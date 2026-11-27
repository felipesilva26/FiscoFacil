import { isISODate } from '../util.js';
import { onlyDigits } from '../cnpj.js';

/**
 * Leitura de documentos fiscais em PDF (com texto). É heurística: procura rótulos conhecidos
 * (vencimento, valor, validade...) no texto. Foi ajustada com PDFs de teste; layouts reais podem
 * variar, por isso o resultado é sempre uma SUGESTÃO que a pessoa confere antes de salvar.
 */
export type TipoDoc = 'guia' | 'comprovante' | 'certidao' | 'desconhecido';
export type Tributo = 'DAS' | 'DARF' | 'FGTS' | 'INSS' | 'ISS' | 'ICMS';

export interface Leitura {
  tipo: TipoDoc;
  tributo: Tributo | null;
  vencimento: string | null; // AAAA-MM-DD
  valor: number | null;
  competencia: string | null;
  linhaDigitavel: string | null;
  cnpjDocumento: string | null;
  dataPagamento: string | null;
  validade: string | null;
  situacaoCertidao: 'negativa' | 'positiva_com_efeitos_de_negativa' | 'positiva' | null;
  confianca: 'alta' | 'media' | 'baixa';
  avisos: string[];
}

const MONEY = '(\\d{1,3}(?:\\.\\d{3})*,\\d{2})';
const DATE = '(\\d{2}\\/\\d{2}\\/\\d{4})';

const toISO = (br: string): string | null => {
  const [d, m, y] = br.split('/');
  const iso = `${y}-${m}-${d}`;
  return isISODate(iso) ? iso : null;
};
const toNum = (br: string) => Number(br.replace(/\./g, '').replace(',', '.'));

/** Primeiro valor que aparece logo depois de um dos rótulos (até `janela` caracteres). */
function depois(texto: string, rotulos: RegExp, valor: string, janela = 90): string | null {
  const re = new RegExp(`(?:${rotulos.source})[^\\d]{0,${janela}}?${valor}`, 'i');
  const m = texto.match(re);
  return m ? m[m.length - 1] : null;
}

function detectarTributo(t: string): Tributo | null {
  const cabeca = t.slice(0, 1500);
  const ordem: [Tributo, RegExp][] = [
    ['DAS', /simples nacional|pgdas|\bDAS\b|\bDAS-MEI\b/i],
    ['DARF', /\bDARF\b|receitas federais/i],
    ['FGTS', /\bFGTS\b|fundo de garantia/i],
    ['INSS', /\bGPS\b|guia da previd[êe]ncia|\bINSS\b/i],
    ['ISS', /\bISS(QN)?\b|imposto sobre servi[çc]os/i],
    ['ICMS', /\bICMS\b|\bGNRE\b/i],
  ];
  for (const base of [cabeca, t]) for (const [nome, re] of ordem) if (re.test(base)) return nome;
  return null;
}

function linhaDigitavel(t: string): string | null {
  // Convênio/arrecadação: 4 blocos de 11 dígitos + dígito verificador.
  const conv = t.match(/(?:\d{11}\s?-?\s?\d\s+){3}\d{11}\s?-?\s?\d/);
  if (conv) return conv[0].replace(/\s+/g, ' ').trim();
  // Boleto bancário: 47 dígitos.
  const bol = t.match(/\d{5}\.\d{5}\s\d{5}\.\d{6}\s\d{5}\.\d{6}\s\d\s\d{14}/);
  return bol ? bol[0] : null;
}

