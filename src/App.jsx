import { useState, useMemo } from "react";

const ML_FEES = { default: 0.16, electronics: 0.14, fashion: 0.16, home: 0.15, sports: 0.15 };
const fmt = (n) => `R$ ${Number(n).toFixed(2).replace(".", ",")}`;
const fmtPct = (n) => `${(n * 100).toFixed(1)}%`;
const ML = (path) => `/api/ml${path}`;

function calcMargin(price, cost, category = "default", shipping = 0) {
  const fee = ML_FEES[category] ?? ML_FEES.default;
  const mlFee = price * fee;
  const revenue = price - mlFee - shipping;
  const profit = revenue - cost;
  const margin = cost > 0 ? profit / price : null;
  return { fee: mlFee, revenue, profit, margin, feeRate: fee };
}

function calcQualityScore(listing) {
  const checks = [
    { key: "title_length", label: "Título com 60+ caracteres", pass: listing.title?.length >= 60, weight: 15 },
    { key: "photos_count", label: "6+ fotos", pass: (listing.pictures?.length ?? 0) >= 6, weight: 20 },
    { key: "description", label: "Descrição detalhada (100+ chars)", pass: (listing.description?.plain_text?.length ?? 0) >= 100, weight: 20 },
    { key: "free_shipping", label: "Frete grátis", pass: listing.shipping?.free_shipping === true, weight: 15 },
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
  const prompt = `Você é um especialista em otimização de anúncios do Mercado Livre Brasil. 
Analise este anúncio e retorne SOMENTE um JSON válido (sem markdown, sem backticks) com esta estrutura:
{"score_commentary":"comentário em 1 frase","strengths":["ponto1","ponto2"],"improvements":[{"field":"campo","suggestion":"sugestão"},{"field":"campo","suggestion":"sugestão"},{"field":"campo","suggestion":"sugestão"}],"title_suggestion":"título otimizado máx 60 chars","keywords":["palavra1","palavra2","palavra3","palavra4","palavra5"]}
Anúncio: Título: ${listing.title}, Preço: R$${listing.price}, Fotos: ${listing.pictures?.length ?? 0}, Frete grátis: ${listing.shipping?.free_shipping ? "Sim" : "Não"}, Descrição: "${listing.description?.plain_text ?? "(vazia)"}", Atributos: ${listing.attributes?.map(a => `${a.name}: ${a.value_name}`).join(", ") || "nenhum"}, Condição: ${listing.condition ?? "não informada"}, Vendidos: ${listing.sold_quantity ?? 0}`;
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
    body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 1000, messages: [{ role: "user", content: prompt }] }),
  });
  const data = await response.json();
  const text = data.content?.map(b => b.text || "").join("") ?? "";
  const clean = text.replace(/```json|```/g, "").trim();
  return JSON.parse(clean);
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
    const batchDetails = await Promise.all(batch.map(id => fetch(ML(`/items/${id}`), { headers: { Authorization: `Bearer ${tk}` } }).then(r => r.json())));
    details.push(...batchDetails);
  }
  return details.filter(d => d.id);
}

async function fetchAllOrders(userId, tk) {
  const pageSize = 50; let offset = 0; let allOrders = [];
  while (true) {
    const res = await fetch(ML(`/orders/search?seller=${userId}&sort=date_desc&limit=${pageSize}&offset=${offset}`), { headers: { Authorization: `Bearer ${tk}` } });
    const data = await res.json();
    const orders = data.results ?? [];
    allOrders = [...allOrders, ...orders];
    if (orders.length < pageSize) break;
    offset += pageSize;
  }
  return allOrders;
}

