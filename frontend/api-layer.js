/* ===== Camada de API: troca o armazenamento local pelo servidor ===== */
const TK = 'fiscofacil-token';
let token = ''; try { token = localStorage.getItem(TK) || ''; } catch (e) {}
let INTEG_SRV = null;

async function api(method, url, body, isForm){
  const h = {}; if (token) h.authorization = 'Bearer ' + token;
  let payload;
  if (body !== undefined) { if (isForm) payload = body; else { h['content-type'] = 'application/json'; payload = JSON.stringify(body); } }
  let r;
  try { r = await fetch(url, {method, headers:h, body:payload}); } catch (e) { throw new Error('Sem conexão com o servidor.'); }
  if (r.status === 401 && token) { logout(); throw new Error('Sessão expirada. Entre novamente.'); }
  if (r.status === 204) return null;
  const txt = await r.text(); let j = null; try { j = txt ? JSON.parse(txt) : null; } catch (e) {}
  if (!r.ok) { const er = new Error((j && j.erro) || ('Erro ' + r.status)); er.status = r.status; er.data = j; throw er; }
  return j;
}
let SEM_LOGIN = false;
function logout(){
  token = ''; try { localStorage.removeItem(TK); } catch (e) {}
  if (SEM_LOGIN) { S.empresas = []; entrarAnonimo().then(iniciar).catch(er => showAuth('login', er.message)); return; }
  showAuth('login');
}
/** Versão de teste sem login: cria uma conta anônima ligada a este navegador. */
async function entrarAnonimo(){
  const id = (window.crypto && crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2)).replace(/[^a-z0-9]/gi, '').slice(0, 20);
  const r = await api('POST', '/api/auth/register', {nome:'Visitante', email:'visitante-' + id + '@fiscofacil.app', senha:id + '-' + Math.random().toString(36).slice(2)});
  token = r.token; try { localStorage.setItem(TK, token); } catch (e) {}
}
async function boot(){
  try { SEM_LOGIN = !!(await api('GET', '/api/health')).semLogin; } catch (e) {}
  document.body.classList.toggle('semlogin', SEM_LOGIN);
  if (token) return iniciar();
  if (SEM_LOGIN) { try { await entrarAnonimo(); return iniciar(); } catch (er) { showAuth('login', er.message); return; } }
  showAuth('login');
}

async function loadAll(){
  const me = await api('GET', '/api/auth/me');
  const emps = await api('GET', '/api/empresas');
  const cfgL = await api('GET', '/api/lembretes/config');
  try { INTEG_SRV = await api('GET', '/api/integracoes'); } catch (e) { INTEG_SRV = null; }
  let alertas = []; try { alertas = await api('GET', '/api/alertas'); } catch (e) {}
  const obrigacoes = [], docs = [];
  for (const e of emps) {
    const r = await Promise.all([api('GET', '/api/empresas/' + e.id + '/obrigacoes'), api('GET', '/api/empresas/' + e.id + '/obrigacoes?arquivadas=true'), api('GET', '/api/empresas/' + e.id + '/documentos')]);
    r[0].concat(r[1]).forEach(o => obrigacoes.push(o));
    r[2].forEach(x => docs.push({id:x.id, empresaId:x.empresaId, nome:x.nome, tipo:x.tipo, tam:x.tamanho, data:x.data, validade:x.validade}));
  }
  const keep = S.empresaId && emps.some(e => e.id === S.empresaId) ? S.empresaId : (emps[0] ? emps[0].id : null);
  S = {v:1, user:{nome:me.nome, email:me.email}, empresas:emps.map(e => Object.assign({}, e, {cnpj:e.cnpj || ''})), empresaId:keep, obrigacoes:obrigacoes, docs:docs,
    alertas:alertas, lembretes:{email:cfgL.email, whatsapp:cfgL.whatsapp, push:cfgL.push, antecedencia:String(cfgL.antecedencia)}};
}
async function refresh(msg){ if (S.empresaId) delete SIT[S.empresaId]; await loadAll(); closeModal(); renderAll(); if (msg) toast(msg); }
const falhou = er => toast(er.message || 'Não foi possível concluir.');
const rodar = fn => async function(el){ try { await fn(el); } catch (er) { falhou(er); } };

