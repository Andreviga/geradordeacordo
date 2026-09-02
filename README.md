# Gerador de Acordo — Colégio Raízes

Sistema de geração e gestão de Termos de Confissão de Dívida com banco de dados PostgreSQL (Neon) e deploy no Vercel.

## Estrutura

```
/
├── index.html                  ← frontend completo (SPA)
├── api/                        ← funções serverless Vercel
│   ├── acordos/                ← CRUD de acordos (catch-all)
│   ├── parcelas/               ← baixar / estornar parcelas
│   ├── cron/                   ← lembretes (D-3/D+1/D+7/D+15) e backup semanal
│   ├── login.js, painel.js, usuarios.js, health.js
│   ├── solicitar-reset.js, confirmar-reset.js
│   └── assinatura/             ← prepara o documento para assinatura no gov.br
├── db/schema.sql               ← schema PostgreSQL (idempotente)
├── scripts/                    ← scripts CLI de operação
├── tests/                      ← testes unitários (662 asserções)
├── tests/e2e/                  ← testes Playwright
├── vercel.json
└── README.md
```

---

## Backup e Restore

O backup tem **dois destinos possíveis**, e os dois podem ficar ligados ao mesmo tempo.
Basta um estar configurado; sem nenhum, o cron falha alto dizendo o que falta.

| Destino | Ligado por | Quando usar |
|---|---|---|
| **E-mail** | `BACKUP_EMAIL` + `BACKUP_SENHA` | funciona em qualquer conta Google |
| **Drive** | `DRIVE_BACKUP_FOLDER_ID` + service account | exige **Drive Compartilhado** |

### Por que o Drive nem sempre serve

Service account **não tem cota de armazenamento** — zero, por definição. Um arquivo que
ela cria numa pasta do "Meu Drive" fica sob a cota dela, e o upload falha com
`Service Accounts do not have storage quota`. Compartilhar a pasta resolve o acesso,
mas não muda quem seria o dono do arquivo.

Em **Drive Compartilhado** os arquivos pertencem ao drive, não a quem os criou — aí
funciona. Só que Drive Compartilhado exige Google Workspace **Business Standard ou
superior**; o Business Starter não inclui.

Sem isso, use o destino por e-mail.

### Backup por e-mail

```
BACKUP_EMAIL=secretaria@colegio.com.br
BACKUP_SENHA=<gere com: node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))">
```

O anexo vai **sempre cifrado** (AES-256-GCM, chave derivada por scrypt, sal aleatório
por arquivo). Isso não é opcional e o envio é recusado sem `BACKUP_SENHA`: o arquivo
leva a base inteira — CPF, RG, endereço e telefone de responsáveis, e nome de menores.
Mandar isso em claro toda semana trocaria "não ter backup" por "vazar a base se a caixa
for comprometida".

> ⚠️ **Guarde a `BACKUP_SENHA` fora do Vercel também.** Sem ela o arquivo não é
> recuperável — não existe porta dos fundos, é o ponto de cifrar. Se você perder o
> acesso ao painel e a senha ao mesmo tempo, os backups viram lixo.

### Backup automático

O cron `/api/cron/backup` roda toda segunda-feira às 06h UTC (03h BRT).

> Os dois crons (`/api/cron/lembretes` e `/api/cron/backup`) são atendidos pela
> mesma função, `api/cron/index.js` — o `vercel.json` reescreve `/api/cron/:job`
> para `/api/cron?job=:job`. Foram fundidos para caber no limite de 12 funções
> serverless do plano Hobby. As URLs não mudaram.

- **Semanal**: `backup-weekly-YYYY-WW.json.gz` — no Drive, retém as 4 últimas semanas.
- **Mensal**: `backup-monthly-YYYY-MM.json.gz` (primeira segunda do mês) — retém 12 meses.
- **Formato**: JSON comprimido (zlib/gzip), todas as tabelas na ordem correta de FK.
- No e-mail não há rotação: a caixa guarda o histórico que você quiser.

Para rodar um backup imediato:
```bash
npm run cron:backup
```

