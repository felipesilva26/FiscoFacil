import { unlink } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../ctx.js';
import { guardarArquivo, lerArquivo } from '../services/arquivos.js';
import { auditar, empresaDoUsuario } from '../services/dominio.js';
import { lerDocumento } from '../services/leitor.js';
import { lerNotaTexto, lerNotaXml, pareceTextoDeNota, pareceXmlDeNota } from '../services/notafiscal.js';
import { extractText, getDocumentProxy } from 'unpdf';
import { isISODate, newId, todayISO } from '../util.js';
import { makeGuard } from './guard.js';

const TIPOS = ['Guia', 'Comprovante', 'Certidão', 'Nota fiscal', 'Outros'] as const;
const MIME: Record<string, string> = {
  pdf: 'application/pdf', xml: 'application/xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  csv: 'text/csv', txt: 'text/plain', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
const MAGIC: Record<string, number[]> = {
  pdf: [0x25, 0x50, 0x44, 0x46], png: [0x89, 0x50, 0x4e, 0x47], jpg: [0xff, 0xd8, 0xff], jpeg: [0xff, 0xd8, 0xff],
};

const limpaNome = (n: string) => basename(n).replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_').slice(0, 200) || 'arquivo';
const dono = async (ctx: Ctx, userId: string, id: string) => {
  const { rows } = await ctx.db.query(
    'select d.id, d.empresa_id, d.nome, d.tipo, d.tamanho, d.arquivo, d.data, d.validade from documentos d join empresas e on e.id = d.empresa_id where d.id = $1 and e.user_id = $2', [id, userId]);
  return rows[0] ?? null;
};
const toDoc = (r: Record<string, any>) => ({ id: r.id, empresaId: r.empresa_id, nome: r.nome, tipo: r.tipo, tamanho: r.tamanho, data: r.data, validade: r.validade ?? null });

export async function documentosRoutes(app: FastifyInstance, ctx: Ctx) {
  const guard = makeGuard(ctx.cfg);

  app.get('/api/empresas/:id/documentos', { preHandler: guard }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!(await empresaDoUsuario(ctx, req.userId, id))) return reply.code(404).send({ erro: 'Empresa não encontrada.' });
    const { rows } = await ctx.db.query('select id, empresa_id, nome, tipo, tamanho, data, validade from documentos where empresa_id = $1 order by criado_em desc', [id]);
    return rows.map(toDoc);
  });

  /** Envio em multipart/form-data, campo "file". O tipo vai na URL: ?tipo=Guia */
  app.post('/api/empresas/:id/documentos', { preHandler: guard }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!(await empresaDoUsuario(ctx, req.userId, id))) return reply.code(404).send({ erro: 'Empresa não encontrada.' });
    const { tipo, validade } = z.object({ tipo: z.enum(TIPOS).default('Outros'), validade: z.string().refine(isISODate, 'Validade inválida.').optional() }).parse(req.query);
    const parte = await req.file();
    if (!parte) return reply.code(400).send({ erro: 'Envie um arquivo no campo "file".' });
    const nome = limpaNome(parte.filename);
    const ext = extname(nome).slice(1).toLowerCase();
    if (!MIME[ext]) return reply.code(415).send({ erro: `Tipo de arquivo não aceito. Use: ${Object.keys(MIME).join(', ')}.` });
    const buf = await parte.toBuffer();
    if (parte.file.truncated) return reply.code(413).send({ erro: 'Arquivo acima de 10 MB.' });
    const magic = MAGIC[ext];
    if (magic && !magic.every((b, i) => buf[i] === b)) return reply.code(415).send({ erro: 'O conteúdo do arquivo não corresponde à extensão.' });

    const docId = await guardarArquivo(ctx, id, { nome, tipo, buf, validade });
    await auditar(ctx, req.userId, id, 'documento.enviar', { id: docId, tipo });
    const { rows } = await ctx.db.query('select id, empresa_id, nome, tipo, tamanho, data, validade from documentos where id = $1', [docId]);
    return reply.code(201).send(toDoc(rows[0]));
  });

  /** Lê um PDF e devolve uma SUGESTÃO de dados. Não salva nada. */
  app.post('/api/empresas/:id/documentos/ler', { preHandler: guard, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const e = await empresaDoUsuario(ctx, req.userId, id);
    if (!e) return reply.code(404).send({ erro: 'Empresa não encontrada.' });
    const parte = await req.file();
    if (!parte) return reply.code(400).send({ erro: 'Envie um arquivo no campo "file".' });
    const buf = await parte.toBuffer();
    if (parte.file.truncated) return reply.code(413).send({ erro: 'Arquivo acima de 10 MB.' });
    const nomeArq = (parte.filename || '').toLowerCase();
    if (nomeArq.endsWith('.xml') || buf.subarray(0, 200).toString('utf8').trimStart().startsWith('<')) {
      const xml = buf.toString('utf8');
      if (!pareceXmlDeNota(xml)) return reply.code(422).send({ erro: 'Este XML não é de nota fiscal (NF-e, NFC-e ou NFS-e).' });
      const nota = lerNotaXml(xml, e.cnpj);
      const repetida = nota.chave ? (await ctx.db.query('select id from notas_fiscais where empresa_id = $1 and chave = $2', [id, nota.chave])).rows.length > 0 : false;
      await auditar(ctx, req.userId, id, 'documento.ler', { tipo: 'nota', origem: 'xml' });
      return { leitura: { tipo: 'nota', nota, avisos: nota.avisos, confianca: nota.confianca }, candidatos: [], duplicada: repetida, hoje: todayISO(ctx.now()) };
    }
    if (!MAGIC.pdf.every((b, i) => buf[i] === b)) return reply.code(415).send({ erro: 'A leitura automática funciona com PDF e com XML de nota fiscal.' });
    let texto = '';
    try {
      const pdf = await getDocumentProxy(new Uint8Array(buf));
      texto = (await extractText(pdf, { mergePages: true })).text;
      // Carimbos como "PAGO DIA 16/11/2026" vêm como anotação do PDF, não como texto da página.
      for (let n = 1; n <= Math.min(pdf.numPages, 5); n++) {
        try {
          const anot = await (await pdf.getPage(n)).getAnnotations();
          for (const x of anot as { subtype?: string; contentsObj?: { str?: string }; contents?: string }[]) {
            const c = x.contentsObj?.str ?? x.contents;
            if (c && (x.subtype === 'FreeText' || x.subtype === 'Stamp' || x.subtype === 'Text')) texto += `\n${String(c).slice(0, 200)}`;
          }
        } catch { /* sem anotações legíveis: segue só com o texto */ }
      }
    } catch {
      return reply.code(422).send({ erro: 'Não consegui abrir este PDF.' });
    }
    if (texto.replace(/\s/g, '').length < 20) {
      return reply.code(422).send({ erro: 'Este PDF não tem texto (parece digitalizado). Ainda não leio imagens: cadastre manualmente.' });
    }
    if (pareceTextoDeNota(texto)) {
      const nota = lerNotaTexto(texto, e.cnpj);
      const repetida = nota.chave ? (await ctx.db.query('select id from notas_fiscais where empresa_id = $1 and chave = $2', [id, nota.chave])).rows.length > 0 : false;
      await auditar(ctx, req.userId, id, 'documento.ler', { tipo: 'nota', origem: 'pdf' });
      return { leitura: { tipo: 'nota', nota, avisos: nota.avisos, confianca: nota.confianca }, candidatos: [], duplicada: repetida, hoje: todayISO(ctx.now()) };
    }
    const leitura = lerDocumento(texto, e.cnpj);
    const hoje = todayISO(ctx.now());
    let candidatos: unknown[] = [];
    let duplicada = false;
    if (leitura.tipo === 'comprovante' && leitura.valor) {
      const { rows } = await ctx.db.query(
        'select * from obrigacoes where empresa_id = $1 and pago_em is null and arquivado = false and abs(valor_centavos - $2) <= 1 order by venc', [id, Math.round(leitura.valor * 100)]);
      candidatos = rows.map((r) => ({ id: r.id, tributo: r.tributo, venc: r.venc, valor: r.valor_centavos / 100 }));
    }
    if (leitura.tipo === 'guia' && leitura.tributo && leitura.vencimento && leitura.valor) {
      const { rows } = await ctx.db.query(
        'select id from obrigacoes where empresa_id = $1 and tributo = $2 and venc = $3 and valor_centavos = $4', [id, leitura.tributo, leitura.vencimento, Math.round(leitura.valor * 100)]);
      duplicada = rows.length > 0;
    }
    await auditar(ctx, req.userId, id, 'documento.ler', { tipo: leitura.tipo, confianca: leitura.confianca });
    return { leitura, candidatos, duplicada, hoje };
  });

  app.get('/api/documentos/:id/arquivo', { preHandler: guard }, async (req, reply) => {
    const d = await dono(ctx, req.userId, (req.params as { id: string }).id);
    if (!d) return reply.code(404).send({ erro: 'Documento não encontrado.' });
    const ext = extname(d.nome).slice(1).toLowerCase();
    const conteudo = await lerArquivo(ctx, d);
    if (!conteudo) return reply.code(410).send({ erro: 'O arquivo não está mais disponível.' });
    return reply
      .header('content-type', MIME[ext] ?? 'application/octet-stream')
      .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(d.nome)}`)
      .header('x-content-type-options', 'nosniff')
      .send(conteudo);
  });

  app.delete('/api/documentos/:id', { preHandler: guard }, async (req, reply) => {
    const d = await dono(ctx, req.userId, (req.params as { id: string }).id);
    if (!d) return reply.code(404).send({ erro: 'Documento não encontrado.' });
    await ctx.db.query('delete from documentos where id = $1', [d.id]);
    if (d.arquivo) await unlink(d.arquivo).catch(() => undefined);
    await auditar(ctx, req.userId, d.empresa_id, 'documento.excluir', { id: d.id });
    return reply.code(204).send();
  });
}
