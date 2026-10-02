# Guia de recuperação — Controle de Peças (Tecnopemt)

Este guia explica como recuperar o sistema e os dados **mesmo se o site estiver fora do ar**.

## Onde o sistema fica

| Parte | Onde está | Backup |
|---|---|---|
| Código do site (`index.html`, ícones, manifesto) | GitHub `tecnopemt-cpu/pecas-eletronicas`, ramo `main`, publicado pelo GitHub Pages | Histórico do Git + uma cópia dentro de cada backup |
| Banco de dados (clientes, peças, entradas, orçamentos, equipe, comissões, períodos, avisos, notificações, históricos) | Firebase Firestore, projeto `controle-processos-a2f99` | Todo backup |
| Fotos (peças, entradas, entregas, testes) e imagens dos avisos | Dentro dos próprios documentos do Firestore (imagem embutida) | Todo backup |
| Assinaturas (imagem, nome, CPF, IP, data) | Dentro dos documentos de entradas e orçamentos | Todo backup |
| PDFs (recibos, orçamentos, relatórios) | **Não ficam guardados**: o sistema gera cada PDF na hora a partir dos dados | Os dados que geram os PDFs estão no backup |
| Vídeos dos avisos | Links externos (YouTube etc.) | Só o link |
| Sessão aberta e preferências do navegador | Em cada aparelho | Não precisa |

O Firebase Storage está configurado no projeto, mas o sistema **não usa** — não há arquivos fora do banco.

## Onde ficam os backups

1. **GitHub (automático, todo dia às 23:00)** — ramo `backups`: <https://github.com/tecnopemt-cpu/pecas-eletronicas/tree/backups>
   Fica fora do Firebase. Mantém os últimos 30 dias e um backup por mês dos últimos 12 meses.
   A rotina está em *Actions → Backup do Controle de Peças* (dá para rodar na hora em “Run workflow”).
2. **Seu computador** — cada “Fazer backup agora” baixa um arquivo `.tpbak`. Guarde também num pen drive ou na nuvem
   (Google Drive, e-mail): se o GitHub inteiro sumir, esse arquivo traz o código **e** os dados.
3. **Dentro do sistema** — as últimas 3 cópias manuais/“antes de restaurar”, para voltar atrás com um clique.

Todos os arquivos são **cifrados**. Para abrir é preciso o arquivo `chave-backup-tecnopemt-XXXX.json` **e a senha** dele,
criados em *Configurações → Backup e Segurança*. Guarde os dois em pelo menos dois lugares seguros.

---

## Situação 1 — alguém apagou ou alterou dados por engano (site funcionando)

1. Entre como **Master** → *Configurações → Backup e Segurança*.
2. No histórico, clique em **Testar** no backup desejado para conferir (não altera nada).
3. Clique em **Restaurar**, informe o arquivo da chave e a senha, confira o resumo (o que será criado, alterado e apagado),
   marque a confirmação e digite `RESTAURAR`.
4. Antes de gravar, o sistema faz sozinho um backup do estado atual (aparece como “Antes de restaurar”). Se precisar
   desfazer, restaure esse backup.

## Situação 2 — o site saiu do ar, mas o banco está bom

Opção A — reverter uma atualização com erro: no GitHub, abra o histórico do ramo `main` e reverta o último commit
(o GitHub Pages publica de novo em 1–2 minutos).

Opção B — publicar o site a partir de um backup (em qualquer computador com [Node.js 20+](https://nodejs.org)):

```bash
node backup/restaurar.mjs backup-AAAAMMDD-HHMM-automatico.tpbak --chave chave-backup-tecnopemt-XXXX.json --extrair recuperado
```

A pasta `recuperado/site` tem o sistema completo (`index.html`, ícones, manifesto). Publique essa pasta em qualquer
hospedagem estática (outro repositório no GitHub Pages, Netlify, Cloudflare Pages, Firebase Hosting…). Ela continua
usando o mesmo banco do Firebase.

> Não tem o repositório? O próprio backup traz os scripts: depois do `--extrair`, eles estão em `recuperado/site/backup/`.
> Para extrair pela primeira vez, baixe só a pasta `backup/` do GitHub ou peça a alguém com Node para rodar o comando.

## Situação 3 — o banco foi apagado ou corrompido

Se o site abre: siga a Situação 1 (o histórico mostra os backups do GitHub mesmo com o banco vazio).

Sem o site, num computador com Node.js 20+:

```bash
# 1) conferir (não grava nada)
node backup/restaurar.mjs backup-AAAAMMDD-HHMM-automatico.tpbak --chave chave-backup-tecnopemt-XXXX.json
# 2) restaurar (salva antes um backup do estado atual e pede para digitar RESTAURAR)
node backup/restaurar.mjs backup-AAAAMMDD-HHMM-automatico.tpbak --chave chave-backup-tecnopemt-XXXX.json --aplicar
```

No fim o script relê o banco e confirma “o banco ficou idêntico ao backup”. Também aceita um link direto
(`https://raw.githubusercontent.com/tecnopemt-cpu/pecas-eletronicas/backups/ARQUIVO.tpbak`) e backups divididos
em partes (`.parte01`, `.parte02`…).

## Situação 4 — o projeto do Firebase foi excluído

1. Crie um projeto novo no [console do Firebase](https://console.firebase.google.com), ative o **Cloud Firestore**
   e configure as regras de acesso.
2. Copie a configuração web do projeto novo (`apiKey`, `projectId`…) para o `firebaseConfig` do `index.html`.
3. Restaure os dados no projeto novo:

```bash
node backup/restaurar.mjs BACKUP.tpbak --chave CHAVE.json --aplicar --projeto ID-DO-PROJETO-NOVO --api-key CHAVE-WEB-NOVA
```

4. Publique o `index.html` atualizado (Situação 2).

## Situação 5 — o repositório do GitHub foi apagado

Use um arquivo `.tpbak` guardado no computador/nuvem: ele tem o código e os dados. Crie um repositório novo, extraia o
site (`--extrair`), envie a pasta `site/` para o repositório e ative o GitHub Pages. Para voltar a ter backup automático,
copie também a pasta `.github/` que está dentro de `site/`.

---

## Testes de recuperação

- **Automático**: toda mudança na pasta `backup/` roda no GitHub um teste completo com os dados reais. O teste lê o banco,
  cifra, abre de novo, confere documento por documento e simula a restauração, sem gravar nada.
- **Manual (recomendado uma vez por mês)**: *Configurações → Backup e Segurança → Testar*, com o arquivo da chave.

## Observações de segurança

- O repositório é público, por isso os backups só saem cifrados (RSA-3072 + AES-256-GCM). O banco guarda apenas a chave
  **pública**; a chave privada fica no arquivo do administrador, protegida pela senha.
- O sistema não usa o login do Firebase. Por isso as regras do Firestore precisam permitir acesso direto, e
  qualquer pessoa com a configuração pública do site consegue ler e gravar no banco. Os backups protegem contra perda.
  Para fechar esse acesso seria preciso migrar o login para o Firebase Authentication (mudança grande, fora deste escopo).
- O GitHub pausa rotinas agendadas de repositórios sem atividade por 60 dias; a própria rotina se reativa a cada execução.
  Mesmo assim, se o card “Backup automático” ficar em alerta, abra *Actions* no GitHub e confira.
