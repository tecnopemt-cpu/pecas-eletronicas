// Diagnóstico das notificações com o sistema fechado (rotina manual). Mostra só CONTAGENS — o repositório é
// público, então nenhum nome, e-mail, endereço de aparelho ou chave aparece no registro.
import { configFirebase } from '../backup/firestore-rest.mjs';
import fs from 'node:fs';
const { projeto, apiKey } = configFirebase();
const URL_SRV = JSON.parse(fs.readFileSync(new URL('./servidor.json', import.meta.url))).url;
const login = await (await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: process.env.FIREBASE_EMAIL, password: process.env.FIREBASE_SENHA, returnSecureToken: true }) })).json();
if (!login.idToken) { console.log('Login da conta de leitura falhou.'); process.exit(1); }
const H = { Authorization: `Bearer ${login.idToken}`, 'Content-Type': 'application/json' };
const FS = `https://firestore.googleapis.com/v1/projects/${projeto}/databases/(default)/documents`;
const val = v => v == null ? null : 'stringValue' in v ? v.stringValue : 'booleanValue' in v ? v.booleanValue : 'timestampValue' in v ? v.timestampValue : 'arrayValue' in v ? (v.arrayValue.values || []).map(val) : 'mapValue' in v ? Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, val(x)])) : null;
const campos = d => Object.fromEntries(Object.entries(d.fields || {}).map(([k, v]) => [k, val(v)]));
async function consulta(q) {
  const r = await fetch(`${FS}:runQuery`, { method: 'POST', headers: H, body: JSON.stringify({ structuredQuery: q }) });
  const j = await r.json();
  if (!r.ok) return { erro: `${r.status} ${(j.error && j.error.message || '').slice(0, 300)}` };
  return { docs: j.filter(x => x.document).map(x => ({ id: x.document.name.split('/').pop(), ...campos(x.document) })) };
}
const eq = (c, v) => ({ fieldFilter: { field: { fieldPath: c }, op: 'EQUAL', value: { stringValue: v } } });
// 1) aparelhos inscritos
const ins = await consulta({ from: [{ collectionId: 'config' }], where: eq('tipo', 'push-inscricao'), limit: 300 });
if (ins.erro) console.log('Inscrições: ERRO', ins.erro);
else {
  const pessoas = new Set(ins.docs.map(d => d.funcionarioId));
  const tipos = {}; ins.docs.forEach(d => { tipos[d.aparelho || '?'] = (tipos[d.aparelho || '?'] || 0) + 1; });
  const servicos = {}; ins.docs.forEach(d => { const h = d.inscricao && d.inscricao.endpoint ? new URL(d.inscricao.endpoint).host : '?'; servicos[h] = (servicos[h] || 0) + 1; });
  console.log(`Aparelhos inscritos: ${ins.docs.length} (de ${pessoas.size} pessoa(s)) — por tipo: ${JSON.stringify(tipos)} — serviço: ${JSON.stringify(servicos)}`);
  // 2) a mesma consulta que o servidor faz (tipo + funcionarioId IN [...])
  const fids = [...pessoas].slice(0, 10);
  if (fids.length) {
    const q2 = await consulta({ from: [{ collectionId: 'config' }], where: { compositeFilter: { op: 'AND', filters: [eq('tipo', 'push-inscricao'), { fieldFilter: { field: { fieldPath: 'funcionarioId' }, op: 'IN', value: { arrayValue: { values: fids.map(f => ({ stringValue: f })) } } } }] } }, limit: 200 });
    console.log('Consulta do servidor (tipo + pessoas):', q2.erro ? 'ERRO ' + q2.erro : `ok, ${q2.docs.length} aparelho(s)`);
  }
}
// 3) sinos ligados
const cfg = await (await fetch(`${FS}/config/notificacoesColunasOrcamento`, { headers: H })).json();
const cols = cfg.fields ? campos(cfg).colunas || {} : {};
console.log('Sinos ligados por coluna:', JSON.stringify(Object.fromEntries(Object.entries(cols).map(([k, v]) => [k, (v || []).length]))));
// 4) avisos de coluna das últimas 48 h
const nts = await consulta({ from: [{ collectionId: 'notificacoes' }], where: eq('tipo', 'coluna-orcamento'), limit: 500 });
if (nts.erro) console.log('Avisos: ERRO', nts.erro);
else {
  const rec = nts.docs.filter(n => Date.now() - Date.parse(n.criadoEm || 0) < 48 * 3600e3);
  console.log(`Avisos de coluna (48 h): ${rec.length} — enviados por push: ${rec.filter(n => n.pushEnviado).length} — cancelados: ${rec.filter(n => n.cancelada).length}`);
  rec.slice(-8).forEach(n => console.log(`  ${new Date(n.criadoEm).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}  push=${n.pushEnviado ? 'sim' : 'não'}  cancelado=${n.cancelada ? 'sim' : 'não'}  espera=${n.liberarEm ? 'sim' : 'não'}${n.pushResultado ? '  resultado=' + n.pushResultado : ''}`));
}
// 5) servidor
try {
  const c = await fetch(URL_SRV + '/chave'); console.log('Servidor /chave:', c.status, (await c.json()).chave ? 'chave ok' : 'sem chave');
  const p = await fetch(URL_SRV + '/enviar', { method: 'OPTIONS', headers: { Origin: 'https://tecnopemt-cpu.github.io', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' } });
  console.log('Servidor (permissão do site):', p.status, p.headers.get('access-control-allow-origin'), p.headers.get('access-control-allow-headers'));
  const e = await fetch(URL_SRV + '/enviar', { method: 'POST', headers: { ...H, Origin: 'https://tecnopemt-cpu.github.io' }, body: JSON.stringify({ ids: ['diagnostico_inexistente'] }) });
  console.log('Servidor /enviar (teste vazio):', e.status, await e.text());
} catch (err) { console.log('Servidor: ERRO', err.message); }
