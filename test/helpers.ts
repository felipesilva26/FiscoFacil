import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { Ctx } from '../src/ctx.js';
import { createDb } from '../src/db.js';
import { MockReceitaProvider } from '../src/receita/mock.js';
import { MemoryNotifier } from '../src/services/notifier.js';

export const CNPJ_TESTE = '66.369.868/0001-71';

export async function criar(opts: { agora?: string; fetchImpl?: typeof fetch; limiteAuth?: number } = {}) {
  const cfg = { ...loadConfig({ NODE_ENV: 'test' }), env: 'test', limiteAuth: opts.limiteAuth ?? 1000, storageDir: mkdtempSync(join(tmpdir(), 'ff-')) };
  const url = process.env.TEST_DATABASE_URL;
  if (url) {
    // Postgres de verdade: zera o banco a cada app de teste.
    const pg = (await import('pg')).default;
    const c = new pg.Client({ connectionString: url }); await c.connect();
    await c.query('drop schema public cascade; create schema public'); await c.end();
  }
  const db = await createDb(url ? { databaseUrl: url } : {});
  const notifier = new MemoryNotifier();
  const agora = opts.agora ?? '2026-11-01T15:00:00Z';
  const ctx: Ctx = { cfg, db, now: () => new Date(agora), fetchImpl: opts.fetchImpl ?? (async () => { throw new Error('sem rede nos testes'); }), notifier, receita: new MockReceitaProvider() };
  const app = await buildApp(ctx);
  return { app, ctx, notifier, fechar: async () => { await app.close(); await db.close(); } };
}

let n = 0;
export async function cadastrar(app: FastifyInstance, nome = 'Ana') {
  const r = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { nome, email: `u${++n}@teste.com`, senha: 'senha-forte-123' } });
  const j = r.json();
  return { token: j.token as string, h: { authorization: `Bearer ${j.token}` } };
}
