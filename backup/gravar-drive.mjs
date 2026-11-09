// Central de Monitoramento: grava o espaço da conta do Google Drive usada na cópia externa dos backups
// (saída do "rclone about --json" e "rclone size --json"). Só números; nenhuma credencial.
//   node backup/gravar-drive.mjs saida/drive-about.json saida/drive-size.json
import fs from 'node:fs';
import { configFirebase, clienteFirestore } from './firestore-rest.mjs';
import { gravarMonitoramento } from './medir-banco.mjs';
const [aboutArq, sizeArq] = process.argv.slice(2);
const ler = a => { try { return JSON.parse(fs.readFileSync(a, 'utf8')); } catch (e) { return null; } };
const about = ler(aboutArq) || {}, size = ler(sizeArq) || {};
const agora = new Date(), dia = agora.toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
const dados = { data: dia, coletadoEm: agora.toISOString(), totalBytes: about.total ?? null, usadoBytes: about.used ?? null, livreBytes: about.free ?? null, lixeiraBytes: about.trashed ?? null, pastaBackupsBytes: size.bytes ?? null, pastaBackupsArquivos: size.count ?? null };
try { await gravarMonitoramento(clienteFirestore(configFirebase()), `drive_${dia}`, dados); console.log('Espaço do Google Drive registrado na Central de Monitoramento.'); }
catch (e) { console.log(`::warning::Central de Monitoramento: não consegui registrar o espaço do Google Drive (${e.status || ''}).`); }
