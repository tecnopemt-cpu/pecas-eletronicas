// Registra o resultado do backup automático no histórico do sistema (coleção "backups"),
// para aparecer em Configurações → Backup e Segurança.
//   node backup/registrar.mjs <pasta-saida> <publicado: true|false>
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { configFirebase, clienteFirestore } from './firestore-rest.mjs';
const require = createRequire(import.meta.url);
const T = require('./nucleo.js');
const [saida, publicado] = process.argv.slice(2);
const metaArq = path.join(saida, 'meta.json');
const meta = fs.existsSync(metaArq) ? JSON.parse(fs.readFileSync(metaArq, 'utf8')) : { status: 'erro', mensagem: 'A rotina de backup não chegou a gerar o arquivo.', tipo: 'automatico', origem: 'github-actions' };
if (meta.modo === 'teste') { console.log('Modo teste: nada é registrado no histórico.'); process.exit(0); }
const repo = process.env.GITHUB_REPOSITORY || 'tecnopemt-cpu/pecas-eletronicas';
const ok = meta.status === 'sucesso' && publicado === 'true';
const doc = {
  tipo: meta.tipo || 'automatico', origem: meta.origem || 'github-actions',
  criadoEm: new Date(meta.criadoEm || meta.inicio || Date.now()),
  status: ok ? 'sucesso' : 'erro',
  mensagem: ok ? 'Backup automático salvo no GitHub (ramo backups).' : (meta.status === 'sucesso' ? 'Backup gerado, mas não foi possível enviar ao GitHub.' : meta.mensagem || 'Erro no backup.'),
  tamanho: meta.tamanho || 0, tamanhoDados: meta.tamanhoDados || 0, chaveId: meta.chaveId || '', sha256Arquivo: meta.sha256Arquivo || '',
  arquivo: meta.arquivo || '', partes: meta.partes || [],
  local: ok ? { tipo: 'github', repositorio: repo, ramo: 'backups', urlBase: `https://raw.githubusercontent.com/${repo}/backups/`, pagina: `https://github.com/${repo}/tree/backups` } : null,
  resumo: meta.resumo || null, verificacao: meta.verificacao ? { ok: meta.verificacao.ok, avisos: meta.verificacao.avisos, erros: meta.verificacao.erros, vinculos: meta.verificacao.vinculos } : null,
  teste: meta.teste || null, commitCodigo: meta.commitCodigo || '', runUrl: meta.runUrl || '', duracaoSegundos: meta.duracaoSegundos || 0, observacoes: meta.observacoes || []
};
const id = 'auto-' + (meta.criadoEm || new Date().toISOString()).replace(/[^0-9]/g, '').slice(0, 14);
const cli = clienteFirestore(configFirebase());
await cli.gravarDocumento('backups', id, T.objetoParaCampos(doc));
// marca os backups que saíram do GitHub pela política de retenção
const ret = path.join(saida, 'retencao.json');
if (fs.existsSync(ret)) {
  const { removidos } = JSON.parse(fs.readFileSync(ret, 'utf8'));
  const lista = await cli.listarDocumentos('backups');
  const escritas = [];
  Object.entries(lista).forEach(([bid, f]) => {
    const o = T.camposParaObjeto(f);
    if (o.arquivo && (o.partes || [o.arquivo]).some(p => removidos.includes(p)) && !o.removidoDoGitHub) escritas.push(cli.escritaSet('backups', bid, T.objetoParaCampos({ ...T.camposParaObjeto(f, { criarTimestamp: s => new Date(s) }), removidoDoGitHub: true, local: null })));
  });
  if (escritas.length) await cli.gravar(escritas);
}
console.log(`Histórico atualizado: ${id} (${doc.status}).`);
if (!ok) process.exitCode = 1;
