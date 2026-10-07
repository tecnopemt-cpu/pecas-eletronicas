// Tira as fotos e assinaturas de dentro dos registros e guarda cada imagem num documento próprio da
// coleção "midias" (id = img_ + SHA-256 do conteúdo). O registro passa a guardar só a referência
// "midia:img_...". Nenhuma imagem é apagada: o conteúdo é copiado, conferido e só então substituído
// pela referência. Assim as listas (peças, entradas, orçamentos) carregam só o texto, e cada foto
// é baixada quando aparece na tela.
//   node backup/mover-midias.mjs --verificar   → mostra o que seria movido e testa o acesso (não grava)
//   node backup/mover-midias.mjs --executar    → move, conferindo cada registro
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { configFirebase, clienteFirestore } from './firestore-rest.mjs';
const require = createRequire(import.meta.url);
const T = require('./nucleo.js');
const executar = process.argv.includes('--executar');
const gh = !!process.env.GITHUB_ACTIONS;
const nota = (nivel, m) => console.log(gh ? `::${nivel}::${m}` : `[${nivel}] ${m}`);
const cli = clienteFirestore(configFirebase());
const MINIMO = 2000; // mesmo limite do site
const COL_MIDIA = 'midias';
const PREFIXO = T.PREFIXO_MIDIA;
const idMidia = s => 'img_' + crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const ehImagem = s => typeof s === 'string' && s.length >= MINIMO && s.startsWith('data:');
const mb = n => (n / 1e6).toFixed(2) + ' MB';

// Troca, no formato tipado do Firestore, cada imagem grande pela referência; junta as imagens achadas.
function trocar(t, achadas) {
  if (!t || typeof t !== 'object') return t;
  if ('stringValue' in t) {
    if (ehImagem(t.stringValue)) { const id = idMidia(t.stringValue); achadas.set(id, t.stringValue); return { stringValue: PREFIXO + id }; }
    return t;
  }
  if (t.arrayValue) return { arrayValue: { ...t.arrayValue, values: (t.arrayValue.values || []).map(x => trocar(x, achadas)) } };
  if (t.mapValue) return { mapValue: { ...t.mapValue, fields: Object.fromEntries(Object.entries(t.mapValue.fields || {}).map(([k, v]) => [k, trocar(v, achadas)])) } };
  return t;
}
// Volta as referências para as imagens (para conferir que nada se perdeu).
function desfazer(t, midias) {
  if (!t || typeof t !== 'object') return t;
  if ('stringValue' in t) {
    if (typeof t.stringValue === 'string' && t.stringValue.startsWith(PREFIXO)) { const d = midias.get(t.stringValue.slice(PREFIXO.length)); return d === undefined ? { stringValue: '<<FALTANDO ' + t.stringValue + '>>' } : { stringValue: d }; }
    return t;
  }
  if (t.arrayValue) return { arrayValue: { ...t.arrayValue, values: (t.arrayValue.values || []).map(x => desfazer(x, midias)) } };
  if (t.mapValue) return { mapValue: { ...t.mapValue, fields: Object.fromEntries(Object.entries(t.mapValue.fields || {}).map(([k, v]) => [k, desfazer(v, midias)])) } };
  return t;
}
const igual = (a, b) => T.jsonEstavel(a) === T.jsonEstavel(b);

// 1) Acesso à coleção nova (sem gravar nada): leitura de um documento inexistente e uma gravação
//    com pré-condição impossível — se as regras do Firebase bloqueassem "midias", daria "permissão negada".
async function testarAcesso() {
  const r = { leitura: '?', escrita: '?' };
  try { await cli.obterComVersao(COL_MIDIA, '__teste_acesso__'); r.leitura = 'liberada'; } catch (e) { r.leitura = e.status === 403 ? 'BLOQUEADA' : 'erro ' + e.message; }
  try {
    await cli.commit([{ update: { name: cli.nomeDoc(COL_MIDIA, '__teste_acesso__'), fields: { x: { stringValue: 'nunca gravado' } } }, currentDocument: { exists: true } }]);
    r.escrita = 'INESPERADO: gravou';
  } catch (e) { r.escrita = e.status === 403 ? 'BLOQUEADA' : (e.status === 404 || e.status === 400 || e.status === 409 || /NOT_FOUND|precondition|No document/i.test(e.message)) ? 'liberada' : 'erro ' + e.message; }
  return r;
}

