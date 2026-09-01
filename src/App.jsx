import React, { useState, useMemo, useEffect, useRef, Children, cloneElement } from "react";
import {
  ResponsiveContainer, LineChart, Line, AreaChart, Area,
  PieChart, Pie, Cell, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip as RTooltip, Legend, ReferenceLine,
} from "recharts";
import { BR_VIEWBOX, BR_ESTADOS } from "./brazilMap.js";

const ML = (path) => `/api/ml${path}`;
// Separador de milhar importa numa tela de dinheiro: "R$ 10100,00" e
// "R$ 101000,00" se confundem de relance, "R$ 10.100,00" não. Só exibição —
// nada lê de volta o texto que sai daqui (CSV e cálculos usam o número cru).
const fmt = (n) => "R$ " + (Number(n) || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
  if (type === "gold_premium" || type === "gold_pro") return { label: "Premium · 17%", color: "#768592" };
  if (type === "gold_special" || type === "gold_extra") return { label: "Clássico · 12%", color: "#768692" };
  if (type === "silver") return { label: "Gratuito", color: "var(--text-3)" };
  if (type === "free") return { label: "Gratuito", color: "var(--text-3)" };
  return { label: type ? "Clássico" : "—", color: "#768692" };
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
//                    impostoPct: alíquota efetiva de impostos sobre a venda, em %,
//                    custosFixosUnit: custos por unidade além do produto (etiqueta,
//                    embalagem) — separados do custo do produto de propósito, para a
//                    tela poder mostrar cada um em vez de um total sem explicação }
function calcMargin(salePrice, cost, feeRate = 0.12, freteSeller = 0, opts = {}) {
  const feeFixa = parseFloat(opts.feeFixa) || 0;
  const impostoPct = parseFloat(opts.impostoPct) || 0;
  const custosFixos = parseFloat(opts.custosFixosUnit) || 0;
  const mlFee = salePrice * feeRate + feeFixa;
  const imposto = salePrice * (impostoPct / 100);
  const revenue = salePrice - mlFee - freteSeller;
  const profit = revenue - imposto - cost - custosFixos;
  const margin = cost > 0 ? profit / salePrice : null;
  return { fee: mlFee, feeFixa, imposto, custosFixos, revenue, profit, margin, feeRate };
}

// ── Regras da análise de anúncios ──────────────────────────────────────────
// Duas coisas diferentes, guardadas juntas porque o usuário as pensa juntas:
//  1. CRITÉRIOS — o que dá para conferir sozinho, olhando os dados do anúncio.
//     Viram a nota de 0 a 100, sem gastar nada com IA.
//  2. INSTRUÇÕES — o que só a IA consegue julgar (tom, o que a descrição precisa
//     conter, o que nunca prometer). Vão junto no pedido ao modelo.
// Ficam separados de propósito: misturar os dois faria a nota depender de uma
// chamada paga e de uma resposta que muda a cada vez.
const CRITERIOS_QUALIDADE = [
  { key:"title_length",  tipo:"titulo_min",     valor:60,  peso:15, ativo:true,  rotulo:function(v){ return "Título com " + v + "+ caracteres"; } },
  { key:"photos_count",  tipo:"fotos_min",      valor:6,   peso:20, ativo:true,  rotulo:function(v){ return v + "+ fotos"; } },
  { key:"description",   tipo:"descricao_min",  valor:100, peso:20, ativo:true,  rotulo:function(v){ return "Descrição com " + v + "+ caracteres"; } },
  { key:"free_shipping", tipo:"frete_gratis",   valor:null,peso:15, ativo:true,  rotulo:function(){ return "Frete grátis ao comprador"; } },
  { key:"attributes",    tipo:"atributos_min",  valor:4,   peso:20, ativo:true,  rotulo:function(v){ return v + "+ atributos preenchidos"; } },
  { key:"condition",     tipo:"condicao",       valor:null,peso:10, ativo:true,  rotulo:function(){ return "Condição informada"; } },
  // Desligados por padrão: ligá-los muda a nota de todos os anúncios de uma vez,
  // e isso tem de ser uma decisão de quem usa, não um efeito colateral da atualização.
  { key:"video",         tipo:"video",          valor:null,peso:10, ativo:false, rotulo:function(){ return "Anúncio com vídeo"; } },
  { key:"garantia",      tipo:"garantia",       valor:null,peso:10, ativo:false, rotulo:function(){ return "Garantia informada"; } },
  { key:"full",          tipo:"envio_full",     valor:null,peso:10, ativo:false, rotulo:function(){ return "Envio pelo Full"; } },
];

function configQualidadePadrao() {
  return {
    instrucoes: "",
    criterios: CRITERIOS_QUALIDADE.map(function(c){
      return { key:c.key, valor:c.valor, peso:c.peso, ativo:c.ativo };
    }),
  };
}

// Cópia em memória da configuração. calcQualityScore roda para centenas de anúncios
// a cada render; reler e reinterpretar o localStorage a cada chamada custaria caro.
// Quem grava a configuração chama aplicarConfigQualidade e mantém as duas em dia.
let _configQualidade = configQualidadePadrao();
function aplicarConfigQualidade(cfg) {
  var base = configQualidadePadrao();
  if (!cfg || typeof cfg !== "object") { _configQualidade = base; return base; }
  var porChave = {};
  (Array.isArray(cfg.criterios) ? cfg.criterios : []).forEach(function(c){ if (c && c.key) porChave[c.key] = c; });
  _configQualidade = {
    instrucoes: typeof cfg.instrucoes === "string" ? cfg.instrucoes : "",
    // Percorre a lista PADRÃO, não a salva: um critério novo lançado numa
    // atualização precisa aparecer para quem já tinha configuração gravada.
    criterios: base.criterios.map(function(pad){
      var salvo = porChave[pad.key];
      if (!salvo) return pad;
      return {
        key: pad.key,
        valor: salvo.valor == null ? pad.valor : (parseInt(salvo.valor, 10) || pad.valor),
        peso: salvo.peso == null ? pad.peso : Math.max(0, parseInt(salvo.peso, 10) || 0),
        ativo: salvo.ativo !== false,
      };
    }),
  };
  return _configQualidade;
}
function lerConfigQualidade() { return _configQualidade; }

// Cada critério sabe olhar o anúncio por conta própria. Um tipo desconhecido
// devolve null e o critério é ignorado, em vez de contar como reprovado — não
// saber conferir não é o mesmo que estar errado.
function avaliarCriterio(tipo, valor, l) {
  var atrs = l.attributes || [];
  if (tipo === "titulo_min")    return (l.title || "").length >= valor;
  if (tipo === "fotos_min")     return (l.pictures || []).length >= valor;
  if (tipo === "descricao_min") return ((l.description && l.description.plain_text) || "").length >= valor;
  if (tipo === "atributos_min") return atrs.length >= valor;
  if (tipo === "frete_gratis")  return !!(l.shipping && l.shipping.free_shipping);
  if (tipo === "condicao")      return !!l.condition;
  if (tipo === "video")         return !!(l.video_id || l.videos || l.video);
  if (tipo === "garantia")      return atrs.some(function(a){ return /warranty|garantia/i.test(String(a.id || a.name || "")) && a.value_name; });
  if (tipo === "envio_full")    return /fulfillment/i.test(String((l.shipping && l.shipping.logistic_type) || l.logistic_type || ""));
  return null;
}

function calcQualityScore(listing) {
  var cfg = lerConfigQualidade();
  var porChave = {};
  cfg.criterios.forEach(function(c){ porChave[c.key] = c; });
  var checks = [];
  CRITERIOS_QUALIDADE.forEach(function(def){
    var c = porChave[def.key] || def;
    if (!c.ativo) return;
    var passou = avaliarCriterio(def.tipo, c.valor, listing || {});
    if (passou === null) return;
    checks.push({ key: def.key, label: def.rotulo(c.valor), pass: passou, weight: c.peso });
  });
  const total = checks.reduce((s, c) => s + (c.pass ? c.weight : 0), 0);
  const max = checks.reduce((s, c) => s + c.weight, 0);
  // Sem critério ativo não existe nota. Devolver 0 diria "seus anúncios são
  // péssimos" quando a verdade é "não há nada configurado para medir".
  return { score: max > 0 ? Math.round((total / max) * 100) : null, checks };
}

// Tela onde o vendedor define o que a análise cobra dos anúncios.
function AnaliseIATab({ config, salvar, enriched }) {
  const [rascunho, setRascunho] = useState(function(){ return JSON.parse(JSON.stringify(config)); });
  const [salvo, setSalvo] = useState(false);
  var porChave = {}; rascunho.criterios.forEach(function(c){ porChave[c.key] = c; });
  function mudar(key, campo, valor){
    setSalvo(false);
    setRascunho(function(r){
      return Object.assign({}, r, { criterios: r.criterios.map(function(c){
        return c.key === key ? Object.assign({}, c, { [campo]: valor }) : c;
      }) });
    });
  }
  function aplicar(){ salvar(rascunho); setSalvo(true); }
  function restaurar(){
    if (!window.confirm("Voltar todos os critérios e instruções ao padrão?")) return;
    var pad = configQualidadePadrao(); setRascunho(pad); salvar(pad); setSalvo(true);
  }
  var alterado = JSON.stringify(rascunho) !== JSON.stringify(config);
  var ativos = rascunho.criterios.filter(function(c){ return c.ativo; });
  var somaPesos = ativos.reduce(function(a,c){ return a + (parseInt(c.peso,10)||0); }, 0);

  // Prévia sobre os anúncios reais: mostra o efeito da mudança antes de salvar,
  // em vez de exigir salvar para depois descobrir que a nota despencou.
  var previa = null;
  if ((enriched || []).length) {
    var antes = configQualidadePadrao();
    var salvoAtual = lerConfigQualidade();
    aplicarConfigQualidade(rascunho);
    var notas = (enriched || []).map(function(l){ return calcQualityScore(l).score; }).filter(function(n){ return n != null; });
    aplicarConfigQualidade(salvoAtual);
    if (notas.length) {
      previa = {
        media: Math.round(notas.reduce(function(a,b){ return a+b; },0) / notas.length),
        bons: notas.filter(function(n){ return n >= 80; }).length,
        fracos: notas.filter(function(n){ return n < 50; }).length,
        total: notas.length,
      };
    }
  }

  var cartao = { background:"var(--surface)", border:"1px solid var(--border)", borderRadius:12, padding:"18px 20px", marginBottom:14 };
  var tit = { fontSize:14, fontWeight:600, color:"var(--text-strong)", marginBottom:4 };
  var sub = { fontSize:12, color:"var(--text-3)", lineHeight:1.5, marginBottom:14 };
  var num = { width:78, background:"var(--bg)", border:"1px solid var(--border)", color:"var(--text-strong)", padding:"6px 9px", borderRadius:7, fontSize:13 };

  return (
    <div style={{ padding:2, width:"100%" }}>
      <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom:14, flexWrap:"wrap" }}>
        <div style={{ fontWeight:600, fontSize:20, color:"var(--text-strong)" }}>Análise de anúncios</div>
        <div style={{ flex:1 }} />
        <button onClick={restaurar} style={{ background:"var(--surface)", border:"1px solid var(--border)", color:"var(--text-2)", padding:"9px 16px", borderRadius:9, cursor:"pointer", fontSize:13 }}>Restaurar padrão</button>
        <button onClick={aplicar} disabled={!alterado}
          style={{ background: alterado ? "var(--ui-accent)" : "var(--surface)", border: alterado ? "none" : "1px solid var(--border)",
                   color: alterado ? "var(--ui-accent-text)" : "var(--text-4)", fontWeight:600, padding:"9px 26px", borderRadius:9,
                   cursor: alterado ? "pointer" : "default", fontSize:13 }}>Salvar</button>
      </div>
      {salvo && !alterado && <div style={{ background:"rgba(10,157,78,.12)", border:"1px solid #0a9d4e", color:"#0a9d4e", borderRadius:10, padding:"10px 14px", fontSize:12.5, marginBottom:14 }}>Regras salvas. As notas da aba Anúncios já usam os novos critérios.</div>}

      <div style={cartao}>
        <div style={tit}>Critérios da nota (0 a 100)</div>
        <div style={sub}>
          Conferidos aqui mesmo, a partir dos dados do anúncio — não gastam nada de IA e valem
          para todos os anúncios de uma vez. O peso é relativo: a nota é quanto o anúncio somou
          dividido pela soma dos pesos ativos.
        </div>
        <div className="tabela-wrap">
          <table className="tabela">
            <thead><tr>{["Ativo","Critério","Exigência","Peso"].map(function(h){ return <th key={h} className="th">{h}</th>; })}</tr></thead>
            <tbody>
              {CRITERIOS_QUALIDADE.map(function(def){
                var c = porChave[def.key];
                var temValor = def.valor != null;
                return <tr key={def.key} style={{ opacity: c.ativo ? 1 : .5 }}>
                  <td className="td" style={{ width:52 }}>
                    <input type="checkbox" checked={!!c.ativo} onChange={function(e){ mudar(def.key, "ativo", e.target.checked); }} />
                  </td>
                  <td className="td" style={{ color:"var(--text-strong)" }}>{def.rotulo(c.valor)}</td>
                  <td className="td">
                    {temValor
                      ? <input type="number" min="1" value={c.valor} disabled={!c.ativo}
                          onChange={function(e){ mudar(def.key, "valor", Math.max(1, parseInt(e.target.value,10) || 1)); }} style={num} />
                      : <span style={{ color:"var(--text-4)" }}>sim/não</span>}
                  </td>
                  <td className="td">
                    <input type="number" min="0" value={c.peso} disabled={!c.ativo}
                      onChange={function(e){ mudar(def.key, "peso", Math.max(0, parseInt(e.target.value,10) || 0)); }} style={num} />
                  </td>
                </tr>;
              })}
            </tbody>
          </table>
        </div>
        <div style={{ fontSize:12, color: somaPesos > 0 ? "var(--text-3)" : "#FF5252", marginTop:10 }}>
          {somaPesos > 0
            ? ativos.length + " critério(s) ativo(s), somando " + somaPesos + " pontos."
            : "Nenhum critério ativo — sem isso não existe nota, e a aba Anúncios mostra “—” no lugar dela."}
        </div>
        {previa && <div style={{ display:"flex", gap:22, flexWrap:"wrap", marginTop:14, paddingTop:12, borderTop:"1px solid var(--border-soft)" }}>
          <div><div style={{ fontSize:11, color:"var(--text-3)" }}>Nota média com estas regras</div>
            <div style={{ fontSize:20, fontWeight:600, color:scoreColor(previa.media) }}>{previa.media}</div></div>
          <div><div style={{ fontSize:11, color:"var(--text-3)" }}>Anúncios acima de 80</div>
            <div style={{ fontSize:20, fontWeight:600, color:"#0a9d4e" }}>{previa.bons}</div></div>
          <div><div style={{ fontSize:11, color:"var(--text-3)" }}>Anúncios abaixo de 50</div>
            <div style={{ fontSize:20, fontWeight:600, color:"#FF5252" }}>{previa.fracos}</div></div>
          <div><div style={{ fontSize:11, color:"var(--text-3)" }}>Anúncios avaliados</div>
            <div style={{ fontSize:20, fontWeight:600, color:"var(--text-2)" }}>{previa.total}</div></div>
        </div>}
        {previa && alterado && <div style={{ fontSize:11.5, color:"var(--text-3)", marginTop:8 }}>Prévia sobre os seus anúncios de verdade, ainda não salva.</div>}
      </div>

      <div style={cartao}>
        <div style={tit}>Regras para a IA</div>
        <div style={sub}>
          Escreva aqui o que a IA precisa saber do seu negócio e o que deve checar além dos
          critérios acima — coisas que só um texto consegue dizer. Este bloco vai junto em
          <b> toda</b> análise, e a IA é instruída a seguir estas regras antes de qualquer
          recomendação genérica.
        </div>
        <textarea
          value={rascunho.instrucoes}
          onChange={function(e){ setSalvo(false); setRascunho(Object.assign({}, rascunho, { instrucoes: e.target.value })); }}
          rows={12}
          placeholder={"Exemplos do que escrever aqui:\n\n" +
            "- Vendemos autopeças para caminhonetes. O título deve sempre trazer a peça, a marca do veículo, o modelo e os anos de compatibilidade.\n" +
            "- Toda descrição precisa terminar com o prazo de garantia e o que está incluso na caixa.\n" +
            "- Nunca prometa entrega em prazo específico nem use “original de fábrica” se a peça for paralela.\n" +
            "- Avise se o título passar de 60 caracteres, porque o Mercado Livre corta.\n" +
            "- Verifique se a compatibilidade de anos está no título e nos atributos."}
          style={{ width:"100%", background:"var(--bg)", border:"1px solid var(--border)", color:"var(--text-strong)",
                   padding:"12px 14px", borderRadius:10, fontSize:13, outline:"none", resize:"vertical",
                   fontFamily:"inherit", lineHeight:1.6, boxSizing:"border-box" }} />
        <div style={{ fontSize:11.5, color:"var(--text-3)", marginTop:8 }}>
          {String(rascunho.instrucoes||"").length} caracteres. Texto longo encarece um pouco cada
          análise, porque vai no pedido todas as vezes — mas o efeito é pequeno perto do resto do anúncio.
        </div>
      </div>

      <div style={{ ...cartao, marginBottom:0 }}>
        <div style={tit}>Como as duas coisas se encaixam</div>
        <div style={{ ...sub, marginBottom:0 }}>
          A <b>nota</b> sai só dos critérios acima e aparece em toda a aba Anúncios, de graça e
          na hora. A <b>IA</b> entra apenas quando você clica em <b>Analisar</b> num anúncio: ela
          recebe o anúncio, os critérios ativos com o resultado de cada um, e as suas regras — e
          devolve título, descrição e atributos já prontos para colar. Mudar os critérios aqui
          muda as duas coisas ao mesmo tempo.
        </div>
      </div>
    </div>
  );
}

function scoreColor(s) { if (s == null) return "var(--text-4)"; return s >= 80 ? "#0a9d4e" : s >= 50 ? "#FFC107" : "#FF5252"; }
function scoreBg(s) { if (s == null) return "var(--surface-3)"; return s >= 80 ? "rgba(0,200,83,.12)" : s >= 50 ? "rgba(255,193,7,.12)" : "rgba(255,82,82,.12)"; }
function scoreLabel(s) { if (s == null) return "Sem critérios"; return s >= 80 ? "Ótimo" : s >= 50 ? "Regular" : "Fraco"; }

async function analyzeWithAI(listing) {
  var cfg = lerConfigQualidade();
  var ativos = calcQualityScore(listing).checks;
  // O modelo recebe os MESMOS critérios que geraram a nota. Sem isso ele sugeriria
  // melhorias que a nota não cobra, e cobraria coisas que a nota não mede.
  var blocoCriterios = ativos.length
    ? "\n\nCritérios de qualidade usados por este vendedor (peso entre parênteses) e como este anúncio está em cada um:\n" +
      ativos.map(function(c){ return "- " + c.label + " (peso " + c.weight + "): " + (c.pass ? "OK" : "NÃO ATENDE"); }).join("\n")
    : "";
  var blocoInstrucoes = String(cfg.instrucoes || "").trim()
    ? "\n\nREGRAS DO VENDEDOR — siga-as acima de qualquer recomendação genérica:\n" + String(cfg.instrucoes).trim()
    : "";
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
- Vendidos: ${listing.sold_quantity ?? 0}${blocoCriterios}${blocoInstrucoes}

Retorne SOMENTE o JSON, começando com { e terminando com }.`;

  // A chamada ao modelo passa pelo proxy /api/ai-chat — a chave da API fica só no
  // servidor, e é lá que se escolhe o motor (ChatGPT).
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
  fluxo_caixa:["📈","Fluxo de caixa","Saldo projetado dia a dia e o dia em que ele acaba."],
  bancos:["🏦","Caixas e bancos","Onde o dinheiro está, com saldo calculado."],
  lancamentos:["📒","Lançamentos","Extrato de tudo o que entrou e saiu."],
  prioridade_pagamento:["🎯","Prioridade de pagamento","Que contas pagar primeiro, com o caixa que você tem."],
  contas_receber:["⬆️","Contas a receber","Recebíveis criados a partir do repasse dos marketplaces."],
  clientes:["👥","Clientes","Cadastro de clientes e histórico."],
  fornecedores:["🏭","Fornecedores","Cadastro de fornecedores e condições."],
  notas_fiscais:["📄","Notas fiscais","Emissão e gestão de NF-e a partir das vendas."],
  dre:["⚖️","DRE e conciliação","Demonstrativo de resultado e conciliação financeira."],
  relatorios:["📈","Relatórios","Relatórios e análises do negócio."],
  integracoes:["🔌","Integrações","Conexões com marketplaces e outros sistemas."],
};
function EmConstrucao({ tab }) {
  var info = ABA_INFO[tab] || ["🚧", tab, ""];
  return (
    <div style={{ display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", minHeight:"62vh", textAlign:"center", padding:24 }}>
      <div style={{ fontSize:60, marginBottom:16, opacity:.9 }}>{info[0]}</div>
      <div style={{ fontSize:24, fontWeight:600, color:"var(--text-strong)", marginBottom:8, letterSpacing:-0.4 }}>{info[1]}</div>
      <div style={{ fontSize:14, color:"var(--text-3)", maxWidth:440, lineHeight:1.6 }}>{info[2]}</div>
      <div style={{ marginTop:18, fontSize:12, fontWeight:500, color:"#FFC107", background:"rgba(255,193,7,.12)", border:"1px solid rgba(255,193,7,.35)", borderRadius:20, padding:"5px 14px" }}>🚧 Em construção</div>
    </div>
  );
}

// Estilos compartilhados das telas de tabela (Produtos, Estoque).
// Os estilos de tabela, KPI, botão e campo saíram daqui para src/estilos.css,
// como classes. Use className="td", "kpi", "btn-pri"... e deixe em style={{ }}
// só o ajuste daquela instância.
function nomeProd(p){ return p.titulo || p.nome || "—"; }
function qtdAnuncios(p){ return (p.mlbsVinculados || []).length || (p.mlbVinculado ? 1 : 0); }

// Campos do cadastro de produto. Ficam FORA do componente de propósito: definidos
// dentro dele, o React os trataria como um tipo novo a cada tecla digitada,
// remontaria o input e o campo perderia o foco a cada caractere.
function PC(props){
  return <div>
    <label className="rotulo">{props.label}</label>
    {props.children}
    {props.dica && <div style={{ fontSize:10.5, color:"var(--text-4)", marginTop:3 }}>{props.dica}</div>}
  </div>;
}
function PTxt(props){
  var v = props.f[props.k];
  return <PC label={props.label} dica={props.dica}>
    <input value={v == null ? "" : v} onChange={function(e){ props.set(props.k, e.target.value); }}
      type={props.tipo || "text"} step={props.tipo === "number" ? (props.step || "0.01") : undefined}
      placeholder={props.ph || ""} list={props.list} className="campo" />
  </PC>;
}
function PSel(props){
  var v = props.f[props.k];
  return <PC label={props.label} dica={props.dica}>
    <select value={v == null ? "" : v} onChange={function(e){ props.set(props.k, e.target.value); }} className="campo">
      {props.opcoes.map(function(o){
        var val = Array.isArray(o) ? o[0] : o, txt = Array.isArray(o) ? o[1] : o;
        return <option key={val} value={val}>{txt}</option>;
      })}
    </select>
  </PC>;
}

// ── Cadastro de produto em página inteira ───────────────────────────────────
// Substituiu o modal de 8 campos: um cadastro de produto de verdade tem mais
// informação do que cabe numa caixinha, e boa parte dela (peso, NCM, dimensões)
// só serve quando está toda junta. As abas separam por assunto para a tela não
// virar um formulário de 50 campos empilhados.
const _abasProduto = [
  { key:"geral",     label:"Dados gerais" },
  { key:"precos",    label:"Preços" },
  { key:"estoque",   label:"Estoque" },
  { key:"dimensoes", label:"Dimensões e peso" },
  { key:"fiscal",    label:"Fiscal" },
  { key:"fornec",    label:"Fornecedor" },
  { key:"anuncios",  label:"Anúncios" },
  { key:"imagens",   label:"Imagens" },
  { key:"obs",       label:"Observações" },
];

// Campos que a sincronização do Mercado Livre reescreve a cada "Atualizar".
// Editar um deles à mão num produto vindo do ML só vale até a próxima sincronização
// — dizer isso na tela é mais honesto do que deixar a edição sumir sem aviso.
const _camposSobrescritosPeloML = ["Descrição", "Preço de venda", "Estoque atual", "Situação", "Código (SKU)", "Imagens"];

function ProdutoPagina({ produto, produtos, fornecedores, enriched, onSave, onClose, onExcluir }) {
  const base = {
    nome:"", sku:"", codigo:"", gtin:"", marca:"", categoria:"", tipo:"simples", unidade:"UN",
    status:"Ativo", descricaoCurta:"", tags:"",
    precoCusto:"", precoVenda:"", precoPromocional:"",
    controlarEstoque:true, estoqueAtual:"", estoqueMinimo:"", estoqueMaximo:"", localizacao:"", deposito:"",
    pesoLiquido:"", pesoBruto:"", largura:"", altura:"", profundidade:"", volumes:"", tipoEmbalagem:"",
    ncm:"", cest:"", origem:"0", cfop:"", icmsPct:"", ipiPct:"", pisPct:"", cofinsPct:"", tipoItem:"Mercadoria para revenda",
    fornecedor:"", codigoFornecedor:"", prazoEntrega:"", custoCompra:"", ultimaCompra:"", obsCompra:"",
    imagens:[], obs:"", descricaoComplementar:"",
  };
  const [f, setF] = useState(function(){ return Object.assign({}, base, produto || {}); });
  const [aba, setAba] = useState("geral");
  const [novaImagem, setNovaImagem] = useState("");
  const [erro, setErro] = useState("");
  function set(k, v){ setF(function(s){ return Object.assign({}, s, { [k]: v }); }); }
  var novo = !produto || !produto.id;

  // Estado inicial guardado para saber se há edição pendente. Um formulário desta
  // altura fecha com um Esc distraído; perder tudo em silêncio seria pior que perguntar.
  const inicial = useRef(JSON.stringify(Object.assign({}, base, produto || {})));
  function fechar(){
    if (JSON.stringify(f) !== inicial.current &&
        !window.confirm("Há alterações não salvas neste produto. Sair mesmo assim?")) return;
    onClose();
  }
  useEffect(function(){
    function aoTeclar(e){ if (e.key === "Escape") fechar(); }
    window.addEventListener("keydown", aoTeclar);
    return function(){ window.removeEventListener("keydown", aoTeclar); };
  });

  function salvar(){
    var p = Object.assign({}, f);
    var nome = String(p.nome || p.titulo || "").trim();
    if (!nome) { setErro("Informe a descrição do produto — é o único campo obrigatório."); setAba("geral"); return; }
    // SKU repetido quebra o vínculo com os anúncios (a ligação é feita pelo SKU),
    // então é melhor barrar aqui do que descobrir depois na tela de Vincular.
    var sku = String(p.sku || "").trim().toLowerCase();
    if (sku) {
      var conflito = (produtos || []).find(function(x){
        return x.id !== p.id && String(x.sku || "").trim().toLowerCase() === sku;
      });
      if (conflito) { setErro('O SKU "' + p.sku + '" já é usado por "' + nomeProd(conflito) + '". Cada produto precisa de um SKU próprio.'); setAba("geral"); return; }
    }
    if (!p.id) p.id = "prod_" + Date.now() + "_" + Math.floor(Math.random()*1000);
    onSave(p);
  }

  // Margem sobre o preço de venda: mesma conta da Precificação, sem taxas nem
  // imposto — aqui é só a diferença entre custo e preço, e a tela diz isso.
  var custoN = parseFloat(f.precoCusto) || 0, vendaN = parseFloat(f.precoVenda) || 0;
  var margemBruta = vendaN > 0 ? ((vendaN - custoN) / vendaN) * 100 : null;
  var markup = custoN > 0 ? ((vendaN - custoN) / custoN) * 100 : null;
  // Peso cubado: o que as transportadoras cobram quando o volume pesa mais que a balança.
  var cubado = (parseFloat(f.largura)||0) * (parseFloat(f.altura)||0) * (parseFloat(f.profundidade)||0) / 6000;

  var mlbs = (f.mlbsVinculados || []).slice();
  if (f.mlbVinculado && mlbs.indexOf(f.mlbVinculado) < 0) mlbs.unshift(f.mlbVinculado);

  var campo = { width:"100%", background:"var(--bg)", border:"1px solid var(--border)", color:"var(--text-strong)", padding:"9px 11px", borderRadius:8, fontSize:13, outline:"none", boxSizing:"border-box" };
  var lbl = { fontSize:11, color:"var(--text-3)", fontWeight:600, letterSpacing:.3, marginBottom:4, display:"block" };
  var grid2 = { display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(230px,1fr))", gap:14 };
  var cartao = { background:"var(--surface)", border:"1px solid var(--border)", borderRadius:12, padding:"18px 20px", marginBottom:14 };
  var tituloSec = { fontSize:13, fontWeight:600, color:"var(--text-strong)", marginBottom:14 };
  var dica = { fontSize:11.5, color:"var(--text-3)", lineHeight:1.5, marginTop:10 };

  return (
    <div style={{ position:"fixed", inset:0, background:"var(--bg)", zIndex:700, display:"flex", flexDirection:"column" }}>
      {/* Cabeçalho fixo: identidade do produto + as duas ações que importam */}
      <div style={{ borderBottom:"1px solid var(--border)", background:"var(--bg-2)", padding:"14px 22px", display:"flex", alignItems:"center", gap:14, flexWrap:"wrap" }}>
        <button onClick={fechar} title="Voltar (Esc)" style={{ background:"var(--surface)", border:"1px solid var(--border)", color:"var(--text-2)", width:34, height:34, borderRadius:9, cursor:"pointer", fontSize:16 }}>←</button>
        <div style={{ minWidth:0 }}>
          <div style={{ fontWeight:600, fontSize:17, color:"var(--text-strong)", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", maxWidth:"52vw" }}>
            {novo ? "Novo produto" : (String(f.nome || f.titulo || "").trim() || "Produto sem descrição")}
          </div>
          <div style={{ fontSize:11.5, color:"var(--text-3)", marginTop:2 }}>
            {f.sku ? "SKU " + f.sku : "sem SKU"}
            {mlbs.length ? " · " + mlbs.length + " anúncio(s) vinculado(s)" : ""}
            {f.syncML ? " · sincronizado com o Mercado Livre" : ""}
          </div>
        </div>
        <div style={{ flex:1 }} />
        {!novo && onExcluir && (
          <button onClick={function(){ onExcluir(f); }} style={{ background:"var(--surface)", border:"1px solid var(--border)", color:"#FF5252", fontWeight:600, padding:"9px 16px", borderRadius:9, cursor:"pointer", fontSize:13 }}>Excluir</button>
        )}
        <button onClick={fechar} style={{ background:"var(--surface)", border:"1px solid var(--border)", color:"var(--text-2)", fontWeight:600, padding:"9px 18px", borderRadius:9, cursor:"pointer", fontSize:13 }}>Cancelar</button>
        <button onClick={salvar} style={{ background:"var(--ui-accent)", border:"none", color:"var(--ui-accent-text)", fontWeight:600, padding:"9px 26px", borderRadius:9, cursor:"pointer", fontSize:13 }}>Salvar</button>
      </div>

      {/* Abas */}
      <div className="scroll-x" style={{ borderBottom:"1px solid var(--border)", background:"var(--bg-2)", padding:"0 22px", display:"flex", gap:2 }}>
        {_abasProduto.map(function(a){
          var ativa = aba === a.key;
          return <button key={a.key} onClick={function(){ setAba(a.key); }}
            style={{ background:"none", border:"none", borderBottom: ativa ? "2px solid var(--ui-accent)" : "2px solid transparent",
                     color: ativa ? "var(--text-strong)" : "var(--text-3)", fontWeight: ativa ? 600 : 500,
                     padding:"11px 14px", cursor:"pointer", fontSize:13, whiteSpace:"nowrap" }}>{a.label}</button>;
        })}
      </div>

      <div style={{ flex:1, overflowY:"auto", padding:"18px 22px 40px" }}>
        <div style={{ maxWidth:960, margin:"0 auto" }}>
          {erro && <div style={{ background:"rgba(255,82,82,.12)", border:"1px solid #FF5252", color:"#FF5252", borderRadius:10, padding:"11px 14px", fontSize:12.5, marginBottom:14 }}>{erro}</div>}

          {f.syncML && (
            <div style={{ background:"rgba(255,193,7,.10)", border:"1px solid rgba(255,193,7,.5)", borderRadius:10, padding:"11px 14px", fontSize:12, color:"var(--text-2)", marginBottom:14, lineHeight:1.5 }}>
              Este produto vem do Mercado Livre. A cada <b>Atualizar</b>, a sincronização reescreve{" "}
              {_camposSobrescritosPeloML.join(", ")} com o que estiver no anúncio — mudanças manuais nesses
              campos não sobrevivem. Os demais (custo, fiscal, dimensões, fornecedor, estoque mínimo) são só seus.
            </div>
          )}

          {aba === "geral" && <>
            <div style={cartao}>
              <div style={tituloSec}>Identificação</div>
              <div style={{ marginBottom:14 }}>
                <label style={lbl}>Descrição *</label>
                <input value={f.nome || f.titulo || ""} onChange={function(e){ set("nome", e.target.value); set("titulo", e.target.value); }} style={campo} placeholder="Nome do produto como aparece no anúncio" />
              </div>
              <div style={grid2}>
                <PTxt f={f} set={set} k="sku" label="Código (SKU)" dica="É por ele que o produto se liga aos anúncios." />
                <PTxt f={f} set={set} k="codigo" label="Código interno" dica="Opcional — usado só nos relatórios." />
                <PTxt f={f} set={set} k="gtin" label="Código de barras (GTIN/EAN)" />
                <PTxt f={f} set={set} k="marca" label="Marca" list="lista-marcas" />
                <PTxt f={f} set={set} k="categoria" label="Categoria" list="lista-categorias" />
                <PSel f={f} set={set} k="tipo" label="Tipo" opcoes={[["simples","Simples"],["kit","Kit / composição"],["variacao","Com variações"],["materia","Matéria-prima"],["servico","Serviço"]]} />
                <PSel f={f} set={set} k="unidade" label="Unidade" opcoes={["UN","PC","CX","KG","G","L","ML","M","M²","PAR","JG"]} />
                <PSel f={f} set={set} k="status" label="Situação" opcoes={["Ativo","Inativo"]} />
              </div>
              <datalist id="lista-marcas">{Array.from(new Set((produtos||[]).map(function(p){ return p.marca; }).filter(Boolean))).map(function(m){ return <option key={m} value={m} />; })}</datalist>
              <datalist id="lista-categorias">{Array.from(new Set((produtos||[]).map(function(p){ return p.categoria; }).filter(Boolean))).map(function(c){ return <option key={c} value={c} />; })}</datalist>
            </div>
            <div style={cartao}>
              <div style={tituloSec}>Descrição curta e etiquetas</div>
              <div style={{ marginBottom:14 }}>
                <label style={lbl}>Descrição curta</label>
                <textarea value={f.descricaoCurta || ""} onChange={function(e){ set("descricaoCurta", e.target.value); }} rows={3} style={{ ...campo, resize:"vertical", fontFamily:"inherit" }} />
              </div>
              <PTxt f={f} set={set} k="tags" label="Etiquetas" ph="promoção, importado, frágil" dica="Separe por vírgula. Servem para filtrar a lista de produtos." />
            </div>
          </>}

          {aba === "precos" && <div style={cartao}>
            <div style={tituloSec}>Preços</div>
            <div style={grid2}>
              <PTxt f={f} set={set} k="precoCusto" label="Preço de custo (R$)" tipo="number" dica="Alimenta a margem das telas de Vendas e Precificação." />
              <PTxt f={f} set={set} k="precoVenda" label="Preço de venda (R$)" tipo="number" />
              <PTxt f={f} set={set} k="precoPromocional" label="Preço promocional (R$)" tipo="number" dica="Referência sua — não altera o preço no Mercado Livre." />
            </div>
            <div style={{ display:"flex", gap:22, flexWrap:"wrap", marginTop:16, paddingTop:14, borderTop:"1px solid var(--border-soft)" }}>
              <div><div style={{ fontSize:11, color:"var(--text-3)" }}>Margem bruta</div>
                <div style={{ fontSize:19, fontWeight:600, color: margemBruta == null ? "var(--text-4)" : (margemBruta >= 0 ? "#0a9d4e" : "#FF5252") }}>
                  {margemBruta == null ? "—" : margemBruta.toFixed(1) + "%"}</div></div>
              <div><div style={{ fontSize:11, color:"var(--text-3)" }}>Markup sobre o custo</div>
                <div style={{ fontSize:19, fontWeight:600, color:"var(--text-2)" }}>{markup == null ? "—" : markup.toFixed(1) + "%"}</div></div>
              <div><div style={{ fontSize:11, color:"var(--text-3)" }}>Lucro por unidade</div>
                <div style={{ fontSize:19, fontWeight:600, color:"var(--text-2)" }}>{vendaN > 0 ? fmt(vendaN - custoN) : "—"}</div></div>
            </div>
            <div style={dica}>Esta margem é só preço menos custo. Ela <b>não</b> desconta comissão do marketplace,
              frete, imposto, etiqueta nem embalagem — a margem real de cada anúncio está na tela de Precificação.</div>
          </div>}

          {aba === "estoque" && <div style={cartao}>
            <div style={tituloSec}>Estoque</div>
            <label style={{ display:"flex", alignItems:"center", gap:8, fontSize:13, color:"var(--text-2)", marginBottom:16, cursor:"pointer" }}>
              <input type="checkbox" checked={f.controlarEstoque !== false} onChange={function(e){ set("controlarEstoque", e.target.checked); }} />
              Controlar estoque deste produto
            </label>
            <div style={grid2}>
              <PTxt f={f} set={set} k="estoqueAtual" label="Estoque atual" tipo="number" step="1" />
              <PTxt f={f} set={set} k="estoqueMinimo" label="Estoque mínimo" tipo="number" step="1" dica="Abaixo disso o produto aparece como reposição na tela de Estoque." />
              <PTxt f={f} set={set} k="estoqueMaximo" label="Estoque máximo" tipo="number" step="1" />
              <PTxt f={f} set={set} k="localizacao" label="Localização física" ph="Corredor 3, prateleira B" />
              <PTxt f={f} set={set} k="deposito" label="Depósito" />
            </div>
          </div>}

          {aba === "dimensoes" && <div style={cartao}>
            <div style={tituloSec}>Dimensões e peso</div>
            <div style={grid2}>
              <PTxt f={f} set={set} k="pesoLiquido" label="Peso líquido (kg)" tipo="number" step="0.001" />
              <PTxt f={f} set={set} k="pesoBruto" label="Peso bruto (kg)" tipo="number" step="0.001" dica="É o peso que o Mercado Livre usa para calcular o frete." />
              <PTxt f={f} set={set} k="largura" label="Largura (cm)" tipo="number" step="0.1" />
              <PTxt f={f} set={set} k="altura" label="Altura (cm)" tipo="number" step="0.1" />
              <PTxt f={f} set={set} k="profundidade" label="Profundidade (cm)" tipo="number" step="0.1" />
              <PTxt f={f} set={set} k="volumes" label="Volumes" tipo="number" step="1" />
              <PSel f={f} set={set} k="tipoEmbalagem" label="Tipo de embalagem" opcoes={[["","—"],["envelope","Envelope"],["caixa","Caixa"],["pacote","Pacote / saco"],["rolo","Rolo / cilindro"]]} />
            </div>
            <div style={{ marginTop:16, paddingTop:14, borderTop:"1px solid var(--border-soft)" }}>
              <div style={{ fontSize:11, color:"var(--text-3)" }}>Peso cubado (L × A × P ÷ 6000)</div>
              <div style={{ fontSize:19, fontWeight:600, color:"var(--text-2)" }}>{cubado > 0 ? cubado.toFixed(3) + " kg" : "—"}</div>
              <div style={dica}>Transportadora cobra pelo maior entre o peso real e o cubado. Se o cubado
                estiver acima do peso bruto, o frete se define pelo tamanho da caixa, não pela balança.</div>
            </div>
          </div>}

          {aba === "fiscal" && <div style={cartao}>
            <div style={tituloSec}>Tributação</div>
            <div style={grid2}>
              <PTxt f={f} set={set} k="ncm" label="NCM" ph="8708.29.99" dica="8 dígitos. Define a tributação do produto na nota." />
              <PTxt f={f} set={set} k="cest" label="CEST" ph="01.001.00" />
              <PSel f={f} set={set} k="origem" label="Origem da mercadoria" opcoes={[
                ["0","0 — Nacional"],["1","1 — Estrangeira, importação direta"],["2","2 — Estrangeira, mercado interno"],
                ["3","3 — Nacional, conteúdo importado > 40%"],["4","4 — Nacional, processos produtivos básicos"],
                ["5","5 — Nacional, conteúdo importado ≤ 40%"],["6","6 — Estrangeira, importação direta, sem similar"],
                ["7","7 — Estrangeira, mercado interno, sem similar"],["8","8 — Nacional, conteúdo importado > 70%"]]} />
              <PTxt f={f} set={set} k="cfop" label="CFOP padrão de venda" ph="5102" />
              <PSel f={f} set={set} k="tipoItem" label="Tipo do item" opcoes={["Mercadoria para revenda","Matéria-prima","Embalagem","Produto em processo","Produto acabado","Uso e consumo","Ativo imobilizado","Serviço","Outros insumos"]} />
            </div>
            <div style={{ ...tituloSec, marginTop:22 }}>Alíquotas (%)</div>
            <div style={grid2}>
              <PTxt f={f} set={set} k="icmsPct" label="ICMS" tipo="number" dica="Deixe vazio para usar o regime de Financeiro → Impostos (4% fora de SP, 0% em SP)." />
              <PTxt f={f} set={set} k="ipiPct" label="IPI" tipo="number" />
              <PTxt f={f} set={set} k="pisPct" label="PIS" tipo="number" />
              <PTxt f={f} set={set} k="cofinsPct" label="COFINS" tipo="number" />
            </div>
            <div style={dica}>Estes valores ficam guardados no cadastro para a emissão de nota e conferência.
              Quem manda na margem das telas de Vendas e Precificação é o ICMS por anúncio da tela de Precificação
              e o regime geral de Financeiro → Impostos.</div>
          </div>}

          {aba === "fornec" && <div style={cartao}>
            <div style={tituloSec}>Fornecedor</div>
            <div style={grid2}>
              <PTxt f={f} set={set} k="fornecedor" label="Fornecedor" list="lista-fornecedores" />
              <PTxt f={f} set={set} k="codigoFornecedor" label="Código no fornecedor" dica="Como o produto é chamado no catálogo dele." />
              <PTxt f={f} set={set} k="custoCompra" label="Custo de compra (R$)" tipo="number" />
              <PTxt f={f} set={set} k="prazoEntrega" label="Prazo de entrega (dias)" tipo="number" step="1" />
              <PTxt f={f} set={set} k="ultimaCompra" label="Última compra" tipo="date" />
            </div>
            <datalist id="lista-fornecedores">
              {(fornecedores || []).map(function(x, i){ var n = x.nome || x.razaoSocial || x.fantasia || String(x); return <option key={i} value={n} />; })}
            </datalist>
            <div style={{ marginTop:14 }}>
              <label style={lbl}>Observações de compra</label>
              <textarea value={f.obsCompra || ""} onChange={function(e){ set("obsCompra", e.target.value); }} rows={3} style={{ ...campo, resize:"vertical", fontFamily:"inherit" }} />
            </div>
          </div>}

          {aba === "anuncios" && <div style={cartao}>
            <div style={tituloSec}>Anúncios vinculados</div>
            {mlbs.length === 0 && <div style={{ fontSize:13, color:"var(--text-3)" }}>
              Nenhum anúncio ligado a este produto. A ligação é feita pelo SKU na tela <b>Operação → Vincular anúncios</b>.
            </div>}
            {mlbs.length > 0 && <div className="tabela-wrap">
              <table className="tabela">
                <thead><tr>{["Código MLB","Anúncio","Preço","Situação",""].map(function(h){ return <th key={h} className="th">{h}</th>; })}</tr></thead>
                <tbody>{mlbs.map(function(m){
                  var l = (enriched || []).find(function(x){ return x.id === m; });
                  return <tr key={m}>
                    <td className="td-num">{m}</td>
                    <td className="td" style={{ maxWidth:340 }}>{l ? l.title : <span style={{ color:"var(--text-4)" }}>anúncio não está na lista carregada</span>}</td>
                    <td className="td">{l ? fmt(l.price) : "—"}</td>
                    <td className="td">{l ? (l.status === "active" ? "Ativo" : l.status) : "—"}</td>
                    <td className="td" style={{ textAlign:"right" }}>
                      <button onClick={function(){
                        setF(function(s){
                          return Object.assign({}, s, {
                            mlbsVinculados: (s.mlbsVinculados || []).filter(function(x){ return x !== m; }),
                            mlbVinculado: s.mlbVinculado === m ? null : s.mlbVinculado,
                          });
                        });
                      }} style={{ background:"none", border:"none", color:"#FF5252", cursor:"pointer", fontSize:12 }}>Desvincular</button>
                    </td>
                  </tr>;
                })}</tbody>
              </table>
            </div>}
            <div style={dica}>Desvincular aqui só vale depois de Salvar. Se o SKU do produto for igual ao do
              anúncio, a sincronização volta a ligar os dois na próxima atualização.</div>
          </div>}

          {aba === "imagens" && <div style={cartao}>
            <div style={tituloSec}>Imagens</div>
            <div style={{ display:"flex", gap:8, marginBottom:16 }}>
              <input value={novaImagem} onChange={function(e){ setNovaImagem(e.target.value); }} placeholder="Cole o endereço (URL) da imagem" style={{ ...campo, flex:1 }} />
              <button onClick={function(){
                var u = novaImagem.trim(); if (!u) return;
                set("imagens", (f.imagens || []).concat([u])); setNovaImagem("");
              }} style={{ background:"var(--ui-accent)", border:"none", color:"var(--ui-accent-text)", fontWeight:600, padding:"9px 20px", borderRadius:8, cursor:"pointer", fontSize:13 }}>Adicionar</button>
            </div>
            {(f.imagens || []).length === 0 && <div style={{ fontSize:13, color:"var(--text-3)" }}>Nenhuma imagem. Produtos vindos do Mercado Livre já trazem as fotos do anúncio.</div>}
            <div style={{ display:"flex", flexWrap:"wrap", gap:12 }}>
              {(f.imagens || []).map(function(src, i){
                return <div key={i} style={{ width:130, border:"1px solid var(--border)", borderRadius:10, overflow:"hidden", background:"var(--bg)" }}>
                  <img src={src} alt="" style={{ width:"100%", height:110, objectFit:"cover", display:"block" }} />
                  <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"5px 7px", fontSize:11 }}>
                    <span style={{ color: i === 0 ? "var(--ui-accent)" : "var(--text-4)" }}>{i === 0 ? "principal" : "#" + (i+1)}</span>
                    <span style={{ display:"flex", gap:6 }}>
                      {i > 0 && <button title="Tornar principal" onClick={function(){
                        var arr = (f.imagens || []).slice(); var [x] = arr.splice(i, 1); arr.unshift(x); set("imagens", arr);
                      }} style={{ background:"none", border:"none", color:"var(--text-3)", cursor:"pointer", fontSize:12 }}>↑</button>}
                      <button title="Remover" onClick={function(){
                        set("imagens", (f.imagens || []).filter(function(_, j){ return j !== i; }));
                      }} style={{ background:"none", border:"none", color:"#FF5252", cursor:"pointer", fontSize:12 }}>×</button>
                    </span>
                  </div>
                </div>;
              })}
            </div>
          </div>}

          {aba === "obs" && <div style={cartao}>
            <div style={tituloSec}>Observações</div>
            <div style={{ marginBottom:14 }}>
              <label style={lbl}>Descrição complementar</label>
              <textarea value={f.descricaoComplementar || ""} onChange={function(e){ set("descricaoComplementar", e.target.value); }} rows={6} style={{ ...campo, resize:"vertical", fontFamily:"inherit" }} />
            </div>
            <div>
              <label style={lbl}>Observações internas</label>
              <textarea value={f.obs || ""} onChange={function(e){ set("obs", e.target.value); }} rows={5} style={{ ...campo, resize:"vertical", fontFamily:"inherit" }} placeholder="Anotações que ficam só aqui dentro." />
            </div>
          </div>}
        </div>
      </div>
    </div>
  );
}

// Catálogo de produtos: importar CSV, novo produto e clicar para editar. Grava via salvar().
function ProdutosTab({ produtos, salvar, fornecedores, enriched }) {
  const [busca, setBusca] = useState("");
  const [editando, setEditando] = useState(null);
  // Fica guardado: quem fecha os filtros para ganhar largura não quer reabri-los
  // a cada troca de aba.
  const [mostrarFiltros, setMostrarFiltros] = useState(function(){
    try { return localStorage.getItem("fin_filtros_ocultos") !== "1"; } catch { return true; }
  });
  function alternarFiltros(){
    setMostrarFiltros(function(v){
      var novo = !v;
      try { localStorage.setItem("fin_filtros_ocultos", novo ? "0" : "1"); } catch(e) {}
      return novo;
    });
  }
  const [mostrarAcoes, setMostrarAcoes] = useState(true);
  const [maisAcoes, setMaisAcoes] = useState(false);
  const [menuRow, setMenuRow] = useState(null);
  const [sel, setSel] = useState({});
  const [fSituacao, setFSituacao] = useState("todos");
  const [fEstoque, setFEstoque] = useState("todos");
  const [fMarca, setFMarca] = useState("");
  const [fFornecedor, setFFornecedor] = useState("");
  // Filtros que antes ficavam acinzentados "porque só existem no ERP". Agora os
  // campos existem no cadastro daqui, então filtrar por eles é filtrar dado real.
  const [fCategoria, setFCategoria] = useState("");
  const [fTipo, setFTipo] = useState("todos");
  const [fAtivo, setFAtivo] = useState("todos");
  const [fNcm, setFNcm] = useState("");
  const [fTags, setFTags] = useState("");
  const [fImagens, setFImagens] = useState("todos");
  const [fAnuncios, setFAnuncios] = useState("todos");
  const [fCodForn, setFCodForn] = useState("");
  const fileRef = useRef(null);
  const lista = (produtos || []).filter(function(p){
    var q = busca.trim().toLowerCase();
    if (q) { var cod = String(p.codigo || p.sku || "").toLowerCase(); if (nomeProd(p).toLowerCase().indexOf(q) < 0 && cod.indexOf(q) < 0 && String(p.gtin||"").toLowerCase().indexOf(q) < 0) return false; }
    var est = parseInt(p.estoqueAtual) || 0, min = parseInt(p.estoqueMinimo) || 0;
    if (fSituacao === "sem_custo" && parseFloat(p.precoCusto) > 0) return false;
    if (fSituacao === "com_custo" && !(parseFloat(p.precoCusto) > 0)) return false;
    if (fEstoque === "com" && est <= 0) return false;
    if (fEstoque === "sem" && est > 0) return false;
    if (fEstoque === "abaixo" && !(min > 0 && est < min)) return false;
    if (fMarca && String(p.marca||"").toLowerCase().indexOf(fMarca.toLowerCase()) < 0) return false;
    if (fFornecedor && String(p.fornecedor||"").toLowerCase().indexOf(fFornecedor.toLowerCase()) < 0) return false;
    if (fCategoria && String(p.categoria||"").toLowerCase().indexOf(fCategoria.toLowerCase()) < 0) return false;
    if (fTipo !== "todos" && String(p.tipo || "simples") !== fTipo) return false;
    if (fAtivo === "ativos" && String(p.status || "Ativo") !== "Ativo") return false;
    if (fAtivo === "inativos" && String(p.status || "Ativo") === "Ativo") return false;
    if (fNcm && String(p.ncm||"").indexOf(fNcm) < 0) return false;
    if (fTags && String(p.tags||"").toLowerCase().indexOf(fTags.toLowerCase()) < 0) return false;
    if (fImagens === "com" && !((p.imagens||[]).length)) return false;
    if (fImagens === "sem" && (p.imagens||[]).length) return false;
    if (fAnuncios === "com" && !qtdAnuncios(p)) return false;
    if (fAnuncios === "sem" && qtdAnuncios(p)) return false;
    if (fCodForn && String(p.codigoFornecedor||"").toLowerCase().indexOf(fCodForn.toLowerCase()) < 0) return false;
    return true;
  });
  const total = (produtos || []).length;
  function limparFiltros(){
    setFSituacao("todos"); setFEstoque("todos"); setFMarca(""); setFFornecedor("");
    setFCategoria(""); setFTipo("todos"); setFAtivo("todos"); setFNcm(""); setFTags("");
    setFImagens("todos"); setFAnuncios("todos"); setFCodForn("");
  }
  var temFiltro = fSituacao!=="todos" || fEstoque!=="todos" || fMarca || fFornecedor ||
    fCategoria || fTipo!=="todos" || fAtivo!=="todos" || fNcm || fTags ||
    fImagens!=="todos" || fAnuncios!=="todos" || fCodForn;
  const idsSel = Object.keys(sel).filter(function(k){ return sel[k]; });
  function toggleSel(id){ setSel(function(s){ var n=Object.assign({},s); if(n[id]) delete n[id]; else n[id]=true; return n; }); }
  function toggleTodos(){ if (idsSel.length === lista.length) setSel({}); else { var n={}; lista.forEach(function(p){ n[p.id]=true; }); setSel(n); } }
  function excluir(id){ if(!window.confirm("Excluir este produto?")) return; salvar((produtos||[]).filter(function(p){ return p.id!==id; })); setMenuRow(null); }
  function excluirSelecionados(){ if(!idsSel.length) return; if(!window.confirm("Excluir "+idsSel.length+" produto(s)?")) return; salvar((produtos||[]).filter(function(p){ return !sel[p.id]; })); setSel({}); }
    // nomeProd lê titulo antes de nome; sem limpar titulo o "(cópia)" nunca apareceria.
  function duplicar(p){ var novo = Object.assign({}, p, { id:"prod_"+Date.now(), titulo: nomeProd(p)+" (cópia)", nome: nomeProd(p)+" (cópia)", sku:"", mlbVinculado:null, mlbsVinculados:[], syncML:false }); salvar([novo].concat(produtos||[])); setMenuRow(null); }
  // Uma definição só para planilha e impressão. Antes o botão Imprimir chamava
  // cols/rowsExport, que não existiam neste componente — ele quebrava ao ser clicado.
  var cols = ["Código","Descrição","GTIN","Categoria","NCM","Estoque","Estoque mínimo","Marca","Fornecedor","Preço de custo","Preço de venda","Anúncios","Situação"];
  function rowsExport(){
    var base = idsSel.length ? (produtos||[]).filter(function(p){ return sel[p.id]; }) : lista;
    return base.map(function(p){
      return [p.codigo||p.sku||"", nomeProd(p), p.gtin||"", p.categoria||"", p.ncm||"",
        parseInt(p.estoqueAtual)||0, parseInt(p.estoqueMinimo)||0, p.marca||"", p.fornecedor||"",
        (parseFloat(p.precoCusto)||0).toFixed(2), (parseFloat(p.precoVenda)||0).toFixed(2),
        qtdAnuncios(p), p.status || "Ativo"];
    });
  }
  function exportarPlanilha(){ baixarCSV("produtos", cols, rowsExport()); }
  function copiar(txt){ try { navigator.clipboard.writeText(String(txt)); } catch(e){} }
  function salvarProduto(p){
    var arr = (produtos || []).slice();
    var idx = arr.findIndex(function(x){ return x.id === p.id; });
    if (idx >= 0) arr[idx] = p; else arr.push(p);
    salvar(arr);
    setEditando(null);
  }
  function importarCSV(file){
    var reader = new FileReader();
    reader.onload = function(ev){
      try {
        var linhas = String(ev.target.result || "").split(/\r?\n/).filter(function(l){ return l.trim(); });
        if (linhas.length < 2) { alert("CSV vazio."); return; }
        var headers = linhas[0].split(/[,;]/).map(function(h){ return h.trim().toLowerCase(); });
        function col(row, nomes){ for (var i=0;i<nomes.length;i++){ var j=headers.indexOf(nomes[i]); if (j>=0 && row[j]!=null) return String(row[j]).trim(); } return ""; }
        var novos = [];
        for (var i=1;i<linhas.length;i++){
          var row = linhas[i].split(/[,;]/);
          var nome = col(row,["nome","produto","descricao","descrição","título","titulo"]);
          var sku = col(row,["sku","codigo","código"]);
          if (!nome && !sku) continue;
          novos.push({ id:"prod_"+Date.now()+"_"+i, nome:nome, sku:sku,
            precoCusto: col(row,["custo","preco custo","preço custo","precocusto"]).replace(",","."),
            precoVenda: col(row,["preco venda","preço venda","venda","precovenda"]).replace(",","."),
            estoqueAtual: col(row,["estoque","estoque atual","estoqueatual","saldo"]),
            estoqueMinimo: col(row,["minimo","mínimo","estoque minimo","estoqueminimo"]),
            fornecedor: col(row,["fornecedor"]) });
        }
        var arr = (produtos || []).slice(), mapaSku = {};
        arr.forEach(function(p,idx){ if (p.sku) mapaSku[String(p.sku).toLowerCase()] = idx; });
        novos.forEach(function(n){
          var k = n.sku ? String(n.sku).toLowerCase() : null;
          if (k && mapaSku[k] != null) arr[mapaSku[k]] = Object.assign({}, arr[mapaSku[k]], n, { id: arr[mapaSku[k]].id });
          else arr.push(n);
        });
        salvar(arr);
        alert(novos.length + " produto(s) importado(s) do CSV.");
      } catch(e) { alert("Não consegui ler o CSV."); }
    };
    reader.readAsText(file);
  }
  var selFiltro = { width:"100%", background:"var(--bg-2)", border:"1px solid var(--border)", color:"var(--text-2)", padding:"7px 9px", borderRadius:8, fontSize:12.5 };
  var menuItem = { background:"none", border:"none", textAlign:"left", padding:"7px 10px", borderRadius:6, cursor:"pointer", fontSize:12.5, color:"var(--text-2)", width:"100%" };
  var acaoItem = { background:"none", border:"none", textAlign:"left", padding:"9px 10px", borderRadius:7, cursor:"pointer", fontSize:12.5, color:"var(--text-2)", width:"100%" };
  var acaoSub = { background:"none", border:"none", textAlign:"left", padding:"5px 2px", cursor:"pointer", fontSize:12, color:"var(--text-2)", width:"100%", display:"block" };
  function Campo(props){ return <div><div style={{ fontSize:11, color:"var(--text-3)", marginBottom:3 }}>{props.label}</div>{props.children}</div>; }
  return (
    <div style={{ padding:2 }}>
      <input ref={fileRef} type="file" accept=".csv,text/csv" style={{ display:"none" }} onChange={function(e){ if (e.target.files && e.target.files[0]) importarCSV(e.target.files[0]); e.target.value=""; }} />
      <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:12, flexWrap:"wrap" }}>
        <div style={{ fontWeight:600, fontSize:20, color:"var(--text-strong)" }}>Produtos</div>
        <button onClick={alternarFiltros} title="Filtros"
          style={{ background: mostrarFiltros?"rgba(118,133,146,.14)":"var(--surface)", border:"1px solid var(--border)", color:"var(--text-2)", padding:"9px 12px", borderRadius:9, cursor:"pointer", fontSize:13 }}>{mostrarFiltros ? "⟨ Filtros" : "⟩ Filtros"}</button>
        <div style={{ position:"relative", flex:1, minWidth:220, maxWidth:560 }}>
          <span style={{ position:"absolute", left:12, top:"50%", transform:"translateY(-50%)", color:"var(--text-3)", fontSize:13 }}>🔍</span>
          <input value={busca} onChange={function(e){ setBusca(e.target.value); }} placeholder="Pesquisar por código, descrição ou GTIN"
            style={{ width:"100%", background:"var(--surface)", border:"1px solid var(--border)", color:"var(--text-strong)", padding:"9px 12px 9px 34px", borderRadius:9, fontSize:13, outline:"none" }} />
        </div>
        <div style={{ flex:1 }} />
        <button onClick={function(){ setMostrarAcoes(function(v){return !v;}); }}
          style={{ background:"var(--surface)", border:"1px solid var(--border)", color:"var(--text-2)", padding:"9px 12px", borderRadius:9, cursor:"pointer", fontSize:13 }}>Ações</button>
      </div>

      <div style={{ display:"flex", gap:12, alignItems:"flex-start" }}>
        {mostrarFiltros && (
          <div style={{ width:230, flexShrink:0, background:"var(--surface)", border:"1px solid var(--border)", borderRadius:12, padding:"14px", display:"flex", flexDirection:"column", gap:11 }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
              <span style={{ fontWeight:600, fontSize:14, color:"var(--text-strong)" }}>Filtrar</span>
              {temFiltro && <button onClick={limparFiltros} style={{ background:"none", border:"none", color:"#768592", cursor:"pointer", fontSize:12 }}>Limpar</button>}
            </div>
            <Campo label="Situação"><select value={fSituacao} onChange={function(e){ setFSituacao(e.target.value); }} style={selFiltro}><option value="todos">Todos</option><option value="com_custo">Com custo</option><option value="sem_custo">Sem custo</option></select></Campo>
            <Campo label="Estoque"><select value={fEstoque} onChange={function(e){ setFEstoque(e.target.value); }} style={selFiltro}><option value="todos">Todos</option><option value="com">Com estoque</option><option value="sem">Sem estoque</option><option value="abaixo">Abaixo do mínimo</option></select></Campo>
            <Campo label="Marca"><input value={fMarca} onChange={function(e){ setFMarca(e.target.value); }} placeholder="Marca" style={selFiltro} /></Campo>
            <Campo label="Fornecedor"><input value={fFornecedor} onChange={function(e){ setFFornecedor(e.target.value); }} placeholder="Fornecedor" style={selFiltro} /></Campo>
            <Campo label="Categoria"><input value={fCategoria} onChange={function(e){ setFCategoria(e.target.value); }} placeholder="Categoria" list="filtro-categorias" style={selFiltro} /></Campo>
            <datalist id="filtro-categorias">{Array.from(new Set((produtos||[]).map(function(p){ return p.categoria; }).filter(Boolean))).map(function(c){ return <option key={c} value={c} />; })}</datalist>
            <Campo label="Tipo"><select value={fTipo} onChange={function(e){ setFTipo(e.target.value); }} style={selFiltro}><option value="todos">Todos</option><option value="simples">Simples</option><option value="kit">Kit / composição</option><option value="variacao">Com variações</option><option value="materia">Matéria-prima</option><option value="servico">Serviço</option></select></Campo>
            <Campo label="Ativo/Inativo"><select value={fAtivo} onChange={function(e){ setFAtivo(e.target.value); }} style={selFiltro}><option value="todos">Todos</option><option value="ativos">Ativos</option><option value="inativos">Inativos</option></select></Campo>
            <Campo label="Anúncios"><select value={fAnuncios} onChange={function(e){ setFAnuncios(e.target.value); }} style={selFiltro}><option value="todos">Todos</option><option value="com">Com anúncio vinculado</option><option value="sem">Sem anúncio</option></select></Campo>
            <Campo label="Imagens"><select value={fImagens} onChange={function(e){ setFImagens(e.target.value); }} style={selFiltro}><option value="todos">Todas</option><option value="com">Com imagem</option><option value="sem">Sem imagem</option></select></Campo>
            <Campo label="NCM"><input value={fNcm} onChange={function(e){ setFNcm(e.target.value); }} placeholder="8708" style={selFiltro} /></Campo>
            <Campo label="Etiquetas"><input value={fTags} onChange={function(e){ setFTags(e.target.value); }} placeholder="Etiqueta" style={selFiltro} /></Campo>
            <Campo label="Cód. fornecedor"><input value={fCodForn} onChange={function(e){ setFCodForn(e.target.value); }} placeholder="Código" style={selFiltro} /></Campo>
            <div style={{ fontSize:10, color:"var(--text-4)", lineHeight:1.4 }}>Todos estes filtros leem o cadastro do produto desta tela. Um filtro vazio de resultados costuma significar que o campo ainda não foi preenchido — abra o produto e complete o cadastro.</div>
          </div>
        )}

        <div style={{ flex:1, minWidth:0 }}>
          {idsSel.length > 0 && (
            <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:8, background:"rgba(118,133,146,.10)", border:"1px solid var(--border)", borderRadius:9, padding:"7px 12px", fontSize:12 }}>
              <span style={{ color:"var(--text-2)" }}>{idsSel.length} selecionado(s)</span>
              <button onClick={exportarPlanilha} className="btn-exp">Exportar</button>
              <button onClick={excluirSelecionados} className="btn-exp" style={{ color:"#FF5252" }}>Excluir</button>
              <button onClick={function(){ setSel({}); }} className="btn-exp" style={{ borderColor:"transparent", background:"transparent" }}>Limpar</button>
            </div>
          )}
          <div className="tabela-wrap">
            <table className="tabela">
              <thead><tr>
                <th className="th" style={{ width:34 }}><input type="checkbox" checked={lista.length>0 && idsSel.length===lista.length} onChange={toggleTodos} /></th>
                {["Descrição","Código","Estoque","Marca","Preço de custo","Preço de venda","Anúncios","Situação",""].map(function(h){ return <th key={h} className="th">{h}</th>; })}
              </tr></thead>
              <tbody>
                {lista.slice(0,500).map(function(p,i){
                  var cod = p.codigo || p.sku || "—";
                  var nAnuncios = qtdAnuncios(p);
                  var ativo = String(p.status || "Ativo") === "Ativo";
                  var img = (p.imagens || [])[0] || null;
                  // A linha inteira abre o produto. Só a coluna de seleção e a do menu
                  // param o clique — nelas o alvo é o controle, não o produto.
                  function abrir(){ setEditando(p); }
                  return <tr key={p.id||i} onClick={abrir} style={{ cursor:"pointer" }} title="Abrir cadastro do produto">
                    <td className="td" onClick={function(e){ e.stopPropagation(); }}><input type="checkbox" checked={!!sel[p.id]} onChange={function(){ toggleSel(p.id); }} /></td>
                    <td className="td" style={{ maxWidth:340, color:"var(--text-strong)", fontWeight:500 }}>
                      <span style={{ display:"flex", alignItems:"center", gap:9, minWidth:0 }}>
                        {img
                          ? <img src={img} alt="" style={{ width:28, height:28, borderRadius:5, objectFit:"cover", flexShrink:0 }} />
                          : <span style={{ width:28, height:28, borderRadius:5, background:"var(--surface-3)", flexShrink:0 }} />}
                        <span style={{ overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{nomeProd(p)}</span>
                      </span>
                    </td>
                    <td className="td-num">{cod} <button className="copy-btn" onClick={function(e){ e.stopPropagation(); copiar(cod); }}>⎘</button></td>
                    <td className="td">{parseInt(p.estoqueAtual)||0}</td>
                    <td className="td">{p.marca || "—"}</td>
                    <td className="td">{parseFloat(p.precoCusto)>0 ? fmt(parseFloat(p.precoCusto)) : <span style={{ color:"#FFC107" }}>0,00</span>}</td>
                    <td className="td">{parseFloat(p.precoVenda)>0 ? fmt(parseFloat(p.precoVenda)) : "—"}</td>
                    <td className="td">{nAnuncios ? nAnuncios : <span style={{ color:"var(--text-4)" }}>—</span>}</td>
                    <td className="td" style={{ color: ativo ? "#0a9d4e" : "var(--text-4)" }}>{ativo ? "Ativo" : "Inativo"}</td>
                    <td className="td" style={{ position:"relative", textAlign:"right", width:44 }} onClick={function(e){ e.stopPropagation(); }}>
                      <button onClick={function(){ setMenuRow(menuRow===p.id?null:p.id); }} style={{ background:"none", border:"none", color:"var(--text-3)", cursor:"pointer", fontSize:16, padding:"0 6px" }}>⋮</button>
                      {menuRow===p.id && (
                        <div style={{ position:"absolute", right:8, top:"100%", zIndex:50, background:"var(--surface)", border:"1px solid var(--border)", borderRadius:8, boxShadow:"0 8px 24px rgba(0,0,0,.18)", padding:4, minWidth:130, display:"flex", flexDirection:"column" }}>
                          <button onClick={function(){ setEditando(p); setMenuRow(null); }} style={menuItem}>Editar</button>
                          <button onClick={function(){ duplicar(p); }} style={menuItem}>Duplicar</button>
                          <button onClick={function(){ excluir(p.id); }} style={{ ...menuItem, color:"#FF5252" }}>Excluir</button>
                        </div>
                      )}
                    </td>
                  </tr>;
                })}
              </tbody>
            </table>
            {lista.length===0 && <div style={{ padding:24, textAlign:"center", color:"var(--text-3)" }}>Nenhum produto. Use "Incluir cadastro" ou "Importar CSV".</div>}
          </div>
          <div style={{ fontSize:12, color:"var(--text-3)", marginTop:8 }}>{lista.length} de {total} produto(s){lista.length>500?" (mostrando 500)":""}</div>
        </div>

        {mostrarAcoes && (
          <div style={{ width:236, flexShrink:0, display:"flex", flexDirection:"column", gap:8 }}>
            <button onClick={function(){ setEditando({}); }} style={{ background:"var(--ui-accent)", border:"none", color:"var(--ui-accent-text)", fontWeight:600, padding:"11px", borderRadius:9, cursor:"pointer", fontSize:13.5 }}>+ Incluir cadastro</button>
            <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:12, padding:"6px", display:"flex", flexDirection:"column" }}>
              <button onClick={function(){ if(fileRef.current) fileRef.current.click(); }} style={acaoItem}>Importar CSV</button>
              <button onClick={exportarPlanilha} style={acaoItem}>Exportar dados para planilha</button>
              <button onClick={function(){ baixarPDF("produtos", cols, rowsExport()); }} style={acaoItem}>Imprimir{idsSel.length?(" ("+idsSel.length+" selec.)"):""}</button>
              <button onClick={function(){ setMaisAcoes(function(v){return !v;}); }} style={{ ...acaoItem, color:"var(--ui-accent)", fontWeight:600 }}>{maisAcoes?"− ":"+ "}Mais ações</button>
              {maisAcoes && <div style={{ padding:"2px 8px 8px" }}>
                <div style={{ fontSize:11, color:"var(--text-4)", margin:"6px 0 3px" }}>Planilhas</div>
                <button onClick={exportarPlanilha} style={acaoSub}>Exportar dados para planilha</button>
                <div style={{ fontSize:11, color:"var(--text-4)", margin:"8px 0 3px" }}>Edição</div>
                <button onClick={excluirSelecionados} style={{ ...acaoSub, color: idsSel.length?"#FF5252":"var(--text-4)" }}>Excluir selecionados</button>
                <div style={{ fontSize:10, color:"var(--text-4)", marginTop:8, lineHeight:1.4 }}>Reajuste em massa, tags, categorias, multiloja e listas de preço são recursos de ERP — não disponíveis aqui.</div>
              </div>}
            </div>
            <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:12, padding:"12px 14px" }}>
              <div style={{ fontSize:12, color:"var(--text-3)" }}>Quantidade de produtos</div>
              <div style={{ fontSize:22, fontWeight:600, color:"var(--ui-accent)" }}>{total}</div>
            </div>
          </div>
        )}
      </div>
      {editando && <ProdutoPagina
        produto={editando.id ? editando : null}
        produtos={produtos}
        fornecedores={fornecedores}
        enriched={enriched}
        onSave={salvarProduto}
        onExcluir={function(p){ if (!window.confirm("Excluir este produto?")) return; salvar((produtos||[]).filter(function(x){ return x.id !== p.id; })); setEditando(null); }}
        onClose={function(){ setEditando(null); }} />}
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
      <div style={{ fontWeight:600, fontSize:20, color:"var(--text-strong)" }}>Estoque</div>
      <div style={{ fontSize:13, color:"var(--text-3)", marginBottom:14 }}>Saldo atual x mínimo, com alerta de reposição.</div>
      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(170px,1fr))", gap:12, marginBottom:14 }}>
        {kpis.map(function(k,i){ return <div key={i} className="kpi"><div className="kpi-rot">{k.l}</div><div className="kpi-val" style={{ color:k.c }}>{k.v}</div></div>; })}
      </div>
      <div style={{ display:"flex", gap:6, marginBottom:12 }}>
        {filtros.map(function(f){ var a = filtro === f[0]; return <button key={f[0]} onClick={function(){ setFiltro(f[0]); }} style={{ padding:"7px 14px", borderRadius:8, border:"1px solid var(--border)", cursor:"pointer", fontSize:12, fontWeight:600, background: a ? "#768692" : "var(--surface)", color: a ? "#fff" : "var(--text-3)" }}>{f[1]}</button>; })}
      </div>
      <div className="tabela-wrap">
        <table className="tabela">
          <thead><tr>{["Foto","Produto","SKU","Estoque","Mínimo","Situação","Anúncios"].map(function(h){ return <th key={h} className="th">{h}</th>; })}</tr></thead>
          <tbody>
            {lista.slice(0,400).map(function(p,i){
              var img = (p.imagens && p.imagens[0]) || null;
              var s = situacao(p); var b = badge[s];
              return <tr key={p.id || i}>
                <td className="td">{img ? <img src={img} alt="" style={{ width:36, height:36, borderRadius:6, objectFit:"cover" }} /> : <div style={{ width:36, height:36, borderRadius:6, background:"var(--surface-3)" }} />}</td>
                <td className="td" style={{ maxWidth:300, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", color:"var(--text-strong)", fontWeight:500 }}>{nomeProd(p)}</td>
                <td className="td-num">{p.sku || "—"}</td>
                <td className="td" style={{ fontWeight:500, color: s === "zerado" ? "#FF5252" : "var(--text-strong)" }}>{parseInt(p.estoqueAtual) || 0}</td>
                <td className="td">{parseInt(p.estoqueMinimo) || 0}</td>
                <td className="td"><span style={{ fontSize:11, fontWeight:500, padding:"2px 8px", borderRadius:20, background:b[1], color:b[0] }}>{b[2]}</span></td>
                <td className="td">{qtdAnuncios(p)}</td>
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
function VincularTab({ enriched, produtos, salvar }) {
  const [filtro, setFiltro] = useState("todos"); // todos | vinculados | sem_produto
  const [busca, setBusca] = useState("");
  var opcoesProd = (produtos || []).slice().sort(function(a,b){ return nomeProd(a).localeCompare(nomeProd(b)); });
  function produtoDoAnuncio(mlb, sku){
    var p = (produtos || []).find(function(x){ return (x.mlbsVinculados || []).indexOf(mlb) >= 0 || x.mlbVinculado === mlb; });
    if (p) return p;
    if (sku){ var q = (produtos || []).find(function(x){ return x.sku && String(x.sku).toLowerCase() === String(sku).toLowerCase(); }); if (q) return q; }
    return null;
  }
  function vincular(mlb, produtoId){
    var arr = (produtos || []).map(function(p){
      var mlbs = (p.mlbsVinculados || []).filter(function(m){ return m !== mlb; });
      if (produtoId && p.id === produtoId) mlbs = mlbs.concat([mlb]);
      return Object.assign({}, p, { mlbsVinculados: mlbs });
    });
    salvar(arr);
  }
  function vincularAuto(){
    var arr = (produtos || []).map(function(p){ return Object.assign({}, p, { mlbsVinculados: (p.mlbsVinculados || []).slice() }); });
    var mp = {}; arr.forEach(function(p){ if (p.sku) mp[String(p.sku).toLowerCase()] = p; });
    var n = 0;
    (enriched || []).forEach(function(l){ var sku = l.seller_sku || l.sku || ""; if (!sku) return; var p = mp[String(sku).toLowerCase()]; if (p && (p.mlbsVinculados || []).indexOf(l.id) < 0){ p.mlbsVinculados.push(l.id); n++; } });
    salvar(arr);
    alert(n + " anúncio(s) vinculado(s) automaticamente por SKU.");
  }
  var linhas = (enriched || []).map(function(l){
    var sku = l.seller_sku || l.sku || "";
    var prod = produtoDoAnuncio(l.id, sku);
    return { id:l.id, titulo:l.title, sku:sku, thumb:l.thumbnail, prod:prod, vinculado: !!prod };
  });
  var lista = linhas.filter(function(r){
    if (filtro === "sem_produto" && r.vinculado) return false;
    if (filtro === "vinculados" && !r.vinculado) return false;
    if (busca.trim()){ var q = busca.trim().toLowerCase(); if (!((r.titulo||"").toLowerCase().indexOf(q)>=0 || (r.sku||"").toLowerCase().indexOf(q)>=0 || String(r.id).indexOf(q)>=0)) return false; }
    return true;
  });
  var nVinc = linhas.filter(function(r){ return r.vinculado; }).length;
  var nSem = linhas.length - nVinc;
  var kpis = [
    { l:"Anúncios", v:String(linhas.length), c:"var(--text-strong)" },
    { l:"Vinculados", v:String(nVinc), c:"#0a9d4e" },
    { l:"Sem produto", v:String(nSem), c: nSem > 0 ? "#FFC107" : "var(--text-strong)" },
  ];
  var filtros = [["todos","Todos"],["vinculados","Vinculados"],["sem_produto","Sem produto"]];
  return (
    <div style={{ padding:2 }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", gap:12, flexWrap:"wrap" }}>
        <div>
          <div style={{ fontWeight:600, fontSize:20, color:"var(--text-strong)" }}>Vincular anúncios</div>
          <div style={{ fontSize:13, color:"var(--text-3)", marginBottom:14 }}>Ligue cada anúncio ao produto do catálogo — o vínculo dá baixa no estoque a cada venda.</div>
        </div>
        <button onClick={vincularAuto} style={{ background:"#768692", border:"none", color:"#fff", fontWeight:500, padding:"9px 18px", borderRadius:9, cursor:"pointer", fontSize:13, whiteSpace:"nowrap" }}>Vincular automático</button>
      </div>
      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(170px,1fr))", gap:12, marginBottom:14 }}>
        {kpis.map(function(k,i){ return <div key={i} className="kpi"><div className="kpi-rot">{k.l}</div><div className="kpi-val" style={{ color:k.c }}>{k.v}</div></div>; })}
      </div>
      <div style={{ display:"flex", gap:6, marginBottom:10, flexWrap:"wrap" }}>
        {filtros.map(function(f){ var a = filtro === f[0]; return <button key={f[0]} onClick={function(){ setFiltro(f[0]); }} style={{ padding:"7px 14px", borderRadius:8, border:"1px solid var(--border)", cursor:"pointer", fontSize:12, fontWeight:600, background: a ? "#768692" : "var(--surface)", color: a ? "#fff" : "var(--text-3)" }}>{f[1]}</button>; })}
      </div>
      <input value={busca} onChange={function(e){ setBusca(e.target.value); }} placeholder="Buscar por título, SKU ou MLB..." className="busca" />
      <datalist id="dl-produtos">
        {opcoesProd.map(function(p){ return <option key={p.id} value={nomeProd(p)} />; })}
      </datalist>
      <div className="tabela-wrap">
        <table className="tabela">
          <thead><tr>{["Foto","Anúncio","MLB","SKU","Produto do catálogo"].map(function(h){ return <th key={h} className="th">{h}</th>; })}</tr></thead>
          <tbody>
            {lista.slice(0,150).map(function(r,i){
              return <tr key={r.id || i}>
                <td className="td">{r.thumb ? <img src={r.thumb} alt="" style={{ width:36, height:36, borderRadius:6, objectFit:"cover" }} /> : <div style={{ width:36, height:36, borderRadius:6, background:"var(--surface-3)" }} />}</td>
                <td className="td" style={{ maxWidth:260, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", color:"var(--text-strong)" }}>{r.titulo || "—"}</td>
                <td className="td-num">{r.id}</td>
                <td className="td-num">{r.sku || "—"}</td>
                <td className="td">
                  <input list="dl-produtos" key={r.prod ? r.prod.id : "none"} defaultValue={r.prod ? nomeProd(r.prod) : ""} placeholder="Sem vínculo"
                    onChange={function(e){ var nome = e.target.value; var p = opcoesProd.find(function(x){ return nomeProd(x) === nome; }); if (p || nome === "") vincular(r.id, p ? p.id : ""); }}
                    style={{ width:220, maxWidth:"100%", background:"var(--bg)", border:"1px solid " + (r.vinculado ? "rgba(10,157,78,.4)" : "var(--border)"), color:"var(--text-strong)", padding:"7px 10px", borderRadius:8, fontSize:12, outline:"none" }} />
                </td>
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
// ─────────────────────────────────────────────────────────────────────────
// Helpers de gráficos (Recharts) usados no Dashboard, Relatórios e DRE.
// ─────────────────────────────────────────────────────────────────────────
var CHART_AXIS = "#8492a8";                       // cor dos rótulos dos eixos (legível nos 2 temas)
var CHART_GRID = "rgba(128,140,168,.16)";         // linhas de grade
var CORES_DINHEIRO = { custo:"#e5484d", taxas:"#FFC107", impostos:"#768692", lucro:"#0a9d4e" }; // custo=vermelho, taxas=amarelo, impostos=slate, lucro=verde
// Paleta categórica alinhada às cores do sistema (slate + nude/camel + grafite + terracota).
var PALETA_SISTEMA = ["#768692", "#c2a878", "#3a4550", "#b5714e"];
var PALETA_ABC = ["#768692","#00A3B5","#0a9d4e","#FFC107","#FF7043","#768592","#E7515A","#5A6B86"];

// Tooltip padrão em R$ (respeita o tema via var(--...)).
function fmtDiaCurto(iso){
  var p = String(iso || "").slice(0, 10).split("-");
  return p.length === 3 ? p[2] + "/" + p[1] : String(iso || "");
}
function TipMoeda({ active, payload, label }){
  if(!active || !payload || !payload.length) return null;
  return (
    <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:8, padding:"8px 11px", fontSize:12, boxShadow:"0 6px 20px rgba(0,0,0,.28)" }}>
      {label != null && label !== "" && <div style={{ color:"var(--text-strong)", fontWeight:500, marginBottom:5 }}>{label}</div>}
      {payload.map(function(p,i){ return (
        <div key={i} style={{ display:"flex", alignItems:"center", gap:6, color:"var(--text-2)", padding:"1px 0" }}>
          <span style={{ width:9, height:9, borderRadius:2, background:(p.color || (p.payload && p.payload.cor) || "#888"), display:"inline-block" }} />
          <span>{p.name}:</span>
          <b style={{ color:"var(--text-strong)" }}>{fmt(p.value)}</b>
        </div>
      ); })}
    </div>
  );
}

// Cartão-moldura para um gráfico (título + subtítulo + ação à direita).
function ChartCard({ titulo, sub, right, children, minW, flex }){
  return (
    <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:12, padding:"16px 18px", flex:(flex==null?1:flex), minWidth:(minW||280) }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:12, gap:10 }}>
        <div>
          <div style={{ fontWeight:500, fontSize:15, color:"var(--text-strong)" }}>{titulo}</div>
          {sub && <div style={{ fontSize:12, color:"var(--text-3)", marginTop:2 }}>{sub}</div>}
        </div>
        {right || null}
      </div>
      {children}
    </div>
  );
}

// Agrega pedidos por dia -> [{ ord:"yyyy-mm-dd", dia:"dd/mm", fat, lucro }] (ordem crescente).
function agrupaPorDia(orders){
  var m = {};
  (orders||[]).forEach(function(o){
    var dia = (o.date||"").slice(0,10); if(!dia) return;
    var q = o.qty||1;
    if(!m[dia]) m[dia] = { ord:dia, dia: dia.slice(8,10)+"/"+dia.slice(5,7), fat:0, lucro:0 };
    m[dia].fat += (o.price||0)*q; m[dia].lucro += (o.profit||0)*q;
  });
  return Object.keys(m).sort().map(function(k){ return m[k]; });
}

// Curva ABC por produto (classificada por faturamento acumulado): A ≤80%, B ≤95%, C o resto.
function curvaABC(orders){
  var m = {};
  (orders||[]).forEach(function(o){
    var q = o.qty||1;
    var k = o.listing_id || o.title || "?";
    if(!m[k]) m[k] = { titulo:o.title||k, fat:0, lucro:0, qtd:0 };
    m[k].fat += (o.price||0)*q; m[k].lucro += (o.profit||0)*q; m[k].qtd += q;
  });
  var arr = Object.keys(m).map(function(k){ return m[k]; }).sort(function(a,b){ return b.fat - a.fat; });
  var total = arr.reduce(function(s,x){ return s+x.fat; }, 0) || 1;
  var acc = 0;
  arr.forEach(function(x){ acc += x.fat; x.pctAcc = acc/total*100; x.classe = x.pctAcc <= 80 ? "A" : (x.pctAcc <= 95 ? "B" : "C"); });
  return arr;
}

// Botão "Exportar PDF": usa a impressão do navegador (Salvar como PDF).
function exportarPDF(){ try { window.print(); } catch(e){} }

// Filtro de período reutilizável (Dashboard/Relatórios). Retorna [botões JSX].
var PERIODOS_REL = [["7","7 dias"],["30","30 dias"],["90","90 dias"],["tudo","Tudo"]];
function cutoffPeriodo(periodo){
  if (periodo === "tudo") return "0000-00-00";
  var d = new Date(); d.setDate(d.getDate() - parseInt(periodo, 10));
  return d.toISOString().slice(0, 10);
}

function RelatoriosTab({ enrichedOrders }) {
  const [periodo, setPeriodo] = useState("30");
  var cutoff = cutoffPeriodo(periodo);
  var validos = (enrichedOrders || []).filter(function(o){ return o.status !== "cancelled" && (o.date || "") >= cutoff; });

  // Agregados do período
  var fat=0, lucro=0, custo=0, taxas=0, impostos=0;
  validos.forEach(function(o){ var q=o.qty||1;
    fat += (o.price||0)*q; lucro += (o.profit||0)*q; custo += (o.cost||0)*q; taxas += (o.fee||0)*q; impostos += (o.imposto||0)*q; });
  var nPed = validos.length, ticket = nPed ? fat/nPed : 0, margem = fat ? lucro/fat*100 : 0;

  var serieDia = agrupaPorDia(validos);
  var dinheiro = [
    { name:"Custo produto", value:Math.max(0,custo), cor:CORES_DINHEIRO.custo },
    { name:"Taxas ML",      value:Math.max(0,taxas), cor:CORES_DINHEIRO.taxas },
    { name:"Impostos",      value:Math.max(0,impostos), cor:CORES_DINHEIRO.impostos },
    { name:"Lucro",         value:Math.max(0,lucro), cor:CORES_DINHEIRO.lucro },
  ].filter(function(d){ return d.value > 0; });
  // Faturamento por canal (a empresa vende hoje só no Mercado Livre; Shopee entra quando integrar).
  var canais = [ { canal:"Mercado Livre", fat:fat, cor:"#FFE600" }, { canal:"Shopee", fat:0, cor:"#EE4D2D" } ];
  var abc = curvaABC(validos);

  // Resumo mensal (tabela histórica completa, ignora o filtro de período)
  var porMes = {};
  (enrichedOrders || []).filter(function(o){ return o.status !== "cancelled"; }).forEach(function(o){
    var mes = (o.date || "").slice(0, 7); if (!mes) return; var q = o.qty || 1;
    if (!porMes[mes]) porMes[mes] = { mes:mes, fat:0, lucro:0, ped:0 };
    porMes[mes].fat += (o.price || 0) * q; porMes[mes].lucro += (o.profit || 0) * q; porMes[mes].ped += 1;
  });
  var meses = Object.keys(porMes).sort().reverse().map(function(k){ return porMes[k]; });
  function rotuloMes(m){ return m.slice(5) + "/" + m.slice(0, 4); }

  var kpis = [
    { l:"Faturamento", v:fmt(fat), c:"var(--text-strong)" },
    { l:"Lucro líquido", v:fmt(lucro), c: lucro>=0?"#0a9d4e":"#FF5252" },
    { l:"Margem", v:margem.toFixed(1)+"%", c: margem>=0?"#0a9d4e":"#FF5252" },
    { l:"Pedidos", v:String(nPed), c:"var(--text-strong)" },
    { l:"Ticket médio", v:fmt(ticket), c:"var(--text-strong)" },
  ];

  return (
    <div style={{ padding:2 }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", flexWrap:"wrap", gap:10, marginBottom:16 }}>
        <div>
          <div style={{ fontWeight:600, fontSize:20, color:"var(--text-strong)" }}>Relatórios</div>
          <div style={{ fontSize:13, color:"var(--text-3)" }}>Desempenho de vendas, lucro e curva ABC de produtos.</div>
        </div>
        <div style={{ display:"flex", gap:6, alignItems:"center" }}>
          {PERIODOS_REL.map(function(p){ var ativo = periodo===p[0];
            return <button key={p[0]} onClick={function(){ setPeriodo(p[0]); }}
              style={{ padding:"7px 14px", borderRadius:8, border:"1px solid var(--border)", cursor:"pointer", fontSize:12, fontWeight:600,
                background: ativo ? "#768692" : "var(--surface)", color: ativo ? "#fff" : "var(--text-3)" }}>{p[1]}</button>; })}
          <button onClick={exportarPDF} className="btn-pdf" style={{ marginLeft:4 }} title="Salvar/Imprimir como PDF">⬇ Exportar PDF</button>
        </div>
      </div>

      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit, minmax(150px, 1fr))", gap:12, marginBottom:16 }}>
        {kpis.map(function(k,i){ return <div key={i} style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:12, padding:"14px 16px" }}>
          <div style={{ fontSize:11, color:"var(--text-3)", textTransform:"none", letterSpacing:.5, fontWeight:600 }}>{k.l}</div>
          <div style={{ fontSize:21, fontWeight:600, color:k.c, marginTop:6 }}>{k.v}</div>
        </div>; })}
      </div>

      <div style={{ marginBottom:14 }}>
        <ChartCard titulo="Faturamento × lucro por dia" sub="Evolução diária no período selecionado">
          {serieDia.length === 0 ? <div style={{ color:"var(--text-3)", fontSize:13, padding:"30px 0", textAlign:"center" }}>Sem vendas no período.</div> :
          <ResponsiveContainer width="100%" height={260}>
            <AreaChart data={serieDia} margin={{ top:6, right:10, left:0, bottom:0 }}>
              <defs>
                <linearGradient id="gFat" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#768692" stopOpacity={.35}/><stop offset="100%" stopColor="#768692" stopOpacity={0}/></linearGradient>
                <linearGradient id="gLucro" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#0a9d4e" stopOpacity={.35}/><stop offset="100%" stopColor="#0a9d4e" stopOpacity={0}/></linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID} vertical={false} />
              <XAxis dataKey="dia" tick={{ fill:CHART_AXIS, fontSize:11 }} tickLine={false} axisLine={{ stroke:CHART_GRID }} minTickGap={16} />
              <YAxis tick={{ fill:CHART_AXIS, fontSize:11 }} tickLine={false} axisLine={false} width={54} tickFormatter={function(v){ return "R$"+(v>=1000?(v/1000).toFixed(0)+"k":v); }} />
              <RTooltip content={<TipMoeda />} />
              <Legend wrapperStyle={{ fontSize:12 }} />
              <Area type="monotone" dataKey="fat" name="Faturamento" stroke="#768692" strokeWidth={2} fill="url(#gFat)" />
              <Area type="monotone" dataKey="lucro" name="Lucro" stroke="#0a9d4e" strokeWidth={2} fill="url(#gLucro)" />
            </AreaChart>
          </ResponsiveContainer>}
        </ChartCard>
      </div>

      <div style={{ display:"flex", gap:14, flexWrap:"wrap", marginBottom:14 }}>
        <ChartCard titulo="Para onde foi o dinheiro" sub="Composição do faturamento" minW={300}>
          {dinheiro.length === 0 ? <div style={{ color:"var(--text-3)", fontSize:13, padding:"30px 0", textAlign:"center" }}>Sem dados no período.</div> :
          <ResponsiveContainer width="100%" height={230}>
            <PieChart>
              <Pie data={dinheiro} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={58} outerRadius={88} paddingAngle={2} stroke="none">
                {dinheiro.map(function(d,i){ return <Cell key={i} fill={d.cor} />; })}
              </Pie>
              <RTooltip content={<TipMoeda />} />
              <Legend wrapperStyle={{ fontSize:12 }} />
            </PieChart>
          </ResponsiveContainer>}
        </ChartCard>
        <ChartCard titulo="Faturamento por canal" sub="Shopee entra quando a integração for ativada" minW={300}>
          <ResponsiveContainer width="100%" height={230}>
            <BarChart data={canais} margin={{ top:6, right:10, left:0, bottom:0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID} vertical={false} />
              <XAxis dataKey="canal" tick={{ fill:CHART_AXIS, fontSize:11 }} tickLine={false} axisLine={{ stroke:CHART_GRID }} />
              <YAxis tick={{ fill:CHART_AXIS, fontSize:11 }} tickLine={false} axisLine={false} width={54} tickFormatter={function(v){ return "R$"+(v>=1000?(v/1000).toFixed(0)+"k":v); }} />
              <RTooltip content={<TipMoeda />} cursor={{ fill:"rgba(128,140,168,.08)" }} />
              <Bar dataKey="fat" name="Faturamento" radius={[6,6,0,0]} maxBarSize={90}>
                {canais.map(function(c,i){ return <Cell key={i} fill={c.cor} />; })}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      <ChartCard titulo="Curva ABC de produtos" sub="A = 80% do faturamento · B = próximos 15% · C = cauda" flex={null}>
        <div className="tabela-wrap">
          <table className="tabela">
            <thead><tr>{["Classe","Produto","Qtd","Faturamento","Lucro","% acumulado"].map(function(h){ return <th key={h} className="th">{h}</th>; })}</tr></thead>
            <tbody>
              {abc.length === 0 ? <tr><td className="td" colSpan={6}>Sem vendas no período.</td></tr> :
              abc.slice(0, 40).map(function(x,i){
                var cor = x.classe==="A" ? "#0a9d4e" : (x.classe==="B" ? "#FFC107" : "#8492a8");
                return <tr key={i}>
                  <td className="td"><span style={{ display:"inline-block", minWidth:22, textAlign:"center", padding:"2px 6px", borderRadius:6, background:cor, color:"#fff", fontWeight:600, fontSize:11 }}>{x.classe}</span></td>
                  <td className="td" style={{ maxWidth:320, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", color:"var(--text-strong)" }}>{x.titulo}</td>
                  <td className="td">{x.qtd}</td>
                  <td className="td-num">{fmt(x.fat)}</td>
                  <td className="td-num" style={{ color: x.lucro>=0?"#0a9d4e":"#FF5252", fontWeight:500 }}>{fmt(x.lucro)}</td>
                  <td className="td">{x.pctAcc.toFixed(1)}%</td>
                </tr>;
              })}
            </tbody>
          </table>
        </div>
      </ChartCard>

      <div style={{ marginTop:14 }}>
        <ChartCard titulo="Resumo mensal" sub="Histórico completo (todos os meses)" flex={null}>
          <div className="tabela-wrap">
            <table className="tabela">
              <thead><tr>{["Mês","Pedidos","Faturamento","Lucro líquido","Margem"].map(function(h){ return <th key={h} className="th">{h}</th>; })}</tr></thead>
              <tbody>
                {meses.length === 0 ? <tr><td className="td" colSpan={5}>Sem vendas registradas.</td></tr> :
                meses.map(function(m,i){ var mg = m.fat ? (m.lucro/m.fat*100) : 0;
                  return <tr key={i}>
                    <td className="td" style={{ fontWeight:600, color:"var(--text-strong)" }}>{rotuloMes(m.mes)}</td>
                    <td className="td">{m.ped}</td>
                    <td className="td-num">{fmt(m.fat)}</td>
                    <td className="td-num" style={{ fontWeight:500, color: m.lucro>=0?"#0a9d4e":"#FF5252" }}>{fmt(m.lucro)}</td>
                    <td className="td" style={{ color: mg>=0?"#0a9d4e":"#FF5252" }}>{mg.toFixed(1)}%</td>
                  </tr>;
                })}
              </tbody>
            </table>
          </div>
        </ChartCard>
      </div>
    </div>
  );
}

// Contas a receber: recebíveis gerados automaticamente dos pedidos do Mercado Livre.
// Função, não constante: FIN_COR é declarado adiante no arquivo, e um objeto
// montado no carregamento do módulo tentaria lê-lo antes da hora.
function rotuloReceb(estado) {
  var m = {
    a_receber: ["A receber", FIN_COR.atencao, "o ML ainda não liberou"],
    liberado:  ["Liberado", FIN_COR.entrada, "o ML liberou · falta confirmar"],
    recebido:  ["Recebido", FIN_COR.entrada, "confirmado por você"],
    sem_dado:  ["Sem dado", FIN_COR.fraco, "o ML não informou o repasse"],
  };
  return m[estado] || ["—", FIN_COR.fraco, ""];
}

function ContasReceberTab({ enrichedOrders, paymentData, baixados, setBaixados, config, tab, setTab }) {
  const [busca, setBusca] = useState("");
  // Fica guardado: quem fecha os filtros para ganhar largura não quer reabri-los
  // a cada troca de aba.
  const [mostrarFiltros, setMostrarFiltros] = useState(function(){
    try { return localStorage.getItem("fin_filtros_ocultos") !== "1"; } catch { return true; }
  });
  function alternarFiltros(){
    setMostrarFiltros(function(v){
      var novo = !v;
      try { localStorage.setItem("fin_filtros_ocultos", novo ? "0" : "1"); } catch(e) {}
      return novo;
    });
  }
  const [mostrarAcoes, setMostrarAcoes] = useState(true);
  const [fSituacao, setFSituacao] = useState("todas");
  var cfgFin = config || financeiroConfigPadrao();
  var hoje = new Date().toISOString().slice(0,10);
  function darBaixa(id, quando){ var n = Object.assign({}, baixados); n[String(id)] = quando || hoje; setBaixados(n); }
  function estornar(id){ var n = Object.assign({}, baixados); delete n[String(id)]; setBaixados(n); }
  const [corte, setCorte] = useState(function(){ var d = new Date(); d.setDate(d.getDate()-30); return d.toISOString().slice(0,10); });

  // Quatro estados, não dois. Antes a tela só perguntava "você confirmou?", e
  // com a resposta "não" para tudo o total a receber virava o faturamento
  // histórico inteiro. O Mercado Livre já responde a pergunta que importa —
  // money_release_status e money_release_date — e o sistema tinha esse dado
  // guardado sem usar.
  //
  //   a_receber  o ML ainda NÃO liberou o dinheiro. É o contas a receber de verdade.
  //   liberado   o ML já liberou e você ainda não confirmou que caiu na conta.
  //   recebido   você confirmou.
  //   sem_dado   o ML não devolveu informação de repasse deste pedido. Não é
  //              "a receber" nem "recebido" — é não sabido, e some do total em
  //              vez de inflá-lo.
  function classificar(o, pay, baixa) {
    if (baixa) return "recebido";
    if (!pay || !pay.releaseDate) return "sem_dado";
    return pay.isReleased ? "liberado" : "a_receber";
  }
  var linhas = (enrichedOrders || []).filter(function(o){ return o.status !== "cancelled"; }).map(function(o){
    var pay = paymentData && paymentData[String(o.id)];
    // O líquido sai da MESMA conta que a tela de Vendas mostra como "Repasse do
    // marketplace": bruto menos a taxa do ML menos o frete que você paga. Antes
    // vinha do netAmount da API, que tinha três bases diferentes — sale_fee
    // real, um chute de 13%, ou o bruto puro quando não havia dado nenhum — e a
    // tela somava as três como se fossem a mesma coisa.
    var q = o.qty || 1;
    var bruto = (o.price || 0) * q;
    var taxa = (o.fee || 0) * q;
    var frete = o.freteSeller || 0;
    var valor = Math.max(0, bruto - taxa - frete);
    var baixaManual = baixados[String(o.id)] || null;
    var estado = classificar(o, pay, baixaManual);
    return {
      id:o.id, cliente:o.buyerName || "Cliente ML", origem:"Mercado Livre",
      previsao: pay && pay.releaseDate ? pay.releaseDate : "",
      dataVenda: o.date || "", bruto:bruto, taxa:taxa, frete:frete, valor:valor,
      // A taxa é real quando veio do sale_fee do pedido; senão é a tabela
      // 12%/17% por tipo de anúncio. A tela marca a diferença.
      taxaEstimada: !o.feeReal,
      estado:estado, baixaManual:baixaManual, recebido: estado === "recebido",
    };
  });
  var nTaxaEstimada = linhas.filter(function(r){ return r.taxaEstimada && r.estado !== "recebido"; }).length;
  function somaDe(est){ return linhas.filter(function(r){ return r.estado === est; }).reduce(function(s,r){ return s + r.valor; }, 0); }
  function qtdDe(est){ return linhas.filter(function(r){ return r.estado === est; }).length; }
  var aReceber = somaDe("a_receber"), liberado = somaDe("liberado");
  var recebidoTot = somaDe("recebido"), semDado = somaDe("sem_dado");

  var lista = linhas.filter(function(r){
    if (fSituacao !== "todas" && r.estado !== fSituacao) return false;
    var q = busca.trim().toLowerCase(); return !q || (r.cliente||"").toLowerCase().indexOf(q) >= 0 || String(r.id).indexOf(q) >= 0;
  });
  var valorLista = lista.reduce(function(s,r){ return s+r.valor; }, 0);
  var temFiltro = fSituacao!=="todas" || busca;

  // ── As duas automações ───────────────────────────────────────────────────
  // A data da baixa vale: é ela que o DRE em regime de caixa usa. Marcar tudo
  // com a data de hoje jogaria meses de receita para um dia só.
  function confirmarLiberados(){
    var alvo = linhas.filter(function(r){ return r.estado === "liberado"; });
    if (!alvo.length) return;
    if (!window.confirm("Confirmar " + alvo.length + " repasse(s) que o Mercado Livre já liberou, somando " +
        fmt(liberado) + "?\n\nCada um entra na data em que o ML liberou, não na data de hoje.")) return;
    var n = Object.assign({}, baixados);
    alvo.forEach(function(r){ n[String(r.id)] = r.previsao || r.dataVenda || hoje; });
    setBaixados(n);
  }
  function confirmarAntigosSemDado(){
    var alvo = linhas.filter(function(r){ return r.estado === "sem_dado" && (r.dataVenda || "") <= corte; });
    if (!alvo.length) return;
    if (!window.confirm("Considerar recebidos " + alvo.length + " pedido(s) vendidos até " + (fmtDate(corte)||corte) +
        ", somando " + fmt(alvo.reduce(function(s,r){ return s+r.valor; },0)) +
        "?\n\nO Mercado Livre não devolveu a data de repasse destes. Esta é uma decisão SUA, não uma informação do ML — cada um entra na data da venda.")) return;
    var n = Object.assign({}, baixados);
    alvo.forEach(function(r){ n[String(r.id)] = r.dataVenda || hoje; });
    setBaixados(n);
  }
  var selFiltro = { width:"100%", background:"var(--bg-2)", border:"1px solid var(--border)", color:"var(--text-2)", padding:"7px 9px", borderRadius:8, fontSize:12.5 };
  var filtBtn = { background:"var(--surface)", border:"1px solid var(--border)", color:"var(--text-2)", padding:"9px 12px", borderRadius:9, cursor:"pointer", fontSize:13, whiteSpace:"nowrap" };
  function limpar(){ setFSituacao("todas"); setBusca(""); }
  function exportar(){ baixarCSV("contas-receber",
    ["Cliente","Nº pedido","Previsão","Bruto","Taxa ML","Taxa estimada?","Frete","Líquido a receber","Situação"],
    lista.map(function(r){ return [r.cliente, r.id, r.previsao||"", r.bruto.toFixed(2), r.taxa.toFixed(2),
      r.taxaEstimada ? "sim" : "não", r.frete.toFixed(2), r.valor.toFixed(2), rotuloReceb(r.estado)[0]]; })); }
  function imprimir(){ baixarPDF("contas-a-receber",
    ["Cliente","Nº pedido","Previsão","Bruto","Taxa ML","Frete","Líquido","Situação"],
    lista.map(function(r){ return [r.cliente, "#"+r.id, r.previsao?(fmtDate(r.previsao)||r.previsao):"—",
      fmt(r.bruto), fmt(r.taxa), r.frete>0?fmt(r.frete):"—", fmt(r.valor), rotuloReceb(r.estado)[0]]; })); }
  return (
    <FinanceiroShell tab={tab} setTab={setTab} titulo="Contas a receber"
      sub="Valores líquidos: bruto menos a taxa do Mercado Livre e o frete que você paga. O que o ML ainda não liberou é o contas a receber de verdade."
      kpis={[
        { rotulo:"A receber de verdade", valor:fmt(aReceber), cor: qtdDe("a_receber") ? FIN_COR.atencao : FIN_COR.fraco,
          nota: qtdDe("a_receber") + " pedido(s) · o ML ainda não liberou" },
        { rotulo:"Liberado, falta confirmar", valor:fmt(liberado), cor: qtdDe("liberado") ? "#0a9d4e" : FIN_COR.fraco,
          nota: qtdDe("liberado") + " pedido(s) · já é dinheiro seu" },
        { rotulo:"Recebido", valor:fmt(recebidoTot), cor:FIN_COR.entrada, nota:qtdDe("recebido") + " confirmado(s)" },
        { rotulo:"Sem dado de repasse", valor:fmt(semDado), cor: qtdDe("sem_dado") ? FIN_COR.fraco : FIN_COR.fraco,
          nota: qtdDe("sem_dado") + " pedido(s) · fora das contas acima" },
      ]}
      acoes={<>
        {qtdDe("liberado") > 0 && (
          <AcaoFin tipo="pri" onClick={confirmarLiberados}>
            ✓ Confirmar {qtdDe("liberado")} liberado(s)
          </AcaoFin>
        )}
        {qtdDe("sem_dado") > 0 && (
          <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:12, padding:"12px 14px" }}>
            <div style={{ fontSize:12, fontWeight:600, color:"var(--text-strong)", marginBottom:4 }}>Pedidos sem dado de repasse</div>
            <div style={{ fontSize:11.5, color:"var(--text-3)", lineHeight:1.55, marginBottom:8 }}>
              O ML não devolveu a data de liberação de {qtdDe("sem_dado")} pedido(s). Eles ficam de fora
              das contas acima. Se são vendas antigas que você já recebeu, marque de uma vez:
            </div>
            <label style={{ fontSize:11, color:"var(--text-3)", display:"block", marginBottom:3 }}>Vendidos até</label>
            <input type="date" value={corte} onChange={function(e){ setCorte(e.target.value); }}
              style={{ width:"100%", background:"var(--bg)", border:"1px solid var(--border)", color:"var(--text-strong)", padding:"7px 9px", borderRadius:7, fontSize:12.5, boxSizing:"border-box", marginBottom:8 }} />
            <button onClick={confirmarAntigosSemDado}
              style={{ width:"100%", background:"var(--surface-3)", border:"1px solid var(--border)", color:"var(--text-2)", fontWeight:600, padding:"8px", borderRadius:8, cursor:"pointer", fontSize:12 }}>
              Considerar recebidos
            </button>
          </div>
        )}
        <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:12, padding:"6px", display:"flex", flexDirection:"column" }}>
          <button onClick={exportar} style={{ background:"none", border:"none", textAlign:"left", padding:"9px 10px", borderRadius:7, cursor:"pointer", fontSize:12.5, color:"var(--text-2)", width:"100%" }}>Exportar para planilha</button>
          <button onClick={function(){ imprimir(); }} style={{ background:"none", border:"none", textAlign:"left", padding:"9px 10px", borderRadius:7, cursor:"pointer", fontSize:12.5, color:"var(--text-2)", width:"100%" }}>Imprimir</button>
        </div>
        <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:12, padding:"12px 14px" }}>
          <div style={{ fontSize:11.5, color:"var(--text-3)" }}>Total filtrado</div>
          <div style={{ fontSize:18, fontWeight:600, color:"var(--text-strong)" }}>{fmt(valorLista)}</div>
          <div style={{ fontSize:11, color:"var(--text-4)", marginTop:2 }}>{lista.length} de {linhas.length} pedido(s)</div>
          <div style={{ fontSize:11, color:"var(--text-3)", marginTop:10, lineHeight:1.55, borderTop:"1px solid var(--border-soft)", paddingTop:8 }}>
            Confirmar é o que faz a venda virar receita no DRE e entrar no saldo dos bancos.
          </div>
          <div style={{ fontSize:11, color:"var(--text-3)", marginTop:8, lineHeight:1.55, borderTop:"1px solid var(--border-soft)", paddingTop:8 }}>
            {nTaxaEstimada > 0
              ? nTaxaEstimada + " pedido(s) usam a taxa por tipo de anúncio porque o ML não devolveu o sale_fee deles. Ficam marcados como “estimada” na coluna Taxa ML."
              : "Todas as taxas vieram do sale_fee real de cada pedido."}
          </div>
        </div>
      </>}>
      <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:12, flexWrap:"wrap" }}>
        <button onClick={alternarFiltros} style={{ ...filtBtn, background: mostrarFiltros?"rgba(118,133,146,.14)":"var(--surface)" }}>{mostrarFiltros ? "⟨ Filtros" : "⟩ Filtros"}</button>
        <div style={{ position:"relative", flex:1, minWidth:220, maxWidth:520 }}>
          <span style={{ position:"absolute", left:12, top:"50%", transform:"translateY(-50%)", color:"var(--text-3)", fontSize:13 }}>🔍</span>
          <input value={busca} onChange={function(e){ setBusca(e.target.value); }} placeholder="Pesquise por cliente ou número do pedido" style={{ width:"100%", background:"var(--surface)", border:"1px solid var(--border)", color:"var(--text-strong)", padding:"9px 12px 9px 34px", borderRadius:9, fontSize:13, outline:"none" }} />
        </div>
      </div>
      <div style={{ display:"flex", gap:12, alignItems:"flex-start" }}>
        {mostrarFiltros && (
          <div style={{ width:230, flexShrink:0, background:"var(--surface)", border:"1px solid var(--border)", borderRadius:12, padding:"14px", display:"flex", flexDirection:"column", gap:11 }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
              <span style={{ fontWeight:600, fontSize:14, color:"var(--text-strong)" }}>Filtrar</span>
              {temFiltro && <button onClick={limpar} style={{ background:"none", border:"none", color:"#768592", cursor:"pointer", fontSize:12 }}>Limpar</button>}
            </div>
            <div><div style={{ fontSize:11, color:"var(--text-3)", marginBottom:3 }}>Opção</div><select value={fSituacao} onChange={function(e){ setFSituacao(e.target.value); }} style={selFiltro}>
              <option value="todas">Todas</option>
              <option value="a_receber">A receber (ML não liberou)</option>
              <option value="liberado">Liberado, falta confirmar</option>
              <option value="recebido">Recebido</option>
              <option value="sem_dado">Sem dado de repasse</option>
            </select></div>
            <div><div style={{ fontSize:11, color:"var(--text-3)", marginBottom:3 }}>Categoria</div><select disabled style={{ ...selFiltro, opacity:.45 }}><option>Todas categorias</option></select></div>
            <button onClick={limpar} style={{ background:"none", border:"none", color:"var(--ui-accent)", fontWeight:600, cursor:"pointer", fontSize:12.5, textAlign:"left" }}>Limpar filtros</button>
          </div>
        )}
        <div style={{ flex:1, minWidth:0 }}>
          <div className="tabela-wrap">
            <table className="tabela">
              <thead><tr>{["Cliente","Nº pedido","Previsão","Bruto","Taxa ML","Frete","Líquido a receber","Situação","Ações"].map(function(h){ return <th key={h} className="th">{h}</th>; })}</tr></thead>
              <tbody>
                {lista.slice(0,500).map(function(r,i){
                  return <tr key={r.id || i}>
                    <td className="td" style={{ color:"var(--text-strong)", maxWidth:210, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{r.cliente}</td>
                    <td className="td-num">#{r.id}</td>
                    <td className="td">
                      {r.previsao ? (fmtDate(r.previsao)||r.previsao) : <span style={{ color:"var(--text-4)" }}>não informada</span>}
                      {r.estado === "recebido" && r.baixaManual && <div style={{ fontSize:10.5, color:"var(--text-4)" }}>confirmado em {fmtDate(r.baixaManual)||r.baixaManual}</div>}
                    </td>
                    <td className="td-num">{fmt(r.bruto)}</td>
                    <td className="td-num">
                      <span style={{ color:FIN_COR.saida }}>− {fmt(r.taxa)}</span>
                      {r.taxaEstimada && <div style={{ fontSize:10, color:"var(--text-4)" }} title="Sem o sale_fee do pedido: usa a taxa por tipo de anúncio.">estimada</div>}
                    </td>
                    <td className="td-num">{r.frete > 0 ? <span style={{ color:FIN_COR.saida }}>− {fmt(r.frete)}</span> : <span style={{ color:"var(--text-4)" }}>—</span>}</td>
                    <td className="td-num" style={{ fontWeight:700 }}>{fmt(r.valor)}</td>
                    <td className="td">
                      <span title={rotuloReceb(r.estado)[2]} style={{ fontSize:11, fontWeight:600, padding:"2px 9px", borderRadius:20, background:"var(--surface-3)", color:rotuloReceb(r.estado)[1] }}>{rotuloReceb(r.estado)[0]}</span>
                    </td>
                    <td className="td" style={{ whiteSpace:"nowrap" }}>
                      {r.estado === "recebido"
                        ? <button onClick={function(){ estornar(r.id); }} style={{ background:"var(--surface-3)", border:"none", color:"var(--text-2)", fontSize:11, fontWeight:600, padding:"4px 10px", borderRadius:6, cursor:"pointer" }}>Estornar</button>
                        : <button onClick={function(){ darBaixa(r.id, r.previsao || r.dataVenda); }} style={{ background:"rgba(10,157,78,.12)", border:"none", color:"var(--ui-accent)", fontSize:11, fontWeight:600, padding:"4px 10px", borderRadius:6, cursor:"pointer" }}>Confirmar</button>}
                    </td>
                  </tr>;
                })}
              </tbody>
            </table>
            {lista.length === 0 && <VazioFin icone="⬆️"
              titulo={temFiltro ? "Nenhum recebível com esses filtros." : "Nenhuma venda para receber."}
              texto={temFiltro
                ? "Limpe os filtros para ver todos os recebíveis."
                : "Os repasses aparecem aqui conforme as vendas do Mercado Livre são sincronizadas."} />}
          </div>
        </div>
      </div>
    </FinanceiroShell>
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
      <div style={{ fontWeight:600, fontSize:20, color:"var(--text-strong)" }}>Clientes</div>
      <div style={{ fontSize:13, color:"var(--text-3)", marginBottom:14 }}>Cadastrados automaticamente dos compradores do Mercado Livre.</div>
      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(170px,1fr))", gap:12, marginBottom:14 }}>
        {kpis.map(function(k,i){ return <div key={i} className="kpi"><div className="kpi-rot">{k.l}</div><div className="kpi-val" style={{ color:k.c }}>{k.v}</div></div>; })}
      </div>
      <div style={{ display:"flex", gap:6, marginBottom:10, flexWrap:"wrap" }}>
        {filtros.map(function(f){ var a = filtro === f[0]; return <button key={f[0]} onClick={function(){ setFiltro(f[0]); }} style={{ padding:"7px 14px", borderRadius:8, border:"1px solid var(--border)", cursor:"pointer", fontSize:12, fontWeight:600, background: a ? "#768692" : "var(--surface)", color: a ? "#fff" : "var(--text-3)" }}>{f[1]}</button>; })}
      </div>
      <input value={busca} onChange={function(e){ setBusca(e.target.value); }} placeholder="Buscar por nome ou documento..." className="busca" />
      <div className="tabela-wrap">
        <table className="tabela">
          <thead><tr>{["Cliente","Documento","Cidade/UF","Pedidos","Total gasto","Última compra","Perfil"].map(function(h){ return <th key={h} className="th">{h}</th>; })}</tr></thead>
          <tbody>
            {lista.slice(0,400).map(function(c,i){
              return <tr key={i}>
                <td className="td" style={{ color:"var(--text-strong)", fontWeight:500 }}>{c.nome}</td>
                <td className="td-num">{c.doc}</td>
                <td className="td">{c.local}</td>
                <td className="td">{c.pedidos}</td>
                <td className="td" style={{ fontWeight:500 }}>{fmt(c.total)}</td>
                <td className="td">{c.ultima || "—"}</td>
                <td className="td"><span style={{ fontSize:11, fontWeight:500, padding:"2px 8px", borderRadius:20, background: c.recorrente ? "rgba(0,200,83,.14)" : "var(--surface-3)", color: c.recorrente ? "#0a9d4e" : "var(--text-3)" }}>{c.recorrente ? "Recorrente" : "Único"}</span></td>
              </tr>;
            })}
          </tbody>
        </table>
        {lista.length === 0 && <div style={{ padding:24, textAlign:"center", color:"var(--text-3)" }}>Nenhum cliente.</div>}
      </div>
    </div>
  );
}

// Rótulo da linha de imposto no detalhamento: mostra a alíquota efetiva daquele pedido,
// que muda conforme o estado de entrega (ICMS interno x interestadual).
function rotuloImposto(o) {
  var pct = parseFloat((o || {}).impostoPct);
  if (!isFinite(pct) || pct <= 0) return "Imposto";
  // Quando o ICMS veio da Precificação daquele anúncio, dizer "UF" enganaria:
  // a alíquota não saiu do destino, saiu do que foi preenchido no produto.
  var origem = (o || {}).icmsProprio
    ? "ICMS do anúncio"
    : String((o || {}).buyerUF || "").toUpperCase();
  return "Imposto (" + pct.toFixed(2).replace(".", ",") + "%" + (origem ? " · " + origem : "") + ")";
}

// Vendas: cada venda com custos/taxas do momento; clicar abre o painel com o detalhamento completo.
function VendasTab({ enrichedOrders }) {
  const [sel, setSel] = useState(null);
  const [situacao, setSituacao] = useState("todas");
  function calc(o){
    var q = o.qty || 1;
    var fat = (o.price || 0) * q, taxas = (o.fee || 0) * q, frete = o.freteSeller || 0;
    var custo = (o.cost || 0) * q, imposto = (o.imposto || 0) * q;
    // Etiqueta e embalagem vêm da Precificação daquele anúncio e são por unidade.
    var etiqueta = (o.etiqueta || 0) * q, embalagem = (o.embalagem || 0) * q;
    var repasse = fat - taxas - frete, lucro = repasse - custo - imposto - etiqueta - embalagem;
    return { q, fat, taxas, frete, custo, imposto, etiqueta, embalagem, repasse, lucro,
             margem: fat ? lucro / fat * 100 : 0, rotuloImp: rotuloImposto(o) };
  }
  var lista = (enrichedOrders || []).filter(function(o){
    if (situacao === "ativas") return o.status !== "cancelled";
    if (situacao === "canceladas") return o.status === "cancelled";
    return true;
  }).slice().sort(function(a,b){ return (b.date || "").localeCompare(a.date || ""); });
  var filtros = [["todas","Todas"],["ativas","Ativas"],["canceladas","Canceladas"]];
  function Linha(label, valor, opts){
    opts = opts || {};
    return <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"9px 0", borderBottom: opts.forte ? "none" : "1px solid var(--border-soft)" }}>
      <span style={{ fontSize: opts.forte ? 14 : 13, fontWeight: opts.forte ? 800 : 500, color: opts.forte ? "var(--text-strong)" : "var(--text-3)" }}>{label}</span>
      <span style={{ fontSize: opts.forte ? 15 : 13, fontWeight: opts.forte ? 800 : 600, color: opts.cor || "var(--text-2)", fontVariantNumeric:"tabular-nums" }}>{valor}</span>
    </div>;
  }
  return (
    <div style={{ padding:2 }}>
      <div style={{ fontWeight:600, fontSize:20, color:"var(--text-strong)" }}>Vendas</div>
      <div style={{ fontSize:13, color:"var(--text-3)", marginBottom:14 }}>Cada venda guarda os custos e taxas do momento. Clique para ver o detalhamento.</div>
      <div style={{ display:"flex", gap:6, marginBottom:12 }}>
        {filtros.map(function(f){ var a = situacao === f[0]; return <button key={f[0]} onClick={function(){ setSituacao(f[0]); }} style={{ padding:"7px 14px", borderRadius:8, border:"1px solid var(--border)", cursor:"pointer", fontSize:12, fontWeight:600, background: a ? "#768692" : "var(--surface)", color: a ? "#fff" : "var(--text-3)" }}>{f[1]}</button>; })}
      </div>
      <div className="tabela-wrap">
        <table className="tabela">
          <thead><tr>{["Data","Código MLB","SKU","Anúncio","Qtd","Faturamento","Lucro","Margem"].map(function(h){ return <th key={h} className="th">{h}</th>; })}</tr></thead>
          <tbody>
            {lista.slice(0,400).map(function(o,i){
              var c = calc(o);
              return <tr key={o.id || i} onClick={function(){ setSel(o); }} style={{ cursor:"pointer" }}>
                <td className="td">{o.date || "—"}</td>
                <td className="td-num">{o.listing_id || o.id}</td>
                <td className="td-num">{o.sku || "—"}</td>
                <td className="td" style={{ maxWidth:240, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", color:"var(--text-strong)" }}>{o.title || "—"}</td>
                <td className="td">{c.q}</td>
                <td className="td">{fmt(c.fat)}</td>
                <td className="td" style={{ fontWeight:500, color: c.lucro >= 0 ? "#0a9d4e" : "#FF5252" }}>{fmt(c.lucro)}</td>
                <td className="td" style={{ color: c.margem >= 0 ? "#0a9d4e" : "#FF5252" }}>{c.margem.toFixed(1)}%</td>
              </tr>;
            })}
          </tbody>
        </table>
        {lista.length === 0 && <div style={{ padding:24, textAlign:"center", color:"var(--text-3)" }}>Nenhuma venda.</div>}
      </div>

      {sel && (function(){
        var c = calc(sel);
        return <>
          <div onClick={function(){ setSel(null); }} style={{ position:"fixed", inset:0, background:"rgba(0,0,0,.4)", zIndex:400 }} />
          <div style={{ position:"fixed", top:0, right:0, bottom:0, width:440, maxWidth:"100vw", background:"var(--bg-2)", borderLeft:"1px solid var(--border)", boxShadow:"-8px 0 32px rgba(0,0,0,.28)", zIndex:401, overflowY:"auto", padding:"22px 24px" }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", gap:12, marginBottom:4 }}>
              <div style={{ fontWeight:600, fontSize:17, color:"var(--text-strong)", lineHeight:1.3 }}>{sel.title || "Venda"}</div>
              <button onClick={function(){ setSel(null); }} style={{ background:"none", border:"none", color:"var(--text-3)", fontSize:22, cursor:"pointer", lineHeight:1, flexShrink:0 }}>×</button>
            </div>
            <div style={{ fontSize:12, color:"var(--text-3)", marginBottom:16 }}>Venda de {sel.date || "—"} · Mercado Livre</div>

            <div style={{ fontSize:11, fontWeight:500, color:"var(--text-3)", textTransform:"none", letterSpacing:.5, margin:"6px 0 2px" }}>Identificação</div>
            {Linha("Código MLB", sel.listing_id || sel.id)}
            {Linha("SKU", sel.sku || "—")}
            {Linha("Quantidade", String(c.q))}
            {Linha("Situação", sel.status === "cancelled" ? "Cancelada" : "Ativa", { cor: sel.status === "cancelled" ? "#FF5252" : "#0a9d4e" })}

            <div style={{ fontSize:11, fontWeight:500, color:"var(--text-3)", textTransform:"none", letterSpacing:.5, margin:"16px 0 2px" }}>Descontos do marketplace</div>
            {Linha("Taxas do marketplace", "- " + fmt(c.taxas), { cor:"#FFC107" })}
            {Linha("Frete pago por você", "- " + fmt(c.frete), { cor:"#FFC107" })}
            <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:10, padding:"10px 14px", margin:"10px 0" }}>
              {Linha("Repasse do marketplace", fmt(c.repasse), { forte:true, cor:"var(--text-strong)" })}
            </div>

            <div style={{ fontSize:11, fontWeight:500, color:"var(--text-3)", textTransform:"none", letterSpacing:.5, margin:"6px 0 2px" }}>Seus custos</div>
            {Linha("Custo do produto", "- " + fmt(c.custo), { cor:"#FFC107" })}
            {Linha(c.rotuloImp, "- " + fmt(c.imposto), { cor:"#FFC107" })}
            {c.etiqueta > 0 && Linha("Etiqueta", "- " + fmt(c.etiqueta), { cor:"#FFC107" })}
            {c.embalagem > 0 && Linha("Embalagem", "- " + fmt(c.embalagem), { cor:"#FFC107" })}
            <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:10, padding:"12px 14px", marginTop:12 }}>
              {Linha("Lucro líquido", fmt(c.lucro) + "  (" + c.margem.toFixed(1) + "%)", { forte:true, cor: c.lucro >= 0 ? "#0a9d4e" : "#FF5252" })}
            </div>
          </div>
        </>;
      })()}
    </div>
  );
}

// Título de seção usado dentro do drawer de detalhes do pedido.
var _secTit = { fontSize:11, fontWeight:500, color:"var(--text-3)", textTransform:"none", letterSpacing:.5, margin:"16px 0 2px" };

// Drawer lateral com o detalhamento de uma venda (aberto ao clicar numa linha da aba Vendas).
function PedidoDetalheDrawer({ pedido, onClose }) {
  if (!pedido) return null;
  var o = pedido;
  var q = o.qty || 1;
  var fat = (o.price || 0) * q, taxas = (o.fee || 0) * q, frete = o.freteSeller || 0;
  var custo = (o.cost || 0) * q, imposto = (o.imposto || 0) * q;
  // Custos por unidade preenchidos na Precificação deste anúncio.
  var etiqueta = (o.etiqueta || 0) * q, embalagem = (o.embalagem || 0) * q;
  var repasse = fat - taxas - frete, lucro = repasse - custo - imposto - etiqueta - embalagem;
  var margem = fat ? lucro / fat * 100 : 0;
  function Linha(label, valor, opts){
    opts = opts || {};
    return <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", gap:12, padding:"9px 0", borderBottom: opts.forte ? "none" : "1px solid var(--border-soft)" }}>
      <span style={{ fontSize: opts.forte ? 14 : 13, fontWeight: opts.forte ? 800 : 500, color: opts.forte ? "var(--text-strong)" : "var(--text-3)" }}>{label}</span>
      <span style={{ fontSize: opts.forte ? 15 : 13, fontWeight: opts.forte ? 800 : 600, color: opts.cor || "var(--text-2)", fontVariantNumeric:"tabular-nums", textAlign:"right", wordBreak:"break-word" }}>{valor}</span>
    </div>;
  }
  var temCliente = o.buyerName || o.buyerDoc || o.buyerEmail || o.buyerCity;
  return <>
    <div onClick={onClose} style={{ position:"fixed", inset:0, background:"rgba(0,0,0,.4)", zIndex:400 }} />
    <div style={{ position:"fixed", top:0, right:0, bottom:0, width:460, maxWidth:"100vw", background:"var(--bg-2)", borderLeft:"1px solid var(--border)", boxShadow:"-8px 0 32px rgba(0,0,0,.28)", zIndex:401, overflowY:"auto", padding:"22px 24px" }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", gap:12, marginBottom:4 }}>
        <div style={{ fontWeight:600, fontSize:17, color:"var(--text-strong)", lineHeight:1.3 }}>{o.title || "Venda"}</div>
        <button onClick={onClose} style={{ background:"none", border:"none", color:"var(--text-3)", fontSize:22, cursor:"pointer", lineHeight:1, flexShrink:0 }}>×</button>
      </div>
      <div style={{ fontSize:12, color:"var(--text-3)", marginBottom:16 }}>Pedido #{o.id} · {fmtDate(o.date) || o.date || "—"} · Mercado Livre</div>

      <div style={_secTit}>Identificação</div>
      {Linha("Código MLB", o.listing_id || o.id)}
      {Linha("SKU", o.sku || "—")}
      {Linha("Quantidade", String(q))}
      {Linha("Faturamento", fmt(fat), { cor:"var(--text-strong)" })}
      {Linha("Situação", o.status === "cancelled" ? "Cancelada" : "Ativa", { cor: o.status === "cancelled" ? "#FF5252" : "#0a9d4e" })}

      {temCliente && <>
        <div style={_secTit}>Cliente</div>
        {o.buyerName && Linha("Nome", o.buyerName, { cor:"var(--text-strong)" })}
        {o.buyerDoc && Linha(o.buyerDocType || "Documento", o.buyerDoc)}
        {o.buyerEmail && Linha("E-mail", o.buyerEmail)}
        {o.buyerPhone && Linha("Telefone", o.buyerPhone)}
        {(o.buyerCity || o.buyerUF) && Linha("Cidade/UF", (o.buyerCity || "") + (o.buyerUF ? " - " + o.buyerUF : ""))}
      </>}

      <div style={_secTit}>Descontos do marketplace</div>
      {Linha("Taxas do marketplace", "- " + fmt(taxas), { cor:"#FFC107" })}
      {Linha("Frete pago por você", "- " + fmt(frete), { cor:"#FFC107" })}
      <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:10, padding:"10px 14px", margin:"10px 0" }}>
        {Linha("Repasse do marketplace", fmt(repasse), { forte:true, cor:"var(--text-strong)" })}
      </div>

      <div style={_secTit}>Seus custos</div>
      {Linha("Custo do produto", "- " + fmt(custo), { cor:"#FFC107" })}
      {Linha(rotuloImposto(o), "- " + fmt(imposto), { cor:"#FFC107" })}
      {etiqueta > 0 && Linha("Etiqueta", "- " + fmt(etiqueta), { cor:"#FFC107" })}
      {embalagem > 0 && Linha("Embalagem", "- " + fmt(embalagem), { cor:"#FFC107" })}
      {etiqueta === 0 && embalagem === 0 && <div style={{ fontSize:11, color:"var(--text-3)", padding:"6px 0" }}>Etiqueta e embalagem: preencha em Precificação para entrarem nesta conta.</div>}
      <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:10, padding:"12px 14px", marginTop:12 }}>
        {Linha("Lucro líquido", fmt(lucro) + "  (" + margem.toFixed(1) + "%)", { forte:true, cor: lucro >= 0 ? "#0a9d4e" : "#FF5252" })}
      </div>
      {custo === 0 && <div style={{ marginTop:12, fontSize:12, color:"var(--text-3)", background:"var(--surface)", border:"1px solid var(--border)", borderRadius:10, padding:"10px 12px" }}>Sem custo cadastrado para este produto — o lucro considera custo R$ 0,00.</div>}
    </div>
  </>;
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
    { l:"Enviados", v:String(cont.enviado), c:"#768692" },
    { l:"Entregues", v:String(cont.entregue), c:"#0a9d4e" },
  ];
  var badge = { aenviar:["#FFC107","rgba(255,193,7,.14)","A enviar"], enviado:["#768692","rgba(118,134,146,.14)","Enviado"], entregue:["#0a9d4e","rgba(0,200,83,.14)","Entregue"], problema:["#FF5252","rgba(255,82,82,.14)","Problema"], sem:["var(--text-3)","var(--surface-3)","—"] };
  var filtros = [["todos","Todos"],["aenviar","A enviar"],["enviado","Enviados"],["entregue","Entregues"]];
  return (
    <div style={{ padding:2 }}>
      <div style={{ fontWeight:600, fontSize:20, color:"var(--text-strong)" }}>Expedição</div>
      <div style={{ fontSize:13, color:"var(--text-3)", marginBottom:14 }}>Status de envio dos pedidos.</div>
      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(150px,1fr))", gap:12, marginBottom:14 }}>
        {kpis.map(function(k,i){ return <div key={i} className="kpi"><div className="kpi-rot">{k.l}</div><div className="kpi-val" style={{ color:k.c }}>{k.v}</div></div>; })}
      </div>
      <div style={{ display:"flex", gap:6, marginBottom:12, flexWrap:"wrap" }}>
        {filtros.map(function(f){ var a = filtro === f[0]; return <button key={f[0]} onClick={function(){ setFiltro(f[0]); }} style={{ padding:"7px 14px", borderRadius:8, border:"1px solid var(--border)", cursor:"pointer", fontSize:12, fontWeight:600, background: a ? "#768692" : "var(--surface)", color: a ? "#fff" : "var(--text-3)" }}>{f[1]}</button>; })}
      </div>
      <div className="tabela-wrap">
        <table className="tabela">
          <thead><tr>{["Data","Pedido","Produto","SKU","Qtd","UF","Frete","Envio"].map(function(h){ return <th key={h} className="th">{h}</th>; })}</tr></thead>
          <tbody>
            {lista.slice(0,400).map(function(o,i){
              var b = badge[categoria(o.shipment_status)];
              return <tr key={o.id || i}>
                <td className="td">{o.date || "—"}</td>
                <td className="td-num">{o.id}</td>
                <td className="td" style={{ maxWidth:260, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", color:"var(--text-strong)" }}>{o.title || "—"}</td>
                <td className="td-num">{o.sku || "—"}</td>
                <td className="td">{o.qty || 1}</td>
                <td className="td">{o.buyerUF || "—"}</td>
                <td className="td">{o.seller_shipping_cost > 0 ? fmt(o.seller_shipping_cost) : "—"}</td>
                <td className="td"><span style={{ fontSize:11, fontWeight:500, padding:"2px 8px", borderRadius:20, background:b[1], color:b[0] }}>{b[2]}</span></td>
              </tr>;
            })}
          </tbody>
        </table>
        {lista.length === 0 && <div style={{ padding:24, textAlign:"center", color:"var(--text-3)" }}>Nenhum pedido neste filtro.</div>}
      </div>
    </div>
  );
}


// ════════════════════════════════════════════════════════════
//  TENDÊNCIAS POR CATEGORIA
//  Equivale à análise que hoje é feita na tela do Mercado Livre, com uma diferença
//  que muda a leitura: aqui os números são os SEUS, tirados dos pedidos já
//  sincronizados. O painel do ML estima o mercado inteiro; este mostra o que a sua
//  operação de fato vendeu — e é sobre isso que se decide preço e compra.
// ════════════════════════════════════════════════════════════

function TendenciasTab({ setTab, setBuscaPrecificacao, enriched }) {
  const [dias, setDias] = useState(30);
  const [dados, setDados] = useState(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState("");
  const [aberta, setAberta] = useState(null);
  // Painel de mercado por categoria: { carregando, dados, erro } por id.
  const [mercadoCat, setMercadoCat] = useState({});
  const [mercadoAberto, setMercadoAberto] = useState(null);

  function carregarMercado(id, forcar) {
    setMercadoAberto(id);
    setMercadoCat(function(m){ return Object.assign({}, m, { [id]: { carregando:true } }); });
    fetch("/api/ml/_mercado?categoria=" + id + (forcar ? "&atualizar=1" : ""))
      .then(function(r){
        return r.json()
          .then(function(d){ return { ok:r.ok, d:d }; })
          .catch(function(){ return { ok:false, d:{ error:"O servidor respondeu com erro (HTTP " + r.status + ")." } }; });
      })
      .then(function(x){
        setMercadoCat(function(m){
          return Object.assign({}, m, { [id]: x.ok ? { dados:x.d } : { erro: x.d.error || "Falhou." } });
        });
      })
      .catch(function(){
        setMercadoCat(function(m){ return Object.assign({}, m, { [id]: { erro:"Sem conexão com o servidor." } }); });
      });
  }
  // Comparação: um concorrente do ranking contra um anúncio do usuário.
  const [comparacao, setComparacao] = useState(null); // { concorrenteId, categoriaId, meuId, carregando, dados, erro }

  function meusDaCategoria(categoriaId) {
    var lista = (enriched || []).filter(function(l){ return l.status === "active"; });
    var daCategoria = lista.filter(function(l){ return l.category_id === categoriaId; });
    // Sem anúncio na mesma categoria, oferece todos — comparar com algo parecido
    // ainda é melhor que não comparar.
    var candidatos = daCategoria.length ? daCategoria : lista;
    return candidatos.slice().sort(function(a,b){ return (b.sold_quantity||0) - (a.sold_quantity||0); });
  }

  function abrirComparacao(concorrenteId, categoriaId, meuId) {
    var meus = meusDaCategoria(categoriaId);
    var meu = meuId || (meus[0] && meus[0].id);
    if (!meu) {
      setComparacao({ concorrenteId, categoriaId, erro: "Você não tem anúncio ativo para comparar." });
      return;
    }
    setComparacao({ concorrenteId, categoriaId, meuId: meu, carregando: true });
    fetch("/api/ml/_comparar?itens=" + concorrenteId + "," + meu)
      .then(function(r){
        return r.json()
          .then(function(d){ return { ok:r.ok, d:d }; })
          .catch(function(){ return { ok:false, d:{ error:"O servidor respondeu com erro (HTTP " + r.status + ")." } }; });
      })
      .then(function(x){
        setComparacao(function(c){
          if (!c || c.concorrenteId !== concorrenteId) return c;
          return x.ok
            ? { concorrenteId, categoriaId, meuId: meu, dados: x.d.anuncios }
            : { concorrenteId, categoriaId, meuId: meu, erro: x.d.error || "Falhou." };
        });
      })
      .catch(function(){
        setComparacao(function(c){
          if (!c || c.concorrenteId !== concorrenteId) return c;
          return { concorrenteId, categoriaId, meuId: meu, erro: "Sem conexão com o servidor." };
        });
      });
  }

  // Score de qualidade com os mesmos critérios da tela de Anúncios, alimentado
  // pelos campos que a comparação traz (a descrição vem como tamanho em caracteres).
  function scoreComparacao(a) {
    return calcQualityScore({
      title: a.titulo || "",
      pictures: new Array(a.fotos || 0),
      description: { plain_text: "x".repeat(a.descricaoTamanho || 0) },
      shipping: { free_shipping: a.freteGratis },
      attributes: new Array(a.atributos || 0),
      condition: a.condicao,
    });
  }

  // Descoberta do que a API do ML oferece de dados de MERCADO (além dos seus
  // próprios números). Fica aqui, num botão, em vez de exigir abrir um endereço
  // solto no navegador para depois copiar o resultado.
  const [mercado, setMercado] = useState(null);
  const [checandoMercado, setChecandoMercado] = useState(false);

  function checarMercado() {
    setChecandoMercado(true); setMercado(null);
    fetch("/api/ml/_descobrir_tendencias")
      .then(function(r){
        return r.json()
          .then(function(d){ return { ok:r.ok, d:d }; })
          .catch(function(){ return { ok:false, d:{ error:"O servidor respondeu com erro (HTTP " + r.status + ")." } }; });
      })
      .then(function(x){ setMercado(x.ok ? x.d : { erro: x.d.error || "Falhou." }); })
      .catch(function(){ setMercado({ erro: "Sem conexão com o servidor." }); })
      .finally(function(){ setChecandoMercado(false); });
  }

  useEffect(function(){
    let cancelado = false;
    setCarregando(true); setErro("");
    fetch("/api/ml/_tendencias?dias=" + dias)
      .then(function(r){ return r.json().then(function(d){ return { ok:r.ok, d:d }; }); })
      .then(function(x){
        if (cancelado) return;
        if (!x.ok) { setErro(x.d.error || "Não foi possível carregar as tendências."); setDados(null); }
        else setDados(x.d);
      })
      .catch(function(){ if (!cancelado) setErro("Sem conexão com o servidor."); })
      .finally(function(){ if (!cancelado) setCarregando(false); });
    return function(){ cancelado = true; };
  }, [dias]);

  function Variacao({ pct }) {
    // Sem base de comparação não se inventa 0%: dizer "estável" seria mentira.
    if (pct === null || pct === undefined) {
      return <span style={{ fontSize:11, color:"var(--text-3)" }}>sem base anterior</span>;
    }
    var sobe = pct >= 0;
    var cor = Math.abs(pct) < 1 ? "var(--text-3)" : sobe ? "#0a9d4e" : "#FF5252";
    var fundo = Math.abs(pct) < 1 ? "var(--bg-2)" : sobe ? "rgba(10,157,78,.12)" : "rgba(255,82,82,.12)";
    return (
      <span style={{ fontSize:12, fontWeight:600, color:cor, background:fundo, padding:"3px 9px", borderRadius:20, whiteSpace:"nowrap" }}>
        {sobe ? "▲" : "▼"} {Math.abs(pct).toFixed(1)}%
      </span>
    );
  }

  var periodos = [[7,"7 dias"],[30,"30 dias"],[90,"90 dias"]];

  return (
    <div style={{ padding:"0 20px" }}>
      <div style={{ padding:"12px 0 10px", borderBottom:"1px solid var(--border)", display:"flex", justifyContent:"space-between", alignItems:"flex-start", gap:16, flexWrap:"wrap" }}>
        <div>
          <div style={{ fontWeight:600, fontSize:20, color:"var(--text-strong)", marginBottom:4 }}>📈 Tendências por categoria</div>
          <div style={{ fontSize:13, color:"var(--text-2)" }}>
            O que cada categoria vendeu no período, comparado com o período anterior de mesmo tamanho.
          </div>
        </div>
        <div style={{ display:"flex", gap:4, background:"var(--bg-2)", border:"1px solid var(--border)", borderRadius:10, padding:3 }}>
          {periodos.map(function(p){
            var ativo = dias === p[0];
            return (
              <button key={p[0]} onClick={function(){ setDias(p[0]); }}
                style={{ padding:"7px 14px", borderRadius:8, border:"none", cursor:"pointer", fontSize:12.5, fontFamily:"inherit",
                  fontWeight: ativo ? 600 : 500,
                  background: ativo ? "var(--surface)" : "transparent",
                  color: ativo ? "var(--text-strong)" : "var(--text-3)" }}>
                {p[1]}
              </button>
            );
          })}
        </div>
      </div>

      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", gap:12, margin:"10px 0 14px", flexWrap:"wrap" }}>
        <div style={{ fontSize:11.5, color:"var(--text-3)", lineHeight:1.5, flex:"1 1 420px" }}>
          Estes números são os <b>seus</b>, calculados a partir dos pedidos sincronizados do Mercado Livre —
          não são a estimativa de mercado que aparece no painel do ML.
        </div>
        <button onClick={checarMercado} disabled={checandoMercado}
          title="Pergunta à API do Mercado Livre quais dados de mercado ela disponibiliza"
          style={{ fontSize:11.5, fontWeight:600, color:"var(--text-2)", background:"var(--bg-2)", border:"1px solid var(--border)", padding:"6px 12px", borderRadius:8, cursor: checandoMercado ? "wait" : "pointer", fontFamily:"inherit", flexShrink:0 }}>
          {checandoMercado ? "Consultando o ML…" : "Testar dados de mercado do ML"}
        </button>
      </div>

      {mercado && (
        <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:12, padding:"12px 16px", marginBottom:14 }}>
          <div style={{ fontWeight:600, fontSize:13.5, color:"var(--text-strong)", marginBottom:6 }}>
            O que a API do Mercado Livre respondeu
          </div>
          {mercado.erro
            ? <div style={{ fontSize:12.5, color:"#FF5252" }}>{mercado.erro}</div>
            : <>
                <div style={{ fontSize:11.5, color:"var(--text-3)", marginBottom:8 }}>
                  Testado com a categoria {mercado.categoriaTestada}. Mande esta lista para o Claude — é com ela
                  que dá para saber quais dados de mercado existem de verdade.
                </div>
                {(mercado.achados || []).map(function(a, i){
                  return (
                    <div key={i} style={{ display:"flex", gap:10, alignItems:"flex-start", padding:"7px 0", borderBottom:"1px solid var(--border-soft)", fontSize:12 }}>
                      <span style={{ flexShrink:0 }}>{a.ok ? "✓" : "✕"}</span>
                      <span style={{ width:190, flexShrink:0, color:"var(--text-strong)" }}>{a.rotulo}</span>
                      <span style={{ color: a.ok ? "var(--text-2)" : "#FF5252", wordBreak:"break-all", lineHeight:1.5 }}>
                        {a.erro ? a.erro : "HTTP " + a.status + (a.chaves ? " · campos: " + a.chaves.slice(0, 8).join(", ") : "")}
                      </span>
                    </div>
                  );
                })}
              </>}
        </div>
      )}

      {carregando && <div style={{ padding:"40px 0", textAlign:"center", color:"var(--text-3)", fontSize:13 }}>Calculando…</div>}

      {erro && !carregando && (
        <div style={{ background:"rgba(255,82,82,.10)", border:"1px solid rgba(255,82,82,.4)", borderRadius:10, padding:"11px 14px", fontSize:12.5, color:"var(--text-2)" }}>
          <b style={{ color:"#FF5252" }}>Tendências:</b> {erro}
        </div>
      )}

      {!carregando && !erro && dados && dados.categorias.length === 0 && (
        <div style={{ padding:"40px 0", textAlign:"center", color:"var(--text-3)", fontSize:13 }}>
          Nenhuma venda no período. Experimente um período maior.
        </div>
      )}

      {comparacao && (function(){
        var cmp = comparacao;
        var meus = meusDaCategoria(cmp.categoriaId);
        var colunas = cmp.dados || [];
        var concorrente = colunas.find(function(a){ return !a.seu; });
        var meu = colunas.find(function(a){ return a.seu; }) || colunas[1];
        function Linha(rotulo, f, destaqueMelhor) {
          var va = concorrente ? f(concorrente) : null;
          var vb = meu ? f(meu) : null;
          return (
            <div style={{ display:"grid", gridTemplateColumns:"140px 1fr 1fr", gap:10, padding:"8px 0", borderBottom:"1px solid var(--border-soft)", fontSize:12.5, alignItems:"center" }}>
              <span style={{ color:"var(--text-3)" }}>{rotulo}</span>
              <span style={{ color:"var(--text-strong)" }}>{va == null || va === "" ? "—" : va}</span>
              <span style={{ color:"var(--text-strong)" }}>{vb == null || vb === "" ? "—" : vb}</span>
            </div>
          );
        }
        return (
          <div onClick={function(){ setComparacao(null); }}
            style={{ position:"fixed", inset:0, background:"rgba(15,23,42,.55)", backdropFilter:"blur(3px)", zIndex:700, display:"flex", alignItems:"center", justifyContent:"center", padding:16 }}>
            <div onClick={function(e){ e.stopPropagation(); }}
              style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:16, width:760, maxWidth:"100%", maxHeight:"90vh", overflowY:"auto", padding:"20px 24px" }}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:4 }}>
                <div style={{ fontWeight:600, fontSize:16, color:"var(--text-strong)" }}>⚖️ Comparar anúncios</div>
                <button onClick={function(){ setComparacao(null); }}
                  style={{ background:"var(--surface-3)", border:"none", color:"var(--text-2)", width:30, height:30, borderRadius:8, cursor:"pointer", fontSize:15 }}>✕</button>
              </div>

              <div style={{ display:"flex", alignItems:"center", gap:8, margin:"8px 0 14px", flexWrap:"wrap" }}>
                <span style={{ fontSize:12, color:"var(--text-3)" }}>Comparar com o meu anúncio:</span>
                <select value={cmp.meuId || ""} onChange={function(e){ abrirComparacao(cmp.concorrenteId, cmp.categoriaId, e.target.value); }}
                  style={{ flex:1, minWidth:220, background:"var(--bg-2)", border:"1px solid var(--border)", color:"var(--text-strong)", padding:"7px 10px", borderRadius:8, fontSize:12.5, outline:"none", cursor:"pointer" }}>
                  {meus.map(function(l){
                    return <option key={l.id} value={l.id}>{(l.title || l.id).slice(0, 70)}</option>;
                  })}
                </select>
              </div>

              {cmp.carregando && <div style={{ padding:"24px 0", textAlign:"center", color:"var(--text-3)", fontSize:13 }}>Buscando os dois anúncios no ML…</div>}
              {cmp.erro && <div style={{ padding:"12px 0", color:"#FF5252", fontSize:12.5 }}>{cmp.erro}</div>}

              {!cmp.carregando && !cmp.erro && concorrente && meu && (function(){
                var problema = concorrente.erro || meu.erro;
                if (problema) return <div style={{ padding:"12px 0", color:"#FF5252", fontSize:12.5 }}>{problema}</div>;
                var sa = scoreComparacao(concorrente), sb = scoreComparacao(meu);
                var difPreco = (concorrente.preco != null && meu.preco != null) ? meu.preco - concorrente.preco : null;
                return (
                  <>
                    <div style={{ display:"grid", gridTemplateColumns:"140px 1fr 1fr", gap:10, padding:"6px 0 10px", fontSize:12, fontWeight:700 }}>
                      <span />
                      <span style={{ color:"#FFC107" }}>CONCORRENTE</span>
                      <span style={{ color:"#0a9d4e" }}>SEU ANÚNCIO</span>
                    </div>
                    {Linha("Título", function(a){ return a.titulo; })}
                    {Linha("Preço", function(a){ return a.preco != null ? fmt(a.preco) : null; })}
                    {difPreco != null && (
                      <div style={{ fontSize:12, padding:"7px 0", color: difPreco > 0 ? "#FF9800" : "#0a9d4e", borderBottom:"1px solid var(--border-soft)" }}>
                        {difPreco > 0
                          ? "O seu está " + fmt(Math.abs(difPreco)) + " mais caro que este concorrente."
                          : difPreco < 0
                            ? "O seu está " + fmt(Math.abs(difPreco)) + " mais barato que este concorrente."
                            : "Mesmo preço."}
                      </div>
                    )}
                    {Linha("Vendidos", function(a){ return a.vendidos != null ? a.vendidos.toLocaleString("pt-BR") : null; })}
                    {Linha("Fotos", function(a){ return a.fotos; })}
                    {Linha("Atributos", function(a){ return a.atributos; })}
                    {Linha("Frete grátis", function(a){ return a.freteGratis ? "Sim" : "Não"; })}
                    {Linha("Descrição", function(a){ return a.descricaoTamanho ? a.descricaoTamanho.toLocaleString("pt-BR") + " caracteres" : "sem descrição"; })}
                    {Linha("Tipo de anúncio", function(a){ return a.tipoAnuncio === "gold_pro" ? "Premium" : a.tipoAnuncio === "gold_special" ? "Clássico" : a.tipoAnuncio; })}
                    {Linha("Score de qualidade", function(a){
                      var sc = a === concorrente ? sa : sb;
                      return sc.score + "/100";
                    })}

                    <div style={{ marginTop:14 }}>
                      <div style={{ fontSize:10.5, color:"var(--text-3)", fontWeight:600, marginBottom:6 }}>ONDE O SEU ANÚNCIO PERDE PARA ESTE CONCORRENTE</div>
                      {(function(){
                        var perdendo = sb.checks.filter(function(chk, i){ return !chk.pass && sa.checks[i] && sa.checks[i].pass; });
                        if (!perdendo.length) return <div style={{ fontSize:12.5, color:"#0a9d4e" }}>Nenhum critério — seu anúncio está igual ou melhor em tudo que o score mede.</div>;
                        return perdendo.map(function(chk){
                          return <div key={chk.key} style={{ fontSize:12.5, color:"var(--text-2)", padding:"4px 0" }}>✕ {chk.label}</div>;
                        });
                      })()}
                    </div>

                    <div style={{ display:"flex", gap:8, marginTop:16, flexWrap:"wrap" }}>
                      {concorrente.link && <a href={concorrente.link} target="_blank" rel="noreferrer"
                        style={{ fontSize:12, fontWeight:600, color:"var(--text-2)", background:"var(--bg-2)", border:"1px solid var(--border)", padding:"8px 14px", borderRadius:8, textDecoration:"none" }}>
                        Ver concorrente no ML ↗</a>}
                      {meu.link && <a href={meu.link} target="_blank" rel="noreferrer"
                        style={{ fontSize:12, fontWeight:600, color:"var(--text-2)", background:"var(--bg-2)", border:"1px solid var(--border)", padding:"8px 14px", borderRadius:8, textDecoration:"none" }}>
                        Ver o meu no ML ↗</a>}
                    </div>
                  </>
                );
              })()}
            </div>
          </div>
        );
      })()}

      {!carregando && !erro && dados && dados.categorias.map(function(c){
        var expandida = aberta === c.id;
        return (
          <div key={c.id} style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:12, marginBottom:10, overflow:"hidden" }}>
            <div style={{ padding:"14px 18px", display:"flex", alignItems:"center", gap:14, flexWrap:"wrap" }}>
              <div style={{ flex:"1 1 240px", minWidth:0 }}>
                <div style={{ fontWeight:600, fontSize:15, color:"var(--text-strong)" }}>{c.nome}</div>
                <div style={{ fontSize:11, color:"var(--text-3)", marginTop:2, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                  {c.caminho || c.id}
                </div>
              </div>
              <div style={{ textAlign:"right" }}>
                <div style={{ fontSize:10.5, color:"var(--text-3)" }}>Unidades</div>
                <div style={{ fontSize:17, fontWeight:600, color:"var(--text-strong)" }}>{c.unidades}</div>
                <div style={{ fontSize:10, color:"var(--text-4)" }}>antes: {c.unidadesAnterior}</div>
              </div>
              <div style={{ textAlign:"right" }}>
                <div style={{ fontSize:10.5, color:"var(--text-3)" }}>Receita</div>
                <div style={{ fontSize:15, fontWeight:600, color:"var(--text-strong)" }}>{fmt(c.receita)}</div>
              </div>
              <div style={{ textAlign:"right" }}>
                <div style={{ fontSize:10.5, color:"var(--text-3)" }}>Preço médio</div>
                <div style={{ fontSize:15, fontWeight:600, color:"var(--text-strong)" }}>{c.precoMedio != null ? fmt(c.precoMedio) : "—"}</div>
              </div>
              <div style={{ textAlign:"right" }}>
                <div style={{ fontSize:10.5, color:"var(--text-3)" }}>Anúncios ativos</div>
                <div style={{ fontSize:15, fontWeight:600, color:"var(--text-strong)" }}>{c.anunciosAtivos}</div>
              </div>
              <div style={{ display:"flex", flexDirection:"column", alignItems:"flex-end", gap:6 }}>
                <Variacao pct={c.variacaoUnidades} />
                <div style={{ display:"flex", gap:6 }}>
                  <button onClick={function(){ setAberta(expandida ? null : c.id); }}
                    style={{ fontSize:11.5, color:"var(--text-2)", background:"var(--bg-2)", border:"1px solid var(--border)", padding:"4px 10px", borderRadius:7, cursor:"pointer", fontFamily:"inherit" }}>
                    {expandida ? "▲ Fechar" : "▼ Produtos"}
                  </button>
                  <button onClick={function(){
                      if (mercadoAberto === c.id) { setMercadoAberto(null); return; }
                      if (mercadoCat[c.id] && mercadoCat[c.id].dados) setMercadoAberto(c.id);
                      else carregarMercado(c.id, false);
                    }}
                    style={{ fontSize:11.5, fontWeight:600, color:"#0e7490", background:"rgba(0,240,255,.08)", border:"1px solid rgba(0,240,255,.35)", padding:"4px 10px", borderRadius:7, cursor:"pointer", fontFamily:"inherit" }}>
                    {mercadoAberto === c.id ? "▲ Mercado" : "▼ Mercado"}
                  </button>
                </div>
              </div>
            </div>

            {mercadoAberto === c.id && (function(){
              var m = mercadoCat[c.id] || {};
              return (
                <div style={{ borderTop:"1px solid var(--border-soft)", padding:"12px 18px 14px", background:"var(--bg-2)" }}>
                  {m.carregando && <div style={{ fontSize:12.5, color:"var(--text-3)", padding:"8px 0" }}>Consultando o mercado no ML…</div>}
                  {m.erro && <div style={{ fontSize:12.5, color:"#FF5252", padding:"8px 0" }}>Mercado: {m.erro}</div>}
                  {m.dados && (function(){
                    var d = m.dados;
                    var meuPreco = c.precoMedio;
                    return (
                      <>
                        <div style={{ display:"flex", gap:20, flexWrap:"wrap", alignItems:"center", marginBottom:10 }}>
                          <div style={{ fontWeight:600, fontSize:13, color:"var(--text-strong)" }}>🌎 Mercado — {d.categoria.nome}</div>
                          {d.categoria.totalAnuncios != null && (
                            <div style={{ fontSize:12, color:"var(--text-2)" }}>
                              <b>{d.categoria.totalAnuncios.toLocaleString("pt-BR")}</b> anúncios concorrendo na categoria
                            </div>
                          )}
                          {d.precoMedioTop != null && (
                            <div style={{ fontSize:12, color:"var(--text-2)" }}>
                              Preço médio do top vendas: <b>{fmt(d.precoMedioTop)}</b>
                              {meuPreco != null && (
                                <span style={{ marginLeft:6, color: meuPreco <= d.precoMedioTop ? "#0a9d4e" : "#FF9800" }}>
                                  (o seu: {fmt(meuPreco)})
                                </span>
                              )}
                            </div>
                          )}
                          <button onClick={function(){ carregarMercado(c.id, true); }}
                            style={{ fontSize:10.5, color:"var(--text-3)", background:"none", border:"1px solid var(--border)", padding:"3px 9px", borderRadius:6, cursor:"pointer", fontFamily:"inherit", marginLeft:"auto" }}>
                            ↻ Atualizar{d.deCache ? " (dados de cache)" : ""}
                          </button>
                        </div>

                        {d.buscasEmAlta.length > 0 && (
                          <div style={{ marginBottom:12 }}>
                            <div style={{ fontSize:10.5, color:"var(--text-3)", marginBottom:5, fontWeight:600 }}>O QUE ESTÃO BUSCANDO NESTA CATEGORIA</div>
                            <div style={{ display:"flex", flexWrap:"wrap", gap:6 }}>
                              {d.buscasEmAlta.map(function(t, i){
                                return <a key={i} href={t.url} target="_blank" rel="noreferrer"
                                  style={{ fontSize:11.5, color:"var(--text-2)", background:"var(--surface)", border:"1px solid var(--border)", padding:"4px 10px", borderRadius:20, textDecoration:"none" }}>
                                  {t.termo}
                                </a>;
                              })}
                            </div>
                          </div>
                        )}

                        {d.maisVendidos.length > 0 && (
                          <div>
                            <div style={{ fontSize:10.5, color:"var(--text-3)", marginBottom:2, fontWeight:600 }}>MAIS VENDIDOS DA CATEGORIA (RANKING DO ML)</div>
                            {d.maisVendidos.map(function(mv){
                              return (
                                <div key={mv.posicao + "-" + mv.id} style={{ display:"flex", alignItems:"center", gap:10, padding:"7px 0", borderBottom:"1px solid var(--border-soft)", flexWrap:"wrap" }}>
                                  <span style={{ width:26, fontSize:12, fontWeight:700, color: mv.posicao <= 3 ? "#FFC107" : "var(--text-3)", flexShrink:0 }}>{mv.posicao}º</span>
                                  <div style={{ flex:"1 1 260px", minWidth:0, fontSize:12.5, color:"var(--text-strong)", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                                    {mv.titulo || mv.id}
                                    {mv.seu && <span style={{ marginLeft:8, fontSize:10, fontWeight:700, color:"#0a9d4e", background:"rgba(10,157,78,.12)", padding:"2px 7px", borderRadius:20 }}>SEU ANÚNCIO</span>}
                                  </div>
                                  <div style={{ width:96, textAlign:"right", fontSize:12.5, fontWeight:600, color:"var(--text-strong)" }}>{mv.preco != null ? fmt(mv.preco) : "—"}</div>
                                  {mv.link
                                    ? <a href={mv.link} target="_blank" rel="noreferrer" style={{ fontSize:11, color:"#0e7490", textDecoration:"none", flexShrink:0 }}>ver ↗</a>
                                    : <span style={{ width:32 }} />}
                                  {!mv.seu && mv.itemComparar && (
                                    <button onClick={function(){ abrirComparacao(mv.itemComparar, c.id, null); }}
                                      style={{ fontSize:11, fontWeight:600, color:"var(--text-2)", background:"var(--surface)", border:"1px solid var(--border)", padding:"4px 10px", borderRadius:7, cursor:"pointer", fontFamily:"inherit", flexShrink:0 }}>
                                      Comparar
                                    </button>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}

                        {Array.isArray(d.avisos) && d.avisos.length > 0 && (
                          <div style={{ fontSize:11, color:"#FF9800", marginTop:8, lineHeight:1.6 }}>
                            {d.avisos.map(function(a, i){ return <div key={i}>⚠ {a}</div>; })}
                          </div>
                        )}
                        <div style={{ fontSize:10.5, color:"var(--text-4)", marginTop:8, lineHeight:1.5 }}>
                          Unidades vendidas e vendedores ativos do mercado inteiro não têm dados públicos na API — esses números só existem no painel do próprio ML.
                        </div>
                      </>
                    );
                  })()}
                </div>
              );
            })()}

            {expandida && (
              <div style={{ borderTop:"1px solid var(--border-soft)", padding:"6px 18px 14px" }}>
                {c.produtos.length === 0
                  ? <div style={{ fontSize:12, color:"var(--text-3)", padding:"10px 0" }}>Sem vendas nesta categoria no período.</div>
                  : c.produtos.map(function(pr){
                      return (
                        <div key={pr.anuncio} style={{ display:"flex", alignItems:"center", gap:12, padding:"9px 0", borderBottom:"1px solid var(--border-soft)", flexWrap:"wrap" }}>
                          <div style={{ flex:"1 1 260px", minWidth:0 }}>
                            <div style={{ fontSize:13, color:"var(--text-strong)", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{pr.titulo}</div>
                            <div style={{ fontSize:11, color:"var(--text-3)", fontFamily:"'JetBrains Mono',monospace" }}>
                              SKU {pr.sku || "—"} · {pr.anuncio}
                            </div>
                          </div>
                          <div style={{ textAlign:"right", width:70 }}>
                            <div style={{ fontSize:10.5, color:"var(--text-3)" }}>Unid.</div>
                            <div style={{ fontSize:14, fontWeight:600, color:"var(--text-strong)" }}>{pr.unidades}</div>
                          </div>
                          <div style={{ textAlign:"right", width:100 }}>
                            <div style={{ fontSize:10.5, color:"var(--text-3)" }}>Receita</div>
                            <div style={{ fontSize:14, fontWeight:600, color:"var(--text-strong)" }}>{fmt(pr.receita)}</div>
                          </div>
                          <div style={{ display:"flex", gap:6 }}>
                            <button
                              onClick={function(){ setBuscaPrecificacao(pr.sku || pr.titulo); setTab("precificacao"); }}
                              title="Abrir este produto na Precificação"
                              style={{ fontSize:11.5, fontWeight:600, color:"var(--ui-accent-text)", background:"var(--ui-accent)", border:"none", padding:"6px 12px", borderRadius:7, cursor:"pointer", fontFamily:"inherit" }}>
                              Precificar
                            </button>
                            <a href={"https://www.mercadolivre.com.br/anuncio/" + pr.anuncio} target="_blank" rel="noreferrer"
                              style={{ fontSize:11.5, fontWeight:600, color:"var(--text-2)", background:"var(--bg-2)", border:"1px solid var(--border)", padding:"6px 12px", borderRadius:7, textDecoration:"none" }}>
                              Ver no ML
                            </a>
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
  );
}

// Integrações: status das conexões do sistema.
function IntegracoesTab({ token, user, lastUpdate }) {
  var mins = lastUpdate ? Math.round((Date.now() - parseInt(lastUpdate)) / 60000) : null;
  var badgeStatus = { conectado:["#0a9d4e","rgba(0,200,83,.14)","● Conectado"], disponivel:["#768692","rgba(118,134,146,.14)","Disponível"], construcao:["#FFC107","rgba(255,193,7,.14)","🚧 Em construção"] };
  var cards = [
    { nome:"Mercado Livre", desc:"Anúncios, pedidos, taxas e repasses — sincronizados automaticamente.", status: token ? "conectado" : "disponivel", extra: token && user && user.nickname ? ("Conta: " + user.nickname + (mins != null ? " · última sync há " + mins + " min" : "")) : null,
      acao: token ? { label:"Reconectar", onClick:function(){ window.location.href="/api/auth/login"; }, tipo:"sec" } : { label:"Conectar ML", onClick:function(){ window.location.href="/api/auth/login"; }, tipo:"pri" } },
    { nome:"Amazon", desc:"Marketplace Amazon (anúncios e pedidos).", status:"construcao", extra:null, acao:null },
    { nome:"Shopee", desc:"Marketplace Shopee (anúncios e pedidos).", status:"construcao", extra:null, acao:null },
  ];
  function btnEstilo(tipo){
    if (tipo==="pri") return { background:"var(--ui-accent)", border:"none", color:"var(--ui-accent-text)", fontWeight:600 };
    if (tipo==="del") return { background:"rgba(255,82,82,.1)", border:"1px solid rgba(255,82,82,.35)", color:"#FF5252", fontWeight:600 };
    return { background:"var(--surface)", border:"1px solid var(--border)", color:"var(--text-2)", fontWeight:600 };
  }
  return (
    <div style={{ padding:2 }}>
      <div style={{ fontWeight:600, fontSize:20, color:"var(--text-strong)" }}>Integrações</div>
      <div style={{ fontSize:13, color:"var(--text-3)", marginBottom:14 }}>Conexões do sistema com marketplaces e serviços.</div>
      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(280px,1fr))", gap:12 }}>
        {cards.map(function(c,i){
          return <div key={i} style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:12, padding:"16px 18px", display:"flex", flexDirection:"column" }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:6 }}>
              <div style={{ fontWeight:500, fontSize:15, color:"var(--text-strong)" }}>{c.nome}</div>
              {(function(){ var b = badgeStatus[c.status]; return <span style={{ fontSize:11, fontWeight:500, padding:"3px 10px", borderRadius:20, background:b[1], color:b[0], whiteSpace:"nowrap" }}>{b[2]}</span>; })()}
            </div>
            <div style={{ fontSize:13, color:"var(--text-2)", lineHeight:1.5 }}>{c.desc}</div>
            {c.extra && <div style={{ fontSize:11, color:"var(--text-3)", marginTop:6 }}>{c.extra}</div>}
            <div style={{ display:"flex", gap:8, marginTop:12, flexWrap:"wrap" }}>
              {c.acao && <button onClick={c.acao.onClick} style={{ ...btnEstilo(c.acao.tipo), padding:"8px 16px", borderRadius:8, cursor:"pointer", fontSize:13 }}>{c.acao.label}</button>}
            </div>
          </div>;
        })}
      </div>

    </div>
  );
}

// Fornecedores: cadastro de verdade, no lugar da tela de exemplo com zeros
// fixos. Ela existia sem ler nada, então um fornecedor gravado por Contas a
// pagar era salvo e sumia — o dado estava certo, a tela é que não o buscava.
// Unidades da federação, mais EX para operação com exterior — a mesma lista que
// a nota fiscal aceita, para o cadastro não travar na hora de emitir.
var UFS = ["AC","AL","AM","AP","BA","CE","DF","ES","EX","GO","MA","MG","MS","MT","PA","PB","PE","PI","PR","RJ","RN","RO","RR","RS","SC","SE","SP","TO"];
var CONTRIBUINTE = [
  ["1","1 - Contribuinte ICMS"],
  ["2","2 - Contribuinte isento de Inscrição no Cadastro de Contribuintes"],
  ["9","9 - Não contribuinte, que pode ou não possuir Inscrição Estadual"],
];
var TIPOS_CONTATO = ["Cliente","Desenvolvedor","Fornecedor","Padrão","Técnico","Transportador","Vendedor","Contador"];
var SITUACOES_CAD = [["ativo","Ativo"],["inativo","Inativo"],["sem_movimento","Sem movimento"]];

function nomeFornecedor(x){
  return String((x && (x.nome || x.razaoSocial || x.fantasia)) || x || "").trim();
}

function FornecedorModal({ fornecedor, onSave, onClose, onExcluir }) {
  const [f, setF] = useState(function(){
    var base = Object.assign({ situacao:"ativo", codigo:"", nome:"", fantasia:"", tipoPessoa:"pj",
                           documento:"", ie:"", contribuinte:"9", nascimento:"", rg:"",
                           cep:"", uf:"", cidade:"", bairro:"", endereco:"", numero:"", complemento:"",
                           email:"", emailNfe:"", celular:"", telefone:"", tipoContato:"Fornecedor",
                           contato:"", infoContato:"", condicao:"", categoriaPadrao:"", obs:"" }, fornecedor || {});
    // Cadastros antigos só tinham o par ativo/inativo; converte sem perder nada.
    if (fornecedor && fornecedor.situacao == null) base.situacao = fornecedor.ativo === false ? "inativo" : "ativo";
    return base;
  });
  const [erro, setErro] = useState("");
  const [aba, setAba] = useState("dados");
  function set(k,v){ setF(function(s){ return Object.assign({}, s, { [k]:v }); }); }
  var novo = !fornecedor || !fornecedor.id;
  var pf = f.tipoPessoa === "pf";
  function salvar(){
    if (!String(f.nome||"").trim()) { setErro("Informe o nome do fornecedor."); setAba("dados"); return; }
    var p = Object.assign({}, f);
    // `ativo` continua gravado porque o resto do sistema ainda lê esse campo;
    // "sem movimento" é um cadastro válido, só sem uso recente — não é inativo.
    p.ativo = p.situacao !== "inativo";
    if (!p.id) p.id = "fn_" + Date.now() + "_" + Math.floor(Math.random()*1000);
    onSave(p);
  }
  var campo = { width:"100%", background:"var(--bg)", border:"1px solid var(--border)", color:"var(--text-strong)", padding:"9px 11px", borderRadius:8, fontSize:13, outline:"none", boxSizing:"border-box" };
  var lbl = { fontSize:11.5, color:"var(--text-3)", fontWeight:600, marginBottom:4, display:"block" };
  var grade = function(cols){ return { display:"grid", gridTemplateColumns:cols, gap:12, marginBottom:12 }; };
  function Campo(rot, k, extra){
    return <div><label style={lbl}>{rot}</label>
      <input value={f[k]||""} onChange={function(e){ set(k, e.target.value); }} style={campo} {...(extra||{})} /></div>;
  }
  function TabBtn(id, label){
    var a = aba === id;
    return <button onClick={function(){ setAba(id); }} style={{ background:"none", border:"none", borderBottom: a?"2px solid var(--ui-accent)":"2px solid transparent", padding:"10px 4px", marginRight:22, cursor:"pointer", fontSize:13, fontWeight: a?700:500, color: a?"#0a9d4e":"var(--text-3)" }}>{label}</button>;
  }
  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,.45)", zIndex:640, display:"flex", alignItems:"flex-start", justifyContent:"center", padding:"24px 16px", overflowY:"auto" }} onClick={onClose}>
      <div onClick={function(e){ e.stopPropagation(); }} style={{ background:"var(--bg-2)", border:"1px solid var(--border)", borderRadius:14, width:780, maxWidth:"100%", display:"flex", flexDirection:"column", maxHeight:"92vh" }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"18px 22px 8px" }}>
          <div style={{ fontWeight:600, fontSize:17.5, color:"var(--text-strong)" }}>{novo ? "Adicionar cadastro" : "Editar cadastro"}</div>
          <button onClick={onClose} style={{ background:"none", border:"none", color:"var(--text-3)", fontSize:22, cursor:"pointer" }}>×</button>
        </div>
        <div style={{ padding:"0 22px", overflowY:"auto" }}>
          {erro && <div style={{ background:"rgba(255,82,82,.12)", border:"1px solid #FF5252", color:"#FF5252", borderRadius:9, padding:"10px 13px", fontSize:12.5, marginBottom:14 }}>{erro}</div>}

          <div style={{ marginBottom:14 }}>
            <label style={lbl}>Situação do cadastro</label>
            <div style={{ display:"flex", gap:8 }}>
              {SITUACOES_CAD.map(function(x){
                var a = f.situacao === x[0];
                return <button key={x[0]} onClick={function(){ set("situacao", x[0]); }}
                  style={{ background: a ? "rgba(10,157,78,.14)" : "var(--surface)", border:"1px solid " + (a ? "var(--ui-accent)" : "var(--border)"),
                           color: a ? "#0a9d4e" : "var(--text-2)", fontWeight: a?600:500, padding:"8px 16px", borderRadius:9, cursor:"pointer", fontSize:12.5 }}>{x[1]}</button>;
              })}
            </div>
          </div>

          <div style={{ borderBottom:"1px solid var(--border)", marginBottom:16 }}>{TabBtn("dados","Dados")}{TabBtn("endereco","Endereço")}{TabBtn("contato","Contato")}</div>

          {aba === "dados" && <>
            <div style={grade("120px 2fr 1.4fr")}>
              {Campo("Código","codigo",{ placeholder:"opcional" })}
              <div><label style={lbl}>Nome <span style={{ color:"#FF5252" }}>*</span></label>
                <input value={f.nome||""} onChange={function(e){ set("nome", e.target.value); }} style={campo} autoFocus /></div>
              {Campo("Fantasia","fantasia")}
            </div>
            <div style={grade("1fr 1fr 1fr")}>
              <div><label style={lbl}>Tipo da pessoa</label>
                <select value={f.tipoPessoa} onChange={function(e){ set("tipoPessoa", e.target.value); }} style={campo}>
                  <option value="pj">Pessoa Jurídica</option><option value="pf">Pessoa Física</option><option value="ex">Estrangeiro</option>
                </select></div>
              {Campo(pf ? "CPF" : f.tipoPessoa === "ex" ? "Documento" : "CNPJ","documento")}
              {Campo("Inscrição estadual","ie")}
            </div>
            <div style={grade("2fr 1fr 1fr")}>
              <div><label style={lbl}>Contribuinte</label>
                <select value={f.contribuinte} onChange={function(e){ set("contribuinte", e.target.value); }} style={campo}>
                  {CONTRIBUINTE.map(function(x){ return <option key={x[0]} value={x[0]}>{x[1]}</option>; })}
                </select></div>
              <div><label style={lbl}>Data de nascimento</label>
                <input type="date" value={f.nascimento||""} onChange={function(e){ set("nascimento", e.target.value); }} style={campo} /></div>
              {Campo("RG","rg")}
            </div>
            <div style={grade("1fr 1fr")}>
              {Campo("Condição de pagamento","condicao",{ placeholder:"30/60/90 dias" })}
              {Campo("Categoria habitual","categoriaPadrao",{ placeholder:"Fornecedor, Serviços..." })}
            </div>
          </>}

          {aba === "endereco" && <>
            <div style={grade("160px 120px 1fr")}>
              {Campo("CEP","cep",{ placeholder:"00000-000" })}
              <div><label style={lbl}>UF</label>
                <select value={f.uf||""} onChange={function(e){ set("uf", e.target.value); }} style={campo}>
                  <option value="">UF</option>
                  {UFS.map(function(u){ return <option key={u} value={u}>{u}</option>; })}
                </select></div>
              {Campo("Cidade","cidade")}
            </div>
            <div style={grade("1fr 2fr")}>
              {Campo("Bairro","bairro")}
              {Campo("Endereço","endereco")}
            </div>
            <div style={grade("140px 1fr")}>
              {Campo("Número","numero")}
              {Campo("Complemento","complemento")}
            </div>
          </>}

          {aba === "contato" && <>
            <div style={grade("1fr 1fr")}>
              {Campo("E-mail","email",{ type:"email" })}
              {Campo("E-mail para envio da NFe","emailNfe",{ type:"email" })}
            </div>
            <div style={grade("1fr 1fr 1fr")}>
              {Campo("Celular","celular")}
              {Campo("Fone","telefone")}
              <div><label style={lbl}>Tipo de contato</label>
                <select value={f.tipoContato||""} onChange={function(e){ set("tipoContato", e.target.value); }} style={campo}>
                  {TIPOS_CONTATO.map(function(t){ return <option key={t} value={t}>{t}</option>; })}
                </select></div>
            </div>
            <div style={grade("1fr 2fr")}>
              {Campo("Nome do contato","contato")}
              {Campo("Informações do contato","infoContato")}
            </div>
            <div style={{ marginBottom:12 }}><label style={lbl}>Observações</label>
              <textarea value={f.obs||""} onChange={function(e){ set("obs", e.target.value); }} rows={3} style={{ ...campo, resize:"vertical", fontFamily:"inherit" }} /></div>
          </>}
        </div>
        <div style={{ display:"flex", gap:8, padding:"14px 22px", borderTop:"1px solid var(--border-soft)" }}>
          {!novo && onExcluir && <button onClick={function(){ onExcluir(f); }} style={{ background:"rgba(255,82,82,.1)", border:"1px solid rgba(255,82,82,.35)", color:"#FF5252", fontWeight:600, padding:"11px 18px", borderRadius:10, cursor:"pointer" }}>Excluir</button>}
          <div style={{ flex:1 }} />
          <button onClick={onClose} style={{ background:"var(--surface)", border:"1px solid var(--border)", color:"var(--text-2)", fontWeight:600, padding:"11px 20px", borderRadius:10, cursor:"pointer" }}>Cancelar</button>
          <button onClick={salvar} style={{ background:"var(--ui-accent)", border:"none", color:"var(--ui-accent-text)", fontWeight:600, padding:"11px 30px", borderRadius:10, cursor:"pointer" }}>Salvar</button>
        </div>
      </div>
    </div>
  );
}
function FornecedoresTab({ fornecedores, salvar, contasPagar, setTab }) {
  const [modal, setModal] = useState(null);
  const [busca, setBusca] = useState("");
  function nomeDe(x){ return String((x && (x.nome || x.razaoSocial || x.fantasia)) || x || "").trim(); }

  // O que cada fornecedor representa em dinheiro. Sem isto a tela seria só uma
  // agenda de nomes; com isto ela responde "quanto eu devo a quem".
  var porNome = {};
  (contasPagar || []).forEach(function(c){
    var k = String(c.descricao || "").trim().toLowerCase();
    if (!k) return;
    if (!porNome[k]) porNome[k] = { aberto:0, nAberto:0, pago:0, nPago:0, vencido:0 };
    // Uma conta paga pela metade conta dos dois lados: o que já saiu em "pago",
    // o que falta em "aberto". Somar o valor de face num só lado inflava os dois.
    var pago = pagoDe(c), saldo = saldoDe(c);
    if (c.status === "cancelada") return;
    if (pago > 0) { porNome[k].pago += pago; porNome[k].nPago++; }
    if (saldo > 0) {
      porNome[k].aberto += saldo; porNome[k].nAberto++;
      if (c.vencimento && c.vencimento < new Date().toISOString().slice(0,10)) porNome[k].vencido += saldo;
    }
  });

  var lista = (fornecedores || []).map(function(x, i){
    var nome = nomeDe(x);
    var d = porNome[nome.toLowerCase()] || { aberto:0, nAberto:0, pago:0, nPago:0, vencido:0 };
    return Object.assign({}, typeof x === "object" ? x : { nome: nome }, { _i:i, nome:nome, mov:d });
  }).filter(function(x){
    var q = busca.trim().toLowerCase();
    return !q || x.nome.toLowerCase().indexOf(q) >= 0 || String(x.documento||"").toLowerCase().indexOf(q) >= 0;
  }).sort(function(a,b){ return b.mov.aberto - a.mov.aberto || a.nome.localeCompare(b.nome); });

  var totalAberto = lista.reduce(function(s,x){ return s + x.mov.aberto; }, 0);
  var totalVencido = lista.reduce(function(s,x){ return s + x.mov.vencido; }, 0);
  var comAberto = lista.filter(function(x){ return x.mov.nAberto > 0; }).length;

  function salvarForn(fn){
    var arr = (fornecedores || []).map(function(x){ return typeof x === "object" ? x : { id:"fn_leg_"+nomeDe(x), nome:nomeDe(x) }; });
    var i = arr.findIndex(function(x){ return x.id === fn.id; });
    if (i >= 0) arr[i] = fn; else arr.push(fn);
    salvar(arr); setModal(null);
  }
  function excluir(fn){
    var d = porNome[String(fn.nome||"").toLowerCase()];
    if (d && d.nAberto > 0 && !window.confirm("Este fornecedor tem " + d.nAberto + " conta(s) em aberto, somando " + fmt(d.aberto) +
      ".\\n\\nExcluir o cadastro NÃO apaga as contas — elas continuam na lista de Contas a pagar. Excluir mesmo assim?")) return;
    if (!d && !window.confirm("Excluir “" + fn.nome + "” do cadastro?")) return;
    salvar((fornecedores || []).filter(function(x){ return (typeof x === "object" ? x.id : null) !== fn.id; }));
    setModal(null);
  }

  var cartao = { background:"var(--surface)", border:"1px solid var(--border)", borderRadius:12, padding:"14px 16px" };
  return (
    <div style={{ padding:2, width:"100%" }}>
      <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom:14, flexWrap:"wrap" }}>
        <div>
          <div style={{ fontWeight:600, fontSize:20, color:"var(--text-strong)" }}>Fornecedores</div>
          <div style={{ fontSize:12.5, color:"var(--text-3)" }}>Quem você paga, e quanto deve a cada um. Fornecedor novo em Contas a pagar entra aqui sozinho.</div>
        </div>
        <div style={{ flex:1 }} />
        <div style={{ position:"relative", minWidth:240 }}>
          <span style={{ position:"absolute", left:12, top:"50%", transform:"translateY(-50%)", color:"var(--text-3)", fontSize:13 }}>🔍</span>
          <input value={busca} onChange={function(e){ setBusca(e.target.value); }} placeholder="Nome ou documento"
            style={{ width:"100%", background:"var(--surface)", border:"1px solid var(--border)", color:"var(--text-strong)", padding:"9px 12px 9px 34px", borderRadius:9, fontSize:13, outline:"none" }} />
        </div>
        <button onClick={function(){ setModal({}); }} style={{ background:"var(--ui-accent)", border:"none", color:"var(--ui-accent-text)", fontWeight:600, padding:"9px 22px", borderRadius:9, cursor:"pointer", fontSize:13 }}>+ Novo fornecedor</button>
      </div>

      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(180px,1fr))", gap:12, marginBottom:14 }}>
        {[["Fornecedores", String(lista.length), "var(--text-strong)", (fornecedores||[]).length + " no cadastro"],
          ["Com conta em aberto", String(comAberto), comAberto ? "#FFC107" : "var(--text-3)", "de " + lista.length],
          ["Total em aberto", fmt(totalAberto), totalAberto ? "var(--text-strong)" : "var(--text-3)", "o que você deve"],
          ["Vencido", fmt(totalVencido), totalVencido ? "#FF5252" : "var(--text-3)", "já passou do prazo"]].map(function(k,i){
          return <div key={i} style={cartao}>
            <div style={{ fontSize:11.5, color:"var(--text-3)" }}>{k[0]}</div>
            <div style={{ fontSize:21, fontWeight:600, color:k[2], marginTop:2, fontVariantNumeric:"tabular-nums" }}>{k[1]}</div>
            <div style={{ fontSize:10.5, color:"var(--text-4)", marginTop:2 }}>{k[3]}</div>
          </div>;
        })}
      </div>

      {lista.length === 0 ? (
        <div style={{ ...cartao, textAlign:"center", padding:"54px 20px" }}>
          <div style={{ fontSize:36, marginBottom:10 }}>🏭</div>
          <div style={{ fontWeight:600, fontSize:16, color:"var(--text-strong)" }}>
            {busca ? "Nenhum fornecedor com esse nome." : "Nenhum fornecedor cadastrado."}
          </div>
          <div style={{ fontSize:13.5, color:"var(--text-3)", marginTop:8, lineHeight:1.65, maxWidth:520, margin:"8px auto 0" }}>
            {busca ? "Limpe a busca para ver todos." : <>Cadastre aqui, ou deixe que se cadastrem sozinhos: todo fornecedor digitado numa conta em <b>Financeiro → Contas a pagar</b> entra nesta lista ao salvar.</>}
          </div>
          {!busca && setTab && <button onClick={function(){ setTab("contas_pagar"); }}
            style={{ marginTop:18, background:"var(--surface)", border:"1px solid var(--border)", color:"var(--text-2)", fontWeight:600, padding:"10px 22px", borderRadius:9, cursor:"pointer", fontSize:13 }}>Ir para Contas a pagar →</button>}
        </div>
      ) : (
        <div className="tabela-wrap">
          <table className="tabela">
            <thead><tr>{["Fornecedor","Documento","Contato","Condição","Em aberto","Vencido","Já pago",""].map(function(h){ return <th key={h} className="th">{h}</th>; })}</tr></thead>
            <tbody>
              {lista.map(function(x){
                var sit = x.situacao || (x.ativo === false ? "inativo" : "ativo");
                var inativo = sit === "inativo";
                return <tr key={x.id || x._i} onClick={function(){ setModal(x); }} style={{ cursor:"pointer", opacity: inativo ? .5 : 1 }} title="Abrir cadastro">
                  <td className="td" style={{ color:"var(--text-strong)", fontWeight:500 }}>
                    {x.nome}
                    {x.fantasia && x.fantasia !== x.nome && <span style={{ marginLeft:7, fontSize:10.5, color:"var(--text-4)" }}>{x.fantasia}</span>}
                    {x.origem && <span style={{ marginLeft:7, fontSize:10, color:"var(--text-4)" }}>via {x.origem}</span>}
                    {sit !== "ativo" && <span style={{ marginLeft:7, fontSize:10.5, color:"var(--text-4)" }}>{sit === "inativo" ? "inativo" : "sem movimento"}</span>}
                  </td>
                  <td className="td-num">{x.documento || "—"}</td>
                  <td className="td">{x.contato || x.email || x.telefone || "—"}</td>
                  <td className="td">{x.condicao || "—"}</td>
                  <td className="td-num" style={{ fontWeight:600, color: x.mov.aberto ? "var(--text-strong)" : "var(--text-4)" }}>
                    {x.mov.aberto ? fmt(x.mov.aberto) : "—"}
                    {x.mov.nAberto > 0 && <div style={{ fontSize:10, color:"var(--text-4)", fontWeight:400 }}>{x.mov.nAberto} conta(s)</div>}
                  </td>
                  <td className="td-num">{x.mov.vencido ? <span style={{ color:"#FF5252" }}>{fmt(x.mov.vencido)}</span> : <span style={{ color:"var(--text-4)" }}>—</span>}</td>
                  <td className="td-num">{x.mov.pago ? <span style={{ color:"#0a9d4e" }}>{fmt(x.mov.pago)}</span> : <span style={{ color:"var(--text-4)" }}>—</span>}</td>
                  <td className="td" style={{ textAlign:"right" }} onClick={function(e){ e.stopPropagation(); }}>
                    <button onClick={function(){ setModal(x); }} style={{ background:"var(--surface-3)", border:"none", color:"var(--text-2)", fontSize:11, fontWeight:600, padding:"4px 10px", borderRadius:6, cursor:"pointer" }}>Editar</button>
                  </td>
                </tr>;
              })}
            </tbody>
          </table>
        </div>
      )}
      {modal && <FornecedorModal fornecedor={modal.id ? modal : null} onSave={salvarForn} onExcluir={excluir} onClose={function(){ setModal(null); }} />}
    </div>
  );
}

// ── Conciliação bancária ───────────────────────────────────────────────────
// Compara o extrato do banco com o que o sistema acha que aconteceu. O valor
// está no que NÃO bate: repasse que veio menor, conta paga que o sistema não
// registrou, lançamento que o banco nunca viu.
const CAMPOS_EXTRATO = [
  { key:"data",      rotulo:"Data",      obrigatorio:true,
    achar:["data","data lancamento","data lançamento","dt","data movimento","data da operacao","data da operação"] },
  { key:"descricao", rotulo:"Histórico", obrigatorio:true,
    achar:["historico","histórico","descricao","descrição","lancamento","lançamento","memo","detalhe","documento"] },
  { key:"valor",     rotulo:"Valor",     obrigatorio:true,
    achar:["valor","valor r$","vlr","montante","credito/debito","crédito/débito"] },
  { key:"tipo",      rotulo:"Tipo (opcional)", obrigatorio:false,
    achar:["tipo","d/c","debito/credito","débito/crédito","natureza"] },
];

// Extrato costuma trazer o sinal no próprio valor; alguns trazem numa coluna
// separada. Aceita os dois, e o sinal do valor manda quando existe.
function tipoDoExtrato(valor, colunaTipo) {
  if (valor < 0) return "saida";
  var t = String(colunaTipo || "").trim().toLowerCase();
  if (/^d$|debito|débito|saida|saída|pagamento/.test(t)) return "saida";
  return "entrada";
}

var TOLERANCIA_DIAS = 5;          // o banco lança em D+1, D+2; a data raramente é igual
// Até 35% de diferença ainda é "o mesmo lançamento com valor diferente". Parece
// muito, e é de propósito: um repasse do Mercado Livre pode chegar bem menor que
// o bruto por retenção ou estorno, e mostrar isso como UMA divergência de R$ 300
// vale mais do que como duas linhas soltas que o usuário teria de cruzar na mão.
// Um par errado fica visível lado a lado na tela e pode ser desfeito.
var TOLERANCIA_DIVERGENCIA = 0.35;

function diffDias(a, b) {
  return Math.abs(Math.round((new Date(a + "T12:00:00") - new Date(b + "T12:00:00")) / 86400000));
}

// Casa cada linha do extrato com um movimento do sistema. Duas passadas: a
// primeira exige o mesmo valor, a segunda aceita valor próximo e marca como
// divergência. Sem as duas, um repasse que veio R$ 30 menor apareceria como
// duas linhas soltas em vez de um problema a resolver.
function conciliar(extrato, movimentos, manuais) {
  var usados = {};
  var linhas = (extrato || []).filter(function(e){ return !e.ignorado; });
  var movs = (movimentos || []).slice();
  var casadas = [], divergentes = [], soExtrato = [], resultadoPorMov = {};

  function melhor(e, exigirValorIgual) {
    var alvo = null, melhorScore = Infinity;
    movs.forEach(function(m){
      if (usados[m.id]) return;
      if (m.tipo !== e.tipo) return;
      var dd = diffDias(e.data, m.data);
      if (dd > TOLERANCIA_DIAS) return;
      var dv = Math.abs(m.valor - e.valor);
      if (exigirValorIgual) { if (dv > 0.011) return; }
      // A margem é medida sobre o valor ESPERADO, não sobre o que caiu: o
      // esperado é a referência estável. Sobre o valor do banco, um crédito que
      // veio menor pareceria proporcionalmente mais distante do que é.
      else if (m.valor <= 0 || dv / m.valor > TOLERANCIA_DIVERGENCIA) return;
      var score = dv * 100 + dd;   // valor pesa mais que data
      if (score < melhorScore) { melhorScore = score; alvo = m; }
    });
    return alvo;
  }

  // Conciliação manual feita pelo usuário tem prioridade sobre qualquer palpite.
  linhas.forEach(function(e){
    var forcado = (manuais || {})[e.id];
    if (!forcado) return;
    var m = movs.find(function(x){ return x.id === forcado && !usados[x.id]; });
    if (!m) return;
    usados[m.id] = true; resultadoPorMov[m.id] = e.id;
    (Math.abs(m.valor - e.valor) > 0.011 ? divergentes : casadas).push({ extrato:e, mov:m, manual:true });
  });
  linhas.forEach(function(e){
    if ((manuais || {})[e.id]) return;
    var m = melhor(e, true);
    if (m) { usados[m.id] = true; resultadoPorMov[m.id] = e.id; casadas.push({ extrato:e, mov:m }); }
  });
  linhas.forEach(function(e){
    if ((manuais || {})[e.id]) return;
    if (casadas.some(function(c){ return c.extrato.id === e.id; })) return;
    var m = melhor(e, false);
    if (m) { usados[m.id] = true; resultadoPorMov[m.id] = e.id; divergentes.push({ extrato:e, mov:m }); }
    else soExtrato.push(e);
  });

  var soSistema = movs.filter(function(m){ return !usados[m.id]; });
  return { casadas: casadas, divergentes: divergentes, soExtrato: soExtrato, soSistema: soSistema, porMov: resultadoPorMov };
}

// Ponto de equilíbrio: quanto precisa faturar para o lucro dar zero. Só existe
// se cada real vendido sobrar alguma coisa depois de imposto, CMV e taxa — se a
// margem de contribuição for zero ou negativa, vender mais só aumenta o prejuízo.
function pontoDeEquilibrio(receita, impostos, cmv, taxas, despesasFixas) {
  if (!(receita > 0)) return null;
  var contribuicao = receita - impostos - cmv - taxas;
  var pct = contribuicao / receita;
  if (pct <= 0) return { impossivel: true, pct: pct };
  return { receita: despesasFixas / pct, pct: pct, impossivel: false };
}

// Período anterior de mesmo tamanho, para o DRE comparar. "Tudo" não tem
// anterior — comparar com o infinito não significa nada.
function periodoAnterior(periodo, hoje) {
  if (periodo === "tudo") return null;
  var dias = parseInt(periodo, 10);
  return { de: somarDias(hoje, -2 * dias), ate: somarDias(hoje, -dias), dias: dias };
}

// Importação do extrato: mesmo leitor de CSV e .xlsx da importação de contas.
function ImportarExtratoModal({ contasBancarias, onImportar, onClose }) {
  const [nomeArq, setNomeArq] = useState("");
  const [cabecalho, setCabecalho] = useState(null);
  const [linhas, setLinhas] = useState([]);
  const [mapa, setMapa] = useState({});
  const [conta, setConta] = useState((contasBancarias || [])[0] ? contasBancarias[0].id : "");
  const [erro, setErro] = useState("");
  const [lendo, setLendo] = useState(false);
  const fileRef = useRef(null);

  async function receber(file) {
    setErro(""); setLendo(true); setNomeArq(file.name);
    try {
      var matriz;
      if (/\.xlsx$/i.test(file.name)) matriz = await lerXLSX(await file.arrayBuffer());
      else if (/\.xls$/i.test(file.name)) throw new Error("O formato .xls (Excel antigo) não é lido aqui. Salve como .xlsx ou CSV.");
      else matriz = lerCSV(await file.text());
      if (matriz.length < 2) throw new Error("O extrato precisa de uma linha de cabeçalho e ao menos um lançamento.");
      var cab = matriz[0];
      setCabecalho(cab); setLinhas(matriz.slice(1));
      var norm = cab.map(normalizarCabecalho), m = {}, usadas = {};
      CAMPOS_EXTRATO.forEach(function(campo){
        var achou = -1;
        campo.achar.forEach(function(nome){
          if (achou >= 0) return;
          var alvo = normalizarCabecalho(nome);
          var i = norm.findIndex(function(h, idx){ return !usadas[idx] && h === alvo; });
          if (i < 0) i = norm.findIndex(function(h, idx){ return !usadas[idx] && h && h.indexOf(alvo) >= 0; });
          if (i >= 0) achou = i;
        });
        if (achou >= 0) { m[campo.key] = achou; usadas[achou] = true; } else m[campo.key] = -1;
      });
      setMapa(m);
    } catch (e) {
      setErro((e && e.message) || "Não consegui ler este arquivo.");
      setCabecalho(null); setLinhas([]);
    } finally { setLendo(false); }
  }

  var prontas = !cabecalho ? [] : linhas.map(function(l, i){
    function col(k){ var idx = mapa[k]; return idx >= 0 && idx < l.length ? l[idx] : ""; }
    var data = parseDataBR(col("data"));
    var valor = parseValorBR(col("valor"));
    var erros = [];
    if (!data) erros.push("data não reconhecida");
    if (valor == null || valor === 0) erros.push("valor não reconhecido");
    return {
      linha: i + 2, erros: erros,
      item: {
        data: data, descricao: String(col("descricao") || "").trim() || "(sem histórico)",
        valor: Math.abs(valor || 0), tipo: tipoDoExtrato(valor || 0, col("tipo")), conta: conta,
      },
    };
  });
  var validas = prontas.filter(function(p){ return !p.erros.length; });
  var faltaObrig = CAMPOS_EXTRATO.filter(function(c){ return c.obrigatorio && (mapa[c.key] == null || mapa[c.key] < 0); });
  var entradas = validas.filter(function(p){ return p.item.tipo === "entrada"; }).reduce(function(s,p){ return s + p.item.valor; }, 0);
  var saidas = validas.filter(function(p){ return p.item.tipo === "saida"; }).reduce(function(s,p){ return s + p.item.valor; }, 0);

  var campo = { width:"100%", background:"var(--bg)", border:"1px solid var(--border)", color:"var(--text-strong)", padding:"8px 10px", borderRadius:7, fontSize:12.5, boxSizing:"border-box" };
  var cartao = { background:"var(--surface)", border:"1px solid var(--border)", borderRadius:12, padding:"16px 18px", marginBottom:14 };
  var tit = { fontSize:13.5, fontWeight:600, color:"var(--text-strong)", marginBottom:10 };

  return (
    <div style={{ position:"fixed", inset:0, background:"var(--bg)", zIndex:700, display:"flex", flexDirection:"column" }}>
      <div style={{ borderBottom:"1px solid var(--border)", background:"var(--bg-2)", padding:"14px 22px", display:"flex", alignItems:"center", gap:14, flexWrap:"wrap" }}>
        <button onClick={onClose} style={{ background:"var(--surface)", border:"1px solid var(--border)", color:"var(--text-2)", width:34, height:34, borderRadius:9, cursor:"pointer", fontSize:16 }}>←</button>
        <div>
          <div style={{ fontWeight:600, fontSize:17, color:"var(--text-strong)" }}>Importar extrato</div>
          <div style={{ fontSize:11.5, color:"var(--text-3)", marginTop:2 }}>{nomeArq || "CSV ou Excel (.xlsx) do seu banco"}</div>
        </div>
        <div style={{ flex:1 }} />
        <button onClick={onClose} style={{ background:"var(--surface)", border:"1px solid var(--border)", color:"var(--text-2)", fontWeight:600, padding:"9px 18px", borderRadius:9, cursor:"pointer", fontSize:13 }}>Cancelar</button>
        <button onClick={function(){ onImportar(validas.map(function(p){ return p.item; }), conta); }}
          disabled={!validas.length || faltaObrig.length > 0 || !conta}
          style={{ background: validas.length && !faltaObrig.length && conta ? "var(--ui-accent)" : "var(--surface)",
                   border: validas.length && !faltaObrig.length && conta ? "none" : "1px solid var(--border)",
                   color: validas.length && !faltaObrig.length && conta ? "var(--ui-accent-text)" : "var(--text-4)",
                   fontWeight:600, padding:"9px 24px", borderRadius:9,
                   cursor: validas.length && !faltaObrig.length && conta ? "pointer" : "default", fontSize:13 }}>
          Importar {validas.length ? validas.length + " lançamento(s)" : ""}
        </button>
      </div>
      <div style={{ flex:1, overflowY:"auto", padding:"18px 22px 40px" }}>
        <div style={{ maxWidth:1080, margin:"0 auto" }}>
          {erro && <div style={{ background:"rgba(255,82,82,.12)", border:"1px solid #FF5252", color:"#FF5252", borderRadius:10, padding:"11px 14px", fontSize:12.5, marginBottom:14 }}>{erro}</div>}
          <div style={cartao}>
            <div style={tit}>1. De qual conta é este extrato?</div>
            {(contasBancarias || []).length === 0
              ? <div style={{ fontSize:13, color:"#FF5252" }}>Cadastre uma conta em Caixas e bancos antes de importar um extrato.</div>
              : <select value={conta} onChange={function(e){ setConta(e.target.value); }} style={{ ...campo, maxWidth:340 }}>
                  {(contasBancarias||[]).map(function(c){ return <option key={c.id} value={c.id}>{c.nome}</option>; })}
                </select>}
          </div>
          <div style={cartao}>
            <div style={tit}>2. Escolha o arquivo</div>
            <input ref={fileRef} type="file" accept=".csv,.tsv,.txt,.xlsx,text/csv" style={{ display:"none" }}
              onChange={function(e){ if (e.target.files && e.target.files[0]) receber(e.target.files[0]); e.target.value=""; }} />
            <button onClick={function(){ if (fileRef.current) fileRef.current.click(); }}
              style={{ background:"var(--ui-accent)", border:"none", color:"var(--ui-accent-text)", fontWeight:600, padding:"10px 22px", borderRadius:9, cursor:"pointer", fontSize:13 }}>
              {lendo ? "Lendo..." : (cabecalho ? "Trocar arquivo" : "Selecionar extrato")}
            </button>
            <div style={{ fontSize:11.5, color:"var(--text-3)", marginTop:10, lineHeight:1.6 }}>
              Valor negativo é entendido como saída. Se o seu banco usa uma coluna separada de D/C,
              indique-a no mapeamento abaixo.
            </div>
          </div>
          {cabecalho && <>
            <div style={cartao}>
              <div style={tit}>3. Confira as colunas</div>
              <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(230px,1fr))", gap:12 }}>
                {CAMPOS_EXTRATO.map(function(c){
                  var vazio = mapa[c.key] == null || mapa[c.key] < 0;
                  return <div key={c.key}>
                    <label style={{ fontSize:11.5, color: c.obrigatorio && vazio ? "#FF5252" : "var(--text-3)", fontWeight:600, display:"block", marginBottom:4 }}>{c.rotulo}{c.obrigatorio ? " *" : ""}</label>
                    <select value={mapa[c.key] == null ? -1 : mapa[c.key]}
                      onChange={function(e){ setMapa(Object.assign({}, mapa, { [c.key]: parseInt(e.target.value, 10) })); }}
                      style={{ ...campo, borderColor: c.obrigatorio && vazio ? "#FF5252" : "var(--border)" }}>
                      <option value={-1}>— não importar —</option>
                      {cabecalho.map(function(h,i){ return <option key={i} value={i}>{h || ("coluna " + (i+1))}</option>; })}
                    </select>
                  </div>;
                })}
              </div>
            </div>
            <div style={cartao}>
              <div style={tit}>4. Confira o resultado</div>
              <div style={{ display:"flex", gap:22, flexWrap:"wrap", marginBottom:12 }}>
                <div><div style={{ fontSize:11, color:"var(--text-3)" }}>Entram</div><div style={{ fontSize:20, fontWeight:600, color:FIN_COR.neutro }}>{validas.length}</div></div>
                <div><div style={{ fontSize:11, color:"var(--text-3)" }}>Créditos</div><div style={{ fontSize:20, fontWeight:600, color:FIN_COR.entrada }}>{fmt(entradas)}</div></div>
                <div><div style={{ fontSize:11, color:"var(--text-3)" }}>Débitos</div><div style={{ fontSize:20, fontWeight:600, color:FIN_COR.saida }}>{fmt(saidas)}</div></div>
                <div><div style={{ fontSize:11, color:"var(--text-3)" }}>Com erro</div><div style={{ fontSize:20, fontWeight:600, color: prontas.length - validas.length ? FIN_COR.saida : FIN_COR.fraco }}>{prontas.length - validas.length}</div></div>
              </div>
              <div className="tabela-wrap" style={{ maxHeight:380, overflowY:"auto" }}>
                <table className="tabela">
                  <thead><tr>{["Linha","Situação","Data","Histórico","Entrada","Saída"].map(function(h){ return <th key={h} className="th">{h}</th>; })}</tr></thead>
                  <tbody>{prontas.slice(0,300).map(function(p,i){
                    return <tr key={i} style={{ opacity: p.erros.length ? .55 : 1 }}>
                      <td className="td" style={{ color:"var(--text-4)", width:52 }}>{p.linha}</td>
                      <td className="td">{p.erros.length ? <span style={{ color:FIN_COR.saida, fontSize:11.5 }}>{p.erros.join(", ")}</span> : <span style={{ color:FIN_COR.entrada, fontSize:11.5 }}>ok</span>}</td>
                      <td className="td">{p.item.data ? (fmtDate(p.item.data) || p.item.data) : "—"}</td>
                      <td className="td" style={{ maxWidth:300, color:"var(--text-strong)" }}>{p.item.descricao}</td>
                      <td className="td-num">{p.item.tipo === "entrada" ? fmt(p.item.valor) : "—"}</td>
                      <td className="td-num">{p.item.tipo === "saida" ? fmt(p.item.valor) : "—"}</td>
                    </tr>;
                  })}</tbody>
                </table>
              </div>
            </div>
          </>}
        </div>
      </div>
    </div>
  );
}

// Conciliação: o que o banco diz contra o que o sistema acha.
function ConciliacaoTab({ tab, setTab, periodo, setPeriodo, extrato, salvarExtrato, manuais, salvarManuais,
                          movimentos, contasBancarias, lancamentos, salvarLancamentos }) {
  const [importando, setImportando] = useState(false);
  const [aba, setAba] = useState("divergentes");
  const [fConta, setFConta] = useState("");
  var cutoff = cutoffPeriodo(periodo);
  var nomeConta = {}; (contasBancarias||[]).forEach(function(c){ nomeConta[c.id] = c.nome; });

  var extPeriodo = (extrato || []).filter(function(e){ return e.data >= cutoff && (!fConta || e.conta === fConta); });
  var movPeriodo = (movimentos || []).filter(function(m){ return m.data >= cutoff && (!fConta || m.conta === fConta); });
  var r = conciliar(extPeriodo, movPeriodo, manuais);

  function somar(arr, get){ return arr.reduce(function(s,x){ return s + get(x); }, 0); }
  var difTotal = somar(r.divergentes, function(d){ return d.extrato.valor - d.mov.valor; });

  function importar(itens, conta) {
    var agora = Date.now();
    var novos = itens.map(function(it, i){ return Object.assign({}, it, { id:"ex_"+agora+"_"+i, importadoEm:new Date().toISOString().slice(0,10) }); });
    // Não repete o que já foi importado: mesma conta, data, valor e tipo.
    var jaTem = {};
    (extrato || []).forEach(function(e){ jaTem[[e.conta,e.data,e.valor.toFixed(2),e.tipo].join("|")] = true; });
    var inedito = novos.filter(function(e){ return !jaTem[[e.conta,e.data,e.valor.toFixed(2),e.tipo].join("|")]; });
    salvarExtrato((extrato || []).concat(inedito));
    setImportando(false);
    if (inedito.length < novos.length) {
      window.alert(inedito.length + " lançamento(s) importado(s). " + (novos.length - inedito.length) +
        " já estavam no extrato e foram ignorados.");
    }
  }
  function lancarDoExtrato(e) {
    var l = { id:"lc_"+Date.now(), data:e.data, tipo:e.tipo, categoria:"A classificar",
              descricao:e.descricao, valor:String(e.valor), conta:e.conta, obs:"Criado da conciliação do extrato" };
    salvarLancamentos((lancamentos || []).concat([l]));
  }
  function ignorar(e) { salvarExtrato((extrato || []).map(function(x){ return x.id === e.id ? Object.assign({}, x, { ignorado:true }) : x; })); }
  function conciliarNaMao(eId, movId) { salvarManuais(Object.assign({}, manuais, { [eId]: movId })); }
  function desfazer(eId) { var n = Object.assign({}, manuais); delete n[eId]; salvarManuais(n); }

  var abas = [
    ["divergentes", "Valor diferente", r.divergentes.length, FIN_COR.atencao],
    ["soExtrato",   "Só no banco",     r.soExtrato.length,   FIN_COR.saida],
    ["soSistema",   "Só no sistema",   r.soSistema.length,   FIN_COR.saida],
    ["casadas",     "Conciliados",     r.casadas.length,     FIN_COR.entrada],
  ];

  var acoes = <>
    <AcaoFin tipo="pri" onClick={function(){ setImportando(true); }}>⬆ Importar extrato</AcaoFin>
    <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:12, padding:"12px 14px", fontSize:11.5, color:"var(--text-3)", lineHeight:1.6 }}>
      Casa por <b>valor e data</b>, aceitando até {TOLERANCIA_DIAS} dias de diferença — banco lança em D+1.
      Valor até {Math.round(TOLERANCIA_DIVERGENCIA*100)}% distante do esperado vira <b>divergência</b>, não duas
      linhas soltas: um repasse que veio menor é um problema a resolver, não dois lançamentos órfãos.
    </div>
  </>;

  if (!(extrato || []).length) {
    return <FinanceiroShell tab={tab} setTab={setTab} titulo="Conciliação"
      sub="O que caiu na conta contra o que o sistema acha que aconteceu." acoes={acoes}>
      <VazioFin icone="🧮" titulo="Nenhum extrato importado ainda."
        texto={<>Baixe o extrato do seu banco em CSV ou Excel e importe aqui. O sistema casa cada lançamento com o que já conhece — contas pagas, recebimentos confirmados e lançamentos — e mostra o que <b>não</b> bate: repasse que veio menor, conta paga que ninguém registrou, lançamento que o banco nunca viu.</>}
        acao="⬆ Importar extrato" onAcao={function(){ setImportando(true); }} />
      {importando && <ImportarExtratoModal contasBancarias={contasBancarias} onImportar={importar} onClose={function(){ setImportando(false); }} />}
    </FinanceiroShell>;
  }

  return (
    <FinanceiroShell tab={tab} setTab={setTab} titulo="Conciliação"
      sub="O que caiu na conta contra o que o sistema acha que aconteceu."
      periodo={periodo} setPeriodo={setPeriodo}
      controles={(contasBancarias||[]).length > 1
        ? <select value={fConta} onChange={function(e){ setFConta(e.target.value); }}
            style={{ background:"var(--surface)", border:"1px solid var(--border)", color:"var(--text-2)", padding:"7px 10px", borderRadius:8, fontSize:12.5 }}>
            <option value="">Todas as contas</option>
            {(contasBancarias||[]).map(function(c){ return <option key={c.id} value={c.id}>{c.nome}</option>; })}
          </select>
        : null}
      kpis={[
        { rotulo:"Conciliados", valor:String(r.casadas.length), cor:FIN_COR.entrada, nota:fmt(somar(r.casadas, function(c){ return c.extrato.valor; })) },
        { rotulo:"Valor diferente", valor:String(r.divergentes.length), cor: r.divergentes.length ? FIN_COR.atencao : FIN_COR.fraco,
          nota: r.divergentes.length ? (difTotal >= 0 ? "+" : "−") + fmt(Math.abs(difTotal)) + " no banco" : "nenhuma" },
        { rotulo:"Só no banco", valor:String(r.soExtrato.length), cor: r.soExtrato.length ? FIN_COR.saida : FIN_COR.fraco, nota:"falta lançar no sistema" },
        { rotulo:"Só no sistema", valor:String(r.soSistema.length), cor: r.soSistema.length ? FIN_COR.saida : FIN_COR.fraco, nota:"o banco não confirma" },
      ]}
      acoes={acoes}>

      <div className="scroll-x" style={{ display:"flex", gap:6, marginBottom:12 }}>
        {abas.map(function(a){
          var on = aba === a[0];
          return <button key={a[0]} onClick={function(){ setAba(a[0]); }}
            style={{ padding:"7px 14px", borderRadius:8, border:"1px solid " + (on ? a[3] : "var(--border)"), cursor:"pointer", fontSize:12.5, fontWeight:600,
                     background: on ? "var(--surface-3)" : "var(--surface)", color: on ? a[3] : "var(--text-3)", whiteSpace:"nowrap" }}>
            {a[1]} <span style={{ opacity:.75 }}>({a[2]})</span>
          </button>;
        })}
      </div>

      {aba === "divergentes" && (r.divergentes.length === 0
        ? <VazioFin icone="✓" titulo="Nada com valor diferente." texto="Todo lançamento que casou veio pelo valor exato que o sistema esperava." />
        : <div className="tabela-wrap"><table className="tabela">
            <thead><tr>{["Data","No banco","Valor no banco","No sistema","Valor esperado","Diferença",""].map(function(h){ return <th key={h} className="th">{h}</th>; })}</tr></thead>
            <tbody>{r.divergentes.map(function(d,i){
              var dif = d.extrato.valor - d.mov.valor;
              return <tr key={i}>
                <td className="td">{fmtDate(d.extrato.data) || d.extrato.data}</td>
                <td className="td" style={{ color:"var(--text-strong)", maxWidth:220 }}>{d.extrato.descricao}</td>
                <td className="td-num">{fmt(d.extrato.valor)}</td>
                <td className="td" style={{ maxWidth:220 }}>{d.mov.descricao}</td>
                <td className="td-num">{fmt(d.mov.valor)}</td>
                <td className="td-num" style={{ fontWeight:700, color: dif < 0 ? FIN_COR.saida : FIN_COR.entrada }}>{(dif >= 0 ? "+" : "−") + fmt(Math.abs(dif))}</td>
                <td className="td" style={{ textAlign:"right" }}>
                  {d.manual && <button onClick={function(){ desfazer(d.extrato.id); }} style={{ background:"var(--surface-3)", border:"none", color:"var(--text-2)", fontSize:11, fontWeight:600, padding:"4px 9px", borderRadius:6, cursor:"pointer" }}>Desfazer</button>}
                </td>
              </tr>;
            })}</tbody>
          </table></div>)}

      {aba === "soExtrato" && (r.soExtrato.length === 0
        ? <VazioFin icone="✓" titulo="Nada solto no banco." texto="Todo lançamento do extrato encontrou par no sistema." />
        : <div className="tabela-wrap"><table className="tabela">
            <thead><tr>{["Data","Histórico","Conta","Entrada","Saída","Ações"].map(function(h){ return <th key={h} className="th">{h}</th>; })}</tr></thead>
            <tbody>{r.soExtrato.map(function(e){
              return <tr key={e.id}>
                <td className="td">{fmtDate(e.data) || e.data}</td>
                <td className="td" style={{ color:"var(--text-strong)", maxWidth:320 }}>{e.descricao}</td>
                <td className="td">{nomeConta[e.conta] || "—"}</td>
                <td className="td-num">{e.tipo === "entrada" ? <span style={{ color:FIN_COR.entrada }}>{fmt(e.valor)}</span> : "—"}</td>
                <td className="td-num">{e.tipo === "saida" ? <span style={{ color:FIN_COR.saida }}>{fmt(e.valor)}</span> : "—"}</td>
                <td className="td" style={{ textAlign:"right", whiteSpace:"nowrap" }}>
                  <button onClick={function(){ lancarDoExtrato(e); }} style={{ background:"rgba(10,157,78,.12)", border:"none", color:"var(--ui-accent)", fontSize:11, fontWeight:600, padding:"4px 9px", borderRadius:6, cursor:"pointer", marginRight:6 }}>Lançar</button>
                  <button onClick={function(){ ignorar(e); }} style={{ background:"var(--surface-3)", border:"none", color:"var(--text-3)", fontSize:11, fontWeight:600, padding:"4px 9px", borderRadius:6, cursor:"pointer" }}>Ignorar</button>
                </td>
              </tr>;
            })}</tbody>
          </table></div>)}

      {aba === "soSistema" && (r.soSistema.length === 0
        ? <VazioFin icone="✓" titulo="Nada solto no sistema." texto="Todo movimento registrado aqui apareceu no extrato." />
        : <div className="tabela-wrap"><table className="tabela">
            <thead><tr>{["Data","Movimento","Origem","Conta","Entrada","Saída","Conciliar com"].map(function(h){ return <th key={h} className="th">{h}</th>; })}</tr></thead>
            <tbody>{r.soSistema.map(function(m){
              var candidatos = r.soExtrato.filter(function(e){ return e.tipo === m.tipo && diffDias(e.data, m.data) <= 15; });
              return <tr key={m.id}>
                <td className="td">{fmtDate(m.data) || m.data}</td>
                <td className="td" style={{ color:"var(--text-strong)", maxWidth:260 }}>{m.descricao}</td>
                <td className="td" style={{ fontSize:11.5, color:"var(--text-3)" }}>{ROTULO_ORIGEM[m.origem] || m.origem}</td>
                <td className="td">{nomeConta[m.conta] || <span style={{ color:FIN_COR.atencao, fontSize:12 }}>sem conta</span>}</td>
                <td className="td-num">{m.tipo === "entrada" ? <span style={{ color:FIN_COR.entrada }}>{fmt(m.valor)}</span> : "—"}</td>
                <td className="td-num">{m.tipo === "saida" ? <span style={{ color:FIN_COR.saida }}>{fmt(m.valor)}</span> : "—"}</td>
                <td className="td" style={{ minWidth:200 }}>
                  {candidatos.length === 0
                    ? <span style={{ fontSize:11.5, color:"var(--text-4)" }}>nenhum candidato no extrato</span>
                    : <select defaultValue="" onChange={function(e){ if (e.target.value) conciliarNaMao(e.target.value, m.id); }}
                        style={{ width:"100%", background:"var(--bg)", border:"1px solid var(--border)", color:"var(--text-2)", padding:"5px 8px", borderRadius:6, fontSize:11.5 }}>
                        <option value="">— escolher —</option>
                        {candidatos.map(function(e){ return <option key={e.id} value={e.id}>{(fmtDate(e.data)||e.data) + " · " + fmt(e.valor) + " · " + e.descricao.slice(0,28)}</option>; })}
                      </select>}
                </td>
              </tr>;
            })}</tbody>
          </table></div>)}

      {aba === "casadas" && (r.casadas.length === 0
        ? <VazioFin icone="🧮" titulo="Nenhum lançamento conciliado no período." texto="Importe o extrato do período ou amplie o intervalo acima." />
        : <div className="tabela-wrap"><table className="tabela">
            <thead><tr>{["Data","No banco","No sistema","Origem","Valor",""].map(function(h){ return <th key={h} className="th">{h}</th>; })}</tr></thead>
            <tbody>{r.casadas.map(function(c,i){
              return <tr key={i}>
                <td className="td">{fmtDate(c.extrato.data) || c.extrato.data}</td>
                <td className="td" style={{ maxWidth:250, color:"var(--text-strong)" }}>{c.extrato.descricao}</td>
                <td className="td" style={{ maxWidth:250 }}>{c.mov.descricao}</td>
                <td className="td" style={{ fontSize:11.5, color:"var(--text-3)" }}>{ROTULO_ORIGEM[c.mov.origem] || c.mov.origem}</td>
                <td className="td-num" style={{ color: c.mov.tipo === "entrada" ? FIN_COR.entrada : FIN_COR.saida }}>{fmt(c.mov.valor)}</td>
                <td className="td" style={{ textAlign:"right", fontSize:11, color:"var(--text-4)" }}>{c.manual ? "conciliado à mão" : ""}</td>
              </tr>;
            })}</tbody>
          </table></div>)}

      {importando && <ImportarExtratoModal contasBancarias={contasBancarias} onImportar={importar} onClose={function(){ setImportando(false); }} />}
    </FinanceiroShell>
  );
}

// ── Esqueleto comum do Financeiro ──────────────────────────────────────────
// Oito telas, cada uma com o seu próprio jeito: uma punha os totais na coluna
// da direita, outra no topo, outra misturava; o período tinha nome diferente em
// cada uma e se perdia ao trocar de aba. Quem usa reaprendia a tela a cada
// clique. Daqui em diante todas passam por aqui.

// Cor com significado fixo. Antes o âmbar aparecia em custo, em taxa e em
// alerta ao mesmo tempo, o que esvazia o sinal: se tudo é atenção, nada é.
const FIN_COR = {
  entrada: "#0a9d4e",           // dinheiro que entra, conta recebida
  saida:   "#FF5252",           // dinheiro que sai, conta vencida, saldo negativo
  atencao: "#FFC107",           // só o que precisa de decisão
  neutro:  "var(--text-strong)",// valores sem polaridade
  fraco:   "var(--text-3)",     // ausência de valor
};

// A ordem é a do dia de trabalho: primeiro o que eu tenho e vou ter, depois o
// que devo, depois o que me devem, e por último o que já aconteceu.
const ABAS_FINANCEIRO = [
  { key:"fluxo_caixa",           label:"Fluxo de caixa" },
  { key:"bancos",                label:"Caixas e bancos" },
  { key:"contas_pagar",          label:"Contas a pagar" },
  { key:"prioridade_pagamento",  label:"Prioridade" },
  { key:"contas_receber",        label:"Contas a receber" },
  { key:"lancamentos",           label:"Lançamentos" },
  { key:"dre",                   label:"DRE" },
  { key:"conciliacao",           label:"Conciliação" },
  { key:"impostos",              label:"Impostos" },
];

// Períodos retroativos, usados pelas telas que olham para trás. O horizonte das
// que olham para frente é outro conceito e tem os seus próprios botões — juntar
// os dois num controle só faria "30 dias" significar coisas diferentes por aba.
var PERIODOS_FIN = [["7","7 dias"],["30","30 dias"],["90","90 dias"],["tudo","Tudo"]];

function KpiFin({ rotulo, valor, cor, nota }) {
  return (
    <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:12, padding:"13px 16px", minWidth:0 }}>
      <div style={{ fontSize:11.5, color:"var(--text-3)", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{rotulo}</div>
      <div style={{ fontSize:21, fontWeight:600, color: cor || FIN_COR.neutro, marginTop:2, fontVariantNumeric:"tabular-nums" }}>{valor}</div>
      {nota && <div style={{ fontSize:10.5, color:"var(--text-4)", marginTop:2, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{nota}</div>}
    </div>
  );
}

// props:
//   tab/setTab        aba atual do módulo
//   titulo, sub       cabeçalho da tela
//   periodo/setPeriodo  quando a tela olha para trás (compartilhado entre elas)
//   controles         nós extras no topo (horizonte, ajustes, exportar)
//   kpis              [{ rotulo, valor, cor, nota }] — sempre na mesma faixa
//   acoes             nós da coluna da direita — sempre no mesmo lugar
//   largura           limite de largura do corpo
function FinanceiroShell({ tab, setTab, titulo, sub, periodo, setPeriodo, controles, kpis, acoes, largura, children }) {
  // A coluna de ações some e volta por escolha do usuário, e a escolha fica
  // guardada: numa tela de tabela larga, 236px de lado fazem diferença. O
  // parâmetro `largura` deixou de existir na prática — travar o conteúdo em
  // 1.280px numa tela de 1.920 deixava um terço da tela vazio enquanto as
  // colunas se espremiam.
  const [acoesAbertas, setAcoesAbertas] = useState(function(){
    try { return localStorage.getItem("fin_acoes_ocultas") !== "1"; } catch { return true; }
  });
  function alternarAcoes(){
    setAcoesAbertas(function(v){
      var novo = !v;
      try { localStorage.setItem("fin_acoes_ocultas", novo ? "0" : "1"); } catch(e) {}
      return novo;
    });
  }
  return (
    <div style={{ padding:2, width:"100%" }}>
      <div style={{ display:"flex", alignItems:"flex-start", gap:12, marginBottom:12, flexWrap:"wrap" }}>
        <div style={{ minWidth:0 }}>
          <div style={{ fontWeight:600, fontSize:20, color:"var(--text-strong)" }}>{titulo}</div>
          {sub && <div style={{ fontSize:12.5, color:"var(--text-3)", marginTop:2 }}>{sub}</div>}
        </div>
        <div style={{ flex:1 }} />
        <div style={{ display:"flex", gap:6, alignItems:"center", flexWrap:"wrap" }}>
          {acoes && (
            <button onClick={alternarAcoes} title={acoesAbertas ? "Ocultar a coluna de ações" : "Mostrar a coluna de ações"}
              style={{ padding:"7px 12px", borderRadius:8, border:"1px solid var(--border)", cursor:"pointer", fontSize:12, fontWeight:600,
                       background: acoesAbertas ? "rgba(118,133,146,.14)" : "var(--surface)", color:"var(--text-2)" }}>
              {acoesAbertas ? "⟩ Ocultar ações" : "⟨ Ações"}
            </button>
          )}
          {setPeriodo && PERIODOS_FIN.map(function(p){
            var on = periodo === p[0];
            return <button key={p[0]} onClick={function(){ setPeriodo(p[0]); }}
              style={{ padding:"7px 14px", borderRadius:8, border:"1px solid var(--border)", cursor:"pointer", fontSize:12, fontWeight:600,
                       background: on ? "#768692" : "var(--surface)", color: on ? "#fff" : "var(--text-3)" }}>{p[1]}</button>;
          })}
          {controles || null}
        </div>
      </div>

      <div className="scroll-x" style={{ display:"flex", gap:2, marginBottom:14, borderBottom:"1px solid var(--border)" }}>
        {ABAS_FINANCEIRO.map(function(a){
          var on = tab === a.key;
          return <button key={a.key} onClick={function(){ if (!on) setTab(a.key); }}
            style={{ background:"none", border:"none", borderBottom: on ? "2px solid var(--ui-accent)" : "2px solid transparent",
                     color: on ? "var(--text-strong)" : "var(--text-3)", fontWeight: on ? 600 : 500,
                     padding:"9px 13px", cursor: on ? "default" : "pointer", fontSize:13, whiteSpace:"nowrap" }}>{a.label}</button>;
        })}
      </div>

      {kpis && kpis.length > 0 && (
        <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(170px,1fr))", gap:12, marginBottom:14 }}>
          {kpis.map(function(k,i){ return <KpiFin key={i} rotulo={k.rotulo} valor={k.valor} cor={k.cor} nota={k.nota} />; })}
        </div>
      )}

      <div style={{ display:"flex", gap:14, alignItems:"flex-start" }}>
        <div style={{ flex:1, minWidth:0 }}>{children}</div>
        {acoes && acoesAbertas && <div className="mod-acoes">{acoes}</div>}
      </div>
    </div>
  );
}

// Botão da coluna de ações, para elas não divergirem de novo tela a tela.
function AcaoFin({ onClick, children, tipo }) {
  var estilo = tipo === "pri"
    ? { background:"var(--ui-accent)", border:"none", color:"var(--ui-accent-text)", fontWeight:600, fontSize:13.5 }
    : { background:"var(--surface)", border:"1px solid var(--border)", color:"var(--text-2)", fontWeight:600, fontSize:13 };
  return <button onClick={onClick} style={Object.assign({ padding:"11px", borderRadius:9, cursor:"pointer", width:"100%" }, estilo)}>{children}</button>;
}

// Tela vazia que ensina, no lugar de "Nenhum resultado encontrado".
function VazioFin({ icone, titulo, texto, acao, onAcao }) {
  return (
    <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:12, padding:"54px 24px", textAlign:"center" }}>
      <div style={{ fontSize:36, marginBottom:10 }}>{icone || "🗎"}</div>
      <div style={{ fontWeight:600, fontSize:16, color:"var(--text-strong)" }}>{titulo}</div>
      <div style={{ fontSize:13.5, color:"var(--text-3)", marginTop:8, lineHeight:1.65, maxWidth:540, margin:"8px auto 0" }}>{texto}</div>
      {acao && onAcao && <button onClick={onAcao}
        style={{ marginTop:18, background:"var(--ui-accent)", border:"none", color:"var(--ui-accent-text)", fontWeight:600, padding:"10px 24px", borderRadius:9, cursor:"pointer", fontSize:13 }}>{acao}</button>}
    </div>
  );
}

// ── Fluxo de caixa ─────────────────────────────────────────────────────────
// Projeção dia a dia do saldo. Diferente do DRE de propósito: o DRE só conta o
// repasse que você CONFIRMOU, porque olha para trás e precisa ser exato. A
// projeção olha para frente, onde não existe nada confirmado — ela usa a data
// prevista de liberação do Mercado Livre. São perguntas diferentes, e a tela diz isso.
function somarDias(iso, n) {
  var d = new Date(iso + "T12:00:00");
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

function projetarFluxo(opts) {
  var hoje = opts.hoje || new Date().toISOString().slice(0, 10);
  var fim = somarDias(hoje, opts.dias || 30);
  var adiam = opts.adiamentos || {};
  var eventos = [];

  // Saídas: contas em aberto. Uma conta já vencida não fica no passado — ela
  // ainda vai sair do caixa, e o dia mais cedo possível é hoje.
  (opts.contasPagar || []).forEach(function(c){
    if (c.status === "cancelada") return;
    var v = saldoDe(c);        // só o saldo devedor ainda vai sair do caixa
    if (v <= 0) return;
    var base = c.vencimento || hoje;
    if (base < hoje) base = hoje;
    var d = adiam[c.id] ? somarDias(base, adiam[c.id]) : base;
    if (d > fim) return;
    eventos.push({ data:d, tipo:"saida", valor:v, descricao:c.descricao || "(sem fornecedor)",
                   categoria:c.categoria || "Outros", origem:"conta_pagar", refId:c.id,
                   vencida: (c.vencimento || "") < hoje, adiada: !!adiam[c.id] });
  });

  // Entradas: repasses ainda não confirmados, na data prevista pelo ML. Um
  // repasse cuja data já passou e que você não confirmou entra hoje — o dinheiro
  // não some, só está atrasado em relação ao anunciado.
  //
  // Pedido SEM data prevista fica de fora. Chutar que cai hoje seria o erro mais
  // caro que esta tela pode cometer: infla o saldo, esconde o dia em que o caixa
  // acaba, e o usuário só descobre quando o pagamento volta. O total não
  // projetado é devolvido para a tela dizer quanto é.
  var semPrevisao = 0, nSemPrevisao = 0;
  (opts.enrichedOrders || []).forEach(function(o){
    if (o.status === "cancelled") return;
    if ((opts.recebiveisBaixados || {})[String(o.id)]) return;   // já entrou no saldo
    // Mesmo liquido que Contas a receber mostra: bruto menos a taxa do ML menos
    // o frete. Antes vinha do netAmount da API, que tinha outra base — as duas
    // telas mostrariam valores diferentes para o mesmo dinheiro.
    var pay = (opts.paymentData || {})[String(o.id)];
    var q = o.qty || 1;
    var v = Math.max(0, (o.price || 0) * q - (o.fee || 0) * q - (o.freteSeller || 0));
    if (v <= 0) return;
    var prev = pay && pay.releaseDate ? String(pay.releaseDate).slice(0,10) : "";
    if (!prev) { semPrevisao += v; nSemPrevisao++; return; }
    var d = prev < hoje ? hoje : prev;
    if (d > fim) return;
    eventos.push({ data:d, tipo:"entrada", valor:v, descricao:"Repasse ML · pedido #" + o.id,
                   categoria:"Vendas", origem:"recebivel", refId:o.id });
  });

  // Lançamentos manuais agendados para o futuro.
  (opts.lancamentos || []).forEach(function(l){
    var d = String(l.data || "").slice(0,10);
    var v = parseFloat(l.valor) || 0;
    if (!d || d <= hoje || d > fim || v <= 0) return;
    eventos.push({ data:d, tipo: l.tipo === "entrada" ? "entrada" : "saida", valor:v,
                   descricao:l.descricao || "(lançamento)", categoria:l.categoria || "Outros", origem:"manual", refId:l.id });
  });

  // Custos fixos previstos. Só os de valor em R$: os definidos como % do
  // faturamento dependem de uma venda que ainda não aconteceu, e projetá-los
  // seria inventar receita para justificar despesa.
  if (opts.incluirFixos) {
    var mensal = (opts.custosFixos || []).filter(function(c){ return c.tipo !== "%"; })
      .reduce(function(s,c){ return s + (parseFloat(c.valor) || 0); }, 0);
    if (mensal > 0) {
      var dia = Math.min(28, Math.max(1, parseInt(opts.diaFixos, 10) || 5));
      var cursor = new Date(hoje + "T12:00:00");
      cursor.setDate(1);
      for (var m = 0; m < 14; m++) {
        var iso = cursor.getFullYear() + "-" + String(cursor.getMonth()+1).padStart(2,"0") + "-" + String(dia).padStart(2,"0");
        if (iso > hoje && iso <= fim) {
          eventos.push({ data:iso, tipo:"saida", valor:mensal, descricao:"Custos fixos do mês (previsto)",
                         categoria:"Custos fixos", origem:"previsto" });
        }
        cursor.setMonth(cursor.getMonth() + 1);
      }
    }
  }

  // Agrupa por dia e vai acumulando o saldo.
  var porDia = {};
  eventos.forEach(function(e){
    if (!porDia[e.data]) porDia[e.data] = { data:e.data, entradas:0, saidas:0, itens:[] };
    porDia[e.data][e.tipo === "entrada" ? "entradas" : "saidas"] += e.valor;
    porDia[e.data].itens.push(e);
  });

  var entradaRepasses = 0, nRepasses = 0;
  eventos.forEach(function(e){ if (e.origem === "recebivel") { entradaRepasses += e.valor; nRepasses++; } });
  var linha = [], saldo = parseFloat(opts.saldoInicial) || 0;
  var d2 = hoje;
  while (d2 <= fim) {
    var dia2 = porDia[d2] || { data:d2, entradas:0, saidas:0, itens:[] };
    saldo += dia2.entradas - dia2.saidas;
    linha.push({ data:d2, entradas:dia2.entradas, saidas:dia2.saidas, saldo:saldo,
                 itens:dia2.itens.sort(function(a,b){ return b.valor - a.valor; }) });
    d2 = somarDias(d2, 1);
  }
  var primeiroNegativo = linha.find(function(x){ return x.saldo < 0; });
  var menor = linha.reduce(function(a,b){ return b.saldo < a.saldo ? b : a; }, linha[0]);
  return {
    linha: linha,
    entradas: linha.reduce(function(s,x){ return s + x.entradas; }, 0),
    saidas: linha.reduce(function(s,x){ return s + x.saidas; }, 0),
    saldoFinal: linha.length ? linha[linha.length-1].saldo : (parseFloat(opts.saldoInicial) || 0),
    primeiroNegativo: primeiroNegativo || null,
    menor: menor || null,
    semPrevisao: semPrevisao, nSemPrevisao: nSemPrevisao,
    entradaRepasses: entradaRepasses, nRepasses: nRepasses,
  };
}

// Fluxo de caixa: o saldo dia a dia daqui para frente, e o dia em que ele acaba.
function FluxoCaixaTab({ saldoEmCaixa, temContasBancarias, contasPagar, enrichedOrders, paymentData,
                         recebiveisBaixados, lancamentos, custosFixos, setTab, tab }) {
  const [dias, setDias] = useState(30);
  const [incluirFixos, setIncluirFixos] = useState(true);
  const [diaFixos, setDiaFixos] = useState(5);
  const [adiamentos, setAdiamentos] = useState({});   // simulação, não é gravada
  const [diaAberto, setDiaAberto] = useState(null);
  var hoje = new Date().toISOString().slice(0, 10);

  var proj = projetarFluxo({
    hoje: hoje, dias: dias, saldoInicial: saldoEmCaixa || 0,
    contasPagar: contasPagar, enrichedOrders: enrichedOrders, paymentData: paymentData,
    recebiveisBaixados: recebiveisBaixados, lancamentos: lancamentos,
    custosFixos: custosFixos, incluirFixos: incluirFixos, diaFixos: diaFixos,
    adiamentos: adiamentos,
  });
  // Sem adiamento nenhum, para mostrar o efeito da simulação.
  var base = projetarFluxo({
    hoje: hoje, dias: dias, saldoInicial: saldoEmCaixa || 0,
    contasPagar: contasPagar, enrichedOrders: enrichedOrders, paymentData: paymentData,
    recebiveisBaixados: recebiveisBaixados, lancamentos: lancamentos,
    custosFixos: custosFixos, incluirFixos: incluirFixos, diaFixos: diaFixos, adiamentos: {},
  });
  var simulando = Object.keys(adiamentos).length > 0;

  var dadosGrafico = proj.linha.map(function(d){
    return { dia: fmtDiaCurto(d.data), data: d.data, Saldo: Math.round(d.saldo * 100) / 100 };
  });
  var comMovimento = proj.linha.filter(function(d){ return d.entradas > 0 || d.saidas > 0; });
  // Saídas ainda não pagas, para a simulação de adiamento.
  var saidasFuturas = [];
  // O que forma as entradas do período. Um total sozinho não dá para conferir:
  // aqui o usuário vê pedido a pedido de onde o dinheiro deve vir e quando.
  var entradasFuturas = [];
  proj.linha.forEach(function(d){
    d.itens.forEach(function(i){
      if (i.tipo === "saida" && i.origem === "conta_pagar") saidasFuturas.push(Object.assign({ dia:d.data }, i));
      else if (i.tipo === "entrada") entradasFuturas.push(Object.assign({ dia:d.data }, i));
    });
  });

  function adiar(id, d){
    setAdiamentos(function(a){
      var n = Object.assign({}, a);
      if (!d) delete n[id]; else n[id] = d;
      return n;
    });
  }

  var cartao = { background:"var(--surface)", border:"1px solid var(--border)", borderRadius:12, padding:"16px 18px" };
  var COR_SALDO = "#768692", COR_RUIM = "#FF5252", COR_BOM = "#0a9d4e";

  // O horizonte olha para frente; o período do módulo olha para trás. São
  // controles diferentes de propósito — "30 dias" não pode significar duas
  // coisas conforme a aba.
  var horizonte = [30,60,90].map(function(n){
    var on = dias === n;
    return <button key={n} onClick={function(){ setDias(n); setDiaAberto(null); }}
      style={{ padding:"7px 14px", borderRadius:8, border:"1px solid var(--border)", cursor:"pointer", fontSize:12, fontWeight:600,
               background: on ? "#768692" : "var(--surface)", color: on ? "#fff" : "var(--text-3)" }}>{n} dias</button>;
  });

  if (!temContasBancarias) {
    return <FinanceiroShell tab={tab} setTab={setTab} titulo="Fluxo de caixa"
      sub="Saldo projetado dia a dia, a partir do que você tem hoje.">
      <VazioFin icone="📈" titulo="Falta dizer de onde a projeção parte."
        texto={<>A projeção é o saldo de hoje mais o que entra e sai a cada dia. Sem nenhuma conta em <b>Caixas e bancos</b>, não há saldo de hoje — e uma projeção que começa do zero não diz nada.</>}
        acao="Cadastrar contas →" onAcao={function(){ setTab("bancos"); }} />
    </FinanceiroShell>;
  }

  return (
    <FinanceiroShell tab={tab} setTab={setTab} titulo="Fluxo de caixa"
      sub="Saldo projetado dia a dia, a partir do que você tem hoje."
      controles={horizonte}
      kpis={[
        { rotulo:"Saldo hoje", valor:fmt(saldoEmCaixa || 0), cor:(saldoEmCaixa||0) >= 0 ? FIN_COR.neutro : FIN_COR.saida, nota:"de Caixas e bancos" },
        { rotulo:"Entra em " + dias + " dias", valor:fmt(proj.entradas), cor:FIN_COR.entrada,
          nota: proj.nRepasses ? proj.nRepasses + " repasse(s) do ML · " + fmt(proj.entradaRepasses) : "nenhum repasse previsto" },
        { rotulo:"Sai em " + dias + " dias", valor:fmt(proj.saidas), cor:FIN_COR.saida, nota:incluirFixos ? "contas e custos fixos" : "contas a pagar" },
        { rotulo:"Saldo ao fim", valor:fmt(proj.saldoFinal), cor:proj.saldoFinal >= 0 ? FIN_COR.entrada : FIN_COR.saida,
          nota:proj.menor ? "menor: " + fmt(proj.menor.saldo) + " em " + (fmtDate(proj.menor.data)||proj.menor.data) : "" },
      ]}>
      {proj.primeiroNegativo && (
        <div style={{ background:"rgba(255,82,82,.10)", border:"1px solid rgba(255,82,82,.5)", borderRadius:10, padding:"12px 16px", marginBottom:14, fontSize:13.5, color:"var(--text-2)", lineHeight:1.6 }}>
          <b style={{ color:COR_RUIM }}>O caixa fica negativo em {fmtDate(proj.primeiroNegativo.data) || proj.primeiroNegativo.data}</b>
          {" "}— saldo de {fmt(proj.primeiroNegativo.saldo)} naquele dia. Adie ou negocie alguma saída antes dessa data,
          ou antecipe entrada. Use a simulação abaixo para ver o efeito.
        </div>
      )}

      <ChartCard
        titulo="Saldo projetado"
        sub={"Do saldo de hoje até " + (fmtDate(somarDias(hoje, dias)) || somarDias(hoje, dias)) + (simulando ? " · com os adiamentos simulados" : "")}
        flex={null} minW={0}>
        <ResponsiveContainer width="100%" height={300}>
          <AreaChart data={dadosGrafico} margin={{ top:24, right:16, left:6, bottom:0 }}>
            <defs>
              <linearGradient id="gradSaldo" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={COR_SALDO} stopOpacity={0.30} />
                <stop offset="100%" stopColor={COR_SALDO} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID} vertical={false} />
            <XAxis dataKey="dia" tick={{ fill:CHART_AXIS, fontSize:11 }} tickLine={false} axisLine={false} minTickGap={26} />
            <YAxis tick={{ fill:CHART_AXIS, fontSize:11 }} tickLine={false} axisLine={false}
              tickFormatter={function(v){ return (v < 0 ? "-" : "") + "R$" + (Math.abs(v)>=1000 ? (Math.abs(v)/1000).toFixed(0)+"k" : Math.abs(v)); }} />
            <RTooltip content={<TipMoeda />} cursor={{ stroke:CHART_AXIS, strokeWidth:1 }} />
            <ReferenceLine y={0} stroke={COR_RUIM} strokeWidth={1.5} strokeDasharray="4 3" />
            {proj.primeiroNegativo && (
              <ReferenceLine x={fmtDiaCurto(proj.primeiroNegativo.data)} stroke={COR_RUIM} strokeWidth={1.5}
                label={{ value:"caixa acaba", position:"top", fill:COR_RUIM, fontSize:11 }} />
            )}
            <Area type="monotone" dataKey="Saldo" stroke={COR_SALDO} strokeWidth={2} fill="url(#gradSaldo)" dot={false}
              activeDot={{ r:5, strokeWidth:2, stroke:"var(--surface)" }} />
          </AreaChart>
        </ResponsiveContainer>
      </ChartCard>

      <div style={{ display:"flex", gap:14, flexWrap:"wrap", alignItems:"flex-start", marginTop:14 }}>
        <div style={{ ...cartao, flex:2, minWidth:420 }}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"baseline", marginBottom:4, gap:10, flexWrap:"wrap" }}>
            <div style={{ fontSize:13.5, fontWeight:600, color:"var(--text-strong)" }}>Dias com movimento</div>
            <label style={{ display:"flex", alignItems:"center", gap:7, fontSize:12, color:"var(--text-3)", cursor:"pointer" }}>
              <input type="checkbox" checked={incluirFixos} onChange={function(e){ setIncluirFixos(e.target.checked); }} />
              incluir custos fixos previstos, dia
              <input type="number" min="1" max="28" value={diaFixos} onChange={function(e){ setDiaFixos(e.target.value); }}
                style={{ width:52, background:"var(--bg)", border:"1px solid var(--border)", color:"var(--text-strong)", padding:"3px 6px", borderRadius:6, fontSize:12 }} />
            </label>
          </div>
          <div style={{ fontSize:11.5, color:"var(--text-3)", marginBottom:10 }}>Clique num dia para ver o que compõe.</div>
          {comMovimento.length === 0
            ? <div style={{ fontSize:13, color:"var(--text-3)", padding:"18px 0" }}>Nenhuma entrada ou saída prevista nos próximos {dias} dias.</div>
            : <div className="tabela-wrap" style={{ maxHeight:400, overflowY:"auto" }}>
                <table className="tabela">
                  <thead><tr>{["Dia","Entradas","Saídas","Saldo no fim do dia"].map(function(h){ return <th key={h} className="th">{h}</th>; })}</tr></thead>
                  <tbody>
                    {comMovimento.map(function(d){
                      var neg = d.saldo < 0;
                      var aberto = diaAberto === d.data;
                      return <React.Fragment key={d.data}>
                        <tr onClick={function(){ setDiaAberto(aberto ? null : d.data); }} style={{ cursor:"pointer", background: neg ? "rgba(255,82,82,.07)" : "transparent" }}>
                          <td className="td">{aberto ? "▾ " : "▸ "}{fmtDate(d.data) || d.data}</td>
                          <td className="td-num">{d.entradas > 0 ? <span style={{ color:COR_BOM }}>{fmt(d.entradas)}</span> : "—"}</td>
                          <td className="td-num">{d.saidas > 0 ? <span style={{ color:COR_RUIM }}>{fmt(d.saidas)}</span> : "—"}</td>
                          <td className="td-num" style={{ fontWeight:700, color: neg ? COR_RUIM : "var(--text-strong)" }}>{fmt(d.saldo)}</td>
                        </tr>
                        {aberto && d.itens.map(function(i,k){
                          return <tr key={k} style={{ background:"var(--surface-3)" }}>
                            <td className="td" style={{ paddingLeft:30, fontSize:12, color:"var(--text-2)" }} colSpan={2}>
                              {i.descricao}
                              {i.vencida && <span style={{ marginLeft:6, fontSize:10, color:COR_RUIM }}>vencida</span>}
                              {i.adiada && <span style={{ marginLeft:6, fontSize:10, color:"#FFC107" }}>adiada na simulação</span>}
                              {i.origem === "previsto" && <span style={{ marginLeft:6, fontSize:10, color:"var(--text-4)" }}>previsto, não lançado</span>}
                            </td>
                            <td className="td" style={{ fontSize:12, color:"var(--text-3)" }}>{i.categoria}</td>
                            <td className="td-num" style={{ fontSize:12, color: i.tipo === "entrada" ? COR_BOM : COR_RUIM }}>
                              {(i.tipo === "entrada" ? "+" : "-") + fmt(i.valor).replace("R$ ", "R$ ")}
                            </td>
                          </tr>;
                        })}
                      </React.Fragment>;
                    })}
                  </tbody>
                </table>
              </div>}
        </div>

        <div style={{ ...cartao, flex:1, minWidth:320 }}>
          <div style={{ fontSize:13.5, fontWeight:600, color:"var(--text-strong)", marginBottom:4 }}>Entradas previstas</div>
          <div style={{ fontSize:11.5, color:"var(--text-3)", marginBottom:12, lineHeight:1.55 }}>
            Repasses do Mercado Livre já vendidos, pelo líquido — venda menos taxa e frete — na data que o ML informou.
          </div>
          {entradasFuturas.length === 0
            ? <div style={{ fontSize:13, color:"var(--text-3)" }}>Nenhuma entrada prevista no horizonte.</div>
            : <div style={{ display:"flex", flexDirection:"column", gap:9, maxHeight:330, overflowY:"auto" }}>
                {entradasFuturas.slice(0, 30).map(function(i,k){
                  return <div key={(i.refId || "e") + "_" + k} style={{ borderBottom:"1px solid var(--border-soft)", paddingBottom:8 }}>
                    <div style={{ display:"flex", justifyContent:"space-between", gap:8, alignItems:"baseline" }}>
                      <span style={{ fontSize:12.5, color:"var(--text-strong)", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{i.descricao}</span>
                      <span style={{ fontSize:12.5, fontWeight:600, color:COR_BOM, whiteSpace:"nowrap" }}>{fmt(i.valor)}</span>
                    </div>
                    <div style={{ fontSize:10.5, color:"var(--text-4)", marginTop:4 }}>{fmtDate(i.dia) || i.dia}</div>
                  </div>;
                })}
                {entradasFuturas.length > 30 && <div style={{ fontSize:11, color:"var(--text-4)" }}>+ {entradasFuturas.length - 30} outras entradas no período.</div>}
              </div>}
        </div>

        <div style={{ ...cartao, flex:1, minWidth:320 }}>
          <div style={{ fontSize:13.5, fontWeight:600, color:"var(--text-strong)", marginBottom:4 }}>E se eu adiar?</div>
          <div style={{ fontSize:11.5, color:"var(--text-3)", marginBottom:12, lineHeight:1.55 }}>
            Simulação — <b>nada é alterado</b> nas suas contas. Serve para achar o adiamento que salva o mês.
          </div>
          {saidasFuturas.length === 0
            ? <div style={{ fontSize:13, color:"var(--text-3)" }}>Nenhuma conta a pagar no horizonte.</div>
            : <div style={{ display:"flex", flexDirection:"column", gap:9, maxHeight:330, overflowY:"auto" }}>
                {saidasFuturas.slice(0, 20).map(function(i){
                  return <div key={i.refId} style={{ borderBottom:"1px solid var(--border-soft)", paddingBottom:8 }}>
                    <div style={{ display:"flex", justifyContent:"space-between", gap:8, alignItems:"baseline" }}>
                      <span style={{ fontSize:12.5, color:"var(--text-strong)", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{i.descricao}</span>
                      <span style={{ fontSize:12.5, fontWeight:600, color:COR_RUIM, whiteSpace:"nowrap" }}>{fmt(i.valor)}</span>
                    </div>
                    <div style={{ display:"flex", gap:5, alignItems:"center", marginTop:5 }}>
                      <span style={{ fontSize:10.5, color:"var(--text-4)", marginRight:2 }}>{fmtDate(i.dia) || i.dia}</span>
                      {[7,15,30].map(function(n){
                        var on = adiamentos[i.refId] === n;
                        return <button key={n} onClick={function(){ adiar(i.refId, on ? 0 : n); }}
                          style={{ fontSize:10.5, fontWeight:600, padding:"3px 8px", borderRadius:6, cursor:"pointer",
                                   border:"1px solid " + (on ? "#FFC107" : "var(--border)"),
                                   background: on ? "rgba(255,193,7,.16)" : "var(--surface)",
                                   color: on ? "#B8860B" : "var(--text-3)" }}>+{n}d</button>;
                      })}
                    </div>
                  </div>;
                })}
              </div>}
          {simulando && (
            <div style={{ marginTop:12, paddingTop:10, borderTop:"1px solid var(--border)" }}>
              <div style={{ fontSize:11.5, color:"var(--text-3)" }}>Saldo ao fim do período</div>
              <div style={{ display:"flex", gap:10, alignItems:"baseline", flexWrap:"wrap" }}>
                <span style={{ fontSize:13, color:"var(--text-4)", textDecoration:"line-through" }}>{fmt(base.saldoFinal)}</span>
                <span style={{ fontSize:19, fontWeight:700, color: proj.saldoFinal >= 0 ? COR_BOM : COR_RUIM }}>{fmt(proj.saldoFinal)}</span>
              </div>
              <div style={{ fontSize:11.5, color:"var(--text-3)", marginTop:6, lineHeight:1.55 }}>
                {base.primeiroNegativo && !proj.primeiroNegativo
                  ? "Com esses adiamentos o caixa não fica negativo no período."
                  : base.primeiroNegativo && proj.primeiroNegativo
                    ? ("O caixa ainda fica negativo, agora em " + (fmtDate(proj.primeiroNegativo.data) || proj.primeiroNegativo.data) + ".")
                    : "O adiamento não muda o total que sai — só quando ele sai. Lembre dos juros e da multa da conta adiada."}
              </div>
              <button onClick={function(){ setAdiamentos({}); }}
                style={{ marginTop:10, background:"var(--surface)", border:"1px solid var(--border)", color:"var(--text-2)", padding:"6px 14px", borderRadius:8, cursor:"pointer", fontSize:12 }}>Limpar simulação</button>
            </div>
          )}
        </div>
      </div>

      {proj.nSemPrevisao > 0 && (
        <div style={{ marginTop:12, background:"var(--surface)", border:"1px solid var(--border)", borderRadius:10, padding:"11px 14px", fontSize:12.5, color:"var(--text-3)", lineHeight:1.6 }}>
          <b>{fmt(proj.semPrevisao)}</b> em {proj.nSemPrevisao} repasse(s) ficaram <b>fora</b> da projeção: o
          Mercado Livre ainda não informou a data de liberação deles. Chutar uma data infla o saldo e
          esconde o dia em que o caixa acaba — quando a previsão chegar, eles aparecem sozinhos.
        </div>
      )}
      <div style={{ marginTop:12, fontSize:11.5, color:"var(--text-3)", background:"var(--surface)", border:"1px solid var(--border)", borderRadius:10, padding:"11px 14px", lineHeight:1.65 }}>
        A projeção usa a <b>data prevista de liberação</b> do Mercado Livre para as entradas — no DRE a
        receita só conta quando você confirma o recebimento. Não é contradição: o DRE olha para trás e
        precisa ser exato, a projeção olha para frente, onde nada está confirmado. Conta vencida e ainda
        não paga entra <b>hoje</b>, porque o dinheiro ainda vai sair. Custos fixos em % do faturamento
        ficam de fora da projeção: dependem de uma venda que ainda não aconteceu.
      </div>
    </FinanceiroShell>
  );
}

// ── Caixas, bancos e movimentos ────────────────────────────────────────────
// O extrato NÃO é guardado. Ele é montado na hora a partir do que já existe:
// contas a pagar quitadas, recebimentos confirmados e lançamentos manuais.
// Gravar uma cópia de cada baixa criaria dois registros da mesma coisa, que
// saem de sincronia no primeiro estorno.
const TIPOS_CONTA_BANCARIA = [
  ["banco", "Conta bancária"],
  ["caixa", "Caixa / dinheiro"],
  ["poupanca", "Poupança / reserva"],
  ["cartao", "Cartão de crédito"],
];

function contaBancariaNova() {
  return {
    nome: "", tipo: "banco", banco: "", agencia: "", numero: "",
    saldoInicial: "", dataSaldoInicial: new Date().toISOString().slice(0, 10),
    recebeML: false, ativa: true, obs: "",
  };
}

// Junta tudo o que mexeu em dinheiro num extrato só, em ordem de data.
// Cada linha diz de onde veio: só a de origem "manual" pode ser editada aqui —
// as outras se editam onde nasceram, e a tela diz isso.
function movimentosConsolidados({ lancamentos, contasPagar, enrichedOrders, recebiveisBaixados, paymentData, contasBancarias }) {
  var mov = [];
  var contaML = (contasBancarias || []).find(function(c){ return c.recebeML; });

  (lancamentos || []).forEach(function(l){
    var v = parseFloat(l.valor) || 0;
    if (!l.data || !v) return;
    mov.push({
      id: l.id, data: String(l.data).slice(0, 10), tipo: l.tipo === "entrada" ? "entrada" : "saida",
      descricao: l.descricao || "(sem descrição)", categoria: l.categoria || "Outros",
      valor: Math.abs(v), conta: l.conta || "", origem: "manual",
    });
  });

  // Cada baixa é um movimento próprio: uma conta paga em duas vezes aparece
  // duas vezes no extrato, nas datas certas, e pode ser estornada em separado.
  (contasPagar || []).forEach(function(c){
    if (c.status === "cancelada") return;
    var pgs = pagamentosDe(c);
    pgs.forEach(function(pg, i){
      var d = String(pg.data || c.pago_em || c.vencimento || "").slice(0, 10);
      var v = parseFloat(pg.valor) || 0;
      if (!d || !v) return;
      mov.push({
        id: "cp:" + c.id + ":" + (pg.id || i), data: d, tipo: "saida",
        descricao: (c.descricao || "(sem fornecedor)") + (pgs.length > 1 ? " · baixa " + (i+1) + "/" + pgs.length : ""),
        categoria: c.categoria || "Outros",
        valor: v, conta: pg.conta || c.conta || "", origem: "conta_pagar", refId: c.id, pagamentoId: pg.id || null,
      });
    });
  });

  (enrichedOrders || []).forEach(function(o){
    if (o.status === "cancelled") return;
    var d = (recebiveisBaixados || {})[String(o.id)];
    if (!d) return;
    var pay = paymentData && paymentData[String(o.id)];
    var v = pay && pay.netAmount ? pay.netAmount : (o.price || 0) * (o.qty || 1);
    if (!v) return;
    mov.push({
      id: "rec:" + o.id, data: String(d).slice(0, 10), tipo: "entrada",
      descricao: "Repasse ML · pedido #" + o.id, categoria: "Vendas",
      valor: v, conta: contaML ? contaML.id : "", origem: "recebivel", refId: o.id,
    });
  });

  mov.sort(function(a, b){ return b.data.localeCompare(a.data) || String(b.id).localeCompare(String(a.id)); });
  return mov;
}

// Saldo de uma conta: o saldo inicial informado mais tudo o que se moveu nela
// DEPOIS da data desse saldo. Movimento anterior é ignorado de propósito — já
// está embutido no número que o usuário digitou, e somá-lo contaria duas vezes.
function saldoDaConta(conta, movimentos) {
  var base = parseFloat(conta.saldoInicial) || 0;
  var desde = conta.dataSaldoInicial || "0000-00-00";
  var delta = 0;
  (movimentos || []).forEach(function(m){
    if (m.conta !== conta.id) return;
    if (m.data < desde) return;
    delta += m.tipo === "entrada" ? m.valor : -m.valor;
  });
  return base + delta;
}

// Movimento que não foi atribuído a nenhuma conta existente. Não entra em saldo
// nenhum — e por isso precisa ser mostrado, não descartado em silêncio.
function movimentosSemConta(movimentos, contasBancarias) {
  var existe = {};
  (contasBancarias || []).forEach(function(c){ existe[c.id] = true; });
  return (movimentos || []).filter(function(m){ return !m.conta || !existe[m.conta]; });
}

// Saldo somado das contas ativas. É o número que a Prioridade de pagamento usa
// no lugar de perguntar quanto você tem.
function saldoConsolidado(contasBancarias, movimentos) {
  return (contasBancarias || [])
    .filter(function(c){ return c.ativa !== false && c.tipo !== "cartao"; })
    .reduce(function(s, c){ return s + saldoDaConta(c, movimentos); }, 0);
}

function ContaBancariaModal({ conta, onSave, onClose, onExcluir }) {
  const [f, setF] = useState(function(){ return Object.assign(contaBancariaNova(), conta || {}); });
  const [erro, setErro] = useState("");
  function set(k, v){ setF(function(s){ return Object.assign({}, s, { [k]: v }); }); }
  var novo = !conta || !conta.id;
  function salvar(){
    if (!String(f.nome || "").trim()) { setErro("Dê um nome à conta — é assim que ela aparece nas outras telas."); return; }
    var p = Object.assign({}, f);
    if (!p.id) p.id = "cb_" + Date.now() + "_" + Math.floor(Math.random()*1000);
    onSave(p);
  }
  var campo = { width:"100%", background:"var(--bg)", border:"1px solid var(--border)", color:"var(--text-strong)", padding:"9px 11px", borderRadius:8, fontSize:13, outline:"none", boxSizing:"border-box" };
  var lbl = { fontSize:11.5, color:"var(--text-3)", fontWeight:600, marginBottom:4, display:"block" };
  var ehCartao = f.tipo === "cartao";
  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,.45)", zIndex:600, display:"flex", alignItems:"flex-start", justifyContent:"center", padding:"32px 16px", overflowY:"auto" }} onClick={onClose}>
      <div onClick={function(e){ e.stopPropagation(); }} style={{ background:"var(--bg-2)", border:"1px solid var(--border)", borderRadius:14, width:620, maxWidth:"100%", padding:22 }}>
        <div style={{ fontWeight:600, fontSize:17, color:"var(--text-strong)", marginBottom:16 }}>{novo ? "Nova conta" : "Editar conta"}</div>
        {erro && <div style={{ background:"rgba(255,82,82,.12)", border:"1px solid #FF5252", color:"#FF5252", borderRadius:9, padding:"10px 13px", fontSize:12.5, marginBottom:14 }}>{erro}</div>}
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12, marginBottom:12 }}>
          <div><label style={lbl}>Nome *</label><input value={f.nome} onChange={function(e){ set("nome", e.target.value); }} placeholder="Itaú principal" style={campo} /></div>
          <div><label style={lbl}>Tipo</label>
            <select value={f.tipo} onChange={function(e){ set("tipo", e.target.value); }} style={campo}>
              {TIPOS_CONTA_BANCARIA.map(function(t){ return <option key={t[0]} value={t[0]}>{t[1]}</option>; })}
            </select></div>
        </div>
        {f.tipo !== "caixa" && (
          <div style={{ display:"grid", gridTemplateColumns:"2fr 1fr 1.4fr", gap:12, marginBottom:12 }}>
            <div><label style={lbl}>Banco</label><input value={f.banco} onChange={function(e){ set("banco", e.target.value); }} style={campo} /></div>
            <div><label style={lbl}>Agência</label><input value={f.agencia} onChange={function(e){ set("agencia", e.target.value); }} style={campo} /></div>
            <div><label style={lbl}>Conta</label><input value={f.numero} onChange={function(e){ set("numero", e.target.value); }} style={campo} /></div>
          </div>
        )}
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12, marginBottom:12 }}>
          <div><label style={lbl}>Saldo inicial (R$)</label><input type="number" step="0.01" value={f.saldoInicial} onChange={function(e){ set("saldoInicial", e.target.value); }} style={campo} /></div>
          <div><label style={lbl}>Nesta data</label><input type="date" value={f.dataSaldoInicial} onChange={function(e){ set("dataSaldoInicial", e.target.value); }} style={campo} /></div>
        </div>
        <div style={{ fontSize:11.5, color:"var(--text-3)", lineHeight:1.6, marginBottom:14 }}>
          O saldo atual é este valor mais tudo o que se moveu <b>depois</b> desta data. Movimento anterior
          é ignorado — ele já está embutido no número que você digitou.
        </div>
        <label style={{ display:"flex", alignItems:"center", gap:8, fontSize:13, color:"var(--text-2)", cursor:"pointer", marginBottom:10 }}>
          <input type="checkbox" checked={!!f.recebeML} onChange={function(e){ set("recebeML", e.target.checked); }} />
          Os repasses do Mercado Livre caem nesta conta
        </label>
        <label style={{ display:"flex", alignItems:"center", gap:8, fontSize:13, color:"var(--text-2)", cursor:"pointer", marginBottom:16 }}>
          <input type="checkbox" checked={f.ativa !== false} onChange={function(e){ set("ativa", e.target.checked); }} />
          Conta ativa {ehCartao ? "" : "— entra no saldo consolidado"}
        </label>
        {ehCartao && <div style={{ fontSize:11.5, color:"var(--text-3)", marginBottom:16, lineHeight:1.6 }}>
          Cartão de crédito fica <b>fora</b> do saldo consolidado: o limite não é dinheiro que você tem.
        </div>}
        <div style={{ display:"flex", gap:8 }}>
          {!novo && onExcluir && <button onClick={function(){ onExcluir(f); }} style={{ background:"rgba(255,82,82,.1)", border:"1px solid rgba(255,82,82,.35)", color:"#FF5252", fontWeight:600, padding:"11px 18px", borderRadius:10, cursor:"pointer" }}>Excluir</button>}
          <div style={{ flex:1 }} />
          <button onClick={onClose} style={{ background:"var(--surface)", border:"1px solid var(--border)", color:"var(--text-2)", fontWeight:600, padding:"11px 20px", borderRadius:10, cursor:"pointer" }}>Cancelar</button>
          <button onClick={salvar} style={{ background:"var(--ui-accent)", border:"none", color:"var(--ui-accent-text)", fontWeight:600, padding:"11px 30px", borderRadius:10, cursor:"pointer" }}>Salvar</button>
        </div>
      </div>
    </div>
  );
}

// Caixas e bancos: onde o dinheiro está, com o saldo calculado a partir dos
// movimentos — não digitado.
function BancosTab({ contasBancarias, salvar, movimentos, setTab, tab, estornar }) {
  const [modal, setModal] = useState(null);
  const [extratoDe, setExtratoDe] = useState(null);
  var semConta = movimentosSemConta(movimentos, contasBancarias);
  var somaSemConta = semConta.reduce(function(s,m){ return s + (m.tipo === "entrada" ? m.valor : -m.valor); }, 0);
  var consolidado = saldoConsolidado(contasBancarias, movimentos);
  var temML = (contasBancarias || []).some(function(c){ return c.recebeML; });

  function salvarConta(c){
    var arr = (contasBancarias || []).slice();
    // Só uma conta pode receber os repasses; marcar uma nova desmarca a anterior.
    if (c.recebeML) arr = arr.map(function(x){ return Object.assign({}, x, { recebeML: x.id === c.id }); });
    var i = arr.findIndex(function(x){ return x.id === c.id; });
    if (i >= 0) arr[i] = c; else arr.push(c);
    salvar(arr); setModal(null);
  }
  function excluir(c){
    if (!window.confirm("Excluir a conta “" + c.nome + "”? Os movimentos ligados a ela ficam sem conta.")) return;
    salvar((contasBancarias || []).filter(function(x){ return x.id !== c.id; })); setModal(null);
  }

  var cartao = { background:"var(--surface)", border:"1px solid var(--border)", borderRadius:12, padding:"18px 20px" };

  var kpisBanco = [
    { rotulo:"Saldo consolidado", valor:fmt(consolidado), cor: consolidado >= 0 ? FIN_COR.entrada : FIN_COR.saida, nota:"contas ativas, sem cartões" },
    { rotulo:"Contas cadastradas", valor:String((contasBancarias||[]).length), cor:FIN_COR.neutro,
      nota:(contasBancarias||[]).filter(function(c){ return c.ativa !== false; }).length + " ativa(s)" },
    { rotulo:"Movimentos sem conta", valor:String(semConta.length), cor: semConta.length ? FIN_COR.atencao : FIN_COR.fraco,
      nota: semConta.length ? fmt(Math.abs(somaSemConta)) + " fora de qualquer saldo" : "tudo atribuído" },
  ];

  if (extratoDe) {
    var conta = (contasBancarias || []).find(function(c){ return c.id === extratoDe; });
    if (!conta) { setExtratoDe(null); return null; }
    var doExtrato = (movimentos || []).filter(function(m){ return m.conta === conta.id && m.data >= (conta.dataSaldoInicial || "0000-00-00"); });
    var corrido = parseFloat(conta.saldoInicial) || 0;
    var comSaldo = doExtrato.slice().reverse().map(function(m){
      corrido += m.tipo === "entrada" ? m.valor : -m.valor;
      return Object.assign({}, m, { saldo: corrido });
    }).reverse();
    return (
      <FinanceiroShell tab={tab} setTab={setTab} titulo={conta.nome}
        sub={"Extrato desde " + (fmtDate(conta.dataSaldoInicial) || conta.dataSaldoInicial) + " · saldo inicial " + fmt(parseFloat(conta.saldoInicial)||0)}
        controles={<button onClick={function(){ setExtratoDe(null); }} style={{ background:"var(--surface)", border:"1px solid var(--border)", color:"var(--text-2)", padding:"7px 16px", borderRadius:8, cursor:"pointer", fontSize:12, fontWeight:600 }}>← Todas as contas</button>}
        kpis={[
          { rotulo:"Saldo atual", valor:fmt(saldoDaConta(conta, movimentos)), cor: saldoDaConta(conta, movimentos) >= 0 ? FIN_COR.entrada : FIN_COR.saida },
          { rotulo:"Entradas no extrato", valor:fmt(doExtrato.filter(function(m){ return m.tipo==="entrada"; }).reduce(function(a,m){ return a+m.valor; },0)), cor:FIN_COR.entrada },
          { rotulo:"Saídas no extrato", valor:fmt(doExtrato.filter(function(m){ return m.tipo==="saida"; }).reduce(function(a,m){ return a+m.valor; },0)), cor:FIN_COR.saida },
        ]}>
        {comSaldo.length === 0
          ? <div style={{ ...cartao, textAlign:"center", padding:"46px 20px", color:"var(--text-3)", fontSize:13.5 }}>Nenhum movimento nesta conta desde a data do saldo inicial.</div>
          : <div className="tabela-wrap"><table className="tabela">
              <thead><tr>{["Data","Descrição","Categoria","Origem","Entrada","Saída","Saldo",""].map(function(h){ return <th key={h} className="th">{h}</th>; })}</tr></thead>
              <tbody>{comSaldo.map(function(m,i){
                return <tr key={m.id||i}>
                  <td className="td">{fmtDate(m.data) || m.data}</td>
                  <td className="td" style={{ color:"var(--text-strong)", maxWidth:280 }}>{m.descricao}</td>
                  <td className="td">{m.categoria}</td>
                  <td className="td" style={{ fontSize:11.5, color:"var(--text-3)" }}>{ROTULO_ORIGEM[m.origem] || m.origem}</td>
                  <td className="td-num">{m.tipo === "entrada" ? <span style={{ color:"#0a9d4e" }}>{fmt(m.valor)}</span> : "—"}</td>
                  <td className="td-num">{m.tipo === "saida" ? <span style={{ color:"#FF5252" }}>{fmt(m.valor)}</span> : "—"}</td>
                  <td className="td-num" style={{ fontWeight:600, color: m.saldo >= 0 ? "var(--text-strong)" : "#FF5252" }}>{fmt(m.saldo)}</td>
                  <td className="td" style={{ textAlign:"right", whiteSpace:"nowrap" }}>
                    {estornar && <button onClick={function(){ estornar(m); }}
                      title={m.origem === "conta_pagar" ? "Desfaz a baixa: a conta volta para Contas a pagar"
                           : m.origem === "recebivel" ? "Desfaz a confirmação: volta para Contas a receber"
                           : "Apaga o lançamento manual"}
                      style={{ background:"rgba(255,82,82,.1)", border:"none", color:"#FF5252", fontSize:11, fontWeight:600, padding:"4px 10px", borderRadius:6, cursor:"pointer" }}>
                      {m.origem === "manual" ? "Excluir" : "Estornar"}
                    </button>}
                  </td>
                </tr>;
              })}</tbody>
            </table></div>}
      </FinanceiroShell>
    );
  }

  return (
    <FinanceiroShell tab={tab} setTab={setTab} titulo="Caixas e bancos"
      sub="Onde o dinheiro está. O saldo é calculado — não digitado."
      kpis={kpisBanco}
      acoes={<>
        <AcaoFin tipo="pri" onClick={function(){ setModal({}); }}>+ Nova conta</AcaoFin>
        <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:12, padding:"12px 14px", fontSize:11.5, color:"var(--text-3)", lineHeight:1.6 }}>
          O saldo consolidado é o que a <b>Prioridade de pagamento</b> usa, no lugar de perguntar
          quanto você tem.
        </div>
      </>}>
      {(contasBancarias || []).length === 0 ? (
        <VazioFin icone="🏦" titulo="Nenhuma conta cadastrada."
          texto="Cadastre onde o seu dinheiro fica — banco, caixa, reserva. Informe o saldo de hoje e o sistema mantém o resto a partir das contas pagas e dos recebimentos confirmados."
          acao="+ Nova conta" onAcao={function(){ setModal({}); }} />
      ) : (
        <div className="tabela-wrap">
          <table className="tabela">
            <thead><tr>{["Conta","Tipo","Dados","Saldo inicial","Saldo atual",""].map(function(h){ return <th key={h} className="th">{h}</th>; })}</tr></thead>
            <tbody>
              {(contasBancarias || []).map(function(c){
                var saldo = saldoDaConta(c, movimentos);
                var inativa = c.ativa === false;
                return <tr key={c.id} onClick={function(){ setExtratoDe(c.id); }} style={{ cursor:"pointer", opacity: inativa ? .5 : 1 }} title="Ver extrato">
                  <td className="td" style={{ color:"var(--text-strong)", fontWeight:500 }}>
                    {c.nome}
                    {c.recebeML && <span style={{ marginLeft:8, fontSize:10, fontWeight:600, padding:"2px 7px", borderRadius:20, background:"rgba(255,193,7,.16)", color:"#B8860B" }}>repasses ML</span>}
                    {inativa && <span style={{ marginLeft:8, fontSize:10.5, color:"var(--text-4)" }}>inativa</span>}
                  </td>
                  <td className="td">{(TIPOS_CONTA_BANCARIA.find(function(t){ return t[0]===c.tipo; })||["","—"])[1]}</td>
                  <td className="td" style={{ fontSize:12, color:"var(--text-3)" }}>{c.banco ? c.banco + (c.agencia ? " · ag " + c.agencia : "") + (c.numero ? " · cc " + c.numero : "") : "—"}</td>
                  <td className="td-num">{fmt(parseFloat(c.saldoInicial)||0)}</td>
                  <td className="td-num" style={{ fontWeight:700, color: saldo >= 0 ? "var(--text-strong)" : "#FF5252" }}>{fmt(saldo)}</td>
                  <td className="td" style={{ textAlign:"right" }} onClick={function(e){ e.stopPropagation(); }}>
                    <button onClick={function(){ setModal(c); }} style={{ background:"var(--surface-3)", border:"none", color:"var(--text-2)", fontSize:11, fontWeight:600, padding:"4px 10px", borderRadius:6, cursor:"pointer" }}>Editar</button>
                  </td>
                </tr>;
              })}
            </tbody>
          </table>
        </div>
      )}

      {(contasBancarias || []).length > 0 && !temML && (
        <div style={{ marginTop:12, background:"rgba(255,193,7,.10)", border:"1px solid rgba(255,193,7,.45)", borderRadius:10, padding:"11px 14px", fontSize:12.5, color:"var(--text-2)", lineHeight:1.6 }}>
          Nenhuma conta está marcada como a que recebe os repasses do Mercado Livre. Enquanto isso,
          os recebimentos confirmados não entram em saldo nenhum. Edite a conta certa e marque a opção.
        </div>
      )}

      {semConta.length > 0 && (
        <div style={{ marginTop:12, background:"var(--surface)", border:"1px solid var(--border)", borderRadius:10, padding:"11px 14px", fontSize:12.5, color:"var(--text-3)", lineHeight:1.6 }}>
          <b>{semConta.length} movimento(s)</b> somando {fmt(Math.abs(somaSemConta))} não estão em nenhuma conta —
          foram pagos ou recebidos sem dizer de onde saiu o dinheiro. Eles aparecem em Lançamentos, mas
          não entram em saldo nenhum.
          {setTab && <button onClick={function(){ setTab("lancamentos"); }} style={{ marginLeft:8, background:"none", border:"none", color:"var(--ui-accent)", cursor:"pointer", fontSize:12.5, fontWeight:600, padding:0 }}>Ver em Lançamentos →</button>}
        </div>
      )}

      {modal && <ContaBancariaModal conta={modal.id ? modal : null} onSave={salvarConta} onExcluir={excluir} onClose={function(){ setModal(null); }} />}
    </FinanceiroShell>
  );
}

var ROTULO_ORIGEM = { manual:"lançamento", conta_pagar:"conta a pagar", recebivel:"recebimento ML" };

function LancamentoModal({ lancamento, contasBancarias, categorias, onSave, onClose }) {
  const [f, setF] = useState(function(){
    return Object.assign({
      data: new Date().toISOString().slice(0,10), tipo:"saida", categoria:"", descricao:"", valor:"", conta:"", obs:"",
    }, lancamento || {});
  });
  const [erro, setErro] = useState("");
  function set(k,v){ setF(function(s){ return Object.assign({}, s, { [k]:v }); }); }
  function salvar(){
    if (!String(f.descricao||"").trim()) { setErro("Descreva o lançamento."); return; }
    if (!(parseFloat(f.valor) > 0)) { setErro("Informe um valor maior que zero."); return; }
    if (!f.data) { setErro("Informe a data."); return; }
    var p = Object.assign({}, f);
    if (!p.id) p.id = "lc_" + Date.now() + "_" + Math.floor(Math.random()*1000);
    onSave(p);
  }
  var campo = { width:"100%", background:"var(--bg)", border:"1px solid var(--border)", color:"var(--text-strong)", padding:"9px 11px", borderRadius:8, fontSize:13, outline:"none", boxSizing:"border-box" };
  var lbl = { fontSize:11.5, color:"var(--text-3)", fontWeight:600, marginBottom:4, display:"block" };
  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,.45)", zIndex:600, display:"flex", alignItems:"flex-start", justifyContent:"center", padding:"32px 16px", overflowY:"auto" }} onClick={onClose}>
      <div onClick={function(e){ e.stopPropagation(); }} style={{ background:"var(--bg-2)", border:"1px solid var(--border)", borderRadius:14, width:580, maxWidth:"100%", padding:22 }}>
        <div style={{ fontWeight:600, fontSize:17, color:"var(--text-strong)", marginBottom:16 }}>{lancamento && lancamento.id ? "Editar lançamento" : "Novo lançamento"}</div>
        {erro && <div style={{ background:"rgba(255,82,82,.12)", border:"1px solid #FF5252", color:"#FF5252", borderRadius:9, padding:"10px 13px", fontSize:12.5, marginBottom:14 }}>{erro}</div>}
        <div style={{ display:"flex", gap:8, marginBottom:14 }}>
          {[["saida","Saída","#FF5252"],["entrada","Entrada","#0a9d4e"]].map(function(t){
            var on = f.tipo === t[0];
            return <button key={t[0]} onClick={function(){ set("tipo", t[0]); }}
              style={{ flex:1, padding:"10px", borderRadius:9, cursor:"pointer", fontSize:13, fontWeight:600,
                       border:"1px solid " + (on ? t[2] : "var(--border)"),
                       background: on ? t[2] : "var(--surface)", color: on ? "#fff" : "var(--text-3)" }}>{t[1]}</button>;
          })}
        </div>
        <div style={{ marginBottom:12 }}><label style={lbl}>Descrição *</label><input value={f.descricao} onChange={function(e){ set("descricao", e.target.value); }} placeholder="Tarifa bancária, adiantamento, venda avulsa..." style={campo} /></div>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12, marginBottom:12 }}>
          <div><label style={lbl}>Valor (R$) *</label><input type="number" step="0.01" value={f.valor} onChange={function(e){ set("valor", e.target.value); }} style={campo} /></div>
          <div><label style={lbl}>Data *</label><input type="date" value={f.data} onChange={function(e){ set("data", e.target.value); }} style={campo} /></div>
        </div>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12, marginBottom:14 }}>
          <div><label style={lbl}>Categoria</label>
            <input value={f.categoria} onChange={function(e){ set("categoria", e.target.value); }} list="lista-cat-lanc" placeholder="Outros" style={campo} />
            <datalist id="lista-cat-lanc">{(categorias||[]).map(function(c){ return <option key={c} value={c} />; })}</datalist>
          </div>
          <div><label style={lbl}>Conta</label>
            <select value={f.conta} onChange={function(e){ set("conta", e.target.value); }} style={campo}>
              <option value="">— não definida —</option>
              {(contasBancarias||[]).map(function(c){ return <option key={c.id} value={c.id}>{c.nome}</option>; })}
            </select>
            <div style={{ fontSize:10.5, color:"var(--text-4)", marginTop:3 }}>Sem conta, não entra em saldo nenhum.</div>
          </div>
        </div>
        <div style={{ marginBottom:18 }}><label style={lbl}>Observação</label><input value={f.obs} onChange={function(e){ set("obs", e.target.value); }} style={campo} /></div>
        <div style={{ display:"flex", gap:8, justifyContent:"flex-end" }}>
          <button onClick={onClose} style={{ background:"var(--surface)", border:"1px solid var(--border)", color:"var(--text-2)", fontWeight:600, padding:"11px 20px", borderRadius:10, cursor:"pointer" }}>Cancelar</button>
          <button onClick={salvar} style={{ background:"var(--ui-accent)", border:"none", color:"var(--ui-accent-text)", fontWeight:600, padding:"11px 30px", borderRadius:10, cursor:"pointer" }}>Salvar</button>
        </div>
      </div>
    </div>
  );
}

// Lançamentos: o extrato de tudo o que mexeu em dinheiro, de qualquer origem.
function LancamentosTab({ lancamentos, salvar, movimentos, contasBancarias, categorias, tab, setTab, periodo, setPeriodo, estornar }) {
  const [modal, setModal] = useState(null);
  const [fTipo, setFTipo] = useState("todos");
  const [fConta, setFConta] = useState("");
  const [fOrigem, setFOrigem] = useState("todas");
  const [busca, setBusca] = useState("");
  var cutoff = cutoffPeriodo(periodo);
  var nomeConta = {}; (contasBancarias||[]).forEach(function(c){ nomeConta[c.id] = c.nome; });

  var lista = (movimentos || []).filter(function(m){
    if (m.data < cutoff) return false;
    if (fTipo !== "todos" && m.tipo !== fTipo) return false;
    if (fConta === "__sem__" ? !!m.conta && !!nomeConta[m.conta] : (fConta && m.conta !== fConta)) return false;
    if (fOrigem !== "todas" && m.origem !== fOrigem) return false;
    var q = busca.trim().toLowerCase();
    if (q && (m.descricao||"").toLowerCase().indexOf(q) < 0 && (m.categoria||"").toLowerCase().indexOf(q) < 0) return false;
    return true;
  });
  var entradas = lista.filter(function(m){ return m.tipo === "entrada"; }).reduce(function(s,m){ return s+m.valor; }, 0);
  var saidas = lista.filter(function(m){ return m.tipo === "saida"; }).reduce(function(s,m){ return s+m.valor; }, 0);

  function salvarLanc(l){
    var arr = (lancamentos || []).slice();
    var i = arr.findIndex(function(x){ return x.id === l.id; });
    if (i >= 0) arr[i] = l; else arr.push(l);
    salvar(arr); setModal(null);
  }
  function excluir(id){
    if (!window.confirm("Excluir este lançamento?")) return;
    salvar((lancamentos || []).filter(function(x){ return x.id !== id; }));
  }
  var sel = { background:"var(--surface)", border:"1px solid var(--border)", color:"var(--text-2)", padding:"8px 10px", borderRadius:8, fontSize:12.5 };

  return (
    <FinanceiroShell tab={tab} setTab={setTab} titulo="Lançamentos"
      sub="Tudo o que mexeu em dinheiro: contas pagas, recebimentos confirmados e lançamentos seus."
      periodo={periodo} setPeriodo={setPeriodo}
      kpis={[
        { rotulo:"Entradas", valor:fmt(entradas), cor:FIN_COR.entrada },
        { rotulo:"Saídas", valor:fmt(saidas), cor:FIN_COR.saida },
        { rotulo:"Resultado do período", valor:fmt(entradas - saidas), cor: entradas - saidas >= 0 ? FIN_COR.entrada : FIN_COR.saida },
        { rotulo:"Movimentos", valor:String(lista.length), cor:FIN_COR.neutro },
      ]}
      acoes={<AcaoFin tipo="pri" onClick={function(){ setModal({}); }}>+ Novo lançamento</AcaoFin>}>

      <div style={{ display:"flex", gap:8, marginBottom:12, flexWrap:"wrap", alignItems:"center" }}>
        <select value={fTipo} onChange={function(e){ setFTipo(e.target.value); }} style={sel}>
          <option value="todos">Entradas e saídas</option><option value="entrada">Só entradas</option><option value="saida">Só saídas</option>
        </select>
        <select value={fConta} onChange={function(e){ setFConta(e.target.value); }} style={sel}>
          <option value="">Todas as contas</option>
          {(contasBancarias||[]).map(function(c){ return <option key={c.id} value={c.id}>{c.nome}</option>; })}
          <option value="__sem__">Sem conta definida</option>
        </select>
        <select value={fOrigem} onChange={function(e){ setFOrigem(e.target.value); }} style={sel}>
          <option value="todas">Todas as origens</option>
          <option value="manual">Lançamento manual</option>
          <option value="conta_pagar">Conta a pagar</option>
          <option value="recebivel">Recebimento ML</option>
        </select>
        <input value={busca} onChange={function(e){ setBusca(e.target.value); }} placeholder="Buscar por descrição ou categoria"
          style={{ ...sel, flex:1, minWidth:200, color:"var(--text-strong)" }} />
      </div>

      {lista.length === 0 ? (
        <VazioFin icone="📒" titulo="Nenhum movimento no período."
          texto="Esta tela mostra contas a pagar quitadas, recebimentos confirmados em Contas a receber, e lançamentos que você criar aqui."
          acao="+ Novo lançamento" onAcao={function(){ setModal({}); }} />
      ) : (
        <div className="tabela-wrap">
          <table className="tabela">
            <thead><tr>{["Data","Descrição","Categoria","Conta","Origem","Entrada","Saída",""].map(function(h){ return <th key={h} className="th">{h}</th>; })}</tr></thead>
            <tbody>
              {lista.slice(0,400).map(function(m,i){
                var editavel = m.origem === "manual";
                return <tr key={m.id||i}>
                  <td className="td">{fmtDate(m.data) || m.data}</td>
                  <td className="td" style={{ color:"var(--text-strong)", maxWidth:280 }}>{m.descricao}</td>
                  <td className="td">{m.categoria}</td>
                  <td className="td">{m.conta && nomeConta[m.conta] ? nomeConta[m.conta] : <span style={{ color:"#FFC107", fontSize:12 }}>sem conta</span>}</td>
                  <td className="td" style={{ fontSize:11.5, color:"var(--text-3)" }}>{ROTULO_ORIGEM[m.origem] || m.origem}</td>
                  <td className="td-num">{m.tipo === "entrada" ? <span style={{ color:"#0a9d4e" }}>{fmt(m.valor)}</span> : "—"}</td>
                  <td className="td-num">{m.tipo === "saida" ? <span style={{ color:"#FF5252" }}>{fmt(m.valor)}</span> : "—"}</td>
                  <td className="td" style={{ textAlign:"right", whiteSpace:"nowrap" }}>
                    {editavel ? <>
                      <button onClick={function(){ setModal((lancamentos||[]).find(function(x){ return x.id === m.id; })); }} style={{ background:"var(--surface-3)", border:"none", color:"var(--text-2)", fontSize:11, fontWeight:600, padding:"4px 9px", borderRadius:6, cursor:"pointer", marginRight:6 }}>Editar</button>
                      <button onClick={function(){ excluir(m.id); }} style={{ background:"rgba(255,82,82,.1)", border:"none", color:"#FF5252", fontSize:11, fontWeight:600, padding:"4px 9px", borderRadius:6, cursor:"pointer" }}>Excluir</button>
                    </> : (estornar
                      ? <button onClick={function(){ estornar(m); }}
                          title={m.origem === "conta_pagar" ? "Desfaz a baixa: a conta volta para Contas a pagar" : "Desfaz a confirmação: volta para Contas a receber"}
                          style={{ background:"rgba(255,82,82,.1)", border:"none", color:"#FF5252", fontSize:11, fontWeight:600, padding:"4px 9px", borderRadius:6, cursor:"pointer" }}>Estornar</button>
                      : <span style={{ fontSize:11, color:"var(--text-4)" }}>edite na origem</span>)}
                  </td>
                </tr>;
              })}
            </tbody>
          </table>
        </div>
      )}
      {lista.length > 400 && <div style={{ fontSize:11.5, color:"var(--text-3)", marginTop:8 }}>Mostrando 400 de {lista.length} movimentos.</div>}

      {modal && <LancamentoModal lancamento={modal.id ? modal : null} contasBancarias={contasBancarias}
        categorias={categorias} onSave={salvarLanc} onClose={function(){ setModal(null); }} />}
    </FinanceiroShell>
  );
}

// ── Regime financeiro ──────────────────────────────────────────────────────
// Duas escolhas que mudam TODOS os números do Financeiro, guardadas num lugar
// só para as telas não discordarem entre si:
//
// regime  "caixa"      → conta no dia em que o dinheiro entra ou sai
//         "competencia"→ conta no dia da venda ou da compra
// repasse "confirmado" → o repasse do Mercado Livre só vira receita quando o
//                        usuário confirma que caiu na conta
//         "previsto"   → vale a data de liberação anunciada pelo ML
const FINANCEIRO_PADRAO = {
  regime: "caixa",
  repasse: "confirmado",
  // De onde saem as despesas do DRE. "pagas" é o certo no regime de caixa:
  // é dinheiro que saiu de verdade. "configurados" usa os custos fixos de
  // Financeiro → Impostos, útil enquanto Contas a pagar ainda está sendo
  // preenchida. "ambos" soma os dois e pode contar a mesma despesa duas vezes.
  origemDespesas: "pagas",
  // Categorias de conta a pagar que são compra de mercadoria. O custo dessas
  // já entra no DRE pelo CMV de cada venda; somá-las de novo como despesa
  // contaria a mesma mercadoria duas vezes.
  categoriasMercadoria: ["Fornecedor"],
};

function financeiroConfigPadrao() { return JSON.parse(JSON.stringify(FINANCEIRO_PADRAO)); }

// Um pedido virou dinheiro? No regime de competência, a venda conta na data em
// que foi feita. No de caixa, só quando o recebimento é confirmado — e a data
// que vale é a da confirmação, não a da venda.
function dataDeReceita(o, cfg, baixas, paymentData) {
  if (cfg.regime !== "caixa") return o.date || "";
  var manual = baixas && baixas[String(o.id)];
  if (manual) return String(manual).slice(0, 10);
  if (cfg.repasse === "previsto") {
    var pay = paymentData && paymentData[String(o.id)];
    if (pay && pay.isReleased) return String(pay.releaseDate || o.date || "").slice(0, 10);
  }
  return "";     // ainda não é dinheiro
}

// Quanto de uma conta a pagar entra no resultado, e em que data. No regime de
// competência é o valor inteiro na competência; no de caixa é cada baixa na sua
// data — uma conta paga em duas vezes pesa em dois meses diferentes.
function parcelasDeDespesa(c, cfg) {
  if (c.status === "cancelada") return [];
  var total = parseFloat(c.valorTotal || c.valor) || 0;
  if (cfg.regime !== "caixa") {
    var d = c.competencia || c.emissao || c.vencimento || "";
    return d && total ? [{ data: d, valor: total }] : [];
  }
  return pagamentosDe(c).map(function(pg){
    return { data: String(pg.data || c.pago_em || c.vencimento || "").slice(0, 10), valor: parseFloat(pg.valor) || 0 };
  }).filter(function(x){ return x.data && x.valor; });
}

// Custos fixos são mensais. Para um período de N dias, o que corresponde é a
// fração do mês — 90 dias valem três meses de aluguel, não um.
function custosFixosNoPeriodo(custosFixos, faturamentoPeriodo, dias) {
  var meses = dias / 30;
  return (custosFixos || []).reduce(function(s, c){
    var v = parseFloat(c.valor) || 0;
    // O item em % é sobre o faturamento do PERÍODO, então já está na medida
    // certa e não se multiplica por mês nenhum.
    return s + (c.tipo === "%" ? faturamentoPeriodo * (v / 100) : v * meses);
  }, 0);
}

function DreTab({ enrichedOrders, contasPagar, custosFixos, recebiveisBaixados, paymentData, config, salvarConfig, lancamentos, tab, setTab, periodo, setPeriodo }) {
  const [mostrarAjustes, setMostrarAjustes] = useState(false);
  const [comparar, setComparar] = useState(false);
  var cfg = config || financeiroConfigPadrao();
  var cutoff = cutoffPeriodo(periodo);
  var dias = periodo === "tudo" ? 365 : parseInt(periodo, 10);
  var hoje = new Date().toISOString().slice(0, 10);
  var caixa = cfg.regime === "caixa";

  // ── Apuração ─────────────────────────────────────────────────────────────
  // Uma função só, chamada duas vezes: no período escolhido e no anterior de
  // mesmo tamanho. Duplicar a conta para a comparação seria a receita certa
  // para os dois números divergirem na primeira alteração.
  function apurar(de, ate, diasPer) {
    var fat=0, impostos=0, custo=0, taxas=0, nPedidos=0;
    var pedidosForaDoCaixa = 0, valorForaDoCaixa = 0;
    (enrichedOrders || []).forEach(function(o){
      if (o.status === "cancelled") return;
      var q = o.qty || 1;
      var d = dataDeReceita(o, cfg, recebiveisBaixados, paymentData);
      if (!d) {
        if ((o.date || "") >= de && (o.date || "") <= ate) { pedidosForaDoCaixa++; valorForaDoCaixa += (o.price||0)*q; }
        return;
      }
      if (d < de || d > ate) return;
      fat += (o.price||0)*q; impostos += (o.imposto||0)*q;
      custo += (o.cost||0)*q; taxas += (o.fee||0)*q; nPedidos++;
    });
    var ehMercadoria = {};
    (cfg.categoriasMercadoria || []).forEach(function(c){ ehMercadoria[c] = true; });
    var despesasPagas = 0, mercadoriaPaga = 0, porCategoria = {};
    (contasPagar || []).forEach(function(c){
      var cat = c.categoria || "Outros";
      parcelasDeDespesa(c, cfg).forEach(function(x){
        if (x.data < de || x.data > ate) return;
        if (ehMercadoria[cat]) { mercadoriaPaga += x.valor; return; }
        despesasPagas += x.valor;
        porCategoria[cat] = (porCategoria[cat] || 0) + x.valor;
      });
    });
    (lancamentos || []).forEach(function(l){
      if (l.tipo !== "saida") return;
      var d = String(l.data || "").slice(0, 10);
      if (!d || d < de || d > ate) return;
      var v = parseFloat(l.valor) || 0;
      despesasPagas += v;
      var cat = l.categoria || "Outros";
      porCategoria[cat] = (porCategoria[cat] || 0) + v;
    });
    // O tamanho do período vem de quem chama. Derivá-lo das datas quebrava em
    // "Tudo", cujo início é uma data-sentinela inválida: a diferença dava NaN e
    // o rateio dos custos fixos aparecia como R$ 0,00 sem erro nenhum.
    var fixosPrevistos = custosFixosNoPeriodo(custosFixos, fat, Math.max(1, diasPer || 0));
    var despesas =
      cfg.origemDespesas === "configurados" ? fixosPrevistos :
      cfg.origemDespesas === "ambos"        ? despesasPagas + fixosPrevistos : despesasPagas;
    var recLiq = fat - impostos, lucroBruto = recLiq - custo;
    return {
      fat:fat, impostos:impostos, custo:custo, taxas:taxas, nPedidos:nPedidos,
      pedidosForaDoCaixa:pedidosForaDoCaixa, valorForaDoCaixa:valorForaDoCaixa,
      despesasPagas:despesasPagas, mercadoriaPaga:mercadoriaPaga, porCategoria:porCategoria,
      fixosPrevistos:fixosPrevistos, despesas:despesas,
      recLiq:recLiq, lucroBruto:lucroBruto, lucro: lucroBruto - taxas - despesas,
    };
  }

  var A = apurar(cutoff, hoje, dias);
  var ant = periodoAnterior(periodo, hoje);
  var B = comparar && ant ? apurar(ant.de, ant.ate, ant.dias) : null;

  var fat=A.fat, impostos=A.impostos, custo=A.custo, taxas=A.taxas, nPedidos=A.nPedidos;
  var pedidosForaDoCaixa=A.pedidosForaDoCaixa, valorForaDoCaixa=A.valorForaDoCaixa;

  var despesasPagas=A.despesasPagas, mercadoriaPaga=A.mercadoriaPaga, porCategoria=A.porCategoria;
  var fixosPrevistos=A.fixosPrevistos, despesas=A.despesas;
  var recLiq=A.recLiq, lucroBruto=A.lucroBruto, lucro=A.lucro;
  var margemLiq = fat ? lucro/fat*100 : 0;
  var equilibrio = pontoDeEquilibrio(fat, impostos, custo, taxas, despesas);

  var linhas = [
    ["Receita bruta", fat, false, "var(--text-strong)", B && B.fat],
    ["(-) Impostos e deduções", -impostos, false, "#FF7043", B && -B.impostos],
    ["= Receita líquida", recLiq, true, "var(--text-strong)", B && B.recLiq],
    ["(-) Custo dos produtos (CMV)", -custo, false, "#768692", B && -B.custo],
    ["= Lucro bruto", lucroBruto, true, "var(--text-strong)", B && B.lucroBruto],
    ["(-) Taxas dos marketplaces", -taxas, false, "#FFC107", B && -B.taxas],
    ["(-) Despesas e custos fixos", -despesas, false, "#8492a8", B && -B.despesas],
    ["= Lucro líquido", lucro, true, lucro>=0?"#0a9d4e":"#FF5252", B && B.lucro],
  ];
  var composicao = [
    { name:"Receita bruta", value:fat, cor:"#768692" },
    { name:"Impostos", value:impostos, cor:"#FF7043" },
    { name:"CMV", value:custo, cor:"#768592" },
    { name:"Taxas ML", value:taxas, cor:"#FFC107" },
    { name:"Despesas", value:despesas, cor:"#8492a8" },
    { name:"Lucro líq.", value:Math.max(0,lucro), cor:"#0a9d4e" },
  ];
  var cats = Object.keys(porCategoria).sort(function(a,b){ return porCategoria[b]-porCategoria[a]; });

  // Avisos: cada um só aparece quando a situação que ele descreve existe.
  var avisos = [];
  if (comparar && !ant) avisos.push({ tom:"info",
    txt:"“Tudo” não tem período anterior de mesmo tamanho para comparar. Escolha 7, 30 ou 90 dias." });
  if (caixa && pedidosForaDoCaixa > 0) avisos.push({
    tom:"info",
    txt: pedidosForaDoCaixa + " venda(s) do período, somando " + fmt(valorForaDoCaixa) + ", ainda não entraram: " +
         "no regime de caixa a receita só conta quando você confirma o recebimento em Contas a receber.",
  });
  if (cfg.origemDespesas === "pagas" && despesasPagas === 0 && fixosPrevistos > 0) avisos.push({
    tom:"alerta",
    txt: "Você tem " + fmt(fixosPrevistos) + " em custos fixos cadastrados e nenhuma conta paga no período. " +
         "O lucro acima está SEM essas despesas. Troque a origem para “custos fixos configurados” em Ajustes, " +
         "ou registre os pagamentos em Contas a pagar.",
  });
  if (cfg.origemDespesas === "ambos" && despesasPagas > 0 && fixosPrevistos > 0) avisos.push({
    tom:"alerta",
    txt: "As despesas somam contas pagas (" + fmt(despesasPagas) + ") e custos fixos configurados (" + fmt(fixosPrevistos) + "). " +
         "Se o aluguel está nos dois lugares, ele está sendo contado duas vezes.",
  });
  if (mercadoriaPaga > 0) avisos.push({
    tom:"info",
    txt: fmt(mercadoriaPaga) + " em contas de " + (cfg.categoriasMercadoria||[]).join(", ") +
         " foram pagas no período e NÃO entraram como despesa: compra de mercadoria já é contada no CMV de cada venda.",
  });

  function setCfg(k, v){ salvarConfig(Object.assign({}, cfg, { [k]: v })); }
  var selAjuste = { background:"var(--bg)", border:"1px solid var(--border)", color:"var(--text-strong)", padding:"7px 10px", borderRadius:7, fontSize:12.5 };
  var corAviso = { info:["var(--surface)","var(--border)","var(--text-3)"], alerta:["rgba(255,193,7,.10)","rgba(255,193,7,.5)","var(--text-2)"] };

  return (
    <FinanceiroShell tab={tab} setTab={setTab} titulo="DRE — Demonstrativo de resultado"
      sub={"Regime de " + (caixa ? "caixa · conta no dia em que o dinheiro entra ou sai" : "competência · conta no dia da venda ou da compra")
           + (caixa && cfg.repasse === "confirmado" ? " · repasse do ML só quando você confirma" : "")}
      periodo={periodo} setPeriodo={setPeriodo}
      controles={<>
        <button onClick={function(){ setComparar(function(v){ return !v; }); }} disabled={periodo === "tudo"}
          title={periodo === "tudo" ? "“Tudo” não tem período anterior para comparar." : ""}
          style={{ padding:"7px 14px", borderRadius:8, border:"1px solid " + (comparar ? "var(--ui-accent)" : "var(--border)"), cursor: periodo === "tudo" ? "not-allowed" : "pointer", fontSize:12, fontWeight:600,
                   background: comparar ? "rgba(10,157,78,.12)" : "var(--surface)", color: periodo === "tudo" ? "var(--text-4)" : (comparar ? "var(--ui-accent)" : "var(--text-2)") }}>
          ⇄ Comparar períodos
        </button>
        <button onClick={function(){ setMostrarAjustes(function(v){ return !v; }); }}
          style={{ padding:"7px 14px", borderRadius:8, border:"1px solid var(--border)", cursor:"pointer", fontSize:12, fontWeight:600, background:"var(--surface)", color:"var(--text-2)" }}>⚙ Ajustes</button>
        <button onClick={exportarPDF} className="btn-pdf" title="Salvar/Imprimir como PDF">⬇ Exportar PDF</button>
      </>}
      kpis={[
        { rotulo:"Receita bruta", valor:fmt(fat), cor:FIN_COR.entrada, nota:nPedidos + " pedido(s)" },
        { rotulo:"CMV + taxas", valor:fmt(custo + taxas), cor:FIN_COR.saida, nota:"custo do produto e do marketplace" },
        { rotulo:"Despesas", valor:fmt(despesas), cor:FIN_COR.saida, nota: cfg.origemDespesas === "configurados" ? "custos fixos configurados" : "contas pagas e lançamentos" },
        { rotulo:"Lucro líquido", valor:fmt(lucro), cor: lucro >= 0 ? FIN_COR.entrada : FIN_COR.saida, nota: fat ? "margem " + margemLiq.toFixed(1) + "%" : "sem receita no período" },
      ]}>
      {mostrarAjustes && (
        <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:12, padding:"16px 18px", marginBottom:14 }}>
          <div style={{ fontSize:13.5, fontWeight:600, color:"var(--text-strong)", marginBottom:12 }}>Como o resultado é apurado</div>
          <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(240px,1fr))", gap:14 }}>
            <div>
              <label style={{ fontSize:11.5, color:"var(--text-3)", fontWeight:600, display:"block", marginBottom:4 }}>Regime</label>
              <select value={cfg.regime} onChange={function(e){ setCfg("regime", e.target.value); }} style={{ ...selAjuste, width:"100%" }}>
                <option value="caixa">Caixa — quando o dinheiro entra e sai</option>
                <option value="competencia">Competência — quando a venda acontece</option>
              </select>
            </div>
            <div>
              <label style={{ fontSize:11.5, color:"var(--text-3)", fontWeight:600, display:"block", marginBottom:4 }}>Repasse do Mercado Livre</label>
              <select value={cfg.repasse} onChange={function(e){ setCfg("repasse", e.target.value); }} style={{ ...selAjuste, width:"100%" }} disabled={!caixa}>
                <option value="confirmado">Só quando eu confirmo o recebimento</option>
                <option value="previsto">Na data de liberação do ML</option>
              </select>
            </div>
            <div>
              <label style={{ fontSize:11.5, color:"var(--text-3)", fontWeight:600, display:"block", marginBottom:4 }}>Despesas vêm de</label>
              <select value={cfg.origemDespesas} onChange={function(e){ setCfg("origemDespesas", e.target.value); }} style={{ ...selAjuste, width:"100%" }}>
                <option value="pagas">Contas a pagar — o que foi realmente pago</option>
                <option value="configurados">Custos fixos configurados — valor previsto</option>
                <option value="ambos">As duas, somando</option>
              </select>
            </div>
          </div>
          <div style={{ fontSize:11.5, color:"var(--text-3)", marginTop:12, lineHeight:1.6 }}>
            Contas das categorias <b>{(cfg.categoriasMercadoria||[]).join(", ") || "nenhuma"}</b> são tratadas como compra de
            mercadoria e ficam fora das despesas, porque o custo delas já entra pelo CMV de cada venda.
          </div>
        </div>
      )}

      <div style={{ display:"flex", gap:14, flexWrap:"wrap", alignItems:"flex-start" }}>
        <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:12, padding:"8px 18px", flex:1, minWidth:340, maxWidth:560 }}>
          {B && (
            <div style={{ display:"flex", justifyContent:"flex-end", gap:16, padding:"6px 0 2px", fontSize:10.5, color:"var(--text-4)", textTransform:"uppercase", letterSpacing:.5 }}>
              <span style={{ width:110, textAlign:"right" }}>período anterior</span>
              <span style={{ width:110, textAlign:"right" }}>este período</span>
              <span style={{ width:74, textAlign:"right" }}>variação</span>
            </div>
          )}
          {linhas.map(function(l,i){
            var isTot = l[2];
            var antV = l[4];
            // Variação em % só faz sentido quando havia base. De zero para
            // qualquer coisa não é "infinito por cento", é "não havia antes".
            var varPct = (B && typeof antV === "number" && Math.abs(antV) > 0.005) ? ((l[1] - antV) / Math.abs(antV)) * 100 : null;
            return <div key={i} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", gap:16, padding:"12px 0", borderBottom: i < linhas.length-1 ? "1px solid var(--border-soft)" : "none", background: isTot ? "linear-gradient(90deg, rgba(128,140,168,.06), transparent)" : "none" }}>
              <span style={{ fontSize:14, fontWeight: isTot ? 800 : 500, color: isTot ? "var(--text-strong)" : "var(--text-2)", flex:1, minWidth:0 }}>{l[0]}</span>
              {B && <span style={{ width:110, textAlign:"right", fontSize:13, color:"var(--text-4)", fontVariantNumeric:"tabular-nums" }}>{fmt(antV)}</span>}
              <span style={{ width: B ? 110 : "auto", textAlign:"right", fontSize:14, fontWeight: isTot ? 800 : 600, color: l[3], fontVariantNumeric:"tabular-nums" }}>{fmt(l[1])}</span>
              {B && <span style={{ width:74, textAlign:"right", fontSize:12, fontWeight:600, fontVariantNumeric:"tabular-nums",
                     color: varPct == null ? "var(--text-4)" : (varPct >= 0 ? FIN_COR.entrada : FIN_COR.saida) }}>
                {varPct == null ? "—" : (varPct >= 0 ? "+" : "") + varPct.toFixed(0) + "%"}
              </span>}
            </div>;
          })}
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"12px 0", marginTop:2, borderTop:"1px solid var(--border)" }}>
            <span style={{ fontSize:13, fontWeight:500, color:"var(--text-3)" }}>Margem líquida</span>
            <span style={{ fontSize:15, fontWeight:600, color: margemLiq>=0?"#0a9d4e":"#FF5252" }}>{fat ? margemLiq.toFixed(1) + "%" : "—"}</span>
          </div>
          <div style={{ fontSize:11.5, color:"var(--text-4)", padding:"0 0 10px" }}>
            {nPedidos} pedido(s) no resultado
            {cfg.origemDespesas !== "configurados" && cats.length ? " · " + cats.length + " categoria(s) de despesa" : ""}
          </div>
        </div>

        <ChartCard titulo="Composição do resultado" sub="Do faturamento ao lucro líquido" minW={320} flex={1}>
          {fat === 0 ? <div style={{ color:"var(--text-3)", fontSize:13, padding:"30px 0", textAlign:"center" }}>Sem receita no período.</div> :
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={composicao} layout="vertical" margin={{ top:4, right:16, left:10, bottom:0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID} horizontal={false} />
              <XAxis type="number" tick={{ fill:CHART_AXIS, fontSize:11 }} tickLine={false} axisLine={false} tickFormatter={function(v){ return "R$"+(v>=1000?(v/1000).toFixed(0)+"k":v); }} />
              <YAxis type="category" dataKey="name" tick={{ fill:CHART_AXIS, fontSize:11 }} tickLine={false} axisLine={false} width={92} />
              <RTooltip content={<TipMoeda />} cursor={{ fill:"rgba(128,140,168,.08)" }} />
              <Bar dataKey="value" name="Valor" radius={[0,6,6,0]} maxBarSize={26}>
                {composicao.map(function(c,i){ return <Cell key={i} fill={c.cor} />; })}
              </Bar>
            </BarChart>
          </ResponsiveContainer>}
        </ChartCard>
      </div>

      <div style={{ display:"flex", gap:14, flexWrap:"wrap", alignItems:"flex-start", marginTop:14 }}>
        <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:12, padding:"14px 18px", flex:1, minWidth:320 }}>
          <div style={{ fontSize:13.5, fontWeight:600, color:"var(--text-strong)", marginBottom:4 }}>Despesas por categoria</div>
          <div style={{ fontSize:11.5, color:"var(--text-3)", marginBottom:10 }}>Contas a pagar quitadas no período.</div>
          {cats.length === 0
            ? <div style={{ fontSize:13, color:"var(--text-3)", padding:"14px 0" }}>Nenhuma conta paga no período.</div>
            : cats.map(function(c){
                return <div key={c} style={{ display:"flex", justifyContent:"space-between", padding:"8px 0", borderBottom:"1px solid var(--border-soft)", fontSize:13 }}>
                  <span style={{ color:"var(--text-2)" }}>{c}</span>
                  <span style={{ color:"var(--text-strong)", fontWeight:600, fontVariantNumeric:"tabular-nums" }}>{fmt(porCategoria[c])}</span>
                </div>;
              })}
        </div>
        <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:12, padding:"14px 18px", flex:1, minWidth:320 }}>
          <div style={{ fontSize:13.5, fontWeight:600, color:"var(--text-strong)", marginBottom:4 }}>Ponto de equilíbrio</div>
          <div style={{ fontSize:11.5, color:"var(--text-3)", marginBottom:10 }}>Quanto precisa faturar no período para o lucro dar zero.</div>
          {!equilibrio
            ? <div style={{ fontSize:13, color:"var(--text-3)" }}>Sem receita no período — não dá para medir quanto sobra de cada real vendido.</div>
            : equilibrio.impossivel
              ? <div style={{ fontSize:13, color:FIN_COR.saida, lineHeight:1.6 }}>
                  Cada real vendido está saindo no negativo depois de imposto, CMV e taxa. Não existe
                  ponto de equilíbrio: vender mais aumenta o prejuízo. O que resolve é preço ou custo,
                  não volume.
                </div>
              : <div style={{ display:"flex", gap:24, flexWrap:"wrap" }}>
                  <div><div style={{ fontSize:11, color:"var(--text-3)" }}>Faturamento necessário</div>
                    <div style={{ fontSize:21, fontWeight:600, color: fat >= equilibrio.receita ? FIN_COR.entrada : FIN_COR.atencao }}>{fmt(equilibrio.receita)}</div></div>
                  <div><div style={{ fontSize:11, color:"var(--text-3)" }}>Faturou</div>
                    <div style={{ fontSize:21, fontWeight:600, color:FIN_COR.neutro }}>{fmt(fat)}</div></div>
                  <div><div style={{ fontSize:11, color:"var(--text-3)" }}>Sobra de cada real vendido</div>
                    <div style={{ fontSize:21, fontWeight:600, color:FIN_COR.neutro }}>{(equilibrio.pct*100).toFixed(1)}%</div></div>
                  <div style={{ width:"100%", fontSize:11.5, color:"var(--text-3)", lineHeight:1.55 }}>
                    {fat >= equilibrio.receita
                      ? "Passou do ponto de equilíbrio: as despesas do período estão cobertas."
                      : "Faltam " + fmt(equilibrio.receita - fat) + " de faturamento para cobrir as despesas do período."}
                  </div>
                </div>}
        </div>
      </div>

      <div style={{ display:"flex", gap:14, flexWrap:"wrap", alignItems:"flex-start", marginTop:14 }}>
        <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:12, padding:"14px 18px", flex:1, minWidth:320 }}>
          <div style={{ fontSize:13.5, fontWeight:600, color:"var(--text-strong)", marginBottom:4 }}>Previsto × pago</div>
          <div style={{ fontSize:11.5, color:"var(--text-3)", marginBottom:10 }}>Custos fixos cadastrados contra o que saiu de verdade.</div>
          <div style={{ display:"flex", gap:24, flexWrap:"wrap" }}>
            <div><div style={{ fontSize:11, color:"var(--text-3)" }}>Previsto ({dias} dias)</div>
              <div style={{ fontSize:19, fontWeight:600, color:"var(--text-2)" }}>{fmt(fixosPrevistos)}</div></div>
            <div><div style={{ fontSize:11, color:"var(--text-3)" }}>Pago</div>
              <div style={{ fontSize:19, fontWeight:600, color:"var(--text-strong)" }}>{fmt(despesasPagas)}</div></div>
            <div><div style={{ fontSize:11, color:"var(--text-3)" }}>Diferença</div>
              <div style={{ fontSize:19, fontWeight:600, color: despesasPagas > fixosPrevistos ? "#FF5252" : "#0a9d4e" }}>
                {fmt(despesasPagas - fixosPrevistos)}</div></div>
          </div>
          <div style={{ fontSize:11.5, color:"var(--text-3)", marginTop:10, lineHeight:1.5 }}>
            Só uma das duas colunas entra no lucro — a que estiver escolhida em Ajustes. Esta comparação é para
            você ver se está gastando acima do planejado.
          </div>
        </div>
      </div>

      {avisos.map(function(a,i){
        var c = corAviso[a.tom];
        return <div key={i} style={{ marginTop:12, fontSize:12.5, color:c[2], background:c[0], border:"1px solid "+c[1], borderRadius:10, padding:"11px 14px", lineHeight:1.6 }}>{a.txt}</div>;
      })}
    </FinanceiroShell>
  );
}

// Soma meses preservando o dia do vencimento. Dia 31 em mês de 30 cai no
// último dia do mês, não vira o dia 1 do seguinte — que é o que o Date faz
// sozinho e jogaria a conta para fora do mês a que pertence.
function somarMeses(iso, n) {
  var p = String(iso).slice(0,10).split("-");
  var ano = parseInt(p[0],10), mes = parseInt(p[1],10) - 1 + n, dia = parseInt(p[2],10);
  var d = new Date(Date.UTC(ano, mes, 1));
  var ultimo = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(dia, ultimo));
  return d.toISOString().slice(0,10);
}

// Expande uma conta recorrente nas contas do periodo. Cada uma e uma conta
// inteira e independente: pode ser paga, editada ou excluida sozinha. Ficam
// ligadas por serieId so para a tela saber dizer de que serie vieram.
var DIAS_SEMANA = [["1","Segunda-feira"],["2","Terça-feira"],["3","Quarta-feira"],["4","Quinta-feira"],["5","Sexta-feira"],["6","Sábado"],["0","Domingo"]];
function somarDiasIso(iso, n) {
  var d = new Date(String(iso).slice(0,10) + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0,10);
}
// Primeira data a partir de `iso` que cai no dia da semana pedido — inclusive o
// próprio `iso`, se já for esse dia.
function proximoDiaDaSemana(iso, dow) {
  var d = new Date(String(iso).slice(0,10) + "T12:00:00Z");
  var falta = (dow - d.getUTCDay() + 7) % 7;
  return somarDiasIso(iso, falta);
}

var MAX_SERIE = 260;   // teto de seguranca: 5 anos de semanal, 10 de mensal
function expandirRecorrencia(base) {
  var recorrentes = ["mensal", "semanal", "parcelada"];
  if (recorrentes.indexOf(base.ocorrencia) < 0) return [base];
  var venc = base.vencimento;
  if (!venc) return [base];
  var serie = "sr_" + Date.now() + "_" + Math.floor(Math.random()*1000);
  var datas = [];
  if (base.ocorrencia === "semanal") {
    var ate2 = base.recorrenciaAte || "";
    if (!ate2) return [base];
    // O vencimento informado define o começo; o dia da semana escolhido define
    // o ritmo. Se os dois discordam, a primeira parcela anda para o dia certo
    // em vez de a série inteira ficar fora do dia combinado.
    var dow = base.diaSemana == null || base.diaSemana === "" ? null : parseInt(base.diaSemana, 10);
    var atual = dow == null ? venc : proximoDiaDaSemana(venc, dow);
    for (var w = 0; w < MAX_SERIE && atual <= ate2; w++) { datas.push(atual); atual = somarDiasIso(atual, 7); }
  } else if (base.ocorrencia === "parcelada") {
    var n = Math.max(1, Math.min(MAX_SERIE, parseInt(base.parcelas, 10) || 1));
    for (var i = 0; i < n; i++) datas.push(somarMeses(venc, i));
  } else {
    var ate = base.recorrenciaAte || "";
    if (!ate) return [base];                       // sem limite nao se gera nada
    for (var k = 0; k < MAX_SERIE; k++) {
      var d = somarMeses(venc, k);
      if (d > ate) break;
      datas.push(d);
    }
  }
  var valorUn = parseFloat(base.valor) || 0;
  if (base.ocorrencia === "parcelada" && base.baseValor === "total" && datas.length > 0) {
    valorUn = Math.round((valorUn / datas.length) * 100) / 100;
  }
  return datas.map(function(d, i){
    return Object.assign({}, base, {
      id: "cp_" + Date.now() + "_" + i + "_" + Math.floor(Math.random()*1000),
      vencimento: d,
      valor: String(valorUn),
      valorTotal: valorUn * (1 + ((parseFloat(base.juros)||0) + (parseFloat(base.multa)||0)) / 100),
      serieId: serie, parcela: i + 1, parcelas: datas.length,
      status: "pendente",
    });
  });
}

// ── Pagamento de conta: total ou parcial ───────────────────────────────────
// Uma conta deixou de ser "paga ou não paga". Ela tem uma lista de pagamentos,
// e o que importa é o SALDO DEVEDOR — quanto ainda falta. Foi o caso que o
// próprio usuário descreveu quando lia as contas do Bling: valor original de
// R$ 1.000 com uma baixa parcial de R$ 400 não é uma conta de R$ 1.000 em
// aberto nem uma conta paga; são R$ 600 a pagar.
function pagamentosDe(c) {
  if (Array.isArray(c.pagamentos) && c.pagamentos.length) return c.pagamentos;
  // Contas antigas, quitadas antes de existir pagamento parcial: viram um
  // pagamento único, para o resto do sistema não precisar saber da diferença.
  if (c.status === "paga") {
    return [{ id: "leg_" + c.id, data: String(c.pago_em || c.vencimento || "").slice(0,10),
              valor: parseFloat(c.valorTotal || c.valor) || 0, conta: c.conta || "", legado: true }];
  }
  return [];
}
function pagoDe(c) { return pagamentosDe(c).reduce(function(s,p){ return s + (parseFloat(p.valor) || 0); }, 0); }
function saldoDe(c) {
  var total = parseFloat(c.valorTotal || c.valor) || 0;
  return Math.max(0, Math.round((total - pagoDe(c)) * 100) / 100);
}
// Cinco situações, não quatro: "parcial" existia na realidade e não na tela.
function situacaoConta(c, hoje) {
  if (c.status === "cancelada") return "cancelada";
  var saldo = saldoDe(c);
  if (saldo <= 0.005) return "paga";
  if (pagoDe(c) > 0) return "parcial";
  if (c.vencimento && c.vencimento < hoje) return "vencida";
  return "pendente";
}
var SITUACAO_CONTA = {
  pendente:  ["Pendente",  "var(--text-2)"],
  vencida:   ["Vencida",   "#FF5252"],
  parcial:   ["Parcial",   "#FFC107"],
  paga:      ["Paga",      "#0a9d4e"],
  cancelada: ["Cancelada", "var(--text-3)"],
};

// Registra o pagamento de uma ou várias contas de uma vez. Cada linha tem o
// próprio valor editável: pagar tudo é o padrão, pagar parte é só mudar o número.
function BaixaModal({ contas, contasBancarias, onConfirmar, onClose }) {
  var hoje = new Date().toISOString().slice(0,10);
  const [data, setData] = useState(hoje);
  const [conta, setConta] = useState((contasBancarias || [])[0] ? contasBancarias[0].id : "");
  const [valores, setValores] = useState(function(){
    var v = {}; (contas || []).forEach(function(c){ v[c.id] = String(saldoDe(c)); }); return v;
  });
  const [erro, setErro] = useState("");
  function setValor(id, x){ setValores(function(s){ return Object.assign({}, s, { [id]: x }); }); }
  var total = (contas || []).reduce(function(s,c){ return s + (parseFloat(valores[c.id]) || 0); }, 0);
  var algumParcial = (contas || []).some(function(c){
    var v = parseFloat(valores[c.id]) || 0;
    return v > 0 && v < saldoDe(c) - 0.005;
  });

  function confirmar(){
    var pgs = [];
    for (var i = 0; i < (contas || []).length; i++) {
      var c = contas[i], v = parseFloat(valores[c.id]) || 0;
      if (v <= 0) continue;
      if (v > saldoDe(c) + 0.005) {
        setErro("O valor de “" + (c.descricao || "conta") + "” passa do que falta pagar (" + fmt(saldoDe(c)) + ").");
        return;
      }
      pgs.push({ contaId: c.id, valor: Math.round(v * 100) / 100, data: data, conta: conta });
    }
    if (!pgs.length) { setErro("Informe ao menos um valor maior que zero."); return; }
    if (!data) { setErro("Informe a data do pagamento."); return; }
    onConfirmar(pgs);
  }

  return (
    <div className="modal-fundo" onClick={onClose}>
      <div className="modal-caixa" onClick={function(e){ e.stopPropagation(); }} style={{ width:720 }}>
        <div style={{ fontWeight:600, fontSize:17, color:"var(--text-strong)", marginBottom:4 }}>
          Baixar pagamento{(contas||[]).length > 1 ? " — " + contas.length + " contas" : ""}
        </div>
        <div className="nota" style={{ marginBottom:16 }}>
          O valor vem preenchido com o que falta pagar. Mude para registrar um pagamento parcial —
          a conta continua em aberto pelo restante.
        </div>
        {erro && <div className="aviso aviso-erro" style={{ marginTop:0, marginBottom:14 }}>{erro}</div>}

        <div className="tabela-wrap" style={{ maxHeight:300, overflowY:"auto", marginBottom:14 }}>
          <table className="tabela" style={{ minWidth:0 }}>
            <thead><tr>{["Fornecedor","Vencimento","Valor","Já pago","Falta","Pagar agora"].map(function(h){ return <th key={h} className="th">{h}</th>; })}</tr></thead>
            <tbody>
              {(contas||[]).map(function(c){
                var pago = pagoDe(c), saldo = saldoDe(c);
                return <tr key={c.id}>
                  <td className="td" style={{ color:"var(--text-strong)", maxWidth:220 }}>{c.descricao || "—"}</td>
                  <td className="td">{c.vencimento ? (fmtDate(c.vencimento)||c.vencimento) : "—"}</td>
                  <td className="td-num">{fmt(parseFloat(c.valorTotal || c.valor) || 0)}</td>
                  <td className="td-num">{pago > 0 ? fmt(pago) : "—"}</td>
                  <td className="td-num" style={{ fontWeight:600 }}>{fmt(saldo)}</td>
                  <td className="td" style={{ width:130 }}>
                    <input type="number" step="0.01" min="0" max={saldo} value={valores[c.id] || ""}
                      onChange={function(e){ setValor(c.id, e.target.value); }}
                      className="campo" style={{ padding:"6px 8px", fontSize:12.5 }} />
                  </td>
                </tr>;
              })}
            </tbody>
          </table>
        </div>

        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:12, marginBottom:16, alignItems:"end" }}>
          <div><label className="rotulo">Data do pagamento</label>
            <input type="date" value={data} onChange={function(e){ setData(e.target.value); }} className="campo" /></div>
          <div><label className="rotulo">Saiu de qual conta</label>
            <select value={conta} onChange={function(e){ setConta(e.target.value); }} className="campo">
              <option value="">— não definida —</option>
              {(contasBancarias||[]).map(function(cb){ return <option key={cb.id} value={cb.id}>{cb.nome}</option>; })}
            </select>
            {!conta && <div className="ajuda">Sem conta, não desconta de nenhum saldo.</div>}
          </div>
          <div style={{ textAlign:"right" }}>
            <div className="kpi-rot">Total a pagar agora</div>
            <div style={{ fontSize:22, fontWeight:700, color:"var(--text-strong)", fontVariantNumeric:"tabular-nums" }}>{fmt(total)}</div>
          </div>
        </div>

        {algumParcial && (
          <div className="aviso aviso-alerta" style={{ marginTop:0, marginBottom:14 }}>
            Pagamento parcial: a conta fica com a situação <b>Parcial</b> e continua em aberto pelo
            restante, que segue contando no fluxo de caixa e na prioridade de pagamento.
          </div>
        )}

        <div style={{ display:"flex", gap:8, justifyContent:"flex-end" }}>
          <button onClick={onClose} className="btn btn-sec">Cancelar</button>
          <button onClick={confirmar} className="btn btn-pri">Confirmar {fmt(total)}</button>
        </div>
      </div>
    </div>
  );
}

// Modal de conta a pagar.
function ContaModal({ conta, onSave, onClose, contasBancarias, categorias, fornecedores, onNovoFornecedor }) {
  var hoje = new Date().toISOString().slice(0,10);
  const [f, setF] = useState(function(){ return Object.assign({ descricao:"", categoria:"", emissao:hoje, competencia:hoje, vencimento:"", valor:"", historico:"", forma:"", conta:"", ndoc:"", juros:"0", multa:"0", ocorrencia:"unica", recorrenciaAte:"", parcelas:"12", baseValor:"cada", diaSemana:"", status:"pendente" }, conta || {}); });
  const [aba, setAba] = useState("pagamento");
  const [buscaForn, setBuscaForn] = useState(null);   // null = fechado; string = termo digitado
  const [novoForn, setNovoForn] = useState(false);
  function set(k,v){ setF(function(s){ return Object.assign({}, s, { [k]:v }); }); }
  // A lupa filtra pelo que já está cadastrado; o + abre o cadastro completo.
  var fornOrdenados = (fornecedores || []).map(nomeFornecedor).filter(Boolean).sort(function(a,b){ return a.localeCompare(b, "pt-BR"); });
  var fornAchados = fornOrdenados.filter(function(n){
    var t = String(buscaForn || "").trim().toLowerCase();
    return !t || n.toLowerCase().indexOf(t) >= 0;
  });
  var valorNum = parseFloat(f.valor)||0, jurosPct = parseFloat(f.juros)||0, multaPct = parseFloat(f.multa)||0;
  var jurosVal = valorNum*jurosPct/100, multaVal = valorNum*multaPct/100, totalVal = valorNum + jurosVal + multaVal;
  // Uma conta ja existente nunca vira serie: editar a parcela de marco nao pode
  // recriar o ano inteiro. A recorrencia so expande na criacao.
  var editando = !!(conta && conta.id);
  var previa = editando ? [] : expandirRecorrencia(Object.assign({}, f, { valorTotal: totalVal }));
  // Editar uma parcela e quase sempre editar a regra, nao aquele mes: o valor do
  // aluguel subiu, o fornecedor mudou de nome. Mas nem sempre — as vezes e um
  // acerto pontual. Em vez de escolher pelo usuario, a tela pergunta, e so
  // quando ha serie e algo mudou de fato.
  const [alcance, setAlcance] = useState(null);
  function houveMudanca(){
    if (!conta) return true;
    return ["descricao","categoria","valor","juros","multa","forma","conta","ndoc","historico"].some(function(k){
      return String(f[k] == null ? "" : f[k]) !== String(conta[k] == null ? "" : conta[k]);
    });
  }
  function salvar(baixa, escopo){
    var p = Object.assign({}, f, { valorTotal: totalVal });
    if (!p.descricao){ alert("Informe o fornecedor."); return; }
    if (editando && conta.serieId && !escopo && !baixa && houveMudanca()) { setAlcance(true); return; }
    if (escopo) { onSave({ conta: Object.assign({}, p), escopo: escopo, serieId: conta.serieId, vencimento: conta.vencimento }); return; }
    if (!editando && (f.ocorrencia === "mensal" || f.ocorrencia === "semanal") && !f.recorrenciaAte) {
      alert("Informe até quando a conta se repete, na aba Ocorrência.\n\nSem uma data limite não dá para saber quantas contas criar."); return;
    }
    if (!p.id) p.id = "cp_"+Date.now();
    if (baixa){
      p.status="paga"; p.pago_em=hoje;
      p.pagamentos = [{ id:"pg_"+Date.now(), data:hoje, valor: totalVal, conta: p.conta || "" }];
    }
    if (editando || f.ocorrencia === "unica") { onSave(p); return; }
    var serie = expandirRecorrencia(p);
    if (baixa && serie.length) {
      serie[0].status = "paga"; serie[0].pago_em = hoje;
      serie[0].pagamentos = [{ id:"pg_"+Date.now(), data:hoje, valor: parseFloat(serie[0].valorTotal || serie[0].valor) || 0, conta: p.conta || "" }];
    }
    onSave(serie);
  }
  var campo = { width:"100%", background:"var(--surface)", border:"1px solid var(--border)", color:"var(--text-strong)", padding:"9px 11px", borderRadius:8, fontSize:13, outline:"none", boxSizing:"border-box" };
  var lbl = { fontSize:11.5, color:"var(--text-3)", fontWeight:600, marginBottom:4, display:"block" };
  var req = <span style={{ color:"#FF5252" }}> *</span>;
  function TabBtn(id, label){ var a=aba===id; return <button onClick={function(){ setAba(id); }} style={{ background:"none", border:"none", borderBottom: a?"2px solid var(--ui-accent)":"2px solid transparent", padding:"10px 4px", marginRight:22, cursor:"pointer", fontSize:13, fontWeight: a?700:500, color: a?"#0a9d4e":"var(--text-3)" }}>{label}</button>; }
  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,.45)", zIndex:600, display:"flex", alignItems:"flex-start", justifyContent:"center", padding:"24px 16px", overflowY:"auto" }} onClick={onClose}>
      <div onClick={function(e){ e.stopPropagation(); }} style={{ background:"var(--bg-2)", border:"1px solid var(--border)", borderRadius:14, width:780, maxWidth:"100%", display:"flex", flexDirection:"column", maxHeight:"92vh" }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"18px 22px 6px" }}>
          <div>
            <div style={{ fontWeight:600, fontSize:18, color:"var(--text-strong)" }}>Conta a pagar</div>
            {editando && conta && conta.serieId && (
              <div style={{ fontSize:11.5, color:"var(--text-3)", marginTop:2 }}>
                Parcela <b>{conta.parcela} de {conta.parcelas}</b> de uma série — a alteração vale só para ela.
              </div>
            )}
          </div>
          <button onClick={onClose} style={{ background:"none", border:"none", color:"var(--text-3)", fontSize:22, cursor:"pointer" }}>×</button>
        </div>
        {alcance && (
          <div style={{ margin:"6px 22px 0", background:"var(--surface)", border:"1px solid var(--ui-accent)", borderRadius:12, padding:"14px 16px" }}>
            <div style={{ fontSize:13.5, fontWeight:600, color:"var(--text-strong)", marginBottom:4 }}>Aplicar a alteração em quais contas?</div>
            <div style={{ fontSize:12, color:"var(--text-3)", marginBottom:12, lineHeight:1.55 }}>
              Esta conta é a parcela {conta.parcela} de {conta.parcelas}. Contas já pagas nunca são alteradas.
            </div>
            <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
              <button onClick={function(){ setAlcance(null); salvar(false, "uma"); }}
                style={{ background:"var(--surface-3)", border:"1px solid var(--border)", color:"var(--text-2)", fontWeight:600, padding:"9px 16px", borderRadius:9, cursor:"pointer", fontSize:12.5 }}>Só esta</button>
              <button onClick={function(){ setAlcance(null); salvar(false, "proximas"); }}
                style={{ background:"var(--ui-accent)", border:"none", color:"var(--ui-accent-text)", fontWeight:600, padding:"9px 16px", borderRadius:9, cursor:"pointer", fontSize:12.5 }}>Esta e as próximas</button>
              <button onClick={function(){ setAlcance(null); salvar(false, "todas"); }}
                style={{ background:"var(--surface-3)", border:"1px solid var(--border)", color:"var(--text-2)", fontWeight:600, padding:"9px 16px", borderRadius:9, cursor:"pointer", fontSize:12.5 }}>Todas as em aberto</button>
              <div style={{ flex:1 }} />
              <button onClick={function(){ setAlcance(null); }}
                style={{ background:"none", border:"none", color:"var(--text-3)", cursor:"pointer", fontSize:12.5 }}>Voltar</button>
            </div>
          </div>
        )}
        <div style={{ padding:"6px 22px", overflowY:"auto" }}>
          <div style={{ display:"grid", gridTemplateColumns:"2fr 1fr", gap:12, marginBottom:12 }}>
            <div style={{ position:"relative" }}><label style={lbl}>Fornecedor{req}</label>
              <div style={{ display:"flex", gap:6 }}>
                <input value={f.descricao||""} onChange={function(e){ set("descricao", e.target.value); }} placeholder="Nome do fornecedor" style={{ ...campo, flex:1 }} />
                <button type="button" onClick={function(){ setBuscaForn(buscaForn == null ? "" : null); }}
                  title={fornOrdenados.length ? "Buscar fornecedor cadastrado (" + fornOrdenados.length + ")" : "Nenhum fornecedor cadastrado ainda"}
                  style={{ background: buscaForn != null ? "rgba(10,157,78,.14)" : "var(--surface)", border:"1px solid " + (buscaForn != null ? "var(--ui-accent)" : "var(--border)"),
                           color:"var(--text-2)", borderRadius:8, width:38, cursor:"pointer", fontSize:14, flexShrink:0 }}>🔍</button>
                <button type="button" onClick={function(){ setNovoForn(true); setBuscaForn(null); }} title="Adicionar cadastro de fornecedor"
                  style={{ background:"var(--surface)", border:"1px solid var(--border)", color:"var(--ui-accent)", borderRadius:8, width:38, cursor:"pointer", fontSize:17, fontWeight:600, flexShrink:0 }}>+</button>
              </div>
              {buscaForn != null && (
                <div style={{ position:"absolute", zIndex:20, left:0, right:0, marginTop:4, background:"var(--bg-2)", border:"1px solid var(--border)", borderRadius:10, boxShadow:"0 10px 28px rgba(0,0,0,.35)", overflow:"hidden" }}>
                  <input autoFocus value={buscaForn} onChange={function(e){ setBuscaForn(e.target.value); }} placeholder="Digite para filtrar..."
                    style={{ ...campo, border:"none", borderBottom:"1px solid var(--border-soft)", borderRadius:0 }} />
                  <div style={{ maxHeight:210, overflowY:"auto" }}>
                    {fornAchados.length ? fornAchados.map(function(n,i){
                      return <button key={i} type="button" onClick={function(){ set("descricao", n); setBuscaForn(null); }}
                        style={{ display:"block", width:"100%", textAlign:"left", background:"none", border:"none", borderBottom:"1px solid var(--border-soft)",
                                 color:"var(--text-strong)", padding:"9px 12px", fontSize:13, cursor:"pointer" }}>{n}</button>;
                    }) : (
                      <div style={{ padding:"14px 12px", fontSize:12.5, color:"var(--text-3)" }}>
                        {fornOrdenados.length ? "Nenhum fornecedor com esse nome." : "Nenhum fornecedor cadastrado ainda."}
                        <button type="button" onClick={function(){ setNovoForn(true); setBuscaForn(null); }}
                          style={{ display:"block", marginTop:8, background:"var(--ui-accent)", border:"none", color:"var(--ui-accent-text)", fontWeight:600, padding:"7px 14px", borderRadius:8, cursor:"pointer", fontSize:12.5 }}>+ Adicionar cadastro</button>
                      </div>
                    )}
                  </div>
                </div>
              )}
              <div style={{ fontSize:10.5, color:"var(--text-4)", marginTop:3 }}>Fornecedor novo entra no cadastro ao salvar.</div>
            </div>
            <div><label style={lbl}>Valor (R$){req}</label><input type="number" step="0.01" value={f.valor||""} onChange={function(e){ set("valor", e.target.value); }} placeholder="0,00" style={campo} /></div>
          </div>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:12, marginBottom:12 }}>
            <div><label style={lbl}>Emissão{req}</label><input type="date" value={f.emissao||""} onChange={function(e){ set("emissao", e.target.value); }} style={campo} /></div>
            <div><label style={lbl}>Competência{req}</label><input type="date" value={f.competencia||""} onChange={function(e){ set("competencia", e.target.value); }} style={campo} /></div>
            <div><label style={lbl}>Vencimento{req}</label><input type="date" value={f.vencimento||""} onChange={function(e){ set("vencimento", e.target.value); }} style={campo} /></div>
          </div>
          <div style={{ marginBottom:12 }}><label style={lbl}>Histórico</label><textarea value={f.historico||""} onChange={function(e){ set("historico", e.target.value); }} rows={2} style={{ ...campo, resize:"vertical" }} /></div>

          <div style={{ borderBottom:"1px solid var(--border)", marginBottom:16 }}>{TabBtn("pagamento","Pagamento")}{TabBtn("ocorrencia","Ocorrência")}{TabBtn("anexos","Anexos")}</div>

          {aba==="pagamento" && <>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:12, marginBottom:12 }}>
              <div><label style={lbl}>Forma de pagamento</label><select value={f.forma||""} onChange={function(e){ set("forma", e.target.value); }} style={campo}><option value="">Selecione</option><option>Dinheiro</option><option>Pix</option><option>Cartão</option><option>Boleto</option><option>Transferência</option></select></div>
              <div><label style={lbl}>Sai de qual conta</label>
                <select value={f.conta||""} onChange={function(e){ set("conta", e.target.value); }} style={campo}>
                  <option value="">— não definida —</option>
                  {(contasBancarias||[]).map(function(cb){ return <option key={cb.id} value={cb.id}>{cb.nome}</option>; })}
                </select>
                <div style={{ fontSize:10.5, color:"var(--text-4)", marginTop:3 }}>Sem isso, a baixa não desconta de nenhum saldo.</div>
              </div>
              <div><label style={lbl}>Categoria</label>
                <input value={f.categoria||""} onChange={function(e){ set("categoria", e.target.value); }} placeholder="Sem categoria" list="lista-cat-conta" style={campo} />
                <datalist id="lista-cat-conta">{(categorias||[]).map(function(c){ return <option key={c} value={c} />; })}</datalist>
                <div style={{ fontSize:10.5, color:"var(--text-4)", marginTop:3 }}>Categoria nova entra na lista ao salvar.</div>
              </div>
              <div><label style={lbl}>Nº documento</label><input value={f.ndoc||""} onChange={function(e){ set("ndoc", e.target.value); }} style={campo} /></div>
            </div>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12 }}>
              <div><label style={lbl}>Juros mensal (%)</label><input type="number" step="0.01" value={f.juros||""} onChange={function(e){ set("juros", e.target.value); }} style={campo} /></div>
              <div><label style={lbl}>Multa (%)</label><input type="number" step="0.01" value={f.multa||""} onChange={function(e){ set("multa", e.target.value); }} style={campo} /></div>
            </div>
          </>}
          {aba==="ocorrencia" && <div>
            <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(220px,1fr))", gap:12 }}>
              <div><label style={lbl}>Ocorrência</label>
                <select value={f.ocorrencia||"unica"} onChange={function(e){ set("ocorrencia", e.target.value); }} style={campo} disabled={editando}>
                  <option value="unica">Única</option>
                  <option value="semanal">Semanal (recorrente)</option>
                  <option value="mensal">Mensal (recorrente)</option>
                  <option value="parcelada">Parcelada</option>
                </select>
              </div>
              {f.ocorrencia === "semanal" && <>
                <div><label style={lbl}>Vence toda{req}</label>
                  <select value={f.diaSemana||""} onChange={function(e){ set("diaSemana", e.target.value); }} style={campo} disabled={editando}>
                    <option value="">— use o dia do vencimento —</option>
                    {DIAS_SEMANA.map(function(d){ return <option key={d[0]} value={d[0]}>{d[1]}</option>; })}
                  </select>
                  <div style={{ fontSize:10.5, color:"var(--text-4)", marginTop:3 }}>A primeira parcela anda para o próximo dia escolhido, se preciso.</div>
                </div>
                <div><label style={lbl}>Repetir até{req}</label>
                  <input type="date" value={f.recorrenciaAte||""} onChange={function(e){ set("recorrenciaAte", e.target.value); }} style={campo} disabled={editando} />
                </div>
              </>}
              {f.ocorrencia === "mensal" && (
                <div><label style={lbl}>Repetir até{req}</label>
                  <input type="date" value={f.recorrenciaAte||""} onChange={function(e){ set("recorrenciaAte", e.target.value); }} style={campo} disabled={editando} />
                  <div style={{ fontSize:10.5, color:"var(--text-4)", marginTop:3 }}>Última data em que a conta se repete.</div>
                </div>
              )}
              {f.ocorrencia === "parcelada" && <>
                <div><label style={lbl}>Número de parcelas</label>
                  <input type="number" min="1" max="120" value={f.parcelas||""} onChange={function(e){ set("parcelas", e.target.value); }} style={campo} disabled={editando} />
                </div>
                <div><label style={lbl}>O valor informado é</label>
                  <select value={f.baseValor||"cada"} onChange={function(e){ set("baseValor", e.target.value); }} style={campo} disabled={editando}>
                    <option value="cada">de cada parcela</option>
                    <option value="total">o total, a dividir</option>
                  </select>
                </div>
              </>}
            </div>
            {editando ? (
              <div style={{ marginTop:14, background:"var(--surface)", border:"1px solid var(--border)", borderRadius:10, padding:"11px 14px", fontSize:12.5, color:"var(--text-3)", lineHeight:1.6 }}>
                Esta conta já existe, então a alteração vale <b>só para ela</b>.
                {conta && conta.serieId ? " Ela faz parte de uma série (parcela " + conta.parcela + " de " + conta.parcelas + "); as outras não mudam." : " Para criar uma série, cadastre uma conta nova."}
              </div>
            ) : f.ocorrencia !== "unica" && (
              <div style={{ marginTop:14, background: previa.length > 1 ? "rgba(10,157,78,.10)" : "rgba(255,193,7,.10)",
                            border:"1px solid " + (previa.length > 1 ? "rgba(10,157,78,.4)" : "rgba(255,193,7,.45)"),
                            borderRadius:10, padding:"11px 14px", fontSize:12.5, color:"var(--text-2)", lineHeight:1.6 }}>
                {previa.length > 1
                  ? <>Serão criadas <b>{previa.length} contas</b>, de {fmtDate(previa[0].vencimento)||previa[0].vencimento} até {fmtDate(previa[previa.length-1].vencimento)||previa[previa.length-1].vencimento},
                      de {fmt(parseFloat(previa[0].valor)||0)} cada — total {fmt(previa.reduce(function(a,c){ return a + (parseFloat(c.valor)||0); },0))}.
                      Cada uma pode ser paga, editada ou excluída sozinha.</>
                  : (f.ocorrencia === "mensal" || f.ocorrencia === "semanal") && !f.recorrenciaAte
                    ? (f.ocorrencia === "mensal" || f.ocorrencia === "semanal")
                        ? "Informe até quando a conta se repete para o sistema saber quantas criar."
                        : "Informe o número de parcelas."
                    : !f.vencimento
                      ? "Informe o vencimento da primeira, na aba Pagamento."
                      : "Com estes valores sai só uma conta."}
              </div>
            )}
          </div>}
          {aba==="anexos" && <div style={{ border:"1px dashed var(--border)", borderRadius:10, padding:"28px", textAlign:"center", color:"var(--text-3)", fontSize:13 }}>📎 Anexos ficam disponíveis com a integração de arquivos.</div>}

          <div style={{ display:"flex", flexWrap:"wrap", gap:18, background:"var(--surface)", border:"1px solid var(--border)", borderRadius:10, padding:"12px 16px", marginTop:16 }}>
            {[["Vencimento original", f.vencimento?(fmtDate(f.vencimento)||f.vencimento):"—"],["Valor original", fmt(valorNum)],["Juros", fmt(jurosVal)],["Multa", fmt(multaVal)],["Valor total", fmt(totalVal)]].map(function(x,i){ return <div key={i}><div style={{ fontSize:11, color:"var(--text-3)" }}>{x[0]}</div><div style={{ fontSize:13, fontWeight:600, color:"var(--text-strong)" }}>{x[1]}</div></div>; })}
          </div>
        </div>
        <div style={{ display:"flex", justifyContent:"flex-end", gap:12, padding:"14px 22px", borderTop:"1px solid var(--border-soft)" }}>
          <button onClick={onClose} style={{ background:"none", border:"none", color:"var(--text-3)", fontWeight:600, padding:"10px 16px", cursor:"pointer", fontSize:13 }}>Cancelar</button>
          <button onClick={function(){ salvar(true); }} style={{ background:"var(--surface)", border:"1px solid var(--ui-accent)", color:"var(--ui-accent)", fontWeight:600, padding:"10px 18px", borderRadius:9, cursor:"pointer", fontSize:13 }}>Salvar e dar baixa</button>
          <button onClick={function(){ salvar(false); }} style={{ background:"var(--ui-accent)", border:"none", color:"var(--ui-accent-text)", fontWeight:600, padding:"10px 24px", borderRadius:9, cursor:"pointer", fontSize:13 }}>Salvar</button>
        </div>
      </div>
      {novoForn && <div onClick={function(e){ e.stopPropagation(); }}><FornecedorModal onClose={function(){ setNovoForn(false); }}
        onSave={function(nf){
          // Grava no cadastro e já traz o nome para a conta aberta, para não ter
          // que digitar de novo o que acabou de ser cadastrado.
          if (onNovoFornecedor) onNovoFornecedor(nf);
          set("descricao", nomeFornecedor(nf));
          setNovoForn(false);
        }} /></div>}
    </div>
  );
}
// Contas a pagar: KPIs, busca, filtro de situação e cadastro/baixa de contas.
// ── Leitura de planilhas ───────────────────────────────────────────────────
// O importador de produtos quebra a linha com split(/[,;]/), o que corta
// "Fornecedor, Ltda" no meio e desloca todas as colunas seguintes. Em contas a
// pagar isso trocaria valor por data sem avisar, então aqui a leitura é feita
// de verdade: aspas, separador dentro do campo, quebra de linha dentro do campo.
function lerCSV(texto) {
  var t = String(texto || "").replace(/^﻿/, "");   // BOM do Excel
  if (!t.trim()) return [];
  // Separador: conta as ocorrências FORA de aspas na primeira linha e escolhe a
  // mais frequente. Ponto e vírgula é o padrão do Excel em português.
  var primeira = "", dentro = false;
  for (var i = 0; i < t.length; i++) {
    var ch = t[i];
    if (ch === '"') dentro = !dentro;
    else if (!dentro && (ch === "\n" || ch === "\r")) break;
    primeira += ch;
  }
  var cont = { ";":0, ",":0, "\t":0, "|":0 };
  dentro = false;
  for (var j = 0; j < primeira.length; j++) {
    var c2 = primeira[j];
    if (c2 === '"') dentro = !dentro;
    else if (!dentro && cont[c2] != null) cont[c2]++;
  }
  var sep = Object.keys(cont).reduce(function(a,b){ return cont[b] > cont[a] ? b : a; }, ";");
  if (!cont[sep]) sep = ";";

  var linhas = [], campo = "", linha = [];
  dentro = false;
  for (var k = 0; k < t.length; k++) {
    var ch2 = t[k];
    if (dentro) {
      if (ch2 === '"') {
        if (t[k+1] === '"') { campo += '"'; k++; }  // aspas escapada
        else dentro = false;
      } else campo += ch2;
      continue;
    }
    if (ch2 === '"') { dentro = true; continue; }
    if (ch2 === sep) { linha.push(campo); campo = ""; continue; }
    if (ch2 === "\r") continue;
    if (ch2 === "\n") { linha.push(campo); linhas.push(linha); linha = []; campo = ""; continue; }
    campo += ch2;
  }
  if (campo !== "" || linha.length) { linha.push(campo); linhas.push(linha); }
  return linhas
    .map(function(l){ return l.map(function(x){ return String(x).trim(); }); })
    .filter(function(l){ return l.some(function(x){ return x !== ""; }); });
}

// Leitor de .xlsx sem biblioteca. Um .xlsx é um ZIP de XMLs; o navegador já sabe
// descomprimir (DecompressionStream) e já sabe ler XML (DOMParser). Trazer uma
// biblioteca de planilha para isso somaria mais de 1 MB ao que todo usuário baixa.
async function lerXLSX(arrayBuffer) {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("Este navegador não sabe abrir .xlsx aqui. Salve a planilha como CSV e importe de novo.");
  }
  var dv = new DataView(arrayBuffer), u8 = new Uint8Array(arrayBuffer);

  // Fim do diretório central (EOCD): assinatura PK\5\6, procurada de trás para
  // frente porque pode haver comentário depois dela.
  var eocd = -1;
  for (var p = dv.byteLength - 22; p >= 0 && p > dv.byteLength - 66000; p--) {
    if (dv.getUint32(p, true) === 0x06054b50) { eocd = p; break; }
  }
  if (eocd < 0) throw new Error("Arquivo .xlsx inválido ou corrompido.");
  var nEntradas = dv.getUint16(eocd + 10, true);
  var inicioCD = dv.getUint32(eocd + 16, true);

  async function inflar(comprimido, metodo) {
    if (metodo === 0) return comprimido;                       // guardado sem compressão
    if (metodo !== 8) throw new Error("Compressão não suportada no .xlsx (método " + metodo + ").");
    var ds = new DecompressionStream("deflate-raw");
    var stream = new Blob([comprimido]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  var arquivos = {}, off = inicioCD;
  for (var e = 0; e < nEntradas; e++) {
    if (dv.getUint32(off, true) !== 0x02014b50) break;
    var metodo = dv.getUint16(off + 10, true);
    var tamComp = dv.getUint32(off + 20, true);
    var tamNome = dv.getUint16(off + 28, true);
    var tamExtra = dv.getUint16(off + 30, true);
    var tamCom = dv.getUint16(off + 32, true);
    var offLocal = dv.getUint32(off + 42, true);
    var nome = new TextDecoder().decode(u8.subarray(off + 46, off + 46 + tamNome));
    // O cabeçalho local repete nome e extra com tamanhos PRÓPRIOS — usar os do
    // diretório central aqui é o erro clássico que desloca os dados em alguns arquivos.
    var nomeLocal = dv.getUint16(offLocal + 26, true);
    var extraLocal = dv.getUint16(offLocal + 28, true);
    var ini = offLocal + 30 + nomeLocal + extraLocal;
    arquivos[nome] = { dados: u8.subarray(ini, ini + tamComp), metodo: metodo };
    off += 46 + tamNome + tamExtra + tamCom;
  }

  async function xml(nome) {
    if (!arquivos[nome]) return null;
    var bytes = await inflar(arquivos[nome].dados, arquivos[nome].metodo);
    return new DOMParser().parseFromString(new TextDecoder().decode(bytes), "application/xml");
  }

  // Textos repetidos ficam numa tabela à parte; a célula guarda só o índice.
  var compart = [];
  var docSS = await xml("xl/sharedStrings.xml");
  if (docSS) {
    var sis = docSS.getElementsByTagName("si");
    for (var s = 0; s < sis.length; s++) {
      var ts = sis[s].getElementsByTagName("t"), txt = "";
      for (var ti = 0; ti < ts.length; ti++) txt += ts[ti].textContent;
      compart.push(txt);
    }
  }

  // Primeira planilha do arquivo, na ordem em que o Excel a lista.
  var nomePlanilha = "xl/worksheets/sheet1.xml";
  if (!arquivos[nomePlanilha]) {
    var qualquer = Object.keys(arquivos).filter(function(n){ return /^xl\/worksheets\/.*\.xml$/.test(n); }).sort();
    if (!qualquer.length) throw new Error("Não encontrei nenhuma planilha dentro do arquivo.");
    nomePlanilha = qualquer[0];
  }
  var doc = await xml(nomePlanilha);
  var rows = doc.getElementsByTagName("row");
  var matriz = [];
  for (var r = 0; r < rows.length; r++) {
    var cs = rows[r].getElementsByTagName("c"), linha2 = [];
    for (var ci = 0; ci < cs.length; ci++) {
      var cel = cs[ci];
      var ref = cel.getAttribute("r") || "";
      var col = ref.replace(/[0-9]/g, "");
      // "AB" → índice 27. A coluna vai na posição certa mesmo quando o Excel
      // omite células vazias, o que ele faz o tempo todo.
      var idx = 0;
      for (var q = 0; q < col.length; q++) idx = idx * 26 + (col.charCodeAt(q) - 64);
      idx = Math.max(0, idx - 1);
      var tipo = cel.getAttribute("t");
      var valor = "";
      if (tipo === "s") {
        var vs = cel.getElementsByTagName("v")[0];
        valor = vs ? (compart[parseInt(vs.textContent, 10)] || "") : "";
      } else if (tipo === "inlineStr") {
        var tsi = cel.getElementsByTagName("t");
        for (var w = 0; w < tsi.length; w++) valor += tsi[w].textContent;
      } else {
        var v2 = cel.getElementsByTagName("v")[0];
        valor = v2 ? v2.textContent : "";
      }
      while (linha2.length < idx) linha2.push("");
      linha2[idx] = String(valor).trim();
    }
    matriz.push(linha2);
  }
  return matriz.filter(function(l){ return l.some(function(x){ return x !== ""; }); });
}

// Data em número (serial do Excel) para ISO. O Excel conta dias desde
// 1899-12-30 — não 31 — porque trata 1900 como bissexto, que não foi.
function serialParaISO(n) {
  var ms = Date.UTC(1899, 11, 30) + Math.round(n) * 86400000;
  return new Date(ms).toISOString().slice(0, 10);
}

// Aceita 31/12/2026, 31-12-2026, 2026-12-31, 31/12/26 e o serial do Excel.
// Devolve "" quando não reconhece, para a linha aparecer com erro em vez de
// entrar com uma data inventada.
function parseDataBR(v) {
  var t = String(v == null ? "" : v).trim();
  if (!t) return "";
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10);
  // \d{4} vem ANTES de \d{2} na alternância de propósito: na ordem inversa a
  // expressão casa "20" de "2026" e a data volta como 2020.
  var m = t.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4}|\d{2})(?!\d)/);
  if (m) {
    var d = parseInt(m[1], 10), mes = parseInt(m[2], 10), a = parseInt(m[3], 10);
    if (a < 100) a += a < 70 ? 2000 : 1900;
    if (d < 1 || d > 31 || mes < 1 || mes > 12 || a < 1900 || a > 2200) return "";
    return a + "-" + String(mes).padStart(2, "0") + "-" + String(d).padStart(2, "0");
  }
  if (/^\d+([.,]\d+)?$/.test(t)) {
    var n = parseFloat(t.replace(",", "."));
    if (n > 20000 && n < 80000) return serialParaISO(n);   // 1954 a 2119
  }
  return "";
}

// "R$ 1.234,56" → 1234.56. Também aceita "1234.56" (formato americano) e
// "(123,45)" como negativo, que é como algumas planilhas exportam.
function parseValorBR(v) {
  var t = String(v == null ? "" : v).trim();
  if (!t) return null;
  var negativo = /^\(.*\)$/.test(t) || /^-/.test(t);
  t = t.replace(/[R$\s()]/gi, "").replace(/^-/, "");
  if (!t) return null;
  var temVirgula = t.indexOf(",") >= 0, temPonto = t.indexOf(".") >= 0;
  if (temVirgula && temPonto) {
    // O último separador que aparece é o decimal; o outro é o de milhar.
    t = t.lastIndexOf(",") > t.lastIndexOf(".")
      ? t.replace(/\./g, "").replace(",", ".")
      : t.replace(/,/g, "");
  } else if (temVirgula) {
    t = t.replace(",", ".");
  } else if (temPonto) {
    // "1.234" é mil e duzentos e trinta e quatro na planilha brasileira, mas
    // "1.23" é um e vinte e três. Três dígitos depois do ponto = milhar.
    var partes = t.split(".");
    if (partes.length > 2 || (partes[1] && partes[1].length === 3)) t = partes.join("");
  }
  var n = parseFloat(t);
  if (!isFinite(n)) return null;
  return negativo ? -n : n;
}

// Campos da conta que a planilha pode preencher. "achar" são os nomes de coluna
// que a gente reconhece sozinho — inclui os que o Bling e o Excel costumam usar.
const CAMPOS_IMPORTACAO = [
  { key:"descricao",  rotulo:"Fornecedor / descrição", obrigatorio:true,
    achar:["fornecedor","credor","descricao","descrição","historico","histórico","favorecido","beneficiario","beneficiário","cliente/fornecedor","nome"] },
  { key:"vencimento", rotulo:"Vencimento", obrigatorio:true,
    achar:["vencimento","data de vencimento","datavencimento","vence em","dt vencimento","data vencto","vencto"] },
  { key:"valor",      rotulo:"Valor", obrigatorio:true,
    achar:["valor","valor total","total","valor da conta","vlr","valor documento","saldo"] },
  { key:"categoria",  rotulo:"Categoria", obrigatorio:false,
    achar:["categoria","classificacao","classificação","plano de contas","tipo","centro de custo"] },
  { key:"emissao",    rotulo:"Emissão", obrigatorio:false,
    achar:["emissao","emissão","data de emissao","data de emissão","data"] },
  { key:"ndoc",       rotulo:"Nº documento", obrigatorio:false,
    achar:["documento","numero documento","número documento","ndoc","nº doc","num doc","nota","nf"] },
  { key:"juros",      rotulo:"Juros mensal (%)", obrigatorio:false, achar:["juros","juros mensal","juros %","juros ao mes"] },
  { key:"multa",      rotulo:"Multa (%)",        obrigatorio:false, achar:["multa","multa %"] },
  { key:"historico",  rotulo:"Observação",       obrigatorio:false, achar:["observacao","observação","obs","complemento","memo"] },
];

function normalizarCabecalho(s) {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

// Adivinha qual coluna da planilha vai em cada campo. É só um chute inicial: a
// tela mostra o resultado e deixa corrigir, porque nome de coluna varia por ERP.
function mapearColunas(cabecalho) {
  var norm = cabecalho.map(normalizarCabecalho);
  var mapa = {}, usadas = {};
  CAMPOS_IMPORTACAO.forEach(function(campo){
    var achou = -1;
    campo.achar.forEach(function(nome){
      if (achou >= 0) return;
      var alvo = normalizarCabecalho(nome);
      var i = norm.findIndex(function(h, idx){ return !usadas[idx] && h === alvo; });
      if (i < 0) i = norm.findIndex(function(h, idx){ return !usadas[idx] && h && h.indexOf(alvo) >= 0; });
      if (i >= 0) { achou = i; }
    });
    if (achou >= 0) { mapa[campo.key] = achou; usadas[achou] = true; }
    else mapa[campo.key] = -1;
  });
  return mapa;
}

// Converte as linhas cruas em contas, dizendo o que deu errado em cada uma.
// Linha com problema NÃO entra: uma conta com valor ou vencimento errado
// estraga a priorização inteira, e o erro só apareceria na hora de pagar.
function prepararLinhas(linhas, mapa, contasExistentes) {
  var chaveExistente = {};
  (contasExistentes || []).forEach(function(c){
    chaveExistente[[String(c.descricao||"").trim().toLowerCase(), c.vencimento||"", (parseFloat(c.valor)||0).toFixed(2)].join("|")] = true;
  });
  var vistas = {};
  return linhas.map(function(l, i){
    function col(k){ var idx = mapa[k]; return idx >= 0 && idx < l.length ? l[idx] : ""; }
    var descricao = String(col("descricao") || "").trim();
    var vencimento = parseDataBR(col("vencimento"));
    var valor = parseValorBR(col("valor"));
    var erros = [];
    if (!descricao) erros.push("sem fornecedor");
    if (!vencimento) erros.push(String(col("vencimento")||"").trim() ? "vencimento não reconhecido" : "sem vencimento");
    if (valor == null) erros.push(String(col("valor")||"").trim() ? "valor não reconhecido" : "sem valor");
    else if (valor <= 0) erros.push("valor zero ou negativo");
    var chave = [descricao.toLowerCase(), vencimento, (valor||0).toFixed(2)].join("|");
    var duplicada = !erros.length && (!!chaveExistente[chave] || !!vistas[chave]);
    var ondeDup = chaveExistente[chave] ? "já cadastrada" : (vistas[chave] ? "repetida na planilha" : "");
    if (!erros.length) vistas[chave] = true;
    return {
      linha: i + 2,             // +2: a planilha conta a partir de 1 e a 1ª é o cabeçalho
      erros: erros, duplicada: duplicada, ondeDup: ondeDup,
      conta: {
        descricao: descricao,
        vencimento: vencimento,
        valor: valor == null ? "" : String(valor),
        categoria: String(col("categoria") || "").trim() || "Outros",
        emissao: parseDataBR(col("emissao")) || "",
        ndoc: String(col("ndoc") || "").trim(),
        juros: String(parseValorBR(col("juros")) == null ? 0 : parseValorBR(col("juros"))),
        multa: String(parseValorBR(col("multa")) == null ? 0 : parseValorBR(col("multa"))),
        historico: String(col("historico") || "").trim(),
        status: "pendente",
      },
    };
  });
}

// Importação de contas a pagar por planilha, em três passos: escolher o
// arquivo, conferir o mapeamento das colunas, revisar e importar.
function ImportarContasModal({ contas, onImportar, onClose }) {
  const [nomeArq, setNomeArq] = useState("");
  const [cabecalho, setCabecalho] = useState(null);
  const [linhas, setLinhas] = useState([]);
  const [mapa, setMapa] = useState({});
  const [erro, setErro] = useState("");
  const [incluirDup, setIncluirDup] = useState(false);
  const [lendo, setLendo] = useState(false);
  const fileRef = useRef(null);

  async function receber(file) {
    setErro(""); setLendo(true); setNomeArq(file.name);
    try {
      var matriz;
      if (/\.xlsx$/i.test(file.name)) matriz = await lerXLSX(await file.arrayBuffer());
      else if (/\.xls$/i.test(file.name)) throw new Error("O formato .xls (Excel antigo) não é lido aqui. Abra no Excel e salve como .xlsx ou CSV.");
      else matriz = lerCSV(await file.text());
      if (matriz.length < 2) throw new Error("A planilha precisa de uma linha de cabeçalho e ao menos uma conta.");
      var cab = matriz[0], corpo = matriz.slice(1);
      setCabecalho(cab); setLinhas(corpo); setMapa(mapearColunas(cab));
    } catch (e) {
      setErro((e && e.message) || "Não consegui ler este arquivo.");
      setCabecalho(null); setLinhas([]);
    } finally { setLendo(false); }
  }

  var prontas = cabecalho ? prepararLinhas(linhas, mapa, contas) : [];
  var validas = prontas.filter(function(p){ return !p.erros.length && (incluirDup || !p.duplicada); });
  var comErro = prontas.filter(function(p){ return p.erros.length; });
  var dups = prontas.filter(function(p){ return !p.erros.length && p.duplicada; });
  var totalValidas = validas.reduce(function(s,p){ return s + (parseFloat(p.conta.valor)||0); }, 0);
  var faltaObrig = CAMPOS_IMPORTACAO.filter(function(c){ return c.obrigatorio && (mapa[c.key] == null || mapa[c.key] < 0); });

  function importar() {
    var agora = Date.now();
    onImportar(validas.map(function(p, i){
      return Object.assign({}, p.conta, { id: "cp_imp_" + agora + "_" + i });
    }));
  }

  var campo = { width:"100%", background:"var(--bg)", border:"1px solid var(--border)", color:"var(--text-strong)", padding:"8px 10px", borderRadius:7, fontSize:12.5, boxSizing:"border-box" };
  var cartao = { background:"var(--surface)", border:"1px solid var(--border)", borderRadius:12, padding:"16px 18px", marginBottom:14 };
  var tit = { fontSize:13.5, fontWeight:600, color:"var(--text-strong)", marginBottom:10 };

  return (
    <div style={{ position:"fixed", inset:0, background:"var(--bg)", zIndex:700, display:"flex", flexDirection:"column" }}>
      <div style={{ borderBottom:"1px solid var(--border)", background:"var(--bg-2)", padding:"14px 22px", display:"flex", alignItems:"center", gap:14, flexWrap:"wrap" }}>
        <button onClick={onClose} title="Voltar" style={{ background:"var(--surface)", border:"1px solid var(--border)", color:"var(--text-2)", width:34, height:34, borderRadius:9, cursor:"pointer", fontSize:16 }}>←</button>
        <div>
          <div style={{ fontWeight:600, fontSize:17, color:"var(--text-strong)" }}>Importar contas a pagar</div>
          <div style={{ fontSize:11.5, color:"var(--text-3)", marginTop:2 }}>{nomeArq || "CSV ou Excel (.xlsx)"}</div>
        </div>
        <div style={{ flex:1 }} />
        <button onClick={onClose} style={{ background:"var(--surface)", border:"1px solid var(--border)", color:"var(--text-2)", fontWeight:600, padding:"9px 18px", borderRadius:9, cursor:"pointer", fontSize:13 }}>Cancelar</button>
        <button onClick={importar} disabled={!validas.length || faltaObrig.length > 0}
          style={{ background: validas.length && !faltaObrig.length ? "var(--ui-accent)" : "var(--surface)",
                   border: validas.length && !faltaObrig.length ? "none" : "1px solid var(--border)",
                   color: validas.length && !faltaObrig.length ? "var(--ui-accent-text)" : "var(--text-4)",
                   fontWeight:600, padding:"9px 24px", borderRadius:9,
                   cursor: validas.length && !faltaObrig.length ? "pointer" : "default", fontSize:13 }}>
          Importar {validas.length ? validas.length + " conta(s)" : ""}
        </button>
      </div>

      <div style={{ flex:1, overflowY:"auto", padding:"18px 22px 40px" }}>
        <div style={{ maxWidth:1100, margin:"0 auto" }}>
          {erro && <div style={{ background:"rgba(255,82,82,.12)", border:"1px solid #FF5252", color:"#FF5252", borderRadius:10, padding:"11px 14px", fontSize:12.5, marginBottom:14 }}>{erro}</div>}

          <div style={cartao}>
            <div style={tit}>1. Escolha o arquivo</div>
            <input ref={fileRef} type="file" accept=".csv,.tsv,.txt,.xlsx,text/csv" style={{ display:"none" }}
              onChange={function(e){ if (e.target.files && e.target.files[0]) receber(e.target.files[0]); e.target.value=""; }} />
            <button onClick={function(){ if (fileRef.current) fileRef.current.click(); }}
              style={{ background:"var(--ui-accent)", border:"none", color:"var(--ui-accent-text)", fontWeight:600, padding:"10px 22px", borderRadius:9, cursor:"pointer", fontSize:13 }}>
              {lendo ? "Lendo..." : (cabecalho ? "Trocar arquivo" : "Selecionar planilha")}
            </button>
            <div style={{ fontSize:11.5, color:"var(--text-3)", marginTop:10, lineHeight:1.6 }}>
              Aceita <b>.csv</b> (vírgula, ponto e vírgula ou tabulação) e <b>.xlsx</b>. A primeira linha
              precisa ser o cabeçalho com o nome das colunas. Valores como <code>R$ 1.234,56</code> e datas
              como <code>31/12/2026</code> são entendidos.
            </div>
          </div>

          {cabecalho && <>
            <div style={cartao}>
              <div style={tit}>2. Confira as colunas</div>
              <div style={{ fontSize:12, color:"var(--text-3)", marginBottom:14, lineHeight:1.5 }}>
                O sistema chutou o encaixe pelo nome das colunas. Corrija o que estiver errado — nome de
                coluna muda de um sistema para outro.
              </div>
              <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(240px,1fr))", gap:12 }}>
                {CAMPOS_IMPORTACAO.map(function(c){
                  var vazio = mapa[c.key] == null || mapa[c.key] < 0;
                  return <div key={c.key}>
                    <label style={{ fontSize:11.5, color: c.obrigatorio && vazio ? "#FF5252" : "var(--text-3)", fontWeight:600, display:"block", marginBottom:4 }}>
                      {c.rotulo}{c.obrigatorio ? " *" : ""}
                    </label>
                    <select value={mapa[c.key] == null ? -1 : mapa[c.key]}
                      onChange={function(e){ var v = parseInt(e.target.value, 10); setMapa(Object.assign({}, mapa, { [c.key]: v })); }}
                      style={{ ...campo, borderColor: c.obrigatorio && vazio ? "#FF5252" : "var(--border)" }}>
                      <option value={-1}>— não importar —</option>
                      {cabecalho.map(function(h, i){ return <option key={i} value={i}>{h || ("coluna " + (i+1))}</option>; })}
                    </select>
                  </div>;
                })}
              </div>
              {faltaObrig.length > 0 && (
                <div style={{ marginTop:12, fontSize:12.5, color:"#FF5252" }}>
                  Falta escolher a coluna de: {faltaObrig.map(function(c){ return c.rotulo; }).join(", ")}.
                </div>
              )}
              <div style={{ fontSize:11.5, color:"var(--text-3)", marginTop:10, lineHeight:1.6 }}>
                <b>Juros e multa</b> são o que permite calcular quanto custa adiar cada conta na tela de
                Prioridade de pagamento. Sem eles a conta entra do mesmo jeito, só sem esse cálculo.
              </div>
            </div>

            <div style={cartao}>
              <div style={tit}>3. Confira o resultado</div>
              <div style={{ display:"flex", gap:22, flexWrap:"wrap", marginBottom:14 }}>
                <div><div style={{ fontSize:11, color:"var(--text-3)" }}>Entram</div>
                  <div style={{ fontSize:20, fontWeight:600, color:"#0a9d4e" }}>{validas.length}</div></div>
                <div><div style={{ fontSize:11, color:"var(--text-3)" }}>Somando</div>
                  <div style={{ fontSize:20, fontWeight:600, color:"var(--text-strong)" }}>{fmt(totalValidas)}</div></div>
                <div><div style={{ fontSize:11, color:"var(--text-3)" }}>Com erro (ficam de fora)</div>
                  <div style={{ fontSize:20, fontWeight:600, color: comErro.length ? "#FF5252" : "var(--text-3)" }}>{comErro.length}</div></div>
                <div><div style={{ fontSize:11, color:"var(--text-3)" }}>Possíveis duplicadas</div>
                  <div style={{ fontSize:20, fontWeight:600, color: dups.length ? "#FFC107" : "var(--text-3)" }}>{dups.length}</div></div>
              </div>
              {dups.length > 0 && (
                <label style={{ display:"flex", alignItems:"center", gap:8, fontSize:12.5, color:"var(--text-2)", cursor:"pointer", marginBottom:12 }}>
                  <input type="checkbox" checked={incluirDup} onChange={function(e){ setIncluirDup(e.target.checked); }} />
                  Importar também as {dups.length} conta(s) com mesmo fornecedor, vencimento e valor de outra
                </label>
              )}
              <div className="tabela-wrap" style={{ maxHeight:420, overflowY:"auto" }}>
                <table className="tabela">
                  <thead><tr>{["Linha","Situação","Fornecedor","Categoria","Vencimento","Valor","Juros","Multa"].map(function(h){ return <th key={h} className="th">{h}</th>; })}</tr></thead>
                  <tbody>
                    {prontas.slice(0, 300).map(function(p, i){
                      var fora = p.erros.length || (p.duplicada && !incluirDup);
                      return <tr key={i} style={{ opacity: fora ? .55 : 1 }}>
                        <td className="td" style={{ color:"var(--text-4)", width:52 }}>{p.linha}</td>
                        <td className="td">
                          {p.erros.length
                            ? <span style={{ color:"#FF5252", fontSize:11.5 }}>{p.erros.join(", ")}</span>
                            : p.duplicada
                              ? <span style={{ color:"#FFC107", fontSize:11.5 }}>{p.ondeDup}</span>
                              : <span style={{ color:"#0a9d4e", fontSize:11.5 }}>ok</span>}
                        </td>
                        <td className="td" style={{ color:"var(--text-strong)", maxWidth:240 }}>{p.conta.descricao || "—"}</td>
                        <td className="td">{p.conta.categoria}</td>
                        <td className="td">{p.conta.vencimento ? (fmtDate(p.conta.vencimento) || p.conta.vencimento) : "—"}</td>
                        <td className="td-num">{p.conta.valor ? fmt(parseFloat(p.conta.valor)) : "—"}</td>
                        <td className="td">{parseFloat(p.conta.juros) ? p.conta.juros + "%" : "—"}</td>
                        <td className="td">{parseFloat(p.conta.multa) ? p.conta.multa + "%" : "—"}</td>
                      </tr>;
                    })}
                  </tbody>
                </table>
              </div>
              {prontas.length > 300 && <div style={{ fontSize:11.5, color:"var(--text-3)", marginTop:8 }}>Mostrando as 300 primeiras de {prontas.length} linhas — a importação leva todas as válidas.</div>}
            </div>
          </>}
        </div>
      </div>
    </div>
  );
}

// ── Prioridade de pagamento ────────────────────────────────────────────────
// Divisão proposital de trabalho: TODA conta em dinheiro é feita aqui, no
// código. A IA só classifica e explica. Um plano de pagamento com aritmética
// inventada por um modelo seria pior que nenhum plano — daria a confiança sem
// a exatidão.
const RISCO_CATEGORIA_PADRAO = {
  "Impostos":    { peso: 10, nota: "Atraso gera multa, juros Selic e risco de negativação." },
  "Funcionário": { peso: 10, nota: "Obrigação trabalhista — atraso tem consequência legal." },
  "Aluguel":     { peso: 8,  nota: "Contrato com cláusula de despejo." },
  "Fornecedor":  { peso: 7,  nota: "Pode cortar o fornecimento e travar as vendas." },
  "Frete":       { peso: 6,  nota: "Atraso trava a expedição dos pedidos." },
  "Marketing":   { peso: 3,  nota: "Pode ser pausado sem parar a operação." },
  "Outros":      { peso: 5,  nota: "" },
};

function configPrioridadePadrao() {
  var riscos = {};
  Object.keys(RISCO_CATEGORIA_PADRAO).forEach(function(k){ riscos[k] = RISCO_CATEGORIA_PADRAO[k].peso; });
  return { instrucoes: "", riscos: riscos, caixa: "", aReceber7d: "" };
}

function diasEntre(deIso, ateIso) {
  var a = new Date(deIso + "T00:00:00"), b = new Date(ateIso + "T00:00:00");
  return Math.round((b - a) / 86400000);
}

// Custo de adiar uma conta por N dias, em reais. A multa só entra se a conta
// ainda NÃO está vencida — quem já atrasou, já pagou a multa; adiar mais um dia
// custa só juros. Juros vem como "% ao mês" na tela de contas, então vira dia
// dividindo por 30.
function custoDeAtrasar(c, diasParaVencer, dias) {
  var valor = parseFloat(c.valor) || 0;
  var multaPct = parseFloat(c.multa) || 0;
  var jurosMesPct = parseFloat(c.juros) || 0;
  var multa = (diasParaVencer >= 0 && diasParaVencer < dias) ? valor * (multaPct / 100) : 0;
  var juros = valor * (jurosMesPct / 100) * (dias / 30);
  return multa + juros;
}

// Ordena as contas em aberto por urgência. A nota é explicável de propósito:
// cada parcela aparece na tela, para o usuário poder discordar com fundamento.
function ranquearContas(contas, riscos, hojeIso) {
  var abertas = (contas || []).filter(function(c){
    return c.status !== "cancelada" && saldoDe(c) > 0;   // parcialmente pagas continuam na fila, pelo que falta
  });
  var itens = abertas.map(function(c){
    var venc = c.vencimento || "";
    var dias = venc ? diasEntre(hojeIso, venc) : 999; // sem vencimento = sem pressa conhecida
    var cat = c.categoria || "Outros";
    var pesoRisco = riscos && riscos[cat] != null ? riscos[cat] : (RISCO_CATEGORIA_PADRAO[cat] ? RISCO_CATEGORIA_PADRAO[cat].peso : 5);
    // Prazo: vencida pontua alto e cresce com o atraso; a vencer decai até 30 dias.
    var pontosPrazo = dias < 0 ? Math.min(50, 30 + Math.abs(dias)) : Math.max(0, 30 - dias);
    var pontosRisco = pesoRisco * 3;                       // 0 a 30
    var valor = saldoDe(c);   // o que ainda falta pagar, não o valor de face
    var custo7 = custoDeAtrasar(Object.assign({}, c, { valor: valor }), dias, 7);
    // O que o atraso custa em relação ao próprio valor da conta. Uma conta
    // pequena com juros alto sobe; uma grande sem juros nenhum não sobe só por
    // ser grande — pagar antes o que não cobra nada por esperar é desperdício.
    var pontosCusto = valor > 0 ? Math.min(20, (custo7 / valor) * 400) : 0;
    return {
      conta: c,
      id: c.id,
      descricao: c.descricao || "(sem fornecedor)",
      categoria: cat,
      vencimento: venc,
      dias: venc ? dias : null,
      vencida: !!venc && dias < 0,
      valor: valor,
      custo7: custo7,
      pesoRisco: pesoRisco,
      notaRisco: RISCO_CATEGORIA_PADRAO[cat] ? RISCO_CATEGORIA_PADRAO[cat].nota : "",
      pontosPrazo: pontosPrazo,
      pontosRisco: pontosRisco,
      pontosCusto: pontosCusto,
      urgencia: Math.round(pontosPrazo + pontosRisco + pontosCusto),
    };
  });
  itens.sort(function(a,b){
    if (b.urgencia !== a.urgencia) return b.urgencia - a.urgencia;
    if (a.vencimento && b.vencimento && a.vencimento !== b.vencimento) return a.vencimento.localeCompare(b.vencimento);
    return b.valor - a.valor;
  });
  return itens;
}

// Distribui o caixa pela ordem de urgência, seguindo em frente quando uma conta
// não cabe: parar na primeira que não cabe deixaria dinheiro parado enquanto
// contas menores vencem. O efeito colateral é que uma conta menos urgente pode
// ser paga na frente de uma mais urgente que não coube — por isso a tela marca
// quais entraram e mostra o que ficou de fora, em vez de só devolver uma lista.
function planoDeCaixa(ranking, caixa) {
  var restante = caixa, cabem = [], naoCabem = [];
  ranking.forEach(function(it){
    if (it.valor <= restante) { restante -= it.valor; cabem.push(it); }
    else naoCabem.push(it);
  });
  var falta = naoCabem.reduce(function(s,i){ return s + i.valor; }, 0);
  var custoSemanaAdiado = naoCabem.reduce(function(s,i){ return s + i.custo7; }, 0);
  return { cabem: cabem, naoCabem: naoCabem, sobra: restante, falta: falta, custoSemanaAdiado: custoSemanaAdiado };
}

// Manda o RANKING (já calculado) para a IA e recebe de volta só decisão e
// texto. Nenhum valor em reais volta do modelo: os números da tela continuam
// sendo os do código.
async function analisarPrioridadeIA(ranking, plano, cfg, caixa, aReceber) {
  var linhas = ranking.slice(0, 40).map(function(i){
    return "- id=" + i.id + " | " + i.descricao + " | " + i.categoria +
      " | vence " + (i.vencimento || "sem data") +
      " (" + (i.dias == null ? "sem data" : (i.dias < 0 ? Math.abs(i.dias) + " dias VENCIDA" : "em " + i.dias + " dias")) + ")" +
      " | R$ " + i.valor.toFixed(2) +
      " | custo de adiar 7 dias: R$ " + i.custo7.toFixed(2) +
      " | urgência calculada: " + i.urgencia;
  }).join("\n");

  var regras = String(cfg.instrucoes || "").trim()
    ? "\n\nREGRAS DA EMPRESA — valem acima de qualquer recomendação genérica:\n" + String(cfg.instrucoes).trim()
    : "";

  var prompt = "Você é um analista financeiro de uma empresa que vende no Mercado Livre. " +
    "Decida a ordem de pagamento das contas abaixo.\n\n" +
    "Caixa disponível hoje: R$ " + caixa.toFixed(2) + "\n" +
    "Previsão de entrada nos próximos 7 dias (informada pelo usuário): R$ " + aReceber.toFixed(2) + "\n" +
    "Total em aberto: R$ " + ranking.reduce(function(s,i){ return s+i.valor; },0).toFixed(2) + "\n" +
    "Pela ordem de urgência calculada, o caixa cobre " + plano.cabem.length + " de " + ranking.length +
    " contas; ficam de fora R$ " + plano.falta.toFixed(2) + ".\n\n" +
    "Contas em aberto:\n" + linhas + regras + "\n\n" +
    "Retorne APENAS um objeto JSON válido, sem markdown:\n" +
    "{\n" +
    ' "resumo":"2 a 3 frases sobre a situação de caixa e a estratégia da semana",\n' +
    ' "decisoes":[{"id":"o id exato da conta","acao":"pagar|negociar|adiar","motivo":"1 frase objetiva","comoNegociar":"o que pedir ao credor, ou string vazia"}],\n' +
    ' "alertas":["riscos concretos de seguir este plano"],\n' +
    ' "seFaltarCaixa":"o que fazer para cobrir o buraco, em 1 ou 2 frases"\n' +
    "}\n\n" +
    "Regras da resposta:\n" +
    "- Inclua TODAS as contas listadas em decisoes, uma vez cada, usando o id EXATO.\n" +
    "- Não invente contas, valores nem ids.\n" +
    "- NÃO escreva valores em reais nos textos: os números são calculados pelo sistema.\n" +
    "- 'negociar' é para o que vale tentar prazo ou parcelamento; 'adiar' é o que aguenta esperar.\n" +
    "- Justifique pelo risco e pelo custo do atraso, não pelo tamanho da conta.\n\n" +
    "Retorne SOMENTE o JSON.";

  var r = await fetch("/api/ai-chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ max_tokens: 3000, messages: [{ role: "user", content: prompt }] }),
  });
  var data = await r.json();
  if (data.error) throw new Error(data.error.message || data.error);
  var txt = (data.content || []).map(function(b){ return b.text || ""; }).join("");
  var limpo = txt.replace(/```json|```/g, "").trim();
  var i0 = limpo.indexOf("{"), i1 = limpo.lastIndexOf("}");
  if (i0 < 0 || i1 < 0) throw new Error("A IA não devolveu um JSON válido.");
  var bruto = JSON.parse(limpo.slice(i0, i1 + 1));

  // Conferência antes de mostrar. O modelo pode citar um id que não existe ou
  // esquecer uma conta; nos dois casos a tela precisa dizer, não encobrir.
  var validos = {};
  ranking.forEach(function(i){ validos[i.id] = true; });
  var porId = {}, inventados = [];
  (Array.isArray(bruto.decisoes) ? bruto.decisoes : []).forEach(function(d){
    if (!d || !d.id) return;
    if (!validos[d.id]) { inventados.push(String(d.id)); return; }
    if (porId[d.id]) return; // primeira decisão vale; repetição é ruído
    porId[d.id] = {
      acao: ["pagar","negociar","adiar"].indexOf(d.acao) >= 0 ? d.acao : "adiar",
      motivo: String(d.motivo || ""),
      comoNegociar: String(d.comoNegociar || ""),
    };
  });
  var semDecisao = ranking.filter(function(i){ return !porId[i.id]; }).map(function(i){ return i.id; });
  return {
    resumo: String(bruto.resumo || ""),
    alertas: Array.isArray(bruto.alertas) ? bruto.alertas.map(String) : [],
    seFaltarCaixa: String(bruto.seFaltarCaixa || ""),
    porId: porId,
    inventados: inventados,
    semDecisao: semDecisao,
  };
}

// Tela: ordena as contas em aberto e monta um plano de pagamento para o caixa
// que o usuário informar. A IA é opcional — o ranking e o plano funcionam sem ela.
function PrioridadePagamentoTab({ contas, salvarContas, config, salvarConfig, saldoEmCaixa, temContasBancarias, tab, setTab }) {
  const [analise, setAnalise] = useState(null);
  const [estado, setEstado] = useState("idle"); // idle | loading | done | error
  const [erro, setErro] = useState("");
  const [mostrarRegras, setMostrarRegras] = useState(false);
  const [rascunho, setRascunho] = useState(function(){ return JSON.parse(JSON.stringify(config)); });
  var hoje = new Date().toISOString().slice(0, 10);

  // Com contas cadastradas, o saldo vem de Caixas e bancos. O campo continua
  // aceitando um valor à mão para quem quer simular — mas o padrão deixa de ser
  // digitar todo dia um número que o sistema já sabe.
  var usaSaldoReal = temContasBancarias && config.usarSaldoReal !== false;
  var caixa = usaSaldoReal ? (saldoEmCaixa || 0) : (parseFloat(config.caixa) || 0);
  var aReceber = parseFloat(config.aReceber7d) || 0;
  var ranking = ranquearContas(contas, config.riscos, hoje);
  var plano = planoDeCaixa(ranking, caixa);
  var totalAberto = ranking.reduce(function(s,i){ return s + i.valor; }, 0);
  var vencidas = ranking.filter(function(i){ return i.vencida; });
  var vence7 = ranking.filter(function(i){ return !i.vencida && i.dias != null && i.dias <= 7; });
  var custoSemana = ranking.reduce(function(s,i){ return s + i.custo7; }, 0);

  function setCampo(k, v){ salvarConfig(Object.assign({}, config, { [k]: v })); }

  async function analisar(){
    setEstado("loading"); setErro("");
    try { setAnalise(await analisarPrioridadeIA(ranking, plano, config, caixa, aReceber)); setEstado("done"); }
    catch (e) { setErro((e && e.message) || "Falha ao analisar."); setEstado("error"); }
  }
  function marcarPaga(it){
    salvarContas((contas || []).map(function(x){
      if (x.id !== it.id) return x;
      return Object.assign({}, x, { status:"paga", pago_em: hoje,
        pagamentos: pagamentosDe(x).concat([{ id:"pg_"+Date.now(), data:hoje, valor: saldoDe(x), conta: x.conta || "" }]) });
    }));
  }

  var cartao = { background:"var(--surface)", border:"1px solid var(--border)", borderRadius:12, padding:"18px 20px", marginBottom:14 };
  var tit = { fontSize:14, fontWeight:600, color:"var(--text-strong)", marginBottom:4 };
  var sub = { fontSize:12, color:"var(--text-3)", lineHeight:1.5, marginBottom:14 };
  var campoNum = { width:"100%", background:"var(--bg)", border:"1px solid var(--border)", color:"var(--text-strong)", padding:"10px 12px", borderRadius:8, fontSize:15, outline:"none", boxSizing:"border-box", fontWeight:600 };
  var corAcao = { pagar:"#0a9d4e", negociar:"#FFC107", adiar:"var(--text-3)" };
  var rotuloAcao = { pagar:"Pagar", negociar:"Negociar", adiar:"Adiar" };

  if (!ranking.length) {
    return <FinanceiroShell tab={tab} setTab={setTab} titulo="Prioridade de pagamento"
      sub="Que contas pagar primeiro com o caixa que você tem.">
      <VazioFin icone="🎯" titulo="Nenhuma conta em aberto para priorizar."
        texto={<>Esta tela lê as contas de <b>Contas a pagar</b> que não estão pagas nem canceladas. Cadastre-as lá — com <b>vencimento</b>, <b>categoria</b> e, quando houver, <b>juros e multa</b>, que são o que permite calcular quanto custa adiar cada uma.</>}
        acao="Ir para Contas a pagar →" onAcao={function(){ setTab("contas_pagar"); }} />
    </FinanceiroShell>;
  }

  return (
    <FinanceiroShell tab={tab} setTab={setTab} titulo="Prioridade de pagamento"
      sub="Ordenadas por prazo, risco e quanto custa adiar cada uma."
      kpis={[
        { rotulo:"Total em aberto", valor:fmt(totalAberto), cor:FIN_COR.neutro, nota:ranking.length + " conta(s)" },
        { rotulo:"Vencidas", valor:fmt(vencidas.reduce(function(s,i){ return s+i.valor; },0)), cor: vencidas.length ? FIN_COR.saida : FIN_COR.fraco, nota:vencidas.length + " conta(s)" },
        { rotulo:"Vencem em 7 dias", valor:fmt(vence7.reduce(function(s,i){ return s+i.valor; },0)), cor: vence7.length ? FIN_COR.atencao : FIN_COR.fraco, nota:vence7.length + " conta(s)" },
        { rotulo:"Custo de adiar tudo 7 dias", valor:fmt(custoSemana), cor: custoSemana > 0 ? FIN_COR.saida : FIN_COR.fraco, nota:"juros + multa" },
      ]}
      acoes={<>
        <AcaoFin tipo="pri" onClick={analisar}>{estado === "loading" ? "Analisando..." : "Analisar com IA"}</AcaoFin>
        <AcaoFin onClick={function(){ setRascunho(JSON.parse(JSON.stringify(config))); setMostrarRegras(function(v){ return !v; }); }}>
          {mostrarRegras ? "Fechar regras" : "⚙ Regras e pesos"}
        </AcaoFin>
      </>}>
      {mostrarRegras && (
        <div style={cartao}>
          <div style={tit}>Regras e pesos</div>
          <div style={sub}>
            O peso de cada categoria diz o quanto atrasar aquele tipo de conta machuca — não o
            quanto ela custa. Vale de 0 a 10.
          </div>
          <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(220px,1fr))", gap:12, marginBottom:16 }}>
            {Object.keys(RISCO_CATEGORIA_PADRAO).map(function(cat){
              return <div key={cat}>
                <label style={{ fontSize:11.5, color:"var(--text-3)", fontWeight:600, display:"block", marginBottom:4 }}>{cat}</label>
                <input type="number" min="0" max="10" value={rascunho.riscos[cat] == null ? "" : rascunho.riscos[cat]}
                  onChange={function(e){
                    var v = Math.max(0, Math.min(10, parseInt(e.target.value, 10) || 0));
                    setRascunho(function(r){ return Object.assign({}, r, { riscos: Object.assign({}, r.riscos, { [cat]: v }) }); });
                  }}
                  style={{ width:"100%", background:"var(--bg)", border:"1px solid var(--border)", color:"var(--text-strong)", padding:"8px 10px", borderRadius:7, fontSize:13, boxSizing:"border-box" }} />
                {RISCO_CATEGORIA_PADRAO[cat].nota && <div style={{ fontSize:10.5, color:"var(--text-4)", marginTop:3, lineHeight:1.4 }}>{RISCO_CATEGORIA_PADRAO[cat].nota}</div>}
              </div>;
            })}
          </div>
          <div style={tit}>Regras para a IA</div>
          <div style={sub}>
            O que a IA precisa saber e os números não dizem: quem corta o fornecimento, com quem dá
            para negociar, o que nunca pode atrasar. Vai em toda análise.
          </div>
          <textarea value={rascunho.instrucoes}
            onChange={function(e){ setRascunho(Object.assign({}, rascunho, { instrucoes: e.target.value })); }}
            rows={7}
            placeholder={"Exemplos:\n- O fornecedor Auto Peças SP corta o fornecimento com 1 dia de atraso; nunca adiar.\n" +
                         "- Imposto e folha nunca entram em 'adiar'.\n" +
                         "- A transportadora aceita parcelar em 2x sem juros; pode negociar.\n" +
                         "- Marketing pode esperar até o dia 20 sem prejuízo."}
            style={{ width:"100%", background:"var(--bg)", border:"1px solid var(--border)", color:"var(--text-strong)",
                     padding:"12px 14px", borderRadius:10, fontSize:13, outline:"none", resize:"vertical",
                     fontFamily:"inherit", lineHeight:1.6, boxSizing:"border-box", marginBottom:12 }} />
          <div style={{ display:"flex", gap:8 }}>
            <button onClick={function(){ salvarConfig(Object.assign({}, config, { riscos: rascunho.riscos, instrucoes: rascunho.instrucoes })); setMostrarRegras(false); }}
              style={{ background:"var(--ui-accent)", border:"none", color:"var(--ui-accent-text)", fontWeight:600, padding:"9px 24px", borderRadius:9, cursor:"pointer", fontSize:13 }}>Salvar regras</button>
            <button onClick={function(){ var p = configPrioridadePadrao(); setRascunho(Object.assign({}, p, { caixa: config.caixa, aReceber7d: config.aReceber7d })); }}
              style={{ background:"var(--surface)", border:"1px solid var(--border)", color:"var(--text-2)", padding:"9px 16px", borderRadius:9, cursor:"pointer", fontSize:13 }}>Restaurar padrão</button>
          </div>
        </div>
      )}

      <div style={cartao}>
        <div style={tit}>Quanto você tem para pagar</div>
        <div style={sub}>
          {usaSaldoReal
            ? <>O saldo vem de <b>Caixas e bancos</b>: saldo inicial de cada conta mais as contas pagas e os
               recebimentos confirmados. A previsão de entrada continua sendo estimativa sua.</>
            : <>O sistema <b>não</b> sabe o seu saldo enquanto não houver conta em Caixas e bancos. Informe
               os valores e o plano abaixo se ajusta na hora. Sem isso, a ordem continua valendo, mas o
               corte de "o que cabe" não.</>}
        </div>
        <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(230px,1fr))", gap:14 }}>
          <div>
            <label style={{ fontSize:11.5, color:"var(--text-3)", fontWeight:600, display:"block", marginBottom:4 }}>Caixa disponível hoje (R$)</label>
            {usaSaldoReal
              ? <>
                  <div style={{ ...campoNum, display:"flex", alignItems:"center", justifyContent:"space-between", gap:10 }}>
                    <span style={{ color: caixa >= 0 ? "#0a9d4e" : "#FF5252" }}>{fmt(caixa)}</span>
                    <span style={{ fontSize:10.5, fontWeight:500, color:"var(--text-4)" }}>de Caixas e bancos</span>
                  </div>
                  <button onClick={function(){ setCampo("usarSaldoReal", false); }}
                    style={{ background:"none", border:"none", color:"var(--ui-accent)", cursor:"pointer", fontSize:11.5, fontWeight:600, padding:"4px 0 0" }}>
                    Informar outro valor
                  </button>
                </>
              : <>
                  <input type="number" step="0.01" value={config.caixa} onChange={function(e){ setCampo("caixa", e.target.value); }} placeholder="0,00" style={campoNum} />
                  {temContasBancarias && <button onClick={function(){ setCampo("usarSaldoReal", true); }}
                    style={{ background:"none", border:"none", color:"var(--ui-accent)", cursor:"pointer", fontSize:11.5, fontWeight:600, padding:"4px 0 0" }}>
                    Voltar a usar o saldo de Caixas e bancos ({fmt(saldoEmCaixa || 0)})
                  </button>}
                </>}
          </div>
          <div>
            <label style={{ fontSize:11.5, color:"var(--text-3)", fontWeight:600, display:"block", marginBottom:4 }}>Previsão de entrada em 7 dias (R$)</label>
            <input type="number" step="0.01" value={config.aReceber7d} onChange={function(e){ setCampo("aReceber7d", e.target.value); }} placeholder="0,00" style={campoNum} />
            <div style={{ fontSize:10.5, color:"var(--text-4)", marginTop:3 }}>Estimativa sua — o sistema não projeta repasses do Mercado Livre.</div>
          </div>
        </div>
        {caixa > 0 && (
          <div style={{ marginTop:16, paddingTop:14, borderTop:"1px solid var(--border-soft)" }}>
            <div style={{ display:"flex", gap:24, flexWrap:"wrap" }}>
              <div><div style={{ fontSize:11, color:"var(--text-3)" }}>O caixa cobre</div>
                <div style={{ fontSize:19, fontWeight:600, color:"#0a9d4e" }}>{plano.cabem.length} de {ranking.length} contas</div></div>
              <div><div style={{ fontSize:11, color:"var(--text-3)" }}>Sobra depois de pagar</div>
                <div style={{ fontSize:19, fontWeight:600, color:"var(--text-2)" }}>{fmt(plano.sobra)}</div></div>
              <div><div style={{ fontSize:11, color:"var(--text-3)" }}>Fica de fora</div>
                <div style={{ fontSize:19, fontWeight:600, color: plano.falta > 0 ? "#FF5252" : "var(--text-3)" }}>{fmt(plano.falta)}</div></div>
              <div><div style={{ fontSize:11, color:"var(--text-3)" }}>Custa adiar o que ficou</div>
                <div style={{ fontSize:19, fontWeight:600, color: plano.custoSemanaAdiado > 0 ? "#FFC107" : "var(--text-3)" }}>{fmt(plano.custoSemanaAdiado)}<span style={{ fontSize:12, fontWeight:400 }}> /semana</span></div></div>
            </div>
            {plano.falta > 0 && aReceber > 0 && (
              <div style={{ fontSize:12, color:"var(--text-3)", marginTop:10 }}>
                Com a entrada prevista de {fmt(aReceber)}, {aReceber >= plano.falta
                  ? "o buraco fecha dentro dos 7 dias."
                  : "ainda faltariam " + fmt(plano.falta - aReceber) + " para cobrir tudo."}
              </div>
            )}
          </div>
        )}
      </div>

      {estado === "error" && (
        <div style={{ background:"rgba(255,82,82,.12)", border:"1px solid #FF5252", color:"#FF5252", borderRadius:10, padding:"11px 14px", fontSize:12.5, marginBottom:14 }}>{erro}</div>
      )}

      {analise && (
        <div style={cartao}>
          <div style={tit}>Leitura da IA</div>
          {analise.resumo && <div style={{ fontSize:13.5, color:"var(--text-2)", lineHeight:1.6, marginBottom:12 }}>{analise.resumo}</div>}
          {analise.alertas.length > 0 && (
            <div style={{ background:"rgba(255,193,7,.10)", border:"1px solid rgba(255,193,7,.45)", borderRadius:10, padding:"11px 14px", marginBottom:10 }}>
              {analise.alertas.map(function(a,i){ return <div key={i} style={{ fontSize:12.5, color:"var(--text-2)", lineHeight:1.6 }}>⚠ {a}</div>; })}
            </div>
          )}
          {analise.seFaltarCaixa && plano.falta > 0 && (
            <div style={{ fontSize:12.5, color:"var(--text-2)", lineHeight:1.6 }}><b>Se faltar caixa:</b> {analise.seFaltarCaixa}</div>
          )}
          {(analise.inventados.length > 0 || analise.semDecisao.length > 0) && (
            <div style={{ marginTop:12, fontSize:11.5, color:"var(--text-3)", lineHeight:1.6, borderTop:"1px solid var(--border-soft)", paddingTop:10 }}>
              {analise.inventados.length > 0 && <div>A IA citou {analise.inventados.length} conta(s) que não existem na sua lista; foram descartadas.</div>}
              {analise.semDecisao.length > 0 && <div>{analise.semDecisao.length} conta(s) ficaram sem opinião da IA e aparecem abaixo só com a ordem calculada.</div>}
            </div>
          )}
        </div>
      )}

      <div className="tabela-wrap">
        <table className="tabela">
          <thead><tr>{["#","Urgência","Fornecedor","Categoria","Vencimento","Valor","Custo/semana","IA","Motivo",""].map(function(h){ return <th key={h} className="th">{h}</th>; })}</tr></thead>
          <tbody>
            {ranking.map(function(it, i){
              var d = analise ? analise.porId[it.id] : null;
              var cabe = caixa > 0 && plano.cabem.indexOf(it) >= 0;
              return <tr key={it.id || i} style={{ background: cabe ? "rgba(10,157,78,.05)" : "transparent" }}>
                <td className="td" style={{ color:"var(--text-4)", width:34 }}>{i+1}</td>
                <td className="td">
                  <span title={"prazo " + it.pontosPrazo + " + risco " + it.pontosRisco + " + custo do atraso " + Math.round(it.pontosCusto)}
                    style={{ fontSize:12, fontWeight:700, color: it.urgencia >= 60 ? "#FF5252" : it.urgencia >= 40 ? "#FFC107" : "var(--text-3)" }}>{it.urgencia}</span>
                </td>
                <td className="td" style={{ color:"var(--text-strong)", maxWidth:230 }}>{it.descricao}</td>
                <td className="td">{it.categoria}</td>
                <td className="td">
                  {it.vencimento ? (fmtDate(it.vencimento) || it.vencimento) : <span style={{ color:"var(--text-4)" }}>sem data</span>}
                  {it.dias != null && <div style={{ fontSize:10.5, color: it.vencida ? "#FF5252" : "var(--text-4)" }}>
                    {it.vencida ? Math.abs(it.dias) + " dias vencida" : (it.dias === 0 ? "vence hoje" : "em " + it.dias + " dias")}
                  </div>}
                </td>
                <td className="td-num" style={{ fontWeight:600 }}>{fmt(it.valor)}</td>
                <td className="td-num">{it.custo7 > 0 ? <span style={{ color:"#FFC107" }}>{fmt(it.custo7)}</span> : <span style={{ color:"var(--text-4)" }}>—</span>}</td>
                <td className="td">
                  {d ? <span style={{ fontSize:11, fontWeight:700, padding:"2px 9px", borderRadius:20, background:"var(--surface-3)", color:corAcao[d.acao] }}>{rotuloAcao[d.acao]}</span>
                     : <span style={{ color:"var(--text-4)", fontSize:11 }}>—</span>}
                </td>
                <td className="td" style={{ fontSize:12, maxWidth:300, color:"var(--text-3)" }}>
                  {d ? d.motivo : ""}
                  {d && d.comoNegociar && <div style={{ marginTop:3, color:"#FFC107" }}>{d.comoNegociar}</div>}
                </td>
                <td className="td" style={{ textAlign:"right" }}>
                  <button onClick={function(){ marcarPaga(it); }}
                    style={{ background:"rgba(10,157,78,.12)", border:"none", color:"var(--ui-accent)", fontSize:11, fontWeight:600, padding:"4px 10px", borderRadius:6, cursor:"pointer", whiteSpace:"nowrap" }}>Pagar</button>
                </td>
              </tr>;
            })}
          </tbody>
        </table>
      </div>

      <div style={{ fontSize:11.5, color:"var(--text-3)", marginTop:10, lineHeight:1.6 }}>
        A urgência é calculada aqui, sem IA: <b>prazo</b> (0 a 50, cresce com o atraso) +
        <b> risco da categoria</b> (0 a 30, os pesos acima) + <b>custo do atraso</b> (0 a 20, juros e
        multa da própria conta em relação ao valor dela). Passe o mouse no número para ver as três parcelas.
        O <b>custo por semana</b> usa a multa da conta — só quando ela ainda não venceu — mais os juros
        mensais proporcionais a 7 dias. Todos os valores em reais são calculados pelo sistema; a IA só
        classifica e escreve os motivos.
      </div>
    </FinanceiroShell>
  );
}

function ContasPagarTab({ contas, salvar, contasBancarias, tab, setTab, categorias, salvarCategorias, fornecedores, salvarFornecedores }) {
  const [modal, setModal] = useState(null);
  const [importando, setImportando] = useState(false);
  const [resultadoImp, setResultadoImp] = useState(null);
  const [sel, setSel] = useState({});          // ids marcados
  const [baixando, setBaixando] = useState(null);
  const [busca, setBusca] = useState("");
  const [sit, setSit] = useState("todas");
  // Fica guardado: quem fecha os filtros para ganhar largura não quer reabri-los
  // a cada troca de aba.
  const [mostrarFiltros, setMostrarFiltros] = useState(function(){
    try { return localStorage.getItem("fin_filtros_ocultos") !== "1"; } catch { return true; }
  });
  function alternarFiltros(){
    setMostrarFiltros(function(v){
      var novo = !v;
      try { localStorage.setItem("fin_filtros_ocultos", novo ? "0" : "1"); } catch(e) {}
      return novo;
    });
  }
  const [mostrarAcoes, setMostrarAcoes] = useState(true);
  const [fCategoria, setFCategoria] = useState("");
  const [de, setDe] = useState("");
  const [ate, setAte] = useState("");
  var hoje = new Date().toISOString().slice(0, 10);
  // Atalhos: um clique cobre o que se pergunta todo dia, sem digitar duas datas.
  function periodoRapido(qual){
    var d = new Date(), a = new Date();
    if (qual === "mes")      { d = new Date(a.getFullYear(), a.getMonth(), 1); a = new Date(a.getFullYear(), a.getMonth()+1, 0); }
    else if (qual === "prox"){ d = new Date(a.getFullYear(), a.getMonth()+1, 1); a = new Date(a.getFullYear(), a.getMonth()+2, 0); }
    else if (qual === "30")  { a.setDate(a.getDate()+30); }
    else if (qual === "vencidas") { setDe(""); setAte(new Date(Date.now()-86400000).toISOString().slice(0,10)); return; }
    else { setDe(""); setAte(""); return; }
    setDe(d.toISOString().slice(0,10)); setAte(a.toISOString().slice(0,10));
  }
  function statusReal(c){ return situacaoConta(c, hoje); }
  var lista = (contas || []).filter(function(c){
    if (sit !== "todas" && statusReal(c) !== sit) return false;
    if (fCategoria && String(c.categoria||"").toLowerCase().indexOf(fCategoria.toLowerCase()) < 0) return false;
    if (de && (c.vencimento || "") < de) return false;
    if (ate && (c.vencimento || "") > ate) return false;
    if (busca.trim()){ var q = busca.trim().toLowerCase(); if (!((c.descricao||"").toLowerCase().indexOf(q)>=0 || (c.categoria||"").toLowerCase().indexOf(q)>=0)) return false; }
    return true;
  }).slice().sort(function(a,b){ return (a.vencimento || "").localeCompare(b.vencimento || ""); });
  // Em aberto é SALDO devedor, não valor de face: uma conta de R$ 1.000 com
  // R$ 400 já pagos pesa R$ 600 aqui, no fluxo de caixa e na prioridade.
  var valorTotalLista = lista.reduce(function(s,c){ return s + saldoDe(c); }, 0);
  function somaSaldo(pred){ return (contas || []).filter(pred).reduce(function(s,c){ return s + saldoDe(c); }, 0); }
  var selIds = Object.keys(sel).filter(function(k){ return sel[k]; });
  var selecionadas = (contas || []).filter(function(c){ return sel[c.id] && statusReal(c) !== "cancelada"; });
  var pagaveis = selecionadas.filter(function(c){ return saldoDe(c) > 0; });

  function alternar(id){ setSel(function(x){ var n = Object.assign({}, x); if (n[id]) delete n[id]; else n[id] = true; return n; }); }
  function alternarTodas(){
    if (lista.every(function(c){ return sel[c.id]; })) { setSel({}); return; }
    var n = {}; lista.forEach(function(c){ n[c.id] = true; }); setSel(n);
  }

  // Registra os pagamentos vindos do modal. Cada um entra na lista da conta; o
  // status vira "paga" só quando o saldo zera.
  function confirmarBaixa(pgs){
    var porConta = {};
    pgs.forEach(function(x){ (porConta[x.contaId] = porConta[x.contaId] || []).push(x); });
    var n = 0, parciais = 0;
    salvar((contas || []).map(function(c){
      var lst = porConta[c.id]; if (!lst) return c;
      var novo = Object.assign({}, c, { pagamentos: pagamentosDe(c).concat(lst.map(function(x,i){
        return { id: "pg_" + Date.now() + "_" + n + "_" + i, data: x.data, valor: x.valor, conta: x.conta };
      })) });
      n++;
      if (saldoDe(novo) <= 0.005) { novo.status = "paga"; novo.pago_em = lst[lst.length-1].data; }
      else { novo.status = "pendente"; delete novo.pago_em; parciais++; }
      return novo;
    }));
    setBaixando(null); setSel({});
    setResultadoImp(n + " conta(s) baixada(s)" + (parciais ? " · " + parciais + " parcial(is), ainda em aberto pelo restante" : "") + ".");
  }
  function excluirSelecionadas(){
    if (!selIds.length) return;
    var pagas = selecionadas.filter(function(c){ return pagoDe(c) > 0; }).length;
    if (!window.confirm("Excluir " + selIds.length + " conta(s)?" +
        (pagas ? "\n\n" + pagas + " delas já tem pagamento registrado — o movimento sai do extrato junto." : ""))) return;
    salvar((contas || []).filter(function(c){ return !sel[c.id]; }));
    setSel({});
  }

  var kpis = [
    { l:"Pendentes", v:fmt(somaSaldo(function(c){ return statusReal(c) === "pendente"; })), c:"var(--text-strong)" },
    { l:"Vencidas", v:fmt(somaSaldo(function(c){ return statusReal(c) === "vencida"; })), c:"#FF5252" },
    { l:"Pagas", v:fmt(somaSaldo(function(c){ return statusReal(c) === "paga"; })), c:"#0a9d4e" },
    { l:"Canceladas", v:fmt(somaSaldo(function(c){ return statusReal(c) === "cancelada"; })), c:"var(--text-3)" },
  ];
  // Recebe uma conta, a série inteira que o modal expandiu, ou um pedido de
  // edição em série: { conta, escopo, serieId, vencimento }.
  function salvarConta(c){
    if (c && c.escopo) { aplicarNaSerie(c); return; }
    var novas = Array.isArray(c) ? c : [c];
    var arr = (contas || []).slice();
    novas.forEach(function(n){
      var i = arr.findIndex(function(x){ return x.id === n.id; });
      if (i >= 0) arr[i] = n; else arr.push(n);
    });
    salvar(arr);
    // O que foi digitado uma vez fica no sistema: a próxima conta já sugere.
    var cat = String(novas[0].categoria || "").trim();
    if (cat && salvarCategorias && (categorias || []).indexOf(cat) < 0) {
      salvarCategorias((categorias || []).concat([cat]));
    }
    var forn = String(novas[0].descricao || "").trim();
    if (forn && salvarFornecedores) {
      var jaTem = (fornecedores || []).some(function(x){
        return String(x.nome || x.razaoSocial || x.fantasia || x).trim().toLowerCase() === forn.toLowerCase();
      });
      if (!jaTem) salvarFornecedores((fornecedores || []).concat([{ id:"fn_"+Date.now(), nome:forn, origem:"contas a pagar" }]));
    }
    setModal(null);
    if (novas.length > 1) setResultadoImp(novas.length + " contas criadas — a série inteira já está na lista.");
  }
  // Aplica a edição às contas da série conforme o alcance escolhido. O que muda
  // é só o que o usuário mexeu — vencimento, status e a numeração da parcela
  // continuam de cada conta, senão a série inteira colapsaria numa data só.
  function aplicarNaSerie(pedido){
    var base = pedido.conta;
    var campos = ["descricao","categoria","valor","valorTotal","juros","multa","forma","conta","ndoc","historico"];
    var n = 0;
    var arr = (contas || []).map(function(x){
      if (x.serieId !== pedido.serieId) return x;
      if (x.status === "paga" || x.status === "cancelada") return x;   // pagas nunca mudam
      if (pedido.escopo === "uma" && x.id !== base.id) return x;
      if (pedido.escopo === "proximas" && (x.vencimento || "") < (pedido.vencimento || "")) return x;
      var novo = Object.assign({}, x);
      campos.forEach(function(k){ novo[k] = base[k]; });
      n++;
      return novo;
    });
    salvar(arr); setModal(null);
    setResultadoImp(n + " conta(s) da série atualizada(s).");
  }

  var badge = { pendente:["var(--text-2)","var(--surface-3)","Pendente"], vencida:["#FF5252","rgba(255,82,82,.14)","Vencida"], parcial:["#FFC107","rgba(255,193,7,.14)","Parcial"], paga:["#0a9d4e","rgba(10,157,78,.14)","Paga"], cancelada:["var(--text-3)","var(--surface-3)","Cancelada"] };
  var sits = [["todas","Todas"],["pendente","Pendentes"],["vencida","Vencidas"],["paga","Pagas"],["cancelada","Canceladas"]];
  var selFiltro = { width:"100%", background:"var(--bg-2)", border:"1px solid var(--border)", color:"var(--text-2)", padding:"7px 9px", borderRadius:8, fontSize:12.5 };
  var filtBtn = { background:"var(--surface)", border:"1px solid var(--border)", color:"var(--text-2)", padding:"9px 12px", borderRadius:9, cursor:"pointer", fontSize:13, whiteSpace:"nowrap" };
  function limpar(){ setSit("todas"); setFCategoria(""); setBusca(""); setDe(""); setAte(""); }
  function exportar(){ baixarCSV("contas-pagar", ["Vencimento","Fornecedor","Categoria","Valor","Situação"], lista.map(function(c){ return [c.vencimento||"", c.descricao||"", c.categoria||"", (parseFloat(c.valor)||0).toFixed(2), statusReal(c)]; })); }
  function imprimir(){ baixarPDF("contas-a-pagar", ["Vencimento","Fornecedor","Categoria","Valor","Situação"], lista.map(function(c){ return [c.vencimento?(fmtDate(c.vencimento)||c.vencimento):"—", c.descricao||"", c.categoria||"", fmt(parseFloat(c.valor)||0), statusReal(c)]; })); }
  var temFiltro = sit!=="todas" || fCategoria || busca || de || ate;
  // O número grande responde à pergunta da tela: aqui é "o que me aperta agora",
  // não o total histórico.
  var venc7 = (contas||[]).filter(function(c){ var st=statusReal(c); return st==="pendente" && c.vencimento && c.vencimento <= new Date(Date.now()+7*864e5).toISOString().slice(0,10); });
  return (
    <FinanceiroShell tab={tab} setTab={setTab} titulo="Contas a pagar"
      sub="Compromissos com vencimento. A baixa aqui vira movimento em Lançamentos."
      kpis={[
        { rotulo:"Vencidas", valor:fmt(somaSaldo(function(c){ return statusReal(c) === "vencida"; })),
          cor: (contas||[]).some(function(c){ return statusReal(c)==="vencida"; }) ? FIN_COR.saida : FIN_COR.fraco,
          nota:(contas||[]).filter(function(c){ return statusReal(c)==="vencida"; }).length + " conta(s)" },
        { rotulo:"Vencem em 7 dias", valor:fmt(venc7.reduce(function(a,c){ return a + saldoDe(c); },0)), cor: venc7.length ? FIN_COR.atencao : FIN_COR.fraco, nota:venc7.length + " conta(s)" },
        { rotulo:"Em aberto", valor:fmt(somaSaldo(function(c){ var st = statusReal(c); return st === "pendente" || st === "vencida" || st === "parcial"; })),
          cor:FIN_COR.neutro, nota:"saldo devedor, não valor de face" },
        { rotulo:"Pagamento parcial", valor:fmt(somaSaldo(function(c){ return statusReal(c) === "parcial"; })),
          cor: (contas||[]).some(function(c){ return statusReal(c)==="parcial"; }) ? FIN_COR.atencao : FIN_COR.fraco,
          nota:(contas||[]).filter(function(c){ return statusReal(c)==="parcial"; }).length + " conta(s) · falta este valor" },
      ]}
      acoes={<>
        <AcaoFin tipo="pri" onClick={function(){ setModal({}); }}>+ Incluir conta</AcaoFin>
        <AcaoFin onClick={function(){ setImportando(true); }}>⬆ Importar planilha</AcaoFin>
        <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:12, padding:"6px", display:"flex", flexDirection:"column" }}>
          <button onClick={exportar} style={{ background:"none", border:"none", textAlign:"left", padding:"9px 10px", borderRadius:7, cursor:"pointer", fontSize:12.5, color:"var(--text-2)", width:"100%" }}>Exportar para planilha</button>
          <button onClick={function(){ imprimir(); }} style={{ background:"none", border:"none", textAlign:"left", padding:"9px 10px", borderRadius:7, cursor:"pointer", fontSize:12.5, color:"var(--text-2)", width:"100%" }}>Imprimir</button>
        </div>
        <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:12, padding:"12px 14px" }}>
          <div style={{ fontSize:11.5, color:"var(--text-3)" }}>Total filtrado</div>
          <div style={{ fontSize:18, fontWeight:600, color:"var(--text-strong)" }}>{fmt(valorTotalLista)}</div>
          <div style={{ fontSize:11, color:"var(--text-4)", marginTop:2 }}>{lista.length} de {(contas||[]).length} conta(s)</div>
        </div>
      </>}>
      <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:12, flexWrap:"wrap" }}>
        <button onClick={alternarFiltros} style={{ ...filtBtn, background: mostrarFiltros?"rgba(118,133,146,.14)":"var(--surface)" }}>{mostrarFiltros ? "⟨ Filtros" : "⟩ Filtros"}</button>
        <div style={{ position:"relative", flex:1, minWidth:220, maxWidth:460 }}>
          <span style={{ position:"absolute", left:12, top:"50%", transform:"translateY(-50%)", color:"var(--text-3)", fontSize:13 }}>🔍</span>
          <input value={busca} onChange={function(e){ setBusca(e.target.value); }} placeholder="Pesquise por fornecedor, categoria ou histórico" className="busca" />
        </div>
        <div style={{ flex:1 }} />
        {/* As ações da seleção. Ficam sempre visíveis, apagadas enquanto nada
            está marcado, para o caminho ser aprendido antes de ser necessário. */}
        <span className="nota" style={{ opacity: selIds.length ? 1 : .5 }}>
          {selIds.length ? selIds.length + " selecionada(s)" : "selecione para agir"}
        </span>
        <button onClick={function(){ if (pagaveis.length) setBaixando(pagaveis); }} disabled={!pagaveis.length}
          title={pagaveis.length ? "Registrar o pagamento das contas marcadas" : "Marque uma ou mais contas em aberto"}
          className="btn" style={{ background: pagaveis.length ? "var(--ui-accent)" : "var(--surface)",
                   color: pagaveis.length ? "var(--ui-accent-text)" : "var(--text-4)",
                   border: pagaveis.length ? "none" : "1px solid var(--border)",
                   cursor: pagaveis.length ? "pointer" : "not-allowed" }}>
          Baixar pagamento{pagaveis.length ? " (" + pagaveis.length + ")" : ""}
        </button>
        <button onClick={excluirSelecionadas} disabled={!selIds.length} title={selIds.length ? "Excluir as contas marcadas" : "Marque uma ou mais contas"}
          className="btn" style={{ background:"var(--surface)", border:"1px solid var(--border)",
                   color: selIds.length ? "#FF5252" : "var(--text-4)", cursor: selIds.length ? "pointer" : "not-allowed", padding:"9px 13px" }}>🗑</button>
      </div>
      <div style={{ display:"flex", gap:12, alignItems:"flex-start" }}>
        {mostrarFiltros && (
          <div style={{ width:230, flexShrink:0, background:"var(--surface)", border:"1px solid var(--border)", borderRadius:12, padding:"14px", display:"flex", flexDirection:"column", gap:11 }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
              <span style={{ fontWeight:600, fontSize:14, color:"var(--text-strong)" }}>Filtrar</span>
              {temFiltro && <button onClick={limpar} style={{ background:"none", border:"none", color:"#768592", cursor:"pointer", fontSize:12 }}>Limpar</button>}
            </div>
            <div><div style={{ fontSize:11, color:"var(--text-3)", marginBottom:3 }}>Opção</div><select value={sit} onChange={function(e){ setSit(e.target.value); }} style={selFiltro}>{sits.map(function(s){ return <option key={s[0]} value={s[0]}>{s[1]}</option>; })}</select></div>
            <div><div style={{ fontSize:11, color:"var(--text-3)", marginBottom:3 }}>Categoria</div>
              <input value={fCategoria} onChange={function(e){ setFCategoria(e.target.value); }} placeholder="Todas categorias" list="filtro-cat-pagar" style={selFiltro} />
              <datalist id="filtro-cat-pagar">{(categorias||[]).map(function(x){ return <option key={x} value={x} />; })}</datalist>
            </div>
            <div>
              <div style={{ fontSize:11, color:"var(--text-3)", marginBottom:3 }}>Vencimento</div>
              <div style={{ display:"flex", flexWrap:"wrap", gap:4, marginBottom:6 }}>
                {[["mes","Este mês"],["prox","Próximo"],["30","30 dias"],["vencidas","Vencidas"],["","Tudo"]].map(function(o){
                  return <button key={o[0]} onClick={function(){ periodoRapido(o[0]); }}
                    style={{ fontSize:10.5, fontWeight:600, padding:"3px 8px", borderRadius:6, cursor:"pointer",
                             border:"1px solid var(--border)", background:"var(--surface)", color:"var(--text-3)" }}>{o[1]}</button>;
                })}
              </div>
              <input type="date" value={de} onChange={function(e){ setDe(e.target.value); }} style={{ ...selFiltro, marginBottom:5 }} title="De" />
              <input type="date" value={ate} onChange={function(e){ setAte(e.target.value); }} style={selFiltro} title="Até" />
            </div>
            <button onClick={limpar} style={{ background:"none", border:"none", color:"var(--ui-accent)", fontWeight:600, cursor:"pointer", fontSize:12.5, textAlign:"left" }}>Limpar filtros</button>
          </div>
        )}
        <div style={{ flex:1, minWidth:0 }}>
          {lista.length === 0 ? (
            <VazioFin icone="🗎"
              titulo={temFiltro ? "Nenhuma conta com esses filtros." : "Nenhuma conta cadastrada."}
              texto={temFiltro
                ? "Limpe os filtros para ver todas, ou cadastre a conta que está procurando."
                : "Cadastre aqui o que você deve, com vencimento, categoria e — quando houver — juros e multa. É isso que faz a Prioridade de pagamento e o Fluxo de caixa funcionarem."}
              acao={temFiltro ? "Limpar filtros" : "+ Incluir conta"}
              onAcao={temFiltro ? limpar : function(){ setModal({}); }} />
          ) : (
            <div className="tabela-wrap">
              <table className="tabela">
                <thead><tr>
                  <th className="th" style={{ width:34, paddingRight:0 }}>
                    <input type="checkbox" checked={lista.length > 0 && lista.every(function(c){ return sel[c.id]; })}
                      onChange={alternarTodas} title="Selecionar todas as contas da lista" style={{ cursor:"pointer", accentColor:"var(--ui-accent)" }} />
                  </th>
                  {["Vencimento","Fornecedor","Categoria","Valor","Pago","Em aberto","Situação"].map(function(h,hi){
                    return <th key={h} className="th" style={hi >= 3 ? { textAlign:"right" } : null}>{h}</th>;
                  })}
                </tr></thead>
                <tbody>
                  {lista.map(function(c,i){
                    var st = statusReal(c); var b = badge[st] || badge.pendente;
                    var pago = pagoDe(c), saldo = saldoDe(c), marcada = !!sel[c.id];
                    // A linha inteira abre a conta para edição; só a célula da
                    // caixa de seleção segura o clique, senão marcar abriria o modal.
                    return <tr key={c.id || i} onClick={function(){ setModal(c); }} title="Clique para editar a conta"
                      style={{ cursor:"pointer", background: marcada ? "rgba(10,157,78,.08)" : "transparent" }}>
                      <td className="td" style={{ paddingRight:0 }} onClick={function(e){ e.stopPropagation(); }}>
                        <input type="checkbox" checked={marcada} onChange={function(){ alternar(c.id); }}
                          style={{ cursor:"pointer", accentColor:"var(--ui-accent)" }} />
                      </td>
                      <td className="td">{c.vencimento ? (fmtDate(c.vencimento)||c.vencimento) : "—"}</td>
                      <td className="td" style={{ color:"var(--text-strong)" }}>
                        {c.descricao || "—"}
                        {c.serieId && <span style={{ marginLeft:7, fontSize:10, color:"var(--text-4)" }}>{c.parcela}/{c.parcelas}</span>}
                      </td>
                      <td className="td">{c.categoria || "—"}</td>
                      <td className="td-num" style={{ fontWeight:600 }}>{fmt(parseFloat(c.valorTotal || c.valor) || 0)}</td>
                      <td className="td-num" style={{ color: pago > 0 ? "#0a9d4e" : "var(--text-4)" }}>{pago > 0 ? fmt(pago) : "—"}</td>
                      <td className="td-num" style={{ fontWeight:600, color: saldo > 0 ? "var(--text-strong)" : "var(--text-4)" }}>{saldo > 0 ? fmt(saldo) : "—"}</td>
                      <td className="td" style={{ textAlign:"right" }}><span style={{ fontSize:11, fontWeight:500, padding:"2px 8px", borderRadius:20, background:b[1], color:b[0] }}>{b[2]}</span></td>
                    </tr>;
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
      {resultadoImp && (
        <div style={{ position:"fixed", left:"50%", bottom:24, transform:"translateX(-50%)", background:"var(--surface)", border:"1px solid #0a9d4e", borderRadius:12, padding:"12px 18px", zIndex:650, boxShadow:"0 8px 30px rgba(0,0,0,.2)", fontSize:13, color:"var(--text-2)", display:"flex", alignItems:"center", gap:14 }}>
          <span>{resultadoImp}</span>
          <button onClick={function(){ setResultadoImp(null); }} style={{ background:"none", border:"none", color:"var(--text-3)", cursor:"pointer", fontSize:16 }}>×</button>
        </div>
      )}
      {importando && <ImportarContasModal
        contas={contas}
        onImportar={function(novas){
          salvar((contas || []).concat(novas));
          setImportando(false);
          setResultadoImp(novas.length + " conta(s) importada(s).");
        }}
        onClose={function(){ setImportando(false); }} />}
      {modal && <ContaModal conta={modal.id ? modal : null} onSave={salvarConta} onClose={function(){ setModal(null); }}
        contasBancarias={contasBancarias} categorias={categorias} fornecedores={fornecedores}
        onNovoFornecedor={function(nf){ if (salvarFornecedores) salvarFornecedores((fornecedores || []).concat([nf])); }} />}
      {baixando && <BaixaModal contas={baixando} contasBancarias={contasBancarias}
        onConfirmar={confirmarBaixa} onClose={function(){ setBaixando(null); }} />}
    </FinanceiroShell>
  );
}

// Modal de pedido de compra.
// Novo pedido de compra — formulário em TELA CHEIA.
function PedidoCompraModal({ pedido, onSave, onClose }) {
  const [f, setF] = useState(function(){ return Object.assign({ fornecedor:"", data:new Date().toISOString().slice(0,10), dataPrevista:"", numero:"", ordem:"", condicao:"", categoria:"Compras de fornecedores", desconto:"0", frete:"", transportador:"", freteConta:"CIF", obs:"", obsInterna:"", status:"aberto" }, pedido || {}); });
  const [itens, setItens] = useState(function(){ if (pedido && Array.isArray(pedido.itensList) && pedido.itensList.length) return pedido.itensList; return [{ nome:"", codigo:"", un:"UN", qtd:"", precoUn:"" }]; });
  function set(k,v){ setF(function(s){ return Object.assign({}, s, { [k]:v }); }); }
  function setItem(i,k,v){ setItens(function(arr){ var n=arr.slice(); n[i]=Object.assign({},n[i],{ [k]:v }); return n; }); }
  function addItem(){ setItens(function(a){ return a.concat([{ nome:"", codigo:"", un:"UN", qtd:"", precoUn:"" }]); }); }
  function delItem(i){ setItens(function(a){ return a.length>1 ? a.filter(function(_,j){ return j!==i; }) : a; }); }
  var totalProdutos = itens.reduce(function(s,it){ return s + (parseFloat(it.qtd)||0)*(parseFloat(it.precoUn)||0); }, 0);
  var somaQtd = itens.reduce(function(s,it){ return s + (parseFloat(it.qtd)||0); }, 0);
  var nItens = itens.filter(function(it){ return it.nome || it.codigo; }).length;
  var desconto = parseFloat(f.desconto)||0, frete = parseFloat(f.frete)||0;
  var totalPedido = Math.max(0, totalProdutos - desconto + frete);
  var novo = !pedido || !pedido.id;
  function salvar(){
    var limpos = itens.filter(function(it){ return it.nome || it.codigo; });
    if (!f.fornecedor && !limpos.length){ alert("Informe o fornecedor e ao menos um item."); return; }
    var resumo = limpos.map(function(it){ return (it.qtd||"?")+"x "+(it.nome||it.codigo); }).join(", ");
    var p = Object.assign({}, f, { itensList:limpos, itens:resumo, valor: totalPedido.toFixed(2) });
    if (!p.id) p.id = "pc_"+Date.now();
    onSave(p);
  }
  var campo = { width:"100%", background:"var(--surface)", border:"1px solid var(--border)", color:"var(--text-strong)", padding:"9px 11px", borderRadius:8, fontSize:13, outline:"none", boxSizing:"border-box" };
  var readonly = { ...campo, background:"var(--bg-2)", color:"var(--text-2)" };
  var lbl = { fontSize:11.5, color:"var(--text-3)", fontWeight:600, marginBottom:4, display:"block" };
  var sec = { fontWeight:600, fontSize:15, color:"var(--text-strong)", margin:"22px 0 12px" };
  var cell = { padding:"6px 6px", borderBottom:"1px solid var(--border-soft)" };
  var inCell = { width:"100%", background:"var(--surface)", border:"1px solid var(--border)", color:"var(--text-strong)", padding:"7px 8px", borderRadius:7, fontSize:12.5, outline:"none", boxSizing:"border-box" };
  return (
    <div style={{ position:"fixed", inset:0, background:"var(--bg)", zIndex:600, overflowY:"auto" }}>
      <div style={{ maxWidth:1120, margin:"0 auto", padding:"20px 22px 60px" }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", gap:12, flexWrap:"wrap", position:"sticky", top:0, background:"var(--bg)", padding:"6px 0 12px", zIndex:2, borderBottom:"1px solid var(--border-soft)", marginBottom:8 }}>
          <div style={{ fontWeight:600, fontSize:20, color:"var(--text-strong)" }}>{novo ? "Pedido de compra" : "Editar pedido de compra"}</div>
          <div style={{ display:"flex", gap:10 }}>
            <button onClick={onClose} style={{ background:"var(--surface)", border:"1px solid var(--border)", color:"var(--text-2)", fontWeight:600, padding:"10px 22px", borderRadius:9, cursor:"pointer", fontSize:13 }}>Cancelar</button>
            <button onClick={salvar} style={{ background:"var(--ui-accent)", border:"none", color:"var(--ui-accent-text)", fontWeight:600, padding:"10px 26px", borderRadius:9, cursor:"pointer", fontSize:13 }}>Salvar</button>
          </div>
        </div>
        <div style={{ textAlign:"right", fontSize:11, color:"#FF5252", marginBottom:4 }}>(*) Campos obrigatórios</div>

        <div style={sec}>Fornecedor</div>
        <div><label style={lbl}>Fornecedor <span style={{ color:"#FF5252" }}>*</span></label><input value={f.fornecedor||""} onChange={function(e){ set("fornecedor", e.target.value); }} placeholder="Nome do fornecedor" style={campo} /></div>

        <div style={sec}>Itens do pedido de compra</div>
        <div style={{ overflowX:"auto" }}>
          <table style={{ width:"100%", borderCollapse:"collapse", minWidth:720 }}>
            <thead><tr>{["#","Item","Código","Un","Qtde","Preço un","Preço total",""].map(function(h){ return <th key={h} style={{ ...cell, textAlign:"left", fontSize:11, color:"var(--text-3)", fontWeight:600 }}>{h}</th>; })}</tr></thead>
            <tbody>
              {itens.map(function(it,i){ var tot=(parseFloat(it.qtd)||0)*(parseFloat(it.precoUn)||0);
                return <tr key={i}>
                  <td style={{ ...cell, color:"var(--text-3)", fontSize:12 }}>{i+1}</td>
                  <td style={cell}><input value={it.nome||""} onChange={function(e){ setItem(i,"nome",e.target.value); }} placeholder="Digite parte do nome ou código" style={inCell} /></td>
                  <td style={{ ...cell, width:120 }}><input value={it.codigo||""} onChange={function(e){ setItem(i,"codigo",e.target.value); }} style={inCell} /></td>
                  <td style={{ ...cell, width:64 }}><input value={it.un||""} onChange={function(e){ setItem(i,"un",e.target.value); }} style={inCell} /></td>
                  <td style={{ ...cell, width:80 }}><input type="number" value={it.qtd||""} onChange={function(e){ setItem(i,"qtd",e.target.value); }} style={inCell} /></td>
                  <td style={{ ...cell, width:100 }}><input type="number" step="0.01" value={it.precoUn||""} onChange={function(e){ setItem(i,"precoUn",e.target.value); }} style={inCell} /></td>
                  <td style={{ ...cell, width:110, fontVariantNumeric:"tabular-nums", color:"var(--text-strong)", fontSize:12.5 }}>{fmt(tot)}</td>
                  <td style={{ ...cell, width:34 }}><button onClick={function(){ delItem(i); }} title="Remover" style={{ background:"none", border:"none", color:"#FF5252", cursor:"pointer", fontSize:14 }}>🗑</button></td>
                </tr>;
              })}
            </tbody>
          </table>
        </div>
        <div style={{ textAlign:"right", marginTop:8 }}><button onClick={addItem} style={{ background:"none", border:"none", color:"var(--ui-accent)", fontWeight:600, cursor:"pointer", fontSize:13 }}>+ Adicionar outro item</button></div>

        <div style={sec}>Totais da compra</div>
        <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(180px,1fr))", gap:12 }}>
          <div><label style={lbl}>Total dos produtos</label><input readOnly value={fmt(totalProdutos)} style={readonly} /></div>
          <div><label style={lbl}>Desconto</label><input type="number" step="0.01" value={f.desconto||""} onChange={function(e){ set("desconto", e.target.value); }} style={campo} /></div>
          <div><label style={lbl}>Frete</label><input type="number" step="0.01" value={f.frete||""} onChange={function(e){ set("frete", e.target.value); }} style={campo} /></div>
          <div><label style={lbl}>Total do pedido</label><input readOnly value={fmt(totalPedido)} style={{ ...readonly, fontWeight:700, color:"var(--text-strong)" }} /></div>
          <div><label style={lbl}>Nº de itens</label><input readOnly value={String(nItens)} style={readonly} /></div>
          <div><label style={lbl}>Soma das qtdes</label><input readOnly value={String(somaQtd)} style={readonly} /></div>
        </div>

        <div style={sec}>Detalhes da compra</div>
        <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(180px,1fr))", gap:12 }}>
          <div><label style={lbl}>Número do pedido</label><input value={f.numero||""} onChange={function(e){ set("numero", e.target.value); }} style={campo} /></div>
          <div><label style={lbl}>Ordem de compra</label><input value={f.ordem||""} onChange={function(e){ set("ordem", e.target.value); }} style={campo} /></div>
          <div><label style={lbl}>Data da compra</label><input type="date" value={f.data||""} onChange={function(e){ set("data", e.target.value); }} style={campo} /></div>
          <div><label style={lbl}>Data prevista</label><input type="date" value={f.dataPrevista||""} onChange={function(e){ set("dataPrevista", e.target.value); }} style={campo} /></div>
        </div>

        <div style={sec}>Pagamento</div>
        <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(200px,1fr))", gap:12 }}>
          <div><label style={lbl}>Condição de pagamento</label><input value={f.condicao||""} onChange={function(e){ set("condicao", e.target.value); }} placeholder="Ex.: 30/60/90" style={campo} /></div>
          <div><label style={lbl}>Categoria</label><input value={f.categoria||""} onChange={function(e){ set("categoria", e.target.value); }} style={campo} /></div>
          <div><label style={lbl}>Situação</label><select value={f.status||"aberto"} onChange={function(e){ set("status", e.target.value); }} style={campo}><option value="aberto">Em aberto</option><option value="recebido">Recebido</option><option value="cancelado">Cancelado</option></select></div>
        </div>

        <div style={sec}>Transportador</div>
        <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(200px,1fr))", gap:12 }}>
          <div><label style={lbl}>Nome</label><input value={f.transportador||""} onChange={function(e){ set("transportador", e.target.value); }} style={campo} /></div>
          <div><label style={lbl}>Frete por conta</label><select value={f.freteConta||"CIF"} onChange={function(e){ set("freteConta", e.target.value); }} style={campo}><option value="CIF">0 - Remetente (CIF)</option><option value="FOB">1 - Destinatário (FOB)</option></select></div>
        </div>

        <div style={sec}>Dados adicionais</div>
        <div style={{ display:"grid", gap:12 }}>
          <div><label style={lbl}>Observações</label><textarea value={f.obs||""} onChange={function(e){ set("obs", e.target.value); }} rows={3} style={{ ...campo, resize:"vertical" }} /></div>
          <div><label style={lbl}>Observações internas</label><textarea value={f.obsInterna||""} onChange={function(e){ set("obsInterna", e.target.value); }} rows={3} style={{ ...campo, resize:"vertical" }} /></div>
        </div>

        <div style={{ display:"flex", gap:10, justifyContent:"flex-end", marginTop:24 }}>
          <button onClick={onClose} style={{ background:"var(--surface)", border:"1px solid var(--border)", color:"var(--text-2)", fontWeight:600, padding:"10px 22px", borderRadius:9, cursor:"pointer", fontSize:13 }}>Cancelar</button>
          <button onClick={salvar} style={{ background:"var(--ui-accent)", border:"none", color:"var(--ui-accent-text)", fontWeight:600, padding:"10px 26px", borderRadius:9, cursor:"pointer", fontSize:13 }}>Salvar</button>
        </div>
      </div>
    </div>
  );
}
// Compras: sugestão de reposição (produtos abaixo do mínimo) + pedidos de compra.
function ComprasTab({ produtos, pedidos, salvar }) {
  const [modal, setModal] = useState(null);
  const [verSug, setVerSug] = useState(false);
  // Fica guardado: quem fecha os filtros para ganhar largura não quer reabri-los
  // a cada troca de aba.
  const [mostrarFiltros, setMostrarFiltros] = useState(function(){
    try { return localStorage.getItem("fin_filtros_ocultos") !== "1"; } catch { return true; }
  });
  function alternarFiltros(){
    setMostrarFiltros(function(v){
      var novo = !v;
      try { localStorage.setItem("fin_filtros_ocultos", novo ? "0" : "1"); } catch(e) {}
      return novo;
    });
  }
  const [mostrarAcoes, setMostrarAcoes] = useState(true);
  const [busca, setBusca] = useState("");
  const [fSituacao, setFSituacao] = useState("todas");
  const [fProduto, setFProduto] = useState("");
  var sugestoes = (produtos || []).filter(function(p){ var a = parseInt(p.estoqueAtual) || 0, m = parseInt(p.estoqueMinimo) || 0; return m > 0 && a <= m; });
  var abertos = (pedidos || []).filter(function(x){ return x.status !== "recebido" && x.status !== "cancelado"; });
  var valorAberto = abertos.reduce(function(s,x){ return s + (parseFloat(x.valor) || 0); }, 0);
  var recebidos = (pedidos || []).filter(function(x){ return x.status === "recebido"; }).length;
  var kpis = [
    { l:"Pedidos em aberto", v:String(abertos.length), c:"var(--text-strong)" },
    { l:"Valor em aberto", v:fmt(valorAberto), c:"var(--text-strong)" },
    { l:"Recebidos", v:String(recebidos), c:"#0a9d4e" },
    { l:"Itens para repor", v:String(sugestoes.length), c: sugestoes.length > 0 ? "#FFC107" : "var(--text-strong)" },
  ];
  function salvarPedido(p){ var arr = (pedidos || []).slice(); var i = arr.findIndex(function(x){ return x.id === p.id; }); if (i >= 0) arr[i] = p; else arr.push(p); salvar(arr); setModal(null); }
  function excluir(p){ if (!window.confirm("Excluir este pedido?")) return; salvar((pedidos || []).filter(function(x){ return x.id !== p.id; })); }
  function receber(p){ salvar((pedidos || []).map(function(x){ return x.id === p.id ? Object.assign({}, x, { status:"recebido" }) : x; })); }
  var badgeP = { aberto:["#FFC107","rgba(255,193,7,.14)","Em aberto"], recebido:["#0a9d4e","rgba(10,157,78,.14)","Recebido"], cancelado:["var(--text-3)","var(--surface-3)","Cancelado"] };
  var pedidosOrd = (pedidos || []).slice().sort(function(a,b){ return (b.data || "").localeCompare(a.data || ""); });
  var lista = pedidosOrd.filter(function(p){
    if (fSituacao!=="todas" && (p.status||"aberto")!==fSituacao) return false;
    if (fProduto && String(p.itens||"").toLowerCase().indexOf(fProduto.toLowerCase())<0) return false;
    var q=busca.trim().toLowerCase();
    if (q && String(p.fornecedor||"").toLowerCase().indexOf(q)<0 && String(p.numero||"").toLowerCase().indexOf(q)<0 && String(p.itens||"").toLowerCase().indexOf(q)<0) return false;
    return true;
  });
  var valorTotalLista = lista.reduce(function(s,p){ return s+(parseFloat(p.valor)||0); }, 0);
  var temFiltro = fSituacao!=="todas" || fProduto || busca;
  function limpar(){ setFSituacao("todas"); setFProduto(""); setBusca(""); }
  function exportarCompras(){ baixarCSV("pedidos-compra", ["Data","Fornecedor","Nº pedido","Itens","Valor","Situação"], lista.map(function(p){ return [p.data||"", p.fornecedor||"", p.numero||"", p.itens||"", (parseFloat(p.valor)||0).toFixed(2), p.status||"aberto"]; })); }
  var selFiltro = { width:"100%", background:"var(--bg-2)", border:"1px solid var(--border)", color:"var(--text-2)", padding:"7px 9px", borderRadius:8, fontSize:12.5 };
  var acaoItem = { background:"none", border:"none", textAlign:"left", padding:"9px 10px", borderRadius:7, cursor:"pointer", fontSize:12.5, color:"var(--text-2)", width:"100%" };
  var filtBtn = { background:"var(--surface)", border:"1px solid var(--border)", color:"var(--text-2)", padding:"9px 12px", borderRadius:9, cursor:"pointer", fontSize:13, whiteSpace:"nowrap" };
  return (
    <div style={{ padding:2 }}>
      <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:12, flexWrap:"wrap" }}>
        <div style={{ fontWeight:600, fontSize:20, color:"var(--text-strong)" }}>Pedidos de compra</div>
        <button onClick={alternarFiltros} style={{ ...filtBtn, background: mostrarFiltros?"rgba(118,133,146,.14)":"var(--surface)" }}>{mostrarFiltros ? "⟨ Filtros" : "⟩ Filtros"}</button>
        <div style={{ position:"relative", flex:1, minWidth:220, maxWidth:520 }}>
          <span style={{ position:"absolute", left:12, top:"50%", transform:"translateY(-50%)", color:"var(--text-3)", fontSize:13 }}>🔍</span>
          <input value={busca} onChange={function(e){ setBusca(e.target.value); }} placeholder="Pesquisa por nome, número do pedido ou item" style={{ width:"100%", background:"var(--surface)", border:"1px solid var(--border)", color:"var(--text-strong)", padding:"9px 12px 9px 34px", borderRadius:9, fontSize:13, outline:"none" }} />
        </div>
        <div style={{ flex:1 }} />
        <button onClick={function(){ setVerSug(function(v){ return !v; }); }} style={filtBtn}>Sugerir reposição{sugestoes.length ? " ("+sugestoes.length+")" : ""}</button>
        <button onClick={function(){ setMostrarAcoes(function(v){return !v;}); }} style={filtBtn}>Ações</button>
      </div>

      <div style={{ display:"flex", gap:12, alignItems:"flex-start" }}>
        {mostrarFiltros && (
          <div style={{ width:230, flexShrink:0, background:"var(--surface)", border:"1px solid var(--border)", borderRadius:12, padding:"14px", display:"flex", flexDirection:"column", gap:11 }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
              <span style={{ fontWeight:600, fontSize:14, color:"var(--text-strong)" }}>Filtrar</span>
              {temFiltro && <button onClick={limpar} style={{ background:"none", border:"none", color:"#768592", cursor:"pointer", fontSize:12 }}>Limpar</button>}
            </div>
            <div><div style={{ fontSize:11, color:"var(--text-3)", marginBottom:3 }}>Situação</div><select value={fSituacao} onChange={function(e){ setFSituacao(e.target.value); }} style={selFiltro}><option value="todas">Todas</option><option value="aberto">Em aberto</option><option value="recebido">Recebido</option><option value="cancelado">Cancelado</option></select></div>
            <div><div style={{ fontSize:11, color:"var(--text-3)", marginBottom:3 }}>Produto</div><input value={fProduto} onChange={function(e){ setFProduto(e.target.value); }} placeholder="Item do pedido" style={selFiltro} /></div>
            <div><div style={{ fontSize:11, color:"var(--text-3)", marginBottom:3 }}>Lote / Observação</div><input disabled placeholder="Indisponível" style={{ ...selFiltro, opacity:.45 }} /></div>
            <button onClick={function(){}} style={{ background:"var(--surface)", border:"1px solid var(--ui-accent)", color:"var(--ui-accent)", fontWeight:600, padding:"9px", borderRadius:9, cursor:"pointer", fontSize:13, marginTop:2 }}>Filtrar</button>
            <button onClick={limpar} style={{ background:"none", border:"none", color:"var(--ui-accent)", fontWeight:600, cursor:"pointer", fontSize:12.5 }}>Limpar filtros</button>
          </div>
        )}

        <div style={{ flex:1, minWidth:0 }}>
          {verSug && (
            <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:12, padding:"14px 18px", marginBottom:12 }}>
              <div style={{ fontWeight:600, fontSize:14, color:"var(--text-strong)", marginBottom:10 }}>Sugestão de reposição (abaixo do estoque mínimo)</div>
              {sugestoes.length === 0 ? <div style={{ color:"var(--text-3)", fontSize:13 }}>Nenhum produto abaixo do mínimo.</div> :
                sugestoes.slice(0,50).map(function(p,i){ return <div key={i} style={{ display:"flex", justifyContent:"space-between", padding:"7px 0", borderBottom: i < Math.min(sugestoes.length,50)-1 ? "1px solid var(--border-soft)" : "none", fontSize:13 }}>
                  <span style={{ color:"var(--text-2)", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{nomeProd(p)}</span>
                  <span style={{ color:"#FFC107", fontWeight:600, flexShrink:0, marginLeft:12 }}>{parseInt(p.estoqueAtual)||0} / mín {parseInt(p.estoqueMinimo)||0}</span>
                </div>; })}
            </div>
          )}
          {lista.length === 0 ? (
            <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:12, padding:"60px 20px", textAlign:"center" }}>
              <div style={{ fontSize:40, marginBottom:10 }}>🗎</div>
              <div style={{ fontWeight:600, fontSize:16, color:"var(--ui-accent)" }}>Nenhum resultado encontrado.</div>
              <div style={{ fontSize:13, color:"var(--text-3)", marginTop:4 }}>Crie um pedido em "Incluir pedido" ou ajuste os filtros.</div>
            </div>
          ) : (
            <div className="tabela-wrap">
              <table className="tabela">
                <thead><tr>{["Data","Fornecedor","Itens","Valor","Situação","Ações"].map(function(h){ return <th key={h} className="th">{h}</th>; })}</tr></thead>
                <tbody>
                  {lista.map(function(p,i){
                    var b = badgeP[p.status] || badgeP.aberto;
                    return <tr key={p.id || i}>
                      <td className="td">{p.data ? (fmtDate(p.data)||p.data) : "—"}</td>
                      <td className="td" style={{ color:"var(--text-strong)" }}>{p.fornecedor || "—"}</td>
                      <td className="td" style={{ maxWidth:260, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{p.itens || "—"}</td>
                      <td className="td-num" style={{ fontWeight:600 }}>{fmt(parseFloat(p.valor) || 0)}</td>
                      <td className="td"><span style={{ fontSize:11, fontWeight:500, padding:"2px 8px", borderRadius:20, background:b[1], color:b[0] }}>{b[2]}</span></td>
                      <td className="td">
                        <div style={{ display:"flex", gap:8 }}>
                          {p.status === "aberto" && <button onClick={function(){ receber(p); }} style={{ background:"rgba(10,157,78,.12)", border:"none", color:"var(--ui-accent)", fontSize:11, fontWeight:600, padding:"4px 10px", borderRadius:6, cursor:"pointer" }}>Receber</button>}
                          <button onClick={function(){ setModal(p); }} style={{ background:"var(--surface-3)", border:"none", color:"var(--text-2)", fontSize:11, fontWeight:600, padding:"4px 10px", borderRadius:6, cursor:"pointer" }}>Editar</button>
                          <button onClick={function(){ excluir(p); }} style={{ background:"rgba(255,82,82,.1)", border:"none", color:"#FF5252", fontSize:11, fontWeight:600, padding:"4px 10px", borderRadius:6, cursor:"pointer" }}>Excluir</button>
                        </div>
                      </td>
                    </tr>;
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {mostrarAcoes && (
          <div style={{ width:236, flexShrink:0, display:"flex", flexDirection:"column", gap:8 }}>
            <button onClick={function(){ setModal({}); }} style={{ background:"var(--ui-accent)", border:"none", color:"var(--ui-accent-text)", fontWeight:600, padding:"11px", borderRadius:9, cursor:"pointer", fontSize:13.5 }}>+ Incluir pedido</button>
            <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:12, padding:"6px", display:"flex", flexDirection:"column" }}>
              <button onClick={exportarCompras} style={acaoItem}>Exportar para planilha</button>
              <button onClick={function(){ baixarPDF("pedidos-de-compra", ["Data","Fornecedor","Nº pedido","Itens","Valor","Situação"], lista.map(function(p){ return [p.data?(fmtDate(p.data)||p.data):"", p.fornecedor||"", p.numero||"", p.itens||"", fmt(parseFloat(p.valor)||0), p.status||"aberto"]; })); }} style={acaoItem}>Imprimir</button>
            </div>
            <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:12, padding:"12px 14px" }}>
              <div style={{ fontWeight:600, fontSize:13, color:"var(--text-strong)", marginBottom:8 }}>Informações</div>
              <div style={{ fontSize:12, color:"var(--text-3)" }}>Quantidade de pedidos</div>
              <div style={{ fontSize:20, fontWeight:600, color:"var(--ui-accent)", marginBottom:8 }}>{lista.length}</div>
              <div style={{ fontSize:12, color:"var(--text-3)" }}>Valor total</div>
              <div style={{ fontSize:20, fontWeight:600, color:"var(--ui-accent)" }}>{fmt(valorTotalLista)}</div>
            </div>
          </div>
        )}
      </div>
      {modal && <PedidoCompraModal pedido={modal} onSave={salvarPedido} onClose={function(){ setModal(null); }} />}
    </div>
  );
}

// Dashboard com os dados REAIS da empresa (a partir dos pedidos já sincronizados): faturamento,
// lucro líquido, margem, taxas, impostos, custo e top produtos — com filtro por período.
// ═══════════════════════════════════════════════════════════════════════════
// SUB-DASHBOARDS (abas internas do Dashboard): Estados, Margem por pedido,
// Estoque, Clientes e Curva ABC. Compartilham os helpers abaixo.
// ═══════════════════════════════════════════════════════════════════════════
function pct1(n){ n = isFinite(n) ? n : 0; return n.toFixed(1).replace(".", ",") + "%"; }
var _inpDataG = { background:"var(--surface)", border:"1px solid var(--border)", color:"var(--text-2)", padding:"6px 8px", borderRadius:8, fontSize:12 };

// Downloads iniciados pelo usuário (clique nos botões Excel/CSV) — dados do próprio usuário.
function _dispararDownload(blob, nome){
  var url = URL.createObjectURL(blob); var a = document.createElement("a");
  a.href = url; a.download = nome; document.body.appendChild(a); a.click();
  document.body.removeChild(a); setTimeout(function(){ URL.revokeObjectURL(url); }, 1000);
}
function baixarCSV(nome, colunas, linhas){
  var esc = function(v){ v = (v==null?"":String(v)); return /[";\n]/.test(v) ? '"'+v.replace(/"/g,'""')+'"' : v; };
  var txt = colunas.map(esc).join(";") + "\n" + linhas.map(function(r){ return r.map(esc).join(";"); }).join("\n");
  _dispararDownload(new Blob(["﻿"+txt], { type:"text/csv;charset=utf-8;" }), nome+".csv");
}
function baixarExcel(nome, colunas, linhas){
  var esc = function(v){ return String(v==null?"":v).replace(/&/g,"&amp;").replace(/</g,"&lt;"); };
  var html = "<table border='1'><tr>" + colunas.map(function(c){ return "<th>"+esc(c)+"</th>"; }).join("") + "</tr>" +
    linhas.map(function(r){ return "<tr>" + r.map(function(c){ return "<td>"+esc(c)+"</td>"; }).join("") + "</tr>"; }).join("") + "</table>";
  _dispararDownload(new Blob(['<html><head><meta charset="utf-8"></head><body>'+html+'</body></html>'], { type:"application/vnd.ms-excel" }), nome+".xls");
}
// Gera um PDF SÓ com a tabela do relatório (abre uma aba limpa e imprime apenas os dados —
// não a tela inteira do sistema). O usuário escolhe "Salvar como PDF" no diálogo.
function baixarPDF(nome, colunas, linhas){
  var esc = function(v){ return String(v==null?"":v).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); };
  var titulo = String(nome||"Relatório").replace(/[-_]/g," ").replace(/\b\w/g, function(m){ return m.toUpperCase(); });
  var thead = "<tr>" + colunas.map(function(c){ return "<th>"+esc(c)+"</th>"; }).join("") + "</tr>";
  var tbody = linhas.map(function(r){ return "<tr>" + r.map(function(c){ return "<td>"+esc(c)+"</td>"; }).join("") + "</tr>"; }).join("");
  var html = '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>'+esc(titulo)+'</title>'
    + '<style>*{box-sizing:border-box}body{font-family:Arial,Helvetica,sans-serif;color:#222;margin:0;padding:26px}'
    + 'h1{font-size:17px;margin:0 0 2px}.sub{color:#666;font-size:11px;margin:0 0 16px}'
    + 'table{border-collapse:collapse;width:100%;font-size:11px}'
    + 'th{text-align:left;background:#f0f0f0;color:#333;padding:7px 8px;border-bottom:2px solid #ccc;white-space:nowrap}'
    + 'td{padding:6px 8px;border-bottom:1px solid #eee}tbody tr:nth-child(even) td{background:#fafafa}'
    + '@page{margin:14mm}</style></head><body>'
    + '<h1>'+esc(titulo)+'</h1><div class="sub">'+new Date().toLocaleString("pt-BR")+' · Flow Marketplaces · '+linhas.length+' registro(s)</div>'
    + '<table><thead>'+thead+'</thead><tbody>'+tbody+'</tbody></table>'
    + '<script>window.onload=function(){window.focus();setTimeout(function(){window.print();},150);};window.onafterprint=function(){window.close();};<\/script>'
    + '</body></html>';
  var w = window.open("", "_blank");
  if (!w){ alert("Habilite pop-ups para gerar o PDF do relatório."); return; }
  w.document.open(); w.document.write(html); w.document.close();
}
function BotoesExport({ nome, colunas, linhas }){
  return <div style={{ display:"flex", gap:8 }}>
    <button className="btn-exp" onClick={function(){ baixarExcel(nome, colunas, linhas()); }}>Excel</button>
    <button className="btn-exp" onClick={function(){ baixarCSV(nome, colunas, linhas()); }}>CSV</button>
    <button className="btn-exp" onClick={function(){ baixarPDF(nome, colunas, linhas()); }}>PDF</button>
  </div>;
}

// Datas De/Até correspondentes a um período nomeado (pra preencher o calendário ao clicar no botão).
function presetRange(p){
  var ate = new Date().toISOString().slice(0,10), de = "";
  if (p==="hoje") de = ate;
  else if (p==="7"||p==="30"||p==="90"){ var d=new Date(); d.setDate(d.getDate()-parseInt(p,10)); de = d.toISOString().slice(0,10); }
  else if (p==="mesatual") de = ate.slice(0,7)+"-01";
  else { de=""; ate=""; } // tudo / custom → sem intervalo definido
  return { de:de, ate:ate };
}

// Filtra pedidos (não cancelados) por período. periodo: hoje|7|30|90|mesatual|tudo|custom.
function filtrarPeriodo(orders, periodo, deData, ateData){
  var hoje = new Date().toISOString().slice(0,10);
  var cut = "0000-00-00";
  if (periodo==="7"||periodo==="30"||periodo==="90"){ var d=new Date(); d.setDate(d.getDate()-parseInt(periodo,10)); cut=d.toISOString().slice(0,10); }
  return (orders||[]).filter(function(o){
    if (o.status==="cancelled") return false;
    var dt=(o.date||"").slice(0,10); if(!dt) return periodo==="tudo";
    if (periodo==="hoje") return dt===hoje;
    if (periodo==="mesatual") return dt.slice(0,7)===hoje.slice(0,7);
    if (periodo==="tudo") return true;
    if (periodo==="custom"){ if(deData&&dt<deData) return false; if(ateData&&dt>ateData) return false; return true; }
    return dt>=cut;
  });
}
function BarraPeriodo({ periodo, setPeriodo, deData, setDeData, ateData, setAteData }){
  var ops=[["hoje","Hoje"],["7","7 dias"],["30","30 dias"],["mesatual","Mês atual"],["tudo","Tudo"]];
  return <div style={{ display:"flex", gap:6, alignItems:"center", flexWrap:"wrap" }}>
    {ops.map(function(p){ var a=periodo===p[0]; return <button key={p[0]} onClick={function(){ var r=presetRange(p[0]); setPeriodo(p[0]); setDeData(r.de); setAteData(r.ate); }}
      style={{ padding:"7px 14px", borderRadius:8, border:"1px solid var(--border)", cursor:"pointer", fontSize:12, fontWeight:600, background:a?"#768692":"var(--surface)", color:a?"#fff":"var(--text-3)" }}>{p[1]}</button>; })}
    <div style={{ display:"flex", alignItems:"center", gap:5, padding:"4px 8px", borderRadius:8, border:"1px solid var(--border)", background: periodo==="custom"?"rgba(118,134,146,.10)":"var(--surface)" }}>
      <input type="date" value={deData} onChange={function(e){ setDeData(e.target.value); setPeriodo("custom"); }} style={_inpDataG} />
      <span style={{ fontSize:11, color:"var(--text-3)" }}>até</span>
      <input type="date" value={ateData} onChange={function(e){ setAteData(e.target.value); setPeriodo("custom"); }} style={_inpDataG} />
      {periodo==="custom" && <button onClick={function(){ var r=presetRange("30"); setPeriodo("30"); setDeData(r.de); setAteData(r.ate); }} style={{ background:"none", border:"none", color:"var(--text-3)", cursor:"pointer", fontSize:14 }}>✕</button>}
    </div>
  </div>;
}

// ── Sub-aba ESTADOS: mapa do Brasil (choropleth) + vendas por estado ─────────
function EstadosDash({ enrichedOrders }){
  const [ufSel, setUfSel] = useState(null);
  const [periodo, setPeriodo] = useState("tudo");
  const [deData, setDeData] = useState("");
  const [ateData, setAteData] = useState("");
  var validos = filtrarPeriodo(enrichedOrders, periodo, deData, ateData);
  var agg = {};
  validos.forEach(function(o){
    var uf=((o.buyerUF||"")+"").toUpperCase()||"—"; var q=o.qty||1;
    if(!agg[uf]) agg[uf]={ uf:uf, fat:0, pecas:0, pedidos:0, prod:{} };
    var a=agg[uf]; a.fat+=(o.price||0)*q; a.pecas+=q; a.pedidos+=1;
    var k=o.title||o.listing_id||"?"; if(!a.prod[k]) a.prod[k]={ titulo:o.title||("Anúncio "+k), qtd:0, fat:0 }; a.prod[k].qtd+=q; a.prod[k].fat+=(o.price||0)*q;
  });
  var lista = Object.keys(agg).map(function(k){ var a=agg[k]; a.ticket=a.pedidos?a.fat/a.pedidos:0; a.produtos=Object.keys(a.prod).map(function(x){return a.prod[x];}).sort(function(x,y){return y.qtd-x.qtd;}); return a; }).sort(function(x,y){ return y.fat-x.fat; });
  var max = lista.reduce(function(m,e){ return (e.uf!=="—" && e.fat>m) ? e.fat : m; }, 1);
  var NOMES={}; BR_ESTADOS.forEach(function(s){ NOMES[s.uf]=s.nome; });
  var sel = (ufSel && agg[ufSel]) ? agg[ufSel] : (lista.filter(function(e){return e.uf!=="—";})[0]||null);
  function fillUF(uf){ var a=agg[uf]; if(!a||!a.fat) return { f:"var(--surface-3)", o:1 }; return { f:"#768692", o:0.22+0.78*Math.pow(a.fat/max,.5) }; }
  return (
    <div style={{ padding:2 }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", flexWrap:"wrap", gap:10, marginBottom:14 }}>
        <div>
          <div style={{ fontWeight:600, fontSize:20, color:"var(--text-strong)" }}>Vendas por estado</div>
          <div style={{ fontSize:13, color:"var(--text-3)" }}>Mapa do Brasil por faturamento no período. Clique num estado para ver os detalhes.</div>
        </div>
        <BarraPeriodo periodo={periodo} setPeriodo={setPeriodo} deData={deData} setDeData={setDeData} ateData={ateData} setAteData={setAteData} />
      </div>
      <div style={{ display:"flex", gap:14, flexWrap:"wrap", alignItems:"stretch" }}>
        <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:12, padding:"14px 16px", flex:"1 1 360px", minWidth:320 }}>
          <svg viewBox={BR_VIEWBOX} style={{ width:"100%", height:"auto", display:"block", maxHeight:460 }}>
            {BR_ESTADOS.map(function(s){ var c=fillUF(s.uf); var a=agg[s.uf]; var isSel = sel && sel.uf===s.uf;
              return <path key={s.uf} d={s.d} fill={c.f} fillOpacity={c.o} stroke={isSel?"#FFC107":"var(--bg-2)"} strokeWidth={isSel?1.6:0.5}
                style={{ cursor:"pointer" }} onClick={function(){ setUfSel(s.uf); }}>
                <title>{s.nome} ({s.uf}) — {a?fmt(a.fat)+" · "+a.pedidos+" pedido(s)":"sem vendas"}</title>
              </path>;
            })}
          </svg>
          <div style={{ display:"flex", alignItems:"center", gap:8, marginTop:8, fontSize:11, color:"var(--text-3)" }}>
            <span>Menos</span>
            <div style={{ flex:1, height:8, borderRadius:4, background:"linear-gradient(90deg, var(--surface-3), #768692)" }} />
            <span>Mais</span>
          </div>
        </div>
        <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:12, padding:"16px 18px", flex:"1 1 320px", minWidth:300 }}>
          {!sel ? <div style={{ color:"var(--text-3)", fontSize:13 }}>Sem vendas para exibir.</div> : <>
            <div style={{ fontWeight:600, fontSize:17, color:"var(--text-strong)" }}>{NOMES[sel.uf]||sel.uf} <span style={{ color:"var(--text-3)", fontWeight:600, fontSize:13 }}>({sel.uf})</span></div>
            <div style={{ display:"grid", gridTemplateColumns:"repeat(2,1fr)", gap:10, margin:"12px 0" }}>
              <div className="kpi"><div className="kpi-rot">Faturamento</div><div className="kpi-val" style={{ color:"var(--text-strong)" }}>{fmt(sel.fat)}</div></div>
              <div className="kpi"><div className="kpi-rot">Peças vendidas</div><div className="kpi-val" style={{ color:"var(--text-strong)" }}>{sel.pecas}</div></div>
              <div className="kpi"><div className="kpi-rot">Pedidos</div><div className="kpi-val" style={{ color:"var(--text-strong)" }}>{sel.pedidos}</div></div>
              <div className="kpi"><div className="kpi-rot">Ticket médio</div><div className="kpi-val" style={{ color:"var(--text-strong)" }}>{fmt(sel.ticket)}</div></div>
            </div>
            <div style={{ fontSize:12, fontWeight:500, color:"var(--text-3)", textTransform:"none", letterSpacing:.5, margin:"4px 0 6px" }}>Produtos vendidos</div>
            <div style={{ maxHeight:220, overflowY:"auto" }}>
              {sel.produtos.map(function(p,i){ return <div key={i} style={{ display:"flex", justifyContent:"space-between", gap:10, padding:"7px 0", borderBottom: i<sel.produtos.length-1?"1px solid var(--border-soft)":"none" }}>
                <span style={{ fontSize:12.5, color:"var(--text-2)", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{p.titulo}</span>
                <span style={{ fontSize:12.5, color:"var(--text-strong)", fontWeight:500, whiteSpace:"nowrap" }}>{p.qtd}× · {fmt(p.fat)}</span>
              </div>; })}
            </div>
          </>}
        </div>
      </div>
      <div className="tabela-wrap" style={{ marginTop:14 }}>
        <table className="tabela">
          <thead><tr>{["Estado","UF","Faturamento","Peças","Pedidos","Ticket médio"].map(function(h){ return <th key={h} className="th">{h}</th>; })}</tr></thead>
          <tbody>
            {lista.length===0 ? <tr><td className="td" colSpan={6}>Sem vendas.</td></tr> :
            lista.map(function(e,i){ var isSel=sel&&sel.uf===e.uf;
              return <tr key={i} onClick={function(){ setUfSel(e.uf); }} style={{ cursor:"pointer", background:isSel?"rgba(118,134,146,.08)":"transparent" }}>
                <td className="td" style={{ fontWeight:600, color:"var(--text-strong)" }}>{NOMES[e.uf]||(e.uf==="—"?"Não informado":e.uf)}</td>
                <td className="td-num">{e.uf}</td>
                <td className="td-num">{fmt(e.fat)}</td>
                <td className="td">{e.pecas}</td>
                <td className="td">{e.pedidos}</td>
                <td className="td-num">{fmt(e.ticket)}</td>
              </tr>;
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Sub-aba MARGEM POR PEDIDO ────────────────────────────────────────────────
function _painel(titulo, extra, itens){
  return <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:12, padding:"16px 18px" }}>
    <div style={{ display:"flex", justifyContent:"space-between", alignItems:"baseline", marginBottom:12, gap:8 }}>
      <div style={{ fontWeight:500, fontSize:14, color:"var(--text-strong)" }}>{titulo}</div>
      {extra ? <div style={{ fontSize:11, color:"var(--text-3)" }}>{extra}</div> : null}
    </div>
    <div style={{ display:"flex", gap:20, flexWrap:"wrap" }}>
      {itens.map(function(m,i){ return <div key={i} style={{ minWidth:88 }}>
        <div style={{ fontSize:11, color:"var(--text-3)", marginBottom:4 }}>{m.l}</div>
        <div style={{ fontSize:18, fontWeight:600, color:m.c||"var(--text-strong)" }}>{m.v}</div>
      </div>; })}
    </div>
  </div>;
}
function MargemPedidoDash({ enrichedOrders }){
  const [periodo,setPeriodo]=useState("mesatual");
  const [deData,setDeData]=useState(function(){ return presetRange("mesatual").de; }); const [ateData,setAteData]=useState(function(){ return presetRange("mesatual").ate; });
  const [aba,setAba]=useState("todos"); const [busca,setBusca]=useState(""); const [pagina,setPagina]=useState(1);
  var base=filtrarPeriodo(enrichedOrders, periodo, deData, ateData);
  function calc(o){ var q=o.qty||1; var valorBase=(o.price||0)*q, custo=(o.cost||0)*q, taxa=(o.fee||0)*q, imp=(o.imposto||0)*q, fv=o.freteSeller||0, fc=o.buyer_shipping_cost||0;
    var contrib=valorBase-custo-taxa-imp-fv; return { q, valorBase, valorPedido:valorBase+fc, custo, taxa, taxaPct: valorBase?taxa/valorBase*100:0, imp, fv, fc, contrib, contribPct: valorBase?contrib/valorBase*100:0 }; }
  var linhas=base.map(function(o){ return Object.assign({ o:o, id:o.id, data:o.date }, calc(o)); }).sort(function(a,b){ return (b.data||"").localeCompare(a.data||""); });
  var T={ fat:0,custo:0,taxa:0,imp:0,fv:0,fc:0,contrib:0 };
  linhas.forEach(function(r){ T.fat+=r.valorBase; T.custo+=r.custo; T.taxa+=r.taxa; T.imp+=r.imp; T.fv+=r.fv; T.fc+=r.fc; T.contrib+=r.contrib; });
  var nped=linhas.length, ticket=nped?T.fat/nped:0, margPct=T.fat?T.contrib/T.fat*100:0;
  var filtradas=linhas.filter(function(r){ if(aba==="lucro") return r.contrib>=0; if(aba==="prejuizo") return r.contrib<0; return true; });
  if(busca.trim()){ var qq=busca.trim().toLowerCase(); filtradas=filtradas.filter(function(r){ return String(r.id).toLowerCase().indexOf(qq)>=0 || (r.o.title||"").toLowerCase().indexOf(qq)>=0; }); }
  var dmap={};
  linhas.forEach(function(r){ var dia=(r.data||"").slice(0,10); if(!dia)return; if(!dmap[dia]) dmap[dia]={ ord:dia, dia:dia.slice(8,10)+"/"+dia.slice(5,7), margem:0, imposto:0, taxa:0, freteSum:0, fatSum:0, ped:0 }; var d=dmap[dia]; d.margem+=r.contrib; d.imposto+=r.imp; d.taxa+=r.taxa; d.freteSum+=r.fv; d.fatSum+=r.valorBase; d.ped+=1; });
  var serie=Object.keys(dmap).sort().map(function(k){ var d=dmap[k]; return { dia:d.dia, margem:d.margem, imposto:d.imposto, taxa:d.taxa, freteMedio:d.ped?d.freteSum/d.ped:0, ticketMedio:d.ped?d.fatSum/d.ped:0 }; });
  var POR=100, totalPg=Math.max(1,Math.ceil(filtradas.length/POR)), pg=Math.min(pagina,totalPg), slice=filtradas.slice((pg-1)*POR,pg*POR);
  var cols=["Nº","ID Pedido","Marketplace","Data","Valor do Pedido","Valor Base","Custo","$ Taxa Marketplace","% Taxa Marketplace","Imposto","Frete Vendedor","Frete Comprador","$ Contribuição","% Contribuição"];
  function rowsExport(){ return filtradas.map(function(r,i){ return [i+1, r.id, "Mercado Livre", fmtDate(r.data)||r.data, r.valorPedido.toFixed(2), r.valorBase.toFixed(2), r.custo.toFixed(2), r.taxa.toFixed(2), r.taxaPct.toFixed(2)+"%", r.imp.toFixed(2), r.fv.toFixed(2), r.fc.toFixed(2), r.contrib.toFixed(2), r.contribPct.toFixed(2)+"%"]; }); }
  var abas=[["todos","Todos"],["lucro","Lucro"],["prejuizo","Prejuízo"]];
  return (
    <div style={{ padding:2 }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", flexWrap:"wrap", gap:10, marginBottom:14 }}>
        <div><div style={{ fontWeight:600, fontSize:20, color:"var(--text-strong)" }}>Margem por pedido</div>
          <div style={{ fontSize:13, color:"var(--text-3)" }}>Margem de contribuição de cada pedido e indicadores do período.</div></div>
        <BarraPeriodo periodo={periodo} setPeriodo={setPeriodo} deData={deData} setDeData={setDeData} ateData={ateData} setAteData={setAteData} />
      </div>
      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit, minmax(300px, 1fr))", gap:12, marginBottom:14 }}>
        {_painel("Indicadores Operacionais", null, [
          { l:"Faturamento total", v:fmt(T.fat) }, { l:"Ticket médio", v:fmt(ticket) }, { l:"Quantidade de pedidos", v:String(nped) },
        ])}
        {_painel("Frete", "Frete comprador só no Mercado Livre", [
          { l:"Frete comprador", v:fmt(T.fc) }, { l:"Frete vendedor", v:fmt(T.fv), c:"#FF7043" },
        ])}
        {_painel("Custos variáveis", null, [
          { l:"Custo", v:fmt(T.custo), c:"#FF7043" }, { l:"Imposto", v:fmt(T.imp), c:"#FF7043" }, { l:"Taxa de marketplace", v:fmt(T.taxa), c:"#FF7043" },
        ])}
        {_painel("Margem de contribuição", null, [
          { l:"Total", v:fmt(T.contrib), c:T.contrib>=0?"#0a9d4e":"#FF5252" }, { l:"Percentual", v:pct1(margPct), c:margPct>=0?"#0a9d4e":"#FF5252" },
        ])}
      </div>
      <ChartCard titulo="Gráfico de progressão" sub="Por dia no período" flex={null}>
        {serie.length===0 ? <div style={{ color:"var(--text-3)", fontSize:13, padding:"30px 0", textAlign:"center" }}>Sem vendas no período.</div> :
        <ResponsiveContainer width="100%" height={300}>
          <LineChart data={serie} margin={{ top:6, right:12, left:0, bottom:0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID} vertical={false} />
            <XAxis dataKey="dia" tick={{ fill:CHART_AXIS, fontSize:11 }} tickLine={false} axisLine={{ stroke:CHART_GRID }} minTickGap={14} />
            <YAxis tick={{ fill:CHART_AXIS, fontSize:11 }} tickLine={false} axisLine={false} width={58} tickFormatter={function(v){ return "R$"+(Math.abs(v)>=1000?(v/1000).toFixed(0)+"k":v); }} />
            <RTooltip content={<TipMoeda />} />
            <Legend wrapperStyle={{ fontSize:12 }} />
            <Line type="monotone" dataKey="margem" name="Margem de Contribuição" stroke="#0a6b3b" strokeWidth={2.2} dot={false} />
            <Line type="monotone" dataKey="imposto" name="Impostos" stroke="#FF9800" strokeWidth={2} dot={false} />
            <Line type="monotone" dataKey="taxa" name="Taxa Marketplace" stroke="#768592" strokeWidth={2} dot={false} />
            <Line type="monotone" dataKey="freteMedio" name="Frete Médio" stroke="#EC4899" strokeWidth={2} dot={false} />
            <Line type="monotone" dataKey="ticketMedio" name="Ticket Médio" stroke="#38BDF8" strokeWidth={2} dot={false} />
          </LineChart>
        </ResponsiveContainer>}
      </ChartCard>
      <div style={{ marginTop:14, background:"var(--surface)", border:"1px solid var(--border)", borderRadius:12, padding:"16px 18px" }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", flexWrap:"wrap", gap:10, marginBottom:10 }}>
          <div style={{ fontWeight:500, fontSize:15, color:"var(--text-strong)" }}>Margem de contribuição por pedido</div>
          <BotoesExport nome="margem-por-pedido" colunas={cols} linhas={rowsExport} />
        </div>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", flexWrap:"wrap", gap:10, marginBottom:10 }}>
          <div style={{ display:"flex", gap:2, borderBottom:"1px solid var(--border)" }}>
            {abas.map(function(t){ var a=aba===t[0]; return <button key={t[0]} onClick={function(){ setAba(t[0]); setPagina(1); }}
              style={{ padding:"8px 16px", border:"none", borderBottom:a?"2px solid var(--ui-accent)":"2px solid transparent", marginBottom:-1, background:"transparent", color:a?"var(--text-strong)":"var(--text-3)", fontWeight:a?700:500, fontSize:13, cursor:"pointer" }}>{t[1]}</button>; })}
          </div>
          <input value={busca} onChange={function(e){ setBusca(e.target.value); setPagina(1); }} placeholder="Procurar por pedido ou produto..."
            style={{ background:"var(--surface)", border:"1px solid var(--border)", color:"var(--text-strong)", padding:"7px 10px", borderRadius:8, fontSize:12, minWidth:240 }} />
        </div>
        <div style={{ overflowX:"auto" }}>
          <table className="tabela">
            <thead><tr>{["Nº","ID Pedido","Marketplace","Data","Valor do Pedido","Valor Base","Custo","$ Taxa","% Taxa","Imposto","Frete Vend.","Frete Comp.","$ Contrib.","% Contrib."].map(function(h){ return <th key={h} className="th" style={{ whiteSpace:"nowrap" }}>{h}</th>; })}</tr></thead>
            <tbody>
              {slice.length===0 ? <tr><td className="td" colSpan={14}>Nenhum pedido.</td></tr> :
              slice.map(function(r,i){ var neg=r.contrib<0;
                return <tr key={r.id||i}>
                  <td className="td-num">{(pg-1)*POR+i+1}</td>
                  <td className="td-num">{r.id}</td>
                  <td className="td">Mercado Livre</td>
                  <td className="td">{fmtDate(r.data)||r.data}</td>
                  <td className="td-num">{fmt(r.valorPedido)}</td>
                  <td className="td-num">{fmt(r.valorBase)}</td>
                  <td className="td-num">{fmt(r.custo)}</td>
                  <td className="td-num">{fmt(r.taxa)}</td>
                  <td className="td">{pct1(r.taxaPct)}</td>
                  <td className="td-num">{fmt(r.imp)}</td>
                  <td className="td-num">{fmt(r.fv)}</td>
                  <td className="td-num">{fmt(r.fc)}</td>
                  <td className="td-num" style={{ fontWeight:500, color:neg?"#FF5252":"#0a9d4e" }}>{fmt(r.contrib)}</td>
                  <td className="td" style={{ fontWeight:500, color:neg?"#FF5252":"#0a9d4e" }}>{pct1(r.contribPct)}</td>
                </tr>;
              })}
            </tbody>
          </table>
        </div>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginTop:10, fontSize:12, color:"var(--text-3)" }}>
          <span>{filtradas.length===0?0:((pg-1)*POR+1)}–{Math.min(pg*POR,filtradas.length)} de {filtradas.length}</span>
          <div style={{ display:"flex", gap:6 }}>
            <button disabled={pg<=1} onClick={function(){ setPagina(pg-1); }} className="btn-exp" style={{ opacity:pg<=1?.5:1, cursor:pg<=1?"default":"pointer" }}>Anterior</button>
            <span style={{ alignSelf:"center" }}>Pág. {pg}/{totalPg}</span>
            <button disabled={pg>=totalPg} onClick={function(){ setPagina(pg+1); }} className="btn-exp" style={{ opacity:pg>=totalPg?.5:1, cursor:pg>=totalPg?"default":"pointer" }}>Próxima</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Sub-aba ESTOQUE DE PRODUTOS ──────────────────────────────────────────────
function EstoqueDash({ produtos }){
  const [busca,setBusca]=useState(""); const [pagina,setPagina]=useState(1); const [modo,setModo]=useState("todos");
  var lista=(produtos||[]).map(function(p){ var est=parseInt(p.estoqueAtual)||0, cu=parseFloat(p.precoCusto)||0, pv=parseFloat(p.precoVenda)||0;
    return { codigo:p.codigo||p.sku||p.id||"—", desc:nomeProd(p), est:est, custo:est*cu, valor:est*pv }; });
  if(busca.trim()){ var qq=busca.trim().toLowerCase(); lista=lista.filter(function(x){ return String(x.codigo).toLowerCase().indexOf(qq)>=0 || x.desc.toLowerCase().indexOf(qq)>=0; }); }
  var totEst=lista.reduce(function(s,x){return s+x.est;},0), totCusto=lista.reduce(function(s,x){return s+x.custo;},0), totValor=lista.reduce(function(s,x){return s+x.valor;},0);
  var POR=40, totalPg=Math.max(1,Math.ceil(lista.length/POR)), pg=Math.min(pagina,totalPg), slice=lista.slice((pg-1)*POR,pg*POR);
  var cols=["Código","Descrição","Estoque","Custo","Valor"];
  function rowsExport(){ return lista.map(function(x){ return [x.codigo, x.desc, x.est, x.custo.toFixed(2), x.valor.toFixed(2)]; }); }
  return (
    <div style={{ padding:2 }}>
      <div style={{ display:"flex", gap:14, flexWrap:"wrap", alignItems:"flex-start" }}>
        <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:12, padding:"16px 18px", flex:"1 1 520px", minWidth:340 }}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", flexWrap:"wrap", gap:10, marginBottom:12 }}>
            <div style={{ fontWeight:500, fontSize:15, color:"var(--text-strong)" }}>Tabela de Estoques — Todos</div>
            <div style={{ display:"flex", gap:4, background:"var(--surface-3)", borderRadius:8, padding:2 }}>
              {[["todos","Variações + Simples + Composições"],["produtos","Produtos"]].map(function(t){ var a=modo===t[0]; return <button key={t[0]} onClick={function(){ setModo(t[0]); }} style={{ padding:"6px 12px", borderRadius:7, border:"none", cursor:"pointer", fontSize:11.5, fontWeight:500, background:a?"var(--surface)":"transparent", color:a?"#0a9d4e":"var(--text-3)" }}>{t[1]}</button>; })}
            </div>
          </div>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", flexWrap:"wrap", gap:10, marginBottom:10 }}>
            <BotoesExport nome="estoque-produtos" colunas={cols} linhas={rowsExport} />
            <input value={busca} onChange={function(e){ setBusca(e.target.value); setPagina(1); }} placeholder="Procurar por código ou descrição..."
              style={{ background:"var(--surface)", border:"1px solid var(--border)", color:"var(--text-strong)", padding:"7px 10px", borderRadius:8, fontSize:12, minWidth:220 }} />
          </div>
          <div style={{ overflowX:"auto" }}>
            <table className="tabela">
              <thead><tr>{["Código","Descrição","Estoque","Custo","Valor"].map(function(h){ return <th key={h} className="th">{h}</th>; })}</tr></thead>
              <tbody>
                {slice.length===0 ? <tr><td className="td" style={{ textAlign:"center", padding:"32px 12px", color:"var(--text-3)" }} colSpan={5}>{(produtos||[]).length===0?"Nenhum produto cadastrado. Importe em Produtos.":"Nada encontrado."}</td></tr> :
                slice.map(function(x,i){ return <tr key={i}>
                  <td className="td-num">{x.codigo}</td>
                  <td className="td" style={{ maxWidth:360, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", color:"var(--text-strong)", fontWeight:500 }}>{x.desc}</td>
                  <td className="td" style={{ fontWeight:500 }}>{x.est}</td>
                  <td className="td-num">{fmt(x.custo)}</td>
                  <td className="td-num">{fmt(x.valor)}</td>
                </tr>; })}
              </tbody>
            </table>
          </div>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginTop:10, fontSize:12, color:"var(--text-3)" }}>
            <span>{lista.length} item(ns)</span>
            <div style={{ display:"flex", gap:6, alignItems:"center" }}>
              <button disabled={pg<=1} onClick={function(){ setPagina(pg-1); }} className="btn-exp" style={{ opacity:pg<=1?.5:1 }}>Anterior</button>
              <span>Pág. {pg}/{totalPg}</span>
              <button disabled={pg>=totalPg} onClick={function(){ setPagina(pg+1); }} className="btn-exp" style={{ opacity:pg>=totalPg?.5:1 }}>Próxima</button>
            </div>
          </div>
        </div>
        <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:12, padding:"16px 18px", flex:"1 1 280px", minWidth:260 }}>
          <div style={{ fontWeight:500, fontSize:15, color:"var(--text-strong)", marginBottom:12 }}>Estoque consolidado</div>
          <table className="tabela">
            <thead><tr>{["Depósito","Estoque","Custo","Valor"].map(function(h){ return <th key={h} className="th">{h}</th>; })}</tr></thead>
            <tbody>
              <tr>
                <td className="td" style={{ fontWeight:500, color:"var(--text-strong)" }}>Estoque geral</td>
                <td className="td" style={{ fontWeight:500 }}>{totEst}</td>
                <td className="td-num">{fmt(totCusto)}</td>
                <td className="td-num">{fmt(totValor)}</td>
              </tr>
            </tbody>
          </table>
          <div style={{ fontSize:11, color:"var(--text-3)", marginTop:10, lineHeight:1.5 }}>A separação por depósito (Distribue, Full, etc.) aparece aqui quando a integração de estoque por depósito for ativada. <b>Valor</b> = estoque × preço de venda; fica R$ 0,00 nos produtos sem preço de venda cadastrado.</div>
        </div>
      </div>
    </div>
  );
}

// ── Sub-aba CLIENTES (recorrentes × novos) ───────────────────────────────────
function ClientesDash({ enrichedOrders, user }){
  const [aba,setAba]=useState("recorrentes"); const [busca,setBusca]=useState(""); const [cliSel,setCliSel]=useState(null);
  var loja = (user && user.nickname) ? user.nickname : "Mercado Livre";
  var mapa={};
  (enrichedOrders||[]).filter(function(o){ return o.status!=="cancelled"; }).forEach(function(o){
    var chave=String(o.buyerDoc||o.buyerName||o.buyerEmail||o.id); var q=o.qty||1;
    var fat=(o.price||0)*q, custo=(o.cost||0)*q, contrib=fat-(o.fee||0)*q-(o.freteSeller||0)-custo-(o.imposto||0)*q;
    if(!mapa[chave]) mapa[chave]={ nome:o.buyerName||"Cliente ML", fone:o.buyerPhone||"", pedidos:0, produtos:0, valor:0, custo:0, lucro:0, ordens:[] };
    var c=mapa[chave]; c.pedidos+=1; c.produtos+=q; c.valor+=fat; c.custo+=custo; c.lucro+=contrib; if(!c.fone&&o.buyerPhone)c.fone=o.buyerPhone;
    c.ordens.push({ data:o.date, titulo:o.title||"—", valor:fat, lucro:contrib, qtd:q });
  });
  var clientes=Object.keys(mapa).map(function(k){ var c=mapa[k]; c.recorrente=c.pedidos>=2; c.margBruta=c.valor?(c.valor-c.custo)/c.valor*100:0; c.pctLucro=c.valor?c.lucro/c.valor*100:0; return c; });
  var rec=clientes.filter(function(c){return c.recorrente;}), nov=clientes.filter(function(c){return !c.recorrente;});
  var totGeral=clientes.reduce(function(s,c){return s+c.valor;},0)||1;
  function seg(arr){ var valor=arr.reduce(function(s,c){return s+c.valor;},0), ped=arr.reduce(function(s,c){return s+c.pedidos;},0), prod=arr.reduce(function(s,c){return s+c.produtos;},0);
    return { valor:valor, ticket:arr.length?valor/arr.length:0, produtos:ped?prod/ped:0, share:valor/totGeral*100, n:arr.length }; }
  var sRec=seg(rec), sNov=seg(nov);
  var donut=[{ name:"Recorrentes", value:rec.length, cor:"#768692" },{ name:"Novos", value:nov.length, cor:"#c2a878" }].filter(function(d){return d.value>0;});
  var alvo=(aba==="recorrentes"?rec:nov).slice().sort(function(a,b){return b.valor-a.valor;});
  if(busca.trim()){ var qq=busca.trim().toLowerCase(); alvo=alvo.filter(function(c){ return c.nome.toLowerCase().indexOf(qq)>=0; }); }
  var cols=["Nome","Loja","Produtos","Valor","Margem Bruta %","Lucro Venda","%","Celular"];
  function rowsExport(){ return alvo.map(function(c){ return [c.nome, loja, c.produtos, c.valor.toFixed(2), c.margBruta.toFixed(2)+"%", c.lucro.toFixed(2), c.pctLucro.toFixed(2)+"%", c.fone||"—"]; }); }
  function CardSeg(titulo, s, cor){ return <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:12, padding:"16px 18px", flex:"1 1 260px", minWidth:240 }}>
    <div style={{ textAlign:"center", fontWeight:600, fontSize:16, color:"var(--text-strong)" }}>{titulo}</div>
    <div style={{ textAlign:"center", fontWeight:600, fontSize:22, color:cor, margin:"4px 0 12px" }}>{fmt(s.valor)}</div>
    <div style={{ display:"flex", justifyContent:"space-around", textAlign:"center", gap:8 }}>
      <div><div style={{ fontWeight:600, color:"var(--text-strong)", fontSize:15 }}>{fmt(s.ticket)}</div><div style={{ fontSize:10, color:"var(--text-3)", textTransform:"none" }}>Ticket médio</div></div>
      <div><div style={{ fontWeight:600, color:"var(--text-strong)", fontSize:15 }}>{s.produtos.toFixed(2).replace(".",",")}</div><div style={{ fontSize:10, color:"var(--text-3)", textTransform:"none" }}>Produtos</div></div>
      <div><div style={{ fontWeight:600, color:"var(--text-strong)", fontSize:15 }}>{pct1(s.share)}</div><div style={{ fontSize:10, color:"var(--text-3)", textTransform:"none" }}>Share</div></div>
    </div>
    <div style={{ textAlign:"center", fontSize:11, color:"var(--text-3)", marginTop:8 }}>{s.n} cliente(s)</div>
  </div>; }
  return (
    <div style={{ padding:2 }}>
      <div style={{ fontWeight:600, fontSize:20, color:"var(--text-strong)" }}>Clientes</div>
      <div style={{ fontSize:13, color:"var(--text-3)", marginBottom:14 }}>Recorrentes (2+ pedidos) e novos (1 pedido), com faturamento e margem.</div>
      <div style={{ display:"flex", gap:14, flexWrap:"wrap", marginBottom:16 }}>
        {CardSeg("Clientes Recorrentes", sRec, "var(--ui-accent)")}
        {CardSeg("Clientes Novos", sNov, "var(--ui-accent)")}
        <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:12, padding:"16px 18px", flex:"1 1 300px", minWidth:280 }}>
          <div style={{ fontWeight:500, fontSize:15, color:"var(--text-strong)", marginBottom:6 }}>Recorrentes × Novos</div>
          {donut.length===0 ? <div style={{ color:"var(--text-3)", fontSize:13 }}>Sem clientes.</div> :
          <ResponsiveContainer width="100%" height={190}>
            <PieChart>
              <Pie data={donut} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={78} label={function(e){ return e.value; }} stroke="none">
                {donut.map(function(d,i){ return <Cell key={i} fill={d.cor} />; })}
              </Pie>
              <RTooltip formatter={function(v,n){ return [v+" cliente(s)", n]; }} />
              <Legend wrapperStyle={{ fontSize:12 }} />
            </PieChart>
          </ResponsiveContainer>}
        </div>
      </div>
      <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:12, padding:"16px 18px" }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", flexWrap:"wrap", gap:10, marginBottom:10 }}>
          <div style={{ display:"flex", gap:2, borderBottom:"1px solid var(--border)" }}>
            {[["recorrentes","Clientes Recorrentes"],["novos","Clientes Novos"]].map(function(t){ var a=aba===t[0]; return <button key={t[0]} onClick={function(){ setAba(t[0]); }}
              style={{ padding:"8px 16px", border:"none", borderBottom:a?"2px solid var(--ui-accent)":"2px solid transparent", marginBottom:-1, background:"transparent", color:a?"var(--text-strong)":"var(--text-3)", fontWeight:a?700:500, fontSize:13, cursor:"pointer" }}>{t[1]}</button>; })}
          </div>
          <BotoesExport nome="clientes" colunas={cols} linhas={rowsExport} />
        </div>
        <input value={busca} onChange={function(e){ setBusca(e.target.value); }} placeholder="Procurar cliente..."
          style={{ background:"var(--surface)", border:"1px solid var(--border)", color:"var(--text-strong)", padding:"7px 10px", borderRadius:8, fontSize:12, minWidth:240, marginBottom:10 }} />
        <div style={{ overflowX:"auto" }}>
          <table className="tabela">
            <thead><tr>{["Nome","Loja","Produtos","Valor","Margem Bruta %","Lucro Venda","%","Celular","Histórico"].map(function(h){ return <th key={h} className="th" style={{ whiteSpace:"nowrap" }}>{h}</th>; })}</tr></thead>
            <tbody>
              {alvo.length===0 ? <tr><td className="td" colSpan={9}>Nenhum cliente.</td></tr> :
              alvo.slice(0,300).map(function(c,i){ return <tr key={i}>
                <td className="td" style={{ fontWeight:600, color:"var(--text-strong)", maxWidth:260, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{c.nome}</td>
                <td className="td">{loja}</td>
                <td className="td">{c.produtos}</td>
                <td className="td-num">{fmt(c.valor)}</td>
                <td className="td">{pct1(c.margBruta)}</td>
                <td className="td-num" style={{ fontWeight:500, color:c.lucro>=0?"#0a9d4e":"#FF5252" }}>{fmt(c.lucro)}</td>
                <td className="td" style={{ color:c.pctLucro>=0?"#0a9d4e":"#FF5252" }}>{pct1(c.pctLucro)}</td>
                <td className="td">{c.fone||"—"}</td>
                <td className="td"><button onClick={function(){ setCliSel(c); }} className="btn-exp" style={{ padding:"5px 10px" }}>Ver Pedidos</button></td>
              </tr>; })}
            </tbody>
          </table>
        </div>
      </div>
      {cliSel && <>
        <div onClick={function(){ setCliSel(null); }} style={{ position:"fixed", inset:0, background:"rgba(0,0,0,.4)", zIndex:400 }} />
        <div style={{ position:"fixed", top:0, right:0, bottom:0, width:440, maxWidth:"100vw", background:"var(--bg-2)", borderLeft:"1px solid var(--border)", boxShadow:"-8px 0 32px rgba(0,0,0,.28)", zIndex:401, overflowY:"auto", padding:"22px 24px" }}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", gap:12, marginBottom:4 }}>
            <div style={{ fontWeight:600, fontSize:17, color:"var(--text-strong)" }}>{cliSel.nome}</div>
            <button onClick={function(){ setCliSel(null); }} style={{ background:"none", border:"none", color:"var(--text-3)", fontSize:22, cursor:"pointer" }}>×</button>
          </div>
          <div style={{ fontSize:12, color:"var(--text-3)", marginBottom:14 }}>{cliSel.pedidos} pedido(s) · {fmt(cliSel.valor)} · {cliSel.fone||"sem telefone"}</div>
          {cliSel.ordens.slice().sort(function(a,b){return (b.data||"").localeCompare(a.data||"");}).map(function(od,i){ return <div key={i} style={{ padding:"10px 0", borderBottom:"1px solid var(--border-soft)" }}>
            <div style={{ fontSize:12, color:"var(--text-2)", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{od.titulo}</div>
            <div style={{ display:"flex", justifyContent:"space-between", marginTop:3, fontSize:12 }}>
              <span style={{ color:"var(--text-3)" }}>{fmtDate(od.data)||od.data} · {od.qtd}×</span>
              <span style={{ color:"var(--text-strong)", fontWeight:500 }}>{fmt(od.valor)} <span style={{ color:od.lucro>=0?"#0a9d4e":"#FF5252" }}>({fmt(od.lucro)})</span></span>
            </div>
          </div>; })}
        </div>
      </>}
    </div>
  );
}

// ── Sub-aba CURVA ABC ────────────────────────────────────────────────────────
function CurvaAbcDash({ enrichedOrders }){
  const [periodo,setPeriodo]=useState("mesatual"); const [deData,setDeData]=useState(function(){ return presetRange("mesatual").de; }); const [ateData,setAteData]=useState(function(){ return presetRange("mesatual").ate; });
  const [aberto,setAberto]=useState({ A:true, B:false, C:false });
  var base=filtrarPeriodo(enrichedOrders, periodo, deData, ateData);
  var abc=curvaABC(base);
  var grupos={ A:[], B:[], C:[] }; abc.forEach(function(x){ grupos[x.classe].push(x); });
  var soma=function(arr){ return arr.reduce(function(s,x){ return s+x.fat; }, 0); };
  var totFat=soma(abc)||1;
  var cor={ A:"#768692", B:"#c2a878", C:"#3a4550" };
  var donut=[{ name:"Curva A", value:soma(grupos.A), cor:cor.A },{ name:"Curva B", value:soma(grupos.B), cor:cor.B },{ name:"Curva C", value:soma(grupos.C), cor:cor.C }].filter(function(d){ return d.value>0; });
  function Accordion(classe){
    var arr=grupos[classe], ab=aberto[classe];
    return <div style={{ borderBottom:"1px solid var(--border-soft)" }}>
      <button onClick={function(){ setAberto(function(s){ var n=Object.assign({},s); n[classe]=!n[classe]; return n; }); }}
        style={{ width:"100%", display:"flex", justifyContent:"space-between", alignItems:"center", padding:"12px 4px", background:"none", border:"none", cursor:"pointer" }}>
        <span style={{ fontWeight:600, fontSize:15, color:cor[classe] }}>Curva {classe} <span style={{ color:"var(--text-3)", fontWeight:600, fontSize:12 }}>· {arr.length} SKU(s) · {fmt(soma(arr))}</span></span>
        <span style={{ color:cor[classe], fontSize:14 }}>{ab?"▲":"▼"}</span>
      </button>
      {ab && <div style={{ overflowX:"auto", paddingBottom:8 }}>
        <table className="tabela">
          <thead><tr>{["Produto","Qtd","Faturamento","% acum."].map(function(h){ return <th key={h} className="th">{h}</th>; })}</tr></thead>
          <tbody>
            {arr.length===0 ? <tr><td className="td" colSpan={4}>Sem produtos.</td></tr> :
            arr.map(function(x,i){ return <tr key={i}>
              <td className="td" style={{ maxWidth:380, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", color:"var(--text-strong)" }}>{x.titulo}</td>
              <td className="td">{x.qtd}</td>
              <td className="td-num">{fmt(x.fat)}</td>
              <td className="td">{x.pctAcc.toFixed(1)}%</td>
            </tr>; })}
          </tbody>
        </table>
      </div>}
    </div>;
  }
  return (
    <div style={{ padding:2 }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", flexWrap:"wrap", gap:10, marginBottom:14 }}>
        <div><div style={{ fontWeight:600, fontSize:20, color:"var(--text-strong)" }}>Curva ABC</div>
          <div style={{ fontSize:13, color:"var(--text-3)" }}>A = 80% do faturamento · B = próximos 15% · C = os 5% restantes.</div></div>
        <BarraPeriodo periodo={periodo} setPeriodo={setPeriodo} deData={deData} setDeData={setDeData} ateData={ateData} setAteData={setAteData} />
      </div>
      <div style={{ display:"flex", gap:14, flexWrap:"wrap", marginBottom:14 }}>
        <ChartCard titulo="Gráfico da Curva ABC" sub="Faturamento por classe" minW={340} flex={1.6}>
          {donut.length===0 ? <div style={{ color:"var(--text-3)", fontSize:13, padding:"30px 0", textAlign:"center" }}>Sem vendas no período.</div> :
          <ResponsiveContainer width="100%" height={260}>
            <PieChart>
              <Pie data={donut} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={100}
                label={function(e){ return pct1(e.value/totFat*100); }} stroke="none">
                {donut.map(function(d,i){ return <Cell key={i} fill={d.cor} />; })}
              </Pie>
              <RTooltip content={<TipMoeda />} />
              <Legend wrapperStyle={{ fontSize:12 }} />
            </PieChart>
          </ResponsiveContainer>}
        </ChartCard>
        <div style={{ display:"flex", flexDirection:"column", gap:12, flex:"1 1 220px", minWidth:200 }}>
          {["A","B","C"].map(function(cl){ return <div key={cl} style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:12, padding:"16px 18px", display:"flex", alignItems:"center", gap:12 }}>
            <div style={{ width:34, height:34, borderRadius:9, background:cor[cl], display:"flex", alignItems:"center", justifyContent:"center", color:"#fff", fontWeight:600 }}>{cl}</div>
            <div><div style={{ fontSize:12, color:"var(--text-3)" }}>Curva {cl}</div><div style={{ fontSize:18, fontWeight:600, color:"var(--text-strong)" }}>{grupos[cl].length} SKUs</div></div>
          </div>; })}
        </div>
      </div>
      <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:12, padding:"8px 18px" }}>
        <div style={{ fontWeight:500, fontSize:15, color:"var(--text-strong)", padding:"10px 4px 4px" }}>Curva ABC — produtos</div>
        {Accordion("A")}{Accordion("B")}{Accordion("C")}
      </div>
    </div>
  );
}

// ── Sub-aba METAS ────────────────────────────────────────────────────────────
function MetasDash({ metas, salvar, enrichedOrders }){
  const [f,setF]=useState({ nome:"", inicio:"", conclusao:"", segmentacao:"", valor:"" });
  function set(k,v){ setF(function(s){ var n=Object.assign({},s); n[k]=v; return n; }); }
  function add(){
    if(!f.nome.trim()){ alert("Informe o nome da meta."); return; }
    if(!f.valor){ alert("Informe o valor da meta."); return; }
    var nova={ id:"meta_"+Date.now(), nome:f.nome.trim(), inicio:f.inicio, conclusao:f.conclusao, segmentacao:f.segmentacao.trim(), valor:parseFloat(String(f.valor).replace(",","."))||0 };
    salvar([nova].concat(metas||[]));
    setF({ nome:"", inicio:"", conclusao:"", segmentacao:"", valor:"" });
  }
  function excluir(id){ if(!window.confirm("Excluir esta meta?")) return; salvar((metas||[]).filter(function(m){ return m.id!==id; })); }
  function realizado(m){
    var ini=m.inicio||"0000-00-00", fim=m.conclusao||"9999-12-31", seg=(m.segmentacao||"").toLowerCase();
    if(seg.indexOf("shopee")>=0) return 0; // ainda sem vendas Shopee
    return (enrichedOrders||[]).filter(function(o){ if(o.status==="cancelled") return false; var dt=(o.date||"").slice(0,10); return dt>=ini && dt<=fim; })
      .reduce(function(s,o){ return s+(o.price||0)*(o.qty||1); }, 0);
  }
  var lbl={ display:"block", fontSize:11, color:"var(--text-3)", fontWeight:600, marginBottom:4, textTransform:"none", letterSpacing:.4 };
  var campo={ width:"100%", background:"var(--surface)", border:"1px solid var(--border)", color:"var(--text-strong)", padding:"9px 10px", borderRadius:8, fontSize:13 };
  return (
    <div style={{ padding:2 }}>
      <div style={{ fontWeight:600, fontSize:20, color:"var(--text-strong)" }}>Metas</div>
      <div style={{ fontSize:13, color:"var(--text-3)", marginBottom:14 }}>Defina metas de faturamento e acompanhe o realizado do período.</div>
      <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:12, padding:"16px 18px", marginBottom:16 }}>
        <div style={{ fontWeight:500, fontSize:14, color:"var(--text-strong)", marginBottom:12 }}>Nova meta</div>
        <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit, minmax(160px, 1fr))", gap:12, alignItems:"end" }}>
          <div style={{ gridColumn:"span 2", minWidth:200 }}><label style={lbl}>Nome da meta</label><input value={f.nome} onChange={function(e){ set("nome", e.target.value); }} placeholder="Ex.: Faturamento agosto" style={campo} /></div>
          <div><label style={lbl}>Data de início</label><input type="date" value={f.inicio} onChange={function(e){ set("inicio", e.target.value); }} style={campo} /></div>
          <div><label style={lbl}>Data de conclusão</label><input type="date" value={f.conclusao} onChange={function(e){ set("conclusao", e.target.value); }} style={campo} /></div>
          <div><label style={lbl}>Segmentação</label>
            <input list="dl-seg" value={f.segmentacao} onChange={function(e){ set("segmentacao", e.target.value); }} placeholder="Geral" style={campo} />
            <datalist id="dl-seg"><option value="Geral" /><option value="Mercado Livre" /><option value="Shopee" /><option value="Por estado" /><option value="Por produto" /></datalist>
          </div>
          <div><label style={lbl}>Valor da meta (R$)</label><input type="number" step="0.01" value={f.valor} onChange={function(e){ set("valor", e.target.value); }} placeholder="0,00" style={campo} /></div>
          <div><button onClick={add} style={{ width:"100%", background:"#768692", border:"none", color:"#fff", fontWeight:500, padding:"10px", borderRadius:8, cursor:"pointer", fontSize:13 }}>+ Adicionar meta</button></div>
        </div>
      </div>
      {(metas||[]).length===0 ? (
        <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:12, padding:"32px 18px", textAlign:"center", color:"var(--text-3)", fontSize:13 }}>Nenhuma meta cadastrada ainda. Crie a primeira acima.</div>
      ) : (
        <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit, minmax(320px, 1fr))", gap:12 }}>
          {(metas||[]).map(function(m){
            var real=realizado(m), pctv=m.valor?Math.min(100, real/m.valor*100):0, bateu=real>=m.valor && m.valor>0;
            return <div key={m.id} style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:12, padding:"16px 18px" }}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", gap:10 }}>
                <div style={{ fontWeight:500, fontSize:15, color:"var(--text-strong)" }}>{m.nome}</div>
                <button onClick={function(){ excluir(m.id); }} title="Excluir" style={{ background:"none", border:"none", color:"var(--text-3)", cursor:"pointer", fontSize:14 }}>✕</button>
              </div>
              <div style={{ fontSize:12, color:"var(--text-3)", marginTop:2 }}>
                {(m.inicio? (fmtDate(m.inicio)||m.inicio) : "—")} até {(m.conclusao? (fmtDate(m.conclusao)||m.conclusao) : "—")}{m.segmentacao ? " · "+m.segmentacao : ""}
              </div>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"baseline", margin:"12px 0 6px" }}>
                <span style={{ fontSize:20, fontWeight:600, color:"var(--text-strong)" }}>{fmt(real)}</span>
                <span style={{ fontSize:12, color:"var(--text-3)" }}>de {fmt(m.valor)}</span>
              </div>
              <div style={{ height:10, borderRadius:6, background:"var(--surface-3)", overflow:"hidden" }}>
                <div style={{ width:pctv+"%", height:"100%", background: bateu?"#0a9d4e":"#768692", transition:"width .3s" }} />
              </div>
              <div style={{ display:"flex", justifyContent:"space-between", marginTop:6, fontSize:12 }}>
                <span style={{ color: bateu?"#0a9d4e":"var(--text-2)", fontWeight:500 }}>{pct1(m.valor?real/m.valor*100:0)}</span>
                <span style={{ color:"var(--text-3)" }}>{bateu ? "🎯 Meta batida!" : "Faltam "+fmt(Math.max(0, m.valor-real))}</span>
              </div>
            </div>;
          })}
        </div>
      )}
    </div>
  );
}

// Wrapper do Dashboard: barra de sub-abas + conteúdo.
// Tela inicial (menu inicial): boas-vindas + resumo do mês + atalhos para todas as seções.
function HomeTab({ enrichedOrders, currentUser, setTab }){
  var perm = currentUser?.permissoes || [];
  var mesAtual = new Date().toISOString().slice(0,7);
  var fat=0, lucro=0, nped=0;
  (enrichedOrders||[]).forEach(function(o){
    if (o.status==="cancelled") return;
    if ((o.date||"").slice(0,7) !== mesAtual) return;
    var q=o.qty||1; fat+=(o.price||0)*q; lucro+=(o.profit||0)*q; nped+=1;
  });
  var resumo = [
    { l:"Faturamento do mês", v:fmt(fat), c:"var(--text-strong)" },
    { l:"Lucro do mês", v:fmt(lucro), c: lucro>=0?"#0a9d4e":"#FF5252" },
    { l:"Pedidos no mês", v:String(nped), c:"var(--text-strong)" },
  ];
  var grupos = [
    { titulo:"Dashboard", itens:[
      { key:"dashboard", label:"Dashboard", desc:"Visão geral, estados, margem, clientes, curva ABC e metas" },
    ]},
    { titulo:"Operação", itens:[
      { key:"produtos", label:"Produtos", desc:"Cadastro e catálogo de produtos" },
      perm.includes("listings") && { key:"listings", label:"Anúncios", desc:"Anúncios do Mercado Livre" },
      { key:"vincular", label:"Vincular anúncios", desc:"Ligar anúncios aos produtos" },
      perm.includes("listings") && { key:"precificacao", label:"Precificação", desc:"Preços, taxas e margem" },
      perm.includes("orders") && { key:"orders", label:"Vendas", desc:"Pedidos e margem por venda" },
      { key:"expedicao", label:"Expedição", desc:"Status de envio dos pedidos" },
      { key:"compras", label:"Compras", desc:"Pedidos de compra e reposição" },
      { key:"estoque", label:"Estoque", desc:"Saldo e estoque mínimo" },
      { key:"notas_fiscais", label:"Notas fiscais", desc:"Emissão e consulta" },
    ]},
    { titulo:"Financeiro", itens:[
      { key:"fluxo_caixa", label:"Fluxo de caixa", desc:"Saldo projetado dia a dia" },
      { key:"contas_pagar", label:"Contas a pagar", desc:"Despesas e vencimentos" },
      { key:"prioridade_pagamento", label:"Prioridade de pagamento", desc:"Que contas pagar primeiro com o caixa que você tem" },
      { key:"contas_receber", label:"Contas a receber", desc:"Recebíveis dos marketplaces" },
      { key:"bancos", label:"Caixas e bancos", desc:"Onde o dinheiro está e quanto tem" },
      { key:"lancamentos", label:"Lançamentos", desc:"Extrato de tudo o que entrou e saiu" },
      { key:"dre", label:"DRE e conciliação", desc:"Demonstrativo de resultado" },
      { key:"conciliacao", label:"Conciliação", desc:"O que caiu na conta x o que o sistema espera" },
      { key:"impostos", label:"Impostos", desc:"ICMS por destino, IRPJ, CSLL e custos fixos" },
    ]},
    { titulo:"Cadastro", itens:[
      { key:"clientes", label:"Clientes", desc:"Recorrentes e novos" },
      { key:"fornecedores", label:"Fornecedores", desc:"Cadastro de fornecedores" },
    ]},
    { titulo:"Inteligência", itens:[
      { key:"tendencias", label:"Tendências", desc:"O que cada categoria vendeu, contra o período anterior" },
      { key:"relatorios", label:"Relatórios", desc:"Análises e curva ABC" },
      perm.includes("listings") && { key:"concorrencia", label:"Concorrência", desc:"Vigia de preços" },
    ]},
    { titulo:"Configuração", itens:[
      perm.includes("admin") && { key:"admin", label:"Equipe", desc:"Usuários e permissões" },
      { key:"analise_ia", label:"Análise de anúncios", desc:"Critérios da nota e regras para a IA" },
      { key:"integracoes", label:"Integrações", desc:"Conexões e marketplaces" },
    ]},
  ];
  return (
    <div style={{ padding:2 }}>
      <div style={{ marginTop:6 }}>
        <div style={{ fontWeight:600, fontSize:24, color:"var(--text-strong)", letterSpacing:-0.3 }}>Olá, {currentUser?.nome || "bem-vindo"}</div>
        <div style={{ fontSize:14, color:"var(--text-3)", marginTop:2 }}>Bem-vindo ao Flow Marketplaces. Escolha por onde começar.</div>
      </div>
    </div>
  );
}

function DashboardTab({ enrichedOrders, produtos, user, metas, salvarMetas, sub, setSub }){
  var subs=[["geral","Visão geral"],["estados","Estados"],["margem","Margem por pedido"],["estoque","Estoque de produtos"],["clientes","Clientes"],["abc","Curva ABC"],["metas","Metas"]];
  return (
    <div style={{ padding:"2px" }}>
      <div style={{ display:"flex", gap:2, borderBottom:"2px solid var(--border)", marginBottom:14, overflowX:"auto" }}>
        {subs.map(function(t){ var a=sub===t[0]; return <button key={t[0]} onClick={function(){ setSub(t[0]); }}
          style={{ padding:"10px 16px", border:"none", borderBottom:a?"2px solid #768692":"2px solid transparent", marginBottom:-2, background:"transparent", color:a?"var(--text-strong)":"var(--text-3)", fontWeight:a?700:500, fontSize:13, cursor:"pointer", whiteSpace:"nowrap", fontFamily:"inherit" }}>{t[1]}</button>; })}
      </div>
      {sub==="geral" && <DashboardGeral enrichedOrders={enrichedOrders} />}
      {sub==="estados" && <EstadosDash enrichedOrders={enrichedOrders} />}
      {sub==="margem" && <MargemPedidoDash enrichedOrders={enrichedOrders} />}
      {sub==="estoque" && <EstoqueDash produtos={produtos} />}
      {sub==="clientes" && <ClientesDash enrichedOrders={enrichedOrders} user={user} />}
      {sub==="abc" && <CurvaAbcDash enrichedOrders={enrichedOrders} />}
      {sub==="metas" && <MetasDash metas={metas} salvar={salvarMetas} enrichedOrders={enrichedOrders} />}
    </div>
  );
}

function DashboardGeral({ enrichedOrders }) {
  const [periodo, setPeriodo] = useState("30"); // hoje | 7 | 30 | mesatual | custom
  const [deData, setDeData] = useState(function(){ return presetRange("30").de; });
  const [ateData, setAteData] = useState(function(){ return presetRange("30").ate; });
  const [marketplace, setMarketplace] = useState("todos"); // todos | ml | shopee
  const hojeStr = new Date().toISOString().slice(0, 10);
  var cutoff = "0000-00-00";
  if (periodo === "7" || periodo === "30") {
    var d = new Date(); d.setDate(d.getDate() - parseInt(periodo, 10));
    cutoff = d.toISOString().slice(0, 10);
  }
  function noPeriodo(dt){
    if (!dt) return false;
    if (periodo === "hoje") return dt === hojeStr;
    if (periodo === "mesatual") return dt.slice(0, 7) === hojeStr.slice(0, 7);
    if (periodo === "custom") {
      if (deData && dt < deData) return false;
      if (ateData && dt > ateData) return false;
      return true;
    }
    return dt >= cutoff; // 7 | 30 dias
  }
  function noCanal(o){
    if (marketplace === "todos") return true;
    var mk = o.marketplace || "ml"; // hoje todos os pedidos são do Mercado Livre
    return mk === marketplace;
  }
  var validos = (enrichedOrders || []).filter(function(o){
    return o.status !== "cancelled" && noPeriodo((o.date || "").slice(0, 10)) && noCanal(o);
  });
  var fat = 0, taxas = 0, impostos = 0, custo = 0, lucro = 0, frete = 0, totalQtd = 0, porProduto = {};
  validos.forEach(function(o){
    var q = o.qty || 1;
    var lucroPed = (o.profit || 0) * q;
    fat += (o.price || 0) * q; taxas += (o.fee || 0) * q; impostos += (o.imposto || 0) * q;
    custo += (o.cost || 0) * q; lucro += lucroPed; frete += (o.freteSeller || 0); totalQtd += q;
    var k = o.listing_id || o.title || "?";
    if (!porProduto[k]) porProduto[k] = { titulo: o.title || k, lucro: 0, qtd: 0 };
    porProduto[k].lucro += lucroPed; porProduto[k].qtd += q;
  });
  var nPed = validos.length;
  var fatLiq = fat - taxas - frete;              // faturamento líquido = bruto − taxas de venda − frete grátis pago pelo vendedor
  var ticket = nPed ? fat / nPed : 0;
  var margem = fat ? (lucro / fat * 100) : 0;
  var kpis = [
    { l:"Faturamento bruto", v:fmt(fat), c:"var(--text-strong)" },
    { l:"Faturamento líquido", v:fmt(fatLiq), c:"var(--text-strong)", sub:"após taxas de venda e frete grátis" },
    { l:"Lucro líquido", v:fmt(lucro), c: lucro >= 0 ? "#0a9d4e" : "#FF5252" },
    { l:"Margem", v:margem.toFixed(1) + "%", c: margem >= 0 ? "#0a9d4e" : "#FF5252" },
    { l:"Pedidos", v:String(nPed), c:"var(--text-strong)" },
    { l:"Produtos vendidos", v:String(totalQtd), c:"var(--text-strong)" },
    { l:"Ticket médio", v:fmt(ticket), c:"var(--text-strong)" },
    { l:"Taxas do marketplace", v:"- " + fmt(taxas), c:"var(--kpi-neg)" },
    { l:"Frete grátis (seu custo)", v:"- " + fmt(frete), c:"var(--kpi-neg)" },
    { l:"Impostos", v:"- " + fmt(impostos), c:"var(--kpi-neg)" },
    { l:"Custo dos produtos", v:"- " + fmt(custo), c:"var(--kpi-neg)" },
  ];
  var periodos = [["hoje","Hoje"],["7","7 dias"],["30","30 dias"],["mesatual","Mês atual"]];
  var _inpData = { background:"var(--surface)", border:"1px solid var(--border)", color:"var(--text-2)", padding:"6px 8px", borderRadius:8, fontSize:12, colorScheme:"inherit" };
  return (
    <div style={{ padding:"2px" }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", flexWrap:"wrap", gap:10, marginBottom:16 }}>
        <div>
          <div style={{ fontWeight:600, fontSize:20, color:"var(--text-strong)" }}>Dashboard</div>
          <div style={{ fontSize:13, color:"var(--text-3)" }}>Faturamento bruto e líquido, taxas, frete, impostos e lucro real do período.</div>
        </div>
        <div style={{ display:"flex", gap:6, alignItems:"center", flexWrap:"wrap", justifyContent:"flex-end" }}>
          {periodos.map(function(p){
            var ativo = periodo === p[0];
            return <button key={p[0]} onClick={function(){ var r=presetRange(p[0]); setPeriodo(p[0]); setDeData(r.de); setAteData(r.ate); }}
              style={{ padding:"7px 14px", borderRadius:8, border:"1px solid var(--border)", cursor:"pointer", fontSize:12, fontWeight:600,
                background: ativo ? "#768692" : "var(--surface)", color: ativo ? "#fff" : "var(--text-3)" }}>{p[1]}</button>;
          })}
          {/* Intervalo personalizado De/Até */}
          <div style={{ display:"flex", alignItems:"center", gap:5, padding:"4px 8px", borderRadius:8, border:"1px solid var(--border)", background: periodo==="custom" ? "rgba(118,134,146,.10)" : "var(--surface)" }}>
            <input type="date" value={deData} max={ateData || undefined}
              onChange={function(e){ setDeData(e.target.value); setPeriodo("custom"); }}
              title="Data inicial" style={_inpData} />
            <span style={{ fontSize:11, color:"var(--text-3)" }}>até</span>
            <input type="date" value={ateData} min={deData || undefined}
              onChange={function(e){ setAteData(e.target.value); setPeriodo("custom"); }}
              title="Data final" style={_inpData} />
            {periodo==="custom" && (
              <button onClick={function(){ var r=presetRange("30"); setPeriodo("30"); setDeData(r.de); setAteData(r.ate); }}
                title="Voltar para 30 dias" style={{ background:"none", border:"none", color:"var(--text-3)", cursor:"pointer", fontSize:14, padding:"0 2px" }}>✕</button>
            )}
          </div>
          {/* Marketplace */}
          <select value={marketplace} onChange={function(e){ setMarketplace(e.target.value); }}
            title="Filtrar por marketplace"
            style={{ padding:"7px 10px", borderRadius:8, border:"1px solid var(--border)", background:"var(--surface)", color:"var(--text-2)", fontSize:12, fontWeight:600, cursor:"pointer" }}>
            <option value="todos">Todos os canais</option>
            <option value="ml">Mercado Livre</option>
            <option value="shopee">Shopee</option>
          </select>
        </div>
      </div>
      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit, minmax(180px, 1fr))", gap:12, marginBottom:20 }}>
        {kpis.map(function(k,i){
          return <div key={i} className="kpi-card">
            <div className="kpi-lbl">{k.l}</div>
            <div style={{ fontSize:22, fontWeight:600, color:k.c, marginTop:6 }}>{k.v}</div>
            {k.sub && <div style={{ fontSize:10, color:"var(--kpi-sub)", marginTop:3, fontWeight:500 }}>{k.sub}</div>}
          </div>;
        })}
      </div>
      {(function(){
        var arr = Object.keys(porProduto).map(function(k){ return porProduto[k]; });
        var topP = arr.slice().sort(function(a,b){ return b.lucro - a.lucro; }).slice(0, 8);
        var piores = arr.slice().sort(function(a,b){ return a.lucro - b.lucro; }).slice(0, 8);
        var serieDia = agrupaPorDia(validos);
        var dinheiro = [
          { name:"Custo produto", value:Math.max(0,custo), cor:CORES_DINHEIRO.custo },
          { name:"Taxas", value:Math.max(0,taxas), cor:CORES_DINHEIRO.taxas },
          { name:"Frete grátis", value:Math.max(0,frete), cor:"#f5872e" },
          { name:"Impostos", value:Math.max(0,impostos), cor:CORES_DINHEIRO.impostos },
          { name:"Lucro", value:Math.max(0,lucro), cor:CORES_DINHEIRO.lucro },
        ].filter(function(d){ return d.value > 0; });
        function listaProd(titulo, itens){
          return <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:12, padding:"16px 18px", flex:1, minWidth:280 }}>
            <div style={{ fontWeight:500, fontSize:15, color:"var(--text-strong)", marginBottom:12 }}>{titulo}</div>
            {itens.length === 0 ? <div style={{ color:"var(--text-3)", fontSize:13 }}>Sem vendas no período.</div> :
              itens.map(function(p,i){ return <div key={i} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"8px 0", borderBottom: i < itens.length-1 ? "1px solid var(--border-soft)" : "none" }}>
                <div style={{ minWidth:0, flex:1, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", fontSize:13, color:"var(--text-2)" }}>{p.titulo}</div>
                <span style={{ fontSize:13, fontWeight:500, color: p.lucro >= 0 ? "#0a9d4e" : "#FF5252", flexShrink:0, marginLeft:12 }}>{fmt(p.lucro)}</span>
              </div>; })}
          </div>;
        }
        return <>
          <div style={{ display:"flex", gap:14, flexWrap:"wrap", marginBottom:14 }}>
            <ChartCard titulo="Faturamento × lucro por dia" sub="Evolução diária no período" minW={360} flex={1.7}>
              {serieDia.length === 0 ? <div style={{ color:"var(--text-3)", fontSize:13, padding:"30px 0", textAlign:"center" }}>Sem vendas no período.</div> :
              <ResponsiveContainer width="100%" height={240}>
                <AreaChart data={serieDia} margin={{ top:6, right:10, left:0, bottom:0 }}>
                  <defs>
                    <linearGradient id="dFat" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#768692" stopOpacity={.35}/><stop offset="100%" stopColor="#768692" stopOpacity={0}/></linearGradient>
                    <linearGradient id="dLucro" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#0a9d4e" stopOpacity={.35}/><stop offset="100%" stopColor="#0a9d4e" stopOpacity={0}/></linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID} vertical={false} />
                  <XAxis dataKey="dia" tick={{ fill:CHART_AXIS, fontSize:11 }} tickLine={false} axisLine={{ stroke:CHART_GRID }} minTickGap={16} />
                  <YAxis tick={{ fill:CHART_AXIS, fontSize:11 }} tickLine={false} axisLine={false} width={54} tickFormatter={function(v){ return "R$"+(v>=1000?(v/1000).toFixed(0)+"k":v); }} />
                  <RTooltip content={<TipMoeda />} />
                  <Legend wrapperStyle={{ fontSize:12 }} />
                  <Area type="monotone" dataKey="fat" name="Faturamento" stroke="#768692" strokeWidth={2} fill="url(#dFat)" />
                  <Area type="monotone" dataKey="lucro" name="Lucro" stroke="#0a9d4e" strokeWidth={2} fill="url(#dLucro)" />
                </AreaChart>
              </ResponsiveContainer>}
            </ChartCard>
            <ChartCard titulo="Para onde foi o dinheiro" sub="Composição do faturamento" minW={280} flex={1}>
              {dinheiro.length === 0 ? <div style={{ color:"var(--text-3)", fontSize:13, padding:"30px 0", textAlign:"center" }}>Sem dados no período.</div> :
              <ResponsiveContainer width="100%" height={240}>
                <PieChart>
                  <Pie data={dinheiro} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={56} outerRadius={86} paddingAngle={2} stroke="none">
                    {dinheiro.map(function(d,i){ return <Cell key={i} fill={d.cor} />; })}
                  </Pie>
                  <RTooltip content={<TipMoeda />} />
                  <Legend wrapperStyle={{ fontSize:11 }} />
                </PieChart>
              </ResponsiveContainer>}
            </ChartCard>
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
  const addressMap = {}; // endereço do comprador (cidade/UF) vindo do /shipments/{id}
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
        // Endereço do comprador (cidade/UF). O ML devolve state.id como "BR-SP" → normaliza para "SP".
        var addr = shipData?.receiver_address || null;
        if (addr) {
          var stId = (addr.state && (addr.state.id || addr.state)) ? String(addr.state.id || addr.state).toUpperCase() : "";
          var ufm = stId.match(/([A-Z]{2})$/);
          addressMap[String(o.id)] = { uf: ufm ? ufm[1] : null, city: (addr.city && (addr.city.name || addr.city)) || null, zip: addr.zip_code || null };
        }
      } catch { shippingMap[String(o.id)] = 0; }
    }));
    if (onBatch) onBatch(shippingMap, statusMap, addressMap, Math.min(i + 5, withShipping.length), withShipping.length);
    await new Promise(r => setTimeout(r, 100));
  }
  return { shippingMap, statusMap, addressMap };
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
          // Só money_release_date serve como previsão de recebimento. Havia um
          // recuo para date_approved — a data em que o pagamento foi APROVADO,
          // que não tem relação com quando o dinheiro é liberado. Pior: como
          // "liberado" também é concluído por "data <= hoje", todo pedido antigo
          // aprovado virava liberado sozinho. Sem a data oficial, o pedido fica
          // sem previsão e a tela diz isso, em vez de mostrar uma data inventada.
          var rdRaw = paymentDetail.money_release_date || null;
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
  if (isDevolvido) return { label: "Devolvido", color: "#768592", bg: "rgba(118,133,146,.14)" };
  if (isMediation) return { label: "Em disputa", color: "#FFC107", bg: "rgba(255,193,7,.12)" };
  if (status === "cancelled") return { label: "Cancelado", color: "#FF5252", bg: "rgba(255,82,82,.12)" };
  if (isDelivered) return { label: "Entregue", color: "#768692", bg: "rgba(118,134,146,.14)" };
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
    padding:"6px 11px", borderRadius:7, border: ativo ? "2px solid #768692" : "1px solid var(--border)",
    background: ativo ? "#768692" : "var(--surface)", color: ativo ? "#fff" : "var(--text-2)",
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
        style={{ position:"absolute", top:6, right:6, background: copiado?cf:"var(--surface-3)", border:"1px solid "+(copiado?cf:"rgba(255,255,255,.14)"), color: copiado?"var(--bg)":"var(--text-2)", fontSize:11, fontWeight:500, padding:"3px 10px", borderRadius:6, cursor:"pointer" }}>
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
            <div style={{ fontWeight: 500, fontSize: 18, color: "var(--text-strong)", marginBottom: 4 }}>Qualidade do Anúncio</div>
            <div style={{ color: "var(--text-2)", fontSize: 13, maxWidth: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{listing.title}</div>
          </div>
          <button onClick={onClose} style={{ background: "var(--surface-3)", border: "none", color: "var(--text-2)", width: 32, height: 32, borderRadius: 8, cursor: "pointer", fontSize: 16 }}>✕</button>
        </div>
        <div style={{ background: "var(--bg-2)", border: "1px solid var(--border)", borderRadius: 12, padding: "16px 20px", marginBottom: 20 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 14 }}>
            <div style={{ width: 52, height: 52, borderRadius: 12, background: scoreBg(score), display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
              <span style={{ fontSize: 18, fontWeight: 600, color: scoreColor(score) }}>{score == null ? "—" : score}</span>
              <span style={{ fontSize: 9, color: scoreColor(score), fontWeight: 600 }}>/100</span>
            </div>
            <div>
              <div style={{ fontWeight: 500, fontSize: 16, color: scoreColor(score) }}>{scoreLabel(score)}</div>
              <div style={{ color: "var(--text-3)", fontSize: 12 }}>Score de qualidade do anúncio</div>
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            {checks.map(c => (
              <div key={c.key} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 7px", background: c.pass ? "rgba(0,200,83,.12)" : "rgba(255,82,82,.12)", borderRadius: 8 }}>
                <span style={{ color: c.pass ? "#0a9d4e" : "#FF5252", fontSize: 13, fontWeight: 500 }}>{c.pass ? "✓" : "✗"}</span>
                <span style={{ fontSize: 12, color: c.pass ? "#0a9d4e" : "#FF5252" }}>{c.label}</span>
              </div>
            ))}
          </div>
        </div>
        {state === "idle" && <div style={{ textAlign: "center", padding: "28px 0" }}><div style={{ color: "var(--text-3)", fontSize: 13, marginBottom: 16 }}>Analise com IA para receber sugestões personalizadas</div><button onClick={runAnalysis} style={{ background: "#768692", border: "none", color: "#fff", fontWeight: 500, padding: "11px 32px", borderRadius: 10, cursor: "pointer", fontSize: 14 }}>✦ Analisar com IA</button></div>}
        {state === "loading" && <div style={{ textAlign: "center", padding: "32px 0", color: "var(--text-3)" }}><div style={{ fontSize: 28, marginBottom: 12, animation: "spin 1.2s linear infinite", display: "inline-block" }}>⟳</div><style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style><div style={{ fontSize: 13 }}>Analisando...</div></div>}
        {state === "error" && <div style={{ textAlign: "center", padding: "24px 0" }}><div style={{ color: "#FF5252", fontSize: 13, marginBottom: 12 }}>Erro: {errorMsg}</div><button onClick={runAnalysis} style={{ background: "var(--surface-3)", border: "1px solid var(--border)", color: "var(--text-2)", padding: "8px 20px", borderRadius: 8, cursor: "pointer", fontSize: 13 }}>Tentar novamente</button></div>}
        {state === "done" && result && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ background: "rgba(255,193,7,.12)", border: "1px solid rgba(255,193,7,.35)", borderRadius: 10, padding: "14px 18px" }}>
              <div style={{ fontSize: 11, color: "#FFC107", marginBottom: 6, fontWeight: 500, textTransform: "none", letterSpacing: 1 }}>Avaliação Geral</div>
              <div style={{ fontSize: 14, color: "var(--text-strong)", lineHeight: 1.6 }}>{result.score_commentary}</div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              {result.strengths?.length > 0 && <div style={{ background: "rgba(0,200,83,.12)", border: "1px solid rgba(0,200,83,.35)", borderRadius: 10, padding: "14px 18px" }}><div style={{ fontSize: 11, color: "#0a9d4e", marginBottom: 10, fontWeight: 500, textTransform: "none", letterSpacing: 1 }}>✓ Pontos Fortes</div>{result.strengths.map((s, i) => <div key={i} style={{ fontSize: 13, color: "#0a9d4e", marginBottom: 6, paddingLeft: 10, borderLeft: "2px solid rgba(0,200,83,.45)" }}>{s}</div>)}</div>}
              {result.keywords?.length > 0 && <div style={{ background: "var(--bg-2)", border: "1px solid var(--border)", borderRadius: 10, padding: "14px 18px" }}><div style={{ fontSize: 11, color: "var(--text-2)", marginBottom: 10, fontWeight: 500, textTransform: "none", letterSpacing: 1 }}>Palavras-chave</div><div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>{result.keywords.map((k, i) => <span key={i} style={{ background: "var(--surface-3)", color: "var(--text-2)", fontSize: 12, padding: "3px 10px", borderRadius: 20 }}>{k}</span>)}</div></div>}
            </div>
            {result.improvements?.length > 0 && <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 10, padding: "14px 18px" }}><div style={{ fontSize: 11, color: "#FFC107", marginBottom: 12, fontWeight: 500, textTransform: "none", letterSpacing: 1 }}>⚡ O que Melhorar — com sugestão pronta</div>{result.improvements.map((imp, i) => <div key={i} style={{ display: "flex", gap: 12, marginBottom: 14, paddingBottom: 14, borderBottom: i < result.improvements.length - 1 ? "1px solid var(--border)" : "none" }}><div style={{ minWidth: 26, height: 26, borderRadius: 7, background: "rgba(255,193,7,.12)", border: "1px solid rgba(255,193,7,.35)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: "#FFC107", fontWeight: 500 }}>{i + 1}</div><div style={{ flex: 1, minWidth: 0 }}><div style={{ fontSize: 12, color: "#FFC107", marginBottom: 3, fontWeight: 600 }}>{imp.field}</div><div style={{ fontSize: 13, color: "var(--text-2)", lineHeight: 1.5 }}>{imp.why || imp.suggestion}</div>{imp.ready && String(imp.ready).trim() && <CaixaCopiar texto={imp.ready} cor="#FFC107" />}</div></div>)}</div>}
            {result.description_suggestion && String(result.description_suggestion).trim() && <div style={{ background: "rgba(0,240,255,.08)", border: "1px solid rgba(0,240,255,.25)", borderRadius: 10, padding: "14px 18px" }}><div style={{ fontSize: 11, color: "#0e7490", marginBottom: 4, fontWeight: 500, textTransform: "none", letterSpacing: 1 }}>📄 Descrição pronta para colar</div><div style={{ fontSize: 12, color: "var(--text-3)" }}>Copie e cole na descrição do seu anúncio</div><CaixaCopiar texto={result.description_suggestion} cor="#0e7490" /></div>}
            {result.title_suggestion && <div style={{ background: "rgba(0,200,83,.12)", border: "1px solid rgba(0,200,83,.35)", borderRadius: 10, padding: "14px 18px" }}><div style={{ fontSize: 11, color: "#0a9d4e", marginBottom: 8, fontWeight: 500, textTransform: "none", letterSpacing: 1 }}>✦ Título pronto para colar</div><div style={{ fontSize: 14, color: "var(--text-strong)", fontWeight: 600 }}>{result.title_suggestion}</div><div style={{ fontSize: 11, color: "var(--text-3)", marginTop: 4 }}>{result.title_suggestion.length} caracteres</div><CaixaCopiar texto={result.title_suggestion} cor="#0a9d4e" /></div>}
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
    shipmentAddresses: dados.shipmentAddresses || {},
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
          <div style={{ fontWeight: 600, fontSize: 18, color: "var(--text-strong)" }}>Conectar Mercado Livre</div>
          <button onClick={onClose} style={{ background: "var(--surface-3)", border: "none", color: "var(--text-2)", width: 32, height: 32, borderRadius: 8, cursor: "pointer", fontSize: 16 }}>✕</button>
        </div>
        <p style={{ color: "var(--text-2)", fontSize: 13, lineHeight: 1.7, marginBottom: 20 }}>
          Cole o token de acesso do Mercado Livre. O token fica salvo no navegador e você só precisa reconectar quando ele expirar (a cada 6 horas).
        </p>
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 11, color: "var(--text-3)", marginBottom: 8, fontWeight: 600, letterSpacing: 1, textTransform: "none" }}>Token de acesso</div>
          <textarea value={tokenInput} onChange={e => setTokenInput(e.target.value)} placeholder="APP_USR-..." rows={3}
            style={{ width: "100%", background: "var(--bg-2)", border: `1px solid ${errorMsg ? "#fca5a5" : "var(--border)"}`, color: "var(--text-strong)", padding: "10px 14px", borderRadius: 10, fontFamily: "monospace", fontSize: 12, resize: "none", outline: "none" }} />
        </div>
        {errorMsg && <div style={{ background: "rgba(255,82,82,.12)", border: "1px solid rgba(255,82,82,.35)", color: "#FF5252", fontSize: 13, padding: "10px 14px", borderRadius: 8, marginBottom: 16 }}>⚠ {errorMsg}</div>}
        <button onClick={handleConnect} disabled={loading || !tokenInput.trim()}
          style={{ width: "100%", background: loading || !tokenInput.trim() ? "var(--surface-3)" : "#768692", border: "none", color: loading || !tokenInput.trim() ? "var(--text-3)" : "#fff", fontWeight: 500, padding: "12px", borderRadius: 10, cursor: loading || !tokenInput.trim() ? "not-allowed" : "pointer", fontSize: 14 }}>
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
        style={{ position: "relative", background: "transparent", border: "none", color: "var(--text-3)", width: 32, height: 32, borderRadius: 8, cursor: "pointer", fontSize: 16, display: "flex", alignItems: "center", justifyContent: "center" }}>
        🔔
        {naoLidas > 0 && (
          <div style={{ position: "absolute", top: -4, right: -4, background: "#FF5252", color: "#fff", width: 18, height: 18, borderRadius: "50%", fontSize: 10, fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "center", lineHeight: 1 }}>
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
              <div style={{ fontWeight: 500, fontSize: 14, color: darkMode ? "var(--text-2)" : "var(--text-strong)" }}>
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
                  style={{ padding: "12px 16px", borderBottom: `1px solid ${border}`, cursor: "pointer", background: !n.lido ? (darkMode ? "#3a4750" : "rgba(118,134,146,.14)") : "transparent", transition: "background .15s" }}>
                  <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                    <div style={{ width: 36, height: 36, borderRadius: 10, background: n.tipo === "pedido" ? "rgba(0,200,83,.18)" : "rgba(255,193,7,.18)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, flexShrink: 0 }}>
                      {n.tipo === "pedido" ? "🛒" : "⚠️"}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                        <div style={{ fontWeight: 500, fontSize: 13, color: darkMode ? "var(--text-2)" : "var(--text-strong)" }}>{n.titulo}</div>
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
              <div style={{ padding: "10px 16px", borderTop: `1px solid ${border}`, background: darkMode ? "#768692" : "var(--bg-2)" }}>
                <button onClick={pedirPermissao} style={{ width: "100%", background: "#768692", border: "none", color: "#fff", fontWeight: 600, padding: "8px", borderRadius: 8, cursor: "pointer", fontSize: 12 }}>
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
  { key: "prioridade_pagamento_config", label: "Regras de prioridade de pagamento" },
  { key: "financeiro_config",       label: "Regime financeiro" },
  { key: "contas_bancarias",        label: "Caixas e bancos" },
  { key: "extrato_bancario",        label: "Extrato importado" },
  { key: "recebiveis_baixados",     label: "Recebimentos confirmados" },
  { key: "contas_bancarias",        label: "Caixas e Bancos" },
  { key: "lancamentos",             label: "Lançamentos Financeiros" },
  { key: "categorias_pagar",        label: "Categorias" },
  { key: "produtos_cadastro",       label: "Produtos" },
  { key: "fornecedores_cadastro",   label: "Fornecedores" },
  { key: "notas_fiscais_entrada",   label: "Notas Fiscais" },
  { key: "impostos_config",         label: "Impostos" },
  { key: "icms_regime_config",      label: "Regime de ICMS" },
  { key: "analise_ia_config",       label: "Regras da análise de anúncios" },
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
            <div style={{ fontWeight:600, fontSize:18, color:"var(--text-strong)" }}>💾 Backup e Restauração</div>
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
              <div style={{ fontWeight:500, fontSize:14, color:"#FFC107", marginBottom:8 }}>⚠️ Confirmar Restauração</div>
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
                  style={{ flex:2, background:"#FFC107", border:"none", color:"#fff", fontWeight:500, padding:"10px", borderRadius:8, cursor:"pointer" }}>
                  ✓ Sim, restaurar dados
                </button>
              </div>
            </div>
          )}

          {/* Resumo dos dados atuais */}
          <div style={{ marginBottom:10 }}>
            <div style={{ fontWeight:500, fontSize:14, color:"var(--text-strong)", marginBottom:12 }}>📊 Dados Armazenados Atualmente</div>
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
                <span style={{ fontSize:13, fontWeight:500, color:"var(--text-strong)" }}>Total</span>
                <span style={{ fontSize:13, fontWeight:500, color:"var(--text-strong)" }}>{formatSize(totalSize)}</span>
              </div>
            </div>
          </div>

          {/* Ações */}
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12 }}>
            {/* Exportar */}
            <div style={{ background:"rgba(0,200,83,.12)", border:"1px solid rgba(0,200,83,.35)", borderRadius:12, padding:"18px 20px" }}>
              <div style={{ fontSize:28, marginBottom:8 }}>⬇️</div>
              <div style={{ fontWeight:500, fontSize:14, color:"var(--ui-accent)", marginBottom:4 }}>Exportar Backup</div>
              <div style={{ fontSize:12, color:"var(--text-2)", marginBottom:8, lineHeight:1.5 }}>
                Baixa um arquivo JSON com todos os seus dados. Guarde em local seguro.
              </div>
              <button onClick={exportarBackup}
                style={{ width:"100%", background:"var(--ui-accent)", border:"none", color:"var(--ui-accent-text)", fontWeight:500, padding:"11px", borderRadius:10, cursor:"pointer", fontSize:13 }}>
                ⬇️ Exportar Backup Agora
              </button>
            </div>

            {/* Importar */}
            <div style={{ background:"rgba(118,134,146,.14)", border:"1px solid rgba(118,134,146,.35)", borderRadius:12, padding:"18px 20px" }}>
              <div style={{ fontSize:28, marginBottom:8 }}>⬆️</div>
              <div style={{ fontWeight:500, fontSize:14, color:"#768692", marginBottom:4 }}>Restaurar Backup</div>
              <div style={{ fontSize:12, color:"var(--text-2)", marginBottom:8, lineHeight:1.5 }}>
                Selecione um arquivo de backup (.json) para restaurar seus dados.
              </div>
              <label style={{ display:"block", width:"100%", background:"#768692", border:"none", color:"#fff", fontWeight:500, padding:"11px", borderRadius:10, cursor:"pointer", fontSize:13, textAlign:"center" }}>
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

// Salva a lista de usuários NO SERVIDOR (é lá que o login procura) e só então
// atualiza o cache local. Antes o cache era gravado primeiro e o envio era
// disparado sem checar a resposta: quando o servidor recusava — sessão expirada,
// KV fora do ar, sem permissão de admin — o usuário aparecia criado no painel de
// quem cadastrou e não existia para o login. Devolve { ok, erro, usuarios }.
async function saveUsuarios(usuarios) {
  // Senhas novas ficam em u.senha (texto) só até o envio — nunca vão para o localStorage
  var senhas = {};
  var semSenhas = usuarios.map(function(u){
    var limpo = Object.assign({}, u);
    if (limpo.senha) { senhas[limpo.id] = limpo.senha; delete limpo.senha; }
    delete limpo.senhaHash;
    return limpo;
  });
  var res;
  try {
    res = await fetch("/api/ml/_users", {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify({ usuarios: semSenhas, senhas: senhas })
    });
  } catch (e) {
    return { ok:false, usuarios:getUsuarios(), semSenha:[],
      erro:"Não foi possível falar com o servidor. A alteração NÃO foi salva — verifique a conexão e tente de novo." };
  }
  var data = await res.json().catch(function(){ return {}; });
  if (!res.ok) {
    var motivo = data.error || ("O servidor recusou a alteração (HTTP " + res.status + ").");
    if (res.status === 401) motivo = "Sua sessão expirou. Saia e entre de novo no sistema para salvar usuários.";
    if (res.status === 403) motivo = "Sua conta não tem permissão de administrador para alterar usuários.";
    return { ok:false, usuarios:getUsuarios(), semSenha:[], erro:motivo };
  }
  // Confirmado: o cache local passa a ser exatamente o que o servidor gravou.
  var confirmados = Array.isArray(data.usuarios) && data.usuarios.length ? data.usuarios : semSenhas;
  try { localStorage.setItem(AUTH_KEY, JSON.stringify(confirmados)); } catch {}
  return { ok:true, usuarios:confirmados, semSenha: Array.isArray(data.semSenha) ? data.semSenha : [], erro:"" };
}

// Busca usuários do servidor para o cache local (chamado após o login).
// Devolve { ok, usuarios, erro } — quem chama precisa saber se a lista exibida é a
// do servidor ou um cache local possivelmente desatualizado.
async function sincronizarUsuariosDoServidor() {
  try {
    var res = await fetch("/api/ml/_users");
    if (!res.ok) {
      var d = await res.json().catch(function(){ return {}; });
      return { ok:false, usuarios:getUsuarios(),
        erro: d.error || ("Não foi possível carregar os usuários do servidor (HTTP " + res.status + ").") };
    }
    var usuariosServidor = await res.json();
    if (!Array.isArray(usuariosServidor)) {
      return { ok:false, usuarios:getUsuarios(), erro:"Resposta inesperada do servidor de usuários." };
    }
    localStorage.setItem(AUTH_KEY, JSON.stringify(usuariosServidor));
    return { ok:true, usuarios:usuariosServidor, erro:"" };
  } catch(e) {
    return { ok:false, usuarios:getUsuarios(), erro:"Sem conexão com o servidor de usuários." };
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
    <div style={{ minHeight:"100vh", backgroundColor:"var(--bg)", backgroundImage:"radial-gradient(1100px 500px at 75% -10%, rgba(118,134,146,.12), transparent 60%), radial-gradient(800px 420px at -10% 110%, rgba(0,240,255,.06), transparent 60%)", display:"flex", alignItems:"center", justifyContent:"center", fontFamily:"'Inter','Segoe UI',sans-serif", padding:24 }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');*{box-sizing:border-box;margin:0;padding:0}`}</style>
      <div style={{ width:"100%", maxWidth:420 }}>
        {/* Logo */}
        <div style={{ textAlign:"center", marginBottom:32 }}>
          <div style={{ width:64, height:64, borderRadius:"50%", background:"rgba(118,134,146,.12)", border:"1px solid rgba(118,134,146,.45)", display:"inline-flex", alignItems:"center", justifyContent:"center", fontFamily:"'Space Grotesk',sans-serif", fontSize:30, fontWeight:500, color:"#768692", marginBottom:12, boxShadow:"0 0 32px rgba(118,134,146,.4)" }}>F</div>
          <div style={{ fontFamily:"'Space Grotesk',sans-serif", fontWeight:500, fontSize:24, color:"var(--text-strong)", letterSpacing:-0.5 }}>Flow Marketplaces</div>
          <div style={{ fontFamily:"'JetBrains Mono',monospace", fontSize:11, color:"var(--text-3)", marginTop:6, letterSpacing:".24em", textTransform:"none" }}>Gestão de Anúncios</div>
        </div>

        {/* Card */}
        <div style={{ background:"var(--bg-2)", borderRadius:20, padding:"32px 36px", boxShadow:"0 20px 60px rgba(0,0,0,.4)", border:"1px solid var(--text-2)" }}>
          <div style={{ fontWeight:500, fontSize:18, color:"var(--text-2)", marginBottom:10 }}>Entrar no sistema</div>

          <div style={{ marginBottom:8 }}>
            <div style={{ fontSize:11, color:"var(--text-2)", marginBottom:8, fontWeight:600, letterSpacing:1, textTransform:"none" }}>Usuário</div>
            <input value={usuario} onChange={e => { setUsuario(e.target.value); setErro(""); }}
              onKeyDown={e => e.key==="Enter" && handleLogin()}
              placeholder="Digite seu usuário"
              style={{ width:"100%", background:"var(--bg)", border:`1px solid ${erro?"#FF5252":"rgba(255,255,255,.14)"}`, color:"var(--text-strong)", padding:"12px 16px", borderRadius:10, fontSize:14, outline:"none", fontFamily:"inherit" }} />
          </div>

          <div style={{ marginBottom:10 }}>
            <div style={{ fontSize:11, color:"var(--text-2)", marginBottom:8, fontWeight:600, letterSpacing:1, textTransform:"none" }}>Senha</div>
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
            style={{ width:"100%", background:loading||!usuario||!senha?"var(--surface-3)":"var(--bg)", border:`1px solid ${loading||!usuario||!senha?"var(--border-soft)":"rgba(255,255,255,.18)"}`, color:loading||!usuario||!senha?"var(--text-3)":"var(--text-strong)", fontWeight:600, padding:"14px", borderRadius:12, cursor:loading||!usuario||!senha?"not-allowed":"pointer", fontSize:15, transition:"all .15s" }}>
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
// Normaliza o login do mesmo jeito que o servidor: sem espaços nas pontas e em
// minúsculas. "João " e "joao" precisam ser a mesma coisa na hora de entrar.
function normalizarLoginCliente(v) {
  return String(v == null ? "" : v).trim().toLowerCase();
}

function ModalUsuario({ usuario, existentes, onSave, onClose }) {
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
    const login = normalizarLoginCliente(form.usuario);
    const nome = String(form.nome || "").trim();
    if (!nome || !login) { alert("Preencha o nome e o usuário."); return; }
    if (/\s/.test(login)) { alert("O usuário não pode conter espaços — use algo como joao.silva"); return; }
    const repetido = (existentes || []).some(function(u){
      return u.id !== form.id && normalizarLoginCliente(u.usuario) === login;
    });
    if (repetido) { alert("Já existe um usuário com o login \"" + login + "\". Escolha outro."); return; }
    const toSave = { ...form, usuario: login, nome: nome };
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
          <div style={{ fontWeight:600, fontSize:17, color:"var(--text-strong)" }}>{usuario ? "Editar Usuário" : "Novo Usuário"}</div>
          <button onClick={onClose} style={{ background:"var(--surface-3)", border:"none", color:"var(--text-2)", width:32, height:32, borderRadius:8, cursor:"pointer", fontSize:16 }}>✕</button>
        </div>

        <div style={{ display:"flex", flexDirection:"column", gap:12, marginBottom:10 }}>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
            <div>
              <div style={{ fontSize:11, color:"var(--text-3)", marginBottom:5, fontWeight:600, textTransform:"none" }}>Nome completo *</div>
              <input value={form.nome} onChange={e=>set("nome",e.target.value)} placeholder="Ex: João Silva"
                style={{ width:"100%", background:"var(--bg-2)", border:"1px solid var(--border)", color:"var(--text-strong)", padding:"9px 12px", borderRadius:8, fontSize:13, outline:"none" }} />
            </div>
            <div>
              <div style={{ fontSize:11, color:"var(--text-3)", marginBottom:5, fontWeight:600, textTransform:"none" }}>Usuário (login) *</div>
              <input value={form.usuario} onChange={e=>set("usuario",e.target.value.toLowerCase().replace(/\s/g,""))} placeholder="Ex: joao"
                style={{ width:"100%", background:"var(--bg-2)", border:"1px solid var(--border)", color:"var(--text-strong)", padding:"9px 12px", borderRadius:8, fontSize:13, outline:"none", fontFamily:"monospace" }} />
            </div>
          </div>

          <div>
            <div style={{ fontSize:11, color:"var(--text-3)", marginBottom:5, fontWeight:600, textTransform:"none" }}>Email (para notificações de tarefas)</div>
            <input type="email" value={form.email||""} onChange={e=>set("email",e.target.value)} placeholder="usuario@empresa.com"
              style={{ width:"100%", background:"var(--bg-2)", border:"1px solid var(--border)", color:"var(--text-strong)", padding:"9px 12px", borderRadius:8, fontSize:13, outline:"none" }} />
          </div>

          <div>
            <div style={{ fontSize:11, color:"var(--text-3)", marginBottom:5, fontWeight:600, textTransform:"none" }}>
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
              <div style={{ fontWeight:500, fontSize:13, color:"var(--text-strong)" }}>Permissões de Acesso</div>
              <button onClick={function(){
                  var todasKeys = [];
                  PERMISSOES_DISPONIVEIS.forEach(function(p){ todasKeys.push(p.key); if(p.sub) p.sub.forEach(function(s){ todasKeys.push(s.key); }); });
                  var temTudo = todasKeys.every(function(k){ return (form.permissoes||[]).includes(k); });
                  set("permissoes", temTudo ? [] : todasKeys);
                }}
                style={{ fontSize:11, color:"#768692", background:"transparent", border:"none", cursor:"pointer", fontWeight:600 }}>
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
                      background: isChecked || subChecked > 0 ? "rgba(118,134,146,.14)" : "var(--surface)",
                      border: "1px solid " + (isChecked || subChecked > 0 ? "#768692" : "var(--border)"),
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
                      <span style={{ fontSize:13, fontWeight:600, color: isChecked || subChecked > 0 ? "#768692" : "var(--text-2)", flex:1 }}>{p.label}</span>
                      {p.sub && <span style={{ fontSize:10, color:"var(--text-3)" }}>{subChecked}/{subTotal}</span>}
                    </label>
                    {/* Sub-permissões */}
                    {p.sub && (isChecked || subChecked > 0 || true) && (
                      <div style={{ marginLeft:24, marginTop:4, display:"grid", gridTemplateColumns:"1fr 1fr", gap:4 }}>
                        {p.sub.map(function(s) {
                          var sChecked = (form.permissoes||[]).includes(s.key);
                          return (
                            <label key={s.key} style={{ display:"flex", alignItems:"center", gap:6, cursor:"pointer", padding:"6px 10px", borderRadius:7,
                              background: sChecked ? "rgba(118,134,146,.12)" : "var(--bg-2)",
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
                              <span style={{ fontSize:12, color: sChecked ? "#768692" : "var(--text-2)", fontWeight: sChecked ? 600 : 400 }}>{s.label}</span>
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
            style={{ flex:2, background:!form.nome||!form.usuario?"var(--surface-3)":"#768692", border:"none", color:!form.nome||!form.usuario?"var(--text-3)":"#fff", fontWeight:500, padding:"11px", borderRadius:10, cursor:!form.nome||!form.usuario?"not-allowed":"pointer" }}>
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
  // Estado da lista exibida: veio do servidor (é o que o login enxerga) ou é cache local?
  const [estadoServidor, setEstadoServidor] = useState({ carregando:true, ok:false, erro:"" });
  const [salvando, setSalvando] = useState(false);

  function recarregarDoServidor() {
    setEstadoServidor(function(e){ return Object.assign({}, e, { carregando:true }); });
    return sincronizarUsuariosDoServidor().then(function(r){
      setUsuarios(r.usuarios);
      setEstadoServidor({ carregando:false, ok:r.ok, erro:r.erro });
      return r;
    });
  }

  // Atualiza o cache local com a lista do servidor ao abrir a aba
  useEffect(function(){ recarregarDoServidor(); }, []);

  // Aplica uma alteração: só considera feita depois do "ok" do servidor, porque é lá
  // que o login procura o usuário. Em caso de falha, mostra o motivo real.
  async function aplicar(lista, descricao) {
    setSalvando(true);
    const r = await saveUsuarios(lista);
    setUsuarios(r.usuarios);
    setEstadoServidor({ carregando:false, ok:r.ok, erro:r.erro });
    setSalvando(false);
    if (!r.ok) {
      alert("NÃO foi possível " + descricao + ".\n\n" + r.erro +
            "\n\nNada foi alterado no servidor — o usuário não conseguiria entrar.");
      return false;
    }
    if (r.semSenha && r.semSenha.length) {
      alert("Atenção: sem senha definida para " + r.semSenha.join(", ") +
            ".\nEsses usuários não conseguem entrar até você usar \"Redefinir senha\".");
    }
    return true;
  }

  function saveUser(user) {
    const lista = getUsuarios();
    const updated = lista.find(u=>u.id===user.id)
      ? lista.map(u=>u.id===user.id?user:u)
      : [...lista, user];
    aplicar(updated, "salvar o usuário");
  }

  function deleteUser(id) {
    if (id === currentUser.id) { alert("Você não pode excluir seu próprio usuário!"); return; }
    if (!confirm("Excluir este usuário?")) return;
    const updated = getUsuarios().filter(u=>u.id!==id);
    aplicar(updated, "excluir o usuário");
  }

  function toggleAtivo(id) {
    if (id === currentUser.id) { alert("Você não pode desativar seu próprio usuário!"); return; }
    const updated = getUsuarios().map(u=>u.id===id?{...u,ativo:!u.ativo}:u);
    aplicar(updated, "mudar a situação do usuário");
  }

  async function resetarSenha(u) {
    var nova = window.prompt("Nova senha para " + (u.nome || u.usuario) + ":", "");
    if (nova == null) return; // cancelou
    nova = String(nova).trim();
    if (nova.length < 4) { alert("A senha precisa ter pelo menos 4 caracteres."); return; }
    // saveUsuarios envia u.senha (texto) ao servidor, que faz o hash com scrypt.
    const updated = getUsuarios().map(u2 => u2.id === u.id ? Object.assign({}, u2, { senha: nova }) : u2);
    const ok = await aplicar(updated, "redefinir a senha");
    if (ok) alert("Senha de " + (u.nome || u.usuario) + " redefinida com sucesso.");
  }

  return (
    <div>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:10 }}>
        <div>
          <div style={{ fontWeight:600, fontSize:18, color:"var(--text-strong)" }}>Equipe</div>
          <div style={{ fontSize:13, color:"var(--text-3)", marginTop:2 }}>Gerencie quem pode acessar o dashboard e o que cada um pode ver</div>
        </div>
        <button onClick={()=>{ setEditingUser(null); setShowModal(true); }} disabled={salvando}
          style={{ background:"#768692", border:"none", color:"#fff", fontWeight:500, padding:"10px 22px", borderRadius:10, cursor: salvando ? "wait" : "pointer", fontSize:13, opacity: salvando ? .6 : 1 }}>
          + Novo Usuário
        </button>
      </div>

      {/* A lista que vale para o login é a do servidor. Quando ela não carrega, o que
          aparece abaixo é cache local — e cadastrar nesse estado não salva de verdade. */}
      {!estadoServidor.carregando && (
        estadoServidor.ok ? (
          <div style={{ fontSize:11.5, color:"var(--text-3)", marginBottom:10 }}>
            ✓ Lista carregada do servidor — é exatamente o que o login enxerga.
            <button onClick={recarregarDoServidor}
              style={{ marginLeft:8, fontSize:11, color:"#768692", background:"none", border:"none", cursor:"pointer", textDecoration:"underline", fontFamily:"inherit" }}>
              recarregar
            </button>
          </div>
        ) : (
          <div style={{ display:"flex", alignItems:"flex-start", gap:8, background:"rgba(255,82,82,.10)", border:"1px solid rgba(255,82,82,.4)", borderRadius:10, padding:"10px 14px", marginBottom:10 }}>
            <span style={{ fontSize:14 }}>⚠️</span>
            <div style={{ fontSize:12, color:"var(--text-2)", lineHeight:1.5 }}>
              <b style={{ color:"#FF5252" }}>A lista abaixo não veio do servidor.</b> {estadoServidor.erro}
              <br />Ela é uma cópia local: usuários criados agora podem não ser salvos e não conseguiriam entrar.
              <button onClick={recarregarDoServidor}
                style={{ marginLeft:6, fontSize:11.5, color:"#768692", background:"none", border:"none", cursor:"pointer", textDecoration:"underline", fontFamily:"inherit" }}>
                tentar de novo
              </button>
            </div>
          </div>
        )
      )}

      <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:12, overflow:"hidden" }}>
        {usuarios.map(function(u, idx){
          var eu = u.id === currentUser.id;
          return (
            <div key={u.id} style={{ display:"flex", alignItems:"center", gap:14, padding:"14px 18px", borderBottom: idx < usuarios.length-1 ? "1px solid var(--border-soft)" : "none", opacity: u.ativo ? 1 : 0.55 }}>
              <div style={{ width:40, height:40, borderRadius:10, background: u.admin ? "#768692" : "var(--surface-3)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:15, fontWeight:600, color: u.admin ? "#fff" : "var(--text-2)", flexShrink:0 }}>
                {(u.nome || "?").charAt(0).toUpperCase()}
              </div>
              <div style={{ width:190, flexShrink:0, minWidth:0 }}>
                <div style={{ fontWeight:500, fontSize:14, color:"var(--text-strong)", display:"flex", alignItems:"center", gap:8 }}>
                  <span style={{ overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{u.nome}</span>
                  {eu && <span style={{ fontSize:10, fontWeight:500, color:"#768692", background:"rgba(118,134,146,.12)", padding:"1px 7px", borderRadius:20, flexShrink:0 }}>Você</span>}
                </div>
                <div style={{ fontSize:12, color:"var(--text-3)", fontFamily:"'JetBrains Mono',monospace" }}>@{u.usuario}{u.admin ? " · admin" : ""}</div>
              </div>
              <div style={{ flex:1, display:"flex", flexWrap:"wrap", gap:4, minWidth:0 }}>
                {PERMISSOES_DISPONIVEIS.map(function(p){ var on = u.permissoes && u.permissoes.includes(p.key); return <span key={p.key} style={{ fontSize:11, padding:"2px 8px", borderRadius:20, background: on ? "rgba(118,134,146,.12)" : "var(--bg-2)", color: on ? "#768692" : "var(--text-4)", border:"1px solid " + (on ? "rgba(118,134,146,.3)" : "var(--border)"), fontWeight: on ? 600 : 400 }}>{p.label}</span>; })}
              </div>
              <button onClick={function(){ toggleAtivo(u.id); }} style={{ fontSize:11, fontWeight:500, padding:"4px 10px", borderRadius:20, cursor:"pointer", flexShrink:0, background: u.ativo ? "rgba(10,157,78,.12)" : "var(--bg-2)", border:"1px solid " + (u.ativo ? "rgba(10,157,78,.35)" : "var(--border)"), color: u.ativo ? "#0a9d4e" : "var(--text-3)" }}>{u.ativo ? "Ativo" : "Inativo"}</button>
              <button onClick={function(){ resetarSenha(u); }} title="Definir uma nova senha para este usuário" style={{ fontSize:12, fontWeight:600, padding:"5px 12px", borderRadius:8, cursor:"pointer", flexShrink:0, background:"rgba(118,134,146,.14)", border:"none", color:"#768692" }}>Redefinir senha</button>
              <button onClick={function(){ setEditingUser(u); setShowModal(true); }} style={{ fontSize:12, fontWeight:600, padding:"5px 12px", borderRadius:8, cursor:"pointer", flexShrink:0, background:"var(--surface-3)", border:"none", color:"var(--text-2)" }}>Editar</button>
              {!eu && <button onClick={function(){ deleteUser(u.id); }} style={{ fontSize:12, fontWeight:600, padding:"5px 12px", borderRadius:8, cursor:"pointer", flexShrink:0, background:"rgba(255,82,82,.1)", border:"none", color:"#FF5252" }}>Excluir</button>}
            </div>
          );
        })}
      </div>

      {showModal && <ModalUsuario usuario={editingUser} existentes={usuarios} onSave={saveUser} onClose={()=>{ setShowModal(false); setEditingUser(null); }} />}
    </div>
  );
}


// ── Painel detalhado de Impostos (Lucro Real) e Custos Fixos ──
var ESTADOS_BR_ICMS = [["AC", "Acre", 19], ["AL", "Alagoas", 19], ["AP", "Amapá", 18], ["AM", "Amazonas", 20], ["BA", "Bahia", 20.5], ["CE", "Ceará", 20], ["DF", "Distrito Federal", 20], ["ES", "Espírito Santo", 17], ["GO", "Goiás", 19], ["MA", "Maranhão", 22], ["MT", "Mato Grosso", 17], ["MS", "Mato Grosso do Sul", 17], ["MG", "Minas Gerais", 18], ["PA", "Pará", 19], ["PB", "Paraíba", 20], ["PR", "Paraná", 19.5], ["PE", "Pernambuco", 20.5], ["PI", "Piauí", 21], ["RJ", "Rio de Janeiro", 22], ["RN", "Rio Grande do Norte", 18], ["RS", "Rio Grande do Sul", 17], ["RO", "Rondônia", 19.5], ["RR", "Roraima", 20], ["SC", "Santa Catarina", 17], ["SP", "São Paulo", 18], ["SE", "Sergipe", 19], ["TO", "Tocantins", 20]];

function getIcmsConfig() {
  try { return JSON.parse(localStorage.getItem("icms_por_estado")||"{}"); } catch { return {}; }
}
function saveIcmsConfig(cfg) { try { localStorage.setItem("icms_por_estado", JSON.stringify(cfg)); } catch {} }

// ── Regime de ICMS sobre a venda ──────────────────────────────────────────────
// Padrão da operação: mercadoria importada saindo de SP — 4% nas vendas para fora do
// estado (alíquota interestadual de importado) e 0% nas vendas dentro de SP. O modo
// "tabela" mantém o comportamento antigo: uma alíquota livre por estado de destino.
var ICMS_REGIME_PADRAO = { ativo: true, modo: "automatico", ufOrigem: "SP", aliqInterna: 0, aliqInterestadual: 4 };
function getIcmsRegime() {
  try {
    var v = JSON.parse(localStorage.getItem("icms_regime_config") || "{}");
    if (!v || typeof v !== "object" || Array.isArray(v)) return Object.assign({}, ICMS_REGIME_PADRAO);
    return Object.assign({}, ICMS_REGIME_PADRAO, v);
  } catch { return Object.assign({}, ICMS_REGIME_PADRAO); }
}
function saveIcmsRegime(cfg) { try { localStorage.setItem("icms_regime_config", JSON.stringify(cfg)); } catch {} }

// Alíquota de ICMS (%) de uma venda, pela UF de entrega do comprador. Sem UF conhecida
// assume interestadual — é o caso mais comum e o mais conservador para a margem.
function icmsPctParaUF(uf, regime, tabelaPorEstado) {
  var r = regime || ICMS_REGIME_PADRAO;
  if (r.ativo === false) return 0;
  var destino = String(uf || "").trim().toUpperCase();
  if (r.modo === "tabela") {
    var t = parseFloat((tabelaPorEstado || {})[destino]);
    return isFinite(t) ? t : 0;
  }
  var interestadual = parseFloat(r.aliqInterestadual); if (!isFinite(interestadual)) interestadual = 0;
  var interna = parseFloat(r.aliqInterna); if (!isFinite(interna)) interna = 0;
  if (!destino) return interestadual;
  return destino === String(r.ufOrigem || "SP").toUpperCase() ? interna : interestadual;
}

// Alíquota usada onde ainda não há comprador: projeção de margem de anúncios e precificação.
// No modo automático usa a interestadual (a maior parte das vendas sai do estado de origem).
function icmsPctProjecao(regime, tabelaPorEstado) {
  var r = regime || ICMS_REGIME_PADRAO;
  if (r.ativo === false) return 0;
  if (r.modo === "tabela") {
    var ufs = Object.keys(tabelaPorEstado || {}).filter(function(k){ return isFinite(parseFloat((tabelaPorEstado || {})[k])); });
    if (!ufs.length) return 0;
    return ufs.reduce(function(soma, k){ return soma + parseFloat(tabelaPorEstado[k]); }, 0) / ufs.length;
  }
  var v = parseFloat(r.aliqInterestadual);
  return isFinite(v) ? v : 0;
}

// Tela de Impostos (menu Configuração). O painel abaixo já existia, mas só era montado por
// uma aba do painel global que nenhum botão abria — ficava inalcançável na interface.
function ImpostosTab(props) {
  return (
    <FinanceiroShell tab={props.tab} setTab={props.setTab} titulo="Impostos"
      sub="ICMS por destino da venda, IRPJ, CSLL e custos fixos — entram na margem de anúncios e pedidos, e nas despesas do DRE.">
      <ImpostosCompacto {...props} />
    </FinanceiroShell>
  );
}

function ImpostosCompacto({ impostos, setImpostos, custosFixos, setCustosFixos, faturamentoMes, irpjCsllConfig, setIrpjCsllConfig, icmsRegime, setIcmsRegime, icmsConfig, setIcmsConfig }) {
  const [novoCusto, setNovoCusto] = useState({ nome:"", valor:"", tipo:"R$" });
  // Persiste no localStorage — o loop de sincronização (pushMudancasLocais) envia daqui para o KV
  function saveCustosFixos(v) { try { localStorage.setItem("custos_fixos_config", JSON.stringify(v)); } catch {} }
  const [showIcmsTable, setShowIcmsTable] = useState(false);
  const regime = icmsRegime || ICMS_REGIME_PADRAO;
  const modoAuto = regime.modo !== "tabela";
  const ufOrigem = String(regime.ufOrigem || "SP").toUpperCase();
  const irpjPct = irpjCsllConfig.irpj ?? "15";
  const irpjAdicionalPct = irpjCsllConfig.irpjAdicional ?? "10";
  const csllPct = irpjCsllConfig.csll ?? "9";

  function salvarIrpjCsll(novoIrpj, novoIrpjAd, novoCsll) {
    setIrpjCsllConfig({ irpj: novoIrpj, irpjAdicional: novoIrpjAd, csll: novoCsll });
  }

  function setIcmsEstado(uf, valor) {
    setIcmsConfig(Object.assign({}, icmsConfig, { [uf]: valor }));
  }
  function resetIcmsPadrao() {
    var next = {};
    ESTADOS_BR_ICMS.forEach(function(e){ next[e[0]] = e[2]; });
    setIcmsConfig(next);
  }
  function setRegimeCampo(campo, valor) {
    setIcmsRegime(Object.assign({}, regime, { [campo]: valor }));
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
        <div style={{ fontSize:13, fontWeight:500, color:"var(--text-2)" }}>{item.tipo==="%" ? item.valor+"%" : fmt(parseFloat(item.valor)||0)}</div>
        <div style={{ fontSize:12, color:"var(--text-3)" }}>= {fmt(calcValor(item, faturamentoMes))}</div>
        <button onClick={function(){ onRemove(item.id); }} style={{ background:"rgba(255,82,82,.12)", border:"none", color:"#FF5252", width:24, height:24, borderRadius:6, cursor:"pointer", fontSize:11, flexShrink:0 }}>✕</button>
      </div>
    );
  }

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:16 }}>

      {/* ── IMPOSTOS — Lucro Real ── */}
      <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:14, overflow:"hidden" }}>
        <div style={{ background:"var(--surface-3)", padding:"10px 14px", borderBottom:"1px solid var(--border)", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
          <div>
            <div style={{ fontWeight:600, fontSize:14, color:"var(--text-strong)" }}>Impostos — Regime Lucro Real</div>
            <div style={{ fontSize:11, color:"var(--text-3)", marginTop:1 }}>ICMS sobre a venda, IRPJ e CSLL</div>
          </div>
          <div style={{ textAlign:"right" }}>
            <div style={{ fontSize:11, color:"var(--text-3)" }}>IRPJ+CSLL s/ faturamento</div>
            <div style={{ fontSize:17, fontWeight:600, color: totalImpFixo > 0 ? FIN_COR.saida : "var(--text-3)" }}>{fmt(totalImpFixo)}</div>
          </div>
        </div>

        <div style={{ padding:"14px 18px" }}>
          {/* IRPJ e CSLL */}
          <div style={{ fontSize:11, color:"var(--text-3)", fontWeight:500, textTransform:"none", marginBottom:8 }}>IRPJ e CSLL (sobre o Lucro Real apurado)</div>
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

          {/* ICMS sobre a venda */}
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8 }}>
            <div>
              <div style={{ fontSize:11, color:"var(--text-3)", fontWeight:500, textTransform:"none" }}>
                ICMS sobre a venda
              </div>
              <div style={{ fontSize:10, color:"var(--text-4)", marginTop:1 }}>
                Entra na margem de cada pedido conforme o estado de entrega do comprador
              </div>
            </div>
            <label style={{ display:"flex", alignItems:"center", gap:6, fontSize:11, color:"var(--text-2)", cursor:"pointer", flexShrink:0 }}>
              <input type="checkbox" checked={regime.ativo !== false}
                onChange={function(e){ setRegimeCampo("ativo", e.target.checked); }}
                style={{ cursor:"pointer" }} />
              Aplicar no cálculo de margem
            </label>
          </div>

          <div style={{ display:"flex", gap:6, marginBottom:10 }}>
            {[["automatico", "Por destino (dentro x fora do estado)"], ["tabela", "Tabela por estado"]].map(function(m){
              var ativo = modoAuto === (m[0] === "automatico");
              return (
                <button key={m[0]} onClick={function(){ setRegimeCampo("modo", m[0]); }}
                  style={{ flex:1, fontSize:11, fontWeight:600, padding:"7px 10px", borderRadius:8, cursor:"pointer",
                    background: ativo ? "#768692" : "var(--bg-2)",
                    border: "1px solid " + (ativo ? "#768692" : "var(--border)"),
                    color: ativo ? "#fff" : "var(--text-2)" }}>
                  {m[1]}
                </button>
              );
            })}
          </div>

          {modoAuto ? (
            <div style={{ background:"var(--bg-2)", border:"1px solid var(--border)", borderRadius:10, padding:"12px 14px", opacity: regime.ativo === false ? .5 : 1 }}>
              <div style={{ display:"grid", gridTemplateColumns:"1.3fr 1fr 1fr", gap:10 }}>
                <div>
                  <div style={{ fontSize:10, color:"var(--text-3)", marginBottom:4 }}>UF de origem (sua empresa)</div>
                  <select value={ufOrigem} onChange={function(e){ setRegimeCampo("ufOrigem", e.target.value); }}
                    style={{ width:"100%", background:"var(--surface)", border:"1px solid var(--border)", color:"var(--text-strong)", padding:"7px 10px", borderRadius:8, fontSize:13, outline:"none", cursor:"pointer" }}>
                    {ESTADOS_BR_ICMS.map(function(e){ return <option key={e[0]} value={e[0]}>{e[0]} — {e[1]}</option>; })}
                  </select>
                </div>
                <div>
                  <div style={{ fontSize:10, color:"var(--text-3)", marginBottom:4 }}>Dentro de {ufOrigem} (%)</div>
                  <div style={{ display:"flex", alignItems:"center", gap:4 }}>
                    <input type="number" step="0.01" min="0" value={regime.aliqInterna ?? 0}
                      onChange={function(e){ setRegimeCampo("aliqInterna", e.target.value); }}
                      style={{ width:"100%", background:"var(--surface)", border:"1px solid var(--border)", color:"var(--text-strong)", padding:"7px 10px", borderRadius:8, fontSize:13, outline:"none" }} />
                    <span style={{ fontSize:12, color:"var(--text-3)" }}>%</span>
                  </div>
                </div>
                <div>
                  <div style={{ fontSize:10, color:"var(--text-3)", marginBottom:4 }}>Outros estados (%)</div>
                  <div style={{ display:"flex", alignItems:"center", gap:4 }}>
                    <input type="number" step="0.01" min="0" value={regime.aliqInterestadual ?? 0}
                      onChange={function(e){ setRegimeCampo("aliqInterestadual", e.target.value); }}
                      style={{ width:"100%", background:"var(--surface)", border:"1px solid var(--border)", color:"var(--text-strong)", padding:"7px 10px", borderRadius:8, fontSize:13, outline:"none" }} />
                    <span style={{ fontSize:12, color:"var(--text-3)" }}>%</span>
                  </div>
                  <div style={{ fontSize:9, color:"var(--text-4)", marginTop:2 }}>Alíquota interestadual</div>
                </div>
              </div>
              <div style={{ fontSize:11, color:"var(--text-3)", marginTop:10, lineHeight:1.5 }}>
                {regime.ativo === false
                  ? "ICMS desligado — nenhuma alíquota é descontada da margem."
                  : <>Venda entregue em <b style={{ color:"var(--text-2)" }}>{ufOrigem}</b>: <b style={{ color: (parseFloat(regime.aliqInterna) || 0) > 0 ? FIN_COR.saida : "var(--text-3)" }}>{(parseFloat(regime.aliqInterna) || 0).toFixed(2).replace(".", ",")}%</b> · venda para <b style={{ color:"var(--text-2)" }}>qualquer outro estado</b>: <b style={{ color: (parseFloat(regime.aliqInterestadual) || 0) > 0 ? FIN_COR.saida : "var(--text-3)" }}>{(parseFloat(regime.aliqInterestadual) || 0).toFixed(2).replace(".", ",")}%</b>. Anúncios e Precificação, que ainda não têm comprador, projetam pela alíquota interestadual.</>}
              </div>
            </div>
          ) : !showIcmsTable ? (
            <>
            <div style={{ display:"flex", justifyContent:"flex-end", gap:6, marginBottom:8 }}>
              <button onClick={resetIcmsPadrao}
                style={{ fontSize:10, color:"var(--text-2)", background:"var(--surface)", border:"1px solid var(--border)", padding:"3px 8px", borderRadius:6, cursor:"pointer", fontWeight:600 }}>
                ↺ Usar alíquotas padrão
              </button>
              <button onClick={function(){ setShowIcmsTable(function(v){return !v;}); }}
                style={{ fontSize:10, color:"var(--text-2)", background:"var(--bg-2)", border:"1px solid var(--border)", padding:"3px 8px", borderRadius:6, cursor:"pointer", fontWeight:600 }}>
                ▼ Ver/editar todos os 27 estados
              </button>
            </div>
            <div style={{ display:"flex", alignItems:"center", gap:14, background:"var(--bg-2)", border:"1px solid var(--border)", borderRadius:10, padding:"10px 14px" }}>
              <div>
                <div style={{ fontSize:10, color:"var(--text-3)" }}>Estados configurados</div>
                <div style={{ fontSize:16, fontWeight:600, color:"var(--text-strong)" }}>{ufsConfigurados.length}/27</div>
              </div>
              <div style={{ width:1, height:28, background:"var(--surface-3)" }} />
              <div>
                <div style={{ fontSize:10, color:"var(--text-3)" }}>Alíquota média configurada</div>
                <div style={{ fontSize:16, fontWeight:600, color: icmsMedioRef > 0 ? FIN_COR.saida : "var(--text-3)" }}>{icmsMedioRef.toFixed(2)}%</div>
              </div>
              {ufsConfigurados.length===0 && (
                <div style={{ fontSize:11, color:"#FFC107", marginLeft:"auto" }}>⚠️ Clique em "Usar alíquotas padrão" para começar</div>
              )}
            </div>
            </>
          ) : (
            <>
            <div style={{ display:"flex", justifyContent:"flex-end", gap:6, marginBottom:8 }}>
              <button onClick={resetIcmsPadrao}
                style={{ fontSize:10, color:"var(--text-2)", background:"var(--surface)", border:"1px solid var(--border)", padding:"3px 8px", borderRadius:6, cursor:"pointer", fontWeight:600 }}>
                ↺ Usar alíquotas padrão
              </button>
              <button onClick={function(){ setShowIcmsTable(function(v){return !v;}); }}
                style={{ fontSize:10, color:"var(--text-2)", background:"var(--bg-2)", border:"1px solid var(--border)", padding:"3px 8px", borderRadius:6, cursor:"pointer", fontWeight:600 }}>
                ▲ Ocultar tabela
              </button>
            </div>
            <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:8, maxHeight:340, overflowY:"auto", padding:2 }}>
              {ESTADOS_BR_ICMS.map(function(e){
                var uf = e[0], nome = e[1], padrao = e[2];
                var valorAtual = icmsConfig[uf] !== undefined ? icmsConfig[uf] : "";
                return (
                  <div key={uf} style={{ display:"flex", alignItems:"center", gap:6, background:"var(--bg-2)", border:"1px solid var(--border)", borderRadius:8, padding:"6px 10px" }}>
                    <span style={{ fontSize:11, fontWeight:500, color:"var(--text-strong)", width:26, flexShrink:0 }}>{uf}</span>
                    <span style={{ fontSize:10, color:"var(--text-3)", flex:1, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{nome}</span>
                    <input type="number" step="0.1" placeholder={String(padrao)} value={valorAtual}
                      onChange={function(ev){ setIcmsEstado(uf, ev.target.value); }}
                      style={{ width:50, background:"var(--surface)", border:"1px solid var(--border)", color:"var(--text-strong)", padding:"3px 5px", borderRadius:6, fontSize:11, outline:"none", textAlign:"center" }} />
                    <span style={{ fontSize:10, color:"var(--text-3)" }}>%</span>
                  </div>
                );
              })}
            </div>
            </>
          )}
        </div>
      </div>

      {/* ── CUSTOS FIXOS DETALHADOS ── */}
      <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:14, overflow:"hidden" }}>
        <div style={{ background:"var(--surface-3)", padding:"10px 14px", borderBottom:"1px solid var(--border)", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
          <div>
            <div style={{ fontWeight:600, fontSize:14, color:"var(--text-strong)" }}>Custos fixos</div>
            <div style={{ fontSize:11, color:"var(--text-3)", marginTop:1 }}>Aluguel, salários, assinaturas, sistemas...</div>
          </div>
          <div style={{ textAlign:"right" }}>
            <div style={{ fontSize:11, color:"var(--text-3)" }}>Total mensal</div>
            <div style={{ fontSize:17, fontWeight:600, color: totalFix > 0 ? FIN_COR.saida : "var(--text-3)" }}>{fmt(totalFix)}</div>
          </div>
        </div>
        <div style={{ padding:"12px 18px" }}>
          {custosFixos.length === 0
            ? <div style={{ fontSize:12, color:"var(--text-3)", padding:"8px 0", textAlign:"center" }}>Nenhum custo fixo cadastrado — adicione abaixo com o valor real (R$) de cada item</div>
            : (
              <div>
                <div style={{ display:"flex", gap:8, padding:"4px 0 8px", borderBottom:"1px solid var(--border)", fontSize:10, color:"var(--text-3)", fontWeight:500, textTransform:"none" }}>
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
                  style={{ padding:"7px 10px", border:"none", cursor:"pointer", fontSize:12, fontWeight:500,
                    background: novoCusto.tipo===t?"#768692":"var(--surface)", color: novoCusto.tipo===t?"#fff":"var(--text-2)" }}>{t}</button>;
              })}
            </div>
            <input type="number" step="0.01" value={novoCusto.valor} onChange={function(e){setNovoCusto(function(s){return Object.assign({},s,{valor:e.target.value});});}}
              placeholder={novoCusto.tipo==="R$" ? "0,00" : "0"}
              style={{ width:90, background:"var(--bg-2)", border:"1px solid var(--border)", color:"var(--text-strong)", padding:"7px 10px", borderRadius:8, fontSize:12, outline:"none", flexShrink:0 }} />
            <button onClick={addCusto} disabled={!novoCusto.nome||!novoCusto.valor}
              style={{ background: (novoCusto.nome&&novoCusto.valor)?"#768692":"var(--surface-3)", border:"none", color:(novoCusto.nome&&novoCusto.valor)?"#fff":"var(--text-3)",
                fontWeight:500, padding:"7px 16px", borderRadius:8, cursor:(novoCusto.nome&&novoCusto.valor)?"pointer":"not-allowed", fontSize:12, flexShrink:0 }}>+ Adicionar</button>
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
  const [colapsado, setColapsado] = useState(false);
  return (
    <div style={{ display:"flex", gap:0, minHeight:"calc(100vh - 180px)" }}>
      {/* Painel lateral de filtros — retrátil */}
      {filtros && (colapsado ? (
        <div style={{ width:36, flexShrink:0, background:"var(--bg-2)", borderRight:"1px solid var(--border-soft)", padding:"8px 4px", display:"flex", flexDirection:"column", alignItems:"center", gap:8 }}>
          <button onClick={function(){ setColapsado(false); }} title="Mostrar filtros"
            style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:8, color:"var(--text-2)", cursor:"pointer", padding:"6px 5px", fontSize:14, lineHeight:1 }}>›</button>
          <div style={{ writingMode:"vertical-rl", transform:"rotate(180deg)", fontSize:11, color:"var(--text-3)", fontWeight:600, letterSpacing:.6 }}>Filtros</div>
        </div>
      ) : (
        <div style={{ width:168, flexShrink:0, background:"var(--bg-2)", borderRight:"1px solid var(--border-soft)", padding:"8px 8px", display:"flex", flexDirection:"column", gap:10 }}>
          <button onClick={function(){ setColapsado(true); }} title="Recolher filtros"
            style={{ alignSelf:"flex-end", background:"none", border:"none", color:"var(--text-3)", cursor:"pointer", fontSize:15, padding:"0 4px", lineHeight:1 }}>‹</button>
          {filtros}
        </div>
      ))}
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
        <div style={{ fontSize:9, color:"#b0b8c4", fontWeight:500, textTransform:"none", letterSpacing:0.7, marginBottom:4 }}>{titulo}</div>
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
    "FULL": { bg:"rgba(118,134,146,.22)", color:"#768692", label:"FULL" },
    "Flex": { bg:"rgba(118,133,146,.18)", color:"#768592", label:"Flex" },
    "ME2":  { bg:"rgba(0,240,255,.25)", color:"#0e7490", label:"ME2" },
    "ME1":  { bg:"rgba(0,200,83,.18)", color:"var(--ui-accent)", label:"ME1" },
  }[tipo];
  if (!cfg) return null;
  return (
    <span style={{ fontSize:10, fontWeight:500, padding:"2px 7px", borderRadius:5,
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
        <div style={{ fontSize:10, color:"var(--text-3)", marginBottom:4, fontWeight:600, textTransform:"none" }}>Marketplace</div>
        <div style={{ display:"flex", gap:6 }}>
          {[{k:"ml",l:"🟡 Mercado Livre",c:"#FFC107"},{k:"shopee",l:"🛒 Shopee",c:"#EE4D2D"}].map(function(m){
            var a=f.marketplace===m.k;
            return <button key={m.k} onClick={function(){ set("marketplace",m.k); }}
              style={{ flex:1, background:a?m.c:"var(--surface)", color:a?"#fff":"var(--text-2)", border:"1px solid "+(a?m.c:"var(--border)"), borderRadius:8, padding:"8px", fontSize:12, fontWeight:500, cursor:"pointer" }}>{m.l}</button>;
          })}
        </div>
      </div>
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
        <div>
          <div style={{ fontSize:10, color:"var(--text-3)", marginBottom:3, fontWeight:600, textTransform:"none" }}>Nome do Produto *</div>
          <input value={f.nome} onChange={function(e){set("nome",e.target.value);}} placeholder="Ex: Lanterna Traseira Uno"
            style={{ width:"100%", background:"var(--bg-2)", border:"1px solid var(--border)", color:"var(--text-strong)", padding:"8px 10px", borderRadius:8, fontSize:12, outline:"none" }} />
        </div>
        <div>
          <div style={{ fontSize:10, color:"var(--text-3)", marginBottom:3, fontWeight:600, textTransform:"none" }}>SKU *</div>
          <input value={f.sku} onChange={function(e){set("sku",e.target.value);}} placeholder="Ex: 1234"
            style={{ width:"100%", background:"var(--bg-2)", border:"1px solid var(--border)", color:"var(--text-strong)", padding:"8px 10px", borderRadius:8, fontSize:12, outline:"none", fontFamily:"monospace" }} />
        </div>
        <div>
          <div style={{ fontSize:10, color:"var(--text-3)", marginBottom:3, fontWeight:600, textTransform:"none" }}>Custo (R$)</div>
          <input type="number" step="0.01" value={f.custo} onChange={function(e){set("custo",e.target.value);}} placeholder="0,00"
            style={{ width:"100%", background:"var(--bg-2)", border:"1px solid var(--border)", color:"var(--text-strong)", padding:"8px 10px", borderRadius:8, fontSize:12, outline:"none" }} />
        </div>
        <div>
          <div style={{ fontSize:10, color:"var(--text-3)", marginBottom:3, fontWeight:600, textTransform:"none" }}>Preço de Venda (R$)</div>
          <input type="number" step="0.01" value={f.precoVenda} onChange={function(e){set("precoVenda",e.target.value);}} placeholder="0,00"
            style={{ width:"100%", background:"var(--bg-2)", border:"1px solid var(--border)", color:"var(--text-strong)", padding:"8px 10px", borderRadius:8, fontSize:12, outline:"none" }} />
        </div>
        <div>
          <div style={{ fontSize:10, color:"var(--text-3)", marginBottom:3, fontWeight:600, textTransform:"none" }}>Frete (R$)</div>
          <input type="number" step="0.01" value={f.frete} onChange={function(e){set("frete",e.target.value);}} placeholder="0,00"
            style={{ width:"100%", background:"var(--bg-2)", border:"1px solid var(--border)", color:"var(--text-strong)", padding:"8px 10px", borderRadius:8, fontSize:12, outline:"none" }} />
        </div>
        <div>
          <div style={{ fontSize:10, color:"var(--text-3)", marginBottom:3, fontWeight:600, textTransform:"none" }}>{ehShopee ? "Taxa Shopee" : "Taxa ML (%)"}</div>
          {ehShopee ? (
            <div style={{ background:"var(--bg-2)", border:"1px solid rgba(238,77,45,.35)", color:"#EE4D2D", padding:"8px 10px", borderRadius:8, fontSize:12, fontWeight:500 }}>
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
          <div><div style={{ fontSize:10, color:"var(--text-3)" }}>Lucro</div><div style={{ fontWeight:500, color:lucro>=0?"#0e7490":"#FF5252" }}>R$ {lucro.toFixed(2).replace(".",",")}</div></div>
          <div><div style={{ fontSize:10, color:"var(--text-3)" }}>Margem</div><div style={{ fontWeight:500, color:mCor }}>{margem.toFixed(1)}%</div></div>
          <div><div style={{ fontSize:10, color:"var(--text-3)" }}>Taxa {ehShopee?"Shopee":"ML"}</div><div style={{ fontWeight:500, color:"#FF5252" }}>R$ {taxa.toFixed(2).replace(".",",")}</div></div>
        </div>
      )}
      <div style={{ display:"flex", gap:8, marginTop:4 }}>
        <button onClick={onClose} style={{ flex:1, background:"var(--bg-2)", border:"1px solid var(--border)", color:"var(--text-2)", fontWeight:600, padding:"9px", borderRadius:9, cursor:"pointer" }}>Cancelar</button>
        <button onClick={function(){ if(f.nome&&f.sku) onSave(f); }} disabled={!f.nome||!f.sku}
          style={{ flex:2, background:f.nome&&f.sku?"#768592":"var(--surface-3)", border:"none", color:f.nome&&f.sku?"#fff":"var(--text-3)", fontWeight:500, padding:"9px", borderRadius:9, cursor:f.nome&&f.sku?"pointer":"not-allowed" }}>
          Salvar e Acompanhar
        </button>
      </div>
    </div>
  );
}

function PrecificacaoTab({ enriched, costs, setCostsAndSave, fretesConfig, setFretesAndSave, descontosConfig, setDescontosAndSave, precosVendaConfig, setPrecosVendaAndSave, pendentesAtualizacao, setPendentesAndSave, setSkuOverridesAndSave, rawOrders, icmsPct, buscaInicial, custosExtras, setCustosExtrasAndSave }) {
  // ICMS projetado da venda (Financeiro → Impostos). Aqui ainda não há comprador, então vale a
  // alíquota interestadual — o cenário da maior parte das vendas e o mais conservador no preço.
  var icmsVendaPct = parseFloat(icmsPct) || 0;
  const [busca, setBusca] = useState(buscaInicial || "");
  const [buscaTipo, setBuscaTipo] = useState("all"); // all | title | sku | mlb
  // Chegou pela tela de Tendências: aplica o filtro do produto escolhido lá.
  useEffect(function(){ if (buscaInicial) setBusca(buscaInicial); }, [buscaInicial]);
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
  const [editingCustoExtra, setEditingCustoExtra] = useState(null); // "<id>|icms" | "<id>|etiqueta" | "<id>|embalagem"
  // Seleção para exclusão em massa. Só produtos precificados aqui (extras) podem
  // ser excluídos — anúncio do ML vem do marketplace e não se apaga por aqui.
  const [selecionados, setSelecionados] = useState([]);

  function alternarSelecao(id) {
    setSelecionados(function(atual) {
      return atual.includes(id) ? atual.filter(function(x){ return x !== id; }) : atual.concat([id]);
    });
  }
  function custoExtraDe(id) {
    var c = (custosExtras || {})[id] || {};
    return {
      icms: parseFloat(c.icms) || 0,
      etiqueta: parseFloat(c.etiqueta) || 0,
      embalagem: parseFloat(c.embalagem) || 0,
    };
  }
  function salvarCustoExtra(id, campo, valor) {
    setCustosExtrasAndSave(function(prev) {
      var atual = Object.assign({}, prev[id] || {});
      if (valor > 0) atual[campo] = valor; else delete atual[campo];
      var next = Object.assign({}, prev);
      // Sem nenhum dos três, a entrada sai do mapa em vez de virar objeto vazio.
      if (Object.keys(atual).length) next[id] = atual; else delete next[id];
      return next;
    });
  }
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
      }); // sem fallback "qualquer tipo": só absorve quando SKU + tipo (Clássico/Premium) batem
      if (!match) { restantes.push(p); return; }
      absorvidos++;
      // Transfere a precificação do produto novo para o anúncio (só se o anúncio ainda não tiver).
      var custoExtra = parseFloat(p.custo) || parseFloat(costs && costs[p.id]) || 0;
      if (custoExtra > 0) addCosts[match.id] = custoExtra;
      if (p.precoVenda) addPrecos[match.id] = p.precoVenda;
      var descExtra = descontosConfig && descontosConfig[p.id];
      if (descExtra) addDesc[match.id] = descExtra;
      if (p.frete) addFretes[match.id] = parseFloat(p.frete) || 0;
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
    var mkt = "ml", precoAtual, titulo, sku = "", tipoPrem = false;
    if (listing) {
      precoAtual = listing.price; titulo = listing.title; mkt = "ml"; sku = listing.seller_sku || listing.sku || ""; tipoPrem = (listing.listing_type_id==="gold_pro"||listing.listing_type_id==="gold_premium");
    } else {
      var extra = (produtosExtras||[]).find(function(p){ return p.id===id; });
      if (!extra) return;
      precoAtual = parseFloat(extra.precoVenda) || 0; titulo = extra.nome; mkt = extra.marketplace || "ml"; sku = extra.sku || ""; tipoPrem = parseFloat(extra.taxaMl||12) >= 17;
    }
    var next = Object.assign({}, pendentesAtualizacao);
    if (novoPreco > 0 && novoPreco !== precoAtual) {
      // Guarda sku/tipo NA pendência para não depender do item ainda existir (evita "SKU —").
      next[id] = { precoAntigo: precoAtual, precoNovo: novoPreco, data: new Date().toISOString(), titulo: titulo, marketplace: mkt, sku: sku, tipoPrem: tipoPrem };
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
    // ICMS incide sobre o preço de venda — entra no lucro e no preço alvo junto com a taxa do
    // marketplace, senão a margem alvo sai furada na alíquota do imposto.
    var icmsValor = precoBase * (icmsVendaPct / 100);
    var lucro = precoBase - custo - frete - taxaBase - icmsValor;
    var margem = precoBase > 0 ? (lucro / precoBase) * 100 : 0;
    var deducoesPct = (taxaBase / precoBase || 0.13) + (icmsVendaPct / 100);
    var divisor = 1 - (margemAlvo / 100) - deducoesPct;
    var precoAlvo = custo > 0 && divisor > 0 ? (custo + frete) / divisor : 0;
    return { lucro, margem, precoAlvo, taxaBase, icmsValor };
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
          <div style={{ fontWeight:600, fontSize:20, color:"var(--text-strong)", marginBottom:4 }}>💲 Precificação</div>
          <div style={{ fontSize:13, color:"var(--text-2)" }}>
            Calcule o preço ideal para cada anúncio com base na margem desejada
          </div>
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:7, background:"var(--bg-2)", border:"1px solid var(--border)", borderRadius:10, padding:"10px 16px" }}>
          <span style={{ fontSize:13, color:"var(--text-2)", fontWeight:600 }}>Margem alvo:</span>
          <input type="number" min="1" max="99" value={margemAlvo} onChange={function(e){setMargemAlvo(parseFloat(e.target.value)||20);}}
            style={{ width:60, background:"var(--surface)", border:"1px solid var(--border)", color:"var(--text-strong)", padding:"6px 10px", borderRadius:8, fontSize:15, fontWeight:500, outline:"none", textAlign:"center" }} />
          <span style={{ fontSize:15, fontWeight:500, color:"var(--text-strong)" }}>%</span>
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
                    padding:"3px 12px", fontSize:11, fontWeight:500, cursor:"pointer" }}>{d}</button>
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
            <div style={{ fontSize:13, fontWeight:500, color:"#FFC107" }}>
              ⚠️ {pendentesDoMkt.length} anúncio(s) com preço pendente de atualização {nomeMkt}
            </div>
          </div>
          <div style={{ display:"flex", flexDirection:"column", gap:6, maxHeight:160, overflowY:"auto" }}>
            {pendentesDoMkt.map(function([id, p]){
              var listingRef = (enriched||[]).find(function(l){ return l.id===id; });
              var extraRef = (produtosExtras||[]).find(function(x){ return x.id===id; });
              var skuRef = listingRef?.sku || extraRef?.sku || p.sku || "—";
              var tipoPrem = listingRef ? (listingRef.listing_type_id==="gold_pro" || listingRef.listing_type_id==="gold_premium") : !!p.tipoPrem;
              var mostraTipo = !!(listingRef || p.tipoPrem !== undefined);
              var ehShopee = (p.marketplace || "ml") === "shopee";
              // Valor riscado = preço BRUTO (anunciar por): o preço de venda desejado (precoNovo)
              // acrescido do % de desconto da promoção, mesma fórmula da coluna "Anunciar por".
              var descItem = parseFloat(descontosConfig && descontosConfig[id] || 0);
              var precoBruto = descItem > 0 ? p.precoNovo / (1 - descItem/100) : p.precoNovo;
              return (
                <div key={id} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", background:"var(--surface)", border:"1px solid rgba(255,193,7,.35)", borderRadius:8, padding:"7px 12px" }}>
                  <div style={{ flex:1, minWidth:0, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", fontSize:12, color:"var(--text-strong)" }}>
                    <span style={{ fontWeight:500, color:"#FFC107", marginRight:6 }}>SKU {skuRef}</span>
                    {mostraTipo && (
                      <span style={{ fontSize:9, fontWeight:500, padding:"1px 6px", borderRadius:4, marginRight:6, whiteSpace:"nowrap",
                        background: tipoPrem?"rgba(118,133,146,.18)":"rgba(118,134,146,.18)",
                        color: tipoPrem?"#a78bfa":"#768692" }}>
                        {tipoPrem?"⭐ Premium 17%":"📋 Clássico 12%"}
                      </span>
                    )}
                    {p.titulo}
                  </div>
                  <div style={{ display:"flex", alignItems:"center", gap:10, flexShrink:0 }}>
                    {precoBruto > p.precoNovo + 0.001 && (
                      <span style={{ fontSize:11, color:"var(--text-3)", textDecoration:"line-through" }}>R$ {precoBruto.toFixed(2).replace(".",",")}</span>
                    )}
                    <span style={{ fontSize:12, fontWeight:500, color:"#768592" }}>→ R$ {p.precoNovo.toFixed(2).replace(".",",")}</span>
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
                      style={{ background:"var(--ui-accent)", border:"none", color:"var(--ui-accent-text)", fontWeight:500, padding:"4px 10px", borderRadius:6, cursor:"pointer", fontSize:11, whiteSpace:"nowrap" }}>
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
          style={{ background:"#768592", border:"none", color:"#fff", fontWeight:500, padding:"9px 14px", borderRadius:9, cursor:"pointer", fontSize:12, whiteSpace:"nowrap", flexShrink:0 }}>
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
            <div style={{ fontWeight:500, fontSize:15, marginBottom:14 }}>+ Precificar Novo Produto</div>
            <NovoProdutoPrecForm
              marketplaceInicial={mktSel}
              shopeeDoc={shopeeDoc}
              onSave={function(p){
                var custoNum = parseFloat(p.custo) || 0;
                var skuP = (p.sku||"").trim().toLowerCase();
                var pPrem = parseFloat(p.taxaMl||12) >= 17;
                // Se o SKU JÁ é um anúncio do ML, aplica a precificação direto no anúncio (não cria
                // um "produto novo" que sumiria ao ser absorvido). Casa por SKU + tipo (Clássico/Premium).
                // Só casa quando SKU E TIPO (Clássico/Premium) batem — precificar o mesmo SKU em
                // OUTRO tipo (ex.: já existe Clássico, você quer Premium) é um item novo separado.
                var match = null;
                if (skuP && (p.marketplace||"ml") === "ml") {
                  match = (enriched||[]).find(function(l){ if (l._isExtra) return false; if ((l.seller_sku||l.sku||"").trim().toLowerCase()!==skuP) return false; var lPrem=(l.listing_type_id==="gold_pro"||l.listing_type_id==="gold_premium"); return lPrem===pPrem; });
                }
                if (match) {
                  if (custoNum > 0) setCostsAndSave(function(c){ return Object.assign({}, c, { [match.id]: custoNum }); });
                  if (p.precoVenda) setPrecosVendaAndSave(function(c){ return Object.assign({}, c, { [match.id]: p.precoVenda }); });
                  if (p.frete) setFretesAndSave(function(c){ return Object.assign({}, c, { [match.id]: parseFloat(p.frete)||0 }); });
                  setShowNovoProdutoPrec(false);
                  alert("Esse SKU já tem anúncio no Mercado Livre — a precificação foi aplicada diretamente no anúncio (SKU " + p.sku + "). Procure por ele na tabela.");
                  return;
                }
                var id = "NOVO_" + Date.now();
                saveProdutosExtras([...produtosExtras, { id:id, nome:p.nome, sku:p.sku, custo:custoNum, taxaMl:p.taxaMl, precoVenda:p.precoVenda, frete:p.frete, marketplace:p.marketplace||"ml" }]);
                if (custoNum > 0) setCostsAndSave(function(c){ return Object.assign({}, c, { [id]: custoNum }); });
                if (p.marketplace) setMktSel(p.marketplace);
                setShowNovoProdutoPrec(false);
              }}
              onClose={function(){ setShowNovoProdutoPrec(false); }}
            />
          </div>
        </div>
      )}

      {/* Produtos extras (ainda não anunciados) */}
      {selecionados.length > 0 && (
        <div style={{ display:"flex", alignItems:"center", gap:12, background:"rgba(255,82,82,.10)", border:"1px solid rgba(255,82,82,.35)", borderRadius:10, padding:"9px 14px", marginBottom:10, flexWrap:"wrap" }}>
          <span style={{ fontSize:13, fontWeight:600, color:"var(--text-strong)" }}>
            {selecionados.length} precificação(ões) selecionada(s)
          </span>
          <button onClick={function(){
              if (!window.confirm("Excluir " + selecionados.length + " precificação(ões)? Isso não mexe nos anúncios do Mercado Livre.")) return;
              var apagar = selecionados;
              saveProdutosExtras(produtosExtras.filter(function(x){ return apagar.indexOf(x.id) === -1; }));
              setSelecionados([]);
            }}
            style={{ background:"rgba(255,82,82,.15)", border:"1px solid rgba(255,82,82,.5)", color:"#FF5252", padding:"6px 14px", borderRadius:8, cursor:"pointer", fontSize:12.5, fontWeight:600, fontFamily:"inherit" }}>
            ✕ Excluir selecionados
          </button>
          <button onClick={function(){ setSelecionados([]); }}
            style={{ background:"none", border:"none", color:"var(--text-3)", cursor:"pointer", fontSize:12, fontFamily:"inherit", textDecoration:"underline" }}>
            limpar seleção
          </button>
          <span style={{ fontSize:11, color:"var(--text-3)", marginLeft:"auto" }}>
            Só produtos precificados aqui entram na seleção — anúncio do ML não se apaga por esta tela.
          </span>
        </div>
      )}

      {/* Tabela */}
      <div className="scroll-x" style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:12, overflow:"auto" }}>
        <table style={{ borderCollapse:"collapse", width:"100%", minWidth:900 }}>
          <thead>
            <tr style={{ background:"var(--bg-2)" }}>
              {[
                "sel","SKU","MLB","Tipo","Anúncio",
                "Custo","ICMS %","Etiqueta","Embalagem",
                "Preço Atual","Frete Real","Frete Config.",
                "💡 Vender por → Anunciar por","🏷 % Desc. Promoção",
                "Taxa ML (s/ desconto)",
                "Lucro Simulado","Margem Simulada","Ação"
              ].map(function(h){
                if (h === "sel") {
                  var extrasVisiveis = listsFiltrados.slice(0,200).filter(function(x){ return x._isExtra; });
                  var todosMarcados = extrasVisiveis.length > 0 &&
                    extrasVisiveis.every(function(x){ return selecionados.includes(x.id); });
                  return (
                    <th key="sel" style={{ padding:"8px 10px", borderBottom:"1px solid var(--border)", width:30 }}>
                      <input type="checkbox" checked={todosMarcados} title="Selecionar todos os produtos precificados desta lista"
                        onChange={function(e){
                          var ids = extrasVisiveis.map(function(x){ return x.id; });
                          setSelecionados(e.target.checked ? ids : []);
                        }}
                        style={{ cursor:"pointer" }} />
                    </th>
                  );
                }
                var isSimul = ["💡 Vender por → Anunciar por","Lucro Simulado","Margem Simulada","Taxa ML (s/ desconto)"].includes(h);
                return <th key={h} style={{ fontSize:10, color: isSimul?"#768592":"var(--text-2)", fontWeight:600, textTransform:"none", padding:"8px 10px", borderBottom:"1px solid var(--border)", textAlign:"left", whiteSpace:"nowrap", background: isSimul?"rgba(118,133,146,.12)":"transparent" }}>{h}</th>;
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
              // Custos preenchidos nesta tela: ICMS (% sobre o preço) e os fixos por peça.
              // O ICMS da linha, quando preenchido, vale no lugar do regime geral —
              // é uma exceção declarada para aquele produto, não um acréscimo.
              var extras = custoExtraDe(l.id);
              var icmsLinhaPct = extras.icms > 0 ? extras.icms : icmsVendaPct;
              var icmsValorLinha = precoComDesc * (icmsLinhaPct / 100);
              var custosFixosLinha = extras.etiqueta + extras.embalagem;

              // Lucro e margem com desconto, frete, ICMS e custos de embalagem/etiqueta
              var lucroFinal = precoComDesc - custo - frete - taxaSobreDesc - icmsValorLinha - custosFixosLinha;
              var margemFinal = precoComDesc > 0 ? (lucroFinal/precoComDesc)*100 : 0;
              var mCor = margemFinal >= margemAlvo ? "#0a9d4e" : margemFinal >= margemAlvo*0.6 ? "#FFC107" : "#FF5252";
              var isEditing = selectedId === l.id;
              var t = l.listing_type_id||"";
              var isPremium = t==="gold_premium"||t==="gold_pro";

              return (
                <tr key={l.id} style={{ borderBottom:"1px solid var(--border)", background: selecionados.includes(l.id) ? "rgba(255,82,82,.08)" : (i%2===0?"var(--surface)":"var(--bg-2)") }}>

                  {/* Seleção — só o que dá para excluir por aqui */}
                  <td style={{ padding:"6px 10px", width:30 }}>
                    {l._isExtra ? (
                      <input type="checkbox" checked={selecionados.includes(l.id)}
                        onChange={function(){ alternarSelecao(l.id); }}
                        style={{ cursor:"pointer" }} />
                    ) : (
                      <span title="Anúncio do Mercado Livre — não é excluído por esta tela"
                        style={{ color:"var(--text-4)", fontSize:11 }}>—</span>
                    )}
                  </td>

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
                        style={{ cursor:"pointer", fontSize:11, fontFamily:"monospace", fontWeight:500, color:"var(--text-2)", background:"var(--surface-3)", padding:"2px 6px", borderRadius:4, whiteSpace:"nowrap", display:"inline-flex", alignItems:"center", gap:4 }}>
                        {l.seller_sku||l.sku||"—"}
                        <span style={{ color:"#0e7490", fontSize:9 }}>✎</span>
                      </span>
                    )}
                  </td>

                  {/* MLB */}
                  <td style={{ padding:"6px 8px", fontSize:11, color:"#0e7490", fontFamily:"monospace" }}>
                    {l._isExtra
                      ? <span style={{ fontSize:10, fontWeight:500, color:"#FFC107", background:"rgba(255,193,7,.12)", border:"1px solid rgba(255,193,7,.35)", padding:"2px 7px", borderRadius:5, whiteSpace:"nowrap" }}>🆕 Novo</span>
                      : l.id}
                  </td>

                  {/* Tipo */}
                  <td style={{ padding:"6px 8px" }}>
                    {ehShopee ? (
                      <span style={{ fontSize:10, fontWeight:500, padding:"2px 6px", borderRadius:5, whiteSpace:"nowrap",
                        background:"rgba(238,77,45,.14)", color:"#EE4D2D", border:"1px solid rgba(238,77,45,.4)" }}>
                        🛒 Shopee
                      </span>
                    ) : (
                      <span style={{ fontSize:10, fontWeight:500, padding:"2px 6px", borderRadius:5, whiteSpace:"nowrap",
                        background: isPremium?"rgba(118,133,146,.14)":"rgba(118,134,146,.14)",
                        color: isPremium?"#768592":"#768692",
                        border:"1px solid "+(isPremium?"rgba(118,133,146,.35)":"rgba(118,134,146,.35)") }}>
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

                  {/* ICMS % — editável por anúncio */}
                  <td style={{ padding:"6px 8px" }}>
                    {editingCustoExtra === l.id + "|icms" ? (
                      <input type="number" step="0.01" min="0" defaultValue={extras.icms || ""} placeholder="0,00" autoFocus
                        onBlur={function(e){ salvarCustoExtra(l.id, "icms", parseFloat(e.target.value)||0); setEditingCustoExtra(null); }}
                        style={{ width:58, background:"var(--surface)", border:"1px solid #0e7490", color:"var(--text-strong)", padding:"3px 6px", borderRadius:6, fontSize:12, outline:"none" }} />
                    ) : (
                      <span onClick={function(){ setEditingCustoExtra(l.id + "|icms"); }}
                        title={extras.icms > 0 ? "ICMS deste produto" : "Sem valor aqui, vale o ICMS configurado em Impostos (" + icmsVendaPct.toFixed(2).replace(".",",") + "%)"}
                        style={{ cursor:"pointer", fontSize:12, fontWeight:600,
                          color: extras.icms > 0 ? "#FF5252" : "var(--text-3)",
                          background: extras.icms > 0 ? "transparent" : "var(--bg-2)",
                          padding: extras.icms > 0 ? "0" : "2px 6px", borderRadius:4, whiteSpace:"nowrap" }}>
                        {extras.icms > 0 ? extras.icms.toFixed(2).replace(".",",")+"%" : "✎ definir"}
                      </span>
                    )}
                  </td>

                  {/* Custo de etiqueta — editável por anúncio */}
                  <td style={{ padding:"6px 8px" }}>
                    {editingCustoExtra === l.id + "|etiqueta" ? (
                      <input type="number" step="0.01" min="0" defaultValue={extras.etiqueta || ""} placeholder="0,00" autoFocus
                        onBlur={function(e){ salvarCustoExtra(l.id, "etiqueta", parseFloat(e.target.value)||0); setEditingCustoExtra(null); }}
                        style={{ width:64, background:"var(--surface)", border:"1px solid #0e7490", color:"var(--text-strong)", padding:"3px 6px", borderRadius:6, fontSize:12, outline:"none" }} />
                    ) : (
                      <span onClick={function(){ setEditingCustoExtra(l.id + "|etiqueta"); }} title="Custo de etiqueta por peça"
                        style={{ cursor:"pointer", fontSize:12, fontWeight:600,
                          color: extras.etiqueta > 0 ? "#FFC107" : "var(--text-3)",
                          background: extras.etiqueta > 0 ? "transparent" : "var(--bg-2)",
                          padding: extras.etiqueta > 0 ? "0" : "2px 6px", borderRadius:4, whiteSpace:"nowrap" }}>
                        {extras.etiqueta > 0 ? "R$ "+extras.etiqueta.toFixed(2).replace(".",",") : "✎ definir"}
                      </span>
                    )}
                  </td>

                  {/* Custo de embalagem — editável por anúncio */}
                  <td style={{ padding:"6px 8px" }}>
                    {editingCustoExtra === l.id + "|embalagem" ? (
                      <input type="number" step="0.01" min="0" defaultValue={extras.embalagem || ""} placeholder="0,00" autoFocus
                        onBlur={function(e){ salvarCustoExtra(l.id, "embalagem", parseFloat(e.target.value)||0); setEditingCustoExtra(null); }}
                        style={{ width:64, background:"var(--surface)", border:"1px solid #0e7490", color:"var(--text-strong)", padding:"3px 6px", borderRadius:6, fontSize:12, outline:"none" }} />
                    ) : (
                      <span onClick={function(){ setEditingCustoExtra(l.id + "|embalagem"); }} title="Custo de embalagem por peça"
                        style={{ cursor:"pointer", fontSize:12, fontWeight:600,
                          color: extras.embalagem > 0 ? "#FFC107" : "var(--text-3)",
                          background: extras.embalagem > 0 ? "transparent" : "var(--bg-2)",
                          padding: extras.embalagem > 0 ? "0" : "2px 6px", borderRadius:4, whiteSpace:"nowrap" }}>
                        {extras.embalagem > 0 ? "R$ "+extras.embalagem.toFixed(2).replace(".",",") : "✎ definir"}
                      </span>
                    )}
                  </td>

                  {/* Preço Atual */}
                  <td style={{ padding:"6px 8px", fontSize:12, fontWeight:500, color:"var(--text-strong)", whiteSpace:"nowrap" }}>
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
                  <td style={{ padding:"6px 8px", background:"rgba(118,133,146,.12)" }}>
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
                            style={{ width:78, background:"var(--surface)", border:"1px solid #768592", color:"var(--text-strong)", padding:"3px 6px", borderRadius:6, fontSize:12, outline:"none", textAlign:"right" }} />
                        </div>
                      </div>
                    ) : (
                      <div onClick={function(){ setEditingPrecoId(l.id); }} title="Clique para definir o preço de venda que você quer receber (já com desconto) — o sistema calcula o preço a anunciar" style={{ cursor:"pointer" }}>
                        {precoVendaDesejado > 0 ? (
                          <div>
                            <span style={{ fontSize:13, fontWeight:600, color:"#768592" }}>
                              📢 R$ {precoParaAnunciar.toFixed(2).replace(".",",")}
                            </span>
                            <div style={{ fontSize:10, color:"var(--text-2)" }}>
                              vender por R$ {precoVendaDesejado.toFixed(2).replace(".",",")}
                              {descPct > 0 && <span style={{ color:"var(--text-3)" }}> (-{descPct}%)</span>}
                            </div>
                            {pendentesAtualizacao[l.id] && (
                              <div style={{ fontSize:9, fontWeight:500, color:"#FFC107", background:"rgba(255,193,7,.12)", border:"1px solid rgba(255,193,7,.35)", padding:"1px 5px", borderRadius:4, marginTop:2, display:"inline-block" }}>
                                ⏳ pendente {(pendentesAtualizacao[l.id].marketplace || "ml") === "shopee" ? "Shopee" : "ML"}
                              </div>
                            )}
                          </div>
                        ) : (
                          <span style={{ fontSize:11, color:"var(--text-3)", background:"rgba(118,133,146,.14)", border:"1px dashed rgba(118,133,146,.35)", padding:"2px 7px", borderRadius:5 }}>
                            ✎ simular
                          </span>
                        )}
                      </div>
                    )}
                  </td>

                  {/* 🏷 % Desconto Promoção */}
                  <td style={{ padding:"6px 8px", background:"rgba(118,133,146,.12)" }}>
                    {editingDescId === l.id ? (
                      <div style={{ display:"flex", alignItems:"center", gap:3 }}>
                        <input type="number" min="0" max="80" step="1"
                          defaultValue={descPct||""}
                          placeholder="0"
                          autoFocus
                          onBlur={function(e){ var v=Math.min(80,Math.max(0,parseFloat(e.target.value)||0)); setDesconto(l.id,v); setEditingDescId(null); }}
                          onKeyDown={function(e){ if(e.key==="Enter"||e.key==="Escape") e.target.blur(); }}
                          style={{ width:46, background:"var(--surface)", border:"1px solid #768592", color:"var(--text-strong)", padding:"3px 6px", borderRadius:6, fontSize:12, outline:"none", textAlign:"center" }} />
                        <span style={{ fontSize:11, color:"var(--text-3)" }}>%</span>
                      </div>
                    ) : (
                      <div onClick={function(){ setEditingDescId(l.id); }} title="% de desconto na promoção" style={{ cursor:"pointer" }}>
                        {descPct > 0 ? (
                          <div>
                            <span style={{ fontSize:12, fontWeight:500, color:"#768592", background:"rgba(118,133,146,.14)", padding:"2px 7px", borderRadius:5 }}>
                              {descPct}%
                            </span>
                            <div style={{ fontSize:10, color:"#768592", marginTop:1 }}>
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
                  <td style={{ padding:"6px 8px", background:"rgba(118,133,146,.12)" }}>
                    <div style={{ fontSize:12, fontWeight:500, color:"#FF5252" }}>
                      R$ {taxaSobreDesc.toFixed(2).replace(".",",")}
                    </div>
                    {ehShopee ? (() => {
                      var f = taxaShopeeFaixa(precoComDesc);
                      return (
                        <>
                          <div style={{ fontSize:10, color:"var(--text-3)" }}>
                            {(f.pct*100).toFixed(0)}% + R$ {f.fixo}{shopeeDoc==="CPF" ? " + R$3" : ""}
                          </div>
                          <div title="Taxa da Shopee 2026 por faixa de preço" style={{ fontSize:9, fontWeight:500, color:"#EE4D2D", marginTop:1 }}>
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
                          style={{ fontSize:9, fontWeight:500, color: isPremium?"#768592":"#768692", marginTop:1 }}>
                          {isPremium ? "Premium 17%" : "Clássico 12%"}
                        </div>
                      </>
                    )}
                  </td>

                  {/* Lucro Simulado (com desconto se houver) */}
                  <td style={{ padding:"6px 8px", background:"rgba(118,133,146,.12)" }}>
                    {custo > 0 ? (
                      <div>
                        <span style={{ fontSize:13, fontWeight:500, color:lucroFinal>=0?"#0e7490":"#FF5252" }}>
                          R$ {lucroFinal.toFixed(2).replace(".",",")}
                        </span>
                        {descPct > 0 && (
                          <div style={{ fontSize:10, color:"var(--text-3)", marginTop:1 }}>c/ {descPct}% desc</div>
                        )}
                      </div>
                    ) : <span style={{color:"var(--text-3)",fontSize:11}}>—</span>}
                  </td>

                  {/* Margem Simulada */}
                  <td style={{ padding:"6px 8px", background:"rgba(118,133,146,.12)" }}>
                    {custo > 0 ? (
                      <span style={{ fontSize:13, fontWeight:500, color:mCor, background:mCor+"18", padding:"3px 8px", borderRadius:6, display:"inline-block" }}>
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
                          style={{ fontSize:10, color:"#768592", textDecoration:"none", fontWeight:600 }}>
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
          <div style={{ fontWeight:600, fontSize:18, color:"var(--text-strong)" }}>🔎 Concorrência — melhorias do anúncio</div>
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
            style={{ background: analisando?"var(--surface-3)":"#768692", border:"none", color:"#fff", fontWeight:500, padding:"9px 18px", borderRadius:8, cursor:analisando?"wait":"pointer", fontSize:13 }}>
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
              <div style={{ fontFamily:"'JetBrains Mono',monospace", fontSize:10, color:"var(--text-3)", fontWeight:500, textTransform:"none", letterSpacing:".12em" }}>{c.label}</div>
              <div style={{ fontSize:24, fontWeight:600, color:c.cor, marginTop:4 }}>{c.valor}</div>
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
              style={{ background:ativo?"#768692":"var(--surface)", color:ativo?"#fff":"var(--text-2)", border:"1px solid "+(ativo?"#768692":"var(--border)"), borderRadius:20, padding:"5px 14px", fontSize:12, fontWeight:600, cursor:"pointer" }}>
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
                      ? <span style={{ fontSize:12, fontWeight:500, color:"var(--ui-accent)" }}>✓ otimizado</span>
                      : <span style={{ fontSize:13, fontWeight:600, color:corQtd }}>{qtd} melhoria{qtd>1?"s":""} {aberto ? "▲" : "▼"}</span>}
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
                            {p.tipo==="lider" && <span style={{ marginLeft:8, fontSize:9, fontFamily:"'JetBrains Mono',monospace", color:"#FFC107", border:"1px solid rgba(255,193,7,.35)", borderRadius:6, padding:"1px 5px", textTransform:"none", letterSpacing:".08em" }}>concorrente</span>}
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

// Rótulo de data estilo WhatsApp para os separadores do chat.
function rotuloDataChat(iso){
  var d = new Date(iso);
  var hoje = new Date(); var ontem = new Date(); ontem.setDate(hoje.getDate()-1);
  function ymd(x){ return x.getFullYear()+"-"+x.getMonth()+"-"+x.getDate(); }
  if (ymd(d)===ymd(hoje)) return "Hoje";
  if (ymd(d)===ymd(ontem)) return "Ontem";
  return d.toLocaleDateString("pt-BR", { day:"2-digit", month:"2-digit", year:"numeric" });
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
  // Fechar o chat com a tecla Esc.
  useEffect(function(){
    if (!open) return;
    function onKey(e){ if (e.key === "Escape") setOpen(false); }
    window.addEventListener("keydown", onKey);
    return function(){ window.removeEventListener("keydown", onKey); };
  }, [open]);

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
    sincronizarUsuariosDoServidor().then(function(r){
      setUsuarios((r.usuarios || []).filter(function(u){ return u.ativo; }));
    });
  }, []);

  // Atualiza a lista de usuários periodicamente também (não só ao abrir o widget)
  useEffect(function(){
    var userInterval = setInterval(function(){
      sincronizarUsuariosDoServidor().then(function(r){
        setUsuarios((r.usuarios || []).filter(function(u){ return u.ativo; }));
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
          background:"#768692", border:"none", color:"#FFC107", fontSize:24, cursor:"pointer",
          boxShadow:"0 6px 20px rgba(0,0,0,.25)", zIndex:500, display: open?"none":"flex",
          alignItems:"center", justifyContent:"center" }}>
        💬
        {(naoLidas>0||tarefasMinhas>0) && (
          <span style={{ position:"absolute", top:-4, right:-4, background:"#FF5252", color:"#fff",
            fontSize:11, fontWeight:500, borderRadius:10, minWidth:20, height:20, display:"flex",
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
          <div style={{ background:"#768692", padding:"12px 16px", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
            <div style={{ color:"#fff", fontWeight:500, fontSize:14 }}>💬 Chat da Equipe</div>
            <button onClick={function(){setOpen(false);}} title="Fechar (Esc)"
              style={{ background:"rgba(255,255,255,.18)", border:"none", color:"#fff", fontSize:17, cursor:"pointer", width:30, height:30, borderRadius:8, display:"flex", alignItems:"center", justifyContent:"center", lineHeight:1, fontWeight:700 }}>✕</button>
          </div>

          {/* Sub-abas */}
          <div style={{ display:"flex", borderBottom:"1px solid var(--border)" }}>
            {[{k:"conversa",l:"💬 Conversa"},{k:"tarefas",l:"✓ Tarefas"+(tarefasMinhas>0?" ("+tarefasMinhas+")":"")}].map(function(t){
              var a = aba===t.k;
              return <button key={t.k} onClick={function(){setAba(t.k);}}
                style={{ flex:1, padding:"9px", border:"none", borderBottom:a?"2px solid #768692":"2px solid transparent",
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
                    style={{ padding:"5px 10px", borderRadius:14, border:"1px solid "+(a?"#768692":"var(--border)"),
                      background:a?"#768692":"var(--surface)", color:a?"#fff":"var(--text-2)", fontSize:11, fontWeight:a?700:400, cursor:"pointer", whiteSpace:"nowrap" }}>
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
                {msgsCanal.map(function(m, idx){
                  var isMe = m.autorId === currentUser.id;
                  var prev = idx>0 ? msgsCanal[idx-1] : null;
                  var mostraData = !prev || new Date(prev.data).toDateString() !== new Date(m.data).toDateString();
                  return (
                    <React.Fragment key={m.id}>
                    {mostraData && (
                      <div style={{ alignSelf:"center", margin:"8px 0 2px", background:"var(--surface-3)", color:"var(--text-3)", fontSize:10.5, fontWeight:600, padding:"3px 12px", borderRadius:20 }}>{rotuloDataChat(m.data)}</div>
                    )}
                    <div style={{ display:"flex", flexDirection:"column", alignItems:isMe?"flex-end":"flex-start" }}>
                      {!isMe && <div style={{ fontSize:10, color:"var(--text-3)", marginBottom:2, marginLeft:4 }}>{m.autorNome}</div>}
                      <div style={{ maxWidth:"80%", background:isMe?"#768692":"var(--surface-3)", color:isMe?"#fff":"var(--text-strong)",
                        padding:"8px 12px", borderRadius:isMe?"12px 12px 4px 12px":"12px 12px 12px 4px", fontSize:13 }}>
                        {m.anexo && (
                          m.anexo.tipo?.startsWith("image/") ? (
                            <img src={m.anexo.data} alt={m.anexo.nome} style={{ maxWidth:200, borderRadius:8, marginBottom:m.texto?6:0, display:"block" }} />
                          ) : (
                            <a href={m.anexo.data} download={m.anexo.nome} style={{ display:"flex", alignItems:"center", gap:6, color:isMe?"rgba(118,134,146,.35)":"#768692", textDecoration:"none", marginBottom:m.texto?6:0 }}>
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
                    </React.Fragment>
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
                  style={{ background:texto.trim()?"#768692":"var(--surface-3)", border:"none", color:texto.trim()?"#fff":"var(--text-3)", width:36, height:36, borderRadius:9, cursor:texto.trim()?"pointer":"not-allowed", fontSize:16, flexShrink:0 }}>
                  ➤
                </button>
              </div>
            </>
          ) : (
            <>
              {/* Tarefas */}
              <div style={{ flex:1, overflowY:"auto", padding:"12px 14px" }}>
                <button onClick={function(){setShowNovaTarefa(true);}}
                  style={{ width:"100%", background:"#768692", border:"none", color:"#fff", fontWeight:500, padding:"9px", borderRadius:9, cursor:"pointer", fontSize:12, marginBottom:12 }}>
                  + Nova Tarefa
                </button>
                {tarefas.length===0 && <div style={{ textAlign:"center", color:"var(--text-3)", fontSize:12, padding:20 }}>Nenhuma tarefa criada</div>}
                {tarefas.slice().reverse().map(function(t){
                  var corPrior = t.prioridade==="alta"?"#FF5252":t.prioridade==="media"?"#FFC107":"#0a9d4e";
                  var concluida = t.status==="concluida";
                  return (
                    <div key={t.id} style={{ background:"var(--bg-2)", border:"1px solid var(--border)", borderRadius:10, padding:"10px 12px", marginBottom:8, opacity:concluida?0.6:1 }}>
                      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", gap:6 }}>
                        <div style={{ fontSize:13, fontWeight:500, color:"var(--text-strong)", textDecoration:concluida?"line-through":"none" }}>{t.titulo}</div>
                        <span style={{ fontSize:9, fontWeight:500, color:corPrior, background:corPrior+"18", padding:"2px 6px", borderRadius:4, whiteSpace:"nowrap" }}>
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
                            style={{ background:"var(--ui-accent)", border:"none", color:"var(--ui-accent-text)", padding:"3px 9px", borderRadius:6, cursor:"pointer", fontSize:10, fontWeight:600 }}>
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
        <div style={{ fontWeight:500, fontSize:15, color:"var(--text-strong)", marginBottom:14 }}>+ Nova Tarefa</div>
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
            style={{ flex:2, background:titulo.trim()?"#768692":"var(--surface-3)", border:"none", color:titulo.trim()?"#fff":"var(--text-3)", fontWeight:500, padding:"10px", borderRadius:9, cursor:titulo.trim()?"pointer":"not-allowed" }}>
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
  var icmsRegime=props.icmsRegime, setIcmsRegime=props.setIcmsRegime;
  var icmsConfig=props.icmsConfig||{}, setIcmsConfig=props.setIcmsConfig;
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
    saveUsuarios(updated).then(function(r){
      setUsuarios(r.usuarios);
      if (!r.ok) alert("NÃO foi possível salvar o usuário.\n\n" + r.erro);
    });
    setShowModalUser(false);
    setEditingUser(null);
  }

  function deleteUser(id) {
    if (id===currentUser.id){alert("Voce nao pode excluir seu proprio usuario.");return;}
    if (!window.confirm("Excluir este usuario?")) return;
    var updated = getUsuarios().filter(function(u){return u.id!==id;});
    saveUsuarios(updated).then(function(r){
      setUsuarios(r.usuarios);
      if (!r.ok) alert("NÃO foi possível excluir o usuário.\n\n" + r.erro);
    });
  }

  var ABAS = [
    {k:"aparencia", l:"Aparência"},
    {k:"backup",    l:"Backup"},
    {k:"usuarios",  l:"Usuários"},
  ];

  return (
    React.createElement("div", {style:{position:"fixed",inset:0,background:"rgba(15,23,42,.55)",backdropFilter:"blur(4px)",zIndex:800,display:"flex",alignItems:"flex-start",justifyContent:"flex-end",padding:"56px 8px 8px"}},
      React.createElement("div", {style:{background:"var(--surface)",borderRadius:14,width:700,maxHeight:"calc(100vh - 68px)",display:"flex",flexDirection:"column",boxShadow:"0 20px 60px rgba(0,0,0,.22)",overflow:"hidden"}},
        React.createElement("div", {style:{background:"#768692",padding:"13px 18px",display:"flex",justifyContent:"space-between",alignItems:"center"}},
          React.createElement("div", {style:{color:"var(--text-strong)",fontWeight:500,fontSize:15}}, "Configuracoes do Sistema"),
          React.createElement("button", {onClick:onClose, style:{background:"transparent",border:"none",color:"var(--text-3)",fontSize:20,cursor:"pointer",lineHeight:1}}, "x")
        ),
        React.createElement("div", {style:{display:"flex",borderBottom:"2px solid var(--border)"}},
          ABAS.map(function(t){
            var a=aba===t.k;
            return React.createElement("button",{key:t.k,onClick:function(){setAba(t.k);},style:{flex:1,padding:"10px",border:"none",borderBottom:a?"2px solid #768692":"2px solid transparent",background:"transparent",color:a?"var(--text-strong)":"var(--text-3)",fontWeight:a?700:400,fontSize:12,cursor:"pointer",fontFamily:"inherit",marginBottom:-2}}, t.l);
          })
        ),
        React.createElement("div", {style:{flex:1,overflowY:"auto",padding:"16px 18px"}},
          aba==="config" ? React.createElement(ImpostosCompacto, {impostos:impostos,setImpostos:setImpostos,custosFixos:custosFixos,setCustosFixos:setCustosFixos,faturamentoMes:faturamentoMes,irpjCsllConfig:irpjCsllConfig,setIrpjCsllConfig:setIrpjCsllConfig,icmsRegime:icmsRegime,setIcmsRegime:setIcmsRegime,icmsConfig:icmsConfig,setIcmsConfig:setIcmsConfig}) :
          aba==="aparencia" ? React.createElement("div", {style:{display:"flex",gap:10}},
            [{v:false,l:"Claro"},{v:true,l:"Escuro"}].map(function(t){
              return React.createElement("button",{key:String(t.v),onClick:function(){setDarkMode(t.v);localStorage.setItem("darkMode",t.v?"1":"0");},style:{flex:1,padding:14,borderRadius:10,border:"2px solid "+(darkMode===t.v?"#768692":"var(--border)"),background:darkMode===t.v?"#768692":"var(--surface)",color:darkMode===t.v?"#fff":"var(--text-2)",fontWeight:500,fontSize:14,cursor:"pointer"}}, t.v?"Escuro":"Claro");
            })
          ) :
          aba==="backup" ? React.createElement("div", {style:{display:"flex",flexDirection:"column",gap:14}},
            React.createElement("div", {style:{background:"var(--bg-2)",border:"1px solid var(--border)",borderRadius:12,padding:16}},
              React.createElement("div", {style:{fontWeight:500,fontSize:14,marginBottom:12}}, "Exportar Backup"),
              React.createElement("button", {
                onClick:function(){
                  var chaves=["produtos_cadastro","mov_estoque","vendas_estoque_baixadas","ml_orders_cache","contas_pagar","contas_bancarias","lancamentos","nfe_entrada","nfe_saida","costs_config","fretes_config","descontos_config","precos_venda_config","precos_pendentes_ml","icms_por_estado","icms_regime_config","irpj_csll_config","fornecedores_db","chat_interno_mensagens","chat_interno_tarefas","min_stock_anuncios","depositos_estoque"];
                  var bk={versao:2,data:new Date().toISOString(),dados:{}};
                  chaves.forEach(function(k){try{bk.dados[k]=JSON.parse(localStorage.getItem(k)||"null");}catch{}});
                  var blob=new Blob([JSON.stringify(bk,null,2)],{type:"application/json"});
                  var a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="mlmargem_backup_"+new Date().toLocaleDateString("sv-SE")+".json";a.click();
                },
                style:{background:"#768692",border:"none",color:"#fff",fontWeight:500,padding:"10px 20px",borderRadius:9,cursor:"pointer",fontSize:13}
              }, "Exportar Backup")
            ),
            React.createElement("div", {style:{background:"var(--bg-2)",border:"1px solid var(--border)",borderRadius:12,padding:16}},
              React.createElement("div", {style:{fontWeight:500,fontSize:14,marginBottom:4}}, "Restaurar Backup"),
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
                React.createElement("div",{style:{width:36,height:36,borderRadius:9,background:"#768692",display:"flex",alignItems:"center",justifyContent:"center",fontSize:13,fontWeight:600,color:"#FFC107",flexShrink:0}}, u.nome&&u.nome.charAt(0).toUpperCase()),
                React.createElement("div",{style:{flex:1,minWidth:0}},
                  React.createElement("div",{style:{fontWeight:500,fontSize:13,color:"var(--text-strong)"}}, u.nome, isMe&&React.createElement("span",{style:{fontSize:10,color:"#0e7490",background:"rgba(118,134,146,.14)",padding:"1px 5px",borderRadius:4,marginLeft:6}},"voce")),
                  React.createElement("div",{style:{fontSize:11,color:"var(--text-2)"}}, "@"+u.usuario+" - "+(u.admin?"Admin":"Usuario")+" - ",React.createElement("span",{style:{color:u.ativo?"#0a9d4e":"#FF5252",fontWeight:600}},u.ativo?"Ativo":"Inativo")),
                  u.email&&React.createElement("div",{style:{fontSize:10,color:"var(--text-3)",marginTop:1}}, u.email)
                ),
                React.createElement("div",{style:{display:"flex",gap:6}},
                  React.createElement("button",{onClick:function(){setEditingUser(u);setShowModalUser(true);},style:{background:"rgba(118,134,146,.14)",border:"1px solid rgba(118,134,146,.35)",color:"#768692",padding:"4px 10px",borderRadius:7,cursor:"pointer",fontSize:11,fontWeight:600}},"Editar"),
                  !isMe&&React.createElement("button",{onClick:function(){deleteUser(u.id);},style:{background:"rgba(255,82,82,.12)",border:"1px solid rgba(255,82,82,.35)",color:"#FF5252",padding:"4px 8px",borderRadius:7,cursor:"pointer",fontSize:11}},"X")
                )
              );
            }),
            React.createElement("button",{onClick:function(){setEditingUser(null);setShowModalUser(true);},style:{width:"100%",background:"#768692",border:"none",color:"#fff",fontWeight:500,padding:10,borderRadius:9,cursor:"pointer",fontSize:13,marginTop:8}},
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
    return "home";
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
  // Custos por anúncio preenchidos na Precificação: ICMS (%), etiqueta e embalagem (R$).
  // Um objeto por anúncio ({ icms, etiqueta, embalagem }) em vez de três chaves soltas —
  // uma chave de sincronização só, e os três nascem e morrem juntos.
  const [custosExtras, setCustosExtras] = useState(function() {
    try { return JSON.parse(localStorage.getItem("custos_extras_config") || "{}"); } catch { return {}; }
  });
  function setCustosExtrasAndSave(updater) {
    setCustosExtras(function(prev) {
      var next = typeof updater === "function" ? updater(prev) : updater;
      try { localStorage.setItem("custos_extras_config", JSON.stringify(next)); } catch {}
      kvSyncPush("custos_extras_config", next);
      return next;
    });
  }
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
  const [pedidoDetalhe, setPedidoDetalhe] = useState(null); // venda selecionada p/ ver detalhes (drawer)
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
  // Endereços por pedido (cidade/UF) — persistidos numa chave PRÓPRIA e pequena, independente do
  // snapshot grande (que pode estourar a cota do localStorage e não salvar). Isso mantém o mapa por
  // estado preenchido entre recarregamentos.
  const [shipmentAddresses, setShipmentAddresses] = useState(function(){ try { var v = JSON.parse(localStorage.getItem("ml_ship_addr") || "{}"); return (v && typeof v === "object") ? v : {}; } catch(e){ return {}; } });
  useEffect(function(){ try { if (shipmentAddresses && Object.keys(shipmentAddresses).length) localStorage.setItem("ml_ship_addr", JSON.stringify(shipmentAddresses)); } catch(e){} }, [shipmentAddresses]);
  const [promos, setPromos] = useState({});
  // Promoções verificadas pelo servidor. Guardadas separadas do enriquecimento do
  // navegador porque aqui existe um terceiro estado que importa: "ainda não
  // verificado" — que NÃO é o mesmo que "sem promoção".
  const [promoServidor, setPromoServidor] = useState({ carregado: false, itens: {} });
  useEffect(function(){
    let vivo = true;
    fetch("/api/ml/cache_promocoes")
      .then(function(r){ return r.ok ? r.json() : null; })
      .then(function(d){ if (vivo && d && d.cache) setPromoServidor({ carregado: true, itens: d.itens || {} }); })
      .catch(function(){});
    return function(){ vivo = false; };
  }, []);
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
  const [darkMode, setDarkMode] = useState(() => localStorage.getItem("darkMode") === "1");
  const [menuAberto, setMenuAberto] = useState(null); // grupo do menu do topo aberto (dropdown)
  const [dashSub, setDashSub] = useState("geral"); // sub-aba ativa do Dashboard (controlada pelo menu)
  // Produto escolhido em Tendências: chega à Precificação já filtrado, para não
  // obrigar a copiar o SKU na mão de uma tela para a outra.
  const [buscaPrecificacao, setBuscaPrecificacao] = useState("");
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
  // Regime de ICMS da venda (padrão: 4% fora do estado de origem, 0% dentro dele) e a
  // tabela por estado do modo manual — no componente raiz para que qualquer ajuste
  // recalcule na hora a margem de anúncios e pedidos, sem recarregar a página.
  const [icmsRegime, setIcmsRegimeState] = useState(getIcmsRegime);
  function setIcmsRegime(cfg) { setIcmsRegimeState(cfg); saveIcmsRegime(cfg); }
  // Regras da análise de anúncios. aplicarConfigQualidade atualiza a cópia em
  // memória que calcQualityScore lê — sem isso a tela salvaria e as notas
  // continuariam as antigas até recarregar a página.
  const [configQualidade, setConfigQualidadeState] = useState(function(){
    try { return aplicarConfigQualidade(JSON.parse(localStorage.getItem("analise_ia_config") || "{}")); }
    catch { return aplicarConfigQualidade(null); }
  });
  function setConfigQualidade(cfg) {
    var normal = aplicarConfigQualidade(cfg);
    setConfigQualidadeState(normal);
    try { localStorage.setItem("analise_ia_config", JSON.stringify(normal)); } catch(e) {}
    try { kvSyncPush("analise_ia_config", normal); } catch(e) {}
  }
  const [icmsTabela, setIcmsTabelaState] = useState(getIcmsConfig);
  function setIcmsTabela(cfg) { setIcmsTabelaState(cfg); saveIcmsConfig(cfg); }
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
  function salvarContasPagar(lista) {
    setContasPagar(lista);
    try { localStorage.setItem("contas_pagar", JSON.stringify(lista)); } catch(e) {}
    try { kvSyncPush("contas_pagar", lista); } catch(e) {}
  }
  const [pedidosCompra, setPedidosCompra] = useState(() => {
    try { var v = JSON.parse(localStorage.getItem("pedidos_compra") || "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
  });
  function salvarPedidosCompra(lista) {
    setPedidosCompra(lista);
    try { localStorage.setItem("pedidos_compra", JSON.stringify(lista)); } catch(e) {}
    try { kvSyncPush("pedidos_compra", lista); } catch(e) {}
  }
  // Estornar um movimento e desfazer o que o criou, na origem. O extrato e
  // calculado, entao nao existe "apagar a linha": o que se apaga e o fato que a
  // produziu — a baixa da conta, a confirmacao do recebimento, o lancamento.
  // Uma implementacao so, usada por Caixas e bancos e por Lancamentos, para as
  // duas telas nunca desfazerem a mesma coisa de jeitos diferentes.
  function estornarMovimento(m) {
    if (!m) return;
    if (m.origem === "conta_pagar") {
      var c = (contasPagar || []).find(function(x){ return x.id === m.refId; });
      if (!c) { window.alert("A conta de origem não está mais na lista — nada a estornar."); return; }
      var pgs = pagamentosDe(c);
      var restantes = m.pagamentoId ? pgs.filter(function(pg){ return pg.id !== m.pagamentoId; }) : [];
      var sobra = restantes.reduce(function(a,pg){ return a + (parseFloat(pg.valor)||0); }, 0);
      if (!window.confirm("Estornar o pagamento de “" + (c.descricao || "conta") + "”, de " + fmt(m.valor) + "?\n\n" +
          (sobra > 0
            ? "As outras baixas desta conta continuam valendo; ela volta para Contas a pagar devendo " +
              fmt(Math.max(0, (parseFloat(c.valorTotal || c.valor) || 0) - sobra)) + "."
            : "A conta volta para Contas a pagar como pendente, com o vencimento original (" +
              (fmtDate(c.vencimento) || c.vencimento || "sem data") + ")") +
          ", e sai do saldo da conta bancária.")) return;
      salvarContasPagar((contasPagar || []).map(function(x){
        if (x.id !== m.refId) return x;
        var v = Object.assign({}, x, { status:"pendente", pagamentos: restantes });
        delete v.pago_em;
        return v;
      }));
      return;
    }
    if (m.origem === "recebivel") {
      if (!window.confirm("Estornar o recebimento do pedido #" + m.refId + ", de " + fmt(m.valor) + "?\n\n" +
          "Ele volta para Contas a receber como não confirmado, sai do saldo e deixa de contar como receita no DRE.")) return;
      var n = Object.assign({}, recebiveisBaixados); delete n[String(m.refId)];
      setRecebiveisBaixados(n);
      return;
    }
    if (m.origem === "manual") {
      if (!window.confirm("Excluir o lançamento “" + m.descricao + "”, de " + fmt(m.valor) + "?\n\n" +
          "Lançamento manual não tem origem para onde voltar: ele é apagado.")) return;
      salvarLancamentos((lancamentos || []).filter(function(x){ return x.id !== m.id; }));
      return;
    }
  }

  const [extratoBancario, setExtratoBancarioState] = useState(function(){
    try { var v = JSON.parse(localStorage.getItem("extrato_bancario") || "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
  });
  function salvarExtratoBancario(lista) {
    setExtratoBancarioState(lista);
    try { localStorage.setItem("extrato_bancario", JSON.stringify(lista)); } catch(e) {}
    try { kvSyncPush("extrato_bancario", lista); } catch(e) {}
  }
  // Conciliações feitas à mão: {idDoExtrato: idDoMovimento}. Ficam separadas do
  // extrato porque valem mesmo se o extrato for reimportado.
  const [conciliacoesManuais, setConciliacoesManuaisState] = useState(function(){
    try { var v = JSON.parse(localStorage.getItem("conciliacoes_manuais") || "{}"); return v && typeof v === "object" ? v : {}; } catch { return {}; }
  });
  function salvarConciliacoesManuais(mapa) {
    setConciliacoesManuaisState(mapa);
    try { localStorage.setItem("conciliacoes_manuais", JSON.stringify(mapa)); } catch(e) {}
    try { kvSyncPush("conciliacoes_manuais", mapa); } catch(e) {}
  }
  // Período do módulo Financeiro. Fica aqui para sobreviver à troca de aba: era
  // estado interno de cada tela, então ir ao DRE e voltar a Lançamentos jogava
  // a escolha fora.
  const [periodoFin, setPeriodoFin] = useState("30");
  // Regime financeiro (caixa/competência, quando o repasse vira receita, de
  // onde saem as despesas). Fica na raiz porque DRE e Contas a receber precisam
  // concordar — duas telas com regimes diferentes dariam dois lucros.
  const [financeiroConfig, setFinanceiroConfigState] = useState(function(){
    try {
      var v = JSON.parse(localStorage.getItem("financeiro_config") || "{}");
      return Object.assign(financeiroConfigPadrao(), v || {});
    } catch { return financeiroConfigPadrao(); }
  });
  function setFinanceiroConfig(cfg) {
    setFinanceiroConfigState(cfg);
    try { localStorage.setItem("financeiro_config", JSON.stringify(cfg)); } catch(e) {}
    try { kvSyncPush("financeiro_config", cfg); } catch(e) {}
  }
  // Baixas manuais dos recebíveis. Sai de dentro de Contas a receber para a
  // raiz porque o DRE em regime de caixa depende exatamente delas.
  const [recebiveisBaixados, setRecebiveisBaixadosState] = useState(function(){
    try { var v = JSON.parse(localStorage.getItem("recebiveis_baixados") || "{}"); return v && typeof v === "object" ? v : {}; }
    catch { return {}; }
  });
  function setRecebiveisBaixados(mapa) {
    setRecebiveisBaixadosState(mapa);
    try { localStorage.setItem("recebiveis_baixados", JSON.stringify(mapa)); } catch(e) {}
    try { kvSyncPush("recebiveis_baixados", mapa); } catch(e) {}
  }

  // Regras e caixa da tela de Prioridade de pagamento. O caixa fica aqui junto
  // das regras porque é informado à mão e vale entre visitas à tela.
  const [configPrioridade, setConfigPrioridadeState] = useState(function(){
    try {
      var v = JSON.parse(localStorage.getItem("prioridade_pagamento_config") || "{}");
      var pad = configPrioridadePadrao();
      return Object.assign(pad, v || {}, { riscos: Object.assign(pad.riscos, (v && v.riscos) || {}) });
    } catch { return configPrioridadePadrao(); }
  });
  function setConfigPrioridade(cfg) {
    setConfigPrioridadeState(cfg);
    try { localStorage.setItem("prioridade_pagamento_config", JSON.stringify(cfg)); } catch(e) {}
    try { kvSyncPush("prioridade_pagamento_config", cfg); } catch(e) {}
  }
  const [contasBancarias, setContasBancarias] = useState(() => {
    try { var v = JSON.parse(localStorage.getItem("contas_bancarias") || "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
  });
  const [categoriasPagar, setCategoriasPagar] = useState(() => {
    try { var vcp = JSON.parse(localStorage.getItem("categorias_pagar") || JSON.stringify(["Fornecedor","Aluguel","Funcionário","Marketing","Frete","Impostos","Outros"])); return Array.isArray(vcp) ? vcp : ["Fornecedor","Aluguel","Funcionário","Marketing","Frete","Impostos","Outros"]; } catch { return ["Fornecedor","Aluguel","Funcionário","Marketing","Frete","Impostos","Outros"]; }
  });
  const [lancamentos, setLancamentos] = useState(() => {
    try { var v = JSON.parse(localStorage.getItem("lancamentos") || "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
  });
  function salvarLancamentos(lista) {
    setLancamentos(lista);
    try { localStorage.setItem("lancamentos", JSON.stringify(lista)); } catch(e) {}
    try { kvSyncPush("lancamentos", lista); } catch(e) {}
  }
  function salvarContasBancarias(lista) {
    setContasBancarias(lista);
    try { localStorage.setItem("contas_bancarias", JSON.stringify(lista)); } catch(e) {}
    try { kvSyncPush("contas_bancarias", lista); } catch(e) {}
  }
  const [finTab, setFinTab] = useState("resumo");

  const [produtos, setProdutos] = useState(() => {
    try { var v = JSON.parse(localStorage.getItem("produtos_cadastro") || "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
  });
  // Grava o catálogo: estado + localStorage + sync pro servidor (Supabase via /api/ml/_sync).
  function salvarProdutos(lista) {
    setProdutos(lista);
    try { localStorage.setItem("produtos_cadastro", JSON.stringify(lista)); } catch(e) {}
    try { kvSyncPush("produtos_cadastro", lista); } catch(e) {}
  }

  // Metas comerciais (aba Dashboard → Metas): estado + localStorage + sync pro servidor.
  const [metas, setMetas] = useState(() => {
    try { var v = JSON.parse(localStorage.getItem("metas") || "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
  });
  function salvarMetas(lista) {
    setMetas(lista);
    try { localStorage.setItem("metas", JSON.stringify(lista)); } catch(e) {}
    try { kvSyncPush("metas", lista); } catch(e) {}
  }

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
  function salvarFornecedoresCad(lista) {
    setFornecedores(lista);
    try { localStorage.setItem("fornecedores_cadastro", JSON.stringify(lista)); } catch(e) {}
    try { kvSyncPush("fornecedores_cadastro", lista); } catch(e) {}
  }
  function salvarCategoriasPagar(lista) {
    setCategoriasPagar(lista);
    try { localStorage.setItem("categorias_pagar", JSON.stringify(lista)); } catch(e) {}
    try { kvSyncPush("categorias_pagar", lista); } catch(e) {}
  }
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
    "custos_fixos_config","impostos_config","irpj_csll_config","icms_por_estado","icms_regime_config","lancamentos",
    "mov_estoque","metaMensal","min_stock_anuncios","real_fees_config","pedidos_compra",
    "precificacao_extras","precos_pendentes_ml","custos_extras_config","depositos_estoque","estoque_depositos",
    "envios_full","vendas_estoque_baixadas","sku_overrides","analise_ia_config","prioridade_pagamento_config","financeiro_config","recebiveis_baixados","extrato_bancario","conciliacoes_manuais",
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
    metas: setMetas,
    fornecedores_cadastro: setFornecedores,
    contas_pagar: setContasPagar,
    pedidos_compra: setPedidosCompra,
    contas_bancarias: setContasBancarias,
    categorias_pagar: setCategoriasPagar,
    custos_fixos_config: setCustosFixos,
    impostos_config: setImpostos,
    irpj_csll_config: mesclarSetter(setIrpjCsllConfigState),
    icms_regime_config: mesclarSetter(setIcmsRegimeState),
    icms_por_estado: mesclarSetter(setIcmsTabelaState),
    lancamentos: setLancamentos,
    metaMensal: function(v){ setMetaMensal(parseFloat(v)||0); },
    min_stock_anuncios: mesclarSetter(setMinStock),
    real_fees_config: mesclarSetter(setRealFees),
    sku_overrides: mesclarSetter(setSkuOverrides),
    custos_extras_config: mesclarSetter(setCustosExtras),
    analise_ia_config: function(v){ setConfigQualidade(v); },
    prioridade_pagamento_config: mesclarSetter(setConfigPrioridadeState),
    financeiro_config: mesclarSetter(setFinanceiroConfigState),
    recebiveis_baixados: mesclarSetter(setRecebiveisBaixadosState),
    extrato_bancario: setExtratoBancarioState,
    conciliacoes_manuais: mesclarSetter(setConciliacoesManuaisState),
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
    icms_regime_config: "object", icms_por_estado: "object",
    min_stock_anuncios: "object", real_fees_config: "object", sku_overrides: "object",
    custos_extras_config: "object", analise_ia_config: "object",
    prioridade_pagamento_config: "object",
    financeiro_config: "object", recebiveis_baixados: "object",
    extrato_bancario: "array", conciliacoes_manuais: "object",
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
          // Produtos precificados (extras): MESCLA por id — o pull nunca remove um extra local que
          // o servidor DESSA conta ainda não tem. Evita perder a precificação ao trocar de conta ML
          // (namespace por vendedor) ou quando o servidor devolve uma lista vazia/desatualizada.
          if (key === "precificacao_extras" && Array.isArray(v)) {
            try {
              var localArr = JSON.parse(localStorage.getItem(key) || "[]");
              if (Array.isArray(localArr) && localArr.length) {
                var byId = {};
                v.forEach(function(x){ if (x && x.id) byId[x.id] = x; });           // servidor vence em conflito
                localArr.forEach(function(x){ if (x && x.id && !byId[x.id]) byId[x.id] = x; }); // mantém extras locais
                v = Object.keys(byId).map(function(k){ return byId[k]; });
              }
            } catch(e) {}
          }
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
    if (snap.shipmentAddresses && Object.keys(snap.shipmentAddresses).length) setShipmentAddresses(function(prev){ return Object.assign({}, prev, snap.shipmentAddresses); });
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

          const { shippingMap: orderShippingMap, statusMap: shipmentStatusMap, addressMap: orderAddressMap } = await fetchShippingForOrders(orders, validTk, function(pShip, pStatus, pAddr){ setShipmentCosts({ ...pShip }); if (pStatus) setShipmentStatuses({ ...pStatus }); if (pAddr) setShipmentAddresses({ ...pAddr }); });
          setShipmentCosts({ ...orderShippingMap });
          setShipmentStatuses({ ...shipmentStatusMap });
          setShipmentAddresses(function(prev){ return Object.assign({}, prev, orderAddressMap); });

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
            shipmentStatuses: shipmentStatusMap, shipmentAddresses: orderAddressMap, paymentData: paymentMap, promos: promoMap,
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
        const { shippingMap, statusMap, addressMap } = await fetchShippingForOrders(ordersNovos, validTk);
        setShipmentCosts(prev => ({ ...prev, ...shippingMap }));
        setShipmentStatuses(prev => ({ ...prev, ...statusMap }));
        setShipmentAddresses(prev => ({ ...prev, ...addressMap }));

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
    var shipAddr = shipmentAddresses[String(o.id)] || {}; // cidade/UF do /shipments (fonte principal)
    // Normaliza state.id ("BR-SP" → "SP") caso venha direto no pedido.
    var ufDireto = buyerAddr.state?.id ? String(buyerAddr.state.id).toUpperCase().match(/([A-Z]{2})$/)?.[1] : null;
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
      buyerUF: shipAddr.uf || ufDireto || null,
      buyerCity: shipAddr.city || buyerAddr.city?.name || null,
      buyerZip: shipAddr.zip || buyerAddr.zip_code || null,
      shipping: o.shipping || null,
      fulfilled: o.fulfilled || false,
      orderTags: o.tags || [],
      packId: o.pack_id ? String(o.pack_id) : null,
    };
  });

  // Alíquota efetiva de impostos sobre a venda (soma dos itens percentuais configurados
  // em Financeiro → Impostos) — entra na margem líquida de cada anúncio/pedido.
  const impostoPctVenda = (impostos || []).filter(i => i.tipo === "%").reduce((s, i) => s + (parseFloat(i.valor) || 0), 0);
  // O ICMS entra por fora dessa soma porque varia com o destino da venda. Anúncios ainda não
  // têm comprador, então projetam pela alíquota interestadual (o caso mais comum da operação).
  const icmsPctProjetado = icmsPctProjecao(icmsRegime, icmsTabela);

  const enriched = listings.map(l => {
    const cost = costs[l.id] ?? 0;
    // Taxa ML padronizada por tipo de anúncio: Clássico 12% / Premium 17%.
    const feeRate = getRealFeeRate(l);
    const realFeeInfo = realFees[l.id] || null;
    // Ordem de confiança: o que o servidor verificou > o que o navegador buscou.
    const doServidor = promoServidor.itens[l.id];
    const promoData = doServidor && doServidor.tem
      ? { salePrice: doServidor.promocional, originalPrice: doServidor.original || l.price }
      : promosData[l.id];
    const { salePrice: salePriceApi, originalPrice: originalPriceApi, hasPromo: hasPromoApi } = getPrices(l);
    const salePrice = promoData ? promoData.salePrice : salePriceApi;
    const originalPrice = promoData ? promoData.originalPrice : originalPriceApi;
    const hasPromo = promoData ? true : hasPromoApi;
    // Só é "sem promoção" de verdade quando alguém checou e não achou. Sem
    // verificação, o certo é não afirmar nada — era isso que enchia o filtro
    // "Sem promoção" de anúncios que estavam em promoção.
    const promoVerificada = hasPromo || !!doServidor || !!promosData[l.id];
    const freteSeller = shippingData[l.id] ?? 0;
    // Taxa padronizada 12%/17% sobre o preço — sem somar tarifa fixa por faixa.
    const margin = calcMargin(salePrice, cost, feeRate, freteSeller, {
      feeFixa: 0,
      impostoPct: impostoPctVenda + icmsPctProjetado,
    });
    const { score, checks } = calcQualityScore(l);
    // SKU editado manualmente pelo usuário tem prioridade sobre o SKU vindo do ML.
    const skuOverride = skuOverrides[l.id] && String(skuOverrides[l.id]).trim();
    const sku = skuOverride || getSku(l);
    const youReceive = salePrice - margin.fee - freteSeller;
    return { ...l, seller_sku: skuOverride || l.seller_sku, ...margin, cost, sku, salePrice, originalPrice, hasPromo, promoVerificada, freteSeller, youReceive, totalProfit: margin.profit * (l.sold_quantity ?? 0), score, checks, feeIsReal: !!realFeeInfo };
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
    // Não verificado fica de fora: melhor uma lista menor e correta do que uma
    // lista cheia que inclui anúncio em promoção.
    if (filterListingExtra === "sem_promo")  results = results.filter(l => l.promoVerificada && !l.hasPromo);
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
  const enrichedOrders = enrichedOrdersFiltered.map(enriquecerPedido);
  // Lista COMPLETA, sem os filtros das telas de Vendas e Anúncios. As telas
  // financeiras precisam dela: uma projeção de caixa nao pode encolher porque
  // alguem deixou um filtro de SKU ligado noutra aba. O que se deve receber e o
  // que se deve receber, independente do que esta filtrado na tela ao lado.
  const enrichedOrdersTodos = useMemo(function(){
    return (rawOrders || []).map(enriquecerPedido);
  }, [rawOrders, listings, costs, paymentData, shipmentCosts, shippingData, realFees, custosExtras, impostos, icmsRegime, icmsTabela]); // eslint-disable-line
  function enriquecerPedido(o) {
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
    // Custos preenchidos na Precificação para este anúncio: ICMS próprio, etiqueta
    // e embalagem. Mesma chave dos custos acima — o código do anúncio.
    const extrasDoAnuncio = custosExtras[o.listing_id] ?? {};
    const etiquetaUnit = parseFloat(extrasDoAnuncio.etiqueta) || 0;
    const embalagemUnit = parseFloat(extrasDoAnuncio.embalagem) || 0;
    const icmsDoAnuncio = parseFloat(extrasDoAnuncio.icms) || 0;
    // ICMS conforme o destino: dentro da UF de origem vs. interestadual (ver Financeiro → Impostos).
    // Um ICMS preenchido na Precificação vale para aquele anúncio, no lugar do regime.
    const icmsPct = icmsDoAnuncio > 0 ? icmsDoAnuncio : icmsPctParaUF(o.buyerUF, icmsRegime, icmsTabela);
    const impostoPctPedido = impostoPctVenda + icmsPct;
    const custosFixosUnit = etiquetaUnit + embalagemUnit;
    const feeReal = !!(pay && pay.tarifaML > 0 && !pay.isCalculated && o.price > 0);
    let base;
    if (feeReal) {
      const tarifaUnit = pay.tarifaML / (o.qty || 1);
      base = calcMargin(o.price, cost, tarifaUnit / o.price, freteSeller, { impostoPct: impostoPctPedido, custosFixosUnit });
    } else {
      // Sem dados reais de tarifa do pedido → usa a taxa padrão por tipo (12%/17%).
      const feeRate = listing ? getRealFeeRate(listing) : 0.12;
      base = calcMargin(o.price, cost, feeRate, freteSeller, {
        feeFixa: 0,
        impostoPct: impostoPctPedido,
        custosFixosUnit,
      });
    }
    return { ...o, listing, ...base, cost, freteSeller, icmsPct, impostoPct: impostoPctPedido,
             etiqueta: etiquetaUnit, embalagem: embalagemUnit, icmsProprio: icmsDoAnuncio > 0, feeReal };
  }

  // Receita líquida do mês corrente — base dos percentuais na tela de Impostos.
  const faturamentoMesAtual = enrichedOrders
    .filter(o => o.date?.startsWith(new Date().toLocaleDateString("sv-SE").slice(0, 7)))
    .reduce((s, o) => s + o.revenue * o.qty, 0);

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

  // Extrato de tudo o que mexeu em dinheiro. Fica na raiz porque Bancos,
  // Lançamentos e Prioridade de pagamento precisam do MESMO extrato — cada tela
  // recalculando do seu jeito daria saldos diferentes na mesma tela.
  const movimentosCaixa = useMemo(function(){
    return movimentosConsolidados({
      lancamentos: lancamentos, contasPagar: contasPagar, enrichedOrders: enrichedOrdersTodos,
      recebiveisBaixados: recebiveisBaixados, paymentData: paymentData, contasBancarias: contasBancarias,
    });
  }, [lancamentos, contasPagar, enrichedOrdersTodos, recebiveisBaixados, paymentData, contasBancarias]);
  const saldoEmCaixa = useMemo(function(){
    return saldoConsolidado(contasBancarias, movimentosCaixa);
  }, [contasBancarias, movimentosCaixa]);

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
        bottomColor: "#768592",
      };
    }
    return {
      topLabel: "Comprador paga",
      topColor: "#768692",
      topBg: "rgba(118,134,146,.14)",
      bottomLabel: cost > 0 ? `Seu custo: ${fmt(cost)}` : "Seu custo: calculando...",
      bottomColor: "#768592",
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
    <div className={darkMode?"dark":""} style={{ minHeight:"100vh", background:"transparent", color:"var(--text-strong)", fontFamily:"'Inter',system-ui,sans-serif", transition:"background .2s,color .2s", display:"flex", flexDirection:"column", alignItems:"stretch" }}>
      {/* As regras globais e as classes de componente ficam em src/estilos.css. */}

      {/* ── MENU SUPERIOR (topo) — logo + grupos com dropdown + status/usuário à direita ── */}
      <header style={{ position:"sticky", top:0, zIndex:200, display:"flex", alignItems:"center", gap:8,
        padding:"8px 16px", background:"var(--bg-2)", borderBottom:"1px solid var(--border-soft)", flexWrap:"wrap" }}>
        {/* Logo */}
        <div onClick={function(){ setTab("home"); }} title="Tela inicial" style={{ display:"flex", alignItems:"center", gap:9, paddingRight:12, marginRight:2, borderRight:"1px solid var(--border-soft)", cursor:"pointer" }}>
          <div style={{ width:32, height:32, borderRadius:"50%", background:"rgba(118,134,146,.12)", border:"1px solid rgba(118,134,146,.45)", boxShadow:"0 0 14px rgba(118,134,146,.35)", display:"flex", alignItems:"center", justifyContent:"center", fontFamily:"'Space Grotesk',sans-serif", fontWeight:500, fontSize:15, color:"#768692", letterSpacing:-0.5, flexShrink:0 }}>F</div>
          <div style={{ lineHeight:1.1 }}>
            <div style={{ fontFamily:"'Space Grotesk',sans-serif", fontWeight:500, fontSize:15, color:"var(--text-strong)", letterSpacing:-0.4 }}>Flow</div>
            <div style={{ fontFamily:"'JetBrains Mono',monospace", fontSize:8, color:"var(--text-3)", letterSpacing:2, marginTop:1 }}>Marketplaces</div>
          </div>
        </div>

        {/* Grupos de navegação com dropdown */}
        {(function() {
          var grupos = [
            { titulo:"Dashboard", itens:[
              { sub:"geral", label:"Visão geral" },
              { sub:"estados", label:"Estados" },
              { sub:"margem", label:"Margem por pedido" },
              { sub:"estoque", label:"Estoque de produtos" },
              { sub:"clientes", label:"Clientes" },
              { sub:"abc", label:"Curva ABC" },
              { sub:"metas", label:"Metas" },
            ]},
            { titulo:"Operação", itens:[
              { key:"produtos", label:"Produtos" },
              currentUser?.permissoes?.includes("listings") && { key:"listings", label:"Anúncios" },
              { key:"vincular", label:"Vincular anúncios" },
              currentUser?.permissoes?.includes("listings") && { key:"precificacao", label:"Precificação" },
              currentUser?.permissoes?.includes("orders") && { key:"orders", label:"Vendas" },
              { key:"expedicao", label:"Expedição" },
              { key:"compras", label:"Compras" },
              { key:"estoque", label:"Estoque" },
              { key:"notas_fiscais", label:"Notas fiscais" },
            ]},
            { titulo:"Financeiro", itens:[
              { key:"fluxo_caixa", label:"Fluxo de caixa" },
              { key:"contas_pagar", label:"Contas a pagar" },
              { key:"prioridade_pagamento", label:"Prioridade de pagamento" },
              { key:"contas_receber", label:"Contas a receber" },
              { key:"bancos", label:"Caixas e bancos" },
              { key:"lancamentos", label:"Lançamentos" },
              { key:"dre", label:"DRE e conciliação" },
              { key:"conciliacao", label:"Conciliação" },
              { key:"impostos", label:"Impostos" },
            ]},
            { titulo:"Cadastro", itens:[
              { key:"clientes", label:"Clientes" },
              { key:"fornecedores", label:"Fornecedores" },
            ]},
            { titulo:"Inteligência", itens:[
              { key:"tendencias", label:"Tendências" },
              { key:"relatorios", label:"Relatórios" },
              currentUser?.permissoes?.includes("listings") && { key:"concorrencia", label:"Concorrência" },
            ]},
            { titulo:"Configuração", itens:[
              currentUser?.permissoes?.includes("admin") && { key:"admin", label:"Equipe" },
              { key:"analise_ia", label:"Análise de anúncios" },
              { key:"integracoes", label:"Integrações" },
            ]},
          ];
          function irPara(key){ setTab(key); setMenuAberto(null); }
          function irParaSub(s){ setTab("dashboard"); setDashSub(s); setMenuAberto(null); }
          return (
            <nav style={{ display:"flex", alignItems:"center", gap:2, flexWrap:"wrap" }}>
              {grupos.map(function(g) {
                var itens = g.itens.filter(Boolean);
                if (!itens.length) return null;
                var grupoAtivo = itens.some(function(t){ return t.sub ? tab==="dashboard" : t.key === tab; });
                var aberto = menuAberto === g.titulo;
                return (
                  <div key={g.titulo} style={{ position:"relative" }}>
                    <button onClick={function(){ setMenuAberto(function(m){ return m === g.titulo ? null : g.titulo; }); }}
                      style={{ display:"flex", alignItems:"center", gap:5, padding:"9px 13px", borderRadius:9, border:"none", cursor:"pointer", fontFamily:"inherit",
                        fontSize:13.5, fontWeight: grupoAtivo ? 600 : 500,
                        color: (grupoAtivo || aberto) ? "var(--text-strong)" : "var(--text-2)",
                        background: aberto ? "var(--surface-3)" : "transparent" }}>
                      {g.titulo}
                      <span style={{ fontSize:9, opacity:.7, transform: aberto ? "rotate(180deg)" : "none", transition:"transform .15s" }}>▾</span>
                    </button>
                    {aberto && (
                      <div style={{ position:"absolute", top:"calc(100% + 2px)", left:0, minWidth:212, background:"var(--surface)", border:"1px solid var(--border)", borderRadius:10, boxShadow:"0 12px 34px rgba(0,0,0,.20)", padding:6, zIndex:300, display:"flex", flexDirection:"column", gap:2 }}>
                        {itens.map(function(t) {
                          var isDash = !!t.sub;
                          var isActive = isDash ? (tab === "dashboard" && dashSub === t.sub) : (tab === t.key);
                          return (
                            <a key={t.key || ("sub_"+t.sub)} href={isDash ? "?tab=dashboard" : ("?tab=" + t.key)}
                              onClick={function(e){ if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; e.preventDefault(); if (isDash) irParaSub(t.sub); else irPara(t.key); }}
                              style={{ display:"block", padding:"8px 12px", borderRadius:7, textDecoration:"none", whiteSpace:"nowrap", fontSize:13,
                                fontWeight: isActive ? 600 : 500,
                                color: isActive ? "var(--text-strong)" : "var(--text-2)",
                                background: isActive ? "rgba(118,134,146,.14)" : "transparent" }}>
                              {t.label}
                            </a>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </nav>
          );
        })()}

        {/* Espaço flexível empurra o bloco do usuário para a direita */}
        <div style={{ flex:1, minWidth:8 }} />

        {/* Direita: status + sino + atualizar + reconectar + usuário + tema + sair */}
        <div style={{ display:"flex", alignItems:"center", gap:8, flexWrap:"wrap", justifyContent:"flex-end" }}>
          {token && <span style={{ background:"rgba(0,200,83,.12)", border:"1px solid rgba(0,200,83,.35)", color:"var(--ui-accent)", fontSize:10, padding:"3px 9px", borderRadius:20, fontWeight:500, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", maxWidth:180 }}>● {user?.nickname}</span>}
          {!token && <span style={{ background:"var(--surface-3)", border:"1px solid var(--border)", color:"var(--text-3)", fontSize:10, padding:"3px 9px", borderRadius:20, fontWeight:600 }}>● Não conectado</span>}
          {token && lastUpdate && (function(){ var mins=Math.round((Date.now()-parseInt(lastUpdate))/60000); var horas=Math.floor(mins/60); var isStale=mins>=300; return <span style={{ fontSize:10, color:isStale?"#FF5252":"var(--text-3)", whiteSpace:"nowrap" }}>{horas>0?(horas+"h "+(mins%60)+"min"):(mins+"min")} atrás</span>; })()}
          <SinoNotificacoes notificacoes={notificacoes} setNotificacoes={setNotificacoes} darkMode={darkMode} />
          {token && (
            <button onClick={clicarAtualizarManual} disabled={refreshingManual} title="Busca pedidos novos sem recarregar tudo"
              style={{ background: refreshingManual?"var(--surface-3)":"var(--surface)", border:"1px solid var(--border)", color:"var(--text-2)", fontWeight:600, padding:"7px 12px", borderRadius:8, cursor: refreshingManual?"wait":"pointer", fontSize:12, whiteSpace:"nowrap" }}>
              {refreshingManual ? "Atualizando…" : (refreshManualMsg ? refreshManualMsg : "Atualizar")}
            </button>
          )}
          <button onClick={function(){ window.location.href = "/api/auth/login"; }}
            style={{ background:"#768692", border:"none", color:"#fff", fontWeight:500, padding:"7px 12px", borderRadius:8, cursor:"pointer", fontSize:12, whiteSpace:"nowrap" }}>
            {token ? "Reconectar" : "Conectar ML"}
          </button>
          <button onClick={function(){ setDarkMode(function(d){ var nd = !d; try { localStorage.setItem("darkMode", nd ? "1" : "0"); } catch(e){} return nd; }); }}
            title={darkMode ? "Mudar para tema claro" : "Mudar para tema escuro"} aria-label="Alternar tema"
            style={{ background:"transparent", border:"none", color:"var(--text-3)", cursor:"pointer", fontSize:16, padding:"6px 7px", borderRadius:8, lineHeight:1 }}>
            {darkMode ? "☾" : "☀"}
          </button>
          <button onClick={function(){ fetch("/api/auth/app-logout", { method:"POST" }).catch(function(){}); clearSession(); clearSavedTokens(); setCurrentUser(null); setToken(null); setUser(null); }}
            title="Sair"
            style={{ background:"transparent", border:"none", color:"var(--text-3)", fontWeight:500, padding:"7px 9px", borderRadius:8, cursor:"pointer", fontSize:12, whiteSpace:"nowrap" }}>
            Sair
          </button>
        </div>
      </header>
      {menuAberto && <div onClick={function(){ setMenuAberto(null); }} style={{ position:"fixed", inset:0, zIndex:150 }} />}

      {/* Coluna do conteúdo */}
      <div style={{ flex:1, minWidth:0 }}>
      <main style={{ maxWidth: "100%", padding: "14px 26px 40px" }}>

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
                      borderBottom: active?"2px solid #768692":"2px solid transparent", marginBottom:-2,
                      background:"transparent", color:active?"var(--text-strong)":"var(--text-3)",
                      fontWeight:active?700:400, fontSize:13, cursor:"pointer", fontFamily:"inherit" }}>
                    {t.label}
                    {t.badge != null && (
                      <span style={{ background:active?"#768692":"var(--surface-3)", color:active?"#fff":"var(--text-2)",
                        fontSize:11, fontWeight:500, padding:"1px 7px", borderRadius:20 }}>{t.badge}</span>
                    )}
                  </button>
                );
              })}
            </div>
            {/* Conteúdo — só ML por enquanto */}
            {(abaAnuncio) === "outros" ? (
              <div style={{ textAlign:"center", padding:"60px 20px", color:"var(--text-3)" }}>
                <div style={{ fontSize:48, marginBottom:12 }}>🔌</div>
                <div style={{ fontWeight:500, fontSize:16, color:"var(--text-strong)", marginBottom:8 }}>Em breve: outros marketplaces</div>
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
                    {[{k:"all",l:"Todos"},{k:"sem_custo",l:"⚠️ Sem custo",cor:"#FF5252",bg:"rgba(255,82,82,.12)"},{k:"sem_atacado",l:"🏷 Sem preço atacado",cor:"#768592",bg:"rgba(118,133,146,.14)"},{k:"com_promo",l:"🔥 Com promoção",cor:"#768592",bg:"rgba(118,133,146,.14)"},{k:"sem_promo",l:"○ Sem promoção",cor:"var(--text-2)",bg:"var(--surface-3)"},{k:"frete_alto",l:"🚚 Frete acima do config.",cor:"#FFC107",bg:"rgba(255,193,7,.10)"}].map(function(f){
                      return <FiltroBotao key={f.k} label={f.l} active={filterListingExtra===f.k}
                        cor={f.cor||"var(--text-strong)"} bg={f.bg||"var(--surface-3)"}
                        onClick={function(){setFilterListingExtra(f.k);setPaginaAnuncios(1);}} />;
                    })}
                  </FiltroGrupo>
                  {(function(){
                    // Quantos anúncios ativos ainda não tiveram a promoção verificada.
                    // Sem esse aviso, a lista aparece menor e ninguém sabe por quê.
                    var naoVerificados = enriched.filter(function(l){
                      return l.status === "active" && !l.promoVerificada;
                    }).length;
                    if (!naoVerificados || (filterListingExtra !== "sem_promo" && filterListingExtra !== "com_promo")) return null;
                    return (
                      <div style={{ fontSize:11, color:"#FFC107", marginTop:8, lineHeight:1.5 }}>
                        {naoVerificados} anúncio(s) ainda sem verificação de promoção — ficam fora deste filtro
                        até o servidor conferir. O desconto de campanha não vem no anúncio; é consultado um a um.
                      </div>
                    );
                  })()}
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
                                <span style={{ fontWeight: 500, fontSize: 13, color, background: bg, padding: "3px 10px", borderRadius: 6, display: "inline-block", marginBottom: 4 }}>
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
                            <span style={{ fontSize: 13, fontWeight: 600, color: scoreColor(l.score) }}>{l.score}</span>
                            <span style={{ fontSize: 11, color: scoreColor(l.score), fontWeight: 600 }}>{scoreLabel(l.score)}</span>
                          </div>
                        </td>
                        <td><span style={{ fontSize: 11, color: typeInfo.color, fontWeight: 600 }}>{typeInfo.label}</span></td>
                        <td>
                          {l.hasPromo ? (
                            <span style={{ fontSize: 13, color: "var(--text-3)", textDecoration: "line-through" }}>{fmt(l.originalPrice)}</span>
                          ) : (
                            <span style={{ fontWeight: 500, color: "var(--text-strong)", fontSize: 13 }}>{fmt(l.originalPrice)}</span>
                          )}
                        </td>
                        <td>
                          {l.hasPromo ? (
                            <div>
                              <span style={{ fontWeight: 500, color: "#FF5252", fontSize: 13 }}>{fmt(l.salePrice)}</span>
                              <span style={{ fontSize: 10, color: "#FF5252", background: "rgba(255,82,82,.12)", padding: "1px 6px", borderRadius: 4, fontWeight: 600, marginLeft: 4 }}>Promo</span>
                            </div>
                          ) : (
                            <span style={{ fontWeight: 500, color: "var(--text-strong)" }}>{fmt(l.salePrice)}</span>
                          )}
                        </td>
                        <td>
                          <span style={{ color: "#FFC107", fontWeight: 500 }}>{fmt(l.fee)}</span>
                          <div style={{ fontSize: 10, color: "var(--text-3)" }}>{fmtPct(l.feeRate)}</div>
                        </td>
                        <td>
                          <div style={{ fontSize: 11, color: frete.topColor, background: frete.topBg, padding: "2px 7px", borderRadius: 5, fontWeight: 600, display: "inline-block", marginBottom: 3 }}>{frete.topLabel}</div>
                          <div style={{ fontSize: 11, color: frete.bottomColor, fontWeight: 500 }}>{frete.bottomLabel}</div>
                          {(function(){
                            try {
                              var fretesConf = JSON.parse(localStorage.getItem("fretes_config")||"{}");
                              var fc = parseFloat(fretesConf[l.id]||0);
                              var fr = l.freteSeller||0;
                              if (fc>0 && fr>fc) return (
                                <div style={{ marginTop:2 }}>
                                  <span style={{ fontSize:9, fontWeight:500, background:"rgba(255,193,7,.10)", color:"#FFC107", border:"1px solid rgba(255,193,7,.35)", padding:"1px 5px", borderRadius:3, whiteSpace:"nowrap" }}>
                                    🚚 frete +R${(fr-fc).toFixed(2).replace(".",",")}
                                  </span>
                                </div>
                              );
                            } catch {}
                            return null;
                          })()}
                        </td>
                        <td>
                          <span style={{ fontWeight: 500, color: "#0a9d4e", fontSize: 13 }}>{fmt(l.youReceive)}</span>
                          <div style={{ fontSize: 10, color: "var(--text-3)" }}>após tarifa e frete</div>
                        </td>
                        <td>
                          <input type="number" value={l.cost || ""} onChange={e => setCostsAndSave(c => ({ ...c, [l.id]: Number(e.target.value) }))} placeholder="0,00"
                            onFocus={function(){ setEditandoCustoId(l.id); }}
                            onBlur={function(){ setEditandoCustoId(function(cur){ return cur === l.id ? null : cur; }); }}
                            style={{ background: "var(--bg-2)", border: "1px solid var(--border)", color: "var(--text-strong)", padding: "5px 8px", borderRadius: 6, width: 80, fontSize: 12, textAlign: "right" }} />
                        </td>
                        <td style={{ color: l.profit >= 0 ? "#0a9d4e" : "#FF5252", fontWeight: 500 }}>{fmt(l.profit)}</td>
                        <td style={{ minWidth: 130 }}><MarginBar value={l.margin} /></td>
                        <td>
                          <span style={{ color: l.totalProfit >= 0 ? "#0a9d4e" : "#FF5252", fontWeight: 500 }}>{l.cost > 0 ? fmt(l.totalProfit) : "—"}</span>
                          <div style={{ fontSize: 10, color: "var(--text-3)" }}>{l.sold_quantity} vendidos</div>
                        </td>
                        <td>
                          <button onClick={() => setSelectedListing(l)} style={{ background: "#768692", border: "none", color: "#fff", fontSize: 11, padding: "5px 12px", borderRadius: 6, cursor: "pointer", fontWeight: 600, whiteSpace: "nowrap" }}>✦ Analisar</button>
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
                      borderBottom: active?"2px solid #768692":"2px solid transparent", marginBottom:-2,
                      background:"transparent", color:active?"var(--text-strong)":"var(--text-3)",
                      fontWeight:active?700:400, fontSize:13, cursor:"pointer", fontFamily:"inherit" }}>
                    {t.label}
                    {t.badge != null && (
                      <span style={{ background:active?"#768692":"var(--surface-3)", color:active?"#fff":"var(--text-2)",
                        fontSize:11, fontWeight:500, padding:"1px 7px", borderRadius:20 }}>{t.badge}</span>
                    )}
                  </button>
                );
              })}
            </div>
            {(abaPedido) === "outros" ? (
              <div style={{ textAlign:"center", padding:"60px 20px", color:"var(--text-3)" }}>
                <div style={{ fontSize:48, marginBottom:12 }}>🔌</div>
                <div style={{ fontWeight:500, fontSize:16, color:"var(--text-strong)", marginBottom:8 }}>Em breve: outros marketplaces</div>
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
                    {[{key:"todos",l:"Todos"},{key:"FULL",l:"FULL",c:"#768692",bg:"rgba(118,134,146,.14)"},{key:"Flex",l:"Flex",c:"#768592",bg:"rgba(118,133,146,.14)"},{key:"ME2",l:"ME2",c:"#0e7490",bg:"rgba(0,240,255,.10)"},{key:"ME1",l:"ME1",c:"#768692",bg:"rgba(118,134,146,.2)"}].map(function(e){
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
                      return <th key={h} style={{ fontSize:11, color:"var(--text-3)", textTransform:"none", letterSpacing:0.8, padding:"10px 12px", borderBottom:"1px solid var(--border)", textAlign:align, fontWeight:600, background:"var(--bg-2)", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{h}</th>;
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
                      <tr key={o.id} onClick={function(){ setPedidoDetalhe(o); }} title="Clique para ver os detalhes desta venda"
                        style={{ borderBottom:"1px solid var(--border-soft)", cursor:"pointer" }}>
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
                              <button onClick={function(e){ e.stopPropagation(); setShowClienteDetalhe(showClienteDetalhe===o.id ? null : o.id); }}
                                style={{ background:"none", border:"none", color:"#0e7490", cursor:"pointer", fontSize:11, fontWeight:600, padding:0, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", maxWidth:"100%", display:"block" }}>
                                {o.buyerName}
                              </button>
                              {showClienteDetalhe === o.id && (
                                <div style={{ position:"fixed", zIndex:900, background:"var(--surface)", border:"1px solid var(--border)", borderRadius:12, padding:"16px 18px", boxShadow:"0 8px 32px rgba(0,0,0,.15)", minWidth:260, marginTop:4 }}>
                                  <div style={{ fontWeight:500, fontSize:14, color:"var(--text-strong)", marginBottom:10, display:"flex", justifyContent:"space-between" }}>
                                    👤 {o.buyerName}
                                    <button onClick={function(e){ e.stopPropagation(); setShowClienteDetalhe(null); }} style={{ background:"none", border:"none", cursor:"pointer", color:"var(--text-3)", fontSize:14 }}>✕</button>
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
                                ? <a href={link} target="_blank" rel="noreferrer" onClick={function(e){ e.stopPropagation(); }} className="title-link" style={{ fontSize:12 }}>{title}</a>
                                : <span style={{ fontSize:12 }}>{title}</span>;
                            })()}
                          </div>
                        </td>
                        <td style={{ padding:"7px 10px", fontSize:11, color:"var(--text-2)", whiteSpace:"nowrap" }}>{fmtDate(o.date)}</td>
                        <td style={{ padding:"7px 10px", fontSize:12, fontWeight:500, color:"var(--text-strong)", textAlign:"right", whiteSpace:"nowrap" }}>{fmt(o.price)}</td>
                        <td style={{ padding:"7px 10px", fontSize:11, color:"var(--text-2)", textAlign:"center" }}>×{o.qty}</td>
                        <td style={{ padding:"10px 12px", textAlign:"right", whiteSpace:"nowrap" }}><span style={{ color:"#FFC107", fontWeight:600, fontSize:12 }}>{fmt(o.fee)}</span></td>
                        <td style={{ padding:"10px 12px", textAlign:"right", whiteSpace:"nowrap" }}><span style={{ color:"#768592", fontWeight:600, fontSize:12 }}>{o.freteSeller > 0 ? fmt(o.freteSeller) : "—"}</span></td>
                        <td style={{ padding:"10px 12px", textAlign:"right", whiteSpace:"nowrap" }}><span style={{ color:"var(--ui-accent)", fontWeight:500, fontSize:12 }}>{fmt(youReceive)}</span></td>
                        <td style={{ padding:"10px 12px", textAlign:"right", whiteSpace:"nowrap", fontSize:12, color:o.profit>=0?"#0a9d4e":"#FF5252", fontWeight:500 }}>{o.cost > 0 ? fmt(o.profit) : "—"}</td>
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
            {pedidoDetalhe && <PedidoDetalheDrawer pedido={pedidoDetalhe} onClose={function(){ setPedidoDetalhe(null); }} />}
          </>
        )}
      </main>

        {tab === "precificacao" && currentUser?.permissoes?.includes("listings") && (
          <PrecificacaoTab
            custosExtras={custosExtras} setCustosExtrasAndSave={setCustosExtrasAndSave}
            buscaInicial={buscaPrecificacao}
            icmsPct={icmsPctProjetado}
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
        {tab === "home" && (
          <HomeTab enrichedOrders={enrichedOrders} currentUser={currentUser} setTab={setTab} />
        )}
        {tab === "dashboard" && (
          <DashboardTab enrichedOrders={enrichedOrders} produtos={produtos} user={user} metas={metas} salvarMetas={salvarMetas} sub={dashSub} setSub={setDashSub} />
        )}
        {tab === "analise_ia" && <AnaliseIATab config={configQualidade} salvar={setConfigQualidade} enriched={enriched} />}
        {tab === "produtos" && <ProdutosTab produtos={produtos} salvar={salvarProdutos} fornecedores={fornecedores} enriched={enriched} />}
        {tab === "estoque" && <EstoqueTab produtos={produtos} />}
        {tab === "vincular" && <VincularTab enriched={enriched} produtos={produtos} salvar={salvarProdutos} />}
        {tab === "relatorios" && <RelatoriosTab enrichedOrders={enrichedOrders} />}
        {tab === "expedicao" && <EmConstrucao tab="expedicao" />}
        {tab === "notas_fiscais" && <EmConstrucao tab="notas_fiscais" />}
        {tab === "contas_receber" && <ContasReceberTab tab={tab} setTab={setTab} enrichedOrders={enrichedOrdersTodos} paymentData={paymentData}
          baixados={recebiveisBaixados} setBaixados={setRecebiveisBaixados} config={financeiroConfig} />}
        {tab === "contas_pagar" && <ContasPagarTab tab={tab} setTab={setTab} contas={contasPagar} salvar={salvarContasPagar} contasBancarias={contasBancarias}
          categorias={categoriasPagar} salvarCategorias={salvarCategoriasPagar}
          fornecedores={fornecedores} salvarFornecedores={salvarFornecedoresCad} />}
        {tab === "prioridade_pagamento" && <PrioridadePagamentoTab contas={contasPagar} salvarContas={salvarContasPagar} config={configPrioridade} salvarConfig={setConfigPrioridade} saldoEmCaixa={saldoEmCaixa} temContasBancarias={(contasBancarias||[]).length > 0} tab={tab} setTab={setTab} />}
        {tab === "fluxo_caixa" && <FluxoCaixaTab tab={tab} saldoEmCaixa={saldoEmCaixa} temContasBancarias={(contasBancarias||[]).length > 0}
          contasPagar={contasPagar} enrichedOrders={enrichedOrdersTodos} paymentData={paymentData}
          recebiveisBaixados={recebiveisBaixados} lancamentos={lancamentos} custosFixos={custosFixos} setTab={setTab} />}
        {tab === "conciliacao" && <ConciliacaoTab tab={tab} setTab={setTab} periodo={periodoFin} setPeriodo={setPeriodoFin}
          extrato={extratoBancario} salvarExtrato={salvarExtratoBancario}
          manuais={conciliacoesManuais} salvarManuais={salvarConciliacoesManuais}
          movimentos={movimentosCaixa} contasBancarias={contasBancarias}
          lancamentos={lancamentos} salvarLancamentos={salvarLancamentos} />}
        {tab === "bancos" && <BancosTab tab={tab} contasBancarias={contasBancarias} salvar={salvarContasBancarias} movimentos={movimentosCaixa} setTab={setTab} estornar={estornarMovimento} />}
        {tab === "lancamentos" && <LancamentosTab tab={tab} setTab={setTab} periodo={periodoFin} setPeriodo={setPeriodoFin} lancamentos={lancamentos} salvar={salvarLancamentos} movimentos={movimentosCaixa} contasBancarias={contasBancarias} categorias={categoriasPagar} estornar={estornarMovimento} />}
        {tab === "compras" && <ComprasTab produtos={produtos} pedidos={pedidosCompra} salvar={salvarPedidosCompra} />}
        {tab === "clientes" && <ClientesTab rawOrders={rawOrders} />}
        {tab === "tendencias" && <TendenciasTab setTab={setTab} setBuscaPrecificacao={setBuscaPrecificacao} enriched={enriched} />}
        {tab === "integracoes" && <IntegracoesTab token={token} user={user} lastUpdate={lastUpdate} />}
        {tab === "impostos" && (
          <ImpostosTab tab={tab} setTab={setTab}
            impostos={impostos} setImpostos={setImpostos}
            custosFixos={custosFixos} setCustosFixos={setCustosFixos}
            irpjCsllConfig={irpjCsllConfig} setIrpjCsllConfig={setIrpjCsllConfig}
            icmsRegime={icmsRegime} setIcmsRegime={setIcmsRegime}
            icmsConfig={icmsTabela} setIcmsConfig={setIcmsTabela}
            faturamentoMes={faturamentoMesAtual}
          />
        )}
        {tab === "dre" && <DreTab enrichedOrders={enrichedOrdersTodos} contasPagar={contasPagar} lancamentos={lancamentos}
          custosFixos={custosFixos} recebiveisBaixados={recebiveisBaixados} paymentData={paymentData}
          config={financeiroConfig} salvarConfig={setFinanceiroConfig} tab={tab} setTab={setTab} periodo={periodoFin} setPeriodo={setPeriodoFin} />}
        {tab === "fornecedores" && <FornecedoresTab fornecedores={fornecedores} salvar={salvarFornecedoresCad} contasPagar={contasPagar} setTab={setTab} />}
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
          icmsRegime={icmsRegime} setIcmsRegime={setIcmsRegime}
          icmsConfig={icmsTabela} setIcmsConfig={setIcmsTabela}
          faturamentoMes={faturamentoMesAtual}
          darkMode={darkMode} setDarkMode={setDarkMode}
          onClose={function(){ setShowConfigPanel(false); }}
        />
      )}
      {selectedListing && <AIPanel listing={selectedListing} onClose={() => setSelectedListing(null)} />}
      {currentUser && <ChatInternoWidget currentUser={currentUser} />}
    </div>
  );
}
