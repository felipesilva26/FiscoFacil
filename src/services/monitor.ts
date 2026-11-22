import type { Cadastral } from '../cnpj.js';
import type { Ctx } from '../ctx.js';
import type { Row } from '../db.js';
import { diffDays, fmtDateBR, newId, todayISO } from '../util.js';

/**
 * Robô de monitoramento: todo dia confere o cadastro público de cada empresa, guarda o que mudou
 * (histórico), cria alertas e avisa por e-mail. Também vigia a validade das certidões anexadas.
 * Só usa dados públicos e o que o próprio usuário anexou: nada de senha, certificado ou procuração.
 */

export type Gravidade = 'alerta' | 'atencao' | 'info';

export interface Mudanca {
  campo: string;
  rotulo: string;
  antes: string | null;
  depois: string | null;
  gravidade: Gravidade;
  /** Frase em linguagem simples, sem o nome da empresa. */
  texto: string;
}

const norm = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
};

/** Compara dois retratos do cadastro e lista o que mudou. Sem retrato anterior, não há o que comparar. */
export function compararCadastro(antigo: Cadastral | null, novo: Cadastral): Mudanca[] {
  if (!antigo || !antigo.situacao) return [];
  const out: Mudanca[] = [];
  const add = (campo: string, rotulo: string, antes: unknown, depois: unknown, gravidade: Gravidade, texto: string) =>
    out.push({ campo, rotulo, antes: norm(antes), depois: norm(depois), gravidade, texto });

  const sA = norm(antigo.situacao), sN = norm(novo.situacao);
  if (sN && sA !== sN) {
    const ativa = /^ATIVA$/i.test(sN);
    add('situacao', 'Situação cadastral', sA, sN, ativa ? 'info' : 'alerta',
      ativa ? `a situação cadastral voltou a ${sN} (antes: ${sA})` : `a situação cadastral mudou de ${sA} para ${sN}`);
  }
  if (antigo.simples === true && novo.simples === false) add('simples', 'Simples Nacional', 'Optante', 'Fora do Simples', 'alerta', 'a empresa saiu do Simples Nacional');
  if (antigo.simples === false && novo.simples === true) add('simples', 'Simples Nacional', 'Fora do Simples', 'Optante', 'info', 'a empresa entrou no Simples Nacional');
  if (antigo.mei === true && novo.mei === false) add('mei', 'MEI', 'MEI', 'Não é MEI', 'alerta', 'a empresa deixou de ser MEI');
  if (antigo.mei === false && novo.mei === true) add('mei', 'MEI', 'Não é MEI', 'MEI', 'info', 'a empresa passou a ser MEI');

  const texto = (campo: string, rotulo: string, a: unknown, b: unknown, frase: string) => {
    const x = norm(a), y = norm(b);
    if (x && y && x !== y) add(campo, rotulo, x, y, 'atencao', `${frase} de ${x} para ${y}`);
  };
  texto('razaoSocial', 'Razão social', antigo.razaoSocial, novo.razaoSocial, 'a razão social mudou');
  texto('atividade', 'Atividade principal', antigo.atividade, novo.atividade, 'a atividade principal mudou');
  texto('porte', 'Porte', antigo.porte, novo.porte, 'o porte mudou');
  texto('natureza', 'Natureza jurídica', antigo.natureza, novo.natureza, 'a natureza jurídica mudou');
  texto('situacaoEspecial', 'Situação especial', antigo.situacaoEspecial, novo.situacaoEspecial, 'a situação especial mudou');
  if (norm(antigo.endereco) && norm(novo.endereco) && (norm(antigo.endereco) !== norm(novo.endereco) || norm(antigo.municipio) !== norm(novo.municipio) || norm(antigo.uf) !== norm(novo.uf))) {
    add('endereco', 'Endereço', [antigo.endereco, antigo.municipio, antigo.uf].filter(Boolean).join(' · '), [novo.endereco, novo.municipio, novo.uf].filter(Boolean).join(' · '), 'atencao', 'o endereço da empresa mudou');
  }
  if (antigo.socios && novo.socios && antigo.socios !== novo.socios) {
    add('socios', 'Sócios', antigo.socios, novo.socios, 'atencao', `o número de sócios mudou de ${antigo.socios} para ${novo.socios}`);
  }
  if (typeof antigo.capitalSocial === 'number' && typeof novo.capitalSocial === 'number' && antigo.capitalSocial !== novo.capitalSocial) {
    add('capitalSocial', 'Capital social', antigo.capitalSocial, novo.capitalSocial, 'info', `o capital social mudou de R$ ${antigo.capitalSocial.toLocaleString('pt-BR')} para R$ ${novo.capitalSocial.toLocaleString('pt-BR')}`);
  }
  return out;
}

