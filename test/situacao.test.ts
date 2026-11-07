import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { Readable } from 'node:stream';
import yazl from 'yazl';
import { avaliarCadastro, lookupCnpj } from '../src/cnpj.js';
import { dividir, filtrarCsv, importarPgfn, mapearColunas, trimestresCandidatos, valorEmCentavos } from '../src/pgfn/importador.js';
import { CNPJ_TESTE, cadastrar, criar } from './helpers.js';

const BRASILAPI = {
  cnpj: '66369868000171', razao_social: 'EMPRESA DE TESTE LTDA', nome_fantasia: '', descricao_situacao_cadastral: 'ATIVA', data_situacao_cadastral: '2019-03-10',
  data_inicio_atividade: '2019-03-10', cnae_fiscal: 6201501, cnae_fiscal_descricao: 'Desenvolvimento de programas de computador sob encomenda',
  descricao_tipo_logradouro: 'RUA', logradouro: 'DAS FLORES', numero: '100', bairro: 'CENTRO', cep: '01001000', municipio: 'SAO PAULO', uf: 'SP',
  descricao_porte: 'MICRO EMPRESA', natureza_juridica: 'Sociedade Empresária Limitada', capital_social: 10000,
  opcao_pelo_simples: true, data_opcao_pelo_simples: '2019-03-10', data_exclusao_do_simples: null, opcao_pelo_mei: false,
  cnaes_secundarias: [{ codigo: 6202300 }, { codigo: 0, descricao: '' }], qsa: [{}, {}],
};
const resposta = (j: unknown) => (async () => new Response(JSON.stringify(j), { status: 200 })) as unknown as typeof fetch;

describe('cadastro público', () => {
  test('mapeia campos e monta a linha do tempo', async () => {
    const c = await lookupCnpj(CNPJ_TESTE, { url: 'https://x/{cnpj}', fetchImpl: resposta(BRASILAPI) });
    assert.equal(c.situacao, 'ATIVA'); assert.equal(c.porte, 'MICRO EMPRESA'); assert.equal(c.simplesDesde, '2019-03-10');
    assert.equal(c.atividadesSecundarias, 1); assert.equal(c.socios, 2); assert.match(c.endereco!, /RUA DAS FLORES, 100/);
    assert.deepEqual(c.linhaDoTempo.map((e) => e.texto[0]), ['A', 'E', 'S']);
    assert.equal(avaliarCadastro(c).nivel, 'ok');
    assert.equal(avaliarCadastro({ ...c, situacao: 'INAPTA' }).nivel, 'alerta');
    assert.equal(avaliarCadastro(null).nivel, 'pendente');
  });
});

