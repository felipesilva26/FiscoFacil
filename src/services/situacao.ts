import { avaliarCadastro, lookupCnpj, regimePelaReceita, type Cadastral } from '../cnpj.js';
import type { Ctx } from '../ctx.js';
import type { Row } from '../db.js';
import { dividaDoCnpj, estadoPgfn } from '../pgfn/importador.js';
import { todayISO, diffDays } from '../util.js';
import { resumoEmpresa } from './dominio.js';
import { competenciasMei, ehMei } from './dasmei.js';
import { compararCadastro, historicoMudancas, registrarMudancas, resumoMonitor } from './monitor.js';

type Nivel = 'ok' | 'alerta' | 'pendente' | 'info';

/** Consulta o cadastro público, guarda e registra (histórico, alerta e e-mail) o que mudou desde a última consulta. */
export async function atualizarCadastro(ctx: Ctx, e: Row): Promise<Cadastral> {
  const novo = await lookupCnpj(e.cnpj, { url: ctx.cfg.cnpjLookupUrl, fetchImpl: ctx.fetchImpl, now: ctx.now(), log: (m) => console.warn(m) });
  const antigo = (e.cadastral ?? null) as Cadastral | null;
  await ctx.db.query('update empresas set cadastral = $1 where id = $2', [JSON.stringify(novo), e.id]);
  // Regime: MEI e Simples a Receita informa com certeza; fora deles, mantém o que o dono escolheu entre Presumido e Real.
  const reg = regimePelaReceita(novo);
  if (reg?.regime && reg.regime !== e.regime) {
    await ctx.db.query('update empresas set regime = $1 where id = $2', [reg.regime, e.id]);
  } else if (reg && !reg.regime && (e.regime === 'MEI' || e.regime === 'Simples Nacional')) {
    await ctx.db.query("update empresas set regime = 'Lucro Presumido' where id = $1", [e.id]);
  }
  await registrarMudancas(ctx, e, compararCadastro(antigo, novo), novo.fonte);
  return novo;
}

