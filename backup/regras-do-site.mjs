// Carrega funções do próprio site (index.html) para as rotinas do GitHub usarem EXATAMENTE a mesma regra
// das telas — por exemplo, o calendário de períodos da Comissão e a regra de arquivamento automático.
// Nada é copiado à mão: se a regra mudar no site, a rotina passa a seguir a regra nova.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// corpo de "function nome(...) { ... }" (pula textos, modelos `...` e comentários ao contar as chaves)
export function extrairFuncao(fonte, nome) {
  const marca = `\nfunction ${nome}(`;
  const ini = fonte.indexOf(marca);
  if (ini < 0 || fonte.indexOf(marca, ini + 1) >= 0) throw new Error(`função ${nome} não encontrada (ou repetida) no index.html`);
  let i = fonte.indexOf('{', fonte.indexOf(')', ini + marca.length - 1));
  // parâmetros simples: o primeiro "{" depois do ")" abre o corpo
  let prof = 0, modo = null;
  for (; i < fonte.length; i++) {
    const c = fonte[i], prox = fonte[i + 1];
    if (modo === 'linha') { if (c === '\n') modo = null; continue; }
    if (modo === 'bloco') { if (c === '*' && prox === '/') { modo = null; i++; } continue; }
    if (modo) { if (c === '\\') { i++; continue; } if (c === modo) modo = null; continue; }
    if (c === '/' && prox === '/') { modo = 'linha'; continue; }
    if (c === '/' && prox === '*') { modo = 'bloco'; continue; }
    if (c === "'" || c === '"' || c === '`') { modo = c; continue; }
    if (c === '{') prof++;
    if (c === '}' && --prof === 0) return fonte.slice(ini + 1, i + 1);
  }
  throw new Error(`fim da função ${nome} não encontrado`);
}
export function extrairConst(fonte, nome) {
  const m = new RegExp(`\\nconst ${nome} = ([^\\n]*?);(\\s*//[^\\n]*)?\\n`).exec(fonte);
  if (!m) throw new Error(`constante ${nome} não encontrada no index.html`);
  return `const ${nome} = ${m[1]};`;
}
export function carregarRegrasDoSite(funcoes, constantes = [], raiz = RAIZ) {
  const html = fs.readFileSync(path.join(raiz, 'index.html'), 'utf8');
  const codigo = [...constantes.map(c => extrairConst(html, c)), ...funcoes.map(f => extrairFuncao(html, f))].join('\n');
  const ctx = vm.createContext({ Date, Math, String, Number, Array, Object, JSON, isNaN, console });
  vm.runInContext(`${codigo}\nthis.__regras = { ${[...funcoes, ...constantes].join(', ')} };`, ctx, { filename: 'index.html (regras)' });
  return ctx.__regras;
}
