import type { Ctx } from '../ctx.js';
import type { Row } from '../db.js';
import { newId, toCents } from '../util.js';

export interface ResultadoSync {
  novas: number;
  consultadoEm: string;
  fonte: string;
  simulado: boolean;
}

/**
 * Consulta a situação fiscal no provedor configurado e grava as pendências como obrigações
 * com origem "receita". Rodar de novo não duplica: a mesma pendência só entra uma vez.
 */
export async function sincronizarReceita(ctx: Ctx, empresa: Row): Promise<ResultadoSync> {
  const agora = ctx.now();
  const sit = await ctx.receita.consultarSituacaoFiscal(String(empresa.cnpj).replace(/\D/g, ''), agora);
  let novas = 0;
  for (const p of sit.pendencias) {
    const ja = await ctx.db.query(
      "select 1 from obrigacoes where empresa_id = $1 and tributo = $2 and venc = $3 and origem = 'receita'",
      [empresa.id, p.tributo, p.venc],
    );
    if (ja.rows.length) continue;
    await ctx.db.query(
      `insert into obrigacoes (id, empresa_id, tributo, venc, valor_centavos, origem)
       values ($1, $2, $3, $4, $5, 'receita')`,
      [newId(), empresa.id, p.tributo, p.venc, toCents(p.valor)],
    );
    novas++;
  }
  await ctx.db.query('update empresas set receita_ultima = $1 where id = $2', [agora.toISOString(), empresa.id]);
  return { novas, consultadoEm: sit.consultadoEm, fonte: sit.fonte, simulado: sit.simulado };
}
