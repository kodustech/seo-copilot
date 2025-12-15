# SEO Copilot

Copiloto em Next.js com UI estilo Notion usando shadcn/ui para gerar ideias de keywords, títulos e artigos completos. Toda a persistência agora acontece no próprio fluxo do n8n, enquanto a autenticação é controlada via Supabase Auth (somente para proteger o acesso à interface).

## Pré-requisitos

- Node.js 18+
- Projeto Supabase (usado apenas para autenticação)

## Como rodar

1. Copie o arquivo de variáveis:

   ```bash
   cp .env.example .env.local
   ```

2. Preencha o `.env.local` com:

   - `NEXT_PUBLIC_SUPABASE_URL` e `NEXT_PUBLIC_SUPABASE_ANON_KEY` para habilitar o login (os valores públicos do seu projeto Supabase)
   - `NEXT_PUBLIC_ALLOWED_DOMAIN` para restringir o domínio (por padrão `@kodus.io`)
   - `N8N_KEYWORDS_ENDPOINT`, `N8N_KEYWORDS_STATUS_ENDPOINT`, `N8N_KEYWORDS_HISTORY_ENDPOINT`, `N8N_TITLES_ENDPOINT`, `N8N_SOCIAL_ENDPOINT`, `N8N_POST_ENDPOINT`, `N8N_ARTICLES_ENDPOINT` caso precise sobrescrever os padrões
   - `N8N_BEARER_TOKEN` se os webhooks exigirem autenticação

3. Instale dependências e inicie:

   ```bash
   npm install
   npm run dev
   ```

A interface em `/` já traz todo o fluxo: dois botões para gerar keywords (com ou sem ideia), multi-seleção para gerar títulos, e um bloco final para gerar e visualizar o artigo. Tudo foi construído com componentes shadcn (button, card, table, checkbox etc.) seguindo o visual minimalista do Notion.

### Parâmetros extras na geração de keywords

- Você pode definir o país (Brasil ou Estados Unidos) e o idioma (pt/en) diretamente na primeira seção da UI. Os valores são enviados ao webhook como `location_code` (2076 ou 2840) e `language` (`pt` ou `en`).

### Como funciona a fila de keywords

- O POST em `N8N_KEYWORDS_ENDPOINT` retorna somente o identificador da task. O front guarda esse ID e começa a checar `N8N_KEYWORDS_STATUS_ENDPOINT?task_id=<id>`.
- Enquanto o webhook ainda processa, o endpoint de status responde `[]`. Assim que termina, retorna a lista completa de keywords (cada item com `keyword`, `search_volume`, `cpc`, `competition`, etc.).
- Quando o app detecta que a lista chegou, ele apenas atualiza o UI automaticamente (sem gravar em banco). Todo o armazenamento fica a cargo do n8n. Se quiser alterar o intervalo ou timeout de polling, ajuste o efeito em `components/seo-workspace.tsx`.
- O botão “Explorar histórico salvo” consulta `N8N_KEYWORDS_HISTORY_ENDPOINT`, permitindo reaproveitar keywords antigas (armazenadas via Supabase pelo fluxo do n8n) diretamente na etapa de geração de títulos.

### Geração de artigos

- Ao solicitar um artigo, enviamos um POST para `N8N_POST_ENDPOINT` com título, keyword selecionada, opções de pesquisa e instruções customizadas. O webhook retorna apenas o `taskId`.
- A UI passa a exibir o status da task e consulta periodicamente `N8N_ARTICLES_ENDPOINT?task_id=<id>` até que o conteúdo esteja pronto. Quando o texto chega, a prévia é atualizada automaticamente.
- O usuário também pode escolher categorias específicas (IDs fornecidos acima). Esses IDs são enviados na mesma requisição, permitindo que o n8n associe cada artigo a uma taxonomia no Supabase.
