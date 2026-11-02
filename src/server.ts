import { loadConfig } from './config.js';
import { buildApp } from './app.js';
import { createDb } from './db.js';
import type { Ctx } from './ctx.js';
import { MockReceitaProvider } from './receita/mock.js';
import { SemReceita } from './receita/provider.js';
import { SerproReceitaProvider } from './receita/serpro.js';
import { ConsoleNotifier, SmtpNotifier } from './services/notifier.js';
import { runReminders } from './services/reminders.js';
import { atualizarCadastrosAntigos } from './services/situacao.js';
import { importarPgfn } from './pgfn/importador.js';

const cfg = loadConfig();
const db = await createDb({ databaseUrl: cfg.databaseUrl, dataDir: cfg.dataDir });
const ctx: Ctx = {
  cfg, db, now: () => new Date(), fetchImpl: fetch,
  notifier: cfg.smtpUrl ? new SmtpNotifier(cfg.smtpUrl, cfg.mailFrom) : new ConsoleNotifier(),
  receita: cfg.receitaProvider === 'serpro' ? new SerproReceitaProvider(cfg.serpro) : cfg.receitaProvider === 'mock' ? new MockReceitaProvider() : new SemReceita(),
};
const app = await buildApp(ctx);

// Lembretes: confere a cada hora; cada aviso só sai uma vez (tabela lembretes_enviados).
let pgfnRodando = false;
const timer = setInterval(() => {
  runReminders(ctx).catch((e) => app.log.error(e));
  atualizarCadastrosAntigos(ctx).catch((e) => app.log.error(e));
  // Dívida ativa (PGFN): de madrugada, só quando há trimestre novo ou CNPJ ainda não conferido.
  const hora = Number(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo', hour: 'numeric', hour12: false }));
  if (hora === 3 && !pgfnRodando && process.env.PGFN_DESLIGADO !== '1') {
    pgfnRodando = true;
    importarPgfn(ctx).then((r) => app.log.info({ pgfn: r }, 'importação PGFN')).catch((e) => app.log.error(e)).finally(() => { pgfnRodando = false; });
  }
}, 60 * 60 * 1000);
timer.unref();

const parar = async () => { clearInterval(timer); await app.close(); await db.close(); process.exit(0); };
process.on('SIGINT', parar);
process.on('SIGTERM', parar);

await app.listen({ port: cfg.port, host: '0.0.0.0' });
