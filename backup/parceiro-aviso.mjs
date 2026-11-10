// Comissão do Parceiro — aviso do último dia útil do mês (rotina "Comissão do parceiro: aviso" do GitHub).
// Roda nos dias úteis; no último dia útil do mês, para cada parceiro ativo, calcula a situação do mês
// (mesma regra da tela: as funções são lidas do próprio index.html) e cria um aviso no 🔔 do Master e dos
// administradores: quantos orçamentos há no período, quantos concluídos, quantos pendentes, e se o
// fechamento está liberado ou bloqueado. NÃO fecha nem paga nada (isso depende do Master no sistema).
// Um aviso por pessoa, parceiro e mês (não repete). O registro é público: só contagens.
import { configFirebase, clienteFirestore } from './firestore-rest.mjs';
import { tipado } from './medir-banco.mjs';
import { carregarRegrasDoSite } from './regras-do-site.mjs';
import { desCampos, diaBr } from './arquivamento.mjs';

export const FUNCOES = ['parcApurar', 'parcUltimoDiaUtil', 'parcVigente', 'parcPercentual', 'parcCent', 'parcDiaDe', 'parcMesNome', 'testeReprovado', 'dataDe', 'chaveDia', 'formatarDataInput'];
export const CONSTANTES = ['PARC_STATUS_APROVADO', 'PARC_MESES'];
const log = m => console.log(m);

export function textoAviso(nome, ap, regras) {
  return `Comissão do parceiro ${nome}: conferir o fechamento de ${regras.parcMesNome(ap.mes)}. ${ap.elegiveis.length} orçamento(s) no período: ${ap.concluidos.length} concluído(s), ${ap.pendentes.length} pendente(s). Fechamento ${ap.fechamento ? 'já realizado' : ap.pendentes.length || !ap.elegiveis.length ? 'bloqueado' : 'liberado'}.`;
}

async function principal() {
  const forcar = /^(1|true|sim)$/i.test(process.env.FORCAR || '');
  const regras = carregarRegrasDoSite(FUNCOES, CONSTANTES);
  const hoje = diaBr(new Date());
  const mes = hoje.slice(0, 7);
  const ultimo = regras.parcUltimoDiaUtil(mes);
  if (hoje !== ultimo && !forcar) { log(`Hoje (${hoje}) não é o último dia útil do mês (${ultimo}). Nada a fazer.`); return; }
  const cli = clienteFirestore(configFirebase());
  const lista = o => Object.entries(o).map(([id, f]) => ({ id, ...desCampos(f) }));
  const [parceiros, fechamentos, funcionarios] = await Promise.all([cli.listarDocumentos('parceiros'), cli.listarDocumentos('parceiroFechamentos'), cli.listarDocumentos('funcionarios')].map(p => p.then(lista)));
  const destino = funcionarios.filter(f => ['master', 'administrador'].includes(f.perfil) && (f.status === 'ativo' || (!f.status && f.ativo !== false)));
  let avisos = 0, repetidos = 0;
  for (const p of parceiros.filter(x => x.ativo !== false)) {
    const orcs = [];
    for (const cid of Object.keys(p.indicados || {})) orcs.push(...(await cli.consultarTudo('orcamentos', 'clienteId', cid)).map(d => ({ id: d.id, ...desCampos(d.fields) })));
    const ap = regras.parcApurar(p, orcs, mes, fechamentos, hoje);
    log(`Parceiro: ${ap.elegiveis.length} orçamento(s) no mês, ${ap.concluidos.length} concluído(s), ${ap.pendentes.length} pendente(s); fechamento ${ap.liberado ? 'liberado' : ap.bloqueio}.`);
    const texto = textoAviso(p.nome || 'parceiro', ap, regras);
    for (const f of destino) {
      const id = `parceiro_${p.id}_${mes}_${f.id}`.replace(/[^A-Za-z0-9_-]/g, '-');
      try {
        await cli.commit([{ update: { name: cli.nomeDoc('notificacoes', id), fields: { funcionarioId: tipado(f.id), tipo: tipado('parceiro'), texto: tipado(texto), lida: tipado(false), parceiroId: tipado(p.id), mes: tipado(mes) } }, updateTransforms: [{ fieldPath: 'criadoEm', setToServerValue: 'REQUEST_TIME' }], currentDocument: { exists: false } }]);
        avisos++;
      } catch (e) {
        if (e.status === 409 || /already exists|ALREADY_EXISTS|precondition/i.test(e.message)) { repetidos++; continue; }
        if (e.status === 403) { log('::warning::Comissão do parceiro: o banco recusou o aviso — publique as regras novas do banco (seguranca/firestore.rules).'); process.exit(0); }
        throw e;
      }
    }
  }
  log(`::notice::Comissão do parceiro: ${avisos} aviso(s) criado(s), ${repetidos} já existiam (${parceiros.length} parceiro(s)).`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  principal().catch(e => { console.log(`::error::Aviso da comissão do parceiro falhou: ${String(e.message || e).slice(0, 300)}`); process.exit(1); });
}
