import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { onlyDigits, type Cadastral } from '../cnpj.js';
import type { Ctx } from '../ctx.js';
import type { Row } from '../db.js';
import { diffDays, fmtDateBR, todayISO } from '../util.js';
import { atividadeEfetiva, competenciasMei, ehMei } from './dasmei.js';
import { historicoMudancas } from './monitor.js';

/**
 * Planilha completa (.xlsx): uma aba de painel por empresa (sem misturar CNPJs), lançamentos com
 * "Pago / Em aberto" editável, faturamento, dívida ativa, certidões e alertas.
 * Só usa o que o FiscoFácil já guarda; dados que não vêm de fonte oficial aparecem como informados pelo usuário.
 */

const COR = { navy: 'FF1A2040', brand: 'FF5B3FE0', brandBg: 'FFEEEAFD', ok: 'FF15803D', okBg: 'FFE4F7EB', bad: 'FFB91C1C', badBg: 'FFFDE8E8', warn: 'FFB45309', warnBg: 'FFFEF3C7', mute: 'FF5F6787', line: 'FFE5E8F3', soft: 'FFF1F3FA', white: 'FFFFFFFF' };
const REAIS = '"R$" #,##0.00;[Red]-"R$" #,##0.00';
const DATA = 'dd/mm/yyyy';
const MESES = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
const SITUACOES = '"Pago,Em aberto,Em atraso,A confirmar"';
const fill = (argb: string): ExcelJS.Fill => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
const iso2date = (s: string) => new Date(`${s}T12:00:00Z`);
const r2 = (n: number) => Math.round(n * 100) / 100;
const fmtCnpj = (c: string) => { const d = onlyDigits(c); return d.length === 14 ? d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5') : c; };

interface Lanc { empresa: string; cnpj: string; imposto: string; venc: string; valor: number; situacao: string; pagoEm: string | null; codigo: string; origem: string }
interface Dados {
  e: Row; cad: Cadastral | null; cnpj: string; lanc: Lanc[]; fat: number[]; compras: number; ano: number;
  divida: { origem: string; numero: string; receita: string; situacao: string; ajuizada: boolean; valor: number; trimestre: string }[];
  dividaConferida: string | null;
  certidoes: { nome: string; validade: string }[];
  alertas: { quando: string; nivel: string; texto: string; fonte: string }[];
}

async function coletar(ctx: Ctx, e: Row, hoje: string): Promise<Dados> {
  const ano = Number(hoje.slice(0, 4));
  const cad = (e.cadastral ?? null) as Cadastral | null;
  const cnpj = e.cnpj ? fmtCnpj(e.cnpj) : '(sem CNPJ)';
  const situ = (venc: string, pagoEm: string | null) => (pagoEm ? 'Pago' : venc < hoje ? 'Em atraso' : 'Em aberto');
  const obr = (await ctx.db.query('select tributo, venc, valor_centavos, pago_em, codigo, origem from obrigacoes where empresa_id = $1 and arquivado = false order by venc desc', [e.id])).rows;
  const lanc: Lanc[] = obr.map((o) => ({ empresa: e.nome, cnpj, imposto: o.tributo, venc: o.venc, valor: Number(o.valor_centavos) / 100, situacao: situ(o.venc, o.pago_em), pagoEm: o.pago_em ?? null, codigo: o.codigo ?? '', origem: o.origem === 'manual' ? 'Informado por você' : String(o.origem) }));
  if (ehMei(e)) {
    // Meses do DAS-MEI que o dono ainda não confirmou: entram como "A confirmar".
    for (const m of await competenciasMei(ctx, e, 12)) {
      if (m.status === 'nao_confirmado' && m.vencida && m.valor) lanc.push({ empresa: e.nome, cnpj, imposto: 'DAS-MEI', venc: m.vencimento, valor: m.valor, situacao: 'A confirmar', pagoEm: null, codigo: m.competencia, origem: `Tabela oficial (${atividadeEfetiva(e).atividade})` });
    }
  }
  lanc.sort((a, b) => (a.venc < b.venc ? 1 : -1));
  const notas = (await ctx.db.query('select data_emissao, direcao, valor_centavos from notas_fiscais where empresa_id = $1 and data_emissao like $2', [e.id, `${ano}-%`])).rows;
  const fat = Array.from({ length: 12 }, (_, i) => r2(notas.filter((n) => n.direcao === 'emitida' && Number(n.data_emissao.slice(5, 7)) === i + 1).reduce((t, n) => t + Number(n.valor_centavos) / 100, 0)));
  const compras = r2(notas.filter((n) => n.direcao === 'recebida').reduce((t, n) => t + Number(n.valor_centavos) / 100, 0));
  const dig = e.cnpj ? onlyDigits(e.cnpj) : '';
  const dv = (await ctx.db.query('select origem, numero_inscricao, receita, situacao, ajuizado, valor_centavos, trimestre from divida_ativa where cnpj = $1 order by valor_centavos desc', [dig])).rows;
  const ver = (await ctx.db.query('select max(trimestre) as t from pgfn_verificados where cnpj = $1', [dig])).rows[0]?.t ?? null;
  const cert = (await ctx.db.query("select nome, validade from documentos where empresa_id = $1 and tipo = 'Certidão' and validade is not null order by validade", [e.id])).rows;
  const al = (await ctx.db.query('select criado_em, nivel, texto, fonte from alertas where empresa_id = $1 order by criado_em desc limit 100', [e.id])).rows;
  void historicoMudancas;
  return {
    e, cad, cnpj, lanc, fat, compras, ano,
    divida: dv.map((d) => ({ origem: d.origem, numero: d.numero_inscricao, receita: d.receita ?? '', situacao: d.situacao ?? '', ajuizada: !!d.ajuizado, valor: Number(d.valor_centavos) / 100, trimestre: d.trimestre })),
    dividaConferida: ver,
    certidoes: cert.map((c) => ({ nome: c.nome, validade: c.validade })),
    alertas: al.map((a) => ({ quando: new Date(a.criado_em).toISOString(), nivel: a.nivel, texto: a.texto, fonte: a.fonte })),
  };
}

/* ---------- utilidades de estilo ---------- */
function cabecalho(ws: ExcelJS.Worksheet, linha: number, titulos: string[], colIni = 1) {
  titulos.forEach((t, i) => {
    const c = ws.getCell(linha, colIni + i);
    c.value = t; c.font = { bold: true, color: { argb: COR.white }, size: 11 }; c.fill = fill(COR.navy);
    c.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true }; c.border = { bottom: { style: 'thin', color: { argb: COR.navy } } };
  });
  ws.getRow(linha).height = 22;
}
function titulo(ws: ExcelJS.Worksheet, texto: string, sub: string, ate: number) {
  ws.mergeCells(1, 1, 1, ate); ws.mergeCells(2, 1, 2, ate);
  const t = ws.getCell(1, 1); t.value = texto; t.font = { bold: true, size: 18, color: { argb: COR.white } }; t.fill = fill(COR.navy); t.alignment = { vertical: 'middle', indent: 1 };
  const s = ws.getCell(2, 1); s.value = sub; s.font = { size: 10, color: { argb: COR.white } }; s.fill = fill(COR.navy); s.alignment = { vertical: 'middle', indent: 1 };
  ws.getRow(1).height = 34; ws.getRow(2).height = 20;
  for (let c = 1; c <= ate; c++) { ws.getCell(1, c).fill = fill(COR.navy); ws.getCell(2, c).fill = fill(COR.navy); }
}
function zebra(ws: ExcelJS.Worksheet, de: number, ate: number, cols: number) {
  for (let r = de; r <= ate; r++) for (let c = 1; c <= cols; c++) {
    const cell = ws.getCell(r, c);
    cell.border = { bottom: { style: 'hair', color: { argb: COR.line } } };
    if ((r - de) % 2 === 1) cell.fill = fill('FFF8F9FD');
  }
}
const cfTexto = (ws: ExcelJS.Worksheet, ref: string, regras: [string, string, string][]) =>
  ws.addConditionalFormatting({ ref, rules: regras.map(([txt, fg, bg], i) => ({ type: 'cellIs' as const, operator: 'equal' as const, priority: i + 1, formulae: [`"${txt}"`], style: { font: { bold: true, color: { argb: fg } }, fill: { type: 'pattern' as const, pattern: 'solid' as const, bgColor: { argb: bg } } } })) });