/* ---------- cadastro da empresa: só o CNPJ ---------- */
let onb;
function onbReset(ctx){ onb = {etapa:'cnpj', cnpj:'', cad:null, reg:null, nome:'', trocarRegime:false, aviso:'', ctx:ctx || 'primeira'}; }
onbReset();
const regimeDe = c => !c ? 'Simples Nacional' : c.mei ? 'MEI' : c.simples ? 'Simples Nacional' : c.simples === false ? 'Lucro Presumido' : 'Simples Nacional';
function onbHTML(){
  if (onb.etapa === 'cnpj') {
    return '<form id="formOnbCnpj" class="form">' + field('ocnpj', 'CNPJ da empresa', '<input id="ocnpj" class="in big" data-mask="cnpj" inputmode="numeric" autocomplete="off" placeholder="00.000.000/0000-00" value="' + esc(onb.cnpj) + '">', 'Só os 14 números. O resto o sistema preenche.') +
      '<p class="err" id="ferr" role="alert"></p><div class="actions"><button class="btn primary" type="submit">Buscar empresa</button></div></form>';
  }
  const c = onb.cad;
  const sit = c && c.situacao ? '<span class="chip ' + (/^ATIVA$/i.test(c.situacao) ? 'pago' : 'atrasado') + '"><i></i>' + esc(c.situacao) + '</span>' : '';
  const linhaC = (rot, val) => val ? '<div class="onbrow"><dt>' + rot + '</dt><dd>' + esc(val) + '</dd></div>' : '';
  const regTxt = c ? (c.mei ? 'MEI' + (c.meiDesde ? ' desde ' + fmtDate(c.meiDesde) : '') : c.simples ? 'Simples Nacional' + (c.simplesDesde ? ' desde ' + fmtDate(c.simplesDesde) : '') : c.simples === false ? 'Fora do Simples' : '') : '';
  const resumo = c ? '<div class="onbcard"><b>' + esc(c.razaoSocial || 'Empresa') + '</b><span class="num">' + esc(onb.cnpj) + '</span><span class="onbmeta">' + sit + esc([c.municipio, c.uf].filter(Boolean).join('/')) + '</span>' +
      '<dl class="onbdl">' + linhaC('O que faz', c.atividade) + linhaC('Tipo', c.natureza) + linhaC('Porte', c.porte) + linhaC('Aberta em', c.abertura ? fmtDate(c.abertura) : '') + '</dl></div>'
    : '<p class="note">' + esc(onb.aviso || 'Preencha o nome da empresa para continuar.') + '</p>';
  return '<form id="formOnbConfirmar" class="form">' + resumo +
    field('onome', 'Nome para mostrar no sistema', '<input id="onome" class="in" autocomplete="organization" value="' + esc(c ? (onb.nome || c.nomeFantasia || c.razaoSocial || '') : '') + '">') +
    regimeHTML() +
    '<p class="err" id="ferr" role="alert"></p><div class="actions"><button type="button" class="btn ghost" data-action="onb-voltar">Trocar CNPJ</button><button class="btn primary" type="submit">Confirmar e ver a situação fiscal</button></div></form>';
}
function regimeHTML(){
  const r = onb.reg;
  const lista = sel => '<select id="oreg" class="in">' + REGIMES.map(x => '<option' + (sel === x ? ' selected' : '') + '>' + x + '</option>').join('') + '</select>';
  if (r && r.regime && !onb.trocarRegime) {
    return '<div class="field"><span class="lbl">Regime tributário</span><div class="regbox"><input type="hidden" id="oreg" value="' + esc(r.regime) + '">' +
      '<div><b>' + esc(r.texto) + '</b><span class="chip pago"><i></i>Identificado na Receita</span></div>' +
      r.historico.map(h => '<small>' + esc(h) + '</small>').join('') +
      '<button type="button" class="linkbtn" data-action="onb-trocar-regime">Não está certo? Alterar</button></div></div>';
  }
  if (r && !r.regime && r.opcoes.length && !onb.trocarRegime) {
    return '<fieldset class="field regopts"><legend class="lbl">Regime tributário</legend>' +
      '<p class="hint" style="margin:0 0 8px">A Receita informa que a empresa <b>não é MEI nem Simples</b>. Se é Lucro Presumido ou Lucro Real não é público: escolha abaixo (o contador sabe).</p>' +
      r.opcoes.map(o => '<label class="regopt"><input type="radio" name="oregr" value="' + o + '"><span><b>' + o + '</b><small>' + (o === 'Lucro Presumido' ? 'O mais comum para empresas pequenas e médias fora do Simples' : 'Obrigatório para faturamento acima de R$ 78 milhões e alguns setores') + '</small></span></label>').join('') +
      r.historico.map(h => '<small class="hint">' + esc(h) + '</small>').join('') + '</fieldset>';
  }
  return field('oreg', 'Regime tributário', lista(regimeDe(onb.cad)), onb.cad ? 'Confira e ajuste se precisar.' : 'Não consegui confirmar na Receita: escolha o regime.');
}
document.addEventListener('change', e => { if (e.target.name === 'oregr') { const f = $('#ferr'); if (f) f.textContent = ''; } });
ACT['onb-trocar-regime'] = () => { onb.trocarRegime = true; onbRedesenhar(); const f = $('#oreg'); if (f) f.focus(); };
function regimeEscolhido(){
  const radio = document.querySelector('input[name="oregr"]:checked');
  if (document.querySelector('input[name="oregr"]') && !radio) throw new Error('Escolha se a empresa é Lucro Presumido ou Lucro Real.');
  return radio ? radio.value : $('#oreg').value;
}
function onbRedesenhar(){
  if (onb.ctx === 'primeira') { showAuth('primeira'); return; }
  renderModal();
}
function drawOnb(){
  const box = $('#modal');
  box.innerHTML = '<div class="overlay" data-overlay><div class="dialog" role="dialog" aria-modal="true" aria-labelledby="mt" tabindex="-1"><div class="mhead"><h2 id="mt">Adicionar empresa</h2><button class="ib" data-action="fechar" aria-label="Fechar">' + ic('x') + '</button></div>' + onbHTML() + '</div></div>';
  const f = box.querySelector('#ocnpj, #onome'); if (f) f.focus();
}

/* ---------- login e cadastro ---------- */
function showAuth(modo, msg){
  let box = $('#auth');
  if (!box) { box = document.createElement('div'); box.id = 'auth'; document.body.appendChild(box); }
  const cad = modo === 'cadastro', prim = modo === 'primeira';
  const campo = (id, lbl, tipo, extra) => '<div class="field"><label for="' + id + '">' + lbl + '</label><input id="' + id + '" class="in" type="' + (tipo || 'text') + '" ' + (extra || '') + '></div>';
  let corpo;
  if (prim) corpo = '<h1>Cadastre sua empresa</h1><p class="sub">Informe o CNPJ. O FiscoFácil busca os dados nas fontes oficiais.</p>' + onbHTML();
  else corpo = '<h1>' + (cad ? 'Criar conta' : 'Entrar') + '</h1><p class="sub">' + (cad ? 'Crie sua conta para acompanhar impostos e vencimentos.' : 'Acesse o FiscoFácil.') + '</p><form id="' + (cad ? 'formCadastro' : 'formLogin') + '" class="form">' +
    (cad ? campo('anome', 'Seu nome', 'text', 'autocomplete="name" required') : '') + campo('aemail', 'E-mail', 'email', 'autocomplete="email" required') +
    campo('asenha', 'Senha' + (cad ? ' (mínimo 8 caracteres)' : ''), 'password', 'autocomplete="' + (cad ? 'new-password' : 'current-password') + '" required') +
    '<p class="err" id="aerr" role="alert">' + esc(msg || '') + '</p><div class="actions"><button class="btn primary" type="submit">' + (cad ? 'Criar conta' : 'Entrar') + '</button></div></form>' +
    '<p class="hint" style="margin-top:14px"><a href="#" data-action="auth-troca" data-modo="' + (cad ? 'login' : 'cadastro') + '">' + (cad ? 'Já tenho conta' : 'Criar uma conta') + '</a></p>';
  const logo = '<div class="brand">' + LOGO + 'FiscoFácil</div>';
  box.innerHTML = '<div class="authwrap"><aside class="authbrand">' + logo + '<div><h2>Impostos em dia, sem complicação.</h2><p>Vencimentos, guias e documentos de todas as suas empresas em um só lugar.</p></div><ul><li>Alertas antes de cada vencimento</li><li>Leitura automática de guias e certidões</li><li>Todos os seus CNPJs numa única tela</li></ul></aside><div class="authside"><div class="authcard card">' + corpo + '</div></div></div>';
  box.hidden = false;
  const f = box.querySelector('input'); if (f) f.focus();
}
function hideAuth(){ const b = $('#auth'); if (b) b.hidden = true; }
async function entrar(path, body){
  const r = await api('POST', path, body);
  token = r.token; try { localStorage.setItem(TK, token); } catch (e) {}
  await iniciar();
}
async function iniciar(){
  try {
    await loadAll();
    if (!S.empresas.length) { showAuth('primeira'); return; }
    hideAuth(); route(); renderAll();
  } catch (er) {
    if (SEM_LOGIN && !iniciar.tentou) { iniciar.tentou = true; token = ''; try { await entrarAnonimo(); return iniciar(); } catch (e2) { er = e2; } }
    showAuth('login', er.message);
  }
}
ACT['auth-troca'] = (el, e) => { if (e) e.preventDefault(); showAuth(el.dataset.modo); };
ACT.sair = () => { logout(); };
ACT['onb-voltar'] = () => { onb.etapa = 'cnpj'; onb.aviso = ''; onbRedesenhar(); };
ACT.novaemp = () => { onbReset('modal'); ui.modal = {t:'onb'}; renderModal(); };
const _bell = ACT.bell; ACT.bell = function(el){ _bell(el); if (ui.alerts && (S.alertas || []).some(a => !a.lido)) api('POST', '/api/alertas/lidos').catch(() => {}); };

