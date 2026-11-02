# FiscoFácil API

Backend do FiscoFácil: contas, várias empresas (CNPJ) por usuário, obrigações e vencimentos, pagamentos, documentos, lembretes por e-mail, assistente e integração com a Receita.

## Tela
O backend já serve a tela em `http://localhost:3000/` (pasta `public/`). Crie uma conta, cadastre a empresa e use. Para regenerar a tela depois de mexer em `frontend/`: `python3 frontend/build.py`. Teste no navegador: `node e2e/e2e.cjs` (precisa de Playwright e do servidor rodando na porta 3111).

## Situação fiscal (fontes oficiais)
| Bloco | Fonte | Como chega |
|---|---|---|
| Cadastro (situação, abertura, Simples/MEI e datas, porte, atividade, endereço) e histórico | Dados abertos da Receita Federal, via BrasilAPI | Automático ao cadastrar e a cada 7 dias; avisa se a situação mudar ou se sair do Simples/MEI |
| Dívida ativa da União e do FGTS | Dados abertos da PGFN (`dadosabertos.pgfn.gov.br`, trimestral) | Automático de madrugada (`npm run pgfn:importar` roda na hora). Avisa nova inscrição por e-mail e no sino |
| Guias, pagamentos e pendências federais | Receita Federal pelo Integra Contador (Serpro) | Precisa de contrato do FiscoFácil e procuração eletrônica de cada cliente no e-CAC |
| ICMS e ISS | Estados e prefeituras | Sem API nacional: certidão anexada (lida automaticamente) |

Testado com respostas simuladas (o ambiente de desenvolvimento não acessa a internet). O layout das colunas da PGFN é detectado pelo cabeçalho; na primeira importação real, confira o log.

## Formatos de tela
- **Celular (até 700px):** barra superior, menu inferior (Início, Situação, Guias, Documentos, Mais), uma coluna, tabelas viram cartões, seletor de empresa no topo de cada tela, campos de 16px (sem zoom no iPhone) e alvos de toque de 44px.
- **Tablet (701 a 1179px):** menu lateral só com ícones, tabelas em grade de cartões no tablet em pé, duas colunas no tablet deitado.
- **Computador (1180px ou mais):** menu lateral completo, conteúdo limitado a 1440px em telas grandes.

## Versão limpa
O sistema começa vazio: a pessoa cria a conta e informa só o CNPJ. Nome, situação e regime vêm do cadastro público da Receita, e ela confirma. `npm run seed` é opcional e só para testes.

## Rodar (desenvolvimento)
```bash
npm install
cp .env.example .env
npm run seed     # cria teste@fiscofacil.local / teste1234 com o CNPJ de teste 66.369.868/0001-71
npm run dev      # http://localhost:3000/api/health
npm test         # 12 testes
```
Sem `DATABASE_URL` usa um PostgreSQL embutido (PGlite) gravado em `./data/pgdata`.

## Produção
Defina `NODE_ENV=production`, `DATABASE_URL` (PostgreSQL), `JWT_SECRET` (32+ caracteres), `CORS_ORIGIN`, `SMTP_URL`. `docker build -t fiscofacil-api .`

## O que é real e o que é simulado
| Parte | Estado |
|---|---|
| Contas, empresas, obrigações, pagamentos, documentos, calendário, resumo consolidado | Real, testado |
| Lembretes por e-mail | Real (precisa de `SMTP_URL`); sem SMTP escreve no log. WhatsApp/push: só preferência salva |
| Consulta cadastral por CNPJ | Real via BrasilAPI (dados abertos da Receita). Só cadastro, **não traz débitos**. Testada só com resposta simulada |
| Situação fiscal / débitos (padrão `RECEITA_PROVIDER=none`) | **Não configurado**: o sistema não inventa dados, mostra o que falta. `mock` existe só para demonstração e marca tudo como simulado |
| Situação fiscal real (`RECEITA_PROVIDER=serpro`) | **Esqueleto não validado**: exige contrato Integra Contador e procuração no e-CAC; endpoints/ids vêm do `.env` e o layout precisa ser conferido |
| Leitura de documentos PDF (guia, comprovante, certidão) | Real, mas heurística: só PDF com texto (não lê imagem/escaneado), ajustada com PDFs de teste. Sempre mostra uma sugestão para a pessoa conferir antes de salvar |
| Assistente | Regras locais; com `ANTHROPIC_API_KEY` usa IA só com os dados da empresa |

## Segurança
Credenciais (certificado, chaves) só em variáveis de ambiente do servidor, nunca em chat ou no código. Toda rota confere que o recurso é do usuário logado. Senhas com scrypt, JWT HS256, limite de tentativas, upload com lista de extensões e checagem de conteúdo, log sem o cabeçalho de autorização.

## Rotas principais
`POST /api/auth/register|login`, `GET /api/auth/me`; `/api/empresas` (CRUD), `/api/resumo`, `/api/empresas/:id/{resumo,calendario,obrigacoes,documentos}`; `POST /api/empresas/:id/receita/{conectar,sincronizar,desconectar}`; `PATCH|DELETE /api/obrigacoes/:id`, `POST /api/obrigacoes/:id/{pagar,desfazer-pagamento}`; `GET /api/cnpj/:cnpj`; `GET|PUT /api/lembretes/config`, `POST /api/lembretes/executar`; `POST /api/assistente`.
