import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { hashPassword, signToken, verifyPassword } from '../auth.js';
import type { Ctx } from '../ctx.js';
import { newId } from '../util.js';
import { makeGuard } from './guard.js';

const registro = z.object({
  nome: z.string().trim().min(2, 'Informe seu nome.').max(120),
  email: z.string().trim().toLowerCase().email('E-mail inválido.').max(200),
  senha: z.string().min(8, 'A senha precisa ter pelo menos 8 caracteres.').max(200),
});
const login = z.object({ email: z.string().trim().toLowerCase(), senha: z.string().min(1) });

export async function authRoutes(app: FastifyInstance, ctx: Ctx) {
  const guard = makeGuard(ctx.cfg);
  const limite = { config: { rateLimit: { max: ctx.cfg.limiteAuth ?? 10, timeWindow: '1 minute' } } };

  app.post('/api/auth/register', limite, async (req, reply) => {
    const b = registro.parse(req.body);
    const existe = await ctx.db.query('select 1 from users where email = $1', [b.email]);
    if (existe.rows.length) return reply.code(409).send({ erro: 'Já existe uma conta com este e-mail.' });
    const id = newId();
    await ctx.db.query('insert into users (id, email, nome, senha_hash) values ($1, $2, $3, $4)',
      [id, b.email, b.nome, await hashPassword(b.senha)]);
    await ctx.db.query('insert into config_lembretes (user_id) values ($1)', [id]);
    return reply.code(201).send({ token: await signToken(ctx.cfg.jwtSecret, id), usuario: { id, nome: b.nome, email: b.email } });
  });

  app.post('/api/auth/login', limite, async (req, reply) => {
    const b = login.parse(req.body);
    const { rows } = await ctx.db.query('select * from users where email = $1', [b.email]);
    const u = rows[0];
    // Mesma resposta para e-mail inexistente e senha errada, para não revelar quem tem conta.
    if (!u || !(await verifyPassword(b.senha, u.senha_hash))) {
      return reply.code(401).send({ erro: 'E-mail ou senha incorretos.' });
    }
    return { token: await signToken(ctx.cfg.jwtSecret, u.id), usuario: { id: u.id, nome: u.nome, email: u.email } };
  });

  app.get('/api/auth/me', { preHandler: guard }, async (req, reply) => {
    const { rows } = await ctx.db.query('select id, nome, email from users where id = $1', [req.userId]);
    if (!rows[0]) return reply.code(401).send({ erro: 'Sessão inválida.' });
    return rows[0];
  });

  app.patch('/api/auth/me', { preHandler: guard }, async (req) => {
    const b = z.object({ nome: z.string().trim().min(2, 'Informe seu nome.').max(120) }).parse(req.body);
    await ctx.db.query('update users set nome = $1 where id = $2', [b.nome, req.userId]);
    return { nome: b.nome };
  });
}
