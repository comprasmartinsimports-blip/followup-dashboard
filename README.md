# Flow Marketplaces

**Link do sistema:** https://flowmarketplaces.vercel.app

Sistema de gestão para vendas em marketplaces, integrado ao **Mercado Livre**. Puxa anúncios e
pedidos da conta conectada e, em cima disso, calcula margem real por anúncio e por venda —
descontando tarifa do marketplace, frete pago pelo vendedor, custo do produto e impostos.

Além da parte de marketplace, o sistema cobre a operação e o financeiro: estoque, compras,
notas fiscais, contas a pagar e receber, DRE, cadastros e relatórios.

## Módulos

| Grupo | Telas |
|---|---|
| **Dashboard** | Visão geral, vendas por estado (mapa), margem, clientes, curva ABC e metas |
| **Operação** | Produtos · Anúncios · Vincular anúncios · Precificação · Vendas · Expedição · Compras · Estoque · Notas fiscais |
| **Financeiro** | Contas a pagar · Contas a receber · DRE e conciliação |
| **Cadastro** | Clientes · Fornecedores |
| **Inteligência** | Relatórios (análises e curva ABC) · Concorrência (vigia de preços) |
| **Configuração** | Equipe (usuários e permissões) · Impostos · Integrações · Backup |

Ainda há chat interno entre os usuários e alertas automáticos no sino (margem negativa,
contas vencendo e ruptura de estoque prevista).

## Impostos e ICMS

No menu **Configuração → Impostos** ficam as alíquotas que entram na margem:

- **ICMS sobre a venda** — dois modos:
  - **Por destino** (padrão): define a UF de origem da empresa, a alíquota das vendas **dentro**
    dela e a das vendas **para os demais estados**. O padrão configurado é **SP como origem, 0%
    dentro de SP e 4% interestadual** (alíquota de mercadoria importada). A alíquota é aplicada
    pedido a pedido, conforme a UF de entrega do comprador; pedido sem UF conhecida assume a
    interestadual.
  - **Tabela por estado**: uma alíquota livre por UF de destino, para regimes que não cabem na
    regra dentro/fora do estado.
  - Um checkbox liga e desliga o ICMS sem apagar as alíquotas configuradas.
- **IRPJ e CSLL** (Lucro Real) e **custos fixos mensais**, usados na apuração do resultado.
- Outros impostos percentuais sobre a venda podem ser cadastrados como itens e são somados ao ICMS.

Onde ainda não existe comprador — **Anúncios** e **Precificação** — a projeção usa a alíquota
interestadual, que é o caso mais comum e o mais conservador. A tela de Precificação desconta o
ICMS do lucro e o inclui no cálculo do preço alvo, e mostra no topo a alíquota aplicada.

## Segurança / Variáveis de ambiente (Vercel → Settings → Environment Variables)

| Variável | Obrigatória | Descrição |
|---|---|---|
| `ANTHROPIC_API_KEY` | Para usar IA | Chave da Anthropic — fica **somente no servidor** (proxy `/api/ai-chat`). **Nunca** use `VITE_ANTHROPIC_KEY`: qualquer variável `VITE_*` é embutida no JavaScript público e visível para qualquer visitante. Se você já usou `VITE_ANTHROPIC_KEY` antes, **revogue essa chave** no console da Anthropic e gere uma nova. |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | Opcional | Vercel KV / Upstash. Reserva: sem `SUPABASE_DB_URL`, é aqui que usuários e dados sincronizados são gravados. Com o banco configurado, serve só de espelho. |
| `SESSION_SECRET` | Recomendada | Segredo para assinar o cookie de sessão do app (qualquer string longa e aleatória). Sem ela, um segredo é gerado e salvo no KV. |
| `ADMIN_INITIAL_PASSWORD` | Recomendada | Senha inicial do usuário `admin` na primeira execução (padrão: `admin123` — troque no primeiro acesso). |
| `ML_APP_ID` / `ML_APP_SECRET` / `ML_REDIRECT_URI` | Para conectar ao ML | Credenciais OAuth do app no Mercado Livre. |
| `BLING_CLIENT_ID` / `BLING_CLIENT_SECRET` / `BLING_REDIRECT_URI` | Para conectar ao Bling | Credenciais OAuth do aplicativo criado no Bling (API v3). O redirect precisa ser exatamente `https://flowmarketplaces.vercel.app/api/bling/callback`, igual ao cadastrado no Bling. |
| `SUPABASE_DB_URL` | Recomendada | Connection string do Postgres do Supabase (pooler de transação). É o armazenamento principal: usuários (`flow.usuario`), dados de negócio (`flow.sync_store`) e o cache de anúncios/pedidos do ML. Sem ela o sistema cai no Vercel KV. |
| `ADMIN_RECOVERY_PASSWORD` | Opcional | Acesso de emergência (break-glass): quem souber essa senha entra como admin, reativa a conta e redefine a senha dela para esse valor. Só habilite quando precisar recuperar o acesso, e remova a variável depois. |
| `CRON_SECRET` | Para o cron | Segredo exigido pelo endpoint `/api/ml/_cron_sync`, que sincroniza o cache de todas as contas do ML. Sem ela o endpoint responde 403. Requer `SUPABASE_DB_URL`. |

