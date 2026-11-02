import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../ctx.js';
import { responder } from '../services/assistant.js';
import { empresaDoUsuario, resumoEmpresa, toObrigacao } from '../services/dominio.js';
import { runReminders } from '../services/reminders.js';
import { todayISO } from '../util.js';
import { checklist } from '../integracoes.js';
import { makeGuard } from './guard.js';

const config = z.object({
  email: z.boolean(),
  whatsapp: z.boolean(),
  push: z.boolean(),
  antecedencia: z.union([z.literal(3), z.literal(5), z.literal(7)]),
});
const pergunta = z.object({
  empresaId: z.string().min(1),
  pergunta: z.string().trim().min(2, 'Escreva sua pergunta.').max(500, 'Pergunta muito longa.'),
});

export async function extrasRoutes(app: FastifyInstance, ctx: Ctx) {
  const guard = makeGuard(ctx.cfg);

  /** Lista do que falta para conectar cada órgão. Mostra só o nome das variáveis, nunca os valores. */
  app.get('/api/integracoes', { preHandler: guard }, async () => checklist(ctx.cfg));

  app.get('/api/lembretes/config', { preHandler: guard }, async (req) => {
    const { rows } = await ctx.db.query('select email, whatsapp, push, antecedencia from config_lembretes where user_id = $1', [req.userId]);
    return rows[0] ?? { email: true, whatsapp: false, push: false, antecedencia: 7 };
  });

  /** WhatsApp e push são só preferências por enquanto: o envio real é e-mail. */
  app.put('/api/lembretes/config', { preHandler: guard }, async (req) => {
    const b = config.parse(req.body);
    await ctx.db.query(
      `insert into config_lembretes (user_id, email, whatsapp, push, antecedencia) values ($1, $2, $3, $4, $5)
       on conflict (user_id) do update set email = $2, whatsapp = $3, push = $4, antecedencia = $5`,
      [req.userId, b.email, b.whatsapp, b.push, b.antecedencia],
    );
    return b;
  });

  /** Roda os lembretes só para o usuário logado (útil para testar). A rotina diária cuida de todos. */
  app.post('/api/lembretes/executar', { preHandler: guard, config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req) =>
    runReminders(ctx, req.userId));

  app.post('/api/assistente', { preHandler: guard, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = pergunta.parse(req.body);
    const e = await empresaDoUsuario(ctx, req.userId, b.empresaId);
    if (!e) return reply.code(404).send({ erro: 'Empresa não encontrada.' });
    const hoje = todayISO(ctx.now());
    const { rows } = await ctx.db.query(
      'select * from obrigacoes where empresa_id = $1 and arquivado = false and pago_em is null order by venc', [e.id]);
    const emAberto = rows.map((r) => toObrigacao(r, hoje)).map((o) => ({
      tributo: o.tributo, venc: o.venc, valor: o.valor, situacao: o.status === 'atrasado' ? ('atrasado' as const) : ('a vencer' as const),
    }));
    return responder(ctx, { empresa: e.nome, hoje, resumo: await resumoEmpresa(ctx, e.id), emAberto }, b.pergunta);
  });
}
