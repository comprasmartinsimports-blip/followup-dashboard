import { useState, useMemo } from "react";

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

// ── Tela de Login do Dashboard ───────────────────────────────
function LoginScreen({ onLogin }) {
  const [user, setUser]   = useState("");
  const [pass, setPass]   = useState("");
  const [error, setError] = useState("");
  const [show, setShow]   = useState(false);

  function handleLogin() {
    if (user === DASHBOARD_USER && pass === DASHBOARD_PASS) {
      sessionStorage.setItem("dash_auth", "1");
      onLogin();
    } else {
      setError("Usuário ou senha incorretos");
      setPass("");
    }
  }

  if (!isLoggedIn) return <LoginScreen onLogin={() => setIsLoggedIn(true)} />;

  return (
    <div style={{ minHeight: "100vh", background: "#f8fafc", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'Inter','Segoe UI',sans-serif" }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');*{box-sizing:border-box;margin:0;padding:0}`}</style>
      <div style={{ background: "#fff", borderRadius: 20, width: "100%", maxWidth: 420, padding: "40px 40px 36px", boxShadow: "0 20px 60px rgba(0,0,0,.10)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 32 }}>
          <div style={{ width: 44, height: 44, borderRadius: 12, background: "#0f172a", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 20, color: "#ffe000" }}>M</div>
          <div>
            <div style={{ fontWeight: 800, fontSize: 18, color: "#0f172a" }}>ML Margem</div>
            <div style={{ fontSize: 11, color: "#94a3b8", letterSpacing: 0.5 }}>DASHBOARD DE LUCRATIVIDADE</div>
          </div>
        </div>

        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 11, color: "#94a3b8", marginBottom: 6, fontWeight: 600, letterSpacing: 1, textTransform: "uppercase" }}>Usuário</div>
          <input value={user} onChange={e => { setUser(e.target.value); setError(""); }}
            onKeyDown={e => e.key === "Enter" && handleLogin()}
            placeholder="Digite seu usuário"
            style={{ width: "100%", background: "#f8fafc", border: `1px solid ${error ? "#fca5a5" : "#e2e8f0"}`, color: "#0f172a", padding: "11px 14px", borderRadius: 10, fontSize: 14, outline: "none", fontFamily: "inherit" }} />
        </div>

        <div style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 11, color: "#94a3b8", marginBottom: 6, fontWeight: 600, letterSpacing: 1, textTransform: "uppercase" }}>Senha</div>
          <div style={{ position: "relative" }}>
            <input type={show ? "text" : "password"} value={pass}
              onChange={e => { setPass(e.target.value); setError(""); }}
              onKeyDown={e => e.key === "Enter" && handleLogin()}
              placeholder="Digite sua senha"
              style={{ width: "100%", background: "#f8fafc", border: `1px solid ${error ? "#fca5a5" : "#e2e8f0"}`, color: "#0f172a", padding: "11px 42px 11px 14px", borderRadius: 10, fontSize: 14, outline: "none", fontFamily: "inherit" }} />
            <button onClick={() => setShow(s => !s)}
              style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", color: "#94a3b8", fontSize: 16 }}>
              {show ? "🙈" : "👁"}
            </button>
          </div>
        </div>

        {error && <div style={{ background: "#fef2f2", border: "1px solid #fecaca", color: "#dc2626", fontSize: 13, padding: "10px 14px", borderRadius: 8, marginBottom: 16, fontWeight: 500 }}>⚠ {error}</div>}

        <button onClick={handleLogin} disabled={!user || !pass}
          style={{ width: "100%", background: !user || !pass ? "#f1f5f9" : "#0f172a", border: "none", color: !user || !pass ? "#94a3b8" : "#fff", fontWeight: 700, padding: "13px", borderRadius: 10, cursor: !user || !pass ? "not-allowed" : "pointer", fontSize: 15 }}>
          Entrar
        </button>
      </div>
    </div>
  );
}