export function lerDocumento(textoBruto: string, cnpjEmpresa?: string | null): Leitura {
  const t = textoBruto.replace(/ /g, ' ').replace(/[ \t]+/g, ' ');
  const avisos: string[] = [];

  const certidao = /certid[ãa]o/i.test(t.slice(0, 800)) && /(negativa|positiva)/i.test(t);
  const comprovante = !certidao && /comprovante (de )?(pagamento|arrecada)|autentica[çc][ãa]o banc[áa]ria|pagamento efetuado/i.test(t);
  const tributo = detectarTributo(t);
  const linha = linhaDigitavel(t);
  const venc = depois(t, /data de vencimento|vencimento|pagar at[ée]|pag[áa]vel at[ée]/, DATE);
  const valorTxt =
    depois(t, /valor total do documento|valor total a recolher|valor total|valor do documento|valor a pagar|total a recolher|valor principal/, MONEY) ??
    depois(t, /valor/, MONEY);
  const competencia = (t.match(/(?:per[ií]odo de apura[çc][ãa]o|compet[êe]ncia|per[ií]odo de apura[çc][ãa]o)\D{0,25}(\d{2}\/\d{4})/i) ?? [])[1] ?? null;
  const cnpjDoc = (t.match(/\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/) ?? [])[0] ?? null;

  const r: Leitura = {
    tipo: 'desconhecido', tributo, vencimento: venc ? toISO(venc) : null, valor: valorTxt ? toNum(valorTxt) : null,
    competencia, linhaDigitavel: linha, cnpjDocumento: cnpjDoc, dataPagamento: null, validade: null, situacaoCertidao: null,
    confianca: 'baixa', avisos,
  };

  if (certidao) {
    r.tipo = 'certidao';
    const val = depois(t, /v[áa]lid[ao]\s+at[ée]|validade|v[áa]lida por|data de validade/, DATE, 120);
    r.validade = val ? toISO(val) : null;
    r.situacaoCertidao = /positiva com efeitos de negativa/i.test(t) ? 'positiva_com_efeitos_de_negativa' : /positiva/i.test(t) && !/negativa/i.test(t.replace(/positiva com efeitos de negativa/gi, '')) ? 'positiva' : 'negativa';
    if (r.situacaoCertidao === 'positiva') avisos.push('Certidão POSITIVA: indica débitos. Fale com o contador.');
    r.vencimento = null; r.valor = null; r.linhaDigitavel = null; r.tributo = null;
    r.confianca = r.validade ? 'alta' : 'baixa';
    if (!r.validade) avisos.push('Não encontrei a data de validade. Informe manualmente.');
  } else if (comprovante) {
    r.tipo = 'comprovante';
    const dp = depois(t, /data (do )?pagamento|data da opera[çc][ãa]o|pago em|data de arrecada[çc][ãa]o/, DATE);
    r.dataPagamento = dp ? toISO(dp) : null;
    const vp = depois(t, /valor (total )?(pago|do pagamento|arrecadado|total)|total pago/, MONEY);
    r.valor = vp ? toNum(vp) : r.valor;
    r.vencimento = null;
    r.confianca = r.dataPagamento && r.valor ? 'alta' : r.dataPagamento || r.valor ? 'media' : 'baixa';
  } else if (tributo && (r.vencimento || linha)) {
    r.tipo = 'guia';
    // A Receita carimba "PAGO DIA dd/mm/aaaa" na guia depois que o pagamento é identificado.
    const pg = t.match(/pago\s+(?:dia|em)\s+(\d{2}\/\d{2}\/\d{4})/i);
    if (pg) r.dataPagamento = toISO(pg[1]);
    r.confianca = r.vencimento && r.valor && r.valor > 0 ? 'alta' : 'media';
    if (!r.vencimento) avisos.push('Não encontrei o vencimento. Informe manualmente.');
    if (!r.valor) avisos.push('Não encontrei o valor. Informe manualmente.');
  } else {
    avisos.push('Não reconheci este documento como guia, comprovante ou certidão.');
  }

  if (r.cnpjDocumento && cnpjEmpresa && onlyDigits(r.cnpjDocumento) !== onlyDigits(cnpjEmpresa)) {
    avisos.push(`O CNPJ do documento (${r.cnpjDocumento}) é diferente do CNPJ desta empresa.`);
  }
  return r;
}
