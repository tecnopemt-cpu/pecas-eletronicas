// Diagnóstico da Comissão (somente leitura, conta da rotina de backup). O relatório sai CIFRADO.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { configFirebase, clienteFirestore } from '../backup/firestore-rest.mjs';
import { campos } from '../backup/lembretes-avaliacao.mjs';
import { carregarCalculo } from './extrair.mjs';
const api = carregarCalculo('index.html');
const fsCli = clienteFirestore(configFirebase());
const ler = async c => Object.entries(await fsCli.listarDocumentos(c)).map(([id, f]) => ({ id, ...conv(campos(f)) }));
// datas do Firestore → objeto com toDate() (como o site recebe)
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
function conv(v) { if (typeof v === 'string' && ISO.test(v)) { const d = new Date(v); return { toDate: () => d, _iso: v }; } if (Array.isArray(v)) return v.map(conv); if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, conv(x)])); return v; }
const [funcionarios, orcamentos, comissoes, periodos, fechamentos, registrosDocs, versoes, historico] = await Promise.all(
  ['funcionarios', 'orcamentos', 'comissoes', 'periodosApuracao', 'comissaoFechamentos', 'apuracaoRegistros', 'regrasComissao', 'comissaoHistorico'].map(ler));
const A = api;
const hoje = A.formatarDataInput(new Date());
const nome = id => (funcionarios.find(f => f.id === id) || {}).nome || id;
const moeda = v => (Number(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const out = []; const p = s => out.push(s);
p(`# Diagnóstico da Comissão — ${new Date().toLocaleString('pt-BR')}`);
p(`Registros: ${funcionarios.length} funcionários, ${orcamentos.length} orçamentos, ${comissoes.length} lançamentos de comissão, ${periodos.length} períodos, ${fechamentos.length} fechamentos, ${registrosDocs.length} docs de apuração, ${versoes.length} versões de regras, ${historico.length} itens de histórico.`);
// calendário
const cal = A.montarCalendario(periodos, fechamentos);
const atual = A.periodoAtualNoCalendario(cal, hoje);
p(`\n## Calendário\nHoje ${hoje}. Período atual: ${atual.inicioStr} a ${atual.fimStr} (${atual.nome}) ${atual.cadastrado ? 'cadastrado' : 'NÃO cadastrado' + (atual.projetado ? ' (projetado)' : '') + (atual.lacuna ? ' (lacuna)' : '')}.`);
for (let i = 1; i < cal.length; i++) { const a = cal[i - 1], b = cal[i]; if (A.somarDias(a.dataFinal, 1) !== b.dataInicial) p(`- ${b.dataInicial <= a.dataFinal ? 'SOBREPOSIÇÃO' : 'LACUNA'} entre ${a.dataInicial}–${a.dataFinal} e ${b.dataInicial}–${b.dataFinal}`); }
const futuros = cal.filter(x => x.dataInicial > hoje);
p(`Períodos futuros cadastrados: ${futuros.length}${futuros.length ? ' (' + futuros.map(x => x.dataInicial + '–' + x.dataFinal).join(', ') + ')' : ''}.`);
// status por período (últimos 8)
p(`\n## Períodos (últimos 8)`);
const rodar = (ini, fim) => A.calcularApuracaoComissao({ inicio: ini, fim, regras: A.regrasVigentesEm(versoes, ini), funcionarios, comissoes, orcamentos, registros: A.montarRegistrosPeriodo(registrosDocs, ini, fim) });
for (const per of cal.filter(x => x.dataInicial <= hoje).slice(-8)) {
  const st = A.statusDoPeriodo(per, hoje, fechamentos);
  const f = fechamentos.find(x => x.id === A.idFechamentoComissao(per.dataInicial, per.dataFinal));
  const vivo = rodar(per.dataInicial, per.dataFinal);
  let linha = `- ${per.dataInicial}–${per.dataFinal} (${per.nome || ''}) · ${st}`;
  if (f) {
    const res = f.resultado || {};
    const ids = Object.keys(f.pagamentos || {}); const pagos = ids.filter(k => f.pagamentos[k] && f.pagamentos[k].pago).length;
    const linhasF = (res.linhas || []).filter(l => (l.final || 0) > 0);
    linha += ` · fechado por ${f.fechadoPor || '-'} · total fechado ${moeda(res.totalFinal)} · faturamento ${moeda(res.faturamento)} · pagos ${pagos}/${linhasF.length} com valor · recálculos ${(f.recalculos || []).length}`;
    const dif = Math.round(((vivo.totalFinal || 0) - (res.totalFinal || 0)) * 100) / 100;
    if (Math.abs(dif) >= 0.01) linha += ` · ATENÇÃO: recalculando hoje daria ${moeda(vivo.totalFinal)} (diferença ${moeda(dif)})`;
    const naoConsol = orcamentos.filter(o => o.status === 'Concluído' && !o.periodoConsolidadoId && A.dentroDoIntervalo(A.dataReferenciaOrcamento(o), per.dataInicial, per.dataFinal));
    if (naoConsol.length) linha += ` · ATENÇÃO: ${naoConsol.length} orçamento(s) concluído(s) com data neste período mas FORA do fechamento (${naoConsol.map(o => '#' + o.numero + ' ' + moeda(o.total)).join(', ')})`;
  } else {
    linha += ` · faturamento ${moeda(vivo.faturamento)} · faixa ${vivo.faixa ? vivo.faixa.percentual + '%' : '-'} · total ${moeda(vivo.totalFinal)} · ${vivo.linhas.length} pessoa(s)`;
    if (st === 'encerrado') linha += ` · ENCERRADO HÁ ${A.diasEntre(per.dataFinal, hoje)} dia(s) E NÃO FECHADO`;
  }
  p(linha);
}
// período atual detalhado
const r = rodar(atual.inicioStr, atual.fimStr);
p(`\n## Período atual em detalhe (${atual.inicioStr}–${atual.fimStr})`);
p(`Faturamento ${moeda(r.faturamento)} · faixa ${r.faixa ? `${moeda(r.faixa.min)}+ = ${r.faixa.percentual}%` : 'nenhuma'}${r.proximaFaixa ? ` · próxima faixa em ${moeda(r.proximaFaixa.min)} (faltam ${moeda(r.proximaFaixa.min - r.faturamento)})` : ''} · garantia ${(r.pctGarantia || 0).toFixed(1)}%${r.garantiaEstourada ? ' (ACIMA do limite)' : ''} · total ${moeda(r.totalFinal)}`);
(r.linhas || []).forEach(l => p(`- ${l.nome || nome(l.funcionarioId)}: base ${moeda(l.base)} → final ${moeda(l.final)} · ${l.atrasos || 0} atraso(s), ${l.qtdFaltas || 0} falta(s)`));
// integridade
p(`\n## Conferências de dados`);
const porId = Object.fromEntries(orcamentos.map(o => [o.id, o]));
const conc = orcamentos.filter(o => o.status === 'Concluído');
const semDataFat = conc.filter(o => !o.dataFaturamento);
p(`- Orçamentos concluídos: ${conc.length}; sem data de faturamento (usa conclusão/criação): ${semDataFat.length}${semDataFat.length ? ' — ' + semDataFat.slice(0, 15).map(o => '#' + o.numero).join(', ') : ''}`);
const concSemValor = conc.filter(o => !(Number(o.total) > 0));
p(`- Concluídos com total zero: ${concSemValor.length}${concSemValor.length ? ' — ' + concSemValor.slice(0, 15).map(o => '#' + o.numero).join(', ') : ''} (pode ser garantia/sem conserto — normal)`);
const orfaos = comissoes.filter(c => !porId[c.orcamentoId]);
p(`- Lançamentos de comissão de orçamento que não existe mais: ${orfaos.length}${orfaos.length ? ` (${moeda(orfaos.reduce((s, c) => s + (Number(c.valor) || 0), 0))})` : ''}`);
const semFunc = comissoes.filter(c => !funcionarios.find(f => f.id === c.funcionarioId));
p(`- Lançamentos de funcionário inexistente: ${semFunc.length}`);
const chaves = {}; comissoes.forEach(c => { const k = c.orcamentoId + '|' + c.funcionarioId; (chaves[k] = chaves[k] || []).push(c); });
const dup = Object.entries(chaves).filter(([, l]) => l.length > 1);
p(`- Orçamentos com mais de um lançamento para a mesma pessoa: ${dup.length}${dup.length ? ' — ' + dup.slice(0, 15).map(([k, l]) => `#${(porId[k.split('|')[0]] || {}).numero || '?'} ${nome(k.split('|')[1])} ×${l.length} (${l.map(c => moeda(c.valor)).join(' + ')})`).join('; ') : ''}`);
const comLanc = new Set(comissoes.map(c => c.orcamentoId));
const dRef = o => { const d = A.dataReferenciaOrcamento(o); return d ? A.chaveDia(d) : ''; };
const concSemLanc = conc.filter(o => Number(o.total) > 0 && !comLanc.has(o.id)).sort((a, b) => dRef(b).localeCompare(dRef(a)));
p(`- Concluídos com valor e SEM nenhum lançamento de comissão: ${concSemLanc.length}${concSemLanc.length ? ' — ' + concSemLanc.slice(0, 20).map(o => '#' + o.numero + ' ' + moeda(o.total) + ' (' + (A.dataReferenciaOrcamento(o) ? A.chaveDia(A.dataReferenciaOrcamento(o)) : '-') + ')').join(', ') : ''}`);
const consolidadoInexistente = orcamentos.filter(o => o.periodoConsolidadoId && !fechamentos.find(f => f.id === o.periodoConsolidadoId));
p(`- Orçamentos presos a um fechamento que não existe: ${consolidadoInexistente.length}`);
const consolidadoNaoConcluido = orcamentos.filter(o => o.periodoConsolidadoId && o.status !== 'Concluído');
p(`- Orçamentos consolidados num fechamento mas que saíram de "Concluído": ${consolidadoNaoConcluido.length}${consolidadoNaoConcluido.length ? ' — ' + consolidadoNaoConcluido.slice(0, 10).map(o => '#' + o.numero + ' (' + o.status + ')').join(', ') : ''}`);
// funcionários
const ativos = funcionarios.filter(f => f.status === 'ativo' || (!('status' in f) && f.ativo !== false));
const comPct = ativos.filter(f => A.percentualVigente(f, new Date()) > 0);
p(`- Funcionários ativos: ${ativos.length}; com % de comissão: ${comPct.length} (${comPct.map(f => `${f.nome} ${A.percentualVigente(f, new Date())}%`).join(', ')})`);
const recebemSemPct = [...new Set(comissoes.filter(c => { const o = porId[c.orcamentoId]; return o && A.dentroDoIntervalo(A.dataReferenciaOrcamento(o), atual.inicioStr, atual.fimStr); }).map(c => c.funcionarioId))].filter(id => { const f = funcionarios.find(x => x.id === id); return f && !(A.percentualVigente(f, new Date()) > 0); });
p(`- Com lançamentos no período atual mas sem % na ficha (não aparecem na Comissão): ${recebemSemPct.map(nome).join(', ') || 'nenhum'}`);
const inativosComPct = funcionarios.filter(f => !ativos.includes(f) && A.percentualVigente(f, new Date()) > 0);
p(`- Inativos/bloqueados ainda com %: ${inativosComPct.map(f => f.nome + ' (' + (f.status || '') + ')').join(', ') || 'nenhum'}`);
// regras
const vig = A.regrasVigentesEm(versoes, hoje);
p(`- Versões de regras: ${versoes.length}${versoes.length ? ' (vigências: ' + versoes.map(v => v.vigenciaInicio || v.vigencia || '?').join(', ') + ')' : ' — usando as regras PADRÃO do sistema'}`);
p(`- Regras em vigor: faixas ${vig.faixasFaturamento.filter(f => f.ativa !== false).map(f => `${moeda(f.min)}→${f.percentual}%`).join(' · ')}; garantia limite ${vig.garantia.limitePct}% (reduz ${vig.garantia.reducaoPct}%); atraso −${vig.atrasos.reducaoPct}% cada (máx ${vig.atrasos.limitePct}%, modo ${vig.atrasos.modo}); faltas: ${vig.faltas.tipos.map(t => `${t.nome}=${t.efeito}${t.descontoPct ? ' ' + t.descontoPct + '%' : ''}`).join(', ')}`);
// ocorrências
const ocs = registrosDocs.flatMap(d => (d.ocorrencias || []).map(o => ({ ...o, fid: d.funcionarioId })));
const antigas = registrosDocs.filter(d => Number(d.atrasos) > 0 || (d.faltas && Object.values(d.faltas).some(n => Number(n) > 0)) || d.faltaNaoJustificada);
p(`- Ocorrências: ${ocs.filter(o => !o.removido).length} ativas, ${ocs.filter(o => o.removido).length} removidas; contagens antigas sem data em ${antigas.length} doc(s)`);
const ocForaCal = ocs.filter(o => !o.removido && !cal.some(x => x.dataInicial <= o.data && o.data <= x.dataFinal));
p(`- Ocorrências com data fora de qualquer período cadastrado: ${ocForaCal.length}`);
const ocDepoisFech = ocs.filter(o => { if (o.removido) return false; const f = fechamentos.find(x => x.inicio <= o.data && o.data <= x.fim); if (!f || !f.fechadoEm) return false; const em = o.em && o.em.toDate ? o.em.toDate() : o.em ? new Date(o.em) : null; return em && em > f.fechadoEm.toDate(); });
p(`- Ocorrências lançadas DEPOIS do fechamento do período delas (não entram no valor fechado): ${ocDepoisFech.length}${ocDepoisFech.length ? ' — ' + ocDepoisFech.map(o => `${nome(o.fid)} ${o.data} ${o.nomeTipo || o.tipo}`).join('; ') : ''}`);
const ultimoHist = historico.map(h => h.data && h.data.toDate ? h.data.toDate() : (h.em ? new Date(h.em) : null)).filter(Boolean).sort((a, b) => b - a)[0];
p(`- Última movimentação no histórico da comissão: ${ultimoHist ? ultimoHist.toLocaleString('pt-BR') : '-'}`);
const relatorio = out.join('\n');
// cifra (AES-256-GCM + chave embrulhada com RSA-OAEP): só quem tem a chave privada lê
const chave = crypto.randomBytes(32), iv = crypto.randomBytes(12);
const c = crypto.createCipheriv('aes-256-gcm', chave, iv);
const dados = Buffer.concat([c.update(relatorio, 'utf8'), c.final()]);
const emb = crypto.publicEncrypt({ key: process.env.CHAVE_PUBLICA, oaepHash: 'sha256' }, chave);
fs.writeFileSync('relatorio.cifrado.json', JSON.stringify({ k: emb.toString('base64'), iv: iv.toString('base64'), t: c.getAuthTag().toString('base64'), d: dados.toString('base64') }));
console.log(`Relatório gerado (${relatorio.length} caracteres, cifrado).`);
