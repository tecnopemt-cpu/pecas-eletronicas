// Limpeza seletiva: remove SOMENTE atrasos/faltas da equipe (apuracaoRegistros), o histórico dessas
// ocorrências (comissaoHistorico tipo "ocorrencia"/"ajuste") e as notificações de ocorrência.
// Não toca em funcionários, clientes, peças, avisos, regras, percentuais nem períodos.
//   node backup/limpeza-ocorrencias.mjs --verificar | --executar
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { configFirebase, clienteFirestore } from './firestore-rest.mjs';
const require = createRequire(import.meta.url);
const T = require('./nucleo.js');
const executar = process.argv.includes('--executar');
const nota = (n, m) => console.log(process.env.GITHUB_ACTIONS ? `::${n}::${m}` : `[${n}] ${m}`);
const cli = clienteFirestore(configFirebase());
const PROTEGIDAS = ['clientes', 'catalogoPecas', 'funcionarios', 'avisos', 'config', 'periodosApuracao', 'regrasComissao', 'lotes', 'orcamentos', 'comissoes'];
const impressao = docs => crypto.createHash('sha256').update(T.jsonEstavel(Object.fromEntries(Object.entries(docs).map(([id, f]) => [id, T.assinaturaDocumento(f)])))).digest('hex').slice(0, 16);
const tipo = f => T.camposParaObjeto(f).tipo || '?';
async function estado() { const r = {}; for (const c of [...PROTEGIDAS, 'apuracaoRegistros', 'comissaoHistorico', 'notificacoes']) r[c] = await cli.listarDocumentos(c); return r; }
const antes = await estado();
const contar = docs => { const o = {}; Object.values(docs).forEach(f => { const t = tipo(f); o[t] = (o[t] || 0) + 1; }); return JSON.stringify(o); };
const exc = [
  ...Object.keys(antes.apuracaoRegistros).map(id => ['apuracaoRegistros', id]),
  ...Object.entries(antes.comissaoHistorico).filter(([, f]) => ['ocorrencia', 'ajuste'].includes(tipo(f))).map(([id]) => ['comissaoHistorico', id]),
  ...Object.entries(antes.notificacoes).filter(([, f]) => tipo(f) === 'ocorrencia').map(([id]) => ['notificacoes', id])
];
const prot = Object.fromEntries(PROTEGIDAS.map(c => [c, { q: Object.keys(antes[c]).length, h: impressao(antes[c]) }]));
const ficaHist = Object.entries(antes.comissaoHistorico).filter(([, f]) => !['ocorrencia', 'ajuste'].includes(tipo(f)));
const ficaNot = Object.entries(antes.notificacoes).filter(([, f]) => tipo(f) !== 'ocorrencia');
nota('notice', `SERÁ EXCLUÍDO → atrasos/faltas (apuracaoRegistros): ${Object.keys(antes.apuracaoRegistros).length} · histórico de ocorrências/ajustes: ${exc.filter(e => e[0] === 'comissaoHistorico').length} (histórico por tipo ${contar(antes.comissaoHistorico)}) · notificações de ocorrência: ${exc.filter(e => e[0] === 'notificacoes').length} (notificações por tipo ${contar(antes.notificacoes)})`);
nota('notice', `NÃO SERÁ TOCADO → ${PROTEGIDAS.map(c => `${c}: ${prot[c].q}`).join(' · ')} · histórico restante: ${ficaHist.length} · outras notificações: ${ficaNot.length}`);
if (!executar) { nota('notice', 'Modo verificação: nada foi excluído.'); process.exit(0); }
await cli.gravar(exc.map(([c, id]) => cli.escritaApagar(c, id)));
const depois = await estado();
const erros = [];
if (Object.keys(depois.apuracaoRegistros).length) erros.push('ainda há registros de atrasos/faltas');
if (Object.values(depois.comissaoHistorico).some(f => ['ocorrencia', 'ajuste'].includes(tipo(f)))) erros.push('ainda há histórico de ocorrências');
if (Object.values(depois.notificacoes).some(f => tipo(f) === 'ocorrencia')) erros.push('ainda há notificações de ocorrência');
if (Object.keys(depois.comissaoHistorico).length !== ficaHist.length || Object.keys(depois.notificacoes).length !== ficaNot.length) erros.push('histórico/notificações restantes mudaram');
PROTEGIDAS.forEach(c => { if (Object.keys(depois[c]).length !== prot[c].q || impressao(depois[c]) !== prot[c].h) erros.push(`${c} mudou`); });
if (erros.length) { nota('error', 'Conferência: ' + erros.join('; ')); process.exit(1); }
nota('notice', `CONFERIDO → atrasos/faltas: 0 · histórico de ocorrências: 0 · notificações de ocorrência: 0 · histórico restante: ${ficaHist.length} (idêntico) · ${PROTEGIDAS.map(c => `${c}: ${prot[c].q} (idêntico)`).join(' · ')}`);
