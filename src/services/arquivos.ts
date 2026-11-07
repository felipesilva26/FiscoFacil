import { readFile } from 'node:fs/promises';
import type { Ctx } from '../ctx.js';
import type { Row } from '../db.js';
import { newId, todayISO } from '../util.js';

/**
 * Guarda o arquivo dentro do banco (coluna bytea).
 * O disco do servidor gratuito é apagado a cada deploy; no banco o arquivo fica junto dos dados
 * e some de verdade quando a empresa ou a conta é excluída (LGPD).
 */
export async function guardarArquivo(ctx: Ctx, empresaId: string, o: { nome: string; tipo: string; buf: Buffer; validade?: string | null }): Promise<string> {
  const id = newId();
  await ctx.db.query(
    'insert into documentos (id, empresa_id, nome, tipo, tamanho, arquivo, conteudo, data, validade) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
    [id, empresaId, o.nome, o.tipo, o.buf.length, '', o.buf, todayISO(ctx.now()), o.validade ?? null],
  );
  return id;
}

/** Conteúdo do arquivo: do banco; documentos antigos ainda podem estar no disco. */
export async function lerArquivo(ctx: Ctx, d: Row): Promise<Buffer | null> {
  const { rows } = await ctx.db.query('select conteudo from documentos where id = $1', [d.id]);
  const c = rows[0]?.conteudo;
  if (c) return Buffer.from(c);
  if (d.arquivo) { try { return await readFile(d.arquivo); } catch { return null; } }
  return null;
}
