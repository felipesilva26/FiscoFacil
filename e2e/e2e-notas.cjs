const { chromium } = require('playwright');
const { PDFDocument, StandardFonts } = require('/home/claude/fiscofacil-api/node_modules/pdf-lib');
const fs = require('fs');
const MEI = '11222333000181', CLI = '66369868000171';
function chave(emit, n) { const b = '352610' + emit + '55001' + String(n).padStart(9, '0') + '112345678'; let s = 0, p = 2; for (let i = b.length - 1; i >= 0; i--) { s += +b[i] * p; p = p === 9 ? 2 : p + 1; } const r = s % 11; return b + (r < 2 ? 0 : 11 - r); }
const xml = (emit, dest, n, v, d) => `<?xml version="1.0"?><nfeProc xmlns="http://www.portalfiscal.inf.br/nfe"><NFe><infNFe Id="NFe${chave(emit, n)}"><ide><natOp>Venda</natOp><mod>55</mod><serie>1</serie><nNF>${n}</nNF><dhEmi>${d}T10:00:00-03:00</dhEmi></ide><emit><CNPJ>${emit}</CNPJ><xNome>COMERCIO EXEMPLO (FICTICIA)</xNome></emit><dest><CNPJ>${dest}</CNPJ><xNome>CLIENTE FICTICIO LTDA</xNome></dest><total><ICMSTot><vNF>${v}</vNF></ICMSTot></total></infNFe></NFe></nfeProc>`;
(async () => {
  const hoje = new Date().toISOString().slice(0, 10);
  fs.writeFileSync('/tmp/e2e/venda1.xml', xml(MEI, CLI, 101, '1500.00', hoje));
  fs.writeFileSync('/tmp/e2e/venda2.xml', xml(MEI, CLI, 102, '2300.40', hoje));
  const d = await PDFDocument.create(); const pg = d.addPage([595, 842]); const f = await d.embedFont(StandardFonts.Helvetica);
  ['DANFE', 'DOCUMENTO AUXILIAR DA NOTA FISCAL ELETRONICA', 'CHAVE DE ACESSO', chave(CLI, 555).match(/.{4}/g).join(' '), 'DESTINATARIO 11.222.333/0001-81', 'DATA DA EMISSAO ' + new Date().toLocaleDateString('pt-BR'), 'VALOR TOTAL DA NOTA 480,00'].forEach((l, i) => pg.drawText(l, { x: 40, y: 800 - i * 18, size: 11, font: f }));
  fs.writeFileSync('/tmp/e2e/danfe-compra.pdf', await d.save());
  const b = await chromium.launch(); const errs = []; const ok = (c, m) => { console.log((c ? 'OK   ' : 'FALHA') + ' ' + m); if (!c) process.exitCode = 1; };
  const p = await b.newPage({ viewport: { width: 1280, height: 1000 } }); p.on('pageerror', e => errs.push(e.message));
  await p.goto('http://localhost:3111/'); await p.waitForSelector('#formOnbCnpj', { timeout: 15000 });
  await p.fill('#ocnpj', MEI); await p.click('#formOnbCnpj button[type=submit]'); await p.waitForSelector('#formOnbConfirmar'); await p.click('#formOnbConfirmar button[type=submit]');
  await p.waitForFunction(() => document.querySelector('#main').textContent.includes('Conferido automaticamente'), null, { timeout: 15000 });
  await p.goto('http://localhost:3111/#documentos'); await p.waitForTimeout(500);
  ok((await p.textContent('#main')).includes('Notas fiscais'), 'Documentos tem a seção Notas fiscais');
  await p.setInputFiles('#fileDoc', ['/tmp/e2e/venda1.xml', '/tmp/e2e/venda2.xml']);
  await p.waitForFunction(() => document.querySelector('#main').textContent.includes('3.800,40'), null, { timeout: 10000 });
  ok(true, 'dois XML importados: vendas somam R$ 3.800,40');
  await p.setInputFiles('#fileDoc', ['/tmp/e2e/venda1.xml']); await p.waitForTimeout(1500);
  ok((await p.textContent('body')).includes('já estava no sistema'), 'XML repetido não conta duas vezes');
  await p.setInputFiles('#fileDoc', '/tmp/e2e/danfe-compra.pdf'); await p.waitForSelector('#formLer[data-k="nota"]', { timeout: 10000 });
  ok((await p.inputValue('#nfvalor')) === '480,00' && (await p.inputValue('#ndir')) === 'recebida', 'PDF de DANFE lido como compra de R$ 480,00');
  await p.screenshot({ path: '/tmp/e2e/notas-modal.png' });
  await p.click('#formLer button[type=submit]'); await p.waitForFunction(() => !document.querySelector('#formLer'), null, { timeout: 10000 }); await p.waitForTimeout(500);
  const t = await p.textContent('#main');
  ok(t.includes('480,00') && t.includes('Faturamento do MEI'), 'compra registrada e barra do limite do MEI aparece');
  await p.screenshot({ path: '/tmp/e2e/notas-docs.png', fullPage: true });
  await p.goto('http://localhost:3111/#inicio'); await p.waitForTimeout(800);
  ok((await p.textContent('#main')).includes('Faturamento do MEI'), 'Início mostra o faturamento do MEI contra o limite');
  for (const [w, h, nm] of [[390, 844, 'm'], [768, 1024, 't']]) {
    await p.setViewportSize({ width: w, height: h }); await p.goto('http://localhost:3111/#documentos'); await p.waitForTimeout(500);
    ok(!(await p.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)), nm + ': sem rolagem lateral');
    await p.screenshot({ path: `/tmp/e2e/notas-${nm}.png`, fullPage: true });
  }
  console.log('erros de página:', errs.length ? errs : 'nenhum'); await b.close();
})().catch(e => { console.error('ERRO', e.message); process.exit(1); });
