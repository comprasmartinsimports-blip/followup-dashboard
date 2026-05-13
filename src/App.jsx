import { useState } from "react";

const MOCK_LISTINGS = [
  {
    id: "MLB001", title: "Fone Bluetooth Premium XZ900", price: 189.9,
    sold_quantity: 42, category: "electronics", status: "active",
    pictures: [{ url: "https://placehold.co/400x400" }],
    description: { plain_text: "Fone de ouvido bluetooth com cancelamento de ruído." },
    attributes: [{ id: "BRAND", name: "Marca", value_name: "XZ" }],
    shipping: { free_shipping: true }, condition: "new",
  },
  {
    id: "MLB002", title: "Tênis Running Masculino Air Pro", price: 349.0,
    sold_quantity: 28, category: "fashion", status: "active",
    pictures: [{ url: "" }, { url: "" }],
    description: { plain_text: "" },
    attributes: [{ id: "BRAND", name: "Marca", value_name: "Air" }, { id: "SIZE", name: "Tamanho", value_name: "42" }],
    shipping: { free_shipping: false }, condition: "new",
  },
  {
    id: "MLB003", title: "Kit Panelas", price: 279.9,
    sold_quantity: 15, category: "home", status: "active",
    pictures: [],
    description: { plain_text: "Kit com panelas." },
    attributes: [],
    shipping: { free_shipping: false }, condition: "new",
  },
  {
    id: "MLB004", title: "Mochila Táctica 40L Impermeável Militar Reforçada", price: 159.9,
    sold_quantity: 67, category: "sports", status: "active",
    pictures: [{ url: "" }, { url: "" }, { url: "" }, { url: "" }, { url: "" }, { url: "" }],
    description: { plain_text: "Mochila tática impermeável 40L com vários compartimentos, material resistente, ideal para camping, trilha e uso diário. Alças acolchoadas e reguláveis. Disponível em preto e verde." },
    attributes: [
      { id: "BRAND", name: "Marca", value_name: "TacPro" },
      { id: "COLOR", name: "Cor", value_name: "Preto" },
      { id: "MATERIAL", name: "Material", value_name: "Nylon 600D" },
      { id: "VOLUME", name: "Volume", value_name: "40L" },
    ],
    shipping: { free_shipping: true }, condition: "new",
  },
  {
    id: "MLB005", title: "Smart Watch Fitness Pro Band", price: 219.9,
    sold_quantity: 33, category: "electronics", status: "paused",
    pictures: [{ url: "" }],
    description: { plain_text: "Smartwatch com monitor cardíaco." },
    attributes: [{ id: "BRAND", name: "Marca", value_name: "FitPro" }],
    shipping: { free_shipping: true }, condition: "new",
  },
];

const MOCK_ORDERS = [
  { id: "2000001", listing_id: "MLB001", date: "2026-05-12", price: 189.9, qty: 2, shipping_cost: 0 },
  { id: "2000002", listing_id: "MLB002", date: "2026-05-11", price: 349.0, qty: 1, shipping_cost: 18.5 },
  { id: "2000003", listing_id: "MLB004", date: "2026-05-11", price: 159.9, qty: 3, shipping_cost: 0 },
  { id: "2000004", listing_id: "MLB003", date: "2026-05-10", price: 279.9, qty: 1, shipping_cost: 22.0 },
  { id: "2000005", listing_id: "MLB001", date: "2026-05-09", price: 189.9, qty: 1, shipping_cost: 0 },
  { id: "2000006", listing_id: "MLB005", date: "2026-05-08", price: 219.9, qty: 2, shipping_cost: 0 },
];

const ML_FEES = { default: 0.16, electronics: 0.14, fashion: 0.16, home: 0.15, sports: 0.15 };

const fmt = (n) => `R$ ${Number(n).toFixed(2).replace(".", ",")}`;
const fmtPct = (n) => `${(n * 100).toFixed(1)}%`;

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

