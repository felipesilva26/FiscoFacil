import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { SCHEMA } from './schema.js';

export type Row = Record<string, any>;

export interface Db {
  query<T extends Row = Row>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

/**
 * Com DATABASE_URL usa um PostgreSQL de verdade (produção).
 * Sem ela usa o PGlite, um PostgreSQL embutido que grava em dataDir (ou na memória se dataDir for vazio).
 * O SQL é o mesmo nos dois.
 */
export async function createDb(opts: { databaseUrl?: string; dataDir?: string }): Promise<Db> {
  let db: Db;
  if (opts.databaseUrl) {
    const pool = new pg.Pool({ connectionString: opts.databaseUrl });
    db = {
      query: async (sql, params) => ({ rows: (await pool.query(sql, params as any[])).rows as any }),
      exec: async (sql) => { await pool.query(sql); },
      close: () => pool.end(),
    };
  } else {
    // O PGlite não cria as pastas-pai sozinho.
    if (opts.dataDir) mkdirSync(dirname(opts.dataDir), { recursive: true });
    const lite = new PGlite(opts.dataDir || undefined);
    await lite.waitReady;
    db = {
      query: async (sql, params) => ({ rows: (await lite.query(sql, params as any[])).rows as any }),
      exec: async (sql) => { await lite.exec(sql); },
      close: () => lite.close(),
    };
  }
  await db.exec(SCHEMA);
  return db;
}
