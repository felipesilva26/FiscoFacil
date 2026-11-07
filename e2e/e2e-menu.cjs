const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch(); const errs = []; const ok = (c, m) => { console.log((c ? 'OK   ' : 'FALHA') + ' ' + m); if (!c) process.exitCode = 1; };
  for (const [nome, w, h, mob] of [['d', 1280, 900, false], ['t', 768, 1024, true], ['m', 390, 844, true]]) {
    const ctx = await b.newContext({ viewport: { width: w, height: h }, isMobile: mob && w < 500, hasTouch: mob }); const p = await ctx.newPage(); p.on('pageerror', e => errs.push(nome + ': ' + e.message));
    await p.goto('http://localhost:3111/'); await p.waitForSelector('#formAnonimo', { timeout: 15000 }); await p.check('#aaceite'); await p.click('#formAnonimo button[type=submit]'); await p.waitForSelector('#formOnbCnpj', { timeout: 15000 });
    await p.fill('#ocnpj', '11222333000181'); await p.click('#formOnbCnpj button[type=submit]'); await p.waitForSelector('#formOnbConfirmar'); await p.click('#formOnbConfirmar button[type=submit]');
    await p.waitForFunction(() => document.querySelector('#main').textContent.includes('Conferido automaticamente'), null, { timeout: 15000 });
    const t = await p.textContent('#main');
    ok(t.includes('Situação da empresa') && t.includes('Total pendente') && t.includes('DAS-MEI'), nome + ': Início = situação + números');
    const nav = nome === 'm' ? await p.$$eval('#tabbar a', as => as.map(a => a.textContent.trim())) : await p.$$eval('.nav a', as => as.map(a => (a.getAttribute('title') || a.textContent).trim()));
    ok(nav.length === 5, nome + ': 5 itens no menu: ' + nav.join(', '));
    ok(!(await p.isVisible('.sidestatus')) && !(await p.isVisible('.topbar .search')), nome + ': sem caixa de status lateral nem busca');
    await p.screenshot({ path: `/tmp/e2e/enx-${nome}-inicio.png` });
    await p.goto('http://localhost:3111/#guias'); await p.waitForTimeout(400);
    ok(!!(await p.$('.seg')), nome + ': Guias tem seletor Lista/Calendário');
    await p.click('.seg [data-v="cal"]'); await p.waitForTimeout(300);
    ok((await p.textContent('#main')).includes('Calendário'), nome + ': calendário dentro de Guias');
    await p.screenshot({ path: `/tmp/e2e/enx-${nome}-guias.png` });
    await p.goto('http://localhost:3111/#situacao'); await p.waitForTimeout(400);
    ok((await p.textContent('#main')).includes('Situação da empresa'), nome + ': link antigo #situacao abre o Início');
    await p.goto('http://localhost:3111/#configuracoes'); await p.waitForTimeout(400);
    const c = await p.textContent('#main');
    ok(!c.includes('Integração com a Receita Federal') && !c.includes('Perfil'), nome + ': Configurações sem seções repetidas');
    const over = await p.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    ok(!over, nome + ': sem rolagem lateral');
    await ctx.close();
  }
  console.log('erros de página:', errs.length ? errs : 'nenhum'); await b.close();
})().catch(e => { console.error('ERRO', e.message); process.exit(1); });
