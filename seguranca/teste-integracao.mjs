// Teste de ponta a ponta do sistema COM as regras de segurança (roda no GitHub Actions).
// Sobe os emuladores oficiais do Firestore e do Authentication, aplica seguranca/firestore.rules, abre o
// site de verdade (index.html, com ?emulador) num navegador e usa o sistema como as pessoas usam:
// login, telas, kanban, redefinir senha, conta do backup, assinatura por link e cadastro pendente.
// Também roda a rotina de backup contra o banco fechado (com e sem a conta própria dela).
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROJ = 'demo-controle-pecas';
const FS = `http://127.0.0.1:8080/v1/projects/${PROJ}/databases/(default)/documents`;
const AUTH = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1';
const DOM = 'acesso.controle-pecas.app';
const derivada = s => 'cp1-' + crypto.createHash('sha256').update('controle-pecas|' + s).digest('hex');
let ok = 0, falhas = 0;
const passo = (nome, cond, det) => { if (cond) { ok++; console.log('OK     ' + nome); } else { falhas++; console.log('FALHOU ' + nome + (det !== undefined ? ' — ' + det : '')); console.log(`::error::Integração: ${nome}`); } };

// ---- banco e contas (como dono do emulador, sem regras)
function tip(v) {
  if (v === null) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(tip) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, tip(x)])) } };
}
function des(t) {
  if (!t) return undefined;
  if ('stringValue' in t) return t.stringValue; if ('booleanValue' in t) return t.booleanValue;
  if ('integerValue' in t) return Number(t.integerValue); if ('doubleValue' in t) return t.doubleValue;
  if ('timestampValue' in t) return t.timestampValue; if ('nullValue' in t) return null;
  if ('arrayValue' in t) return (t.arrayValue.values || []).map(des);
  if ('mapValue' in t) return Object.fromEntries(Object.entries(t.mapValue.fields || {}).map(([k, x]) => [k, des(x)]));
}
const dono = { Authorization: 'Bearer owner', 'Content-Type': 'application/json' };
async function gravar(caminho, dados) {
  const r = await fetch(`${FS}/${caminho}`, { method: 'PATCH', headers: dono, body: JSON.stringify({ fields: Object.fromEntries(Object.entries(dados).map(([k, v]) => [k, tip(v)])) }) });
  if (!r.ok) throw new Error('seed ' + caminho + ' ' + await r.text());
}
async function ler(caminho) {
  const r = await fetch(`${FS}/${caminho}`, { headers: dono });
  if (r.status === 404) return null;
  const j = await r.json(); return Object.fromEntries(Object.entries(j.fields || {}).map(([k, v]) => [k, des(v)]));
}
async function listar(col) {
  const r = await fetch(`${FS}/${col}?pageSize=300`, { headers: dono }); const j = await r.json();
  return (j.documents || []).map(d => ({ id: d.name.split('/').pop(), ...Object.fromEntries(Object.entries(d.fields || {}).map(([k, v]) => [k, des(v)])) }));
}
async function criarConta(email, senha) {
  const r = await fetch(`${AUTH}/accounts:signUp?key=fake`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: senha, returnSecureToken: true }) });
  const j = await r.json(); if (!r.ok) throw new Error('conta ' + JSON.stringify(j)); return j.localId;
}
const perm = v => Object.fromEntries(['dashboard', 'lotes', 'catalogo', 'clientes', 'orcamentos', 'comissoes', 'funcionarios'].map(m => [m, v]));
await criarConta(`f-WAL-v1@${DOM}`, derivada('walter123'));
await criarConta(`f-FUN-v1@${DOM}`, derivada('fabio123'));
await gravar('funcionarios/WAL', { nome: 'Walter Teste', perfil: 'master', status: 'ativo', login: 'walter', cpf: '52998224725', authEmail: `f-WAL-v1@${DOM}`, permissoes: perm('editar'), percentualComissao: 0 });
await gravar('funcionarios/FUN', { nome: 'Fábio Teste', perfil: 'funcionario', status: 'ativo', login: 'fabio', authEmail: `f-FUN-v1@${DOM}`, permissoes: { ...perm('editar'), funcionarios: 'sem_acesso' }, percentualComissao: 5, comissaoEscopo: 'propria' });
await gravar('loginsPublicos/walter', { email: `f-WAL-v1@${DOM}` });
await gravar('loginsPublicos/fabio', { email: `f-FUN-v1@${DOM}` });
await gravar('clientes/C1', { razaoSocial: 'Cliente Integração Ltda', cnpj: '11222333000181' });
await gravar('catalogoPecas/P1', { descricao: 'Placa controladora', categoria: 'Placa', valorConserto: 300, criadoEm: new Date('2026-10-01T10:00:00Z') });
await gravar('lotes/L1', { numero: 41, clienteId: 'C1', status: 'Em análise', arquivado: false, criadoEm: new Date('2026-10-20T10:00:00Z'), codigoAssinaturaEntrada: '1234', itens: [{ pecaDescricao: 'Placa controladora', quantidade: 2 }] });
await gravar('orcamentos/O1', { numero: 1, clienteId: 'C1', status: 'Pendente orçamento', total: 600, arquivado: false, ordemKanban: 1, criadoEm: new Date('2026-10-21T10:00:00Z'), itens: [{ descricao: 'Placa', qtd: 2, valorUnit: 300, tipo: 'consertada' }], historico: [] });
await gravar('periodosApuracao/PA1', { nome: 'Out/Nov', dataInicial: '2026-10-24', dataFinal: '2026-11-23', origem: 'manual', editadoManualmente: true });
for (const c of ['migracaoArquivamento_v2', 'migracaoPermissoes', 'migracaoStatusRota', 'migracaoLoteConcluidoOrcado']) await gravar('config/' + c, { feito: true });

