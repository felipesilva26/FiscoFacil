const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
  const errs = []; p.on('pageerror', e => errs.push('pageerror: ' + e.message + ' ' + (e.stack||'').split('\n').slice(0,4).join(' | '))); p.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  const ok = (c, m) => { console.log('   errs so far', errs.filter(e=>e.startsWith('pageerror')).length); console.log((c ? 'OK   ' : 'FALHA') + ' ' + m); if (!c) process.exitCode = 1; };
  await p.goto('http://localhost:3111/');
  ok(await p.isVisible('#auth'), 'tela de login aparece');
  await p.click('[data-action="auth-troca"]');
  await p.fill('#anome', 'Richard Teste'); await p.fill('#aemail', 'r' + Date.now() + '@teste.com'); await p.fill('#asenha', 'senha-forte-123');
  await p.click('#formCadastro button[type=submit]');
  await p.waitForSelector('#formOnbCnpj'); await p.fill('#ocnpj', '12345678000100'); await p.click('#formOnbCnpj button[type=submit]');
  await p.waitForFunction(() => document.querySelector('#ferr') && document.querySelector('#ferr').textContent.length > 0);
  ok((await p.textContent('#ferr')).includes('CNPJ inválido'), 'CNPJ inválido recusado');
  await p.fill('#ocnpj', '66369868000171'); await p.click('#formOnbCnpj button[type=submit]'); await p.waitForSelector('#formOnbConfirmar'); await p.click('#formOnbConfirmar button[type=submit]');
  await p.waitForSelector('#auth', { state: 'hidden' });
  const html = await p.evaluate(() => document.body.innerText);
  ok(!/Empresa Exemplo|Comércio Exemplo|simulada/i.test(html), 'sem dados de exemplo nem "simulada" na tela');
  await p.waitForFunction(() => document.querySelector('#main').textContent.includes('Situação fiscal'));
  ok(true, 'depois do cadastro abre a Situação fiscal');
  await p.goto('http://localhost:3111/#inicio'); await p.waitForTimeout(300);
  ok((await p.textContent('#main')).includes('Olá, Richard Teste'), 'dashboard carrega com o nome do usuário');
  // nova obrigação
  await p.goto('http://localhost:3111/#guias'); await p.waitForTimeout(300);
  await p.click('[data-action="nova"]'); await p.waitForSelector('#formNova');
  const d = new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10);
  await p.fill('#nvenc', d); await p.fill('#nvalor', '1.250,00'); await p.click('#formNova button[type=submit]');
  await p.waitForFunction(() => document.querySelector('#main').textContent.includes('1.250,00'));
  ok(true, 'obrigação criada e listada (vem do servidor)');
  // recarregar mantém dados
  await p.reload(); await p.waitForSelector('#auth', { state: 'hidden' }); await p.waitForFunction(() => document.querySelector('#main').textContent.includes('1.250,00'));
  ok(true, 'dados persistem após recarregar a página');
  // conectar à Receita sem Serpro: mensagem honesta
  await p.goto('http://localhost:3111/#configuracoes'); await p.waitForTimeout(300);
  await p.click('[data-action="conectar"]'); await p.waitForSelector('#formConectar');
  await p.check('#cok'); await p.click('#formConectar button[type=submit]');
  await p.waitForFunction(() => document.querySelector('#ferr') && document.querySelector('#ferr').textContent.length > 0);
  ok((await p.textContent('#ferr')).includes('não configurad') || (await p.textContent('#ferr')).includes('Faltam'), 'conectar sem Serpro mostra o que falta, sem inventar dados: ' + (await p.textContent('#ferr')).slice(0, 110));
  await p.click('[data-action="fechar"]');
  // integrações
  await p.goto('http://localhost:3111/#integracoes'); await p.waitForTimeout(500);
  const t = await p.textContent('#main');
  ok(t.includes('Fonte dos dados') && t.includes('Integra Contador'), 'página Integrações mostra a fonte de cada dado');
  ok(t.includes('O que preciso receber'), 'mostra o que falta para conectar');
  // upload de documento
  await p.goto('http://localhost:3111/#documentos'); await p.waitForTimeout(300);
  require('fs').writeFileSync('/tmp/e2e/guia.pdf', '%PDF-1.4\nteste');
  await p.setInputFiles('#fileDoc', '/tmp/e2e/guia.pdf');
  await p.waitForFunction(() => document.querySelector('#main').textContent.includes('guia.pdf'));
  ok(true, 'upload de documento funciona');
  // assistente
  await p.goto('http://localhost:3111/#assistente'); await p.waitForTimeout(300);
  await p.fill('#chatq', 'Quanto tenho em aberto?'); await p.press('#chatq', 'Enter');
  await p.waitForFunction(() => document.querySelector('#main').textContent.includes('total em aberto'));
  ok(true, 'assistente responde com dados do servidor');
  // sair
  await p.goto('http://localhost:3111/#configuracoes'); await p.waitForTimeout(300);
  await p.click('[data-action="sair"]'); ok(await p.isVisible('#auth'), 'sair volta ao login');
  await p.screenshot({ path: '/tmp/e2e/login.png' });
  console.log('erros de console:', errs.length ? errs : 'nenhum');
  await b.close();
})().catch(e => { console.error('ERRO', e.message); process.exit(1); });
