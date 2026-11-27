import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { chaveValida, lerNotaTexto, lerNotaXml, limiteMei, pareceTextoDeNota } from '../src/services/notafiscal.js';
import { CNPJ_TESTE, cadastrar, criar } from './helpers.js';

const MEU = '66369868000171';
const CLIENTE = '11222333000181';

/** Monta uma chave de 44 dígitos com DV correto. */
export function chave(cnpjEmit: string, numero: number, modelo = '55'): string {
  const base = `35` + `2610` + cnpjEmit + modelo + '001' + String(numero).padStart(9, '0') + '1' + '12345678';
  let soma = 0, peso = 2;
  for (let i = base.length - 1; i >= 0; i--) { soma += Number(base[i]) * peso; peso = peso === 9 ? 2 : peso + 1; }
  const r = soma % 11;
  return base + (r < 2 ? 0 : 11 - r);
}
export function nfeXml(o: { emit: string; dest: string; numero: number; valor: string; data: string; modelo?: string }) {
  const ch = chave(o.emit, o.numero, o.modelo);
  return `<?xml version="1.0" encoding="UTF-8"?><nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00"><NFe><infNFe Id="NFe${ch}" versao="4.00">
<ide><cUF>35</cUF><natOp>Venda de mercadoria</natOp><mod>${o.modelo ?? '55'}</mod><serie>1</serie><nNF>${o.numero}</nNF><dhEmi>${o.data}T10:00:00-03:00</dhEmi></ide>
<emit><CNPJ>${o.emit}</CNPJ><xNome>EMITENTE &amp; CIA</xNome></emit><dest><CNPJ>${o.dest}</CNPJ><xNome>DESTINO LTDA</xNome></dest>
<total><ICMSTot><vICMS>0.00</vICMS><vIPI>0.00</vIPI><vNF>${o.valor}</vNF></ICMSTot></total></infNFe></NFe></nfeProc>`;
}

