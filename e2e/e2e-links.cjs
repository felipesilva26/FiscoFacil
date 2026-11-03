const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch(); const errs = []; const ok = (c, m) => { console.log((c ? 'OK   ' : 'FALHA') + ' ' + m); if (!c) process.exitCode = 1; };
  for (const [nome, w, h, mob] of [['m', 390, 844, true], ['d', 1280, 900, false]]) {
    const ctx = await b.newContext({ viewport: { width: w, height: h }, isMobile: mob, hasTouch: mob, permissions: ['clipboard-read', 'clipboard-write'] }); const p = await ctx.newPage(); p.on('pageerror', e => errs.push(e.message));
    await p.goto('http://localhost:3111/'); await p.waitForSelector('#formOnbCnpj', { timeout: 15000 });
    await p.fill('#ocnpj', '11222333000181'); await p.click('#formOnbCnpj button[type=submit]'); await p.waitForSelector('#formOnbConfirmar'); await p.click('#formOnbConfirmar button[type=submit]');
    await p.waitForFunction(() => document.querySelector('#main').textContent.includes('Atalhos oficiais'), null, { timeout: 15000 });
    const links = await p.$$eval('#main a[target=_blank]', as => as.map(a => a.href));
    const hosts = [...new Set(links.map(u => new URL(u).host))];
    console.log(nome, 'hosts:', hosts.join(' '));
    ok(['solucoes.receita.fazenda.gov.br', 'www.regularize.pgfn.gov.br', 'www8.receita.fazenda.gov.br', 'cav.receita.fazenda.gov.br', 'servicos.receitafederal.gov.br', 'consultacrf.caixa.gov.br', 'cndt-certidao.tst.jus.br'].every(x => hosts.includes(x)), nome + ': todos os sites oficiais têm botão');
    ok(links.every(u => u.startsWith('https://')), nome + ': todos em https');
    const porBloco = await p.$$eval('.sitrow', rs => rs.map(r => r.querySelector('b').textContent + ' => ' + [...r.querySelectorAll('.sitlinks .btn')].map(x => x.textContent).join(' | ')));
    if (nome === 'd') console.log(porBloco.join('\n'));
    ok(porBloco.every(t => !t.endsWith('=> ')), nome + ': cada bloco tem pelo menos um botão');
    await p.click('[data-action="copiar-cnpj"]'); await p.waitForTimeout(300);
    ok((await p.evaluate(() => navigator.clipboard.readText())) === '11.222.333/0001-81', nome + ': copiar CNPJ funciona');
    await p.screenshot({ path: `/tmp/e2e/links-${nome}.png`, fullPage: true });
    await ctx.close();
  }
  console.log('erros de página:', errs.length ? errs : 'nenhum'); await b.close();
})().catch(e => { console.error('ERRO', e.message); process.exit(1); });
