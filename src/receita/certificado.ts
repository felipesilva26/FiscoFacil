import { readFileSync } from 'node:fs';
import forge from 'node-forge';

export interface InfoCertificado { titular: string; cnpj: string | null; emissor: string; validoDe: string; validoAte: string; vencido: boolean; diasRestantes: number }

/**
 * Lê o certificado A1 (.pfx/.p12) só para conferir titular, CNPJ e validade.
 * A chave privada não sai do servidor e nada disso é gravado ou enviado.
 */
export function lerCertificado(caminho: string, senha: string, agora = new Date()): InfoCertificado {
  const der = readFileSync(caminho).toString('binary');
  let p12: forge.pkcs12.Pkcs12Pfx;
  try {
    p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(der), senha);
  } catch {
    throw new Error('Não consegui abrir o certificado: a senha está errada ou o arquivo não é um .pfx/.p12.');
  }
  const bags = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] ?? [];
  const temChave = (p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] ?? []).length > 0
    || (p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] ?? []).length > 0;
  if (!temChave) throw new Error('O arquivo não tem a chave privada. Exporte o certificado marcando "exportar a chave privada".');
  // O certificado do titular é o que não é autoridade certificadora.
  const certs = bags.map((b) => b.cert).filter((c): c is forge.pki.Certificate => !!c);
  const cert = certs.find((c) => !c.extensions.some((e) => e.name === 'basicConstraints' && (e as { cA?: boolean }).cA)) ?? certs[0];
  if (!cert) throw new Error('Nenhum certificado encontrado dentro do arquivo.');
  const cn = String(cert.subject.getField('CN')?.value ?? '');
  const cnpj = (cn.match(/(\d{14})/) ?? [])[1] ?? null; // e-CNPJ: "RAZAO SOCIAL:00000000000000"
  const ate = cert.validity.notAfter;
  return {
    titular: cn.replace(/:\d{14}$/, ''), cnpj, emissor: String(cert.issuer.getField('CN')?.value ?? ''),
    validoDe: cert.validity.notBefore.toISOString(), validoAte: ate.toISOString(),
    vencido: ate < agora, diasRestantes: Math.floor((ate.getTime() - agora.getTime()) / 864e5),
  };
}
