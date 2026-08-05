# Gerador de Acordo — publicação e salvamento na nuvem

Site estático de um arquivo só. Não tem servidor, não tem banco: tudo roda no navegador
e o salvamento vai direto para o Google Drive de quem está usando.

```
/
├── index.html     ← o gerador inteiro (logo e marca d'água já embutidos)
├── vercel.json
└── README.md
```

---

## 1. Publicar no Vercel

### Caminho rápido (sem GitHub)

1. Instale o Node.js e rode no terminal, dentro desta pasta:
   ```bash
   npm i -g vercel
   vercel
   ```
2. Responda as perguntas (aceite os padrões). O deploy de produção sai com:
   ```bash
   vercel --prod
   ```
3. O Vercel devolve a URL, algo como `https://gerador-acordo.vercel.app`.

### Caminho com GitHub (recomendado para editar depois)

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

## 4. Configurar Assinatura Digital (Adobe Acrobat Sign)

O endpoint de assinatura vive em `/api/adobe-sign` e precisa das seguintes variáveis de
ambiente configuradas no painel do Vercel (**Settings → Environment Variables**):

| Variável | Descrição | Onde obter |
|---|---|---|
| `ADOBE_SIGN_INTEGRATION_KEY` | Chave de integração da conta Adobe Sign | Adobe Sign → Conta → Adobe Sign API → Integration Key |
| `ADOBE_SIGN_REGION` | Região da conta (padrão: `na4`) | `na1`/`na2`/`na4`/`eu1`/`eu2`/`au1`/`jp1`/`in1` |
| `APP_ACCESS_TOKEN` | Segredo compartilhado cliente↔servidor | Gere com `openssl rand -hex 32` |
| `ALLOWED_ORIGIN` | URL do Vercel sem barra final | ex.: `https://geradordeacordo.vercel.app` |
| `ASSINATURA_PROVIDER` | Provedor ativo (padrão: `manual`) | `manual` ou `adobe` |

**Após configurar as variáveis no Vercel**, edite o `index.html` e defina a mesma string em:

```js
const APP_TOKEN = 'cole_aqui_o_mesmo_valor_de_APP_ACCESS_TOKEN';
```

Para testar localmente, copie `.env.example` para `.env.local` (não commitado), preencha os
valores e use `vercel dev`.

### Segurança do endpoint

O `/api/adobe-sign` usa duas camadas de proteção:

1. **`APP_ACCESS_TOKEN`** — header `X-App-Token` exigido em toda requisição. É o controle de
   acesso real; sem ele, qualquer `curl` externo recebe `401`. Quando a variável não está
   configurada (ambiente de dev), o check é pulado.

2. **`ALLOWED_ORIGIN`** — verifica o header `Origin`/`Referer`. É camada adicional, *não*
   única, pois headers são escolhidos pelo cliente e podem ser falsificados por scripts
   não-browser.

### Rate limit (best-effort)

O endpoint limita a 10 requisições por minuto por IP. Este limite é **por instância** do
servidor Vercel — em ambientes com múltiplas instâncias paralelas, o limite real é
10 × número de instâncias ativas. O controle de acesso real é o `APP_ACCESS_TOKEN`; o
rate limit é apenas amortecedor contra repetição acidental ou abuso básico. Para limite
global garantido, seria necessário migrar o contador para um KV externo (ex.: Vercel KV).

---

## 5. Assinatura digital (ZapSign) e persistência de PDFs

### Conta de serviço Google (Service Account)

O webhook `/api/assinatura/webhook` recebe o evento `doc_signed` da ZapSign, baixa o PDF assinado
do URL temporário (expira em 60 min) e sobe para o Google Drive usando uma **conta de serviço** —
não a conta pessoal de ninguém.

**Pré-requisitos:**

1. Google Workspace (Drive Compartilhado). Arquivos criados por SA em "Meu Drive" pessoal ficam
   sob cota da SA e podem ser bloqueados por políticas de Workspace. Use um **Drive Compartilhado**
   da escola onde a SA tenha acesso de Contribuidor.
2. No Google Cloud Console:
   - Ative a **Google Drive API** no projeto.
   - Crie uma Service Account (IAM → Service Accounts → Create).
   - Gere e baixe a chave JSON (Manage keys → Add key → JSON).
3. Compartilhe a pasta do Drive Compartilhado com o e-mail da SA
   (`nome@projeto.iam.gserviceaccount.com`) — papel: **Contribuidor**.
4. Copie o ID da pasta da URL do Drive: `https://drive.google.com/drive/folders/`**`ID`**.

**Formato da variável `GOOGLE_SERVICE_ACCOUNT_JSON`:**

O JSON da SA contém quebras de linha na `private_key`. Alguns painéis de variáveis
(incluindo o da Vercel) interpretam incorretamente. Use **base64** para evitar o problema:

