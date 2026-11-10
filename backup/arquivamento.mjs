// Arquivamento automático de Entradas de Peças e Orçamentos (rotina "Arquivamento automático" do GitHub).
// Roda fora do site, com a conta própria das rotinas (a mesma do backup), várias vezes ao dia — funciona
// mesmo sem ninguém com o sistema aberto.
//
// Regra (a MESMA das telas: as funções são lidas do próprio index.html):
//  - conjunto = a entrada + TODOS os orçamentos com o mesmo loteId (cópias/divisões incluídas);
//  - arquiva o conjunto inteiro só quando a entrada está concluída e TODOS os orçamentos estão em Concluído,
//    com a data de faturamento oficial ANTES do período de apuração de comissão atual (calendário da Comissão);
//  - se qualquer item não atende, nada do conjunto é arquivado;
//  - entrada arquivada por esta rotina volta para a área ativa se algum orçamento dela voltar a ficar ativo.
// Arquivar NÃO apaga nada: só marca arquivado:true com data, motivo e quem (a rotina). Status, faturamento,
// fotos, assinaturas e histórico ficam como estão. Cada conjunto é gravado num único commit atômico, com a
// versão lida de cada documento como pré-condição: se alguém mexeu no meio do caminho, nada é gravado e o
// conjunto é reavaliado na próxima execução (sem arquivamento parcial e sem sobrescrever ninguém).
// O registro desta rotina é público (repositório público): só contagens, nada de clientes ou números.
import { configFirebase, clienteFirestore } from './firestore-rest.mjs';
import { tipado, gravarMonitoramento } from './medir-banco.mjs';
import { carregarRegrasDoSite } from './regras-do-site.mjs';

export const FUNCOES = ['avaliarArquivamentoConjunto', 'arqDiaFaturamento', 'arqDiaBr', 'periodoAtualNoCalendario', 'periodoDaDataNoCalendario', 'montarCalendario', 'periodoSeguintePorCorte', 'periodoAnteriorPorCorte', 'diaDeCorteDe', 'nomePeriodoAuto', 'somarDias', 'diasEntre', 'dataDeCorteNoMes', 'formatarDataInput', 'chaveDia', 'dataDe', 'loteTotalmenteOrcado', 'loteTotalmenteClassificado'];
export const CONSTANTES = ['MESES_CURTOS', 'PERIODO_MIN_DIAS', 'ARQ_AUTO_POR', 'ARQ_AUTO_MOTIVO'];
const log = m => console.log(m);
export const diaBr = d => new Date(d).toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });

// formato tipado da API REST → objeto comum (datas viram Date)
export function des(t) {
  if (!t || typeof t !== 'object') return undefined;
  if ('stringValue' in t) return t.stringValue;
  if ('booleanValue' in t) return t.booleanValue;
  if ('integerValue' in t) return Number(t.integerValue);
  if ('doubleValue' in t) return t.doubleValue;
  if ('timestampValue' in t) return new Date(t.timestampValue);
  if ('nullValue' in t) return null;
  if ('referenceValue' in t) return t.referenceValue;
  if ('arrayValue' in t) return (t.arrayValue.values || []).map(des);
  if ('mapValue' in t) return desCampos(t.mapValue.fields);
  return undefined;
}
export const desCampos = f => Object.fromEntries(Object.entries(f || {}).map(([k, v]) => [k, des(v)]));

