"""Gera public/index.html a partir da tela base + camada de API. Uso: python3 frontend/build.py"""
import pathlib
root = pathlib.Path(__file__).parent
s = (root / 'fiscofacil.base.html').read_text()
layer = (root / 'api-layer.js').read_text()

def sub(a, b, count=1):
    global s
    assert a in s, 'não achei: ' + a[:60]
    s = s.replace(a, b, count)

sub("let S = load();", "let S = {v:1, user:{nome:''}, empresas:[], empresaId:null, obrigacoes:[], docs:[], lembretes:{email:true, whatsapp:false, push:false, antecedencia:'7'}};")
sub("function save(){ try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) {} }", "function save(){}")
sub("receita:'Receita Federal (simulada)'", "receita:'Receita Federal (Integra Contador)'")
sub("Receita conectada (simulada)", "Receita conectada")
sub("Conectada (simulada)", "Conectada")
sub(" + ' (simulada).' : 'Com a autorização", " + '.' : 'Com a autorização")
sub("MVP: a conexão é simulada. Nenhum certificado ou senha é pedido nem guardado.", "A consulta usa a autorização (procuração) dada à Receita. Nenhum certificado ou senha é pedido nem guardado aqui.")
sub("' (simulada)' : 'segundo os dados", "'' : 'segundo os dados")
sub("MVP: a conexão é simulada. Nunca pedimos a senha do gov.br e nenhum certificado é enviado ou guardado aqui.", "Nunca pedimos a senha do gov.br e nenhum certificado é enviado ou guardado aqui. A consulta usa a autorização (procuração) dada no e-CAC.")
sub("Simular conexão", "Conectar")
sub("No MVP só o nome, o tipo e o tamanho do arquivo são guardados. O conteúdo não é enviado nem armazenado.", "Os arquivos ficam guardados no servidor e só a sua conta consegue abri-los.")
sub("Só o nome do arquivo é guardado no MVP.", "O arquivo é enviado e guardado no servidor.")
sub("No MVP os lembretes ainda não são enviados. Esta tela mostra como a configuração ficaria.", "Os avisos por e-mail são enviados pelo servidor (precisa de e-mail configurado em Integrações). WhatsApp e notificação no celular ainda não são enviados.")
sub("'Simulação sem IA real: responde com os dados cadastrados aqui.'", "'Responde com os dados cadastrados aqui. Confirme sempre com o seu contador.'")
sub("const tipos = ['Todos','Guia','Comprovante','Nota fiscal','Outros'];", "const tipos = ['Todos','Guia','Comprovante','Certidão','Nota fiscal','Outros'];")
sub("t === 'Nota fiscal' ? 'Notas fiscais' : 'Outros'", "t === 'Certidão' ? 'Certidões' : t === 'Nota fiscal' ? 'Notas fiscais' : 'Outros'")
sub("esc(d.tipo) + ' · ' + fmtDate(d.data)", "esc(d.tipo) + (d.validade ? ' · válida até ' + fmtDate(d.validade) + (d.validade < iso(today()) ? ' (VENCIDA)' : '') : '') + ' · ' + fmtDate(d.data)")
sub("  return out;\n}\nfunction renderSide", "  S.docs.filter(d => d.empresaId === S.empresaId && d.validade).forEach(d => { const k = diffDays(d.validade, t); if (k < 0) out.push({k:'bad', txt:'Certidão vencida em ' + fmtDate(d.validade) + ': ' + d.nome}); else if (k <= 30) out.push({k:'warn', txt:'Certidão vence ' + rel(d.validade) + ': ' + d.nome}); });\n  (S.alertas || []).filter(a => !a.lido && a.empresaId === S.empresaId).forEach(a => out.push({k: a.nivel === 'alerta' ? 'bad' : 'warn', txt: a.texto}));\n  return out;\n}\nfunction renderSide")
# ---- Situação fiscal ----
sub("['inicio','Início','home'],", "['inicio','Início','home'],['situacao','Situação fiscal','shield'],")
sub("relatorios:pgRel,", "relatorios:pgRel, situacao:pgSituacao,")
sub("  plug:'", "  shield:'<path d=\"M12 3l8 3v6c0 4.6-3.4 8.4-8 9-4.6-.6-8-4.4-8-9V6z\"/><path d=\"M9 12l2 2 4-4\"/>',\n  plug:'")
sub("const tabs = [['inicio','Início','home'],['calendario','Calendário','calendar'],", "const tabs = [['inicio','Início','home'],['situacao','Situação','shield'],")
sub("[['empresas','Minhas empresas','building'],['assistente'", "[['empresas','Minhas empresas','building'],['calendario','Calendário','calendar'],['assistente'")
# ---- versão limpa e responsiva ----
ICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 30 30'%3E%3Crect width='30' height='30' rx='7' fill='%230F1847'/%3E%3Crect x='6' y='16' width='4.5' height='8' rx='1.2' fill='%237FA2FF'/%3E%3Crect x='12.75' y='11' width='4.5' height='13' rx='1.2' fill='%235B8CFF'/%3E%3Crect x='19.5' y='6' width='4.5' height='18' rx='1.2' fill='%232F5BEA'/%3E%3C/svg%3E"
sub('<meta name="claude:viewport-fit-sides" content="cover">', '<!doctype html>\n<html lang="pt-BR">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n<meta name="theme-color" content="#0F1847">\n<meta name="description" content="Acompanhe a situação fiscal, os vencimentos e as guias das suas empresas.">\n<link rel="icon" href="' + ICON + '">')
sub("""'<button class="ib" id="phoneBtn" data-action="phone" aria-pressed="' + ui.phone + '" aria-label="Ver como celular">' + ic('phone') + '</button>' +""", "")
sub("NAV.map(n => '<a href=\"#' + n[0] + '\"' + (ui.page === n[0]", "NAV.map(n => '<a href=\"#' + n[0] + '\" title=\"' + n[1] + '\"' + (ui.page === n[0]")
sub("if (t.id === 'empresa') {", "if (t.id === 'empresa' || t.id === 'empresaM') {")
# ---- refinamento visual (Impeccable) ----
n = s.count('</td><td class="num">\' + brl(o.valor)')
assert n == 2, n
s = s.replace('</td><td class="num">\' + brl(o.valor)', '</td><td class="num money">\' + brl(o.valor)')
assert s.count('<th>Valor</th>') == 2
s = s.replace('<th>Valor</th>', '<th class="money">Valor</th>')
sub("const L = guiasFiltered();", "const L = guiasFiltered().slice().sort((a, b) => (!!a.pagoEm - !!b.pagoEm) || (a.pagoEm ? (a.venc < b.venc ? 1 : -1) : (a.venc < b.venc ? -1 : 1)));")
sub('<span class="pill" aria-hidden="true">★ Novidade!</span><h2 id="pr" class="sr">Novidade: assistente fiscal</h2>', '<h2 id="pr">Tire dúvidas com o assistente</h2>')
css = (root / 'polish.css').read_text()
sub("</style>", css + "\n</style>")
# bloco "Dados do MVP" vira "Conta"
a = s.index("const dados = sec('cd', 'Dados do MVP'")
b = s.index("return head('Configurações'")
s = s[:a] + "const dados = sec('cd', 'Conta', '<p class=\"sub\" style=\"margin:0 0 12px\">Conectado como <b>' + esc(S.user.email || '') + '</b>. Os dados ficam guardados no servidor.</p><button class=\"btn ghost\" data-action=\"sair\">Sair</button>');\n  " + s[b:]
# INTEG estática some: a página usa os dados do servidor
a = s.index("const INTEG = [")
b = s.index("function pgInteg(){")
c = s.index("function pgCfg(){")
s = s[:a] + "function pgInteg(){ return ''; }\n" + s[c:]
# início: não carregar dados de exemplo, entrar pela tela de login
sub("route();\nrenderAll();\n})();", layer + "\nroute();\nif (token) iniciar(); else showAuth('login');\n})();")
(root.parent / 'public').mkdir(exist_ok=True)
(root.parent / 'public' / 'index.html').write_text(s)
print('ok', len(s))
