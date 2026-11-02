import type { Ctx } from '../ctx.js';
import type { Row } from '../db.js';
import { diffDays, fromCents, todayISO } from '../util.js';

export type StatusObrigacao = 'pago' | 'atrasado' | 'avencer';

export const TRIBUTOS = ['DAS', 'FGTS', 'INSS', 'ISS', 'ICMS', 'DARF'] as const;
export const REGIMES = ['Simples Nacional', 'MEI', 'Lucro Presumido', 'Lucro Real'] as const;

export function statusDe(o: { pago_em: string | null; venc: string }, hoje: string): StatusObrigacao {
  if (o.pago_em) return 'pago';
  return o.venc < hoje ? 'atrasado' : 'avencer';
}

export function toObrigacao(r: Row, hoje: string) {
  return {
    id: r.id as string,
    empresaId: r.empresa_id as string,
    tributo: r.tributo as string,
    venc: r.venc as string,
    valor: fromCents(r.valor_centavos as number),
    pagoEm: (r.pago_em as string | null) ?? null,
    arquivado: r.arquivado as boolean,
    codigo: r.codigo as string,
    comprovante: r.comprovante as string,
    origem: r.origem as string,
    status: statusDe(r as { pago_em: string | null; venc: string }, hoje),
  };
}

export function toEmpresa(r: Row) {
  return {
    id: r.id as string,
    nome: r.nome as string,
    cnpj: (r.cnpj as string | null) ?? null,
    regime: r.regime as string,
    receita: {
      conectada: r.receita_conectada as boolean,
      ultima: r.receita_ultima ? new Date(r.receita_ultima as string).toISOString() : null,
    },
    cadastral: r.cadastral ?? null,
  };
}

/** Devolve a empresa só se ela pertence ao usuário (evita ver dados de outro cliente). */
export async function empresaDoUsuario(ctx: Ctx, userId: string, empresaId: string): Promise<Row | null> {
  const { rows } = await ctx.db.query('select * from empresas where id = $1 and user_id = $2', [empresaId, userId]);
  return rows[0] ?? null;
}

export async function obrigacaoDoUsuario(ctx: Ctx, userId: string, id: string): Promise<Row | null> {
  const { rows } = await ctx.db.query(
    `select o.* from obrigacoes o join empresas e on e.id = o.empresa_id
     where o.id = $1 and e.user_id = $2`,
    [id, userId],
  );
  return rows[0] ?? null;
}

export async function auditar(
  ctx: Ctx, userId: string, empresaId: string | null, acao: string, detalhe: unknown = null,
): Promise<void> {
  await ctx.db.query(
    'insert into auditoria (user_id, empresa_id, acao, detalhe) values ($1, $2, $3, $4)',
    [userId, empresaId, acao, detalhe === null ? null : JSON.stringify(detalhe)],
  );
}

export interface Resumo {
  empresaId: string;
  totalPendente: number;
  atrasadas: number;
  proximos7Dias: number;
  pagoNoMes: number;
  guiasDoMes: number;
  emAberto: number;
}

export async function resumoEmpresa(ctx: Ctx, empresaId: string): Promise<Resumo> {
  const hoje = todayISO(ctx.now());
  const mes = hoje.slice(0, 7);
  const { rows } = await ctx.db.query(
    'select * from obrigacoes where empresa_id = $1 and arquivado = false', [empresaId],
  );
  const abertas = rows.filter((r) => !r.pago_em);
  const soma = (l: Row[]) => l.reduce((s, r) => s + (r.valor_centavos as number), 0);
  return {
    empresaId,
    totalPendente: fromCents(soma(abertas)),
    atrasadas: abertas.filter((r) => r.venc < hoje).length,
    proximos7Dias: abertas.filter((r) => { const d = diffDays(r.venc, hoje); return d >= 0 && d <= 7; }).length,
    pagoNoMes: fromCents(soma(rows.filter((r) => r.pago_em && String(r.pago_em).slice(0, 7) === mes))),
    guiasDoMes: rows.filter((r) => String(r.venc).slice(0, 7) === mes).length,
    emAberto: abertas.length,
  };
}
