import { readFileSync } from 'node:fs';
import https from 'node:https';
import type { SerproConfig } from '../config.js';
import { ReceitaNaoConfigurada, type ReceitaProvider, type SituacaoFiscal } from './provider.js';

/**
 * Provedor REAL (Integra Contador, Serpro) - ESQUELETO NÃO VALIDADO.
 *
 * Foi escrito sem acesso à documentação oficial nem ao contrato, então:
 *  - URLs, ids de sistema/serviço e versão vêm do .env (SERPRO_*), nada é fixo no código;
 *  - o formato exato do corpo/cabeçalhos precisa ser conferido na documentação do seu contrato;
 *  - a resposta do órgão é guardada em `bruto`; as pendências só são interpretadas quando o
 *    layout real estiver confirmado (por isso `pendencias` volta vazia).
 * Credenciais ficam só em variáveis de ambiente do servidor.
 */
export class SerproReceitaProvider implements ReceitaProvider {
  readonly nome = 'Serpro Integra Contador (Receita Federal)';
  constructor(private cfg: SerproConfig) {}

  private faltando(): string[] {
    const c = this.cfg;
    const req: [string, string][] = [
      ['SERPRO_CONSUMER_KEY', c.consumerKey], ['SERPRO_CONSUMER_SECRET', c.consumerSecret],
      ['SERPRO_AUTH_URL', c.authUrl], ['SERPRO_GATEWAY_URL', c.gatewayUrl],
      ['SERPRO_CERT_PFX_PATH', c.certPfxPath], ['SERPRO_CERT_PASSWORD', c.certPassword],
      ['SERPRO_CONTRATANTE_CNPJ', c.contratanteCnpj], ['SERPRO_SITFIS_SISTEMA', c.sitfisSistema],
      ['SERPRO_SITFIS_SERVICO', c.sitfisServico], ['SERPRO_SITFIS_VERSAO', c.sitfisVersao],
    ];
    return req.filter(([, v]) => !v).map(([k]) => k);
  }

  private chamar(url: string, method: string, headers: Record<string, string>, body?: string): Promise<{ status: number; texto: string }> {
    const agent = new https.Agent({ pfx: readFileSync(this.cfg.certPfxPath), passphrase: this.cfg.certPassword });
    return new Promise((resolve, reject) => {
      const req = https.request(url, { method, headers, agent, timeout: 30_000 }, (res) => {
        const partes: Buffer[] = [];
        res.on('data', (d: Buffer) => partes.push(d));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, texto: Buffer.concat(partes).toString('utf8') }));
      });
      req.on('timeout', () => req.destroy(new Error('Tempo esgotado ao falar com o Serpro.')));
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }

  async consultarSituacaoFiscal(cnpj: string, now: Date): Promise<SituacaoFiscal> {
    const falta = this.faltando();
    if (falta.length) throw new ReceitaNaoConfigurada(falta);
    const c = this.cfg;

    // 1) Token (OAuth2 client_credentials). Conferir cabeçalhos exigidos no seu contrato.
    const basic = Buffer.from(`${c.consumerKey}:${c.consumerSecret}`).toString('base64');
    const tk = await this.chamar(c.authUrl, 'POST',
      { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded', 'role-type': 'TERCEIROS' },
      'grant_type=client_credentials');
    if (tk.status !== 200) throw new Error(`Serpro recusou a autenticação (HTTP ${tk.status}).`);
    const token = (JSON.parse(tk.texto) as { access_token?: string }).access_token;
    if (!token) throw new Error('Resposta de autenticação do Serpro sem token.');

    // 2) Pedido do serviço de situação fiscal. O formato abaixo é um MODELO a conferir.
    const corpo = JSON.stringify({
      contratante: { numero: c.contratanteCnpj, tipo: 2 },
      autorPedidoDados: { numero: c.contratanteCnpj, tipo: 2 },
      contribuinte: { numero: cnpj, tipo: 2 },
      pedidoDados: { idSistema: c.sitfisSistema, idServico: c.sitfisServico, versaoSistema: c.sitfisVersao, dados: '' },
    });
    const r = await this.chamar(c.gatewayUrl, 'POST',
      { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, corpo);
    if (r.status < 200 || r.status >= 300) throw new Error(`Serpro respondeu HTTP ${r.status} na consulta de situação fiscal.`);
    let bruto: unknown = r.texto;
    try { bruto = JSON.parse(r.texto); } catch { /* mantém texto */ }
    return { cnpj, consultadoEm: now.toISOString(), fonte: this.nome, simulado: false, pendencias: [], bruto };
  }
}