// diagnóstico: a conta do master consegue ler a própria ficha direto pela API?
{
  const r1 = await fetch(`${AUTH}/accounts:signInWithPassword?key=fake`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: `f-WAL-v1@${DOM}`, password: derivada('walter123'), returnSecureToken: true }) });
  const t = (await r1.json()).idToken;
  const r2 = await fetch(`${FS}/funcionarios/WAL`, { headers: { Authorization: 'Bearer ' + t } });
  const r3 = await fetch(`${FS}/clientes/C1`, { headers: { Authorization: 'Bearer ' + t } });
  const payload = JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString());
  console.log(`::warning::Diagnóstico API: ficha ${r2.status} ${r2.status !== 200 ? (await r2.text()).slice(0, 200) : ''} | clientes ${r3.status} | token ${JSON.stringify({ email: payload.email, firebase: payload.firebase })}`);
}
// ---- site servido localmente
const tipos = { '.html': 'text/html', '.png': 'image/png', '.json': 'application/json', '.js': 'text/javascript' };
const servidor = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname); if (p === '/') p = '/index.html';
  const f = path.join(RAIZ, p);
  if (!f.startsWith(RAIZ) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': tipos[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
}).listen(5050);
const SITE = 'http://localhost:5050/';
const browser = await chromium.launch();
async function novaPagina() {
  const ctx = await browser.newContext({ geolocation: { latitude: -23.39, longitude: -46.32 }, permissions: ['geolocation'] });
  const page = await ctx.newPage();
  const erros = [];
  page.__log = [];
  page.on('console', m => { page.__log.push(m.type() + ': ' + m.text().slice(0, 300)); });
  page.on('requestfailed', r => page.__log.push('falhou: ' + r.url().slice(0, 120) + ' ' + (r.failure() || {}).errorText));
  page.on('console', m => { if (m.type() === 'error' && /permission|insufficient|PERMISSION_DENIED/i.test(m.text())) erros.push(m.text().slice(0, 200)); });
  page.on('pageerror', e => erros.push('pageerror: ' + e.message));
  page.on('dialog', d => d.accept());
  return { ctx, page, erros };
}
async function entrar(page, login, senha) {
  await page.goto(SITE + '?emulador'); await page.waitForSelector('#acesso-login', { timeout: 30000 });
  await page.fill('#acesso-login', login); await page.fill('#acesso-senha', senha);
  await page.locator('.acesso-btn-entrar').click();
  await page.waitForSelector('.sidebar, .acesso-erro', { timeout: 30000 }).catch(() => {}); await page.waitForTimeout(1500);
  if (!(await page.locator('.sidebar').count())) {
    const erro = await page.locator('.acesso-erro').innerText().catch(() => '(sem mensagem)');
    console.log(`::warning::Login ${login}: ${erro} | ${page.__log.filter(l => !/^falhou/.test(l)).slice(-10).join(' || ').replace(/\n/g, ' ')}`);
  }
}
const esperar = ms => new Promise(r => setTimeout(r, ms));
try {
  // 1) Fábio entra (vai ser "derrubado" depois que a senha dele for redefinida)
  const fabio = await novaPagina();
  await entrar(fabio.page, 'fabio', 'fabio123');
  passo('funcionário entra com o banco fechado', await fabio.page.locator('.sidebar').count() === 1);
  // 2) Walter (master): telas, kanban
  const w = await novaPagina();
  await entrar(w.page, 'walter', 'errada1');
  passo('senha errada é recusada', /Senha incorreta/.test(await w.page.locator('.acesso-erro').innerText().catch(() => '')));
  await entrar(w.page, 'walter', 'walter123');
  passo('master entra com o banco fechado', await w.page.locator('.sidebar').count() === 1);
  for (const t of ['Painel', 'Entrada de Peças', 'Cadastro de Peças', 'Clientes', 'Orçamento', 'Comissão', 'Equipe', 'Avisos']) {
    await w.page.locator('.sidebar-item', { hasText: t }).first().click(); await w.page.waitForTimeout(1200);
  }
  passo('master passa por todas as telas sem erro de permissão', w.erros.length === 0, w.erros.join(' | '));
  passo('migrações de primeiro login rodam com o banco fechado (carimbo e índice de CPFs)', !!(await ler('config/migracaoCarimboSincronizacao')) && !!(await ler('config/migracaoIndiceCpfs')));
  await w.page.locator('.sidebar-item', { hasText: 'Orçamento' }).first().click(); await w.page.waitForSelector('[data-orc-id="O1"]');
  await w.page.locator('[data-orc-id="O1"] select').selectOption('Em Análise'); await esperar(1500);
  const o1 = await ler('orcamentos/O1');
  passo('mover o cartão no kanban grava no banco (status + histórico + carimbo)', o1.status === 'Em Análise' && o1.historico.length === 1 && !!o1.atualizadoEm, JSON.stringify(o1).slice(0, 200));
  // 3) Conta da rotina de backup (painel de segurança do master)
  await w.page.locator('.sidebar-item', { hasText: 'Equipe' }).first().click(); await w.page.waitForTimeout(800);
  await w.page.locator('.seguranca-acesso-resumo').click();
  await w.page.locator('.seguranca-acesso button', { hasText: 'Criar acesso da rotina de backup' }).click();
  await w.page.waitForSelector('.seguranca-acesso-credencial', { timeout: 20000 });
  const codigos = await w.page.locator('.seguranca-acesso-credencial code').allInnerTexts();
  const [bEmail, bSenha] = [codigos[1], codigos[3]];
  passo('master cria a conta da rotina de backup (registrada em seguranca/backup)', /^backup-.+@/.test(bEmail || '') && !!(await ler('seguranca/backup'))?.uid, JSON.stringify(codigos));
  passo('master continua logado depois de criar contas', await w.page.locator('.sidebar').count() === 1);
  const rodarBackup = env => spawnSync('node', [path.join(RAIZ, 'backup/gerar-backup.mjs'), '--modo', 'teste', '--saida', '/tmp/saida-teste'], { env: { ...process.env, FIRESTORE_BASE: 'http://127.0.0.1:8080/v1', AUTH_BASE: AUTH, FIREBASE_PROJECT_ID: PROJ, FIREBASE_API_KEY: 'fake', GITHUB_ACTIONS: '', ...env }, encoding: 'utf8' });
  const semConta = rodarBackup({ FIREBASE_EMAIL: '', FIREBASE_SENHA: '' });
  passo('rotina de backup SEM a conta não lê o banco fechado', semConta.status !== 0, (semConta.stdout + semConta.stderr).slice(-300));
  const comConta = rodarBackup({ FIREBASE_EMAIL: bEmail, FIREBASE_SENHA: bSenha });
  passo('rotina de backup COM a conta lê o banco inteiro e passa no teste de recuperação', comConta.status === 0 && /TESTE DE RECUPERAÇÃO APROVADO/.test(comConta.stdout), (comConta.stdout + comConta.stderr).slice(-400));
  // 4) Redefinir a senha do Fábio: conta nova, a antiga cai
  await w.page.locator('tr, .card, li', { hasText: 'Fábio Teste' }).last().click(); await w.page.waitForTimeout(800);
  await w.page.locator('.modal').getByText('Acesso', { exact: true }).first().click().catch(() => {});
  await w.page.locator('.modal button', { hasText: 'Redefinir senha' }).click();
  await w.page.locator('.modal button', { hasText: 'Gerar nova senha' }).click(); await esperar(2500);
  const senhaTemp = (await w.page.locator('.modal').last().innerText()).match(/\b[A-Z2-9]{8}\b/g)?.pop();
  const fun = await ler('funcionarios/FUN');
  passo('administrador redefine a senha (conta v2)', fun.authEmail === `f-FUN-v2@${DOM}` && !!senhaTemp, fun.authEmail);
  await fabio.page.reload(); await fabio.page.waitForSelector('#acesso-login, .sidebar', { timeout: 30000 }); await fabio.page.waitForTimeout(2000);
  passo('sessão com a senha antiga é encerrada com aviso', await fabio.page.locator('.sidebar').count() === 0 && /redefinida/.test(await fabio.page.locator('.acesso-erro').innerText().catch(() => '')), await fabio.page.locator('body').innerText().then(t => t.slice(0, 200)));
  await entrar(fabio.page, 'fabio', senhaTemp);
  passo('funcionário entra com a senha temporária e usa o sistema', await fabio.page.locator('.sidebar').count() === 1);
  for (const t of ['Painel', 'Entrada de Peças', 'Orçamento', 'Clientes']) { await fabio.page.locator('.sidebar-item', { hasText: t }).first().click().catch(() => {}); await fabio.page.waitForTimeout(1000); }
  passo('funcionário usa as telas sem erro de permissão', fabio.erros.filter(e => !/redefinida/.test(e)).length === 0, fabio.erros.join(' | '));
  // 5) Assinatura por link (cliente, sem login)
  const cli = await novaPagina();
  await cli.page.goto(SITE + '?assinar=entrada&id=L1&emulador'); await cli.page.waitForSelector('input', { timeout: 30000 });
  await cli.page.locator('input').first().fill('1234'); await cli.page.getByText('Continuar').click();
  await cli.page.waitForSelector('form input', { timeout: 20000 });
  await cli.page.locator('form input').first().fill('Maria Aparecida da Silva'); await cli.page.locator('form input').nth(1).fill('52998224725');
  await cli.page.locator('form button.btn:not(.secundario)').last().click(); await esperar(6000);
  const l1 = await ler('lotes/L1');
  passo('cliente assina pelo link como visitante (só a assinatura é gravada)', l1.assinaturaEntrada && l1.assinaturaEntrada.nome === 'Maria Aparecida da Silva' && l1.status === 'Em análise', JSON.stringify(l1.assinaturaEntrada || null).slice(0, 150));
  passo('assinatura sem erro de permissão', cli.erros.length === 0, cli.erros.join(' | '));
  // 6) Cadastro pelo próprio funcionário (fica pendente)
  const novo = await novaPagina();
  await novo.page.goto(SITE + '?emulador'); await novo.page.waitForSelector('#acesso-login', { timeout: 30000 });
  await novo.page.locator('.acesso-btn-sec', { hasText: 'Criar minha conta' }).click();
  const cc = (rot, v) => novo.page.locator(`form label:text-is("${rot}") + input`).first().fill(v);
  await cc('Nome completo', 'Diego Novo'); await novo.page.locator('form label:text-is("CPF") + input').fill('11144477735');
  await cc('Login', 'diego'); await cc('Senha', 'diego123'); await cc('Confirmar senha', 'diego123');
  await novo.page.locator('form button.btn', { hasText: 'Enviar cadastro' }).click(); await novo.page.waitForSelector('text=Cadastro enviado', { timeout: 20000 }).catch(() => {});
  const diego = (await listar('funcionarios')).find(f => f.login === 'diego');
  passo('cadastro pelo próprio funcionário: ficha pendente criada com o banco fechado', diego && diego.status === 'pendente' && /^f-.+-v1@/.test(diego.authEmail || ''), JSON.stringify(diego || null).slice(0, 200));
  await novo.page.locator('button', { hasText: 'Voltar para o início' }).click().catch(() => {});
  await entrar(novo.page, 'diego', 'diego123');
  passo('cadastro pendente não entra', await novo.page.locator('.sidebar').count() === 0 && /aguardando/.test(await novo.page.locator('.acesso-erro').innerText().catch(() => '')));
  // 7) Estranho: nada sem login
  const r = await fetch(`${FS}/clientes/C1`);
  passo('sem login, o banco não entrega dados (acesso direto à API)', r.status === 403 || r.status === 401, r.status);
} catch (e) {
  falhas++; console.log('FALHOU erro inesperado — ' + (e.stack || e)); console.log('::error::Integração: erro inesperado ' + String(e.message || e).slice(0, 200));
}
await browser.close(); servidor.close();
console.log(`\n${ok}/${ok + falhas} verificações de integração ${falhas ? 'com FALHAS' : 'OK'}`);
console.log(falhas ? `::error::Integração com as regras: ${falhas} falha(s)` : `::notice::Integração com as regras: ${ok} verificações OK`);
process.exit(falhas ? 1 : 0);