// ── Modal de conexão ML — token manual com persistência ─────
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
function ModalConta({ conta, categoriasPagar, onSave, onClose }) {
  const [form, setForm] = useState(conta || {
    id: Date.now(), descricao: "", categoria: categoriasPagar[0] || "Outros",
    valor: "", vencimento: "", status: "Pendente", observacao: ""
  });
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(15,23,42,.6)", backdropFilter:"blur(4px)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:400, padding:24 }}>
      <div style={{ background:"#fff", borderRadius:16, width:"100%", maxWidth:500, padding:"28px 32px", boxShadow:"0 20px 60px rgba(0,0,0,.15)" }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:20 }}>
          <div style={{ fontWeight:800, fontSize:17, color:"#0f172a" }}>{conta ? "Editar Conta" : "Nova Conta a Pagar"}</div>
          <button onClick={onClose} style={{ background:"#f1f5f9", border:"none", color:"#64748b", width:32, height:32, borderRadius:8, cursor:"pointer", fontSize:16 }}>✕</button>
        </div>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12, marginBottom:16 }}>
          <div style={{ gridColumn:"1/-1" }}>
            <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Descrição *</div>
            <input value={form.descricao} onChange={e => set("descricao", e.target.value)} placeholder="Ex: Nota fiscal fornecedor X"
              style={{ width:"100%", background:"#f8fafc", border:"1px solid #e2e8f0", color:"#0f172a", padding:"9px 12px", borderRadius:8, fontSize:13, outline:"none" }} />
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
          <div style={{ gridColumn:"1/-1" }}>
            <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Observação</div>
            <input value={form.observacao} onChange={e => set("observacao", e.target.value)} placeholder="Opcional"
              style={{ width:"100%", background:"#f8fafc", border:"1px solid #e2e8f0", color:"#0f172a", padding:"9px 12px", borderRadius:8, fontSize:13, outline:"none" }} />
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
  );
}