function scoreColor(s) {
  if (s >= 80) return "#00e5a0";
  if (s >= 50) return "#f5c542";
  return "#ff5b5b";
}

function scoreLabel(s) {
  if (s >= 80) return "Ótimo";
  if (s >= 50) return "Regular";
  return "Fraco";
}

async function analyzeWithAI(listing) {
  const prompt = `Você é um especialista em otimização de anúncios do Mercado Livre Brasil. 
Analise este anúncio e retorne SOMENTE um JSON válido (sem markdown, sem texto extra) com esta estrutura exata:
{
  "score_commentary": "Comentário geral em 1 frase sobre a qualidade atual",
  "strengths": ["ponto forte 1", "ponto forte 2"],
  "improvements": [
    {"field": "campo a melhorar", "suggestion": "sugestão específica e acionável"},
    {"field": "campo a melhorar", "suggestion": "sugestão específica e acionável"},
    {"field": "campo a melhorar", "suggestion": "sugestão específica e acionável"}
  ],
  "title_suggestion": "Sugestão de novo título otimizado com palavras-chave (máx 60 chars)",
  "keywords": ["palavra1", "palavra2", "palavra3", "palavra4", "palavra5"]
}

Dados do anúncio:
- Título: ${listing.title}
- Preço: R$ ${listing.price}
- Categoria: ${listing.category}
- Fotos: ${listing.pictures?.length ?? 0} foto(s)
- Frete grátis: ${listing.shipping?.free_shipping ? "Sim" : "Não"}
- Descrição: "${listing.description?.plain_text ?? "(vazia)"}"
- Atributos preenchidos: ${listing.attributes?.map(a => `${a.name}: ${a.value_name}`).join(", ") || "nenhum"}
- Condição: ${listing.condition ?? "não informada"}
- Quantidade vendida: ${listing.sold_quantity ?? 0}`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const data = await response.json();
  const text = data.content?.map(b => b.text || "").join("") ?? "";
  const clean = text.replace(/```json|```/g, "").trim();
  return JSON.parse(clean);
}

function ScoreRing({ score }) {
  const r = 22;
  const circ = 2 * Math.PI * r;
  const fill = (score / 100) * circ;
  const color = scoreColor(score);
  return (
    <svg width={56} height={56} style={{ transform: "rotate(-90deg)" }}>
      <circle cx={28} cy={28} r={r} fill="none" stroke="#1e2130" strokeWidth={5} />
      <circle cx={28} cy={28} r={r} fill="none" stroke={color} strokeWidth={5}
        strokeDasharray={`${fill} ${circ}`} strokeLinecap="round"
        style={{ transition: "stroke-dasharray 0.6s ease" }} />
      <text x={28} y={32} textAnchor="middle" fill={color}
        style={{ transform: "rotate(90deg) translate(0px,-56px)", fontSize: 13, fontWeight: 800, fontFamily: "monospace" }}>
        {score}
      </text>
    </svg>
  );
}

function MarginBar({ value }) {
  if (value === null) return <span style={{ color: "#444", fontSize: 12 }}>— insira custo</span>;
  const pct = Math.max(0, Math.min(1, value));
  const color = pct >= 0.25 ? "#00e5a0" : pct >= 0.15 ? "#f5c542" : "#ff5b5b";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <div style={{ flex: 1, height: 5, background: "#1e2130", borderRadius: 99, overflow: "hidden", minWidth: 60 }}>
        <div style={{ width: `${pct * 100}%`, height: "100%", background: color, borderRadius: 99, transition: "width .4s" }} />
      </div>
      <span style={{ fontSize: 12, fontWeight: 700, color, minWidth: 38, textAlign: "right" }}>{fmtPct(pct)}</span>
    </div>
  );
}

