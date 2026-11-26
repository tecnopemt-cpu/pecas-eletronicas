// Servidor de notificações do Controle de Peças (Cloudflare Workers, plano gratuito).
//
// O que faz: quando alguém move um cartão, o sistema grava as notificações no banco (coleção "notificacoes") e
// chama POST /enviar com os ids. Este servidor lê essas notificações e as inscrições dos aparelhos de cada
// destinatário NO PRÓPRIO BANCO, usando o login de quem chamou (as regras do Firestore valem: sem login válido
// de um usuário ativo, nada é lido) e manda o "push" para os aparelhos. O texto vem do banco, não do pedido.
//
// Chaves de envio (VAPID): criadas pela rotina de publicação e guardadas como segredos do Worker
// (VAPID_PRIVADA em JWK, VAPID_PUBLICA). Ninguém precisa copiar chave nenhuma.

const PROJETO = 'controle-processos-a2f99';
const FS = `https://firestore.googleapis.com/v1/projects/${PROJETO}/databases/(default)/documents`;
const ORIGENS = ['https://tecnopemt-cpu.github.io', 'http://localhost', 'http://127.0.0.1'];
const CONTATO = 'mailto:avisos@tecnopemt.invalid';

export default {
  async fetch(req, env) {
    const origem = req.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': ORIGENS.some(o => origem === o || origem.startsWith(o + ':')) ? origem : ORIGENS[0],
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin'
    };
    const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const url = new URL(req.url);
    try {
      if (url.pathname === '/chave' && req.method === 'GET') {
        if (!env.VAPID_PUBLICA) return json({ erro: 'servidor sem chave' }, 503);
        return json({ chave: env.VAPID_PUBLICA });
      }
      if (url.pathname === '/enviar' && req.method === 'POST') {
        const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
        if (!token) return json({ erro: 'sem login' }, 401);
        const corpo = await req.json().catch(() => ({}));
        const ids = [...new Set((corpo.ids || []).filter(x => typeof x === 'string' && /^[\w-]{1,200}$/.test(x)))].slice(0, 30);
        if (!ids.length) return json({ enviados: 0 });
        return json(await enviar(ids, token, env));
      }
      return json({ ok: true, servico: 'notificações do Controle de Peças' });
    } catch (err) {
      return json({ erro: String(err && err.message || err) }, 500);
    }
  }
};

// ---------- Firestore (REST, com o login de quem chamou) ----------
async function fs(caminho, token, op = {}) {
  const r = await fetch(caminho.startsWith('http') ? caminho : `${FS}/${caminho}`, {
    ...op,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(op.headers || {}) }
  });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`banco ${r.status}`);
  return r.json();
}
function valor(v) {
  if (!v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('nullValue' in v) return null;
  if ('mapValue' in v) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, valor(x)]));
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(valor);
  return null;
}
const campos = doc => Object.fromEntries(Object.entries(doc.fields || {}).map(([k, v]) => [k, valor(v)]));

