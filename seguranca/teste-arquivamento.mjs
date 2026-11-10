// Testes da regra de arquivamento automático (sem banco): os 8 cenários pedidos + limites do período.
// A regra testada é a do próprio index.html (a mesma que as telas e a rotina usam).
import { planejar, escritasArquivar, escritasReativar, FUNCOES, CONSTANTES } from '../backup/arquivamento.mjs';
import { carregarRegrasDoSite } from '../backup/regras-do-site.mjs';

process.env.TZ = 'America/Sao_Paulo';
const R = carregarRegrasDoSite(FUNCOES, CONSTANTES);
let ok = 0, falhas = 0;
const passo = (nome, cond, det) => { if (cond) { ok++; console.log('OK     ' + nome); } else { falhas++; console.log('FALHOU ' + nome + (det ? ' — ' + det : '')); console.log(`::error::Arquivamento: ${nome}`); } };

// calendário da Comissão: período atual 21/10 a 20/11/2026 (cadastrado), anterior 21/09 a 20/10
const CAL = R.montarCalendario([{ id: 'p0', dataInicial: '2026-09-21', dataFinal: '2026-10-20' }, { id: 'p1', dataInicial: '2026-10-21', dataFinal: '2026-11-20' }], []);
const HOJE = new Date('2026-11-10T15:00:00-03:00');
const itens = [{ quantidade: 2, qtdConsertada: 2, qtdConsertadaOrcada: 2 }];
const lote = (id, extra = {}) => ({ id, numero: Number(id.replace(/\D/g, '')) || 1, status: 'Concluído', itens, arquivado: false, updateTime: 'v-' + id, ...extra });
const fat = dia => new Date(dia + 'T14:30:00-03:00');
const orc = (id, loteId, extra = {}) => ({ id, numero: 'RP-' + id, loteId, status: 'Concluído', dataFaturamento: fat('2026-10-05'), dataConclusao: fat('2026-10-05'), arquivado: false, updateTime: 'v-' + id, ...extra });
const plano = (grupos, agora = HOJE) => planejar(grupos, CAL, R, agora);
const ids = p => p.arquivar.flatMap(i => [...(i.lote ? [i.lote.id] : []), ...i.orcamentos.map(o => o.id)]).sort().join(',');

