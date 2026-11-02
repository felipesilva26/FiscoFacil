import { loadConfig } from './config.js';
import { createDb } from './db.js';
import { hashPassword } from './auth.js';
import { newId } from './util.js';

// Cria um usuário de teste com o CNPJ de modelo informado pelo projeto.
const cfg = loadConfig();
const db = await createDb({ databaseUrl: cfg.databaseUrl, dataDir: cfg.dataDir });
const email = 'teste@fiscofacil.local';
const { rows } = await db.query('select id from users where email = $1', [email]);
let uid = rows[0]?.id as string | undefined;
if (!uid) {
  uid = newId();
  await db.query('insert into users (id, email, nome, senha_hash) values ($1, $2, $3, $4)', [uid, email, 'Usuário de Teste', await hashPassword('teste1234')]);
  await db.query('insert into config_lembretes (user_id) values ($1) on conflict do nothing', [uid]);
}
await db.query(
  `insert into empresas (id, user_id, nome, cnpj, regime) values ($1, $2, $3, $4, $5) on conflict do nothing`,
  [newId(), uid, 'Empresa de Teste', '66.369.868/0001-71', 'Simples Nacional'],
);
console.log(`Pronto. Login: ${email} / teste1234  (CNPJ de teste: 66.369.868/0001-71)`);
await db.close();
