import { useState, useMemo, useEffect } from "react";

const ML = (path) => `/api/ml${path}`;
const fmt = (n) => `R$ ${Number(n).toFixed(2).replace(".", ",")}`;
const fmtPct = (n) => `${(n * 100).toFixed(1)}%`;

function getSku(listing) {
  if (listing.seller_sku) return listing.seller_sku;
  const skuAttr = listing.attributes?.find(a =>
    a.id === "SELLER_SKU" || a.id === "SKU" || a.name?.toLowerCase().includes("sku")
  );
  return skuAttr?.value_name ?? null;
}

function getRealFeeRate(listing) {
  if (listing.listing_type_id === "gold_premium" || listing.listing_type_id === "gold_pro") return 0.17;
  return 0.12;
}

function getListingTypeLabel(type) {
  if (type === "gold_premium" || type === "gold_pro") return { label: "Premium · 17%", color: "#7c3aed" };
  return { label: "Clássico · 12%", color: "#2563eb" };
}

function getPrices(listing) {
  if (listing.original_price && parseFloat(listing.original_price) > parseFloat(listing.price)) {
    return {
      salePrice: parseFloat(listing.price),
      originalPrice: parseFloat(listing.original_price),
      hasPromo: true
    };
  }
  if (listing.sale_price && listing.sale_price.amount && parseFloat(listing.sale_price.amount) < parseFloat(listing.price)) {
    return {
      salePrice: parseFloat(listing.sale_price.amount),
      originalPrice: parseFloat(listing.price),
      hasPromo: true
    };
  }
  return { salePrice: parseFloat(listing.price), originalPrice: parseFloat(listing.price), hasPromo: false };
}

function calcMargin(salePrice, cost, feeRate = 0.12, freteSeller = 0) {
  const mlFee = salePrice * feeRate;
  const revenue = salePrice - mlFee - freteSeller;
  const profit = revenue - cost;
  const margin = cost > 0 ? profit / salePrice : null;
  return { fee: mlFee, revenue, profit, margin, feeRate };
}

function calcQualityScore(listing) {
  const checks = [
    { key: "title_length", label: "Título com 60+ caracteres", pass: listing.title?.length >= 60, weight: 15 },
    { key: "photos_count", label: "6+ fotos", pass: (listing.pictures?.length ?? 0) >= 6, weight: 20 },
    { key: "description", label: "Descrição detalhada (100+ chars)", pass: (listing.description?.plain_text?.length ?? 0) >= 100, weight: 20 },
    { key: "free_shipping", label: "Frete grátis ao comprador", pass: listing.shipping?.free_shipping === true, weight: 15 },
    { key: "attributes", label: "4+ atributos preenchidos", pass: (listing.attributes?.length ?? 0) >= 4, weight: 20 },
    { key: "condition", label: "Condição informada", pass: !!listing.condition, weight: 10 },
  ];
  const total = checks.reduce((s, c) => s + (c.pass ? c.weight : 0), 0);
  const max = checks.reduce((s, c) => s + c.weight, 0);
  return { score: Math.round((total / max) * 100), checks };
}

function scoreColor(s) { return s >= 80 ? "#16a34a" : s >= 50 ? "#d97706" : "#dc2626"; }
function scoreBg(s) { return s >= 80 ? "#f0fdf4" : s >= 50 ? "#fffbeb" : "#fef2f2"; }
function scoreLabel(s) { return s >= 80 ? "Ótimo" : s >= 50 ? "Regular" : "Fraco"; }

async function analyzeWithAI(listing) {
  const apiKey = import.meta.env.VITE_ANTHROPIC_KEY;
  if (!apiKey) throw new Error("VITE_ANTHROPIC_KEY não configurada");

  const prompt = `Analise este anúncio do Mercado Livre Brasil e retorne APENAS um objeto JSON válido, sem texto extra, sem markdown.

Estrutura obrigatória:
{"score_commentary":"frase curta sobre qualidade geral","strengths":["ponto1","ponto2"],"improvements":[{"field":"campo","suggestion":"sugestão curta"},{"field":"campo","suggestion":"sugestão curta"},{"field":"campo","suggestion":"sugestão curta"}],"title_suggestion":"novo título em até 60 chars","keywords":["palavra1","palavra2","palavra3","palavra4","palavra5"]}

Dados:
- Título: ${listing.title}
- Preço: R$${listing.salePrice}
- Fotos: ${listing.pictures?.length ?? 0}
- Frete grátis: ${listing.shipping?.free_shipping ? "Sim" : "Não"}
- Descrição: ${(listing.description?.plain_text ?? "").slice(0, 200) || "vazia"}
- Atributos: ${listing.attributes?.slice(0, 5).map(a => a.name + ": " + a.value_name).join(", ") || "nenhum"}
- Vendidos: ${listing.sold_quantity ?? 0}

Retorne SOMENTE o JSON, começando com { e terminando com }.`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
      "x-api-key": apiKey,
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: 1500,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  const data = await response.json();
  if (data.error) throw new Error(data.error.message);
  const text = data.content?.map(b => b.text || "").join("") ?? "";
  const clean = text.replace(/```json|```/g, "").trim();
  const jsonStart = clean.indexOf("{");
  const jsonEnd = clean.lastIndexOf("}");
  if (jsonStart === -1 || jsonEnd === -1) throw new Error("JSON inválido na resposta");
  return JSON.parse(clean.slice(jsonStart, jsonEnd + 1));
}

async function fetchAllListings(userId, tk) {
  const pageSize = 50; let offset = 0; let allIds = [];
  while (true) {
    const res = await fetch(ML(`/users/${userId}/items/search?limit=${pageSize}&offset=${offset}`), { headers: { Authorization: `Bearer ${tk}` } });
    const data = await res.json();
    const ids = data.results ?? [];
    allIds = [...allIds, ...ids];
    if (ids.length < pageSize) break;
    offset += pageSize;
  }
  const details = [];
  for (let i = 0; i < allIds.length; i += 20) {
    const batch = allIds.slice(i, i + 20);
    const batchDetails = await Promise.all(
      batch.map(id => fetch(ML(`/items/${id}`), { headers: { Authorization: `Bearer ${tk}` } }).then(r => r.json()))
    );
    details.push(...batchDetails);
  }
  return details.filter(d => d.id);
}

// Importa/sincroniza anúncios ML para o cadastro de produtos
function syncListingsToProdutos(listings, produtosExistentes) {
  const produtosMap = {};
  produtosExistentes.forEach(p => {
    if (p.mlbVinculado) produtosMap[p.mlbVinculado] = p;
    if (p.sku) produtosMap[`sku_${p.sku}`] = p;
  });

  const novos = [];
  const atualizados = [];

  listings.forEach(l => {
    const sku = l.seller_sku || l.attributes?.find(a => a.id==="SELLER_SKU")?.value_name || "";
    const existente = produtosMap[l.id] || (sku ? produtosMap[`sku_${sku}`] : null);

    const dadosML = {
      mlbVinculado: l.id,
      titulo: l.title || "",
      sku: sku,
      precoVenda: String(l.price || ""),
      estoqueAtual: String(l.available_quantity || 0),
      status: l.status === "active" ? "Ativo" : "Inativo",
      imagens: l.pictures?.slice(0,10).map(p => p.url).filter(Boolean) || [],
      peso: l.shipping?.dimensions?.weight ? String(l.shipping.dimensions.weight/1000) : "",
      comprimento: l.shipping?.dimensions?.length ? String(l.shipping.dimensions.length) : "",
      largura: l.shipping?.dimensions?.width ? String(l.shipping.dimensions.width) : "",
      altura: l.shipping?.dimensions?.height ? String(l.shipping.dimensions.height) : "",
      descricao: l.description?.plain_text?.slice(0, 500) || "",
      categoria: "Outros",
      syncML: true,
      ultimoSyncML: new Date().toLocaleDateString("sv-SE"),
    };

    if (existente) {
      // Atualiza apenas campos do ML, preserva custo e dados manuais
      const atualizado = {
        ...existente,
        titulo: dadosML.titulo,
        precoVenda: dadosML.precoVenda,
        estoqueAtual: dadosML.estoqueAtual,
        status: dadosML.status,
        mlbVinculado: l.id,
        sku: dadosML.sku || existente.sku,
        imagens: dadosML.imagens.length > 0 ? dadosML.imagens : existente.imagens,
        syncML: true,
        ultimoSyncML: dadosML.ultimoSyncML,
      };
      atualizados.push(atualizado);
    } else {
      novos.push({ ...dadosML, id: `ml_${l.id}`, criadoViaML: true });
    }
  });

  // Monta lista final: atualizados + não-sincronizados + novos
  const idsAtualizados = new Set(atualizados.map(p => p.id));
  const naoSincronizados = produtosExistentes.filter(p => !idsAtualizados.has(p.id));
  return [...atualizados, ...naoSincronizados, ...novos];
}

async function fetchAllOrders(userId, tk) {
  const pageSize = 50; let offset = 0; let allOrders = [];
  const cutoffDate = "2026-04-01";
  while (true) {
    const res = await fetch(ML(`/orders/search?seller=${userId}&sort=date_desc&limit=${pageSize}&offset=${offset}`), { headers: { Authorization: `Bearer ${tk}` } });
    const data = await res.json();
    const orders = data.results ?? [];
    if (orders.length === 0) break;
    // Filtrar apenas pedidos a partir de 01/04/2026
    const filtered = orders.filter(o => o.date_created && o.date_created.slice(0, 10) >= cutoffDate);
    allOrders = [...allOrders, ...filtered];
    // Se o último pedido da página é antes de 01/04, parar de paginar
    const lastDate = orders[orders.length - 1]?.date_created?.slice(0, 10);
    if (orders.length < pageSize || (lastDate && lastDate < cutoffDate)) break;
    offset += pageSize;
  }
  return allOrders;
}

async function fetchSellerShippingCost(itemId, userId, tk) {
  try {
    const res = await fetch(ML(`/users/${userId}/shipping_options/free?item_id=${itemId}`), {
      headers: { Authorization: `Bearer ${tk}` }
    });
    const data = await res.json();
    const cost = data?.coverage?.all_country?.list_cost;
    if (cost && parseFloat(cost) > 0) return parseFloat(cost);
    return 0;
  } catch { return 0; }
}

async function fetchShipmentCost(shipmentId, tk) {
  if (!shipmentId) return 0;
  try {
    // Tenta via proxy primeiro, depois direto na API do ML
    const urls = [
      `/api/ml/shipments/${shipmentId}`,
      `https://api.mercadolibre.com/shipments/${shipmentId}`,
    ];
    for (const url of urls) {
      try {
        const res = await fetch(url, { headers: { Authorization: `Bearer ${tk}` } });
        const data = await res.json();
        console.log("SHIPMENT DATA", shipmentId, JSON.stringify(data).slice(0, 300));
        if (data.error) continue;
        const cost =
          data?.base_cost ??
          data?.sender_cost ??
          data?.shipping_option?.cost ??
          data?.cost ??
          0;
        const val = parseFloat(cost);
        if (val > 0) return val;
      } catch { continue; }
    }
    return 0;
  } catch { return 0; }
}

async function fetchPromoPrice(itemId, tk) {
  try {
    const res = await fetch(`/api/promo/items/${itemId}?app_version=v2`, {
      headers: { Authorization: `Bearer ${tk}` }
    });
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) return null;
    const active = data.filter(p => p.status === "started" && p.price && parseFloat(p.price) > 0);
    if (active.length === 0) return null;
    const best = active.reduce((min, p) => parseFloat(p.price) < parseFloat(min.price) ? p : min, active[0]);
    return { salePrice: parseFloat(best.price), originalPrice: parseFloat(best.original_price) };
  } catch { return null; }
}


function getOrderStatusInfo(status, tags, fulfilled, shipmentStatus) {
  const isMediation = tags?.some(t => t.includes("mediation")) || status === "in_mediation";
  const isRefunded = tags?.some(t => t.includes("refund"));
  const isDelivered = tags?.some(t => t === "delivered") || shipmentStatus === "delivered";
  const isDevolvido = isRefunded || (status === "cancelled" && isDelivered);
  if (isDevolvido) return { label: "Devolvido", color: "#7c3aed", bg: "#f5f3ff" };
  if (isMediation) return { label: "Em disputa", color: "#d97706", bg: "#fffbeb" };
  if (status === "cancelled") return { label: "Cancelado", color: "#dc2626", bg: "#fef2f2" };
  if (isDelivered) return { label: "Entregue", color: "#0369a1", bg: "#eff6ff" };
  // Enviado = apenas postado na transportadora
  // ready_to_ship = etiqueta gerada mas NÃO postado → Ag. Envio
  if (["shipped", "in_transit"].includes(shipmentStatus))
    return { label: "Enviado", color: "#0891b2", bg: "#ecfeff" };
  if (status === "paid") return { label: "Ag. Envio", color: "#d97706", bg: "#fffbeb" };
  return { label: status ?? "—", color: "#64748b", bg: "#f8fafc" };
}

function MarginBar({ value }) {
  if (value === null) return <span style={{ fontSize: 12, color: "#94a3b8" }}>— insira custo</span>;
  const pct = Math.max(0, Math.min(1, value));
  const color = pct >= 0.25 ? "#16a34a" : pct >= 0.15 ? "#d97706" : "#dc2626";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <div style={{ flex: 1, height: 4, background: "#e2e8f0", borderRadius: 99, overflow: "hidden", minWidth: 60 }}>
        <div style={{ width: `${pct * 100}%`, height: "100%", background: color, borderRadius: 99 }} />
      </div>
      <span style={{ fontSize: 12, fontWeight: 600, color, minWidth: 38, textAlign: "right" }}>{fmtPct(pct)}</span>
    </div>
  );
}

function AIPanel({ listing, onClose }) {
  const [state, setState] = useState("idle");
  const [result, setResult] = useState(null);
  const [errorMsg, setErrorMsg] = useState("");
  const { score, checks } = calcQualityScore(listing);
  async function runAnalysis() {
    setState("loading"); setErrorMsg("");
    try { const r = await analyzeWithAI(listing); setResult(r); setState("done"); }
    catch (e) { setErrorMsg(e.message); setState("error"); }
  }
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,.5)", backdropFilter: "blur(4px)", display: "flex", alignItems: "flex-end", justifyContent: "center", zIndex: 300 }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ background: "#fff", borderRadius: "20px 20px 0 0", width: "100%", maxWidth: 760, maxHeight: "88vh", overflowY: "auto", padding: "28px 32px 40px", boxShadow: "0 -4px 40px rgba(0,0,0,.12)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20 }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 18, color: "#0f172a", marginBottom: 4 }}>Qualidade do Anúncio</div>
            <div style={{ color: "#64748b", fontSize: 13, maxWidth: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{listing.title}</div>
          </div>
          <button onClick={onClose} style={{ background: "#f1f5f9", border: "none", color: "#64748b", width: 32, height: 32, borderRadius: 8, cursor: "pointer", fontSize: 16 }}>✕</button>
        </div>
        <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 12, padding: "16px 20px", marginBottom: 20 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 14 }}>
            <div style={{ width: 52, height: 52, borderRadius: 12, background: scoreBg(score), display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
              <span style={{ fontSize: 18, fontWeight: 800, color: scoreColor(score) }}>{score}</span>
              <span style={{ fontSize: 9, color: scoreColor(score), fontWeight: 600 }}>/100</span>
            </div>
            <div>
              <div style={{ fontWeight: 700, fontSize: 16, color: scoreColor(score) }}>{scoreLabel(score)}</div>
              <div style={{ color: "#94a3b8", fontSize: 12 }}>Score de qualidade do anúncio</div>
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            {checks.map(c => (
              <div key={c.key} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", background: c.pass ? "#f0fdf4" : "#fef2f2", borderRadius: 8 }}>
                <span style={{ color: c.pass ? "#16a34a" : "#dc2626", fontSize: 13, fontWeight: 700 }}>{c.pass ? "✓" : "✗"}</span>
                <span style={{ fontSize: 12, color: c.pass ? "#15803d" : "#b91c1c" }}>{c.label}</span>
              </div>
            ))}
          </div>
        </div>
        {state === "idle" && <div style={{ textAlign: "center", padding: "28px 0" }}><div style={{ color: "#94a3b8", fontSize: 13, marginBottom: 16 }}>Analise com IA para receber sugestões personalizadas</div><button onClick={runAnalysis} style={{ background: "#0f172a", border: "none", color: "#fff", fontWeight: 700, padding: "11px 32px", borderRadius: 10, cursor: "pointer", fontSize: 14 }}>✦ Analisar com IA</button></div>}
        {state === "loading" && <div style={{ textAlign: "center", padding: "32px 0", color: "#94a3b8" }}><div style={{ fontSize: 28, marginBottom: 12, animation: "spin 1.2s linear infinite", display: "inline-block" }}>⟳</div><style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style><div style={{ fontSize: 13 }}>Analisando...</div></div>}
        {state === "error" && <div style={{ textAlign: "center", padding: "24px 0" }}><div style={{ color: "#dc2626", fontSize: 13, marginBottom: 12 }}>Erro: {errorMsg}</div><button onClick={runAnalysis} style={{ background: "#f1f5f9", border: "1px solid #e2e8f0", color: "#374151", padding: "8px 20px", borderRadius: 8, cursor: "pointer", fontSize: 13 }}>Tentar novamente</button></div>}
        {state === "done" && result && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 10, padding: "14px 18px" }}>
              <div style={{ fontSize: 11, color: "#92400e", marginBottom: 6, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Avaliação Geral</div>
              <div style={{ fontSize: 14, color: "#1c1917", lineHeight: 1.6 }}>{result.score_commentary}</div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              {result.strengths?.length > 0 && <div style={{ background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 10, padding: "14px 18px" }}><div style={{ fontSize: 11, color: "#15803d", marginBottom: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>✓ Pontos Fortes</div>{result.strengths.map((s, i) => <div key={i} style={{ fontSize: 13, color: "#166534", marginBottom: 6, paddingLeft: 10, borderLeft: "2px solid #86efac" }}>{s}</div>)}</div>}
              {result.keywords?.length > 0 && <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 10, padding: "14px 18px" }}><div style={{ fontSize: 11, color: "#475569", marginBottom: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Palavras-chave</div><div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>{result.keywords.map((k, i) => <span key={i} style={{ background: "#e2e8f0", color: "#334155", fontSize: 12, padding: "3px 10px", borderRadius: 20 }}>{k}</span>)}</div></div>}
            </div>
            {result.improvements?.length > 0 && <div style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 10, padding: "14px 18px" }}><div style={{ fontSize: 11, color: "#d97706", marginBottom: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>⚡ O que Melhorar</div>{result.improvements.map((imp, i) => <div key={i} style={{ display: "flex", gap: 12, marginBottom: 12, paddingBottom: 12, borderBottom: i < result.improvements.length - 1 ? "1px solid #f1f5f9" : "none" }}><div style={{ minWidth: 26, height: 26, borderRadius: 7, background: "#fffbeb", border: "1px solid #fde68a", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: "#d97706", fontWeight: 700 }}>{i + 1}</div><div><div style={{ fontSize: 12, color: "#d97706", marginBottom: 3, fontWeight: 600 }}>{imp.field}</div><div style={{ fontSize: 13, color: "#475569", lineHeight: 1.5 }}>{imp.suggestion}</div></div></div>)}</div>}
            {result.title_suggestion && <div style={{ background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 10, padding: "14px 18px" }}><div style={{ fontSize: 11, color: "#15803d", marginBottom: 8, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>✦ Sugestão de Título</div><div style={{ fontSize: 14, color: "#0f172a", fontWeight: 600 }}>{result.title_suggestion}</div><div style={{ fontSize: 11, color: "#94a3b8", marginTop: 4 }}>{result.title_suggestion.length} caracteres</div></div>}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Credenciais do dashboard (login de acesso) ──────────────
// Defina aqui o usuário e senha para proteger o dashboard
const DASHBOARD_USER = "admin";
const DASHBOARD_PASS = "martins2026";

// ── Client ID do app ML (para OAuth com refresh token) ──────
const ML_CLIENT_ID = "6544342798807693";

// ── Salva/lê tokens no localStorage para persistir entre sessões ──
function saveTokens(accessToken, refreshToken, expiresIn, userId, nickname) {
  const expiry = Date.now() + (expiresIn * 1000);
  localStorage.setItem("ml_access_token",  accessToken);
  localStorage.setItem("ml_refresh_token", refreshToken);
  localStorage.setItem("ml_token_expiry",  String(expiry));
  localStorage.setItem("ml_user_id",       String(userId));
  localStorage.setItem("ml_nickname",      nickname || "");
}

function loadSavedTokens() {
  const tk      = localStorage.getItem("ml_access_token");
  const refresh = localStorage.getItem("ml_refresh_token");
  const expiry  = parseInt(localStorage.getItem("ml_token_expiry") || "0");
  const userId  = localStorage.getItem("ml_user_id");
  const nick    = localStorage.getItem("ml_nickname");
  if (!tk || !refresh) return null;
  return { accessToken: tk, refreshToken: refresh, expiry, userId, nickname: nick };
}

function clearSavedTokens() {
  ["ml_access_token","ml_refresh_token","ml_token_expiry","ml_user_id","ml_nickname"]
    .forEach(k => localStorage.removeItem(k));
}

// Renova o access token via refresh token (chamado automaticamente)
async function refreshAccessToken(refreshToken) {
  const res = await fetch("/api/oauth", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type:    "refresh_token",
      client_id:     ML_CLIENT_ID,
      refresh_token: refreshToken,
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error("Falha ao renovar token");
  return data;
}

function MLConnectModal({ onConnect, onClose }) {
  const [tokenInput, setTokenInput] = useState("");
  const [loading, setLoading]       = useState(false);
  const [errorMsg, setErrorMsg]     = useState("");

  async function handleConnect() {
    const tk = tokenInput.trim();
    if (!tk) return;
    setLoading(true); setErrorMsg("");
    try {
      const res = await fetch(ML("/users/me"), { headers: { Authorization: `Bearer ${tk}` } });
      const me = await res.json();
      if (!me.id) throw new Error("Token inválido ou expirado");
      // Salva token — expira em 6h, refresh token não disponível neste fluxo
      saveTokens(tk, "", 21600, me.id, me.nickname ?? "");
      onConnect(tk, me.id);
    } catch(e) {
      setErrorMsg(e.message);
    }
    setLoading(false);
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,.6)", backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 300, padding: 24 }}>
      <div style={{ background: "#fff", borderRadius: 16, width: "100%", maxWidth: 480, padding: "32px 36px", boxShadow: "0 20px 60px rgba(0,0,0,.15)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
          <div style={{ fontWeight: 800, fontSize: 18, color: "#0f172a" }}>Conectar Mercado Livre</div>
          <button onClick={onClose} style={{ background: "#f1f5f9", border: "none", color: "#64748b", width: 32, height: 32, borderRadius: 8, cursor: "pointer", fontSize: 16 }}>✕</button>
        </div>
        <p style={{ color: "#64748b", fontSize: 13, lineHeight: 1.7, marginBottom: 20 }}>
          Cole o token de acesso do Mercado Livre. O token fica salvo no navegador e você só precisa reconectar quando ele expirar (a cada 6 horas).
        </p>
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 11, color: "#94a3b8", marginBottom: 8, fontWeight: 600, letterSpacing: 1, textTransform: "uppercase" }}>Token de acesso</div>
          <textarea value={tokenInput} onChange={e => setTokenInput(e.target.value)} placeholder="APP_USR-..." rows={3}
            style={{ width: "100%", background: "#f8fafc", border: `1px solid ${errorMsg ? "#fca5a5" : "#e2e8f0"}`, color: "#0f172a", padding: "10px 14px", borderRadius: 10, fontFamily: "monospace", fontSize: 12, resize: "none", outline: "none" }} />
        </div>
        {errorMsg && <div style={{ background: "#fef2f2", border: "1px solid #fecaca", color: "#dc2626", fontSize: 13, padding: "10px 14px", borderRadius: 8, marginBottom: 16 }}>⚠ {errorMsg}</div>}
        <button onClick={handleConnect} disabled={loading || !tokenInput.trim()}
          style={{ width: "100%", background: loading || !tokenInput.trim() ? "#f1f5f9" : "#0f172a", border: "none", color: loading || !tokenInput.trim() ? "#94a3b8" : "#fff", fontWeight: 700, padding: "12px", borderRadius: 10, cursor: loading || !tokenInput.trim() ? "not-allowed" : "pointer", fontSize: 14 }}>
          {loading ? "Verificando..." : "Conectar"}
        </button>
      </div>
    </div>
  );
}


// ════════════════════════════════════════════════════════════
//  SISTEMA DE NOTIFICAÇÕES
// ════════════════════════════════════════════════════════════

function SinoNotificacoes({ notificacoes, setNotificacoes, darkMode }) {
  const [aberto, setAberto] = useState(false);
  const naoLidas = notificacoes.filter(n => !n.lido).length;

  function marcarTodasLidas() {
    const updated = notificacoes.map(n => ({ ...n, lido: true }));
    setNotificacoes(updated);
    localStorage.setItem("ml_notificacoes", JSON.stringify(updated));
  }

  function marcarLida(id) {
    const updated = notificacoes.map(n => n.id === id ? { ...n, lido: true } : n);
    setNotificacoes(updated);
    localStorage.setItem("ml_notificacoes", JSON.stringify(updated));
  }

  function limparTodas() {
    setNotificacoes([]);
    localStorage.setItem("ml_notificacoes", "[]");
    localStorage.setItem("ml_notif_estoque", "[]");
  }

  async function pedirPermissao() {
    if (typeof Notification !== "undefined" && Notification.permission === "default") {
      await Notification.requestPermission();
    }
  }

  const bg = darkMode ? "#1e293b" : "#fff";
  const border = darkMode ? "#334155" : "#e2e8f0";

  return (
    <div style={{ position: "relative" }}>
      <button onClick={() => { setAberto(a => !a); pedirPermissao(); }}
        style={{ position: "relative", background: naoLidas > 0 ? "#fef3c7" : darkMode ? "#1e293b" : "#f1f5f9", border: `1px solid ${naoLidas > 0 ? "#fde68a" : border}`, color: naoLidas > 0 ? "#d97706" : darkMode ? "#94a3b8" : "#64748b", width: 38, height: 38, borderRadius: 10, cursor: "pointer", fontSize: 18, display: "flex", alignItems: "center", justifyContent: "center" }}>
        🔔
        {naoLidas > 0 && (
          <div style={{ position: "absolute", top: -4, right: -4, background: "#dc2626", color: "#fff", width: 18, height: 18, borderRadius: "50%", fontSize: 10, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center", lineHeight: 1 }}>
            {naoLidas > 9 ? "9+" : naoLidas}
          </div>
        )}
      </button>

      {aberto && (
        <>
          <div onClick={() => setAberto(false)} style={{ position: "fixed", inset: 0, zIndex: 200 }} />
          <div style={{ position: "absolute", top: 46, right: 0, width: 380, background: bg, border: `1px solid ${border}`, borderRadius: 14, boxShadow: "0 8px 32px rgba(0,0,0,.15)", zIndex: 201, overflow: "hidden" }}>
            {/* Header */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 16px", borderBottom: `1px solid ${border}` }}>
              <div style={{ fontWeight: 700, fontSize: 14, color: darkMode ? "#e2e8f0" : "#0f172a" }}>
                🔔 Notificações {naoLidas > 0 && <span style={{ fontSize: 11, background: "#dc2626", color: "#fff", padding: "1px 7px", borderRadius: 20, marginLeft: 6 }}>{naoLidas} novas</span>}
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                {naoLidas > 0 && (
                  <button onClick={marcarTodasLidas} style={{ background: "none", border: "none", fontSize: 11, color: "#0891b2", cursor: "pointer", fontWeight: 600 }}>Marcar todas como lidas</button>
                )}
                {notificacoes.length > 0 && (
                  <button onClick={limparTodas} style={{ background: "none", border: "none", fontSize: 11, color: "#94a3b8", cursor: "pointer" }}>Limpar</button>
                )}
              </div>
            </div>

            {/* Lista */}
            <div style={{ maxHeight: 420, overflowY: "auto" }}>
              {notificacoes.length === 0 ? (
                <div style={{ padding: "32px 16px", textAlign: "center", color: "#94a3b8" }}>
                  <div style={{ fontSize: 32, marginBottom: 8 }}>🔔</div>
                  <div style={{ fontSize: 13 }}>Nenhuma notificação</div>
                  <div style={{ fontSize: 11, marginTop: 4 }}>Reconecte o ML para verificar novos pedidos</div>
                </div>
              ) : notificacoes.map(n => (
                <div key={n.id} onClick={() => marcarLida(n.id)}
                  style={{ padding: "12px 16px", borderBottom: `1px solid ${border}`, cursor: "pointer", background: !n.lido ? (darkMode ? "#1e3a5f" : "#eff6ff") : "transparent", transition: "background .15s" }}>
                  <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                    <div style={{ width: 36, height: 36, borderRadius: 10, background: n.tipo === "pedido" ? "#dcfce7" : "#fef3c7", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, flexShrink: 0 }}>
                      {n.tipo === "pedido" ? "🛒" : "⚠️"}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                        <div style={{ fontWeight: 700, fontSize: 13, color: darkMode ? "#e2e8f0" : "#0f172a" }}>{n.titulo}</div>
                        {!n.lido && <div style={{ width: 8, height: 8, background: "#0891b2", borderRadius: "50%", flexShrink: 0, marginTop: 4 }} />}
                      </div>
                      <div style={{ fontSize: 12, color: darkMode ? "#94a3b8" : "#475569", marginTop: 2, lineHeight: 1.4 }}>{n.msg}</div>
                      <div style={{ fontSize: 10, color: "#94a3b8", marginTop: 4 }}>{n.data}</div>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {/* Footer — permissão browser */}
            {typeof Notification !== "undefined" && Notification.permission === "default" && (
              <div style={{ padding: "10px 16px", borderTop: `1px solid ${border}`, background: darkMode ? "#0f172a" : "#f8fafc" }}>
                <button onClick={pedirPermissao} style={{ width: "100%", background: "#0f172a", border: "none", color: "#fff", fontWeight: 600, padding: "8px", borderRadius: 8, cursor: "pointer", fontSize: 12 }}>
                  🔔 Ativar notificações do navegador
                </button>
              </div>
            )}
            {typeof Notification !== "undefined" && Notification.permission === "granted" && (
              <div style={{ padding: "8px 16px", borderTop: `1px solid ${border}`, fontSize: 11, color: "#15803d", textAlign: "center" }}>
                ✓ Notificações do navegador ativadas
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}


// ════════════════════════════════════════════════════════════
//  BACKUP E RESTAURAÇÃO DE DADOS
// ════════════════════════════════════════════════════════════

const BACKUP_KEYS = [
  { key: "contas_pagar",            label: "Contas a Pagar" },
  { key: "contas_bancarias",        label: "Caixas e Bancos" },
  { key: "lancamentos",             label: "Lançamentos Financeiros" },
  { key: "categorias_pagar",        label: "Categorias" },
  { key: "produtos_cadastro",       label: "Produtos" },
  { key: "fornecedores_cadastro",   label: "Fornecedores" },
  { key: "notas_fiscais_entrada",   label: "Notas Fiscais" },
  { key: "impostos_config",         label: "Impostos" },
  { key: "custos_fixos_config",     label: "Custos Fixos" },
  { key: "metaMensal",              label: "Meta Mensal" },
  { key: "ml_auth_users",           label: "Usuários do Sistema" },
];

function PainelBackup({ onClose }) {
  const [status, setStatus] = useState("");
  const [importing, setImporting] = useState(false);
  const [preview, setPreview] = useState(null);

  // Calcula tamanho e contagem de cada chave
  const resumo = BACKUP_KEYS.map(({ key, label }) => {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return { key, label, count: 0, size: 0, empty: true };
      const parsed = JSON.parse(raw);
      const count = Array.isArray(parsed) ? parsed.length : (typeof parsed === "object" ? Object.keys(parsed).length : 1);
      const size = new Blob([raw]).size;
      return { key, label, count, size, empty: false };
    } catch { return { key, label, count: 0, size: 0, empty: true }; }
  });

  const totalSize = resumo.reduce((s, r) => s + r.size, 0);

  function exportarBackup() {
    const backup = {
      versao: "1.0",
      sistema: "ML Margem Dashboard",
      dataBackup: new Date().toLocaleString("pt-BR"),
      dados: {},
    };
    BACKUP_KEYS.forEach(({ key }) => {
      try {
        const raw = localStorage.getItem(key);
        if (raw) backup.dados[key] = JSON.parse(raw);
      } catch {}
    });
    const json = JSON.stringify(backup, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ml_margem_backup_${new Date().toLocaleDateString("sv-SE")}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setStatus("✅ Backup exportado com sucesso!");
    setTimeout(() => setStatus(""), 3000);
  }

  function handleImportFile(file) {
    if (!file) return;
    setImporting(true);
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const backup = JSON.parse(e.target.result);
        if (!backup.dados || !backup.versao) throw new Error("Arquivo inválido — não é um backup do ML Margem.");
        // Mostra preview antes de confirmar
        const prev = Object.entries(backup.dados).map(([key, val]) => {
          const info = BACKUP_KEYS.find(b => b.key === key);
          const count = Array.isArray(val) ? val.length : 1;
          return { key, label: info?.label || key, count };
        });
        setPreview({ backup, prev, dataBackup: backup.dataBackup });
      } catch(err) {
        setStatus("❌ Erro: " + err.message);
        setTimeout(() => setStatus(""), 4000);
      }
      setImporting(false);
    };
    reader.readAsText(file, "UTF-8");
  }

  function confirmarImport() {
    if (!preview) return;
    try {
      Object.entries(preview.backup.dados).forEach(([key, val]) => {
        localStorage.setItem(key, JSON.stringify(val));
      });
      setStatus("✅ Dados restaurados! Recarregando...");
      setPreview(null);
      setTimeout(() => window.location.reload(), 1500);
    } catch(err) {
      setStatus("❌ Erro ao restaurar: " + err.message);
    }
  }

  function formatSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024*1024) return `${(bytes/1024).toFixed(1)} KB`;
    return `${(bytes/1024/1024).toFixed(2)} MB`;
  }

  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(15,23,42,.65)", backdropFilter:"blur(4px)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:700, padding:24 }}>
      <div style={{ background:"#fff", borderRadius:20, width:"100%", maxWidth:580, maxHeight:"90vh", display:"flex", flexDirection:"column", boxShadow:"0 24px 64px rgba(0,0,0,.2)" }}>
        {/* Header */}
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"20px 28px", borderBottom:"1px solid #f1f5f9" }}>
          <div>
            <div style={{ fontWeight:800, fontSize:18, color:"#0f172a" }}>💾 Backup e Restauração</div>
            <div style={{ fontSize:12, color:"#94a3b8", marginTop:2 }}>Exporte seus dados para um arquivo seguro ou restaure de um backup anterior</div>
          </div>
          <button onClick={onClose} style={{ background:"#f1f5f9", border:"none", color:"#64748b", width:32, height:32, borderRadius:8, cursor:"pointer", fontSize:16 }}>✕</button>
        </div>

        <div style={{ flex:1, overflowY:"auto", padding:"20px 28px" }}>

          {/* Status */}
          {status && (
            <div style={{ background:status.startsWith("✅")?"#f0fdf4":"#fef2f2", border:`1px solid ${status.startsWith("✅")?"#bbf7d0":"#fecaca"}`, borderRadius:10, padding:"10px 16px", marginBottom:16, fontSize:13, fontWeight:600, color:status.startsWith("✅")?"#15803d":"#dc2626" }}>
              {status}
            </div>
          )}

          {/* Preview de importação */}
          {preview && (
            <div style={{ background:"#fffbeb", border:"1px solid #fde68a", borderRadius:12, padding:"16px 18px", marginBottom:16 }}>
              <div style={{ fontWeight:700, fontSize:14, color:"#92400e", marginBottom:8 }}>⚠️ Confirmar Restauração</div>
              <div style={{ fontSize:12, color:"#78350f", marginBottom:12 }}>
                Backup de: <strong>{preview.dataBackup}</strong><br/>
                <strong>Atenção:</strong> os dados atuais serão substituídos pelos dados do backup!
              </div>
              <div style={{ display:"flex", flexDirection:"column", gap:4, marginBottom:14 }}>
                {preview.prev.map(p => (
                  <div key={p.key} style={{ display:"flex", justifyContent:"space-between", fontSize:12, color:"#0f172a" }}>
                    <span>{p.label}</span>
                    <span style={{ fontWeight:600, color:"#d97706" }}>{p.count} registro(s)</span>
                  </div>
                ))}
              </div>
              <div style={{ display:"flex", gap:8 }}>
                <button onClick={() => setPreview(null)}
                  style={{ flex:1, background:"#fff", border:"1px solid #e2e8f0", color:"#64748b", fontWeight:600, padding:"10px", borderRadius:8, cursor:"pointer" }}>Cancelar</button>
                <button onClick={confirmarImport}
                  style={{ flex:2, background:"#d97706", border:"none", color:"#fff", fontWeight:700, padding:"10px", borderRadius:8, cursor:"pointer" }}>
                  ✓ Sim, restaurar dados
                </button>
              </div>
            </div>
          )}

          {/* Resumo dos dados atuais */}
          <div style={{ marginBottom:20 }}>
            <div style={{ fontWeight:700, fontSize:14, color:"#0f172a", marginBottom:12 }}>📊 Dados Armazenados Atualmente</div>
            <div style={{ background:"#f8fafc", border:"1px solid #e2e8f0", borderRadius:12, overflow:"hidden" }}>
              {resumo.map((r, i) => (
                <div key={r.key} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"10px 16px", borderBottom:i<resumo.length-1?"1px solid #f1f5f9":"none", background:i%2===0?"#f8fafc":"#fff" }}>
                  <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                    <div style={{ width:8, height:8, borderRadius:"50%", background:r.empty?"#e2e8f0":"#15803d" }} />
                    <span style={{ fontSize:13, color:"#0f172a" }}>{r.label}</span>
                  </div>
                  <div style={{ display:"flex", gap:16, alignItems:"center" }}>
                    {!r.empty ? (
                      <>
                        <span style={{ fontSize:12, color:"#64748b" }}>{r.count} registro(s)</span>
                        <span style={{ fontSize:11, color:"#94a3b8", background:"#f1f5f9", padding:"2px 8px", borderRadius:20 }}>{formatSize(r.size)}</span>
                      </>
                    ) : (
                      <span style={{ fontSize:12, color:"#94a3b8" }}>vazio</span>
                    )}
                  </div>
                </div>
              ))}
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"12px 16px", background:"#f1f5f9", borderTop:"2px solid #e2e8f0" }}>
                <span style={{ fontSize:13, fontWeight:700, color:"#0f172a" }}>Total</span>
                <span style={{ fontSize:13, fontWeight:700, color:"#0f172a" }}>{formatSize(totalSize)}</span>
              </div>
            </div>
          </div>

          {/* Ações */}
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12 }}>
            {/* Exportar */}
            <div style={{ background:"#f0fdf4", border:"1px solid #bbf7d0", borderRadius:12, padding:"18px 20px" }}>
              <div style={{ fontSize:28, marginBottom:8 }}>⬇️</div>
              <div style={{ fontWeight:700, fontSize:14, color:"#15803d", marginBottom:4 }}>Exportar Backup</div>
              <div style={{ fontSize:12, color:"#64748b", marginBottom:14, lineHeight:1.5 }}>
                Baixa um arquivo JSON com todos os seus dados. Guarde em local seguro.
              </div>
              <button onClick={exportarBackup}
                style={{ width:"100%", background:"#15803d", border:"none", color:"#fff", fontWeight:700, padding:"11px", borderRadius:10, cursor:"pointer", fontSize:13 }}>
                ⬇️ Exportar Backup Agora
              </button>
            </div>

            {/* Importar */}
            <div style={{ background:"#eff6ff", border:"1px solid #bfdbfe", borderRadius:12, padding:"18px 20px" }}>
              <div style={{ fontSize:28, marginBottom:8 }}>⬆️</div>
              <div style={{ fontWeight:700, fontSize:14, color:"#1d4ed8", marginBottom:4 }}>Restaurar Backup</div>
              <div style={{ fontSize:12, color:"#64748b", marginBottom:14, lineHeight:1.5 }}>
                Selecione um arquivo de backup (.json) para restaurar seus dados.
              </div>
              <label style={{ display:"block", width:"100%", background:"#1d4ed8", border:"none", color:"#fff", fontWeight:700, padding:"11px", borderRadius:10, cursor:"pointer", fontSize:13, textAlign:"center" }}>
                {importing ? "Lendo arquivo..." : "⬆️ Selecionar Arquivo"}
                <input type="file" accept=".json" style={{ display:"none" }} onChange={e => { if(e.target.files[0]) handleImportFile(e.target.files[0]); e.target.value=""; }} />
              </label>
            </div>
          </div>

          <div style={{ marginTop:16, background:"#fef9c3", border:"1px solid #fde68a", borderRadius:10, padding:"12px 16px", fontSize:12, color:"#78350f" }}>
            💡 <strong>Dica:</strong> Faça backup sempre que cadastrar muitas informações. Recomendamos exportar pelo menos uma vez por semana.
          </div>
        </div>
      </div>
    </div>
  );
}


// ════════════════════════════════════════════════════════════
//  SISTEMA DE AUTENTICAÇÃO E CONTROLE DE ACESSO
// ════════════════════════════════════════════════════════════

const AUTH_KEY = "ml_auth_users";
const SESSION_KEY = "ml_auth_session";

// Permissões disponíveis por aba
const PERMISSOES_DISPONIVEIS = [
  { key: "overview",   label: "🏠 Visão Geral" },
  { key: "listings",   label: "📢 Anúncios" },
  { key: "orders",     label: "📦 Pedidos" },
  { key: "financeiro", label: "💰 Financeiro" },
  { key: "produtos",   label: "🛍️ Produtos" },
  { key: "admin",      label: "⚙️ Administração" },
];

function hashSenha(senha) {
  // Hash simples para armazenamento local
  let hash = 0;
  for (let i = 0; i < senha.length; i++) {
    const char = senha.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return String(Math.abs(hash)) + senha.length;
}

function getUsuarios() {
  try {
    const data = localStorage.getItem(AUTH_KEY);
    if (!data) {
      // Cria admin padrão na primeira vez
      const adminPadrao = [{
        id: "admin",
        nome: "Administrador",
        usuario: "admin",
        senhaHash: hashSenha("admin123"),
        ativo: true,
        admin: true,
        permissoes: PERMISSOES_DISPONIVEIS.map(p => p.key),
        criadoEm: new Date().toLocaleDateString("sv-SE"),
      }];
      localStorage.setItem(AUTH_KEY, JSON.stringify(adminPadrao));
      return adminPadrao;
    }
    return JSON.parse(data);
  } catch { return []; }
}

function saveUsuarios(usuarios) {
  localStorage.setItem(AUTH_KEY, JSON.stringify(usuarios));
}

function getSession() {
  try {
    const s = sessionStorage.getItem(SESSION_KEY);
    return s ? JSON.parse(s) : null;
  } catch { return null; }
}

function setSession(usuario) {
  sessionStorage.setItem(SESSION_KEY, JSON.stringify({ ...usuario, loginEm: Date.now() }));
}

function clearSession() {
  sessionStorage.removeItem(SESSION_KEY);
}

// ── Tela de Login ────────────────────────────────────────────
function LoginScreen({ onLogin }) {
  const [usuario, setUsuario] = useState("");
  const [senha, setSenha] = useState("");
  const [showSenha, setShowSenha] = useState(false);
  const [erro, setErro] = useState("");
  const [loading, setLoading] = useState(false);

  function handleLogin() {
    if (!usuario || !senha) return;
    setLoading(true); setErro("");
    setTimeout(() => {
      const usuarios = getUsuarios();
      const user = usuarios.find(u =>
        u.usuario.toLowerCase() === usuario.toLowerCase() &&
        u.senhaHash === hashSenha(senha) &&
        u.ativo
      );
      if (user) {
        setSession(user);
        onLogin(user);
      } else {
        setErro("Usuário ou senha incorretos, ou usuário inativo.");
      }
      setLoading(false);
    }, 400);
  }

  return (
    <div style={{ minHeight:"100vh", background:"linear-gradient(135deg,#0f172a 0%,#1e293b 50%,#0f172a 100%)", display:"flex", alignItems:"center", justifyContent:"center", fontFamily:"'Inter','Segoe UI',sans-serif", padding:24 }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');*{box-sizing:border-box;margin:0;padding:0}`}</style>
      <div style={{ width:"100%", maxWidth:420 }}>
        {/* Logo */}
        <div style={{ textAlign:"center", marginBottom:32 }}>
          <div style={{ width:64, height:64, borderRadius:18, background:"#ffe000", display:"inline-flex", alignItems:"center", justifyContent:"center", fontSize:32, fontWeight:800, color:"#0f172a", marginBottom:16, boxShadow:"0 8px 32px rgba(255,224,0,.3)" }}>M</div>
          <div style={{ fontWeight:800, fontSize:24, color:"#fff", letterSpacing:-0.5 }}>ML Margem</div>
          <div style={{ fontSize:13, color:"#64748b", marginTop:4 }}>Dashboard de Lucratividade</div>
        </div>

        {/* Card */}
        <div style={{ background:"#1e293b", borderRadius:20, padding:"32px 36px", boxShadow:"0 20px 60px rgba(0,0,0,.4)", border:"1px solid #334155" }}>
          <div style={{ fontWeight:700, fontSize:18, color:"#f1f5f9", marginBottom:24 }}>Entrar no sistema</div>

          <div style={{ marginBottom:16 }}>
            <div style={{ fontSize:11, color:"#64748b", marginBottom:8, fontWeight:600, letterSpacing:1, textTransform:"uppercase" }}>Usuário</div>
            <input value={usuario} onChange={e => { setUsuario(e.target.value); setErro(""); }}
              onKeyDown={e => e.key==="Enter" && handleLogin()}
              placeholder="Digite seu usuário"
              style={{ width:"100%", background:"#0f172a", border:`1px solid ${erro?"#dc2626":"#334155"}`, color:"#f1f5f9", padding:"12px 16px", borderRadius:10, fontSize:14, outline:"none", fontFamily:"inherit" }} />
          </div>

          <div style={{ marginBottom:24 }}>
            <div style={{ fontSize:11, color:"#64748b", marginBottom:8, fontWeight:600, letterSpacing:1, textTransform:"uppercase" }}>Senha</div>
            <div style={{ position:"relative" }}>
              <input type={showSenha?"text":"password"} value={senha}
                onChange={e => { setSenha(e.target.value); setErro(""); }}
                onKeyDown={e => e.key==="Enter" && handleLogin()}
                placeholder="Digite sua senha"
                style={{ width:"100%", background:"#0f172a", border:`1px solid ${erro?"#dc2626":"#334155"}`, color:"#f1f5f9", padding:"12px 48px 12px 16px", borderRadius:10, fontSize:14, outline:"none", fontFamily:"inherit" }} />
              <button onClick={() => setShowSenha(s=>!s)}
                style={{ position:"absolute", right:14, top:"50%", transform:"translateY(-50%)", background:"none", border:"none", cursor:"pointer", color:"#64748b", fontSize:16 }}>
                {showSenha?"🙈":"👁"}
              </button>
            </div>
          </div>

          {erro && (
            <div style={{ background:"#450a0a", border:"1px solid #dc2626", color:"#fca5a5", fontSize:13, padding:"10px 14px", borderRadius:8, marginBottom:16 }}>
              ⚠ {erro}
            </div>
          )}

          <button onClick={handleLogin} disabled={loading||!usuario||!senha}
            style={{ width:"100%", background:loading||!usuario||!senha?"#334155":"#ffe000", border:"none", color:loading||!usuario||!senha?"#64748b":"#0f172a", fontWeight:800, padding:"14px", borderRadius:12, cursor:loading||!usuario||!senha?"not-allowed":"pointer", fontSize:15, transition:"all .15s" }}>
            {loading ? "Verificando..." : "Entrar"}
          </button>

          <div style={{ textAlign:"center", marginTop:16, fontSize:12, color:"#475569" }}>
            Acesso restrito — somente usuários autorizados
          </div>
        </div>

        <div style={{ textAlign:"center", marginTop:20, fontSize:11, color:"#334155" }}>
          Primeiro acesso: usuário <strong style={{ color:"#64748b" }}>admin</strong> / senha <strong style={{ color:"#64748b" }}>admin123</strong>
        </div>
      </div>
    </div>
  );
}

// ── Painel de Administração de Usuários ──────────────────────
function ModalUsuario({ usuario, onSave, onClose }) {
  const [form, setForm] = useState(usuario || {
    id: Date.now().toString(),
    nome: "", usuario: "", senha: "", ativo: true, admin: false,
    permissoes: ["overview","listings","orders"],
  });
  const [showSenha, setShowSenha] = useState(false);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  function togglePerm(key) {
    const perms = form.permissoes || [];
    set("permissoes", perms.includes(key) ? perms.filter(p=>p!==key) : [...perms, key]);
  }

  function handleSave() {
    if (!form.nome || !form.usuario) return;
    const toSave = { ...form };
    if (form.senha) {
      toSave.senhaHash = hashSenha(form.senha);
      delete toSave.senha;
    } else if (!usuario) {
      alert("Informe uma senha para o novo usuário");
      return;
    } else {
      delete toSave.senha;
    }
    if (!toSave.criadoEm) toSave.criadoEm = new Date().toLocaleDateString("sv-SE");
    onSave(toSave);
    onClose();
  }

  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,.7)", backdropFilter:"blur(4px)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:600, padding:24 }}>
      <div style={{ background:"#fff", borderRadius:16, width:"100%", maxWidth:520, padding:"28px 32px", boxShadow:"0 20px 60px rgba(0,0,0,.3)", maxHeight:"90vh", overflowY:"auto" }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:20 }}>
          <div style={{ fontWeight:800, fontSize:17, color:"#0f172a" }}>{usuario ? "Editar Usuário" : "Novo Usuário"}</div>
          <button onClick={onClose} style={{ background:"#f1f5f9", border:"none", color:"#64748b", width:32, height:32, borderRadius:8, cursor:"pointer", fontSize:16 }}>✕</button>
        </div>

        <div style={{ display:"flex", flexDirection:"column", gap:12, marginBottom:20 }}>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
            <div>
              <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Nome completo *</div>
              <input value={form.nome} onChange={e=>set("nome",e.target.value)} placeholder="Ex: João Silva"
                style={{ width:"100%", background:"#f8fafc", border:"1px solid #e2e8f0", color:"#0f172a", padding:"9px 12px", borderRadius:8, fontSize:13, outline:"none" }} />
            </div>
            <div>
              <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Usuário (login) *</div>
              <input value={form.usuario} onChange={e=>set("usuario",e.target.value.toLowerCase().replace(/\s/g,""))} placeholder="Ex: joao"
                style={{ width:"100%", background:"#f8fafc", border:"1px solid #e2e8f0", color:"#0f172a", padding:"9px 12px", borderRadius:8, fontSize:13, outline:"none", fontFamily:"monospace" }} />
            </div>
          </div>

          <div>
            <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>
              {usuario ? "Nova senha (deixe vazio para manter)" : "Senha *"}
            </div>
            <div style={{ position:"relative" }}>
              <input type={showSenha?"text":"password"} value={form.senha||""} onChange={e=>set("senha",e.target.value)}
                placeholder={usuario?"••••••••":"Mínimo 6 caracteres"}
                style={{ width:"100%", background:"#f8fafc", border:"1px solid #e2e8f0", color:"#0f172a", padding:"9px 44px 9px 12px", borderRadius:8, fontSize:13, outline:"none" }} />
              <button onClick={()=>setShowSenha(s=>!s)}
                style={{ position:"absolute", right:10, top:"50%", transform:"translateY(-50%)", background:"none", border:"none", cursor:"pointer", color:"#94a3b8", fontSize:14 }}>
                {showSenha?"🙈":"👁"}
              </button>
            </div>
          </div>

          {/* Permissões */}
          <div style={{ background:"#f8fafc", borderRadius:12, padding:"14px 16px" }}>
            <div style={{ fontWeight:700, fontSize:13, color:"#0f172a", marginBottom:12 }}>Permissões de Acesso</div>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
              {PERMISSOES_DISPONIVEIS.map(p => (
                <label key={p.key} style={{ display:"flex", alignItems:"center", gap:8, cursor:"pointer", padding:"8px 10px", borderRadius:8, background:form.permissoes?.includes(p.key)?"#eff6ff":"#fff", border:`1px solid ${form.permissoes?.includes(p.key)?"#2563eb":"#e2e8f0"}`, transition:"all .15s" }}>
                  <input type="checkbox" checked={form.permissoes?.includes(p.key)||false} onChange={()=>togglePerm(p.key)}
                    style={{ width:14, height:14, cursor:"pointer" }} />
                  <span style={{ fontSize:13, color:form.permissoes?.includes(p.key)?"#1d4ed8":"#334155", fontWeight:form.permissoes?.includes(p.key)?600:400 }}>{p.label}</span>
                </label>
              ))}
            </div>
          </div>

          {/* Status e Admin */}
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
            <label style={{ display:"flex", alignItems:"center", gap:8, cursor:"pointer", padding:"10px 14px", borderRadius:8, background:"#f8fafc", border:"1px solid #e2e8f0" }}>
              <input type="checkbox" checked={form.ativo} onChange={e=>set("ativo",e.target.checked)} style={{ width:14, height:14 }} />
              <span style={{ fontSize:13, color:"#334155", fontWeight:500 }}>Usuário ativo</span>
            </label>
            <label style={{ display:"flex", alignItems:"center", gap:8, cursor:"pointer", padding:"10px 14px", borderRadius:8, background:"#f8fafc", border:"1px solid #e2e8f0" }}>
              <input type="checkbox" checked={form.admin||false} onChange={e=>set("admin",e.target.checked)} style={{ width:14, height:14 }} />
              <span style={{ fontSize:13, color:"#334155", fontWeight:500 }}>Administrador</span>
            </label>
          </div>
        </div>

        <div style={{ display:"flex", gap:8 }}>
          <button onClick={onClose} style={{ flex:1, background:"#f8fafc", border:"1px solid #e2e8f0", color:"#64748b", fontWeight:600, padding:"11px", borderRadius:10, cursor:"pointer" }}>Cancelar</button>
          <button onClick={handleSave} disabled={!form.nome||!form.usuario}
            style={{ flex:2, background:!form.nome||!form.usuario?"#f1f5f9":"#0f172a", border:"none", color:!form.nome||!form.usuario?"#94a3b8":"#fff", fontWeight:700, padding:"11px", borderRadius:10, cursor:!form.nome||!form.usuario?"not-allowed":"pointer" }}>
            Salvar Usuário
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Aba de Administração ─────────────────────────────────────
function AdminTab({ currentUser }) {
  const [usuarios, setUsuarios] = useState(getUsuarios);
  const [showModal, setShowModal] = useState(false);
  const [editingUser, setEditingUser] = useState(null);

  function saveUser(user) {
    const lista = getUsuarios();
    const updated = lista.find(u=>u.id===user.id)
      ? lista.map(u=>u.id===user.id?user:u)
      : [...lista, user];
    saveUsuarios(updated);
    setUsuarios(updated);
  }

  function deleteUser(id) {
    if (id === currentUser.id) { alert("Você não pode excluir seu próprio usuário!"); return; }
    if (!confirm("Excluir este usuário?")) return;
    const updated = getUsuarios().filter(u=>u.id!==id);
    saveUsuarios(updated);
    setUsuarios(updated);
  }

  function toggleAtivo(id) {
    if (id === currentUser.id) { alert("Você não pode desativar seu próprio usuário!"); return; }
    const updated = getUsuarios().map(u=>u.id===id?{...u,ativo:!u.ativo}:u);
    saveUsuarios(updated);
    setUsuarios(updated);
  }

  return (
    <div>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:20 }}>
        <div>
          <div style={{ fontWeight:800, fontSize:18, color:"#0f172a" }}>⚙️ Administração de Usuários</div>
          <div style={{ fontSize:13, color:"#94a3b8", marginTop:2 }}>Gerencie quem pode acessar o dashboard e o que cada um pode ver</div>
        </div>
        <button onClick={()=>{ setEditingUser(null); setShowModal(true); }}
          style={{ background:"#0f172a", border:"none", color:"#fff", fontWeight:700, padding:"10px 22px", borderRadius:10, cursor:"pointer", fontSize:13 }}>
          + Novo Usuário
        </button>
      </div>

      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(300px,1fr))", gap:12 }}>
        {usuarios.map(u => (
          <div key={u.id} style={{ background:"#fff", border:`2px solid ${u.id===currentUser.id?"#0f172a":u.ativo?"#e2e8f0":"#f1f5f9"}`, borderRadius:14, padding:"18px 20px", position:"relative", opacity:u.ativo?1:0.6 }}>
            {u.id===currentUser.id && (
              <div style={{ position:"absolute", top:12, left:12, background:"#0f172a", color:"#fff", fontSize:10, padding:"2px 8px", borderRadius:20, fontWeight:700 }}>VOCÊ</div>
            )}
            <div style={{ display:"flex", justifyContent:"flex-end", gap:6, marginBottom:8 }}>
              <button onClick={()=>toggleAtivo(u.id)}
                style={{ background:u.ativo?"#f0fdf4":"#f8fafc", border:`1px solid ${u.ativo?"#bbf7d0":"#e2e8f0"}`, color:u.ativo?"#15803d":"#94a3b8", padding:"3px 10px", borderRadius:6, cursor:"pointer", fontSize:11, fontWeight:600 }}>
                {u.ativo?"● Ativo":"○ Inativo"}
              </button>
              <button onClick={()=>{ setEditingUser(u); setShowModal(true); }}
                style={{ background:"#f1f5f9", border:"none", color:"#64748b", width:28, height:28, borderRadius:6, cursor:"pointer", fontSize:12 }}>✏️</button>
              {u.id!==currentUser.id && (
                <button onClick={()=>deleteUser(u.id)}
                  style={{ background:"#fef2f2", border:"none", color:"#dc2626", width:28, height:28, borderRadius:6, cursor:"pointer", fontSize:12 }}>🗑</button>
              )}
            </div>

            <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:12 }}>
              <div style={{ width:42, height:42, borderRadius:12, background:u.admin?"#0f172a":"#f1f5f9", display:"flex", alignItems:"center", justifyContent:"center", fontSize:18, fontWeight:800, color:u.admin?"#ffe000":"#64748b" }}>
                {u.nome?.charAt(0).toUpperCase()}
              </div>
              <div>
                <div style={{ fontWeight:700, fontSize:15, color:"#0f172a" }}>{u.nome}</div>
                <div style={{ fontSize:12, color:"#94a3b8", fontFamily:"monospace" }}>@{u.usuario}</div>
                {u.admin && <div style={{ fontSize:10, color:"#7c3aed", fontWeight:700 }}>ADMINISTRADOR</div>}
              </div>
            </div>

            <div style={{ fontSize:11, color:"#94a3b8", marginBottom:6, fontWeight:600, textTransform:"uppercase" }}>Permissões</div>
            <div style={{ display:"flex", flexWrap:"wrap", gap:4 }}>
              {PERMISSOES_DISPONIVEIS.map(p => (
                <span key={p.key} style={{ fontSize:11, padding:"2px 8px", borderRadius:20, background:u.permissoes?.includes(p.key)?"#eff6ff":"#f8fafc", color:u.permissoes?.includes(p.key)?"#2563eb":"#cbd5e1", border:`1px solid ${u.permissoes?.includes(p.key)?"#bfdbfe":"#f1f5f9"}`, fontWeight:u.permissoes?.includes(p.key)?600:400 }}>
                  {p.label}
                </span>
              ))}
            </div>
            <div style={{ fontSize:11, color:"#cbd5e1", marginTop:10 }}>Criado em {u.criadoEm||"—"}</div>
          </div>
        ))}
      </div>

      {showModal && <ModalUsuario usuario={editingUser} onSave={saveUser} onClose={()=>{ setShowModal(false); setEditingUser(null); }} />}
    </div>
  );
}


// ── Versão compacta do painel de Impostos/Custos Fixos ───────
function ImpostosCompacto({ impostos, setImpostos, custosFixos, setCustosFixos, faturamentoMes }) {
  const [novoImposto, setNovoImposto] = useState({ nome:"", valor:"", tipo:"%" });
  const [novoCusto, setNovoCusto]     = useState({ nome:"", valor:"", tipo:"%" });

  function addI() {
    if (!novoImposto.nome || !novoImposto.valor) return;
    const u = [...impostos, { ...novoImposto, id: Date.now() }];
    setImpostos(u); saveImpostos(u); setNovoImposto({ nome:"", valor:"", tipo:"%" });
  }
  function addC() {
    if (!novoCusto.nome || !novoCusto.valor) return;
    const u = [...custosFixos, { ...novoCusto, id: Date.now() }];
    setCustosFixos(u); saveCustosFixos(u); setNovoCusto({ nome:"", valor:"", tipo:"%" });
  }
  function removeI(id) { const u = impostos.filter(i=>i.id!==id); setImpostos(u); saveImpostos(u); }
  function removeC(id) { const u = custosFixos.filter(c=>c.id!==id); setCustosFixos(u); saveCustosFixos(u); }
  function updateI(id, f, v) { const u = impostos.map(i=>i.id===id?{...i,[f]:v}:i); setImpostos(u); saveImpostos(u); }
  function updateC(id, f, v) { const u = custosFixos.map(c=>c.id===id?{...c,[f]:v}:c); setCustosFixos(u); saveCustosFixos(u); }

  const inp = { background:"#f8fafc", border:"1px solid #e2e8f0", color:"#0f172a", padding:"6px 10px", borderRadius:7, fontSize:12, outline:"none", fontFamily:"inherit" };
  const tBtn = (item, t, fn) => (
    <button onClick={()=>fn("tipo",t)} style={{ padding:"3px 8px", borderRadius:5, border:"none", cursor:"pointer", fontSize:11, fontWeight:700, background:item.tipo===t?"#0f172a":"#e2e8f0", color:item.tipo===t?"#fff":"#64748b" }}>{t}</button>
  );

  const Row = ({ item, onUpdate, onRemove, color }) => (
    <div style={{ display:"flex", gap:6, alignItems:"center", marginBottom:6 }}>
      <input value={item.nome} onChange={e=>onUpdate(item.id,"nome",e.target.value)} style={{ ...inp, flex:2 }} placeholder="Nome" />
      <div style={{ display:"flex", gap:2 }}>
        {tBtn(item,"%",onUpdate.bind(null,item.id))}
        {tBtn(item,"R$",onUpdate.bind(null,item.id))}
      </div>
      <input type="number" value={item.valor} onChange={e=>onUpdate(item.id,"valor",e.target.value)} style={{ ...inp, width:70 }} placeholder="0" />
      <span style={{ fontSize:11, color:"#94a3b8", minWidth:70, textAlign:"right" }}>
        = R$ {calcValor(item, faturamentoMes).toFixed(2).replace(".",",")}
      </span>
      <button onClick={()=>onRemove(item.id)} style={{ background:"#fef2f2", border:"none", color:"#dc2626", width:24, height:24, borderRadius:5, cursor:"pointer", fontSize:11, flexShrink:0 }}>✕</button>
    </div>
  );

  const AddRow = ({ novo, setNovo, onAdd, placeholder }) => (
    <div style={{ display:"flex", gap:6, alignItems:"center", marginTop:6 }}>
      <input value={novo.nome} onChange={e=>setNovo(n=>({...n,nome:e.target.value}))}
        onKeyDown={e=>e.key==="Enter"&&onAdd()}
        style={{ ...inp, flex:2 }} placeholder={placeholder} />
      <div style={{ display:"flex", gap:2 }}>
        {tBtn(novo,"%",(f,v)=>setNovo(n=>({...n,[f]:v})))}
        {tBtn(novo,"R$",(f,v)=>setNovo(n=>({...n,[f]:v})))}
      </div>
      <input type="number" value={novo.valor} onChange={e=>setNovo(n=>({...n,valor:e.target.value}))}
        onKeyDown={e=>e.key==="Enter"&&onAdd()}
        style={{ ...inp, width:70 }} placeholder="0" />
      <span style={{ fontSize:11, color:"#94a3b8", minWidth:70 }} />
      <button onClick={onAdd} disabled={!novo.nome||!novo.valor}
        style={{ background:novo.nome&&novo.valor?"#0f172a":"#e2e8f0", border:"none", color:novo.nome&&novo.valor?"#fff":"#94a3b8", width:24, height:24, borderRadius:5, cursor:"pointer", fontSize:14, flexShrink:0 }}>+</button>
    </div>
  );

  return (
    <div style={{ background:"#f8fafc", border:"1px solid #e2e8f0", borderRadius:12, padding:"16px 18px" }}>
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:20 }}>
        <div>
          <div style={{ fontSize:12, fontWeight:700, color:"#dc2626", marginBottom:10, textTransform:"uppercase", letterSpacing:0.5 }}>🧾 Impostos</div>
          {impostos.map(i => <Row key={i.id} item={i} onUpdate={updateI} onRemove={removeI} color="#dc2626" />)}
          <AddRow novo={novoImposto} setNovo={setNovoImposto} onAdd={addI} placeholder="Ex: ICMS, Simples..." />
        </div>
        <div>
          <div style={{ fontSize:12, fontWeight:700, color:"#d97706", marginBottom:10, textTransform:"uppercase", letterSpacing:0.5 }}>🏢 Custos Fixos</div>
          {custosFixos.map(c => <Row key={c.id} item={c} onUpdate={updateC} onRemove={removeC} color="#d97706" />)}
          <AddRow novo={novoCusto} setNovo={setNovoCusto} onAdd={addC} placeholder="Ex: Aluguel, Salário..." />
        </div>
      </div>
    </div>
  );
}


// ════════════════════════════════════════════════════════════
//  IMPOSTOS E CUSTOS FIXOS — Painel da Visão Geral
// ════════════════════════════════════════════════════════════

function saveImpostos(v) { try { localStorage.setItem("impostos_config", JSON.stringify(v)); } catch {} }
function saveCustosFixos(v) { try { localStorage.setItem("custos_fixos_config", JSON.stringify(v)); } catch {} }

function calcValor(item, base) {
  if (!item.valor) return 0;
  const v = parseFloat(item.valor || 0);
  if (item.tipo === "%") return base * (v / 100);
  return v; // R$
}

function ImpostosPanel({ impostos, setImpostos, custosFixos, setCustosFixos, faturamentoMes, darkMode, card, txt, txtMuted }) {
  const [editando, setEditando] = useState(false);
  const [novoImposto, setNovoImposto] = useState({ nome: "", valor: "", tipo: "%" });
  const [novoCusto, setNovoCusto] = useState({ nome: "", valor: "", tipo: "%" });

  const totalImpostos = impostos.reduce((s, i) => s + calcValor(i, faturamentoMes), 0);
  const totalCustosFixos = custosFixos.reduce((s, c) => s + calcValor(c, faturamentoMes), 0);
  const totalDeducoes = totalImpostos + totalCustosFixos;
  const lucroReal = faturamentoMes - totalDeducoes;

  function addImposto() {
    if (!novoImposto.nome || !novoImposto.valor) return;
    const updated = [...impostos, { ...novoImposto, id: Date.now() }];
    setImpostos(updated); saveImpostos(updated);
    setNovoImposto({ nome: "", valor: "", tipo: "%" });
  }

  function addCusto() {
    if (!novoCusto.nome || !novoCusto.valor) return;
    const updated = [...custosFixos, { ...novoCusto, id: Date.now() }];
    setCustosFixos(updated); saveCustosFixos(updated);
    setNovoCusto({ nome: "", valor: "", tipo: "%" });
  }

  function removeImposto(id) {
    const updated = impostos.filter(i => i.id !== id);
    setImpostos(updated); saveImpostos(updated);
  }

  function removeCusto(id) {
    const updated = custosFixos.filter(c => c.id !== id);
    setCustosFixos(updated); saveCustosFixos(updated);
  }

  function updateImposto(id, field, value) {
    const updated = impostos.map(i => i.id === id ? { ...i, [field]: value } : i);
    setImpostos(updated); saveImpostos(updated);
  }

  function updateCusto(id, field, value) {
    const updated = custosFixos.map(c => c.id === id ? { ...c, [field]: value } : c);
    setCustosFixos(updated); saveCustosFixos(updated);
  }

  const inputStyle = {
    background: darkMode ? "#0f172a" : "#f8fafc",
    border: `1px solid ${darkMode ? "#334155" : "#e2e8f0"}`,
    color: darkMode ? "#e2e8f0" : "#0f172a",
    padding: "7px 10px", borderRadius: 8, fontSize: 13, outline: "none", fontFamily: "inherit"
  };

  const tipoBtn = (item, tipo, onChange) => (
    <button onClick={() => onChange("tipo", tipo)}
      style={{ padding: "4px 10px", borderRadius: 6, border: "none", cursor: "pointer", fontSize: 12, fontWeight: 700,
        background: item.tipo === tipo ? "#0f172a" : darkMode ? "#334155" : "#e2e8f0",
        color: item.tipo === tipo ? "#fff" : darkMode ? "#94a3b8" : "#64748b" }}>
      {tipo}
    </button>
  );

  return (
    <div style={{ ...card(), padding: "20px 24px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <div>
          <div style={{ fontWeight: 800, fontSize: 15, ...txt }}>📊 Impostos e Custos Fixos</div>
          <div style={{ fontSize: 12, ...txtMuted, marginTop: 2 }}>Deduzidos do faturamento para calcular o lucro real</div>
        </div>
        <button onClick={() => setEditando(e => !e)}
          style={{ background: editando ? "#0f172a" : darkMode ? "#334155" : "#f1f5f9", border: "none", color: editando ? "#fff" : darkMode ? "#e2e8f0" : "#64748b", fontWeight: 600, padding: "7px 16px", borderRadius: 8, cursor: "pointer", fontSize: 13 }}>
          {editando ? "✓ Fechar" : "✏️ Editar"}
        </button>
      </div>

      {/* Resumo sempre visível */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px,1fr))", gap: 10, marginBottom: editando ? 20 : 0 }}>
        <div style={{ background: darkMode ? "#1e293b" : "#fef2f2", borderRadius: 10, padding: "12px 16px", border: `1px solid ${darkMode ? "#334155" : "#fecaca"}` }}>
          <div style={{ fontSize: 11, color: "#dc2626", fontWeight: 700, textTransform: "uppercase", marginBottom: 4 }}>Total Impostos</div>
          <div style={{ fontSize: 18, fontWeight: 800, color: "#dc2626" }}>{`R$ ${totalImpostos.toFixed(2).replace(".", ",")}`}</div>
          <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 2 }}>{impostos.length} item(ns)</div>
        </div>
        <div style={{ background: darkMode ? "#1e293b" : "#fef2f2", borderRadius: 10, padding: "12px 16px", border: `1px solid ${darkMode ? "#334155" : "#fecaca"}` }}>
          <div style={{ fontSize: 11, color: "#d97706", fontWeight: 700, textTransform: "uppercase", marginBottom: 4 }}>Custos Fixos</div>
          <div style={{ fontSize: 18, fontWeight: 800, color: "#d97706" }}>{`R$ ${totalCustosFixos.toFixed(2).replace(".", ",")}`}</div>
          <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 2 }}>{custosFixos.length} item(ns)</div>
        </div>
        <div style={{ background: darkMode ? "#1e293b" : "#f0fdf4", borderRadius: 10, padding: "12px 16px", border: `1px solid ${darkMode ? "#334155" : "#bbf7d0"}` }}>
          <div style={{ fontSize: 11, color: "#15803d", fontWeight: 700, textTransform: "uppercase", marginBottom: 4 }}>Lucro Real do Mês</div>
          <div style={{ fontSize: 18, fontWeight: 800, color: lucroReal >= 0 ? "#15803d" : "#dc2626" }}>{`R$ ${lucroReal.toFixed(2).replace(".", ",")}`}</div>
          <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 2 }}>Fat. - Impostos - Fixos</div>
        </div>
      </div>

      {/* Edição */}
      {editando && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>

          {/* IMPOSTOS */}
          <div>
            <div style={{ fontWeight: 700, fontSize: 13, color: "#dc2626", marginBottom: 12 }}>🧾 Impostos</div>
            {impostos.map(item => (
              <div key={item.id} style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 8 }}>
                <input value={item.nome} onChange={e => updateImposto(item.id, "nome", e.target.value)}
                  style={{ ...inputStyle, flex: 2, padding: "6px 8px" }} placeholder="Nome" />
                <div style={{ display: "flex", gap: 2 }}>
                  {tipoBtn(item, "%", (f, v) => updateImposto(item.id, f, v))}
                  {tipoBtn(item, "R$", (f, v) => updateImposto(item.id, f, v))}
                </div>
                <input type="number" value={item.valor} onChange={e => updateImposto(item.id, "valor", e.target.value)}
                  style={{ ...inputStyle, width: 80, padding: "6px 8px" }} placeholder={item.tipo === "%" ? "0,00" : "0,00"} />
                <div style={{ fontSize: 11, color: "#94a3b8", minWidth: 60, textAlign: "right" }}>
                  = {`R$ ${calcValor(item, faturamentoMes).toFixed(2).replace(".", ",")}`}
                </div>
                <button onClick={() => removeImposto(item.id)}
                  style={{ background: "#fef2f2", border: "none", color: "#dc2626", width: 26, height: 26, borderRadius: 6, cursor: "pointer", fontSize: 12, flexShrink: 0 }}>✕</button>
              </div>
            ))}
            {/* Novo imposto */}
            <div style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 8 }}>
              <input value={novoImposto.nome} onChange={e => setNovoImposto(n => ({ ...n, nome: e.target.value }))}
                onKeyDown={e => e.key === "Enter" && addImposto()}
                style={{ ...inputStyle, flex: 2, padding: "6px 8px" }} placeholder="Ex: ICMS, ISS..." />
              <div style={{ display: "flex", gap: 2 }}>
                {tipoBtn(novoImposto, "%", (f, v) => setNovoImposto(n => ({ ...n, [f]: v })))}
                {tipoBtn(novoImposto, "R$", (f, v) => setNovoImposto(n => ({ ...n, [f]: v })))}
              </div>
              <input type="number" value={novoImposto.valor} onChange={e => setNovoImposto(n => ({ ...n, valor: e.target.value }))}
                onKeyDown={e => e.key === "Enter" && addImposto()}
                style={{ ...inputStyle, width: 80, padding: "6px 8px" }} placeholder="0,00" />
              <button onClick={addImposto} disabled={!novoImposto.nome || !novoImposto.valor}
                style={{ background: novoImposto.nome && novoImposto.valor ? "#0f172a" : "#e2e8f0", border: "none", color: novoImposto.nome && novoImposto.valor ? "#fff" : "#94a3b8", width: 26, height: 26, borderRadius: 6, cursor: "pointer", fontSize: 14, flexShrink: 0 }}>+</button>
            </div>
          </div>

          {/* CUSTOS FIXOS */}
          <div>
            <div style={{ fontWeight: 700, fontSize: 13, color: "#d97706", marginBottom: 12 }}>🏢 Custos Fixos</div>
            {custosFixos.map(item => (
              <div key={item.id} style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 8 }}>
                <input value={item.nome} onChange={e => updateCusto(item.id, "nome", e.target.value)}
                  style={{ ...inputStyle, flex: 2, padding: "6px 8px" }} placeholder="Nome" />
                <div style={{ display: "flex", gap: 2 }}>
                  {tipoBtn(item, "%", (f, v) => updateCusto(item.id, f, v))}
                  {tipoBtn(item, "R$", (f, v) => updateCusto(item.id, f, v))}
                </div>
                <input type="number" value={item.valor} onChange={e => updateCusto(item.id, "valor", e.target.value)}
                  style={{ ...inputStyle, width: 80, padding: "6px 8px" }} placeholder="0,00" />
                <div style={{ fontSize: 11, color: "#94a3b8", minWidth: 60, textAlign: "right" }}>
                  = {`R$ ${calcValor(item, faturamentoMes).toFixed(2).replace(".", ",")}`}
                </div>
                <button onClick={() => removeCusto(item.id)}
                  style={{ background: "#fef2f2", border: "none", color: "#dc2626", width: 26, height: 26, borderRadius: 6, cursor: "pointer", fontSize: 12, flexShrink: 0 }}>✕</button>
              </div>
            ))}
            {/* Novo custo */}
            <div style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 8 }}>
              <input value={novoCusto.nome} onChange={e => setNovoCusto(n => ({ ...n, nome: e.target.value }))}
                onKeyDown={e => e.key === "Enter" && addCusto()}
                style={{ ...inputStyle, flex: 2, padding: "6px 8px" }} placeholder="Ex: Aluguel, Salário..." />
              <div style={{ display: "flex", gap: 2 }}>
                {tipoBtn(novoCusto, "%", (f, v) => setNovoCusto(n => ({ ...n, [f]: v })))}
                {tipoBtn(novoCusto, "R$", (f, v) => setNovoCusto(n => ({ ...n, [f]: v })))}
              </div>
              <input type="number" value={novoCusto.valor} onChange={e => setNovoCusto(n => ({ ...n, valor: e.target.value }))}
                onKeyDown={e => e.key === "Enter" && addCusto()}
                style={{ ...inputStyle, width: 80, padding: "6px 8px" }} placeholder="0,00" />
              <button onClick={addCusto} disabled={!novoCusto.nome || !novoCusto.valor}
                style={{ background: novoCusto.nome && novoCusto.valor ? "#0f172a" : "#e2e8f0", border: "none", color: novoCusto.nome && novoCusto.valor ? "#fff" : "#94a3b8", width: 26, height: 26, borderRadius: 6, cursor: "pointer", fontSize: 14, flexShrink: 0 }}>+</button>
            </div>
          </div>

        </div>
      )}

      {/* Lista resumida quando fechado */}
      {!editando && (impostos.length > 0 || custosFixos.length > 0) && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 12 }}>
          {impostos.map(i => (
            <span key={i.id} style={{ fontSize: 11, background: darkMode ? "#1e293b" : "#fef2f2", color: "#dc2626", border: "1px solid #fecaca", padding: "2px 8px", borderRadius: 20, fontWeight: 500 }}>
              {i.nome}: {i.tipo === "%" ? `${i.valor}%` : `R$ ${parseFloat(i.valor).toFixed(2).replace(".", ",")}`} = R$ {calcValor(i, faturamentoMes).toFixed(2).replace(".", ",")}
            </span>
          ))}
          {custosFixos.map(c => (
            <span key={c.id} style={{ fontSize: 11, background: darkMode ? "#1e293b" : "#fffbeb", color: "#d97706", border: "1px solid #fde68a", padding: "2px 8px", borderRadius: 20, fontWeight: 500 }}>
              {c.nome}: {c.tipo === "%" ? `${c.valor}%` : `R$ ${parseFloat(c.valor).toFixed(2).replace(".", ",")}`} = R$ {calcValor(c, faturamentoMes).toFixed(2).replace(".", ",")}
            </span>
          ))}
        </div>
      )}

      {!editando && impostos.length === 0 && custosFixos.length === 0 && (
        <div style={{ textAlign: "center", padding: "16px 0", ...txtMuted, fontSize: 13 }}>
          Clique em <strong>✏️ Editar</strong> para adicionar impostos e custos fixos
        </div>
      )}
    </div>
  );
}


// ════════════════════════════════════════════════════════════
//  OVERVIEW — Visão Geral Unificada
// ════════════════════════════════════════════════════════════

function MiniBar({ value, max, color }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div style={{ height:6, background:"#e2e8f0", borderRadius:99, overflow:"hidden", marginTop:6 }}>
      <div style={{ width:`${pct}%`, height:"100%", background:color, borderRadius:99, transition:"width .5s" }} />
    </div>
  );
}

function SparkLine({ data, color }) {
  if (!data || data.length < 2) return null;
  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min || 1;
  const w = 120, h = 40;
  const points = data.map((v, i) => `${(i/(data.length-1))*w},${h - ((v-min)/range)*h}`).join(" ");
  return (
    <svg width={w} height={h} style={{ overflow:"visible" }}>
      <polyline points={points} fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={(data.length-1)/(data.length-1)*w} cy={h-((data[data.length-1]-min)/range)*h} r={3} fill={color} />
    </svg>
  );
}

function OverviewTab({ enriched, enrichedOrders, rawOrders, contasPagar, contasBancarias, lancamentos, paymentData, shipmentStatuses, metaMensal, setMetaMensal, darkMode, costs, impostos, setImpostos, custosFixos, setCustosFixos }) {
  const [editMeta, setEditMeta] = useState(false);
  const [metaInput, setMetaInput] = useState(String(metaMensal || ""));

  const hoje = new Date().toLocaleDateString("sv-SE");
  const mesAtual = hoje.slice(0,7);
  const mesAnterior = new Date(new Date().setMonth(new Date().getMonth()-1)).toLocaleDateString("sv-SE").slice(0,7);

  // ── Pedidos deste mês ────────────────────────────────────
  const pedidosMes = rawOrders.filter(o => o.date?.startsWith(mesAtual) && o.status === "paid");
  const pedidosMesAnt = rawOrders.filter(o => o.date?.startsWith(mesAnterior) && o.status === "paid");
  // Usa todos os pedidos pagos do mês (mesma base dos KPI cards no topo quando filtro = "Este mês")
  const faturamentoMes = pedidosMes.reduce((s,o) => s+o.price*o.qty, 0);
  const faturamentoMesAnt = pedidosMesAnt.reduce((s,o) => s+o.price*o.qty, 0);
  const crescimento = faturamentoMesAnt > 0 ? ((faturamentoMes - faturamentoMesAnt) / faturamentoMesAnt) * 100 : 0;
  const ticketMedio = pedidosMes.length > 0 ? faturamentoMes / pedidosMes.length : 0;

  // ── Pedidos hoje ─────────────────────────────────────────
  const pedidosHoje = rawOrders.filter(o => o.date === hoje && o.status === "paid");
  const faturamentoHoje = pedidosHoje.reduce((s,o) => s+o.price*o.qty, 0);

  // ── Alertas ──────────────────────────────────────────────
  const agEnvio = rawOrders.filter(o => {
    if (o.status !== "paid") return false;
    const ss = shipmentStatuses?.[o.id] ?? o.shipment_status;
    return !["shipped","in_transit","delivered"].includes(ss) && !o.tags?.some(t=>t==="delivered");
  });
  const vencidos = contasPagar.filter(c => c.status === "Pendente" && c.vencimento && getDaysUntil(c.vencimento) < 0);
  const vencendo7 = contasPagar.filter(c => c.status === "Pendente" && c.vencimento && getDaysUntil(c.vencimento) >= 0 && getDaysUntil(c.vencimento) <= 7);
  const estoqueCritico = enriched.filter(l => {
    if (!l.available_quantity) return false;
    const prod = null; // será implementado com sync de produtos
    return l.available_quantity <= 3;
  });

  // ── Ranking produtos mais vendidos ───────────────────────
  const vendasPorProduto = {};
  rawOrders.filter(o => o.status === "paid" && o.date?.startsWith(mesAtual)).forEach(o => {
    const id = o.listing_id;
    if (!id) return;
    if (!vendasPorProduto[id]) vendasPorProduto[id] = { id, title: o.title, qty: 0, revenue: 0 };
    vendasPorProduto[id].qty += o.qty || 1;
    vendasPorProduto[id].revenue += o.price * (o.qty || 1);
  });
  const rankingVendas = Object.values(vendasPorProduto).sort((a,b) => b.qty - a.qty).slice(0,5);
  const maxQty = rankingVendas[0]?.qty || 1;

  // ── Ranking mais lucrativos ──────────────────────────────
  const rankingLucro = enriched
    .filter(l => costs[l.id] > 0 && l.sold_quantity > 0)
    .sort((a,b) => b.totalProfit - a.totalProfit)
    .slice(0, 5);

  // ── Faturamento por dia (últimos 14 dias) ────────────────
  const ultimos14 = Array.from({length:14}, (_,i) => {
    const d = new Date(); d.setDate(d.getDate()-13+i);
    return d.toLocaleDateString("sv-SE");
  });
  const fatPorDia = ultimos14.map(d => rawOrders.filter(o=>o.date===d&&o.status==="paid").reduce((s,o)=>s+o.price*o.qty,0));

  // ── Distribuição por status ──────────────────────────────
  const statusCount = { agEnvio: 0, enviado: 0, entregue: 0, cancelado: 0, devolvido: 0 };
  rawOrders.filter(o=>o.date?.startsWith(mesAtual)).forEach(o => {
    const ss = shipmentStatuses?.[o.id];
    if (o.status === "cancelled") { statusCount.cancelado++; return; }
    if (ss === "delivered" || o.tags?.some(t=>t==="delivered")) { statusCount.entregue++; return; }
    if (["shipped","in_transit"].includes(ss)) { statusCount.enviado++; return; }
    if (o.status === "paid") statusCount.agEnvio++;
  });

  // ── Previsão do mês ──────────────────────────────────────
  const diaDoMes = new Date().getDate();
  const diasNoMes = new Date(new Date().getFullYear(), new Date().getMonth()+1, 0).getDate();
  const previsaoMes = diaDoMes > 0 ? (faturamentoMes / diaDoMes) * diasNoMes : 0;
  const progressoMeta = metaMensal > 0 ? Math.min(100, (faturamentoMes / metaMensal) * 100) : 0;

  // ── Taxa de cancelamento ──────────────────────────────────
  const totalMes = rawOrders.filter(o=>o.date?.startsWith(mesAtual)).length;
  const canceladosMes = rawOrders.filter(o=>o.date?.startsWith(mesAtual)&&o.status==="cancelled").length;
  const taxaCancel = totalMes > 0 ? (canceladosMes/totalMes)*100 : 0;

  const card = (bg) => ({
    background: darkMode ? "#1e293b" : bg || "#fff",
    border: `1px solid ${darkMode?"#334155":"#e2e8f0"}`,
    borderRadius: 12,
    padding: "16px 18px",
    boxShadow: "0 1px 3px rgba(0,0,0,.06)",
  });

  const txt = { color: darkMode?"#e2e8f0":"#0f172a" };
  const txtMuted = { color: darkMode?"#94a3b8":"#64748b" };

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:20 }}>

      {/* ── ALERTAS ── */}
      {(vencidos.length > 0 || vencendo7.length > 0 || agEnvio.length > 5) && (
        <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
          {vencidos.length > 0 && (
            <div style={{ background:"#fef2f2", border:"1px solid #fecaca", borderRadius:10, padding:"10px 16px", display:"flex", alignItems:"center", gap:10 }}>
              <span>🚨</span>
              <span style={{ fontSize:13, color:"#dc2626", fontWeight:600 }}>{vencidos.length} conta(s) vencida(s) — {fmt(vencidos.reduce((s,c)=>s+parseFloat(c.valor||0),0))}</span>
            </div>
          )}
          {vencendo7.length > 0 && (
            <div style={{ background:"#fffbeb", border:"1px solid #fde68a", borderRadius:10, padding:"10px 16px", display:"flex", alignItems:"center", gap:10 }}>
              <span>⏰</span>
              <span style={{ fontSize:13, color:"#d97706", fontWeight:600 }}>{vencendo7.length} conta(s) vencendo em 7 dias</span>
            </div>
          )}
          {agEnvio.length > 5 && (
            <div style={{ background:"#eff6ff", border:"1px solid #bfdbfe", borderRadius:10, padding:"10px 16px", display:"flex", alignItems:"center", gap:10 }}>
              <span>📦</span>
              <span style={{ fontSize:13, color:"#2563eb", fontWeight:600 }}>{agEnvio.length} pedidos aguardando envio</span>
            </div>
          )}
        </div>
      )}

      {/* ── CARDS PRINCIPAIS ── */}
      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(180px,1fr))", gap:12 }}>
        {/* Hoje */}
        <div style={card()}>
          <div style={{ fontSize:11, ...txtMuted, fontWeight:600, textTransform:"uppercase", letterSpacing:0.8, marginBottom:6 }}>Hoje</div>
          <div style={{ fontSize:22, fontWeight:800, color:"#0891b2" }}>{fmt(faturamentoHoje)}</div>
          <div style={{ fontSize:12, ...txtMuted, marginTop:4 }}>{pedidosHoje.length} pedido(s)</div>
        </div>

        {/* Mês atual */}
        <div style={card()}>
          <div style={{ fontSize:11, ...txtMuted, fontWeight:600, textTransform:"uppercase", letterSpacing:0.8, marginBottom:6 }}>Este Mês</div>
          <div style={{ fontSize:22, fontWeight:800, ...txt }}>{fmt(faturamentoMes)}</div>
          <div style={{ fontSize:12, color:crescimento>=0?"#15803d":"#dc2626", marginTop:4, fontWeight:600 }}>
            {crescimento>=0?"▲":"▼"} {Math.abs(crescimento).toFixed(1)}% vs mês anterior
          </div>
          <SparkLine data={fatPorDia} color={crescimento>=0?"#15803d":"#dc2626"} />
        </div>

        {/* Previsão */}
        <div style={card()}>
          <div style={{ fontSize:11, ...txtMuted, fontWeight:600, textTransform:"uppercase", letterSpacing:0.8, marginBottom:6 }}>Previsão do Mês</div>
          <div style={{ fontSize:22, fontWeight:800, color:"#7c3aed" }}>{fmt(previsaoMes)}</div>
          <div style={{ fontSize:12, ...txtMuted, marginTop:4 }}>baseado no ritmo atual</div>
        </div>

        {/* Ticket médio */}
        <div style={card()}>
          <div style={{ fontSize:11, ...txtMuted, fontWeight:600, textTransform:"uppercase", letterSpacing:0.8, marginBottom:6 }}>Ticket Médio</div>
          <div style={{ fontSize:22, fontWeight:800, ...txt }}>{fmt(ticketMedio)}</div>
          <div style={{ fontSize:12, ...txtMuted, marginTop:4 }}>{pedidosMes.length} pedidos no mês</div>
        </div>

        {/* Taxa cancelamento */}
        <div style={card()}>
          <div style={{ fontSize:11, ...txtMuted, fontWeight:600, textTransform:"uppercase", letterSpacing:0.8, marginBottom:6 }}>Cancelamentos</div>
          <div style={{ fontSize:22, fontWeight:800, color:taxaCancel>5?"#dc2626":taxaCancel>2?"#d97706":"#15803d" }}>{taxaCancel.toFixed(1)}%</div>
          <div style={{ fontSize:12, ...txtMuted, marginTop:4 }}>{canceladosMes} de {totalMes} pedidos</div>
        </div>

        {/* Score médio */}
        <div style={card()}>
          <div style={{ fontSize:11, ...txtMuted, fontWeight:600, textTransform:"uppercase", letterSpacing:0.8, marginBottom:6 }}>Score Médio</div>
          <div style={{ fontSize:22, fontWeight:800, color:scoreColor(Math.round(enriched.reduce((s,l)=>s+l.score,0)/(enriched.length||1))) }}>
            {Math.round(enriched.reduce((s,l)=>s+l.score,0)/(enriched.length||1))}/100
          </div>
          <div style={{ fontSize:12, ...txtMuted, marginTop:4 }}>{enriched.length} anúncios</div>
        </div>
      </div>

      {/* ── META MENSAL ── */}
      {(metaMensal > 0 || editMeta) && (
        <div style={{ ...card(), padding:"20px 24px" }}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12 }}>
            <div style={{ fontWeight:700, fontSize:15, ...txt }}>🎯 Meta do Mês</div>
            <button onClick={() => setEditMeta(e=>!e)}
              style={{ background:"#f1f5f9", border:"none", color:"#64748b", padding:"5px 12px", borderRadius:8, cursor:"pointer", fontSize:12 }}>
              {editMeta ? "Fechar" : "Editar"}
            </button>
          </div>
          {editMeta && (
            <div style={{ display:"flex", gap:8, marginBottom:16 }}>
              <input type="number" value={metaInput} onChange={e=>setMetaInput(e.target.value)} placeholder="Ex: 50000"
                style={{ flex:1, background:"#f8fafc", border:"1px solid #e2e8f0", color:"#0f172a", padding:"8px 12px", borderRadius:8, fontSize:13, outline:"none" }} />
              <button onClick={() => { const v = parseFloat(metaInput)||0; setMetaMensal(v); localStorage.setItem("metaMensal", v); setEditMeta(false); }}
                style={{ background:"#0f172a", border:"none", color:"#fff", fontWeight:700, padding:"8px 20px", borderRadius:8, cursor:"pointer", fontSize:13 }}>Salvar</button>
            </div>
          )}
          {metaMensal > 0 && (
            <>
              <div style={{ display:"flex", justifyContent:"space-between", marginBottom:8 }}>
                <span style={{ fontSize:13, ...txtMuted }}>{fmt(faturamentoMes)} de {fmt(metaMensal)}</span>
                <span style={{ fontSize:13, fontWeight:700, color:progressoMeta>=100?"#15803d":progressoMeta>=70?"#d97706":"#dc2626" }}>{progressoMeta.toFixed(1)}%</span>
              </div>
              <div style={{ height:12, background:darkMode?"#334155":"#e2e8f0", borderRadius:99, overflow:"hidden" }}>
                <div style={{ width:`${progressoMeta}%`, height:"100%", background:progressoMeta>=100?"#15803d":progressoMeta>=70?"#d97706":"#dc2626", borderRadius:99, transition:"width .5s" }} />
              </div>
              {progressoMeta < 100 && (
                <div style={{ fontSize:12, ...txtMuted, marginTop:8 }}>
                  Faltam {fmt(metaMensal-faturamentoMes)} para atingir a meta • {diasNoMes-diaDoMes} dias restantes
                </div>
              )}
              {progressoMeta >= 100 && <div style={{ fontSize:13, color:"#15803d", fontWeight:700, marginTop:8 }}>🎉 Meta atingida!</div>}
            </>
          )}
        </div>
      )}
      {metaMensal === 0 && !editMeta && (
        <button onClick={() => setEditMeta(true)}
          style={{ background:"transparent", border:`2px dashed ${darkMode?"#334155":"#e2e8f0"}`, color:darkMode?"#64748b":"#94a3b8", padding:"14px", borderRadius:12, cursor:"pointer", fontSize:13, width:"100%", fontFamily:"inherit" }}>
          + Definir Meta Mensal de Faturamento
        </button>
      )}

      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:16 }}>
        {/* ── DISTRIBUIÇÃO DE STATUS ── */}
        <div style={{ ...card(), padding:"20px 24px" }}>
          <div style={{ fontWeight:700, fontSize:14, ...txt, marginBottom:16 }}>Status dos Pedidos (mês)</div>
          <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
            {[
              { label:"Ag. Envio", value:statusCount.agEnvio, color:"#d97706", total:totalMes },
              { label:"Enviados",  value:statusCount.enviado,  color:"#0891b2", total:totalMes },
              { label:"Entregues", value:statusCount.entregue, color:"#15803d", total:totalMes },
              { label:"Cancelados",value:statusCount.cancelado,color:"#dc2626", total:totalMes },
            ].map(s => (
              <div key={s.label}>
                <div style={{ display:"flex", justifyContent:"space-between", marginBottom:4 }}>
                  <span style={{ fontSize:12, ...txtMuted }}>{s.label}</span>
                  <span style={{ fontSize:12, fontWeight:700, color:s.color }}>{s.value}</span>
                </div>
                <MiniBar value={s.value} max={s.total} color={s.color} />
              </div>
            ))}
          </div>
        </div>

        {/* ── FATURAMENTO 14 DIAS ── */}
        <div style={{ ...card(), padding:"20px 24px" }}>
          <div style={{ fontWeight:700, fontSize:14, ...txt, marginBottom:16 }}>Faturamento — Últimos 14 dias</div>
          <div style={{ display:"flex", gap:3, alignItems:"flex-end", height:80 }}>
            {fatPorDia.map((v,i) => {
              const max = Math.max(...fatPorDia, 1);
              const isHoje = i === 13;
              return (
                <div key={i} style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", gap:2 }}>
                  <div style={{ width:"100%", background:isHoje?"#0f172a":darkMode?"#334155":"#e2e8f0", borderRadius:"3px 3px 0 0", height:`${Math.max(4,(v/max)*70)}px`, transition:"height .3s", cursor:"pointer", position:"relative" }}
                    title={`${ultimos14[i]}: ${fmt(v)}`}>
                    {v > 0 && <div style={{ position:"absolute", bottom:"100%", left:"50%", transform:"translateX(-50%)", background:"#0f172a", color:"#fff", fontSize:9, padding:"2px 4px", borderRadius:3, whiteSpace:"nowrap", display:"none" }}>{fmt(v)}</div>}
                  </div>
                </div>
              );
            })}
          </div>
          <div style={{ display:"flex", justifyContent:"space-between", marginTop:6 }}>
            <span style={{ fontSize:10, ...txtMuted }}>{ultimos14[0]?.slice(5)}</span>
            <span style={{ fontSize:10, ...txtMuted }}>hoje</span>
          </div>
        </div>
      </div>

      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:16 }}>
        {/* ── RANKING MAIS VENDIDOS ── */}
        <div style={{ ...card(), padding:"20px 24px" }}>
          <div style={{ fontWeight:700, fontSize:14, ...txt, marginBottom:16 }}>🏆 Mais Vendidos (mês)</div>
          {rankingVendas.length === 0 ? (
            <div style={{ fontSize:13, ...txtMuted, textAlign:"center", padding:"20px 0" }}>Sem dados do mês atual</div>
          ) : rankingVendas.map((p,i) => (
            <div key={p.id} style={{ display:"flex", alignItems:"center", gap:12, marginBottom:12, paddingBottom:12, borderBottom:i<rankingVendas.length-1?`1px solid ${darkMode?"#334155":"#f1f5f9"}`:"none" }}>
              <div style={{ width:28, height:28, borderRadius:8, background:i===0?"#fde68a":i===1?"#e2e8f0":i===2?"#fed7aa":"#f8fafc", display:"flex", alignItems:"center", justifyContent:"center", fontWeight:800, fontSize:13, color:"#0f172a", flexShrink:0 }}>
                {i+1}
              </div>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontSize:12, fontWeight:600, ...txt, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{p.title||p.id}</div>
                <div style={{ display:"flex", gap:10, marginTop:3 }}>
                  <span style={{ fontSize:11, color:"#0891b2", fontWeight:600 }}>{p.qty} vendas</span>
                  <span style={{ fontSize:11, ...txtMuted }}>{fmt(p.revenue)}</span>
                </div>
                <MiniBar value={p.qty} max={maxQty} color="#0891b2" />
              </div>
            </div>
          ))}
        </div>

        {/* ── RANKING MAIS LUCRATIVOS ── */}
        <div style={{ ...card(), padding:"20px 24px" }}>
          <div style={{ fontWeight:700, fontSize:14, ...txt, marginBottom:16 }}>💰 Mais Lucrativos (total)</div>
          {rankingLucro.length === 0 ? (
            <div style={{ fontSize:13, ...txtMuted, textAlign:"center", padding:"20px 0" }}>Insira custos nos anúncios para ver ranking</div>
          ) : rankingLucro.map((l,i) => (
            <div key={l.id} style={{ display:"flex", alignItems:"center", gap:12, marginBottom:12, paddingBottom:12, borderBottom:i<rankingLucro.length-1?`1px solid ${darkMode?"#334155":"#f1f5f9"}`:"none" }}>
              <div style={{ width:28, height:28, borderRadius:8, background:i===0?"#fde68a":i===1?"#e2e8f0":i===2?"#fed7aa":"#f8fafc", display:"flex", alignItems:"center", justifyContent:"center", fontWeight:800, fontSize:13, color:"#0f172a", flexShrink:0 }}>
                {i+1}
              </div>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontSize:12, fontWeight:600, ...txt, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{l.title}</div>
                <div style={{ display:"flex", gap:10, marginTop:3 }}>
                  <span style={{ fontSize:11, color:"#15803d", fontWeight:600 }}>{fmt(l.totalProfit)}</span>
                  <span style={{ fontSize:11, ...txtMuted }}>{l.sold_quantity} vendas</span>
                  {l.margin && <span style={{ fontSize:11, color:l.margin>=0.25?"#15803d":l.margin>=0.15?"#d97706":"#dc2626" }}>{fmtPct(l.margin)}</span>}
                </div>
                <MiniBar value={l.totalProfit} max={rankingLucro[0]?.totalProfit||1} color="#15803d" />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ── ANÚNCIOS COM PROBLEMA ── */}
      {enriched.filter(l=>l.score<50).length > 0 && (
        <div style={{ ...card(), padding:"20px 24px" }}>
          <div style={{ fontWeight:700, fontSize:14, ...txt, marginBottom:14 }}>⚠️ Anúncios com Score Baixo ({enriched.filter(l=>l.score<50).length})</div>
          <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(260px,1fr))", gap:10 }}>
            {enriched.filter(l=>l.score<50).slice(0,6).map(l => (
              <div key={l.id} style={{ background:darkMode?"#1e293b":"#fef2f2", border:"1px solid #fecaca", borderRadius:10, padding:"12px 14px" }}>
                <div style={{ fontSize:12, fontWeight:600, color:"#dc2626", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", marginBottom:4 }}>{l.title}</div>
                <div style={{ display:"flex", gap:8, alignItems:"center" }}>
                  <span style={{ fontSize:18, fontWeight:800, color:scoreColor(l.score) }}>{l.score}</span>
                  <div style={{ flex:1 }}>
                    {l.checks.filter(c=>!c.pass).slice(0,2).map(c => (
                      <div key={c.key} style={{ fontSize:10, color:"#b91c1c" }}>✗ {c.label}</div>
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  </div>
  );
}


// ════════════════════════════════════════════════════════════
//  NOTAS FISCAIS DE ENTRADA
// ════════════════════════════════════════════════════════════

function saveNFs(v) { try { localStorage.setItem("notas_fiscais_entrada", JSON.stringify(v)); } catch {} }

// ── Parser de XML de NF-e ────────────────────────────────────
function parseNFeXML(xmlText) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, "text/xml");
  const get = (selector) => doc.querySelector(selector)?.textContent?.trim() ?? "";

  const itens = [];
  doc.querySelectorAll("det").forEach(det => {
    const prod = det.querySelector("prod");
    const imposto = det.querySelector("imposto");
    itens.push({
      cProd: prod?.querySelector("cProd")?.textContent?.trim() ?? "",
      xProd: prod?.querySelector("xProd")?.textContent?.trim() ?? "",
      ncm: prod?.querySelector("NCM")?.textContent?.trim() ?? "",
      ean: prod?.querySelector("cEAN")?.textContent?.trim() ?? "",
      cfop: prod?.querySelector("CFOP")?.textContent?.trim() ?? "",
      uCom: prod?.querySelector("uCom")?.textContent?.trim() ?? "",
      qCom: parseFloat(prod?.querySelector("qCom")?.textContent ?? "0"),
      vUnCom: parseFloat(prod?.querySelector("vUnCom")?.textContent ?? "0"),
      vProd: parseFloat(prod?.querySelector("vProd")?.textContent ?? "0"),
      vDesc: parseFloat(prod?.querySelector("vDesc")?.textContent ?? "0"),
      pICMS: parseFloat(imposto?.querySelector("pICMS")?.textContent ?? "0"),
      vICMS: parseFloat(imposto?.querySelector("vICMS")?.textContent ?? "0"),
      vIPI: parseFloat(det.querySelector("IPI vIPI")?.textContent ?? "0"),
    });
  });

  // Cobranças/duplicatas (boletos)
  const dups = [];
  doc.querySelectorAll("dup").forEach(d => {
    dups.push({
      nDup: d.querySelector("nDup")?.textContent?.trim() ?? "",
      dVenc: d.querySelector("dVenc")?.textContent?.trim() ?? "",
      vDup: parseFloat(d.querySelector("vDup")?.textContent ?? "0"),
    });
  });

  return {
    chave: get("infNFe").replace(/[^0-9]/g,"").slice(0,44) || get("Id").replace(/[^0-9]/g,"").slice(0,44),
    numero: get("nNF"),
    serie: get("serie"),
    dataEmissao: get("dhEmi")?.slice(0,10) ?? get("dEmi"),
    natureza: get("natOp"),
    emitente: {
      cnpj: get("emit CNPJ"),
      nome: get("emit xNome"),
      uf: get("emit UF"),
    },
    destinatario: {
      cnpj: get("dest CNPJ"),
      nome: get("dest xNome"),
    },
    totais: {
      vProd: parseFloat(get("ICMSTot vProd") || "0"),
      vFrete: parseFloat(get("ICMSTot vFrete") || "0"),
      vDesc: parseFloat(get("ICMSTot vDesc") || "0"),
      vIPI: parseFloat(get("ICMSTot vIPI") || "0"),
      vICMS: parseFloat(get("ICMSTot vICMS") || "0"),
      vPIS: parseFloat(get("ICMSTot vPIS") || "0"),
      vCOFINS: parseFloat(get("ICMSTot vCOFINS") || "0"),
      vNF: parseFloat(get("ICMSTot vNF") || "0"),
    },
    itens,
    duplicatas: dups,
    infAdic: get("infCpl") || get("infAdFisco"),
  };
}

// ── Modal de lançamento de NF ────────────────────────────────
function ModalNF({ nf, fornecedores, produtos, categoriasPagar, onSave, onClose }) {
  const emptyNF = {
    id: Date.now().toString(),
    numero: "", serie: "1", chave: "", dataEmissao: new Date().toLocaleDateString("sv-SE"),
    natureza: "Compra de mercadoria", fornecedorId: "", fornecedorNome: "", fornecedorCNPJ: "",
    totais: { vProd:0, vFrete:0, vDesc:0, vIPI:0, vICMS:0, vPIS:0, vCOFINS:0, vNF:0 },
    itens: [], duplicatas: [],
    gerarContaPagar: true,
    atualizarEstoque: true,
    contaPagarConfig: { categoria:"Fornecedor", multaPct:"2", multaTipo:"%", jurosDia:"0.033", jurosTipo:"%", temProtesto:false, diasProtesto:"", cartorio:"" },
    status: "Lançada", obs: "",
  };

  const [form, setForm] = useState(nf || emptyNF);
  const [subTab, setSubTab] = useState("geral");
  const [xmlError, setXmlError] = useState("");
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const setTot = (k, v) => setForm(f => ({ ...f, totais: { ...f.totais, [k]: v } }));
  const setCPConfig = (k, v) => setForm(f => ({ ...f, contaPagarConfig: { ...f.contaPagarConfig, [k]: v } }));

  function handleXML(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const parsed = parseNFeXML(e.target.result);
        const forn = fornecedores.find(f => f.cnpj?.replace(/\D/g,"") === parsed.emitente.cnpj?.replace(/\D/g,""));
        setForm(prev => ({
          ...prev,
          numero: parsed.numero,
          serie: parsed.serie,
          chave: parsed.chave,
          dataEmissao: parsed.dataEmissao?.slice(0,10),
          natureza: parsed.natureza,
          fornecedorId: forn?.id || "",
          fornecedorNome: parsed.emitente.nome,
          fornecedorCNPJ: parsed.emitente.cnpj,
          totais: parsed.totais,
          itens: parsed.itens.map(it => ({
            ...it,
            produtoCadastradoId: produtos.find(p =>
              (p.ean && p.ean === it.ean && it.ean !== "SEM GTIN") ||
              (p.sku && p.sku === it.cProd)
            )?.id || "",
          })),
          duplicatas: parsed.duplicatas,
          infAdic: parsed.infAdic,
        }));
        setXmlError("");
      } catch(e) { setXmlError("Erro ao ler XML: " + e.message); }
    };
    reader.readAsText(file, "UTF-8");
  }

  function addItem() {
    set("itens", [...form.itens, { cProd:"", xProd:"", ncm:"", ean:"", cfop:"1102", uCom:"UN", qCom:1, vUnCom:0, vProd:0, produtoCadastradoId:"" }]);
  }

  function updateItem(idx, field, val) {
    const updated = form.itens.map((it,i) => {
      if (i !== idx) return it;
      const up = { ...it, [field]: val };
      if (field === "qCom" || field === "vUnCom") up.vProd = parseFloat(up.qCom||0) * parseFloat(up.vUnCom||0);
      return up;
    });
    set("itens", updated);
  }

  function addDup() { set("duplicatas", [...form.duplicatas, { nDup:"", dVenc:"", vDup:0 }]); }
  function updateDup(idx, field, val) {
    set("duplicatas", form.duplicatas.map((d,i) => i===idx ? {...d,[field]:val} : d));
  }
  function removeDup(idx) { set("duplicatas", form.duplicatas.filter((_,i)=>i!==idx)); }

  const inp = { background:"#f8fafc", border:"1px solid #e2e8f0", color:"#0f172a", padding:"8px 10px", borderRadius:8, fontSize:13, outline:"none", fontFamily:"inherit", width:"100%" };

  const SUBTABS = [
    { key:"geral", label:"📋 Geral" },
    { key:"itens", label:`📦 Itens (${form.itens.length})` },
    { key:"financeiro", label:`💰 Financeiro (${form.duplicatas.length})` },
    { key:"config", label:"⚙️ Opções" },
  ];

  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(15,23,42,.65)", backdropFilter:"blur(4px)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:600, padding:16 }}>
      <div style={{ background:"#fff", borderRadius:16, width:"100%", maxWidth:820, maxHeight:"94vh", display:"flex", flexDirection:"column", boxShadow:"0 20px 60px rgba(0,0,0,.2)" }}>
        {/* Header */}
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"18px 28px", borderBottom:"1px solid #f1f5f9" }}>
          <div>
            <div style={{ fontWeight:800, fontSize:17, color:"#0f172a" }}>{nf ? "Editar Nota Fiscal" : "Nova Nota Fiscal de Entrada"}</div>
            <div style={{ fontSize:12, color:"#94a3b8", marginTop:2 }}>NF {form.numero || "s/n"} — {form.fornecedorNome || "Fornecedor não selecionado"}</div>
          </div>
          <div style={{ display:"flex", gap:8, alignItems:"center" }}>
            {!nf && (
              <label style={{ background:"#ffe000", border:"none", color:"#0f172a", fontWeight:700, padding:"8px 16px", borderRadius:8, cursor:"pointer", fontSize:13 }}>
                📎 Importar XML
                <input type="file" accept=".xml" style={{ display:"none" }} onChange={e => e.target.files[0] && handleXML(e.target.files[0])} />
              </label>
            )}
            <button onClick={onClose} style={{ background:"#f1f5f9", border:"none", color:"#64748b", width:32, height:32, borderRadius:8, cursor:"pointer", fontSize:16 }}>✕</button>
          </div>
        </div>

        {xmlError && <div style={{ background:"#fef2f2", color:"#dc2626", fontSize:12, padding:"8px 28px", borderBottom:"1px solid #fecaca" }}>⚠ {xmlError}</div>}

        {/* Sub-tabs */}
        <div style={{ display:"flex", gap:0, padding:"0 28px", background:"#fafafa", borderBottom:"1px solid #f1f5f9" }}>
          {SUBTABS.map(t => (
            <button key={t.key} onClick={() => setSubTab(t.key)}
              style={{ background:"transparent", border:"none", borderBottom:subTab===t.key?"2px solid #0f172a":"2px solid transparent", color:subTab===t.key?"#0f172a":"#94a3b8", padding:"10px 16px", cursor:"pointer", fontFamily:"inherit", fontSize:12, fontWeight:subTab===t.key?700:500 }}>
              {t.label}
            </button>
          ))}
        </div>

        {/* Content */}
        <div style={{ flex:1, overflowY:"auto", padding:"20px 28px" }}>

          {/* ── GERAL ── */}
          {subTab === "geral" && (
            <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:10 }}>
                <div><div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Número NF *</div>
                  <input style={inp} value={form.numero} onChange={e=>set("numero",e.target.value)} placeholder="Ex: 000001" /></div>
                <div><div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Série</div>
                  <input style={inp} value={form.serie} onChange={e=>set("serie",e.target.value)} placeholder="1" /></div>
                <div><div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Data Emissão</div>
                  <input type="date" style={inp} value={form.dataEmissao} onChange={e=>set("dataEmissao",e.target.value)} /></div>
              </div>
              <div><div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Chave de Acesso (44 dígitos)</div>
                <input style={inp} value={form.chave} onChange={e=>set("chave",e.target.value)} placeholder="0000 0000 0000 0000 0000 0000 0000 0000 0000 0000 000" maxLength={44} /></div>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
                <div><div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Fornecedor</div>
                  <select style={{ ...inp }} value={form.fornecedorId} onChange={e => {
                    const f = fornecedores.find(f=>f.id===e.target.value);
                    set("fornecedorId", e.target.value);
                    if (f) { set("fornecedorNome", f.nome); set("fornecedorCNPJ", f.cnpj||""); }
                  }}>
                    <option value="">— Selecione ou digite abaixo —</option>
                    {fornecedores.map(f=><option key={f.id} value={f.id}>{f.nome}</option>)}
                  </select>
                </div>
                <div><div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Nome do Emitente</div>
                  <input style={inp} value={form.fornecedorNome} onChange={e=>set("fornecedorNome",e.target.value)} placeholder="Razão social do fornecedor" /></div>
              </div>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
                <div><div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>CNPJ Emitente</div>
                  <input style={inp} value={form.fornecedorCNPJ} onChange={e=>set("fornecedorCNPJ",e.target.value)} placeholder="00.000.000/0000-00" /></div>
                <div><div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Natureza da Operação</div>
                  <input style={inp} value={form.natureza} onChange={e=>set("natureza",e.target.value)} placeholder="Compra de mercadoria" /></div>
              </div>
              {/* Totais */}
              <div style={{ background:"#f8fafc", borderRadius:10, padding:"14px 16px" }}>
                <div style={{ fontWeight:700, fontSize:13, color:"#0f172a", marginBottom:12 }}>Totais da Nota</div>
                <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:10 }}>
                  {[
                    { k:"vProd", label:"Produtos (R$)" },
                    { k:"vFrete", label:"Frete (R$)" },
                    { k:"vDesc", label:"Desconto (R$)" },
                    { k:"vIPI", label:"IPI (R$)" },
                    { k:"vICMS", label:"ICMS (R$)" },
                    { k:"vPIS", label:"PIS (R$)" },
                    { k:"vCOFINS", label:"COFINS (R$)" },
                    { k:"vNF", label:"Total NF (R$) *" },
                  ].map(f => (
                    <div key={f.k}>
                      <div style={{ fontSize:10, color:"#94a3b8", marginBottom:4, fontWeight:600, textTransform:"uppercase" }}>{f.label}</div>
                      <input type="number" style={{ ...inp, padding:"6px 8px", fontSize:12 }} value={form.totais[f.k]||""} onChange={e=>setTot(f.k,parseFloat(e.target.value)||0)} placeholder="0,00" />
                    </div>
                  ))}
                </div>
              </div>
              <div><div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Observações</div>
                <textarea style={{ ...inp, resize:"vertical" }} rows={2} value={form.obs||""} onChange={e=>set("obs",e.target.value)} placeholder="Informações adicionais..." /></div>
            </div>
          )}

          {/* ── ITENS ── */}
          {subTab === "itens" && (
            <div>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:14 }}>
                <div style={{ fontSize:13, color:"#64748b" }}>{form.itens.length} item(ns) na nota</div>
                <button onClick={addItem} style={{ background:"#0f172a", border:"none", color:"#fff", fontWeight:700, padding:"7px 16px", borderRadius:8, cursor:"pointer", fontSize:12 }}>+ Adicionar Item</button>
              </div>
              {form.itens.length === 0 ? (
                <div style={{ background:"#f8fafc", border:"2px dashed #e2e8f0", borderRadius:12, padding:32, textAlign:"center", color:"#94a3b8" }}>
                  <div style={{ fontSize:28, marginBottom:8 }}>📦</div>
                  <div style={{ fontSize:13 }}>Importe um XML ou adicione itens manualmente</div>
                </div>
              ) : form.itens.map((it, idx) => (
                <div key={idx} style={{ background:"#f8fafc", border:"1px solid #e2e8f0", borderRadius:10, padding:"12px 14px", marginBottom:8 }}>
                  <div style={{ display:"flex", gap:8, flexWrap:"wrap", alignItems:"flex-end" }}>
                    <div style={{ flex:3, minWidth:200 }}>
                      <div style={{ fontSize:10, color:"#94a3b8", marginBottom:4, fontWeight:600 }}>DESCRIÇÃO *</div>
                      <input style={{ ...inp, fontSize:12 }} value={it.xProd} onChange={e=>updateItem(idx,"xProd",e.target.value)} placeholder="Descrição do produto" />
                    </div>
                    <div style={{ flex:1, minWidth:90 }}>
                      <div style={{ fontSize:10, color:"#94a3b8", marginBottom:4, fontWeight:600 }}>CÓD. PROD.</div>
                      <input style={{ ...inp, fontSize:12 }} value={it.cProd} onChange={e=>updateItem(idx,"cProd",e.target.value)} placeholder="SKU/Ref" />
                    </div>
                    <div style={{ flex:1, minWidth:100 }}>
                      <div style={{ fontSize:10, color:"#94a3b8", marginBottom:4, fontWeight:600 }}>EAN/GTIN</div>
                      <input style={{ ...inp, fontSize:12 }} value={it.ean} onChange={e=>updateItem(idx,"ean",e.target.value)} placeholder="7891234..." />
                    </div>
                    <div style={{ flex:1, minWidth:70 }}>
                      <div style={{ fontSize:10, color:"#94a3b8", marginBottom:4, fontWeight:600 }}>QTD</div>
                      <input type="number" style={{ ...inp, fontSize:12 }} value={it.qCom} onChange={e=>updateItem(idx,"qCom",e.target.value)} />
                    </div>
                    <div style={{ flex:1, minWidth:90 }}>
                      <div style={{ fontSize:10, color:"#94a3b8", marginBottom:4, fontWeight:600 }}>VL. UNIT.</div>
                      <input type="number" style={{ ...inp, fontSize:12 }} value={it.vUnCom} onChange={e=>updateItem(idx,"vUnCom",e.target.value)} />
                    </div>
                    <div style={{ flex:1, minWidth:90 }}>
                      <div style={{ fontSize:10, color:"#94a3b8", marginBottom:4, fontWeight:600 }}>TOTAL</div>
                      <input type="number" style={{ ...inp, fontSize:12 }} value={it.vProd} onChange={e=>updateItem(idx,"vProd",e.target.value)} />
                    </div>
                  </div>
                  <div style={{ display:"flex", gap:8, marginTop:8, alignItems:"center", flexWrap:"wrap" }}>
                    <div style={{ flex:2, minWidth:160 }}>
                      <div style={{ fontSize:10, color:"#94a3b8", marginBottom:4, fontWeight:600 }}>VINCULAR AO PRODUTO CADASTRADO</div>
                      <select style={{ ...inp, fontSize:12 }} value={it.produtoCadastradoId||""} onChange={e=>updateItem(idx,"produtoCadastradoId",e.target.value)}>
                        <option value="">— Selecione para atualizar estoque —</option>
                        {produtos.map(p=><option key={p.id} value={p.id}>{p.titulo?.slice(0,50)} {p.sku?`(${p.sku})`:""}</option>)}
                      </select>
                    </div>
                    <div style={{ flex:1, minWidth:80 }}>
                      <div style={{ fontSize:10, color:"#94a3b8", marginBottom:4, fontWeight:600 }}>NCM</div>
                      <input style={{ ...inp, fontSize:12 }} value={it.ncm||""} onChange={e=>updateItem(idx,"ncm",e.target.value)} placeholder="0000.00.00" />
                    </div>
                    <div style={{ flex:1, minWidth:70 }}>
                      <div style={{ fontSize:10, color:"#94a3b8", marginBottom:4, fontWeight:600 }}>CFOP</div>
                      <input style={{ ...inp, fontSize:12 }} value={it.cfop||""} onChange={e=>updateItem(idx,"cfop",e.target.value)} />
                    </div>
                    {it.produtoCadastradoId && (
                      <div style={{ fontSize:11, color:"#15803d", background:"#f0fdf4", padding:"4px 10px", borderRadius:6, border:"1px solid #bbf7d0", marginTop:16 }}>
                        ✓ Estoque será atualizado: +{it.qCom} un
                      </div>
                    )}
                    <button onClick={()=>set("itens",form.itens.filter((_,i)=>i!==idx))}
                      style={{ background:"#fef2f2", border:"none", color:"#dc2626", width:28, height:28, borderRadius:6, cursor:"pointer", fontSize:12, marginTop:16, flexShrink:0 }}>🗑</button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* ── FINANCEIRO ── */}
          {subTab === "financeiro" && (
            <div>
              <div style={{ background:"#f0fdf4", border:"1px solid #bbf7d0", borderRadius:10, padding:"12px 16px", marginBottom:16, fontSize:13, color:"#15803d" }}>
                💡 Cada duplicata (parcela) será lançada como uma conta a pagar no Financeiro.
              </div>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:14 }}>
                <div style={{ fontWeight:700, fontSize:14, color:"#0f172a" }}>{form.duplicatas.length} duplicata(s) / parcela(s)</div>
                <button onClick={addDup} style={{ background:"#0f172a", border:"none", color:"#fff", fontWeight:700, padding:"7px 16px", borderRadius:8, cursor:"pointer", fontSize:12 }}>+ Adicionar Parcela</button>
              </div>
              {form.duplicatas.length === 0 ? (
                <div style={{ background:"#f8fafc", border:"2px dashed #e2e8f0", borderRadius:12, padding:24, textAlign:"center", color:"#94a3b8", fontSize:13 }}>
                  Nenhuma duplicata. Adicione parcelas ou importe o XML que traz automaticamente.
                </div>
              ) : form.duplicatas.map((d, idx) => (
                <div key={idx} style={{ display:"flex", gap:8, alignItems:"center", marginBottom:8, background:"#f8fafc", padding:"10px 12px", borderRadius:8, border:"1px solid #e2e8f0" }}>
                  <div style={{ flex:1 }}>
                    <div style={{ fontSize:10, color:"#94a3b8", marginBottom:3, fontWeight:600 }}>Nº DUPLICATA</div>
                    <input style={{ ...inp, padding:"6px 8px", fontSize:12 }} value={d.nDup} onChange={e=>updateDup(idx,"nDup",e.target.value)} placeholder="001" />
                  </div>
                  <div style={{ flex:2 }}>
                    <div style={{ fontSize:10, color:"#94a3b8", marginBottom:3, fontWeight:600 }}>VENCIMENTO</div>
                    <input type="date" style={{ ...inp, padding:"6px 8px", fontSize:12 }} value={d.dVenc} onChange={e=>updateDup(idx,"dVenc",e.target.value)} />
                  </div>
                  <div style={{ flex:1 }}>
                    <div style={{ fontSize:10, color:"#94a3b8", marginBottom:3, fontWeight:600 }}>VALOR (R$)</div>
                    <input type="number" style={{ ...inp, padding:"6px 8px", fontSize:12 }} value={d.vDup} onChange={e=>updateDup(idx,"vDup",e.target.value)} />
                  </div>
                  <button onClick={()=>removeDup(idx)} style={{ background:"#fef2f2", border:"none", color:"#dc2626", width:28, height:28, borderRadius:6, cursor:"pointer", fontSize:12, marginTop:16, flexShrink:0 }}>🗑</button>
                </div>
              ))}
              <div style={{ display:"flex", justifyContent:"flex-end", marginTop:8, paddingTop:8, borderTop:"1px solid #f1f5f9" }}>
                <div style={{ fontSize:13, fontWeight:700, color:"#0f172a" }}>
                  Total duplicatas: R$ {form.duplicatas.reduce((s,d)=>s+parseFloat(d.vDup||0),0).toFixed(2).replace(".",",")}
                </div>
              </div>
            </div>
          )}

          {/* ── OPÇÕES ── */}
          {subTab === "config" && (
            <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
              {/* Opções gerais */}
              <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
                <label style={{ display:"flex", alignItems:"center", gap:10, cursor:"pointer", padding:"12px 16px", background:"#f0fdf4", border:"1px solid #bbf7d0", borderRadius:10 }}>
                  <input type="checkbox" checked={form.atualizarEstoque} onChange={e=>set("atualizarEstoque",e.target.checked)} style={{ width:16, height:16 }} />
                  <div>
                    <div style={{ fontWeight:700, fontSize:13, color:"#15803d" }}>📦 Atualizar estoque dos produtos</div>
                    <div style={{ fontSize:12, color:"#64748b" }}>Soma a quantidade de cada item vinculado ao seu produto cadastrado</div>
                  </div>
                </label>
                <label style={{ display:"flex", alignItems:"center", gap:10, cursor:"pointer", padding:"12px 16px", background:"#eff6ff", border:"1px solid #bfdbfe", borderRadius:10 }}>
                  <input type="checkbox" checked={form.gerarContaPagar} onChange={e=>set("gerarContaPagar",e.target.checked)} style={{ width:16, height:16 }} />
                  <div>
                    <div style={{ fontWeight:700, fontSize:13, color:"#1d4ed8" }}>💰 Gerar contas a pagar no Financeiro</div>
                    <div style={{ fontSize:12, color:"#64748b" }}>Cria uma conta a pagar para cada duplicata da nota</div>
                  </div>
                </label>
              </div>

              {/* Config das contas a pagar */}
              {form.gerarContaPagar && (
                <div style={{ background:"#f8fafc", border:"1px solid #e2e8f0", borderRadius:12, padding:"16px 18px" }}>
                  <div style={{ fontWeight:700, fontSize:13, color:"#0f172a", marginBottom:14 }}>Configuração das Contas a Pagar</div>
                  <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12 }}>
                    <div>
                      <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Categoria</div>
                      <select style={inp} value={form.contaPagarConfig.categoria} onChange={e=>setCPConfig("categoria",e.target.value)}>
                        {(categoriasPagar||["Fornecedor","Outros"]).map(c=><option key={c}>{c}</option>)}
                      </select>
                    </div>
                    <div>
                      <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Multa por atraso</div>
                      <div style={{ display:"flex", gap:4 }}>
                        <input type="number" style={{ ...inp, flex:1 }} value={form.contaPagarConfig.multaPct} onChange={e=>setCPConfig("multaPct",e.target.value)} placeholder="2" />
                        {["%","R$"].map(t=>(
                          <button key={t} onClick={()=>setCPConfig("multaTipo",t)}
                            style={{ padding:"0 10px", borderRadius:6, border:"none", cursor:"pointer", fontSize:12, fontWeight:700, background:form.contaPagarConfig.multaTipo===t?"#0f172a":"#e2e8f0", color:form.contaPagarConfig.multaTipo===t?"#fff":"#64748b" }}>{t}</button>
                        ))}
                      </div>
                    </div>
                    <div>
                      <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Juros ao dia</div>
                      <div style={{ display:"flex", gap:4 }}>
                        <input type="number" style={{ ...inp, flex:1 }} value={form.contaPagarConfig.jurosDia} onChange={e=>setCPConfig("jurosDia",e.target.value)} placeholder="0.033" />
                        {["%","R$"].map(t=>(
                          <button key={t} onClick={()=>setCPConfig("jurosTipo",t)}
                            style={{ padding:"0 10px", borderRadius:6, border:"none", cursor:"pointer", fontSize:12, fontWeight:700, background:form.contaPagarConfig.jurosTipo===t?"#0f172a":"#e2e8f0", color:form.contaPagarConfig.jurosTipo===t?"#fff":"#64748b" }}>{t}</button>
                        ))}
                      </div>
                    </div>
                    <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
                      <label style={{ display:"flex", alignItems:"center", gap:8, cursor:"pointer" }}>
                        <input type="checkbox" checked={form.contaPagarConfig.temProtesto||false} onChange={e=>setCPConfig("temProtesto",e.target.checked)} />
                        <span style={{ fontSize:13, color:"#334155" }}>⚖️ Será protestada por atraso</span>
                      </label>
                      {form.contaPagarConfig.temProtesto && (
                        <div style={{ display:"flex", gap:8 }}>
                          <div style={{ flex:1 }}>
                            <div style={{ fontSize:10, color:"#94a3b8", marginBottom:3, fontWeight:600 }}>DIAS P/ PROTESTO</div>
                            <input type="number" style={{ ...inp, padding:"6px 8px", fontSize:12 }} value={form.contaPagarConfig.diasProtesto} onChange={e=>setCPConfig("diasProtesto",e.target.value)} placeholder="5" />
                          </div>
                          <div style={{ flex:2 }}>
                            <div style={{ fontSize:10, color:"#94a3b8", marginBottom:3, fontWeight:600 }}>CARTÓRIO</div>
                            <input style={{ ...inp, padding:"6px 8px", fontSize:12 }} value={form.contaPagarConfig.cartorio||""} onChange={e=>setCPConfig("cartorio",e.target.value)} placeholder="1º Cartório..." />
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{ display:"flex", gap:8, padding:"14px 28px", borderTop:"1px solid #f1f5f9", background:"#fafafa" }}>
          <button onClick={onClose} style={{ flex:1, background:"#f8fafc", border:"1px solid #e2e8f0", color:"#64748b", fontWeight:600, padding:"11px", borderRadius:10, cursor:"pointer" }}>Cancelar</button>
          <button onClick={() => { if (!form.numero) { alert("Informe o número da NF"); return; } onSave(form); onClose(); }}
            style={{ flex:3, background:"#0f172a", border:"none", color:"#fff", fontWeight:700, padding:"11px", borderRadius:10, cursor:"pointer", fontSize:14 }}>
            ✓ Lançar Nota Fiscal
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Menu de 3 pontinhos para NF ─────────────────────────────
function MenuAcoes({ nf, produtos, setProdutos, contasPagar, setContasPagar, categoriasPagar }) {
  const [aberto, setAberto] = useState(false);
  const [modalEstoque, setModalEstoque] = useState(false);
  const [modalContas, setModalContas] = useState(false);

  // Itens que têm produto vinculado
  const itensComProduto = (nf.itens || []).filter(it => it.produtoCadastradoId);
  // Duplicatas ainda não lançadas como conta a pagar
  const dupsJaLancadas = new Set(contasPagar.filter(c => c.nfId === nf.id).map(c => c.id));
  const dupsDisponiveis = nf.duplicatas || [];

  function lancarEstoque() {
    if (itensComProduto.length === 0) { alert("Nenhum item desta NF está vinculado a um produto cadastrado."); return; }
    const novoProdutos = produtos.map(p => {
      const item = itensComProduto.find(it => it.produtoCadastradoId === p.id);
      if (!item) return p;
      return { ...p, estoqueAtual: String(parseFloat(p.estoqueAtual || 0) + parseFloat(item.qCom || 0)) };
    });
    setProdutos(novoProdutos);
    try { localStorage.setItem("produtos_cadastro", JSON.stringify(novoProdutos)); } catch {}
    alert(`✅ Estoque atualizado para ${itensComProduto.length} produto(s)!`);
    setAberto(false);
  }

  function lancarContasPagar(cfg) {
    const novas = dupsDisponiveis.map((d, i) => ({
      id: Date.now() + i,
      descricao: `NF ${nf.numero}/${nf.serie} — ${nf.fornecedorNome} — Dup. ${d.nDup || String(i+1).padStart(3,"0")}`,
      categoria: cfg.categoria || "Fornecedor",
      valor: String(d.vDup),
      vencimento: d.dVenc,
      status: "Pendente",
      observacao: `Nota Fiscal ${nf.numero} — Chave: ${(nf.chave||"").slice(0,20)}...`,
      multaPct: cfg.multaPct, multaTipo: cfg.multaTipo || "%",
      jurosDia: cfg.jurosDia, jurosTipo: cfg.jurosTipo || "%",
      temProtesto: cfg.temProtesto, diasProtesto: cfg.diasProtesto, cartorio: cfg.cartorio,
      nfId: nf.id,
    }));
    const updated = [...contasPagar, ...novas];
    setContasPagar(updated);
    try { localStorage.setItem("contas_pagar", JSON.stringify(updated)); } catch {}
    alert(`✅ ${novas.length} conta(s) a pagar lançada(s) no Financeiro!`);
    setAberto(false); setModalContas(false);
  }

  return (
    <div style={{ position:"relative" }}>
      <button onClick={() => setAberto(a => !a)}
        style={{ background:"#f8fafc", border:"1px solid #e2e8f0", color:"#64748b", width:28, height:28, borderRadius:6, cursor:"pointer", fontSize:14, display:"flex", alignItems:"center", justifyContent:"center", fontWeight:700 }}>
        ⋯
      </button>

      {aberto && (
        <>
          <div onClick={() => setAberto(false)} style={{ position:"fixed", inset:0, zIndex:299 }} />
          <div style={{ position:"absolute", right:0, top:32, background:"#fff", border:"1px solid #e2e8f0", borderRadius:12, boxShadow:"0 8px 24px rgba(0,0,0,.12)", zIndex:300, minWidth:220, overflow:"hidden" }}>
            {/* Lançar Estoque */}
            <button onClick={() => { setAberto(false); setModalEstoque(true); }}
              style={{ width:"100%", background:"none", border:"none", padding:"12px 16px", textAlign:"left", cursor:"pointer", display:"flex", alignItems:"center", gap:10, fontSize:13, color:"#0f172a" }}
              onMouseEnter={e=>e.currentTarget.style.background="#f0fdf4"}
              onMouseLeave={e=>e.currentTarget.style.background="none"}>
              <span style={{ fontSize:16 }}>📦</span>
              <div>
                <div style={{ fontWeight:600 }}>Lançar no Estoque</div>
                <div style={{ fontSize:11, color:"#94a3b8" }}>{itensComProduto.length} produto(s) vinculado(s)</div>
              </div>
            </button>
            <div style={{ height:1, background:"#f1f5f9" }} />
            {/* Lançar Contas a Pagar */}
            <button onClick={() => { setAberto(false); setModalContas(true); }}
              style={{ width:"100%", background:"none", border:"none", padding:"12px 16px", textAlign:"left", cursor:"pointer", display:"flex", alignItems:"center", gap:10, fontSize:13, color:"#0f172a" }}
              onMouseEnter={e=>e.currentTarget.style.background="#eff6ff"}
              onMouseLeave={e=>e.currentTarget.style.background="none"}>
              <span style={{ fontSize:16 }}>💰</span>
              <div>
                <div style={{ fontWeight:600 }}>Lançar Contas a Pagar</div>
                <div style={{ fontSize:11, color:"#94a3b8" }}>{dupsDisponiveis.length} duplicata(s)</div>
              </div>
            </button>
            <div style={{ height:1, background:"#f1f5f9" }} />
            {/* Lançar Ambos */}
            <button onClick={() => { lancarEstoque(); setTimeout(() => setModalContas(true), 100); }}
              style={{ width:"100%", background:"none", border:"none", padding:"12px 16px", textAlign:"left", cursor:"pointer", display:"flex", alignItems:"center", gap:10, fontSize:13, color:"#0f172a" }}
              onMouseEnter={e=>e.currentTarget.style.background="#fafafa"}
              onMouseLeave={e=>e.currentTarget.style.background="none"}>
              <span style={{ fontSize:16 }}>⚡</span>
              <div>
                <div style={{ fontWeight:600 }}>Lançar Estoque + Financeiro</div>
                <div style={{ fontSize:11, color:"#94a3b8" }}>Faz tudo de uma vez</div>
              </div>
            </button>
          </div>
        </>
      )}

      {/* Modal de confirmação de estoque */}
      {modalEstoque && (
        <div style={{ position:"fixed", inset:0, background:"rgba(15,23,42,.6)", backdropFilter:"blur(4px)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:600, padding:24 }}>
          <div style={{ background:"#fff", borderRadius:16, width:"100%", maxWidth:480, padding:"28px 32px", boxShadow:"0 20px 60px rgba(0,0,0,.15)" }}>
            <div style={{ fontWeight:800, fontSize:17, color:"#0f172a", marginBottom:6 }}>📦 Lançar no Estoque</div>
            <div style={{ fontSize:13, color:"#64748b", marginBottom:16 }}>Os seguintes produtos terão seu estoque atualizado:</div>
            {itensComProduto.length === 0 ? (
              <div style={{ background:"#fef2f2", border:"1px solid #fecaca", borderRadius:10, padding:"12px 16px", color:"#dc2626", fontSize:13, marginBottom:16 }}>
                ⚠ Nenhum item desta NF está vinculado a um produto cadastrado. Edite a NF e vincule os itens.
              </div>
            ) : (
              <div style={{ background:"#f0fdf4", border:"1px solid #bbf7d0", borderRadius:10, padding:"12px 16px", marginBottom:16 }}>
                {itensComProduto.map((it, i) => {
                  const prod = produtos.find(p => p.id === it.produtoCadastradoId);
                  return (
                    <div key={i} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"4px 0", borderBottom:i<itensComProduto.length-1?"1px solid #dcfce7":"none" }}>
                      <span style={{ fontSize:13, color:"#0f172a" }}>{prod?.titulo?.slice(0,40) || it.xProd?.slice(0,40)}</span>
                      <span style={{ fontSize:13, fontWeight:700, color:"#15803d" }}>+{it.qCom} {it.uCom||"un"}</span>
                    </div>
                  );
                })}
              </div>
            )}
            <div style={{ display:"flex", gap:8 }}>
              <button onClick={() => setModalEstoque(false)}
                style={{ flex:1, background:"#f8fafc", border:"1px solid #e2e8f0", color:"#64748b", fontWeight:600, padding:"11px", borderRadius:10, cursor:"pointer" }}>Cancelar</button>
              <button onClick={() => { lancarEstoque(); setModalEstoque(false); }} disabled={itensComProduto.length === 0}
                style={{ flex:2, background:itensComProduto.length>0?"#15803d":"#f1f5f9", border:"none", color:itensComProduto.length>0?"#fff":"#94a3b8", fontWeight:700, padding:"11px", borderRadius:10, cursor:itensComProduto.length>0?"pointer":"not-allowed" }}>
                ✓ Confirmar Lançamento
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal de configuração de contas a pagar */}
      {modalContas && (
        <ModalLancarContas
          nf={nf}
          categoriasPagar={categoriasPagar}
          onConfirm={lancarContasPagar}
          onClose={() => setModalContas(false)}
        />
      )}
    </div>
  );
}

// ── Modal de lançamento de contas a pagar da NF ──────────────
function ModalLancarContas({ nf, categoriasPagar, onConfirm, onClose }) {
  const [cfg, setCfg] = useState({
    categoria: "Fornecedor",
    multaPct: "2", multaTipo: "%",
    jurosDia: "0.033", jurosTipo: "%",
    temProtesto: false, diasProtesto: "", cartorio: "",
  });
  const set = (k, v) => setCfg(c => ({ ...c, [k]: v }));
  const dups = nf.duplicatas || [];

  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(15,23,42,.6)", backdropFilter:"blur(4px)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:600, padding:24 }}>
      <div style={{ background:"#fff", borderRadius:16, width:"100%", maxWidth:500, padding:"28px 32px", boxShadow:"0 20px 60px rgba(0,0,0,.15)", maxHeight:"90vh", overflowY:"auto" }}>
        <div style={{ fontWeight:800, fontSize:17, color:"#0f172a", marginBottom:4 }}>💰 Lançar Contas a Pagar</div>
        <div style={{ fontSize:13, color:"#64748b", marginBottom:16 }}>NF {nf.numero}/{nf.serie} — {nf.fornecedorNome}</div>

        {/* Duplicatas */}
        <div style={{ background:"#f8fafc", borderRadius:10, padding:"12px 16px", marginBottom:16 }}>
          <div style={{ fontWeight:700, fontSize:13, color:"#0f172a", marginBottom:10 }}>{dups.length} duplicata(s) a lançar</div>
          {dups.length === 0 ? (
            <div style={{ fontSize:13, color:"#94a3b8" }}>Nenhuma duplicata cadastrada nesta NF.</div>
          ) : dups.map((d, i) => (
            <div key={i} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"6px 0", borderBottom:i<dups.length-1?"1px solid #f1f5f9":"none" }}>
              <div>
                <span style={{ fontSize:12, fontWeight:600, color:"#0f172a" }}>Dup. {d.nDup || String(i+1).padStart(3,"0")}</span>
                <span style={{ fontSize:11, color:"#94a3b8", marginLeft:8 }}>Venc: {d.dVenc ? new Date(d.dVenc+"T12:00:00").toLocaleDateString("pt-BR") : "—"}</span>
              </div>
              <span style={{ fontSize:13, fontWeight:700, color:"#0f172a" }}>R$ {parseFloat(d.vDup||0).toFixed(2).replace(".",",")}</span>
            </div>
          ))}
          <div style={{ display:"flex", justifyContent:"flex-end", marginTop:8, paddingTop:8, borderTop:"1px solid #f1f5f9" }}>
            <span style={{ fontSize:13, fontWeight:800, color:"#0f172a" }}>Total: R$ {dups.reduce((s,d)=>s+parseFloat(d.vDup||0),0).toFixed(2).replace(".",",")}</span>
          </div>
        </div>

        {/* Configuração */}
        <div style={{ display:"flex", flexDirection:"column", gap:12, marginBottom:20 }}>
          <div>
            <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Categoria</div>
            <select value={cfg.categoria} onChange={e=>set("categoria",e.target.value)}
              style={{ width:"100%", background:"#f8fafc", border:"1px solid #e2e8f0", color:"#334155", padding:"9px 12px", borderRadius:8, fontSize:13 }}>
              {(categoriasPagar||["Fornecedor","Outros"]).map(c=><option key={c}>{c}</option>)}
            </select>
          </div>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
            <div>
              <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Multa por atraso</div>
              <div style={{ display:"flex", gap:4 }}>
                <input type="number" value={cfg.multaPct} onChange={e=>set("multaPct",e.target.value)}
                  style={{ flex:1, background:"#f8fafc", border:"1px solid #e2e8f0", color:"#0f172a", padding:"8px 10px", borderRadius:8, fontSize:13, outline:"none" }} placeholder="2" />
                {["%","R$"].map(t=>(
                  <button key={t} onClick={()=>set("multaTipo",t)}
                    style={{ padding:"0 10px", borderRadius:6, border:"none", cursor:"pointer", fontSize:12, fontWeight:700, background:cfg.multaTipo===t?"#0f172a":"#e2e8f0", color:cfg.multaTipo===t?"#fff":"#64748b" }}>{t}</button>
                ))}
              </div>
            </div>
            <div>
              <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Juros ao dia</div>
              <div style={{ display:"flex", gap:4 }}>
                <input type="number" value={cfg.jurosDia} onChange={e=>set("jurosDia",e.target.value)}
                  style={{ flex:1, background:"#f8fafc", border:"1px solid #e2e8f0", color:"#0f172a", padding:"8px 10px", borderRadius:8, fontSize:13, outline:"none" }} placeholder="0.033" />
                {["%","R$"].map(t=>(
                  <button key={t} onClick={()=>set("jurosTipo",t)}
                    style={{ padding:"0 10px", borderRadius:6, border:"none", cursor:"pointer", fontSize:12, fontWeight:700, background:cfg.jurosTipo===t?"#0f172a":"#e2e8f0", color:cfg.jurosTipo===t?"#fff":"#64748b" }}>{t}</button>
                ))}
              </div>
            </div>
          </div>
          <label style={{ display:"flex", alignItems:"center", gap:8, cursor:"pointer" }}>
            <input type="checkbox" checked={cfg.temProtesto} onChange={e=>set("temProtesto",e.target.checked)} style={{ width:14, height:14 }} />
            <span style={{ fontSize:13, color:"#334155" }}>⚖️ Será protestada por atraso</span>
          </label>
          {cfg.temProtesto && (
            <div style={{ display:"grid", gridTemplateColumns:"1fr 2fr", gap:8 }}>
              <div>
                <div style={{ fontSize:11, color:"#94a3b8", marginBottom:4, fontWeight:600, textTransform:"uppercase" }}>Dias p/ Protesto</div>
                <input type="number" value={cfg.diasProtesto} onChange={e=>set("diasProtesto",e.target.value)}
                  style={{ width:"100%", background:"#f8fafc", border:"1px solid #fecaca", color:"#0f172a", padding:"8px 10px", borderRadius:8, fontSize:13, outline:"none" }} placeholder="5" />
              </div>
              <div>
                <div style={{ fontSize:11, color:"#94a3b8", marginBottom:4, fontWeight:600, textTransform:"uppercase" }}>Cartório</div>
                <input value={cfg.cartorio||""} onChange={e=>set("cartorio",e.target.value)}
                  style={{ width:"100%", background:"#f8fafc", border:"1px solid #fecaca", color:"#0f172a", padding:"8px 10px", borderRadius:8, fontSize:13, outline:"none" }} placeholder="1º Cartório..." />
              </div>
            </div>
          )}
        </div>

        <div style={{ display:"flex", gap:8 }}>
          <button onClick={onClose} style={{ flex:1, background:"#f8fafc", border:"1px solid #e2e8f0", color:"#64748b", fontWeight:600, padding:"11px", borderRadius:10, cursor:"pointer" }}>Cancelar</button>
          <button onClick={() => onConfirm(cfg)} disabled={dups.length===0}
            style={{ flex:2, background:dups.length>0?"#0f172a":"#f1f5f9", border:"none", color:dups.length>0?"#fff":"#94a3b8", fontWeight:700, padding:"11px", borderRadius:10, cursor:dups.length>0?"pointer":"not-allowed" }}>
            ✓ Lançar {dups.length} Conta(s) a Pagar
          </button>
        </div>
      </div>
    </div>
  );
}


// ── Aba Principal de Notas Fiscais ───────────────────────────
function NotasFiscaisTab({ notasFiscais, setNotasFiscais, fornecedores, produtos, setProdutos, contasPagar, setContasPagar, categoriasPagar }) {
  const [showModal, setShowModal] = useState(false);
  const [editingNF, setEditingNF] = useState(null);
  const [search, setSearch] = useState("");
  const [filterStatus, setFilterStatus] = useState("all");

  function saveNF(form) {
    const isNew = !notasFiscais.find(n => n.id === form.id);
    const updated = isNew ? [{ ...form, lancadaEm: new Date().toLocaleDateString("sv-SE") }, ...notasFiscais]
                          : notasFiscais.map(n => n.id === form.id ? form : n);
    setNotasFiscais(updated);
    saveNFs(updated);

    if (isNew) {
      // Atualizar estoque dos produtos vinculados
      if (form.atualizarEstoque) {
        const novoProdutos = produtos.map(p => {
          const item = form.itens.find(it => it.produtoCadastradoId === p.id);
          if (!item) return p;
          const novoEstoque = parseFloat(p.estoqueAtual || 0) + parseFloat(item.qCom || 0);
          return { ...p, estoqueAtual: String(novoEstoque) };
        });
        setProdutos(novoProdutos);
        try { localStorage.setItem("produtos_cadastro", JSON.stringify(novoProdutos)); } catch {}
      }

      // Gerar contas a pagar para cada duplicata
      if (form.gerarContaPagar && form.duplicatas.length > 0) {
        const cfg = form.contaPagarConfig;
        const novasContas = form.duplicatas.map((d, i) => ({
          id: Date.now() + i,
          descricao: `NF ${form.numero}/${form.serie} — ${form.fornecedorNome} — Dup. ${d.nDup || String(i+1).padStart(3,"0")}`,
          categoria: cfg.categoria || "Fornecedor",
          valor: String(d.vDup),
          vencimento: d.dVenc,
          status: "Pendente",
          observacao: `Nota Fiscal ${form.numero} — Chave: ${form.chave?.slice(0,20)}...`,
          multaPct: cfg.multaPct, multaTipo: cfg.multaTipo,
          jurosDia: cfg.jurosDia, jurosTipo: cfg.jurosTipo,
          temProtesto: cfg.temProtesto, diasProtesto: cfg.diasProtesto, cartorio: cfg.cartorio,
          nfId: form.id,
        }));
        const updatedContas = [...contasPagar, ...novasContas];
        setContasPagar(updatedContas);
        try { localStorage.setItem("contas_pagar", JSON.stringify(updatedContas)); } catch {}
      }
    }
    setEditingNF(null);
  }

  function deleteNF(id) {
    if (!confirm("Excluir esta nota fiscal? As contas a pagar geradas NÃO serão excluídas.")) return;
    const updated = notasFiscais.filter(n => n.id !== id);
    setNotasFiscais(updated); saveNFs(updated);
  }

  const nfsFiltradas = notasFiscais.filter(n => {
    if (filterStatus !== "all" && n.status !== filterStatus) return false;
    if (search) {
      const q = search.toLowerCase();
      return n.numero?.includes(q) || n.fornecedorNome?.toLowerCase().includes(q) || n.chave?.includes(q);
    }
    return true;
  });

  const totalNFs = notasFiscais.reduce((s,n) => s + (n.totais?.vNF||0), 0);
  const totalItens = notasFiscais.reduce((s,n) => s + (n.itens?.length||0), 0);

  return (
    <div>
      {/* Cards */}
      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(160px,1fr))", gap:10, marginBottom:16 }}>
        {[
          { label:"Total de NFs", value:String(notasFiscais.length), color:"#0f172a", desc:"lançadas" },
          { label:"Valor Total", value:`R$ ${totalNFs.toFixed(2).replace(".",",")}`, color:"#15803d", desc:"em compras" },
          { label:"Total de Itens", value:String(totalItens), color:"#0891b2", desc:"produtos" },
          { label:"Contas Geradas", value:String(notasFiscais.reduce((s,n)=>s+(n.duplicatas?.length||0),0)), color:"#7c3aed", desc:"duplicatas" },
        ].map(k => (
          <div key={k.label} style={{ background:"#fff", border:"1px solid #e2e8f0", borderRadius:12, padding:"14px 18px" }}>
            <div style={{ fontSize:11, color:"#94a3b8", fontWeight:600, textTransform:"uppercase", marginBottom:4 }}>{k.label}</div>
            <div style={{ fontSize:20, fontWeight:800, color:k.color }}>{k.value}</div>
            <div style={{ fontSize:11, color:"#94a3b8", marginTop:2 }}>{k.desc}</div>
          </div>
        ))}
      </div>

      {/* Toolbar */}
      <div style={{ display:"flex", gap:10, alignItems:"center", marginBottom:14, flexWrap:"wrap" }}>
        <button onClick={() => { setEditingNF(null); setShowModal(true); }}
          style={{ background:"#0f172a", border:"none", color:"#fff", fontWeight:700, padding:"9px 20px", borderRadius:8, cursor:"pointer", fontSize:13 }}>
          + Nova Nota Fiscal
        </button>
        <label style={{ background:"#ffe000", border:"none", color:"#0f172a", fontWeight:700, padding:"9px 16px", borderRadius:8, cursor:"pointer", fontSize:13 }}>
          📎 Importar XML
          <input type="file" accept=".xml" style={{ display:"none" }} onChange={e => {
            if (!e.target.files[0]) return;
            const reader = new FileReader();
            reader.onload = ev => {
              try {
                const parsed = parseNFeXML(ev.target.result);
                const forn = fornecedores.find(f => f.cnpj?.replace(/\D/g,"") === parsed.emitente.cnpj?.replace(/\D/g,""));
                setEditingNF({
                  id: Date.now().toString(),
                  numero: parsed.numero, serie: parsed.serie, chave: parsed.chave,
                  dataEmissao: parsed.dataEmissao?.slice(0,10),
                  natureza: parsed.natureza,
                  fornecedorId: forn?.id || "",
                  fornecedorNome: parsed.emitente.nome,
                  fornecedorCNPJ: parsed.emitente.cnpj,
                  totais: parsed.totais,
                  itens: parsed.itens.map(it => ({
                    ...it,
                    produtoCadastradoId: produtos.find(p =>
                      (p.ean && p.ean === it.ean && it.ean !== "SEM GTIN") ||
                      (p.sku && p.sku === it.cProd)
                    )?.id || "",
                  })),
                  duplicatas: parsed.duplicatas,
                  infAdic: parsed.infAdic,
                  gerarContaPagar: true, atualizarEstoque: true,
                  contaPagarConfig: { categoria:"Fornecedor", multaPct:"2", multaTipo:"%", jurosDia:"0.033", jurosTipo:"%", temProtesto:false, diasProtesto:"", cartorio:"" },
                  status: "Lançada", obs: "",
                });
                setShowModal(true);
              } catch(err) { alert("Erro ao ler XML: " + err.message); }
            };
            reader.readAsText(e.target.files[0], "UTF-8");
            e.target.value = "";
          }} />
        </label>
        <div style={{ position:"relative", flex:1, minWidth:200 }}>
          <span style={{ position:"absolute", left:10, top:"50%", transform:"translateY(-50%)", color:"#94a3b8" }}>🔍</span>
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Buscar por NF, fornecedor, chave..."
            style={{ width:"100%", background:"#fff", border:"1px solid #e2e8f0", color:"#0f172a", padding:"8px 12px 8px 32px", borderRadius:8, fontSize:13, outline:"none" }} />
        </div>
        <select value={filterStatus} onChange={e=>setFilterStatus(e.target.value)}
          style={{ background:"#fff", border:"1px solid #e2e8f0", color:"#334155", padding:"8px 12px", borderRadius:8, fontSize:12 }}>
          <option value="all">Todos status</option>
          <option value="Lançada">Lançada</option>
          <option value="Cancelada">Cancelada</option>
        </select>
        <span style={{ fontSize:12, color:"#94a3b8" }}>{nfsFiltradas.length} nota(s)</span>
      </div>

      {/* Tabela */}
      {nfsFiltradas.length === 0 ? (
        <div style={{ background:"#f8fafc", border:"2px dashed #e2e8f0", borderRadius:12, padding:60, textAlign:"center", color:"#94a3b8" }}>
          <div style={{ fontSize:40, marginBottom:12 }}>🧾</div>
          <div style={{ fontWeight:700, fontSize:16, marginBottom:6 }}>Nenhuma nota fiscal lançada</div>
          <div style={{ fontSize:13 }}>Clique em "+ Nova Nota Fiscal" ou importe um XML</div>
        </div>
      ) : (
        <div style={{ background:"#fff", border:"1px solid #e2e8f0", borderRadius:12, overflow:"auto" }}>
          <table style={{ borderCollapse:"collapse", width:"100%" }}>
            <thead>
              <tr>{["NF/Série","Data","Fornecedor","Itens","Total NF","Duplicatas","Status","Ações"].map(h=>(
                <th key={h} style={{ fontSize:11, color:"#94a3b8", textTransform:"uppercase", letterSpacing:0.8, padding:"10px 14px", borderBottom:"1px solid #f1f5f9", textAlign:"left", fontWeight:600, background:"#fafafa", whiteSpace:"nowrap" }}>{h}</th>
              ))}</tr>
            </thead>
            <tbody>
              {nfsFiltradas.map((n,i) => (
                <tr key={n.id} style={{ background:i%2===0?"#f8fafc":"#fff" }}>
                  <td style={{ padding:"10px 14px" }}>
                    <div style={{ fontWeight:700, fontSize:13, color:"#0f172a" }}>{n.numero}/{n.serie}</div>
                    <div style={{ fontSize:10, color:"#94a3b8", fontFamily:"monospace" }}>{n.chave?.slice(0,20)}...</div>
                  </td>
                  <td style={{ padding:"10px 14px", fontSize:12, color:"#64748b" }}>{n.dataEmissao ? new Date(n.dataEmissao+"T12:00:00").toLocaleDateString("pt-BR") : "—"}</td>
                  <td style={{ padding:"10px 14px" }}>
                    <div style={{ fontSize:13, color:"#0f172a", fontWeight:500 }}>{n.fornecedorNome?.slice(0,30)}</div>
                    <div style={{ fontSize:11, color:"#94a3b8" }}>{n.fornecedorCNPJ}</div>
                  </td>
                  <td style={{ padding:"10px 14px", fontSize:13, color:"#0f172a", textAlign:"center" }}>{n.itens?.length||0}</td>
                  <td style={{ padding:"10px 14px", fontSize:13, fontWeight:700, color:"#0f172a" }}>R$ {(n.totais?.vNF||0).toFixed(2).replace(".",",")}</td>
                  <td style={{ padding:"10px 14px" }}>
                    {(n.duplicatas||[]).map((d,di) => (
                      <div key={di} style={{ fontSize:11, color:"#64748b" }}>Dup.{d.nDup||di+1} — {d.dVenc ? new Date(d.dVenc+"T12:00:00").toLocaleDateString("pt-BR") : "—"} — R$ {parseFloat(d.vDup||0).toFixed(2).replace(".",",")}</div>
                    ))}
                  </td>
                  <td style={{ padding:"10px 14px" }}>
                    <span style={{ fontSize:11, fontWeight:600, color:n.status==="Cancelada"?"#dc2626":"#15803d", background:n.status==="Cancelada"?"#fef2f2":"#f0fdf4", padding:"3px 8px", borderRadius:6 }}>{n.status||"Lançada"}</span>
                  </td>
                  <td style={{ padding:"10px 14px" }}>
                    <div style={{ display:"flex", gap:4, alignItems:"center" }}>
                      <button onClick={() => { setEditingNF(n); setShowModal(true); }}
                        style={{ background:"#f1f5f9", border:"1px solid #e2e8f0", color:"#64748b", padding:"4px 8px", borderRadius:6, cursor:"pointer", fontSize:11 }}>✏️</button>
                      <button onClick={() => deleteNF(n.id)}
                        style={{ background:"#fef2f2", border:"1px solid #fecaca", color:"#dc2626", padding:"4px 8px", borderRadius:6, cursor:"pointer", fontSize:11 }}>🗑</button>
                      <MenuAcoes
                        nf={n}
                        produtos={produtos}
                        setProdutos={setProdutos}
                        contasPagar={contasPagar}
                        setContasPagar={setContasPagar}
                        categoriasPagar={categoriasPagar}
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showModal && (
        <ModalNF
          nf={editingNF}
          fornecedores={fornecedores}
          produtos={produtos}
          categoriasPagar={categoriasPagar}
          onSave={saveNF}
          onClose={() => { setShowModal(false); setEditingNF(null); }}
        />
      )}
    </div>
  );
}


// ════════════════════════════════════════════════════════════
//  PRODUTOS — Cadastro completo com sync ML
// ════════════════════════════════════════════════════════════

const ORIGENS_PRODUTO = [
  "0 - Nacional", "1 - Estrangeira (importação direta)",
  "2 - Estrangeira (adquirida no mercado interno)",
  "3 - Nacional c/ + 40% de conteúdo estrangeiro",
  "4 - Nacional (processos básicos)",
  "5 - Nacional c/ até 40% de conteúdo estrangeiro",
];

const CATEGORIAS_PRODUTO = [
  "Lanternas", "Faróis", "Break Lights", "Retrovisores",
  "Para-choques", "Capôs", "Portas", "Vidros",
  "Suspensão", "Motor", "Freios", "Elétrica", "Outros"
];

function saveProdutos(p) { try { localStorage.setItem("produtos_cadastro", JSON.stringify(p)); } catch {} }
function saveFornecedores(f) { try { localStorage.setItem("fornecedores_cadastro", JSON.stringify(f)); } catch {} }

// ── Converte imagem para base64 ──────────────────────────────
function fileToBase64(file) {
  return new Promise((res, rej) => {
    const reader = new FileReader();
    reader.onload = () => res(reader.result);
    reader.onerror = rej;
    reader.readAsDataURL(file);
  });
}

// ── Modal de Fornecedor ──────────────────────────────────────
function ModalFornecedor({ fornecedor, onSave, onClose }) {
  const [form, setForm] = useState(fornecedor || {
    id: Date.now(), nome: "", cnpj: "", telefone: "", email: "", contato: "", obs: ""
  });
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(15,23,42,.6)", backdropFilter:"blur(4px)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:600, padding:24 }}>
      <div style={{ background:"#fff", borderRadius:16, width:"100%", maxWidth:480, padding:"28px 32px", boxShadow:"0 20px 60px rgba(0,0,0,.15)", maxHeight:"90vh", overflowY:"auto" }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:20 }}>
          <div style={{ fontWeight:800, fontSize:17, color:"#0f172a" }}>{fornecedor ? "Editar Fornecedor" : "Novo Fornecedor"}</div>
          <button onClick={onClose} style={{ background:"#f1f5f9", border:"none", color:"#64748b", width:32, height:32, borderRadius:8, cursor:"pointer", fontSize:16 }}>✕</button>
        </div>
        <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
          {[
            { k:"nome", label:"Nome *", placeholder:"Nome do fornecedor" },
            { k:"cnpj", label:"CNPJ", placeholder:"00.000.000/0000-00" },
            { k:"contato", label:"Contato", placeholder:"Nome do contato" },
            { k:"telefone", label:"Telefone", placeholder:"(11) 99999-9999" },
            { k:"email", label:"E-mail", placeholder:"email@fornecedor.com" },
            { k:"obs", label:"Observação", placeholder:"Opcional" },
          ].map(f => (
            <div key={f.k}>
              <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>{f.label}</div>
              <input value={form[f.k]} onChange={e => set(f.k, e.target.value)} placeholder={f.placeholder}
                style={{ width:"100%", background:"#f8fafc", border:"1px solid #e2e8f0", color:"#0f172a", padding:"9px 12px", borderRadius:8, fontSize:13, outline:"none" }} />
            </div>
          ))}
        </div>
        <div style={{ display:"flex", gap:8, marginTop:20 }}>
          <button onClick={onClose} style={{ flex:1, background:"#f8fafc", border:"1px solid #e2e8f0", color:"#64748b", fontWeight:600, padding:"11px", borderRadius:10, cursor:"pointer" }}>Cancelar</button>
          <button onClick={() => { if (!form.nome) return; onSave(form); onClose(); }} disabled={!form.nome}
            style={{ flex:2, background:!form.nome?"#f1f5f9":"#0f172a", border:"none", color:!form.nome?"#94a3b8":"#fff", fontWeight:700, padding:"11px", borderRadius:10, cursor:!form.nome?"not-allowed":"pointer" }}>
            Salvar
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Modal de Produto ─────────────────────────────────────────
function ModalProduto({ produto, fornecedores, listings, onSave, onClose }) {
  const emptyForm = {
    id: Date.now(), titulo: "", sku: "", ean: "", codigoFornecedor: "",
    fornecedorId: "", precoCusto: "", precoVenda: "",
    estoqueAtual: "", estoqueMinimo: "", estoqueMaximo: "", localizacao: "",
    ncm: "", cest: "", origem: "0 - Nacional", cfop: "5102",
    aliqICMS: "", aliqIPI: "", aliqPIS: "0.65", aliqCOFINS: "3.00",
    categoria: "Outros", descricao: "", peso: "", comprimento: "", largura: "", altura: "",
    status: "Ativo", imagens: [], mlbVinculado: "",
  };
  const [form, setForm] = useState(produto || emptyForm);
  const [tab, setTab] = useState("geral");
  const [uploading, setUploading] = useState(false);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  async function handleImages(files) {
    if (form.imagens.length >= 10) return;
    setUploading(true);
    const remaining = 10 - form.imagens.length;
    const toProcess = Array.from(files).slice(0, remaining);
    const base64s = await Promise.all(toProcess.map(f => fileToBase64(f)));
    set("imagens", [...form.imagens, ...base64s]);
    setUploading(false);
  }

  function removeImage(idx) {
    set("imagens", form.imagens.filter((_, i) => i !== idx));
  }

  const TABS = [
    { key:"geral", label:"📋 Geral" },
    { key:"estoque", label:"📦 Estoque" },
    { key:"fiscal", label:"🧾 Fiscal" },
    { key:"fotos", label:"🖼️ Fotos" },
    { key:"ml", label:"🟡 ML" },
  ];

  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(15,23,42,.6)", backdropFilter:"blur(4px)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:600, padding:16 }}>
      <div style={{ background:"#fff", borderRadius:16, width:"100%", maxWidth:720, maxHeight:"92vh", display:"flex", flexDirection:"column", boxShadow:"0 20px 60px rgba(0,0,0,.15)" }}>
        {/* Header */}
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"20px 28px", borderBottom:"1px solid #f1f5f9" }}>
          <div style={{ fontWeight:800, fontSize:17, color:"#0f172a" }}>{produto ? "Editar Produto" : "Novo Produto"}</div>
          <button onClick={onClose} style={{ background:"#f1f5f9", border:"none", color:"#64748b", width:32, height:32, borderRadius:8, cursor:"pointer", fontSize:16 }}>✕</button>
        </div>
        {/* Sub-tabs */}
        <div style={{ display:"flex", gap:2, padding:"10px 28px 0", borderBottom:"1px solid #f1f5f9", background:"#fafafa" }}>
          {TABS.map(t => (
            <button key={t.key} onClick={() => setTab(t.key)}
              style={{ background:tab===t.key?"#fff":"transparent", border:"none", borderBottom:tab===t.key?"2px solid #0f172a":"2px solid transparent", color:tab===t.key?"#0f172a":"#94a3b8", padding:"8px 14px", cursor:"pointer", fontFamily:"inherit", fontSize:12, fontWeight:tab===t.key?700:500 }}>
              {t.label}
            </button>
          ))}
        </div>
        {/* Content */}
        <div style={{ flex:1, overflowY:"auto", padding:"20px 28px" }}>

          {/* ── GERAL ── */}
          {tab === "geral" && (
            <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
              <div>
                <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Título *</div>
                <input value={form.titulo} onChange={e => set("titulo", e.target.value)} placeholder="Nome completo do produto"
                  style={{ width:"100%", background:"#f8fafc", border:"1px solid #e2e8f0", color:"#0f172a", padding:"9px 12px", borderRadius:8, fontSize:13, outline:"none" }} />
              </div>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:10 }}>
                <div>
                  <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>SKU *</div>
                  <input value={form.sku} onChange={e => set("sku", e.target.value)} placeholder="Ex: 097"
                    style={{ width:"100%", background:"#f8fafc", border:"1px solid #e2e8f0", color:"#0f172a", padding:"9px 12px", borderRadius:8, fontSize:13, outline:"none" }} />
                </div>
                <div>
                  <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Cód. de Barras (EAN)</div>
                  <input value={form.ean} onChange={e => set("ean", e.target.value)} placeholder="7891234567890"
                    style={{ width:"100%", background:"#f8fafc", border:"1px solid #e2e8f0", color:"#0f172a", padding:"9px 12px", borderRadius:8, fontSize:13, outline:"none" }} />
                </div>
                <div>
                  <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Categoria</div>
                  <select value={form.categoria} onChange={e => set("categoria", e.target.value)}
                    style={{ width:"100%", background:"#f8fafc", border:"1px solid #e2e8f0", color:"#334155", padding:"9px 12px", borderRadius:8, fontSize:13 }}>
                    {CATEGORIAS_PRODUTO.map(c => <option key={c}>{c}</option>)}
                  </select>
                </div>
              </div>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
                <div>
                  <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Fornecedor</div>
                  <select value={form.fornecedorId} onChange={e => set("fornecedorId", e.target.value)}
                    style={{ width:"100%", background:"#f8fafc", border:"1px solid #e2e8f0", color:"#334155", padding:"9px 12px", borderRadius:8, fontSize:13 }}>
                    <option value="">— Selecione —</option>
                    {fornecedores.map(f => <option key={f.id} value={f.id}>{f.nome}</option>)}
                  </select>
                </div>
                <div>
                  <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Cód. do Fornecedor</div>
                  <input value={form.codigoFornecedor} onChange={e => set("codigoFornecedor", e.target.value)} placeholder="Referência do fornecedor"
                    style={{ width:"100%", background:"#f8fafc", border:"1px solid #e2e8f0", color:"#0f172a", padding:"9px 12px", borderRadius:8, fontSize:13, outline:"none" }} />
                </div>
              </div>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
                <div>
                  <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Preço de Custo (R$)</div>
                  <input type="number" value={form.precoCusto} onChange={e => set("precoCusto", e.target.value)} placeholder="0,00"
                    style={{ width:"100%", background:"#f8fafc", border:"1px solid #e2e8f0", color:"#0f172a", padding:"9px 12px", borderRadius:8, fontSize:13, outline:"none" }} />
                </div>
                <div>
                  <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Preço de Venda (R$)</div>
                  <input type="number" value={form.precoVenda} onChange={e => set("precoVenda", e.target.value)} placeholder="0,00"
                    style={{ width:"100%", background:"#f8fafc", border:"1px solid #e2e8f0", color:"#0f172a", padding:"9px 12px", borderRadius:8, fontSize:13, outline:"none" }} />
                </div>
              </div>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr 1fr", gap:10 }}>
                <div>
                  <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Peso (kg)</div>
                  <input type="number" value={form.peso} onChange={e => set("peso", e.target.value)} placeholder="0.000"
                    style={{ width:"100%", background:"#f8fafc", border:"1px solid #e2e8f0", color:"#0f172a", padding:"9px 12px", borderRadius:8, fontSize:13, outline:"none" }} />
                </div>
                <div>
                  <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Compr. (cm)</div>
                  <input type="number" value={form.comprimento} onChange={e => set("comprimento", e.target.value)} placeholder="0"
                    style={{ width:"100%", background:"#f8fafc", border:"1px solid #e2e8f0", color:"#0f172a", padding:"9px 12px", borderRadius:8, fontSize:13, outline:"none" }} />
                </div>
                <div>
                  <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Larg. (cm)</div>
                  <input type="number" value={form.largura} onChange={e => set("largura", e.target.value)} placeholder="0"
                    style={{ width:"100%", background:"#f8fafc", border:"1px solid #e2e8f0", color:"#0f172a", padding:"9px 12px", borderRadius:8, fontSize:13, outline:"none" }} />
                </div>
                <div>
                  <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Alt. (cm)</div>
                  <input type="number" value={form.altura} onChange={e => set("altura", e.target.value)} placeholder="0"
                    style={{ width:"100%", background:"#f8fafc", border:"1px solid #e2e8f0", color:"#0f172a", padding:"9px 12px", borderRadius:8, fontSize:13, outline:"none" }} />
                </div>
              </div>
              <div>
                <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Descrição</div>
                <textarea value={form.descricao} onChange={e => set("descricao", e.target.value)} placeholder="Descrição detalhada do produto..." rows={3}
                  style={{ width:"100%", background:"#f8fafc", border:"1px solid #e2e8f0", color:"#0f172a", padding:"9px 12px", borderRadius:8, fontSize:13, outline:"none", resize:"vertical" }} />
              </div>
              <div>
                <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Status</div>
                <div style={{ display:"flex", gap:8 }}>
                  {["Ativo","Inativo"].map(s => (
                    <button key={s} onClick={() => set("status", s)}
                      style={{ padding:"7px 20px", borderRadius:8, border:`1px solid ${form.status===s?"#0f172a":"#e2e8f0"}`, background:form.status===s?"#0f172a":"#fff", color:form.status===s?"#fff":"#64748b", fontWeight:600, cursor:"pointer", fontSize:13 }}>
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* ── ESTOQUE ── */}
          {tab === "estoque" && (
            <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:10 }}>
                {[
                  { k:"estoqueAtual", label:"Estoque Atual", placeholder:"0" },
                  { k:"estoqueMinimo", label:"Estoque Mínimo", placeholder:"0" },
                  { k:"estoqueMaximo", label:"Estoque Máximo", placeholder:"0" },
                ].map(f => (
                  <div key={f.k}>
                    <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>{f.label}</div>
                    <input type="number" value={form[f.k]} onChange={e => set(f.k, e.target.value)} placeholder={f.placeholder}
                      style={{ width:"100%", background:"#f8fafc", border:"1px solid #e2e8f0", color:"#0f172a", padding:"9px 12px", borderRadius:8, fontSize:13, outline:"none" }} />
                  </div>
                ))}
              </div>
              <div>
                <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Localização no Estoque</div>
                <input value={form.localizacao} onChange={e => set("localizacao", e.target.value)} placeholder="Ex: Galpão A, Prateleira 3, Box 2"
                  style={{ width:"100%", background:"#f8fafc", border:"1px solid #e2e8f0", color:"#0f172a", padding:"9px 12px", borderRadius:8, fontSize:13, outline:"none" }} />
              </div>
              {form.estoqueAtual && form.estoqueMinimo && parseFloat(form.estoqueAtual) <= parseFloat(form.estoqueMinimo) && (
                <div style={{ background:"#fef2f2", border:"1px solid #fecaca", borderRadius:10, padding:"12px 16px", display:"flex", alignItems:"center", gap:8 }}>
                  <span style={{ fontSize:18 }}>⚠️</span>
                  <div style={{ color:"#dc2626", fontWeight:600, fontSize:13 }}>Estoque abaixo do mínimo!</div>
                </div>
              )}
            </div>
          )}

          {/* ── FISCAL ── */}
          {tab === "fiscal" && (
            <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
                <div>
                  <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>NCM</div>
                  <input value={form.ncm} onChange={e => set("ncm", e.target.value)} placeholder="0000.00.00"
                    style={{ width:"100%", background:"#f8fafc", border:"1px solid #e2e8f0", color:"#0f172a", padding:"9px 12px", borderRadius:8, fontSize:13, outline:"none" }} />
                </div>
                <div>
                  <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>CEST</div>
                  <input value={form.cest} onChange={e => set("cest", e.target.value)} placeholder="00.000.00"
                    style={{ width:"100%", background:"#f8fafc", border:"1px solid #e2e8f0", color:"#0f172a", padding:"9px 12px", borderRadius:8, fontSize:13, outline:"none" }} />
                </div>
              </div>
              <div>
                <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Origem</div>
                <select value={form.origem} onChange={e => set("origem", e.target.value)}
                  style={{ width:"100%", background:"#f8fafc", border:"1px solid #e2e8f0", color:"#334155", padding:"9px 12px", borderRadius:8, fontSize:13 }}>
                  {ORIGENS_PRODUTO.map(o => <option key={o}>{o}</option>)}
                </select>
              </div>
              <div>
                <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>CFOP</div>
                <input value={form.cfop} onChange={e => set("cfop", e.target.value)} placeholder="5102"
                  style={{ width:"100%", background:"#f8fafc", border:"1px solid #e2e8f0", color:"#0f172a", padding:"9px 12px", borderRadius:8, fontSize:13, outline:"none" }} />
              </div>
              <div style={{ background:"#f8fafc", borderRadius:10, padding:"14px 16px" }}>
                <div style={{ fontWeight:600, fontSize:13, color:"#0f172a", marginBottom:12 }}>Alíquotas (%)</div>
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr 1fr", gap:10 }}>
                  {[
                    { k:"aliqICMS", label:"ICMS" },
                    { k:"aliqIPI",  label:"IPI" },
                    { k:"aliqPIS",  label:"PIS" },
                    { k:"aliqCOFINS", label:"COFINS" },
                  ].map(f => (
                    <div key={f.k}>
                      <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>{f.label}</div>
                      <input type="number" value={form[f.k]} onChange={e => set(f.k, e.target.value)} placeholder="0,00"
                        style={{ width:"100%", background:"#fff", border:"1px solid #e2e8f0", color:"#0f172a", padding:"9px 12px", borderRadius:8, fontSize:13, outline:"none" }} />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* ── FOTOS ── */}
          {tab === "fotos" && (
            <div>
              <div style={{ fontSize:13, color:"#64748b", marginBottom:14 }}>
                {form.imagens.length}/10 fotos adicionadas
              </div>
              {form.imagens.length < 10 && (
                <label style={{ display:"block", border:"2px dashed #e2e8f0", borderRadius:12, padding:"24px", textAlign:"center", cursor:"pointer", marginBottom:16, background:"#f8fafc" }}>
                  <input type="file" accept="image/*" multiple style={{ display:"none" }} onChange={e => handleImages(e.target.files)} />
                  <div style={{ fontSize:32, marginBottom:8 }}>📷</div>
                  <div style={{ fontSize:14, fontWeight:600, color:"#0f172a" }}>{uploading ? "Carregando..." : "Clique para adicionar fotos"}</div>
                  <div style={{ fontSize:12, color:"#94a3b8", marginTop:4 }}>JPG, PNG, WEBP — máx. {10 - form.imagens.length} foto(s)</div>
                </label>
              )}
              <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill, minmax(120px, 1fr))", gap:10 }}>
                {form.imagens.map((img, idx) => (
                  <div key={idx} style={{ position:"relative", aspectRatio:"1", borderRadius:10, overflow:"hidden", border:"1px solid #e2e8f0" }}>
                    <img src={img} alt={`Foto ${idx+1}`} style={{ width:"100%", height:"100%", objectFit:"cover" }} />
                    {idx === 0 && <div style={{ position:"absolute", top:6, left:6, background:"#0f172a", color:"#fff", fontSize:9, padding:"2px 6px", borderRadius:4, fontWeight:700 }}>CAPA</div>}
                    <button onClick={() => removeImage(idx)}
                      style={{ position:"absolute", top:6, right:6, background:"#dc2626", border:"none", color:"#fff", width:22, height:22, borderRadius:6, cursor:"pointer", fontSize:12, display:"flex", alignItems:"center", justifyContent:"center" }}>✕</button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── ML ── */}
          {tab === "ml" && (
            <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
              <div style={{ background:"#fffbeb", border:"1px solid #fde68a", borderRadius:10, padding:"12px 16px", fontSize:13, color:"#92400e" }}>
                💡 Vincule este produto a um anúncio do ML pelo SKU. O estoque e custo serão sincronizados automaticamente.
              </div>
              <div>
                <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Anúncio ML Vinculado (por SKU)</div>
                <select value={form.mlbVinculado} onChange={e => set("mlbVinculado", e.target.value)}
                  style={{ width:"100%", background:"#f8fafc", border:"1px solid #e2e8f0", color:"#334155", padding:"9px 12px", borderRadius:8, fontSize:13 }}>
                  <option value="">— Nenhum —</option>
                  {listings.filter(l => l.seller_sku || l.sku).map(l => (
                    <option key={l.id} value={l.id}>
                      {l.seller_sku || l.sku} — {l.title?.slice(0,50)}
                    </option>
                  ))}
                </select>
              </div>
              {form.mlbVinculado && (() => {
                const listing = listings.find(l => l.id === form.mlbVinculado);
                if (!listing) return null;
                return (
                  <div style={{ background:"#f0fdf4", border:"1px solid #bbf7d0", borderRadius:10, padding:"14px 16px" }}>
                    <div style={{ fontWeight:700, fontSize:13, color:"#15803d", marginBottom:8 }}>✓ Anúncio vinculado</div>
                    <div style={{ fontSize:13, color:"#0f172a", marginBottom:4 }}>{listing.title}</div>
                    <div style={{ display:"flex", gap:16, fontSize:12, color:"#64748b" }}>
                      <span>MLB: {listing.id}</span>
                      <span>Preço: R$ {listing.price}</span>
                      <span>Estoque ML: {listing.available_quantity}</span>
                    </div>
                  </div>
                );
              })()}
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{ display:"flex", gap:8, padding:"16px 28px", borderTop:"1px solid #f1f5f9" }}>
          <button onClick={onClose} style={{ flex:1, background:"#f8fafc", border:"1px solid #e2e8f0", color:"#64748b", fontWeight:600, padding:"11px", borderRadius:10, cursor:"pointer" }}>Cancelar</button>
          <button onClick={() => { if (!form.titulo || !form.sku) return; onSave(form); onClose(); }}
            disabled={!form.titulo || !form.sku}
            style={{ flex:3, background:!form.titulo||!form.sku?"#f1f5f9":"#0f172a", border:"none", color:!form.titulo||!form.sku?"#94a3b8":"#fff", fontWeight:700, padding:"11px", borderRadius:10, cursor:!form.titulo||!form.sku?"not-allowed":"pointer" }}>
            Salvar Produto
          </button>
        </div>
      </div>
    </div>
  );
}

// ── ProdutosTab Principal ────────────────────────────────────
function ProdutosTab({ produtos, setProdutos, fornecedores, setFornecedores, listings, costs, setCosts }) {
  const [prodTab, setProdTab] = useState("lista"); // lista | fornecedores
  const [showModalProd, setShowModalProd] = useState(false);
  const [showModalForn, setShowModalForn] = useState(false);
  const [editingProd, setEditingProd] = useState(null);
  const [editingForn, setEditingForn] = useState(null);
  const [search, setSearch] = useState("");
  const [filterCat, setFilterCat] = useState("all");
  const [filterStatus, setFilterStatus] = useState("all");

  function saveProd(form) {
    const updated = editingProd ? produtos.map(p => p.id===form.id?form:p) : [...produtos, {...form, id:Date.now()}];
    setProdutos(updated); saveProdutos(updated);
    // Sync custo com dashboard de anúncios (aba Anúncios)
    if (form.mlbVinculado && form.precoCusto) {
      setCosts(c => ({ ...c, [form.mlbVinculado]: parseFloat(form.precoCusto) }));
    }
    // Sync todos os produtos vinculados ao ML de uma vez
    const newCosts = {};
    updated.forEach(p => {
      if (p.mlbVinculado && p.precoCusto) {
        newCosts[p.mlbVinculado] = parseFloat(p.precoCusto);
      }
    });
    if (Object.keys(newCosts).length > 0) {
      setCosts(c => ({ ...c, ...newCosts }));
    }
    setEditingProd(null);
  }

  function deleteProd(id) {
    if (!confirm("Excluir este produto?")) return;
    const updated = produtos.filter(p => p.id !== id);
    setProdutos(updated); saveProdutos(updated);
  }

  function saveForn(form) {
    const updated = editingForn ? fornecedores.map(f => f.id===form.id?form:f) : [...fornecedores, {...form, id:Date.now()}];
    setFornecedores(updated); saveFornecedores(updated);
    setEditingForn(null);
  }

  function deleteForn(id) {
    if (!confirm("Excluir este fornecedor?")) return;
    const updated = fornecedores.filter(f => f.id !== id);
    setFornecedores(updated); saveFornecedores(updated);
  }

  const produtosFiltrados = useMemo(() => {
    let r = produtos;
    if (search) r = r.filter(p =>
      p.titulo?.toLowerCase().includes(search.toLowerCase()) ||
      p.sku?.toLowerCase().includes(search.toLowerCase()) ||
      p.ean?.includes(search) ||
      p.codigoFornecedor?.toLowerCase().includes(search.toLowerCase())
    );
    if (filterCat !== "all") r = r.filter(p => p.categoria === filterCat);
    if (filterStatus !== "all") r = r.filter(p => p.status === filterStatus);
    return r;
  }, [produtos, search, filterCat, filterStatus]);

  const estoqueBaixo = produtos.filter(p => p.estoqueMinimo && p.estoqueAtual && parseFloat(p.estoqueAtual) <= parseFloat(p.estoqueMinimo));

  return (
    <div>
      {/* Sub-tabs */}
      <div style={{ display:"flex", gap:2, marginBottom:16, background:"#f1f5f9", padding:4, borderRadius:10, width:"fit-content" }}>
        {[
          { key:"lista", label:"📦 Produtos" },
          { key:"fornecedores", label:"🏭 Fornecedores" },
        ].map(t => (
          <button key={t.key} onClick={() => setProdTab(t.key)}
            style={{ background:prodTab===t.key?"#fff":"transparent", border:"none", color:prodTab===t.key?"#0f172a":"#94a3b8", padding:"8px 18px", cursor:"pointer", fontFamily:"inherit", fontSize:13, borderRadius:8, fontWeight:prodTab===t.key?700:500, boxShadow:prodTab===t.key?"0 1px 3px rgba(0,0,0,.08)":"none" }}>
            {t.label}
          </button>
        ))}
      </div>

      {/* ── LISTA DE PRODUTOS ── */}
      {prodTab === "lista" && (
        <div>
          {estoqueBaixo.length > 0 && (
            <div style={{ background:"#fef2f2", border:"1px solid #fecaca", borderRadius:10, padding:"12px 16px", marginBottom:14, display:"flex", alignItems:"center", gap:10 }}>
              <span style={{ fontSize:18 }}>⚠️</span>
              <div>
                <div style={{ fontWeight:700, color:"#dc2626", fontSize:13 }}>Estoque crítico em {estoqueBaixo.length} produto(s)</div>
                <div style={{ fontSize:12, color:"#b91c1c" }}>{estoqueBaixo.map(p => p.titulo?.slice(0,30)).join(", ")}</div>
              </div>
            </div>
          )}

          <div style={{ display:"flex", gap:10, alignItems:"center", marginBottom:14, flexWrap:"wrap" }}>
            <button onClick={() => { setEditingProd(null); setShowModalProd(true); }}
              style={{ background:"#0f172a", border:"none", color:"#fff", fontWeight:700, padding:"9px 20px", borderRadius:8, cursor:"pointer", fontSize:13 }}>+ Novo Produto</button>
            {listings.length > 0 && (
              <button onClick={() => {
                const sincronizados = syncListingsToProdutos(listings, produtos);
                setProdutos(sincronizados); saveProdutos(sincronizados);
                // Sync custos
                const newCosts = {};
                sincronizados.forEach(p => { if (p.mlbVinculado && p.precoCusto) newCosts[p.mlbVinculado] = parseFloat(p.precoCusto); });
                if (Object.keys(newCosts).length > 0) setCosts(c => ({...c, ...newCosts}));
                alert(`✅ ${sincronizados.length} produtos sincronizados com o ML!`);
              }}
                style={{ background:"#ffe000", border:"none", color:"#0f172a", fontWeight:700, padding:"9px 20px", borderRadius:8, cursor:"pointer", fontSize:13 }}>
                🔄 Sincronizar com ML
              </button>
            )}
            <div style={{ position:"relative", flex:1, minWidth:200 }}>
              <span style={{ position:"absolute", left:10, top:"50%", transform:"translateY(-50%)", color:"#94a3b8", fontSize:13 }}>🔍</span>
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar por título, SKU, EAN..."
                style={{ width:"100%", background:"#fff", border:"1px solid #e2e8f0", color:"#0f172a", padding:"8px 12px 8px 32px", borderRadius:8, fontSize:13, outline:"none" }} />
            </div>
            <select value={filterCat} onChange={e => setFilterCat(e.target.value)}
              style={{ background:"#fff", border:"1px solid #e2e8f0", color:"#334155", padding:"8px 12px", borderRadius:8, fontSize:12 }}>
              <option value="all">Todas categorias</option>
              {CATEGORIAS_PRODUTO.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)}
              style={{ background:"#fff", border:"1px solid #e2e8f0", color:"#334155", padding:"8px 12px", borderRadius:8, fontSize:12 }}>
              <option value="all">Todos status</option>
              <option value="Ativo">Ativo</option>
              <option value="Inativo">Inativo</option>
            </select>
            <span style={{ fontSize:12, color:"#94a3b8" }}>{produtosFiltrados.length} produto(s)</span>
            <span style={{ fontSize:12, color:"#854d0e", background:"#fef9c3", padding:"3px 10px", borderRadius:20, fontWeight:600 }}>🟡 {produtos.filter(p=>p.syncML).length} sincronizados com ML</span>
          </div>

          {produtosFiltrados.length === 0 ? (
            <div style={{ background:"#f8fafc", border:"2px dashed #e2e8f0", borderRadius:12, padding:60, textAlign:"center", color:"#94a3b8" }}>
              <div style={{ fontSize:40, marginBottom:12 }}>📦</div>
              <div style={{ fontWeight:700, fontSize:16, marginBottom:6 }}>Nenhum produto cadastrado</div>
              <div style={{ fontSize:13 }}>Clique em "+ Novo Produto" para começar</div>
            </div>
          ) : (
            <div style={{ background:"#fff", border:"1px solid #e2e8f0", borderRadius:12, overflow:"auto" }}>
              <table style={{ borderCollapse:"collapse", width:"100%" }}>
                <thead>
                  <tr>{["Foto","Produto","SKU / EAN","Fornecedor","Custo","Venda","Estoque","Status","ML","Ações"].map(h=>(
                    <th key={h} style={{ fontSize:11, color:"#94a3b8", textTransform:"uppercase", letterSpacing:0.8, padding:"10px 14px", borderBottom:"1px solid #f1f5f9", textAlign:"left", fontWeight:600, background:"#fafafa", whiteSpace:"nowrap" }}>{h}</th>
                  ))}</tr>
                </thead>
                <tbody>
                  {produtosFiltrados.map((p, i) => {
                    const forn = fornecedores.find(f => f.id === p.fornecedorId);
                    const mlListing = listings.find(l => l.id === p.mlbVinculado);
                    const estBaixo = p.estoqueMinimo && p.estoqueAtual && parseFloat(p.estoqueAtual) <= parseFloat(p.estoqueMinimo);
                    return (
                      <tr key={p.id} style={{ background:i%2===0?"#f8fafc":"#fff" }}>
                        <td style={{ padding:"8px 8px 8px 14px", width:52 }}>
                          {p.imagens?.[0] ? (
                            <img src={p.imagens[0]} alt="" style={{ width:44, height:44, objectFit:"cover", borderRadius:8, border:"1px solid #e2e8f0" }} />
                          ) : (
                            <div style={{ width:44, height:44, borderRadius:8, background:"#f1f5f9", border:"1px solid #e2e8f0", display:"flex", alignItems:"center", justifyContent:"center", fontSize:18 }}>📦</div>
                          )}
                        </td>
                        <td style={{ padding:"10px 14px", maxWidth:200 }}>
                          <div style={{ fontSize:13, fontWeight:600, color:"#0f172a", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{p.titulo}</div>
                          <div style={{ display:"flex", gap:4, alignItems:"center", marginTop:2 }}>
                          <div style={{ fontSize:11, color:"#94a3b8" }}>{p.categoria}</div>
                          {p.syncML && <span style={{ fontSize:9, background:"#fef9c3", color:"#854d0e", padding:"1px 5px", borderRadius:3, fontWeight:700 }}>ML</span>}
                          {p.ultimoSyncML && <span style={{ fontSize:9, color:"#cbd5e1" }}>sync {p.ultimoSyncML}</span>}
                        </div>
                        </td>
                        <td style={{ padding:"10px 14px" }}>
                          <div style={{ fontSize:12, fontFamily:"monospace", fontWeight:600, color:"#334155" }}>{p.sku || "—"}</div>
                          {p.ean && <div style={{ fontSize:10, color:"#94a3b8" }}>{p.ean}</div>}
                        </td>
                        <td style={{ padding:"10px 14px", fontSize:12, color:"#64748b" }}>
                          <div>{forn?.nome || "—"}</div>
                          {p.codigoFornecedor && <div style={{ fontSize:10, color:"#94a3b8" }}>{p.codigoFornecedor}</div>}
                        </td>
                        <td style={{ padding:"10px 14px" }}>
                          {p.precoCusto ? (
                            <div>
                              <div style={{ fontSize:13, fontWeight:700, color:"#0f172a" }}>R$ {parseFloat(p.precoCusto).toFixed(2).replace(".",",")}</div>
                              {p.mlbVinculado && <div style={{ fontSize:10, color:"#15803d" }}>✓ sync anúncios</div>}
                            </div>
                          ) : (
                            <span style={{ fontSize:12, color:"#94a3b8" }}>— insira custo</span>
                          )}
                        </td>
                        <td style={{ padding:"10px 14px", fontSize:13, fontWeight:600, color:"#15803d" }}>
                          {p.precoVenda ? `R$ ${parseFloat(p.precoVenda).toFixed(2).replace(".",",")}` : "—"}
                        </td>
                        <td style={{ padding:"10px 14px" }}>
                          <div style={{ fontWeight:700, fontSize:13, color:estBaixo?"#dc2626":"#0f172a" }}>
                            {p.estoqueAtual || "0"} un {estBaixo?"⚠️":""}
                          </div>
                          {p.estoqueMinimo && <div style={{ fontSize:10, color:"#94a3b8" }}>mín: {p.estoqueMinimo}</div>}
                        </td>
                        <td style={{ padding:"10px 14px" }}>
                          <span style={{ fontSize:11, fontWeight:600, color:p.status==="Ativo"?"#15803d":"#94a3b8", background:p.status==="Ativo"?"#f0fdf4":"#f8fafc", padding:"3px 8px", borderRadius:6 }}>{p.status}</span>
                        </td>
                        <td style={{ padding:"10px 14px" }}>
                          {mlListing ? (
                            <div style={{ fontSize:11, color:"#15803d" }}>✓ {mlListing.id}</div>
                          ) : <span style={{ fontSize:11, color:"#94a3b8" }}>—</span>}
                        </td>
                        <td style={{ padding:"10px 14px" }}>
                          <div style={{ display:"flex", gap:4 }}>
                            <button onClick={() => { setEditingProd(p); setShowModalProd(true); }}
                              style={{ background:"#f1f5f9", border:"1px solid #e2e8f0", color:"#64748b", padding:"4px 8px", borderRadius:6, cursor:"pointer", fontSize:11 }}>✏️</button>
                            <button onClick={() => deleteProd(p.id)}
                              style={{ background:"#fef2f2", border:"1px solid #fecaca", color:"#dc2626", padding:"4px 8px", borderRadius:6, cursor:"pointer", fontSize:11 }}>🗑</button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── FORNECEDORES ── */}
      {prodTab === "fornecedores" && (
        <div>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:14 }}>
            <div style={{ fontWeight:700, fontSize:15, color:"#0f172a" }}>Fornecedores Cadastrados</div>
            <button onClick={() => { setEditingForn(null); setShowModalForn(true); }}
              style={{ background:"#0f172a", border:"none", color:"#fff", fontWeight:700, padding:"9px 20px", borderRadius:8, cursor:"pointer", fontSize:13 }}>+ Novo Fornecedor</button>
          </div>
          {fornecedores.length === 0 ? (
            <div style={{ background:"#f8fafc", border:"2px dashed #e2e8f0", borderRadius:12, padding:40, textAlign:"center", color:"#94a3b8" }}>
              <div style={{ fontSize:32, marginBottom:8 }}>🏭</div>
              <div style={{ fontWeight:600 }}>Nenhum fornecedor cadastrado</div>
            </div>
          ) : (
            <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(280px,1fr))", gap:12 }}>
              {fornecedores.map(f => {
                const qtdProdutos = produtos.filter(p => p.fornecedorId === f.id).length;
                return (
                  <div key={f.id} style={{ background:"#fff", border:"1px solid #e2e8f0", borderRadius:12, padding:"18px 20px", position:"relative" }}>
                    <div style={{ position:"absolute", top:12, right:12, display:"flex", gap:4 }}>
                      <button onClick={() => { setEditingForn(f); setShowModalForn(true); }}
                        style={{ background:"#f1f5f9", border:"none", color:"#64748b", width:28, height:28, borderRadius:6, cursor:"pointer", fontSize:12 }}>✏️</button>
                      <button onClick={() => deleteForn(f.id)}
                        style={{ background:"#fef2f2", border:"none", color:"#dc2626", width:28, height:28, borderRadius:6, cursor:"pointer", fontSize:12 }}>🗑</button>
                    </div>
                    <div style={{ fontWeight:700, fontSize:15, color:"#0f172a", marginBottom:4, paddingRight:70 }}>{f.nome}</div>
                    <div style={{ fontSize:11, color:"#94a3b8", marginBottom:10 }}>{f.cnpj || "CNPJ não informado"}</div>
                    <div style={{ display:"flex", flexDirection:"column", gap:4, fontSize:12, color:"#64748b" }}>
                      {f.contato && <span>👤 {f.contato}</span>}
                      {f.telefone && <span>📞 {f.telefone}</span>}
                      {f.email && <span>✉️ {f.email}</span>}
                    </div>
                    <div style={{ marginTop:10, paddingTop:10, borderTop:"1px solid #f1f5f9", fontSize:12, color:"#94a3b8" }}>
                      {qtdProdutos} produto(s) vinculado(s)
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {showModalProd && <ModalProduto produto={editingProd} fornecedores={fornecedores} listings={listings} onSave={saveProd} onClose={() => { setShowModalProd(false); setEditingProd(null); }} />}
      {showModalForn && <ModalFornecedor fornecedor={editingForn} onSave={saveForn} onClose={() => { setShowModalForn(false); setEditingForn(null); }} />}
    </div>
  );
}


// ════════════════════════════════════════════════════════════
//  IA — Analisador de Prioridade de Pagamentos
// ════════════════════════════════════════════════════════════

async function analisarPrioridadePagamentos(contas, saldoDisponivel) {
  const hoje = new Date().toLocaleDateString("sv-SE");
  
  // Calcula custo acumulado de cada conta
  const contasComCusto = contas.filter(c => c.status !== "Pago").map(c => {
    const valor = parseFloat(c.valor || 0);
    // Converte multa para valor R$
    const multaR = c.multaTipo === "R$"
      ? parseFloat(c.multaPct || 0)
      : valor * (parseFloat(c.multaPct || 0) / 100);
    // Converte juros para valor R$ por dia
    const jurosDiaR = c.jurosTipo === "R$"
      ? parseFloat(c.jurosDia || 0)
      : valor * (parseFloat(c.jurosDia || 0) / 100);
    const multa = valor > 0 ? multaR / valor : 0;
    const jurosDia = valor > 0 ? jurosDiaR / valor : 0;
    const venc = c.vencimento;
    const hoje = new Date(); hoje.setHours(0,0,0,0);
    const dueDate = venc ? new Date(venc + "T00:00:00") : null;
    const diasAtraso = dueDate ? Math.max(0, Math.round((hoje - dueDate) / 86400000)) : 0;
    const diasParaVencer = dueDate ? Math.round((dueDate - hoje) / 86400000) : 999;
    
    const multaValor = diasAtraso > 0 ? multaR : 0;
    const jurosValor = diasAtraso > 0 ? jurosDiaR * diasAtraso : 0;
    const custoHoje = valor + multaValor + jurosValor;
    const custoAmanha = valor + (diasAtraso === 0 && dueDate ? multaR : multaValor) + jurosDiaR * (diasAtraso + 1);
    const custoPorDia = jurosDiaR + (diasAtraso === 0 && dueDate ? multaR : 0);
    
    return {
      ...c, valor, multa, jurosDia, diasAtraso, diasParaVencer,
      multaValor, jurosValor, custoHoje, custoAmanha, custoPorDia,
    };
  });

  const prompt = `Você é um consultor financeiro especialista em gestão de fluxo de caixa para pequenas empresas brasileiras.

Analise as seguintes contas a pagar e forneça uma recomendação de prioridade de pagamento considerando:
1. Custo total atual (valor + multa + juros acumulados)
2. Custo por dia de atraso adicional
3. Dias até o vencimento (ou de atraso)
4. Valor total de cada conta

Saldo disponível para pagamento hoje: R$ ${saldoDisponivel.toFixed(2)}

Contas a pagar:
${contasComCusto.map((c, i) => `
${i+1}. ${c.descricao}
   - Valor original: R$ ${c.valor.toFixed(2)}
   - Vencimento: ${c.vencimento || "não informado"}
   - Situação: ${c.diasAtraso > 0 ? `VENCIDA há ${c.diasAtraso} dias` : c.diasParaVencer === 0 ? "VENCE HOJE" : `vence em ${c.diasParaVencer} dias`}
   - Multa acumulada: R$ ${c.multaValor.toFixed(2)} (${c.multaTipo||"%"} ${c.multaPct || 0}${c.multaTipo==="R$"?" R$/ocorrência":" %"})
   - Juros acumulados: R$ ${c.jurosValor.toFixed(2)} (${c.jurosTipo||"%"} ${c.jurosDia || 0}${c.jurosTipo==="R$"?" R$/dia":" % ao dia"})
   - Custo total hoje: R$ ${c.custoHoje.toFixed(2)}
   - Custo adicional por dia: R$ ${c.custoPorDia.toFixed(2)}
   - Categoria: ${c.categoria}
   - Protesto: ${c.temProtesto ? `SIM — será protestada ${c.diasProtesto} dias após vencimento${c.cartorio ? ` (${c.cartorio})` : ""}` : "Não"}
`).join("")}

Retorne APENAS um JSON válido neste formato exato:
{
  "resumo": "frase curta explicando a situação geral",
  "alerta_critico": "alerta se houver situação urgente ou null",
  "prioridade": [
    {
      "posicao": 1,
      "id": "id_da_conta",
      "razao": "explicação curta do motivo da prioridade",
      "urgencia": "critica|alta|media|baixa",
      "pagar_hoje": true|false,
      "economia_se_pagar_hoje": 0.00
    }
  ],
  "contas_no_saldo": ["id1", "id2"],
  "total_se_pagar_prioritarias": 0.00,
  "recomendacao_final": "texto com recomendação final considerando o saldo disponível"
}`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
      "x-api-key": import.meta.env.VITE_ANTHROPIC_KEY,
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: 1000,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  const data = await response.json();
  if (data.error) throw new Error(data.error.message);
  const text = data.content?.map(b => b.text || "").join("") ?? "";
  const clean = text.replace(/```json|```/g, "").trim();
  const jsonStart = clean.indexOf("{");
  const jsonEnd = clean.lastIndexOf("}");
  return JSON.parse(clean.slice(jsonStart, jsonEnd + 1));
}

function PainelIAPagamentos({ contasPagar, contasBancarias }) {
  const [state, setState] = useState("idle"); // idle | loading | done | error
  const [result, setResult] = useState(null);
  const [errorMsg, setErrorMsg] = useState("");
  const [saldo, setSaldo] = useState("");
  const [contaSelecionada, setContaSelecionada] = useState("");

  const contasPendentes = contasPagar.filter(c => c.status !== "Pago");

  async function analisar() {
    if (!import.meta.env.VITE_ANTHROPIC_KEY) {
      setErrorMsg("Chave da API Anthropic não configurada (VITE_ANTHROPIC_KEY)");
      setState("error"); return;
    }
    if (contasPendentes.length === 0) {
      setErrorMsg("Nenhuma conta pendente para analisar");
      setState("error"); return;
    }
    setState("loading"); setErrorMsg("");
    try {
      const r = await analisarPrioridadePagamentos(contasPendentes, parseFloat(saldo) || 0);
      setResult(r); setState("done");
    } catch(e) { setErrorMsg(e.message); setState("error"); }
  }

  const urgenciaCor = u => u==="critica"?"#dc2626":u==="alta"?"#d97706":u==="media"?"#0891b2":"#15803d";
  const urgenciaBg  = u => u==="critica"?"#fef2f2":u==="alta"?"#fffbeb":u==="media"?"#ecfeff":"#f0fdf4";
  const urgenciaLabel = u => u==="critica"?"🚨 CRÍTICA":u==="alta"?"⚠️ Alta":u==="media"?"📋 Média":"✓ Baixa";

  return (
    <div style={{ background:"#fff", border:"1px solid #e2e8f0", borderRadius:16, padding:"24px 28px", marginBottom:20, boxShadow:"0 1px 3px rgba(0,0,0,.06)" }}>
      <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:20 }}>
        <div style={{ width:40, height:40, borderRadius:12, background:"linear-gradient(135deg,#667eea,#764ba2)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:20 }}>✦</div>
        <div>
          <div style={{ fontWeight:800, fontSize:16, color:"#0f172a" }}>Análise IA de Prioridade de Pagamentos</div>
          <div style={{ fontSize:12, color:"#94a3b8" }}>Descubra quais contas custam mais por dia de atraso</div>
        </div>
      </div>

      {state === "idle" && (
        <div>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12, marginBottom:16 }}>
            <div>
              <div style={{ fontSize:11, color:"#94a3b8", marginBottom:6, fontWeight:600, textTransform:"uppercase" }}>Saldo disponível hoje (R$)</div>
              <input type="number" value={saldo} onChange={e => setSaldo(e.target.value)}
                placeholder="Ex: 5000,00 — deixe 0 para análise geral"
                style={{ width:"100%", background:"#f8fafc", border:"1px solid #e2e8f0", color:"#0f172a", padding:"10px 14px", borderRadius:10, fontSize:13, outline:"none" }} />
            </div>
            <div>
              <div style={{ fontSize:11, color:"#94a3b8", marginBottom:6, fontWeight:600, textTransform:"uppercase" }}>Conta para pagamento</div>
              <select value={contaSelecionada} onChange={e => setContaSelecionada(e.target.value)}
                style={{ width:"100%", background:"#f8fafc", border:"1px solid #e2e8f0", color:"#334155", padding:"10px 14px", borderRadius:10, fontSize:13 }}>
                <option value="">— Selecione (opcional) —</option>
                {contasBancarias.map(c => <option key={c.id} value={c.id}>{c.nome}</option>)}
              </select>
            </div>
          </div>
          <div style={{ background:"#f8fafc", borderRadius:10, padding:"12px 14px", marginBottom:16 }}>
            <div style={{ fontSize:12, color:"#64748b", marginBottom:8 }}>
              <strong>{contasPendentes.length}</strong> contas pendentes para análise
              {contasPendentes.filter(c=>c.multaPct||c.jurosDia).length < contasPendentes.length && (
                <span style={{ color:"#d97706", marginLeft:8 }}>
                  ⚠ {contasPendentes.filter(c=>!c.multaPct&&!c.jurosDia).length} sem juros/multa cadastrados — a IA ainda analisa por vencimento e valor
                </span>
              )}
            </div>
            <div style={{ display:"flex", flexWrap:"wrap", gap:6 }}>
              {contasPendentes.slice(0,5).map(c => (
                <span key={c.id} style={{ fontSize:11, background:"#e2e8f0", color:"#475569", padding:"3px 8px", borderRadius:20 }}>
                  {c.descricao?.slice(0,25)} — R$ {parseFloat(c.valor||0).toFixed(2).replace(".",",")}
                </span>
              ))}
              {contasPendentes.length > 5 && <span style={{ fontSize:11, color:"#94a3b8" }}>+{contasPendentes.length-5} mais</span>}
            </div>
          </div>
          <button onClick={analisar}
            style={{ width:"100%", background:"linear-gradient(135deg,#667eea,#764ba2)", border:"none", color:"#fff", fontWeight:700, padding:"13px", borderRadius:12, cursor:"pointer", fontSize:15 }}>
            ✦ Analisar com Inteligência Artificial
          </button>
        </div>
      )}

      {state === "loading" && (
        <div style={{ textAlign:"center", padding:"32px 0" }}>
          <div style={{ fontSize:32, marginBottom:12, display:"inline-block", animation:"spin 1s linear infinite" }}>✦</div>
          <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
          <div style={{ fontSize:14, color:"#94a3b8" }}>Analisando suas contas com IA...</div>
          <div style={{ fontSize:12, color:"#cbd5e1", marginTop:4 }}>Calculando custo de cada dia de atraso</div>
        </div>
      )}

      {state === "error" && (
        <div>
          <div style={{ background:"#fef2f2", border:"1px solid #fecaca", borderRadius:10, padding:"12px 16px", marginBottom:16, color:"#dc2626", fontSize:13 }}>⚠ {errorMsg}</div>
          <button onClick={() => setState("idle")} style={{ background:"#f8fafc", border:"1px solid #e2e8f0", color:"#334155", fontWeight:600, padding:"10px 20px", borderRadius:10, cursor:"pointer" }}>Tentar novamente</button>
        </div>
      )}

      {state === "done" && result && (
        <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
          {/* Resumo */}
          <div style={{ background:"linear-gradient(135deg,#667eea22,#764ba222)", border:"1px solid #667eea44", borderRadius:12, padding:"14px 18px" }}>
            <div style={{ fontSize:13, color:"#0f172a", lineHeight:1.6 }}>{result.resumo}</div>
          </div>

          {/* Alerta crítico */}
          {result.alerta_critico && (
            <div style={{ background:"#fef2f2", border:"1px solid #fecaca", borderRadius:10, padding:"12px 16px", display:"flex", gap:10, alignItems:"flex-start" }}>
              <span style={{ fontSize:18 }}>🚨</span>
              <div style={{ fontSize:13, color:"#dc2626", fontWeight:600 }}>{result.alerta_critico}</div>
            </div>
          )}

          {/* Ranking de prioridade */}
          <div>
            <div style={{ fontWeight:700, fontSize:14, color:"#0f172a", marginBottom:12 }}>Ordem de Prioridade</div>
            <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
              {result.prioridade?.map((item, i) => {
                const conta = contasPagar.find(c => c.id === item.id || String(c.id) === String(item.id));
                const noCabeSaldo = result.contas_no_saldo?.includes(item.id) || result.contas_no_saldo?.includes(String(item.id));
                return (
                  <div key={i} style={{ background:urgenciaBg(item.urgencia), border:`1px solid ${urgenciaCor(item.urgencia)}33`, borderRadius:12, padding:"14px 16px" }}>
                    <div style={{ display:"flex", alignItems:"flex-start", gap:12 }}>
                      <div style={{ width:36, height:36, borderRadius:10, background:urgenciaCor(item.urgencia), color:"#fff", display:"flex", alignItems:"center", justifyContent:"center", fontWeight:800, fontSize:16, flexShrink:0 }}>
                        {item.posicao}
                      </div>
                      <div style={{ flex:1 }}>
                        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:6 }}>
                          <div>
                            <div style={{ fontWeight:700, fontSize:14, color:"#0f172a" }}>{conta?.descricao || `Conta #${item.id}`}</div>
                            <span style={{ fontSize:11, fontWeight:600, color:urgenciaCor(item.urgencia), background:urgenciaBg(item.urgencia), padding:"2px 8px", borderRadius:20, border:`1px solid ${urgenciaCor(item.urgencia)}44` }}>
                              {urgenciaLabel(item.urgencia)}
                            </span>
                          </div>
                          <div style={{ textAlign:"right" }}>
                            {conta?.valor && <div style={{ fontSize:15, fontWeight:800, color:"#0f172a" }}>R$ {parseFloat(conta.valor).toFixed(2).replace(".",",")}</div>}
                            {item.economia_se_pagar_hoje > 0 && (
                              <div style={{ fontSize:11, color:"#15803d", fontWeight:600 }}>Economiza R$ {item.economia_se_pagar_hoje.toFixed(2).replace(".",",")} pagando hoje</div>
                            )}
                          </div>
                        </div>
                        <div style={{ fontSize:13, color:"#475569", lineHeight:1.5, marginBottom:8 }}>{item.razao}</div>
                        <div style={{ display:"flex", gap:8 }}>
                          {item.pagar_hoje && (
                            <span style={{ fontSize:11, background:"#dc2626", color:"#fff", padding:"3px 10px", borderRadius:20, fontWeight:700 }}>⚡ Pagar hoje</span>
                          )}
                          {noCabeSaldo && parseFloat(saldo) > 0 && (
                            <span style={{ fontSize:11, background:"#15803d", color:"#fff", padding:"3px 10px", borderRadius:20, fontWeight:600 }}>✓ Cabe no saldo</span>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Resumo financeiro */}
          {result.total_se_pagar_prioritarias > 0 && (
            <div style={{ background:"#f8fafc", border:"1px solid #e2e8f0", borderRadius:12, padding:"14px 18px" }}>
              <div style={{ display:"flex", justifyContent:"space-between" }}>
                <span style={{ fontSize:13, color:"#64748b" }}>Total das prioritárias:</span>
                <span style={{ fontSize:14, fontWeight:700, color:"#0f172a" }}>R$ {result.total_se_pagar_prioritarias.toFixed(2).replace(".",",")}</span>
              </div>
              {parseFloat(saldo) > 0 && (
                <div style={{ display:"flex", justifyContent:"space-between", marginTop:6 }}>
                  <span style={{ fontSize:13, color:"#64748b" }}>Saldo após pagamento:</span>
                  <span style={{ fontSize:14, fontWeight:700, color:parseFloat(saldo)-result.total_se_pagar_prioritarias>=0?"#15803d":"#dc2626" }}>
                    R$ {(parseFloat(saldo)-result.total_se_pagar_prioritarias).toFixed(2).replace(".",",")}
                  </span>
                </div>
              )}
            </div>
          )}

          {/* Recomendação final */}
          <div style={{ background:"#fffbeb", border:"1px solid #fde68a", borderRadius:12, padding:"14px 18px" }}>
            <div style={{ fontSize:11, color:"#92400e", fontWeight:700, textTransform:"uppercase", marginBottom:6 }}>✦ Recomendação Final</div>
            <div style={{ fontSize:13, color:"#1c1917", lineHeight:1.6 }}>{result.recomendacao_final}</div>
          </div>

          <button onClick={() => { setState("idle"); setResult(null); }}
            style={{ background:"#f8fafc", border:"1px solid #e2e8f0", color:"#64748b", fontWeight:600, padding:"10px", borderRadius:10, cursor:"pointer", fontSize:13 }}>
            Nova Análise
          </button>
        </div>
      )}
    </div>
  );
}


// ════════════════════════════════════════════════════════════
//  FINANCEIRO COMPLETO
// ════════════════════════════════════════════════════════════

function saveLS(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch {} }

function fmtDate(dateStr) {
  if (!dateStr) return "—";
  const [y, m, d] = dateStr.split("-");
  return `${d}/${m}/${y}`;
}

function getDaysUntil(dateStr) {
  if (!dateStr) return null;
  const today = new Date(); today.setHours(0,0,0,0);
  const due = new Date(dateStr + "T00:00:00");
  return Math.round((due - today) / 86400000);
}

// ── Modal de Conta Bancária ──────────────────────────────────
function ModalContaBancaria({ conta, onSave, onClose }) {
  const [form, setForm] = useState(conta || { id: Date.now(), nome: "", tipo: "Conta Corrente", banco: "", saldoInicial: "0", cor: "#0891b2" });
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const TIPOS = ["Caixa", "Conta Corrente", "Conta Poupança", "Conta PJ", "Mercado Pago", "Outro"];
  const CORES = ["#0891b2","#15803d","#7c3aed","#d97706","#dc2626","#0f172a","#64748b"];
  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(15,23,42,.6)", backdropFilter:"blur(4px)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:500, padding:24 }}>
      <div style={{ background:"#fff", borderRadius:16, width:"100%", maxWidth:440, padding:"28px 32px", boxShadow:"0 20px 60px rgba(0,0,0,.15)" }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:20 }}>
          <div style={{ fontWeight:800, fontSize:17, color:"#0f172a" }}>{conta ? "Editar Conta" : "Nova Conta"}</div>
          <button onClick={onClose} style={{ background:"#f1f5f9", border:"none", color:"#64748b", width:32, height:32, borderRadius:8, cursor:"pointer", fontSize:16 }}>✕</button>
        </div>
        <div style={{ display:"flex", flexDirection:"column", gap:12, marginBottom:16 }}>
          <div>
            <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Nome da conta *</div>
            <input value={form.nome} onChange={e => set("nome", e.target.value)} placeholder="Ex: Mercado Pago Filial SP"
              style={{ width:"100%", background:"#f8fafc", border:"1px solid #e2e8f0", color:"#0f172a", padding:"9px 12px", borderRadius:8, fontSize:13, outline:"none" }} />
          </div>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
            <div>
              <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Tipo</div>
              <select value={form.tipo} onChange={e => set("tipo", e.target.value)}
                style={{ width:"100%", background:"#f8fafc", border:"1px solid #e2e8f0", color:"#334155", padding:"9px 12px", borderRadius:8, fontSize:13 }}>
                {TIPOS.map(t => <option key={t}>{t}</option>)}
              </select>
            </div>
            <div>
              <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Banco/Instituição</div>
              <input value={form.banco} onChange={e => set("banco", e.target.value)} placeholder="Ex: Itaú, Nubank..."
                style={{ width:"100%", background:"#f8fafc", border:"1px solid #e2e8f0", color:"#0f172a", padding:"9px 12px", borderRadius:8, fontSize:13, outline:"none" }} />
            </div>
          </div>
          <div>
            <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Saldo inicial (R$)</div>
            <input type="number" value={form.saldoInicial} onChange={e => set("saldoInicial", e.target.value)} placeholder="0,00"
              style={{ width:"100%", background:"#f8fafc", border:"1px solid #e2e8f0", color:"#0f172a", padding:"9px 12px", borderRadius:8, fontSize:13, outline:"none" }} />
          </div>
          <div>
            <div style={{ fontSize:11, color:"#94a3b8", marginBottom:8, fontWeight:600, textTransform:"uppercase" }}>Cor</div>
            <div style={{ display:"flex", gap:8 }}>
              {CORES.map(c => (
                <button key={c} onClick={() => set("cor", c)}
                  style={{ width:28, height:28, borderRadius:8, background:c, border:form.cor===c?"3px solid #0f172a":"2px solid transparent", cursor:"pointer" }} />
              ))}
            </div>
          </div>
        </div>
        <div style={{ display:"flex", gap:8 }}>
          <button onClick={onClose} style={{ flex:1, background:"#f8fafc", border:"1px solid #e2e8f0", color:"#64748b", fontWeight:600, padding:"11px", borderRadius:10, cursor:"pointer" }}>Cancelar</button>
          <button onClick={() => { if (!form.nome) return; onSave(form); onClose(); }} disabled={!form.nome}
            style={{ flex:2, background:!form.nome?"#f1f5f9":"#0f172a", border:"none", color:!form.nome?"#94a3b8":"#fff", fontWeight:700, padding:"11px", borderRadius:10, cursor:!form.nome?"not-allowed":"pointer" }}>
            Salvar
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Modal de Baixa de Pagamento ──────────────────────────────
function ModalBaixa({ conta, contasBancarias, onConfirm, onClose }) {
  const [contaBancariaId, setContaBancariaId] = useState(contasBancarias[0]?.id || "");
  const [dataPagamento, setDataPagamento] = useState(new Date().toLocaleDateString("sv-SE"));
  const [obs, setObs] = useState("");
  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(15,23,42,.6)", backdropFilter:"blur(4px)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:500, padding:24 }}>
      <div style={{ background:"#fff", borderRadius:16, width:"100%", maxWidth:400, padding:"28px 32px", boxShadow:"0 20px 60px rgba(0,0,0,.15)" }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:16 }}>
          <div style={{ fontWeight:800, fontSize:17, color:"#0f172a" }}>Dar Baixa</div>
          <button onClick={onClose} style={{ background:"#f1f5f9", border:"none", color:"#64748b", width:32, height:32, borderRadius:8, cursor:"pointer", fontSize:16 }}>✕</button>
        </div>
        <div style={{ background:"#f8fafc", borderRadius:10, padding:"12px 16px", marginBottom:16 }}>
          <div style={{ fontSize:12, color:"#94a3b8", marginBottom:2 }}>Conta a pagar</div>
          <div style={{ fontSize:14, fontWeight:700, color:"#0f172a" }}>{conta.descricao}</div>
          <div style={{ fontSize:16, fontWeight:800, color:"#dc2626", marginTop:4 }}>{`R$ ${parseFloat(conta.valor||0).toFixed(2).replace(".",",")}`}</div>
        </div>
        <div style={{ display:"flex", flexDirection:"column", gap:12, marginBottom:16 }}>
          <div>
            <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Pagar com qual conta *</div>
            {contasBancarias.length === 0 ? (
              <div style={{ color:"#dc2626", fontSize:13 }}>⚠ Cadastre uma conta bancária primeiro</div>
            ) : (
              <select value={contaBancariaId} onChange={e => setContaBancariaId(e.target.value)}
                style={{ width:"100%", background:"#f8fafc", border:"1px solid #e2e8f0", color:"#334155", padding:"9px 12px", borderRadius:8, fontSize:13 }}>
                {contasBancarias.map(c => <option key={c.id} value={c.id}>{c.nome}</option>)}
              </select>
            )}
          </div>
          <div>
            <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Data do pagamento</div>
            <input type="date" value={dataPagamento} onChange={e => setDataPagamento(e.target.value)}
              style={{ width:"100%", background:"#f8fafc", border:"1px solid #e2e8f0", color:"#334155", padding:"9px 12px", borderRadius:8, fontSize:13 }} />
          </div>
          <div>
            <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Observação</div>
            <input value={obs} onChange={e => setObs(e.target.value)} placeholder="Opcional"
              style={{ width:"100%", background:"#f8fafc", border:"1px solid #e2e8f0", color:"#0f172a", padding:"9px 12px", borderRadius:8, fontSize:13, outline:"none" }} />
          </div>
        </div>
        <div style={{ display:"flex", gap:8 }}>
          <button onClick={onClose} style={{ flex:1, background:"#f8fafc", border:"1px solid #e2e8f0", color:"#64748b", fontWeight:600, padding:"11px", borderRadius:10, cursor:"pointer" }}>Cancelar</button>
          <button onClick={() => { if (!contaBancariaId || !dataPagamento) return; onConfirm({ contaBancariaId, dataPagamento, obs }); onClose(); }}
            disabled={!contaBancariaId || contasBancarias.length === 0}
            style={{ flex:2, background:contaBancariaId&&contasBancarias.length>0?"#15803d":"#f1f5f9", border:"none", color:contaBancariaId&&contasBancarias.length>0?"#fff":"#94a3b8", fontWeight:700, padding:"11px", borderRadius:10, cursor:contaBancariaId&&contasBancarias.length>0?"pointer":"not-allowed" }}>
            ✓ Confirmar Pagamento
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Modal de Baixa de Recebimento ML ────────────────────────
function ModalBaixaML({ order, paymentInfo, contasBancarias, onConfirm, onClose }) {
  const mpConta = contasBancarias.find(c => c.nome.toLowerCase().includes("mercado pago"));
  const [contaBancariaId, setContaBancariaId] = useState(mpConta?.id || contasBancarias[0]?.id || "");
  const [dataRecebimento, setDataRecebimento] = useState(paymentInfo?.releaseDate || new Date().toLocaleDateString("sv-SE"));
  const valor = paymentInfo?.netAmount || order.price * order.qty;
  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(15,23,42,.6)", backdropFilter:"blur(4px)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:500, padding:24 }}>
      <div style={{ background:"#fff", borderRadius:16, width:"100%", maxWidth:400, padding:"28px 32px", boxShadow:"0 20px 60px rgba(0,0,0,.15)" }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:16 }}>
          <div style={{ fontWeight:800, fontSize:17, color:"#0f172a" }}>Registrar Recebimento</div>
          <button onClick={onClose} style={{ background:"#f1f5f9", border:"none", color:"#64748b", width:32, height:32, borderRadius:8, cursor:"pointer", fontSize:16 }}>✕</button>
        </div>
        <div style={{ background:"#f0fdf4", borderRadius:10, padding:"12px 16px", marginBottom:16 }}>
          <div style={{ fontSize:12, color:"#94a3b8", marginBottom:2 }}>Pedido #{order.id}</div>
          <div style={{ fontSize:13, color:"#0f172a", marginBottom:4, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{order.title||"—"}</div>
          <div style={{ fontSize:16, fontWeight:800, color:"#15803d" }}>{`R$ ${valor.toFixed(2).replace(".",",")}`} <span style={{ fontSize:11, fontWeight:400, color:"#94a3b8" }}>líquido</span></div>
        </div>
        <div style={{ display:"flex", flexDirection:"column", gap:12, marginBottom:16 }}>
          <div>
            <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Registrar na conta *</div>
            {contasBancarias.length === 0 ? (
              <div style={{ color:"#dc2626", fontSize:13 }}>⚠ Cadastre uma conta bancária primeiro</div>
            ) : (
              <select value={contaBancariaId} onChange={e => setContaBancariaId(e.target.value)}
                style={{ width:"100%", background:"#f8fafc", border:"1px solid #e2e8f0", color:"#334155", padding:"9px 12px", borderRadius:8, fontSize:13 }}>
                {contasBancarias.map(c => <option key={c.id} value={c.id}>{c.nome}</option>)}
              </select>
            )}
          </div>
          <div>
            <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Data do recebimento</div>
            <input type="date" value={dataRecebimento} onChange={e => setDataRecebimento(e.target.value)}
              style={{ width:"100%", background:"#f8fafc", border:"1px solid #e2e8f0", color:"#334155", padding:"9px 12px", borderRadius:8, fontSize:13 }} />
          </div>
        </div>
        <div style={{ display:"flex", gap:8 }}>
          <button onClick={onClose} style={{ flex:1, background:"#f8fafc", border:"1px solid #e2e8f0", color:"#64748b", fontWeight:600, padding:"11px", borderRadius:10, cursor:"pointer" }}>Cancelar</button>
          <button onClick={() => { if (!contaBancariaId) return; onConfirm({ contaBancariaId, dataRecebimento, valor }); onClose(); }}
            disabled={!contaBancariaId || contasBancarias.length === 0}
            style={{ flex:2, background:contaBancariaId&&contasBancarias.length>0?"#15803d":"#f1f5f9", border:"none", color:contaBancariaId&&contasBancarias.length>0?"#fff":"#94a3b8", fontWeight:700, padding:"11px", borderRadius:10, cursor:contaBancariaId&&contasBancarias.length>0?"pointer":"not-allowed" }}>
            ✓ Confirmar Recebimento
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Modal de Conta a Pagar ───────────────────────────────────
function ModalConta({ conta, categoriasPagar, fornecedores, onSave, onClose }) {
  const [form, setForm] = useState(conta || {
    id: Date.now(), descricao: "", fornecedorId: "", fornecedorNome: "", fornecedorCNPJ: "", categoria: categoriasPagar[0] || "Outros", recorrencia: "unica", totalParcelas: "", intervaloParcelas: "mensal",
    valor: "", vencimento: "", status: "Pendente", observacao: ""
  });
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const [sugestoes, setSugestoes] = useState([]);
  const [showSugestoes, setShowSugestoes] = useState(false);

  function onDescricaoChange(val) {
    set("descricao", val);
    if (val.length >= 2 && fornecedores?.length > 0) {
      const q = val.toLowerCase();
      const found = fornecedores.filter(f =>
        f.nome?.toLowerCase().includes(q) ||
        f.cnpj?.includes(q)
      ).slice(0, 6);
      setSugestoes(found);
      setShowSugestoes(found.length > 0);
    } else {
      setShowSugestoes(false);
    }
  }

  function selecionarFornecedor(forn) {
    setForm(f => ({
      ...f,
      descricao: forn.nome,
      fornecedorId: forn.id,
      fornecedorNome: forn.nome,
      fornecedorCNPJ: forn.cnpj || "",
    }));
    setShowSugestoes(false);
  }
  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(15,23,42,.6)", backdropFilter:"blur(4px)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:400, padding:24 }}>
      <div style={{ background:"#fff", borderRadius:16, width:"100%", maxWidth:500, padding:"28px 32px", boxShadow:"0 20px 60px rgba(0,0,0,.15)" }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:20 }}>
          <div style={{ fontWeight:800, fontSize:17, color:"#0f172a" }}>{conta ? "Editar Conta" : "Nova Conta a Pagar"}</div>
          <button onClick={onClose} style={{ background:"#f1f5f9", border:"none", color:"#64748b", width:32, height:32, borderRadius:8, cursor:"pointer", fontSize:16 }}>✕</button>
        </div>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12, marginBottom:16 }}>
          <div style={{ gridColumn:"1/-1", position:"relative" }}>
            <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Descrição / Fornecedor *</div>
            <input
              value={form.descricao}
              onChange={e => onDescricaoChange(e.target.value)}
              onBlur={() => setTimeout(() => setShowSugestoes(false), 150)}
              onFocus={() => form.descricao.length >= 2 && sugestoes.length > 0 && setShowSugestoes(true)}
              placeholder="Digite o nome do fornecedor ou descrição..."
              style={{ width:"100%", background:"#f8fafc", border:"1px solid #e2e8f0", color:"#0f172a", padding:"9px 12px", borderRadius:8, fontSize:13, outline:"none" }} />
            {/* Autocomplete dropdown */}
            {showSugestoes && sugestoes.length > 0 && (
              <div style={{ position:"absolute", top:"100%", left:0, right:0, background:"#fff", border:"1px solid #e2e8f0", borderRadius:10, boxShadow:"0 8px 24px rgba(0,0,0,.12)", zIndex:500, overflow:"hidden", marginTop:2 }}>
                {sugestoes.map(f => (
                  <button key={f.id} onMouseDown={() => selecionarFornecedor(f)}
                    style={{ width:"100%", background:"none", border:"none", padding:"10px 14px", textAlign:"left", cursor:"pointer", display:"flex", justifyContent:"space-between", alignItems:"center" }}
                    onMouseEnter={e=>e.currentTarget.style.background="#f0f9ff"}
                    onMouseLeave={e=>e.currentTarget.style.background="none"}>
                    <div>
                      <div style={{ fontSize:13, fontWeight:600, color:"#0f172a" }}>{f.nome}</div>
                      {f.cnpj && <div style={{ fontSize:11, color:"#94a3b8" }}>{f.cnpj}</div>}
                    </div>
                    <div style={{ fontSize:11, color:"#0891b2", fontWeight:600 }}>Fornecedor →</div>
                  </button>
                ))}
                <div style={{ padding:"6px 14px", background:"#f8fafc", borderTop:"1px solid #f1f5f9", fontSize:11, color:"#94a3b8" }}>
                  {sugestoes.length} fornecedor(es) encontrado(s)
                </div>
              </div>
            )}
            {/* Badge do fornecedor selecionado */}
            {form.fornecedorId && (
              <div style={{ display:"flex", alignItems:"center", gap:6, marginTop:6 }}>
                <span style={{ fontSize:11, background:"#eff6ff", color:"#1d4ed8", border:"1px solid #bfdbfe", padding:"2px 8px", borderRadius:20, fontWeight:600 }}>
                  🏭 {form.fornecedorNome}
                </span>
                {form.fornecedorCNPJ && <span style={{ fontSize:11, color:"#94a3b8" }}>{form.fornecedorCNPJ}</span>}
                <button onClick={() => setForm(f=>({...f,fornecedorId:"",fornecedorNome:"",fornecedorCNPJ:""}))}
                  style={{ background:"none", border:"none", color:"#94a3b8", cursor:"pointer", fontSize:12 }}>✕</button>
              </div>
            )}
          </div>
          <div>
            <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Categoria</div>
            <select value={form.categoria} onChange={e => set("categoria", e.target.value)}
              style={{ width:"100%", background:"#f8fafc", border:"1px solid #e2e8f0", color:"#334155", padding:"9px 12px", borderRadius:8, fontSize:13 }}>
              {categoriasPagar.map(c => <option key={c}>{c}</option>)}
            </select>
          </div>
          <div>
            <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Valor (R$) *</div>
            <input type="number" value={form.valor} onChange={e => set("valor", e.target.value)} placeholder="0,00"
              style={{ width:"100%", background:"#f8fafc", border:"1px solid #e2e8f0", color:"#0f172a", padding:"9px 12px", borderRadius:8, fontSize:13, outline:"none" }} />
          </div>
          <div>
            <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Vencimento</div>
            <input type="date" value={form.vencimento} onChange={e => set("vencimento", e.target.value)}
              style={{ width:"100%", background:"#f8fafc", border:"1px solid #e2e8f0", color:"#334155", padding:"9px 12px", borderRadius:8, fontSize:13 }} />
          </div>
          {/* Recorrência */}
          <div style={{ gridColumn:"1/-1" }}>
            <div style={{ fontSize:11, color:"#94a3b8", marginBottom:8, fontWeight:600, textTransform:"uppercase" }}>Tipo de Ocorrência</div>
            <div style={{ display:"flex", flexWrap:"wrap", gap:6 }}>
              {[
                { key:"unica",       label:"Única" },
                { key:"parcelada",   label:"Parcelada" },
                { key:"semanal",     label:"Semanal" },
                { key:"quinzenal",   label:"Quinzenal" },
                { key:"mensal",      label:"Mensal" },
                { key:"bimestral",   label:"Bimestral" },
                { key:"trimestral",  label:"Trimestral" },
                { key:"semestral",   label:"Semestral" },
                { key:"anual",       label:"Anual" },
              ].map(o => (
                <button key={o.key} onClick={() => set("recorrencia", o.key)}
                  style={{ padding:"6px 14px", borderRadius:20, border:"none", cursor:"pointer", fontSize:12, fontWeight:600,
                    background:(form.recorrencia||"unica")===o.key?"#0f172a":"#f1f5f9",
                    color:(form.recorrencia||"unica")===o.key?"#fff":"#64748b" }}>
                  {o.label}
                </button>
              ))}
            </div>
          </div>

          {/* Parcelamento */}
          {(form.recorrencia === "parcelada") && (
            <div style={{ gridColumn:"1/-1", background:"#f8fafc", border:"1px solid #e2e8f0", borderRadius:10, padding:"12px 14px" }}>
              <div style={{ fontSize:11, color:"#94a3b8", marginBottom:10, fontWeight:600, textTransform:"uppercase" }}>Configuração do Parcelamento</div>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
                <div>
                  <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Número de parcelas</div>
                  <input type="number" min="2" max="60" value={form.totalParcelas||""} onChange={e=>set("totalParcelas",e.target.value)} placeholder="Ex: 12"
                    style={{ width:"100%", background:"#fff", border:"1px solid #e2e8f0", color:"#0f172a", padding:"9px 12px", borderRadius:8, fontSize:13, outline:"none" }} />
                </div>
                <div>
                  <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Intervalo entre parcelas</div>
                  <select value={form.intervaloParcelas||"mensal"} onChange={e=>set("intervaloParcelas",e.target.value)}
                    style={{ width:"100%", background:"#fff", border:"1px solid #e2e8f0", color:"#334155", padding:"9px 12px", borderRadius:8, fontSize:13 }}>
                    <option value="semanal">Semanal (7 dias)</option>
                    <option value="quinzenal">Quinzenal (15 dias)</option>
                    <option value="mensal">Mensal (30 dias)</option>
                    <option value="bimestral">Bimestral (60 dias)</option>
                    <option value="trimestral">Trimestral (90 dias)</option>
                  </select>
                </div>
              </div>
              {form.totalParcelas && form.valor && form.vencimento && (
                <div style={{ marginTop:10, background:"#eff6ff", borderRadius:8, padding:"8px 12px", fontSize:12, color:"#1d4ed8" }}>
                  💡 Serão geradas <strong>{form.totalParcelas} parcelas</strong> de <strong>R$ {(parseFloat(form.valor)/parseInt(form.totalParcelas)).toFixed(2).replace(".",",")}</strong> cada
                </div>
              )}
            </div>
          )}

          {/* Info de recorrência */}
          {form.recorrencia && form.recorrencia !== "unica" && form.recorrencia !== "parcelada" && form.vencimento && (
            <div style={{ gridColumn:"1/-1", background:"#f0fdf4", border:"1px solid #bbf7d0", borderRadius:8, padding:"8px 12px", fontSize:12, color:"#15803d" }}>
              🔄 Esta conta se repetirá automaticamente — a próxima será criada ao dar baixa nesta.
            </div>
          )}

          <div style={{ gridColumn:"1/-1" }}>
            <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Observação</div>
            <input value={form.observacao} onChange={e => set("observacao", e.target.value)} placeholder="Opcional"
              style={{ width:"100%", background:"#f8fafc", border:"1px solid #e2e8f0", color:"#0f172a", padding:"9px 12px", borderRadius:8, fontSize:13, outline:"none" }} />
          </div>
          <div style={{ gridColumn:"1/-1", background:"#f8fafc", borderRadius:10, padding:"12px 14px" }}>
            <div style={{ fontSize:11, color:"#94a3b8", marginBottom:10, fontWeight:700, textTransform:"uppercase" }}>💰 Juros e Multa (para análise IA)</div>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
              {/* Multa */}
              <div>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:5 }}>
                  <div style={{ fontSize:11, color:"#94a3b8", fontWeight:600, textTransform:"uppercase" }}>Multa por atraso</div>
                  <div style={{ display:"flex", gap:2 }}>
                    {["%","R$"].map(t => (
                      <button key={t} onClick={() => set("multaTipo", t)}
                        style={{ padding:"2px 8px", borderRadius:5, border:"none", cursor:"pointer", fontSize:11, fontWeight:700,
                          background:(form.multaTipo||"%")===t?"#0f172a":"#e2e8f0",
                          color:(form.multaTipo||"%")===t?"#fff":"#64748b" }}>
                        {t}
                      </button>
                    ))}
                  </div>
                </div>
                <div style={{ position:"relative" }}>
                  <input type="number" value={form.multaPct||""} onChange={e => set("multaPct", e.target.value)}
                    placeholder={(form.multaTipo||"%")==="%" ? "Ex: 2" : "Ex: 50,00"}
                    style={{ width:"100%", background:"#fff", border:"1px solid #e2e8f0", color:"#0f172a", padding:"9px 12px 9px 32px", borderRadius:8, fontSize:13, outline:"none" }} />
                  <span style={{ position:"absolute", left:10, top:"50%", transform:"translateY(-50%)", fontSize:12, color:"#94a3b8", fontWeight:700 }}>
                    {(form.multaTipo||"%")==="%" ? "%" : "R$"}
                  </span>
                </div>
                {form.multaPct && form.valor && (
                  <div style={{ fontSize:10, color:"#64748b", marginTop:4 }}>
                    {(form.multaTipo||"%")==="%" 
                      ? `= R$ ${(parseFloat(form.valor||0)*parseFloat(form.multaPct||0)/100).toFixed(2).replace(".",",")} de multa`
                      : `= ${(parseFloat(form.multaPct||0)/parseFloat(form.valor||1)*100).toFixed(2)}% do valor`}
                  </div>
                )}
              </div>
              {/* Juros */}
              <div>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:5 }}>
                  <div style={{ fontSize:11, color:"#94a3b8", fontWeight:600, textTransform:"uppercase" }}>Juros ao dia</div>
                  <div style={{ display:"flex", gap:2 }}>
                    {["%","R$"].map(t => (
                      <button key={t} onClick={() => set("jurosTipo", t)}
                        style={{ padding:"2px 8px", borderRadius:5, border:"none", cursor:"pointer", fontSize:11, fontWeight:700,
                          background:(form.jurosTipo||"%")===t?"#0f172a":"#e2e8f0",
                          color:(form.jurosTipo||"%")===t?"#fff":"#64748b" }}>
                        {t}
                      </button>
                    ))}
                  </div>
                </div>
                <div style={{ position:"relative" }}>
                  <input type="number" value={form.jurosDia||""} onChange={e => set("jurosDia", e.target.value)}
                    placeholder={(form.jurosTipo||"%")==="%" ? "Ex: 0.033" : "Ex: 5,00"}
                    style={{ width:"100%", background:"#fff", border:"1px solid #e2e8f0", color:"#0f172a", padding:"9px 12px 9px 32px", borderRadius:8, fontSize:13, outline:"none" }} />
                  <span style={{ position:"absolute", left:10, top:"50%", transform:"translateY(-50%)", fontSize:12, color:"#94a3b8", fontWeight:700 }}>
                    {(form.jurosTipo||"%")==="%" ? "%" : "R$"}
                  </span>
                </div>
                {form.jurosDia && form.valor && (
                  <div style={{ fontSize:10, color:"#64748b", marginTop:4 }}>
                    {(form.jurosTipo||"%")==="%" 
                      ? `= R$ ${(parseFloat(form.valor||0)*parseFloat(form.jurosDia||0)/100).toFixed(2).replace(".",",")} por dia`
                      : `= ${(parseFloat(form.jurosDia||0)/parseFloat(form.valor||1)*100).toFixed(4)}% ao dia`}
                  </div>
                )}
              </div>
            </div>
          </div>
          <div style={{ gridColumn:"1/-1", background: form.temProtesto ? "#fef2f2" : "#f8fafc", border: `1px solid ${form.temProtesto ? "#fecaca" : "#e2e8f0"}`, borderRadius:10, padding:"12px 14px", transition:"all .2s" }}>
            <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom: form.temProtesto ? 12 : 0 }}>
              <div>
                <div style={{ fontSize:11, color: form.temProtesto ? "#dc2626" : "#94a3b8", marginBottom:2, fontWeight:700, textTransform:"uppercase" }}>⚖️ Protesto</div>
                <div style={{ fontSize:11, color:"#94a3b8" }}>Será protestada caso não paga no vencimento</div>
              </div>
              <label style={{ display:"flex", alignItems:"center", gap:8, cursor:"pointer" }}>
                <div style={{ position:"relative", width:44, height:24 }}>
                  <input type="checkbox" checked={form.temProtesto||false} onChange={e => set("temProtesto", e.target.checked)}
                    style={{ opacity:0, width:0, height:0, position:"absolute" }} />
                  <div style={{ position:"absolute", inset:0, background:form.temProtesto?"#dc2626":"#cbd5e1", borderRadius:99, transition:"all .2s", cursor:"pointer" }}
                    onClick={() => set("temProtesto", !form.temProtesto)} />
                  <div style={{ position:"absolute", top:2, left: form.temProtesto ? 22 : 2, width:20, height:20, background:"#fff", borderRadius:"50%", transition:"all .2s", boxShadow:"0 1px 3px rgba(0,0,0,.2)" }} />
                </div>
                <span style={{ fontSize:13, fontWeight:600, color: form.temProtesto ? "#dc2626" : "#94a3b8" }}>
                  {form.temProtesto ? "Sim, será protestada" : "Não"}
                </span>
              </label>
            </div>
            {form.temProtesto && (
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginTop:4 }}>
                <div>
                  <div style={{ fontSize:11, color:"#dc2626", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Dias após vencimento para protesto</div>
                  <input type="number" value={form.diasProtesto||""} onChange={e => set("diasProtesto", e.target.value)} placeholder="Ex: 5"
                    style={{ width:"100%", background:"#fff", border:"1px solid #fecaca", color:"#0f172a", padding:"9px 12px", borderRadius:8, fontSize:13, outline:"none" }} />
                  <div style={{ fontSize:10, color:"#94a3b8", marginTop:4 }}>
                    {form.vencimento && form.diasProtesto ? (() => {
                      const d = new Date(form.vencimento + "T00:00:00");
                      d.setDate(d.getDate() + parseInt(form.diasProtesto || 0));
                      return `Protesto em: ${d.toLocaleDateString("pt-BR")}`;
                    })() : "Informe o vencimento e os dias"}
                  </div>
                </div>
                <div>
                  <div style={{ fontSize:11, color:"#dc2626", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Cartório / Observação</div>
                  <input value={form.cartorio||""} onChange={e => set("cartorio", e.target.value)} placeholder="Ex: 1º Cartório de Protesto SP"
                    style={{ width:"100%", background:"#fff", border:"1px solid #fecaca", color:"#0f172a", padding:"9px 12px", borderRadius:8, fontSize:13, outline:"none" }} />
                </div>
              </div>
            )}
          </div>

          {/* ── ANEXOS ── */}
          <div style={{ gridColumn:"1/-1" }}>
            <div style={{ fontSize:11, color:"#94a3b8", marginBottom:8, fontWeight:600, textTransform:"uppercase" }}>📎 Anexos</div>
            <label style={{ display:"block", border:"2px dashed #e2e8f0", borderRadius:10, padding:"12px", textAlign:"center", cursor:"pointer", background:"#f8fafc", marginBottom:8 }}>
              <input type="file" multiple accept=".pdf,.jpg,.jpeg,.png,.webp,.xml,.xlsx,.xls,.doc,.docx" style={{ display:"none" }}
                onChange={async e => {
                  const files = Array.from(e.target.files);
                  const converted = await Promise.all(files.map(f => new Promise((res) => {
                    const reader = new FileReader();
                    reader.onload = ev => res({ nome: f.name, tipo: f.type, tamanho: f.size, base64: ev.target.result });
                    reader.readAsDataURL(f);
                  })));
                  set("anexos", [...(form.anexos||[]), ...converted].slice(0,5));
                  e.target.value = "";
                }} />
              <div style={{ fontSize:13, color:"#64748b" }}>📎 Clique para anexar arquivos</div>
              <div style={{ fontSize:11, color:"#94a3b8", marginTop:2 }}>PDF, imagens, XML, Word, Excel — máx. 5 arquivos</div>
            </label>
            {(form.anexos||[]).length > 0 && (
              <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
                {(form.anexos||[]).map((a, i) => {
                  const isImg = a.tipo && a.tipo.startsWith("image/");
                  const icon = isImg ? "🖼️" : a.tipo === "application/pdf" ? "📄" : "📎";
                  return (
                    <div key={i} style={{ display:"flex", alignItems:"center", gap:10, background:"#f8fafc", border:"1px solid #e2e8f0", borderRadius:8, padding:"8px 12px" }}>
                      <span style={{ fontSize:18 }}>{icon}</span>
                      <div style={{ flex:1, minWidth:0 }}>
                        <div style={{ fontSize:12, fontWeight:600, color:"#0f172a", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{a.nome}</div>
                        <div style={{ fontSize:10, color:"#94a3b8" }}>{(a.tamanho/1024).toFixed(1)} KB</div>
                      </div>
                      {isImg && <img src={a.base64} alt={a.nome} style={{ width:36, height:36, objectFit:"cover", borderRadius:6, border:"1px solid #e2e8f0", flexShrink:0 }} />}
                      <a href={a.base64} download={a.nome}
                        style={{ background:"#f1f5f9", border:"1px solid #e2e8f0", color:"#64748b", width:26, height:26, borderRadius:6, fontSize:13, display:"flex", alignItems:"center", justifyContent:"center", textDecoration:"none", flexShrink:0 }}>⬇</a>
                      <button onClick={() => { const idx2=i; set("anexos", (form.anexos||[]).filter((_,j)=>j!==idx2)); }}
                        style={{ background:"#fef2f2", border:"none", color:"#dc2626", width:26, height:26, borderRadius:6, cursor:"pointer", fontSize:11, flexShrink:0 }}>✕</button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
        <div style={{ display:"flex", gap:8 }}>
          <button onClick={onClose} style={{ flex:1, background:"#f8fafc", border:"1px solid #e2e8f0", color:"#64748b", fontWeight:600, padding:"11px", borderRadius:10, cursor:"pointer" }}>Cancelar</button>
          <button onClick={() => { if (!form.descricao || !form.valor) return; onSave(form); onClose(); }}
            disabled={!form.descricao || !form.valor}
            style={{ flex:2, background:!form.descricao||!form.valor?"#f1f5f9":"#0f172a", border:"none", color:!form.descricao||!form.valor?"#94a3b8":"#fff", fontWeight:700, padding:"11px", borderRadius:10, cursor:!form.descricao||!form.valor?"not-allowed":"pointer" }}>
            Salvar
          </button>
        </div>
      </div>
    </div>
    </div>
  </div>
  );
}

function FinanceiroTab({ contasPagar, setContasPagar, contasBancarias, setContasBancarias, categoriasPagar, setCategoriasPagar, lancamentos, setLancamentos, enrichedOrders, rawOrders, shipmentStatuses, paymentData, finTab, setFinTab, impostos, setImpostos, custosFixos, setCustosFixos, fornecedores }) {
  const [showModalConta, setShowModalConta] = useState(false);
  const [showModalBancaria, setShowModalBancaria] = useState(false);
  const [editingConta, setEditingConta] = useState(null);
  const [editingBancaria, setEditingBancaria] = useState(null);
  const [modalBaixa, setModalBaixa] = useState(null); // conta a pagar para dar baixa
  const [modalBaixaML, setModalBaixaML] = useState(null); // pedido ML para registrar
  const [searchReceber, setSearchReceber] = useState("");
  const [receberDe, setReceberDe] = useState("");
  const [receberAte, setReceberAte] = useState("");
  const [pagarDe, setPagarDe] = useState("");
  const [pagarAte, setPagarAte] = useState("");
  const [filterStatus, setFilterStatus] = useState("all");
  const [filterCat, setFilterCat] = useState("all");
  const [searchPagar, setSearchPagar] = useState("");
  const [novaCat, setNovaCat] = useState("");

  // ── Helpers ──────────────────────────────────────────────
  const statusColor = s => s==="Pago"?"#15803d":s==="Vencido"?"#dc2626":"#d97706";
  const statusBg    = s => s==="Pago"?"#f0fdf4":s==="Vencido"?"#fef2f2":"#fffbeb";

  // ── Contas a pagar com auto-vencimento ───────────────────
  const contasFiltradas = useMemo(() => {
    let r = contasPagar.map(c => {
      if (c.status === "Pendente" && c.vencimento && getDaysUntil(c.vencimento) < 0) return {...c, status:"Vencido"};
      return c;
    });
    if (filterStatus !== "all") r = r.filter(c => c.status === filterStatus);
    if (filterCat !== "all") r = r.filter(c => c.categoria === filterCat);
    if (searchPagar) r = r.filter(c => c.descricao.toLowerCase().includes(searchPagar.toLowerCase()));
    if (pagarDe) r = r.filter(c => c.vencimento && c.vencimento >= pagarDe);
    if (pagarAte) r = r.filter(c => c.vencimento && c.vencimento <= pagarAte);
    return r.sort((a,b) => (a.vencimento||"9999") > (b.vencimento||"9999") ? 1 : -1);
  }, [contasPagar, filterStatus, filterCat, searchPagar, pagarDe, pagarAte]);

  // ── Totais ───────────────────────────────────────────────
  const totalPagar   = contasPagar.filter(c=>c.status!=="Pago").reduce((s,c)=>s+parseFloat(c.valor||0),0);
  const totalPago    = contasPagar.filter(c=>c.status==="Pago").reduce((s,c)=>s+parseFloat(c.valor||0),0);
  const totalVencido = contasPagar.filter(c=>c.status==="Vencido").reduce((s,c)=>s+parseFloat(c.valor||0),0);
  const vencendo7    = contasPagar.filter(c=>c.status==="Pendente"&&c.vencimento&&getDaysUntil(c.vencimento)>=0&&getDaysUntil(c.vencimento)<=7);

  const hoje = new Date().toLocaleDateString("sv-SE");
  const mesAtual = hoje.slice(0,7);
  const allOrders = rawOrders || [];

  const aReceber = allOrders.filter(o => {
    if (o.status !== "paid") return false;
    const ss = shipmentStatuses?.[o.id] ?? o.shipment_status;
    const isDelivered = ss === "delivered" || o.tags?.some(t=>t==="delivered");
    if (isDelivered) return false;
    // Não registrado ainda
    const jaRegistrado = lancamentos.some(l => l.tipo === "recebimento" && l.pedidoId === o.id);
    return !jaRegistrado;
  });

  const recebidoMes = allOrders.filter(o => {
    const ss = shipmentStatuses?.[o.id] ?? o.shipment_status;
    const isDelivered = ss === "delivered" || o.tags?.some(t=>t==="delivered");
    return isDelivered && o.date?.startsWith(mesAtual);
  });

  const totalAReceberLiq = aReceber.reduce((s,o) => s + (paymentData?.[o.id]?.netAmount || o.price*o.qty), 0);
  const totalRecebidoMesLiq = recebidoMes.reduce((s,o) => s + (paymentData?.[o.id]?.netAmount || o.price*o.qty), 0);
  const saldoMes = totalRecebidoMesLiq - totalPago;
  const saldoPrevisto = totalAReceberLiq - totalPagar;

  // ── Saldo por conta bancária ─────────────────────────────
  function getSaldoConta(contaId) {
    const inicial = parseFloat(contasBancarias.find(c=>c.id===contaId)?.saldoInicial || 0);
    const entradas = lancamentos.filter(l=>l.contaBancariaId===contaId&&l.tipo==="recebimento").reduce((s,l)=>s+l.valor,0);
    const saidas   = lancamentos.filter(l=>l.contaBancariaId===contaId&&l.tipo==="pagamento").reduce((s,l)=>s+l.valor,0);
    return inicial + entradas - saidas;
  }

  // ── Ações ────────────────────────────────────────────────
  function saveConta(form) {
    let novas = [];

    if (!editingConta && form.recorrencia === "parcelada" && form.totalParcelas > 1) {
      // Gera parcelas automaticamente
      const total = parseInt(form.totalParcelas);
      const valorParcela = parseFloat(form.valor) / total;
      const intervaloDias = { semanal:7, quinzenal:15, mensal:30, bimestral:60, trimestral:90 }[form.intervaloParcelas||"mensal"] || 30;
      for (let i = 0; i < total; i++) {
        const dataVenc = new Date(form.vencimento + "T12:00:00");
        dataVenc.setDate(dataVenc.getDate() + intervaloDias * i);
        novas.push({
          ...form,
          id: Date.now() + i,
          descricao: `${form.descricao} (${i+1}/${total})`,
          valor: valorParcela.toFixed(2),
          vencimento: dataVenc.toLocaleDateString("sv-SE"),
          recorrencia: "parcelada",
          parcelaAtual: i + 1,
          totalParcelas: total,
          grupoParcelado: Date.now(),
        });
      }
    } else {
      novas = [editingConta ? form : { ...form, id: Date.now() }];
    }

    const updated = editingConta
      ? contasPagar.map(c => c.id === form.id ? form : c)
      : [...contasPagar, ...novas];
    setContasPagar(updated); saveLS("contas_pagar", updated); setEditingConta(null);
  }

  function deleteConta(id) {
    if (!confirm("Excluir esta conta?")) return;
    const updated = contasPagar.filter(c=>c.id!==id);
    setContasPagar(updated); saveLS("contas_pagar", updated);
  }

  function confirmarBaixa(conta, { contaBancariaId, dataPagamento, obs }) {
    let updatedContas = contasPagar.map(c => c.id===conta.id ? {...c, status:"Pago", contaBancariaId, dataPagamento} : c);

    // Se for recorrente, cria a próxima ocorrência automaticamente
    const rec = conta.recorrencia;
    const diasMap = { semanal:7, quinzenal:15, mensal:30, bimestral:60, trimestral:90, semestral:180, anual:365 };
    if (rec && diasMap[rec] && conta.vencimento) {
      const proxVenc = new Date(conta.vencimento + "T12:00:00");
      proxVenc.setDate(proxVenc.getDate() + diasMap[rec]);
      const proxConta = {
        ...conta,
        id: Date.now() + 1,
        status: "Pendente",
        vencimento: proxVenc.toLocaleDateString("sv-SE"),
        dataPagamento: undefined,
        contaBancariaId: undefined,
        descricao: conta.descricao.replace(/ \(próxima\)/g,"") + " (próxima)",
      };
      updatedContas = [...updatedContas, proxConta];
    }

    setContasPagar(updatedContas); saveLS("contas_pagar", updatedContas);
    const lan = { id:Date.now(), tipo:"pagamento", descricao:conta.descricao, valor:parseFloat(conta.valor||0), data:dataPagamento, contaBancariaId, contaPagarId:conta.id, obs, categoria:conta.categoria };
    const updatedLan = [...lancamentos, lan];
    setLancamentos(updatedLan); saveLS("lancamentos", updatedLan);
  }

  function confirmarBaixaML(order, { contaBancariaId, dataRecebimento, valor }) {
    const lan = { id:Date.now(), tipo:"recebimento", descricao:`Pedido ML #${order.id}`, valor, data:dataRecebimento, contaBancariaId, pedidoId:order.id };
    const updatedLan = [...lancamentos, lan];
    setLancamentos(updatedLan); saveLS("lancamentos", updatedLan);
  }

  function saveBancaria(form) {
    const updated = editingBancaria ? contasBancarias.map(c=>c.id===form.id?form:c) : [...contasBancarias, {...form, id:Date.now()}];
    setContasBancarias(updated); saveLS("contas_bancarias", updated); setEditingBancaria(null);
  }

  function deleteBancaria(id) {
    if (!confirm("Excluir esta conta bancária? Os lançamentos serão mantidos.")) return;
    const updated = contasBancarias.filter(c=>c.id!==id);
    setContasBancarias(updated); saveLS("contas_bancarias", updated);
  }

  function addCategoria() {
    if (!novaCat.trim() || categoriasPagar.includes(novaCat.trim())) return;
    const updated = [...categoriasPagar, novaCat.trim()];
    setCategoriasPagar(updated); saveLS("categorias_pagar", updated); setNovaCat("");
  }

  function removeCategoria(cat) {
    if (!confirm(`Remover categoria "${cat}"?`)) return;
    const updated = categoriasPagar.filter(c=>c!==cat);
    setCategoriasPagar(updated); saveLS("categorias_pagar", updated);
  }

  // Gráfico por mês
  const recebPorMes = {};
  allOrders.forEach(o => {
    const ss = shipmentStatuses?.[o.id] ?? o.shipment_status;
    const isDelivered = ss==="delivered" || o.tags?.some(t=>t==="delivered");
    if (!isDelivered||!o.date) return;
    const mes = o.date.slice(0,7);
    recebPorMes[mes] = (recebPorMes[mes]||0) + (paymentData?.[o.id]?.netAmount||o.price*o.qty);
  });
  const pagosPorMes = {};
  lancamentos.filter(l=>l.tipo==="pagamento"&&l.data).forEach(l => {
    const mes = l.data.slice(0,7);
    pagosPorMes[mes] = (pagosPorMes[mes]||0) + l.valor;
  });
  const meses = [...new Set([...Object.keys(recebPorMes),...Object.keys(pagosPorMes)])].sort().slice(-6);

  return (
    <div>
      {/* Sub-tabs */}
      <div style={{ display:"flex", gap:2, marginBottom:20, background:"#f1f5f9", padding:4, borderRadius:10, width:"fit-content", flexWrap:"wrap" }}>
        {[
          { key:"resumo",   label:"📊 Resumo" },
          { key:"fluxo",    label:"📈 Fluxo de Caixa" },
          { key:"pagar",    label:"📤 Contas a Pagar" },
          { key:"receber",  label:"📥 Contas a Receber" },
          { key:"contas",   label:"🏦 Caixas e Bancos" },
          { key:"config",   label:"⚙️ Configurações" },
        ].map(t => (
          <button key={t.key} onClick={() => setFinTab(t.key)}
            style={{ background:finTab===t.key?"#fff":"transparent", border:"none", color:finTab===t.key?"#0f172a":"#94a3b8", padding:"8px 16px", cursor:"pointer", fontFamily:"inherit", fontSize:13, borderRadius:8, fontWeight:finTab===t.key?700:500, boxShadow:finTab===t.key?"0 1px 3px rgba(0,0,0,.08)":"none", whiteSpace:"nowrap" }}>
            {t.label}
          </button>
        ))}
      </div>

      {/* ── RESUMO ── */}
      {finTab === "resumo" && (
        <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
          <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit, minmax(160px,1fr))", gap:12 }}>
            {[
              { label:"Saldo do Mês", value:fmt(saldoMes), color:saldoMes>=0?"#15803d":"#dc2626", desc:"Recebido - Pago" },
              { label:"Saldo Previsto", value:fmt(saldoPrevisto), color:saldoPrevisto>=0?"#15803d":"#dc2626", desc:"A receber - A pagar" },
              { label:"A Receber (líq.)", value:fmt(totalAReceberLiq), color:"#0891b2", desc:`${aReceber.length} pedidos` },
              { label:"Recebido no Mês", value:fmt(totalRecebidoMesLiq), color:"#15803d", desc:"Pedidos entregues" },
              { label:"A Pagar", value:fmt(totalPagar), color:"#d97706", desc:"Contas pendentes" },
              { label:"Pago no Mês", value:fmt(totalPago), color:"#64748b", desc:"Lançado" },
            ].map(k => (
              <div key={k.label} style={{ background:"#fff", border:"1px solid #e2e8f0", borderRadius:12, padding:"16px 18px", boxShadow:"0 1px 2px rgba(0,0,0,.04)" }}>
                <div style={{ fontSize:11, color:"#94a3b8", marginBottom:6, fontWeight:600, textTransform:"uppercase", letterSpacing:0.8 }}>{k.label}</div>
                <div style={{ fontSize:20, fontWeight:800, color:k.color }}>{k.value}</div>
                <div style={{ fontSize:11, color:"#94a3b8", marginTop:4 }}>{k.desc}</div>
              </div>
            ))}
          </div>

          {/* Saldo por conta */}
          {contasBancarias.length > 0 && (
            <div style={{ background:"#fff", border:"1px solid #e2e8f0", borderRadius:12, padding:"20px 24px" }}>
              <div style={{ fontWeight:700, fontSize:14, color:"#0f172a", marginBottom:14 }}>🏦 Saldo por Conta</div>
              <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(180px,1fr))", gap:10 }}>
                {contasBancarias.map(cb => {
                  const saldo = getSaldoConta(cb.id);
                  return (
                    <div key={cb.id} style={{ background:"#f8fafc", border:`2px solid ${cb.cor}22`, borderRadius:10, padding:"14px 16px" }}>
                      <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:6 }}>
                        <div style={{ width:10, height:10, borderRadius:"50%", background:cb.cor }} />
                        <div style={{ fontSize:12, fontWeight:700, color:"#0f172a" }}>{cb.nome}</div>
                      </div>
                      <div style={{ fontSize:11, color:"#94a3b8", marginBottom:4 }}>{cb.tipo}</div>
                      <div style={{ fontSize:18, fontWeight:800, color:saldo>=0?"#15803d":"#dc2626" }}>{fmt(saldo)}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Alertas */}
          {(vencendo7.length > 0 || totalVencido > 0) && (
            <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
              {totalVencido > 0 && <div style={{ background:"#fef2f2", border:"1px solid #fecaca", borderRadius:10, padding:"12px 16px", display:"flex", alignItems:"center", gap:10 }}>
                <span style={{ fontSize:18 }}>⚠️</span>
                <div><div style={{ fontWeight:700, color:"#dc2626", fontSize:13 }}>Contas Vencidas</div>
                <div style={{ fontSize:12, color:"#b91c1c" }}>{contasPagar.filter(c=>c.status==="Vencido").length} conta(s) — {fmt(totalVencido)}</div></div>
              </div>}
              {vencendo7.length > 0 && <div style={{ background:"#fffbeb", border:"1px solid #fde68a", borderRadius:10, padding:"12px 16px", display:"flex", alignItems:"center", gap:10 }}>
                <span style={{ fontSize:18 }}>🔔</span>
                <div><div style={{ fontWeight:700, color:"#d97706", fontSize:13 }}>Vencendo em 7 dias</div>
                <div style={{ fontSize:12, color:"#92400e" }}>{vencendo7.map(c=>`${c.descricao} (${fmtDate(c.vencimento)})`).join(", ")}</div></div>
              </div>}
            </div>
          )}

          {/* Gráfico */}
          {meses.length > 0 && (
            <div style={{ background:"#fff", border:"1px solid #e2e8f0", borderRadius:12, padding:"20px 24px" }}>
              <div style={{ fontWeight:700, fontSize:14, color:"#0f172a", marginBottom:16 }}>Entradas vs Saídas por Mês</div>
              <div style={{ display:"flex", gap:8, alignItems:"flex-end", height:140 }}>
                {meses.map(mes => {
                  const rec = recebPorMes[mes]||0;
                  const pag = pagosPorMes[mes]||0;
                  const max = Math.max(...meses.map(m=>Math.max(recebPorMes[m]||0,pagosPorMes[m]||0)),1);
                  const [y,m] = mes.split("-");
                  return (
                    <div key={mes} style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", gap:4 }}>
                      <div style={{ width:"100%", display:"flex", gap:2, alignItems:"flex-end", height:100 }}>
                        <div style={{ flex:1, background:"#15803d", borderRadius:"4px 4px 0 0", height:`${(rec/max)*100}%`, minHeight:2 }} title={fmt(rec)} />
                        <div style={{ flex:1, background:"#dc2626", borderRadius:"4px 4px 0 0", height:`${(pag/max)*100}%`, minHeight:2, opacity:0.7 }} title={fmt(pag)} />
                      </div>
                      <div style={{ fontSize:10, color:"#94a3b8" }}>{m}/{y.slice(2)}</div>
                    </div>
                  );
                })}
              </div>
              <div style={{ display:"flex", gap:16, marginTop:10 }}>
                <div style={{ display:"flex", alignItems:"center", gap:6 }}><div style={{ width:12, height:12, background:"#15803d", borderRadius:2 }}/><span style={{ fontSize:12, color:"#64748b" }}>Recebido ML</span></div>
                <div style={{ display:"flex", alignItems:"center", gap:6 }}><div style={{ width:12, height:12, background:"#dc2626", borderRadius:2, opacity:0.7 }}/><span style={{ fontSize:12, color:"#64748b" }}>Pago</span></div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── FLUXO DE CAIXA ── */}
      {finTab === "fluxo" && (() => {
        // Agrupa entradas (ML entregues) e saídas (contas pagas) por dia
        const hoje = new Date().toLocaleDateString("sv-SE");
        const dias = {};

        // Entradas: pedidos entregues (recebimentos ML)
        allOrders.forEach(o => {
          const ss = shipmentStatuses?.[o.id] ?? o.shipment_status;
          const isDelivered = ss === "delivered" || o.tags?.some(t => t === "delivered");
          if (!isDelivered || !o.date) return;
          if (!dias[o.date]) dias[o.date] = { entradas:[], saidas:[] };
          dias[o.date].entradas.push({
            desc: o.title?.slice(0,40) || `Pedido #${o.id}`,
            valor: paymentData?.[o.id]?.netAmount || o.price * o.qty,
            tipo: "ML",
            id: o.id,
          });
        });

        // Saídas: contas pagas com data de pagamento
        contasPagar.filter(c => c.status === "Pago" && c.dataPagamento).forEach(c => {
          const d = c.dataPagamento;
          if (!dias[d]) dias[d] = { entradas:[], saidas:[] };
          dias[d].saidas.push({
            desc: c.descricao,
            valor: parseFloat(c.valor || 0),
            tipo: c.categoria,
            id: c.id,
          });
        });

        // Lançamentos manuais de recebimento
        lancamentos.filter(l => l.tipo === "recebimento" && l.data).forEach(l => {
          const d = l.data;
          if (!dias[d]) dias[d] = { entradas:[], saidas:[] };
          const jaExiste = dias[d].entradas.some(e => e.id === l.pedidoId);
          if (!jaExiste) {
            dias[d].entradas.push({ desc: l.descricao, valor: l.valor, tipo: "Registro manual", id: l.id });
          }
        });

        // Futuros: contas a pagar pendentes
        contasPagar.filter(c => c.status !== "Pago" && c.vencimento).forEach(c => {
          const d = c.vencimento;
          if (!dias[d]) dias[d] = { entradas:[], saidas:[] };
          dias[d].saidas.push({
            desc: `[PREVISTO] ${c.descricao}`,
            valor: parseFloat(c.valor || 0),
            tipo: c.categoria,
            id: c.id,
            previsto: true,
          });
        });

        // Futuros: recebimentos ML previstos
        aReceber.forEach(o => {
          const pd = paymentData?.[o.id];
          if (!pd?.releaseDate) return;
          if (!dias[pd.releaseDate]) dias[pd.releaseDate] = { entradas:[], saidas:[] };
          dias[pd.releaseDate].entradas.push({
            desc: `[PREVISTO] ${o.title?.slice(0,35) || `Pedido #${o.id}`}`,
            valor: pd.netAmount || o.price * o.qty,
            tipo: "ML Previsto",
            id: `prev_${o.id}`,
            previsto: true,
          });
        });

        const sortedDias = Object.keys(dias).sort().reverse().slice(0, 60);
        let saldoAcumulado = contasBancarias.reduce((s, c) => s + parseFloat(c.saldoInicial || 0), 0);
        
        // Calcula saldo acumulado na ordem cronológica
        const saldosPorDia = {};
        [...sortedDias].reverse().forEach(d => {
          const entrada = dias[d].entradas.filter(e => !e.previsto).reduce((s,e) => s+e.valor, 0);
          const saida   = dias[d].saidas.filter(s => !s.previsto).reduce((s,e) => s+e.valor, 0);
          saldoAcumulado += entrada - saida;
          saldosPorDia[d] = saldoAcumulado;
        });

        const totalEntradas = sortedDias.reduce((s,d) => s + dias[d].entradas.filter(e=>!e.previsto).reduce((a,e)=>a+e.valor,0), 0);
        const totalSaidas   = sortedDias.reduce((s,d) => s + dias[d].saidas.filter(e=>!e.previsto).reduce((a,e)=>a+e.valor,0), 0);

        return (
          <div>
            {/* Cards resumo */}
            <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(150px,1fr))", gap:12, marginBottom:16 }}>
              {[
                { label:"Total Entradas", value:fmt(totalEntradas), color:"#15803d", bg:"#f0fdf4" },
                { label:"Total Saídas",   value:fmt(totalSaidas),   color:"#dc2626", bg:"#fef2f2" },
                { label:"Saldo Período",  value:fmt(totalEntradas-totalSaidas), color:totalEntradas-totalSaidas>=0?"#15803d":"#dc2626", bg:"#f8fafc" },
              ].map(k => (
                <div key={k.label} style={{ background:k.bg, borderRadius:12, padding:"16px 18px", border:`1px solid ${k.bg}` }}>
                  <div style={{ fontSize:11, color:k.color, fontWeight:700, textTransform:"uppercase", marginBottom:6 }}>{k.label}</div>
                  <div style={{ fontSize:20, fontWeight:800, color:k.color }}>{k.value}</div>
                </div>
              ))}
            </div>

            <div style={{ background:"#fffbeb", border:"1px solid #fde68a", borderRadius:10, padding:"10px 14px", marginBottom:14, fontSize:12, color:"#92400e" }}>
              💡 Itens marcados como <b>[PREVISTO]</b> são futuros — contas a vencer e recebimentos ML com data prevista.
            </div>

            {/* Tabela por dia */}
            {sortedDias.length === 0 ? (
              <div style={{ background:"#f8fafc", border:"2px dashed #e2e8f0", borderRadius:12, padding:40, textAlign:"center", color:"#94a3b8" }}>
                <div style={{ fontSize:32, marginBottom:8 }}>📈</div>
                <div style={{ fontWeight:600 }}>Nenhum lançamento ainda</div>
                <div style={{ fontSize:13 }}>Dê baixa em contas a pagar e registre recebimentos para ver o fluxo</div>
              </div>
            ) : sortedDias.map(dia => {
              const { entradas, saidas } = dias[dia];
              const totalE = entradas.reduce((s,e)=>s+e.valor,0);
              const totalS = saidas.reduce((s,e)=>s+e.valor,0);
              const saldo  = totalE - totalS;
              const isFuturo = dia > hoje;
              return (
                <div key={dia} style={{ background:"#fff", border:"1px solid #e2e8f0", borderRadius:12, marginBottom:10, overflow:"hidden", opacity:isFuturo?0.85:1 }}>
                  {/* Header do dia */}
                  <div style={{ background:isFuturo?"#f8fafc":"#fafafa", padding:"10px 16px", display:"flex", justifyContent:"space-between", alignItems:"center", borderBottom:"1px solid #f1f5f9" }}>
                    <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                      {isFuturo && <span style={{ fontSize:10, background:"#dbeafe", color:"#1d4ed8", padding:"2px 7px", borderRadius:4, fontWeight:600 }}>PREVISTO</span>}
                      {dia === hoje && <span style={{ fontSize:10, background:"#fde68a", color:"#92400e", padding:"2px 7px", borderRadius:4, fontWeight:600 }}>HOJE</span>}
                      <span style={{ fontWeight:700, fontSize:14, color:"#0f172a" }}>{fmtDate(dia)}</span>
                    </div>
                    <div style={{ display:"flex", gap:16, alignItems:"center" }}>
                      {totalE > 0 && <span style={{ fontSize:12, color:"#15803d", fontWeight:600 }}>↑ {fmt(totalE)}</span>}
                      {totalS > 0 && <span style={{ fontSize:12, color:"#dc2626", fontWeight:600 }}>↓ {fmt(totalS)}</span>}
                      <span style={{ fontSize:13, fontWeight:800, color:saldo>=0?"#15803d":"#dc2626" }}>{saldo>=0?"+":""}{fmt(saldo)}</span>
                    </div>
                  </div>
                  {/* Linhas */}
                  <div style={{ padding:"6px 0" }}>
                    {entradas.map((e,i) => (
                      <div key={i} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"6px 16px" }}>
                        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                          <div style={{ width:6, height:6, borderRadius:"50%", background:"#15803d", flexShrink:0 }} />
                          <span style={{ fontSize:12, color:e.previsto?"#64748b":"#0f172a", fontStyle:e.previsto?"italic":"normal" }}>{e.desc}</span>
                          <span style={{ fontSize:10, background:"#f0fdf4", color:"#15803d", padding:"1px 6px", borderRadius:4 }}>{e.tipo}</span>
                        </div>
                        <span style={{ fontSize:13, fontWeight:700, color:"#15803d" }}>+{fmt(e.valor)}</span>
                      </div>
                    ))}
                    {saidas.map((e,i) => (
                      <div key={i} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"6px 16px" }}>
                        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                          <div style={{ width:6, height:6, borderRadius:"50%", background:"#dc2626", flexShrink:0 }} />
                          <span style={{ fontSize:12, color:e.previsto?"#64748b":"#0f172a", fontStyle:e.previsto?"italic":"normal" }}>{e.desc}</span>
                          <span style={{ fontSize:10, background:"#fef2f2", color:"#dc2626", padding:"1px 6px", borderRadius:4 }}>{e.tipo}</span>
                        </div>
                        <span style={{ fontSize:13, fontWeight:700, color:"#dc2626" }}>-{fmt(e.valor)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        );
      })()}

            {/* ── CONTAS A PAGAR ── */}
      {finTab === "pagar" && (
        <div>
          <PainelIAPagamentos contasPagar={contasPagar} contasBancarias={contasBancarias} />
          <div style={{ display:"flex", gap:10, alignItems:"center", marginBottom:10, flexWrap:"wrap" }}>
            <button onClick={() => { setEditingConta(null); setShowModalConta(true); }}
              style={{ background:"#0f172a", border:"none", color:"#fff", fontWeight:700, padding:"9px 20px", borderRadius:8, cursor:"pointer", fontSize:13 }}>+ Nova Conta</button>
            <div style={{ position:"relative", flex:1, minWidth:160 }}>
              <span style={{ position:"absolute", left:10, top:"50%", transform:"translateY(-50%)", color:"#94a3b8", fontSize:13 }}>🔍</span>
              <input value={searchPagar} onChange={e=>setSearchPagar(e.target.value)} placeholder="Buscar descrição..."
                style={{ width:"100%", background:"#fff", border:"1px solid #e2e8f0", color:"#0f172a", padding:"8px 12px 8px 32px", borderRadius:8, fontSize:13, outline:"none" }} />
            </div>
            <select value={filterStatus} onChange={e=>setFilterStatus(e.target.value)}
              style={{ background:"#fff", border:"1px solid #e2e8f0", color:"#334155", padding:"8px 12px", borderRadius:8, fontSize:12 }}>
              <option value="all">Todos status</option>
              {["Pendente","Pago","Vencido"].map(s=><option key={s} value={s}>{s}</option>)}
            </select>
            <select value={filterCat} onChange={e=>setFilterCat(e.target.value)}
              style={{ background:"#fff", border:"1px solid #e2e8f0", color:"#334155", padding:"8px 12px", borderRadius:8, fontSize:12 }}>
              <option value="all">Todas categorias</option>
              {categoriasPagar.map(c=><option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div style={{ display:"flex", gap:8, alignItems:"center", marginBottom:14, flexWrap:"wrap" }}>
            <span style={{ fontSize:12, color:"#94a3b8", fontWeight:500 }}>Vencimento:</span>
            <input type="date" value={pagarDe} onChange={e=>setPagarDe(e.target.value)}
              style={{ background:"#fff", border:"1px solid #e2e8f0", color:"#334155", padding:"6px 10px", borderRadius:8, fontSize:12, cursor:"pointer" }} />
            <span style={{ fontSize:12, color:"#94a3b8" }}>até</span>
            <input type="date" value={pagarAte} onChange={e=>setPagarAte(e.target.value)}
              style={{ background:"#fff", border:"1px solid #e2e8f0", color:"#334155", padding:"6px 10px", borderRadius:8, fontSize:12, cursor:"pointer" }} />
            {(pagarDe||pagarAte) && (
              <button onClick={()=>{setPagarDe("");setPagarAte("");}}
                style={{ background:"#f1f5f9", border:"1px solid #e2e8f0", color:"#64748b", padding:"5px 10px", borderRadius:8, cursor:"pointer", fontSize:12 }}>✕ Limpar</button>
            )}
            <span style={{ fontSize:12, color:"#94a3b8", marginLeft:4 }}>{contasFiltradas.length} conta(s)</span>
          </div>
          {(() => {
            const hoje = new Date(); hoje.setHours(0,0,0,0);
            const protestoIminente = contasPagar.filter(c => {
              if (c.status === "Pago" || !c.temProtesto || !c.vencimento || !c.diasProtesto) return false;
              const venc = new Date(c.vencimento + "T00:00:00");
              const dataProtesto = new Date(venc); dataProtesto.setDate(dataProtesto.getDate() + parseInt(c.diasProtesto));
              const diasRestantes = Math.round((dataProtesto - hoje) / 86400000);
              return diasRestantes >= 0 && diasRestantes <= 5;
            });
            const protestados = contasPagar.filter(c => {
              if (c.status === "Pago" || !c.temProtesto || !c.vencimento || !c.diasProtesto) return false;
              const venc = new Date(c.vencimento + "T00:00:00");
              const dataProtesto = new Date(venc); dataProtesto.setDate(dataProtesto.getDate() + parseInt(c.diasProtesto));
              return dataProtesto < hoje;
            });
            return (
              <>
                {protestados.length > 0 && (
                  <div style={{ background:"#f5f3ff", border:"1px solid #c4b5fd", borderRadius:10, padding:"10px 16px", marginBottom:10, display:"flex", alignItems:"center", gap:10 }}>
                    <span style={{ fontSize:18 }}>⚖️</span>
                    <div>
                      <div style={{ fontWeight:700, color:"#7c3aed", fontSize:13 }}>{protestados.length} conta(s) com protesto vencido!</div>
                      <div style={{ fontSize:12, color:"#6d28d9" }}>{protestados.map(c=>c.descricao?.slice(0,30)).join(", ")}</div>
                    </div>
                  </div>
                )}
                {protestoIminente.length > 0 && (
                  <div style={{ background:"#fef2f2", border:"1px solid #fca5a5", borderRadius:10, padding:"10px 16px", marginBottom:10, display:"flex", alignItems:"center", gap:10 }}>
                    <span style={{ fontSize:18 }}>⚠️</span>
                    <div>
                      <div style={{ fontWeight:700, color:"#dc2626", fontSize:13 }}>Protesto em até 5 dias!</div>
                      <div style={{ fontSize:12, color:"#b91c1c" }}>{protestoIminente.map(c=>`${c.descricao?.slice(0,25)} (${c.diasProtesto}d após venc.)`).join(", ")}</div>
                    </div>
                  </div>
                )}
              </>
            );
          })()}
          <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:10, marginBottom:14 }}>
            {[
              { label:"Pendente", value:fmt(contasPagar.filter(c=>c.status==="Pendente").reduce((s,c)=>s+parseFloat(c.valor||0),0)), color:"#d97706", bg:"#fffbeb" },
              { label:"Vencido",  value:fmt(totalVencido), color:"#dc2626", bg:"#fef2f2" },
              { label:"Pago",     value:fmt(totalPago),    color:"#15803d", bg:"#f0fdf4" },
            ].map(k => (
              <div key={k.label} style={{ background:k.bg, borderRadius:10, padding:"12px 16px" }}>
                <div style={{ fontSize:11, color:k.color, fontWeight:700, textTransform:"uppercase", marginBottom:4 }}>{k.label}</div>
                <div style={{ fontSize:18, fontWeight:800, color:k.color }}>{k.value}</div>
              </div>
            ))}
          </div>
          <div style={{ background:"#fff", border:"1px solid #e2e8f0", borderRadius:12, overflow:"auto" }}>
            <table style={{ borderCollapse:"collapse", width:"100%" }}>
              <thead>
                <tr>{["Descrição","Categoria","Valor","Vencimento","Status","Conta paga","Anexos","Ações"].map(h=>(
                  <th key={h} style={{ fontSize:11, color:"#94a3b8", textTransform:"uppercase", letterSpacing:0.8, padding:"10px 14px", borderBottom:"1px solid #f1f5f9", textAlign:"left", fontWeight:600, background:"#fafafa", whiteSpace:"nowrap" }}>{h}</th>
                ))}</tr>
              </thead>
              <tbody>
                {contasFiltradas.length===0 ? (
                  <tr><td colSpan={7} style={{ textAlign:"center", color:"#94a3b8", padding:40 }}>Nenhuma conta encontrada</td></tr>
                ) : contasFiltradas.map((c,i) => {
                  const days = getDaysUntil(c.vencimento);
                  const isVencendo = c.status==="Pendente"&&days!==null&&days>=0&&days<=7;
                  const contaBanc = contasBancarias.find(cb=>cb.id===c.contaBancariaId);
                  return (
                    <tr key={c.id} style={{ background:i%2===0?"#f8fafc":"#fff" }}>
                      <td style={{ padding:"10px 14px", fontSize:13, color:"#0f172a", fontWeight:500 }}>
                        <div>{c.descricao}
                          {isVencendo&&<span style={{ fontSize:10, background:"#fde68a", color:"#92400e", padding:"1px 6px", borderRadius:4, marginLeft:6, fontWeight:600 }}>Vence em {days}d</span>}
                        </div>
                        {c.fornecedorNome && c.fornecedorNome !== c.descricao && (
                          <div style={{ fontSize:11, color:"#0891b2", marginTop:2 }}>🏭 {c.fornecedorNome}</div>
                        )}
                        {c.recorrencia && c.recorrencia !== "unica" && (() => {
                          const labels = { parcelada:"📋", semanal:"📅", quinzenal:"📅", mensal:"🔄", bimestral:"🔄", trimestral:"🔄", semestral:"🔄", anual:"🔄" };
                          const names = { parcelada:`Parcela ${c.parcelaAtual||""}/${c.totalParcelas||""}`, semanal:"Semanal", quinzenal:"Quinzenal", mensal:"Mensal", bimestral:"Bimestral", trimestral:"Trimestral", semestral:"Semestral", anual:"Anual" };
                          return (
                            <span style={{ fontSize:10, background:"#f0fdf4", color:"#15803d", border:"1px solid #bbf7d0", padding:"1px 7px", borderRadius:20, fontWeight:600, display:"inline-block", marginTop:3 }}>
                              {labels[c.recorrencia]} {names[c.recorrencia]}
                            </span>
                          );
                        })()}
                      </td>
                      <td style={{ padding:"10px 14px", fontSize:12, color:"#64748b" }}>{c.categoria}</td>
                      <td style={{ padding:"10px 14px", fontSize:13, fontWeight:700, color:"#0f172a" }}>{fmt(parseFloat(c.valor||0))}</td>
                      <td style={{ padding:"10px 14px", fontSize:12, color:"#64748b" }}>{fmtDate(c.vencimento)}</td>
                      <td style={{ padding:"10px 14px" }}>
                        <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
                          <span style={{ fontSize:11, fontWeight:600, color:statusColor(c.status), background:statusBg(c.status), padding:"3px 8px", borderRadius:6, display:"inline-block" }}>{c.status}</span>
                          {c.temProtesto && (() => {
                            const dias = getDaysUntil(c.vencimento);
                            const diasProt = parseInt(c.diasProtesto || 0);
                            const diasParaProtesto = dias !== null ? dias + diasProt : null;
                            const jaProtestado = diasParaProtesto !== null && diasParaProtesto <= 0 && c.status !== "Pago";
                            const alertaProtesto = diasParaProtesto !== null && diasParaProtesto > 0 && diasParaProtesto <= 5;
                            return (
                              <span style={{ fontSize:10, fontWeight:700, color: jaProtestado?"#7c3aed": alertaProtesto?"#dc2626":"#94a3b8", background: jaProtestado?"#f5f3ff": alertaProtesto?"#fef2f2":"#f8fafc", padding:"2px 7px", borderRadius:5, display:"inline-block", whiteSpace:"nowrap" }}>
                                {jaProtestado ? "⚖️ Protestado" : alertaProtesto ? `⚠️ Protesto em ${diasParaProtesto}d` : `⚖️ Protesto em ${diasParaProtesto}d`}
                              </span>
                            );
                          })()}
                        </div>
                      </td>
                      <td style={{ padding:"10px 14px", fontSize:12, color:"#64748b" }}>
                        {contaBanc ? <span style={{ display:"flex", alignItems:"center", gap:4 }}><div style={{ width:8, height:8, borderRadius:"50%", background:contaBanc.cor }} />{contaBanc.nome}</span> : "—"}
                      </td>
                      <td style={{ padding:"10px 14px" }}>
                        {(c.anexos||[]).length > 0 ? (
                          <div style={{ display:"flex", gap:4, flexWrap:"wrap" }}>
                            {(c.anexos||[]).map((a,i) => (
                              <a key={i} href={a.base64} download={a.nome} title={a.nome}
                                style={{ fontSize:10, background:"#eff6ff", color:"#1d4ed8", border:"1px solid #bfdbfe", padding:"2px 8px", borderRadius:20, textDecoration:"none", fontWeight:600, display:"inline-flex", alignItems:"center", gap:3 }}>
                                📎 {a.nome.length>15?a.nome.slice(0,15)+"...":a.nome}
                              </a>
                            ))}
                          </div>
                        ) : <span style={{ fontSize:12, color:"#94a3b8" }}>—</span>}
                      </td>
                      <td style={{ padding:"10px 14px" }}>
                        <div style={{ display:"flex", gap:4 }}>
                          {c.status!=="Pago" && (
                            <button onClick={() => setModalBaixa(c)}
                              style={{ background:"#0f172a", border:"none", color:"#fff", padding:"4px 10px", borderRadius:6, cursor:"pointer", fontSize:11, fontWeight:600, whiteSpace:"nowrap" }}>
                              Dar Baixa
                            </button>
                          )}
                          <button onClick={() => { setEditingConta(c); setShowModalConta(true); }}
                            style={{ background:"#f1f5f9", border:"1px solid #e2e8f0", color:"#64748b", padding:"4px 8px", borderRadius:6, cursor:"pointer", fontSize:11 }}>✏️</button>
                          <button onClick={() => deleteConta(c.id)}
                            style={{ background:"#fef2f2", border:"1px solid #fecaca", color:"#dc2626", padding:"4px 8px", borderRadius:6, cursor:"pointer", fontSize:11 }}>🗑</button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── CONTAS A RECEBER ── */}
      {finTab === "receber" && (
        <div>
          <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(160px,1fr))", gap:10, marginBottom:14 }}>
            {[
              { label:"A Receber (líq.)", value:fmt(totalAReceberLiq), color:"#0891b2", bg:"#ecfeff", desc:`${aReceber.length} pedidos` },
              { label:"Recebido no Mês", value:fmt(totalRecebidoMesLiq), color:"#15803d", bg:"#f0fdf4", desc:`${recebidoMes.length} pedidos` },
            ].map(k => (
              <div key={k.label} style={{ background:k.bg, borderRadius:10, padding:"14px 18px" }}>
                <div style={{ fontSize:11, color:k.color, fontWeight:700, textTransform:"uppercase", marginBottom:4 }}>{k.label}</div>
                <div style={{ fontSize:20, fontWeight:800, color:k.color }}>{k.value}</div>
                <div style={{ fontSize:11, color:k.color, opacity:0.7, marginTop:2 }}>{k.desc}</div>
              </div>
            ))}
          </div>
          <div style={{ display:"flex", gap:10, alignItems:"center", marginBottom:10, flexWrap:"wrap" }}>
            <div style={{ fontWeight:700, fontSize:14, color:"#0f172a", whiteSpace:"nowrap" }}>Pedidos a Receber</div>
            <div style={{ position:"relative", flex:1, minWidth:240 }}>
              <span style={{ position:"absolute", left:10, top:"50%", transform:"translateY(-50%)", color:"#94a3b8", fontSize:13 }}>🔍</span>
              <input value={searchReceber} onChange={e => setSearchReceber(e.target.value)}
                placeholder="Buscar por nº pedido, cliente ou produto..."
                style={{ width:"100%", background:"#fff", border:"1px solid #e2e8f0", color:"#0f172a", padding:"8px 12px 8px 32px", borderRadius:8, fontSize:13, outline:"none" }} />
            </div>
            {searchReceber && (
              <button onClick={() => setSearchReceber("")}
                style={{ background:"#f1f5f9", border:"1px solid #e2e8f0", color:"#64748b", padding:"7px 12px", borderRadius:8, cursor:"pointer", fontSize:12 }}>
                ✕ Limpar
              </button>
            )}
          </div>
          <div style={{ display:"flex", gap:8, alignItems:"center", marginBottom:14, flexWrap:"wrap" }}>
            <span style={{ fontSize:12, color:"#94a3b8", fontWeight:500 }}>Data da venda:</span>
            <input type="date" value={receberDe} onChange={e=>setReceberDe(e.target.value)}
              style={{ background:"#fff", border:"1px solid #e2e8f0", color:"#334155", padding:"6px 10px", borderRadius:8, fontSize:12, cursor:"pointer" }} />
            <span style={{ fontSize:12, color:"#94a3b8" }}>até</span>
            <input type="date" value={receberAte} onChange={e=>setReceberAte(e.target.value)}
              style={{ background:"#fff", border:"1px solid #e2e8f0", color:"#334155", padding:"6px 10px", borderRadius:8, fontSize:12, cursor:"pointer" }} />
            {(receberDe||receberAte) && (
              <button onClick={()=>{setReceberDe("");setReceberAte("");}}
                style={{ background:"#f1f5f9", border:"1px solid #e2e8f0", color:"#64748b", padding:"5px 10px", borderRadius:8, cursor:"pointer", fontSize:12 }}>✕ Limpar</button>
            )}
          </div>
          <div style={{ background:"#fff", border:"1px solid #e2e8f0", borderRadius:12, overflow:"auto", marginBottom:20 }}>
            <table style={{ borderCollapse:"collapse", width:"100%" }}>
              <thead>
                <tr>{["Pedido","Cliente","Produto","Data","Valor Bruto","Valor Líquido","Previsão ML","Status","Ação"].map(h=>(
                  <th key={h} style={{ fontSize:11, color:"#94a3b8", textTransform:"uppercase", letterSpacing:0.8, padding:"10px 14px", borderBottom:"1px solid #f1f5f9", textAlign:"left", fontWeight:600, background:"#fafafa", whiteSpace:"nowrap" }}>{h}</th>
                ))}</tr>
              </thead>
              <tbody>
                {(() => {
                  const q = searchReceber.toLowerCase().trim();
                  let filtered = aReceber;
                  if (q) filtered = filtered.filter(o =>
                    String(o.id).includes(q) ||
                    o.title?.toLowerCase().includes(q) ||
                    o.buyerName?.toLowerCase().includes(q)
                  );
                  if (receberDe) filtered = filtered.filter(o => o.date && o.date >= receberDe);
                  if (receberAte) filtered = filtered.filter(o => o.date && o.date <= receberAte);
                  if (filtered.length === 0) return (
                    <tr><td colSpan={9} style={{ textAlign:"center", color:"#94a3b8", padding:32 }}>
                      {searchReceber ? "Nenhum pedido encontrado para essa busca" : "Nenhum pedido a receber"}
                    </td></tr>
                  );
                  return filtered.slice(0,100).map((o,i) => {
                  const ss = shipmentStatuses?.[o.id] ?? o.shipment_status;
                  const isEnviado = ["shipped","in_transit"].includes(ss);
                  const label = isEnviado ? "Enviado" : "Ag. Envio";
                  const color = isEnviado ? "#0891b2" : "#d97706";
                  const bg = isEnviado ? "#ecfeff" : "#fffbeb";
                  const pd = paymentData?.[o.id];
                  const netAmt = pd?.netAmount || null;
                  const releaseDate = pd?.releaseDate || null;
                  const relDays = releaseDate ? getDaysUntil(releaseDate) : null;
                  const jaRegistrado = lancamentos.some(l=>l.tipo==="recebimento"&&l.pedidoId===o.id);
                  return (
                    <tr key={o.id} style={{ background:i%2===0?"#f8fafc":"#fff" }}>
                      <td style={{ padding:"10px 14px", fontSize:12, color:"#64748b", fontFamily:"monospace", fontWeight:600 }}>#{o.id}</td>
                      <td style={{ padding:"10px 14px", fontSize:12, color:"#334155", maxWidth:120, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{o.buyerName||"—"}</td>
                      <td style={{ padding:"10px 14px", fontSize:13, color:"#0f172a", maxWidth:200, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{o.title||"—"}</td>
                      <td style={{ padding:"10px 14px", fontSize:12, color:"#64748b" }}>{o.date}</td>
                      <td style={{ padding:"10px 14px", fontSize:13, color:"#64748b" }}>{fmt(o.price*o.qty)}</td>
                      <td style={{ padding:"10px 14px", fontSize:13, fontWeight:700, color:"#15803d" }}>{netAmt ? fmt(netAmt) : <span style={{ color:"#94a3b8", fontSize:11 }}>Carregando...</span>}</td>
                      <td style={{ padding:"10px 14px" }}>
                        {releaseDate ? (
                          <div>
                            <div style={{ fontSize:12, fontWeight:700, color:relDays<=0?"#15803d":relDays<=7?"#d97706":"#0891b2" }}>
                              {relDays<=0 ? "✓ Liberado" : fmtDate(releaseDate)}
                            </div>
                            {relDays>0&&<div style={{ fontSize:10, color:"#94a3b8" }}>em {relDays}d</div>}
                          </div>
                        ) : <span style={{ fontSize:11, color:"#94a3b8" }}>—</span>}
                      </td>
                      <td style={{ padding:"10px 14px" }}><span style={{ fontSize:11, fontWeight:600, color, background:bg, padding:"3px 8px", borderRadius:6 }}>{label}</span></td>
                      <td style={{ padding:"10px 14px" }}>
                        {jaRegistrado ? (
                          <span style={{ fontSize:11, color:"#15803d", fontWeight:600 }}>✓ Registrado</span>
                        ) : (
                          <button onClick={() => setModalBaixaML(o)}
                            style={{ background:"#15803d", border:"none", color:"#fff", padding:"4px 10px", borderRadius:6, cursor:"pointer", fontSize:11, fontWeight:600, whiteSpace:"nowrap" }}>
                            Registrar
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                });
                })()}
              </tbody>
            </table>
          </div>

          <div style={{ fontWeight:700, fontSize:14, color:"#0f172a", marginBottom:10 }}>Recebidos no Mês Atual</div>
          <div style={{ background:"#fff", border:"1px solid #e2e8f0", borderRadius:12, overflow:"auto" }}>
            <table style={{ borderCollapse:"collapse", width:"100%" }}>
              <thead>
                <tr>{["Pedido","Produto","Data","Valor Bruto","Valor Líquido"].map(h=>(
                  <th key={h} style={{ fontSize:11, color:"#94a3b8", textTransform:"uppercase", letterSpacing:0.8, padding:"10px 14px", borderBottom:"1px solid #f1f5f9", textAlign:"left", fontWeight:600, background:"#fafafa" }}>{h}</th>
                ))}</tr>
              </thead>
              <tbody>
                {recebidoMes.length===0 ? (
                  <tr><td colSpan={5} style={{ textAlign:"center", color:"#94a3b8", padding:32 }}>Nenhum pedido entregue este mês</td></tr>
                ) : recebidoMes.slice(0,50).map((o,i) => (
                  <tr key={o.id} style={{ background:i%2===0?"#f8fafc":"#fff" }}>
                    <td style={{ padding:"10px 14px", fontSize:12, color:"#64748b", fontFamily:"monospace", fontWeight:600 }}>#{o.id}</td>
                    <td style={{ padding:"10px 14px", fontSize:13, color:"#0f172a", maxWidth:240, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{o.title||"—"}</td>
                    <td style={{ padding:"10px 14px", fontSize:12, color:"#64748b" }}>{o.date}</td>
                    <td style={{ padding:"10px 14px", fontSize:13, color:"#64748b" }}>{fmt(o.price*o.qty)}</td>
                    <td style={{ padding:"10px 14px", fontSize:13, fontWeight:700, color:"#15803d" }}>{paymentData?.[o.id]?.netAmount ? fmt(paymentData[o.id].netAmount) : fmt(o.price*o.qty)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── CAIXAS E BANCOS ── */}
      {finTab === "contas" && (
        <div>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:14 }}>
            <div style={{ fontWeight:700, fontSize:15, color:"#0f172a" }}>Contas Cadastradas</div>
            <button onClick={() => { setEditingBancaria(null); setShowModalBancaria(true); }}
              style={{ background:"#0f172a", border:"none", color:"#fff", fontWeight:700, padding:"9px 20px", borderRadius:8, cursor:"pointer", fontSize:13 }}>+ Nova Conta</button>
          </div>
          {contasBancarias.length === 0 ? (
            <div style={{ background:"#f8fafc", border:"2px dashed #e2e8f0", borderRadius:12, padding:40, textAlign:"center", color:"#94a3b8" }}>
              <div style={{ fontSize:32, marginBottom:8 }}>🏦</div>
              <div style={{ fontWeight:600, marginBottom:4 }}>Nenhuma conta cadastrada</div>
              <div style={{ fontSize:13 }}>Clique em "+ Nova Conta" para começar</div>
            </div>
          ) : (
            <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(260px,1fr))", gap:12 }}>
              {contasBancarias.map(cb => {
                const saldo = getSaldoConta(cb.id);
                const entradas = lancamentos.filter(l=>l.contaBancariaId===cb.id&&l.tipo==="recebimento").reduce((s,l)=>s+l.valor,0);
                const saidas   = lancamentos.filter(l=>l.contaBancariaId===cb.id&&l.tipo==="pagamento").reduce((s,l)=>s+l.valor,0);
                return (
                  <div key={cb.id} style={{ background:"#fff", border:`2px solid ${cb.cor}33`, borderRadius:12, padding:"18px 20px", position:"relative" }}>
                    <div style={{ position:"absolute", top:12, right:12, display:"flex", gap:4 }}>
                      <button onClick={() => { setEditingBancaria(cb); setShowModalBancaria(true); }}
                        style={{ background:"#f1f5f9", border:"none", color:"#64748b", width:28, height:28, borderRadius:6, cursor:"pointer", fontSize:12 }}>✏️</button>
                      <button onClick={() => deleteBancaria(cb.id)}
                        style={{ background:"#fef2f2", border:"none", color:"#dc2626", width:28, height:28, borderRadius:6, cursor:"pointer", fontSize:12 }}>🗑</button>
                    </div>
                    <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:4 }}>
                      <div style={{ width:12, height:12, borderRadius:"50%", background:cb.cor }} />
                      <div style={{ fontWeight:700, fontSize:14, color:"#0f172a" }}>{cb.nome}</div>
                    </div>
                    <div style={{ fontSize:11, color:"#94a3b8", marginBottom:12 }}>{cb.tipo}{cb.banco ? ` · ${cb.banco}` : ""}</div>
                    <div style={{ fontSize:22, fontWeight:800, color:saldo>=0?"#15803d":"#dc2626", marginBottom:8 }}>{fmt(saldo)}</div>
                    <div style={{ display:"flex", gap:12, fontSize:11, color:"#94a3b8" }}>
                      <span style={{ color:"#15803d" }}>↑ {fmt(entradas)}</span>
                      <span style={{ color:"#dc2626" }}>↓ {fmt(saidas)}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Extrato de lançamentos */}
          {lancamentos.length > 0 && (
            <div style={{ marginTop:20 }}>
              <div style={{ fontWeight:700, fontSize:14, color:"#0f172a", marginBottom:10 }}>Extrato de Lançamentos</div>
              <div style={{ background:"#fff", border:"1px solid #e2e8f0", borderRadius:12, overflow:"auto" }}>
                <table style={{ borderCollapse:"collapse", width:"100%" }}>
                  <thead>
                    <tr>{["Data","Descrição","Conta","Tipo","Valor"].map(h=>(
                      <th key={h} style={{ fontSize:11, color:"#94a3b8", textTransform:"uppercase", letterSpacing:0.8, padding:"10px 14px", borderBottom:"1px solid #f1f5f9", textAlign:"left", fontWeight:600, background:"#fafafa" }}>{h}</th>
                    ))}</tr>
                  </thead>
                  <tbody>
                    {[...lancamentos].sort((a,b)=>b.data>a.data?1:-1).slice(0,50).map((l,i) => {
                      const cb = contasBancarias.find(c=>c.id===l.contaBancariaId);
                      return (
                        <tr key={l.id} style={{ background:i%2===0?"#f8fafc":"#fff" }}>
                          <td style={{ padding:"10px 14px", fontSize:12, color:"#64748b" }}>{fmtDate(l.data)}</td>
                          <td style={{ padding:"10px 14px", fontSize:13, color:"#0f172a" }}>{l.descricao}</td>
                          <td style={{ padding:"10px 14px", fontSize:12 }}>
                            {cb ? <span style={{ display:"flex", alignItems:"center", gap:4 }}><div style={{ width:8,height:8,borderRadius:"50%",background:cb.cor }}/>{cb.nome}</span> : "—"}
                          </td>
                          <td style={{ padding:"10px 14px" }}>
                            <span style={{ fontSize:11, fontWeight:600, color:l.tipo==="recebimento"?"#15803d":"#dc2626", background:l.tipo==="recebimento"?"#f0fdf4":"#fef2f2", padding:"2px 8px", borderRadius:5 }}>
                              {l.tipo==="recebimento"?"↑ Entrada":"↓ Saída"}
                            </span>
                          </td>
                          <td style={{ padding:"10px 14px", fontSize:13, fontWeight:700, color:l.tipo==="recebimento"?"#15803d":"#dc2626" }}>
                            {l.tipo==="recebimento"?"+":"-"}{fmt(l.valor)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── CONFIGURAÇÕES ── */}
      {finTab === "config" && (
        <div style={{ maxWidth:700 }}>
          {/* Painel compacto de Impostos e Custos Fixos */}
          <div style={{ marginBottom:24 }}>
            <div style={{ fontWeight:700, fontSize:15, color:"#0f172a", marginBottom:4 }}>Impostos e Custos Fixos</div>
            <div style={{ fontSize:12, color:"#94a3b8", marginBottom:12 }}>Usados para calcular o Lucro Real no painel principal</div>
            <ImpostosCompacto
              impostos={impostos}
              setImpostos={setImpostos}
              custosFixos={custosFixos}
              setCustosFixos={setCustosFixos}
              faturamentoMes={enrichedOrders.filter(o=>o.date?.startsWith(new Date().toLocaleDateString("sv-SE").slice(0,7))).reduce((s,o)=>s+o.revenue*o.qty,0)}
            />
          </div>

          <div style={{ borderTop:"1px solid #f1f5f9", paddingTop:20 }}>
          <div style={{ fontWeight:700, fontSize:15, color:"#0f172a", marginBottom:4 }}>Fornecedores Cadastrados</div>
          <div style={{ fontSize:12, color:"#94a3b8", marginBottom:10 }}>
            {fornecedores.length} fornecedor(es) — aparecem no autocomplete das contas a pagar.
            Cadastre mais em <strong>🛍️ Produtos → 🏭 Fornecedores</strong>.
          </div>
          <div style={{ display:"flex", flexWrap:"wrap", gap:6, marginBottom:20 }}>
            {fornecedores.length === 0
              ? <span style={{ fontSize:12, color:"#94a3b8" }}>Nenhum fornecedor cadastrado ainda.</span>
              : fornecedores.map(f => (
                <span key={f.id} style={{ fontSize:12, background:"#eff6ff", color:"#1d4ed8", border:"1px solid #bfdbfe", padding:"3px 10px", borderRadius:20, fontWeight:500 }}>
                  🏭 {f.nome}
                </span>
              ))
            }
          </div>

          <div style={{ fontWeight:700, fontSize:15, color:"#0f172a", marginBottom:14 }}>Categorias de Contas a Pagar</div>
          <div style={{ background:"#fff", border:"1px solid #e2e8f0", borderRadius:12, padding:"16px 20px", marginBottom:16 }}>
            <div style={{ display:"flex", gap:8, marginBottom:14 }}>
              <input value={novaCat} onChange={e=>setNovaCat(e.target.value)}
                onKeyDown={e=>e.key==="Enter"&&addCategoria()}
                placeholder="Nova categoria..."
                style={{ flex:1, background:"#f8fafc", border:"1px solid #e2e8f0", color:"#0f172a", padding:"8px 12px", borderRadius:8, fontSize:13, outline:"none" }} />
              <button onClick={addCategoria} disabled={!novaCat.trim()}
                style={{ background:novaCat.trim()?"#0f172a":"#f1f5f9", border:"none", color:novaCat.trim()?"#fff":"#94a3b8", fontWeight:700, padding:"8px 16px", borderRadius:8, cursor:novaCat.trim()?"pointer":"not-allowed", fontSize:13 }}>
                Adicionar
              </button>
            </div>
            <div style={{ display:"flex", flexWrap:"wrap", gap:8 }}>
              {categoriasPagar.map(cat => (
                <div key={cat} style={{ display:"flex", alignItems:"center", gap:6, background:"#f1f5f9", border:"1px solid #e2e8f0", borderRadius:20, padding:"5px 12px" }}>
                  <span style={{ fontSize:13, color:"#334155", fontWeight:500 }}>{cat}</span>
                  <button onClick={()=>removeCategoria(cat)}
                    style={{ background:"none", border:"none", color:"#94a3b8", cursor:"pointer", fontSize:12, padding:0, lineHeight:1 }}>✕</button>
                </div>
              ))}
            </div>
          </div>
          </div>
        </div>
      )}

      {/* Modais */}
      {showModalConta && <ModalConta conta={editingConta} categoriasPagar={categoriasPagar} fornecedores={fornecedores} onSave={saveConta} onClose={()=>{ setShowModalConta(false); setEditingConta(null); }} />}
      {showModalBancaria && <ModalContaBancaria conta={editingBancaria} onSave={saveBancaria} onClose={()=>{ setShowModalBancaria(false); setEditingBancaria(null); }} />}
      {modalBaixa && <ModalBaixa conta={modalBaixa} contasBancarias={contasBancarias} onConfirm={(data)=>confirmarBaixa(modalBaixa,data)} onClose={()=>setModalBaixa(null)} />}
      {modalBaixaML && <ModalBaixaML order={modalBaixaML} paymentInfo={paymentData?.[modalBaixaML.id]} contasBancarias={contasBancarias} onConfirm={(data)=>confirmarBaixaML(modalBaixaML,data)} onClose={()=>setModalBaixaML(null)} />}
    </div>
  );
}


export default function App() {
  // ── Auth do dashboard ─────────────────────────────────────
  const [tab, setTab] = useState("listings");
  const [costs, setCosts] = useState({});
  const [minStock, setMinStock] = useState({});
  const [selectedListing, setSelectedListing] = useState(null);
  const [sortBy, setSortBy] = useState("score");
  const [orderFilter, setOrderFilter] = useState("all");
  const [searchListings, setSearchListings] = useState("");
  const [searchType, setSearchType] = useState("all");
  const [searchOrders, setSearchOrders] = useState("");
  const [orderStatusFilter, setOrderStatusFilter] = useState("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [token, setToken] = useState(() => loadSavedTokens()?.accessToken ?? null);
  const [user, setUser] = useState(() => {
    const s = loadSavedTokens();
    return s ? { nickname: s.nickname, id: s.userId } : null;
  });
  const [realListings, setRealListings] = useState([]);
  const [realOrders, setRealOrders] = useState([]);
  const [sellerShipping, setSellerShipping] = useState({});
  const [shipmentCosts, setShipmentCosts] = useState({});
  const [shipmentStatuses, setShipmentStatuses] = useState({});
  const [promos, setPromos] = useState({});
  const [loading, setLoading] = useState(false);
  const [loadingMsg, setLoadingMsg] = useState("");
  // ── Auth ──────────────────────────────────────────────────
  const [currentUser, setCurrentUser] = useState(() => getSession());
  const [lastUpdate, setLastUpdate] = useState(() => localStorage.getItem("ml_last_update"));
  const [minutesTick, setMinutesTick] = useState(0);
  const [showMLModal, setShowMLModal] = useState(false);
  const [darkMode, setDarkMode] = useState(() => localStorage.getItem("darkMode") === "1");
  const [metaMensal, setMetaMensal] = useState(() => parseFloat(localStorage.getItem("metaMensal") || "0"));
  const [impostos, setImpostos] = useState(() => {
    try { return JSON.parse(localStorage.getItem("impostos_config") || "[]"); } catch { return []; }
  });
  const [custosFixos, setCustosFixos] = useState(() => {
    try { return JSON.parse(localStorage.getItem("custos_fixos_config") || "[]"); } catch { return []; }
  });
  const [showNotif, setShowNotif] = useState(false);
  const [showBackup, setShowBackup] = useState(false);
  const [notificacoes, setNotificacoes] = useState(() => {
    try { return JSON.parse(localStorage.getItem("ml_notificacoes") || "[]"); } catch { return []; }
  });
  const [ultimosPedidosIds, setUltimosPedidosIds] = useState(() => {
    try { return JSON.parse(localStorage.getItem("ml_ultimos_pedidos") || "[]"); } catch { return []; }
  });
  const [periodoFiltro, setPeriodoFiltro] = useState("mes"); // hoje | semana | mes | ano | custom
  const [periodoCustomDe, setPeriodoCustomDe] = useState("");
  const [periodoCustomAte, setPeriodoCustomAte] = useState("");
  // ── Financeiro ────────────────────────────────────────────
  const [contasPagar, setContasPagar] = useState(() => {
    try { return JSON.parse(localStorage.getItem("contas_pagar") || "[]"); } catch { return []; }
  });
  const [contasBancarias, setContasBancarias] = useState(() => {
    try { return JSON.parse(localStorage.getItem("contas_bancarias") || "[]"); } catch { return []; }
  });
  const [categoriasPagar, setCategoriasPagar] = useState(() => {
    try { return JSON.parse(localStorage.getItem("categorias_pagar") || JSON.stringify(["Fornecedor","Aluguel","Funcionário","Marketing","Frete","Impostos","Outros"])); } catch { return ["Fornecedor","Aluguel","Funcionário","Marketing","Frete","Impostos","Outros"]; }
  });
  const [lancamentos, setLancamentos] = useState(() => {
    try { return JSON.parse(localStorage.getItem("lancamentos") || "[]"); } catch { return []; }
  });
  const [finTab, setFinTab] = useState("resumo");
  const [produtos, setProdutos] = useState(() => {
    try { return JSON.parse(localStorage.getItem("produtos_cadastro") || "[]"); } catch { return []; }
  });
  const [fornecedores, setFornecedores] = useState(() => {
    try { return JSON.parse(localStorage.getItem("fornecedores_cadastro") || "[]"); } catch { return []; }
  });
  const [notasFiscais, setNotasFiscais] = useState(() => {
    try { return JSON.parse(localStorage.getItem("notas_fiscais_entrada") || "[]"); } catch { return []; }
  });
  const [paymentData, setPaymentData] = useState({}); // orderId → { releaseDate, netAmount }
  const [loadError, setLoadError] = useState(null);

  const usingMock = !token || realListings.length === 0;

  // Renova token automaticamente se estiver próximo de vencer
  async function getValidToken() {
    const saved = loadSavedTokens();
    if (!saved) return token;
    // Renova se vence em menos de 10 minutos
    if (saved.expiry - Date.now() < 600000 && saved.refreshToken) {
      try {
        const data = await refreshAccessToken(saved.refreshToken);
        saveTokens(data.access_token, data.refresh_token, data.expires_in, saved.userId, user?.nickname || "");
        setToken(data.access_token);
        return data.access_token;
      } catch(e) { console.warn("Falha ao renovar token:", e); }
    }
    return saved.accessToken;
  }

  async function handleConnect(tk, userId) {
    const validTk = tk;
    setToken(validTk); setShowMLModal(false);
    setLoading(true); setLoadError(null);
    try {
      setLoadingMsg("Identificando conta...");
      const meRes = await fetch(ML("/users/me"), { headers: { Authorization: `Bearer ${validTk}` } });
      const me = await meRes.json();
      if (!me.id) throw new Error("Token inválido");
      setUser({ nickname: me.nickname ?? "Minha Conta ML", id: me.id });
      // Atualiza nickname salvo
      const saved = loadSavedTokens();
      if (saved) saveTokens(saved.accessToken, saved.refreshToken, (saved.expiry - Date.now()) / 1000, me.id, me.nickname);

      setLoadingMsg("Buscando anúncios...");
      const listings = await fetchAllListings(me.id, validTk);
      setRealListings(listings);

      // Auto-importar anúncios para cadastro de produtos
      setLoadingMsg("Sincronizando produtos com ML...");
      const produtosAtuais = JSON.parse(localStorage.getItem("produtos_cadastro") || "[]");
      const produtosSincronizados = syncListingsToProdutos(listings, produtosAtuais);
      localStorage.setItem("produtos_cadastro", JSON.stringify(produtosSincronizados));
      // Atualizar state de produtos se existir
      setProdutos(produtosSincronizados);

      setLoadingMsg("Buscando pedidos...");
      const orders = await fetchAllOrders(me.id, validTk);
      setRealOrders(orders);
      // Guardar temporariamente para usar depois

      setLoadingMsg("Buscando custo de frete por anúncio...");
      const shippingMap = {};
      for (let i = 0; i < listings.length; i += 5) {
        const batch = listings.slice(i, i + 5);
        const results = await Promise.all(
          batch.map(l => fetchSellerShippingCost(l.id, me.id, validTk).then(cost => ({ id: l.id, cost })))
        );
        results.forEach(r => { shippingMap[r.id] = r.cost; });
        if (i % 50 === 0) setLoadingMsg(`Buscando frete... ${Math.min(i + 5, listings.length)}/${listings.length}`);
      }
      setSellerShipping(shippingMap);

      // Buscar frete real via /shipments/{id}/costs → senders[0].save
      // Confirmado: senders[0].save = 28.35 = valor exato debitado do vendedor
      setLoadingMsg("Buscando frete dos pedidos...");
      const orderShippingMap = {};
      const shipmentStatusMap = {};
      const ordersWithShipping = orders.filter(o => o.shipping?.id);
      for (let i = 0; i < ordersWithShipping.length; i += 5) {
        const batch = ordersWithShipping.slice(i, i + 5);
        await Promise.all(batch.map(async o => {
          try {
            // Buscar /costs para frete e /shipments para status
            const [costsRes, shipRes] = await Promise.all([
              fetch(ML(`/shipments/${o.shipping.id}/costs`), { headers: { Authorization: `Bearer ${validTk}` } }),
              fetch(ML(`/shipments/${o.shipping.id}`), { headers: { Authorization: `Bearer ${tk}` } })
            ]);
            const costsData = await costsRes.json();
            const shipData = await shipRes.json();
            const save = parseFloat(costsData?.senders?.[0]?.save);
            orderShippingMap[String(o.id)] = isNaN(save) ? 0 : save;
            // status: "delivered", "shipped", "ready_to_ship", "pending", etc
            shipmentStatusMap[String(o.id)] = shipData?.status ?? null;
          } catch { orderShippingMap[String(o.id)] = 0; }
        }));
        if (i % 20 === 0) setShipmentCosts({...orderShippingMap});
        await new Promise(r => setTimeout(r, 100));
      }
      setShipmentCosts({...orderShippingMap});
      setShipmentStatuses({...shipmentStatusMap});

      // Buscar dados de pagamento via /payments/{payment_id}
      // Este endpoint retorna money_release_date e net_received_amount reais
      setLoadingMsg("Buscando previsão de pagamento...");
      const paymentMap = {};
      const paidOrders = orders.filter(o => o.status === "paid" && o.payments?.[0]?.id);
      for (let i = 0; i < paidOrders.length; i += 5) {
        const batch = paidOrders.slice(i, i + 5);
        await Promise.all(batch.map(async o => {
          const oid = String(o.id);
          const pmtId = o.payments?.find(p => p.status === "approved")?.id || o.payments?.[0]?.id;
          if (!pmtId) return;
          try {
            const res = await fetch(ML(`/payments/${pmtId}`), { headers: { Authorization: `Bearer ${validTk}` } });
            const data = await res.json();
            if (data.error) return;
            const releaseDate = data.money_release_date?.slice(0, 10) ?? null;
            const netAmount = parseFloat(data.net_received_amount ?? data.transaction_amount ?? 0);
            if (releaseDate || netAmount > 0) {
              paymentMap[oid] = { releaseDate, netAmount };
            }
          } catch { /* ignora */ }
        }));
        if (i % 20 === 0) setPaymentData({...paymentMap});
        await new Promise(r => setTimeout(r, 150));
      }
      setPaymentData({...paymentMap});

      setLoadingMsg("Buscando promoções...");
      const promoMap = {};
      for (let i = 0; i < listings.length; i += 10) {
        const batch = listings.slice(i, i + 10);
        const results = await Promise.all(
          batch.map(l => fetchPromoPrice(l.id, validTk).then(promo => ({ id: l.id, promo })))
        );
        results.forEach(r => { if (r.promo) promoMap[r.id] = r.promo; });
      }
      setPromos(promoMap);

    } catch (e) { setLoadError(e.message); }
    setLoading(false); setLoadingMsg("");
    const now = Date.now().toString();
    localStorage.setItem("ml_last_update", now);
    setLastUpdate(now);

    // ── Verificar novos pedidos e estoque baixo ─────────
    const savedIds = JSON.parse(localStorage.getItem("ml_ultimos_pedidos") || "[]");
    const novasNotifs = [];

    // Novos pedidos (IDs que não existiam antes)
    orders.forEach(o => {
      if (o.status === "paid" && !savedIds.includes(String(o.id))) {
        const titulo = o.order_items?.[0]?.item?.title?.slice(0,40) || "Novo pedido";
        const valor = o.total_amount || (o.order_items?.[0]?.unit_price * o.order_items?.[0]?.quantity) || 0;
        novasNotifs.push({
          id: `order_${o.id}_${Date.now()}`,
          tipo: "pedido",
          titulo: "🛒 Novo pedido!",
          msg: `Pedido #${o.id} — ${titulo} — R$ ${parseFloat(valor).toFixed(2).replace(".",",")}`,
          data: new Date().toLocaleString("pt-BR"),
          lido: false,
        });
      }
    });

    // Estoque baixo nos produtos cadastrados
    const produtosAtual = JSON.parse(localStorage.getItem("produtos_cadastro") || "[]");
    const jaNotifEstoque = JSON.parse(localStorage.getItem("ml_notif_estoque") || "[]");
    produtosAtual.forEach(p => {
      if (p.estoqueMinimo && p.estoqueAtual !== undefined &&
          parseFloat(p.estoqueAtual) <= parseFloat(p.estoqueMinimo) &&
          !jaNotifEstoque.includes(String(p.id))) {
        novasNotifs.push({
          id: `estoque_${p.id}_${Date.now()}`,
          tipo: "estoque",
          titulo: "⚠️ Estoque crítico!",
          msg: `${p.titulo?.slice(0,45)} — ${p.estoqueAtual} un (mín: ${p.estoqueMinimo})`,
          data: new Date().toLocaleString("pt-BR"),
          lido: false,
        });
        jaNotifEstoque.push(String(p.id));
      }
    });
    localStorage.setItem("ml_notif_estoque", JSON.stringify(jaNotifEstoque));

    // Salva todos os IDs de pedidos vistos
    const todosIds = [...new Set([...savedIds, ...orders.map(o => String(o.id))])];
    localStorage.setItem("ml_ultimos_pedidos", JSON.stringify(todosIds));
    setUltimosPedidosIds(todosIds);

    if (novasNotifs.length > 0) {
      const todasNotifs = [...novasNotifs, ...JSON.parse(localStorage.getItem("ml_notificacoes") || "[]")].slice(0, 50);
      localStorage.setItem("ml_notificacoes", JSON.stringify(todasNotifs));
      setNotificacoes(todasNotifs);
      if (typeof Notification !== "undefined" && Notification.permission === "granted") {
        novasNotifs.slice(0,3).forEach(n => {
          try { new Notification(n.titulo, { body: n.msg }); } catch {}
        });
      }
    }
  }

  const MOCK_LISTINGS = [
    {
      id: "MLB6685879548", seller_sku: "1461", listing_type_id: "gold_premium",
      title: "Lanterna Traseira Gol G4 2006 2007 2008 A 2014 Fume Vermelho Direito Passageiro",
      price: 61.69, original_price: 62.34,
      sold_quantity: 0, status: "active",
      permalink: "https://www.mercadolivre.com.br",
      shipping: { free_shipping: false, logistic_type: "xd_drop_off" },
      pictures: [{}], description: { plain_text: "Lanterna traseira." },
      attributes: [{ id: "SELLER_SKU", name: "SKU", value_name: "1461" }], condition: "new"
    },
    {
      id: "MLB6581658690", seller_sku: "012", listing_type_id: "gold_premium",
      title: "Break Light Toyota Hilux 2016 2017 2018 2019 2020 A 2026",
      price: 102.99, original_price: 121.16,
      sold_quantity: 0, status: "active",
      permalink: "https://www.mercadolivre.com.br",
      shipping: { free_shipping: true, logistic_type: "xd_drop_off" },
      pictures: [{},{},{},{},{},{}],
      description: { plain_text: "Break light Toyota Hilux original novo." },
      attributes: [{ id: "SELLER_SKU", name: "SKU", value_name: "012" }], condition: "new"
    },
  ];

  const MOCK_PROMOS = {
    "MLB6685879548": { salePrice: 61.69, originalPrice: 62.34 },
    "MLB6581658690": { salePrice: 102.99, originalPrice: 121.16 },
  };

  const MOCK_SHIPPING = {
    "MLB6685879548": 8.55,
    "MLB6581658690": 15.45,
  };

  const MOCK_ORDERS = [
    { id: "2000001", listing_id: "MLB6685879548", date: "2026-05-13", price: 61.69, qty: 1, seller_shipping_cost: 8.55 },
    { id: "2000002", listing_id: "MLB6581658690", date: "2026-05-10", price: 102.99, qty: 1, seller_shipping_cost: 15.45 },
  ];

  const listings = usingMock ? MOCK_LISTINGS : realListings;
  const shippingData = usingMock ? MOCK_SHIPPING : sellerShipping;
  const promosData = usingMock ? MOCK_PROMOS : promos;

  const rawOrders = usingMock ? MOCK_ORDERS : realOrders.map(o => {
    const item = o.order_items?.[0];
    const buyerShippingCost = parseFloat(o.payments?.[0]?.shipping_cost) || 0;
    const shipmentCost = shipmentCosts[String(o.id)] ?? 0;
    return {
      id: String(o.id),
      listing_id: item?.item?.id,
      title: item?.item?.title ?? null,
      date: o.date_created?.slice(0, 10),
      price: item?.unit_price ?? o.total_amount ?? 0,
      qty: item?.quantity ?? 1,
      seller_shipping_cost: shipmentCost,
      buyer_shipping_cost: buyerShippingCost,
      permalink: item?.item?.id ? `https://www.mercadolivre.com.br/p/${item.item.id}` : null,
      status: o.status ?? "paid",
      tags: o.tags ?? [],
      fulfilled: o.fulfilled,
      shipment_status: shipmentStatuses[String(o.id)] ?? null,
    };
  });

  const enriched = listings.map(l => {
    const cost = costs[l.id] ?? 0;
    const feeRate = getRealFeeRate(l);
    const promoData = promosData[l.id];
    const { salePrice: salePriceApi, originalPrice: originalPriceApi, hasPromo: hasPromoApi } = getPrices(l);
    const salePrice = promoData ? promoData.salePrice : salePriceApi;
    const originalPrice = promoData ? promoData.originalPrice : originalPriceApi;
    const hasPromo = promoData ? true : hasPromoApi;
    const freteSeller = shippingData[l.id] ?? 0;
    const margin = calcMargin(salePrice, cost, feeRate, freteSeller);
    const { score, checks } = calcQualityScore(l);
    const sku = getSku(l);
    const youReceive = salePrice - margin.fee - freteSeller;
    return { ...l, ...margin, cost, sku, salePrice, originalPrice, hasPromo, freteSeller, youReceive, totalProfit: margin.profit * (l.sold_quantity ?? 0), score, checks };
  });

  const filteredListings = useMemo(() => {
    const q = searchListings.toLowerCase().trim();
    let results = enriched;
    if (q) {
      results = results.filter(l => {
        if (searchType === "title") return l.title?.toLowerCase().includes(q);
        if (searchType === "sku") {
          const sku = (l.sku || l.seller_sku || "").toLowerCase();
          return sku === q || sku.startsWith(q + " ") || sku.endsWith(" " + q);
        }
        if (searchType === "mlb") return l.id?.toLowerCase() === q || l.id?.toLowerCase().includes(q);
        // "all" - busca em tudo
        return (
          l.title?.toLowerCase().includes(q) ||
          l.id?.toLowerCase().includes(q) ||
          (l.sku && l.sku.toLowerCase().includes(q)) ||
          (l.seller_sku && l.seller_sku.toLowerCase().includes(q)) ||
          l.attributes?.some(a => a.value_name?.toLowerCase().includes(q))
        );
      });
    }
    if (statusFilter === "active") results = results.filter(l => l.status === "active");
    if (statusFilter === "paused") results = results.filter(l => l.status === "paused");
    return results;
  }, [enriched, searchListings, searchType, statusFilter]);

  const sorted = [...filteredListings].sort((a, b) =>
    sortBy === "score" ? a.score - b.score :
    sortBy === "margin" ? (b.margin ?? -1) - (a.margin ?? -1) :
    sortBy === "sales_desc" ? (b.sold_quantity ?? 0) - (a.sold_quantity ?? 0) :
    sortBy === "sales_asc" ? (a.sold_quantity ?? 0) - (b.sold_quantity ?? 0) :
    b.totalProfit - a.totalProfit
  );

  const periodOrders = useMemo(() => {
    if (orderFilter === "all") return rawOrders;
    const now = new Date();
    if (orderFilter === "today") {
      const todayStr = now.toLocaleDateString("sv-SE");
      return rawOrders.filter(o => o.date === todayStr);
    }
    const cutoff = new Date();
    if (orderFilter === "week") cutoff.setDate(now.getDate() - 7);
    else if (orderFilter === "month") cutoff.setMonth(now.getMonth() - 1);
    else if (orderFilter === "3months") cutoff.setMonth(now.getMonth() - 3);
    cutoff.setHours(0, 0, 0, 0);
    return rawOrders.filter(o => {
      if (!o.date) return false;
      return new Date(o.date + "T00:00:00") >= cutoff;
    });
  }, [rawOrders, orderFilter]);

  const filteredOrders = useMemo(() => {
    const q = searchOrders.toLowerCase().trim();
    // Se tem data customizada, usa rawOrders direto; senão usa periodOrders
    let results = (dateFrom || dateTo) ? rawOrders : periodOrders;
    if (dateFrom) results = results.filter(o => o.date && o.date >= dateFrom);
    if (dateTo) results = results.filter(o => o.date && o.date <= dateTo);
    if (q) results = results.filter(o => String(o.id).toLowerCase().includes(q));
    // Status: cancelado = status cancelled SEM tag de devolução
    // Devolvido = tem tag "not_delivered" + "not_paid" OU mediação com cancelamento
    if (orderStatusFilter === "waiting") {
      results = results.filter(o => {
        if (o.status !== "paid") return false;
        if (o.tags?.some(t => t.includes("refund"))) return false;
        const isDelivered = o.tags?.some(t => t === "delivered") || o.shipment_status === "delivered";
        if (isDelivered) return false;
        // ready_to_ship/handling/pending = ainda não postado → ag. envio
        return !["shipped", "in_transit"].includes(o.shipment_status);
      });
    } else if (orderStatusFilter === "done") {
      results = results.filter(o => o.status === "paid" && (o.tags?.some(t => t === "delivered") || o.shipment_status === "delivered"));
    } else if (orderStatusFilter === "shipped") {
      results = results.filter(o => {
        if (o.status !== "paid") return false;
        if (o.tags?.some(t => t.includes("refund"))) return false;
        const isDelivered = o.tags?.some(t => t === "delivered") || o.shipment_status === "delivered";
        if (isDelivered) return false;
        // Apenas shipped/in_transit = realmente postado
        return ["shipped", "in_transit"].includes(o.shipment_status);
      });
    } else if (orderStatusFilter === "cancelled") {
      results = results.filter(o => o.status === "cancelled" && !o.tags?.some(t => t === "delivered") && !o.tags?.some(t => t.includes("refund")));
    } else if (orderStatusFilter === "refunded") {
      results = results.filter(o => 
        o.tags?.some(t => t.includes("refund")) ||
        (o.status === "cancelled" && o.tags?.some(t => t === "delivered"))
      );
    } else if (orderStatusFilter === "mediation") {
      results = results.filter(o => o.tags?.some(t => t.includes("mediation")) || o.status === "in_mediation");
    }
    return results;
  }, [rawOrders, periodOrders, searchOrders, orderStatusFilter, dateFrom, dateTo]);

  const enrichedOrders = filteredOrders.map(o => {
    const listing = listings.find(l => l.id === o.listing_id);
    const cost = costs[listing?.id] ?? 0;
    const feeRate = listing ? getRealFeeRate(listing) : 0.12;
    // Frete: usa shipmentCosts[order_id] calculado como base_cost - buyer_paid
    const freteSeller = shipmentCosts[String(o.id)]
      ?? shippingData[o.listing_id]
      ?? shippingData[listing?.id]
      ?? 0;
    return { ...o, listing, ...calcMargin(o.price, cost, feeRate, freteSeller), cost, freteSeller };
  });

  // ── Filtro de período ────────────────────────────────────
  const hoje = new Date().toLocaleDateString("sv-SE");
  const getRange = () => {
    const now = new Date();
    if (periodoFiltro === "hoje") return [hoje, hoje];
    if (periodoFiltro === "semana") {
      const d = new Date(); d.setDate(d.getDate() - 6);
      return [d.toLocaleDateString("sv-SE"), hoje];
    }
    if (periodoFiltro === "mes") return [hoje.slice(0,7) + "-01", hoje];
    if (periodoFiltro === "ano") return [hoje.slice(0,4) + "-01-01", hoje];
    if (periodoFiltro === "custom") return [periodoCustomDe || "2000-01-01", periodoCustomAte || hoje];
    return ["2000-01-01", hoje];
  };
  const [rangeStart, rangeEnd] = getRange();
  const ordersFiltered = enrichedOrders.filter(o => o.date >= rangeStart && o.date <= rangeEnd);
  // rawOrdersFiltered usa TODOS os pedidos pagos (incluindo sem anúncio vinculado)
  // garante que a Receita Líquida bata com o faturamento real
  // Todos os pedidos no período (qualquer status)
  const rawOrdersFiltered = rawOrders.filter(o => o.status === "paid" && o.date >= rangeStart && o.date <= rangeEnd);
  // Faturamento BRUTO = todos os pedidos pagos (inclui cancelados e devolvidos)
  const allOrdersPeriodo = rawOrders.filter(o => o.date >= rangeStart && o.date <= rangeEnd);
  const canceladosDevolvidos = allOrdersPeriodo.filter(o =>
    o.status === "cancelled" ||
    o.tags?.some(t => t.includes("refund")) ||
    o.tags?.some(t => t === "refunded")
  );
  const fatBruto = allOrdersPeriodo.filter(o => o.status === "paid").reduce((s, o) => s + o.price * o.qty, 0);
  const totalCancelDevolv = canceladosDevolvidos.reduce((s, o) => s + o.price * (o.qty || 1), 0);
  const fatLiquido = fatBruto - totalCancelDevolv;

  const totalRevenue = fatLiquido;
  // Apenas pedidos CONCLUÍDOS (pagos, não cancelados, não devolvidos)
  // Usado para tarifas, frete e margem — valores que só se aplicam a vendas reais
  const ordersValidos = ordersFiltered.filter(o => {
    if (o.status === "cancelled") return false;
    if (o.tags?.some(t => t.includes("refund") || t === "refunded")) return false;
    return true;
  });

  const totalProfit = ordersValidos.reduce((s, o) => s + o.profit * o.qty, 0);
  const totalFees = ordersValidos.reduce((s, o) => s + o.fee * o.qty, 0);
  const totalFreteSeller = ordersValidos.reduce((s, o) => s + (o.freteSeller ?? 0), 0);
  const avgMargin = ordersValidos.length > 0 ? ordersValidos.reduce((s, o) => s + (o.margin ?? 0), 0) / ordersValidos.length : 0;
  const avgScore = Math.round(enriched.reduce((s, l) => s + l.score, 0) / (enriched.length || 1));

  function getFreteDisplay(l) {
    const hasFreeShipping = l.shipping?.free_shipping;
    const cost = l.freteSeller;
    if (hasFreeShipping) {
      return {
        topLabel: "Grátis ao comprador",
        topColor: "#15803d",
        topBg: "#f0fdf4",
        bottomLabel: cost > 0 ? `Seu custo: ${fmt(cost)}` : "Seu custo: calculando...",
        bottomColor: "#7c3aed",
      };
    }
    return {
      topLabel: "Comprador paga",
      topColor: "#2563eb",
      topBg: "#eff6ff",
      bottomLabel: cost > 0 ? `Seu custo: ${fmt(cost)}` : "Seu custo: calculando...",
      bottomColor: "#7c3aed",
    };
  }

  // Ticker para atualizar "última atualização" a cada minuto
  useEffect(() => {
    const interval = setInterval(() => setMinutesTick(t => t + 1), 60000);
    return () => clearInterval(interval);
  }, []);

  // Atualiza lastUpdate quando conectar
  useEffect(() => {
    const stored = localStorage.getItem("ml_last_update");
    if (stored) setLastUpdate(stored);
  }, [token]);

  if (!currentUser) return <LoginScreen onLogin={(user) => { setCurrentUser(user); }} />;

  return (
    <div className={darkMode?"dark":""} style={{ minHeight: "100vh", background: darkMode?"#0f172a":"#f8fafc", color: darkMode?"#e2e8f0":"#0f172a", fontFamily: "'Inter','Segoe UI',sans-serif", transition:"background .2s,color .2s" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        ::-webkit-scrollbar{width:5px;height:5px}::-webkit-scrollbar-track{background:#f1f5f9}::-webkit-scrollbar-thumb{background:#cbd5e1;border-radius:99px}
        input:focus,textarea:focus,select:focus{outline:2px solid #0f172a;outline-offset:1px}
        table{border-collapse:collapse;width:100%}
        th{font-size:11px;color:#94a3b8;text-transform:uppercase;letter-spacing:0.8px;padding:10px 14px;border-bottom:1px solid #f1f5f9;text-align:left;font-weight:600;background:#fafafa;white-space:nowrap}
        td{padding:10px 14px;font-size:13px;border-bottom:1px solid #f8fafc;vertical-align:middle;color:#334155}
        tr:last-child td{border-bottom:none}tr:hover td{background:#f8fafc}
        .dark th{background:#1e293b!important;border-bottom-color:#334155!important;color:#64748b!important}
        .dark td{border-bottom-color:#1e293b!important;color:#cbd5e1!important}
        .dark tr:hover td{background:#1e293b!important}
        .dark .tab-btn{color:#64748b}
        .dark .tab-btn.active{background:#334155;color:#e2e8f0}
        .dark .filter-btn{background:#1e293b;border-color:#334155;color:#94a3b8}
        .dark .filter-btn.active{background:#e2e8f0;color:#0f172a}
        .dark select{background:#1e293b;border-color:#334155;color:#e2e8f0}
        .dark input{background:#1e293b!important;border-color:#334155!important;color:#e2e8f0!important}
        .tab-btn{background:transparent;border:none;color:#94a3b8;padding:8px 18px;cursor:pointer;font-family:inherit;font-size:13px;border-radius:8px;transition:all .15s;font-weight:500}
        .tab-btn.active{background:#fff;color:#0f172a;font-weight:700;box-shadow:0 1px 3px rgba(0,0,0,.08)}
        .filter-btn{background:#fff;border:1px solid #e2e8f0;color:#64748b;padding:5px 14px;cursor:pointer;font-family:inherit;font-size:12px;border-radius:20px;transition:all .15s;font-weight:500}
        .filter-btn.active{background:#0f172a;border-color:#0f172a;color:#fff;font-weight:600}
        .filter-btn:hover:not(.active){background:#f1f5f9}
        .search-input{width:100%;background:#fff;border:1px solid #e2e8f0;color:#0f172a;padding:8px 14px 8px 38px;border-radius:8px;font-family:inherit;font-size:13px;outline:none;transition:border .15s}
        .search-input:focus{border-color:#0f172a}
        .copy-btn{background:transparent;border:none;color:#cbd5e1;cursor:pointer;padding:2px 5px;border-radius:4px;font-size:11px;transition:all .15s}
        .copy-btn:hover{background:#f1f5f9;color:#475569}
        .title-link{color:#0f172a;text-decoration:none;font-weight:500;transition:color .15s}
        .title-link:hover{color:#2563eb;text-decoration:underline}
        select{background:#fff;border:1px solid #e2e8f0;color:#334155;padding:6px 12px;border-radius:8px;font-family:inherit;font-size:12px;cursor:pointer;font-weight:500}
        @keyframes fadeUp{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}.fade-up{animation:fadeUp .3s ease forwards}
      `}</style>

      <header style={{ background: darkMode?"#1e293b":"#fff", borderBottom: `1px solid ${darkMode?"#334155":"#e2e8f0"}`, padding: "14px 32px", display: "flex", alignItems: "center", justifyContent: "space-between", position: "sticky", top: 0, zIndex: 100, boxShadow: "0 1px 3px rgba(0,0,0,.04)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ width: 36, height: 36, borderRadius: 10, background: "#0f172a", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 16, color: "#ffe000" }}>M</div>
          <div>
            <div style={{ fontWeight: 800, fontSize: 15, color: "#0f172a", letterSpacing: -0.3 }}>ML Margem</div>
            <div style={{ fontSize: 11, color: "#94a3b8", letterSpacing: 0.5 }}>DASHBOARD DE LUCRATIVIDADE</div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {usingMock && !token && <span style={{ background: "#f1f5f9", border: "1px solid #e2e8f0", color: "#94a3b8", fontSize: 11, padding: "3px 10px", borderRadius: 20, fontWeight: 500 }}>Demonstração</span>}
          {token && <span style={{ background: "#f0fdf4", border: "1px solid #bbf7d0", color: "#15803d", fontSize: 11, padding: "3px 12px", borderRadius: 20, fontWeight: 600 }}>● {user?.nickname}</span>}
          {loading && <span style={{ color: "#94a3b8", fontSize: 12 }}>⏳ {loadingMsg}</span>}
          {loadError && <span style={{ color: "#dc2626", fontSize: 12 }}>⚠ {loadError}</span>}
          {token && lastUpdate && (() => {
            const mins = Math.round((Date.now() - parseInt(lastUpdate)) / 60000);
            const horas = Math.floor(mins / 60);
            const isStale = mins >= 300; // avisa após 5h (token expira em 6h)
            return (
              <div style={{ fontSize:11, textAlign:"right", lineHeight:1.4 }}>
                <div style={{ color: isStale ? "#dc2626" : "#94a3b8" }}>
                  {isStale ? "⚠️ " : "✓ "}
                  {horas > 0 ? `${horas}h ${mins%60}min` : `${mins}min`} atrás
                </div>
                <div style={{ color:"#cbd5e1", fontSize:10 }}>
                  {isStale ? "Token próximo de expirar" : "dados atualizados"}
                </div>
              </div>
            );
          })()}
          <button onClick={() => setShowMLModal(true)} style={{ background: "#0f172a", border: "none", color: "#fff", fontWeight: 700, padding: "8px 20px", borderRadius: 8, cursor: "pointer", fontSize: 13 }}>
            {token ? "Reconectar" : "Conectar ML"}
          </button>
          <SinoNotificacoes
            notificacoes={notificacoes}
            setNotificacoes={setNotificacoes}
            darkMode={darkMode}
          />
          <button onClick={() => setShowBackup(true)}
            title="Backup e Restauração"
            style={{ background: darkMode?"#1e293b":"#f1f5f9", border:`1px solid ${darkMode?"#334155":"#e2e8f0"}`, color: darkMode?"#94a3b8":"#64748b", width:36, height:36, borderRadius:8, cursor:"pointer", fontSize:16 }}>
            💾
          </button>
          <button onClick={() => { const n = !darkMode; setDarkMode(n); localStorage.setItem("darkMode", n?"1":"0"); }}
            style={{ background: darkMode?"#334155":"#f1f5f9", border:"none", color: darkMode?"#fff":"#475569", width:36, height:36, borderRadius:8, cursor:"pointer", fontSize:18 }}>
            {darkMode ? "☀️" : "🌙"}
          </button>
          <div style={{ display:"flex", alignItems:"center", gap:8, background: darkMode?"#1e293b":"#f8fafc", border:`1px solid ${darkMode?"#334155":"#e2e8f0"}`, borderRadius:8, padding:"5px 10px" }}>
            <div style={{ width:26, height:26, borderRadius:8, background:"#0f172a", display:"flex", alignItems:"center", justifyContent:"center", fontSize:12, fontWeight:800, color:"#ffe000" }}>
              {currentUser?.nome?.charAt(0).toUpperCase()}
            </div>
            <div style={{ fontSize:12, lineHeight:1.3 }}>
              <div style={{ fontWeight:600, color: darkMode?"#e2e8f0":"#0f172a" }}>{currentUser?.nome}</div>
              <div style={{ color:"#94a3b8", fontSize:10 }}>{currentUser?.admin?"Admin":"Usuário"}</div>
            </div>
          </div>
          <button onClick={() => { clearSession(); clearSavedTokens(); setCurrentUser(null); setToken(null); setUser(null); }}
            style={{ background:"#fef2f2", border:"1px solid #fecaca", color:"#dc2626", fontWeight:600, padding:"7px 14px", borderRadius:8, cursor:"pointer", fontSize:12 }}>
            Sair
          </button>
        </div>
      </header>

      <main style={{ maxWidth: 1440, margin: "0 auto", padding: "24px 32px" }}>
        {/* ── FILTRO DE PERÍODO ── */}
        <div style={{ display:"flex", gap:6, alignItems:"center", marginBottom:12, flexWrap:"wrap" }}>
          <span style={{ fontSize:12, color:"#94a3b8", fontWeight:500 }}>Período:</span>
          {[
            { key:"hoje", label:"Hoje" },
            { key:"semana", label:"7 dias" },
            { key:"mes", label:"Este mês" },
            { key:"ano", label:"Este ano" },
            { key:"tudo", label:"Tudo" },
            { key:"custom", label:"Personalizado" },
          ].map(p => (
            <button key={p.key} onClick={() => setPeriodoFiltro(p.key)}
              style={{ padding:"5px 14px", borderRadius:20, border:"none", cursor:"pointer", fontSize:12, fontWeight:periodoFiltro===p.key?700:500,
                background:periodoFiltro===p.key?"#0f172a":"#f1f5f9",
                color:periodoFiltro===p.key?"#fff":"#64748b" }}>
              {p.label}
            </button>
          ))}
          {periodoFiltro === "custom" && (
            <>
              <input type="date" value={periodoCustomDe} onChange={e=>setPeriodoCustomDe(e.target.value)}
                style={{ background:"#fff", border:"1px solid #e2e8f0", color:"#334155", padding:"4px 10px", borderRadius:8, fontSize:12 }} />
              <span style={{ fontSize:12, color:"#94a3b8" }}>até</span>
              <input type="date" value={periodoCustomAte} onChange={e=>setPeriodoCustomAte(e.target.value)}
                style={{ background:"#fff", border:"1px solid #e2e8f0", color:"#334155", padding:"4px 10px", borderRadius:8, fontSize:12 }} />
            </>
          )}
          <span style={{ fontSize:11, color:"#94a3b8", marginLeft:4 }}>{rawOrdersFiltered.length} pedido(s)</span>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 12, marginBottom: 24 }} className="fade-up">
          {[
            { label: "Fat. Bruto", value: fmt(fatBruto), color: "#0f172a", desc: `${allOrdersPeriodo.filter(o=>o.status==="paid").length} pedidos` },
            { label: "Fat. Líquido", value: fmt(fatLiquido), color: fatLiquido >= fatBruto ? "#0f172a" : "#dc2626", desc: canceladosDevolvidos.length > 0 ? `-${canceladosDevolvidos.length} cancel./devolv.` : "sem cancelamentos" },
            { label: "Tarifas ML", value: fmt(totalFees), color: "#d97706" },
            { label: "Frete (seu custo)", value: fmt(totalFreteSeller), color: "#7c3aed" },
            { label: "Margem média", value: fmtPct(avgMargin), color: avgMargin >= .25 ? "#15803d" : avgMargin >= .15 ? "#d97706" : "#dc2626" },
            { label: "Impostos (mês)", value: (() => { const v = impostos.reduce((s,i)=>s+(i.tipo==="%"?(totalRevenue*(parseFloat(i.valor||0)/100)):(parseFloat(i.valor||0))),0); return `R$ ${v.toFixed(2).replace(".",",")}` })(), color: "#dc2626" },
            { label: "Custos Fixos (mês)", value: (() => { const v = custosFixos.reduce((s,c)=>s+(c.tipo==="%"?(totalRevenue*(parseFloat(c.valor||0)/100)):(parseFloat(c.valor||0))),0); return `R$ ${v.toFixed(2).replace(".",",")}` })(), color: "#d97706" },
            { label: "Lucro Real", value: (() => { const imp = impostos.reduce((s,i)=>s+(i.tipo==="%"?(totalRevenue*(parseFloat(i.valor||0)/100)):(parseFloat(i.valor||0))),0); const fix = custosFixos.reduce((s,c)=>s+(c.tipo==="%"?(totalRevenue*(parseFloat(c.valor||0)/100)):(parseFloat(c.valor||0))),0); const lucro = fatLiquido - totalFees - totalFreteSeller - imp - fix; return `R$ ${lucro.toFixed(2).replace(".",",")}` })(), color: (() => { const imp = impostos.reduce((s,i)=>s+(i.tipo==="%"?(totalRevenue*(parseFloat(i.valor||0)/100)):(parseFloat(i.valor||0))),0); const fix = custosFixos.reduce((s,c)=>s+(c.tipo==="%"?(totalRevenue*(parseFloat(c.valor||0)/100)):(parseFloat(c.valor||0))),0); const lucro = fatLiquido - totalFees - totalFreteSeller - imp - fix; return lucro>=0?"#15803d":"#dc2626" })() },
            { label: "Score médio", value: `${avgScore}/100`, color: scoreColor(avgScore) },
            { label: "Total anúncios", value: enriched.length, color: "#0f172a" },
            { label: "Pedidos período", value: enrichedOrders.length, color: "#0f172a" },
          ].map(k => (
            <div key={k.label} style={{ background: darkMode?"#1e293b":"#fff", border: `1px solid ${darkMode?"#334155":"#e2e8f0"}`, borderRadius: 12, padding: "16px 18px", boxShadow: "0 1px 2px rgba(0,0,0,.04)" }}>
              <div style={{ fontSize: 11, color: "#94a3b8", marginBottom: 8, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.8 }}>{k.label}</div>
              <div style={{ fontSize: 20, fontWeight: 800, color: k.color, letterSpacing: -0.5 }}>{k.value}</div>
              {k.desc && <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 4 }}>{k.desc}</div>}
            </div>
          ))}
        </div>

        <div style={{ display: "flex", gap: 2, marginBottom: 20, background: darkMode?"#1e293b":"#f1f5f9", padding: 4, borderRadius: 10, width: "fit-content" }}>
          {currentUser?.permissoes?.includes("overview") && <button className={`tab-btn ${tab === "overview" ? "active" : ""}`} onClick={() => setTab("overview")}>🏠 Visão Geral</button>}
          {currentUser?.permissoes?.includes("listings") && <button className={`tab-btn ${tab === "listings" ? "active" : ""}`} onClick={() => setTab("listings")}>Anúncios ({enriched.length})</button>}
          {currentUser?.permissoes?.includes("orders") && <button className={`tab-btn ${tab === "orders" ? "active" : ""}`} onClick={() => setTab("orders")}>Pedidos ({enrichedOrders.length})</button>}
          {currentUser?.permissoes?.includes("financeiro") && <button className={`tab-btn ${tab === "financeiro" ? "active" : ""}`} onClick={() => setTab("financeiro")}>💰 Financeiro</button>}
          {currentUser?.admin && <button className={`tab-btn ${tab === "admin" ? "active" : ""}`} onClick={() => setTab("admin")}>⚙️ Usuários</button>}
          {currentUser?.permissoes?.includes("produtos") && <button className={`tab-btn ${tab === "produtos" ? "active" : ""}`} onClick={() => setTab("produtos")}>📦 Produtos</button>}
          {currentUser?.permissoes?.includes("produtos") && <button className={`tab-btn ${tab === "nf" ? "active" : ""}`} onClick={() => setTab("nf")}>🧾 Notas Fiscais</button>}
        </div>

        {tab === "overview" && currentUser?.permissoes?.includes("overview") && (
          <OverviewTab
            enriched={enriched}
            enrichedOrders={enrichedOrders}
            rawOrders={rawOrders}
            contasPagar={contasPagar}
            contasBancarias={contasBancarias}
            lancamentos={lancamentos}
            paymentData={paymentData}
            shipmentStatuses={shipmentStatuses}
            metaMensal={metaMensal}
            setMetaMensal={setMetaMensal}
            darkMode={darkMode}
            costs={costs}
            impostos={impostos}
            setImpostos={setImpostos}
            custosFixos={custosFixos}
            setCustosFixos={setCustosFixos}
          />
        )}

                {tab === "listings" && currentUser?.permissoes?.includes("listings") && (
          <>
            <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 16, flexWrap: "wrap" }}>
              <div style={{ display: "flex", gap: 6, flex: 1, minWidth: 260 }}>
                <div style={{ position: "relative", flex: 1 }}>
                  <span style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", color: "#94a3b8", fontSize: 14 }}>🔍</span>
                  <input className="search-input" value={searchListings} onChange={e => setSearchListings(e.target.value)}
                    placeholder={searchType === "title" ? "Buscar por título..." : searchType === "sku" ? "Buscar por SKU exato..." : searchType === "mlb" ? "Buscar por MLB..." : "Buscar por título, MLB ou SKU..."} />
                </div>
                <select value={searchType} onChange={e => setSearchType(e.target.value)} style={{ minWidth: 110 }}>
                  <option value="all">Tudo</option>
                  <option value="title">Título</option>
                  <option value="sku">SKU exato</option>
                  <option value="mlb">MLB</option>
                </select>
              </div>
              <div style={{ display: "flex", gap: 4 }}>
                {[{ key: "all", label: "Todos" }, { key: "active", label: "● Ativos" }, { key: "paused", label: "○ Pausados" }].map(f => (
                  <button key={f.key} onClick={() => setStatusFilter(f.key)}
                    style={{ padding: "6px 14px", borderRadius: 20, border: "1px solid #e2e8f0", cursor: "pointer", fontFamily: "inherit", fontSize: 12, fontWeight: 500, transition: "all .15s",
                      background: statusFilter === f.key ? "#0f172a" : "#fff",
                      color: statusFilter === f.key ? "#fff" : f.key === "active" ? "#15803d" : f.key === "paused" ? "#94a3b8" : "#64748b",
                      borderColor: statusFilter === f.key ? "#0f172a" : "#e2e8f0" }}>
                    {f.label}
                  </button>
                ))}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 12, color: "#94a3b8", fontWeight: 500 }}>Ordenar:</span>
                <select value={sortBy} onChange={e => setSortBy(e.target.value)}>
                  <option value="score">Pior score primeiro</option>
                  <option value="margin">Maior margem</option>
                  <option value="profit">Maior lucro total</option>
                  <option value="sales_desc">Maior nº de vendas</option>
                  <option value="sales_asc">Menor nº de vendas</option>
                </select>
              </div>
              <span style={{ fontSize: 12, color: "#94a3b8" }}>{sorted.length} anúncio{sorted.length !== 1 ? "s" : ""}</span>
            </div>

            <div style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 12, overflow: "auto", boxShadow: "0 1px 3px rgba(0,0,0,.04)" }}>
              <table>
                <thead>
                  <tr>
                    <th>Foto</th>
                    <th>Anúncio</th>
                    <th>MLB / SKU</th>
                    <th>Estoque / Mín.</th>
                    <th>Score</th>
                    <th>Tipo</th>
                    <th>Preço original</th>
                    <th>Preço venda</th>
                    <th>Taxa ML</th>
                    <th>Frete (seu custo)</th>
                    <th>Você recebe</th>
                    <th>Custo produto</th>
                    <th>Lucro unit.</th>
                    <th>Margem</th>
                    <th>Lucro total</th>
                    <th>IA</th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.length === 0 ? (
                    <tr><td colSpan={15} style={{ textAlign: "center", color: "#94a3b8", padding: 40 }}>Nenhum anúncio encontrado</td></tr>
                  ) : sorted.map(l => {
                    const frete = getFreteDisplay(l);
                    const typeInfo = getListingTypeLabel(l.listing_type_id);
                    return (
                      <tr key={l.id}>
                        <td style={{ width: 56, padding: "8px 8px 8px 14px" }}>
                          <a href={l.permalink ?? `https://www.mercadolivre.com.br/p/${l.id}`} target="_blank" rel="noreferrer">
                            {l.pictures?.[0]?.url ? (
                              <img src={l.pictures[0].url} alt="" style={{ width: 44, height: 44, objectFit: "cover", borderRadius: 8, border: "1px solid #e2e8f0", display: "block" }} />
                            ) : (
                              <div style={{ width: 44, height: 44, borderRadius: 8, background: "#f1f5f9", border: "1px solid #e2e8f0", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>📦</div>
                            )}
                          </a>
                        </td>
                        <td style={{ maxWidth: 220 }}>
                          <a href={l.permalink ?? `https://www.mercadolivre.com.br/p/${l.id}`} target="_blank" rel="noreferrer" className="title-link"
                            style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={l.title}>
                            {l.title}
                          </a>
                          <div style={{ display: "flex", gap: 4, marginTop: 5, flexWrap: "wrap" }}>
                            {l.checks.filter(c => !c.pass).slice(0, 2).map(c => (
                              <span key={c.key} style={{ fontSize: 10, color: "#b91c1c", background: "#fef2f2", border: "1px solid #fecaca", padding: "1px 6px", borderRadius: 4, fontWeight: 500 }}>✗ {c.label}</span>
                            ))}
                            <span style={{ fontSize: 10, padding: "1px 7px", borderRadius: 4, fontWeight: 500, background: l.status === "active" ? "#f0fdf4" : "#f8fafc", color: l.status === "active" ? "#15803d" : "#94a3b8", border: `1px solid ${l.status === "active" ? "#bbf7d0" : "#e2e8f0"}` }}>
                              {l.status === "active" ? "● ativo" : "○ pausado"}
                            </span>
                          </div>
                        </td>
                        <td>
                          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                            <span style={{ fontSize: 11, color: "#334155", fontFamily: "monospace", fontWeight: 600 }}>{l.id}</span>
                            <button className="copy-btn" onClick={() => navigator.clipboard.writeText(l.id)}>⎘</button>
                          </div>
                          {l.sku ? (
                            <div style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 3 }}>
                              <span style={{ fontSize: 10, color: "#94a3b8" }}>SKU:</span>
                              <span style={{ fontSize: 11, color: "#64748b", fontFamily: "monospace", fontWeight: 600 }}>{l.sku}</span>
                              <button className="copy-btn" onClick={() => navigator.clipboard.writeText(l.sku)}>⎘</button>
                            </div>
                          ) : <div style={{ fontSize: 10, color: "#cbd5e1", marginTop: 3 }}>SKU: —</div>}
                        </td>
                        <td>
                          {(() => {
                            const qty = l.available_quantity ?? 0;
                            const min = minStock[l.id] ?? 0;
                            const abaixo = min > 0 && qty < min;
                            const color = abaixo ? "#dc2626" : qty === 0 ? "#dc2626" : qty <= 5 ? "#d97706" : "#15803d";
                            const bg = abaixo ? "#fef2f2" : qty === 0 ? "#fef2f2" : qty <= 5 ? "#fffbeb" : "#f0fdf4";
                            return (
                              <div>
                                <span style={{ fontWeight: 700, fontSize: 13, color, background: bg, padding: "3px 10px", borderRadius: 6, display: "inline-block", marginBottom: 4 }}>
                                  {qty} un. {abaixo ? "⚠" : ""}
                                </span>
                                <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                                  <span style={{ fontSize: 10, color: "#94a3b8" }}>Mín:</span>
                                  <input type="number" value={minStock[l.id] ?? ""} onChange={e => setMinStock(m => ({ ...m, [l.id]: Number(e.target.value) }))} placeholder="0"
                                    style={{ background: "#f8fafc", border: "1px solid #e2e8f0", color: "#0f172a", padding: "2px 6px", borderRadius: 4, width: 52, fontSize: 11, textAlign: "right" }} />
                                </div>
                              </div>
                            );
                          })()}
                        </td>
                        <td>
                          <div style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 10px", borderRadius: 8, background: scoreBg(l.score) }}>
                            <span style={{ fontSize: 13, fontWeight: 800, color: scoreColor(l.score) }}>{l.score}</span>
                            <span style={{ fontSize: 11, color: scoreColor(l.score), fontWeight: 600 }}>{scoreLabel(l.score)}</span>
                          </div>
                        </td>
                        <td><span style={{ fontSize: 11, color: typeInfo.color, fontWeight: 600 }}>{typeInfo.label}</span></td>
                        <td>
                          {l.hasPromo ? (
                            <span style={{ fontSize: 13, color: "#94a3b8", textDecoration: "line-through" }}>{fmt(l.originalPrice)}</span>
                          ) : (
                            <span style={{ fontWeight: 700, color: "#0f172a", fontSize: 13 }}>{fmt(l.originalPrice)}</span>
                          )}
                        </td>
                        <td>
                          {l.hasPromo ? (
                            <div>
                              <span style={{ fontWeight: 700, color: "#dc2626", fontSize: 13 }}>{fmt(l.salePrice)}</span>
                              <span style={{ fontSize: 10, color: "#dc2626", background: "#fef2f2", padding: "1px 6px", borderRadius: 4, fontWeight: 600, marginLeft: 4 }}>Promo</span>
                            </div>
                          ) : (
                            <span style={{ fontWeight: 700, color: "#0f172a" }}>{fmt(l.salePrice)}</span>
                          )}
                        </td>
                        <td>
                          <span style={{ color: "#d97706", fontWeight: 700 }}>{fmt(l.fee)}</span>
                          <div style={{ fontSize: 10, color: "#94a3b8" }}>{fmtPct(l.feeRate)}</div>
                        </td>
                        <td>
                          <div style={{ fontSize: 11, color: frete.topColor, background: frete.topBg, padding: "2px 7px", borderRadius: 5, fontWeight: 600, display: "inline-block", marginBottom: 3 }}>{frete.topLabel}</div>
                          <div style={{ fontSize: 11, color: frete.bottomColor, fontWeight: 700 }}>{frete.bottomLabel}</div>
                        </td>
                        <td>
                          <span style={{ fontWeight: 700, color: "#15803d", fontSize: 13 }}>{fmt(l.youReceive)}</span>
                          <div style={{ fontSize: 10, color: "#94a3b8" }}>após tarifa e frete</div>
                        </td>
                        <td>
                          <input type="number" value={l.cost || ""} onChange={e => setCosts(c => ({ ...c, [l.id]: Number(e.target.value) }))} placeholder="0,00"
                            style={{ background: "#f8fafc", border: "1px solid #e2e8f0", color: "#0f172a", padding: "5px 8px", borderRadius: 6, width: 80, fontSize: 12, textAlign: "right" }} />
                        </td>
                        <td style={{ color: l.profit >= 0 ? "#15803d" : "#dc2626", fontWeight: 700 }}>{fmt(l.profit)}</td>
                        <td style={{ minWidth: 130 }}><MarginBar value={l.margin} /></td>
                        <td>
                          <span style={{ color: l.totalProfit >= 0 ? "#15803d" : "#dc2626", fontWeight: 700 }}>{l.cost > 0 ? fmt(l.totalProfit) : "—"}</span>
                          <div style={{ fontSize: 10, color: "#94a3b8" }}>{l.sold_quantity} vendidos</div>
                        </td>
                        <td>
                          <button onClick={() => setSelectedListing(l)} style={{ background: "#0f172a", border: "none", color: "#fff", fontSize: 11, padding: "5px 12px", borderRadius: 6, cursor: "pointer", fontWeight: 600, whiteSpace: "nowrap" }}>✦ Analisar</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}

        {tab === "orders" && currentUser?.permissoes?.includes("orders") && (
          <>
            <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 16, flexWrap: "wrap" }}>
              <div style={{ position: "relative", width: 220 }}>
                <span style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", color: "#94a3b8", fontSize: 14 }}>🔍</span>
                <input className="search-input" value={searchOrders} onChange={e => setSearchOrders(e.target.value)} placeholder="Buscar por nº do pedido..." />
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: 12, color: "#94a3b8", fontWeight: 500 }}>De:</span>
                <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
                  style={{ background: "#fff", border: "1px solid #e2e8f0", color: "#334155", padding: "6px 10px", borderRadius: 8, fontFamily: "inherit", fontSize: 12, cursor: "pointer" }} />
                <span style={{ fontSize: 12, color: "#94a3b8", fontWeight: 500 }}>Até:</span>
                <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
                  style={{ background: "#fff", border: "1px solid #e2e8f0", color: "#334155", padding: "6px 10px", borderRadius: 8, fontFamily: "inherit", fontSize: 12, cursor: "pointer" }} />
                {(dateFrom || dateTo) && <button onClick={() => { setDateFrom(""); setDateTo(""); }}
                  style={{ background: "#f1f5f9", border: "1px solid #e2e8f0", color: "#64748b", padding: "5px 10px", borderRadius: 8, cursor: "pointer", fontSize: 12 }}>✕ Limpar</button>}
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {[{ key: "today", label: "Hoje" }, { key: "week", label: "7 dias" }, { key: "month", label: "30 dias" }, { key: "3months", label: "3 meses" }, { key: "all", label: "Todos" }].map(f => (
                  <button key={f.key} className={`filter-btn ${orderFilter === f.key ? "active" : ""}`} onClick={() => setOrderFilter(f.key)}>{f.label}</button>
                ))}
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {[
                  { key: "all", label: "Todos" },
                  { key: "waiting", label: "⏳ Ag. envio" },
                  { key: "shipped", label: "🚚 Enviados" },
                  { key: "done", label: "✓ Concluídos" },
                  { key: "cancelled", label: "✗ Cancelados" },
                  { key: "refunded", label: "↩ Devolvidos" },
                  { key: "mediation", label: "⚠ Em disputa" },
                ].map(f => (
                  <button key={f.key} className={`filter-btn ${orderStatusFilter === f.key ? "active" : ""}`} onClick={() => setOrderStatusFilter(f.key)}>{f.label}</button>
                ))}
              </div>
              <span style={{ fontSize: 12, color: "#94a3b8" }}>{enrichedOrders.length} pedido{enrichedOrders.length !== 1 ? "s" : ""} · {fmt(enrichedOrders.reduce((s, o) => s + o.price * o.qty, 0))}</span>
            </div>
            <div style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 12, overflow: "auto", boxShadow: "0 1px 3px rgba(0,0,0,.04)" }}>
              <table>
                <thead>
                  <tr>
                    <th>Pedido</th>
                    <th>Status</th>
                    <th>Produto</th>
                    <th>Data</th>
                    <th>Preço venda</th>
                    <th>Qtd</th>
                    <th>Tarifa ML</th>
                    <th>Frete (seu custo)</th>
                    <th>Você recebe</th>
                    <th>Lucro unit.</th>
                    <th>Margem</th>
                  </tr>
                </thead>
                <tbody>
                  {enrichedOrders.length === 0 ? (
                    <tr><td colSpan={10} style={{ textAlign: "center", color: "#94a3b8", padding: 40 }}>Nenhum pedido encontrado</td></tr>
                  ) : enrichedOrders.map(o => {
                    const youReceive = o.price - o.fee - o.freteSeller;
                    return (
                      <tr key={o.id}>
                        <td style={{ color: "#64748b", fontSize: 12, fontFamily: "monospace", fontWeight: 600 }}>#{o.id}</td>
                        <td>
                          {(() => {
                            const s = getOrderStatusInfo(o.status, o.tags, o.fulfilled, o.shipment_status);
                            return <span style={{ fontSize: 11, fontWeight: 600, color: s.color, background: s.bg, padding: "3px 8px", borderRadius: 6, whiteSpace: "nowrap" }}>{s.label}</span>;
                          })()}
                        </td>
                        <td>
                          <div style={{ maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {(() => {
                              // Título: prioriza o título direto do pedido, depois o do anúncio carregado
                              const title = o.title ?? o.listing?.title;
                              const link = o.permalink ?? o.listing?.permalink;
                              if (!title) return <span style={{ color: "#94a3b8" }}>—</span>;
                              return link
                                ? <a href={link} target="_blank" rel="noreferrer" className="title-link">{title}</a>
                                : <span>{title}</span>;
                            })()}
                          </div>
                        </td>
                        <td style={{ color: "#64748b", fontSize: 12 }}>{o.date}</td>
                        <td style={{ fontWeight: 700, color: "#0f172a" }}>{fmt(o.price)}</td>
                        <td style={{ color: "#64748b" }}>×{o.qty}</td>
                        <td><span style={{ color: "#d97706", fontWeight: 600 }}>{fmt(o.fee)}</span></td>
                        <td><span style={{ color: "#7c3aed", fontWeight: 600 }}>{o.freteSeller > 0 ? fmt(o.freteSeller) : "—"}</span></td>
                        <td><span style={{ color: "#15803d", fontWeight: 700 }}>{fmt(youReceive)}</span></td>
                        <td style={{ color: o.profit >= 0 ? "#15803d" : "#dc2626", fontWeight: 700 }}>{o.cost > 0 ? fmt(o.profit) : "—"}</td>
                        <td style={{ minWidth: 130 }}><MarginBar value={o.margin} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </main>


        {tab === "financeiro" && currentUser?.permissoes?.includes("financeiro") && (
          <FinanceiroTab
            contasPagar={contasPagar}
            setContasPagar={setContasPagar}
            contasBancarias={contasBancarias}
            setContasBancarias={setContasBancarias}
            categoriasPagar={categoriasPagar}
            setCategoriasPagar={setCategoriasPagar}
            lancamentos={lancamentos}
            setLancamentos={setLancamentos}
            enrichedOrders={enrichedOrders}
            rawOrders={rawOrders}
            shipmentStatuses={shipmentStatuses}
            paymentData={paymentData}
            finTab={finTab}
            setFinTab={setFinTab}
            impostos={impostos}
            setImpostos={setImpostos}
            custosFixos={custosFixos}
            setCustosFixos={setCustosFixos}
            fornecedores={fornecedores}
          />
        )}

        {tab === "nf" && currentUser?.permissoes?.includes("produtos") && (
          <NotasFiscaisTab
            notasFiscais={notasFiscais}
            setNotasFiscais={setNotasFiscais}
            fornecedores={fornecedores}
            produtos={produtos}
            setProdutos={setProdutos}
            contasPagar={contasPagar}
            setContasPagar={setContasPagar}
            categoriasPagar={categoriasPagar}
          />
        )}

        {tab === "produtos" && currentUser?.permissoes?.includes("produtos") && (
          <ProdutosTab
            produtos={produtos}
            setProdutos={setProdutos}
            fornecedores={fornecedores}
            setFornecedores={setFornecedores}
            listings={listings}
            costs={costs}
            setCosts={setCosts}
          />
        )}

        {tab === "admin" && currentUser?.admin && (
          <AdminTab currentUser={currentUser} />
        )}

      {showBackup && <PainelBackup onClose={() => setShowBackup(false)} />}

      {showMLModal && <MLConnectModal onConnect={handleConnect} onClose={() => setShowMLModal(false)} />}
      {selectedListing && <AIPanel listing={selectedListing} onClose={() => setSelectedListing(null)} />}
    </div>
  );
}
