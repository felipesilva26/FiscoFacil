import { Readable } from 'node:stream';
import yauzl from 'yauzl';
import unzipper from 'unzipper';
import { onlyDigits } from '../cnpj.js';
import type { Ctx } from '../ctx.js';
import { newId } from '../util.js';

/**
 * Dívida ativa da União e do FGTS a partir dos DADOS ABERTOS da PGFN (fonte oficial, pública, trimestral):
 *   https://dadosabertos.pgfn.gov.br/{ANO}_trimestre_{QQ}/Dados_abertos_*.zip
 * Os arquivos são grandes (todos os devedores do país). O importador baixa, lê em fluxo (sem carregar tudo
 * na memória) e guarda SÓ as linhas dos CNPJs cadastrados no FiscoFácil.
 * As colunas são encontradas pelo nome no cabeçalho, para tolerar pequenas mudanças de layout.
 */
export const ORIGENS = [
  { origem: 'Não previdenciária', arquivos: ['Dados_abertos_Nao_Previdenciario.zip', 'Dados_abertos_Sistema_SIDA.zip'] },
  { origem: 'Previdenciária', arquivos: ['Dados_abertos_Previdenciario.zip'] },
  { origem: 'FGTS', arquivos: ['Dados_abertos_FGTS.zip'] },
] as const;

export interface Inscricao {
  cnpj: string;
  numeroInscricao: string;
  tipoDevedor: string | null;
  situacao: string | null;
  tipoSituacao: string | null;
  receita: string | null;
  dataInscricao: string | null;
  ajuizado: boolean | null;
  valorCentavos: number;
}

const norm = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '');

/** Acha cada campo pelo nome da coluna. */
export function mapearColunas(cabecalho: string[]): Record<keyof Omit<Inscricao, 'cnpj'> | 'cnpj', number> {
  const h = cabecalho.map(norm);
  const achar = (...res: RegExp[]) => { for (const re of res) { const i = h.findIndex((c) => re.test(c)); if (i >= 0) return i; } return -1; };
  const m = {
    cnpj: achar(/^CPF_CNPJ$/, /CNPJ/),
    numeroInscricao: achar(/NUMERO_INSCRICAO/, /INSCRICAO$/),
    tipoDevedor: achar(/TIPO_DEVEDOR/),
    situacao: achar(/^SITUACAO_INSCRICAO$/),
    tipoSituacao: achar(/TIPO_SITUACAO/),
    receita: achar(/RECEITA_PRINCIPAL/, /RECEITA/),
    dataInscricao: achar(/DATA_INSCRICAO/),
    ajuizado: achar(/AJUIZADO/),
    valorCentavos: achar(/VALOR_CONSOLIDADO/, /^VALOR/),
  };
  if (m.cnpj < 0 || m.numeroInscricao < 0 || m.valorCentavos < 0) {
    throw new Error(`Layout da PGFN não reconhecido. Colunas encontradas: ${cabecalho.join(', ')}`);
  }
  return m;
}

