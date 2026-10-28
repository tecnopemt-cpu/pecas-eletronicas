// Recuperação do Controle de Peças a partir de um backup (.tpbak) — funciona mesmo com o site fora do ar.
// Precisa de Node 20+ e do arquivo da chave de backup (+ senha).
//
//   node backup/restaurar.mjs BACKUP.tpbak --chave chave-backup.json
//        → abre o backup, confere a integridade e mostra o relatório (não grava nada)
//   node backup/restaurar.mjs BACKUP.tpbak --chave chave-backup.json --extrair pasta
//        → extrai o código do site (pasta/site) e os dados legíveis (pasta/dados/*.json)
//   node backup/restaurar.mjs BACKUP.tpbak --chave chave-backup.json --aplicar
//        → faz um backup do estado atual e depois restaura o banco (pede para digitar RESTAURAR)
//
// Opções: --senha S (ou variável TPBACKUP_SENHA) · --projeto ID --api-key K (restaurar em outro projeto
// Firebase) · --sim (não pergunta) · BACKUP pode ser .parte01 (junta as partes) ou um link https.
// Com o banco fechado, --aplicar pede o login e a senha de um Administrador Master (--login L).
// Projeto novo (banco vazio, regras abertas no início): --sem-login e, depois de restaurar,
// --novo-acesso LOGIN cria a conta de acesso desse funcionário (pede a senha nova).
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { configFirebase, clienteFirestore, lerBancoCompleto, credenciaisDoLogin, senhaAcessoSistema } from './firestore-rest.mjs';

const require = createRequire(import.meta.url);
const T = require('./nucleo.js');
const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = n => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : undefined; };
const flag = n => args.includes('--' + n);
const pergunta = q => new Promise(res => { const rl = readline.createInterface({ input: process.stdin, output: process.stdout }); rl.question(q, r => { rl.close(); res(r); }); });

async function lerArquivoBackup(alvo) {
  if (/^https?:\/\//.test(alvo)) {
    const r = await fetch(alvo);
    if (!r.ok) throw new Error(`Não consegui baixar ${alvo} (${r.status}).`);
    return new Uint8Array(await r.arrayBuffer());
  }
  const m = /^(.*)\.parte\d+$/.exec(alvo);
  if (m) {
    const dir = path.dirname(alvo), base = path.basename(m[1]);
    const partes = fs.readdirSync(dir).filter(f => f.startsWith(base + '.parte')).sort();
    return T.juntar(partes.map(p => new Uint8Array(fs.readFileSync(path.join(dir, p)))));
  }
  return new Uint8Array(fs.readFileSync(alvo));
}
function imprimirRelatorio(cab, v) {
  console.log(`\nBackup de ${new Date(cab.criadoEm).toLocaleString('pt-BR')} (${cab.tipo}, ${cab.origem})`);
  console.log(`Documentos: ${v.resumo.totalDocumentos} · imagens: ${v.resumo.imagens} (${v.resumo.assinaturas} assinaturas) · arquivos do site: ${v.resumo.arquivosCodigo}`);
  Object.entries(v.resumo.colecoes).forEach(([c, n]) => console.log(`  ${c.padEnd(22)} ${n}`));
  console.log('Vínculos entre os dados:');
  v.vinculos.forEach(x => console.log(`  ${x.quebrados ? '⚠️ ' : '✔ '} ${x.nome}: ${x.total - x.quebrados}/${x.total} ok${x.quebrados ? ` (${x.exemplos.join('; ')})` : ''}`));
  v.avisos.forEach(a => console.log('  ⚠️  ' + a));
  v.erros.forEach(e => console.log('  ⛔ ' + e));
  console.log(v.ok ? 'Integridade: OK' : 'Integridade: COM ERROS');
}

