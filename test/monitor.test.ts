import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { mapearCadastro } from '../src/cnpj.js';
import { compararCadastro, rodarMonitor, rodarMonitorSeVencido, verificarCertidoes } from '../src/services/monitor.js';
import { CNPJ_TESTE, cadastrar, criar } from './helpers.js';

const BASE = {
  razao_social: 'EMPRESA DE TESTE LTDA', descricao_situacao_cadastral: 'ATIVA', data_situacao_cadastral: '2019-03-10', data_inicio_atividade: '2019-03-10',
  cnae_fiscal: 6201501, cnae_fiscal_descricao: 'Desenvolvimento de programas de computador sob encomenda',
  descricao_tipo_logradouro: 'RUA', logradouro: 'DAS FLORES', numero: '100', bairro: 'CENTRO', cep: '01001000', municipio: 'SAO PAULO', uf: 'SP',
  descricao_porte: 'MICRO EMPRESA', natureza_juridica: 'Sociedade Empresária Limitada', capital_social: 10000,
  opcao_pelo_simples: true, data_opcao_pelo_simples: '2019-03-10', opcao_pelo_mei: false, cnaes_secundarias: [], qsa: [{}, {}],
};
const cad = (o: Record<string, unknown> = {}) => mapearCadastro({ ...BASE, ...o }, 'teste');

describe('comparação do cadastro', () => {
  test('sem retrato anterior não há mudança (primeira consulta é só referência)', () => {
    assert.deepEqual(compararCadastro(null, cad()), []);
  });
  test('igual a si mesmo: nada mudou', () => {
    assert.deepEqual(compararCadastro(cad(), cad()), []);
  });
  test('situação irregular e saída do Simples são vermelhas; volta a ATIVA é verde', () => {
    const m = compararCadastro(cad(), cad({ descricao_situacao_cadastral: 'INAPTA', opcao_pelo_simples: false }));
    assert.deepEqual(m.map((x) => [x.campo, x.gravidade]), [['situacao', 'alerta'], ['simples', 'alerta']]);
    assert.match(m[0].texto, /de ATIVA para INAPTA/);
    const volta = compararCadastro(cad({ descricao_situacao_cadastral: 'INAPTA' }), cad());
    assert.equal(volta[0].gravidade, 'info'); assert.match(volta[0].texto, /voltou a ATIVA/);
  });
  test('endereço, atividade, porte, sócios e razão social são amarelos', () => {
    const m = compararCadastro(cad(), cad({ logradouro: 'DAS ROSAS', cnae_fiscal_descricao: 'Outra atividade', descricao_porte: 'EMPRESA DE PEQUENO PORTE', qsa: [{}, {}, {}], razao_social: 'NOVA RAZAO LTDA' }));
    assert.deepEqual(m.map((x) => x.campo).sort(), ['atividade', 'endereco', 'porte', 'razaoSocial', 'socios']);
    assert.ok(m.every((x) => x.gravidade === 'atencao'));
  });
  test('campo que não existia antes não vira "mudança"', () => {
    assert.deepEqual(compararCadastro(cad({ descricao_porte: undefined }), cad()), []);
  });
});