### Backup manual, para a sua máquina

```bash
npm run backup:baixar                     # ./backups/backup-manual-<data>.json.gz
npm run backup:baixar -- --cifrar         # cifra com BACKUP_SENHA
npm run backup:baixar -- --dir=D:/copias  # outra pasta
```

O cron manda o arquivo para fora; este comando traz uma cópia para perto, sem passar
por terceiro nenhum. É o que se roda **antes de uma operação de risco**: migração de
schema, expurgo de retenção, restore.

Sai no mesmo formato do cron, então o `db:restore` lê os dois. A pasta `backups/` está
no `.gitignore`.

> Sem `--cifrar` o arquivo fica em claro na sua máquina, com todos os dados pessoais.
> Numa pasta sincronizada (OneDrive, Dropbox) isso significa mandar a base para a nuvem
> do fornecedor. Prefira `--cifrar`, ou uma pasta fora da sincronização.


### Restore — procedimento exato

#### Pré-requisitos
- Node.js 18+
- `DATABASE_URL` apontando para o banco de destino (use `.env.local`)
- Arquivo do backup: o `.json.gz` do Drive, ou o `.json.gz.enc` que chega por e-mail

Não é preciso descompactar: o script detecta gzip pelos bytes do arquivo.

#### Passo 1 — Ensaiar (não grava nada)

```bash
npm run db:restore -- backup-weekly-2026-W31.json.gz --dry-run
```

O ensaio roda o restore inteiro — `TRUNCATE`, todos os `INSERT`, conferência de
contagens — e dá `ROLLBACK` no final. Serve para validar o arquivo contra as
constraints reais do banco sem alterar nada. Antes de escrever qualquer coisa
ele já teria recusado se alguma tabela ou coluna do dump não existisse no destino.

A saída mostra o que seria substituído:

```
  tabela                    hoje →  do backup
  usuarios                     1 →          1
  acordos                     12 →        347
  parcelas                   140 →       4108
  TOTAL                      153 →       4456
```

#### Passo 2 — Restaurar para valer

```bash
npm run db:restore -- backup-weekly-2026-W31.json.gz
```

O script pede que você **digite o host do banco** para confirmar. Isso existe
para não restaurar em produção por engano — colar o comando não basta, é preciso
reconhecer o destino.

Tudo roda numa transação. Se as contagens finais não baterem com o backup, ele
dá `ROLLBACK` sozinho e o banco fica intacto.

#### Passo 3 — Verificar

```bash
npm run db:status
```

#### Restore parcial (apenas uma tabela)

```bash
npm run db:restore -- backup-weekly-2026-W31.json.gz --tabela=acordos
```

> ⚠️ `TRUNCATE ... CASCADE` numa tabela pai apaga as filhas, que **não** serão
> repostas no modo parcial. Restaurar só `acordos` esvazia `parcelas`. O script
> avisa antes de pedir a confirmação.

#### Opções

| Opção | Efeito |
|---|---|
| `--dry-run` | ensaio completo com `ROLLBACK` no fim |
| `--sim` | pula a confirmação digitada (automação) |
| `--tabela=<nome>` | restaura só essa tabela; pode repetir |
| `--senha=<senha>` | senha do backup cifrado (o que chega por e-mail) |

### Restore de teste trimestral

O teste que antes era manual virou script, e roda junto com `npm test`:

```bash
npm run test:restore
```

Ele semeia dados cobrindo as 13 tabelas (JSONB, datas, BIGINT em centavos, FKs,
acentuação), gera um backup no formato exato do cron, destrói e adultera os
dados, restaura com o mesmo núcleo do `db:restore` e compara linha a linha com o
original.

Por padrão usa **PGlite** — PostgreSQL 18 compilado para WASM, rodando dentro do
próprio processo. Não precisa de Docker, servidor nem rede, então roda igual em
qualquer máquina e em CI.

Para conferir contra o Postgres real de tempos em tempos:

```bash
npm run test:restore -- --postgres
```

