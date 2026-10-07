/* TPBACKUP-NUCLEO-INICIO */
// Núcleo do backup do Controle de Peças — usado pela rotina automática (GitHub Actions) e pelo
// script de recuperação (Node 20+). Não faz parte do site: o backup funciona fora do sistema.
// Formato do arquivo .tpbak:
//   "TPBAK001" (8 bytes) + tamanho do cabeçalho (4 bytes, big-endian) + cabeçalho JSON + dados cifrados
// Dados = JSON do backup, compactado (gzip) e cifrado com AES-256-GCM. A chave AES de cada
// backup é cifrada com a chave PÚBLICA RSA-OAEP da empresa; só o arquivo da chave privada
// (protegido por senha, guardado pelo administrador) consegue abrir o backup.
(function (raiz) {
  'use strict';
  const MAGICO = 'TPBAK001';
  const FORMATO = 'tecnopemt-backup';
  const VERSAO = 1;
  // Coleções do sistema (as que o código usa). A rotina também tenta descobrir coleções extras.
  const COLECOES = ['clientes', 'catalogoPecas', 'lotes', 'orcamentos', 'funcionarios', 'comissoes', 'comissaoFechamentos', 'comissaoHistorico', 'apuracaoRegistros', 'regrasComissao', 'periodosApuracao', 'avisos', 'notificacoes', 'config', 'pecas', 'midias'];
  // Fotos e assinaturas ficam na coleção "midias" (um documento por imagem, id = img_ + SHA-256 do conteúdo);
  // os registros guardam só a referência "midia:img_...".
  const PREFIXO_MIDIA = 'midia:';
  // Coleções de uma versão anterior do backup (já removida do site): nunca entram num backup nem
  // são gravadas por uma restauração.
  const COLECOES_DO_BACKUP = ['backups', 'backupsCopias'];
  // Documentos que a restauração mantém como estão (configuração da chave de backup).
  const DOCS_PRESERVADOS = { config: ['backup'] };
  const subtle = () => (raiz.crypto && raiz.crypto.subtle) || null;
  const te = new TextEncoder(), td = new TextDecoder();

  // ---------- utilidades ----------
  function paraBase64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function deBase64(b64) {
    const s = atob(b64);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }
  async function sha256Hex(bytes) {
    const h = new Uint8Array(await subtle().digest('SHA-256', bytes));
    return Array.from(h, b => b.toString(16).padStart(2, '0')).join('');
  }
  async function transformar(bytes, stream) {
    const r = new Response(new Blob([bytes]).stream().pipeThrough(stream));
    return new Uint8Array(await r.arrayBuffer());
  }
  const temCompressao = () => typeof raiz.CompressionStream === 'function' && typeof raiz.DecompressionStream === 'function';
  const gzip = b => transformar(b, new raiz.CompressionStream('gzip'));
  const gunzip = b => transformar(b, new raiz.DecompressionStream('gzip'));
  function juntar(partes) {
    const total = partes.reduce((s, p) => s + p.length, 0);
    const out = new Uint8Array(total);
    let o = 0;
    partes.forEach(p => { out.set(p, o); o += p.length; });
    return out;
  }
  // JSON estável (chaves ordenadas) — para hash de documentos
  function jsonEstavel(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(jsonEstavel).join(',') + ']';
    return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + jsonEstavel(v[k])).join(',') + '}';
  }

  // ---------- chaves ----------
  const RSA = { name: 'RSA-OAEP', modulusLength: 3072, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' };
  async function idDaChave(jwkPublica) {
    return (await sha256Hex(te.encode(jwkPublica.n + '.' + jwkPublica.e))).slice(0, 16);
  }
  async function chaveDeSenha(senha, sal, usos) {
    const base = await subtle().importKey('raw', te.encode(senha), 'PBKDF2', false, ['deriveKey']);
    return subtle().deriveKey({ name: 'PBKDF2', salt: sal, iterations: 250000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, usos);
  }
  // Gera o par de chaves. Devolve o ARQUIVO DA CHAVE (para o administrador guardar) e a chave pública.
  async function gerarChaves(senha, info) {
    if (!senha || senha.length < 8) throw new Error('A senha da chave precisa ter pelo menos 8 caracteres.');
    const par = await subtle().generateKey(RSA, true, ['encrypt', 'decrypt']);
    const publica = await subtle().exportKey('jwk', par.publicKey);
    const privada = new Uint8Array(await subtle().exportKey('pkcs8', par.privateKey));
    const sal = raiz.crypto.getRandomValues(new Uint8Array(16)), iv = raiz.crypto.getRandomValues(new Uint8Array(12));
    const k = await chaveDeSenha(senha, sal, ['encrypt']);
    const cifrada = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv }, k, privada));
    const chaveId = await idDaChave(publica);
    const pub = { kty: publica.kty, n: publica.n, e: publica.e, alg: 'RSA-OAEP-256', ext: true };
    return {
      chaveId,
      chavePublica: pub,
      arquivoChave: { formato: 'tecnopemt-chave-backup', versao: 1, chaveId, criadaEm: new Date().toISOString(), ...(info || {}), chavePublica: pub, privadaCifrada: { kdf: 'PBKDF2-SHA256', iteracoes: 250000, sal: paraBase64(sal), iv: paraBase64(iv), dados: paraBase64(cifrada) }, aviso: 'Guarde este arquivo e a senha em dois lugares seguros. Sem eles não é possível abrir os backups.' }
    };
  }
  async function abrirChavePrivada(arquivoChave, senha) {
    if (!arquivoChave || arquivoChave.formato !== 'tecnopemt-chave-backup') throw new Error('Este arquivo não é uma chave de backup do Controle de Peças.');
    const p = arquivoChave.privadaCifrada;
    const k = await chaveDeSenha(senha || '', deBase64(p.sal), ['decrypt']);
    let pkcs8;
    try { pkcs8 = await subtle().decrypt({ name: 'AES-GCM', iv: deBase64(p.iv) }, k, deBase64(p.dados)); } catch (e) { throw new Error('Senha da chave incorreta.'); }
    const chave = await subtle().importKey('pkcs8', pkcs8, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['decrypt']);
    return { chave, chaveId: arquivoChave.chaveId, chavePublica: arquivoChave.chavePublica };
  }
  async function importarPublica(jwk) {
    return subtle().importKey('jwk', { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RSA-OAEP-256', ext: true }, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
  }

  // ---------- empacotar / abrir ----------
  // plano = objeto do backup (documentos, código, resumo...). meta = informações visíveis sem a chave.
  async function empacotar(plano, chavePublicaJwk, meta) {
    const json = te.encode(JSON.stringify(plano));
    const shaPlano = await sha256Hex(json);
    const comp = temCompressao() ? await gzip(json) : json;
    const aes = await subtle().generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
    const aesBruta = new Uint8Array(await subtle().exportKey('raw', aes));
    const pub = await importarPublica(chavePublicaJwk);
    const chaveCifrada = new Uint8Array(await subtle().encrypt({ name: 'RSA-OAEP' }, pub, aesBruta));
    const iv = raiz.crypto.getRandomValues(new Uint8Array(12));
    const cab = {
      formato: FORMATO, versao: VERSAO, alg: 'RSA-OAEP-256+A256GCM', chaveId: await idDaChave(chavePublicaJwk),
      chaveCifrada: paraBase64(chaveCifrada), iv: paraBase64(iv), compressao: temCompressao() ? 'gzip' : 'nenhuma',
      tamanhoDados: json.length, sha256Dados: shaPlano, ...(meta || {})
    };
    const cabBytes = te.encode(JSON.stringify(cab));
    const cifrado = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: cabBytes }, aes, comp));
    const tam = new Uint8Array(4);
    new DataView(tam.buffer).setUint32(0, cabBytes.length, false);
    return juntar([te.encode(MAGICO), tam, cabBytes, cifrado]);
  }
  function lerCabecalho(bytes) {
    if (!bytes || bytes.length < 12 || td.decode(bytes.subarray(0, 8)) !== MAGICO) throw new Error('Arquivo inválido: não é um backup do Controle de Peças (.tpbak).');
    const n = new DataView(bytes.buffer, bytes.byteOffset + 8, 4).getUint32(0, false);
    if (12 + n > bytes.length) throw new Error('Arquivo de backup incompleto (cortado).');
    const cabBytes = bytes.subarray(12, 12 + n);
    const cab = JSON.parse(td.decode(cabBytes));
    if (cab.formato !== FORMATO) throw new Error('Formato de backup desconhecido.');
    return { cab, cabBytes, corpo: bytes.subarray(12 + n) };
  }
  async function abrir(bytes, chavePrivada) {
    const { cab, cabBytes, corpo } = lerCabecalho(bytes);
    if (chavePrivada.chaveId && cab.chaveId !== chavePrivada.chaveId) throw new Error(`Este backup foi cifrado com outra chave (${cab.chaveId}). A chave informada é ${chavePrivada.chaveId}.`);
    let aesBruta, comp;
    try { aesBruta = await subtle().decrypt({ name: 'RSA-OAEP' }, chavePrivada.chave, deBase64(cab.chaveCifrada)); } catch (e) { throw new Error('A chave não abre este backup.'); }
    const aes = await subtle().importKey('raw', aesBruta, { name: 'AES-GCM' }, false, ['decrypt']);
    try { comp = new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: deBase64(cab.iv), additionalData: cabBytes }, aes, corpo)); } catch (e) { throw new Error('Backup corrompido ou alterado: a verificação de integridade falhou.'); }
    const json = cab.compressao === 'gzip' ? await gunzip(comp) : comp;
    const sha = await sha256Hex(json);
    if (sha !== cab.sha256Dados) throw new Error('Backup corrompido: o conteúdo não confere com o código de verificação (SHA-256).');
    return { cab, plano: JSON.parse(td.decode(json)) };
  }

  // ---------- valores do Firestore (formato tipado da API REST) ----------
  // O backup guarda cada documento no formato tipado do Firestore ({ stringValue: ... }), que é
  // exato: datas, números, mapas e listas voltam iguais.
  function paraTipado(v, ad) {
    if (v === null || v === undefined) return { nullValue: null };
    if (typeof v === 'boolean') return { booleanValue: v };
    if (typeof v === 'number') {
      if (Number.isInteger(v) && Math.abs(v) <= Number.MAX_SAFE_INTEGER) return { integerValue: String(v) };
      return { doubleValue: Number.isFinite(v) ? v : String(v) };
    }
    if (typeof v === 'string') return { stringValue: v };
    if (ad && ad.ehTimestamp && ad.ehTimestamp(v)) return { timestampValue: new Date(v.toMillis ? v.toMillis() : v.toDate().getTime()).toISOString() };
    if (v instanceof Date) return { timestampValue: v.toISOString() };
    if (ad && ad.ehGeo && ad.ehGeo(v)) return { geoPointValue: { latitude: v.latitude, longitude: v.longitude } };
    if (ad && ad.ehRef && ad.ehRef(v)) return { referenceValue: ad.nomeRef(v) };
    if (ad && ad.ehBytes && ad.ehBytes(v)) return { bytesValue: v.toBase64() };
    if (Array.isArray(v)) return { arrayValue: { values: v.map(x => paraTipado(x, ad)) } };
    if (typeof v === 'object') { const fields = {}; Object.keys(v).forEach(k => { fields[k] = paraTipado(v[k], ad); }); return { mapValue: { fields } }; }
    return { stringValue: String(v) };
  }
  function deTipado(t, ad) {
    if (!t || typeof t !== 'object') return null;
    if ('nullValue' in t) return null;
    if ('booleanValue' in t) return t.booleanValue;
    if ('integerValue' in t) return Number(t.integerValue);
    if ('doubleValue' in t) return Number(t.doubleValue);
    if ('stringValue' in t) return t.stringValue;
    if ('timestampValue' in t) return ad && ad.criarTimestamp ? ad.criarTimestamp(t.timestampValue) : t.timestampValue;
    if ('geoPointValue' in t) return ad && ad.criarGeo ? ad.criarGeo(t.geoPointValue) : t.geoPointValue;
    if ('referenceValue' in t) return ad && ad.criarRef ? ad.criarRef(t.referenceValue) : t.referenceValue;
    if ('bytesValue' in t) return ad && ad.criarBytes ? ad.criarBytes(t.bytesValue) : t.bytesValue;
    if ('arrayValue' in t) return ((t.arrayValue && t.arrayValue.values) || []).map(x => deTipado(x, ad));
    if ('mapValue' in t) { const o = {}; const f = (t.mapValue && t.mapValue.fields) || {}; Object.keys(f).forEach(k => { o[k] = deTipado(f[k], ad); }); return o; }
    return null;
  }
  const camposParaObjeto = (fields, ad) => deTipado({ mapValue: { fields: fields || {} } }, ad);
  const objetoParaCampos = (obj, ad) => paraTipado(obj || {}, ad).mapValue.fields;
  // Forma canônica para comparar documentos (números como número, datas em milissegundos).
  function canonico(t) {
    if (!t || typeof t !== 'object') return null;
    if ('nullValue' in t) return null;
    if ('booleanValue' in t) return t.booleanValue;
    if ('integerValue' in t || 'doubleValue' in t) return Number('integerValue' in t ? t.integerValue : t.doubleValue);
    if ('stringValue' in t) return t.stringValue;
    if ('timestampValue' in t) return { __ts: new Date(t.timestampValue).getTime() };
    if ('geoPointValue' in t) return { __geo: [t.geoPointValue.latitude || 0, t.geoPointValue.longitude || 0] };
    if ('referenceValue' in t) return { __ref: String(t.referenceValue).replace(/^projects\/[^/]+\/databases\/[^/]+\/documents\//, '') };
    if ('bytesValue' in t) return { __bytes: t.bytesValue };
    if ('arrayValue' in t) return ((t.arrayValue && t.arrayValue.values) || []).map(canonico);
    if ('mapValue' in t) { const o = {}; const f = (t.mapValue && t.mapValue.fields) || {}; Object.keys(f).forEach(k => { o[k] = canonico(f[k]); }); return o; }
    return null;
  }
  const assinaturaDocumento = fields => jsonEstavel(canonico({ mapValue: { fields: fields || {} } }));

  // ---------- montar o backup ----------
  // docsPorColecao: { colecao: { id: fields(tipado) } }
  function montarPlano({ docsPorColecao, tipo, origem, projeto, codigo, colecoesNaoEncontradas, observacoes }) {
    const documentos = {};
    Object.keys(docsPorColecao).sort().forEach(c => { if (!COLECOES_DO_BACKUP.includes(c)) documentos[c] = docsPorColecao[c]; });
    return {
      formato: FORMATO, versao: VERSAO, criadoEm: new Date().toISOString(), tipo, origem, projeto,
      colecoes: Object.keys(documentos), colecoesNaoEncontradas: colecoesNaoEncontradas || [],
      documentos, codigo: codigo || null, observacoes: observacoes || []
    };
  }
  function resumoDoPlano(plano) {
    const colecoes = {};
    let total = 0;
    Object.keys(plano.documentos || {}).forEach(c => { const n = Object.keys(plano.documentos[c]).length; colecoes[c] = n; total += n; });
    const img = contarImagens(plano);
    return { colecoes, totalDocumentos: total, imagens: img.qtd, bytesImagens: img.bytes, assinaturas: img.assinaturas, arquivosCodigo: plano.codigo && plano.codigo.arquivos ? Object.keys(plano.codigo.arquivos).length : 0 };
  }
  function contarImagens(plano) {
    let qtd = 0, bytes = 0, assinaturas = 0, invalidas = [];
    function andar(t, caminho) {
      if (!t || typeof t !== 'object') return;
      if ('stringValue' in t) {
        const s = t.stringValue;
        if (typeof s === 'string' && s.startsWith(PREFIXO_MIDIA)) { if (/assinatura/i.test(caminho)) assinaturas++; return; }
        if (typeof s === 'string' && s.startsWith('data:')) {
          qtd++; bytes += s.length;
          if (/assinatura/i.test(caminho)) assinaturas++;
          if (!/^data:[\w.+/-]+;base64,[A-Za-z0-9+/]/.test(s.slice(0, 80)) || s.length < 40) invalidas.push(caminho);
        }
        return;
      }
      if (t.arrayValue) (t.arrayValue.values || []).forEach((x, i) => andar(x, caminho + '[' + i + ']'));
      if (t.mapValue) Object.keys(t.mapValue.fields || {}).forEach(k => andar(t.mapValue.fields[k], caminho + '.' + k));
    }
    Object.keys(plano.documentos || {}).forEach(c => Object.keys(plano.documentos[c]).forEach(id => andar({ mapValue: { fields: plano.documentos[c][id] } }, `${c}/${id}`)));
    return { qtd, bytes, assinaturas, invalidas };
  }

  // ---------- verificação de integridade ----------
  // Vínculos entre os dados (Entrada → Cliente → Peças → Orçamento → Comissão ...).
  const VINCULOS = [
    { de: 'orcamentos', campo: 'clienteId', para: 'clientes', nome: 'Orçamento → Cliente' },
    { de: 'orcamentos', campo: 'loteId', para: 'lotes', nome: 'Orçamento → Entrada de peças' },
    { de: 'orcamentos', campo: 'periodoApuracaoId', para: 'periodosApuracao', nome: 'Orçamento → Período de apuração' },
    { de: 'lotes', campo: 'clienteId', para: 'clientes', nome: 'Entrada → Cliente' },
    { de: 'lotes', campo: 'orcamentoId', para: 'orcamentos', nome: 'Entrada → Orçamento' },
    { de: 'lotes', lista: 'itens', campo: 'pecaCatalogoId', para: 'catalogoPecas', nome: 'Entrada → Peça do cadastro' },
    { de: 'orcamentos', lista: 'itens', campo: 'pecaCatalogoId', para: 'catalogoPecas', nome: 'Orçamento → Peça do cadastro' },
    { de: 'comissoes', campo: 'orcamentoId', para: 'orcamentos', nome: 'Comissão → Orçamento' },
    { de: 'comissoes', campo: 'funcionarioId', para: 'funcionarios', nome: 'Comissão → Funcionário' },
    { de: 'apuracaoRegistros', campo: 'funcionarioId', para: 'funcionarios', nome: 'Atrasos/faltas → Funcionário' },
    { de: 'notificacoes', campo: 'funcionarioId', para: 'funcionarios', nome: 'Notificação → Funcionário' }
  ];
  function verificarPlano(plano) {
    const erros = [], avisos = [], vinculos = [];
    if (!plano || plano.formato !== FORMATO) erros.push('Formato do backup não reconhecido.');
    const docs = (plano && plano.documentos) || {};
    const ids = {};
    Object.keys(docs).forEach(c => { ids[c] = new Set(Object.keys(docs[c])); });
    COLECOES.forEach(c => { if (!docs[c] && !(plano.colecoesNaoEncontradas || []).includes(c)) avisos.push(`Coleção "${c}" não está no backup (estava vazia ou não existia).`); });
    Object.keys(docs).forEach(c => Object.keys(docs[c]).forEach(id => {
      const f = docs[c][id];
      if (!f || typeof f !== 'object') erros.push(`Documento inválido: ${c}/${id}`);
    }));
    VINCULOS.forEach(v => {
      if (!docs[v.de]) return;
      let total = 0, quebrados = 0;
      const exemplos = [];
      Object.keys(docs[v.de]).forEach(id => {
        const obj = camposParaObjeto(docs[v.de][id]);
        const valores = v.lista ? (Array.isArray(obj[v.lista]) ? obj[v.lista].map(x => x && x[v.campo]) : []) : [obj[v.campo]];
        valores.forEach(val => {
          if (val === undefined || val === null || val === '') return;
          total++;
          if (!ids[v.para] || !ids[v.para].has(String(val))) { quebrados++; if (exemplos.length < 3) exemplos.push(`${v.de}/${id} → ${v.para}/${val}`); }
        });
      });
      vinculos.push({ nome: v.nome, total, quebrados, exemplos });
    });
    // Foto/assinatura → imagem guardada em "midias"
    {
      let total = 0, quebrados = 0;
      const exemplos = [];
      const andar = (t, onde) => {
        if (!t || typeof t !== 'object') return;
        if (typeof t.stringValue === 'string') {
          if (t.stringValue.startsWith(PREFIXO_MIDIA)) {
            total++;
            const id = t.stringValue.slice(PREFIXO_MIDIA.length);
            if (!ids.midias || !ids.midias.has(id)) { quebrados++; if (exemplos.length < 3) exemplos.push(`${onde} → midias/${id}`); }
          }
          return;
        }
        if (t.arrayValue) (t.arrayValue.values || []).forEach(x => andar(x, onde));
        if (t.mapValue) Object.values(t.mapValue.fields || {}).forEach(x => andar(x, onde));
      };
      Object.keys(docs).forEach(c => { if (c !== 'midias') Object.keys(docs[c]).forEach(id => andar({ mapValue: { fields: docs[c][id] } }, `${c}/${id}`)); });
      if (total || docs.midias) vinculos.push({ nome: 'Foto/assinatura → Imagem guardada', total, quebrados, exemplos });
    }
    const img = contarImagens(plano || {});
    if (img.invalidas.length) avisos.push(`${img.invalidas.length} imagem(ns) com formato inesperado (ex.: ${img.invalidas.slice(0, 2).join(', ')}).`);
    if (plano && plano.codigo && plano.codigo.arquivos && !plano.codigo.arquivos['index.html']) avisos.push('O código do site (index.html) não está no backup.');
    if (plano && !plano.codigo) avisos.push('Este backup não traz o código do site (só os dados).');
    return { ok: erros.length === 0, erros, avisos, vinculos, resumo: plano ? resumoDoPlano(plano) : null };
  }
  // Diferença entre o backup e o banco atual (o que a restauração vai criar, mudar e apagar).
  function compararComAtual(plano, atual) {
    const r = {};
    const cols = new Set([...Object.keys(plano.documentos || {}), ...Object.keys(atual || {})]);
    cols.forEach(c => {
      if (COLECOES_DO_BACKUP.includes(c)) return;
      const b = (plano.documentos || {})[c] || {}, a = (atual || {})[c] || {};
      const preserv = DOCS_PRESERVADOS[c] || [];
      let criar = 0, alterar = 0, apagar = 0, iguais = 0;
      Object.keys(b).forEach(id => { if (preserv.includes(id)) return; if (!a[id]) criar++; else if (assinaturaDocumento(a[id]) !== assinaturaDocumento(b[id])) alterar++; else iguais++; });
      Object.keys(a).forEach(id => { if (!preserv.includes(id) && !b[id]) apagar++; });
      r[c] = { criar, alterar, apagar, iguais };
    });
    return r;
  }
  // Confere, depois de restaurar, se o banco ficou idêntico ao backup.
  function conferirRestauracao(plano, atual) {
    const dif = [];
    Object.keys(plano.documentos || {}).forEach(c => {
      if (COLECOES_DO_BACKUP.includes(c)) return;
      const b = plano.documentos[c], a = (atual || {})[c] || {};
      const preserv = DOCS_PRESERVADOS[c] || [];
      Object.keys(b).forEach(id => { if (preserv.includes(id)) return; if (!a[id]) dif.push(`faltando ${c}/${id}`); else if (assinaturaDocumento(a[id]) !== assinaturaDocumento(b[id])) dif.push(`diferente ${c}/${id}`); });
      Object.keys(a).forEach(id => { if (!preserv.includes(id) && !b[id]) dif.push(`sobrando ${c}/${id}`); });
    });
    return { ok: dif.length === 0, diferencas: dif };
  }
  function formatarBytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1).replace('.', ',') + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1).replace('.', ',') + ' MB';
    return (n / 1024 / 1024 / 1024).toFixed(2).replace('.', ',') + ' GB';
  }
  const api = { PREFIXO_MIDIA, MAGICO, FORMATO, VERSAO, COLECOES, COLECOES_DO_BACKUP, DOCS_PRESERVADOS, VINCULOS, paraBase64, deBase64, sha256Hex, gzip, gunzip, jsonEstavel, gerarChaves, abrirChavePrivada, importarPublica, idDaChave, empacotar, lerCabecalho, abrir, paraTipado, deTipado, camposParaObjeto, objetoParaCampos, assinaturaDocumento, montarPlano, resumoDoPlano, contarImagens, verificarPlano, compararComAtual, conferirRestauracao, formatarBytes, juntar };
  raiz.TPBackup = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : window);
/* TPBACKUP-NUCLEO-FIM */
