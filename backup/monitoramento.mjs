// Central de Monitoramento — coleta diária fora do site (GitHub Actions, rotina "Central de Monitoramento").
// Grava em monitoramento/ (só o Master lê; só a conta da rotina grava). Não apaga nem altera nada do sistema.
//  1. Firestore (métricas OFICIAIS do Google Cloud Monitoring): leituras, gravações e exclusões por dia.
//     Precisa do segredo GCP_MONITORAMENTO_CHAVE (conta de serviço só com "Leitor do Monitoring").
//     Sem ele: grava "indisponível" com o motivo — nunca inventa número.
//  2. GitHub: tamanho do repositório, backups (índice do ramo backups), execuções e falhas das rotinas,
//     publicação do site (GitHub Pages).
//  3. Saúde: o site responde? quanto tempo leva? o banco responde?
// O registro desta rotina é público (repositório público): só contagens, nada de dados ou segredos.
import crypto from 'node:crypto';
import { configFirebase, clienteFirestore } from './firestore-rest.mjs';
import { gravarMonitoramento } from './medir-banco.mjs';
import { campos } from './lembretes-avaliacao.mjs';

const REPO = process.env.GITHUB_REPOSITORY || 'tecnopemt-cpu/pecas-eletronicas';
const SITE = process.env.SITE_URL || 'https://tecnopemt-cpu.github.io/pecas-eletronicas/';
const GH = process.env.GITHUB_API || 'https://api.github.com';
const DIAS_OPERACOES = 35;
const diaBr = d => new Date(d).toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
const diaPacifico = d => new Date(d).toLocaleDateString('sv-SE', { timeZone: 'America/Los_Angeles' });
const log = m => console.log(m);