const COLECOES = T.COLECOES.filter(c => c !== COL_MIDIA);
const plano = [];
let totalImagens = 0, bytesImagens = 0, bytesAntes = 0, bytesDepois = 0;
const porColecao = {};
for (const c of COLECOES) {
  const docs = await cli.listarComVersao(c);
  for (const [id, d] of Object.entries(docs)) {
    const achadas = new Map();
    const novo = trocar({ mapValue: { fields: d.fields } }, achadas).mapValue.fields;
    const antes = JSON.stringify(d.fields).length;
    bytesAntes += antes;
    if (!achadas.size) { bytesDepois += antes; continue; }
    const depois = JSON.stringify(novo).length;
    bytesDepois += depois;
    const campos = Object.keys(d.fields).filter(k => !igual(d.fields[k], novo[k]));
    plano.push({ c, id, updateTime: d.updateTime, original: d.fields, novo, campos, achadas });
    totalImagens += achadas.size;
    achadas.forEach(v => { bytesImagens += v.length; });
    const pc = porColecao[c] = porColecao[c] || { registros: 0, imagens: 0, antes: 0, depois: 0 };
    pc.registros++; pc.imagens += achadas.size; pc.antes += antes; pc.depois += depois;
  }
}
const acesso = await testarAcesso();
nota('notice', `Acesso à coleção "${COL_MIDIA}": leitura ${acesso.leitura} · escrita ${acesso.escrita}`);
nota('notice', `A MOVER → ${plano.length} registro(s) com ${totalImagens} imagem(ns) (${mb(bytesImagens)}). ` + Object.entries(porColecao).map(([c, p]) => `${c}: ${p.registros} registro(s), ${p.imagens} imagem(ns), ${mb(p.antes)} → ${mb(p.depois)}`).join(' · '));
nota('notice', `Banco (todas as coleções do sistema) que as telas baixam: ${mb(bytesAntes)} hoje → ${mb(bytesDepois)} depois (as imagens passam a ser baixadas só quando aparecem).`);
if (acesso.leitura !== 'liberada' || acesso.escrita !== 'liberada') { nota('error', 'As regras do Firebase não liberam a coleção "midias". Nada foi feito.'); process.exit(1); }
if (!executar) { nota('notice', 'Modo verificação: nada foi gravado.'); process.exit(0); }

// 2) Grava as imagens (cópia) e confere cada uma relendo do banco.
const todas = new Map();
plano.forEach(p => p.achadas.forEach((v, k) => { if (!todas.has(k)) todas.set(k, { dados: v, usos: new Set() }); todas.get(k).usos.add(`${p.c}/${p.id}`); }));
const existentes = await cli.listarComVersao(COL_MIDIA);
const gravar = [];
for (const [id, m] of todas) {
  const atual = existentes[id];
  const usos = new Set([...m.usos, ...((atual?.fields?.usos?.arrayValue?.values) || []).map(v => v.stringValue)]);
  if (atual && atual.fields?.dados?.stringValue === m.dados && usos.size === (atual.fields.usos?.arrayValue?.values || []).length) continue;
  gravar.push(cli.escritaSet(COL_MIDIA, id, {
    dados: { stringValue: m.dados },
    tamanho: { integerValue: String(m.dados.length) },
    usos: { arrayValue: { values: [...usos].map(u => ({ stringValue: u })) } },
    criadoEm: atual?.fields?.criadoEm || { timestampValue: new Date().toISOString() }
  }));
}
await cli.gravar(gravar, (f, t) => console.log(`imagens gravadas ${f}/${t}`));
const conferidas = await cli.listarComVersao(COL_MIDIA);
const imagensOk = new Map();
const faltando = [];
for (const [id, m] of todas) {
  if (conferidas[id]?.fields?.dados?.stringValue === m.dados && idMidia(conferidas[id].fields.dados.stringValue) === id) imagensOk.set(id, m.dados);
  else faltando.push(id);
}
if (faltando.length) { nota('error', `${faltando.length} imagem(ns) não conferiram depois de gravadas. Nenhum registro foi alterado.`); process.exit(1); }
nota('notice', `IMAGENS COPIADAS E CONFERIDAS: ${imagensOk.size} de ${todas.size} (conteúdo idêntico, byte a byte).`);

