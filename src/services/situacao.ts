import { avaliarCadastro, lookupCnpj, type Cadastral } from '../cnpj.js';
import type { Ctx } from '../ctx.js';
import type { Row } from '../db.js';
import { dividaDoCnpj } from '../pgfn/importador.js';
import { newId, todayISO, diffDays } from '../util.js';
import { resumoEmpresa } from './dominio.js';

type Nivel = 'ok' | 'alerta' | 'pendente' | 'info';

/** Consulta o cadastro público, guarda e avisa se algo importante mudou. */
export async function atualizarCadastro(ctx: Ctx, e: Row): Promise<Cadastral> {
  const novo = await lookupCnpj(e.cnpj, { url: ctx.cfg.cnpjLookupUrl, fetchImpl: ctx.fetchImpl, now: ctx.now() });
  const antigo = (e.cadastral ?? null) as Cadastral | null;
  await ctx.db.query('update empresas set cadastral = $1 where id = $2', [JSON.stringify(novo), e.id]);
  if (antigo && antigo.situacao) {
    const mudou: string[] = [];
    if (antigo.situacao !== novo.situacao) mudou.push(`a situação cadastral mudou de ${antigo.situacao} para ${novo.situacao ?? 'desconhecida'}`);
    if (antigo.simples === true && novo.simples === false) mudou.push('a empresa saiu do Simples Nacional');
    if (antigo.mei === true && novo.mei === false) mudou.push('a empresa deixou de ser MEI');
    if (mudou.length) {
      const { rows } = await ctx.db.query('select email from users where id = $1', [e.user_id]);
      const texto = `${e.nome}: ${mudou.join('; ')}.`;
      await ctx.db.query('insert into alertas (id, user_id, empresa_id, nivel, texto, fonte) values ($1,$2,$3,$4,$5,$6)',
        [newId(), e.user_id, e.id, 'alerta', texto, novo.fonte]);
      if (rows[0]) await ctx.notifier.send({ to: rows[0].email, subject: 'FiscoFácil: mudança no cadastro da empresa', text: `${texto}\n\nFonte: ${novo.fonte}.` }).catch(() => undefined);
    }
  }
  return novo;
}

/** Atualiza o cadastro das empresas consultadas há mais de `dias` dias. */
export async function atualizarCadastrosAntigos(ctx: Ctx, dias = 7): Promise<number> {
  const { rows } = await ctx.db.query('select * from empresas where cnpj is not null');
  let n = 0;
  for (const e of rows) {
    const ultima = (e.cadastral as Cadastral | null)?.consultadoEm;
    if (ultima && diffDays(todayISO(ctx.now()), todayISO(new Date(ultima))) < dias) continue;
    try { await atualizarCadastro(ctx, e); n++; } catch { /* tenta de novo na próxima rodada */ }
  }
  return n;
}

