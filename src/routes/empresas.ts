import { unlink } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CnpjError, formatCnpj, lookupCnpj, onlyDigits, validCnpj, nomeSugerido, regimePelaReceita } from '../cnpj.js';
import type { Ctx } from '../ctx.js';
import { ReceitaNaoConfigurada } from '../receita/provider.js';
import { sincronizarReceita } from '../receita/sync.js';
import { auditar, empresaDoUsuario, REGIMES, resumoEmpresa, toEmpresa, toObrigacao } from '../services/dominio.js';
import { newId, todayISO } from '../util.js';
import { makeGuard } from './guard.js';
import { atualizarCadastro } from '../services/situacao.js';
import { agendarPgfn } from '../pgfn/importador.js';

const cnpjSchema = z.string().refine(validCnpj, 'CNPJ inválido. Confira os 14 números.').transform(formatCnpj);
const novaEmpresa = z.object({
  nome: z.string().trim().min(2, 'Informe o nome da empresa.').max(160),
  cnpj: cnpjSchema,
  regime: z.enum(REGIMES).default('Simples Nacional'),
});
const edicao = z.object({
  nome: z.string().trim().min(2).max(160).optional(),
  cnpj: z.union([z.literal(''), cnpjSchema]).nullable().optional(),
  regime: z.enum(REGIMES).optional(),
});
const conexao = z.object({
  cnpj: cnpjSchema.optional(),
  autorizacao: z.enum(['procuracao_ecac', 'procurador_contador', 'certificado_ecnpj']),
  confirmo: z.literal(true, { errorMap: () => ({ message: 'Confirme que você é responsável pelo CNPJ ou tem autorização.' }) }),
});

