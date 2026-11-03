const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch(); const errs = []; const ok = (c, m) => { console.log((c ? 'OK   ' : 'FALHA') + ' ' + m); if (!c) process.exitCode = 1; };
  for (const [nome, vp] of [['m', { width: 390, height: 844, isMobile: true, hasTouch: true }], ['d', { width: 1280, height: 900 }]]) {
    const ctx = await b.newContext({ viewport: { width: vp.width, height: vp.height }, isMobile: !!vp.isMobile, hasTouch: !!vp.hasTouch }); const p = await ctx.newPage(); p.on('pageerror', e => errs.push(e.message));
    await p.goto('http://localhost:3111/'); await p.waitForSelector('#formOnbCnpj', { timeout: 15000 });
    await p.fill('#ocnpj', '11222333000181'); await p.click('#formOnbCnpj button[type=submit]'); await p.waitForSelector('#formOnbConfirmar');
    await p.click('#formOnbConfirmar button[type=submit]');
    await p.waitForFunction(() => document.querySelector('#main').textContent.includes('DAS-MEI mês a mês'), null, { timeout: 15000 });
    let t = await p.textContent('#main');
    ok(!t.includes('Tudo em dia') && t.includes('Ainda não dá para dizer'), nome + ': não afirma que está em dia sem saber');
    await p.click('[data-action="das-mei"][data-c="2026-09"][data-s="nao_pago"]').catch(async () => { const c = await p.$$eval('[data-action="das-mei"]', els => els.map(e => e.dataset.c + ':' + e.dataset.s)); console.log('botoes', c); throw new Error('sem botao'); });
    await p.waitForFunction(() => document.querySelector('#main').textContent.includes('Não pago, atrasado'), null, { timeout: 10000 });
    t = await p.textContent('#main');
    ok(t.includes('ponto de atenção') || t.includes('pontos de atenção'), nome + ': "Não paguei" vira pendência no veredito');
    await p.screenshot({ path: `/tmp/e2e/mei-${nome}.png`, fullPage: nome === 'd' });
    await p.goto('http://localhost:3111/#guias'); await p.waitForTimeout(400);
    ok((await p.textContent('#main')).includes('86,05') || (await p.textContent('#main')).includes('82,05'), nome + ': guia do DAS aparece em Guias com o valor da tabela');
    await ctx.close();
  }
  console.log('erros de página:', errs.length ? errs : 'nenhum'); await b.close();
})().catch(e => { console.error('ERRO', e.message); process.exit(1); });
