import { basename } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Cadastral } from '../cnpj.js';
import { onlyDigits } from '../cnpj.js';
import type { Ctx } from '../ctx.js';
import type { Row } from '../db.js';
import { guardarArquivo } from '../services/arquivos.js';
import { ehMei } from '../services/dasmei.js';
import { auditar, empresaDoUsuario } from '../services/dominio.js';
import { chaveValida, lerNotaXml, limiteMei, pareceXmlDeNota } from '../services/notafiscal.js';
import { isISODate, newId, todayISO } from '../util.js';
import { makeGuard } from './guard.js';

const nova = z.object({
  documentoId: z.string().optional(),
  tipo: z.enum(['NF-e', 'NFC-e', 'NFS-e', 'Nota fiscal', 'Venda sem nota']),
  chave: z.string().regex(/^\d{44}$|^\d{50}$/).nullable().optional(),
  numero: z.string().trim().max(20).nullable().optional(),
  serie: z.string().trim().max(5).nullable().optional(),
  dataEmissao: z.string().refine(isISODate, 'Data de emissão inválida.'),
  direcao: z.enum(['emitida', 'recebida']),
  contraparteDoc: z.string().nullable().optional(),
  contraparteNome: z.string().trim().max(200).nullable().optional(),
  valor: z.number().positive('O valor precisa ser maior que zero.').max(1e10),
  impostos: z.record(z.string(), z.number().nonnegative()).default({}),
});

const toNota = (r: Row) => ({
  id: r.id, empresaId: r.empresa_id, documentoId: r.documento_id, tipo: r.tipo, chave: r.chave, numero: r.numero, serie: r.serie,
  dataEmissao: r.data_emissao, direcao: r.direcao, contraparteDoc: r.contraparte_doc, contraparteNome: r.contraparte_nome,
  valor: Number(r.valor_centavos) / 100, impostos: r.impostos ?? {},
});

