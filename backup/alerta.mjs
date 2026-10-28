// Avisos por e-mail do backup e do armazenamento (fora do site: funciona mesmo com o sistema fora do ar).
// Cada aviso é um "issue" no repositório com menção à conta da empresa (@tecnopemt-cpu) — o GitHub
// envia e-mail de issues e menções para essa conta. Um aviso igual já aberto recebe um comentário
// (não duplica) e é fechado sozinho quando o problema some.
//   node backup/alerta.mjs falha <link da execução>       backup falhou
//   node backup/alerta.mjs resolvido <link da execução>   backup voltou a funcionar (fecha o aviso de falha)
//   node backup/alerta.mjs verificar                      backup atrasado? armazenamento perto do limite?
// Precisa de GH_TOKEN (ou GITHUB_TOKEN) e GITHUB_REPOSITORY (o GitHub Actions já fornece).

const REPO = process.env.GITHUB_REPOSITORY || 'tecnopemt-cpu/pecas-eletronicas';
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
const CONTA = '@tecnopemt-cpu';
const HORAS_MAX_SEM_BACKUP = 36;
const LIMITE_BANCO = 1024 ** 3; // 1 GiB gratuito do Firestore (plano Spark)
const AVISO_BANCO = 0.5; // avisa quando o banco estimado passar de 50% do gratuito
const AVISO_REPO_KB = 1024 * 1024; // GitHub recomenda repositório abaixo de 1 GB
const COMPRESSAO = 0.72; // backup cifrado ≈ 72% do tamanho dos dados (medido em out/2026)

const TIPOS = {
  falha: { rotulo: 'aviso-backup-falhou', cor: 'B60205', titulo: 'Backup do Controle de Peças falhou' },
  atrasado: { rotulo: 'aviso-backup-atrasado', cor: 'D93F0B', titulo: 'Backup do Controle de Peças está atrasado' },
  armazenamento: { rotulo: 'aviso-armazenamento', cor: 'FBCA04', titulo: 'Armazenamento do Controle de Peças passou do nível de atenção' },
  bancoAberto: { rotulo: 'aviso-banco-aberto', cor: 'B60205', titulo: 'URGENTE: o banco do Controle de Peças está aberto a qualquer pessoa' }
};

async function gh(caminho, opcoes = {}) {
  const r = await fetch(`https://api.github.com/repos/${REPO}${caminho}`, {
    ...opcoes,
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', ...(opcoes.headers || {}) }
  });
  if (!r.ok && r.status !== 422) throw new Error(`GitHub respondeu ${r.status} em ${caminho}: ${(await r.text()).slice(0, 200)}`);
  return r.status === 204 ? null : r.json();
}
const agoraBr = () => new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

async function abrirAviso(tipo, texto) {
  const t = TIPOS[tipo];
  await gh('/labels', { method: 'POST', body: JSON.stringify({ name: t.rotulo, color: t.cor }) }); // 422 = já existe
  const abertos = await gh(`/issues?state=open&labels=${t.rotulo}&per_page=1`);
  if (abertos.length) {
    await gh(`/issues/${abertos[0].number}/comments`, { method: 'POST', body: JSON.stringify({ body: `${CONTA} continua: ${texto}` }) });
    console.log(`Aviso #${abertos[0].number} atualizado.`);
  } else {
    const novo = await gh('/issues', { method: 'POST', body: JSON.stringify({ title: t.titulo, labels: [t.rotulo], body: `${CONTA}\n\n${texto}\n\n---\nAviso automático. Ele é fechado sozinho quando o problema for resolvido. Como recuperar e onde ver tudo: \`backup/RECUPERACAO.md\`.` }) });
    console.log(`Aviso #${novo.number} aberto.`);
  }
}
async function fecharAviso(tipo, texto) {
  const t = TIPOS[tipo];
  const abertos = await gh(`/issues?state=open&labels=${t.rotulo}&per_page=10`);
  for (const i of abertos) {
    await gh(`/issues/${i.number}/comments`, { method: 'POST', body: JSON.stringify({ body: `${CONTA} resolvido: ${texto}` }) });
    await gh(`/issues/${i.number}`, { method: 'PATCH', body: JSON.stringify({ state: 'closed' }) });
    console.log(`Aviso #${i.number} fechado.`);
  }
}

