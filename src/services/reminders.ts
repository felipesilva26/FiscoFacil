import type { Ctx } from '../ctx.js';
import { brl, diffDays, fmtDateBR, fromCents, todayISO } from '../util.js';

/**
 * Envia um e-mail-resumo por usuário com o que vence em N dias, 3, 1, hoje e o que está atrasado.
 * Cada aviso vai só uma vez (tabela lembretes_enviados), então rodar de novo não repete.
 */
export async function runReminders(ctx: Ctx, soUsuario?: string): Promise<{ enviados: number; usuarios: number }> {
  const hoje = todayISO(ctx.now());
  const { rows } = await ctx.db.query(
    `select o.id, o.tributo, o.venc, o.valor_centavos, e.nome as empresa,
            u.id as user_id, u.email, u.nome as usuario,
            coalesce(c.email, true) as quer_email, coalesce(c.antecedencia, 7) as antecedencia
       from obrigacoes o
       join empresas e on e.id = o.empresa_id
       join users u on u.id = e.user_id
       left join config_lembretes c on c.user_id = u.id
      where o.pago_em is null and o.arquivado = false ${soUsuario ? 'and u.id = $1' : ''}
      order by o.venc`,
    soUsuario ? [soUsuario] : [],
  );

  type Item = { id: string; marco: number; linha: string };
  const porUsuario = new Map<string, { email: string; nome: string; itens: Item[] }>();

  for (const r of rows) {
    if (!r.quer_email) continue;
    const dias = diffDays(r.venc, hoje);
    const marcos = new Set<number>([r.antecedencia, 3, 1, 0]);
    const marco = dias < 0 ? -1 : marcos.has(dias) ? dias : null;
    if (marco === null) continue;
    const quando = dias < 0 ? `ATRASADO desde ${fmtDateBR(r.venc)}` : dias === 0 ? 'vence HOJE' : `vence em ${dias} ${dias === 1 ? 'dia' : 'dias'} (${fmtDateBR(r.venc)})`;
    const linha = `- ${r.tributo} (${r.empresa}): ${quando}, ${brl(fromCents(r.valor_centavos))}`;
    const g = porUsuario.get(r.user_id) ?? { email: r.email, nome: r.usuario, itens: [] as Item[] };
    g.itens.push({ id: r.id, marco, linha });
    porUsuario.set(r.user_id, g);
  }

  let enviados = 0;
  for (const g of porUsuario.values()) {
    // Só entra quem ainda não foi avisado neste marco.
    const novos: Item[] = [];
    for (const it of g.itens) {
      const ins = await ctx.db.query(
        'insert into lembretes_enviados (obrigacao_id, dias_antes) values ($1, $2) on conflict do nothing returning obrigacao_id',
        [it.id, it.marco],
      );
      if (ins.rows.length) novos.push(it);
    }
    if (!novos.length) continue;
    const texto = `Olá, ${g.nome}!\n\nSeus próximos vencimentos:\n\n${novos.map((n) => n.linha).join('\n')}\n\n` +
      'Os valores são os que constam no FiscoFácil. Confirme com o seu contador antes de pagar.';
    try {
      await ctx.notifier.send({ to: g.email, subject: `FiscoFácil: ${novos.length} ${novos.length === 1 ? 'vencimento' : 'vencimentos'} para acompanhar`, text: texto });
      enviados += 1;
    } catch {
      // Falhou o envio: desfaz a marca para tentar de novo na próxima rodada.
      for (const it of novos) {
        await ctx.db.query('delete from lembretes_enviados where obrigacao_id = $1 and dias_antes = $2', [it.id, it.marco]);
      }
    }
  }
  return { enviados, usuarios: porUsuario.size };
}
