# Backup e recuperação — Controle de Peças (Tecnopemt)

O backup funciona **fora do sistema**: não existe tela, menu ou botão de backup no site.
Tudo roda nos bastidores (GitHub Actions) e a recuperação é feita por script, sem depender do site estar no ar.

## Onde está cada parte do sistema

| Parte | Onde está armazenada | Como é protegida |
|---|---|---|
| Código do site (`index.html`, ícones, manifesto) | GitHub `tecnopemt-cpu/pecas-eletronicas`, ramo `main` (publicado pelo GitHub Pages) | Versionamento do Git (todo o histórico de alterações) + uma cópia dentro de cada backup |
| Banco de dados (clientes, peças, entradas, orçamentos, equipe, comissões, períodos, avisos, notificações, históricos) | Google Firebase — Cloud Firestore, projeto `controle-processos-a2f99` | Backup automático diário |
| Fotos das peças, das entradas, das entregas e dos testes; imagens dos avisos | **No Firestore, coleção `midias`** — um documento por imagem (id = `img_` + SHA-256 do conteúdo). O registro (peça, entrada, orçamento, aviso) guarda só a referência `midia:img_...`, assim as telas carregam rápido e cada foto é baixada só quando aparece | Backup automático diário (junto com o banco); o backup confere que toda referência tem a sua imagem |
| Assinaturas (imagem, nome, CPF, IP, data) | Nome, CPF, IP e data dentro dos registros de entradas e orçamentos; a imagem da assinatura na coleção `midias` | Backup automático diário |
| PDFs (recibos, orçamentos, relatórios) | Não ficam armazenados: o sistema gera cada PDF na hora a partir dos dados | Os dados que geram os PDFs estão no backup |
| Arquivos enviados pelos usuários | Não existe armazenamento de arquivos separado: o que é enviado (fotos) vira imagem dentro do banco. O Firebase Storage está configurado, mas não é usado | Backup do banco |
| Vídeos dos avisos | Links externos (YouTube etc.) | Só o link |

Resumo: **os dados (inclusive fotos e assinaturas) estão no Firestore, no Google; o código está no GitHub.**
O backup copia o Firestore para fora do Google, e o código já está versionado.

## Mecanismo de backup (automático e externo)

- **Rotina**: GitHub Actions, arquivo `.github/workflows/backup.yml`, **todo dia às 23:00 (Brasília)**.
  Lê o Firestore inteiro direto da API do Google (não passa pelo site), junta o código, cifra e grava.
- **Onde ficam os backups**: ramo `backups` do repositório —
  <https://github.com/tecnopemt-cpu/pecas-eletronicas/tree/backups>.
  Fica fora do Firebase e do site. Retenção: últimos 30 dias + 1 por mês dos últimos 12 meses.
  O arquivo `indice.json`/`LEIAME.md` do ramo lista todos os backups (data, tamanho, quantidade de documentos).
- **Segunda cópia fora do GitHub (opcional)**: se os segredos `RCLONE_CONFIG` e `RCLONE_DESTINO` forem configurados
  no repositório (*Settings → Secrets and variables → Actions*), cada backup também é enviado para um armazenamento
  externo (Google Drive, OneDrive, Amazon S3, Backblaze etc.) via [rclone](https://rclone.org).
- **Criptografia**: o repositório é público, então todo backup sai cifrado (RSA-3072 + AES-256-GCM).
  A rotina usa a chave **pública** (`backup/chave-publica.json`). Abrir um backup exige o **arquivo da chave privada
  (`chave-backup-tecnopemt-XXXX.json`) + a senha** — guardados pelo administrador, fora do sistema e fora do GitHub.
  **Guarde os dois em pelo menos dois lugares** (ex.: pen drive e Google Drive). Sem eles os backups não abrem.
- **Teste de recuperação automático**: toda alteração na pasta `backup/` roda no GitHub um teste completo com os dados reais
  (lê o banco, cifra, abre de novo, confere documento por documento e simula a restauração), sem gravar nada.
- **Aviso de falha**: se a rotina falhar, o GitHub envia e-mail para a conta dona do repositório.
  Dá para ver todas as execuções em *Actions → Backup do Controle de Peças* e rodar na hora em *Run workflow*.

## Como recuperar (sem precisar do site)

Precisa de um computador com [Node.js 20+](https://nodejs.org), a pasta `backup/` deste repositório (ou de dentro de
qualquer backup extraído), o arquivo do backup e a chave + senha.

Baixe o backup desejado em <https://github.com/tecnopemt-cpu/pecas-eletronicas/tree/backups> (ou use o link direto
`https://raw.githubusercontent.com/tecnopemt-cpu/pecas-eletronicas/backups/ARQUIVO.tpbak`).

### 1) Conferir um backup (não altera nada)

```bash
node backup/restaurar.mjs backup-AAAAMMDD-HHMM-automatico.tpbak --chave chave-backup-tecnopemt-XXXX.json
```

Mostra a data, a quantidade de documentos por coleção, fotos e assinaturas, e confere os vínculos entre os dados
(orçamento → cliente → entrada → peças → comissão).

### 2) Dados apagados ou corrompidos → restaurar o banco

```bash
node backup/restaurar.mjs backup-AAAAMMDD-HHMM-automatico.tpbak --chave chave-backup-tecnopemt-XXXX.json --aplicar
```

Antes de gravar, o script salva um backup do estado atual (`...-pre-restauracao.tpbak`) para poder voltar atrás.
Pede para digitar `RESTAURAR`, grava tudo e no fim relê o banco e confirma: “o banco ficou idêntico ao backup”.
Para desfazer, rode o mesmo comando com o arquivo `...-pre-restauracao.tpbak`.

### 3) Site fora do ar → publicar o sistema de novo

- Se foi uma atualização com erro: reverta o último commit do ramo `main` no GitHub (o Pages republica em 1–2 minutos).
- Ou extraia o site de um backup e publique em qualquer hospedagem estática (outro repositório no GitHub Pages,
  Netlify, Cloudflare Pages, Firebase Hosting):

```bash
node backup/restaurar.mjs BACKUP.tpbak --chave CHAVE.json --extrair recuperado
```

`recuperado/site` = sistema completo; `recuperado/dados` = todos os dados em JSON legível.

### 4) Projeto do Firebase excluído → banco novo

1. Crie um projeto no [console do Firebase](https://console.firebase.google.com) e ative o Cloud Firestore.
2. Coloque a configuração web do projeto novo no `firebaseConfig` do `index.html`.
3. `node backup/restaurar.mjs BACKUP.tpbak --chave CHAVE.json --aplicar --projeto ID-NOVO --api-key CHAVE-WEB-NOVA`
4. Publique o site atualizado (item 3).

### 5) Repositório do GitHub perdido

Cada backup também guarda o código. Com um arquivo `.tpbak` salvo fora do GitHub (segunda cópia via rclone, ou
baixado e guardado), extraia (`--extrair`) e publique a pasta `site/` num repositório novo; a pasta
`site/.github` reativa o backup automático.

## Trocar a chave de backup

```bash
node backup/gerar-chave.mjs --saida chave-backup-tecnopemt-NOVA.json
```

Envie o `backup/chave-publica.json` atualizado ao repositório. Backups novos usam a chave nova; os antigos continuam
abrindo só com a chave antiga (não descarte o arquivo antigo).

## Observação de segurança

O sistema não usa o login do Firebase, então as regras do Firestore permitem acesso direto com a configuração pública
do site. O backup diário protege contra perda; fechar esse acesso exigiria migrar o login para o Firebase Authentication.
