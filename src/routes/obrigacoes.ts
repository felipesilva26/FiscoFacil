import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../ctx.js';
import { auditar, empresaDoUsuario, obrigacaoDoUsuario, TRIBUTOS, toObrigacao } from '../services/dominio.js';
import { isISODate, newId, todayISO, toCents } from '../util.js';
import { makeGuard } from './guard.js';

const data = z.string().refine(isISODate, 'Data inválida. Use AAAA-MM-DD.');
const valor = z.number({ error: 'Informe o valor em reais (número).' })
  .positive('O valor precisa ser maior que zero.').max(21_000_000, 'Valor acima do limite.');

const nova = z.object({
  tributo: z.enum(TRIBUTOS),
  venc: data,
  valor,
  codigo: z.string().trim().max(200).optional(),
});
const edicao = z.object({
  tributo: z.enum(TRIBUTOS).optional(),
  venc: data.optional(),
  valor: valor.optional(),
  codigo: z.string().trim().max(200).optional(),
  arquivado: z.boolean().optional(),
});
const pagamento = z.object({
  data: data.optional(),
  comprovante: z.string().trim().max(200).optional(),
});
const filtro = z.object({
  status: z.enum(['aberta', 'pago', 'atrasado', 'avencer']).optional(),
  tributo: z.enum(TRIBUTOS).optional(),
  arquivadas: z.enum(['true', 'false']).default('false'),
  busca: z.string().trim().max(100).optional(),
});

export async function obrigacoesRoutes(app: FastifyInstance, ctx: Ctx) {
  const guard = makeGuard(ctx.cfg);
  const naoAchou = { erro: 'Obrigação não encontrada.' };

  app.get('/api/empresas/:id/obrigacoes', { preHandler: guard }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!(await empresaDoUsuario(ctx, req.userId, id))) return reply.code(404).send({ erro: 'Empresa não encontrada.' });
    const f = filtro.parse(req.query);
    const hoje = todayISO(ctx.now());
    const { rows } = await ctx.db.query(
      'select * from obrigacoes where empresa_id = $1 and arquivado = $2 order by venc, criado_em', [id, f.arquivadas === 'true'],
    );
    const busca = f.busca?.toLowerCase();
    return rows
      .map((r) => toObrigacao(r, hoje))
      .filter((o) => (f.tributo ? o.tributo === f.tributo : true))
      .filter((o) => (f.status === 'aberta' ? o.status !== 'pago' : f.status ? o.status === f.status : true))
      .filter((o) => (busca ? `${o.tributo} ${o.venc} ${o.valor}`.toLowerCase().includes(busca) : true));
  });

  app.post('/api/empresas/:id/obrigacoes', { preHandler: guard }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!(await empresaDoUsuario(ctx, req.userId, id))) return reply.code(404).send({ erro: 'Empresa não encontrada.' });
    const b = nova.parse(req.body);
    const oid = newId();
    await ctx.db.query(
      'insert into obrigacoes (id, empresa_id, tributo, venc, valor_centavos, codigo) values ($1, $2, $3, $4, $5, $6)',
      [oid, id, b.tributo, b.venc, toCents(b.valor), b.codigo ?? ''],
    );
    await auditar(ctx, req.userId, id, 'obrigacao.criar', { id: oid });
    const { rows } = await ctx.db.query('select * from obrigacoes where id = $1', [oid]);
    return reply.code(201).send(toObrigacao(rows[0], todayISO(ctx.now())));
  });

  app.patch('/api/obrigacoes/:id', { preHandler: guard }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const o = await obrigacaoDoUsuario(ctx, req.userId, id);
    if (!o) return reply.code(404).send(naoAchou);
    const b = edicao.parse(req.body);
    await ctx.db.query(
      'update obrigacoes set tributo = $1, venc = $2, valor_centavos = $3, codigo = $4, arquivado = $5 where id = $6',
      [b.tributo ?? o.tributo, b.venc ?? o.venc, b.valor === undefined ? o.valor_centavos : toCents(b.valor), b.codigo ?? o.codigo, b.arquivado ?? o.arquivado, id],
    );
    await auditar(ctx, req.userId, o.empresa_id, 'obrigacao.editar', { id });
    const { rows } = await ctx.db.query('select * from obrigacoes where id = $1', [id]);
    return toObrigacao(rows[0], todayISO(ctx.now()));
  });

  app.post('/api/obrigacoes/:id/pagar', { preHandler: guard }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const o = await obrigacaoDoUsuario(ctx, req.userId, id);
    if (!o) return reply.code(404).send(naoAchou);
    const b = pagamento.parse(req.body ?? {});
    const hoje = todayISO(ctx.now());
    const quando = b.data ?? hoje;
    if (quando > hoje) return reply.code(400).send({ erro: 'A data do pagamento não pode ser no futuro.' });
    await ctx.db.query('update obrigacoes set pago_em = $1, comprovante = $2 where id = $3', [quando, b.comprovante ?? '', id]);
    await auditar(ctx, req.userId, o.empresa_id, 'obrigacao.pagar', { id, data: quando });
    const { rows } = await ctx.db.query('select * from obrigacoes where id = $1', [id]);
    return toObrigacao(rows[0], hoje);
  });

  app.post('/api/obrigacoes/:id/desfazer-pagamento', { preHandler: guard }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const o = await obrigacaoDoUsuario(ctx, req.userId, id);
    if (!o) return reply.code(404).send(naoAchou);
    await ctx.db.query("update obrigacoes set pago_em = null, comprovante = '' where id = $1", [id]);
    await auditar(ctx, req.userId, o.empresa_id, 'obrigacao.desfazer_pagamento', { id });
    const { rows } = await ctx.db.query('select * from obrigacoes where id = $1', [id]);
    return toObrigacao(rows[0], todayISO(ctx.now()));
  });

  app.delete('/api/obrigacoes/:id', { preHandler: guard }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const o = await obrigacaoDoUsuario(ctx, req.userId, id);
    if (!o) return reply.code(404).send(naoAchou);
    await ctx.db.query('delete from obrigacoes where id = $1', [id]);
    await auditar(ctx, req.userId, o.empresa_id, 'obrigacao.excluir', { id });
    return reply.code(204).send();
  });
}
