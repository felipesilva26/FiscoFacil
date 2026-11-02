const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch(); const errs = []; const ok = (c, m) => { console.log((c ? 'OK   ' : 'FALHA') + ' ' + m); if (!c) process.exitCode = 1; };
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }); const p = await ctx.newPage(); p.on('pageerror', e => errs.push(e.message));
  await p.goto('http://localhost:3111/');
  await p.waitForSelector('#formOnbCnpj', { timeout: 15000 });
  ok(!(await p.$('#formLogin')), 'abre direto no CNPJ, sem login');
  await p.fill('#ocnpj', '66369868000171'); await p.click('#formOnbCnpj button[type=submit]'); await p.waitForSelector('#formOnbConfirmar');
  ok((await p.textContent('.onbcard')).includes('Desenvolvimento de programas'), 'mostra o que a empresa faz');
  await p.screenshot({ path: '/tmp/e2e/semlogin-confirmar.png' });
  await p.click('#formOnbConfirmar button[type=submit]');
  await p.waitForFunction(() => document.querySelector('#main').textContent.includes('O que foi conferido'), null, { timeout: 15000 });
  ok(true, 'confirmou e abriu a Situação fiscal');
  await p.reload(); await p.waitForFunction(() => document.querySelector('#main') && document.querySelector('#main').textContent.length > 50, null, { timeout: 15000 });
  ok(!(await p.$('#formOnbCnpj')) || (await p.$eval('#auth', el => el.hidden).catch(() => true)), 'ao recarregar continua com a empresa');
  const p2 = await (await b.newContext()).newPage(); await p2.goto('http://localhost:3111/'); await p2.waitForSelector('#formOnbCnpj', { timeout: 15000 });
  ok(true, 'outro navegador começa zerado (não vê a empresa do primeiro)');
  console.log('erros de página:', errs.length ? errs : 'nenhum'); await b.close();
})().catch(e => { console.error('ERRO', e.message); process.exit(1); });
