// Medição do banco para a Central de Monitoramento (roda dentro da rotina de backup, que já lê o banco
// inteiro: não gera leituras a mais). Só conta e mede; não grava nada além do resumo em monitoramento/.
//
// Tamanho dos documentos: fórmula OFICIAL do Firestore ("Storage size calculations"):
//   texto = bytes UTF-8 + 1 · número/data = 8 · booleano/nulo = 1 · lista = soma · mapa = campos + 32
//   documento = nome do documento + nomes dos campos + valores + 32
// Índices automáticos: ESTIMATIVA (2 entradas por campo simples — crescente e decrescente; o Firestore
// indexa no máximo 1.500 bytes de cada texto). O total cobrado pelo Firebase (documentos + índices) só
// aparece no console do Firebase; aqui fica separado em "medido" e "estimado".
const PREFIXO_MIDIA = 'midia:';
const LIMITE_INDICE_TEXTO = 1500;

export const tamTexto = s => Buffer.byteLength(String(s), 'utf8') + 1;
export const tamNomeDoc = (caminho) => caminho.split('/').filter(Boolean).reduce((s, p) => s + tamTexto(p), 0) + 16;
// tamanho de um valor no formato tipado da API REST do Firestore
export function tamValor(v) {
  if (!v || typeof v !== 'object') return 1;
  if ('stringValue' in v) return tamTexto(v.stringValue);
  if ('integerValue' in v || 'doubleValue' in v || 'timestampValue' in v) return 8;
  if ('booleanValue' in v || 'nullValue' in v) return 1;
  if ('geoPointValue' in v) return 16;
  if ('bytesValue' in v) return Math.floor(String(v.bytesValue).length * 3 / 4);
  if ('referenceValue' in v) return tamNomeDoc(String(v.referenceValue).split('/documents/').pop());
  if ('arrayValue' in v) return (v.arrayValue.values || []).reduce((s, x) => s + tamValor(x), 0);
  if ('mapValue' in v) return tamCampos(v.mapValue.fields || {}) + 32;
  return 1;
}
export const tamCampos = f => Object.entries(f || {}).reduce((s, [k, x]) => s + tamTexto(k) + tamValor(x), 0);
export const tamDocumento = (caminho, campos) => tamNomeDoc(caminho) + tamCampos(campos) + 32;
// estimativa dos índices automáticos de campo simples (crescente + decrescente) de um documento
function estIndices(caminho, campos) {
  const nome = tamNomeDoc(caminho), pai = caminho.split('/').length > 2 ? tamNomeDoc(caminho.split('/').slice(0, -2).join('/')) : 0;
  let t = 0;
  for (const [k, v] of Object.entries(campos || {})) {
    if (v && (v.mapValue || v.arrayValue)) continue; // mapas e listas: índices por subcampo/elemento — fora da estimativa
    const val = v && 'stringValue' in v ? Math.min(tamTexto(v.stringValue), LIMITE_INDICE_TEXTO) : tamValor(v);
    t += 2 * (nome + pai + tamTexto(k) + val + 32);
  }
  return t;
}
function referenciasMidia(v, out) {
  if (!v || typeof v !== 'object') return;
  if (typeof v.stringValue === 'string') { if (v.stringValue.startsWith(PREFIXO_MIDIA)) out.push(v.stringValue.slice(PREFIXO_MIDIA.length)); return; }
  if (v.arrayValue) (v.arrayValue.values || []).forEach(x => referenciasMidia(x, out));
  if (v.mapValue) Object.values(v.mapValue.fields || {}).forEach(x => referenciasMidia(x, out));
}
const txt = v => (v && typeof v.stringValue === 'string' ? v.stringValue : '');
// tipo da imagem a partir do começo do texto "data:image/jpeg;base64,..."
const tipoMidia = campos => { for (const v of Object.values(campos || {})) { const m = /^data:([a-z]+\/[a-z0-9.+-]+)/i.exec(txt(v)); if (m) return m[1].toLowerCase(); } return 'desconhecido'; };

