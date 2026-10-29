import fs from 'node:fs';
import vm from 'node:vm';
// Carrega do index.html só as funções de cálculo da Comissão (as mesmas que o site usa).
export function carregarCalculo(caminhoIndex) {
  const html = fs.readFileSync(caminhoIndex, 'utf8');
  const linhas = html.split('\n');
  const achar = re => linhas.findIndex(l => re.test(l));
  const blocoFn = nome => {
    const i = achar(new RegExp(`^function ${nome}\\(`));
    if (i < 0) throw new Error('não achei ' + nome);
    let j = i + 1; while (j < linhas.length && !/^(function |const |let |\/\/ |async function )/.test(linhas[j])) j++;
    return linhas.slice(i, j).join('\n');
  };
  const ini = achar(/^const REGRAS_COMISSAO_PADRAO = \{/);
  const fim = achar(/^function useRegistrosApuracao\(/);
  const regiao = linhas.slice(ini, fim).join('\n');
  // todas as funções declaradas no script (declarar não executa nada); a região traz as constantes de regras
  const nomes = [...new Set(linhas.map(l => /^function ([A-Za-z0-9_$]+)\(/.exec(l)).filter(Boolean).map(m => m[1]))];
  const extras = nomes.map(n => { try { return blocoFn(n); } catch (e) { return ''; } }).join('\n');
  const ctx = { console, Intl, Date, Math, JSON, Number, String, Object, Array, Set, Map, isNaN, parseFloat, parseInt };
  ctx.React = { createElement: () => null }; ctx.useState = () => [null, () => {}]; ctx.useEffect = () => {}; ctx.useMemo = f => f(); ctx.useRef = () => ({});
  ctx.firebase = { firestore: { Timestamp: class {}, FieldValue: {} } };
  vm.createContext(ctx);
  vm.runInContext(extras + '\n' + regiao, ctx);
  return ctx;
}
