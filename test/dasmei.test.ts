import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { atividadeDe, valorDasMei, vencimentoDasMei } from '../src/services/dasmei.js';
import { CNPJ_TESTE, cadastrar, criar } from './helpers.js';

describe('DAS-MEI: regras', () => {
  test('vencimento dia 20 do mês seguinte, antecipado no fim de semana', () => {
    assert.equal(vencimentoDasMei('2026-10'), '2026-11-20'); // sexta
    assert.equal(vencimentoDasMei('2026-05'), '2026-06-19'); // 20/06 é sábado
    assert.equal(vencimentoDasMei('2026-08'), '2026-09-18'); // 20/09 é domingo
    assert.equal(vencimentoDasMei('2026-12'), '2027-01-20');
  });
  test('valores de 2026 (salário mínimo R$ 1.621)', () => {
    assert.equal(valorDasMei(2026, 'comercio'), 82.05);
    assert.equal(valorDasMei(2026, 'servicos'), 86.05);
    assert.equal(valorDasMei(2026, 'ambos'), 87.05);
    assert.equal(valorDasMei(1990, 'servicos'), null);
    assert.equal(atividadeDe({ cnae: '4751201' } as never), 'comercio');
    assert.equal(atividadeDe({ cnae: '6201501' } as never), 'servicos');
  });
});

describe('DAS-MEI: o dono confirma se pagou', () => {
  let t: Awaited<ReturnType<typeof criar>>;
  before(async () => { t = await criar({ agora: '2026-11-02T15:00:00Z' }); });
  after(async () => { await t.fechar(); });
  test('sem resposta fica "a conferir"; "não paguei" vira guia atrasada; "paguei" quita', async () => {
    const { h } = await cadastrar(t.app);
    const e = (await t.app.inject({ method: 'POST', url: '/api/empresas', headers: h, payload: { nome: 'Meu MEI', cnpj: CNPJ_TESTE, regime: 'MEI' } })).json();
    const s1 = (await t.app.inject({ method: 'GET', url: `/api/empresas/${e.id}/situacao`, headers: h })).json();
    const b1 = s1.blocos.find((b: { id: string }) => b.id === 'dasmei');
    assert.equal(b1.nivel, 'pendente'); assert.notEqual(s1.resumo.titulo, 'Tudo em dia');
    assert.equal(s1.mei[0].competencia, '2026-10'); assert.equal(s1.mei[0].vencimento, '2026-11-20'); assert.equal(s1.mei[0].vencida, false);
    assert.equal(s1.mei[1].competencia, '2026-09'); assert.equal(s1.mei[1].vencida, true);
    assert.equal(s1.blocos.find((b: { id: string }) => b.id === 'guias').nivel, 'pendente', 'sem guias não diz "em dia"');

    const s2 = (await t.app.inject({ method: 'POST', url: `/api/empresas/${e.id}/das-mei`, headers: h, payload: { competencia: '2026-09', status: 'nao_pago' } })).json();
    assert.equal(s2.blocos.find((b: { id: string }) => b.id === 'dasmei').nivel, 'alerta');
    assert.equal(s2.resumo.nivel, 'alerta');
    const ob = (await t.app.inject({ method: 'GET', url: `/api/empresas/${e.id}/obrigacoes`, headers: h })).json();
    assert.equal(ob.length, 1); assert.equal(ob[0].venc, '2026-10-20'); assert.equal(ob[0].valor, 86.05); assert.equal(ob[0].status, 'atrasado');

    await t.app.inject({ method: 'POST', url: `/api/empresas/${e.id}/das-mei`, headers: h, payload: { competencia: '2026-09', status: 'pago' } });
    const ob2 = (await t.app.inject({ method: 'GET', url: `/api/empresas/${e.id}/obrigacoes`, headers: h })).json();
    assert.equal(ob2[0].status, 'pago');
    assert.equal((await t.app.inject({ method: 'POST', url: `/api/empresas/${e.id}/das-mei`, headers: h, payload: { competencia: '2026-13', status: 'pago' } })).statusCode, 400);
  });
  test('empresa que não é MEI não tem o bloco e recusa a marcação', async () => {
    const { h } = await cadastrar(t.app);
    const e = (await t.app.inject({ method: 'POST', url: '/api/empresas', headers: h, payload: { nome: 'Ltda', cnpj: CNPJ_TESTE, regime: 'Lucro Presumido' } })).json();
    const s = (await t.app.inject({ method: 'GET', url: `/api/empresas/${e.id}/situacao`, headers: h })).json();
    assert.equal(s.mei, null); assert.ok(!s.blocos.some((b: { id: string }) => b.id === 'dasmei'));
    assert.equal((await t.app.inject({ method: 'POST', url: `/api/empresas/${e.id}/das-mei`, headers: h, payload: { competencia: '2026-09', status: 'pago' } })).statusCode, 409);
  });
});