describe('nota fiscal: leitura', () => {
  test('chave de acesso: dígito verificador', () => {
    const c = chave(MEU, 15);
    assert.equal(chaveValida(c), true);
    assert.equal(chaveValida(c.slice(0, 43) + ((Number(c[43]) + 1) % 10)), false);
    assert.equal(chaveValida('123'), false);
  });
  test('XML de NF-e: emitida pela empresa e recebida de fornecedor', () => {
    const v = lerNotaXml(nfeXml({ emit: MEU, dest: CLIENTE, numero: 15, valor: '1250.50', data: '2026-10-05' }), CNPJ_TESTE);
    assert.equal(v.tipo, 'NF-e'); assert.equal(v.direcao, 'emitida'); assert.equal(v.valor, 1250.5); assert.equal(v.dataEmissao, '2026-10-05');
    assert.equal(v.numero, '15'); assert.equal(v.emitente.nome, 'EMITENTE & CIA'); assert.equal(v.confianca, 'alta'); assert.deepEqual(v.avisos, []);
    const c = lerNotaXml(nfeXml({ emit: CLIENTE, dest: MEU, numero: 7, valor: '300.00', data: '2026-10-06' }), CNPJ_TESTE);
    assert.equal(c.direcao, 'recebida');
    const x = lerNotaXml(nfeXml({ emit: CLIENTE, dest: '99888777000166', numero: 7, valor: '300.00', data: '2026-10-06' }), CNPJ_TESTE);
    assert.equal(x.direcao, 'outra'); assert.match(x.avisos[0], /não tem o CNPJ/);
    assert.equal(lerNotaXml(nfeXml({ emit: MEU, dest: CLIENTE, numero: 2, valor: '10.00', data: '2026-10-05', modelo: '65' }), MEU).tipo, 'NFC-e');
  });
  test('XML de NF-e traz a data prevista de recebimento (cobrança/duplicata)', () => {
    const xml = nfeXml({ emit: MEU, dest: CLIENTE, numero: 21, valor: '10000.00', data: '2026-11-20' }).replace('</infNFe>', '<cobr><dup><nDup>001</nDup><dVenc>2026-12-03</dVenc><vDup>10000.00</vDup></dup></cobr></infNFe>');
    const n = lerNotaXml(xml, MEU);
    assert.equal(n.receberEm, '2026-12-03'); assert.equal(n.valor, 10000);
    assert.equal(lerNotaXml(nfeXml({ emit: MEU, dest: CLIENTE, numero: 22, valor: '1.00', data: '2026-11-20' }), MEU).receberEm, null);
  });
  test('XML de NFS-e no padrão nacional', () => {
    const xml = `<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse"><infNFSe Id="NFS${'3'.repeat(50)}"><nNFSe>42</nNFSe><dhProc>2026-09-10T08:00:00-03:00</dhProc>
<emit><CNPJ>${MEU}</CNPJ><xNome>MEU MEI</xNome></emit><valores><vLiq>800.00</vLiq></valores><DPS><infDPS><toma><CNPJ>${CLIENTE}</CNPJ><xNome>CLIENTE</xNome></toma>
<serv><cServ><xDescServ>Consultoria</xDescServ></cServ></serv></infDPS></DPS></infNFSe></NFSe>`;
    const n = lerNotaXml(xml, MEU);
    assert.equal(n.tipo, 'NFS-e'); assert.equal(n.numero, '42'); assert.equal(n.valor, 800); assert.equal(n.direcao, 'emitida'); assert.equal(n.destinatario.doc, CLIENTE);
  });
  test('texto de DANFE (PDF) usa a chave de acesso', () => {
    const c = chave(CLIENTE, 991);
    const t = `DANFE\nDOCUMENTO AUXILIAR DA NOTA FISCAL ELETRÔNICA\nCHAVE DE ACESSO\n${c.match(/.{1,4}/g)!.join(' ')}\nDESTINATÁRIO 66.369.868/0001-71\nDATA DA EMISSÃO 03/10/2026\nVALOR TOTAL DA NOTA 2.345,67`;
    assert.equal(pareceTextoDeNota(t), true);
    const n = lerNotaTexto(t, MEU);
    assert.equal(n.chave, c); assert.equal(n.numero, '991'); assert.equal(n.valor, 2345.67); assert.equal(n.dataEmissao, '2026-10-03'); assert.equal(n.direcao, 'recebida');
  });
  test('limite do MEI: cheio e proporcional no ano de abertura', () => {
    assert.deepEqual(limiteMei(2026, '2025-02-01'), { limite: 81000, meses: 12 });
    assert.deepEqual(limiteMei(2026, '2026-04-21'), { limite: 60750, meses: 9 });
    assert.deepEqual(limiteMei(2026, null), { limite: 81000, meses: 12 });
  });
});

