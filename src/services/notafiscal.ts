import { onlyDigits } from '../cnpj.js';
import { isISODate } from '../util.js';

/**
 * Leitura de nota fiscal: NF-e (modelo 55), NFC-e (65) e NFS-e.
 * O XML é o arquivo oficial e é lido com precisão. O PDF (DANFE/DANFSe) é lido pelo texto e pela
 * chave de acesso, que traz CNPJ do emitente, modelo, série e número (com dígito verificador).
 */
export type TipoNota = 'NF-e' | 'NFC-e' | 'NFS-e' | 'Nota fiscal';
export interface Parte { doc: string | null; nome: string | null }
export interface NotaLida {
  tipo: TipoNota;
  numero: string | null;
  serie: string | null;
  chave: string | null;
  dataEmissao: string | null;
  emitente: Parte;
  destinatario: Parte;
  valor: number | null;
  impostos: { icms?: number; ipi?: number; pis?: number; cofins?: number; iss?: number };
  natureza: string | null;
  direcao: 'emitida' | 'recebida' | 'outra';
  origem: 'xml' | 'pdf';
  /** Data prevista de pagamento (vencimento da cobrança/duplicata), AAAA-MM-DD, quando a nota traz. */
  receberEm: string | null;
  confianca: 'alta' | 'media' | 'baixa';
  avisos: string[];
}

/** Dígito verificador da chave de acesso (módulo 11, pesos 2 a 9). */
export function chaveValida(chave: string): boolean {
  const c = onlyDigits(chave);
  if (c.length !== 44) return false;
  let soma = 0, peso = 2;
  for (let i = 42; i >= 0; i--) { soma += Number(c[i]) * peso; peso = peso === 9 ? 2 : peso + 1; }
  const r = soma % 11;
  const dv = r < 2 ? 0 : 11 - r;
  return dv === Number(c[43]);
}

/** Partes da chave: UF(2) AAMM(4) CNPJ(14) modelo(2) série(3) número(9) tipo(1) código(8) DV(1). */
export function infoChave(chave: string) {
  const c = onlyDigits(chave);
  return { aamm: c.slice(2, 6), cnpj: c.slice(6, 20), modelo: c.slice(20, 22), serie: String(Number(c.slice(22, 25))), numero: String(Number(c.slice(25, 34))) };
}