const ORDEM: Record<Gravidade, number> = { alerta: 0, atencao: 1, info: 2 };
const pior = (m: { gravidade: Gravidade }[]): Gravidade => m.reduce<Gravidade>((p, x) => (ORDEM[x.gravidade] < ORDEM[p] ? x.gravidade : p), 'info');

/** Usuário real (não visitante) que quer receber e-mail? */
async function querEmail(ctx: Ctx, userId: string): Promise<{ email: string; nome: string } | null> {
  const { rows } = await ctx.db.query(
    'select u.email, u.nome, u.anonimo, coalesce(c.email, true) as quer from users u left join config_lembretes c on c.user_id = u.id where u.id = $1', [userId]);
  const u = rows[0];
  return u && !u.anonimo && u.quer ? { email: u.email, nome: u.nome } : null;
}

/** Guarda no histórico, cria um alerta por mudança e manda um único e-mail com tudo. Devolve quantas mudanças. */
export async function registrarMudancas(ctx: Ctx, e: Row, mudancas: Mudanca[], fonte: string): Promise<number> {
  if (!mudancas.length) return 0;
  for (const m of mudancas) {
    await ctx.db.query(
      'insert into mudancas_cadastro (id, empresa_id, campo, rotulo, antes, depois, gravidade, texto, fonte, detectado_em) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [newId(), e.id, m.campo, m.rotulo, m.antes, m.depois, m.gravidade, `${e.nome}: ${m.texto}.`, fonte, ctx.now().toISOString()]);
    await ctx.db.query('insert into alertas (id, user_id, empresa_id, nivel, texto, fonte) values ($1,$2,$3,$4,$5,$6)',
      [newId(), e.user_id, e.id, m.gravidade, `${e.nome}: ${m.texto}.`, fonte]);
  }
  const dest = await querEmail(ctx, e.user_id);
  if (dest) {
    const grav = pior(mudancas);
    const assunto = grav === 'alerta' ? 'FiscoFácil: mudança importante no cadastro da empresa' : 'FiscoFácil: mudança no cadastro da empresa';
    const linhas = mudancas.map((m) => `- ${m.texto}`).join('\n');
    await ctx.notifier.send({ to: dest.email, subject: assunto, text: `Olá, ${dest.nome}!\n\nO robô do FiscoFácil encontrou mudanças no cadastro de ${e.nome}:\n\n${linhas}\n\nFonte: ${fonte}.\nSe você não reconhece a mudança, fale com o seu contador.` }).catch(() => undefined);
  }
  return mudancas.length;
}

const MARCOS_CERTIDAO = [
  { ate: -1, marco: -1, nivel: 'alerta' as Gravidade },
  { ate: 3, marco: 3, nivel: 'alerta' as Gravidade },
  { ate: 7, marco: 7, nivel: 'atencao' as Gravidade },
  { ate: 15, marco: 15, nivel: 'atencao' as Gravidade },
];

/** Avisa quando uma certidão anexada está para vencer ou já venceu. Cada marco avisa uma vez só. */
export async function verificarCertidoes(ctx: Ctx): Promise<number> {
  const hoje = todayISO(ctx.now());
  const { rows } = await ctx.db.query(
    `select d.id, d.nome, d.validade, e.id as empresa_id, e.nome as empresa, e.user_id
       from documentos d join empresas e on e.id = d.empresa_id
      where d.tipo = 'Certidão' and d.validade is not null
        and not exists (select 1 from documentos d2 where d2.empresa_id = d.empresa_id and d2.tipo = 'Certidão' and d2.nome = d.nome and d2.validade > d.validade)`);
  const porUsuario = new Map<string, string[]>();
  let novos = 0;
  for (const d of rows) {
    const dias = diffDays(d.validade as string, hoje);
    const faixa = MARCOS_CERTIDAO.find((m) => dias <= m.ate);
    if (!faixa) continue;
    const quando = dias < 0 ? `venceu em ${fmtDateBR(d.validade)}` : dias === 0 ? 'vence hoje' : `vence em ${dias} ${dias === 1 ? 'dia' : 'dias'} (${fmtDateBR(d.validade)})`;
    const texto = `${d.empresa}: a certidão "${d.nome}" ${quando}.`;
    const ins = await ctx.db.query(
      'insert into alertas (id, user_id, empresa_id, nivel, texto, fonte, chave) values ($1,$2,$3,$4,$5,$6,$7) on conflict do nothing returning id',
      [newId(), d.user_id, d.empresa_id, faixa.nivel, texto, 'Validade das certidões que você anexou', `cert:${d.id}:${faixa.marco}`]);
    if (!ins.rows.length) continue;
    novos++;
    const l = porUsuario.get(d.user_id) ?? []; l.push(`- ${texto}`); porUsuario.set(d.user_id, l);
  }
  for (const [userId, linhas] of porUsuario) {
    const dest = await querEmail(ctx, userId);
    if (dest) await ctx.notifier.send({ to: dest.email, subject: 'FiscoFácil: certidão vencendo', text: `Olá, ${dest.nome}!\n\n${linhas.join('\n')}\n\nEmita a certidão nova no site oficial e anexe em Documentos.` }).catch(() => undefined);
  }
  return novos;
}

export const estadoMonitor: { rodando: boolean } = { rodando: false };
const pausa = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Uma rodada completa: cadastro de todas as empresas com CNPJ + certidões. Não roda duas ao mesmo tempo. */
export async function rodarMonitor(ctx: Ctx, opts: { pausaMs?: number; forcar?: boolean } = {}) {
  if (estadoMonitor.rodando) return { ocupado: true as const };
  estadoMonitor.rodando = true;
  const { atualizarCadastro } = await import('./situacao.js');
  const inicio = ctx.now();
  const ex = await ctx.db.query('insert into monitor_execucoes (iniciado_em) values ($1) returning id', [inicio.toISOString()]);
  const id = ex.rows[0].id;
  let empresas = 0, falhas = 0;
  try {
    const { rows } = await ctx.db.query('select * from empresas where cnpj is not null order by criado_em');
    const entre = opts.pausaMs ?? (ctx.cfg.env === 'test' ? 0 : 800);
    for (const e of rows) {
      const ultima = (e.cadastral as Cadastral | null)?.consultadoEm;
      // Quem acabou de ser consultado (ex.: o usuário clicou em atualizar) não precisa de nova consulta.
      if (!opts.forcar && ultima && inicio.getTime() - new Date(ultima).getTime() < 20 * 3600_000) continue;
      try { await atualizarCadastro(ctx, e); empresas++; } catch { falhas++; }
      if (entre) await pausa(entre);
    }
    await verificarCertidoes(ctx);
    const n = await ctx.db.query('select count(*)::int as n from mudancas_cadastro where detectado_em >= $1', [inicio.toISOString()]);
    const mudancas = n.rows[0].n as number;
    await ctx.db.query('update monitor_execucoes set concluido_em = $1, empresas = $2, mudancas = $3, falhas = $4 where id = $5', [ctx.now().toISOString(), empresas, mudancas, falhas, id]);
    return { ocupado: false as const, empresas, mudancas, falhas };
  } catch (e) {
    await ctx.db.query('update monitor_execucoes set concluido_em = $1, falhas = falhas + 1 where id = $2', [ctx.now().toISOString(), id]).catch(() => undefined);
    throw e;
  } finally {
    estadoMonitor.rodando = false;
  }
}

/** Roda só se a última rodada concluída foi há mais de 20 horas (ou nunca houve). */
export async function rodarMonitorSeVencido(ctx: Ctx) {
  const { rows } = await ctx.db.query('select max(concluido_em) as ultima from monitor_execucoes');
  const ultima = rows[0]?.ultima ? new Date(rows[0].ultima).getTime() : 0;
  if (ctx.now().getTime() - ultima < 20 * 3600_000) return null;
  return rodarMonitor(ctx);
}

/** Quando o robô rodou pela última vez, para a tela mostrar que ele está vigiando. */
export async function resumoMonitor(ctx: Ctx) {
  const { rows } = await ctx.db.query('select concluido_em, empresas, mudancas, falhas from monitor_execucoes where concluido_em is not null order by concluido_em desc limit 1');
  const r = rows[0];
  return { ultimaRodada: r ? new Date(r.concluido_em).toISOString() : null, frequencia: 'todos os dias' };
}

/** Histórico de mudanças de uma empresa (mais recentes primeiro). */
export async function historicoMudancas(ctx: Ctx, empresaId: string, limite = 30) {
  const { rows } = await ctx.db.query(
    'select id, campo, rotulo, antes, depois, gravidade, texto, fonte, detectado_em from mudancas_cadastro where empresa_id = $1 order by detectado_em desc limit $2', [empresaId, limite]);
  return rows.map((r) => ({
    id: r.id as string, campo: r.campo as string, rotulo: r.rotulo as string, antes: r.antes as string | null, depois: r.depois as string | null,
    gravidade: r.gravidade as Gravidade, texto: r.texto as string, fonte: r.fonte as string, detectadoEm: new Date(r.detectado_em).toISOString(),
  }));
}
