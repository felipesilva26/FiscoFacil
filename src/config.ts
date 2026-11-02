export interface SerproConfig {
  ambiente: string;
  consumerKey: string;
  consumerSecret: string;
  authUrl: string;
  gatewayUrl: string;
  certPfxPath: string;
  certPassword: string;
  contratanteCnpj: string;
  sitfisSistema: string;
  sitfisServico: string;
  sitfisVersao: string;
}

export interface Config {
  env: string;
  port: number;
  databaseUrl?: string;
  databaseSchema?: string;
  /** Versão de teste: cada navegador ganha uma conta anônima, sem tela de login. */
  semLogin: boolean;
  dataDir: string;
  storageDir: string;
  jwtSecret: string;
  corsOrigin: string[];
  smtpUrl?: string;
  mailFrom: string;
  anthropicKey?: string;
  assistantModel: string;
  cnpjLookupUrl: string;
  receitaProvider: 'mock' | 'serpro' | 'none';
  serpro: SerproConfig;
  pgfnBaseUrl: string;
  pgfnTmpDir: string;
  /** CNPJ que recebe a procuração dos clientes no e-CAC (o do FiscoFácil). */
  procuradorCnpj: string;
  /** Só para testes: sobe o limite de tentativas de login/cadastro por minuto. */
  limiteAuth?: number;
}

type Env = Record<string, string | undefined>;

export function loadConfig(env: Env = process.env): Config {
  const prod = env.NODE_ENV === 'production';
  const secret = env.JWT_SECRET?.trim() ?? '';
  if (prod && !env.DATABASE_URL?.trim() && env.PERMITIR_BANCO_TEMPORARIO !== '1') {
    throw new Error('DATABASE_URL é obrigatório em produção (sem ele os dados se perderiam a cada reinício).');
  }
  if (prod && secret.length < 32) {
    throw new Error('JWT_SECRET é obrigatório em produção e precisa ter 32 ou mais caracteres.');
  }
  const provider = env.RECEITA_PROVIDER === 'serpro' ? 'serpro' : env.RECEITA_PROVIDER === 'mock' ? 'mock' : 'none';
  const e = (k: string) => env[k]?.trim() ?? '';
  return {
    env: env.NODE_ENV ?? 'development',
    port: Number(env.PORT ?? 3000),
    databaseUrl: e('DATABASE_URL') || undefined,
    databaseSchema: e('DATABASE_SCHEMA') || undefined,
    semLogin: e('SEM_LOGIN') === '1',
    dataDir: e('DATA_DIR') || './data/pgdata',
    storageDir: e('STORAGE_DIR') || './data/arquivos',
    jwtSecret: secret || 'chave-somente-para-desenvolvimento-nao-use-em-producao',
    corsOrigin: e('CORS_ORIGIN').split(',').map((s) => s.trim()).filter(Boolean),
    smtpUrl: e('SMTP_URL') || undefined,
    mailFrom: e('MAIL_FROM') || 'FiscoFácil <nao-responder@localhost>',
    anthropicKey: e('ANTHROPIC_API_KEY') || undefined,
    assistantModel: e('ASSISTANT_MODEL') || 'claude-sonnet-5-5',
    cnpjLookupUrl: e('CNPJ_LOOKUP_URL') || 'https://brasilapi.com.br/api/cnpj/v1/{cnpj},https://minhareceita.org/{cnpj},https://publica.cnpj.ws/cnpj/{cnpj}',
    receitaProvider: provider,
    pgfnBaseUrl: (e('PGFN_BASE_URL') || 'https://dadosabertos.pgfn.gov.br').replace(/\/$/, ''),
    pgfnTmpDir: e('PGFN_TMP_DIR') || './data/pgfn-tmp',
    procuradorCnpj: e('PROCURADOR_CNPJ') || e('SERPRO_CONTRATANTE_CNPJ'),
    serpro: {
      ambiente: e('SERPRO_AMBIENTE') || 'trial',
      consumerKey: e('SERPRO_CONSUMER_KEY'),
      consumerSecret: e('SERPRO_CONSUMER_SECRET'),
      authUrl: e('SERPRO_AUTH_URL'),
      gatewayUrl: e('SERPRO_GATEWAY_URL'),
      certPfxPath: e('SERPRO_CERT_PFX_PATH'),
      certPassword: e('SERPRO_CERT_PASSWORD'),
      contratanteCnpj: e('SERPRO_CONTRATANTE_CNPJ'),
      sitfisSistema: e('SERPRO_SITFIS_SISTEMA'),
      sitfisServico: e('SERPRO_SITFIS_SERVICO'),
      sitfisVersao: e('SERPRO_SITFIS_VERSAO'),
    },
  };
}
