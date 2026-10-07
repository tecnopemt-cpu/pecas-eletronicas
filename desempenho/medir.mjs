// Mede a velocidade do site publicado, com os dados reais, simulando celular (4G) e notebook (Wi-Fi).
// Só LÊ: toda gravação no banco é bloqueada durante a medição (nada é alterado).
//   node desempenho/medir.mjs [url] [rotulo]
import { chromium } from 'playwright';
import fs from 'node:fs';
import { configFirebase, clienteFirestore } from '../backup/firestore-rest.mjs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const T = require('../backup/nucleo.js');

const URL_SITE = process.argv[2] || 'https://tecnopemt-cpu.github.io/pecas-eletronicas/';
const ROTULO = process.argv[3] || 'medição';
const LIMITE = 240000;
const gh = !!process.env.GITHUB_ACTIONS;
const nota = m => console.log(gh ? `::notice title=${ROTULO}::${m}` : m);

// Textos que só aparecem quando os dados de cada tela chegaram (tirados do próprio banco)
const cli = clienteFirestore(configFirebase());
const ler = async c => Object.fromEntries(Object.entries(await cli.listarDocumentos(c)).map(([id, f]) => [id, T.camposParaObjeto(f)]));
const [funcs, clientes, lotes, catalogo, orcs, avisos] = await Promise.all(['funcionarios', 'clientes', 'lotes', 'catalogoPecas', 'orcamentos', 'avisos'].map(ler));
const sessao = Object.entries(funcs).find(([, f]) => f.perfil === 'master' && f.status !== 'inativo')?.[0];
if (!sessao) throw new Error('sem usuário master');
const limpa = s => String(s || '').trim().replace(/\s+/g, ' ');
const ANCORAS = {
  avisos: Object.values(avisos).map(a => limpa(a.titulo)).filter(Boolean),
  lotes: [...new Set(Object.values(lotes).filter(l => l.arquivado !== true).map(l => limpa(clientes[l.clienteId]?.razaoSocial)).filter(Boolean))],
  catalogo: Object.values(catalogo).map(p => limpa(p.descricao)).filter(s => s.length > 3),
  clientes: Object.values(clientes).map(c => limpa(c.razaoSocial)).filter(s => s.length > 3),
  orcamentos: Object.values(orcs).filter(o => o.arquivado !== true && o.numero).map(o => '#' + o.numero)
};
const TELAS = [
  ['Entrada de Peças', 'lotes'],
  ['Cadastro de Peças', 'catalogo'],
  ['Clientes', 'clientes'],
  ['Orçamento', 'orcamentos'],
  ['Painel', 'painel']
];
const PERFIS = {
  'Celular (4G)': { viewport: { width: 390, height: 844 }, mobile: true, cpu: 4, rede: { latency: 120, downloadThroughput: 6e6 / 8, uploadThroughput: 1.5e6 / 8 } },
  'Notebook (Wi-Fi)': { viewport: { width: 1366, height: 768 }, mobile: false, cpu: 1, rede: { latency: 30, downloadThroughput: 25e6 / 8, uploadThroughput: 10e6 / 8 } }
};

const browser = await chromium.launch();
const resultado = {};
for (const [perfil, P] of Object.entries(PERFIS)) {
  const ctx = await browser.newContext({ viewport: P.viewport, isMobile: P.mobile, hasTouch: P.mobile });
  // nenhuma gravação chega ao banco durante a medição
  await ctx.route(/google\.firestore\.v1\.Firestore\/Write\//, r => r.abort());
  await ctx.route(/:commit/, r => r.abort());
  const page = await ctx.newPage();
  page.on('dialog', d => d.dismiss().catch(() => {}));
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', { offline: false, ...P.rede });
  if (P.cpu > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: P.cpu });
  let bytes = 0;
  cdp.on('Network.dataReceived', e => { bytes += e.encodedDataLength || 0; });
  cdp.on('Network.responseReceived', e => { bytes += (e.response.encodedDataLength || 0); });
  const linhas = [];
  async function medir(nome, acao, condicao) {
    const b0 = bytes, t0 = Date.now();
    let ok = true;
    try {
      await acao();
      await page.waitForFunction(condicao.fn, condicao.arg, { timeout: LIMITE, polling: 100 });
    } catch (e) { ok = false; }
    const ms = Date.now() - t0;
    const mb = (bytes - b0) / 1e6;
    linhas.push({ nome, ms: ok ? ms : null, mb: +mb.toFixed(2) });
    console.log(`${perfil} | ${nome.padEnd(28)} ${ok ? (ms / 1000).toFixed(1).padStart(6) + ' s' : ' > ' + LIMITE / 1000 + ' s'}  ${mb.toFixed(2).padStart(6)} MB`);
  }
  const contem = lista => ({ fn: l => { const el = document.querySelector('.conteudo-principal') || document.body; const t = el.innerText.replace(/\s+/g, ' '); return l.some(x => t.includes(x)); }, arg: lista });
  async function irPara(nome) {
    if (P.mobile) { await page.locator('.sidebar-toggle').first().click(); await page.waitForTimeout(300); }
    await page.locator('.sidebar-item', { hasText: nome }).first().click();
  }
  const base = URL_SITE + (URL_SITE.includes('?') ? '&' : '?') + 'medicao=' + Date.now();
  await medir('Abrir o site (tela de login)', () => page.goto(base, { timeout: LIMITE }), { fn: () => !!document.querySelector('input[type=password]'), arg: null });
  await medir('Entrar (abre em Avisos)', async () => {
    await page.evaluate(s => localStorage.setItem('pecas_sessao', s), sessao);
    await page.goto(base + '&r=1', { timeout: LIMITE });
  }, contem(ANCORAS.avisos));
  for (const [tela, chave] of TELAS) {
    const cond = chave === 'painel'
      ? { fn: () => { const t = (document.querySelector('.conteudo-principal')?.innerText || '').replace(/\s+/g, ' '); return /Entrada de peças no período [1-9]/.test(t); }, arg: null }
      : contem(ANCORAS[chave]);
    if (chave === 'orcamentos' && !ANCORAS.orcamentos.length) continue;
    await medir(tela, () => irPara(tela), cond);
  }
  await medir('Entrada de Peças (2ª vez)', () => irPara('Entrada de Peças'), contem(ANCORAS.lotes));
  await medir('Cadastro de Peças (2ª vez)', () => irPara('Cadastro de Peças'), contem(ANCORAS.catalogo));
  resultado[perfil] = linhas;
  await ctx.close();
}
await browser.close();
for (const [perfil, linhas] of Object.entries(resultado)) {
  const total = linhas.reduce((s, l) => s + l.mb, 0);
  nota(`${perfil}: ` + linhas.map(l => `${l.nome} = ${l.ms === null ? `mais de ${LIMITE / 1000} s` : (l.ms / 1000).toFixed(1) + ' s'} (${l.mb} MB)`).join(' · ') + ` · TOTAL baixado ${total.toFixed(1)} MB`);
}
fs.writeFileSync('medicao.json', JSON.stringify({ rotulo: ROTULO, url: URL_SITE, data: new Date().toISOString(), resultado }, null, 1));
