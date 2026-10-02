# pecas-eletronicas

Sistema de controle de entrada, conserto e saída de peças eletrônicas da Tecnopemt (site em GitHub Pages + banco no Firebase Firestore).

## Backup e recuperação

- Backup automático diário (23:00, Brasília) pelo GitHub Actions: `.github/workflows/backup.yml`, guardado cifrado no ramo `backups`.
- No sistema: *Configurações → Backup e Segurança* (backup manual, histórico, teste e restauração).
- Recuperação sem o site: [`backup/RECUPERACAO.md`](backup/RECUPERACAO.md).
