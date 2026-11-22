import type { FastifyInstance } from 'fastify';
import { CnpjError } from '../cnpj.js';
import type { Ctx } from '../ctx.js';
import { empresaDoUsuario } from '../services/dominio.js';
import { atualizarCadastro, situacaoFiscal } from '../services/situacao.js';
import { ehMei, marcarDasMei } from '../services/dasmei.js';
import { z } from 'zod';
import { makeGuard } from './guard.js';

export async function situacaoRoutes(app: FastifyInstance, ctx: Ctx) {
  const guard = makeGuard(ctx.cfg);
  const naoAchou = { erro: 'Empresa não encontrada.' };

  app.get('/api/empresas/:id/situacao', { preHandler: guard }, async (req, reply) => {
    const e = await empresaDoUsuario(ctx, req.userId, (req.params as { id: string }).id);
    if (!e) return reply.code(404).send(naoAchou);
    return situacaoFiscal(ctx, e);
  });

  /** Consulta o cadastro público de novo agora. */
  app.post('/api/empresas/:id/situacao/atualizar', { preHandler: guard, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const e = await empresaDoUsuario(ctx, req.userId, (req.params as { id: string }).id);
    if (!e) return reply.code(404).send(naoAchou);
    if (!e.cnpj) return reply.code(409).send({ erro: 'Informe o CNPJ da empresa primeiro.' });
    try {
      await atualizarCadastro(ctx, e);
    } catch (err) {
      if (err instanceof CnpjError) return reply.code(err.status === 400 ? 400 : 502).send({ erro: err.message });
      throw err;
    }
    return situacaoFiscal(ctx, (await empresaDoUsuario(ctx, req.userId, e.id))!);
  });

  /** O dono informa se pagou o DAS-MEI de um mês. */
  app.post('/api/empresas/:id/das-mei', { preHandler: guard }, async (req, reply) => {
    const e = await empresaDoUsuario(ctx, req.userId, (req.params as { id: string }).id);
    if (!e) return reply.code(404).send(naoAchou);
    if (!ehMei(e)) return reply.code(409).send({ erro: 'Esta empresa não está como MEI.' });
    const b = z.object({ competencia: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Competência inválida.'), status: z.enum(['pago', 'nao_pago']) }).parse(req.body);
    await marcarDasMei(ctx, e, b.competencia, b.status);
    return situacaoFiscal(ctx, (await empresaDoUsuario(ctx, req.userId, e.id))!);
  });

  /** O dono corrige a atividade usada no valor do DAS-MEI (comércio, serviços ou os dois). */
  app.post('/api/empresas/:id/das-mei/atividade', { preHandler: guard }, async (req, reply) => {
    const e = await empresaDoUsuario(ctx, req.userId, (req.params as { id: string }).id);
    if (!e) return reply.code(404).send(naoAchou);
    if (!ehMei(e)) return reply.code(409).send({ erro: 'Esta empresa não está como MEI.' });
    const b = z.object({ atividade: z.enum(['comercio', 'servicos', 'ambos']) }).parse(req.body);
    await ctx.db.query('update empresas set das_atividade = $1 where id = $2', [b.atividade, e.id]);
    return situacaoFiscal(ctx, (await empresaDoUsuario(ctx, req.userId, e.id))!);
  });

  app.get('/api/alertas', { preHandler: guard }, async (req) => {
    const { rows } = await ctx.db.query('select id, empresa_id, nivel, texto, fonte, lido, criado_em from alertas where user_id = $1 order by criado_em desc limit 50', [req.userId]);
    return rows.map((r) => ({ id: r.id, empresaId: r.empresa_id, nivel: r.nivel, texto: r.texto, fonte: r.fonte, lido: r.lido, criadoEm: new Date(r.criado_em).toISOString() }));
  });

  app.post('/api/alertas/lidos', { preHandler: guard }, async (req) => {
    await ctx.db.query('update alertas set lido = true where user_id = $1', [req.userId]);
    return { ok: true };
  });
}
