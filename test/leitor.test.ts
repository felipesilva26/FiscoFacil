import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { lerDocumento } from '../src/services/leitor.js';
import { CNPJ_TESTE, cadastrar, criar } from './helpers.js';

async function pdf(linhas: string[]): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  linhas.forEach((l, i) => page.drawText(l, { x: 40, y: 800 - i * 18, size: 11, font }));
  return Buffer.from(await doc.save());
}
const DAS = ['Documento de Arrecadação do Simples Nacional', 'CNPJ: 66.369.868/0001-71', 'Período de Apuração: 10/2026', 'Data de Vencimento: 20/11/2026', 'Valor Total do Documento: R$ 1.250,00',
  '85800000012 5 50030000000 1 31120261001 7 00000000000 3'];

describe('leitor de documentos (texto)', () => {
  test('guia do Simples', () => {
    const r = lerDocumento(DAS.join('\n'), CNPJ_TESTE);
    assert.equal(r.tipo, 'guia'); assert.equal(r.tributo, 'DAS');
    assert.equal(r.vencimento, '2026-11-20'); assert.equal(r.valor, 1250); assert.equal(r.competencia, '10/2026');
    assert.equal(r.confianca, 'alta'); assert.equal(r.cnpjDocumento, '66.369.868/0001-71'); assert.deepEqual(r.avisos, []);
    assert.ok(r.linhaDigitavel);
  });
  test('DARF e FGTS', () => {
    const d = lerDocumento('Documento de Arrecadação de Receitas Federais\nCódigo da Receita 2089\nData de Vencimento 31/12/2026\nValor Total 5.432,10');
    assert.equal(d.tributo, 'DARF'); assert.equal(d.valor, 5432.1); assert.equal(d.vencimento, '2026-12-31');
    const f = lerDocumento('Guia de Recolhimento do FGTS\nVencimento: 07/11/2026\nValor a pagar R$ 980,00');
    assert.equal(f.tributo, 'FGTS'); assert.equal(f.valor, 980);
  });
  test('certidão com validade e avisos', () => {
    const c = lerDocumento('CERTIDÃO NEGATIVA DE DÉBITOS RELATIVOS AOS TRIBUTOS FEDERAIS\nCNPJ 11.222.333/0001-81\nVálida até 30/04/2027', CNPJ_TESTE);
    assert.equal(c.tipo, 'certidao'); assert.equal(c.validade, '2027-04-30'); assert.equal(c.situacaoCertidao, 'negativa');
    assert.ok(c.avisos.some((a) => a.includes('diferente')));
    const p = lerDocumento('CERTIDÃO POSITIVA DE DÉBITOS\nVálida até 01/01/2027');
    assert.equal(p.situacaoCertidao, 'positiva'); assert.ok(p.avisos.some((a) => a.includes('POSITIVA')));
    assert.equal(lerDocumento('CERTIDÃO POSITIVA COM EFEITOS DE NEGATIVA\nVálida até 01/01/2027').situacaoCertidao, 'positiva_com_efeitos_de_negativa');
  });
  test('comprovante e texto sem sentido', () => {
    const c = lerDocumento('Comprovante de pagamento\nData do pagamento: 18/11/2026\nValor pago: R$ 1.250,00');
    assert.equal(c.tipo, 'comprovante'); assert.equal(c.dataPagamento, '2026-11-18'); assert.equal(c.valor, 1250);
    const x = lerDocumento('Receita da vovó: bolo de cenoura');
    assert.equal(x.tipo, 'desconhecido'); assert.equal(x.confianca, 'baixa');
  });
  test('data inválida não vira vencimento', () => {
    assert.equal(lerDocumento('Documento de Arrecadação do Simples Nacional\nData de Vencimento: 31/02/2026\nValor Total: 10,00').vencimento, null);
  });
});

