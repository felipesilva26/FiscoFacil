import type { Config } from './config.js';

export interface ItemIntegracao {
  id: string;
  grupo: 'Federal' | 'Estadual' | 'Municipal' | 'Avisos' | 'Servidor';
  titulo: string;
  /** De onde vêm os dados quando a integração está ativa. */
  fonte: string;
  oficial: boolean;
  /** pronto = já funciona; pendente = falta algo; simulado = roda com dados fictícios. */
  status: 'pronto' | 'pendente' | 'simulado';
  /** Documentos e informações que preciso receber para ajustar e conectar. */
  precisa: string[];
  /** Como entregar com segurança. */
  entrega: string;
  /** Variáveis de ambiente do servidor (só o nome e se está preenchida; nunca o valor). */
  variaveis: { nome: string; configurada: boolean }[];
}

const v = (nome: string, valor: unknown) => ({ nome, configurada: Boolean(valor) });
const SEGURO = 'Segredos (senha, chave, certificado) NUNCA no chat: ficam só nas variáveis de ambiente do servidor. No chat vão apenas documentos públicos, textos e prints sem dados sensíveis.';

export function checklist(cfg: Config): ItemIntegracao[] {
  const s = cfg.serpro;
  const serproCompleto = [s.consumerKey, s.consumerSecret, s.authUrl, s.gatewayUrl, s.certPfxPath, s.certPassword, s.contratanteCnpj, s.sitfisSistema, s.sitfisServico, s.sitfisVersao].every(Boolean);
  return [
    {
      id: 'receita', grupo: 'Federal', titulo: 'Situação fiscal na Receita (Integra Contador / Serpro)', fonte: 'Receita Federal, pela plataforma oficial Integra Contador (Serpro)', oficial: true,
      status: cfg.receitaProvider === 'serpro' && serproCompleto ? 'pronto' : cfg.receitaProvider === 'mock' ? 'simulado' : 'pendente',
      precisa: [
        'Contrato do Integra Contador na Loja Serpro (trial ou produção) e qual ambiente usar',
        'Documentação oficial do contrato: catálogo de serviços com idSistema, idServico e versão do SITFIS (situação fiscal)',
        'Exemplo real de requisição e de resposta do SITFIS (pode ter os números mascarados), para eu interpretar as pendências',
        'Endereços (URL) de autenticação e do gateway do seu contrato',
        'CNPJ do contratante (quem assina o contrato)',
        'Confirmação de que o cliente deu procuração eletrônica no e-CAC (ou de qual modelo de autorização vocês usarão)',
      ],
      entrega: `Documentação e exemplos: anexar no chat. Chave/segredo do consumidor e certificado e-CNPJ (.pfx) com senha: só no servidor (SERPRO_*). ${SEGURO}`,
      variaveis: [
        v('RECEITA_PROVIDER=serpro', cfg.receitaProvider === 'serpro'), v('SERPRO_CONSUMER_KEY', s.consumerKey), v('SERPRO_CONSUMER_SECRET', s.consumerSecret),
        v('SERPRO_AUTH_URL', s.authUrl), v('SERPRO_GATEWAY_URL', s.gatewayUrl), v('SERPRO_CERT_PFX_PATH', s.certPfxPath), v('SERPRO_CERT_PASSWORD', s.certPassword),
        v('SERPRO_CONTRATANTE_CNPJ', s.contratanteCnpj), v('SERPRO_SITFIS_SISTEMA', s.sitfisSistema), v('SERPRO_SITFIS_SERVICO', s.sitfisServico), v('SERPRO_SITFIS_VERSAO', s.sitfisVersao), v('PROCURADOR_CNPJ', cfg.procuradorCnpj),
      ],
    },
    {
      id: 'pgfn', grupo: 'Federal', titulo: 'Dívida ativa da União e do FGTS (PGFN)', fonte: 'PGFN - dados abertos da dívida ativa (públicos, atualizados a cada trimestre)', oficial: true,
      status: 'pronto',
      precisa: ['Nada: os dados são públicos. O servidor baixa a base da PGFN de madrugada e cruza com os CNPJs cadastrados.', 'Para valores do dia (com juros) e débitos ainda não inscritos: Integra Contador com procuração, ou consulta no Regularize.'],
      entrega: 'Automático. Para rodar na hora: npm run pgfn:importar.',
      variaveis: [v('PGFN_BASE_URL', cfg.pgfnBaseUrl)],
    },
    {
      id: 'cnpj', grupo: 'Federal', titulo: 'Consulta cadastral por CNPJ (BrasilAPI)', fonte: 'Dados abertos da Receita Federal, repassados pela BrasilAPI (espelho de terceiro, só cadastro)', oficial: false, status: 'pronto',
      precisa: ['Nada. Só falta testar na sua máquina, porque o ambiente de desenvolvimento não acessa a internet.'],
      entrega: 'Rode o sistema e consulte o CNPJ de teste. Se falhar, me mande a mensagem de erro.',
      variaveis: [v('CNPJ_LOOKUP_URL', cfg.cnpjLookupUrl)],
    },
    {
      id: 'estadual', grupo: 'Estadual', titulo: 'ICMS e débitos estaduais (SEFAZ)', fonte: 'Secretaria da Fazenda (SEFAZ) do estado da empresa', oficial: true, status: 'pendente',
      precisa: [
        'Estado (UF) e inscrição estadual da empresa',
        'Regime de tributação (Simples, Lucro Presumido, Lucro Real) e se a empresa paga ICMS',
        'Se a SEFAZ do estado oferece API ou web service para contribuintes, com documentação (varia por estado; não há API nacional)',
        'Se não houver API: exemplo de certidão negativa e de guia de ICMS (PDF), para cadastro manual e alerta de validade',
      ],
      entrega: `PDFs e links da documentação no chat. ${SEGURO}`,
      variaveis: [],
    },
    {
      id: 'municipal', grupo: 'Municipal', titulo: 'ISS, taxas e débitos municipais (Prefeitura)', fonte: 'Prefeitura do município da empresa', oficial: true, status: 'pendente',
      precisa: [
        'Município e inscrição municipal da empresa',
        'Endereço do portal da prefeitura e como a empresa consulta débitos e emite guias',
        'Se há API ou nota fiscal eletrônica integrada (cada município é diferente)',
        'Exemplo de guia de ISS e de certidão negativa municipal',
      ],
      entrega: `PDFs e links no chat. ${SEGURO}`,
      variaveis: [],
    },
    {
      id: 'email', grupo: 'Avisos', titulo: 'Lembretes por e-mail', fonte: 'Seu servidor de e-mail (SMTP)', oficial: false, status: cfg.smtpUrl ? 'pronto' : 'pendente',
      precisa: ['Servidor SMTP para envio (host, porta, usuário, senha) e o endereço remetente'],
      entrega: `Preencher SMTP_URL e MAIL_FROM no servidor. ${SEGURO}`,
      variaveis: [v('SMTP_URL', cfg.smtpUrl), v('MAIL_FROM', cfg.mailFrom)],
    },
    {
      id: 'whatsapp', grupo: 'Avisos', titulo: 'Lembretes por WhatsApp', fonte: 'API oficial do WhatsApp Business (Meta)', oficial: true, status: 'pendente',
      precisa: [
        'Conta Meta Business com a API oficial do WhatsApp Business (paga por conversa)',
        'Número dedicado, modelos de mensagem aprovados pela Meta e consentimento dos usuários para receber',
      ],
      entrega: `Token da API só no servidor. ${SEGURO}`,
      variaveis: [],
    },
    {
      id: 'ia', grupo: 'Avisos', titulo: 'Assistente com IA', fonte: 'Anthropic (só recebe os dados da empresa selecionada)', oficial: false, status: cfg.anthropicKey ? 'pronto' : 'pendente',
      precisa: ['Chave de API da Anthropic (sem ela o assistente responde por regras simples)'],
      entrega: `ANTHROPIC_API_KEY no servidor. ${SEGURO}`,
      variaveis: [v('ANTHROPIC_API_KEY', cfg.anthropicKey)],
    },
    {
      id: 'servidor', grupo: 'Servidor', titulo: 'Hospedagem e banco de dados', fonte: 'Seu servidor e seu banco PostgreSQL', oficial: false, status: cfg.databaseUrl ? 'pronto' : 'pendente',
      precisa: ['Onde vai hospedar (por exemplo a Hostinger), domínio, banco PostgreSQL (DATABASE_URL) e JWT_SECRET com 32+ caracteres'],
      entrega: `Variáveis no painel da hospedagem. ${SEGURO}`,
      variaveis: [v('DATABASE_URL', cfg.databaseUrl), v('JWT_SECRET', cfg.env !== 'production' ? false : true), v('CORS_ORIGIN', cfg.corsOrigin.length)],
    },
  ];
}
