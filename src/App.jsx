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
    // Usar date_created OU date_closed para filtrar (API ordena por date_closed)
    const filtered = orders.filter(o => {
      const dc = (o.date_created || o.date_closed || "").slice(0, 10);
      return dc >= cutoffDate;
    });
    allOrders = [...allOrders, ...filtered];
    // Continuar paginando baseado em date_closed (campo usado pela ordenação da API)
    const last = orders[orders.length - 1];
    const lastDate = (last?.date_closed || last?.date_created || "").slice(0, 10);
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
  const [novoCusto, setNovoCusto] = useState({ nome:"", valor:"", tipo:"%" });

  function addImposto() {
    if (!novoImposto.nome || !novoImposto.valor) return;
    var upd = [...impostos, Object.assign({}, novoImposto, {id: Date.now()})];
    setImpostos(upd); saveImpostos(upd);
    setNovoImposto({ nome:"", valor:"", tipo:"%" });
  }
  function addCusto() {
    if (!novoCusto.nome || !novoCusto.valor) return;
    var upd = [...custosFixos, Object.assign({}, novoCusto, {id: Date.now()})];
    setCustosFixos(upd); saveCustosFixos(upd);
    setNovoCusto({ nome:"", valor:"", tipo:"%" });
  }
  function removeImposto(id) { var upd = impostos.filter(function(i){return i.id!==id;}); setImpostos(upd); saveImpostos(upd); }
  function removeCusto(id) { var upd = custosFixos.filter(function(c){return c.id!==id;}); setCustosFixos(upd); saveCustosFixos(upd); }

  var totalImp = impostos.reduce(function(s,i){ return s + calcValor(i, faturamentoMes); }, 0);
  var totalFix = custosFixos.reduce(function(s,c){ return s + calcValor(c, faturamentoMes); }, 0);

  function ItemRow({ item, onRemove }) {
    return (
      <div style={{ display:"flex", alignItems:"center", gap:8, padding:"8px 0", borderBottom:"1px solid #f8fafc" }}>
        <div style={{ flex:1, fontSize:13, color:"#0f172a", fontWeight:500 }}>{item.nome}</div>
        <div style={{ fontSize:13, fontWeight:700, color:"#334155" }}>{item.valor}{item.tipo}</div>
        <div style={{ fontSize:12, color:"#94a3b8" }}>= R$ {calcValor(item, faturamentoMes).toFixed(2).replace(".",",")}</div>
        <button onClick={function(){ onRemove(item.id); }} style={{ background:"#fef2f2", border:"none", color:"#dc2626", width:24, height:24, borderRadius:6, cursor:"pointer", fontSize:11, flexShrink:0 }}>✕</button>
      </div>
    );
  }

  function AddRow({ state, setState, onAdd, placeholder }) {
    return (
      <div style={{ display:"flex", gap:6, marginTop:10, alignItems:"center" }}>
        <input value={state.nome} onChange={function(e){setState(function(s){return Object.assign({},s,{nome:e.target.value});});}}
          placeholder={placeholder}
          style={{ flex:2, background:"#f8fafc", border:"1px solid #e2e8f0", color:"#0f172a", padding:"7px 10px", borderRadius:8, fontSize:12, outline:"none" }} />
        <div style={{ display:"flex", border:"1px solid #e2e8f0", borderRadius:8, overflow:"hidden", flexShrink:0 }}>
          {["%","R$"].map(function(t){
            return <button key={t} onClick={function(){setState(function(s){return Object.assign({},s,{tipo:t});});}}
              style={{ padding:"7px 10px", border:"none", cursor:"pointer", fontSize:12, fontWeight:700,
                background: state.tipo===t?"#0f172a":"#fff", color: state.tipo===t?"#fff":"#64748b" }}>{t}</button>;
          })}
        </div>
        <input type="number" value={state.valor} onChange={function(e){setState(function(s){return Object.assign({},s,{valor:e.target.value});});}}
          placeholder="0"
          style={{ width:70, background:"#f8fafc", border:"1px solid #e2e8f0", color:"#0f172a", padding:"7px 10px", borderRadius:8, fontSize:12, outline:"none", flexShrink:0 }} />
        <button onClick={onAdd} disabled={!state.nome||!state.valor}
          style={{ background: (state.nome&&state.valor)?"#0f172a":"#f1f5f9", border:"none", color:(state.nome&&state.valor)?"#fff":"#94a3b8",
            fontWeight:700, padding:"7px 14px", borderRadius:8, cursor:(state.nome&&state.valor)?"pointer":"not-allowed", fontSize:12, flexShrink:0 }}>+</button>
      </div>
    );
  }

  return (
    <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:16 }}>
      {/* Impostos */}
      <div style={{ background:"#fff", border:"1px solid #fecaca", borderRadius:14, overflow:"hidden" }}>
        <div style={{ background:"#fef2f2", padding:"14px 18px", borderBottom:"1px solid #fecaca", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
          <div>
            <div style={{ fontWeight:700, fontSize:14, color:"#dc2626" }}>📋 Impostos</div>
            <div style={{ fontSize:11, color:"#94a3b8", marginTop:1 }}>ICMS, Simples, DAS...</div>
          </div>
          <div style={{ textAlign:"right" }}>
            <div style={{ fontSize:11, color:"#94a3b8" }}>Total</div>
            <div style={{ fontSize:17, fontWeight:800, color:"#dc2626" }}>R$ {totalImp.toFixed(2).replace(".",",")}</div>
          </div>
        </div>
        <div style={{ padding:"12px 18px" }}>
          {impostos.length === 0
            ? <div style={{ fontSize:12, color:"#94a3b8", padding:"8px 0", textAlign:"center" }}>Nenhum imposto cadastrado</div>
            : impostos.map(function(i){ return <ItemRow key={i.id} item={i} onRemove={removeImposto} />; })
          }
          <AddRow state={novoImposto} setState={setNovoImposto} onAdd={addImposto} placeholder="Ex: Simples Nacional" />
        </div>
      </div>

      {/* Custos Fixos */}
      <div style={{ background:"#fff", border:"1px solid #fde68a", borderRadius:14, overflow:"hidden" }}>
        <div style={{ background:"#fffbeb", padding:"14px 18px", borderBottom:"1px solid #fde68a", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
          <div>
            <div style={{ fontWeight:700, fontSize:14, color:"#d97706" }}>🏢 Custos Fixos</div>
            <div style={{ fontSize:11, color:"#94a3b8", marginTop:1 }}>Aluguel, salários, assinaturas...</div>
          </div>
          <div style={{ textAlign:"right" }}>
            <div style={{ fontSize:11, color:"#94a3b8" }}>Total</div>
            <div style={{ fontSize:17, fontWeight:800, color:"#d97706" }}>R$ {totalFix.toFixed(2).replace(".",",")}</div>
          </div>
        </div>
        <div style={{ padding:"12px 18px" }}>
          {custosFixos.length === 0
            ? <div style={{ fontSize:12, color:"#94a3b8", padding:"8px 0", textAlign:"center" }}>Nenhum custo fixo cadastrado</div>
            : custosFixos.map(function(c){ return <ItemRow key={c.id} item={c} onRemove={removeCusto} />; })
          }
          <AddRow state={novoCusto} setState={setNovoCusto} onAdd={addCusto} placeholder="Ex: Aluguel" />
        </div>
      </div>
    </div>
  );
}

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
function ModalFornecedor({ fornecedor, tipoPadrao, onSave, onClose }) {
  var TIPOS_CADASTRO = [
    { key:"Fornecedor",            icon:"🏭", label:"Fornecedor" },
    { key:"Cliente",               icon:"🧑‍💼", label:"Cliente" },
    { key:"Prestador de Serviço",  icon:"🔧", label:"Prestador de Serviço" },
    { key:"Transportadora",        icon:"🚚", label:"Transportadora" },
    { key:"Contador",              icon:"📊", label:"Contador" },
    { key:"Outro",                 icon:"🏢", label:"Outro" },
  ];
  const [form, setForm] = useState(fornecedor || {
    id: Date.now(), tipo: tipoPadrao || "Fornecedor", nome: "", cnpj: "", cpf: "",
    ie: "", telefone: "", celular: "", email: "", contato: "", site: "",
    cep: "", endereco: "", numero: "", complemento: "", bairro: "", cidade: "", estado: "",
    obs: "", ativo: true,
  });
  const set = (k, v) => setForm(function(f) { return Object.assign({}, f, { [k]: v }); });
  var tipoInfo = TIPOS_CADASTRO.find(function(t) { return t.key === form.tipo; }) || TIPOS_CADASTRO[0];

  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(15,23,42,.6)", backdropFilter:"blur(4px)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:600, padding:24 }}>
      <div style={{ background:"#fff", borderRadius:16, width:"100%", maxWidth:560, padding:"28px 32px", boxShadow:"0 20px 60px rgba(0,0,0,.15)", maxHeight:"92vh", overflowY:"auto" }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:20 }}>
          <div>
            <div style={{ fontWeight:800, fontSize:17, color:"#0f172a" }}>{fornecedor ? "Editar Cadastro" : "Novo Cadastro"}</div>
            <div style={{ fontSize:12, color:"#94a3b8", marginTop:2 }}>Clientes, fornecedores, prestadores e mais</div>
          </div>
          <button onClick={onClose} style={{ background:"#f1f5f9", border:"none", color:"#64748b", width:32, height:32, borderRadius:8, cursor:"pointer", fontSize:16 }}>✕</button>
        </div>

        {/* Tipo */}
        <div style={{ marginBottom:20 }}>
          <div style={{ fontSize:11, color:"#94a3b8", marginBottom:8, fontWeight:600, textTransform:"uppercase" }}>Tipo de Cadastro *</div>
          <div style={{ display:"flex", flexWrap:"wrap", gap:6 }}>
            {TIPOS_CADASTRO.map(function(t) {
              var active = form.tipo === t.key;
              return (
                <button key={t.key} onClick={function() { set("tipo", t.key); }}
                  style={{ padding:"7px 14px", borderRadius:20, border: active ? "2px solid #0f172a" : "1px solid #e2e8f0",
                    background: active ? "#0f172a" : "#f8fafc", color: active ? "#fff" : "#64748b",
                    fontWeight:600, fontSize:12, cursor:"pointer", display:"flex", alignItems:"center", gap:5 }}>
                  {t.icon} {t.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Dados principais */}
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12, marginBottom:12 }}>
          <div style={{ gridColumn:"1/-1" }}>
            <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Nome / Razão Social *</div>
            <input value={form.nome} onChange={function(e){ set("nome", e.target.value); }} placeholder={"Nome do " + tipoInfo.label.toLowerCase()}
              style={{ width:"100%", background:"#f8fafc", border:"1px solid #e2e8f0", color:"#0f172a", padding:"9px 12px", borderRadius:8, fontSize:13, outline:"none" }} />
          </div>
          <div>
            <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>CNPJ</div>
            <input value={form.cnpj} onChange={function(e){ set("cnpj", e.target.value); }} placeholder="00.000.000/0000-00"
              style={{ width:"100%", background:"#f8fafc", border:"1px solid #e2e8f0", color:"#0f172a", padding:"9px 12px", borderRadius:8, fontSize:13, outline:"none" }} />
          </div>
          <div>
            <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>CPF</div>
            <input value={form.cpf} onChange={function(e){ set("cpf", e.target.value); }} placeholder="000.000.000-00"
              style={{ width:"100%", background:"#f8fafc", border:"1px solid #e2e8f0", color:"#0f172a", padding:"9px 12px", borderRadius:8, fontSize:13, outline:"none" }} />
          </div>
          <div>
            <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Inscrição Estadual</div>
            <input value={form.ie} onChange={function(e){ set("ie", e.target.value); }} placeholder="IE ou ISENTO"
              style={{ width:"100%", background:"#f8fafc", border:"1px solid #e2e8f0", color:"#0f172a", padding:"9px 12px", borderRadius:8, fontSize:13, outline:"none" }} />
          </div>
          <div>
            <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Contato / Responsável</div>
            <input value={form.contato} onChange={function(e){ set("contato", e.target.value); }} placeholder="Nome do contato"
              style={{ width:"100%", background:"#f8fafc", border:"1px solid #e2e8f0", color:"#0f172a", padding:"9px 12px", borderRadius:8, fontSize:13, outline:"none" }} />
          </div>
        </div>

        {/* Contato */}
        <div style={{ background:"#f8fafc", borderRadius:10, padding:"14px", marginBottom:12 }}>
          <div style={{ fontSize:11, color:"#94a3b8", marginBottom:10, fontWeight:700, textTransform:"uppercase" }}>📞 Contato</div>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
            <div>
              <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Telefone</div>
              <input value={form.telefone} onChange={function(e){ set("telefone", e.target.value); }} placeholder="(11) 3333-3333"
                style={{ width:"100%", background:"#fff", border:"1px solid #e2e8f0", color:"#0f172a", padding:"9px 12px", borderRadius:8, fontSize:13, outline:"none" }} />
            </div>
            <div>
              <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Celular / WhatsApp</div>
              <input value={form.celular} onChange={function(e){ set("celular", e.target.value); }} placeholder="(11) 99999-9999"
                style={{ width:"100%", background:"#fff", border:"1px solid #e2e8f0", color:"#0f172a", padding:"9px 12px", borderRadius:8, fontSize:13, outline:"none" }} />
            </div>
            <div>
              <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>E-mail</div>
              <input value={form.email} onChange={function(e){ set("email", e.target.value); }} placeholder="email@empresa.com"
                style={{ width:"100%", background:"#fff", border:"1px solid #e2e8f0", color:"#0f172a", padding:"9px 12px", borderRadius:8, fontSize:13, outline:"none" }} />
            </div>
            <div>
              <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Site</div>
              <input value={form.site} onChange={function(e){ set("site", e.target.value); }} placeholder="www.empresa.com"
                style={{ width:"100%", background:"#fff", border:"1px solid #e2e8f0", color:"#0f172a", padding:"9px 12px", borderRadius:8, fontSize:13, outline:"none" }} />
            </div>
          </div>
        </div>

        {/* Endereço */}
        <div style={{ background:"#f8fafc", borderRadius:10, padding:"14px", marginBottom:12 }}>
          <div style={{ fontSize:11, color:"#94a3b8", marginBottom:10, fontWeight:700, textTransform:"uppercase" }}>📍 Endereço</div>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
            <div>
              <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>CEP</div>
              <input value={form.cep} onChange={function(e){ set("cep", e.target.value); }} placeholder="00000-000"
                style={{ width:"100%", background:"#fff", border:"1px solid #e2e8f0", color:"#0f172a", padding:"9px 12px", borderRadius:8, fontSize:13, outline:"none" }} />
            </div>
            <div>
              <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Número</div>
              <input value={form.numero} onChange={function(e){ set("numero", e.target.value); }} placeholder="123"
                style={{ width:"100%", background:"#fff", border:"1px solid #e2e8f0", color:"#0f172a", padding:"9px 12px", borderRadius:8, fontSize:13, outline:"none" }} />
            </div>
            <div style={{ gridColumn:"1/-1" }}>
              <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Logradouro</div>
              <input value={form.endereco} onChange={function(e){ set("endereco", e.target.value); }} placeholder="Rua, Av, Travessa..."
                style={{ width:"100%", background:"#fff", border:"1px solid #e2e8f0", color:"#0f172a", padding:"9px 12px", borderRadius:8, fontSize:13, outline:"none" }} />
            </div>
            <div>
              <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Complemento</div>
              <input value={form.complemento} onChange={function(e){ set("complemento", e.target.value); }} placeholder="Apto, Sala..."
                style={{ width:"100%", background:"#fff", border:"1px solid #e2e8f0", color:"#0f172a", padding:"9px 12px", borderRadius:8, fontSize:13, outline:"none" }} />
            </div>
            <div>
              <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Bairro</div>
              <input value={form.bairro} onChange={function(e){ set("bairro", e.target.value); }} placeholder="Bairro"
                style={{ width:"100%", background:"#fff", border:"1px solid #e2e8f0", color:"#0f172a", padding:"9px 12px", borderRadius:8, fontSize:13, outline:"none" }} />
            </div>
            <div>
              <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Cidade</div>
              <input value={form.cidade} onChange={function(e){ set("cidade", e.target.value); }} placeholder="Cidade"
                style={{ width:"100%", background:"#fff", border:"1px solid #e2e8f0", color:"#0f172a", padding:"9px 12px", borderRadius:8, fontSize:13, outline:"none" }} />
            </div>
            <div>
              <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Estado</div>
              <select value={form.estado} onChange={function(e){ set("estado", e.target.value); }}
                style={{ width:"100%", background:"#fff", border:"1px solid #e2e8f0", color:"#334155", padding:"9px 12px", borderRadius:8, fontSize:13 }}>
                <option value="">— UF —</option>
                {["AC","AL","AP","AM","BA","CE","DF","ES","GO","MA","MT","MS","MG","PA","PB","PR","PE","PI","RJ","RN","RS","RO","RR","SC","SP","SE","TO"].map(function(uf){ return <option key={uf} value={uf}>{uf}</option>; })}
              </select>
            </div>
          </div>
        </div>

        {/* Observação e status */}
        <div style={{ display:"grid", gridTemplateColumns:"1fr auto", gap:10, marginBottom:20, alignItems:"flex-start" }}>
          <div>
            <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Observação</div>
            <input value={form.obs} onChange={function(e){ set("obs", e.target.value); }} placeholder="Condições, notas, informações extras..."
              style={{ width:"100%", background:"#f8fafc", border:"1px solid #e2e8f0", color:"#0f172a", padding:"9px 12px", borderRadius:8, fontSize:13, outline:"none" }} />
          </div>
          <div style={{ paddingTop:24 }}>
            <label style={{ display:"flex", alignItems:"center", gap:8, cursor:"pointer" }}>
              <input type="checkbox" checked={form.ativo !== false} onChange={function(e){ set("ativo", e.target.checked); }} />
              <span style={{ fontSize:13, fontWeight:600, color:"#0f172a" }}>Ativo</span>
            </label>
          </div>
        </div>

        <div style={{ display:"flex", gap:8 }}>
          <button onClick={onClose} style={{ flex:1, background:"#f8fafc", border:"1px solid #e2e8f0", color:"#64748b", fontWeight:600, padding:"11px", borderRadius:10, cursor:"pointer" }}>Cancelar</button>
          <button onClick={function(){ if (!form.nome) return; onSave(form); onClose(); }} disabled={!form.nome}
            style={{ flex:2, background: form.nome ? "#0f172a" : "#f1f5f9", border:"none", color: form.nome ? "#fff" : "#94a3b8", fontWeight:700, padding:"11px", borderRadius:10, cursor: form.nome ? "pointer" : "not-allowed" }}>
            Salvar {tipoInfo.icon} {tipoInfo.label}
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
  const [prodTab, setProdTab] = useState("lista"); // lista | cadastros
  const [showModalProd, setShowModalProd] = useState(false);
  const [showModalForn, setShowModalForn] = useState(false);
  const [editingProd, setEditingProd] = useState(null);
  const [editingForn, setEditingForn] = useState(null);
  const [prodSel, setProdSel] = useState([]);
  const [search, setSearch] = useState("");
  const [filterCat, setFilterCat] = useState("all");
  const [filterStatus, setFilterStatus] = useState("all");
  const [filtroTipo, setFiltroTipo] = useState("todos");
  const [searchCad, setSearchCad] = useState("");
  const [tipoPadraoCad, setTipoPadraoCad] = useState("Fornecedor");

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
          { key:"lista",     label:"📦 Produtos" },
          { key:"cadastros", label:"🗂️ Cadastros" },
        ].map(function(t) {
          return (
            <button key={t.key} onClick={function(){ setProdTab(t.key); }}
              style={{ background:prodTab===t.key?"#fff":"transparent", border:"none", color:prodTab===t.key?"#0f172a":"#94a3b8", padding:"8px 18px", cursor:"pointer", fontFamily:"inherit", fontSize:13, borderRadius:8, fontWeight:prodTab===t.key?700:500, boxShadow:prodTab===t.key?"0 1px 3px rgba(0,0,0,.08)":"none" }}>
              {t.label}
            </button>
          );
        })}
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

          {prodSel.length > 0 && (
            <div style={{ display:"flex", gap:8, alignItems:"center", background:"#0f172a", borderRadius:10, padding:"10px 16px", marginBottom:10, flexWrap:"wrap" }}>
              <span style={{ color:"#fff", fontWeight:700, fontSize:13 }}>{prodSel.length} produto(s) selecionado(s)</span>
              <button onClick={function(){
                if (!window.confirm("Excluir " + prodSel.length + " produto(s)?")) return;
                var upd = produtos.filter(function(p){ return !prodSel.includes(p.id); });
                setProdutos(upd); saveProdutos(upd); setProdSel([]);
              }} style={{ background:"#dc2626", border:"none", color:"#fff", fontWeight:700, padding:"6px 14px", borderRadius:8, cursor:"pointer", fontSize:12 }}>
                🗑 Excluir Selecionados
              </button>
              <button onClick={function(){
                var upd = produtos.map(function(p){ return prodSel.includes(p.id) ? Object.assign({},p,{status:"Inativo"}) : p; });
                setProdutos(upd); saveProdutos(upd); setProdSel([]);
              }} style={{ background:"#d97706", border:"none", color:"#fff", fontWeight:700, padding:"6px 14px", borderRadius:8, cursor:"pointer", fontSize:12 }}>
                ⏸ Inativar
              </button>
              <button onClick={function(){
                var upd = produtos.map(function(p){ return prodSel.includes(p.id) ? Object.assign({},p,{status:"Ativo"}) : p; });
                setProdutos(upd); saveProdutos(upd); setProdSel([]);
              }} style={{ background:"#15803d", border:"none", color:"#fff", fontWeight:700, padding:"6px 14px", borderRadius:8, cursor:"pointer", fontSize:12 }}>
                ▶ Ativar
              </button>
              <button onClick={function(){ setProdSel([]); }}
                style={{ background:"#334155", border:"none", color:"#94a3b8", padding:"6px 12px", borderRadius:8, cursor:"pointer", fontSize:12 }}>✕ Cancelar</button>
            </div>
          )}
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
                  <tr>
                    <th style={{ padding:"10px 14px", background:"#fafafa", borderBottom:"1px solid #f1f5f9", width:36 }}>
                      <input type="checkbox"
                        checked={produtosFiltrados.length > 0 && produtosFiltrados.every(function(p){ return prodSel.includes(p.id); })}
                        onChange={function(e){ setProdSel(e.target.checked ? produtosFiltrados.map(function(p){return p.id;}) : []); }}
                        style={{ cursor:"pointer" }} />
                    </th>
                    {["Foto","Produto","SKU / EAN","Fornecedor","Custo","Venda","Estoque","Status","ML","Ações"].map(function(h){
                      return <th key={h} style={{ fontSize:11, color:"#94a3b8", textTransform:"uppercase", letterSpacing:0.8, padding:"10px 14px", borderBottom:"1px solid #f1f5f9", textAlign:"left", fontWeight:600, background:"#fafafa", whiteSpace:"nowrap" }}>{h}</th>;
                    })}
                  </tr>
                </thead>
                <tbody>
                  {produtosFiltrados.map((p, i) => {
                    const forn = fornecedores.find(f => f.id === p.fornecedorId);
                    const mlListing = listings.find(l => l.id === p.mlbVinculado);
                    const estBaixo = p.estoqueMinimo && p.estoqueAtual && parseFloat(p.estoqueAtual) <= parseFloat(p.estoqueMinimo);
                    return (
                      <tr key={p.id} style={{ background: prodSel.includes(p.id)?"#eff6ff":i%2===0?"#f8fafc":"#fff" }}>
                        <td style={{ padding:"10px 14px", textAlign:"center" }}>
                          <input type="checkbox" checked={prodSel.includes(p.id)}
                            onChange={function(e){ setProdSel(e.target.checked ? [...prodSel,p.id] : prodSel.filter(function(x){return x!==p.id;})); }}
                            style={{ cursor:"pointer" }} />
                        </td>
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
      {prodTab === "cadastros" && (
        <div>
          {/* Filtros e ações */}
          <div style={{ display:"flex", gap:10, alignItems:"center", marginBottom:14, flexWrap:"wrap" }}>
            <button onClick={function(){ setEditingForn(null); setTipoPadraoCad("Fornecedor"); setShowModalForn(true); }}
              style={{ background:"#0f172a", border:"none", color:"#fff", fontWeight:700, padding:"9px 20px", borderRadius:8, cursor:"pointer", fontSize:13 }}>+ Novo Cadastro</button>
            <div style={{ position:"relative", flex:1, minWidth:180 }}>
              <span style={{ position:"absolute", left:10, top:"50%", transform:"translateY(-50%)", color:"#94a3b8", fontSize:13 }}>🔍</span>
              <input value={searchCad} onChange={function(e){ setSearchCad(e.target.value); }} placeholder="Buscar nome, CNPJ, cidade..."
                style={{ width:"100%", background:"#fff", border:"1px solid #e2e8f0", color:"#0f172a", padding:"8px 12px 8px 32px", borderRadius:8, fontSize:13, outline:"none" }} />
            </div>
          </div>

          {/* Filtro por tipo */}
          <div style={{ display:"flex", gap:6, marginBottom:16, flexWrap:"wrap" }}>
            {[
              { key:"todos",                label:"Todos",              icon:"🗂️" },
              { key:"Fornecedor",           label:"Fornecedores",       icon:"🏭" },
              { key:"Cliente",              label:"Clientes",           icon:"🧑‍💼" },
              { key:"Prestador de Serviço", label:"Prestadores",        icon:"🔧" },
              { key:"Transportadora",       label:"Transportadoras",    icon:"🚚" },
              { key:"Contador",             label:"Contadores",         icon:"📊" },
              { key:"Outro",                label:"Outros",             icon:"🏢" },
            ].map(function(t) {
              var active = filtroTipo === t.key;
              var count = t.key === "todos" ? fornecedores.length : fornecedores.filter(function(f){ return f.tipo === t.key; }).length;
              if (count === 0 && t.key !== "todos") return null;
              return (
                <button key={t.key} onClick={function(){ setFiltroTipo(t.key); }}
                  style={{ padding:"6px 14px", borderRadius:20, border: active ? "2px solid #0f172a" : "1px solid #e2e8f0",
                    background: active ? "#0f172a" : "#f8fafc", color: active ? "#fff" : "#64748b",
                    fontWeight:600, fontSize:12, cursor:"pointer" }}>
                  {t.icon} {t.label} <span style={{ opacity:0.7, fontSize:11 }}>({count})</span>
                </button>
              );
            })}
          </div>

          {/* Cards de ação rápida para criar */}
          {fornecedores.length === 0 && (
            <div style={{ marginBottom:20 }}>
              <div style={{ fontSize:13, color:"#64748b", marginBottom:12, fontWeight:600 }}>Criar novo cadastro:</div>
              <div style={{ display:"flex", gap:10, flexWrap:"wrap" }}>
                {[
                  { tipo:"Fornecedor",           icon:"🏭", cor:"#0891b2" },
                  { tipo:"Cliente",              icon:"🧑‍💼", cor:"#15803d" },
                  { tipo:"Prestador de Serviço", icon:"🔧", cor:"#7c3aed" },
                  { tipo:"Transportadora",       icon:"🚚", cor:"#d97706" },
                ].map(function(t) {
                  return (
                    <button key={t.tipo} onClick={function(){ setEditingForn(null); setTipoPadraoCad(t.tipo); setShowModalForn(true); }}
                      style={{ padding:"12px 20px", borderRadius:12, border:"2px dashed #e2e8f0", background:"#f8fafc", cursor:"pointer", display:"flex", alignItems:"center", gap:8, fontSize:13, fontWeight:600, color:"#64748b" }}>
                      <span style={{ fontSize:20 }}>{t.icon}</span> + {t.tipo}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Lista de cadastros */}
          {(function() {
            var lista = fornecedores.filter(function(f) {
              if (filtroTipo !== "todos" && f.tipo !== filtroTipo) return false;
              if (searchCad) {
                var q = searchCad.toLowerCase();
                return (f.nome&&f.nome.toLowerCase().includes(q)) || (f.cnpj&&f.cnpj.includes(q)) || (f.cidade&&f.cidade.toLowerCase().includes(q)) || (f.email&&f.email.toLowerCase().includes(q));
              }
              return true;
            });

            var TIPO_CONFIG = {
              "Fornecedor":           { icon:"🏭", cor:"#0891b2", bg:"#ecfeff" },
              "Cliente":              { icon:"🧑‍💼", cor:"#15803d", bg:"#f0fdf4" },
              "Prestador de Serviço": { icon:"🔧", cor:"#7c3aed", bg:"#f5f3ff" },
              "Transportadora":       { icon:"🚚", cor:"#d97706", bg:"#fffbeb" },
              "Contador":             { icon:"📊", cor:"#0f172a", bg:"#f8fafc" },
              "Outro":                { icon:"🏢", cor:"#64748b", bg:"#f8fafc" },
            };

            if (lista.length === 0) {
              return (
                <div style={{ background:"#f8fafc", border:"2px dashed #e2e8f0", borderRadius:12, padding:40, textAlign:"center", color:"#94a3b8" }}>
                  <div style={{ fontSize:32, marginBottom:8 }}>🗂️</div>
                  <div style={{ fontWeight:600, marginBottom:4 }}>Nenhum cadastro encontrado</div>
                  <div style={{ fontSize:13 }}>Clique em "+ Novo Cadastro" para começar</div>
                </div>
              );
            }

            return (
              <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(300px,1fr))", gap:12 }}>
                {lista.map(function(f) {
                  var cfg = TIPO_CONFIG[f.tipo] || TIPO_CONFIG["Outro"];
                  var qtdProdutos = f.tipo === "Fornecedor" ? produtos.filter(function(p){ return p.fornecedorId === f.id; }).length : 0;
                  return (
                    <div key={f.id} style={{ background:"#fff", border:"1px solid #e2e8f0", borderRadius:12, padding:"18px 20px", position:"relative" }}>
                      {/* Tipo badge */}
                      <span style={{ position:"absolute", top:12, left:16, fontSize:10, fontWeight:700, color:cfg.cor, background:cfg.bg, padding:"2px 8px", borderRadius:20, border:"1px solid " + cfg.cor + "33" }}>
                        {cfg.icon} {f.tipo || "Fornecedor"}
                      </span>
                      {/* Ações */}
                      <div style={{ position:"absolute", top:10, right:12, display:"flex", gap:4 }}>
                        <button onClick={function(){ setEditingForn(f); setShowModalForn(true); }}
                          style={{ background:"#f1f5f9", border:"none", color:"#64748b", width:28, height:28, borderRadius:6, cursor:"pointer", fontSize:12 }}>✏️</button>
                        <button onClick={function(){ deleteForn(f.id); }}
                          style={{ background:"#fef2f2", border:"none", color:"#dc2626", width:28, height:28, borderRadius:6, cursor:"pointer", fontSize:12 }}>🗑</button>
                      </div>
                      {/* Info principal */}
                      <div style={{ marginTop:26, fontWeight:700, fontSize:15, color:"#0f172a", marginBottom:2 }}>{f.nome}</div>
                      {f.ativo === false && <span style={{ fontSize:10, background:"#fef2f2", color:"#dc2626", padding:"1px 6px", borderRadius:4, fontWeight:600 }}>INATIVO</span>}
                      <div style={{ fontSize:11, color:"#94a3b8", marginBottom:10 }}>
                        {f.cnpj ? "CNPJ: " + f.cnpj : f.cpf ? "CPF: " + f.cpf : "Sem documento"}
                        {f.ie ? " · IE: " + f.ie : ""}
                      </div>
                      <div style={{ display:"flex", flexDirection:"column", gap:3, fontSize:12, color:"#64748b" }}>
                        {f.contato && <span>👤 {f.contato}</span>}
                        {f.celular && <span>📱 {f.celular}</span>}
                        {f.telefone && !f.celular && <span>📞 {f.telefone}</span>}
                        {f.email && <span>✉️ {f.email}</span>}
                        {(f.cidade || f.estado) && <span>📍 {[f.cidade, f.estado].filter(Boolean).join(" / ")}</span>}
                      </div>
                      {qtdProdutos > 0 && (
                        <div style={{ marginTop:10, paddingTop:10, borderTop:"1px solid #f1f5f9", fontSize:12, color:"#94a3b8" }}>
                          📦 {qtdProdutos} produto(s) vinculado(s)
                        </div>
                      )}
                      {f.obs && (
                        <div style={{ marginTop:6, fontSize:11, color:"#94a3b8", fontStyle:"italic", borderTop: qtdProdutos > 0 ? "none" : "1px solid #f1f5f9", paddingTop: qtdProdutos > 0 ? 0 : 6 }}>
                          💬 {f.obs.slice(0, 60)}{f.obs.length > 60 ? "..." : ""}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })()}
        </div>
      )}

      {showModalProd && <ModalProduto produto={editingProd} fornecedores={fornecedores} listings={listings} onSave={saveProd} onClose={() => { setShowModalProd(false); setEditingProd(null); }} />}
      {showModalForn && <ModalFornecedor fornecedor={editingForn} tipoPadrao={tipoPadraoCad} onSave={saveForn} onClose={function(){ setShowModalForn(false); setEditingForn(null); }} />}
    </div>
  );
}


// ════════════════════════════════════════════════════════════
//  IA — Analisador de Prioridade de Pagamentos
// ════════════════════════════════════════════════════════════

async function chamarIA(prompt, maxTokens) {
  maxTokens = maxTokens || 1500;
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
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const data = await response.json();
  if (data.error) throw new Error(data.error.message);
  return data.content?.map(function(b) { return b.text || ""; }).join("") ?? "";
}

function sanitize(str) {
  var s = String(str || "");
  var result = "";
  for (var i = 0; i < s.length; i++) {
    var code = s.charCodeAt(i);
    if (code === 10 || code === 13 || code === 9) { result += " "; }
    else if (code === 34) { result += "'"; }
    else if (code === 92) { result += " "; }
    else { result += s[i]; }
  }
  return result.trim();
}

function parseIAJson(text) {
  // Tenta extrair JSON de forma robusta
  var clean = text.replace(/```json[\s\S]*?```/g, function(m) { return m.slice(7, -3); });
  clean = clean.replace(/```/g, "").trim();
  var start = clean.indexOf("{");
  var end = clean.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("IA não retornou JSON válido");
  var jsonStr = clean.slice(start, end + 1);
  try {
    return JSON.parse(jsonStr);
  } catch(e) {
    // Tenta corrigir JSON com aspas simples ou aspas internas mal escapadas
    var fixed = jsonStr
      .replace(/([{,]\s*)(\w+)(\s*:)/g, '$1"$2"$3')  // chaves sem aspas
      .replace(/:\s*'([^']*)'/g, ': "$1"')              // valores com aspas simples
      .replace(/,\s*}/g, '}')                           // trailing comma
      .replace(/,\s*]/g, ']');
    try { return JSON.parse(fixed); } catch(e2) {
      throw new Error("JSON inválido da IA: " + e.message);
    }
  }
}

async function analisarPrioridadePagamentos(contas, saldoDisponivel) {
  const contasComCusto = contas.filter(function(c) { return c.status !== "Pago"; }).map(function(c) {
    const valor = parseFloat(c.valor || 0);
    const multaR = c.multaTipo === "R$" ? parseFloat(c.multaPct || 0) : valor * (parseFloat(c.multaPct || 0) / 100);
    const jurosDiaR = c.jurosTipo === "R$" ? parseFloat(c.jurosDia || 0) : valor * (parseFloat(c.jurosDia || 0) / 100);
    const hoje = new Date(); hoje.setHours(0,0,0,0);
    const dueDate = c.vencimento ? new Date(c.vencimento + "T00:00:00") : null;
    const diasAtraso = dueDate ? Math.max(0, Math.round((hoje - dueDate) / 86400000)) : 0;
    const diasParaVencer = dueDate ? Math.round((dueDate - hoje) / 86400000) : 999;
    const multaValor = diasAtraso > 0 ? multaR : 0;
    const jurosValor = diasAtraso > 0 ? jurosDiaR * diasAtraso : 0;
    return Object.assign({}, c, { valor, diasAtraso, diasParaVencer, multaValor, jurosValor });
  });

  // Usar JSON estruturado no prompt evita problemas com caracteres especiais
  var contasData = contasComCusto.map(function(c, i) {
    return {
      num: i + 1,
      id: String(c.id),
      desc: sanitize(c.descricao),
      valor: c.valor.toFixed(2),
      venc: c.vencimento || "sem data",
      situacao: c.diasAtraso > 0 ? ("VENCIDA " + c.diasAtraso + "d") : ("vence em " + c.diasParaVencer + "d"),
      multa: c.multaValor.toFixed(2),
      juros: c.jurosValor.toFixed(2),
      protesto: c.temProtesto ? ("SIM " + (c.diasProtesto || 0) + "d") : "Nao",
      cat: sanitize(c.categoria),
      prioridade: c.prioridade || "media"
    };
  });

  var contasTexto = contasData.slice(0, 20).map(function(c) {
    return c.num + ". [ID:" + c.id + "] " + c.desc + " R$" + c.valor + " " + c.situacao + " multa:R$" + c.multa + " juros:R$" + c.juros + " protesto:" + c.protesto + " cat:" + c.cat + " prior:" + c.prioridade;
  }).join("; ");

  var exemploJson = '{"resumo":"resumo breve","alerta_critico":null,"prioridade":[{"posicao":1,"id":"ID_DA_CONTA","razao":"motivo","urgencia":"critica","pagar_hoje":true}],"recomendacao_final":"acao"}';
  const prompt = 'Analise contas a pagar. Saldo: R$' + saldoDisponivel.toFixed(2) + '. Contas: ' + contasTexto + '. Responda SOMENTE com JSON valido em uma linha sem markdown: ' + exemploJson;
  const text = await chamarIA(prompt, 1400);
  return parseIAJson(text);
}

async function analisarEmprestimo(dados) {
  const prompt = `Você é um consultor financeiro especialista em crédito para pequenas empresas brasileiras.

Analise se vale a pena fazer um empréstimo para quitar dívidas, considerando:

SITUAÇÃO FINANCEIRA:
- Saldo atual disponível: R$ ${dados.saldoAtual.toFixed(2)}
- Total de dívidas vencidas: R$ ${dados.totalVencido.toFixed(2)} (${dados.qtdVencidas} contas)
- Total de dívidas protestadas: R$ ${dados.totalProtestado.toFixed(2)} (${dados.qtdProtestadas} contas)
- Total de multas e juros acumulados: R$ ${dados.totalMultasJuros.toFixed(2)}
- Total a pagar (todas pendentes): R$ ${dados.totalPendente.toFixed(2)}
- Custo médio por dia de atraso: R$ ${dados.custoDiario.toFixed(2)}

DADOS DO EMPRÉSTIMO CONSIDERADO:
- Valor desejado: R$ ${dados.valorEmprestimo.toFixed(2)}
- Taxa de juros: ${dados.taxaEmprestimo}% ao mês
- Prazo: ${dados.prazoEmprestimo} meses
- Parcela estimada: R$ ${dados.parcelaEstimada.toFixed(2)}/mês
- Custo total do empréstimo: R$ ${dados.custoTotalEmprestimo.toFixed(2)}

CONTAS MAIS CRÍTICAS:
${dados.contasCriticas.map(function(c, i) {
  return (i+1) + ". " + c.descricao + " — R$ " + parseFloat(c.valor||0).toFixed(2) + (c.diasAtraso > 0 ? " (vencida " + c.diasAtraso + "d, multa+juros: R$ " + c.encargos.toFixed(2) + ")" : "") + (c.temProtesto ? " ⚖️ PROTESTO" : "");
}).join("\n")}

Análise detalhada considerando:
1. Vale a pena quitar as dívidas com empréstimo? Compare o custo do empréstimo vs custo das multas/juros/protesto
2. Qual o risco financeiro de não quitar agora vs fazer o empréstimo?
3. Qual o impacto do protesto no nome da empresa?
4. Alternativas ao empréstimo (negociação, parcelamento, priorização)
5. Recomendação clara e objetiva

Retorne APENAS JSON:
{
  "viavel": true,
  "score_risco": "alto|medio|baixo",
  "economia_estimada": 0.00,
  "analise_custo_beneficio": "comparativo detalhado em 2-3 frases",
  "risco_sem_emprestimo": "o que acontece se não fizer nada, em 2 frases",
  "impacto_protesto": "impacto do protesto no negócio, em 1-2 frases",
  "alternativas": ["alternativa 1", "alternativa 2", "alternativa 3"],
  "recomendacao": "recomendação clara e direta em 2-3 frases",
  "plano_acao": ["passo 1", "passo 2", "passo 3", "passo 4"]
}`;

  const text = await chamarIA(prompt, 1800);
  return parseIAJson(text);
}

async function analisarDecisaoFinanceira(dados) {
  const prompt = `Você é um CFO (Diretor Financeiro) experiente em pequenas e médias empresas brasileiras. Seja direto, prático e objetivo.

CENÁRIO FINANCEIRO COMPLETO:
Saldo em caixa/bancos: R$ ${dados.saldoTotal.toFixed(2)}
Contas a pagar pendentes: R$ ${dados.totalPendente.toFixed(2)} (${dados.qtdPendentes} contas)
Contas vencidas: R$ ${dados.totalVencido.toFixed(2)} (${dados.qtdVencidas} contas)
Contas protestadas: R$ ${dados.totalProtestado.toFixed(2)}
Multas e juros acumulados: R$ ${dados.totalEncargos.toFixed(2)}
Recebimentos previstos (ML): R$ ${dados.totalAReceber.toFixed(2)}
Saldo projetado após pagar tudo: R$ ${(dados.saldoTotal + dados.totalAReceber - dados.totalPendente).toFixed(2)}

PERGUNTA DO USUÁRIO: "${dados.pergunta}"

Responda de forma prática e direta como um CFO. Use dados reais da situação acima.
Seja específico com valores. Máximo 4 parágrafos curtos.

Retorne APENAS JSON:
{
  "resposta": "resposta direta e prática",
  "situacao": "critica|atencao|estavel|otima",
  "acoes_imediatas": ["ação 1", "ação 2", "ação 3"],
  "indicadores": [
    {"label": "Nome do indicador", "valor": "R$ X ou X%", "status": "bom|atencao|critico"}
  ]
}`;

  const text = await chamarIA(prompt, 1500);
  return parseIAJson(text);
}

function PainelIAPagamentos({ contasPagar, contasBancarias, lancamentos, enrichedOrders, paymentData, shipmentStatuses }) {
  const [aba, setAba] = useState("prioridade"); // prioridade | emprestimo | consultor
  const [state, setState] = useState("idle");
  const [result, setResult] = useState(null);
  const [errorMsg, setErrorMsg] = useState("");

  // Prioridade
  const [saldo, setSaldo] = useState("");
  const [contaSelecionada, setContaSelecionada] = useState("");

  // Empréstimo
  const [valorEmprestimo, setValorEmprestimo] = useState("");
  const [taxaEmprestimo, setTaxaEmprestimo] = useState("3");
  const [prazoEmprestimo, setPrazoEmprestimo] = useState("12");

  // Consultor
  const [pergunta, setPergunta] = useState("");

  const hoje = new Date(); hoje.setHours(0,0,0,0);

  const contasPendentes = contasPagar.filter(function(c) { return c.status !== "Pago"; });
  const contasVencidas = contasPendentes.filter(function(c) {
    if (!c.vencimento) return false;
    return new Date(c.vencimento + "T00:00:00") < hoje;
  });
  const contasProtestadas = contasPendentes.filter(function(c) {
    if (!c.temProtesto || !c.vencimento || !c.diasProtesto) return false;
    const venc = new Date(c.vencimento + "T00:00:00");
    const dataProtesto = new Date(venc); dataProtesto.setDate(dataProtesto.getDate() + parseInt(c.diasProtesto));
    return dataProtesto <= hoje;
  });

  function calcEncargos(c) {
    const valor = parseFloat(c.valor || 0);
    const multaR = c.multaTipo === "R$" ? parseFloat(c.multaPct || 0) : valor * (parseFloat(c.multaPct || 0) / 100);
    const jurosDiaR = c.jurosTipo === "R$" ? parseFloat(c.jurosDia || 0) : valor * (parseFloat(c.jurosDia || 0) / 100);
    const dueDate = c.vencimento ? new Date(c.vencimento + "T00:00:00") : null;
    const diasAtraso = dueDate ? Math.max(0, Math.round((hoje - dueDate) / 86400000)) : 0;
    return diasAtraso > 0 ? multaR + jurosDiaR * diasAtraso : 0;
  }

  const totalVencido = contasVencidas.reduce(function(s,c){ return s + parseFloat(c.valor||0); }, 0);
  const totalProtestado = contasProtestadas.reduce(function(s,c){ return s + parseFloat(c.valor||0); }, 0);
  const totalPendente = contasPendentes.reduce(function(s,c){ return s + parseFloat(c.valor||0); }, 0);
  const totalEncargos = contasPendentes.reduce(function(s,c){ return s + calcEncargos(c); }, 0);
  const custoDiario = contasVencidas.reduce(function(s,c) {
    const valor = parseFloat(c.valor||0);
    const jurosDiaR = c.jurosTipo === "R$" ? parseFloat(c.jurosDia||0) : valor * (parseFloat(c.jurosDia||0)/100);
    return s + jurosDiaR;
  }, 0);
  const saldoTotal = contasBancarias.reduce(function(s,cb) {
    const ent = (lancamentos||[]).filter(function(l){return l.contaBancariaId===cb.id&&l.tipo==="recebimento";}).reduce(function(a,l){return a+l.valor;},0);
    const sai = (lancamentos||[]).filter(function(l){return l.contaBancariaId===cb.id&&l.tipo==="pagamento";}).reduce(function(a,l){return a+l.valor;},0);
    return s + parseFloat(cb.saldoInicial||0) + ent - sai;
  }, 0);

  function checkKey() {
    if (!import.meta.env.VITE_ANTHROPIC_KEY) { setErrorMsg("Chave da API não configurada (VITE_ANTHROPIC_KEY)"); setState("error"); return false; }
    return true;
  }

  async function analisarPrioridade() {
    if (!checkKey()) return;
    if (contasPendentes.length === 0) { setErrorMsg("Nenhuma conta pendente"); setState("error"); return; }
    setState("loading"); setErrorMsg("");
    try {
      const r = await analisarPrioridadePagamentos(contasPendentes, parseFloat(saldo) || 0);
      setResult(r); setState("done");
    } catch(e) { setErrorMsg(e.message); setState("error"); }
  }

  async function analisarEmprestimoFn() {
    if (!checkKey()) return;
    const valor = parseFloat(valorEmprestimo) || 0;
    const taxa = parseFloat(taxaEmprestimo) || 3;
    const prazo = parseInt(prazoEmprestimo) || 12;
    if (valor <= 0) { setErrorMsg("Informe o valor do empréstimo"); setState("error"); return; }
    const parcela = (valor * (taxa/100)) / (1 - Math.pow(1 + taxa/100, -prazo));
    const custoTotal = parcela * prazo;
    const contasCriticas = [...contasVencidas, ...contasProtestadas.filter(function(c){ return !contasVencidas.find(function(v){return v.id===c.id;}); })].slice(0,8).map(function(c) {
      const dueDate = c.vencimento ? new Date(c.vencimento + "T00:00:00") : null;
      const diasAtraso = dueDate ? Math.max(0, Math.round((hoje - dueDate) / 86400000)) : 0;
      return Object.assign({}, c, { diasAtraso, encargos: calcEncargos(c) });
    });
    setState("loading"); setErrorMsg("");
    try {
      const r = await analisarEmprestimo({
        saldoAtual: saldoTotal, totalVencido, totalProtestado,
        qtdVencidas: contasVencidas.length, qtdProtestadas: contasProtestadas.length,
        totalMultasJuros: totalEncargos, totalPendente, custoDiario,
        valorEmprestimo: valor, taxaEmprestimo: taxa, prazoEmprestimo: prazo,
        parcelaEstimada: parcela, custoTotalEmprestimo: custoTotal, contasCriticas,
      });
      setResult(r); setState("done");
    } catch(e) { setErrorMsg(e.message); setState("error"); }
  }

  async function consultarCFO() {
    if (!checkKey()) return;
    if (!pergunta.trim()) { setErrorMsg("Digite sua pergunta"); setState("error"); return; }
    const aReceber = (enrichedOrders||[]).filter(function(o) {
      const ss = (shipmentStatuses||{})[o.id] ?? o.shipment_status;
      return ss !== "delivered" && !o.tags?.some(function(t){return t==="delivered";});
    }).reduce(function(s,o){ return s + ((paymentData||{})[o.id]?.netAmount || o.price*o.qty); }, 0);
    setState("loading"); setErrorMsg("");
    try {
      const r = await analisarDecisaoFinanceira({
        saldoTotal, totalPendente, totalVencido, totalProtestado, totalEncargos,
        qtdPendentes: contasPendentes.length, qtdVencidas: contasVencidas.length,
        totalAReceber: aReceber, pergunta: pergunta.trim(),
      });
      setResult(r); setState("done");
    } catch(e) { setErrorMsg(e.message); setState("error"); }
  }

  const urgenciaCor = function(u) { return u==="critica"?"#dc2626":u==="alta"?"#d97706":u==="media"?"#0891b2":"#15803d"; };
  const urgenciaBg  = function(u) { return u==="critica"?"#fef2f2":u==="alta"?"#fffbeb":u==="media"?"#ecfeff":"#f0fdf4"; };
  const urgenciaLabel = function(u) { return u==="critica"?"🚨 CRÍTICA":u==="alta"?"⚠️ Alta":u==="media"?"📋 Média":"✓ Baixa"; };
  const situacaoCor = function(s) { return s==="critica"?"#dc2626":s==="atencao"?"#d97706":s==="estavel"?"#0891b2":"#15803d"; };
  const situacaoBg  = function(s) { return s==="critica"?"#fef2f2":s==="atencao"?"#fffbeb":s==="estavel"?"#ecfeff":"#f0fdf4"; };
  const statusCor   = function(s) { return s==="critico"?"#dc2626":s==="atencao"?"#d97706":"#15803d"; };

  const ABAS = [
    { key:"prioridade", label:"📋 Prioridade de Pagamento" },
    { key:"emprestimo", label:"🏦 Análise de Empréstimo" },
    { key:"consultor",  label:"🧠 Consultor Financeiro" },
  ];

  return (
    <div style={{ background:"#fff", border:"1px solid #e2e8f0", borderRadius:16, padding:"24px 28px", marginBottom:20, boxShadow:"0 1px 3px rgba(0,0,0,.06)" }}>
      {/* Header */}
      <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:20 }}>
        <div style={{ width:44, height:44, borderRadius:12, background:"linear-gradient(135deg,#667eea,#764ba2)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:22 }}>✦</div>
        <div>
          <div style={{ fontWeight:800, fontSize:16, color:"#0f172a" }}>Consultoria Financeira com IA</div>
          <div style={{ fontSize:12, color:"#94a3b8" }}>Análise inteligente para tomada de decisões financeiras</div>
        </div>
      </div>

      {/* Cards de situação */}
      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(130px,1fr))", gap:10, marginBottom:20 }}>
        {[
          { label:"Saldo Total", value:"R$ " + saldoTotal.toFixed(2).replace(".",","), color: saldoTotal>=0?"#15803d":"#dc2626", bg: saldoTotal>=0?"#f0fdf4":"#fef2f2" },
          { label:"Vencidas", value: contasVencidas.length + " contas", sub:"R$ " + totalVencido.toFixed(2).replace(".",","), color:"#dc2626", bg:"#fef2f2" },
          { label:"Protestadas", value: contasProtestadas.length + " contas", sub:"R$ " + totalProtestado.toFixed(2).replace(".",","), color:"#7c3aed", bg:"#f5f3ff" },
          { label:"Multas+Juros", value:"R$ " + totalEncargos.toFixed(2).replace(".",","), color:"#d97706", bg:"#fffbeb" },
          { label:"Custo/Dia", value:"R$ " + custoDiario.toFixed(2).replace(".",","), color:"#0891b2", bg:"#ecfeff" },
        ].map(function(k) {
          return (
            <div key={k.label} style={{ background:k.bg, borderRadius:10, padding:"10px 12px" }}>
              <div style={{ fontSize:10, color:k.color, fontWeight:700, textTransform:"uppercase", marginBottom:3 }}>{k.label}</div>
              <div style={{ fontSize:14, fontWeight:800, color:k.color }}>{k.value}</div>
              {k.sub && <div style={{ fontSize:11, color:k.color, opacity:0.8 }}>{k.sub}</div>}
            </div>
          );
        })}
      </div>

      {/* Abas */}
      <div style={{ display:"flex", gap:4, marginBottom:20, background:"#f1f5f9", padding:4, borderRadius:10, flexWrap:"wrap" }}>
        {ABAS.map(function(a) {
          var active = aba === a.key;
          return (
            <button key={a.key} onClick={function(){ setAba(a.key); setState("idle"); setResult(null); setErrorMsg(""); }}
              style={{ flex:1, padding:"8px 12px", borderRadius:8, border:"none", cursor:"pointer", fontFamily:"inherit", fontSize:12, fontWeight: active?700:500,
                background: active?"#fff":"transparent", color: active?"#0f172a":"#94a3b8",
                boxShadow: active?"0 1px 3px rgba(0,0,0,.08)":"none", whiteSpace:"nowrap" }}>
              {a.label}
            </button>
          );
        })}
      </div>

      {/* Erro */}
      {state === "error" && (
        <div style={{ marginBottom:16 }}>
          <div style={{ background:"#fef2f2", border:"1px solid #fecaca", borderRadius:10, padding:"12px 16px", color:"#dc2626", fontSize:13, marginBottom:10 }}>⚠ {errorMsg}</div>
          <button onClick={function(){ setState("idle"); }} style={{ background:"#f8fafc", border:"1px solid #e2e8f0", color:"#334155", fontWeight:600, padding:"8px 16px", borderRadius:8, cursor:"pointer", fontSize:13 }}>Voltar</button>
        </div>
      )}

      {/* Loading */}
      {state === "loading" && (
        <div style={{ textAlign:"center", padding:"40px 0" }}>
          <div style={{ fontSize:36, marginBottom:12, display:"inline-block", animation:"spin 1s linear infinite" }}>✦</div>
          <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
          <div style={{ fontSize:14, color:"#64748b", fontWeight:600 }}>Analisando com IA...</div>
          <div style={{ fontSize:12, color:"#94a3b8", marginTop:4 }}>
            {aba==="prioridade" ? "Calculando prioridade de pagamentos" : aba==="emprestimo" ? "Avaliando custo x benefício do empréstimo" : "Consultando CFO virtual"}
          </div>
        </div>
      )}

      {/* ── ABA: PRIORIDADE ── */}
      {state === "idle" && aba === "prioridade" && (
        <div>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12, marginBottom:16 }}>
            <div>
              <div style={{ fontSize:11, color:"#94a3b8", marginBottom:6, fontWeight:600, textTransform:"uppercase" }}>Saldo disponível hoje (R$)</div>
              <input type="number" value={saldo} onChange={function(e){ setSaldo(e.target.value); }} placeholder="Ex: 5000,00"
                style={{ width:"100%", background:"#f8fafc", border:"1px solid #e2e8f0", color:"#0f172a", padding:"10px 14px", borderRadius:10, fontSize:13, outline:"none" }} />
            </div>
            <div>
              <div style={{ fontSize:11, color:"#94a3b8", marginBottom:6, fontWeight:600, textTransform:"uppercase" }}>Conta para pagamento</div>
              <select value={contaSelecionada} onChange={function(e){ setContaSelecionada(e.target.value); }}
                style={{ width:"100%", background:"#f8fafc", border:"1px solid #e2e8f0", color:"#334155", padding:"10px 14px", borderRadius:10, fontSize:13 }}>
                <option value="">— Opcional —</option>
                {contasBancarias.map(function(c){ return <option key={c.id} value={c.id}>{c.nome}</option>; })}
              </select>
            </div>
          </div>
          <button onClick={analisarPrioridade}
            style={{ width:"100%", background:"linear-gradient(135deg,#667eea,#764ba2)", border:"none", color:"#fff", fontWeight:700, padding:"13px", borderRadius:12, cursor:"pointer", fontSize:15 }}>
            ✦ Analisar Prioridade de Pagamentos
          </button>
        </div>
      )}

      {/* ── ABA: EMPRÉSTIMO ── */}
      {state === "idle" && aba === "emprestimo" && (
        <div>
          {contasVencidas.length === 0 && contasProtestadas.length === 0 && (
            <div style={{ background:"#f0fdf4", border:"1px solid #bbf7d0", borderRadius:10, padding:"12px 16px", marginBottom:16, fontSize:13, color:"#15803d" }}>
              ✓ Nenhuma conta vencida ou protestada. A análise vai considerar suas contas pendentes.
            </div>
          )}
          {(contasVencidas.length > 0 || contasProtestadas.length > 0) && (
            <div style={{ background:"#fef2f2", border:"1px solid #fecaca", borderRadius:10, padding:"12px 16px", marginBottom:16, fontSize:13, color:"#dc2626" }}>
              🚨 {contasVencidas.length} conta(s) vencida(s) e {contasProtestadas.length} protestada(s) — custo total de encargos: R$ {totalEncargos.toFixed(2).replace(".",",")}
            </div>
          )}
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:12, marginBottom:16 }}>
            <div>
              <div style={{ fontSize:11, color:"#94a3b8", marginBottom:6, fontWeight:600, textTransform:"uppercase" }}>Valor do Empréstimo (R$)</div>
              <input type="number" value={valorEmprestimo} onChange={function(e){ setValorEmprestimo(e.target.value); }} placeholder="Ex: 20000"
                style={{ width:"100%", background:"#f8fafc", border:"1px solid #e2e8f0", color:"#0f172a", padding:"10px 12px", borderRadius:10, fontSize:13, outline:"none" }} />
            </div>
            <div>
              <div style={{ fontSize:11, color:"#94a3b8", marginBottom:6, fontWeight:600, textTransform:"uppercase" }}>Juros ao mês (%)</div>
              <input type="number" step="0.1" value={taxaEmprestimo} onChange={function(e){ setTaxaEmprestimo(e.target.value); }} placeholder="Ex: 3"
                style={{ width:"100%", background:"#f8fafc", border:"1px solid #e2e8f0", color:"#0f172a", padding:"10px 12px", borderRadius:10, fontSize:13, outline:"none" }} />
            </div>
            <div>
              <div style={{ fontSize:11, color:"#94a3b8", marginBottom:6, fontWeight:600, textTransform:"uppercase" }}>Prazo (meses)</div>
              <input type="number" value={prazoEmprestimo} onChange={function(e){ setPrazoEmprestimo(e.target.value); }} placeholder="Ex: 12"
                style={{ width:"100%", background:"#f8fafc", border:"1px solid #e2e8f0", color:"#0f172a", padding:"10px 12px", borderRadius:10, fontSize:13, outline:"none" }} />
            </div>
          </div>
          {valorEmprestimo && taxaEmprestimo && prazoEmprestimo && (function() {
            var v = parseFloat(valorEmprestimo)||0, t = parseFloat(taxaEmprestimo)/100, p = parseInt(prazoEmprestimo);
            var parcela = v * t / (1 - Math.pow(1+t, -p));
            var custo = parcela * p;
            return (
              <div style={{ background:"#f8fafc", borderRadius:10, padding:"12px 14px", marginBottom:16, display:"flex", gap:20 }}>
                <div>
                  <div style={{ fontSize:11, color:"#94a3b8" }}>Parcela estimada</div>
                  <div style={{ fontSize:16, fontWeight:800, color:"#0f172a" }}>R$ {parcela.toFixed(2).replace(".",",")}/mês</div>
                </div>
                <div>
                  <div style={{ fontSize:11, color:"#94a3b8" }}>Custo total</div>
                  <div style={{ fontSize:16, fontWeight:800, color:"#dc2626" }}>R$ {custo.toFixed(2).replace(".",",")}</div>
                </div>
                <div>
                  <div style={{ fontSize:11, color:"#94a3b8" }}>Juros totais</div>
                  <div style={{ fontSize:16, fontWeight:800, color:"#d97706" }}>R$ {(custo - v).toFixed(2).replace(".",",")}</div>
                </div>
              </div>
            );
          })()}
          <button onClick={analisarEmprestimoFn}
            style={{ width:"100%", background:"linear-gradient(135deg,#667eea,#764ba2)", border:"none", color:"#fff", fontWeight:700, padding:"13px", borderRadius:12, cursor:"pointer", fontSize:15 }}>
            ✦ Analisar se Vale o Empréstimo
          </button>
        </div>
      )}

      {/* ── ABA: CONSULTOR CFO ── */}
      {state === "idle" && aba === "consultor" && (
        <div>
          <div style={{ background:"#f0f9ff", border:"1px solid #bae6fd", borderRadius:10, padding:"12px 16px", marginBottom:16, fontSize:13, color:"#0369a1" }}>
            🧠 Faça qualquer pergunta sobre sua situação financeira. O CFO virtual analisará seus dados reais e dará orientações práticas.
          </div>
          <div style={{ display:"flex", flexWrap:"wrap", gap:6, marginBottom:12 }}>
            {[
              "O que devo pagar primeiro?",
              "Estou em situação crítica?",
              "Como melhorar meu fluxo de caixa?",
              "Vale renegociar minhas dívidas?",
              "Consigo pagar tudo com meu saldo?",
              "Qual meu risco de insolvência?",
            ].map(function(q) {
              return (
                <button key={q} onClick={function(){ setPergunta(q); }}
                  style={{ fontSize:11, background:"#f1f5f9", border:"1px solid #e2e8f0", color:"#475569", padding:"5px 10px", borderRadius:20, cursor:"pointer", fontFamily:"inherit" }}>
                  {q}
                </button>
              );
            })}
          </div>
          <textarea
            value={pergunta}
            onChange={function(e){ setPergunta(e.target.value); }}
            placeholder="Digite sua dúvida financeira... Ex: 'Tenho R$ 10.000 disponíveis, vale a pena quitar as dívidas vencidas ou guardar para o próximo mês?'"
            rows={3}
            style={{ width:"100%", background:"#f8fafc", border:"1px solid #e2e8f0", color:"#0f172a", padding:"12px 14px", borderRadius:10, fontSize:13, outline:"none", resize:"vertical", fontFamily:"inherit", marginBottom:12, boxSizing:"border-box" }}
          />
          <button onClick={consultarCFO} disabled={!pergunta.trim()}
            style={{ width:"100%", background: pergunta.trim() ? "linear-gradient(135deg,#667eea,#764ba2)" : "#f1f5f9", border:"none", color: pergunta.trim() ? "#fff" : "#94a3b8", fontWeight:700, padding:"13px", borderRadius:12, cursor: pergunta.trim() ? "pointer" : "not-allowed", fontSize:15 }}>
            ✦ Consultar CFO Virtual
          </button>
        </div>
      )}

      {/* ── RESULTADO: PRIORIDADE ── */}
      {state === "done" && result && aba === "prioridade" && (
        <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
          <div style={{ background:"linear-gradient(135deg,#667eea22,#764ba222)", border:"1px solid #667eea44", borderRadius:12, padding:"14px 18px" }}>
            <div style={{ fontSize:13, color:"#0f172a", lineHeight:1.6 }}>{result.resumo}</div>
          </div>
          {result.alerta_critico && result.alerta_critico !== "null" && (
            <div style={{ background:"#fef2f2", border:"1px solid #fecaca", borderRadius:10, padding:"12px 16px", display:"flex", gap:10 }}>
              <span style={{ fontSize:18 }}>🚨</span>
              <div style={{ fontSize:13, color:"#dc2626", fontWeight:600 }}>{result.alerta_critico}</div>
            </div>
          )}
          <div>
            <div style={{ fontWeight:700, fontSize:14, color:"#0f172a", marginBottom:12 }}>Ordem de Prioridade</div>
            <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
              {(result.prioridade||[]).map(function(item, i) {
                var conta = contasPagar.find(function(c){ return c.id === item.id || String(c.id) === String(item.id); });
                return (
                  <div key={i} style={{ background:urgenciaBg(item.urgencia), border:"1px solid " + urgenciaCor(item.urgencia) + "33", borderRadius:12, padding:"14px 16px" }}>
                    <div style={{ display:"flex", alignItems:"flex-start", gap:12 }}>
                      <div style={{ width:36, height:36, borderRadius:10, background:urgenciaCor(item.urgencia), color:"#fff", display:"flex", alignItems:"center", justifyContent:"center", fontWeight:800, fontSize:16, flexShrink:0 }}>{item.posicao}</div>
                      <div style={{ flex:1 }}>
                        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:6 }}>
                          <div>
                            <div style={{ fontWeight:700, fontSize:14, color:"#0f172a" }}>{conta?.descricao || "Conta #" + item.id}</div>
                            <span style={{ fontSize:11, fontWeight:600, color:urgenciaCor(item.urgencia), background:urgenciaBg(item.urgencia), padding:"2px 8px", borderRadius:20, border:"1px solid " + urgenciaCor(item.urgencia) + "44" }}>{urgenciaLabel(item.urgencia)}</span>
                          </div>
                          {conta?.valor && <div style={{ fontSize:15, fontWeight:800, color:"#0f172a" }}>R$ {parseFloat(conta.valor).toFixed(2).replace(".",",")}</div>}
                        </div>
                        <div style={{ fontSize:13, color:"#475569", lineHeight:1.5 }}>{item.razao}</div>
                        {item.pagar_hoje && <span style={{ fontSize:11, background:"#dc2626", color:"#fff", padding:"3px 10px", borderRadius:20, fontWeight:700, display:"inline-block", marginTop:6 }}>⚡ Pagar hoje</span>}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          <div style={{ background:"#fffbeb", border:"1px solid #fde68a", borderRadius:12, padding:"14px 18px" }}>
            <div style={{ fontSize:11, color:"#92400e", fontWeight:700, textTransform:"uppercase", marginBottom:6 }}>✦ Recomendação Final</div>
            <div style={{ fontSize:13, color:"#1c1917", lineHeight:1.6 }}>{result.recomendacao_final}</div>
          </div>
          <button onClick={function(){ setState("idle"); setResult(null); }} style={{ background:"#f8fafc", border:"1px solid #e2e8f0", color:"#64748b", fontWeight:600, padding:"10px", borderRadius:10, cursor:"pointer" }}>Nova Análise</button>
        </div>
      )}

      {/* ── RESULTADO: EMPRÉSTIMO ── */}
      {state === "done" && result && aba === "emprestimo" && (
        <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
          <div style={{ background: result.viavel ? "#f0fdf4" : "#fef2f2", border:"1px solid " + (result.viavel ? "#bbf7d0" : "#fecaca"), borderRadius:12, padding:"16px 20px", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
            <div>
              <div style={{ fontSize:11, color: result.viavel?"#15803d":"#dc2626", fontWeight:700, textTransform:"uppercase", marginBottom:4 }}>Veredito da IA</div>
              <div style={{ fontSize:20, fontWeight:800, color: result.viavel?"#15803d":"#dc2626" }}>{result.viavel ? "✅ Empréstimo Recomendado" : "⚠️ Cautela — Avalie Alternativas"}</div>
            </div>
            <div style={{ textAlign:"right" }}>
              <div style={{ fontSize:11, color:"#94a3b8", marginBottom:4 }}>Risco</div>
              <span style={{ fontSize:13, fontWeight:700, color: result.score_risco==="alto"?"#dc2626":result.score_risco==="medio"?"#d97706":"#15803d", background: result.score_risco==="alto"?"#fef2f2":result.score_risco==="medio"?"#fffbeb":"#f0fdf4", padding:"4px 12px", borderRadius:20 }}>
                {result.score_risco==="alto"?"🔴 Alto":result.score_risco==="medio"?"🟡 Médio":"🟢 Baixo"}
              </span>
            </div>
          </div>
          {result.economia_estimada > 0 && (
            <div style={{ background:"#f0fdf4", border:"1px solid #bbf7d0", borderRadius:10, padding:"12px 16px", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
              <span style={{ fontSize:13, color:"#15803d", fontWeight:600 }}>💰 Economia estimada pagando as dívidas</span>
              <span style={{ fontSize:17, fontWeight:800, color:"#15803d" }}>R$ {result.economia_estimada.toFixed(2).replace(".",",")}</span>
            </div>
          )}
          <div style={{ background:"#f8fafc", borderRadius:12, padding:"14px 18px" }}>
            <div style={{ fontSize:11, color:"#94a3b8", fontWeight:700, textTransform:"uppercase", marginBottom:8 }}>📊 Custo x Benefício</div>
            <div style={{ fontSize:13, color:"#0f172a", lineHeight:1.7 }}>{result.analise_custo_beneficio}</div>
          </div>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12 }}>
            <div style={{ background:"#fef2f2", border:"1px solid #fecaca", borderRadius:10, padding:"12px 14px" }}>
              <div style={{ fontSize:11, color:"#dc2626", fontWeight:700, textTransform:"uppercase", marginBottom:6 }}>⚠️ Risco sem empréstimo</div>
              <div style={{ fontSize:12, color:"#7f1d1d", lineHeight:1.6 }}>{result.risco_sem_emprestimo}</div>
            </div>
            <div style={{ background:"#f5f3ff", border:"1px solid #c4b5fd", borderRadius:10, padding:"12px 14px" }}>
              <div style={{ fontSize:11, color:"#7c3aed", fontWeight:700, textTransform:"uppercase", marginBottom:6 }}>⚖️ Impacto do protesto</div>
              <div style={{ fontSize:12, color:"#4c1d95", lineHeight:1.6 }}>{result.impacto_protesto}</div>
            </div>
          </div>
          <div style={{ background:"#f8fafc", borderRadius:12, padding:"14px 18px" }}>
            <div style={{ fontSize:11, color:"#94a3b8", fontWeight:700, textTransform:"uppercase", marginBottom:10 }}>🔀 Alternativas ao Empréstimo</div>
            <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
              {(result.alternativas||[]).map(function(a, i) {
                return <div key={i} style={{ display:"flex", gap:8, alignItems:"flex-start" }}><span style={{ color:"#667eea", fontWeight:700, flexShrink:0 }}>{i+1}.</span><span style={{ fontSize:13, color:"#334155" }}>{a}</span></div>;
              })}
            </div>
          </div>
          <div style={{ background:"linear-gradient(135deg,#667eea22,#764ba222)", border:"1px solid #667eea44", borderRadius:12, padding:"14px 18px" }}>
            <div style={{ fontSize:11, color:"#4338ca", fontWeight:700, textTransform:"uppercase", marginBottom:6 }}>✦ Recomendação</div>
            <div style={{ fontSize:13, color:"#0f172a", lineHeight:1.6 }}>{result.recomendacao}</div>
          </div>
          <div style={{ background:"#f8fafc", borderRadius:12, padding:"14px 18px" }}>
            <div style={{ fontSize:11, color:"#94a3b8", fontWeight:700, textTransform:"uppercase", marginBottom:10 }}>🗒️ Plano de Ação</div>
            <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
              {(result.plano_acao||[]).map(function(p, i) {
                return (
                  <div key={i} style={{ display:"flex", gap:10, alignItems:"flex-start" }}>
                    <div style={{ width:22, height:22, borderRadius:6, background:"#0f172a", color:"#fff", display:"flex", alignItems:"center", justifyContent:"center", fontSize:11, fontWeight:700, flexShrink:0 }}>{i+1}</div>
                    <span style={{ fontSize:13, color:"#0f172a", lineHeight:1.5 }}>{p}</span>
                  </div>
                );
              })}
            </div>
          </div>
          <button onClick={function(){ setState("idle"); setResult(null); }} style={{ background:"#f8fafc", border:"1px solid #e2e8f0", color:"#64748b", fontWeight:600, padding:"10px", borderRadius:10, cursor:"pointer" }}>Nova Análise</button>
        </div>
      )}

      {/* ── RESULTADO: CONSULTOR CFO ── */}
      {state === "done" && result && aba === "consultor" && (
        <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
          <div style={{ background:"#f0f9ff", border:"1px solid #bae6fd", borderRadius:10, padding:"10px 14px", fontSize:12, color:"#0369a1" }}>
            💬 "{pergunta}"
          </div>
          <div style={{ background: situacaoBg(result.situacao), border:"1px solid " + situacaoCor(result.situacao) + "44", borderRadius:12, padding:"14px 18px" }}>
            <div style={{ fontSize:11, color:situacaoCor(result.situacao), fontWeight:700, textTransform:"uppercase", marginBottom:8 }}>
              {result.situacao==="critica"?"🚨 Situação Crítica":result.situacao==="atencao"?"⚠️ Atenção Necessária":result.situacao==="estavel"?"✅ Situação Estável":"🟢 Situação Ótima"}
            </div>
            <div style={{ fontSize:13, color:"#0f172a", lineHeight:1.7, whiteSpace:"pre-line" }}>{result.resposta}</div>
          </div>
          {(result.indicadores||[]).length > 0 && (
            <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(140px,1fr))", gap:10 }}>
              {result.indicadores.map(function(ind, i) {
                return (
                  <div key={i} style={{ background:"#f8fafc", border:"1px solid #e2e8f0", borderRadius:10, padding:"10px 12px" }}>
                    <div style={{ fontSize:10, color:"#94a3b8", fontWeight:600, textTransform:"uppercase", marginBottom:4 }}>{ind.label}</div>
                    <div style={{ fontSize:15, fontWeight:800, color:statusCor(ind.status) }}>{ind.valor}</div>
                  </div>
                );
              })}
            </div>
          )}
          {(result.acoes_imediatas||[]).length > 0 && (
            <div style={{ background:"#f8fafc", borderRadius:12, padding:"14px 18px" }}>
              <div style={{ fontSize:11, color:"#94a3b8", fontWeight:700, textTransform:"uppercase", marginBottom:10 }}>⚡ Ações Imediatas</div>
              <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
                {result.acoes_imediatas.map(function(a, i) {
                  return (
                    <div key={i} style={{ display:"flex", gap:10, alignItems:"flex-start" }}>
                      <div style={{ width:22, height:22, borderRadius:6, background:"linear-gradient(135deg,#667eea,#764ba2)", color:"#fff", display:"flex", alignItems:"center", justifyContent:"center", fontSize:11, fontWeight:700, flexShrink:0 }}>{i+1}</div>
                      <span style={{ fontSize:13, color:"#0f172a", lineHeight:1.5 }}>{a}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          <div style={{ display:"flex", gap:8 }}>
            <button onClick={function(){ setState("idle"); setResult(null); setPergunta(""); }} style={{ flex:1, background:"#f8fafc", border:"1px solid #e2e8f0", color:"#64748b", fontWeight:600, padding:"10px", borderRadius:10, cursor:"pointer" }}>Nova Pergunta</button>
            <button onClick={function(){ setState("idle"); setResult(null); }} style={{ flex:1, background:"#0f172a", border:"none", color:"#fff", fontWeight:700, padding:"10px", borderRadius:10, cursor:"pointer" }}>Refinar Análise</button>
          </div>
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
  var valorTotal = parseFloat(conta.valor || 0);
  const [contaBancariaId, setContaBancariaId] = useState(contasBancarias[0]?.id || "");
  const [dataPagamento, setDataPagamento] = useState(new Date().toLocaleDateString("sv-SE"));
  const [obs, setObs] = useState("");
  const [tipoPagamento, setTipoPagamento] = useState("total");
  const [valorParcial, setValorParcial] = useState(valorTotal.toFixed(2));

  var valorFinal = tipoPagamento === "total" ? valorTotal : parseFloat(valorParcial || 0);
  var canConfirm = contaBancariaId && dataPagamento && valorFinal > 0;

  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(15,23,42,.6)", backdropFilter:"blur(4px)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:500, padding:24 }}>
      <div style={{ background:"#fff", borderRadius:16, width:"100%", maxWidth:440, padding:"28px 32px", boxShadow:"0 20px 60px rgba(0,0,0,.15)" }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:16 }}>
          <div style={{ fontWeight:800, fontSize:17, color:"#0f172a" }}>💸 Dar Baixa</div>
          <button onClick={onClose} style={{ background:"#f1f5f9", border:"none", color:"#64748b", width:32, height:32, borderRadius:8, cursor:"pointer", fontSize:16 }}>✕</button>
        </div>
        <div style={{ background:"#f8fafc", borderRadius:10, padding:"12px 16px", marginBottom:16 }}>
          <div style={{ fontSize:12, color:"#94a3b8", marginBottom:2 }}>Conta a pagar</div>
          <div style={{ fontSize:14, fontWeight:700, color:"#0f172a" }}>{conta.descricao}</div>
          <div style={{ fontSize:16, fontWeight:800, color:"#dc2626", marginTop:4 }}>R$ {valorTotal.toFixed(2).replace(".",",")}</div>
        </div>
        <div style={{ display:"flex", flexDirection:"column", gap:12, marginBottom:16 }}>
          <div>
            <div style={{ fontSize:11, color:"#94a3b8", marginBottom:8, fontWeight:600, textTransform:"uppercase" }}>Tipo de pagamento</div>
            <div style={{ display:"flex", gap:8 }}>
              {[{k:"total",l:"💯 Valor Total"},{k:"parcial",l:"✂️ Valor Parcial"}].map(function(op) {
                var active = tipoPagamento === op.k;
                return (
                  <button key={op.k} onClick={function() { setTipoPagamento(op.k); }}
                    style={{ flex:1, padding:"9px", borderRadius:8, border: active ? "2px solid #0f172a" : "1px solid #e2e8f0",
                      background: active ? "#0f172a" : "#f8fafc", color: active ? "#fff" : "#64748b",
                      fontWeight:600, fontSize:12, cursor:"pointer" }}>
                    {op.l}
                  </button>
                );
              })}
            </div>
          </div>
          {tipoPagamento === "parcial" && (
            <div>
              <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Valor a pagar agora (R$)</div>
              <input
                type="number"
                value={valorParcial}
                onChange={function(e) { setValorParcial(e.target.value); }}
                placeholder="0,00"
                max={valorTotal}
                style={{ width:"100%", background:"#f8fafc", border:"1px solid #e2e8f0", color:"#0f172a", padding:"9px 12px", borderRadius:8, fontSize:13, outline:"none" }}
              />
              {parseFloat(valorParcial||0) < valorTotal && parseFloat(valorParcial||0) > 0 && (
                <div style={{ fontSize:11, color:"#d97706", marginTop:4 }}>
                  Saldo restante: R$ {(valorTotal - parseFloat(valorParcial||0)).toFixed(2).replace(".",",")} — a conta ficará como Pago Parcial
                </div>
              )}
            </div>
          )}
          <div>
            <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Pagar com qual conta *</div>
            {contasBancarias.length === 0 ? (
              <div style={{ color:"#dc2626", fontSize:13 }}>⚠ Cadastre uma conta bancária primeiro</div>
            ) : (
              <select value={contaBancariaId} onChange={function(e) { setContaBancariaId(e.target.value); }}
                style={{ width:"100%", background:"#f8fafc", border:"1px solid #e2e8f0", color:"#334155", padding:"9px 12px", borderRadius:8, fontSize:13 }}>
                {contasBancarias.map(function(c) { return <option key={c.id} value={c.id}>{c.nome}</option>; })}
              </select>
            )}
          </div>
          <div>
            <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Data do pagamento</div>
            <input type="date" value={dataPagamento} onChange={function(e) { setDataPagamento(e.target.value); }}
              style={{ width:"100%", background:"#f8fafc", border:"1px solid #e2e8f0", color:"#334155", padding:"9px 12px", borderRadius:8, fontSize:13 }} />
          </div>
          <div>
            <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Observação</div>
            <input value={obs} onChange={function(e) { setObs(e.target.value); }} placeholder="Opcional"
              style={{ width:"100%", background:"#f8fafc", border:"1px solid #e2e8f0", color:"#0f172a", padding:"9px 12px", borderRadius:8, fontSize:13, outline:"none" }} />
          </div>
          <div style={{ background: tipoPagamento==="total" ? "#f0fdf4" : "#fffbeb", border:"1px solid", borderColor: tipoPagamento==="total" ? "#bbf7d0" : "#fde68a", borderRadius:8, padding:"10px 14px" }}>
            <div style={{ fontSize:11, color:"#94a3b8", marginBottom:2 }}>Valor a ser baixado</div>
            <div style={{ fontSize:18, fontWeight:800, color: tipoPagamento==="total" ? "#15803d" : "#d97706" }}>
              R$ {valorFinal.toFixed(2).replace(".",",")}
            </div>
          </div>
        </div>
        <div style={{ display:"flex", gap:8 }}>
          <button onClick={onClose} style={{ flex:1, background:"#f8fafc", border:"1px solid #e2e8f0", color:"#64748b", fontWeight:600, padding:"11px", borderRadius:10, cursor:"pointer" }}>Cancelar</button>
          <button
            onClick={function() { if (canConfirm) { onConfirm({ contaBancariaId, dataPagamento, obs, valorPago: valorFinal, parcial: tipoPagamento === "parcial" && valorFinal < valorTotal }); onClose(); } }}
            disabled={!canConfirm}
            style={{ flex:2, background: canConfirm ? "#15803d" : "#f1f5f9", border:"none", color: canConfirm ? "#fff" : "#94a3b8", fontWeight:700, padding:"11px", borderRadius:10, cursor: canConfirm ? "pointer" : "not-allowed" }}>
            ✓ Confirmar Pagamento
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Modal de Baixa em Lote ──────────────────────────────────
function ModalMultiBaixa({ contas, contasBancarias, onConfirm, onClose }) {
  var total = contas.reduce(function(s,c){ return s + parseFloat(c.valor||0); }, 0);
  const [contaBancariaId, setContaBancariaId] = useState(contasBancarias[0]?.id || "");
  const [dataPagamento, setDataPagamento] = useState(new Date().toLocaleDateString("sv-SE"));
  const [obs, setObs] = useState("");
  var canConfirm = contaBancariaId && dataPagamento;
  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(15,23,42,.6)", backdropFilter:"blur(4px)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:500, padding:24 }}>
      <div style={{ background:"#fff", borderRadius:16, width:"100%", maxWidth:480, maxHeight:"90vh", overflowY:"auto", padding:"28px 32px", boxShadow:"0 20px 60px rgba(0,0,0,.15)" }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:16 }}>
          <div style={{ fontWeight:800, fontSize:17, color:"#0f172a" }}>💸 Baixa em Lote</div>
          <button onClick={onClose} style={{ background:"#f1f5f9", border:"none", color:"#64748b", width:32, height:32, borderRadius:8, cursor:"pointer", fontSize:16 }}>✕</button>
        </div>
        <div style={{ background:"#f8fafc", borderRadius:10, padding:"12px 16px", marginBottom:16, maxHeight:160, overflowY:"auto" }}>
          <div style={{ fontSize:11, color:"#94a3b8", marginBottom:8, fontWeight:600 }}>{contas.length} CONTA(S) SELECIONADA(S)</div>
          {contas.map(function(c) {
            return (
              <div key={c.id} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"4px 0", borderBottom:"1px solid #f1f5f9" }}>
                <span style={{ fontSize:12, color:"#0f172a" }}>{c.descricao}</span>
                <span style={{ fontSize:12, fontWeight:700, color:"#dc2626" }}>R$ {parseFloat(c.valor||0).toFixed(2).replace(".",",")}</span>
              </div>
            );
          })}
        </div>
        <div style={{ background:"#fef2f2", borderRadius:8, padding:"10px 14px", marginBottom:16, display:"flex", justifyContent:"space-between", alignItems:"center" }}>
          <span style={{ fontSize:13, fontWeight:600, color:"#dc2626" }}>Total a pagar</span>
          <span style={{ fontSize:20, fontWeight:800, color:"#dc2626" }}>R$ {total.toFixed(2).replace(".",",")}</span>
        </div>
        <div style={{ display:"flex", flexDirection:"column", gap:12, marginBottom:16 }}>
          <div>
            <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Pagar com qual conta *</div>
            {contasBancarias.length === 0 ? (
              <div style={{ color:"#dc2626", fontSize:13 }}>⚠ Cadastre uma conta bancária primeiro</div>
            ) : (
              <select value={contaBancariaId} onChange={function(e){ setContaBancariaId(e.target.value); }}
                style={{ width:"100%", background:"#f8fafc", border:"1px solid #e2e8f0", color:"#334155", padding:"9px 12px", borderRadius:8, fontSize:13 }}>
                {contasBancarias.map(function(c){ return <option key={c.id} value={c.id}>{c.nome}</option>; })}
              </select>
            )}
          </div>
          <div>
            <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Data do pagamento</div>
            <input type="date" value={dataPagamento} onChange={function(e){ setDataPagamento(e.target.value); }}
              style={{ width:"100%", background:"#f8fafc", border:"1px solid #e2e8f0", color:"#334155", padding:"9px 12px", borderRadius:8, fontSize:13 }} />
          </div>
          <div>
            <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Observação</div>
            <input value={obs} onChange={function(e){ setObs(e.target.value); }} placeholder="Opcional"
              style={{ width:"100%", background:"#f8fafc", border:"1px solid #e2e8f0", color:"#0f172a", padding:"9px 12px", borderRadius:8, fontSize:13, outline:"none" }} />
          </div>
        </div>
        <div style={{ display:"flex", gap:8 }}>
          <button onClick={onClose} style={{ flex:1, background:"#f8fafc", border:"1px solid #e2e8f0", color:"#64748b", fontWeight:600, padding:"11px", borderRadius:10, cursor:"pointer" }}>Cancelar</button>
          <button
            onClick={function(){ if(canConfirm){ onConfirm({ contaBancariaId, dataPagamento, obs }); onClose(); } }}
            disabled={!canConfirm}
            style={{ flex:2, background: canConfirm?"#15803d":"#f1f5f9", border:"none", color: canConfirm?"#fff":"#94a3b8", fontWeight:700, padding:"11px", borderRadius:10, cursor: canConfirm?"pointer":"not-allowed" }}>
            ✓ Confirmar Pagamento de {contas.length} Conta(s)
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Modal de Baixa de Recebimento ML ────────────────────────
function ModalBaixaML({ order, paymentInfo, contasBancarias, onConfirm, onClose }) {
  const mpConta = contasBancarias.find(c => c.nome.toLowerCase().includes("mercado pago filial sp")) 
    || contasBancarias.find(c => c.nome.toLowerCase().includes("mercado pago"));
  const [contaBancariaId, setContaBancariaId] = useState(mpConta?.id || contasBancarias[0]?.id || "");
  const [dataRecebimento, setDataRecebimento] = useState(paymentInfo?.releaseDate || new Date().toLocaleDateString("sv-SE"));
  // Usar fee e freteSeller do pedido (mesmos da aba Pedidos) para cálculo preciso
  var brutoModal = order.price * order.qty;
  var tarifaModal = (order.fee || 0) * (order.qty || 1);
  var freteModal = order.freteSeller || 0;
  // Líquido = Bruto - Tarifa ML - Frete (custo) — mesma fórmula da tabela
  var netPedido = brutoModal - tarifaModal - freteModal;
  const valor = netPedido > 0 ? netPedido : brutoModal * 0.87;
  const isValorReal = !!(paymentInfo?.netAmount && !paymentInfo?.isCalculated);
  const isValorCalc = !!(paymentInfo?.netAmount && paymentInfo?.isCalculated) || (netPedido > 0 && !paymentInfo?.netAmount);
  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(15,23,42,.6)", backdropFilter:"blur(4px)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:500, padding:24 }}>
      <div style={{ background:"#fff", borderRadius:16, width:"100%", maxWidth:400, padding:"28px 32px", boxShadow:"0 20px 60px rgba(0,0,0,.15)" }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:16 }}>
          <div style={{ fontWeight:800, fontSize:17, color:"#0f172a" }}>Registrar Recebimento</div>
          <button onClick={onClose} style={{ background:"#f1f5f9", border:"none", color:"#64748b", width:32, height:32, borderRadius:8, cursor:"pointer", fontSize:16 }}>✕</button>
        </div>
        <div style={{ background: isValorReal?"#f0fdf4":isValorCalc?"#eff6ff":"#fffbeb", borderRadius:10, padding:"12px 16px", marginBottom:16 }}>
          <div style={{ fontSize:12, color:"#94a3b8", marginBottom:2 }}>Pedido #{order.id}</div>
          <div style={{ fontSize:13, color:"#0f172a", marginBottom:6, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{order.title||"—"}</div>
          <div style={{ display:"flex", gap:16, alignItems:"flex-end", flexWrap:"wrap" }}>
            <div>
              <div style={{ fontSize:10, color:"#94a3b8", marginBottom:2 }}>Valor bruto</div>
              <div style={{ fontSize:13, fontWeight:600, color:"#64748b", textDecoration:"line-through" }}>R$ {brutoModal.toFixed(2).replace(".",",")}</div>
            </div>
            {tarifaModal > 0 && (
              <div>
                <div style={{ fontSize:10, color:"#94a3b8", marginBottom:2 }}>Tarifa ML</div>
                <div style={{ fontSize:13, fontWeight:600, color:"#d97706" }}>-R$ {tarifaModal.toFixed(2).replace(".",",")}</div>
              </div>
            )}
            {freteModal > 0 && (
              <div>
                <div style={{ fontSize:10, color:"#94a3b8", marginBottom:2 }}>Frete (custo)</div>
                <div style={{ fontSize:13, fontWeight:600, color:"#7c3aed" }}>-R$ {freteModal.toFixed(2).replace(".",",")}</div>
              </div>
            )}
            <div>
              <div style={{ fontSize:10, color: isValorReal?"#15803d":"#0891b2", marginBottom:2, fontWeight:600 }}>
                {isValorReal ? "✓ Líquido real (API ML)" : "= Líquido calculado"}
              </div>
              <div style={{ fontSize:20, fontWeight:800, color: isValorReal?"#15803d":"#0891b2" }}>
                R$ {valor.toFixed(2).replace(".",",")}
              </div>
            </div>
          </div>
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

// ── Componente de Upload de Anexos ──────────────────────────
function AnexosUpload({ anexos, onChange }) {
  function handleFiles(e) {
    var files = Array.from(e.target.files);
    var promises = files.map(function(f) {
      return new Promise(function(res) {
        var reader = new FileReader();
        reader.onload = function(ev) {
          res({ nome: f.name, tipo: f.type, tamanho: f.size, base64: ev.target.result });
        };
        reader.readAsDataURL(f);
      });
    });
    Promise.all(promises).then(function(converted) {
      onChange([].concat(anexos, converted).slice(0, 5));
    });
    e.target.value = "";
  }
  function remover(idx) {
    onChange(anexos.filter(function(_, j) { return j !== idx; }));
  }
  return (
    <div>
      <label style={{ display:"block", border:"2px dashed #e2e8f0", borderRadius:10, padding:"12px", textAlign:"center", cursor:"pointer", background:"#f8fafc", marginBottom:8 }}>
        <input
          type="file"
          multiple
          accept=".pdf,.jpg,.jpeg,.png,.webp,.xml,.xlsx,.xls,.doc,.docx"
          style={{ display:"none" }}
          onChange={handleFiles}
        />
        <div style={{ fontSize:13, color:"#64748b" }}>📎 Clique para anexar arquivos</div>
        <div style={{ fontSize:11, color:"#94a3b8", marginTop:2 }}>PDF, imagens, XML, Word, Excel — máx. 5 arquivos</div>
      </label>
      {anexos.length > 0 && (
        <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
          {anexos.map(function(a, i) {
            var isImg = a.tipo && a.tipo.startsWith("image/");
            var icon = isImg ? "🖼️" : a.tipo === "application/pdf" ? "📄" : "📎";
            var kb = (a.tamanho / 1024).toFixed(1);
            return (
              <div key={i} style={{ display:"flex", alignItems:"center", gap:10, background:"#f8fafc", border:"1px solid #e2e8f0", borderRadius:8, padding:"8px 12px" }}>
                <span style={{ fontSize:18 }}>{icon}</span>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ fontSize:12, fontWeight:600, color:"#0f172a", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{a.nome}</div>
                  <div style={{ fontSize:10, color:"#94a3b8" }}>{kb} KB</div>
                </div>
                {isImg && (
                  <img src={a.base64} alt={a.nome} style={{ width:36, height:36, objectFit:"cover", borderRadius:6, border:"1px solid #e2e8f0", flexShrink:0 }} />
                )}
                <a href={a.base64} download={a.nome} style={{ background:"#f1f5f9", border:"1px solid #e2e8f0", color:"#64748b", width:26, height:26, borderRadius:6, fontSize:13, display:"flex", alignItems:"center", justifyContent:"center", textDecoration:"none", flexShrink:0 }}>⬇</a>
                <button onClick={function() { remover(i); }} style={{ background:"#fef2f2", border:"none", color:"#dc2626", width:26, height:26, borderRadius:6, cursor:"pointer", fontSize:11, flexShrink:0 }}>✕</button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Modal de Conta a Pagar ───────────────────────────────────
function ModalConta({ conta, categoriasPagar, fornecedores, onSave, onClose }) {
  const initForm = {
    id: Date.now(), descricao: "", fornecedorId: "", fornecedorNome: "", fornecedorCNPJ: "",
    categoria: categoriasPagar[0] || "Outros", recorrencia: "unica", totalParcelas: "",
    intervaloParcelas: "mensal", valor: "", vencimento: "", status: "Pendente", observacao: "",
    multaTipo: "%", multaPct: "", jurosTipo: "%", jurosDia: "", temProtesto: false,
    diasProtesto: "", cartorio: "", anexos: [], prioridade: "media"
  };
  const [form, setForm] = useState(conta || initForm);
  const set = (k, v) => setForm(function(f) { return Object.assign({}, f, { [k]: v }); });
  const [sugestoes, setSugestoes] = useState([]);
  const [showSug, setShowSug] = useState(false);

  function onDescChange(val) {
    set("descricao", val);
    if (val.length >= 2 && fornecedores && fornecedores.length > 0) {
      var q = val.toLowerCase();
      var found = fornecedores.filter(function(f) {
        return (f.nome && f.nome.toLowerCase().includes(q)) || (f.cnpj && f.cnpj.includes(q));
      }).slice(0, 6);
      setSugestoes(found);
      setShowSug(found.length > 0);
    } else {
      setShowSug(false);
    }
  }

  function selecionarForn(forn) {
    setForm(function(f) {
      return Object.assign({}, f, {
        descricao: forn.nome, fornecedorId: forn.id,
        fornecedorNome: forn.nome, fornecedorCNPJ: forn.cnpj || ""
      });
    });
    setShowSug(false);
  }

  var canSave = form.descricao && form.valor;
  var btnStyle = {
    flex: 2, border: "none", fontWeight: 700, padding: "11px", borderRadius: 10,
    cursor: canSave ? "pointer" : "not-allowed",
    background: canSave ? "#0f172a" : "#f1f5f9",
    color: canSave ? "#fff" : "#94a3b8"
  };

  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(15,23,42,.6)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:400, padding:24 }}>
      <div style={{ background:"#fff", borderRadius:16, width:"100%", maxWidth:520, maxHeight:"90vh", overflowY:"auto", padding:"28px 32px", boxShadow:"0 20px 60px rgba(0,0,0,.15)" }}>

        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:20 }}>
          <div style={{ fontWeight:800, fontSize:17, color:"#0f172a" }}>{conta ? "Editar Conta" : "Nova Conta a Pagar"}</div>
          <button onClick={onClose} style={{ background:"#f1f5f9", border:"none", color:"#64748b", width:32, height:32, borderRadius:8, cursor:"pointer", fontSize:16 }}>✕</button>
        </div>

        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12, marginBottom:16 }}>

          {/* Descrição */}
          <div style={{ gridColumn:"1/-1", position:"relative" }}>
            <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Descrição / Fornecedor *</div>
            <input
              value={form.descricao}
              onChange={function(e) { onDescChange(e.target.value); }}
              onBlur={function() { setTimeout(function() { setShowSug(false); }, 150); }}
              onFocus={function() { if (form.descricao.length >= 2 && sugestoes.length > 0) setShowSug(true); }}
              placeholder="Digite o nome do fornecedor ou descrição..."
              style={{ width:"100%", background:"#f8fafc", border:"1px solid #e2e8f0", color:"#0f172a", padding:"9px 12px", borderRadius:8, fontSize:13, outline:"none" }}
            />
            {showSug && sugestoes.length > 0 && (
              <div style={{ position:"absolute", top:"100%", left:0, right:0, background:"#fff", border:"1px solid #e2e8f0", borderRadius:10, boxShadow:"0 8px 24px rgba(0,0,0,.12)", zIndex:50, overflow:"hidden" }}>
                {sugestoes.map(function(f) {
                  return (
                    <div key={f.id} onClick={function() { selecionarForn(f); }} style={{ padding:"10px 14px", cursor:"pointer", borderBottom:"1px solid #f1f5f9", fontSize:13 }}>
                      <div style={{ fontWeight:600, color:"#0f172a" }}>{f.nome}</div>
                      {f.cnpj && <div style={{ fontSize:11, color:"#94a3b8" }}>{f.cnpj}</div>}
                    </div>
                  );
                })}
                <div style={{ padding:"6px 14px", background:"#f8fafc", borderTop:"1px solid #f1f5f9", fontSize:11, color:"#94a3b8" }}>
                  Fornecedor cadastrado
                </div>
              </div>
            )}
            {form.fornecedorNome && (
              <div style={{ display:"flex", alignItems:"center", gap:6, marginTop:6 }}>
                <span style={{ fontSize:11, background:"#f0fdf4", color:"#15803d", border:"1px solid #bbf7d0", borderRadius:6, padding:"2px 8px", fontWeight:600 }}>✓ {form.fornecedorNome}</span>
                {form.fornecedorCNPJ && <span style={{ fontSize:11, color:"#94a3b8" }}>CNPJ: {form.fornecedorCNPJ}</span>}
              </div>
            )}
          </div>

          {/* Categoria */}
          <div>
            <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Categoria</div>
            <select value={form.categoria} onChange={function(e) { set("categoria", e.target.value); }}
              style={{ width:"100%", background:"#f8fafc", border:"1px solid #e2e8f0", color:"#334155", padding:"9px 12px", borderRadius:8, fontSize:13 }}>
              {categoriasPagar.map(function(c) { return <option key={c}>{c}</option>; })}
            </select>
          </div>

          {/* Valor */}
          <div>
            <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Valor (R$) *</div>
            <input type="number" value={form.valor} onChange={function(e) { set("valor", e.target.value); }} placeholder="0,00"
              style={{ width:"100%", background:"#f8fafc", border:"1px solid #e2e8f0", color:"#0f172a", padding:"9px 12px", borderRadius:8, fontSize:13, outline:"none" }} />
          </div>

          {/* Vencimento */}
          <div>
            <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Vencimento</div>
            <input type="date" value={form.vencimento} onChange={function(e) { set("vencimento", e.target.value); }}
              style={{ width:"100%", background:"#f8fafc", border:"1px solid #e2e8f0", color:"#334155", padding:"9px 12px", borderRadius:8, fontSize:13 }} />
          </div>

          {/* Recorrência */}
          <div style={{ gridColumn:"1/-1" }}>
            <div style={{ fontSize:11, color:"#94a3b8", marginBottom:8, fontWeight:600, textTransform:"uppercase" }}>Tipo de Ocorrência</div>
            <div style={{ display:"flex", flexWrap:"wrap", gap:6 }}>
              {["unica","parcelada","semanal","quinzenal","mensal","bimestral","trimestral","semestral","anual"].map(function(key) {
                var labels = { unica:"Única", parcelada:"Parcelada", semanal:"Semanal", quinzenal:"Quinzenal", mensal:"Mensal", bimestral:"Bimestral", trimestral:"Trimestral", semestral:"Semestral", anual:"Anual" };
                var active = (form.recorrencia || "unica") === key;
                return (
                  <button key={key} onClick={function() { set("recorrencia", key); }}
                    style={{ padding:"6px 14px", borderRadius:20, border:"none", cursor:"pointer", fontSize:12, fontWeight:600,
                      background: active ? "#0f172a" : "#f1f5f9", color: active ? "#fff" : "#64748b" }}>
                    {labels[key]}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Parcelamento */}
          {form.recorrencia === "parcelada" && (
            <div style={{ gridColumn:"1/-1", background:"#f8fafc", border:"1px solid #e2e8f0", borderRadius:10, padding:"12px 14px" }}>
              <div style={{ fontSize:11, color:"#94a3b8", marginBottom:10, fontWeight:600, textTransform:"uppercase" }}>Configuração do Parcelamento</div>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
                <div>
                  <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Número de parcelas</div>
                  <input type="number" min="2" max="60" value={form.totalParcelas || ""} onChange={function(e) { set("totalParcelas", e.target.value); }} placeholder="Ex: 12"
                    style={{ width:"100%", background:"#fff", border:"1px solid #e2e8f0", color:"#0f172a", padding:"9px 12px", borderRadius:8, fontSize:13, outline:"none" }} />
                </div>
                <div>
                  <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Intervalo entre parcelas</div>
                  <select value={form.intervaloParcelas || "mensal"} onChange={function(e) { set("intervaloParcelas", e.target.value); }}
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
                  Serão geradas {form.totalParcelas} parcelas de R$ {(parseFloat(form.valor) / parseInt(form.totalParcelas)).toFixed(2).replace(".", ",")} cada
                </div>
              )}
            </div>
          )}

          {/* Info recorrência */}
          {form.recorrencia && form.recorrencia !== "unica" && form.recorrencia !== "parcelada" && form.vencimento && (
            <div style={{ gridColumn:"1/-1", background:"#f0fdf4", border:"1px solid #bbf7d0", borderRadius:8, padding:"8px 12px", fontSize:12, color:"#15803d" }}>
              Esta conta se repetirá automaticamente — a próxima será criada ao dar baixa nesta.
            </div>
          )}

          {/* Multa e Juros */}
          <div style={{ gridColumn:"1/-1", background:"#f8fafc", border:"1px solid #e2e8f0", borderRadius:10, padding:"14px" }}>
            <div style={{ fontSize:11, color:"#94a3b8", marginBottom:10, fontWeight:700, textTransform:"uppercase" }}>💰 Multa e Juros por Atraso</div>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr 1fr", gap:10 }}>
              <div>
                <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Tipo Multa</div>
                <select value={form.multaTipo || "%"} onChange={function(e){ set("multaTipo", e.target.value); }}
                  style={{ width:"100%", background:"#fff", border:"1px solid #e2e8f0", color:"#334155", padding:"8px 10px", borderRadius:8, fontSize:13 }}>
                  <option value="%">%</option>
                  <option value="R$">R$</option>
                </select>
              </div>
              <div>
                <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Multa ({form.multaTipo||"%"})</div>
                <input type="number" step="0.01" value={form.multaPct || ""} onChange={function(e){ set("multaPct", e.target.value); }} placeholder={form.multaTipo==="%"?"Ex: 2":"Ex: 10,00"}
                  style={{ width:"100%", background:"#fff", border:"1px solid #e2e8f0", color:"#0f172a", padding:"8px 10px", borderRadius:8, fontSize:13, outline:"none" }} />
              </div>
              <div>
                <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Tipo Juros</div>
                <select value={form.jurosTipo || "%"} onChange={function(e){ set("jurosTipo", e.target.value); }}
                  style={{ width:"100%", background:"#fff", border:"1px solid #e2e8f0", color:"#334155", padding:"8px 10px", borderRadius:8, fontSize:13 }}>
                  <option value="%">% ao dia</option>
                  <option value="R$">R$ ao dia</option>
                </select>
              </div>
              <div>
                <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Juros/dia ({form.jurosTipo||"%"})</div>
                <input type="number" step="0.001" value={form.jurosDia || ""} onChange={function(e){ set("jurosDia", e.target.value); }} placeholder={form.jurosTipo==="%"?"Ex: 0.033":"Ex: 1,50"}
                  style={{ width:"100%", background:"#fff", border:"1px solid #e2e8f0", color:"#0f172a", padding:"8px 10px", borderRadius:8, fontSize:13, outline:"none" }} />
              </div>
            </div>
          </div>

          {/* Protesto */}
          <div style={{ gridColumn:"1/-1", background:"#f8fafc", border:"1px solid #e2e8f0", borderRadius:10, padding:"14px" }}>
            <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom: form.temProtesto ? 10 : 0 }}>
              <label style={{ display:"flex", alignItems:"center", gap:8, cursor:"pointer" }}>
                <input type="checkbox" checked={!!form.temProtesto} onChange={function(e){ set("temProtesto", e.target.checked); }} />
                <span style={{ fontSize:13, fontWeight:700, color:"#7c3aed" }}>⚖️ Sujeito a Protesto</span>
              </label>
            </div>
            {form.temProtesto && (
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginTop:8 }}>
                <div>
                  <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Dias para Protesto (após venc.)</div>
                  <input type="number" min="1" value={form.diasProtesto || ""} onChange={function(e){ set("diasProtesto", e.target.value); }} placeholder="Ex: 5"
                    style={{ width:"100%", background:"#fff", border:"1px solid #e2e8f0", color:"#0f172a", padding:"8px 10px", borderRadius:8, fontSize:13, outline:"none" }} />
                </div>
                <div>
                  <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Cartório</div>
                  <input value={form.cartorio || ""} onChange={function(e){ set("cartorio", e.target.value); }} placeholder="Nome do cartório (opcional)"
                    style={{ width:"100%", background:"#fff", border:"1px solid #e2e8f0", color:"#0f172a", padding:"8px 10px", borderRadius:8, fontSize:13, outline:"none" }} />
                </div>
                {form.vencimento && form.diasProtesto && (
                  <div style={{ gridColumn:"1/-1", background:"#fef2f2", borderRadius:8, padding:"8px 12px", fontSize:12, color:"#dc2626" }}>
                    ⚠️ Protesto previsto para: {(function(){
                      var d = new Date(form.vencimento + "T00:00:00");
                      d.setDate(d.getDate() + parseInt(form.diasProtesto||0));
                      return d.toLocaleDateString("pt-BR");
                    })()}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Prioridade */}
          <div style={{ gridColumn:"1/-1" }}>
            <div style={{ fontSize:11, color:"#94a3b8", marginBottom:8, fontWeight:600, textTransform:"uppercase" }}>Prioridade</div>
            <div style={{ display:"flex", gap:8 }}>
              {[
                { key:"baixa",  label:"! Baixa",  cor:"#15803d", bg:"#f0fdf4", border:"#bbf7d0" },
                { key:"media",  label:"!! Média",  cor:"#d97706", bg:"#fffbeb", border:"#fde68a" },
                { key:"alta",   label:"!!! Alta",  cor:"#dc2626", bg:"#fef2f2", border:"#fecaca" },
              ].map(function(p) {
                var active = (form.prioridade || "media") === p.key;
                return (
                  <button key={p.key} onClick={function() { set("prioridade", p.key); }}
                    style={{ flex:1, padding:"10px 8px", borderRadius:10,
                      border: active ? "2px solid " + p.cor : "2px solid " + p.border,
                      background: active ? p.bg : "#fff",
                      color: active ? p.cor : "#94a3b8",
                      fontWeight: active ? 800 : 500, fontSize:13, cursor:"pointer",
                      boxShadow: active ? "0 0 0 3px " + p.cor + "22" : "none" }}>
                    {p.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Observação */}
          <div style={{ gridColumn:"1/-1" }}>
            <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Observação</div>
            <input value={form.observacao} onChange={function(e) { set("observacao", e.target.value); }} placeholder="Opcional"
              style={{ width:"100%", background:"#f8fafc", border:"1px solid #e2e8f0", color:"#0f172a", padding:"9px 12px", borderRadius:8, fontSize:13, outline:"none" }} />
          </div>

          {/* Anexos */}
          <div style={{ gridColumn:"1/-1" }}>
            <div style={{ fontSize:11, color:"#94a3b8", marginBottom:8, fontWeight:600, textTransform:"uppercase" }}>Anexos</div>
            <AnexosUpload
              anexos={form.anexos || []}
              onChange={function(novos) { set("anexos", novos); }}
            />
          </div>

        </div>

        <div style={{ display:"flex", gap:8 }}>
          <button onClick={onClose} style={{ flex:1, background:"#f8fafc", border:"1px solid #e2e8f0", color:"#64748b", fontWeight:600, padding:"11px", borderRadius:10, cursor:"pointer" }}>Cancelar</button>
          <button onClick={function() { if (canSave) { onSave(form); onClose(); } }} disabled={!canSave} style={btnStyle}>
            Salvar
          </button>
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
  const [receberSel, setReceberSel] = useState([]);
  const [receberVista, setReceberVista] = useState("areceber"); // areceber | recebido | todos
  const [pagarDe, setPagarDe] = useState("");
  const [pagarAte, setPagarAte] = useState("");
  const [filterStatus, setFilterStatus] = useState("all");
  const [filterCat, setFilterCat] = useState("all");
  const [filterPrioridade, setFilterPrioridade] = useState("all-pr");
  const [searchPagar, setSearchPagar] = useState("");
  const [novaCat, setNovaCat] = useState("");
  const [fluxoDe, setFluxoDe] = useState("");
  const [fluxoAte, setFluxoAte] = useState("");
  const [extratoContaId, setExtratoContaId] = useState(null);
  const [extratoDe, setExtratoDe] = useState("");
  const [extratoAte, setExtratoAte] = useState("");
  const [extratoSel, setExtratoSel] = useState([]);
  const [selecionadas, setSelecionadas] = useState([]);
  const [showModalMultiBaixa, setShowModalMultiBaixa] = useState(false);

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
    if (filterPrioridade !== "all-pr") r = r.filter(c => (c.prioridade||"media") === filterPrioridade);
    if (searchPagar) r = r.filter(c => c.descricao.toLowerCase().includes(searchPagar.toLowerCase()));
    if (pagarDe) r = r.filter(c => c.vencimento && c.vencimento >= pagarDe);
    if (pagarAte) r = r.filter(c => c.vencimento && c.vencimento <= pagarAte);
    // Ordenar: alta > media > baixa > sem prioridade, depois por vencimento
    const ordPr = { alta:0, media:1, baixa:2 };
    return r.sort((a,b) => {
      var pa = ordPr[a.prioridade||"media"] ?? 1;
      var pb = ordPr[b.prioridade||"media"] ?? 1;
      if (pa !== pb) return pa - pb;
      return (a.vencimento||"9999") > (b.vencimento||"9999") ? 1 : -1;
    });
  }, [contasPagar, filterStatus, filterCat, filterPrioridade, searchPagar, pagarDe, pagarAte]);

  // ── Totais ───────────────────────────────────────────────
  const totalPagar   = contasPagar.filter(c=>c.status!=="Pago").reduce((s,c)=>s+parseFloat(c.valor||0),0);
  const totalPago    = contasPagar.filter(c=>c.status==="Pago").reduce((s,c)=>s+parseFloat(c.valor||0),0);
  const totalVencido = contasPagar.filter(c=>c.status==="Vencido").reduce((s,c)=>s+parseFloat(c.valor||0),0);
  const vencendo7    = contasPagar.filter(c=>c.status==="Pendente"&&c.vencimento&&getDaysUntil(c.vencimento)>=0&&getDaysUntil(c.vencimento)<=7);

  const hoje = new Date().toLocaleDateString("sv-SE");
  const mesAtual = hoje.slice(0,7);
  const allOrders = rawOrders || [];

  // Usar enrichedOrders — já tem fee e freteSeller calculados (mesmos da aba Pedidos)
  const aReceber = (enrichedOrders||[]).filter(function(o) {
    const jaRegistrado = lancamentos.some(function(l) { return l.tipo === "recebimento" && (l.pedidoId === o.id || String(l.pedidoId) === String(o.id)); });
    if (jaRegistrado) return false;
    // Incluir pagos, em envio, entregues — qualquer pedido não registrado ainda
    const ss = shipmentStatuses?.[o.id] ?? o.shipment_status;
    const statusValido = o.status === "paid" || ["shipped","in_transit","delivered","ready_to_ship"].includes(ss);
    return statusValido;
  });

  // Entregues já registrados (desde 01/04 — início do período carregado)
  const recebidoMes = (enrichedOrders||[]).filter(function(o) {
    const ss = shipmentStatuses?.[o.id] ?? o.shipment_status;
    const isDelivered = ss === "delivered" || o.tags?.some(function(t){return t==="delivered";});
    const jaRegistrado = lancamentos.some(function(l) { return l.tipo === "recebimento" && (l.pedidoId === o.id || String(l.pedidoId) === String(o.id)); });
    return isDelivered && jaRegistrado;
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

  function confirmarMultiBaixa(ids, { contaBancariaId, dataPagamento, obs }) {
    var updated = contasPagar.map(function(c) {
      if (!ids.includes(c.id)) return c;
      return Object.assign({}, c, { status:"Pago", dataPagamento, contaBancariaId });
    });
    setContasPagar(updated); saveLS("contas_pagar", updated);
    var novosLanc = ids.map(function(id) {
      var c = contasPagar.find(function(x){return x.id===id;});
      return { id: Date.now()+Math.random(), tipo:"pagamento", descricao: c?c.descricao:"Conta", valor: parseFloat(c?c.valor:0), data:dataPagamento, contaBancariaId, contaPagarId:id };
    });
    setLancamentos(function(prev) { var u=[...prev,...novosLanc]; saveLS("lancamentos",u); return u; });
    setSelecionadas([]);
  }

  function confirmarBaixa(conta, { contaBancariaId, dataPagamento, obs, valorPago, parcial }) {
    var novoStatus = parcial ? "Pago Parcial" : "Pago";
    var valorFinal = valorPago || parseFloat(conta.valor || 0);
    let updatedContas = contasPagar.map(c => c.id===conta.id ? {...c, status: novoStatus, contaBancariaId, dataPagamento, valorPago: valorFinal} : c);

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

        // Futuros: recebimentos ML previstos (+14 dias ou releaseDate da API)
        aReceber.forEach(function(o) {
          var pd = paymentData?.[o.id];
          // Data de previsão: API ou +14 dias da data do pedido
          var previsaoDate = pd?.releaseDate || null;
          if (!previsaoDate && o.date) {
            var dp = new Date(o.date + "T00:00:00");
            dp.setDate(dp.getDate() + 14);
            previsaoDate = dp.toLocaleDateString("sv-SE");
          }
          if (!previsaoDate) return;
          // Valor líquido: bruto - tarifa - frete (mesma fórmula da tabela)
          var brutoFluxo = o.price * o.qty;
          var tarifaFluxo = (o.fee || 0) * (o.qty || 1);
          var freteFluxo = o.freteSeller || 0;
          var netFluxo = brutoFluxo - tarifaFluxo - freteFluxo;
          if (netFluxo <= 0) netFluxo = brutoFluxo * 0.87;
          if (!dias[previsaoDate]) dias[previsaoDate] = { entradas:[], saidas:[] };
          // Não adicionar se já tem lançamento registrado para esse pedido
          var jaLancado = lancamentos.some(function(l){ return l.tipo==="recebimento" && (l.pedidoId===o.id||String(l.pedidoId)===String(o.id)); });
          if (!jaLancado) {
            dias[previsaoDate].entradas.push({
              desc: "[PREVISTO] " + (o.title ? o.title.slice(0,35) : "Pedido #" + o.id),
              valor: netFluxo,
              tipo: "ML Previsto",
              id: "prev_" + o.id,
              previsto: true,
            });
          }
        });

        // Filtro por período
        const fluxoSortedAll = Object.keys(dias).sort().reverse();
        const fluxoFiltrado = fluxoSortedAll.filter(function(d) {
          if (fluxoDe && d < fluxoDe) return false;
          if (fluxoAte && d > fluxoAte) return false;
          return true;
        });
        const sortedDias = fluxoFiltrado.slice(0, 90);

        // Saldo acumulado
        let saldoAcumulado = contasBancarias.reduce((s, c) => s + parseFloat(c.saldoInicial || 0), 0);
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
            {/* Filtro de período */}
            <div style={{ background:"#f8fafc", border:"1px solid #e2e8f0", borderRadius:10, padding:"10px 14px", marginBottom:14 }}>
              <div style={{ display:"flex", gap:8, alignItems:"center", flexWrap:"wrap", marginBottom:8 }}>
                <span style={{ fontSize:12, color:"#64748b", fontWeight:600 }}>📅 Período:</span>
                <BotoesPeriodo de={fluxoDe} ate={fluxoAte} onChangeDe={setFluxoDe} onChangeAte={setFluxoAte} />
                <span style={{ fontSize:12, color:"#94a3b8", marginLeft:"auto" }}>{sortedDias.length} dia(s)</span>
              </div>
              <div style={{ display:"flex", gap:8, alignItems:"center", flexWrap:"wrap" }}>
                <input type="date" value={fluxoDe} onChange={function(e) { setFluxoDe(e.target.value); }}
                  style={{ background:"#fff", border:"1px solid #e2e8f0", color:"#334155", padding:"5px 10px", borderRadius:8, fontSize:12 }} />
                <span style={{ fontSize:12, color:"#94a3b8" }}>até</span>
                <input type="date" value={fluxoAte} onChange={function(e) { setFluxoAte(e.target.value); }}
                  style={{ background:"#fff", border:"1px solid #e2e8f0", color:"#334155", padding:"5px 10px", borderRadius:8, fontSize:12 }} />
                {(fluxoDe || fluxoAte) && (
                  <button onClick={function() { setFluxoDe(""); setFluxoAte(""); }}
                    style={{ background:"#f1f5f9", border:"1px solid #e2e8f0", color:"#64748b", padding:"5px 10px", borderRadius:8, cursor:"pointer", fontSize:12 }}>✕ Limpar</button>
                )}
              </div>
            </div>
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
          <PainelIAPagamentos contasPagar={contasPagar} contasBancarias={contasBancarias} lancamentos={lancamentos} enrichedOrders={enrichedOrders} paymentData={paymentData} shipmentStatuses={shipmentStatuses} />
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
          {/* Filtro de prioridade */}
          <div style={{ display:"flex", gap:6, alignItems:"center", marginBottom:10, flexWrap:"wrap" }}>
            <span style={{ fontSize:12, color:"#64748b", fontWeight:600 }}>Prioridade:</span>
            {[
              { key:"all-pr", label:"Todas",      cor:"#64748b", bg:"#f8fafc", activeBg:"#334155" },
              { key:"alta",   label:"!!! Alta",   cor:"#dc2626", bg:"#fef2f2", activeBg:"#dc2626" },
              { key:"media",  label:"!! Média",   cor:"#d97706", bg:"#fffbeb", activeBg:"#d97706" },
              { key:"baixa",  label:"! Baixa",    cor:"#15803d", bg:"#f0fdf4", activeBg:"#15803d" },
            ].map(function(p) {
              var isActive = filterPrioridade === p.key;
              return (
                <button key={p.key} onClick={function(){ setFilterPrioridade(p.key); }}
                  style={{ padding:"5px 14px", borderRadius:20,
                    border: isActive ? "2px solid " + p.activeBg : "1px solid #e2e8f0",
                    background: isActive ? p.activeBg : p.bg,
                    color: isActive ? "#fff" : p.cor,
                    fontWeight: isActive ? 700 : 500, fontSize:12, cursor:"pointer" }}>
                  {p.label}
                  {p.key !== "all-pr" && (
                    <span style={{ marginLeft:5, fontSize:10, opacity:0.8 }}>
                      ({contasPagar.filter(function(c){ return (c.prioridade||"media")===p.key && c.status!=="Pago"; }).length})
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          <div style={{ background:"#f8fafc", border:"1px solid #e2e8f0", borderRadius:10, padding:"10px 14px", marginBottom:14 }}>
            <div style={{ display:"flex", gap:8, alignItems:"center", flexWrap:"wrap", marginBottom:8 }}>
              <span style={{ fontSize:12, color:"#64748b", fontWeight:600 }}>📅 Vencimento:</span>
              <BotoesPeriodo de={pagarDe} ate={pagarAte} onChangeDe={setPagarDe} onChangeAte={setPagarAte} />
              <span style={{ fontSize:12, color:"#94a3b8", marginLeft:"auto" }}>{contasFiltradas.length} conta(s)</span>
            </div>
            <div style={{ display:"flex", gap:8, alignItems:"center", flexWrap:"wrap" }}>
              <input type="date" value={pagarDe} onChange={function(e){ setPagarDe(e.target.value); }}
                style={{ background:"#fff", border:"1px solid #e2e8f0", color:"#334155", padding:"5px 10px", borderRadius:8, fontSize:12 }} />
              <span style={{ fontSize:12, color:"#94a3b8" }}>até</span>
              <input type="date" value={pagarAte} onChange={function(e){ setPagarAte(e.target.value); }}
                style={{ background:"#fff", border:"1px solid #e2e8f0", color:"#334155", padding:"5px 10px", borderRadius:8, fontSize:12 }} />
              {(pagarDe||pagarAte) && (
                <button onClick={function(){ setPagarDe(""); setPagarAte(""); }}
                  style={{ background:"#f1f5f9", border:"1px solid #e2e8f0", color:"#64748b", padding:"5px 10px", borderRadius:8, cursor:"pointer", fontSize:12 }}>✕ Limpar</button>
              )}
            </div>
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
          {selecionadas.length > 0 && (
            <div style={{ background:"#0f172a", borderRadius:12, padding:"12px 16px", marginBottom:10 }}>
              <div style={{ display:"flex", alignItems:"center", gap:10, flexWrap:"wrap" }}>
                <span style={{ color:"#fff", fontWeight:700, fontSize:13 }}>{selecionadas.length} conta(s) selecionada(s)</span>
                <span style={{ color:"#94a3b8", fontSize:12 }}>
                  Total: {fmt(contasFiltradas.filter(function(c) { return selecionadas.includes(c.id); }).reduce(function(s,c) { return s + parseFloat(c.valor||0); }, 0))}
                </span>
                <div style={{ marginLeft:"auto", display:"flex", gap:8, flexWrap:"wrap", alignItems:"center" }}>
                  {/* Alterar prioridade em massa */}
                  <span style={{ color:"#94a3b8", fontSize:12 }}>Prioridade:</span>
                  {[
                    { key:"baixa", label:"! Baixa",  cor:"#15803d", bg:"#f0fdf4" },
                    { key:"media", label:"!! Média",  cor:"#d97706", bg:"#fffbeb" },
                    { key:"alta",  label:"!!! Alta",  cor:"#dc2626", bg:"#fef2f2" },
                  ].map(function(p) {
                    return (
                      <button key={p.key}
                        onClick={function() {
                          var updated = contasPagar.map(function(c) {
                            return selecionadas.includes(c.id) ? Object.assign({}, c, { prioridade: p.key }) : c;
                          });
                          setContasPagar(updated);
                          saveLS("contas_pagar", updated);
                        }}
                        style={{ background:p.bg, border:"none", color:p.cor, fontWeight:700, padding:"6px 12px", borderRadius:8, cursor:"pointer", fontSize:12 }}>
                        {p.label}
                      </button>
                    );
                  })}
                  <div style={{ width:1, height:24, background:"#334155", margin:"0 4px" }} />
                  <button onClick={function() { setShowModalMultiBaixa(true); }}
                    style={{ background:"#15803d", border:"none", color:"#fff", fontWeight:700, padding:"7px 16px", borderRadius:8, cursor:"pointer", fontSize:12 }}>
                    💸 Baixa em Lote
                  </button>
                  <button onClick={function() {
                    if (!window.confirm("Excluir " + selecionadas.length + " conta(s)?")) return;
                    var updated = contasPagar.filter(function(c) { return !selecionadas.includes(c.id); });
                    setContasPagar(updated); saveLS("contas_pagar", updated); setSelecionadas([]);
                  }} style={{ background:"#7f1d1d", border:"none", color:"#fca5a5", fontWeight:700, padding:"7px 12px", borderRadius:8, cursor:"pointer", fontSize:12 }}>
                    🗑 Excluir
                  </button>
                  <button onClick={function() { setSelecionadas([]); }}
                    style={{ background:"#334155", border:"none", color:"#94a3b8", padding:"7px 12px", borderRadius:8, cursor:"pointer", fontSize:12 }}>
                    ✕ Cancelar
                  </button>
                </div>
              </div>
            </div>
          )}
          <div style={{ background:"#fff", border:"1px solid #e2e8f0", borderRadius:12, overflow:"auto" }}>
            <table style={{ borderCollapse:"collapse", width:"100%" }}>
              <thead>
                <tr>
                  <th style={{ fontSize:11, color:"#94a3b8", padding:"10px 14px", borderBottom:"1px solid #f1f5f9", background:"#fafafa", width:36 }}>
                    <input type="checkbox"
                      checked={contasFiltradas.filter(function(c){return c.status!=="Pago";}).length > 0 && contasFiltradas.filter(function(c){return c.status!=="Pago";}).every(function(c){return selecionadas.includes(c.id);})}
                      onChange={function(e) {
                        var pendentes = contasFiltradas.filter(function(c){return c.status!=="Pago";}).map(function(c){return c.id;});
                        setSelecionadas(e.target.checked ? pendentes : []);
                      }}
                      style={{ cursor:"pointer" }}
                    />
                  </th>
                  {["Prioridade","Descrição","Categoria","Valor","Vencimento","Status","Conta paga","Anexos","Ações"].map(function(h) {
                    return <th key={h} style={{ fontSize:11, color:"#94a3b8", textTransform:"uppercase", letterSpacing:0.8, padding:"10px 14px", borderBottom:"1px solid #f1f5f9", textAlign:"left", fontWeight:600, background:"#fafafa", whiteSpace:"nowrap" }}>{h}</th>;
                  })}
                </tr>
              </thead>
              <tbody>
                {contasFiltradas.length===0 ? (
                  <tr><td colSpan={7} style={{ textAlign:"center", color:"#94a3b8", padding:40 }}>Nenhuma conta encontrada</td></tr>
                ) : contasFiltradas.map((c,i) => {
                  const days = getDaysUntil(c.vencimento);
                  const isVencendo = c.status==="Pendente"&&days!==null&&days>=0&&days<=7;
                  const contaBanc = contasBancarias.find(cb=>cb.id===c.contaBancariaId);
                  var isSel = selecionadas.includes(c.id);
                  return (
                    <tr key={c.id} style={{ background: isSel ? "#eff6ff" : i%2===0?"#f8fafc":"#fff" }}>
                      <td style={{ padding:"10px 14px", textAlign:"center" }}>
                        {c.status !== "Pago" && (
                          <input type="checkbox" checked={isSel}
                            onChange={function(e) {
                              setSelecionadas(e.target.checked ? [...selecionadas, c.id] : selecionadas.filter(function(id){return id!==c.id;}));
                            }}
                            style={{ cursor:"pointer" }}
                          />
                        )}
                      </td>
                      <td style={{ padding:"10px 6px", textAlign:"center", width:70 }}>
                        {(function() {
                          var pr = c.prioridade || "media";
                          var cfg = pr === "alta"
                            ? { label:"!!!", title:"Alta Prioridade", cor:"#dc2626", bg:"#fef2f2", border:"#fecaca" }
                            : pr === "baixa"
                            ? { label:"!", title:"Baixa Prioridade", cor:"#15803d", bg:"#f0fdf4", border:"#bbf7d0" }
                            : { label:"!!", title:"Média Prioridade", cor:"#d97706", bg:"#fffbeb", border:"#fde68a" };
                          return (
                            <span title={cfg.title} style={{ fontSize:13, fontWeight:800, color:cfg.cor, background:cfg.bg, border:"1px solid " + cfg.border, padding:"3px 8px", borderRadius:6, display:"inline-block", cursor:"default", letterSpacing:1 }}>
                              {cfg.label}
                            </span>
                          );
                        })()}
                      </td>
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
                      <td style={{ padding:"10px 14px" }}>
                        {(function() {
                          var valor = parseFloat(c.valor || 0);
                          var hoje2 = new Date(); hoje2.setHours(0,0,0,0);
                          var dueDate2 = c.vencimento ? new Date(c.vencimento + "T00:00:00") : null;
                          var diasAtr = dueDate2 ? Math.max(0, Math.round((hoje2 - dueDate2) / 86400000)) : 0;
                          var multaR = c.multaTipo === "R$" ? parseFloat(c.multaPct||0) : valor * (parseFloat(c.multaPct||0)/100);
                          var jurosR = c.jurosTipo === "R$" ? parseFloat(c.jurosDia||0) : valor * (parseFloat(c.jurosDia||0)/100);
                          var totalHoje = valor + (diasAtr > 0 ? multaR + jurosR * diasAtr : 0);
                          var temEncargos = diasAtr > 0 && (multaR > 0 || jurosR > 0);
                          return (
                            <div>
                              <div style={{ fontSize:13, fontWeight:700, color: temEncargos ? "#94a3b8" : "#0f172a", textDecoration: temEncargos ? "line-through" : "none" }}>
                                {fmt(valor)}
                              </div>
                              {temEncargos && (
                                <div style={{ fontSize:12, fontWeight:800, color:"#dc2626" }}>
                                  {fmt(totalHoje)}
                                  <div style={{ fontSize:10, fontWeight:500, color:"#dc2626", opacity:0.8 }}>hoje +{diasAtr}d</div>
                                </div>
                              )}
                            </div>
                          );
                        })()}
                      </td>
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
      {finTab === "receber" && (function() {
        // Calcula taxas ML estimadas quando não tem netAmount da API
        function calcNetEstimado(o) {
          var bruto = o.price * o.qty;
          // Taxa padrão ML: ~12% para normal, ~16% premium + frete grátis
          // Usa uma estimativa conservadora de 13% se não tiver dado real
          return bruto * 0.87;
        }

        // Agrupamento por previsão de recebimento
        var proximosLiberados = aReceber.filter(function(o) {
          var pd = paymentData?.[o.id];
          if (!pd?.releaseDate) return false;
          var d = getDaysUntil(pd.releaseDate);
          return d !== null && d >= 0 && d <= 7;
        });
        var semPrevisao = aReceber.filter(function(o) { return !paymentData?.[o.id]?.releaseDate; });
        var totalComDados = aReceber.filter(function(o) { return paymentData?.[o.id]?.netAmount; }).length;

        // Totais reais com fallback estimado
        var totalBruto = aReceber.reduce(function(s,o){ return s + o.price * o.qty; }, 0);
        var totalTarifas = aReceber.reduce(function(s,o){ return s + (o.fee||0)*(o.qty||1); }, 0);
        var totalFrete = aReceber.reduce(function(s,o){ return s + (o.freteSeller||0); }, 0);
        var totalLiq = aReceber.reduce(function(s,o){
          var brutoO = o.price * o.qty;
          var tarifaO = (o.fee||0)*(o.qty||1);
          var freteO = o.freteSeller||0;
          var net = brutoO - tarifaO - freteO;
          return s + (net > 0 ? net : brutoO * 0.87);
        }, 0);
        var taxaMedia = totalBruto > 0 ? ((totalBruto - totalLiq) / totalBruto * 100) : 0;

        // Previsão por período
        var prevProx7 = aReceber.reduce(function(s,o) {
          var pd = paymentData?.[o.id]; if (!pd?.releaseDate) return s;
          var d = getDaysUntil(pd.releaseDate);
          return (d !== null && d >= 0 && d <= 7) ? s + (pd.netAmount || calcNetEstimado(o)) : s;
        }, 0);
        var prevProx30 = aReceber.reduce(function(s,o) {
          var pd = paymentData?.[o.id]; if (!pd?.releaseDate) return s;
          var d = getDaysUntil(pd.releaseDate);
          return (d !== null && d >= 0 && d <= 30) ? s + (pd.netAmount || calcNetEstimado(o)) : s;
        }, 0);

        return (
        <div>
          {/* Cards de resumo */}
          <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(160px,1fr))", gap:10, marginBottom:16 }}>
            {[
              { label:"A Receber (líq.)", value:fmt(totalLiq), color:"#0891b2", bg:"#ecfeff",
                desc: aReceber.length + " pedido(s)" },
              { label:"Bruto Total", value:fmt(totalBruto), color:"#64748b", bg:"#f8fafc", desc:"Antes das taxas" },
              { label:"Tarifas ML", value:fmt(totalTarifas), color:"#d97706", bg:"#fffbeb", desc:"Comissão ML" },
              { label:"Frete (custo)", value:fmt(totalFrete), color:"#7c3aed", bg:"#f5f3ff", desc:"Seu custo de envio" },
              { label:"Já Registrado", value:fmt(totalRecebidoMesLiq), color:"#15803d", bg:"#f0fdf4", desc: recebidoMes.length + " entregue(s)" },
            ].map(function(k) {
              return (
                <div key={k.label} style={{ background:k.bg, borderRadius:10, padding:"14px 18px" }}>
                  <div style={{ fontSize:10, color:k.color, fontWeight:700, textTransform:"uppercase", marginBottom:4 }}>{k.label}</div>
                  <div style={{ fontSize:18, fontWeight:800, color:k.color }}>{k.value}</div>
                  <div style={{ fontSize:11, color:k.color, opacity:0.7, marginTop:2 }}>{k.desc}</div>
                </div>
              );
            })}
          </div>

          {/* Aviso sobre dados estimados */}
          {semPrevisao.length > 0 && (
            <div style={{ background:"#fffbeb", border:"1px solid #fde68a", borderRadius:10, padding:"10px 14px", marginBottom:14, fontSize:12, color:"#92400e", display:"flex", alignItems:"center", gap:8 }}>
              <span style={{ fontSize:16 }}>ℹ️</span>
              <div>
                <strong>{semPrevisao.length} pedido(s)</strong> ainda sem dados de pagamento da API do ML — o valor líquido é estimado com ~13% de taxa.
                {totalComDados > 0 && <span style={{ marginLeft:6, color:"#15803d" }}>✓ {totalComDados} pedidos com dados reais</span>}
              </div>
            </div>
          )}

          {/* Alertas de liberação próxima */}
          {proximosLiberados.length > 0 && (
            <div style={{ background:"#f0fdf4", border:"1px solid #bbf7d0", borderRadius:10, padding:"10px 14px", marginBottom:14, display:"flex", alignItems:"center", gap:10 }}>
              <span style={{ fontSize:18 }}>💰</span>
              <div>
                <div style={{ fontWeight:700, color:"#15803d", fontSize:13 }}>{proximosLiberados.length} pagamento(s) liberando nos próximos 7 dias</div>
                <div style={{ fontSize:12, color:"#166534" }}>Total: {fmt(prevProx7)} líquido a cair no Mercado Pago</div>
              </div>
            </div>
          )}

          {/* Filtros */}
          <div style={{ display:"flex", gap:10, alignItems:"center", marginBottom:10, flexWrap:"wrap" }}>
            <div style={{ fontWeight:700, fontSize:14, color:"#0f172a", whiteSpace:"nowrap" }}>
              {receberVista === "recebido" ? "✅ Pedidos Registrados" : receberVista === "todos" ? "📋 Todos os Pedidos" : "📥 Pedidos a Receber"}
            </div>
            <div style={{ position:"relative", flex:1, minWidth:240 }}>
              <span style={{ position:"absolute", left:10, top:"50%", transform:"translateY(-50%)", color:"#94a3b8", fontSize:13 }}>🔍</span>
              <input value={searchReceber} onChange={function(e){ setSearchReceber(e.target.value); }}
                placeholder="Buscar por nº pedido, cliente ou produto..."
                style={{ width:"100%", background:"#fff", border:"1px solid #e2e8f0", color:"#0f172a", padding:"8px 12px 8px 32px", borderRadius:8, fontSize:13, outline:"none" }} />
            </div>
            {searchReceber && (
              <button onClick={function(){ setSearchReceber(""); }}
                style={{ background:"#f1f5f9", border:"1px solid #e2e8f0", color:"#64748b", padding:"7px 12px", borderRadius:8, cursor:"pointer", fontSize:12 }}>✕ Limpar</button>
            )}
          </div>
          <div style={{ background:"#f8fafc", border:"1px solid #e2e8f0", borderRadius:10, padding:"10px 14px", marginBottom:14 }}>
            <div style={{ display:"flex", gap:8, alignItems:"center", flexWrap:"wrap", marginBottom:8 }}>
              <span style={{ fontSize:12, color:"#64748b", fontWeight:600 }}>📅 Data da venda:</span>
              <BotoesPeriodo de={receberDe} ate={receberAte} onChangeDe={setReceberDe} onChangeAte={setReceberAte} />
            </div>
            <div style={{ display:"flex", gap:8, alignItems:"center", flexWrap:"wrap" }}>
              <input type="date" value={receberDe} onChange={function(e){ setReceberDe(e.target.value); }}
                style={{ background:"#fff", border:"1px solid #e2e8f0", color:"#334155", padding:"5px 10px", borderRadius:8, fontSize:12 }} />
              <span style={{ fontSize:12, color:"#94a3b8" }}>até</span>
              <input type="date" value={receberAte} onChange={function(e){ setReceberAte(e.target.value); }}
                style={{ background:"#fff", border:"1px solid #e2e8f0", color:"#334155", padding:"5px 10px", borderRadius:8, fontSize:12 }} />
              {(receberDe||receberAte) && (
                <button onClick={function(){ setReceberDe(""); setReceberAte(""); }}
                  style={{ background:"#f1f5f9", border:"1px solid #e2e8f0", color:"#64748b", padding:"5px 10px", borderRadius:8, cursor:"pointer", fontSize:12 }}>✕ Limpar</button>
              )}
            </div>
          </div>

          {/* Tabela */}
          {/* Filtro de visão */}
          <div style={{ display:"flex", gap:4, marginBottom:14, background:"#f1f5f9", padding:4, borderRadius:10, width:"fit-content" }}>
            {[
              { key:"areceber", label:"📥 A Receber",  count: aReceber.length },
              { key:"recebido", label:"✅ Registrados", count: recebidoMes.length },
              { key:"todos",    label:"📋 Todos",       count: aReceber.length + recebidoMes.length },
            ].map(function(v) {
              var active = receberVista === v.key;
              return (
                <button key={v.key} onClick={function(){ setReceberVista(v.key); setReceberSel([]); }}
                  style={{ background: active?"#fff":"transparent", border:"none", color: active?"#0f172a":"#94a3b8",
                    padding:"8px 16px", cursor:"pointer", fontFamily:"inherit", fontSize:13,
                    borderRadius:8, fontWeight: active?700:500,
                    boxShadow: active?"0 1px 3px rgba(0,0,0,.08)":"none", whiteSpace:"nowrap" }}>
                  {v.label} <span style={{ fontSize:11, opacity:0.7 }}>({v.count})</span>
                </button>
              );
            })}
          </div>

          {receberSel.length > 0 && (
            <div style={{ display:"flex", gap:8, alignItems:"center", background:"#0f172a", borderRadius:10, padding:"10px 16px", marginBottom:10, flexWrap:"wrap" }}>
              <span style={{ color:"#fff", fontWeight:700, fontSize:13 }}>{receberSel.length} pedido(s) selecionado(s)</span>
              <button onClick={function(){
                if (!window.confirm("Excluir lançamentos dos " + receberSel.length + " pedido(s) selecionados?")) return;
                var upd = lancamentos.filter(function(l){ return !receberSel.some(function(id){ return String(l.pedidoId)===String(id); }); });
                setLancamentos(upd); saveLS("lancamentos", upd); setReceberSel([]);
              }} style={{ background:"#dc2626", border:"none", color:"#fff", fontWeight:700, padding:"6px 14px", borderRadius:8, cursor:"pointer", fontSize:12 }}>
                🗑 Excluir Lançamentos
              </button>
              <button onClick={function(){ setReceberSel([]); }}
                style={{ background:"#334155", border:"none", color:"#94a3b8", padding:"6px 12px", borderRadius:8, cursor:"pointer", fontSize:12 }}>✕ Cancelar</button>
            </div>
          )}
          <div style={{ background:"#fff", border:"1px solid #e2e8f0", borderRadius:12, overflow:"auto", marginBottom:20 }}>
            <table style={{ borderCollapse:"collapse", width:"100%" }}>
              <thead>
                <tr>
                  <th style={{ padding:"10px 14px", background:"#fafafa", borderBottom:"1px solid #f1f5f9", width:36 }}>
                    <input type="checkbox"
                      checked={receberSel.length > 0 && aReceber.length > 0 && aReceber.every(function(o){ return receberSel.includes(o.id); })}
                      onChange={function(e){ setReceberSel(e.target.checked ? aReceber.map(function(o){return o.id;}) : []); }}
                      style={{ cursor:"pointer" }} />
                  </th>
                  {["Pedido","Cliente","Produto","Data Venda","Bruto","Tarifa ML","Frete (custo)","Líquido (MP)","Previsão Pagamento","Status","Ação"].map(function(h) {
                    return <th key={h} style={{ fontSize:11, color:"#94a3b8", textTransform:"uppercase", letterSpacing:0.8, padding:"10px 14px", borderBottom:"1px solid #f1f5f9", textAlign:"left", fontWeight:600, background:"#fafafa", whiteSpace:"nowrap" }}>{h}</th>;
                  })}
                </tr>
              </thead>
              <tbody>
                {(function() {
                  var q = searchReceber.toLowerCase().trim();

                  // Pool baseado no filtro de visão selecionado
                  var poolBase;
                  if (receberVista === "recebido") {
                    poolBase = recebidoMes;
                  } else if (receberVista === "todos") {
                    // Todos: a receber + já registrados (sem duplicatas)
                    var idsAReceber = new Set(aReceber.map(function(o){ return o.id; }));
                    var todosCombinados = [...aReceber];
                    recebidoMes.forEach(function(o){ if (!idsAReceber.has(o.id)) todosCombinados.push(o); });
                    poolBase = todosCombinados;
                  } else {
                    poolBase = aReceber; // padrão: a receber
                  }

                  var filtered = poolBase.filter(function(o) {
                    if (q && !(String(o.id).includes(q) || (o.title||"").toLowerCase().includes(q) || (o.buyerName||"").toLowerCase().includes(q))) return false;
                    if (receberDe && o.date && o.date < receberDe) return false;
                    if (receberAte && o.date && o.date > receberAte) return false;
                    return true;
                  });
                  if (filtered.length === 0) return (
                    <tr>
                      <td colSpan={10} style={{ textAlign:"center", color:"#94a3b8", padding:32 }}>
                        {q ? "Nenhum pedido encontrado — verifique se já foi registrado" : "Nenhum pedido a receber"}
                      </td>
                    </tr>
                  );
                  return filtered.slice(0, 100).map(function(o, i) {
                    var ss = shipmentStatuses?.[o.id] ?? o.shipment_status;
                    var isDelivered2 = ss === "delivered" || o.tags?.some(function(t){return t==="delivered";});
                    var isEnviado = ["shipped","in_transit"].includes(ss);
                    var label = isDelivered2 ? "Entregue" : isEnviado ? "Enviado" : "Ag. Envio";
                    var color = isDelivered2 ? "#7c3aed" : isEnviado ? "#0891b2" : "#d97706";
                    var bg = isDelivered2 ? "#f5f3ff" : isEnviado ? "#ecfeff" : "#fffbeb";
                    var pd = paymentData?.[o.id];
                    var bruto = o.price * o.qty;
                    // Valores já calculados no enrichedOrders (mesmos da aba Pedidos)
                    var tarifaExib = (o.fee || 0) * (o.qty || 1);
                    var freteExib = o.freteSeller || 0;
                    // Líquido = Bruto - Tarifa ML - Frete (custo)
                    var netFinal = bruto - tarifaExib - freteExib;
                    if (netFinal <= 0) netFinal = bruto * 0.87; // fallback seguro
                    var netEstimado = tarifaExib === 0 && freteExib === 0;
                    var taxa = bruto > 0 ? ((bruto - netFinal) / bruto * 100) : 0;
                    // Previsão: data real da API ou +14 dias da data do pedido
                    var releaseDate = pd?.releaseDate || null;
                    if (!releaseDate && o.date) {
                      var d14 = new Date(o.date + "T00:00:00");
                      d14.setDate(d14.getDate() + 14);
                      releaseDate = d14.toLocaleDateString("sv-SE");
                    }
                    var relDays = releaseDate ? getDaysUntil(releaseDate) : null;
                    var jaRegistrado = lancamentos.some(function(l){ return l.tipo==="recebimento"&&l.pedidoId===o.id; });

                    // Cor da previsão
                    var relColor = "#94a3b8", relBg = "#f8fafc";
                    if (releaseDate) {
                      if (relDays <= 0) { relColor = "#15803d"; relBg = "#f0fdf4"; }
                      else if (relDays <= 7) { relColor = "#d97706"; relBg = "#fffbeb"; }
                      else { relColor = "#0891b2"; relBg = "#ecfeff"; }
                    }

                    return (
                      <tr key={o.id} style={{ background: receberSel.includes(o.id)?"#eff6ff":i%2===0?"#f8fafc":"#fff" }}>
                        <td style={{ padding:"10px 14px", textAlign:"center" }}>
                          <input type="checkbox" checked={receberSel.includes(o.id)}
                            onChange={function(e){ setReceberSel(e.target.checked ? [...receberSel,o.id] : receberSel.filter(function(x){return x!==o.id;})); }}
                            style={{ cursor:"pointer" }} />
                        </td>
                        <td style={{ padding:"10px 14px", fontSize:12, color:"#64748b", fontFamily:"monospace", fontWeight:600 }}>#{o.id}</td>
                        <td style={{ padding:"10px 14px", fontSize:12, color:"#334155", maxWidth:100, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{o.buyerName||"—"}</td>
                        <td style={{ padding:"10px 14px", fontSize:12, color:"#0f172a", maxWidth:180, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }} title={o.title}>{o.title||"—"}</td>
                        <td style={{ padding:"10px 14px", fontSize:12, color:"#64748b", whiteSpace:"nowrap" }}>{fmtDate(o.date)}</td>
                        <td style={{ padding:"10px 14px", fontSize:12, color:"#64748b", whiteSpace:"nowrap" }}>{fmt(bruto)}</td>
                        <td style={{ padding:"10px 14px", whiteSpace:"nowrap" }}>
                          {tarifaExib > 0 ? (
                            <span style={{ fontSize:13, fontWeight:700, color:"#d97706" }}>{fmt(tarifaExib)}</span>
                          ) : (
                            <span style={{ fontSize:12, color:"#94a3b8" }}>—</span>
                          )}
                          <div style={{ fontSize:9, color:"#94a3b8" }}>{taxa > 0 ? taxa.toFixed(1)+"%" : ""}</div>
                        </td>
                        <td style={{ padding:"10px 14px", whiteSpace:"nowrap" }}>
                          {freteExib > 0 ? (
                            <span style={{ fontSize:13, fontWeight:700, color:"#7c3aed" }}>{fmt(freteExib)}</span>
                          ) : (
                            <span style={{ fontSize:12, color:"#94a3b8" }}>—</span>
                          )}
                        </td>
                        <td style={{ padding:"10px 14px", whiteSpace:"nowrap" }}>
                          <div style={{ fontSize:13, fontWeight:800, color: netEstimado ? "#d97706" : "#15803d" }}>
                            {fmt(netFinal)}
                          </div>
                          {netEstimado && (
                            <div style={{ fontSize:9, color:"#94a3b8", fontStyle:"italic" }}>~estimado</div>
                          )}
                        </td>
                        <td style={{ padding:"10px 14px", whiteSpace:"nowrap" }}>
                          {releaseDate ? (
                            <div style={{ background:relBg, borderRadius:8, padding:"4px 10px", display:"inline-block" }}>
                              <div style={{ fontSize:12, fontWeight:700, color:relColor }}>
                                {relDays <= 0 ? "✓ Liberado" : fmtDate(releaseDate)}
                              </div>
                              {relDays > 0 && <div style={{ fontSize:10, color:relColor, opacity:0.8 }}>em {relDays} dia(s)</div>}
                            </div>
                          ) : (
                            <span style={{ fontSize:11, color:"#94a3b8", fontStyle:"italic" }}>Aguardando ML</span>
                          )}
                        </td>
                        <td style={{ padding:"10px 14px" }}>
                          <span style={{ fontSize:11, fontWeight:600, color, background:bg, padding:"3px 8px", borderRadius:6 }}>{label}</span>
                        </td>
                        <td style={{ padding:"10px 14px" }}>
                          {jaRegistrado ? (function() {
                            var lanc = lancamentos.find(function(l){ return l.tipo==="recebimento" && (String(l.pedidoId)===String(o.id)); });
                            var isAuto = lanc && lanc.automatico;
                            return (
                              <div>
                                <span style={{ fontSize:11, color:"#15803d", fontWeight:700 }}>✓ {isAuto ? "Auto" : "Registrado"}</span>
                                {isAuto && <div style={{ fontSize:9, color:"#94a3b8" }}>baixa automática</div>}
                              </div>
                            );
                          })() : (
                            <button onClick={function(){ setModalBaixaML(o); }}
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

          {/* Recebidos — seção separada removida, agora integrada no filtro acima */}
          {false && <div style={{ fontWeight:700, fontSize:14, color:"#0f172a", marginBottom:10 }}>Recebidos no Mês Atual</div>}
          <div style={{ background:"#fff", border:"1px solid #e2e8f0", borderRadius:12, overflow:"auto" }}>
            <table style={{ borderCollapse:"collapse", width:"100%" }}>
              <thead>
                <tr>
                  {["Pedido","Produto","Data","Bruto","Líquido (MP)","Taxa ML"].map(function(h) {
                    return <th key={h} style={{ fontSize:11, color:"#94a3b8", textTransform:"uppercase", letterSpacing:0.8, padding:"10px 14px", borderBottom:"1px solid #f1f5f9", textAlign:"left", fontWeight:600, background:"#fafafa" }}>{h}</th>;
                  })}
                </tr>
              </thead>
              <tbody>
                {recebidoMes.length === 0 ? (
                  <tr><td colSpan={6} style={{ textAlign:"center", color:"#94a3b8", padding:32 }}>Nenhum pedido entregue este mês</td></tr>
                ) : recebidoMes.slice(0, 50).map(function(o, i) {
                  var bruto = o.price * o.qty;
                  var net = paymentData?.[o.id]?.netAmount || null;
                  var netFinal = net || bruto * 0.87;
                  var taxa = bruto > 0 ? ((bruto - netFinal) / bruto * 100) : 0;
                  return (
                    <tr key={o.id} style={{ background: i%2===0?"#f8fafc":"#fff" }}>
                      <td style={{ padding:"10px 14px", fontSize:12, color:"#64748b", fontFamily:"monospace", fontWeight:600 }}>#{o.id}</td>
                      <td style={{ padding:"10px 14px", fontSize:12, color:"#0f172a", maxWidth:260, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{o.title||"—"}</td>
                      <td style={{ padding:"10px 14px", fontSize:12, color:"#64748b" }}>{fmtDate(o.date)}</td>
                      <td style={{ padding:"10px 14px", fontSize:12, color:"#64748b" }}>{fmt(bruto)}</td>
                      <td style={{ padding:"10px 14px" }}>
                        <div style={{ fontSize:13, fontWeight:700, color: net ? "#15803d" : "#d97706" }}>{fmt(netFinal)}</div>
                        {!net && <div style={{ fontSize:9, color:"#94a3b8", fontStyle:"italic" }}>~estimado</div>}
                      </td>
                      <td style={{ padding:"10px 14px", fontSize:12, fontWeight:600, color: taxa > 15 ? "#dc2626" : taxa > 10 ? "#d97706" : "#15803d" }}>
                        {taxa.toFixed(1)}%{!net && <span style={{ fontSize:9, color:"#94a3b8" }}> *</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {(recebidoMes.some(function(o){ return !paymentData?.[o.id]?.netAmount; })) && (
            <div style={{ fontSize:11, color:"#94a3b8", marginTop:8 }}>* Valores estimados com ~13% de taxa ML. Reconecte para atualizar com dados reais.</div>
          )}
        </div>
        );
      })()}

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
                  <div key={cb.id} style={{ background:"#fff", border:`2px solid ${cb.cor}22`, borderRadius:14, overflow:"hidden", boxShadow:"0 1px 4px rgba(0,0,0,.06)" }}>
                    {/* Header colorido */}
                    <div style={{ background:`${cb.cor}15`, borderBottom:`1px solid ${cb.cor}22`, padding:"14px 16px", display:"flex", alignItems:"center", gap:8 }}>
                      <div style={{ width:10, height:10, borderRadius:"50%", background:cb.cor, flexShrink:0 }} />
                      <div style={{ flex:1, minWidth:0 }}>
                        <div style={{ fontWeight:700, fontSize:13, color:"#0f172a", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{cb.nome}</div>
                        <div style={{ fontSize:11, color:"#94a3b8" }}>{cb.tipo}{cb.banco ? " · " + cb.banco : ""}</div>
                      </div>
                    </div>
                    {/* Saldo */}
                    <div style={{ padding:"16px", borderBottom:"1px solid #f1f5f9" }}>
                      <div style={{ fontSize:11, color:"#94a3b8", marginBottom:4, fontWeight:600, textTransform:"uppercase", letterSpacing:0.5 }}>Saldo atual</div>
                      <div style={{ fontSize:22, fontWeight:800, color:saldo>=0?"#15803d":"#dc2626" }}>{fmt(saldo)}</div>
                      <div style={{ display:"flex", gap:12, fontSize:11, marginTop:6 }}>
                        <span style={{ color:"#15803d", fontWeight:600 }}>↑ {fmt(entradas)}</span>
                        <span style={{ color:"#dc2626", fontWeight:600 }}>↓ {fmt(saidas)}</span>
                      </div>
                    </div>
                    {/* Ações */}
                    <div style={{ display:"flex", borderTop:"1px solid #f1f5f9" }}>
                      <button onClick={function() { setExtratoContaId(extratoContaId === cb.id ? null : cb.id); }}
                        style={{ flex:1, background: extratoContaId===cb.id?"#0f172a":"transparent", border:"none", borderRight:"1px solid #f1f5f9", color: extratoContaId===cb.id?"#fff":"#64748b", padding:"10px 0", cursor:"pointer", fontSize:12, fontWeight:600, display:"flex", flexDirection:"column", alignItems:"center", gap:2 }}>
                        <span>📋</span><span style={{ fontSize:10 }}>Extrato</span>
                      </button>
                      <button onClick={function() { setEditingBancaria(cb); setShowModalBancaria(true); }}
                        style={{ flex:1, background:"transparent", border:"none", borderRight:"1px solid #f1f5f9", color:"#64748b", padding:"10px 0", cursor:"pointer", fontSize:12, fontWeight:600, display:"flex", flexDirection:"column", alignItems:"center", gap:2 }}>
                        <span>✏️</span><span style={{ fontSize:10 }}>Editar</span>
                      </button>
                      <button onClick={function() { deleteBancaria(cb.id); }}
                        style={{ flex:1, background:"transparent", border:"none", color:"#dc2626", padding:"10px 0", cursor:"pointer", fontSize:12, fontWeight:600, display:"flex", flexDirection:"column", alignItems:"center", gap:2 }}>
                        <span>🗑</span><span style={{ fontSize:10 }}>Excluir</span>
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Extrato individual por conta */}
          {extratoContaId && (function() {
            var cb = contasBancarias.find(function(c) { return c.id === extratoContaId; });
            if (!cb) return null;
            var movsAll = [...lancamentos].filter(function(l) { return l.contaBancariaId === extratoContaId; });
            var movs = movsAll.filter(function(l) {
              if (extratoDe && l.data && l.data < extratoDe) return false;
              if (extratoAte && l.data && l.data > extratoAte) return false;
              return true;
            }).sort(function(a,b) { return b.data > a.data ? 1 : -1; });
            var saldoInicial = parseFloat(cb.saldoInicial || 0);
            var saldoAtual = getSaldoConta(extratoContaId);
            return (
              <div style={{ marginTop:16, background:"#fff", border:`2px solid ${cb.cor}44`, borderRadius:12, overflow:"hidden" }}>
                <div style={{ background:`${cb.cor}11`, borderBottom:`1px solid ${cb.cor}33`, padding:"14px 20px", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                  <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                    <div style={{ width:14, height:14, borderRadius:"50%", background:cb.cor }} />
                    <div style={{ fontWeight:700, fontSize:15, color:"#0f172a" }}>Extrato — {cb.nome}</div>
                    <span style={{ fontSize:12, color:"#64748b" }}>{cb.tipo}{cb.banco ? " · " + cb.banco : ""}</span>
                  </div>
                  <div style={{ display:"flex", alignItems:"center", gap:16 }}>
                    <div style={{ textAlign:"right" }}>
                      <div style={{ fontSize:11, color:"#94a3b8" }}>Saldo atual</div>
                      <div style={{ fontSize:17, fontWeight:800, color: saldoAtual>=0?"#15803d":"#dc2626" }}>{fmt(saldoAtual)}</div>
                    </div>
                    <button onClick={function() { setExtratoContaId(null); setExtratoDe(""); setExtratoAte(""); }}
                      style={{ background:"#f1f5f9", border:"none", color:"#64748b", width:32, height:32, borderRadius:8, cursor:"pointer", fontSize:14 }}>✕</button>
                  </div>
                </div>
                {/* Filtros de período */}
                <div style={{ padding:"12px 16px", borderBottom:"1px solid #f1f5f9", background:"#fafafa" }}>
                  <div style={{ display:"flex", gap:8, alignItems:"center", flexWrap:"wrap", marginBottom:6 }}>
                    <span style={{ fontSize:12, color:"#64748b", fontWeight:600 }}>📅 Período:</span>
                    <BotoesPeriodo de={extratoDe} ate={extratoAte} onChangeDe={function(v){ setExtratoDe(v); setExtratoSel([]); }} onChangeAte={function(v){ setExtratoAte(v); setExtratoSel([]); }} />
                  </div>
                  <div style={{ display:"flex", gap:8, alignItems:"center", flexWrap:"wrap" }}>
                    <input type="date" value={extratoDe} onChange={function(e){ setExtratoDe(e.target.value); setExtratoSel([]); }}
                      style={{ background:"#fff", border:"1px solid #e2e8f0", color:"#334155", padding:"5px 10px", borderRadius:8, fontSize:12 }} />
                    <span style={{ fontSize:12, color:"#94a3b8" }}>até</span>
                    <input type="date" value={extratoAte} onChange={function(e){ setExtratoAte(e.target.value); setExtratoSel([]); }}
                      style={{ background:"#fff", border:"1px solid #e2e8f0", color:"#334155", padding:"5px 10px", borderRadius:8, fontSize:12 }} />
                    {(extratoDe||extratoAte) && (
                      <button onClick={function(){ setExtratoDe(""); setExtratoAte(""); setExtratoSel([]); }}
                        style={{ background:"#f1f5f9", border:"1px solid #e2e8f0", color:"#64748b", padding:"5px 10px", borderRadius:8, cursor:"pointer", fontSize:12 }}>✕ Limpar</button>
                    )}
                    <span style={{ fontSize:12, color:"#94a3b8", marginLeft:"auto" }}>{movs.length} lançamento(s)</span>
                  </div>
                  {extratoSel.length > 0 && (
                    <div style={{ display:"flex", gap:8, alignItems:"center", marginTop:8, background:"#0f172a", borderRadius:8, padding:"8px 12px", flexWrap:"wrap" }}>
                      <span style={{ color:"#fff", fontWeight:700, fontSize:12 }}>{extratoSel.length} selecionado(s)</span>
                      <button onClick={function(){
                        if (!window.confirm("Excluir " + extratoSel.length + " lançamento(s)?")) return;
                        var upd = lancamentos.filter(function(x){ return !extratoSel.includes(x.id); });
                        setLancamentos(upd); saveLS("lancamentos", upd); setExtratoSel([]);
                      }} style={{ background:"#dc2626", border:"none", color:"#fff", fontWeight:700, padding:"5px 12px", borderRadius:6, cursor:"pointer", fontSize:12 }}>
                        🗑 Excluir Selecionados
                      </button>
                      <button onClick={function(){ setExtratoSel([]); }}
                        style={{ background:"#334155", border:"none", color:"#94a3b8", padding:"5px 10px", borderRadius:6, cursor:"pointer", fontSize:12 }}>✕ Cancelar</button>
                    </div>
                  )}
                </div>
                {movs.length === 0 ? (
                  <div style={{ padding:32, textAlign:"center", color:"#94a3b8", fontSize:13 }}>{movsAll.length > 0 ? "Nenhum lançamento neste período" : "Nenhum lançamento nesta conta"}</div>
                ) : (
                  <div style={{ overflowX:"auto" }}>
                    <table style={{ borderCollapse:"collapse", width:"100%" }}>
                      <thead>
                        <tr>
                          <th style={{ padding:"10px 16px", background:"#fafafa", borderBottom:"1px solid #f1f5f9", width:36 }}>
                            <input type="checkbox"
                              checked={movs.length > 0 && movs.every(function(l){ return extratoSel.includes(l.id); })}
                              onChange={function(e){ setExtratoSel(e.target.checked ? movs.map(function(l){return l.id;}) : []); }}
                              style={{ cursor:"pointer" }} />
                          </th>
                          {["Data","Descrição","Tipo","Valor",""].map(function(h) {
                            return <th key={h} style={{ fontSize:11, color:"#94a3b8", textTransform:"uppercase", letterSpacing:0.8, padding:"10px 16px", borderBottom:"1px solid #f1f5f9", textAlign:"left", fontWeight:600, background:"#fafafa" }}>{h}</th>;
                          })}
                        </tr>
                      </thead>
                      <tbody>
                        {movs.map(function(l, i) {
                          return (
                            <tr key={l.id} style={{ background: extratoSel.includes(l.id) ? "#eff6ff" : l.automatico ? "#fffbeb" : i%2===0?"#f8fafc":"#fff" }}>
                              <td style={{ padding:"10px 16px", textAlign:"center" }}>
                                <input type="checkbox" checked={extratoSel.includes(l.id)}
                                  onChange={function(e){ setExtratoSel(e.target.checked ? [...extratoSel,l.id] : extratoSel.filter(function(x){return x!==l.id;})); }}
                                  style={{ cursor:"pointer" }} />
                              </td>
                              <td style={{ padding:"10px 16px", fontSize:12, color:"#64748b", whiteSpace:"nowrap" }}>{fmtDate(l.data)}</td>
                              <td style={{ padding:"10px 16px", fontSize:13, color:"#0f172a" }}>
                                {l.descricao}
                                {l.automatico && <span style={{ marginLeft:6, fontSize:10, background:"#fef9c3", color:"#92400e", border:"1px solid #fde68a", borderRadius:4, padding:"1px 5px" }}>🤖 auto</span>}
                              </td>
                              <td style={{ padding:"10px 16px" }}>
                                <span style={{ fontSize:11, fontWeight:600, color: l.tipo==="recebimento"?"#15803d":"#dc2626", background: l.tipo==="recebimento"?"#f0fdf4":"#fef2f2", padding:"2px 8px", borderRadius:5 }}>
                                  {l.tipo==="recebimento" ? "↑ Entrada" : "↓ Saída"}
                                </span>
                              </td>
                              <td style={{ padding:"10px 16px", fontSize:13, fontWeight:700, color: l.tipo==="recebimento"?"#15803d":"#dc2626", textAlign:"right" }}>
                                {l.tipo==="recebimento" ? "+" : "-"}{fmt(l.valor)}
                              </td>
                              <td style={{ padding:"10px 16px", textAlign:"center" }}>
                                <button
                                  onClick={function() {
                                    if (!window.confirm("Excluir lançamento: " + l.descricao + "?")) return;
                                    var upd = lancamentos.filter(function(x){ return x.id !== l.id; });
                                    setLancamentos(upd);
                                    saveLS("lancamentos", upd);
                                  }}
                                  title="Excluir lançamento"
                                  style={{ background:"#fef2f2", border:"none", color:"#dc2626", width:26, height:26, borderRadius:6, cursor:"pointer", fontSize:12 }}>
                                  🗑
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                      <tfoot>
                        <tr style={{ background:"#f8fafc", borderTop:"2px solid #e2e8f0" }}>
                          <td colSpan={3} style={{ padding:"12px 16px", fontSize:12, fontWeight:700, color:"#0f172a" }}>Saldo inicial: {fmt(saldoInicial)}</td>
                          <td style={{ padding:"12px 16px", fontSize:14, fontWeight:800, color: saldoAtual>=0?"#15803d":"#dc2626", textAlign:"right" }}>= {fmt(saldoAtual)}</td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                )}
              </div>
            );
          })()}

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
      {showModalMultiBaixa && selecionadas.length > 0 && (
        <ModalMultiBaixa
          contas={contasPagar.filter(function(c){return selecionadas.includes(c.id);})}
          contasBancarias={contasBancarias}
          onConfirm={function(data){confirmarMultiBaixa(selecionadas,data);}}
          onClose={function(){setShowModalMultiBaixa(false);}}
        />
      )}
    </div>
  );
}


// ── Utilitário de períodos rápidos ──────────────────────────
function getPeriodo(key) {
  var hoje = new Date(); hoje.setHours(0,0,0,0);
  var hojeStr = hoje.toLocaleDateString("sv-SE");
  if (key === "hoje") {
    return { de: hojeStr, ate: hojeStr };
  }
  if (key === "7dias") {
    var d = new Date(hoje); d.setDate(d.getDate() - 6);
    return { de: d.toLocaleDateString("sv-SE"), ate: hojeStr };
  }
  if (key === "mesat") {
    var d = new Date(hoje.getFullYear(), hoje.getMonth(), 1);
    return { de: d.toLocaleDateString("sv-SE"), ate: hojeStr };
  }
  if (key === "30dias") {
    var d = new Date(hoje); d.setDate(d.getDate() - 29);
    return { de: d.toLocaleDateString("sv-SE"), ate: hojeStr };
  }
  if (key === "3meses") {
    var d = new Date(hoje); d.setMonth(d.getMonth() - 3);
    return { de: d.toLocaleDateString("sv-SE"), ate: hojeStr };
  }
  return { de: "", ate: "" }; // todos
}

var PERIODOS = [
  { key:"hoje",   label:"Hoje" },
  { key:"7dias",  label:"7 dias" },
  { key:"mesat",  label:"Este mês" },
  { key:"30dias", label:"30 dias" },
  { key:"3meses", label:"3 meses" },
  { key:"todos",  label:"Todos" },
];

function BotoesPeriodo({ de, ate, onChangeDe, onChangeAte }) {
  // Detecta qual botão está ativo comparando com os períodos
  function getAtivo() {
    if (!de && !ate) return "todos";
    for (var i = 0; i < PERIODOS.length - 1; i++) {
      var p = getPeriodo(PERIODOS[i].key);
      if (p.de === de && p.ate === ate) return PERIODOS[i].key;
    }
    return null; // custom
  }
  var ativo = getAtivo();
  return (
    <div style={{ display:"flex", gap:4, flexWrap:"wrap" }}>
      {PERIODOS.map(function(p) {
        var isAtivo = ativo === p.key;
        return (
          <button key={p.key}
            onClick={function() {
              var per = getPeriodo(p.key);
              onChangeDe(per.de);
              onChangeAte(per.ate);
            }}
            style={{ padding:"5px 12px", borderRadius:20, border: isAtivo ? "2px solid #0f172a" : "1px solid #e2e8f0",
              background: isAtivo ? "#0f172a" : "#f8fafc",
              color: isAtivo ? "#fff" : "#64748b",
              fontWeight: isAtivo ? 700 : 500, fontSize:12, cursor:"pointer", fontFamily:"inherit", whiteSpace:"nowrap" }}>
            {p.label}
          </button>
        );
      })}
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

            // Tentar vários campos para obter o custo real do frete para o vendedor
            var sender = costsData?.senders?.[0] || {};
            // save = valor subsidiado pelo vendedor, cost = custo total, list_cost = tabela
            var save    = parseFloat(sender.save    ?? sender.cost ?? sender.list_cost ?? 0);
            var cost    = parseFloat(sender.cost    ?? sender.list_cost ?? 0);
            var listCost = parseFloat(sender.list_cost ?? 0);

            // O frete cobrado do vendedor é: cost - (o que o comprador pagou)
            // Se save > 0 = é o desconto dado ao comprador (frete grátis) = custo do vendedor
            // Se save == 0 mas cost > 0 = comprador pagou tudo, vendedor não paga
            var buyerPaidShip = parseFloat(costsData?.receivers?.[0]?.cost ?? 0);
            var freteVendedor = 0;

            if (save > 0) {
              freteVendedor = save; // frete grátis: vendedor paga 'save'
            } else if (cost > 0 && buyerPaidShip === 0) {
              freteVendedor = cost; // comprador não pagou nada = vendedor paga tudo
            } else if (cost > 0 && buyerPaidShip < cost) {
              freteVendedor = cost - buyerPaidShip; // vendedor paga a diferença
            }

            // Fallback: usar base_cost do shipment se disponível
            if (freteVendedor === 0 && shipData?.base_cost > 0) {
              freteVendedor = parseFloat(shipData.base_cost);
            }

            orderShippingMap[String(o.id)] = freteVendedor;
            // status: "delivered", "shipped", "ready_to_ship", "pending", etc
            shipmentStatusMap[String(o.id)] = shipData?.status ?? null;
            // Guardar método de envio
            var lt = shipData?.logistic_type || "";
            if (lt) shipmentStatusMap[String(o.id) + "_logistic"] = lt;
          } catch { orderShippingMap[String(o.id)] = 0; }
        }));
        if (i % 20 === 0) setShipmentCosts({...orderShippingMap});
        await new Promise(r => setTimeout(r, 100));
      }
      setShipmentCosts({...orderShippingMap});
      setShipmentStatuses({...shipmentStatusMap});

      // Buscar dados de pagamento usando /orders/{id} com campo completo de payment
      // Isso retorna os dados reais de valor líquido e data de liberação
      setLoadingMsg("Buscando dados de pagamento...");
      const paymentMap = {};
      const paidOrders = orders.filter(o => o.status === "paid");
      for (let i = 0; i < paidOrders.length; i += 5) {
        const batch = paidOrders.slice(i, i + 5);
        await Promise.all(batch.map(async o => {
          const oid = String(o.id);
          try {
            // Buscar o pedido completo com todos os campos de pagamento
            const res = await fetch(ML(`/orders/${o.id}`), { headers: { Authorization: `Bearer ${validTk}` } });
            const data = await res.json();
            if (data.error) return;

            // Fórmula correta: total_amount - sale_fee (sale_fee já inclui tarifa ML + custo frete)
            var bruto = parseFloat(data.total_amount || o.total_amount || 0);

            // sale_fee de cada item (inclui tarifa de venda + custo envio cobrado pelo ML)
            var saleFeeTotal = 0;
            if (Array.isArray(data.order_items)) {
              data.order_items.forEach(function(item) {
                saleFeeTotal += parseFloat(item.sale_fee || 0);
              });
            }

            // Se sale_fee não disponível, usar marketplace_fee como fallback
            var tarifaFinal = saleFeeTotal > 0 ? saleFeeTotal : parseFloat(data.marketplace_fee || 0);

            // Valor líquido = bruto - sale_fee (tarifa ML + frete seller)
            var netAmount = bruto > 0 && tarifaFinal > 0 ? bruto - tarifaFinal : 0;

            // Calcular frete e tarifa separados para exibição
            var freteCusto = 0;
            var tarifaML = tarifaFinal;
            if (Array.isArray(data.order_items)) {
              data.order_items.forEach(function(item) {
                freteCusto += parseFloat(item.shipping_cost || 0);
              });
              if (freteCusto > 0) tarifaML = tarifaFinal - freteCusto;
            }

            // Data de liberação via payments[0]
            var releaseDate = null;
            if (Array.isArray(data.payments) && data.payments.length > 0) {
              var pmt = data.payments.find(function(p) { return p.status === "approved"; }) || data.payments[0];
              releaseDate = (pmt && pmt.money_release_date) ? pmt.money_release_date.slice(0, 10) : null;
            }

            if (netAmount > 0 || releaseDate) {
              paymentMap[oid] = {
                releaseDate,
                netAmount: netAmount > 0 ? netAmount : bruto * 0.87,
                bruto,
                tarifaML: tarifaML,
                freteCusto: freteCusto,
                isCalculated: saleFeeTotal <= 0,
              };
            }
          } catch {}
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
    else if (orderFilter === "thismonth") { cutoff = new Date(now.getFullYear(), now.getMonth(), 1); }
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
                {[{ key: "today", label: "Hoje" }, { key: "week", label: "7 dias" }, { key: "thismonth", label: "Este mês" }, { key: "month", label: "30 dias" }, { key: "3months", label: "3 meses" }, { key: "all", label: "Todos" }].map(f => (
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
                    <th>Envio</th>
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
                          {(() => {
                            var lt = shipmentStatuses?.[String(o.id) + "_logistic"] || o.shipping?.logistic_type || "";
                            var cfg = lt.includes("fulfillment") || lt.includes("self_service")
                              ? { label:"FULL", color:"#1d4ed8", bg:"#eff6ff" }
                              : lt.includes("flex")
                              ? { label:"Flex", color:"#7c3aed", bg:"#f5f3ff" }
                              : lt.includes("drop_off") || lt.includes("xd_")
                              ? { label:"ME2", color:"#0891b2", bg:"#ecfeff" }
                              : lt.includes("me1") || lt.includes("mandatory")
                              ? { label:"ME1", color:"#0369a1", bg:"#e0f2fe" }
                              : lt.includes("cross")
                              ? { label:"Cross", color:"#15803d", bg:"#f0fdf4" }
                              : o.shipping?.free_shipping
                              ? { label:"Grátis", color:"#15803d", bg:"#f0fdf4" }
                              : { label:"—", color:"#94a3b8", bg:"transparent" };
                            if (cfg.label === "—") return <span style={{ color:"#94a3b8", fontSize:11 }}>—</span>;
                            return <span style={{ fontSize:10, fontWeight:700, color:cfg.color, background:cfg.bg, padding:"2px 7px", borderRadius:5, whiteSpace:"nowrap", letterSpacing:0.3 }}>{cfg.label}</span>;
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
