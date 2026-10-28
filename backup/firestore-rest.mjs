// Acesso ao Firestore pela API REST (usado pela rotina automática e pelo script de recuperação).
// Não depende do site estar no ar: fala direto com o banco do Firebase.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const AQUI = path.dirname(fileURLToPath(import.meta.url));

// Projeto e chave pública do Firebase: lidos do próprio index.html (fonte única).
export function configFirebase(raizSite = path.join(AQUI, '..')) {
  const env = { projeto: process.env.FIREBASE_PROJECT_ID, apiKey: process.env.FIREBASE_API_KEY };
  if (env.projeto && env.apiKey) return env;
  const html = fs.readFileSync(path.join(raizSite, 'index.html'), 'utf8');
  const projeto = /projectId:\s*"([^"]+)"/.exec(html)?.[1];
  const apiKey = /apiKey:\s*"([^"]+)"/.exec(html)?.[1];
  if (!projeto || !apiKey) throw new Error('Não encontrei projectId/apiKey do Firebase no index.html.');
  return { projeto: env.projeto || projeto, apiKey: env.apiKey || apiKey };
}

// ---- login no Firebase Authentication (as regras do banco exigem uma conta)
// A rotina de backup usa a conta própria dela (BACKUP_EMAIL / BACKUP_SENHA, segredos do GitHub).
// A restauração usa o login de um Administrador Master (o mesmo login e senha do sistema).
const AUTH_BASE = () => process.env.AUTH_BASE || 'https://identitytoolkit.googleapis.com/v1';
export function senhaAcessoSistema(senha) {
  return 'cp1-' + createHash('sha256').update('controle-pecas|' + String(senha || '')).digest('hex');
}
async function entrarAuth(apiKey, email, senha) {
  const r = await fetch(`${AUTH_BASE()}/accounts:signInWithPassword?key=${encodeURIComponent(apiKey)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: senha, returnSecureToken: true }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Login no Firebase recusado (${(j.error && j.error.message) || r.status}). Confira e-mail/senha da conta.`);
  return { token: j.idToken, expira: Date.now() + (Number(j.expiresIn) || 3600) * 1000 - 120000 };
}
// Login do sistema (ex.: "walter" + senha) → conta interna do Firebase.
export async function credenciaisDoLogin({ projeto, apiKey, base }, login, senha) {
  const raiz = base || process.env.FIRESTORE_BASE || 'https://firestore.googleapis.com/v1';
  const chave = encodeURIComponent(String(login || '').trim().toLowerCase());
  const r = await fetch(`${raiz}/projects/${projeto}/databases/(default)/documents/loginsPublicos/${chave}?key=${encodeURIComponent(apiKey)}`);
  if (!r.ok) throw new Error(`Login "${login}" não encontrado no sistema (${r.status}).`);
  const email = ((await r.json()).fields || {}).email?.stringValue;
  if (!email) throw new Error(`Login "${login}" sem conta de acesso.`);
  return { email, senha: senhaAcessoSistema(senha) };
}