async function inserir(ctx: Ctx, empresaId: string, b: z.infer<typeof nova>): Promise<{ nota: ReturnType<typeof toNota>; repetida: boolean }> {
  if (b.chave) {
    const { rows } = await ctx.db.query('select * from notas_fiscais where empresa_id = $1 and chave = $2', [empresaId, b.chave]);
    if (rows.length) return { nota: toNota(rows[0]), repetida: true };
  }
  const id = newId();
  await ctx.db.query(
    `insert into notas_fiscais (id, empresa_id, documento_id, tipo, chave, numero, serie, data_emissao, direcao, contraparte_doc, contraparte_nome, valor_centavos, impostos)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [id, empresaId, b.documentoId ?? null, b.tipo, b.chave ?? null, b.numero ?? null, b.serie ?? null, b.dataEmissao, b.direcao,
      b.contraparteDoc ? onlyDigits(b.contraparteDoc) : null, b.contraparteNome ?? null, Math.round(b.valor * 100), JSON.stringify(b.impostos ?? {})]);
  const { rows } = await ctx.db.query('select * from notas_fiscais where id = $1', [id]);
  return { nota: toNota(rows[0]), repetida: false };
}

const r2 = (v: number) => Math.round(v * 100) / 100;
/** Faturamento do MEI contra o limite do ano. Até 20% acima: paga DAS sobre o excesso e vira ME no ano seguinte; acima disso, o desenquadramento é retroativo. */
function situacaoMei(e: Row, ano: number, usado: number) {
  const c = e.cadastral as Cadastral | null;
  const { limite, meses } = limiteMei(ano, c?.meiDesde ?? c?.abertura);
  return { limite, meses, usado, restante: r2(limite - usado), percentual: limite ? Math.round((usado / limite) * 1000) / 10 : 0,
    situacao: usado > limite * 1.2 ? 'acima20' : usado > limite ? 'acima' : usado > limite * 0.8 ? 'perto' : 'ok' };
}

export async function notasRoutes(app: FastifyInstance, ctx: Ctx) {
  const guard = makeGuard(ctx.cfg);
  const naoAchou = { erro: 'Empresa não encontrada.' };

  /** Lista e resumo do ano: faturamento (emitidas), compras (recebidas) e, para MEI, o limite anual. */
  app.get('/api/empresas/:id/notas', { preHandler: guard }, async (req, reply) => {
    const e = await empresaDoUsuario(ctx, req.userId, (req.params as { id: string }).id);
    if (!e) return reply.code(404).send(naoAchou);
    const hoje = todayISO(ctx.now());
    const { ano } = z.object({ ano: z.coerce.number().int().min(2000).max(2100).default(Number(hoje.slice(0, 4))) }).parse(req.query);
    const { rows } = await ctx.db.query('select * from notas_fiscais where empresa_id = $1 order by data_emissao desc, criado_em desc', [e.id]);
    const notas = rows.map(toNota);
    const doAno = notas.filter((n) => n.dataEmissao.startsWith(String(ano)));
    const soma = (l: typeof notas) => Math.round(l.reduce((s, n) => s + n.valor, 0) * 100) / 100;
    const emitidas = doAno.filter((n) => n.direcao === 'emitida');
    const recebidas = doAno.filter((n) => n.direcao === 'recebida');
    const mes = hoje.slice(0, 7);
    const porMes = Array.from({ length: 12 }, (_, i) => soma(emitidas.filter((n) => n.dataEmissao.slice(5, 7) === String(i + 1).padStart(2, '0'))));
    const mei = ehMei(e) ? situacaoMei(e, ano, soma(emitidas)) : null;
    return { ano, notas, resumo: { emitidas: { qtd: emitidas.length, total: soma(emitidas), mes: soma(emitidas.filter((n) => n.dataEmissao.startsWith(mes))) }, recebidas: { qtd: recebidas.length, total: soma(recebidas) }, porMes }, mei };
  });

  /** Para onde vai o dinheiro: faturamento do ano (com e sem nota) e impostos pagos por tipo. */
  app.get('/api/empresas/:id/financeiro', { preHandler: guard }, async (req, reply) => {
    const e = await empresaDoUsuario(ctx, req.userId, (req.params as { id: string }).id);
    if (!e) return reply.code(404).send(naoAchou);
    const hoje = todayISO(ctx.now());
    const { ano } = z.object({ ano: z.coerce.number().int().min(2000).max(2100).default(Number(hoje.slice(0, 4))) }).parse(req.query);
    const a = String(ano);
    const notas = (await ctx.db.query("select * from notas_fiscais where empresa_id = $1 and data_emissao like $2", [e.id, `${a}-%`])).rows.map(toNota);
    const vendas = notas.filter((n) => n.direcao === 'emitida');
    const porMes = Array.from({ length: 12 }, (_, i) => r2(vendas.filter((n) => Number(n.dataEmissao.slice(5, 7)) === i + 1).reduce((t, n) => t + n.valor, 0)));
    const total = r2(porMes.reduce((t, v) => t + v, 0));
    const semNota = r2(vendas.filter((n) => n.tipo === 'Venda sem nota').reduce((t, n) => t + n.valor, 0));
    const compras = r2(notas.filter((n) => n.direcao === 'recebida').reduce((t, n) => t + n.valor, 0));
    // Guias: pagas no ano (pela data do pagamento) e em aberto com vencimento no ano.
    const obr = (await ctx.db.query('select tributo, venc, pago_em, valor_centavos from obrigacoes where empresa_id = $1 and arquivado = false and (pago_em like $2 or (pago_em is null and venc like $2))', [e.id, `${a}-%`])).rows;
    const porTributo = new Map<string, { tributo: string; pago: number; emAberto: number; guias: number }>();
    for (const o of obr) {
      const t = porTributo.get(o.tributo) ?? { tributo: o.tributo, pago: 0, emAberto: 0, guias: 0 };
      if (o.pago_em) t.pago += Number(o.valor_centavos) / 100; else t.emAberto += Number(o.valor_centavos) / 100;
      t.guias += 1; porTributo.set(o.tributo, t);
    }
    const impostos = [...porTributo.values()].map((t) => ({ ...t, pago: r2(t.pago), emAberto: r2(t.emAberto) })).sort((x, y) => y.pago + y.emAberto - (x.pago + x.emAberto));
    const pagos = r2(impostos.reduce((t, i) => t + i.pago, 0));
    const destacados: Record<string, number> = {};
    for (const n of vendas) for (const [k, v] of Object.entries(n.impostos as Record<string, number>)) if (v) destacados[k] = r2((destacados[k] ?? 0) + v);
    return {
      ano, faturamento: { total, comNota: r2(total - semNota), semNota, porMes, notas: vendas.length }, compras,
      impostos, impostosPagos: pagos, impostosEmAberto: r2(impostos.reduce((t, i) => t + i.emAberto, 0)),
      cargaTributaria: total ? Math.round((pagos / total) * 1000) / 10 : null, destacadosNasNotas: destacados,
      mei: ehMei(e) ? situacaoMei(e, ano, total) : null,
    };
  });

  app.post('/api/empresas/:id/notas', { preHandler: guard }, async (req, reply) => {
    const e = await empresaDoUsuario(ctx, req.userId, (req.params as { id: string }).id);
    if (!e) return reply.code(404).send(naoAchou);
    const b = nova.parse(req.body);
    if (b.documentoId) {
      const { rows } = await ctx.db.query('select id from documentos where id = $1 and empresa_id = $2', [b.documentoId, e.id]);
      if (!rows.length) return reply.code(400).send({ erro: 'Documento não encontrado nesta empresa.' });
    }
    const r = await inserir(ctx, e.id, b);
    if (!r.repetida) await auditar(ctx, req.userId, e.id, 'nota.criar', { id: r.nota.id });
    return reply.code(r.repetida ? 200 : 201).send(r);
  });

  /** Vários XML de uma vez (o contador costuma mandar assim): guarda o arquivo e registra a nota. */
  app.post('/api/empresas/:id/notas/importar', { preHandler: guard, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
    const e = await empresaDoUsuario(ctx, req.userId, (req.params as { id: string }).id);
    if (!e) return reply.code(404).send(naoAchou);
    const parte = await req.file();
    if (!parte) return reply.code(400).send({ erro: 'Envie um arquivo XML no campo "file".' });
    const buf = await parte.toBuffer();
    if (parte.file.truncated) return reply.code(413).send({ erro: 'Arquivo acima de 10 MB.' });
    const xml = buf.toString('utf8');
    if (!pareceXmlDeNota(xml)) return reply.code(422).send({ erro: `${parte.filename}: não é XML de nota fiscal.` });
    const n = lerNotaXml(xml, e.cnpj);
    if (n.direcao === 'outra') return reply.code(422).send({ erro: `${parte.filename}: a nota não é desta empresa (CNPJ não confere).` });
    if (!n.valor || !n.dataEmissao) return reply.code(422).send({ erro: `${parte.filename}: não encontrei valor ou data.` });
    if (n.chave && n.chave.length === 44 && !chaveValida(n.chave)) return reply.code(422).send({ erro: `${parte.filename}: chave de acesso inválida.` });
    if (n.chave) {
      const { rows } = await ctx.db.query('select * from notas_fiscais where empresa_id = $1 and chave = $2', [e.id, n.chave]);
      if (rows.length) return { nota: toNota(rows[0]), repetida: true };
    }
    const docId = await guardarArquivo(ctx, e.id, { nome: basename(parte.filename || 'nota.xml').replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_').slice(0, 200), tipo: 'Nota fiscal', buf });
    const outra = n.direcao === 'emitida' ? n.destinatario : n.emitente;
    const r = await inserir(ctx, e.id, { documentoId: docId, tipo: n.tipo, chave: n.chave, numero: n.numero, serie: n.serie, dataEmissao: n.dataEmissao,
      direcao: n.direcao, contraparteDoc: outra.doc, contraparteNome: outra.nome, valor: n.valor, impostos: Object.fromEntries(Object.entries(n.impostos).filter(([, v]) => v != null)) as Record<string, number> });
    return reply.code(201).send(r);
  });

  app.delete('/api/notas/:id', { preHandler: guard }, async (req, reply) => {
    const { rows } = await ctx.db.query('select n.* from notas_fiscais n join empresas e on e.id = n.empresa_id where n.id = $1 and e.user_id = $2', [(req.params as { id: string }).id, req.userId]);
    if (!rows.length) return reply.code(404).send({ erro: 'Nota não encontrada.' });
    await ctx.db.query('delete from notas_fiscais where id = $1', [rows[0].id]);
    await auditar(ctx, req.userId, rows[0].empresa_id, 'nota.excluir', { id: rows[0].id });
    return reply.code(204).send();
  });
}
