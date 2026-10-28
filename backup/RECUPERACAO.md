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
  Na pasta de destino ficam os backups dos últimos 30 dias; na subpasta `mensal`, o último backup de cada mês
  (13 meses). Os arquivos continuam cifrados: abrem só com a chave + senha.
- **Criptografia**: o repositório é público, então todo backup sai cifrado (RSA-3072 + AES-256-GCM).
  A rotina usa a chave **pública** (`backup/chave-publica.json`). Abrir um backup exige o **arquivo da chave privada
  (`chave-backup-tecnopemt-XXXX.json`) + a senha** — guardados pelo administrador, fora do sistema e fora do GitHub.
  **Guarde os dois em pelo menos dois lugares** (ex.: pen drive e Google Drive). Sem eles os backups não abrem.
- **Teste de recuperação automático**: toda alteração na pasta `backup/` roda no GitHub um teste completo com os dados reais
  (lê o banco, cifra, abre de novo, confere documento por documento e simula a restauração), sem gravar nada.
- **Avisos por e-mail** (`backup/alerta.mjs`): se o backup falhar, se ficar mais de 36 h sem backup novo
  (rotina *Verificar backup e armazenamento*, todo dia às 12:00) ou se o banco passar de 50% do 1 GiB gratuito /
  o repositório passar de 1 GB, a rotina abre um aviso em *Issues* mencionando @tecnopemt-cpu, e o GitHub manda
  e-mail para essa conta. O aviso não se repete (vira comentário) e fecha sozinho quando o problema some.
  Para garantir o e-mail: no repositório, *Watch → All Activity*, e em github.com/settings/notifications deixe
  *Email* marcado. (O e-mail padrão do GitHub para falha de rotina agendada vai para quem editou o agendamento,
  que não é a conta da empresa — por isso os avisos usam issues.)
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

O script pede o **login e a senha de um Administrador Master** (o mesmo do sistema): com o banco fechado, só
uma conta de verdade pode gravar. Antes de gravar, salva um backup do estado atual (`...-pre-restauracao.tpbak`)
para poder voltar atrás. As contas de acesso não voltam no tempo: cada funcionário continua com a senha atual.
Pede para digitar `RESTAURAR`, grava tudo e no fim relê o banco e confirma: “o banco ficou idêntico ao backup”.
Para desfazer, rode o mesmo comando com o arquivo `...-pre-restauracao.tpbak`.
As avaliações de desempenho não podem ser apagadas nem reescritas pelo site; durante a restauração o script
liga uma liberação de 2 horas só para o Master (`seguranca/restauracao`) e a retira ao terminar. Se o script for
interrompido no meio, apague `seguranca/restauracao` no console do Firebase (ou espere as 2 horas vencerem).

### 3) Site fora do ar → publicar o sistema de novo

- Se foi uma atualização com erro: reverta o último commit do ramo `main` no GitHub (o Pages republica em 1–2 minutos).
- Ou extraia o site de um backup e publique em qualquer hospedagem estática (outro repositório no GitHub Pages,
  Netlify, Cloudflare Pages, Firebase Hosting):

```bash
node backup/restaurar.mjs BACKUP.tpbak --chave CHAVE.json --extrair recuperado
```

`recuperado/site` = sistema completo; `recuperado/dados` = todos os dados em JSON legível.

### 4) Projeto do Firebase excluído → banco novo

1. Crie um projeto no [console do Firebase](https://console.firebase.google.com) e ative o Cloud Firestore
   (em modo de teste, aberto, só durante a recuperação) e o Authentication com **E-mail/senha** e **Anônimo**.
2. Coloque a configuração web do projeto novo no `firebaseConfig` do `index.html`.
3. `node backup/restaurar.mjs BACKUP.tpbak --chave CHAVE.json --aplicar --sem-login --projeto ID-NOVO --api-key CHAVE-WEB-NOVA`
4. As contas de login não ficam no backup (são do Google). Crie a do Master:
   `node backup/restaurar.mjs BACKUP.tpbak --chave CHAVE.json --novo-acesso walter --projeto ID-NOVO --api-key CHAVE-WEB-NOVA`
5. Publique o site atualizado (item 3), entre como Master e, em Equipe, use "Redefinir senha" para cada funcionário.
6. Cole as regras de `seguranca/firestore.rules` no console (Firestore → Regras) e recrie o acesso do backup
   (Equipe → painel de segurança) e os segredos `BACKUP_EMAIL`/`BACKUP_SENHA` no GitHub.

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

## Segurança do acesso (login pelo Firebase)

- O login é conferido pelo Google (Firebase Authentication). Cada funcionário tem uma conta interna
  (`f-<id>-v<n>@acesso.controle-pecas.app`, ligada à ficha por `contas/<uid>` e pelo campo `authUid` da ficha);
  ninguém precisa conhecer esse e-mail — entra-se com o login e a senha de sempre.
- As regras do banco ficam em `seguranca/firestore.rules` (versão anterior, aberta, em `seguranca/regras-anteriores.rules`).
  A rotina **Testar regras do banco** (GitHub Actions) testa as regras no emulador oficial e o sistema inteiro com elas
  (login, telas, assinatura por link, cadastro, backup) a cada alteração.
- A rotina de backup usa uma conta própria, só de leitura, criada pelo Master em **Equipe → painel de segurança**
  ("Criar acesso da rotina de backup"); o e-mail e a senha vão nos segredos `BACKUP_EMAIL` e `BACKUP_SENHA` do GitHub.
- A mesma conta (só leitura) é usada pela rotina **Verificar backup e armazenamento** para os lembretes da
  Avaliação de Desempenho (avaliações pendentes, feedback, metas atrasadas, dias sem registro), enviados como
  aviso `lembrete-avaliacao` no GitHub — só quando a lista muda. Desligue em Avaliação → Critérios e configurações.
- Para voltar às regras abertas em uma emergência: console do Firebase → Firestore → Regras → histórico → versão anterior.
