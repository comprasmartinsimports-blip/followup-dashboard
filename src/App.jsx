import React, { useState, useMemo, useEffect, useRef, Children, cloneElement } from "react";

const ML = (path) => `/api/ml${path}`;
const fmt = (n) => `R$ ${Number(n).toFixed(2).replace(".", ",")}`;
const fmtPct = (n) => `${(n * 100).toFixed(1)}%`;

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

// ── Sincronização de dados de negócio entre TODOS os usuários (NF Entrada, Precificação) ──
// Usa a rota /api/ml/_sync (KV compartilhado) — o mesmo mecanismo já usado para compartilhar
// a lista de usuários e a conexão com o ML. Chamado tanto para "puxar" o que outros usuários
// salvaram quanto para "empurrar" uma mudança feita localmente.
// Conta do Mercado Livre atualmente conectada NESTE navegador. Os dados de negócio são
// sincronizados dentro do espaço dessa conta (ns) — assim contas diferentes do ML nunca
// misturam custos/produtos/precificação, mesmo que o login do sistema seja o mesmo.
function syncNamespace() {
  try { return localStorage.getItem("ml_connected_seller") || ""; } catch { return ""; }
}
async function kvSyncPull(key) {
  try {
    const res = await fetch("/api/ml/_sync?key=" + encodeURIComponent(key) + "&ns=" + encodeURIComponent(syncNamespace()));
    if (!res.ok) return null;
    const d = await res.json();
    var v = d && d.value !== undefined ? d.value : null;
    // Proteção: dados salvos antes da correção do formato do KV ficaram "embrulhados"
    // como {value: "..."} em vez do valor real — se detectar esse formato antigo, ignora
    // (equivale a "nada sincronizado ainda") em vez de aplicar um dado corrompido na tela.
    if (v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 1 && typeof v.value === "string") {
      return null;
    }
    return v;
  } catch { return null; }
}
async function kvSyncPush(key, value) {
  try {
    await fetch("/api/ml/_sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, value, ns: syncNamespace() }),
    });
  } catch {}
}

function getSku(listing) {
  if (listing.seller_sku) return listing.seller_sku;
  const skuAttr = listing.attributes?.find(a =>
    a.id === "SELLER_SKU" || a.id === "SKU" || a.name?.toLowerCase().includes("sku")
  );
  return skuAttr?.value_name ?? null;
}

function getRealFeeRate(listing) {
  if (listing.listing_type_id === "gold_premium" || listing.listing_type_id === "gold_pro") return 0.17;
  if (listing.listing_type_id === "gold_special" || listing.listing_type_id === "gold_extra") return 0.12;
  return 0.12;
}

// Taxa de venda da SHOPEE (Brasil, 2026) — comissão % + tarifa fixa por faixa de preço do item.
// CNPJ: até R$79,99 = 20%+R$4 | R$80–99,99 = 14%+R$16 | R$100–199,99 = 14%+R$20 | R$200+ = 14%+R$26.
// CPF: as mesmas faixas + R$3 por item. (O subsídio Pix é desconto ao comprador, não muda o repasse.)
function taxaShopeeFaixa(preco) {
  var p = parseFloat(preco) || 0;
  if (p <= 79.99) return { pct: 0.20, fixo: 4 };
  if (p <= 99.99) return { pct: 0.14, fixo: 16 };
  if (p <= 199.99) return { pct: 0.14, fixo: 20 };
  return { pct: 0.14, fixo: 26 };
}
function calcTaxaShopee(preco, doc) {
  var p = parseFloat(preco) || 0;
  if (p <= 0) return 0;
  var f = taxaShopeeFaixa(p);
  return p * f.pct + f.fixo + (doc === "CPF" ? 3 : 0);
}

function getListingTypeLabel(type) {
  // ML Brasil: gold_premium e gold_pro = Premium (17%)
  // gold_special, gold_extra, demais = Clássico (12%)
  if (type === "gold_premium" || type === "gold_pro") return { label: "Premium · 17%", color: "#7c3aed" };
  if (type === "gold_special" || type === "gold_extra") return { label: "Clássico · 12%", color: "#1976FF" };
  if (type === "silver") return { label: "Gratuito", color: "var(--text-3)" };
  if (type === "free") return { label: "Gratuito", color: "var(--text-3)" };
  return { label: type ? "Clássico" : "—", color: "#1976FF" };
}

function getPrices(listing) {
  var price = parseFloat(listing.price) || 0;
  var origPrice = parseFloat(listing.original_price) || 0;


  // Caso 1: preço de promoção buscado via /items/{id}/promotions
  if (listing._promo_price && listing._promo_price < price) {
    return { salePrice: listing._promo_price, originalPrice: listing._promo_original || price, hasPromo: true };
  }

  // Caso 2: original_price > price → price é o preço com desconto
  if (origPrice > 0 && origPrice > price) {
    return { salePrice: price, originalPrice: origPrice, hasPromo: true };
  }

  // Caso 2: sale_price no objeto (promoções do ML)
  if (listing.sale_price && listing.sale_price.amount) {
    var saleAmt = parseFloat(listing.sale_price.amount);
    if (saleAmt > 0 && saleAmt < price) {
      return { salePrice: saleAmt, originalPrice: price, hasPromo: true };
    }
  }

  // Caso 3: deals array (Central de Promoções ML)
  if (Array.isArray(listing.deals) && listing.deals.length > 0) {
    var deal = listing.deals[0];
    var dealPrice = parseFloat(deal.price || deal.deal_price || 0);
    if (dealPrice > 0 && dealPrice < price) {
      return { salePrice: dealPrice, originalPrice: price, hasPromo: true };
    }
  }

  // Caso 4: promotion_type indica que está em promoção mas preço já é o final
  // Neste caso price JÁ É o preço com desconto e original_price é o original
  if (listing.promotion_type && origPrice > 0) {
    return { salePrice: price, originalPrice: origPrice, hasPromo: true };
  }

  return { salePrice: price, originalPrice: price, hasPromo: false };
}

// ── Tarifa fixa do ML por unidade para itens abaixo de R$79 (Brasil) ──
// Usada como ESTIMATIVA apenas quando ainda não temos a tarifa real do anúncio
// (via /sites/MLB/listing_prices) nem a tarifa cobrada no pedido (sale_fee).
// Faixas vigentes em 2025/2026 — conferir a tabela oficial do ML se mudar:
function estimarTarifaFixaML(salePrice) {
  const p = parseFloat(salePrice) || 0;
  if (p <= 0 || p >= 79) return 0;
  if (p < 12.5) return p * 0.5;   // abaixo de R$12,50 o ML cobra metade do valor
  if (p < 29)   return 6.25;
  if (p < 50)   return 6.50;
  return 6.75;
}

// opts (opcional): { feeFixa: tarifa fixa em R$ a somar à comissão percentual,
//                    impostoPct: alíquota efetiva de impostos sobre a venda, em % }
function calcMargin(salePrice, cost, feeRate = 0.12, freteSeller = 0, opts = {}) {
  const feeFixa = parseFloat(opts.feeFixa) || 0;
  const impostoPct = parseFloat(opts.impostoPct) || 0;
  const mlFee = salePrice * feeRate + feeFixa;
  const imposto = salePrice * (impostoPct / 100);
  const revenue = salePrice - mlFee - freteSeller;
  const profit = revenue - imposto - cost;
  const margin = cost > 0 ? profit / salePrice : null;
  return { fee: mlFee, feeFixa, imposto, revenue, profit, margin, feeRate };
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

function scoreColor(s) { return s >= 80 ? "#0a9d4e" : s >= 50 ? "#FFC107" : "#FF5252"; }
function scoreBg(s) { return s >= 80 ? "rgba(0,200,83,.12)" : s >= 50 ? "rgba(255,193,7,.12)" : "rgba(255,82,82,.12)"; }
function scoreLabel(s) { return s >= 80 ? "Ótimo" : s >= 50 ? "Regular" : "Fraco"; }

async function analyzeWithAI(listing) {
  const prompt = `Você é especialista em anúncios do Mercado Livre Brasil. Analise o anúncio abaixo e, para CADA melhoria, entregue o CONTEÚDO JÁ PRONTO para o vendedor copiar e colar — não apenas dizer o que fazer.

Retorne APENAS um objeto JSON válido, sem texto extra, sem markdown, com esta estrutura:
{
 "score_commentary":"frase curta sobre a qualidade geral",
 "strengths":["ponto forte 1","ponto forte 2"],
 "improvements":[
   {"field":"Nome do campo (ex: Descrição, Título, Atributos, Fotos)","why":"por que melhorar, em 1 frase","ready":"CONTEÚDO PRONTO para colar — o texto/valor final já escrito. Se for algo não textual (ex: adicionar fotos), deixe \\"\\" e explique no why."}
 ],
 "title_suggestion":"novo título otimizado com até 60 caracteres, com as principais palavras-chave",
 "description_suggestion":"descrição COMPLETA e pronta para colar (use quebras de linha \\n), com: o que é o produto, compatibilidade/aplicação, material e características, medidas se fizer sentido, itens inclusos, instalação e garantia. Português comercial e persuasivo.",
 "keywords":["palavra1","palavra2","palavra3","palavra4","palavra5"]
}

Regras:
- Gere de 3 a 5 melhorias, sempre com "ready" preenchido quando for texto (Descrição, Título, Atributos).
- Para "Atributos", em "ready" liste no formato "Marca: X\\nModelo: Y\\nCor: Z" com valores plausíveis para este produto.
- Baseie tudo nos dados reais do anúncio abaixo.

Dados do anúncio:
- Título atual: ${listing.title}
- Preço: R$${listing.salePrice}
- Categoria: ${listing.category_id || "-"}
- Condição: ${listing.condition || "-"}
- Fotos: ${listing.pictures?.length ?? 0}
- Frete grátis: ${listing.shipping?.free_shipping ? "Sim" : "Não"}
- Descrição atual: ${(listing.description?.plain_text ?? "").slice(0, 400) || "vazia"}
- Atributos atuais: ${listing.attributes?.filter(a => a.value_name).slice(0, 12).map(a => a.name + ": " + a.value_name).join(", ") || "nenhum"}
- Vendidos: ${listing.sold_quantity ?? 0}

Retorne SOMENTE o JSON, começando com { e terminando com }.`;

  // A chamada à Anthropic passa pelo proxy /api/ai-chat — a chave da API fica só no servidor
  const response = await fetch("/api/ai-chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      max_tokens: 2500,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  const data = await response.json();
  if (data.error) throw new Error(data.error.message || data.error);
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
  // Busca o detalhe de um item com retry: o ML aplica rate limit e, em rajadas, devolve 429.
  // Sem retry, esses anúncios eram silenciosamente descartados (some do total e some dos filtros).
  async function fetchItemComRetry(id, tentativas) {
    for (var t = 0; t <= tentativas; t++) {
      try {
        var r = await fetch(ML("/items/" + id), { headers: { Authorization: "Bearer " + tk } });
        if (r.status === 429 || r.status === 503) {
          await new Promise(res => setTimeout(res, 400 * (t + 1)));
          continue;
        }
        var item = await r.json();
        if (item && item.id) return item;
      } catch (e) {}
      await new Promise(res => setTimeout(res, 300 * (t + 1)));
    }
    return null;
  }
  const details = [];
  // Lotes menores (10) com uma pausa curta entre eles: mantém o ritmo abaixo do limite do ML
  // e garante que TODOS os anúncios sejam carregados (essencial para os filtros por situação).
  for (let i = 0; i < allIds.length; i += 10) {
    const batch = allIds.slice(i, i + 10);
    const batchDetails = await Promise.all(batch.map(id => fetchItemComRetry(id, 2)));
    details.push(...batchDetails);
    if (i + 10 < allIds.length) await new Promise(res => setTimeout(res, 120));
  }
  return details.filter(d => d && d.id);
}

// Lê anúncios/pedidos do CACHE do servidor (Postgres via /api/ml/cache_*), paginado.
// Devolve { items, cache }: items na mesma shape das buscas ao ML; cache=false quando não há
// cache disponível (aí o chamador cai no fetch direto ao ML). Instantâneo vs. puxar tudo do ML.
async function carregarCachePaginado(rota) {
  var todos = [], offset = 0, limit = 400;
  try {
    while (true) {
      var res = await fetch(rota + "?limit=" + limit + "&offset=" + offset);
      if (!res.ok) return { items: null, cache: false };
      var d = await res.json();
      if (!d || d.cache === false) return { items: null, cache: false };
      todos = todos.concat(d.items || []);
      if (!d.hasMore) break;
      offset += limit;
      if (offset > 30000) break; // trava de segurança
    }
  } catch (e) { return { items: null, cache: false }; }
  return { items: todos, cache: true };
}
function carregarAnunciosDoCache() { return carregarCachePaginado("/api/ml/cache_listings"); }
function carregarPedidosDoCache() { return carregarCachePaginado("/api/ml/cache_orders"); }

// Tela "em construção" para as abas novas cuja funcionalidade ainda será desenvolvida.
const ABA_INFO = {
  dashboard:["📊","Dashboard","Visão geral do negócio: faturamento, lucro e margem por período."],
  produtos:["📦","Produtos","Catálogo de produtos com custo, SKU e vínculo aos anúncios."],
  vincular:["🔗","Vincular anúncios","Relacione cada anúncio ao produto do catálogo."],
  expedicao:["🚚","Expedição","Acompanhamento de envios e prazos."],
  compras:["🛒","Compras","Pedidos de compra e reposição de estoque."],
  estoque:["📦","Estoque","Saldo por depósito, baixa automática e estoque mínimo."],
  contas_pagar:["⬇️","Contas a pagar","Despesas, vencimentos e baixas."],
  contas_receber:["⬆️","Contas a receber","Recebíveis criados a partir do repasse dos marketplaces."],
  clientes:["👥","Clientes","Cadastro de clientes e histórico."],
  fornecedores:["🏭","Fornecedores","Cadastro de fornecedores e condições."],
  notas_fiscais:["📄","Notas fiscais","Emissão e gestão de NF-e a partir das vendas."],
  dre:["⚖️","DRE e conciliação","Demonstrativo de resultado e conciliação financeira."],
  relatorios:["📈","Relatórios","Relatórios e análises do negócio."],
  integracoes:["🔌","Integrações","Conexões com marketplaces, Bling, e outros sistemas."],
};
function EmConstrucao({ tab }) {
  var info = ABA_INFO[tab] || ["🚧", tab, ""];
  return (
    <div style={{ display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", minHeight:"62vh", textAlign:"center", padding:24 }}>
      <div style={{ fontSize:60, marginBottom:16, opacity:.9 }}>{info[0]}</div>
      <div style={{ fontSize:24, fontWeight:800, color:"var(--text-strong)", marginBottom:8, letterSpacing:-0.4 }}>{info[1]}</div>
      <div style={{ fontSize:14, color:"var(--text-3)", maxWidth:440, lineHeight:1.6 }}>{info[2]}</div>
      <div style={{ marginTop:18, fontSize:12, fontWeight:700, color:"#FFC107", background:"rgba(255,193,7,.12)", border:"1px solid rgba(255,193,7,.35)", borderRadius:20, padding:"5px 14px" }}>🚧 Em construção</div>
    </div>
  );
}

// Estilos compartilhados das telas de tabela (Produtos, Estoque).
const _kpiCard = { background:"var(--surface)", border:"1px solid var(--border)", borderRadius:12, padding:"14px 16px" };
const _kpiLbl = { fontSize:11, color:"var(--text-3)", textTransform:"uppercase", letterSpacing:.5, fontWeight:600 };
const _kpiVal = { fontSize:20, fontWeight:800, marginTop:5 };
const _inputBusca = { width:"100%", background:"var(--surface)", border:"1px solid var(--border)", color:"var(--text-strong)", padding:"10px 14px", borderRadius:10, fontSize:13, outline:"none", marginBottom:12, boxSizing:"border-box" };
const _tableWrap = { overflowX:"auto", border:"1px solid var(--border)", borderRadius:12, background:"var(--surface)" };
const _table = { borderCollapse:"collapse", width:"100%", fontSize:13, minWidth:640 };
const _th = { textAlign:"left", padding:"10px 12px", fontSize:11, textTransform:"uppercase", letterSpacing:.4, color:"var(--text-3)", fontWeight:600, borderBottom:"1px solid var(--border)", whiteSpace:"nowrap", background:"var(--surface-3)" };
const _td = { padding:"9px 12px", borderBottom:"1px solid var(--border-soft)", color:"var(--text-2)", verticalAlign:"middle" };
const _tdMono = { padding:"9px 12px", borderBottom:"1px solid var(--border-soft)", color:"var(--text-2)", fontFamily:"'JetBrains Mono',monospace", fontSize:12 };
function nomeProd(p){ return p.titulo || p.nome || "—"; }
function qtdAnuncios(p){ return (p.mlbsVinculados || []).length || (p.mlbVinculado ? 1 : 0); }

// Catálogo de produtos (a partir de produtos_cadastro) com custo, SKU, estoque e vínculo.
function ProdutosTab({ produtos }) {
  const [busca, setBusca] = useState("");
  const lista = (produtos || []).filter(function(p){
    var q = busca.trim().toLowerCase();
    if (!q) return true;
    return nomeProd(p).toLowerCase().indexOf(q) >= 0 || (p.sku || "").toLowerCase().indexOf(q) >= 0;
  });
  const total = (produtos || []).length;
  const semCusto = (produtos || []).filter(function(p){ return !(parseFloat(p.precoCusto) > 0); }).length;
  const valorEstoque = (produtos || []).reduce(function(s,p){ return s + (parseFloat(p.precoCusto) || 0) * (parseInt(p.estoqueAtual) || 0); }, 0);
  const kpis = [
    { l:"Produtos", v:String(total), c:"var(--text-strong)" },
    { l:"Sem custo", v:String(semCusto), c: semCusto > 0 ? "#FFC107" : "var(--text-strong)" },
    { l:"Valor em estoque (custo)", v:fmt(valorEstoque), c:"var(--text-strong)" },
  ];
  return (
    <div style={{ padding:2 }}>
      <div style={{ fontWeight:800, fontSize:20, color:"var(--text-strong)" }}>Produtos</div>
      <div style={{ fontSize:13, color:"var(--text-3)", marginBottom:14 }}>Catálogo com custo, SKU, estoque e vínculo aos anúncios.</div>
      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(170px,1fr))", gap:12, marginBottom:14 }}>
        {kpis.map(function(k,i){ return <div key={i} style={_kpiCard}><div style={_kpiLbl}>{k.l}</div><div style={{ ..._kpiVal, color:k.c }}>{k.v}</div></div>; })}
      </div>
      <input value={busca} onChange={function(e){ setBusca(e.target.value); }} placeholder="Buscar por produto ou SKU..." style={_inputBusca} />
      <div style={_tableWrap}>
        <table style={_table}>
          <thead><tr>{["Foto","Produto","SKU","Custo","Preço venda","Estoque","Anúncios","Status"].map(function(h){ return <th key={h} style={_th}>{h}</th>; })}</tr></thead>
          <tbody>
            {lista.slice(0,400).map(function(p,i){
              var img = (p.imagens && p.imagens[0]) || null;
              var ativo = (p.status || "") === "Ativo";
              return <tr key={p.id || i}>
                <td style={_td}>{img ? <img src={img} alt="" style={{ width:36, height:36, borderRadius:6, objectFit:"cover" }} /> : <div style={{ width:36, height:36, borderRadius:6, background:"var(--surface-3)" }} />}</td>
                <td style={{ ..._td, maxWidth:300, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", color:"var(--text-strong)", fontWeight:500 }}>{nomeProd(p)}</td>
                <td style={_tdMono}>{p.sku || "—"}</td>
                <td style={_td}>{parseFloat(p.precoCusto) > 0 ? fmt(parseFloat(p.precoCusto)) : <span style={{ color:"#FFC107" }}>sem custo</span>}</td>
                <td style={_td}>{parseFloat(p.precoVenda) > 0 ? fmt(parseFloat(p.precoVenda)) : "—"}</td>
                <td style={_td}>{parseInt(p.estoqueAtual) || 0}</td>
                <td style={_td}>{qtdAnuncios(p)}</td>
                <td style={_td}><span style={{ fontSize:11, fontWeight:700, padding:"2px 8px", borderRadius:20, background: ativo ? "rgba(0,200,83,.14)" : "var(--surface-3)", color: ativo ? "#0a9d4e" : "var(--text-3)" }}>{p.status || "—"}</span></td>
              </tr>;
            })}
          </tbody>
        </table>
        {lista.length === 0 && <div style={{ padding:24, textAlign:"center", color:"var(--text-3)" }}>Nenhum produto encontrado.</div>}
      </div>
    </div>
  );
}

// Estoque: saldo atual x mínimo, com situação (OK/baixo/zerado) e filtro.
function EstoqueTab({ produtos }) {
  const [filtro, setFiltro] = useState("todos"); // todos | baixo | zerado
  function situacao(p){
    var atual = parseInt(p.estoqueAtual) || 0, min = parseInt(p.estoqueMinimo) || 0;
    if (atual <= 0) return "zerado";
    if (min > 0 && atual <= min) return "baixo";
    return "ok";
  }
  const todos = produtos || [];
  const lista = todos.filter(function(p){
    var s = situacao(p);
    if (filtro === "baixo") return s === "baixo";
    if (filtro === "zerado") return s === "zerado";
    return true;
  });
  const nZerado = todos.filter(function(p){ return situacao(p) === "zerado"; }).length;
  const nBaixo = todos.filter(function(p){ return situacao(p) === "baixo"; }).length;
  const itens = todos.reduce(function(s,p){ return s + (parseInt(p.estoqueAtual) || 0); }, 0);
  const valor = todos.reduce(function(s,p){ return s + (parseFloat(p.precoCusto) || 0) * (parseInt(p.estoqueAtual) || 0); }, 0);
  const kpis = [
    { l:"Itens em estoque", v:String(itens), c:"var(--text-strong)" },
    { l:"Abaixo do mínimo", v:String(nBaixo), c: nBaixo > 0 ? "#FFC107" : "var(--text-strong)" },
    { l:"Zerados", v:String(nZerado), c: nZerado > 0 ? "#FF5252" : "var(--text-strong)" },
    { l:"Valor do estoque (custo)", v:fmt(valor), c:"var(--text-strong)" },
  ];
  const badge = { ok:["#0a9d4e","rgba(0,200,83,.14)","OK"], baixo:["#FFC107","rgba(255,193,7,.14)","Baixo"], zerado:["#FF5252","rgba(255,82,82,.14)","Zerado"] };
  const filtros = [["todos","Todos"],["baixo","Abaixo do mínimo"],["zerado","Zerados"]];
  return (
    <div style={{ padding:2 }}>
      <div style={{ fontWeight:800, fontSize:20, color:"var(--text-strong)" }}>Estoque</div>
      <div style={{ fontSize:13, color:"var(--text-3)", marginBottom:14 }}>Saldo atual x mínimo, com alerta de reposição.</div>
      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(170px,1fr))", gap:12, marginBottom:14 }}>
        {kpis.map(function(k,i){ return <div key={i} style={_kpiCard}><div style={_kpiLbl}>{k.l}</div><div style={{ ..._kpiVal, color:k.c }}>{k.v}</div></div>; })}
      </div>
      <div style={{ display:"flex", gap:6, marginBottom:12 }}>
        {filtros.map(function(f){ var a = filtro === f[0]; return <button key={f[0]} onClick={function(){ setFiltro(f[0]); }} style={{ padding:"7px 14px", borderRadius:8, border:"1px solid var(--border)", cursor:"pointer", fontSize:12, fontWeight:600, background: a ? "#1976FF" : "var(--surface)", color: a ? "#fff" : "var(--text-3)" }}>{f[1]}</button>; })}
      </div>
      <div style={_tableWrap}>
        <table style={_table}>
          <thead><tr>{["Foto","Produto","SKU","Estoque","Mínimo","Situação","Anúncios"].map(function(h){ return <th key={h} style={_th}>{h}</th>; })}</tr></thead>
          <tbody>
            {lista.slice(0,400).map(function(p,i){
              var img = (p.imagens && p.imagens[0]) || null;
              var s = situacao(p); var b = badge[s];
              return <tr key={p.id || i}>
                <td style={_td}>{img ? <img src={img} alt="" style={{ width:36, height:36, borderRadius:6, objectFit:"cover" }} /> : <div style={{ width:36, height:36, borderRadius:6, background:"var(--surface-3)" }} />}</td>
                <td style={{ ..._td, maxWidth:300, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", color:"var(--text-strong)", fontWeight:500 }}>{nomeProd(p)}</td>
                <td style={_tdMono}>{p.sku || "—"}</td>
                <td style={{ ..._td, fontWeight:700, color: s === "zerado" ? "#FF5252" : "var(--text-strong)" }}>{parseInt(p.estoqueAtual) || 0}</td>
                <td style={_td}>{parseInt(p.estoqueMinimo) || 0}</td>
                <td style={_td}><span style={{ fontSize:11, fontWeight:700, padding:"2px 8px", borderRadius:20, background:b[1], color:b[0] }}>{b[2]}</span></td>
                <td style={_td}>{qtdAnuncios(p)}</td>
              </tr>;
            })}
          </tbody>
        </table>
        {lista.length === 0 && <div style={{ padding:24, textAlign:"center", color:"var(--text-3)" }}>Nenhum produto neste filtro.</div>}
      </div>
    </div>
  );
}

// Vincular anúncios: mostra cada anúncio e o produto do catálogo ao qual está vinculado (por SKU),
// destacando os que estão sem SKU / sem produto.
function VincularTab({ enriched, produtos }) {
  const [filtro, setFiltro] = useState("todos"); // todos | vinculados | sem_sku
  var mapaSku = {};
  (produtos || []).forEach(function(p){ if (p.sku) mapaSku[String(p.sku).toLowerCase()] = p; });
  var linhas = (enriched || []).map(function(l){
    var sku = l.seller_sku || l.sku || "";
    var prod = sku ? mapaSku[String(sku).toLowerCase()] : null;
    var sit = !sku ? "sem_sku" : (prod ? "vinculado" : "sem_produto");
    return { id:l.id, titulo:l.title, sku:sku, thumb:l.thumbnail, prod:prod, sit:sit };
  });
  var lista = linhas.filter(function(r){
    if (filtro === "sem_sku") return r.sit === "sem_sku";
    if (filtro === "vinculados") return r.sit === "vinculado";
    return true;
  });
  var nVinc = linhas.filter(function(r){ return r.sit === "vinculado"; }).length;
  var nSemSku = linhas.filter(function(r){ return r.sit === "sem_sku"; }).length;
  var kpis = [
    { l:"Anúncios", v:String(linhas.length), c:"var(--text-strong)" },
    { l:"Vinculados", v:String(nVinc), c:"#0a9d4e" },
    { l:"Sem SKU", v:String(nSemSku), c: nSemSku > 0 ? "#FFC107" : "var(--text-strong)" },
  ];
  var badge = { vinculado:["#0a9d4e","rgba(0,200,83,.14)","Vinculado"], sem_sku:["#FFC107","rgba(255,193,7,.14)","Sem SKU"], sem_produto:["#FF5252","rgba(255,82,82,.14)","Sem produto"] };
  var filtros = [["todos","Todos"],["vinculados","Vinculados"],["sem_sku","Sem SKU"]];
  return (
    <div style={{ padding:2 }}>
      <div style={{ fontWeight:800, fontSize:20, color:"var(--text-strong)" }}>Vincular anúncios</div>
      <div style={{ fontSize:13, color:"var(--text-3)", marginBottom:14 }}>Cada anúncio ligado ao produto do catálogo pelo SKU.</div>
      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(170px,1fr))", gap:12, marginBottom:14 }}>
        {kpis.map(function(k,i){ return <div key={i} style={_kpiCard}><div style={_kpiLbl}>{k.l}</div><div style={{ ..._kpiVal, color:k.c }}>{k.v}</div></div>; })}
      </div>
      <div style={{ display:"flex", gap:6, marginBottom:12 }}>
        {filtros.map(function(f){ var a = filtro === f[0]; return <button key={f[0]} onClick={function(){ setFiltro(f[0]); }} style={{ padding:"7px 14px", borderRadius:8, border:"1px solid var(--border)", cursor:"pointer", fontSize:12, fontWeight:600, background: a ? "#1976FF" : "var(--surface)", color: a ? "#fff" : "var(--text-3)" }}>{f[1]}</button>; })}
      </div>
      <div style={_tableWrap}>
        <table style={_table}>
          <thead><tr>{["Foto","Anúncio","MLB","SKU","Produto vinculado","Situação"].map(function(h){ return <th key={h} style={_th}>{h}</th>; })}</tr></thead>
          <tbody>
            {lista.slice(0,400).map(function(r,i){
              var b = badge[r.sit];
              return <tr key={r.id || i}>
                <td style={_td}>{r.thumb ? <img src={r.thumb} alt="" style={{ width:36, height:36, borderRadius:6, objectFit:"cover" }} /> : <div style={{ width:36, height:36, borderRadius:6, background:"var(--surface-3)" }} />}</td>
                <td style={{ ..._td, maxWidth:280, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", color:"var(--text-strong)" }}>{r.titulo || "—"}</td>
                <td style={_tdMono}>{r.id}</td>
                <td style={_tdMono}>{r.sku || "—"}</td>
                <td style={{ ..._td, maxWidth:240, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{r.prod ? nomeProd(r.prod) : "—"}</td>
                <td style={_td}><span style={{ fontSize:11, fontWeight:700, padding:"2px 8px", borderRadius:20, background:b[1], color:b[0] }}>{b[2]}</span></td>
              </tr>;
            })}
          </tbody>
        </table>
        {lista.length === 0 && <div style={{ padding:24, textAlign:"center", color:"var(--text-3)" }}>Nenhum anúncio neste filtro.</div>}
      </div>
    </div>
  );
}

// Relatórios: faturamento, lucro e margem por MÊS (a partir dos pedidos sincronizados).
function RelatoriosTab({ enrichedOrders }) {
  var porMes = {};
  (enrichedOrders || []).filter(function(o){ return o.status !== "cancelled"; }).forEach(function(o){
    var mes = (o.date || "").slice(0, 7); if (!mes) return;
    var q = o.qty || 1;
    if (!porMes[mes]) porMes[mes] = { mes:mes, fat:0, lucro:0, ped:0 };
    porMes[mes].fat += (o.price || 0) * q; porMes[mes].lucro += (o.profit || 0) * q; porMes[mes].ped += 1;
  });
  var meses = Object.keys(porMes).sort().reverse().map(function(k){ return porMes[k]; });
  function rotulo(m){ return m.slice(5) + "/" + m.slice(0, 4); }
  return (
    <div style={{ padding:2 }}>
      <div style={{ fontWeight:800, fontSize:20, color:"var(--text-strong)" }}>Relatórios</div>
      <div style={{ fontSize:13, color:"var(--text-3)", marginBottom:14 }}>Faturamento, lucro e margem por mês.</div>
      <div style={_tableWrap}>
        <table style={_table}>
          <thead><tr>{["Mês","Pedidos","Faturamento","Lucro líquido","Margem"].map(function(h){ return <th key={h} style={_th}>{h}</th>; })}</tr></thead>
          <tbody>
            {meses.length === 0 ? (
              <tr><td style={_td} colSpan={5}>Sem vendas registradas.</td></tr>
            ) : meses.map(function(m,i){
              var mg = m.fat ? (m.lucro / m.fat * 100) : 0;
              return <tr key={i}>
                <td style={{ ..._td, fontWeight:600, color:"var(--text-strong)" }}>{rotulo(m.mes)}</td>
                <td style={_td}>{m.ped}</td>
                <td style={_td}>{fmt(m.fat)}</td>
                <td style={{ ..._td, fontWeight:700, color: m.lucro >= 0 ? "#0a9d4e" : "#FF5252" }}>{fmt(m.lucro)}</td>
                <td style={{ ..._td, color: mg >= 0 ? "#0a9d4e" : "#FF5252" }}>{mg.toFixed(1)}%</td>
              </tr>;
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Contas a receber: recebíveis gerados automaticamente dos pedidos do Mercado Livre.
function ContasReceberTab({ enrichedOrders, paymentData }) {
  const [busca, setBusca] = useState("");
  var linhas = (enrichedOrders || []).filter(function(o){ return o.status !== "cancelled"; }).map(function(o){
    var pay = paymentData && paymentData[String(o.id)];
    var valor = pay && pay.netAmount ? pay.netAmount : (o.price || 0) * (o.qty || 1);
    var previsao = pay && pay.releaseDate ? pay.releaseDate : (o.date || "");
    var recebido = pay ? !!pay.isReleased : false;
    return { id:o.id, cliente:o.buyerName || "Cliente ML", origem:"Mercado Livre", previsao:previsao, valor:valor, recebido:recebido };
  });
  var lista = linhas.filter(function(r){ var q = busca.trim().toLowerCase(); return !q || (r.cliente||"").toLowerCase().indexOf(q) >= 0 || String(r.id).indexOf(q) >= 0; });
  var aReceber = linhas.filter(function(r){ return !r.recebido; }).reduce(function(s,r){ return s + r.valor; }, 0);
  var recebido = linhas.filter(function(r){ return r.recebido; }).reduce(function(s,r){ return s + r.valor; }, 0);
  var kpis = [
    { l:"A receber", v:fmt(aReceber), c:"var(--text-strong)" },
    { l:"Recebido", v:fmt(recebido), c:"#0a9d4e" },
    { l:"Total", v:fmt(aReceber + recebido), c:"var(--text-strong)" },
  ];
  return (
    <div style={{ padding:2 }}>
      <div style={{ fontWeight:800, fontSize:20, color:"var(--text-strong)" }}>Contas a receber</div>
      <div style={{ fontSize:13, color:"var(--text-3)", marginBottom:14 }}>Recebíveis criados automaticamente dos pedidos do Mercado Livre.</div>
      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(170px,1fr))", gap:12, marginBottom:14 }}>
        {kpis.map(function(k,i){ return <div key={i} style={_kpiCard}><div style={_kpiLbl}>{k.l}</div><div style={{ ..._kpiVal, color:k.c }}>{k.v}</div></div>; })}
      </div>
      <input value={busca} onChange={function(e){ setBusca(e.target.value); }} placeholder="Buscar por cliente ou pedido..." style={_inputBusca} />
      <div style={_tableWrap}>
        <table style={_table}>
          <thead><tr>{["Cliente","Origem","Previsão","Valor","Situação"].map(function(h){ return <th key={h} style={_th}>{h}</th>; })}</tr></thead>
          <tbody>
            {lista.slice(0,400).map(function(r,i){
              return <tr key={r.id || i}>
                <td style={{ ..._td, color:"var(--text-strong)" }}>{r.cliente}</td>
                <td style={_td}>{r.origem}</td>
                <td style={_td}>{r.previsao || "—"}</td>
                <td style={{ ..._td, fontWeight:700 }}>{fmt(r.valor)}</td>
                <td style={_td}><span style={{ fontSize:11, fontWeight:700, padding:"2px 8px", borderRadius:20, background: r.recebido ? "rgba(0,200,83,.14)" : "rgba(255,193,7,.14)", color: r.recebido ? "#0a9d4e" : "#FFC107" }}>{r.recebido ? "Recebido" : "A receber"}</span></td>
              </tr>;
            })}
          </tbody>
        </table>
        {lista.length === 0 && <div style={{ padding:24, textAlign:"center", color:"var(--text-3)" }}>Nenhum recebível.</div>}
      </div>
    </div>
  );
}

// Clientes: cadastrados automaticamente dos compradores do Mercado Livre, com recorrência.
function ClientesTab({ rawOrders }) {
  const [filtro, setFiltro] = useState("todos"); // todos | recorrentes
  const [busca, setBusca] = useState("");
  var mapa = {};
  (rawOrders || []).filter(function(o){ return o.status !== "cancelled"; }).forEach(function(o){
    var chave = o.buyerDoc || o.buyerName || o.buyerEmail || o.id;
    if (!mapa[chave]) mapa[chave] = { nome:o.buyerName || "Cliente ML", doc:o.buyerDoc || "—", local:[o.buyerCity, o.buyerUF].filter(Boolean).join("/") || "—", pedidos:0, total:0, ultima:"" };
    var c = mapa[chave];
    c.pedidos += 1; c.total += (o.price || 0) * (o.qty || 1);
    if ((o.date || "") > c.ultima) c.ultima = o.date || "";
  });
  var todos = Object.keys(mapa).map(function(k){ var c = mapa[k]; c.recorrente = c.pedidos >= 2; return c; });
  var lista = todos.filter(function(c){
    if (filtro === "recorrentes" && !c.recorrente) return false;
    var q = busca.trim().toLowerCase();
    return !q || (c.nome || "").toLowerCase().indexOf(q) >= 0 || (c.doc || "").toLowerCase().indexOf(q) >= 0;
  }).sort(function(a,b){ return b.pedidos - a.pedidos; });
  var recorrentes = todos.filter(function(c){ return c.recorrente; }).length;
  var kpis = [
    { l:"Clientes", v:String(todos.length), c:"var(--text-strong)" },
    { l:"Recorrentes", v:String(recorrentes), c: recorrentes > 0 ? "#0a9d4e" : "var(--text-strong)" },
    { l:"Compra única", v:String(todos.length - recorrentes), c:"var(--text-strong)" },
  ];
  var filtros = [["todos","Todos"],["recorrentes","Recorrentes"]];
  return (
    <div style={{ padding:2 }}>
      <div style={{ fontWeight:800, fontSize:20, color:"var(--text-strong)" }}>Clientes</div>
      <div style={{ fontSize:13, color:"var(--text-3)", marginBottom:14 }}>Cadastrados automaticamente dos compradores do Mercado Livre.</div>
      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(170px,1fr))", gap:12, marginBottom:14 }}>
        {kpis.map(function(k,i){ return <div key={i} style={_kpiCard}><div style={_kpiLbl}>{k.l}</div><div style={{ ..._kpiVal, color:k.c }}>{k.v}</div></div>; })}
      </div>
      <div style={{ display:"flex", gap:6, marginBottom:10, flexWrap:"wrap" }}>
        {filtros.map(function(f){ var a = filtro === f[0]; return <button key={f[0]} onClick={function(){ setFiltro(f[0]); }} style={{ padding:"7px 14px", borderRadius:8, border:"1px solid var(--border)", cursor:"pointer", fontSize:12, fontWeight:600, background: a ? "#1976FF" : "var(--surface)", color: a ? "#fff" : "var(--text-3)" }}>{f[1]}</button>; })}
      </div>
      <input value={busca} onChange={function(e){ setBusca(e.target.value); }} placeholder="Buscar por nome ou documento..." style={_inputBusca} />
      <div style={_tableWrap}>
        <table style={_table}>
          <thead><tr>{["Cliente","Documento","Cidade/UF","Pedidos","Total gasto","Última compra","Perfil"].map(function(h){ return <th key={h} style={_th}>{h}</th>; })}</tr></thead>
          <tbody>
            {lista.slice(0,400).map(function(c,i){
              return <tr key={i}>
                <td style={{ ..._td, color:"var(--text-strong)", fontWeight:500 }}>{c.nome}</td>
                <td style={_tdMono}>{c.doc}</td>
                <td style={_td}>{c.local}</td>
                <td style={_td}>{c.pedidos}</td>
                <td style={{ ..._td, fontWeight:700 }}>{fmt(c.total)}</td>
                <td style={_td}>{c.ultima || "—"}</td>
                <td style={_td}><span style={{ fontSize:11, fontWeight:700, padding:"2px 8px", borderRadius:20, background: c.recorrente ? "rgba(0,200,83,.14)" : "var(--surface-3)", color: c.recorrente ? "#0a9d4e" : "var(--text-3)" }}>{c.recorrente ? "Recorrente" : "Único"}</span></td>
              </tr>;
            })}
          </tbody>
        </table>
        {lista.length === 0 && <div style={{ padding:24, textAlign:"center", color:"var(--text-3)" }}>Nenhum cliente.</div>}
      </div>
    </div>
  );
}

// Expedição: pedidos com o status de envio do ML (a enviar / enviado / entregue), com filtro.
function ExpedicaoTab({ rawOrders }) {
  const [filtro, setFiltro] = useState("todos");
  function categoria(st){
    if (!st) return "sem";
    if (st === "delivered") return "entregue";
    if (st === "shipped") return "enviado";
    if (st === "pending" || st === "handling" || st === "ready_to_ship") return "aenviar";
    return "problema";
  }
  var base = (rawOrders || []).filter(function(o){ return o.status !== "cancelled"; });
  var lista = base.filter(function(o){ return filtro === "todos" || categoria(o.shipment_status) === filtro; })
    .sort(function(a,b){ return (b.date || "").localeCompare(a.date || ""); });
  var cont = { aenviar:0, enviado:0, entregue:0 };
  base.forEach(function(o){ var c = categoria(o.shipment_status); if (cont[c] !== undefined) cont[c]++; });
  var kpis = [
    { l:"Pedidos", v:String(base.length), c:"var(--text-strong)" },
    { l:"A enviar", v:String(cont.aenviar), c: cont.aenviar > 0 ? "#FFC107" : "var(--text-strong)" },
    { l:"Enviados", v:String(cont.enviado), c:"#1976FF" },
    { l:"Entregues", v:String(cont.entregue), c:"#0a9d4e" },
  ];
  var badge = { aenviar:["#FFC107","rgba(255,193,7,.14)","A enviar"], enviado:["#1976FF","rgba(59,140,255,.14)","Enviado"], entregue:["#0a9d4e","rgba(0,200,83,.14)","Entregue"], problema:["#FF5252","rgba(255,82,82,.14)","Problema"], sem:["var(--text-3)","var(--surface-3)","—"] };
  var filtros = [["todos","Todos"],["aenviar","A enviar"],["enviado","Enviados"],["entregue","Entregues"]];
  return (
    <div style={{ padding:2 }}>
      <div style={{ fontWeight:800, fontSize:20, color:"var(--text-strong)" }}>Expedição</div>
      <div style={{ fontSize:13, color:"var(--text-3)", marginBottom:14 }}>Status de envio dos pedidos.</div>
      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(150px,1fr))", gap:12, marginBottom:14 }}>
        {kpis.map(function(k,i){ return <div key={i} style={_kpiCard}><div style={_kpiLbl}>{k.l}</div><div style={{ ..._kpiVal, color:k.c }}>{k.v}</div></div>; })}
      </div>
      <div style={{ display:"flex", gap:6, marginBottom:12, flexWrap:"wrap" }}>
        {filtros.map(function(f){ var a = filtro === f[0]; return <button key={f[0]} onClick={function(){ setFiltro(f[0]); }} style={{ padding:"7px 14px", borderRadius:8, border:"1px solid var(--border)", cursor:"pointer", fontSize:12, fontWeight:600, background: a ? "#1976FF" : "var(--surface)", color: a ? "#fff" : "var(--text-3)" }}>{f[1]}</button>; })}
      </div>
      <div style={_tableWrap}>
        <table style={_table}>
          <thead><tr>{["Data","Pedido","Produto","SKU","Qtd","UF","Frete","Envio"].map(function(h){ return <th key={h} style={_th}>{h}</th>; })}</tr></thead>
          <tbody>
            {lista.slice(0,400).map(function(o,i){
              var b = badge[categoria(o.shipment_status)];
              return <tr key={o.id || i}>
                <td style={_td}>{o.date || "—"}</td>
                <td style={_tdMono}>{o.id}</td>
                <td style={{ ..._td, maxWidth:260, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", color:"var(--text-strong)" }}>{o.title || "—"}</td>
                <td style={_tdMono}>{o.sku || "—"}</td>
                <td style={_td}>{o.qty || 1}</td>
                <td style={_td}>{o.buyerUF || "—"}</td>
                <td style={_td}>{o.seller_shipping_cost > 0 ? fmt(o.seller_shipping_cost) : "—"}</td>
                <td style={_td}><span style={{ fontSize:11, fontWeight:700, padding:"2px 8px", borderRadius:20, background:b[1], color:b[0] }}>{b[2]}</span></td>
              </tr>;
            })}
          </tbody>
        </table>
        {lista.length === 0 && <div style={{ padding:24, textAlign:"center", color:"var(--text-3)" }}>Nenhum pedido neste filtro.</div>}
      </div>
    </div>
  );
}

// Integrações: status das conexões do sistema.
function IntegracoesTab({ token, user, lastUpdate }) {
  var mins = lastUpdate ? Math.round((Date.now() - parseInt(lastUpdate)) / 60000) : null;
  var badgeStatus = { conectado:["#0a9d4e","rgba(0,200,83,.14)","● Conectado"], disponivel:["#1976FF","rgba(59,140,255,.14)","Disponível"], construcao:["#FFC107","rgba(255,193,7,.14)","🚧 Em construção"] };
  var cards = [
    { nome:"Mercado Livre", desc:"Anúncios, pedidos, taxas e repasses — sincronizados automaticamente.", status: token ? "conectado" : "disponivel", extra: token && user && user.nickname ? ("Conta: " + user.nickname + (mins != null ? " · última sync há " + mins + " min" : "")) : null },
    { nome:"Bling", desc:"ERP: produtos, custos, estoque e notas fiscais.", status:"disponivel", extra:null },
    { nome:"Amazon", desc:"Marketplace Amazon (anúncios e pedidos).", status:"construcao", extra:null },
    { nome:"Shopee", desc:"Marketplace Shopee (anúncios e pedidos).", status:"construcao", extra:null },
  ];
  return (
    <div style={{ padding:2 }}>
      <div style={{ fontWeight:800, fontSize:20, color:"var(--text-strong)" }}>Integrações</div>
      <div style={{ fontSize:13, color:"var(--text-3)", marginBottom:14 }}>Conexões do sistema com marketplaces e serviços.</div>
      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(280px,1fr))", gap:12 }}>
        {cards.map(function(c,i){
          return <div key={i} style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:12, padding:"16px 18px" }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:6 }}>
              <div style={{ fontWeight:700, fontSize:15, color:"var(--text-strong)" }}>{c.nome}</div>
              {(function(){ var b = badgeStatus[c.status]; return <span style={{ fontSize:11, fontWeight:700, padding:"3px 10px", borderRadius:20, background:b[1], color:b[0], whiteSpace:"nowrap" }}>{b[2]}</span>; })()}
            </div>
            <div style={{ fontSize:13, color:"var(--text-2)", lineHeight:1.5 }}>{c.desc}</div>
            {c.extra && <div style={{ fontSize:11, color:"var(--text-3)", marginTop:6 }}>{c.extra}</div>}
          </div>;
        })}
      </div>
    </div>
  );
}

// Telas financeiras: estrutura (KPIs + colunas) pronta, porém SEM dados por escolha do usuário
// (não conectadas a nenhuma fonte). Ficam prontas para receber dados/integração depois.
const TELAS_FIN = {
  compras:        { titulo:"Compras",           desc:"Pedidos de compra e reposição de estoque.",     kpis:[["Pedidos de compra","0"],["Em aberto","0"],["Recebidos","0"]],                 colunas:["Data","Fornecedor","Itens","Valor","Status"] },
  contas_pagar:   { titulo:"Contas a pagar",     desc:"Despesas, vencimentos e baixas.",               kpis:[["Total a pagar","R$ 0,00"],["Vencidas","R$ 0,00"],["A vencer","R$ 0,00"]],      colunas:["Vencimento","Descrição","Categoria","Valor","Status"] },
  fornecedores:   { titulo:"Fornecedores",       desc:"Cadastro de fornecedores e condições.",         kpis:[["Fornecedores","0"],["Ativos","0"]],                                          colunas:["Nome","Documento","Contato","Produtos"] },
};
function TelaEstruturada({ cfg }) {
  return (
    <div style={{ padding:2 }}>
      <div style={{ fontWeight:800, fontSize:20, color:"var(--text-strong)" }}>{cfg.titulo}</div>
      <div style={{ fontSize:13, color:"var(--text-3)", marginBottom:14 }}>{cfg.desc}</div>
      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(170px,1fr))", gap:12, marginBottom:14 }}>
        {cfg.kpis.map(function(k,i){ return <div key={i} style={_kpiCard}><div style={_kpiLbl}>{k[0]}</div><div style={{ ..._kpiVal, color:"var(--text-strong)" }}>{k[1]}</div></div>; })}
      </div>
      <div style={_tableWrap}>
        <table style={_table}>
          <thead><tr>{cfg.colunas.map(function(h){ return <th key={h} style={_th}>{h}</th>; })}</tr></thead>
          <tbody><tr><td style={{ ..._td, textAlign:"center", padding:"32px 12px", color:"var(--text-3)" }} colSpan={cfg.colunas.length}>Nenhum registro ainda.</td></tr></tbody>
        </table>
      </div>
      <div style={{ marginTop:12, fontSize:12, color:"var(--text-3)", background:"var(--surface)", border:"1px solid var(--border)", borderRadius:10, padding:"10px 14px" }}>
        🗂 Estrutura pronta. Ainda sem dados — esta área será conectada a uma fonte financeira depois.
      </div>
    </div>
  );
}
// DRE (Demonstrativo de Resultado): estrutura zerada, sem dados por enquanto.
function DreTab() {
  var linhas = [
    ["Receita bruta", "R$ 0,00", false],
    ["(-) Impostos e deduções", "R$ 0,00", false],
    ["= Receita líquida", "R$ 0,00", true],
    ["(-) Custo dos produtos (CMV)", "R$ 0,00", false],
    ["= Lucro bruto", "R$ 0,00", true],
    ["(-) Taxas dos marketplaces", "R$ 0,00", false],
    ["(-) Despesas e custos fixos", "R$ 0,00", false],
    ["= Lucro líquido", "R$ 0,00", true],
  ];
  return (
    <div style={{ padding:2 }}>
      <div style={{ fontWeight:800, fontSize:20, color:"var(--text-strong)" }}>DRE e conciliação</div>
      <div style={{ fontSize:13, color:"var(--text-3)", marginBottom:14 }}>Demonstrativo de resultado do período.</div>
      <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:12, padding:"8px 18px", maxWidth:520 }}>
        {linhas.map(function(l,i){
          return <div key={i} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"12px 0", borderBottom: i < linhas.length-1 ? "1px solid var(--border-soft)" : "none" }}>
            <span style={{ fontSize:14, fontWeight: l[2] ? 800 : 500, color: l[2] ? "var(--text-strong)" : "var(--text-2)" }}>{l[0]}</span>
            <span style={{ fontSize:14, fontWeight: l[2] ? 800 : 600, color: l[2] ? "var(--text-strong)" : "var(--text-3)", fontVariantNumeric:"tabular-nums" }}>{l[1]}</span>
          </div>;
        })}
      </div>
      <div style={{ marginTop:12, fontSize:12, color:"var(--text-3)", background:"var(--surface)", border:"1px solid var(--border)", borderRadius:10, padding:"10px 14px", maxWidth:520 }}>
        🗂 Estrutura pronta. Ainda sem dados — será conectada a uma fonte financeira depois.
      </div>
    </div>
  );
}

// Dashboard com os dados REAIS da empresa (a partir dos pedidos já sincronizados): faturamento,
// lucro líquido, margem, taxas, impostos, custo e top produtos — com filtro por período.
function DashboardTab({ enrichedOrders }) {
  const [periodo, setPeriodo] = useState("30"); // hoje | 7 | 30 | tudo
  const hojeStr = new Date().toISOString().slice(0, 10);
  var cutoff = "0000-00-00";
  if (periodo !== "tudo") {
    var d = new Date(); d.setDate(d.getDate() - (periodo === "hoje" ? 0 : parseInt(periodo, 10)));
    cutoff = d.toISOString().slice(0, 10);
  }
  var validos = (enrichedOrders || []).filter(function(o){
    if (o.status === "cancelled") return false;
    if (periodo === "hoje") return (o.date || "") === hojeStr;
    return (o.date || "") >= cutoff;
  });
  var fat = 0, taxas = 0, impostos = 0, custo = 0, lucro = 0, porProduto = {};
  validos.forEach(function(o){
    var q = o.qty || 1;
    var lucroPed = (o.profit || 0) * q;
    fat += (o.price || 0) * q; taxas += (o.fee || 0) * q; impostos += (o.imposto || 0) * q;
    custo += (o.cost || 0) * q; lucro += lucroPed;
    var k = o.listing_id || o.title || "?";
    if (!porProduto[k]) porProduto[k] = { titulo: o.title || k, lucro: 0, qtd: 0 };
    porProduto[k].lucro += lucroPed; porProduto[k].qtd += q;
  });
  var nPed = validos.length;
  var ticket = nPed ? fat / nPed : 0;
  var margem = fat ? (lucro / fat * 100) : 0;
  var top = Object.keys(porProduto).map(function(k){ return porProduto[k]; }).sort(function(a,b){ return b.lucro - a.lucro; }).slice(0, 8);
  var kpis = [
    { l:"Faturamento", v:fmt(fat), c:"var(--text-strong)" },
    { l:"Lucro líquido", v:fmt(lucro), c: lucro >= 0 ? "#0a9d4e" : "#FF5252" },
    { l:"Margem", v:margem.toFixed(1) + "%", c: margem >= 0 ? "#0a9d4e" : "#FF5252" },
    { l:"Pedidos", v:String(nPed), c:"var(--text-strong)" },
    { l:"Ticket médio", v:fmt(ticket), c:"var(--text-strong)" },
    { l:"Taxas do marketplace", v:"- " + fmt(taxas), c:"#FFC107" },
    { l:"Impostos", v:"- " + fmt(impostos), c:"#FFC107" },
    { l:"Custo dos produtos", v:"- " + fmt(custo), c:"#FFC107" },
  ];
  var periodos = [["hoje","Hoje"],["7","7 dias"],["30","30 dias"],["tudo","Tudo"]];
  return (
    <div style={{ padding:"2px" }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", flexWrap:"wrap", gap:10, marginBottom:16 }}>
        <div>
          <div style={{ fontWeight:800, fontSize:20, color:"var(--text-strong)" }}>Dashboard</div>
          <div style={{ fontSize:13, color:"var(--text-3)" }}>Faturamento, taxas, impostos e lucro real do período.</div>
        </div>
        <div style={{ display:"flex", gap:6 }}>
          {periodos.map(function(p){
            var ativo = periodo === p[0];
            return <button key={p[0]} onClick={function(){ setPeriodo(p[0]); }}
              style={{ padding:"7px 14px", borderRadius:8, border:"1px solid var(--border)", cursor:"pointer", fontSize:12, fontWeight:600,
                background: ativo ? "#1976FF" : "var(--surface)", color: ativo ? "#fff" : "var(--text-3)" }}>{p[1]}</button>;
          })}
        </div>
      </div>
      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit, minmax(180px, 1fr))", gap:12, marginBottom:20 }}>
        {kpis.map(function(k,i){
          return <div key={i} style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:12, padding:"16px 18px" }}>
            <div style={{ fontSize:11, color:"var(--text-3)", textTransform:"uppercase", letterSpacing:.5, fontWeight:600 }}>{k.l}</div>
            <div style={{ fontSize:22, fontWeight:800, color:k.c, marginTop:6 }}>{k.v}</div>
          </div>;
        })}
      </div>
      {(function(){
        var arr = Object.keys(porProduto).map(function(k){ return porProduto[k]; });
        var topP = arr.slice().sort(function(a,b){ return b.lucro - a.lucro; }).slice(0, 8);
        var piores = arr.slice().sort(function(a,b){ return a.lucro - b.lucro; }).slice(0, 8);
        var segs = [
          { l:"Custo produto", v:custo, cor:"#1976FF" },
          { l:"Taxas", v:taxas, cor:"#FFC107" },
          { l:"Impostos", v:impostos, cor:"#FF9800" },
          { l:"Lucro", v:Math.max(0, lucro), cor:"#0a9d4e" },
        ];
        var somaSeg = segs.reduce(function(s,x){ return s + x.v; }, 0) || 1;
        function listaProd(titulo, itens){
          return <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:12, padding:"16px 18px", flex:1, minWidth:280 }}>
            <div style={{ fontWeight:700, fontSize:15, color:"var(--text-strong)", marginBottom:12 }}>{titulo}</div>
            {itens.length === 0 ? <div style={{ color:"var(--text-3)", fontSize:13 }}>Sem vendas no período.</div> :
              itens.map(function(p,i){ return <div key={i} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"8px 0", borderBottom: i < itens.length-1 ? "1px solid var(--border-soft)" : "none" }}>
                <div style={{ minWidth:0, flex:1, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", fontSize:13, color:"var(--text-2)" }}>{p.titulo}</div>
                <span style={{ fontSize:13, fontWeight:700, color: p.lucro >= 0 ? "#0a9d4e" : "#FF5252", flexShrink:0, marginLeft:12 }}>{fmt(p.lucro)}</span>
              </div>; })}
          </div>;
        }
        return <>
          <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:12, padding:"16px 18px", marginBottom:14 }}>
            <div style={{ fontWeight:700, fontSize:15, color:"var(--text-strong)", marginBottom:12 }}>Para onde foi o dinheiro</div>
            <div style={{ display:"flex", height:16, borderRadius:8, overflow:"hidden", marginBottom:10, background:"var(--surface-3)" }}>
              {segs.map(function(s,i){ return <div key={i} title={s.l} style={{ width:(s.v/somaSeg*100)+"%", background:s.cor }} />; })}
            </div>
            <div style={{ display:"flex", flexWrap:"wrap", gap:16 }}>
              {segs.map(function(s,i){ return <div key={i} style={{ display:"flex", alignItems:"center", gap:6, fontSize:12, color:"var(--text-2)" }}>
                <span style={{ width:10, height:10, borderRadius:2, background:s.cor, display:"inline-block" }} /> {s.l}: <b style={{ color:"var(--text-strong)" }}>{fmt(s.v)}</b>
              </div>; })}
            </div>
          </div>
          <div style={{ display:"flex", gap:14, flexWrap:"wrap" }}>
            {listaProd("Top produtos por lucro", topP)}
            {listaProd("Piores resultados", piores)}
          </div>
        </>;
      })()}
    </div>
  );
}

// Importa/sincroniza anúncios ML para o cadastro de produtos
function syncListingsToProdutos(listings, produtosExistentes) {
  var hoje = new Date().toLocaleDateString("sv-SE");

  // ── PASSO 1: Agrupar anúncios por SKU ────────────────────────────────
  // Chave: SKU se disponível, senão MLB (produto sem SKU = produto único)
  var gruposPorSku = {}; // chave -> [listing, ...]
  listings.forEach(function(l) {
    var sku = l.seller_sku || l.attributes?.find(function(a){return a.id==="SELLER_SKU";})?.value_name || "";
    var chave = sku ? ("sku_" + sku) : ("mlb_" + l.id);
    if (!gruposPorSku[chave]) gruposPorSku[chave] = { sku: sku, listings: [] };
    gruposPorSku[chave].listings.push(l);
  });

  // ── PASSO 2: Mapear produtos existentes por SKU e MLB ─────────────────
  var mapSku = {}; // sku -> produto existente
  var mapMlb = {}; // mlb -> produto existente
  produtosExistentes.forEach(function(p) {
    if (p.sku) mapSku[p.sku] = p;
    if (p.mlbVinculado) mapMlb[p.mlbVinculado] = p;
    // mlbs extras (array de MLBs vinculados)
    if (Array.isArray(p.mlbsVinculados)) {
      p.mlbsVinculados.forEach(function(m){ mapMlb[m] = p; });
    }
  });

  // ── PASSO 3: Montar produtos agrupados ────────────────────────────────
  var resultado = [];
  var produtosProcessados = new Set();

  Object.keys(gruposPorSku).forEach(function(chave) {
    var grupo = gruposPorSku[chave];
    var ls = grupo.listings;
    var sku = grupo.sku;

    // Encontrar produto existente para esse SKU
    var existente = (sku && mapSku[sku]) || mapMlb[ls[0].id] || null;
    // Se tem mais de um MLB, verificar se algum já tem produto
    if (!existente && ls.length > 1) {
      for (var i = 0; i < ls.length; i++) {
        if (mapMlb[ls[i].id]) { existente = mapMlb[ls[i].id]; break; }
      }
    }

    if (existente && produtosProcessados.has(existente.id)) return; // já processou
    if (existente) produtosProcessados.add(existente.id);

    // Dados do primeiro anúncio ativo, ou o primeiro da lista
    var lPrincipal = ls.find(function(l){return l.status==="active";}) || ls[0];

    // Consolidar estoque: soma de todos
    var estoqueTotal = ls.reduce(function(s,l){ return s + (parseInt(l.available_quantity)||0); }, 0);

    // Coletar todos os MLBs
    var mlbsVinculados = ls.map(function(l){ return l.id; });

    // Coletar todas as imagens (sem duplicatas)
    var todasImagens = [];
    var imgSet = new Set();
    ls.forEach(function(l){
      (l.pictures||[]).slice(0,5).forEach(function(p){
        if (p.url && !imgSet.has(p.url)) { imgSet.add(p.url); todasImagens.push(p.url); }
      });
    });

    // Status: Ativo se qualquer anúncio ativo
    var temAtivo = ls.some(function(l){ return l.status==="active"; });
    var statusProd = temAtivo ? "Ativo" : "Inativo";

    // Preço de venda: do anúncio principal
    var precoVenda = String(lPrincipal.price || "");

    var dadosML = {
      titulo: lPrincipal.title || "",
      sku: sku,
      precoVenda: precoVenda,
      estoqueAtual: String(estoqueTotal),
      status: statusProd,
      imagens: todasImagens.slice(0, 10),
      mlbVinculado: lPrincipal.id,       // MLB principal (retrocompatibilidade)
      mlbsVinculados: mlbsVinculados,    // TODOS os MLBs desse SKU
      syncML: true,
      ultimoSyncML: hoje,
      categoria: "Outros",
    };

    if (existente) {
      resultado.push(Object.assign({}, existente, {
        titulo: dadosML.titulo,
        precoVenda: dadosML.precoVenda,
        estoqueAtual: dadosML.estoqueAtual,
        status: dadosML.status,
        sku: dadosML.sku || existente.sku,
        mlbVinculado: dadosML.mlbVinculado,
        mlbsVinculados: dadosML.mlbsVinculados,
        imagens: dadosML.imagens.length > 0 ? dadosML.imagens : existente.imagens,
        syncML: true,
        ultimoSyncML: hoje,
      }));
    } else {
      resultado.push(Object.assign({}, dadosML, {
        id: sku ? ("sku_prod_" + sku) : ("ml_" + lPrincipal.id),
        criadoViaML: true,
      }));
    }
  });

  // ── PASSO 4: Manter TODOS os produtos que não bateram com um anúncio desta busca ──
  // Importante: isso inclui produtos criados via ML cujo anúncio não veio nesta busca
  // específica (ex: erro de rede pontual, anúncio pausado, falha parcial na paginação).
  // Antes, produtos com "criadoViaML: true" eram APAGADOS do cadastro nesse caso — perdendo
  // estoque mínimo, custo e qualquer edição manual. Agora eles são sempre preservados; só
  // deixam de receber a atualização de preço/estoque do ML até aparecerem numa sincronização
  // futura. A exclusão de um produto deve ser sempre uma ação manual do usuário.
  produtosExistentes.forEach(function(p) {
    if (!produtosProcessados.has(p.id)) {
      resultado.push(p);
    }
  });

  return resultado;
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

// ── Busca a taxa REAL do ML para um anúncio, via /sites/MLB/listing_prices ──
// O valor real depende da categoria e do preço (produtos abaixo de ~R$79 pagam uma tarifa fixa
// adicional), então uma tabela fixa de 12%/17% por tipo de anúncio (Clássico/Premium) não reflete
// o que o ML realmente cobra. Este endpoint devolve o sale_fee_amount exato calculado pelo ML.
async function fetchRealFee(listing, tk) {
  const price = listing._promo_price || listing.price;
  const catId = listing.category_id;
  const listingType = listing.listing_type_id;
  if (!catId || !price || price <= 0) return null;
  const url = ML(`/sites/MLB/listing_prices?price=${price}&category_id=${catId}&listing_type_id=${listingType}`);
  // Retry em 429/503: sem isso, a taxa real de vários anúncios não carregava (caía na tabela).
  for (let t = 0; t <= 2; t++) {
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${tk}` } });
      if (res.status === 429 || res.status === 503) { await new Promise(r => setTimeout(r, 400 * (t + 1))); continue; }
      if (!res.ok) return null;
      const data = await res.json();
      // Com listing_type_id na query, o ML devolve um OBJETO (não um array). Aceitar os dois.
      const match = Array.isArray(data)
        ? (data.find(d => d.listing_type_id === listingType) || data[0])
        : data;
      if (!match || typeof match.sale_fee_amount !== "number") return null;
      return {
        feeAmount: match.sale_fee_amount,
        feeRate: price > 0 ? match.sale_fee_amount / price : 0,
        fixedFee: match.sale_fee_details?.fixed_fee ?? 0,
      };
    } catch { await new Promise(r => setTimeout(r, 300 * (t + 1))); }
  }
  return null;
}

// Busca em lote (5 por vez) para não estourar rate-limit do ML
async function fetchRealFeesForListings(listingsList, validTk, onBatch) {
  const feeMap = {};
  for (let i = 0; i < listingsList.length; i += 5) {
    const batch = listingsList.slice(i, i + 5);
    await Promise.all(batch.map(async l => {
      const r = await fetchRealFee(l, validTk);
      if (r) feeMap[l.id] = r;
    }));
    if (onBatch) onBatch(feeMap, Math.min(i + 5, listingsList.length), listingsList.length);
    await new Promise(r => setTimeout(r, 100));
  }
  return feeMap;
}

// ── Busca custo de frete + status de envio para uma lista de pedidos (em lotes de 5) ──
// Extraído para ser reutilizado tanto na carga completa (handleConnect) quanto na
// atualização automática incremental (refreshOrdersIncremental), evitando duplicar a lógica.
async function fetchShippingForOrders(ordersList, validTk, onBatch) {
  const shippingMap = {};
  const statusMap = {};
  const withShipping = ordersList.filter(o => o.shipping?.id);
  for (let i = 0; i < withShipping.length; i += 5) {
    const batch = withShipping.slice(i, i + 5);
    await Promise.all(batch.map(async o => {
      try {
        const [costsRes, shipRes] = await Promise.all([
          fetch(ML(`/shipments/${o.shipping.id}/costs`), { headers: { Authorization: `Bearer ${validTk}` } }),
          fetch(ML(`/shipments/${o.shipping.id}`), { headers: { Authorization: `Bearer ${validTk}` } })
        ]);
        const costsData = await costsRes.json();
        const shipData = await shipRes.json();
        var sender = costsData?.senders?.[0] || {};
        var save = parseFloat(sender.save ?? sender.cost ?? sender.list_cost ?? 0);
        var cost = parseFloat(sender.cost ?? sender.list_cost ?? 0);
        var buyerPaidShip = parseFloat(costsData?.receivers?.[0]?.cost ?? 0);
        var freteVendedor = 0;
        if (save > 0) freteVendedor = save;
        else if (cost > 0 && buyerPaidShip === 0) freteVendedor = cost;
        else if (cost > 0 && buyerPaidShip < cost) freteVendedor = cost - buyerPaidShip;
        if (freteVendedor === 0 && shipData?.base_cost > 0) freteVendedor = parseFloat(shipData.base_cost);
        shippingMap[String(o.id)] = freteVendedor;
        statusMap[String(o.id)] = shipData?.status ?? null;
        if (shipData?.logistic_type) statusMap[String(o.id) + "_logistic"] = shipData.logistic_type;
        if (shipData?.mode) statusMap[String(o.id) + "_mode"] = shipData.mode;
        if (shipData?.type) statusMap[String(o.id) + "_type"] = shipData.type;
        if (shipData?.service_id) statusMap[String(o.id) + "_service"] = String(shipData.service_id);
        if (shipData?.substatus) statusMap[String(o.id) + "_substatus"] = shipData.substatus;
      } catch { shippingMap[String(o.id)] = 0; }
    }));
    if (onBatch) onBatch(shippingMap, statusMap, Math.min(i + 5, withShipping.length), withShipping.length);
    await new Promise(r => setTimeout(r, 100));
  }
  return { shippingMap, statusMap };
}

// ── Busca dados de pagamento (valor líquido, data de liberação) para uma lista de pedidos pagos ──
async function fetchPaymentForOrders(ordersList, validTk, onBatch) {
  const paymentMap = {};
  const paidOrders = ordersList.filter(o => o.status === "paid");
  for (let i = 0; i < paidOrders.length; i += 5) {
    const batch = paidOrders.slice(i, i + 5);
    await Promise.all(batch.map(async o => {
      const oid = String(o.id);
      try {
        const res = await fetch(ML(`/orders/${o.id}`), { headers: { Authorization: `Bearer ${validTk}` } });
        const data = await res.json();
        if (data.error) return;
        var paymentId = null;
        if (Array.isArray(data.payments) && data.payments.length > 0) {
          var pmtRef = data.payments.find(function(p){ return p.status === "approved"; }) || data.payments[0];
          paymentId = pmtRef?.id || null;
        }
        var paymentDetail = null;
        if (paymentId) {
          try {
            var pmtRes = await fetch(ML(`/collections/${paymentId}`), { headers: { Authorization: `Bearer ${validTk}` } });
            var pmtData = await pmtRes.json();
            if (!pmtData.error && pmtData.collection) paymentDetail = pmtData.collection;
            else if (!pmtData.error) paymentDetail = pmtData;
          } catch {}
        }
        var bruto = parseFloat(data.total_amount || o.total_amount || 0);
        var saleFeeTotal = 0;
        if (Array.isArray(data.order_items)) {
          data.order_items.forEach(function(item) { saleFeeTotal += parseFloat(item.sale_fee || 0); });
        }
        var tarifaFinal = saleFeeTotal > 0 ? saleFeeTotal : parseFloat(data.marketplace_fee || 0);
        var netAmount = bruto > 0 && tarifaFinal > 0 ? bruto - tarifaFinal : 0;
        var freteCusto = 0;
        var tarifaML = tarifaFinal;
        if (Array.isArray(data.order_items)) {
          data.order_items.forEach(function(item) { freteCusto += parseFloat(item.shipping_cost || 0); });
          if (freteCusto > 0) tarifaML = tarifaFinal - freteCusto;
        }
        var releaseDate = null;
        var isReleased = false;
        var hoje2 = new Date().toLocaleDateString("sv-SE");
        if (paymentDetail) {
          var rdRaw = paymentDetail.money_release_date || paymentDetail.date_approved || null;
          var rdStatus = paymentDetail.money_release_status || paymentDetail.release_status || "";
          if (rdRaw) {
            releaseDate = rdRaw.slice(0, 10);
            isReleased = rdStatus === "released" || rdStatus === "released_for_seller" || releaseDate <= hoje2;
          }
        }
        if (!releaseDate && Array.isArray(data.payments) && data.payments.length > 0) {
          var pmt = data.payments.find(function(p){ return p.status === "approved"; }) || data.payments[0];
          if (pmt) {
            var rdRaw2 = pmt.money_release_date || null;
            var rdStatus2 = pmt.money_release_status || pmt.release_status || "";
            if (rdRaw2) {
              releaseDate = rdRaw2.slice(0, 10);
              isReleased = rdStatus2 === "released" || rdStatus2 === "released_for_seller" || releaseDate <= hoje2;
            }
          }
        }
        if (netAmount > 0 || releaseDate) {
          paymentMap[oid] = {
            releaseDate, isReleased,
            netAmount: netAmount > 0 ? netAmount : bruto * 0.87,
            bruto, tarifaML, freteCusto,
            isCalculated: saleFeeTotal <= 0,
          };
        }
      } catch {}
    }));
    if (onBatch) onBatch(paymentMap, Math.min(i + 5, paidOrders.length), paidOrders.length);
    await new Promise(r => setTimeout(r, 150));
  }
  return paymentMap;
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
    // Endpoint seller-promotions retorna array de promoções ativas
    const r1 = await fetch(`/api/ml/seller-promotions/items/${itemId}?app_version=v2`, {
      headers: { Authorization: `Bearer ${tk}` }
    });
    if (r1.ok) {
      const d1 = await r1.json();
      if (!d1.error) {
        // d1 é um array de promoções — pegar a que tem menor preço ativo
        const lista = Array.isArray(d1) ? d1 : (d1.results || [d1]);
        const ativas = lista.filter(function(p) {
          return p.status === "started" && parseFloat(p.price || 0) > 0;
        });
        if (ativas.length > 0) {
          // Menor preço entre todas as promoções ativas
          const melhor = ativas.reduce(function(min, p) {
            return parseFloat(p.price) < parseFloat(min.price) ? p : min;
          }, ativas[0]);
          const sale = parseFloat(melhor.price);
          const orig = parseFloat(melhor.original_price || 0);
          if (sale > 0 && orig > sale) return { salePrice: sale, originalPrice: orig };
          if (sale > 0) return { salePrice: sale, originalPrice: orig || sale };
        }
      }
    }

    // Tentar: /items/{id}/prices — retorna objeto com prices[]
    const r2 = await fetch(`/api/ml/items/${itemId}/prices`, {
      headers: { Authorization: `Bearer ${tk}` }
    });
    if (r2.ok) {
      const d2 = await r2.json();
      if (!d2.error) {
        const list = d2.prices || (Array.isArray(d2) ? d2 : []);
        const stdPrice = list.find(function(p){ return p.type === "standard" && parseFloat(p.amount||0) > 0; });
        // Pegar o menor amount entre todos (preço vencedor com promoção)
        const allWithAmt = list.filter(function(p){ return parseFloat(p.amount||0) > 0; });
        if (allWithAmt.length > 0) {
          const menor = allWithAmt.reduce(function(m, p){
            return parseFloat(p.amount) < parseFloat(m.amount) ? p : m;
          }, allWithAmt[0]);
          const sale = parseFloat(menor.amount);
          const orig = parseFloat((stdPrice || menor).amount);
          // regular_amount é o original riscado
          const reg  = parseFloat(menor.regular_amount || (stdPrice ? stdPrice.amount : 0) || 0);
          if (reg > sale) return { salePrice: sale, originalPrice: reg };
          if (orig > sale) return { salePrice: sale, originalPrice: orig };
        }
      }
    }

    // Tentar: /items/{id}/promotions
    const r3 = await fetch(`/api/ml/items/${itemId}/promotions`, {
      headers: { Authorization: `Bearer ${tk}` }
    });
    if (r3.ok) {
      const d3 = await r3.json();
      const list3 = Array.isArray(d3) ? d3 : (d3.results || []);
      const ativa = list3.find(function(p){ return p.status === "started"; });
      if (ativa) {
        const s = parseFloat(ativa.new_price || ativa.price || 0);
        const o = parseFloat(ativa.original_price || 0);
        if (s > 0 && o > s) return { salePrice: s, originalPrice: o };
      }
    }

    return null;
  } catch(e) { return null; }
}


function getOrderStatusInfo(status, tags, fulfilled, shipmentStatus) {
  const isMediation = tags?.some(t => t.includes("mediation")) || status === "in_mediation";
  const isRefunded = tags?.some(t => t.includes("refund"));
  const isDelivered = tags?.some(t => t === "delivered") || shipmentStatus === "delivered";
  const isDevolvido = isRefunded || (status === "cancelled" && isDelivered);
  if (isDevolvido) return { label: "Devolvido", color: "#7c3aed", bg: "rgba(139,92,246,.14)" };
  if (isMediation) return { label: "Em disputa", color: "#FFC107", bg: "rgba(255,193,7,.12)" };
  if (status === "cancelled") return { label: "Cancelado", color: "#FF5252", bg: "rgba(255,82,82,.12)" };
  if (isDelivered) return { label: "Entregue", color: "#1976FF", bg: "rgba(59,140,255,.14)" };
  // Enviado = apenas postado na transportadora
  // ready_to_ship = etiqueta gerada mas NÃO postado → Ag. Envio
  if (["shipped", "in_transit"].includes(shipmentStatus))
    return { label: "Enviado", color: "#0e7490", bg: "rgba(0,240,255,.10)" };
  if (status === "paid") return { label: "Ag. Envio", color: "#FFC107", bg: "rgba(255,193,7,.12)" };
  return { label: status ?? "—", color: "var(--text-2)", bg: "var(--text-2)" };
}

// ── Componente de Paginação ─────────────────────────────────────────────
function Paginacao({ total, porPagina, paginaAtual, onMudar }) {
  var totalPags = Math.ceil(total / porPagina);
  if (totalPags <= 1) return null;

  var inicio = (paginaAtual - 1) * porPagina + 1;
  var fim = Math.min(paginaAtual * porPagina, total);

  // Gerar páginas visíveis (máx 7 botões)
  function paginasVisiveis() {
    var pages = [];
    if (totalPags <= 7) {
      for (var i = 1; i <= totalPags; i++) pages.push(i);
      return pages;
    }
    pages.push(1);
    if (paginaAtual > 3) pages.push("...");
    for (var i = Math.max(2, paginaAtual-1); i <= Math.min(totalPags-1, paginaAtual+1); i++) pages.push(i);
    if (paginaAtual < totalPags - 2) pages.push("...");
    pages.push(totalPags);
    return pages;
  }

  var btnStyle = function(ativo) { return {
    padding:"6px 11px", borderRadius:7, border: ativo ? "2px solid #1976FF" : "1px solid var(--border)",
    background: ativo ? "#1976FF" : "var(--surface)", color: ativo ? "#fff" : "var(--text-2)",
    fontWeight: ativo ? 700 : 400, fontSize:13, cursor:"pointer", fontFamily:"inherit", minWidth:34
  }; };

  return (
    <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"12px 0", borderTop:"1px solid var(--border)", marginTop:4, flexWrap:"wrap", gap:8 }}>
      <span style={{ fontSize:12, color:"var(--text-3)" }}>
        Mostrando {inicio}–{fim} de <strong>{total}</strong> registros
      </span>
      <div style={{ display:"flex", gap:4, alignItems:"center" }}>
        <button onClick={function(){ onMudar(1); }} disabled={paginaAtual===1}
          style={Object.assign({},btnStyle(false),{opacity:paginaAtual===1?0.4:1})}>«</button>
        <button onClick={function(){ onMudar(paginaAtual-1); }} disabled={paginaAtual===1}
          style={Object.assign({},btnStyle(false),{opacity:paginaAtual===1?0.4:1})}>‹</button>
        {paginasVisiveis().map(function(p, i) {
          if (p === "...") return <span key={"e"+i} style={{ color:"var(--text-3)", padding:"0 4px" }}>…</span>;
          return <button key={p} onClick={function(){ onMudar(p); }} style={btnStyle(p===paginaAtual)}>{p}</button>;
        })}
        <button onClick={function(){ onMudar(paginaAtual+1); }} disabled={paginaAtual===totalPags}
          style={Object.assign({},btnStyle(false),{opacity:paginaAtual===totalPags?0.4:1})}>›</button>
        <button onClick={function(){ onMudar(totalPags); }} disabled={paginaAtual===totalPags}
          style={Object.assign({},btnStyle(false),{opacity:paginaAtual===totalPags?0.4:1})}>»</button>
      </div>
    </div>
  );
}

function MarginBar({ value }) {
  if (value === null) return <span style={{ fontSize: 12, color: "var(--text-3)" }}>— insira custo</span>;
  const pct = Math.max(0, Math.min(1, value));
  const color = pct >= 0.25 ? "#0a9d4e" : pct >= 0.15 ? "#FFC107" : "#FF5252";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <div style={{ flex: 1, height: 4, background: "var(--surface-3)", borderRadius: 99, overflow: "hidden", minWidth: 60 }}>
        <div style={{ width: `${pct * 100}%`, height: "100%", background: color, borderRadius: 99 }} />
      </div>
      <span style={{ fontSize: 12, fontWeight: 600, color, minWidth: 38, textAlign: "right" }}>{fmtPct(pct)}</span>
    </div>
  );
}

// Caixa de conteúdo pronto para copiar (descrição, título, atributos gerados pela IA)
function CaixaCopiar({ texto, cor }) {
  const [copiado, setCopiado] = useState(false);
  const cf = cor || "#0a9d4e";
  function copiar() {
    try {
      navigator.clipboard.writeText(texto).then(function(){ setCopiado(true); setTimeout(function(){ setCopiado(false); }, 1800); });
    } catch(e) {}
  }
  return (
    <div style={{ position:"relative", marginTop:8 }}>
      <div style={{ background:"var(--bg)", border:"1px solid var(--border)", borderRadius:8, padding:"10px 12px", fontSize:13, color:"#E6EDF7", lineHeight:1.55, whiteSpace:"pre-wrap", maxHeight:220, overflowY:"auto" }}>{texto}</div>
      <button onClick={copiar}
        style={{ position:"absolute", top:6, right:6, background: copiado?cf:"var(--surface-3)", border:"1px solid "+(copiado?cf:"rgba(255,255,255,.14)"), color: copiado?"var(--bg)":"var(--text-2)", fontSize:11, fontWeight:700, padding:"3px 10px", borderRadius:6, cursor:"pointer" }}>
        {copiado ? "✓ Copiado" : "Copiar"}
      </button>
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
      <div onClick={e => e.stopPropagation()} style={{ background: "var(--surface)", borderRadius: "20px 20px 0 0", width: "100%", maxWidth: 760, maxHeight: "88vh", overflowY: "auto", padding: "28px 32px 40px", boxShadow: "0 -4px 40px rgba(0,0,0,.12)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20 }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 18, color: "var(--text-strong)", marginBottom: 4 }}>Qualidade do Anúncio</div>
            <div style={{ color: "var(--text-2)", fontSize: 13, maxWidth: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{listing.title}</div>
          </div>
          <button onClick={onClose} style={{ background: "var(--surface-3)", border: "none", color: "var(--text-2)", width: 32, height: 32, borderRadius: 8, cursor: "pointer", fontSize: 16 }}>✕</button>
        </div>
        <div style={{ background: "var(--bg-2)", border: "1px solid var(--border)", borderRadius: 12, padding: "16px 20px", marginBottom: 20 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 14 }}>
            <div style={{ width: 52, height: 52, borderRadius: 12, background: scoreBg(score), display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
              <span style={{ fontSize: 18, fontWeight: 800, color: scoreColor(score) }}>{score}</span>
              <span style={{ fontSize: 9, color: scoreColor(score), fontWeight: 600 }}>/100</span>
            </div>
            <div>
              <div style={{ fontWeight: 700, fontSize: 16, color: scoreColor(score) }}>{scoreLabel(score)}</div>
              <div style={{ color: "var(--text-3)", fontSize: 12 }}>Score de qualidade do anúncio</div>
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            {checks.map(c => (
              <div key={c.key} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 7px", background: c.pass ? "rgba(0,200,83,.12)" : "rgba(255,82,82,.12)", borderRadius: 8 }}>
                <span style={{ color: c.pass ? "#0a9d4e" : "#FF5252", fontSize: 13, fontWeight: 700 }}>{c.pass ? "✓" : "✗"}</span>
                <span style={{ fontSize: 12, color: c.pass ? "#0a9d4e" : "#FF5252" }}>{c.label}</span>
              </div>
            ))}
          </div>
        </div>
        {state === "idle" && <div style={{ textAlign: "center", padding: "28px 0" }}><div style={{ color: "var(--text-3)", fontSize: 13, marginBottom: 16 }}>Analise com IA para receber sugestões personalizadas</div><button onClick={runAnalysis} style={{ background: "#1976FF", border: "none", color: "#fff", fontWeight: 700, padding: "11px 32px", borderRadius: 10, cursor: "pointer", fontSize: 14 }}>✦ Analisar com IA</button></div>}
        {state === "loading" && <div style={{ textAlign: "center", padding: "32px 0", color: "var(--text-3)" }}><div style={{ fontSize: 28, marginBottom: 12, animation: "spin 1.2s linear infinite", display: "inline-block" }}>⟳</div><style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style><div style={{ fontSize: 13 }}>Analisando...</div></div>}
        {state === "error" && <div style={{ textAlign: "center", padding: "24px 0" }}><div style={{ color: "#FF5252", fontSize: 13, marginBottom: 12 }}>Erro: {errorMsg}</div><button onClick={runAnalysis} style={{ background: "var(--surface-3)", border: "1px solid var(--border)", color: "var(--text-2)", padding: "8px 20px", borderRadius: 8, cursor: "pointer", fontSize: 13 }}>Tentar novamente</button></div>}
        {state === "done" && result && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ background: "rgba(255,193,7,.12)", border: "1px solid rgba(255,193,7,.35)", borderRadius: 10, padding: "14px 18px" }}>
              <div style={{ fontSize: 11, color: "#FFC107", marginBottom: 6, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Avaliação Geral</div>
              <div style={{ fontSize: 14, color: "var(--text-strong)", lineHeight: 1.6 }}>{result.score_commentary}</div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              {result.strengths?.length > 0 && <div style={{ background: "rgba(0,200,83,.12)", border: "1px solid rgba(0,200,83,.35)", borderRadius: 10, padding: "14px 18px" }}><div style={{ fontSize: 11, color: "#0a9d4e", marginBottom: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>✓ Pontos Fortes</div>{result.strengths.map((s, i) => <div key={i} style={{ fontSize: 13, color: "#0a9d4e", marginBottom: 6, paddingLeft: 10, borderLeft: "2px solid rgba(0,200,83,.45)" }}>{s}</div>)}</div>}
              {result.keywords?.length > 0 && <div style={{ background: "var(--bg-2)", border: "1px solid var(--border)", borderRadius: 10, padding: "14px 18px" }}><div style={{ fontSize: 11, color: "var(--text-2)", marginBottom: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Palavras-chave</div><div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>{result.keywords.map((k, i) => <span key={i} style={{ background: "var(--surface-3)", color: "var(--text-2)", fontSize: 12, padding: "3px 10px", borderRadius: 20 }}>{k}</span>)}</div></div>}
            </div>
            {result.improvements?.length > 0 && <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 10, padding: "14px 18px" }}><div style={{ fontSize: 11, color: "#FFC107", marginBottom: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>⚡ O que Melhorar — com sugestão pronta</div>{result.improvements.map((imp, i) => <div key={i} style={{ display: "flex", gap: 12, marginBottom: 14, paddingBottom: 14, borderBottom: i < result.improvements.length - 1 ? "1px solid var(--border)" : "none" }}><div style={{ minWidth: 26, height: 26, borderRadius: 7, background: "rgba(255,193,7,.12)", border: "1px solid rgba(255,193,7,.35)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: "#FFC107", fontWeight: 700 }}>{i + 1}</div><div style={{ flex: 1, minWidth: 0 }}><div style={{ fontSize: 12, color: "#FFC107", marginBottom: 3, fontWeight: 600 }}>{imp.field}</div><div style={{ fontSize: 13, color: "var(--text-2)", lineHeight: 1.5 }}>{imp.why || imp.suggestion}</div>{imp.ready && String(imp.ready).trim() && <CaixaCopiar texto={imp.ready} cor="#FFC107" />}</div></div>)}</div>}
            {result.description_suggestion && String(result.description_suggestion).trim() && <div style={{ background: "rgba(0,240,255,.08)", border: "1px solid rgba(0,240,255,.25)", borderRadius: 10, padding: "14px 18px" }}><div style={{ fontSize: 11, color: "#0e7490", marginBottom: 4, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>📄 Descrição pronta para colar</div><div style={{ fontSize: 12, color: "var(--text-3)" }}>Copie e cole na descrição do seu anúncio</div><CaixaCopiar texto={result.description_suggestion} cor="#0e7490" /></div>}
            {result.title_suggestion && <div style={{ background: "rgba(0,200,83,.12)", border: "1px solid rgba(0,200,83,.35)", borderRadius: 10, padding: "14px 18px" }}><div style={{ fontSize: 11, color: "#0a9d4e", marginBottom: 8, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>✦ Título pronto para colar</div><div style={{ fontSize: 14, color: "var(--text-strong)", fontWeight: 600 }}>{result.title_suggestion}</div><div style={{ fontSize: 11, color: "var(--text-3)", marginTop: 4 }}>{result.title_suggestion.length} caracteres</div><CaixaCopiar texto={result.title_suggestion} cor="#0a9d4e" /></div>}
          </div>
        )}
      </div>
    </div>
  );
}

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
  idbDel(ML_SNAPSHOT_KEY);
}

// ── Snapshot dos dados do ML (anúncios, pedidos, enriquecimentos) ──────────
// Guarda a última carga completa para que ABRIR UMA NOVA ABA reaproveite os dados
// na hora, sem refazer a reconexão pesada com o Mercado Livre.
// Fica no IndexedDB (não no localStorage) porque a carga passa de 3 MB com centenas
// de anúncios — o localStorage estoura em ~5 MB e o cache simplesmente não salvava.
// Vale por um TTL; passou disso, a aba recarrega do ML normalmente.
const ML_SNAPSHOT_KEY = "ml_snapshot_v1";
// Cache do último carregamento completo: vale por 7 dias, para reaproveitar entre sessões
// (abrir instantâneo) em vez de refazer a carga pesada do ML a cada acesso. Ao hidratar do
// cache, um refresh incremental de pedidos roda em segundo plano; anúncios/taxas/promoções
// ficam do cache até o "Atualizar" manual ou o próximo carregamento completo (pós-TTL).
const ML_SNAPSHOT_TTL = 7 * 24 * 60 * 60 * 1000; // 7 dias

// ── Mini-wrapper de IndexedDB (armazena valores grandes que não cabem no localStorage) ──
function idbOpen() {
  return new Promise(function(resolve, reject){
    try {
      var req = indexedDB.open("mlmargem_cache", 1);
      req.onupgradeneeded = function(){ try { req.result.createObjectStore("kv"); } catch(e){} };
      req.onsuccess = function(){ resolve(req.result); };
      req.onerror = function(){ reject(req.error); };
    } catch (e) { reject(e); }
  });
}
function idbPut(key, val) {
  return idbOpen().then(function(db){
    return new Promise(function(resolve, reject){
      var tx = db.transaction("kv", "readwrite");
      tx.objectStore("kv").put(val, key);
      tx.oncomplete = function(){ resolve(); };
      tx.onerror = function(){ reject(tx.error); };
    });
  });
}
function idbGet(key) {
  return idbOpen().then(function(db){
    return new Promise(function(resolve, reject){
      var tx = db.transaction("kv", "readonly");
      var r = tx.objectStore("kv").get(key);
      r.onsuccess = function(){ resolve(r.result); };
      r.onerror = function(){ reject(r.error); };
    });
  });
}
function idbDel(key) {
  return idbOpen().then(function(db){
    return new Promise(function(resolve){
      try { var tx = db.transaction("kv", "readwrite"); tx.objectStore("kv").delete(key); tx.oncomplete = function(){ resolve(); }; }
      catch(e){ resolve(); }
    });
  }).catch(function(){});
}

// Salva o snapshot completo (sem enxugar — o IndexedDB comporta) — best-effort.
function salvarMLSnapshot(dados) {
  var payload = {
    ts: Date.now(),
    user: dados.user || null,
    listings: dados.listings || [],
    orders: dados.orders || [],
    sellerShipping: dados.sellerShipping || {},
    shipmentCosts: dados.shipmentCosts || {},
    shipmentStatuses: dados.shipmentStatuses || {},
    paymentData: dados.paymentData || {},
    promos: dados.promos || {},
  };
  return idbPut(ML_SNAPSHOT_KEY, payload).catch(function(){});
}

// Lê o snapshot (assíncrono). Retorna null se não existir ou estiver vencido.
function lerMLSnapshot() {
  return idbGet(ML_SNAPSHOT_KEY).then(function(s){
    if (!s || !s.ts || (Date.now() - s.ts) > ML_SNAPSHOT_TTL) return null;
    if (!Array.isArray(s.listings) || !s.listings.length) return null;
    return s;
  }).catch(function(){ return null; });
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
      <div style={{ background: "var(--surface)", borderRadius: 16, width: "100%", maxWidth: 480, padding: "32px 36px", boxShadow: "0 20px 60px rgba(0,0,0,.15)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
          <div style={{ fontWeight: 800, fontSize: 18, color: "var(--text-strong)" }}>Conectar Mercado Livre</div>
          <button onClick={onClose} style={{ background: "var(--surface-3)", border: "none", color: "var(--text-2)", width: 32, height: 32, borderRadius: 8, cursor: "pointer", fontSize: 16 }}>✕</button>
        </div>
        <p style={{ color: "var(--text-2)", fontSize: 13, lineHeight: 1.7, marginBottom: 20 }}>
          Cole o token de acesso do Mercado Livre. O token fica salvo no navegador e você só precisa reconectar quando ele expirar (a cada 6 horas).
        </p>
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 11, color: "var(--text-3)", marginBottom: 8, fontWeight: 600, letterSpacing: 1, textTransform: "uppercase" }}>Token de acesso</div>
          <textarea value={tokenInput} onChange={e => setTokenInput(e.target.value)} placeholder="APP_USR-..." rows={3}
            style={{ width: "100%", background: "var(--bg-2)", border: `1px solid ${errorMsg ? "#fca5a5" : "var(--border)"}`, color: "var(--text-strong)", padding: "10px 14px", borderRadius: 10, fontFamily: "monospace", fontSize: 12, resize: "none", outline: "none" }} />
        </div>
        {errorMsg && <div style={{ background: "rgba(255,82,82,.12)", border: "1px solid rgba(255,82,82,.35)", color: "#FF5252", fontSize: 13, padding: "10px 14px", borderRadius: 8, marginBottom: 16 }}>⚠ {errorMsg}</div>}
        <button onClick={handleConnect} disabled={loading || !tokenInput.trim()}
          style={{ width: "100%", background: loading || !tokenInput.trim() ? "var(--surface-3)" : "#1976FF", border: "none", color: loading || !tokenInput.trim() ? "var(--text-3)" : "#fff", fontWeight: 700, padding: "12px", borderRadius: 10, cursor: loading || !tokenInput.trim() ? "not-allowed" : "pointer", fontSize: 14 }}>
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

  const bg = darkMode ? "var(--bg-2)" : "#fff";
  const border = darkMode ? "var(--text-2)" : "var(--border)";

  return (
    <div style={{ position: "relative" }}>
      <button onClick={() => { setAberto(a => !a); pedirPermissao(); }}
        style={{ position: "relative", background: naoLidas > 0 ? "rgba(255,193,7,.18)" : darkMode ? "var(--bg-2)" : "var(--surface-3)", border: `1px solid ${naoLidas > 0 ? "rgba(255,193,7,.35)" : border}`, color: naoLidas > 0 ? "#FFC107" : darkMode ? "var(--text-3)" : "var(--text-2)", width: 38, height: 38, borderRadius: 10, cursor: "pointer", fontSize: 18, display: "flex", alignItems: "center", justifyContent: "center" }}>
        🔔
        {naoLidas > 0 && (
          <div style={{ position: "absolute", top: -4, right: -4, background: "#FF5252", color: "#fff", width: 18, height: 18, borderRadius: "50%", fontSize: 10, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center", lineHeight: 1 }}>
            {naoLidas > 9 ? "9+" : naoLidas}
          </div>
        )}
      </button>

      {aberto && (
        <>
          <div onClick={() => setAberto(false)} style={{ position: "fixed", inset: 0, zIndex: 200 }} />
          <div style={{ position: "fixed", left: 14, bottom: 14, width: 360, maxWidth: "calc(100vw - 28px)", maxHeight: "78vh", background: bg, border: `1px solid ${border}`, borderRadius: 14, boxShadow: "0 8px 32px rgba(0,0,0,.28)", zIndex: 201, overflow: "hidden", display: "flex", flexDirection: "column" }}>
            {/* Header */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 16px", borderBottom: `1px solid ${border}` }}>
              <div style={{ fontWeight: 700, fontSize: 14, color: darkMode ? "var(--text-2)" : "var(--text-strong)" }}>
                🔔 Notificações {naoLidas > 0 && <span style={{ fontSize: 11, background: "#FF5252", color: "#fff", padding: "1px 7px", borderRadius: 20, marginLeft: 6 }}>{naoLidas} novas</span>}
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                {naoLidas > 0 && (
                  <button onClick={marcarTodasLidas} style={{ background: "none", border: "none", fontSize: 11, color: "#0e7490", cursor: "pointer", fontWeight: 600 }}>Marcar todas como lidas</button>
                )}
                {notificacoes.length > 0 && (
                  <button onClick={limparTodas} style={{ background: "none", border: "none", fontSize: 11, color: "var(--text-3)", cursor: "pointer" }}>Limpar</button>
                )}
              </div>
            </div>

            {/* Lista */}
            <div style={{ maxHeight: 420, overflowY: "auto" }}>
              {notificacoes.length === 0 ? (
                <div style={{ padding: "32px 16px", textAlign: "center", color: "var(--text-3)" }}>
                  <div style={{ fontSize: 32, marginBottom: 8 }}>🔔</div>
                  <div style={{ fontSize: 13 }}>Nenhuma notificação</div>
                  <div style={{ fontSize: 11, marginTop: 4 }}>Reconecte o ML para verificar novos pedidos</div>
                </div>
              ) : notificacoes.map(n => (
                <div key={n.id} onClick={() => marcarLida(n.id)}
                  style={{ padding: "12px 16px", borderBottom: `1px solid ${border}`, cursor: "pointer", background: !n.lido ? (darkMode ? "#1e3a5f" : "rgba(59,140,255,.14)") : "transparent", transition: "background .15s" }}>
                  <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                    <div style={{ width: 36, height: 36, borderRadius: 10, background: n.tipo === "pedido" ? "rgba(0,200,83,.18)" : "rgba(255,193,7,.18)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, flexShrink: 0 }}>
                      {n.tipo === "pedido" ? "🛒" : "⚠️"}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                        <div style={{ fontWeight: 700, fontSize: 13, color: darkMode ? "var(--text-2)" : "var(--text-strong)" }}>{n.titulo}</div>
                        {!n.lido && <div style={{ width: 8, height: 8, background: "#0e7490", borderRadius: "50%", flexShrink: 0, marginTop: 4 }} />}
                      </div>
                      <div style={{ fontSize: 12, color: darkMode ? "var(--text-3)" : "var(--text-2)", marginTop: 2, lineHeight: 1.4 }}>{n.msg}</div>
                      <div style={{ fontSize: 10, color: "var(--text-3)", marginTop: 4 }}>{fmtDate(n.data)}</div>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {/* Footer — permissão browser */}
            {typeof Notification !== "undefined" && Notification.permission === "default" && (
              <div style={{ padding: "10px 16px", borderTop: `1px solid ${border}`, background: darkMode ? "#1976FF" : "var(--bg-2)" }}>
                <button onClick={pedirPermissao} style={{ width: "100%", background: "#1976FF", border: "none", color: "#fff", fontWeight: 600, padding: "8px", borderRadius: 8, cursor: "pointer", fontSize: 12 }}>
                  🔔 Ativar notificações do navegador
                </button>
              </div>
            )}
            {typeof Notification !== "undefined" && Notification.permission === "granted" && (
              <div style={{ padding: "8px 16px", borderTop: `1px solid ${border}`, fontSize: 11, color: "#0a9d4e", textAlign: "center" }}>
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
      sistema: "Flow Marketplaces",
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
    a.download = `flow_marketplaces_backup_${new Date().toLocaleDateString("sv-SE")}.json`;
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
        if (!backup.dados || !backup.versao) throw new Error("Arquivo inválido — não é um backup do Flow Marketplaces.");
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
      <div style={{ background:"var(--surface)", borderRadius:20, width:"100%", maxWidth:580, maxHeight:"90vh", display:"flex", flexDirection:"column", boxShadow:"0 24px 64px rgba(0,0,0,.2)" }}>
        {/* Header */}
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"12px 16px", borderBottom:"1px solid var(--border)" }}>
          <div>
            <div style={{ fontWeight:800, fontSize:18, color:"var(--text-strong)" }}>💾 Backup e Restauração</div>
            <div style={{ fontSize:12, color:"var(--text-3)", marginTop:2 }}>Exporte seus dados para um arquivo seguro ou restaure de um backup anterior</div>
          </div>
          <button onClick={onClose} style={{ background:"var(--surface-3)", border:"none", color:"var(--text-2)", width:32, height:32, borderRadius:8, cursor:"pointer", fontSize:16 }}>✕</button>
        </div>

        <div style={{ flex:1, overflowY:"auto", padding:"12px 16px" }}>

          {/* Status */}
          {status && (
            <div style={{ background:status.startsWith("✅")?"rgba(0,200,83,.12)":"rgba(255,82,82,.12)", border:`1px solid ${status.startsWith("✅")?"rgba(0,200,83,.35)":"rgba(255,82,82,.35)"}`, borderRadius:10, padding:"10px 16px", marginBottom:8, fontSize:13, fontWeight:600, color:status.startsWith("✅")?"#0a9d4e":"#FF5252" }}>
              {status}
            </div>
          )}

          {/* Preview de importação */}
          {preview && (
            <div style={{ background:"rgba(255,193,7,.12)", border:"1px solid rgba(255,193,7,.35)", borderRadius:12, padding:"16px 18px", marginBottom:8 }}>
              <div style={{ fontWeight:700, fontSize:14, color:"#FFC107", marginBottom:8 }}>⚠️ Confirmar Restauração</div>
              <div style={{ fontSize:12, color:"#FFC107", marginBottom:12 }}>
                Backup de: <strong>{preview.dataBackup}</strong><br/>
                <strong>Atenção:</strong> os dados atuais serão substituídos pelos dados do backup!
              </div>
              <div style={{ display:"flex", flexDirection:"column", gap:4, marginBottom:8 }}>
                {preview.prev.map(p => (
                  <div key={p.key} style={{ display:"flex", justifyContent:"space-between", fontSize:12, color:"var(--text-strong)" }}>
                    <span>{p.label}</span>
                    <span style={{ fontWeight:600, color:"#FFC107" }}>{p.count} registro(s)</span>
                  </div>
                ))}
              </div>
              <div style={{ display:"flex", gap:8 }}>
                <button onClick={() => setPreview(null)}
                  style={{ flex:1, background:"var(--surface)", border:"1px solid var(--border)", color:"var(--text-2)", fontWeight:600, padding:"10px", borderRadius:8, cursor:"pointer" }}>Cancelar</button>
                <button onClick={confirmarImport}
                  style={{ flex:2, background:"#FFC107", border:"none", color:"#fff", fontWeight:700, padding:"10px", borderRadius:8, cursor:"pointer" }}>
                  ✓ Sim, restaurar dados
                </button>
              </div>
            </div>
          )}

          {/* Resumo dos dados atuais */}
          <div style={{ marginBottom:10 }}>
            <div style={{ fontWeight:700, fontSize:14, color:"var(--text-strong)", marginBottom:12 }}>📊 Dados Armazenados Atualmente</div>
            <div style={{ background:"var(--bg-2)", border:"1px solid var(--border)", borderRadius:12, overflow:"hidden" }}>
              {resumo.map((r, i) => (
                <div key={r.key} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"10px 16px", borderBottom:i<resumo.length-1?"1px solid var(--border)":"none", background:i%2===0?"var(--bg-2)":"var(--surface)" }}>
                  <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                    <div style={{ width:8, height:8, borderRadius:"50%", background:r.empty?"var(--surface-3)":"#0a9d4e" }} />
                    <span style={{ fontSize:13, color:"var(--text-strong)" }}>{r.label}</span>
                  </div>
                  <div style={{ display:"flex", gap:16, alignItems:"center" }}>
                    {!r.empty ? (
                      <>
                        <span style={{ fontSize:12, color:"var(--text-2)" }}>{r.count} registro(s)</span>
                        <span style={{ fontSize:11, color:"var(--text-3)", background:"var(--surface-3)", padding:"2px 8px", borderRadius:20 }}>{formatSize(r.size)}</span>
                      </>
                    ) : (
                      <span style={{ fontSize:12, color:"var(--text-3)" }}>vazio</span>
                    )}
                  </div>
                </div>
              ))}
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"12px 16px", background:"var(--surface-3)", borderTop:"2px solid var(--border)" }}>
                <span style={{ fontSize:13, fontWeight:700, color:"var(--text-strong)" }}>Total</span>
                <span style={{ fontSize:13, fontWeight:700, color:"var(--text-strong)" }}>{formatSize(totalSize)}</span>
              </div>
            </div>
          </div>

          {/* Ações */}
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12 }}>
            {/* Exportar */}
            <div style={{ background:"rgba(0,200,83,.12)", border:"1px solid rgba(0,200,83,.35)", borderRadius:12, padding:"18px 20px" }}>
              <div style={{ fontSize:28, marginBottom:8 }}>⬇️</div>
              <div style={{ fontWeight:700, fontSize:14, color:"#0a9d4e", marginBottom:4 }}>Exportar Backup</div>
              <div style={{ fontSize:12, color:"var(--text-2)", marginBottom:8, lineHeight:1.5 }}>
                Baixa um arquivo JSON com todos os seus dados. Guarde em local seguro.
              </div>
              <button onClick={exportarBackup}
                style={{ width:"100%", background:"#0a9d4e", border:"none", color:"#fff", fontWeight:700, padding:"11px", borderRadius:10, cursor:"pointer", fontSize:13 }}>
                ⬇️ Exportar Backup Agora
              </button>
            </div>

            {/* Importar */}
            <div style={{ background:"rgba(59,140,255,.14)", border:"1px solid rgba(77,179,255,.35)", borderRadius:12, padding:"18px 20px" }}>
              <div style={{ fontSize:28, marginBottom:8 }}>⬆️</div>
              <div style={{ fontWeight:700, fontSize:14, color:"#1976FF", marginBottom:4 }}>Restaurar Backup</div>
              <div style={{ fontSize:12, color:"var(--text-2)", marginBottom:8, lineHeight:1.5 }}>
                Selecione um arquivo de backup (.json) para restaurar seus dados.
              </div>
              <label style={{ display:"block", width:"100%", background:"#1976FF", border:"none", color:"#fff", fontWeight:700, padding:"11px", borderRadius:10, cursor:"pointer", fontSize:13, textAlign:"center" }}>
                {importing ? "Lendo arquivo..." : "⬆️ Selecionar Arquivo"}
                <input type="file" accept=".json" style={{ display:"none" }} onChange={e => { if(e.target.files[0]) handleImportFile(e.target.files[0]); e.target.value=""; }} />
              </label>
            </div>
          </div>

          <div style={{ marginTop:16, background:"rgba(255,193,7,.18)", border:"1px solid rgba(255,193,7,.35)", borderRadius:10, padding:"12px 16px", fontSize:12, color:"#FFC107" }}>
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
  { key: "listings",        label: "Anúncios" },
  { key: "orders",          label: "Pedidos" },
  { key: "admin",           label: "Administração" },
];

// A validação de senha agora acontece SOMENTE no servidor (/api/auth/app-login).
// O navegador não gera, não armazena e não compara hashes de senha — o localStorage
// guarda apenas um cache dos usuários (sem senha) para exibição na aba Admin/Chat.

function getUsuarios() {
  try {
    const data = localStorage.getItem(AUTH_KEY);
    if (!data) return [];
    var parsed = JSON.parse(data);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function saveUsuarios(usuarios) {
  // Senhas novas ficam em u.senha (texto) só até o envio — nunca vão para o localStorage
  var senhas = {};
  var semSenhas = usuarios.map(function(u){
    var limpo = Object.assign({}, u);
    if (limpo.senha) { senhas[limpo.id] = limpo.senha; delete limpo.senha; }
    delete limpo.senhaHash;
    return limpo;
  });
  localStorage.setItem(AUTH_KEY, JSON.stringify(semSenhas));
  try {
    fetch("/api/ml/_users", {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify({ usuarios: semSenhas, senhas: senhas })
    }).catch(function(){});
  } catch {}
  return semSenhas;
}

// Busca usuários do servidor para o cache local (chamado após o login)
async function sincronizarUsuariosDoServidor() {
  try {
    var res = await fetch("/api/ml/_users");
    if (!res.ok) return;
    var usuariosServidor = await res.json();
    if (!Array.isArray(usuariosServidor) || !usuariosServidor.length) return;
    localStorage.setItem(AUTH_KEY, JSON.stringify(usuariosServidor));
    console.log("[USUÁRIOS] Sincronizados:", usuariosServidor.length);
  } catch(e) {
    console.warn("[USUÁRIOS] Erro na sincronização:", e.message);
  }
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

  async function handleLogin() {
    if (!usuario || !senha) return;
    setLoading(true); setErro("");
    try {
      // A senha é validada no servidor, que emite um cookie de sessão assinado (httpOnly)
      const res = await fetch("/api/auth/app-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ usuario: usuario, senha: senha }),
      });
      const data = await res.json().catch(function(){ return {}; });
      if (res.ok && data.user) {
        setSession(data.user);
        // Com o cookie emitido, atualiza o cache local de usuários
        sincronizarUsuariosDoServidor();
        onLogin(data.user);
      } else {
        setErro(data.error || "Usuário ou senha incorretos, ou usuário inativo.");
      }
    } catch (e) {
      setErro("Não foi possível conectar ao servidor. Tente novamente.");
    }
    setLoading(false);
  }

  return (
    <div style={{ minHeight:"100vh", backgroundColor:"var(--bg)", backgroundImage:"radial-gradient(1100px 500px at 75% -10%, rgba(25,118,255,.12), transparent 60%), radial-gradient(800px 420px at -10% 110%, rgba(0,240,255,.06), transparent 60%)", display:"flex", alignItems:"center", justifyContent:"center", fontFamily:"'Inter','Segoe UI',sans-serif", padding:24 }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');*{box-sizing:border-box;margin:0;padding:0}`}</style>
      <div style={{ width:"100%", maxWidth:420 }}>
        {/* Logo */}
        <div style={{ textAlign:"center", marginBottom:32 }}>
          <div style={{ width:64, height:64, borderRadius:"50%", background:"rgba(77,179,255,.12)", border:"1px solid rgba(77,179,255,.45)", display:"inline-flex", alignItems:"center", justifyContent:"center", fontFamily:"'Space Grotesk',sans-serif", fontSize:30, fontWeight:700, color:"#1976FF", marginBottom:12, boxShadow:"0 0 32px rgba(77,179,255,.4)" }}>F</div>
          <div style={{ fontFamily:"'Space Grotesk',sans-serif", fontWeight:700, fontSize:24, color:"var(--text-strong)", letterSpacing:-0.5 }}>Flow Marketplaces</div>
          <div style={{ fontFamily:"'JetBrains Mono',monospace", fontSize:11, color:"var(--text-3)", marginTop:6, letterSpacing:".24em", textTransform:"uppercase" }}>Gestão de Anúncios</div>
        </div>

        {/* Card */}
        <div style={{ background:"var(--bg-2)", borderRadius:20, padding:"32px 36px", boxShadow:"0 20px 60px rgba(0,0,0,.4)", border:"1px solid var(--text-2)" }}>
          <div style={{ fontWeight:700, fontSize:18, color:"var(--text-2)", marginBottom:10 }}>Entrar no sistema</div>

          <div style={{ marginBottom:8 }}>
            <div style={{ fontSize:11, color:"var(--text-2)", marginBottom:8, fontWeight:600, letterSpacing:1, textTransform:"uppercase" }}>Usuário</div>
            <input value={usuario} onChange={e => { setUsuario(e.target.value); setErro(""); }}
              onKeyDown={e => e.key==="Enter" && handleLogin()}
              placeholder="Digite seu usuário"
              style={{ width:"100%", background:"var(--bg)", border:`1px solid ${erro?"#FF5252":"rgba(255,255,255,.14)"}`, color:"var(--text-strong)", padding:"12px 16px", borderRadius:10, fontSize:14, outline:"none", fontFamily:"inherit" }} />
          </div>

          <div style={{ marginBottom:10 }}>
            <div style={{ fontSize:11, color:"var(--text-2)", marginBottom:8, fontWeight:600, letterSpacing:1, textTransform:"uppercase" }}>Senha</div>
            <div style={{ position:"relative" }}>
              <input type={showSenha?"text":"password"} value={senha}
                onChange={e => { setSenha(e.target.value); setErro(""); }}
                onKeyDown={e => e.key==="Enter" && handleLogin()}
                placeholder="Digite sua senha"
                style={{ width:"100%", background:"var(--bg)", border:`1px solid ${erro?"#FF5252":"rgba(255,255,255,.14)"}`, color:"var(--text-strong)", padding:"12px 48px 12px 16px", borderRadius:10, fontSize:14, outline:"none", fontFamily:"inherit" }} />
              <button onClick={() => setShowSenha(s=>!s)}
                style={{ position:"absolute", right:14, top:"50%", transform:"translateY(-50%)", background:"none", border:"none", cursor:"pointer", color:"var(--text-2)", fontSize:16 }}>
                {showSenha?"🙈":"👁"}
              </button>
            </div>
          </div>

          {erro && (
            <div style={{ background:"#450a0a", border:"1px solid #FF5252", color:"#fca5a5", fontSize:13, padding:"10px 14px", borderRadius:8, marginBottom:8 }}>
              ⚠ {erro}
            </div>
          )}

          <button onClick={handleLogin} disabled={loading||!usuario||!senha}
            style={{ width:"100%", background:loading||!usuario||!senha?"var(--surface-3)":"var(--bg)", border:`1px solid ${loading||!usuario||!senha?"var(--border-soft)":"rgba(255,255,255,.18)"}`, color:loading||!usuario||!senha?"var(--text-3)":"var(--text-strong)", fontWeight:800, padding:"14px", borderRadius:12, cursor:loading||!usuario||!senha?"not-allowed":"pointer", fontSize:15, transition:"all .15s" }}>
            {loading ? "Verificando..." : "Entrar"}
          </button>

          <div style={{ textAlign:"center", marginTop:16, fontSize:12, color:"var(--text-2)" }}>
            Acesso restrito — somente usuários autorizados
          </div>
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
    permissoes: ["listings","orders"],
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
    // A senha segue em texto (via HTTPS) para o servidor, que calcula o hash com
    // scrypt — saveUsuarios remove o campo antes de gravar no localStorage.
    if (!form.senha) {
      if (!usuario) {
        alert("Informe uma senha para o novo usuário");
        return;
      }
      delete toSave.senha;
    }
    if (!toSave.criadoEm) toSave.criadoEm = new Date().toLocaleDateString("sv-SE");
    onSave(toSave);
    onClose();
  }

  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,.7)", backdropFilter:"blur(4px)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:600, padding:24 }}>
      <div style={{ background:"var(--surface)", borderRadius:16, width:"100%", maxWidth:520, padding:"28px 32px", boxShadow:"0 20px 60px rgba(0,0,0,.3)", maxHeight:"90vh", overflowY:"auto" }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:10 }}>
          <div style={{ fontWeight:800, fontSize:17, color:"var(--text-strong)" }}>{usuario ? "Editar Usuário" : "Novo Usuário"}</div>
          <button onClick={onClose} style={{ background:"var(--surface-3)", border:"none", color:"var(--text-2)", width:32, height:32, borderRadius:8, cursor:"pointer", fontSize:16 }}>✕</button>
        </div>

        <div style={{ display:"flex", flexDirection:"column", gap:12, marginBottom:10 }}>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
            <div>
              <div style={{ fontSize:11, color:"var(--text-3)", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Nome completo *</div>
              <input value={form.nome} onChange={e=>set("nome",e.target.value)} placeholder="Ex: João Silva"
                style={{ width:"100%", background:"var(--bg-2)", border:"1px solid var(--border)", color:"var(--text-strong)", padding:"9px 12px", borderRadius:8, fontSize:13, outline:"none" }} />
            </div>
            <div>
              <div style={{ fontSize:11, color:"var(--text-3)", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Usuário (login) *</div>
              <input value={form.usuario} onChange={e=>set("usuario",e.target.value.toLowerCase().replace(/\s/g,""))} placeholder="Ex: joao"
                style={{ width:"100%", background:"var(--bg-2)", border:"1px solid var(--border)", color:"var(--text-strong)", padding:"9px 12px", borderRadius:8, fontSize:13, outline:"none", fontFamily:"monospace" }} />
            </div>
          </div>

          <div>
            <div style={{ fontSize:11, color:"var(--text-3)", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Email (para notificações de tarefas)</div>
            <input type="email" value={form.email||""} onChange={e=>set("email",e.target.value)} placeholder="usuario@empresa.com"
              style={{ width:"100%", background:"var(--bg-2)", border:"1px solid var(--border)", color:"var(--text-strong)", padding:"9px 12px", borderRadius:8, fontSize:13, outline:"none" }} />
          </div>

          <div>
            <div style={{ fontSize:11, color:"var(--text-3)", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>
              {usuario ? "Nova senha (deixe vazio para manter)" : "Senha *"}
            </div>
            <div style={{ position:"relative" }}>
              <input type={showSenha?"text":"password"} value={form.senha||""} onChange={e=>set("senha",e.target.value)}
                placeholder={usuario?"••••••••":"Mínimo 6 caracteres"}
                style={{ width:"100%", background:"var(--bg-2)", border:"1px solid var(--border)", color:"var(--text-strong)", padding:"9px 44px 9px 12px", borderRadius:8, fontSize:13, outline:"none" }} />
              <button onClick={()=>setShowSenha(s=>!s)}
                style={{ position:"absolute", right:10, top:"50%", transform:"translateY(-50%)", background:"none", border:"none", cursor:"pointer", color:"var(--text-3)", fontSize:14 }}>
                {showSenha?"🙈":"👁"}
              </button>
            </div>
          </div>

          {/* Permissões */}
          <div style={{ background:"var(--bg-2)", borderRadius:12, padding:"14px 16px" }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12 }}>
              <div style={{ fontWeight:700, fontSize:13, color:"var(--text-strong)" }}>Permissões de Acesso</div>
              <button onClick={function(){
                  var todasKeys = [];
                  PERMISSOES_DISPONIVEIS.forEach(function(p){ todasKeys.push(p.key); if(p.sub) p.sub.forEach(function(s){ todasKeys.push(s.key); }); });
                  var temTudo = todasKeys.every(function(k){ return (form.permissoes||[]).includes(k); });
                  set("permissoes", temTudo ? [] : todasKeys);
                }}
                style={{ fontSize:11, color:"#1976FF", background:"transparent", border:"none", cursor:"pointer", fontWeight:600 }}>
                {(function(){
                  var total = 0;
                  PERMISSOES_DISPONIVEIS.forEach(function(p){ total++; if(p.sub) total+=p.sub.length; });
                  return (form.permissoes||[]).length >= total ? "Desmarcar tudo" : "Selecionar tudo";
                })()}
              </button>
            </div>
            <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
              {PERMISSOES_DISPONIVEIS.map(function(p) {
                var isChecked = (form.permissoes||[]).includes(p.key);
                // Sub-permissões: algumas marcadas?
                var subChecked = p.sub ? p.sub.filter(function(s){ return (form.permissoes||[]).includes(s.key); }).length : 0;
                var subTotal = p.sub ? p.sub.length : 0;
                var isIndeterminate = !isChecked && subChecked > 0 && subChecked < subTotal;
                return (
                  <div key={p.key}>
                    {/* Item pai */}
                    <label style={{ display:"flex", alignItems:"center", gap:8, cursor:"pointer", padding:"5px 8px", borderRadius:8,
                      background: isChecked || subChecked > 0 ? "rgba(59,140,255,.14)" : "var(--surface)",
                      border: "1px solid " + (isChecked || subChecked > 0 ? "#1976FF" : "var(--border)"),
                      transition:"all .15s" }}>
                      <input type="checkbox" checked={isChecked} ref={function(el){ try { if (el) el.indeterminate = isIndeterminate; } catch(e){} }}
                        onChange={function() {
                          var perms = form.permissoes || [];
                          if (isChecked) {
                            // Desmarcar pai e todos os filhos
                            var remove = [p.key].concat(p.sub ? p.sub.map(function(s){return s.key;}) : []);
                            set("permissoes", perms.filter(function(k){ return !remove.includes(k); }));
                          } else {
                            // Marcar pai e todos os filhos
                            var add = [p.key].concat(p.sub ? p.sub.map(function(s){return s.key;}) : []);
                            var newPerms = perms.slice();
                            add.forEach(function(k){ if(!newPerms.includes(k)) newPerms.push(k); });
                            set("permissoes", newPerms);
                          }
                        }}
                        style={{ width:14, height:14, cursor:"pointer" }} />
                      <span style={{ fontSize:13, fontWeight:600, color: isChecked || subChecked > 0 ? "#1976FF" : "var(--text-2)", flex:1 }}>{p.label}</span>
                      {p.sub && <span style={{ fontSize:10, color:"var(--text-3)" }}>{subChecked}/{subTotal}</span>}
                    </label>
                    {/* Sub-permissões */}
                    {p.sub && (isChecked || subChecked > 0 || true) && (
                      <div style={{ marginLeft:24, marginTop:4, display:"grid", gridTemplateColumns:"1fr 1fr", gap:4 }}>
                        {p.sub.map(function(s) {
                          var sChecked = (form.permissoes||[]).includes(s.key);
                          return (
                            <label key={s.key} style={{ display:"flex", alignItems:"center", gap:6, cursor:"pointer", padding:"6px 10px", borderRadius:7,
                              background: sChecked ? "rgba(77,179,255,.12)" : "var(--bg-2)",
                              border: "1px solid " + (sChecked ? "#bae6fd" : "var(--border)"),
                              transition:"all .15s" }}>
                              <input type="checkbox" checked={sChecked}
                                onChange={function() {
                                  var perms = form.permissoes || [];
                                  var newPerms = sChecked
                                    ? perms.filter(function(k){ return k !== s.key; })
                                    : [...perms, s.key];
                                  // Auto-marcar pai se qualquer filho estiver marcado
                                  if (!sChecked && !newPerms.includes(p.key)) newPerms = [...newPerms, p.key];
                                  // Desmarcar pai se nenhum filho estiver marcado
                                  if (sChecked) {
                                    var filhosAtivos = (p.sub||[]).filter(function(fs){ return newPerms.includes(fs.key); });
                                    if (filhosAtivos.length === 0) newPerms = newPerms.filter(function(k){ return k !== p.key; });
                                  }
                                  set("permissoes", newPerms);
                                }}
                                style={{ width:12, height:12, cursor:"pointer" }} />
                              <span style={{ fontSize:12, color: sChecked ? "#1976FF" : "var(--text-2)", fontWeight: sChecked ? 600 : 400 }}>{s.label}</span>
                            </label>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Status e Admin */}
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
            <label style={{ display:"flex", alignItems:"center", gap:8, cursor:"pointer", padding:"10px 14px", borderRadius:8, background:"var(--bg-2)", border:"1px solid var(--border)" }}>
              <input type="checkbox" checked={form.ativo} onChange={e=>set("ativo",e.target.checked)} style={{ width:14, height:14 }} />
              <span style={{ fontSize:13, color:"var(--text-2)", fontWeight:500 }}>Usuário ativo</span>
            </label>
            <label style={{ display:"flex", alignItems:"center", gap:8, cursor:"pointer", padding:"10px 14px", borderRadius:8, background:"var(--bg-2)", border:"1px solid var(--border)" }}>
              <input type="checkbox" checked={form.admin||false} onChange={e=>set("admin",e.target.checked)} style={{ width:14, height:14 }} />
              <span style={{ fontSize:13, color:"var(--text-2)", fontWeight:500 }}>Administrador</span>
            </label>
          </div>
        </div>

        <div style={{ display:"flex", gap:8 }}>
          <button onClick={onClose} style={{ flex:1, background:"var(--bg-2)", border:"1px solid var(--border)", color:"var(--text-2)", fontWeight:600, padding:"11px", borderRadius:10, cursor:"pointer" }}>Cancelar</button>
          <button onClick={handleSave} disabled={!form.nome||!form.usuario}
            style={{ flex:2, background:!form.nome||!form.usuario?"var(--surface-3)":"#1976FF", border:"none", color:!form.nome||!form.usuario?"var(--text-3)":"#fff", fontWeight:700, padding:"11px", borderRadius:10, cursor:!form.nome||!form.usuario?"not-allowed":"pointer" }}>
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

  // Atualiza o cache local com a lista do servidor ao abrir a aba
  useEffect(function(){
    sincronizarUsuariosDoServidor().then(function(){ setUsuarios(getUsuarios()); });
  }, []);

  function saveUser(user) {
    const lista = getUsuarios();
    const updated = lista.find(u=>u.id===user.id)
      ? lista.map(u=>u.id===user.id?user:u)
      : [...lista, user];
    setUsuarios(saveUsuarios(updated));
  }

  function deleteUser(id) {
    if (id === currentUser.id) { alert("Você não pode excluir seu próprio usuário!"); return; }
    if (!confirm("Excluir este usuário?")) return;
    const updated = getUsuarios().filter(u=>u.id!==id);
    setUsuarios(saveUsuarios(updated));
  }

  function toggleAtivo(id) {
    if (id === currentUser.id) { alert("Você não pode desativar seu próprio usuário!"); return; }
    const updated = getUsuarios().map(u=>u.id===id?{...u,ativo:!u.ativo}:u);
    setUsuarios(saveUsuarios(updated));
  }

  return (
    <div>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:10 }}>
        <div>
          <div style={{ fontWeight:800, fontSize:18, color:"var(--text-strong)" }}>Equipe</div>
          <div style={{ fontSize:13, color:"var(--text-3)", marginTop:2 }}>Gerencie quem pode acessar o dashboard e o que cada um pode ver</div>
        </div>
        <button onClick={()=>{ setEditingUser(null); setShowModal(true); }}
          style={{ background:"#1976FF", border:"none", color:"#fff", fontWeight:700, padding:"10px 22px", borderRadius:10, cursor:"pointer", fontSize:13 }}>
          + Novo Usuário
        </button>
      </div>

      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(300px,1fr))", gap:12 }}>
        {usuarios.map(u => (
          <div key={u.id} style={{ background:"var(--surface)", border:`2px solid ${u.id===currentUser.id?"#1976FF":u.ativo?"var(--border)":"var(--border)"}`, borderRadius:14, padding:"18px 20px", position:"relative", opacity:u.ativo?1:0.6 }}>
            {u.id===currentUser.id && (
              <div style={{ position:"absolute", top:12, left:12, background:"#1976FF", color:"#fff", fontSize:10, padding:"2px 8px", borderRadius:20, fontWeight:700 }}>VOCÊ</div>
            )}
            <div style={{ display:"flex", justifyContent:"flex-end", gap:6, marginBottom:8 }}>
              <button onClick={()=>toggleAtivo(u.id)}
                style={{ background:u.ativo?"rgba(0,200,83,.12)":"var(--bg-2)", border:`1px solid ${u.ativo?"rgba(0,200,83,.35)":"var(--border)"}`, color:u.ativo?"#0a9d4e":"var(--text-3)", padding:"3px 10px", borderRadius:6, cursor:"pointer", fontSize:11, fontWeight:600 }}>
                {u.ativo?"● Ativo":"○ Inativo"}
              </button>
              <button onClick={()=>{ setEditingUser(u); setShowModal(true); }}
                style={{ background:"var(--surface-3)", border:"none", color:"var(--text-2)", width:28, height:28, borderRadius:6, cursor:"pointer", fontSize:12 }}>✏️</button>
              {u.id!==currentUser.id && (
                <button onClick={()=>deleteUser(u.id)}
                  style={{ background:"rgba(255,82,82,.12)", border:"none", color:"#FF5252", width:28, height:28, borderRadius:6, cursor:"pointer", fontSize:12 }}>🗑</button>
              )}
            </div>

            <div style={{ display:"flex", alignItems:"center", gap:7, marginBottom:12 }}>
              <div style={{ width:42, height:42, borderRadius:12, background:u.admin?"#1976FF":"var(--surface-3)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:15, fontWeight:800, color:u.admin?"#FFC107":"var(--text-2)" }}>
                {u.nome?.charAt(0).toUpperCase()}
              </div>
              <div>
                <div style={{ fontWeight:700, fontSize:15, color:"var(--text-strong)" }}>{u.nome}</div>
                <div style={{ fontSize:12, color:"var(--text-3)", fontFamily:"monospace" }}>@{u.usuario}</div>
                {u.admin && <div style={{ fontSize:10, color:"#7c3aed", fontWeight:700 }}>ADMINISTRADOR</div>}
              </div>
            </div>

            <div style={{ fontSize:11, color:"var(--text-3)", marginBottom:6, fontWeight:600, textTransform:"uppercase" }}>Permissões</div>
            <div style={{ display:"flex", flexWrap:"wrap", gap:4 }}>
              {PERMISSOES_DISPONIVEIS.map(p => (
                <span key={p.key} style={{ fontSize:11, padding:"2px 8px", borderRadius:20, background:u.permissoes?.includes(p.key)?"rgba(59,140,255,.14)":"var(--bg-2)", color:u.permissoes?.includes(p.key)?"#1976FF":"var(--text-4)", border:`1px solid ${u.permissoes?.includes(p.key)?"rgba(77,179,255,.35)":"var(--border)"}`, fontWeight:u.permissoes?.includes(p.key)?600:400 }}>
                  {p.label}
                </span>
              ))}
            </div>
            <div style={{ fontSize:11, color:"var(--text-4)", marginTop:10 }}>Criado em {u.criadoEm||"—"}</div>
          </div>
        ))}
      </div>

      {showModal && <ModalUsuario usuario={editingUser} onSave={saveUser} onClose={()=>{ setShowModal(false); setEditingUser(null); }} />}
    </div>
  );
}


// ── Painel detalhado de Impostos (Lucro Real) e Custos Fixos ──
var ESTADOS_BR_ICMS = [["AC", "Acre", 19], ["AL", "Alagoas", 19], ["AP", "Amapá", 18], ["AM", "Amazonas", 20], ["BA", "Bahia", 20.5], ["CE", "Ceará", 20], ["DF", "Distrito Federal", 20], ["ES", "Espírito Santo", 17], ["GO", "Goiás", 19], ["MA", "Maranhão", 22], ["MT", "Mato Grosso", 17], ["MS", "Mato Grosso do Sul", 17], ["MG", "Minas Gerais", 18], ["PA", "Pará", 19], ["PB", "Paraíba", 20], ["PR", "Paraná", 19.5], ["PE", "Pernambuco", 20.5], ["PI", "Piauí", 21], ["RJ", "Rio de Janeiro", 22], ["RN", "Rio Grande do Norte", 18], ["RS", "Rio Grande do Sul", 17], ["RO", "Rondônia", 19.5], ["RR", "Roraima", 20], ["SC", "Santa Catarina", 17], ["SP", "São Paulo", 18], ["SE", "Sergipe", 19], ["TO", "Tocantins", 20]];

function getIcmsConfig() {
  try { return JSON.parse(localStorage.getItem("icms_por_estado")||"{}"); } catch { return {}; }
}
function saveIcmsConfig(cfg) { try { localStorage.setItem("icms_por_estado", JSON.stringify(cfg)); } catch {} }

function ImpostosCompacto({ impostos, setImpostos, custosFixos, setCustosFixos, faturamentoMes, irpjCsllConfig, setIrpjCsllConfig }) {
  const [novoCusto, setNovoCusto] = useState({ nome:"", valor:"", tipo:"R$" });
  // Persiste no localStorage — o loop de sincronização (pushMudancasLocais) envia daqui para o KV
  function saveCustosFixos(v) { try { localStorage.setItem("custos_fixos_config", JSON.stringify(v)); } catch {} }
  const [icmsConfig, setIcmsConfig] = useState(getIcmsConfig);
  const [showIcmsTable, setShowIcmsTable] = useState(false);
  const irpjPct = irpjCsllConfig.irpj ?? "15";
  const irpjAdicionalPct = irpjCsllConfig.irpjAdicional ?? "10";
  const csllPct = irpjCsllConfig.csll ?? "9";

  function salvarIrpjCsll(novoIrpj, novoIrpjAd, novoCsll) {
    setIrpjCsllConfig({ irpj: novoIrpj, irpjAdicional: novoIrpjAd, csll: novoCsll });
  }

  function setIcmsEstado(uf, valor) {
    var next = Object.assign({}, icmsConfig, { [uf]: valor });
    setIcmsConfig(next); saveIcmsConfig(next);
  }
  function resetIcmsPadrao() {
    var next = {};
    ESTADOS_BR_ICMS.forEach(function(e){ next[e[0]] = e[2]; });
    setIcmsConfig(next); saveIcmsConfig(next);
  }

  function addCusto() {
    if (!novoCusto.nome || !novoCusto.valor) return;
    var upd = [...custosFixos, Object.assign({}, novoCusto, {id: Date.now()})];
    setCustosFixos(upd); saveCustosFixos(upd);
    setNovoCusto({ nome:"", valor:"", tipo:"R$" });
  }
  function removeCusto(id) { var upd = custosFixos.filter(function(c){return c.id!==id;}); setCustosFixos(upd); saveCustosFixos(upd); }

  function calcValor(item, base) {
    var v = parseFloat(item.valor||0);
    return item.tipo === "%" ? base * (v/100) : v;
  }

  var totalFix = custosFixos.reduce(function(s,c){ return s + calcValor(c, faturamentoMes); }, 0);

  // ICMS médio ponderado (apenas para exibição de referência; cálculo real usa por-pedido conforme UF do comprador)
  var ufsConfigurados = Object.keys(icmsConfig).filter(function(k){ return parseFloat(icmsConfig[k])>0; });
  var icmsMedioRef = ufsConfigurados.length
    ? ufsConfigurados.reduce(function(s,k){return s+parseFloat(icmsConfig[k]);},0) / ufsConfigurados.length
    : 0;

  var irpjTotal = parseFloat(irpjPct||0) + parseFloat(irpjAdicionalPct||0);
  var csllTotalCalc = parseFloat(csllPct||0);
  var totalImpFixo = faturamentoMes * ((irpjTotal+csllTotalCalc)/100);

  function ItemRow({ item, onRemove }) {
    return (
      <div style={{ display:"flex", alignItems:"center", gap:8, padding:"8px 0", borderBottom:"1px solid var(--border-soft)" }}>
        <div style={{ flex:1, fontSize:13, color:"var(--text-strong)", fontWeight:500 }}>{item.nome}</div>
        <div style={{ fontSize:13, fontWeight:700, color:"var(--text-2)" }}>{item.tipo==="%" ? item.valor+"%" : "R$ "+parseFloat(item.valor).toFixed(2).replace(".",",")}</div>
        <div style={{ fontSize:12, color:"var(--text-3)" }}>= R$ {calcValor(item, faturamentoMes).toFixed(2).replace(".",",")}</div>
        <button onClick={function(){ onRemove(item.id); }} style={{ background:"rgba(255,82,82,.12)", border:"none", color:"#FF5252", width:24, height:24, borderRadius:6, cursor:"pointer", fontSize:11, flexShrink:0 }}>✕</button>
      </div>
    );
  }

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:16 }}>

      {/* ── IMPOSTOS — Lucro Real ── */}
      <div style={{ background:"var(--surface)", border:"1px solid rgba(255,82,82,.35)", borderRadius:14, overflow:"hidden" }}>
        <div style={{ background:"rgba(255,82,82,.12)", padding:"10px 14px", borderBottom:"1px solid rgba(255,82,82,.35)", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
          <div>
            <div style={{ fontWeight:700, fontSize:14, color:"#FF5252" }}>📋 Impostos — Regime Lucro Real</div>
            <div style={{ fontSize:11, color:"var(--text-3)", marginTop:1 }}>ICMS por estado, IRPJ e CSLL</div>
          </div>
          <div style={{ textAlign:"right" }}>
            <div style={{ fontSize:11, color:"var(--text-3)" }}>IRPJ+CSLL s/ faturamento</div>
            <div style={{ fontSize:17, fontWeight:800, color:"#FF5252" }}>R$ {totalImpFixo.toFixed(2).replace(".",",")}</div>
          </div>
        </div>

        <div style={{ padding:"14px 18px" }}>
          {/* IRPJ e CSLL */}
          <div style={{ fontSize:11, color:"var(--text-3)", fontWeight:700, textTransform:"uppercase", marginBottom:8 }}>IRPJ e CSLL (sobre o Lucro Real apurado)</div>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:10, marginBottom:14 }}>
            <div>
              <div style={{ fontSize:10, color:"var(--text-3)", marginBottom:4 }}>IRPJ base (%)</div>
              <div style={{ display:"flex", alignItems:"center", gap:4 }}>
                <input type="number" step="0.01" value={irpjPct}
                  onChange={function(e){ salvarIrpjCsll(e.target.value, irpjAdicionalPct, csllPct); }}
                  style={{ width:"100%", background:"var(--bg-2)", border:"1px solid var(--border)", color:"var(--text-strong)", padding:"7px 10px", borderRadius:8, fontSize:13, outline:"none" }} />
                <span style={{ fontSize:12, color:"var(--text-3)" }}>%</span>
              </div>
            </div>
            <div>
              <div style={{ fontSize:10, color:"var(--text-3)", marginBottom:4 }}>IRPJ adicional (%)</div>
              <div style={{ display:"flex", alignItems:"center", gap:4 }}>
                <input type="number" step="0.01" value={irpjAdicionalPct}
                  onChange={function(e){ salvarIrpjCsll(irpjPct, e.target.value, csllPct); }}
                  style={{ width:"100%", background:"var(--bg-2)", border:"1px solid var(--border)", color:"var(--text-strong)", padding:"7px 10px", borderRadius:8, fontSize:13, outline:"none" }} />
                <span style={{ fontSize:12, color:"var(--text-3)" }}>%</span>
              </div>
              <div style={{ fontSize:9, color:"var(--text-4)", marginTop:2 }}>Sobre lucro &gt; R$ 20mil/mês</div>
            </div>
            <div>
              <div style={{ fontSize:10, color:"var(--text-3)", marginBottom:4 }}>CSLL (%)</div>
              <div style={{ display:"flex", alignItems:"center", gap:4 }}>
                <input type="number" step="0.01" value={csllPct}
                  onChange={function(e){ salvarIrpjCsll(irpjPct, irpjAdicionalPct, e.target.value); }}
                  style={{ width:"100%", background:"var(--bg-2)", border:"1px solid var(--border)", color:"var(--text-strong)", padding:"7px 10px", borderRadius:8, fontSize:13, outline:"none" }} />
                <span style={{ fontSize:12, color:"var(--text-3)" }}>%</span>
              </div>
            </div>
          </div>

          {/* ICMS por estado */}
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8 }}>
            <div style={{ fontSize:11, color:"var(--text-3)", fontWeight:700, textTransform:"uppercase" }}>
              ICMS por Estado (alíquota interna de venda)
            </div>
            <div style={{ display:"flex", gap:6 }}>
              <button onClick={resetIcmsPadrao}
                style={{ fontSize:10, color:"#0e7490", background:"rgba(0,240,255,.10)", border:"1px solid rgba(0,240,255,.35)", padding:"3px 8px", borderRadius:6, cursor:"pointer", fontWeight:600 }}>
                ↺ Usar alíquotas padrão
              </button>
              <button onClick={function(){ setShowIcmsTable(function(v){return !v;}); }}
                style={{ fontSize:10, color:"var(--text-2)", background:"var(--bg-2)", border:"1px solid var(--border)", padding:"3px 8px", borderRadius:6, cursor:"pointer", fontWeight:600 }}>
                {showIcmsTable ? "▲ Ocultar tabela" : "▼ Ver/editar todos os 27 estados"}
              </button>
            </div>
          </div>

          {!showIcmsTable ? (
            <div style={{ display:"flex", alignItems:"center", gap:14, background:"var(--bg-2)", border:"1px solid var(--border)", borderRadius:10, padding:"10px 14px" }}>
              <div>
                <div style={{ fontSize:10, color:"var(--text-3)" }}>Estados configurados</div>
                <div style={{ fontSize:16, fontWeight:800, color:"var(--text-strong)" }}>{ufsConfigurados.length}/27</div>
              </div>
              <div style={{ width:1, height:28, background:"var(--surface-3)" }} />
              <div>
                <div style={{ fontSize:10, color:"var(--text-3)" }}>Alíquota média configurada</div>
                <div style={{ fontSize:16, fontWeight:800, color:"#FF5252" }}>{icmsMedioRef.toFixed(2)}%</div>
              </div>
              {ufsConfigurados.length===0 && (
                <div style={{ fontSize:11, color:"#FFC107", marginLeft:"auto" }}>⚠️ Clique em "Usar alíquotas padrão" para começar</div>
              )}
            </div>
          ) : (
            <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:8, maxHeight:340, overflowY:"auto", padding:2 }}>
              {ESTADOS_BR_ICMS.map(function(e){
                var uf = e[0], nome = e[1], padrao = e[2];
                var valorAtual = icmsConfig[uf] !== undefined ? icmsConfig[uf] : "";
                return (
                  <div key={uf} style={{ display:"flex", alignItems:"center", gap:6, background:"var(--bg-2)", border:"1px solid var(--border)", borderRadius:8, padding:"6px 10px" }}>
                    <span style={{ fontSize:11, fontWeight:700, color:"var(--text-strong)", width:26, flexShrink:0 }}>{uf}</span>
                    <span style={{ fontSize:10, color:"var(--text-3)", flex:1, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{nome}</span>
                    <input type="number" step="0.1" placeholder={String(padrao)} value={valorAtual}
                      onChange={function(ev){ setIcmsEstado(uf, ev.target.value); }}
                      style={{ width:50, background:"var(--surface)", border:"1px solid var(--border)", color:"var(--text-strong)", padding:"3px 5px", borderRadius:6, fontSize:11, outline:"none", textAlign:"center" }} />
                    <span style={{ fontSize:10, color:"var(--text-3)" }}>%</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* ── CUSTOS FIXOS DETALHADOS ── */}
      <div style={{ background:"var(--surface)", border:"1px solid rgba(255,193,7,.35)", borderRadius:14, overflow:"hidden" }}>
        <div style={{ background:"rgba(255,193,7,.12)", padding:"10px 14px", borderBottom:"1px solid rgba(255,193,7,.35)", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
          <div>
            <div style={{ fontWeight:700, fontSize:14, color:"#FFC107" }}>🏢 Custos Fixos Detalhados</div>
            <div style={{ fontSize:11, color:"var(--text-3)", marginTop:1 }}>Aluguel, salários, assinaturas, sistemas...</div>
          </div>
          <div style={{ textAlign:"right" }}>
            <div style={{ fontSize:11, color:"var(--text-3)" }}>Total mensal</div>
            <div style={{ fontSize:17, fontWeight:800, color:"#FFC107" }}>R$ {totalFix.toFixed(2).replace(".",",")}</div>
          </div>
        </div>
        <div style={{ padding:"12px 18px" }}>
          {custosFixos.length === 0
            ? <div style={{ fontSize:12, color:"var(--text-3)", padding:"8px 0", textAlign:"center" }}>Nenhum custo fixo cadastrado — adicione abaixo com o valor real (R$) de cada item</div>
            : (
              <div>
                <div style={{ display:"flex", gap:8, padding:"4px 0 8px", borderBottom:"1px solid var(--border)", fontSize:10, color:"var(--text-3)", fontWeight:700, textTransform:"uppercase" }}>
                  <div style={{ flex:1 }}>Custo</div>
                  <div>Valor</div>
                  <div>= R$ mensal</div>
                  <div style={{ width:24 }}></div>
                </div>
                {custosFixos.map(function(c){ return <ItemRow key={c.id} item={c} onRemove={removeCusto} />; })}
              </div>
            )
          }
          <div style={{ display:"flex", gap:6, marginTop:12, alignItems:"center" }}>
            <input value={novoCusto.nome} onChange={function(e){setNovoCusto(function(s){return Object.assign({},s,{nome:e.target.value});});}}
              placeholder="Ex: Aluguel, Funcionário, Sistema..."
              style={{ flex:2, background:"var(--bg-2)", border:"1px solid var(--border)", color:"var(--text-strong)", padding:"7px 10px", borderRadius:8, fontSize:12, outline:"none" }} />
            <div style={{ display:"flex", border:"1px solid var(--border)", borderRadius:8, overflow:"hidden", flexShrink:0 }}>
              {["R$","%"].map(function(t){
                return <button key={t} onClick={function(){setNovoCusto(function(s){return Object.assign({},s,{tipo:t});});}}
                  style={{ padding:"7px 10px", border:"none", cursor:"pointer", fontSize:12, fontWeight:700,
                    background: novoCusto.tipo===t?"#1976FF":"var(--surface)", color: novoCusto.tipo===t?"#fff":"var(--text-2)" }}>{t}</button>;
              })}
            </div>
            <input type="number" step="0.01" value={novoCusto.valor} onChange={function(e){setNovoCusto(function(s){return Object.assign({},s,{valor:e.target.value});});}}
              placeholder={novoCusto.tipo==="R$" ? "0,00" : "0"}
              style={{ width:90, background:"var(--bg-2)", border:"1px solid var(--border)", color:"var(--text-strong)", padding:"7px 10px", borderRadius:8, fontSize:12, outline:"none", flexShrink:0 }} />
            <button onClick={addCusto} disabled={!novoCusto.nome||!novoCusto.valor}
              style={{ background: (novoCusto.nome&&novoCusto.valor)?"#1976FF":"var(--surface-3)", border:"none", color:(novoCusto.nome&&novoCusto.valor)?"#fff":"var(--text-3)",
                fontWeight:700, padding:"7px 16px", borderRadius:8, cursor:(novoCusto.nome&&novoCusto.valor)?"pointer":"not-allowed", fontSize:12, flexShrink:0 }}>+ Adicionar</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════
//  LAYOUT PADRÃO: Filtros lateral esquerda | Conteúdo | Ação direita
// ════════════════════════════════════════════════════════════
function LayoutFiltros({ filtros, busca, acoes, children }) {
  return (
    <div style={{ display:"flex", gap:0, minHeight:"calc(100vh - 180px)" }}>
      {/* Painel lateral — mais estreito e delicado */}
      {filtros && (
        <div style={{ width:168, flexShrink:0, background:"var(--bg-2)", borderRight:"1px solid var(--border-soft)", padding:"8px 8px", display:"flex", flexDirection:"column", gap:10 }}>
          {filtros}
        </div>
      )}
      {/* Área principal */}
      <div style={{ flex:1, minWidth:0, padding:"10px 14px", display:"flex", flexDirection:"column", gap:10 }}>
        {(busca || acoes) && (
          <div style={{ display:"flex", gap:8, alignItems:"center" }}>
            {busca && <div style={{ flex:1 }}>{busca}</div>}
            {acoes && <div style={{ display:"flex", gap:6, flexShrink:0 }}>{acoes}</div>}
          </div>
        )}
        {children}
      </div>
    </div>
  );
}

// FiltroGrupo — dropdown compacto e delicado
function FiltroGrupo({ titulo, children }) {
  const [open, setOpen] = useState(false);
  var activeLabel = null;
  var childArr = Children.toArray(children);
  childArr.forEach(function(child) {
    if (child?.props?.active && child?.props?.label) activeLabel = child.props.label;
  });

  return (
    <div style={{ position:"relative" }}>
      {titulo && (
        <div style={{ fontSize:9, color:"#b0b8c4", fontWeight:700, textTransform:"uppercase", letterSpacing:0.7, marginBottom:4 }}>{titulo}</div>
      )}
      <button
        onClick={function(){ setOpen(function(v){return !v;}); }}
        style={{ width:"100%", display:"flex", justifyContent:"space-between", alignItems:"center",
          padding:"5px 9px", borderRadius:7,
          border:"1px solid "+(activeLabel?"var(--text-4)":"var(--border)"),
          background: activeLabel ? "var(--surface-3)" : "var(--surface)",
          color: activeLabel ? "var(--text-strong)" : "var(--text-3)",
          fontWeight: activeLabel ? 600 : 400, fontSize:11, cursor:"pointer", textAlign:"left",
          transition:"border-color .15s" }}>
        <span style={{ overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", flex:1 }}>
          {activeLabel || "Todos"}
        </span>
        <span style={{ fontSize:8, color:"#c4c9d0", marginLeft:4, flexShrink:0 }}>{open?"▲":"▼"}</span>
      </button>
      {open && (
        <div style={{ position:"absolute", top:"100%", left:0, right:0, marginTop:2,
          background:"var(--surface)", border:"1px solid var(--border)", borderRadius:7,
          boxShadow:"0 6px 20px rgba(0,0,0,.07)", overflow:"hidden", zIndex:100 }}>
          {childArr.map(function(child, i) {
            if (!child) return null;
            return cloneElement(child, {
              key: i,
              onClick: function() {
                if (child.props.onClick) child.props.onClick();
                setOpen(false);
              }
            });
          })}
        </div>
      )}
    </div>
  );
}

// FiltroBotao — opção compacta dentro do dropdown
function FiltroBotao({ label, active, cor, bg, onClick, count }) {
  return (
    <button onClick={onClick}
      style={{ display:"flex", justifyContent:"space-between", alignItems:"center",
        padding:"6px 10px", border:"none", borderBottom:"1px solid var(--border-soft)",
        background: active ? (bg||"var(--surface-3)") : "var(--surface)",
        color: active ? (cor||"var(--text-strong)") : "var(--text-2)",
        fontWeight: active ? 600 : 400, fontSize:11, cursor:"pointer",
        textAlign:"left", width:"100%", transition:"background .1s" }}>
      <span style={{ overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{label}</span>
      {count !== undefined && (
        <span style={{ fontSize:9, fontWeight:600, flexShrink:0, marginLeft:4,
          color: active?(cor||"var(--text-strong)"):"var(--text-3)",
          background: active?"transparent":"var(--surface-3)",
          padding:"1px 5px", borderRadius:8 }}>
          {count}
        </span>
      )}
    </button>
  );
}


// ════════════════════════════════════════════════════════
//  Detecção de Tipo de Envio (ML Brasil)
//  Baseado nos campos oficiais da API ML
// ════════════════════════════════════════════════════════
function detectTipoEnvio(o, shipmentStatuses) {
  var sid = String(o.id);

  // Campos reais da API ML (confirmados com dados reais)
  var lt    = ((shipmentStatuses && shipmentStatuses[sid + "_logistic"]) || o.shipping?.logistic_type || o.logistic_type || "").toLowerCase().trim();
  var mode  = ((shipmentStatuses && shipmentStatuses[sid + "_mode"])    || "").toLowerCase();
  var type  = ((shipmentStatuses && shipmentStatuses[sid + "_type"])    || "").toLowerCase();

  // Tags do pedido
  var allTags = [].concat(o.tags || [], o.orderTags || []).map(function(t){ return String(t).toLowerCase(); });
  var fulfilled = o.fulfilled === true;

  // ══ FULL — ML Fulfillment (galpão ML, logistic_type="fulfillment", fulfilled=true) ══
  // Confirmado: logistic_type="fulfillment" + fulfilled=true + tags=["d2c"...]
  if (lt === "fulfillment" && fulfilled) return "FULL";
  if (lt.includes("fulfillment") && fulfilled) return "FULL";

  // ══ FLEX — Entrega pelo vendedor com rota ML ══
  // Confirmado: logistic_type="self_service" + mode="me2" + fulfilled=true/false
  // "self_service" é o identificador real do Flex no Brasil
  if (lt === "self_service") return "Flex";
  if (lt.includes("self_service")) return "Flex";

  // ══ FULL também pode aparecer como fulfillment sem fulfilled=true em alguns casos ══
  if (lt === "fulfillment") return "FULL";

  // ══ ME2 — Agência (Correios/Jadlog, drop-off) ══
  // logistic_type="xd_drop_off" ou "drop_off", mode="me2" sem self_service
  if (lt.includes("xd_drop_off") || lt === "drop_off" || lt.includes("cross_docking")) return "ME2";
  if (mode === "me2" && lt !== "self_service" && !lt.includes("self_service")) return "ME2";

  // ══ ME1 — Correios coleta no vendedor ══
  if (lt === "me1" || lt.includes("mandatory1") || mode === "me1") return "ME1";

  return null;
}

// Badge visual do tipo de envio
function BadgeTipoEnvio({ tipo }) {
  if (!tipo) return null;
  var cfg = {
    "FULL": { bg:"rgba(77,179,255,.22)", color:"#1976FF", label:"FULL" },
    "Flex": { bg:"rgba(139,92,246,.18)", color:"#7c3aed", label:"Flex" },
    "ME2":  { bg:"rgba(0,240,255,.25)", color:"#0e7490", label:"ME2" },
    "ME1":  { bg:"rgba(0,200,83,.18)", color:"#0a9d4e", label:"ME1" },
  }[tipo];
  if (!cfg) return null;
  return (
    <span style={{ fontSize:10, fontWeight:700, padding:"2px 7px", borderRadius:5,
      background:cfg.bg, color:cfg.color, whiteSpace:"nowrap" }}>{cfg.label}</span>
  );
}


// ════════════════════════════════════════════════════════════
//  ABA PRECIFICAÇÃO — Calculadora vinculada aos anúncios
// ════════════════════════════════════════════════════════════

function NovoProdutoPrecForm({ onSave, onClose, marketplaceInicial, shopeeDoc }) {
  const [f, setF] = useState({ nome:"", sku:"", custo:"", precoVenda:"", frete:"", taxaMl:"12", desconto:"0", marketplace: marketplaceInicial || "ml" });
  var set = function(k,v){ setF(function(p){ return Object.assign({},p,{[k]:v}); }); };
  var ehShopee = f.marketplace === "shopee";
  var custo=parseFloat(f.custo||0), bruto=parseFloat(f.precoVenda||0);
  var taxa = ehShopee ? calcTaxaShopee(bruto, shopeeDoc) : bruto*(parseFloat(f.taxaMl||12)/100);
  var frete=parseFloat(f.frete||0);
  var lucro=bruto-custo-frete-taxa;
  var margem=bruto>0?(lucro/bruto)*100:0;
  var mCor=margem>=20?"#0a9d4e":margem>=0?"#FFC107":"#FF5252";
  return (
    <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
      {/* Marketplace do produto */}
      <div>
        <div style={{ fontSize:10, color:"var(--text-3)", marginBottom:4, fontWeight:600, textTransform:"uppercase" }}>Marketplace</div>
        <div style={{ display:"flex", gap:6 }}>
          {[{k:"ml",l:"🟡 Mercado Livre",c:"#FFC107"},{k:"shopee",l:"🛒 Shopee",c:"#EE4D2D"}].map(function(m){
            var a=f.marketplace===m.k;
            return <button key={m.k} onClick={function(){ set("marketplace",m.k); }}
              style={{ flex:1, background:a?m.c:"var(--surface)", color:a?"#fff":"var(--text-2)", border:"1px solid "+(a?m.c:"var(--border)"), borderRadius:8, padding:"8px", fontSize:12, fontWeight:700, cursor:"pointer" }}>{m.l}</button>;
          })}
        </div>
      </div>
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
        <div>
          <div style={{ fontSize:10, color:"var(--text-3)", marginBottom:3, fontWeight:600, textTransform:"uppercase" }}>Nome do Produto *</div>
          <input value={f.nome} onChange={function(e){set("nome",e.target.value);}} placeholder="Ex: Lanterna Traseira Uno"
            style={{ width:"100%", background:"var(--bg-2)", border:"1px solid var(--border)", color:"var(--text-strong)", padding:"8px 10px", borderRadius:8, fontSize:12, outline:"none" }} />
        </div>
        <div>
          <div style={{ fontSize:10, color:"var(--text-3)", marginBottom:3, fontWeight:600, textTransform:"uppercase" }}>SKU *</div>
          <input value={f.sku} onChange={function(e){set("sku",e.target.value);}} placeholder="Ex: 1234"
            style={{ width:"100%", background:"var(--bg-2)", border:"1px solid var(--border)", color:"var(--text-strong)", padding:"8px 10px", borderRadius:8, fontSize:12, outline:"none", fontFamily:"monospace" }} />
        </div>
        <div>
          <div style={{ fontSize:10, color:"var(--text-3)", marginBottom:3, fontWeight:600, textTransform:"uppercase" }}>Custo (R$)</div>
          <input type="number" step="0.01" value={f.custo} onChange={function(e){set("custo",e.target.value);}} placeholder="0,00"
            style={{ width:"100%", background:"var(--bg-2)", border:"1px solid var(--border)", color:"var(--text-strong)", padding:"8px 10px", borderRadius:8, fontSize:12, outline:"none" }} />
        </div>
        <div>
          <div style={{ fontSize:10, color:"var(--text-3)", marginBottom:3, fontWeight:600, textTransform:"uppercase" }}>Preço de Venda (R$)</div>
          <input type="number" step="0.01" value={f.precoVenda} onChange={function(e){set("precoVenda",e.target.value);}} placeholder="0,00"
            style={{ width:"100%", background:"var(--bg-2)", border:"1px solid var(--border)", color:"var(--text-strong)", padding:"8px 10px", borderRadius:8, fontSize:12, outline:"none" }} />
        </div>
        <div>
          <div style={{ fontSize:10, color:"var(--text-3)", marginBottom:3, fontWeight:600, textTransform:"uppercase" }}>Frete (R$)</div>
          <input type="number" step="0.01" value={f.frete} onChange={function(e){set("frete",e.target.value);}} placeholder="0,00"
            style={{ width:"100%", background:"var(--bg-2)", border:"1px solid var(--border)", color:"var(--text-strong)", padding:"8px 10px", borderRadius:8, fontSize:12, outline:"none" }} />
        </div>
        <div>
          <div style={{ fontSize:10, color:"var(--text-3)", marginBottom:3, fontWeight:600, textTransform:"uppercase" }}>{ehShopee ? "Taxa Shopee" : "Taxa ML (%)"}</div>
          {ehShopee ? (
            <div style={{ background:"var(--bg-2)", border:"1px solid rgba(238,77,45,.35)", color:"#EE4D2D", padding:"8px 10px", borderRadius:8, fontSize:12, fontWeight:700 }}>
              {bruto>0 ? (function(){ var fx=taxaShopeeFaixa(bruto); return (fx.pct*100).toFixed(0)+"% + R$"+fx.fixo+(shopeeDoc==="CPF"?" + R$3":""); })() : "automática por preço"}
            </div>
          ) : (
            <select value={f.taxaMl} onChange={function(e){set("taxaMl",e.target.value);}}
              style={{ width:"100%", background:"var(--bg-2)", border:"1px solid var(--border)", color:"var(--text-2)", padding:"8px 10px", borderRadius:8, fontSize:12 }}>
              <option value="12">12% — Clássico</option>
              <option value="17">17% — Premium</option>
            </select>
          )}
        </div>
      </div>
      {bruto > 0 && custo > 0 && (
        <div style={{ background:"var(--bg-2)", border:"1px solid var(--border)", borderRadius:8, padding:"10px 14px", display:"flex", gap:16 }}>
          <div><div style={{ fontSize:10, color:"var(--text-3)" }}>Lucro</div><div style={{ fontWeight:700, color:lucro>=0?"#0e7490":"#FF5252" }}>R$ {lucro.toFixed(2).replace(".",",")}</div></div>
          <div><div style={{ fontSize:10, color:"var(--text-3)" }}>Margem</div><div style={{ fontWeight:700, color:mCor }}>{margem.toFixed(1)}%</div></div>
          <div><div style={{ fontSize:10, color:"var(--text-3)" }}>Taxa {ehShopee?"Shopee":"ML"}</div><div style={{ fontWeight:700, color:"#FF5252" }}>R$ {taxa.toFixed(2).replace(".",",")}</div></div>
        </div>
      )}
      <div style={{ display:"flex", gap:8, marginTop:4 }}>
        <button onClick={onClose} style={{ flex:1, background:"var(--bg-2)", border:"1px solid var(--border)", color:"var(--text-2)", fontWeight:600, padding:"9px", borderRadius:9, cursor:"pointer" }}>Cancelar</button>
        <button onClick={function(){ if(f.nome&&f.sku) onSave(f); }} disabled={!f.nome||!f.sku}
          style={{ flex:2, background:f.nome&&f.sku?"#7c3aed":"var(--surface-3)", border:"none", color:f.nome&&f.sku?"#fff":"var(--text-3)", fontWeight:700, padding:"9px", borderRadius:9, cursor:f.nome&&f.sku?"pointer":"not-allowed" }}>
          Salvar e Acompanhar
        </button>
      </div>
    </div>
  );
}

function PrecificacaoTab({ enriched, costs, setCostsAndSave, fretesConfig, setFretesAndSave, descontosConfig, setDescontosAndSave, precosVendaConfig, setPrecosVendaAndSave, pendentesAtualizacao, setPendentesAndSave, setSkuOverridesAndSave, rawOrders }) {
  const [busca, setBusca] = useState("");
  const [buscaTipo, setBuscaTipo] = useState("all"); // all | title | sku | mlb
  const [margemAlvo, setMargemAlvo] = useState(20);
  // Casa um item (anúncio ou produto novo) com a busca conforme o tipo escolhido.
  function casaBusca(sku, id, titulo) {
    var q = busca.trim().toLowerCase();
    if (!q) return true;
    var s = (sku||"").toLowerCase(), m = (id||"").toLowerCase(), t = (titulo||"").toLowerCase();
    if (buscaTipo === "title") return t.includes(q);
    if (buscaTipo === "sku")   return s === q;               // SKU exato
    if (buscaTipo === "mlb")   return m.includes(q);
    return t.includes(q) || m.includes(q) || s.includes(q);  // tudo
  }
  const [selectedId, setSelectedId] = useState(null);
  const [editingFreteId, setEditingFreteId] = useState(null);
  const [editingDescId, setEditingDescId] = useState(null);
  const [editingSkuId, setEditingSkuId] = useState(null);
  const [custosLocais, setCustosLocais] = useState({});
  // Sub-aba do marketplace (Mercado Livre / Shopee) e tipo de documento p/ a taxa da Shopee.
  const [mktSel, setMktSel] = useState("ml");
  const [shopeeDoc, setShopeeDoc] = useState(function(){ try { return localStorage.getItem("shopee_doc") || "CNPJ"; } catch { return "CNPJ"; } });
  function setShopeeDocSave(v){ setShopeeDoc(v); try { localStorage.setItem("shopee_doc", v); } catch {} }
  function setDesconto(id, pct) {
    setDescontosAndSave(function(prev){ return Object.assign({}, prev, { [id]: pct }); });
  }
  // Salva o SKU editado: produto novo atualiza o próprio cadastro; anúncio do ML grava um
  // override local (sku_overrides) que passa a valer na tela.
  function salvarSku(l, valor) {
    var novo = (valor || "").trim();
    if (l._isExtra) {
      saveProdutosExtras(produtosExtras.map(function(x){ return x.id === l.id ? Object.assign({}, x, { sku: novo }) : x; }));
    } else if (setSkuOverridesAndSave) {
      setSkuOverridesAndSave(function(prev){ return Object.assign({}, prev, { [l.id]: novo }); });
    }
  }
  // Preços de venda sugeridos (digitados pelo usuário)
  const [editingPrecoId, setEditingPrecoId] = useState(null);
  const [showNovoProdutoPrec, setShowNovoProdutoPrec] = useState(false);
  const [produtosExtras, setProdutosExtras] = useState(function(){
    try { return JSON.parse(localStorage.getItem("precificacao_extras")||"[]"); } catch { return []; }
  });
  function saveProdutosExtras(next) {
    setProdutosExtras(next);
    try { localStorage.setItem("precificacao_extras", JSON.stringify(next)); } catch {}
    // Envia na hora para o servidor (KV) — sem esperar o ciclo de 15s — para que os
    // outros usuários vejam o produto precificado imediatamente.
    kvSyncPush("precificacao_extras", next);
  }
  // Produto precificado por OUTRO usuário chegou pela sincronização → mostra na hora aqui também.
  useEffect(function(){
    function aoSincronizar(e){
      if (!e.detail || e.detail.key !== "precificacao_extras") return;
      var v = e.detail.value;
      if (Array.isArray(v)) setProdutosExtras(v);
    }
    window.addEventListener("mlmargem-sync", aoSincronizar);
    return function(){ window.removeEventListener("mlmargem-sync", aoSincronizar); };
  }, []);
  // Quando o ANÚNCIO do produto novo é criado no ML (mesmo SKU), a precificação que o usuário
  // fez ANTES é transferida para o anúncio (custo, preço de venda, desconto e frete, por MLB) e o
  // item "Novo" é absorvido — some da lista, sem virar cadastro duplicado. Casa por SKU + tipo
  // (Clássico/Premium) para respeitar variações; se não achar o tipo, casa só pelo SKU.
  useEffect(function(){
    if (!enriched || !produtosExtras.length) return;
    var restantes = [];
    var addCosts = {}, addPrecos = {}, addDesc = {}, addFretes = {};
    var absorvidos = 0;
    produtosExtras.forEach(function(p){
      var skuP = (p.sku||"").trim().toLowerCase();
      // Só absorve produto do Mercado Livre em anúncio do ML. Produtos da Shopee ficam como estão
      // (a integração com a Shopee ainda não traz os anúncios para casar).
      if (!skuP || (p.marketplace && p.marketplace !== "ml")) { restantes.push(p); return; }
      var pPrem = parseFloat(p.taxaMl||12) >= 17;
      function bateSku(l){ return !l._isExtra && (l.seller_sku||l.sku||"").trim().toLowerCase() === skuP; }
      var match = enriched.find(function(l){
        if (!bateSku(l)) return false;
        var lPrem = l.listing_type_id === "gold_pro" || l.listing_type_id === "gold_premium";
        return lPrem === pPrem;
      }) || enriched.find(bateSku);
      if (!match) { restantes.push(p); return; }
      absorvidos++;
      // Transfere a precificação do produto novo para o anúncio (só se o anúncio ainda não tiver).
      var custoExtra = parseFloat(costs && costs[p.id]) || 0;
      if (custoExtra > 0 && !(costs && costs[match.id] > 0)) addCosts[match.id] = custoExtra;
      if (p.precoVenda && !(precosVendaConfig && precosVendaConfig[match.id])) addPrecos[match.id] = p.precoVenda;
      var descExtra = descontosConfig && descontosConfig[p.id];
      if (descExtra && !(descontosConfig && descontosConfig[match.id])) addDesc[match.id] = descExtra;
      if (p.frete && !(fretesConfig && fretesConfig[match.id])) addFretes[match.id] = parseFloat(p.frete) || 0;
      // não vai para "restantes" → o produto novo é absorvido pelo anúncio real
    });
    if (absorvidos > 0) {
      if (Object.keys(addCosts).length) setCostsAndSave(function(c){ return Object.assign({}, c, addCosts); });
      if (Object.keys(addPrecos).length) setPrecosVendaAndSave(function(c){ return Object.assign({}, c, addPrecos); });
      if (Object.keys(addDesc).length) setDescontosAndSave(function(c){ return Object.assign({}, c, addDesc); });
      if (Object.keys(addFretes).length) setFretesAndSave(function(c){ return Object.assign({}, c, addFretes); });
      saveProdutosExtras(restantes);
    }
  }, [enriched]);
  function setPrecoVenda(id, preco) {
    setPrecosVendaAndSave(function(prev){ return Object.assign({}, prev, { [id]: preco }); });
    // Marca como pendente de atualização no ML (preço simulado != preço atual)
    marcarPendente(id, preco);
  }

  // ── Controle de "pendente de atualização no ML" ──
  function salvarPendentes(next) {
    setPendentesAndSave(next);
  }
  function marcarPendente(id, novoPreco) {
    // Descobre o item (anúncio do ML OU produto novo Shopee/ML) e seu marketplace.
    var listing = (enriched||[]).find(function(l){ return l.id===id; });
    var mkt = "ml", precoAtual, titulo;
    if (listing) {
      precoAtual = listing.price; titulo = listing.title; mkt = "ml";
    } else {
      var extra = (produtosExtras||[]).find(function(p){ return p.id===id; });
      if (!extra) return;
      precoAtual = parseFloat(extra.precoVenda) || 0; titulo = extra.nome; mkt = extra.marketplace || "ml";
    }
    var next = Object.assign({}, pendentesAtualizacao);
    if (novoPreco > 0 && novoPreco !== precoAtual) {
      next[id] = { precoAntigo: precoAtual, precoNovo: novoPreco, data: new Date().toISOString(), titulo: titulo, marketplace: mkt };
    } else {
      delete next[id];
    }
    salvarPendentes(next);
  }
  function confirmarAtualizado(id) {
    var next = Object.assign({}, pendentesAtualizacao);
    delete next[id];
    salvarPendentes(next);
  }
  // Detectar automaticamente quando o preço do ML já bateu com o simulado (resolve sozinho)
  useEffect(function(){
    var next = Object.assign({}, pendentesAtualizacao);
    var mudou = false;
    Object.keys(next).forEach(function(id){
      var listing = (enriched||[]).find(function(l){ return l.id===id; });
      var extra = (produtosExtras||[]).find(function(p){ return p.id===id; });
      var precoAtual = listing ? listing.price : (extra ? parseFloat(extra.precoVenda) || 0 : null);
      if (precoAtual !== null && precoAtual === next[id].precoNovo) {
        delete next[id];
        mudou = true;
      }
    });
    if (mudou) salvarPendentes(next);
  }, [enriched, produtosExtras]);

  const [buscaSku, setBuscaSku] = useState("");

  // Anúncios reais do ML só aparecem na sub-aba Mercado Livre (todos são do ML).
  var listsFiltrados = (mktSel === "ml" ? (enriched||[]) : []).filter(function(l) {
    return casaBusca(l.seller_sku||l.sku, l.id, l.title);
  });

  // Novos produtos (ainda sem anúncio) viram "pseudo-anúncios" na MESMA tabela, filtrados pela
  // sub-aba do marketplace (Mercado Livre / Shopee). A precificação usa os mesmos configs por id.
  var extrasPseudo = (produtosExtras||[]).filter(function(p){
    return !p.vinculado && ((p.marketplace||"ml") === mktSel);
  }).map(function(p){
    return {
      id: p.id, seller_sku: p.sku, sku: p.sku, title: p.nome,
      price: parseFloat(p.precoVenda) || 0,
      listing_type_id: (parseFloat(p.taxaMl||12) >= 17) ? "gold_pro" : "gold_special",
      freteSeller: parseFloat(p.frete) || 0,
      status: "active", _isExtra: true, marketplace: p.marketplace || "ml",
    };
  });
  if (busca.trim()) {
    extrasPseudo = extrasPseudo.filter(function(p){ return casaBusca(p.sku, p.id, p.title); });
  }
  listsFiltrados = extrasPseudo.concat(listsFiltrados);

  function calcPrecos(bruto, custo, frete, taxa, precoVendaCustom) {
    // Se tem preço de venda customizado, usa ele; senão usa o preço atual do anúncio
    var precoBase = precoVendaCustom > 0 ? precoVendaCustom : bruto;
    // Recalcular taxa proporcional ao novo preço
    var taxaBase = precoVendaCustom > 0 && bruto > 0 ? taxa * (precoVendaCustom / bruto) : taxa;
    var lucro = precoBase - custo - frete - taxaBase;
    var margem = precoBase > 0 ? (lucro / precoBase) * 100 : 0;
    var precoAlvo = custo > 0 ? (custo + frete) / (1 - (margemAlvo/100) - (taxaBase/precoBase||0.13)) : 0;
    return { lucro, margem, precoAlvo, taxaBase };
  }

  // Preço médio real das últimas vendas
  function precoMedioVendas(listingId) {
    var vendas = (rawOrders||[]).filter(function(o){return o.listing_id===listingId && o.status==="paid";});
    if (!vendas.length) return null;
    return vendas.reduce(function(s,o){return s+o.price;},0) / vendas.length;
  }

  return (
    <div style={{ padding:"0 20px" }}>
      <div style={{ padding:"12px 0 8px", borderBottom:"1px solid var(--border)", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
        <div>
          <div style={{ fontWeight:800, fontSize:20, color:"var(--text-strong)", marginBottom:4 }}>💲 Precificação</div>
          <div style={{ fontSize:13, color:"var(--text-2)" }}>Calcule o preço ideal para cada anúncio com base na margem desejada</div>
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:7, background:"var(--bg-2)", border:"1px solid var(--border)", borderRadius:10, padding:"10px 16px" }}>
          <span style={{ fontSize:13, color:"var(--text-2)", fontWeight:600 }}>Margem alvo:</span>
          <input type="number" min="1" max="99" value={margemAlvo} onChange={function(e){setMargemAlvo(parseFloat(e.target.value)||20);}}
            style={{ width:60, background:"var(--surface)", border:"1px solid var(--border)", color:"var(--text-strong)", padding:"6px 10px", borderRadius:8, fontSize:15, fontWeight:700, outline:"none", textAlign:"center" }} />
          <span style={{ fontSize:15, fontWeight:700, color:"var(--text-strong)" }}>%</span>
        </div>
      </div>

      {/* Sub-abas do marketplace + (Shopee) seletor CNPJ/CPF */}
      <div style={{ display:"flex", alignItems:"center", gap:2, borderBottom:"2px solid var(--border)", margin:"12px 0 4px" }}>
        {[
          { key:"ml",     label:"🟡 Mercado Livre", cor:"#FFC107" },
          { key:"shopee", label:"🛒 Shopee",        cor:"#EE4D2D" },
        ].map(function(m){
          var ativo = mktSel === m.key;
          return (
            <button key={m.key} onClick={function(){ setMktSel(m.key); }}
              style={{ display:"flex", alignItems:"center", gap:6, padding:"9px 18px", border:"none",
                borderBottom: ativo ? "2px solid "+m.cor : "2px solid transparent", marginBottom:-2,
                background:"transparent", color: ativo ? "var(--text-strong)" : "var(--text-3)",
                fontWeight: ativo?700:500, fontSize:13, cursor:"pointer", fontFamily:"inherit" }}>
              {m.label}
            </button>
          );
        })}
        {mktSel === "shopee" && (
          <div style={{ marginLeft:"auto", display:"flex", alignItems:"center", gap:6 }}>
            <span style={{ fontSize:11, color:"var(--text-3)", fontWeight:600 }}>Taxa como:</span>
            {["CNPJ","CPF"].map(function(d){
              var ativo = shopeeDoc === d;
              return (
                <button key={d} onClick={function(){ setShopeeDocSave(d); }}
                  style={{ background: ativo?"#EE4D2D":"var(--surface)", color: ativo?"#fff":"var(--text-2)",
                    border:"1px solid "+(ativo?"#EE4D2D":"var(--border)"), borderRadius:16,
                    padding:"3px 12px", fontSize:11, fontWeight:700, cursor:"pointer" }}>{d}</button>
              );
            })}
          </div>
        )}
      </div>

      {/* Banner de avisos — preços pendentes de atualização, filtrados pelo marketplace da aba ativa */}
      {(function(){
        var nomeMkt = mktSel === "shopee" ? "na Shopee" : "no Mercado Livre";
        var pendentesDoMkt = Object.entries(pendentesAtualizacao).filter(function([id, p]){ return (p.marketplace || "ml") === mktSel; });
        if (pendentesDoMkt.length === 0) return null;
        return (
        <div style={{ background:"rgba(255,193,7,.12)", border:"1px solid rgba(255,193,7,.35)", borderRadius:10, padding:"12px 16px", margin:"12px 0" }}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8 }}>
            <div style={{ fontSize:13, fontWeight:700, color:"#FFC107" }}>
              ⚠️ {pendentesDoMkt.length} anúncio(s) com preço pendente de atualização {nomeMkt}
            </div>
          </div>
          <div style={{ display:"flex", flexDirection:"column", gap:6, maxHeight:160, overflowY:"auto" }}>
            {pendentesDoMkt.map(function([id, p]){
              var listingRef = (enriched||[]).find(function(l){ return l.id===id; });
              var extraRef = (produtosExtras||[]).find(function(x){ return x.id===id; });
              var skuRef = listingRef?.sku || extraRef?.sku || p.sku || "—";
              var tipoPrem = listingRef && (listingRef.listing_type_id==="gold_pro" || listingRef.listing_type_id==="gold_premium");
              var ehShopee = (p.marketplace || "ml") === "shopee";
              // Valor riscado = preço BRUTO (anunciar por): o preço de venda desejado (precoNovo)
              // acrescido do % de desconto da promoção, mesma fórmula da coluna "Anunciar por".
              var descItem = parseFloat(descontosConfig && descontosConfig[id] || 0);
              var precoBruto = descItem > 0 ? p.precoNovo / (1 - descItem/100) : p.precoNovo;
              return (
                <div key={id} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", background:"var(--surface)", border:"1px solid rgba(255,193,7,.35)", borderRadius:8, padding:"7px 12px" }}>
                  <div style={{ flex:1, minWidth:0, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", fontSize:12, color:"var(--text-strong)" }}>
                    <span style={{ fontWeight:700, color:"#FFC107", marginRight:6 }}>SKU {skuRef}</span>
                    {listingRef && (
                      <span style={{ fontSize:9, fontWeight:700, padding:"1px 6px", borderRadius:4, marginRight:6, whiteSpace:"nowrap",
                        background: tipoPrem?"rgba(139,92,246,.18)":"rgba(59,140,255,.18)",
                        color: tipoPrem?"#a78bfa":"#1976FF" }}>
                        {tipoPrem?"⭐ Premium 17%":"📋 Clássico 12%"}
                      </span>
                    )}
                    {p.titulo}
                  </div>
                  <div style={{ display:"flex", alignItems:"center", gap:10, flexShrink:0 }}>
                    {precoBruto > p.precoNovo + 0.001 && (
                      <span style={{ fontSize:11, color:"var(--text-3)", textDecoration:"line-through" }}>R$ {precoBruto.toFixed(2).replace(".",",")}</span>
                    )}
                    <span style={{ fontSize:12, fontWeight:700, color:"#7c3aed" }}>→ R$ {p.precoNovo.toFixed(2).replace(".",",")}</span>
                    {!ehShopee && (
                      <a href={"https://www.mercadolivre.com.br/seller-admin/listing/edit?itemId="+id} target="_blank" rel="noreferrer"
                        style={{ fontSize:11, color:"#0e7490", textDecoration:"none", fontWeight:600, whiteSpace:"nowrap" }}>
                        Editar no ML ↗
                      </a>
                    )}
                    {ehShopee && (
                      <a href="https://seller.shopee.com.br/portal/product/list/all" target="_blank" rel="noreferrer"
                        style={{ fontSize:11, color:"#EE4D2D", textDecoration:"none", fontWeight:600, whiteSpace:"nowrap" }}>
                        Editar na Shopee ↗
                      </a>
                    )}
                    <button onClick={function(){ confirmarAtualizado(id); }}
                      style={{ background:"#0a9d4e", border:"none", color:"#fff", fontWeight:700, padding:"4px 10px", borderRadius:6, cursor:"pointer", fontSize:11, whiteSpace:"nowrap" }}>
                      ✓ Já atualizei
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        );
      })()}

      {/* Botão novo produto + Busca */}
      <div style={{ display:"flex", gap:7, margin:"14px 0", alignItems:"center" }}>
        <button onClick={function(){ setShowNovoProdutoPrec(true); }}
          style={{ background:"#7c3aed", border:"none", color:"#fff", fontWeight:700, padding:"9px 14px", borderRadius:9, cursor:"pointer", fontSize:12, whiteSpace:"nowrap", flexShrink:0 }}>
          + Precificar Novo Produto
        </button>
        <div style={{ position:"relative", flex:1 }}>
          <span style={{ position:"absolute", left:12, top:"50%", transform:"translateY(-50%)", color:"var(--text-3)", fontSize:14 }}>🔍</span>
          <input value={busca} onChange={function(e){setBusca(e.target.value);}} placeholder="Buscar por título, MLB ou SKU..."
            style={{ width:"100%", background:"var(--surface)", border:"1px solid var(--border)", color:"var(--text-strong)", padding:"10px 14px 10px 36px", borderRadius:10, fontSize:13, outline:"none" }} />
          {busca && (
            <button onClick={function(){setBusca("");}} style={{ position:"absolute", right:10, top:"50%", transform:"translateY(-50%)", background:"none", border:"none", color:"var(--text-3)", cursor:"pointer", fontSize:18, lineHeight:1 }}>×</button>
          )}
        </div>
        <select value={buscaTipo} onChange={function(e){setBuscaTipo(e.target.value);}}
          style={{ background:"var(--surface)", border:"1px solid var(--border)", color:"var(--text-strong)", padding:"10px 12px", borderRadius:10, fontSize:12, outline:"none", cursor:"pointer", flexShrink:0 }}>
          <option value="all">Tudo</option>
          <option value="title">Título</option>
          <option value="sku">SKU (exato)</option>
          <option value="mlb">MLB</option>
        </select>
        <div style={{ display:"flex", alignItems:"center", gap:8, background:"var(--bg-2)", border:"1px solid var(--border)", borderRadius:10, padding:"0 14px", fontSize:12, color:"var(--text-2)", whiteSpace:"nowrap" }}>
          {listsFiltrados.length} anúncio(s)
        </div>
      </div>

      {/* Modal novo produto para precificação */}
      {showNovoProdutoPrec && (
        <div style={{ position:"fixed", inset:0, background:"rgba(15,23,42,.5)", zIndex:600, display:"flex", alignItems:"center", justifyContent:"center", padding:16 }}>
          <div style={{ background:"var(--surface)", borderRadius:14, width:480, padding:20 }}>
            <div style={{ fontWeight:700, fontSize:15, marginBottom:14 }}>+ Precificar Novo Produto</div>
            <NovoProdutoPrecForm
              marketplaceInicial={mktSel}
              shopeeDoc={shopeeDoc}
              onSave={function(p){
                var id = "NOVO_" + Date.now();
                saveProdutosExtras([...produtosExtras, { id:id, nome:p.nome, sku:p.sku, taxaMl:p.taxaMl, precoVenda:p.precoVenda, frete:p.frete, marketplace:p.marketplace||"ml" }]);
                // Custo vai para o mesmo lugar dos anúncios (costs_config) → mesma regra e edição.
                var custoNum = parseFloat(p.custo) || 0;
                if (custoNum > 0) setCostsAndSave(function(c){ return Object.assign({}, c, { [id]: custoNum }); });
                // Se o usuário criou na aba Shopee, garante que a tabela mostre a aba certa.
                if (p.marketplace) setMktSel(p.marketplace);
                setShowNovoProdutoPrec(false);
              }}
              onClose={function(){ setShowNovoProdutoPrec(false); }}
            />
          </div>
        </div>
      )}

      {/* Produtos extras (ainda não anunciados) */}
      {/* Tabela */}
      <div className="scroll-x" style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:12, overflow:"auto" }}>
        <table style={{ borderCollapse:"collapse", width:"100%", minWidth:900 }}>
          <thead>
            <tr style={{ background:"var(--bg-2)" }}>
              {[
                "SKU","MLB","Tipo","Anúncio",
                "Custo","Preço Atual","Frete Real","Frete Config.",
                "💡 Vender por → Anunciar por","🏷 % Desc. Promoção",
                "Taxa ML (s/ desconto)",
                "Lucro Simulado","Margem Simulada","Ação"
              ].map(function(h){
                var isSimul = ["💡 Vender por → Anunciar por","Lucro Simulado","Margem Simulada","Taxa ML (s/ desconto)"].includes(h);
                return <th key={h} style={{ fontSize:10, color: isSimul?"#7c3aed":"var(--text-2)", fontWeight:600, textTransform:"uppercase", padding:"8px 10px", borderBottom:"1px solid var(--border)", textAlign:"left", whiteSpace:"nowrap", background: isSimul?"rgba(139,92,246,.12)":"transparent" }}>{h}</th>;
              })}
            </tr>
          </thead>
          <tbody>
            {listsFiltrados.slice(0,200).map(function(l, i) {
              var custo = custosLocais[l.id] !== undefined ? custosLocais[l.id] : (costs[l.id]||0);
              var bruto = l.price || 0;
              var taxa = l.fee || bruto * 0.13;
              var freteReal = l.freteSeller || 0;
              var freteConfig = parseFloat(fretesConfig&&fretesConfig[l.id]||0);
              var frete = freteConfig > 0 ? freteConfig : freteReal;
              var precoVendaDesejado = parseFloat(precosVendaConfig&&precosVendaConfig[l.id]||0);
              var descPct = parseFloat(descontosConfig&&descontosConfig[l.id]||0);

              // Preço a ANUNCIAR: se o usuário definiu o preço de venda desejado (o que o cliente
              // deve pagar depois do desconto), calculamos o preço de anúncio necessário para que,
              // após aplicar o % de desconto da promoção, o cliente pague exatamente esse valor.
              var precoParaAnunciar = precoVendaDesejado > 0
                ? (descPct > 0 ? precoVendaDesejado / (1 - descPct/100) : precoVendaDesejado)
                : 0;
              // Preço base para exibição/comparação (o que está ou ficará anunciado)
              var precoBase = precoParaAnunciar > 0 ? precoParaAnunciar : bruto;
              // Preço que o cliente efetivamente paga (com desconto aplicado)
              var precoComDesc = precoVendaDesejado > 0 ? precoVendaDesejado : (descPct > 0 ? bruto * (1 - descPct/100) : bruto);
              // Taxa ML padronizada por tipo de anúncio: Clássico 12% / Premium 17%.
              var _tipo = l.listing_type_id || "";
              var ehShopee = (mktSel === "shopee") || (l.marketplace === "shopee");
              var feeRate, taxaSobreDesc;
              if (ehShopee) {
                // Taxa da Shopee: comissão % + tarifa fixa por faixa (varia com o preço final).
                taxaSobreDesc = calcTaxaShopee(precoComDesc, shopeeDoc);
                feeRate = precoComDesc > 0 ? (taxaSobreDesc / precoComDesc) : 0;
              } else {
                // Taxa ML padronizada por tipo: Clássico 12% / Premium 17%.
                feeRate = (_tipo === "gold_premium" || _tipo === "gold_pro") ? 0.17 : 0.12;
                taxaSobreDesc = precoComDesc * feeRate;
              }
              // Lucro e margem com desconto e frete
              var lucroFinal = precoComDesc - custo - frete - taxaSobreDesc;
              var margemFinal = precoComDesc > 0 ? (lucroFinal/precoComDesc)*100 : 0;
              var mCor = margemFinal >= margemAlvo ? "#0a9d4e" : margemFinal >= margemAlvo*0.6 ? "#FFC107" : "#FF5252";
              var isEditing = selectedId === l.id;
              var t = l.listing_type_id||"";
              var isPremium = t==="gold_premium"||t==="gold_pro";

              return (
                <tr key={l.id} style={{ borderBottom:"1px solid var(--border)", background:i%2===0?"var(--surface)":"var(--bg-2)" }}>

                  {/* SKU — editável */}
                  <td style={{ padding:"6px 8px" }}>
                    {editingSkuId === l.id ? (
                      <input type="text" defaultValue={l.seller_sku||l.sku||""} autoFocus
                        onChange={function(e){ salvarSku(l, e.target.value); }}
                        onBlur={function(){ setEditingSkuId(null); }}
                        onKeyDown={function(e){ if(e.key==="Enter"||e.key==="Escape"){ setEditingSkuId(null); } }}
                        style={{ width:80, background:"var(--surface)", border:"1px solid #0e7490", color:"var(--text-strong)", padding:"2px 6px", borderRadius:4, fontSize:11, fontFamily:"monospace", outline:"none" }} />
                    ) : (
                      <span onClick={function(){ setEditingSkuId(l.id); }} title="Clique para editar o SKU"
                        style={{ cursor:"pointer", fontSize:11, fontFamily:"monospace", fontWeight:700, color:"var(--text-2)", background:"var(--surface-3)", padding:"2px 6px", borderRadius:4, whiteSpace:"nowrap", display:"inline-flex", alignItems:"center", gap:4 }}>
                        {l.seller_sku||l.sku||"—"}
                        <span style={{ color:"#0e7490", fontSize:9 }}>✎</span>
                      </span>
                    )}
                  </td>

                  {/* MLB */}
                  <td style={{ padding:"6px 8px", fontSize:11, color:"#0e7490", fontFamily:"monospace" }}>
                    {l._isExtra
                      ? <span style={{ fontSize:10, fontWeight:700, color:"#FFC107", background:"rgba(255,193,7,.12)", border:"1px solid rgba(255,193,7,.35)", padding:"2px 7px", borderRadius:5, whiteSpace:"nowrap" }}>🆕 Novo</span>
                      : l.id}
                  </td>

                  {/* Tipo */}
                  <td style={{ padding:"6px 8px" }}>
                    {ehShopee ? (
                      <span style={{ fontSize:10, fontWeight:700, padding:"2px 6px", borderRadius:5, whiteSpace:"nowrap",
                        background:"rgba(238,77,45,.14)", color:"#EE4D2D", border:"1px solid rgba(238,77,45,.4)" }}>
                        🛒 Shopee
                      </span>
                    ) : (
                      <span style={{ fontSize:10, fontWeight:700, padding:"2px 6px", borderRadius:5, whiteSpace:"nowrap",
                        background: isPremium?"rgba(139,92,246,.14)":"rgba(59,140,255,.14)",
                        color: isPremium?"#7c3aed":"#1976FF",
                        border:"1px solid "+(isPremium?"rgba(139,92,246,.35)":"rgba(77,179,255,.35)") }}>
                        {isPremium?"⭐ Premium":"📋 Clássico"}
                      </span>
                    )}
                  </td>

                  {/* Anúncio */}
                  <td style={{ padding:"6px 8px", maxWidth:220, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                    <div style={{ fontSize:12, fontWeight:600, color:"var(--text-strong)" }}>{l.title}</div>
                  </td>

                  {/* Custo (editável) */}
                  <td style={{ padding:"6px 8px" }}>
                    {isEditing ? (
                      <input type="number" step="0.01" defaultValue={custo}
                        onChange={function(e){ var v=parseFloat(e.target.value)||0; setCustosLocais(function(c){return {...c,[l.id]:v};}); setCostsAndSave(function(c){return {...c,[l.id]:v};}); }}
                        onBlur={function(){ setSelectedId(null); }}
                        onKeyDown={function(e){ if(e.key==="Enter"){ e.target.blur(); } }}
                        autoFocus
                        style={{ width:72, background:"var(--surface)", border:"1px solid #0e7490", color:"var(--text-strong)", padding:"3px 6px", borderRadius:6, fontSize:12, outline:"none" }} />
                    ) : (
                      <span onClick={function(){setSelectedId(l.id);}} title="Clique para editar custo"
                        style={{ cursor:"pointer", fontSize:12, fontWeight:600, color:custo>0?"var(--text-2)":"#FF5252",
                          background:custo>0?"transparent":"rgba(255,82,82,.12)", padding:custo>0?"0":"2px 6px", borderRadius:4 }}>
                        {custo>0?"R$ "+custo.toFixed(2).replace(".",","): "✎ Sem custo"}
                      </span>
                    )}
                  </td>

                  {/* Preço Atual */}
                  <td style={{ padding:"6px 8px", fontSize:12, fontWeight:700, color:"var(--text-strong)", whiteSpace:"nowrap" }}>
                    R$ {bruto.toFixed(2).replace(".",",")}
                  </td>

                  {/* Frete Real */}
                  <td style={{ padding:"6px 8px", fontSize:12, color:"#FFC107", whiteSpace:"nowrap" }}>
                    R$ {freteReal.toFixed(2).replace(".",",")}
                  </td>

                  {/* Frete Config (editável) */}
                  <td style={{ padding:"6px 8px" }}>
                    {editingFreteId === l.id ? (
                      <input type="number" step="0.01" min="0" defaultValue={freteConfig||""} placeholder="0,00"
                        onBlur={function(e){ var v=parseFloat(e.target.value)||0; setFretesAndSave(function(f){return Object.assign({},f,{[l.id]:v});}); setEditingFreteId(null); }}
                        autoFocus
                        style={{ width:72, background:"var(--surface)", border:"1px solid #0e7490", color:"var(--text-strong)", padding:"3px 6px", borderRadius:6, fontSize:12, outline:"none" }} />
                    ) : (
                      <span onClick={function(){setEditingFreteId(l.id);}} title="Frete esperado"
                        style={{ cursor:"pointer", fontSize:12, fontWeight:600,
                          color:freteConfig>0?"#FFC107":"var(--text-3)",
                          background:freteConfig>0?"transparent":"var(--bg-2)",
                          padding:freteConfig>0?"0":"2px 6px", borderRadius:4 }}>
                        {freteConfig>0?"R$ "+freteConfig.toFixed(2).replace(".",","):"✎ definir"}
                      </span>
                    )}
                  </td>

                  {/* 💡 Preço de Venda Desejado → Preço a Anunciar (editável) */}
                  <td style={{ padding:"6px 8px", background:"rgba(139,92,246,.12)" }}>
                    {editingPrecoId === l.id ? (
                      <div style={{ display:"flex", flexDirection:"column", gap:2 }}>
                        <span style={{ fontSize:9, color:"var(--text-3)" }}>Vender por (c/ desconto):</span>
                        <div style={{ display:"flex", alignItems:"center", gap:3 }}>
                          <span style={{ fontSize:10, color:"var(--text-3)" }}>R$</span>
                          <input type="number" step="0.01" min="0"
                            defaultValue={precoVendaDesejado||""}
                            placeholder={bruto.toFixed(2)}
                            autoFocus
                            onBlur={function(e){ var v=parseFloat(e.target.value)||0; setPrecoVenda(l.id,v); setEditingPrecoId(null); }}
                            onKeyDown={function(e){ if(e.key==="Enter"||e.key==="Escape") e.target.blur(); }}
                            style={{ width:78, background:"var(--surface)", border:"1px solid #7c3aed", color:"var(--text-strong)", padding:"3px 6px", borderRadius:6, fontSize:12, outline:"none", textAlign:"right" }} />
                        </div>
                      </div>
                    ) : (
                      <div onClick={function(){ setEditingPrecoId(l.id); }} title="Clique para definir o preço de venda que você quer receber (já com desconto) — o sistema calcula o preço a anunciar" style={{ cursor:"pointer" }}>
                        {precoVendaDesejado > 0 ? (
                          <div>
                            <span style={{ fontSize:13, fontWeight:800, color:"#7c3aed" }}>
                              📢 R$ {precoParaAnunciar.toFixed(2).replace(".",",")}
                            </span>
                            <div style={{ fontSize:10, color:"var(--text-2)" }}>
                              vender por R$ {precoVendaDesejado.toFixed(2).replace(".",",")}
                              {descPct > 0 && <span style={{ color:"var(--text-3)" }}> (-{descPct}%)</span>}
                            </div>
                            {pendentesAtualizacao[l.id] && (
                              <div style={{ fontSize:9, fontWeight:700, color:"#FFC107", background:"rgba(255,193,7,.12)", border:"1px solid rgba(255,193,7,.35)", padding:"1px 5px", borderRadius:4, marginTop:2, display:"inline-block" }}>
                                ⏳ pendente {(pendentesAtualizacao[l.id].marketplace || "ml") === "shopee" ? "Shopee" : "ML"}
                              </div>
                            )}
                          </div>
                        ) : (
                          <span style={{ fontSize:11, color:"var(--text-3)", background:"rgba(139,92,246,.14)", border:"1px dashed rgba(139,92,246,.35)", padding:"2px 7px", borderRadius:5 }}>
                            ✎ simular
                          </span>
                        )}
                      </div>
                    )}
                  </td>

                  {/* 🏷 % Desconto Promoção */}
                  <td style={{ padding:"6px 8px", background:"rgba(139,92,246,.12)" }}>
                    {editingDescId === l.id ? (
                      <div style={{ display:"flex", alignItems:"center", gap:3 }}>
                        <input type="number" min="0" max="80" step="1"
                          defaultValue={descPct||""}
                          placeholder="0"
                          autoFocus
                          onBlur={function(e){ var v=Math.min(80,Math.max(0,parseFloat(e.target.value)||0)); setDesconto(l.id,v); setEditingDescId(null); }}
                          onKeyDown={function(e){ if(e.key==="Enter"||e.key==="Escape") e.target.blur(); }}
                          style={{ width:46, background:"var(--surface)", border:"1px solid #7c3aed", color:"var(--text-strong)", padding:"3px 6px", borderRadius:6, fontSize:12, outline:"none", textAlign:"center" }} />
                        <span style={{ fontSize:11, color:"var(--text-3)" }}>%</span>
                      </div>
                    ) : (
                      <div onClick={function(){ setEditingDescId(l.id); }} title="% de desconto na promoção" style={{ cursor:"pointer" }}>
                        {descPct > 0 ? (
                          <div>
                            <span style={{ fontSize:12, fontWeight:700, color:"#7c3aed", background:"rgba(139,92,246,.14)", padding:"2px 7px", borderRadius:5 }}>
                              {descPct}%
                            </span>
                            <div style={{ fontSize:10, color:"#7c3aed", marginTop:1 }}>
                              cliente paga R$ {precoComDesc.toFixed(2).replace(".",",")}
                            </div>
                          </div>
                        ) : (
                          <span style={{ fontSize:11, color:"var(--text-3)", background:"var(--bg-2)", border:"1px dashed var(--border)", padding:"2px 7px", borderRadius:5 }}>
                            ✎ definir
                          </span>
                        )}
                      </div>
                    )}
                  </td>

                  {/* Taxa sobre preço c/ desconto */}
                  <td style={{ padding:"6px 8px", background:"rgba(139,92,246,.12)" }}>
                    <div style={{ fontSize:12, fontWeight:700, color:"#FF5252" }}>
                      R$ {taxaSobreDesc.toFixed(2).replace(".",",")}
                    </div>
                    {ehShopee ? (() => {
                      var f = taxaShopeeFaixa(precoComDesc);
                      return (
                        <>
                          <div style={{ fontSize:10, color:"var(--text-3)" }}>
                            {(f.pct*100).toFixed(0)}% + R$ {f.fixo}{shopeeDoc==="CPF" ? " + R$3" : ""}
                          </div>
                          <div title="Taxa da Shopee 2026 por faixa de preço" style={{ fontSize:9, fontWeight:700, color:"#EE4D2D", marginTop:1 }}>
                            Shopee {shopeeDoc}
                          </div>
                        </>
                      );
                    })() : (
                      <>
                        <div style={{ fontSize:10, color:"var(--text-3)" }}>
                          {(feeRate*100).toFixed(0)}% s/ {descPct>0?"desc":"atual"}
                        </div>
                        <div title="Taxa padrão do Mercado Livre: Clássico 12% · Premium 17%"
                          style={{ fontSize:9, fontWeight:700, color: isPremium?"#7c3aed":"#1976FF", marginTop:1 }}>
                          {isPremium ? "Premium 17%" : "Clássico 12%"}
                        </div>
                      </>
                    )}
                  </td>

                  {/* Lucro Simulado (com desconto se houver) */}
                  <td style={{ padding:"6px 8px", background:"rgba(139,92,246,.12)" }}>
                    {custo > 0 ? (
                      <div>
                        <span style={{ fontSize:13, fontWeight:700, color:lucroFinal>=0?"#0e7490":"#FF5252" }}>
                          R$ {lucroFinal.toFixed(2).replace(".",",")}
                        </span>
                        {descPct > 0 && (
                          <div style={{ fontSize:10, color:"var(--text-3)", marginTop:1 }}>c/ {descPct}% desc</div>
                        )}
                      </div>
                    ) : <span style={{color:"var(--text-3)",fontSize:11}}>—</span>}
                  </td>

                  {/* Margem Simulada */}
                  <td style={{ padding:"6px 8px", background:"rgba(139,92,246,.12)" }}>
                    {custo > 0 ? (
                      <span style={{ fontSize:13, fontWeight:700, color:mCor, background:mCor+"18", padding:"3px 8px", borderRadius:6, display:"inline-block" }}>
                        {margemFinal.toFixed(1)}%
                        {margemFinal >= margemAlvo ? " ✓" : " ↓"}
                      </span>
                    ) : <span style={{color:"var(--text-3)",fontSize:11}}>—</span>}
                  </td>

                  {/* Ação */}
                  <td style={{ padding:"6px 8px" }}>
                    {l._isExtra ? (
                      <button onClick={function(){
                        if(!window.confirm("Remover este produto?")) return;
                        saveProdutosExtras(produtosExtras.filter(function(x){return x.id!==l.id;}));
                      }} style={{ background:"rgba(255,82,82,.12)", border:"1px solid rgba(255,82,82,.35)", color:"#FF5252", padding:"4px 10px", borderRadius:6, cursor:"pointer", fontSize:11, fontWeight:600, whiteSpace:"nowrap" }}>
                        ✕ Remover
                      </button>
                    ) : (
                      <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
                        <a href={"https://www.mercadolivre.com.br/seller-admin/listing/edit?itemId="+l.id} target="_blank" rel="noreferrer"
                          style={{ fontSize:11, color:"#0e7490", textDecoration:"none", fontWeight:600 }}>
                          Editar ML ↗
                        </a>
                        <a href={"https://vendedores.mercadolivre.com.br/ferramentas/promocoes"} target="_blank" rel="noreferrer"
                          style={{ fontSize:10, color:"#7c3aed", textDecoration:"none", fontWeight:600 }}>
                          Promoções ↗
                        </a>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {listsFiltrados.length === 0 && (
          <div style={{ textAlign:"center", padding:"40px", color:"var(--text-3)" }}>
            <div style={{ fontSize:32, marginBottom:8 }}>🔍</div>
            <div>Nenhum anúncio encontrado</div>
          </div>
        )}
      </div>
    </div>
  );
}






// ════════════════════════════════════════════════════════════
//  ABA CONCORRÊNCIA — O que os líderes da sua categoria têm e o seu anúncio não
// ────────────────────────────────────────────────────────────
//  O ML bloqueia ler o anúncio COMPLETO de um concorrente (403). O que a API
//  entrega é: o ranking de MAIS VENDIDOS por categoria (/highlights) e, de cada
//  líder, sinais de qualidade (clipe de vídeo, fotos em alta, Premium, loja
//  oficial, atacado, garantia, promoção). Comparamos esses sinais + as boas
//  práticas do ML com o SEU anúncio (dados completos) e listamos o que melhorar.
// ════════════════════════════════════════════════════════════
const CONCORRENCIA_CACHE_KEY = "concorrencia_melhorias_v3";

function ConcorrenciaTab({ enriched, token, sellerId }) {
  const [cats, setCats] = useState(function(){
    try {
      var raw = localStorage.getItem(CONCORRENCIA_CACHE_KEY);
      if (!raw) return {};
      var p = JSON.parse(raw);
      if (Date.now() - (p.em || 0) > 24*60*60*1000) return {}; // cache 24h
      return p.dados || {};
    } catch { return {}; }
  });
  const [analisando, setAnalisando] = useState(false);
  const [progresso, setProgresso] = useState({ feito: 0, total: 0 });
  const [busca, setBusca] = useState("");
  const [filtro, setFiltro] = useState("com");
  const [expandido, setExpandido] = useState(null);
  const cancelRef = useRef(false);

  const ativos = useMemo(function(){
    return enriched.filter(function(l){ return l.status === "active"; });
  }, [enriched]);
  const categoriasUnicas = useMemo(function(){
    var s = {};
    ativos.forEach(function(l){ if (l.category_id) s[l.category_id] = true; });
    return Object.keys(s);
  }, [ativos]);

  function salvarCache(dados) {
    try { localStorage.setItem(CONCORRENCIA_CACHE_KEY, JSON.stringify({ em: Date.now(), dados: dados })); } catch {}
  }
  function sleep(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }
  function hdr(){ return { headers: { Authorization: "Bearer " + token } }; }
  function temTag(l, t){ return (l.tags || []).indexOf(t) >= 0; }
  function temGarantia(w){ return !!(w && !/sem garantia|nao possui|não possui/i.test(w)); }

  // Lê o "stub" de um líder do ranking (dados que o ML deixa ver de concorrentes).
  async function resolverLider(entry) {
    try {
      if (entry.type === "ITEM") return null; // item de concorrente = 403; só USER_PRODUCT é legível
      var r = await fetch(ML("/products/" + entry.id + "/items"), hdr()).then(function(x){ return x.json(); });
      var st = (r && r.results || [])[0];
      if (!st) return null;
      var tags = st.tags || [];
      return {
        posicao: entry.position,
        sellerId: st.seller_id,
        preco: typeof st.price === "number" ? st.price : null,
        promo: typeof st.original_price === "number" && typeof st.price === "number" && st.original_price > st.price,
        premium: st.listing_type_id === "gold_pro" || st.listing_type_id === "gold_premium",
        oficial: !!st.official_store_id,
        clip: tags.indexOf("has_published_clips") >= 0,
        fotoHQ: tags.indexOf("good_quality_picture") >= 0,
        atacado: tags.indexOf("standard_price_by_quantity") >= 0,
        garantia: temGarantia(st.warranty),
      };
    } catch { return null; }
  }

  async function analisarCategoria(cat) {
    var hl = await fetch(ML("/highlights/MLB/category/" + cat), hdr()).then(function(r){ return r.json(); }).catch(function(){ return null; });
    var content = (hl && hl.content) || [];
    var top = content.slice(0, 10);
    var lideres = [];
    for (var i = 0; i < top.length; i++) {
      var s = await resolverLider(top[i]);
      if (s && String(s.sellerId) !== String(sellerId)) lideres.push(s);
      await sleep(120);
    }
    var n = lideres.length;
    var cont = function(f){ return lideres.filter(f).length; };
    var precos = lideres.map(function(x){ return x.preco; }).filter(function(p){ return p > 0; }).sort(function(a,b){ return a-b; });
    return {
      em: Date.now(), n: n,
      comClip: cont(function(x){ return x.clip; }),
      comFotoHQ: cont(function(x){ return x.fotoHQ; }),
      premium: cont(function(x){ return x.premium; }),
      oficial: cont(function(x){ return x.oficial; }),
      atacado: cont(function(x){ return x.atacado; }),
      garantia: cont(function(x){ return x.garantia; }),
      promo: cont(function(x){ return x.promo; }),
      precoMin: precos[0] ?? null, precoMax: precos[precos.length-1] ?? null,
      precoMediana: precos.length ? precos[Math.floor((precos.length-1)/2)] : null,
    };
  }

  async function analisarTodos() {
    if (!token) { alert("Conecte ao Mercado Livre primeiro."); return; }
    cancelRef.current = false;
    setAnalisando(true);
    var fila = categoriasUnicas;
    setProgresso({ feito: 0, total: fila.length });
    var acc = Object.assign({}, cats);
    for (var i = 0; i < fila.length; i++) {
      if (cancelRef.current) break;
      try { acc[fila[i]] = await analisarCategoria(fila[i]); } catch (e) {}
      setCats(Object.assign({}, acc));
      setProgresso({ feito: i + 1, total: fila.length });
      salvarCache(acc);
    }
    setAnalisando(false);
  }

  // Lista de melhorias para um anúncio, comparando com os líderes + boas práticas do ML.
  function melhorias(l) {
    var c = cats[l.category_id];
    if (!c) return null; // categoria ainda não analisada
    var pts = [];
    var metade = c.n / 2;
    // ── O que os líderes têm e o seu não ──
    if (c.n >= 1 && c.comClip >= 1 && !temTag(l, "has_published_clips"))
      pts.push({ ico:"🎬", t:"Adicione um clipe de vídeo", d: c.comClip + " de " + c.n + " líderes têm clipe", tipo:"lider" });
    if (c.n >= 1 && c.comFotoHQ >= 1 && !temTag(l, "good_quality_picture"))
      pts.push({ ico:"📸", t:"Melhore a qualidade das fotos", d: c.comFotoHQ + " de " + c.n + " líderes têm fotos em alta resolução", tipo:"lider" });
    var ehPrem = l.listing_type_id === "gold_pro" || l.listing_type_id === "gold_premium";
    if (c.n >= 1 && c.premium >= metade && c.premium >= 1 && !ehPrem)
      pts.push({ ico:"⭐", t:"Considere o anúncio Premium", d: c.premium + " de " + c.n + " líderes são Premium (mais exposição)", tipo:"lider" });
    if (c.n >= 1 && c.atacado >= metade && c.atacado >= 1 && !temTag(l, "standard_price_by_quantity"))
      pts.push({ ico:"🏷️", t:"Adicione preço de atacado", d: c.atacado + " de " + c.n + " líderes têm preço por quantidade", tipo:"lider" });
    if (c.n >= 1 && c.garantia >= metade && c.garantia >= 1 && !temGarantia(l.warranty))
      pts.push({ ico:"🛡️", t:"Informe a garantia", d: c.garantia + " de " + c.n + " líderes informam garantia", tipo:"lider" });
    // ── Boas práticas do próprio anúncio (dados que temos completos) ──
    var nFotos = (l.pictures || []).length;
    if (nFotos < 6) pts.push({ ico:"🖼️", t:"Adicione mais fotos", d:"você tem " + nFotos + " — o ideal são 6 ou mais", tipo:"pratica" });
    var nAttrs = (l.attributes || []).filter(function(a){ return a.value_name; }).length;
    if (nAttrs < 8) pts.push({ ico:"📋", t:"Preencha mais a ficha técnica", d:"só " + nAttrs + " atributos preenchidos", tipo:"pratica" });
    if (!(l.shipping && l.shipping.free_shipping)) pts.push({ ico:"🚚", t:"Avalie oferecer frete grátis", d:"melhora conversão e posição", tipo:"pratica" });
    if ((l.title || "").length < 60) pts.push({ ico:"📝", t:"Aproveite todo o título", d:(l.title||"").length + " caracteres — use até 60 com palavras-chave", tipo:"pratica" });
    if (!(l.descriptions && l.descriptions.length)) pts.push({ ico:"📄", t:"Adicione uma descrição detalhada", d:"anúncios com descrição convertem mais", tipo:"pratica" });
    return pts;
  }

  var linhas = ativos.map(function(l){ return { l: l, pts: melhorias(l) }; });
  var resumo = {
    analisados: linhas.filter(function(x){ return x.pts != null; }).length,
    totalMelhorias: linhas.reduce(function(s,x){ return s + (x.pts ? x.pts.length : 0); }, 0),
    otimizados: linhas.filter(function(x){ return x.pts != null && x.pts.length === 0; }).length,
  };

  var q = busca.toLowerCase().trim();
  var visiveis = linhas.filter(function(x){
    if (filtro === "com" && !(x.pts && x.pts.length > 0)) return false;
    if (filtro === "ok" && !(x.pts != null && x.pts.length === 0)) return false;
    if (filtro === "nao" && x.pts != null) return false;
    if (q && (x.l.title||"").toLowerCase().indexOf(q) < 0 && (x.l.id||"").toLowerCase().indexOf(q) < 0 && (x.l.sku||"").toLowerCase().indexOf(q) < 0) return false;
    return true;
  }).sort(function(a,b){ return (b.pts ? b.pts.length : -1) - (a.pts ? a.pts.length : -1); });

  return (
    <div style={{ padding: "0 12px" }}>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", flexWrap:"wrap", gap:12, marginBottom:16 }}>
        <div>
          <div style={{ fontWeight:800, fontSize:18, color:"var(--text-strong)" }}>🔎 Concorrência — melhorias do anúncio</div>
          <div style={{ fontSize:12, color:"var(--text-3)", maxWidth:680 }}>Compara cada anúncio ativo com os <strong>mais vendidos da mesma categoria</strong> e mostra o que os líderes têm e o seu não (clipe, fotos em alta, Premium, atacado, garantia), além das boas práticas do ML.</div>
        </div>
        <div style={{ display:"flex", gap:8, alignItems:"center" }}>
          {analisando && (
            <>
              <span style={{ fontSize:12, color:"var(--text-3)" }}>⏳ {progresso.feito}/{progresso.total} categorias</span>
              <button onClick={function(){ cancelRef.current = true; }}
                style={{ background:"rgba(255,82,82,.12)", border:"1px solid rgba(255,82,82,.35)", color:"#FF5252", fontWeight:600, padding:"8px 14px", borderRadius:8, cursor:"pointer", fontSize:12 }}>Parar</button>
            </>
          )}
          <button onClick={analisarTodos} disabled={analisando || !categoriasUnicas.length}
            style={{ background: analisando?"var(--surface-3)":"#1976FF", border:"none", color:"#fff", fontWeight:700, padding:"9px 18px", borderRadius:8, cursor:analisando?"wait":"pointer", fontSize:13 }}>
            {analisando ? "Analisando..." : "🔍 Analisar (" + categoriasUnicas.length + " categorias)"}
          </button>
        </div>
      </div>

      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit, minmax(160px, 1fr))", gap:12, marginBottom:16 }}>
        {[
          { label:"Anúncios analisados",     valor: resumo.analisados,     cor:"var(--text-strong)" },
          { label:"Melhorias sugeridas",     valor: resumo.totalMelhorias, cor:"#FFC107" },
          { label:"Anúncios otimizados",     valor: resumo.otimizados,     cor:"#0a9d4e" },
        ].map(function(c){
          return (
            <div key={c.label} style={{ background:"var(--surface)", border:"1px solid var(--border-soft)", borderRadius:12, padding:"14px 16px" }}>
              <div style={{ fontFamily:"'JetBrains Mono',monospace", fontSize:10, color:"var(--text-3)", fontWeight:700, textTransform:"uppercase", letterSpacing:".12em" }}>{c.label}</div>
              <div style={{ fontSize:24, fontWeight:800, color:c.cor, marginTop:4 }}>{c.valor}</div>
            </div>
          );
        })}
      </div>

      <div style={{ display:"flex", gap:6, alignItems:"center", flexWrap:"wrap", marginBottom:12 }}>
        {[
          { key:"com", label:"Com melhorias" },
          { key:"ok",  label:"✓ Otimizados" },
          { key:"nao", label:"Não analisados" },
          { key:"all", label:"Todos" },
        ].map(function(f){
          var ativo = filtro === f.key;
          return (
            <button key={f.key} onClick={function(){ setFiltro(f.key); }}
              style={{ background:ativo?"#1976FF":"var(--surface)", color:ativo?"#fff":"var(--text-2)", border:"1px solid "+(ativo?"#1976FF":"var(--border)"), borderRadius:20, padding:"5px 14px", fontSize:12, fontWeight:600, cursor:"pointer" }}>
              {f.label}
            </button>
          );
        })}
        <input value={busca} onChange={function(e){ setBusca(e.target.value); }} placeholder="Buscar por título, MLB ou SKU..."
          style={{ marginLeft:"auto", background:"var(--bg-2)", color:"var(--text-strong)", border:"1px solid var(--border)", borderRadius:8, padding:"7px 12px", fontSize:13, minWidth:240, fontFamily:"inherit" }} />
      </div>

      <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
        {!visiveis.length && (
          <div style={{ background:"var(--surface)", border:"1px solid var(--border-soft)", borderRadius:12, padding:"40px 20px", textAlign:"center", color:"var(--text-3)", fontSize:13 }}>
            {ativos.length ? "Clique em “Analisar” para comparar seus anúncios com os líderes de cada categoria." : "Nenhum anúncio ativo encontrado."}
          </div>
        )}
        {visiveis.map(function(x){
          var l = x.l, pts = x.pts;
          var aberto = expandido === l.id;
          var qtd = pts ? pts.length : null;
          var corQtd = qtd === null ? "var(--text-3)" : qtd === 0 ? "#0a9d4e" : qtd >= 4 ? "#FF5252" : "#FFC107";
          return (
            <div key={l.id} style={{ background:"var(--surface)", border:"1px solid var(--border-soft)", borderRadius:12, overflow:"hidden" }}>
              <div onClick={function(){ if (qtd) setExpandido(aberto ? null : l.id); }}
                style={{ display:"flex", alignItems:"center", gap:12, padding:"12px 16px", cursor: qtd ? "pointer" : "default" }}>
                {l.thumbnail && <img src={l.thumbnail.replace("http://","https://")} alt="" style={{ width:44, height:44, borderRadius:8, objectFit:"cover", border:"1px solid var(--border)", flexShrink:0 }} />}
                <div style={{ minWidth:0, flex:1 }}>
                  <a href={l.permalink} target="_blank" rel="noreferrer" onClick={function(e){ e.stopPropagation(); }} style={{ fontSize:13, fontWeight:600, color:"var(--text-strong)", textDecoration:"none", display:"block", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{l.title}</a>
                  <div style={{ fontSize:11, color:"var(--text-3)" }}>{l.id}{l.sku ? " · SKU " + l.sku : ""}</div>
                </div>
                <div style={{ textAlign:"right", flexShrink:0 }}>
                  {qtd === null
                    ? <span style={{ fontSize:12, color:"var(--text-3)" }}>não analisado</span>
                    : qtd === 0
                      ? <span style={{ fontSize:12, fontWeight:700, color:"#0a9d4e" }}>✓ otimizado</span>
                      : <span style={{ fontSize:13, fontWeight:800, color:corQtd }}>{qtd} melhoria{qtd>1?"s":""} {aberto ? "▲" : "▼"}</span>}
                </div>
              </div>
              {aberto && qtd > 0 && (
                <div style={{ borderTop:"1px solid var(--border-soft)", padding:"10px 16px", display:"flex", flexDirection:"column", gap:6 }}>
                  {pts.map(function(p, i){
                    return (
                      <div key={i} style={{ display:"flex", gap:10, alignItems:"flex-start", padding:"7px 10px", background:"var(--bg-2)", borderRadius:8, border:"1px solid "+(p.tipo==="lider"?"rgba(255,193,7,.25)":"rgba(255,255,255,.06)") }}>
                        <span style={{ fontSize:15, lineHeight:1.2 }}>{p.ico}</span>
                        <div style={{ minWidth:0 }}>
                          <div style={{ fontSize:13, fontWeight:600, color:"var(--text-strong)" }}>{p.t}
                            {p.tipo==="lider" && <span style={{ marginLeft:8, fontSize:9, fontFamily:"'JetBrains Mono',monospace", color:"#FFC107", border:"1px solid rgba(255,193,7,.35)", borderRadius:6, padding:"1px 5px", textTransform:"uppercase", letterSpacing:".08em" }}>concorrente</span>}
                          </div>
                          <div style={{ fontSize:12, color:"var(--text-3)", marginTop:1 }}>{p.d}</div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}


// ════════════════════════════════════════════════════════════
//  CHAT INTERNO — Conversa entre usuários + Tarefas + Anexos
// ════════════════════════════════════════════════════════════
function getChatMensagens() {
  try { var v = JSON.parse(localStorage.getItem("chat_interno_mensagens")||"[]"); return Array.isArray(v) ? v : []; } catch { return []; }
}
function saveChatMensagens(msgs) {
  try { localStorage.setItem("chat_interno_mensagens", JSON.stringify(msgs)); } catch {}
  kvSyncPush("chat_interno_mensagens", msgs);
}
function getTarefas() {
  try { var v = JSON.parse(localStorage.getItem("chat_interno_tarefas")||"[]"); return Array.isArray(v) ? v : []; } catch { return []; }
}
function saveTarefas(t) {
  try { localStorage.setItem("chat_interno_tarefas", JSON.stringify(t)); } catch {}
  kvSyncPush("chat_interno_tarefas", t);
}

function ChatInternoWidget({ currentUser }) {
  const [open, setOpen] = useState(false);
  const [aba, setAba] = useState("conversa"); // conversa | tarefas
  const [mensagens, setMensagens] = useState(getChatMensagens);
  const [tarefas, setTarefas] = useState(getTarefas);
  const [texto, setTexto] = useState("");
  const [canalAtivo, setCanalAtivo] = useState("geral"); // geral | dm:<userId>
  const [showNovaTarefa, setShowNovaTarefa] = useState(false);
  const bottomRef = useRef(null);
  const fileRef = useRef(null);

  const [usuarios, setUsuarios] = useState(function(){ return getUsuarios().filter(function(u){ return u.ativo; }); });
  var naoLidas = mensagens.filter(function(m){ return !((m.lidoPor||[]).includes(currentUser?.id)) && m.autorId!==currentUser?.id; }).length;
  var tarefasMinhas = tarefas.filter(function(t){ return t.responsavelId===currentUser?.id && t.status!=="concluida"; }).length;

  useEffect(function(){
    if (open && bottomRef.current) bottomRef.current.scrollIntoView({ behavior:"smooth" });
  }, [mensagens, open, canalAtivo]);

  // Busca imediatamente ao montar (sem esperar o primeiro tick do polling) — inclui a lista
  // de usuários, pra um usuário criado depois já aparecer nas conversas diretas sem precisar
  // recarregar a página inteira.
  useEffect(function(){
    kvSyncPull("chat_interno_mensagens").then(function(fresh){
      if (Array.isArray(fresh)) { setMensagens(fresh); try { localStorage.setItem("chat_interno_mensagens", JSON.stringify(fresh)); } catch {} }
    });
    kvSyncPull("chat_interno_tarefas").then(function(freshT){
      if (Array.isArray(freshT)) { setTarefas(freshT); try { localStorage.setItem("chat_interno_tarefas", JSON.stringify(freshT)); } catch {} }
    });
    sincronizarUsuariosDoServidor().then(function(){
      setUsuarios(getUsuarios().filter(function(u){ return u.ativo; }));
    });
  }, []);

  // Atualiza a lista de usuários periodicamente também (não só ao abrir o widget)
  useEffect(function(){
    var userInterval = setInterval(function(){
      sincronizarUsuariosDoServidor().then(function(){
        setUsuarios(getUsuarios().filter(function(u){ return u.ativo; }));
      });
    }, 20000); // a cada 20s
    return function(){ clearInterval(userInterval); };
  }, []);

  // Polling para chegar mensagens/tarefas de outros usuários (em qualquer computador) —
  // busca do servidor compartilhado, não só do localStorage deste navegador.
  useEffect(function(){
    var interval = setInterval(function(){
      kvSyncPull("chat_interno_mensagens").then(function(fresh){
        if (!Array.isArray(fresh)) return;
        if (JSON.stringify(fresh) !== JSON.stringify(mensagens)) {
          setMensagens(fresh);
          try { localStorage.setItem("chat_interno_mensagens", JSON.stringify(fresh)); } catch {}
        }
      });
      kvSyncPull("chat_interno_tarefas").then(function(freshT){
        if (!Array.isArray(freshT)) return;
        if (JSON.stringify(freshT) !== JSON.stringify(tarefas)) {
          setTarefas(freshT);
          try { localStorage.setItem("chat_interno_tarefas", JSON.stringify(freshT)); } catch {}
        }
      });
    }, 4000); // 4s — chat precisa parecer quase em tempo real
    return function(){ clearInterval(interval); };
  }, [mensagens, tarefas]);

  function marcarComoLidas() {
    var next = mensagens.map(function(m){
      if (m.autorId === currentUser?.id) return m;
      var lidoPor = m.lidoPor||[];
      if (lidoPor.includes(currentUser?.id)) return m;
      return Object.assign({}, m, { lidoPor: [...lidoPor, currentUser.id] });
    });
    setMensagens(next);
    saveChatMensagens(next);
  }

  function enviarMensagem(anexoBase64, anexoNome, anexoTipo) {
    if (!texto.trim() && !anexoBase64) return;
    // Canal canônico para DMs: usa os dois IDs ordenados, então dá a MESMA string pros dois
    // lados da conversa (antes, cada lado salvava com um nome de canal diferente e a
    // mensagem nunca aparecia pro outro usuário).
    var canalParaSalvar = canalAtivo;
    if (canalAtivo.indexOf("dm:") === 0) {
      var otherIdEnvio = canalAtivo.split(":")[1];
      canalParaSalvar = "dm:" + [String(currentUser.id), String(otherIdEnvio)].sort().join(":");
    }
    var nova = {
      id: "msg_"+Date.now(),
      canal: canalParaSalvar,
      autorId: currentUser.id,
      autorNome: currentUser.nome,
      texto: texto.trim(),
      anexo: anexoBase64 ? { data: anexoBase64, nome: anexoNome, tipo: anexoTipo } : null,
      data: new Date().toISOString(),
      lidoPor: [currentUser.id],
    };
    var next = [...mensagens, nova];
    setMensagens(next);
    saveChatMensagens(next);
    setTexto("");
  }

  function handleFileChange(e) {
    var file = e.target.files[0];
    if (!file) return;
    if (file.size > 3*1024*1024) { alert("Arquivo muito grande (máx 3MB)."); return; }
    var reader = new FileReader();
    reader.onload = function(){ enviarMensagem(reader.result, file.name, file.type); };
    reader.readAsDataURL(file);
    e.target.value = "";
  }

  function handleKey(e) { if (e.key==="Enter" && !e.shiftKey) { e.preventDefault(); enviarMensagem(); } }

  function criarTarefa(form) {
    var nova = {
      id: "tarefa_"+Date.now(),
      titulo: form.titulo,
      descricao: form.descricao,
      responsavelId: form.responsavelId,
      responsavelNome: usuarios.find(function(u){return u.id===form.responsavelId;})?.nome||"—",
      criadorId: currentUser.id,
      criadorNome: currentUser.nome,
      prazo: form.prazo,
      prioridade: form.prioridade,
      status: "pendente",
      criadoEm: new Date().toISOString(),
    };
    var next = [...tarefas, nova];
    setTarefas(next); saveTarefas(next);
    setShowNovaTarefa(false);

    // Enviar email de notificação ao responsável (via mailto: como fallback sem servidor)
    var responsavel = usuarios.find(function(u){ return u.id===form.responsavelId; });
    if (responsavel && responsavel.email) {
      var prazoTxt = form.prazo ? " - Prazo: "+new Date(form.prazo).toLocaleDateString("pt-BR") : "";
      var assunto = encodeURIComponent("[Flow Marketplaces] Nova tarefa: "+form.titulo);
      var linhas = [
        "Ola "+responsavel.nome+",",
        "",
        "Voce recebeu uma nova tarefa no Flow Marketplaces:",
        "",
        "Tarefa: "+form.titulo,
        form.descricao ? "Descricao: "+form.descricao : "",
        "Prioridade: "+form.prioridade,
        prazoTxt,
        "Criado por: "+currentUser.nome,
        "",
        "Acesse o sistema para ver mais detalhes.",
      ].filter(function(l){ return l !== ""; }).join("%0A");
      window.open("mailto:"+responsavel.email+"?subject="+assunto+"&body="+linhas, "_blank");
    }
  }

  function mudarStatusTarefa(id, status) {
    var next = tarefas.map(function(t){ return t.id===id ? Object.assign({},t,{status:status}) : t; });
    setTarefas(next); saveTarefas(next);
  }

  var canais = [{ k:"geral", l:"💬 Geral", icon:"👥" }].concat(
    usuarios.filter(function(u){return u.id!==currentUser?.id;}).map(function(u){
      return { k:"dm:"+u.id, l:u.nome, icon:"👤" };
    })
  );

  var msgsCanal = mensagens.filter(function(m){
    if (canalAtivo === "geral") return m.canal === "geral";
    var otherId = canalAtivo.split(":")[1];
    // Formato canônico (novo, simétrico): "dm:<menorId>:<maiorId>"
    var canonico = "dm:" + [String(currentUser.id), String(otherId)].sort().join(":");
    // Formatos antigos (assimétricos, de antes da correção): cada lado salvava usando
    // só o ID do OUTRO participante — aceita os dois pra não perder histórico já salvo.
    var formaAntigaEu = "dm:" + otherId;
    var formaAntigaOutro = "dm:" + currentUser.id;
    return m.canal === canonico || m.canal === formaAntigaEu || m.canal === formaAntigaOutro;
  });

  return (
    <>
      {/* Botão flutuante */}
      <button onClick={function(){ setOpen(true); marcarComoLidas(); }}
        style={{ position:"fixed", bottom:20, right:20, width:56, height:56, borderRadius:"50%",
          background:"#1976FF", border:"none", color:"#FFC107", fontSize:24, cursor:"pointer",
          boxShadow:"0 6px 20px rgba(0,0,0,.25)", zIndex:500, display: open?"none":"flex",
          alignItems:"center", justifyContent:"center" }}>
        💬
        {(naoLidas>0||tarefasMinhas>0) && (
          <span style={{ position:"absolute", top:-4, right:-4, background:"#FF5252", color:"#fff",
            fontSize:11, fontWeight:700, borderRadius:10, minWidth:20, height:20, display:"flex",
            alignItems:"center", justifyContent:"center", padding:"0 5px" }}>
            {naoLidas+tarefasMinhas}
          </span>
        )}
      </button>

      {/* Painel do chat */}
      {open && (
        <div style={{ position:"fixed", bottom:20, right:20, width:420, height:560, background:"var(--surface)",
          borderRadius:16, boxShadow:"0 12px 40px rgba(0,0,0,.25)", zIndex:500, display:"flex",
          flexDirection:"column", overflow:"hidden", border:"1px solid var(--border)" }}>

          {/* Header */}
          <div style={{ background:"#1976FF", padding:"12px 16px", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
            <div style={{ color:"#fff", fontWeight:700, fontSize:14 }}>💬 Chat da Equipe</div>
            <button onClick={function(){setOpen(false);}} style={{ background:"transparent", border:"none", color:"var(--text-3)", fontSize:18, cursor:"pointer" }}>✕</button>
          </div>

          {/* Sub-abas */}
          <div style={{ display:"flex", borderBottom:"1px solid var(--border)" }}>
            {[{k:"conversa",l:"💬 Conversa"},{k:"tarefas",l:"✓ Tarefas"+(tarefasMinhas>0?" ("+tarefasMinhas+")":"")}].map(function(t){
              var a = aba===t.k;
              return <button key={t.k} onClick={function(){setAba(t.k);}}
                style={{ flex:1, padding:"9px", border:"none", borderBottom:a?"2px solid #1976FF":"2px solid transparent",
                  background:"transparent", color:a?"var(--text-strong)":"var(--text-3)", fontWeight:a?700:400, fontSize:12, cursor:"pointer", fontFamily:"inherit" }}>
                {t.l}
              </button>;
            })}
          </div>

          {aba === "conversa" ? (
            <>
              {/* Canais */}
              <div style={{ display:"flex", gap:4, padding:"8px 10px", borderBottom:"1px solid var(--border)", overflowX:"auto" }}>
                {canais.map(function(c){
                  var a = canalAtivo===c.k;
                  return <button key={c.k} onClick={function(){setCanalAtivo(c.k);}}
                    style={{ padding:"5px 10px", borderRadius:14, border:"1px solid "+(a?"#1976FF":"var(--border)"),
                      background:a?"#1976FF":"var(--surface)", color:a?"#fff":"var(--text-2)", fontSize:11, fontWeight:a?700:400, cursor:"pointer", whiteSpace:"nowrap" }}>
                    {c.icon} {c.l}
                  </button>;
                })}
              </div>

              {/* Mensagens */}
              <div style={{ flex:1, overflowY:"auto", padding:"10px 14px", display:"flex", flexDirection:"column", gap:8 }}>
                {msgsCanal.length===0 && (
                  <div style={{ textAlign:"center", color:"var(--text-3)", fontSize:12, padding:30 }}>
                    Nenhuma mensagem ainda. Comece a conversa!
                  </div>
                )}
                {msgsCanal.map(function(m){
                  var isMe = m.autorId === currentUser.id;
                  return (
                    <div key={m.id} style={{ display:"flex", flexDirection:"column", alignItems:isMe?"flex-end":"flex-start" }}>
                      {!isMe && <div style={{ fontSize:10, color:"var(--text-3)", marginBottom:2, marginLeft:4 }}>{m.autorNome}</div>}
                      <div style={{ maxWidth:"80%", background:isMe?"#1976FF":"var(--surface-3)", color:isMe?"#fff":"var(--text-strong)",
                        padding:"8px 12px", borderRadius:isMe?"12px 12px 4px 12px":"12px 12px 12px 4px", fontSize:13 }}>
                        {m.anexo && (
                          m.anexo.tipo?.startsWith("image/") ? (
                            <img src={m.anexo.data} alt={m.anexo.nome} style={{ maxWidth:200, borderRadius:8, marginBottom:m.texto?6:0, display:"block" }} />
                          ) : (
                            <a href={m.anexo.data} download={m.anexo.nome} style={{ display:"flex", alignItems:"center", gap:6, color:isMe?"rgba(77,179,255,.35)":"#1976FF", textDecoration:"none", marginBottom:m.texto?6:0 }}>
                              📎 {m.anexo.nome}
                            </a>
                          )
                        )}
                        {m.texto && <div style={{ whiteSpace:"pre-wrap" }}>{m.texto}</div>}
                      </div>
                      <div style={{ fontSize:9, color:"var(--text-4)", marginTop:2 }}>
                        {new Date(m.data).toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"})}
                      </div>
                    </div>
                  );
                })}
                <div ref={bottomRef} />
              </div>

              {/* Input */}
              <div style={{ display:"flex", gap:6, padding:"10px 12px", borderTop:"1px solid var(--border)" }}>
                <input type="file" ref={fileRef} style={{display:"none"}} onChange={handleFileChange} accept="image/*,.pdf,.doc,.docx,.xls,.xlsx" />
                <button onClick={function(){fileRef.current?.click();}}
                  style={{ background:"var(--surface-3)", border:"none", color:"var(--text-2)", width:36, height:36, borderRadius:9, cursor:"pointer", fontSize:16, flexShrink:0 }}>
                  📎
                </button>
                <input value={texto} onChange={function(e){setTexto(e.target.value);}} onKeyDown={handleKey} placeholder="Digite uma mensagem..."
                  style={{ flex:1, background:"var(--bg-2)", border:"1px solid var(--border)", color:"var(--text-strong)", padding:"8px 12px", borderRadius:9, fontSize:13, outline:"none" }} />
                <button onClick={function(){enviarMensagem();}} disabled={!texto.trim()}
                  style={{ background:texto.trim()?"#1976FF":"var(--surface-3)", border:"none", color:texto.trim()?"#fff":"var(--text-3)", width:36, height:36, borderRadius:9, cursor:texto.trim()?"pointer":"not-allowed", fontSize:16, flexShrink:0 }}>
                  ➤
                </button>
              </div>
            </>
          ) : (
            <>
              {/* Tarefas */}
              <div style={{ flex:1, overflowY:"auto", padding:"12px 14px" }}>
                <button onClick={function(){setShowNovaTarefa(true);}}
                  style={{ width:"100%", background:"#1976FF", border:"none", color:"#fff", fontWeight:700, padding:"9px", borderRadius:9, cursor:"pointer", fontSize:12, marginBottom:12 }}>
                  + Nova Tarefa
                </button>
                {tarefas.length===0 && <div style={{ textAlign:"center", color:"var(--text-3)", fontSize:12, padding:20 }}>Nenhuma tarefa criada</div>}
                {tarefas.slice().reverse().map(function(t){
                  var corPrior = t.prioridade==="alta"?"#FF5252":t.prioridade==="media"?"#FFC107":"#0a9d4e";
                  var concluida = t.status==="concluida";
                  return (
                    <div key={t.id} style={{ background:"var(--bg-2)", border:"1px solid var(--border)", borderRadius:10, padding:"10px 12px", marginBottom:8, opacity:concluida?0.6:1 }}>
                      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", gap:6 }}>
                        <div style={{ fontSize:13, fontWeight:700, color:"var(--text-strong)", textDecoration:concluida?"line-through":"none" }}>{t.titulo}</div>
                        <span style={{ fontSize:9, fontWeight:700, color:corPrior, background:corPrior+"18", padding:"2px 6px", borderRadius:4, whiteSpace:"nowrap" }}>
                          {t.prioridade}
                        </span>
                      </div>
                      {t.descricao && <div style={{ fontSize:11, color:"var(--text-2)", marginTop:3 }}>{t.descricao}</div>}
                      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginTop:6 }}>
                        <div style={{ fontSize:10, color:"var(--text-3)" }}>
                          👤 {t.responsavelNome} {t.prazo && "· 📅 "+new Date(t.prazo).toLocaleDateString("pt-BR")}
                        </div>
                        {!concluida && t.responsavelId===currentUser.id && (
                          <button onClick={function(){mudarStatusTarefa(t.id,"concluida");}}
                            style={{ background:"#0a9d4e", border:"none", color:"#fff", padding:"3px 9px", borderRadius:6, cursor:"pointer", fontSize:10, fontWeight:600 }}>
                            ✓ Concluir
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}

      {/* Modal nova tarefa */}
      {showNovaTarefa && (
        <ModalNovaTarefa usuarios={usuarios} onSave={criarTarefa} onClose={function(){setShowNovaTarefa(false);}} />
      )}
    </>
  );
}

function ModalNovaTarefa({ usuarios, onSave, onClose }) {
  const [titulo, setTitulo] = useState("");
  const [descricao, setDescricao] = useState("");
  const [responsavelId, setResponsavelId] = useState(usuarios[0]?.id||"");
  const [prazo, setPrazo] = useState("");
  const [prioridade, setPrioridade] = useState("media");

  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(15,23,42,.6)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:700, padding:16 }}>
      <div style={{ background:"var(--surface)", borderRadius:14, width:"100%", maxWidth:420, padding:20 }}>
        <div style={{ fontWeight:700, fontSize:15, color:"var(--text-strong)", marginBottom:14 }}>+ Nova Tarefa</div>
        <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
          <input value={titulo} onChange={function(e){setTitulo(e.target.value);}} placeholder="Título da tarefa"
            style={{ background:"var(--bg-2)", border:"1px solid var(--border)", color:"var(--text-strong)", padding:"9px 12px", borderRadius:8, fontSize:13, outline:"none" }} />
          <textarea value={descricao} onChange={function(e){setDescricao(e.target.value);}} placeholder="Descrição (opcional)" rows={3}
            style={{ background:"var(--bg-2)", border:"1px solid var(--border)", color:"var(--text-strong)", padding:"9px 12px", borderRadius:8, fontSize:13, outline:"none", resize:"none", fontFamily:"inherit" }} />
          <select value={responsavelId} onChange={function(e){setResponsavelId(e.target.value);}}
            style={{ background:"var(--bg-2)", border:"1px solid var(--border)", color:"var(--text-2)", padding:"9px 12px", borderRadius:8, fontSize:13 }}>
            {usuarios.map(function(u){ return <option key={u.id} value={u.id}>{u.nome}</option>; })}
          </select>
          <div style={{ display:"flex", gap:8 }}>
            <input type="date" value={prazo} onChange={function(e){setPrazo(e.target.value);}}
              style={{ flex:1, background:"var(--bg-2)", border:"1px solid var(--border)", color:"var(--text-2)", padding:"9px 12px", borderRadius:8, fontSize:13 }} />
            <select value={prioridade} onChange={function(e){setPrioridade(e.target.value);}}
              style={{ flex:1, background:"var(--bg-2)", border:"1px solid var(--border)", color:"var(--text-2)", padding:"9px 12px", borderRadius:8, fontSize:13 }}>
              <option value="baixa">Baixa</option>
              <option value="media">Média</option>
              <option value="alta">Alta</option>
            </select>
          </div>
        </div>
        <div style={{ display:"flex", gap:8, marginTop:16 }}>
          <button onClick={onClose} style={{ flex:1, background:"var(--bg-2)", border:"1px solid var(--border)", color:"var(--text-2)", fontWeight:600, padding:"10px", borderRadius:9, cursor:"pointer" }}>Cancelar</button>
          <button onClick={function(){ if(titulo.trim()) onSave({titulo,descricao,responsavelId,prazo,prioridade}); }}
            disabled={!titulo.trim()}
            style={{ flex:2, background:titulo.trim()?"#1976FF":"var(--surface-3)", border:"none", color:titulo.trim()?"#fff":"var(--text-3)", fontWeight:700, padding:"10px", borderRadius:9, cursor:titulo.trim()?"pointer":"not-allowed" }}>
            Criar Tarefa
          </button>
        </div>
      </div>
    </div>
  );
}


// ════════════════════════════════════════════════════════════
//  Painel de Usuários (acessado pelo header)
// ════════════════════════════════════════════════════════════

function PainelConfiguracoesGlobal(props) {
  var currentUser=props.currentUser, abaInicial=props.abaInicial;
  var impostos=props.impostos, setImpostos=props.setImpostos;
  var custosFixos=props.custosFixos, setCustosFixos=props.setCustosFixos;
  var irpjCsllConfig=props.irpjCsllConfig||{}, setIrpjCsllConfig=props.setIrpjCsllConfig;
  var faturamentoMes=props.faturamentoMes||0;
  var darkMode=props.darkMode, setDarkMode=props.setDarkMode;
  var onClose=props.onClose;

  var [aba, setAba] = useState(abaInicial==="config" ? "aparencia" : (abaInicial||"aparencia"));
  var [usuarios, setUsuarios] = useState(getUsuarios);
  var [editingUser, setEditingUser] = useState(null);
  var [showModalUser, setShowModalUser] = useState(false);

  function saveUser(user) {
    var lista = getUsuarios();
    var updated = lista.find(function(u){return u.id===user.id;})
      ? lista.map(function(u){return u.id===user.id?user:u;})
      : lista.concat([user]);
    saveUsuarios(updated);
    setUsuarios(updated);
    setShowModalUser(false);
    setEditingUser(null);
  }

  function deleteUser(id) {
    if (id===currentUser.id){alert("Voce nao pode excluir seu proprio usuario.");return;}
    if (!window.confirm("Excluir este usuario?")) return;
    var updated = getUsuarios().filter(function(u){return u.id!==id;});
    saveUsuarios(updated);
    setUsuarios(updated);
  }

  var ABAS = [
    {k:"aparencia", l:"Aparência"},
    {k:"backup",    l:"Backup"},
    {k:"usuarios",  l:"Usuários"},
  ];

  return (
    React.createElement("div", {style:{position:"fixed",inset:0,background:"rgba(15,23,42,.55)",backdropFilter:"blur(4px)",zIndex:800,display:"flex",alignItems:"flex-start",justifyContent:"flex-end",padding:"56px 8px 8px"}},
      React.createElement("div", {style:{background:"var(--surface)",borderRadius:14,width:700,maxHeight:"calc(100vh - 68px)",display:"flex",flexDirection:"column",boxShadow:"0 20px 60px rgba(0,0,0,.22)",overflow:"hidden"}},
        React.createElement("div", {style:{background:"#1976FF",padding:"13px 18px",display:"flex",justifyContent:"space-between",alignItems:"center"}},
          React.createElement("div", {style:{color:"var(--text-strong)",fontWeight:700,fontSize:15}}, "Configuracoes do Sistema"),
          React.createElement("button", {onClick:onClose, style:{background:"transparent",border:"none",color:"var(--text-3)",fontSize:20,cursor:"pointer",lineHeight:1}}, "x")
        ),
        React.createElement("div", {style:{display:"flex",borderBottom:"2px solid var(--border)"}},
          ABAS.map(function(t){
            var a=aba===t.k;
            return React.createElement("button",{key:t.k,onClick:function(){setAba(t.k);},style:{flex:1,padding:"10px",border:"none",borderBottom:a?"2px solid #1976FF":"2px solid transparent",background:"transparent",color:a?"var(--text-strong)":"var(--text-3)",fontWeight:a?700:400,fontSize:12,cursor:"pointer",fontFamily:"inherit",marginBottom:-2}}, t.l);
          })
        ),
        React.createElement("div", {style:{flex:1,overflowY:"auto",padding:"16px 18px"}},
          aba==="config" ? React.createElement(ImpostosCompacto, {impostos:impostos,setImpostos:setImpostos,custosFixos:custosFixos,setCustosFixos:setCustosFixos,faturamentoMes:faturamentoMes,irpjCsllConfig:irpjCsllConfig,setIrpjCsllConfig:setIrpjCsllConfig}) :
          aba==="aparencia" ? React.createElement("div", {style:{display:"flex",gap:10}},
            [{v:false,l:"Claro"},{v:true,l:"Escuro"}].map(function(t){
              return React.createElement("button",{key:String(t.v),onClick:function(){setDarkMode(t.v);localStorage.setItem("darkMode",t.v?"1":"0");},style:{flex:1,padding:14,borderRadius:10,border:"2px solid "+(darkMode===t.v?"#1976FF":"var(--border)"),background:darkMode===t.v?"#1976FF":"var(--surface)",color:darkMode===t.v?"#fff":"var(--text-2)",fontWeight:700,fontSize:14,cursor:"pointer"}}, t.v?"Escuro":"Claro");
            })
          ) :
          aba==="backup" ? React.createElement("div", {style:{display:"flex",flexDirection:"column",gap:14}},
            React.createElement("div", {style:{background:"var(--bg-2)",border:"1px solid var(--border)",borderRadius:12,padding:16}},
              React.createElement("div", {style:{fontWeight:700,fontSize:14,marginBottom:12}}, "Exportar Backup"),
              React.createElement("button", {
                onClick:function(){
                  var chaves=["produtos_cadastro","mov_estoque","vendas_estoque_baixadas","ml_orders_cache","contas_pagar","contas_bancarias","lancamentos","nfe_entrada","nfe_saida","costs_config","fretes_config","descontos_config","precos_venda_config","precos_pendentes_ml","icms_por_estado","irpj_csll_config","fornecedores_db","chat_interno_mensagens","chat_interno_tarefas","min_stock_anuncios","depositos_estoque"];
                  var bk={versao:2,data:new Date().toISOString(),dados:{}};
                  chaves.forEach(function(k){try{bk.dados[k]=JSON.parse(localStorage.getItem(k)||"null");}catch{}});
                  var blob=new Blob([JSON.stringify(bk,null,2)],{type:"application/json"});
                  var a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="mlmargem_backup_"+new Date().toLocaleDateString("sv-SE")+".json";a.click();
                },
                style:{background:"#1976FF",border:"none",color:"#fff",fontWeight:700,padding:"10px 20px",borderRadius:9,cursor:"pointer",fontSize:13}
              }, "Exportar Backup")
            ),
            React.createElement("div", {style:{background:"var(--bg-2)",border:"1px solid var(--border)",borderRadius:12,padding:16}},
              React.createElement("div", {style:{fontWeight:700,fontSize:14,marginBottom:4}}, "Restaurar Backup"),
              React.createElement("label", {style:{background:"var(--surface)",border:"2px dashed var(--border)",borderRadius:9,padding:14,display:"block",textAlign:"center",cursor:"pointer",fontSize:13,color:"var(--text-2)"}},
                "Clique para selecionar arquivo de backup (.json)",
                React.createElement("input", {type:"file",accept:".json",style:{display:"none"},onChange:function(e){
                  var file=e.target.files[0];if(!file)return;
                  if(!window.confirm("Isso vai substituir TODOS os dados atuais. Confirmar?"))return;
                  var reader=new FileReader();
                  reader.onload=function(ev){try{var bk=JSON.parse(ev.target.result);if(!bk.dados)throw new Error("Formato invalido");Object.keys(bk.dados).forEach(function(k){if(bk.dados[k]!=null)localStorage.setItem(k,JSON.stringify(bk.dados[k]));});alert("Backup restaurado! Recarregando...");window.location.reload();}catch(err){alert("Erro ao restaurar: "+err.message);}};
                  reader.readAsText(file);
                }})
              )
            )
          ) :
          React.createElement("div", null,
            usuarios.map(function(u){
              var isMe=u.id===currentUser.id;
              return React.createElement("div",{key:u.id,style:{background:"var(--bg-2)",border:"1px solid var(--border)",borderRadius:10,padding:"10px 14px",marginBottom:8,display:"flex",alignItems:"center",gap:10}},
                React.createElement("div",{style:{width:36,height:36,borderRadius:9,background:"#1976FF",display:"flex",alignItems:"center",justifyContent:"center",fontSize:13,fontWeight:800,color:"#FFC107",flexShrink:0}}, u.nome&&u.nome.charAt(0).toUpperCase()),
                React.createElement("div",{style:{flex:1,minWidth:0}},
                  React.createElement("div",{style:{fontWeight:700,fontSize:13,color:"var(--text-strong)"}}, u.nome, isMe&&React.createElement("span",{style:{fontSize:10,color:"#0e7490",background:"rgba(59,140,255,.14)",padding:"1px 5px",borderRadius:4,marginLeft:6}},"voce")),
                  React.createElement("div",{style:{fontSize:11,color:"var(--text-2)"}}, "@"+u.usuario+" - "+(u.admin?"Admin":"Usuario")+" - ",React.createElement("span",{style:{color:u.ativo?"#0a9d4e":"#FF5252",fontWeight:600}},u.ativo?"Ativo":"Inativo")),
                  u.email&&React.createElement("div",{style:{fontSize:10,color:"var(--text-3)",marginTop:1}}, u.email)
                ),
                React.createElement("div",{style:{display:"flex",gap:6}},
                  React.createElement("button",{onClick:function(){setEditingUser(u);setShowModalUser(true);},style:{background:"rgba(59,140,255,.14)",border:"1px solid rgba(77,179,255,.35)",color:"#1976FF",padding:"4px 10px",borderRadius:7,cursor:"pointer",fontSize:11,fontWeight:600}},"Editar"),
                  !isMe&&React.createElement("button",{onClick:function(){deleteUser(u.id);},style:{background:"rgba(255,82,82,.12)",border:"1px solid rgba(255,82,82,.35)",color:"#FF5252",padding:"4px 8px",borderRadius:7,cursor:"pointer",fontSize:11}},"X")
                )
              );
            }),
            React.createElement("button",{onClick:function(){setEditingUser(null);setShowModalUser(true);},style:{width:"100%",background:"#1976FF",border:"none",color:"#fff",fontWeight:700,padding:10,borderRadius:9,cursor:"pointer",fontSize:13,marginTop:8}},
              "+ Novo Usuario"
            )
          )
        )
      ),
      showModalUser&&React.createElement(ModalUsuario,{usuario:editingUser,onSave:saveUser,onClose:function(){setShowModalUser(false);setEditingUser(null);}})
    )
  );
}


export default function App() {
  // ── Auth do dashboard ─────────────────────────────────────
  const [tab, setTab] = useState(() => {
    try {
      var urlTab = new URLSearchParams(window.location.search).get("tab");
      if (urlTab) return urlTab;
    } catch(e) {}
    return "listings";
  });
  const [abaAnuncio, setAbaAnuncio] = useState("ml");
  const [abaPedido,  setAbaPedido]  = useState("ml");

  // ── Verificar autenticação OAuth ao carregar ──────────────
  useEffect(function() {
    // Verificar se veio do callback OAuth
    try {
      var params = new URLSearchParams(window.location.search);
      var authStatus = params.get("auth");
      if (authStatus === "success") {
        // Limpar parâmetro da URL
        window.history.replaceState({}, "", window.location.pathname + (params.get("tab") ? "?tab=" + params.get("tab") : ""));
        // Buscar dados da sessão e conectar automaticamente
        fetch("/api/auth/session")
          .then(function(r){ return r.json(); })
          .then(function(session) {
            if (session.authenticated) {
              if (session.expiresAt) setTokenExpiry(session.expiresAt);
              handleConnect(session.accessToken, session.userId);
            }
          }).catch(function(){});
      } else if (authStatus === "error") {
        console.warn("Erro na autenticação ML:", params.get("msg"));
        window.history.replaceState({}, "", window.location.pathname);
      } else {
        // Verificar sessão existente silenciosamente ao abrir o dashboard
        fetch("/api/auth/session")
          .then(function(r){ return r.json(); })
          .then(function(session) {
            if (session.authenticated) {
              if (session.expiresAt) setTokenExpiry(session.expiresAt);
              // Marca a conta ML já aqui (o mais cedo possível) para o namespace de sincronização.
              try { if (session.userId) localStorage.setItem("ml_connected_seller", String(session.userId)); } catch(e) {}
              // Nova aba / reabertura: se já temos uma carga recente em cache, mostra na hora
              // sem refazer a reconexão pesada com o ML. "Atualizar" força a recarga completa.
              lerMLSnapshot().then(function(snap){
                if (snap) { hidratarDoSnapshot(snap, session.accessToken); return; }
                // Sem cache válido → carga completa (renovando o token se estiver perto de expirar)
                if (session.almostExpired) {
                  fetch("/api/auth/refresh", { method: "POST" })
                    .then(function(r){ return r.json(); })
                    .then(function(d){
                      var tk = d.access_token || session.accessToken;
                      if (d.expires_in) setTokenExpiry(Date.now() + d.expires_in * 1000);
                      handleConnect(tk, session.userId);
                    }).catch(function(){ handleConnect(session.accessToken, session.userId); });
                } else {
                  handleConnect(session.accessToken, session.userId);
                }
              });
            }
          }).catch(function(){});
      }
    } catch(e) {}
  }, []);
  const [costs, setCosts] = useState(function() {
    try { return JSON.parse(localStorage.getItem("costs_config") || "{}"); } catch { return {}; }
  });
  // Fretes configurados na precificação: {[listing_id]: valorFreteEsperado}
  const [fretesConfig, setFretesConfig] = useState(function() {
    try { return JSON.parse(localStorage.getItem("fretes_config") || "{}"); } catch { return {}; }
  });
  // % de desconto de promoção configurado por anúncio na Precificação
  const [descontosConfig, setDescontosConfig] = useState(function() {
    try { return JSON.parse(localStorage.getItem("descontos_config") || "{}"); } catch { return {}; }
  });
  // Preço de venda desejado configurado por anúncio na Precificação
  const [precosVendaConfig, setPrecosVendaConfig] = useState(function() {
    try { return JSON.parse(localStorage.getItem("precos_venda_config") || "{}"); } catch { return {}; }
  });
  // Anúncios com preço pendente de atualização manual no Mercado Livre
  const [pendentesAtualizacao, setPendentesAtualizacao] = useState(function() {
    try { return JSON.parse(localStorage.getItem("precos_pendentes_ml") || "{}"); } catch { return {}; }
  });
  // SKU editado manualmente pelo usuário na Precificação (por anúncio) — sobrepõe o SKU do ML.
  const [skuOverrides, setSkuOverrides] = useState(function() {
    try { return JSON.parse(localStorage.getItem("sku_overrides") || "{}"); } catch { return {}; }
  });
  function setSkuOverridesAndSave(updater) {
    setSkuOverrides(function(prev) {
      var next = typeof updater === "function" ? updater(prev) : updater;
      try { localStorage.setItem("sku_overrides", JSON.stringify(next)); } catch {}
      kvSyncPush("sku_overrides", next);
      return next;
    });
  }
  function setFretesAndSave(updater) {
    setFretesConfig(function(prev) {
      var next = typeof updater === "function" ? updater(prev) : updater;
      try { localStorage.setItem("fretes_config", JSON.stringify(next)); } catch {}
      kvSyncPush("fretes_config", next);
      return next;
    });
  }
  function setCostsAndSave(updater) {
    setCosts(function(prev) {
      var next = typeof updater === "function" ? updater(prev) : updater;
      try { localStorage.setItem("costs_config", JSON.stringify(next)); } catch {}
      kvSyncPush("costs_config", next);
      return next;
    });
  }
  function setDescontosAndSave(updater) {
    setDescontosConfig(function(prev) {
      var next = typeof updater === "function" ? updater(prev) : updater;
      try { localStorage.setItem("descontos_config", JSON.stringify(next)); } catch {}
      kvSyncPush("descontos_config", next);
      return next;
    });
  }
  function setPrecosVendaAndSave(updater) {
    setPrecosVendaConfig(function(prev) {
      var next = typeof updater === "function" ? updater(prev) : updater;
      try { localStorage.setItem("precos_venda_config", JSON.stringify(next)); } catch {}
      kvSyncPush("precos_venda_config", next);
      return next;
    });
  }
  function setPendentesAndSave(updater) {
    setPendentesAtualizacao(function(prev) {
      var next = typeof updater === "function" ? updater(prev) : updater;
      try { localStorage.setItem("precos_pendentes_ml", JSON.stringify(next)); } catch {}
      kvSyncPush("precos_pendentes_ml", next);
      return next;
    });
  }
  const [minStock, setMinStock] = useState(function(){
    try { return JSON.parse(localStorage.getItem("min_stock_anuncios")||"{}"); } catch { return {}; }
  });
  function setMinStockAndSave(updater) {
    setMinStock(function(prev) {
      var next = typeof updater === "function" ? updater(prev) : updater;
      try { localStorage.setItem("min_stock_anuncios", JSON.stringify(next)); } catch {}
      return next;
    });
  }

  const [selectedListing, setSelectedListing] = useState(null);
  const [sortBy, setSortBy] = useState("score");
  const [orderFilter, setOrderFilter] = useState("all");
  const [searchListings, setSearchListings] = useState("");
  const [paginaAnuncios, setPaginaAnuncios] = useState(1);
  const POR_PAG_ANUNCIOS = 50;
  const [searchType, setSearchType] = useState("all");
  const [searchOrders, setSearchOrders] = useState("");
  const [paginaPedidos, setPaginaPedidos] = useState(1);
  const POR_PAG_PEDIDOS = 50;
  const [filterEnvio, setFilterEnvio] = useState("todos"); // todos | FULL | Flex | ME2 | ME1

  const [orderStatusFilter, setOrderStatusFilter] = useState("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [filterSku, setFilterSku] = useState("");
  const [filterUF, setFilterUF] = useState("");
  const [showClienteDetalhe, setShowClienteDetalhe] = useState(null);
  const [statusFilter, setStatusFilter] = useState("all");
  const [filterListingExtra, setFilterListingExtra] = useState("all");
  // Anúncio cujo campo de custo está sendo editado agora: fica isento do filtro "Sem custo"
  // enquanto digita, senão a linha some no 1º dígito (custo passa a >0) e não dá pra terminar.
  const [editandoCustoId, setEditandoCustoId] = useState(null);
  const [token, setToken] = useState(() => loadSavedTokens()?.accessToken ?? null);
  // Guarda quando o token atual vence (vem da sessão do servidor — cookie próprio ou conexão
  // compartilhada da equipe). Usado por getValidToken() para saber quando renovar.
  const [tokenExpiry, setTokenExpiry] = useState(() => loadSavedTokens()?.expiry ?? null);
  const [user, setUser] = useState(() => {
    const s = loadSavedTokens();
    return s ? { nickname: s.nickname, id: s.userId } : null;
  });
  const [realListings, setRealListings] = useState([]);
  const [realOrders, setRealOrders] = useState([]);
  const [sellerShipping, setSellerShipping] = useState({});
  const [shipmentCosts, setShipmentCosts] = useState({});
  // Taxa real do ML por anúncio (vinda de /sites/MLB/listing_prices, não de tabela fixa 12%/17%)
  const [realFees, setRealFees] = useState(() => {
    try { return JSON.parse(localStorage.getItem("real_fees_config") || "{}"); } catch { return {}; }
  });
  function setRealFeesAndSave(updater) {
    setRealFees(prev => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      try { localStorage.setItem("real_fees_config", JSON.stringify(next)); } catch {}
      return next;
    });
  }
  const [shipmentStatuses, setShipmentStatuses] = useState({});
  const [promos, setPromos] = useState({});
  const [loading, setLoading] = useState(false);
  const [loadingMsg, setLoadingMsg] = useState("");
  // ── Auth ──────────────────────────────────────────────────
  const [currentUser, setCurrentUser] = useState(() => getSession());
  // true enquanto validamos o cookie no servidor ao abrir — evita piscar o login numa guia nova.
  const [authChecking, setAuthChecking] = useState(true);

  // Ao abrir (INCLUSIVE em nova guia), valida o cookie de sessão no servidor. O cookie app_session
  // é compartilhado entre guias, mas o sessionStorage NÃO — então a guia nova restaura a sessão
  // pelo servidor, sem pedir login de novo. Se não estiver autenticado, cai na tela de login.
  useEffect(function(){
    fetch("/api/auth/app-login").then(function(r){ return r.json(); }).then(function(d){
      if (d && d.authenticated && d.user) {
        setSession(d.user); setCurrentUser(d.user);
        sincronizarUsuariosDoServidor();
      } else if (getSession()) {
        // sessão local órfã (cookie expirou/revogado) → limpa e volta ao login
        clearSession(); setCurrentUser(null);
      }
    }).catch(function(){}).finally(function(){ setAuthChecking(false); });
  }, []);
  const [lastUpdate, setLastUpdate] = useState(() => localStorage.getItem("ml_last_update"));
  const [minutesTick, setMinutesTick] = useState(0);
  const [showMLModal, setShowMLModal] = useState(false);
  // Tema: escuro por padrão (preserva o visual atual); só fica claro se o usuário escolher.
  // "1"/ausente = escuro; "0" = claro. Aplica data-theme na raiz p/ os tokens CSS trocarem.
  const [darkMode, setDarkMode] = useState(() => localStorage.getItem("darkMode") !== "0");
  useEffect(function(){
    try { document.documentElement.setAttribute("data-theme", darkMode ? "dark" : "light"); } catch(e) {}
  }, [darkMode]);
  const [metaMensal, setMetaMensal] = useState(() => parseFloat(localStorage.getItem("metaMensal") || "0"));
  const [impostos, setImpostos] = useState(() => {
    try { var v = JSON.parse(localStorage.getItem("impostos_config") || "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
  });
  const [custosFixos, setCustosFixos] = useState(() => {
    try { var v = JSON.parse(localStorage.getItem("custos_fixos_config") || "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
  });
  // Config de IRPJ/CSLL (usada para calcular "Impostos (mês)" no resumo) — elevada ao componente raiz
  // para que o card do resumo reaja imediatamente quando o usuário edita os percentuais, sem precisar recarregar.
  const [irpjCsllConfig, setIrpjCsllConfigState] = useState(() => {
    try { return JSON.parse(localStorage.getItem("irpj_csll_config") || "{}"); } catch { return {}; }
  });
  function setIrpjCsllConfig(cfg) {
    setIrpjCsllConfigState(cfg);
    try { localStorage.setItem("irpj_csll_config", JSON.stringify(cfg)); } catch {}
  }
  const [showNotif, setShowNotif] = useState(false);
  const [showBackup, setShowBackup] = useState(false);
  const [showConfigPanel, setShowConfigPanel] = useState(false);
  const [configPanelTab, setConfigPanelTab] = useState("config"); // config | usuarios
  const [notificacoes, setNotificacoes] = useState(() => {
    try { var v = JSON.parse(localStorage.getItem("ml_notificacoes") || "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
  });
  const [ultimosPedidosIds, setUltimosPedidosIds] = useState(() => {
    try { var v = JSON.parse(localStorage.getItem("ml_ultimos_pedidos") || "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
  });
  const [periodoFiltro, setPeriodoFiltro] = useState("mes"); // hoje | semana | mes | mesSel | ano | custom
  const [periodoCustomDe, setPeriodoCustomDe] = useState("");
  const [periodoCustomAte, setPeriodoCustomAte] = useState("");
  const [showMesPicker, setShowMesPicker] = useState(false); // dropdown seletor de mês
  const [mesSelecionado, setMesSelecionado] = useState(() => {
    var d = new Date(); return d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0");
  });
  // ── Financeiro ────────────────────────────────────────────
  const [contasPagar, setContasPagar] = useState(() => {
    try { var v = JSON.parse(localStorage.getItem("contas_pagar") || "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
  });
  const [contasBancarias, setContasBancarias] = useState(() => {
    try { var v = JSON.parse(localStorage.getItem("contas_bancarias") || "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
  });
  const [categoriasPagar, setCategoriasPagar] = useState(() => {
    try { var vcp = JSON.parse(localStorage.getItem("categorias_pagar") || JSON.stringify(["Fornecedor","Aluguel","Funcionário","Marketing","Frete","Impostos","Outros"])); return Array.isArray(vcp) ? vcp : ["Fornecedor","Aluguel","Funcionário","Marketing","Frete","Impostos","Outros"]; } catch { return ["Fornecedor","Aluguel","Funcionário","Marketing","Frete","Impostos","Outros"]; }
  });
  const [lancamentos, setLancamentos] = useState(() => {
    try { var v = JSON.parse(localStorage.getItem("lancamentos") || "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
  });
  const [finTab, setFinTab] = useState("resumo");

  const [produtos, setProdutos] = useState(() => {
    try { var v = JSON.parse(localStorage.getItem("produtos_cadastro") || "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
  });

  // Sincroniza automaticamente o estoque mínimo definido no cadastro de Produtos
  // (campo estoqueMinimo) com a coluna "Mín" da aba Anúncios, usando o MLB vinculado.
  useEffect(function(){
    if (!produtos || produtos.length === 0) return;
    setMinStock(function(prev) {
      var next = Object.assign({}, prev);
      var mudou = false;
      produtos.forEach(function(p) {
        if (!p.estoqueMinimo) return;
        var mlbs = [p.mlbVinculado].concat(p.mlbsVinculados||[]).filter(Boolean);
        mlbs.forEach(function(mlb) {
          var valorProduto = parseInt(p.estoqueMinimo);
          if (next[mlb] === undefined || next["_src_"+mlb] === "produto") {
            if (next[mlb] !== valorProduto) {
              next[mlb] = valorProduto;
              next["_src_"+mlb] = "produto";
              mudou = true;
            }
          }
        });
      });
      if (mudou) { try { localStorage.setItem("min_stock_anuncios", JSON.stringify(next)); } catch {} }
      return mudou ? next : prev;
    });
  }, [produtos]);

  // ── Auto-baixa de estoque a cada venda nova ──────────────────────────
  // Roda automaticamente sempre que a lista de pedidos (realOrders) mudar,
  // gerando uma movimentação de SAÍDA para cada venda paga que ainda não
  // tenha sido processada, sem precisar clicar em "Reprocessar Vendas".
  var autoBaixaRef = useRef(null);
  autoBaixaRef.current = function() {
    try {
      if (!realOrders || realOrders.length === 0) return;
      if (!produtos || produtos.length === 0) return;

      var prodAtual  = JSON.parse(localStorage.getItem("produtos_cadastro") || "[]");
      var movAtual   = JSON.parse(localStorage.getItem("mov_estoque") || "[]");
      var baixadas   = new Set(JSON.parse(localStorage.getItem("vendas_estoque_baixadas") || "[]"));

      // Só processa pedidos pagos que ainda não foram baixados
      var pedidosPagos = realOrders.filter(function(o){ return o.status === "paid"; });
      var novos = pedidosPagos.filter(function(o){ return !baixadas.has(String(o.id)); });
      if (novos.length === 0) return;

      console.log("[ESTOQUE] Auto-baixa iniciada: " + novos.length + " venda(s) nova(s) para processar.");

      // Verificar se o usuário já rodou o Reprocessar pelo menos uma vez
      // (se não tiver nenhuma movimentação de saldo_inicial, não roda a baixa
      //  pois o saldo base ainda não foi estabelecido)
      var temSaldoInicial = movAtual.some(function(m){ return m.saldoInicial; });
      if (!temSaldoInicial) {
        console.log("[ESTOQUE] Nenhum saldo inicial encontrado — rode 'Reprocessar Vendas' primeiro para estabelecer o saldo base de cada produto. As saídas ficarão pendentes até então.");
        // Registra as saídas sem alterar estoqueAtual (para não zerar indevidamente)
        var movsPendentes = movAtual.slice();
        var baixadasUpd = new Set(baixadas);
        var hoje2 = new Date().toLocaleDateString("sv-SE");
        var hora2 = new Date().toLocaleTimeString("pt-BR", {hour:"2-digit", minute:"2-digit"});
        novos.forEach(function(o){
          if (!o.listing_id) return;
          movsPendentes.push({
            id: "venda_"+o.id, produtoId: null, mlbId: o.listing_id, sku: o.seller_sku||"",
            tipo: "saida", qtd: parseInt(o.qty||1),
            motivo: "Venda ML #"+o.id+" — "+(o.title||"").slice(0,40),
            pedidoId: String(o.id), data: o.date||hoje2, hora: hora2,
            automatico: true, pendenteSaldoInicial: true,
          });
          baixadasUpd.add(String(o.id));
        });
        localStorage.setItem("mov_estoque", JSON.stringify(movsPendentes));
        localStorage.setItem("vendas_estoque_baixadas", JSON.stringify([...baixadasUpd]));
        return;
      }

      // Mapa MLB → produto (deduplicado)
      var mapMlb = {}, mapSku = {};
      prodAtual.forEach(function(p) {
        var mlbsU = [p.mlbVinculado].concat(p.mlbsVinculados||[]).filter(Boolean)
                      .filter(function(m,i,a){ return a.indexOf(m)===i; });
        mlbsU.forEach(function(m){ mapMlb[m] = p; });
        if (p.sku) mapSku[p.sku.trim().toLowerCase()] = p;
      });

      var produtosUpd = prodAtual.slice();
      var movsUpd = movAtual.slice();
      var qtdOk = 0, qtdSemProd = 0;
      var hoje = new Date().toLocaleDateString("sv-SE");
      var hora = new Date().toLocaleTimeString("pt-BR", {hour:"2-digit", minute:"2-digit"});

      novos.forEach(function(o) {
        var lid = o.listing_id;
        var prod = (lid && mapMlb[lid])
                || (o.seller_sku && mapSku[o.seller_sku.trim().toLowerCase()])
                || null;

        var qty = parseInt(o.qty||1);

        if (!prod) {
          qtdSemProd++;
          if (lid) {
            movsUpd.push({
              id: "venda_"+o.id, produtoId: null, mlbId: lid, sku: o.seller_sku||"",
              tipo: "saida", qtd: qty,
              motivo: "Venda ML #"+o.id+" — "+(o.title||"").slice(0,35)+" (sem produto cadastrado)",
              pedidoId: String(o.id), data: o.date||hoje, hora: hora,
              automatico: true, semProduto: true,
            });
            baixadas.add(String(o.id));
          }
          return;
        }

        // Atualizar estoqueAtual no produto
        var pidx = produtosUpd.findIndex(function(p2){ return p2.id === prod.id; });
        if (pidx >= 0) {
          var estoqueAgora = parseInt(produtosUpd[pidx].estoqueAtual||0);
          produtosUpd[pidx] = Object.assign({}, produtosUpd[pidx], {
            estoqueAtual: String(Math.max(0, estoqueAgora - qty))
          });
          // Atualiza mapa para que múltiplas vendas do mesmo produto sejam acumuladas
          var mlbs2 = [produtosUpd[pidx].mlbVinculado].concat(produtosUpd[pidx].mlbsVinculados||[])
                        .filter(Boolean).filter(function(m,i,a){ return a.indexOf(m)===i; });
          mlbs2.forEach(function(m){ mapMlb[m] = produtosUpd[pidx]; });
        }

        movsUpd.push({
          id: "venda_"+o.id,
          produtoId: prod.id,
          mlbId: lid,
          sku: prod.sku||o.seller_sku||"",
          tipo: "saida",
          qtd: qty,
          motivo: "Venda ML #"+o.id+(o.title?" — "+o.title.slice(0,40):""),
          pedidoId: String(o.id),
          data: o.date||hoje,
          hora: hora,
          automatico: true,
        });
        baixadas.add(String(o.id));
        qtdOk++;
      });

      // ── Recalcular estoqueAtual de TODOS os produtos com base nas movimentações reais ──
      // (garante que estoqueAtual bate com o saldo calculado pelas movimentações)
      var saldoPorProduto = {};
      movsUpd.forEach(function(m) {
        if (!m.produtoId) return;
        if (!saldoPorProduto[m.produtoId]) saldoPorProduto[m.produtoId] = 0;
        if (m.tipo === "entrada") saldoPorProduto[m.produtoId] += parseInt(m.qtd||0);
        if (m.tipo === "saida")   saldoPorProduto[m.produtoId] -= parseInt(m.qtd||0);
      });

      produtosUpd = produtosUpd.map(function(p) {
        if (saldoPorProduto[p.id] === undefined) return p;
        var saldo = Math.max(0, saldoPorProduto[p.id]);
        return Object.assign({}, p, { estoqueAtual: String(saldo) });
      });

      // Salvar tudo
      localStorage.setItem("produtos_cadastro", JSON.stringify(produtosUpd));
      localStorage.setItem("mov_estoque", JSON.stringify(movsUpd));
      localStorage.setItem("vendas_estoque_baixadas", JSON.stringify([...baixadas]));
      setProdutos(produtosUpd);
      console.log("[ESTOQUE] Auto-baixa concluída: " + qtdOk + " com produto, " + qtdSemProd + " sem produto. Saldos recalculados por movimentação.");
    } catch(e) {
      console.warn("[ESTOQUE] Erro na auto-baixa:", e.message);
    }
  };

  useEffect(function(){
    var timer = setTimeout(function(){
      if (autoBaixaRef.current) autoBaixaRef.current();
    }, 600);
    return function(){ clearTimeout(timer); };
  }, [realOrders, produtos]);
  // Rastreia IDs de pedidos que já tiveram baixa de estoque
  const [vendasBaixadas, setVendasBaixadas] = useState(function() {
    try { return new Set(JSON.parse(localStorage.getItem("vendas_estoque_baixadas") || "[]")); } catch { return new Set(); }
  });
  const [fornecedores, setFornecedores] = useState(() => {
    try { var v = JSON.parse(localStorage.getItem("fornecedores_cadastro") || "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
  });
  const [nfeSaida, setNfeSaida] = useState({});          // orderId -> dados da NF
  const [loadingNfe, setLoadingNfe] = useState(false);
  const [notasFiscais, setNotasFiscais] = useState(() => {
    try { var v = JSON.parse(localStorage.getItem("notas_fiscais_entrada") || "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
  });
  // ══ SINCRONIZAÇÃO GERAL DO SISTEMA ENTRE TODOS OS USUÁRIOS ══════════════
  // Cobre TODO o sistema, não só NF Entrada e Precificação: produtos, fornecedores,
  // contas a pagar/bancárias, custos fixos, impostos, lançamentos, estoque, pedidos de
  // compra etc. Funciona em duas frentes:
  //  1) PUSH: varre o localStorage periodicamente e manda pro servidor qualquer chave que
  //     mudou desde o último envio — funciona não importa em qual tela/componente a edição
  //     foi feita, sem precisar alterar cada uma individualmente.
  //  2) PULL: busca do servidor o que outros usuários salvaram. Para os dados que já são
  //     estado do componente principal (produtos, fornecedores, contas a pagar...), atualiza
  //     a tela na hora. Para os que vivem só dentro de uma aba específica (movimentação de
  //     estoque, pedidos de compra, ICMS por estado...), atualiza o localStorage — a aba pega
  //     o valor mais novo na próxima vez que for aberta.
  const SYNC_ALL_KEYS = useRef([
    "notas_fiscais_entrada","costs_config","fretes_config","descontos_config","precos_venda_config",
    "produtos_cadastro","fornecedores_cadastro","contas_pagar","contas_bancarias","categorias_pagar",
    "custos_fixos_config","impostos_config","irpj_csll_config","icms_por_estado","lancamentos",
    "mov_estoque","metaMensal","min_stock_anuncios","real_fees_config","pedidos_compra",
    "precificacao_extras","precos_pendentes_ml","depositos_estoque","estoque_depositos",
    "envios_full","vendas_estoque_baixadas","sku_overrides",
  ]).current;
  // Para os dados guardados como dicionário (chave→valor, ex: custo por anúncio), mesclar em
  // vez de substituir por inteiro — evita que um "pull" com dados parciais do servidor apague
  // entradas que este navegador já tinha (ex: taxas reais do ML buscadas aos poucos, ou um
  // custo editado localmente que ainda não chegou ao servidor).
  function mesclarSetter(setter) {
    return function(pulled) {
      setter(function(prev) { return Object.assign({}, prev || {}, pulled || {}); });
    };
  }
  const SYNC_ROOT_SETTERS = useRef({
    notas_fiscais_entrada: setNotasFiscais,
    costs_config: mesclarSetter(setCosts),
    fretes_config: mesclarSetter(setFretesConfig),
    descontos_config: mesclarSetter(setDescontosConfig),
    precos_venda_config: mesclarSetter(setPrecosVendaConfig),
    precos_pendentes_ml: mesclarSetter(setPendentesAtualizacao),
    produtos_cadastro: setProdutos,
    fornecedores_cadastro: setFornecedores,
    contas_pagar: setContasPagar,
    contas_bancarias: setContasBancarias,
    categorias_pagar: setCategoriasPagar,
    custos_fixos_config: setCustosFixos,
    impostos_config: setImpostos,
    irpj_csll_config: mesclarSetter(setIrpjCsllConfigState),
    lancamentos: setLancamentos,
    metaMensal: function(v){ setMetaMensal(parseFloat(v)||0); },
    min_stock_anuncios: mesclarSetter(setMinStock),
    real_fees_config: mesclarSetter(setRealFees),
    sku_overrides: mesclarSetter(setSkuOverrides),
  }).current;
  // Tipo esperado de cada chave — usado para blindar contra um valor no formato errado
  // (ex: um objeto onde deveria vir uma lista) travando a tela com "x.filter is not a function".
  // Se o que veio do servidor não bate com o formato esperado, a atualização é ignorada.
  const SYNC_TIPO_ESPERADO = useRef({
    notas_fiscais_entrada: "array", produtos_cadastro: "array", fornecedores_cadastro: "array",
    contas_pagar: "array", contas_bancarias: "array", categorias_pagar: "array",
    custos_fixos_config: "array", impostos_config: "array", lancamentos: "array",
    costs_config: "object", fretes_config: "object", descontos_config: "object",
    precos_venda_config: "object", precos_pendentes_ml: "object", irpj_csll_config: "object",
    min_stock_anuncios: "object", real_fees_config: "object", sku_overrides: "object",
  }).current;
  const lastSyncRef = useRef({}); // key -> string JSON já sincronizado (evita reenviar/reaplicar sem necessidade)

  useEffect(function(){
    function pushMudancasLocais() {
      SYNC_ALL_KEYS.forEach(function(key){
        try {
          var raw = localStorage.getItem(key);
          if (raw == null) return;
          if (lastSyncRef.current[key] === raw) return; // sem mudança desde a última sincronização
          lastSyncRef.current[key] = raw;
          kvSyncPush(key, JSON.parse(raw));
        } catch(e) {}
      });
    }
    function puxarDoServidor() {
      var promessas = SYNC_ALL_KEYS.map(function(key){
        return kvSyncPull(key).then(function(v){
          if (v == null) return;
          // Blindagem: se a chave tem um tipo esperado (lista/objeto) e o valor que veio do
          // servidor não bate, ignora — evita aplicar um dado corrompido/incompatível que
          // quebraria qualquer tela que faça .filter()/.map()/.forEach() nele.
          var tipoEsperado = SYNC_TIPO_ESPERADO[key];
          if (tipoEsperado === "array" && !Array.isArray(v)) return;
          if (tipoEsperado === "object" && (Array.isArray(v) || typeof v !== "object" || v === null)) return;
          var raw = JSON.stringify(v);
          if (lastSyncRef.current[key] === raw) return; // já é o que temos
          lastSyncRef.current[key] = raw;
          try { localStorage.setItem(key, raw); } catch(e) {}
          var setter = SYNC_ROOT_SETTERS[key];
          if (setter) setter(v);
          // Avisa componentes que leem essa chave direto do localStorage (ex: produtos extras
          // da Precificação) para que a mudança de outro usuário apareça na hora, sem reload.
          try { window.dispatchEvent(new CustomEvent("mlmargem-sync", { detail: { key: key, value: v } })); } catch(e) {}
        });
      });
      return Promise.all(promessas);
    }

    var pushInterval, pullInterval;
    // Primeiro busca o que já existe no servidor (evita que uma cópia local desatualizada
    // sobrescreva o que outro usuário salvou mais recentemente), só depois começa a observar
    // mudanças locais para enviar.
    puxarDoServidor().finally(function(){
      pushMudancasLocais();
      pushInterval = setInterval(pushMudancasLocais, 12000); // envia mudanças locais a cada 12s
      pullInterval = setInterval(puxarDoServidor, 15000); // busca o que outros editaram a cada 15s
    });

    // Ao esconder a aba: envia o que mudou. Ao voltar para a aba: puxa na hora o que os outros
    // usuários editaram (não espera o ciclo) — a edição de um aparece para todos rapidamente.
    function aoMudarVisibilidade(){
      if (document.visibilityState === "hidden") pushMudancasLocais();
      else { pushMudancasLocais(); puxarDoServidor(); }
    }
    document.addEventListener("visibilitychange", aoMudarVisibilidade);
    window.addEventListener("beforeunload", pushMudancasLocais);
    return function(){
      clearInterval(pushInterval);
      clearInterval(pullInterval);
      document.removeEventListener("visibilitychange", aoMudarVisibilidade);
      window.removeEventListener("beforeunload", pushMudancasLocais);
    };
  }, []);
  const [paymentData, setPaymentData] = useState({}); // orderId → { releaseDate, netAmount }
  const [loadError, setLoadError] = useState(null);

  const usingMock = !token || realListings.length === 0;



  // Renova token automaticamente se estiver próximo de vencer
  async function getValidToken() {
    // Sem token nenhum ainda (nem local, nem de sessão) — nada a renovar
    if (!token) return null;
    const vencendoEmBreve = tokenExpiry && (tokenExpiry - Date.now() < 600000);
    if (vencendoEmBreve) {
      try {
        // /api/auth/refresh funciona tanto com o cookie deste navegador quanto, na ausência
        // dele, com o refresh_token da conexão compartilhada da equipe — não depende mais do
        // localStorage deste navegador específico.
        const res = await fetch("/api/auth/refresh", { method: "POST" });
        if (res.ok) {
          const data = await res.json();
          if (data.access_token) {
            setToken(data.access_token);
            setTokenExpiry(Date.now() + (data.expires_in || 21600) * 1000);
            // Mantém o fluxo legado de localStorage em sincronia, se este navegador já o usava
            const saved = loadSavedTokens();
            if (saved) saveTokens(data.access_token, data.refresh_token || saved.refreshToken, data.expires_in || 21600, saved.userId || user?.id, user?.nickname || "");
            return data.access_token;
          }
        }
      } catch(e) { console.warn("Falha ao renovar token:", e); }
    }
    return token;
  }

  // Reaproveita a última carga completa (snapshot em cache) ao abrir uma nova aba: preenche os
  // dados na hora, sem o carregamento pesado do ML. Depois dispara uma atualização leve em
  // segundo plano para pegar pedidos novos, sem travar a tela.
  const hidratouDoCacheRef = useRef(false);
  function hidratarDoSnapshot(snap, accessToken) {
    // Marca que abrimos a partir do cache — o efeito do token dispara, logo em seguida, um
    // refresh incremental de pedidos em segundo plano (sem esperar os 3 min do intervalo).
    hidratouDoCacheRef.current = true;
    if (accessToken) setToken(accessToken);
    if (snap.user) setUser(snap.user);
    // Marca a conta ML conectada (usada como fallback do namespace de sincronização).
    try { if (snap.user && snap.user.id) localStorage.setItem("ml_connected_seller", String(snap.user.id)); } catch(e) {}
    setRealListings(snap.listings || []);
    setRealOrders(snap.orders || []);
    setSellerShipping(snap.sellerShipping || {});
    setShipmentCosts(snap.shipmentCosts || {});
    setShipmentStatuses(snap.shipmentStatuses || {});
    setPaymentData(snap.paymentData || {});
    setPromos(snap.promos || {});
    var lu = localStorage.getItem("ml_last_update");
    if (lu) setLastUpdate(lu);
    setLoading(false); setLoadingMsg("");
    // Em segundo plano, relê os anúncios do cache do servidor — traz mudanças (preço/estoque/
    // status via webhook) que o snapshot local ainda não tinha, sem travar a tela.
    setTimeout(function(){ refrescarAnunciosDoCacheRef.current(); }, 400);
  }

  async function handleConnect(tk, userId) {
    const validTk = tk;
    setToken(validTk); setShowMLModal(false);
    setLoading(true); setLoadError(null);
    var ordersCarregados = []; // visível após o try — usado nas notificações de novos pedidos
    try {
      setLoadingMsg("Identificando conta...");
      const meRes = await fetch(ML("/users/me"), { headers: { Authorization: `Bearer ${validTk}` } });
      const me = await meRes.json();
      if (!me.id) throw new Error("Token inválido");
      setUser({ nickname: me.nickname ?? "Minha Conta ML", id: me.id });

      // ── Isolamento entre contas: se este navegador conectar uma conta ML DIFERENTE da
      // anterior, limpa os dados de negócio locais (custos, produtos, precificação) para não
      // misturar as contas. Na primeira conexão (sem conta registrada) não limpa nada.
      try {
        var contaAnterior = localStorage.getItem("ml_connected_seller");
        if (contaAnterior && contaAnterior !== String(me.id)) {
          SYNC_ALL_KEYS.forEach(function(k){ try { localStorage.removeItem(k); } catch(e){} });
          try { localStorage.removeItem("ml_orders_cache"); } catch(e){}
          try { idbDel(ML_SNAPSHOT_KEY); } catch(e){}
          lastSyncRef.current = {}; // força re-puxar os dados da conta nova do servidor
          setCosts({}); setFretesConfig({}); setDescontosConfig({}); setPrecosVendaConfig({});
          setPendentesAtualizacao({}); setRealFees({}); setProdutos([]);
        }
        localStorage.setItem("ml_connected_seller", String(me.id));
      } catch(e) {}

      // Atualiza nickname salvo
      const saved = loadSavedTokens();
      if (saved) saveTokens(saved.accessToken, saved.refreshToken, (saved.expiry - Date.now()) / 1000, me.id, me.nickname);

      // Anúncios: lê do CACHE do servidor (instantâneo). Só puxa do ML se o cache estiver vazio
      // (ex.: 1º acesso, antes do primeiro sync do servidor). Mesma shape nos dois casos.
      setLoadingMsg("Carregando anúncios...");
      var cacheL = await carregarAnunciosDoCache();
      const listings = (cacheL.cache && cacheL.items && cacheL.items.length) ? cacheL.items : await fetchAllListings(me.id, validTk);
      setRealListings(listings);

      // Auto-importar anúncios para cadastro de produtos (rápido, local)
      setLoadingMsg("Sincronizando produtos...");
      const produtosAtuais = JSON.parse(localStorage.getItem("produtos_cadastro") || "[]");
      const produtosSincronizados = syncListingsToProdutos(listings, produtosAtuais);
      localStorage.setItem("produtos_cadastro", JSON.stringify(produtosSincronizados));
      setProdutos(produtosSincronizados);
      const costsExistentes = JSON.parse(localStorage.getItem("costs_config") || "{}");
      const costsFromProdutos = {};
      produtosSincronizados.forEach(function(p) {
        if (!p.precoCusto) return;
        var custo = parseFloat(p.precoCusto);
        if (!custo || custo <= 0) return;
        var mlbs = p.mlbsVinculados || (p.mlbVinculado ? [p.mlbVinculado] : []);
        mlbs.forEach(function(mlb) { costsFromProdutos[mlb] = custo; });
      });
      setCostsAndSave(Object.assign({}, costsExistentes, costsFromProdutos));

      // Pedidos: também do CACHE (instantâneo), com fallback ao ML.
      setLoadingMsg("Carregando pedidos...");
      var cacheO = await carregarPedidosDoCache();
      const orders = (cacheO.cache && cacheO.items && cacheO.items.length) ? cacheO.items : await fetchAllOrders(me.id, validTk);
      ordersCarregados = orders;
      setRealOrders(orders);
      // Salvar pedidos no localStorage para uso offline pelo Reprocessar Vendas
      try {
        var ordersLeve = orders.map(function(o){
          return { id:o.id, listing_id:o.listing_id, status:o.status, qty:o.qty||1, price:o.price, date:o.date, title:o.title, seller_sku:o.seller_sku||"" };
        });
        localStorage.setItem("ml_orders_cache", JSON.stringify(ordersLeve));
      } catch(e) {}

      // ✅ A partir daqui a tela JÁ renderiza (anúncios + pedidos carregados). Taxa real, frete,
      // pagamento e promoções (que já vêm do cache local) são refrescados em SEGUNDO PLANO,
      // sem travar a abertura — o setLoading(false) logo abaixo é alcançado na hora.
      (async function enriquecerBg(){
        try {
          const feeMap = await fetchRealFeesForListings(listings, validTk, function(partial){
            setRealFeesAndSave(function(f){ return Object.assign({}, f, partial); });
          });
          setRealFeesAndSave(function(f){ return Object.assign({}, f, feeMap); });

          const shippingMap = {};
          for (let i = 0; i < listings.length; i += 5) {
            const batch = listings.slice(i, i + 5);
            const results = await Promise.all(batch.map(l => fetchSellerShippingCost(l.id, me.id, validTk).then(cost => ({ id: l.id, cost }))));
            results.forEach(r => { shippingMap[r.id] = r.cost; });
          }
          setSellerShipping(shippingMap);

          const { shippingMap: orderShippingMap, statusMap: shipmentStatusMap } = await fetchShippingForOrders(orders, validTk, function(partialShipping){ setShipmentCosts({ ...partialShipping }); });
          setShipmentCosts({ ...orderShippingMap });
          setShipmentStatuses({ ...shipmentStatusMap });

          const paymentMap = await fetchPaymentForOrders(orders, validTk, function(partial){ setPaymentData({ ...partial }); });
          setPaymentData({ ...paymentMap });

          const promoMap = {};
          for (let i = 0; i < listings.length; i += 10) {
            const batch = listings.slice(i, i + 10);
            const results = await Promise.all(batch.map(l => fetchPromoPrice(l.id, validTk).then(promo => ({ id: l.id, promo }))));
            results.forEach(r => { if (r.promo) promoMap[r.id] = r.promo; });
          }
          setPromos(promoMap);

          salvarMLSnapshot({
            user: { nickname: me.nickname ?? "Minha Conta ML", id: me.id },
            listings: listings, orders: orders,
            sellerShipping: shippingMap, shipmentCosts: orderShippingMap,
            shipmentStatuses: shipmentStatusMap, paymentData: paymentMap, promos: promoMap,
          });
        } catch (e) { console.warn("[enriquecimento bg] falhou:", e && e.message); }
      })();
    } catch (e) { setLoadError(e.message); }
    setLoading(false); setLoadingMsg("");
    const now = Date.now().toString();
    localStorage.setItem("ml_last_update", now);
    setLastUpdate(now);

    // ── Verificar novos pedidos e estoque baixo ─────────
    const savedIds = JSON.parse(localStorage.getItem("ml_ultimos_pedidos") || "[]");
    const novasNotifs = [];

    // Novos pedidos (IDs que não existiam antes)
    const ordersParaNotif = Array.isArray(ordersCarregados) ? ordersCarregados : [];
    ordersParaNotif.forEach(o => {
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
    const ordersForNotif = ordersCarregados;
    const todosIds = [...new Set([...savedIds, ...ordersForNotif.map(o => String(o.id))])];
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

  // ── Atualização automática em tempo real (leve, sem precisar clicar em "Reconectar") ──
  // handleConnect faz a carga completa: TODOS os anúncios, frete por anúncio, TODOS os pedidos,
  // e frete/pagamento de TODOS os pedidos — por isso demora. Esta função só busca a lista de
  // pedidos (rápido) e enriquece com frete/pagamento apenas os pedidos que ainda não tinham
  // esses dados (pedidos novos desde a última sincronização), então roda em segundos e pode
  // ficar rodando sozinha em segundo plano.
  const autoRefreshingRef = useRef(false);
  async function refreshOrdersIncremental() {
    if (!token || !user?.id || loading || autoRefreshingRef.current) return;
    autoRefreshingRef.current = true;
    try {
      const validTk = await getValidToken();
      if (!validTk) return;
      const orders = await fetchAllOrders(user.id, validTk);
      setRealOrders(orders);
      try {
        var ordersLeve = orders.map(function(o){
          return { id:o.id, listing_id:o.listing_id, status:o.status, qty:o.qty||1, price:o.price, date:o.date, title:o.title, seller_sku:o.seller_sku||"" };
        });
        localStorage.setItem("ml_orders_cache", JSON.stringify(ordersLeve));
      } catch(e) {}

      // Enriquecer só os pedidos que ainda não têm frete/pagamento calculados (novos desde a última sync)
      const ordersNovos = orders.filter(o => shipmentCosts[String(o.id)] === undefined);
      if (ordersNovos.length > 0) {
        const { shippingMap, statusMap } = await fetchShippingForOrders(ordersNovos, validTk);
        setShipmentCosts(prev => ({ ...prev, ...shippingMap }));
        setShipmentStatuses(prev => ({ ...prev, ...statusMap }));

        const pagosNovos = ordersNovos.filter(o => o.status === "paid" && paymentData[String(o.id)] === undefined);
        if (pagosNovos.length > 0) {
          const novoPaymentMap = await fetchPaymentForOrders(pagosNovos, validTk);
          setPaymentData(prev => ({ ...prev, ...novoPaymentMap }));
        }
      }

      // Notifica pedidos novos (mesma lógica de handleConnect, de forma incremental)
      const savedIds = JSON.parse(localStorage.getItem("ml_ultimos_pedidos") || "[]");
      const novasNotifsInc = [];
      orders.forEach(o => {
        if (o.status === "paid" && !savedIds.includes(String(o.id))) {
          const valor = (o.price || 0) * (o.qty || 1);
          novasNotifsInc.push({
            id: `order_${o.id}_${Date.now()}`,
            tipo: "pedido",
            titulo: "🛒 Novo pedido!",
            msg: `Pedido #${o.id} — ${o.title || "Item"} — R$ ${parseFloat(valor).toFixed(2).replace(".",",")}`,
            data: new Date().toLocaleString("pt-BR"),
            lido: false,
          });
        }
      });
      if (novasNotifsInc.length > 0) {
        const todosIdsInc = [...new Set([...savedIds, ...orders.map(o => String(o.id))])];
        localStorage.setItem("ml_ultimos_pedidos", JSON.stringify(todosIdsInc));
        setUltimosPedidosIds(todosIdsInc);
        const todasNotifsInc = [...novasNotifsInc, ...JSON.parse(localStorage.getItem("ml_notificacoes") || "[]")].slice(0, 50);
        localStorage.setItem("ml_notificacoes", JSON.stringify(todasNotifsInc));
        setNotificacoes(todasNotifsInc);
        if (typeof Notification !== "undefined" && Notification.permission === "granted") {
          novasNotifsInc.slice(0,3).forEach(n => { try { new Notification(n.titulo, { body: n.msg }); } catch {} });
        }
      }

      const now = Date.now().toString();
      localStorage.setItem("ml_last_update", now);
      setLastUpdate(now);
    } catch (e) {
      console.warn("[Auto-atualização] falhou:", e.message);
    } finally {
      autoRefreshingRef.current = false;
    }
  }

  // Guarda sempre a versão mais recente de refreshOrdersIncremental (evita "stale closure" no
  // setInterval — sem isso, o intervalo ficaria preso aos valores de token/pedidos do momento
  // em que foi criado, em vez de sempre usar o estado mais atual).
  const refreshOrdersIncrementalRef = useRef(refreshOrdersIncremental);
  refreshOrdersIncrementalRef.current = refreshOrdersIncremental;

  // Relê os ANÚNCIOS do cache do servidor (mantido fresco por webhook + cron) e atualiza a tela.
  // Assim, mudanças de preço/estoque/status feitas no ML aparecem numa reabertura ou dentro do
  // intervalo, sem precisar de uma recarga "fria" (Reconectar). Pedidos já têm o refresh próprio.
  async function refrescarAnunciosDoCache() {
    try {
      var rl = await carregarAnunciosDoCache();
      if (rl.cache && Array.isArray(rl.items) && rl.items.length) setRealListings(rl.items);
    } catch (e) {}
  }
  const refrescarAnunciosDoCacheRef = useRef(refrescarAnunciosDoCache);
  refrescarAnunciosDoCacheRef.current = refrescarAnunciosDoCache;

  // Estado (não ref) para o botão "Atualizar" manual, pra dar retorno visível de verdade —
  // antes, ele usava só uma ref, que não atualiza a tela, então clicar parecia não fazer nada.
  const [refreshingManual, setRefreshingManual] = useState(false);
  const [refreshManualMsg, setRefreshManualMsg] = useState(null);
  async function clicarAtualizarManual() {
    if (!token || !user?.id) {
      alert("Conecte-se ao Mercado Livre primeiro (botão Reconectar).");
      return;
    }
    if (refreshingManual || autoRefreshingRef.current) return; // já está atualizando
    setRefreshingManual(true);
    setRefreshManualMsg(null);
    try {
      await refreshOrdersIncrementalRef.current();
      setRefreshManualMsg("✓ Atualizado agora");
    } catch (e) {
      setRefreshManualMsg("⚠ Falhou, tente de novo");
    } finally {
      setRefreshingManual(false);
      setTimeout(function(){ setRefreshManualMsg(null); }, 4000);
    }
  }

  // Dispara a atualização automática a cada 3 minutos, sozinha, sem precisar de nenhum clique.
  useEffect(function(){
    if (!token) return;
    // Se acabamos de abrir a partir do cache (hidratação), busca pedidos novos JÁ — assim o que
    // mudou no ML desde a última sessão aparece em segundos, sem esperar o intervalo de 3 min.
    if (hidratouDoCacheRef.current) {
      hidratouDoCacheRef.current = false;
      setTimeout(function(){ refreshOrdersIncrementalRef.current(); }, 600);
    }
    var intervalId = setInterval(function(){
      refreshOrdersIncrementalRef.current();
      refrescarAnunciosDoCacheRef.current(); // relê anúncios do cache (mudanças via webhook/cron)
    }, 180000); // 3 minutos
    return function(){ clearInterval(intervalId); };
  }, [token]);

  // Sem dados de demonstração: enquanto não conectar a conta, as telas ficam vazias.
  const listings = realListings;
  const shippingData = sellerShipping;
  const promosData = promos;

  const rawOrders = realOrders.map(o => {
    const item = o.order_items?.[0];
    const buyerShippingCost = parseFloat(o.payments?.[0]?.shipping_cost) || 0;
    const shipmentCost = shipmentCosts[String(o.id)] ?? 0;
    var buyer = o.buyer || {};
    var buyerAddr = o.shipping?.receiver_address || {};
    return {
      id: String(o.id),
      listing_id: item?.item?.id,
      title: item?.item?.title ?? null,
      sku: item?.item?.seller_sku || item?.item?.attributes?.find(function(a){return a.id==="SELLER_SKU";})?.value_name || null,
      date: o.date_created?.slice(0, 10),
      price: item?.unit_price ?? o.total_amount ?? 0,
      qty: item?.quantity ?? 1,
      seller_shipping_cost: shipmentCost,
      buyer_shipping_cost: buyerShippingCost,
      permalink: item?.item?.id ? `https://www.mercadolivre.com.br/p/${item.item.id}` : null,
      status: o.status ?? "paid",
      tags: o.tags ?? [],
      shipment_status: shipmentStatuses[String(o.id)] ?? null,
      // Dados do comprador
      buyerName: buyer.nickname || (buyer.first_name ? (buyer.first_name + " " + (buyer.last_name||"")).trim() : null),
      buyerFirstName: buyer.first_name || null,
      buyerLastName: buyer.last_name || null,
      buyerDoc: buyer.identification?.number || null,
      buyerDocType: buyer.identification?.type || null,
      buyerEmail: buyer.email || null,
      buyerPhone: buyer.phone?.number || null,
      // Endereço de entrega
      buyerUF: buyerAddr.state?.id || buyerAddr.address_line?.match(/[A-Z]{2}/)?.[0] || null,
      buyerCity: buyerAddr.city?.name || null,
      buyerZip: buyerAddr.zip_code || null,
      shipping: o.shipping || null,
      fulfilled: o.fulfilled || false,
      orderTags: o.tags || [],
      packId: o.pack_id ? String(o.pack_id) : null,
    };
  });

  // Alíquota efetiva de impostos sobre a venda (soma dos itens percentuais configurados
  // em Financeiro → Impostos) — entra na margem líquida de cada anúncio/pedido.
  const impostoPctVenda = (impostos || []).filter(i => i.tipo === "%").reduce((s, i) => s + (parseFloat(i.valor) || 0), 0);

  const enriched = listings.map(l => {
    const cost = costs[l.id] ?? 0;
    // Taxa ML padronizada por tipo de anúncio: Clássico 12% / Premium 17%.
    const feeRate = getRealFeeRate(l);
    const realFeeInfo = realFees[l.id] || null;
    const promoData = promosData[l.id];
    const { salePrice: salePriceApi, originalPrice: originalPriceApi, hasPromo: hasPromoApi } = getPrices(l);
    const salePrice = promoData ? promoData.salePrice : salePriceApi;
    const originalPrice = promoData ? promoData.originalPrice : originalPriceApi;
    const hasPromo = promoData ? true : hasPromoApi;
    const freteSeller = shippingData[l.id] ?? 0;
    // Taxa padronizada 12%/17% sobre o preço — sem somar tarifa fixa por faixa.
    const margin = calcMargin(salePrice, cost, feeRate, freteSeller, {
      feeFixa: 0,
      impostoPct: impostoPctVenda,
    });
    const { score, checks } = calcQualityScore(l);
    // SKU editado manualmente pelo usuário tem prioridade sobre o SKU vindo do ML.
    const skuOverride = skuOverrides[l.id] && String(skuOverrides[l.id]).trim();
    const sku = skuOverride || getSku(l);
    const youReceive = salePrice - margin.fee - freteSeller;
    return { ...l, seller_sku: skuOverride || l.seller_sku, ...margin, cost, sku, salePrice, originalPrice, hasPromo, freteSeller, youReceive, totalProfit: margin.profit * (l.sold_quantity ?? 0), score, checks, feeIsReal: !!realFeeInfo };
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
    if (filterListingExtra === "sem_custo")  results = results.filter(l => l.id === editandoCustoId || !(costs[l.id] > 0));
    if (filterListingExtra === "com_promo")  results = results.filter(l => l.hasPromo);
    if (filterListingExtra === "sem_promo")  results = results.filter(l => !l.hasPromo);
    if (filterListingExtra === "sem_atacado") {
      // Anúncios sem preço de atacado (ML chama de "Preço por Quantidade") preenchido.
      // Segundo a documentação oficial do ML, publicações com esse preço configurado
      // recebem a tag "standard_price_by_quantity" no item — é isso que identifica com certeza.
      results = results.filter(function(l) {
        var hasWholesale = l.tags && l.tags.includes("standard_price_by_quantity");
        return !hasWholesale;
      });
    }
    if (filterListingExtra === "frete_alto") {
      var fretesConf = {};
      try { fretesConf = JSON.parse(localStorage.getItem("fretes_config") || "{}"); } catch {}
      results = results.filter(function(l) {
        var fc = parseFloat(fretesConf[l.id]||0);
        var fr = l.freteSeller || 0;
        return fc > 0 && fr > fc;
      });
    }
    return results;
  }, [enriched, searchListings, searchType, statusFilter, filterListingExtra, costs, editandoCustoId]);

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
    let cutoff = new Date();
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
    if (q) results = results.filter(o =>
      String(o.id).includes(q) ||
      (o.title||"").toLowerCase().includes(q) ||
      (o.buyerName||"").toLowerCase().includes(q) ||
      (o.buyerDoc||"").includes(q) ||
      (o.buyerEmail||"").toLowerCase().includes(q) ||
      (o.buyerCity||"").toLowerCase().includes(q) ||
      (o.sku||"").toLowerCase().includes(q)
    );
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

  // Aplicar filtro de envio no enrichedOrders

  const enrichedOrdersFiltered = filteredOrders.filter(o => {
    if (filterSku) {
      var q = filterSku.toLowerCase().trim();
      if (!(o.sku||"").toLowerCase().includes(q)) return false;
    }
    if (filterUF) {
      if ((o.buyerUF||"").toUpperCase() !== filterUF.toUpperCase()) return false;
    }
    return true;
  });
  const enrichedOrders = enrichedOrdersFiltered.map(o => {
    const listing = listings.find(l => l.id === o.listing_id);
    const cost = costs[listing?.id] ?? 0;
    // Frete: usa shipmentCosts[order_id] calculado como base_cost - buyer_paid
    const freteSeller = shipmentCosts[String(o.id)]
      ?? shippingData[o.listing_id]
      ?? shippingData[listing?.id]
      ?? 0;
    // Melhor fonte de tarifa, nesta ordem: (1) sale_fee real cobrado neste pedido,
    // (2) taxa real do anúncio via listing_prices, (3) tabela estimada + tarifa fixa.
    const pay = paymentData[String(o.id)];
    let base;
    if (pay && pay.tarifaML > 0 && !pay.isCalculated && o.price > 0) {
      const tarifaUnit = pay.tarifaML / (o.qty || 1);
      base = calcMargin(o.price, cost, tarifaUnit / o.price, freteSeller, { impostoPct: impostoPctVenda });
    } else {
      // Sem dados reais de tarifa do pedido → usa a taxa padrão por tipo (12%/17%).
      const feeRate = listing ? getRealFeeRate(listing) : 0.12;
      base = calcMargin(o.price, cost, feeRate, freteSeller, {
        feeFixa: 0,
        impostoPct: impostoPctVenda,
      });
    }
    return { ...o, listing, ...base, cost, freteSeller };
  })

  // ── Alertas proativos no sino: margem negativa, contas vencendo e ruptura prevista ──
  // Cada alerta tem id único por dia — a deduplicação por id impede repetição no sino.
  useEffect(function() {
    try {
      if (!currentUser) return;
      var hojeStr = new Date().toLocaleDateString("sv-SE");
      var alertas = [];

      // 1) Anúncios ativos com custo cadastrado vendendo no prejuízo
      var negativos = enriched.filter(function(l){ return l.status==="active" && l.cost>0 && l.profit<0; });
      if (negativos.length>0) {
        var piores = negativos.slice().sort(function(a,b){return a.profit-b.profit;}).slice(0,3)
          .map(function(l){return (l.title||"").slice(0,35);}).join(" · ");
        alertas.push({
          id: "margem_neg_"+hojeStr, tipo: "margem",
          titulo: "🔻 "+negativos.length+" anúncio(s) com margem NEGATIVA",
          msg: "Você perde dinheiro a cada venda: "+piores,
          data: new Date().toLocaleString("pt-BR"), lido: false,
        });
      }

      if (alertas.length>0) {
        var existentes = JSON.parse(localStorage.getItem("ml_notificacoes")||"[]");
        var idsExist = existentes.map(function(n){return n.id;});
        var novas = alertas.filter(function(a){return !idsExist.includes(a.id);});
        if (novas.length>0) {
          var todas=[...novas, ...existentes].slice(0,50);
          localStorage.setItem("ml_notificacoes", JSON.stringify(todas));
          setNotificacoes(todas);
        }
      }
    } catch(e) {}
  }, [currentUser, listings.length, (rawOrders||[]).length]); // eslint-disable-line

  const enrichedOrdersComEnvio = useMemo(function() {
    if (filterEnvio === "todos") return enrichedOrders;
    return enrichedOrders.filter(function(o) {
      var tipo = detectTipoEnvio(o, shipmentStatuses);
      return tipo === filterEnvio;
    });
  }, [enrichedOrders, filterEnvio, shipmentStatuses]);

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
    if (periodoFiltro === "mesSel") {
      var lastDay = new Date(parseInt(mesSelecionado.slice(0,4)), parseInt(mesSelecionado.slice(5,7)), 0);
      var fim = lastDay.toLocaleDateString("sv-SE");
      return [mesSelecionado + "-01", fim];
    }
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
  // Custo de Mercadorias Vendidas (CMV) — soma do custo unitário cadastrado × quantidade vendida no período
  const totalCMV = ordersValidos.reduce((s, o) => s + (o.cost ?? 0) * o.qty, 0);
  // Impostos (mês) — usa o percentual de IRPJ+CSLL pré-cadastrado em Financeiro > Configurações, aplicado sobre o faturamento do período
  const pctImpostos = (parseFloat(irpjCsllConfig.irpj || 0) + parseFloat(irpjCsllConfig.irpjAdicional || 0) + parseFloat(irpjCsllConfig.csll || 0)) / 100;
  const totalImpostosMes = totalRevenue * pctImpostos;
  const totalCustosFixosMes = custosFixos.reduce((s, c) => s + (c.tipo === "%" ? (totalRevenue * (parseFloat(c.valor || 0) / 100)) : parseFloat(c.valor || 0)), 0);
  const lucroReal = fatLiquido - totalFees - totalFreteSeller - totalCMV - totalImpostosMes - totalCustosFixosMes;
  const avgScore = Math.round(enriched.reduce((s, l) => s + l.score, 0) / (enriched.length || 1));

  function getFreteDisplay(l) {
    const hasFreeShipping = l.shipping?.free_shipping;
    const cost = l.freteSeller;
    if (hasFreeShipping) {
      return {
        topLabel: "Grátis ao comprador",
        topColor: "#0a9d4e",
        topBg: "rgba(0,200,83,.12)",
        bottomLabel: cost > 0 ? `Seu custo: ${fmt(cost)}` : "Seu custo: calculando...",
        bottomColor: "#7c3aed",
      };
    }
    return {
      topLabel: "Comprador paga",
      topColor: "#1976FF",
      topBg: "rgba(59,140,255,.14)",
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

  if (!currentUser) {
    // Enquanto valida o cookie (ex.: guia recém-aberta), não pisca o login: mostra um loading.
    if (authChecking) return (
      <div style={{ minHeight:"100vh", backgroundColor:"var(--bg)", display:"flex", alignItems:"center", justifyContent:"center", color:"var(--text-3)", fontFamily:"'Inter',system-ui,sans-serif", fontSize:14 }}>
        Carregando…
      </div>
    );
    return <LoginScreen onLogin={(user) => { setCurrentUser(user); }} />;
  }

  return (
    <div className={darkMode?"dark":""} style={{ minHeight:"100vh", background:"transparent", color:"var(--text-strong)", fontFamily:"'Inter',system-ui,sans-serif", transition:"background .2s,color .2s", display:"flex", alignItems:"flex-start" }}>
      <style>{`
        *{box-sizing:border-box;margin:0;padding:0}
        body,#root{font-family:'Inter',system-ui,sans-serif}
        input:not([type=checkbox]):not([type=radio]),textarea,select{background:var(--bg-2);color:var(--text-strong);border:1px solid var(--border)}
        input::placeholder,textarea::placeholder{color:var(--text-3)}
        ::-webkit-scrollbar{width:4px;height:4px}
        ::-webkit-scrollbar-track{background:transparent}
        ::-webkit-scrollbar-thumb{background:var(--text-4);border-radius:99px}
        ::-webkit-scrollbar-thumb:hover{background:var(--text-3)}
        .app-header::-webkit-scrollbar{display:none}
        /* Barra de rolagem horizontal visível e "pegável" nas tabelas largas */
        .scroll-x{overflow-x:auto;overflow-y:visible}
        .scroll-x::-webkit-scrollbar{height:12px}
        .scroll-x::-webkit-scrollbar-track{background:rgba(255,255,255,.05);border-radius:8px}
        .scroll-x::-webkit-scrollbar-thumb{background:var(--text-4);border-radius:8px;border:2px solid transparent;background-clip:padding-box}
        .scroll-x::-webkit-scrollbar-thumb:hover{background:#7C8AAE}
        input:focus,textarea:focus,select:focus{outline:2px solid #1976FF;outline-offset:1px}

        /* ── TABELAS ── */
        table{border-collapse:collapse;width:100%}
        th{font-family:'JetBrains Mono',monospace;font-size:9.5px;color:var(--text-3);text-transform:uppercase;letter-spacing:0.12em;padding:10px 14px;border-bottom:1px solid var(--border);text-align:left;font-weight:700;background:var(--bg-2);white-space:nowrap}
        td{padding:10px 14px;font-size:13px;border-bottom:1px solid var(--border);vertical-align:middle;color:var(--text-2)}
        tr:last-child td{border-bottom:none}
        tbody tr:hover td{background:var(--bg-2);transition:background .1s}
        .dark th{background:var(--bg-2)!important;border-bottom-color:var(--text-2)!important;color:var(--text-2)!important}
        .dark td{border-bottom-color:var(--bg-2)!important;color:var(--text-4)!important}
        .dark tbody tr:hover td{background:var(--bg-2)!important}

        /* ── FILTRO PERIOD ── */
        .filter-btn{background:var(--surface);border:1px solid var(--border);color:var(--text-2);padding:5px 14px;cursor:pointer;font-family:inherit;font-size:12px;border-radius:20px;transition:all .15s;font-weight:500}
        .filter-btn.active{background:#1976FF;border-color:#1976FF;color:#fff;font-weight:600}
        .filter-btn:hover:not(.active){background:var(--bg-2);border-color:var(--text-4)}
        .dark .filter-btn{background:var(--bg-2);border-color:var(--text-2);color:var(--text-3)}
        .dark .filter-btn.active{background:var(--surface-3);color:var(--text-strong)}

        /* ── SUB-ABAS (Financeiro, etc) ── */
        .tab-btn{background:transparent;border:none;border-bottom:2px solid transparent;color:var(--text-3);padding:14px 18px;cursor:pointer;font-family:inherit;font-size:13px;transition:all .15s;font-weight:500;border-radius:0}
        .tab-btn.active{color:var(--text-strong);border-bottom-color:var(--text-strong);font-weight:600}
        .tab-btn:hover:not(.active){color:var(--text-2);background:var(--bg-2)}
        .dark .tab-btn{color:var(--text-2)}
        .dark .tab-btn.active{color:var(--text-2);border-bottom-color:var(--text-2)}

        /* ── INPUTS ── */
        .search-input{width:100%;background:var(--surface);border:1px solid var(--border);color:var(--text-strong);padding:8px 14px 8px 38px;border-radius:8px;font-family:inherit;font-size:13px;outline:none;transition:border .15s}
        .search-input:focus{border-color:#1976FF;box-shadow:0 0 0 3px rgba(15,23,42,.06)}
        .dark input{background:var(--bg-2)!important;border-color:var(--text-2)!important;color:var(--text-2)!important}
        .dark select{background:var(--bg-2);border-color:var(--text-2);color:var(--text-2)}

        /* ── MISC ── */
        .copy-btn{background:transparent;border:none;color:var(--text-4);cursor:pointer;padding:2px 5px;border-radius:4px;font-size:11px;transition:all .15s}
        .copy-btn:hover{background:var(--surface-3);color:var(--text-2)}
        .title-link{color:#1976FF;text-decoration:none;font-weight:500;transition:color .15s}
        .title-link:hover{color:#1976FF;text-decoration:underline}
        select{background:var(--surface);border:1px solid var(--border);color:var(--text-2);padding:7px 12px;border-radius:8px;font-family:inherit;font-size:13px;cursor:pointer;font-weight:400}

        /* ── CARDS ── */
        .sl-card{background:var(--surface);border:1px solid var(--border);border-radius:12px;box-shadow:0 1px 3px rgba(15,23,42,.04)}

        /* ── ANIMAÇÕES ── */
        @keyframes fadeUp{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
        .fade-up{animation:fadeUp .25s ease forwards}
        @keyframes slPulse{0%,100%{opacity:1}50%{opacity:.4}}
      `}</style>

      {/* ── BARRA LATERAL ESQUERDA — logo + abas (vertical) + status + botões (Config por último) ── */}
      <aside style={{ width:214, flexShrink:0, position:"sticky", top:0, height:"100vh", overflowY:"auto",
        background:darkMode?"var(--bg)":"var(--bg-2)", borderRight:"1px solid var(--border-soft)",
        display:"flex", flexDirection:"column", padding:"14px 12px", zIndex:100 }}>
        {/* Logo */}
        <div style={{ display:"flex", alignItems:"center", gap:9, padding:"2px 6px 14px", borderBottom:"1px solid var(--border-soft)", marginBottom:10 }}>
          <div style={{ width:34, height:34, borderRadius:"50%", background:"rgba(77,179,255,.12)", border:"1px solid rgba(77,179,255,.45)", boxShadow:"0 0 14px rgba(77,179,255,.35)", display:"flex", alignItems:"center", justifyContent:"center", fontFamily:"'Space Grotesk',sans-serif", fontWeight:700, fontSize:15, color:"#1976FF", letterSpacing:-0.5, flexShrink:0 }}>F</div>
          <div>
            <div style={{ fontFamily:"'Space Grotesk',sans-serif", fontWeight:700, fontSize:15, color:"var(--text-strong)", letterSpacing:-0.4, lineHeight:1.2 }}>Flow</div>
            <div style={{ fontFamily:"'JetBrains Mono',monospace", fontSize:8, color:"var(--text-3)", letterSpacing:2, textTransform:"uppercase", lineHeight:1, marginTop:2 }}>Marketplaces</div>
          </div>
        </div>
        {/* Abas de navegação — verticais */}
        <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
          {(function() {
            var grupos = [
              { titulo:"Operação", itens:[
                { key:"dashboard", label:"Dashboard" },
                { key:"produtos", label:"Produtos" },
                currentUser?.permissoes?.includes("listings") && { key:"listings", label:"Anúncios" },
                { key:"vincular", label:"Vincular anúncios" },
                currentUser?.permissoes?.includes("listings") && { key:"precificacao", label:"Precificação" },
                currentUser?.permissoes?.includes("orders") && { key:"orders", label:"Vendas" },
                { key:"expedicao", label:"Expedição" },
                { key:"compras", label:"Compras" },
                { key:"estoque", label:"Estoque" },
              ]},
              { titulo:"Financeiro", itens:[
                { key:"contas_pagar", label:"Contas a pagar" },
                { key:"contas_receber", label:"Contas a receber" },
                { key:"clientes", label:"Clientes" },
                { key:"fornecedores", label:"Fornecedores" },
                { key:"notas_fiscais", label:"Notas fiscais" },
                { key:"dre", label:"DRE e conciliação" },
              ]},
              { titulo:"Inteligência", itens:[
                { key:"relatorios", label:"Relatórios" },
                currentUser?.permissoes?.includes("listings") && { key:"concorrencia", label:"Concorrência" },
              ]},
              { titulo:"Configuração", itens:[
                currentUser?.permissoes?.includes("admin") && { key:"admin", label:"Equipe" },
                { key:"integracoes", label:"Integrações" },
              ]},
            ];
            function renderItem(t) {
              var isActive = tab === t.key;
              var estilo = {
                display:"flex", alignItems:"center", justifyContent:"space-between", gap:6, width:"100%", boxSizing:"border-box",
                padding:"9px 12px", borderRadius:9, border:"none", cursor:"pointer", fontFamily:"inherit",
                fontSize:13, textAlign:"left", textDecoration:"none",
                background: isActive ? "rgba(25,118,255,.16)" : "transparent",
                color: isActive ? "var(--text-strong)" : "var(--text-3)",
                fontWeight: isActive ? 700 : 500,
                borderLeft: "3px solid "+(isActive ? "#1976FF" : "transparent"),
                transition:"background .15s,color .15s",
              };
              var conteudo = [
                <span key="l" style={{ whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{t.label}</span>,
                t.badge != null ? (
                  <span key="b" style={{ fontSize:10, fontWeight:700, padding:"1px 7px", borderRadius:10, flexShrink:0,
                    background: isActive ? "#1976FF" : "var(--surface-3)",
                    color: isActive ? "#fff" : "var(--text-3)", lineHeight:1.6 }}>
                    {t.badge}
                  </span>
                ) : null,
              ];
              // "Configurações" abre um painel (modal), então segue como botão.
              if (t.acao === "config") {
                return (
                  <button key={t.key} onClick={function(){ setShowConfigPanel(true); setConfigPanelTab("aparencia"); }} style={estilo}>
                    {conteudo}
                  </button>
                );
              }
              // Demais itens são LINKS reais: clique esquerdo troca a aba (sem recarregar); clique
              // direito, do meio ou com Ctrl/Cmd → o navegador abre em NOVA GUIA nativamente (a opção
              // "Abrir em nova guia" aparece sozinha no menu de contexto do link).
              return (
                <a key={t.key} href={"?tab=" + t.key}
                  onClick={function(e){ if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; e.preventDefault(); setTab(t.key); }}
                  style={estilo}>
                  {conteudo}
                </a>
              );
            }
            return grupos.map(function(g){
              var itens = g.itens.filter(Boolean);
              if (!itens.length) return null;
              return (
                <div key={g.titulo} style={{ marginBottom:4 }}>
                  <div style={{ fontSize:9, fontWeight:700, letterSpacing:1.4, textTransform:"uppercase", color:"var(--text-4)", padding:"12px 12px 5px" }}>{g.titulo}</div>
                  {itens.map(renderItem)}
                </div>
              );
            });
          })()}
        </div>

        {/* Empurra o rodapé (status + botões) para baixo */}
        <div style={{ flex:1, minHeight:14 }} />

        {/* Rodapé: status + botões (Config por último) */}
        <div style={{ borderTop:"1px solid var(--border-soft)", paddingTop:10, display:"flex", flexDirection:"column", gap:8 }}>
          <div style={{ display:"flex", alignItems:"center", gap:6, flexWrap:"wrap" }}>
            {!token && <span style={{ background: "var(--surface-3)", border: "1px solid var(--border)", color: "var(--text-3)", fontSize: 10, padding: "3px 9px", borderRadius: 20, fontWeight: 600 }}>● Não conectado</span>}
            {token && <span style={{ background: "rgba(0,200,83,.12)", border: "1px solid rgba(0,200,83,.35)", color: "#0a9d4e", fontSize: 10, padding: "3px 9px", borderRadius: 20, fontWeight: 700, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", maxWidth:"100%" }}>● {user?.nickname}</span>}
            <SinoNotificacoes notificacoes={notificacoes} setNotificacoes={setNotificacoes} darkMode={darkMode} />
          </div>
          {loading && <span style={{ color: "var(--text-3)", fontSize: 11 }}>⏳ {loadingMsg}</span>}
          {loadError && <span style={{ color: "#FF5252", fontSize: 11 }}>⚠ {loadError}</span>}
          {token && lastUpdate && (() => {
            const mins = Math.round((Date.now() - parseInt(lastUpdate)) / 60000);
            const horas = Math.floor(mins / 60);
            const isStale = mins >= 300;
            return (
              <div style={{ fontSize:10, lineHeight:1.4 }}>
                <span style={{ color: isStale ? "#FF5252" : "var(--text-3)" }}>{isStale ? "⚠️ " : "✓ "}{horas > 0 ? `${horas}h ${mins%60}min` : `${mins}min`} atrás</span>
                <span style={{ color:"var(--text-4)" }}> · {isStale ? "token expirando" : "atualizado"}</span>
              </div>
            );
          })()}
          {token && (
            <button onClick={clicarAtualizarManual} disabled={refreshingManual}
              title="Busca pedidos novos e atualiza os dados sem recarregar tudo"
              style={{ background: refreshingManual?"var(--surface-3)":"var(--surface)", border: "1px solid var(--border)", color: "var(--text-2)", fontWeight: 600, padding: "9px", borderRadius: 8, cursor: refreshingManual?"wait":"pointer", fontSize: 12, width:"100%" }}>
              {refreshingManual ? "⏳ Atualizando..." : refreshManualMsg ? refreshManualMsg : "🔄 Atualizar"}
            </button>
          )}
          <button onClick={function(){ window.location.href = "/api/auth/login"; }}
            style={{ background: "#1976FF", border: "none", color: "#fff", fontWeight: 700, padding: "9px", borderRadius: 8, cursor: "pointer", fontSize: 12, width:"100%" }}>
            {token ? "Reconectar" : "Conectar ML"}
          </button>
          <div style={{ display:"flex", alignItems:"center", gap:6, background:"var(--surface)", border:"1px solid var(--border)", borderRadius:8, padding:"6px 8px" }}>
            <div style={{ width:26, height:26, borderRadius:8, background:"#1976FF", display:"flex", alignItems:"center", justifyContent:"center", fontSize:12, fontWeight:800, color:"#FFC107", flexShrink:0 }}>
              {currentUser?.nome?.charAt(0).toUpperCase()}
            </div>
            <div style={{ fontSize:12, lineHeight:1.3, minWidth:0 }}>
              <div style={{ fontWeight:600, color:"var(--text-strong)", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{currentUser?.nome}</div>
              <div style={{ color:"var(--text-3)", fontSize:10 }}>{currentUser?.admin?"Admin":"Usuário"}</div>
            </div>
          </div>
          <button onClick={() => { fetch("/api/auth/app-logout", { method:"POST" }).catch(()=>{}); clearSession(); clearSavedTokens(); setCurrentUser(null); setToken(null); setUser(null); }}
            style={{ background:"rgba(255,82,82,.12)", border:"1px solid rgba(255,82,82,.35)", color:"#FF5252", fontWeight:600, padding:"9px", borderRadius:8, cursor:"pointer", fontSize:12, width:"100%" }}>
            Sair
          </button>
          {/* Alternador de tema (substitui o botão de Configurações no rodapé) */}
          <button onClick={function(){ setDarkMode(function(d){ var nd = !d; try { localStorage.setItem("darkMode", nd ? "1" : "0"); } catch(e){} return nd; }); }}
            style={{ background:"var(--surface)", border:"1px solid var(--border)", color:"var(--text-2)", fontWeight:600, padding:"9px", borderRadius:8, cursor:"pointer", fontSize:12, width:"100%" }}>
            {darkMode ? "Tema claro" : "Tema escuro"}
          </button>
        </div>
      </aside>

      {/* Coluna do conteúdo */}
      <div style={{ flex:1, minWidth:0 }}>
      <main style={{ maxWidth: "100%", padding: "12px 20px" }}>

        {/* Abas agora estão no header */}

        {tab === "listings" && currentUser?.permissoes?.includes("listings") && (
          <>
            {/* Sub-abas de Anúncios */}
            <div style={{ display:"flex", gap:2, borderBottom:"2px solid var(--border)", marginBottom:10 }}>
              {[
                { key:"ml",    label:"🟡 Anúncios Mercado Livre", badge: enriched.length },
                { key:"outros",label:"➕ Outros Marketplaces",    badge: null },
              ].map(function(t){
                var active = (abaAnuncio) === t.key;
                return (
                  <button key={t.key}
                    onClick={function(){ setAbaAnuncio(t.key); }}
                    style={{ display:"flex", alignItems:"center", gap:8, padding:"10px 20px", border:"none",
                      borderBottom: active?"2px solid #1976FF":"2px solid transparent", marginBottom:-2,
                      background:"transparent", color:active?"var(--text-strong)":"var(--text-3)",
                      fontWeight:active?700:400, fontSize:13, cursor:"pointer", fontFamily:"inherit" }}>
                    {t.label}
                    {t.badge != null && (
                      <span style={{ background:active?"#1976FF":"var(--surface-3)", color:active?"#fff":"var(--text-2)",
                        fontSize:11, fontWeight:700, padding:"1px 7px", borderRadius:20 }}>{t.badge}</span>
                    )}
                  </button>
                );
              })}
            </div>
            {/* Conteúdo — só ML por enquanto */}
            {(abaAnuncio) === "outros" ? (
              <div style={{ textAlign:"center", padding:"60px 20px", color:"var(--text-3)" }}>
                <div style={{ fontSize:48, marginBottom:12 }}>🔌</div>
                <div style={{ fontWeight:700, fontSize:16, color:"var(--text-strong)", marginBottom:8 }}>Em breve: outros marketplaces</div>
                <div style={{ fontSize:13 }}>Integração com Shopee, Shein, Amazon e outros em desenvolvimento</div>
              </div>
            ) : (
            <LayoutFiltros
              filtros={
                <>
                  <FiltroGrupo titulo="Status">
                    {[{key:"all",label:"Todos"},{key:"active",label:"● Ativos"},{key:"paused",label:"○ Pausados"}].map(function(f){
                      return <FiltroBotao key={f.key} label={f.label} active={statusFilter===f.key}
                        cor={f.key==="active"?"#0a9d4e":f.key==="paused"?"var(--text-3)":"var(--text-strong)"}
                        bg={f.key==="active"?"rgba(0,200,83,.12)":f.key==="paused"?"var(--surface-3)":"var(--surface-3)"}
                        onClick={function(){setStatusFilter(f.key);}} />;
                    })}
                  </FiltroGrupo>
                  <FiltroGrupo titulo="Situação">
                    {[{k:"all",l:"Todos"},{k:"sem_custo",l:"⚠️ Sem custo",cor:"#FF5252",bg:"rgba(255,82,82,.12)"},{k:"sem_atacado",l:"🏷 Sem preço atacado",cor:"#7c3aed",bg:"rgba(139,92,246,.14)"},{k:"com_promo",l:"🔥 Com promoção",cor:"#7c3aed",bg:"rgba(139,92,246,.14)"},{k:"sem_promo",l:"○ Sem promoção",cor:"var(--text-2)",bg:"var(--surface-3)"},{k:"frete_alto",l:"🚚 Frete acima do config.",cor:"#FFC107",bg:"rgba(255,193,7,.10)"}].map(function(f){
                      return <FiltroBotao key={f.k} label={f.l} active={filterListingExtra===f.k}
                        cor={f.cor||"var(--text-strong)"} bg={f.bg||"var(--surface-3)"}
                        onClick={function(){setFilterListingExtra(f.k);setPaginaAnuncios(1);}} />;
                    })}
                  </FiltroGrupo>
                  <FiltroGrupo titulo="Ordenar">
                    {[
                      {k:"score",      l:"⚠ Pior score"},
                      {k:"margin",     l:"📈 Maior margem"},
                      {k:"profit",     l:"💰 Maior lucro"},
                      {k:"sales_desc", l:"🔥 Mais vendidos"},
                      {k:"sales_asc",  l:"📉 Menos vendidos"},
                    ].map(function(o){
                      return <FiltroBotao key={o.k} label={o.l} active={sortBy===o.k} cor="var(--text-strong)" bg="var(--surface-3)" onClick={function(){setSortBy(o.k);}} />;
                    })}
                  </FiltroGrupo>
                  <div style={{ fontSize:11, color:"var(--text-3)", marginTop:"auto" }}>{sorted.length} anúncio(s)</div>
                </>
              }
              busca={
                <div style={{ display:"flex", gap:6 }}>
                  <div style={{ position:"relative", flex:1 }}>
                    <span style={{ position:"absolute", left:10, top:"50%", transform:"translateY(-50%)", color:"var(--text-3)", fontSize:13 }}>🔍</span>
                    <input className="search-input" value={searchListings} onChange={function(e){setSearchListings(e.target.value);}}
                      placeholder={searchType==="title"?"Buscar por título...":searchType==="sku"?"Buscar por SKU exato...":searchType==="mlb"?"Buscar por MLB...":"Buscar por título, MLB ou SKU..."} style={{ paddingLeft:34 }} />
                  </div>
                  <select value={searchType} onChange={function(e){setSearchType(e.target.value);}} style={{ minWidth:100 }}>
                    <option value="all">Tudo</option>
                    <option value="title">Título</option>
                    <option value="sku">SKU exato</option>
                    <option value="mlb">MLB</option>
                  </select>
                </div>
              }>

            <div className="scroll-x" style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, overflow: "auto", boxShadow: "0 1px 3px rgba(0,0,0,.04)" }}>
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
                    <tr><td colSpan={15} style={{ textAlign: "center", color: "var(--text-3)", padding: 40 }}>Nenhum anúncio encontrado</td></tr>
                  ) : sorted.slice((paginaAnuncios-1)*POR_PAG_ANUNCIOS, paginaAnuncios*POR_PAG_ANUNCIOS).map(l => {
                    const frete = getFreteDisplay(l);
                    const typeInfo = getListingTypeLabel(l.listing_type_id);
                    return (
                      <tr key={l.id}>
                        <td style={{ width: 56, padding: "8px 8px 8px 14px" }}>
                          <a href={l.permalink ?? `https://www.mercadolivre.com.br/p/${l.id}`} target="_blank" rel="noreferrer">
                            {l.pictures?.[0]?.url ? (
                              <img src={l.pictures[0].url} alt="" style={{ width: 44, height: 44, objectFit: "cover", borderRadius: 8, border: "1px solid var(--border)", display: "block" }} />
                            ) : (
                              <div style={{ width: 44, height: 44, borderRadius: 8, background: "var(--surface-3)", border: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>📦</div>
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
                              <span key={c.key} style={{ fontSize: 10, color: "#FF5252", background: "rgba(255,82,82,.12)", border: "1px solid rgba(255,82,82,.35)", padding: "1px 6px", borderRadius: 4, fontWeight: 500 }}>✗ {c.label}</span>
                            ))}
                            <span style={{ fontSize: 10, padding: "1px 7px", borderRadius: 4, fontWeight: 500, background: l.status === "active" ? "rgba(0,200,83,.12)" : "var(--bg-2)", color: l.status === "active" ? "#0a9d4e" : "var(--text-3)", border: `1px solid ${l.status === "active" ? "rgba(0,200,83,.35)" : "var(--border)"}` }}>
                              {l.status === "active" ? "● ativo" : "○ pausado"}
                            </span>
                          </div>
                        </td>
                        <td>
                          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                            <span style={{ fontSize: 11, color: "var(--text-2)", fontFamily: "monospace", fontWeight: 600 }}>{l.id}</span>
                            <button className="copy-btn" onClick={() => navigator.clipboard.writeText(l.id)}>⎘</button>
                          </div>
                          {l.sku ? (
                            <div style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 3 }}>
                              <span style={{ fontSize: 10, color: "var(--text-3)" }}>SKU:</span>
                              <span style={{ fontSize: 11, color: "var(--text-2)", fontFamily: "monospace", fontWeight: 600 }}>{l.sku}</span>
                              <button className="copy-btn" onClick={() => navigator.clipboard.writeText(l.sku)}>⎘</button>
                            </div>
                          ) : <div style={{ fontSize: 10, color: "var(--text-4)", marginTop: 3 }}>SKU: —</div>}
                        </td>
                        <td>
                          {(() => {
                            const qty = l.available_quantity ?? 0;
                            const min = minStock[l.id] ?? 0;
                            const abaixo = min > 0 && qty < min;
                            const color = abaixo ? "#FF5252" : qty === 0 ? "#FF5252" : qty <= 5 ? "#FFC107" : "#0a9d4e";
                            const bg = abaixo ? "rgba(255,82,82,.12)" : qty === 0 ? "rgba(255,82,82,.12)" : qty <= 5 ? "rgba(255,193,7,.12)" : "rgba(0,200,83,.12)";
                            return (
                              <div>
                                <span style={{ fontWeight: 700, fontSize: 13, color, background: bg, padding: "3px 10px", borderRadius: 6, display: "inline-block", marginBottom: 4 }}>
                                  {qty} un. {abaixo ? "⚠" : ""}
                                </span>
                                <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                                  <span style={{ fontSize: 10, color: "var(--text-3)" }}>Mín:</span>
                                  <input type="number" value={minStock[l.id] ?? ""} onChange={e => setMinStockAndSave(m => ({ ...m, [l.id]: Number(e.target.value), ["_src_"+l.id]: "manual" }))} placeholder="0"
                                    title="Editar aqui marca como manual; para voltar a sincronizar com o cadastro do produto, defina o Estoque Mínimo em Produtos novamente"
                                    style={{ background: "var(--bg-2)", border: "1px solid var(--border)", color: "var(--text-strong)", padding: "2px 6px", borderRadius: 4, width: 52, fontSize: 11, textAlign: "right" }} />
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
                            <span style={{ fontSize: 13, color: "var(--text-3)", textDecoration: "line-through" }}>{fmt(l.originalPrice)}</span>
                          ) : (
                            <span style={{ fontWeight: 700, color: "var(--text-strong)", fontSize: 13 }}>{fmt(l.originalPrice)}</span>
                          )}
                        </td>
                        <td>
                          {l.hasPromo ? (
                            <div>
                              <span style={{ fontWeight: 700, color: "#FF5252", fontSize: 13 }}>{fmt(l.salePrice)}</span>
                              <span style={{ fontSize: 10, color: "#FF5252", background: "rgba(255,82,82,.12)", padding: "1px 6px", borderRadius: 4, fontWeight: 600, marginLeft: 4 }}>Promo</span>
                            </div>
                          ) : (
                            <span style={{ fontWeight: 700, color: "var(--text-strong)" }}>{fmt(l.salePrice)}</span>
                          )}
                        </td>
                        <td>
                          <span style={{ color: "#FFC107", fontWeight: 700 }}>{fmt(l.fee)}</span>
                          <div style={{ fontSize: 10, color: "var(--text-3)" }}>{fmtPct(l.feeRate)}</div>
                        </td>
                        <td>
                          <div style={{ fontSize: 11, color: frete.topColor, background: frete.topBg, padding: "2px 7px", borderRadius: 5, fontWeight: 600, display: "inline-block", marginBottom: 3 }}>{frete.topLabel}</div>
                          <div style={{ fontSize: 11, color: frete.bottomColor, fontWeight: 700 }}>{frete.bottomLabel}</div>
                          {(function(){
                            try {
                              var fretesConf = JSON.parse(localStorage.getItem("fretes_config")||"{}");
                              var fc = parseFloat(fretesConf[l.id]||0);
                              var fr = l.freteSeller||0;
                              if (fc>0 && fr>fc) return (
                                <div style={{ marginTop:2 }}>
                                  <span style={{ fontSize:9, fontWeight:700, background:"rgba(255,193,7,.10)", color:"#FFC107", border:"1px solid rgba(255,193,7,.35)", padding:"1px 5px", borderRadius:3, whiteSpace:"nowrap" }}>
                                    🚚 frete +R${(fr-fc).toFixed(2).replace(".",",")}
                                  </span>
                                </div>
                              );
                            } catch {}
                            return null;
                          })()}
                        </td>
                        <td>
                          <span style={{ fontWeight: 700, color: "#0a9d4e", fontSize: 13 }}>{fmt(l.youReceive)}</span>
                          <div style={{ fontSize: 10, color: "var(--text-3)" }}>após tarifa e frete</div>
                        </td>
                        <td>
                          <input type="number" value={l.cost || ""} onChange={e => setCostsAndSave(c => ({ ...c, [l.id]: Number(e.target.value) }))} placeholder="0,00"
                            onFocus={function(){ setEditandoCustoId(l.id); }}
                            onBlur={function(){ setEditandoCustoId(function(cur){ return cur === l.id ? null : cur; }); }}
                            style={{ background: "var(--bg-2)", border: "1px solid var(--border)", color: "var(--text-strong)", padding: "5px 8px", borderRadius: 6, width: 80, fontSize: 12, textAlign: "right" }} />
                        </td>
                        <td style={{ color: l.profit >= 0 ? "#0a9d4e" : "#FF5252", fontWeight: 700 }}>{fmt(l.profit)}</td>
                        <td style={{ minWidth: 130 }}><MarginBar value={l.margin} /></td>
                        <td>
                          <span style={{ color: l.totalProfit >= 0 ? "#0a9d4e" : "#FF5252", fontWeight: 700 }}>{l.cost > 0 ? fmt(l.totalProfit) : "—"}</span>
                          <div style={{ fontSize: 10, color: "var(--text-3)" }}>{l.sold_quantity} vendidos</div>
                        </td>
                        <td>
                          <button onClick={() => setSelectedListing(l)} style={{ background: "#1976FF", border: "none", color: "#fff", fontSize: 11, padding: "5px 12px", borderRadius: 6, cursor: "pointer", fontWeight: 600, whiteSpace: "nowrap" }}>✦ Analisar</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <Paginacao
              total={sorted.length}
              porPagina={POR_PAG_ANUNCIOS}
              paginaAtual={paginaAnuncios}
              onMudar={function(p){ setPaginaAnuncios(p); window.scrollTo({top:0,behavior:"smooth"}); }}
            />
            </LayoutFiltros>
            )} {/* fecha condicional ml */}
          </>
        )}

        {tab === "orders" && currentUser?.permissoes?.includes("orders") && (
          <>
            {/* Sub-abas de Pedidos */}
            <div style={{ display:"flex", gap:2, borderBottom:"2px solid var(--border)", marginBottom:10 }}>
              {[
                { key:"ml",    label:"🟡 Pedidos Mercado Livre", badge: enrichedOrders.length },
                { key:"outros",label:"➕ Outros Marketplaces",   badge: null },
              ].map(function(t){
                var active = (abaPedido) === t.key;
                return (
                  <button key={t.key}
                    onClick={function(){ setAbaPedido(t.key); }}
                    style={{ display:"flex", alignItems:"center", gap:8, padding:"10px 20px", border:"none",
                      borderBottom: active?"2px solid #1976FF":"2px solid transparent", marginBottom:-2,
                      background:"transparent", color:active?"var(--text-strong)":"var(--text-3)",
                      fontWeight:active?700:400, fontSize:13, cursor:"pointer", fontFamily:"inherit" }}>
                    {t.label}
                    {t.badge != null && (
                      <span style={{ background:active?"#1976FF":"var(--surface-3)", color:active?"#fff":"var(--text-2)",
                        fontSize:11, fontWeight:700, padding:"1px 7px", borderRadius:20 }}>{t.badge}</span>
                    )}
                  </button>
                );
              })}
            </div>
            {(abaPedido) === "outros" ? (
              <div style={{ textAlign:"center", padding:"60px 20px", color:"var(--text-3)" }}>
                <div style={{ fontSize:48, marginBottom:12 }}>🔌</div>
                <div style={{ fontWeight:700, fontSize:16, color:"var(--text-strong)", marginBottom:8 }}>Em breve: outros marketplaces</div>
                <div style={{ fontSize:13 }}>Integração com Shopee, Shein, Amazon e outros em desenvolvimento</div>
              </div>
            ) : (
            <LayoutFiltros
              filtros={
                <>
                  <FiltroGrupo titulo="Período">
                    {[{key:"today",l:"Hoje"},{key:"week",l:"7 dias"},{key:"thismonth",l:"Este mês"},{key:"month",l:"30 dias"},{key:"3months",l:"3 meses"},{key:"all",l:"Todos"}].map(function(f){
                      return <FiltroBotao key={f.key} label={f.l} active={orderFilter===f.key} cor="var(--text-strong)" bg="var(--surface-3)" onClick={function(){setOrderFilter(f.key);}} />;
                    })}
                  </FiltroGrupo>
                  <FiltroGrupo titulo="Status">
                    {[{key:"all",l:"Todos"},{key:"waiting",l:"⏳ Ag. envio"},{key:"shipped",l:"🚚 Enviados"},{key:"done",l:"✓ Concluídos"},{key:"cancelled",l:"✗ Cancelados"},{key:"refunded",l:"↩ Devolvidos"},{key:"mediation",l:"⚠ Disputa"}].map(function(f){
                      return <FiltroBotao key={f.key} label={f.l} active={orderStatusFilter===f.key} cor="var(--text-strong)" bg="var(--surface-3)" onClick={function(){setOrderStatusFilter(f.key);}} />;
                    })}
                  </FiltroGrupo>
                  <FiltroGrupo titulo="Tipo de Envio">
                    {[{key:"todos",l:"Todos"},{key:"FULL",l:"FULL",c:"#1976FF",bg:"rgba(59,140,255,.14)"},{key:"Flex",l:"Flex",c:"#7c3aed",bg:"rgba(139,92,246,.14)"},{key:"ME2",l:"ME2",c:"#0e7490",bg:"rgba(0,240,255,.10)"},{key:"ME1",l:"ME1",c:"#1976FF",bg:"rgba(77,179,255,.2)"}].map(function(e){
                      return <FiltroBotao key={e.key} label={e.l} active={filterEnvio===e.key} cor={e.c||"var(--text-strong)"} bg={e.bg||"var(--surface-3)"} onClick={function(){setFilterEnvio(e.key);setPaginaPedidos(1);}} />;
                    })}
                  </FiltroGrupo>
                  <FiltroGrupo titulo="Outros Filtros">
                    <input value={filterSku} onChange={function(e){setFilterSku(e.target.value);}} placeholder="SKU do produto..."
                      style={{ width:"100%", background:"var(--surface)", border:"1px solid var(--border)", color:"var(--text-strong)", padding:"6px 8px", borderRadius:7, fontSize:11, outline:"none" }} />
                    <select value={filterUF} onChange={function(e){setFilterUF(e.target.value);}}
                      style={{ width:"100%", background:"var(--surface)", border:"1px solid var(--border)", color:"var(--text-2)", padding:"6px 8px", borderRadius:7, fontSize:11 }}>
                      <option value="">Estado (UF)</option>
                      {["AC","AL","AP","AM","BA","CE","DF","ES","GO","MA","MT","MS","MG","PA","PB","PR","PE","PI","RJ","RN","RS","RO","RR","SC","SP","SE","TO"].map(function(uf){return <option key={uf} value={uf}>{uf}</option>;})}
                    </select>
                    <div style={{ display:"flex", gap:4, alignItems:"center" }}>
                      <input type="date" value={dateFrom} onChange={function(e){setDateFrom(e.target.value);}}
                        style={{ flex:1, background:"var(--surface)", border:"1px solid var(--border)", color:"var(--text-2)", padding:"5px 6px", borderRadius:7, fontSize:11 }} />
                    </div>
                    <div style={{ display:"flex", gap:4, alignItems:"center" }}>
                      <span style={{ fontSize:10, color:"var(--text-3)" }}>até</span>
                      <input type="date" value={dateTo} onChange={function(e){setDateTo(e.target.value);}}
                        style={{ flex:1, background:"var(--surface)", border:"1px solid var(--border)", color:"var(--text-2)", padding:"5px 6px", borderRadius:7, fontSize:11 }} />
                    </div>
                    {(filterSku||filterUF||dateFrom||dateTo) && (
                      <button onClick={function(){setFilterSku("");setFilterUF("");setDateFrom("");setDateTo("");}}
                        style={{ background:"rgba(255,82,82,.12)", border:"1px solid rgba(255,82,82,.35)", color:"#FF5252", padding:"5px 8px", borderRadius:7, cursor:"pointer", fontSize:11, width:"100%" }}>✕ Limpar filtros</button>
                    )}
                  </FiltroGrupo>
                  <div style={{ fontSize:11, color:"var(--text-3)", marginTop:"auto" }}>{enrichedOrders.length} pedido(s)<br/>{fmt(enrichedOrders.reduce(function(s,o){return s+o.price*o.qty;},0))}</div>
                </>
              }
              busca={
                <div style={{ position:"relative" }}>
                  <span style={{ position:"absolute", left:10, top:"50%", transform:"translateY(-50%)", color:"var(--text-3)", fontSize:13 }}>🔍</span>
                  <input className="search-input" value={searchOrders} onChange={function(e){setSearchOrders(e.target.value);}}
                    placeholder="Buscar por nº pedido, cliente, CPF, e-mail..." style={{ width:"100%", paddingLeft:36 }} />
                </div>
              }>
              <div className="scroll-x" style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, overflow: "auto", boxShadow: "0 1px 3px rgba(0,0,0,.04)" }}>
              <table style={{ borderCollapse:"collapse", width:"100%", tableLayout:"fixed" }}>
                <colgroup>
                  <col style={{ width:130 }} />
                  <col style={{ width:88  }} />
                  <col style={{ width:58  }} />
                  <col style={{ width:88  }} />
                  <col style={{ width:200 }} />
                  <col style={{ width:88  }} />
                  <col style={{ width:88  }} />
                  <col style={{ width:40  }} />
                  <col style={{ width:88  }} />
                  <col style={{ width:88  }} />
                  <col style={{ width:88  }} />
                  <col style={{ width:80  }} />
                  <col style={{ width:120 }} />
                </colgroup>
                <thead>
                  <tr>
                    {["Pedido","Status","Envio","Cliente","Produto","Data","Preço","Qtd","Tarifa ML","Frete","Você recebe","Lucro","Margem"].map(function(h,i){
                      var align = [6,7,8,9,10,11].includes(i) ? "right" : i===7 ? "center" : "left";
                      return <th key={h} style={{ fontSize:11, color:"var(--text-3)", textTransform:"uppercase", letterSpacing:0.8, padding:"10px 12px", borderBottom:"1px solid var(--border)", textAlign:align, fontWeight:600, background:"var(--bg-2)", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{h}</th>;
                    })}
                  </tr>
                </thead>
                <tbody>
                  {enrichedOrdersComEnvio.length === 0 ? (
                    <tr><td colSpan={13} style={{ textAlign:"center", color:"var(--text-3)", padding:40 }}>Nenhum pedido encontrado</td></tr>
                  ) : enrichedOrdersComEnvio.slice((paginaPedidos-1)*POR_PAG_PEDIDOS, paginaPedidos*POR_PAG_PEDIDOS).map(function(o) {
                    var youReceive = o.price - o.fee - o.freteSeller;
                    var sInfo = getOrderStatusInfo(o.status, o.tags, o.fulfilled, o.shipment_status);
                    var envLabel = detectTipoEnvio(o, shipmentStatuses) || "";
                    return (
                      <tr key={o.id} style={{ borderBottom:"1px solid var(--border-soft)" }}>
                        <td style={{ padding:"6px 9px", fontSize:11, color:"var(--text-2)", fontFamily:"monospace", fontWeight:600, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>#{o.id}</td>
                        <td style={{ padding:"10px 12px" }}>
                          <span style={{ fontSize:11, fontWeight:600, color:sInfo.color, background:sInfo.bg, padding:"3px 8px", borderRadius:6, whiteSpace:"nowrap" }}>{sInfo.label}</span>
                        </td>
                        <td style={{ padding:"10px 12px" }}>
                          {envLabel ? <BadgeTipoEnvio tipo={envLabel} /> : <span style={{ color:"var(--text-3)", fontSize:11 }}>—</span>}
                        </td>
                        <td style={{ padding:"10px 12px", overflow:"hidden" }}>
                          {o.buyerName ? (
                            <div style={{ position:"relative" }}>
                              <button onClick={function(){ setShowClienteDetalhe(showClienteDetalhe===o.id ? null : o.id); }}
                                style={{ background:"none", border:"none", color:"#0e7490", cursor:"pointer", fontSize:11, fontWeight:600, padding:0, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", maxWidth:"100%", display:"block" }}>
                                {o.buyerName}
                              </button>
                              {showClienteDetalhe === o.id && (
                                <div style={{ position:"fixed", zIndex:900, background:"var(--surface)", border:"1px solid var(--border)", borderRadius:12, padding:"16px 18px", boxShadow:"0 8px 32px rgba(0,0,0,.15)", minWidth:260, marginTop:4 }}>
                                  <div style={{ fontWeight:700, fontSize:14, color:"var(--text-strong)", marginBottom:10, display:"flex", justifyContent:"space-between" }}>
                                    👤 {o.buyerName}
                                    <button onClick={function(){ setShowClienteDetalhe(null); }} style={{ background:"none", border:"none", cursor:"pointer", color:"var(--text-3)", fontSize:14 }}>✕</button>
                                  </div>
                                  {o.buyerDoc && <div style={{ fontSize:12, color:"var(--text-2)", marginBottom:4 }}>{o.buyerDocType||"Doc"}: {o.buyerDoc}</div>}
                                  {o.buyerEmail && <div style={{ fontSize:12, color:"var(--text-2)", marginBottom:4 }}>✉️ {o.buyerEmail}</div>}
                                  {o.buyerPhone && <div style={{ fontSize:12, color:"var(--text-2)", marginBottom:4 }}>📞 {o.buyerPhone}</div>}
                                  {o.buyerCity && <div style={{ fontSize:12, color:"var(--text-2)", marginBottom:4 }}>📍 {o.buyerCity}{o.buyerUF ? " - "+o.buyerUF : ""}{o.buyerZip ? " ("+o.buyerZip+")" : ""}</div>}
                                  {o.sku && <div style={{ fontSize:12, color:"var(--text-2)" }}>SKU: {o.sku}</div>}
                                </div>
                              )}
                            </div>
                          ) : <span style={{ color:"var(--text-3)", fontSize:11 }}>—</span>}
                        </td>
                        <td style={{ padding:"10px 12px", overflow:"hidden" }}>
                          <div style={{ overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                            {(function(){
                              var title = o.title ?? o.listing?.title;
                              // Montar link do ML: listing_id existe no rawOrder
                              var listingId = o.listing_id;
                              // Buscar permalink real nos listings carregados
                              var listingObj = listings && listingId ? listings.find(function(l){ return l.id === listingId; }) : null;
                              var link = null;
                              if (listingObj && listingObj.permalink) {
                                link = listingObj.permalink;
                              } else if (listingId) {
                                // Montar URL direta do anúncio no ML
                                link = "https://www.mercadolivre.com.br/anuncio/" + listingId;
                              } else if (o.permalink) {
                                link = o.permalink;
                              }
                              if (!title) return <span style={{ color:"var(--text-3)", fontSize:12 }}>—</span>;
                              return link
                                ? <a href={link} target="_blank" rel="noreferrer" className="title-link" style={{ fontSize:12 }}>{title}</a>
                                : <span style={{ fontSize:12 }}>{title}</span>;
                            })()}
                          </div>
                        </td>
                        <td style={{ padding:"7px 10px", fontSize:11, color:"var(--text-2)", whiteSpace:"nowrap" }}>{fmtDate(o.date)}</td>
                        <td style={{ padding:"7px 10px", fontSize:12, fontWeight:700, color:"var(--text-strong)", textAlign:"right", whiteSpace:"nowrap" }}>{fmt(o.price)}</td>
                        <td style={{ padding:"7px 10px", fontSize:11, color:"var(--text-2)", textAlign:"center" }}>×{o.qty}</td>
                        <td style={{ padding:"10px 12px", textAlign:"right", whiteSpace:"nowrap" }}><span style={{ color:"#FFC107", fontWeight:600, fontSize:12 }}>{fmt(o.fee)}</span></td>
                        <td style={{ padding:"10px 12px", textAlign:"right", whiteSpace:"nowrap" }}><span style={{ color:"#7c3aed", fontWeight:600, fontSize:12 }}>{o.freteSeller > 0 ? fmt(o.freteSeller) : "—"}</span></td>
                        <td style={{ padding:"10px 12px", textAlign:"right", whiteSpace:"nowrap" }}><span style={{ color:"#0a9d4e", fontWeight:700, fontSize:12 }}>{fmt(youReceive)}</span></td>
                        <td style={{ padding:"10px 12px", textAlign:"right", whiteSpace:"nowrap", fontSize:12, color:o.profit>=0?"#0a9d4e":"#FF5252", fontWeight:700 }}>{o.cost > 0 ? fmt(o.profit) : "—"}</td>
                        <td style={{ padding:"10px 12px" }}><MarginBar value={o.margin} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <Paginacao
                total={enrichedOrdersComEnvio.length}
                porPagina={POR_PAG_PEDIDOS}
                paginaAtual={paginaPedidos}
                onMudar={function(p){ setPaginaPedidos(p); window.scrollTo({top:0,behavior:"smooth"}); }}
              />
              </div>
            </LayoutFiltros>
            )} {/* fecha condicional ml pedidos */}
          </>
        )}
      </main>

        {tab === "precificacao" && currentUser?.permissoes?.includes("listings") && (
          <PrecificacaoTab
            enriched={enriched}
            costs={costs}
            setCostsAndSave={setCostsAndSave}
            fretesConfig={fretesConfig}
            setFretesAndSave={setFretesAndSave}
            descontosConfig={descontosConfig}
            setDescontosAndSave={setDescontosAndSave}
            precosVendaConfig={precosVendaConfig}
            setPrecosVendaAndSave={setPrecosVendaAndSave}
            pendentesAtualizacao={pendentesAtualizacao}
            setPendentesAndSave={setPendentesAndSave}
            setSkuOverridesAndSave={setSkuOverridesAndSave}
            rawOrders={rawOrders}
          />
        )}



        {tab === "concorrencia" && currentUser?.permissoes?.includes("listings") && (
          <ConcorrenciaTab enriched={enriched} token={token} sellerId={user?.id} />
        )}
        {tab === "admin" && currentUser?.permissoes?.includes("admin") && (
          <AdminTab currentUser={currentUser} />
        )}
        {tab === "dashboard" && (
          <DashboardTab enrichedOrders={enrichedOrders} />
        )}
        {tab === "produtos" && <ProdutosTab produtos={produtos} />}
        {tab === "estoque" && <EstoqueTab produtos={produtos} />}
        {tab === "vincular" && <VincularTab enriched={enriched} produtos={produtos} />}
        {tab === "relatorios" && <RelatoriosTab enrichedOrders={enrichedOrders} />}
        {tab === "expedicao" && <EmConstrucao tab="expedicao" />}
        {tab === "notas_fiscais" && <EmConstrucao tab="notas_fiscais" />}
        {tab === "contas_receber" && <ContasReceberTab enrichedOrders={enrichedOrders} paymentData={paymentData} />}
        {tab === "clientes" && <ClientesTab rawOrders={rawOrders} />}
        {tab === "integracoes" && <IntegracoesTab token={token} user={user} lastUpdate={lastUpdate} />}
        {tab === "dre" && <DreTab />}
        {TELAS_FIN[tab] && <TelaEstruturada cfg={TELAS_FIN[tab]} />}
      </div>{/* fecha a coluna do conteúdo */}

      {showBackup && <PainelBackup onClose={() => setShowBackup(false)} />}

      {showMLModal && <MLConnectModal onConnect={handleConnect} onClose={() => setShowMLModal(false)} />}
      {showConfigPanel && (
        <PainelConfiguracoesGlobal
          currentUser={currentUser}
          abaInicial={configPanelTab}
          impostos={impostos} setImpostos={setImpostos}
          custosFixos={custosFixos} setCustosFixos={setCustosFixos}
          irpjCsllConfig={irpjCsllConfig} setIrpjCsllConfig={setIrpjCsllConfig}
          faturamentoMes={enrichedOrders.filter(o=>o.date?.startsWith(new Date().toLocaleDateString("sv-SE").slice(0,7))).reduce((s,o)=>s+o.revenue*o.qty,0)}
          darkMode={darkMode} setDarkMode={setDarkMode}
          onClose={function(){ setShowConfigPanel(false); }}
        />
      )}
      {selectedListing && <AIPanel listing={selectedListing} onClose={() => setSelectedListing(null)} />}
      {currentUser && <ChatInternoWidget currentUser={currentUser} />}
    </div>
  );
}
