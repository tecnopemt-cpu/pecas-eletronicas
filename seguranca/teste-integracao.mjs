// Teste de ponta a ponta do sistema COM as regras de segurança (roda no GitHub Actions).
// Sobe os emuladores oficiais do Firestore e do Authentication, aplica seguranca/firestore.rules, abre o
// site de verdade (index.html, com ?emulador) num navegador e usa o sistema como as pessoas usam:
// login, telas, kanban, redefinir senha, conta do backup, assinatura por link, cadastro pendente e
// avaliação de desempenho (gestão registra/aprova; funcionário vê só o que é dele).
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
const passo = (nome, cond, det) => { if (cond) { ok++; console.log('OK     ' + nome); } else { falhas++; console.log('FALHOU ' + nome + (det !== undefined ? ' — ' + det : '')); console.log(`::error::Integração: ${nome}${det !== undefined ? ' — ' + String(det).replace(/\n/g, ' ').slice(0, 400) : ''}`); } };

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
const emWAL = `f-wal-v1@${DOM}`, emFUN = `f-fun-v1@${DOM}`;
const uidWAL = await criarConta(emWAL, derivada('walter123'));
const uidFUN = await criarConta(emFUN, derivada('fabio123'));
await gravar('funcionarios/WAL', { nome: 'Walter Teste', perfil: 'master', status: 'ativo', login: 'walter', cpf: '52998224725', authEmail: emWAL, authUid: uidWAL, permissoes: perm('editar'), percentualComissao: 0 });
await gravar('funcionarios/FUN', { nome: 'Fábio Teste', perfil: 'funcionario', status: 'ativo', login: 'fabio', authEmail: emFUN, authUid: uidFUN, permissoes: { ...perm('editar'), funcionarios: 'sem_acesso' }, percentualComissao: 5, comissaoEscopo: 'propria' });
await gravar('contas/' + uidWAL, { funcionarioId: 'WAL', email: emWAL });
await gravar('contas/' + uidFUN, { funcionarioId: 'FUN', email: emFUN });
await gravar('loginsPublicos/walter', { email: emWAL });
await gravar('loginsPublicos/fabio', { email: emFUN });
await gravar('clientes/C1', { razaoSocial: 'Cliente Integração Ltda', cnpj: '11222333000181' });
await gravar('catalogoPecas/P1', { descricao: 'Placa controladora', categoria: 'Placa', valorConserto: 300, criadoEm: new Date('2026-10-01T10:00:00Z') });
await gravar('lotes/L1', { numero: 41, clienteId: 'C1', status: 'Em análise', arquivado: false, criadoEm: new Date('2026-10-20T10:00:00Z'), itens: [{ pecaDescricao: 'Placa controladora', quantidade: 2 }] });
await gravar('orcamentos/O1', { numero: 1, clienteId: 'C1', status: 'Pendente orçamento', total: 600, arquivado: false, ordemKanban: 1, criadoEm: new Date('2026-10-21T10:00:00Z'), itens: [{ descricao: 'Placa', qtd: 2, valorUnit: 300, tipo: 'consertada' }], historico: [] });
await gravar('codigosAssinatura/entrada_L1', { tipo: 'entrada', colecao: 'lotes', documentoId: 'L1', campoAssinatura: 'assinaturaEntrada', codigo: '0372', expiraEm: new Date(Date.now() + 7 * 864e5), tentativas: 0, tentativa: '', tentativaPor: '', confirmado: false, usado: false });
await gravar('periodosApuracao/PA1', { nome: 'Out/Nov', dataInicial: '2026-10-24', dataFinal: '2026-11-23', origem: 'manual', editadoManualmente: true });
for (const c of ['migracaoArquivamento_v2', 'migracaoPermissoes', 'migracaoStatusRota', 'migracaoLoteConcluidoOrcado']) await gravar('config/' + c, { feito: true });

