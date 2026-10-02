// Rotina de backup (GitHub Actions todo dia, ou manualmente num computador com Node 20+).
//   node backup/gerar-backup.mjs --saida pasta            backup completo, cifrado com a chave pública
//                                                          cadastrada no sistema (config/backup)
//   node backup/gerar-backup.mjs --modo teste              teste de ponta a ponta com uma chave temporária:
//                                                          lê o banco real, cifra, abre de novo, confere tudo
//                                                          e simula a restauração — sem gravar nada
// Opções: --chave-publica arquivo.json (usa o arquivo da chave em vez de config/backup)
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { configFirebase, clienteFirestore, lerBancoCompleto } from './firestore-rest.mjs';

const require = createRequire(import.meta.url);
const T = require('./nucleo.js');
const AQUI = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.join(AQUI, '..');
const LIMITE_PARTE = 90 * 1024 * 1024; // arquivos acima disso são divididos (limite do GitHub: 100 MB por arquivo)

const args = process.argv.slice(2);
const opt = (n, padrao) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : padrao; };
const modo = opt('modo', 'completo');
const saida = path.resolve(opt('saida', path.join(RAIZ, 'saida-backup')));
const tipo = opt('tipo', 'automatico');
const noGithub = !!process.env.GITHUB_ACTIONS;
const aviso = (nivel, msg) => { if (noGithub) console.log(`::${nivel}::${msg.replace(/\n/g, '%0A')}`); else console.log(`[${nivel}] ${msg}`); };
const saidaGithub = (k, v) => { if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`); };

// Código do site (tudo que está versionado), para poder reconstruir o sistema do zero.
function lerCodigo() {
  let arquivos = [];
  try { arquivos = execSync('git ls-files', { cwd: RAIZ, encoding: 'utf8' }).split('\n').filter(Boolean); } catch (e) { arquivos = ['index.html', 'manifest.json']; }
  const out = {};
  for (const a of arquivos) {
    const p = path.join(RAIZ, a);
    if (!fs.existsSync(p) || fs.statSync(p).size > 20 * 1024 * 1024) continue;
    out[a] = fs.readFileSync(p).toString('base64');
  }
  let commit = process.env.GITHUB_SHA || '';
  if (!commit) { try { commit = execSync('git rev-parse HEAD', { cwd: RAIZ, encoding: 'utf8' }).trim(); } catch (e) {} }
  return { commit, repositorio: process.env.GITHUB_REPOSITORY || 'tecnopemt-cpu/pecas-eletronicas', arquivos: out };
}

async function principal() {
  const inicio = Date.now();
  const cfg = configFirebase(RAIZ);
  const fsCli = clienteFirestore(cfg);
  fs.mkdirSync(saida, { recursive: true });
  const meta = { tipo, origem: noGithub ? 'github-actions' : 'computador', modo, inicio: new Date(inicio).toISOString(), status: 'erro', projeto: cfg.projeto, runUrl: process.env.GITHUB_SERVER_URL ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : '' };
  const gravarMeta = () => fs.writeFileSync(path.join(saida, 'meta.json'), JSON.stringify(meta, null, 2));
  try {
    // 1) chave pública
    let chavePublica, chaveTemp = null;
    if (modo === 'teste') {
      const senha = 'senha-temporaria-do-teste-' + Math.random().toString(36).slice(2);
      chaveTemp = await T.gerarChaves(senha, { observacao: 'chave temporária do teste automático' });
      chaveTemp.senha = senha;
      chavePublica = chaveTemp.chavePublica;
    } else if (opt('chave-publica')) {
      const arq = JSON.parse(fs.readFileSync(opt('chave-publica'), 'utf8'));
      chavePublica = arq.chavePublica || arq;
    } else {
      const c = await fsCli.obterDocumento('config', 'backup');
      const obj = c ? T.camposParaObjeto(c) : null;
      if (!obj || !obj.chavePublica || !obj.chavePublica.n) {
        meta.mensagem = 'Chave de backup não configurada. Gere a chave em Configurações → Backup e Segurança.';
        throw new Error(meta.mensagem);
      }
      chavePublica = obj.chavePublica;
    }
    // 2) banco completo
    const banco = await lerBancoCompleto(fsCli, T.COLECOES, T.COLECOES_DO_BACKUP, (c, i, n, qtd) => console.log(`  ${i}/${n} ${c}: ${qtd} documento(s)`));
    const codigo = lerCodigo();
    const observacoes = [];
    // o núcleo embutido no site precisa ser o mesmo desta rotina (senão o site não abriria os backups)
    try {
      const html = fs.readFileSync(path.join(RAIZ, 'index.html'), 'utf8');
      const embutido = /<script id="tpbackup-nucleo">\n([\s\S]*?)\n<\/script>/.exec(html)?.[1]?.trim();
      const arquivo = fs.readFileSync(path.join(AQUI, 'nucleo.js'), 'utf8').trim();
      if (embutido !== arquivo) observacoes.push('ATENÇÃO: o núcleo de backup dentro do index.html é diferente de backup/nucleo.js.');
    } catch (e) {}
    if (!banco.listaDoBanco) observacoes.push('A lista de coleções do Firestore não está disponível com a chave pública; foram copiadas as coleções conhecidas do sistema.');
    if (banco.extras.length) observacoes.push(`Coleções extras encontradas e incluídas: ${banco.extras.join(', ')}.`);
    const plano = T.montarPlano({ docsPorColecao: banco.docsPorColecao, tipo, origem: meta.origem, projeto: cfg.projeto, codigo, colecoesNaoEncontradas: banco.vazias, observacoes });
    const verificacao = T.verificarPlano(plano);
    const resumo = T.resumoDoPlano(plano);
    // 3) cifrar
    const bytes = await T.empacotar(plano, chavePublica, { criadoEm: plano.criadoEm, tipo, origem: meta.origem, projeto: cfg.projeto, commitCodigo: codigo.commit, resumo: { totalDocumentos: resumo.totalDocumentos, colecoes: Object.keys(resumo.colecoes).length, imagens: resumo.imagens } });
    Object.assign(meta, { criadoEm: plano.criadoEm, tamanho: bytes.length, tamanhoDados: T.lerCabecalho(bytes).cab.tamanhoDados, chaveId: T.lerCabecalho(bytes).cab.chaveId, sha256Arquivo: await T.sha256Hex(bytes), resumo, commitCodigo: codigo.commit, verificacao: { ok: verificacao.ok, erros: verificacao.erros, avisos: verificacao.avisos, vinculos: verificacao.vinculos }, observacoes, vazias: banco.vazias });
    console.log(`Backup: ${resumo.totalDocumentos} documentos em ${Object.keys(resumo.colecoes).length} coleções, ${resumo.imagens} imagens, ${resumo.arquivosCodigo} arquivos de código, ${T.formatarBytes(bytes.length)} cifrado.`);
    // 4) teste de recuperação
    const conferencia = await testarRecuperacao(bytes, plano, chaveTemp);
    meta.teste = conferencia;
    if (!conferencia.ok) throw new Error('Teste de recuperação falhou: ' + conferencia.erros.join('; '));
    // 5) arquivo final
    if (modo !== 'teste') {
      const carimbo = plano.criadoEm.replace(/[-:]/g, '').replace('T', '-').slice(0, 13);
      const nome = `backup-${carimbo}-${tipo}.tpbak`;
      const partes = [];
      if (bytes.length <= LIMITE_PARTE) { fs.writeFileSync(path.join(saida, nome), bytes); partes.push(nome); }
      else for (let i = 0, n = 1; i < bytes.length; i += LIMITE_PARTE, n++) { const p = `${nome}.parte${String(n).padStart(2, '0')}`; fs.writeFileSync(path.join(saida, p), bytes.subarray(i, i + LIMITE_PARTE)); partes.push(p); }
      Object.assign(meta, { arquivo: nome, partes });
      saidaGithub('publicar', 'true');
      saidaGithub('arquivo', nome);
    }
    meta.status = 'sucesso';
    meta.duracaoSegundos = Math.round((Date.now() - inicio) / 1000);
    gravarMeta();
    aviso('notice', `${modo === 'teste' ? 'TESTE DE RECUPERAÇÃO APROVADO' : 'Backup criado'}: ${resumo.totalDocumentos} documentos, ${resumo.imagens} imagens, ${resumo.arquivosCodigo} arquivos do site, ${T.formatarBytes(bytes.length)}. Abertura com a chave: OK. Conferência documento a documento: OK (${conferencia.documentosConferidos}). Vínculos verificados: ${verificacao.vinculos.length}.`);
    verificacao.vinculos.filter(v => v.quebrados).forEach(v => aviso('warning', `Vínculo já quebrado no banco: ${v.nome} — ${v.quebrados} de ${v.total} (o backup copia o banco como está).`));
    verificacao.avisos.forEach(a => aviso('warning', a));
    observacoes.forEach(o => aviso('notice', o));
  } catch (e) {
    meta.status = 'erro';
    meta.mensagem = meta.mensagem || e.message;
    meta.duracaoSegundos = Math.round((Date.now() - inicio) / 1000);
    gravarMeta();
    saidaGithub('publicar', 'false');
    aviso('error', `Backup falhou: ${meta.mensagem}`);
    process.exitCode = 1;
  }
}

// Abre o backup recém-criado e simula a restauração. Com a chave temporária (modo teste) a abertura é
// real; no backup oficial (chave privada só com o administrador) confere a estrutura cifrada e a
// conversão de cada documento para o formato que a restauração grava.
async function testarRecuperacao(bytes, plano, chaveTemp) {
  const erros = [];
  let documentosConferidos = 0;
  let aberto = plano;
  const { cab } = T.lerCabecalho(bytes);
  if (cab.sha256Dados !== await T.sha256Hex(new TextEncoder().encode(JSON.stringify(plano)))) erros.push('código de verificação divergente');
  if (chaveTemp) {
    const priv = await T.abrirChavePrivada(chaveTemp.arquivoChave, chaveTemp.senha);
    aberto = (await T.abrir(bytes, priv)).plano;
  }
  // restauração simulada: documento → objeto (como o sistema grava) → documento, e comparação exata
  const comoSistema = { criarTimestamp: s => new Date(s), criarGeo: g => ({ __geo: g }), ehGeo: v => v && v.__geo, criarBytes: b => ({ __b: b, toBase64: () => b }), ehBytes: v => v && v.__b !== undefined };
  const restaurado = {};
  Object.keys(aberto.documentos).forEach(c => {
    restaurado[c] = {};
    Object.keys(aberto.documentos[c]).forEach(id => { restaurado[c][id] = T.objetoParaCampos(T.camposParaObjeto(aberto.documentos[c][id], comoSistema), comoSistema); documentosConferidos++; });
  });
  const conf = T.conferirRestauracao(plano, restaurado);
  if (!conf.ok) erros.push(`${conf.diferencas.length} documento(s) não voltariam iguais (ex.: ${conf.diferencas.slice(0, 3).join(', ')})`);
  const v = T.verificarPlano(aberto);
  if (!v.ok) erros.push(...v.erros);
  return { ok: erros.length === 0, erros, documentosConferidos, aberturaReal: !!chaveTemp };
}

principal();
