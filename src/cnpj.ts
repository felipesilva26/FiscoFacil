export const onlyDigits = (s: unknown): string => String(s ?? '').replace(/\D/g, '');

export function formatCnpj(s: unknown): string {
  return onlyDigits(s)
    .slice(0, 14)
    .replace(/^(\d{2})(\d)/, '$1.$2')
    .replace(/^(\d{2})\.(\d{3})(\d)/, '$1.$2.$3')
    .replace(/\.(\d{3})(\d)/, '.$1/$2')
    .replace(/(\d{4})(\d)/, '$1-$2');
}

/** Confere os 14 dígitos e os dois dígitos verificadores. */
export function validCnpj(v: unknown): boolean {
  const d = onlyDigits(v);
  if (d.length !== 14 || /^(\d)\1+$/.test(d)) return false;
  const dv = (n: number): number => {
    let sum = 0;
    let p = n - 7;
    for (let i = 0; i < n; i++) {
      sum += Number(d[i]) * p--;
      if (p < 2) p = 9;
    }
    const r = sum % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return dv(12) === Number(d[12]) && dv(13) === Number(d[13]);
}

export interface EventoCadastral {
  data: string; // AAAA-MM-DD
  texto: string;
  tipo: 'ok' | 'info' | 'alerta';
}

export interface Cadastral {
  razaoSocial?: string;
  nomeFantasia?: string;
  situacao?: string;
  situacaoDesde?: string;
  situacaoEspecial?: string;
  matrizFilial?: string;
  natureza?: string;
  porte?: string;
  capitalSocial?: number;
  atividade?: string;
  cnae?: string;
  atividadesSecundarias: number;
  endereco?: string;
  municipio?: string;
  uf?: string;
  abertura?: string;
  simples: boolean | null;
  simplesDesde?: string;
  simplesExclusao?: string;
  mei: boolean | null;
  meiDesde?: string;
  meiExclusao?: string;
  socios: number;
  linhaDoTempo: EventoCadastral[];
  fonte: string;
  consultadoEm: string;
}

export class CnpjError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

export interface LookupOptions {
  url: string; // modelo com {cnpj}
  fetchImpl: typeof fetch;
  now?: Date;
  timeoutMs?: number;
  log?: (msg: string) => void;
}

/**
 * Consulta de dados cadastrais (públicos) por CNPJ.
 * Não é a Receita direto: usa um espelho dos dados abertos (padrão: BrasilAPI). Não traz débitos.
 */
/** Converte o formato do CNPJ.ws para o formato da BrasilAPI / Minha Receita. */
function deCnpjWs(j: Record<string, any>): Record<string, unknown> {
  const e = j.estabelecimento ?? {};
  const sim = j.simples ?? {};
  const sn = (v: unknown) => (typeof v === 'string' ? /^s/i.test(v) : null);
  return {
    razao_social: j.razao_social, nome_fantasia: e.nome_fantasia, descricao_situacao_cadastral: e.situacao_cadastral,
    data_situacao_cadastral: e.data_situacao_cadastral, data_inicio_atividade: e.data_inicio_atividade,
    descricao_matriz_filial: e.tipo, natureza_juridica: j.natureza_juridica?.descricao, descricao_porte: j.porte?.descricao,
    capital_social: j.capital_social != null ? Number(j.capital_social) : undefined,
    cnae_fiscal: e.atividade_principal?.id, cnae_fiscal_descricao: e.atividade_principal?.descricao,
    cnaes_secundarias: (e.atividades_secundarias ?? []).map((x: { id?: string }) => ({ codigo: Number(x.id) || 0 })),
    descricao_tipo_logradouro: e.tipo_logradouro, logradouro: e.logradouro, numero: e.numero, bairro: e.bairro, cep: e.cep,
    municipio: e.cidade?.nome, uf: e.estado?.sigla,
    opcao_pelo_simples: sn(sim.simples), data_opcao_pelo_simples: sim.data_opcao_simples, data_exclusao_do_simples: sim.data_exclusao_simples,
    opcao_pelo_mei: sn(sim.mei), data_opcao_pelo_mei: sim.data_opcao_mei, data_exclusao_do_mei: sim.data_exclusao_mei,
    situacao_especial: e.situacao_especial, qsa: j.socios ?? [],
  };
}

function fonteDe(url: string): string {
  const h = (() => { try { return new URL(url).hostname; } catch { return url; } })();
  const nome = /brasilapi/.test(h) ? 'BrasilAPI' : /minhareceita/.test(h) ? 'Minha Receita' : /cnpj\.ws/.test(h) ? 'CNPJ.ws' : h;
  return `Dados abertos da Receita Federal, via ${nome}`;
}

export function mapearCadastro(bruto: Record<string, unknown>, fonte: string, now?: Date): Cadastral {
  const j = (bruto.estabelecimento ? deCnpjWs(bruto as Record<string, any>) : bruto) as Record<string, unknown>;
    const s = (k: string): string | undefined => (typeof j[k] === 'string' && (j[k] as string).trim() ? (j[k] as string).trim() : undefined);
    const b = (k: string): boolean | null => (typeof j[k] === 'boolean' ? (j[k] as boolean) : null);
    const data = (k: string): string | undefined => { const v = s(k); return v && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : undefined; };
    const natureza = s('natureza_juridica');
    const end = [s('descricao_tipo_logradouro'), s('logradouro')].filter(Boolean).join(' ') + (s('numero') ? ', ' + s('numero') : '') + (s('bairro') ? ' - ' + s('bairro') : '') + (s('cep') ? ' - CEP ' + s('cep') : '');
    const cad: Cadastral = {
      razaoSocial: s('razao_social'),
      nomeFantasia: s('nome_fantasia'),
      situacao: s('descricao_situacao_cadastral'),
      situacaoDesde: data('data_situacao_cadastral'),
      situacaoEspecial: s('situacao_especial'),
      matrizFilial: s('descricao_matriz_filial'),
      natureza,
      porte: s('descricao_porte') ?? s('porte'),
      capitalSocial: typeof j.capital_social === 'number' ? (j.capital_social as number) : undefined,
      atividade: s('cnae_fiscal_descricao'),
      cnae: j.cnae_fiscal != null ? String(j.cnae_fiscal) : undefined,
      atividadesSecundarias: Array.isArray(j.cnaes_secundarias) ? (j.cnaes_secundarias as unknown[]).filter((c) => (c as { codigo?: number })?.codigo).length : 0,
      endereco: end.trim() || undefined,
      municipio: s('municipio'),
      uf: s('uf'),
      abertura: data('data_inicio_atividade'),
      simples: b('opcao_pelo_simples'),
      simplesDesde: data('data_opcao_pelo_simples'),
      simplesExclusao: data('data_exclusao_do_simples'),
      mei: b('opcao_pelo_mei'),
      meiDesde: data('data_opcao_pelo_mei'),
      meiExclusao: data('data_exclusao_do_mei'),
      socios: Array.isArray(j.qsa) ? (j.qsa as unknown[]).length : 0,
      linhaDoTempo: [],
      fonte,
      consultadoEm: (now ?? new Date()).toISOString(),
    };
    cad.linhaDoTempo = linhaDoTempo(cad);
    return cad;
}

/**
 * Consulta de dados cadastrais (públicos) por CNPJ.
 * Não é a Receita direto: usa espelhos dos dados abertos. `url` aceita vários modelos separados por vírgula;
 * se um falhar (fora do ar, bloqueio, limite de uso), tenta o próximo. Não traz débitos.
 */
export async function lookupCnpj(cnpj: string, o: LookupOptions): Promise<Cadastral> {
  const d = onlyDigits(cnpj);
  if (!validCnpj(d)) throw new CnpjError('CNPJ inválido. Confira os 14 números.', 400);
  const modelos = o.url.split(',').map((u) => u.trim()).filter(Boolean);
  let naoAchou = 0;
  for (const modelo of modelos) {
    const url = modelo.replace('{cnpj}', d);
    try {
      const res = await o.fetchImpl(url, {
        signal: AbortSignal.timeout(o.timeoutMs ?? 8000),
        headers: { accept: 'application/json', 'user-agent': 'FiscoFacil/1.0 (consulta cadastral de CNPJ)' },
      });
      if (res.status === 404) { naoAchou++; o.log?.(`consulta CNPJ: ${fonteDe(url)} respondeu 404`); continue; }
      if (!res.ok) { o.log?.(`consulta CNPJ: ${fonteDe(url)} respondeu HTTP ${res.status}`); continue; }
      const j = (await res.json()) as Record<string, unknown>;
      if (!j || (!j.razao_social && !j.estabelecimento)) { o.log?.(`consulta CNPJ: ${fonteDe(url)} respondeu sem dados`); continue; }
      return mapearCadastro(j, fonteDe(url), o.now);
    } catch (e) {
      o.log?.(`consulta CNPJ: ${fonteDe(url)} falhou: ${(e as Error).message}`);
    }
  }
  if (naoAchou && naoAchou === modelos.length) throw new CnpjError('CNPJ não encontrado na base pública da Receita.', 404);
  throw new CnpjError('Não foi possível consultar o CNPJ agora. Tente de novo em instantes.', 502);
}

/** Monta a história da empresa a partir das datas do cadastro público. */
export function linhaDoTempo(c: Cadastral): EventoCadastral[] {
  const ev: EventoCadastral[] = [];
  if (c.abertura) ev.push({ data: c.abertura, texto: 'Abertura da empresa (início das atividades)', tipo: 'info' });
  if (c.simplesDesde) ev.push({ data: c.simplesDesde, texto: 'Entrou no Simples Nacional', tipo: 'ok' });
  if (c.simplesExclusao) ev.push({ data: c.simplesExclusao, texto: 'Saiu do Simples Nacional', tipo: 'alerta' });
  if (c.meiDesde) ev.push({ data: c.meiDesde, texto: 'Passou a ser MEI', tipo: 'ok' });
  if (c.meiExclusao) ev.push({ data: c.meiExclusao, texto: 'Deixou de ser MEI', tipo: 'alerta' });
  if (c.situacaoDesde && c.situacao) {
    ev.push({ data: c.situacaoDesde, texto: `Situação cadastral passou a ${c.situacao}`, tipo: /ATIVA/i.test(c.situacao) ? 'ok' : 'alerta' });
  }
  return ev.sort((a, b) => (a.data < b.data ? -1 : a.data > b.data ? 1 : 0));
}

/** Situação cadastral em linguagem simples. */
export function avaliarCadastro(c: Cadastral | null): { nivel: 'ok' | 'alerta' | 'pendente'; texto: string } {
  if (!c || !c.situacao) return { nivel: 'pendente', texto: 'Cadastro ainda não consultado.' };
  if (/^ATIVA$/i.test(c.situacao)) return { nivel: 'ok', texto: 'CNPJ ativo na Receita Federal.' };
  const m: Record<string, string> = {
    BAIXADA: 'CNPJ baixado (empresa encerrada).',
    INAPTA: 'CNPJ inapto: normalmente por falta de entrega de declarações. Procure o contador.',
    SUSPENSA: 'CNPJ suspenso. Procure o contador.',
    NULA: 'CNPJ nulo.',
  };
  return { nivel: 'alerta', texto: m[c.situacao.toUpperCase()] ?? `Situação cadastral: ${c.situacao}.` };
}