export async function situacaoFiscal(ctx: Ctx, e: Row) {
  const hoje = todayISO(ctx.now());
  const cad = (e.cadastral ?? null) as Cadastral | null;
  const av = avaliarCadastro(cad);

  const divida = e.cnpj ? await dividaDoCnpj(ctx, e.cnpj) : null;
  const nivelDivida: Nivel = !divida || !divida.verificado ? 'pendente' : divida.inscricoes.length ? 'alerta' : 'ok';
  const textoDivida = !divida || !divida.verificado
    ? estadoPgfn.rodando
      ? 'Conferindo agora na base oficial da PGFN. Leva alguns minutos: esta tela se atualiza sozinha.'
      : estadoPgfn.ultimoErro
        ? 'Não consegui baixar a base da PGFN agora. O sistema tenta de novo sozinho em 30 minutos.'
        : 'Na fila para conferir na base oficial da PGFN. Começa em instantes.'
    : divida.inscricoes.length
      ? `${divida.inscricoes.length} ${divida.inscricoes.length === 1 ? 'inscrição' : 'inscrições'} em dívida ativa, total de R$ ${divida.total.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}.`
      : `Nenhuma inscrição em dívida ativa da União ou do FGTS (base do ${divida.trimestre}).`;

  const receitaPronta = ctx.receita.nome !== 'Não configurado';
  const nivelReceita: Nivel = e.receita_conectada ? 'ok' : 'pendente';

  const { rows: certs } = await ctx.db.query("select nome, validade from documentos where empresa_id = $1 and tipo = 'Certidão' and validade is not null order by validade desc", [e.id]);
  const certidoes = certs.map((c) => ({ nome: c.nome as string, validade: c.validade as string, vencida: (c.validade as string) < hoje, venceEm: diffDays(c.validade as string, hoje) }));
  const nivelCert: Nivel = !certidoes.length ? 'pendente' : certidoes.some((c) => !c.vencida) ? 'ok' : 'alerta';

  const guias = await resumoEmpresa(ctx, e.id);
  const nivelGuias: Nivel = guias.atrasadas ? 'alerta' : guias.emAberto ? 'ok' : 'pendente';

  const mei = ehMei(e) ? await competenciasMei(ctx, e) : null;
  const meiVencidas = mei ? mei.filter((m) => m.vencida) : [];
  const meiDevendo = meiVencidas.filter((m) => m.status === 'nao_pago');
  const meiSemResposta = meiVencidas.filter((m) => m.status === 'nao_confirmado');
  const blocoMei = mei ? [{
    id: 'dasmei', grupo: 'serpro', titulo: 'DAS-MEI (guia mensal do MEI)',
    nivel: (meiDevendo.length ? 'alerta' : meiSemResposta.length ? 'pendente' : 'ok') as Nivel,
    texto: meiDevendo.length
      ? `${meiDevendo.length} ${meiDevendo.length === 1 ? 'mês não pago' : 'meses não pagos'}: ${meiDevendo.map((m) => m.competencia.split('-').reverse().join('/')).join(', ')}.`
      : meiSemResposta.length
        ? `Confirme se pagou ${meiSemResposta.length === 1 ? 'o mês' : 'os meses'} ${meiSemResposta.map((m) => m.competencia.split('-').reverse().join('/')).join(', ')}. Sem a conexão com a Receita, o sistema não sabe.`
        : 'Meses vencidos confirmados como pagos.',
    fonte: 'Calendário oficial do DAS-MEI (vence dia 20); pagamento confirmado por você', atualizadoEm: null, automatico: false,
  }] : [];
  const blocos = [
    { id: 'cadastro', grupo: 'auto', titulo: 'Cadastro na Receita Federal', nivel: av.nivel as Nivel, texto: av.texto, fonte: cad?.fonte ?? 'Dados abertos da Receita Federal', atualizadoEm: cad?.consultadoEm ?? null, automatico: true },
    { id: 'divida', grupo: 'auto', titulo: 'Dívida ativa da União e do FGTS', nivel: nivelDivida, texto: textoDivida, fonte: divida?.fonte ?? 'PGFN - dados abertos', atualizadoEm: divida?.trimestre ?? null, automatico: true },
    ...blocoMei,
    { id: 'receita', grupo: 'serpro', titulo: 'Tributos federais, guias e pagamentos (e-CAC)', nivel: nivelReceita,
      texto: e.receita_conectada ? 'Conectado à Receita pelo Integra Contador.' : 'Precisa da sua autorização (procuração eletrônica no e-CAC).',
      fonte: 'Receita Federal, pelo Integra Contador (Serpro)', atualizadoEm: e.receita_ultima ? new Date(e.receita_ultima).toISOString() : null, automatico: receitaPronta },
    { id: 'guias', grupo: 'voce', titulo: 'Guias cadastradas por você', nivel: nivelGuias,
      texto: guias.atrasadas ? `${guias.atrasadas} ${guias.atrasadas === 1 ? 'guia atrasada' : 'guias atrasadas'}.` : guias.emAberto ? `${guias.emAberto} em aberto, nenhuma atrasada.` : 'Nenhuma guia cadastrada. Sem a conexão com a Receita, o sistema só conhece as guias que você cadastra ou anexa.',
      fonte: 'Cadastradas por você ou lidas dos seus documentos', atualizadoEm: null, automatico: false },
    { id: 'certidoes', grupo: 'voce', titulo: 'Estado e município (certidões)', nivel: nivelCert,
      texto: !certidoes.length ? 'Não há consulta automática nacional para ICMS e ISS. Anexe as certidões em Documentos.' : certidoes.some((c) => !c.vencida) ? 'Há certidão válida anexada.' : 'Todas as certidões anexadas estão vencidas.',
      fonte: 'Certidões anexadas por você', atualizadoEm: null, automatico: false },
  ];
  const alertas = blocos.filter((b) => b.nivel === 'alerta');
  const pendentes = blocos.filter((b) => b.nivel === 'pendente');
  const resumo = alertas.length
    ? { nivel: 'alerta' as Nivel, titulo: alertas.length === 1 ? 'Há 1 ponto de atenção' : `Há ${alertas.length} pontos de atenção`, texto: alertas.map((b) => `${b.titulo}: ${b.texto}`).join(' ') }
    : pendentes.length
      ? { nivel: 'info' as Nivel, titulo: 'Ainda não dá para dizer que está tudo em dia', texto: `${pendentes.length} ${pendentes.length === 1 ? 'item ainda não pôde ser conferido' : 'itens ainda não puderam ser conferidos'}. Veja abaixo o que já foi conferido e o que falta.` }
      : { nivel: 'ok' as Nivel, titulo: 'Tudo em dia', texto: 'Nenhuma pendência nas fontes conferidas.' };

  return {
    empresa: { id: e.id, nome: e.nome, cnpj: e.cnpj },
    resumo, blocos, cadastro: cad, divida, guias, certidoes, mei,
    monitor: { ...(await resumoMonitor(ctx)), mudancas: await historicoMudancas(ctx, e.id) }, pgfnRodando: estadoPgfn.rodando || (!!divida && !divida.verificado && !estadoPgfn.ultimoErro),
    procuracao: { conectada: !!e.receita_conectada, procuradorCnpj: ctx.cfg.procuradorCnpj || null, servicoConfigurado: receitaPronta },
    naoCobre: ['ICMS (cada estado tem o seu sistema)', 'ISS e taxas municipais (cada prefeitura tem o seu)', 'Débitos ainda não inscritos em dívida ativa, sem a procuração no e-CAC'],
  };
}