async function gh(caminho, opcoes = {}) {
  const r = await fetch(`${GH}${caminho}`, { ...opcoes, headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${process.env.GITHUB_TOKEN || ''}`, 'x-github-api-version': '2022-11-28', ...(opcoes.headers || {}) } });
  const corpo = await r.text();
  let j = null; try { j = JSON.parse(corpo); } catch (e) {}
  return { ok: r.ok, status: r.status, json: j, texto: corpo };
}

// ---- 1. Cloud Monitoring (oficial)
async function tokenGoogle(chave) {
  const agora = Math.floor(Date.now() / 1000);
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const corpo = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: chave.client_email, scope: 'https://www.googleapis.com/auth/monitoring.read https://www.googleapis.com/auth/cloud-billing.readonly', aud: chave.token_uri || 'https://oauth2.googleapis.com/token', iat: agora, exp: agora + 3600 })}`;
  const assinatura = crypto.createSign('RSA-SHA256').update(corpo).sign(chave.private_key, 'base64url');
  const r = await fetch(chave.token_uri || 'https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${corpo}.${assinatura}` });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw Object.assign(new Error('a chave do monitoramento foi recusada pelo Google'), { status: r.status });
  return j.access_token;
}
async function serie(token, projeto, metrica, agruparPor) {
  const fim = new Date(), ini = new Date(Date.now() - DIAS_OPERACOES * 864e5);
  const p = new URLSearchParams({ filter: `metric.type="firestore.googleapis.com/document/${metrica}"`, 'interval.startTime': ini.toISOString(), 'interval.endTime': fim.toISOString(), 'aggregation.alignmentPeriod': '3600s', 'aggregation.perSeriesAligner': 'ALIGN_SUM', 'aggregation.crossSeriesReducer': 'REDUCE_SUM' });
  if (agruparPor) p.append('aggregation.groupByFields', agruparPor);
  const pontos = [];
  let pagina = '';
  do {
    const r = await fetch(`https://monitoring.googleapis.com/v3/projects/${projeto}/timeSeries?${p}${pagina ? `&pageToken=${pagina}` : ''}`, { headers: { authorization: `Bearer ${token}` } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      // motivo dado pelo Google (sem dados nem segredos): API desativada, papel ausente etc.
      const er = j.error || {}, info = (er.details || []).find(x => x.reason) || {};
      const motivo = info.reason === 'SERVICE_DISABLED' || /has not been used|is disabled/i.test(er.message || '') ? 'a Cloud Monitoring API não está ativada no projeto (ou acabou de ser ativada: aguarde alguns minutos)'
        : r.status === 403 ? `a conta de serviço não tem o papel “Visualizador de monitoramento” neste projeto (ou o papel acabou de ser dado: aguarde alguns minutos) [${info.reason || er.status || 403}]`
          : `o Cloud Monitoring respondeu com erro ${r.status} [${info.reason || er.status || ''}]`;
      throw Object.assign(new Error(motivo), { status: r.status });
    }
    for (const ts of j.timeSeries || []) {
      const rotulo = agruparPor ? ((ts.metric || {}).labels || {})[agruparPor.split('.').pop()] || '' : '';
      for (const pt of ts.points || []) pontos.push({ inicio: pt.interval.startTime || new Date(Date.parse(pt.interval.endTime) - 3600e3).toISOString(), valor: Number(pt.value.int64Value || pt.value.doubleValue || 0), rotulo });
    }
    pagina = j.nextPageToken || '';
  } while (pagina);
  return pontos;
}
// bytes trafegados pela API do Firestore (métrica oficial de "APIs consumidas" do projeto): respostas = dados
// que saíram do Firestore para os aparelhos; pedidos = dados enviados a ele. Distribuição → soma = contagem × média.
async function serieBytes(token, projeto, metrica) {
  const fim = new Date(), ini = new Date(Date.now() - DIAS_OPERACOES * 864e5);
  const p = new URLSearchParams({ filter: `metric.type="serviceruntime.googleapis.com/api/${metrica}" AND resource.type="consumed_api" AND resource.labels.service="firestore.googleapis.com"`, 'interval.startTime': ini.toISOString(), 'interval.endTime': fim.toISOString(), 'aggregation.alignmentPeriod': '3600s', 'aggregation.perSeriesAligner': 'ALIGN_DELTA', 'aggregation.crossSeriesReducer': 'REDUCE_SUM' });
  const pontos = [];
  let pagina = '';
  do {
    const r = await fetch(`https://monitoring.googleapis.com/v3/projects/${projeto}/timeSeries?${p}${pagina ? `&pageToken=${pagina}` : ''}`, { headers: { authorization: `Bearer ${token}` } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(`o Cloud Monitoring respondeu com erro ${r.status} para ${metrica}`), { status: r.status });
    for (const ts of j.timeSeries || []) for (const pt of ts.points || []) { const d = pt.value.distributionValue || {}; pontos.push({ inicio: pt.interval.startTime || new Date(Date.parse(pt.interval.endTime) - 3600e3).toISOString(), valor: Number(d.count || 0) * Number(d.mean || 0) }); }
    pagina = j.nextPageToken || '';
  } while (pagina);
  return pontos;
}
// faturamento do projeto (o Google diz se há conta de faturamento ligada; sem ela, o custo é zero)
async function coletarFaturamento(token, projeto) {
  const r = await fetch(`https://cloudbilling.googleapis.com/v1/projects/${projeto}/billingInfo`, { headers: { authorization: `Bearer ${token}` } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return { disponivel: false, motivo: r.status === 403 ? 'a conta de serviço não tem o papel “Navegador” ou a Cloud Billing API não está ativada no projeto' : `o Google respondeu com erro ${r.status}` };
  return { disponivel: true, faturamentoAtivo: !!j.billingEnabled, conta: j.billingAccountName ? 'ligada' : 'nenhuma', verificadoEm: new Date().toISOString() };
}
export async function coletarOperacoes(projeto, chave) {
  if (chave.project_id && chave.project_id !== projeto) throw new Error(`a chave foi criada em outro projeto do Google Cloud (“${chave.project_id}”); ela precisa ser do projeto “${projeto}”`);
  const token = await tokenGoogle(chave);
  const [leit, grav, excl] = await Promise.all([serie(token, projeto, 'read_ops_count'), serie(token, projeto, 'write_ops_count', 'metric.label.op_type'), serie(token, projeto, 'delete_ops_count')]);
  const dias = {}, diasCota = {};
  const somar = (alvo, dia, campo, v) => { alvo[dia] = alvo[dia] || { leituras: 0, gravacoes: 0, criacoes: 0, atualizacoes: 0, exclusoes: 0 }; alvo[dia][campo] += v; };
  const tudo = [...leit.map(p => ['leituras', p]), ...grav.map(p => ['gravacoes', p]), ...excl.map(p => ['exclusoes', p])];
  for (const [campo, p] of tudo) {
    for (const [alvo, dia] of [[dias, diaBr(p.inicio)], [diasCota, diaPacifico(p.inicio)]]) {
      somar(alvo, dia, campo, p.valor);
      if (campo === 'gravacoes' && p.rotulo === 'CREATE') somar(alvo, dia, 'criacoes', p.valor);
      if (campo === 'gravacoes' && p.rotulo === 'UPDATE') somar(alvo, dia, 'atualizacoes', p.valor);
    }
  }
  // transferência (oficial, se o projeto expuser a métrica) e faturamento — falhas aqui não derrubam o resto
  let transferencia = { disponivel: false, motivo: '' };
  try {
    const [saida, entrada] = await Promise.all([serieBytes(token, projeto, 'response_sizes'), serieBytes(token, projeto, 'request_sizes')]);
    const porDia = {};
    for (const [campo, pts] of [['saida', saida], ['entrada', entrada]]) for (const pt of pts) { const d = diaBr(pt.inicio); porDia[d] = porDia[d] || { saida: 0, entrada: 0 }; porDia[d][campo] += pt.valor; }
    transferencia = Object.keys(porDia).length ? { disponivel: true, dias: porDia } : { disponivel: false, motivo: 'o Cloud Monitoring não devolveu dados de tamanho das respostas da API do Firestore para este projeto' };
  } catch (e) { transferencia = { disponivel: false, motivo: e.message }; }
  const faturamento = await coletarFaturamento(token, projeto).catch(e => ({ disponivel: false, motivo: e.message }));
  return { dias, diasCota, transferencia, faturamento };
}

// ---- 2. GitHub
async function coletarGithub() {
  const out = { disponivel: true };
  const repo = await gh(`/repos/${REPO}`);
  out.repositorioKB = repo.ok ? repo.json.size : null;
  // backups: índice público do ramo "backups" (tamanho, data, conferência de cada arquivo)
  const ind = await gh(`/repos/${REPO}/contents/indice.json?ref=backups`, { headers: { accept: 'application/vnd.github.raw+json' } });
  if (ind.ok && ind.json) {
    const lista = (ind.json.backups || []).map(b => ({ arquivo: b.arquivo, criadoEm: b.criadoEm, tamanho: b.tamanho || 0, tipo: b.tipo || '', verificacaoOk: b.verificacaoOk !== false, documentos: b.totalDocumentos || 0, imagens: b.imagens || 0, partes: (b.partes || []).length || 1, temSha256: !!b.sha256Arquivo }));
    out.backups = { quantidade: lista.length, bytesTotal: lista.reduce((s, b) => s + b.tamanho, 0), maisAntigo: lista.length ? lista[lista.length - 1].criadoEm : '', maisRecente: lista.length ? lista[0].criadoEm : '', limiteBytes: (ind.json.politica || {}).limiteBytes || null, politica: ind.json.politica || {}, lista: lista.slice(0, 45), indiceAtualizadoEm: ind.json.atualizadoEm || '' };
  } else out.backups = { disponivel: false, motivo: `índice dos backups não encontrado (${ind.status})` };
  // execuções das rotinas (resultado REAL de cada execução; falhas com a mensagem resumida)
  const execucoes = async (wf, n) => {
    const r = await gh(`/repos/${REPO}/actions/workflows/${wf}/runs?per_page=${n}`);
    if (!r.ok) return { disponivel: false, motivo: `GitHub respondeu ${r.status}` };
    const runs = [];
    for (const x of r.json.workflow_runs || []) {
      const e = { id: x.id, criadoEm: x.created_at, iniciadoEm: x.run_started_at || x.created_at, terminadoEm: x.updated_at, situacao: x.status, resultado: x.conclusion || '', evento: x.event, url: x.html_url };
      if (x.conclusion === 'failure' && runs.filter(y => y.resultado === 'failure').length < 5) {
        const jobs = await gh(`/repos/${REPO}/actions/runs/${x.id}/jobs`);
        const msgs = [];
        for (const job of (jobs.json && jobs.json.jobs) || []) {
          const an = await gh(`/repos/${REPO}/check-runs/${job.id}/annotations`);
          (an.json || []).filter(a => a.annotation_level === 'failure' || a.annotation_level === 'warning').slice(0, 3).forEach(a => msgs.push(String(a.message || '').replace(/\s+/g, ' ').slice(0, 220)));
          const passo = (job.steps || []).find(s => s.conclusion === 'failure');
          if (passo) msgs.unshift(`Falhou no passo: ${passo.name}`);
        }
        e.erros = msgs.slice(0, 4);
      }
      runs.push(e);
    }
    return { disponivel: true, execucoes: runs };
  };
  out.rotinaBackup = await execucoes('backup.yml', 30);
  // a cópia no Google Drive rodou na última execução completa? (passo pulado = não configurada)
  const ultimaCompleta = (out.rotinaBackup.execucoes || []).find(e => e.situacao === 'completed' && e.evento !== 'push');
  if (ultimaCompleta) {
    const jobs = await gh(`/repos/${REPO}/actions/runs/${ultimaCompleta.id}/jobs`);
    const passo = (((jobs.json || {}).jobs || [])[0] || { steps: [] }).steps.find(s => /Segunda cópia/.test(s.name));
    out.copiaExterna = !passo ? { situacao: 'desconhecida' } : passo.conclusion === 'skipped' ? { situacao: 'nao_configurada' } : { situacao: passo.conclusion === 'success' ? 'ok' : 'falhou', em: passo.completed_at || '' };
  }
  out.rotinaVerificacao = await execucoes('verificar-backup.yml', 10);
  const pages = await gh(`/repos/${REPO}/pages/builds/latest`);
  out.publicacaoSite = pages.ok ? { situacao: pages.json.status, em: pages.json.updated_at || pages.json.created_at, duracaoMs: pages.json.duration || null } : { disponivel: false, motivo: `GitHub respondeu ${pages.status}` };
  const trafego = await gh(`/repos/${REPO}/traffic/views`);
  out.trafegoSite = trafego.ok ? { disponivel: true, visitas: trafego.json.count, visitantes: trafego.json.uniques, dias: (trafego.json.views || []).map(v => ({ dia: v.timestamp.slice(0, 10), visitas: v.count, visitantes: v.uniques })) } : { disponivel: false, motivo: `o GitHub só mostra o tráfego para quem administra o repositório (resposta ${trafego.status})` };
  return out;
}

// ---- 3. saúde
async function medir(fn) { const t = Date.now(); try { const r = await fn(); return { ok: true, ms: Date.now() - t, ...r }; } catch (e) { return { ok: false, ms: Date.now() - t, erro: String(e.message || e).slice(0, 160) }; } }

export async function coletar({ fsCli, projeto, chaveGcp }) {
  const agora = new Date();
  const dia = diaBr(agora);
  const fontes = { atualizadoEm: agora.toISOString() };
  // saúde
  const saude = {
    site: await medir(async () => { const r = await fetch(SITE, { cache: 'no-store' }); const b = await r.arrayBuffer(); if (!r.ok) throw new Error(`site respondeu ${r.status}`); return { status: r.status, bytesPagina: b.byteLength }; }),
    banco: await medir(async () => { await fsCli.obterDocumento('seguranca', 'backup'); return {}; })
  };
  // operações oficiais
  let operacoes = null;
  if (!chaveGcp) { fontes.transferenciaOficial = { disponivel: false, motivo: 'depende da mesma chave GCP_MONITORAMENTO_CHAVE' }; fontes.faturamento = { disponivel: false, motivo: 'depende da mesma chave GCP_MONITORAMENTO_CHAVE' }; }
  if (!chaveGcp) fontes.firestoreOficial = { disponivel: false, motivo: 'Falta o segredo GCP_MONITORAMENTO_CHAVE no GitHub (conta de serviço com o papel “Leitor do Monitoring”). Sem ele, as leituras, gravações e exclusões oficiais do Firebase não podem ser consultadas automaticamente.' };
  else {
    try {
      operacoes = await coletarOperacoes(projeto, JSON.parse(chaveGcp));
      fontes.firestoreOficial = { disponivel: true, dias: Object.keys(operacoes.dias).length };
      fontes.transferenciaOficial = operacoes.transferencia.disponivel ? { disponivel: true } : { disponivel: false, motivo: operacoes.transferencia.motivo };
      fontes.faturamento = operacoes.faturamento;
    }
    catch (e) { fontes.firestoreOficial = { disponivel: false, motivo: `Não consegui consultar o Cloud Monitoring: ${e.message}.` }; log(`Cloud Monitoring: falhou (${e.status || ''}).`); }
  }
  const github = await coletarGithub().catch(e => ({ disponivel: false, motivo: String(e.message || e).slice(0, 160) }));
  fontes.github = { disponivel: github.disponivel !== false };
  // grava: infra do dia, operações (por mês, juntando com o que já estava guardado) e fontes
  await gravarMonitoramento(fsCli, `infra_${dia}`, { data: dia, coletadoEm: agora.toISOString(), saude, github });
  if (operacoes) {
    const meses = new Set([...Object.keys(operacoes.dias), ...Object.keys(operacoes.diasCota)].map(d => d.slice(0, 7)));
    for (const mes of meses) {
      const antigo = campos(await fsCli.obterDocumento('monitoramento', `operacoes_${mes}`) || {});
      const doMes = o => Object.fromEntries(Object.entries(o).filter(([d]) => d.startsWith(mes)));
      const transf = operacoes.transferencia.disponivel ? { ...(antigo.transferencia || {}), ...doMes(operacoes.transferencia.dias) } : (antigo.transferencia || {});
      await gravarMonitoramento(fsCli, `operacoes_${mes}`, { data: `${mes}-01`, mes, atualizadoEm: agora.toISOString(), fonte: 'Google Cloud Monitoring (oficial)', dias: { ...(antigo.dias || {}), ...doMes(operacoes.dias) }, diasCota: { ...(antigo.diasCota || {}), ...doMes(operacoes.diasCota) }, transferencia: transf });
    }
  }
  await gravarMonitoramento(fsCli, 'fontes', fontes);
  log(`::notice::Fontes: operações oficiais ${fontes.firestoreOficial.disponivel ? 'OK' : 'indisponíveis (' + fontes.firestoreOficial.motivo + ')'} · transferência ${fontes.transferenciaOficial && fontes.transferenciaOficial.disponivel ? 'OK' : 'indisponível (' + ((fontes.transferenciaOficial || {}).motivo || '') + ')'} · faturamento ${fontes.faturamento && fontes.faturamento.disponivel ? (fontes.faturamento.faturamentoAtivo ? 'ATIVO' : 'desativado') : 'indisponível (' + ((fontes.faturamento || {}).motivo || '') + ')'}.`);
  log(`Monitoramento: site ${saude.site.ok ? 'OK' : 'FALHOU'} (${saude.site.ms} ms), banco ${saude.banco.ok ? 'OK' : 'FALHOU'} (${saude.banco.ms} ms), operações oficiais: ${fontes.firestoreOficial.disponivel ? 'OK' : 'indisponíveis'}, backups: ${github.backups && github.backups.quantidade != null ? github.backups.quantidade : '?'}.`);
  return { dia, saude, github, fontes, operacoes };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!process.env.FIREBASE_EMAIL || !process.env.FIREBASE_SENHA) { log('Sem a conta da rotina (BACKUP_EMAIL/BACKUP_SENHA): nada a fazer.'); process.exit(0); }
  const cfg = configFirebase();
  coletar({ fsCli: clienteFirestore(cfg), projeto: cfg.projeto, chaveGcp: process.env.GCP_MONITORAMENTO_CHAVE || '' })
    .then(() => process.exit(0))
    .catch(e => {
      // 403 = regras novas ainda não publicadas no Firebase: aviso, sem marcar a rotina como falha
      if (e.status === 403) { log('::warning::Central de Monitoramento: sem permissão para gravar — publique as regras novas do banco (seguranca/firestore.rules).'); process.exit(0); }
      log(`::error::Central de Monitoramento: ${String(e.message || e).slice(0, 160)}`); process.exit(1);
    });
}
