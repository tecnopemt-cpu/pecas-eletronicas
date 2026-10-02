// Acesso ao Firestore pela API REST (usado pela rotina automática e pelo script de recuperação).
// Não depende do site estar no ar: fala direto com o banco do Firebase.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

export function clienteFirestore({ projeto, apiKey, base }) {
  const raiz = base || process.env.FIRESTORE_BASE || 'https://firestore.googleapis.com/v1';
  const docs = `${raiz}/projects/${projeto}/databases/(default)/documents`;
  const nomeDoc = (col, id) => `projects/${projeto}/databases/(default)/documents/${col}/${id}`;
  async function req(url, opcoes = {}, tentativas = 4) {
    const sep = url.includes('?') ? '&' : '?';
    for (let t = 1; ; t++) {
      let r;
      try {
        r = await fetch(`${url}${sep}key=${encodeURIComponent(apiKey)}`, { ...opcoes, headers: { 'Content-Type': 'application/json', ...(opcoes.headers || {}) } });
      } catch (e) {
        if (t >= tentativas) throw new Error(`Sem conexão com o Firestore: ${e.message}`);
        await new Promise(res => setTimeout(res, 1000 * t));
        continue;
      }
      if (r.ok) return r.status === 204 ? null : r.json();
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
