import yazl from '/home/claude/fiscofacil-api/node_modules/yazl/index.js';
import fs from 'node:fs';
const csv = 'CPF_CNPJ;TIPO_PESSOA;TIPO_DEVEDOR;NOME_DEVEDOR;UF_DEVEDOR;NUMERO_INSCRICAO;TIPO_SITUACAO_INSCRICAO;SITUACAO_INSCRICAO;RECEITA_PRINCIPAL;DATA_INSCRICAO;INDICADOR_AJUIZADO;VALOR_CONSOLIDADO\n' +
 '11.222.333/0001-81;Pessoa jurídica;PRINCIPAL;COMERCIO EXEMPLO ME;SP;80 4 25 012345-67;Em cobrança;ATIVA EM COBRANCA;Simples Nacional;12/06/2025;NAO;3.482,17\n' +
 '99.999.999/0001-91;Pessoa jurídica;PRINCIPAL;OUTRA;RJ;80 2 23 000002-02;Em cobrança;ATIVA;IRPJ;01/01/2023;SIM;999,99\n';
const z = new yazl.ZipFile(); z.addBuffer(Buffer.from(csv, 'latin1'), 'arquivo_lai_SIDA_SP.csv'); z.end();
z.outputStream.pipe(fs.createWriteStream('/tmp/mock/sida.zip')).on('close', () => console.log('zip ok'));
