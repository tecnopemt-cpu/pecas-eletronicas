# pecas-eletronicas

Sistema de controle de entrada, conserto e saída de peças eletrônicas da Tecnopemt (site em GitHub Pages + banco no Firebase Firestore).

## Backup e recuperação

- Backup automático diário (23:00, Brasília) pelo GitHub Actions: `.github/workflows/backup.yml`, guardado cifrado no ramo `backups`.
- O backup funciona fora do sistema (não há tela de backup no site). Dados no Firebase Firestore (inclusive fotos e assinaturas); código versionado aqui.
- Recuperação sem o site: [`backup/RECUPERACAO.md`](backup/RECUPERACAO.md).
