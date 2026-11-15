import { unlink } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../ctx.js';
import { makeGuard } from './guard.js';

/** Direitos do titular (LGPD, art. 18): acesso/portabilidade e eliminação dos dados. */
export async function contaRoutes(app: FastifyInstance, ctx: Ctx) {
  const guard = makeGuard(ctx.cfg);

  app.get('/api/conta/exportar', { preHandler: guard, config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
    const q = async (sql: string, p: unknown[] = [req.userId]) => (await ctx.db.query(sql, p)).rows;
    const [u] = await q('select id, nome, email, anonimo, criado_em, ultimo_acesso, aceite_privacidade from users where id = $1');
    if (!u) return reply.code(401).send({ erro: 'Sessão inválida.' });
    const sub = 'select empresa_id from (select id as empresa_id from empresas where user_id = $1) x';
    const dados = {
      geradoEm: ctx.now().toISOString(),
      aviso: 'Cópia dos seus dados no FiscoFácil (LGPD, art. 18). Os arquivos enviados estão listados; baixe cada um pelo sistema.',
      conta: { ...u, email: u.anonimo ? null : u.email },
      empresas: await q('select id, nome, cnpj, regime, cadastral, criado_em from empresas where user_id = $1'),
      obrigacoes: await q(`select * from obrigacoes where empresa_id in (${sub})`),
      notasFiscais: await q(`select * from notas_fiscais where empresa_id in (${sub})`),
      documentos: await q(`select id, empresa_id, nome, tipo, tamanho, data, validade, criado_em from documentos where empresa_id in (${sub})`),
      dasMei: await q(`select * from das_mei_status where empresa_id in (${sub})`),
      alertas: await q('select nivel, texto, fonte, lido, criado_em from alertas where user_id = $1'),
      lembretes: await q('select email, whatsapp, push, antecedencia from config_lembretes where user_id = $1'),
      registroDeAtividades: await q('select acao, empresa_id, detalhe, criado_em from auditoria where user_id = $1 order by criado_em desc limit 1000'),
    };
    return reply.header('content-disposition', 'attachment; filename="fiscofacil-meus-dados.json"').send(dados);
  });

  /** Apaga a conta e tudo ligado a ela. Não tem volta. */
  app.delete('/api/conta', { preHandler: guard, config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
    z.object({ confirmar: z.literal('EXCLUIR', { message: 'Digite EXCLUIR para confirmar.' }) }).parse(req.body);
    await excluirUsuario(ctx, req.userId);
    return reply.code(204).send();
  });
}

export async function excluirUsuario(ctx: Ctx, userId: string): Promise<void> {
  // Documentos antigos podem ter ficado no disco: apaga os arquivos antes das linhas.
  const { rows } = await ctx.db.query("select d.arquivo from documentos d join empresas e on e.id = d.empresa_id where e.user_id = $1 and d.arquivo <> ''", [userId]);
  for (const r of rows) await unlink(r.arquivo).catch(() => undefined);
  await ctx.db.query('delete from auditoria where user_id = $1', [userId]);
  await ctx.db.query('delete from users where id = $1', [userId]); // o resto sai em cascata
}

/** Retenção: contas sem cadastro paradas há 90 dias, registros de atividade com mais de 1 ano e alertas lidos antigos. */
export async function limparDadosAntigos(ctx: Ctx): Promise<{ contas: number }> {
  const { rows } = await ctx.db.query("select id from users where anonimo = true and ultimo_acesso < now() - interval '90 days'");
  for (const r of rows) await excluirUsuario(ctx, r.id);
  await ctx.db.query("delete from auditoria where criado_em < now() - interval '365 days'");
  await ctx.db.query("delete from alertas where lido = true and criado_em < now() - interval '180 days'");
  return { contas: rows.length };
}