const SUB = {
  async formLogin(){ await entrar('/api/auth/login', {email:$('#aemail').value, senha:$('#asenha').value}); },
  async formCadastro(){ await entrar('/api/auth/register', {nome:$('#anome').value, email:$('#aemail').value, senha:$('#asenha').value}); },
  async formPrimeira(){
    if (!validCnpj($('#pcnpj').value)) throw new Error('CNPJ inválido. Confira os 14 números.');
    await api('POST', '/api/empresas', {nome:$('#pnome').value.trim(), cnpj:$('#pcnpj').value, regime:$('#preg').value});
    location.hash = '#situacao';
    await iniciar();
  },
  async formOnbCnpj(){
    const v = $('#ocnpj').value;
    if (!validCnpj(v)) throw new Error('CNPJ inválido. Confira os 14 números.');
    onb.cnpj = fmtCnpj(v); onb.erro = '';
    try { const r = await api('GET', '/api/cnpj/' + onlyD(v)); onb.cad = r.cadastral; onb.reg = r.regime || null; onb.nome = r.nome || ''; }
    catch (er) { if (er.status === 400) throw er; onb.cad = null; onb.reg = null; onb.aviso = er.status === 404 ? 'Não encontrei este CNPJ na base pública da Receita. Se a empresa é nova, preencha os dados abaixo.' : 'Não consegui buscar os dados agora. Preencha o nome da empresa para continuar.'; }
    onb.etapa = 'confirmar'; onbRedesenhar();
  },
  async formOnbConfirmar(){
    const nome = $('#onome').value.trim();
    if (nome.length < 2) throw new Error('Informe o nome da empresa.');
    const e = await api('POST', '/api/empresas', {nome:nome, cnpj:onb.cnpj, regime:regimeEscolhido()});
    const primeira = onb.ctx === 'primeira';
    onbReset();
    S.empresaId = e.id;
    if (location.hash !== '#situacao') history.replaceState(null, '', '#situacao');
    route();
    if (primeira) await iniciar(); else await refresh('Empresa adicionada. Consultando as fontes oficiais.');
  },
  async formNova(){
    const venc = $('#nvenc').value, valor = parseMoney($('#nvalor').value);
    if (!venc) throw new Error('Informe a data de vencimento.');
    if (!(valor > 0)) throw new Error('Informe um valor maior que zero, por exemplo 1.250,00.');
    await api('POST', '/api/empresas/' + S.empresaId + '/obrigacoes', {tributo:$('#ntrib').value, venc:venc, valor:Math.round(valor * 100) / 100, codigo:$('#ncod').value.trim()});
    await refresh('Obrigação adicionada.');
  },
  async formPagar(f){
    const o = find(f.dataset.id); if (!o) return;
    const file = $('#parq').files[0];
    await api('POST', '/api/obrigacoes/' + o.id + '/pagar', {data:$('#pdata').value || iso(today()), comprovante:file ? file.name : undefined});
    if (file) await enviar(o.empresaId, file, 'Comprovante');
    await refresh('Pagamento registrado.');
  },
  async formLer(f){
    const k = f.dataset.k, L = ui.modal.r.leitura;
    if (k === 'guia') {
      const venc = $('#lvenc').value, valor = parseMoney($('#lvalor').value);
      if (!venc) throw new Error('Informe a data de vencimento.');
      if (!(valor > 0)) throw new Error('Informe um valor maior que zero.');
      await api('POST', '/api/empresas/' + S.empresaId + '/obrigacoes', {tributo:$('#ltrib').value, venc:venc, valor:Math.round(valor * 100) / 100, codigo:$('#lcod').value.trim()});
      await enviar(S.empresaId, lerFile, 'Guia');
      await refresh('Obrigação criada e arquivo guardado.');
    } else if (k === 'comprovante') {
      const sel = f.querySelector('input[name="lcand"]:checked');
      if (!sel) throw new Error('Escolha a obrigação paga.');
      await api('POST', '/api/obrigacoes/' + sel.value + '/pagar', {data:$('#ldata').value || iso(today()), comprovante:lerFile.name});
      await enviar(S.empresaId, lerFile, 'Comprovante');
      await refresh('Pagamento registrado e comprovante guardado.');
    } else {
      const v = $('#lval').value;
      if (!v) throw new Error('Informe até quando a certidão é válida.');
      await enviar(S.empresaId, lerFile, 'Certidão', v);
      await refresh('Certidão guardada. Você será avisado antes de vencer.');
    }
  },
  async formPerfil(){ await api('PATCH', '/api/auth/me', {nome:$('#nome').value.trim()}); await refresh('Perfil salvo.'); },
  async formEmpresa(){
    const em = empAtual(), c = $('#ecnpj').value;
    if (c.trim() && !validCnpj(c)) throw new Error('CNPJ inválido. Confira os 14 números.');
    await api('PATCH', '/api/empresas/' + em.id, {nome:$('#enome').value.trim() || em.nome, cnpj:c.trim() ? c : '', regime:$('#ereg').value});
    await refresh('Empresa salva.');
  },
  async formNovaEmp(){
    if (!validCnpj($('#mcnpj').value)) throw new Error('CNPJ inválido. Confira os 14 números.');
    const e = await api('POST', '/api/empresas', {nome:$('#mnome').value.trim(), cnpj:$('#mcnpj').value, regime:$('#mreg').value});
    S.empresaId = e.id; await refresh('Empresa adicionada. Consultando as fontes oficiais.'); location.hash = '#situacao';
  },
  async formConectar(f){
    if (!validCnpj($('#ccnpj').value)) throw new Error('CNPJ inválido. Confira os 14 números.');
    if (!$('#cok').checked) throw new Error('Confirme que você é responsável por este CNPJ ou tem autorização.');
    const aut = ['procuracao_ecac', 'procurador_contador', 'certificado_ecnpj'][$('#caut').selectedIndex] || 'procuracao_ecac';
    const r = await api('POST', '/api/empresas/' + f.dataset.id + '/receita/conectar', {cnpj:$('#ccnpj').value, autorizacao:aut, confirmo:true});
    await refresh('Conectado. ' + r.novas + (r.novas === 1 ? ' guia nova' : ' guias novas') + ' (fonte: ' + r.fonte + ').');
  },
};
window.addEventListener('submit', async e => {
  const f = e.target, h = SUB[f.id];
  if (f.id === 'formChat' || !h) return;
  e.preventDefault(); e.stopImmediatePropagation();
  try { await h(f); } catch (er) { const err = f.querySelector('#aerr, #ferr'); if (err) err.textContent = er.message; else falhou(er); }
}, true);

