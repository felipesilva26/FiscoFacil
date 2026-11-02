import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { validCnpj } from '../src/cnpj.js';
import { SemReceita } from '../src/receita/provider.js';
import { CNPJ_TESTE, cadastrar, criar } from './helpers.js';

type T = Awaited<ReturnType<typeof criar>>;
let t: T;
before(async () => { t = await criar(); });
after(async () => { await t.fechar(); });

const post = (url: string, h: Record<string, string>, payload?: unknown) => t.app.inject({ method: 'POST', url, headers: h, payload: payload as object });

describe('CNPJ', () => {
  test('o CNPJ de teste do projeto é válido e um inventado não', () => {
    assert.equal(validCnpj(CNPJ_TESTE), true);
    assert.equal(validCnpj('11.111.111/1111-11'), false);
    assert.equal(validCnpj('66.369.868/0001-72'), false);
  });
});

describe('autenticação', () => {
  test('cadastro, login e /me; senha errada e e-mail repetido são recusados', async () => {
    const r = await t.app.inject({ method: 'POST', url: '/api/auth/register', payload: { nome: 'Bia', email: 'bia@teste.com', senha: 'senha-forte-123' } });
    assert.equal(r.statusCode, 201);
    const dup = await t.app.inject({ method: 'POST', url: '/api/auth/register', payload: { nome: 'Bia', email: 'bia@teste.com', senha: 'senha-forte-123' } });
    assert.equal(dup.statusCode, 409);
    const ruim = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'bia@teste.com', senha: 'errada' } });
    assert.equal(ruim.statusCode, 401);
    const ok = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'bia@teste.com', senha: 'senha-forte-123' } });
    const me = await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${ok.json().token}` } });
    assert.equal(me.json().email ?? me.json().usuario?.email, 'bia@teste.com');
  });
  test('sem token ou senha curta é recusado', async () => {
    assert.equal((await t.app.inject({ method: 'GET', url: '/api/empresas' })).statusCode, 401);
    const r = await t.app.inject({ method: 'POST', url: '/api/auth/register', payload: { nome: 'X', email: 'x@teste.com', senha: '123' } });
    assert.equal(r.statusCode, 400);
  });
});

describe('limite de tentativas', () => {
  test('bloqueia o login depois de 10 tentativas por minuto', async () => {
    const x = await criar({ limiteAuth: 10 });
    try {
      let ultimo = 0;
      for (let i = 0; i < 12; i++) ultimo = (await x.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'a@a.com', senha: 'x' } })).statusCode;
      assert.equal(ultimo, 429);
    } finally { await x.fechar(); }
  });
});

describe('empresas e obrigações', () => {
  test('fluxo completo com o CNPJ de teste', async () => {
    const { h } = await cadastrar(t.app);
    const bad = await post('/api/empresas', h, { nome: 'Teste', cnpj: '12.345.678/0001-00' });
    assert.equal(bad.statusCode, 400);
    const e = await post('/api/empresas', h, { nome: 'Empresa de Teste', cnpj: CNPJ_TESTE, regime: 'Simples Nacional' });
    assert.equal(e.statusCode, 201);
    const id = e.json().id;
    assert.equal((await post('/api/empresas', h, { nome: 'Outra', cnpj: CNPJ_TESTE })).statusCode, 409);

    const o = await post(`/api/empresas/${id}/obrigacoes`, h, { tributo: 'DAS', venc: '2026-11-05', valor: 1234.56 });
    assert.equal(o.statusCode, 201);
    assert.equal(o.json().valor, 1234.56);
    await post(`/api/empresas/${id}/obrigacoes`, h, { tributo: 'FGTS', venc: '2026-10-20', valor: 500 });
    assert.equal((await post(`/api/empresas/${id}/obrigacoes`, h, { tributo: 'DAS', venc: '2026-02-30', valor: 10 })).statusCode, 400);
    assert.equal((await post(`/api/empresas/${id}/obrigacoes`, h, { tributo: 'DAS', venc: '2026-11-05', valor: -5 })).statusCode, 400);

    const resumo = (await t.app.inject({ method: 'GET', url: `/api/empresas/${id}/resumo`, headers: h })).json();
    assert.equal(resumo.totalPendente, 1734.56);
    assert.equal(resumo.atrasadas, 1);
    assert.equal(resumo.proximos7Dias, 1);

    const pago = await post(`/api/obrigacoes/${o.json().id}/pagar`, h, { data: '2026-11-01' });
    assert.equal(pago.json().status, 'pago');
    assert.equal((await post(`/api/obrigacoes/${o.json().id}/pagar`, h, { data: '2027-01-01' })).statusCode, 400);
    const aposPago = (await t.app.inject({ method: 'GET', url: `/api/empresas/${id}/resumo`, headers: h })).json();
    assert.equal(aposPago.totalPendente, 500);
  });

  test('um usuário não enxerga nem mexe nos dados de outro', async () => {
    const a = await cadastrar(t.app, 'Alice');
    const b = await cadastrar(t.app, 'Bruno');
    const e = (await post('/api/empresas', a.h, { nome: 'Da A', cnpj: CNPJ_TESTE })).json();
    const o = (await post(`/api/empresas/${e.id}/obrigacoes`, a.h, { tributo: 'DAS', venc: '2026-11-10', valor: 100 })).json();
    for (const [m, url] of [['GET', `/api/empresas/${e.id}`], ['GET', `/api/empresas/${e.id}/obrigacoes`], ['GET', `/api/empresas/${e.id}/resumo`], ['DELETE', `/api/empresas/${e.id}`], ['DELETE', `/api/obrigacoes/${o.id}`], ['POST', `/api/obrigacoes/${o.id}/pagar`]] as const) {
      const r = await t.app.inject({ method: m, url, headers: b.h });
      assert.equal(r.statusCode, 404, `${m} ${url}`);
    }
    assert.deepEqual((await t.app.inject({ method: 'GET', url: '/api/empresas', headers: b.h })).json(), []);
    // o mesmo CNPJ pode existir na conta de outro usuário
    assert.equal((await post('/api/empresas', b.h, { nome: 'Da B', cnpj: CNPJ_TESTE })).statusCode, 201);
  });

  test('consolidado de várias empresas', async () => {
    const { h } = await cadastrar(t.app);
    const e1 = (await post('/api/empresas', h, { nome: 'Um', cnpj: CNPJ_TESTE })).json();
    const e2 = (await post('/api/empresas', h, { nome: 'Dois', cnpj: '11.222.333/0001-81' })).json();
    await post(`/api/empresas/${e1.id}/obrigacoes`, h, { tributo: 'DAS', venc: '2026-11-03', valor: 100 });
    await post(`/api/empresas/${e2.id}/obrigacoes`, h, { tributo: 'ISS', venc: '2026-10-01', valor: 50 });
    const r = (await t.app.inject({ method: 'GET', url: '/api/resumo', headers: h })).json();
    assert.equal(r.totais.empresas, 2);
    assert.equal(r.totais.totalPendente, 150);
    assert.equal(r.totais.atrasadas, 1);
  });
});

describe('Receita (simulada) e consulta cadastral', () => {
  test('conectar exige autorização, é idempotente e marca como simulado', async () => {
    const { h } = await cadastrar(t.app);
    const e = (await post('/api/empresas', h, { nome: 'Teste', cnpj: CNPJ_TESTE })).json();
    assert.equal((await post(`/api/empresas/${e.id}/receita/sincronizar`, h)).statusCode, 409);
    assert.equal((await post(`/api/empresas/${e.id}/receita/conectar`, h, { autorizacao: 'procuracao_ecac' })).statusCode, 400);
    const c = await post(`/api/empresas/${e.id}/receita/conectar`, h, { autorizacao: 'procuracao_ecac', confirmo: true });
    assert.equal(c.statusCode, 200);
    assert.equal(c.json().simulado, true);
    assert.ok(c.json().novas >= 1);
    const de = await post(`/api/empresas/${e.id}/receita/sincronizar`, h);
    assert.equal(de.json().novas, 0);
    const lista = (await t.app.inject({ method: 'GET', url: `/api/empresas/${e.id}/obrigacoes`, headers: h })).json();
    assert.ok(lista.every((o: { origem: string }) => o.origem === 'receita'));
    assert.equal((await post(`/api/empresas/${e.id}/receita/desconectar`, h)).json().conectada, false);
  });

  test('consulta cadastral usa a fonte injetada e recusa CNPJ inválido', async () => {
    const x = await criar({ fetchImpl: (async () => new Response(JSON.stringify({ razao_social: 'EMPRESA TESTE LTDA', descricao_situacao_cadastral: 'ATIVA', municipio: 'SAO PAULO', uf: 'SP' }), { status: 200 })) as typeof fetch });
    try {
      const { h } = await cadastrar(x.app);
      const ok = await x.app.inject({ method: 'GET', url: `/api/cnpj/${encodeURIComponent(CNPJ_TESTE)}`, headers: h });
      assert.equal(ok.statusCode, 200);
      assert.equal(ok.json().cadastral.razaoSocial, 'EMPRESA TESTE LTDA');
      const ruim = await x.app.inject({ method: 'GET', url: '/api/cnpj/123', headers: h });
      assert.equal(ruim.statusCode, 400);
    } finally { await x.fechar(); }
  });
});

describe('checklist de integrações', () => {
  test('lista o que falta, sem vazar valores de segredos', async () => {
    const { h } = await cadastrar(t.app);
    const r = await t.app.inject({ method: 'GET', url: '/api/integracoes', headers: h });
    assert.equal(r.statusCode, 200);
    const itens = r.json();
    assert.equal(itens.find((i: { id: string }) => i.id === 'receita').status, 'pendente');
    assert.ok(itens.every((i: { precisa: string[] }) => i.precisa.length > 0));
    assert.equal(JSON.stringify(itens).includes(t.ctx.cfg.jwtSecret), false);
    assert.equal((await t.app.inject({ method: 'GET', url: '/api/integracoes' })).statusCode, 401);
  });
});

describe('sem integração configurada', () => {
  test('não inventa dados: conectar devolve 503 e não cria obrigações', async () => {
    const x = await criar();
    x.ctx.receita = new SemReceita();
    try {
      const { h } = await cadastrar(x.app);
      const e = (await x.app.inject({ method: 'POST', url: '/api/empresas', headers: h, payload: { nome: 'Teste', cnpj: CNPJ_TESTE } })).json();
      const c = await x.app.inject({ method: 'POST', url: `/api/empresas/${e.id}/receita/conectar`, headers: h, payload: { autorizacao: 'procuracao_ecac', confirmo: true } });
      assert.equal(c.statusCode, 503);
      assert.ok(c.json().faltando.length > 0);
      const l = (await x.app.inject({ method: 'GET', url: `/api/empresas/${e.id}/obrigacoes`, headers: h })).json();
      assert.equal(l.length, 0);
    } finally { await x.fechar(); }
  });
});

describe('documentos', () => {
  const multipart = (nome: string, conteudo: Buffer) => {
    const b = '----ff';
    const corpo = Buffer.concat([Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${nome}"\r\nContent-Type: application/octet-stream\r\n\r\n`), conteudo, Buffer.from(`\r\n--${b}--\r\n`)]);
    return { payload: corpo, headers: { 'content-type': `multipart/form-data; boundary=${b}` } };
  };
  test('envia PDF, baixa, e recusa tipo trocado, extensão ruim e acesso de outro usuário', async () => {
    const a = await cadastrar(t.app);
    const b = await cadastrar(t.app);
    const e = (await post('/api/empresas', a.h, { nome: 'Doc', cnpj: CNPJ_TESTE })).json();
    const pdf = Buffer.from('%PDF-1.4\nteste');
    const m = multipart('guia.pdf', pdf);
    const up = await t.app.inject({ method: 'POST', url: `/api/empresas/${e.id}/documentos?tipo=Guia`, headers: { ...a.h, ...m.headers }, payload: m.payload });
    assert.equal(up.statusCode, 201);
    const dl = await t.app.inject({ method: 'GET', url: `/api/documentos/${up.json().id}/arquivo`, headers: a.h });
    assert.equal(dl.statusCode, 200);
    assert.deepEqual(dl.rawPayload, pdf);
    assert.equal((await t.app.inject({ method: 'GET', url: `/api/documentos/${up.json().id}/arquivo`, headers: b.h })).statusCode, 404);
    const falso = multipart('falso.pdf', Buffer.from('MZ nao sou pdf'));
    assert.equal((await t.app.inject({ method: 'POST', url: `/api/empresas/${e.id}/documentos`, headers: { ...a.h, ...falso.headers }, payload: falso.payload })).statusCode, 415);
    const exe = multipart('virus.exe', Buffer.from('x'));
    assert.equal((await t.app.inject({ method: 'POST', url: `/api/empresas/${e.id}/documentos`, headers: { ...a.h, ...exe.headers }, payload: exe.payload })).statusCode, 415);
    assert.equal((await t.app.inject({ method: 'DELETE', url: `/api/documentos/${up.json().id}`, headers: a.h })).statusCode, 204);
  });
});

