// Gera (ou troca) a chave de backup — fora do sistema, num computador com Node 20+.
//   node backup/gerar-chave.mjs --saida chave-backup-tecnopemt.json [--senha S]
// Cria:
//   backup/chave-publica.json  → vai para o repositório (a rotina automática cifra os backups com ela)
//   arquivo --saida            → chave PRIVADA, cifrada pela senha: guarde em 2 lugares seguros, NUNCA no repositório
// Depois de trocar a chave, os backups novos só abrem com a chave nova; os antigos continuam com a antiga.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const T = require('./nucleo.js');
const AQUI = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = n => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : undefined; };
const pergunta = q => new Promise(res => { const rl = readline.createInterface({ input: process.stdin, output: process.stdout }); rl.question(q, r => { rl.close(); res(r); }); });
const senha = opt('senha') || await pergunta('Senha para proteger a chave (mínimo 8 caracteres): ');
const k = await T.gerarChaves(senha, { criadaPor: opt('autor') || 'administrador', sistema: 'Controle de Peças — Tecnopemt' });
const saida = path.resolve(opt('saida') || `chave-backup-tecnopemt-${k.chaveId}.json`);
fs.writeFileSync(saida, JSON.stringify(k.arquivoChave, null, 2));
fs.writeFileSync(path.join(AQUI, 'chave-publica.json'), JSON.stringify({ formato: 'tecnopemt-chave-publica', chaveId: k.chaveId, criadaEm: k.arquivoChave.criadaEm, chavePublica: k.chavePublica }, null, 2) + '\n');
console.log(`Chave ${k.chaveId} criada.\n  Privada (guarde com a senha, fora do GitHub): ${saida}\n  Pública (envie ao repositório): backup/chave-publica.json`);
