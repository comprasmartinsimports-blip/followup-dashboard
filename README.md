# Flow Marketplaces

**Link do sistema:** https://flowmarketplaces.vercel.app

Sistema focado em integração com marketplaces (Mercado Livre): visualizar **anúncios** com sugestões de melhoria, acompanhar **pedidos**, **precificação** por anúncio e comparação com a **concorrência** (mais vendidos da categoria).

> Dashboards, financeiro, notas fiscais e cadastro de produtos **não fazem mais parte deste sistema** — essas funções vivem em outro local. Os dados antigos desses módulos continuam salvos no KV e podem ser exportados pela aba Backup.

## Segurança / Variáveis de ambiente (Vercel → Settings → Environment Variables)

| Variável | Obrigatória | Descrição |
|---|---|---|
| `ANTHROPIC_API_KEY` | Para usar IA | Chave da Anthropic — fica **somente no servidor** (proxy `/api/ai-chat`). **Nunca** use `VITE_ANTHROPIC_KEY`: qualquer variável `VITE_*` é embutida no JavaScript público e visível para qualquer visitante. Se você já usou `VITE_ANTHROPIC_KEY` antes, **revogue essa chave** no console da Anthropic e gere uma nova. |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | Recomendada | Vercel KV / Upstash — persistência de usuários, sessões e dados sincronizados. |
| `SESSION_SECRET` | Recomendada | Segredo para assinar o cookie de sessão do app (qualquer string longa e aleatória). Sem ela, um segredo é gerado e salvo no KV. |
| `ADMIN_INITIAL_PASSWORD` | Recomendada | Senha inicial do usuário `admin` na primeira execução (padrão: `admin123` — troque no primeiro acesso). |
| `ML_APP_ID` / `ML_APP_SECRET` / `ML_REDIRECT_URI` | Para conectar ao ML | Credenciais OAuth do app no Mercado Livre. |

O login dos usuários do sistema é validado **no servidor** (`/api/auth/app-login`, hash scrypt),
que emite um cookie httpOnly assinado. As rotas internas `/api/ml/_users`, `/api/ml/_sync` e
`/api/ai-chat` exigem esse cookie; alterações de usuários exigem perfil administrador.

## Como subir no Vercel

### Opção 1 — Via GitHub (recomendado)
1. Crie um repositório no [github.com](https://github.com)
2. Faça upload de todos os arquivos desta pasta
3. Acesse [vercel.com](https://vercel.com) → "Add New Project"
4. Importe o repositório do GitHub
5. Clique em **Deploy** — pronto!

### Opção 2 — Via Vercel CLI
```bash
npm install -g vercel
vercel login
vercel --prod
```

### Opção 3 — Upload direto
1. Acesse [vercel.com](https://vercel.com)
2. "Add New Project" → "Deploy from template" não é necessário
3. Arraste a pasta do projeto direto na tela do Vercel

## Após o deploy

1. A URL do sistema é `https://flowmarketplaces.vercel.app`
2. Configure a variável `ML_REDIRECT_URI` no Vercel e o **Redirect URI** no App do Mercado Livre com o mesmo endereço de retorno:
   `https://flowmarketplaces.vercel.app/api/auth/callback`
3. Acesse o sistema pela URL e clique em "Conectar ML"

## Funcionalidades

- ✅ Margem de lucro por anúncio
- ✅ Margem por pedido
- ✅ Score de qualidade dos anúncios (critérios do ML)
- ✅ Análise com IA (Claude) com sugestões de melhoria
- ✅ Cálculo automático de tarifas do ML por categoria
- ✅ KPIs: receita líquida, lucro, tarifas, margem média
