import { createHash } from 'node:crypto';
import { addDaysISO, todayISO } from '../util.js';
import type { ReceitaProvider, SituacaoFiscal } from './provider.js';

/**
 * Provedor SIMULADO. Gera dados fictícios, estáveis para o mesmo CNPJ, só para testar o fluxo.
 * Nada aqui vem da Receita Federal.
 */
export class MockReceitaProvider implements ReceitaProvider {
  readonly nome = 'Simulado (dados fictícios)';

  async consultarSituacaoFiscal(cnpj: string, now: Date): Promise<SituacaoFiscal> {
    const h = createHash('sha256').update(cnpj).digest();
    const hoje = todayISO(now);
    const qtd = 1 + (h[0] % 2);
    const pendencias = Array.from({ length: qtd }, (_, i) => ({
      tributo: i === 0 ? 'DAS' : 'DARF',
      venc: addDaysISO(hoje, 5 + (h[i + 1] % 20)),
      valor: 300 + (h[i + 3] % 120) * 10 + 0.5,
      descricao: i === 0 ? 'Guia do Simples Nacional (simulada)' : 'DARF (simulado)',
    }));
    return {
      cnpj,
      consultadoEm: now.toISOString(),
      fonte: this.nome,
      simulado: true,
      pendencias,
    };
  }
}