describe('consulta cadastral com várias fontes', () => {
  test('se a primeira fonte falha, usa a próxima; entende o formato do CNPJ.ws', async () => {
    const vistos: string[] = [];
    const fetchImpl = (async (url: string) => {
      vistos.push(url);
      if (url.startsWith('https://a/')) return new Response('bloqueado', { status: 403 });
      return new Response(JSON.stringify({ razao_social: 'EMPRESA WS LTDA', porte: { descricao: 'Micro Empresa' }, natureza_juridica: { descricao: 'Sociedade Limitada' },
        simples: { simples: 'Sim', data_opcao_simples: '2020-01-01', mei: 'Não' },
        estabelecimento: { situacao_cadastral: 'Ativa', data_inicio_atividade: '2020-01-01', atividade_principal: { id: '4751201', descricao: 'Comércio varejista de informática' },
          cidade: { nome: 'Campinas' }, estado: { sigla: 'SP' }, atividades_secundarias: [{ id: '4752100' }] }, socios: [{}] }));
    }) as unknown as typeof fetch;
    const logs: string[] = [];
    const c = await lookupCnpj(CNPJ_TESTE, { url: 'https://a/{cnpj}, https://publica.cnpj.ws/cnpj/{cnpj}', fetchImpl, log: (m) => logs.push(m) });
    assert.equal(vistos.length, 2); assert.match(logs[0], /HTTP 403/);
    assert.equal(c.razaoSocial, 'EMPRESA WS LTDA'); assert.equal(c.atividade, 'Comércio varejista de informática');
    assert.equal(c.simples, true); assert.equal(c.mei, false); assert.equal(c.uf, 'SP'); assert.equal(c.porte, 'Micro Empresa');
    assert.match(c.fonte, /CNPJ\.ws/);
  });
  test('404 em todas as fontes = não encontrado; erro em todas = indisponível', async () => {
    const f404 = (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch;
    await assert.rejects(lookupCnpj(CNPJ_TESTE, { url: 'https://a/{cnpj},https://b/{cnpj}', fetchImpl: f404 }), (e: { status: number }) => e.status === 404);
    const f500 = (async () => { throw new Error('rede'); }) as unknown as typeof fetch;
    await assert.rejects(lookupCnpj(CNPJ_TESTE, { url: 'https://a/{cnpj}', fetchImpl: f500 }), (e: { status: number }) => e.status === 502);
  });
});

describe('leitura da base da PGFN', () => {
  test('colunas pelo nome, aspas, valores e trimestres', async () => {
    const m = mapearColunas(['CPF_CNPJ', 'NÚMERO_INSCRIÇÃO', 'Valor Consolidado']);
    assert.equal(m.cnpj, 0); assert.equal(m.numeroInscricao, 1); assert.equal(m.valorCentavos, 2);
    assert.throws(() => mapearColunas(['A', 'B']), /Layout da PGFN/);
    assert.deepEqual(dividir('"a;b";c;"d ""e"""', ';'), ['a;b', 'c', 'd "e"']);
    assert.equal(valorEmCentavos('1.234,56'), 123456); assert.equal(valorEmCentavos('1234.5'), 123450); assert.equal(valorEmCentavos(''), 0);
    assert.deepEqual(trimestresCandidatos(new Date('2026-11-02T12:00:00Z'), 3), ['2026_trimestre_04', '2026_trimestre_03', '2026_trimestre_02']);
  });
  test('CSV em Windows-1252 só traz os CNPJs procurados', async () => {
    const csv = 'CPF_CNPJ;NOME_DEVEDOR;NUMERO_INSCRICAO;SITUACAO_INSCRICAO;RECEITA_PRINCIPAL;DATA_INSCRICAO;INDICADOR_AJUIZADO;VALOR_CONSOLIDADO\r\n' +
      '66.369.868/0001-71;EMPRESA DE TESTE;80 6 24 000001-01;ATIVA EM COBRANÇA;Simples Nacional;15/03/2024;NAO;1.500,00\r\n' +
      '11.222.333/0001-81;OUTRA;80 2 23 000002-02;ATIVA;IRPJ;01/01/2023;SIM;999,99\r\n';
    const r = await filtrarCsv(Readable.from([Buffer.from(csv, 'latin1')]), new Set(['66369868000171']));
    assert.equal(r.linhas, 2); assert.equal(r.achados.length, 1);
    assert.equal(r.achados[0].situacao, 'ATIVA EM COBRANÇA'); assert.equal(r.achados[0].dataInscricao, '2024-03-15');
    assert.equal(r.achados[0].valorCentavos, 150000); assert.equal(r.achados[0].ajuizado, false);
  });
});

function zipCom(csv: string): Promise<Buffer> {
  return new Promise((ok) => {
    const z = new yazl.ZipFile();
    z.addBuffer(Buffer.from(csv, 'latin1'), 'arquivo_lai_SIDA_SP.csv');
    z.end();
    const partes: Buffer[] = [];
    z.outputStream.on('data', (d: Buffer) => partes.push(d)).on('end', () => ok(Buffer.concat(partes)));
  });
}

describe('situação fiscal ponta a ponta', () => {
  let t: Awaited<ReturnType<typeof criar>>;
  let pedidos: string[] = [];
  let zip: Buffer;
  before(async () => {
    zip = await zipCom('CPF_CNPJ;NUMERO_INSCRICAO;SITUACAO_INSCRICAO;RECEITA_PRINCIPAL;DATA_INSCRICAO;INDICADOR_AJUIZADO;VALOR_CONSOLIDADO\n' +
      '66.369.868/0001-71;80 6 24 000001-01;ATIVA EM COBRANÇA;Simples Nacional;15/03/2024;NAO;1.500,00\n');
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      pedidos.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.startsWith('https://brasil/')) return new Response(JSON.stringify(BRASILAPI));
      const publicado = url.includes('2026_trimestre_03/Dados_abertos_Nao_Previdenciario.zip');
      if (init?.method === 'HEAD') return new Response(null, { status: publicado ? 200 : 404 });
      return publicado ? new Response(new Uint8Array(zip)) : new Response('nao', { status: 404 });
    }) as unknown as typeof fetch;
    t = await criar({ fetchImpl });
    t.ctx.cfg.cnpjLookupUrl = 'https://brasil/{cnpj}';
    t.ctx.cfg.pgfnBaseUrl = 'https://pgfn.teste';
    t.ctx.cfg.pgfnTmpDir = t.ctx.cfg.storageDir + '/pgfn';
  });
  after(async () => { await t.fechar(); });

  test('antes da importação: cadastro ok, dívida pendente; depois: alerta com aviso por e-mail', async () => {
    const { h } = await cadastrar(t.app);
    const e = (await t.app.inject({ method: 'POST', url: '/api/empresas', headers: h, payload: { nome: 'Teste', cnpj: CNPJ_TESTE, regime: 'Lucro Real' } })).json();
    const s1 = (await t.app.inject({ method: 'POST', url: `/api/empresas/${e.id}/situacao/atualizar`, headers: h })).json();
    assert.equal(s1.blocos.find((b: { id: string }) => b.id === 'cadastro').nivel, 'ok');
    assert.equal(s1.blocos.find((b: { id: string }) => b.id === 'divida').nivel, 'pendente');
    assert.equal(s1.cadastro.razaoSocial, 'EMPRESA DE TESTE LTDA');
    const reg = (await t.app.inject({ method: 'GET', url: `/api/empresas/${e.id}`, headers: h })).json();
    assert.equal(reg.regime, 'Simples Nacional', 'regime vem da Receita');
    const cn = (await t.app.inject({ method: 'GET', url: `/api/cnpj/${CNPJ_TESTE.replace(/\D/g, '')}`, headers: h })).json();
    assert.equal(cn.regime.regime, 'Simples Nacional'); assert.equal(cn.nome, 'EMPRESA DE TESTE LTDA');

    const r = await importarPgfn(t.ctx);
    assert.equal(r.trimestre, '2026_trimestre_03'); assert.equal(r.novas, 1);
    const s2 = (await t.app.inject({ method: 'GET', url: `/api/empresas/${e.id}/situacao`, headers: h })).json();
    const div = s2.blocos.find((b: { id: string }) => b.id === 'divida');
    assert.equal(div.nivel, 'alerta'); assert.match(div.texto, /1 inscrição/);
    assert.equal(s2.divida.total, 1500); assert.equal(s2.resumo.nivel, 'alerta');
    assert.ok(t.notifier.outbox.some((m) => /dívida ativa/.test(m.subject)));
    const al = (await t.app.inject({ method: 'GET', url: '/api/alertas', headers: h })).json();
    assert.equal(al.length, 1);

    pedidos = [];
    const r2 = await importarPgfn(t.ctx);
    assert.equal(r2.origens.length, 0, 'não baixa de novo o que já foi conferido');
    assert.ok(!pedidos.some((p) => p.startsWith('GET https://pgfn')));
  });

  test('outro usuário não vê situação nem alertas alheios', async () => {
    const a = await cadastrar(t.app); const b = await cadastrar(t.app);
    const e = (await t.app.inject({ method: 'POST', url: '/api/empresas', headers: a.h, payload: { nome: 'Da A', cnpj: CNPJ_TESTE } })).json();
    assert.equal((await t.app.inject({ method: 'GET', url: `/api/empresas/${e.id}/situacao`, headers: b.h })).statusCode, 404);
    assert.deepEqual((await t.app.inject({ method: 'GET', url: '/api/alertas', headers: b.h })).json(), []);
  });

  test('mudança de situação cadastral gera aviso', async () => {
    const { h } = await cadastrar(t.app);
    const e = (await t.app.inject({ method: 'POST', url: '/api/empresas', headers: h, payload: { nome: 'Muda', cnpj: CNPJ_TESTE } })).json();
    await t.app.inject({ method: 'POST', url: `/api/empresas/${e.id}/situacao/atualizar`, headers: h });
    BRASILAPI.descricao_situacao_cadastral = 'INAPTA';
    const s = (await t.app.inject({ method: 'POST', url: `/api/empresas/${e.id}/situacao/atualizar`, headers: h })).json();
    BRASILAPI.descricao_situacao_cadastral = 'ATIVA';
    assert.equal(s.blocos[0].nivel, 'alerta');
    const al = (await t.app.inject({ method: 'GET', url: '/api/alertas', headers: h })).json();
    assert.ok(al.some((x: { texto: string }) => /ATIVA para INAPTA/.test(x.texto)));
  });
});