const nomeAba = (base: string, usados: Set<string>) => {
  let n = base.replace(/[\\/?*[\]:]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 28) || 'Empresa';
  let k = 2; const original = n;
  while (usados.has(n.toLowerCase())) n = `${original.slice(0, 25)} ${k++}`;
  usados.add(n.toLowerCase()); return n;
};

/* ---------- gráficos (XML escrito à mão, injetado depois) ---------- */
interface Serie { nome: string; refNome: string; refValores: string; valores: number[]; cor: string }
interface Grafico { aba: number; titulo: string; refCategorias: string; categorias: string[]; series: Serie[]; ancora: [number, number, number, number]; horizontal?: boolean; empilhado?: boolean }
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function xmlGrafico(g: Grafico): string {
  const cat = `<c:cat><c:strRef><c:f>${esc(g.refCategorias)}</c:f><c:strCache><c:ptCount val="${g.categorias.length}"/>${g.categorias.map((c, i) => `<c:pt idx="${i}"><c:v>${esc(c)}</c:v></c:pt>`).join('')}</c:strCache></c:strRef></c:cat>`;
  const ser = g.series.map((s, i) => `<c:ser><c:idx val="${i}"/><c:order val="${i}"/><c:tx><c:strRef><c:f>${esc(s.refNome)}</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>${esc(s.nome)}</c:v></c:pt></c:strCache></c:strRef></c:tx><c:spPr><a:solidFill><a:srgbClr val="${s.cor}"/></a:solidFill></c:spPr><c:invertIfNegative val="0"/>${cat}<c:val><c:numRef><c:f>${esc(s.refValores)}</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${s.valores.length}"/>${s.valores.map((v, k) => `<c:pt idx="${k}"><c:v>${v}</c:v></c:pt>`).join('')}</c:numCache></c:numRef></c:val></c:ser>`).join('');
  const txt = (sz: number, b = 0) => `<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="${sz}" b="${b}"><a:solidFill><a:srgbClr val="5F6787"/></a:solidFill></a:defRPr></a:pPr><a:endParaRPr lang="pt-BR"/></a:p></c:txPr>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><c:roundedCorners val="0"/><c:chart><c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1200" b="1"/></a:pPr><a:r><a:rPr lang="pt-BR" sz="1200" b="1"><a:solidFill><a:srgbClr val="1A2040"/></a:solidFill></a:rPr><a:t>${esc(g.titulo)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title><c:autoTitleDeleted val="0"/><c:plotArea><c:layout/><c:barChart><c:barDir val="${g.horizontal ? 'bar' : 'col'}"/><c:grouping val="${g.empilhado ? 'stacked' : 'clustered'}"/><c:varyColors val="0"/>${ser}<c:gapWidth val="60"/>${g.empilhado ? '<c:overlap val="100"/>' : ''}<c:axId val="50010"/><c:axId val="50020"/></c:barChart><c:catAx><c:axId val="50010"/><c:scaling><c:orientation val="${g.horizontal ? 'maxMin' : 'minMax'}"/></c:scaling><c:delete val="0"/><c:axPos val="${g.horizontal ? 'l' : 'b'}"/><c:numFmt formatCode="General" sourceLinked="0"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:spPr><a:ln><a:solidFill><a:srgbClr val="E5E8F3"/></a:solidFill></a:ln></c:spPr>${txt(900)}<c:crossAx val="50020"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx><c:valAx><c:axId val="50020"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="${g.horizontal ? 't' : 'l'}"/><c:majorGridlines><c:spPr><a:ln><a:solidFill><a:srgbClr val="E5E8F3"/></a:solidFill></a:ln></c:spPr></c:majorGridlines><c:numFmt formatCode="&quot;R$&quot; #,##0" sourceLinked="0"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:spPr><a:ln><a:noFill/></a:ln></c:spPr>${txt(900)}<c:crossAx val="50010"/><c:crosses val="${g.horizontal ? 'max' : 'autoZero'}"/><c:crossBetween val="between"/></c:valAx><c:spPr><a:noFill/></c:spPr></c:plotArea>${g.series.length > 1 ? `<c:legend><c:legendPos val="b"/><c:overlay val="0"/>${txt(900)}</c:legend>` : ''}<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart><c:spPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:ln><a:solidFill><a:srgbClr val="E5E8F3"/></a:solidFill></a:ln></c:spPr></c:chartSpace>`;
}

