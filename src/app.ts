import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Ctx } from './ctx.js';
import { authRoutes } from './routes/auth.js';
import { documentosRoutes } from './routes/documentos.js';
import { empresasRoutes } from './routes/empresas.js';
import { extrasRoutes } from './routes/extras.js';
import { mensagemDeErro } from './routes/guard.js';
import { obrigacoesRoutes } from './routes/obrigacoes.js';
import { situacaoRoutes } from './routes/situacao.js';
import { CnpjError } from './cnpj.js';
import { ReceitaNaoConfigurada } from './receita/provider.js';

export async function buildApp(ctx: Ctx): Promise<FastifyInstance> {
  const app = Fastify({ logger: ctx.cfg.env === 'test' ? false : { level: 'info', redact: ['req.headers.authorization'] }, bodyLimit: 1_000_000, trustProxy: true });

  await app.register(cors, { origin: ctx.cfg.corsOrigin.length ? ctx.cfg.corsOrigin : false, methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] });
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 1 } });

  app.addHook('onSend', async (_req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('cache-control', 'no-store');
  });

  app.setErrorHandler((err: unknown, _req, reply) => {
    const zod = mensagemDeErro(err);
    if (zod) return reply.code(400).send({ erro: zod });
    if (err instanceof CnpjError) return reply.code(err.status).send({ erro: err.message });
    if (err instanceof ReceitaNaoConfigurada) {
      return reply.code(503).send({ erro: 'Integração com a Receita ainda não configurada no servidor.', faltando: err.faltando });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.code(status).send({ erro: status === 429 ? 'Muitas tentativas. Aguarde um minuto.' : (err as Error).message });
    }
    app.log.error(err);
    return reply.code(500).send({ erro: 'Erro interno. Tente novamente.' });
  });

  app.setNotFoundHandler((req, reply) => (req.url.startsWith('/api/') ? reply.code(404).send({ erro: 'Rota não encontrada.' }) : reply.code(404).send('Não encontrado')));

  app.get('/api/health', async () => ({ ok: true, receita: ctx.receita.nome, semLogin: ctx.cfg.semLogin }));

  await authRoutes(app, ctx);
  await empresasRoutes(app, ctx);
  await obrigacoesRoutes(app, ctx);
  await documentosRoutes(app, ctx);
  await extrasRoutes(app, ctx);
  await situacaoRoutes(app, ctx);

  // Tela do FiscoFácil servida pelo próprio backend (mesma origem, sem CORS).
  const pub = resolve(process.cwd(), 'public');
  if (existsSync(pub)) {
    await app.register(fastifyStatic, { root: pub, wildcard: false });
  }
  return app;
}