describe('leitura de PDF pela API', () => {
  let t: Awaited<ReturnType<typeof criar>>;
  before(async () => { t = await criar(); });
  after(async () => { await t.fechar(); });
  const envio = (nome: string, conteudo: Buffer) => {
    const b = '----ff';
    return { headers: { 'content-type': `multipart/form-data; boundary=${b}` }, payload: Buffer.concat([Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${nome}"\r\nContent-Type: application/pdf\r\n\r\n`), conteudo, Buffer.from(`\r\n--${b}--\r\n`)]) };
  };
  test('lê guia, detecta duplicada, sugere guia do comprovante, e não salva nada', async () => {
    const { h } = await cadastrar(t.app);
    const e = (await t.app.inject({ method: 'POST', url: '/api/empresas', headers: h, payload: { nome: 'Leitura', cnpj: CNPJ_TESTE } })).json();
    const m = envio('das.pdf', await pdf(DAS));
    const r = await t.app.inject({ method: 'POST', url: `/api/empresas/${e.id}/documentos/ler`, headers: { ...h, ...m.headers }, payload: m.payload });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().leitura.tributo, 'DAS'); assert.equal(r.json().leitura.valor, 1250); assert.equal(r.json().duplicada, false);
    assert.equal((await t.app.inject({ method: 'GET', url: `/api/empresas/${e.id}/documentos`, headers: h })).json().length, 0);
    await t.app.inject({ method: 'POST', url: `/api/empresas/${e.id}/obrigacoes`, headers: h, payload: { tributo: 'DAS', venc: '2026-11-20', valor: 1250 } });
    const r2 = await t.app.inject({ method: 'POST', url: `/api/empresas/${e.id}/documentos/ler`, headers: { ...h, ...m.headers }, payload: m.payload });
    assert.equal(r2.json().duplicada, true);
    const comp = envio('c.pdf', await pdf(['Comprovante de pagamento', 'Data do pagamento: 18/11/2026', 'Valor pago: R$ 1.250,00']));
    const r3 = await t.app.inject({ method: 'POST', url: `/api/empresas/${e.id}/documentos/ler`, headers: { ...h, ...comp.headers }, payload: comp.payload });
    assert.equal(r3.json().candidatos.length, 1);
  });
  test('recusa não-PDF, PDF sem texto e outro usuário', async () => {
    const a = await cadastrar(t.app); const b = await cadastrar(t.app);
    const e = (await t.app.inject({ method: 'POST', url: '/api/empresas', headers: a.h, payload: { nome: 'Empresa X', cnpj: CNPJ_TESTE } })).json();
    const naoPdf = envio('a.pdf', Buffer.from('nao sou pdf'));
    assert.equal((await t.app.inject({ method: 'POST', url: `/api/empresas/${e.id}/documentos/ler`, headers: { ...a.h, ...naoPdf.headers }, payload: naoPdf.payload })).statusCode, 415);
    const vazio = envio('v.pdf', await pdf([]));
    assert.equal((await t.app.inject({ method: 'POST', url: `/api/empresas/${e.id}/documentos/ler`, headers: { ...a.h, ...vazio.headers }, payload: vazio.payload })).statusCode, 422);
    const ok = envio('d.pdf', await pdf(DAS));
    assert.equal((await t.app.inject({ method: 'POST', url: `/api/empresas/${e.id}/documentos/ler`, headers: { ...b.h, ...ok.headers }, payload: ok.payload })).statusCode, 404);
  });
});

test('guia com carimbo "PAGO DIA" vem com a data do pagamento', () => {
  const t = 'Documento de Arrecadação do Simples Nacional\nCNPJ 16.749.358/0001-51\nPeríodo de Apuração outubro/2026\nData de Vencimento 23/11/2026\nPAGO DIA 16/11/2026\nValor Total do Documento 3.404,93';
  const l = lerDocumento(t, '16749358000151');
  assert.equal(l.tipo, 'guia'); assert.equal(l.valor, 3404.93); assert.equal(l.vencimento, '2026-11-23'); assert.equal(l.dataPagamento, '2026-11-16');
});