describe('nota fiscal: pela API', () => {
  let t: Awaited<ReturnType<typeof criar>>;
  before(async () => { t = await criar(); });
  after(async () => { await t.fechar(); });
  const envio = (nome: string, conteudo: Buffer | string, tipo = 'application/xml') => {
    const b = '----ff';
    return { headers: { 'content-type': `multipart/form-data; boundary=${b}` }, payload: Buffer.concat([Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${nome}"\r\nContent-Type: ${tipo}\r\n\r\n`), Buffer.from(conteudo), Buffer.from(`\r\n--${b}--\r\n`)]) };
  };

  test('lê XML e PDF, importa sem repetir, resume faturamento e limite do MEI', async () => {
    const { h } = await cadastrar(t.app);
    const e = (await t.app.inject({ method: 'POST', url: '/api/empresas', headers: h, payload: { nome: 'Meu MEI', cnpj: CNPJ_TESTE, regime: 'MEI' } })).json();
    const xml = nfeXml({ emit: MEU, dest: CLIENTE, numero: 15, valor: '1250.50', data: '2026-10-05' });

    const l = await t.app.inject({ method: 'POST', url: `/api/empresas/${e.id}/documentos/ler`, headers: { ...h, ...envio('n.xml', xml).headers }, payload: envio('n.xml', xml).payload });
    assert.equal(l.statusCode, 200); assert.equal(l.json().leitura.tipo, 'nota'); assert.equal(l.json().leitura.nota.direcao, 'emitida');

    const doc = await PDFDocument.create(); const pg = doc.addPage([595, 842]); const f = await doc.embedFont(StandardFonts.Helvetica);
    ['DANFE', 'CHAVE DE ACESSO', chave(CLIENTE, 77), 'DATA DA EMISSAO 02/10/2026', 'VALOR TOTAL DA NOTA 99,90'].forEach((s, i) => pg.drawText(s, { x: 40, y: 800 - i * 18, size: 11, font: f }));
    const p = envio('danfe.pdf', Buffer.from(await doc.save()), 'application/pdf');
    const lp = await t.app.inject({ method: 'POST', url: `/api/empresas/${e.id}/documentos/ler`, headers: { ...h, ...p.headers }, payload: p.payload });
    assert.equal(lp.json().leitura.tipo, 'nota'); assert.equal(lp.json().leitura.nota.valor, 99.9);

    const i1 = await t.app.inject({ method: 'POST', url: `/api/empresas/${e.id}/notas/importar`, headers: { ...h, ...envio('n.xml', xml).headers }, payload: envio('n.xml', xml).payload });
    assert.equal(i1.statusCode, 201); assert.equal(i1.json().repetida, false);
    const i2 = await t.app.inject({ method: 'POST', url: `/api/empresas/${e.id}/notas/importar`, headers: { ...h, ...envio('n.xml', xml).headers }, payload: envio('n.xml', xml).payload });
    assert.equal(i2.json().repetida, true);
    const alheia = nfeXml({ emit: CLIENTE, dest: '99888777000166', numero: 3, valor: '5.00', data: '2026-10-05' });
    assert.equal((await t.app.inject({ method: 'POST', url: `/api/empresas/${e.id}/notas/importar`, headers: { ...h, ...envio('a.xml', alheia).headers }, payload: envio('a.xml', alheia).payload })).statusCode, 422);

    const m = await t.app.inject({ method: 'POST', url: `/api/empresas/${e.id}/notas`, headers: h, payload: { tipo: 'NF-e', dataEmissao: '2026-11-01', direcao: 'recebida', valor: 99.9, contraparteNome: 'Fornecedor' } });
    assert.equal(m.statusCode, 201);

    const r = (await t.app.inject({ method: 'GET', url: `/api/empresas/${e.id}/notas?ano=2026`, headers: h })).json();
    assert.equal(r.notas.length, 2);
    assert.equal(r.resumo.emitidas.total, 1250.5); assert.equal(r.resumo.recebidas.total, 99.9); assert.equal(r.resumo.porMes[9], 1250.5);
    assert.ok(r.mei); assert.equal(r.mei.usado, 1250.5); assert.equal(r.mei.situacao, 'ok');
    assert.equal((await t.app.inject({ method: 'GET', url: `/api/empresas/${e.id}/documentos`, headers: h })).json().length, 1);

    const v = await t.app.inject({ method: 'POST', url: `/api/empresas/${e.id}/notas`, headers: h, payload: { tipo: 'NF-e', dataEmissao: '2026-11-27', direcao: 'emitida', valor: 10000, contraparteNome: 'Cliente', receberEm: '2026-12-03' } });
    assert.equal(v.statusCode, 201); assert.equal(v.json().nota.receberEm, '2026-12-03'); assert.equal(v.json().nota.recebidoEm, null);
    const compra = await t.app.inject({ method: 'POST', url: `/api/empresas/${e.id}/notas`, headers: h, payload: { tipo: 'NF-e', dataEmissao: '2026-11-27', direcao: 'recebida', valor: 5, receberEm: '2026-12-03' } });
    assert.equal(compra.json().nota.receberEm, null);
    const rec = await t.app.inject({ method: 'POST', url: `/api/notas/${v.json().nota.id}/recebido`, headers: h, payload: { data: '2026-01-02' } });
    assert.equal(rec.json().recebidoEm, '2026-01-02');
    const futuro = await t.app.inject({ method: 'POST', url: `/api/notas/${v.json().nota.id}/recebido`, headers: h, payload: { data: '2099-01-01' } });
    assert.equal(futuro.statusCode, 400);
    assert.equal((await t.app.inject({ method: 'POST', url: `/api/notas/${v.json().nota.id}/desfazer-recebimento`, headers: h })).json().recebidoEm, null);
    const outro = await cadastrar(t.app);
    assert.equal((await t.app.inject({ method: 'DELETE', url: `/api/notas/${m.json().nota.id}`, headers: outro.h })).statusCode, 404);
    assert.equal((await t.app.inject({ method: 'DELETE', url: `/api/notas/${m.json().nota.id}`, headers: h })).statusCode, 204);
  });
});