let p = plano([{ chave: 'L1', lote: lote('L1'), orcamentos: [orc('O1', 'L1')] }]);
passo('cenário 1: entrada com um orçamento concluído e fora do período → arquiva os dois', ids(p) === 'L1,O1', ids(p));
p = plano([{ chave: 'L2', lote: lote('L2'), orcamentos: [orc('O2', 'L2'), orc('O3', 'L2', { dataFaturamento: fat('2026-09-25') })] }]);
passo('cenário 2: dois orçamentos concluídos e fora do período → arquiva a entrada e os dois', ids(p) === 'L2,O2,O3', ids(p));
p = plano([{ chave: 'L3', lote: lote('L3'), orcamentos: [orc('O4', 'L3'), orc('O5', 'L3', { status: 'Rota', dataFaturamento: null })] }]);
passo('cenário 3: um concluído e outro pendente → não arquiva nenhum dos três', p.arquivar.length === 0 && p.pendentes === 1);
p = plano([{ chave: 'L4', lote: lote('L4'), orcamentos: [orc('O6', 'L4'), orc('O7', 'L4', { dataFaturamento: fat('2026-11-03') })] }]);
passo('cenário 4: um dos concluídos dentro do período atual → nada arquivado', p.arquivar.length === 0);
p = plano([{ chave: 'L5', lote: lote('L5', { status: 'Em análise', itens: [{ quantidade: 3, qtdConsertada: 2, qtdConsertadaOrcada: 2 }] }), orcamentos: [orc('O8', 'L5')] }]);
passo('cenário 5: orçamentos concluídos mas entrada não finalizada → nada arquivado', p.arquivar.length === 0);
p = plano([{ chave: 'L5b', lote: lote('L5b', { itens: [{ quantidade: 3, qtdConsertada: 3, qtdConsertadaOrcada: 2 }] }), orcamentos: [orc('O8b', 'L5b')] }]);
passo('cenário 5b: entrada marcada Concluído mas com peças sem orçamento → nada arquivado', p.arquivar.length === 0);
const g6 = () => [{ chave: 'L6', lote: lote('L6'), orcamentos: [orc('O9', 'L6', { dataFaturamento: fat('2026-11-02') }), orc('O10', 'L6', { dataFaturamento: fat('2026-11-09') })] }];
p = plano(g6());
passo('cenário 6: tudo concluído, mas dentro do período de apuração → todos ativos', p.arquivar.length === 0 && p.pendentes === 1);
p = plano(g6(), new Date('2026-11-21T00:20:00-03:00'));
passo('cenário 7: o período é encerrado (virada para 21/11) → arquiva a entrada e todos os orçamentos', ids(p) === 'L6,O10,O9', ids(p));
// cenário 8: conjunto arquivado pela rotina; o O12 é reaberto (desarquivado hoje)
const arqAuto = { arquivado: true, arquivamentoAutomatico: true, dataArquivamento: '2026-11-01T03:00:00Z' };
p = plano([{ chave: 'L7', lote: lote('L7', arqAuto), orcamentos: [orc('O11', 'L7', arqAuto), orc('O12', 'L7', { arquivamentoReabertoEm: '2026-11-10' })] }]);
passo('cenário 8: orçamento arquivado é reaberto → a entrada volta para a área ativa (e o orçamento não é rearquivado no mesmo período)', p.arquivar.length === 0 && p.reativar.length === 1 && p.reativar[0].lote.id === 'L7');
p = plano([{ chave: 'L7', lote: lote('L7', arqAuto), orcamentos: [orc('O11', 'L7', arqAuto), orc('O12', 'L7', { status: 'Em Análise', dataFaturamento: null })] }]);
passo('cenário 8b: orçamento reaberto volta a ficar pendente → entrada reativada', p.reativar.length === 1);
p = plano([{ chave: 'L7', lote: lote('L7', { arquivado: false, arquivamentoReabertoEm: '2026-11-10' }), orcamentos: [orc('O11', 'L7', arqAuto), orc('O12', 'L7', { arquivamentoReabertoEm: '2026-11-10' })] }], new Date('2026-11-21T00:20:00-03:00'));
passo('cenário 8c: depois da virada do período, o conjunto reaberto (e já corrigido) volta a ser arquivado', ids(p) === 'L7,O12', ids(p));
// limites exatos do período
p = plano([{ chave: 'L8', lote: lote('L8'), orcamentos: [orc('O13', 'L8', { dataFaturamento: fat('2026-10-21') })] }]);
passo('limite: faturado no 1º dia do período atual (21/10) → continua ativo', p.arquivar.length === 0);
p = plano([{ chave: 'L9', lote: lote('L9'), orcamentos: [orc('O14', 'L9', { dataFaturamento: new Date('2026-10-20T23:59:00-03:00') })] }]);
passo('limite: faturado no último dia do período anterior (20/10, 23:59) → arquiva', ids(p) === 'L9,O14', ids(p));
p = plano([{ chave: 'L10', lote: lote('L10'), orcamentos: [orc('O15', 'L10', { dataFaturamento: null, dataConclusao: fat('2026-09-01') })] }]);
passo('sem data de faturamento oficial (só conclusão) → continua ativo', p.arquivar.length === 0);
p = plano([{ chave: 'L11', lote: lote('L11'), orcamentos: [orc('O16', 'L11'), orc('O17', 'L11', { status: 'Teste', dataFaturamento: null, observacoes: 'faturado em 01/10' })] }]);
passo('cópia/divisão em Teste ligada à mesma entrada segura o conjunto inteiro', p.arquivar.length === 0);
p = plano([{ chave: 'L12', lote: lote('L12'), orcamentos: [orc('O18', 'L12'), orc('O19', 'L12', { arquivado: true, status: 'Pendente orçamento', dataFaturamento: null })] }]);
passo('orçamento arquivado à mão fora de Concluído (ex.: cancelado) não segura o conjunto', ids(p) === 'L12,O18', ids(p));
p = plano([{ chave: 'L13', lote: lote('L13'), orcamentos: [] }]);
passo('entrada sem nenhum orçamento vinculado → não arquiva automaticamente', p.arquivar.length === 0);
p = plano([{ chave: 'orc:O20', lote: null, orcamentos: [orc('O20', null)] }]);
passo('orçamento sem entrada, concluído e fora do período → arquiva sozinho', ids(p) === 'O20');
p = plano([{ chave: 'L14', lote: lote('L14', { arquivado: true, arquivamentoAutomatico: false }), orcamentos: [orc('O21', 'L14')] }]);
passo('entrada já arquivada à mão: arquiva o orçamento que faltava (sem mexer na entrada)', ids(p) === 'O21', ids(p));
p = plano([{ chave: 'L15', lote: lote('L15', arqAuto), orcamentos: [orc('O22', 'L15', arqAuto)] }]);
passo('conjunto todo já arquivado → nada a fazer', p.arquivar.length === 0 && p.reativar.length === 0 && p.pendentes === 0);
// escritas: só campos de arquivamento, status intacto, pré-condição em todos, histórico preservado (append)
const nomeDoc = (c, id) => `x/${c}/${id}`;
const w = escritasArquivar(plano(g6(), new Date('2026-11-21T00:20:00-03:00')).arquivar[0], nomeDoc, R, HOJE);
const masks = w.flatMap(x => x.updateMask.fieldPaths);
passo('gravação atômica: 1 commit com a entrada e todos os orçamentos, cada um com pré-condição de versão', w.length === 3 && w.every(x => x.currentDocument && x.currentDocument.updateTime));
passo('gravação: não toca em status, faturamento, fotos ou assinaturas (só campos de arquivamento)', !masks.some(m => /^(status|dataFaturamento|dataConclusao|valor|itens|fotos?|assinatura.*|observac.*)$/.test(m)) && masks.includes('motivoArquivamento') && masks.includes('dataArquivamento'));
passo('gravação: histórico só recebe uma linha nova (não apaga o anterior)', w.filter(x => x.update.name.includes('/orcamentos/')).every(x => x.updateTransforms[0].fieldPath === 'historico' && x.updateTransforms[0].appendMissingElements.values.length === 1));
passo('gravação: vínculo mantido (mesmo conjunto em todos)', w.every(x => x.update.fields.arquivamentoConjuntoId.stringValue === 'L6'));
const wr = escritasReativar(plano([{ chave: 'L7', lote: lote('L7', arqAuto), orcamentos: [orc('O11', 'L7', arqAuto), orc('O12', 'L7', { arquivamentoReabertoEm: '2026-11-10' })] }]).reativar[0], nomeDoc, R, HOJE);
passo('reativação: só a entrada, sem mudar o status, com o motivo no histórico', wr.length === 1 && !wr[0].updateMask.fieldPaths.includes('status') && wr[0].update.fields.arquivado.booleanValue === false && /RP-O12/.test(wr[0].update.fields.reativadoMotivo.stringValue));

console.log(`\n${ok}/${ok + falhas} verificações do arquivamento automático ${falhas ? 'com FALHAS' : 'OK'}`);
process.exit(falhas ? 1 : 0);
