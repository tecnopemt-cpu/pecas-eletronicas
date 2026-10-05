// Remove do banco os registros da tela de backup que existiu dentro do sistema (já retirada):
// coleções "backups" e "backupsCopias" e o documento config/backup. Não toca em mais nada.
import { createRequire } from 'node:module';
import { configFirebase, clienteFirestore } from './firestore-rest.mjs';
const require = createRequire(import.meta.url);
const T = require('./nucleo.js');
const cli = clienteFirestore(configFirebase());
const escritas = [];
for (const c of T.COLECOES_DO_BACKUP) {
  const docs = await cli.listarDocumentos(c);
  Object.keys(docs).forEach(id => escritas.push(cli.escritaApagar(c, id)));
}
if (await cli.obterDocumento('config', 'backup')) escritas.push(cli.escritaApagar('config', 'backup'));
if (escritas.length) await cli.gravar(escritas);
console.log(`Registros antigos da tela de backup removidos: ${escritas.length}.`);