export async function situacaoFiscal(ctx: Ctx, e: Row) {
  const hoje = todayISO(ctx.now());
  const cad = (e.cadastral ?? null) as Cadastral | null;
  const av = avaliarCadastro(cad);

  const divida = e.cnpj ? await dividaDoCnpj(ctx, e.cnpj) : null;
  const nivelDivida: Nivel = !divida || !divida.verificado ? 'pendente' : divida.inscricoes.length ? 'alerta' : 'ok';
  const textoDivida = !divida || !divida.verificado
    ? 'Conferência agendada: a base da PGFN é baixada e cruzada durante a noite.'
    : divida.inscricoes.length
      ? `${divida.inscricoes.length} ${divida.inscricoes.length === 1 ? 'inscrição' : 'inscrições'} em dívida ativa, total de R$ ${divida.total.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}.`
      : `Nenhuma inscrição em dívida ativa da União ou do FGTS (base do ${divida.trimestre}).`;

  const receitaPronta = ctx.receita.nome !== 'Não configurado';
  const nivelReceita: Nivel = e.receita_conectada ? 'ok' : 'pendente';

  const { rows: certs } = await ctx.db.query("select nome, validade from documentos where empresa_id = $1 and tipo = 'Certidão' and validade is not null order by validade desc", [e.id]);
  const certidoes = certs.map((c) => ({ nome: c.nome as string, validade: c.validade as string, vencida: (c.validade as string) < hoje, venceEm: diffDays(c.validade as string, hoje) }));
  const nivelCert: Nivel = !certidoes.length ? 'pendente' : certidoes.some((c) => !c.vencida) ? 'ok' : 'alerta';

  const guias = await resumoEmpresa(ctx, e.id);
  const nivelGuias: Nivel = guias.atrasadas ? 'alerta' : 'ok';

  const blocos = [
    { id: 'cadastro', titulo: 'Cadastro na Receita Federal', nivel: av.nivel as Nivel, texto: av.texto, fonte: cad?.fonte ?? 'Dados abertos da Receita Federal', atualizadoEm: cad?.consultadoEm ?? null, automatico: true },
    { id: 'divida', titulo: 'Dívida ativa da União e do FGTS', nivel: nivelDivida, texto: textoDivida, fonte: divida?.fonte ?? 'PGFN - dados abertos', atualizadoEm: divida?.trimestre ?? null, automatico: true },
    { id: 'receita', titulo: 'Tributos federais, guias e pagamentos (e-CAC)', nivel: nivelReceita,
      texto: e.receita_conectada ? 'Conectado à Receita pelo Integra Contador.' : 'Precisa da sua autorização (procuração eletrônica no e-CAC).',
      fonte: 'Receita Federal, pelo Integra Contador (Serpro)', atualizadoEm: e.receita_ultima ? new Date(e.receita_ultima).toISOString() : null, automatico: receitaPronta },
    { id: 'guias', titulo: 'Guias cadastradas no FiscoFácil', nivel: nivelGuias,
      texto: guias.atrasadas ? `${guias.atrasadas} ${guias.atrasadas === 1 ? 'guia atrasada' : 'guias atrasadas'}.` : guias.emAberto ? `${guias.emAberto} em aberto, nenhuma atrasada.` : 'Nenhuma guia em aberto.',
      fonte: 'Cadastradas por você ou lidas dos seus documentos', atualizadoEm: null, automatico: false },
    { id: 'certidoes', titulo: 'Estado e município (certidões)', nivel: nivelCert,
      texto: !certidoes.length ? 'Não há consulta automática nacional para ICMS e ISS. Anexe as certidões em Documentos.' : certidoes.some((c) => !c.vencida) ? 'Há certidão válida anexada.' : 'Todas as certidões anexadas estão vencidas.',
      fonte: 'Certidões anexadas por você', atualizadoEm: null, automatico: false },
  ];
  const alertas = blocos.filter((b) => b.nivel === 'alerta');
  const pendentes = blocos.filter((b) => b.nivel === 'pendente');
  const resumo = alertas.length
    ? { nivel: 'alerta' as Nivel, titulo: alertas.length === 1 ? 'Há 1 ponto de atenção' : `Há ${alertas.length} pontos de atenção`, texto: alertas.map((b) => `${b.titulo}: ${b.texto}`).join(' ') }
    : pendentes.length
      ? { nivel: 'info' as Nivel, titulo: 'Nada de errado encontrado até aqui', texto: `Ainda falta conferir: ${pendentes.map((b) => b.titulo).join('; ')}.` }
      : { nivel: 'ok' as Nivel, titulo: 'Tudo em dia', texto: 'Nenhuma pendência nas fontes conferidas.' };

  return {
    empresa: { id: e.id, nome: e.nome, cnpj: e.cnpj },
    resumo, blocos, cadastro: cad, divida, guias, certidoes,
    procuracao: { conectada: !!e.receita_conectada, procuradorCnpj: ctx.cfg.procuradorCnpj || null, servicoConfigurado: receitaPronta },
    naoCobre: ['ICMS (cada estado tem o seu sistema)', 'ISS e taxas municipais (cada prefeitura tem o seu)', 'Débitos ainda não inscritos em dívida ativa, sem a procuração no e-CAC'],
  };
}
