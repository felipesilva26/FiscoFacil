import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { CNPJ_TESTE, cadastrar, criar } from './helpers.js';

describe('planilha completa', () => {
  let t: Awaited<ReturnType<typeof criar>>;
  before(async () => { t = await criar(); });
  after(async () => { await t.fechar(); });

  test('gera xlsx com uma aba por empresa, lançamentos com lista e gráficos; isola usuários', async () => {
    const { h } = await cadastrar(t.app);
    const e = (await t.app.inject({ method: 'POST', url: '/api/empresas', headers: h, payload: { nome: 'Empresa Um', cnpj: CNPJ_TESTE } })).json();
    await t.app.inject({ method: 'POST', url: `/api/empresas/${e.id}/obrigacoes`, headers: h, payload: { tributo: 'DAS', venc: '2026-12-20', valor: 500 } });
    const r = await t.app.inject({ method: 'GET', url: '/api/exportar/planilha', headers: h });
    assert.equal(r.statusCode, 200);
    assert.match(String(r.headers['content-type']), /spreadsheetml/);
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(r.rawPayload as never);
    const nomes = wb.worksheets.map((w) => w.name);
    assert.ok(nomes.includes('Resumo') && nomes.includes('Lançamentos') && nomes.some((n) => n.startsWith('Painel')));
    const l = wb.getWorksheet('Lançamentos')!;
    assert.equal(l.getCell('C5').value, 'DAS'); assert.equal(l.getCell('F5').value, 'Em aberto');
    assert.equal(l.getCell('F5').dataValidation?.type, 'list');
    const zip = await JSZip.loadAsync(r.rawPayload);
    assert.ok(zip.file('xl/charts/chart1.xml') && zip.file('xl/charts/chart2.xml'));
    const outro = await cadastrar(t.app);
    const r2 = await t.app.inject({ method: 'GET', url: '/api/exportar/planilha', headers: outro.h });
    const wb2 = new ExcelJS.Workbook(); await wb2.xlsx.load(r2.rawPayload as never);
    assert.equal(wb2.getWorksheet('Lançamentos')!.getCell('C5').value === 'DAS', false);
  });
});
