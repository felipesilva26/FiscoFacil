import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Ctx } from './ctx.js';
import { authRoutes } from './routes/auth.js';
import { documentosRoutes } from './routes/documentos.js';
import { empresasRoutes } from './routes/empresas.js';
import { extrasRoutes } from './routes/extras.js';
import { mensagemDeErro } from './routes/guard.js';
import { obrigacoesRoutes } from './routes/obrigacoes.js';
import { situacaoRoutes } from './routes/situacao.js';
import { notasRoutes } from './routes/notas.js';
import { contaRoutes } from './routes/conta.js';
import { CnpjError } from './cnpj.js';
import { ReceitaNaoConfigurada } from './receita/provider.js';

const escHtml = (t: string) => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export async function buildApp(ctx: Ctx): Promise<FastifyInstance> {
  const app = Fastify({ logger: ctx.cfg.env === 'test' ? false : { level: 'info', redact: ['req.headers.authorization'] }, bodyLimit: 1_000_000, trustProxy: true });

  await app.register(cors, { origin: ctx.cfg.corsOrigin.length ? ctx.cfg.corsOrigin : false, methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] });
  // Limite por IP só na API (página e fontes não contam); escritórios atrás de um mesmo IP têm folga.
  await app.register(rateLimit, { max: 600, timeWindow: '1 minute', allowList: (req) => !req.url.startsWith('/api/') });
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 1 } });

  // CSP: só roda o script da própria página (pelo hash); nada de fora do site.
  const pub = resolve(process.cwd(), 'public');
  const hashes = existsSync(join(pub, 'index.html'))
    ? [...readFileSync(join(pub, 'index.html'), 'utf8').matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => `'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`)
    : [];
  const csp = [`default-src 'self'`, `script-src 'self' ${hashes.join(' ')}`.trim(), `style-src 'self' 'unsafe-inline'`, `img-src 'self' data: blob:`, `font-src 'self'`,
    `connect-src 'self'`, `frame-ancestors 'none'`, `base-uri 'none'`, `form-action 'self'`, `object-src 'none'`].join('; ');
  app.addHook('onSend', async (req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    reply.header('content-security-policy', csp);
    if (ctx.cfg.env === 'production') reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
    reply.header('cache-control', req.url.startsWith('/fonts/') ? 'public, max-age=31536000, immutable' : 'no-store');
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
  await notasRoutes(app, ctx);
  await contaRoutes(app, ctx);

  // Política de privacidade com o responsável e o contato definidos no servidor.
  app.get('/privacidade.html', async (_req, reply) => {
    const arq = resolve(process.cwd(), 'frontend', 'privacidade.html');
    if (!existsSync(arq)) return reply.code(404).send('Não encontrado');
    const html = readFileSync(arq, 'utf8')
      .replaceAll('{{RESPONSAVEL}}', escHtml(ctx.cfg.privacidadeResponsavel))
      .replaceAll('{{CONTATO}}', ctx.cfg.privacidadeContato ? `<a href="mailto:${escHtml(ctx.cfg.privacidadeContato)}">${escHtml(ctx.cfg.privacidadeContato)}</a>` : 'o responsável pelo projeto');
    return reply.type('text/html; charset=utf-8').send(html);
  });

  // Tela do FiscoFácil servida pelo próprio backend (mesma origem, sem CORS).
  if (existsSync(pub)) {
    await app.register(fastifyStatic, { root: pub, wildcard: false });
  }
  return app;
}