describe('regime tributário pelo cadastro', () => {
  test('MEI, Simples e fora do Simples', async () => {
    const { regimePelaReceita, nomeSugerido } = await import('../src/cnpj.js');
    const base = { atividadesSecundarias: 0, socios: 0, linhaDoTempo: [], fonte: 'x', consultadoEm: '' };
    const mei = regimePelaReceita({ ...base, mei: true, meiDesde: '2026-04-21', simples: true, natureza: 'Empresário (Individual)' })!;
    assert.equal(mei.regime, 'MEI'); assert.equal(mei.texto, 'MEI desde 21/04/2026'); assert.deepEqual(mei.opcoes, []);
    const sn = regimePelaReceita({ ...base, mei: false, meiExclusao: '2025-12-31', simples: true, simplesDesde: '2019-03-10' })!;
    assert.equal(sn.regime, 'Simples Nacional'); assert.match(sn.historico[0], /Deixou de ser MEI em 31\/12\/2025/);
    const lucro = regimePelaReceita({ ...base, mei: false, simples: false })!;
    assert.equal(lucro.regime, null); assert.deepEqual(lucro.opcoes, ['Lucro Presumido', 'Lucro Real']);
    assert.equal(regimePelaReceita(null), null);
    assert.equal(regimePelaReceita({ ...base, mei: null, simples: null }), null);
    assert.equal(nomeSugerido({ ...base, mei: true, simples: true, razaoSocial: '66.369.868 RICHARDS FELIPE DO CARMO' }), 'RICHARDS FELIPE DO CARMO');
    assert.equal(nomeSugerido({ ...base, mei: true, simples: true, razaoSocial: '66369868 FULANO' }), 'FULANO');
  });
});
