// Mantém a pasta de backups do ramo "backups" no GitHub: guarda os mais recentes, um por mês e
// respeita um limite de espaço. Atualiza indice.json (lista pública, sem dados) e LEIAME.md.
//   node backup/retencao.mjs <pasta-do-ramo> <meta.json do backup novo>
import fs from 'node:fs';
import path from 'node:path';
const [dir, metaNovoArq] = process.argv.slice(2);
// O que vale no dia a dia é o último backup; os 7 mais recentes e o último de cada um dos 3 meses já encerrados
// ficam para o caso de um problema só ser percebido depois. Limite de 600 MB para o repositório ficar abaixo
// de 1 GB (recomendação do GitHub), mesmo com os backups crescendo junto com as fotos.
const DIARIOS = 7, MENSAIS = 3, MINIMO = 3, LIMITE_BYTES = 600 * 1024 ** 2;
const indiceArq = path.join(dir, 'indice.json');
const indice = fs.existsSync(indiceArq) ? JSON.parse(fs.readFileSync(indiceArq, 'utf8')) : { backups: [] };
let lista = (indice.backups || []).filter(b => (b.partes || [b.arquivo]).every(p => fs.existsSync(path.join(dir, p))));
if (metaNovoArq) {
  const m = JSON.parse(fs.readFileSync(metaNovoArq, 'utf8'));
  lista = lista.filter(b => b.arquivo !== m.arquivo);
  lista.push({ arquivo: m.arquivo, partes: m.partes, criadoEm: m.criadoEm, tipo: m.tipo, tamanho: m.tamanho, sha256Arquivo: m.sha256Arquivo, chaveId: m.chaveId, totalDocumentos: m.resumo?.totalDocumentos, imagens: m.resumo?.imagens, commitCodigo: m.commitCodigo, verificacaoOk: m.verificacao?.ok !== false });
}
lista.sort((a, b) => (a.criadoEm < b.criadoEm ? 1 : -1));
const manter = new Set();
lista.slice(0, DIARIOS).forEach(b => manter.add(b.arquivo));
// mensal = o ÚLTIMO backup de cada mês que já terminou (o mês corrente fica coberto pelos diários)
const mesAtual = (lista[0]?.criadoEm || new Date().toISOString()).slice(0, 7);
const porMes = {};
lista.forEach(b => { const mes = b.criadoEm.slice(0, 7); if (mes < mesAtual && !porMes[mes]) porMes[mes] = b; });
Object.keys(porMes).sort().reverse().slice(0, MENSAIS).forEach(m => manter.add(porMes[m].arquivo));
let total = 0, mantidos = [];
for (const b of lista) {
  if (!manter.has(b.arquivo)) continue;
  if (mantidos.length >= MINIMO && total + (b.tamanho || 0) > LIMITE_BYTES) continue;
  mantidos.push(b); total += b.tamanho || 0;
}
const nomesMantidos = new Set(mantidos.flatMap(b => b.partes || [b.arquivo]));
const removidos = [];
fs.readdirSync(dir).filter(f => /\.tpbak(\.parte\d+)?$/.test(f)).forEach(f => { if (!nomesMantidos.has(f)) { fs.rmSync(path.join(dir, f)); removidos.push(f); } });
fs.writeFileSync(indiceArq, JSON.stringify({ atualizadoEm: new Date().toISOString(), politica: { diarios: DIARIOS, mensais: MENSAIS, limiteBytes: LIMITE_BYTES }, backups: mantidos }, null, 2));
fs.writeFileSync(path.join(dir, 'LEIAME.md'), `# Backups do Controle de Peças (Tecnopemt)

Cópias **cifradas** do banco de dados e do código do sistema, geradas automaticamente todo dia.
Os arquivos \`.tpbak\` só podem ser abertos com o **arquivo da chave de backup + senha** (guardados pelo administrador).
Este ramo é separado do sistema: se o site ou o banco ficarem fora do ar, os backups continuam aqui.

Como recuperar: veja \`backup/RECUPERACAO.md\` no ramo principal (ou dentro de qualquer backup, que também guarda o código).

| Data (UTC) | Tipo | Tamanho | Arquivo |
|---|---|---|---|
${mantidos.map(b => `| ${b.criadoEm.replace('T', ' ').slice(0, 16)} | ${b.tipo} | ${(b.tamanho / 1024 / 1024).toFixed(1)} MB | ${(b.partes || [b.arquivo]).join(', ')} |`).join('\n')}
`);
console.log(`Mantidos: ${mantidos.length} backup(s), ${(total / 1024 / 1024).toFixed(1)} MB. Removidos: ${removidos.length}.`);
fs.writeFileSync(path.join(path.dirname(metaNovoArq || indiceArq), 'retencao.json'), JSON.stringify({ mantidos: mantidos.map(b => b.arquivo), removidos }));