function AIPanel({ listing, onClose }) {
  const [state, setState] = useState("idle");
  const [result, setResult] = useState(null);
  const { score, checks } = calcQualityScore(listing);

  async function runAnalysis() {
    setState("loading");
    try {
      const r = await analyzeWithAI(listing);
      setResult(r);
      setState("done");
    } catch (e) {
      setState("error");
    }
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.85)", display: "flex", alignItems: "flex-end", justifyContent: "center", zIndex: 300 }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ background: "#0a0c12", border: "1px solid #1e2130", borderRadius: "20px 20px 0 0", width: "100%", maxWidth: 720, maxHeight: "85vh", overflowY: "auto", padding: "28px 32px 40px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20 }}>
          <div>
            <div style={{ fontFamily: "'Syne',sans-serif", fontWeight: 900, fontSize: 18, marginBottom: 4 }}>Qualidade do Anúncio</div>
            <div style={{ color: "#666", fontSize: 13, maxWidth: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{listing.title}</div>
          </div>
          <button onClick={onClose} style={{ background: "#1e2130", border: "none", color: "#888", width: 32, height: 32, borderRadius: 8, cursor: "pointer", fontSize: 16 }}>✕</button>
        </div>
        <div style={{ display: "flex", gap: 16, alignItems: "center", background: "#0f1117", border: "1px solid #1e2130", borderRadius: 14, padding: "20px 24px", marginBottom: 20 }}>
          <ScoreRing score={score} />
          <div>
            <div style={{ fontWeight: 800, fontSize: 22, color: scoreColor(score), fontFamily: "'Syne',sans-serif" }}>{scoreLabel(score)}</div>
            <div style={{ color: "#666", fontSize: 13 }}>Score baseado nos critérios do ML</div>
          </div>
          <div style={{ marginLeft: "auto", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            {checks.map(c => (
              <div key={c.key} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
                <span style={{ color: c.pass ? "#00e5a0" : "#ff5b5b", fontSize: 14 }}>{c.pass ? "✓" : "✗"}</span>
                <span style={{ color: c.pass ? "#aaa" : "#666" }}>{c.label}</span>
              </div>
            ))}
          </div>
        </div>
        {state === "idle" && (
          <div style={{ textAlign: "center", padding: "24px 0" }}>
            <div style={{ color: "#555", fontSize: 13, marginBottom: 16 }}>Analise este anúncio com IA para receber sugestões personalizadas</div>
            <button onClick={runAnalysis} style={{ background: "linear-gradient(135deg,#ffe000,#ff9500)", border: "none", color: "#0f1117", fontWeight: 800, padding: "11px 28px", borderRadius: 10, cursor: "pointer", fontFamily: "inherit", fontSize: 14 }}>✦ Analisar com IA</button>
          </div>
        )}
        {state === "loading" && (
          <div style={{ textAlign: "center", padding: "32px 0", color: "#555" }}>
            <div style={{ fontSize: 28, marginBottom: 12, animation: "spin 1.5s linear infinite", display: "inline-block" }}>⟳</div>
            <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
            <div style={{ fontSize: 13 }}>Analisando seu anúncio com IA...</div>
          </div>
        )}
        {state === "error" && (
          <div style={{ textAlign: "center", padding: "24px 0", color: "#ff5b5b", fontSize: 13 }}>
            Erro ao conectar. Tente novamente.<br />
            <button onClick={runAnalysis} style={{ marginTop: 12, background: "#1e2130", border: "1px solid #2a3050", color: "#f0f0f0", padding: "8px 16px", borderRadius: 8, cursor: "pointer", fontFamily: "inherit" }}>Tentar novamente</button>
          </div>
        )}
        {state === "done" && result && (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={{ background: "#0f1117", border: "1px solid #2a3050", borderRadius: 12, padding: "16px 20px", borderLeft: "3px solid #ffe000" }}>
              <div style={{ fontSize: 12, color: "#ffe000", marginBottom: 6, letterSpacing: 1, textTransform: "uppercase" }}>Avaliação Geral</div>
              <div style={{ fontSize: 14, color: "#ccc", lineHeight: 1.6 }}>{result.score_commentary}</div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              {result.strengths?.length > 0 && (
                <div style={{ background: "#0f1117", border: "1px solid #1e2130", borderRadius: 12, padding: "16px 20px" }}>
                  <div style={{ fontSize: 12, color: "#00e5a0", marginBottom: 10, letterSpacing: 1, textTransform: "uppercase" }}>✓ Pontos Fortes</div>
                  {result.strengths.map((s, i) => <div key={i} style={{ fontSize: 13, color: "#aaa", marginBottom: 6, paddingLeft: 12, borderLeft: "2px solid #00e5a020" }}>{s}</div>)}
                </div>
              )}
              {result.keywords?.length > 0 && (
                <div style={{ background: "#0f1117", border: "1px solid #1e2130", borderRadius: 12, padding: "16px 20px" }}>
                  <div style={{ fontSize: 12, color: "#888", marginBottom: 10, letterSpacing: 1, textTransform: "uppercase" }}>Palavras-chave</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {result.keywords.map((k, i) => <span key={i} style={{ background: "#1e2130", color: "#ccc", fontSize: 12, padding: "4px 10px", borderRadius: 20 }}>{k}</span>)}
                  </div>
                </div>
              )}
            </div>
            {result.improvements?.length > 0 && (
              <div style={{ background: "#0f1117", border: "1px solid #1e2130", borderRadius: 12, padding: "16px 20px" }}>
                <div style={{ fontSize: 12, color: "#f5c542", marginBottom: 12, letterSpacing: 1, textTransform: "uppercase" }}>⚡ O que Melhorar</div>
                {result.improvements.map((imp, i) => (
                  <div key={i} style={{ display: "flex", gap: 12, marginBottom: 12, paddingBottom: 12, borderBottom: i < result.improvements.length - 1 ? "1px solid #1e2130" : "none" }}>
                    <div style={{ minWidth: 28, height: 28, borderRadius: 8, background: "#1e2130", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: "#f5c542", fontWeight: 800 }}>{i + 1}</div>
                    <div>
                      <div style={{ fontSize: 12, color: "#f5c542", marginBottom: 4, fontWeight: 600 }}>{imp.field}</div>
                      <div style={{ fontSize: 13, color: "#aaa", lineHeight: 1.5 }}>{imp.suggestion}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {result.title_suggestion && (
              <div style={{ background: "#0f1117", border: "1px solid #2a3050", borderRadius: 12, padding: "16px 20px", borderLeft: "3px solid #00e5a0" }}>
                <div style={{ fontSize: 12, color: "#00e5a0", marginBottom: 8, letterSpacing: 1, textTransform: "uppercase" }}>✦ Sugestão de Título</div>
                <div style={{ fontSize: 14, color: "#f0f0f0", fontWeight: 600 }}>{result.title_suggestion}</div>
                <div style={{ fontSize: 11, color: "#555", marginTop: 4 }}>{result.title_suggestion.length} caracteres</div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default function App() {
  const [tab, setTab] = useState("listings");
  const [costs, setCosts] = useState({});
  const [selectedListing, setSelectedListing] = useState(null);
  const [sortBy, setSortBy] = useState("score");
  const usingMock = true;

  const listings = MOCK_LISTINGS;
  const orders = MOCK_ORDERS;

  function handleConnect() {
    const appId = "6544342790807693";
    const redirectUri = window.location.href.split("?")[0].split("#")[0];
    const url = `https://auth.mercadolivre.com.br/authorization?response_type=token&client_id=${appId}&redirect_uri=${encodeURIComponent(redirectUri)}`;
    window.location.href = url;
  }

  const enriched = listings.map(l => {
    const cost = costs[l.id] ?? 0;
    const margin = calcMargin(l.price, cost, l.category, 0);
    const { score, checks } = calcQualityScore(l);
    const totalProfit = margin.profit * (l.sold_quantity ?? 0);
    return { ...l, ...margin, cost, totalProfit, score, checks };
  });

  const sorted = [...enriched].sort((a, b) => {
    if (sortBy === "score") return a.score - b.score;
    if (sortBy === "margin") return (b.margin ?? -1) - (a.margin ?? -1);
    if (sortBy === "profit") return b.totalProfit - a.totalProfit;
    return 0;
  });

  const enrichedOrders = orders.map(o => {
    const listing = listings.find(l => l.id === o.listing_id);
    const cost = costs[listing?.id] ?? 0;
    const m = calcMargin(o.price, cost, listing?.category, o.shipping_cost / o.qty);
    return { ...o, listing, ...m, cost };
  });

  const totalRevenue = enrichedOrders.reduce((s, o) => s + o.revenue * o.qty, 0);
  const totalProfit = enrichedOrders.reduce((s, o) => s + o.profit * o.qty, 0);
  const totalFees = enrichedOrders.reduce((s, o) => s + o.fee * o.qty, 0);
  const avgMargin = enrichedOrders.length > 0 ? enrichedOrders.reduce((s, o) => s + (o.margin ?? 0), 0) / enrichedOrders.length : 0;
  const avgScore = Math.round(enriched.reduce((s, l) => s + l.score, 0) / (enriched.length || 1));

  return (
    <div style={{ minHeight: "100vh", background: "#080a0f", color: "#f0f0f0", fontFamily: "'DM Mono','Courier New',monospace" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Mono:ital,wght@0,400;0,500;1,400&family=Syne:wght@700;800;900&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        ::-webkit-scrollbar { width: 5px; height: 5px; }
        ::-webkit-scrollbar-track { background: #080a0f; }
        ::-webkit-scrollbar-thumb { background: #2a3050; border-radius: 99px; }
        input[type=number]::-webkit-inner-spin-button { opacity: .4; }
        input:focus { outline: 2px solid #ffe000; outline-offset: 1px; }
        table { border-collapse: collapse; width: 100%; }
        th { font-size: 10px; color: #444; text-transform: uppercase; letter-spacing: 1.2px; padding: 10px 14px; border-bottom: 1px solid #13151d; text-align: left; font-weight: 500; }
        td { padding: 11px 14px; font-size: 12.5px; border-bottom: 1px solid #0d0f18; vertical-align: middle; }
        tr:last-child td { border-bottom: none; }
        tr:hover td { background: rgba(255,255,255,.015); }
        .tab-btn { background: transparent; border: none; color: #555; padding: 7px 16px; cursor: pointer; font-family: inherit; font-size: 12px; border-radius: 7px; transition: all .15s; }
        .tab-btn.active { background: #1a1d2a; color: #f0f0f0; }
        select { background: #0f1117; border: 1px solid #1e2130; color: #aaa; padding: 5px 10px; border-radius: 7px; font-family: inherit; font-size: 11px; cursor: pointer; }
        @keyframes fadeUp { from { opacity:0; transform:translateY(10px); } to { opacity:1; transform:translateY(0); } }
        .fade-up { animation: fadeUp .35s ease forwards; }
      `}</style>

      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 28px", background: "#080a0f", borderBottom: "1px solid #13151d", position: "sticky", top: 0, zIndex: 100 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 34, height: 34, borderRadius: 9, background: "linear-gradient(135deg,#ffe000,#ff9500)", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 900, fontSize: 17, color: "#0f1117" }}>M</div>
          <div>
            <div style={{ fontFamily: "'Syne',sans-serif", fontWeight: 900, fontSize: 14, color: "#f0f0f0", letterSpacing: -.3 }}>ML Margem</div>
            <div style={{ fontSize: 10, color: "#444", letterSpacing: .8 }}>DASHBOARD DE LUCRATIVIDADE</div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {usingMock && <span style={{ background: "#13151d", border: "1px solid #1e2130", color: "#555", fontSize: 10, padding: "3px 10px", borderRadius: 20 }}>📊 demonstração</span>}
          <button onClick={handleConnect} style={{ background: "linear-gradient(135deg,#ffe000,#ff9500)", border: "none", color: "#0f1117", fontWeight: 800, padding: "8px 18px", borderRadius: 8, cursor: "pointer", fontSize: 12, fontFamily: "inherit" }}>Conectar ML</button>
        </div>
      </header>

      <main style={{ maxWidth: 1200, margin: "0 auto", padding: "28px 24px" }}>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 24 }} className="fade-up">
          {[
            { label: "Receita líquida", value: fmt(totalRevenue), accent: null },
            { label: "Lucro estimado", value: fmt(totalProfit), accent: totalProfit >= 0 ? "#00e5a0" : "#ff5b5b" },
            { label: "Tarifas ML", value: fmt(totalFees), accent: "#f5c542" },
            { label: "Margem média", value: fmtPct(avgMargin), accent: avgMargin >= .25 ? "#00e5a0" : avgMargin >= .15 ? "#f5c542" : "#ff5b5b" },
            { label: "Score médio anúncios", value: `${avgScore}/100`, accent: scoreColor(avgScore) },
          ].map(k => (
            <div key={k.label} style={{ flex: 1, minWidth: 150, background: "#0a0c12", border: "1px solid #13151d", borderRadius: 12, padding: "16px 20px" }}>
              <div style={{ fontSize: 10, color: "#444", marginBottom: 6, letterSpacing: 1, textTransform: "uppercase" }}>{k.label}</div>
              <div style={{ fontSize: 22, fontWeight: 800, color: k.accent ?? "#f0f0f0", fontFamily: "'Syne',sans-serif", letterSpacing: -1 }}>{k.value}</div>
            </div>
          ))}
        </div>

        <div style={{ display: "flex", gap: 2, marginBottom: 18, background: "#0a0c12", padding: 3, borderRadius: 9, width: "fit-content", border: "1px solid #13151d" }}>
          <button className={`tab-btn ${tab === "listings" ? "active" : ""}`} onClick={() => setTab("listings")}>Anúncios</button>
          <button className={`tab-btn ${tab === "orders" ? "active" : ""}`} onClick={() => setTab("orders")}>Pedidos</button>
        </div>

        {tab === "listings" && (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
              <div style={{ fontSize: 11, color: "#444" }}>💡 Preencha o custo · Clique em <span style={{ color: "#ffe000" }}>✦ Analisar</span> para sugestões de IA</div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 11, color: "#444" }}>Ordenar por</span>
                <select value={sortBy} onChange={e => setSortBy(e.target.value)}>
                  <option value="score">Pior score primeiro</option>
                  <option value="margin">Maior margem</option>
                  <option value="profit">Maior lucro total</option>
                </select>
              </div>
            </div>
            <div style={{ background: "#0a0c12", border: "1px solid #13151d", borderRadius: 14, overflow: "auto" }}>
              <table>
                <thead>
                  <tr><th>Anúncio</th><th>Score ML</th><th>Preço</th><th>Custo (R$)</th><th>Tarifa ML</th><th>Lucro unit.</th><th>Margem</th><th>Lucro total</th><th>IA</th></tr>
                </thead>
                <tbody>
                  {sorted.map(l => (
                    <tr key={l.id}>
                      <td>
                        <div style={{ fontWeight: 500, maxWidth: 210, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "#ddd" }}>{l.title}</div>
                        <div style={{ display: "flex", gap: 6, marginTop: 4, flexWrap: "wrap" }}>
                          {l.checks.filter(c => !c.pass).slice(0, 2).map(c => (
                            <span key={c.key} style={{ fontSize: 10, color: "#ff5b5b", background: "#ff5b5b10", border: "1px solid #ff5b5b20", padding: "1px 7px", borderRadius: 20 }}>✗ {c.label}</span>
                          ))}
                          <span style={{ fontSize: 10, padding: "1px 7px", borderRadius: 20, background: l.status === "active" ? "#00e5a010" : "#1e2130", color: l.status === "active" ? "#00e5a0" : "#555", border: `1px solid ${l.status === "active" ? "#00e5a020" : "#2a3050"}` }}>
                            {l.status === "active" ? "● ativo" : "○ pausado"}
                          </span>
                        </div>
                      </td>
                      <td>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <div style={{ width: 36, height: 36, borderRadius: 8, border: `2px solid ${scoreColor(l.score)}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 800, color: scoreColor(l.score) }}>{l.score}</div>
                          <span style={{ fontSize: 11, color: scoreColor(l.score) }}>{scoreLabel(l.score)}</span>
                        </div>
                      </td>
                      <td style={{ fontWeight: 700, color: "#f0f0f0" }}>{fmt(l.price)}</td>
                      <td><input type="number" value={l.cost || ""} onChange={e => setCosts(c => ({ ...c, [l.id]: Number(e.target.value) }))} placeholder="0,00" style={{ background: "#0f1117", border: "1px solid #1e2130", color: "#f0f0f0", padding: "4px 8px", borderRadius: 6, width: 80, fontSize: 12, fontFamily: "inherit", textAlign: "right" }} /></td>
                      <td style={{ color: "#f5c542" }}>{fmt(l.fee)}<div style={{ fontSize: 10, color: "#555" }}>{fmtPct(l.feeRate)}</div></td>
                      <td style={{ color: l.profit >= 0 ? "#00e5a0" : "#ff5b5b", fontWeight: 700 }}>{fmt(l.profit)}</td>
                      <td style={{ minWidth: 130 }}><MarginBar value={l.margin} /></td>
                      <td style={{ color: l.totalProfit >= 0 ? "#00e5a0" : "#ff5b5b" }}>
                        {l.cost > 0 ? fmt(l.totalProfit) : "—"}
                        <div style={{ fontSize: 10, color: "#555" }}>{l.sold_quantity} vendidos</div>
                      </td>
                      <td><button onClick={() => setSelectedListing(l)} style={{ background: "linear-gradient(135deg,#ffe00022,#ff950022)", border: "1px solid #ffe00033", color: "#ffe000", fontSize: 11, padding: "5px 12px", borderRadius: 7, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }}>✦ Analisar</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {tab === "orders" && (
          <div style={{ background: "#0a0c12", border: "1px solid #13151d", borderRadius: 14, overflow: "auto" }}>
            <table>
              <thead>
                <tr><th>Pedido</th><th>Produto</th><th>Data</th><th>Preço</th><th>Qtd</th><th>Tarifa ML</th><th>Frete</th><th>Lucro unit.</th><th>Margem</th></tr>
              </thead>
              <tbody>
                {enrichedOrders.map(o => (
                  <tr key={o.id}>
                    <td style={{ color: "#444", fontSize: 11 }}>#{o.id}</td>
                    <td><div style={{ maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "#ccc" }}>{o.listing?.title ?? "—"}</div></td>
                    <td style={{ color: "#555", fontSize: 11 }}>{o.date}</td>
                    <td style={{ fontWeight: 700, color: "#f0f0f0" }}>{fmt(o.price)}</td>
                    <td style={{ color: "#666" }}>×{o.qty}</td>
                    <td style={{ color: "#f5c542" }}>{fmt(o.fee)}</td>
                    <td style={{ color: "#666" }}>{o.shipping_cost > 0 ? fmt(o.shipping_cost) : "Grátis"}</td>
                    <td style={{ color: o.profit >= 0 ? "#00e5a0" : "#ff5b5b", fontWeight: 700 }}>{o.cost > 0 ? fmt(o.profit) : "—"}</td>
                    <td style={{ minWidth: 130 }}><MarginBar value={o.margin} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>

      {selectedListing && <AIPanel listing={selectedListing} onClose={() => setSelectedListing(null)} />}
    </div>
  );
}