describe('robô de monitoramento ponta a ponta', () => {
  let t: Awaited<ReturnType<typeof criar>>;
  let resposta: Record<string, unknown> = { ...BASE };
  let consultas = 0;
  let agora = '2026-11-01T15:00:00Z';
  before(async () => {
    t = await criar({ fetchImpl: (async () => { consultas++; return new Response(JSON.stringify(resposta)); }) as unknown as typeof fetch });
    t.ctx.cfg.cnpjLookupUrl = 'https://brasil/{cnpj}';
    t.ctx.now = () => new Date(agora);
  });
  after(async () => { await t.fechar(); });

  test('1ª rodada só guarda a referência; 2ª detecta a mudança, registra e avisa uma vez', async () => {
    const { h } = await cadastrar(t.app);
    const e = (await t.app.inject({ method: 'POST', url: '/api/empresas', headers: h, payload: { nome: 'Minha Empresa', cnpj: CNPJ_TESTE } })).json();
    const r1 = await rodarMonitor(t.ctx, { forcar: true });
    assert.equal(r1.ocupado, false);
    let sit = (await t.app.inject({ method: 'GET', url: `/api/empresas/${e.id}/situacao`, headers: h })).json();
    assert.deepEqual(sit.monitor.mudancas, []);
    assert.ok(sit.monitor.ultimaRodada);
    assert.equal(t.notifier.outbox.length, 0);

    resposta = { ...BASE, descricao_situacao_cadastral: 'SUSPENSA', logradouro: 'DAS ROSAS' };
    agora = '2026-11-02T15:00:00Z';
    const r2 = await rodarMonitor(t.ctx);
    assert.equal(r2.ocupado, false);
    if (!r2.ocupado) { assert.equal(r2.empresas, 1); assert.equal(r2.mudancas, 2); assert.equal(r2.falhas, 0); }
    sit = (await t.app.inject({ method: 'GET', url: `/api/empresas/${e.id}/situacao`, headers: h })).json();
    assert.equal(sit.monitor.mudancas.length, 2);
    assert.ok(sit.monitor.mudancas.some((m: { campo: string; gravidade: string }) => m.campo === 'situacao' && m.gravidade === 'alerta'));
    const al = (await t.app.inject({ method: 'GET', url: '/api/alertas', headers: h })).json();
    assert.equal(al.length, 2);
    assert.equal(t.notifier.outbox.length, 1, 'um e-mail só, com as duas mudanças');
    assert.match(t.notifier.outbox[0].text, /ATIVA para SUSPENSA/); assert.match(t.notifier.outbox[0].text, /endereço/);

    // Rodar de novo sem mudança no governo não repete nada.
    agora = '2026-11-03T15:00:00Z';
    const r3 = await rodarMonitor(t.ctx);
    assert.equal(r3.ocupado, false);
    if (!r3.ocupado) assert.equal(r3.mudancas, 0);
    assert.equal(t.notifier.outbox.length, 1);
  });

  test('não consulta de novo quem foi consultado há menos de 20 horas, e só roda se a última rodada é antiga', async () => {
    const antes = consultas;
    await rodarMonitor(t.ctx); // acabou de consultar na rodada anterior
    assert.equal(consultas, antes);
    assert.equal(await rodarMonitorSeVencido(t.ctx), null, 'rodou há pouco: nada a fazer');
    agora = '2026-11-05T15:00:00Z';
    assert.notEqual(await rodarMonitorSeVencido(t.ctx), null);
  });

  test('uma fonte fora do ar conta como falha e não derruba a rodada', async () => {
    const t2 = await criar({ fetchImpl: (async () => { throw new Error('rede'); }) as unknown as typeof fetch });
    t2.ctx.cfg.cnpjLookupUrl = 'https://brasil/{cnpj}';
    const { h } = await cadastrar(t2.app);
    await t2.app.inject({ method: 'POST', url: '/api/empresas', headers: h, payload: { nome: 'Empresa X', cnpj: CNPJ_TESTE } });
    const r = await rodarMonitor(t2.ctx, { forcar: true });
    assert.equal(r.ocupado, false);
    if (!r.ocupado) { assert.equal(r.falhas, 1); assert.equal(r.empresas, 0); }
    await t2.fechar();
  });

  test('certidão: avisa nos marcos 15, 7, 3 dias e vencida, uma vez cada; nova certidão cala a antiga', async () => {
    const { h } = await cadastrar(t.app);
    const e = (await t.app.inject({ method: 'POST', url: '/api/empresas', headers: h, payload: { nome: 'Com certidão', cnpj: CNPJ_TESTE } })).json();
    const doc = async (nome: string, validade: string) => {
      const id = 'd' + Math.random().toString(36).slice(2);
      await t.ctx.db.query("insert into documentos (id, empresa_id, nome, tipo, tamanho, arquivo, data, validade) values ($1,$2,$3,'Certidão',1,'x','2026-11-01',$4)", [id, e.id, nome, validade]);
      return id;
    };
    agora = '2026-11-10T12:00:00Z';
    await doc('CND federal', '2026-11-20');             // 10 dias: marco 15
    assert.equal(await verificarCertidoes(t.ctx), 1);
    assert.equal(await verificarCertidoes(t.ctx), 0, 'mesmo marco não repete');
    agora = '2026-11-14T12:00:00Z';                       // 6 dias: marco 7
    assert.equal(await verificarCertidoes(t.ctx), 1);
    agora = '2026-11-18T12:00:00Z';                       // 2 dias: marco 3
    assert.equal(await verificarCertidoes(t.ctx), 1);
    agora = '2026-11-21T12:00:00Z';                       // vencida
    assert.equal(await verificarCertidoes(t.ctx), 1);
    const al = (await t.app.inject({ method: 'GET', url: '/api/alertas', headers: h })).json();
    assert.equal(al.filter((a: { texto: string }) => /CND federal/.test(a.texto)).length, 4);
    assert.ok(al.some((a: { nivel: string; texto: string }) => a.nivel === 'alerta' && /venceu em 20\/11\/2026/.test(a.texto)));
    // Anexou uma certidão nova da mesma: a antiga não gera mais aviso.
    await doc('CND federal', '2027-05-01');
    agora = '2026-12-01T12:00:00Z';
    assert.equal(await verificarCertidoes(t.ctx), 0);
  });

  test('alertas de um usuário não aparecem para outro', async () => {
    const outro = await cadastrar(t.app);
    assert.deepEqual((await t.app.inject({ method: 'GET', url: '/api/alertas', headers: outro.h })).json(), []);
  });
});