// O banco tem de recusar quem não fez login (regras de seguranca/firestore.rules publicadas).
async function bancoFechado() {
  const html = await fetch(`https://raw.githubusercontent.com/${REPO}/main/index.html`).then(r => r.text());
  const projeto = /projectId:\s*"([^"]+)"/.exec(html)?.[1], chave = /apiKey:\s*"([^"]+)"/.exec(html)?.[1];
  const r = await fetch(`https://firestore.googleapis.com/v1/projects/${projeto}/databases/(default)/documents/clientes?pageSize=1&key=${chave}`);
  return { fechado: r.status === 403 || r.status === 401, status: r.status };
}
async function verificar() {
  // 0) banco fechado para quem não fez login?
  try {
    const b = await bancoFechado();
    console.log(`::notice::Banco sem login: ${b.fechado ? 'fechado (OK)' : 'ABERTO'} (resposta ${b.status}).`);
    if (!b.fechado) await abrirAviso('bancoAberto', `${agoraBr()} — o banco respondeu a uma leitura SEM login (resposta ${b.status}). As regras de segurança não estão valendo.\n\nCorrija no console do Firebase → Firestore Database → Regras: cole o conteúdo de \`seguranca/firestore.rules\` e clique em Publicar.`);
    else await fecharAviso('bancoAberto', `${agoraBr()} — o banco voltou a recusar acessos sem login.`);
  } catch (e) { console.log('::warning::Não consegui conferir se o banco está fechado: ' + e.message); }
  // 1) último backup (lista pública do ramo "backups", sem dados)
  const arq = await gh('/contents/indice.json?ref=backups');
  const indice = JSON.parse(Buffer.from(arq.content, 'base64').toString('utf8'));
  const ultimo = (indice.backups || []).slice().sort((a, b) => (a.criadoEm < b.criadoEm ? 1 : -1))[0];
  const horas = ultimo ? (Date.now() - Date.parse(ultimo.criadoEm)) / 36e5 : Infinity;
  console.log(`Último backup: ${ultimo ? ultimo.arquivo : 'nenhum'} (${horas.toFixed(1)} h atrás).`);
  if (horas > HORAS_MAX_SEM_BACKUP) {
    await abrirAviso('atrasado', `${agoraBr()} — o último backup foi há ${Math.floor(horas)} horas (${ultimo ? ultimo.arquivo : 'nenhum encontrado'}). O normal é um por dia.\n\nVerifique as execuções em https://github.com/${REPO}/actions/workflows/backup.yml e, se precisar, rode um backup na hora pelo botão "Run workflow".`);
  } else await fecharAviso('atrasado', `${agoraBr()} — backup em dia (${ultimo.arquivo}).`);

  // 2) armazenamento: banco do Firestore (estimado pelo backup) e tamanho do repositório
  const repo = await gh('');
  const bancoEst = ultimo ? ultimo.tamanho / COMPRESSAO : 0;
  const mb = b => (b / 1024 / 1024).toFixed(0) + ' MB';
  console.log(`Banco estimado: ${mb(bancoEst)} de 1 GiB · repositório: ${mb(repo.size * 1024)}.`);
  const problemas = [];
  if (bancoEst >= LIMITE_BANCO * AVISO_BANCO) problemas.push(`O banco de dados (Firestore) está em cerca de **${mb(bancoEst)}**, ${Math.round(bancoEst / LIMITE_BANCO * 100)}% do 1 GiB gratuito (estimativa pelo backup; o número oficial fica em Firebase → Uso e faturamento).`);
  if (repo.size >= AVISO_REPO_KB) problemas.push(`O repositório do GitHub (código + backups) está com **${mb(repo.size * 1024)}**, acima de 1 GB recomendado pelo GitHub. A retenção de backups pode precisar de ajuste.`);
  if (problemas.length) await abrirAviso('armazenamento', `${agoraBr()}\n\n- ${problemas.join('\n- ')}\n\nNada parou de funcionar; é um aviso antecipado para planejar.`);
  else await fecharAviso('armazenamento', `${agoraBr()} — banco ≈ ${mb(bancoEst)}, repositório ${mb(repo.size * 1024)}.`);
}

const [modo, link] = process.argv.slice(2);
if (!TOKEN) { console.error('Falta GH_TOKEN.'); process.exit(1); }
try {
  if (modo === 'falha') await abrirAviso('falha', `${agoraBr()} — a rotina de backup falhou. Detalhes e motivo: ${link || `https://github.com/${REPO}/actions/workflows/backup.yml`}\n\nOs backups anteriores continuam guardados em https://github.com/${REPO}/tree/backups.`);
  else if (modo === 'resolvido') await fecharAviso('falha', `${agoraBr()} — o backup voltou a funcionar (${link || ''}).`);
  else if (modo === 'verificar') await verificar();
  else { console.error('Uso: node backup/alerta.mjs falha|resolvido|verificar'); process.exit(1); }
} catch (e) {
  console.log(`::error::Não foi possível registrar o aviso: ${e.message}`);
  process.exit(1);
}
