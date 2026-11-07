const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch(); const errs = []; const ok = (c, m) => { console.log((c ? 'OK   ' : 'FALHA') + ' ' + m); if (!c) process.exitCode = 1; };
  const casos = [['mei', '11222333000181'], ['simples', '66369868000171'], ['lucro', '00000000000191']];
  for (const [nome, cnpj] of casos) {
    const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }); const p = await ctx.newPage(); p.on('pageerror', e => errs.push(e.message));
    await p.goto('http://localhost:3111/'); await p.waitForSelector('#formOnbCnpj', { timeout: 15000 });
    await p.fill('#ocnpj', cnpj); await p.click('#formOnbCnpj button[type=submit]'); await p.waitForSelector('#formOnbConfirmar');
    const t = await p.textContent('#formOnbConfirmar');
    if (nome === 'mei') {
      ok(t.includes('MEI desde') && t.includes('Identificado na Receita') && !(await p.$('select#oreg')), 'MEI reconhecido, sem lista para escolher');
      ok((await p.inputValue('#onome')) === 'COMERCIO EXEMPLO (FICTICIA)', 'nome sem o número do CNPJ na frente');
      ok(t.includes('Empresário (Individual)'), 'mostra o tipo de empresa');
    }
    if (nome === 'simples') ok(t.includes('Simples Nacional desde 10/03/2019') && t.includes('Identificado na Receita'), 'Simples reconhecido com a data');
    if (nome === 'lucro') {
      ok(t.includes('não é MEI nem Simples') && (await p.$$('input[name="oregr"]')).length === 2, 'fora do Simples: só Presumido ou Real');
      await p.click('#formOnbConfirmar button[type=submit]'); await p.waitForTimeout(300);
      ok((await p.textContent('#ferr')).includes('Escolha se a empresa'), 'obriga escolher entre Presumido e Real');
      await p.click('label.regopt:has-text("Lucro Real")');
    }
    await p.screenshot({ path: `/tmp/e2e/regime-${nome}.png`, fullPage: true });
    await p.click('#formOnbConfirmar button[type=submit]');
    await p.waitForFunction(() => document.querySelector('#main') && document.querySelector('#main').textContent.includes('O que foi conferido'), null, { timeout: 15000 });
    const reg = await p.evaluate(async () => { const t = localStorage.getItem('fiscofacil-token'); const r = await fetch('/api/empresas', { headers: { authorization: 'Bearer ' + t } }); return (await r.json())[0].regime; });
    ok(reg === { mei: 'MEI', simples: 'Simples Nacional', lucro: 'Lucro Real' }[nome], nome + ': regime salvo = ' + reg);
    await ctx.close();
  }
  // trocar regime manualmente quando identificado
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } }); const p = await ctx.newPage();
  await p.goto('http://localhost:3111/'); await p.waitForSelector('#formOnbCnpj'); await p.fill('#ocnpj', '11222333000181'); await p.click('#formOnbCnpj button[type=submit]'); await p.waitForSelector('#formOnbConfirmar');
  await p.click('[data-action="onb-trocar-regime"]'); ok(!!(await p.$('select#oreg')), '"Não está certo? Alterar" abre a lista');
  await p.screenshot({ path: '/tmp/e2e/regime-desktop.png' });
  console.log('erros de página:', errs.length ? errs : 'nenhum'); await b.close();
})().catch(e => { console.error('ERRO', e.message); process.exit(1); });