// diagnóstico: a conta do master consegue ler a própria ficha direto pela API?
{
  const r1 = await fetch(`${AUTH}/accounts:signInWithPassword?key=fake`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: emWAL, password: derivada('walter123'), returnSecureToken: true }) });
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
let etapa = '';
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
  passo('administrador redefine a senha (conta v2)', fun.authEmail === `f-fun-v2@${DOM}` && fun.authUid !== uidFUN && !!senhaTemp, fun.authEmail);
  // a tela do Fábio, aberta com a senha antiga, sai sozinha e mostra o aviso
  await fabio.page.waitForSelector('#acesso-login', { timeout: 30000 }).catch(() => {}); await fabio.page.waitForTimeout(1000);
  passo('sessão com a senha antiga é encerrada na hora, com aviso', await fabio.page.locator('.sidebar').count() === 0 && /redefinida/.test(await fabio.page.locator('.acesso-erro').innerText().catch(() => '')), await fabio.page.locator('body').innerText().then(t => t.slice(0, 200)));
  fabio.erros.length = 0; // erros de permissão da sessão antiga (esperados) ficam de fora
  await entrar(fabio.page, 'fabio', senhaTemp);
  passo('funcionário entra com a senha temporária e usa o sistema', await fabio.page.locator('.sidebar').count() === 1);
  for (const t of ['Painel', 'Entrada de Peças', 'Orçamento', 'Clientes']) { await fabio.page.locator('.sidebar-item', { hasText: t }).first().click().catch(() => {}); await fabio.page.waitForTimeout(1000); }
  passo('funcionário usa as telas sem erro de permissão', fabio.erros.filter(e => !/redefinida/.test(e)).length === 0, fabio.erros.join(' | '));
  // 5) Assinatura por link (cliente, sem login)
  const cli = await novaPagina();
  await cli.page.goto(SITE + '?assinar=entrada&id=L1&emulador'); await cli.page.waitForSelector('input', { timeout: 30000 });
  await cli.page.locator('input').first().fill('1111'); await cli.page.getByText('Continuar').click();
  await cli.page.waitForSelector('text=Código incorreto', { timeout: 20000 }).catch(() => {});
  passo('código errado é recusado pelo banco (e conta como tentativa)', await cli.page.locator('text=Código incorreto').count() === 1 && (await ler('codigosAssinatura/entrada_L1')).tentativas === 1);
  cli.erros.length = 0; // a recusa do código errado aparece como "sem permissão" no console (esperado)
  await cli.page.locator('input').first().fill('0372'); await cli.page.getByText('Continuar').click();
  await cli.page.waitForSelector('form input', { timeout: 20000 });
  await cli.page.locator('form input').first().fill('Maria Aparecida da Silva'); await cli.page.locator('form input').nth(1).fill('52998224725');
  await cli.page.locator('form button.btn:not(.secundario)').last().click(); await esperar(6000);
  const l1 = await ler('lotes/L1');
  passo('cliente assina pelo link como visitante (só a assinatura é gravada)', l1.assinaturaEntrada && l1.assinaturaEntrada.nome === 'Maria Aparecida da Silva' && l1.status === 'Em análise', JSON.stringify(l1.assinaturaEntrada || null).slice(0, 150));
  const codL1 = await ler('codigosAssinatura/entrada_L1');
  passo('código de 4 dígitos (com zero na frente) confirmado e gasto junto com a assinatura', codL1.confirmado === true && codL1.usado === true && codL1.tentativas === 2, JSON.stringify(codL1));
  // código usado não serve de novo: outro visitante, mesmo link e mesmo código
  const cli2 = await novaPagina();
  await cli2.page.goto(SITE + '?assinar=entrada&id=L1&emulador'); await cli2.page.waitForTimeout(4000);
  passo('documento já assinado: o link mostra "assinatura confirmada" e não pede código', /Assinatura confirmada/.test(await cli2.page.locator('body').innerText()));
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
  // 7) Avaliação de desempenho com as regras valendo: registro, correção, avaliação, aprovação, meta, visão do funcionário
  // a janela de redefinir senha ficou aberta lá atrás: recarrega a tela (a sessão continua)
  await w.page.goto(SITE + '?emulador'); await w.page.waitForSelector('.sidebar', { timeout: 30000 });
  w.erros.length = 0;
  etapa = 'avaliação passo 1'; await w.page.locator('.sidebar-item', { hasText: 'Avaliação' }).first().click(); await w.page.waitForTimeout(1200);
  etapa = 'avaliação passo 2'; await w.page.locator('.av-botoes-rapidos button', { hasText: 'Novo registro' }).click();
  const mr = w.page.locator('.av-modal-registro');
  await mr.locator('select').nth(0).selectOption('FUN'); await mr.locator('select').nth(1).selectOption('Organização'); await mr.locator('select').nth(2).selectOption('positivo');
  await mr.locator('textarea').first().fill('Organizou a bancada antes do serviço.');
  etapa = 'avaliação passo 3'; await mr.locator('button', { hasText: 'Revisar e salvar' }).click(); await mr.locator('button', { hasText: 'Salvar registro' }).click();
  await w.page.waitForSelector('.av-sucesso-titulo', { timeout: 15000 }).catch(() => {});
  let regsAv = await listar('avaliacaoRegistros');
  passo('avaliação: registro diário gravado com o banco fechado', regsAv.length === 1 && regsAv[0].funcionarioId === 'FUN' && regsAv[0].registradoPorId === 'WAL', JSON.stringify(regsAv).slice(0, 200));
  etapa = 'avaliação passo 4'; await mr.locator('button', { hasText: 'Fechar' }).click();
  etapa = 'avaliação passo 5'; await w.page.locator('.abas-internas button', { hasText: 'Histórico' }).click(); await w.page.waitForTimeout(800);
  etapa = 'avaliação passo 6'; await w.page.locator('.av-tabela tr', { hasText: 'Organizou a bancada' }).click(); await w.page.waitForTimeout(500);
  const mc = w.page.locator('.modal').last();
  etapa = 'avaliação passo 7'; await mc.locator('button', { hasText: 'Corrigir' }).click(); await mc.locator('textarea').first().fill('Organizou a bancada e as peças antes do serviço.');
  etapa = 'avaliação passo 8'; await mc.locator('button', { hasText: 'Salvar correção' }).click(); await esperar(1500);
  regsAv = await listar('avaliacaoRegistros');
  passo('avaliação: correção gravada com histórico', /e as peças/.test(regsAv[0].descricao) && regsAv[0].historicoAlteracoes.length === 1, JSON.stringify(regsAv[0]).slice(0, 300));
  etapa = 'avaliação passo 9'; await mc.locator('button', { hasText: 'Fechar' }).first().click();
  etapa = 'avaliação passo 10'; await w.page.locator('.abas-internas button', { hasText: 'Avaliações trimestrais' }).click(); await w.page.waitForTimeout(800);
  etapa = 'avaliação passo 11'; await w.page.locator('.av-tabela tr', { hasText: 'Fábio' }).locator('button').click(); await w.page.waitForSelector('.av-modal-avaliacao', { timeout: 15000 });
  etapa = 'avaliação passo 12'; await w.page.locator('.av-modal-avaliacao button', { hasText: 'Salvar revisão' }).click(); await esperar(1200);
  etapa = 'avaliação passo 13'; await w.page.locator('.av-modal-avaliacao button', { hasText: 'Aprovar…' }).click();
  etapa = 'avaliação passo 14'; await w.page.locator('.av-modal-avaliacao .av-confirmar button', { hasText: /^Aprovar$/ }).click(); await esperar(2000);
  const avs = await listar('avaliacoesTrimestrais'), pubs = await listar('avaliacoesPublicadas');
  passo('avaliação: gerada, revisada, aprovada e publicada', avs.length === 1 && avs[0].status === 'aprovada' && pubs.length === 1 && pubs[0].funcionarioId === 'FUN', JSON.stringify(avs.map(a => a.status)) + ' ' + pubs.length);
  etapa = 'avaliação passo 15'; await w.page.locator('.av-modal-avaliacao button', { hasText: 'Fechar' }).first().click();
  etapa = 'avaliação passo 16'; await w.page.locator('.abas-internas button', { hasText: 'Metas e PDI' }).click(); await w.page.waitForTimeout(500);
  etapa = 'avaliação passo 17'; await w.page.locator('.av-filtros button', { hasText: 'Nova meta' }).click();
  const mm = w.page.locator('.modal').last();
  await mm.locator('select').first().selectOption('FUN'); await mm.locator('textarea').first().fill('Conferir as peças antes de separar');
  etapa = 'avaliação passo 18'; await mm.locator('button', { hasText: 'Salvar meta' }).click(); await esperar(1500);
  passo('avaliação: meta criada', (await listar('avaliacaoMetas')).length === 1);
  passo('avaliação: gestão usa o módulo sem erro de permissão', w.erros.length === 0, w.erros.join(' | '));
  fabio.erros.length = 0;
  etapa = 'avaliação passo 19'; await fabio.page.locator('.sidebar-item', { hasText: 'Avaliação' }).first().click(); await fabio.page.waitForTimeout(2500);
  const tf = await fabio.page.locator('.av-modulo').innerText().catch(() => '');
  passo('avaliação: funcionário vê a própria avaliação aprovada e a meta, sem os registros', /trimestre de/.test(tf) && /Conferir as peças/.test(tf) && !/Organizou a bancada/.test(tf), tf.slice(0, 300));
  passo('avaliação: funcionário sem erro de permissão', fabio.erros.length === 0, fabio.erros.join(' | '));
  // 7) Estranho: nada sem login
  const r = await fetch(`${FS}/clientes/C1`);
  passo('sem login, o banco não entrega dados (acesso direto à API)', r.status === 403 || r.status === 401, r.status);
} catch (e) {
  falhas++; console.log('FALHOU erro inesperado — ' + etapa + ' ' + (e.stack || e)); console.log('::error::Integração: erro inesperado (' + etapa + ') ' + String(e.message || e).slice(0, 200));
}
await browser.close(); servidor.close();
console.log(`\n${ok}/${ok + falhas} verificações de integração ${falhas ? 'com FALHAS' : 'OK'}`);
console.log(falhas ? `::error::Integração com as regras: ${falhas} falha(s)` : `::notice::Integração com as regras: ${ok} verificações OK`);
process.exit(falhas ? 1 : 0);
