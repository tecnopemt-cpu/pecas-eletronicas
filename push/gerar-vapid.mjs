// Gera o par de chaves VAPID (P-256) do servidor de notificações. Usado só pela rotina de publicação:
//   node push/gerar-vapid.mjs privada   → imprime a chave privada (JWK) — vai direto para "wrangler secret put"
//   node push/gerar-vapid.mjs publica   → imprime a pública correspondente (lida do arquivo temporário)
// As duas saem de um arquivo temporário criado e apagado pela rotina; nada é gravado no repositório.
import fs from 'node:fs';
const ARQ = process.env.ARQ_VAPID || '/tmp/vapid.json';
if (!fs.existsSync(ARQ)) {
  const par = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const privada = await crypto.subtle.exportKey('jwk', par.privateKey);
  const publica = Buffer.from(await crypto.subtle.exportKey('raw', par.publicKey)).toString('base64url');
  fs.writeFileSync(ARQ, JSON.stringify({ privada, publica }), { mode: 0o600 });
}
const { privada, publica } = JSON.parse(fs.readFileSync(ARQ, 'utf8'));
process.stdout.write(process.argv[2] === 'privada' ? JSON.stringify(privada) : publica);