O login dos usuários do sistema é validado **no servidor** (`/api/auth/app-login`, hash scrypt),
que emite um cookie httpOnly assinado. As rotas internas `/api/ml/_users`, `/api/ml/_sync` e
`/api/ai-chat` exigem esse cookie; alterações de usuários exigem perfil administrador.

Os usuários ficam em `flow.usuario` no Postgres, com o KV como reserva. Se nenhum dos dois
estiver configurado, criar usuário é **recusado** com essa explicação — antes a operação
respondia sucesso e o cadastro se perdia, e o usuário não conseguia entrar depois.

## Integrações

- **Mercado Livre** — conexão por OAuth; traz anúncios, pedidos, frete e tarifas reais.
- **Bling** — conexão por OAuth 2.0 (API v3). O botão *Conectar* leva à autorização do Bling; o
  servidor troca o código pelo token, guarda em `flow.conexao_bling` e renova sozinho pelo refresh
  token. Nenhuma credencial passa pelo navegador. O botão *Sincronizar agora* importa produtos e
  custos, saldos de estoque, contas a pagar e receber e notas fiscais para as tabelas `flow.bling_*`,
  e mostra um relatório por entidade — uma que falhe não impede as outras.
  `GET /api/bling/diagnostico` (admin) testa cada endpoint da API e diz qual respondeu o quê.

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

## Após o deploy

1. A URL do sistema é `https://flowmarketplaces.vercel.app`
2. Configure a variável `ML_REDIRECT_URI` no Vercel e o **Redirect URI** no App do Mercado Livre com o mesmo endereço de retorno:
   `https://flowmarketplaces.vercel.app/api/auth/callback`
3. Acesse o sistema pela URL e clique em "Conectar ML"
4. Em **Configuração → Impostos**, confira a UF de origem e as alíquotas de ICMS antes de usar a margem para decidir preço

## Desenvolvimento local

```bash
npm install
npm run dev     # http://localhost:5173
npm run build   # build de produção
```

As rotas `/api/*` são funções serverless do Vercel — no `npm run dev` elas não sobem junto;
use `vercel dev` para testar o backend localmente.

## Funcionalidades

- ✅ Margem de lucro por anúncio e por pedido, com tarifa real do ML quando disponível
- ✅ ICMS por destino da venda (dentro x fora do estado de origem), IRPJ, CSLL e custos fixos
- ✅ Precificação com margem alvo, já descontando taxas, frete e ICMS
- ✅ Score de qualidade dos anúncios (critérios do ML)
- ✅ Análise com IA (Claude) com sugestões de melhoria
- ✅ KPIs: receita líquida, lucro, tarifas, margem média
- ✅ Vendas por estado, curva ABC, clientes recorrentes e metas
- ✅ Estoque, compras, contas a pagar/receber e DRE
- ✅ Usuários com permissões por módulo e dados sincronizados entre a equipe
- ✅ Backup e exportação dos dados
