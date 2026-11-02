// Uso: npm run pgfn:importar  (baixa a base mais recente da PGFN e cruza com os CNPJs cadastrados)
import { loadConfig } from './config.js';
import { createDb } from './db.js';
import { importarPgfn } from './pgfn/importador.js';
import { ConsoleNotifier, SmtpNotifier } from './services/notifier.js';
import { SemReceita } from './receita/provider.js';

const cfg = loadConfig();
const db = await createDb({ databaseUrl: cfg.databaseUrl, dataDir: cfg.dataDir, schema: cfg.databaseSchema });
const ctx = { cfg, db, now: () => new Date(), fetchImpl: fetch, notifier: cfg.smtpUrl ? new SmtpNotifier(cfg.smtpUrl, cfg.mailFrom) : new ConsoleNotifier(), receita: new SemReceita() };
console.log(JSON.stringify(await importarPgfn(ctx, { forcar: process.argv.includes('--forcar') }), null, 2));
await db.close();