/* ---------- ações ---------- */
ACT.desfazer = rodar(async el => { await api('POST', '/api/obrigacoes/' + el.dataset.id + '/desfazer-pagamento'); await refresh('Pagamento desfeito.'); });
ACT.arquivar = rodar(async el => { const o = find(el.dataset.id); if (!o) return; await api('PATCH', '/api/obrigacoes/' + o.id, {arquivado:!o.arquivado}); await refresh(o.arquivado ? 'Obrigação restaurada.' : 'Obrigação arquivada.'); });
ACT['excluir-ok'] = rodar(async el => { await api('DELETE', '/api/obrigacoes/' + el.dataset.id); await refresh('Obrigação excluída.'); });
ACT.rmdoc = rodar(async el => { await api('DELETE', '/api/documentos/' + el.dataset.id); await refresh('Documento removido.'); });
ACT.desconectar = rodar(async el => { await api('POST', '/api/empresas/' + (el.dataset.emp || S.empresaId) + '/receita/desconectar'); await refresh('Integração desconectada.'); });
ACT.sincronizar = rodar(async el => {
  const r = await api('POST', '/api/empresas/' + (el.dataset.emp || S.empresaId) + '/receita/sincronizar');
  await refresh(r.novas ? r.novas + (r.novas === 1 ? ' guia nova' : ' guias novas') + ' (fonte: ' + r.fonte + ').' : 'Consulta feita em ' + r.fonte + ': nada novo.');
});
ACT['restaurar-ok'] = () => {};

async function enviar(empresaId, file, tipo, validade){
  const fd = new FormData(); fd.append('file', file, file.name);
  return api('POST', '/api/empresas/' + empresaId + '/documentos?tipo=' + encodeURIComponent(tipo) + (validade ? '&validade=' + validade : ''), fd, true);
}
let lerFile = null;
addFiles = async function(files, tipo){
  const arr = Array.prototype.slice.call(files);
  if (arr.length === 1 && /\.pdf$/i.test(arr[0].name)) {
    try {
      const fd = new FormData(); fd.append('file', arr[0], arr[0].name);
      toast('Lendo o documento...');
      const r = await api('POST', '/api/empresas/' + S.empresaId + '/documentos/ler', fd, true);
      if (r.leitura.tipo !== 'desconhecido') { lerFile = arr[0]; ui.modal = {t:'lerdoc', r:r}; renderModal(); return; }
      toast('Não reconheci o documento. Ele foi enviado sem leitura.');
    } catch (er) { toast(er.message + ' O arquivo foi enviado sem leitura.'); }
  }
  let n = 0;
  try { for (const f of arr) { await enviar(S.empresaId, f, tipo); n++; } } catch (er) { falhou(er); }
  if (n) await refresh(n + (n === 1 ? ' documento enviado.' : ' documentos enviados.')); else renderMain();
};
const TIPO_DOC = {guia:'Guia', comprovante:'Comprovante', certidao:'Certidão'};
const num2br = v => v == null ? '' : String(v.toFixed(2)).replace('.', ',');
function drawLer(){
  const m = ui.modal, r = m.r, L = r.leitura, box = $('#modal');
  const close = '<button class="ib" data-action="fechar" aria-label="Fechar">' + ic('x') + '</button>';
  const avisos = L.avisos.map(a => '<p class="err" style="margin:0">' + esc(a) + '</p>').join('') + (r.duplicada ? '<p class="err" style="margin:0">Já existe uma obrigação igual cadastrada.</p>' : '') +
    (L.confianca !== 'alta' ? '<p class="hint" style="margin:0">Não tenho certeza de todos os campos. Confira antes de salvar.</p>' : '');
  const botoes = (txt) => '<p class="err" id="ferr" role="alert"></p><div class="actions"><button type="button" class="btn ghost" data-action="fechar">Cancelar</button><button type="button" class="btn ghost" data-action="ler-so-arquivo">Só guardar o arquivo</button>' + (txt ? '<button class="btn primary" type="submit">' + txt + '</button>' : '') + '</div>';
  let title, body;
  if (L.tipo === 'guia') {
    title = 'Li uma guia';
    body = '<form id="formLer" class="form" data-k="guia"><p class="sub" style="margin:0">Confira os dados lidos do arquivo <b>' + esc(lerFile.name) + '</b>.</p>' + avisos +
      '<div class="formrow">' + field('ltrib', 'Tributo', '<select id="ltrib" class="in">' + Object.keys(TRIB).map(k => '<option value="' + k + '"' + (L.tributo === k ? ' selected' : '') + '>' + esc(TRIB[k]) + '</option>').join('') + '</select>') +
      field('lvenc', 'Vencimento', '<input id="lvenc" type="date" class="in" value="' + esc(L.vencimento || '') + '">') + '</div>' +
      field('lvalor', 'Valor (R$)', '<input id="lvalor" class="in" inputmode="decimal" value="' + esc(num2br(L.valor)) + '">') +
      field('lcod', 'Linha digitável (opcional)', '<input id="lcod" class="in" autocomplete="off" value="' + esc(L.linhaDigitavel || '') + '">') + botoes(r.duplicada ? '' : 'Criar obrigação e guardar');
  } else if (L.tipo === 'comprovante') {
    title = 'Li um comprovante';
    const c = r.candidatos;
    body = '<form id="formLer" class="form" data-k="comprovante"><p class="sub" style="margin:0">Arquivo <b>' + esc(lerFile.name) + '</b>: ' + (L.valor != null ? 'valor ' + brl(L.valor) : 'valor não encontrado') + (L.dataPagamento ? ', pago em ' + fmtDate(L.dataPagamento) : '') + '.</p>' + avisos +
      (c.length ? '<div class="field"><label>Marcar qual obrigação como paga?</label>' + c.map((o, i) => '<label class="check"><input type="radio" name="lcand" value="' + o.id + '"' + (i === 0 ? ' checked' : '') + '> ' + esc(TRIB[o.tributo] || o.tributo) + ', vence ' + fmtDate(o.venc) + ', ' + brl(o.valor) + '</label>').join('') + '</div>' +
        field('ldata', 'Data do pagamento', '<input id="ldata" type="date" class="in" value="' + esc(L.dataPagamento || iso(today())) + '">')
        : '<p class="hint" style="margin:0">Não achei uma obrigação em aberto com esse valor. Você pode guardar só o arquivo.</p>') + botoes(c.length ? 'Marcar como paga e guardar' : '');
  } else {
    title = 'Li uma certidão';
    const sit = {negativa:'Negativa (sem débitos)', positiva_com_efeitos_de_negativa:'Positiva com efeitos de negativa', positiva:'Positiva (há débitos)'}[L.situacaoCertidao] || '';
    body = '<form id="formLer" class="form" data-k="certidao"><p class="sub" style="margin:0">Arquivo <b>' + esc(lerFile.name) + '</b>. Situação: <b>' + esc(sit) + '</b>.</p>' + avisos +
      field('lval', 'Válida até', '<input id="lval" type="date" class="in" value="' + esc(L.validade || '') + '">', 'Você será avisado antes de vencer.') + botoes('Guardar certidão');
  }
  box.innerHTML = '<div class="overlay" data-overlay><div class="dialog" role="dialog" aria-modal="true" aria-labelledby="mt" tabindex="-1"><div class="mhead"><h2 id="mt">' + title + '</h2>' + close + '</div>' + body + '</div></div>';
}
ACT['ler-so-arquivo'] = rodar(async () => {
  const L = ui.modal.r.leitura;
  await enviar(S.empresaId, lerFile, TIPO_DOC[L.tipo] || 'Outros', L.tipo === 'certidao' ? (($('#lval') && $('#lval').value) || L.validade || '') : '');
  await refresh('Arquivo guardado.');
});

