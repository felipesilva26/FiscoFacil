/** Esquema do banco (PostgreSQL). Datas ficam como texto ISO (AAAA-MM-DD) e valores em centavos. */
export const SCHEMA = `
create table if not exists users (
  id text primary key,
  email text not null unique,
  nome text not null,
  senha_hash text not null,
  criado_em timestamptz not null default now()
);

create table if not exists empresas (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  nome text not null,
  cnpj text,
  regime text not null default 'Simples Nacional',
  receita_conectada boolean not null default false,
  receita_ultima timestamptz,
  cadastral jsonb,
  criado_em timestamptz not null default now()
);
create unique index if not exists empresas_user_cnpj on empresas (user_id, cnpj) where cnpj is not null;

create table if not exists obrigacoes (
  id text primary key,
  empresa_id text not null references empresas(id) on delete cascade,
  tributo text not null,
  venc text not null,
  valor_centavos integer not null check (valor_centavos > 0),
  pago_em text,
  arquivado boolean not null default false,
  codigo text not null default '',
  comprovante text not null default '',
  origem text not null default 'manual',
  criado_em timestamptz not null default now()
);
create index if not exists obrigacoes_empresa on obrigacoes (empresa_id, venc);

create table if not exists documentos (
  id text primary key,
  empresa_id text not null references empresas(id) on delete cascade,
  nome text not null,
  tipo text not null,
  tamanho integer not null,
  arquivo text not null,
  data text not null,
  criado_em timestamptz not null default now()
);
alter table documentos add column if not exists validade text;

create table if not exists config_lembretes (
  user_id text primary key references users(id) on delete cascade,
  email boolean not null default true,
  whatsapp boolean not null default false,
  push boolean not null default false,
  antecedencia integer not null default 7
);

create table if not exists lembretes_enviados (
  obrigacao_id text not null references obrigacoes(id) on delete cascade,
  dias_antes integer not null,
  enviado_em timestamptz not null default now(),
  primary key (obrigacao_id, dias_antes)
);

create table if not exists auditoria (
  id serial primary key,
  user_id text,
  empresa_id text,
  acao text not null,
  detalhe jsonb,
  criado_em timestamptz not null default now()
);

-- Dívida ativa da União e do FGTS (dados abertos da PGFN), só dos CNPJs cadastrados no sistema.
create table if not exists divida_ativa (
  cnpj text not null,
  origem text not null,            -- 'Não previdenciária' | 'Previdenciária' | 'FGTS'
  numero_inscricao text not null,
  tipo_devedor text,
  situacao text,
  tipo_situacao text,
  receita text,
  data_inscricao text,
  ajuizado boolean,
  valor_centavos bigint not null default 0,
  trimestre text not null,
  primary key (cnpj, origem, numero_inscricao)
);
create table if not exists pgfn_importacoes (
  trimestre text not null,
  origem text not null,
  arquivo text not null,
  linhas integer not null,
  encontrados integer not null,
  cnpjs_verificados integer not null,
  concluido_em timestamptz not null default now(),
  primary key (trimestre, origem)
);
-- CNPJs já conferidos contra cada trimestre (para saber se "nenhuma dívida" é resposta ou só falta conferir).
create table if not exists pgfn_verificados (
  cnpj text not null,
  trimestre text not null,
  origem text not null,
  primary key (cnpj, trimestre, origem)
);
create table if not exists alertas (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  empresa_id text references empresas(id) on delete cascade,
  nivel text not null,
  texto text not null,
  fonte text not null,
  lido boolean not null default false,
  criado_em timestamptz not null default now()
);

-- DAS-MEI: o que o dono informou sobre cada mês (enquanto não há conexão com a Receita).
create table if not exists das_mei_status (
  empresa_id text not null references empresas(id) on delete cascade,
  competencia text not null,
  status text not null,
  marcado_em timestamptz not null default now(),
  primary key (empresa_id, competencia)
);

-- Notas fiscais lidas dos documentos (emitidas = faturamento; recebidas = compras).
create table if not exists notas_fiscais (
  id text primary key,
  empresa_id text not null references empresas(id) on delete cascade,
  documento_id text references documentos(id) on delete set null,
  tipo text not null,
  chave text,
  numero text,
  serie text,
  data_emissao text not null,
  direcao text not null,
  contraparte_doc text,
  contraparte_nome text,
  valor_centavos bigint not null,
  impostos jsonb not null default '{}',
  criado_em timestamptz not null default now()
);
alter table users add column if not exists anonimo boolean not null default false;
alter table users add column if not exists ultimo_acesso timestamptz not null default now();
alter table users add column if not exists aceite_privacidade timestamptz;
alter table documentos add column if not exists conteudo bytea;
update users set anonimo = true where anonimo = false and email like 'visitante-%@fiscofacil.app';
create index if not exists notas_empresa_data on notas_fiscais (empresa_id, data_emissao);
create index if not exists auditoria_criado on auditoria (criado_em);
create unique index if not exists notas_chave_unica on notas_fiscais (empresa_id, chave) where chave is not null;
`;