describe('lembretes e assistente', () => {
  test('envia o aviso uma única vez e respeita a preferência de e-mail', async () => {
    const { h } = await cadastrar(t.app, 'Lia');
    const e = (await post('/api/empresas', h, { nome: 'Lembra', cnpj: CNPJ_TESTE })).json();
    await post(`/api/empresas/${e.id}/obrigacoes`, h, { tributo: 'DAS', venc: '2026-11-04', valor: 200 }); // em 3 dias
    await post(`/api/empresas/${e.id}/obrigacoes`, h, { tributo: 'ISS', venc: '2026-11-20', valor: 90 }); // longe: não avisa
    const antes = t.notifier.outbox.length;
    const r1 = (await post('/api/lembretes/executar', h)).json();
    assert.equal(r1.enviados, 1);
    assert.equal(t.notifier.outbox.length, antes + 1);
    const mail = t.notifier.outbox.at(-1)!;
    assert.match(mail.text, /DAS/);
    assert.doesNotMatch(mail.text, /ISS/);
    assert.equal((await post('/api/lembretes/executar', h)).json().enviados, 0);

    const put = await t.app.inject({ method: 'PUT', url: '/api/lembretes/config', headers: h, payload: { email: false, whatsapp: false, push: false, antecedencia: 7 } });
    assert.equal(put.statusCode, 200);
    await post(`/api/empresas/${e.id}/obrigacoes`, h, { tributo: 'FGTS', venc: '2026-11-02', valor: 10 });
    assert.equal((await post('/api/lembretes/executar', h)).json().enviados, 0);
    assert.equal((await t.app.inject({ method: 'PUT', url: '/api/lembretes/config', headers: h, payload: { email: true, whatsapp: false, push: false, antecedencia: 4 } })).statusCode, 400);
  });

  test('assistente responde por regras com os dados reais da empresa', async () => {
    const { h } = await cadastrar(t.app);
    const e = (await post('/api/empresas', h, { nome: 'Assist', cnpj: CNPJ_TESTE })).json();
    await post(`/api/empresas/${e.id}/obrigacoes`, h, { tributo: 'DAS', venc: '2026-10-10', valor: 321 });
    const r = await post('/api/assistente', h, { empresaId: e.id, pergunta: 'Tenho algo atrasado?' });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().origem, 'regras');
    assert.match(r.json().resposta, /DAS/);
    const outro = await cadastrar(t.app);
    assert.equal((await post('/api/assistente', outro.h, { empresaId: e.id, pergunta: 'Tenho algo atrasado?' })).statusCode, 404);
  });
});
