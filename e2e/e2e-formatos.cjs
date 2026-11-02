const { chromium } = require('playwright');
const OUT = '/tmp/e2e/resp'; require('fs').mkdirSync(OUT, { recursive: true });
const VPS = [['celular', 390, 844, true], ['tablet-retrato', 768, 1024, true], ['tablet-paisagem', 1024, 768, true], ['notebook', 1280, 800, false], ['desktop', 1440, 900, false]];
const PAGES = ['inicio', 'situacao', 'guias', 'calendario', 'documentos', 'empresas', 'configuracoes', 'integracoes', 'relatorios', 'assistente'];
(async () => {
  const b = await chromium.launch(); const errs = []; const probs = [];
  const ok = (c, m) => { console.log((c ? 'OK   ' : 'FALHA') + ' ' + m); if (!c) process.exitCode = 1; };
  // 1) onboarding no celular: só CNPJ
  const ctx0 = await b.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }); const p = await ctx0.newPage(); p.on('pageerror', e => errs.push(e.message));
  await p.goto('http://localhost:3111/'); await p.screenshot({ path: OUT + '/celular-login.png' });
  await p.click('[data-action="auth-troca"]'); await p.fill('#anome', 'Dono'); await p.fill('#aemail', 'resp' + Date.now() + '@fiscofacil.com'); await p.fill('#asenha', 'senha-forte-123'); await p.click('#formCadastro button[type=submit]');
  await p.waitForSelector('#formOnbCnpj'); await p.screenshot({ path: OUT + '/celular-onb1.png' });
  await p.fill('#ocnpj', '66369868000172'); await p.click('#formOnbCnpj button[type=submit]'); await p.waitForTimeout(300);
  ok((await p.textContent('#ferr')).includes('CNPJ inválido'), 'CNPJ errado é recusado na hora');
  await p.fill('#ocnpj', '66369868000171'); await p.click('#formOnbCnpj button[type=submit]'); await p.waitForSelector('#formOnbConfirmar');
  ok((await p.inputValue('#onome')).includes('EMPRESA DE TESTE') && (await p.inputValue('#oreg')) === 'Simples Nacional', 'nome e regime preenchidos pela Receita');
  await p.screenshot({ path: OUT + '/celular-onb2.png' });
  await p.click('#formOnbConfirmar button[type=submit]'); await p.waitForFunction(() => document.querySelector('#auth').hidden);
  await p.waitForFunction(() => document.querySelector('#main').textContent.includes('O que foi conferido'), null, { timeout: 15000 });
  ok(p.url().endsWith('#situacao'), 'vai direto para a Situação fiscal');
  // segunda empresa pelo modal, CNPJ desconhecido na base -> preenche manual
  await p.goto('http://localhost:3111/#empresas'); await p.waitForTimeout(300); await p.click('[data-action="novaemp"]');
  await p.waitForSelector('#formOnbCnpj'); await p.fill('#ocnpj', '11222333000181'); await p.click('#formOnbCnpj button[type=submit]'); await p.waitForSelector('#formOnbConfirmar');
  ok((await p.inputValue('#oreg')) === 'MEI', 'MEI detectado');
  await p.click('#formOnbConfirmar button[type=submit]'); await p.waitForFunction(() => location.hash === '#situacao' && document.querySelector('#main').textContent.includes('COMERCIO EXEMPLO'), null, { timeout: 15000 });
  ok(true, 'segunda empresa adicionada pelo mesmo fluxo');
  const tk = await p.evaluate(() => localStorage.getItem('fiscofacil-token'));
  await ctx0.close();
  // dados para as telas
  const H = { authorization: 'Bearer ' + tk, 'content-type': 'application/json' };
  const emps = await (await fetch('http://localhost:3111/api/empresas', { headers: H })).json();
  const d = n => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
  for (const [t, n, v] of [['DAS', 3, 1250], ['FGTS', 6, 980], ['ISS', -4, 410], ['DARF', 14, 7820.55], ['INSS', 21, 5400]]) await fetch(`http://localhost:3111/api/empresas/${emps[0].id}/obrigacoes`, { method: 'POST', headers: H, body: JSON.stringify({ tributo: t, venc: d(n), valor: v }) });
  // 2) matriz de telas
  for (const [nome, w, h, touch] of VPS) {
    const ctx = await b.newContext({ viewport: { width: w, height: h }, hasTouch: touch, isMobile: nome === 'celular' }); const q = await ctx.newPage(); q.on('pageerror', e => errs.push(nome + ': ' + e.message));
    await q.goto('http://localhost:3111/'); await q.evaluate(t => localStorage.setItem('fiscofacil-token', t), tk); await q.goto('http://localhost:3111/?r=1#inicio');
    await q.waitForFunction(() => (!document.querySelector('#auth') || document.querySelector('#auth').hidden) && document.querySelector('#main').textContent.length > 50, null, { timeout: 15000 });
    for (const pg of PAGES) {
      await q.goto('http://localhost:3111/#' + pg); await q.waitForTimeout(pg === 'situacao' ? 1200 : 350);
      const r = await q.evaluate(() => {
        const W = document.documentElement.clientWidth, over = [];
        document.querySelectorAll('#main *, #top *').forEach(el => { const b = el.getBoundingClientRect(); if (b.width && b.right > W + 1 && getComputedStyle(el).position !== 'fixed') over.push((el.id ? '#' + el.id : el.tagName.toLowerCase() + '.' + [...el.classList].join('.')) + ' ' + Math.round(b.right)); });
        const small = []; document.querySelectorAll('#main button, #main a, #main select, #main input, #top button, #top a, #tabbar a, #tabbar button').forEach(el => { const b = el.getBoundingClientRect(); if (b.width && b.height && (b.height < 36 || b.width < 36) && getComputedStyle(el).visibility !== 'hidden') small.push((el.textContent || el.getAttribute('aria-label') || el.tagName).trim().slice(0, 24) + ' ' + Math.round(b.width) + 'x' + Math.round(b.height)); });
        return { scroll: document.documentElement.scrollWidth > W, over: over.slice(0, 4), small: [...new Set(small)].slice(0, 6), side: getComputedStyle(document.querySelector('.side')).display, tab: getComputedStyle(document.querySelector('.tabbar')).display };
      });
      if (r.scroll || r.over.length) probs.push(`${nome}/${pg}: transborda ${r.over.join(', ')}`);
      if (touch && r.small.length) probs.push(`${nome}/${pg}: alvos pequenos ${r.small.join(' | ')}`);
      if (pg === 'inicio') console.log(`${nome}: menu lateral=${r.side} barra inferior=${r.tab}`);
      await q.screenshot({ path: `${OUT}/${nome}-${pg}.png` });
    }
    await ctx.close();
  }
  console.log('PROBLEMAS:\n' + (probs.join('\n') || 'nenhum'));
  console.log('erros de página:', errs.length ? errs : 'nenhum'); await b.close();
})().catch(e => { console.error('ERRO', e.message); process.exit(1); });