// 3) Troca a imagem pela referência em cada registro — só se o registro não mudou desde a leitura.
let trocados = 0, alteradosNoMeio = 0;
const problemas = [];
for (let p of plano) {
  for (let tentativa = 1; tentativa <= 3; tentativa++) {
    // conferência prévia: desfazendo as referências, o registro novo é idêntico ao original
    if (!igual(desfazer({ mapValue: { fields: p.novo } }, imagensOk).mapValue.fields, p.original)) { problemas.push(`${p.c}/${p.id}: conferência prévia falhou`); break; }
    try {
      const r = await cli.commit([{ update: { name: cli.nomeDoc(p.c, p.id), fields: Object.fromEntries(p.campos.map(k => [k, p.novo[k]])) }, updateMask: { fieldPaths: p.campos.map(k => /^[A-Za-z_][A-Za-z_0-9]*$/.test(k) ? k : '`' + k.replace(/`/g, '\\`') + '`') }, currentDocument: { updateTime: p.updateTime } }]);
      const v = await cli.obterComVersao(p.c, p.id);
      const ok = v && (v.updateTime !== r.writeResults[0].updateTime || igual(desfazer({ mapValue: { fields: v.fields } }, imagensOk).mapValue.fields, p.original));
      if (!ok) problemas.push(`${p.c}/${p.id}: conferência depois da troca falhou`); else trocados++;
      break;
    } catch (e) {
      // alguém alterou o registro agora há pouco: relê e tenta de novo
      alteradosNoMeio++;
      const v = await cli.obterComVersao(p.c, p.id);
      if (!v) { problemas.push(`${p.c}/${p.id}: registro não existe mais`); break; }
      const achadas = new Map();
      const novo = trocar({ mapValue: { fields: v.fields } }, achadas).mapValue.fields;
      for (const [id, dados] of achadas) if (!imagensOk.has(id)) {
        await cli.gravar([cli.escritaSet(COL_MIDIA, id, { dados: { stringValue: dados }, tamanho: { integerValue: String(dados.length) }, usos: { arrayValue: { values: [{ stringValue: `${p.c}/${p.id}` }] } }, criadoEm: { timestampValue: new Date().toISOString() } })]);
        const c = await cli.obterComVersao(COL_MIDIA, id);
        if (c?.fields?.dados?.stringValue === dados) imagensOk.set(id, dados); else { problemas.push(`${p.c}/${p.id}: imagem nova não conferiu`); }
      }
      p = { ...p, updateTime: v.updateTime, original: v.fields, novo, campos: Object.keys(v.fields).filter(k => !igual(v.fields[k], novo[k])) };
      if (!p.campos.length) { trocados++; break; }
      if (tentativa === 3) problemas.push(`${p.c}/${p.id}: ${e.message}`);
    }
  }
}
// 4) Conferência final: cada registro, com as referências trocadas de volta, é idêntico ao que era.
const midiasFinal = await cli.listarComVersao(COL_MIDIA);
const mapaFinal = new Map(Object.entries(midiasFinal).map(([id, d]) => [id, d.fields?.dados?.stringValue]));
let restantes = 0, refsQuebradas = 0;
for (const c of COLECOES) {
  const docs = await cli.listarComVersao(c);
  for (const d of Object.values(docs)) {
    const achadas = new Map();
    trocar({ mapValue: { fields: d.fields } }, achadas);
    restantes += achadas.size;
    JSON.stringify(d.fields).replace(new RegExp('"' + PREFIXO + '(img_[0-9a-f]{64})"', 'g'), (_, id) => { if (!mapaFinal.has(id)) refsQuebradas++; return ''; });
  }
}
if (problemas.length || refsQuebradas) { nota('error', `Conferência: ${problemas.length} problema(s) ${problemas.slice(0, 5).join('; ')} · referências sem imagem: ${refsQuebradas}`); process.exit(1); }
nota('notice', `CONFERIDO → ${trocados} registro(s) agora guardam só a referência (${alteradosNoMeio} relidos porque mudaram durante a troca). Imagens na coleção "${COL_MIDIA}": ${mapaFinal.size}. Imagens que ainda estão dentro de registros: ${restantes}. Referências sem imagem: 0. Todos os registros, com as imagens de volta, são idênticos ao original.`);
