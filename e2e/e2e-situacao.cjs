const { chromium } = require('playwright');
const fase = process.argv[2]; const fs = require('fs');
const EMAIL = fase === '1' ? 'sit' + Date.now() + '@fiscofacil.com' : fs.readFileSync('/tmp/e2e/sit-email.txt', 'utf8');
if (fase === '1') fs.writeFileSync('/tmp/e2e/sit-email.txt', EMAIL);
(async () => {
  const b = await chromium.launch(); const errs = [];
  const ok = (c, m) => { console.log((c ? 'OK   ' : 'FALHA') + ' ' + m); if (!c) process.exitCode = 1; };
  if (fase === '1') {
    const p = await b.newPage({ viewport: { width: 1280, height: 900 } }); p.on('pageerror', e => errs.push(e.message));
    await p.goto('http://localhost:3111/'); await p.click('[data-action="auth-troca"]');
    await p.fill('#anome', 'Richard Carmo'); await p.fill('#aemail', EMAIL); await p.fill('#asenha', 'senha-forte-123'); await p.click('#formCadastro button[type=submit]');
    await p.waitForSelector('#formOnbCnpj'); await p.fill('#ocnpj', '66369868000171'); await p.click('#formOnbCnpj button[type=submit]'); await p.waitForSelector('#formOnbConfirmar'); await p.fill('#onome', 'Empresa de Teste'); await p.click('#formOnbConfirmar button[type=submit]');
    await p.waitForFunction(() => document.querySelector('#auth').hidden);
    await p.waitForFunction(() => document.querySelector('#main').textContent.includes('O que foi conferido'), null, { timeout: 15000 });
    ok(p.url().endsWith('#situacao'), 'depois do cadastro abre a Situação fiscal');
    const t = await p.textContent('#main');
    ok(t.includes('EMPRESA DE TESTE LTDA (FICTICIA)') && t.includes('Simples Nacional desde 10/03/2019'), 'cadastro puxado automaticamente com regime e data');
    ok(t.includes('CNPJ ativo') && t.includes('Conferência agendada'), 'cadastro ok e dívida ativa agendada');
    ok(t.includes('Histórico desde a abertura') && t.includes('Abertura da empresa'), 'linha do tempo desde a abertura');
    ok(t.includes('11.222.333/0001-81'), 'passo a passo mostra o CNPJ procurador');
    await p.click('[data-action="sit-ir-autorizar"]'); await p.waitForTimeout(500); ok(p.url().endsWith('#situacao'), '"Como autorizar" rola sem trocar de página');
    await p.screenshot({ path: '/tmp/e2e/sit1.png', fullPage: true });
    await p.click('[data-action="novaemp"]').catch(async () => { await p.goto('http://localhost:3111/#empresas'); await p.waitForTimeout(300); await p.click('[data-action="novaemp"]'); });
    await p.waitForSelector('#formOnbCnpj'); await p.fill('#ocnpj', '11222333000181'); await p.click('#formOnbCnpj button[type=submit]'); await p.waitForSelector('#formOnbConfirmar'); await p.fill('#onome', 'Comércio Exemplo'); await p.click('#formOnbConfirmar button[type=submit]');
    await p.waitForFunction(() => document.querySelector('#main').textContent.includes('COMERCIO EXEMPLO ME'), null, { timeout: 15000 });
    ok(true, 'segunda empresa (MEI) cadastrada e consultada');
  } else {
    for (const [nome, w, h] of [['d', 1280, 900], ['m', 390, 844]]) {
      const p = await b.newPage({ viewport: { width: w, height: h } }); p.on('pageerror', e => errs.push(e.message));
      await p.goto('http://localhost:3111/'); await p.waitForSelector('#formLogin');
      await p.fill('#aemail', EMAIL); await p.fill('#asenha', 'senha-forte-123'); await p.click('#formLogin button[type=submit]');
      await p.waitForFunction(() => document.querySelector('#auth').hidden);
      await p.goto('http://localhost:3111/#situacao');
      await p.waitForFunction(() => document.querySelector('#main').textContent.includes('O que foi conferido'), null, { timeout: 15000 });
      if (nome === 'd') await p.selectOption('#empresa', { label: 'Comércio Exemplo' });
      else await p.evaluate(() => { const s = document.querySelector('#empresa'); if (s) { s.value = [...s.options].find(o => o.text.includes('Comércio')).value; s.dispatchEvent(new Event('change', { bubbles: true })); } });
      await p.waitForFunction(() => document.querySelector('#main').textContent.includes('COMERCIO EXEMPLO'), null, { timeout: 15000 });
      const t = await p.textContent('#main');
      if (nome === 'd') {
        ok(t.includes('ponto de atenção') && t.includes('3.482,17') && t.includes('80 4 25 012345-67'), 'MEI com dívida ativa: veredito, valor e inscrição');
        ok(t.includes('Inscrição em dívida ativa'), 'inscrição aparece no histórico');
        await p.click('[data-action="bell"]'); await p.waitForTimeout(300);
        ok((await p.textContent('body')).includes('inscrição em dívida ativa'), 'sino avisa a nova inscrição');
        await p.keyboard.press('Escape');
      }
      await p.screenshot({ path: `/tmp/e2e/sit2-${nome}.png`, fullPage: nome === 'd' });
      await p.close();
    }
  }
  console.log('erros de página:', errs.length ? errs : 'nenhum'); await b.close();
})().catch(e => { console.error('ERRO', e.message, (e.stack||'').split('\n').filter(l=>l.includes('e2e3')).join(' | ')); process.exit(1); });