```bash
# macOS / Linux
base64 -w0 service-account.json   # -w0 = sem quebra de linha

# PowerShell (Windows)
[Convert]::ToBase64String([IO.File]::ReadAllBytes("service-account.json"))
```

Cole o resultado (uma linha só, sem espaços) em `GOOGLE_SERVICE_ACCOUNT_JSON`.
O código aceita tanto JSON direto quanto base64 do JSON.

**Variáveis de ambiente no Vercel (Settings → Environment Variables):**

| Variável | Obrigatória para `doc_signed` | Descrição |
|---|---|---|
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Sim | JSON da SA ou base64 do JSON |
| `DRIVE_PDF_FOLDER_ID` | Sim | ID da pasta no Drive Compartilhado |
| `ZAPSIGN_WEBHOOK_SECRET` | Sim | Segredo do webhook (painel ZapSign) |
| `ZAPSIGN_API_TOKEN` | Sim (envio) | Token da API ZapSign |
| `ZAPSIGN_VALIDATE_CPF` | Não | `true` para validar CPF na Receita; testar antes de ativar |

> **Sem `GOOGLE_SERVICE_ACCOUNT_JSON` configurado:** o webhook responde `500` no evento
> `doc_signed` e a ZapSign reenvia. Não há fallback silencioso.

### LGPD — dados pessoais persistidos

A pasta indicada em `DRIVE_PDF_FOLDER_ID` acumula documentos sensíveis:

| Arquivo | Conteúdo | Base legal (LGPD) |
|---|---|---|
| `Assinado-{externalId}.pdf` | CPF, nome, endereço dos responsáveis e dados de menores | Art. 7º, V (execução de contrato) |
| `_eventos_webhook.json` | Tokens ZapSign (sem PII) | Legítimo interesse (idempotência) |

**Requisitos mínimos:**
- Compartilhe a pasta **somente** com a conta de serviço e com as pessoas da secretaria.
  Nunca use "Qualquer pessoa com o link".

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

## Primeiro usuário (cadastro manual)

Enquanto não houver tela de gerenciamento, o primeiro usuário é criado via `psql`.
**Crie como `admin`** — sem um admin, nenhum outro usuário pode ser criado depois.

```sql
-- Gere o hash da senha com: npm run hash
INSERT INTO usuarios (nome, email, hash_senha, papel)
VALUES (
  'Nome da Secretaria',
  'email-real@dominio.com.br',  -- campo UNIQUE; é o login
  '$2a$10$...',                  -- hash gerado por npm run hash
  'admin'
);
```

> O campo `email` é `UNIQUE`. Use o e-mail real da pessoa que vai administrar o sistema,
> não o e-mail de notificações (`notificacoesraizes@gmail.com`).
- Defina prazo de retenção antes de colocar em produção (sugestão: 5 anos após quitação
  ou conforme orientação jurídica e PROCON).
- A Fase E implementará exclusão automática via rotina agendada.

### Política de retry da ZapSign

> ⚠️ **Não confirmado na documentação oficial.** O número abaixo (`MAX_RETRIES = 3`) é
> baseado em comportamento comumente observado em provedores de webhook — não em documentação
> explícita da ZapSign. Ajuste a constante em `webhook.js` após confirmar com o suporte
> ou com os logs do painel ZapSign → Integrações → Webhooks → Histórico.

Comportamento assumido (confirmar com ZapSign antes de ir para produção):
- ~3 retentativas com backoff exponencial após falha ou timeout
- Após esgotar: ZapSign para de tentar

O webhook responde:
- `500` em falhas de `doc_signed` (para acionar retentativa)
- Após `MAX_RETRIES=3` falhas persistidas no Drive: responde `200` para parar o loop
  e grava em `_pendencias.json` (visível via `action=pendencias`)
- Logs: `[drive] 🔴 FALHA PERMANENTE` + ZapSign token para recuperação manual

**Recuperação manual após falha permanente:** o token ZapSign aparece no log e em
`_pendencias.json`. Com ele, acesse o painel ZapSign → Documentos → busca pelo token
para baixar o PDF assinado manualmente.

**Dependência circular:** se a falha for no Drive (e não na ZapSign), `marcarFalha`
não consegue gravar. Nesse caso, o ZapSign token ainda aparece nos logs do Vercel como
último recurso. Substitua por banco de dados na Fase E.

### Texto dos fechos — revisão jurídica obrigatória

> ⚠️ **Os três textos abaixo são rascunhos funcionais e precisam de revisão pela
> assessoria jurídica do colégio antes de entrar em produção.**

Ponto específico a confirmar: a ZapSign entrega o relatório de auditoria **embutido** no
PDF assinado ou como arquivo separado? Se vier separado, qualquer cláusula que afirme
que o relatório "integra este instrumento" ou é "indissociável deste" cria contradição
com o documento em si.

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