async function principal() {
  const comValor = ['chave', 'senha', 'extrair', 'projeto', 'api-key', 'login', 'novo-acesso'];
  const alvo = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && comValor.includes(args[i - 1].slice(2))))[0];
  if (!alvo || !opt('chave')) {
    console.log('Uso: node backup/restaurar.mjs BACKUP.tpbak --chave chave-backup.json [--extrair pasta] [--aplicar]');
    process.exit(1);
  }
  const bytes = await lerArquivoBackup(alvo);
  const { cab } = T.lerCabecalho(bytes);
  const arquivoChave = JSON.parse(fs.readFileSync(opt('chave'), 'utf8'));
  const senha = opt('senha') || process.env.TPBACKUP_SENHA || await pergunta('Senha da chave de backup: ');
  const chave = await T.abrirChavePrivada(arquivoChave, senha);
  const { plano } = await T.abrir(bytes, chave);
  const v = T.verificarPlano(plano);
  imprimirRelatorio(cab, v);

  if (opt('extrair')) {
    const destino = path.resolve(opt('extrair'));
    const arquivos = (plano.codigo && plano.codigo.arquivos) || {};
    Object.entries(arquivos).forEach(([nome, b64]) => { const p = path.join(destino, 'site', nome); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, Buffer.from(b64, 'base64')); });
    const ad = { criarTimestamp: s => s };
    Object.entries(plano.documentos).forEach(([c, docs]) => {
      const p = path.join(destino, 'dados', c + '.json');
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const legivel = {};
      Object.entries(docs).forEach(([id, f]) => { legivel[id] = T.camposParaObjeto(f, ad); });
      fs.writeFileSync(p, JSON.stringify(legivel, null, 2));
    });
    fs.writeFileSync(path.join(destino, 'backup-original.json'), JSON.stringify(plano));
    console.log(`\nExtraído em ${destino}: site/ (${Object.keys(arquivos).length} arquivos — publique esta pasta para o sistema voltar ao ar) e dados/ (${Object.keys(plano.documentos).length} coleções).`);
  }

  if (flag('aplicar')) {
    if (!v.ok) throw new Error('O backup tem erros de integridade; restauração cancelada.');
    const cfg = configFirebase(RAIZ);
    if (opt('projeto')) cfg.projeto = opt('projeto');
    if (opt('api-key')) cfg.apiKey = opt('api-key');
    let credenciais = null;
    if (!flag('sem-login')) {
      const login = opt('login') || process.env.TPBACKUP_LOGIN || await pergunta('Login de um Administrador Master: ');
      const senhaLogin = process.env.TPBACKUP_SENHA_LOGIN || await pergunta('Senha desse login: ');
      credenciais = await credenciaisDoLogin(cfg, login, senhaLogin);
    }
    const fsCli = clienteFirestore({ ...cfg, credenciais });
    console.log(`\nLendo o banco atual do projeto ${cfg.projeto}...`);
    const atual = await lerBancoCompleto(fsCli, T.COLECOES, T.COLECOES_DO_BACKUP);
    // 1) backup do estado atual ANTES de restaurar
    const planoAtual = T.montarPlano({ docsPorColecao: atual.docsPorColecao, tipo: 'pre-restauracao', origem: 'computador', projeto: cfg.projeto, colecoesNaoEncontradas: atual.vazias, codigo: plano.codigo });
    const bytesAtual = await T.empacotar(planoAtual, chave.chavePublica, { criadoEm: planoAtual.criadoEm, tipo: 'pre-restauracao', origem: 'computador', projeto: cfg.projeto, resumo: { totalDocumentos: T.resumoDoPlano(planoAtual).totalDocumentos } });
    const nomePre = `backup-${planoAtual.criadoEm.replace(/[-:]/g, '').replace('T', '-').slice(0, 13)}-pre-restauracao.tpbak`;
    fs.writeFileSync(nomePre, bytesAtual);
    console.log(`Backup do estado atual salvo em ${path.resolve(nomePre)} (${T.formatarBytes(bytesAtual.length)}).`);
    // 2) o que vai mudar
    const dif = T.compararComAtual(plano, atual.docsPorColecao);
    console.log('\nO que a restauração vai fazer:');
    Object.entries(dif).forEach(([c, d]) => { if (d.criar || d.alterar || d.apagar) console.log(`  ${c.padEnd(22)} +${d.criar} criar · ~${d.alterar} alterar · -${d.apagar} apagar`); });
    if (!flag('sim')) {
      const r = await pergunta('\nDigite RESTAURAR para confirmar: ');
      if (r.trim() !== 'RESTAURAR') { console.log('Cancelado. Nada foi alterado.'); return; }
    }
    // 3) grava: apaga o que não existe no backup e grava cada documento do backup exatamente como era
    const escritas = [];
    const cols = new Set([...Object.keys(plano.documentos), ...Object.keys(atual.docsPorColecao)]);
    // Contas de acesso não voltam no tempo: se o banco atual já tem os índices de login e a configuração
    // de segurança, eles ficam como estão, e cada ficha mantém a conta de acesso atual (senão quem
    // trocou a senha depois do backup — e quem está restaurando — perderia o acesso).
    const manterAcesso = (atual.docsPorColecao.loginsPublicos && Object.keys(atual.docsPorColecao.loginsPublicos).length) ? ['loginsPublicos', 'contas', 'seguranca'] : [];
    const CAMPOS_ACESSO = ['authEmail', 'authUid', 'acessoCriadoEm'];
    const fichaAtual = atual.docsPorColecao.funcionarios || {};
    if (plano.documentos.funcionarios) Object.keys(plano.documentos.funcionarios).forEach(id => {
      const f = { ...plano.documentos.funcionarios[id] };
      CAMPOS_ACESSO.forEach(k => { if (fichaAtual[id] && fichaAtual[id][k]) f[k] = fichaAtual[id][k]; });
      if (fichaAtual[id] && !fichaAtual[id].senhaHash) delete f.senhaHash;
      plano.documentos.funcionarios[id] = f;
    });
    cols.forEach(c => {
      if (T.COLECOES_DO_BACKUP.includes(c) || manterAcesso.includes(c)) return;
      const preserv = T.DOCS_PRESERVADOS[c] || [];
      const b = plano.documentos[c] || {}, a = atual.docsPorColecao[c] || {};
      Object.keys(a).forEach(id => { if (!preserv.includes(id) && !b[id]) escritas.push(fsCli.escritaApagar(c, id)); });
      Object.keys(b).forEach(id => { if (!preserv.includes(id)) escritas.push(fsCli.escritaSet(c, id, b[id])); });
    });
    // As avaliações de desempenho não podem ser apagadas nem reescritas pelo site; durante a restauração
    // o Master ganha essa liberação por 2 horas (seguranca/restauracao), retirada logo ao terminar.
    const comLogin = !!credenciais;
    if (comLogin) await fsCli.gravarDocumento('seguranca', 'restauracao', { ate: { timestampValue: new Date(Date.now() + 2 * 36e5).toISOString() }, motivo: { stringValue: 'restauração de backup' } });
    try {
      await fsCli.gravar(escritas, (f, t) => process.stdout.write(`\rGravando ${f}/${t}...`));
    } finally {
      if (comLogin) await fsCli.gravar([fsCli.escritaApagar('seguranca', 'restauracao')]).catch(e => console.log(`\nAtenção: apague seguranca/restauracao no console (${e.message}).`));
    }
    console.log('');
    // os aparelhos guardam uma cópia dos dados: troca a "geração" para todos relerem o banco restaurado
    await fsCli.gravarDocumento('config', 'cache', { geracao: { integerValue: String(Date.now()) }, motivo: { stringValue: 'restauração de backup' } });
    // 4) conferência final
    const depois = await lerBancoCompleto(fsCli, T.COLECOES, T.COLECOES_DO_BACKUP);
    manterAcesso.forEach(c => { delete plano.documentos[c]; delete depois.docsPorColecao[c]; });
    const conf = T.conferirRestauracao(plano, depois.docsPorColecao);
    console.log(conf.ok ? '✔ Restauração conferida: o banco ficou idêntico ao backup.' : `⛔ Diferenças após restaurar: ${conf.diferencas.slice(0, 10).join(', ')}`);
    // (o registro da restauração fica neste terminal e no arquivo pré-restauração — nada é gravado no sistema)
    if (!conf.ok) process.exitCode = 2;
  }

  // Projeto novo: cria a conta de acesso de um funcionário (as contas do Firebase não ficam no backup).
  if (opt('novo-acesso')) {
    const cfg = configFirebase(RAIZ);
    if (opt('projeto')) cfg.projeto = opt('projeto');
    if (opt('api-key')) cfg.apiKey = opt('api-key');
    const login = opt('novo-acesso');
    const fsCli = clienteFirestore(cfg);
    const funcs = await fsCli.listarDocumentos('funcionarios');
    const [fid, ficha] = Object.entries(funcs).find(([, f]) => String(f.login?.stringValue || '').trim().toLowerCase() === login.trim().toLowerCase()) || [];
    if (!fid) throw new Error(`Funcionário com login "${login}" não encontrado.`);
    const senhaNova = await pergunta(`Senha nova para ${ficha.nome?.stringValue || login} (mínimo 6): `);
    if (senhaNova.length < 6) throw new Error('Senha curta demais.');
    const AUTH = process.env.AUTH_BASE || 'https://identitytoolkit.googleapis.com/v1';
    let email = '', r = null;
    for (let v = 1; v < 20; v++) {
      email = `f-${fid}-v${v}@acesso.controle-pecas.app`.toLowerCase();
      r = await fetch(`${AUTH}/accounts:signUp?key=${encodeURIComponent(cfg.apiKey)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: senhaAcessoSistema(senhaNova), returnSecureToken: true }) });
      if (r.ok) break;
      const j = await r.json().catch(() => ({}));
      if (!String(j.error && j.error.message).includes('EMAIL_EXISTS')) throw new Error('Não consegui criar a conta: ' + JSON.stringify(j));
    }
    const conta = await r.json();
    const chaveLogin = encodeURIComponent(login.trim().toLowerCase());
    await fsCli.gravar([
      { update: { name: fsCli.nomeDoc('funcionarios', fid), fields: { authEmail: { stringValue: email }, authUid: { stringValue: conta.localId } } }, updateMask: { fieldPaths: ['authEmail', 'authUid'] } },
      fsCli.escritaSet('loginsPublicos', chaveLogin, { email: { stringValue: email } }),
      fsCli.escritaSet('contas', conta.localId, { funcionarioId: { stringValue: fid }, email: { stringValue: email } })
    ]);
    console.log(`✔ Acesso criado: ${login} já pode entrar no sistema com a senha nova. Os demais: Equipe → ficha → Redefinir senha.`);
  }
}
principal().catch(e => { console.error('⛔ ' + e.message); process.exit(1); });
