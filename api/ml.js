// api/ml.js
// Proxy para a API do Mercado Livre + rotas internas /_users e /_sync.
// As rotas internas agora EXIGEM sessão do aplicativo (cookie assinado emitido
// pelo /api/auth/app-login) — antes eram públicas, o que permitia a qualquer
// pessoa ler/alterar usuários e dados do negócio.

import {
  kvGet,
  kvSet,
  lerUsuarios,
  salvarUsuarios,
  hashSenha,
  verificarSessao,
  semSenha,
} from "./_lib/auth.js";

// Chaves de dados de negócio que ficam sincronizadas entre TODOS os usuários (não só no
// navegador de quem editou) — cada uma vira uma entrada no KV, prefixada para não colidir
// com outras chaves.
const SYNC_KEYS_PERMITIDAS = [
  "notas_fiscais_entrada",
  "costs_config",
  "fretes_config",
  "precos_venda_config",
  "descontos_config",
  "produtos_cadastro",
  "fornecedores_cadastro",
  "contas_pagar",
  "contas_bancarias",
  "categorias_pagar",
  "custos_fixos_config",
  "impostos_config",
  "irpj_csll_config",
  "icms_por_estado",
  "lancamentos",
  "mov_estoque",
  "metaMensal",
  "min_stock_anuncios",
  "real_fees_config",
  "pedidos_compra",
  "precificacao_extras",
  "precos_pendentes_ml",
  "depositos_estoque",
  "estoque_depositos",
  "envios_full",
  "vendas_estoque_baixadas",
  "chat_interno_mensagens",
  "chat_interno_tarefas",
];

export default async function handler(req, res) {
  const path = req.url.replace(/^\/api\/ml/, "");

  // ── Rota de usuários — exige sessão do app; escrita exige admin ──
  if (path === "/_users" || path.startsWith("/_users?")) {
    const sessao = await verificarSessao(req);
    if (!sessao) {
      return res.status(401).json({ error: "Não autenticado. Faça login no sistema." });
    }

    if (req.method === "GET") {
      const usuarios = await lerUsuarios();
      return res.status(200).json(usuarios.map(semSenha));
    }

    if (req.method === "POST") {
      if (!sessao.admin) {
        return res.status(403).json({ error: "Apenas administradores podem alterar usuários." });
      }
      const body = req.body;
      if (!body || !Array.isArray(body.usuarios)) {
        return res.status(400).json({ error: "Formato inválido" });
      }
      const atual = await lerUsuarios();
      const mapaAtual = {};
      atual.forEach(function(u) { mapaAtual[u.id] = u; });

      // "senhas" traz as senhas novas em texto (só sobre HTTPS) — o hash é
      // calculado AQUI com scrypt; o navegador nunca gera nem armazena hashes.
      const senhas = body.senhas || {};
      const novos = body.usuarios.map(function(u) {
        const limpo = Object.assign({}, u);
        delete limpo.senha;
        delete limpo.senhaHash;
        const existente = mapaAtual[u.id] || {};
        return Object.assign({}, existente, limpo, {
          senhaHash: senhas[u.id] ? hashSenha(senhas[u.id]) : existente.senhaHash || null,
        });
      });
      await salvarUsuarios(novos);
      return res.status(200).json({ ok: true, total: novos.length });
    }

    return res.status(405).json({ error: "Method not allowed" });
  }

  // ── Rota de sincronização de dados de negócio — exige sessão do app ──
  if (path === "/_sync" || path.startsWith("/_sync?")) {
    const sessao = await verificarSessao(req);
    if (!sessao) {
      return res.status(401).json({ error: "Não autenticado. Faça login no sistema." });
    }

    if (req.method === "GET") {
      const key = new URLSearchParams(path.split("?")[1] || "").get("key");
      if (!key || !SYNC_KEYS_PERMITIDAS.includes(key)) {
        return res.status(400).json({ error: "Chave de sincronização inválida" });
      }
      const value = await kvGet("mlmargem_sync_" + key);
      return res.status(200).json({ key, value: value ?? null });
    }

    if (req.method === "POST") {
      const body = req.body || {};
      const key = body.key;
      if (!key || !SYNC_KEYS_PERMITIDAS.includes(key)) {
        return res.status(400).json({ error: "Chave de sincronização inválida" });
      }
      await kvSet("mlmargem_sync_" + key, body.value);
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: "Method not allowed" });
  }

  // ── Proxy normal ML — exige token ──
  const cookies = Object.fromEntries(
    (req.headers.cookie || "").split(";").map(c => {
      const [k, ...v] = c.trim().split("=");
      return [k.trim(), v.join("=")];
    })
  );

  // Prioriza o header Authorization: o front-end renova o token ativamente (getValidToken) e
  // sempre envia o valor mais atual nesse header. O cookie ml_access_token só é usado como
  // fallback, pois pode ficar desatualizado entre renovações e "esconder" um token mais novo.
  let token = req.headers.authorization ? req.headers.authorization.replace("Bearer ", "") : null;
  if (!token) {
    token = cookies.ml_access_token;
  }
  // Último fallback: a conexão do PRÓPRIO usuário do sistema salva no KV (quando este
  // navegador ainda não enviou o header e não tem cookie). Isolada por usuário — nunca
  // usa o token de outra conta.
  if (!token) {
    const sessao = await verificarSessao(req);
    if (sessao && sessao.uid) {
      const meu = await kvGet("mlmargem_ml_token_" + sessao.uid);
      if (meu && meu.accessToken) token = meu.accessToken;
    }
  }

  if (!token) {
    return res.status(401).json({ error: "Não autenticado. Faça login com o Mercado Livre." });
  }

  const mlUrl = `https://api.mercadolibre.com${path}`;

  try {
    const mlRes = await fetch(mlUrl, {
      method: req.method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: req.method !== "GET" && req.method !== "HEAD" ? JSON.stringify(req.body) : undefined,
    });

    if (mlRes.status === 401) {
      // Sempre tenta renovar — o endpoint /api/auth/refresh já sabe usar o refresh_token do
      // cookie deste navegador OU, se não houver, o da conexão compartilhada da equipe.
      try {
        const refreshRes = await fetch(`${process.env.VERCEL_URL ? "https://" + process.env.VERCEL_URL : ""}/api/auth/refresh`, {
          method: "POST",
          headers: { cookie: req.headers.cookie || "" },
        });
        if (refreshRes.ok) {
          const refreshData = await refreshRes.json();
          const retryRes = await fetch(mlUrl, {
            method: req.method,
            headers: {
              Authorization: `Bearer ${refreshData.access_token}`,
              "Content-Type": "application/json",
              "Accept": "application/json",
            },
            body: req.method !== "GET" ? JSON.stringify(req.body) : undefined,
          });
          const setCookie = refreshRes.headers.get("set-cookie");
          if (setCookie) res.setHeader("Set-Cookie", setCookie);
          const data = await retryRes.json();
          return res.status(retryRes.status).json(data);
        }
      } catch (e) {}
      return res.status(401).json({ error: "Token expirado. Reconecte ao Mercado Livre." });
    }

    const data = await mlRes.json();
    return res.status(mlRes.status).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
