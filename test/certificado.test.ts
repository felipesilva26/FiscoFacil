import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import forge from 'node-forge';
import { lerCertificado } from '../src/receita/certificado.js';

function pfxFalso(senha: string, comChave = true) {
  const keys = forge.pki.rsa.generateKeyPair(1024);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey; cert.serialNumber = '01';
  cert.validity.notBefore = new Date('2026-01-01'); cert.validity.notAfter = new Date('2027-01-01');
  const attrs = [{ name: 'commonName', value: 'EMPRESA TESTE LTDA:66369868000171' }];
  cert.setSubject(attrs); cert.setIssuer([{ name: 'commonName', value: 'AC TESTE' }]); cert.sign(keys.privateKey);
  const asn = forge.pkcs12.toPkcs12Asn1(comChave ? keys.privateKey : null, [cert], senha, { algorithm: '3des' });
  const f = join(mkdtempSync(join(tmpdir(), 'cert-')), 'c.pfx');
  writeFileSync(f, Buffer.from(forge.asn1.toDer(asn).getBytes(), 'binary'));
  return f;
}

test('lê titular, CNPJ e validade do e-CNPJ; recusa senha errada', () => {
  const f = pfxFalso('segredo');
  const c = lerCertificado(f, 'segredo', new Date('2026-11-07'));
  assert.equal(c.cnpj, '66369868000171'); assert.equal(c.titular, 'EMPRESA TESTE LTDA'); assert.equal(c.vencido, false);
  assert.ok(c.diasRestantes > 50 && c.diasRestantes < 60);
  assert.throws(() => lerCertificado(f, 'errada'), /senha está errada/);
});