Nesse modo ele só aceita `localhost` ou `BANCO_TESTE_HOST` — recusa qualquer
outro destino, porque apaga dados de propósito. Para um banco descartável em
outro host, acrescente `--descartavel`.

Registre a data e o resultado a cada execução (ex.: "Restore testado em
2026-10-05, 347 acordos, OK").


---

## Variáveis de ambiente necessárias (Vercel → Settings → Environment Variables)

| Variável | Descrição |
|---|---|
| `DATABASE_URL` | Connection string PostgreSQL (Neon) |
| `JWT_SECRET` | Segredo para assinar tokens JWT (mín. 32 chars) |
| `CRON_SECRET` | Segredo para autenticar chamadas dos crons |
| `SMTP_USER` | Gmail da conta de notificações |
| `SMTP_PASS` | Senha de app do Gmail |
| `EMAIL_FROM` | Endereço exibido como remetente |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | JSON (ou base64) da service account GCP |
| `DRIVE_PDF_FOLDER_ID` | ID da pasta de PDFs no Drive Compartilhado |
| `DRIVE_BACKUP_FOLDER_ID` | ID da pasta de backups no Drive Compartilhado |
| `CONTATO_SECRETARIA_EMAIL` | E-mail da secretaria (lembretes e replyTo) |
| `CONTATO_SECRETARIA_FONE` | Telefone da secretaria (corpo dos lembretes) |
| `LEMBRETES_MAX_POR_EXECUCAO` | Cap de segurança de envios por execução (default: 5) |
| `APP_URL` | URL de produção (default: https://gerador-acordo.vercel.app) |

---

## Operação

```bash
npm test                    # 437 assertions unitárias (deve passar sem banco)
npm run smoke               # smoke test integrado (requer .env.local com banco de teste)
npm run cron:lembretes -- --dry-run    # lista quem receberia lembrete (sem enviar)
npm run cron:lembretes -- --test-email # envia 4 templates sintéticos para a secretaria
npm run cron:backup                    # backup manual imediato
npm run db:migrate                     # aplica schema (idempotente)
npm run db:status                      # verifica integridade do banco
npm run db:resetar-senha contato@raizesedu.com.br NovaSenha
npm run db:deletar-acordo 2026/001     # remove acordo permanentemente (com confirmação)
```


1. Crie um repositório no GitHub e suba estes três arquivos.
2. Em vercel.com → **Add New… → Project → Import Git Repository**.
3. Framework Preset: **Other**. Build Command: deixe vazio. Output Directory: `.`
4. **Deploy**. Cada `git push` republica sozinho.

Domínio próprio: Project → Settings → Domains → adicione `acordos.seudominio.com.br`
e aponte o CNAME indicado no seu provedor de DNS.

---

## 2. Ligar o Google Drive

O app usa o escopo `drive.file`: ele só enxerga e altera **os arquivos que ele mesmo criou**.
Não tem acesso ao resto do seu Drive.

1. Acesse **console.cloud.google.com** e crie um projeto (ex.: "Gerador Acordos").
2. **APIs e serviços → Biblioteca** → busque **Google Drive API** → **Ativar**.
3. **APIs e serviços → Tela de permissão OAuth**:
   - Tipo: **Externo** (ou **Interno**, se você usa Google Workspace — mais simples).
   - Preencha nome do app, e-mail de suporte e e-mail do desenvolvedor.
   - Em **Escopos**, adicione `.../auth/drive.file`.
   - Em **Usuários de teste**, coloque os e-mails da secretaria enquanto o app estiver
     em modo de teste. Sem publicar, o consentimento vale 7 dias por usuário; para uso
     contínuo, clique em **Publicar app**.
4. **APIs e serviços → Credenciais → Criar credenciais → ID do cliente OAuth**:
   - Tipo: **Aplicativo da Web**.
   - **Origens JavaScript autorizadas**: a URL do Vercel, sem barra no final —
     `https://gerador-acordo.vercel.app`. Adicione também `http://localhost:3000`
     se for testar na sua máquina, e o domínio próprio, se tiver.
   - Não precisa preencher URI de redirecionamento.
5. Copie o **Client ID** (termina em `.apps.googleusercontent.com`), abra o site publicado,
   vá na seção **10 · Google Drive**, cole no campo e clique em **Conectar**.

O Client ID fica gravado no navegador de quem usa — é uma identificação pública do app,
não é senha. Cada pessoa conecta a própria conta Google.

### O que dá para fazer depois de conectar

- **Salvar acordo no Drive** — grava um `.json` com todos os dados na pasta
  *Acordos - Gerador*, criada automaticamente no Drive de quem está conectado.
- **Atualizar / Abrir o selecionado** — lista os acordos salvos e recarrega qualquer um
  no formulário, com cláusulas, valores e tudo mais.
- **Enviar Word ao Drive** — sobe o documento pronto (`.doc`) para a mesma pasta.

Quem não quiser nuvem continua usando **Salvar dados** e **Abrir dados**, que baixam e leem
o mesmo `.json` do computador.

---

## 3. Alternativas ao Drive

| Opção | Quando faz sentido | Esforço |
|---|---|---|
| **Google Drive** (implementado) | Cada pessoa guarda no próprio Drive; nada de servidor | Só o Client ID |
| **Vercel Blob + rota de API** | Todos veem o mesmo acervo de acordos, com senha única | Precisa de código no servidor e chave |
| **Supabase / Firebase** | Vários usuários, histórico, permissões por pessoa | Banco + autenticação |
| **Pasta de rede da escola** | Sem internet, tudo interno | Só usar Salvar/Abrir dados |

---

## 4. Assinatura digital — gov.br

A assinatura é feita pelos próprios signatários no portal **gov.br**. O sistema não
assina nem envia nada: ele valida o PDF, calcula o **SHA-256** de conferência e monta
o passo a passo. Não há custo por assinatura e não há integração a manter.

Cada signatário precisa de conta gov.br **Prata ou Ouro** — Bronze não habilita
assinatura eletrônica avançada.

> ⚠️ **A assinatura é sequencial.** Cada signatário assina o arquivo **já assinado**
> pelo anterior, nunca o original. Assinar o original em paralelo produz dois PDFs com
> uma assinatura cada — sem validade como instrumento conjunto. As instruções que a
> tela gera já dizem isso, em ordem.

Onde: `assinador.iti.gov.br` para assinar, `validar.iti.gov.br` para conferir.

O arquivo assinado fica com quem assinou — **o sistema não guarda cópia**. Cabe à
secretaria arquivar a via final.

Base legal do fecho eletrônico: art. 784, §4º do CPC (Lei nº 14.620/2023), que dispensa
testemunhas quando a integridade é conferida por provedor de assinatura. O gov.br é um.

### Integrações removidas

Houve integração com **ZapSign** e **Adobe Sign**, com webhook e guarda automática do
PDF assinado no Drive. Foram removidas: a assinatura passou a ser exclusivamente pelo
gov.br. Nenhuma delas chegou a gravar no banco, então não ficou dado órfão.

Se `ZAPSIGN_API_TOKEN`, `ZAPSIGN_WEBHOOK_SECRET`, `ZAPSIGN_VALIDATE_CPF`,
`ASSINATURA_PROVIDER` ou as variáveis da Adobe ainda estiverem no painel do Vercel,
**remova**. O `npm run health` acusa quando alguma sobra.

---


## Banco de dados (Fase E)

### Pré-requisitos

- `DATABASE_URL` definida no `.env.local` (desenvolvimento) ou no painel do Vercel (produção).
- Copie a connection string diretamente de: painel Neon → projeto → **Connection Details** → _Connection string_.
  Formato: `postgresql://usuario:senha@host.neon.tech/banco?sslmode=require`

### Comandos

| Comando | O que faz | Altera dados? |
|---------|-----------|:---:|
| `npm run db:migrate` | Aplica `db/schema.sql` e verifica o resultado | Sim (DDL) |
| `npm run db:status` | Verifica o schema sem alterar nada | Não |
| `npm run db:criar-admin` | Cria o primeiro usuário admin interativamente | Sim |

### Ordem de execução (primeira vez)

```bash
# 1. Instalar dependências (inclui o driver pg)
npm install

# 2. Aplicar o schema e verificar
npm run db:migrate

# 3. Criar o primeiro usuário administrador
npm run db:criar-admin
```

O script `db:migrate` é idempotente: pode ser rodado novamente após falha parcial sem risco.
O script `db:status` é seguro para rodar a qualquer momento em produção — só lê.

### Primeiro usuário

Use `npm run db:criar-admin`. O script pede nome, e-mail e senha no terminal (senha mascarada),
confirma antes de gravar e recusa se o e-mail já existir.

**Use um e-mail real da pessoa que vai administrar o sistema** — não o e-mail de notificações.
O campo é `UNIQUE` e é o login do sistema.

**Crie como `admin`** (o script sempre cria admin) — sem um admin, nenhum outro
usuário pode ser criado depois pela interface.

---

## Revisão jurídica

| Data       | Escopo revisado | Status |
|------------|-----------------|--------|
| 2026-08-04 | Fecho eletrônico (assinatura digital + dispensa de testemunhas, art. 784 §4º CPC) | ✅ Aprovado |
| 2026-08-04 | Fecho físico (duas vias + duas testemunhas, art. 784 III CPC) | ✅ Aprovado |
| 2026-08-04 | Texto de dispensa de testemunhas no modo eletrônico | ✅ Aprovado |
| Pendente   | Cláusulas do corpo do acordo (multa moratória, multa penal, juros, cumulação) | ⚠ Não revisado |
| Pendente   | Cláusula de foro de eleição | ⚠ Não revisado |
| Pendente   | Qualificação das partes e cláusulas de confissão de dívida | ⚠ Não revisado |

> As cláusulas "Não revisado" foram redigidas com base em modelos usuais e precisam de
> validação por advogado antes de uso em situações de risco jurídico elevado.

---

## Gestão de usuários

O primeiro admin nasce pela linha de comando (`npm run db:criar-admin`). Do segundo
em diante, tudo acontece na tela: botão **Usuários** na barra superior, visível só
para quem é admin.

| Ação | Onde |
|---|---|
| Criar usuário (nome, e-mail, papel, senha provisória) | tela **Usuários** |
| Promover a admin / rebaixar a secretaria | tela **Usuários** |
| Desativar e reativar | tela **Usuários** |
| Definir nova senha para alguém | tela **Usuários** |
| Trocar a própria senha esquecida | tela de login → *Esqueci minha senha* |

Papéis (o banco só aceita estes dois):

- **`secretaria`** — usa o sistema no dia a dia: cria acordos, dá baixa, consulta.
- **`admin`** — tudo isso, mais gerenciar usuários e cancelar acordos.

### Desativar em vez de excluir

Não existe exclusão de usuário, de propósito: `acordos.criado_por` referencia
`usuarios(id)`, e apagar a linha destruiria a autoria dos acordos já emitidos.
Desativar resolve o que importa — o acesso é cortado **na hora**, mesmo se a pessoa
estiver com uma sessão aberta, porque o `ativo` é reconferido no banco a cada
requisição. Toda desativação fica registrada em `auditoria_exclusoes`.

### Travas contra ficar sem administrador

O sistema recusa, com `409`, qualquer operação que deixasse ninguém no comando:

- desativar a própria conta;
- rebaixar a própria conta;
- desativar ou rebaixar o **último admin ativo**, mesmo sendo outra pessoa fazendo.

Sem isso, um clique distraído exigiria acesso por linha de comando para consertar.
A tela também esconde os botões correspondentes, mas a decisão é sempre do servidor:
o papel é relido do banco a cada requisição, então esconder botão é conveniência,
nunca a proteção.

> O campo `email` é `UNIQUE` e é o login. Use o e-mail real da pessoa,
> não o e-mail de notificações (`notificacoesraizes@gmail.com`).

## Retenção de dados pessoais (LGPD)

Existe uma rotina de expurgo. Ela **não está agendada** — roda só quando alguém pede.

```bash
npm run cron:retencao              # ensaio: lista quem seria anonimizado
npm run cron:retencao -- --anos=7  # ensaio com outro prazo
npm run cron:retencao -- --aplicar # apaga de verdade (pede confirmação digitada)
```

### O que ela faz

Apaga **nome, CPF, RG, endereço, e-mail e telefone** de devedores e alunos ligados
apenas a acordos encerrados há mais de N anos, e limpa o `snapshot_assinatura_json`
desses acordos.

A linha **não** é excluída, e o acordo, as parcelas e as baixas continuam
intactos: some o dado pessoal, fica o registro financeiro. A linha é marcada com
`anonimizado_em`, e cada expurgo entra em `auditoria_exclusoes`.

### Quem é preservado

Uma pessoa só é anonimizada quando **todos** os acordos dela estão encerrados
(`quitado` ou `cancelado`) e vencidos de prazo. Um único acordo em aberto,
inadimplente ou encerrado há pouco preserva o cadastro inteiro.

O prazo conta a partir do último fato do acordo: o último pagamento; na falta
dele, o último vencimento; na falta dos dois, a última atualização.

### O prazo

Padrão de **5 anos**, configurável em `RETENCAO_ANOS`. O número vem da orientação
usual de 5 anos após a quitação (prescrição do CDC).

> ⚠️ **Isso é decisão jurídica do colégio, não do software.** Confirme o prazo com
> a assessoria antes de aplicar pela primeira vez. A anonimização é irreversível:
> o dado não volta, nem por backup já rotacionado.

### Antes de agendar

Rode o ensaio, confira a lista, aplique uma vez à mão. Só depois, se quiser
automatizar, acrescente ao `vercel.json`:

```json
{ "path": "/api/cron/retencao?aplicar=1", "schedule": "0 5 1 * *" }
```

Sem `aplicar=1` o endpoint responde o ensaio e não altera nada — uma chamada
acidental, ou um agendamento posto sem querer, não apaga nada.

### Texto dos fechos — revisão jurídica obrigatória

> ⚠️ **Os três textos abaixo são rascunhos funcionais e precisam de revisão pela
> assessoria jurídica do colégio antes de entrar em produção.**

Ponto específico a confirmar com a assessoria: o gov.br entrega o relatório de
conferência embutido no PDF assinado. Qualquer cláusula que trate esse relatório como
peça separada precisa ser relida à luz disso.

Texto atualmente em uso no modo eletrônico:
> "...cuja integridade é conferida pela plataforma de assinatura digital utilizada,
> dispensada a assinatura de testemunhas na forma do art. 784, §4º, do Código de Processo
> Civil (Lei nº 14.620/2023). A autenticidade pode ser verificada no portal da plataforma
> pelo código de autenticação do documento."

Redação exata do §4º (Lei nº 14.620/2023):
> "Nos títulos executivos constituídos ou atestados por meio eletrônico, é admitida
> qualquer modalidade de assinatura eletrônica prevista em lei, dispensada a assinatura
> de testemunhas quando sua integridade for conferida por provedor de assinatura."

---

## 6. Observações

- Cabeçalho, rodapé e marca d'água estão embutidos no `index.html` em base64: não existe
  pasta de imagens para quebrar.
- **Imprimir / PDF** usa o navegador (Chrome recomendado). Nas opções de impressão, mantenha
  margens padrão e desmarque "Cabeçalhos e rodapés" do próprio navegador.
- **Baixar Word** gera um `.doc` com o timbrado como cabeçalho e rodapé reais, repetidos em
  todas as páginas. No Word, salve como `.docx` para editar com conforto.
- Os textos das cláusulas usam tokens (`{{total}}`, `{{multaPenal}}`, `{{ref:mora}}`…) que se
  atualizam sozinhos quando você muda os campos ou a ordem das cláusulas.

> ⚠️ **Revisão jurídica obrigatória.** Todo o texto gerado pelo app — cláusulas,
> fecho e eleição de foro — deve ser revisado pela assessoria jurídica do colégio
> antes de entrar em uso em produção.
