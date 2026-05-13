# Follow-up Dashboard — ML Margem

Dashboard de lucratividade para vendedores do Mercado Livre.

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

1. Copie a URL gerada (ex: `https://followup-dashboard.vercel.app`)
2. Cole essa URL como **Redirect URI** no seu App do Mercado Livre
3. Acesse o dashboard pela URL e clique em "Conectar ML"

## Funcionalidades

- ✅ Margem de lucro por anúncio
- ✅ Margem por pedido
- ✅ Score de qualidade dos anúncios (critérios do ML)
- ✅ Análise com IA (Claude) com sugestões de melhoria
- ✅ Cálculo automático de tarifas do ML por categoria
- ✅ KPIs: receita líquida, lucro, tarifas, margem média
