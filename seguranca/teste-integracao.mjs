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
import { spawnSync, spawn } from 'node:child_process';
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
  await cli.page.waitForSelector('text=Nome completo', { timeout: 20000 }); // o código é conferido pelo banco (assíncrono)
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
  // navegação por colaborador: Equipe → cartão do Fábio → Registros diários
  etapa = 'avaliação passo 2'; await w.page.locator('.av-card', { hasText: 'Fábio' }).click(); await w.page.locator('.av-area[data-secao=registros]').click(); await w.page.waitForTimeout(500);
  await w.page.locator('.av-perfil-secao .av-botoes-rapidos button', { hasText: 'Novo registro' }).click();
  const mr = w.page.locator('.av-modal-registro');
  passo('avaliação: registro aberto pelo perfil já vem com o colaborador', await mr.locator('select').nth(0).inputValue() === 'FUN');
  await mr.locator('select').nth(1).selectOption('Organização'); await mr.locator('select').nth(2).selectOption('positivo');
  await mr.locator('textarea').first().fill('Organizou a bancada antes do serviço.');
  // anexo (foto) no registro: guardado à parte, com as mesmas regras dos certificados
  const PNGI = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  await mr.locator('input[type=file]').setInputFiles({ name: 'bancada.png', mimeType: 'image/png', buffer: PNGI }); await w.page.waitForTimeout(500);
  etapa = 'avaliação passo 3'; await mr.locator('button', { hasText: 'Revisar e salvar' }).click(); await mr.locator('button', { hasText: 'Salvar registro' }).click();
  await w.page.waitForSelector('.av-sucesso-titulo', { timeout: 15000 }).catch(() => {});
  let regsAv = await listar('avaliacaoRegistros');
  passo('avaliação: registro diário gravado com o banco fechado', regsAv.length === 1 && regsAv[0].funcionarioId === 'FUN' && regsAv[0].registradoPorId === 'WAL', JSON.stringify(regsAv).slice(0, 200));
  const certsReg = (await listar('certificados')).filter(c => c.registroId === (regsAv[0] && regsAv[0].id));
  passo('avaliação: anexo do registro gravado com as regras valendo (protegido, à parte)', regsAv[0] && (regsAv[0].anexos || []).length === 1 && certsReg.length === 1 && certsReg[0].funcionarioId === 'FUN', JSON.stringify(regsAv[0] && regsAv[0].anexos));
  etapa = 'avaliação passo 4'; await mr.locator('button', { hasText: 'Fechar' }).click();
  etapa = 'avaliação passo 5'; await w.page.waitForTimeout(800);
  etapa = 'avaliação passo 6'; await w.page.locator('.av-tl-item', { hasText: 'Organizou a bancada' }).locator('button').click(); await w.page.waitForTimeout(500);
  const mc = w.page.locator('.modal').last();
  etapa = 'avaliação passo 7'; await mc.locator('button', { hasText: 'Corrigir' }).click(); await mc.locator('textarea').first().fill('Organizou a bancada e as peças antes do serviço.');
  etapa = 'avaliação passo 8'; await mc.locator('button', { hasText: 'Salvar correção' }).click(); await esperar(1500);
  regsAv = await listar('avaliacaoRegistros');
  passo('avaliação: correção gravada com histórico', /e as peças/.test(regsAv[0].descricao) && regsAv[0].historicoAlteracoes.length === 1, JSON.stringify(regsAv[0]).slice(0, 300));
  etapa = 'avaliação passo 9'; await mc.locator('button', { hasText: 'Fechar' }).first().click();
  etapa = 'avaliação passo 10'; await w.page.locator('.av-secao-cab .av-voltar').click(); await w.page.locator('.av-ficha-btn-av').click(); await w.page.waitForTimeout(800);
  // 2ª linha = trimestre anterior (o que está sendo avaliado)
  etapa = 'avaliação passo 11'; await w.page.locator('.av-perfil-secao .av-tabela tbody tr').nth(1).locator('button').click(); await w.page.waitForSelector('.av-modal-avaliacao', { timeout: 15000 });
  etapa = 'avaliação passo 12'; await w.page.locator('.av-modal-avaliacao button', { hasText: 'Salvar revisão' }).click(); await esperar(1200);
  etapa = 'avaliação passo 13'; await w.page.locator('.av-modal-avaliacao button', { hasText: 'Aprovar…' }).click();
  etapa = 'avaliação passo 14'; await w.page.locator('.av-modal-avaliacao .av-confirmar button', { hasText: /^Aprovar$/ }).click(); await esperar(2000);
  const avs = await listar('avaliacoesTrimestrais'), pubs = await listar('avaliacoesPublicadas');
  passo('avaliação: gerada, revisada, aprovada e publicada', avs.length === 1 && avs[0].status === 'aprovada' && pubs.length === 1 && pubs[0].funcionarioId === 'FUN', JSON.stringify(avs.map(a => a.status)) + ' ' + pubs.length);
  etapa = 'avaliação passo 15'; await w.page.locator('.av-modal-avaliacao button', { hasText: 'Fechar' }).first().click();
  etapa = 'avaliação passo 16'; await w.page.locator('.av-secao-cab .av-voltar').click(); await w.page.locator('.av-area[data-secao=metas]').click(); await w.page.waitForTimeout(500);
  etapa = 'avaliação passo 17'; await w.page.locator('.av-filtros button', { hasText: 'Nova meta' }).click();
  const mm = w.page.locator('.modal').last();
  await mm.locator('select').first().selectOption('FUN'); await mm.locator('textarea').first().fill('Conferir as peças antes de separar');
  etapa = 'avaliação passo 18'; await mm.locator('button', { hasText: 'Salvar meta' }).click(); await esperar(1500);
  passo('avaliação: meta criada', (await listar('avaliacaoMetas')).length === 1);
  passo('avaliação: gestão usa o módulo sem erro de permissão', w.erros.length === 0, w.erros.join(' | '));
  fabio.erros.length = 0;
  etapa = 'avaliação passo 19'; await fabio.page.locator('.sidebar-item', { hasText: 'Avaliação' }).first().click(); await fabio.page.waitForTimeout(2500);
  const tCab = await fabio.page.locator('.av-ficha-cab').innerText().catch(() => '');
  await fabio.page.locator('.av-area[data-secao=metas]').click().catch(() => {}); await fabio.page.waitForTimeout(1200);
  const tMetas = await fabio.page.locator('.av-modulo').innerText().catch(() => '');
  await fabio.page.locator('.av-perfil-secao .av-voltar').click().catch(() => {}); await fabio.page.locator('.av-area[data-secao=relatorios]').click().catch(() => {}); await fabio.page.waitForTimeout(1200);
  const tf = tCab + tMetas + await fabio.page.locator('.av-modulo').innerText().catch(() => '');
  passo('avaliação: funcionário vê a própria ficha, avaliação aprovada e a meta, sem os registros', /trimestre de/.test(tCab) && /Conferir as peças/.test(tMetas) && /trimestre de/.test(tf) && !/Organizou a bancada/.test(tf), tf.slice(0, 300));
  passo('avaliação: funcionário sem erro de permissão', fabio.erros.length === 0, fabio.erros.join(' | '));
  // 8) Tempo real entre dois usuários (Orçamentos): o que um faz aparece para o outro sem recarregar
  etapa = 'tempo real';
  const A = w.page, B = fabio.page;
  const ate = async (fn, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await fn()) return true; } catch (e) {} await esperar(300); } return false; };
  await A.locator('.sidebar-item', { hasText: 'Orçamento' }).first().click();
  await B.locator('.sidebar-item', { hasText: 'Orçamento' }).first().click();
  await esperar(2000);
  w.erros.length = 0; fabio.erros.length = 0;
  const idRT = await A.evaluate(async () => { const ref = db.collection('orcamentos').doc(); await ref.set({ numero: 7001, clienteId: 'C1', status: 'Pendente orçamento', total: 800, arquivado: false, ordemKanban: 1, criadoEm: firebase.firestore.FieldValue.serverTimestamp(), historico: [], itens: [{ descricao: 'Placa tempo real', qtd: 1, valorUnit: 800, tipo: 'consertada' }] }); return ref.id; });
  const cartaoB = B.locator(`[data-orc-id="${idRT}"]`);
  passo('tempo real: A cria orçamento, B vê sem recarregar', await ate(async () => await cartaoB.count() === 1));
  await A.locator(`[data-orc-id="${idRT}"] select`).selectOption('Aprovado/Aguardando pedido');
  passo('tempo real: A move o cartão, B vê na nova coluna', await ate(async () => await cartaoB.locator('select').inputValue() === 'Aprovado/Aguardando pedido'));
  await A.evaluate(id => db.collection('orcamentos').doc(id).update({ numeroPedidoCompras: '4455' }), idRT);
  passo('tempo real: A altera o pedido de compra, B vê no cartão', await ate(async () => /Pedido: 4455/.test(await cartaoB.innerText())));
  await A.locator(`[data-orc-id="${idRT}"] .indicador-liberado`).click();
  passo('tempo real: A marca "liberado para faturar", B vê o destaque', await ate(async () => /cartao-liberado/.test(await cartaoB.getAttribute('class') || '')));
  await A.locator(`[data-orc-id="${idRT}"] select`).selectOption('Concluído');
  passo('tempo real: A conclui, B vê em Concluído', await ate(async () => await cartaoB.locator('select').inputValue() === 'Concluído'));
  // queda de conexão de B e volta
  await fabio.ctx.setOffline(true);
  passo('sem internet: B vê o aviso "Sem conexão"', await ate(async () => await B.locator('.indicador-conexao').getAttribute('data-conexao') === 'offline', 5000));
  await A.evaluate(id => db.collection('orcamentos').doc(id).update({ numeroPedidoCompras: '9999' }), idRT);
  await esperar(1500);
  await fabio.ctx.setOffline(false);
  passo('internet volta: B recebe o que mudou enquanto estava sem conexão', await ate(async () => /Pedido: 9999/.test(await cartaoB.innerText()), 30000), await cartaoB.innerText().catch(() => ''));
  passo('internet volta: indicador de B volta a "Sincronizado"', await ate(async () => await B.locator('.indicador-conexao').getAttribute('data-conexao') === 'ok', 20000));
  // dois usuários editando o mesmo orçamento: ninguém perde o que fez
  etapa = 'concorrência';
  await cartaoB.getByText('📅', { exact: false }).click(); await B.waitForSelector('form.modal');
  await A.evaluate(id => db.collection('orcamentos').doc(id).update({ observacao: 'Observação de A' }), idRT);
  await esperar(2500);
  const campoPedidoB = B.locator('form.modal input[placeholder*="edido" i]').first();
  if (await campoPedidoB.count()) await campoPedidoB.fill('PED-B'); else await B.locator('form.modal label', { hasText: /pedido/i }).locator('xpath=following::input[1]').fill('PED-B');
  await B.locator('form.modal button.btn:not(.secundario)').last().click(); await esperar(3000);
  const rt = await ler('orcamentos/' + idRT);
  passo('concorrência: B salva o pedido sem apagar a observação que A gravou', rt.numeroPedidoCompras === 'PED-B' && rt.observacao === 'Observação de A' && rt.status === 'Concluído', JSON.stringify({ p: rt.numeroPedidoCompras, o: rt.observacao, s: rt.status }));
  passo('nenhum orçamento duplicado', (await listar('orcamentos')).filter(o => o.numero === 7001).length === 1);
  passo('tempo real sem erros de permissão', w.erros.length === 0 && fabio.erros.length === 0, [...w.erros, ...fabio.erros].join(' | '));
  // 9) Desenvolvimento profissional: curso com certificado, resumo montado pelo sistema, funcionário vê o seu
  etapa = 'formação';
  w.erros.length = 0; fabio.erros.length = 0;
  await w.page.locator('.sidebar-item', { hasText: 'Avaliação' }).first().click(); await esperar(1200);
  await w.page.locator('.av-barra-modulo .av-voltar', { hasText: 'Equipe' }).click().catch(() => {}); await esperar(300);
  await w.page.locator('.av-card', { hasText: 'Fábio' }).click(); await w.page.locator('.av-area[data-secao=cursos]').click(); await esperar(800);
  await w.page.locator('.fp-cab button', { hasText: 'Adicionar curso ou formação' }).click();
  const fm = w.page.locator('.fp-modal');
  await fm.locator('input[aria-label="Nome do curso ou formação"]').fill('Eletrônica de Potência');
  await fm.locator('input[aria-label="Instituição responsável"]').fill('Senai');
  await fm.locator('select[aria-label="Tipo de formação"]').selectOption('Curso técnico');
  await fm.locator('input[aria-label="Data de conclusão"]').fill('2025-06-30');
  await fm.locator('input[aria-label="Carga horária"]').fill('60');
  const PDFI = Buffer.from('%PDF-1.4 teste ' + 'y'.repeat(800000));
  await fm.locator('input[type=file]').setInputFiles({ name: 'potencia.pdf', mimeType: 'application/pdf', buffer: PDFI }); await esperar(800);
  await fm.locator('button[type=submit]').click(); await esperar(3000);
  const cursosI = await listar('cursosProfissionais');
  const cursoCertId = cursosI[0] && cursosI[0].certificado && cursosI[0].certificado.id;
  const certI = (await listar('certificadosPartes')).filter(p => p.certificadoId === cursoCertId);
  passo('formação: gestão cadastra curso com certificado (regras aceitam curso + certificado em partes)', cursosI.length === 1 && cursosI[0].funcionarioId === 'FUN' && cursosI[0].certificado && certI.length === cursosI[0].certificado.partes && certI.length >= 2, JSON.stringify(cursosI.map(c => c.nome)) + ' ' + certI.length + ' ' + w.erros.join('|'));
  // relatório de avaliação (gerador): só leituras, com as regras valendo (gestão lê registros, avaliações, metas e cursos)
  await w.page.locator('.av-secao-cab .av-voltar').click(); await w.page.locator('.av-area[data-secao=relatorios]').click(); await esperar(800);
  await w.page.locator('.rl-passo').first().locator('.av-chip', { hasText: 'Todo o histórico' }).click();
  await w.page.locator('.rl-modelo strong', { hasText: /^Completo$/ }).click();
  await w.page.locator('.rl-config button', { hasText: 'Ver prévia' }).click();
  await w.page.waitForSelector('.rl-previa', { timeout: 20000 }).catch(() => {}); await esperar(800);
  const rgT = await w.page.locator('.rl-previa').innerText().catch(() => '');
  passo('relatório de avaliação: monta com as regras valendo (registro com anexo, avaliação aprovada, meta e curso do Fábio)', /Organizou a bancada e as peças/.test(rgT) && /📎 1/.test(rgT) && /Aprovada/.test(rgT) && /Conferir as peças antes de separar/.test(rgT) && /Eletrônica de Potência/.test(rgT) && /Certificado anexado/.test(rgT), rgT.slice(0, 300));
  passo('relatório geral: não grava nada', !(await ler('resumosProfissionais/FUN')));
  await fabio.page.locator('.sidebar-item', { hasText: 'Avaliação' }).first().click(); await esperar(1500);
  await fabio.page.locator('.av-perfil-secao .av-voltar').click().catch(() => {}); await esperar(300);
  await fabio.page.locator('.av-area[data-secao=cursos]').click().catch(() => {}); await esperar(2000);
  const tfF = await fabio.page.locator('.fp-secao').innerText().catch(() => '');
  passo('formação: funcionário vê o próprio curso', /Eletrônica de Potência/.test(tfF), tfF.slice(0, 200));
  await fabio.page.locator('.fp-secao .fp-item button', { hasText: 'Ver / baixar' }).click();
  await fabio.page.waitForSelector('.fp-visor-pdf, .fp-visor .av-erro', { timeout: 15000 }).catch(() => {});
  passo('formação: funcionário abre o próprio certificado', await fabio.page.locator('.fp-visor-pdf').count() === 1);
  await fabio.page.locator('.fp-visor button', { hasText: 'Fechar' }).click().catch(() => {});
  passo('formação: sem erros de permissão', w.erros.length === 0 && fabio.erros.length === 0, [...w.erros, ...fabio.erros].join(' | '));
  // 10) Central de Monitoramento: rotinas gravam com a conta do backup (regras valendo); só o Master vê
  etapa = 'monitoramento';
  w.erros.length = 0;
  const envRotina = { ...process.env, FIRESTORE_BASE: 'http://127.0.0.1:8080/v1', AUTH_BASE: AUTH, FIREBASE_PROJECT_ID: PROJ, FIREBASE_API_KEY: 'fake', FIREBASE_EMAIL: bEmail, FIREBASE_SENHA: bSenha, GITHUB_ACTIONS: '' };
  const medir = spawnSync('node', ['--input-type=module', '-e', `
    import { configFirebase, clienteFirestore, lerBancoCompleto } from '${RAIZ}/backup/firestore-rest.mjs';
    import { medirBanco, gravarMonitoramento } from '${RAIZ}/backup/medir-banco.mjs';
    const cli = clienteFirestore(configFirebase('${RAIZ}'));
    const b = await lerBancoCompleto(cli, [], []);
    const m = medirBanco(b.docsPorColecao);
    await gravarMonitoramento(cli, 'banco_' + m.data, m);
    console.log(JSON.stringify({ data: m.data, documentos: m.documentos, bytes: m.bytesDocumentos }));`], { env: envRotina, encoding: 'utf8' });
  let medida = null; try { medida = JSON.parse(medir.stdout.trim().split('\n').pop()); } catch (e) {}
  passo('monitoramento: medição do banco gravada pela conta da rotina (regras aceitam)', medir.status === 0 && !!medida && (await ler(`monitoramento/banco_${medida.data}`))?.documentos === medida.documentos, (medir.stderr || '').slice(-300));
  // GitHub e site simulados (a rotina real consulta a API do GitHub e o site publicado)
  const ghFake = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url.startsWith('/repos/x/y/contents/indice.json')) return res.end(JSON.stringify({ atualizadoEm: '2026-11-09T09:24:27Z', politica: { diarios: 30, mensais: 12, limiteBytes: 1610612736 }, backups: [{ arquivo: 'backup-20261109-0923-automatico.tpbak', partes: ['backup-20261109-0923-automatico.tpbak'], criadoEm: '2026-11-09T09:23:36Z', tipo: 'automatico', tamanho: 41010312, sha256Arquivo: 'abc', totalDocumentos: 1633, imagens: 356, verificacaoOk: true }] }));
    if (req.url.startsWith('/repos/x/y/actions/workflows/backup.yml/runs')) return res.end(JSON.stringify({ workflow_runs: [{ id: 9, created_at: new Date(Date.now() - 3600e3).toISOString(), run_started_at: new Date(Date.now() - 3600e3).toISOString(), updated_at: new Date(Date.now() - 3300e3).toISOString(), status: 'completed', conclusion: 'success', event: 'schedule' }] }));
    if (req.url.startsWith('/repos/x/y/traffic')) { res.statusCode = 403; return res.end('{}'); }
    if (req.url === '/site') { res.setHeader('content-type', 'text/html'); return res.end('<html>ok</html>'); }
    if (req.url.startsWith('/repos/x/y/pages')) return res.end(JSON.stringify({ status: 'built', updated_at: '2026-11-09T10:00:00Z' }));
    if (req.url.startsWith('/repos/x/y/actions/workflows/')) return res.end(JSON.stringify({ workflow_runs: [] }));
    if (req.url === '/repos/x/y') return res.end(JSON.stringify({ size: 300000 }));
    res.statusCode = 404; res.end('{}');
  }).listen(5053);
  const rotinaMon = await new Promise(ok => { const p = spawn('node', [path.join(RAIZ, 'backup/monitoramento.mjs')], { env: { ...envRotina, GITHUB_API: 'http://127.0.0.1:5053', GITHUB_REPOSITORY: 'x/y', GITHUB_TOKEN: 't', SITE_URL: 'http://127.0.0.1:5053/site', GCP_MONITORAMENTO_CHAVE: '' } }); let out = ''; p.stdout.on('data', d => out += d); p.stderr.on('data', d => out += d); p.on('close', code => ok({ code, out })); });
  ghFake.close();
  const fontesM = await ler('monitoramento/fontes');
  passo('monitoramento: rotina diária grava saúde, backups e fontes (sem a chave oficial: indisponível com motivo)', rotinaMon.code === 0 && fontesM?.firestoreOficial?.disponivel === false && /GCP_MONITORAMENTO_CHAVE/.test(fontesM.firestoreOficial.motivo), rotinaMon.out.slice(-300));
  passo('monitoramento: registro da rotina sem dados nem segredos', !/Fábio|backup-.+@|chave-|senha/i.test(rotinaMon.out.replace('Sem a conta', '')), rotinaMon.out.slice(-200));
  await w.page.locator('.sidebar-item', { hasText: 'Central de Monitoramento' }).first().click();
  await w.page.waitForSelector('.mon-kpis, .mon .av-erro', { timeout: 20000 }).catch(() => {});
  const monT = await w.page.locator('.mon').innerText().catch(() => '');
  passo('monitoramento: Master abre a central com os números gravados (regras valendo)', new RegExp(medida ? medida.documentos.toLocaleString('pt-BR') : 'x').test(monT) && /Indisponível/.test(monT), monT.slice(0, 300) + ' ' + w.erros.join('|'));
  await w.page.locator('.mon-nav .mon-aba', { hasText: 'Backups' }).click(); await esperar(300);
  passo('monitoramento: backups vindos do GitHub', /Concluído e conferido/.test(await w.page.locator('.mon-secao').innerText().catch(() => '')));
  // contadores do app gravados pelo próprio aparelho
  await w.page.evaluate(() => monEnviar()); await esperar(1500);
  const usoDocs = await listar('monitoramentoUso');
  passo('monitoramento: contadores do aplicativo gravados (regras aceitam o próprio documento do dia)', usoDocs.length >= 1 && usoDocs.every(u => u.uid && u.dia), JSON.stringify(usoDocs).slice(0, 200));
  passo('monitoramento: sem erros de permissão', w.erros.length === 0, w.erros.join(' | '));
  // funcionário: não vê o item e o banco recusa a leitura
  passo('monitoramento: funcionário não tem o item no menu', await fabio.page.locator('.sidebar-item', { hasText: 'Central de Monitoramento' }).count() === 0);
  const negadoF = await fabio.page.evaluate(async () => { try { await db.collection('monitoramento').doc('fontes').get(); return 'leu'; } catch (e) { return e.code; } });
  passo('monitoramento: banco recusa a leitura para funcionário', negadoF === 'permission-denied', negadoF);
  // Benefícios (VR e VT): Master abre e grava com as regras valendo; funcionário sem o módulo não vê nem lê
  etapa = 'benefícios';
  await w.page.locator('.sidebar-item', { hasText: 'Benefícios' }).first().click();
  await w.page.waitForSelector('.bn-tela', { timeout: 20000 }).catch(() => {});
  passo('benefícios: Master abre a tela (regras valendo)', /Compra do mês/.test(await w.page.locator('.bn-tela').innerText().catch(() => '')));
  const gravouBen = await w.page.evaluate(async () => { try { await db.collection('beneficiosFuncionarios').doc('FUN').set({ recebeVR: true, vrDiario: 30 }, { merge: true }); return 'ok'; } catch (e) { return e.code; } });
  passo('benefícios: Master grava a configuração', gravouBen === 'ok', gravouBen);
  passo('benefícios: sem erros de permissão', w.erros.length === 0, w.erros.join(' | '));
  passo('benefícios: funcionário sem o módulo não tem o item no menu', await fabio.page.locator('.sidebar-item', { hasText: 'Benefícios' }).count() === 0);
  const negadoB = await fabio.page.evaluate(async () => { try { await db.collection('beneficiosFuncionarios').doc('FUN').get(); return 'leu'; } catch (e) { return e.code; } });
  passo('benefícios: banco recusa a leitura para funcionário', negadoB === 'permission-denied', negadoB);
  // 11) Arquivamento automático: a rotina (conta do backup, regras valendo) arquiva só conjuntos inteiros
  etapa = 'arquivamento';
  const diaSP = (d) => new Date(d).toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
  const diasAtras = n => new Date(Date.now() - n * 86400e3);
  await gravar('periodosApuracao/PA-ATUAL', { dataInicial: diaSP(diasAtras(10)), dataFinal: diaSP(diasAtras(-20)), nome: 'Atual' });
  const itensOk = [{ quantidade: 1, qtdConsertada: 1, qtdConsertadaOrcada: 1 }];
  const hist0 = [{ texto: 'criado', data: '2026-01-01T00:00:00Z' }];
  await gravar('lotes/ARQ-A', { numero: 9001, clienteId: 'C1', status: 'Concluído', itens: itensOk, arquivado: false });
  await gravar('orcamentos/ARQ-A1', { numero: 'RP-9001', clienteId: 'C1', loteId: 'ARQ-A', status: 'Concluído', dataFaturamento: diasAtras(40), arquivado: false, historico: hist0, valorTotal: 123.45 });
  await gravar('orcamentos/ARQ-A2', { numero: 'RP-9002', clienteId: 'C1', loteId: 'ARQ-A', status: 'Concluído', dataFaturamento: diasAtras(35), arquivado: false, historico: hist0 });
  await gravar('lotes/ARQ-B', { numero: 9002, clienteId: 'C1', status: 'Concluído', itens: itensOk, arquivado: false });
  await gravar('orcamentos/ARQ-B1', { numero: 'RP-9003', clienteId: 'C1', loteId: 'ARQ-B', status: 'Concluído', dataFaturamento: diasAtras(40), arquivado: false, historico: hist0 });
  await gravar('orcamentos/ARQ-B2', { numero: 'RP-9004', clienteId: 'C1', loteId: 'ARQ-B', status: 'Rota', arquivado: false, historico: hist0 });
  await gravar('lotes/ARQ-C', { numero: 9003, clienteId: 'C1', status: 'Concluído', itens: itensOk, arquivado: false });
  await gravar('orcamentos/ARQ-C1', { numero: 'RP-9005', clienteId: 'C1', loteId: 'ARQ-C', status: 'Concluído', dataFaturamento: diasAtras(40), arquivado: false, historico: hist0 });
  await gravar('orcamentos/ARQ-C2', { numero: 'RP-9006', clienteId: 'C1', loteId: 'ARQ-C', status: 'Concluído', dataFaturamento: diasAtras(2), arquivado: false, historico: hist0 });
  const rodarArq = () => new Promise(ok => { const p = spawn('node', [path.join(RAIZ, 'backup/arquivamento.mjs')], { env: { ...envRotina, TZ: 'America/Sao_Paulo' } }); let out = ''; p.stdout.on('data', d => out += d); p.stderr.on('data', d => out += d); p.on('close', code => ok({ code, out })); });
  const arq1 = await rodarArq();
  const [lA, a1, a2, lB, b1, b2, lC, c1, c2] = await Promise.all(['lotes/ARQ-A', 'orcamentos/ARQ-A1', 'orcamentos/ARQ-A2', 'lotes/ARQ-B', 'orcamentos/ARQ-B1', 'orcamentos/ARQ-B2', 'lotes/ARQ-C', 'orcamentos/ARQ-C1', 'orcamentos/ARQ-C2'].map(ler));
  passo('arquivamento: rotina arquiva a entrada e os 2 orçamentos concluídos fora do período (regras valendo)', arq1.code === 0 && lA.arquivado === true && a1.arquivado === true && a2.arquivado === true && lA.arquivamentoAutomatico === true && /período de apuração/.test(a1.motivoArquivamento || ''), arq1.out.slice(-400));
  passo('arquivamento: nada é apagado nem alterado (status, faturamento, valor e histórico preservados)', a1.status === 'Concluído' && a1.valorTotal === 123.45 && !!a1.dataFaturamento && a1.historico.length === 2 && a1.historico[0].texto === 'criado' && lA.status === 'Concluído' && lA.historicoArquivamento.length === 1 && a1.arquivamentoConjuntoId === 'ARQ-A');
  passo('arquivamento: carimbo de alteração gravado (os aparelhos tiram o cartão da tela)', !!lA.atualizadoEm && !!a1.atualizadoEm && !!a2.atualizadoEm && lA.atualizadoEm >= lA.dataArquivamento);
  passo('arquivamento: entrada com orçamento pendente → nenhum dos três arquivado', lB.arquivado === false && b1.arquivado === false && b2.arquivado === false);
  passo('arquivamento: orçamento dentro do período atual → conjunto inteiro continua ativo', lC.arquivado === false && c1.arquivado === false && c2.arquivado === false);
  passo('arquivamento: registro da rotina sem clientes, números ou contas', !/RP-9|9001|Fábio|backup-.+@|senha/i.test(arq1.out) && /Gravado: [1-9]\d* conjunto/.test(arq1.out), arq1.out.slice(-300));
  // arquivado antes da correção, sem o carimbo de alteração → a rotina carimba (só o carimbo)
  await gravar('orcamentos/ARQ-R', { numero: 'RP-9007', clienteId: 'C1', status: 'Concluído', arquivado: true, arquivadoPor: 'Arquivamento automático', arquivamentoAutomatico: true, dataArquivamento: new Date().toISOString(), historico: hist0 });
  const arq2 = await rodarArq();
  const r2 = await ler('orcamentos/ARQ-R');
  passo('arquivamento: arquivados recentes sem carimbo recebem o carimbo (e nada mais muda)', !!r2.atualizadoEm && r2.arquivado === true && r2.historico.length === 1 && /1 arquivamento\(s\) recente\(s\) avisado/.test(arq2.out), arq2.out.slice(-200));
  passo('arquivamento: rodar de novo não duplica nada', arq2.code === 0 && (await ler('orcamentos/ARQ-A1')).historico.length === 2 && /Gravado: 0 conjunto/.test(arq2.out), arq2.out.slice(-300));
  // reabertura de um orçamento (como a tela faz ao desarquivar) → a entrada volta para a área ativa
  await gravar('orcamentos/ARQ-A2', { ...a2, dataFaturamento: new Date(a2.dataFaturamento), arquivado: false, arquivamentoReabertoEm: diaSP(new Date()) });
  const arq3 = await rodarArq();
  const [lA3, a13, a23] = await Promise.all(['lotes/ARQ-A', 'orcamentos/ARQ-A1', 'orcamentos/ARQ-A2'].map(ler));
  passo('arquivamento: orçamento reaberto → a entrada é reativada e o orçamento não é rearquivado', arq3.code === 0 && lA3.arquivado === false && lA3.historicoArquivamento.length === 2 && /RP-9002/.test(lA3.reativadoMotivo || '') && a23.arquivado === false && a13.arquivado === true, arq3.out.slice(-300));
  const resumoArq = await ler('monitoramento/arquivamento');
  passo('arquivamento: resumo da última execução gravado (só contagens)', !!resumoArq && typeof resumoArq.avaliados === 'number' && resumoArq.reativadas === 1);
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