/** Divide uma linha CSV respeitando aspas. */
export function dividir(linha: string, sep: string): string[] {
  const out: string[] = [];
  let cur = '', q = false;
  for (let i = 0; i < linha.length; i++) {
    const c = linha[i];
    if (q) {
      if (c === '"' && linha[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c;
    } else if (c === '"') q = true;
    else if (c === sep) { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out.map((v) => v.trim());
}

export function valorEmCentavos(v: string): number {
  const t = v.replace(/[^\d,.-]/g, '');
  if (!t) return 0;
  const n = /,\d{1,2}$/.test(t) ? Number(t.replace(/\./g, '').replace(',', '.')) : Number(t.replace(/,/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

export function dataISO(v: string): string | null {
  const br = v.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (br) return `${br[3]}-${br[2]}-${br[1]}`;
  const iso = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return iso ? iso[0] : null;
}

/** Lê um CSV (em fluxo) e devolve só as linhas dos CNPJs procurados. */
export async function filtrarCsv(stream: Readable, procurados: Set<string>): Promise<{ linhas: number; achados: Inscricao[] }> {
  let dec: TextDecoder | null = null;
  let resto = '', cab: ReturnType<typeof mapearColunas> | null = null, sep = ';', linhas = 0;
  const achados: Inscricao[] = [];
  const processar = (l: string) => {
    if (!l.trim()) return;
    if (!cab) {
      const limpa = l.replace(/^\uFEFF/, '');
      sep = (limpa.match(/;/g)?.length ?? 0) >= (limpa.match(/,/g)?.length ?? 0) ? ';' : ',';
      cab = mapearColunas(dividir(limpa, sep));
      return;
    }
    linhas++;
    if (linhas % 2_000_000 === 0) console.log(`PGFN: ${linhas.toLocaleString('pt-BR')} linhas lidas`);
    // Caminho rápido: quase nenhuma linha interessa, então só olha a coluna do CNPJ.
    if (cab.cnpj === 0 && l.charCodeAt(0) !== 34) {
      const fim = l.indexOf(sep);
      if (!procurados.has(onlyDigits(fim < 0 ? l : l.slice(0, fim)))) return;
    }
    const c = dividir(l, sep);
    const cnpj = onlyDigits(c[cab.cnpj]);
    if (!procurados.has(cnpj)) return;
    const g = (i: number) => (i >= 0 && c[i] ? c[i] : null);
    const aj = g(cab.ajuizado);
    achados.push({
      cnpj,
      numeroInscricao: c[cab.numeroInscricao],
      tipoDevedor: g(cab.tipoDevedor),
      situacao: g(cab.situacao),
      tipoSituacao: g(cab.tipoSituacao),
      receita: g(cab.receita),
      dataInscricao: g(cab.dataInscricao) ? dataISO(g(cab.dataInscricao)!) : null,
      ajuizado: aj == null ? null : /^(SIM|S|TRUE|1)$/i.test(aj),
      valorCentavos: valorEmCentavos(c[cab.valorCentavos] ?? ''),
    });
  };
  for await (const chunk of stream) {
    const buf = chunk as Buffer;
    if (!dec) {
      // UTF-8 se for válido; senão Windows-1252 (padrão comum em arquivos do governo).
      try { new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(0, Math.min(buf.length, 65536))); dec = new TextDecoder('utf-8'); } catch { dec = new TextDecoder('windows-1252'); }
    }
    resto += dec.decode(buf, { stream: true });
    const partes = resto.split(/\r?\n/);
    resto = partes.pop() ?? '';
    for (const p of partes) processar(p);
  }
  if (dec) resto += dec.decode();
  processar(resto);
  return { linhas, achados };
}

const abrirZip = (arquivo: string) => new Promise<yauzl.ZipFile>((ok, erro) => yauzl.open(arquivo, { lazyEntries: true }, (e, z) => (e ? erro(e) : ok(z!))));

/** Percorre todos os .csv do zip. */
export async function filtrarZip(arquivo: string, procurados: Set<string>) {
  const zip = await abrirZip(arquivo);
  let linhas = 0;
  const achados: Inscricao[] = [];
  await new Promise<void>((ok, erro) => {
    zip.on('error', erro);
    zip.on('end', () => ok());
    zip.on('entry', (entry: yauzl.Entry) => {
      if (!/\.(csv|txt)$/i.test(entry.fileName)) { zip.readEntry(); return; }
      zip.openReadStream(entry, (e, s) => {
        if (e || !s) { erro(e); return; }
        filtrarCsv(s, procurados).then((r) => { linhas += r.linhas; achados.push(...r.achados); zip.readEntry(); }, erro);
      });
    });
    zip.readEntry();
  });
  zip.close();
  return { linhas, achados };
}

/** Lê o zip direto do download, sem gravar em disco (os arquivos da PGFN são grandes). */
export async function filtrarZipStream(src: Readable, procurados: Set<string>) {
  let linhas = 0;
  const achados: Inscricao[] = [];
  const parser = src.pipe(unzipper.Parse({ forceStream: true }));
  for await (const item of parser) {
    const entry = item as unzipper.Entry;
    if (/\.(csv|txt)$/i.test(entry.path)) {
      const r = await filtrarCsv(entry, procurados);
      linhas += r.linhas; achados.push(...r.achados);
    } else entry.autodrain();
  }
  return { linhas, achados };
}

/** Trimestres do mais recente para o mais antigo, a partir de hoje. */
export function trimestresCandidatos(agora: Date, quantos = 6): string[] {
  let y = agora.getUTCFullYear(), q = Math.floor(agora.getUTCMonth() / 3) + 1;
  const out: string[] = [];
  for (let i = 0; i < quantos; i++) { out.push(`${y}_trimestre_${String(q).padStart(2, '0')}`); q--; if (q === 0) { q = 4; y--; } }
  return out;
}

async function existe(ctx: Ctx, url: string): Promise<boolean> {
  try {
    const r = await ctx.fetchImpl(url, { method: 'HEAD', signal: AbortSignal.timeout(20_000) });
    if (r.ok) return true;
    if (r.status === 404) return false;
  } catch { /* alguns servidores não aceitam HEAD */ }
  // Plano B: pede só o primeiro byte.
  try {
    const r = await ctx.fetchImpl(url, { headers: { range: 'bytes=0-0' }, signal: AbortSignal.timeout(20_000) });
    await r.body?.cancel().catch(() => undefined);
    return r.ok || r.status === 206;
  } catch { return false; }
}

/** Descobre o trimestre mais recente publicado e a URL de cada arquivo. */
export async function descobrirPublicacao(ctx: Ctx): Promise<{ trimestre: string; urls: { origem: string; url: string }[] } | null> {
  for (const t of trimestresCandidatos(ctx.now())) {
    const urls: { origem: string; url: string }[] = [];
    for (const o of ORIGENS) {
      for (const a of o.arquivos) {
        const url = `${ctx.cfg.pgfnBaseUrl}/${t}/${a}`;
        if (await existe(ctx, url)) { urls.push({ origem: o.origem, url }); break; }
      }
    }
    if (urls.length) return { trimestre: t, urls };
  }
  return null;
}

export async function cnpjsCadastrados(ctx: Ctx): Promise<Set<string>> {
  const { rows } = await ctx.db.query('select distinct cnpj from empresas where cnpj is not null');
  return new Set(rows.map((r) => onlyDigits(r.cnpj)).filter((c) => c.length === 14));
}

export interface ResultadoImportacao { trimestre: string | null; origens: { origem: string; linhas: number; encontrados: number }[]; novas: number; motivo?: string }

/**
 * Importa o trimestre mais recente. Só baixa de novo se houver trimestre novo ou CNPJ ainda não conferido.
 * `forcar` ignora essa checagem.
 */
export async function importarPgfn(ctx: Ctx, opts: { forcar?: boolean } = {}): Promise<ResultadoImportacao> {
  const procurados = await cnpjsCadastrados(ctx);
  if (!procurados.size) return { trimestre: null, origens: [], novas: 0, motivo: 'Nenhum CNPJ cadastrado.' };
  const pub = await descobrirPublicacao(ctx);
  if (!pub) return { trimestre: null, origens: [], novas: 0, motivo: 'Não encontrei arquivos publicados pela PGFN.' };

  const res: ResultadoImportacao = { trimestre: pub.trimestre, origens: [], novas: 0 };
  console.log(`PGFN: publicação ${pub.trimestre}: ${pub.urls.map((u) => u.origem).join(', ')}`);
  for (const { origem, url } of pub.urls) {
    const { rows } = await ctx.db.query('select cnpj from pgfn_verificados where trimestre = $1 and origem = $2', [pub.trimestre, origem]);
    const feitos = new Set(rows.map((r) => r.cnpj as string));
    const faltam = [...procurados].filter((c) => !feitos.has(c));
    if (!opts.forcar && !faltam.length) continue;

    {
      console.log(`PGFN: baixando ${url} para conferir ${procurados.size} CNPJ(s)`);
      const r = await ctx.fetchImpl(url, { signal: AbortSignal.timeout(4 * 60 * 60 * 1000) });
      if (!r.ok || !r.body) throw new Error(`Download falhou (HTTP ${r.status}): ${url}`);
      let lido: { linhas: number; achados: Inscricao[] };
      try {
        lido = await filtrarZipStream(Readable.fromWeb(r.body as never), procurados);
      } catch (e) {
        // Alguns zips só podem ser lidos com acesso aleatório: baixa para o disco e lê de novo.
        console.warn(`PGFN: leitura em fluxo falhou (${(e as Error).message}); tentando pelo disco.`);
        lido = await viaDisco(ctx, url, procurados);
      }
      const { linhas, achados } = lido;

      // Inscrições que ainda não existiam viram aviso.
      const antes = await ctx.db.query('select cnpj, numero_inscricao from divida_ativa where origem = $1', [origem]);
      const conhecidas = new Set(antes.rows.map((x) => `${x.cnpj}|${x.numero_inscricao}`));
      const novas = achados.filter((a) => !conhecidas.has(`${a.cnpj}|${a.numeroInscricao}`));

      // Substitui o retrato dos CNPJs conferidos por este arquivo.
      for (const c of procurados) await ctx.db.query('delete from divida_ativa where origem = $1 and cnpj = $2', [origem, c]);
      for (const a of achados) {
        await ctx.db.query(
          `insert into divida_ativa (cnpj, origem, numero_inscricao, tipo_devedor, situacao, tipo_situacao, receita, data_inscricao, ajuizado, valor_centavos, trimestre)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) on conflict (cnpj, origem, numero_inscricao) do update set valor_centavos = excluded.valor_centavos, situacao = excluded.situacao, trimestre = excluded.trimestre`,
          [a.cnpj, origem, a.numeroInscricao, a.tipoDevedor, a.situacao, a.tipoSituacao, a.receita, a.dataInscricao, a.ajuizado, a.valorCentavos, pub.trimestre]);
      }
      for (const c of procurados) {
        await ctx.db.query('insert into pgfn_verificados (cnpj, trimestre, origem) values ($1,$2,$3) on conflict do nothing', [c, pub.trimestre, origem]);
      }
      await ctx.db.query(
        `insert into pgfn_importacoes (trimestre, origem, arquivo, linhas, encontrados, cnpjs_verificados) values ($1,$2,$3,$4,$5,$6)
         on conflict (trimestre, origem) do update set linhas = $4, encontrados = $5, cnpjs_verificados = $6, concluido_em = now()`,
        [pub.trimestre, origem, url, linhas, achados.length, procurados.size]);
      await avisarNovas(ctx, novas, origem);
      res.novas += novas.length;
      res.origens.push({ origem, linhas, encontrados: achados.length });
    }
  }
  return res;
}

async function viaDisco(ctx: Ctx, url: string, procurados: Set<string>) {
  const { createWriteStream } = await import('node:fs');
  const { mkdir, rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { pipeline } = await import('node:stream/promises');
  await mkdir(ctx.cfg.pgfnTmpDir, { recursive: true });
  const tmp = join(ctx.cfg.pgfnTmpDir, `${newId()}.zip`);
  try {
    const r = await ctx.fetchImpl(url, { signal: AbortSignal.timeout(2 * 60 * 60 * 1000) });
    if (!r.ok || !r.body) throw new Error(`Download falhou (HTTP ${r.status}): ${url}`);
    await pipeline(Readable.fromWeb(r.body as never), createWriteStream(tmp));
    return await filtrarZip(tmp, procurados);
  } finally { await rm(tmp, { force: true }); }
}

/* ---------- execução em segundo plano ---------- */
export const estadoPgfn: { rodando: boolean; iniciadoEm: string | null; ultimoErro: string | null; concluidoEm: string | null; deNovo: boolean } =
  { rodando: false, iniciadoEm: null, ultimoErro: null, concluidoEm: null, deNovo: false };
let agendado: NodeJS.Timeout | null = null;

/** Agenda uma conferência (ex.: logo depois de cadastrar um CNPJ). Só baixa se houver CNPJ ainda não conferido. */
export function agendarPgfn(ctx: Ctx, atrasoMs = 15_000) {
  if (ctx.cfg.env === 'test' || process.env.PGFN_DESLIGADO === '1') return;
  if (estadoPgfn.rodando) { estadoPgfn.deNovo = true; return; }
  if (agendado) return;
  agendado = setTimeout(() => { agendado = null; void rodarPgfn(ctx); }, atrasoMs);
  agendado.unref?.();
}

export async function rodarPgfn(ctx: Ctx) {
  if (estadoPgfn.rodando) { estadoPgfn.deNovo = true; return; }
  estadoPgfn.rodando = true; estadoPgfn.iniciadoEm = new Date().toISOString();
  // No plano grátis o servidor dorme sem visitas: enquanto confere, ele mesmo se visita para não ser desligado no meio.
  const url = process.env.RENDER_EXTERNAL_URL;
  const acordado = url ? setInterval(() => { fetch(`${url}/api/health`).catch(() => undefined); }, 4 * 60 * 1000) : null;
  try {
    const r = await importarPgfn(ctx);
    estadoPgfn.ultimoErro = null; estadoPgfn.concluidoEm = new Date().toISOString();
    console.log(JSON.stringify({ pgfn: r }));
  } catch (e) {
    estadoPgfn.ultimoErro = (e as Error).message;
    console.error('PGFN: falhou', (e as Error).message);
    setTimeout(() => agendarPgfn(ctx, 0), 30 * 60 * 1000).unref?.();
  } finally {
    if (acordado) clearInterval(acordado);
    estadoPgfn.rodando = false;
    if (estadoPgfn.deNovo) { estadoPgfn.deNovo = false; agendarPgfn(ctx, 1000); }
  }
}

async function avisarNovas(ctx: Ctx, novas: Inscricao[], origem: string) {
  for (const n of novas) {
    const { rows } = await ctx.db.query(
      'select e.id, e.nome, u.id as user_id, u.email from empresas e join users u on u.id = e.user_id where regexp_replace(e.cnpj, \'\\D\', \'\', \'g\') = $1', [n.cnpj]);
    for (const r of rows) {
      const texto = `${r.nome}: inscrição em dívida ativa (${origem}) nº ${n.numeroInscricao}, valor R$ ${(n.valorCentavos / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}.`;
      await ctx.db.query('insert into alertas (id, user_id, empresa_id, nivel, texto, fonte) values ($1,$2,$3,$4,$5,$6)',
        [newId(), r.user_id, r.id, 'alerta', texto, 'PGFN - dados abertos da dívida ativa']);
      await ctx.notifier.send({ to: r.email, subject: 'FiscoFácil: nova inscrição em dívida ativa', text: `${texto}\n\nFonte: dados abertos da PGFN. Confira em regularize.pgfn.gov.br e fale com o seu contador.` }).catch(() => undefined);
    }
  }
}

/** Resumo da dívida ativa de um CNPJ para a tela. */
export async function dividaDoCnpj(ctx: Ctx, cnpj: string) {
  const d = onlyDigits(cnpj);
  const { rows } = await ctx.db.query('select * from divida_ativa where cnpj = $1 order by valor_centavos desc', [d]);
  const ver = await ctx.db.query('select trimestre, origem from pgfn_verificados where cnpj = $1 order by trimestre desc', [d]);
  const trimestre = (ver.rows[0]?.trimestre as string | undefined) ?? null;
  const origensConferidas = ver.rows.filter((r) => r.trimestre === trimestre).map((r) => r.origem as string);
  const inscricoes = rows.map((r) => ({
    origem: r.origem, numero: r.numero_inscricao, tipoDevedor: r.tipo_devedor, situacao: r.situacao, tipoSituacao: r.tipo_situacao,
    receita: r.receita, dataInscricao: r.data_inscricao, ajuizado: r.ajuizado, valor: Number(r.valor_centavos) / 100,
  }));
  return {
    verificado: trimestre !== null,
    trimestre: trimestre ? `${Number(trimestre.slice(-2))}º trimestre de ${trimestre.slice(0, 4)}` : null,
    origensConferidas,
    inscricoes,
    total: Math.round(inscricoes.reduce((s, i) => s + i.valor, 0) * 100) / 100,
    fonte: 'Procuradoria-Geral da Fazenda Nacional (PGFN) - dados abertos da dívida ativa da União e do FGTS',
  };
}