// ─── COMPONENTS ───────────────────────────────────────────────────────────────

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
    setState("loading");
    setErrorMsg("");
    try {
      const r = await analyzeWithAI(listing);
      setResult(r);
      setState("done");
    } catch (e) {
      setErrorMsg(e.message);
      setState("error");
    }
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,.6)", backdropFilter: "blur(4px)", display: "flex", alignItems: "flex-end", justifyContent: "center", zIndex: 300 }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ background: "#fff", borderRadius: "20px 20px 0 0", width: "100%", maxWidth: 760, maxHeight: "88vh", overflowY: "auto", padding: "28px 32px 40px", boxShadow: "0 -4px 40px rgba(0,0,0,.12)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20 }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 18, color: "#0f172a", marginBottom: 4 }}>Qualidade do Anúncio</div>
            <div style={{ color: "#64748b", fontSize: 13, maxWidth: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{listing.title}</div>
          </div>
          <button onClick={onClose} style={{ background: "#f1f5f9", border: "none", color: "#64748b", width: 32, height: 32, borderRadius: 8, cursor: "pointer", fontSize: 16, display: "flex", alignItems: "center", justifyContent: "center" }}>✕</button>
        </div>

        {/* Score */}
        <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 12, padding: "16px 20px", marginBottom: 20 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 14 }}>
            <div style={{ width: 52, height: 52, borderRadius: 12, background: scoreBg(score), display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column" }}>
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

        {state === "idle" && (
          <div style={{ textAlign: "center", padding: "28px 0" }}>
            <div style={{ color: "#94a3b8", fontSize: 13, marginBottom: 16 }}>Analise com IA para receber sugestões personalizadas de melhoria</div>
            <button onClick={runAnalysis} style={{ background: "#0f172a", border: "none", color: "#fff", fontWeight: 700, padding: "11px 32px", borderRadius: 10, cursor: "pointer", fontSize: 14 }}>✦ Analisar com IA</button>
          </div>
        )}

        {state === "loading" && (
          <div style={{ textAlign: "center", padding: "32px 0", color: "#94a3b8" }}>
            <div style={{ fontSize: 28, marginBottom: 12, animation: "spin 1.2s linear infinite", display: "inline-block" }}>⟳</div>
            <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
            <div style={{ fontSize: 13 }}>Analisando seu anúncio...</div>
          </div>
        )}

        {state === "error" && (
          <div style={{ textAlign: "center", padding: "24px 0" }}>
            <div style={{ color: "#dc2626", fontSize: 13, marginBottom: 12 }}>Erro: {errorMsg || "Não foi possível analisar."}</div>
            <button onClick={runAnalysis} style={{ background: "#f1f5f9", border: "1px solid #e2e8f0", color: "#374151", padding: "8px 20px", borderRadius: 8, cursor: "pointer", fontSize: 13 }}>Tentar novamente</button>
          </div>
        )}

        {state === "done" && result && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 10, padding: "14px 18px" }}>
              <div style={{ fontSize: 11, color: "#92400e", marginBottom: 6, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Avaliação Geral</div>
              <div style={{ fontSize: 14, color: "#1c1917", lineHeight: 1.6 }}>{result.score_commentary}</div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              {result.strengths?.length > 0 && (
                <div style={{ background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 10, padding: "14px 18px" }}>
                  <div style={{ fontSize: 11, color: "#15803d", marginBottom: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>✓ Pontos Fortes</div>
                  {result.strengths.map((s, i) => <div key={i} style={{ fontSize: 13, color: "#166534", marginBottom: 6, paddingLeft: 10, borderLeft: "2px solid #86efac" }}>{s}</div>)}
                </div>
              )}
              {result.keywords?.length > 0 && (
                <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 10, padding: "14px 18px" }}>
                  <div style={{ fontSize: 11, color: "#475569", marginBottom: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Palavras-chave</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {result.keywords.map((k, i) => <span key={i} style={{ background: "#e2e8f0", color: "#334155", fontSize: 12, padding: "3px 10px", borderRadius: 20 }}>{k}</span>)}
                  </div>
                </div>
              )}
            </div>

            {result.improvements?.length > 0 && (
              <div style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 10, padding: "14px 18px" }}>
                <div style={{ fontSize: 11, color: "#d97706", marginBottom: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>⚡ O que Melhorar</div>
                {result.improvements.map((imp, i) => (
                  <div key={i} style={{ display: "flex", gap: 12, marginBottom: 12, paddingBottom: 12, borderBottom: i < result.improvements.length - 1 ? "1px solid #f1f5f9" : "none" }}>
                    <div style={{ minWidth: 26, height: 26, borderRadius: 7, background: "#fffbeb", border: "1px solid #fde68a", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: "#d97706", fontWeight: 700 }}>{i + 1}</div>
                    <div>
                      <div style={{ fontSize: 12, color: "#d97706", marginBottom: 3, fontWeight: 600 }}>{imp.field}</div>
                      <div style={{ fontSize: 13, color: "#475569", lineHeight: 1.5 }}>{imp.suggestion}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {result.title_suggestion && (
              <div style={{ background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 10, padding: "14px 18px" }}>
                <div style={{ fontSize: 11, color: "#15803d", marginBottom: 8, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>✦ Sugestão de Título</div>
                <div style={{ fontSize: 14, color: "#0f172a", fontWeight: 600 }}>{result.title_suggestion}</div>
                <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 4 }}>{result.title_suggestion.length} caracteres</div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function TokenModal({ onConnect }) {
  const [tokenInput, setTokenInput] = useState("");
  const [loading, setLoading] = useState(false);
  async function handleSubmit() {
    const tk = tokenInput.trim();
    if (!tk) return;
    setLoading(true);
    onConnect(tk, { nickname: "Minha Conta ML", id: null });
    setLoading(false);
  }
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,.6)", backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 300, padding: 24 }}>
      <div style={{ background: "#fff", borderRadius: 16, width: "100%", maxWidth: 480, padding: "32px 36px", boxShadow: "0 20px 60px rgba(0,0,0,.15)" }}>
        <div style={{ fontWeight: 800, fontSize: 20, color: "#0f172a", marginBottom: 6 }}>Conectar Mercado Livre</div>
        <p style={{ color: "#64748b", fontSize: 13, lineHeight: 1.7, marginBottom: 24 }}>Cole o token gerado via Terminal para conectar sua conta.</p>
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 11, color: "#94a3b8", marginBottom: 8, fontWeight: 600, letterSpacing: 1, textTransform: "uppercase" }}>Token de acesso</div>
          <textarea value={tokenInput} onChange={e => setTokenInput(e.target.value)} placeholder="APP_USR-..." rows={3}
            style={{ width: "100%", background: "#f8fafc", border: "1px solid #e2e8f0", color: "#0f172a", padding: "10px 14px", borderRadius: 10, fontFamily: "monospace", fontSize: 12, resize: "none", outline: "none" }} />
        </div>
        <button onClick={handleSubmit} disabled={loading || !tokenInput.trim()}
          style={{ width: "100%", background: loading ? "#f1f5f9" : "#0f172a", border: "none", color: loading ? "#94a3b8" : "#fff", fontWeight: 700, padding: "12px", borderRadius: 10, cursor: loading ? "not-allowed" : "pointer", fontSize: 14 }}>
          {loading ? "Conectando..." : "Conectar"}
        </button>
      </div>
    </div>
  );
}

export default function App() {
  const [tab, setTab] = useState("listings");
  const [costs, setCosts] = useState({});
  const [selectedListing, setSelectedListing] = useState(null);
  const [sortBy, setSortBy] = useState("score");
  const [orderFilter, setOrderFilter] = useState("all");
  const [searchListings, setSearchListings] = useState("");
  const [searchOrders, setSearchOrders] = useState("");
  const [token, setToken] = useState(null);
  const [user, setUser] = useState(null);
  const [realListings, setRealListings] = useState([]);
  const [realOrders, setRealOrders] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loadingMsg, setLoadingMsg] = useState("");
  const [showTokenModal, setShowTokenModal] = useState(false);
  const [loadError, setLoadError] = useState(null);

  const usingMock = !token || realListings.length === 0;

  async function handleConnect(tk, userData) {
    setToken(tk); setUser(userData); setShowTokenModal(false);
    setLoading(true); setLoadError(null);
    try {
      setLoadingMsg("Identificando conta...");
      const meRes = await fetch(ML("/users/me"), { headers: { Authorization: `Bearer ${tk}` } });
      const me = await meRes.json();
      if (!me.id) throw new Error("Token inválido");
      setUser({ nickname: me.nickname ?? "Minha Conta ML", id: me.id });
      setLoadingMsg("Buscando anúncios...");
      const listings = await fetchAllListings(me.id, tk);
      setRealListings(listings);
      setLoadingMsg("Buscando pedidos...");
      const orders = await fetchAllOrders(me.id, tk);
      setRealOrders(orders);
    } catch (e) { setLoadError(e.message); }
    setLoading(false); setLoadingMsg("");
  }

  const MOCK_LISTINGS = [
    { id: "MLB001", seller_sku: "SKU-001", title: "Fone Bluetooth Premium XZ900", price: 189.9, sold_quantity: 42, category: "electronics", status: "active", permalink: "https://www.mercadolivre.com.br", shipping: { free_shipping: true, logistic_type: "fulfillment" }, pictures: [{}], description: { plain_text: "Fone de ouvido bluetooth com cancelamento de ruído ativo." }, attributes: [{ id: "BRAND", name: "Marca", value_name: "XZ" }], condition: "new" },
    { id: "MLB002", seller_sku: "SKU-002", title: "Tênis Running Masculino Air Pro", price: 349.0, sold_quantity: 28, category: "fashion", status: "active", permalink: "https://www.mercadolivre.com.br", shipping: { free_shipping: false }, pictures: [{}, {}], description: { plain_text: "" }, attributes: [{ id: "BRAND", name: "Marca", value_name: "Air" }], condition: "new" },
    { id: "MLB003", seller_sku: null, title: "Kit Panelas Inox", price: 279.9, sold_quantity: 15, category: "home", status: "active", permalink: "https://www.mercadolivre.com.br", shipping: { free_shipping: false }, pictures: [], description: { plain_text: "Kit com panelas." }, attributes: [], condition: "new" },
    { id: "MLB004", seller_sku: "SKU-004", title: "Mochila Táctica 40L Impermeável Militar Reforçada", price: 159.9, sold_quantity: 67, category: "sports", status: "active", permalink: "https://www.mercadolivre.com.br", shipping: { free_shipping: true, logistic_type: "fulfillment" }, pictures: [{},{},{},{},{},{}], description: { plain_text: "Mochila tática impermeável 40L com vários compartimentos, material resistente, ideal para camping e trilha. Alças acolchoadas." }, attributes: [{ id: "BRAND", name: "Marca", value_name: "TacPro" },{ id: "COLOR", name: "Cor", value_name: "Preto" },{ id: "MATERIAL", name: "Material", value_name: "Nylon" },{ id: "VOLUME", name: "Volume", value_name: "40L" }], condition: "new" },
    { id: "MLB005", seller_sku: "SKU-005", title: "Smart Watch Fitness Pro Band", price: 219.9, sold_quantity: 33, category: "electronics", status: "paused", permalink: "https://www.mercadolivre.com.br", shipping: { free_shipping: true }, pictures: [{}], description: { plain_text: "Smartwatch com monitor cardíaco." }, attributes: [{ id: "BRAND", name: "Marca", value_name: "FitPro" }], condition: "new" },
  ];

  const MOCK_ORDERS = [
    { id: "2000001", listing_id: "MLB001", date: "2026-05-13", price: 189.9, qty: 2, shipping_cost: 0 },
    { id: "2000002", listing_id: "MLB002", date: "2026-05-13", price: 349.0, qty: 1, shipping_cost: 18.5 },
    { id: "2000003", listing_id: "MLB004", date: "2026-05-10", price: 159.9, qty: 3, shipping_cost: 0 },
    { id: "2000004", listing_id: "MLB003", date: "2026-05-08", price: 279.9, qty: 1, shipping_cost: 22.0 },
    { id: "2000005", listing_id: "MLB001", date: "2026-04-30", price: 189.9, qty: 1, shipping_cost: 0 },
    { id: "2000006", listing_id: "MLB005", date: "2026-04-15", price: 219.9, qty: 2, shipping_cost: 0 },
  ];

  const listings = usingMock ? MOCK_LISTINGS : realListings;
  const rawOrders = usingMock ? MOCK_ORDERS : realOrders.map(o => ({
    id: String(o.id),
    listing_id: o.order_items?.[0]?.item?.id,
    date: o.date_created?.slice(0, 10),
    price: o.total_amount ?? o.order_items?.[0]?.unit_price ?? 0,
    qty: o.order_items?.[0]?.quantity ?? 1,
    shipping_cost: o.shipping?.cost ?? 0,
  }));

  const enriched = listings.map(l => {
    const cost = costs[l.id] ?? 0;
    const margin = calcMargin(l.price, cost, l.category, 0);
    const { score, checks } = calcQualityScore(l);
    return { ...l, ...margin, cost, totalProfit: margin.profit * (l.sold_quantity ?? 0), score, checks };
  });

  // Busca anúncios
  const filteredListings = useMemo(() => {
    const q = searchListings.toLowerCase().trim();
    if (!q) return enriched;
    return enriched.filter(l =>
      l.title?.toLowerCase().includes(q) ||
      l.id?.toLowerCase().includes(q) ||
      l.seller_sku?.toLowerCase().includes(q)
    );
  }, [enriched, searchListings]);

  const sorted = [...filteredListings].sort((a, b) =>
    sortBy === "score" ? a.score - b.score :
    sortBy === "margin" ? (b.margin ?? -1) - (a.margin ?? -1) :
    b.totalProfit - a.totalProfit
  );

  // Filtro pedidos por período
  const periodOrders = useMemo(() => {
    if (orderFilter === "all") return rawOrders;
    const now = new Date(); const cutoff = new Date();
    if (orderFilter === "today") cutoff.setHours(0, 0, 0, 0);
    else if (orderFilter === "week") cutoff.setDate(now.getDate() - 7);
    else if (orderFilter === "month") cutoff.setMonth(now.getMonth() - 1);
    else if (orderFilter === "3months") cutoff.setMonth(now.getMonth() - 3);
    return rawOrders.filter(o => o.date && new Date(o.date) >= cutoff);
  }, [rawOrders, orderFilter]);

  // Busca pedidos
  const filteredOrders = useMemo(() => {
    const q = searchOrders.toLowerCase().trim();
    if (!q) return periodOrders;
    return periodOrders.filter(o => String(o.id).toLowerCase().includes(q));
  }, [periodOrders, searchOrders]);

  const enrichedOrders = filteredOrders.map(o => {
    const listing = listings.find(l => l.id === o.listing_id);
    const cost = costs[listing?.id] ?? 0;
    return { ...o, listing, ...calcMargin(o.price, cost, listing?.category, o.shipping_cost / Math.max(o.qty, 1)), cost };
  });

  const totalRevenue = enrichedOrders.reduce((s, o) => s + o.revenue * o.qty, 0);
  const totalProfit = enrichedOrders.reduce((s, o) => s + o.profit * o.qty, 0);
  const totalFees = enrichedOrders.reduce((s, o) => s + o.fee * o.qty, 0);
  const avgMargin = enrichedOrders.length > 0 ? enrichedOrders.reduce((s, o) => s + (o.margin ?? 0), 0) / enrichedOrders.length : 0;
  const avgScore = Math.round(enriched.reduce((s, l) => s + l.score, 0) / (enriched.length || 1));

  function getShippingInfo(l) {
    if (l.shipping?.free_shipping) {
      if (l.shipping?.logistic_type === "fulfillment") return { label: "Grátis · Full", color: "#15803d", bg: "#f0fdf4" };
      return { label: "Frete grátis", color: "#15803d", bg: "#f0fdf4" };
    }
    return { label: "Frete cobrado", color: "#d97706", bg: "#fffbeb" };
  }

  // Cores e estilos do tema claro
  const theme = {
    bg: "#f8fafc",
    surface: "#ffffff",
    border: "#e2e8f0",
    text: "#0f172a",
    muted: "#64748b",
    hint: "#94a3b8",
  };

  return (
    <div style={{ minHeight: "100vh", background: theme.bg, color: theme.text, fontFamily: "'Inter','Segoe UI',sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        ::-webkit-scrollbar{width:5px;height:5px}
        ::-webkit-scrollbar-track{background:#f1f5f9}
        ::-webkit-scrollbar-thumb{background:#cbd5e1;border-radius:99px}
        input:focus,textarea:focus,select:focus{outline:2px solid #0f172a;outline-offset:1px}
        table{border-collapse:collapse;width:100%}
        th{font-size:11px;color:#94a3b8;text-transform:uppercase;letter-spacing:0.8px;padding:10px 14px;border-bottom:1px solid #f1f5f9;text-align:left;font-weight:600;background:#fafafa}
        td{padding:11px 14px;font-size:13px;border-bottom:1px solid #f8fafc;vertical-align:middle;color:#334155}
        tr:last-child td{border-bottom:none}
        tr:hover td{background:#f8fafc}
        .tab-btn{background:transparent;border:none;color:#94a3b8;padding:8px 18px;cursor:pointer;font-family:inherit;font-size:13px;border-radius:8px;transition:all .15s;font-weight:500}
        .tab-btn.active{background:#fff;color:#0f172a;font-weight:700;box-shadow:0 1px 3px rgba(0,0,0,.08)}
        .filter-btn{background:#fff;border:1px solid #e2e8f0;color:#64748b;padding:5px 14px;cursor:pointer;font-family:inherit;font-size:12px;border-radius:20px;transition:all .15s;font-weight:500}
        .filter-btn.active{background:#0f172a;border-color:#0f172a;color:#fff;font-weight:600}
        .filter-btn:hover:not(.active){background:#f1f5f9}
        .search-input{width:100%;background:#fff;border:1px solid #e2e8f0;color:#0f172a;padding:8px 14px 8px 36px;border-radius:8px;font-family:inherit;font-size:13px;outline:none;transition:border .15s}
        .search-input:focus{border-color:#0f172a}
        .copy-btn{background:transparent;border:none;color:#cbd5e1;cursor:pointer;padding:2px 5px;border-radius:4px;font-size:11px;transition:all .15s}
        .copy-btn:hover{background:#f1f5f9;color:#475569}
        .title-link{color:#0f172a;text-decoration:none;font-weight:500;transition:color .15s}
        .title-link:hover{color:#2563eb;text-decoration:underline}
        @keyframes fadeUp{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
        .fade-up{animation:fadeUp .3s ease forwards}
        select{background:#fff;border:1px solid #e2e8f0;color:#334155;padding:6px 12px;border-radius:8px;font-family:inherit;font-size:12px;cursor:pointer;font-weight:500}
      `}</style>

      {/* Header */}
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
          <button onClick={() => setShowTokenModal(true)} style={{ background: "#0f172a", border: "none", color: "#fff", fontWeight: 700, padding: "8px 20px", borderRadius: 8, cursor: "pointer", fontSize: 13 }}>
            {token ? "Reconectar" : "Conectar ML"}
          </button>
        </div>
      </header>

      <main style={{ maxWidth: 1440, margin: "0 auto", padding: "24px 32px" }}>

        {/* KPI Cards */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 12, marginBottom: 24 }} className="fade-up">
          {[
            { label: "Receita líquida", value: fmt(totalRevenue), icon: "💰", color: "#0f172a" },
            { label: "Lucro estimado", value: fmt(totalProfit), icon: "📈", color: totalProfit >= 0 ? "#15803d" : "#dc2626" },
            { label: "Tarifas ML", value: fmt(totalFees), icon: "🏷️", color: "#d97706" },
            { label: "Margem média", value: fmtPct(avgMargin), icon: "📊", color: avgMargin >= .25 ? "#15803d" : avgMargin >= .15 ? "#d97706" : "#dc2626" },
            { label: "Score médio", value: `${avgScore}/100`, icon: "⭐", color: scoreColor(avgScore) },
            { label: "Total anúncios", value: enriched.length, icon: "📦", color: "#0f172a" },
            { label: "Pedidos período", value: enrichedOrders.length, icon: "🛒", color: "#0f172a" },
          ].map(k => (
            <div key={k.label} style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 12, padding: "16px 18px", boxShadow: "0 1px 2px rgba(0,0,0,.04)" }}>
              <div style={{ fontSize: 11, color: "#94a3b8", marginBottom: 8, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.8 }}>{k.label}</div>
              <div style={{ fontSize: 20, fontWeight: 800, color: k.color, letterSpacing: -0.5 }}>{k.value}</div>
            </div>
          ))}
        </div>

        {/* Tabs */}
        <div style={{ display: "flex", gap: 2, marginBottom: 20, background: "#f1f5f9", padding: 4, borderRadius: 10, width: "fit-content" }}>
          <button className={`tab-btn ${tab === "listings" ? "active" : ""}`} onClick={() => setTab("listings")}>Anúncios ({enriched.length})</button>
          <button className={`tab-btn ${tab === "orders" ? "active" : ""}`} onClick={() => setTab("orders")}>Pedidos ({enrichedOrders.length})</button>
        </div>

        {tab === "listings" && (
          <>
            {/* Toolbar */}
            <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 16, flexWrap: "wrap" }}>
              <div style={{ position: "relative", flex: 1, minWidth: 240 }}>
                <span style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", color: "#94a3b8", fontSize: 14 }}>🔍</span>
                <input className="search-input" value={searchListings} onChange={e => setSearchListings(e.target.value)}
                  placeholder="Buscar por título, MLB ou SKU..." />
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 12, color: "#94a3b8", fontWeight: 500 }}>Ordenar:</span>
                <select value={sortBy} onChange={e => setSortBy(e.target.value)}>
                  <option value="score">Pior score primeiro</option>
                  <option value="margin">Maior margem</option>
                  <option value="profit">Maior lucro total</option>
                </select>
              </div>
              {searchListings && <span style={{ fontSize: 12, color: "#94a3b8" }}>{sorted.length} resultado{sorted.length !== 1 ? "s" : ""}</span>}
            </div>

            <div style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 12, overflow: "auto", boxShadow: "0 1px 3px rgba(0,0,0,.04)" }}>
              <table>
                <thead>
                  <tr>
                    <th>Anúncio</th>
                    <th>MLB / SKU</th>
                    <th>Score</th>
                    <th>Preço</th>
                    <th>Frete</th>
                    <th>Custo (R$)</th>
                    <th>Tarifa ML</th>
                    <th>Lucro unit.</th>
                    <th>Margem</th>
                    <th>Lucro total</th>
                    <th>IA</th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.length === 0 ? (
                    <tr><td colSpan={11} style={{ textAlign: "center", color: "#94a3b8", padding: 40 }}>Nenhum anúncio encontrado</td></tr>
                  ) : sorted.map(l => {
                    const ship = getShippingInfo(l);
                    return (
                      <tr key={l.id}>
                        <td style={{ maxWidth: 240 }}>
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
                            <button className="copy-btn" onClick={() => navigator.clipboard.writeText(l.id)} title="Copiar">⎘</button>
                          </div>
                          {l.seller_sku ? (
                            <div style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 2 }}>
                              <span style={{ fontSize: 10, color: "#94a3b8" }}>SKU:</span>
                              <span style={{ fontSize: 11, color: "#64748b", fontFamily: "monospace" }}>{l.seller_sku}</span>
                              <button className="copy-btn" onClick={() => navigator.clipboard.writeText(l.seller_sku)}>⎘</button>
                            </div>
                          ) : <div style={{ fontSize: 10, color: "#cbd5e1", marginTop: 2 }}>SKU: —</div>}
                        </td>
                        <td>
                          <div style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 10px", borderRadius: 8, background: scoreBg(l.score) }}>
                            <span style={{ fontSize: 13, fontWeight: 800, color: scoreColor(l.score) }}>{l.score}</span>
                            <span style={{ fontSize: 11, color: scoreColor(l.score), fontWeight: 600 }}>{scoreLabel(l.score)}</span>
                          </div>
                        </td>
                        <td style={{ fontWeight: 700, color: "#0f172a" }}>{fmt(l.price)}</td>
                        <td>
                          <span style={{ fontSize: 11, color: ship.color, background: ship.bg, padding: "3px 8px", borderRadius: 6, fontWeight: 600 }}>{ship.label}</span>
                        </td>
                        <td>
                          <input type="number" value={l.cost || ""} onChange={e => setCosts(c => ({ ...c, [l.id]: Number(e.target.value) }))} placeholder="0,00"
                            style={{ background: "#f8fafc", border: "1px solid #e2e8f0", color: "#0f172a", padding: "5px 8px", borderRadius: 6, width: 80, fontSize: 12, textAlign: "right" }} />
                        </td>
                        <td>
                          <span style={{ color: "#d97706", fontWeight: 600 }}>{fmt(l.fee)}</span>
                          <div style={{ fontSize: 10, color: "#94a3b8" }}>{fmtPct(l.feeRate)}</div>
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
            {/* Filtros pedidos */}
            <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 16, flexWrap: "wrap" }}>
              <div style={{ position: "relative", width: 260 }}>
                <span style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", color: "#94a3b8", fontSize: 14 }}>🔍</span>
                <input className="search-input" value={searchOrders} onChange={e => setSearchOrders(e.target.value)} placeholder="Buscar por nº do pedido..." />
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {[{ key: "today", label: "Hoje" }, { key: "week", label: "7 dias" }, { key: "month", label: "30 dias" }, { key: "3months", label: "3 meses" }, { key: "all", label: "Todos" }].map(f => (
                  <button key={f.key} className={`filter-btn ${orderFilter === f.key ? "active" : ""}`} onClick={() => setOrderFilter(f.key)}>{f.label}</button>
                ))}
              </div>
              <span style={{ fontSize: 12, color: "#94a3b8" }}>
                {enrichedOrders.length} pedido{enrichedOrders.length !== 1 ? "s" : ""} · {fmt(enrichedOrders.reduce((s, o) => s + o.price * o.qty, 0))}
              </span>
            </div>

            <div style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 12, overflow: "auto", boxShadow: "0 1px 3px rgba(0,0,0,.04)" }}>
              <table>
                <thead><tr><th>Pedido</th><th>Produto</th><th>Data</th><th>Preço</th><th>Qtd</th><th>Tarifa ML</th><th>Frete</th><th>Lucro unit.</th><th>Margem</th></tr></thead>
                <tbody>
                  {enrichedOrders.length === 0 ? (
                    <tr><td colSpan={9} style={{ textAlign: "center", color: "#94a3b8", padding: 40 }}>Nenhum pedido encontrado</td></tr>
                  ) : enrichedOrders.map(o => (
                    <tr key={o.id}>
                      <td style={{ color: "#94a3b8", fontSize: 12, fontFamily: "monospace", fontWeight: 600 }}>#{o.id}</td>
                      <td>
                        <div style={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {o.listing?.permalink ? (
                            <a href={o.listing.permalink} target="_blank" rel="noreferrer" className="title-link">{o.listing.title}</a>
                          ) : <span style={{ color: "#94a3b8" }}>{o.listing?.title ?? "—"}</span>}
                        </div>
                      </td>
                      <td style={{ color: "#64748b", fontSize: 12 }}>{o.date}</td>
                      <td style={{ fontWeight: 700, color: "#0f172a" }}>{fmt(o.price)}</td>
                      <td style={{ color: "#64748b" }}>×{o.qty}</td>
                      <td style={{ color: "#d97706", fontWeight: 600 }}>{fmt(o.fee)}</td>
                      <td style={{ color: "#64748b" }}>{o.shipping_cost > 0 ? fmt(o.shipping_cost) : <span style={{ color: "#15803d", fontWeight: 600 }}>Grátis</span>}</td>
                      <td style={{ color: o.profit >= 0 ? "#15803d" : "#dc2626", fontWeight: 700 }}>{o.cost > 0 ? fmt(o.profit) : "—"}</td>
                      <td style={{ minWidth: 130 }}><MarginBar value={o.margin} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </main>

      {showTokenModal && <TokenModal onConnect={handleConnect} />}
      {selectedListing && <AIPanel listing={selectedListing} onClose={() => setSelectedListing(null)} />}
    </div>
  );
}