// ── FinanceiroTab Principal ──────────────────────────────────
function FinanceiroTab({ contasPagar, setContasPagar, contasBancarias, setContasBancarias, categoriasPagar, setCategoriasPagar, lancamentos, setLancamentos, enrichedOrders, rawOrders, shipmentStatuses, paymentData, finTab, setFinTab }) {
  const [showModalConta, setShowModalConta] = useState(false);
  const [showModalBancaria, setShowModalBancaria] = useState(false);
  const [editingConta, setEditingConta] = useState(null);
  const [editingBancaria, setEditingBancaria] = useState(null);
  const [modalBaixa, setModalBaixa] = useState(null); // conta a pagar para dar baixa
  const [modalBaixaML, setModalBaixaML] = useState(null); // pedido ML para registrar
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
    return r.sort((a,b) => (a.vencimento||"9999") > (b.vencimento||"9999") ? 1 : -1);
  }, [contasPagar, filterStatus, filterCat, searchPagar]);

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
    const updated = editingConta ? contasPagar.map(c=>c.id===form.id?form:c) : [...contasPagar, {...form, id:Date.now()}];
    setContasPagar(updated); saveLS("contas_pagar", updated); setEditingConta(null);
  }

  function deleteConta(id) {
    if (!confirm("Excluir esta conta?")) return;
    const updated = contasPagar.filter(c=>c.id!==id);
    setContasPagar(updated); saveLS("contas_pagar", updated);
  }

  function confirmarBaixa(conta, { contaBancariaId, dataPagamento, obs }) {
    const updatedContas = contasPagar.map(c => c.id===conta.id ? {...c, status:"Pago", contaBancariaId, dataPagamento} : c);
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

      {/* ── CONTAS A PAGAR ── */}
      {finTab === "pagar" && (
        <div>
          <div style={{ display:"flex", gap:10, alignItems:"center", marginBottom:14, flexWrap:"wrap" }}>
            <button onClick={() => { setEditingConta(null); setShowModalConta(true); }}
              style={{ background:"#0f172a", border:"none", color:"#fff", fontWeight:700, padding:"9px 20px", borderRadius:8, cursor:"pointer", fontSize:13 }}>+ Nova Conta</button>
            <div style={{ position:"relative", flex:1, minWidth:160 }}>
              <span style={{ position:"absolute", left:10, top:"50%", transform:"translateY(-50%)", color:"#94a3b8", fontSize:13 }}>🔍</span>
              <input value={searchPagar} onChange={e=>setSearchPagar(e.target.value)} placeholder="Buscar..."
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
                <tr>{["Descrição","Categoria","Valor","Vencimento","Status","Conta paga","Ações"].map(h=>(
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
                        {c.descricao}
                        {isVencendo&&<span style={{ fontSize:10, background:"#fde68a", color:"#92400e", padding:"1px 6px", borderRadius:4, marginLeft:6, fontWeight:600 }}>Vence em {days}d</span>}
                      </td>
                      <td style={{ padding:"10px 14px", fontSize:12, color:"#64748b" }}>{c.categoria}</td>
                      <td style={{ padding:"10px 14px", fontSize:13, fontWeight:700, color:"#0f172a" }}>{fmt(parseFloat(c.valor||0))}</td>
                      <td style={{ padding:"10px 14px", fontSize:12, color:"#64748b" }}>{fmtDate(c.vencimento)}</td>
                      <td style={{ padding:"10px 14px" }}><span style={{ fontSize:11, fontWeight:600, color:statusColor(c.status), background:statusBg(c.status), padding:"3px 8px", borderRadius:6 }}>{c.status}</span></td>
                      <td style={{ padding:"10px 14px", fontSize:12, color:"#64748b" }}>
                        {contaBanc ? <span style={{ display:"flex", alignItems:"center", gap:4 }}><div style={{ width:8, height:8, borderRadius:"50%", background:contaBanc.cor }} />{contaBanc.nome}</span> : "—"}
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
          <div style={{ fontWeight:700, fontSize:14, color:"#0f172a", marginBottom:10 }}>Pedidos a Receber</div>
          <div style={{ background:"#fff", border:"1px solid #e2e8f0", borderRadius:12, overflow:"auto", marginBottom:20 }}>
            <table style={{ borderCollapse:"collapse", width:"100%" }}>
              <thead>
                <tr>{["Pedido","Produto","Data","Valor Bruto","Valor Líquido","Previsão ML","Status","Ação"].map(h=>(
                  <th key={h} style={{ fontSize:11, color:"#94a3b8", textTransform:"uppercase", letterSpacing:0.8, padding:"10px 14px", borderBottom:"1px solid #f1f5f9", textAlign:"left", fontWeight:600, background:"#fafafa", whiteSpace:"nowrap" }}>{h}</th>
                ))}</tr>
              </thead>
              <tbody>
                {aReceber.length===0 ? (
                  <tr><td colSpan={8} style={{ textAlign:"center", color:"#94a3b8", padding:32 }}>Nenhum pedido a receber</td></tr>
                ) : aReceber.slice(0,100).map((o,i) => {
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
                })}
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
        <div style={{ maxWidth:500 }}>
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
      )}

      {/* Modais */}
      {showModalConta && <ModalConta conta={editingConta} categoriasPagar={categoriasPagar} onSave={saveConta} onClose={()=>{ setShowModalConta(false); setEditingConta(null); }} />}
      {showModalBancaria && <ModalContaBancaria conta={editingBancaria} onSave={saveBancaria} onClose={()=>{ setShowModalBancaria(false); setEditingBancaria(null); }} />}
      {modalBaixa && <ModalBaixa conta={modalBaixa} contasBancarias={contasBancarias} onConfirm={(data)=>confirmarBaixa(modalBaixa,data)} onClose={()=>setModalBaixa(null)} />}
      {modalBaixaML && <ModalBaixaML order={modalBaixaML} paymentInfo={paymentData?.[modalBaixaML.id]} contasBancarias={contasBancarias} onConfirm={(data)=>confirmarBaixaML(modalBaixaML,data)} onClose={()=>setModalBaixaML(null)} />}
    </div>
  );
}


export default function App() {
  // ── Auth do dashboard ─────────────────────────────────────
  const [isLoggedIn, setIsLoggedIn] = useState(() => sessionStorage.getItem("dash_auth") === "1");

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
  const [showMLModal, setShowMLModal] = useState(false);
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
  const [finTab, setFinTab] = useState("resumo"); // resumo | pagar | receber | contas | config
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

      // Buscar dados de pagamento (data de liberação + valor líquido) por pedido
      setLoadingMsg("Buscando previsão de pagamento...");
      const paymentMap = {};
      const ordersForPayment = orders.filter(o => o.status === "paid").slice(0, 100);
      for (let i = 0; i < ordersForPayment.length; i += 5) {
        const batch = ordersForPayment.slice(i, i + 5);
        await Promise.all(batch.map(async o => {
          try {
            // ML payments endpoint: /collections/orders/{id} traz money_release_date
            const res = await fetch(ML(`/collections/orders/${o.id}`), { headers: { Authorization: `Bearer ${validTk}` } });
            const data = await res.json();
            const col = data?.collection ?? data;
            if (col) {
              // net_received_amount = valor líquido após tarifas e frete
              // money_release_date = data exata de liberação pelo ML
              const releaseDate = col.money_release_date?.slice(0, 10) ?? 
                                  col.payments?.[0]?.money_release_date?.slice(0, 10) ?? null;
              const netAmount = parseFloat(
                col.net_received_amount ?? 
                col.payments?.[0]?.net_received_amount ?? 
                col.total_amount ?? 0
              );
              if (releaseDate || netAmount > 0) {
                paymentMap[String(o.id)] = { releaseDate, netAmount };
              }
            }
          } catch { /* ignora */ }
        }));
        if (i % 20 === 0) setPaymentData({...paymentMap});
        await new Promise(r => setTimeout(r, 100));
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

  const totalRevenue = enrichedOrders.reduce((s, o) => s + o.revenue * o.qty, 0);
  const totalProfit = enrichedOrders.reduce((s, o) => s + o.profit * o.qty, 0);
  const totalFees = enrichedOrders.reduce((s, o) => s + o.fee * o.qty, 0);
  const totalFreteSeller = enrichedOrders.reduce((s, o) => s + (o.freteSeller ?? 0), 0);
  const avgMargin = enrichedOrders.length > 0 ? enrichedOrders.reduce((s, o) => s + (o.margin ?? 0), 0) / enrichedOrders.length : 0;
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

  return (
    <div style={{ minHeight: "100vh", background: "#f8fafc", color: "#0f172a", fontFamily: "'Inter','Segoe UI',sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        ::-webkit-scrollbar{width:5px;height:5px}::-webkit-scrollbar-track{background:#f1f5f9}::-webkit-scrollbar-thumb{background:#cbd5e1;border-radius:99px}
        input:focus,textarea:focus,select:focus{outline:2px solid #0f172a;outline-offset:1px}
        table{border-collapse:collapse;width:100%}
        th{font-size:11px;color:#94a3b8;text-transform:uppercase;letter-spacing:0.8px;padding:10px 14px;border-bottom:1px solid #f1f5f9;text-align:left;font-weight:600;background:#fafafa;white-space:nowrap}
        td{padding:10px 14px;font-size:13px;border-bottom:1px solid #f8fafc;vertical-align:middle;color:#334155}
        tr:last-child td{border-bottom:none}tr:hover td{background:#f8fafc}
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

      <header style={{ background: "#fff", borderBottom: "1px solid #e2e8f0", padding: "14px 32px", display: "flex", alignItems: "center", justifyContent: "space-between", position: "sticky", top: 0, zIndex: 100, boxShadow: "0 1px 3px rgba(0,0,0,.04)" }}>
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
          <button onClick={() => setShowMLModal(true)} style={{ background: "#0f172a", border: "none", color: "#fff", fontWeight: 700, padding: "8px 20px", borderRadius: 8, cursor: "pointer", fontSize: 13 }}>
            {token ? "Reconectar" : "Conectar ML"}
          </button>
        </div>
      </header>

      <main style={{ maxWidth: 1440, margin: "0 auto", padding: "24px 32px" }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 12, marginBottom: 24 }} className="fade-up">
          {[
            { label: "Receita líquida", value: fmt(totalRevenue), color: "#0f172a" },
            { label: "Lucro estimado", value: fmt(totalProfit), color: totalProfit >= 0 ? "#15803d" : "#dc2626" },
            { label: "Tarifas ML", value: fmt(totalFees), color: "#d97706" },
            { label: "Frete (seu custo)", value: fmt(totalFreteSeller), color: "#7c3aed" },
            { label: "Margem média", value: fmtPct(avgMargin), color: avgMargin >= .25 ? "#15803d" : avgMargin >= .15 ? "#d97706" : "#dc2626" },
            { label: "Score médio", value: `${avgScore}/100`, color: scoreColor(avgScore) },
            { label: "Total anúncios", value: enriched.length, color: "#0f172a" },
            { label: "Pedidos período", value: enrichedOrders.length, color: "#0f172a" },
          ].map(k => (
            <div key={k.label} style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 12, padding: "16px 18px", boxShadow: "0 1px 2px rgba(0,0,0,.04)" }}>
              <div style={{ fontSize: 11, color: "#94a3b8", marginBottom: 8, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.8 }}>{k.label}</div>
              <div style={{ fontSize: 20, fontWeight: 800, color: k.color, letterSpacing: -0.5 }}>{k.value}</div>
            </div>
          ))}
        </div>

        <div style={{ display: "flex", gap: 2, marginBottom: 20, background: "#f1f5f9", padding: 4, borderRadius: 10, width: "fit-content" }}>
          <button className={`tab-btn ${tab === "listings" ? "active" : ""}`} onClick={() => setTab("listings")}>Anúncios ({enriched.length})</button>
          <button className={`tab-btn ${tab === "orders" ? "active" : ""}`} onClick={() => setTab("orders")}>Pedidos ({enrichedOrders.length})</button>
          <button className={`tab-btn ${tab === "financeiro" ? "active" : ""}`} onClick={() => setTab("financeiro")}>💰 Financeiro</button>
        </div>

        {tab === "listings" && (
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

        {tab === "orders" && (
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


        {tab === "financeiro" && (
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
          />
        )}

      {showMLModal && <MLConnectModal onConnect={handleConnect} onClose={() => setShowMLModal(false)} />}
      {selectedListing && <AIPanel listing={selectedListing} onClose={() => setSelectedListing(null)} />}
    </div>
  );
}
