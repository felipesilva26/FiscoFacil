import type { Cadastral } from '../cnpj.js';
import type { Ctx } from '../ctx.js';
import type { Row } from '../db.js';
import { newId, todayISO } from '../util.js';

/**
 * DAS-MEI: guia mensal fixa do MEI. Vence no dia 20 do mês seguinte à competência;
 * se cair em sábado ou domingo, deve ser paga no dia útil ANTERIOR (feriados não são tratados aqui).
 * Valor = 5% do salário mínimo (INSS) + R$ 1 de ICMS (comércio/indústria) e/ou R$ 5 de ISS (serviços).
 * Sem a conexão com a Receita, o sistema não sabe se foi paga: quem confirma é o dono.
 */
const SALARIO_MINIMO: Record<number, number> = { 2024: 1412, 2025: 1518, 2026: 1621 };

export type Atividade = 'comercio' | 'servicos' | 'ambos';

/** Indústria (10-33) e comércio (45-47) pagam ICMS; o resto, ISS. */
const classeCnae = (cnae: string): 'comercio' | 'servicos' | null => {
  const div = Number(String(cnae).padStart(7, '0').slice(0, 2));
  if (!div) return null;
  return (div >= 10 && div <= 33) || (div >= 45 && div <= 47) ? 'comercio' : 'servicos';
};

/** Pela atividade principal e pelas secundárias (CNAE): só comércio/indústria, só serviços, ou os dois. */
export function atividadeDe(c: Cadastral | null): Atividade {
  const classes = new Set([c?.cnae, ...(c?.cnaesSecundarios ?? [])].filter(Boolean).map((x) => classeCnae(String(x))));
  const com = classes.has('comercio'), srv = classes.has('servicos');
  return com && srv ? 'ambos' : com ? 'comercio' : 'servicos';
}

/** A escolha do dono (se houver) vale mais do que a dedução pelo cadastro. */
export function atividadeEfetiva(e: Row): { atividade: Atividade; escolhida: boolean } {
  const x = e.das_atividade as string | null | undefined;
  if (x === 'comercio' || x === 'servicos' || x === 'ambos') return { atividade: x, escolhida: true };
  return { atividade: atividadeDe((e.cadastral ?? null) as Cadastral | null), escolhida: false };
}

/** De quanto é o DAS do mês e como o valor se compõe (INSS de 5% do salário mínimo + ICMS e/ou ISS). */
export function composicaoDas(ano: number, atividade: Atividade) {
  const sm = SALARIO_MINIMO[ano];
  if (!sm) return null;
  const inss = Math.round(sm * 5) / 100;
  const icms = atividade === 'servicos' ? 0 : 1, iss = atividade === 'comercio' ? 0 : 5;
  return { ano, inss, icms, iss, total: Math.round((inss + icms + iss) * 100) / 100 };
}

export function valorDasMei(ano: number, atividade: Atividade): number | null {
  const sm = SALARIO_MINIMO[ano];
  if (!sm) return null;
  const inss = Math.round(sm * 5) / 100;
  return Math.round((inss + (atividade === 'comercio' ? 1 : atividade === 'servicos' ? 5 : 6)) * 100) / 100;
}

/** Vencimento da competência AAAA-MM: dia 20 do mês seguinte, antecipado se cair no fim de semana. */
export function vencimentoDasMei(competencia: string): string {
  const [y, m] = competencia.split('-').map(Number);
  const d = new Date(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 20));
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

const competenciaAnterior = (c: string) => { const [y, m] = c.split('-').map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`; };

export function ehMei(e: Row): boolean {
  const c = e.cadastral as Cadastral | null;
  return e.regime === 'MEI' || c?.mei === true;
}

export interface CompetenciaMei { competencia: string; vencimento: string; valor: number | null; status: 'pago' | 'nao_pago' | 'nao_confirmado'; vencida: boolean }

/** Últimas competências (até 6), da mais recente para a mais antiga, a partir de quando virou MEI. */
export async function competenciasMei(ctx: Ctx, e: Row, quantas = 6): Promise<CompetenciaMei[]> {
  const hoje = todayISO(ctx.now());
  const c = e.cadastral as Cadastral | null;
  const inicio = (c?.meiDesde ?? c?.abertura ?? '2000-01-01').slice(0, 7);
  const atv = atividadeEfetiva(e).atividade;
  // A competência mais recente cuja guia vence nos próximos 40 dias.
  let comp = hoje.slice(0, 7);
  while (vencimentoDasMei(comp) > todayISO(new Date(ctx.now().getTime() + 40 * 864e5))) comp = competenciaAnterior(comp);
  const { rows } = await ctx.db.query('select competencia, status from das_mei_status where empresa_id = $1', [e.id]);
  const marcado = new Map(rows.map((r) => [r.competencia as string, r.status as 'pago' | 'nao_pago']));
  const out: CompetenciaMei[] = [];
  for (let i = 0; i < quantas && comp >= inicio; i++) {
    const venc = vencimentoDasMei(comp);
    out.push({ competencia: comp, vencimento: venc, valor: valorDasMei(Number(comp.slice(0, 4)), atv), status: marcado.get(comp) ?? 'nao_confirmado', vencida: venc < hoje });
    comp = competenciaAnterior(comp);
  }
  return out;
}

/** O dono informa se pagou. "Não paguei" vira uma guia em aberto (com aviso de vencimento). */
export async function marcarDasMei(ctx: Ctx, e: Row, competencia: string, status: 'pago' | 'nao_pago') {
  const hoje = todayISO(ctx.now());
  await ctx.db.query(
    `insert into das_mei_status (empresa_id, competencia, status) values ($1, $2, $3)
     on conflict (empresa_id, competencia) do update set status = $3, marcado_em = now()`, [e.id, competencia, status]);
  const venc = vencimentoDasMei(competencia);
  const valor = valorDasMei(Number(competencia.slice(0, 4)), atividadeEfetiva(e).atividade) ?? 0;
  const { rows } = await ctx.db.query("select id, pago_em from obrigacoes where empresa_id = $1 and tributo = 'DAS' and venc = $2", [e.id, venc]);
  if (status === 'nao_pago') {
    if (!rows.length && valor > 0) {
      await ctx.db.query("insert into obrigacoes (id, empresa_id, tributo, venc, valor_centavos, codigo, origem) values ($1, $2, 'DAS', $3, $4, '', 'manual')",
        [newId(), e.id, venc, Math.round(valor * 100)]);
    } else if (rows.length) {
      await ctx.db.query('update obrigacoes set pago_em = null where id = $1', [rows[0].id]);
    }
  } else if (rows.length && !rows[0].pago_em) {
    await ctx.db.query('update obrigacoes set pago_em = $1 where id = $2', [hoje, rows[0].id]);
  } else if (!rows.length && valor > 0) {
    // Pagamento confirmado pelo dono: vira guia paga, para entrar no total de impostos pagos.
    await ctx.db.query("insert into obrigacoes (id, empresa_id, tributo, venc, valor_centavos, codigo, origem, pago_em) values ($1, $2, 'DAS', $3, $4, '', 'manual', $5)",
      [newId(), e.id, venc, Math.round(valor * 100), venc < hoje ? venc : hoje]);
  }
}
