// api/ml.js
// Proxy para a API do Mercado Livre + rota interna /_users (sem exigir token ML)
import { kvGet, kvSet, SHARED_ML_TOKEN_KEY } from "./_kv.js";

let _usersCache = null;

// Chaves de dados de negócio que ficam sincronizadas entre TODOS os usuários (não só no
// navegador de quem editou) — cada uma vira uma entrada no KV, prefixada para não colidir
// com outras chaves. Adicione aqui outras coleções se quiser expandir a sincronização.
const SYNC_KEYS_PERMITIDAS = [
  "notas_fiscais_entrada",
  "costs_config",
  "fretes_config",
  "precos_venda_config",
  "descontos_config",
];

const ADMIN_PADRAO = [{
  id: "admin",
  nome: "Administrador",
  usuario: "admin",
  senhaHash: "1143424611",
  ativo: true,
  admin: true,
  permissoes: ["overview","listings","orders","financeiro","produtos","admin","nfe","full"],
  criadoEm: new Date().toISOString().slice(0,10),
}];

async function lerUsuarios() {
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    try {
      const r = await fetch(process.env.KV_REST_API_URL + "/get/mlmargem_users", {
        headers: { Authorization: "Bearer " + process.env.KV_REST_API_TOKEN }
      });
      const d = await r.json();
      if (d && d.result) return JSON.parse(d.result);
    } catch {}
  }
  return _usersCache || ADMIN_PADRAO;
}

async function salvarUsuarios(usuarios) {
  _usersCache = usuarios;
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    try {
      await fetch(process.env.KV_REST_API_URL + "/set/mlmargem_users", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + process.env.KV_REST_API_TOKEN,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ value: JSON.stringify(usuarios) })
      });
    } catch {}
  }
}

export default async function handler(req, res) {
  const path = req.url.replace(/^\/api\/ml/, "");

  // ── Rota de usuários — NÃO exige token do ML ──
  if (path === "/_users" || path.startsWith("/_users?")) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") return res.status(200).end();

    if (req.method === "GET") {
      const usuarios = await lerUsuarios();
      // Retorna sem senhaHash
      const seguros = usuarios.map(function(u) {
        const s = Object.assign({}, u);
        delete s.senhaHash;
        return s;
      });
      return res.status(200).json(seguros);
    }

    if (req.method === "POST") {
      const body = req.body;
      if (!body || !Array.isArray(body.usuarios)) {
        return res.status(400).json({ error: "Formato inválido" });
      }
      const atual = await lerUsuarios();
      const mapaAtual = {};
      atual.forEach(function(u) { mapaAtual[u.id] = u; });

      const novos = body.usuarios.map(function(u) {
        const hashMap = body.senhaHashMap || {};
        return Object.assign(
          {},
          mapaAtual[u.id] || {},
          u,
          { senhaHash: hashMap[u.id] || (mapaAtual[u.id] && mapaAtual[u.id].senhaHash) || "1143424611" }
        );
      });
      await salvarUsuarios(novos);
      return res.status(200).json({ ok: true, total: novos.length });
    }

    return res.status(405).json({ error: "Method not allowed" });
  }

  // ── Rota de sincronização de dados de negócio — NÃO exige token do ML ──
  // Compartilha NF Entrada, custos/frete/preços de venda/descontos da Precificação entre
  // todos os usuários do sistema, independente do navegador/computador de cada um.
  if (path === "/_sync" || path.startsWith("/_sync?")) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") return res.status(200).end();

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
  // Último fallback: conexão compartilhada da equipe (quando este navegador nunca conectou
  // e por algum motivo o front-end ainda não tinha enviado o header com o token compartilhado).
  if (!token) {
    const shared = await kvGet(SHARED_ML_TOKEN_KEY);
    if (shared && shared.accessToken) token = shared.accessToken;
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