// Planejamento puro (sem banco): recebe os conjuntos já lidos e devolve o que gravar.
// grupos: [{ chave, lote: {id, updateTime, ...} | null, orcamentos: [{id, updateTime, ...}] }]
export function planejar(grupos, calendario, regras, agora = new Date()) {
  const hoje = diaBr(agora);
  const plano = { arquivar: [], reativar: [], pendentes: 0, motivosPendencia: {} };
  for (const g of grupos) {
    const r = regras.avaliarArquivamentoConjunto(g.lote, g.orcamentos, calendario, hoje);
    if (r.arquivar) {
      plano.arquivar.push({ chave: g.chave, lote: g.lote && !g.lote.arquivado ? g.lote : null, orcamentos: g.orcamentos.filter(o => !o.arquivado), periodo: r.periodo });
      continue;
    }
    const ativos = g.orcamentos.filter(o => !o.arquivado);
    if (g.lote && g.lote.arquivado && g.lote.arquivamentoAutomatico === true && ativos.length) {
      plano.reativar.push({ chave: g.chave, lote: g.lote, orcamentos: ativos });
      continue;
    }
    if ((g.lote && !g.lote.arquivado) || ativos.length) {
      plano.pendentes++;
      // tipos de pendência (sem números nem nomes) para o resumo
      r.pendencias.forEach(p => { const tipo = p.replace(/^[^:]*:\s*/, '').replace(/\(.*$|\d.*$/, '').trim(); plano.motivosPendencia[tipo] = (plano.motivosPendencia[tipo] || 0) + 1; });
    }
  }
  return plano;
}

// Escritas de um conjunto (commit único, com pré-condição de versão em cada documento).
export function escritasArquivar(item, nomeDoc, regras, agora = new Date()) {
  const quando = agora.toISOString();
  const conj = item.chave;
  const periodo = { inicio: item.periodo.inicio, fim: item.periodo.fim };
  const comuns = (doc) => ({
    arquivado: true, statusAnterior: doc.status || null, dataArquivamento: quando, arquivadoPor: regras.ARQ_AUTO_POR,
    motivoArquivamento: regras.ARQ_AUTO_MOTIVO, arquivamentoAutomatico: true, arquivamentoConjuntoId: conj, arquivamentoPeriodo: periodo
  });
  const w = [];
  const nOrc = item.orcamentos.length;
  for (const o of item.orcamentos) {
    const campos = comuns(o);
    w.push({
      update: { name: nomeDoc('orcamentos', o.id), fields: Object.fromEntries(Object.entries(campos).map(([k, v]) => [k, tipado(v)])) },
      updateMask: { fieldPaths: Object.keys(campos) },
      updateTransforms: [{ fieldPath: 'historico', appendMissingElements: { values: [tipado({ data: quando, usuario: regras.ARQ_AUTO_POR, usuarioId: '', tipo: 'arquivo', texto: `arquivado automaticamente junto com ${item.lote || o.loteId ? 'a entrada e os demais orçamentos vinculados' : 'o próprio conjunto'} — ${regras.ARQ_AUTO_MOTIVO}`, id: `auto-${o.id}-${agora.getTime().toString(36)}` })] } }],
      currentDocument: { updateTime: o.updateTime }
    });
  }
  if (item.lote) {
    const campos = comuns(item.lote);
    w.push({
      update: { name: nomeDoc('lotes', item.lote.id), fields: Object.fromEntries(Object.entries(campos).map(([k, v]) => [k, tipado(v)])) },
      updateMask: { fieldPaths: Object.keys(campos) },
      updateTransforms: [{ fieldPath: 'historicoArquivamento', appendMissingElements: { values: [tipado({ data: quando, acao: 'arquivada', por: regras.ARQ_AUTO_POR, motivo: `${regras.ARQ_AUTO_MOTIVO} (${nOrc} orçamento(s) arquivado(s) junto)` })] } }],
      currentDocument: { updateTime: item.lote.updateTime }
    });
  }
  return w;
}
export function escritasReativar(item, nomeDoc, regras, agora = new Date()) {
  const quando = agora.toISOString();
  const numeros = item.orcamentos.map(o => `#${o.numero || o.id}`).join(', ');
  const motivo = `Orçamento ${numeros} voltou para a área ativa — a entrada volta junto (arquivamento automático desfeito).`;
  const campos = { arquivado: false, dataArquivamento: null, arquivadoPor: null, arquivamentoAutomatico: false, reativadoEm: quando, reativadoMotivo: motivo };
  return [{
    update: { name: nomeDoc('lotes', item.lote.id), fields: Object.fromEntries(Object.entries(campos).map(([k, v]) => [k, tipado(v)])) },
    updateMask: { fieldPaths: Object.keys(campos) },
    updateTransforms: [{ fieldPath: 'historicoArquivamento', appendMissingElements: { values: [tipado({ data: quando, acao: 'reativada', por: regras.ARQ_AUTO_POR, motivo })] } }],
    currentDocument: { updateTime: item.lote.updateTime }
  }];
}

// Lê do banco só o necessário: entradas e orçamentos ATIVOS e, para cada entrada envolvida, todos os
// orçamentos com o mesmo loteId (inclusive os já arquivados), além do calendário da Comissão.
export async function lerConjuntos(cli) {
  const comVersao = d => ({ id: d.id, updateTime: d.updateTime, ...desCampos(d.fields) });
  const [lotesAtivos, orcsAtivos, periodos, fechamentos] = await Promise.all([
    cli.consultarTudo('lotes', 'arquivado', false), cli.consultarTudo('orcamentos', 'arquivado', false),
    cli.listarDocumentos('periodosApuracao'), cli.listarDocumentos('comissaoFechamentos')
  ]);
  const grupos = new Map();
  for (const l of lotesAtivos.map(comVersao)) grupos.set(l.id, { chave: l.id, lote: l, orcamentos: null });
  for (const o of orcsAtivos.map(comVersao)) {
    if (o.loteId) { if (!grupos.has(o.loteId)) grupos.set(o.loteId, { chave: o.loteId, lote: undefined, orcamentos: null }); }
    else grupos.set('orc:' + o.id, { chave: 'orc:' + o.id, lote: null, orcamentos: [o] });
  }
  for (const g of grupos.values()) {
    if (g.orcamentos) continue;
    if (g.lote === undefined) { const l = await cli.obterComVersao('lotes', g.chave); g.lote = l ? { id: g.chave, updateTime: l.updateTime, ...desCampos(l.fields) } : null; }
    g.orcamentos = (await cli.consultarTudo('orcamentos', 'loteId', g.chave)).map(comVersao);
  }
  const lista = o => Object.entries(o).map(([id, f]) => ({ id, ...desCampos(f) }));
  return { grupos: [...grupos.values()], periodos: lista(periodos).filter(p => !p.excluido), fechamentos: lista(fechamentos) };
}

async function principal() {
  const simular = /^(1|true|sim)$/i.test(process.env.SIMULAR || '');
  const regras = carregarRegrasDoSite(FUNCOES, CONSTANTES);
  const cli = clienteFirestore(configFirebase());
  const agora = new Date();
  const { grupos, periodos, fechamentos } = await lerConjuntos(cli);
  const cal = regras.montarCalendario(periodos, fechamentos);
  const per = regras.periodoAtualNoCalendario(cal, diaBr(agora));
  const plano = planejar(grupos, cal, regras, agora);
  log(`Período de apuração atual (Comissão): ${per.inicioStr} a ${per.fimStr}${per.cadastrado ? '' : ' (projetado pelo dia de corte)'}.`);
  log(`Conjuntos avaliados: ${grupos.length} · prontos para arquivar: ${plano.arquivar.length} · entradas a reativar: ${plano.reativar.length} · continuam ativos: ${plano.pendentes}.`);
  Object.entries(plano.motivosPendencia).sort((a, b) => b[1] - a[1]).forEach(([m, n]) => log(`  - ${n}× ${m}`));
  const res = { conjuntos: 0, entradas: 0, orcamentos: 0, reativadas: 0, conflitos: 0 };
  if (simular) {
    log(`SIMULAÇÃO: nada foi gravado. Arquivaria ${plano.arquivar.reduce((s, i) => s + (i.lote ? 1 : 0), 0)} entrada(s) e ${plano.arquivar.reduce((s, i) => s + i.orcamentos.length, 0)} orçamento(s).`);
    return;
  }
  const commit = async (writes, aoGravar) => {
    try { await cli.commit(writes); aoGravar(); }
    catch (e) {
      // versão mudou no meio do caminho (alguém editou): não grava nada, reavalia na próxima execução
      if ((e.status === 400 || e.status === 409) && /precondition|does not match|update.?time|base version|stored version/i.test(e.message)) { res.conflitos++; return; }
      throw e;
    }
  };
  try {
    for (const item of plano.arquivar) await commit(escritasArquivar(item, cli.nomeDoc, regras, agora), () => { res.conjuntos++; res.entradas += item.lote ? 1 : 0; res.orcamentos += item.orcamentos.length; });
    for (const item of plano.reativar) await commit(escritasReativar(item, cli.nomeDoc, regras, agora), () => { res.reativadas++; });
  } catch (e) {
    if (e.status === 403) { log('::warning::Arquivamento automático: o banco recusou a gravação — publique as regras novas do banco (seguranca/firestore.rules) no console do Firebase.'); process.exit(0); }
    throw e;
  }
  log(`Gravado: ${res.conjuntos} conjunto(s) arquivado(s) — ${res.entradas} entrada(s) e ${res.orcamentos} orçamento(s); ${res.reativadas} entrada(s) reativada(s); ${res.conflitos} adiado(s) por alteração simultânea.`);
  try {
    await gravarMonitoramento(cli, 'arquivamento', { executadoEm: agora.toISOString(), periodo: { inicio: per.inicioStr, fim: per.fimStr }, avaliados: grupos.length, continuamAtivos: plano.pendentes, ...res });
  } catch (e) { log('::warning::Arquivamento automático: resumo não gravado na Central (' + (e.status || e.message) + ').'); }
  log(`::notice::Arquivamento automático: ${res.entradas} entrada(s) e ${res.orcamentos} orçamento(s) arquivados; ${res.reativadas} entrada(s) reativada(s).`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  principal().catch(e => { console.log(`::error::Arquivamento automático falhou: ${String(e.message || e).replace(/backup-[^\s@]+@\S+/g, '[conta]').slice(0, 300)}`); process.exit(1); });
}
