const { chromium } = require('playwright');
const fs = require('fs');
(async () => {
  const b = await chromium.launch(); const ok = (c, m) => { console.log((c ? 'OK   ' : 'FALHA') + ' ' + m); if (!c) process.exitCode = 1; };
  for (const [nm, w, h] of [['d', 1280, 900], ['t', 820, 1180], ['m', 390, 844]]) {
    const ctx = await b.newContext({ viewport: { width: w, height: h }, acceptDownloads: true }); const p = await ctx.newPage();
    const errs = []; p.on('pageerror', e => errs.push(e.message)); p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
    await p.goto('http://localhost:3111/'); await p.waitForSelector('#formAnonimo', { timeout: 15000 });
    await p.click('#formAnonimo button[type=submit]'); await p.waitForTimeout(300);
    ok(!!(await p.$('#formAnonimo')) && !(await p.$('#formOnbCnpj')), nm + ': sem aceitar a política não entra');
    await p.check('#aaceite'); await p.click('#formAnonimo button[type=submit]');
    await p.waitForSelector('#formOnbCnpj'); await p.fill('#ocnpj', '11222333000181'); await p.click('#formOnbCnpj button[type=submit]'); await p.waitForSelector('#formOnbConfirmar'); await p.click('#formOnbConfirmar button[type=submit]');
    await p.waitForFunction(() => document.querySelector('#main') && document.querySelector('#main').textContent.includes('Faturamento e impostos'), null, { timeout: 15000 });
    ok(true, nm + ': Início tem Faturamento e impostos');
    await p.click('[data-action="venda-sem-nota"]'); await p.fill('#svalor', '2.500,00'); await p.click('#formSemNota button[type=submit]');
    await p.waitForFunction(() => (document.querySelector('.dinheiro .kval.big') || {textContent:''}).textContent.includes('2.500,00'), null, { timeout: 10000 });
    ok((await p.textContent('.dinheiro')).includes('sem nota'), nm + ': venda sem nota entra no faturamento');
    await p.screenshot({ path: `/tmp/e2e/aud-${nm}-inicio.png`, fullPage: true });
    await p.goto('http://localhost:3111/#configuracoes'); await p.waitForTimeout(500);
    const c = await p.textContent('#main');
    ok(c.includes('Conta e privacidade') && c.includes('Proteja sua conta'), nm + ': Configurações tem conta e privacidade');
    const [dl] = await Promise.all([p.waitForEvent('download'), p.click('[data-action="baixar-dados"]')]);
    const j = JSON.parse(fs.readFileSync(await dl.path(), 'utf8'));
    ok(j.empresas.length === 1 && j.notasFiscais.length === 1, nm + ': baixar meus dados traz empresa e faturamento');
    await p.screenshot({ path: `/tmp/e2e/aud-${nm}-config.png`, fullPage: true });
    if (nm === 'd') {
      await p.fill('#pnomeC', 'Richard'); await p.fill('#pemailC', 'r' + Date.now() + '@teste.com'); await p.fill('#psenhaC', 'senha-forte-123'); await p.click('#formProteger button[type=submit]');
      await p.waitForFunction(() => document.querySelector('#main').textContent.includes('Conectado como'), null, { timeout: 8000 });
      ok(true, 'conta sem cadastro virou conta com e-mail');
      await p.click('[data-action="excluir-conta"]'); await p.fill('#xconf', 'EXCLUIR'); await p.click('#formExcluirConta button[type=submit]');
      await p.waitForSelector('#formAnonimo', { timeout: 8000 }); ok(true, 'excluir conta volta para a tela inicial');
      const pr = await (await ctx.newPage()).goto('http://localhost:3111/privacidade.html'); ok(pr.status() === 200, 'página de privacidade abre');
    }
    ok(!(await p.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)), nm + ': sem rolagem lateral');
    ok(errs.length === 0, nm + ': sem erros no console' + (errs.length ? ': ' + errs.slice(0, 3).join(' | ') : ''));
    await ctx.close();
  }
  await b.close();
})().catch(e => { console.error('ERRO', e.message); process.exit(1); });
