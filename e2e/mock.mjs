import http from 'node:http'; import fs from 'node:fs';
const base = (cnpj, nome, extra) => ({ cnpj, razao_social: nome, descricao_situacao_cadastral: 'ATIVA', data_situacao_cadastral: '2019-03-10', data_inicio_atividade: '2019-03-10', cnae_fiscal: 6201501, cnae_fiscal_descricao: 'Desenvolvimento de programas de computador sob encomenda', descricao_tipo_logradouro: 'RUA', logradouro: 'DAS FLORES', numero: '100', bairro: 'CENTRO', cep: '01001000', municipio: 'SAO PAULO', uf: 'SP', descricao_porte: 'MICRO EMPRESA', natureza_juridica: 'Sociedade Empresária Limitada', opcao_pelo_simples: true, data_opcao_pelo_simples: '2019-03-10', opcao_pelo_mei: false, qsa: [{}, {}], ...extra });
const db = { '66369868000171': base('66369868000171', 'EMPRESA DE TESTE LTDA (FICTICIA)', {}),
  '11222333000181': base('11222333000181', 'COMERCIO EXEMPLO ME (FICTICIA)', { data_inicio_atividade: '2021-08-02', data_situacao_cadastral: '2021-08-02', descricao_porte: 'MICRO EMPRESA', opcao_pelo_simples: false, opcao_pelo_mei: true, data_opcao_pelo_mei: '2021-08-02', natureza_juridica: 'Empresário (Individual)', qsa: [{}] }) };
http.createServer((req, res) => {
  const m = req.url.match(/^\/cnpj\/(\d+)/);
  if (m) { const j = db[m[1]]; res.writeHead(j ? 200 : 404, { 'content-type': 'application/json' }); return res.end(j ? JSON.stringify(j) : '{}'); }
  if (req.url === '/2026_trimestre_03/Dados_abertos_Nao_Previdenciario.zip') { res.writeHead(200); return req.method === 'HEAD' ? res.end() : fs.createReadStream('/tmp/mock/sida.zip').pipe(res); }
  res.writeHead(404); res.end();
}).listen(3112, () => console.log('mock 3112'));