async function enviar(ids, token, env) {
  // 1) as notificações (só as recentes, ainda não enviadas por push)
  const notifs = [];
  for (const id of ids) {
    const d = await fs(`notificacoes/${id}`, token);
    if (!d) continue;
    const n = campos(d);
    const criado = Date.parse(n.criadoEm || '') || 0;
    if (n.pushEnviado || !n.funcionarioId || Date.now() - criado > 10 * 60 * 1000) continue;
    notifs.push({ id, ...n });
  }
  if (!notifs.length) return { enviados: 0 };
  // 2) inscrições dos aparelhos dos destinatários
  const fids = [...new Set(notifs.map(n => n.funcionarioId))].slice(0, 30);
  const consulta = await fs(`${FS}:runQuery`, token, {
    method: 'POST',
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: 'config' }],
        where: {
          compositeFilter: {
            op: 'AND',
            filters: [
              { fieldFilter: { field: { fieldPath: 'tipo' }, op: 'EQUAL', value: { stringValue: 'push-inscricao' } } },
              { fieldFilter: { field: { fieldPath: 'funcionarioId' }, op: 'IN', value: { arrayValue: { values: fids.map(f => ({ stringValue: f })) } } } }
            ]
          }
        },
        limit: 200
      }
    })
  });
  const inscricoes = (consulta || []).filter(x => x.document).map(x => ({ nome: x.document.name, ...campos(x.document) }));
  // 3) envio
  const chave = await chavesVapid(env);
  let enviados = 0, removidas = 0;
  for (const n of notifs) {
    // marca antes de enviar: se a chamada for repetida, não manda de novo
    await fs(`notificacoes/${n.id}?updateMask.fieldPaths=pushEnviado`, token, {
      method: 'PATCH',
      body: JSON.stringify({ fields: { pushEnviado: { booleanValue: true } } })
    });
    const dados = JSON.stringify({ id: n.id, titulo: n.titulo || 'Controle de Peças', texto: n.texto || '', orcamentoId: n.orcamentoId || '' });
    for (const ins of inscricoes.filter(i => i.funcionarioId === n.funcionarioId)) {
      const sub = ins.inscricao;
      if (!sub || !sub.endpoint || !sub.keys) continue;
      try {
        const r = await mandarPush(sub, dados, chave);
        if (r.status === 404 || r.status === 410) {
          // aparelho desinstalou ou revogou: tira a inscrição
          await fetch(`https://firestore.googleapis.com/v1/${ins.nome}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
          removidas++;
        } else if (r.ok) enviados++;
      } catch (e) {}
    }
  }
  return { enviados, removidas };
}

// ---------- Web Push (RFC 8291 aes128gcm + VAPID RFC 8292), só com WebCrypto ----------
const enc = new TextEncoder();
function b64u(buf) {
  let s = '';
  new Uint8Array(buf).forEach(b => (s += String.fromCharCode(b)));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function deB64u(s) {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(b, c => c.charCodeAt(0));
}
function juntar(...partes) {
  const tam = partes.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(tam);
  let i = 0;
  partes.forEach(p => { out.set(p, i); i += p.length; });
  return out;
}
async function hkdf(salt, ikm, info, bytes) {
  const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, bytes * 8));
}
let _chaves = null;
async function chavesVapid(env) {
  if (_chaves) return _chaves;
  const jwk = JSON.parse(env.VAPID_PRIVADA);
  const privada = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  _chaves = { privada, publica: env.VAPID_PUBLICA };
  return _chaves;
}
async function jwtVapid(aud, chave) {
  const cab = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const corpo = b64u(enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: CONTATO })));
  const assinatura = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, chave.privada, enc.encode(`${cab}.${corpo}`));
  return `${cab}.${corpo}.${b64u(assinatura)}`;
}
export async function cifrar(texto, p256dh, authSecret) {
  const uaPublica = deB64u(p256dh);
  const auth = deB64u(authSecret);
  const efemera = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublica = new Uint8Array(await crypto.subtle.exportKey('raw', efemera.publicKey));
  const uaChave = await crypto.subtle.importKey('raw', uaPublica, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const segredo = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaChave }, efemera.privateKey, 256));
  const ikm = await hkdf(auth, segredo, juntar(enc.encode('WebPush: info\0'), uaPublica, asPublica), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const chave = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const cifrado = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, chave, juntar(enc.encode(texto), new Uint8Array([2]))));
  const rs = new Uint8Array([0, 0, 16, 0]); // 4096
  return juntar(salt, rs, new Uint8Array([asPublica.length]), asPublica, cifrado);
}
async function mandarPush(sub, texto, chave) {
  const corpo = await cifrar(texto, sub.keys.p256dh, sub.keys.auth);
  const aud = new URL(sub.endpoint).origin;
  return fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      Authorization: `vapid t=${await jwtVapid(aud, chave)}, k=${chave.publica}`,
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: '86400',
      Urgency: 'high'
    },
    body: corpo
  });
}