ask = function(q){
  q = q.trim(); if (!q) return;
  ui.chat.push({de:'me', texto:q}); renderMain();
  api('POST', '/api/assistente', {empresaId:S.empresaId, pergunta:q})
    .then(r => { ui.chat.push({de:'bot', texto:r.resposta}); })
    .catch(er => { ui.chat.push({de:'bot', texto:'Não consegui responder agora: ' + er.message}); })
    .then(() => { if (ui.page === 'assistente') { renderMain(); const i = $('#chatq'); if (i) i.focus(); } });
};
ui.chat = [{de:'bot', texto:'Olá! Respondo com base nos dados cadastrados aqui. Confirme tudo com o seu contador.'}];

document.addEventListener('change', e => {
  const t = e.target;
  if (['lemEmail', 'lemWhats', 'lemPush', 'lemAnt'].indexOf(t.id) > -1) {
    const l = S.lembretes;
    api('PUT', '/api/lembretes/config', {email:!!l.email, whatsapp:!!l.whatsapp, push:!!l.push, antecedencia:Number(l.antecedencia)}).then(() => toast('Lembretes salvos.')).catch(falhou);
  }
  if (t.id === 'dcod') { const o = find(t.dataset.id); if (o) api('PATCH', '/api/obrigacoes/' + o.id, {codigo:t.value}).catch(falhou); }
});

/* ---------- página Integrações com os dados do servidor ---------- */
pgInteg = function(){
  const lab = {pronto:['pago', 'Conectado'], simulado:['avencer', 'Demonstração'], pendente:['atrasado', 'Pendente']};
  const L = INTEG_SRV || [];
  const falta = L.filter(x => x.status !== 'pronto').length;
  const cards = L.map(x => {
    const l = lab[x.status] || lab.pendente;
    return '<div class="card" style="padding:18px"><div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start;flex-wrap:wrap"><div><span class="hint">' + esc(x.grupo) + '</span><h3 style="margin:2px 0 0;font-size:16px">' + esc(x.titulo) + '</h3></div><span class="chip ' + l[0] + '"><i></i>' + l[1] + '</span></div>' +
      '<p class="hint" style="margin:10px 0 0"><b>Fonte dos dados:</b> ' + esc(x.fonte) + (x.oficial ? ' (fonte oficial)' : '') + '</p>' +
      (x.status === 'pronto' ? '' : '<p class="hint" style="margin:12px 0 6px"><b>O que preciso receber</b></p><ul style="margin:0;padding-left:20px;line-height:1.55">' + x.precisa.map(i => '<li>' + esc(i) + '</li>').join('') + '</ul><p class="hint" style="margin:12px 0 0"><b>Como entregar:</b> ' + esc(x.entrega) + '</p>') +
      '</div>';
  }).join('');
  return head('Integrações', 'De onde vêm os dados e o que falta para conectar cada órgão. ' + falta + ' de ' + L.length + ' ainda precisam de algo.') +
    '<div class="note" style="margin-bottom:16px">Segurança: nunca envie senha, certificado digital, login do gov.br ou token pelo chat. Esses itens ficam apenas nas variáveis de ambiente do servidor.</div><div class="empgrid">' + cards + '</div>';
};

/* ---------- estilos da tela de acesso ---------- */
(function(){ const st = document.createElement('style'); st.textContent = '#auth{position:fixed;inset:0;z-index:100;overflow:auto}#auth[hidden]{display:none}'; document.head.appendChild(st); })();

/* Sem empresa carregada (antes do login ou depois de sair) nada é desenhado. */
const _rs = renderSide, _rt = renderTop, _rm = renderMain, _rtab = renderTab, _rmo = renderModal;
renderSide = function(){ if (S.empresas.length) _rs(); };
renderTop = function(){ if (S.empresas.length) _rt(); };
renderMain = function(){
  if (!S.empresas.length) return;
  _rm();
  if (S.empresas.length > 1 && ['empresas', 'integracoes', 'configuracoes'].indexOf(ui.page) < 0) {
    ($('#main').firstElementChild || $('#main')).insertAdjacentHTML('afterbegin', '<div class="mobemp"><label for="empresaM">Empresa</label><select id="empresaM" class="in">' + S.empresas.map(e => '<option value="' + e.id + '"' + (e.id === S.empresaId ? ' selected' : '') + '>' + esc(e.nome) + '</option>').join('') + '</select></div>');
  }
};
renderTab = function(){ if (S.empresas.length) _rtab(); };
renderModal = function(){ if (!S.empresas.length) return; if (ui.modal && ui.modal.t === 'lerdoc') drawLer(); else if (ui.modal && ui.modal.t === 'onb') drawOnb(); else _rmo(); };

