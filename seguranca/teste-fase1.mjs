// Fase 1 (banco ainda aberto, regras antigas): cada pessoa entra uma vez com a senha de sempre e o
// acesso novo é criado. Roda com os emuladores oficiais e o site de verdade (index.html ?emulador).
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FS = 'http://127.0.0.1:8080/v1/projects/demo-controle-pecas/databases/(default)/documents';
const sha = t => crypto.createHash('sha256').update(t).digest('hex');
let ok = 0, falhas = 0;
const passo = (nome, cond, det) => { if (cond) { ok++; console.log('OK     ' + nome); } else { falhas++; console.log('FALHOU ' + nome + (det !== undefined ? ' — ' + det : '')); console.log(`::error::Fase 1: ${nome}${det !== undefined ? ' — ' + String(det).replace(/\n/g, ' ').slice(0, 300) : ''}`); } };
const tip = v => typeof v === 'string' ? { stringValue: v } : typeof v === 'boolean' ? { booleanValue: v } : typeof v === 'number' ? { integerValue: String(v) } : Array.isArray(v) ? { arrayValue: { values: v.map(tip) } } : { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, tip(x)])) } };
const dono = { Authorization: 'Bearer owner', 'Content-Type': 'application/json' };
const gravar = (c, d) => fetch(`${FS}/${c}`, { method: 'PATCH', headers: dono, body: JSON.stringify({ fields: Object.fromEntries(Object.entries(d).map(([k, v]) => [k, tip(v)])) }) });
const ler = async c => { const r = await fetch(`${FS}/${c}`, { headers: dono }); if (r.status === 404) return null; const j = await r.json(); return j.fields || {}; };
const perm = v => Object.fromEntries(['dashboard', 'lotes', 'catalogo', 'clientes', 'orcamentos', 'comissoes', 'funcionarios'].map(m => [m, v]));
await gravar('funcionarios/Wa1TeR', { nome: 'Walter', perfil: 'master', status: 'ativo', login: 'Walter', senhaHash: sha('0538'), permissoes: perm('editar'), cpf: '52998224725' });
await gravar('funcionarios/RaIaNy', { nome: 'Raiany', perfil: 'administrador', status: 'ativo', login: 'raiany', senhaHash: sha('raiany1'), permissoes: perm('editar') });
await gravar('clientes/C1', { razaoSocial: 'Cliente' });
await gravar('orcamentos/O1', { numero: 1, clienteId: 'C1', status: 'Pendente orçamento', total: 100, arquivado: false, ordemKanban: 1, itens: [], historico: [] });
for (const c of ['migracaoArquivamento_v2', 'migracaoPermissoes', 'migracaoStatusRota', 'migracaoLoteConcluidoOrcado']) await gravar('config/' + c, { feito: true });
const servidor = http.createServer((req, res) => { let p = decodeURIComponent(new URL(req.url, 'http://x').pathname); if (p === '/') p = '/index.html'; const f = path.join(RAIZ, p); if (!f.startsWith(RAIZ) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': p.endsWith('.html') ? 'text/html' : 'application/octet-stream' }); fs.createReadStream(f).pipe(res); }).listen(5050);
const browser = await chromium.launch();
try {
  const ctx = await browser.newContext(); const page = await ctx.newPage();
  const erros = []; page.on('pageerror', e => erros.push(e.message)); page.on('dialog', d => d.accept());
  const entrar = async (l, s) => { await page.goto('http://localhost:5050/?emulador'); await page.waitForSelector('#acesso-login', { timeout: 30000 }); await page.fill('#acesso-login', l); await page.fill('#acesso-senha', s); await page.locator('.acesso-btn-entrar').click(); await page.waitForSelector('.sidebar, .acesso-erro', { timeout: 30000 }).catch(() => {}); await page.waitForTimeout(1500); };
  await entrar('walter', '0538');
  passo('conta antiga (senha de 4 dígitos) entra pela 1ª vez', await page.locator('.sidebar').count() === 1, await page.locator('body').innerText().then(t => t.slice(0, 200)));
  const w = await ler('funcionarios/Wa1TeR');
  passo('acesso novo criado na 1ª entrada (authUid, conta ligada, senha antiga apagada)', w.authUid && w.authEmail.stringValue === 'f-wa1ter-v1@acesso.controle-pecas.app' && !w.senhaHash && !!(await ler('contas/' + w.authUid.stringValue)) && !!(await ler('loginsPublicos/walter')), JSON.stringify(w).slice(0, 300));
  for (const t of ['Painel', 'Orçamento', 'Equipe']) { await page.locator('.sidebar-item', { hasText: t }).first().click(); await page.waitForTimeout(1000); }
  passo('painel de segurança mostra 1 de 2 com acesso novo', /1 de 2/.test(await page.locator('.seguranca-acesso').innerText().catch(() => '')), await page.locator('.seguranca-acesso').innerText().catch(() => ''));
  await page.locator('.sidebar-item', { hasText: 'Sair' }).first().click(); await page.waitForTimeout(800);
  await entrar('WALTER', '0538');
  passo('2ª entrada já pelo acesso novo', await page.locator('.sidebar').count() === 1);
  await page.locator('.sidebar-item', { hasText: 'Sair' }).first().click(); await page.waitForTimeout(800);
  await entrar('raiany', 'errada');
  passo('senha errada de conta antiga é recusada sem criar acesso', /Senha incorreta/.test(await page.locator('.acesso-erro').innerText().catch(() => '')) && !(await ler('funcionarios/RaIaNy')).authUid);
  passo('sem erros de JavaScript', erros.length === 0, erros.join(' | '));
} catch (e) { falhas++; console.log('::error::Fase 1: erro inesperado ' + String(e.message || e).slice(0, 300)); }
await browser.close(); servidor.close();
console.log(`\n${ok}/${ok + falhas} verificações da fase 1 ${falhas ? 'com FALHAS' : 'OK'}`);
console.log(falhas ? `::error::Fase 1: ${falhas} falha(s)` : `::notice::Fase 1 (banco aberto, 1ª entrada cria o acesso novo): ${ok} verificações OK`);
process.exit(falhas ? 1 : 0);