export async function empresasRoutes(app: FastifyInstance, ctx: Ctx) {
  const guard = makeGuard(ctx.cfg);
  const limite = { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } };
  const naoAchou = { erro: 'Empresa não encontrada.' };

  const cnpjEmUso = async (userId: string, cnpj: string, exceto?: string) => {
    const { rows } = await ctx.db.query('select id from empresas where user_id = $1 and cnpj = $2', [userId, cnpj]);
    return rows.some((r) => r.id !== exceto);
  };

  app.get('/api/empresas', { preHandler: guard }, async (req) => {
    const { rows } = await ctx.db.query('select * from empresas where user_id = $1 order by criado_em', [req.userId]);
    return rows.map(toEmpresa);
  });

  app.post('/api/empresas', { preHandler: guard }, async (req, reply) => {
    const b = novaEmpresa.parse(req.body);
    if (await cnpjEmUso(req.userId, b.cnpj)) return reply.code(409).send({ erro: 'Este CNPJ já está cadastrado.' });
    const id = newId();
    await ctx.db.query('insert into empresas (id, user_id, nome, cnpj, regime) values ($1, $2, $3, $4, $5)',
      [id, req.userId, b.nome, b.cnpj, b.regime]);
    await auditar(ctx, req.userId, id, 'empresa.criar');
    // Busca o cadastro público em segundo plano; a tela mostra quando chegar.
    const criada = await empresaDoUsuario(ctx, req.userId, id);
    if (criada) void atualizarCadastro(ctx, criada).catch(() => undefined);
    agendarPgfn(ctx);
    return reply.code(201).send(toEmpresa((await empresaDoUsuario(ctx, req.userId, id))!));
  });

  app.get('/api/empresas/:id', { preHandler: guard }, async (req, reply) => {
    const e = await empresaDoUsuario(ctx, req.userId, (req.params as { id: string }).id);
    return e ? toEmpresa(e) : reply.code(404).send(naoAchou);
  });

  app.patch('/api/empresas/:id', { preHandler: guard }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const atual = await empresaDoUsuario(ctx, req.userId, id);
    if (!atual) return reply.code(404).send(naoAchou);
    const b = edicao.parse(req.body);
    const cnpj = b.cnpj === undefined ? atual.cnpj : b.cnpj || null;
    if (cnpj && (await cnpjEmUso(req.userId, cnpj, id))) return reply.code(409).send({ erro: 'Este CNPJ já está cadastrado em outra empresa.' });
    await ctx.db.query('update empresas set nome = $1, cnpj = $2, regime = $3 where id = $4',
      [b.nome ?? atual.nome, cnpj, b.regime ?? atual.regime, id]);
    await auditar(ctx, req.userId, id, 'empresa.editar');
    return toEmpresa((await empresaDoUsuario(ctx, req.userId, id))!);
  });

  app.delete('/api/empresas/:id', { preHandler: guard }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!(await empresaDoUsuario(ctx, req.userId, id))) return reply.code(404).send(naoAchou);
    const { rows: arqs } = await ctx.db.query("select arquivo from documentos where empresa_id = $1 and arquivo <> ''", [id]);
    for (const a of arqs) await unlink(a.arquivo).catch(() => undefined);
    await ctx.db.query('delete from empresas where id = $1', [id]);
    await auditar(ctx, req.userId, null, 'empresa.excluir', { empresaId: id });
    return reply.code(204).send();
  });

  app.get('/api/empresas/:id/resumo', { preHandler: guard }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!(await empresaDoUsuario(ctx, req.userId, id))) return reply.code(404).send(naoAchou);
    return resumoEmpresa(ctx, id);
  });

  /** Visão de todas as empresas do usuário em um só lugar. */
  app.get('/api/resumo', { preHandler: guard }, async (req) => {
    const { rows } = await ctx.db.query('select * from empresas where user_id = $1 order by criado_em', [req.userId]);
    const empresas = [];
    const totais = { empresas: rows.length, totalPendente: 0, atrasadas: 0, proximos7Dias: 0 };
    for (const e of rows) {
      const resumo = await resumoEmpresa(ctx, e.id);
      totais.totalPendente += resumo.totalPendente;
      totais.atrasadas += resumo.atrasadas;
      totais.proximos7Dias += resumo.proximos7Dias;
      empresas.push({ empresa: toEmpresa(e), resumo });
    }
    totais.totalPendente = Math.round(totais.totalPendente * 100) / 100;
    return { totais, empresas };
  });

  app.get('/api/empresas/:id/calendario', { preHandler: guard }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!(await empresaDoUsuario(ctx, req.userId, id))) return reply.code(404).send(naoAchou);
    const hoje = todayISO(ctx.now());
    const { mes } = z.object({ mes: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).default(hoje.slice(0, 7)) }).parse(req.query);
    const { rows } = await ctx.db.query(
      'select * from obrigacoes where empresa_id = $1 and arquivado = false and venc like $2 order by venc',
      [id, `${mes}-%`],
    );
    const dias: Record<string, unknown[]> = {};
    for (const r of rows) (dias[r.venc] ??= []).push(toObrigacao(r, hoje));
    return { mes, dias };
  });

  /** Consulta cadastral pública por CNPJ (razão social, situação, atividade). Não traz débitos. */
  app.get('/api/cnpj/:cnpj', { preHandler: guard, ...limite }, async (req, reply) => {
    const cnpj = (req.params as { cnpj: string }).cnpj;
    try {
      const cadastral = await lookupCnpj(cnpj, { url: ctx.cfg.cnpjLookupUrl, fetchImpl: ctx.fetchImpl, now: ctx.now(), log: (m) => console.warn(m) });
      return { cnpj: formatCnpj(cnpj), valido: true, cadastral, regime: regimePelaReceita(cadastral), nome: nomeSugerido(cadastral) };
    } catch (e) {
      if (e instanceof CnpjError) {
        if (e.status === 400) return reply.code(400).send({ cnpj: formatCnpj(cnpj), valido: false, erro: e.message });
        return reply.code(e.status).send({ erro: e.message });
      }
      throw e;
    }
  });

  app.post('/api/empresas/:id/cadastro/atualizar', { preHandler: guard, ...limite }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const e = await empresaDoUsuario(ctx, req.userId, id);
    if (!e) return reply.code(404).send(naoAchou);
    if (!e.cnpj) return reply.code(409).send({ erro: 'Informe o CNPJ da empresa primeiro.' });
    try {
      const cad = await lookupCnpj(e.cnpj, { url: ctx.cfg.cnpjLookupUrl, fetchImpl: ctx.fetchImpl, now: ctx.now(), log: (m) => console.warn(m) });
      await ctx.db.query('update empresas set cadastral = $1 where id = $2', [JSON.stringify(cad), id]);
      return { cadastral: cad, nomeSugerido: cad.razaoSocial ?? null };
    } catch (err) {
      if (err instanceof CnpjError) return reply.code(err.status).send({ erro: err.message });
      throw err;
    }
  });

  // ---- Integração com a Receita ----
  const falhaReceita = (reply: import('fastify').FastifyReply, err: unknown) => {
    if (err instanceof ReceitaNaoConfigurada) return reply.code(503).send({ erro: err.message, faltando: err.faltando });
    return reply.code(502).send({ erro: 'A consulta à Receita falhou. Tente novamente mais tarde.' });
  };

  app.post('/api/empresas/:id/receita/conectar', { preHandler: guard }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const e = await empresaDoUsuario(ctx, req.userId, id);
    if (!e) return reply.code(404).send(naoAchou);
    const b = conexao.parse(req.body);
    const cnpj = b.cnpj ?? e.cnpj;
    if (!cnpj) return reply.code(400).send({ erro: 'Informe o CNPJ da empresa.' });
    if (await cnpjEmUso(req.userId, cnpj, id)) return reply.code(409).send({ erro: 'Este CNPJ já está cadastrado em outra empresa.' });
    await ctx.db.query('update empresas set cnpj = $1 where id = $2', [cnpj, id]);
    try {
      const r = await sincronizarReceita(ctx, { ...e, cnpj });
      await ctx.db.query('update empresas set receita_conectada = true where id = $1', [id]);
      await auditar(ctx, req.userId, id, 'receita.conectar', { autorizacao: b.autorizacao, provedor: ctx.receita.nome, cnpj: onlyDigits(cnpj) });
      return { conectada: true, ...r };
    } catch (err) {
      return falhaReceita(reply, err);
    }
  });

  app.post('/api/empresas/:id/receita/sincronizar', { preHandler: guard }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const e = await empresaDoUsuario(ctx, req.userId, id);
    if (!e) return reply.code(404).send(naoAchou);
    if (!e.receita_conectada || !e.cnpj) return reply.code(409).send({ erro: 'Conecte a empresa à Receita primeiro.' });
    try {
      const r = await sincronizarReceita(ctx, e);
      await auditar(ctx, req.userId, id, 'receita.sincronizar', { novas: r.novas, simulado: r.simulado });
      return r;
    } catch (err) {
      return falhaReceita(reply, err);
    }
  });

  app.post('/api/empresas/:id/receita/desconectar', { preHandler: guard }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!(await empresaDoUsuario(ctx, req.userId, id))) return reply.code(404).send(naoAchou);
    await ctx.db.query('update empresas set receita_conectada = false, receita_ultima = null where id = $1', [id]);
    await auditar(ctx, req.userId, id, 'receita.desconectar');
    return { conectada: false };
  });
}