/* ---------- Situação fiscal (fontes oficiais) ---------- */
const SIT = {}; let sitCarregando = null, sitErro = '';
const NIVEL = {ok:['pago', 'Em dia'], alerta:['atrasado', 'Pendência'], pendente:['neutro', 'A conferir'], info:['avencer', 'Atenção']};
async function carregarSituacao(id, forcar){
  if (sitCarregando === id) return;
  sitCarregando = id; sitErro = '';
  try {
    let s = await api('GET', '/api/empresas/' + id + '/situacao');
    if (forcar || (!s.cadastro && s.empresa.cnpj)) {
      try { s = await api('POST', '/api/empresas/' + id + '/situacao/atualizar'); } catch (er) { sitErro = er.message; }
    }
    SIT[id] = s;
  } catch (er) { sitErro = er.message; }
  sitCarregando = null;
  if (ui.page === 'situacao' || ui.page === 'inicio') renderMain();
}
ACT['sit-atualizar'] = rodar(async () => { delete SIT[S.empresaId]; renderMain(); await carregarSituacao(S.empresaId, true); toast(sitErro ? sitErro : 'Situação atualizada nas fontes oficiais.'); });
ACT['sit-ir-autorizar'] = () => { const el = $('#autorizar'); if (el) el.closest('section').scrollIntoView({behavior:'smooth', block:'start'}); };
const MESES_N = ['janeiro','fevereiro','março','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];
const nomeComp = c => { const p = c.split('-'); return MESES_N[Number(p[1]) - 1] + '/' + p[0]; };
ACT['das-mei'] = rodar(async el => {
  const id = S.empresaId;
  const r = await api('POST', '/api/empresas/' + id + '/das-mei', {competencia:el.dataset.c, status:el.dataset.s});
  await loadAll(); SIT[id] = r; renderAll();
  toast(el.dataset.s === 'pago' ? 'Marcado como pago.' : 'Guia em aberto criada. Você será avisado.');
});
/* Sites oficiais de cada assunto (endereços conferidos em fontes oficiais). */
const OFICIAL = {
  cnpj: {txt:'Comprovante do CNPJ', desc:'Receita Federal: situação cadastral e comprovante de inscrição', url:'https://solucoes.receita.fazenda.gov.br/servicos/cnpjreva/cnpjreva_solicitacao.asp'},
  cnd: {txt:'Certidão federal', desc:'Receita Federal e PGFN: certidão de débitos federais', url:'https://servicos.receitafederal.gov.br/servico/certidoes/#/home'},
  regularize: {txt:'Regularize (PGFN)', desc:'Dívida ativa da União e do FGTS: consultar, pagar e parcelar', url:'https://www.regularize.pgfn.gov.br/'},
  pgmei: {txt:'PGMEI / Simples Nacional', desc:'Receita Federal: guia DAS-MEI e situação de cada mês', url:'https://www8.receita.fazenda.gov.br/simplesnacional/'},
  ecac: {txt:'e-CAC', desc:'Receita Federal: pendências, pagamentos e procurações (gov.br)', url:'https://cav.receita.fazenda.gov.br/'},
  crf: {txt:'Certidão do FGTS (CRF)', desc:'Caixa: certificado de regularidade do FGTS', url:'https://consultacrf.caixa.gov.br/consultacrf/pages/consultaEmpregador.jsf'},
  cndt: {txt:'Certidão trabalhista (CNDT)', desc:'TST: débitos trabalhistas', url:'https://cndt-certidao.tst.jus.br/inicio.faces'},
};
const busca = q => 'https://www.google.com/search?q=' + encodeURIComponent(q);
function linksOficiais(s){
  const c = s.cadastro || {}, uf = c.uf || '', mun = c.municipio || '';
  const sefaz = {txt:'SEFAZ' + (uf ? ' ' + uf : ' do seu estado'), desc:'Certidão de débitos estaduais (ICMS)', url:busca('certidão negativa de débitos estaduais SEFAZ ' + uf + ' site:gov.br')};
  const pref = {txt:'Prefeitura' + (mun ? ' de ' + mun.toLowerCase().replace(/(^|\s)(\S)/g, (x, a, b) => a + b.toUpperCase()).replace(/ (De|Do|Da|Dos|Das) /g, x => x.toLowerCase()) : ''), desc:'Certidão de débitos municipais (ISS e taxas)', url:busca('certidão negativa de débitos municipais prefeitura ' + mun + ' ' + uf)};
  const divAlerta = s.blocos.some(b => b.id === 'divida' && b.nivel === 'alerta');
  const receitaOk = s.blocos.some(b => b.id === 'receita' && b.nivel === 'ok');
  return {
    cadastro: [{txt:'Ver na Receita', url:OFICIAL.cnpj.url}],
    divida: [{txt:divAlerta ? 'Negociar no Regularize' : 'Consultar no Regularize', url:OFICIAL.regularize.url}],
    dasmei: [{txt:'Conferir e pagar no PGMEI', url:OFICIAL.pgmei.url}],
    receita: [{txt:'Abrir o e-CAC', url:OFICIAL.ecac.url}].concat(receitaOk ? [] : [{txt:'Como autorizar', interno:true, acao:'sit-ir-autorizar'}]),
    guias: [{txt:'Ver minhas guias', interno:true, url:'#guias'}],
    certidoes: [{txt:'Certidão federal', url:OFICIAL.cnd.url}, {txt:'FGTS', url:OFICIAL.crf.url}, {txt:'Trabalhista', url:OFICIAL.cndt.url}, {txt:sefaz.txt, url:sefaz.url}, {txt:pref.txt, url:pref.url}, {txt:'Anexar certidão', interno:true, url:'#documentos'}],
    todos: [OFICIAL.cnpj, OFICIAL.ecac, OFICIAL.pgmei, OFICIAL.regularize, OFICIAL.cnd, OFICIAL.crf, OFICIAL.cndt, sefaz, pref],
  };
}
ACT['copiar-cnpj'] = el => {
  const v = el.dataset.cnpj || '';
  const ok = () => toast('CNPJ copiado. Cole no site do governo.');
  try { navigator.clipboard.writeText(v).then(ok, () => toast('Copie manualmente: ' + v)); } catch (e) { toast('Copie manualmente: ' + v); }
};
const dataBR = s => s ? fmtDate(String(s).slice(0, 10)) : '';
const reais = v => brl(Number(v) || 0);

function pgSituacao(){
  const e = empAtual(), s = SIT[e.id];
  if (!s) {
    carregarSituacao(e.id);
    return head('Situação da empresa', esc(e.nome) + (e.cnpj ? ' · ' + esc(fmtCnpj(e.cnpj)) : '')) +
      '<section class="card sitload" aria-busy="true"><p><b>Consultando as fontes oficiais…</b></p><p class="hint">Receita Federal (cadastro) e PGFN (dívida ativa da União e do FGTS).</p></section>';
  }
  const c = s.cadastro, v = s.resumo, nv = NIVEL[v.nivel] || NIVEL.info;
  const icone = v.nivel === 'ok' ? ic('check', 26) : v.nivel === 'alerta' ? ic('alert', 26) : ic('search', 26);
  const veredito = '<section class="card sitverdict ' + v.nivel + '" aria-live="polite"><span class="sitvicon">' + icone + '</span><div><h2>' + esc(v.titulo) + '</h2><p>' + esc(v.texto) + '</p>' +
    (sitErro ? '<p class="err" style="margin-top:6px">' + esc(sitErro) + '</p>' : '') + '</div></section>';

  const L = linksOficiais(s);
  const acao = b => (L[b.id] || []).map(l => l.interno
      ? (l.acao ? '<button class="btn soft sm" data-action="' + l.acao + '">' + esc(l.txt) + '</button>' : '<a class="btn soft sm" href="' + l.url + '">' + esc(l.txt) + '</a>')
      : '<a class="btn soft sm" href="' + l.url + '" target="_blank" rel="noopener">' + esc(l.txt) + ic('right', 14) + '</a>').join('');
  const linhaB = b => { const n = NIVEL[b.nivel] || NIVEL.info;
    return '<li class="sitrow"><span class="chip ' + n[0] + '"><i></i>' + n[1] + '</span><div class="grow"><b>' + esc(b.titulo) + '</b><p>' + esc(b.texto) + '</p><small>Fonte: ' + esc(b.fonte) +
      (b.atualizadoEm ? ' · ' + (/^\d{4}-/.test(b.atualizadoEm) ? 'consultado em ' + fmtDT(b.atualizadoEm) : 'base do ' + esc(b.atualizadoEm)) : '') + '</small>' + (acao(b) ? '<div class="sitlinks">' + acao(b) + '</div>' : '') + '</div></li>'; };
  const GRUPOS = [['auto', 'Conferido automaticamente nas fontes oficiais', ''],
    ['serpro', 'Precisa da conexão com a Receita', 'Guias, pagamentos e pendências federais só podem ser lidos com o contrato do Integra Contador (Serpro) e a sua autorização. Até lá, você confirma aqui.'],
    ['voce', 'Informado por você', '']];
  const lista = GRUPOS.map(g => { const bs = s.blocos.filter(b => (b.grupo || 'auto') === g[0]); if (!bs.length) return '';
    return sec('sb-' + g[0], g[1], (g[2] ? '<p class="sub" style="margin:0 0 6px">' + g[2] + '</p>' : '') + '<ul class="sitlist">' + bs.map(linhaB).join('') + '</ul>'); }).join('');
  if (s.pgfnRodando && (ui.page === 'situacao' || ui.page === 'inicio')) { clearTimeout(pgSituacao.t); pgSituacao.t = setTimeout(() => { if ((ui.page === 'situacao' || ui.page === 'inicio') && S.empresaId === e.id) { delete SIT[e.id]; carregarSituacao(e.id); } }, 30000); }

  let dados = '';
  if (c) {
    const regime = c.mei ? 'MEI' + (c.meiDesde ? ' desde ' + dataBR(c.meiDesde) : '') : c.simples ? 'Simples Nacional desde ' + dataBR(c.simplesDesde) : c.simples === false ? 'Fora do Simples (Lucro Presumido ou Real)' : 'Não informado';
    const kv = [['Razão social', c.razaoSocial], ['Situação', (c.situacao || '') + (c.situacaoDesde ? ' desde ' + dataBR(c.situacaoDesde) : '')], ['Abertura', dataBR(c.abertura)],
      ['Regime', regime], ['Porte', c.porte], ['Natureza', c.natureza], ['Atividade', c.atividade], ['Endereço', [c.endereco, [c.municipio, c.uf].filter(Boolean).join('/')].filter(Boolean).join(' · ')], ['Sócios', c.socios ? String(c.socios) : '']]
      .filter(x => x[1]).map(x => '<dt>' + x[0] + '</dt><dd>' + esc(x[1]) + '</dd>').join('');
    dados = sec('sc', 'Cadastro na Receita Federal', '<dl class="kv">' + kv + '</dl><p class="hint" style="margin-top:12px">Fonte: ' + esc(c.fonte) + ' · consultado em ' + fmtDT(c.consultadoEm) + '</p>');
  }

  const ev = (c ? c.linhaDoTempo : []).map(x => ({data:x.data, texto:x.texto, tipo:x.tipo}));
  (s.divida ? s.divida.inscricoes : []).forEach(i => { if (i.dataInscricao) ev.push({data:i.dataInscricao, texto:'Inscrição em dívida ativa (' + i.origem + '): ' + (i.receita || 'débito') + ', ' + reais(i.valor), tipo:'alerta'}); });
  ev.sort((a, b) => a.data < b.data ? -1 : a.data > b.data ? 1 : 0);
  const linha = ev.length ? sec('st', 'Histórico desde a abertura', '<ol class="timeline">' + ev.map(x => '<li class="' + x.tipo + '"><time>' + dataBR(x.data) + '</time><span>' + esc(x.texto) + '</span></li>').join('') +
    '<li class="hoje"><time>' + dataBR(iso(today())) + '</time><span>Hoje: ' + esc(v.titulo.toLowerCase()) + '</span></li></ol>') : '';

  const d = s.divida;
  const divida = d && d.inscricoes.length ? sec('sd', 'Dívida ativa da União e do FGTS',
    '<div class="tablewrap"><table class="tbl"><thead><tr><th>Inscrição</th><th>Origem</th><th>Receita</th><th class="money">Valor</th><th>Situação</th></tr></thead><tbody>' +
    d.inscricoes.map(i => '<tr><td class="num">' + esc(i.numero) + '</td><td>' + esc(i.origem) + '</td><td>' + esc(i.receita || '') + '</td><td class="num money">' + reais(i.valor) + '</td><td>' + esc(i.situacao || '') + (i.ajuizado ? ' · ajuizada' : '') + '</td></tr>').join('') +
    '</tbody></table></div><p class="hint" style="margin-top:12px">Total: <b>' + reais(d.total) + '</b>. Fonte: ' + esc(d.fonte) + ', base do ' + esc(d.trimestre) + '. Para pagar ou parcelar, use o Regularize da PGFN.</p>') : '';

  const meiSec = s.mei && s.mei.length ? sec('sm', 'DAS-MEI mês a mês',
    '<p class="sub" style="margin:0 0 12px">A guia do MEI vence todo dia 20. Sem a conexão com a Receita, o sistema não sabe se você pagou: marque cada mês.</p>' +
    '<ul class="meilist">' + s.mei.map(m => {
      const chipM = m.status === 'pago' ? '<span class="chip pago"><i></i>Pago</span>' : m.status === 'nao_pago' ? '<span class="chip atrasado"><i></i>' + (m.vencida ? 'Não pago, atrasado' : 'Não pago') + '</span>' : m.vencida ? '<span class="chip neutro"><i></i>Confirme</span>' : '<span class="chip avencer"><i></i>A vencer</span>';
      const bt = (st, txt, cls) => '<button class="btn ' + cls + ' sm" data-action="das-mei" data-c="' + m.competencia + '" data-s="' + st + '">' + txt + '</button>';
      return '<li class="meirow"><div class="grow"><b>' + esc(nomeComp(m.competencia)) + '</b><small>Vence ' + dataBR(m.vencimento) + (m.valor ? ' · ' + reais(m.valor) + ' (valor da tabela)' : '') + '</small></div>' + chipM +
        '<div class="meibtns">' + (m.status !== 'pago' ? bt('pago', 'Paguei', 'soft') : '') + (m.status !== 'nao_pago' ? bt('nao_pago', 'Não paguei', 'ghost') : '') + '</div></li>';
    }).join('') + '</ul>' +
    '<div class="actions" style="justify-content:flex-start;margin-top:14px"><a class="btn primary" href="' + OFICIAL.pgmei.url + '" target="_blank" rel="noopener">Conferir e pagar no PGMEI (site da Receita)</a><button class="btn ghost" data-action="copiar-cnpj" data-cnpj="' + esc(fmtCnpj(e.cnpj || '')) + '">' + ic('copy', 16) + 'Copiar CNPJ</button></div>' +
    '<p class="hint" style="margin-top:10px">No portal do Simples Nacional, entre em PGMEI. Use sempre o endereço receita.fazenda.gov.br: existem sites falsos de DAS. Se a guia vencer em feriado, pague no dia útil anterior.</p>') : '';
  const p = s.procuracao;
  const passos = sec('autorizar', 'Autorizar a consulta de tributos e guias', p.conectada
    ? '<p>Autorização registrada. As guias e pendências federais são consultadas no e-CAC automaticamente.</p>'
    : '<p class="sub" style="margin:0 0 14px">Por lei (sigilo fiscal), guias, pagamentos e pendências da Receita só podem ser lidos com a autorização do dono do CNPJ. É grátis e feito por você no site da Receita.</p>' +
      '<ol class="steps">' +
      '<li class="step"><span class="sn">1</span><div><b>Entre no e-CAC</b><p class="hint">Use sua conta gov.br (nível prata ou ouro), em cav.receita.fazenda.gov.br.</p></div></li>' +
      '<li class="step"><span class="sn">2</span><div><b>Abra "Procuração para e-CAC"</b><p class="hint">No menu Senhas e Procurações, escolha cadastrar uma procuração eletrônica.</p></div></li>' +
      '<li class="step"><span class="sn">3</span><div><b>Informe o FiscoFácil como procurador</b><p class="hint">' + (p.procuradorCnpj ? 'CNPJ do procurador: <b class="num">' + esc(fmtCnpj(p.procuradorCnpj)) + '</b>.' : 'O CNPJ do FiscoFácil ainda não foi configurado no servidor.') + ' Marque os serviços do Simples Nacional, situação fiscal e pagamentos, e escolha a validade.</p></div></li>' +
      '<li class="step"><span class="sn">4</span><div><b>Volte aqui e conecte</b><p class="hint">' + (p.servicoConfigurado ? 'O sistema confere a autorização e passa a consultar sozinho.' : 'A consulta automática à Receita ainda está sendo contratada pelo FiscoFácil. Sua autorização fica pronta para quando ela for ligada.') + '</p></div></li>' +
      '</ol><div class="actions" style="justify-content:flex-start;margin-top:14px"><button class="btn primary" data-action="conectar" data-emp="' + e.id + '">' + ic('plug', 18) + 'Já autorizei, conectar</button></div>');

  const cnpjF = fmtCnpj(e.cnpj || '');
  const atalhos = sec('sa', 'Atalhos oficiais', '<p class="sub" style="margin:0 0 12px">Sites do governo para conferir, emitir guias e tirar certidões. Os sites pedem o CNPJ: copie aqui e cole lá.</p>' +
    '<div class="cnpjcopy"><span class="num">' + esc(cnpjF) + '</span><button class="btn ghost sm" data-action="copiar-cnpj" data-cnpj="' + esc(cnpjF) + '">' + ic('copy', 16) + 'Copiar CNPJ</button></div>' +
    '<ul class="atalhos">' + L.todos.map(l => '<li><a href="' + l.url + '" target="_blank" rel="noopener"><span><b>' + esc(l.txt) + '</b><small>' + esc(l.desc) + '</small></span>' + ic('right', 16) + '</a></li>').join('') + '</ul>' +
    '<p class="hint" style="margin-top:10px">Os links de estado e prefeitura abrem uma busca, porque cada um tem o seu site. Confira sempre se o endereço termina em .gov.br.</p>');
  const limites = '<p class="hint sitlimits">Esta verificação não cobre: ' + s.naoCobre.map(esc).join('; ') + '.</p>';
  return head('Situação da empresa', esc(e.nome) + ' · ' + esc(fmtCnpj(e.cnpj || '')), '<button class="btn ghost" data-action="sit-atualizar">Atualizar agora</button>') +
    veredito + numerosInicio() + '<div class="cols" style="margin-top:20px"><div class="stack">' + lista + divida + meiSec + passos + '</div><div class="stack">' + dados + atalhos + linha + '</div></div>' + limites;
}


/* ---------- Menu enxuto: 5 telas, sem informação repetida ---------- */
NAV.splice(0, NAV.length, ['inicio','Início','home'], ['guias','Guias e pagamentos','wallet'], ['documentos','Documentos','folder'], ['empresas','Minhas empresas','building'], ['configuracoes','Configurações','gear']);
PAGES.splice(0, PAGES.length, ...NAV.map(n => n[0]));
const ALIAS = {situacao:'inicio', relatorios:'inicio', assistente:'inicio', calendario:'guias'};
route = function(){
  let h = (location.hash || '').replace('#', '');
  if (h === 'calendario') ui.gv = 'cal';
  h = ALIAS[h] || h;
  ui.page = PAGES.indexOf(h) > -1 || h === 'integracoes' ? h : 'inicio';
};
pgInicio = function(){ return pgSituacao(); };
/** Três números que resumem as guias cadastradas (o resto da tela vem das fontes oficiais). */
function numerosInicio(){
  const st = stats(), mesNome = MESES[today().getMonth()].toLowerCase();
  const kp = (icone, tom, rot, sub, val, vt) => '<div class="card kpi"><span class="kicon ' + tom + '">' + icone + '</span><div><div class="klabel">' + rot + '</div><div class="ksub">' + sub + '</div><div class="kval' + (vt ? ' ' + vt : '') + '">' + val + '</div></div></div>';
  return '<div class="kpis kpis3" style="margin-top:20px">' +
    kp(ic('alert', 24), 'bad', 'Total pendente', 'guias em aberto', brl(st.totalPend), st.totalPend ? 'bad' : '') +
    kp(ic('calendar', 24), 'brand', 'Vencem em 7 dias', st.prox7.length === 1 ? 'guia' : 'guias', st.prox7.length) +
    kp(ic('check', 24), 'ok', 'Pago em ' + mesNome, 'pagamentos registrados', brl(st.pagosMes), 'ok') + '</div>';
}
/* Guias e calendário na mesma tela, com um seletor. */
ui.gv = ui.gv || 'lista';
const _pgGuias = pgGuias;
pgGuias = function(){ return ui.gv === 'cal' ? pgCal() : _pgGuias(); };
ACT.gv = el => { ui.gv = el.dataset.v; renderMain(); };
const _rmEnxuto = renderMain;
renderMain = function(){
  _rmEnxuto();
  if (ui.page === 'guias' && S.empresas.length) {
    const ph = $('#main .pagehead');
    if (ph) ph.insertAdjacentHTML('beforeend', '<div class="seg" role="group" aria-label="Ver como"><button data-action="gv" data-v="lista" aria-pressed="' + (ui.gv !== 'cal') + '">Lista</button><button data-action="gv" data-v="cal" aria-pressed="' + (ui.gv === 'cal') + '">Calendário</button></div>');
  }
};
/* Barra do celular: as mesmas 5 telas, sem "Mais". */
renderTab = function(){
  if (!S.empresas.length) return;
  const tabs = [['inicio','Início','home'], ['guias','Guias','wallet'], ['documentos','Documentos','folder'], ['empresas','Empresas','building'], ['configuracoes','Ajustes','gear']];
  $('#tabbar').innerHTML = tabs.map(n => '<a href="#' + n[0] + '"' + (ui.page === n[0] ? ' aria-current="page"' : '') + '>' + ic(n[2], 22) + n[1] + '</a>').join('');
};
