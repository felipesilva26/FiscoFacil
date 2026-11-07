import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { CNPJ_TESTE, cadastrar, criar } from './helpers.js';
import { nfeXml } from './notas.test.js';
import { limparDadosAntigos } from '../src/routes/conta.js';

const MEU = '66369868000171', CLIENTE = '11222333000181';
const envio = (nome: string, conteudo: string | Buffer) => {
  const b = '----ff';
  return { 'content-type': `multipart/form-data; boundary=${b}`, payload: Buffer.concat([Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${nome}"\r\nContent-Type: application/octet-stream\r\n\r\n`), Buffer.from(conteudo), Buffer.from(`\r\n--${b}--\r\n`)]) };
};

describe('isolamento entre contas com o mesmo CNPJ', () => {
  let t: Awaited<ReturnType<typeof criar>>;
  before(async () => { t = await criar(); });
  after(async () => { await t.fechar(); });

  test('B não lê, altera nem apaga nada de A, mesmo cadastrando o mesmo CNPJ', async () => {
    const A = await cadastrar(t.app, 'Ana'); const B = await cadastrar(t.app, 'Bruno');
    const inj = (h: Record<string, string>, method: string, url: string, payload?: unknown) => t.app.inject({ method: method as never, url, headers: h, payload: payload as never });
    const ea = (await inj(A.h, 'POST', '/api/empresas', { nome: 'Empresa da Ana', cnpj: CNPJ_TESTE, regime: 'MEI' })).json();
    const eb = (await inj(B.h, 'POST', '/api/empresas', { nome: 'Empresa do Bruno', cnpj: CNPJ_TESTE, regime: 'MEI' })).json();
    assert.ok(ea.id && eb.id && ea.id !== eb.id);
    const o = (await inj(A.h, 'POST', `/api/empresas/${ea.id}/obrigacoes`, { tributo: 'DAS', venc: '2026-11-20', valor: 82.05 })).json();
    await inj(A.h, 'POST', `/api/obrigacoes/${o.id}/pagar`, { data: '2026-10-30' });
    const m = envio('n.xml', nfeXml({ emit: MEU, dest: CLIENTE, numero: 9, valor: '5000.00', data: '2026-10-01' }));
    const n = (await t.app.inject({ method: 'POST', url: `/api/empresas/${ea.id}/notas/importar`, headers: { ...A.h, 'content-type': m['content-type'] }, payload: m.payload })).json();
    const docs = (await inj(A.h, 'GET', `/api/empresas/${ea.id}/documentos`)).json();
    assert.equal(docs.length, 1);

    // Tudo que é de A, acessado por B: 404 (não revela nem que existe).
    const tentativas: [string, string, unknown?][] = [
      ['GET', `/api/empresas/${ea.id}`], ['PATCH', `/api/empresas/${ea.id}`, { nome: 'hack' }], ['DELETE', `/api/empresas/${ea.id}`],
      ['GET', `/api/empresas/${ea.id}/obrigacoes`], ['POST', `/api/empresas/${ea.id}/obrigacoes`, { tributo: 'DAS', venc: '2026-12-20', valor: 1 }],
      ['PATCH', `/api/obrigacoes/${o.id}`, { valor: 1 }], ['POST', `/api/obrigacoes/${o.id}/desfazer-pagamento`], ['DELETE', `/api/obrigacoes/${o.id}`],
      ['GET', `/api/empresas/${ea.id}/documentos`], ['GET', `/api/documentos/${docs[0].id}/arquivo`], ['DELETE', `/api/documentos/${docs[0].id}`],
      ['GET', `/api/empresas/${ea.id}/notas`], ['GET', `/api/empresas/${ea.id}/financeiro`], ['DELETE', `/api/notas/${n.nota.id}`],
      ['POST', `/api/empresas/${ea.id}/notas`, { tipo: 'Venda sem nota', dataEmissao: '2026-10-01', direcao: 'emitida', valor: 1 }],
      ['GET', `/api/empresas/${ea.id}/situacao`], ['POST', `/api/empresas/${ea.id}/das-mei`, { competencia: '2026-10', status: 'pago' }],
      ['GET', `/api/empresas/${ea.id}/resumo`], ['GET', `/api/empresas/${ea.id}/calendario`],
    ];
    for (const [met, url, body] of tentativas) {
      const r = await inj(B.h, met, url, body);
      assert.equal(r.statusCode, 404, `${met} ${url} devolveu ${r.statusCode}`);
    }
    // Documento de B não pode apontar para documento de A.
    assert.equal((await inj(B.h, 'POST', `/api/empresas/${eb.id}/notas`, { documentoId: docs[0].id, tipo: 'NF-e', dataEmissao: '2026-10-01', direcao: 'emitida', valor: 1 })).statusCode, 400);

    // A mesma nota (mesma chave) pode existir nas duas contas sem uma ver a da outra.
    const mb = envio('n.xml', nfeXml({ emit: MEU, dest: CLIENTE, numero: 9, valor: '5000.00', data: '2026-10-01' }));
    assert.equal((await t.app.inject({ method: 'POST', url: `/api/empresas/${eb.id}/notas/importar`, headers: { ...B.h, 'content-type': mb['content-type'] }, payload: mb.payload })).json().repetida, false);

    const fb = (await inj(B.h, 'GET', `/api/empresas/${eb.id}/financeiro?ano=2026`)).json();
    assert.equal(fb.faturamento.total, 5000); assert.equal(fb.impostosPagos, 0);
    const fa = (await inj(A.h, 'GET', `/api/empresas/${ea.id}/financeiro?ano=2026`)).json();
    assert.equal(fa.impostosPagos, 82.05); assert.equal(fa.impostos[0].tributo, 'DAS');
    assert.deepEqual((await inj(B.h, 'GET', '/api/empresas')).json().map((e: { id: string }) => e.id), [eb.id]);

    const exp = JSON.stringify((await inj(B.h, 'GET', '/api/conta/exportar')).json());
    assert.ok(!exp.includes(ea.id) && !exp.includes(o.id) && !exp.includes('Ana'), 'exportação de B não contém nada de A');

    // A exclui a conta: some tudo de A; B continua intacto.
    assert.equal((await inj(A.h, 'DELETE', '/api/conta', { confirmar: 'sim' })).statusCode, 400);
    assert.equal((await inj(A.h, 'DELETE', '/api/conta', { confirmar: 'EXCLUIR' })).statusCode, 204);
    for (const tab of ['empresas', 'obrigacoes', 'documentos', 'notas_fiscais']) {
      const col = tab === 'empresas' ? 'id' : 'empresa_id';
      assert.equal((await t.ctx.db.query(`select count(*)::int as n from ${tab} where ${col} = $1`, [ea.id])).rows[0].n, 0, tab);
    }
    assert.equal((await inj(A.h, 'GET', '/api/auth/me')).statusCode, 401);
    assert.equal((await inj(B.h, 'GET', `/api/empresas/${eb.id}/notas`)).json().notas.length, 1);
  });

  test('arquivo enviado fica no banco e volta igual', async () => {
    const A = await cadastrar(t.app);
    const e = (await t.app.inject({ method: 'POST', url: '/api/empresas', headers: A.h, payload: { nome: 'Arq', cnpj: CNPJ_TESTE } })).json();
    const m = envio('a.txt', 'conteúdo de teste');
    const d = (await t.app.inject({ method: 'POST', url: `/api/empresas/${e.id}/documentos?tipo=Outros`, headers: { ...A.h, 'content-type': m['content-type'] }, payload: m.payload })).json();
    const r = await t.app.inject({ method: 'GET', url: `/api/documentos/${d.id}/arquivo`, headers: A.h });
    assert.equal(r.statusCode, 200); assert.equal(r.body, 'conteúdo de teste');
  });
});

describe('conta sem cadastro, sessão e LGPD', () => {
  let t: Awaited<ReturnType<typeof criar>>;
  before(async () => { t = await criar(); });
  after(async () => { await t.fechar(); });

  test('sem aceite não cria; anônima renova, vira conta com e-mail e não recebe e-mail', async () => {
    assert.equal((await t.app.inject({ method: 'POST', url: '/api/auth/anonimo', payload: {} })).statusCode, 400);
    assert.equal((await t.app.inject({ method: 'POST', url: '/api/auth/register', payload: { nome: 'X', email: 'x@y.com', senha: 'senha-forte-123' } })).statusCode, 400);
    const r = (await t.app.inject({ method: 'POST', url: '/api/auth/anonimo', payload: { aceite: true } })).json();
    const h = { authorization: `Bearer ${r.token}` };
    const me = (await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: h })).json();
    assert.equal(me.anonimo, true); assert.equal(me.email, null);
    const nv = (await t.app.inject({ method: 'POST', url: '/api/auth/renovar', headers: h })).json();
    assert.ok(nv.token);
    // Conta anônima não entra por login com o e-mail interno.
    const { rows } = await t.ctx.db.query('select email from users where id = $1', [me.id]);
    assert.equal((await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: rows[0].email, senha: 'qualquer' } })).statusCode, 401);
    const p = await t.app.inject({ method: 'POST', url: '/api/auth/proteger', headers: h, payload: { nome: 'Richard', email: 'richard@teste.com', senha: 'senha-forte-123' } });
    assert.equal(p.statusCode, 200);
    assert.equal((await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'richard@teste.com', senha: 'senha-forte-123' } })).statusCode, 200);
    assert.equal((await t.app.inject({ method: 'POST', url: '/api/auth/proteger', headers: h, payload: { nome: 'Rafa', email: 'r2@teste.com', senha: 'senha-forte-123' } })).statusCode, 409);
  });

  test('retenção: conta sem cadastro parada há 90 dias é apagada; com cadastro não', async () => {
    const a = (await t.app.inject({ method: 'POST', url: '/api/auth/anonimo', payload: { aceite: true } })).json();
    const c = await cadastrar(t.app);
    await t.ctx.db.query("update users set ultimo_acesso = now() - interval '100 days'");
    const r = await limparDadosAntigos(t.ctx);
    assert.ok(r.contas >= 1);
    assert.equal((await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${a.token}` } })).statusCode, 401);
    assert.equal((await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: c.h })).statusCode, 200);
  });

  test('cabeçalhos de segurança e política de privacidade', async () => {
    const r = await t.app.inject({ method: 'GET', url: '/api/health' });
    assert.match(String(r.headers['content-security-policy']), /default-src 'self'/);
    assert.match(String(r.headers['content-security-policy']), /script-src 'self' 'sha256-/);
    const p = await t.app.inject({ method: 'GET', url: '/privacidade.html' });
    assert.equal(p.statusCode, 200); assert.match(p.body, /LGPD/); assert.ok(!p.body.includes('{{'));
  });
});