// docsPorColecao: { colecao: { id: camposTipados } } (como a rotina de backup lê)
export function medirBanco(docsPorColecao, agora = new Date()) {
  const colecoes = {};
  let totalDocs = 0, totalBytes = 0, totalIndices = 0;
  const donoMidia = new Map(); // id da mídia → coleção que a usa primeiro
  for (const [c, docs] of Object.entries(docsPorColecao)) {
    let bytes = 0, indices = 0, n = 0;
    for (const [id, campos] of Object.entries(docs)) {
      const caminho = `${c}/${id}`;
      bytes += tamDocumento(caminho, campos); indices += estIndices(caminho, campos); n++;
      if (c !== 'midias') { const refs = []; Object.values(campos).forEach(v => referenciasMidia(v, refs)); refs.forEach(r => { if (!donoMidia.has(r)) donoMidia.set(r, c); }); }
    }
    colecoes[c] = { documentos: n, bytes, indicesEstimados: indices };
    totalDocs += n; totalBytes += bytes; totalIndices += indices;
  }
  // fotos e imagens (coleção midias), por coleção que as usa e por formato
  const midias = { quantidade: 0, bytes: 0, porOrigem: {}, porTipo: {} };
  for (const [id, campos] of Object.entries(docsPorColecao.midias || {})) {
    const b = tamDocumento(`midias/${id}`, campos);
    const origem = donoMidia.get(id) || 'sem uso registrado';
    const tipo = tipoMidia(campos);
    midias.quantidade++; midias.bytes += b;
    (midias.porOrigem[origem] = midias.porOrigem[origem] || { quantidade: 0, bytes: 0 }).quantidade++; midias.porOrigem[origem].bytes += b;
    (midias.porTipo[tipo] = midias.porTipo[tipo] || { quantidade: 0, bytes: 0 }).quantidade++; midias.porTipo[tipo].bytes += b;
  }
  // certificados (PDF/JPG/PNG) — o arquivo fica em partes em certificadosPartes
  const certificados = { quantidade: Object.keys(docsPorColecao.certificados || {}).length, partes: Object.keys(docsPorColecao.certificadosPartes || {}).length, bytes: (colecoes.certificadosPartes || {}).bytes || 0, porTipo: {} };
  for (const campos of Object.values(docsPorColecao.certificados || {})) {
    const t = txt(campos.tipo) || 'desconhecido', tam = Number((campos.tamanho || {}).integerValue || (campos.tamanho || {}).doubleValue || 0);
    (certificados.porTipo[t] = certificados.porTipo[t] || { quantidade: 0, bytesArquivo: 0 }).quantidade++; certificados.porTipo[t].bytesArquivo += tam;
  }
  // usuários (fichas da Equipe)
  const usuarios = { total: 0, ativos: 0, pendentes: 0, bloqueados: 0, porPerfil: {} };
  for (const campos of Object.values(docsPorColecao.funcionarios || {})) {
    usuarios.total++;
    const st = txt(campos.status) || (campos.ativo && campos.ativo.booleanValue === false ? 'bloqueado' : 'ativo');
    if (st === 'ativo') usuarios.ativos++; else if (st === 'pendente') usuarios.pendentes++; else usuarios.bloqueados++;
    const p = txt(campos.perfil) || 'funcionario';
    usuarios.porPerfil[p] = (usuarios.porPerfil[p] || 0) + 1;
  }
  return {
    data: agora.toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' }), coletadoEm: agora.toISOString(), origem: 'rotina de backup (leitura completa do banco)',
    documentos: totalDocs, bytesDocumentos: totalBytes, bytesIndicesEstimados: totalIndices,
    colecoes, midias, certificados, usuarios
  };
}

// objeto comum → formato tipado da API REST (para gravar o resumo)
export function tipado(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(tipado) } };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, tipado(x)])) } };
}
// grava (substitui) monitoramento/<id> com a conta da rotina (regras: só ela grava, só o Master lê)
export async function gravarMonitoramento(fsCli, id, dados) {
  return fsCli.commit([{ update: { name: fsCli.nomeDoc('monitoramento', id), fields: Object.fromEntries(Object.entries(dados).map(([k, x]) => [k, tipado(x)])) } }]);
}
