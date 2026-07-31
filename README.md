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

## Observações

- Cabeçalho, rodapé e marca d'água estão embutidos no `index.html` em base64: não existe
  pasta de imagens para quebrar.
- **Imprimir / PDF** usa o navegador (Chrome recomendado). Nas opções de impressão, mantenha
  margens padrão e desmarque "Cabeçalhos e rodapés" do próprio navegador.
- **Baixar Word** gera um `.doc` com o timbrado como cabeçalho e rodapé reais, repetidos em
  todas as páginas. No Word, salve como `.docx` para editar com conforto.
- Os textos das cláusulas usam tokens (`{{total}}`, `{{multaPenal}}`, `{{ref:mora}}`…) que se
  atualizam sozinhos quando você muda os campos ou a ordem das cláusulas.
