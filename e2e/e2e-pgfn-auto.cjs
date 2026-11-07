const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch(); const errs = []; const ok = (c, m) => { console.log((c ? 'OK   ' : 'FALHA') + ' ' + m); if (!c) process.exitCode = 1; };
  const p = await (await b.newContext({ viewport: { width: 1280, height: 900 } })).newPage(); p.on('pageerror', e => errs.push(e.message));
  await p.goto('http://localhost:3111/'); await p.waitForSelector('#formOnbCnpj', { timeout: 15000 });
  await p.fill('#ocnpj', '11222333000181'); await p.click('#formOnbCnpj button[type=submit]'); await p.waitForSelector('#formOnbConfirmar'); await p.click('#formOnbConfirmar button[type=submit]');
  await p.waitForFunction(() => document.querySelector('#main').textContent.includes('Conferido automaticamente'), null, { timeout: 15000 });
  const t0 = await p.textContent('#main');
  ok(t0.includes('Precisa da conexão com a Receita') && t0.includes('Informado por você'), 'blocos separados em grupos');
  ok(t0.includes('Na fila') || t0.includes('Conferindo agora'), 'dívida ativa já começa a ser conferida sozinha');
  const t = Date.now();
  await p.waitForFunction(() => document.querySelector('#main').textContent.includes('inscrição em dívida ativa'), null, { timeout: 90000 });
  ok(true, `dívida ativa conferida sozinha em ${Math.round((Date.now() - t) / 1000)}s, sem recarregar a página`);
  await p.screenshot({ path: '/tmp/e2e/pgfnauto.png', fullPage: true });
  console.log('erros de página:', errs.length ? errs : 'nenhum'); await b.close();
})().catch(e => { console.error('ERRO', e.message); process.exit(1); });
