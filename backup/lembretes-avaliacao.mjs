// Lembretes da Avaliação de Desempenho (rodam no GitHub, todo dia, mesmo com o site fechado).
// Lê o banco com a conta da rotina de backup (só leitura) e devolve a lista do que precisa de atenção.
// Nenhum texto de registro ou avaliação vai para o aviso: só nomes, quantidades e prazos.

const ATIVO = f => f && (f.status === 'ativo' || (!('status' in f) && f.ativo !== false));
const trimestreDe = d => { const [a, m] = d.split('-').map(Number); return `${a}-T${Math.floor((m - 1) / 3) + 1}`; };
const anterior = t => { const [a, n] = t.split('-T').map(Number); return n === 1 ? `${a - 1}-T4` : `${a}-T${n - 1}`; };
const fimDo = t => { const [a, n] = t.split('-T').map(Number); const mf = n * 3; return `${a}-${String(mf).padStart(2, '0')}-${new Date(Date.UTC(a, mf, 0)).getUTCDate()}`; };
const rotulo = t => { const [a, n] = t.split('-T'); return `${n}º trimestre de ${a}`; };
const br = d => d.split('-').reverse().join('/');
const diasEntre = (a, b) => Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 864e5);
export const hojeBrasil = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });

// dados: { funcionarios: {id: ficha}, registros: {id: doc}, avaliacoes: {id: doc}, metas: {id: doc}, config: doc|null }
export function calcularLembretes(dados, hoje = hojeBrasil()) {
  const cfg = dados.config || {};
  if (cfg.lembretesAtivos === false) return [];
  // módulo ainda não usado (sem configuração e sem nenhum registro): não lembra nada
  if (!dados.config && !Object.keys(dados.registros || {}).length) return [];
  const avaliaveis = Object.entries(dados.funcionarios || {}).filter(([, f]) => ATIVO(f) && f.perfil !== 'master').map(([id, f]) => ({ id, nome: f.nome || id }));
  if (!avaliaveis.length) return [];
  const regs = Object.values(dados.registros || {}).filter(r => r.status !== 'removido');
  const avs = dados.avaliacoes || {};
  const out = [];
  const tri = trimestreDe(hoje), triAnt = anterior(tri);
  // 1) fim do trimestre chegando
  const faltam = diasEntre(hoje, fimDo(tri));
  if (faltam >= 0 && faltam <= 7) out.push({ chave: `fim-${tri}`, texto: `O ${rotulo(tri)} termina em ${br(fimDo(tri))} (${faltam} dia(s)). Revise se os registros do período estão completos antes de gerar as avaliações.` });
  // 2) avaliações do trimestre anterior pendentes
  const pend = avaliaveis.filter(f => { const a = avs[`${f.id}_${triAnt}`]; return !a || a.status === 'rascunho' || a.status === 'em_revisao'; });
  if (pend.length) out.push({ chave: `pendentes-${triAnt}-${pend.map(f => f.id).sort().join(',')}`, texto: `Avaliações do ${rotulo(triAnt)} ainda não aprovadas (${pend.length}): ${pend.map(f => f.nome).join(', ')}.` });
  // 3) aprovadas há mais de 15 dias sem feedback
  const semFb = Object.values(avs).filter(a => a.status === 'aprovada' && a.aprovadaEm && diasEntre(String(a.aprovadaEm).slice(0, 10), hoje) > 15);
  if (semFb.length) out.push({ chave: `feedback-${semFb.map(a => a.funcionarioId + a.trimestre).sort().join(',')}`, texto: `Avaliações aprovadas há mais de 15 dias sem o feedback registrado: ${semFb.map(a => `${a.funcionarioNome || a.funcionarioId} (${rotulo(a.trimestre)})`).join(', ')}.` });
  // 4) metas atrasadas
  const atrasadas = Object.values(dados.metas || {}).filter(m => m.prazo && m.prazo < hoje && ['Não iniciada', 'Em andamento'].includes(m.status) && avaliaveis.some(f => f.id === m.funcionarioId));
  if (atrasadas.length) out.push({ chave: `metas-${atrasadas.map(m => m.funcionarioId + m.prazo).sort().join(',')}`, texto: `Metas com prazo vencido (${atrasadas.length}): ${atrasadas.map(m => `${m.funcionarioNome || m.funcionarioId} — prazo ${br(m.prazo)}`).join('; ')}.` });
  // 5) ninguém registrou nada sobre a pessoa nos últimos 7 dias (só nos dias úteis, para não repetir no fim de semana)
  const dia = new Date(hoje + 'T12:00:00Z').getUTCDay();
  if (dia >= 1 && dia <= 5) {
    const sem = avaliaveis.filter(f => !regs.some(r => r.funcionarioId === f.id && diasEntre(r.dataOcorrido || '1970-01-01', hoje) <= 7));
    if (sem.length) out.push({ chave: `sem-registro-${sem.map(f => f.id).sort().join(',')}`, texto: `Sem registros de desempenho nos últimos 7 dias: ${sem.map(f => f.nome).join(', ')}. (Isso não indica desempenho bom nem ruim — é só um lembrete para registrar.)` });
  }
  return out;
}

// Firestore REST (valores tipados) → objetos comuns
export function deTipado(v) {
  if (!v || typeof v !== 'object') return v;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(deTipado);
  if ('mapValue' in v) return campos(v.mapValue.fields || {});
  return null;
}
export const campos = f => Object.fromEntries(Object.entries(f || {}).map(([k, x]) => [k, deTipado(x)]));
export async function lerDadosAvaliacao(fsCli) {
  const col = async c => Object.fromEntries(Object.entries(await fsCli.listarDocumentos(c)).map(([id, f]) => [id, campos(f)]));
  const [funcionarios, registros, avaliacoes, metas, configs] = await Promise.all(['funcionarios', 'avaliacaoRegistros', 'avaliacoesTrimestrais', 'avaliacaoMetas', 'avaliacaoConfig'].map(col));
  return { funcionarios, registros, avaliacoes, metas, config: configs.geral || null };
}
