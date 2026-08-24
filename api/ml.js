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
  normalizarLogin,
  kvConfigurado,
  ErroPersistencia,
} from "./_lib/auth.js";
import { dbEnabled, syncGet, syncSet, upsertConexaoMl, listConexoesMl, listCacheListings, listCacheOrders, getConexaoMl } from "./_lib/db.js";
import { syncListings, syncOrders, garantirToken, syncOneListing, syncOneOrder } from "./_lib/mlsync.js";

// A sincronização do cache do ML (/_sync_ml) puxa centenas de itens — pede mais tempo que o
// padrão de 10s. O Vercel limita ao teto do plano se este valor for maior.
export const config = { maxDuration: 60 };

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
  "icms_regime_config",
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
  "sku_overrides",
];

function falhaPersistencia(e) {
  const detalhe = e instanceof ErroPersistencia ? " (" + e.message + ")" : "";
  return "Armazenamento de usuários indisponível" + detalhe + ". Nada foi alterado — tente de novo em instantes.";
}

export default async function handler(req, res) {
  const path = req.url.replace(/^\/api\/ml/, "");

  // ── Webhook do Mercado Livre (notificações) — PÚBLICO (o ML chama sem sessão) ──
  // Atualiza APENAS o item/pedido que mudou, em tempo real. Responde 200 rápido; se algo
  // falhar, engole o erro (o cron a cada 15 min é a rede de segurança). Valida o app pelo
  // application_id e só sincroniza contas conhecidas (com token salvo em flow.conexao_ml).
  if (path === "/webhook" || path.startsWith("/webhook?")) {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    body = body || {};
    const topic = String(body.topic || "");
    const resource = String(body.resource || "");
    const sellerId = body.user_id ? String(body.user_id) : null;
    // Ignora notificações de outro app (quando ML_APP_ID está configurado).
    if (process.env.ML_APP_ID && body.application_id && String(body.application_id) !== String(process.env.ML_APP_ID)) {
      return res.status(200).json({ ok: true, ignored: "application_id" });
    }
    try {
      if (dbEnabled() && sellerId && resource) {
        const conexao = await getConexaoMl(sellerId);
        if (conexao) {
          const token = await garantirToken(conexao);
          if (token) {
            const rid = resource.split("/").filter(Boolean).pop();
            if (topic.indexOf("item") >= 0 && resource.indexOf("/items/") >= 0) {
              await syncOneListing(sellerId, token, rid);
            } else if (topic.indexOf("order") >= 0 && resource.indexOf("/orders/") >= 0) {
              await syncOneOrder(sellerId, token, rid);
            }
          }
        }
      }
    } catch (e) { /* engole — cron é a rede de segurança */ }
    return res.status(200).json({ ok: true });
  }

  // ── Rota de usuários — exige sessão do app; escrita exige admin ──
  if (path === "/_users" || path.startsWith("/_users?")) {
    const sessao = await verificarSessao(req);
    if (!sessao) {
      return res.status(401).json({ error: "Não autenticado. Faça login no sistema." });
    }

    if (req.method === "GET") {
      let usuarios;
      try {
        usuarios = await lerUsuarios();
      } catch (e) {
        return res.status(503).json({ error: falhaPersistencia(e) });
      }
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
      // Sem armazenamento a gravação não sobrevive à requisição: recusa antes de
      // devolver um "ok" que faria o painel mostrar um usuário que não existe.
      if (!kvConfigurado()) {
        return res.status(503).json({
          error: "Armazenamento (KV) não configurado no servidor: defina KV_REST_API_URL e " +
                 "KV_REST_API_TOKEN no Vercel. Enquanto isso, usuários criados não são salvos.",
        });
      }

      let atual;
      try {
        atual = await lerUsuarios();
      } catch (e) {
        // Gravar em cima de uma leitura que falhou apagaria quem já existe.
        return res.status(503).json({ error: falhaPersistencia(e) });
      }
      const mapaAtual = {};
      atual.forEach(function(u) { mapaAtual[u.id] = u; });

      // "senhas" traz as senhas novas em texto (só sobre HTTPS) — o hash é
      // calculado AQUI com scrypt; o navegador nunca gera nem armazena hashes.
      const senhas = body.senhas || {};
      const novos = body.usuarios.map(function(u) {
        const limpo = Object.assign({}, u);
        delete limpo.senha;
        delete limpo.senhaHash;
        // O login é gravado normalizado: espaço no fim ou maiúscula digitada no
        // cadastro impediam o usuário de entrar com o que lhe foi passado.
        if (limpo.usuario != null) limpo.usuario = normalizarLogin(limpo.usuario);
        if (typeof limpo.nome === "string") limpo.nome = limpo.nome.trim();
        const existente = mapaAtual[u.id] || {};
        return Object.assign({}, existente, limpo, {
          senhaHash: senhas[u.id] ? hashSenha(senhas[u.id]) : existente.senhaHash || null,
        });
      });

      const semLogin = novos.filter(function(u) { return !u.usuario; });
      if (semLogin.length) {
        return res.status(400).json({ error: "Há usuário sem login preenchido." });
      }
      const vistos = {};
      const duplicados = [];
      novos.forEach(function(u) {
        if (vistos[u.usuario]) duplicados.push(u.usuario);
        vistos[u.usuario] = true;
      });
      if (duplicados.length) {
        return res.status(409).json({
          error: "Login repetido: " + duplicados.join(", ") + ". Cada usuário precisa de um login único.",
        });
      }
      // Um usuário sem senha definida nunca consegue entrar — avisa em vez de deixar
      // o cadastro "pronto" e o cliente batendo na porta.
      const semSenhaDefinida = novos.filter(function(u) { return !u.senhaHash; }).map(function(u) { return u.usuario; });

      try {
        await salvarUsuarios(novos);
      } catch (e) {
        return res.status(503).json({ error: falhaPersistencia(e) });
      }
      return res.status(200).json({
        ok: true,
        total: novos.length,
        semSenha: semSenhaDefinida,
        usuarios: novos.map(semSenha),
      });
    }

    return res.status(405).json({ error: "Method not allowed" });
  }

  // ── Backfill one-shot KV → Postgres (flow.sync_store) — exige ADMIN ──
  // Copia as chaves de negócio do Vercel KV para o Postgres, SÓ onde o Postgres ainda
  // está vazio (idempotente: nunca sobrescreve um valor mais novo já gravado pelo dual-write).
  // Uso: abrir /api/ml/_migrate_kv logado como admin; pode rodar quantas vezes quiser.
  if (path === "/_migrate_kv" || path.startsWith("/_migrate_kv?")) {
    const sessao = await verificarSessao(req);
    if (!sessao) return res.status(401).json({ error: "Não autenticado. Faça login no sistema." });
    if (!sessao.admin) return res.status(403).json({ error: "Apenas administradores." });
    if (!dbEnabled()) return res.status(400).json({ error: "SUPABASE_DB_URL não configurada no servidor." });

    const cookiesMig = Object.fromEntries(
      (req.headers.cookie || "").split(";").map(function(c){ const p = c.trim().split("="); return [p[0], p.slice(1).join("=")]; })
    );
    const qsMig = new URLSearchParams(path.split("?")[1] || "");
    const nsClienteMig = qsMig.get("ns");
    const COMPART = ["chat_interno_mensagens", "chat_interno_tarefas"];
    function contaMig() {
      return (cookiesMig.ml_user_id && String(cookiesMig.ml_user_id).trim())
        || (nsClienteMig && String(nsClienteMig).trim())
        || ("u-" + sessao.uid);
    }
    function kvKeyMig(key) { return COMPART.includes(key) ? ("mlmargem_sync_" + key) : ("mlmargem_sync_acc_" + contaMig() + "_" + key); }
    function nsScopeMig(key) { return COMPART.includes(key) ? "shared" : contaMig(); }

    const migrated = [], skipped = [], vazias = [], erros = [];
    for (let i = 0; i < SYNC_KEYS_PERMITIDAS.length; i += 5) {
      const lote = SYNC_KEYS_PERMITIDAS.slice(i, i + 5);
      await Promise.all(lote.map(async function(key){
        try {
          const kvVal = await kvGet(kvKeyMig(key));
          if (kvVal === null || kvVal === undefined) { vazias.push(key); return; }
          const pgVal = await syncGet(nsScopeMig(key), key);
          if (pgVal !== null && pgVal !== undefined) { skipped.push(key); return; }
          await syncSet(nsScopeMig(key), key, kvVal);
          migrated.push(key);
        } catch (e) { erros.push(key + ": " + (e && e.message)); }
      }));
    }
    return res.status(200).json({ ok: true, conta: contaMig(), migrated, skipped_ja_no_postgres: skipped, vazias_no_kv: vazias, erros });
  }

  // ── Leitura do cache (anúncios/pedidos) para o app ler no boot — exige sessão ──
  // Devolve o item/pedido ML completo (raw), paginado, na MESMA shape das buscas ao ML.
  if (path === "/cache_listings" || path.startsWith("/cache_listings?") ||
      path === "/cache_orders" || path.startsWith("/cache_orders?")) {
    const sessao = await verificarSessao(req);
    if (!sessao) return res.status(401).json({ error: "Não autenticado. Faça login no sistema." });
    const ehPedidos = path.indexOf("/cache_orders") === 0;
    if (!dbEnabled()) return res.status(200).json({ items: [], hasMore: false, cache: false });
    const ck = Object.fromEntries(
      (req.headers.cookie || "").split(";").map(function(c){ const p = c.trim().split("="); return [p[0], p.slice(1).join("=")]; })
    );
    const qs = new URLSearchParams(path.split("?")[1] || "");
    const sellerId = qs.get("seller") || ck.ml_user_id;
    if (!sellerId) return res.status(200).json({ items: [], hasMore: false, cache: false });
    const limit = Math.min(parseInt(qs.get("limit"), 10) || 400, 1000);
    const offset = parseInt(qs.get("offset"), 10) || 0;
    try {
      const rows = ehPedidos
        ? await listCacheOrders(sellerId, limit, offset)
        : await listCacheListings(sellerId, limit, offset);
      return res.status(200).json({ items: rows.map(function(r){ return r.raw; }), hasMore: rows.length === limit, cache: true });
    } catch (e) {
      return res.status(200).json({ items: [], hasMore: false, cache: false });
    }
  }

  // ── Cron: sincroniza o cache do ML de TODAS as contas — autenticado por secret ──
  // Chamado pelo agendador (pg_cron do Supabase). Não usa sessão; valida CRON_SECRET.
  // Para cada conexão salva, renova o token se preciso e roda o sync de anúncios+pedidos.
  if (path === "/_cron_sync" || path.startsWith("/_cron_sync?")) {
    const secret = req.headers["x-cron-secret"] || (req.headers.authorization || "").replace("Bearer ", "");
    if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
      return res.status(403).json({ error: "Proibido." });
    }
    if (!dbEnabled()) return res.status(400).json({ error: "SUPABASE_DB_URL não configurada." });
    const conexoes = await listConexoesMl();
    const resultados = [];
    for (const c of conexoes) {
      try {
        const token = await garantirToken(c);
        if (!token) { resultados.push({ seller: c.seller_id, erro: "sem token" }); continue; }
        const rl = await syncListings(c.seller_id, token);
        const ro = await syncOrders(c.seller_id, token);
        resultados.push({ seller: c.seller_id, listings: rl.upserted, orders: ro.upserted });
      } catch (e) {
        resultados.push({ seller: c.seller_id, erro: (e && e.message) || "falha" });
      }
    }
    return res.status(200).json({ ok: true, contas: conexoes.length, resultados });
  }

  // ── Sincroniza o cache do ML (anúncios + pedidos) para o Postgres — exige ADMIN ──
  // Puxa do ML no SERVIDOR e faz upsert em flow.ml_listing/flow.ml_order. O app depois só lê daí.
  if (path === "/_sync_ml" || path.startsWith("/_sync_ml?")) {
    const sessao = await verificarSessao(req);
    if (!sessao) return res.status(401).json({ error: "Não autenticado. Faça login no sistema." });
    if (!sessao.admin) return res.status(403).json({ error: "Apenas administradores." });
    if (!dbEnabled()) return res.status(400).json({ error: "SUPABASE_DB_URL não configurada no servidor." });

    const ck = Object.fromEntries(
      (req.headers.cookie || "").split(";").map(function(c){ const p = c.trim().split("="); return [p[0], p.slice(1).join("=")]; })
    );
    const qs = new URLSearchParams(path.split("?")[1] || "");
    const sellerId = qs.get("seller") || ck.ml_user_id;
    if (!sellerId) return res.status(400).json({ error: "Conta ML não identificada. Conecte o Mercado Livre primeiro." });

    let token = req.headers.authorization ? req.headers.authorization.replace("Bearer ", "") : (ck.ml_access_token || null);
    if (!token) {
      const meu = await kvGet("mlmargem_ml_token_" + sessao.uid);
      if (meu && meu.accessToken) token = meu.accessToken;
    }
    if (!token) return res.status(401).json({ error: "Sem token do ML. Reconecte ao Mercado Livre e tente de novo." });

    try {
      const rl = await syncListings(sellerId, token);
      const ro = await syncOrders(sellerId, token);
      // Bootstrap: guarda o token na conexao_ml p/ cron/webhook sincronizarem sem o usuário logado.
      try {
        const expMs = parseInt(ck.ml_expires_at || "0", 10) || null;
        await upsertConexaoMl(sellerId, token, ck.ml_refresh_token || null, expMs);
      } catch (e) {}
      return res.status(200).json({ ok: true, seller: String(sellerId), listings: rl, orders: ro });
    } catch (e) {
      return res.status(500).json({ error: (e && e.message) || "Falha ao sincronizar" });
    }
  }

  // ── Rota de sincronização de dados de negócio — exige sessão do app ──
  if (path === "/_sync" || path.startsWith("/_sync?")) {
    const sessao = await verificarSessao(req);
    if (!sessao) {
      return res.status(401).json({ error: "Não autenticado. Faça login no sistema." });
    }

    // Chaves COMPARTILHADAS entre todos (ex: chat interno da equipe) → espaço global.
    // As demais (dados de negócio: custos, produtos, precificação) ficam ISOLADAS por CONTA
    // do Mercado Livre, para que contas diferentes do ML nunca misturem dados — mesmo com o
    // mesmo login do sistema. A conta é identificada de forma confiável pelo cookie ml_user_id
    // (o seller id conectado NESTE navegador, setado no OAuth). Só se não houver cookie usamos o
    // ns enviado pelo cliente; por fim, um espaço neutro por usuário.
    const cookiesSync = Object.fromEntries(
      (req.headers.cookie || "").split(";").map(function(c){
        const p = c.trim().split("="); return [p[0], p.slice(1).join("=")];
      })
    );
    const CHAVES_COMPARTILHADAS = ["chat_interno_mensagens", "chat_interno_tarefas"];
    function kvKeyPara(key, nsCliente) {
      if (CHAVES_COMPARTILHADAS.includes(key)) return "mlmargem_sync_" + key;
      var conta = (cookiesSync.ml_user_id && String(cookiesSync.ml_user_id).trim())
        || (nsCliente && String(nsCliente).trim())
        || ("u-" + sessao.uid);
      return "mlmargem_sync_acc_" + conta + "_" + key;
    }
    // Escopo (ns) usado no Postgres (flow.sync_store): 'shared' para chaves da equipe,
    // senão a CONTA do ML — mesma regra de isolamento do kvKeyPara.
    function nsScopePara(key, nsCliente) {
      if (CHAVES_COMPARTILHADAS.includes(key)) return "shared";
      return (cookiesSync.ml_user_id && String(cookiesSync.ml_user_id).trim())
        || (nsCliente && String(nsCliente).trim())
        || ("u-" + sessao.uid);
    }

    if (req.method === "GET") {
      const qs = new URLSearchParams(path.split("?")[1] || "");
      const key = qs.get("key");
      const ns = qs.get("ns");
      if (!key || !SYNC_KEYS_PERMITIDAS.includes(key)) {
        return res.status(400).json({ error: "Chave de sincronização inválida" });
      }
      // Dual-mode: Postgres (flow.sync_store) como fonte primária; se a chave ainda não
      // existir lá (dado antigo), lê do KV como fallback (read-through). Qualquer erro no
      // Postgres cai no KV — o _sync nunca quebra por causa do banco novo.
      if (dbEnabled()) {
        try {
          let value = await syncGet(nsScopePara(key, ns), key);
          if (value === null || value === undefined) {
            value = await kvGet(kvKeyPara(key, ns));
          }
          return res.status(200).json({ key, value: value ?? null });
        } catch (e) { /* cai no KV abaixo */ }
      }
      const value = await kvGet(kvKeyPara(key, ns));
      return res.status(200).json({ key, value: value ?? null });
    }

    if (req.method === "POST") {
      const body = req.body || {};
      const key = body.key;
      if (!key || !SYNC_KEYS_PERMITIDAS.includes(key)) {
        return res.status(400).json({ error: "Chave de sincronização inválida" });
      }
      // Dual-write durante a transição: grava no Postgres E mantém o KV atualizado,
      // para um rollback seguro. Se o Postgres falhar, ainda grava no KV.
      if (dbEnabled()) {
        try {
          await syncSet(nsScopePara(key, body.ns), key, body.value);
          try { await kvSet(kvKeyPara(key, body.ns), body.value); } catch (e) {}
          return res.status(200).json({ ok: true });
        } catch (e) { /* cai no KV abaixo */ }
      }
      await kvSet(kvKeyPara(key, body.ns), body.value);
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
