// api/_lib/mlsync.js
// Sincroniza anúncios e pedidos do Mercado Livre para o cache no Postgres
// (flow.ml_listing / flow.ml_order). Roda NO SERVIDOR (endpoint manual, webhook, cron);
// o app depois só LÊ do cache — é isso que acaba com a lentidão no boot.

import { sqlClient, upsertConexaoMl } from "./db.js";

const ML = "https://api.mercadolibre.com";

async function mlGet(path, token) {
  const r = await fetch(ML + path, {
    headers: { Authorization: "Bearer " + token, Accept: "application/json" },
  });
  return r.json();
}

// Garante um access token válido para a conta: se expirou (ou falta <5 min), renova via OAuth
// refresh_token e regrava em flow.conexao_ml. Usa as credenciais do app ML já existentes.
export async function garantirToken(conexao) {
  const agora = Date.now();
  const exp = conexao.expira_em ? new Date(conexao.expira_em).getTime() : 0;
  if (conexao.access_token && exp - agora > 5 * 60 * 1000) return conexao.access_token;
  if (!conexao.refresh_token) return conexao.access_token || null;
  const r = await fetch(ML + "/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: process.env.ML_APP_ID,
      client_secret: process.env.ML_APP_SECRET,
      refresh_token: conexao.refresh_token,
    }),
  });
  const d = await r.json();
  if (d && d.access_token) {
    await upsertConexaoMl(conexao.seller_id, d.access_token, d.refresh_token || conexao.refresh_token, Date.now() + (d.expires_in || 21600) * 1000);
    return d.access_token;
  }
  return conexao.access_token || null; // fallback: tenta com o token atual
}

// Insere/atualiza um lote de linhas numa tabela do cache, em UMA instrução por lote.
// A coluna "raw" é jsonb, então seu placeholder recebe cast ::jsonb (o valor vem como string JSON).
async function upsertLote(sql, tabela, rows, cols, updateCols) {
  if (!rows.length) return;
  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100);
    const setClause = updateCols.map((c) => `${c} = excluded.${c}`).join(", ");
    const valores = chunk.map((_, j) =>
      "(" + cols.map((c, k) => {
        const ph = "$" + (j * cols.length + k + 1);
        return c === "raw" ? ph + "::jsonb" : ph;
      }).join(", ") + ")"
    ).join(", ");
    await sql.unsafe(
      `insert into flow.${tabela} (${cols.join(", ")}) values ${valores}` +
      ` on conflict (seller_id, id) do update set ${setClause}, synced_at = now()`,
      chunk.flatMap((r) => cols.map((c) => r[c])),
    );
  }
}

// Puxa TODOS os anúncios do vendedor e faz upsert. Usa multiget (20 por vez) em vez de
// /items/{id} um a um — muito mais rápido e cabe no tempo de uma função serverless.
export async function syncListings(sellerId, token) {
  const sql = sqlClient();
  if (!sql) throw new Error("Postgres não configurado (SUPABASE_DB_URL).");
  let ids = [], offset = 0;
  while (true) {
    const data = await mlGet(`/users/${sellerId}/items/search?limit=50&offset=${offset}`, token);
    const page = (data && data.results) || [];
    ids = ids.concat(page);
    if (page.length < 50) break;
    offset += 50;
    if (offset > 8000) break; // trava de segurança
  }
  // SKU do anúncio: fica em seller_custom_field OU num atributo SELLER_SKU do array attributes.
  function extrairSku(it) {
    if (it.seller_custom_field) return it.seller_custom_field;
    if (Array.isArray(it.attributes)) {
      const a = it.attributes.find((x) => x && (x.id === "SELLER_SKU" || x.id === "GTIN"));
      if (a && a.id === "SELLER_SKU" && a.value_name) return a.value_name;
    }
    return it.seller_sku || null;
  }
  // O multiget precisa listar EXPLICITAMENTE os campos pesados (pictures, attributes, condition),
  // senão vêm vazios — e o app usa fotos/atributos/condição no score de qualidade.
  const attrs = "id,title,price,base_price,available_quantity,sold_quantity,status,sub_status,listing_type_id,seller_custom_field,category_id,thumbnail,permalink,shipping,pictures,attributes,condition,health,last_updated";
  const rows = [];
  for (let i = 0; i < ids.length; i += 20) {
    const lote = ids.slice(i, i + 20);
    const multi = await mlGet(`/items?ids=${lote.join(",")}&attributes=${attrs}`, token);
    const items = Array.isArray(multi) ? multi.map((x) => x && x.body).filter((b) => b && b.id) : [];
    for (const it of items) {
      rows.push({
        seller_id: String(sellerId),
        id: it.id,
        title: it.title || null,
        price: it.price ?? null,
        available_quantity: it.available_quantity ?? null,
        status: it.status || null,
        listing_type_id: it.listing_type_id || null,
        seller_sku: extrairSku(it),
        category_id: it.category_id || null,
        thumbnail: it.thumbnail || null,
        permalink: it.permalink || null,
        free_shipping: it.shipping ? !!it.shipping.free_shipping : null,
        raw: it, // objeto — o postgres.js serializa p/ jsonb uma vez (não pré-stringificar)
        ml_last_updated: it.last_updated || null,
      });
    }
  }
  const cols = ["seller_id", "id", "title", "price", "available_quantity", "status", "listing_type_id", "seller_sku", "category_id", "thumbnail", "permalink", "free_shipping", "raw", "ml_last_updated"];
  const upd = cols.filter((c) => c !== "seller_id" && c !== "id");
  await upsertLote(sql, "ml_listing", rows, cols, upd);
  return { total_ids: ids.length, upserted: rows.length };
}

// Puxa os pedidos do vendedor (desde o cutoff) e faz upsert no cache.
export async function syncOrders(sellerId, token, cutoff = "2026-04-01") {
  const sql = sqlClient();
  if (!sql) throw new Error("Postgres não configurado (SUPABASE_DB_URL).");
  let all = [], offset = 0;
  while (true) {
    const data = await mlGet(`/orders/search?seller=${sellerId}&sort=date_desc&limit=50&offset=${offset}`, token);
    const page = (data && data.results) || [];
    if (!page.length) break;
    const filtrados = page.filter((o) => ((o.date_created || o.date_closed || "").slice(0, 10)) >= cutoff);
    all = all.concat(filtrados);
    const last = page[page.length - 1];
    const lastDate = ((last && (last.date_closed || last.date_created)) || "").slice(0, 10);
    if (page.length < 50 || (lastDate && lastDate < cutoff)) break;
    offset += 50;
    if (offset > 10000) break;
  }
  const rows = all.map((o) => {
    const it = (o.order_items && o.order_items[0]) || {};
    const item = it.item || {};
    return {
      seller_id: String(sellerId),
      id: String(o.id),
      listing_id: item.id || null,
      title: item.title || null,
      seller_sku: item.seller_sku || item.seller_custom_field || null,
      status: o.status || null,
      qty: it.quantity ?? null,
      unit_price: it.unit_price ?? null,
      total_amount: o.total_amount ?? null,
      date_created: o.date_created || o.date_closed || null,
      raw: o, // objeto — serializado uma vez pelo postgres.js
    };
  });
  const cols = ["seller_id", "id", "listing_id", "title", "seller_sku", "status", "qty", "unit_price", "total_amount", "date_created", "raw"];
  const upd = cols.filter((c) => c !== "seller_id" && c !== "id");
  await upsertLote(sql, "ml_order", rows, cols, upd);
  return { upserted: rows.length };
}