function xmlDesenho(itens: { rid: string; n: number; ancora: [number, number, number, number] }[]): string {
  const a = (i: { rid: string; n: number; ancora: [number, number, number, number] }) => `<xdr:twoCellAnchor><xdr:from><xdr:col>${i.ancora[0]}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${i.ancora[1]}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>${i.ancora[2]}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${i.ancora[3]}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${i.n + 1}" name="Gráfico ${i.n}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="${i.rid}"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">${itens.map(a).join('')}</xdr:wsDr>`;
}

async function injetarGraficos(buf: Buffer, graficos: Grafico[]): Promise<Buffer> {
  if (!graficos.length) return buf;
  const zip = await JSZip.loadAsync(buf);
  let tipos = await zip.file('[Content_Types].xml')!.async('string');
  const porAba = new Map<number, Grafico[]>();
  graficos.forEach((g) => porAba.set(g.aba, [...(porAba.get(g.aba) ?? []), g]));
  let nChart = 0, nDraw = 0;
  for (const [aba, lista] of porAba) {
    nDraw++;
    const itens: { rid: string; n: number; ancora: [number, number, number, number] }[] = [];
    let relsDraw = '';
    lista.forEach((g, i) => {
      nChart++;
      zip.file(`xl/charts/chart${nChart}.xml`, xmlGrafico(g));
      tipos = tipos.replace('</Types>', `<Override PartName="/xl/charts/chart${nChart}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/></Types>`);
      relsDraw += `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart${nChart}.xml"/>`;
      itens.push({ rid: `rId${i + 1}`, n: i + 1, ancora: g.ancora });
    });
    zip.file(`xl/drawings/drawing${nDraw}.xml`, xmlDesenho(itens));
    zip.file(`xl/drawings/_rels/drawing${nDraw}.xml.rels`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relsDraw}</Relationships>`);
    tipos = tipos.replace('</Types>', `<Override PartName="/xl/drawings/drawing${nDraw}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/></Types>`);
    // liga o desenho à aba
    const relPath = `xl/worksheets/_rels/sheet${aba}.xml.rels`;
    const rel = `<Relationship Id="rIdGraf${nDraw}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing${nDraw}.xml"/>`;
    const existente = zip.file(relPath);
    if (existente) zip.file(relPath, (await existente.async('string')).replace('</Relationships>', `${rel}</Relationships>`));
    else zip.file(relPath, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rel}</Relationships>`);
    const sheetPath = `xl/worksheets/sheet${aba}.xml`;
    let xml = await zip.file(sheetPath)!.async('string');
    const tag = `<drawing r:id="rIdGraf${nDraw}"/>`;
    const pos = ['<legacyDrawing', '<tableParts', '<extLst'].map((t) => xml.indexOf(t)).filter((x) => x >= 0).sort((a, b) => a - b)[0];
    xml = pos !== undefined ? xml.slice(0, pos) + tag + xml.slice(pos) : xml.replace('</worksheet>', `${tag}</worksheet>`);
    if (!/xmlns:r=/.test(xml.slice(0, 600))) xml = xml.replace('<worksheet ', '<worksheet xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ');
    zip.file(sheetPath, xml);
  }
  zip.file('[Content_Types].xml', tipos);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/* ---------- a planilha ---------- */
export async function gerarPlanilha(ctx: Ctx, userId: string, empresaId?: string): Promise<{ buffer: Buffer; nome: string; empresas: number }> {
  const hoje = todayISO(ctx.now());
  const ano = Number(hoje.slice(0, 4));
  const { rows } = await ctx.db.query('select * from empresas where user_id = $1 order by criado_em', [userId]);
  const alvo = empresaId ? rows.filter((r) => r.id === empresaId) : rows;
  const dados: Dados[] = [];
  for (const e of alvo) dados.push(await coletar(ctx, e, hoje));

  const wb = new ExcelJS.Workbook();
  wb.creator = 'FiscoFácil'; wb.created = ctx.now(); wb.title = 'FiscoFácil: planilha completa';
  wb.calcProperties = { fullCalcOnLoad: true } as never;
  const graficos: Grafico[] = [];
  const usados = new Set<string>();

  // Abas na ordem em que aparecem: Resumo, painéis, Lançamentos, Faturamento, Dívida ativa, Certidões, Alertas, Como usar.
  const wsRes = wb.addWorksheet(nomeAba('Resumo', usados), { views: [{ showGridLines: false }], properties: { tabColor: { argb: COR.brand } } });
  const paineis = dados.map((d) => wb.addWorksheet(nomeAba(`Painel ${d.e.nome}`, usados), { views: [{ showGridLines: false }], properties: { tabColor: { argb: COR.brand } } }));
  const wsL = wb.addWorksheet(nomeAba('Lançamentos', usados), { views: [{ state: 'frozen', ySplit: 4, showGridLines: false }] });
  const wsF = wb.addWorksheet(nomeAba('Faturamento', usados), { views: [{ showGridLines: false }] });
  const wsD = wb.addWorksheet(nomeAba('Dívida ativa', usados), { views: [{ showGridLines: false }] });
  const wsC = wb.addWorksheet(nomeAba('Certidões', usados), { views: [{ showGridLines: false }] });
  const wsA = wb.addWorksheet(nomeAba('Alertas', usados), { views: [{ showGridLines: false }] });
  const wsH = wb.addWorksheet(nomeAba('Como usar', usados), { views: [{ showGridLines: false }] });

  /* Lançamentos */
  titulo(wsL, 'Lançamentos: guias e pagamentos', 'Troque a coluna "Situação" para Pago, Em aberto, Em atraso ou A confirmar: os painéis se atualizam sozinhos.', 9);
  cabecalho(wsL, 4, ['Empresa', 'CNPJ', 'Imposto', 'Vencimento', 'Valor', 'Situação', 'Pago em', 'Código / competência', 'Origem']);
  const todos = dados.flatMap((d) => d.lanc);
  todos.forEach((l, i) => {
    const r = 5 + i;
    wsL.getCell(r, 1).value = l.empresa; wsL.getCell(r, 2).value = l.cnpj; wsL.getCell(r, 3).value = l.imposto;
    wsL.getCell(r, 4).value = iso2date(l.venc); wsL.getCell(r, 4).numFmt = DATA;
    wsL.getCell(r, 5).value = l.valor; wsL.getCell(r, 5).numFmt = REAIS;
    wsL.getCell(r, 6).value = l.situacao;
    if (l.pagoEm) { wsL.getCell(r, 7).value = iso2date(l.pagoEm); wsL.getCell(r, 7).numFmt = DATA; }
    wsL.getCell(r, 8).value = l.codigo; wsL.getCell(r, 9).value = l.origem;
  });
  const fimL = Math.max(5 + todos.length - 1, 5);
  zebra(wsL, 5, fimL, 9);
  for (let r = 5; r <= fimL + 300; r++) wsL.getCell(r, 6).dataValidation = { type: 'list', allowBlank: false, formulae: [SITUACOES], showErrorMessage: true, errorTitle: 'Situação', error: 'Escolha: Pago, Em aberto, Em atraso ou A confirmar.' };
  cfTexto(wsL, `F5:F${fimL + 300}`, [['Pago', COR.ok, COR.okBg], ['Em atraso', COR.bad, COR.badBg], ['Em aberto', COR.warn, COR.warnBg], ['A confirmar', COR.mute, COR.soft]]);
  [28, 22, 12, 14, 16, 16, 14, 26, 28].forEach((w, i) => { wsL.getColumn(i + 1).width = w; });
  wsL.autoFilter = { from: { row: 4, column: 1 }, to: { row: Math.max(fimL, 5), column: 9 } };
  if (!todos.length) { wsL.getCell(5, 1).value = 'Nenhuma guia cadastrada ainda. Cadastre em "Guias e pagamentos" ou confirme os meses do DAS-MEI.'; wsL.getCell(5, 1).font = { italic: true, color: { argb: COR.mute } }; }
  const LNC = (col: string) => `'${wsL.name}'!$${col}$5:$${col}$${fimL + 300}`;

  /* Dívida ativa */
  titulo(wsD, 'Dívida ativa da União e do FGTS', 'Fonte: dados abertos da PGFN, base trimestral. Só aparece aqui o que a PGFN publicou.', 9);
  cabecalho(wsD, 4, ['Empresa', 'CNPJ', 'Origem', 'Inscrição', 'Receita', 'Situação', 'Ajuizada', 'Valor', 'Base']);
  let rD = 5;
  for (const d of dados) {
    if (d.divida.length) for (const x of d.divida) {
      wsD.getRow(rD).values = [d.e.nome, d.cnpj, x.origem, x.numero, x.receita, x.situacao, x.ajuizada ? 'Sim' : 'Não', x.valor, x.trimestre]; wsD.getCell(rD, 8).numFmt = REAIS; rD++;
    } else {
      wsD.getRow(rD).values = [d.e.nome, d.cnpj, d.dividaConferida ? 'Nenhuma dívida ativa encontrada' : 'Ainda não conferido', '', '', '', '', 0, d.dividaConferida ?? '']; wsD.getCell(rD, 8).numFmt = REAIS;
      wsD.getCell(rD, 3).font = { bold: true, color: { argb: d.dividaConferida ? COR.ok : COR.mute } }; rD++;
    }
  }
  zebra(wsD, 5, Math.max(rD - 1, 5), 9);
  [28, 22, 30, 22, 26, 22, 10, 16, 20].forEach((w, i) => { wsD.getColumn(i + 1).width = w; });
  const DIV = (col: string) => `'${wsD.name}'!$${col}$5:$${col}$${rD + 50}`;

  /* Faturamento */
  titulo(wsF, `Faturamento em ${ano}`, 'Soma das notas fiscais emitidas e vendas sem nota que você registrou. Compras = notas recebidas.', 16);
  cabecalho(wsF, 4, ['Empresa', 'CNPJ', ...MESES, 'Total', 'Compras']);
  dados.forEach((d, i) => {
    const r = 5 + i;
    wsF.getRow(r).values = [d.e.nome, d.cnpj, ...d.fat];
    wsF.getCell(r, 15).value = { formula: `SUM(C${r}:N${r})`, result: r2(d.fat.reduce((t, v) => t + v, 0)) };
    wsF.getCell(r, 16).value = d.compras;
    for (let c = 3; c <= 16; c++) wsF.getCell(r, c).numFmt = REAIS;
    wsF.getCell(r, 15).font = { bold: true };
  });
  zebra(wsF, 5, Math.max(4 + dados.length, 5), 16);
  wsF.getColumn(1).width = 28; wsF.getColumn(2).width = 22; for (let c = 3; c <= 16; c++) wsF.getColumn(c).width = 13;

  /* Certidões */
  titulo(wsC, 'Certidões anexadas', 'Validade das certidões que você enviou em Documentos.', 5);
  cabecalho(wsC, 4, ['Empresa', 'Documento', 'Validade', 'Dias', 'Situação']);
  let rC = 5;
  for (const d of dados) for (const c of d.certidoes) {
    const dias = diffDays(c.validade, hoje);
    wsC.getRow(rC).values = [d.e.nome, c.nome, iso2date(c.validade), dias, dias < 0 ? 'Vencida' : dias <= 15 ? 'Vence em breve' : 'Válida'];
    wsC.getCell(rC, 3).numFmt = DATA; rC++;
  }
  if (rC === 5) { wsC.getCell(5, 1).value = 'Nenhuma certidão com validade anexada.'; wsC.getCell(5, 1).font = { italic: true, color: { argb: COR.mute } }; rC = 6; }
  zebra(wsC, 5, rC - 1, 5);
  cfTexto(wsC, `E5:E${rC + 100}`, [['Vencida', COR.bad, COR.badBg], ['Vence em breve', COR.warn, COR.warnBg], ['Válida', COR.ok, COR.okBg]]);
  [28, 36, 14, 8, 18].forEach((w, i) => { wsC.getColumn(i + 1).width = w; });
  const CER = (col: string) => `'${wsC.name}'!$${col}$5:$${col}$${rC + 100}`;

  /* Alertas */
  titulo(wsA, 'Alertas e mudanças detectadas', 'O que o FiscoFácil avisou: mudanças no cadastro, dívida nova, certidão vencendo.', 5);
  cabecalho(wsA, 4, ['Data', 'Empresa', 'Gravidade', 'Aviso', 'Fonte']);
  let rA = 5;
  for (const d of dados) for (const a of d.alertas) {
    wsA.getRow(rA).values = [new Date(a.quando), d.e.nome, a.nivel === 'alerta' ? 'Urgente' : a.nivel === 'info' ? 'Informação' : 'Atenção', a.texto, a.fonte];
    wsA.getCell(rA, 1).numFmt = 'dd/mm/yyyy hh:mm'; wsA.getCell(rA, 4).alignment = { wrapText: true, vertical: 'top' }; rA++;
  }
  if (rA === 5) { wsA.getCell(5, 1).value = 'Nenhum alerta até agora.'; wsA.getCell(5, 1).font = { italic: true, color: { argb: COR.mute } }; rA = 6; }
  zebra(wsA, 5, rA - 1, 5);
  cfTexto(wsA, `C5:C${rA + 100}`, [['Urgente', COR.bad, COR.badBg], ['Atenção', COR.warn, COR.warnBg], ['Informação', COR.ok, COR.okBg]]);
  [18, 28, 14, 70, 36].forEach((w, i) => { wsA.getColumn(i + 1).width = w; });

  /* Painel de cada empresa */
  dados.forEach((d, idx) => {
    const ws = paineis[idx];
    const aba = ws.id;
    const q = `'${ws.name}'`;
    const cad = d.cad;
    titulo(ws, d.e.nome, `${d.cnpj}  ·  ${d.e.regime}  ·  Situação cadastral: ${cad?.situacao ?? 'não consultada'}${cad?.atividade ? '  ·  ' + String(cad.atividade) : ''}`, 12);
    ws.getCell('A3').value = d.cnpj; ws.getCell('A3').font = { size: 8, color: { argb: 'FFFFFFFF' } };      // chave usada nas fórmulas (invisível: texto branco)
    const soma = (col: string, ...crit: string[]) => `SUMIFS(${LNC(col)},${LNC('B')},$A$3${crit.length ? ',' + crit.join(',') : ''})`;
    const val = (sit: string) => r2(d.lanc.filter((l) => l.situacao === sit).reduce((t, l) => t + l.valor, 0));
    const pagoAno = r2(d.lanc.filter((l) => l.situacao === 'Pago' && l.pagoEm && l.pagoEm.startsWith(String(ano))).reduce((t, l) => t + l.valor, 0));
    const totalDiv = r2(d.divida.reduce((t, x) => t + x.valor, 0));
    const cards: [string, string, number, string, string][] = [
      ['EM ABERTO', soma('E', `${LNC('F')},"Em aberto"`), val('Em aberto'), COR.warn, COR.warnBg],
      ['EM ATRASO', soma('E', `${LNC('F')},"Em atraso"`), val('Em atraso'), COR.bad, COR.badBg],
      [`PAGO EM ${ano}`, soma('E', `${LNC('F')},"Pago"`, `${LNC('G')},">="&DATE(${ano},1,1)`, `${LNC('G')},"<="&DATE(${ano},12,31)`), pagoAno, COR.ok, COR.okBg],
      ['DÍVIDA ATIVA (PGFN)', `SUMIFS(${DIV('H')},${DIV('B')},$A$3)`, totalDiv, totalDiv > 0 ? COR.bad : COR.ok, totalDiv > 0 ? COR.badBg : COR.okBg],
    ];
    cards.forEach(([rot, f, res, fg, bg], i) => {
      const c0 = 1 + i * 3;
      ws.mergeCells(4, c0, 4, c0 + 2); ws.mergeCells(5, c0, 5, c0 + 2);
      const a = ws.getCell(4, c0); a.value = rot; a.font = { bold: true, size: 9, color: { argb: fg } }; a.alignment = { indent: 1, vertical: 'bottom' };
      const b = ws.getCell(5, c0); b.value = { formula: f, result: res }; b.numFmt = REAIS; b.font = { bold: true, size: 20, color: { argb: fg } }; b.alignment = { indent: 1, vertical: 'middle', horizontal: 'left' };
      for (let k = 0; k < 3; k++) { ws.getCell(4, c0 + k).fill = fill(bg); ws.getCell(5, c0 + k).fill = fill(bg); }
    });
    ws.getRow(4).height = 22; ws.getRow(5).height = 38;
    ws.getCell('A6').value = d.lanc.some((l) => l.situacao === 'A confirmar') ? 'Há meses do DAS-MEI a confirmar: marque Pago ou Em aberto na aba Lançamentos.' : 'Valores calculados a partir da aba Lançamentos.';
    ws.getCell('A6').font = { italic: true, size: 9, color: { argb: COR.mute } };

    // Impostos por tipo (com fórmulas, para acompanhar mudanças na aba Lançamentos)
    ws.getCell('A8').value = 'Impostos por tipo'; ws.getCell('A8').font = { bold: true, size: 13, color: { argb: COR.navy } };
    cabecalho(ws, 9, ['Imposto', 'Pago', 'Em aberto', 'Guias']);
    const tipos = [...new Set(d.lanc.map((l) => l.imposto))].slice(0, 10);
    if (!tipos.length) tipos.push('(sem guias)');
    tipos.forEach((t, i) => {
      const r = 10 + i;
      const do_tipo = d.lanc.filter((l) => l.imposto === t);
      ws.getCell(r, 1).value = t;
      ws.getCell(r, 2).value = { formula: `SUMIFS(${LNC('E')},${LNC('B')},$A$3,${LNC('C')},$A${r},${LNC('F')},"Pago")`, result: r2(do_tipo.filter((l) => l.situacao === 'Pago').reduce((s, l) => s + l.valor, 0)) };
      ws.getCell(r, 3).value = { formula: `SUMIFS(${LNC('E')},${LNC('B')},$A$3,${LNC('C')},$A${r},${LNC('F')},"Em aberto")+SUMIFS(${LNC('E')},${LNC('B')},$A$3,${LNC('C')},$A${r},${LNC('F')},"Em atraso")`, result: r2(do_tipo.filter((l) => l.situacao === 'Em aberto' || l.situacao === 'Em atraso').reduce((s, l) => s + l.valor, 0)) };
      ws.getCell(r, 4).value = { formula: `COUNTIFS(${LNC('B')},$A$3,${LNC('C')},$A${r})`, result: do_tipo.length };
      ws.getCell(r, 2).numFmt = REAIS; ws.getCell(r, 3).numFmt = REAIS;
    });
    const fimT = 9 + tipos.length;
    zebra(ws, 10, fimT, 4);
    const pagos = tipos.map((t) => r2(d.lanc.filter((l) => l.imposto === t && l.situacao === 'Pago').reduce((s, l) => s + l.valor, 0)));
    const abertos = tipos.map((t) => r2(d.lanc.filter((l) => l.imposto === t && (l.situacao === 'Em aberto' || l.situacao === 'Em atraso')).reduce((s, l) => s + l.valor, 0)));
    graficos.push({
      aba, titulo: 'Pago x em aberto, por imposto', refCategorias: `${q}!$A$10:$A$${fimT}`, categorias: tipos, ancora: [5, 7, 12, 22],
      series: [
        { nome: 'Pago', refNome: `${q}!$B$9`, refValores: `${q}!$B$10:$B$${fimT}`, valores: pagos, cor: '22C55E' },
        { nome: 'Em aberto', refNome: `${q}!$C$9`, refValores: `${q}!$C$10:$C$${fimT}`, valores: abertos, cor: 'F59E0B' },
      ],
    });

    // Faturamento por mês
    const r0 = 24;
    ws.getCell(r0, 1).value = `Faturamento em ${ano}`; ws.getCell(r0, 1).font = { bold: true, size: 13, color: { argb: COR.navy } };
    cabecalho(ws, r0 + 1, ['Mês', 'Faturamento']);
    MESES.forEach((m, i) => {
      const r = r0 + 2 + i;
      ws.getCell(r, 1).value = m; ws.getCell(r, 2).value = { formula: `'${wsF.name}'!${String.fromCharCode(67 + i)}${5 + idx}`, result: d.fat[i] }; ws.getCell(r, 2).numFmt = REAIS;
    });
    zebra(ws, r0 + 2, r0 + 13, 2);
    ws.getCell(r0 + 14, 1).value = 'Total'; ws.getCell(r0 + 14, 1).font = { bold: true };
    ws.getCell(r0 + 14, 2).value = { formula: `SUM(B${r0 + 2}:B${r0 + 13})`, result: r2(d.fat.reduce((t, v) => t + v, 0)) }; ws.getCell(r0 + 14, 2).numFmt = REAIS; ws.getCell(r0 + 14, 2).font = { bold: true };
    graficos.push({
      aba, titulo: `Faturamento por mês em ${ano}`, refCategorias: `${q}!$A$${r0 + 2}:$A$${r0 + 13}`, categorias: MESES, ancora: [5, r0 - 1, 12, r0 + 14],
      series: [{ nome: 'Faturamento', refNome: `${q}!$B$${r0 + 1}`, refValores: `${q}!$B$${r0 + 2}:$B$${r0 + 13}`, valores: d.fat, cor: '5B3FE0' }],
    });

    // Próximos vencimentos
    const r1 = r0 + 17;
    ws.getCell(r1, 1).value = 'Próximos vencimentos e pendências'; ws.getCell(r1, 1).font = { bold: true, size: 13, color: { argb: COR.navy } };
    cabecalho(ws, r1 + 1, ['Imposto', 'Vencimento', 'Valor', 'Situação']);
    const pend = d.lanc.filter((l) => l.situacao !== 'Pago').sort((a, b) => (a.venc < b.venc ? -1 : 1)).slice(0, 10);
    pend.forEach((l, i) => {
      const r = r1 + 2 + i;
      ws.getRow(r).values = [l.imposto, iso2date(l.venc), l.valor, l.situacao]; ws.getCell(r, 2).numFmt = DATA; ws.getCell(r, 3).numFmt = REAIS;
    });
    if (!pend.length) { ws.getCell(r1 + 2, 1).value = 'Nada em aberto. Tudo em dia pelo que está cadastrado.'; ws.getCell(r1 + 2, 1).font = { italic: true, color: { argb: COR.ok } }; }
    zebra(ws, r1 + 2, r1 + 1 + Math.max(pend.length, 1), 4);
    cfTexto(ws, `D${r1 + 2}:D${r1 + 12}`, [['Em atraso', COR.bad, COR.badBg], ['Em aberto', COR.warn, COR.warnBg], ['A confirmar', COR.mute, COR.soft]]);
    // Certidões e dívida em uma linha de resumo
    const rr = r1 + 14;
    ws.getCell(rr, 1).value = 'Outras conferências'; ws.getCell(rr, 1).font = { bold: true, size: 13, color: { argb: COR.navy } };
    const venc = d.certidoes.filter((c) => diffDays(c.validade, hoje) < 0).length, breve = d.certidoes.filter((c) => { const x = diffDays(c.validade, hoje); return x >= 0 && x <= 15; }).length;
    ws.getCell(rr + 1, 1).value = totalDiv > 0 ? `Dívida ativa: ${d.divida.length} inscrição(ões) na base da PGFN (${d.dividaConferida ?? ''}).` : d.dividaConferida ? `Dívida ativa: nenhuma encontrada na base da PGFN (${d.dividaConferida}).` : 'Dívida ativa: ainda não conferida.';
    ws.getCell(rr + 2, 1).value = d.certidoes.length ? `Certidões anexadas: ${d.certidoes.length} (${venc} vencida(s), ${breve} vencendo em até 15 dias).` : 'Certidões: nenhuma com validade anexada.';
    if (cad?.situacao && !/^ATIVA$/i.test(String(cad.situacao))) { ws.getCell(rr + 3, 1).value = `Atenção: situação cadastral ${cad.situacao}.`; ws.getCell(rr + 3, 1).font = { bold: true, color: { argb: COR.bad } }; }
    ws.getColumn(1).width = 26; ws.getColumn(2).width = 16; ws.getColumn(3).width = 16; ws.getColumn(4).width = 14;
    for (let c = 5; c <= 12; c++) ws.getColumn(c).width = 11;
  });

  /* Resumo (todas as empresas, uma linha cada) */
  titulo(wsRes, 'FiscoFácil: resumo das empresas', `Gerado em ${fmtDateBR(hoje)}. Cada empresa tem a sua própria aba de painel, para não misturar CNPJs.`, 9);
  cabecalho(wsRes, 4, ['Empresa', 'CNPJ', 'Regime', 'Situação cadastral', 'Em aberto', 'Em atraso', `Pago em ${ano}`, 'Dívida ativa', 'Certidões vencidas']);
  dados.forEach((d, i) => {
    const r = 5 + i;
    const val = (sit: string) => r2(d.lanc.filter((l) => l.situacao === sit).reduce((t, l) => t + l.valor, 0));
    wsRes.getCell(r, 1).value = { text: d.e.nome, hyperlink: `#'${paineis[i].name}'!A1` } as ExcelJS.CellHyperlinkValue; wsRes.getCell(r, 1).font = { bold: true, color: { argb: COR.brand }, underline: true };
    wsRes.getCell(r, 2).value = d.cnpj; wsRes.getCell(r, 3).value = d.e.regime; wsRes.getCell(r, 4).value = d.cad?.situacao ?? 'Não consultada';
    wsRes.getCell(r, 5).value = { formula: `SUMIFS(${LNC('E')},${LNC('B')},$B${r},${LNC('F')},"Em aberto")`, result: val('Em aberto') };
    wsRes.getCell(r, 6).value = { formula: `SUMIFS(${LNC('E')},${LNC('B')},$B${r},${LNC('F')},"Em atraso")`, result: val('Em atraso') };
    wsRes.getCell(r, 7).value = { formula: `SUMIFS(${LNC('E')},${LNC('B')},$B${r},${LNC('F')},"Pago",${LNC('G')},">="&DATE(${ano},1,1),${LNC('G')},"<="&DATE(${ano},12,31))`, result: r2(d.lanc.filter((l) => l.situacao === 'Pago' && l.pagoEm?.startsWith(String(ano))).reduce((t, l) => t + l.valor, 0)) };
    wsRes.getCell(r, 8).value = { formula: `SUMIFS(${DIV('H')},${DIV('B')},$B${r})`, result: r2(d.divida.reduce((t, x) => t + x.valor, 0)) };
    wsRes.getCell(r, 9).value = { formula: `COUNTIFS(${CER('A')},$A${r},${CER('E')},"Vencida")`, result: d.certidoes.filter((c) => diffDays(c.validade, hoje) < 0).length };
    for (let c = 5; c <= 8; c++) wsRes.getCell(r, c).numFmt = REAIS;
  });
  const fimR = Math.max(4 + dados.length, 5);
  zebra(wsRes, 5, fimR, 9);
  wsRes.addConditionalFormatting({ ref: `F5:F${fimR}`, rules: [{ type: 'cellIs', operator: 'greaterThan', priority: 1, formulae: ['0'], style: { font: { bold: true, color: { argb: COR.bad } }, fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: COR.badBg } } } }] });
  wsRes.addConditionalFormatting({ ref: `H5:H${fimR}`, rules: [{ type: 'cellIs', operator: 'greaterThan', priority: 2, formulae: ['0'], style: { font: { bold: true, color: { argb: COR.bad } }, fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: COR.badBg } } } }] });
  cfTexto(wsRes, `D5:D${fimR}`, [['ATIVA', COR.ok, COR.okBg]]);
  [30, 22, 18, 20, 16, 16, 16, 16, 18].forEach((w, i) => { wsRes.getColumn(i + 1).width = w; });
  if (!dados.length) { wsRes.getCell(5, 1).value = 'Nenhuma empresa cadastrada ainda.'; wsRes.getCell(5, 1).font = { italic: true, color: { argb: COR.mute } }; }

  /* Como usar */
  titulo(wsH, 'Como usar esta planilha', 'Leia uma vez; leva um minuto.', 2);
  const linhas: [string, string][] = [
    ['Resumo', 'Uma linha por empresa. Clique no nome da empresa para abrir o painel dela.'],
    ['Painel (uma aba por empresa)', 'Cartões com o que está em aberto, em atraso, pago no ano e a dívida ativa; gráficos de impostos e de faturamento; próximos vencimentos.'],
    ['Lançamentos', 'Todas as guias. Na coluna "Situação" escolha Pago, Em aberto, Em atraso ou A confirmar: os painéis e gráficos se atualizam na hora.'],
    ['De onde vêm os dados', 'Cadastro e dívida ativa: fontes oficiais públicas (Receita Federal e PGFN). Guias, pagamentos e vendas sem nota: o que você informou. DAS-MEI: valor da tabela oficial.'],
    ['O que esta planilha não sabe', 'Se uma guia foi paga de verdade na Receita. Isso só é possível com a conexão oficial (Serpro), que ainda não está ativa. Por isso a situação vem do que você marcou.'],
    ['Segurança', 'Não há senhas nem certificados nesta planilha. Guarde o arquivo com cuidado: ele tem os dados financeiros das suas empresas.'],
  ];
  linhas.forEach(([a, b], i) => {
    const r = 4 + i; wsH.getCell(r, 1).value = a; wsH.getCell(r, 1).font = { bold: true, color: { argb: COR.navy } }; wsH.getCell(r, 1).alignment = { vertical: 'top', wrapText: true };
    wsH.getCell(r, 2).value = b; wsH.getCell(r, 2).alignment = { wrapText: true, vertical: 'top' }; wsH.getRow(r).height = 48;
  });
  wsH.getColumn(1).width = 30; wsH.getColumn(2).width = 100;

  for (const w of wb.worksheets) {
    w.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 };
  }
  const bruto = Buffer.from(await wb.xlsx.writeBuffer());
  const buffer = await injetarGraficos(bruto, graficos);
  return { buffer, nome: `FiscoFacil-planilha-${hoje}.xlsx`, empresas: dados.length };
}
