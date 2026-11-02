export interface PendenciaReceita {
  tributo: string; // DAS, DARF, INSS...
  venc: string; // AAAA-MM-DD
  valor: number; // em reais
  descricao: string;
}

export interface SituacaoFiscal {
  cnpj: string;
  consultadoEm: string;
  /** De onde vieram os dados. Sempre mostrado ao usuário. */
  fonte: string;
  /** true quando os dados não vêm da Receita de verdade. */
  simulado: boolean;
  pendencias: PendenciaReceita[];
  /** Resposta crua do órgão, para auditoria e para quando o layout ainda não é interpretado. */
  bruto?: unknown;
}

export class ReceitaNaoConfigurada extends Error {
  constructor(public faltando: string[]) {
    super(`Integração com a Receita não configurada. Faltam: ${faltando.join(', ')}.`);
  }
}

export interface ReceitaProvider {
  readonly nome: string;
  consultarSituacaoFiscal(cnpj: string, now: Date): Promise<SituacaoFiscal>;
}

/** Padrão: sem integração configurada. Nunca inventa dados; avisa o que falta. */
export class SemReceita implements ReceitaProvider {
  readonly nome = 'Não configurado';
  async consultarSituacaoFiscal(): Promise<SituacaoFiscal> {
    throw new ReceitaNaoConfigurada(['RECEITA_PROVIDER=serpro', 'SERPRO_* (contrato Integra Contador)']);
  }
}
