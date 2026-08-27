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
  armazenamentoUsuarios,
  ErroPersistencia,
} from "./_lib/auth.js";
import { dbEnabled, syncGet, syncSet, upsertConexaoMl, listConexoesMl, listCacheListings, listCacheOrders, getConexaoMl, sqlClient } from "./_lib/db.js";
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
      if (armazenamentoUsuarios() === "nenhum") {
        return res.status(503).json({
          error: "Nenhum armazenamento configurado no servidor: defina SUPABASE_DB_URL (banco) " +
                 "ou KV_REST_API_URL/KV_REST_API_TOKEN (KV) no Vercel. Enquanto isso, usuários " +
                 "criados não são salvos.",
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

  // ── Tendências por categoria ────────────────────────────────────────────────
  // Espelha a análise que hoje é feita na tela do Mercado Livre, com uma diferença
  // importante: aqui os números são os SEUS — saem dos pedidos já sincronizados,
  // não de uma estimativa de mercado. Compara o período escolhido com o anterior
  // de mesmo tamanho, que é o que transforma número em tendência.
  if (path === "/_tendencias" || path.startsWith("/_tendencias?")) {
    const sessao = await verificarSessao(req);
    if (!sessao) return res.status(401).json({ error: "Não autenticado. Faça login no sistema." });
    const sql = sqlClient();
    if (!sql) return res.status(503).json({ error: "Banco não configurado (SUPABASE_DB_URL)." });
    const qsT = new URLSearchParams(path.split("?")[1] || "");
    let dias = parseInt(qsT.get("dias"), 10);
    if (!isFinite(dias) || dias < 1 || dias > 365) dias = 30;

    const categorias = await sql`
      with itens as (
        select (o.raw->>'date_created')::timestamptz::date as dia,
               it->'item'->>'category_id' as categoria,
               coalesce((it->>'quantity')::numeric, 1) as qtd,
               coalesce((it->>'unit_price')::numeric, 0) as preco
        from flow.ml_order o, jsonb_array_elements(o.raw->'order_items') it
        where coalesce(o.raw->>'status', '') <> 'cancelled'
          and it->'item'->>'category_id' is not null
      ),
      lim as (
        select (current_date - ${dias}::int) as ini_atual,
               (current_date - (${dias}::int * 2)) as ini_ant
      )
      select i.categoria,
             sum(case when i.dia > l.ini_atual then i.qtd else 0 end)::numeric as unidades,
             round(sum(case when i.dia > l.ini_atual then i.qtd * i.preco else 0 end), 2) as receita,
             sum(case when i.dia <= l.ini_atual and i.dia > l.ini_ant then i.qtd else 0 end)::numeric as unidades_ant,
             round(sum(case when i.dia <= l.ini_atual and i.dia > l.ini_ant then i.qtd * i.preco else 0 end), 2) as receita_ant
      from itens i cross join lim l
      group by i.categoria
      having sum(case when i.dia > l.ini_atual then i.qtd else 0 end) > 0
          or sum(case when i.dia <= l.ini_atual and i.dia > l.ini_ant then i.qtd else 0 end) > 0
      order by 2 desc
    `;

    const tops = await sql`
      with itens as (
        select (o.raw->>'date_created')::timestamptz::date as dia,
               it->'item'->>'category_id' as categoria,
               it->'item'->>'id' as anuncio,
               it->'item'->>'title' as titulo,
               it->'item'->>'seller_sku' as sku,
               coalesce((it->>'quantity')::numeric, 1) as qtd,
               coalesce((it->>'unit_price')::numeric, 0) as preco
        from flow.ml_order o, jsonb_array_elements(o.raw->'order_items') it
        where coalesce(o.raw->>'status', '') <> 'cancelled'
          and (o.raw->>'date_created')::timestamptz::date > (current_date - ${dias}::int)
          and it->'item'->>'category_id' is not null
      ),
      somado as (
        select categoria, anuncio, max(titulo) as titulo, max(sku) as sku,
               sum(qtd) as unidades, round(sum(qtd * preco), 2) as receita
        from itens group by categoria, anuncio
      )
      select * from (
        select s.*, row_number() over (partition by categoria order by unidades desc) as pos
        from somado s
      ) x where pos <= 5
    `;

    const anuncios = await sql`
      select raw->>'category_id' as categoria, count(*)::int as n
      from flow.ml_listing
      where raw->>'category_id' is not null and coalesce(raw->>'status','') = 'active'
      group by 1
    `;

    // Nomes das categorias: cache no banco, buscando na API só o que falta.
    const nomes = {};
    const guardados = await sql`select id, nome, caminho from flow.ml_categoria`;
    guardados.forEach(function(r) { nomes[r.id] = { nome: r.nome, caminho: r.caminho }; });
    const faltando = categorias.map(function(c) { return c.categoria; })
      .filter(function(id) { return !nomes[id]; });
    if (faltando.length) {
      const ckT = Object.fromEntries(
        (req.headers.cookie || "").split(";").map(function(c){ const p = c.trim().split("="); return [p[0], p.slice(1).join("=")]; })
      );
      let tk = ckT.ml_access_token || null;
      if (!tk) {
        const meu = await kvGet("mlmargem_ml_token_" + sessao.uid);
        if (meu && meu.accessToken) tk = meu.accessToken;
      }
      for (const id of faltando.slice(0, 12)) {
        try {
          const r = await fetch("https://api.mercadolibre.com/categories/" + id, {
            headers: tk ? { Authorization: "Bearer " + tk } : {},
            signal: AbortSignal.timeout(8000),
          });
          if (!r.ok) continue;
          const j = await r.json();
          const caminho = Array.isArray(j.path_from_root)
            ? j.path_from_root.map(function(x) { return x.name; }).join(" › ") : null;
          nomes[id] = { nome: j.name || id, caminho: caminho };
          await sql`
            insert into flow.ml_categoria (id, nome, caminho, atualizado_em)
            values (${id}, ${j.name || null}, ${caminho}, now())
            on conflict (id) do update set nome = excluded.nome, caminho = excluded.caminho, atualizado_em = now()
          `;
        } catch (e) { /* sem nome agora: a tela mostra o código, que ainda identifica */ }
      }
    }

    const porCategoria = {};
    anuncios.forEach(function(a) { porCategoria[a.categoria] = a.n; });
    const resposta = categorias.map(function(c) {
      const u = Number(c.unidades), ua = Number(c.unidades_ant);
      const r = Number(c.receita), ra = Number(c.receita_ant);
      return {
        id: c.categoria,
        nome: (nomes[c.categoria] && nomes[c.categoria].nome) || c.categoria,
        caminho: (nomes[c.categoria] && nomes[c.categoria].caminho) || null,
        unidades: u, receita: r, precoMedio: u > 0 ? r / u : null,
        unidadesAnterior: ua, receitaAnterior: ra,
        // Sem base no período anterior não existe variação — null, não zero: zero
        // seria lido como "não mudou", quando na verdade é "não havia com o que comparar".
        variacaoUnidades: ua > 0 ? ((u - ua) / ua) * 100 : null,
        variacaoReceita: ra > 0 ? ((r - ra) / ra) * 100 : null,
        anunciosAtivos: porCategoria[c.categoria] || 0,
        produtos: tops.filter(function(t) { return t.categoria === c.categoria; })
          .map(function(t) {
            return { anuncio: t.anuncio, titulo: t.titulo, sku: t.sku,
                     unidades: Number(t.unidades), receita: Number(t.receita) };
          }),
      };
    });

    return res.status(200).json({ dias: dias, categorias: resposta });
  }

  // ── Comparação de anúncios (o seu x um concorrente) ─────────────────────────
  // Busca o detalhe completo de até 3 anúncios — inclusive a descrição, que não vem
  // no cache — e devolve os campos que alimentam a comparação e o score de
  // qualidade. Anúncio do próprio usuário vem marcado.
  if (path === "/_comparar" || path.startsWith("/_comparar?")) {
    const sessao = await verificarSessao(req);
    if (!sessao) return res.status(401).json({ error: "Não autenticado. Faça login no sistema." });
    const sql = sqlClient();
    if (!sql) return res.status(503).json({ error: "Banco não configurado (SUPABASE_DB_URL)." });
    const qsC = new URLSearchParams(path.split("?")[1] || "");
    const ids = (qsC.get("itens") || "").split(",").map(function(x){ return x.trim(); }).filter(Boolean);
    if (!ids.length || ids.length > 3 || !ids.every(function(id){ return /^MLB\d+$/.test(id); })) {
      return res.status(400).json({ error: "Informe de 1 a 3 anúncios (itens=MLB...,MLB...)." });
    }

    const ckC = Object.fromEntries(
      (req.headers.cookie || "").split(";").map(function(c){ const p = c.trim().split("="); return [p[0], p.slice(1).join("=")]; })
    );
    let tokenC = ckC.ml_access_token || null;
    if (!tokenC) {
      const meu = await kvGet("mlmargem_ml_token_" + sessao.uid);
      if (meu && meu.accessToken) tokenC = meu.accessToken;
    }
    if (!tokenC) return res.status(401).json({ error: "Sem token do ML. Reconecte ao Mercado Livre." });

    async function mlC(caminho) {
      const r = await fetch("https://api.mercadolibre.com" + caminho, {
        headers: { Authorization: "Bearer " + tokenC, Accept: "application/json" },
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) throw new Error(caminho + " respondeu HTTP " + r.status);
      return await r.json();
    }

    const [meusAnunciosC, minhasContasC] = await Promise.all([
      sql`select id from flow.ml_listing`,
      sql`select seller_id from flow.conexao_ml`,
    ]);
    const meusIdsC = new Set(meusAnunciosC.map(function(r){ return String(r.id); }));
    const meusSellersC = new Set(minhasContasC.map(function(r){ return String(r.seller_id); }));

    const anuncios = [];
    for (const id of ids) {
      try {
        const [item, descricao] = await Promise.all([
          mlC("/items/" + id),
          // A descrição é chamada à parte na API; sem ela o score de qualidade
          // acusaria "sem descrição" para um anúncio que tem.
          mlC("/items/" + id + "/description").catch(function(){ return null; }),
        ]);
        anuncios.push({
          id: item.id,
          titulo: item.title || null,
          preco: typeof item.price === "number" ? item.price : null,
          precoOriginal: typeof item.original_price === "number" ? item.original_price : null,
          vendidos: typeof item.sold_quantity === "number" ? item.sold_quantity : null,
          condicao: item.condition || null,
          fotos: Array.isArray(item.pictures) ? item.pictures.length : 0,
          atributos: Array.isArray(item.attributes) ? item.attributes.length : 0,
          freteGratis: !!(item.shipping && item.shipping.free_shipping),
          tipoAnuncio: item.listing_type_id || null,
          descricaoTamanho: descricao && descricao.plain_text ? descricao.plain_text.length : 0,
          link: item.permalink || null,
          foto: item.thumbnail || null,
          status: item.status || null,
          categoria: item.category_id || null,
          seu: meusIdsC.has(String(item.id)) ||
               (item.seller_id != null && meusSellersC.has(String(item.seller_id))),
        });
      } catch (e) {
        anuncios.push({ id: id, erro: (e && e.message) || "não foi possível carregar" });
      }
    }
    return res.status(200).json({ anuncios });
  }

  // ── Painel de mercado de uma categoria ───────────────────────────────────────
  // Constrói o que a descoberta provou existir: mais vendidos da categoria
  // (/highlights), buscas em alta (/trends) e total de anúncios (/categories).
  // Os agregados do Seller Center (unidades do mercado, vendedores ativos) não têm
  // endpoint público — a busca respondeu 403 — então NÃO são estimados aqui: número
  // inventado é pior que número ausente.
  if (path === "/_mercado" || path.startsWith("/_mercado?")) {
    const sessao = await verificarSessao(req);
    if (!sessao) return res.status(401).json({ error: "Não autenticado. Faça login no sistema." });
    const sql = sqlClient();
    if (!sql) return res.status(503).json({ error: "Banco não configurado (SUPABASE_DB_URL)." });
    const qsM = new URLSearchParams(path.split("?")[1] || "");
    const categoria = qsM.get("categoria") || "";
    if (!/^MLB\d+$/.test(categoria)) return res.status(400).json({ error: "Categoria inválida." });
    const forcar = qsM.get("atualizar") === "1";

    // Cache de 12h: o ranking de mais vendidos não muda a cada minuto, e rebuscar
    // a cada abertura da tela gastaria a cota da API à toa.
    if (!forcar) {
      const cache = await sql`
        select dados, atualizado_em from flow.ml_mercado
        where categoria = ${categoria} and atualizado_em > now() - interval '12 hours'
          and dados->>'v' = '2'
      `;
      if (cache.length) {
        return res.status(200).json(Object.assign({}, cache[0].dados, {
          atualizadoEm: new Date(cache[0].atualizado_em).toISOString(), deCache: true,
        }));
      }
    }

    const ckM = Object.fromEntries(
      (req.headers.cookie || "").split(";").map(function(c){ const p = c.trim().split("="); return [p[0], p.slice(1).join("=")]; })
    );
    let tokenM = ckM.ml_access_token || null;
    if (!tokenM) {
      const meu = await kvGet("mlmargem_ml_token_" + sessao.uid);
      if (meu && meu.accessToken) tokenM = meu.accessToken;
    }
    if (!tokenM) return res.status(401).json({ error: "Sem token do ML. Reconecte ao Mercado Livre." });

    async function ml(caminho) {
      const r = await fetch("https://api.mercadolibre.com" + caminho, {
        headers: { Authorization: "Bearer " + tokenM, Accept: "application/json" },
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) throw new Error(caminho + " respondeu HTTP " + r.status);
      return await r.json();
    }

    try {
      // As três fontes em paralelo; cada uma falhando vira campo vazio, não erro geral.
      const [altas, destaque, cat] = await Promise.all([
        ml("/trends/MLB/" + categoria).catch(function(){ return []; }),
        ml("/highlights/MLB/category/" + categoria).catch(function(){ return { content: [] }; }),
        ml("/categories/" + categoria).catch(function(){ return {}; }),
      ]);

      const conteudo = Array.isArray(destaque.content) ? destaque.content.slice(0, 20) : [];
      // O ranking mistura dois tipos: ITEM (um anúncio) e PRODUCT (produto de
      // catálogo, ids MLBU...). Cada tipo resolve o detalhe num endpoint diferente;
      // o que falhar vira um aviso visível, não uma linha muda com traços.
      const avisos = [];
      const idsItens = conteudo.filter(function(x){ return x.type === "ITEM"; }).map(function(x){ return x.id; });
      const idsProdutos = conteudo.filter(function(x){ return x.type !== "ITEM"; }).map(function(x){ return x.id; });

      const detalhes = {};
      for (let i = 0; i < idsItens.length; i += 20) {
        const lote = idsItens.slice(i, i + 20);
        try {
          const r = await ml("/items?ids=" + lote.join(",") +
            "&attributes=id,title,price,permalink,sold_quantity,seller_id,thumbnail");
          (Array.isArray(r) ? r : []).forEach(function(x) {
            if (x && x.body && x.body.id) detalhes[x.body.id] = x.body;
          });
        } catch (e) {
          avisos.push("Detalhe dos anúncios: " + ((e && e.message) || "falhou"));
        }
      }
      // Multiget indisponível ou parcial: tenta um a um, que é mais tolerante.
      const semDetalhe = idsItens.filter(function(id){ return !detalhes[id]; }).slice(0, 10);
      for (const id of semDetalhe) {
        try { detalhes[id] = await ml("/items/" + id); }
        catch (e) { avisos.push("Anúncio " + id + ": " + ((e && e.message) || "falhou")); }
      }

      // Produtos de catálogo: /products devolve o nome e o anúncio vencedor do
      // catálogo (buy box), que é o concorrente real a comparar.
      const produtosCat = {};
      let erroProdutoJaAvisado = false;
      for (const id of idsProdutos.slice(0, 20)) {
        try { produtosCat[id] = await ml("/products/" + id); }
        catch (e) {
          if (!erroProdutoJaAvisado) {
            avisos.push("Produtos de catálogo (" + id + "): " + ((e && e.message) || "falhou"));
            erroProdutoJaAvisado = true;
          }
        }
      }

      // Para marcar o que é SEU no ranking: ids dos seus anúncios e das suas contas.
      const [meusAnuncios, minhasContas] = await Promise.all([
        sql`select id from flow.ml_listing`,
        sql`select seller_id from flow.conexao_ml`,
      ]);
      const meusIds = new Set(meusAnuncios.map(function(r){ return String(r.id); }));
      const meusSellers = new Set(minhasContas.map(function(r){ return String(r.seller_id); }));

      const maisVendidos = conteudo.map(function(x) {
        if (x.type === "ITEM") {
          const d = detalhes[x.id] || {};
          return {
            posicao: x.position, id: x.id, tipo: x.type,
            titulo: d.title || null,
            preco: typeof d.price === "number" ? d.price : null,
            vendidos: typeof d.sold_quantity === "number" ? d.sold_quantity : null,
            link: d.permalink || null,
            itemComparar: x.id,
            seu: meusIds.has(String(x.id)) || (d.seller_id != null && meusSellers.has(String(d.seller_id))),
          };
        }
        const pr = produtosCat[x.id] || {};
        const buyBox = pr.buy_box_winner || {};
        const itemVencedor = buyBox.item_id ? String(buyBox.item_id) : null;
        return {
          posicao: x.position, id: x.id, tipo: x.type,
          titulo: pr.name || null,
          preco: typeof buyBox.price === "number" ? buyBox.price : null,
          vendidos: null,
          link: pr.permalink || ("https://www.mercadolivre.com.br/p/" + x.id),
          // Comparar usa o anúncio vencedor do catálogo — é quem está levando a venda.
          itemComparar: itemVencedor,
          seu: (itemVencedor && meusIds.has(itemVencedor)) ||
               (buyBox.seller_id != null && meusSellers.has(String(buyBox.seller_id))),
        };
      });
      const precos = maisVendidos.map(function(m){ return m.preco; }).filter(function(v){ return v != null; });

      const dados = {
        v: "2",
        avisos: avisos,
        categoria: {
          id: categoria,
          nome: cat.name || categoria,
          totalAnuncios: typeof cat.total_items_in_this_category === "number" ? cat.total_items_in_this_category : null,
        },
        buscasEmAlta: (Array.isArray(altas) ? altas : []).slice(0, 15).map(function(t){
          return { termo: t.keyword, url: t.url };
        }),
        maisVendidos: maisVendidos,
        precoMedioTop: precos.length ? precos.reduce(function(a,b){ return a+b; }, 0) / precos.length : null,
        // O que NÃO existe aqui, de propósito: unidades vendidas e vendedores ativos
        // do mercado. A API pública não fornece (busca respondeu 403).
      };

      await sql`
        insert into flow.ml_mercado (categoria, dados, atualizado_em)
        values (${categoria}, ${sql.json(dados)}, now())
        on conflict (categoria) do update set dados = excluded.dados, atualizado_em = now()
      `;
      return res.status(200).json(Object.assign({}, dados, { atualizadoEm: new Date().toISOString(), deCache: false }));
    } catch (e) {
      return res.status(502).json({ error: (e && e.message) || "Falha ao consultar o mercado no ML." });
    }
  }

  // ── Descoberta: o que a API do ML devolve sobre tendências de categoria ──────
  // A tela "Tendências por categoria" é do Seller Center; nem tudo que aparece lá
  // tem endpoint público. Antes de prometer a tela, esta rota pergunta à própria API
  // o que existe, usando as categorias em que a conta realmente anuncia. Só leitura.
  if (path === "/_descobrir_tendencias" || path.startsWith("/_descobrir_tendencias?")) {
    const sessao = await verificarSessao(req);
    if (!sessao) return res.status(401).json({ error: "Não autenticado. Faça login no sistema." });
    if (!sessao.admin) return res.status(403).json({ error: "Apenas administradores." });

    const ck = Object.fromEntries(
      (req.headers.cookie || "").split(";").map(function(c){ const p = c.trim().split("="); return [p[0], p.slice(1).join("=")]; })
    );
    let token = ck.ml_access_token || null;
    if (!token) {
      const meu = await kvGet("mlmargem_ml_token_" + sessao.uid);
      if (meu && meu.accessToken) token = meu.accessToken;
    }
    if (!token) return res.status(401).json({ error: "Sem token do ML. Reconecte ao Mercado Livre." });

    // Categorias onde a conta mais anuncia — testar com categoria real evita
    // conclusão errada por causa de um id inventado.
    let categorias = [];
    try {
      const sql = sqlClient();
      if (sql) {
        const rows = await sql`
          select raw->>'category_id' as categoria, count(*)::int as n
          from flow.ml_listing where raw->>'category_id' is not null
          group by 1 order by n desc limit 2
        `;
        categorias = rows.map(function(r) { return r.categoria; });
      }
    } catch (e) {}
    const qsTend = new URLSearchParams(path.split("?")[1] || "");
    if (qsTend.get("categoria")) categorias = [qsTend.get("categoria")];
    if (!categorias.length) categorias = ["MLB1747"];

    const cat = categorias[0];
    const candidatos = [
      { rotulo: "Buscas em alta no site",        caminho: "/trends/MLB" },
      { rotulo: "Buscas em alta na categoria",   caminho: "/trends/MLB/" + cat },
      { rotulo: "Mais vendidos da categoria",    caminho: "/highlights/MLB/category/" + cat },
      { rotulo: "Dados da categoria",            caminho: "/categories/" + cat },
      { rotulo: "Busca na categoria (agregados)",caminho: "/sites/MLB/search?category=" + cat + "&limit=1" },
      { rotulo: "Mais vendidos por busca",       caminho: "/sites/MLB/search?category=" + cat + "&sort=sold_quantity_desc&limit=1" },
    ];

    const achados = [];
    const fimDescoberta = Date.now() + 40000;
    for (const c of candidatos) {
      if (Date.now() > fimDescoberta) {
        achados.push({ rotulo: c.rotulo, caminho: c.caminho, erro: "não coube no tempo — rode de novo" });
        continue;
      }
      try {
        const r = await fetch("https://api.mercadolibre.com" + c.caminho, {
          headers: { Authorization: "Bearer " + token, Accept: "application/json" },
          signal: AbortSignal.timeout(8000),
        });
        const texto = await r.text();
        let amostra = texto.slice(0, 600);
        let chaves = null;
        try {
          const j = JSON.parse(texto);
          chaves = Array.isArray(j) ? ["(lista de " + j.length + ")"].concat(Object.keys(j[0] || {})) : Object.keys(j);
          amostra = JSON.stringify(Array.isArray(j) ? j.slice(0, 2) : j).slice(0, 600);
        } catch (e) {}
        achados.push({ rotulo: c.rotulo, caminho: c.caminho, status: r.status, ok: r.ok, chaves: chaves, amostra: amostra });
      } catch (e) {
        achados.push({ rotulo: c.rotulo, caminho: c.caminho, erro: (e && e.message) || "falha" });
      }
    }
    return res.status(200).json({ categoriaTestada: cat, categoriasDaConta: categorias, achados });
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
