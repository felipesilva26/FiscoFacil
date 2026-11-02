import type { Config } from './config.js';
import type { Db } from './db.js';
import type { Notifier } from './services/notifier.js';
import type { ReceitaProvider } from './receita/provider.js';

/** Tudo que as rotas precisam. Injetar isso facilita os testes (relógio, rede, e-mail, Receita). */
export interface Ctx {
  cfg: Config;
  db: Db;
  now: () => Date;
  fetchImpl: typeof fetch;
  notifier: Notifier;
  receita: ReceitaProvider;
}
