import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { readToken } from '../auth.js';
import type { Config } from '../config.js';

declare module 'fastify' {
  interface FastifyRequest {
    userId: string;
  }
}

/** Exige "Authorization: Bearer <token>" e coloca o id do usuário em req.userId. */
export const makeGuard = (cfg: Config) => async (req: FastifyRequest, reply: FastifyReply) => {
  const h = req.headers.authorization ?? '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  const userId = token ? await readToken(cfg.jwtSecret, token) : null;
  if (!userId) return reply.code(401).send({ erro: 'Faça login para continuar.' });
  req.userId = userId;
};

/** Converte erros de validação (zod) em respostas 400 legíveis. */
export function mensagemDeErro(e: unknown): string | null {
  if (!(e instanceof ZodError)) return null;
  return e.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ` : '') + i.message).join('; ');
}