export function clienteFirestore({ projeto, apiKey, base, credenciais }) {
  const raiz = base || process.env.FIRESTORE_BASE || 'https://firestore.googleapis.com/v1';
  const docs = `${raiz}/projects/${projeto}/databases/(default)/documents`;
  const nomeDoc = (col, id) => `projects/${projeto}/databases/(default)/documents/${col}/${id}`;
  const cred = credenciais || (process.env.FIREBASE_EMAIL && process.env.FIREBASE_SENHA ? { email: process.env.FIREBASE_EMAIL, senha: process.env.FIREBASE_SENHA } : null);
  let sessao = null;
  async function cabecalhoAuth(renovar) {
    if (!cred) return {};
    if (renovar || !sessao || Date.now() > sessao.expira) sessao = await entrarAuth(apiKey, cred.email, cred.senha);
    return { Authorization: `Bearer ${sessao.token}` };
  }
  async function req(url, opcoes = {}, tentativas = 4) {
    const sep = url.includes('?') ? '&' : '?';
    let renovou = false;
    for (let t = 1; ; t++) {
      let r;
      try {
        r = await fetch(`${url}${sep}key=${encodeURIComponent(apiKey)}`, { ...opcoes, headers: { 'Content-Type': 'application/json', ...(await cabecalhoAuth(false)), ...(opcoes.headers || {}) } });
      } catch (e) {
        if (t >= tentativas) throw new Error(`Sem conexão com o Firestore: ${e.message}`);
        await new Promise(res => setTimeout(res, 1000 * t));
        continue;
      }
      if (r.ok) return r.status === 204 ? null : r.json();
      if (r.status === 401 && cred && !renovou) { renovou = true; await cabecalhoAuth(true); t--; continue; }
      const corpo = await r.text();
      if ((r.status === 429 || r.status >= 500) && t < tentativas) { await new Promise(res => setTimeout(res, 1500 * t)); continue; }
      const msg = (() => { try { return JSON.parse(corpo).error.message; } catch (e) { return corpo.slice(0, 200); } })();
      const err = new Error(`Firestore respondeu ${r.status}: ${msg}`);
      err.status = r.status;
      throw err;
    }
  }
  return {
    projeto,
    nomeDoc,
    // Lista as coleções do banco. Pode exigir login administrativo; se não der, devolve null.
    async listarColecoes() {
      try {
        const ids = [];
        let pageToken;
        do {
          const r = await req(`${docs}:listCollectionIds`, { method: 'POST', body: JSON.stringify({ pageSize: 300, pageToken }) });
          ids.push(...(r?.collectionIds || []));
          pageToken = r?.nextPageToken;
        } while (pageToken);
        return ids;
      } catch (e) { return null; }
    },
    // Todos os documentos de uma coleção, no formato tipado (exato) do Firestore.
    async listarDocumentos(col) {
      const out = {};
      let pageToken;
      do {
        const r = await req(`${docs}/${encodeURIComponent(col)}?pageSize=200${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`);
        (r?.documents || []).forEach(d => { out[d.name.split('/').pop()] = d.fields || {}; });
        pageToken = r?.nextPageToken;
      } while (pageToken);
      return out;
    },
    // Igual a listarDocumentos, mas com a versão (updateTime) de cada documento — usada como
    // pré-condição para nunca sobrescrever uma alteração feita por alguém no meio do caminho.
    async listarComVersao(col) {
      const out = {};
      let pageToken;
      do {
        const r = await req(`${docs}/${encodeURIComponent(col)}?pageSize=100${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`);
        (r?.documents || []).forEach(d => { out[d.name.split('/').pop()] = { fields: d.fields || {}, updateTime: d.updateTime }; });
        pageToken = r?.nextPageToken;
      } while (pageToken);
      return out;
    },
    async obterComVersao(col, id) {
      try { const r = await req(`${docs}/${col}/${id}`); return r ? { fields: r.fields || {}, updateTime: r.updateTime } : null; } catch (e) { if (e.status === 404) return null; throw e; }
    },
    // Um commit (atômico) — devolve os resultados (updateTime de cada escrita).
    async commit(writes) { return req(`${docs}:commit`, { method: 'POST', body: JSON.stringify({ writes }) }, 1); },
    async obterDocumento(col, id) {
      try { const r = await req(`${docs}/${col}/${id}`); return r ? (r.fields || {}) : null; } catch (e) { if (e.status === 404) return null; throw e; }
    },
    // Gravações em lote (até 500 por vez, limitando também o tamanho da requisição).
    async gravar(escritas, aoProgredir) {
      let lote = [], bytes = 0, feitas = 0;
      const enviar = async () => {
        if (!lote.length) return;
        await req(`${docs}:commit`, { method: 'POST', body: JSON.stringify({ writes: lote }) });
        feitas += lote.length;
        if (aoProgredir) aoProgredir(feitas, escritas.length);
        lote = []; bytes = 0;
      };
      for (const w of escritas) {
        const tam = JSON.stringify(w).length;
        if (lote.length >= 400 || (bytes + tam > 7_000_000 && lote.length)) await enviar();
        lote.push(w); bytes += tam;
      }
      await enviar();
    },
    gravarDocumento(col, id, fields) { return this.gravar([{ update: { name: nomeDoc(col, id), fields } }]); },
    escritaSet: (col, id, fields) => ({ update: { name: nomeDoc(col, id), fields } }),
    escritaApagar: (col, id) => ({ delete: nomeDoc(col, id) })
  };
}

// Lê o banco inteiro (coleções do sistema + as que o Firestore informar).
export async function lerBancoCompleto(fsCli, colecoesSistema, colecoesDoBackup, aoProgredir) {
  const descobertas = await fsCli.listarColecoes();
  const todas = [...new Set([...colecoesSistema, ...(descobertas || [])])].filter(c => !colecoesDoBackup.includes(c));
  const docsPorColecao = {}, vazias = [];
  let i = 0;
  for (const c of todas) {
    const d = await fsCli.listarDocumentos(c);
    if (Object.keys(d).length) docsPorColecao[c] = d; else vazias.push(c);
    i++;
    if (aoProgredir) aoProgredir(c, i, todas.length, Object.keys(d).length);
  }
  return { docsPorColecao, vazias, listaDoBanco: descobertas, extras: (descobertas || []).filter(c => !colecoesSistema.includes(c) && !colecoesDoBackup.includes(c)) };
}
