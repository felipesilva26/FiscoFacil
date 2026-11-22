import { loadConfig } from './config.js';
import { lookupCnpj } from './cnpj.js';
import { lerCertificado } from './receita/certificado.js';
import { buildApp } from './app.js';
import { createDb } from './db.js';
import type { Ctx } from './ctx.js';
import { MockReceitaProvider } from './receita/mock.js';
import { SemReceita } from './receita/provider.js';
import { SerproReceitaProvider } from './receita/serpro.js';
import { ConsoleNotifier, SmtpNotifier } from './services/notifier.js';
import { runReminders } from './services/reminders.js';
import { rodarMonitorSeVencido } from './services/monitor.js';
import { agendarPgfn, rodarPgfn } from './pgfn/importador.js';
import { limparDadosAntigos } from './routes/conta.js';

const cfg = loadConfig();
// Banco fora do ar na partida: tenta de novo algumas vezes antes de desistir, com mensagem clara (sem senha no log).
async function abrirBanco() {
  for (let t = 1; ; t++) {
    try { return await createDb({ databaseUrl: cfg.databaseUrl, dataDir: cfg.dataDir, schema: cfg.databaseSchema }); }
    catch (e) {
      console.error(`Banco de dados indisponível (tentativa ${t}/5): ${(e as Error).message}`);
      if (t >= 5) throw new Error('Não foi possível conectar ao banco de dados. Confira DATABASE_URL e se o banco está ativo.');
      await new Promise((r) => setTimeout(r, 3000 * t));
    }
  }
}
const db = await abrirBanco();
const ctx: Ctx = {
  cfg, db, now: () => new Date(), fetchImpl: fetch,
  notifier: cfg.smtpUrl ? new SmtpNotifier(cfg.smtpUrl, cfg.mailFrom) : new ConsoleNotifier(),
  receita: cfg.receitaProvider === 'serpro' ? new SerproReceitaProvider(cfg.serpro) : cfg.receitaProvider === 'mock' ? new MockReceitaProvider() : new SemReceita(),
};
const app = await buildApp(ctx);

// Lembretes: confere a cada hora; cada aviso só sai uma vez (tabela lembretes_enviados).
const timer = setInterval(() => {
  runReminders(ctx).catch((e) => app.log.error(e));
  // Robô de monitoramento: uma rodada por dia (cadastro de todas as empresas + validade das certidões).
  rodarMonitorSeVencido(ctx).then((r) => r && !r.ocupado && app.log.info(r, 'monitor: rodada concluída')).catch((e) => app.log.error(e));
  // Dívida ativa (PGFN): de madrugada, só quando há trimestre novo ou CNPJ ainda não conferido.
  const hora = Number(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo', hour: 'numeric', hour12: false }));
  if (hora === 3 && process.env.PGFN_DESLIGADO !== '1') void rodarPgfn(ctx);
  if (hora === 4) limparDadosAntigos(ctx).then((r) => r.contas && app.log.info(r, 'retenção: contas sem cadastro inativas removidas')).catch((e) => app.log.error(e));
}, 60 * 60 * 1000);
timer.unref();

const parar = async () => { clearInterval(timer); await app.close(); await db.close(); process.exit(0); };
process.on('SIGINT', parar);
process.on('SIGTERM', parar);

await app.listen({ port: cfg.port, host: '0.0.0.0' });
// Confere na PGFN os CNPJs que ainda não foram conferidos (não baixa nada se já estiver tudo em dia).
agendarPgfn(ctx, 20_000);
// Primeira rodada do robô logo depois de subir, se já passou de um dia desde a última.
setTimeout(() => { rodarMonitorSeVencido(ctx).catch((e) => app.log.error(e)); }, 90_000).unref();
db.query('select trimestre, origem, linhas, encontrados, cnpjs_verificados, concluido_em from pgfn_importacoes order by concluido_em')
  .then((r) => app.log.info({ pgfnImportacoes: r.rows }, 'PGFN: importações já feitas'))
  .catch(() => undefined);

// Diagnóstico ao iniciar: confere se cada fonte da consulta cadastral responde daqui do servidor.
for (const modelo of cfg.cnpjLookupUrl.split(',').map((m) => m.trim()).filter(Boolean)) {
  lookupCnpj('00000000000191', { url: modelo, fetchImpl: fetch, log: (m) => app.log.warn(m) })
    .then((c) => app.log.info(`consulta CNPJ disponível: ${c.fonte}`))
    .catch((e) => app.log.warn(`consulta CNPJ indisponível em ${modelo}: ${(e as Error).message}`));
}

// Confere o certificado e-CNPJ, se configurado (só titular, CNPJ e validade vão para o log).
if (cfg.serpro.certPfxPath) {
  try {
    const c = lerCertificado(cfg.serpro.certPfxPath, cfg.serpro.certPassword);
    app.log.info(`Certificado e-CNPJ OK: ${c.titular} (CNPJ ${c.cnpj ?? 'não identificado'}), emitido por ${c.emissor}, válido até ${c.validoAte.slice(0, 10)} (${c.diasRestantes} dias)${c.vencido ? ' - VENCIDO' : ''}`);
  } catch (e) {
    app.log.warn(`Certificado e-CNPJ com problema: ${(e as Error).message}`);
  }
}