const num = (v: string | null | undefined) => {
  if (v == null || v === '') return undefined;
  const t = v.trim();
  const n = /,\d{1,2}$/.test(t) ? Number(t.replace(/\./g, '').replace(',', '.')) : Number(t);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : undefined;
};
const dataDe = (v: string | null | undefined) => {
  if (!v) return null;
  const iso = v.match(/(\d{4}-\d{2}-\d{2})/);
  if (iso && isISODate(iso[1])) return iso[1];
  const br = v.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  return br && isISODate(`${br[3]}-${br[2]}-${br[1]}`) ? `${br[3]}-${br[2]}-${br[1]}` : null;
};
const desc = (s: string | null) => (s ? s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').trim() : s);

/** Conteúdo do primeiro elemento com um destes nomes (ignora prefixo de namespace e maiúsculas). */
function tag(xml: string, ...nomes: string[]): string | null {
  for (const n of nomes) {
    const m = xml.match(new RegExp(`<(?:\\w+:)?${n}(?:\\s[^>]*)?>([^<]*)</(?:\\w+:)?${n}>`, 'i'));
    if (m) return desc(m[1]);
  }
  return null;
}
function bloco(xml: string, ...nomes: string[]): string | null {
  for (const n of nomes) {
    const m = xml.match(new RegExp(`<(?:\\w+:)?${n}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${n}>`, 'i'));
    if (m) return m[1];
  }
  return null;
}
const parte = (b: string | null): Parte => (b ? { doc: tag(b, 'CNPJ', 'Cnpj', 'CPF', 'Cpf') ? onlyDigits(tag(b, 'CNPJ', 'Cnpj', 'CPF', 'Cpf')) : null, nome: tag(b, 'xNome', 'RazaoSocial', 'NomeFantasia', 'xFant') } : { doc: null, nome: null });

function direcaoDe(n: Pick<NotaLida, 'emitente' | 'destinatario'>, cnpjEmpresa?: string | null): NotaLida['direcao'] {
  const e = onlyDigits(cnpjEmpresa ?? '');
  if (!e) return 'outra';
  if (n.emitente.doc === e) return 'emitida';
  if (n.destinatario.doc === e) return 'recebida';
  return 'outra';
}

function finalizar(n: Omit<NotaLida, 'direcao' | 'confianca' | 'avisos'>, cnpjEmpresa?: string | null): NotaLida {
  const avisos: string[] = [];
  const direcao = direcaoDe(n, cnpjEmpresa);
  if (direcao === 'outra' && cnpjEmpresa) avisos.push('Esta nota não tem o CNPJ desta empresa nem como emitente nem como destinatário.');
  if (n.chave && !chaveValida(n.chave)) avisos.push('A chave de acesso não confere (dígito verificador). Confira o arquivo.');
  if (!n.valor) avisos.push('Não encontrei o valor total. Informe manualmente.');
  if (!n.dataEmissao) avisos.push('Não encontrei a data de emissão. Informe manualmente.');
  const confianca = n.valor && n.dataEmissao && (n.numero || n.chave) ? (n.origem === 'xml' ? 'alta' : 'media') : 'baixa';
  return { ...n, direcao, confianca, avisos };
}

export function pareceXmlDeNota(xml: string): boolean {
  return /<(?:\w+:)?(infNFe|infNFSe|NFSe|CompNfse|Nfse|infDPS)\b/i.test(xml);
}

export function lerNotaXml(xml: string, cnpjEmpresa?: string | null): NotaLida {
  if (/<(?:\w+:)?infNFe\b/i.test(xml)) {
    const id = (xml.match(/<(?:\w+:)?infNFe[^>]*\bId="(?:NFe)?(\d{44})"/i) ?? [])[1] ?? tag(xml, 'chNFe');
    const ide = bloco(xml, 'ide') ?? '';
    const tot = bloco(xml, 'ICMSTot') ?? '';
    const mod = tag(ide, 'mod');
    return finalizar({
      tipo: mod === '65' ? 'NFC-e' : 'NF-e', numero: tag(ide, 'nNF'), serie: tag(ide, 'serie'), chave: id ? onlyDigits(id) : null,
      dataEmissao: dataDe(tag(ide, 'dhEmi', 'dEmi')), emitente: parte(bloco(xml, 'emit')), destinatario: parte(bloco(xml, 'dest')),
      valor: num(tag(tot, 'vNF')) ?? null,
      impostos: { icms: num(tag(tot, 'vICMS')), ipi: num(tag(tot, 'vIPI')), pis: num(tag(tot, 'vPIS')), cofins: num(tag(tot, 'vCOFINS')) },
      natureza: tag(ide, 'natOp'), origem: 'xml', receberEm: dataDe(tag(bloco(xml, 'cobr') ?? '', 'dVenc')),
    }, cnpjEmpresa);
  }
  // NFS-e: padrão nacional (emit/toma) e padrão ABRASF das prefeituras (Prestador/Tomador).
  const emit = bloco(xml, 'emit', 'PrestadorServico', 'Prestador', 'IdentificacaoPrestador', 'prest');
  const toma = bloco(xml, 'toma', 'TomadorServico', 'Tomador', 'IdentificacaoTomador');
  const chave = (xml.match(/<(?:\w+:)?infNFSe[^>]*\bId="NFS(\d{50})"/i) ?? [])[1] ?? null;
  return finalizar({
    tipo: 'NFS-e', numero: tag(xml, 'nNFSe', 'Numero'), serie: null, chave,
    dataEmissao: dataDe(tag(xml, 'dhEmi', 'dhProc', 'DataEmissao', 'DataEmissaoNfse', 'Competencia')),
    emitente: parte(emit), destinatario: parte(toma),
    valor: num(tag(xml, 'vLiq', 'ValorLiquidoNfse', 'vServ', 'ValorServicos')) ?? null,
    impostos: { iss: num(tag(xml, 'vISSQN', 'ValorIss')), pis: num(tag(xml, 'vPIS', 'ValorPis')), cofins: num(tag(xml, 'vCOFINS', 'ValorCofins')) },
    natureza: tag(xml, 'xDescServ', 'Discriminacao'), origem: 'xml', receberEm: dataDe(tag(xml, 'dVenc', 'DataVencimento')),
  }, cnpjEmpresa);
}

export function pareceTextoDeNota(t: string): boolean {
  return /DANFE|DOCUMENTO AUXILIAR DA NOTA FISCAL|NFS-?e|NOTA FISCAL (DE SERVI|ELETR)/i.test(t.slice(0, 3000));
}

const MONEY = '(\\d{1,3}(?:\\.\\d{3})*,\\d{2})';
const depois = (t: string, rot: RegExp, val: string, janela = 120) => {
  const m = t.match(new RegExp(`(?:${rot.source})[^\\d]{0,${janela}}?${val}`, 'i'));
  return m ? m[m.length - 1] : null;
};

export function lerNotaTexto(texto: string, cnpjEmpresa?: string | null): NotaLida {
  const t = texto.replace(/ /g, ' ').replace(/[ \t]+/g, ' ');
  const servico = /NFS-?e|NOTA FISCAL DE SERVI/i.test(t.slice(0, 3000)) && !/DANFE/i.test(t.slice(0, 3000));
  // Chave de acesso: 44 dígitos, às vezes em blocos de 4.
  let chave: string | null = null;
  for (const m of t.matchAll(/(?:\d[\s.]?){44}/g)) { const c = onlyDigits(m[0]).slice(0, 44); if (c.length === 44 && chaveValida(c)) { chave = c; break; } }
  const cnpjs = [...t.matchAll(/\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/g)].map((m) => onlyDigits(m[0]));
  const ic = chave ? infoChave(chave) : null;
  const emitDoc = ic?.cnpj ?? (servico ? onlyDigits(depois(t, /prestador|emitente/, '(\\d{2}\\.\\d{3}\\.\\d{3}\\/\\d{4}-\\d{2})', 300) ?? '') || null : cnpjs[0] ?? null);
  const destDoc = servico ? onlyDigits(depois(t, /tomador/, '(\\d{2}\\.\\d{3}\\.\\d{3}\\/\\d{4}-\\d{2}|\\d{3}\\.\\d{3}\\.\\d{3}-\\d{2})', 300) ?? '') || null : cnpjs.find((c) => c !== emitDoc) ?? null;
  const valorTxt = servico
    ? depois(t, /valor l[íi]quido(?: da nfs-?e)?|valor do servi[çc]o|valor total/, MONEY)
    : depois(t, /valor total da nota|v\.? total da nota|valor total/, MONEY);
  const data = depois(t, /data (?:e hora )?(?:da |de )?emiss[ãa]o|emitida em|data de emiss[ãa]o/, '(\\d{2}\\/\\d{2}\\/\\d{4})', 80);
  const numero = ic?.numero ?? depois(t, /n[úu]mero(?: da nfs-?e)?|n[ºo°]\.?/, '(\\d{1,9})', 20);
  return finalizar({
    tipo: servico ? 'NFS-e' : ic?.modelo === '65' ? 'NFC-e' : ic || /DANFE/i.test(t) ? 'NF-e' : 'Nota fiscal',
    numero, serie: ic?.serie ?? null, chave,
    dataEmissao: dataDe(data), emitente: { doc: emitDoc, nome: null }, destinatario: { doc: destDoc, nome: null },
    valor: valorTxt ? num(valorTxt) ?? null : null,
    impostos: servico ? { iss: num(depois(t, /valor (?:do )?iss(?:qn)?/, MONEY) ?? undefined) } : { icms: num(depois(t, /valor do icms(?! st| substitui)/, MONEY) ?? undefined), ipi: num(depois(t, /valor (?:total )?do ipi/, MONEY) ?? undefined) },
    natureza: null, origem: 'pdf', receberEm: dataDe(depois(t, /vencimento|data de pagamento|pagar at[ée]|pag[áa]vel at[ée]/, '(\\d{2}\\/\\d{2}\\/\\d{4})', 80)),
  }, cnpjEmpresa);
}

/* ---------- Limite do MEI ---------- */
export const LIMITE_MEI_ANO = 81000;

/** Limite do ano: no ano de abertura é proporcional (R$ 6.750 por mês, contando o mês de início). */
export function limiteMei(ano: number, inicioMei?: string | null): { limite: number; meses: number } {
  if (!inicioMei || Number(inicioMei.slice(0, 4)) < ano) return { limite: LIMITE_MEI_ANO, meses: 12 };
  if (Number(inicioMei.slice(0, 4)) > ano) return { limite: 0, meses: 0 };
  const meses = 12 - Number(inicioMei.slice(5, 7)) + 1;
  return { limite: Math.round((LIMITE_MEI_ANO / 12) * meses * 100) / 100, meses };
}
