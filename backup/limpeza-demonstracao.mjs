// Limpeza seletiva para demonstração: zera SOMENTE Entradas de Peças, Orçamentos e os lançamentos de
// comissão que vêm deles. Não toca em Clientes, Cadastro de Peças, Equipe, Avisos nem configurações.
//   node backup/limpeza-demonstracao.mjs --verificar      → só mostra o que seria excluído (não apaga nada)
//   node backup/limpeza-demonstracao.mjs --executar       → exclui e confere o resultado
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { configFirebase, clienteFirestore } from './firestore-rest.mjs';
const require = createRequire(import.meta.url);
const T = require('./nucleo.js');
const executar = process.argv.includes('--executar');
const gh = !!process.env.GITHUB_ACTIONS;
const nota = (nivel, m) => console.log(gh ? `::${nivel}::${m}` : `[${nivel}] ${m}`);
const cli = clienteFirestore(configFirebase());

// Coleções que NÃO podem mudar (conferidas antes e depois por um código de verificação do conteúdo)
const PROTEGIDAS = ['clientes', 'catalogoPecas', 'funcionarios', 'avisos', 'config', 'periodosApuracao', 'regrasComissao', 'apuracaoRegistros', 'notificacoes'];
// Histórico de comissão que deriva de orçamentos (fechamento/pagamento de períodos); o resto (regras,
// percentuais da equipe, períodos, atrasos/faltas) é configuração e fica.
const TIPOS_HIST_DERIVADOS = ['fechamento', 'recalculo', 'reabertura', 'pagamento'];

const impressao = docs => crypto.createHash('sha256').update(T.jsonEstavel(Object.fromEntries(Object.entries(docs).map(([id, f]) => [id, T.assinaturaDocumento(f)])))).digest('hex').slice(0, 16);
async function ler(c) { return cli.listarDocumentos(c); }

async function estado() {
  const r = {};
  for (const c of [...PROTEGIDAS, 'lotes', 'orcamentos', 'comissoes', 'comissaoFechamentos', 'comissaoHistorico']) r[c] = await ler(c);
  return r;
}
function plano(e) {
  const idsOrc = new Set(Object.keys(e.orcamentos));
  // todo lançamento de comissão nasce de um orçamento; como todos os orçamentos saem, saem todos os
  // lançamentos (inclusive os que já apontavam para orçamentos apagados antes)
  const comissoes = Object.keys(e.comissoes);
  const orfaos = Object.values(e.comissoes).filter(f => !idsOrc.has(String(T.camposParaObjeto(f).orcamentoId))).length;
  const fech = Object.keys(e.comissaoFechamentos);
  const hist = Object.entries(e.comissaoHistorico).filter(([, f]) => TIPOS_HIST_DERIVADOS.includes(T.camposParaObjeto(f).tipo)).map(([id]) => id);
  return { lotes: Object.keys(e.lotes), orcamentos: [...idsOrc], comissoes, orfaos, comissaoFechamentos: fech, comissaoHistorico: hist };
}

const antes = await estado();
const p = plano(antes);
const protegidasAntes = Object.fromEntries(PROTEGIDAS.map(c => [c, { qtd: Object.keys(antes[c]).length, id: impressao(antes[c]) }]));
const tiposHist = {};
Object.values(antes.comissaoHistorico).forEach(f => { const t = T.camposParaObjeto(f).tipo || '?'; tiposHist[t] = (tiposHist[t] || 0) + 1; });
nota('notice', `SERÁ EXCLUÍDO → Entradas: ${p.lotes.length} · Orçamentos: ${p.orcamentos.length} · Lançamentos de comissão: ${p.comissoes.length} (de ${Object.keys(antes.comissoes).length}; ${p.orfaos} já sem orçamento) · Fechamentos de período: ${p.comissaoFechamentos.length} · Histórico de fechamento/pagamento: ${p.comissaoHistorico.length} (histórico total ${Object.keys(antes.comissaoHistorico).length}: ${JSON.stringify(tiposHist)})`);
nota('notice', `NÃO SERÁ TOCADO → ${PROTEGIDAS.map(c => `${c}: ${protegidasAntes[c].qtd}`).join(' · ')}`);
// garantia: nada do plano pertence a uma coleção protegida
const exclusoes = [...p.lotes.map(id => ['lotes', id]), ...p.orcamentos.map(id => ['orcamentos', id]), ...p.comissoes.map(id => ['comissoes', id]), ...p.comissaoFechamentos.map(id => ['comissaoFechamentos', id]), ...p.comissaoHistorico.map(id => ['comissaoHistorico', id])];
if (exclusoes.some(([c]) => PROTEGIDAS.includes(c))) { nota('error', 'Plano inválido: tentaria excluir algo protegido. Nada foi feito.'); process.exit(1); }

if (!executar) { nota('notice', 'Modo verificação: nada foi excluído.'); process.exit(0); }

await cli.gravar(exclusoes.map(([c, id]) => cli.escritaApagar(c, id)), (f, t) => console.log(`excluindo ${f}/${t}`));

// conferência final
const depois = await estado();
const erros = [];
if (Object.keys(depois.lotes).length) erros.push(`ainda há ${Object.keys(depois.lotes).length} entrada(s)`);
if (Object.keys(depois.orcamentos).length) erros.push(`ainda há ${Object.keys(depois.orcamentos).length} orçamento(s)`);
if (Object.keys(depois.comissoes).length) erros.push(`ainda há ${Object.keys(depois.comissoes).length} lançamento(s) de comissão`);
PROTEGIDAS.forEach(c => { const d = { qtd: Object.keys(depois[c]).length, id: impressao(depois[c]) }; if (d.qtd !== protegidasAntes[c].qtd || d.id !== protegidasAntes[c].id) erros.push(`${c} mudou (${protegidasAntes[c].qtd} → ${d.qtd})`); });
if (erros.length) { nota('error', 'Conferência: ' + erros.join('; ')); process.exit(1); }
nota('notice', `CONFERIDO → Entradas: 0 · Orçamentos: 0 · Lançamentos de comissão: 0 · ${PROTEGIDAS.map(c => `${c}: ${protegidasAntes[c].qtd} (idêntico)`).join(' · ')}`);
