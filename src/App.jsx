import React, { useState, useMemo, useEffect, useRef, Children, cloneElement } from "react";

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
  if (listing.listing_type_id === "gold_special" || listing.listing_type_id === "gold_extra") return 0.12;
  return 0.12;
}

function getListingTypeLabel(type) {
  // ML Brasil: gold_premium e gold_pro = Premium (17%)
  // gold_special, gold_extra, demais = Clássico (12%)
  if (type === "gold_premium" || type === "gold_pro") return { label: "Premium · 17%", color: "#7c3aed" };
  if (type === "gold_special" || type === "gold_extra") return { label: "Clássico · 12%", color: "#2563eb" };
  if (type === "silver") return { label: "Gratuito", color: "#94a3b8" };
  if (type === "free") return { label: "Gratuito", color: "#94a3b8" };
  return { label: type ? "Clássico" : "—", color: "#2563eb" };
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
      batch.map(async function(id) {
        var item = await fetch(ML("/items/" + id), { headers: { Authorization: "Bearer " + tk } }).then(function(r){ return r.json(); });
        // Buscar preço com desconto via promotions

        return item;
      })
    );
    details.push(...batchDetails);
  }
  return details.filter(d => d.id);
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

  // ── PASSO 4: Manter produtos manuais não-sincronizados ────────────────
  produtosExistentes.forEach(function(p) {
    if (!produtosProcessados.has(p.id) && !p.criadoViaML) {
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
    padding:"6px 11px", borderRadius:7, border: ativo ? "2px solid #0f172a" : "1px solid #e2e8f0",
    background: ativo ? "#0f172a" : "#fff", color: ativo ? "#fff" : "#64748b",
    fontWeight: ativo ? 700 : 400, fontSize:13, cursor:"pointer", fontFamily:"inherit", minWidth:34
  }; };

  return (
    <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"12px 0", borderTop:"1px solid #f1f5f9", marginTop:4, flexWrap:"wrap", gap:8 }}>
      <span style={{ fontSize:12, color:"#94a3b8" }}>
        Mostrando {inicio}–{fim} de <strong>{total}</strong> registros
      </span>
      <div style={{ display:"flex", gap:4, alignItems:"center" }}>
        <button onClick={function(){ onMudar(1); }} disabled={paginaAtual===1}
          style={Object.assign({},btnStyle(false),{opacity:paginaAtual===1?0.4:1})}>«</button>
        <button onClick={function(){ onMudar(paginaAtual-1); }} disabled={paginaAtual===1}
          style={Object.assign({},btnStyle(false),{opacity:paginaAtual===1?0.4:1})}>‹</button>
        {paginasVisiveis().map(function(p, i) {
          if (p === "...") return <span key={"e"+i} style={{ color:"#94a3b8", padding:"0 4px" }}>…</span>;
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
              <div key={c.key} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 7px", background: c.pass ? "#f0fdf4" : "#fef2f2", borderRadius: 8 }}>
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
                      <div style={{ fontSize: 10, color: "#94a3b8", marginTop: 4 }}>{fmtDate(n.data)}</div>
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
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"12px 16px", borderBottom:"1px solid #f1f5f9" }}>
          <div>
            <div style={{ fontWeight:800, fontSize:18, color:"#0f172a" }}>💾 Backup e Restauração</div>
            <div style={{ fontSize:12, color:"#94a3b8", marginTop:2 }}>Exporte seus dados para um arquivo seguro ou restaure de um backup anterior</div>
          </div>
          <button onClick={onClose} style={{ background:"#f1f5f9", border:"none", color:"#64748b", width:32, height:32, borderRadius:8, cursor:"pointer", fontSize:16 }}>✕</button>
        </div>

        <div style={{ flex:1, overflowY:"auto", padding:"12px 16px" }}>

          {/* Status */}
          {status && (
            <div style={{ background:status.startsWith("✅")?"#f0fdf4":"#fef2f2", border:`1px solid ${status.startsWith("✅")?"#bbf7d0":"#fecaca"}`, borderRadius:10, padding:"10px 16px", marginBottom:8, fontSize:13, fontWeight:600, color:status.startsWith("✅")?"#15803d":"#dc2626" }}>
              {status}
            </div>
          )}

          {/* Preview de importação */}
          {preview && (
            <div style={{ background:"#fffbeb", border:"1px solid #fde68a", borderRadius:12, padding:"16px 18px", marginBottom:8 }}>
              <div style={{ fontWeight:700, fontSize:14, color:"#92400e", marginBottom:8 }}>⚠️ Confirmar Restauração</div>
              <div style={{ fontSize:12, color:"#78350f", marginBottom:12 }}>
                Backup de: <strong>{preview.dataBackup}</strong><br/>
                <strong>Atenção:</strong> os dados atuais serão substituídos pelos dados do backup!
              </div>
              <div style={{ display:"flex", flexDirection:"column", gap:4, marginBottom:8 }}>
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
          <div style={{ marginBottom:10 }}>
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
              <div style={{ fontSize:12, color:"#64748b", marginBottom:8, lineHeight:1.5 }}>
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
              <div style={{ fontSize:12, color:"#64748b", marginBottom:8, lineHeight:1.5 }}>
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
  { key: "overview",        label: "🏠 Visão Geral" },
  { key: "listings",        label: "📢 Anúncios" },
  { key: "orders",          label: "📦 Pedidos" },
  { key: "financeiro",      label: "💰 Financeiro", sub: [
    { key: "fin_resumo",    label: "📊 Resumo" },
    { key: "fin_fluxo",     label: "📈 Fluxo de Caixa" },
    { key: "fin_pagar",     label: "📤 Contas a Pagar" },
    { key: "fin_receber",   label: "📥 Contas a Receber" },
    { key: "fin_bancos",    label: "🏦 Caixas e Bancos" },
    { key: "fin_config",    label: "⚙️ Configurações" },
  ]},
  { key: "produtos",        label: "🛍️ Produtos" },
  { key: "admin",           label: "⚙️ Administração" },
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
      // Cria admin padrão na primeira vez (antes da sincronização com servidor)
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
  // Sincroniza com o servidor — envia SEMPRE com senhaHash para persistir no cache
  try {
    var senhaHashMap = {};
    usuarios.forEach(function(u){ if(u.senhaHash) senhaHashMap[u.id]=u.senhaHash; });
    fetch("/api/ml/_users", {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify({ usuarios: usuarios, senhaHashMap: senhaHashMap })
    }).catch(function(){});
  } catch {}
}

// Sincroniza usuários do servidor para o localStorage (chamado na inicialização do app)
async function sincronizarUsuariosDoServidor() {
  try {
    var locais = getUsuarios();

    // Primeiro envia os usuários locais para o servidor (com senhaHash)
    // para que o servidor sempre tenha a versão mais recente
    if (locais.length > 0) {
      var senhaHashMap = {};
      locais.forEach(function(u){ if(u.senhaHash) senhaHashMap[u.id] = u.senhaHash; });
      fetch("/api/ml/_users", {
        method: "POST",
        headers: {"Content-Type":"application/json"},
        body: JSON.stringify({ usuarios: locais, senhaHashMap: senhaHashMap })
      }).catch(function(){});
    }

    // Depois busca do servidor para pegar usuários criados em outros dispositivos
    var res = await fetch("/api/ml/_users");
    if (!res.ok) return;
    var usuariosServidor = await res.json();
    if (!usuariosServidor || !usuariosServidor.length) return;

    // Mescla: mantém senhaHash local, adiciona usuários novos do servidor
    var mapaLocal = {};
    locais.forEach(function(u){ mapaLocal[u.id] = u; });
    var mesclados = usuariosServidor.map(function(us){
      var local = mapaLocal[us.id];
      return Object.assign({}, us, {
        senhaHash: (local && local.senhaHash) || hashSenha("123456")
      });
    });
    // Preserva usuários locais não encontrados no servidor
    locais.forEach(function(l){
      if (!mesclados.find(function(m){ return m.id===l.id; })) mesclados.push(l);
    });
    localStorage.setItem(AUTH_KEY, JSON.stringify(mesclados));
    console.log("[USUÁRIOS] Sincronizados:", mesclados.length);
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

  // Sincroniza usuários do servidor ao abrir tela de login
  useEffect(function(){
    sincronizarUsuariosDoServidor();
  }, []);

  function handleLogin() {
    if (!usuario || !senha) return;
    setLoading(true); setErro("");
    // Tenta sincronizar do servidor antes de validar (garante usuários atualizados)
    sincronizarUsuariosDoServidor().finally(function(){
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
          <div style={{ width:64, height:64, borderRadius:18, background:"#ffe000", display:"inline-flex", alignItems:"center", justifyContent:"center", fontSize:32, fontWeight:800, color:"#0f172a", marginBottom:8, boxShadow:"0 8px 32px rgba(255,224,0,.3)" }}>M</div>
          <div style={{ fontWeight:800, fontSize:24, color:"#fff", letterSpacing:-0.5 }}>ML Margem</div>
          <div style={{ fontSize:13, color:"#64748b", marginTop:4 }}>Dashboard de Lucratividade</div>
        </div>

        {/* Card */}
        <div style={{ background:"#1e293b", borderRadius:20, padding:"32px 36px", boxShadow:"0 20px 60px rgba(0,0,0,.4)", border:"1px solid #334155" }}>
          <div style={{ fontWeight:700, fontSize:18, color:"#f1f5f9", marginBottom:10 }}>Entrar no sistema</div>

          <div style={{ marginBottom:8 }}>
            <div style={{ fontSize:11, color:"#64748b", marginBottom:8, fontWeight:600, letterSpacing:1, textTransform:"uppercase" }}>Usuário</div>
            <input value={usuario} onChange={e => { setUsuario(e.target.value); setErro(""); }}
              onKeyDown={e => e.key==="Enter" && handleLogin()}
              placeholder="Digite seu usuário"
              style={{ width:"100%", background:"#0f172a", border:`1px solid ${erro?"#dc2626":"#334155"}`, color:"#f1f5f9", padding:"12px 16px", borderRadius:10, fontSize:14, outline:"none", fontFamily:"inherit" }} />
          </div>

          <div style={{ marginBottom:10 }}>
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
            <div style={{ background:"#450a0a", border:"1px solid #dc2626", color:"#fca5a5", fontSize:13, padding:"10px 14px", borderRadius:8, marginBottom:8 }}>
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
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:10 }}>
          <div style={{ fontWeight:800, fontSize:17, color:"#0f172a" }}>{usuario ? "Editar Usuário" : "Novo Usuário"}</div>
          <button onClick={onClose} style={{ background:"#f1f5f9", border:"none", color:"#64748b", width:32, height:32, borderRadius:8, cursor:"pointer", fontSize:16 }}>✕</button>
        </div>

        <div style={{ display:"flex", flexDirection:"column", gap:12, marginBottom:10 }}>
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
            <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Email (para notificações de tarefas)</div>
            <input type="email" value={form.email||""} onChange={e=>set("email",e.target.value)} placeholder="usuario@empresa.com"
              style={{ width:"100%", background:"#f8fafc", border:"1px solid #e2e8f0", color:"#0f172a", padding:"9px 12px", borderRadius:8, fontSize:13, outline:"none" }} />
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
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12 }}>
              <div style={{ fontWeight:700, fontSize:13, color:"#0f172a" }}>Permissões de Acesso</div>
              <button onClick={function(){
                  var todasKeys = [];
                  PERMISSOES_DISPONIVEIS.forEach(function(p){ todasKeys.push(p.key); if(p.sub) p.sub.forEach(function(s){ todasKeys.push(s.key); }); });
                  var temTudo = todasKeys.every(function(k){ return (form.permissoes||[]).includes(k); });
                  set("permissoes", temTudo ? [] : todasKeys);
                }}
                style={{ fontSize:11, color:"#2563eb", background:"transparent", border:"none", cursor:"pointer", fontWeight:600 }}>
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
                      background: isChecked || subChecked > 0 ? "#eff6ff" : "#fff",
                      border: "1px solid " + (isChecked || subChecked > 0 ? "#2563eb" : "#e2e8f0"),
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
                      <span style={{ fontSize:13, fontWeight:600, color: isChecked || subChecked > 0 ? "#1d4ed8" : "#334155", flex:1 }}>{p.label}</span>
                      {p.sub && <span style={{ fontSize:10, color:"#94a3b8" }}>{subChecked}/{subTotal}</span>}
                    </label>
                    {/* Sub-permissões */}
                    {p.sub && (isChecked || subChecked > 0 || true) && (
                      <div style={{ marginLeft:24, marginTop:4, display:"grid", gridTemplateColumns:"1fr 1fr", gap:4 }}>
                        {p.sub.map(function(s) {
                          var sChecked = (form.permissoes||[]).includes(s.key);
                          return (
                            <label key={s.key} style={{ display:"flex", alignItems:"center", gap:6, cursor:"pointer", padding:"6px 10px", borderRadius:7,
                              background: sChecked ? "#f0f9ff" : "#fafafa",
                              border: "1px solid " + (sChecked ? "#bae6fd" : "#f1f5f9"),
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
                              <span style={{ fontSize:12, color: sChecked ? "#0369a1" : "#64748b", fontWeight: sChecked ? 600 : 400 }}>{s.label}</span>
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
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:10 }}>
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

            <div style={{ display:"flex", alignItems:"center", gap:7, marginBottom:12 }}>
              <div style={{ width:42, height:42, borderRadius:12, background:u.admin?"#0f172a":"#f1f5f9", display:"flex", alignItems:"center", justifyContent:"center", fontSize:15, fontWeight:800, color:u.admin?"#ffe000":"#64748b" }}>
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


// ── Painel detalhado de Impostos (Lucro Real) e Custos Fixos ──
var ESTADOS_BR_ICMS = [["AC", "Acre", 19], ["AL", "Alagoas", 19], ["AP", "Amapá", 18], ["AM", "Amazonas", 20], ["BA", "Bahia", 20.5], ["CE", "Ceará", 20], ["DF", "Distrito Federal", 20], ["ES", "Espírito Santo", 17], ["GO", "Goiás", 19], ["MA", "Maranhão", 22], ["MT", "Mato Grosso", 17], ["MS", "Mato Grosso do Sul", 17], ["MG", "Minas Gerais", 18], ["PA", "Pará", 19], ["PB", "Paraíba", 20], ["PR", "Paraná", 19.5], ["PE", "Pernambuco", 20.5], ["PI", "Piauí", 21], ["RJ", "Rio de Janeiro", 22], ["RN", "Rio Grande do Norte", 18], ["RS", "Rio Grande do Sul", 17], ["RO", "Rondônia", 19.5], ["RR", "Roraima", 20], ["SC", "Santa Catarina", 17], ["SP", "São Paulo", 18], ["SE", "Sergipe", 19], ["TO", "Tocantins", 20]];

function getIcmsConfig() {
  try { return JSON.parse(localStorage.getItem("icms_por_estado")||"{}"); } catch { return {}; }
}
function saveIcmsConfig(cfg) { try { localStorage.setItem("icms_por_estado", JSON.stringify(cfg)); } catch {} }

function ImpostosCompacto({ impostos, setImpostos, custosFixos, setCustosFixos, faturamentoMes, irpjCsllConfig, setIrpjCsllConfig }) {
  const [novoCusto, setNovoCusto] = useState({ nome:"", valor:"", tipo:"R$" });
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
      <div style={{ display:"flex", alignItems:"center", gap:8, padding:"8px 0", borderBottom:"1px solid #f8fafc" }}>
        <div style={{ flex:1, fontSize:13, color:"#0f172a", fontWeight:500 }}>{item.nome}</div>
        <div style={{ fontSize:13, fontWeight:700, color:"#334155" }}>{item.tipo==="%" ? item.valor+"%" : "R$ "+parseFloat(item.valor).toFixed(2).replace(".",",")}</div>
        <div style={{ fontSize:12, color:"#94a3b8" }}>= R$ {calcValor(item, faturamentoMes).toFixed(2).replace(".",",")}</div>
        <button onClick={function(){ onRemove(item.id); }} style={{ background:"#fef2f2", border:"none", color:"#dc2626", width:24, height:24, borderRadius:6, cursor:"pointer", fontSize:11, flexShrink:0 }}>✕</button>
      </div>
    );
  }

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:16 }}>

      {/* ── IMPOSTOS — Lucro Real ── */}
      <div style={{ background:"#fff", border:"1px solid #fecaca", borderRadius:14, overflow:"hidden" }}>
        <div style={{ background:"#fef2f2", padding:"10px 14px", borderBottom:"1px solid #fecaca", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
          <div>
            <div style={{ fontWeight:700, fontSize:14, color:"#dc2626" }}>📋 Impostos — Regime Lucro Real</div>
            <div style={{ fontSize:11, color:"#94a3b8", marginTop:1 }}>ICMS por estado, IRPJ e CSLL</div>
          </div>
          <div style={{ textAlign:"right" }}>
            <div style={{ fontSize:11, color:"#94a3b8" }}>IRPJ+CSLL s/ faturamento</div>
            <div style={{ fontSize:17, fontWeight:800, color:"#dc2626" }}>R$ {totalImpFixo.toFixed(2).replace(".",",")}</div>
          </div>
        </div>

        <div style={{ padding:"14px 18px" }}>
          {/* IRPJ e CSLL */}
          <div style={{ fontSize:11, color:"#94a3b8", fontWeight:700, textTransform:"uppercase", marginBottom:8 }}>IRPJ e CSLL (sobre o Lucro Real apurado)</div>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:10, marginBottom:14 }}>
            <div>
              <div style={{ fontSize:10, color:"#94a3b8", marginBottom:4 }}>IRPJ base (%)</div>
              <div style={{ display:"flex", alignItems:"center", gap:4 }}>
                <input type="number" step="0.01" value={irpjPct}
                  onChange={function(e){ salvarIrpjCsll(e.target.value, irpjAdicionalPct, csllPct); }}
                  style={{ width:"100%", background:"#f8fafc", border:"1px solid #e2e8f0", color:"#0f172a", padding:"7px 10px", borderRadius:8, fontSize:13, outline:"none" }} />
                <span style={{ fontSize:12, color:"#94a3b8" }}>%</span>
              </div>
            </div>
            <div>
              <div style={{ fontSize:10, color:"#94a3b8", marginBottom:4 }}>IRPJ adicional (%)</div>
              <div style={{ display:"flex", alignItems:"center", gap:4 }}>
                <input type="number" step="0.01" value={irpjAdicionalPct}
                  onChange={function(e){ salvarIrpjCsll(irpjPct, e.target.value, csllPct); }}
                  style={{ width:"100%", background:"#f8fafc", border:"1px solid #e2e8f0", color:"#0f172a", padding:"7px 10px", borderRadius:8, fontSize:13, outline:"none" }} />
                <span style={{ fontSize:12, color:"#94a3b8" }}>%</span>
              </div>
              <div style={{ fontSize:9, color:"#cbd5e1", marginTop:2 }}>Sobre lucro &gt; R$ 20mil/mês</div>
            </div>
            <div>
              <div style={{ fontSize:10, color:"#94a3b8", marginBottom:4 }}>CSLL (%)</div>
              <div style={{ display:"flex", alignItems:"center", gap:4 }}>
                <input type="number" step="0.01" value={csllPct}
                  onChange={function(e){ salvarIrpjCsll(irpjPct, irpjAdicionalPct, e.target.value); }}
                  style={{ width:"100%", background:"#f8fafc", border:"1px solid #e2e8f0", color:"#0f172a", padding:"7px 10px", borderRadius:8, fontSize:13, outline:"none" }} />
                <span style={{ fontSize:12, color:"#94a3b8" }}>%</span>
              </div>
            </div>
          </div>

          {/* ICMS por estado */}
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8 }}>
            <div style={{ fontSize:11, color:"#94a3b8", fontWeight:700, textTransform:"uppercase" }}>
              ICMS por Estado (alíquota interna de venda)
            </div>
            <div style={{ display:"flex", gap:6 }}>
              <button onClick={resetIcmsPadrao}
                style={{ fontSize:10, color:"#0891b2", background:"#ecfeff", border:"1px solid #a5f3fc", padding:"3px 8px", borderRadius:6, cursor:"pointer", fontWeight:600 }}>
                ↺ Usar alíquotas padrão
              </button>
              <button onClick={function(){ setShowIcmsTable(function(v){return !v;}); }}
                style={{ fontSize:10, color:"#64748b", background:"#f8fafc", border:"1px solid #e2e8f0", padding:"3px 8px", borderRadius:6, cursor:"pointer", fontWeight:600 }}>
                {showIcmsTable ? "▲ Ocultar tabela" : "▼ Ver/editar todos os 27 estados"}
              </button>
            </div>
          </div>

          {!showIcmsTable ? (
            <div style={{ display:"flex", alignItems:"center", gap:14, background:"#f8fafc", border:"1px solid #e2e8f0", borderRadius:10, padding:"10px 14px" }}>
              <div>
                <div style={{ fontSize:10, color:"#94a3b8" }}>Estados configurados</div>
                <div style={{ fontSize:16, fontWeight:800, color:"#0f172a" }}>{ufsConfigurados.length}/27</div>
              </div>
              <div style={{ width:1, height:28, background:"#e2e8f0" }} />
              <div>
                <div style={{ fontSize:10, color:"#94a3b8" }}>Alíquota média configurada</div>
                <div style={{ fontSize:16, fontWeight:800, color:"#dc2626" }}>{icmsMedioRef.toFixed(2)}%</div>
              </div>
              {ufsConfigurados.length===0 && (
                <div style={{ fontSize:11, color:"#d97706", marginLeft:"auto" }}>⚠️ Clique em "Usar alíquotas padrão" para começar</div>
              )}
            </div>
          ) : (
            <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:8, maxHeight:340, overflowY:"auto", padding:2 }}>
              {ESTADOS_BR_ICMS.map(function(e){
                var uf = e[0], nome = e[1], padrao = e[2];
                var valorAtual = icmsConfig[uf] !== undefined ? icmsConfig[uf] : "";
                return (
                  <div key={uf} style={{ display:"flex", alignItems:"center", gap:6, background:"#f8fafc", border:"1px solid #e2e8f0", borderRadius:8, padding:"6px 10px" }}>
                    <span style={{ fontSize:11, fontWeight:700, color:"#0f172a", width:26, flexShrink:0 }}>{uf}</span>
                    <span style={{ fontSize:10, color:"#94a3b8", flex:1, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{nome}</span>
                    <input type="number" step="0.1" placeholder={String(padrao)} value={valorAtual}
                      onChange={function(ev){ setIcmsEstado(uf, ev.target.value); }}
                      style={{ width:50, background:"#fff", border:"1px solid #e2e8f0", color:"#0f172a", padding:"3px 5px", borderRadius:6, fontSize:11, outline:"none", textAlign:"center" }} />
                    <span style={{ fontSize:10, color:"#94a3b8" }}>%</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* ── CUSTOS FIXOS DETALHADOS ── */}
      <div style={{ background:"#fff", border:"1px solid #fde68a", borderRadius:14, overflow:"hidden" }}>
        <div style={{ background:"#fffbeb", padding:"10px 14px", borderBottom:"1px solid #fde68a", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
          <div>
            <div style={{ fontWeight:700, fontSize:14, color:"#d97706" }}>🏢 Custos Fixos Detalhados</div>
            <div style={{ fontSize:11, color:"#94a3b8", marginTop:1 }}>Aluguel, salários, assinaturas, sistemas...</div>
          </div>
          <div style={{ textAlign:"right" }}>
            <div style={{ fontSize:11, color:"#94a3b8" }}>Total mensal</div>
            <div style={{ fontSize:17, fontWeight:800, color:"#d97706" }}>R$ {totalFix.toFixed(2).replace(".",",")}</div>
          </div>
        </div>
        <div style={{ padding:"12px 18px" }}>
          {custosFixos.length === 0
            ? <div style={{ fontSize:12, color:"#94a3b8", padding:"8px 0", textAlign:"center" }}>Nenhum custo fixo cadastrado — adicione abaixo com o valor real (R$) de cada item</div>
            : (
              <div>
                <div style={{ display:"flex", gap:8, padding:"4px 0 8px", borderBottom:"1px solid #f1f5f9", fontSize:10, color:"#94a3b8", fontWeight:700, textTransform:"uppercase" }}>
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
              style={{ flex:2, background:"#f8fafc", border:"1px solid #e2e8f0", color:"#0f172a", padding:"7px 10px", borderRadius:8, fontSize:12, outline:"none" }} />
            <div style={{ display:"flex", border:"1px solid #e2e8f0", borderRadius:8, overflow:"hidden", flexShrink:0 }}>
              {["R$","%"].map(function(t){
                return <button key={t} onClick={function(){setNovoCusto(function(s){return Object.assign({},s,{tipo:t});});}}
                  style={{ padding:"7px 10px", border:"none", cursor:"pointer", fontSize:12, fontWeight:700,
                    background: novoCusto.tipo===t?"#0f172a":"#fff", color: novoCusto.tipo===t?"#fff":"#64748b" }}>{t}</button>;
              })}
            </div>
            <input type="number" step="0.01" value={novoCusto.valor} onChange={function(e){setNovoCusto(function(s){return Object.assign({},s,{valor:e.target.value});});}}
              placeholder={novoCusto.tipo==="R$" ? "0,00" : "0"}
              style={{ width:90, background:"#f8fafc", border:"1px solid #e2e8f0", color:"#0f172a", padding:"7px 10px", borderRadius:8, fontSize:12, outline:"none", flexShrink:0 }} />
            <button onClick={addCusto} disabled={!novoCusto.nome||!novoCusto.valor}
              style={{ background: (novoCusto.nome&&novoCusto.valor)?"#0f172a":"#f1f5f9", border:"none", color:(novoCusto.nome&&novoCusto.valor)?"#fff":"#94a3b8",
                fontWeight:700, padding:"7px 16px", borderRadius:8, cursor:(novoCusto.nome&&novoCusto.valor)?"pointer":"not-allowed", fontSize:12, flexShrink:0 }}>+ Adicionar</button>
          </div>
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

function GraficoMeta({ metaMensal, faturamentoMes, progressoMeta, diasNoMes, diaDoMes, mesAtual, rawOrders, fmt }) {
  var rOrders = rawOrders || [];
  var corMeta = progressoMeta >= 100 ? "#15803d" : progressoMeta >= 70 ? "#d97706" : "#dc2626";
  var metaDiaria = diasNoMes > 0 ? metaMensal / diasNoMes : 0;

  // Calcular faturamento acumulado dia a dia no mês atual
  var fatPorDia = [];
  var fatAcum = 0;
  for (var d = 1; d <= diasNoMes; d++) {
    var ano = new Date().getFullYear();
    var mes = new Date().getMonth();
    var ds = new Date(ano, mes, d).toLocaleDateString("sv-SE");
    if (d <= diaDoMes) {
      var dayFat = 0;
      rOrders.forEach(function(o) {
        if (o.status === "paid" && o.date === ds) dayFat += o.price * o.qty;
      });
      fatAcum += dayFat;
      fatPorDia.push(fatAcum);
    } else {
      fatPorDia.push(null);
    }
  }
  var maxGraf = Math.max(metaMensal * 1.05, fatAcum, 1);

  // 12 meses históricos
  var meses12 = [];
  var agora = new Date();
  for (var mi = 11; mi >= 0; mi--) {
    var md = new Date(agora.getFullYear(), agora.getMonth() - mi, 1);
    var mk = md.getFullYear() + "-" + String(md.getMonth() + 1).padStart(2, "0");
    var lbl = md.toLocaleDateString("pt-BR", { month: "short" }).replace(".", "").toUpperCase();
    var fat = 0;
    rOrders.forEach(function(o) {
      if (o.status === "paid" && o.date && o.date.startsWith(mk)) fat += o.price * o.qty;
    });
    meses12.push({ mk: mk, label: lbl, fat: fat, atual: mk === mesAtual });
  }
  var maxMes = Math.max.apply(null, meses12.map(function(m) { return m.fat; }).concat([metaMensal, 1]));

  return (
    <div>
      {/* KPIs */}
      <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:8, marginBottom:8 }}>
        {[
          { label:"Realizado", val: fmt(faturamentoMes), cor: corMeta },
          { label:"Meta", val: fmt(metaMensal), cor: "#0f172a" },
          { label:"Progresso", val: progressoMeta.toFixed(1)+"%", cor: corMeta },
          { label: progressoMeta >= 100 ? "✅ Meta!" : "Faltam", val: progressoMeta >= 100 ? "" : fmt(metaMensal - faturamentoMes), cor: corMeta },
        ].map(function(k) {
          return (
            <div key={k.label} style={{ background:"#f8fafc", borderRadius:8, padding:"10px 12px" }}>
              <div style={{ fontSize:9, color:"#94a3b8", fontWeight:700, textTransform:"uppercase", marginBottom:4 }}>{k.label}</div>
              <div style={{ fontSize:14, fontWeight:800, color:k.cor }}>{k.val}</div>
            </div>
          );
        })}
      </div>

      {/* Barra progresso */}
      <div style={{ height:8, background:"#e2e8f0", borderRadius:99, overflow:"hidden", marginBottom:6 }}>
        <div style={{ width: Math.min(100, progressoMeta) + "%", height:"100%", background:corMeta, borderRadius:99, transition:"width .5s" }} />
      </div>
      <div style={{ fontSize:11, color:"#94a3b8", marginBottom:10 }}>
        Meta diária: {fmt(metaDiaria)} · Ritmo: {fmt(diaDoMes > 0 ? faturamentoMes / diaDoMes : 0)}/dia · {diasNoMes - diaDoMes} dias restantes
      </div>

      {/* Gráfico diário */}
      <div style={{ marginBottom:10 }}>
        <div style={{ fontSize:11, fontWeight:700, color:"#64748b", textTransform:"uppercase", marginBottom:8 }}>
          Evolução diária vs meta — {agora.toLocaleDateString("pt-BR", { month:"long", year:"numeric" })}
        </div>
        <div style={{ display:"flex", alignItems:"flex-end", gap:1, height:80, background:"#f8fafc", borderRadius:8, padding:"8px 6px 0", position:"relative" }}>
          {fatPorDia.map(function(v, i) {
            var metaAcum = metaDiaria * (i + 1);
            var barH = v !== null ? Math.max(2, (v / maxGraf) * 100) : 0;
            var metaH = Math.max(1, (metaAcum / maxGraf) * 100);
            var acima = v !== null && v >= metaAcum;
            return (
              <div key={i} style={{ flex:1, display:"flex", flexDirection:"column", justifyContent:"flex-end", height:"100%", position:"relative" }}
                title={"Dia "+(i+1)+": "+(v !== null ? fmt(v) : "—")+" (meta: "+fmt(metaAcum)+")"}>
                {v !== null && (
                  <div style={{ width:"100%", height:barH+"%", background: acima ? "#15803d" : "#0891b2", borderRadius:"2px 2px 0 0", opacity:0.85 }} />
                )}
                <div style={{ position:"absolute", bottom:metaH+"%", left:0, right:0, borderTop:"1px dashed #ef4444", opacity:0.6 }} />
              </div>
            );
          })}
        </div>
        <div style={{ display:"flex", gap:12, marginTop:6, justifyContent:"center" }}>
          <span style={{ fontSize:10, color:"#0891b2" }}>■ Realizado acumulado</span>
          <span style={{ fontSize:10, color:"#ef4444" }}>— Meta acumulada</span>
        </div>
      </div>

      {/* 12 meses */}
      <div>
        <div style={{ fontSize:11, fontWeight:700, color:"#64748b", textTransform:"uppercase", marginBottom:10 }}>
          Comparativo — Últimos 12 Meses
        </div>
        <div style={{ display:"flex", alignItems:"flex-end", gap:3, height:80 }}>
          {meses12.map(function(m) {
            var barH = maxMes > 0 ? Math.max(2, (m.fat / maxMes) * 100) : 2;
            var atingiu = metaMensal > 0 && m.fat >= metaMensal;
            var cor = m.atual ? corMeta : (atingiu ? "#15803d88" : "#cbd5e1");
            return (
              <div key={m.mk} title={m.label+": "+fmt(m.fat)} style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", gap:3 }}>
                <div style={{ width:"100%", height:barH+"%", background:cor, borderRadius:"3px 3px 0 0",
                  outline: m.atual ? "2px solid #0f172a" : "none", alignSelf:"flex-end" }} />
                <span style={{ fontSize:8, color: m.atual ? "#0f172a" : "#94a3b8", fontWeight: m.atual ? 700 : 400 }}>
                  {m.label}
                </span>
              </div>
            );
          })}
        </div>
        {/* Últimos 4 meses em destaque */}
        <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:6, marginTop:10 }}>
          {meses12.slice(-4).map(function(m) {
            var ok = metaMensal > 0 && m.fat >= metaMensal;
            var pct = metaMensal > 0 ? ((m.fat / metaMensal) * 100).toFixed(0) : null;
            return (
              <div key={m.mk} style={{ background: ok ? "#f0fdf4" : "#f8fafc", border:"1px solid "+(ok?"#bbf7d0":"#e2e8f0"), borderRadius:8, padding:"5px 8px", textAlign:"center" }}>
                <div style={{ fontSize:10, color:"#64748b", fontWeight:600 }}>{m.label}</div>
                <div style={{ fontSize:13, fontWeight:700, color: ok ? "#15803d" : "#0f172a" }}>{fmt(m.fat)}</div>
                {pct && <div style={{ fontSize:10, color: ok ? "#15803d" : "#94a3b8" }}>{pct}% da meta</div>}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function OverviewTab({ enriched, enrichedOrders, rawOrders, contasPagar, contasBancarias, lancamentos, paymentData, shipmentStatuses, metaMensal, setMetaMensal, darkMode, costs, impostos, setImpostos, custosFixos, setCustosFixos }) {
  const [editMeta, setEditMeta] = useState(false);
  const [metaInput, setMetaInput] = useState(String(metaMensal || ""));
  const [overviewTab, setOverviewTab] = useState("resumo"); // resumo | dashboard
  const [dashSubTab, setDashSubTab] = useState("geral"); // geral | vendas | margem | produtos | clientes | abc | metas
  const [sortMargem, setSortMargem] = useState("data"); // data | maior | menor
  const [dashPeriodo, setDashPeriodo] = useState("mes"); // hoje | 7dias | mes | 30dias | ano | custom | mesSel
  const [dashMesSel, setDashMesSel] = useState(() => { var d = new Date(); return d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0"); });
  const [dashDe, setDashDe] = useState("");
  const [dashAte, setDashAte] = useState("");
  const [showDashMesPicker, setShowDashMesPicker] = useState(false);

  const hoje = new Date().toLocaleDateString("sv-SE");
  const mesAtual = hoje.slice(0,7);
  const mesAnterior = new Date(new Date().setMonth(new Date().getMonth()-1)).toLocaleDateString("sv-SE").slice(0,7);

  // ── Calcular range de datas baseado no período selecionado ──
  function getDashRange() {
    var d = new Date();
    var hojeStr = d.toLocaleDateString("sv-SE");
    if (dashPeriodo === "hoje") return { de: hojeStr, ate: hojeStr };
    if (dashPeriodo === "7dias") { var d7 = new Date(); d7.setDate(d7.getDate()-6); return { de: d7.toLocaleDateString("sv-SE"), ate: hojeStr }; }
    if (dashPeriodo === "mes") return { de: mesAtual + "-01", ate: hojeStr };
    if (dashPeriodo === "30dias") { var d30 = new Date(); d30.setDate(d30.getDate()-29); return { de: d30.toLocaleDateString("sv-SE"), ate: hojeStr }; }
    if (dashPeriodo === "ano") return { de: hojeStr.slice(0,4) + "-01-01", ate: hojeStr };
    if (dashPeriodo === "mesSel") {
      var ultimo = new Date(parseInt(dashMesSel.slice(0,4)), parseInt(dashMesSel.slice(5,7)), 0).toLocaleDateString("sv-SE");
      return { de: dashMesSel + "-01", ate: ultimo };
    }
    if (dashPeriodo === "custom") return { de: dashDe || "2000-01-01", ate: dashAte || hojeStr };
    return { de: mesAtual + "-01", ate: hojeStr };
  }
  var dashRange = getDashRange();

  // ── Pedidos no período selecionado ───────────────────────
  const pedidosMes = rawOrders.filter(function(o){
    return o.status === "paid" && o.date >= dashRange.de && o.date <= dashRange.ate;
  });
  const pedidosMesAnt = rawOrders.filter(o => o.date?.startsWith(mesAnterior) && o.status === "paid");
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

  // ── Ranking produtos mais vendidos (período selecionado) ──
  const vendasPorProduto = {};
  rawOrders.filter(function(o){ return o.status === "paid" && o.date >= dashRange.de && o.date <= dashRange.ate; }).forEach(o => {
    const id = o.listing_id;
    if (!id) return;
    if (!vendasPorProduto[id]) vendasPorProduto[id] = { id, title: o.title, qty: 0, revenue: 0 };
    vendasPorProduto[id].qty += o.qty || 1;
    vendasPorProduto[id].revenue += o.price * (o.qty || 1);
  });
  const rankingVendas = Object.values(vendasPorProduto).sort((a,b) => b.qty - a.qty).slice(0,5);
  const maxQty = rankingVendas[0]?.qty || 1;

  // ── Ranking mais lucrativos (período selecionado) ────────
  var lucroPorProduto = {};
  rawOrders.filter(function(o){ return o.status === "paid" && o.date >= dashRange.de && o.date <= dashRange.ate; }).forEach(function(o) {
    var listing = enriched.find(function(l){ return l.id === o.listing_id; });
    if (!listing || !costs[listing.id]) return;
    var id = listing.id;
    if (!lucroPorProduto[id]) lucroPorProduto[id] = { id, title: listing.title, profit: 0, revenue: 0, qty: 0 };
    var lucroUnit = o.price - (listing.fee || 0) - (listing.freteSeller || 0) - costs[listing.id];
    lucroPorProduto[id].profit += lucroUnit * (o.qty || 1);
    lucroPorProduto[id].revenue += o.price * (o.qty || 1);
    lucroPorProduto[id].qty += o.qty || 1;
  });
  const rankingLucro = Object.values(lucroPorProduto)
    .filter(function(p){ return p.profit > 0; })
    .sort(function(a,b){ return b.profit - a.profit; })
    .slice(0, 5);

  // ── Dados para o gráfico (baseado no período selecionado) ──
  var ultimos30dash = [];
  var fat30dash = [];
  var deDate = new Date(dashRange.de);
  var ateDate = new Date(dashRange.ate);
  var diffDias = Math.round((ateDate - deDate) / (1000*60*60*24)) + 1;
  // Limitar a 90 dias no gráfico para não ficar muito denso
  var diasGrafico = Math.min(diffDias, 90);
  var baseGrafico = new Date(ateDate);
  for (var di30 = diasGrafico - 1; di30 >= 0; di30--) {
    var dd30 = new Date(baseGrafico); dd30.setDate(dd30.getDate() - di30);
    var ds30 = dd30.toLocaleDateString("sv-SE");
    if (ds30 < dashRange.de || ds30 > dashRange.ate) continue;
    ultimos30dash.push(ds30);
    var dayFat = rawOrders.filter(function(o){ return o.date === ds30 && o.status === "paid"; });
    fat30dash.push(dayFat.reduce(function(s,o){ return s + o.price * o.qty; }, 0));
  }
  var maxFat30dash = Math.max.apply(null, fat30dash.concat([1]));
  var totalFat30dash = fat30dash.reduce(function(s,v){ return s+v; }, 0);
  var mediaFat30dash = totalFat30dash / Math.max(ultimos30dash.length, 1);

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

  // ── Anúncios com score baixo ─────────────────────────────
  const lowScoreListings = enriched.filter(l => l.score < 50).sort((a,b) => a.score - b.score).slice(0, 5);

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:20 }}>

      {/* ── NAVEGAÇÃO PRINCIPAL ── */}
      <div style={{ display:"flex", gap:2, background:"#f1f5f9", padding:4, borderRadius:10, width:"fit-content" }}>
        {[{key:"resumo",label:"📊 Resumo"},{key:"dashboard",label:"📈 Dashboard"}].map(function(t){
          var active = overviewTab===t.key;
          return <button key={t.key} onClick={function(){setOverviewTab(t.key);}}
            style={{background:active?"#fff":"transparent",border:"none",color:active?"#0f172a":"#94a3b8",
            padding:"8px 20px",cursor:"pointer",fontFamily:"inherit",fontSize:13,
            borderRadius:8,fontWeight:active?700:500,boxShadow:active?"0 1px 3px rgba(0,0,0,.08)":"none"}}>{t.label}</button>;
        })}
      </div>

      {/* ── SUB-NAVEGAÇÃO DO DASHBOARD ── */}
      {overviewTab === "dashboard" && (
        <div style={{ display:"flex", gap:4, flexWrap:"wrap", borderBottom:"2px solid #f1f5f9", paddingBottom:12 }}>
          {[
            { key:"geral",    label:"📊 Dashboard Geral" },
            { key:"vendas",   label:"🛒 Dashboard Vendas" },
            { key:"margem",   label:"💰 Margem por Pedido" },
            { key:"produtos", label:"📦 Dashboard Produtos" },
            { key:"clientes", label:"👥 Dashboard Clientes" },
            { key:"abc",      label:"🏆 Curva ABC" },
            { key:"metas",    label:"🎯 Metas" },
          ].map(function(t){
            var active = dashSubTab===t.key;
            return (
              <button key={t.key} onClick={function(){setDashSubTab(t.key);}}
                style={{ padding:"7px 16px", borderRadius:8, border:"none", cursor:"pointer", fontFamily:"inherit", fontSize:12,
                  fontWeight:active?700:500,
                  background:active?"#0f172a":"#f8fafc",
                  color:active?"#fff":"#64748b",
                  boxShadow:active?"0 2px 6px rgba(0,0,0,.12)":"none" }}>
                {t.label}
              </button>
            );
          })}
        </div>
      )}

      {/* ══ ABA RESUMO ══ */}
      {overviewTab === "resumo" && <div style={{ display:"flex", flexDirection:"column", gap:20 }}>

        {/* Alertas */}
        {(vencidos.length > 0 || vencendo7.length > 0 || agEnvio.length > 5) && (
          <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
            {vencidos.length > 0 && <div style={{ background:"#fef2f2", border:"1px solid #fecaca", borderRadius:10, padding:"10px 16px", display:"flex", alignItems:"center", gap:10 }}>
              <span>🚨</span><span style={{ fontSize:13, color:"#dc2626", fontWeight:600 }}>{vencidos.length} conta(s) vencida(s) — {fmt(vencidos.reduce((s,c)=>s+parseFloat(c.valor||0),0))}</span>
            </div>}
            {vencendo7.length > 0 && <div style={{ background:"#fffbeb", border:"1px solid #fde68a", borderRadius:10, padding:"10px 16px", display:"flex", alignItems:"center", gap:10 }}>
              <span>⏰</span><span style={{ fontSize:13, color:"#d97706", fontWeight:600 }}>{vencendo7.length} conta(s) vencendo em 7 dias</span>
            </div>}
            {agEnvio.length > 5 && <div style={{ background:"#eff6ff", border:"1px solid #bfdbfe", borderRadius:10, padding:"10px 16px", display:"flex", alignItems:"center", gap:10 }}>
              <span>📦</span><span style={{ fontSize:13, color:"#2563eb", fontWeight:600 }}>{agEnvio.length} pedidos aguardando envio</span>
            </div>}
          </div>
        )}

        {/* Cards KPI */}
        <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(160px,1fr))", gap:12 }}>
          <div style={card()}>
            <div style={{ fontSize:11,...txtMuted,fontWeight:600,textTransform:"uppercase",letterSpacing:0.8,marginBottom:6 }}>Hoje</div>
            <div style={{ fontSize:22,fontWeight:800,color:"#0891b2" }}>{fmt(faturamentoHoje)}</div>
            <div style={{ fontSize:12,...txtMuted,marginTop:4 }}>{pedidosHoje.length} pedido(s)</div>
          </div>
          <div style={card()}>
            <div style={{ fontSize:11,...txtMuted,fontWeight:600,textTransform:"uppercase",letterSpacing:0.8,marginBottom:6 }}>Este Mês</div>
            <div style={{ fontSize:22,fontWeight:800,...txt }}>{fmt(faturamentoMes)}</div>
            <div style={{ fontSize:12,color:crescimento>=0?"#15803d":"#dc2626",marginTop:4,fontWeight:600 }}>{crescimento>=0?"▲":"▼"} {Math.abs(crescimento).toFixed(1)}% vs mês anterior</div>
            <SparkLine data={fatPorDia} color={crescimento>=0?"#15803d":"#dc2626"} />
          </div>
          <div style={card()}>
            <div style={{ fontSize:11,...txtMuted,fontWeight:600,textTransform:"uppercase",letterSpacing:0.8,marginBottom:6 }}>Previsão do Mês</div>
            <div style={{ fontSize:22,fontWeight:800,color:"#7c3aed" }}>{fmt(previsaoMes)}</div>
            <div style={{ fontSize:12,...txtMuted,marginTop:4 }}>baseado no ritmo atual</div>
          </div>
          <div style={card()}>
            <div style={{ fontSize:11,...txtMuted,fontWeight:600,textTransform:"uppercase",letterSpacing:0.8,marginBottom:6 }}>Ticket Médio</div>
            <div style={{ fontSize:22,fontWeight:800,...txt }}>{fmt(ticketMedio)}</div>
            <div style={{ fontSize:12,...txtMuted,marginTop:4 }}>{pedidosMes.length} pedidos no mês</div>
          </div>
          <div style={card()}>
            <div style={{ fontSize:11,...txtMuted,fontWeight:600,textTransform:"uppercase",letterSpacing:0.8,marginBottom:6 }}>Cancelamentos</div>
            <div style={{ fontSize:22,fontWeight:800,color:taxaCancel>5?"#dc2626":taxaCancel>2?"#d97706":"#15803d" }}>{taxaCancel.toFixed(1)}%</div>
            <div style={{ fontSize:12,...txtMuted,marginTop:4 }}>{canceladosMes} de {totalMes} pedidos</div>
          </div>
          <div style={card()}>
            <div style={{ fontSize:11,...txtMuted,fontWeight:600,textTransform:"uppercase",letterSpacing:0.8,marginBottom:6 }}>Score Médio</div>
            <div style={{ fontSize:22,fontWeight:800,color:scoreColor(Math.round(enriched.reduce((s,l)=>s+l.score,0)/(enriched.length||1))) }}>
              {Math.round(enriched.reduce((s,l)=>s+l.score,0)/(enriched.length||1))}/100
            </div>
            <div style={{ fontSize:12,...txtMuted,marginTop:4 }}>{enriched.length} anúncios</div>
          </div>
        </div>

        {/* Meta Mensal */}
        {(metaMensal > 0 || editMeta) && (
          <div style={{ ...card(), padding:"12px 16px" }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12 }}>
              <div style={{ fontWeight:700, fontSize:15, ...txt }}>🎯 Meta do Mês</div>
              <button onClick={() => setEditMeta(e=>!e)} style={{ background:"#f1f5f9",border:"none",color:"#64748b",padding:"3px 9px",borderRadius:8,cursor:"pointer",fontSize:12 }}>
                {editMeta ? "Fechar" : "Editar"}
              </button>
            </div>
            {editMeta && (
              <div style={{ display:"flex", gap:8, marginBottom:8 }}>
                <input type="number" value={metaInput} onChange={e=>setMetaInput(e.target.value)} placeholder="Ex: 50000"
                  style={{ flex:1,background:"#f8fafc",border:"1px solid #e2e8f0",color:"#0f172a",padding:"5px 8px",borderRadius:8,fontSize:13,outline:"none" }} />
                <button onClick={() => { const v = parseFloat(metaInput)||0; setMetaMensal(v); localStorage.setItem("metaMensal", v); setEditMeta(false); }}
                  style={{ background:"#0f172a",border:"none",color:"#fff",fontWeight:700,padding:"8px 20px",borderRadius:8,cursor:"pointer",fontSize:13 }}>Salvar</button>
              </div>
            )}
            {metaMensal > 0 && (
              <GraficoMeta
                metaMensal={metaMensal}
                faturamentoMes={faturamentoMes}
                progressoMeta={progressoMeta}
                diasNoMes={diasNoMes}
                diaDoMes={diaDoMes}
                mesAtual={mesAtual}
                rawOrders={rawOrders}
                fmt={fmt}
              />
            )}
          </div>
        )}
        {metaMensal === 0 && !editMeta && (
          <button onClick={() => setEditMeta(true)} style={{ background:"transparent",border:`2px dashed ${darkMode?"#334155":"#e2e8f0"}`,color:darkMode?"#64748b":"#94a3b8",padding:"14px",borderRadius:12,cursor:"pointer",fontSize:13,width:"100%",fontFamily:"inherit" }}>
            + Definir Meta Mensal de Faturamento
          </button>
        )}

        {/* Status dos Pedidos + Anúncios com score baixo */}
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:16 }}>
          <div style={{ background:"#fff", border:"1px solid #e2e8f0", borderRadius:12, boxShadow:"0 1px 3px rgba(15,23,42,.04)", padding:"12px 16px" }}>
            <div style={{ fontWeight:700, fontSize:14, ...txt, marginBottom:8 }}>Status dos Pedidos (mês)</div>
            <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
              {[
                { label:"Ag. Envio", value:statusCount.agEnvio, color:"#d97706", total:totalMes },
                { label:"Enviados",  value:statusCount.enviado,  color:"#0891b2", total:totalMes },
                { label:"Entregues", value:statusCount.entregue, color:"#15803d", total:totalMes },
                { label:"Cancelados",value:statusCount.cancelado,color:"#dc2626", total:totalMes },
              ].map(s => (
                <div key={s.label}>
                  <div style={{ display:"flex", justifyContent:"space-between", marginBottom:4 }}>
                    <span style={{ fontSize:12,...txtMuted }}>{s.label}</span>
                    <span style={{ fontSize:12,fontWeight:700,color:s.color }}>{s.value}</span>
                  </div>
                  <MiniBar value={s.value} max={s.total} color={s.color} />
                </div>
              ))}
            </div>
          </div>

          {lowScoreListings.length > 0 && (
            <div style={{ background:"#fff", border:"1px solid #e2e8f0", borderRadius:12, boxShadow:"0 1px 3px rgba(15,23,42,.04)", padding:"12px 16px" }}>
              <div style={{ fontWeight:700, fontSize:14, ...txt, marginBottom:8 }}>⚠️ Anúncios com Score Baixo</div>
              <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
                {lowScoreListings.map(l => (
                  <div key={l.id} style={{ display:"flex", alignItems:"center", gap:7, paddingBottom:10, borderBottom:"1px solid #f1f5f9" }}>
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ fontSize:12,fontWeight:600,...txt,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>{l.title||l.id}</div>
                    </div>
                    <div style={{ display:"flex", gap:8, alignItems:"center" }}>
                      <span style={{ fontSize:18,fontWeight:800,color:scoreColor(l.score) }}>{l.score}</span>
                      <div style={{ flex:1 }}>
                        {l.checks.filter(c=>!c.pass).slice(0,2).map(c => (
                          <div key={c.key} style={{ fontSize:10,color:"#b91c1c" }}>✗ {c.label}</div>
                        ))}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

      </div>} {/* fim resumo */}

      {/* ══ ABA DASHBOARD ══ */}
      {overviewTab === "dashboard" && (
        <div>
          {/* ── Filtro de Período (sempre visível no dashboard) ── */}
          <div style={{ display:"flex", gap:6, alignItems:"center", marginBottom:8, flexWrap:"wrap" }}>
            <span style={{ fontSize:12, color:"#64748b", fontWeight:600 }}>Período:</span>
            {[
              { key:"hoje",   label:"Hoje" },
              { key:"7dias",  label:"7 dias" },
              { key:"mes",    label:"Este mês" },
              { key:"30dias", label:"30 dias" },
              { key:"ano",    label:"Este ano" },
            ].map(function(p) {
              var isActive = dashPeriodo === p.key;
              return (
                <button key={p.key} onClick={function(){ setDashPeriodo(p.key); setShowDashMesPicker(false); }}
                  style={{ padding:"5px 14px", borderRadius:20, border:"none", cursor:"pointer", fontSize:12,
                    fontWeight:isActive?700:500, background:isActive?"#0f172a":"#f1f5f9", color:isActive?"#fff":"#64748b" }}>
                  {p.label}
                </button>
              );
            })}
            {/* Seletor mês específico */}
            <div style={{ position:"relative" }}>
              <button onClick={function(){ setShowDashMesPicker(function(v){ return !v; }); }}
                style={{ padding:"5px 14px", borderRadius:20, border:"none", cursor:"pointer", fontSize:12,
                  fontWeight:dashPeriodo==="mesSel"?700:500,
                  background:dashPeriodo==="mesSel"?"#0891b2":"#f1f5f9",
                  color:dashPeriodo==="mesSel"?"#fff":"#64748b",
                  display:"flex", alignItems:"center", gap:4 }}>
                📅 {dashPeriodo==="mesSel"
                  ? new Date(dashMesSel+"-15").toLocaleDateString("pt-BR",{month:"short",year:"numeric"})
                  : "Mês"} <span style={{ fontSize:9 }}>▼</span>
              </button>
              {showDashMesPicker && (
                <div style={{ position:"absolute", top:34, left:0, background:"#fff", border:"1px solid #e2e8f0",
                  borderRadius:12, boxShadow:"0 8px 24px rgba(0,0,0,.12)", zIndex:300, padding:10, minWidth:200 }}
                  onMouseLeave={function(){ setShowDashMesPicker(false); }}>
                  <div style={{ fontSize:10, color:"#94a3b8", fontWeight:700, textTransform:"uppercase", marginBottom:6 }}>Selecionar mês</div>
                  <div style={{ maxHeight:220, overflowY:"auto" }}>
                    {(function(){
                      var meses = []; var agora = new Date();
                      for (var i = 0; i < 24; i++) {
                        var d = new Date(agora.getFullYear(), agora.getMonth()-i, 1);
                        var k = d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0");
                        meses.push({ k, nome: d.toLocaleDateString("pt-BR",{month:"long",year:"numeric"}) });
                      }
                      return meses.map(function(m) {
                        var sel = dashMesSel===m.k && dashPeriodo==="mesSel";
                        return (
                          <button key={m.k} onClick={function(){ setDashMesSel(m.k); setDashPeriodo("mesSel"); setShowDashMesPicker(false); }}
                            style={{ width:"100%", textAlign:"left", background:sel?"#0891b2":"transparent",
                              border:"none", color:sel?"#fff":"#334155", padding:"6px 10px",
                              borderRadius:6, cursor:"pointer", fontSize:12, fontWeight:sel?700:400 }}
                            onMouseEnter={function(e){ if(!sel) e.currentTarget.style.background="#f8fafc"; }}
                            onMouseLeave={function(e){ if(!sel) e.currentTarget.style.background="transparent"; }}>
                            {m.nome.charAt(0).toUpperCase()+m.nome.slice(1)}
                          </button>
                        );
                      });
                    })()}
                  </div>
                </div>
              )}
            </div>
            <button onClick={function(){ setDashPeriodo("custom"); setShowDashMesPicker(false); }}
              style={{ padding:"5px 14px", borderRadius:20, border:"none", cursor:"pointer", fontSize:12,
                fontWeight:dashPeriodo==="custom"?700:500,
                background:dashPeriodo==="custom"?"#0f172a":"#f1f5f9",
                color:dashPeriodo==="custom"?"#fff":"#64748b" }}>
              Personalizado
            </button>
            {dashPeriodo === "custom" && (
              <>
                <input type="date" value={dashDe} onChange={function(e){ setDashDe(e.target.value); }}
                  style={{ background:"#fff", border:"1px solid #e2e8f0", color:"#334155", padding:"4px 10px", borderRadius:8, fontSize:12 }} />
                <span style={{ fontSize:12, color:"#94a3b8" }}>até</span>
                <input type="date" value={dashAte} onChange={function(e){ setDashAte(e.target.value); }}
                  style={{ background:"#fff", border:"1px solid #e2e8f0", color:"#334155", padding:"4px 10px", borderRadius:8, fontSize:12 }} />
              </>
            )}
            <span style={{ fontSize:11, color:"#94a3b8", marginLeft:4 }}>
              {pedidosMes.length} pedido(s) · {fmt(faturamentoMes)}
            </span>
          </div>

          {/* ══ GERAL ══ */}
          {dashSubTab === "geral" && (
            <DashboardSubAbas
              fat30={fat30dash} ultimos30={ultimos30dash} maxFat30={maxFat30dash} totalFat30={totalFat30dash} mediaFat30={mediaFat30dash}
              rankingVendas={rankingVendas} rankingLucro={rankingLucro}
              fmt={fmt} card={card} txt={txt} txtMuted={txtMuted}
            />
          )}

          {/* ══ DASHBOARD VENDAS ══ */}
          {dashSubTab === "vendas" && (function(){
            var pedidosPeriodo = rawOrders.filter(function(o){ return o.status==="paid" && o.date>=dashRange.de && o.date<=dashRange.ate; });
            var totalBruto = pedidosPeriodo.reduce(function(s,o){return s+o.price*(o.qty||1);},0);
            var porDia = {}; pedidosPeriodo.forEach(function(o){ porDia[o.date]=(porDia[o.date]||0)+o.price*(o.qty||1); });
            var diasComVenda = Object.keys(porDia).length || 1;
            var mediaDia = totalBruto / diasComVenda;
            var cancelados = rawOrders.filter(function(o){ return o.status==="cancelled" && o.date>=dashRange.de && o.date<=dashRange.ate; }).length;
            var ticketMedio = pedidosPeriodo.length > 0 ? totalBruto/pedidosPeriodo.length : 0;
            var statusCount = {};
            rawOrders.filter(function(o){return o.date>=dashRange.de&&o.date<=dashRange.ate;}).forEach(function(o){ statusCount[o.status]=(statusCount[o.status]||0)+1; });
            return (
              <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
                {/* Cards principais */}
                <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(160px,1fr))", gap:12 }}>
                  {[
                    { l:"Total de Pedidos", v:pedidosPeriodo.length, cor:"#0f172a" },
                    { l:"Faturamento Bruto", v:fmt(totalBruto), cor:"#15803d" },
                    { l:"Ticket Médio", v:fmt(ticketMedio), cor:"#0891b2" },
                    { l:"Média Diária", v:fmt(mediaDia), cor:"#7c3aed" },
                    { l:"Pedidos Cancelados", v:cancelados, cor:"#dc2626" },
                    { l:"Dias com Venda", v:diasComVenda, cor:"#d97706" },
                  ].map(function(k){ return (
                    <div key={k.l} style={{ background:"#fff", border:"1px solid #e2e8f0", borderRadius:12, padding:"14px 16px" }}>
                      <div style={{ fontSize:9, color:"#94a3b8", fontWeight:600, textTransform:"uppercase", marginBottom:3 }}>{k.l}</div>
                      <div style={{ fontSize:17, fontWeight:800, color:k.cor }}>{k.v}</div>
                    </div>
                  ); })}
                </div>
                {/* Vendas por status */}
                <div style={{ background:"#fff", border:"1px solid #e2e8f0", borderRadius:12, padding:"18px 20px" }}>
                  <div style={{ fontWeight:700, fontSize:15, color:"#0f172a", marginBottom:12 }}>Pedidos por Status</div>
                  <div style={{ display:"flex", gap:7, flexWrap:"wrap" }}>
                    {Object.entries(statusCount).map(function(e){
                      var cor=e[0]==="paid"?"#15803d":e[0]==="cancelled"?"#dc2626":"#d97706";
                      var bg=e[0]==="paid"?"#f0fdf4":e[0]==="cancelled"?"#fef2f2":"#fffbeb";
                      return <div key={e[0]} style={{ background:bg, border:"1px solid "+cor+"33", borderRadius:10, padding:"10px 18px", textAlign:"center" }}>
                        <div style={{ fontSize:11, color:cor, fontWeight:600, textTransform:"uppercase" }}>{e[0]}</div>
                        <div style={{ fontSize:17, fontWeight:800, color:cor }}>{e[1]}</div>
                      </div>;
                    })}
                  </div>
                </div>
                {/* Top 10 pedidos por valor */}
                <div style={{ background:"#fff", border:"1px solid #e2e8f0", borderRadius:12, overflow:"auto" }}>
                  <div style={{ padding:"10px 14px", borderBottom:"1px solid #f1f5f9", fontWeight:700, fontSize:15, color:"#0f172a" }}>Top 10 Pedidos por Valor</div>
                  <table style={{ borderCollapse:"collapse", width:"100%" }}>
                    <thead><tr>{["#","Pedido","Data","Produto","Valor"].map(function(h){ return <th key={h} style={{ fontSize:11, color:"#94a3b8", textTransform:"uppercase", padding:"8px 14px", borderBottom:"1px solid #f1f5f9", textAlign:"left", fontWeight:600, background:"#fafafa" }}>{h}</th>; })}</tr></thead>
                    <tbody>{pedidosPeriodo.sort(function(a,b){return (b.price*(b.qty||1))-(a.price*(a.qty||1));}).slice(0,10).map(function(o,i){
                      return <tr key={o.id} style={{ background:i%2===0?"#f8fafc":"#fff" }}>
                        <td style={{ padding:"8px 14px", fontSize:13, fontWeight:700, color:"#94a3b8" }}>{i+1}</td>
                        <td style={{ padding:"8px 14px", fontSize:12, color:"#0891b2", fontFamily:"monospace" }}>#{o.id}</td>
                        <td style={{ padding:"8px 14px", fontSize:12, color:"#64748b" }}>{fmtDate(o.date)}</td>
                        <td style={{ padding:"8px 14px", fontSize:12, color:"#0f172a", maxWidth:200, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{o.title||"—"}</td>
                        <td style={{ padding:"8px 14px", fontSize:13, fontWeight:700, color:"#15803d" }}>{fmt(o.price*(o.qty||1))}</td>
                      </tr>;
                    })}</tbody>
                  </table>
                </div>
              </div>
            );
          })()}

          {/* ══ MARGEM POR PEDIDO ══ */}
          {dashSubTab === "margem" && (function(){
            var pedidosPeriodo = rawOrders.filter(function(o){ return o.status==="paid" && o.date>=dashRange.de && o.date<=dashRange.ate; });
            var comCusto = pedidosPeriodo.map(function(o){
              var listing = enriched.find(function(l){return l.id===o.listing_id;});
              var custo = costs[o.listing_id]||0;
              var bruto = o.price*(o.qty||1);
              var taxa = listing ? (listing.fee||0)*(o.qty||1) : bruto*0.13;
              var frete = listing ? (listing.freteSeller||0)*(o.qty||1) : 0;
              var lucro = bruto - taxa - frete - custo*(o.qty||1);
              var margem = bruto>0?(lucro/bruto)*100:0;
              return Object.assign({},o,{bruto,taxa,frete,custo:custo*(o.qty||1),lucro,margem,listing});
            });
            var comCustoVal = comCusto.filter(function(o){return costs[o.listing_id]>0;});
            var totalBruto=comCusto.reduce(function(s,o){return s+o.bruto;},0);
            var totalLucro=comCustoVal.reduce(function(s,o){return s+o.lucro;},0);
            var margemMedia=comCustoVal.length>0?comCustoVal.reduce(function(s,o){return s+o.margem;},0)/comCustoVal.length:0;
            return (
              <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
                <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(160px,1fr))", gap:12 }}>
                  {[
                    {l:"Pedidos Analisados",v:comCustoVal.length,cor:"#0f172a"},
                    {l:"Faturamento Bruto",v:fmt(totalBruto),cor:"#15803d"},
                    {l:"Lucro Total",v:fmt(totalLucro),cor:totalLucro>=0?"#0891b2":"#dc2626"},
                    {l:"Margem Média",v:margemMedia.toFixed(1)+"%",cor:margemMedia>=20?"#15803d":margemMedia>=10?"#d97706":"#dc2626"},
                    {l:"Sem Custo Cad.",v:comCusto.length-comCustoVal.length,cor:"#dc2626"},
                  ].map(function(k){ return <div key={k.l} style={{ background:"#fff", border:"1px solid #e2e8f0", borderRadius:12, padding:"14px 16px" }}>
                    <div style={{ fontSize:9, color:"#94a3b8", fontWeight:600, textTransform:"uppercase", marginBottom:3 }}>{k.l}</div>
                    <div style={{ fontSize:17, fontWeight:800, color:k.cor }}>{k.v}</div>
                  </div>; })}
                </div>
                {(function(){
                  var pedidosOrdenados = comCusto.slice().sort(function(a, b) {
                    if (sortMargem === "maior") return b.margem - a.margem;
                    if (sortMargem === "menor") return a.margem - b.margem;
                    // padrão: data mais recente primeiro
                    return (b.date||"") > (a.date||"") ? 1 : -1;
                  });

                  return (
                    <div style={{ background:"#fff", border:"1px solid #e2e8f0", borderRadius:12, overflow:"auto" }}>
                      <div style={{ padding:"8px 14px", borderBottom:"1px solid #f1f5f9", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                        <span style={{ fontWeight:700, fontSize:15, color:"#0f172a" }}>Margem por Pedido</span>
                        <div style={{ display:"flex", gap:6, alignItems:"center" }}>
                          <span style={{ fontSize:12, color:"#94a3b8" }}>Ordenar:</span>
                          {[
                            { k:"data",  l:"📅 Data" },
                            { k:"maior", l:"▲ Maior margem" },
                            { k:"menor", l:"▼ Menor margem" },
                          ].map(function(op){
                            var a = sortMargem === op.k;
                            return (
                              <button key={op.k} onClick={function(){ setSortMargem(op.k); }}
                                style={{ padding:"3px 9px", borderRadius:8, border:"1px solid "+(a?"#0f172a":"#e2e8f0"),
                                  background:a?"#0f172a":"#fff", color:a?"#fff":"#64748b",
                                  fontWeight:a?700:400, fontSize:12, cursor:"pointer" }}>
                                {op.l}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                      <table style={{ borderCollapse:"collapse", width:"100%" }}>
                        <thead><tr>{["Pedido","Data","Produto","Bruto","Taxa ML","Frete","Custo","Lucro","Margem"].map(function(h){ return <th key={h} style={{ fontSize:10, color:"#94a3b8", textTransform:"uppercase", padding:"5px 8px", borderBottom:"1px solid #f1f5f9", textAlign:"left", fontWeight:600, background:"#fafafa", whiteSpace:"nowrap" }}>{h}</th>; })}</tr></thead>
                        <tbody>{pedidosOrdenados.slice(0,200).map(function(o,i){
                          var mCor=o.margem>=20?"#15803d":o.margem>=10?"#d97706":"#dc2626";
                          return <tr key={o.id} style={{ background:i%2===0?"#f8fafc":"#fff" }}>
                            <td style={{ padding:"7px 12px", fontSize:11, color:"#0891b2", fontFamily:"monospace" }}>#{o.id}</td>
                            <td style={{ padding:"7px 12px", fontSize:11, color:"#64748b", whiteSpace:"nowrap" }}>{fmtDate(o.date)}</td>
                            <td style={{ padding:"7px 12px", fontSize:11, color:"#0f172a", maxWidth:200, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{o.title||"—"}</td>
                            <td style={{ padding:"7px 12px", fontSize:12, fontWeight:600, color:"#0f172a" }}>{fmt(o.bruto)}</td>
                            <td style={{ padding:"7px 12px", fontSize:12, color:"#dc2626" }}>{fmt(o.taxa)}</td>
                            <td style={{ padding:"7px 12px", fontSize:12, color:"#d97706" }}>{fmt(o.frete)}</td>
                            <td style={{ padding:"7px 12px", fontSize:12, color:"#64748b" }}>{o.custo>0?fmt(o.custo):<span style={{color:"#94a3b8"}}>—</span>}</td>
                            <td style={{ padding:"7px 12px", fontSize:12, fontWeight:700, color:o.lucro>=0?"#0891b2":"#dc2626" }}>{o.custo>0?fmt(o.lucro):<span style={{color:"#94a3b8"}}>—</span>}</td>
                            <td style={{ padding:"7px 12px" }}>{o.custo>0?<span style={{ fontSize:12, fontWeight:700, color:mCor, background:mCor+"11", padding:"2px 7px", borderRadius:5 }}>{o.margem.toFixed(1)}%</span>:<span style={{fontSize:11,color:"#94a3b8"}}>sem custo</span>}</td>
                          </tr>;
                        })}</tbody>
                      </table>
                    </div>
                  );
                })()}
              </div>
            );
          })()}

          {/* ══ DASHBOARD PRODUTOS ══ */}
          {dashSubTab === "produtos" && (function(){
            var pedidosPeriodo = rawOrders.filter(function(o){ return o.status==="paid" && o.date>=dashRange.de && o.date<=dashRange.ate; });
            var porProd = {};
            pedidosPeriodo.forEach(function(o){
              var id=o.listing_id||"sem_listing";
              if(!porProd[id]) porProd[id]={id,titulo:o.title||id,qtd:0,receita:0};
              porProd[id].qtd+=(o.qty||1);
              porProd[id].receita+=o.price*(o.qty||1);
            });
            var ranking=Object.values(porProd).sort(function(a,b){return b.receita-a.receita;});
            return (
              <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
                <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(150px,1fr))", gap:12 }}>
                  {[
                    {l:"Produtos Vendidos",v:ranking.length,cor:"#0f172a"},
                    {l:"Total de Unidades",v:pedidosPeriodo.reduce(function(s,o){return s+(o.qty||1);},0),cor:"#0891b2"},
                    {l:"Receita Total",v:fmt(pedidosPeriodo.reduce(function(s,o){return s+o.price*(o.qty||1);},0)),cor:"#15803d"},
                    {l:"Produto #1",v:ranking[0]?.titulo?.slice(0,20)||"—",cor:"#d97706"},
                  ].map(function(k){ return <div key={k.l} style={{ background:"#fff", border:"1px solid #e2e8f0", borderRadius:12, padding:"14px 16px" }}>
                    <div style={{ fontSize:9, color:"#94a3b8", fontWeight:600, textTransform:"uppercase", marginBottom:3 }}>{k.l}</div>
                    <div style={{ fontSize:k.l==="Produto #1"?13:20, fontWeight:800, color:k.cor }}>{k.v}</div>
                  </div>; })}
                </div>
                <div style={{ background:"#fff", border:"1px solid #e2e8f0", borderRadius:12, overflow:"auto" }}>
                  <div style={{ padding:"10px 14px", borderBottom:"1px solid #f1f5f9", fontWeight:700, fontSize:15, color:"#0f172a" }}>Ranking de Produtos por Receita</div>
                  <table style={{ borderCollapse:"collapse", width:"100%" }}>
                    <thead><tr>{["#","Produto","MLB","Qtd Vendida","Receita","Part. %"].map(function(h){ return <th key={h} style={{ fontSize:10, color:"#94a3b8", textTransform:"uppercase", padding:"8px 14px", borderBottom:"1px solid #f1f5f9", textAlign:"left", fontWeight:600, background:"#fafafa" }}>{h}</th>; })}</tr></thead>
                    <tbody>{(function(){
                      var total=ranking.reduce(function(s,r){return s+r.receita;},0);
                      return ranking.slice(0,50).map(function(r,i){ return <tr key={r.id} style={{ background:i%2===0?"#f8fafc":"#fff" }}>
                        <td style={{ padding:"8px 14px", fontSize:13, fontWeight:800, color:i===0?"#d97706":i===1?"#64748b":i===2?"#d97706":"#94a3b8" }}>{i+1}</td>
                        <td style={{ padding:"8px 14px", fontSize:12, color:"#0f172a", maxWidth:220, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{r.titulo}</td>
                        <td style={{ padding:"8px 14px", fontSize:11, color:"#0891b2", fontFamily:"monospace" }}>{r.id!=="sem_listing"?r.id:"—"}</td>
                        <td style={{ padding:"8px 14px", textAlign:"center", fontSize:13, fontWeight:700, color:"#0891b2" }}>{r.qtd}</td>
                        <td style={{ padding:"8px 14px", fontSize:13, fontWeight:700, color:"#15803d" }}>{fmt(r.receita)}</td>
                        <td style={{ padding:"8px 14px" }}>
                          <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                            <div style={{ flex:1, background:"#f1f5f9", borderRadius:4, height:8, overflow:"hidden" }}>
                              <div style={{ width:(r.receita/total*100).toFixed(1)+"%", background:"#0891b2", height:"100%", borderRadius:4 }} />
                            </div>
                            <span style={{ fontSize:11, color:"#64748b", fontWeight:600 }}>{(r.receita/total*100).toFixed(1)}%</span>
                          </div>
                        </td>
                      </tr>; });
                    })()}</tbody>
                  </table>
                </div>
              </div>
            );
          })()}

          {/* ══ DASHBOARD CLIENTES ══ */}
          {dashSubTab === "clientes" && (function(){
            var pedidosPeriodo = rawOrders.filter(function(o){ return o.status==="paid" && o.date>=dashRange.de && o.date<=dashRange.ate; });
            var porCliente={};
            pedidosPeriodo.forEach(function(o){
              // Chave única do cliente: prioriza o documento (CPF/CNPJ), depois nome, por último o id do pedido
              var doc=(o.buyerDoc||"").replace(/\D/g,"");
              var nome=o.buyerName||o.buyerFirstName||"Cliente sem nome";
              var chave=doc||nome||("pedido_"+o.id);
              if(!porCliente[chave]) porCliente[chave]={chave,nome:nome,doc:o.buyerDoc||"",docType:o.buyerDocType||"",pedidos:0,receita:0,primeiroId:o.id};
              // Preenche nome/doc se algum pedido anterior do mesmo cliente não tinha essa info
              if(!porCliente[chave].nome||porCliente[chave].nome==="Cliente sem nome") porCliente[chave].nome=nome;
              if(!porCliente[chave].doc && o.buyerDoc) { porCliente[chave].doc=o.buyerDoc; porCliente[chave].docType=o.buyerDocType||""; }
              porCliente[chave].pedidos++;
              porCliente[chave].receita+=o.price*(o.qty||1);
            });
            var ranking=Object.values(porCliente).sort(function(a,b){return b.receita-a.receita;});
            var totalReceita=ranking.reduce(function(s,c){return s+c.receita;},0);
            var recorrentes=ranking.filter(function(c){return c.pedidos>1;}).length;
            function fmtDoc(d){
              var n=(d||"").replace(/\D/g,"");
              if(n.length===11) return n.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/,"$1.$2.$3-$4");
              if(n.length===14) return n.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/,"$1.$2.$3/$4-$5");
              return d||"—";
            }
            return (
              <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
                <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(150px,1fr))", gap:12 }}>
                  {[
                    {l:"Clientes Únicos",v:ranking.length,cor:"#0f172a"},
                    {l:"Clientes Recorrentes",v:recorrentes,cor:"#15803d"},
                    {l:"Ticket Médio/Cliente",v:fmt(ranking.length>0?totalReceita/ranking.length:0),cor:"#0891b2"},
                    {l:"Top Cliente",v:ranking[0]?.nome?.slice(0,20)||"—",cor:"#d97706"},
                  ].map(function(k){ return <div key={k.l} style={{ background:"#fff", border:"1px solid #e2e8f0", borderRadius:12, padding:"14px 16px" }}>
                    <div style={{ fontSize:9, color:"#94a3b8", fontWeight:600, textTransform:"uppercase", marginBottom:3 }}>{k.l}</div>
                    <div style={{ fontSize:k.l.includes("Top")?13:20, fontWeight:800, color:k.cor }}>{k.v}</div>
                  </div>; })}
                </div>
                <div style={{ background:"#fff", border:"1px solid #e2e8f0", borderRadius:12, overflow:"auto" }}>
                  <div style={{ padding:"10px 14px", borderBottom:"1px solid #f1f5f9", fontWeight:700, fontSize:15, color:"#0f172a" }}>Top Clientes por Receita</div>
                  <table style={{ borderCollapse:"collapse", width:"100%" }}>
                    <thead><tr>{["#","Cliente","CPF/CNPJ","Pedidos","Receita Total","Ticket Médio","Part. %"].map(function(h){ return <th key={h} style={{ fontSize:10, color:"#94a3b8", textTransform:"uppercase", padding:"8px 14px", borderBottom:"1px solid #f1f5f9", textAlign:"left", fontWeight:600, background:"#fafafa" }}>{h}</th>; })}</tr></thead>
                    <tbody>{ranking.slice(0,50).map(function(c,i){ return <tr key={c.chave} style={{ background:i%2===0?"#f8fafc":"#fff" }}>
                      <td style={{ padding:"8px 14px", fontSize:13, fontWeight:800, color:i===0?"#d97706":"#94a3b8" }}>{i+1}</td>
                      <td style={{ padding:"8px 14px", fontSize:12, color:"#0f172a", maxWidth:200, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{c.nome}</td>
                      <td style={{ padding:"8px 14px", fontSize:11, color:"#64748b", fontFamily:"monospace", whiteSpace:"nowrap" }}>{fmtDoc(c.doc)}</td>
                      <td style={{ padding:"8px 14px", textAlign:"center", fontWeight:700, color:c.pedidos>1?"#15803d":"#64748b" }}>{c.pedidos}{c.pedidos>1&&<span style={{fontSize:10,marginLeft:4,color:"#15803d"}}>✓ recorrente</span>}</td>
                      <td style={{ padding:"8px 14px", fontWeight:700, color:"#15803d" }}>{fmt(c.receita)}</td>
                      <td style={{ padding:"8px 14px", fontSize:12, color:"#64748b" }}>{fmt(c.receita/c.pedidos)}</td>
                      <td style={{ padding:"8px 14px", fontSize:12, color:"#64748b", fontWeight:600 }}>{(c.receita/totalReceita*100).toFixed(1)}%</td>
                    </tr>; })}</tbody>
                  </table>
                </div>
              </div>
            );
          })()}

          {/* ══ CURVA ABC ══ */}
          {dashSubTab === "abc" && (function(){
            var pedidosPeriodo = rawOrders.filter(function(o){ return o.status==="paid" && o.date>=dashRange.de && o.date<=dashRange.ate; });
            var porProd={};
            pedidosPeriodo.forEach(function(o){
              var id=o.listing_id||"sem";
              if(!porProd[id]) porProd[id]={id,titulo:o.title||id,qtd:0,receita:0};
              porProd[id].qtd+=(o.qty||1);
              porProd[id].receita+=o.price*(o.qty||1);
            });
            var total=Object.values(porProd).reduce(function(s,p){return s+p.receita;},0);
            var acum=0;
            var ranking=Object.values(porProd).sort(function(a,b){return b.receita-a.receita;}).map(function(p){
              acum+=p.receita;
              var perc=total>0?(acum/total)*100:0;
              var curva=perc<=80?"A":perc<=95?"B":"C";
              return Object.assign({},p,{acum,percAcum:perc,curva});
            });
            var qtdA=ranking.filter(function(p){return p.curva==="A";}).length;
            var qtdB=ranking.filter(function(p){return p.curva==="B";}).length;
            var qtdC=ranking.filter(function(p){return p.curva==="C";}).length;
            return (
              <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
                <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:12 }}>
                  {[
                    {l:"Curva A",desc:"Representam 80% da receita",v:qtdA+" produtos",cor:"#15803d",bg:"#f0fdf4"},
                    {l:"Curva B",desc:"Entre 80% e 95% da receita",v:qtdB+" produtos",cor:"#d97706",bg:"#fffbeb"},
                    {l:"Curva C",desc:"Últimos 5% da receita",v:qtdC+" produtos",cor:"#dc2626",bg:"#fef2f2"},
                  ].map(function(k){ return <div key={k.l} style={{ background:k.bg, border:"1px solid "+k.cor+"33", borderRadius:12, padding:"16px 18px" }}>
                    <div style={{ fontSize:15, fontWeight:800, color:k.cor, marginBottom:4 }}>{k.l}</div>
                    <div style={{ fontSize:17, fontWeight:800, color:"#0f172a" }}>{k.v}</div>
                    <div style={{ fontSize:11, color:"#64748b", marginTop:4 }}>{k.desc}</div>
                  </div>; })}
                </div>
                <div style={{ background:"#fff", border:"1px solid #e2e8f0", borderRadius:12, overflow:"auto" }}>
                  <div style={{ padding:"10px 14px", borderBottom:"1px solid #f1f5f9", fontWeight:700, fontSize:15, color:"#0f172a" }}>Curva ABC de Produtos</div>
                  <table style={{ borderCollapse:"collapse", width:"100%" }}>
                    <thead><tr>{["#","Curva","Produto","MLB","Qtd","Receita","Part. %","Acum. %"].map(function(h){ return <th key={h} style={{ fontSize:10, color:"#94a3b8", textTransform:"uppercase", padding:"5px 8px", borderBottom:"1px solid #f1f5f9", textAlign:"left", fontWeight:600, background:"#fafafa", whiteSpace:"nowrap" }}>{h}</th>; })}</tr></thead>
                    <tbody>{ranking.map(function(p,i){
                      var cor=p.curva==="A"?"#15803d":p.curva==="B"?"#d97706":"#dc2626";
                      var bg=p.curva==="A"?"#f0fdf4":p.curva==="B"?"#fffbeb":"#fef2f2";
                      return <tr key={p.id} style={{ background:i%2===0?"#f9f9f9":"#fff" }}>
                        <td style={{ padding:"7px 12px", fontSize:12, fontWeight:700, color:"#94a3b8" }}>{i+1}</td>
                        <td style={{ padding:"7px 12px" }}><span style={{ fontSize:12, fontWeight:800, color:cor, background:bg, padding:"2px 10px", borderRadius:20 }}>{p.curva}</span></td>
                        <td style={{ padding:"7px 12px", fontSize:12, color:"#0f172a", maxWidth:200, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{p.titulo}</td>
                        <td style={{ padding:"7px 12px", fontSize:11, color:"#0891b2", fontFamily:"monospace" }}>{p.id!=="sem"?p.id:"—"}</td>
                        <td style={{ padding:"7px 12px", textAlign:"center", fontWeight:700, color:"#0891b2" }}>{p.qtd}</td>
                        <td style={{ padding:"7px 12px", fontWeight:700, color:"#15803d" }}>{fmt(p.receita)}</td>
                        <td style={{ padding:"7px 12px", fontSize:12, color:"#64748b" }}>{(p.receita/total*100).toFixed(2)}%</td>
                        <td style={{ padding:"7px 12px" }}>
                          <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                            <div style={{ width:60, background:"#f1f5f9", borderRadius:4, height:8, overflow:"hidden" }}>
                              <div style={{ width:Math.min(p.percAcum,100).toFixed(0)+"%", background:cor, height:"100%", borderRadius:4 }} />
                            </div>
                            <span style={{ fontSize:11, fontWeight:600, color:cor }}>{p.percAcum.toFixed(1)}%</span>
                          </div>
                        </td>
                      </tr>;
                    })}</tbody>
                  </table>
                </div>
              </div>
            );
          })()}

          {/* ══ METAS ══ */}
          {dashSubTab === "metas" && (
            <GraficoMeta metaMensal={metaMensal} faturamentoMes={faturamentoMes} progressoMeta={progressoMeta} diasNoMes={diasNoMes} diaDoMes={diaDoMes} mesAtual={mesAtual} rawOrders={rawOrders} fmt={fmt} />
          )}

        </div>
      )}

    </div>
  );
}


// ════════════════════════════════════════════════════════════
//  DASHBOARD SUB-ABAS
// ════════════════════════════════════════════════════════════
function DashboardSubAbas({ fat30, ultimos30, maxFat30, totalFat30, mediaFat30, rankingVendas, rankingLucro, fmt, card, txt, txtMuted }) {
  const [dashTab, setDashTab] = useState("fat30");
  const [sortVendidos, setSortVendidos] = useState("qty"); // "qty" | "revenue"
  const [sortLucro, setSortLucro] = useState("valor"); // "valor" | "margem"
  return (
    <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
      <div style={{ display:"flex", gap:2, background:"#f1f5f9", padding:4, borderRadius:10, width:"fit-content" }}>
        {[{key:"fat30",label:"📅 Faturamento 30 dias"},{key:"vendidos",label:"🏆 Mais Vendidos"},{key:"lucro",label:"💰 Mais Lucrativos"}].map(function(t){
          var active = dashTab===t.key;
          return <button key={t.key} onClick={function(){setDashTab(t.key);}}
            style={{background:active?"#fff":"transparent",border:"none",color:active?"#0f172a":"#94a3b8",
            padding:"7px 16px",cursor:"pointer",fontFamily:"inherit",fontSize:12,
            borderRadius:8,fontWeight:active?700:500,boxShadow:active?"0 1px 3px rgba(0,0,0,.08)":"none"}}>{t.label}</button>;
        })}
      </div>

      {/* Faturamento 30 dias */}
      {dashTab === "fat30" && (
        <div style={{ background:"#fff", border:"1px solid #e2e8f0", borderRadius:14, padding:"12px 16px" }}>
          <div style={{ fontWeight:700, fontSize:15, color:"#0f172a", marginBottom:4 }}>📅 Faturamento — Últimos 30 dias</div>
          <div style={{ fontSize:12, color:"#94a3b8", marginBottom:10 }}>Faturamento bruto diário</div>
          <div style={{ display:"flex", gap:16, marginBottom:8, flexWrap:"wrap" }}>
            <div style={{ background:"#f0fdf4", borderRadius:10, padding:"12px 16px" }}>
              <div style={{ fontSize:10, color:"#15803d", fontWeight:700, textTransform:"uppercase", marginBottom:4 }}>Total 30 dias</div>
              <div style={{ fontSize:17, fontWeight:800, color:"#15803d" }}>{fmt(totalFat30)}</div>
            </div>
            <div style={{ background:"#eff6ff", borderRadius:10, padding:"12px 16px" }}>
              <div style={{ fontSize:10, color:"#1d4ed8", fontWeight:700, textTransform:"uppercase", marginBottom:4 }}>Média diária</div>
              <div style={{ fontSize:17, fontWeight:800, color:"#1d4ed8" }}>{fmt(mediaFat30)}</div>
            </div>
            <div style={{ background:"#f5f3ff", borderRadius:10, padding:"12px 16px" }}>
              <div style={{ fontSize:10, color:"#7c3aed", fontWeight:700, textTransform:"uppercase", marginBottom:4 }}>Melhor dia</div>
              <div style={{ fontSize:17, fontWeight:800, color:"#7c3aed" }}>{fmt(maxFat30)}</div>
            </div>
          </div>
          <div style={{ display:"flex", gap:2, alignItems:"flex-end", height:140, marginBottom:8 }}>
            {fat30.map(function(v, i) {
              var isHoje = i === 29;
              var pct = maxFat30 > 0 ? (v / maxFat30) : 0;
              var barH = Math.max(4, pct * 120);
              var dataStr = ultimos30[i] ? ultimos30[i].slice(8) + "/" + ultimos30[i].slice(5,7) : "";
              return (
                <div key={i} style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", gap:2 }}>
                  <div title={dataStr + ": " + fmt(v)}
                    style={{ width:"100%", borderRadius:"3px 3px 0 0", cursor:"pointer",
                      background: isHoje ? "#0f172a" : v === maxFat30 && v > 0 ? "#15803d" : v > mediaFat30 ? "#0891b2" : "#e2e8f0",
                      height: barH + "px", transition:"height .3s" }} />
                  <div style={{ fontSize:7, color:isHoje?"#0f172a":"#94a3b8", whiteSpace:"nowrap", fontWeight:isHoje?700:400, transform:"rotate(-45deg)", transformOrigin:"top center", marginTop:2 }}>{dataStr}</div>
                </div>
              );
            })}
          </div>
          <div style={{ display:"flex", gap:12, fontSize:11, color:"#94a3b8", flexWrap:"wrap" }}>
            <span>⬛ Hoje</span>
            <span style={{ color:"#15803d" }}>■ Melhor dia</span>
            <span style={{ color:"#0891b2" }}>■ Acima da média</span>
            <span>□ Abaixo da média</span>
          </div>
        </div>
      )}

      {/* Mais Vendidos */}
      {dashTab === "vendidos" && (
        <div style={{ background:"#fff", border:"1px solid #e2e8f0", borderRadius:14, padding:"12px 16px" }}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8 }}>
            <div style={{ fontWeight:700, fontSize:15, color:"#0f172a" }}>🏆 Mais Vendidos</div>
            {rankingVendas && rankingVendas.length > 0 && (
              <div style={{ display:"flex", gap:4, background:"#f1f5f9", padding:3, borderRadius:8 }}>
                {[{k:"qty",l:"Qtd. vendas"},{k:"revenue",l:"R$ Faturado"}].map(function(op){
                  var active = sortVendidos === op.k;
                  return (
                    <button key={op.k} onClick={function(){setSortVendidos(op.k);}}
                      style={{ padding:"3px 9px", borderRadius:6, border:"none", cursor:"pointer", fontFamily:"inherit",
                        fontSize:11, fontWeight:active?700:500,
                        background:active?"#fff":"transparent",
                        color:active?"#0f172a":"#94a3b8",
                        boxShadow:active?"0 1px 2px rgba(0,0,0,.08)":"none" }}>
                      {op.l}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          {!rankingVendas || rankingVendas.length === 0 ? (
            <div style={{ fontSize:13, color:"#94a3b8", textAlign:"center", padding:"10px 0" }}>Sem dados de vendas</div>
          ) : (function(){
            var lista = rankingVendas.slice();
            if (sortVendidos === "revenue") {
              lista = lista.sort(function(a,b){ return b.revenue - a.revenue; });
            } else {
              lista = lista.sort(function(a,b){ return b.qty - a.qty; });
            }
            return lista.slice(0,15).map(function(p,i) {
              return (
                <div key={p.id} style={{ display:"flex", alignItems:"center", gap:12, marginBottom:12, paddingBottom:12, borderBottom: i<lista.slice(0,15).length-1?"1px solid #f1f5f9":"none" }}>
                  <div style={{ width:28,height:28,borderRadius:8,background:i===0?"#fde68a":i===1?"#e2e8f0":i===2?"#fed7aa":"#f8fafc",display:"flex",alignItems:"center",justifyContent:"center",fontWeight:800,fontSize:13,color:"#0f172a",flexShrink:0 }}>{i+1}</div>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontSize:12,fontWeight:600,color:"#0f172a",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>{p.title||p.id}</div>
                    <div style={{ display:"flex", gap:7, marginTop:3 }}>
                      <span style={{ fontSize:11,color:"#0891b2",fontWeight:600 }}>{p.qty} vendas</span>
                      <span style={{ fontSize:11,color:"#94a3b8" }}>{fmt(p.revenue)}</span>
                    </div>
                  </div>
                  <div style={{ textAlign:"right", flexShrink:0 }}>
                    <div style={{ fontSize:14,fontWeight:800,color:sortVendidos==="revenue"?"#15803d":"#0891b2" }}>
                      {sortVendidos==="revenue" ? fmt(p.revenue) : p.qty + " un"}
                    </div>
                    <div style={{ fontSize:10,color:"#94a3b8" }}>{sortVendidos==="revenue"?"faturado":"vendidos"}</div>
                  </div>
                </div>
              );
            });
          })()}
        </div>
      )}

      {/* Mais Lucrativos */}
      {dashTab === "lucro" && (
        <div style={{ background:"#fff", border:"1px solid #e2e8f0", borderRadius:14, padding:"12px 16px" }}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8 }}>
            <div style={{ fontWeight:700, fontSize:15, color:"#0f172a" }}>💰 Mais Lucrativos</div>
            {rankingLucro && rankingLucro.length > 0 && (
              <div style={{ display:"flex", gap:4, background:"#f1f5f9", padding:3, borderRadius:8 }}>
                {[{k:"valor",l:"R$ Lucro"},{k:"margem",l:"% Margem"}].map(function(op){
                  var active = sortLucro === op.k;
                  return (
                    <button key={op.k} onClick={function(){setSortLucro(op.k);}}
                      style={{ padding:"3px 9px", borderRadius:6, border:"none", cursor:"pointer", fontFamily:"inherit",
                        fontSize:11, fontWeight:active?700:500,
                        background:active?"#fff":"transparent",
                        color:active?"#0f172a":"#94a3b8",
                        boxShadow:active?"0 1px 2px rgba(0,0,0,.08)":"none" }}>
                      {op.l}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          {!rankingLucro || rankingLucro.length === 0 ? (
            <div style={{ fontSize:13, color:"#94a3b8", textAlign:"center", padding:"10px 0" }}>Cadastre custos nos anúncios para ver ranking de lucro</div>
          ) : (function(){
            var lista = rankingLucro.slice();
            if (sortLucro === "margem") {
              lista = lista.sort(function(a,b){
                var mA = a.revenue>0 ? a.profit/a.revenue : 0;
                var mB = b.revenue>0 ? b.profit/b.revenue : 0;
                return mB - mA;
              });
            }
            return lista.slice(0,15).map(function(p,i) {
              var margem = p.revenue > 0 ? (p.profit/p.revenue)*100 : 0;
              var margemColor = margem >= 25 ? "#15803d" : margem >= 15 ? "#d97706" : "#dc2626";
              return (
                <div key={p.id} style={{ display:"flex", alignItems:"center", gap:12, marginBottom:12, paddingBottom:12, borderBottom: i<lista.slice(0,15).length-1?"1px solid #f1f5f9":"none" }}>
                  <div style={{ width:28,height:28,borderRadius:8,background:i===0?"#fde68a":i===1?"#e2e8f0":i===2?"#fed7aa":"#f8fafc",display:"flex",alignItems:"center",justifyContent:"center",fontWeight:800,fontSize:13,color:"#0f172a",flexShrink:0 }}>{i+1}</div>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontSize:12,fontWeight:600,color:"#0f172a",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>{p.title||p.id}</div>
                    <div style={{ display:"flex", gap:7, marginTop:3 }}>
                      <span style={{ fontSize:11,color:"#15803d",fontWeight:600 }}>{fmt(p.profit)}</span>
                      <span style={{ fontSize:11,color:"#94a3b8" }}>{p.qty} venda(s)</span>
                    </div>
                  </div>
                  <div style={{ textAlign:"right", flexShrink:0 }}>
                    <div style={{ fontSize:14,fontWeight:800,color:margemColor }}>{margem.toFixed(1)}%</div>
                    <div style={{ fontSize:10,color:"#94a3b8" }}>margem</div>
                  </div>
                </div>
              );
            });
          })()}
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
        const forn = (fornecedores||[]).find(f => f.cnpj?.replace(/\D/g,"") === parsed.emitente.cnpj?.replace(/\D/g,""));
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

  const inp = { background:"#f8fafc", border:"1px solid #e2e8f0", color:"#0f172a", padding:"5px 8px", borderRadius:8, fontSize:13, outline:"none", fontFamily:"inherit", width:"100%" };

  const SUBTABS = [
    { key:"geral", label:"📋 Geral" },
    { key:"itens", label:`📦 Itens (${form.itens.length})` },
    { key:"financeiro", label:`💰 Financeiro (${form.duplicatas.length})` },
    { key:"config", label:"⚙️ Opções" },
  ];

  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(15,23,42,.65)", backdropFilter:"blur(4px)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:600, padding:12 }}>
      <div style={{ background:"#fff", borderRadius:16, width:"100%", maxWidth:"98vw", height:"96vh", maxHeight:"96vh", display:"flex", flexDirection:"column", boxShadow:"0 20px 60px rgba(0,0,0,.2)" }}>
        {/* Header */}
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"10px 16px", borderBottom:"1px solid #f1f5f9" }}>
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
        <div style={{ flex:1, overflowY:"auto", padding:"12px 16px" }}>

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
                    const f = (fornecedores||[]).find(f=>f.id===e.target.value);
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
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8 }}>
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
                    <div style={{ flex:1, minWidth:110 }}>
                      <div style={{ fontSize:10, color:"#94a3b8", marginBottom:4, fontWeight:600 }}>BUSCAR POR SKU</div>
                      <input placeholder="Digite o SKU..."
                        value={it.skuBusca!==undefined ? it.skuBusca : ""}
                        onChange={function(e){
                          var val = e.target.value;
                          var matchExato = produtos.find(function(p){ return p.sku && p.sku.trim().toLowerCase() === val.trim().toLowerCase(); });
                          var updated = form.itens.map(function(it2,i2){
                            if (i2 !== idx) return it2;
                            var up = Object.assign({}, it2, { skuBusca: val });
                            if (matchExato) up.produtoCadastradoId = matchExato.id;
                            return up;
                          });
                          set("itens", updated);
                        }}
                        style={{ ...inp, fontSize:12, borderColor: it.skuBusca && !produtos.some(function(p){return p.sku&&p.sku.trim().toLowerCase()===it.skuBusca.trim().toLowerCase();}) ? "#fca5a5" : undefined }} />
                    </div>
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
              <div style={{ background:"#f0fdf4", border:"1px solid #bbf7d0", borderRadius:10, padding:"12px 16px", marginBottom:8, fontSize:13, color:"#15803d" }}>
                💡 Cada duplicata (parcela) será lançada como uma conta a pagar no Financeiro.
              </div>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8 }}>
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
                <label style={{ display:"flex", alignItems:"center", gap:7, cursor:"pointer", padding:"12px 16px", background:"#f0fdf4", border:"1px solid #bbf7d0", borderRadius:10 }}>
                  <input type="checkbox" checked={form.atualizarEstoque} onChange={e=>set("atualizarEstoque",e.target.checked)} style={{ width:16, height:16 }} />
                  <div>
                    <div style={{ fontWeight:700, fontSize:13, color:"#15803d" }}>📦 Atualizar estoque dos produtos</div>
                    <div style={{ fontSize:12, color:"#64748b" }}>Soma a quantidade de cada item vinculado ao seu produto cadastrado</div>
                  </div>
                </label>
                <label style={{ display:"flex", alignItems:"center", gap:7, cursor:"pointer", padding:"12px 16px", background:"#eff6ff", border:"1px solid #bfdbfe", borderRadius:10 }}>
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
                  <div style={{ fontWeight:700, fontSize:13, color:"#0f172a", marginBottom:8 }}>Configuração das Contas a Pagar</div>
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

// ── Precificar direto da NF Entrada — mesma lógica/fórmulas da aba Precificação ──
// Usa as mesmas chaves de localStorage (fretes_config, precos_venda_config, descontos_config)
// que a aba Precificação, então qualquer ajuste feito aqui já aparece lá também.
function ModalPrecificarNF({ nf, produtos, enriched, costs, setCosts, onClose }) {
  const [margemAlvo] = useState(20);
  const [custosLocais, setCustosLocais] = useState({});
  const [fretesConfig, setFretesConfigState] = useState(function(){
    try { return JSON.parse(localStorage.getItem("fretes_config")||"{}"); } catch { return {}; }
  });
  function setFretesAndSave(updater) {
    setFretesConfigState(function(prev){
      var next = typeof updater === "function" ? updater(prev) : updater;
      try { localStorage.setItem("fretes_config", JSON.stringify(next)); } catch {}
      return next;
    });
  }
  const [descontosConfig, setDescontosConfig] = useState(function(){
    try { return JSON.parse(localStorage.getItem("descontos_config")||"{}"); } catch { return {}; }
  });
  function setDesconto(id, pct) {
    var next = Object.assign({}, descontosConfig, { [id]: pct });
    setDescontosConfig(next);
    try { localStorage.setItem("descontos_config", JSON.stringify(next)); } catch {}
  }
  const [precosVendaConfig, setPrecosVendaConfig] = useState(function(){
    try { return JSON.parse(localStorage.getItem("precos_venda_config")||"{}"); } catch { return {}; }
  });
  function setPrecoVenda(id, preco) {
    var next = Object.assign({}, precosVendaConfig, { [id]: preco });
    setPrecosVendaConfig(next);
    try { localStorage.setItem("precos_venda_config", JSON.stringify(next)); } catch {}
  }
  const [editingCampo, setEditingCampo] = useState(null); // `${mlbId}:${campo}`

  // Produtos desta NF que têm produto cadastrado vinculado a pelo menos um MLB
  const itensPrecificaveis = (nf.itens || []).filter(function(it){ return it.produtoCadastradoId; }).map(function(it){
    var prod = produtos.find(function(p){ return p.id === it.produtoCadastradoId; });
    var mlbs = prod ? (prod.mlbsVinculados || (prod.mlbVinculado ? [prod.mlbVinculado] : [])) : [];
    return { item: it, produto: prod, mlbs: mlbs };
  }).filter(function(x){ return x.mlbs.length > 0; });

  var linhas = [];
  itensPrecificaveis.forEach(function(x){
    x.mlbs.forEach(function(mlbId){
      var l = enriched.find(function(e){ return e.id === mlbId; });
      if (l) linhas.push({ produto: x.produto, listing: l });
    });
  });

  function fmt2(n) { return "R$ " + Number(n||0).toFixed(2).replace(".",","); }

  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(15,23,42,.65)", backdropFilter:"blur(4px)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:700, padding:16 }}>
      <div style={{ background:"#fff", borderRadius:16, width:"100%", maxWidth:960, maxHeight:"92vh", display:"flex", flexDirection:"column", boxShadow:"0 20px 60px rgba(0,0,0,.25)" }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"14px 20px", borderBottom:"1px solid #f1f5f9" }}>
          <div>
            <div style={{ fontWeight:800, fontSize:17, color:"#0f172a" }}>📊 Precificar itens da NF {nf.numero}/{nf.serie}</div>
            <div style={{ fontSize:12, color:"#94a3b8", marginTop:2 }}>{nf.fornecedorNome} — mesma lógica da aba Precificação: defina o preço de venda desejado (com desconto) e o sistema calcula o preço a anunciar</div>
          </div>
          <button onClick={onClose} style={{ background:"#f1f5f9", border:"none", color:"#64748b", width:30, height:30, borderRadius:8, cursor:"pointer", fontSize:14 }}>✕</button>
        </div>

        <div style={{ flex:1, overflowY:"auto", padding:"12px 20px" }}>
          {linhas.length === 0 ? (
            <div style={{ background:"#fef2f2", border:"1px solid #fecaca", borderRadius:10, padding:"16px", color:"#dc2626", fontSize:13 }}>
              ⚠ Nenhum item desta NF está vinculado a um produto cadastrado com anúncio (MLB) associado. Vincule os itens da NF a um produto, e o produto a um anúncio, para poder precificar aqui.
            </div>
          ) : linhas.map(function(row){
            var l = row.listing;
            var custo = custosLocais[l.id] !== undefined ? custosLocais[l.id] : (costs[l.id]||0);
            var bruto = l.price || 0;
            var taxa = l.fee || bruto * 0.13;
            var freteReal = l.freteSeller || 0;
            var freteConfig = parseFloat(fretesConfig&&fretesConfig[l.id]||0);
            var frete = freteConfig > 0 ? freteConfig : freteReal;
            var precoVendaDesejado = parseFloat(precosVendaConfig&&precosVendaConfig[l.id]||0);
            var descPct = parseFloat(descontosConfig&&descontosConfig[l.id]||0);
            var precoParaAnunciar = precoVendaDesejado > 0
              ? (descPct > 0 ? precoVendaDesejado / (1 - descPct/100) : precoVendaDesejado)
              : 0;
            var precoComDesc = precoVendaDesejado > 0 ? precoVendaDesejado : (descPct > 0 ? bruto * (1 - descPct/100) : bruto);
            var feeRate = taxa > 0 && bruto > 0 ? taxa/bruto : (l.feeRate||0.12);
            var taxaSobreDesc = precoComDesc * feeRate;
            var lucroFinal = precoComDesc - custo - frete - taxaSobreDesc;
            var margemFinal = precoComDesc > 0 ? (lucroFinal/precoComDesc)*100 : 0;
            var mCor = margemFinal >= margemAlvo ? "#15803d" : margemFinal >= margemAlvo*0.6 ? "#d97706" : "#dc2626";

            return (
              <div key={l.id} style={{ border:"1px solid #e2e8f0", borderRadius:12, padding:"14px 16px", marginBottom:10 }}>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:10, gap:10 }}>
                  <div style={{ minWidth:0 }}>
                    <div style={{ fontWeight:700, fontSize:13, color:"#0f172a", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{l.title}</div>
                    <div style={{ fontSize:11, color:"#94a3b8", marginTop:2 }}>SKU: {row.produto?.sku || "—"} · MLB: {l.id}</div>
                  </div>
                  <div style={{ textAlign:"right", flexShrink:0 }}>
                    <div style={{ fontSize:10, color:"#94a3b8" }}>Margem simulada</div>
                    <div style={{ fontSize:16, fontWeight:800, color:mCor }}>{margemFinal.toFixed(1)}%</div>
                  </div>
                </div>

                <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(120px,1fr))", gap:10 }}>
                  {/* Custo */}
                  <div>
                    <div style={{ fontSize:10, color:"#94a3b8", marginBottom:3 }}>Custo</div>
                    {editingCampo === l.id+":custo" ? (
                      <input type="number" step="0.01" defaultValue={custo} autoFocus
                        onBlur={function(e){ var v=parseFloat(e.target.value)||0; setCustosLocais(function(c){return {...c,[l.id]:v};}); setCosts(function(c){return {...c,[l.id]:v};}); setEditingCampo(null); }}
                        style={{ width:"100%", background:"#fff", border:"1px solid #0891b2", color:"#0f172a", padding:"5px 8px", borderRadius:6, fontSize:12, outline:"none" }} />
                    ) : (
                      <div onClick={function(){setEditingCampo(l.id+":custo");}} style={{ cursor:"pointer", fontSize:13, fontWeight:700, color:custo>0?"#334155":"#dc2626" }}>
                        {custo>0?fmt2(custo):"✎ definir"}
                      </div>
                    )}
                  </div>

                  {/* Preço Atual */}
                  <div>
                    <div style={{ fontSize:10, color:"#94a3b8", marginBottom:3 }}>Preço atual</div>
                    <div style={{ fontSize:13, fontWeight:700, color:"#0f172a", padding:"5px 0" }}>{fmt2(bruto)}</div>
                  </div>

                  {/* Frete */}
                  <div>
                    <div style={{ fontSize:10, color:"#94a3b8", marginBottom:3 }}>Frete (real {fmt2(freteReal)})</div>
                    {editingCampo === l.id+":frete" ? (
                      <input type="number" step="0.01" defaultValue={freteConfig||""} placeholder="0,00" autoFocus
                        onBlur={function(e){ var v=parseFloat(e.target.value)||0; setFretesAndSave(function(f){return Object.assign({},f,{[l.id]:v});}); setEditingCampo(null); }}
                        style={{ width:"100%", background:"#fff", border:"1px solid #0891b2", color:"#0f172a", padding:"5px 8px", borderRadius:6, fontSize:12, outline:"none" }} />
                    ) : (
                      <div onClick={function(){setEditingCampo(l.id+":frete");}} style={{ cursor:"pointer", fontSize:13, fontWeight:600, color:freteConfig>0?"#d97706":"#94a3b8" }}>
                        {freteConfig>0?fmt2(freteConfig):"✎ usar real"}
                      </div>
                    )}
                  </div>

                  {/* % Desconto */}
                  <div>
                    <div style={{ fontSize:10, color:"#94a3b8", marginBottom:3 }}>% Desconto promoção</div>
                    {editingCampo === l.id+":desc" ? (
                      <input type="number" min="0" max="80" step="1" defaultValue={descPct||""} placeholder="0" autoFocus
                        onBlur={function(e){ var v=Math.min(80,Math.max(0,parseFloat(e.target.value)||0)); setDesconto(l.id,v); setEditingCampo(null); }}
                        style={{ width:"100%", background:"#fff", border:"1px solid #7c3aed", color:"#0f172a", padding:"5px 8px", borderRadius:6, fontSize:12, outline:"none" }} />
                    ) : (
                      <div onClick={function(){setEditingCampo(l.id+":desc");}} style={{ cursor:"pointer", fontSize:13, fontWeight:600, color:descPct>0?"#7c3aed":"#94a3b8" }}>
                        {descPct>0?descPct+"%":"✎ definir"}
                      </div>
                    )}
                  </div>

                  {/* Vender por → Anunciar por */}
                  <div style={{ gridColumn:"span 2" }}>
                    <div style={{ fontSize:10, color:"#94a3b8", marginBottom:3 }}>Vender por (c/ desconto) → anunciar por</div>
                    {editingCampo === l.id+":venda" ? (
                      <input type="number" step="0.01" min="0" defaultValue={precoVendaDesejado||""} placeholder={bruto.toFixed(2)} autoFocus
                        onBlur={function(e){ var v=parseFloat(e.target.value)||0; setPrecoVenda(l.id,v); setEditingCampo(null); }}
                        style={{ width:"100%", background:"#fff", border:"1px solid #7c3aed", color:"#0f172a", padding:"5px 8px", borderRadius:6, fontSize:12, outline:"none" }} />
                    ) : (
                      <div onClick={function(){setEditingCampo(l.id+":venda");}} style={{ cursor:"pointer" }}>
                        {precoVendaDesejado > 0 ? (
                          <span style={{ fontSize:13, fontWeight:800, color:"#7c3aed" }}>
                            {fmt2(precoVendaDesejado)} 📢 anunciar {fmt2(precoParaAnunciar)}
                          </span>
                        ) : (
                          <span style={{ fontSize:12, color:"#94a3b8" }}>✎ definir preço de venda</span>
                        )}
                      </div>
                    )}
                  </div>
                </div>

                <div style={{ display:"flex", gap:16, marginTop:10, paddingTop:10, borderTop:"1px solid #f1f5f9" }}>
                  <div>
                    <div style={{ fontSize:10, color:"#94a3b8" }}>Taxa ML</div>
                    <div style={{ fontSize:12, fontWeight:700, color:"#dc2626" }}>{fmt2(taxaSobreDesc)}</div>
                  </div>
                  <div>
                    <div style={{ fontSize:10, color:"#94a3b8" }}>Lucro simulado</div>
                    <div style={{ fontSize:12, fontWeight:700, color:lucroFinal>=0?"#0891b2":"#dc2626" }}>{fmt2(lucroFinal)}</div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div style={{ padding:"12px 20px", borderTop:"1px solid #f1f5f9", display:"flex", justifyContent:"flex-end" }}>
          <button onClick={onClose} style={{ background:"#0f172a", border:"none", color:"#fff", fontWeight:700, padding:"10px 24px", borderRadius:10, cursor:"pointer", fontSize:13 }}>
            ✓ Concluir
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Menu de 3 pontinhos para NF ─────────────────────────────
function MenuAcoes({ nf, produtos, setProdutos, contasPagar, setContasPagar, categoriasPagar, costs, setCosts, enriched }) {
  const [aberto, setAberto] = useState(false);
  const [modalEstoque, setModalEstoque] = useState(false);
  const [modalContas, setModalContas] = useState(false);
  const [modalCusto, setModalCusto] = useState(false);
  const [modalPrecificar, setModalPrecificar] = useState(false);
  const btnRef = useRef(null);
  const [menuPos, setMenuPos] = useState(null);

  function toggleMenu() {
    if (!aberto && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      const menuWidth = 240;
      const menuHeightEstimado = 220; // 4 opções ~56px cada
      const espacoAbaixo = window.innerHeight - rect.bottom;
      const abrirParaCima = espacoAbaixo < menuHeightEstimado && rect.top > menuHeightEstimado;
      let left = rect.right - menuWidth;
      if (left < 8) left = 8;
      if (left + menuWidth > window.innerWidth - 8) left = window.innerWidth - menuWidth - 8;
      setMenuPos(
        abrirParaCima
          ? { position:"fixed", left, bottom: window.innerHeight - rect.top + 6, top:"auto", width:menuWidth }
          : { position:"fixed", left, top: rect.bottom + 6, bottom:"auto", width:menuWidth }
      );
    }
    setAberto(a => !a);
  }

  // Itens que têm produto vinculado
  const itensComProduto = (nf.itens || []).filter(it => it.produtoCadastradoId);
  // Itens vinculados que têm valor unitário informado na NF (podem atualizar custo)
  const itensComCusto = itensComProduto.filter(it => parseFloat(it.vUnCom || 0) > 0);
  // Itens vinculados a um produto que por sua vez está vinculado a pelo menos um anúncio (MLB) — podem ser precificados
  const itensComMlb = itensComProduto.filter(it => {
    const p = produtos.find(pp => pp.id === it.produtoCadastradoId);
    const mlbs = p ? (p.mlbsVinculados || (p.mlbVinculado ? [p.mlbVinculado] : [])) : [];
    return mlbs.length > 0;
  });
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

  function atualizarPrecosCusto() {
    if (itensComCusto.length === 0) { alert("Nenhum item desta NF está vinculado a um produto cadastrado com valor unitário informado."); return; }
    // Atualiza o preço de custo no cadastro do produto
    const novoProdutos = produtos.map(p => {
      const item = itensComCusto.find(it => it.produtoCadastradoId === p.id);
      if (!item) return p;
      return { ...p, precoCusto: String(parseFloat(item.vUnCom)) };
    });
    setProdutos(novoProdutos);
    try { localStorage.setItem("produtos_cadastro", JSON.stringify(novoProdutos)); } catch {}

    // Sincroniza custo com os anúncios (ML) e com a tela de Precificação — ambos usam o mesmo mapa `costs` por MLB
    if (setCosts) {
      const newCosts = {};
      novoProdutos.forEach(p => {
        const item = itensComCusto.find(it => it.produtoCadastradoId === p.id);
        if (!item) return;
        const mlbs = p.mlbsVinculados || (p.mlbVinculado ? [p.mlbVinculado] : []);
        mlbs.forEach(m => { newCosts[m] = parseFloat(item.vUnCom); });
      });
      if (Object.keys(newCosts).length > 0) setCosts(c => ({ ...c, ...newCosts }));
    }

    alert(`✅ Preço de custo atualizado para ${itensComCusto.length} produto(s) — refletido no cadastro, anúncios e precificação!`);
    setAberto(false); setModalCusto(false);
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
      <button ref={btnRef} onClick={toggleMenu}
        style={{ background:"#f8fafc", border:"1px solid #e2e8f0", color:"#64748b", width:28, height:28, borderRadius:6, cursor:"pointer", fontSize:14, display:"flex", alignItems:"center", justifyContent:"center", fontWeight:700 }}>
        ⋯
      </button>

      {aberto && menuPos && (
        <>
          <div onClick={() => setAberto(false)} style={{ position:"fixed", inset:0, zIndex:299 }} />
          <div style={{ ...menuPos, background:"#fff", border:"1px solid #e2e8f0", borderRadius:12, boxShadow:"0 8px 24px rgba(0,0,0,.12)", zIndex:300, minWidth:220, overflow:"hidden" }}>
            {/* Lançar Estoque */}
            <button onClick={() => { setAberto(false); setModalEstoque(true); }}
              style={{ width:"100%", background:"none", border:"none", padding:"12px 16px", textAlign:"left", cursor:"pointer", display:"flex", alignItems:"center", gap:7, fontSize:13, color:"#0f172a" }}
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
              style={{ width:"100%", background:"none", border:"none", padding:"12px 16px", textAlign:"left", cursor:"pointer", display:"flex", alignItems:"center", gap:7, fontSize:13, color:"#0f172a" }}
              onMouseEnter={e=>e.currentTarget.style.background="#eff6ff"}
              onMouseLeave={e=>e.currentTarget.style.background="none"}>
              <span style={{ fontSize:16 }}>💰</span>
              <div>
                <div style={{ fontWeight:600 }}>Lançar Contas a Pagar</div>
                <div style={{ fontSize:11, color:"#94a3b8" }}>{dupsDisponiveis.length} duplicata(s)</div>
              </div>
            </button>
            <div style={{ height:1, background:"#f1f5f9" }} />
            {/* Atualizar Preços de Custo */}
            <button onClick={() => { setAberto(false); setModalCusto(true); }}
              style={{ width:"100%", background:"none", border:"none", padding:"12px 16px", textAlign:"left", cursor:"pointer", display:"flex", alignItems:"center", gap:7, fontSize:13, color:"#0f172a" }}
              onMouseEnter={e=>e.currentTarget.style.background="#fffbeb"}
              onMouseLeave={e=>e.currentTarget.style.background="none"}>
              <span style={{ fontSize:16 }}>💲</span>
              <div>
                <div style={{ fontWeight:600 }}>Atualizar Preços de Custo</div>
                <div style={{ fontSize:11, color:"#94a3b8" }}>{itensComCusto.length} produto(s) com valor na NF</div>
              </div>
            </button>
            <div style={{ height:1, background:"#f1f5f9" }} />
            {/* Precificar itens da NF */}
            <button onClick={() => { setAberto(false); setModalPrecificar(true); }}
              style={{ width:"100%", background:"none", border:"none", padding:"12px 16px", textAlign:"left", cursor:"pointer", display:"flex", alignItems:"center", gap:7, fontSize:13, color:"#0f172a" }}
              onMouseEnter={e=>e.currentTarget.style.background="#f5f3ff"}
              onMouseLeave={e=>e.currentTarget.style.background="none"}>
              <span style={{ fontSize:16 }}>📊</span>
              <div>
                <div style={{ fontWeight:600 }}>Precificar</div>
                <div style={{ fontSize:11, color:"#94a3b8" }}>{itensComMlb.length} produto(s) com anúncio vinculado</div>
              </div>
            </button>
            <div style={{ height:1, background:"#f1f5f9" }} />
            {/* Lançar Ambos */}
            <button onClick={() => { lancarEstoque(); setTimeout(() => setModalContas(true), 100); }}
              style={{ width:"100%", background:"none", border:"none", padding:"12px 16px", textAlign:"left", cursor:"pointer", display:"flex", alignItems:"center", gap:7, fontSize:13, color:"#0f172a" }}
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
            <div style={{ fontSize:13, color:"#64748b", marginBottom:8 }}>Os seguintes produtos terão seu estoque atualizado:</div>
            {itensComProduto.length === 0 ? (
              <div style={{ background:"#fef2f2", border:"1px solid #fecaca", borderRadius:10, padding:"12px 16px", color:"#dc2626", fontSize:13, marginBottom:8 }}>
                ⚠ Nenhum item desta NF está vinculado a um produto cadastrado. Edite a NF e vincule os itens.
              </div>
            ) : (
              <div style={{ background:"#f0fdf4", border:"1px solid #bbf7d0", borderRadius:10, padding:"12px 16px", marginBottom:8 }}>
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

      {/* Modal de confirmação de atualização de preço de custo */}
      {modalCusto && (
        <div style={{ position:"fixed", inset:0, background:"rgba(15,23,42,.6)", backdropFilter:"blur(4px)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:600, padding:24 }}>
          <div style={{ background:"#fff", borderRadius:16, width:"100%", maxWidth:480, padding:"28px 32px", boxShadow:"0 20px 60px rgba(0,0,0,.15)" }}>
            <div style={{ fontWeight:800, fontSize:17, color:"#0f172a", marginBottom:6 }}>💲 Atualizar Preços de Custo</div>
            <div style={{ fontSize:13, color:"#64748b", marginBottom:8 }}>O preço de custo será atualizado no cadastro do produto, nos anúncios vinculados e na tela de Precificação:</div>
            {itensComCusto.length === 0 ? (
              <div style={{ background:"#fef2f2", border:"1px solid #fecaca", borderRadius:10, padding:"12px 16px", color:"#dc2626", fontSize:13, marginBottom:8 }}>
                ⚠ Nenhum item desta NF está vinculado a um produto cadastrado com valor unitário informado.
              </div>
            ) : (
              <div style={{ background:"#fffbeb", border:"1px solid #fde68a", borderRadius:10, padding:"12px 16px", marginBottom:8, maxHeight:280, overflowY:"auto" }}>
                {itensComCusto.map((it, i) => {
                  const prod = produtos.find(p => p.id === it.produtoCadastradoId);
                  const custoAtual = parseFloat(prod?.precoCusto || 0);
                  const custoNovo = parseFloat(it.vUnCom);
                  return (
                    <div key={i} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"5px 0", borderBottom:i<itensComCusto.length-1?"1px solid #fde68a":"none" }}>
                      <span style={{ fontSize:13, color:"#0f172a" }}>{prod?.titulo?.slice(0,36) || it.xProd?.slice(0,36)}</span>
                      <span style={{ fontSize:12, whiteSpace:"nowrap" }}>
                        <span style={{ color:"#94a3b8", textDecoration: custoAtual !== custoNovo ? "line-through" : "none" }}>R$ {custoAtual.toFixed(2).replace(".",",")}</span>
                        {custoAtual !== custoNovo && <span style={{ color:"#b45309", fontWeight:700 }}> → R$ {custoNovo.toFixed(2).replace(".",",")}</span>}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
            <div style={{ display:"flex", gap:8 }}>
              <button onClick={() => setModalCusto(false)}
                style={{ flex:1, background:"#f8fafc", border:"1px solid #e2e8f0", color:"#64748b", fontWeight:600, padding:"11px", borderRadius:10, cursor:"pointer" }}>Cancelar</button>
              <button onClick={atualizarPrecosCusto} disabled={itensComCusto.length === 0}
                style={{ flex:2, background:itensComCusto.length>0?"#b45309":"#f1f5f9", border:"none", color:itensComCusto.length>0?"#fff":"#94a3b8", fontWeight:700, padding:"11px", borderRadius:10, cursor:itensComCusto.length>0?"pointer":"not-allowed" }}>
                ✓ Confirmar Atualização
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal de precificação dos itens da NF */}
      {modalPrecificar && (
        <ModalPrecificarNF
          nf={nf}
          produtos={produtos}
          enriched={enriched || []}
          costs={costs}
          setCosts={setCosts}
          onClose={() => setModalPrecificar(false)}
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
        <div style={{ fontSize:13, color:"#64748b", marginBottom:8 }}>NF {nf.numero}/{nf.serie} — {nf.fornecedorNome}</div>

        {/* Duplicatas */}
        <div style={{ background:"#f8fafc", borderRadius:10, padding:"12px 16px", marginBottom:8 }}>
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
        <div style={{ display:"flex", flexDirection:"column", gap:12, marginBottom:10 }}>
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
                  style={{ flex:1, background:"#f8fafc", border:"1px solid #e2e8f0", color:"#0f172a", padding:"5px 8px", borderRadius:8, fontSize:13, outline:"none" }} placeholder="2" />
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
                  style={{ flex:1, background:"#f8fafc", border:"1px solid #e2e8f0", color:"#0f172a", padding:"5px 8px", borderRadius:8, fontSize:13, outline:"none" }} placeholder="0.033" />
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
                  style={{ width:"100%", background:"#f8fafc", border:"1px solid #fecaca", color:"#0f172a", padding:"5px 8px", borderRadius:8, fontSize:13, outline:"none" }} placeholder="5" />
              </div>
              <div>
                <div style={{ fontSize:11, color:"#94a3b8", marginBottom:4, fontWeight:600, textTransform:"uppercase" }}>Cartório</div>
                <input value={cfg.cartorio||""} onChange={e=>set("cartorio",e.target.value)}
                  style={{ width:"100%", background:"#f8fafc", border:"1px solid #fecaca", color:"#0f172a", padding:"5px 8px", borderRadius:8, fontSize:13, outline:"none" }} placeholder="1º Cartório..." />
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
function NotasFiscaisTab({ notasFiscais, setNotasFiscais, fornecedores, produtos, setProdutos, contasPagar, setContasPagar, categoriasPagar, costs, setCosts, enriched }) {
  const [showModal, setShowModal] = useState(false);
  const [editingNF, setEditingNF] = useState(null);
  const [search, setSearch] = useState("");
  const [filterStatus, setFilterStatus] = useState("all");
  const [nfParaPrecificar, setNfParaPrecificar] = useState(null);

  function saveNF(form) {
    const isNew = !notasFiscais.find(n => n.id === form.id);
    const savedForm = isNew ? { ...form, lancadaEm: new Date().toLocaleDateString("sv-SE") } : form;
    const updated = isNew ? [savedForm, ...notasFiscais]
                          : notasFiscais.map(n => n.id === form.id ? form : n);
    setNotasFiscais(updated);
    saveNFs(updated);

    console.log("[NF] saveNF chamado. isNew:", isNew, "atualizarEstoque:", form.atualizarEstoque, "itens:", form.itens?.length, "itens vinculados:", form.itens?.filter(function(it){return it.produtoCadastradoId;}).length);

    if (isNew) {
      // Auto-lançamento de contas e estoque desativado.
      // Use os 3 pontinhos da NF para lançar manualmente.

      // Se a NF já tem itens vinculados a produto + anúncio (MLB), oferece precificar na hora,
      // pra não precisar ir até a aba Precificação separadamente.
      var temPrecificavel = (savedForm.itens||[]).some(function(it){
        if (!it.produtoCadastradoId) return false;
        var p = produtos.find(function(pp){ return pp.id === it.produtoCadastradoId; });
        var mlbs = p ? (p.mlbsVinculados || (p.mlbVinculado ? [p.mlbVinculado] : [])) : [];
        return mlbs.length > 0;
      });
      if (temPrecificavel) setNfParaPrecificar(savedForm);
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
      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(160px,1fr))", gap:7, marginBottom:8 }}>
        {[
          { label:"Total de NFs", value:String(notasFiscais.length), color:"#0f172a", desc:"lançadas" },
          { label:"Valor Total", value:`R$ ${totalNFs.toFixed(2).replace(".",",")}`, color:"#15803d", desc:"em compras" },
          { label:"Total de Itens", value:String(totalItens), color:"#0891b2", desc:"produtos" },
          { label:"Contas Geradas", value:String(notasFiscais.reduce((s,n)=>s+(n.duplicatas?.length||0),0)), color:"#7c3aed", desc:"duplicatas" },
        ].map(k => (
          <div key={k.label} style={{ background:"#fff", border:"1px solid #e2e8f0", borderRadius:12, padding:"10px 14px" }}>
            <div style={{ fontSize:11, color:"#94a3b8", fontWeight:600, textTransform:"uppercase", marginBottom:4 }}>{k.label}</div>
            <div style={{ fontSize:17, fontWeight:800, color:k.color }}>{k.value}</div>
            <div style={{ fontSize:11, color:"#94a3b8", marginTop:2 }}>{k.desc}</div>
          </div>
        ))}
      </div>

      {/* Toolbar */}
      <div style={{ display:"flex", gap:7, alignItems:"center", marginBottom:8, flexWrap:"wrap" }}>
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
                const forn = (fornecedores||[]).find(f => f.cnpj?.replace(/\D/g,"") === parsed.emitente.cnpj?.replace(/\D/g,""));
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
          style={{ background:"#fff", border:"1px solid #e2e8f0", color:"#334155", padding:"5px 8px", borderRadius:8, fontSize:12 }}>
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
                  <td style={{ padding:"7px 10px", fontSize:11, color:"#64748b" }}>{n.dataEmissao ? new Date(n.dataEmissao+"T12:00:00").toLocaleDateString("pt-BR") : "—"}</td>
                  <td style={{ padding:"10px 14px" }}>
                    <div style={{ fontSize:13, color:"#0f172a", fontWeight:500 }}>{n.fornecedorNome?.slice(0,30)}</div>
                    <div style={{ fontSize:11, color:"#94a3b8" }}>{n.fornecedorCNPJ}</div>
                  </td>
                  <td style={{ padding:"7px 10px", fontSize:12, color:"#0f172a", textAlign:"center" }}>{n.itens?.length||0}</td>
                  <td style={{ padding:"7px 10px", fontSize:12, fontWeight:700, color:"#0f172a" }}>R$ {(n.totais?.vNF||0).toFixed(2).replace(".",",")}</td>
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
                        costs={costs}
                        setCosts={setCosts}
                        enriched={enriched}
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

      {/* Abre automaticamente após lançar uma NF nova com itens já vinculados a anúncios */}
      {nfParaPrecificar && (
        <ModalPrecificarNF
          nf={nfParaPrecificar}
          produtos={produtos}
          enriched={enriched || []}
          costs={costs}
          setCosts={setCosts}
          onClose={() => setNfParaPrecificar(null)}
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
    obs: "", ativo: true, prioridade: "media",
    multaTipo: "%", multaPct: "", jurosTipo: "%", jurosDia: "", temProtesto: false, diasProtesto: "", cartorio: "",
  });
  const set = (k, v) => setForm(function(f) { return Object.assign({}, f, { [k]: v }); });
  var tipoInfo = TIPOS_CADASTRO.find(function(t) { return t.key === form.tipo; }) || TIPOS_CADASTRO[0];

  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(15,23,42,.6)", backdropFilter:"blur(4px)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:600, padding:24 }}>
      <div style={{ background:"#fff", borderRadius:16, width:"100%", maxWidth:560, padding:"28px 32px", boxShadow:"0 20px 60px rgba(0,0,0,.15)", maxHeight:"92vh", overflowY:"auto" }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:10 }}>
          <div>
            <div style={{ fontWeight:800, fontSize:17, color:"#0f172a" }}>{fornecedor ? "Editar Cadastro" : "Novo Cadastro"}</div>
            <div style={{ fontSize:12, color:"#94a3b8", marginTop:2 }}>Clientes, fornecedores, prestadores e mais</div>
          </div>
          <button onClick={onClose} style={{ background:"#f1f5f9", border:"none", color:"#64748b", width:32, height:32, borderRadius:8, cursor:"pointer", fontSize:16 }}>✕</button>
        </div>

        {/* Tipo */}
        <div style={{ marginBottom:10 }}>
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

        {/* ── Prioridade de Pagamento ── */}
        <div style={{ background:"#f8fafc", border:"1px solid #e2e8f0", borderRadius:12, padding:"16px 18px", marginBottom:8 }}>
          <div style={{ fontSize:12, color:"#0f172a", fontWeight:700, marginBottom:12 }}>💰 Prioridade e Condições de Cobrança</div>

          {/* Prioridade */}
          <div style={{ marginBottom:8 }}>
            <div style={{ fontSize:11, color:"#94a3b8", marginBottom:8, fontWeight:600, textTransform:"uppercase" }}>Nível de Prioridade</div>
            <div style={{ display:"flex", gap:8 }}>
              {[
                { key:"baixa", label:"! Baixa",  cor:"#15803d", bg:"#f0fdf4", border:"#bbf7d0", desc:"Sem urgência" },
                { key:"media", label:"!! Média",  cor:"#d97706", bg:"#fffbeb", border:"#fde68a", desc:"Normal" },
                { key:"alta",  label:"!!! Alta",  cor:"#dc2626", bg:"#fef2f2", border:"#fecaca", desc:"Prioritário" },
              ].map(function(p) {
                var active = (form.prioridade || "media") === p.key;
                return (
                  <button key={p.key} onClick={function(){ set("prioridade", p.key); }}
                    style={{ flex:1, padding:"10px 8px", borderRadius:10,
                      border: active ? "2px solid " + p.cor : "2px solid " + p.border,
                      background: active ? p.bg : "#fff",
                      color: active ? p.cor : "#94a3b8",
                      fontWeight: active ? 800 : 500, fontSize:13, cursor:"pointer",
                      boxShadow: active ? "0 0 0 3px " + p.cor + "18" : "none",
                      textAlign:"center" }}>
                    <div>{p.label}</div>
                    <div style={{ fontSize:10, marginTop:2, fontWeight:400 }}>{p.desc}</div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Multa e juros */}
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr 1fr", gap:7, marginBottom:12 }}>
            <div>
              <div style={{ fontSize:10, color:"#94a3b8", marginBottom:4, fontWeight:600, textTransform:"uppercase" }}>Tipo Multa</div>
              <select value={form.multaTipo||"%"} onChange={function(e){ set("multaTipo",e.target.value); }}
                style={{ width:"100%", background:"#fff", border:"1px solid #e2e8f0", color:"#334155", padding:"7px 8px", borderRadius:7, fontSize:12 }}>
                <option value="%">%</option>
                <option value="R$">R$</option>
              </select>
            </div>
            <div>
              <div style={{ fontSize:10, color:"#94a3b8", marginBottom:4, fontWeight:600, textTransform:"uppercase" }}>Multa ({form.multaTipo||"%"})</div>
              <input type="number" step="0.01" value={form.multaPct||""} onChange={function(e){ set("multaPct",e.target.value); }} placeholder={form.multaTipo==="%"?"Ex: 2":"Ex: 10"}
                style={{ width:"100%", background:"#fff", border:"1px solid #e2e8f0", color:"#0f172a", padding:"7px 8px", borderRadius:7, fontSize:12, outline:"none" }} />
            </div>
            <div>
              <div style={{ fontSize:10, color:"#94a3b8", marginBottom:4, fontWeight:600, textTransform:"uppercase" }}>Tipo Juros</div>
              <select value={form.jurosTipo||"%"} onChange={function(e){ set("jurosTipo",e.target.value); }}
                style={{ width:"100%", background:"#fff", border:"1px solid #e2e8f0", color:"#334155", padding:"7px 8px", borderRadius:7, fontSize:12 }}>
                <option value="%">% ao dia</option>
                <option value="R$">R$/dia</option>
              </select>
            </div>
            <div>
              <div style={{ fontSize:10, color:"#94a3b8", marginBottom:4, fontWeight:600, textTransform:"uppercase" }}>Juros/dia</div>
              <input type="number" step="0.001" value={form.jurosDia||""} onChange={function(e){ set("jurosDia",e.target.value); }} placeholder="Ex: 0.033"
                style={{ width:"100%", background:"#fff", border:"1px solid #e2e8f0", color:"#0f172a", padding:"7px 8px", borderRadius:7, fontSize:12, outline:"none" }} />
            </div>
          </div>

          {/* Protesto */}
          <div style={{ display:"flex", alignItems:"center", gap:12, flexWrap:"wrap" }}>
            <label style={{ display:"flex", alignItems:"center", gap:7, cursor:"pointer" }}>
              <input type="checkbox" checked={!!form.temProtesto} onChange={function(e){ set("temProtesto",e.target.checked); }} />
              <span style={{ fontSize:12, fontWeight:600, color:"#7c3aed" }}>⚖️ Protesta boletos</span>
            </label>
            {form.temProtesto && (
              <>
                <div>
                  <input type="number" min="1" value={form.diasProtesto||""} onChange={function(e){ set("diasProtesto",e.target.value); }} placeholder="Dias p/ protesto"
                    style={{ background:"#fff", border:"1px solid #e2e8f0", color:"#0f172a", padding:"6px 10px", borderRadius:7, fontSize:12, outline:"none", width:140 }} />
                </div>
                <div>
                  <input value={form.cartorio||""} onChange={function(e){ set("cartorio",e.target.value); }} placeholder="Cartório (opcional)"
                    style={{ background:"#fff", border:"1px solid #e2e8f0", color:"#0f172a", padding:"6px 10px", borderRadius:7, fontSize:12, outline:"none", width:160 }} />
                </div>
              </>
            )}
          </div>
        </div>

        {/* Observação e status */}
        <div style={{ display:"grid", gridTemplateColumns:"1fr auto", gap:7, marginBottom:10, alignItems:"flex-start" }}>
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
function ModalMovEstoque({ produto, movEstoque, onRegistrar, onClose }) {
  const [tipo, setTipo] = useState("entrada");
  const [qtd, setQtd] = useState("");
  const [motivo, setMotivo] = useState("");
  const [preco, setPreco] = useState("");
  const [precoVenda, setPrecoVenda] = useState("");
  const [abaView, setAbaView] = useState("historico");

  var mlbsAll = [produto.mlbVinculado].concat(produto.mlbsVinculados||[]).filter(Boolean);
  var mlbsProd = mlbsAll.filter(function(m,i){ return mlbsAll.indexOf(m)===i; }); // deduplicate
  var skuProd = (produto.sku||"").trim().toLowerCase();
  var movsProd = (movEstoque||[]).filter(function(m){
    if (m.produtoId && m.produtoId === produto.id) return true;
    if (skuProd && m.sku && m.sku.trim().toLowerCase() === skuProd) return true;
    if (m.mlbId && mlbsProd.includes(m.mlbId)) return true;
    return false;
  }).sort(function(a,b){ return (b.id||0) - (a.id||0); });

  var estoqueAtual = parseInt(produto.estoqueAtual||0);
  var totalEntradas = movsProd.filter(function(m){return m.tipo==="entrada";}).reduce(function(s,m){return s+parseInt(m.qtd||0);},0);
  var totalSaidas   = movsProd.filter(function(m){return m.tipo==="saida";}).reduce(function(s,m){return s+parseInt(m.qtd||0);},0);
  // Saldo real = entradas - saídas (não depende do estoqueAtual do produto)
  var saldoCalculado = totalEntradas - totalSaidas;

  function handleRegistrar() {
    if (!qtd || parseInt(qtd) <= 0) return;
    onRegistrar(produto.id, produto.sku, tipo, qtd, motivo, preco, precoVenda);
    setQtd(""); setMotivo(""); setPreco(""); setPrecoVenda(""); setAbaView("historico");
  }

  var fmt2 = function(n){ return n!=null&&n!==""?"R$ "+Number(n).toFixed(2).replace(".",","):"—"; };

  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(15,23,42,.7)", backdropFilter:"blur(4px)", display:"flex", alignItems:"stretch", justifyContent:"center", zIndex:600, padding:"12px" }}>
      <div style={{ background:"#fff", borderRadius:14, width:"100%", maxWidth:"100%", height:"100%", display:"flex", flexDirection:"column", boxShadow:"0 20px 60px rgba(0,0,0,.3)" }}>

        {/* Header */}
        <div style={{ padding:"16px 24px", borderBottom:"1px solid #f1f5f9", display:"flex", justifyContent:"space-between", alignItems:"flex-start" }}>
          <div>
            <div style={{ fontWeight:800, fontSize:16, color:"#0f172a" }}>Lançamentos de Estoque</div>
            <div style={{ fontSize:13, color:"#0f172a", fontWeight:600, marginTop:2 }}>
              {produto.sku ? produto.sku + " - " : ""}{produto.titulo}
            </div>
          </div>
          <div style={{ display:"flex", gap:8, alignItems:"center" }}>
            <button onClick={function(){setAbaView("registrar");}}
              style={{ background:"#15803d", border:"none", color:"#fff", fontWeight:700, padding:"8px 18px", borderRadius:8, cursor:"pointer", fontSize:13 }}>
              + Incluir lançamento
            </button>
            <button onClick={onClose} style={{ background:"#f1f5f9", border:"none", color:"#64748b", width:34, height:34, borderRadius:8, cursor:"pointer", fontSize:16 }}>✕</button>
          </div>
        </div>

        {/* Resumo lateral estilo Bling */}
        <div style={{ display:"flex", gap:0 }}>
          {/* Tabela principal */}
          <div style={{ flex:1, display:"flex", flexDirection:"column", minWidth:0 }}>

            {/* Sub-abas */}
            <div style={{ display:"flex", gap:0, borderBottom:"2px solid #f1f5f9", padding:"0 12px" }}>
              {[{k:"historico",l:"Lançamentos"},{k:"registrar",l:"+ Registrar"}].map(function(t){
                var active = abaView===t.k;
                return <button key={t.k} onClick={function(){setAbaView(t.k);}}
                  style={{ padding:"10px 16px", border:"none", borderBottom:active?"2px solid #15803d":"2px solid transparent", marginBottom:-2,
                    background:"transparent", color:active?"#15803d":"#94a3b8", fontWeight:active?700:400, fontSize:13, cursor:"pointer", fontFamily:"inherit" }}>
                  {t.l}
                </button>;
              })}
            </div>

            <div style={{ flex:1, overflowY:"auto" }}>
              {abaView === "historico" && (
                movsProd.length === 0 ? (
                  <div style={{ textAlign:"center", color:"#94a3b8", padding:"40px 24px" }}>
                    <div style={{ fontSize:32, marginBottom:8 }}>📦</div>
                    <div style={{ fontWeight:600, color:"#0f172a", marginBottom:10 }}>Nenhuma movimentação registrada</div>
                    {mlbsProd.length > 0 ? (
                      <div style={{ fontSize:12, color:"#92400e", background:"#fffbeb", border:"1px solid #fde68a", borderRadius:8, padding:"10px 14px", marginBottom:8, textAlign:"left", maxWidth:440, margin:"0 auto 14px" }}>
                        ⚠️ MLB vinculado: <b>{mlbsProd[0]}</b>. Vá em <b>Produtos → 📋 Movimentações → 🔄 Reprocessar Vendas</b> para importar todas as saídas automáticas.
                      </div>
                    ) : (
                      <div style={{ fontSize:12, color:"#dc2626", background:"#fef2f2", border:"1px solid #fecaca", borderRadius:8, padding:"10px 14px", marginBottom:8, maxWidth:440, margin:"0 auto 14px" }}>
                        ⚠️ Produto sem MLB vinculado. Edite o produto e vincule um MLB para baixa automática de vendas.
                      </div>
                    )}
                    <button onClick={function(){setAbaView("registrar");}} style={{ background:"#15803d", border:"none", color:"#fff", padding:"9px 22px", borderRadius:8, cursor:"pointer", fontSize:13, fontWeight:700 }}>+ Incluir lançamento</button>
                  </div>
                ) : (
                  <div style={{ overflowX:"auto" }}>
                    <table style={{ borderCollapse:"collapse", width:"100%", minWidth:700 }}>
                      <thead>
                        <tr style={{ background:"#f8fafc", borderBottom:"2px solid #e2e8f0" }}>
                          {["Data","Entrada","Saída","Preço de Venda","Preço de Custo","Observação","Origem",""].map(function(h){
                            return <th key={h} style={{ fontSize:11, color:"#64748b", fontWeight:600, padding:"10px 12px", textAlign:"left", whiteSpace:"nowrap", borderBottom:"1px solid #e2e8f0" }}>{h}</th>;
                          })}
                        </tr>
                      </thead>
                      <tbody>
                        {movsProd.map(function(m, i){
                          var isE = m.tipo === "entrada";
                          return (
                            <tr key={m.id} style={{ borderBottom:"1px solid #f1f5f9", background:i%2===0?"#fff":"#fafafa" }}>
                              {/* Data */}
                              <td style={{ padding:"7px 10px", fontSize:11, color:"#334155", whiteSpace:"nowrap" }}>
                                <div style={{ fontWeight:500 }}>{fmtDate(m.data)}</div>
                                {m.hora && m.hora!=="—" && <div style={{ fontSize:10, color:"#94a3b8" }}>{m.hora}</div>}
                              </td>
                              {/* Entrada */}
                              <td style={{ padding:"7px 10px", fontSize:12, fontWeight:700, color:"#15803d", textAlign:"right" }}>
                                {isE ? <span style={{color:"#15803d"}}>+{parseInt(m.qtd||0)}</span> : <span style={{ color:"#94a3b8" }}>—</span>}
                              </td>
                              {/* Saída */}
                              <td style={{ padding:"7px 10px", fontSize:12, fontWeight:700, color:"#dc2626", textAlign:"right" }}>
                                {!isE ? <span style={{color:"#dc2626"}}>-{parseInt(m.qtd||0)}</span> : <span style={{ color:"#94a3b8" }}>—</span>}
                              </td>
                              {/* Preço de Venda */}
                              <td style={{ padding:"7px 10px", fontSize:11, color:"#334155", textAlign:"right" }}>
                                {m.precoVenda ? fmt2(m.precoVenda) : (isE ? "—" : (produto.precoVenda ? fmt2(produto.precoVenda) : "—"))}
                              </td>
                              {/* Preço de Custo */}
                              <td style={{ padding:"7px 10px", fontSize:11, color:"#334155", textAlign:"right" }}>
                                {m.preco ? fmt2(m.preco) : (produto.precoCusto ? fmt2(produto.precoCusto) : "—")}
                              </td>
                              {/* Observação */}
                              <td style={{ padding:"7px 10px", fontSize:11, color:"#64748b", maxWidth:200, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                                {m.saldoInicial
                                  ? <span style={{color:"#15803d", fontWeight:600}}>{m.motivo}</span>
                                  : m.motivo||"—"}
                              </td>
                              {/* Origem — Nº do pedido em destaque */}
                              <td style={{ padding:"6px 9px", fontSize:11 }}>
                                {m.pedidoId ? (
                                  <div>
                                    <span style={{ background:"#eff6ff", color:"#1d4ed8", padding:"2px 7px", borderRadius:5, fontWeight:700, fontSize:11, display:"inline-block" }}>
                                      #{m.pedidoId}
                                    </span>
                                    {m.mlbId && <div style={{fontSize:10,color:"#94a3b8",marginTop:1}}>{m.mlbId}</div>}
                                  </div>
                                ) : m.mlbId ? (
                                  <span style={{ background:"#f0fdf4", color:"#15803d", padding:"2px 7px", borderRadius:5, fontWeight:600, fontSize:11 }}>
                                    {m.mlbId}
                                  </span>
                                ) : "—"}
                              </td>
                              {/* Excluir lançamento */}
                              <td style={{ padding:"6px 9px" }}>
                                {!m.automatico || m.saldoInicial ? (
                                  <button onClick={function(){
                                    if (!window.confirm("Excluir este lançamento?")) return;
                                    var todasMov = JSON.parse(localStorage.getItem("mov_estoque")||"[]").filter(function(mv){ return mv.id !== m.id; });
                                    localStorage.setItem("mov_estoque", JSON.stringify(todasMov));
                                    setMovEstoque(todasMov);
                                  }}
                                    style={{ background:"#fef2f2", border:"none", color:"#dc2626", width:24, height:24, borderRadius:6, cursor:"pointer", fontSize:12, display:"flex", alignItems:"center", justifyContent:"center" }}
                                    title="Excluir lançamento">
                                    ✕
                                  </button>
                                ) : (
                                  <span style={{ fontSize:10, color:"#e2e8f0" }}>—</span>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )
              )}

              {/* Registrar movimento */}
              {abaView === "registrar" && (
                <div style={{ padding:"12px 16px", display:"flex", flexDirection:"column", gap:8 }}>
                  <div style={{ fontWeight:700, fontSize:15, color:"#0f172a" }}>Registrar Lançamento Manual</div>
                  <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:12 }}>
                    <div>
                      <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Tipo *</div>
                      <div style={{ display:"flex", gap:6 }}>
                        {["entrada","saida"].map(function(t){
                          var a = tipo===t;
                          return <button key={t} onClick={function(){setTipo(t);}}
                            style={{ flex:1, padding:"9px", borderRadius:8, border:"1.5px solid "+(a?(t==="entrada"?"#15803d":"#dc2626"):"#e2e8f0"),
                              background:a?(t==="entrada"?"#f0fdf4":"#fef2f2"):"#fff",
                              color:a?(t==="entrada"?"#15803d":"#dc2626"):"#64748b",
                              fontWeight:a?700:500, fontSize:12, cursor:"pointer" }}>
                            {t==="entrada"?"↑ Entrada":"↓ Saída"}
                          </button>;
                        })}
                      </div>
                    </div>
                    <div>
                      <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Quantidade *</div>
                      <input type="number" min="1" value={qtd} onChange={function(e){setQtd(e.target.value);}} placeholder="0"
                        style={{ width:"100%", background:"#f8fafc", border:"1px solid #e2e8f0", color:"#0f172a", padding:"9px 12px", borderRadius:8, fontSize:14, fontWeight:700, outline:"none" }} />
                    </div>
                    <div>
                      <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Preço de Custo</div>
                      <input type="number" step="0.01" value={preco} onChange={function(e){setPreco(e.target.value);}} placeholder="R$ 0,00"
                        style={{ width:"100%", background:"#f8fafc", border:"1px solid #e2e8f0", color:"#0f172a", padding:"9px 12px", borderRadius:8, fontSize:13, outline:"none" }} />
                    </div>
                    <div>
                      <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Preço de Venda</div>
                      <input type="number" step="0.01" value={precoVenda} onChange={function(e){setPrecoVenda(e.target.value);}} placeholder="R$ 0,00"
                        style={{ width:"100%", background:"#f8fafc", border:"1px solid #e2e8f0", color:"#0f172a", padding:"9px 12px", borderRadius:8, fontSize:13, outline:"none" }} />
                    </div>
                    <div style={{ gridColumn:"span 2" }}>
                      <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Observação</div>
                      <input value={motivo} onChange={function(e){setMotivo(e.target.value);}} placeholder="Motivo da movimentação..."
                        style={{ width:"100%", background:"#f8fafc", border:"1px solid #e2e8f0", color:"#0f172a", padding:"9px 12px", borderRadius:8, fontSize:13, outline:"none" }} />
                    </div>
                  </div>
                  <div style={{ display:"flex", gap:8 }}>
                    <button onClick={function(){setAbaView("historico");}} style={{ flex:1, background:"#f8fafc", border:"1px solid #e2e8f0", color:"#64748b", fontWeight:600, padding:"11px", borderRadius:10, cursor:"pointer" }}>Cancelar</button>
                    <button onClick={handleRegistrar} disabled={!qtd||parseInt(qtd)<=0}
                      style={{ flex:2, background:(!qtd||parseInt(qtd)<=0)?"#f1f5f9":"#15803d", border:"none", color:(!qtd||parseInt(qtd)<=0)?"#94a3b8":"#fff", fontWeight:700, padding:"11px", borderRadius:10, cursor:(!qtd||parseInt(qtd)<=0)?"not-allowed":"pointer", fontSize:14 }}>
                      ✓ Confirmar Lançamento
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Painel lateral direito — resumo estilo Bling */}
          <div style={{ width:200, flexShrink:0, borderLeft:"1px solid #f1f5f9", padding:"20px 16px", display:"flex", flexDirection:"column", gap:16 }}>
            <div>
              <div style={{ fontSize:11, color:"#64748b", fontWeight:600, marginBottom:4 }}>Entradas</div>
              <div style={{ fontSize:15, fontWeight:800, color:totalEntradas>0?"#15803d":"#94a3b8" }}>{totalEntradas}</div>
            </div>
            <div>
              <div style={{ fontSize:11, color:"#64748b", fontWeight:600, marginBottom:4 }}>Saídas</div>
              <div style={{ fontSize:15, fontWeight:800, color:totalSaidas>0?"#dc2626":"#94a3b8" }}>{totalSaidas}</div>
            </div>
            <div style={{ borderTop:"1px solid #f1f5f9", paddingTop:12 }}>
              <div style={{ fontSize:11, color:"#64748b", fontWeight:600, marginBottom:4 }}>Saldo calculado</div>
              <div style={{ fontSize:18, fontWeight:800, color:saldoCalculado>0?"#15803d":"#dc2626" }}>{saldoCalculado}</div>
              {saldoCalculado !== estoqueAtual && (
                <div style={{ fontSize:10, color:"#94a3b8", marginTop:2 }}>Cadastrado: {estoqueAtual}</div>
              )}
            </div>
            {mlbsProd.length > 0 && (
              <div style={{ borderTop:"1px solid #f1f5f9", paddingTop:12 }}>
                <div style={{ fontSize:11, color:"#64748b", fontWeight:600, marginBottom:6 }}>MLBs Vinculados</div>
                {mlbsProd.slice(0,3).map(function(m){
                  return <div key={m} style={{ fontSize:11, fontFamily:"monospace", color:"#0891b2", marginBottom:3 }}>{m}</div>;
                })}
              </div>
            )}
          </div>
        </div>

      </div>
    </div>
  );
}

function ModalProduto({ produto, fornecedores, listings, produtos, onSave, onClose }) {
  const emptyForm = {
    id: Date.now(), titulo: "", sku: "", ean: "", codigoFornecedor: "",
    fornecedorId: "", precoCusto: "", precoVenda: "",
    estoqueAtual: "", estoqueMinimo: "", estoqueMaximo: "", localizacao: "",
    ncm: "", cest: "", origem: "0 - Nacional", cfop: "5102",
    aliqICMS: "", aliqIPI: "", aliqPIS: "0.65", aliqCOFINS: "3.00",
    categoria: "Outros", descricao: "", peso: "", comprimento: "", largura: "", altura: "",
    status: "Ativo", imagens: [], mlbVinculado: "",
    tipoProduto: "simples",      // simples | composto
    composicao: [],               // [{ skuComponente, qtd }]
  };
  const [form, setForm] = useState(produto ? { tipoProduto:"simples", composicao:[], ...produto } : emptyForm);
  const [tab, setTab] = useState("geral");
  const [uploading, setUploading] = useState(false);
  const [novoCompSku, setNovoCompSku] = useState("");
  const [novoCompQtd, setNovoCompQtd] = useState("1");
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  function addComponente() {
    if (!novoCompSku.trim()) return;
    var jaExiste = (form.composicao||[]).some(function(c){ return c.skuComponente === novoCompSku.trim(); });
    if (jaExiste) { alert("SKU já adicionado."); return; }
    set("composicao", [...(form.composicao||[]), { skuComponente: novoCompSku.trim(), qtd: parseInt(novoCompQtd)||1 }]);
    setNovoCompSku(""); setNovoCompQtd("1");
  }
  function removeComponente(sku) {
    set("composicao", (form.composicao||[]).filter(function(c){ return c.skuComponente !== sku; }));
  }

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
    { key:"composicao", label:"🔗 Composição" },
    { key:"estoque", label:"📦 Estoque" },
    { key:"fiscal", label:"🧾 Fiscal" },
    { key:"fotos", label:"🖼️ Fotos" },
    { key:"ml", label:"🟡 ML" },
  ];

  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(15,23,42,.6)", backdropFilter:"blur(4px)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:600, padding:16 }}>
      <div style={{ background:"#fff", borderRadius:16, width:"100%", maxWidth:720, maxHeight:"92vh", display:"flex", flexDirection:"column", boxShadow:"0 20px 60px rgba(0,0,0,.15)" }}>
        {/* Header */}
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"12px 16px", borderBottom:"1px solid #f1f5f9" }}>
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
        <div style={{ flex:1, overflowY:"auto", padding:"12px 16px" }}>

          {/* ── GERAL ── */}
          {tab === "geral" && (
            <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
              {/* Tipo de produto */}
              <div style={{ background:"#f8fafc", border:"1px solid #e2e8f0", borderRadius:10, padding:"12px 14px" }}>
                <div style={{ fontSize:11, color:"#94a3b8", marginBottom:8, fontWeight:600, textTransform:"uppercase" }}>Tipo de Produto</div>
                <div style={{ display:"flex", gap:8 }}>
                  {[{k:"simples",l:"📦 Produto Simples",desc:"Produto unitário com estoque próprio"},{k:"composto",l:"🔗 Produto Composto",desc:"Kit formado por outros produtos (componentes)"}].map(function(t){
                    var a = (form.tipoProduto||"simples") === t.k;
                    return (
                      <button key={t.k} onClick={function(){set("tipoProduto",t.k); if(t.k==="composto") setTimeout(function(){},0);}}
                        style={{ flex:1, padding:"10px 14px", borderRadius:9, border:"1.5px solid "+(a?"#0f172a":"#e2e8f0"),
                          background:a?"#0f172a":"#fff", color:a?"#fff":"#64748b", fontWeight:a?700:400, fontSize:12, cursor:"pointer", textAlign:"left" }}>
                        <div style={{ fontWeight:a?700:600 }}>{t.l}</div>
                        <div style={{ fontSize:10, opacity:0.7, marginTop:2 }}>{t.desc}</div>
                      </button>
                    );
                  })}
                </div>
              </div>
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

          {/* ── COMPOSIÇÃO ── */}
          {tab === "composicao" && (
            <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
              {(form.tipoProduto||"simples") === "simples" ? (
                <div style={{ textAlign:"center", padding:"32px 20px", color:"#94a3b8" }}>
                  <div style={{ fontSize:32, marginBottom:8 }}>📦</div>
                  <div style={{ fontWeight:600, color:"#0f172a", marginBottom:6 }}>Este é um Produto Simples</div>
                  <div style={{ fontSize:13 }}>Mude para <b>Produto Composto</b> na aba Geral para definir a composição.</div>
                </div>
              ) : (
                <>
                  <div style={{ background:"#eff6ff", border:"1px solid #bfdbfe", borderRadius:10, padding:"12px 14px", fontSize:12, color:"#1d4ed8" }}>
                    ℹ️ <b>Produto Composto (Kit)</b> — Informe os SKUs e quantidades dos produtos que compõem este kit.<br/>
                    Exemplo: SKU <b>14861487</b> é composto por 1× SKU <b>1486</b> + 1× SKU <b>1487</b>
                  </div>

                  {/* Adicionar componente */}
                  <div style={{ background:"#f8fafc", border:"1px solid #e2e8f0", borderRadius:10, padding:"14px" }}>
                    <div style={{ fontSize:12, fontWeight:700, color:"#0f172a", marginBottom:10 }}>+ Adicionar Componente</div>
                    <div style={{ display:"flex", gap:8, alignItems:"flex-end" }}>
                      <div style={{ flex:2 }}>
                        <div style={{ fontSize:10, color:"#94a3b8", marginBottom:4, fontWeight:600, textTransform:"uppercase" }}>SKU do Componente</div>
                        <input value={novoCompSku} onChange={function(e){setNovoCompSku(e.target.value);}} placeholder="Ex: 1486"
                          onKeyDown={function(e){if(e.key==="Enter") addComponente();}}
                          style={{ width:"100%", background:"#fff", border:"1px solid #e2e8f0", color:"#0f172a", padding:"5px 8px", borderRadius:8, fontSize:13, outline:"none" }} />
                      </div>
                      <div style={{ width:80 }}>
                        <div style={{ fontSize:10, color:"#94a3b8", marginBottom:4, fontWeight:600, textTransform:"uppercase" }}>Qtd</div>
                        <input type="number" min="1" value={novoCompQtd} onChange={function(e){setNovoCompQtd(e.target.value);}}
                          style={{ width:"100%", background:"#fff", border:"1px solid #e2e8f0", color:"#0f172a", padding:"5px 8px", borderRadius:8, fontSize:13, outline:"none" }} />
                      </div>
                      <button onClick={addComponente}
                        style={{ background:"#0f172a", border:"none", color:"#fff", fontWeight:700, padding:"9px 18px", borderRadius:8, cursor:"pointer", fontSize:13, whiteSpace:"nowrap" }}>
                        + Adicionar
                      </button>
                    </div>
                  </div>

                  {/* Lista de componentes */}
                  {(form.composicao||[]).length === 0 ? (
                    <div style={{ textAlign:"center", padding:"20px", color:"#94a3b8", fontSize:13 }}>
                      Nenhum componente adicionado ainda.
                    </div>
                  ) : (
                    <div style={{ border:"1px solid #e2e8f0", borderRadius:10, overflow:"hidden" }}>
                      <table style={{ width:"100%", borderCollapse:"collapse" }}>
                        <thead>
                          <tr style={{ background:"#f8fafc" }}>
                            {["SKU Componente","Produto","Qtd",""].map(function(h){
                              return <th key={h} style={{ fontSize:11, color:"#64748b", fontWeight:600, padding:"10px 14px", textAlign:"left", borderBottom:"1px solid #e2e8f0" }}>{h}</th>;
                            })}
                          </tr>
                        </thead>
                        <tbody>
                          {(form.composicao||[]).map(function(comp, i){
                            // Buscar produto pelo SKU nos produtos cadastrados
                            return (
                              <tr key={comp.skuComponente} style={{ borderBottom:"1px solid #f1f5f9", background:i%2===0?"#fff":"#fafafa" }}>
                                <td style={{ padding:"7px 10px", fontSize:11, fontFamily:"monospace", fontWeight:700, color:"#0891b2" }}>{comp.skuComponente}</td>
                                <td style={{ padding:"7px 10px", fontSize:11, color:"#64748b" }}>
                                  {(function(){
                                    var p = (produtos||[]).find(function(x){ return x.sku && x.sku.trim() === comp.skuComponente.trim(); });
                                    return p ? <span style={{color:"#0f172a"}}>{p.titulo?.slice(0,45)||"—"}</span> : <span style={{color:"#dc2626",fontSize:11}}>⚠ SKU não encontrado</span>;
                                  })()}
                                </td>
                                <td style={{ padding:"7px 10px", fontSize:12, fontWeight:700, color:"#0f172a" }}>{comp.qtd}×</td>
                                <td style={{ padding:"10px 14px" }}>
                                  <button onClick={function(){removeComponente(comp.skuComponente);}}
                                    style={{ background:"#fef2f2", border:"none", color:"#dc2626", padding:"4px 10px", borderRadius:6, cursor:"pointer", fontSize:12 }}>✕</button>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                      <div style={{ padding:"10px 14px", background:"#f8fafc", borderTop:"1px solid #e2e8f0", fontSize:12, color:"#64748b" }}>
                        Total: <b>{(form.composicao||[]).reduce(function(s,c){return s+c.qtd;},0)}</b> unidade(s) de componentes
                      </div>
                    </div>
                  )}
                </>
              )}
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
              <div style={{ fontSize:13, color:"#64748b", marginBottom:8 }}>
                {form.imagens.length}/10 fotos adicionadas
              </div>
              {form.imagens.length < 10 && (
                <label style={{ display:"block", border:"2px dashed #e2e8f0", borderRadius:12, padding:"24px", textAlign:"center", cursor:"pointer", marginBottom:8, background:"#f8fafc" }}>
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
            <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
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


// ════════════════════════════════════════════════════════════
//  DEPÓSITOS DE ESTOQUE
// ════════════════════════════════════════════════════════════

function saveDepositos(v) { try { localStorage.setItem("depositos_estoque", JSON.stringify(v)); } catch {} }
function saveEstoqueDepositos(v) { try { localStorage.setItem("estoque_depositos", JSON.stringify(v)); } catch {} }

function ModalDeposito({ deposito, onSave, onClose }) {
  var CORES = ["#0891b2","#15803d","#7c3aed","#d97706","#dc2626","#0f172a","#64748b","#db2777"];
  var ICONES = ["🏪","🏭","🏬","📦","🗄️","🚛","🏠","⭐"];
  var empty = { id: Date.now().toString(), nome: "", descricao: "", cor: "#0891b2", icone: "🏪", ativo: true };
  const [form, setForm] = useState(deposito || empty);
  var set = function(k,v){ setForm(function(f){ return Object.assign({},f,{[k]:v}); }); };
  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(15,23,42,.6)", backdropFilter:"blur(4px)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:600, padding:24 }}>
      <div style={{ background:"#fff", borderRadius:16, width:"100%", maxWidth:460, padding:"28px 32px", boxShadow:"0 20px 60px rgba(0,0,0,.15)" }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:10 }}>
          <div style={{ fontWeight:800, fontSize:17, color:"#0f172a" }}>{deposito ? "Editar Depósito" : "Novo Depósito"}</div>
          <button onClick={onClose} style={{ background:"#f1f5f9", border:"none", color:"#64748b", width:32, height:32, borderRadius:8, cursor:"pointer", fontSize:16 }}>✕</button>
        </div>
        <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
          <div style={{ display:"flex", alignItems:"center", gap:12, background:"#f8fafc", borderRadius:12, padding:"12px 16px" }}>
            <div style={{ width:48, height:48, borderRadius:12, background:form.cor, display:"flex", alignItems:"center", justifyContent:"center", fontSize:24 }}>{form.icone}</div>
            <div>
              <div style={{ fontWeight:700, fontSize:15, color:"#0f172a" }}>{form.nome || "Nome do depósito"}</div>
              <div style={{ fontSize:12, color:"#94a3b8" }}>{form.descricao || "Sem descrição"}</div>
            </div>
          </div>
          <div>
            <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Nome *</div>
            <input value={form.nome} onChange={function(e){set("nome",e.target.value);}} placeholder="Ex: Galpão Principal, Loja SP..."
              style={{ width:"100%", background:"#f8fafc", border:"1px solid #e2e8f0", color:"#0f172a", padding:"9px 12px", borderRadius:8, fontSize:13, outline:"none" }} />
          </div>
          <div>
            <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Descrição</div>
            <input value={form.descricao} onChange={function(e){set("descricao",e.target.value);}} placeholder="Endereço, observação..."
              style={{ width:"100%", background:"#f8fafc", border:"1px solid #e2e8f0", color:"#0f172a", padding:"9px 12px", borderRadius:8, fontSize:13, outline:"none" }} />
          </div>
          <div>
            <div style={{ fontSize:11, color:"#94a3b8", marginBottom:8, fontWeight:600, textTransform:"uppercase" }}>Ícone</div>
            <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
              {ICONES.map(function(ic){ return (
                <button key={ic} onClick={function(){set("icone",ic);}}
                  style={{ width:38, height:38, borderRadius:8, border:form.icone===ic?"2px solid #0f172a":"1px solid #e2e8f0", background:form.icone===ic?"#f1f5f9":"#fff", cursor:"pointer", fontSize:20 }}>{ic}</button>
              ); })}
            </div>
          </div>
          <div>
            <div style={{ fontSize:11, color:"#94a3b8", marginBottom:8, fontWeight:600, textTransform:"uppercase" }}>Cor</div>
            <div style={{ display:"flex", gap:8 }}>
              {CORES.map(function(c){ return (
                <button key={c} onClick={function(){set("cor",c);}}
                  style={{ width:28, height:28, borderRadius:8, background:c, border:form.cor===c?"3px solid #0f172a":"2px solid transparent", cursor:"pointer" }} />
              ); })}
            </div>
          </div>
          <label style={{ display:"flex", alignItems:"center", gap:8, cursor:"pointer" }}>
            <input type="checkbox" checked={form.ativo !== false} onChange={function(e){set("ativo",e.target.checked);}} />
            <span style={{ fontSize:13, color:"#334155", fontWeight:500 }}>Depósito ativo</span>
          </label>
        </div>
        <div style={{ display:"flex", gap:8, marginTop:20 }}>
          <button onClick={onClose} style={{ flex:1, background:"#f8fafc", border:"1px solid #e2e8f0", color:"#64748b", fontWeight:600, padding:"11px", borderRadius:10, cursor:"pointer" }}>Cancelar</button>
          <button onClick={function(){ if(!form.nome) return; onSave(form); onClose(); }} disabled={!form.nome}
            style={{ flex:2, background:form.nome?"#0f172a":"#f1f5f9", border:"none", color:form.nome?"#fff":"#94a3b8", fontWeight:700, padding:"11px", borderRadius:10, cursor:form.nome?"pointer":"not-allowed" }}>
            Salvar Depósito
          </button>
        </div>
      </div>
    </div>
  );
}

function ModalTransfEstoque({ produto, depositos, estoqueDepositos, onConfirm, onClose }) {
  var estoquesProd = estoqueDepositos.filter(function(e){ return e.produtoId === produto.id; });
  const [origem, setOrigem] = useState(estoquesProd[0]?.depositoId || "");
  const [destino, setDestino] = useState(estoquesProd[1]?.depositoId || "");
  const [qtd, setQtd] = useState("");
  const [erro, setErro] = useState("");
  var estOrigem = estoquesProd.find(function(e){return e.depositoId===origem;});
  var dispOrigem = estOrigem ? parseInt(estOrigem.qtd||0) : 0;
  function confirmar() {
    var q = parseInt(qtd);
    if (!origem || !destino) { setErro("Selecione origem e destino"); return; }
    if (origem === destino) { setErro("Origem e destino não podem ser iguais"); return; }
    if (!q || q <= 0) { setErro("Informe uma quantidade válida"); return; }
    if (q > dispOrigem) { setErro("Quantidade maior que o disponível"); return; }
    onConfirm(origem, destino, q);
  }
  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(15,23,42,.6)", backdropFilter:"blur(4px)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:600, padding:24 }}>
      <div style={{ background:"#fff", borderRadius:16, width:"100%", maxWidth:460, padding:"28px 32px", boxShadow:"0 20px 60px rgba(0,0,0,.15)" }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:10 }}>
          <div>
            <div style={{ fontWeight:800, fontSize:17, color:"#0f172a" }}>⇄ Transferência de Estoque</div>
            <div style={{ fontSize:12, color:"#94a3b8", marginTop:2, maxWidth:340, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{produto.titulo}</div>
          </div>
          <button onClick={onClose} style={{ background:"#f1f5f9", border:"none", color:"#64748b", width:32, height:32, borderRadius:8, cursor:"pointer", fontSize:16 }}>✕</button>
        </div>
        <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
          <div style={{ display:"flex", alignItems:"center", gap:12 }}>
            <div style={{ flex:1 }}>
              <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>De (Origem)</div>
              <select value={origem} onChange={function(e){setOrigem(e.target.value);setErro("");}}
                style={{ width:"100%", background:"#f8fafc", border:"1px solid #e2e8f0", color:"#0f172a", padding:"9px 12px", borderRadius:8, fontSize:13 }}>
                <option value="">— Selecione —</option>
                {estoquesProd.map(function(e){
                  var dep = depositos.find(function(d){return d.id===e.depositoId;});
                  return dep ? <option key={dep.id} value={dep.id}>{dep.icone} {dep.nome} ({e.qtd} un)</option> : null;
                })}
              </select>
            </div>
            <div style={{ fontSize:20, color:"#0891b2", marginTop:20 }}>→</div>
            <div style={{ flex:1 }}>
              <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Para (Destino)</div>
              <select value={destino} onChange={function(e){setDestino(e.target.value);setErro("");}}
                style={{ width:"100%", background:"#f8fafc", border:"1px solid #e2e8f0", color:"#0f172a", padding:"9px 12px", borderRadius:8, fontSize:13 }}>
                <option value="">— Selecione —</option>
                {depositos.filter(function(d){return d.id!==origem&&d.ativo!==false;}).map(function(d){
                  var est = estoqueDepositos.find(function(e){return e.produtoId===produto.id&&e.depositoId===d.id;});
                  return <option key={d.id} value={d.id}>{d.icone} {d.nome} ({est?est.qtd:0} un)</option>;
                })}
              </select>
            </div>
          </div>
          <div>
            <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Quantidade *</div>
            <input type="number" min="1" max={dispOrigem} value={qtd} onChange={function(e){setQtd(e.target.value);setErro("");}} placeholder="Ex: 5" autoFocus
              style={{ width:"100%", background:"#f8fafc", border:"1px solid #e2e8f0", color:"#0f172a", padding:"9px 12px", borderRadius:8, fontSize:16, fontWeight:700, outline:"none" }} />
            {origem && <div style={{ fontSize:11, color:"#94a3b8", marginTop:4 }}>Disponível na origem: {dispOrigem} un</div>}
          </div>
          {qtd && parseInt(qtd)>0 && !erro && origem && destino && origem!==destino && (
            <div style={{ background:"#eff6ff", border:"1px solid #bfdbfe", borderRadius:10, padding:"7px 10px", fontSize:12, color:"#1d4ed8", fontWeight:600 }}>
              {qtd} un: {depositos.find(function(d){return d.id===origem;})?.nome} → {depositos.find(function(d){return d.id===destino;})?.nome}
            </div>
          )}
          {erro && <div style={{ background:"#fef2f2", border:"1px solid #fecaca", borderRadius:8, padding:"5px 8px", fontSize:12, color:"#dc2626", fontWeight:600 }}>⚠️ {erro}</div>}
        </div>
        <div style={{ display:"flex", gap:8, marginTop:20 }}>
          <button onClick={onClose} style={{ flex:1, background:"#f8fafc", border:"1px solid #e2e8f0", color:"#64748b", fontWeight:600, padding:"11px", borderRadius:10, cursor:"pointer" }}>Cancelar</button>
          <button onClick={confirmar}
            style={{ flex:2, background:(!qtd||!origem||!destino||origem===destino)?"#f1f5f9":"#0891b2", border:"none", color:(!qtd||!origem||!destino||origem===destino)?"#94a3b8":"#fff", fontWeight:700, padding:"11px", borderRadius:10, cursor:(!qtd||!origem||!destino||origem===destino)?"not-allowed":"pointer" }}>
            ⇄ Confirmar Transferência
          </button>
        </div>
      </div>
    </div>
  );
}


// ════════════════════════════════════════════════════════════
//  PEDIDOS DE COMPRA
// ════════════════════════════════════════════════════════════
function savePedidosCompra(v){ try { localStorage.setItem("pedidos_compra", JSON.stringify(v)); } catch {} }

function PedidosCompraTab({ produtos, fornecedores, setProdutos, exportarCSV, exportarXLS, exportarPDF, BotaoExportar, fmtDate }) {
  const [pedidos, setPedidos] = useState(function(){ try { return JSON.parse(localStorage.getItem("pedidos_compra")||"[]"); } catch { return []; } });
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState(null);
  const [search, setSearch] = useState("");
  const [filterStatus, setFilterStatus] = useState("todos");
  const [filterForn, setFilterForn] = useState("all");

  function salvar(p) {
    var lista = pedidos.find(function(x){return x.id===p.id;})
      ? pedidos.map(function(x){return x.id===p.id?p:x;})
      : [p, ...pedidos];
    setPedidos(lista); savePedidosCompra(lista);
  }
  function excluir(id) {
    if (!window.confirm("Excluir este pedido de compra?")) return;
    var lista = pedidos.filter(function(x){return x.id!==id;});
    setPedidos(lista); savePedidosCompra(lista);
  }
  function mudarStatus(id, s) {
    var lista = pedidos.map(function(x){ return x.id===id?Object.assign({},x,{status:s,dataStatus:new Date().toLocaleDateString("sv-SE")}):x; });
    setPedidos(lista); savePedidosCompra(lista);
    // Se recebido: dar entrada no estoque
    if (s === "Recebido") {
      var ped = pedidos.find(function(x){return x.id===id;});
      if (!ped) return;
      var upd = produtos.slice();
      (ped.itens||[]).forEach(function(it){
        var idx = upd.findIndex(function(p){return p.id===it.produtoId;});
        if (idx>=0) {
          var novoEst = parseInt(upd[idx].estoqueAtual||0)+parseInt(it.qtd||0);
          upd[idx] = Object.assign({},upd[idx],{estoqueAtual:String(novoEst)});
        }
      });
      setProdutos(upd); localStorage.setItem("produtos_cadastro", JSON.stringify(upd));
    }
  }

  var STATUS_CFG = {
    "Em aberto":  { cor:"#d97706", bg:"#fffbeb" },
    "Enviado":    { cor:"#0891b2", bg:"#ecfeff" },
    "Parcial":    { cor:"#7c3aed", bg:"#f5f3ff" },
    "Recebido":   { cor:"#15803d", bg:"#f0fdf4" },
    "Cancelado":  { cor:"#dc2626", bg:"#fef2f2" },
  };

  var filtrados = pedidos.filter(function(p){
    if (filterStatus!=="todos"&&p.status!==filterStatus) return false;
    if (filterForn!=="all"&&p.fornecedorId!==filterForn) return false;
    if (search) { var q=search.toLowerCase(); return (p.numero||"").includes(q)||(p.fornecedorNome||"").toLowerCase().includes(q)||(p.obs||"").toLowerCase().includes(q); }
    return true;
  });

  var totalPendente = pedidos.filter(function(p){return p.status==="Em aberto"||p.status==="Enviado";}).reduce(function(s,p){ return s+(p.itens||[]).reduce(function(ss,it){return ss+parseFloat(it.valorTotal||0);},0); },0);
  var fmt2 = function(n){ return "R$ "+Number(n).toFixed(2).replace(".",","); };

  return (
    <div>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8 }}>
        <div>
          <div style={{ fontWeight:800, fontSize:18, color:"#0f172a" }}>🛒 Pedidos de Compra</div>
          <div style={{ fontSize:13, color:"#94a3b8", marginTop:2 }}>Gerencie pedidos de compra para seus fornecedores</div>
        </div>
        <div style={{ display:"flex", gap:8 }}>
          <BotaoExportar
            onCSV={function(){
              var cab=["Número","Fornecedor","Data Criação","Prev. Entrega","Status","Itens","Valor Total","Observação"];
              var linhas=filtrados.map(function(p){
                var total=p.itens.reduce(function(s,it){return s+parseFloat(it.valorTotal||0);},0);
                return [p.numero||"",p.fornecedorNome||"",fmtDate(p.dataCriacao),fmtDate(p.dataEntregaPrev)||"",p.status,p.itens.length,"R$ "+total.toFixed(2).replace(".",","),p.obs||""];
              });
              exportarCSV("pedidos_de_compra",cab,linhas);
            }}
            onXLS={function(){
              var cab=["Número","Fornecedor","Data","Produto","SKU","Qtd Pedida","Qtd Recebida","Vlr Unit.","Vlr Total","Status Pedido"];
              var linhas=[];
              filtrados.forEach(function(p){
                (p.itens||[]).forEach(function(it){
                  linhas.push([p.numero||"",p.fornecedorNome||"",fmtDate(p.dataCriacao),it.titulo||"",it.sku||"",it.qtd||0,it.qtdRecebida||0,it.valorUnit?"R$ "+parseFloat(it.valorUnit).toFixed(2).replace(".",","):"",it.valorTotal?"R$ "+parseFloat(it.valorTotal).toFixed(2).replace(".",","):"",p.status]);
                });
              });
              exportarXLS("pedidos_de_compra_itens",cab,linhas);
            }}
            onPDF={function(){
              var cab=["Número","Fornecedor","Data","Status","Itens","Total"];
              var linhas=filtrados.map(function(p){
                var total=p.itens.reduce(function(s,it){return s+parseFloat(it.valorTotal||0);},0);
                return [p.numero||"",p.fornecedorNome||"",fmtDate(p.dataCriacao),p.status,p.itens.length,"R$ "+total.toFixed(2).replace(".",",")];
              });
              var totalGeral=filtrados.reduce(function(s,p){return s+p.itens.reduce(function(ss,it){return ss+parseFloat(it.valorTotal||0);},0);},0);
              exportarPDF("pedidos_de_compra","Pedidos de Compra",cab,linhas,["Total de pedidos: "+filtrados.length,"Valor total: R$ "+totalGeral.toFixed(2).replace(".",",")]);
            }}
          />
          <button onClick={function(){setEditing(null);setShowModal(true);}}
            style={{ background:"#0f172a", border:"none", color:"#fff", fontWeight:700, padding:"10px 22px", borderRadius:10, cursor:"pointer", fontSize:13 }}>
            + Novo Pedido de Compra
          </button>
        </div>
      </div>

      {/* Cards */}
      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(140px,1fr))", gap:7, marginBottom:8 }}>
        {[
          { l:"Total de Pedidos", v:pedidos.length, cor:"#0f172a" },
          { l:"Em Aberto", v:pedidos.filter(function(p){return p.status==="Em aberto";}).length, cor:"#d97706" },
          { l:"Enviados", v:pedidos.filter(function(p){return p.status==="Enviado";}).length, cor:"#0891b2" },
          { l:"Recebidos", v:pedidos.filter(function(p){return p.status==="Recebido";}).length, cor:"#15803d" },
          { l:"Total Pendente", v:fmt2(totalPendente), cor:"#dc2626" },
        ].map(function(k){
          return (
            <div key={k.l} style={{ background:"#fff", border:"1px solid #e2e8f0", borderRadius:12, padding:"12px 16px" }}>
              <div style={{ fontSize:9, color:"#94a3b8", fontWeight:600, textTransform:"uppercase", marginBottom:3 }}>{k.l}</div>
              <div style={{ fontSize:15, fontWeight:800, color:k.cor }}>{k.v}</div>
            </div>
          );
        })}
      </div>

      {/* Filtros */}
      <div style={{ background:"#f8fafc", border:"1px solid #e2e8f0", borderRadius:10, padding:"12px 14px", marginBottom:8 }}>
        <div style={{ display:"flex", gap:8, alignItems:"center", flexWrap:"wrap" }}>
          <div style={{ position:"relative", flex:1, minWidth:200 }}>
            <span style={{ position:"absolute", left:8, top:"50%", transform:"translateY(-50%)", color:"#94a3b8", fontSize:13 }}>🔍</span>
            <input value={search} onChange={function(e){setSearch(e.target.value);}} placeholder="Buscar por número, fornecedor..."
              style={{ width:"100%", background:"#fff", border:"1px solid #e2e8f0", color:"#0f172a", padding:"7px 10px 7px 28px", borderRadius:8, fontSize:12, outline:"none" }} />
          </div>
          <select value={filterForn} onChange={function(e){setFilterForn(e.target.value);}}
            style={{ background:"#fff", border:"1px solid #e2e8f0", color:"#334155", padding:"7px 10px", borderRadius:8, fontSize:12 }}>
            <option value="all">Todos fornecedores</option>
            {fornecedores.map(function(f){ return <option key={f.id} value={f.id}>{f.nome}</option>; })}
          </select>
          <div style={{ display:"flex", gap:4 }}>
            {["todos","Em aberto","Enviado","Parcial","Recebido","Cancelado"].map(function(s){
              var a = filterStatus===s;
              var cfg = STATUS_CFG[s];
              return <button key={s} onClick={function(){setFilterStatus(s);}}
                style={{ padding:"3px 9px", borderRadius:20, border:"none", cursor:"pointer", fontSize:11, fontWeight:a?700:400,
                  background:a?(cfg?cfg.bg:"#0f172a"):"#f1f5f9", color:a?(cfg?cfg.cor:"#fff"):"#64748b" }}>
                {s==="todos"?"Todos":s}
              </button>;
            })}
          </div>
          <span style={{ fontSize:12, color:"#94a3b8" }}>{filtrados.length} pedido(s)</span>
        </div>
      </div>

      {/* Lista */}
      {filtrados.length === 0 ? (
        <div style={{ background:"#f8fafc", border:"2px dashed #e2e8f0", borderRadius:12, padding:48, textAlign:"center", color:"#94a3b8" }}>
          <div style={{ fontSize:40, marginBottom:8 }}>🛒</div>
          <div style={{ fontWeight:700, fontSize:15, marginBottom:4 }}>Nenhum pedido de compra</div>
          <div style={{ fontSize:13 }}>Clique em "+ Novo Pedido de Compra" para começar</div>
        </div>
      ) : filtrados.map(function(ped){
        var cfg = STATUS_CFG[ped.status]||STATUS_CFG["Em aberto"];
        var totalQtd = (ped.itens||[]).reduce(function(s,it){return s+parseInt(it.qtd||0);},0);
        var totalVal = (ped.itens||[]).reduce(function(s,it){return s+parseFloat(it.valorTotal||0);},0);
        return (
          <div key={ped.id} style={{ background:"#fff", border:"1px solid #e2e8f0", borderRadius:12, marginBottom:12, overflow:"hidden" }}>
            <div style={{ background:cfg.bg, borderBottom:"1px solid "+cfg.cor+"22", padding:"12px 18px", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
              <div style={{ display:"flex", alignItems:"center", gap:12 }}>
                <div>
                  <div style={{ fontWeight:700, fontSize:15, color:"#0f172a" }}>Pedido #{ped.numero||ped.id.slice(-6)}</div>
                  <div style={{ fontSize:12, color:"#64748b" }}>
                    {ped.fornecedorNome||"—"} · {fmtDate(ped.dataCriacao)||"—"} · {totalQtd} itens · {fmt2(totalVal)}
                  </div>
                </div>
                <span style={{ fontSize:11, fontWeight:700, color:cfg.cor, background:"#fff", padding:"2px 10px", borderRadius:20, border:"1px solid "+cfg.cor+"44" }}>{ped.status}</span>
              </div>
              <div style={{ display:"flex", gap:6 }}>
                {ped.status==="Em aberto" && <button onClick={function(){mudarStatus(ped.id,"Enviado");}} style={{ background:"#0891b2", border:"none", color:"#fff", fontWeight:700, padding:"4px 10px", borderRadius:8, cursor:"pointer", fontSize:12 }}>🚛 Marcar Enviado</button>}
                {ped.status==="Enviado" && <button onClick={function(){mudarStatus(ped.id,"Recebido");}} style={{ background:"#15803d", border:"none", color:"#fff", fontWeight:700, padding:"4px 10px", borderRadius:8, cursor:"pointer", fontSize:12 }}>✅ Confirmar Recebimento</button>}
                <button onClick={function(){setEditing(ped);setShowModal(true);}} style={{ background:"#f1f5f9", border:"1px solid #e2e8f0", color:"#64748b", padding:"6px 10px", borderRadius:8, cursor:"pointer", fontSize:12 }}>✏️</button>
                <button onClick={function(){excluir(ped.id);}} style={{ background:"#fef2f2", border:"1px solid #fecaca", color:"#dc2626", padding:"6px 10px", borderRadius:8, cursor:"pointer", fontSize:12 }}>🗑</button>
              </div>
            </div>
            {(ped.itens||[]).length > 0 && (
              <div style={{ padding:"10px 18px" }}>
                <table style={{ borderCollapse:"collapse", width:"100%" }}>
                  <thead>
                    <tr>{["Produto","SKU","Qtd Pedida","Qtd Recebida","Vlr Unit.","Total","Obs"].map(function(h){
                      return <th key={h} style={{ fontSize:10, color:"#94a3b8", textTransform:"uppercase", padding:"6px 8px", borderBottom:"1px solid #f1f5f9", textAlign:"left", fontWeight:600 }}>{h}</th>;
                    })}</tr>
                  </thead>
                  <tbody>
                    {(ped.itens||[]).map(function(it,i){
                      return (
                        <tr key={i} style={{ background:i%2===0?"#f8fafc":"#fff" }}>
                          <td style={{ padding:"6px 8px", fontSize:12, color:"#0f172a" }}>{it.titulo||"—"}</td>
                          <td style={{ padding:"6px 8px", fontSize:11, color:"#64748b", fontFamily:"monospace" }}>{it.sku||"—"}</td>
                          <td style={{ padding:"6px 8px", fontSize:13, fontWeight:700, color:"#0f172a", textAlign:"center" }}>{it.qtd}</td>
                          <td style={{ padding:"6px 8px", fontSize:13, fontWeight:700, color:"#15803d", textAlign:"center" }}>{it.qtdRecebida||0}</td>
                          <td style={{ padding:"6px 8px", fontSize:12, color:"#64748b" }}>{it.valorUnit?fmt2(it.valorUnit):"—"}</td>
                          <td style={{ padding:"6px 8px", fontSize:12, fontWeight:700, color:"#0f172a" }}>{it.valorTotal?fmt2(it.valorTotal):"—"}</td>
                          <td style={{ padding:"6px 8px", fontSize:11, color:"#94a3b8" }}>{it.obs||"—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr style={{ background:"#f1f5f9" }}>
                      <td colSpan={2} style={{ padding:"6px 8px", fontWeight:700, fontSize:12 }}>TOTAL</td>
                      <td style={{ padding:"6px 8px", fontWeight:800, textAlign:"center" }}>{totalQtd}</td>
                      <td colSpan={2} />
                      <td style={{ padding:"6px 8px", fontWeight:800, color:"#0f172a" }}>{fmt2(totalVal)}</td>
                      <td />
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
            {ped.obs && <div style={{ padding:"0 18px 10px", fontSize:12, color:"#64748b", fontStyle:"italic" }}>💬 {ped.obs}</div>}
          </div>
        );
      })}

      {showModal && <ModalPedidoCompra pedido={editing} produtos={produtos} fornecedores={fornecedores} onSave={function(p){salvar(p);setShowModal(false);setEditing(null);}} onClose={function(){setShowModal(false);setEditing(null);}} />}
    </div>
  );
}

function ModalPedidoCompra({ pedido, produtos, fornecedores, onSave, onClose }) {
  var empty = {
    id:Date.now().toString(), numero:String(Date.now()).slice(-6),
    fornecedorId:"", fornecedorNome:"", fornecedorCNPJ:"",
    status:"Em aberto", dataCriacao:new Date().toLocaleDateString("sv-SE"),
    dataEntregaPrev:"", ordemCompra:"",
    desconto:"0", frete:"0", outrasDespesas:"0",
    condicaoPagamento:"", transportador:"", fretePorConta:"0",
    pesoBruto:"", quantidade:"",
    itens:[], obs:"", obsInternas:""
  };
  const [form, setForm] = useState(pedido||empty);
  const [busca, setBusca] = useState("");
  const [resultados, setResultados] = useState([]);
  var set = function(k,v){setForm(function(f){return Object.assign({},f,{[k]:v});});};

  function buscarProds(q) {
    setBusca(q);
    if (!q||q.length<2) {setResultados([]);return;}
    var ql=q.toLowerCase();
    setResultados(produtos.filter(function(p){return (p.titulo||"").toLowerCase().includes(ql)||(p.sku||"").toLowerCase().includes(ql);}).slice(0,8));
  }
  function addItem(prod) {
    if (form.itens.find(function(it){return it.produtoId===prod.id;})) {setResultados([]);setBusca("");return;}
    set("itens",[...form.itens,{produtoId:prod.id,titulo:prod.titulo,sku:prod.sku||"",qtd:"1",qtdRecebida:"0",valorUnit:prod.precoCusto||"",valorTotal:prod.precoCusto||"",obs:""}]);
    setResultados([]);setBusca("");
  }
  function updItem(i,k,v) {
    var upd=form.itens.map(function(it,j){
      if(j!==i)return it;
      var u=Object.assign({},it,{[k]:v});
      if(k==="qtd"||k==="valorUnit") u.valorTotal=(parseFloat(k==="qtd"?v:u.qtd||0)*parseFloat(k==="valorUnit"?v:u.valorUnit||0)).toFixed(2);
      return u;
    });
    set("itens",upd);
  }
  function remItem(i){set("itens",form.itens.filter(function(_,j){return j!==i;}));}
  var total=form.itens.reduce(function(s,it){return s+parseFloat(it.valorTotal||0);},0);
  var fmt2=function(n){return "R$ "+Number(n).toFixed(2).replace(".",",");};

  return (
    <div style={{ position:"fixed",inset:0,background:"rgba(15,23,42,.65)",backdropFilter:"blur(4px)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:600,padding:12 }}>
      <div style={{ background:"#fff",borderRadius:16,width:"100%",maxWidth:"98vw",height:"96vh",maxHeight:"96vh",display:"flex",flexDirection:"column",boxShadow:"0 24px 64px rgba(0,0,0,.2)" }}>
        <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",padding:"10px 16px",borderBottom:"1px solid #f1f5f9" }}>
          <div style={{ fontWeight:800,fontSize:17,color:"#0f172a" }}>{pedido?"Editar Pedido de Compra":"Novo Pedido de Compra"}</div>
          <button onClick={onClose} style={{ background:"#f1f5f9",border:"none",color:"#64748b",width:32,height:32,borderRadius:8,cursor:"pointer",fontSize:16 }}>✕</button>
        </div>
        <div style={{ flex:1,overflowY:"auto",padding:"12px 16px" }}>
          {/* ── FORNECEDOR ── */}
          <div style={{ fontSize:12,fontWeight:700,color:"#0f172a",marginBottom:8,paddingBottom:6,borderBottom:"1px solid #f1f5f9" }}>Fornecedor</div>
          <div style={{ display:"grid",gridTemplateColumns:"2fr 1fr 1fr",gap:7,marginBottom:8 }}>
            <div>
              <div style={{ fontSize:11,color:"#94a3b8",marginBottom:4,fontWeight:600,textTransform:"uppercase" }}>Fornecedor *</div>
              <select value={form.fornecedorId} onChange={function(e){
                var f=fornecedores.find(function(x){return x.id===e.target.value;});
                set("fornecedorId",e.target.value);
                if(f){set("fornecedorNome",f.nome);set("fornecedorCNPJ",f.cnpj||"");}
              }} style={{ width:"100%",background:"#f8fafc",border:"1px solid #e2e8f0",color:"#334155",padding:"8px 11px",borderRadius:8,fontSize:12 }}>
                <option value="">— Selecione —</option>
                {fornecedores.filter(function(f){return !f.tipo||f.tipo==="Fornecedor";}).map(function(f){return <option key={f.id} value={f.id}>{f.nome}</option>;})}
              </select>
            </div>
            <div>
              <div style={{ fontSize:11,color:"#94a3b8",marginBottom:4,fontWeight:600,textTransform:"uppercase" }}>CNPJ/CPF</div>
              <input type="text" value={form.fornecedorCNPJ||""} onChange={function(e){set("fornecedorCNPJ",e.target.value);}} placeholder=""
                style={{ width:"100%",background:"#f8fafc",border:"1px solid #e2e8f0",color:"#0f172a",padding:"8px 11px",borderRadius:8,fontSize:12,outline:"none" }} />
            </div>
            <div>
              <div style={{ fontSize:11,color:"#94a3b8",marginBottom:4,fontWeight:600,textTransform:"uppercase" }}>Nº do Pedido</div>
              <input type="text" value={form.numero||""} onChange={function(e){set("numero",e.target.value);}} placeholder=""
                style={{ width:"100%",background:"#f8fafc",border:"1px solid #e2e8f0",color:"#0f172a",padding:"8px 11px",borderRadius:8,fontSize:12,outline:"none" }} />
            </div>
          </div>

          {/* ── ITENS DO PEDIDO ── */}
          <div style={{ fontSize:12,fontWeight:700,color:"#0f172a",marginBottom:8,paddingBottom:6,borderBottom:"1px solid #f1f5f9" }}>Itens do Pedido de Compra</div>
          {/* Busca produto */}
          <div style={{ marginBottom:8,position:"relative" }}>
            <div style={{ fontSize:13,fontWeight:700,color:"#0f172a",marginBottom:8 }}>Adicionar Produtos</div>
            <span style={{ position:"absolute",left:10,top:36,color:"#94a3b8" }}>🔍</span>
            <input value={busca} onChange={function(e){buscarProds(e.target.value);}} placeholder="Buscar produto por nome ou SKU..."
              style={{ width:"100%",background:"#f8fafc",border:"1px solid #e2e8f0",color:"#0f172a",padding:"9px 12px 9px 32px",borderRadius:8,fontSize:13,outline:"none" }} />
            {resultados.length>0&&(
              <div style={{ position:"absolute",top:"100%",left:0,right:0,background:"#fff",border:"1px solid #e2e8f0",borderRadius:10,boxShadow:"0 8px 24px rgba(0,0,0,.12)",zIndex:50,overflow:"hidden" }}>
                {resultados.map(function(p){
                  return <div key={p.id} onClick={function(){addItem(p);}}
                    style={{ padding:"10px 14px",cursor:"pointer",borderBottom:"1px solid #f1f5f9",display:"flex",justifyContent:"space-between" }}
                    onMouseEnter={function(e){e.currentTarget.style.background="#f0fdf4";}}
                    onMouseLeave={function(e){e.currentTarget.style.background="#fff";}}>
                    <div>
                      <div style={{ fontSize:13,fontWeight:600,color:"#0f172a" }}>{p.titulo?.slice(0,55)}</div>
                      <div style={{ fontSize:11,color:"#94a3b8" }}>SKU: {p.sku||"—"} · Estoque: {p.estoqueAtual||0} · Custo: {p.precoCusto?"R$ "+p.precoCusto:"—"}</div>
                    </div>
                    <span style={{ fontSize:12,color:"#15803d",fontWeight:700 }}>+ Adicionar</span>
                  </div>;
                })}
              </div>
            )}
          </div>
          {/* Tabela itens */}
          {form.itens.length>0&&(
            <div style={{ background:"#fff",border:"1px solid #e2e8f0",borderRadius:12,overflow:"hidden",marginBottom:12 }}>
              <table style={{ borderCollapse:"collapse",width:"100%" }}>
                <thead>
                  <tr>{["Item","Produto","Código SKU","Un","Qtde","Preço un","IPI %","Preço total","Obs",""].map(function(h){
                    return <th key={h} style={{ fontSize:10,color:"#94a3b8",textTransform:"uppercase",padding:"5px 8px",borderBottom:"1px solid #f1f5f9",textAlign:"left",fontWeight:600,background:"#fafafa" }}>{h}</th>;
                  })}</tr>
                </thead>
                <tbody>
                  {form.itens.map(function(it,i){
                    return (
                      <tr key={i} style={{ background:i%2===0?"#f8fafc":"#fff" }}>
                        <td style={{ padding:"7px 10px",fontSize:11,color:"#94a3b8",textAlign:"center",width:30 }}>{i+1}</td>
                        <td style={{ padding:"7px 10px",fontSize:12,color:"#0f172a",maxWidth:160,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>{it.titulo}</td>
                        <td style={{ padding:"7px 10px",fontSize:11,color:"#64748b",fontFamily:"monospace" }}>{it.sku||"—"}</td>
                        <td style={{ padding:"7px 10px",fontSize:11,color:"#94a3b8",textAlign:"center" }}>UN</td>
                        <td style={{ padding:"7px 10px" }}><input type="number" min="1" value={it.qtd} onChange={function(e){updItem(i,"qtd",e.target.value);}} style={{ width:56,textAlign:"center",background:"#f0fdf4",border:"1px solid #bbf7d0",color:"#15803d",padding:"4px 6px",borderRadius:6,fontSize:13,fontWeight:700,outline:"none" }} /></td>
                        <td style={{ padding:"7px 10px" }}><input type="number" step="0.01" value={it.valorUnit||""} onChange={function(e){updItem(i,"valorUnit",e.target.value);}} placeholder="0,00" style={{ width:76,background:"#f8fafc",border:"1px solid #e2e8f0",color:"#0f172a",padding:"4px 6px",borderRadius:6,fontSize:12,outline:"none" }} /></td>
                        <td style={{ padding:"7px 10px" }}><input type="number" step="0.01" min="0" value={it.ipi||""} onChange={function(e){updItem(i,"ipi",e.target.value);}} placeholder="0" style={{ width:50,background:"#f8fafc",border:"1px solid #e2e8f0",color:"#0f172a",padding:"4px 6px",borderRadius:6,fontSize:12,outline:"none",textAlign:"center" }} /></td>
                        <td style={{ padding:"7px 10px",fontSize:12,fontWeight:700,color:"#0f172a",whiteSpace:"nowrap" }}>
                          {it.valorTotal?"R$ "+parseFloat(it.valorTotal).toFixed(2).replace(".",","):"—"}
                        </td>
                        <td style={{ padding:"7px 10px" }}><input value={it.obs||""} onChange={function(e){updItem(i,"obs",e.target.value);}} placeholder="Obs..." style={{ width:85,background:"#f8fafc",border:"1px solid #e2e8f0",color:"#0f172a",padding:"4px 6px",borderRadius:6,fontSize:11,outline:"none" }} /></td>
                        <td style={{ padding:"7px 10px" }}><button onClick={function(){remItem(i);}} style={{ background:"#fef2f2",border:"none",color:"#dc2626",width:24,height:24,borderRadius:6,cursor:"pointer",fontSize:11 }}>✕</button></td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr style={{ background:"#f1f5f9" }}>
                    <td colSpan={5} style={{ padding:"5px 8px",fontWeight:700,fontSize:13 }}>TOTAL DO PEDIDO</td>
                    <td style={{ padding:"5px 8px",fontWeight:800,fontSize:14,color:"#0f172a" }}>{fmt2(total)}</td>
                    <td colSpan={2}/>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
          {/* ── TOTAIS DA COMPRA ── */}
          <div style={{ fontSize:12,fontWeight:700,color:"#0f172a",marginBottom:8,marginTop:14,paddingBottom:6,borderBottom:"1px solid #f1f5f9" }}>Totais da Compra</div>
          <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr 1fr 1fr",gap:7,marginBottom:8 }}>
            <div>
              <div style={{ fontSize:10,color:"#94a3b8",marginBottom:4,fontWeight:600,textTransform:"uppercase" }}>Total dos Produtos</div>
              <div style={{ background:"#f8fafc",border:"1px solid #e2e8f0",borderRadius:8,padding:"8px 11px",fontSize:13,fontWeight:700,color:"#0f172a" }}>
                R$ {total.toFixed(2).replace(".",",")}
              </div>
            </div>
            <div>
              <div style={{ fontSize:10,color:"#94a3b8",marginBottom:4,fontWeight:600,textTransform:"uppercase" }}>Desconto (R$)</div>
              <input type="number" step="0.01" min="0" value={form.desconto||"0"} onChange={function(e){set("desconto",e.target.value);}}
                style={{ width:"100%",background:"#f8fafc",border:"1px solid #e2e8f0",color:"#0f172a",padding:"8px 11px",borderRadius:8,fontSize:12,outline:"none" }} />
            </div>
            <div>
              <div style={{ fontSize:10,color:"#94a3b8",marginBottom:4,fontWeight:600,textTransform:"uppercase" }}>Frete (R$)</div>
              <input type="number" step="0.01" min="0" value={form.frete||"0"} onChange={function(e){set("frete",e.target.value);}}
                style={{ width:"100%",background:"#f8fafc",border:"1px solid #e2e8f0",color:"#0f172a",padding:"8px 11px",borderRadius:8,fontSize:12,outline:"none" }} />
            </div>
            <div>
              <div style={{ fontSize:10,color:"#94a3b8",marginBottom:4,fontWeight:600,textTransform:"uppercase" }}>Total do Pedido</div>
              <div style={{ background:"#0f172a",borderRadius:8,padding:"8px 11px",fontSize:14,fontWeight:800,color:"#fff" }}>
                R$ {(total - parseFloat(form.desconto||0) + parseFloat(form.frete||0)).toFixed(2).replace(".",",")}
              </div>
            </div>
          </div>

          {/* ── DETALHES DA COMPRA ── */}
          <div style={{ fontSize:12,fontWeight:700,color:"#0f172a",marginBottom:8,paddingBottom:6,borderBottom:"1px solid #f1f5f9" }}>Detalhes da Compra</div>
          <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr 1fr 1fr",gap:7,marginBottom:8 }}>
            <div>
              <div style={{ fontSize:10,color:"#94a3b8",marginBottom:4,fontWeight:600,textTransform:"uppercase" }}>Data da Compra</div>
              <input type="date" value={form.dataCriacao||""} onChange={function(e){set("dataCriacao",e.target.value);}}
                style={{ width:"100%",background:"#f8fafc",border:"1px solid #e2e8f0",color:"#334155",padding:"8px 11px",borderRadius:8,fontSize:12 }} />
            </div>
            <div>
              <div style={{ fontSize:10,color:"#94a3b8",marginBottom:4,fontWeight:600,textTransform:"uppercase" }}>Data Prevista</div>
              <input type="date" value={form.dataEntregaPrev||""} onChange={function(e){set("dataEntregaPrev",e.target.value);}}
                style={{ width:"100%",background:"#f8fafc",border:"1px solid #e2e8f0",color:"#334155",padding:"8px 11px",borderRadius:8,fontSize:12 }} />
            </div>
            <div>
              <div style={{ fontSize:10,color:"#94a3b8",marginBottom:4,fontWeight:600,textTransform:"uppercase" }}>Ordem de Compra</div>
              <input value={form.ordemCompra||""} onChange={function(e){set("ordemCompra",e.target.value);}} placeholder=""
                style={{ width:"100%",background:"#f8fafc",border:"1px solid #e2e8f0",color:"#0f172a",padding:"8px 11px",borderRadius:8,fontSize:12,outline:"none" }} />
            </div>
            <div>
              <div style={{ fontSize:10,color:"#94a3b8",marginBottom:4,fontWeight:600,textTransform:"uppercase" }}>Condição de Pagamento</div>
              <input value={form.condicaoPagamento||""} onChange={function(e){set("condicaoPagamento",e.target.value);}} placeholder="Ex: 30/60/90 dias"
                style={{ width:"100%",background:"#f8fafc",border:"1px solid #e2e8f0",color:"#0f172a",padding:"8px 11px",borderRadius:8,fontSize:12,outline:"none" }} />
            </div>
          </div>

          {/* ── TRANSPORTADOR ── */}
          <div style={{ fontSize:12,fontWeight:700,color:"#0f172a",marginBottom:8,paddingBottom:6,borderBottom:"1px solid #f1f5f9" }}>Transportador</div>
          <div style={{ display:"grid",gridTemplateColumns:"2fr 1fr 1fr 1fr",gap:7,marginBottom:8 }}>
            <div>
              <div style={{ fontSize:10,color:"#94a3b8",marginBottom:4,fontWeight:600,textTransform:"uppercase" }}>Nome</div>
              <input value={form.transportador||""} onChange={function(e){set("transportador",e.target.value);}} placeholder="Nome da transportadora"
                style={{ width:"100%",background:"#f8fafc",border:"1px solid #e2e8f0",color:"#0f172a",padding:"8px 11px",borderRadius:8,fontSize:12,outline:"none" }} />
            </div>
            <div>
              <div style={{ fontSize:10,color:"#94a3b8",marginBottom:4,fontWeight:600,textTransform:"uppercase" }}>Frete por Conta</div>
              <select value={form.fretePorConta||"0"} onChange={function(e){set("fretePorConta",e.target.value);}}
                style={{ width:"100%",background:"#f8fafc",border:"1px solid #e2e8f0",color:"#334155",padding:"8px 11px",borderRadius:8,fontSize:11 }}>
                <option value="0">0 - CIF (Remetente)</option>
                <option value="1">1 - FOB (Destinatário)</option>
                <option value="2">2 - Terceiros</option>
                <option value="9">9 - Sem Frete</option>
              </select>
            </div>
            <div>
              <div style={{ fontSize:10,color:"#94a3b8",marginBottom:4,fontWeight:600,textTransform:"uppercase" }}>Peso Bruto (kg)</div>
              <input type="number" step="0.001" value={form.pesoBruto||""} onChange={function(e){set("pesoBruto",e.target.value);}} placeholder="0,000"
                style={{ width:"100%",background:"#f8fafc",border:"1px solid #e2e8f0",color:"#0f172a",padding:"8px 11px",borderRadius:8,fontSize:12,outline:"none" }} />
            </div>
            <div>
              <div style={{ fontSize:10,color:"#94a3b8",marginBottom:4,fontWeight:600,textTransform:"uppercase" }}>Quantidade Volumes</div>
              <input type="number" value={form.quantidade||""} onChange={function(e){set("quantidade",e.target.value);}} placeholder="0"
                style={{ width:"100%",background:"#f8fafc",border:"1px solid #e2e8f0",color:"#0f172a",padding:"8px 11px",borderRadius:8,fontSize:12,outline:"none" }} />
            </div>
          </div>

          {/* ── OBSERVAÇÕES ── */}
          <div style={{ fontSize:12,fontWeight:700,color:"#0f172a",marginBottom:8,paddingBottom:6,borderBottom:"1px solid #f1f5f9" }}>Dados Adicionais</div>
          <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:10 }}>
            <div>
              <div style={{ fontSize:10,color:"#94a3b8",marginBottom:4,fontWeight:600,textTransform:"uppercase" }}>Observações</div>
              <textarea value={form.obs||""} onChange={function(e){set("obs",e.target.value);}} placeholder="Observações da compra..." rows={3}
                style={{ width:"100%",background:"#f8fafc",border:"1px solid #e2e8f0",color:"#0f172a",padding:"8px 11px",borderRadius:8,fontSize:12,outline:"none",resize:"none",fontFamily:"inherit" }} />
            </div>
            <div>
              <div style={{ fontSize:10,color:"#94a3b8",marginBottom:4,fontWeight:600,textTransform:"uppercase" }}>Observações Internas</div>
              <textarea value={form.obsInternas||""} onChange={function(e){set("obsInternas",e.target.value);}} placeholder="Notas internas..." rows={3}
                style={{ width:"100%",background:"#f8fafc",border:"1px solid #e2e8f0",color:"#0f172a",padding:"8px 11px",borderRadius:8,fontSize:12,outline:"none",resize:"none",fontFamily:"inherit" }} />
            </div>
          </div>
        </div>
        <div style={{ display:"flex",gap:8,padding:"14px 28px",borderTop:"1px solid #f1f5f9",background:"#fafafa" }}>
          <button onClick={onClose} style={{ flex:1,background:"#f8fafc",border:"1px solid #e2e8f0",color:"#64748b",fontWeight:600,padding:"11px",borderRadius:10,cursor:"pointer" }}>Cancelar</button>
          <button onClick={function(){if(!form.fornecedorId)return;onSave(form);}} disabled={!form.fornecedorId}
            style={{ flex:3,background:form.fornecedorId?"#0f172a":"#f1f5f9",border:"none",color:form.fornecedorId?"#fff":"#94a3b8",fontWeight:700,padding:"11px",borderRadius:10,cursor:form.fornecedorId?"pointer":"not-allowed",fontSize:14 }}>
            ✓ Salvar Pedido de Compra
          </button>
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════
//  RELATÓRIOS DE ESTOQUE
// ════════════════════════════════════════════════════════════
function RelatoriosEstoqueTab({ produtos, fornecedores, movEstoque, listings }) {
  const [relAtivo, setRelAtivo] = useState(null);
  const [filtroDe, setFiltroDe] = useState("");
  const [filtroAte, setFiltroAte] = useState("");
  const [filtroProd, setFiltroProd] = useState("");

  var fmt2=function(n){return "R$ "+Number(n||0).toFixed(2).replace(".",",");};
  var hoje=new Date().toLocaleDateString("sv-SE");

  var RELATORIOS = [
    { key:"entradas_saidas",    titulo:"Entradas e Saídas de Estoque",         desc:"Todas as movimentações realizadas em um período com saldos" },
    { key:"saldo_atual",        titulo:"Relatório de Saldo em Estoque",         desc:"Saldo atual de todos os produtos com valor de estoque" },
    { key:"abaixo_minimo",      titulo:"Produtos Abaixo do Estoque Mínimo",     desc:"Produtos que precisam de reposição urgente" },
    { key:"sem_movimentacao",   titulo:"Produtos sem Movimentação",             desc:"Produtos que não tiveram movimentação no período" },
    { key:"maior_circulacao",   titulo:"Produtos com Maior Circulação",         desc:"Produtos mais movimentados no período" },
    { key:"visao_financeira",   titulo:"Visão Financeira do Estoque",           desc:"Valor total do estoque pelo preço de custo e venda" },
  ];

  function gerarRelatorio(key) {
    setRelAtivo(key);
  }

  var movsFiltradas = movEstoque.filter(function(m){
    if (filtroDe && m.data < filtroDe) return false;
    if (filtroAte && m.data > filtroAte) return false;
    if (filtroProd) { var p=produtos.find(function(x){return x.id===m.produtoId;}); return (p?.titulo||"").toLowerCase().includes(filtroProd.toLowerCase())||(p?.sku||"").toLowerCase().includes(filtroProd.toLowerCase()); }
    return true;
  });

  var dadosExport = useMemo(function(){
    if (!relAtivo) return null;
    if (relAtivo === "entradas_saidas") {
      var headers = ["Data","Produto","SKU","Tipo","Qtd","Motivo","Preço un."];
      var rows = movsFiltradas.slice().sort(function(a,b){return (b.id||0)-(a.id||0);}).slice(0,500).map(function(m){
        var prod=produtos.find(function(p){return p.id===m.produtoId;});
        var isE=m.tipo==="entrada";
        return [fmtDate(m.data), prod?.titulo||"—", prod?.sku||"—", isE?"Entrada":"Saída", (isE?"+":"-")+m.qtd, m.motivo||"—", m.preco?fmt2(m.preco):"—"];
      });
      return { titulo:"Entradas e Saídas de Estoque", headers:headers, rows:rows };
    }
    if (relAtivo === "saldo_atual") {
      var headers2=["Produto","SKU","Categoria","Estoque","Mín","Vlr Custo","Vlr Venda","Total Custo","Total Venda","Status"];
      var rows2 = produtos.filter(function(p){return !filtroProd||(p.titulo||"").toLowerCase().includes(filtroProd.toLowerCase())||(p.sku||"").toLowerCase().includes(filtroProd.toLowerCase());}).map(function(p){
        var est=parseInt(p.estoqueAtual||0),min=parseInt(p.estoqueMinimo||0);
        var critico=min>0&&est<=min, zerado=est<=0;
        var status = zerado?"Zerado":critico?"Crítico":"OK";
        return [p.titulo, p.sku||"—", p.categoria||"—", est, min||"—", p.precoCusto?fmt2(p.precoCusto):"—", p.precoVenda?fmt2(p.precoVenda):"—", p.precoCusto?fmt2(parseFloat(p.precoCusto)*est):"—", p.precoVenda?fmt2(parseFloat(p.precoVenda)*est):"—", status];
      });
      return { titulo:"Relatório de Saldo em Estoque", headers:headers2, rows:rows2 };
    }
    if (relAtivo === "abaixo_minimo") {
      var headers3=["Produto","SKU","Fornecedor","Estoque Atual","Estoque Mínimo","Diferença","Custo Unit.","Custo Reposição"];
      var rows3 = produtos.filter(function(p){return p.estoqueMinimo&&parseInt(p.estoqueAtual||0)<=parseInt(p.estoqueMinimo||0);}).map(function(p){
        var est=parseInt(p.estoqueAtual||0),min=parseInt(p.estoqueMinimo||0),diff=min-est;
        var forn=fornecedores.find(function(f){return f.id===p.fornecedorId;});
        return [p.titulo, p.sku||"—", forn?.nome||"—", est, min, "-"+diff, p.precoCusto?fmt2(p.precoCusto):"—", p.precoCusto?fmt2(parseFloat(p.precoCusto)*diff):"—"];
      });
      return { titulo:"Produtos Abaixo do Estoque Mínimo", headers:headers3, rows:rows3 };
    }
    if (relAtivo === "sem_movimentacao" || relAtivo === "maior_circulacao") {
      var movsProd={};
      movsFiltradas.forEach(function(m){ movsProd[m.produtoId]=(movsProd[m.produtoId]||0)+m.qtd; });
      var prods=relAtivo==="sem_movimentacao"
        ? produtos.filter(function(p){return !movsProd[p.id];})
        : produtos.filter(function(p){return movsProd[p.id]>0;}).sort(function(a,b){return (movsProd[b.id]||0)-(movsProd[a.id]||0);}).slice(0,50);
      var headers4=["#","Produto","SKU","Estoque Atual","Movimentação Total","Custo Unit."];
      var rows4 = prods.slice(0,100).map(function(p,i){
        return [i+1, p.titulo, p.sku||"—", p.estoqueAtual||0, movsProd[p.id]||0, p.precoCusto?fmt2(p.precoCusto):"—"];
      });
      return { titulo: relAtivo==="sem_movimentacao"?"Produtos sem Movimentação":"Produtos com Maior Circulação", headers:headers4, rows:rows4 };
    }
    if (relAtivo === "visao_financeira") {
      var headers5=["Produto","SKU","Estoque","Custo Unit.","Venda Unit.","Total Custo","Total Venda","Lucro","Margem"];
      var rows5 = produtos.filter(function(p){return parseInt(p.estoqueAtual||0)>0;}).map(function(p){
        var est=parseInt(p.estoqueAtual||0);
        var custo=parseFloat(p.precoCusto||0)*est;
        var venda=parseFloat(p.precoVenda||0)*est;
        var lucro=venda-custo;
        var margem=venda>0?(lucro/venda)*100:0;
        return [p.titulo, p.sku||"—", est, p.precoCusto?fmt2(p.precoCusto):"—", p.precoVenda?fmt2(p.precoVenda):"—", custo>0?fmt2(custo):"—", venda>0?fmt2(venda):"—", (venda>0&&custo>0)?fmt2(lucro):"—", (venda>0&&custo>0)?margem.toFixed(1)+"%":"—"];
      });
      return { titulo:"Visão Financeira do Estoque", headers:headers5, rows:rows5 };
    }
    return null;
  }, [relAtivo, produtos, fornecedores, movsFiltradas, filtroProd]);

  return (
    <div>
      <div style={{ fontWeight:800,fontSize:18,color:"#0f172a",marginBottom:4 }}>📊 Relatórios de Estoque</div>
      <div style={{ fontSize:13,color:"#94a3b8",marginBottom:10 }}>Análises e relatórios completos do seu estoque</div>

      {/* Lista de relatórios disponíveis */}
      <div style={{ display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(300px,1fr))",gap:12,marginBottom:10 }}>
        {RELATORIOS.map(function(r){
          var isAtivo=relAtivo===r.key;
          return (
            <div key={r.key} onClick={function(){gerarRelatorio(r.key);}}
              style={{ background:isAtivo?"#0f172a":"#fff", border:isAtivo?"2px solid #0f172a":"1px solid #e2e8f0", borderRadius:12, padding:"16px 18px", cursor:"pointer", transition:"all .15s" }}
              onMouseEnter={function(e){if(!isAtivo){e.currentTarget.style.borderColor="#0f172a";e.currentTarget.style.background="#f8fafc";}}}
              onMouseLeave={function(e){if(!isAtivo){e.currentTarget.style.borderColor="#e2e8f0";e.currentTarget.style.background="#fff";}}}>
              <div style={{ display:"flex",alignItems:"flex-start",gap:10 }}>
                <div style={{ width:36,height:36,borderRadius:8,background:isAtivo?"rgba(255,255,255,.15)":"#f1f5f9",display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,flexShrink:0 }}>📋</div>
                <div>
                  <div style={{ fontWeight:700,fontSize:14,color:isAtivo?"#fff":"#0f172a",marginBottom:4 }}>{r.titulo}</div>
                  <div style={{ fontSize:12,color:isAtivo?"rgba(255,255,255,.7)":"#94a3b8",lineHeight:1.4 }}>{r.desc}</div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Filtros para o relatório */}
      {relAtivo && (
        <div style={{ background:"#f8fafc",border:"1px solid #e2e8f0",borderRadius:10,padding:"12px 16px",marginBottom:8 }}>
          <div style={{ display:"flex",gap:8,alignItems:"center",flexWrap:"wrap" }}>
            <span style={{ fontSize:12,color:"#64748b",fontWeight:600 }}>Período:</span>
            <input type="date" value={filtroDe} onChange={function(e){setFiltroDe(e.target.value);}}
              style={{ background:"#fff",border:"1px solid #e2e8f0",color:"#334155",padding:"6px 10px",borderRadius:8,fontSize:12 }} />
            <span style={{ fontSize:12,color:"#94a3b8" }}>até</span>
            <input type="date" value={filtroAte} onChange={function(e){setFiltroAte(e.target.value);}}
              style={{ background:"#fff",border:"1px solid #e2e8f0",color:"#334155",padding:"6px 10px",borderRadius:8,fontSize:12 }} />
            <input value={filtroProd} onChange={function(e){setFiltroProd(e.target.value);}} placeholder="Filtrar produto..."
              style={{ background:"#fff",border:"1px solid #e2e8f0",color:"#0f172a",padding:"6px 10px",borderRadius:8,fontSize:12,outline:"none",width:160 }} />
            {(filtroDe||filtroAte||filtroProd)&&<button onClick={function(){setFiltroDe("");setFiltroAte("");setFiltroProd("");}} style={{ background:"#f1f5f9",border:"1px solid #e2e8f0",color:"#64748b",padding:"5px 10px",borderRadius:8,cursor:"pointer",fontSize:12 }}>✕ Limpar</button>}
            {dadosExport && (
              <div style={{ marginLeft:"auto" }}>
                <BotaoExportar
                  onCSV={function(){ exportarCSV(dadosExport.titulo, dadosExport.headers, dadosExport.rows); }}
                  onXLS={function(){ exportarXLS(dadosExport.titulo, dadosExport.headers, dadosExport.rows); }}
                  onPDF={function(){ exportarPDF(dadosExport.titulo, dadosExport.titulo, dadosExport.headers, dadosExport.rows); }}
                />
              </div>
            )}
          </div>
        </div>
      )}

      {/* Conteúdo do relatório */}
      {relAtivo === "entradas_saidas" && (
        <div style={{ background:"#fff",border:"1px solid #e2e8f0",borderRadius:12,overflow:"auto" }}>
          <div style={{ padding:"10px 14px",borderBottom:"1px solid #f1f5f9",display:"flex",justifyContent:"space-between",alignItems:"center" }}>
            <div style={{ fontWeight:700,fontSize:15,color:"#0f172a" }}>Entradas e Saídas de Estoque</div>
            <div style={{ fontSize:12,color:"#94a3b8" }}>{movsFiltradas.length} movimentações</div>
          </div>
          {movsFiltradas.length===0?(<div style={{ padding:32,textAlign:"center",color:"#94a3b8" }}>Nenhuma movimentação no período</div>):(
            <table style={{ borderCollapse:"collapse",width:"100%" }}>
              <thead><tr>{["Data","Produto","SKU","Tipo","Qtd","Motivo","Preço un."].map(function(h){return <th key={h} style={{ fontSize:11,color:"#94a3b8",textTransform:"uppercase",padding:"9px 14px",borderBottom:"1px solid #f1f5f9",textAlign:"left",fontWeight:600,background:"#fafafa",whiteSpace:"nowrap" }}>{h}</th>;})}</tr></thead>
              <tbody>
                {movsFiltradas.sort(function(a,b){return (b.id||0)-(a.id||0);}).slice(0,500).map(function(m,i){
                  var prod=produtos.find(function(p){return p.id===m.produtoId;});
                  var isE=m.tipo==="entrada";
                  return (
                    <tr key={m.id} style={{ background:i%2===0?"#f8fafc":"#fff" }}>
                      <td style={{ padding:"8px 14px",fontSize:12,color:"#64748b",whiteSpace:"nowrap" }}>{fmtDate(m.data)}<div style={{ fontSize:10,color:"#94a3b8" }}>{m.hora}</div></td>
                      <td style={{ padding:"8px 14px",fontSize:12,color:"#0f172a",maxWidth:200,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>{prod?.titulo||"—"}</td>
                      <td style={{ padding:"8px 14px",fontSize:11,color:"#64748b",fontFamily:"monospace" }}>{prod?.sku||"—"}</td>
                      <td style={{ padding:"8px 14px" }}><span style={{ fontSize:11,fontWeight:700,color:isE?"#15803d":"#dc2626",background:isE?"#f0fdf4":"#fef2f2",padding:"2px 8px",borderRadius:6 }}>{isE?"↑ Entrada":"↓ Saída"}</span></td>
                      <td style={{ padding:"8px 14px",fontSize:14,fontWeight:800,color:isE?"#15803d":"#dc2626",textAlign:"center" }}>{isE?"+":"-"}{m.qtd}</td>
                      <td style={{ padding:"8px 14px",fontSize:12,color:"#64748b" }}>{m.motivo||"—"}</td>
                      <td style={{ padding:"8px 14px",fontSize:12,color:"#64748b" }}>{m.preco?fmt2(m.preco):"—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}

      {relAtivo === "saldo_atual" && (
        <div style={{ background:"#fff",border:"1px solid #e2e8f0",borderRadius:12,overflow:"auto" }}>
          <div style={{ padding:"10px 14px",borderBottom:"1px solid #f1f5f9",display:"flex",justifyContent:"space-between",alignItems:"center" }}>
            <div style={{ fontWeight:700,fontSize:15,color:"#0f172a" }}>Saldo Atual de Estoque</div>
            <div style={{ display:"flex",gap:16 }}>
              <div style={{ textAlign:"right" }}>
                <div style={{ fontSize:10,color:"#94a3b8" }}>Valor Total (Custo)</div>
                <div style={{ fontSize:14,fontWeight:800,color:"#0f172a" }}>{fmt2(produtos.reduce(function(s,p){return s+(parseFloat(p.precoCusto||0)*parseInt(p.estoqueAtual||0));},0))}</div>
              </div>
              <div style={{ textAlign:"right" }}>
                <div style={{ fontSize:10,color:"#94a3b8" }}>Valor Total (Venda)</div>
                <div style={{ fontSize:14,fontWeight:800,color:"#15803d" }}>{fmt2(produtos.reduce(function(s,p){return s+(parseFloat(p.precoVenda||0)*parseInt(p.estoqueAtual||0));},0))}</div>
              </div>
            </div>
          </div>
          <table style={{ borderCollapse:"collapse",width:"100%" }}>
            <thead><tr>{["Produto","SKU","Categoria","Estoque","Mín","Vlr Custo","Vlr Venda","Total Custo","Total Venda","Status"].map(function(h){return <th key={h} style={{ fontSize:10,color:"#94a3b8",textTransform:"uppercase",padding:"5px 8px",borderBottom:"1px solid #f1f5f9",textAlign:"left",fontWeight:600,background:"#fafafa",whiteSpace:"nowrap" }}>{h}</th>;})}</tr></thead>
            <tbody>
              {produtos.filter(function(p){return !filtroProd||(p.titulo||"").toLowerCase().includes(filtroProd.toLowerCase())||(p.sku||"").toLowerCase().includes(filtroProd.toLowerCase());}).map(function(p,i){
                var est=parseInt(p.estoqueAtual||0),min=parseInt(p.estoqueMinimo||0);
                var critico=min>0&&est<=min, zerado=est<=0;
                var cor=zerado?"#dc2626":critico?"#d97706":"#15803d";
                return (
                  <tr key={p.id} style={{ background:i%2===0?"#f8fafc":"#fff" }}>
                    <td style={{ padding:"5px 8px",fontSize:12,color:"#0f172a",maxWidth:200,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>{p.titulo}</td>
                    <td style={{ padding:"5px 8px",fontSize:11,color:"#64748b",fontFamily:"monospace" }}>
                      {p.sku||"—"}
                      {p.tipoProduto==="composto" && <span style={{ marginLeft:5,fontSize:9,fontWeight:700,background:"#ede9fe",color:"#7c3aed",padding:"1px 5px",borderRadius:4 }}>KIT</span>}
                    </td>
                    <td style={{ padding:"5px 8px",fontSize:12,color:"#64748b" }}>{p.categoria||"—"}</td>
                    <td style={{ padding:"5px 8px",textAlign:"center",fontWeight:800,fontSize:13,color:cor }}>{est}</td>
                    <td style={{ padding:"5px 8px",textAlign:"center",fontSize:12,color:"#94a3b8" }}>{min||"—"}</td>
                    <td style={{ padding:"5px 8px",fontSize:12,color:"#64748b" }}>{p.precoCusto?fmt2(p.precoCusto):"—"}</td>
                    <td style={{ padding:"5px 8px",fontSize:12,color:"#64748b" }}>{p.precoVenda?fmt2(p.precoVenda):"—"}</td>
                    <td style={{ padding:"5px 8px",fontSize:12,fontWeight:700,color:"#0f172a" }}>{p.precoCusto?fmt2(parseFloat(p.precoCusto)*est):"—"}</td>
                    <td style={{ padding:"5px 8px",fontSize:12,fontWeight:700,color:"#15803d" }}>{p.precoVenda?fmt2(parseFloat(p.precoVenda)*est):"—"}</td>
                    <td style={{ padding:"5px 8px" }}><span style={{ fontSize:10,fontWeight:600,color:cor,background:cor+"11",padding:"2px 7px",borderRadius:5 }}>{zerado?"Zerado":critico?"Crítico":"OK"}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {relAtivo === "abaixo_minimo" && (
        <div style={{ background:"#fff",border:"1px solid #e2e8f0",borderRadius:12,overflow:"auto" }}>
          <div style={{ padding:"10px 14px",borderBottom:"1px solid #f1f5f9",fontWeight:700,fontSize:15,color:"#dc2626" }}>⚠️ Produtos Abaixo do Estoque Mínimo</div>
          <table style={{ borderCollapse:"collapse",width:"100%" }}>
            <thead><tr>{["Produto","SKU","Fornecedor","Estoque Atual","Estoque Mínimo","Diferença","Custo Unit.","Custo Reposição"].map(function(h){return <th key={h} style={{ fontSize:10,color:"#94a3b8",textTransform:"uppercase",padding:"5px 8px",borderBottom:"1px solid #f1f5f9",textAlign:"left",fontWeight:600,background:"#fafafa",whiteSpace:"nowrap" }}>{h}</th>;})}</tr></thead>
            <tbody>
              {produtos.filter(function(p){return p.estoqueMinimo&&parseInt(p.estoqueAtual||0)<=parseInt(p.estoqueMinimo||0);}).map(function(p,i){
                var est=parseInt(p.estoqueAtual||0),min=parseInt(p.estoqueMinimo||0),diff=min-est;
                var forn=fornecedores.find(function(f){return f.id===p.fornecedorId;});
                return (
                  <tr key={p.id} style={{ background:i%2===0?"#fff9f9":"#fff" }}>
                    <td style={{ padding:"5px 8px",fontSize:12,color:"#0f172a",maxWidth:200,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>{p.titulo}</td>
                    <td style={{ padding:"5px 8px",fontSize:11,color:"#64748b",fontFamily:"monospace" }}>{p.sku||"—"}</td>
                    <td style={{ padding:"5px 8px",fontSize:12,color:"#64748b" }}>{forn?.nome||"—"}</td>
                    <td style={{ padding:"5px 8px",textAlign:"center",fontWeight:800,fontSize:13,color:est<=0?"#dc2626":"#d97706" }}>{est}</td>
                    <td style={{ padding:"5px 8px",textAlign:"center",fontSize:12,color:"#94a3b8" }}>{min}</td>
                    <td style={{ padding:"5px 8px",textAlign:"center",fontWeight:800,fontSize:13,color:"#dc2626" }}>-{diff}</td>
                    <td style={{ padding:"5px 8px",fontSize:12,color:"#64748b" }}>{p.precoCusto?fmt2(p.precoCusto):"—"}</td>
                    <td style={{ padding:"5px 8px",fontSize:12,fontWeight:700,color:"#dc2626" }}>{p.precoCusto?fmt2(parseFloat(p.precoCusto)*diff):"—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {relAtivo === "visao_financeira" && (
        <div style={{ background:"#fff",border:"1px solid #e2e8f0",borderRadius:12,overflow:"auto" }}>
          <div style={{ padding:"10px 14px",borderBottom:"1px solid #f1f5f9",fontWeight:700,fontSize:15,color:"#0f172a" }}>💰 Visão Financeira do Estoque</div>
          {(function(){
            var totalCusto=0,totalVenda=0,totalLucro=0;
            var rows=produtos.filter(function(p){return parseInt(p.estoqueAtual||0)>0;}).map(function(p){
              var est=parseInt(p.estoqueAtual||0);
              var custo=parseFloat(p.precoCusto||0)*est;
              var venda=parseFloat(p.precoVenda||0)*est;
              var lucro=venda-custo;
              var margem=venda>0?(lucro/venda)*100:0;
              totalCusto+=custo;totalVenda+=venda;totalLucro+=lucro;
              return {p,est,custo,venda,lucro,margem};
            }).sort(function(a,b){return b.custo-a.custo;});
            return (
              <>
                <div style={{ display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:12,padding:"10px 14px",borderBottom:"1px solid #f1f5f9" }}>
                  {[{l:"Valor de Custo",v:fmt2(totalCusto),c:"#dc2626"},{l:"Valor de Venda",v:fmt2(totalVenda),c:"#15803d"},{l:"Lucro Potencial",v:fmt2(totalLucro),c:totalLucro>=0?"#0891b2":"#dc2626"}].map(function(k){
                    return <div key={k.l} style={{ background:"#f8fafc",borderRadius:10,padding:"12px 16px" }}><div style={{ fontSize:11,color:"#94a3b8",marginBottom:4 }}>{k.l}</div><div style={{ fontSize:18,fontWeight:800,color:k.c }}>{k.v}</div></div>;
                  })}
                </div>
                <table style={{ borderCollapse:"collapse",width:"100%" }}>
                  <thead><tr>{["Produto","SKU","Estoque","Custo Unit.","Venda Unit.","Total Custo","Total Venda","Lucro","Margem"].map(function(h){return <th key={h} style={{ fontSize:10,color:"#94a3b8",textTransform:"uppercase",padding:"5px 8px",borderBottom:"1px solid #f1f5f9",textAlign:"left",fontWeight:600,background:"#fafafa",whiteSpace:"nowrap" }}>{h}</th>;})}</tr></thead>
                  <tbody>
                    {rows.map(function(r,i){
                      return <tr key={r.p.id} style={{ background:i%2===0?"#f8fafc":"#fff" }}>
                        <td style={{ padding:"7px 12px",fontSize:12,color:"#0f172a",maxWidth:180,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>{r.p.titulo}</td>
                        <td style={{ padding:"7px 12px",fontSize:11,color:"#64748b",fontFamily:"monospace" }}>{r.p.sku||"—"}</td>
                        <td style={{ padding:"7px 12px",textAlign:"center",fontWeight:700 }}>{r.est}</td>
                        <td style={{ padding:"7px 12px",fontSize:12,color:"#64748b" }}>{r.p.precoCusto?fmt2(r.p.precoCusto):"—"}</td>
                        <td style={{ padding:"7px 12px",fontSize:12,color:"#64748b" }}>{r.p.precoVenda?fmt2(r.p.precoVenda):"—"}</td>
                        <td style={{ padding:"7px 12px",fontSize:12,fontWeight:700,color:"#dc2626" }}>{r.custo>0?fmt2(r.custo):"—"}</td>
                        <td style={{ padding:"7px 12px",fontSize:12,fontWeight:700,color:"#15803d" }}>{r.venda>0?fmt2(r.venda):"—"}</td>
                        <td style={{ padding:"7px 12px",fontSize:12,fontWeight:700,color:r.lucro>=0?"#0891b2":"#dc2626" }}>{r.venda>0&&r.custo>0?fmt2(r.lucro):"—"}</td>
                        <td style={{ padding:"7px 12px",fontSize:12,fontWeight:700,color:r.margem>=25?"#15803d":r.margem>=15?"#d97706":"#dc2626" }}>{r.venda>0&&r.custo>0?r.margem.toFixed(1)+"%":"—"}</td>
                      </tr>;
                    })}
                  </tbody>
                </table>
              </>
            );
          })()}
        </div>
      )}

      {(relAtivo==="sem_movimentacao"||relAtivo==="maior_circulacao") && (function(){
        var movsProd={};
        movsFiltradas.forEach(function(m){ movsProd[m.produtoId]=(movsProd[m.produtoId]||0)+m.qtd; });
        var prods=relAtivo==="sem_movimentacao"
          ? produtos.filter(function(p){return !movsProd[p.id];})
          : produtos.filter(function(p){return movsProd[p.id]>0;}).sort(function(a,b){return (movsProd[b.id]||0)-(movsProd[a.id]||0);}).slice(0,50);
        return (
          <div style={{ background:"#fff",border:"1px solid #e2e8f0",borderRadius:12,overflow:"auto" }}>
            <div style={{ padding:"10px 14px",borderBottom:"1px solid #f1f5f9",fontWeight:700,fontSize:15,color:"#0f172a" }}>
              {relAtivo==="sem_movimentacao"?"📦 Produtos sem Movimentação":"🏆 Produtos com Maior Circulação"}
              <span style={{ marginLeft:10,fontSize:12,color:"#94a3b8",fontWeight:400 }}>{prods.length} produtos</span>
            </div>
            {prods.length===0?<div style={{ padding:32,textAlign:"center",color:"#94a3b8" }}>Nenhum produto encontrado</div>:(
              <table style={{ borderCollapse:"collapse",width:"100%" }}>
                <thead><tr>{["#","Produto","SKU","Estoque Atual","Movimentação Total","Custo Unit."].map(function(h){return <th key={h} style={{ fontSize:10,color:"#94a3b8",textTransform:"uppercase",padding:"5px 8px",borderBottom:"1px solid #f1f5f9",textAlign:"left",fontWeight:600,background:"#fafafa" }}>{h}</th>;})}</tr></thead>
                <tbody>
                  {prods.map(function(p,i){return (
                    <tr key={p.id} style={{ background:i%2===0?"#f8fafc":"#fff" }}>
                      <td style={{ padding:"5px 8px",fontSize:13,fontWeight:700,color:"#94a3b8" }}>{i+1}</td>
                      <td style={{ padding:"5px 8px",fontSize:12,color:"#0f172a",maxWidth:200,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>{p.titulo}</td>
                      <td style={{ padding:"5px 8px",fontSize:11,color:"#64748b",fontFamily:"monospace" }}>{p.sku||"—"}</td>
                      <td style={{ padding:"5px 8px",textAlign:"center",fontWeight:700 }}>{p.estoqueAtual||0}</td>
                      <td style={{ padding:"5px 8px",textAlign:"center",fontWeight:800,color:relAtivo==="maior_circulacao"?"#0891b2":"#94a3b8" }}>{movsProd[p.id]||0}</td>
                      <td style={{ padding:"5px 8px",fontSize:12,color:"#64748b" }}>{p.precoCusto?fmt2(p.precoCusto):"—"}</td>
                    </tr>
                  );}).slice(0,100)}
                </tbody>
              </table>
            )}
          </div>
        );
      })()}
    </div>
  );
}

// ════════════════════════════════════════════════════════════
//  SUGESTÃO DE COMPRAS
// ════════════════════════════════════════════════════════════
function SugestaoComprasTab({ produtos, fornecedores, rawOrders, exportarCSV, exportarXLS, exportarPDF, BotaoExportar, fmtDate }) {
  const [periodoVenda, setPeriodoVenda] = useState(30);
  const [coberturaEstoque, setCoberturaEstoque] = useState(30);
  const [filterForn, setFilterForn] = useState("all");
  const [search, setSearch] = useState("");
  const [gerado, setGerado] = useState(false);

  var fmt2=function(n){return "R$ "+Number(n||0).toFixed(2).replace(".",",");};
  var hoje=new Date().toLocaleDateString("sv-SE");
  var deDate=new Date(); deDate.setDate(deDate.getDate()-parseInt(periodoVenda));
  var deStr=deDate.toLocaleDateString("sv-SE");

  // Calcular vendas por produto no período
  var vendasPorProd={};
  (rawOrders||[]).filter(function(o){return o.status==="paid"&&o.date>=deStr;}).forEach(function(o){
    if(!o.listing_id)return;
    vendasPorProd[o.listing_id]=(vendasPorProd[o.listing_id]||0)+(o.qty||1);
  });

  // Montar sugestões
  var sugestoes=produtos.filter(function(p){
    if(filterForn!=="all"&&p.fornecedorId!==filterForn)return false;
    if(search){var q=search.toLowerCase();return (p.titulo||"").toLowerCase().includes(q)||(p.sku||"").toLowerCase().includes(q);}
    return true;
  }).map(function(p){
    var mlb=p.mlbVinculado||(p.mlbsVinculados||[])[0]||"";
    var vendas=vendasPorProd[mlb]||0;
    var mediaDia=vendas/parseInt(periodoVenda);
    var estAtual=parseInt(p.estoqueAtual||0);
    var diasEstoque=mediaDia>0?Math.floor(estAtual/mediaDia):999;
    var sugestaoQtd=Math.max(0,Math.ceil(mediaDia*parseInt(coberturaEstoque))-estAtual);
    var valorEst=sugestaoQtd*parseFloat(p.precoCusto||0);
    return {p,vendas,mediaDia,estAtual,diasEstoque,sugestaoQtd,valorEst};
  }).filter(function(s){return s.sugestaoQtd>0||s.vendas>0;}).sort(function(a,b){return b.sugestaoQtd-a.sugestaoQtd;});

  var totalSugestao=sugestoes.reduce(function(s,x){return s+x.sugestaoQtd;},0);
  var totalValor=sugestoes.reduce(function(s,x){return s+x.valorEst;},0);

  return (
    <div>
      <div style={{ fontWeight:800,fontSize:18,color:"#0f172a",marginBottom:4 }}>💡 Sugestão de Compras</div>
      <div style={{ fontSize:13,color:"#94a3b8",marginBottom:10 }}>Baseado no histórico de vendas e estoque atual</div>

      {/* Parâmetros */}
      <div style={{ background:"#fff",border:"1px solid #e2e8f0",borderRadius:12,padding:"16px 20px",marginBottom:10 }}>
        <div style={{ fontWeight:700,fontSize:14,color:"#0f172a",marginBottom:8 }}>⚙️ Parâmetros de Cálculo</div>
        <div style={{ display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(200px,1fr))",gap:16 }}>
          <div>
            <div style={{ fontSize:11,color:"#94a3b8",marginBottom:5,fontWeight:600,textTransform:"uppercase" }}>Período de Venda (dias)</div>
            <input type="number" min="7" max="365" value={periodoVenda} onChange={function(e){setPeriodoVenda(e.target.value);setGerado(false);}}
              style={{ width:"100%",background:"#f8fafc",border:"1px solid #e2e8f0",color:"#0f172a",padding:"9px 12px",borderRadius:8,fontSize:13,outline:"none" }} />
            <div style={{ fontSize:11,color:"#94a3b8",marginTop:4 }}>Analisar vendas dos últimos {periodoVenda} dias</div>
          </div>
          <div>
            <div style={{ fontSize:11,color:"#94a3b8",marginBottom:5,fontWeight:600,textTransform:"uppercase" }}>Cobertura de Estoque (dias)</div>
            <input type="number" min="7" max="365" value={coberturaEstoque} onChange={function(e){setCoberturaEstoque(e.target.value);setGerado(false);}}
              style={{ width:"100%",background:"#f8fafc",border:"1px solid #e2e8f0",color:"#0f172a",padding:"9px 12px",borderRadius:8,fontSize:13,outline:"none" }} />
            <div style={{ fontSize:11,color:"#94a3b8",marginTop:4 }}>Quantidade para cobrir {coberturaEstoque} dias de vendas</div>
          </div>
          <div>
            <div style={{ fontSize:11,color:"#94a3b8",marginBottom:5,fontWeight:600,textTransform:"uppercase" }}>Filtrar Fornecedor</div>
            <select value={filterForn} onChange={function(e){setFilterForn(e.target.value);setGerado(false);}}
              style={{ width:"100%",background:"#f8fafc",border:"1px solid #e2e8f0",color:"#334155",padding:"9px 12px",borderRadius:8,fontSize:13 }}>
              <option value="all">Todos os fornecedores</option>
              {fornecedores.map(function(f){return <option key={f.id} value={f.id}>{f.nome}</option>;})}
            </select>
          </div>
          <div>
            <div style={{ fontSize:11,color:"#94a3b8",marginBottom:5,fontWeight:600,textTransform:"uppercase" }}>Buscar Produto</div>
            <input value={search} onChange={function(e){setSearch(e.target.value);}} placeholder="Nome ou SKU..."
              style={{ width:"100%",background:"#f8fafc",border:"1px solid #e2e8f0",color:"#0f172a",padding:"9px 12px",borderRadius:8,fontSize:13,outline:"none" }} />
          </div>
        </div>
        <button onClick={function(){setGerado(true);}}
          style={{ marginTop:14,background:"#0f172a",border:"none",color:"#fff",fontWeight:700,padding:"11px 28px",borderRadius:10,cursor:"pointer",fontSize:13 }}>
          🔍 Gerar Sugestão de Compras
        </button>
      </div>

      {/* Resultado */}
      {gerado && (
        <>
          {/* Cards resumo */}
          <div style={{ display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(150px,1fr))",gap:7,marginBottom:8 }}>
            {[
              {l:"Produtos p/ Comprar",v:sugestoes.filter(function(s){return s.sugestaoQtd>0;}).length,c:"#0f172a"},
              {l:"Total de Unidades",v:totalSugestao,c:"#0891b2"},
              {l:"Valor Estimado",v:fmt2(totalValor),c:"#dc2626"},
              {l:"Sem Estoque",v:sugestoes.filter(function(s){return s.estAtual<=0;}).length,c:"#dc2626"},
              {l:"Período Analisado",v:periodoVenda+" dias",c:"#64748b"},
            ].map(function(k){return <div key={k.l} style={{ background:"#fff",border:"1px solid #e2e8f0",borderRadius:12,padding:"12px 16px" }}><div style={{ fontSize:10,color:"#94a3b8",fontWeight:600,textTransform:"uppercase",marginBottom:4 }}>{k.l}</div><div style={{ fontSize:18,fontWeight:800,color:k.c }}>{k.v}</div></div>;})}
          </div>

          {sugestoes.length===0?(
            <div style={{ background:"#f0fdf4",border:"1px solid #bbf7d0",borderRadius:12,padding:40,textAlign:"center",color:"#15803d" }}>
              <div style={{ fontSize:32,marginBottom:8 }}>✅</div>
              <div style={{ fontWeight:700,fontSize:15 }}>Nenhuma sugestão de compra necessária</div>
              <div style={{ fontSize:13,marginTop:4 }}>Seu estoque está adequado para o período de cobertura definido</div>
            </div>
          ):(
            <div style={{ background:"#fff",border:"1px solid #e2e8f0",borderRadius:12,overflow:"auto" }}>
              <div style={{ padding:"10px 14px",borderBottom:"1px solid #f1f5f9",display:"flex",justifyContent:"space-between",alignItems:"center" }}>
                <div>
                  <div style={{ fontWeight:700,fontSize:15,color:"#0f172a" }}>Dashboard Sugestão de Compras</div>
                  <div style={{ fontSize:12,color:"#94a3b8" }}>Período: últimos {periodoVenda} dias · Cobertura: {coberturaEstoque} dias</div>
                </div>
                <BotaoExportar
                  onCSV={function(){
                    var cab=["SKU","Produto","Fornecedor","Vendas","Estoque Atual","Média/Dia","Dias p/ Esgotar","Sugestão Compra","Valor Estimado"];
                    var linhas=sugestoes.map(function(s){var forn=fornecedores.find(function(f){return f.id===s.p.fornecedorId;}); return [s.p.sku||"",s.p.titulo||"",forn?.nome||"",s.vendas,s.estAtual,s.mediaDia.toFixed(2),s.diasEstoque>=999?"∞":s.diasEstoque,s.sugestaoQtd>0?s.sugestaoQtd:"",s.valorEst>0?"R$ "+s.valorEst.toFixed(2).replace(".",","):""];});
                    exportarCSV("sugestao_de_compras",cab,linhas);
                  }}
                  onXLS={function(){
                    var cab=["SKU","Produto","Fornecedor","Vendas","Estoque Atual","Média/Dia","Dias p/ Esgotar","Sugestão Compra","Valor Estimado"];
                    var linhas=sugestoes.map(function(s){var forn=fornecedores.find(function(f){return f.id===s.p.fornecedorId;}); return [s.p.sku||"",s.p.titulo||"",forn?.nome||"",s.vendas,s.estAtual,s.mediaDia.toFixed(2),s.diasEstoque>=999?"∞":s.diasEstoque,s.sugestaoQtd>0?s.sugestaoQtd:"",s.valorEst>0?"R$ "+s.valorEst.toFixed(2).replace(".",","):""];});
                    exportarXLS("sugestao_de_compras",cab,linhas);
                  }}
                  onPDF={function(){
                    var cab=["SKU","Produto","Vendas","Estoque","Dias","Sugestão","Valor"];
                    var linhas=sugestoes.map(function(s){return [s.p.sku||"",s.p.titulo?.slice(0,40)||"",s.vendas,s.estAtual,s.diasEstoque>=999?"∞":s.diasEstoque,s.sugestaoQtd>0?s.sugestaoQtd:"—",s.valorEst>0?"R$ "+s.valorEst.toFixed(2).replace(".",","):"—"];});
                    exportarPDF("sugestao_de_compras","Sugestão de Compras",cab,linhas,["Produtos: "+sugestoes.length,"Total unidades: "+totalSugestao,"Valor: R$ "+totalValor.toFixed(2).replace(".",",")]);
                  }}
                />
              </div>
              <table style={{ borderCollapse:"collapse",width:"100%" }}>
                <thead>
                  <tr>{["SKU","Produto","Fornecedor","Peças Vendidas","Estoque Atual","Média/Dia","Dias p/ Esgotar","Sugestão de Compra","Valor Estimado"].map(function(h){
                    return <th key={h} style={{ fontSize:10,color:"#94a3b8",textTransform:"uppercase",padding:"9px 12px",borderBottom:"1px solid #f1f5f9",textAlign:"left",fontWeight:600,background:"#fafafa",whiteSpace:"nowrap" }}>{h}</th>;
                  })}</tr>
                </thead>
                <tbody>
                  {sugestoes.map(function(s,i){
                    var forn=fornecedores.find(function(f){return f.id===s.p.fornecedorId;});
                    var urgente=s.diasEstoque<7,atencao=s.diasEstoque<15;
                    return (
                      <tr key={s.p.id} style={{ background:urgente?"#fff9f9":i%2===0?"#f8fafc":"#fff" }}>
                        <td style={{ padding:"5px 8px",fontSize:11,color:"#64748b",fontFamily:"monospace" }}>{s.p.sku||"—"}</td>
                        <td style={{ padding:"5px 8px",fontSize:12,color:"#0f172a",maxWidth:200,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>{s.p.titulo}</td>
                        <td style={{ padding:"5px 8px",fontSize:12,color:"#64748b" }}>{forn?.nome||"—"}</td>
                        <td style={{ padding:"5px 8px",textAlign:"center",fontWeight:700,fontSize:13,color:"#0891b2" }}>{s.vendas}</td>
                        <td style={{ padding:"5px 8px",textAlign:"center",fontWeight:800,fontSize:13,color:s.estAtual<=0?"#dc2626":atencao?"#d97706":"#15803d" }}>{s.estAtual}</td>
                        <td style={{ padding:"5px 8px",textAlign:"center",fontSize:12,color:"#64748b" }}>{s.mediaDia.toFixed(1)}</td>
                        <td style={{ padding:"5px 8px",textAlign:"center" }}>
                          <span style={{ fontSize:12,fontWeight:700,color:urgente?"#dc2626":atencao?"#d97706":"#0f172a",background:urgente?"#fef2f2":atencao?"#fffbeb":"#f8fafc",padding:"3px 8px",borderRadius:6 }}>
                            {s.diasEstoque>=999?"∞":s.diasEstoque+" dias"}
                          </span>
                        </td>
                        <td style={{ padding:"5px 8px",textAlign:"center",fontWeight:800,fontSize:14,color:s.sugestaoQtd>0?"#dc2626":"#94a3b8" }}>{s.sugestaoQtd>0?s.sugestaoQtd:"—"}</td>
                        <td style={{ padding:"5px 8px",fontSize:12,fontWeight:700,color:"#0f172a" }}>{s.valorEst>0?fmt2(s.valorEst):"—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr style={{ background:"#f1f5f9" }}>
                    <td colSpan={7} style={{ padding:"10px 12px",fontWeight:700,fontSize:13 }}>TOTAL</td>
                    <td style={{ padding:"10px 12px",textAlign:"center",fontWeight:800,fontSize:14,color:"#dc2626" }}>{totalSugestao}</td>
                    <td style={{ padding:"10px 12px",fontWeight:800,color:"#0f172a" }}>{fmt2(totalValor)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── ProdutosTab Principal ────────────────────────────────────
function ProdutosTab({ produtos, setProdutos, fornecedores, setFornecedores, listings, costs, setCosts, rawOrders }) {
  const [prodTab, setProdTab] = useState("lista"); // lista | depositos | estoque | cadastros | pedidos | relatorios | sugestao
  const [viewProdutos, setViewProdutos] = useState("tabela"); // tabela | cards
  const [filterEstoque, setFilterEstoque] = useState("todos"); // todos | critico | zerado | ok
  const [filterMarca, setFilterMarca] = useState("");
  const [filterFornecedorProd, setFilterFornecedorProd] = useState("all");
  const [depositos, setDepositos] = useState(function(){ try { return JSON.parse(localStorage.getItem("depositos_estoque")||"[]"); } catch { return []; } });
  const [estoqueDepositos, setEstoqueDepositos] = useState(function(){ try { return JSON.parse(localStorage.getItem("estoque_depositos")||"[]"); } catch { return []; } });
  const [showModalDeposito, setShowModalDeposito] = useState(false);
  const [editingDeposito, setEditingDeposito] = useState(null);
  const [showTransfEstoque, setShowTransfEstoque] = useState(null);
  const [searchEstoque, setSearchEstoque] = useState("");
  const [filterDepositoEst, setFilterDepositoEst] = useState("todos");
  const [showModalProd, setShowModalProd] = useState(false);
  const [showModalForn, setShowModalForn] = useState(false);
  const [editingProd, setEditingProd] = useState(null);
  const [editingForn, setEditingForn] = useState(null);
  const [prodSel, setProdSel] = useState([]);
  const [showMovEstoque, setShowMovEstoque] = useState(null); // produto para ver movimentação
  const [movEstoque, setMovEstoque] = useState(function(){ try { return JSON.parse(localStorage.getItem("mov_estoque")||"[]"); } catch(e){ return []; } });
  // Recarrega movimentações sempre que a aba "estoque" (Movimentações) é aberta —
  // garante refletir entradas geradas por NF Entrada, vendas, etc.
  useEffect(function(){
    if (prodTab !== "estoque") return;
    try {
      var fresh = JSON.parse(localStorage.getItem("mov_estoque")||"[]");
      setMovEstoque(fresh);
    } catch(e) {}
  }, [prodTab]);
  const [importMsg, setImportMsg] = useState(null); // {tipo:"ok"|"erro", texto:"..."}
  const [paginaProdutos, setPaginaProdutos] = useState(1);
  const POR_PAG_PROD = 50;
  const [search, setSearch] = useState("");
  const [searchSkuExato, setSearchSkuExato] = useState(false);
  const [filterCat, setFilterCat] = useState("all");
  const [filterStatus, setFilterStatus] = useState("all");
  const [filtroTipo, setFiltroTipo] = useState("todos");
  const [searchCad, setSearchCad] = useState("");
  const [tipoPadraoCad, setTipoPadraoCad] = useState("Fornecedor");

  function saveMovEstoque2(movs) {
    setMovEstoque(movs);
    localStorage.setItem("mov_estoque", JSON.stringify(movs));
  }

  function salvarDeposito(dep) {
    var lista = depositos.find(function(d){return d.id===dep.id;})
      ? depositos.map(function(d){return d.id===dep.id?dep:d;})
      : [...depositos, dep];
    setDepositos(lista); saveDepositos(lista);
  }
  function excluirDeposito(id) {
    if (!window.confirm("Excluir este depósito? O estoque vinculado será removido.")) return;
    var lista = depositos.filter(function(d){return d.id!==id;});
    var estoqueAtualizado = estoqueDepositos.filter(function(e){return e.depositoId!==id;});
    setDepositos(lista); saveDepositos(lista);
    setEstoqueDepositos(estoqueAtualizado); saveEstoqueDepositos(estoqueAtualizado);
  }
  function transferirEstoque(produtoId, origemId, destinoId, qtd) {
    var novoEst = estoqueDepositos.slice();
    var idxO = novoEst.findIndex(function(e){return e.produtoId===produtoId&&e.depositoId===origemId;});
    if (idxO>=0) novoEst[idxO]=Object.assign({},novoEst[idxO],{qtd:Math.max(0,parseInt(novoEst[idxO].qtd||0)-qtd)});
    var idxD = novoEst.findIndex(function(e){return e.produtoId===produtoId&&e.depositoId===destinoId;});
    if (idxD>=0) novoEst[idxD]=Object.assign({},novoEst[idxD],{qtd:parseInt(novoEst[idxD].qtd||0)+qtd});
    else novoEst.push({produtoId, depositoId:destinoId, qtd});
    setEstoqueDepositos(novoEst); saveEstoqueDepositos(novoEst);
    var depO = depositos.find(function(d){return d.id===origemId;});
    var depD = depositos.find(function(d){return d.id===destinoId;});
    var mov1 = {id:Date.now(),   produtoId,depositoId:origemId,  tipo:"saida",   qtd,motivo:"Transferência → "+(depD?.nome||destinoId), data:new Date().toLocaleDateString("sv-SE"),hora:new Date().toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"})};
    var mov2 = {id:Date.now()+1, produtoId,depositoId:destinoId, tipo:"entrada", qtd,motivo:"Transferência ← "+(depO?.nome||origemId),  data:new Date().toLocaleDateString("sv-SE"),hora:new Date().toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"})};
    var novasMov = [...movEstoque, mov1, mov2];
    setMovEstoque(novasMov); localStorage.setItem("mov_estoque", JSON.stringify(novasMov));
  }
  function registrarMovEstoque(produtoId, sku, tipo, qtd, motivo, preco) {
    var mov = { id: Date.now(), produtoId, sku, tipo, qtd: parseInt(qtd), motivo: motivo||"", preco: parseFloat(preco||0)||null, data: new Date().toLocaleDateString("sv-SE"), hora: new Date().toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"}) };
    var novas = [...movEstoque, mov];
    saveMovEstoque2(novas);
    // Atualizar estoque do produto
    var upd = produtos.map(function(p){ if (p.id===produtoId || p.sku===sku) { var atual = parseInt(p.estoqueAtual||0); return Object.assign({},p,{estoqueAtual:String(tipo==="entrada"?atual+mov.qtd:Math.max(0,atual-mov.qtd))}); } return p; });
    setProdutos(upd); localStorage.setItem("produtos", JSON.stringify(upd));
    return mov;
  }

  // ── EXPORTAR PLANILHA ─────────────────────────────────────────────────
  function exportarPlanilhaProdutos(prods) {
    var header = ["SKU","Nome do Produto","Categoria","Custo (R$)","Preco Venda (R$)","Estoque Atual","Estoque Minimo","Fornecedor","MLB Vinculado","Status","Peso kg","Observacao"];
    var rows = [header.join(";")];
    prods.forEach(function(p) {
      var mlbs = (p.mlbsVinculados||[]).join("|") || (p.mlbVinculado||"");
      var descLimpa = (p.descricao||"").split(";").join(" ");
      var tituloLimpo = (p.titulo||"").split(";").join(" ");
      var fornLimpo = (p.fornecedorNome||"").split(";").join(" ");
      var row = [
        p.sku||"", tituloLimpo, p.categoria||"", p.precoCusto||"", p.precoVenda||"",
        p.estoqueAtual||"0", p.minStock||"0", fornLimpo,
        mlbs, p.status||"Ativo", p.peso||"", descLimpa
      ];
      rows.push(row.join(";"));
    });
    var csvContent = rows.join(String.fromCharCode(10));
    var blob = new Blob([csvContent], { type:"text/csv;charset=utf-8;" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url; a.download = "produtos_ml_margem.csv";
    a.click(); URL.revokeObjectURL(url);
    setImportMsg({ tipo:"ok", texto:"Planilha exportada com " + prods.length + " produto(s)!" });
    setTimeout(function(){ setImportMsg(null); }, 4000);
  }

  // ── IMPORTAR PLANILHA ──────────────────────────────────────────────────
  function importarPlanilhaProdutos(file) {
    var reader = new FileReader();
    reader.onload = function(e) {
      try {
        var text = e.target.result;
        // Remover BOM se existir
        if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
        // Detectar separador (ponto-vírgula ou vírgula)
        var sep = text.indexOf(";") > -1 ? ";" : ",";
        var lines = text.split(String.fromCharCode(10)).filter(function(l){ return l.trim(); });
        if (lines.length < 2) { setImportMsg({ tipo:"erro", texto:"❌ Planilha vazia ou inválida" }); return; }

        function parseLine(line) {
          var result = [], cur = "", inQ = false;
          for (var i = 0; i < line.length; i++) {
            var c = line[i];
            if (c === '"') { inQ = !inQ; }
            else if (c === sep && !inQ) { result.push(cur.trim()); cur = String(); }
            else { cur += c; }
          }
          result.push(cur.trim());
          return result;
        }

        var headers = parseLine(lines[0]).map(function(h){ return h.toLowerCase().replace(/[^a-z0-9]/g,""); });
        var idx = {
          sku:        headers.indexOf("sku"),
          titulo:     headers.findIndex(function(h){ return h.includes("nome"); }),
          categoria:  headers.findIndex(function(h){ return h.includes("categoria"); }),
          custo:      headers.findIndex(function(h){ return h.includes("custo"); }),
          preco:      headers.findIndex(function(h){ return h.includes("preo") || h.includes("preco") || h.includes("venda"); }),
          estoque:    headers.findIndex(function(h){ return h.includes("estoqueatu") || (h.includes("estoque") && !h.includes("min")); }),
          minstock:   headers.findIndex(function(h){ return h.includes("min"); }),
          fornecedor: headers.findIndex(function(h){ return h.includes("fornecedor"); }),
          mlb:        headers.findIndex(function(h){ return h.includes("mlb") || h.includes("vinculado"); }),
          status:     headers.findIndex(function(h){ return h.includes("status"); }),
          peso:       headers.findIndex(function(h){ return h.includes("peso"); }),
          obs:        headers.findIndex(function(h){ return h.includes("obs") || h.includes("servao"); }),
        };

        var importados = 0, atualizados = 0, erros = [];
        var novosProdutos = [...produtos];

        lines.slice(1).forEach(function(line, li) {
          var cols = parseLine(line);
          var sku = idx.sku >= 0 ? cols[idx.sku] : "";
          var titulo = idx.titulo >= 0 ? cols[idx.titulo] : "";
          if (!titulo && !sku) return; // linha vazia

          var dadosPlanilha = {
            sku: sku,
            titulo: titulo,
            categoria: idx.categoria >= 0 ? cols[idx.categoria] : "Outros",
            precoCusto: idx.custo >= 0 ? String(cols[idx.custo]).replace(/[R$\s.]/g,"").replace(",",".") : "",
            precoVenda: idx.preco >= 0 ? String(cols[idx.preco]).replace(/[R$\s.]/g,"").replace(",",".") : "",
            estoqueAtual: idx.estoque >= 0 ? String(parseInt(cols[idx.estoque])||0) : "0",
            minStock: idx.minstock >= 0 ? String(parseInt(cols[idx.minstock])||0) : "0",
            fornecedorNome: idx.fornecedor >= 0 ? cols[idx.fornecedor] : "",
            mlbVinculado: idx.mlb >= 0 ? cols[idx.mlb].split(";")[0] : "",
            mlbsVinculados: idx.mlb >= 0 ? cols[idx.mlb].split(";").filter(Boolean) : [],
            status: idx.status >= 0 && cols[idx.status] ? cols[idx.status] : "Ativo",
            peso: idx.peso >= 0 ? cols[idx.peso] : "",
            descricao: idx.obs >= 0 ? cols[idx.obs] : "",
            syncML: false,
          };

          // Verificar se produto já existe (por SKU ou MLB)
          var existIdx = novosProdutos.findIndex(function(p){
            return (sku && p.sku === sku) || (dadosPlanilha.mlbVinculado && p.mlbVinculado === dadosPlanilha.mlbVinculado);
          });

          if (existIdx >= 0) {
            novosProdutos[existIdx] = Object.assign({}, novosProdutos[existIdx], dadosPlanilha);
            atualizados++;
          } else {
            novosProdutos.push(Object.assign({ id: "imp_" + Date.now() + "_" + li, criadoViaImport: true }, dadosPlanilha));
            importados++;
          }
        });

        setProdutos(novosProdutos);
        saveProdutos(novosProdutos);

        // Atualizar custos se tiver precoCusto
        var newCosts = {};
        novosProdutos.forEach(function(p) {
          if (p.precoCusto) {
            var mlbs = p.mlbsVinculados || (p.mlbVinculado ? [p.mlbVinculado] : []);
            mlbs.forEach(function(m){ newCosts[m] = parseFloat(p.precoCusto); });
          }
        });
        if (Object.keys(newCosts).length > 0) setCosts(function(c){ return Object.assign({},c,newCosts); });

        setImportMsg({ tipo:"ok", texto:"✅ Importação concluída! " + importados + " adicionado(s), " + atualizados + " atualizado(s)." });
        setTimeout(function(){ setImportMsg(null); }, 6000);
      } catch(err) {
        setImportMsg({ tipo:"erro", texto:"❌ Erro ao importar: " + err.message });
      }
    };
    reader.readAsText(file, "utf-8");
  }

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

  // Auto-detectar composição para produtos "Par" (ex: SKU 14861487 = 1486 + 1487)
  function autoDetectarComposicaoPar(produto) {
    var sku = (produto.sku || "").trim();
    var titulo = (produto.titulo || "").toLowerCase();
    if (!titulo.startsWith("par ") && !titulo.startsWith("par d") && !titulo.startsWith("par l")) return null;
    // Regra: SKU do par é a concatenação dos SKUs simples
    // Ex: 14861487 → 1486 + 1487, com 4 dígitos cada
    if (sku.length >= 6) {
      var metade = Math.floor(sku.length / 2);
      var sku1 = sku.slice(0, metade);
      var sku2 = sku.slice(metade);
      // Verificar se ambos existem nos produtos
      var p1 = produtos.find(function(p){ return p.sku && p.sku.trim() === sku1; });
      var p2 = produtos.find(function(p){ return p.sku && p.sku.trim() === sku2; });
      if (p1 && p2) return [{ skuComponente: sku1, qtd: 1 }, { skuComponente: sku2, qtd: 1 }];
    }
    return null;
  }

  // Aplicar composição automática em todos os produtos "par" cadastrados
  function aplicarComposicaoPares() {
    var atualizados = 0;
    var produtosUpd = produtos.map(function(p) {
      if ((p.composicao||[]).length > 0) return p; // já tem composição
      var comp = autoDetectarComposicaoPar(p);
      if (!comp) return p;
      atualizados++;
      return Object.assign({}, p, { tipoProduto: "composto", composicao: comp });
    });
    if (atualizados === 0) { alert("Nenhum produto par novo detectado."); return; }
    setProdutos(produtosUpd); saveProdutos(produtosUpd);
    alert("✅ " + atualizados + " produto(s) par atualizado(s) com composição automática!");
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
    if (search && searchSkuExato) {
      r = r.filter(p => (p.sku||"").toLowerCase().trim() === search.toLowerCase().trim());
    } else if (search) r = r.filter(p =>
      (p.titulo||"").toLowerCase().includes(search.toLowerCase()) ||
      (p.sku||"").toLowerCase().includes(search.toLowerCase()) ||
      (p.ean||"").includes(search) ||
      (p.codigoFornecedor||"").toLowerCase().includes(search.toLowerCase()) ||
      (p.marca||"").toLowerCase().includes(search.toLowerCase())
    );
    if (filterCat !== "all") r = r.filter(p => p.categoria === filterCat);
    if (filterStatus !== "all") r = r.filter(p => p.status === filterStatus);
    if (filterFornecedorProd !== "all") r = r.filter(p => p.fornecedorId === filterFornecedorProd);
    // Filtros rápidos de situação
    if (filterEstoque === "zerado") r = r.filter(p => parseInt(p.estoqueAtual||0) <= 0);
    else if (filterEstoque === "critico") r = r.filter(p => p.estoqueMinimo && parseInt(p.estoqueAtual||0) <= parseInt(p.estoqueMinimo||0));
    else if (filterEstoque === "ok") r = r.filter(p => parseInt(p.estoqueAtual||0) > parseInt(p.estoqueMinimo||0));
    else if (filterEstoque === "sem_img") r = r.filter(p => !p.imagens || p.imagens.length === 0);
    else if (filterEstoque === "sem_custo") r = r.filter(p => !p.precoCusto || parseFloat(p.precoCusto||0) <= 0);
    else if (filterEstoque === "sem_sku") r = r.filter(p => !p.sku);
    else if (filterEstoque === "sem_ml") r = r.filter(p => !p.mlbVinculado && (!p.mlbsVinculados || p.mlbsVinculados.length === 0));
    return r;
  }, [produtos, search, filterCat, filterStatus, filterFornecedorProd, filterEstoque]);

  const estoqueBaixo = produtos.filter(p => p.estoqueMinimo && p.estoqueAtual && parseFloat(p.estoqueAtual) <= parseFloat(p.estoqueMinimo));

  return (
    <div>
      {/* Sub-tabs */}
      <div style={{ display:"flex", gap:2, marginBottom:8, background:"#f1f5f9", padding:4, borderRadius:10, width:"fit-content" }}>
        {[
          { key:"lista",      label:"📦 Produtos" },
          { key:"depositos",  label:"🏪 Depósitos" },
          { key:"estoque",    label:"📋 Movimentações" },
          { key:"pedidos",    label:"🛒 Pedidos de Compra" },
          { key:"relatorios", label:"📊 Relatórios" },
          { key:"sugestao",   label:"💡 Sugestão de Compras" },
          { key:"cadastros",  label:"🗂️ Cadastros" },
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


          <LayoutFiltros
            filtros={
              <>
                <FiltroGrupo titulo="Categoria">
                  <FiltroBotao label="Todas" active={filterCat==="all"} cor="#0f172a" bg="#f1f5f9" onClick={function(){setFilterCat("all");setPaginaProdutos(1);}} />
                  {CATEGORIAS_PRODUTO.map(function(c){ return <FiltroBotao key={c} label={c} active={filterCat===c} cor="#0f172a" bg="#f1f5f9" onClick={function(){setFilterCat(c);setPaginaProdutos(1);}} />; })}
                </FiltroGrupo>
                <FiltroGrupo titulo="Status">
                  <FiltroBotao label="Todos" active={filterStatus==="all"} cor="#0f172a" bg="#f1f5f9" onClick={function(){setFilterStatus("all");}} />
                  <FiltroBotao label="✅ Ativo" active={filterStatus==="Ativo"} cor="#15803d" bg="#f0fdf4" onClick={function(){setFilterStatus("Ativo");}} />
                  <FiltroBotao label="○ Inativo" active={filterStatus==="Inativo"} cor="#94a3b8" bg="#f8fafc" onClick={function(){setFilterStatus("Inativo");}} />
                </FiltroGrupo>
                <FiltroGrupo titulo="Fornecedor">
                  <FiltroBotao label="Todos" active={filterFornecedorProd==="all"} cor="#0f172a" bg="#f1f5f9" onClick={function(){setFilterFornecedorProd("all");}} />
                  {fornecedores.filter(function(f){return f.tipo==="Fornecedor";}).map(function(f){ return <FiltroBotao key={f.id} label={f.nome} active={filterFornecedorProd===f.id} cor="#0891b2" bg="#ecfeff" onClick={function(){setFilterFornecedorProd(f.id);}} />; })}
                </FiltroGrupo>
                <FiltroGrupo titulo="Situação">
                  {[{k:"todos",l:"Todos"},{k:"zerado",l:"🔴 Zerado"},{k:"critico",l:"⚠️ Crítico"},{k:"ok",l:"✅ OK"},{k:"sem_img",l:"📷 Sem imagem"},{k:"sem_custo",l:"💰 Sem custo"},{k:"sem_sku",l:"# Sem SKU"},{k:"sem_ml",l:"🟡 Sem MLB"}].map(function(f){
                    return <FiltroBotao key={f.k} label={f.l} active={filterEstoque===f.k} cor="#0f172a" bg="#f1f5f9" onClick={function(){setFilterEstoque(f.k);}} />;
                  })}
                </FiltroGrupo>
                <div style={{ fontSize:11, color:"#94a3b8", marginTop:"auto" }}>{produtosFiltrados.length} produto(s)</div>
              </>
            }
            busca={
              <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                <div style={{ position:"relative", flex:1 }}>
                  <span style={{ position:"absolute", left:10, top:"50%", transform:"translateY(-50%)", color:"#94a3b8", fontSize:13 }}>🔍</span>
                  <input value={search} onChange={function(e){ setSearch(e.target.value); setPaginaProdutos(1); }} placeholder={searchSkuExato ? "Digite o SKU exato..." : "Buscar por título, SKU, EAN, cód. fornecedor..."}
                    style={{ width:"100%", background:"#fff", border:"1px solid #e2e8f0", color:"#0f172a", padding:"8px 12px 8px 32px", borderRadius:8, fontSize:13, outline:"none" }} />
                </div>
                <label style={{ display:"flex", alignItems:"center", gap:5, fontSize:12, color:"#334155", whiteSpace:"nowrap", cursor:"pointer", background:searchSkuExato?"#eff6ff":"#f8fafc", border:`1px solid ${searchSkuExato?"#bfdbfe":"#e2e8f0"}`, padding:"7px 10px", borderRadius:8 }}>
                  <input type="checkbox" checked={searchSkuExato} onChange={function(e){ setSearchSkuExato(e.target.checked); setPaginaProdutos(1); }} style={{ cursor:"pointer" }} />
                  SKU exato
                </label>
              </div>
            }
            acoes={
              <div style={{ display:"flex", gap:6 }}>
              <BotaoExportar
              onCSV={function(){
                var list = produtosFiltrados.length > 0 ? produtosFiltrados : produtos;
                var cab=["Título","SKU","EAN","Categoria","Preço Venda","Preço Custo","Estoque Atual","Estoque Mínimo","Fornecedor","Status","MLB Vinculado"];
                var linhas=list.map(function(p){ var forn=(fornecedores||[]).find(function(f){return f.id===p.fornecedorId;}); return [p.titulo||"",p.sku||"",p.ean||"",p.categoria||"",p.precoVenda||"",p.precoCusto||"",p.estoqueAtual||0,p.estoqueMinimo||0,forn?.nome||"",p.status||"Ativo",p.mlbVinculado||""]; });
                exportarCSV("produtos",cab,linhas);
              }}
              onXLS={function(){
                var list = produtosFiltrados.length > 0 ? produtosFiltrados : produtos;
                var cab=["Título","SKU","EAN","Categoria","Preço Venda","Preço Custo","Estoque Atual","Estoque Mínimo","Fornecedor","Status","MLB Vinculado"];
                var linhas=list.map(function(p){ var forn=(fornecedores||[]).find(function(f){return f.id===p.fornecedorId;}); return [p.titulo||"",p.sku||"",p.ean||"",p.categoria||"",p.precoVenda||"",p.precoCusto||"",p.estoqueAtual||0,p.estoqueMinimo||0,forn?.nome||"",p.status||"Ativo",p.mlbVinculado||""]; });
                exportarXLS("produtos",cab,linhas);
              }}
              onPDF={function(){
                var list = produtosFiltrados.length > 0 ? produtosFiltrados : produtos;
                var cab=["Título","SKU","Categoria","Venda","Custo","Estoque","Mín","Status"];
                var linhas=list.map(function(p){ return [p.titulo?.slice(0,45)||"",p.sku||"",p.categoria||"",p.precoVenda?"R$ "+parseFloat(p.precoVenda).toFixed(2).replace(".",","):"—",p.precoCusto?"R$ "+parseFloat(p.precoCusto).toFixed(2).replace(".",","):"—",p.estoqueAtual||0,p.estoqueMinimo||0,p.status||"Ativo"]; });
                exportarPDF("produtos","Lista de Produtos",cab,linhas,["Total: "+list.length+" produto(s)","Filtro ativo: "+(produtosFiltrados.length>0&&produtosFiltrados.length<produtos.length?"Sim":"Não")]);
              }}
              />
              <label style={{ background:"#7c3aed", border:"none", color:"#fff", fontWeight:700, padding:"9px 18px", borderRadius:8, cursor:"pointer", fontSize:13, display:"inline-flex", alignItems:"center", gap:6 }}>
                ⬆️ Importar
                <input type="file" accept=".xlsx,.csv" style={{ display:"none" }}
                  onChange={function(e){ if(e.target.files[0]) importarPlanilhaProdutos(e.target.files[0]); e.target.value=""; }} />
              </label>
              <button onClick={aplicarComposicaoPares}
                style={{ background:"#7c3aed", border:"none", color:"#fff", fontWeight:700, padding:"9px 16px", borderRadius:8, cursor:"pointer", fontSize:13 }}>
                🔗 Detectar Pares
              </button>
              <button onClick={function(){ setEditingProd(null); setShowModalProd(true); }}
                style={{ background:"#0f172a", border:"none", color:"#fff", fontWeight:700, padding:"9px 20px", borderRadius:8, cursor:"pointer", fontSize:13 }}>+ Novo Produto</button>
            </div>
          }>
            <div>
            {listings.length > 0 && (
              <button onClick={() => {
                const sincronizados = syncListingsToProdutos(listings, produtos);
                setProdutos(sincronizados); saveProdutos(sincronizados);
                // Sync custos
                const newCosts = {};
                sincronizados.forEach(p => {
      if (p.precoCusto) {
        var custo = parseFloat(p.precoCusto);
        // Aplicar custo a todos os MLBs desse produto
        var mlbs = p.mlbsVinculados || (p.mlbVinculado ? [p.mlbVinculado] : []);
        mlbs.forEach(function(mlb){ newCosts[mlb] = custo; });
      }
    });
                if (Object.keys(newCosts).length > 0) setCosts(c => ({...c, ...newCosts}));
                alert(`✅ ${sincronizados.length} produtos sincronizados com o ML!`);
              }}
                style={{ background:"#ffe000", border:"none", color:"#0f172a", fontWeight:700, padding:"9px 20px", borderRadius:8, cursor:"pointer", fontSize:13 }}>
                🔄 Sincronizar com ML
              </button>
            )}
          </div>
          {importMsg && (
            <div style={{ background:importMsg.tipo==="ok"?"#f0fdf4":"#fef2f2", border:"1px solid "+(importMsg.tipo==="ok"?"#bbf7d0":"#fecaca"), borderRadius:10, padding:"10px 16px", marginBottom:10, display:"flex", justifyContent:"space-between", alignItems:"center" }}>
              <span style={{ fontSize:13, color:importMsg.tipo==="ok"?"#15803d":"#dc2626", fontWeight:600 }}>{importMsg.texto}</span>
              <button onClick={function(){ setImportMsg(null); }} style={{ background:"none", border:"none", cursor:"pointer", color:"#94a3b8", fontSize:15 }}>✕</button>
            </div>
          )}


          {prodSel.length > 0 && (
            <div style={{ display:"flex", gap:8, alignItems:"center", background:"#0f172a", borderRadius:10, padding:"10px 16px", marginBottom:10, flexWrap:"wrap" }}>
              <span style={{ color:"#fff", fontWeight:700, fontSize:13 }}>{prodSel.length} produto(s) selecionado(s)</span>
              <button onClick={function(){
                if (!window.confirm("Excluir " + prodSel.length + " produto(s)?")) return;
                var upd = produtos.filter(function(p){ return !prodSel.includes(p.id); });
                setProdutos(upd); saveProdutos(upd); setProdSel([]);
              }} style={{ background:"#dc2626", border:"none", color:"#fff", fontWeight:700, padding:"4px 10px", borderRadius:8, cursor:"pointer", fontSize:12 }}>
                🗑 Excluir Selecionados
              </button>
              <button onClick={function(){
                var upd = produtos.map(function(p){ return prodSel.includes(p.id) ? Object.assign({},p,{status:"Inativo"}) : p; });
                setProdutos(upd); saveProdutos(upd); setProdSel([]);
              }} style={{ background:"#d97706", border:"none", color:"#fff", fontWeight:700, padding:"4px 10px", borderRadius:8, cursor:"pointer", fontSize:12 }}>
                ⏸ Inativar
              </button>
              <button onClick={function(){
                var upd = produtos.map(function(p){ return prodSel.includes(p.id) ? Object.assign({},p,{status:"Ativo"}) : p; });
                setProdutos(upd); saveProdutos(upd); setProdSel([]);
              }} style={{ background:"#15803d", border:"none", color:"#fff", fontWeight:700, padding:"4px 10px", borderRadius:8, cursor:"pointer", fontSize:12 }}>
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
                  {produtosFiltrados.slice((paginaProdutos-1)*POR_PAG_PROD, paginaProdutos*POR_PAG_PROD).map((p, i) => {
                    const forn = (fornecedores||[]).find(f => f.id === p.fornecedorId);
                    // mlbsVinculados: array com todos os MLBs; mlbVinculado: retrocompatibilidade
                    var todosMLBs = p.mlbsVinculados || (p.mlbVinculado ? [p.mlbVinculado] : []);
                    const mlListing = listings.find(l => l.id === p.mlbVinculado);
                    // Para produto COMPOSTO (kit): saldo = mínimo entre (estoque do componente / qtd necessária)
                    var estoqueExibir = parseInt(p.estoqueAtual||0);
                    var isKit = p.tipoProduto === "composto" && (p.composicao||[]).length > 0;
                    if (isKit) {
                      var saldoKit = Infinity;
                      (p.composicao||[]).forEach(function(comp) {
                        var prodComp = produtos.find(function(x){ return x.sku && x.sku.trim() === comp.skuComponente.trim(); });
                        if (prodComp) {
                          var saldoComp = Math.floor(parseInt(prodComp.estoqueAtual||0) / (parseInt(comp.qtd)||1));
                          if (saldoComp < saldoKit) saldoKit = saldoComp;
                        } else {
                          saldoKit = 0; // componente não encontrado = sem estoque
                        }
                      });
                      estoqueExibir = saldoKit === Infinity ? 0 : saldoKit;
                    }
                    const estBaixo = p.estoqueMinimo && estoqueExibir <= parseFloat(p.estoqueMinimo);
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
                        <td style={{ padding:"7px 10px", fontSize:11, color:"#64748b" }}>
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
                        <td style={{ padding:"7px 10px", fontSize:12, fontWeight:600, color:"#15803d" }}>
                          {p.precoVenda ? `R$ ${parseFloat(p.precoVenda).toFixed(2).replace(".",",")}` : "—"}
                        </td>
                        <td style={{ padding:"10px 14px" }}>
                          <div style={{ fontWeight:700, fontSize:13, color:estBaixo?"#dc2626":"#0f172a" }}>
                            {estoqueExibir} un {estBaixo?"⚠️":""}
                            {isKit && <span style={{ fontSize:9, color:"#7c3aed", background:"#f5f3ff", padding:"1px 4px", borderRadius:3, marginLeft:4 }}>KIT</span>}
                          </div>
                          {p.estoqueMinimo && <div style={{ fontSize:10, color:"#94a3b8" }}>mín: {p.estoqueMinimo}</div>}
                          {isKit && (
                            <div style={{ fontSize:9, color:"#64748b" }}>
                              {(p.composicao||[]).map(function(c){ return c.skuComponente+"×"+c.qtd; }).join(" + ")}
                            </div>
                          )}
                        </td>
                        <td style={{ padding:"10px 14px" }}>
                          <span style={{ fontSize:11, fontWeight:600, color:p.status==="Ativo"?"#15803d":"#94a3b8", background:p.status==="Ativo"?"#f0fdf4":"#f8fafc", padding:"3px 8px", borderRadius:6 }}>{p.status}</span>
                        </td>
                        <td style={{ padding:"10px 14px" }}>
                          {todosMLBs.length > 0 ? (
                            <div>
                              {todosMLBs.map(function(mlb) {
                                var lst = listings.find(function(l){ return l.id === mlb; });
                                return (
                                  <div key={mlb} style={{ display:"flex", alignItems:"center", gap:4, marginBottom:2 }}>
                                    <span style={{ fontSize:10, fontWeight:600, color:lst?.status==="active"?"#15803d":"#94a3b8" }}>
                                      {lst?.status==="active"?"✓":"○"}
                                    </span>
                                    <span style={{ fontSize:10, fontFamily:"monospace", color:"#334155" }}>{mlb}</span>
                                    {lst && <span style={{ fontSize:9, color:lst.status==="active"?"#15803d":"#94a3b8" }}>
                                      {lst.status==="active"?"Ativo":"Inativo"}
                                    </span>}
                                  </div>
                                );
                              })}
                              {todosMLBs.length > 1 && (
                                <span style={{ fontSize:9, background:"#eff6ff", color:"#1d4ed8", padding:"1px 5px", borderRadius:4, fontWeight:600 }}>
                                  {todosMLBs.length} anúncios
                                </span>
                              )}
                            </div>
                          ) : <span style={{ fontSize:11, color:"#94a3b8" }}>—</span>}
                        </td>
                        <td style={{ padding:"10px 14px" }}>
                          <div style={{ display:"flex", gap:4 }}>
                            <button onClick={function(){ setShowMovEstoque(p); }}
                              title="Movimentação de estoque"
                              style={{ background:"#eff6ff", border:"1px solid #bfdbfe", color:"#1d4ed8", padding:"4px 8px", borderRadius:6, cursor:"pointer", fontSize:11 }}>📦</button>
                            {depositos.length >= 2 && estoqueDepositos.some(function(e){return e.produtoId===p.id&&parseInt(e.qtd||0)>0;}) && (
                              <button onClick={function(){ setShowTransfEstoque(p); }}
                                title="Transferir entre depósitos"
                                style={{ background:"#f0fdf4", border:"1px solid #bbf7d0", color:"#15803d", padding:"4px 8px", borderRadius:6, cursor:"pointer", fontSize:11 }}>⇄</button>
                            )}
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
          </LayoutFiltros>
        </div>
      )}

      {/* ── FORNECEDORES ── */}
      {/* ── DEPÓSITOS ── */}
      {prodTab === "depositos" && (
        <div>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8 }}>
            <div>
              <div style={{ fontWeight:800, fontSize:18, color:"#0f172a" }}>🏪 Depósitos de Estoque</div>
              <div style={{ fontSize:13, color:"#94a3b8", marginTop:2 }}>Gerencie múltiplos locais de armazenamento e transfira produtos entre eles</div>
            </div>
            <div style={{ display:"flex", gap:8 }}>
              <BotaoExportar
                onCSV={function(){
                  var cab=["Depósito","Descrição","Status","Produtos","Unidades Totais"];
                  var linhas=depositos.map(function(dep){
                    var totalP=estoqueDepositos.filter(function(e){return e.depositoId===dep.id&&parseInt(e.qtd||0)>0;}).length;
                    var totalU=estoqueDepositos.filter(function(e){return e.depositoId===dep.id;}).reduce(function(s,e){return s+parseInt(e.qtd||0);},0);
                    return [dep.nome,dep.descricao||"",dep.ativo===false?"Inativo":"Ativo",totalP,totalU];
                  });
                  exportarCSV("depositos",cab,linhas);
                }}
                onXLS={function(){
                  var cab=["Depósito","Produto","SKU","Quantidade"];
                  var linhas=[];
                  depositos.forEach(function(dep){
                    estoqueDepositos.filter(function(e){return e.depositoId===dep.id&&parseInt(e.qtd||0)>0;}).forEach(function(e){
                      var prod=produtos.find(function(p){return p.id===e.produtoId;});
                      linhas.push([dep.nome,prod?.titulo||e.produtoId,prod?.sku||"",e.qtd]);
                    });
                  });
                  exportarXLS("estoque_por_deposito",cab,linhas);
                }}
                onPDF={function(){
                  var cab=["Depósito","Produto","SKU","Qtd"];
                  var linhas=[];
                  depositos.forEach(function(dep){
                    estoqueDepositos.filter(function(e){return e.depositoId===dep.id&&parseInt(e.qtd||0)>0;}).forEach(function(e){
                      var prod=produtos.find(function(p){return p.id===e.produtoId;});
                      linhas.push([dep.nome,prod?.titulo?.slice(0,40)||"",prod?.sku||"",e.qtd]);
                    });
                  });
                  var total=estoqueDepositos.reduce(function(s,e){return s+parseInt(e.qtd||0);},0);
                  exportarPDF("estoque_por_deposito","Estoque por Depósito",cab,linhas,["Total de depósitos: "+depositos.length,"Total de unidades: "+total]);
                }}
              />
              <button onClick={function(){ setEditingDeposito(null); setShowModalDeposito(true); }}
                style={{ background:"#0f172a", border:"none", color:"#fff", fontWeight:700, padding:"10px 22px", borderRadius:10, cursor:"pointer", fontSize:13 }}>
                + Novo Depósito
              </button>
            </div>
          </div>
          {depositos.length === 0 ? (
            <div style={{ background:"#f8fafc", border:"2px dashed #e2e8f0", borderRadius:16, padding:60, textAlign:"center", color:"#94a3b8" }}>
              <div style={{ fontSize:48, marginBottom:12 }}>🏪</div>
              <div style={{ fontWeight:700, fontSize:16, color:"#0f172a", marginBottom:6 }}>Nenhum depósito cadastrado</div>
              <div style={{ fontSize:13, marginBottom:10 }}>Crie depósitos para organizar seu estoque por localização</div>
              <button onClick={function(){ setEditingDeposito(null); setShowModalDeposito(true); }}
                style={{ background:"#0f172a", border:"none", color:"#fff", fontWeight:700, padding:"11px 28px", borderRadius:10, cursor:"pointer", fontSize:14 }}>
                + Criar Primeiro Depósito
              </button>
            </div>
          ) : (
            <div>
              <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(280px,1fr))", gap:8, marginBottom:10 }}>
                {depositos.map(function(dep) {
                  var totalProdutos = estoqueDepositos.filter(function(e){return e.depositoId===dep.id&&parseInt(e.qtd||0)>0;}).length;
                  var totalUnidades = estoqueDepositos.filter(function(e){return e.depositoId===dep.id;}).reduce(function(s,e){return s+parseInt(e.qtd||0);},0);
                  return (
                    <div key={dep.id} style={{ background:"#fff", border:"2px solid "+dep.cor+"33", borderRadius:14, overflow:"hidden", opacity:dep.ativo===false?0.6:1 }}>
                      <div style={{ background:dep.cor+"15", borderBottom:"1px solid "+dep.cor+"22", padding:"16px 18px", display:"flex", alignItems:"center", gap:12 }}>
                        <div style={{ width:48, height:48, borderRadius:12, background:dep.cor, display:"flex", alignItems:"center", justifyContent:"center", fontSize:24 }}>{dep.icone}</div>
                        <div style={{ flex:1, minWidth:0 }}>
                          <div style={{ fontWeight:700, fontSize:15, color:"#0f172a" }}>{dep.nome}</div>
                          {dep.descricao && <div style={{ fontSize:12, color:"#64748b", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{dep.descricao}</div>}
                        </div>
                      </div>
                      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr" }}>
                        <div style={{ padding:"12px 16px", borderRight:"1px solid #f1f5f9" }}>
                          <div style={{ fontSize:9, color:"#94a3b8", fontWeight:600, textTransform:"uppercase", marginBottom:3 }}>Produtos</div>
                          <div style={{ fontSize:17, fontWeight:800, color:dep.cor }}>{totalProdutos}</div>
                        </div>
                        <div style={{ padding:"12px 16px" }}>
                          <div style={{ fontSize:9, color:"#94a3b8", fontWeight:600, textTransform:"uppercase", marginBottom:3 }}>Unidades</div>
                          <div style={{ fontSize:17, fontWeight:800, color:dep.cor }}>{totalUnidades}</div>
                        </div>
                      </div>
                      <div style={{ display:"flex", borderTop:"1px solid #f1f5f9" }}>
                        <button onClick={function(){ setEditingDeposito(dep); setShowModalDeposito(true); }}
                          style={{ flex:1, background:"transparent", border:"none", borderRight:"1px solid #f1f5f9", color:"#64748b", padding:"10px", cursor:"pointer", fontSize:12, fontWeight:600, display:"flex", flexDirection:"column", alignItems:"center", gap:2 }}>
                          <span>✏️</span><span style={{ fontSize:10 }}>Editar</span>
                        </button>
                        <button onClick={function(){ excluirDeposito(dep.id); }}
                          style={{ flex:1, background:"transparent", border:"none", color:"#dc2626", padding:"10px", cursor:"pointer", fontSize:12, fontWeight:600, display:"flex", flexDirection:"column", alignItems:"center", gap:2 }}>
                          <span>🗑</span><span style={{ fontSize:10 }}>Excluir</span>
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
              {produtos.length > 0 && (
                <div>
                  <div style={{ fontWeight:700, fontSize:15, color:"#0f172a", marginBottom:12 }}>Estoque por Produto e Depósito</div>
                  <div style={{ background:"#fff", border:"1px solid #e2e8f0", borderRadius:12, overflow:"auto" }}>
                    <table style={{ borderCollapse:"collapse", width:"100%" }}>
                      <thead>
                        <tr>
                          <th style={{ fontSize:11, color:"#94a3b8", textTransform:"uppercase", padding:"10px 14px", borderBottom:"1px solid #f1f5f9", textAlign:"left", fontWeight:600, background:"#fafafa" }}>Produto</th>
                          {depositos.map(function(dep){
                            return <th key={dep.id} style={{ fontSize:11, color:dep.cor, textTransform:"uppercase", padding:"10px 14px", borderBottom:"1px solid #f1f5f9", textAlign:"center", fontWeight:700, background:"#fafafa", whiteSpace:"nowrap" }}>{dep.icone} {dep.nome}</th>;
                          })}
                          <th style={{ fontSize:11, color:"#94a3b8", textTransform:"uppercase", padding:"10px 14px", borderBottom:"1px solid #f1f5f9", textAlign:"center", fontWeight:600, background:"#fafafa" }}>Total</th>
                          <th style={{ fontSize:11, color:"#94a3b8", textTransform:"uppercase", padding:"10px 14px", borderBottom:"1px solid #f1f5f9", textAlign:"center", fontWeight:600, background:"#fafafa" }}>Ações</th>
                        </tr>
                      </thead>
                      <tbody>
                        {produtos.filter(function(p){return p.status!=="Inativo";}).slice(0,100).map(function(p, i) {
                          var totalProd = estoqueDepositos.filter(function(e){return e.produtoId===p.id;}).reduce(function(s,e){return s+parseInt(e.qtd||0);},0);
                          var temEst = estoqueDepositos.some(function(e){return e.produtoId===p.id&&parseInt(e.qtd||0)>0;});
                          return (
                            <tr key={p.id} style={{ background:i%2===0?"#f8fafc":"#fff" }}>
                              <td style={{ padding:"10px 14px" }}>
                                <div style={{ fontSize:13, fontWeight:600, color:"#0f172a", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", maxWidth:220 }}>{p.titulo}</div>
                                {p.sku && <div style={{ fontSize:11, color:"#94a3b8", fontFamily:"monospace" }}>{p.sku}</div>}
                              </td>
                              {depositos.map(function(dep){
                                var est = estoqueDepositos.find(function(e){return e.produtoId===p.id&&e.depositoId===dep.id;});
                                var qtdDep = est ? parseInt(est.qtd||0) : 0;
                                return (
                                  <td key={dep.id} style={{ padding:"10px 14px", textAlign:"center" }}>
                                    <input type="number" min="0" value={qtdDep}
                                      onChange={function(e){
                                        var novoEst = estoqueDepositos.slice();
                                        var idx = novoEst.findIndex(function(x){return x.produtoId===p.id&&x.depositoId===dep.id;});
                                        var novaQtd = parseInt(e.target.value)||0;
                                        if (idx>=0) novoEst[idx]=Object.assign({},novoEst[idx],{qtd:novaQtd});
                                        else novoEst.push({produtoId:p.id,depositoId:dep.id,qtd:novaQtd});
                                        setEstoqueDepositos(novoEst); saveEstoqueDepositos(novoEst);
                                        var total = novoEst.filter(function(x){return x.produtoId===p.id;}).reduce(function(s,x){return s+parseInt(x.qtd||0);},0);
                                        var updProd = produtos.map(function(pr){return pr.id===p.id?Object.assign({},pr,{estoqueAtual:String(total)}):pr;});
                                        setProdutos(updProd); localStorage.setItem("produtos_cadastro", JSON.stringify(updProd));
                                      }}
                                      style={{ width:70, textAlign:"center", background:qtdDep>0?"#f0fdf4":"#f8fafc", border:"1px solid "+(qtdDep>0?"#bbf7d0":"#e2e8f0"), color:qtdDep>0?"#15803d":"#94a3b8", padding:"5px 8px", borderRadius:7, fontSize:13, fontWeight:700, outline:"none" }} />
                                  </td>
                                );
                              })}
                              <td style={{ padding:"10px 14px", textAlign:"center", fontWeight:800, fontSize:14, color:totalProd>0?"#0f172a":"#94a3b8" }}>{totalProd}</td>
                              <td style={{ padding:"10px 14px", textAlign:"center" }}>
                                {temEst && depositos.length >= 2 && (
                                  <button onClick={function(){ setShowTransfEstoque(p); }}
                                    style={{ background:"#eff6ff", border:"1px solid #bfdbfe", color:"#1d4ed8", padding:"5px 10px", borderRadius:7, cursor:"pointer", fontSize:12, fontWeight:600 }}>
                                    ⇄ Transferir
                                  </button>
                                )}
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
        </div>
      )}

      {/* ── ESTOQUE (Movimentações) ── */}
      {prodTab === "estoque" && (
        <div>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:4 }}>
            <div>
              <div style={{ fontWeight:800, fontSize:18, color:"#0f172a" }}>📋 Movimentação de Estoque</div>
              <div style={{ fontSize:13, color:"#94a3b8", marginTop:2 }}>Histórico completo de entradas, saídas e transferências por produto e depósito</div>
            </div>
            <div style={{ display:"flex", gap:8, alignItems:"center", flexShrink:0 }}>
                <button onClick={function(){
                  if (!window.confirm("Isso vai:\n\n1. Calcular saldo = estoque ML atual + total de saídas de venda\n2. Criar ENTRADA inicial com esse saldo\n3. Criar SAÍDA para cada venda paga\n\nContinuar?")) return;

                  var prodAtual = JSON.parse(localStorage.getItem("produtos_cadastro") || "[]");
                  var hoje = new Date().toLocaleDateString("sv-SE");
                  var horaAgora = new Date().toLocaleTimeString("pt-BR", {hour:"2-digit", minute:"2-digit"});
                  localStorage.removeItem("vendas_estoque_baixadas");

                  // Buscar pedidos
                  var ordersParaProcessar = (rawOrders && rawOrders.length > 0)
                    ? rawOrders
                    : (function(){ try { return JSON.parse(localStorage.getItem("ml_orders_cache")||"[]"); } catch { return []; } })();

                  var pedidosPagos = ordersParaProcessar.filter(function(o){ return o.status==="paid"; });

                  // Contar saídas por MLB (vendas pagas)
                  var vendasPorMlb = {};
                  pedidosPagos.forEach(function(o) {
                    if (!o.listing_id) return;
                    vendasPorMlb[o.listing_id] = (vendasPorMlb[o.listing_id]||0) + parseInt(o.qty||1);
                  });

                  // Mapa MLB -> quantidade disponível no ML agora
                  var saldoMlb = {};
                  (listings||[]).forEach(function(l) {
                    saldoMlb[l.id] = parseInt(l.available_quantity||l.initial_quantity||0);
                  });

                  // Criar entradas iniciais: saldo ML atual + todas as saídas que ocorreram
                  var movsIniciais = [];
                  var produtosUpd = prodAtual.map(function(p) {
                    // Deduplicate MLBs to avoid double counting
                    var mlbsRaw = [p.mlbVinculado].concat(p.mlbsVinculados||[]).filter(Boolean);
                    var mlbs = mlbsRaw.filter(function(m,i){ return mlbsRaw.indexOf(m)===i; });
                    // Soma vendas de todos os MLB únicos do produto
                    var totalSaidas = mlbs.reduce(function(s,m){ return s+(vendasPorMlb[m]||0); },0);
                    // Saldo atual no ML (soma dos estoques de cada MLB único)
                    var saldoAtualMl = mlbs.reduce(function(s,m){ return s+(saldoMlb[m]||0); },0);
                    // Se tem MLB, usa saldo ML + saídas; senão usa estoqueAtual cadastrado
                    var saldoInicial = mlbs.length>0 ? (saldoAtualMl + totalSaidas) : parseInt(p.estoqueAtual||0);
                    if (saldoInicial <= 0 && parseInt(p.estoqueAtual||0) > 0) saldoInicial = parseInt(p.estoqueAtual||0);
                    if (saldoInicial > 0) {
                      movsIniciais.push({
                        id: "saldo_inicial_" + p.id,
                        produtoId: p.id,
                        mlbId: mlbs[0]||null,
                        sku: p.sku||"",
                        tipo: "entrada",
                        qtd: saldoInicial,
                        motivo: mlbs.length>0
                          ? "Saldo inicial (ML atual: "+saldoAtualMl+" + vendas: "+totalSaidas+")"
                          : "Saldo inicial de estoque",
                        data: hoje, hora: horaAgora,
                        automatico: true, saldoInicial: true,
                      });
                    }
                    // Atualizar estoqueAtual com saldo ML se disponível
                    if (mlbs.length>0 && saldoAtualMl > 0) {
                      return Object.assign({}, p, { estoqueAtual: String(saldoAtualMl) });
                    }
                    return p;
                  });

                  localStorage.setItem("produtos_cadastro", JSON.stringify(produtosUpd));
                  setProdutos(produtosUpd);
                  localStorage.setItem("mov_estoque", JSON.stringify(movsIniciais));
                  setMovEstoque(movsIniciais);

                  if (pedidosPagos.length === 0) {
                    alert("✅ " + movsIniciais.length + " entradas iniciais criadas!\n\nNenhum pedido encontrado em cache. Reconecte ao ML para gerar as saídas.");
                    return;
                  }

                  // Gerar saídas de todas as vendas pagas
                  // Chama diretamente sem depender do estado React (que pode estar desatualizado)
                  var resultBaixa = (function() {
                    var novasBaixadas = new Set();
                    var produtosUpd2 = produtosUpd.slice();
                    var movsUpd = movsIniciais.slice();
                    var qtdBaixadas = 0;

                    // Mapa MLB → produto (deduplicated)
                    var mapMlb = {}, mapSku = {};
                    produtosUpd2.forEach(function(p) {
                      var mlbsU = [p.mlbVinculado].concat(p.mlbsVinculados||[]).filter(Boolean).filter(function(m,i,a){return a.indexOf(m)===i;});
                      mlbsU.forEach(function(m){ mapMlb[m] = p; });
                      if (p.sku) mapSku[p.sku.trim().toLowerCase()] = p;
                    });

                    pedidosPagos.forEach(function(o) {
                      if (novasBaixadas.has(String(o.id))) return;
                      var lid = o.listing_id;
                      var prod = (lid && mapMlb[lid]) ||
                                 (o.seller_sku && mapSku[o.seller_sku.trim().toLowerCase()]) || null;
                      if (!prod) {
                        // Sem produto cadastrado — registra semProduto
                        if (lid) {
                          movsUpd.push({
                            id: "venda_"+o.id, produtoId:null, mlbId:lid, sku:o.seller_sku||"",
                            tipo:"saida", qtd:parseInt(o.qty||1),
                            motivo:"Venda ML #"+o.id+" ("+(o.title||"").slice(0,35)+") — sem produto",
                            pedidoId:String(o.id), data:o.date||hoje, hora:horaAgora,
                            automatico:true, semProduto:true,
                          });
                          novasBaixadas.add(String(o.id));
                        }
                        return;
                      }
                      var qty = parseInt(o.qty||1);
                      var idx = produtosUpd2.findIndex(function(p2){return p2.id===prod.id;});
                      if (idx>=0) {
                        var est = parseInt(produtosUpd2[idx].estoqueAtual||0);
                        produtosUpd2[idx] = Object.assign({},produtosUpd2[idx],{estoqueAtual:String(Math.max(0,est-qty))});
                        // atualizar mapa
                        var mlbsU2=[produtosUpd2[idx].mlbVinculado].concat(produtosUpd2[idx].mlbsVinculados||[]).filter(Boolean).filter(function(m,i,a){return a.indexOf(m)===i;});
                        mlbsU2.forEach(function(m){mapMlb[m]=produtosUpd2[idx];});
                      }
                      movsUpd.push({
                        id:"venda_"+o.id, produtoId:prod.id, mlbId:lid,
                        sku:prod.sku||o.seller_sku||"", tipo:"saida", qtd:qty,
                        motivo:"Venda ML #"+o.id+(o.title?" — "+o.title.slice(0,40):""),
                        pedidoId:String(o.id), data:o.date||hoje, hora:horaAgora,
                        automatico:true,
                      });
                      novasBaixadas.add(String(o.id));
                      qtdBaixadas++;
                    });

                    // Recalcular estoqueAtual com base nas movimentações reais
                    var saldoMap = {};
                    movsUpd.forEach(function(m) {
                      if (!m.produtoId) return;
                      if (!saldoMap[m.produtoId]) saldoMap[m.produtoId] = 0;
                      if (m.tipo === "entrada") saldoMap[m.produtoId] += parseInt(m.qtd||0);
                      if (m.tipo === "saida")   saldoMap[m.produtoId] -= parseInt(m.qtd||0);
                    });
                    produtosUpd2 = produtosUpd2.map(function(p) {
                      if (saldoMap[p.id] === undefined) return p;
                      return Object.assign({}, p, { estoqueAtual: String(Math.max(0, saldoMap[p.id])) });
                    });

                    // Salvar tudo
                    localStorage.setItem("produtos_cadastro", JSON.stringify(produtosUpd2));
                    localStorage.setItem("mov_estoque", JSON.stringify(movsUpd));
                    localStorage.setItem("vendas_estoque_baixadas", JSON.stringify([...novasBaixadas]));
                    setProdutos(produtosUpd2);
                    setMovEstoque(movsUpd);
                    return { qtd: qtdBaixadas, total: movsUpd.length, semProduto: movsUpd.filter(function(m){return m.semProduto;}).length };
                  })();

                  alert("✅ Concluído!\n• " + movsIniciais.length + " entradas iniciais\n• " + resultBaixa.qtd + " saídas de vendas vinculadas\n• " + resultBaixa.semProduto + " sem produto cadastrado\n• " + resultBaixa.total + " movimentações no total");
                }}
                  style={{ background:"#ffe000", border:"none", color:"#0f172a", fontWeight:700, padding:"8px 16px", borderRadius:8, cursor:"pointer", fontSize:12 }}>
                  🔄 Reprocessar Vendas
                </button>
            <BotaoExportar
              onCSV={function(){
                var cab=["Data","Hora","Produto","SKU","Depósito","Tipo","Quantidade","Motivo","Preço Unit."];
                var movs=movEstoque.filter(function(m){
                  if(filterDepositoEst==="todos") return true;
                  if(filterDepositoEst==="sem_deposito") return !m.depositoId;
                  return m.depositoId===filterDepositoEst;
                }).filter(function(m){
                  if(!searchEstoque) return true; var q=searchEstoque.toLowerCase();
                  var p=produtos.find(function(x){return x.id===m.produtoId;});
                  return (p?.titulo||"").toLowerCase().includes(q)||(p?.sku||"").toLowerCase().includes(q)||(m.motivo||"").toLowerCase().includes(q);
                }).sort(function(a,b){return (b.id||0)-(a.id||0);});
                var linhas=movs.map(function(m){
                  var p=produtos.find(function(x){return x.id===m.produtoId;});
                  var dep=depositos.find(function(d){return d.id===m.depositoId;});
                  return [fmtDate(m.data),m.hora||"",p?.titulo||"",p?.sku||"",dep?.nome||"Sem depósito",m.tipo==="entrada"?"Entrada":"Saída",m.qtd,m.motivo||"",m.preco||""];
                });
                exportarCSV("movimentacoes_estoque",cab,linhas);
              }}
              onXLS={function(){
                var cab=["Data","Hora","Produto","SKU","Depósito","Tipo","Quantidade","Motivo","Preço Unit."];
                var movs=movEstoque.sort(function(a,b){return (b.id||0)-(a.id||0);});
                var linhas=movs.map(function(m){
                  var p=produtos.find(function(x){return x.id===m.produtoId;});
                  var dep=depositos.find(function(d){return d.id===m.depositoId;});
                  return [fmtDate(m.data),m.hora||"",p?.titulo||"",p?.sku||"",dep?.nome||"",m.tipo==="entrada"?"Entrada":"Saída",m.qtd,m.motivo||"",m.preco||""];
                });
                exportarXLS("movimentacoes_estoque",cab,linhas);
              }}
              onPDF={function(){
                var cab=["Data","Produto","SKU","Depósito","Tipo","Qtd","Motivo"];
                var movs=movEstoque.sort(function(a,b){return (b.id||0)-(a.id||0);}).slice(0,200);
                var linhas=movs.map(function(m){
                  var p=produtos.find(function(x){return x.id===m.produtoId;});
                  var dep=depositos.find(function(d){return d.id===m.depositoId;});
                  return [fmtDate(m.data),p?.titulo?.slice(0,35)||"",p?.sku||"",dep?.nome||"",m.tipo==="entrada"?"↑ Entrada":"↓ Saída",m.qtd,m.motivo?.slice(0,40)||""];
                });
                var entradas=movEstoque.filter(function(m){return m.tipo==="entrada";}).reduce(function(s,m){return s+m.qtd;},0);
                var saidas=movEstoque.filter(function(m){return m.tipo==="saida";}).reduce(function(s,m){return s+m.qtd;},0);
                exportarPDF("movimentacoes_estoque","Movimentações de Estoque",cab,linhas,["Total de movimentações: "+movEstoque.length,"↑ Entradas: "+entradas+" un","↓ Saídas: "+saidas+" un"]);
              }}
            />
            </div>
          </div>
          <div style={{ display:"flex", gap:7, alignItems:"center", marginBottom:8, flexWrap:"wrap", marginTop:12 }}>
            <div style={{ position:"relative", flex:1, minWidth:220 }}>
              <span style={{ position:"absolute", left:10, top:"50%", transform:"translateY(-50%)", color:"#94a3b8", fontSize:13 }}>🔍</span>
              <input value={searchEstoque} onChange={function(e){setSearchEstoque(e.target.value);}} placeholder="Buscar por produto, SKU, motivo..."
                style={{ width:"100%", background:"#fff", border:"1px solid #e2e8f0", color:"#0f172a", padding:"8px 12px 8px 32px", borderRadius:8, fontSize:13, outline:"none" }} />
            </div>
            <select value={filterDepositoEst} onChange={function(e){setFilterDepositoEst(e.target.value);}}
              style={{ background:"#fff", border:"1px solid #e2e8f0", color:"#334155", padding:"5px 8px", borderRadius:8, fontSize:12 }}>
              <option value="todos">Todos os depósitos</option>
              {depositos.map(function(d){ return <option key={d.id} value={d.id}>{d.icone} {d.nome}</option>; })}
              <option value="sem_deposito">Sem depósito</option>
            </select>
          </div>
          {depositos.length > 0 && (
            <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(150px,1fr))", gap:7, marginBottom:8 }}>
              {depositos.map(function(dep){
                var movsDep = movEstoque.filter(function(m){return m.depositoId===dep.id;});
                var entradas = movsDep.filter(function(m){return m.tipo==="entrada";}).reduce(function(s,m){return s+m.qtd;},0);
                var saidas = movsDep.filter(function(m){return m.tipo==="saida";}).reduce(function(s,m){return s+m.qtd;},0);
                var totalAtual = estoqueDepositos.filter(function(e){return e.depositoId===dep.id;}).reduce(function(s,e){return s+parseInt(e.qtd||0);},0);
                return (
                  <div key={dep.id} style={{ background:"#fff", border:"2px solid "+dep.cor+"22", borderRadius:12, padding:"14px 16px" }}>
                    <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:8 }}>
                      <div style={{ width:32, height:32, borderRadius:8, background:dep.cor, display:"flex", alignItems:"center", justifyContent:"center", fontSize:18 }}>{dep.icone}</div>
                      <div style={{ fontWeight:700, fontSize:13, color:"#0f172a" }}>{dep.nome}</div>
                    </div>
                    <div style={{ fontSize:17, fontWeight:800, color:dep.cor, marginBottom:4 }}>{totalAtual} un</div>
                    <div style={{ display:"flex", gap:8, fontSize:11 }}>
                      <span style={{ color:"#15803d" }}>↑ {entradas}</span>
                      <span style={{ color:"#dc2626" }}>↓ {saidas}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {(function(){
            var movsFiltradas = movEstoque.filter(function(m){
              if (filterDepositoEst === "todos") return true;
              if (filterDepositoEst === "sem_deposito") return !m.depositoId;
              return m.depositoId === filterDepositoEst;
            }).filter(function(m){
              if (!searchEstoque) return true;
              var q = searchEstoque.toLowerCase();
              var prod = produtos.find(function(p){return p.id===m.produtoId;});
              return (prod?.titulo||"").toLowerCase().includes(q)||(prod?.sku||"").toLowerCase().includes(q)||(m.motivo||"").toLowerCase().includes(q);
            }).sort(function(a,b){return (b.id||0)-(a.id||0);});
            if (movsFiltradas.length === 0) return (
              <div style={{ background:"#f8fafc", border:"2px dashed #e2e8f0", borderRadius:12, padding:40, textAlign:"center", color:"#94a3b8" }}>
                <div style={{ fontSize:36, marginBottom:8 }}>📋</div>
                <div style={{ fontWeight:600, marginBottom:4 }}>Nenhuma movimentação registrada</div>
                <div style={{ fontSize:13 }}>Use o botão 📦 nos produtos para registrar entradas e saídas</div>
              </div>
            );
            return (
              <div style={{ background:"#fff", border:"1px solid #e2e8f0", borderRadius:12, overflow:"auto" }}>
                <table style={{ borderCollapse:"collapse", width:"100%" }}>
                  <thead>
                    <tr>{["Data/Hora","Produto","SKU","Depósito","Tipo","Qtd","Motivo","Preço un."].map(function(h){
                      return <th key={h} style={{ fontSize:11, color:"#94a3b8", textTransform:"uppercase", letterSpacing:0.8, padding:"10px 14px", borderBottom:"1px solid #f1f5f9", textAlign:"left", fontWeight:600, background:"#fafafa", whiteSpace:"nowrap" }}>{h}</th>;
                    })}</tr>
                  </thead>
                  <tbody>
                    {movsFiltradas.slice(0,200).map(function(m,i){
                      var prod = produtos.find(function(p){return p.id===m.produtoId;});
                      var dep = depositos.find(function(d){return d.id===m.depositoId;});
                      var isEntrada = m.tipo==="entrada";
                      return (
                        <tr key={m.id} style={{ background:i%2===0?"#f8fafc":"#fff" }}>
                          <td style={{ padding:"6px 9px", fontSize:11, color:"#64748b", whiteSpace:"nowrap" }}>
                            <div>{fmtDate(m.data)}</div><div style={{ fontSize:10, color:"#94a3b8" }}>{m.hora}</div>
                          </td>
                          <td style={{ padding:"7px 10px", fontSize:11, color:"#0f172a", maxWidth:200, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{prod?.titulo||"—"}</td>
                          <td style={{ padding:"6px 9px", fontSize:11, color:"#64748b", fontFamily:"monospace" }}>{prod?.sku||"—"}</td>
                          <td style={{ padding:"10px 14px" }}>
                            {dep ? <span style={{ fontSize:12, fontWeight:600, color:dep.cor }}>{dep.icone} {dep.nome}</span>
                                 : <span style={{ fontSize:12, color:"#94a3b8" }}>—</span>}
                          </td>
                          <td style={{ padding:"10px 14px" }}>
                            <span style={{ fontSize:11, fontWeight:700, color:isEntrada?"#15803d":"#dc2626", background:isEntrada?"#f0fdf4":"#fef2f2", padding:"3px 8px", borderRadius:6 }}>
                              {isEntrada?"↑ Entrada":"↓ Saída"}
                            </span>
                          </td>
                          <td style={{ padding:"10px 14px", fontSize:14, fontWeight:800, color:isEntrada?"#15803d":"#dc2626" }}>{isEntrada?"+":"-"}{m.qtd}</td>
                          <td style={{ padding:"7px 10px", fontSize:11, color:"#64748b" }}>{m.motivo||"—"}</td>
                          <td style={{ padding:"7px 10px", fontSize:11, color:"#64748b" }}>{m.preco?("R$ "+m.preco.toFixed(2).replace(".",",")):"—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            );
          })()}
        </div>
      )}

      {/* ── PEDIDOS DE COMPRA ── */}
      {prodTab === "pedidos" && (
        <PedidosCompraTab
          produtos={produtos}
          fornecedores={fornecedores}
          setProdutos={setProdutos}
          exportarCSV={exportarCSV}
          exportarXLS={exportarXLS}
          exportarPDF={exportarPDF}
          BotaoExportar={BotaoExportar}
          fmtDate={fmtDate}
        />
      )}

      {/* ── RELATÓRIOS ── */}
      {prodTab === "relatorios" && (
        <RelatoriosEstoqueTab
          produtos={produtos}
          fornecedores={fornecedores}
          movEstoque={movEstoque}
          listings={listings}
        />
      )}

      {/* ── SUGESTÃO DE COMPRAS ── */}
      {prodTab === "sugestao" && (
        <SugestaoComprasTab
          produtos={produtos}
          fornecedores={fornecedores}
          rawOrders={rawOrders||[]}
          exportarCSV={exportarCSV}
          exportarXLS={exportarXLS}
          exportarPDF={exportarPDF}
          BotaoExportar={BotaoExportar}
          fmtDate={fmtDate}
        />
      )}

      {prodTab === "cadastros" && (
        <div>
          {/* Filtros e ações */}
          {/* Toolbar Cadastros: busca centro | ações direita */}
          <div style={{ display:"flex", gap:8, alignItems:"center", marginBottom:8, flexWrap:"wrap" }}>
            {/* Busca — centro */}
            <div style={{ position:"relative", flex:1, minWidth:180 }}>
              <span style={{ position:"absolute", left:10, top:"50%", transform:"translateY(-50%)", color:"#94a3b8", fontSize:13 }}>🔍</span>
              <input value={searchCad} onChange={function(e){ setSearchCad(e.target.value); }} placeholder="Buscar nome, CNPJ, cidade..."
                style={{ width:"100%", background:"#fff", border:"1px solid #e2e8f0", color:"#0f172a", padding:"8px 12px 8px 32px", borderRadius:8, fontSize:13, outline:"none" }} />
            </div>
            {/* Ações — direita */}
            <div style={{ display:"flex", gap:8 }}>
              <BotaoExportar
                onCSV={function(){
                  var list=fornecedoresFiltrados||fornecedores;
                  var cab=["Nome","Tipo","CNPJ/CPF","E-mail","Telefone","Cidade","Estado","Prioridade","Observação"];
                  var linhas=list.map(function(f){return [f.nome||"",f.tipo||"",f.cnpj||"",f.email||"",f.telefone||"",f.cidade||"",f.estado||"",f.prioridade||"media",f.obs||""];});
                  exportarCSV("cadastros",cab,linhas);
                }}
                onXLS={function(){
                  var list=fornecedoresFiltrados||fornecedores;
                  var cab=["Nome","Tipo","CNPJ/CPF","E-mail","Telefone","Cidade","Estado","Banco","Agência","Conta","PIX","Prioridade"];
                  var linhas=list.map(function(f){return [f.nome||"",f.tipo||"",f.cnpj||"",f.email||"",f.telefone||"",f.cidade||"",f.estado||"",f.banco||"",f.agencia||"",f.conta||"",f.pix||"",f.prioridade||"media"];});
                  exportarXLS("cadastros_completo",cab,linhas);
                }}
                onPDF={function(){
                  var list=fornecedoresFiltrados||fornecedores;
                  var cab=["Nome","Tipo","CNPJ/CPF","Cidade","Telefone","Prioridade"];
                  var linhas=list.map(function(f){return [f.nome||"",f.tipo||"",f.cnpj||"",f.cidade||"",f.telefone||"",f.prioridade||"media"];});
                  exportarPDF("cadastros","Cadastros de Fornecedores e Parceiros",cab,linhas,["Total: "+list.length+" cadastro(s)"]);
                }}
              />
              <button onClick={function(){ setEditingForn(null); setTipoPadraoCad("Fornecedor"); setShowModalForn(true); }}
                style={{ background:"#0f172a", border:"none", color:"#fff", fontWeight:700, padding:"9px 20px", borderRadius:8, cursor:"pointer", fontSize:13 }}>+ Novo Cadastro</button>
            </div>
          </div>

          {/* Filtro por tipo */}
          <div style={{ display:"flex", gap:6, marginBottom:8, flexWrap:"wrap" }}>
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
                  style={{ padding:"4px 10px", borderRadius:20, border: active ? "2px solid #0f172a" : "1px solid #e2e8f0",
                    background: active ? "#0f172a" : "#f8fafc", color: active ? "#fff" : "#64748b",
                    fontWeight:600, fontSize:12, cursor:"pointer" }}>
                  {t.icon} {t.label} <span style={{ opacity:0.7, fontSize:11 }}>({count})</span>
                </button>
              );
            })}
          </div>

          {/* Cards de ação rápida para criar */}
          {fornecedores.length === 0 && (
            <div style={{ marginBottom:10 }}>
              <div style={{ fontSize:13, color:"#64748b", marginBottom:12, fontWeight:600 }}>Criar novo cadastro:</div>
              <div style={{ display:"flex", gap:7, flexWrap:"wrap" }}>
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
                      {f.prioridade && (
                        <span style={{ position:"absolute", top:12, right:46, fontSize:10, fontWeight:800,
                          color: f.prioridade==="alta"?"#dc2626":f.prioridade==="baixa"?"#15803d":"#d97706",
                          background: f.prioridade==="alta"?"#fef2f2":f.prioridade==="baixa"?"#f0fdf4":"#fffbeb",
                          padding:"2px 7px", borderRadius:6,
                          border: "1px solid " + (f.prioridade==="alta"?"#fecaca":f.prioridade==="baixa"?"#bbf7d0":"#fde68a") }}>
                          {f.prioridade==="alta"?"!!!":f.prioridade==="baixa"?"!":"!!"}
                        </span>
                      )}
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
                      {(f.multaPct || f.jurosDia || f.temProtesto) && (
                        <div style={{ marginTop:8, paddingTop:8, borderTop:"1px solid #f1f5f9", display:"flex", gap:8, flexWrap:"wrap" }}>
                          {f.multaPct && <span style={{ fontSize:10, color:"#d97706", background:"#fffbeb", padding:"1px 6px", borderRadius:4, fontWeight:600 }}>Multa {f.multaPct}{f.multaTipo||"%"}</span>}
                          {f.jurosDia && <span style={{ fontSize:10, color:"#d97706", background:"#fffbeb", padding:"1px 6px", borderRadius:4, fontWeight:600 }}>Juros {f.jurosDia}{f.jurosTipo||"%"}/dia</span>}
                          {f.temProtesto && <span style={{ fontSize:10, color:"#7c3aed", background:"#f5f3ff", padding:"1px 6px", borderRadius:4, fontWeight:600 }}>⚖️ Protesta {f.diasProtesto ? "em "+f.diasProtesto+"d" : ""}</span>}
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
          <Paginacao total={produtosFiltrados.length} porPagina={POR_PAG_PROD} paginaAtual={paginaProdutos} onMudar={function(p){setPaginaProdutos(p);window.scrollTo({top:0,behavior:"smooth"});}} />
        </div>
      )}

      {showModalProd && <ModalProduto produto={editingProd} fornecedores={fornecedores} listings={listings} produtos={produtos} onSave={saveProd} onClose={() => { setShowModalProd(false); setEditingProd(null); }} />}
      {showModalDeposito && (
        <ModalDeposito
          deposito={editingDeposito}
          onSave={salvarDeposito}
          onClose={function(){ setShowModalDeposito(false); setEditingDeposito(null); }}
        />
      )}
      {showTransfEstoque && depositos.length >= 2 && (
        <ModalTransfEstoque
          produto={showTransfEstoque}
          depositos={depositos}
          estoqueDepositos={estoqueDepositos}
          onConfirm={function(origemId, destinoId, qtd){
            transferirEstoque(showTransfEstoque.id, origemId, destinoId, qtd);
            setShowTransfEstoque(null);
          }}
          onClose={function(){ setShowTransfEstoque(null); }}
        />
      )}
      {showMovEstoque && (
        <ModalMovEstoque
          produto={showMovEstoque}
          movEstoque={movEstoque}
          onRegistrar={function(prodId, sku, tipo, qtd, motivo, preco) {
            var mov = { id: Date.now(), produtoId: prodId, sku: sku, tipo: tipo, qtd: parseInt(qtd),
              motivo: motivo||"", preco: parseFloat(preco||0)||null,
              data: new Date().toLocaleDateString("sv-SE"),
              hora: new Date().toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"}) };
            var novas = [...movEstoque, mov];
            setMovEstoque(novas);
            localStorage.setItem("mov_estoque", JSON.stringify(novas));
            // Atualizar estoque do produto
            var upd = produtos.map(function(p) {
              if (p.id===prodId || (sku && p.sku===sku)) {
                var atual = parseInt(p.estoqueAtual||0);
                var novo = tipo==="entrada" ? atual+mov.qtd : Math.max(0,atual-mov.qtd);
                return Object.assign({},p,{estoqueAtual:String(novo)});
              }
              return p;
            });
            setProdutos(upd); localStorage.setItem("produtos", JSON.stringify(upd));
            // Atualizar produto mostrado no modal
            var prodAtualizado = upd.find(function(p){ return p.id===prodId; });
            if (prodAtualizado) setShowMovEstoque(prodAtualizado);
          }}
          onClose={function(){ setShowMovEstoque(null); }}
        />
      )}
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
  var BT = String.fromCharCode(96);
  var re1 = new RegExp(BT+BT+BT+'json[\\s\\S]*?'+BT+BT+BT, 'g');
  var re2 = new RegExp(BT+BT+BT, 'g');
  var clean = text.replace(re1, function(m) { return m.slice(7, -3); });
  clean = clean.replace(re2, '').trim();
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

function PainelIAPagamentos({ contasPagar=[], contasBancarias=[], lancamentos=[], enrichedOrders=[], paymentData, shipmentStatuses }) {
  const [aba, setAba] = useState("prioridade");
  const [state, setState] = useState("idle");
  const [result, setResult] = useState(null);
  const [errorMsg, setErrorMsg] = useState("");
  const [autoAnalise, setAutoAnalise] = useState(false); // se já rodou auto

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
    try {
      if (!import.meta.env.VITE_ANTHROPIC_KEY) { setErrorMsg("Configure VITE_ANTHROPIC_KEY nas variáveis de ambiente do Vercel"); setState("error"); return false; }
      return true;
    } catch(e) {
      setErrorMsg("Chave da API não configurada"); setState("error"); return false;
    }
  }

  // Análise automática ao abrir o painel — usa saldo real das contas
  useEffect(function() {
    try {
      if (autoAnalise) return; // já rodou
      if (contasPendentes.length === 0) return;
      // Só roda automaticamente se tiver chave configurada
      var temChave = false;
      try { temChave = !!import.meta.env.VITE_ANTHROPIC_KEY; } catch(e) {}
      if (!temChave) return;
      setAutoAnalise(true);
      var t = setTimeout(function() {
        try { analisarPrioridade(true); } catch(e) {}
      }, 800);
      return function() { clearTimeout(t); };
    } catch(e) {}
  }, []); // eslint-disable-line

  async function analisarPrioridade(auto) {
    if (!checkKey()) return;
    if (contasPendentes.length === 0) { setErrorMsg("Nenhuma conta pendente"); setState("error"); return; }
    setState("loading"); setErrorMsg("");
    try {
      // Usa sempre o saldo total real das contas bancárias
      const r = await analisarPrioridadePagamentos(contasPendentes, saldoTotal);
      setResult(r); setState("done");
    } catch(e) { setErrorMsg(e.message); setState("error"); }
  }

  async function analisarEmprestimoFn() {
    if (!checkKey()) return;
    const taxa = parseFloat(taxaEmprestimo) || 3;
    const prazo = parseInt(prazoEmprestimo) || 12;
    // Se não informou valor, sugere automaticamente o total das contas vencidas
    const valorSugerido = totalVencido > 0 ? totalVencido : totalPendente;
    const valor = parseFloat(valorEmprestimo) || valorSugerido;
    if (valor <= 0) { setErrorMsg("Nenhuma conta pendente para análise"); setState("error"); return; }
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
    <div style={{ background:"#fff", border:"1px solid #e2e8f0", borderRadius:16, padding:"24px 28px", marginBottom:10, boxShadow:"0 1px 3px rgba(0,0,0,.06)" }}>
      {/* Header */}
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:7, marginBottom:8 }}>
        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
          <div style={{ width:44, height:44, borderRadius:12, background:"linear-gradient(135deg,#667eea,#764ba2)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:22 }}>✦</div>
          <div>
            <div style={{ fontWeight:800, fontSize:16, color:"#0f172a" }}>Consultoria Financeira com IA</div>
            <div style={{ fontSize:12, color:"#94a3b8" }}>Análise automática com os dados reais da sua empresa</div>
          </div>
        </div>
        {/* Indicador de atualização automática */}
        <div style={{ background:"#f0fdf4", border:"1px solid #bbf7d0", borderRadius:8, padding:"6px 12px", display:"flex", alignItems:"center", gap:6 }}>
          <div style={{ width:8, height:8, borderRadius:"50%", background:"#15803d", animation:"pulse 2s infinite" }} />
          <span style={{ fontSize:11, color:"#15803d", fontWeight:600 }}>Análise automática ativa</span>
        </div>
      </div>

      {/* Dashboard de situação atual */}
      <div style={{ display:"grid", gridTemplateColumns:"repeat(5,1fr)", gap:8, marginBottom:8 }}>
        {[
          { label:"Saldo em Caixa",   value: "R$ " + saldoTotal.toFixed(2).replace(".",","),       color: saldoTotal > 0 ? "#15803d" : "#dc2626", bg: saldoTotal > 0 ? "#f0fdf4" : "#fef2f2" },
          { label:"Total Pendente",   value: "R$ " + totalPendente.toFixed(2).replace(".",","),    color: "#d97706", bg:"#fffbeb" },
          { label:"Vencidas",         value: contasVencidas.length + " contas", color:"#dc2626", bg:"#fef2f2" },
          { label:"Protestadas",      value: contasProtestadas.length + " contas",                  color:"#7c3aed", bg:"#f5f3ff" },
          { label:"Encargos/Juros",   value: "R$ " + totalEncargos.toFixed(2).replace(".",","),    color:"#dc2626", bg:"#fef2f2" },
        ].map(function(k) {
          return (
            <div key={k.label} style={{ background:k.bg, borderRadius:10, padding:"10px 12px", textAlign:"center" }}>
              <div style={{ fontSize:10, color:k.color, fontWeight:700, textTransform:"uppercase", marginBottom:4 }}>{k.label}</div>
              <div style={{ fontSize:13, fontWeight:800, color:k.color }}>{k.value}</div>
            </div>
          );
        })}
      </div>

      {/* Cards de situação */}
      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(130px,1fr))", gap:7, marginBottom:10 }}>
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
      <div style={{ display:"flex", gap:4, marginBottom:10, background:"#f1f5f9", padding:4, borderRadius:10, flexWrap:"wrap" }}>
        {ABAS.map(function(a) {
          var active = aba === a.key;
          return (
            <button key={a.key} onClick={function(){ setAba(a.key); setState("idle"); setResult(null); setErrorMsg(""); }}
              style={{ flex:1, padding:"5px 8px", borderRadius:8, border:"none", cursor:"pointer", fontFamily:"inherit", fontSize:12, fontWeight: active?700:500,
                background: active?"#fff":"transparent", color: active?"#0f172a":"#94a3b8",
                boxShadow: active?"0 1px 3px rgba(0,0,0,.08)":"none", whiteSpace:"nowrap" }}>
              {a.label}
            </button>
          );
        })}
      </div>

      {/* Erro */}
      {state === "error" && (
        <div style={{ marginBottom:8 }}>
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
          <div style={{ background:"#f0f9ff", border:"1px solid #bae6fd", borderRadius:10, padding:"14px 16px", marginBottom:8 }}>
            <div style={{ fontWeight:700, fontSize:13, color:"#0369a1", marginBottom:4 }}>🤖 Análise automática ativada</div>
            <div style={{ fontSize:12, color:"#0369a1" }}>
              Usando saldo real: <strong>R$ {saldoTotal.toFixed(2).replace(".",",")}</strong> em {contasBancarias.length} conta(s) bancária(s) · {contasPendentes.length} contas pendentes para analisar.
            </div>
          </div>
          <button onClick={function(){ analisarPrioridade(false); }}
            style={{ width:"100%", background:"linear-gradient(135deg,#667eea,#764ba2)", border:"none", color:"#fff", fontWeight:700, padding:"13px", borderRadius:12, cursor:"pointer", fontSize:15 }}>
            🔄 Reanalisar Prioridades
          </button>
        </div>
      )}

      {/* ── ABA: EMPRÉSTIMO ── */}
      {state === "idle" && aba === "emprestimo" && (
        <div>
          {contasVencidas.length === 0 && contasProtestadas.length === 0 && (
            <div style={{ background:"#f0fdf4", border:"1px solid #bbf7d0", borderRadius:10, padding:"12px 16px", marginBottom:8, fontSize:13, color:"#15803d" }}>
              ✓ Nenhuma conta vencida ou protestada. A análise vai considerar suas contas pendentes.
            </div>
          )}
          {(contasVencidas.length > 0 || contasProtestadas.length > 0) && (
            <div style={{ background:"#fef2f2", border:"1px solid #fecaca", borderRadius:10, padding:"12px 16px", marginBottom:8, fontSize:13, color:"#dc2626" }}>
              🚨 {contasVencidas.length} conta(s) vencida(s) e {contasProtestadas.length} protestada(s) — custo total de encargos: R$ {totalEncargos.toFixed(2).replace(".",",")}
            </div>
          )}
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:8, marginBottom:10 }}>
            <div>
              <div style={{ fontSize:11, color:"#94a3b8", marginBottom:6, fontWeight:600, textTransform:"uppercase" }}>Valor (deixe vazio para usar sugerido)</div>
              <input type="number" value={valorEmprestimo} onChange={function(e){ setValorEmprestimo(e.target.value); }}
                placeholder={"Sugerido: " + (totalVencido > 0 ? totalVencido : totalPendente).toFixed(0)}
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
              <div style={{ background:"#f8fafc", borderRadius:10, padding:"12px 14px", marginBottom:8, display:"flex", gap:20 }}>
                <div>
                  <div style={{ fontSize:11, color:"#94a3b8" }}>Parcela estimada</div>
                  <div style={{ fontSize:14, fontWeight:800, color:"#0f172a" }}>R$ {parcela.toFixed(2).replace(".",",")}/mês</div>
                </div>
                <div>
                  <div style={{ fontSize:11, color:"#94a3b8" }}>Custo total</div>
                  <div style={{ fontSize:14, fontWeight:800, color:"#dc2626" }}>R$ {custo.toFixed(2).replace(".",",")}</div>
                </div>
                <div>
                  <div style={{ fontSize:11, color:"#94a3b8" }}>Juros totais</div>
                  <div style={{ fontSize:14, fontWeight:800, color:"#d97706" }}>R$ {(custo - v).toFixed(2).replace(".",",")}</div>
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
          <div style={{ background:"#f0f9ff", border:"1px solid #bae6fd", borderRadius:10, padding:"12px 16px", marginBottom:8, fontSize:13, color:"#0369a1" }}>
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
        <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
          <div style={{ background:"linear-gradient(135deg,#667eea22,#764ba222)", border:"1px solid #667eea44", borderRadius:12, padding:"10px 14px" }}>
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
          <div style={{ background:"#fffbeb", border:"1px solid #fde68a", borderRadius:12, padding:"10px 14px" }}>
            <div style={{ fontSize:11, color:"#92400e", fontWeight:700, textTransform:"uppercase", marginBottom:6 }}>✦ Recomendação Final</div>
            <div style={{ fontSize:13, color:"#1c1917", lineHeight:1.6 }}>{result.recomendacao_final}</div>
          </div>
          <button onClick={function(){ setState("idle"); setResult(null); }} style={{ background:"#f8fafc", border:"1px solid #e2e8f0", color:"#64748b", fontWeight:600, padding:"10px", borderRadius:10, cursor:"pointer" }}>Nova Análise</button>
        </div>
      )}

      {/* ── RESULTADO: EMPRÉSTIMO ── */}
      {state === "done" && result && aba === "emprestimo" && (
        <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
          <div style={{ background: result.viavel ? "#f0fdf4" : "#fef2f2", border:"1px solid " + (result.viavel ? "#bbf7d0" : "#fecaca"), borderRadius:12, padding:"16px 20px", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
            <div>
              <div style={{ fontSize:11, color: result.viavel?"#15803d":"#dc2626", fontWeight:700, textTransform:"uppercase", marginBottom:4 }}>Veredito da IA</div>
              <div style={{ fontSize:17, fontWeight:800, color: result.viavel?"#15803d":"#dc2626" }}>{result.viavel ? "✅ Empréstimo Recomendado" : "⚠️ Cautela — Avalie Alternativas"}</div>
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
          <div style={{ background:"#f8fafc", borderRadius:12, padding:"10px 14px" }}>
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
          <div style={{ background:"#f8fafc", borderRadius:12, padding:"10px 14px" }}>
            <div style={{ fontSize:11, color:"#94a3b8", fontWeight:700, textTransform:"uppercase", marginBottom:10 }}>🔀 Alternativas ao Empréstimo</div>
            <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
              {(result.alternativas||[]).map(function(a, i) {
                return <div key={i} style={{ display:"flex", gap:8, alignItems:"flex-start" }}><span style={{ color:"#667eea", fontWeight:700, flexShrink:0 }}>{i+1}.</span><span style={{ fontSize:13, color:"#334155" }}>{a}</span></div>;
              })}
            </div>
          </div>
          <div style={{ background:"linear-gradient(135deg,#667eea22,#764ba222)", border:"1px solid #667eea44", borderRadius:12, padding:"10px 14px" }}>
            <div style={{ fontSize:11, color:"#4338ca", fontWeight:700, textTransform:"uppercase", marginBottom:6 }}>✦ Recomendação</div>
            <div style={{ fontSize:13, color:"#0f172a", lineHeight:1.6 }}>{result.recomendacao}</div>
          </div>
          <div style={{ background:"#f8fafc", borderRadius:12, padding:"10px 14px" }}>
            <div style={{ fontSize:11, color:"#94a3b8", fontWeight:700, textTransform:"uppercase", marginBottom:10 }}>🗒️ Plano de Ação</div>
            <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
              {(result.plano_acao||[]).map(function(p, i) {
                return (
                  <div key={i} style={{ display:"flex", gap:7, alignItems:"flex-start" }}>
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
        <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
          <div style={{ background:"#f0f9ff", border:"1px solid #bae6fd", borderRadius:10, padding:"7px 10px", fontSize:11, color:"#0369a1" }}>
            💬 "{pergunta}"
          </div>
          <div style={{ background: situacaoBg(result.situacao), border:"1px solid " + situacaoCor(result.situacao) + "44", borderRadius:12, padding:"10px 14px" }}>
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
                    <div style={{ fontSize:9, color:"#94a3b8", fontWeight:600, textTransform:"uppercase", marginBottom:3 }}>{ind.label}</div>
                    <div style={{ fontSize:15, fontWeight:800, color:statusCor(ind.status) }}>{ind.valor}</div>
                  </div>
                );
              })}
            </div>
          )}
          {(result.acoes_imediatas||[]).length > 0 && (
            <div style={{ background:"#f8fafc", borderRadius:12, padding:"10px 14px" }}>
              <div style={{ fontSize:11, color:"#94a3b8", fontWeight:700, textTransform:"uppercase", marginBottom:10 }}>⚡ Ações Imediatas</div>
              <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
                {result.acoes_imediatas.map(function(a, i) {
                  return (
                    <div key={i} style={{ display:"flex", gap:7, alignItems:"flex-start" }}>
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
function ModalTransferencia({ contasBancarias, onConfirm, onClose }) {
  var hoje = new Date().toLocaleDateString("sv-SE");
  const [origem, setOrigem] = useState(contasBancarias[0]?.id || "");
  const [destino, setDestino] = useState(contasBancarias[1]?.id || "");
  const [valor, setValor] = useState("");
  const [descricao, setDescricao] = useState("");
  const [data, setData] = useState(hoje);
  const [erro, setErro] = useState("");

  var contaOrigem = contasBancarias.find(function(c){ return c.id === origem; });
  var contaDestino = contasBancarias.find(function(c){ return c.id === destino; });

  function handleSubmit() {
    if (!origem || !destino) { setErro("Selecione as contas de origem e destino"); return; }
    if (origem === destino) { setErro("Origem e destino não podem ser a mesma conta"); return; }
    var v = parseFloat(valor);
    if (!v || v <= 0) { setErro("Informe um valor válido"); return; }
    if (!data) { setErro("Informe a data da transferência"); return; }
    setErro("");
    onConfirm(origem, destino, v, descricao, data);
  }

  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(15,23,42,.6)", backdropFilter:"blur(4px)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:600, padding:24 }}>
      <div style={{ background:"#fff", borderRadius:16, width:"100%", maxWidth:480, padding:"28px 32px", boxShadow:"0 20px 60px rgba(0,0,0,.15)" }}>
        {/* Header */}
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:10 }}>
          <div>
            <div style={{ fontWeight:800, fontSize:17, color:"#0f172a" }}>⇄ Transferência entre Contas</div>
            <div style={{ fontSize:12, color:"#94a3b8", marginTop:3 }}>Mova valores entre suas contas bancárias</div>
          </div>
          <button onClick={onClose} style={{ background:"#f1f5f9", border:"none", color:"#64748b", width:32, height:32, borderRadius:8, cursor:"pointer", fontSize:16 }}>✕</button>
        </div>

        {/* Seleção visual de contas */}
        <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom:10 }}>
          <div style={{ flex:1 }}>
            <div style={{ fontSize:11, color:"#94a3b8", fontWeight:600, textTransform:"uppercase", marginBottom:6 }}>De (Origem)</div>
            <select value={origem} onChange={function(e){ setOrigem(e.target.value); setErro(""); }}
              style={{ width:"100%", background:"#f8fafc", border:"1px solid #e2e8f0", color:"#0f172a", padding:"10px 12px", borderRadius:10, fontSize:13 }}>
              {contasBancarias.map(function(c){
                return <option key={c.id} value={c.id}>{c.nome}</option>;
              })}
            </select>
          </div>

          <div style={{ marginTop:18, fontSize:20, color:"#0891b2", fontWeight:700 }}>→</div>

          <div style={{ flex:1 }}>
            <div style={{ fontSize:11, color:"#94a3b8", fontWeight:600, textTransform:"uppercase", marginBottom:6 }}>Para (Destino)</div>
            <select value={destino} onChange={function(e){ setDestino(e.target.value); setErro(""); }}
              style={{ width:"100%", background:"#f8fafc", border:"1px solid #e2e8f0", color:"#0f172a", padding:"10px 12px", borderRadius:10, fontSize:13 }}>
              {contasBancarias.filter(function(c){ return c.id !== origem; }).map(function(c){
                return <option key={c.id} value={c.id}>{c.nome}</option>;
              })}
            </select>
          </div>
        </div>

        {/* Resumo visual */}
        {contaOrigem && contaDestino && origem !== destino && (
          <div style={{ background:"#f0f9ff", border:"1px solid #bae6fd", borderRadius:10, padding:"12px 16px", marginBottom:8, display:"flex", alignItems:"center", gap:12 }}>
            <div style={{ flex:1, textAlign:"center" }}>
              <div style={{ display:"flex", alignItems:"center", justifyContent:"center", gap:6, marginBottom:4 }}>
                <div style={{ width:8, height:8, borderRadius:"50%", background:contaOrigem.cor||"#64748b" }} />
                <span style={{ fontSize:12, fontWeight:600, color:"#0f172a" }}>{contaOrigem.nome}</span>
              </div>
              <div style={{ fontSize:11, color:"#64748b" }}>{contaOrigem.tipo||"Conta"}</div>
            </div>
            <div style={{ fontSize:18, color:"#0891b2" }}>⇄</div>
            <div style={{ flex:1, textAlign:"center" }}>
              <div style={{ display:"flex", alignItems:"center", justifyContent:"center", gap:6, marginBottom:4 }}>
                <div style={{ width:8, height:8, borderRadius:"50%", background:contaDestino.cor||"#64748b" }} />
                <span style={{ fontSize:12, fontWeight:600, color:"#0f172a" }}>{contaDestino.nome}</span>
              </div>
              <div style={{ fontSize:11, color:"#64748b" }}>{contaDestino.tipo||"Conta"}</div>
            </div>
          </div>
        )}

        {/* Campos */}
        <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
          <div>
            <div style={{ fontSize:11, color:"#94a3b8", fontWeight:600, textTransform:"uppercase", marginBottom:6 }}>Valor (R$) *</div>
            <input type="number" step="0.01" value={valor} onChange={function(e){ setValor(e.target.value); setErro(""); }}
              placeholder="0,00" autoFocus
              style={{ width:"100%", background:"#f8fafc", border:"1px solid #e2e8f0", color:"#0f172a", padding:"10px 14px", borderRadius:10, fontSize:16, fontWeight:700, outline:"none" }} />
          </div>

          <div>
            <div style={{ fontSize:11, color:"#94a3b8", fontWeight:600, textTransform:"uppercase", marginBottom:6 }}>Data *</div>
            <input type="date" value={data} onChange={function(e){ setData(e.target.value); setErro(""); }}
              style={{ width:"100%", background:"#f8fafc", border:"1px solid #e2e8f0", color:"#0f172a", padding:"10px 14px", borderRadius:10, fontSize:13, outline:"none" }} />
          </div>

          <div>
            <div style={{ fontSize:11, color:"#94a3b8", fontWeight:600, textTransform:"uppercase", marginBottom:6 }}>Descrição (opcional)</div>
            <input value={descricao} onChange={function(e){ setDescricao(e.target.value); }}
              placeholder={"Transferência de " + (contaOrigem?.nome||"") + " para " + (contaDestino?.nome||"")}
              style={{ width:"100%", background:"#f8fafc", border:"1px solid #e2e8f0", color:"#0f172a", padding:"10px 14px", borderRadius:10, fontSize:13, outline:"none" }} />
          </div>
        </div>

        {erro && (
          <div style={{ background:"#fef2f2", border:"1px solid #fecaca", borderRadius:8, padding:"10px 14px", marginTop:14, fontSize:12, color:"#dc2626", fontWeight:600 }}>
            ⚠️ {erro}
          </div>
        )}

        {/* Ações */}
        <div style={{ display:"flex", gap:7, marginTop:22 }}>
          <button onClick={onClose}
            style={{ flex:1, background:"#f8fafc", border:"1px solid #e2e8f0", color:"#64748b", fontWeight:600, padding:"12px", borderRadius:10, cursor:"pointer", fontSize:13 }}>
            Cancelar
          </button>
          <button onClick={handleSubmit} disabled={!valor || !origem || !destino || origem===destino}
            style={{ flex:2, background: (!valor||!origem||!destino||origem===destino) ? "#f1f5f9" : "#0891b2",
              border:"none", color: (!valor||!origem||!destino||origem===destino) ? "#94a3b8" : "#fff",
              fontWeight:700, padding:"12px", borderRadius:10, cursor: (!valor||!origem||!destino||origem===destino) ? "not-allowed" : "pointer", fontSize:14 }}>
            ⇄ Confirmar Transferência
            {valor && parseFloat(valor) > 0 && <span style={{ marginLeft:6, fontSize:13, opacity:0.9 }}>de R$ {parseFloat(valor).toFixed(2).replace(".",",")}</span>}
          </button>
        </div>
      </div>
    </div>
  );
}

function ModalContaBancaria({ conta, onSave, onClose }) {
  const [form, setForm] = useState(conta || { id: Date.now(), nome: "", tipo: "Conta Corrente", banco: "", saldoInicial: "0", cor: "#0891b2" });
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const TIPOS = ["Caixa", "Conta Corrente", "Conta Poupança", "Conta PJ", "Mercado Pago", "Outro"];
  const CORES = ["#0891b2","#15803d","#7c3aed","#d97706","#dc2626","#0f172a","#64748b"];
  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(15,23,42,.6)", backdropFilter:"blur(4px)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:500, padding:24 }}>
      <div style={{ background:"#fff", borderRadius:16, width:"100%", maxWidth:440, padding:"28px 32px", boxShadow:"0 20px 60px rgba(0,0,0,.15)" }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:10 }}>
          <div style={{ fontWeight:800, fontSize:17, color:"#0f172a" }}>{conta ? "Editar Conta" : "Nova Conta"}</div>
          <button onClick={onClose} style={{ background:"#f1f5f9", border:"none", color:"#64748b", width:32, height:32, borderRadius:8, cursor:"pointer", fontSize:16 }}>✕</button>
        </div>
        <div style={{ display:"flex", flexDirection:"column", gap:8, marginBottom:10 }}>
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
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8 }}>
          <div style={{ fontWeight:800, fontSize:17, color:"#0f172a" }}>💸 Dar Baixa</div>
          <button onClick={onClose} style={{ background:"#f1f5f9", border:"none", color:"#64748b", width:32, height:32, borderRadius:8, cursor:"pointer", fontSize:16 }}>✕</button>
        </div>
        <div style={{ background:"#f8fafc", borderRadius:10, padding:"12px 16px", marginBottom:8 }}>
          <div style={{ fontSize:12, color:"#94a3b8", marginBottom:2 }}>Conta a pagar</div>
          <div style={{ fontSize:14, fontWeight:700, color:"#0f172a" }}>{conta.descricao}</div>
          <div style={{ fontSize:14, fontWeight:800, color:"#dc2626", marginTop:4 }}>R$ {valorTotal.toFixed(2).replace(".",",")}</div>
        </div>
        <div style={{ display:"flex", flexDirection:"column", gap:8, marginBottom:10 }}>
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
            <div style={{ fontSize:15, fontWeight:800, color: tipoPagamento==="total" ? "#15803d" : "#d97706" }}>
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
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8 }}>
          <div style={{ fontWeight:800, fontSize:17, color:"#0f172a" }}>💸 Baixa em Lote</div>
          <button onClick={onClose} style={{ background:"#f1f5f9", border:"none", color:"#64748b", width:32, height:32, borderRadius:8, cursor:"pointer", fontSize:16 }}>✕</button>
        </div>
        <div style={{ background:"#f8fafc", borderRadius:10, padding:"12px 16px", marginBottom:8, maxHeight:160, overflowY:"auto" }}>
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
        <div style={{ background:"#fef2f2", borderRadius:8, padding:"10px 14px", marginBottom:8, display:"flex", justifyContent:"space-between", alignItems:"center" }}>
          <span style={{ fontSize:13, fontWeight:600, color:"#dc2626" }}>Total a pagar</span>
          <span style={{ fontSize:17, fontWeight:800, color:"#dc2626" }}>R$ {total.toFixed(2).replace(".",",")}</span>
        </div>
        <div style={{ display:"flex", flexDirection:"column", gap:8, marginBottom:10 }}>
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
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8 }}>
          <div style={{ fontWeight:800, fontSize:17, color:"#0f172a" }}>Registrar Recebimento</div>
          <button onClick={onClose} style={{ background:"#f1f5f9", border:"none", color:"#64748b", width:32, height:32, borderRadius:8, cursor:"pointer", fontSize:16 }}>✕</button>
        </div>
        <div style={{ background: isValorReal?"#f0fdf4":isValorCalc?"#eff6ff":"#fffbeb", borderRadius:10, padding:"12px 16px", marginBottom:8 }}>
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
              <div style={{ fontSize:17, fontWeight:800, color: isValorReal?"#15803d":"#0891b2" }}>
                R$ {valor.toFixed(2).replace(".",",")}
              </div>
            </div>
          </div>
        </div>
        <div style={{ display:"flex", flexDirection:"column", gap:8, marginBottom:10 }}>
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
              <div key={i} style={{ display:"flex", alignItems:"center", gap:7, background:"#f8fafc", border:"1px solid #e2e8f0", borderRadius:8, padding:"5px 8px" }}>
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
function ModalConta({ conta, categoriasPagar, fornecedores, contasPagar, onSave, onClose }) {
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
    // Buscar histórico de contas desse fornecedor para extrair padrões
    var historico = (contasPagar || []).filter(function(c) {
      return c.fornecedorId === forn.id || c.fornecedorNome === forn.nome;
    });

    // Calcular valores mais frequentes/recentes do histórico
    var ultimaConta = historico.sort(function(a,b){ return (b.id||0)-(a.id||0); })[0];

    // Valores padrão do fornecedor baseados no histórico
    var multaTipo   = ultimaConta?.multaTipo   || "%";
    var multaPct    = ultimaConta?.multaPct    || "";
    var jurosTipo   = ultimaConta?.jurosTipo   || "%";
    var jurosDia    = ultimaConta?.jurosDia    || "";
    var temProtesto = ultimaConta?.temProtesto || false;
    var diasProtesto = ultimaConta?.diasProtesto || "";
    var cartorio    = ultimaConta?.cartorio    || "";
    var categoria   = ultimaConta?.categoria   || "";
    // Prioridade: usar do próprio cadastro do fornecedor se disponível, senão histórico de contas
    var fornCadastrado = (fornecedores||[]).find(function(f){ return f.id === forn.id; });
    var prioridade  = fornCadastrado?.prioridade || ultimaConta?.prioridade || "media";
    // Condições do fornecedor (cadastro tem precedência sobre histórico)
    if (fornCadastrado?.multaPct)     multaPct     = fornCadastrado.multaPct;
    if (fornCadastrado?.multaTipo)    multaTipo    = fornCadastrado.multaTipo;
    if (fornCadastrado?.jurosDia)     jurosDia     = fornCadastrado.jurosDia;
    if (fornCadastrado?.jurosTipo)    jurosTipo    = fornCadastrado.jurosTipo;
    if (fornCadastrado?.temProtesto)  temProtesto  = fornCadastrado.temProtesto;
    if (fornCadastrado?.diasProtesto) diasProtesto = fornCadastrado.diasProtesto;
    if (fornCadastrado?.cartorio)     cartorio     = fornCadastrado.cartorio;

    setForm(function(f) {
      return Object.assign({}, f, {
        descricao: forn.nome,
        fornecedorId: forn.id,
        fornecedorNome: forn.nome,
        fornecedorCNPJ: forn.cnpj || "",
        // Preencher com histórico
        multaTipo:    multaTipo,
        multaPct:     multaPct,
        jurosTipo:    jurosTipo,
        jurosDia:     jurosDia,
        temProtesto:  temProtesto,
        diasProtesto: diasProtesto,
        cartorio:     cartorio,
        categoria:    categoria || f.categoria,
        prioridade:   prioridade,
        _historicoPreenchido: historico.length > 0,
        _qtdHistorico: historico.length,
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

        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:10 }}>
          <div style={{ fontWeight:800, fontSize:17, color:"#0f172a" }}>{conta ? "Editar Conta" : "Nova Conta a Pagar"}</div>
          <button onClick={onClose} style={{ background:"#f1f5f9", border:"none", color:"#64748b", width:32, height:32, borderRadius:8, cursor:"pointer", fontSize:16 }}>✕</button>
        </div>

        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, marginBottom:10 }}>

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
                  var hist = (contasPagar||[]).filter(function(c){ return c.fornecedorId===f.id||c.fornecedorNome===f.nome; });
                  var ultima = hist.sort(function(a,b){return (b.id||0)-(a.id||0);})[0];
                  return (
                    <div key={f.id} onClick={function() { selecionarForn(f); }}
                      style={{ padding:"10px 14px", cursor:"pointer", borderBottom:"1px solid #f1f5f9", fontSize:13, transition:"background .1s" }}
                      onMouseEnter={function(e){e.currentTarget.style.background="#f8fafc";}}
                      onMouseLeave={function(e){e.currentTarget.style.background="";}}
                    >
                      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between" }}>
                        <div style={{ fontWeight:600, color:"#0f172a" }}>{f.nome}</div>
                        {hist.length > 0 && <span style={{ fontSize:10, background:"#eff6ff", color:"#1d4ed8", padding:"1px 6px", borderRadius:4, fontWeight:600 }}>{hist.length} conta(s)</span>}
                      </div>
                      {f.cnpj && <div style={{ fontSize:11, color:"#94a3b8" }}>{f.cnpj}</div>}
                      {ultima && (
                        <div style={{ display:"flex", gap:8, marginTop:4, flexWrap:"wrap" }}>
                          {ultima.multaPct && <span style={{ fontSize:10, color:"#d97706" }}>Multa: {ultima.multaPct}{ultima.multaTipo}</span>}
                          {ultima.jurosDia && <span style={{ fontSize:10, color:"#d97706" }}>Juros: {ultima.jurosDia}{ultima.jurosTipo}/dia</span>}
                          {ultima.temProtesto && <span style={{ fontSize:10, color:"#7c3aed" }}>⚖️ Protesta em {ultima.diasProtesto}d</span>}
                          {ultima.categoria && <span style={{ fontSize:10, color:"#64748b" }}>{ultima.categoria}</span>}
                        </div>
                      )}
                    </div>
                  );
                })}
                <div style={{ padding:"4px 10px", background:"#f8fafc", borderTop:"1px solid #f1f5f9", fontSize:11, color:"#94a3b8" }}>
                  🤖 Selecione para preencher multa, juros e protesto automaticamente
                </div>
              </div>
            )}
            {form.fornecedorNome && (
              <div style={{ display:"flex", alignItems:"center", gap:6, marginTop:6, flexWrap:"wrap" }}>
                <span style={{ fontSize:11, background:"#f0fdf4", color:"#15803d", border:"1px solid #bbf7d0", borderRadius:6, padding:"2px 8px", fontWeight:600 }}>✓ {form.fornecedorNome}</span>
                {form.fornecedorCNPJ && <span style={{ fontSize:11, color:"#94a3b8" }}>CNPJ: {form.fornecedorCNPJ}</span>}
                {form._historicoPreenchido && (
                  <span style={{ fontSize:11, background:"#eff6ff", color:"#1d4ed8", border:"1px solid #bfdbfe", borderRadius:6, padding:"2px 8px", fontWeight:600 }}>
                    🤖 {form._qtdHistorico} histórico(s) — multa, juros e protesto preenchidos automaticamente
                  </span>
                )}
                {form.fornecedorNome && !form._historicoPreenchido && (contasPagar||[]).length > 0 && (
                  <span style={{ fontSize:11, color:"#94a3b8" }}>Primeiro cadastro deste fornecedor</span>
                )}
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
                    style={{ padding:"4px 10px", borderRadius:20, border:"none", cursor:"pointer", fontSize:12, fontWeight:600,
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
                <div style={{ marginTop:10, background:"#eff6ff", borderRadius:8, padding:"5px 8px", fontSize:12, color:"#1d4ed8" }}>
                  Serão geradas {form.totalParcelas} parcelas de R$ {(parseFloat(form.valor) / parseInt(form.totalParcelas)).toFixed(2).replace(".", ",")} cada
                </div>
              )}
            </div>
          )}

          {/* Info recorrência */}
          {form.recorrencia && form.recorrencia !== "unica" && form.recorrencia !== "parcelada" && form.vencimento && (function(){
            // Calcular preview de quantas ocorrências serão geradas
            var mesesMap = { semanal:0, quinzenal:0, mensal:1, bimestral:2, trimestral:3, semestral:6, anual:12 };
            var diasSemMap = { semanal:7, quinzenal:15 };
            var isSem = form.recorrencia==="semanal"||form.recorrencia==="quinzenal";
            var limite = new Date(); limite.setFullYear(limite.getFullYear()+2);
            var dataAt = new Date(form.vencimento+"T12:00:00"); var count=0;
            while(dataAt<=limite&&count<104){
              count++;
              if(isSem){dataAt=new Date(dataAt);dataAt.setDate(dataAt.getDate()+diasSemMap[form.recorrencia]);}
              else{var m=mesesMap[form.recorrencia]||1;dataAt=new Date(dataAt);dataAt.setMonth(dataAt.getMonth()+m);}
            }
            return (
              <div style={{ background:"#eff6ff", border:"1px solid #bfdbfe", borderRadius:8, padding:"5px 8px", fontSize:12, color:"#1d4ed8", fontWeight:600, marginBottom:4 }}>
                ℹ️ Serão geradas <strong>{count} ocorrências</strong> automaticamente (cobertura de 2 anos a partir do primeiro vencimento)
              </div>
            );
          })()}
          {false && form.recorrencia && form.recorrencia !== "unica" && form.recorrencia !== "parcelada" && form.vencimento && (
            <div style={{ gridColumn:"1/-1", background:"#f0fdf4", border:"1px solid #bbf7d0", borderRadius:8, padding:"5px 8px", fontSize:12, color:"#15803d" }}>
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
                  style={{ width:"100%", background:"#fff", border:"1px solid #e2e8f0", color:"#334155", padding:"5px 8px", borderRadius:8, fontSize:13 }}>
                  <option value="%">%</option>
                  <option value="R$">R$</option>
                </select>
              </div>
              <div>
                <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Multa ({form.multaTipo||"%"})</div>
                <input type="number" step="0.01" value={form.multaPct || ""} onChange={function(e){ set("multaPct", e.target.value); }} placeholder={form.multaTipo==="%"?"Ex: 2":"Ex: 10,00"}
                  style={{ width:"100%", background:"#fff", border:"1px solid #e2e8f0", color:"#0f172a", padding:"5px 8px", borderRadius:8, fontSize:13, outline:"none" }} />
              </div>
              <div>
                <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Tipo Juros</div>
                <select value={form.jurosTipo || "%"} onChange={function(e){ set("jurosTipo", e.target.value); }}
                  style={{ width:"100%", background:"#fff", border:"1px solid #e2e8f0", color:"#334155", padding:"5px 8px", borderRadius:8, fontSize:13 }}>
                  <option value="%">% ao dia</option>
                  <option value="R$">R$ ao dia</option>
                </select>
              </div>
              <div>
                <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Juros/dia ({form.jurosTipo||"%"})</div>
                <input type="number" step="0.001" value={form.jurosDia || ""} onChange={function(e){ set("jurosDia", e.target.value); }} placeholder={form.jurosTipo==="%"?"Ex: 0.033":"Ex: 1,50"}
                  style={{ width:"100%", background:"#fff", border:"1px solid #e2e8f0", color:"#0f172a", padding:"5px 8px", borderRadius:8, fontSize:13, outline:"none" }} />
              </div>
            </div>
          </div>

          {/* Protesto */}
          <div style={{ gridColumn:"1/-1", background:"#f8fafc", border:"1px solid #e2e8f0", borderRadius:10, padding:"14px" }}>
            <div style={{ display:"flex", alignItems:"center", gap:7, marginBottom: form.temProtesto ? 10 : 0 }}>
              <label style={{ display:"flex", alignItems:"center", gap:8, cursor:"pointer" }}>
                <input type="checkbox" checked={!!form.temProtesto} onChange={function(e){ set("temProtesto", e.target.checked); }} />
                <span style={{ fontSize:13, fontWeight:700, color:"#7c3aed" }}>⚖️ Sujeito a Protesto</span>
              </label>
            </div>
            {form.temProtesto && (
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:7, marginTop:8 }}>
                <div>
                  <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Dias para Protesto (após venc.)</div>
                  <input type="number" min="1" value={form.diasProtesto || ""} onChange={function(e){ set("diasProtesto", e.target.value); }} placeholder="Ex: 5"
                    style={{ width:"100%", background:"#fff", border:"1px solid #e2e8f0", color:"#0f172a", padding:"5px 8px", borderRadius:8, fontSize:13, outline:"none" }} />
                </div>
                <div>
                  <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Cartório</div>
                  <input value={form.cartorio || ""} onChange={function(e){ set("cartorio", e.target.value); }} placeholder="Nome do cartório (opcional)"
                    style={{ width:"100%", background:"#fff", border:"1px solid #e2e8f0", color:"#0f172a", padding:"5px 8px", borderRadius:8, fontSize:13, outline:"none" }} />
                </div>
                {form.vencimento && form.diasProtesto && (
                  <div style={{ gridColumn:"1/-1", background:"#fef2f2", borderRadius:8, padding:"5px 8px", fontSize:12, color:"#dc2626" }}>
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



// ════════════════════════════════════════════════════════════
//  UTILITÁRIOS DE EXPORTAÇÃO FINANCEIRA
// ════════════════════════════════════════════════════════════
function exportarCSV(nomeArquivo, cabecalho, linhas) {
  function escapeCel(c) {
    var s = String(c === null || c === undefined ? "" : c);
    if (s.includes(";") || s.includes("\n") || s.includes('"')) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }
  var bom = "\uFEFF";
  var rows = [cabecalho.map(escapeCel).join(";")];
  linhas.forEach(function(l) { rows.push(l.map(escapeCel).join(";")); });
  var csv = bom + rows.join("\n");
  var blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  var url = URL.createObjectURL(blob);
  var a = document.createElement("a");
  a.href = url; a.download = nomeArquivo + ".csv"; a.click();
  setTimeout(function() { URL.revokeObjectURL(url); }, 1000);
}

function exportarXLS(nomeArquivo, cabecalho, linhas) {
  function escapeHtml(c) {
    return String(c === null || c === undefined ? "" : c)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  var bom = "\uFEFF";
  var ths = cabecalho.map(function(h) { return "<th><b>" + escapeHtml(h) + "</b></th>"; }).join("");
  var trs = linhas.map(function(l) {
    return "<tr>" + l.map(function(c) { return "<td>" + escapeHtml(c) + "</td>"; }).join("") + "</tr>";
  }).join("");
  var html = bom + "<table><tr>" + ths + "</tr>" + trs + "</table>";
  var blob = new Blob([html], { type: "application/vnd.ms-excel;charset=utf-8;" });
  var url = URL.createObjectURL(blob);
  var a = document.createElement("a");
  a.href = url; a.download = nomeArquivo + ".xls"; a.click();
  setTimeout(function() { URL.revokeObjectURL(url); }, 1000);
}

function exportarPDF(nomeArquivo, titulo, cabecalho, linhas, totais) {
  function escapeHtml(c) {
    return String(c === null || c === undefined ? "" : c)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  var estilos = [
    "body{font-family:Arial,sans-serif;font-size:11px;color:#0f172a;margin:20px}",
    "h2{font-size:16px;margin-bottom:4px}",
    ".sub{font-size:11px;color:#64748b;margin-bottom:14px}",
    "table{border-collapse:collapse;width:100%}",
    "th{background:#0f172a;color:#fff;padding:7px 10px;text-align:left;font-size:10px;text-transform:uppercase}",
    "td{padding:6px 10px;border-bottom:1px solid #e2e8f0;font-size:11px}",
    "tr:nth-child(even) td{background:#f8fafc}",
    ".totais{margin-top:14px;background:#f1f5f9;padding:10px 14px;border-radius:6px;font-weight:bold}",
    ".totais span{margin-right:24px}"
  ].join("");
  var ths = cabecalho.map(function(h) { return "<th>" + escapeHtml(h) + "</th>"; }).join("");
  var trs = linhas.map(function(l) {
    return "<tr>" + l.map(function(c) { return "<td>" + escapeHtml(c) + "</td>"; }).join("") + "</tr>";
  }).join("");
  var totaisHtml = totais
    ? '<div class="totais">' + totais.map(function(t) { return "<span>" + escapeHtml(t) + "</span>"; }).join("") + "</div>"
    : "";
  var data = new Date().toLocaleDateString("pt-BR");
  var hora = new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  var html = [
    '<!DOCTYPE html><html><head><meta charset="UTF-8">',
    "<title>" + escapeHtml(titulo) + "</title>",
    "<style>" + estilos + "</style></head><body>",
    "<h2>" + escapeHtml(titulo) + "</h2>",
    '<div class="sub">Gerado em ' + data + " às " + hora + "</div>",
    "<table><thead><tr>" + ths + "</tr></thead><tbody>" + trs + "</tbody></table>",
    totaisHtml,
    "</body></html>"
  ].join("");
  var w = window.open("", "_blank", "width=900,height=700");
  if (!w) { alert("Permita pop-ups para gerar o PDF."); return; }
  w.document.write(html);
  w.document.close();
  w.focus();
  setTimeout(function() { w.print(); }, 600);
}

function BotaoExportar({ onCSV, onXLS, onPDF }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ position: "relative", display: "inline-block" }}>
      <button
        onClick={function() { setOpen(function(v) { return !v; }); }}
        style={{ display: "flex", alignItems: "center", gap: 6, background: "#f8fafc", border: "1px solid #e2e8f0", color: "#334155", fontWeight: 600, padding: "8px 16px", borderRadius: 8, cursor: "pointer", fontSize: 12 }}>
        ⬇️ Exportar <span style={{ fontSize: 10, color: "#94a3b8" }}>▼</span>
      </button>
      {open && (
        <div
          style={{ position: "absolute", top: "100%", left: 0, marginTop: 4, background: "#fff", border: "1px solid #e2e8f0", borderRadius: 10, boxShadow: "0 8px 24px rgba(0,0,0,.12)", zIndex: 200, minWidth: 160, overflow: "hidden" }}
          onMouseLeave={function() { setOpen(false); }}>
          {[
            { label: "📄 PDF", action: onPDF },
            { label: "📊 Excel (.xls)", action: onXLS },
            { label: "📋 CSV", action: onCSV },
          ].map(function(op) {
            return (
              <button
                key={op.label}
                onClick={function() { op.action(); setOpen(false); }}
                style={{ display: "block", width: "100%", textAlign: "left", padding: "10px 16px", border: "none", background: "transparent", cursor: "pointer", fontSize: 13, color: "#0f172a", fontWeight: 500 }}
                onMouseEnter={function(e) { e.currentTarget.style.background = "#f8fafc"; }}
                onMouseLeave={function(e) { e.currentTarget.style.background = "transparent"; }}>
                {op.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}


function FinanceiroTab({ contasPagar=[], setContasPagar, contasBancarias=[], setContasBancarias, categoriasPagar=[], setCategoriasPagar, lancamentos=[], setLancamentos, enrichedOrders=[], rawOrders=[], shipmentStatuses, paymentData, finTab, setFinTab, impostos=[], setImpostos, custosFixos=[], setCustosFixos, fornecedores=[], currentUser=null, irpjCsllConfig={}, setIrpjCsllConfig }) {
  const [paginaPagar, setPaginaPagar] = useState(1);
  const [paginaReceber, setPaginaReceber] = useState(1);
  const POR_PAG_FIN = 30;

  // Badge de quantos pagamentos liberados ainda não foram baixados
  var qtdLiberadosNaoRegistrados = (enrichedOrders||[]).filter(function(o) {
    var pd = paymentData?.[o.id];
    if (!pd?.releaseDate) return false;
    var daysUntil = (function(dateStr) {
      var d = new Date(dateStr+"T12:00:00"); var hoje = new Date(); hoje.setHours(0,0,0,0);
      return Math.ceil((d-hoje)/(1000*60*60*24));
    })(pd.releaseDate);
    if (daysUntil > 0) return false;
    return !(lancamentos||[]).some(function(l){ return l.tipo==="recebimento" && String(l.pedidoId)===String(o.id); });
  }).length;
  const [showModalConta, setShowModalConta] = useState(false);
  const [showModalBancaria, setShowModalBancaria] = useState(false);
  const [showModalTransf, setShowModalTransf] = useState(false);
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
  const [filterDoc, setFilterDoc] = useState("");
  const [filterValorMin, setFilterValorMin] = useState("");
  const [filterValorMax, setFilterValorMax] = useState("");
  const [novaCat, setNovaCat] = useState("");
  const [fluxoDe, setFluxoDe] = useState("");
  const [fluxoAte, setFluxoAte] = useState("");
  const [extratoContaId, setExtratoContaId] = useState(null);
  const [extratoDe, setExtratoDe] = useState("");
  const [extratoAte, setExtratoAte] = useState("");
  const [extratoSel, setExtratoSel] = useState([]);
  const [extratoTipo, setExtratoTipo] = useState("todos"); // todos | recebimento | pagamento
  const [extratoSearch, setExtratoSearch] = useState("");
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
    if (filterPrioridade !== "all-pr") r = r.filter(function(c) {
      var priorConta = c.prioridade || "media";
      // Se conta tem prioridade explícita, usa ela
      if (priorConta !== "media") return priorConta === filterPrioridade;
      // Se é média (padrão), verifica se o fornecedor tem prioridade diferente
      var forn = (fornecedores||[]).find(function(f){ return f.id === c.fornecedorId; });
      var priorEfetiva = forn?.prioridade || "media";
      return priorEfetiva === filterPrioridade;
    });
    if (searchPagar) {
      var qp = searchPagar.toLowerCase();
      r = r.filter(c => (c.descricao||"").toLowerCase().includes(qp) || (c.fornecedorNome||"").toLowerCase().includes(qp) || (c.fornecedorCNPJ||"").includes(qp) || (c.observacao||"").toLowerCase().includes(qp));
    }
    if (filterDoc) r = r.filter(c => (c.observacao||"").toLowerCase().includes(filterDoc.toLowerCase()) || (c.descricao||"").toLowerCase().includes(filterDoc.toLowerCase()));
    if (filterValorMin) r = r.filter(c => parseFloat(c.valor||0) >= parseFloat(filterValorMin));
    if (filterValorMax) r = r.filter(c => parseFloat(c.valor||0) <= parseFloat(filterValorMax));
    if (pagarDe) r = r.filter(c => c.vencimento && c.vencimento >= pagarDe);
    if (pagarAte) r = r.filter(c => c.vencimento && c.vencimento <= pagarAte);
    // Ordenar: alta > media > baixa > sem prioridade, depois por vencimento
    const ordPr = { alta:0, media:1, baixa:2 };
    function getPriorEfetiva(c) {
      var priorConta = c.prioridade || "media";
      if (priorConta !== "media") return priorConta;
      var forn = (fornecedores||[]).find(function(f){ return f.id === c.fornecedorId; });
      return forn?.prioridade || "media";
    }
    return r.sort((a,b) => {
      var pa = ordPr[getPriorEfetiva(a)] ?? 1;
      var pb = ordPr[getPriorEfetiva(b)] ?? 1;
      if (pa !== pb) return pa - pb;
      return (a.vencimento||"9999") > (b.vencimento||"9999") ? 1 : -1;
    });
  }, [contasPagar, filterStatus, filterCat, filterPrioridade, searchPagar, pagarDe, pagarAte, fornecedores]);

  // ── Totais ───────────────────────────────────────────────
  const totalPagar   = contasPagar.filter(c=>c.status!=="Pago").reduce((s,c)=>s+parseFloat(c.valor||0),0);
  const totalPago    = contasPagar.filter(c=>c.status==="Pago").reduce((s,c)=>s+parseFloat(c.valor||0),0);
  const totalVencido = contasPagar.filter(c=>c.status==="Vencido").reduce((s,c)=>s+parseFloat(c.valor||0),0);
  const vencendo7    = contasPagar.filter(c=>c.status==="Pendente"&&c.vencimento&&getDaysUntil(c.vencimento)>=0&&getDaysUntil(c.vencimento)<=7);

  const hoje = new Date().toLocaleDateString("sv-SE");
  const mesAtual = hoje.slice(0,7);
  const allOrders = rawOrders || [];

  // Usar enrichedOrders — já tem fee e freteSeller calculados (mesmos da aba Pedidos)
  // Pedidos a receber = pagos e ainda não registrados no financeiro
  const aReceber = (enrichedOrders||[]).filter(function(o) {
    if (o.status !== "paid") return false;
    if (o.tags?.some(function(t){ return t === "cancelled" || t === "refunded"; })) return false;
    const jaRegistrado = lancamentos.some(function(l) {
      return l.tipo === "recebimento" && String(l.pedidoId) === String(o.id);
    });
    return !jaRegistrado;
  });

  // Pedidos já registrados no financeiro
  const recebidoMes = (enrichedOrders||[]).filter(function(o) {
    const jaRegistrado = lancamentos.some(function(l) {
      return l.tipo === "recebimento" && String(l.pedidoId) === String(o.id);
    });
    return jaRegistrado && o.status === "paid";
  });

  const totalAReceberLiq = aReceber.reduce((s,o) => s + (paymentData?.[o.id]?.netAmount || o.price*o.qty), 0);
  const totalRecebidoMesLiq = recebidoMes.reduce(function(s,o) {
    // Usar valor real do lançamento se existir, senão dado da API, senão bruto
    var lanc = lancamentos.find(function(l){ return l.tipo==="recebimento" && String(l.pedidoId)===String(o.id); });
    return s + (lanc?.valor || paymentData?.[o.id]?.netAmount || o.price*o.qty);
  }, 0);
  const saldoMes = totalRecebidoMesLiq - totalPago;
  const saldoPrevisto = totalAReceberLiq - totalPagar;

  // ── Saldo por conta bancária ─────────────────────────────
  function getSaldoConta(contaId) {
    const inicial = parseFloat((contasBancarias||[]).find(function(c){return c.id===contaId;})?.saldoInicial || 0);
    const entradas = lancamentos.filter(l=>l.contaBancariaId===contaId&&l.tipo==="recebimento").reduce((s,l)=>s+l.valor,0);
    const saidas   = lancamentos.filter(l=>l.contaBancariaId===contaId&&l.tipo==="pagamento").reduce((s,l)=>s+l.valor,0);
    return inicial + entradas - saidas;
  }

  // ── Ações ────────────────────────────────────────────────
  function saveConta(form) {
    let novas = [];

    if (!editingConta && form.recorrencia === "parcelada" && form.totalParcelas > 1) {
      // Gera todas as parcelas de uma vez
      const total = parseInt(form.totalParcelas);
      const valorParcela = parseFloat(form.valor) / total;
      const intervaloDias = { semanal:7, quinzenal:15, mensal:30, bimestral:60, trimestral:90 }[form.intervaloParcelas||"mensal"] || 30;
      const grupo = Date.now();
      for (let i = 0; i < total; i++) {
        const dataVenc = new Date(form.vencimento + "T12:00:00");
        dataVenc.setDate(dataVenc.getDate() + intervaloDias * i);
        novas.push({
          ...form,
          id: grupo + i,
          descricao: `${form.descricao} (${i+1}/${total})`,
          valor: valorParcela.toFixed(2),
          vencimento: dataVenc.toLocaleDateString("sv-SE"),
          recorrencia: "parcelada",
          parcelaAtual: i + 1,
          totalParcelas: total,
          grupoParcelado: grupo,
        });
      }
    } else if (!editingConta && form.recorrencia && form.recorrencia !== "unica" && form.recorrencia !== "parcelada" && form.vencimento) {
      // Recorrente (mensal, semanal, etc.) — gera ocorrências até 2 anos à frente
      const diasMap = { semanal:7, quinzenal:15, mensal:1, bimestral:2, trimestral:3, semestral:6, anual:12 };
      const mesesMap = { semanal:0, quinzenal:0, mensal:1, bimestral:2, trimestral:3, semestral:6, anual:12 };
      const diasSemMap = { semanal:7, quinzenal:15 };
      const isSemanas = form.recorrencia === "semanal" || form.recorrencia === "quinzenal";
      const grupo = Date.now();
      const limite = new Date(); limite.setFullYear(limite.getFullYear() + 2); // até 2 anos

      let dataAtual = new Date(form.vencimento + "T12:00:00");
      let i = 0;
      while (dataAtual <= limite && i < 104) { // max 104 semanas / 24 meses
        novas.push({
          ...form,
          id: grupo + i,
          vencimento: dataAtual.toLocaleDateString("sv-SE"),
          status: "Pendente",
          grupoRecorrente: grupo,
          parcelaAtual: i + 1,
        });
        i++;
        // Avançar para próxima data
        if (isSemanas) {
          dataAtual = new Date(dataAtual);
          dataAtual.setDate(dataAtual.getDate() + diasSemMap[form.recorrencia]);
        } else {
          const meses = mesesMap[form.recorrencia] || 1;
          dataAtual = new Date(dataAtual);
          dataAtual.setMonth(dataAtual.getMonth() + meses);
        }
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

    // Se for recorrente e tiver grupoRecorrente, NÃO cria nova (já foram pré-geradas ao cadastrar)
    // Se for recorrente sem grupo (legado), cria a próxima
    const rec = conta.recorrencia;
    const diasMap = { semanal:7, quinzenal:15, mensal:30, bimestral:60, trimestral:90, semestral:180, anual:365 };
    if (rec && diasMap[rec] && conta.vencimento && !conta.grupoRecorrente) {
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
    const lan = { id:Date.now(), tipo:"recebimento", descricao:"Pedido ML #"+order.id, valor, data:dataRecebimento, contaBancariaId, pedidoId:order.id, automatico:true };
    const updatedLan = [...lancamentos, lan];
    setLancamentos(updatedLan); saveLS("lancamentos", updatedLan);
  }

  // ── Baixa automática de pedidos liberados ───────────────
  function baixaAutomaticaLiberados() {
    // Encontrar conta Mercado Pago automaticamente
    var contaMP = contasBancarias.find(function(c) {
      var nome = (c.nome||"").toLowerCase();
      return nome.includes("mercado pago") || nome.includes("mercadopago") || c.tipo === "Mercado Pago";
    });
    if (!contaMP) {
      alert("Nenhuma conta do tipo Mercado Pago encontrada. Cadastre a conta 'Mercado Pago Filial SP' em Caixas e Bancos.");
      return;
    }

    var hoje = new Date().toLocaleDateString("sv-SE");
    var novosLanc = [];
    var qtdBaixados = 0;

    enrichedOrders.forEach(function(o) {
      var pd = paymentData?.[o.id];
      if (!pd?.releaseDate) return;
      var relDays = getDaysUntil(pd.releaseDate);
      // Só baixar se o pagamento já foi liberado (releaseDate <= hoje)
      if (relDays > 0) return;
      // Verificar se já foi registrado
      var jaReg = lancamentos.some(function(l) {
        return l.tipo === "recebimento" && (String(l.pedidoId) === String(o.id));
      });
      if (jaReg) return;

      // Calcular valor líquido a receber
      var bruto = o.price * o.qty;
      var taxa = pd.feeAmount || (bruto * 0.13);
      var frete = pd.shippingAmount || 0;
      var liquido = pd.netAmount || (bruto - taxa - frete);
      if (liquido <= 0) liquido = bruto;

      novosLanc.push({
        id: Date.now() + Math.random(),
        tipo: "recebimento",
        descricao: "Pedido ML #"+o.id+" — "+(o.title||"").slice(0,40),
        valor: parseFloat(liquido.toFixed(2)),
        data: pd.releaseDate <= hoje ? pd.releaseDate : hoje,
        contaBancariaId: contaMP.id,
        pedidoId: o.id,
        automatico: true,
        origem: "ml_auto",
      });
      qtdBaixados++;
    });

    if (novosLanc.length === 0) {
      alert("Nenhum pagamento novo para baixar. Todos os pagamentos liberados já estão registrados.");
      return;
    }

    var updatedLan = [...lancamentos, ...novosLanc];
    setLancamentos(updatedLan);
    saveLS("lancamentos", updatedLan);
    alert("✅ "+qtdBaixados+" pagamento(s) baixado(s) automaticamente na conta '"+contaMP.nome+"'!");
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
      <div style={{ display:"flex", gap:2, marginBottom:10, background:"#f1f5f9", padding:4, borderRadius:10, width:"fit-content", flexWrap:"wrap" }}>
        {[
          { key:"resumo",  label:"📊 Resumo",           perm:"fin_resumo" },
          { key:"fluxo",   label:"📈 Fluxo de Caixa",   perm:"fin_fluxo" },
          { key:"pagar",   label:"📤 Contas a Pagar",   perm:"fin_pagar" },
          { key:"receber", label:"📥 Contas a Receber", perm:"fin_receber" },
          { key:"contas",  label:"🏦 Caixas e Bancos",  perm:"fin_bancos" },
          { key:"ia",      label:"✦ Consultoria IA",    perm:"fin_pagar" },

        ].filter(function(t) {
          if (currentUser?.admin) return true;
          var perms = currentUser?.permissoes || [];
          var temSubPerm = perms.some(function(p){ return p.startsWith("fin_"); });
          if (!temSubPerm) return true;
          return perms.includes(t.perm);
        }).map(function(t) {
          return (
            <button key={t.key} onClick={function(){ setFinTab(t.key); }}
              style={{ background:finTab===t.key?"#fff":"transparent", border:"none", color:finTab===t.key?"#0f172a":"#94a3b8", padding:"8px 16px", cursor:"pointer", fontFamily:"inherit", fontSize:13, borderRadius:8, fontWeight:finTab===t.key?700:500, boxShadow:finTab===t.key?"0 1px 3px rgba(0,0,0,.08)":"none", whiteSpace:"nowrap" }}>
              {t.label}
            </button>
          );
        })}
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
                <div style={{ fontSize:17, fontWeight:800, color:k.color }}>{k.value}</div>
                <div style={{ fontSize:11, color:"#94a3b8", marginTop:4 }}>{k.desc}</div>
              </div>
            ))}
          </div>

          {/* Saldo por conta */}
          {contasBancarias.length > 0 && (
            <div style={{ background:"#fff", border:"1px solid #e2e8f0", borderRadius:12, padding:"12px 16px" }}>
              <div style={{ fontWeight:700, fontSize:14, color:"#0f172a", marginBottom:8 }}>🏦 Saldo por Conta</div>
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
                      <div style={{ fontSize:15, fontWeight:800, color:saldo>=0?"#15803d":"#dc2626" }}>{fmt(saldo)}</div>
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
            <div style={{ background:"#fff", border:"1px solid #e2e8f0", borderRadius:12, padding:"12px 16px" }}>
              <div style={{ fontWeight:700, fontSize:14, color:"#0f172a", marginBottom:8 }}>Entradas vs Saídas por Mês</div>
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

        function exportarFluxo(tipo) {
          var cab=["Data","Descrição","Tipo","Valor","E/S","Previsto"];
          var linhas=[];
          sortedDias.forEach(function(d){
            dias[d].entradas.forEach(function(e){ linhas.push([fmtDate(d),e.desc,e.tipo||"—","R$ "+e.valor.toFixed(2).replace(".",","),"Entrada",e.previsto?"Sim":"Não"]); });
            dias[d].saidas.forEach(function(s){ linhas.push([fmtDate(d),s.desc,s.tipo||"—","R$ "+s.valor.toFixed(2).replace(".",","),"Saída",s.previsto?"Sim":"Não"]); });
          });
          var tots=["Total Entradas: R$ "+totalEntradas.toFixed(2).replace(".",","),"Total Saídas: R$ "+totalSaidas.toFixed(2).replace(".",","),"Saldo: R$ "+(totalEntradas-totalSaidas).toFixed(2).replace(".",",")];
          if(tipo==="csv") exportarCSV("fluxo_de_caixa",cab,linhas);
          else if(tipo==="xls") exportarXLS("fluxo_de_caixa",cab,linhas);
          else exportarPDF("fluxo_de_caixa","Fluxo de Caixa",cab,linhas,tots);
        }

        return (
          <div>
            {/* Filtro de período */}
            <div style={{ background:"#f8fafc", border:"1px solid #e2e8f0", borderRadius:10, padding:"10px 14px", marginBottom:8 }}>
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
            {/* Exportar + Cards resumo */}
            <div style={{ display:"flex", justifyContent:"flex-end", marginBottom:10 }}>
              <BotaoExportar onCSV={function(){exportarFluxo("csv");}} onXLS={function(){exportarFluxo("xls");}} onPDF={function(){exportarFluxo("pdf");}} />
            </div>
            <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(150px,1fr))", gap:8, marginBottom:10 }}>
              {[
                { label:"Total Entradas", value:fmt(totalEntradas), color:"#15803d", bg:"#f0fdf4" },
                { label:"Total Saídas",   value:fmt(totalSaidas),   color:"#dc2626", bg:"#fef2f2" },
                { label:"Saldo Período",  value:fmt(totalEntradas-totalSaidas), color:totalEntradas-totalSaidas>=0?"#15803d":"#dc2626", bg:"#f8fafc" },
              ].map(k => (
                <div key={k.label} style={{ background:k.bg, borderRadius:12, padding:"16px 18px", border:`1px solid ${k.bg}` }}>
                  <div style={{ fontSize:11, color:k.color, fontWeight:700, textTransform:"uppercase", marginBottom:6 }}>{k.label}</div>
                  <div style={{ fontSize:17, fontWeight:800, color:k.color }}>{k.value}</div>
                </div>
              ))}
            </div>

            <div style={{ background:"#fffbeb", border:"1px solid #fde68a", borderRadius:10, padding:"10px 14px", marginBottom:8, fontSize:12, color:"#92400e" }}>
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
          <LayoutFiltros
            filtros={
              <>
                <FiltroGrupo titulo="Status">
                  {[{v:"all",l:"Todos"},{v:"Pendente",l:"📋 Em Aberto"},{v:"Vencido",l:"🔴 Em Atraso"},{v:"Protestado",l:"⚖️ Protestado"},{v:"Pago",l:"✅ Pago"},{v:"Pago Parcial",l:"⚡ Pago Parcial"}].map(function(s){
                    return <FiltroBotao key={s.v} label={s.l} active={filterStatus===s.v} cor={s.v==="Vencido"?"#dc2626":s.v==="Pago"?"#15803d":s.v==="Protestado"?"#7c3aed":"#0f172a"} bg={s.v==="Vencido"?"#fef2f2":s.v==="Pago"?"#f0fdf4":s.v==="Protestado"?"#f5f3ff":"#f1f5f9"} onClick={function(){setFilterStatus(s.v);}} />;
                  })}
                </FiltroGrupo>
                <FiltroGrupo titulo="Categoria">
                  <FiltroBotao label="Todas" active={filterCat==="all"} cor="#0f172a" bg="#f1f5f9" onClick={function(){setFilterCat("all");}} />
                  {categoriasPagar.map(function(c){ return <FiltroBotao key={c} label={c} active={filterCat===c} cor="#0f172a" bg="#f1f5f9" onClick={function(){setFilterCat(c);}} />; })}
                </FiltroGrupo>
                <FiltroGrupo titulo="Prioridade">
                  {[{key:"all-pr",l:"Todas",cor:"#64748b",abg:"#334155"},{key:"alta",l:"!!! Alta",cor:"#dc2626",abg:"#dc2626",bg:"#fef2f2"},{key:"media",l:"!! Média",cor:"#d97706",abg:"#d97706",bg:"#fffbeb"},{key:"baixa",l:"! Baixa",cor:"#15803d",abg:"#15803d",bg:"#f0fdf4"}].map(function(p){
                    var qtd = p.key==="all-pr" ? 0 : contasPagar.filter(function(c){ var pc=c.prioridade||"media"; var f=(fornecedores||[]).find(function(x){return x.id===c.fornecedorId;}); var pf=pc!=="media"?pc:(f?.prioridade||pc); return pf===p.key&&c.status!=="Pago"; }).length;
                    return <FiltroBotao key={p.key} label={p.l} active={filterPrioridade===p.key} cor={p.cor} bg={p.bg||"#f1f5f9"} count={p.key!=="all-pr"?qtd:undefined} onClick={function(){setFilterPrioridade(p.key);}} />;
                  })}
                </FiltroGrupo>
                <FiltroGrupo titulo="Vencimento">
                  {[{l:"Todos",de:"",ate:""},{l:"Vencidas",de:"2000-01-01",ate:new Date().toLocaleDateString("sv-SE")},{l:"Esta semana",de:new Date().toLocaleDateString("sv-SE"),ate:(function(){var d=new Date();d.setDate(d.getDate()+7);return d.toLocaleDateString("sv-SE");})()},{l:"Este mês",de:new Date().toLocaleDateString("sv-SE"),ate:(function(){var d=new Date();return new Date(d.getFullYear(),d.getMonth()+1,0).toLocaleDateString("sv-SE");})()},{l:"Próx. 3 meses",de:new Date().toLocaleDateString("sv-SE"),ate:(function(){var d=new Date();d.setMonth(d.getMonth()+3);return d.toLocaleDateString("sv-SE");})()},{l:"Próx. 6 meses",de:new Date().toLocaleDateString("sv-SE"),ate:(function(){var d=new Date();d.setMonth(d.getMonth()+6);return d.toLocaleDateString("sv-SE");})()},{l:"Este ano",de:new Date().toLocaleDateString("sv-SE"),ate:new Date().getFullYear()+"-12-31"}].map(function(p){
                    return <FiltroBotao key={p.l} label={p.l} active={pagarDe===p.de&&pagarAte===p.ate} cor="#0f172a" bg="#f1f5f9" onClick={function(){setPagarDe(p.de);setPagarAte(p.ate);}} />;
                  })}
                  <div style={{ display:"flex", flexDirection:"column", gap:4, marginTop:4 }}>
                    <input type="date" value={pagarDe} onChange={function(e){setPagarDe(e.target.value);}} style={{ background:"#fff", border:"1px solid #e2e8f0", color:"#334155", padding:"5px 7px", borderRadius:7, fontSize:11 }} />
                    <input type="date" value={pagarAte} onChange={function(e){setPagarAte(e.target.value);}} style={{ background:"#fff", border:"1px solid #e2e8f0", color:"#334155", padding:"5px 7px", borderRadius:7, fontSize:11 }} />
                  </div>
                </FiltroGrupo>
                <FiltroGrupo titulo="Valor / Doc">
                  <input type="number" value={filterValorMin} onChange={function(e){setFilterValorMin(e.target.value);}} placeholder="Mín R$" style={{ width:"100%", background:"#fff", border:"1px solid #e2e8f0", color:"#0f172a", padding:"5px 7px", borderRadius:7, fontSize:11, outline:"none" }} />
                  <input type="number" value={filterValorMax} onChange={function(e){setFilterValorMax(e.target.value);}} placeholder="Máx R$" style={{ width:"100%", background:"#fff", border:"1px solid #e2e8f0", color:"#0f172a", padding:"5px 7px", borderRadius:7, fontSize:11, outline:"none" }} />
                  <input value={filterDoc} onChange={function(e){setFilterDoc(e.target.value);}} placeholder="Nº doc / obs..." style={{ width:"100%", background:"#fff", border:"1px solid #e2e8f0", color:"#0f172a", padding:"5px 7px", borderRadius:7, fontSize:11, outline:"none" }} />
                  {(filterValorMin||filterValorMax||filterDoc||pagarDe||pagarAte) && <button onClick={function(){setFilterValorMin("");setFilterValorMax("");setFilterDoc("");setPagarDe("");setPagarAte("");}} style={{ background:"#fef2f2", border:"1px solid #fecaca", color:"#dc2626", padding:"5px 7px", borderRadius:7, cursor:"pointer", fontSize:11, width:"100%" }}>✕ Limpar</button>}
                </FiltroGrupo>
                <div style={{ fontSize:11, color:"#94a3b8", marginTop:"auto" }}>{contasFiltradas.length} conta(s)</div>
              </>
            }
            busca={
              <div style={{ position:"relative" }}>
                <span style={{ position:"absolute", left:10, top:"50%", transform:"translateY(-50%)", color:"#94a3b8", fontSize:13 }}>🔍</span>
                <input value={searchPagar} onChange={function(e){setSearchPagar(e.target.value);}} placeholder="Buscar descrição..."
                  style={{ width:"100%", background:"#fff", border:"1px solid #e2e8f0", color:"#0f172a", padding:"8px 12px 8px 32px", borderRadius:8, fontSize:13, outline:"none" }} />
              </div>
            }
            acoes={
              <div style={{ display:"flex", gap:8 }}>
              <BotaoExportar
                onCSV={function(){
                  var cab=["Descrição","Categoria","Valor","Vencimento","Status","Conta Paga","Prioridade","Parcela"];
                  var linhas=contasFiltradas.map(function(c){ return [c.descricao,c.categoria||"—",c.valor,fmtDate(c.vencimento),c.status,c.contaBancariaId?(contasBancarias.find(function(b){return b.id===c.contaBancariaId;})?.nome||"—"):"—",c.prioridade||"media",c.parcelaAtual?(c.parcelaAtual+"/"+c.totalParcelas):"—"]; });
                  exportarCSV("contas_a_pagar",cab,linhas);
                }}
                onXLS={function(){
                  var cab=["Descrição","Categoria","Valor","Vencimento","Status","Conta Paga","Prioridade","Parcela"];
                  var linhas=contasFiltradas.map(function(c){ return [c.descricao,c.categoria||"—",c.valor,fmtDate(c.vencimento),c.status,c.contaBancariaId?(contasBancarias.find(function(b){return b.id===c.contaBancariaId;})?.nome||"—"):"—",c.prioridade||"media",c.parcelaAtual?(c.parcelaAtual+"/"+c.totalParcelas):"—"]; });
                  exportarXLS("contas_a_pagar",cab,linhas);
                }}
                onPDF={function(){
                  var cab=["Descrição","Categoria","Valor","Vencimento","Status","Conta Paga","Prioridade"];
                  var linhas=contasFiltradas.map(function(c){ return [c.descricao,c.categoria||"—","R$ "+parseFloat(c.valor||0).toFixed(2).replace(".",","),fmtDate(c.vencimento),c.status,c.contaBancariaId?(contasBancarias.find(function(b){return b.id===c.contaBancariaId;})?.nome||"—"):"—",c.prioridade||"media"]; });
                  var pendente=contasFiltradas.filter(function(c){return c.status==="Pendente"||c.status==="Vencido";}).reduce(function(s,c){return s+parseFloat(c.valor||0);},0);
                  var pago=contasFiltradas.filter(function(c){return c.status==="Pago";}).reduce(function(s,c){return s+parseFloat(c.valor||0);},0);
                  exportarPDF("contas_a_pagar","Contas a Pagar",cab,linhas,["Total: "+contasFiltradas.length+" conta(s)","Pendente: R$ "+pendente.toFixed(2).replace(".",","),"Pago: R$ "+pago.toFixed(2).replace(".",",")]);
                }}
              />
              <button onClick={function(){ setEditingConta(null); setShowModalConta(true); }}
                style={{ background:"#0f172a", border:"none", color:"#fff", fontWeight:700, padding:"9px 20px", borderRadius:8, cursor:"pointer", fontSize:13 }}>+ Nova Conta</button>
            </div>
          }>
          {/* Conteúdo da aba pagar */}
          <div>
            {/* Prioridade */}
            <div style={{ display:"flex", gap:4, alignItems:"center" }}>
              <span style={{ fontSize:11, color:"#64748b", fontWeight:600, whiteSpace:"nowrap" }}>Prioridade:</span>
              {[
                { key:"all-pr", label:"Todas",    cor:"#64748b", activeBg:"#334155" },
                { key:"alta",   label:"!!! Alta", cor:"#dc2626", bg:"#fef2f2", activeBg:"#dc2626" },
                { key:"media",  label:"!! Média", cor:"#d97706", bg:"#fffbeb", activeBg:"#d97706" },
                { key:"baixa",  label:"! Baixa",  cor:"#15803d", bg:"#f0fdf4", activeBg:"#15803d" },
              ].map(function(p) {
                var isActive = filterPrioridade === p.key;
                var qtd = p.key === "all-pr" ? 0 : contasPagar.filter(function(c){
                  var priorConta = c.prioridade || "media";
                  var forn = (fornecedores||[]).find(function(f){ return f.id === c.fornecedorId; });
                  var priorFinal = priorConta !== "media" ? priorConta : (forn?.prioridade || priorConta);
                  return priorFinal === p.key && c.status !== "Pago";
                }).length;
                return (
                  <button key={p.key} onClick={function(){ setFilterPrioridade(p.key); }}
                    style={{ padding:"4px 10px", borderRadius:20,
                      border: isActive ? "2px solid "+p.activeBg : "1px solid #e2e8f0",
                      background: isActive ? p.activeBg : (p.bg||"#f8fafc"),
                      color: isActive ? "#fff" : p.cor,
                      fontWeight: isActive ? 700 : 500, fontSize:11, cursor:"pointer", whiteSpace:"nowrap" }}>
                    {p.label}{p.key !== "all-pr" && <span style={{ marginLeft:4, fontSize:10, opacity:0.8 }}>({qtd})</span>}
                  </button>
                );
              })}
            </div>
            <div style={{ width:1, height:20, background:"#e2e8f0", flexShrink:0 }} />
            {/* Vencimento */}
            <div style={{ display:"flex", gap:4, alignItems:"center", flexWrap:"wrap" }}>
              <span style={{ fontSize:11, color:"#64748b", fontWeight:600, whiteSpace:"nowrap" }}>📅</span>
              {[
                { label:"Todos",         de:"", ate:"" },
                { label:"Vencidas",      de:"2000-01-01", ate: new Date().toLocaleDateString("sv-SE") },
                { label:"Esta semana",   de: new Date().toLocaleDateString("sv-SE"), ate: (function(){ var d=new Date(); d.setDate(d.getDate()+7); return d.toLocaleDateString("sv-SE"); })() },
                { label:"Este mês",      de: new Date().toLocaleDateString("sv-SE"), ate: (function(){ var d=new Date(); return new Date(d.getFullYear(),d.getMonth()+1,0).toLocaleDateString("sv-SE"); })() },
                { label:"Próx. 3m",      de: new Date().toLocaleDateString("sv-SE"), ate: (function(){ var d=new Date(); d.setMonth(d.getMonth()+3); return d.toLocaleDateString("sv-SE"); })() },
                { label:"Próx. 6m",      de: new Date().toLocaleDateString("sv-SE"), ate: (function(){ var d=new Date(); d.setMonth(d.getMonth()+6); return d.toLocaleDateString("sv-SE"); })() },
                { label:"Este ano",      de: new Date().toLocaleDateString("sv-SE"), ate: new Date().getFullYear()+"-12-31" },
              ].map(function(p) {
                var isActive = pagarDe === p.de && pagarAte === p.ate;
                return (
                  <button key={p.label} onClick={function(){ setPagarDe(p.de); setPagarAte(p.ate); }}
                    style={{ padding:"4px 10px", borderRadius:20, border:"none", cursor:"pointer", fontSize:11,
                      fontWeight:isActive?700:500, background:isActive?"#0f172a":"#f1f5f9",
                      color:isActive?"#fff":"#64748b", whiteSpace:"nowrap" }}>
                    {p.label}
                  </button>
                );
              })}
            </div>
            <div style={{ width:1, height:20, background:"#e2e8f0", flexShrink:0 }} />
            {/* Data manual + Valor + Doc */}
            <div style={{ display:"flex", gap:5, alignItems:"center", flexWrap:"wrap" }}>
              <input type="date" value={pagarDe} onChange={function(e){ setPagarDe(e.target.value); }}
                style={{ background:"#fff", border:"1px solid #e2e8f0", color:"#334155", padding:"4px 7px", borderRadius:7, fontSize:11 }} />
              <span style={{ fontSize:10, color:"#94a3b8" }}>até</span>
              <input type="date" value={pagarAte} onChange={function(e){ setPagarAte(e.target.value); }}
                style={{ background:"#fff", border:"1px solid #e2e8f0", color:"#334155", padding:"4px 7px", borderRadius:7, fontSize:11 }} />
              <input type="number" value={filterValorMin} onChange={function(e){setFilterValorMin(e.target.value);}} placeholder="Mín R$"
                style={{ width:72, background:"#fff", border:"1px solid #e2e8f0", color:"#0f172a", padding:"4px 7px", borderRadius:7, fontSize:11, outline:"none" }} />
              <input type="number" value={filterValorMax} onChange={function(e){setFilterValorMax(e.target.value);}} placeholder="Máx R$"
                style={{ width:72, background:"#fff", border:"1px solid #e2e8f0", color:"#0f172a", padding:"4px 7px", borderRadius:7, fontSize:11, outline:"none" }} />
              <input value={filterDoc} onChange={function(e){setFilterDoc(e.target.value);}} placeholder="Nº doc..."
                style={{ width:90, background:"#fff", border:"1px solid #e2e8f0", color:"#0f172a", padding:"4px 7px", borderRadius:7, fontSize:11, outline:"none" }} />
              {(filterValorMin||filterValorMax||filterDoc||pagarDe||pagarAte) && (
                <button onClick={function(){setFilterValorMin("");setFilterValorMax("");setFilterDoc("");setPagarDe("");setPagarAte("");}}
                  style={{ background:"#fef2f2", border:"1px solid #fecaca", color:"#dc2626", padding:"4px 8px", borderRadius:7, cursor:"pointer", fontSize:11 }}>✕</button>
              )}
            </div>
            <span style={{ fontSize:11, color:"#94a3b8", marginLeft:"auto", whiteSpace:"nowrap" }}>{contasFiltradas.length} conta(s)</span>
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
          <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:8, marginBottom:10 }}>
            {[
              { label:"Pendente", value:fmt(contasPagar.filter(c=>c.status==="Pendente").reduce((s,c)=>s+parseFloat(c.valor||0),0)), color:"#d97706", bg:"#fffbeb" },
              { label:"Vencido",  value:fmt(totalVencido), color:"#dc2626", bg:"#fef2f2" },
              { label:"Pago",     value:fmt(totalPago),    color:"#15803d", bg:"#f0fdf4" },
            ].map(k => (
              <div key={k.label} style={{ background:k.bg, borderRadius:10, padding:"12px 16px" }}>
                <div style={{ fontSize:11, color:k.color, fontWeight:700, textTransform:"uppercase", marginBottom:4 }}>{k.label}</div>
                <div style={{ fontSize:15, fontWeight:800, color:k.color }}>{k.value}</div>
              </div>
            ))}
          </div>
          {selecionadas.length > 0 && (
            <div style={{ background:"#0f172a", borderRadius:12, padding:"12px 16px", marginBottom:10 }}>
              <div style={{ display:"flex", alignItems:"center", gap:7, flexWrap:"wrap" }}>
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
                ) : contasFiltradas.slice((paginaPagar-1)*POR_PAG_FIN, paginaPagar*POR_PAG_FIN).map((c,i) => {
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
                          var prConta = c.prioridade || "media";
                          // Verificar se fornecedor tem prioridade cadastrada
                          var forn = (fornecedores||[]).find(function(f){ return f.id === c.fornecedorId; });
                          var prForn = forn?.prioridade;
                          // Usar prioridade da conta; se for padrão (media), considerar a do fornecedor
                          var pr = (prConta !== "media") ? prConta : (prForn || prConta);
                          var cfg = pr === "alta"
                            ? { label:"!!!", title:"Alta Prioridade", cor:"#dc2626", bg:"#fef2f2", border:"#fecaca" }
                            : pr === "baixa"
                            ? { label:"!", title:"Baixa Prioridade", cor:"#15803d", bg:"#f0fdf4", border:"#bbf7d0" }
                            : { label:"!!", title:"Média Prioridade", cor:"#d97706", bg:"#fffbeb", border:"#fde68a" };
                          return (
                            <div>
                              <span title={cfg.title + (prForn ? " (do fornecedor)" : "")} style={{ fontSize:13, fontWeight:800, color:cfg.cor, background:cfg.bg, border:"1px solid " + cfg.border, padding:"3px 8px", borderRadius:6, display:"inline-block", cursor:"default", letterSpacing:1 }}>
                                {cfg.label}
                              </span>
                              {prForn && prConta === "media" && (
                                <div style={{ fontSize:9, color:"#94a3b8", marginTop:2 }}>fornecedor</div>
                              )}
                            </div>
                          );
                        })()}
                      </td>
                      <td style={{ padding:"7px 10px", fontSize:12, color:"#0f172a", fontWeight:500 }}>
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
                      <td style={{ padding:"7px 10px", fontSize:11, color:"#64748b" }}>{c.categoria}</td>
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
                      <td style={{ padding:"7px 10px", fontSize:11, color:"#64748b" }}>{fmtDate(c.vencimento)}</td>
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
                      <td style={{ padding:"7px 10px", fontSize:11, color:"#64748b" }}>
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
            <Paginacao
              total={contasFiltradas.length}
              porPagina={POR_PAG_FIN}
              paginaAtual={paginaPagar}
              onMudar={function(p){ setPaginaPagar(p); window.scrollTo({top:0,behavior:"smooth"}); }}
            />
          </div>
          </LayoutFiltros>
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

        function exportarReceber(tipo) {
          var cab=["Pedido","Data Venda","Produto","Bruto","Líquido (MP)","Taxa ML","Frete","Previsão Pagamento","Status"];
          var linhas=aReceber.map(function(o){
            var pd=paymentData?.[o.id]; var ss=shipmentStatuses?.[o.id]??o.shipment_status;
            var bruto=o.price*(o.qty||1); var liq=pd?.netAmount||bruto*0.87;
            var taxa=pd?.tarifaML||bruto*0.13; var frete=pd?.freteCusto||0;
            var rel=pd?.releaseDate?fmtDate(pd.releaseDate):"—";
            var stat=pd?.isReleased?"Liberado":ss==="delivered"?"Entregue":ss==="shipped"?"Enviado":"Aguardando";
            return ["#"+o.id,fmtDate(o.date),(o.title||"").slice(0,40),"R$ "+bruto.toFixed(2).replace(".",","),"R$ "+liq.toFixed(2).replace(".",","),"R$ "+taxa.toFixed(2).replace(".",","),"R$ "+frete.toFixed(2).replace(".",","),rel,stat];
          });
          var totStr=["Total a receber: "+aReceber.length+" pedido(s)","Total bruto: R$ "+aReceber.reduce(function(s,o){return s+o.price*(o.qty||1);},0).toFixed(2).replace(".",",")];
          if(tipo==="csv") exportarCSV("contas_a_receber",cab,linhas);
          else if(tipo==="xls") exportarXLS("contas_a_receber",cab,linhas);
          else exportarPDF("contas_a_receber","Contas a Receber",cab,linhas,totStr);
        }

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
          <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(160px,1fr))", gap:7, marginBottom:8 }}>
            {[
              { label:"A Receber (líq.)", value:fmt(totalLiq), color:"#0891b2", bg:"#ecfeff",
                desc: aReceber.length + " pedido(s)" },
              { label:"Bruto Total", value:fmt(totalBruto), color:"#64748b", bg:"#f8fafc", desc:"Antes das taxas" },
              { label:"Tarifas ML", value:fmt(totalTarifas), color:"#d97706", bg:"#fffbeb", desc:"Comissão ML" },
              { label:"Frete (custo)", value:fmt(totalFrete), color:"#7c3aed", bg:"#f5f3ff", desc:"Seu custo de envio" },
              { label:"Já Registrado", value:fmt(totalRecebidoMesLiq), color:"#15803d", bg:"#f0fdf4", desc: recebidoMes.length + " entregue(s)" },
            ].map(function(k) {
              return (
                <div key={k.label} style={{ background:k.bg, borderRadius:10, padding:"10px 14px" }}>
                  <div style={{ fontSize:10, color:k.color, fontWeight:700, textTransform:"uppercase", marginBottom:4 }}>{k.label}</div>
                  <div style={{ fontSize:15, fontWeight:800, color:k.color }}>{k.value}</div>
                  <div style={{ fontSize:11, color:k.color, opacity:0.7, marginTop:2 }}>{k.desc}</div>
                </div>
              );
            })}
          </div>

          {/* Aviso sobre dados estimados */}
          {semPrevisao.length > 0 && (
            <div style={{ background:"#fffbeb", border:"1px solid #fde68a", borderRadius:10, padding:"10px 14px", marginBottom:8, fontSize:12, color:"#92400e", display:"flex", alignItems:"center", gap:8 }}>
              <span style={{ fontSize:16 }}>ℹ️</span>
              <div>
                <strong>{semPrevisao.length} pedido(s)</strong> ainda sem dados de pagamento da API do ML — o valor líquido é estimado com ~13% de taxa.
                {totalComDados > 0 && <span style={{ marginLeft:6, color:"#15803d" }}>✓ {totalComDados} pedidos com dados reais</span>}
              </div>
            </div>
          )}

          {/* Alertas de liberação próxima */}
          {proximosLiberados.length > 0 && (
            <div style={{ background:"#f0fdf4", border:"1px solid #bbf7d0", borderRadius:10, padding:"10px 14px", marginBottom:8, display:"flex", alignItems:"center", gap:10 }}>
              <span style={{ fontSize:18 }}>💰</span>
              <div>
                <div style={{ fontWeight:700, color:"#15803d", fontSize:13 }}>{proximosLiberados.length} pagamento(s) liberando nos próximos 7 dias</div>
                <div style={{ fontSize:12, color:"#166534" }}>Total: {fmt(prevProx7)} líquido a cair no Mercado Pago</div>
              </div>
            </div>
          )}

          {/* Header + Botão de Baixa Automática */}
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:10, flexWrap:"wrap", gap:10 }}>
            <div style={{ fontWeight:700, fontSize:14, color:"#0f172a", whiteSpace:"nowrap" }}>
              {receberVista === "recebido" ? "✅ Pedidos Registrados" : receberVista === "todos" ? "📋 Todos os Pedidos" : "📥 Pedidos a Receber"}
            </div>
            <div style={{ display:"flex", gap:8, alignItems:"center" }}>
              <BotaoExportar onCSV={function(){exportarReceber("csv");}} onXLS={function(){exportarReceber("xls");}} onPDF={function(){exportarReceber("pdf");}} />
              {receberVista !== "recebido" && (
                <button onClick={baixaAutomaticaLiberados}
                  style={{ background:"#15803d", border:"none", color:"#fff", fontWeight:700, padding:"8px 16px", borderRadius:8, cursor:"pointer", fontSize:12, display:"flex", alignItems:"center", gap:6, whiteSpace:"nowrap" }}>
                  ⚡ Baixar Liberados Automaticamente
                </button>
              )}
            </div>
          </div>
          {/* Filtros */}
          <div style={{ display:"flex", gap:7, alignItems:"center", marginBottom:10, flexWrap:"wrap" }}>
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
          <div style={{ background:"#f8fafc", border:"1px solid #e2e8f0", borderRadius:10, padding:"10px 14px", marginBottom:8 }}>
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
          <div style={{ display:"flex", gap:4, marginBottom:8, background:"#f1f5f9", padding:4, borderRadius:10, width:"fit-content" }}>
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
              }} style={{ background:"#dc2626", border:"none", color:"#fff", fontWeight:700, padding:"4px 10px", borderRadius:8, cursor:"pointer", fontSize:12 }}>
                🗑 Excluir Lançamentos
              </button>
              <button onClick={function(){ setReceberSel([]); }}
                style={{ background:"#334155", border:"none", color:"#94a3b8", padding:"6px 12px", borderRadius:8, cursor:"pointer", fontSize:12 }}>✕ Cancelar</button>
            </div>
          )}
          <div style={{ background:"#fff", border:"1px solid #e2e8f0", borderRadius:12, overflow:"auto", marginBottom:10 }}>
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
                  return filtered.slice((paginaReceber-1)*POR_PAG_FIN, paginaReceber*POR_PAG_FIN).map(function(o, i) {
                    var ss = shipmentStatuses?.[o.id] ?? o.shipment_status;
                    var isDelivered2 = ss === "delivered" || (o.tags||[]).some(function(t){return t==="delivered";});
                    var isEnviado = ["shipped","in_transit"].includes(ss);
                    var envLabel = detectTipoEnvio(o, shipmentStatuses);
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
                    var taxaTarifa = bruto > 0 ? (tarifaExib / bruto * 100) : 0;
                    var taxaFrete  = bruto > 0 ? (freteExib  / bruto * 100) : 0;
                    var taxa = taxaTarifa + taxaFrete; // total (para compatibilidade)
                    // Previsão: data real da API > +2 dias após entrega > +14 dias após venda
                    var releaseDate = pd?.releaseDate || null;
                    if (!releaseDate) {
                      var ss2 = shipmentStatuses?.[o.id] ?? o.shipment_status;
                      var isDelivered3 = ss2 === "delivered" || (o.tags||[]).some(function(t){return t==="delivered";});
                      if (isDelivered3 && o.date) {
                        // Entregue: previsão de liberação em 2 dias úteis
                        var dEnt = new Date(o.date + "T00:00:00");
                        dEnt.setDate(dEnt.getDate() + 2);
                        releaseDate = dEnt.toLocaleDateString("sv-SE");
                      } else if (o.date) {
                        // Não entregue: previsão conservadora de 14 dias da venda
                        var d14 = new Date(o.date + "T00:00:00");
                        d14.setDate(d14.getDate() + 14);
                        releaseDate = d14.toLocaleDateString("sv-SE");
                      }
                    }
                    var relDays = releaseDate ? getDaysUntil(releaseDate) : null;
                    var jaRegistrado = lancamentos.some(function(l){ return l.tipo==="recebimento" && String(l.pedidoId) === String(o.id); });

                    // Cor da previsão
                    var isRealmenteLib = pd?.isReleased || (relDays !== null && relDays <= 0);
                    var relColor = "#94a3b8", relBg = "#f8fafc";
                    if (releaseDate) {
                      if (isRealmenteLib) { relColor = "#15803d"; relBg = "#f0fdf4"; }
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
                        <td style={{ padding:"7px 10px", fontSize:11, color:"#64748b", fontFamily:"monospace", fontWeight:600 }}>#{o.id}</td>
                        <td style={{ padding:"7px 10px", fontSize:11, color:"#334155", maxWidth:100, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{o.buyerName||"—"}</td>
                        <td style={{ padding:"7px 10px", fontSize:11, color:"#0f172a", maxWidth:180, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }} title={o.title}>{o.title||"—"}</td>
                        <td style={{ padding:"7px 10px", fontSize:11, color:"#64748b", whiteSpace:"nowrap" }}>{fmtDate(o.date)}</td>
                        <td style={{ padding:"7px 10px", fontSize:11, color:"#64748b", whiteSpace:"nowrap" }}>{fmt(bruto)}</td>
                        <td style={{ padding:"10px 14px", whiteSpace:"nowrap" }}>
                          {tarifaExib > 0 ? (
                            <span style={{ fontSize:13, fontWeight:700, color:"#d97706" }}>{fmt(tarifaExib)}</span>
                          ) : (
                            <span style={{ fontSize:12, color:"#94a3b8" }}>—</span>
                          )}
                          {taxaTarifa > 0 && <div style={{ fontSize:9, color:"#d97706", opacity:0.8 }}>{taxaTarifa.toFixed(1)}%</div>}
                        </td>
                        <td style={{ padding:"10px 14px", whiteSpace:"nowrap" }}>
                          {freteExib > 0 ? (
                            <span style={{ fontSize:13, fontWeight:700, color:"#7c3aed" }}>{fmt(freteExib)}</span>
                          ) : (
                            <span style={{ fontSize:12, color:"#94a3b8" }}>—</span>
                          )}
                          {taxaFrete > 0 && <div style={{ fontSize:9, color:"#7c3aed", opacity:0.8 }}>{taxaFrete.toFixed(1)}%</div>}
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
                                {isRealmenteLib ? "✓ Liberado" : fmtDate(releaseDate)}
                              </div>
                              {isRealmenteLib
                                ? <div style={{ fontSize:10, color:relColor, opacity:0.8 }}>{fmtDate(releaseDate)}</div>
                                : <div style={{ fontSize:10, color:relColor, opacity:0.8 }}>previsão · em {relDays} dia(s)</div>
                              }
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
                            var lanc = lancamentos.find(function(l){ return l.tipo==="recebimento" && String(l.pedidoId)===String(o.id); });
                            var isAuto = lanc && lanc.automatico;
                            return (
                              <div>
                                <span style={{ fontSize:11, color:"#15803d", fontWeight:700 }}>✓ {isAuto ? "Auto" : "Registrado"}</span>
                                {lanc?.data && <div style={{ fontSize:10, color:"#15803d", opacity:0.8 }}>{fmtDate(lanc.data)}</div>}
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
            <div style={{padding:"4px 0"}}><Paginacao total={receberVista==="recebido"?recebidoMes.length:aReceber.length} porPagina={POR_PAG_FIN} paginaAtual={paginaReceber} onMudar={function(p){setPaginaReceber(p);window.scrollTo({top:0,behavior:"smooth"});}} /></div>
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
                      <td style={{ padding:"7px 10px", fontSize:11, color:"#64748b", fontFamily:"monospace", fontWeight:600 }}>#{o.id}</td>
                      <td style={{ padding:"7px 10px", fontSize:11, color:"#0f172a", maxWidth:260, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{o.title||"—"}</td>
                      <td style={{ padding:"7px 10px", fontSize:11, color:"#64748b" }}>{fmtDate(o.date)}</td>
                      <td style={{ padding:"7px 10px", fontSize:11, color:"#64748b" }}>{fmt(bruto)}</td>
                      <td style={{ padding:"10px 14px" }}>
                        <div style={{ fontSize:13, fontWeight:700, color: net ? "#15803d" : "#d97706" }}>{fmt(netFinal)}</div>
                        {!net && <div style={{ fontSize:9, color:"#94a3b8", fontStyle:"italic" }}>~estimado</div>}
                      </td>
                      <td style={{ padding:"7px 10px", fontSize:11, fontWeight:600, color: taxa > 15 ? "#dc2626" : taxa > 10 ? "#d97706" : "#15803d" }}>
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
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8 }}>
            <div style={{ fontWeight:700, fontSize:15, color:"#0f172a" }}>Contas Cadastradas</div>
            <div style={{ display:"flex", gap:8 }}>
              <BotaoExportar
                onCSV={function(){
                  var cab=["Conta","Tipo","Banco","Agência","Nº Conta","Saldo Inicial","Saldo Atual"];
                  var linhas=contasBancarias.map(function(b){ var s=getSaldoConta(b.id); return [b.nome,b.tipo||"—",b.banco||"—",b.agencia||"—",b.numeroConta||"—","R$ "+parseFloat(b.saldoInicial||0).toFixed(2).replace(".",","),"R$ "+s.toFixed(2).replace(".",",")]; });
                  exportarCSV("caixas_e_bancos",cab,linhas);
                }}
                onXLS={function(){
                  var cab=["Conta","Tipo","Banco","Agência","Nº Conta","Saldo Inicial","Saldo Atual"];
                  var linhas=contasBancarias.map(function(b){ var s=getSaldoConta(b.id); return [b.nome,b.tipo||"—",b.banco||"—",b.agencia||"—",b.numeroConta||"—","R$ "+parseFloat(b.saldoInicial||0).toFixed(2).replace(".",","),"R$ "+s.toFixed(2).replace(".",",")]; });
                  exportarXLS("caixas_e_bancos",cab,linhas);
                }}
                onPDF={function(){
                  var cab=["Conta","Tipo","Banco","Saldo Inicial","Saldo Atual"];
                  var linhas=contasBancarias.map(function(b){ var s=getSaldoConta(b.id); return [b.nome,b.tipo||"—",b.banco||"—","R$ "+parseFloat(b.saldoInicial||0).toFixed(2).replace(".",","),"R$ "+s.toFixed(2).replace(".",",")]; });
                  var total=contasBancarias.reduce(function(s,b){return s+getSaldoConta(b.id);},0);
                  exportarPDF("caixas_e_bancos","Caixas e Bancos",cab,linhas,["Total em caixa: R$ "+total.toFixed(2).replace(".",","),"Contas cadastradas: "+contasBancarias.length]);
                }}
              />
              {contasBancarias.length >= 2 && (
                <button onClick={function(){ setShowModalTransf(true); }}
                  style={{ background:"#0891b2", border:"none", color:"#fff", fontWeight:700, padding:"9px 20px", borderRadius:8, cursor:"pointer", fontSize:13, display:"flex", alignItems:"center", gap:6 }}>
                  ⇄ Transferir entre Contas
                </button>
              )}
              <button onClick={() => { setEditingBancaria(null); setShowModalBancaria(true); }}
                style={{ background:"#0f172a", border:"none", color:"#fff", fontWeight:700, padding:"9px 20px", borderRadius:8, cursor:"pointer", fontSize:13 }}>+ Nova Conta</button>
            </div>
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
                      <div style={{ fontSize:15, fontWeight:800, color:saldo>=0?"#15803d":"#dc2626" }}>{fmt(saldo)}</div>
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
              if (extratoTipo !== "todos" && l.tipo !== extratoTipo) return false;
              if (extratoSearch) {
                var qs = extratoSearch.toLowerCase();
                if (!((l.descricao||"").toLowerCase().includes(qs))) return false;
              }
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
                  <div style={{ display:"flex", gap:8, alignItems:"center", flexWrap:"wrap", marginBottom:8 }}>
                    <input type="date" value={extratoDe} onChange={function(e){ setExtratoDe(e.target.value); setExtratoSel([]); }}
                      style={{ background:"#fff", border:"1px solid #e2e8f0", color:"#334155", padding:"5px 10px", borderRadius:8, fontSize:12 }} />
                    <span style={{ fontSize:12, color:"#94a3b8" }}>até</span>
                    <input type="date" value={extratoAte} onChange={function(e){ setExtratoAte(e.target.value); setExtratoSel([]); }}
                      style={{ background:"#fff", border:"1px solid #e2e8f0", color:"#334155", padding:"5px 10px", borderRadius:8, fontSize:12 }} />
                    {(extratoDe||extratoAte) && (
                      <button onClick={function(){ setExtratoDe(""); setExtratoAte(""); setExtratoSel([]); }}
                        style={{ background:"#f1f5f9", border:"1px solid #e2e8f0", color:"#64748b", padding:"5px 10px", borderRadius:8, cursor:"pointer", fontSize:12 }}>✕</button>
                    )}
                    <span style={{ fontSize:12, color:"#94a3b8", marginLeft:"auto" }}>{movs.length} lançamento(s)</span>
                  </div>
                  <div style={{ display:"flex", gap:6, alignItems:"center", flexWrap:"wrap" }}>
                    {/* Filtro tipo */}
                    {[
                      { k:"todos",        l:"📋 Todos" },
                      { k:"recebimento",  l:"↑ Entradas" },
                      { k:"pagamento",    l:"↓ Saídas" },
                    ].map(function(t){
                      var active = extratoTipo === t.k;
                      return <button key={t.k} onClick={function(){ setExtratoTipo(t.k); setExtratoSel([]); }}
                        style={{ padding:"3px 9px", borderRadius:20, border: active?"2px solid #0f172a":"1px solid #e2e8f0",
                          background: active?"#0f172a":"#f8fafc", color: active?"#fff":"#64748b",
                          fontWeight: active?700:500, fontSize:12, cursor:"pointer" }}>{t.l}</button>;
                    })}
                    <div style={{ position:"relative", flex:1, minWidth:160 }}>
                      <span style={{ position:"absolute", left:8, top:"50%", transform:"translateY(-50%)", color:"#94a3b8", fontSize:12 }}>🔍</span>
                      <input value={extratoSearch} onChange={function(e){ setExtratoSearch(e.target.value); }}
                        placeholder="Buscar descrição, fornecedor..."
                        style={{ width:"100%", background:"#fff", border:"1px solid #e2e8f0", color:"#0f172a", padding:"5px 10px 5px 26px", borderRadius:8, fontSize:12, outline:"none" }} />
                    </div>
                    {extratoSearch && <button onClick={function(){ setExtratoSearch(""); }} style={{ background:"#f1f5f9", border:"1px solid #e2e8f0", color:"#64748b", padding:"5px 8px", borderRadius:8, cursor:"pointer", fontSize:12 }}>✕</button>}
                  </div>
                  {extratoSel.length > 0 && (
                    <div style={{ display:"flex", gap:8, alignItems:"center", marginTop:8, background:"#0f172a", borderRadius:8, padding:"5px 8px", flexWrap:"wrap" }}>
                      <span style={{ color:"#fff", fontWeight:700, fontSize:12 }}>{extratoSel.length} selecionado(s)</span>
                      <button onClick={function(){
                        if (!window.confirm("Excluir " + extratoSel.length + " lançamento(s)?")) return;
                        var upd = lancamentos.filter(function(x){ return !extratoSel.includes(x.id); });
                        setLancamentos(upd); saveLS("lancamentos", upd); setExtratoSel([]);
                      }} style={{ background:"#dc2626", border:"none", color:"#fff", fontWeight:700, padding:"3px 9px", borderRadius:6, cursor:"pointer", fontSize:12 }}>
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
                              {l.transferencia && <span style={{ marginLeft:6, fontSize:10, background:"#eff6ff", color:"#1d4ed8", border:"1px solid #bfdbfe", borderRadius:4, padding:"1px 5px" }}>⇄ transf.</span>}
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
                          <td style={{ padding:"7px 10px", fontSize:11, color:"#64748b" }}>{fmtDate(l.data)}</td>
                          <td style={{ padding:"7px 10px", fontSize:12, color:"#0f172a" }}>{l.descricao}</td>
                          <td style={{ padding:"7px 10px", fontSize:11 }}>
                            {cb ? <span style={{ display:"flex", alignItems:"center", gap:4 }}><div style={{ width:8,height:8,borderRadius:"50%",background:cb.cor }}/>{cb.nome}</span> : "—"}
                          </td>
                          <td style={{ padding:"10px 14px" }}>
                            <span style={{ fontSize:11, fontWeight:600, color:l.tipo==="recebimento"?"#15803d":"#dc2626", background:l.tipo==="recebimento"?"#f0fdf4":"#fef2f2", padding:"2px 8px", borderRadius:5 }}>
                              {l.tipo==="recebimento"?"↑ Entrada":"↓ Saída"}
                            </span>
                          </td>
                          <td style={{ padding:"7px 10px", fontSize:12, fontWeight:700, color:l.tipo==="recebimento"?"#15803d":"#dc2626" }}>
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
        <div style={{ maxWidth:1100 }}>
          {/* Painel compacto de Impostos e Custos Fixos */}
          <div style={{ marginBottom:10 }}>
            <div style={{ fontWeight:700, fontSize:15, color:"#0f172a", marginBottom:4 }}>Impostos e Custos Fixos</div>
            <div style={{ fontSize:12, color:"#94a3b8", marginBottom:12 }}>Usados para calcular o Lucro Real no painel principal</div>
            <ImpostosCompacto
              impostos={impostos}
              setImpostos={setImpostos}
              custosFixos={custosFixos}
              setCustosFixos={setCustosFixos}
              faturamentoMes={enrichedOrders.filter(o=>o.date?.startsWith(new Date().toLocaleDateString("sv-SE").slice(0,7))).reduce((s,o)=>s+o.revenue*o.qty,0)}
              irpjCsllConfig={irpjCsllConfig}
              setIrpjCsllConfig={setIrpjCsllConfig}
            />
          </div>

          <div style={{ borderTop:"1px solid #f1f5f9", paddingTop:20 }}>
          <div style={{ fontWeight:700, fontSize:15, color:"#0f172a", marginBottom:4 }}>Fornecedores Cadastrados</div>
          <div style={{ fontSize:12, color:"#94a3b8", marginBottom:10 }}>
            {fornecedores.length} fornecedor(es) — aparecem no autocomplete das contas a pagar.
            Cadastre mais em <strong>🛍️ Produtos → 🏭 Fornecedores</strong>.
          </div>
          <div style={{ display:"flex", flexWrap:"wrap", gap:6, marginBottom:10 }}>
            {fornecedores.length === 0
              ? <span style={{ fontSize:12, color:"#94a3b8" }}>Nenhum fornecedor cadastrado ainda.</span>
              : fornecedores.map(f => (
                <span key={f.id} style={{ fontSize:12, background:"#eff6ff", color:"#1d4ed8", border:"1px solid #bfdbfe", padding:"3px 10px", borderRadius:20, fontWeight:500 }}>
                  🏭 {f.nome}
                </span>
              ))
            }
          </div>

          <div style={{ fontWeight:700, fontSize:15, color:"#0f172a", marginBottom:8 }}>Categorias de Contas a Pagar</div>
          <div style={{ background:"#fff", border:"1px solid #e2e8f0", borderRadius:12, padding:"16px 20px", marginBottom:8 }}>
            <div style={{ display:"flex", gap:8, marginBottom:8 }}>
              <input value={novaCat} onChange={e=>setNovaCat(e.target.value)}
                onKeyDown={e=>e.key==="Enter"&&addCategoria()}
                placeholder="Nova categoria..."
                style={{ flex:1, background:"#f8fafc", border:"1px solid #e2e8f0", color:"#0f172a", padding:"5px 8px", borderRadius:8, fontSize:13, outline:"none" }} />
              <button onClick={addCategoria} disabled={!novaCat.trim()}
                style={{ background:novaCat.trim()?"#0f172a":"#f1f5f9", border:"none", color:novaCat.trim()?"#fff":"#94a3b8", fontWeight:700, padding:"8px 16px", borderRadius:8, cursor:novaCat.trim()?"pointer":"not-allowed", fontSize:13 }}>
                Adicionar
              </button>
            </div>
            <div style={{ display:"flex", flexWrap:"wrap", gap:8 }}>
              {categoriasPagar.map(cat => (
                <div key={cat} style={{ display:"flex", alignItems:"center", gap:6, background:"#f1f5f9", border:"1px solid #e2e8f0", borderRadius:20, padding:"3px 9px" }}>
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
      {finTab === "ia" && (
        <div>
          <div style={{ marginBottom:8 }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start" }}>
              <div>
                <div style={{ fontWeight:800, fontSize:18, color:"#0f172a", marginBottom:4 }}>✦ Consultoria Financeira com IA</div>
                <div style={{ fontSize:13, color:"#94a3b8" }}>Análise automática de prioridade de pagamentos, simulação de empréstimos e consultor CFO virtual.</div>
              </div>
              <BotaoExportar
                onCSV={function(){
                  var cab=["Descrição","Valor","Vencimento","Status","Prioridade","Categoria"];
                  var linhas=contasPagar.filter(function(c){return c.status!=="Pago";}).sort(function(a,b){return (a.vencimento||"")>(b.vencimento||"")?1:-1;}).map(function(c){ return [c.descricao,"R$ "+parseFloat(c.valor||0).toFixed(2).replace(".",","),fmtDate(c.vencimento),c.status,c.prioridade||"media",c.categoria||"—"]; });
                  exportarCSV("consultoria_ia_pendentes",cab,linhas);
                }}
                onXLS={function(){
                  var cab=["Descrição","Valor","Vencimento","Status","Prioridade","Categoria"];
                  var linhas=contasPagar.filter(function(c){return c.status!=="Pago";}).sort(function(a,b){return (a.vencimento||"")>(b.vencimento||"")?1:-1;}).map(function(c){ return [c.descricao,"R$ "+parseFloat(c.valor||0).toFixed(2).replace(".",","),fmtDate(c.vencimento),c.status,c.prioridade||"media",c.categoria||"—"]; });
                  exportarXLS("consultoria_ia_pendentes",cab,linhas);
                }}
                onPDF={function(){
                  var pending=contasPagar.filter(function(c){return c.status!=="Pago";});
                  var cab=["Descrição","Valor","Vencimento","Prioridade","Status"];
                  var linhas=pending.sort(function(a,b){return (a.vencimento||"")>(b.vencimento||"")?1:-1;}).map(function(c){ return [c.descricao,"R$ "+parseFloat(c.valor||0).toFixed(2).replace(".",","),fmtDate(c.vencimento),c.prioridade||"media",c.status]; });
                  var total=pending.reduce(function(s,c){return s+parseFloat(c.valor||0);},0);
                  exportarPDF("consultoria_ia_pendentes","Consultoria IA — Contas Pendentes",cab,linhas,["Total pendente: R$ "+total.toFixed(2).replace(".",","),"Qtd contas: "+pending.length]);
                }}
              />
            </div>
          </div>
          <PainelIAPagamentos contasPagar={contasPagar} contasBancarias={contasBancarias} lancamentos={lancamentos} enrichedOrders={enrichedOrders} paymentData={paymentData} shipmentStatuses={shipmentStatuses} />
        </div>
      )}

      {showModalConta && <ModalConta conta={editingConta} categoriasPagar={categoriasPagar} fornecedores={fornecedores} contasPagar={contasPagar} onSave={saveConta} onClose={()=>{ setShowModalConta(false); setEditingConta(null); }} />}
      {showModalBancaria && <ModalContaBancaria conta={editingBancaria} onSave={saveBancaria} onClose={()=>{ setShowModalBancaria(false); setEditingBancaria(null); }} />}
      {showModalTransf && (
        <ModalTransferencia
          contasBancarias={contasBancarias}
          onConfirm={function(origem, destino, valor, descricao, data) {
            // Criar dois lançamentos: saída da origem + entrada no destino
            var id1 = Date.now();
            var id2 = Date.now() + 1;
            var desc = descricao || ("Transferência: " + (contasBancarias.find(function(c){return c.id===origem;})||{}).nome + " → " + (contasBancarias.find(function(c){return c.id===destino;})||{}).nome);
            var novos = [
              { id:id1, tipo:"pagamento",    descricao:desc, valor:valor, data:data, contaBancariaId:origem,  transferencia:true, parId:id2 },
              { id:id2, tipo:"recebimento",  descricao:desc, valor:valor, data:data, contaBancariaId:destino, transferencia:true, parId:id1 },
            ];
            var upd = [...lancamentos, ...novos];
            setLancamentos(upd); saveLS("lancamentos", upd);
            setShowModalTransf(false);
          }}
          onClose={function(){ setShowModalTransf(false); }}
        />
      )}
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


// ════════════════════════════════════════════════════════════
//  NOTAS FISCAIS DE SAÍDA (ML)
// ════════════════════════════════════════════════════════════
function NfSaidaTab({ enrichedOrders, nfeSaida, setNfeSaida, loadingNfe, setLoadingNfe, token, getValidToken }) {
  const [search, setSearch] = useState("");
  const [filtroStatus, setFiltroStatus] = useState("todos"); // todos | com_nf | sem_nf
  const [filtroDe, setFiltroDe] = useState("");
  const [filtroAte, setFiltroAte] = useState("");
  const [expandido, setExpandido] = useState(null);
  const [erroBusca, setErroBusca] = useState(null);

  async function buscarNFs() {
    if (!token) { alert("Reconecte ao ML primeiro"); return; }
    setLoadingNfe(true);
    setErroBusca(null);
    setNfeSaida({});
    var mapa = {};
    var pedidos = enrichedOrders.filter(function(o){ return o.status === "paid"; }).slice(0, 200);

    // Garante um token válido (renova automaticamente se estiver perto de expirar) —
    // evita que a busca falhe silenciosamente por token vencido.
    var tk = token;
    if (typeof getValidToken === "function") {
      try { tk = (await getValidToken()) || token; } catch(e) {}
    }

    var contagemErros = { 401: 0, 403: 0, outros: 0 };
    function registrarErro(status) {
      if (status === 401) contagemErros[401]++;
      else if (status === 403) contagemErros[403]++;
      else contagemErros.outros++;
    }

    // Helper robusto para extrair NF de qualquer formato ML
    function extrairNF(d) {
      if (!d || d.error || d.status === 404 || d.status === 400) return null;
      // Tentar todos os formatos conhecidos do ML
      var candidatos = [];
      if (Array.isArray(d)) candidatos = d;
      else if (Array.isArray(d.results)) candidatos = d.results;
      else if (Array.isArray(d.fiscal_documents)) candidatos = d.fiscal_documents;
      else if (Array.isArray(d.invoices)) candidatos = d.invoices;
      else if (d.invoice_data) candidatos = [d.invoice_data];
      else if (d.billing_info) candidatos = [d.billing_info];
      else if (d.nfe || d.nfce || d.nfs) candidatos = [d.nfe || d.nfce || d.nfs];
      else candidatos = [d];

      for (var ci = 0; ci < candidatos.length; ci++) {
        var doc = candidatos[ci];
        if (!doc) continue;
        var numero = doc.number || doc.serie_number || doc.invoice_number || doc.nota_fiscal_number || null;
        var chave  = doc.access_key || doc.key || doc.nfe_access_key || doc.chave_acesso || doc.access_code || null;
        // Chave NF-e tem 44 dígitos
        if (chave && chave.length !== 44) { var m = String(chave).match(/\d{44}/); chave = m ? m[0] : null; }
        var serie  = doc.serie || doc.series || null;
        var dataEm = doc.emission_date || doc.date_created || doc.issued_date || doc.date || null;
        var xmlUrl  = doc.xml_url || doc.xml || null;
        var danfeUrl = doc.pdf_url || doc.danfe_url || doc.danfe || doc.document_url || null;
        if (numero || chave || xmlUrl) {
          return { numero: numero, chave: chave, serie: serie, dataEmissao: dataEm, xmlUrl: xmlUrl, danfeUrl: danfeUrl, raw: doc };
        }
      }
      return null;
    }

    // Buscar dados completos do pedido para pegar invoice_data e pack_id
    async function buscarNFPedido(o) {
      var nfDados = null;
      var base = {
        orderId: o.id, orderTitle: o.title, orderDate: o.date,
        buyerName: o.buyerName, buyerDoc: o.buyerDoc, buyerUF: o.buyerUF,
        valor: o.price * o.qty,
      };

      // ── Endpoint principal: GET /orders/{id} com invoice_data ──────────
      // O ML retorna invoice_data dentro do próprio pedido quando NF foi emitida
      try {
        var rOrder = await fetch("/api/ml/orders/" + o.id, {
          headers: { Authorization: "Bearer " + tk }
        });
        if (rOrder.ok) {
          var dOrder = await rOrder.json();
          // invoice_data dentro do pedido
          if (dOrder.invoice_data) {
            nfDados = extrairNF(dOrder.invoice_data);
          }
          // fiscal_documents dentro do pedido
          if (!nfDados && dOrder.fiscal_documents) {
            nfDados = extrairNF(dOrder.fiscal_documents);
          }
          // Atualizar packId se disponível
          if (dOrder.pack_id) o.packId = String(dOrder.pack_id);
        } else {
          registrarErro(rOrder.status);
        }
      } catch(e) {}

      // ── Endpoint 2: orders/{id}/billing_info ──────────────────────────
      if (!nfDados) {
        try {
          var r2 = await fetch("/api/ml/orders/" + o.id + "/billing_info", {
            headers: { Authorization: "Bearer " + tk }
          });
          if (r2.ok) {
            var d2 = await r2.json();
            nfDados = extrairNF(d2);
            // Às vezes vem dentro de invoice_data
            if (!nfDados && d2.invoice_data) nfDados = extrairNF(d2.invoice_data);
          } else if (r2.status !== 404) {
            registrarErro(r2.status);
          }
        } catch(e) {}
      }

      // ── Endpoint 3: packs/{packId}/billing_info ───────────────────────
      if (!nfDados && o.packId) {
        try {
          var r3 = await fetch("/api/ml/packs/" + o.packId + "/billing_info", {
            headers: { Authorization: "Bearer " + tk }
          });
          if (r3.ok) {
            var d3 = await r3.json();
            nfDados = extrairNF(d3);
            if (!nfDados && d3.invoice_data) nfDados = extrairNF(d3.invoice_data);
          } else if (r3.status !== 404) {
            registrarErro(r3.status);
          }
        } catch(e) {}
      }

      // ── Endpoint 4: packs/{packId}/fiscal_documents ───────────────────
      if (!nfDados && o.packId) {
        try {
          var r4 = await fetch("/api/ml/packs/" + o.packId + "/fiscal_documents", {
            headers: { Authorization: "Bearer " + tk }
          });
          if (r4.ok) nfDados = extrairNF(await r4.json());
          else if (r4.status !== 404) registrarErro(r4.status);
        } catch(e) {}
      }

      if (nfDados) {
        mapa[String(o.id)] = Object.assign(base, nfDados);
      } else {
        mapa[String(o.id)] = Object.assign(base, { semNF: true });
      }
    }

    for (var i = 0; i < pedidos.length; i += 2) {
      await Promise.all(pedidos.slice(i, i + 2).map(buscarNFPedido));
      setNfeSaida(Object.assign({}, mapa)); // atualizar UI progressivamente
      await new Promise(function(r){ setTimeout(r, 400); });
    }
    setNfeSaida(Object.assign({}, mapa));
    setLoadingNfe(false);

    // Diagnóstico: se a maioria das tentativas voltou 401/403, o token está inválido/sem permissão —
    // isso explica "não consegue comunicar com o ML" sem nenhum erro visível antes desta correção.
    var totalErros = contagemErros[401] + contagemErros[403] + contagemErros.outros;
    if (contagemErros[401] > pedidos.length) {
      setErroBusca("⚠️ Token de acesso expirado ou inválido (erro 401 do Mercado Livre). Clique em \"Reconectar\" no topo da página e tente buscar novamente.");
    } else if (contagemErros[403] > pedidos.length) {
      setErroBusca("⚠️ Sua conta/aplicação no Mercado Livre não tem permissão para acessar dados fiscais (erro 403). Isso geralmente exige uma solicitação de acesso especial à API de faturamento junto ao Mercado Livre.");
    } else if (totalErros > pedidos.length * 2) {
      setErroBusca("⚠️ Muitos erros de comunicação com o Mercado Livre durante a busca (" + totalErros + " falhas). Tente novamente em alguns instantes.");
    }
  }

  var pedidosFiltrados = enrichedOrders.filter(function(o) {
    if (o.status !== "paid") return false;
    if (filtroDe && o.date && o.date < filtroDe) return false;
    if (filtroAte && o.date && o.date > filtroAte) return false;
    var nf = nfeSaida[String(o.id)];
    if (filtroStatus === "com_nf" && (!nf || nf.semNF)) return false;
    if (filtroStatus === "sem_nf" && (nf && !nf.semNF)) return false;
    if (search) {
      var q = search.toLowerCase();
      return String(o.id).includes(q) ||
        (o.title||"").toLowerCase().includes(q) ||
        (o.buyerName||"").toLowerCase().includes(q) ||
        (nf?.numero||"").includes(q) ||
        (nf?.chave||"").includes(q);
    }
    return true;
  });

  var comNF = Object.values(nfeSaida).filter(function(n){ return !n.semNF; }).length;
  var semNF = Object.values(nfeSaida).filter(function(n){ return n.semNF; }).length;

  return (
    <div>
      {/* Header */}
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:8, flexWrap:"wrap", gap:10 }}>
        <div>
          <div style={{ fontWeight:800, fontSize:18, color:"#0f172a" }}>🧾 Notas Fiscais de Saída</div>
          <div style={{ fontSize:12, color:"#94a3b8", marginTop:2 }}>Notas fiscais emitidas pelo Mercado Livre para suas vendas</div>
        </div>
        <button onClick={buscarNFs} disabled={loadingNfe}
          style={{ background: loadingNfe?"#f1f5f9":"#0f172a", border:"none", color: loadingNfe?"#94a3b8":"#fff",
            fontWeight:700, padding:"10px 20px", borderRadius:10, cursor: loadingNfe?"not-allowed":"pointer", fontSize:13,
            display:"flex", alignItems:"center", gap:8 }}>
          {loadingNfe ? "⏳ Buscando NFs..." : "🔄 Buscar NFs no ML"}
        </button>
      </div>

      {erroBusca && (
        <div style={{ background:"#fef2f2", border:"1px solid #fecaca", borderRadius:10, padding:"12px 16px", marginBottom:10, color:"#991b1b", fontSize:13, display:"flex", justifyContent:"space-between", alignItems:"center", gap:10 }}>
          <span>{erroBusca}</span>
          <button onClick={function(){ setErroBusca(null); }} style={{ background:"none", border:"none", color:"#991b1b", cursor:"pointer", fontSize:16, flexShrink:0 }}>✕</button>
        </div>
      )}

      {/* Cards resumo */}
      {Object.keys(nfeSaida).length > 0 && (
        <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(150px,1fr))", gap:7, marginBottom:8 }}>
          {[
            { label:"Total buscados", value: Object.keys(nfeSaida).length, color:"#0f172a", bg:"#f8fafc" },
            { label:"Com NF emitida", value: comNF, color:"#15803d", bg:"#f0fdf4" },
            { label:"Sem NF / Pendente", value: semNF, color:"#d97706", bg:"#fffbeb" },
          ].map(function(k) {
            return (
              <div key={k.label} style={{ background:k.bg, borderRadius:10, padding:"12px 16px" }}>
                <div style={{ fontSize:10, color:k.color, fontWeight:700, textTransform:"uppercase", marginBottom:4 }}>{k.label}</div>
                <div style={{ fontSize:15, fontWeight:800, color:k.color }}>{k.value}</div>
              </div>
            );
          })}
        </div>
      )}

      {/* Filtros */}
      <div style={{ display:"flex", gap:8, flexWrap:"wrap", alignItems:"center", marginBottom:12 }}>
        <div style={{ position:"relative", flex:1, minWidth:220 }}>
          <span style={{ position:"absolute", left:10, top:"50%", transform:"translateY(-50%)", color:"#94a3b8", fontSize:13 }}>🔍</span>
          <input value={search} onChange={function(e){ setSearch(e.target.value); }} placeholder="Buscar por pedido, cliente, nº NF, chave..."
            style={{ width:"100%", background:"#fff", border:"1px solid #e2e8f0", color:"#0f172a", padding:"8px 12px 8px 30px", borderRadius:8, fontSize:13, outline:"none" }} />
        </div>
        <div style={{ display:"flex", gap:4 }}>
          {[
            { k:"todos",   l:"📋 Todos" },
            { k:"com_nf",  l:"✅ Com NF" },
            { k:"sem_nf",  l:"⏳ Sem NF" },
          ].map(function(f) {
            var active = filtroStatus === f.k;
            return <button key={f.k} onClick={function(){ setFiltroStatus(f.k); }}
              style={{ padding:"7px 14px", borderRadius:8, border: active?"2px solid #0f172a":"1px solid #e2e8f0",
                background: active?"#0f172a":"#f8fafc", color: active?"#fff":"#64748b",
                fontWeight: active?700:500, fontSize:12, cursor:"pointer" }}>{f.l}</button>;
          })}
        </div>
        <input type="date" value={filtroDe} onChange={function(e){setFiltroDe(e.target.value);}}
          style={{ background:"#fff", border:"1px solid #e2e8f0", color:"#334155", padding:"7px 10px", borderRadius:8, fontSize:12 }} />
        <span style={{ fontSize:12, color:"#94a3b8" }}>até</span>
        <input type="date" value={filtroAte} onChange={function(e){setFiltroAte(e.target.value);}}
          style={{ background:"#fff", border:"1px solid #e2e8f0", color:"#334155", padding:"7px 10px", borderRadius:8, fontSize:12 }} />
      </div>

      {/* Aviso inicial */}
      {Object.keys(nfeSaida).length === 0 && (
        <div style={{ background:"#f0f9ff", border:"1px solid #bae6fd", borderRadius:12, padding:"32px", textAlign:"center", marginBottom:10 }}>
          <div style={{ fontSize:36, marginBottom:12 }}>🧾</div>
          <div style={{ fontWeight:700, fontSize:16, color:"#0f172a", marginBottom:8 }}>Buscar Notas Fiscais do ML</div>
          <div style={{ fontSize:13, color:"#64748b", marginBottom:8, maxWidth:500, margin:"0 auto 16px" }}>
            O Mercado Livre emite notas fiscais para as vendas. Clique em "Buscar NFs no ML" para carregar os dados fiscais de cada pedido.
          </div>
          <button onClick={buscarNFs} disabled={loadingNfe}
            style={{ background:"#0f172a", border:"none", color:"#fff", fontWeight:700, padding:"12px 28px", borderRadius:10, cursor:"pointer", fontSize:14 }}>
            🔄 Buscar Notas Fiscais
          </button>
        </div>
      )}

      {/* Tabela */}
      {pedidosFiltrados.length > 0 && (
        <div style={{ background:"#fff", border:"1px solid #e2e8f0", borderRadius:12, overflow:"auto" }}>
          <table style={{ borderCollapse:"collapse", width:"100%" }}>
            <thead>
              <tr>
                {["Pedido","Data","Cliente","Produto","Valor","Nº NF","Série","Data Emissão","Chave NF-e","Ações"].map(function(h) {
                  return <th key={h} style={{ fontSize:11, color:"#94a3b8", textTransform:"uppercase", letterSpacing:0.8, padding:"10px 14px", borderBottom:"1px solid #f1f5f9", textAlign:"left", fontWeight:600, background:"#fafafa", whiteSpace:"nowrap" }}>{h}</th>;
                })}
              </tr>
            </thead>
            <tbody>
              {pedidosFiltrados.slice(0, 200).map(function(o, i) {
                var nf = nfeSaida[String(o.id)];
                var temNF = nf && !nf.semNF && (nf.numero || nf.chave);
                return (
                  <tr key={o.id} style={{ background: i%2===0?"#f8fafc":"#fff" }}>
                    <td style={{ padding:"7px 10px", fontSize:11, color:"#64748b", fontFamily:"monospace", fontWeight:600 }}>#{o.id}</td>
                    <td style={{ padding:"7px 10px", fontSize:11, color:"#64748b", whiteSpace:"nowrap" }}>{fmtDate(o.date)}</td>
                    <td style={{ padding:"7px 10px", fontSize:11, color:"#334155", maxWidth:120, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                      {o.buyerName || "—"}
                      {o.buyerUF && <span style={{ marginLeft:4, fontSize:10, background:"#f1f5f9", padding:"1px 5px", borderRadius:4, color:"#64748b" }}>{o.buyerUF}</span>}
                    </td>
                    <td style={{ padding:"7px 10px", fontSize:11, color:"#0f172a", maxWidth:200, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{o.title||"—"}</td>
                    <td style={{ padding:"7px 10px", fontSize:12, fontWeight:700, color:"#0f172a", whiteSpace:"nowrap" }}>R$ {(o.price*o.qty).toFixed(2).replace(".",",")}</td>
                    <td style={{ padding:"10px 14px" }}>
                      {!nf ? (
                        <span style={{ fontSize:11, color:"#94a3b8" }}>—</span>
                      ) : temNF ? (
                        <span style={{ fontSize:13, fontWeight:700, color:"#0f172a" }}>{nf.numero}</span>
                      ) : (
                        <span style={{ fontSize:11, color:"#d97706", fontWeight:600 }}>⏳ Pendente</span>
                      )}
                    </td>
                    <td style={{ padding:"7px 10px", fontSize:11, color:"#64748b" }}>{nf?.serie || "—"}</td>
                    <td style={{ padding:"7px 10px", fontSize:11, color:"#64748b", whiteSpace:"nowrap" }}>{nf?.dataEmissao ? fmtDate(nf.dataEmissao.slice(0,10)) : "—"}</td>
                    <td style={{ padding:"10px 14px" }}>
                      {nf?.chave ? (
                        <div style={{ display:"flex", alignItems:"center", gap:4 }}>
                          <span style={{ fontSize:10, fontFamily:"monospace", color:"#334155", maxWidth:140, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", display:"block" }}>{nf.chave}</span>
                          <button onClick={function(){ navigator.clipboard.writeText(nf.chave); }}
                            style={{ background:"#f1f5f9", border:"none", color:"#64748b", padding:"2px 6px", borderRadius:4, cursor:"pointer", fontSize:10, flexShrink:0 }}>⎘</button>
                        </div>
                      ) : <span style={{ fontSize:11, color:"#94a3b8" }}>—</span>}
                    </td>
                    <td style={{ padding:"10px 14px" }}>
                      <div style={{ display:"flex", gap:4 }}>
                        {nf?.xmlUrl && (
                          <a href={nf.xmlUrl} target="_blank" rel="noreferrer"
                            style={{ background:"#eff6ff", border:"1px solid #bfdbfe", color:"#1d4ed8", padding:"4px 8px", borderRadius:6, fontSize:11, fontWeight:600, textDecoration:"none", whiteSpace:"nowrap" }}>
                            📄 XML
                          </a>
                        )}
                        {nf?.danfeUrl && (
                          <a href={nf.danfeUrl} target="_blank" rel="noreferrer"
                            style={{ background:"#f0fdf4", border:"1px solid #bbf7d0", color:"#15803d", padding:"4px 8px", borderRadius:6, fontSize:11, fontWeight:600, textDecoration:"none", whiteSpace:"nowrap" }}>
                            🖨️ DANFE
                          </a>
                        )}
                        {!temNF && !nf && (
                          <span style={{ fontSize:11, color:"#94a3b8" }}>Clique em Buscar</span>
                        )}
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
  const [showPicker, setShowPicker] = useState(false);
  const [mesPick, setMesPick] = useState(() => {
    var d = new Date(); return d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0");
  });

  function getAtivo() {
    if (!de && !ate) return "todos";
    for (var i = 0; i < PERIODOS.length - 1; i++) {
      var p = getPeriodo(PERIODOS[i].key);
      if (p.de === de && p.ate === ate) return PERIODOS[i].key;
    }
    // Verificar se é mês específico
    if (de && ate && de.slice(0,7) === ate.slice(0,7) && de.endsWith("-01")) return "mesSel";
    return null;
  }
  var ativo = getAtivo();

  function aplicarMes(mesKey) {
    var ultimo = new Date(parseInt(mesKey.slice(0,4)), parseInt(mesKey.slice(5,7)), 0).toLocaleDateString("sv-SE");
    onChangeDe(mesKey + "-01");
    onChangeAte(ultimo);
    setMesPick(mesKey);
    setShowPicker(false);
  }

  var nomeMes = ativo === "mesSel" && de
    ? new Date(de).toLocaleDateString("pt-BR",{month:"short",year:"numeric"}).replace(".","")
    : "Mês";

  return (
    <div style={{ display:"flex", gap:4, flexWrap:"wrap", alignItems:"center" }}>
      {PERIODOS.map(function(p) {
        var isAtivo = ativo === p.key;
        return (
          <button key={p.key}
            onClick={function() {
              var per = getPeriodo(p.key);
              onChangeDe(per.de);
              onChangeAte(per.ate);
              setShowPicker(false);
            }}
            style={{ padding:"3px 9px", borderRadius:20, border: isAtivo ? "2px solid #0f172a" : "1px solid #e2e8f0",
              background: isAtivo ? "#0f172a" : "#f8fafc",
              color: isAtivo ? "#fff" : "#64748b",
              fontWeight: isAtivo ? 700 : 500, fontSize:12, cursor:"pointer", fontFamily:"inherit", whiteSpace:"nowrap" }}>
            {p.label}
          </button>
        );
      })}

      {/* Seletor de mês específico */}
      <div style={{ position:"relative" }}>
        <button onClick={function(){ setShowPicker(function(v){return !v;}); }}
          style={{ padding:"3px 9px", borderRadius:20, fontSize:12, cursor:"pointer", fontFamily:"inherit", whiteSpace:"nowrap",
            border: ativo==="mesSel" ? "2px solid #0891b2" : "1px solid #e2e8f0",
            background: ativo==="mesSel" ? "#0891b2" : "#f8fafc",
            color: ativo==="mesSel" ? "#fff" : "#64748b",
            fontWeight: ativo==="mesSel" ? 700 : 500,
            display:"flex", alignItems:"center", gap:4 }}>
          📅 {nomeMes} <span style={{ fontSize:9, opacity:0.7 }}>▼</span>
        </button>
        {showPicker && (
          <div style={{ position:"absolute", top:34, left:0, background:"#fff", border:"1px solid #e2e8f0",
            borderRadius:12, boxShadow:"0 8px 24px rgba(0,0,0,.12)", zIndex:300, padding:10, minWidth:200 }}>
            <div style={{ fontSize:10, color:"#94a3b8", fontWeight:700, textTransform:"uppercase", marginBottom:6 }}>Selecionar mês</div>
            <div style={{ maxHeight:220, overflowY:"auto" }}>
              {(function() {
                var meses = [];
                var agora = new Date();
                for (var i = 0; i < 24; i++) {
                  var d = new Date(agora.getFullYear(), agora.getMonth() - i, 1);
                  var k = d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0");
                  var nome = d.toLocaleDateString("pt-BR",{month:"long",year:"numeric"});
                  meses.push({ k, nome });
                }
                return meses.map(function(m) {
                  var sel = mesPick === m.k && ativo === "mesSel";
                  return (
                    <button key={m.k} onClick={function(){ aplicarMes(m.k); }}
                      style={{ width:"100%", textAlign:"left", background:sel?"#0891b2":"transparent",
                        border:"none", color:sel?"#fff":"#334155", padding:"6px 10px",
                        borderRadius:6, cursor:"pointer", fontSize:12, fontWeight:sel?700:400 }}
                      onMouseEnter={function(e){ if(!sel) e.currentTarget.style.background="#f8fafc"; }}
                      onMouseLeave={function(e){ if(!sel) e.currentTarget.style.background="transparent"; }}>
                      {m.nome.charAt(0).toUpperCase() + m.nome.slice(1)}
                    </button>
                  );
                });
              })()}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}


// ════════════════════════════════════════════════════════════
//  ENVIOS FULL — Montagem de caixas para Mercado Envios Full
// ════════════════════════════════════════════════════════════
function saveEnviosFull(v) { try { localStorage.setItem("envios_full", JSON.stringify(v)); } catch {} }

function EnviosFULLTab({ produtos, listings, estoqueDepositos, depositos }) {
  const [envios, setEnvios] = useState(function(){
    try { return JSON.parse(localStorage.getItem("envios_full")||"[]"); } catch { return []; }
  });
  const [showNovoEnvio, setShowNovoEnvio] = useState(false);
  const [editingEnvio, setEditingEnvio] = useState(null);
  const [search, setSearch] = useState("");
  const [filterStatus, setFilterStatus] = useState("todos");

  function salvarEnvio(envio) {
    var lista = envios.find(function(e){return e.id===envio.id;})
      ? envios.map(function(e){return e.id===envio.id?envio:e;})
      : [envio, ...envios];
    setEnvios(lista); saveEnviosFull(lista);
  }

  function excluirEnvio(id) {
    if (!window.confirm("Excluir este envio?")) return;
    var lista = envios.filter(function(e){return e.id!==id;});
    setEnvios(lista); saveEnviosFull(lista);
  }

  function mudarStatus(id, novoStatus) {
    var lista = envios.map(function(e){
      return e.id===id ? Object.assign({},e,{status:novoStatus, dataStatus:new Date().toLocaleDateString("sv-SE")}) : e;
    });
    setEnvios(lista); saveEnviosFull(lista);
  }

  var enviosFiltrados = envios.filter(function(e){
    if (filterStatus !== "todos" && e.status !== filterStatus) return false;
    if (search) {
      var q = search.toLowerCase();
      return (e.nome||"").toLowerCase().includes(q) || (e.itens||[]).some(function(it){
        return (it.titulo||"").toLowerCase().includes(q) || (it.sku||"").toLowerCase().includes(q);
      });
    }
    return true;
  });

  var STATUS_CFG = {
    "Montando":   { cor:"#d97706", bg:"#fffbeb", icone:"📦" },
    "Pronto":     { cor:"#0891b2", bg:"#ecfeff", icone:"✅" },
    "Enviado":    { cor:"#7c3aed", bg:"#f5f3ff", icone:"🚛" },
    "Recebido":   { cor:"#15803d", bg:"#f0fdf4", icone:"🏭" },
    "Cancelado":  { cor:"#dc2626", bg:"#fef2f2", icone:"✕" },
  };

  var totalItens = envios.reduce(function(s,e){ return s+(e.itens||[]).reduce(function(ss,it){return ss+parseInt(it.qtd||0);},0); },0);
  var totalEnviados = envios.filter(function(e){return e.status==="Enviado"||e.status==="Recebido";}).length;

  return (
    <div style={{ maxWidth:1440, margin:"0 auto", padding:"24px 32px" }}>
      {/* Header */}
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:10 }}>
        <div>
          <div style={{ fontWeight:800, fontSize:22, color:"#0f172a", marginBottom:4 }}>⚡ Envios FULL</div>
          <div style={{ fontSize:13, color:"#94a3b8" }}>Monte caixas para envio ao centro de distribuição do Mercado Livre Full</div>
        </div>
        <button onClick={function(){ setEditingEnvio(null); setShowNovoEnvio(true); }}
          style={{ background:"#ffe000", border:"none", color:"#0f172a", fontWeight:800, padding:"11px 24px", borderRadius:10, cursor:"pointer", fontSize:14, display:"flex", alignItems:"center", gap:8 }}>
          + Novo Envio FULL
        </button>
      </div>

      {/* Cards resumo */}
      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(150px,1fr))", gap:12, marginBottom:10 }}>
        {[
          { label:"Total de Envios",  value: envios.length,        cor:"#0f172a" },
          { label:"Montando",         value: envios.filter(function(e){return e.status==="Montando";}).length,  cor:"#d97706" },
          { label:"Prontos p/ envio", value: envios.filter(function(e){return e.status==="Pronto";}).length,   cor:"#0891b2" },
          { label:"Enviados/Receb.",  value: totalEnviados,         cor:"#15803d" },
          { label:"Total de Itens",   value: totalItens + " un",    cor:"#7c3aed" },
        ].map(function(k){
          return (
            <div key={k.label} style={{ background:"#fff", border:"1px solid #e2e8f0", borderRadius:12, padding:"10px 14px" }}>
              <div style={{ fontSize:9, color:"#94a3b8", fontWeight:600, textTransform:"uppercase", marginBottom:3 }}>{k.label}</div>
              <div style={{ fontSize:15, fontWeight:800, color:k.cor }}>{k.value}</div>
            </div>
          );
        })}
      </div>

      {/* Filtros */}
      <div style={{ display:"flex", gap:7, alignItems:"center", marginBottom:8, flexWrap:"wrap" }}>
        <div style={{ position:"relative", flex:1, minWidth:220 }}>
          <span style={{ position:"absolute", left:10, top:"50%", transform:"translateY(-50%)", color:"#94a3b8" }}>🔍</span>
          <input value={search} onChange={function(e){setSearch(e.target.value);}} placeholder="Buscar por nome do envio ou produto..."
            style={{ width:"100%", background:"#fff", border:"1px solid #e2e8f0", color:"#0f172a", padding:"8px 12px 8px 32px", borderRadius:8, fontSize:13, outline:"none" }} />
        </div>
        <div style={{ display:"flex", gap:4 }}>
          {["todos","Montando","Pronto","Enviado","Recebido","Cancelado"].map(function(s){
            var active = filterStatus===s;
            var cfg = STATUS_CFG[s];
            return (
              <button key={s} onClick={function(){setFilterStatus(s);}}
                style={{ padding:"4px 10px", borderRadius:20, border:"none", cursor:"pointer", fontSize:12, fontWeight:active?700:500,
                  background:active?(cfg?cfg.bg:"#0f172a"):("#f8fafc"),
                  color:active?(cfg?cfg.cor:"#fff"):"#64748b" }}>
                {cfg?cfg.icone+" ":""}{s==="todos"?"Todos":s}
              </button>
            );
          })}
        </div>
      </div>

      {/* Lista de envios */}
      {enviosFiltrados.length === 0 ? (
        <div style={{ background:"#f8fafc", border:"2px dashed #e2e8f0", borderRadius:16, padding:60, textAlign:"center", color:"#94a3b8" }}>
          <div style={{ fontSize:48, marginBottom:12 }}>⚡</div>
          <div style={{ fontWeight:700, fontSize:16, color:"#0f172a", marginBottom:6 }}>Nenhum envio FULL cadastrado</div>
          <div style={{ fontSize:13, marginBottom:10 }}>Crie um envio para organizar os produtos que serão enviados ao galpão ML</div>
          <button onClick={function(){ setEditingEnvio(null); setShowNovoEnvio(true); }}
            style={{ background:"#ffe000", border:"none", color:"#0f172a", fontWeight:800, padding:"11px 28px", borderRadius:10, cursor:"pointer", fontSize:14 }}>
            + Criar Primeiro Envio
          </button>
        </div>
      ) : (
        <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
          {enviosFiltrados.map(function(envio) {
            var cfg = STATUS_CFG[envio.status] || STATUS_CFG["Montando"];
            var totalQtd = (envio.itens||[]).reduce(function(s,it){return s+parseInt(it.qtd||0);},0);
            var totalPeso = (envio.itens||[]).reduce(function(s,it){return s+parseFloat(it.peso||0)*parseInt(it.qtd||0);},0);
            return (
              <div key={envio.id} style={{ background:"#fff", border:"2px solid "+cfg.cor+"33", borderRadius:14, overflow:"hidden" }}>
                {/* Header do envio */}
                <div style={{ background:cfg.bg, borderBottom:"1px solid "+cfg.cor+"22", padding:"14px 20px", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                  <div style={{ display:"flex", alignItems:"center", gap:12 }}>
                    <div style={{ fontSize:22 }}>{cfg.icone}</div>
                    <div>
                      <div style={{ fontWeight:700, fontSize:16, color:"#0f172a" }}>{envio.nome}</div>
                      <div style={{ display:"flex", gap:7, marginTop:2, flexWrap:"wrap" }}>
                        <span style={{ fontSize:11, fontWeight:700, color:cfg.cor, background:"#fff", padding:"2px 8px", borderRadius:20, border:"1px solid "+cfg.cor+"44" }}>{envio.status}</span>
                        <span style={{ fontSize:11, color:"#64748b" }}>{(envio.itens||[]).length} produto(s) · {totalQtd} unidades</span>
                        {totalPeso > 0 && <span style={{ fontSize:11, color:"#64748b" }}>~{totalPeso.toFixed(1)} kg</span>}
                        {envio.dataCriacao && <span style={{ fontSize:11, color:"#94a3b8" }}>Criado em {fmtDate(envio.dataCriacao)}</span>}
                        {envio.dataStatus && <span style={{ fontSize:11, color:"#94a3b8" }}>Atualizado {fmtDate(envio.dataStatus)}</span>}
                      </div>
                    </div>
                  </div>
                  <div style={{ display:"flex", gap:8, alignItems:"center" }}>
                    {/* Botões de mudança de status */}
                    {envio.status === "Montando" && (
                      <button onClick={function(){mudarStatus(envio.id,"Pronto");}}
                        style={{ background:"#0891b2", border:"none", color:"#fff", fontWeight:700, padding:"7px 16px", borderRadius:8, cursor:"pointer", fontSize:12 }}>
                        ✅ Marcar como Pronto
                      </button>
                    )}
                    {envio.status === "Pronto" && (
                      <button onClick={function(){mudarStatus(envio.id,"Enviado");}}
                        style={{ background:"#7c3aed", border:"none", color:"#fff", fontWeight:700, padding:"7px 16px", borderRadius:8, cursor:"pointer", fontSize:12 }}>
                        🚛 Marcar como Enviado
                      </button>
                    )}
                    {envio.status === "Enviado" && (
                      <button onClick={function(){mudarStatus(envio.id,"Recebido");}}
                        style={{ background:"#15803d", border:"none", color:"#fff", fontWeight:700, padding:"7px 16px", borderRadius:8, cursor:"pointer", fontSize:12 }}>
                        🏭 Confirmar Recebimento
                      </button>
                    )}
                    <button onClick={function(){ setEditingEnvio(envio); setShowNovoEnvio(true); }}
                      style={{ background:"#f1f5f9", border:"1px solid #e2e8f0", color:"#64748b", padding:"7px 12px", borderRadius:8, cursor:"pointer", fontSize:12 }}>✏️</button>
                    <button onClick={function(){excluirEnvio(envio.id);}}
                      style={{ background:"#fef2f2", border:"1px solid #fecaca", color:"#dc2626", padding:"7px 12px", borderRadius:8, cursor:"pointer", fontSize:12 }}>🗑</button>
                  </div>
                </div>
                {/* Tabela de itens */}
                {(envio.itens||[]).length > 0 && (
                  <div style={{ padding:"14px 20px" }}>
                    <table style={{ borderCollapse:"collapse", width:"100%" }}>
                      <thead>
                        <tr>
                          {["Produto","SKU","MLB","Qtd. a Enviar","Estoque Atual","Peso unit.","Total KG","Obs"].map(function(h){
                            return <th key={h} style={{ fontSize:11, color:"#94a3b8", textTransform:"uppercase", padding:"5px 8px", borderBottom:"1px solid #f1f5f9", textAlign:"left", fontWeight:600, whiteSpace:"nowrap" }}>{h}</th>;
                          })}
                        </tr>
                      </thead>
                      <tbody>
                        {(envio.itens||[]).map(function(it, i){
                          var prod = produtos.find(function(p){return p.id===it.produtoId;});
                          var estAtual = parseInt(prod?.estoqueAtual||0);
                          var ok = parseInt(it.qtd||0) <= estAtual;
                          return (
                            <tr key={i} style={{ background:i%2===0?"#f8fafc":"#fff" }}>
                              <td style={{ padding:"5px 8px", fontSize:13, color:"#0f172a", maxWidth:220, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{it.titulo||"—"}</td>
                              <td style={{ padding:"5px 8px", fontSize:11, color:"#64748b", fontFamily:"monospace" }}>{it.sku||"—"}</td>
                              <td style={{ padding:"5px 8px", fontSize:11, color:"#0891b2", fontFamily:"monospace" }}>{it.mlb||"—"}</td>
                              <td style={{ padding:"5px 8px", textAlign:"center" }}>
                                <span style={{ fontSize:14, fontWeight:800, color:ok?"#15803d":"#dc2626" }}>{it.qtd}</span>
                                {!ok && <div style={{ fontSize:10, color:"#dc2626" }}>⚠ insuf.</div>}
                              </td>
                              <td style={{ padding:"5px 8px", textAlign:"center", fontSize:13, color:estAtual>0?"#0f172a":"#94a3b8" }}>{estAtual} un</td>
                              <td style={{ padding:"5px 8px", textAlign:"center", fontSize:12, color:"#64748b" }}>{it.peso?it.peso+"kg":"—"}</td>
                              <td style={{ padding:"5px 8px", textAlign:"center", fontSize:12, color:"#64748b" }}>{it.peso&&it.qtd?(parseFloat(it.peso)*parseInt(it.qtd)).toFixed(2)+"kg":"—"}</td>
                              <td style={{ padding:"5px 8px", fontSize:12, color:"#94a3b8" }}>{it.obs||"—"}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                      <tfoot>
                        <tr style={{ background:"#f1f5f9" }}>
                          <td colSpan={3} style={{ padding:"5px 8px", fontWeight:700, fontSize:13, color:"#0f172a" }}>TOTAL</td>
                          <td style={{ padding:"5px 8px", textAlign:"center", fontWeight:800, fontSize:14, color:"#0f172a" }}>{totalQtd} un</td>
                          <td colSpan={2} />
                          <td style={{ padding:"5px 8px", textAlign:"center", fontWeight:700, fontSize:13, color:"#0f172a" }}>{totalPeso.toFixed(2)} kg</td>
                          <td />
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                )}
                {/* Obs do envio */}
                {envio.obs && (
                  <div style={{ padding:"0 20px 14px", fontSize:12, color:"#64748b", fontStyle:"italic" }}>💬 {envio.obs}</div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Modal de novo/editar envio */}
      {showNovoEnvio && (
        <ModalNovoEnvioFull
          envio={editingEnvio}
          produtos={produtos}
          listings={listings}
          onSave={function(env){ salvarEnvio(env); setShowNovoEnvio(false); setEditingEnvio(null); }}
          onClose={function(){ setShowNovoEnvio(false); setEditingEnvio(null); }}
        />
      )}
    </div>
  );
}

function ModalNovoEnvioFull({ envio, produtos, listings, onSave, onClose }) {
  var empty = {
    id: Date.now().toString(), nome: "", status: "Montando",
    dataCriacao: new Date().toLocaleDateString("sv-SE"), itens: [], obs: "",
  };
  const [form, setForm] = useState(envio || empty);
  const [busca, setBusca] = useState("");
  const [resultados, setResultados] = useState([]);
  var set = function(k,v){ setForm(function(f){return Object.assign({},f,{[k]:v});}); };

  function buscarProdutos(q) {
    setBusca(q);
    if (!q || q.length < 2) { setResultados([]); return; }
    var ql = q.toLowerCase();
    var found = produtos.filter(function(p){
      return (p.titulo||"").toLowerCase().includes(ql) ||
             (p.sku||"").toLowerCase().includes(ql) ||
             (p.mlbVinculado||"").toLowerCase().includes(ql);
    }).slice(0,8);
    setResultados(found);
  }

  function adicionarItem(prod) {
    var jaExiste = form.itens.find(function(it){return it.produtoId===prod.id;});
    if (jaExiste) { setResultados([]); setBusca(""); return; }
    var mlb = prod.mlbVinculado || (prod.mlbsVinculados||[])[0] || "";
    var listing = listings.find(function(l){return l.id===mlb;});
    var novoItem = {
      produtoId: prod.id,
      titulo: prod.titulo,
      sku: prod.sku||"",
      mlb: mlb,
      qtd: "1",
      peso: prod.peso||"",
      obs: "",
    };
    set("itens", [...form.itens, novoItem]);
    setResultados([]); setBusca("");
  }

  function updateItem(idx, field, val) {
    var updated = form.itens.map(function(it,i){return i===idx?Object.assign({},it,{[field]:val}):it;});
    set("itens", updated);
  }

  function removeItem(idx) {
    set("itens", form.itens.filter(function(_,i){return i!==idx;}));
  }

  var totalQtd = form.itens.reduce(function(s,it){return s+parseInt(it.qtd||0);},0);
  var totalPeso = form.itens.reduce(function(s,it){return s+parseFloat(it.peso||0)*parseInt(it.qtd||0);},0);

  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(15,23,42,.65)", backdropFilter:"blur(4px)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:600, padding:24 }}>
      <div style={{ background:"#fff", borderRadius:16, width:"100%", maxWidth:820, maxHeight:"94vh", display:"flex", flexDirection:"column", boxShadow:"0 24px 64px rgba(0,0,0,.2)" }}>
        {/* Header */}
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"12px 16px", borderBottom:"1px solid #f1f5f9" }}>
          <div>
            <div style={{ fontWeight:800, fontSize:18, color:"#0f172a" }}>{envio?"Editar Envio FULL":"Novo Envio FULL"}</div>
            <div style={{ fontSize:12, color:"#94a3b8", marginTop:2 }}>Monte a caixa com os produtos para envio ao centro de distribuição ML</div>
          </div>
          <button onClick={onClose} style={{ background:"#f1f5f9", border:"none", color:"#64748b", width:32, height:32, borderRadius:8, cursor:"pointer", fontSize:16 }}>✕</button>
        </div>

        <div style={{ flex:1, overflowY:"auto", padding:"12px 16px" }}>
          {/* Dados do envio */}
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12, marginBottom:10 }}>
            <div>
              <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Nome do Envio *</div>
              <input value={form.nome} onChange={function(e){set("nome",e.target.value);}} placeholder="Ex: Caixa #01 - Junho 2026"
                style={{ width:"100%", background:"#f8fafc", border:"1px solid #e2e8f0", color:"#0f172a", padding:"9px 12px", borderRadius:8, fontSize:13, outline:"none" }} />
            </div>
            <div>
              <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Status</div>
              <select value={form.status} onChange={function(e){set("status",e.target.value);}}
                style={{ width:"100%", background:"#f8fafc", border:"1px solid #e2e8f0", color:"#0f172a", padding:"9px 12px", borderRadius:8, fontSize:13 }}>
                {["Montando","Pronto","Enviado","Recebido","Cancelado"].map(function(s){return <option key={s}>{s}</option>;})}
              </select>
            </div>
            <div style={{ gridColumn:"1/-1" }}>
              <div style={{ fontSize:11, color:"#94a3b8", marginBottom:5, fontWeight:600, textTransform:"uppercase" }}>Observações</div>
              <input value={form.obs} onChange={function(e){set("obs",e.target.value);}} placeholder="Número da solicitação ML, observações..."
                style={{ width:"100%", background:"#f8fafc", border:"1px solid #e2e8f0", color:"#0f172a", padding:"9px 12px", borderRadius:8, fontSize:13, outline:"none" }} />
            </div>
          </div>

          {/* Busca de produtos */}
          <div style={{ marginBottom:8 }}>
            <div style={{ fontSize:13, fontWeight:700, color:"#0f172a", marginBottom:8 }}>Adicionar Produtos</div>
            <div style={{ position:"relative" }}>
              <span style={{ position:"absolute", left:10, top:"50%", transform:"translateY(-50%)", color:"#94a3b8" }}>🔍</span>
              <input value={busca} onChange={function(e){buscarProdutos(e.target.value);}}
                placeholder="Buscar produto por nome, SKU ou MLB..."
                style={{ width:"100%", background:"#f8fafc", border:"1px solid #e2e8f0", color:"#0f172a", padding:"9px 12px 9px 32px", borderRadius:8, fontSize:13, outline:"none" }} />
              {resultados.length > 0 && (
                <div style={{ position:"absolute", top:"100%", left:0, right:0, background:"#fff", border:"1px solid #e2e8f0", borderRadius:10, boxShadow:"0 8px 24px rgba(0,0,0,.12)", zIndex:50, overflow:"hidden" }}>
                  {resultados.map(function(p){
                    var jaAdicionado = form.itens.some(function(it){return it.produtoId===p.id;});
                    return (
                      <div key={p.id} onClick={function(){if(!jaAdicionado)adicionarItem(p);}}
                        style={{ padding:"10px 14px", cursor:jaAdicionado?"default":"pointer", borderBottom:"1px solid #f1f5f9", display:"flex", justifyContent:"space-between", alignItems:"center",
                          background:jaAdicionado?"#f8fafc":"#fff", opacity:jaAdicionado?0.5:1 }}
                        onMouseEnter={function(e){if(!jaAdicionado)e.currentTarget.style.background="#f0fdf4";}}
                        onMouseLeave={function(e){if(!jaAdicionado)e.currentTarget.style.background="#fff";}}>
                        <div>
                          <div style={{ fontSize:13, fontWeight:600, color:"#0f172a" }}>{p.titulo?.slice(0,60)}</div>
                          <div style={{ fontSize:11, color:"#94a3b8" }}>
                            {p.sku&&<span>SKU: {p.sku}</span>}
                            {p.mlbVinculado&&<span style={{ marginLeft:8 }}>MLB: {p.mlbVinculado}</span>}
                            <span style={{ marginLeft:8 }}>Estoque: {p.estoqueAtual||0} un</span>
                          </div>
                        </div>
                        {jaAdicionado
                          ? <span style={{ fontSize:11, color:"#94a3b8" }}>Já adicionado</span>
                          : <span style={{ fontSize:12, color:"#15803d", fontWeight:700 }}>+ Adicionar</span>
                        }
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Tabela de itens */}
          {form.itens.length === 0 ? (
            <div style={{ background:"#f8fafc", border:"2px dashed #e2e8f0", borderRadius:12, padding:32, textAlign:"center", color:"#94a3b8" }}>
              <div style={{ fontSize:32, marginBottom:8 }}>📦</div>
              <div style={{ fontSize:13 }}>Busque e adicione produtos para montar a caixa de envio</div>
            </div>
          ) : (
            <div>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8 }}>
                <div style={{ fontSize:13, fontWeight:700, color:"#0f172a" }}>Itens da Caixa ({form.itens.length} produto(s) · {totalQtd} unidades · {totalPeso.toFixed(2)} kg)</div>
              </div>
              <div style={{ background:"#fff", border:"1px solid #e2e8f0", borderRadius:12, overflow:"hidden" }}>
                <table style={{ borderCollapse:"collapse", width:"100%" }}>
                  <thead>
                    <tr>
                      {["Produto","SKU","MLB","Qtd","Peso (kg)","Total kg","Obs",""].map(function(h){
                        return <th key={h} style={{ fontSize:11, color:"#94a3b8", textTransform:"uppercase", padding:"9px 12px", borderBottom:"1px solid #f1f5f9", textAlign:"left", fontWeight:600, background:"#fafafa", whiteSpace:"nowrap" }}>{h}</th>;
                      })}
                    </tr>
                  </thead>
                  <tbody>
                    {form.itens.map(function(it,i){
                      var prod = produtos.find(function(p){return p.id===it.produtoId;});
                      var estAtual = parseInt(prod?.estoqueAtual||0);
                      var semEstoque = parseInt(it.qtd||0) > estAtual;
                      return (
                        <tr key={i} style={{ background:i%2===0?"#f8fafc":"#fff" }}>
                          <td style={{ padding:"5px 8px", fontSize:12, color:"#0f172a", maxWidth:180, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }} title={it.titulo}>{it.titulo}</td>
                          <td style={{ padding:"5px 8px", fontSize:11, color:"#64748b", fontFamily:"monospace" }}>{it.sku||"—"}</td>
                          <td style={{ padding:"5px 8px", fontSize:11, color:"#0891b2", fontFamily:"monospace" }}>{it.mlb||"—"}</td>
                          <td style={{ padding:"5px 8px" }}>
                            <div style={{ display:"flex", alignItems:"center", gap:4 }}>
                              <input type="number" min="1" value={it.qtd} onChange={function(e){updateItem(i,"qtd",e.target.value);}}
                                style={{ width:60, textAlign:"center", background:semEstoque?"#fef2f2":"#f0fdf4", border:"1px solid "+(semEstoque?"#fecaca":"#bbf7d0"), color:semEstoque?"#dc2626":"#15803d", padding:"5px 6px", borderRadius:6, fontSize:13, fontWeight:700, outline:"none" }} />
                              <span style={{ fontSize:10, color:"#94a3b8" }}>/{estAtual}</span>
                            </div>
                          </td>
                          <td style={{ padding:"5px 8px" }}>
                            <input type="number" step="0.001" value={it.peso} onChange={function(e){updateItem(i,"peso",e.target.value);}} placeholder="0.000"
                              style={{ width:70, background:"#f8fafc", border:"1px solid #e2e8f0", color:"#0f172a", padding:"5px 6px", borderRadius:6, fontSize:12, outline:"none" }} />
                          </td>
                          <td style={{ padding:"5px 8px", fontSize:12, color:"#64748b", textAlign:"center" }}>
                            {it.peso&&it.qtd?(parseFloat(it.peso)*parseInt(it.qtd)).toFixed(3):"—"}
                          </td>
                          <td style={{ padding:"5px 8px" }}>
                            <input value={it.obs||""} onChange={function(e){updateItem(i,"obs",e.target.value);}} placeholder="Obs..."
                              style={{ width:100, background:"#f8fafc", border:"1px solid #e2e8f0", color:"#0f172a", padding:"5px 6px", borderRadius:6, fontSize:12, outline:"none" }} />
                          </td>
                          <td style={{ padding:"5px 8px", textAlign:"center" }}>
                            <button onClick={function(){removeItem(i);}}
                              style={{ background:"#fef2f2", border:"none", color:"#dc2626", width:26, height:26, borderRadius:6, cursor:"pointer", fontSize:12 }}>✕</button>
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

        {/* Footer */}
        <div style={{ display:"flex", gap:8, padding:"16px 28px", borderTop:"1px solid #f1f5f9", background:"#fafafa" }}>
          <button onClick={onClose} style={{ flex:1, background:"#f8fafc", border:"1px solid #e2e8f0", color:"#64748b", fontWeight:600, padding:"11px", borderRadius:10, cursor:"pointer" }}>Cancelar</button>
          <button onClick={function(){ if(!form.nome) return; onSave(form); }} disabled={!form.nome}
            style={{ flex:3, background:form.nome?"#ffe000":"#f1f5f9", border:"none", color:form.nome?"#0f172a":"#94a3b8", fontWeight:800, padding:"11px", borderRadius:10, cursor:form.nome?"pointer":"not-allowed", fontSize:14 }}>
            ⚡ {envio?"Salvar Envio":"Criar Envio FULL"}
          </button>
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
        <div style={{ width:168, flexShrink:0, background:"#fafafa", borderRight:"1px solid #f0f0f0", padding:"8px 8px", display:"flex", flexDirection:"column", gap:10 }}>
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
          border:"1px solid "+(activeLabel?"#cbd5e1":"#e9ecef"),
          background: activeLabel ? "#f1f5f9" : "#fff",
          color: activeLabel ? "#0f172a" : "#94a3b8",
          fontWeight: activeLabel ? 600 : 400, fontSize:11, cursor:"pointer", textAlign:"left",
          transition:"border-color .15s" }}>
        <span style={{ overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", flex:1 }}>
          {activeLabel || "Todos"}
        </span>
        <span style={{ fontSize:8, color:"#c4c9d0", marginLeft:4, flexShrink:0 }}>{open?"▲":"▼"}</span>
      </button>
      {open && (
        <div style={{ position:"absolute", top:"100%", left:0, right:0, marginTop:2,
          background:"#fff", border:"1px solid #e9ecef", borderRadius:7,
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
        padding:"6px 10px", border:"none", borderBottom:"1px solid #f5f5f5",
        background: active ? (bg||"#f1f5f9") : "#fff",
        color: active ? (cor||"#0f172a") : "#64748b",
        fontWeight: active ? 600 : 400, fontSize:11, cursor:"pointer",
        textAlign:"left", width:"100%", transition:"background .1s" }}>
      <span style={{ overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{label}</span>
      {count !== undefined && (
        <span style={{ fontSize:9, fontWeight:600, flexShrink:0, marginLeft:4,
          color: active?(cor||"#0f172a"):"#94a3b8",
          background: active?"transparent":"#f1f5f9",
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
    "FULL": { bg:"#dbeafe", color:"#1d4ed8", label:"FULL" },
    "Flex": { bg:"#ede9fe", color:"#7c3aed", label:"Flex" },
    "ME2":  { bg:"#cffafe", color:"#0e7490", label:"ME2" },
    "ME1":  { bg:"#dcfce7", color:"#166534", label:"ME1" },
  }[tipo];
  if (!cfg) return null;
  return (
    <span style={{ fontSize:10, fontWeight:700, padding:"2px 7px", borderRadius:5,
      background:cfg.bg, color:cfg.color, whiteSpace:"nowrap" }}>{cfg.label}</span>
  );
}


// ════════════════════════════════════════════════════════════
//  ABA ASSISTENTE IA — Chat com contexto do negócio
// ════════════════════════════════════════════════════════════
function IAChatTab({ enriched, rawOrders, produtos, contasPagar, token }) {
  const [msgs, setMsgs] = useState([{
    role: "assistant",
    content: "Olá! Sou seu assistente de negócios com acesso aos dados do seu ML Margem. Posso ajudar com análise de vendas, precificação, estoque, contas a pagar, e muito mais. O que você precisa?"
  }]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef(null);

  useEffect(function() {
    if (bottomRef.current) bottomRef.current.scrollIntoView({ behavior: "smooth" });
  }, [msgs]);

  function buildContext() {
    var totalVendas = (rawOrders||[]).filter(function(o){return o.status==="paid";}).length;
    var faturamento = (rawOrders||[]).filter(function(o){return o.status==="paid";}).reduce(function(s,o){return s+o.price*(o.qty||1);},0);
    var contasPend = (contasPagar||[]).filter(function(c){return c.status!=="Pago";}).reduce(function(s,c){return s+parseFloat(c.valor||0);},0);
    var topProd = {};
    (rawOrders||[]).filter(function(o){return o.status==="paid";}).forEach(function(o){
      if(!topProd[o.listing_id]) topProd[o.listing_id]={titulo:o.title,qtd:0,receita:0};
      topProd[o.listing_id].qtd+=(o.qty||1);
      topProd[o.listing_id].receita+=o.price*(o.qty||1);
    });
    var top5 = Object.values(topProd).sort(function(a,b){return b.receita-a.receita;}).slice(0,5);
    var estoqueCritico = (produtos||[]).filter(function(p){return parseInt(p.estoqueAtual||0)<=(parseInt(p.estoqueMinimo||0));}).length;
    return [
      "=== CONTEXTO DO NEGÓCIO (dados em tempo real) ===",
      "Total de pedidos pagos: " + totalVendas,
      "Faturamento total: R$ " + faturamento.toFixed(2),
      "Contas a pagar pendentes: R$ " + contasPend.toFixed(2),
      "Produtos cadastrados: " + (produtos||[]).length,
      "Produtos com estoque crítico: " + estoqueCritico,
      "Top 5 produtos por receita:",
      top5.map(function(p,i){return "  "+(i+1)+". "+p.titulo+" — "+p.qtd+" vendas — R$ "+p.receita.toFixed(2);}).join("\n"),
      "=== FIM DO CONTEXTO ===",
      "Responda em português brasileiro. Seja direto, objetivo e use os dados acima quando relevante.",
    ].join("\n");
  }

  async function enviar() {
    if (!input.trim() || loading) return;
    var userMsg = { role: "user", content: input.trim() };
    var newMsgs = [...msgs, userMsg];
    setMsgs(newMsgs);
    setInput("");
    setLoading(true);
    try {
      var systemPrompt = buildContext();
      var apiMsgs = newMsgs.map(function(m){ return { role: m.role, content: m.content }; });
      // Tenta /api/ai-chat (endpoint serverless Vercel que precisa ser criado)
      // Se não existir (405/404), cai no fallback de instrução
      var res = await fetch("/api/ai-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ system: systemPrompt, messages: apiMsgs })
      });

      // Se o endpoint não existir, dá instrução clara
      if (res.status === 404 || res.status === 405) {
        throw new Error("__ENDPOINT_NAO_EXISTE__");
      }

      if (!res.ok) {
        var errTxt = await res.text();
        throw new Error("Servidor respondeu "+res.status+": "+errTxt.slice(0,200));
      }
      var data = await res.json();
      var reply = (data.content||[]).find(function(b){return b.type==="text";})?.text || data.reply || data.text || "Sem resposta.";
      setMsgs(function(m){ return [...m, { role: "assistant", content: reply }]; });
    } catch(e) {
            var msgErro;
      if (e.message === "__ENDPOINT_NAO_EXISTE__") {
        msgErro = "Para ativar o Assistente IA, crie o arquivo api/ai-chat.js no Vercel e adicione a variavel ANTHROPIC_API_KEY em Settings > Environment Variables. Fale com o desenvolvedor para fazer essa configuracao.";
      } else {
        msgErro = "Erro ao conectar com a IA: " + e.message;
      }
      setMsgs(function(m){ return [...m, { role: "assistant", content: msgErro }]; });
    }
    setLoading(false);
  }

  function handleKey(e) { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); enviar(); } }

  var SUGESTOES = [
    "Como está minha margem média este mês?",
    "Quais produtos preciso repor no estoque?",
    "Quais são minhas contas a pagar mais urgentes?",
    "Qual produto está gerando mais receita?",
    "Me dê dicas para melhorar minha lucratividade",
  ];

  return (
    <div style={{ display:"flex", flexDirection:"column", height:"calc(100vh - 130px)", maxWidth:900, margin:"0 auto", padding:"0 20px" }}>
      {/* Header */}
      <div style={{ padding:"12px 0 8px", borderBottom:"1px solid #e2e8f0", marginBottom:8 }}>
        <div style={{ fontWeight:800, fontSize:20, color:"#0f172a", marginBottom:4 }}>✦ Assistente IA</div>
        <div style={{ fontSize:13, color:"#64748b" }}>Converse com sua IA de negócios — com acesso aos dados reais do seu ML Margem</div>
      </div>

      {/* Mensagens */}
      <div style={{ flex:1, overflowY:"auto", display:"flex", flexDirection:"column", gap:12, paddingBottom:8 }}>
        {msgs.map(function(m, i) {
          var isUser = m.role === "user";
          return (
            <div key={i} style={{ display:"flex", justifyContent:isUser?"flex-end":"flex-start" }}>
              {!isUser && (
                <div style={{ width:32, height:32, borderRadius:10, background:"#0f172a", color:"#ffe000", display:"flex", alignItems:"center", justifyContent:"center", fontSize:16, flexShrink:0, marginRight:10, marginTop:2 }}>✦</div>
              )}
              <div style={{ maxWidth:"75%", padding:"12px 16px", borderRadius:isUser?"14px 14px 4px 14px":"14px 14px 14px 4px",
                background:isUser?"#0f172a":"#f8fafc",
                color:isUser?"#fff":"#0f172a",
                fontSize:13, lineHeight:1.6, border:isUser?"none":"1px solid #e2e8f0",
                whiteSpace:"pre-wrap" }}>
                {m.content}
              </div>
            </div>
          );
        })}
        {loading && (
          <div style={{ display:"flex", alignItems:"center", gap:10 }}>
            <div style={{ width:32, height:32, borderRadius:10, background:"#0f172a", color:"#ffe000", display:"flex", alignItems:"center", justifyContent:"center", fontSize:16 }}>✦</div>
            <div style={{ background:"#f8fafc", border:"1px solid #e2e8f0", borderRadius:"14px 14px 14px 4px", padding:"12px 16px" }}>
              <div style={{ display:"flex", gap:4 }}>
                {[0,1,2].map(function(j){ return <div key={j} style={{ width:6, height:6, borderRadius:"50%", background:"#94a3b8", animation:"pulse 1.2s ease-in-out "+j*0.2+"s infinite" }} />; })}
              </div>
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Sugestões rápidas */}
      {msgs.length <= 1 && (
        <div style={{ display:"flex", gap:6, flexWrap:"wrap", marginBottom:12 }}>
          {SUGESTOES.map(function(s){
            return (
              <button key={s} onClick={function(){ setInput(s); }}
                style={{ background:"#f8fafc", border:"1px solid #e2e8f0", color:"#334155", padding:"7px 14px", borderRadius:20, fontSize:12, cursor:"pointer", fontFamily:"inherit" }}>
                {s}
              </button>
            );
          })}
        </div>
      )}

      {/* Input */}
      <div style={{ display:"flex", gap:7, padding:"12px 0 16px", borderTop:"1px solid #e2e8f0" }}>
        <textarea value={input} onChange={function(e){setInput(e.target.value);}} onKeyDown={handleKey}
          placeholder="Pergunte sobre suas vendas, estoque, finanças... (Enter para enviar)"
          rows={2} disabled={loading}
          style={{ flex:1, background:"#f8fafc", border:"1px solid #e2e8f0", color:"#0f172a", padding:"10px 14px",
            borderRadius:10, fontSize:13, outline:"none", resize:"none", fontFamily:"inherit", lineHeight:1.5 }} />
        <button onClick={enviar} disabled={loading || !input.trim()}
          style={{ background:loading||!input.trim()?"#f1f5f9":"#0f172a", border:"none",
            color:loading||!input.trim()?"#94a3b8":"#fff", fontWeight:700, padding:"0 20px",
            borderRadius:10, cursor:loading||!input.trim()?"not-allowed":"pointer", fontSize:20, flexShrink:0 }}>
          ➤
        </button>
      </div>
    </div>
  );
}


// ════════════════════════════════════════════════════════════
//  ABA PRECIFICAÇÃO — Calculadora vinculada aos anúncios
// ════════════════════════════════════════════════════════════

function NovoProdutoPrecForm({ onSave, onClose }) {
  const [f, setF] = useState({ nome:"", sku:"", custo:"", precoVenda:"", frete:"", taxaMl:"12", desconto:"0" });
  var set = function(k,v){ setF(function(p){ return Object.assign({},p,{[k]:v}); }); };
  var custo=parseFloat(f.custo||0), bruto=parseFloat(f.precoVenda||0);
  var taxa=bruto*(parseFloat(f.taxaMl||12)/100);
  var frete=parseFloat(f.frete||0);
  var lucro=bruto-custo-frete-taxa;
  var margem=bruto>0?(lucro/bruto)*100:0;
  var mCor=margem>=20?"#15803d":margem>=0?"#d97706":"#dc2626";
  return (
    <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
        <div>
          <div style={{ fontSize:10, color:"#94a3b8", marginBottom:3, fontWeight:600, textTransform:"uppercase" }}>Nome do Produto *</div>
          <input value={f.nome} onChange={function(e){set("nome",e.target.value);}} placeholder="Ex: Lanterna Traseira Uno"
            style={{ width:"100%", background:"#f8fafc", border:"1px solid #e2e8f0", color:"#0f172a", padding:"8px 10px", borderRadius:8, fontSize:12, outline:"none" }} />
        </div>
        <div>
          <div style={{ fontSize:10, color:"#94a3b8", marginBottom:3, fontWeight:600, textTransform:"uppercase" }}>SKU *</div>
          <input value={f.sku} onChange={function(e){set("sku",e.target.value);}} placeholder="Ex: 1234"
            style={{ width:"100%", background:"#f8fafc", border:"1px solid #e2e8f0", color:"#0f172a", padding:"8px 10px", borderRadius:8, fontSize:12, outline:"none", fontFamily:"monospace" }} />
        </div>
        <div>
          <div style={{ fontSize:10, color:"#94a3b8", marginBottom:3, fontWeight:600, textTransform:"uppercase" }}>Custo (R$)</div>
          <input type="number" step="0.01" value={f.custo} onChange={function(e){set("custo",e.target.value);}} placeholder="0,00"
            style={{ width:"100%", background:"#f8fafc", border:"1px solid #e2e8f0", color:"#0f172a", padding:"8px 10px", borderRadius:8, fontSize:12, outline:"none" }} />
        </div>
        <div>
          <div style={{ fontSize:10, color:"#94a3b8", marginBottom:3, fontWeight:600, textTransform:"uppercase" }}>Preço de Venda (R$)</div>
          <input type="number" step="0.01" value={f.precoVenda} onChange={function(e){set("precoVenda",e.target.value);}} placeholder="0,00"
            style={{ width:"100%", background:"#f8fafc", border:"1px solid #e2e8f0", color:"#0f172a", padding:"8px 10px", borderRadius:8, fontSize:12, outline:"none" }} />
        </div>
        <div>
          <div style={{ fontSize:10, color:"#94a3b8", marginBottom:3, fontWeight:600, textTransform:"uppercase" }}>Frete (R$)</div>
          <input type="number" step="0.01" value={f.frete} onChange={function(e){set("frete",e.target.value);}} placeholder="0,00"
            style={{ width:"100%", background:"#f8fafc", border:"1px solid #e2e8f0", color:"#0f172a", padding:"8px 10px", borderRadius:8, fontSize:12, outline:"none" }} />
        </div>
        <div>
          <div style={{ fontSize:10, color:"#94a3b8", marginBottom:3, fontWeight:600, textTransform:"uppercase" }}>Taxa ML (%)</div>
          <select value={f.taxaMl} onChange={function(e){set("taxaMl",e.target.value);}}
            style={{ width:"100%", background:"#f8fafc", border:"1px solid #e2e8f0", color:"#334155", padding:"8px 10px", borderRadius:8, fontSize:12 }}>
            <option value="12">12% — Clássico</option>
            <option value="17">17% — Premium</option>
          </select>
        </div>
      </div>
      {bruto > 0 && custo > 0 && (
        <div style={{ background:"#f8fafc", border:"1px solid #e2e8f0", borderRadius:8, padding:"10px 14px", display:"flex", gap:16 }}>
          <div><div style={{ fontSize:10, color:"#94a3b8" }}>Lucro</div><div style={{ fontWeight:700, color:lucro>=0?"#0891b2":"#dc2626" }}>R$ {lucro.toFixed(2).replace(".",",")}</div></div>
          <div><div style={{ fontSize:10, color:"#94a3b8" }}>Margem</div><div style={{ fontWeight:700, color:mCor }}>{margem.toFixed(1)}%</div></div>
          <div><div style={{ fontSize:10, color:"#94a3b8" }}>Taxa ML</div><div style={{ fontWeight:700, color:"#dc2626" }}>R$ {taxa.toFixed(2).replace(".",",")}</div></div>
        </div>
      )}
      <div style={{ display:"flex", gap:8, marginTop:4 }}>
        <button onClick={onClose} style={{ flex:1, background:"#f8fafc", border:"1px solid #e2e8f0", color:"#64748b", fontWeight:600, padding:"9px", borderRadius:9, cursor:"pointer" }}>Cancelar</button>
        <button onClick={function(){ if(f.nome&&f.sku) onSave(f); }} disabled={!f.nome||!f.sku}
          style={{ flex:2, background:f.nome&&f.sku?"#7c3aed":"#f1f5f9", border:"none", color:f.nome&&f.sku?"#fff":"#94a3b8", fontWeight:700, padding:"9px", borderRadius:9, cursor:f.nome&&f.sku?"pointer":"not-allowed" }}>
          Salvar e Acompanhar
        </button>
      </div>
    </div>
  );
}

function PrecificacaoTab({ enriched, costs, setCostsAndSave, fretesConfig, setFretesAndSave, rawOrders }) {
  const [busca, setBusca] = useState("");
  const [margemAlvo, setMargemAlvo] = useState(20);
  const [selectedId, setSelectedId] = useState(null);
  const [editingFreteId, setEditingFreteId] = useState(null);
  const [editingDescId, setEditingDescId] = useState(null);
  const [custosLocais, setCustosLocais] = useState({});
  const [descontosConfig, setDescontosConfig] = useState(function(){
    try { return JSON.parse(localStorage.getItem("descontos_config")||"{}"); } catch { return {}; }
  });
  function setDesconto(id, pct) {
    var next = Object.assign({}, descontosConfig, { [id]: pct });
    setDescontosConfig(next);
    try { localStorage.setItem("descontos_config", JSON.stringify(next)); } catch {}
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
    // Quando um produto extra tiver SKU que agora existe em enriched, vincula automaticamente
  }
  // Auto-vincular produtos extras a anúncios quando o SKU for encontrado nos enriched listings
  useEffect(function(){
    if (!enriched || !produtosExtras.length) return;
    var atualizados = false;
    var novaLista = produtosExtras.map(function(p){
      if (p.vinculado) return p; // já vinculado
      var match = enriched.find(function(l){ return l.seller_sku && l.seller_sku.trim() === p.sku.trim(); });
      if (match) { atualizados = true; return Object.assign({}, p, { vinculado: true, mlbVinculado: match.id, titulo: match.title }); }
      return p;
    });
    if (atualizados) saveProdutosExtras(novaLista);
  }, [enriched]);
  const [precosVendaConfig, setPrecosVendaConfig] = useState(function(){
    try { return JSON.parse(localStorage.getItem("precos_venda_config")||"{}"); } catch { return {}; }
  });
  function setPrecoVenda(id, preco) {
    var next = Object.assign({}, precosVendaConfig, { [id]: preco });
    setPrecosVendaConfig(next);
    try { localStorage.setItem("precos_venda_config", JSON.stringify(next)); } catch {}
    // Marca como pendente de atualização no ML (preço simulado != preço atual)
    marcarPendente(id, preco);
  }

  // ── Controle de "pendente de atualização no ML" ──
  const [pendentesAtualizacao, setPendentesAtualizacao] = useState(function(){
    try { return JSON.parse(localStorage.getItem("precos_pendentes_ml")||"{}"); } catch { return {}; }
  });
  function salvarPendentes(next) {
    setPendentesAtualizacao(next);
    try { localStorage.setItem("precos_pendentes_ml", JSON.stringify(next)); } catch {}
  }
  function marcarPendente(id, novoPreco) {
    var listing = (enriched||[]).find(function(l){ return l.id===id; });
    if (!listing) return;
    var next = Object.assign({}, pendentesAtualizacao);
    if (novoPreco > 0 && novoPreco !== listing.price) {
      next[id] = { precoAntigo: listing.price, precoNovo: novoPreco, data: new Date().toISOString(), titulo: listing.title };
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
      if (listing && listing.price === next[id].precoNovo) {
        delete next[id];
        mudou = true;
      }
    });
    if (mudou) salvarPendentes(next);
  }, [enriched]);

  const [buscaSku, setBuscaSku] = useState("");

  var listsFiltrados = (enriched||[]).filter(function(l) {
    // Campo único busca por título, MLB e SKU
    if (busca.trim()) {
      var q = busca.trim().toLowerCase();
      var matchTitulo = (l.title||"").toLowerCase().includes(q);
      var matchMlb    = (l.id||"").toLowerCase().includes(q);
      var matchSku    = (l.seller_sku||l.sku||"").toLowerCase().includes(q);
      return matchTitulo || matchMlb || matchSku;
    }
    return true;
  });

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
      <div style={{ padding:"12px 0 8px", borderBottom:"1px solid #e2e8f0", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
        <div>
          <div style={{ fontWeight:800, fontSize:20, color:"#0f172a", marginBottom:4 }}>💲 Precificação</div>
          <div style={{ fontSize:13, color:"#64748b" }}>Calcule o preço ideal para cada anúncio com base na margem desejada</div>
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:7, background:"#f8fafc", border:"1px solid #e2e8f0", borderRadius:10, padding:"10px 16px" }}>
          <span style={{ fontSize:13, color:"#64748b", fontWeight:600 }}>Margem alvo:</span>
          <input type="number" min="1" max="99" value={margemAlvo} onChange={function(e){setMargemAlvo(parseFloat(e.target.value)||20);}}
            style={{ width:60, background:"#fff", border:"1px solid #e2e8f0", color:"#0f172a", padding:"6px 10px", borderRadius:8, fontSize:15, fontWeight:700, outline:"none", textAlign:"center" }} />
          <span style={{ fontSize:15, fontWeight:700, color:"#0f172a" }}>%</span>
        </div>
      </div>

      {/* Banner de avisos — preços pendentes de atualização no ML */}
      {Object.keys(pendentesAtualizacao).length > 0 && (
        <div style={{ background:"#fffbeb", border:"1px solid #fde68a", borderRadius:10, padding:"12px 16px", margin:"12px 0" }}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8 }}>
            <div style={{ fontSize:13, fontWeight:700, color:"#92400e" }}>
              ⚠️ {Object.keys(pendentesAtualizacao).length} anúncio(s) com preço pendente de atualização no Mercado Livre
            </div>
          </div>
          <div style={{ display:"flex", flexDirection:"column", gap:6, maxHeight:160, overflowY:"auto" }}>
            {Object.entries(pendentesAtualizacao).map(function([id, p]){
              return (
                <div key={id} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", background:"#fff", border:"1px solid #fde68a", borderRadius:8, padding:"7px 12px" }}>
                  <div style={{ flex:1, minWidth:0, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", fontSize:12, color:"#0f172a" }}>
                    {p.titulo}
                  </div>
                  <div style={{ display:"flex", alignItems:"center", gap:10, flexShrink:0 }}>
                    <span style={{ fontSize:11, color:"#94a3b8", textDecoration:"line-through" }}>R$ {p.precoAntigo.toFixed(2).replace(".",",")}</span>
                    <span style={{ fontSize:12, fontWeight:700, color:"#7c3aed" }}>→ R$ {p.precoNovo.toFixed(2).replace(".",",")}</span>
                    <a href={"https://www.mercadolivre.com.br/seller-admin/listing/edit?itemId="+id} target="_blank" rel="noreferrer"
                      style={{ fontSize:11, color:"#0891b2", textDecoration:"none", fontWeight:600, whiteSpace:"nowrap" }}>
                      Editar no ML ↗
                    </a>
                    <button onClick={function(){ confirmarAtualizado(id); }}
                      style={{ background:"#15803d", border:"none", color:"#fff", fontWeight:700, padding:"4px 10px", borderRadius:6, cursor:"pointer", fontSize:11, whiteSpace:"nowrap" }}>
                      ✓ Já atualizei
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Botão novo produto + Busca */}
      <div style={{ display:"flex", gap:7, margin:"14px 0", alignItems:"center" }}>
        <button onClick={function(){ setShowNovoProdutoPrec(true); }}
          style={{ background:"#7c3aed", border:"none", color:"#fff", fontWeight:700, padding:"9px 14px", borderRadius:9, cursor:"pointer", fontSize:12, whiteSpace:"nowrap", flexShrink:0 }}>
          + Precificar Novo Produto
        </button>
        <div style={{ position:"relative", flex:1 }}>
          <span style={{ position:"absolute", left:12, top:"50%", transform:"translateY(-50%)", color:"#94a3b8", fontSize:14 }}>🔍</span>
          <input value={busca} onChange={function(e){setBusca(e.target.value);}} placeholder="Buscar por título, MLB ou SKU..."
            style={{ width:"100%", background:"#fff", border:"1px solid #e2e8f0", color:"#0f172a", padding:"10px 14px 10px 36px", borderRadius:10, fontSize:13, outline:"none" }} />
          {busca && (
            <button onClick={function(){setBusca("");}} style={{ position:"absolute", right:10, top:"50%", transform:"translateY(-50%)", background:"none", border:"none", color:"#94a3b8", cursor:"pointer", fontSize:18, lineHeight:1 }}>×</button>
          )}
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:8, background:"#f8fafc", border:"1px solid #e2e8f0", borderRadius:10, padding:"0 14px", fontSize:12, color:"#64748b", whiteSpace:"nowrap" }}>
          {listsFiltrados.length} anúncio(s)
        </div>
      </div>

      {/* Modal novo produto para precificação */}
      {showNovoProdutoPrec && (
        <div style={{ position:"fixed", inset:0, background:"rgba(15,23,42,.5)", zIndex:600, display:"flex", alignItems:"center", justifyContent:"center", padding:16 }}>
          <div style={{ background:"#fff", borderRadius:14, width:480, padding:20 }}>
            <div style={{ fontWeight:700, fontSize:15, marginBottom:14 }}>+ Precificar Novo Produto</div>
            <NovoProdutoPrecForm
              onSave={function(p){
                saveProdutosExtras([...produtosExtras, Object.assign({id:"extra_"+Date.now()}, p)]);
                setShowNovoProdutoPrec(false);
              }}
              onClose={function(){ setShowNovoProdutoPrec(false); }}
            />
          </div>
        </div>
      )}

      {/* Produtos extras (ainda não anunciados) */}
      {produtosExtras.filter(function(p){return !p.vinculado;}).length > 0 && (
        <div style={{ marginBottom:10 }}>
          <div style={{ fontSize:11, fontWeight:700, color:"#7c3aed", textTransform:"uppercase", marginBottom:6 }}>📦 Produtos aguardando anúncio no ML</div>
          {produtosExtras.filter(function(p){return !p.vinculado;}).map(function(p){
            var custo = parseFloat(p.custo||0);
            var bruto = parseFloat(p.precoVenda||0);
            var taxa = bruto * (parseFloat(p.taxaMl||12)/100);
            var frete = parseFloat(p.frete||0);
            var lucro = bruto - custo - frete - taxa;
            var margem = bruto>0?(lucro/bruto)*100:0;
            var mCor = margem>=margemAlvo?"#15803d":margem>=0?"#d97706":"#dc2626";
            return (
              <div key={p.id} style={{ display:"flex", gap:10, alignItems:"center", background:"#faf5ff", border:"1px solid #ddd6fe", borderRadius:10, padding:"10px 14px", marginBottom:6 }}>
                <div style={{ flex:1 }}>
                  <div style={{ fontSize:13, fontWeight:700, color:"#0f172a" }}>{p.nome}</div>
                  <div style={{ fontSize:11, color:"#7c3aed" }}>SKU: {p.sku} · Aguardando anúncio no ML</div>
                </div>
                <div style={{ fontSize:12, color:"#64748b" }}>Custo: R$ {custo.toFixed(2).replace(".",",")}</div>
                <div style={{ fontSize:12, fontWeight:700, color:"#0f172a" }}>Venda: R$ {bruto.toFixed(2).replace(".",",")}</div>
                <span style={{ fontSize:12, fontWeight:700, color:mCor, background:mCor+"18", padding:"2px 8px", borderRadius:6 }}>
                  {margem.toFixed(1)}%
                </span>
                <button onClick={function(){
                  if(!window.confirm("Remover este produto?")) return;
                  saveProdutosExtras(produtosExtras.filter(function(x){return x.id!==p.id;}));
                }} style={{ background:"#fef2f2", border:"none", color:"#dc2626", width:24, height:24, borderRadius:6, cursor:"pointer", fontSize:11 }}>✕</button>
              </div>
            );
          })}
        </div>
      )}

      {/* Tabela */}
      <div style={{ background:"#fff", border:"1px solid #e2e8f0", borderRadius:12, overflow:"auto" }}>
        <table style={{ borderCollapse:"collapse", width:"100%", minWidth:900 }}>
          <thead>
            <tr style={{ background:"#f8fafc" }}>
              {[
                "SKU","MLB","Tipo","Anúncio",
                "Custo","Preço Atual","Frete Real","Frete Config.",
                "💡 Vender por → Anunciar por","🏷 % Desc. Promoção",
                "Taxa ML (s/ desconto)",
                "Lucro Simulado","Margem Simulada","Ação"
              ].map(function(h){
                var isSimul = ["💡 Vender por → Anunciar por","Lucro Simulado","Margem Simulada","Taxa ML (s/ desconto)"].includes(h);
                return <th key={h} style={{ fontSize:10, color: isSimul?"#7c3aed":"#64748b", fontWeight:600, textTransform:"uppercase", padding:"8px 10px", borderBottom:"1px solid #e2e8f0", textAlign:"left", whiteSpace:"nowrap", background: isSimul?"#faf5ff":"transparent" }}>{h}</th>;
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
              // Taxa ML calculada sobre o preço COM desconto (promoção)
              var feeRate = taxa > 0 && bruto > 0 ? taxa/bruto : (l.feeRate||0.12);
              var taxaSobreDesc = precoComDesc * feeRate;
              // Lucro e margem com desconto e frete
              var lucroFinal = precoComDesc - custo - frete - taxaSobreDesc;
              var margemFinal = precoComDesc > 0 ? (lucroFinal/precoComDesc)*100 : 0;
              var mCor = margemFinal >= margemAlvo ? "#15803d" : margemFinal >= margemAlvo*0.6 ? "#d97706" : "#dc2626";
              var isEditing = selectedId === l.id;
              var t = l.listing_type_id||"";
              var isPremium = t==="gold_premium"||t==="gold_pro";

              return (
                <tr key={l.id} style={{ borderBottom:"1px solid #f1f5f9", background:i%2===0?"#fff":"#fafafa" }}>

                  {/* SKU */}
                  <td style={{ padding:"6px 8px" }}>
                    <span style={{ fontSize:11, fontFamily:"monospace", fontWeight:700, color:"#334155", background:"#f1f5f9", padding:"2px 6px", borderRadius:4, whiteSpace:"nowrap" }}>
                      {l.seller_sku||l.sku||"—"}
                    </span>
                  </td>

                  {/* MLB */}
                  <td style={{ padding:"6px 8px", fontSize:11, color:"#0891b2", fontFamily:"monospace" }}>
                    {l.id}
                  </td>

                  {/* Tipo */}
                  <td style={{ padding:"6px 8px" }}>
                    <span style={{ fontSize:10, fontWeight:700, padding:"2px 6px", borderRadius:5, whiteSpace:"nowrap",
                      background: isPremium?"#f5f3ff":"#eff6ff",
                      color: isPremium?"#7c3aed":"#1d4ed8",
                      border:"1px solid "+(isPremium?"#ddd6fe":"#bfdbfe") }}>
                      {isPremium?"⭐ Premium":"📋 Clássico"}
                    </span>
                  </td>

                  {/* Anúncio */}
                  <td style={{ padding:"6px 8px", maxWidth:220, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                    <div style={{ fontSize:12, fontWeight:600, color:"#0f172a" }}>{l.title}</div>
                  </td>

                  {/* Custo (editável) */}
                  <td style={{ padding:"6px 8px" }}>
                    {isEditing ? (
                      <input type="number" step="0.01" defaultValue={custo}
                        onBlur={function(e){ var v=parseFloat(e.target.value)||0; setCustosLocais(function(c){return {...c,[l.id]:v};}); setCostsAndSave(function(c){return {...c,[l.id]:v};}); setSelectedId(null); }}
                        autoFocus
                        style={{ width:72, background:"#fff", border:"1px solid #0891b2", color:"#0f172a", padding:"3px 6px", borderRadius:6, fontSize:12, outline:"none" }} />
                    ) : (
                      <span onClick={function(){setSelectedId(l.id);}} title="Clique para editar custo"
                        style={{ cursor:"pointer", fontSize:12, fontWeight:600, color:custo>0?"#334155":"#dc2626",
                          background:custo>0?"transparent":"#fef2f2", padding:custo>0?"0":"2px 6px", borderRadius:4 }}>
                        {custo>0?"R$ "+custo.toFixed(2).replace(".",","): "✎ Sem custo"}
                      </span>
                    )}
                  </td>

                  {/* Preço Atual */}
                  <td style={{ padding:"6px 8px", fontSize:12, fontWeight:700, color:"#0f172a", whiteSpace:"nowrap" }}>
                    R$ {bruto.toFixed(2).replace(".",",")}
                  </td>

                  {/* Frete Real */}
                  <td style={{ padding:"6px 8px", fontSize:12, color:"#d97706", whiteSpace:"nowrap" }}>
                    R$ {freteReal.toFixed(2).replace(".",",")}
                  </td>

                  {/* Frete Config (editável) */}
                  <td style={{ padding:"6px 8px" }}>
                    {editingFreteId === l.id ? (
                      <input type="number" step="0.01" min="0" defaultValue={freteConfig||""} placeholder="0,00"
                        onBlur={function(e){ var v=parseFloat(e.target.value)||0; setFretesAndSave(function(f){return Object.assign({},f,{[l.id]:v});}); setEditingFreteId(null); }}
                        autoFocus
                        style={{ width:72, background:"#fff", border:"1px solid #0891b2", color:"#0f172a", padding:"3px 6px", borderRadius:6, fontSize:12, outline:"none" }} />
                    ) : (
                      <span onClick={function(){setEditingFreteId(l.id);}} title="Frete esperado"
                        style={{ cursor:"pointer", fontSize:12, fontWeight:600,
                          color:freteConfig>0?"#d97706":"#94a3b8",
                          background:freteConfig>0?"transparent":"#f8fafc",
                          padding:freteConfig>0?"0":"2px 6px", borderRadius:4 }}>
                        {freteConfig>0?"R$ "+freteConfig.toFixed(2).replace(".",","):"✎ definir"}
                      </span>
                    )}
                  </td>

                  {/* 💡 Preço de Venda Desejado → Preço a Anunciar (editável) */}
                  <td style={{ padding:"6px 8px", background:"#faf5ff" }}>
                    {editingPrecoId === l.id ? (
                      <div style={{ display:"flex", flexDirection:"column", gap:2 }}>
                        <span style={{ fontSize:9, color:"#94a3b8" }}>Vender por (c/ desconto):</span>
                        <div style={{ display:"flex", alignItems:"center", gap:3 }}>
                          <span style={{ fontSize:10, color:"#94a3b8" }}>R$</span>
                          <input type="number" step="0.01" min="0"
                            defaultValue={precoVendaDesejado||""}
                            placeholder={bruto.toFixed(2)}
                            autoFocus
                            onBlur={function(e){ var v=parseFloat(e.target.value)||0; setPrecoVenda(l.id,v); setEditingPrecoId(null); }}
                            onKeyDown={function(e){ if(e.key==="Enter"||e.key==="Escape") e.target.blur(); }}
                            style={{ width:78, background:"#fff", border:"1px solid #7c3aed", color:"#0f172a", padding:"3px 6px", borderRadius:6, fontSize:12, outline:"none", textAlign:"right" }} />
                        </div>
                      </div>
                    ) : (
                      <div onClick={function(){ setEditingPrecoId(l.id); }} title="Clique para definir o preço de venda que você quer receber (já com desconto) — o sistema calcula o preço a anunciar" style={{ cursor:"pointer" }}>
                        {precoVendaDesejado > 0 ? (
                          <div>
                            <span style={{ fontSize:13, fontWeight:800, color:"#7c3aed" }}>
                              📢 R$ {precoParaAnunciar.toFixed(2).replace(".",",")}
                            </span>
                            <div style={{ fontSize:10, color:"#64748b" }}>
                              vender por R$ {precoVendaDesejado.toFixed(2).replace(".",",")}
                              {descPct > 0 && <span style={{ color:"#94a3b8" }}> (-{descPct}%)</span>}
                            </div>
                            {pendentesAtualizacao[l.id] && (
                              <div style={{ fontSize:9, fontWeight:700, color:"#d97706", background:"#fffbeb", border:"1px solid #fde68a", padding:"1px 5px", borderRadius:4, marginTop:2, display:"inline-block" }}>
                                ⏳ pendente ML
                              </div>
                            )}
                          </div>
                        ) : (
                          <span style={{ fontSize:11, color:"#94a3b8", background:"#f5f3ff", border:"1px dashed #ddd6fe", padding:"2px 7px", borderRadius:5 }}>
                            ✎ simular
                          </span>
                        )}
                      </div>
                    )}
                  </td>

                  {/* 🏷 % Desconto Promoção */}
                  <td style={{ padding:"6px 8px", background:"#faf5ff" }}>
                    {editingDescId === l.id ? (
                      <div style={{ display:"flex", alignItems:"center", gap:3 }}>
                        <input type="number" min="0" max="80" step="1"
                          defaultValue={descPct||""}
                          placeholder="0"
                          autoFocus
                          onBlur={function(e){ var v=Math.min(80,Math.max(0,parseFloat(e.target.value)||0)); setDesconto(l.id,v); setEditingDescId(null); }}
                          onKeyDown={function(e){ if(e.key==="Enter"||e.key==="Escape") e.target.blur(); }}
                          style={{ width:46, background:"#fff", border:"1px solid #7c3aed", color:"#0f172a", padding:"3px 6px", borderRadius:6, fontSize:12, outline:"none", textAlign:"center" }} />
                        <span style={{ fontSize:11, color:"#94a3b8" }}>%</span>
                      </div>
                    ) : (
                      <div onClick={function(){ setEditingDescId(l.id); }} title="% de desconto na promoção" style={{ cursor:"pointer" }}>
                        {descPct > 0 ? (
                          <div>
                            <span style={{ fontSize:12, fontWeight:700, color:"#7c3aed", background:"#f5f3ff", padding:"2px 7px", borderRadius:5 }}>
                              {descPct}%
                            </span>
                            <div style={{ fontSize:10, color:"#7c3aed", marginTop:1 }}>
                              cliente paga R$ {precoComDesc.toFixed(2).replace(".",",")}
                            </div>
                          </div>
                        ) : (
                          <span style={{ fontSize:11, color:"#94a3b8", background:"#f8fafc", border:"1px dashed #e2e8f0", padding:"2px 7px", borderRadius:5 }}>
                            ✎ definir
                          </span>
                        )}
                      </div>
                    )}
                  </td>

                  {/* Taxa ML sobre preço c/ desconto */}
                  <td style={{ padding:"6px 8px", background:"#faf5ff" }}>
                    <div style={{ fontSize:12, fontWeight:700, color:"#dc2626" }}>
                      R$ {taxaSobreDesc.toFixed(2).replace(".",",")}
                    </div>
                    <div style={{ fontSize:10, color:"#94a3b8" }}>
                      {(feeRate*100).toFixed(0)}% s/ {descPct>0?"desc":"atual"}
                    </div>
                  </td>

                  {/* Lucro Simulado (com desconto se houver) */}
                  <td style={{ padding:"6px 8px", background:"#faf5ff" }}>
                    {custo > 0 ? (
                      <div>
                        <span style={{ fontSize:13, fontWeight:700, color:lucroFinal>=0?"#0891b2":"#dc2626" }}>
                          R$ {lucroFinal.toFixed(2).replace(".",",")}
                        </span>
                        {descPct > 0 && (
                          <div style={{ fontSize:10, color:"#94a3b8", marginTop:1 }}>c/ {descPct}% desc</div>
                        )}
                      </div>
                    ) : <span style={{color:"#94a3b8",fontSize:11}}>—</span>}
                  </td>

                  {/* Margem Simulada */}
                  <td style={{ padding:"6px 8px", background:"#faf5ff" }}>
                    {custo > 0 ? (
                      <span style={{ fontSize:13, fontWeight:700, color:mCor, background:mCor+"18", padding:"3px 8px", borderRadius:6, display:"inline-block" }}>
                        {margemFinal.toFixed(1)}%
                        {margemFinal >= margemAlvo ? " ✓" : " ↓"}
                      </span>
                    ) : <span style={{color:"#94a3b8",fontSize:11}}>—</span>}
                  </td>

                  {/* Ação */}
                  <td style={{ padding:"6px 8px" }}>
                    <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
                      <a href={"https://www.mercadolivre.com.br/seller-admin/listing/edit?itemId="+l.id} target="_blank" rel="noreferrer"
                        style={{ fontSize:11, color:"#0891b2", textDecoration:"none", fontWeight:600 }}>
                        Editar ML ↗
                      </a>
                      <a href={"https://vendedores.mercadolivre.com.br/ferramentas/promocoes"} target="_blank" rel="noreferrer"
                        style={{ fontSize:10, color:"#7c3aed", textDecoration:"none", fontWeight:600 }}>
                        Promoções ↗
                      </a>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {listsFiltrados.length === 0 && (
          <div style={{ textAlign:"center", padding:"40px", color:"#94a3b8" }}>
            <div style={{ fontSize:32, marginBottom:8 }}>🔍</div>
            <div>Nenhum anúncio encontrado</div>
          </div>
        )}
      </div>
    </div>
  );
}


// ════════════════════════════════════════════════════════════
//  ABA PUBLICIDADE — Campanhas ML Ads
// ════════════════════════════════════════════════════════════
function PublicidadeTab({ token, sellerId, enriched }) {
  const [campanhas, setCampanhas] = useState([]);
  const [metricas, setMetricas] = useState({});
  const [loading, setLoading] = useState(false);
  const [erro, setErro] = useState(null);
  const [periodo, setPeriodo] = useState("LAST_7_DAYS");
  const [totalMetricas, setTotalMetricas] = useState(null);
  const [ultimaAtualizacao, setUltimaAtualizacao] = useState(null);
  const [expandedCamp, setExpandedCamp] = useState({});   // {campId: true/false}
  const [anunciosCamp, setAnunciosCamp] = useState({});   // {campId: [...items]}
  const [loadingAnuncios, setLoadingAnuncios] = useState({});
  const [advertiserId, setAdvertiserId] = useState(null);

  var periodos = [
    { k:"TODAY",       l:"Hoje" },
    { k:"YESTERDAY",   l:"Ontem" },
    { k:"LAST_7_DAYS", l:"Últimos 7 dias" },
    { k:"LAST_14_DAYS",l:"Últimos 14 dias" },
    { k:"LAST_30_DAYS",l:"Últimos 30 dias" },
    { k:"THIS_MONTH",  l:"Este mês" },
  ];

  async function carregarCampanhas() {
    if (!token || !sellerId) { setErro("Conecte ao Mercado Livre primeiro."); return; }
    setLoading(true); setErro(null);

    // Mapear período para datas reais (API ML Ads usa date_from/date_to)
    function getDatas(p) {
      var hoje = new Date();
      var fmt = function(d){ return d.toISOString().slice(0,10); };
      var sub = function(n){ var d=new Date(hoje); d.setDate(d.getDate()-n); return d; };
      if(p==="TODAY")        return { from: fmt(hoje),       to: fmt(hoje) };
      if(p==="YESTERDAY")    return { from: fmt(sub(1)),     to: fmt(sub(1)) };
      if(p==="LAST_7_DAYS")  return { from: fmt(sub(7)),     to: fmt(hoje) };
      if(p==="LAST_14_DAYS") return { from: fmt(sub(14)),    to: fmt(hoje) };
      if(p==="LAST_30_DAYS") return { from: fmt(sub(30)),    to: fmt(hoje) };
      if(p==="THIS_MONTH")   { var d=new Date(hoje.getFullYear(),hoje.getMonth(),1); return { from: fmt(d), to: fmt(hoje) }; }
      return { from: fmt(sub(7)), to: fmt(hoje) };
    }
    var datas = getDatas(periodo);

    try {
      // Header obrigatório pela API oficial do Product Ads (documentação ML)
      var headers = { Authorization: "Bearer "+token, "Content-Type": "application/json", "Api-Version": "2" };

      // ── 1. Buscar o advertiser_id (NÃO é o seller_id — é um ID separado do Product Ads) ──
      var advRes = await fetch("/api/ml/advertising/advertisers?product_id=PADS", { headers: headers });
      var advTxt = await advRes.text();
      console.log("[PUBLICIDADE] advertisers status "+advRes.status+":", advTxt.slice(0,500));

      if (advRes.status !== 200) {
        throw new Error("Não foi possível obter o advertiser_id (status "+advRes.status+"). Isso geralmente significa que o Product Ads não está habilitado nesta conta, ou que o token de conexão não tem o escopo de advertising. Acesse Mercado Livre > Seu perfil > Publicidade para habilitar.");
      }
      var advData = JSON.parse(advTxt);
      var advertisers = advData.advertisers || advData.results || (Array.isArray(advData) ? advData : []);
      if (!advertisers.length) {
        throw new Error("Nenhum 'advertiser' encontrado para esta conta. O Product Ads pode não estar habilitado — acesse Mercado Livre > Seu perfil > Publicidade.");
      }
      var advId = advertisers[0].advertiser_id || advertisers[0].id;
      setAdvertiserId(advId);

      // ── 2. Buscar campanhas desse advertiser (endpoint oficial documentado) ──
      var campUrl = "/api/ml/advertising/advertisers/"+advId+"/product_ads/campaigns?limit=50&offset=0";
      var res = await fetch(campUrl, { headers: headers });
      var txt = await res.text();
      console.log("[PUBLICIDADE] campanhas status "+res.status+":", txt.slice(0,500));

      if (res.status !== 200) {
        throw new Error("Erro ao buscar campanhas (status "+res.status+"): "+txt.slice(0,200));
      }
      var data = JSON.parse(txt);
      var camps = Array.isArray(data) ? data : (data.results || data.campaigns || data.data || []);
      setCampanhas(camps);

      if (camps.length === 0) {
        setErro(null);
        setLoading(false);
        return;
      }

      // ── 3. Buscar campanhas COM métricas direto (endpoint /campaigns aceita filtro de métricas) ──
      var metMap = {};
      var totais = { impressoes:0, cliques:0, vendas:0, receita:0, gasto:0 };

      var metricsParam = "clicks,prints,cost,acos,direct_amount,direct_items_quantity";
      var campWithMetricsUrl = "/api/ml/advertising/advertisers/"+advId+"/product_ads/campaigns"+
        "?limit=50&offset=0&date_from="+datas.from+"&date_to="+datas.to+"&metrics="+metricsParam;
      try {
        var mr = await fetch(campWithMetricsUrl, { headers: headers });
        var mtxt = await mr.text();
        console.log("[PUBLICIDADE] campanhas+métricas status "+mr.status+":", mtxt.slice(0,500));
        if (mr.status === 200) {
          var mdata = JSON.parse(mtxt);
          var campsComMetricas = Array.isArray(mdata) ? mdata : (mdata.results || mdata.campaigns || []);
          campsComMetricas.forEach(function(c) {
            var met = c.metrics || c;
            metMap[c.id] = met;
            totais.impressoes += parseFloat(met.prints||met.impressions||0);
            totais.cliques    += parseFloat(met.clicks||0);
            totais.vendas     += parseFloat(met.direct_items_quantity||met.organic_items_quantity||0);
            totais.receita    += parseFloat(met.direct_amount||met.organic_units_amount||0);
            totais.gasto      += parseFloat(met.cost||0);
          });
          // Se essa chamada já trouxe as campanhas atualizadas, usa elas (têm mais dados que a primeira)
          if (campsComMetricas.length > 0) { setCampanhas(campsComMetricas); }
        }
      } catch(e2) {
        console.warn("[PUBLICIDADE] erro ao buscar métricas agregadas:", e2.message);
      }

      totais.roas = totais.gasto > 0 ? totais.receita/totais.gasto : 0;
      totais.ctr  = totais.impressoes > 0 ? (totais.cliques/totais.impressoes)*100 : 0;
      totais.acos = totais.receita > 0 ? (totais.gasto/totais.receita)*100 : 0;
      setMetricas(metMap);
      setTotalMetricas(totais);
      setUltimaAtualizacao(new Date().toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"}));
      setErro(null);
    } catch(e) {
      console.error("[PUBLICIDADE] erro:", e);
      setErro(e.message + " — Verifique o console (F12) para detalhes técnicos.");
    }
    setLoading(false);
  }

  useEffect(function(){ if(token&&sellerId) carregarCampanhas(); }, [token, sellerId, periodo]);

  function toggleCampanha(campId) {
    var novoEstado = !expandedCamp[campId];
    setExpandedCamp(function(p){ return Object.assign({},p,{[campId]:novoEstado}); });
    // A API do ML não disponibiliza endpoint de anúncios por campanha para apps externos.
    // Exibimos os anúncios ativos do seller que pertencem a esta conta de ads.
    // Os anúncios já estão carregados em `enriched` (listings do seller).
    if (novoEstado && !anunciosCamp[campId] && enriched && enriched.length > 0) {
      // Mostra todos os anúncios ativos do seller como anúncios desta campanha
      // (a API não retorna o vínculo campanha→item sem certificação)
      var adsExibir = enriched.filter(function(l){ return l.status === "active"; }).slice(0,20).map(function(l){
        return {
          item_id: l.id,
          title: l.title,
          thumbnail: l.thumbnail || l.pictures?.[0]?.url,
          permalink: l.permalink || ("https://www.mercadolivre.com.br/"+l.id),
          price: l.salePrice || l.price,
          listing_type_id: l.listing_type_id,
        };
      });
      setAnunciosCamp(function(p){ return Object.assign({},p,{[campId]:adsExibir}); });
    }
  }

  function fmtR(n){ return "R$ "+(parseFloat(n||0)).toFixed(2).replace(".",","); }
  function fmtN(n){ return parseInt(n||0).toLocaleString("pt-BR"); }
  function statusCor(s) {
    return s==="enabled"||s==="active"||s==="ENABLED" ? "#15803d" :
           s==="paused"||s==="PAUSED" ? "#d97706" : "#94a3b8";
  }
  function statusLabel(s) {
    return s==="enabled"||s==="active"||s==="ENABLED"||s==="A" ? "Ativa" :
           s==="paused"||s==="PAUSED"||s==="P" ? "Pausada" :
           s==="archived"||s==="ARCHIVED" ? "Arquivada" : s||"—";
  }

  return (
    <div style={{ padding:"0 12px" }}>
      {/* Header */}
      <div style={{ padding:"12px 0 8px", borderBottom:"1px solid #e2e8f0", display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8 }}>
        <div>
          <div style={{ fontWeight:800, fontSize:20, color:"#0f172a", marginBottom:4 }}>📣 Publicidade — ML Ads</div>
          <div style={{ fontSize:13, color:"#64748b" }}>Campanhas e métricas de anúncios patrocinados do Mercado Livre</div>
        </div>
        <div style={{ display:"flex", gap:7, alignItems:"center" }}>
          <select value={periodo} onChange={function(e){setPeriodo(e.target.value);}}
            style={{ background:"#fff", border:"1px solid #e2e8f0", color:"#334155", padding:"8px 14px", borderRadius:9, fontSize:12 }}>
            {periodos.map(function(p){ return <option key={p.k} value={p.k}>{p.l}</option>; })}
          </select>
          <button onClick={carregarCampanhas} disabled={loading}
            style={{ background:loading?"#f1f5f9":"#0f172a", border:"none", color:loading?"#94a3b8":"#fff", fontWeight:700, padding:"8px 18px", borderRadius:9, cursor:loading?"not-allowed":"pointer", fontSize:13, display:"flex", alignItems:"center", gap:6 }}>
            {loading ? "⏳ Carregando..." : "🔄 Atualizar"}
          </button>
          {ultimaAtualizacao && <span style={{ fontSize:11, color:"#94a3b8" }}>Atualizado às {ultimaAtualizacao}</span>}
        </div>
      </div>

      {/* Erro */}
      {erro && (
        <div style={{ background:"#fef2f2", border:"1px solid #fecaca", borderRadius:10, padding:"10px 14px", color:"#dc2626", marginBottom:8, fontSize:13 }}>
          <div style={{ marginBottom:8 }}>⚠️ {erro}</div>
          <a href="https://publicidade.mercadolivre.com.br" target="_blank" rel="noreferrer"
            style={{ display:"inline-block", background:"#ffe000", color:"#0f172a", fontWeight:700, padding:"8px 18px", borderRadius:8, textDecoration:"none", fontSize:12 }}>
            📣 Ver campanhas direto no Mercado Ads ↗
          </a>
        </div>
      )}

      {/* Cards de totais */}
      {totalMetricas && (
        <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(150px,1fr))", gap:12, marginBottom:10 }}>
          {[
            { l:"Vendas (Ads)", v:fmtN(totalMetricas.vendas), cor:"#0f172a", icon:"🛒" },
            { l:"ROAS", v:totalMetricas.roas.toFixed(2)+"x", cor:"#7c3aed", icon:"📈" },
            { l:"Receita (Ads)", v:fmtR(totalMetricas.receita), cor:"#15803d", icon:"💰" },
            { l:"Gasto", v:fmtR(totalMetricas.gasto), cor:"#dc2626", icon:"💸" },
            { l:"ACOS", v:totalMetricas.acos.toFixed(1)+"%", cor:totalMetricas.acos<15?"#15803d":totalMetricas.acos<30?"#d97706":"#dc2626", icon:"🎯" },
            { l:"Cliques", v:fmtN(totalMetricas.cliques), cor:"#0891b2", icon:"👆" },
            { l:"Impressões", v:fmtN(totalMetricas.impressoes), cor:"#64748b", icon:"👁" },
            { l:"CTR", v:totalMetricas.ctr.toFixed(2)+"%", cor:"#0891b2", icon:"🖱" },
          ].map(function(k){
            return (
              <div key={k.l} style={{ background:"#fff", border:"1px solid #e2e8f0", borderRadius:12, padding:"14px 16px", boxShadow:"0 1px 3px rgba(0,0,0,.04)" }}>
                <div style={{ fontSize:11, color:"#94a3b8", fontWeight:600, textTransform:"uppercase", marginBottom:6 }}>{k.icon} {k.l}</div>
                <div style={{ fontSize:15, fontWeight:800, color:k.cor }}>{k.v}</div>
              </div>
            );
          })}
        </div>
      )}

      {/* Tabela de campanhas */}
      {loading && campanhas.length===0 ? (
        <div style={{ textAlign:"center", padding:"60px", color:"#94a3b8" }}>
          <div style={{ fontSize:40, marginBottom:12 }}>⏳</div>
          <div style={{ fontWeight:600, color:"#0f172a", marginBottom:8 }}>Carregando campanhas...</div>
          <div style={{ fontSize:13 }}>Buscando dados de publicidade no Mercado Livre</div>
        </div>
      ) : campanhas.length === 0 && !loading ? (
        <div style={{ textAlign:"center", padding:"60px", color:"#94a3b8" }}>
          <div style={{ fontSize:40, marginBottom:12 }}>📣</div>
          <div style={{ fontWeight:600, color:"#0f172a", marginBottom:8 }}>Nenhuma campanha encontrada</div>
          <div style={{ fontSize:13, marginBottom:8 }}>Conecte ao ML e clique em Atualizar para carregar suas campanhas</div>
          <a href="https://publicidade.mercadolivre.com.br" target="_blank" rel="noreferrer"
            style={{ background:"#ffe000", color:"#0f172a", fontWeight:700, padding:"10px 24px", borderRadius:10, textDecoration:"none", fontSize:13 }}>
            Criar campanha no ML ↗
          </a>
        </div>
      ) : (
        <div style={{ background:"#fff", border:"1px solid #e2e8f0", borderRadius:12, overflow:"auto" }}>
          <table style={{ borderCollapse:"collapse", width:"100%", minWidth:900 }}>
            <thead>
              <tr style={{ background:"#f8fafc", borderBottom:"2px solid #e2e8f0" }}>
                {["","Nome da Campanha","Status","Orçamento Diário","ROAS Obj.","Vendas (Ads)","ROAS Real","Receita","Gasto","ACOS","Cliques","Impressões","CTR","Ação"].map(function(h){
                  return <th key={h} style={{ fontSize:10, color:"#64748b", fontWeight:600, textTransform:"uppercase", padding:"10px 12px", textAlign:"left", whiteSpace:"nowrap" }}>{h}</th>;
                })}
              </tr>
            </thead>
            <tbody>
              {campanhas.map(function(c, i) {
                var m = metricas[c.id] || c.metrics || {};
                // Campos oficiais da API Product Ads: prints, clicks, cost, direct_amount, acos
                var impressoes = parseFloat(m.prints||m.impressions||0);
                var cliques    = parseFloat(m.clicks||0);
                var vendas     = parseFloat(m.direct_items_quantity||m.organic_items_quantity||0);
                var receita    = parseFloat(m.direct_amount||m.organic_units_amount||0);
                var gasto      = parseFloat(m.cost||0);
                var roas       = gasto>0 ? receita/gasto : 0;
                var acos       = m.acos!=null ? parseFloat(m.acos) : (receita>0 ? (gasto/receita)*100 : 0);
                var ctr        = impressoes>0 ? (cliques/impressoes)*100 : 0;
                var isAtiva    = c.status==="active"||c.status==="enabled"||c.status==="ENABLED"||c.status==="A";
                var sCorText   = statusCor(c.status);
                var roasObjN   = parseFloat(c.acos_target||c.roas_target||0);

                return (
                  <React.Fragment key={c.id}>
                  <tr style={{ borderBottom:"1px solid #f1f5f9", background:i%2===0?"#fff":"#fafafa" }}>
                    {/* Toggle status visual */}
                    <td style={{ padding:"10px 12px" }}>
                      <div style={{ width:36, height:20, borderRadius:10, background:isAtiva?"#22c55e":"#e2e8f0", position:"relative", cursor:"default" }}>
                        <div style={{ width:16, height:16, borderRadius:"50%", background:"#fff", position:"absolute", top:2, left:isAtiva?18:2, transition:"left .2s", boxShadow:"0 1px 3px rgba(0,0,0,.2)" }} />
                      </div>
                    </td>
                    <td style={{ padding:"10px 12px", minWidth:180 }}>
                      <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                        <button onClick={function(){ toggleCampanha(c.id); }}
                          style={{ background:"#f1f5f9", border:"none", color:"#64748b", width:22, height:22, borderRadius:5, cursor:"pointer", fontSize:12, flexShrink:0, display:"flex", alignItems:"center", justifyContent:"center" }}>
                          {expandedCamp[c.id] ? "▼" : "▶"}
                        </button>
                        <div>
                          <div style={{ fontSize:13, fontWeight:700, color:"#1d4ed8" }}>{c.name||c.nome||"Campanha #"+c.id}</div>
                          {c.type && <div style={{ fontSize:10, color:"#94a3b8", marginTop:2 }}>{c.type} · ID: {c.id}</div>}
                        </div>
                      </div>
                    </td>
                    <td style={{ padding:"10px 12px" }}>
                      <span style={{ fontSize:11, fontWeight:700, color:sCorText, background:sCorText+"18", padding:"3px 8px", borderRadius:6 }}>
                        {statusLabel(c.status)}
                      </span>
                    </td>
                    <td style={{ padding:"7px 10px", fontSize:11, color:"#334155", fontWeight:600 }}>
                      {c.daily_budget||c.dailyBudget ? fmtR(c.daily_budget||c.dailyBudget) : "—"}
                    </td>
                    <td style={{ padding:"7px 10px", fontSize:11, color:"#64748b" }}>
                      {roasObjN>0 ? roasObjN.toFixed(0)+"x" : "—"}
                    </td>
                    <td style={{ padding:"7px 10px", fontSize:12, fontWeight:700, color:"#0f172a" }}>
                      {vendas>0?fmtN(vendas):<span style={{color:"#94a3b8"}}>—</span>}
                    </td>
                    <td style={{ padding:"10px 12px" }}>
                      {gasto>0 ? (
                        <span style={{ fontSize:13, fontWeight:800, color:roas>=(roasObjN||10)?"#15803d":"#d97706" }}>
                          {roas.toFixed(2)}x
                        </span>
                      ) : <span style={{color:"#94a3b8",fontSize:11}}>—</span>}
                    </td>
                    <td style={{ padding:"7px 10px", fontSize:11, fontWeight:700, color:"#15803d" }}>
                      {receita>0?fmtR(receita):<span style={{color:"#94a3b8"}}>—</span>}
                    </td>
                    <td style={{ padding:"7px 10px", fontSize:11, color:"#dc2626", fontWeight:600 }}>
                      {gasto>0?fmtR(gasto):<span style={{color:"#94a3b8"}}>—</span>}
                    </td>
                    <td style={{ padding:"10px 12px" }}>
                      {gasto>0 ? (
                        <span style={{ fontSize:12, fontWeight:700,
                          color:acos<10?"#15803d":acos<20?"#d97706":"#dc2626",
                          background:(acos<10?"#f0fdf4":acos<20?"#fffbeb":"#fef2f2"),
                          padding:"3px 8px", borderRadius:6 }}>
                          {acos.toFixed(1)}%
                        </span>
                      ) : <span style={{color:"#94a3b8",fontSize:11}}>—</span>}
                    </td>
                    <td style={{ padding:"7px 10px", fontSize:11, color:"#334155" }}>
                      {cliques>0?fmtN(cliques):<span style={{color:"#94a3b8"}}>—</span>}
                    </td>
                    <td style={{ padding:"7px 10px", fontSize:11, color:"#64748b" }}>
                      {impressoes>0?fmtN(impressoes):<span style={{color:"#94a3b8"}}>—</span>}
                    </td>
                    <td style={{ padding:"7px 10px", fontSize:11, color:"#0891b2" }}>
                      {impressoes>0?ctr.toFixed(2)+"%":<span style={{color:"#94a3b8"}}>—</span>}
                    </td>
                    <td style={{ padding:"10px 12px" }}>
                      <a href={"https://publicidade.mercadolivre.com.br/campaigns/"+c.id} target="_blank" rel="noreferrer"
                        style={{ fontSize:11, color:"#0891b2", textDecoration:"none", fontWeight:600, whiteSpace:"nowrap" }}>
                        Ver no ML ↗
                      </a>
                    </td>
                  </tr>
                  {/* Linha expansível com anúncios da campanha */}
                  {expandedCamp[c.id] && (
                    <tr key={c.id+"_ads"}>
                      <td colSpan={14} style={{ background:"#f8fafc", padding:"0 0 0 48px", borderBottom:"2px solid #e2e8f0" }}>
                        {loadingAnuncios[c.id] ? (
                          <div style={{ padding:"14px", fontSize:12, color:"#94a3b8" }}>⏳ Carregando anúncios...</div>
                        ) : (anunciosCamp[c.id]||[]).length === 0 ? (
                          <div style={{ padding:"14px", fontSize:12, color:"#94a3b8" }}>Nenhum anúncio encontrado nesta campanha.</div>
                        ) : (
                          <table style={{ borderCollapse:"collapse", width:"100%", fontSize:11 }}>
                            <thead>
                              <tr style={{ background:"#f1f5f9" }}>
                                {["","Anúncio","Impressões","ROAS","Cliques","Custo/clique","Receita","Gasto","ACOS","Vendas"].map(function(h){
                                  return <th key={h} style={{ padding:"7px 10px", textAlign:"left", color:"#64748b", fontWeight:600, textTransform:"uppercase", fontSize:10 }}>{h}</th>;
                                })}
                              </tr>
                            </thead>
                            <tbody>
                              {(anunciosCamp[c.id]||[]).map(function(ad, ai) {
                                var am = ad.metrics || ad;
                                var aImpr = parseFloat(am.prints||am.impressions||0);
                                var aCliq = parseFloat(am.clicks||0);
                                var aVend = parseFloat(am.direct_items_quantity||0);
                                var aRec  = parseFloat(am.direct_amount||0);
                                var aGast = parseFloat(am.cost||0);
                                var aRoas = aGast>0 ? aRec/aGast : 0;
                                var aAcos = am.acos!=null ? parseFloat(am.acos) : (aRec>0?(aGast/aRec)*100:0);
                                var aCpc  = aCliq>0 ? aGast/aCliq : 0;
                                var thumb = ad.item?.thumbnail || ad.thumbnail;
                                var title = ad.item?.title || ad.title || ad.item_id || ("Anúncio #"+(ai+1));
                                var itemId = ad.item_id || ad.item?.id;
                                return (
                                  <tr key={ad.id||ai} style={{ borderBottom:"1px solid #f1f5f9", background:ai%2===0?"#fff":"#fafafa" }}>
                                    <td style={{ padding:"7px 10px", width:40 }}>
                                      {thumb && <img src={thumb} alt="" style={{ width:32, height:32, borderRadius:4, objectFit:"cover" }} />}
                                    </td>
                                    <td style={{ padding:"7px 10px", maxWidth:280, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                                      <div style={{ fontSize:12, fontWeight:600, color:"#0f172a" }}>{title}</div>
                                      {itemId && <div style={{ fontSize:10, color:"#94a3b8" }}>{itemId}</div>}
                                    </td>
                                    <td style={{ padding:"7px 10px" }}>{aImpr>0?fmtN(aImpr):"—"}</td>
                                    <td style={{ padding:"7px 10px", fontWeight:700, color:aRoas>0?(aRoas>=5?"#15803d":"#d97706"):"#94a3b8" }}>{aGast>0?aRoas.toFixed(2)+"x":"—"}</td>
                                    <td style={{ padding:"7px 10px" }}>{aCliq>0?fmtN(aCliq):"—"}</td>
                                    <td style={{ padding:"7px 10px" }}>{aCpc>0?"R$ "+aCpc.toFixed(2).replace(".",","):"—"}</td>
                                    <td style={{ padding:"7px 10px", color:"#15803d", fontWeight:600 }}>{aRec>0?fmtR(aRec):"—"}</td>
                                    <td style={{ padding:"7px 10px", color:"#dc2626" }}>{aGast>0?fmtR(aGast):"—"}</td>
                                    <td style={{ padding:"7px 10px" }}>
                                      {aGast>0 ? <span style={{ color:aAcos<10?"#15803d":aAcos<20?"#d97706":"#dc2626", fontWeight:700 }}>{aAcos.toFixed(1)}%</span> : "—"}
                                    </td>
                                    <td style={{ padding:"7px 10px", fontWeight:700 }}>{aVend>0?aVend:"—"}</td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        )}
                      </td>
                    </tr>
                  )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Link para criar campanha */}
      <div style={{ marginTop:16, textAlign:"center" }}>
        <a href="https://publicidade.mercadolivre.com.br" target="_blank" rel="noreferrer"
          style={{ fontSize:12, color:"#0891b2", textDecoration:"none" }}>
          Gerenciar campanhas no Mercado Livre ↗
        </a>
      </div>
    </div>
  );
}




// ════════════════════════════════════════════════════════════
//  CHAT INTERNO — Conversa entre usuários + Tarefas + Anexos
// ════════════════════════════════════════════════════════════
function getChatMensagens() {
  try { return JSON.parse(localStorage.getItem("chat_interno_mensagens")||"[]"); } catch { return []; }
}
function saveChatMensagens(msgs) {
  try { localStorage.setItem("chat_interno_mensagens", JSON.stringify(msgs)); } catch {}
}
function getTarefas() {
  try { return JSON.parse(localStorage.getItem("chat_interno_tarefas")||"[]"); } catch { return []; }
}
function saveTarefas(t) {
  try { localStorage.setItem("chat_interno_tarefas", JSON.stringify(t)); } catch {}
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

  var usuarios = getUsuarios().filter(function(u){ return u.ativo; });
  var naoLidas = mensagens.filter(function(m){ return !((m.lidoPor||[]).includes(currentUser?.id)) && m.autorId!==currentUser?.id; }).length;
  var tarefasMinhas = tarefas.filter(function(t){ return t.responsavelId===currentUser?.id && t.status!=="concluida"; }).length;

  useEffect(function(){
    if (open && bottomRef.current) bottomRef.current.scrollIntoView({ behavior:"smooth" });
  }, [mensagens, open, canalAtivo]);

  // Polling simples para simular tempo real entre abas/usuários (localStorage não dispara evento na mesma aba)
  useEffect(function(){
    var interval = setInterval(function(){
      var fresh = getChatMensagens();
      if (JSON.stringify(fresh) !== JSON.stringify(mensagens)) setMensagens(fresh);
      var freshT = getTarefas();
      if (JSON.stringify(freshT) !== JSON.stringify(tarefas)) setTarefas(freshT);
    }, 3000);
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
    var nova = {
      id: "msg_"+Date.now(),
      canal: canalAtivo,
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
      var assunto = encodeURIComponent("[ML Margem] Nova tarefa: "+form.titulo);
      var linhas = [
        "Ola "+responsavel.nome+",",
        "",
        "Voce recebeu uma nova tarefa no ML Margem:",
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
    // DM: aparece se o canal bate OU é uma DM entre os dois envolvidos
    var [, otherId] = canalAtivo.split(":");
    var dmKey1 = "dm:"+currentUser.id+":"+otherId;
    var dmKey2 = "dm:"+otherId+":"+currentUser.id;
    return m.canal === canalAtivo || m.canal === dmKey1 || m.canal === dmKey2;
  });

  return (
    <>
      {/* Botão flutuante */}
      <button onClick={function(){ setOpen(true); marcarComoLidas(); }}
        style={{ position:"fixed", bottom:20, right:20, width:56, height:56, borderRadius:"50%",
          background:"#0f172a", border:"none", color:"#ffe000", fontSize:24, cursor:"pointer",
          boxShadow:"0 6px 20px rgba(0,0,0,.25)", zIndex:500, display: open?"none":"flex",
          alignItems:"center", justifyContent:"center" }}>
        💬
        {(naoLidas>0||tarefasMinhas>0) && (
          <span style={{ position:"absolute", top:-4, right:-4, background:"#dc2626", color:"#fff",
            fontSize:11, fontWeight:700, borderRadius:10, minWidth:20, height:20, display:"flex",
            alignItems:"center", justifyContent:"center", padding:"0 5px" }}>
            {naoLidas+tarefasMinhas}
          </span>
        )}
      </button>

      {/* Painel do chat */}
      {open && (
        <div style={{ position:"fixed", bottom:20, right:20, width:420, height:560, background:"#fff",
          borderRadius:16, boxShadow:"0 12px 40px rgba(0,0,0,.25)", zIndex:500, display:"flex",
          flexDirection:"column", overflow:"hidden", border:"1px solid #e2e8f0" }}>

          {/* Header */}
          <div style={{ background:"#0f172a", padding:"12px 16px", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
            <div style={{ color:"#fff", fontWeight:700, fontSize:14 }}>💬 Chat da Equipe</div>
            <button onClick={function(){setOpen(false);}} style={{ background:"transparent", border:"none", color:"#94a3b8", fontSize:18, cursor:"pointer" }}>✕</button>
          </div>

          {/* Sub-abas */}
          <div style={{ display:"flex", borderBottom:"1px solid #e2e8f0" }}>
            {[{k:"conversa",l:"💬 Conversa"},{k:"tarefas",l:"✓ Tarefas"+(tarefasMinhas>0?" ("+tarefasMinhas+")":"")}].map(function(t){
              var a = aba===t.k;
              return <button key={t.k} onClick={function(){setAba(t.k);}}
                style={{ flex:1, padding:"9px", border:"none", borderBottom:a?"2px solid #0f172a":"2px solid transparent",
                  background:"transparent", color:a?"#0f172a":"#94a3b8", fontWeight:a?700:400, fontSize:12, cursor:"pointer", fontFamily:"inherit" }}>
                {t.l}
              </button>;
            })}
          </div>

          {aba === "conversa" ? (
            <>
              {/* Canais */}
              <div style={{ display:"flex", gap:4, padding:"8px 10px", borderBottom:"1px solid #f1f5f9", overflowX:"auto" }}>
                {canais.map(function(c){
                  var a = canalAtivo===c.k;
                  return <button key={c.k} onClick={function(){setCanalAtivo(c.k);}}
                    style={{ padding:"5px 10px", borderRadius:14, border:"1px solid "+(a?"#0f172a":"#e2e8f0"),
                      background:a?"#0f172a":"#fff", color:a?"#fff":"#64748b", fontSize:11, fontWeight:a?700:400, cursor:"pointer", whiteSpace:"nowrap" }}>
                    {c.icon} {c.l}
                  </button>;
                })}
              </div>

              {/* Mensagens */}
              <div style={{ flex:1, overflowY:"auto", padding:"10px 14px", display:"flex", flexDirection:"column", gap:8 }}>
                {msgsCanal.length===0 && (
                  <div style={{ textAlign:"center", color:"#94a3b8", fontSize:12, padding:30 }}>
                    Nenhuma mensagem ainda. Comece a conversa!
                  </div>
                )}
                {msgsCanal.map(function(m){
                  var isMe = m.autorId === currentUser.id;
                  return (
                    <div key={m.id} style={{ display:"flex", flexDirection:"column", alignItems:isMe?"flex-end":"flex-start" }}>
                      {!isMe && <div style={{ fontSize:10, color:"#94a3b8", marginBottom:2, marginLeft:4 }}>{m.autorNome}</div>}
                      <div style={{ maxWidth:"80%", background:isMe?"#0f172a":"#f1f5f9", color:isMe?"#fff":"#0f172a",
                        padding:"8px 12px", borderRadius:isMe?"12px 12px 4px 12px":"12px 12px 12px 4px", fontSize:13 }}>
                        {m.anexo && (
                          m.anexo.tipo?.startsWith("image/") ? (
                            <img src={m.anexo.data} alt={m.anexo.nome} style={{ maxWidth:200, borderRadius:8, marginBottom:m.texto?6:0, display:"block" }} />
                          ) : (
                            <a href={m.anexo.data} download={m.anexo.nome} style={{ display:"flex", alignItems:"center", gap:6, color:isMe?"#bfdbfe":"#1d4ed8", textDecoration:"none", marginBottom:m.texto?6:0 }}>
                              📎 {m.anexo.nome}
                            </a>
                          )
                        )}
                        {m.texto && <div style={{ whiteSpace:"pre-wrap" }}>{m.texto}</div>}
                      </div>
                      <div style={{ fontSize:9, color:"#cbd5e1", marginTop:2 }}>
                        {new Date(m.data).toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"})}
                      </div>
                    </div>
                  );
                })}
                <div ref={bottomRef} />
              </div>

              {/* Input */}
              <div style={{ display:"flex", gap:6, padding:"10px 12px", borderTop:"1px solid #e2e8f0" }}>
                <input type="file" ref={fileRef} style={{display:"none"}} onChange={handleFileChange} accept="image/*,.pdf,.doc,.docx,.xls,.xlsx" />
                <button onClick={function(){fileRef.current?.click();}}
                  style={{ background:"#f1f5f9", border:"none", color:"#64748b", width:36, height:36, borderRadius:9, cursor:"pointer", fontSize:16, flexShrink:0 }}>
                  📎
                </button>
                <input value={texto} onChange={function(e){setTexto(e.target.value);}} onKeyDown={handleKey} placeholder="Digite uma mensagem..."
                  style={{ flex:1, background:"#f8fafc", border:"1px solid #e2e8f0", color:"#0f172a", padding:"8px 12px", borderRadius:9, fontSize:13, outline:"none" }} />
                <button onClick={function(){enviarMensagem();}} disabled={!texto.trim()}
                  style={{ background:texto.trim()?"#0f172a":"#f1f5f9", border:"none", color:texto.trim()?"#fff":"#94a3b8", width:36, height:36, borderRadius:9, cursor:texto.trim()?"pointer":"not-allowed", fontSize:16, flexShrink:0 }}>
                  ➤
                </button>
              </div>
            </>
          ) : (
            <>
              {/* Tarefas */}
              <div style={{ flex:1, overflowY:"auto", padding:"12px 14px" }}>
                <button onClick={function(){setShowNovaTarefa(true);}}
                  style={{ width:"100%", background:"#0f172a", border:"none", color:"#fff", fontWeight:700, padding:"9px", borderRadius:9, cursor:"pointer", fontSize:12, marginBottom:12 }}>
                  + Nova Tarefa
                </button>
                {tarefas.length===0 && <div style={{ textAlign:"center", color:"#94a3b8", fontSize:12, padding:20 }}>Nenhuma tarefa criada</div>}
                {tarefas.slice().reverse().map(function(t){
                  var corPrior = t.prioridade==="alta"?"#dc2626":t.prioridade==="media"?"#d97706":"#15803d";
                  var concluida = t.status==="concluida";
                  return (
                    <div key={t.id} style={{ background:"#f8fafc", border:"1px solid #e2e8f0", borderRadius:10, padding:"10px 12px", marginBottom:8, opacity:concluida?0.6:1 }}>
                      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", gap:6 }}>
                        <div style={{ fontSize:13, fontWeight:700, color:"#0f172a", textDecoration:concluida?"line-through":"none" }}>{t.titulo}</div>
                        <span style={{ fontSize:9, fontWeight:700, color:corPrior, background:corPrior+"18", padding:"2px 6px", borderRadius:4, whiteSpace:"nowrap" }}>
                          {t.prioridade}
                        </span>
                      </div>
                      {t.descricao && <div style={{ fontSize:11, color:"#64748b", marginTop:3 }}>{t.descricao}</div>}
                      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginTop:6 }}>
                        <div style={{ fontSize:10, color:"#94a3b8" }}>
                          👤 {t.responsavelNome} {t.prazo && "· 📅 "+new Date(t.prazo).toLocaleDateString("pt-BR")}
                        </div>
                        {!concluida && t.responsavelId===currentUser.id && (
                          <button onClick={function(){mudarStatusTarefa(t.id,"concluida");}}
                            style={{ background:"#15803d", border:"none", color:"#fff", padding:"3px 9px", borderRadius:6, cursor:"pointer", fontSize:10, fontWeight:600 }}>
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
      <div style={{ background:"#fff", borderRadius:14, width:"100%", maxWidth:420, padding:20 }}>
        <div style={{ fontWeight:700, fontSize:15, color:"#0f172a", marginBottom:14 }}>+ Nova Tarefa</div>
        <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
          <input value={titulo} onChange={function(e){setTitulo(e.target.value);}} placeholder="Título da tarefa"
            style={{ background:"#f8fafc", border:"1px solid #e2e8f0", color:"#0f172a", padding:"9px 12px", borderRadius:8, fontSize:13, outline:"none" }} />
          <textarea value={descricao} onChange={function(e){setDescricao(e.target.value);}} placeholder="Descrição (opcional)" rows={3}
            style={{ background:"#f8fafc", border:"1px solid #e2e8f0", color:"#0f172a", padding:"9px 12px", borderRadius:8, fontSize:13, outline:"none", resize:"none", fontFamily:"inherit" }} />
          <select value={responsavelId} onChange={function(e){setResponsavelId(e.target.value);}}
            style={{ background:"#f8fafc", border:"1px solid #e2e8f0", color:"#334155", padding:"9px 12px", borderRadius:8, fontSize:13 }}>
            {usuarios.map(function(u){ return <option key={u.id} value={u.id}>{u.nome}</option>; })}
          </select>
          <div style={{ display:"flex", gap:8 }}>
            <input type="date" value={prazo} onChange={function(e){setPrazo(e.target.value);}}
              style={{ flex:1, background:"#f8fafc", border:"1px solid #e2e8f0", color:"#334155", padding:"9px 12px", borderRadius:8, fontSize:13 }} />
            <select value={prioridade} onChange={function(e){setPrioridade(e.target.value);}}
              style={{ flex:1, background:"#f8fafc", border:"1px solid #e2e8f0", color:"#334155", padding:"9px 12px", borderRadius:8, fontSize:13 }}>
              <option value="baixa">Baixa</option>
              <option value="media">Média</option>
              <option value="alta">Alta</option>
            </select>
          </div>
        </div>
        <div style={{ display:"flex", gap:8, marginTop:16 }}>
          <button onClick={onClose} style={{ flex:1, background:"#f8fafc", border:"1px solid #e2e8f0", color:"#64748b", fontWeight:600, padding:"10px", borderRadius:9, cursor:"pointer" }}>Cancelar</button>
          <button onClick={function(){ if(titulo.trim()) onSave({titulo,descricao,responsavelId,prazo,prioridade}); }}
            disabled={!titulo.trim()}
            style={{ flex:2, background:titulo.trim()?"#0f172a":"#f1f5f9", border:"none", color:titulo.trim()?"#fff":"#94a3b8", fontWeight:700, padding:"10px", borderRadius:9, cursor:titulo.trim()?"pointer":"not-allowed" }}>
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

  var [aba, setAba] = useState(abaInicial||"config");
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
    {k:"config",    l:"Impostos & Custos"},
    {k:"aparencia", l:"Aparencia"},
    {k:"backup",    l:"Backup"},
    {k:"usuarios",  l:"Usuarios"},
  ];

  return (
    React.createElement("div", {style:{position:"fixed",inset:0,background:"rgba(15,23,42,.55)",backdropFilter:"blur(4px)",zIndex:800,display:"flex",alignItems:"flex-start",justifyContent:"flex-end",padding:"56px 8px 8px"}},
      React.createElement("div", {style:{background:"#fff",borderRadius:14,width:700,maxHeight:"calc(100vh - 68px)",display:"flex",flexDirection:"column",boxShadow:"0 20px 60px rgba(0,0,0,.22)",overflow:"hidden"}},
        React.createElement("div", {style:{background:"#0f172a",padding:"13px 18px",display:"flex",justifyContent:"space-between",alignItems:"center"}},
          React.createElement("div", {style:{color:"#fff",fontWeight:700,fontSize:15}}, "Configuracoes do Sistema"),
          React.createElement("button", {onClick:onClose, style:{background:"transparent",border:"none",color:"#94a3b8",fontSize:20,cursor:"pointer",lineHeight:1}}, "x")
        ),
        React.createElement("div", {style:{display:"flex",borderBottom:"2px solid #f1f5f9"}},
          ABAS.map(function(t){
            var a=aba===t.k;
            return React.createElement("button",{key:t.k,onClick:function(){setAba(t.k);},style:{flex:1,padding:"10px",border:"none",borderBottom:a?"2px solid #0f172a":"2px solid transparent",background:"transparent",color:a?"#0f172a":"#94a3b8",fontWeight:a?700:400,fontSize:12,cursor:"pointer",fontFamily:"inherit",marginBottom:-2}}, t.l);
          })
        ),
        React.createElement("div", {style:{flex:1,overflowY:"auto",padding:"16px 18px"}},
          aba==="config" ? React.createElement(ImpostosCompacto, {impostos:impostos,setImpostos:setImpostos,custosFixos:custosFixos,setCustosFixos:setCustosFixos,faturamentoMes:faturamentoMes,irpjCsllConfig:irpjCsllConfig,setIrpjCsllConfig:setIrpjCsllConfig}) :
          aba==="aparencia" ? React.createElement("div", {style:{display:"flex",gap:10}},
            [{v:false,l:"Claro"},{v:true,l:"Escuro"}].map(function(t){
              return React.createElement("button",{key:String(t.v),onClick:function(){setDarkMode(t.v);localStorage.setItem("darkMode",t.v?"1":"0");},style:{flex:1,padding:14,borderRadius:10,border:"2px solid "+(darkMode===t.v?"#0f172a":"#e2e8f0"),background:darkMode===t.v?"#0f172a":"#fff",color:darkMode===t.v?"#fff":"#334155",fontWeight:700,fontSize:14,cursor:"pointer"}}, t.v?"Escuro":"Claro");
            })
          ) :
          aba==="backup" ? React.createElement("div", {style:{display:"flex",flexDirection:"column",gap:14}},
            React.createElement("div", {style:{background:"#f8fafc",border:"1px solid #e2e8f0",borderRadius:12,padding:16}},
              React.createElement("div", {style:{fontWeight:700,fontSize:14,marginBottom:12}}, "Exportar Backup"),
              React.createElement("button", {
                onClick:function(){
                  var chaves=["produtos_cadastro","mov_estoque","vendas_estoque_baixadas","ml_orders_cache","contas_pagar","contas_bancarias","lancamentos","nfe_entrada","nfe_saida","costs_config","fretes_config","descontos_config","precos_venda_config","precos_pendentes_ml","icms_por_estado","irpj_csll_config","fornecedores_db","chat_interno_mensagens","chat_interno_tarefas","min_stock_anuncios","depositos_estoque"];
                  var bk={versao:2,data:new Date().toISOString(),dados:{}};
                  chaves.forEach(function(k){try{bk.dados[k]=JSON.parse(localStorage.getItem(k)||"null");}catch{}});
                  var blob=new Blob([JSON.stringify(bk,null,2)],{type:"application/json"});
                  var a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="mlmargem_backup_"+new Date().toLocaleDateString("sv-SE")+".json";a.click();
                },
                style:{background:"#0f172a",border:"none",color:"#fff",fontWeight:700,padding:"10px 20px",borderRadius:9,cursor:"pointer",fontSize:13}
              }, "Exportar Backup")
            ),
            React.createElement("div", {style:{background:"#f8fafc",border:"1px solid #e2e8f0",borderRadius:12,padding:16}},
              React.createElement("div", {style:{fontWeight:700,fontSize:14,marginBottom:4}}, "Restaurar Backup"),
              React.createElement("label", {style:{background:"#fff",border:"2px dashed #e2e8f0",borderRadius:9,padding:14,display:"block",textAlign:"center",cursor:"pointer",fontSize:13,color:"#64748b"}},
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
              return React.createElement("div",{key:u.id,style:{background:"#f8fafc",border:"1px solid #e2e8f0",borderRadius:10,padding:"10px 14px",marginBottom:8,display:"flex",alignItems:"center",gap:10}},
                React.createElement("div",{style:{width:36,height:36,borderRadius:9,background:"#0f172a",display:"flex",alignItems:"center",justifyContent:"center",fontSize:13,fontWeight:800,color:"#ffe000",flexShrink:0}}, u.nome&&u.nome.charAt(0).toUpperCase()),
                React.createElement("div",{style:{flex:1,minWidth:0}},
                  React.createElement("div",{style:{fontWeight:700,fontSize:13,color:"#0f172a"}}, u.nome, isMe&&React.createElement("span",{style:{fontSize:10,color:"#0891b2",background:"#eff6ff",padding:"1px 5px",borderRadius:4,marginLeft:6}},"voce")),
                  React.createElement("div",{style:{fontSize:11,color:"#64748b"}}, "@"+u.usuario+" - "+(u.admin?"Admin":"Usuario")+" - ",React.createElement("span",{style:{color:u.ativo?"#15803d":"#dc2626",fontWeight:600}},u.ativo?"Ativo":"Inativo")),
                  u.email&&React.createElement("div",{style:{fontSize:10,color:"#94a3b8",marginTop:1}}, u.email)
                ),
                React.createElement("div",{style:{display:"flex",gap:6}},
                  React.createElement("button",{onClick:function(){setEditingUser(u);setShowModalUser(true);},style:{background:"#eff6ff",border:"1px solid #bfdbfe",color:"#1d4ed8",padding:"4px 10px",borderRadius:7,cursor:"pointer",fontSize:11,fontWeight:600}},"Editar"),
                  !isMe&&React.createElement("button",{onClick:function(){deleteUser(u.id);},style:{background:"#fef2f2",border:"1px solid #fecaca",color:"#dc2626",padding:"4px 8px",borderRadius:7,cursor:"pointer",fontSize:11}},"X")
                )
              );
            }),
            React.createElement("button",{onClick:function(){setEditingUser(null);setShowModalUser(true);},style:{width:"100%",background:"#0f172a",border:"none",color:"#fff",fontWeight:700,padding:10,borderRadius:9,cursor:"pointer",fontSize:13,marginTop:8}},
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
    return "overview";
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
              // Renovar se quase expirando
              if (session.almostExpired) {
                fetch("/api/auth/refresh", { method: "POST" })
                  .then(function(r){ return r.json(); })
                  .then(function(d){
                    var tk = d.access_token || session.accessToken;
                    handleConnect(tk, session.userId);
                  }).catch(function(){ handleConnect(session.accessToken, session.userId); });
              } else {
                handleConnect(session.accessToken, session.userId);
              }
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
  function setFretesAndSave(updater) {
    setFretesConfig(function(prev) {
      var next = typeof updater === "function" ? updater(prev) : updater;
      try { localStorage.setItem("fretes_config", JSON.stringify(next)); } catch {}
      return next;
    });
  }
  function setCostsAndSave(updater) {
    setCosts(function(prev) {
      var next = typeof updater === "function" ? updater(prev) : updater;
      try { localStorage.setItem("costs_config", JSON.stringify(next)); } catch {}
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

  // Sincroniza usuários do servidor ao iniciar (garante que todos os dispositivos veem os mesmos usuários)
  useEffect(function(){
    sincronizarUsuariosDoServidor();
  }, []);
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
    try { return JSON.parse(localStorage.getItem("ml_notificacoes") || "[]"); } catch { return []; }
  });
  const [ultimosPedidosIds, setUltimosPedidosIds] = useState(() => {
    try { return JSON.parse(localStorage.getItem("ml_ultimos_pedidos") || "[]"); } catch { return []; }
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
    try { return JSON.parse(localStorage.getItem("fornecedores_cadastro") || "[]"); } catch { return []; }
  });
  const [nfeSaida, setNfeSaida] = useState({});          // orderId -> dados da NF
  const [loadingNfe, setLoadingNfe] = useState(false);
  const [notasFiscais, setNotasFiscais] = useState(() => {
    try { return JSON.parse(localStorage.getItem("notas_fiscais_entrada") || "[]"); } catch { return []; }
  });
  const [paymentData, setPaymentData] = useState({}); // orderId → { releaseDate, netAmount }
  const [loadError, setLoadError] = useState(null);

  const usingMock = !token || realListings.length === 0;


  // ── Baixa automática de estoque por venda ──────────────────
  function baixarEstoqueVendas(orders, produtosAtuais, movimentosAtuais, baixadasAtuais) {
    var novasBaixadas = new Set(baixadasAtuais);
    var produtosUpd = produtosAtuais.slice();
    var movsUpd = movimentosAtuais.slice();
    var qtdBaixadas = 0;

    // Montar mapa rápido MLB → produto para lookup eficiente
    var mapMlb = {};
    var mapSku = {};
    produtosUpd.forEach(function(p) {
      if (p.mlbVinculado) mapMlb[p.mlbVinculado] = p;
      // Use unique MLBs only
      var uniqueMlbs = (p.mlbsVinculados||[]).filter(function(m,i,a){ return a.indexOf(m)===i; });
      uniqueMlbs.forEach(function(m) { mapMlb[m] = p; });
      if (p.sku) mapSku[p.sku.trim().toLowerCase()] = p;
    });

    // PASSO 0: Corrigir movimentações "semProduto" que agora têm produto cadastrado
    var movsCorrigidas = 0;
    movsUpd = movsUpd.map(function(m) {
      if (!m.semProduto) return m;
      var prod = (m.mlbId && mapMlb[m.mlbId]) ||
                 (m.sku && mapSku[m.sku.trim().toLowerCase()]) || null;
      if (!prod) return m;
      movsCorrigidas++;
      return Object.assign({}, m, { produtoId: prod.id, sku: prod.sku, semProduto: false });
    });
    if (movsCorrigidas > 0) console.log("[ESTOQUE] " + movsCorrigidas + " movimentações corrigidas com produto.");

    orders.filter(function(o) {
      return o.status === "paid" && !novasBaixadas.has(String(o.id));
    }).forEach(function(o) {
      var listingId = o.listing_id;

      // 1. Tentar achar pelo listing_id (MLB)
      var prod = listingId ? mapMlb[listingId] : null;

      // 2. Fallback: buscar pelo SKU do pedido (seller_sku)
      if (!prod && o.seller_sku) {
        prod = mapSku[o.seller_sku.trim().toLowerCase()];
      }

      // 3. Fallback: buscar pelo título parcial
      if (!prod && o.title && o.title.length > 10) {
        var titleLower = o.title.toLowerCase();
        prod = produtosUpd.find(function(p) {
          return p.titulo && p.titulo.toLowerCase().includes(titleLower.slice(0, 30));
        });
      }

      if (!prod) {
        // Produto não cadastrado — registra movimentação sem vínculo mas com MLB
        // para que o usuário saiba que aquela venda saiu sem produto vinculado
        if (listingId) {
          movsUpd.push({
            id: "venda_" + o.id,
            produtoId: null,
            mlbId: listingId,
            sku: o.seller_sku || "",
            tipo: "saida",
            qtd: parseInt(o.qty || 1),
            motivo: "Venda ML #" + o.id + " (" + (o.title||"").slice(0,35) + ") — sem produto cadastrado",
            pedidoId: String(o.id),
            data: o.date || new Date().toLocaleDateString("sv-SE"),
            hora: "—",
            automatico: true,
            semProduto: true,
          });
          novasBaixadas.add(String(o.id));
        }
        return;
      }

      var qty = parseInt(o.qty || 1);
      var estoqueAtual = parseInt(prod.estoqueAtual || 0);
      var novoEstoque = Math.max(0, estoqueAtual - qty);

      // Atualizar produto no array
      var idx = produtosUpd.findIndex(function(p){ return p.id === prod.id; });
      if (idx >= 0) {
        produtosUpd[idx] = Object.assign({}, prod, { estoqueAtual: String(novoEstoque) });
        // Atualizar mapa para próximas iterações
        if (prod.mlbVinculado) mapMlb[prod.mlbVinculado] = produtosUpd[idx];
        (prod.mlbsVinculados || []).forEach(function(m) { mapMlb[m] = produtosUpd[idx]; });
      }

      // Registrar movimentação
      movsUpd.push({
        id: "venda_" + o.id,
        produtoId: prod.id,
        mlbId: listingId,
        sku: prod.sku || o.seller_sku || "",
        tipo: "saida",
        qtd: qty,
        motivo: "Venda ML #" + o.id + (o.title ? " — " + o.title.slice(0,40) : ""),
        pedidoId: String(o.id),
        data: o.date || new Date().toLocaleDateString("sv-SE"),
        hora: new Date().toLocaleTimeString("pt-BR", {hour:"2-digit", minute:"2-digit"}),
        automatico: true,
      });

      novasBaixadas.add(String(o.id));
      qtdBaixadas++;
    });

    if (qtdBaixadas > 0 || movsUpd.length > movimentosAtuais.length) {
      localStorage.setItem("produtos_cadastro", JSON.stringify(produtosUpd));
      localStorage.setItem("mov_estoque", JSON.stringify(movsUpd));
      localStorage.setItem("vendas_estoque_baixadas", JSON.stringify([...novasBaixadas]));
      setProdutos(produtosUpd);
      setMovEstoque(movsUpd);          // ← CRÍTICO: atualiza estado do React
      setVendasBaixadas(novasBaixadas);
      console.log("[ESTOQUE] " + qtdBaixadas + " baixa(s). Total movs: " + movsUpd.length);
    }
    return qtdBaixadas;
  }

  // ── Ref para baixarEstoqueVendas (evita TDZ em useEffect) ──
  var baixarEstoqueRef = useRef(null);
  baixarEstoqueRef.current = baixarEstoqueVendas;

  // ── Auto-baixa quando realOrders muda (novas vendas chegam ao reconectar) ──
  useEffect(function() {
    if (!realOrders || realOrders.length === 0) return;
    if (!produtos || produtos.length === 0) return;
    var timer = setTimeout(function() {
      try {
        var pedidosPagos = realOrders.filter(function(o){ return o.status === "paid"; });
        var baixAtual = new Set(JSON.parse(localStorage.getItem("vendas_estoque_baixadas") || "[]"));
        var novas = pedidosPagos.filter(function(o){ return !baixAtual.has(String(o.id)); });
        var temSemProduto = movEstoque.some(function(m){ return m.semProduto; });
        if (novas.length > 0 || temSemProduto) {
          console.log("[ESTOQUE] " + novas.length + " venda(s) nova(s) para baixar");
          if (baixarEstoqueRef.current) {
            // Usa produtos e movEstoque do estado React (sempre atualizados)
            baixarEstoqueRef.current(pedidosPagos, produtos, movEstoque, baixAtual);
          }
        }
      } catch(e) { console.warn("[ESTOQUE] Auto-baixa:", e); }
    }, 800);
    return function() { clearTimeout(timer); };
  }, [realOrders, produtos]);

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

      setLoadingMsg("Buscando pedidos...");
      const orders = await fetchAllOrders(me.id, validTk);
      setRealOrders(orders);
      // Salvar pedidos no localStorage para uso offline pelo Reprocessar Vendas
      try {
        var ordersLeve = orders.map(function(o){
          return { id:o.id, listing_id:o.listing_id, status:o.status, qty:o.qty||1, price:o.price, date:o.date, title:o.title, seller_sku:o.seller_sku||"" };
        });
        localStorage.setItem("ml_orders_cache", JSON.stringify(ordersLeve));
      } catch(e) {}
      // Baixa automática de estoque para pedidos pagos
      // (o useEffect vai cuidar disso quando realOrders mudar)
      // Aqui só garantimos que realOrders foi atualizado
      console.log("[ESTOQUE] " + orders.filter(function(o){return o.status==="paid";}).length + " pedidos pagos carregados para processamento.");

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
      setLoadingMsg("Buscando frete dos pedidos...");
      const { shippingMap: orderShippingMap, statusMap: shipmentStatusMap } = await fetchShippingForOrders(orders, validTk, function(partialShipping, partialStatus, done, total) {
        setShipmentCosts({...partialShipping});
        setLoadingMsg(`Buscando frete dos pedidos... ${done}/${total}`);
      });
      setShipmentCosts({...orderShippingMap});
      setShipmentStatuses({...shipmentStatusMap});

      // Buscar dados de pagamento usando /orders/{id} com campo completo de payment
      // Isso retorna os dados reais de valor líquido e data de liberação
      setLoadingMsg("Buscando dados de pagamento...");
      const paymentMap = await fetchPaymentForOrders(orders, validTk, function(partial, done, total) {
        setPaymentData({...partial});
        setLoadingMsg(`Buscando dados de pagamento... ${done}/${total}`);
      });
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
    const ordersParaNotif = (typeof orders !== "undefined" && Array.isArray(orders)) ? orders : [];
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
    const ordersForNotif = (typeof orders !== "undefined" ? orders : []);
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

  // Dispara a atualização automática a cada 3 minutos, sozinha, sem precisar de nenhum clique.
  useEffect(function(){
    if (!token) return;
    var intervalId = setInterval(function(){ refreshOrdersIncrementalRef.current(); }, 180000); // 3 minutos
    return function(){ clearInterval(intervalId); };
  }, [token]);

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
    if (filterListingExtra === "sem_custo")  results = results.filter(l => !(costs[l.id] > 0));
    if (filterListingExtra === "com_promo")  results = results.filter(l => l.hasPromo);
    if (filterListingExtra === "sem_promo")  results = results.filter(l => !l.hasPromo);
    if (filterListingExtra === "sem_atacado") {
      // Anúncios sem preço de atacado preenchido
      // ML armazena em wholesale_prices[] ou como tag "wholesale"
      results = results.filter(function(l) {
        var hasWholesale =
          (l.wholesale_prices && l.wholesale_prices.length > 0 && l.wholesale_prices.some(function(w){ return w.price > 0; })) ||
          (l.sale_conditions && l.sale_conditions.available_conditions && l.sale_conditions.available_conditions.includes("1")) ||
          (l.tags && l.tags.some(function(t){ return String(t).toLowerCase().includes("wholesale"); }));
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
  }, [enriched, searchListings, searchType, statusFilter, filterListingExtra, costs]);

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
    const feeRate = listing ? getRealFeeRate(listing) : 0.12;
    // Frete: usa shipmentCosts[order_id] calculado como base_cost - buyer_paid
    const freteSeller = shipmentCosts[String(o.id)]
      ?? shippingData[o.listing_id]
      ?? shippingData[listing?.id]
      ?? 0;
    return { ...o, listing, ...calcMargin(o.price, cost, feeRate, freteSeller), cost, freteSeller };
  })

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
    <div className={darkMode?"dark":""} style={{ minHeight:"100vh", background:darkMode?"#0c1120":"#f1f5f9", color:darkMode?"#e2e8f0":"#0f172a", fontFamily:"'DM Sans',system-ui,sans-serif", transition:"background .2s,color .2s" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700;0,9..40,800;1,9..40,400&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        body,#root{font-family:'DM Sans',system-ui,sans-serif}
        ::-webkit-scrollbar{width:4px;height:4px}
        ::-webkit-scrollbar-track{background:transparent}
        ::-webkit-scrollbar-thumb{background:#cbd5e1;border-radius:99px}
        ::-webkit-scrollbar-thumb:hover{background:#94a3b8}
        input:focus,textarea:focus,select:focus{outline:2px solid #0f172a;outline-offset:1px}

        /* ── TABELAS ── */
        table{border-collapse:collapse;width:100%}
        th{font-size:11px;color:#94a3b8;text-transform:uppercase;letter-spacing:0.8px;padding:10px 14px;border-bottom:1px solid #f1f5f9;text-align:left;font-weight:600;background:#fafafa;white-space:nowrap}
        td{padding:10px 14px;font-size:13px;border-bottom:1px solid #f1f5f9;vertical-align:middle;color:#334155}
        tr:last-child td{border-bottom:none}
        tbody tr:hover td{background:#f8fafc;transition:background .1s}
        .dark th{background:#1e293b!important;border-bottom-color:#334155!important;color:#64748b!important}
        .dark td{border-bottom-color:#1e293b!important;color:#cbd5e1!important}
        .dark tbody tr:hover td{background:#1e293b!important}

        /* ── FILTRO PERIOD ── */
        .filter-btn{background:#fff;border:1px solid #e2e8f0;color:#64748b;padding:5px 14px;cursor:pointer;font-family:inherit;font-size:12px;border-radius:20px;transition:all .15s;font-weight:500}
        .filter-btn.active{background:#0f172a;border-color:#0f172a;color:#fff;font-weight:600}
        .filter-btn:hover:not(.active){background:#f8fafc;border-color:#cbd5e1}
        .dark .filter-btn{background:#1e293b;border-color:#334155;color:#94a3b8}
        .dark .filter-btn.active{background:#e2e8f0;color:#0f172a}

        /* ── SUB-ABAS (Financeiro, etc) ── */
        .tab-btn{background:transparent;border:none;border-bottom:2px solid transparent;color:#94a3b8;padding:14px 18px;cursor:pointer;font-family:inherit;font-size:13px;transition:all .15s;font-weight:500;border-radius:0}
        .tab-btn.active{color:#0f172a;border-bottom-color:#0f172a;font-weight:600}
        .tab-btn:hover:not(.active){color:#64748b;background:#f8fafc}
        .dark .tab-btn{color:#64748b}
        .dark .tab-btn.active{color:#e2e8f0;border-bottom-color:#e2e8f0}

        /* ── INPUTS ── */
        .search-input{width:100%;background:#fff;border:1px solid #e2e8f0;color:#0f172a;padding:8px 14px 8px 38px;border-radius:8px;font-family:inherit;font-size:13px;outline:none;transition:border .15s}
        .search-input:focus{border-color:#0f172a;box-shadow:0 0 0 3px rgba(15,23,42,.06)}
        .dark input{background:#1e293b!important;border-color:#334155!important;color:#e2e8f0!important}
        .dark select{background:#1e293b;border-color:#334155;color:#e2e8f0}

        /* ── MISC ── */
        .copy-btn{background:transparent;border:none;color:#cbd5e1;cursor:pointer;padding:2px 5px;border-radius:4px;font-size:11px;transition:all .15s}
        .copy-btn:hover{background:#f1f5f9;color:#475569}
        .title-link{color:#2563eb;text-decoration:none;font-weight:500;transition:color .15s}
        .title-link:hover{color:#1d4ed8;text-decoration:underline}
        select{background:#fff;border:1px solid #e2e8f0;color:#334155;padding:7px 12px;border-radius:8px;font-family:inherit;font-size:13px;cursor:pointer;font-weight:400}

        /* ── CARDS ── */
        .sl-card{background:#fff;border:1px solid #e2e8f0;border-radius:12px;box-shadow:0 1px 3px rgba(15,23,42,.04)}

        /* ── ANIMAÇÕES ── */
        @keyframes fadeUp{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
        .fade-up{animation:fadeUp .25s ease forwards}
        @keyframes slPulse{0%,100%{opacity:1}50%{opacity:.4}}
      `}</style>

      <header style={{ background:darkMode?"#111827":"#fff", borderBottom:`1px solid ${darkMode?"#1f2937":"#e2e8f0"}`, padding:"0 32px", display:"flex", alignItems:"center", position:"sticky", top:0, zIndex:100, boxShadow:"0 1px 2px rgba(15,23,42,.06)", minHeight:62 }}>
        {/* Logo + divisor + Abas */}
        <div style={{ display:"flex", alignItems:"stretch", flex:1, minWidth:0, overflow:"hidden", height:50 }}>
          {/* Logo */}
          <div style={{ display:"flex", alignItems:"center", gap:7, paddingRight:28, marginRight:4, borderRight:`1px solid ${darkMode?"#1f2937":"#f1f5f9"}`, flexShrink:0 }}>
            <div style={{ width:34, height:34, borderRadius:9, background:"#0f172a", display:"flex", alignItems:"center", justifyContent:"center", fontWeight:800, fontSize:15, color:"#fbbf24", letterSpacing:-0.5 }}>M</div>
            <div>
              <div style={{ fontWeight:700, fontSize:14, color:darkMode?"#f1f5f9":"#0f172a", letterSpacing:-0.4, lineHeight:1.2 }}>ML Margem</div>
              <div style={{ fontSize:9, color:"#94a3b8", letterSpacing:1.2, textTransform:"uppercase", lineHeight:1 }}>Lucratividade</div>
            </div>
          </div>
          {/* Abas de navegação no header */}
          <div style={{ display:"flex", gap:0, alignItems:"stretch", overflowX:"auto", msOverflowStyle:"none", scrollbarWidth:"none" }}>
            {(function() {
              var navTabs = [
                currentUser?.permissoes?.includes("overview")   && { key:"overview",   label:"Visão Geral", badge:null },
                currentUser?.permissoes?.includes("listings")   && { key:"listings",   label:"Anúncios",    badge:enriched.length },
                currentUser?.permissoes?.includes("orders")     && { key:"orders",     label:"Pedidos",     badge:enrichedOrders.length },
                currentUser?.permissoes?.includes("financeiro") && { key:"financeiro", label:"Financeiro",  badge:null },

                currentUser?.permissoes?.includes("produtos")   && { key:"produtos",   label:"Produtos",    badge:null },
                currentUser?.permissoes?.includes("produtos")   && { key:"nf",         label:"NF Entrada",  badge:null },
                currentUser?.permissoes?.includes("orders")     && { key:"nfe_saida",  label:"NF Saída",    badge:null },

                currentUser?.permissoes?.includes("listings")   && { key:"precificacao",  label:"💲 Precificação", badge:null },

                                                                   { key:"ia_chat",       label:"✦ Assistente IA", badge:null },
              ].filter(Boolean);
              return navTabs.map(function(t) {
                var isActive = tab === t.key;
                return (
                  <div key={t.key} style={{ display:"flex", alignItems:"stretch", position:"relative" }}
                    onMouseEnter={function(e){ e.currentTarget.querySelector(".open-tab-btn").style.opacity="1"; }}
                    onMouseLeave={function(e){ e.currentTarget.querySelector(".open-tab-btn").style.opacity="0"; }}>
                    <button onClick={function(){ setTab(t.key); }}
                      style={{ display:"flex", alignItems:"center", gap:6, padding:"0 16px", height:50, background:"transparent", border:"none",
                        borderBottom: isActive ? "2px solid #0f172a" : "2px solid transparent",
                        color: isActive ? (darkMode?"#f1f5f9":"#0f172a") : "#94a3b8",
                        fontWeight: isActive ? 600 : 400, fontSize:13, cursor:"pointer",
                        fontFamily:"inherit", whiteSpace:"nowrap", transition:"color .15s,border-color .15s",
                        borderTop: "2px solid transparent" }}>
                      {t.label}
                      {t.badge !== null && (
                        <span style={{ fontSize:10, fontWeight:600, padding:"1px 6px", borderRadius:10,
                          background: isActive ? "#0f172a" : "#f1f5f9",
                          color: isActive ? "#fff" : "#94a3b8", lineHeight:1.6 }}>
                          {t.badge}
                        </span>
                      )}
                    </button>
                    {/* Botão abrir em nova guia — aparece no hover */}
                    <button className="open-tab-btn"
                      title={"Abrir " + t.label + " em nova guia"}
                      onClick={function(e){
                        e.stopPropagation();
                        window.open(window.location.pathname + "?tab=" + t.key, "_blank");
                      }}
                      style={{ opacity:0, position:"absolute", top:8, right:2, width:18, height:18,
                        borderRadius:4, border:"1px solid #e2e8f0", background:"#fff",
                        color:"#94a3b8", cursor:"pointer", fontSize:9, display:"flex", alignItems:"center",
                        justifyContent:"center", transition:"opacity .15s", zIndex:10 }}
                      onMouseEnter={function(e){ e.currentTarget.style.background="#eff6ff"; e.currentTarget.style.color="#2563eb"; e.currentTarget.style.borderColor="#bfdbfe"; }}
                      onMouseLeave={function(e){ e.currentTarget.style.background="#fff"; e.currentTarget.style.color="#94a3b8"; e.currentTarget.style.borderColor="#e2e8f0"; }}>
                      ↗
                    </button>
                  </div>
                );
              });
            })()}
          </div>
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:7, flexShrink:0, paddingLeft:16, borderLeft:`1px solid ${darkMode?"#1f2937":"#f1f5f9"}` }}>
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
          {token && (
            <button onClick={function(){ refreshOrdersIncrementalRef.current(); }} disabled={autoRefreshingRef.current}
              title="Busca pedidos novos e atualiza os dados sem recarregar tudo"
              style={{ background: "#f8fafc", border: "1px solid #e2e8f0", color: "#334155", fontWeight: 600, padding: "8px 14px", borderRadius: 8, cursor: "pointer", fontSize: 13, display:"flex", alignItems:"center", gap:5 }}>
              🔄 Atualizar
            </button>
          )}
          <button onClick={function(){ window.location.href = "/api/auth/login"; }}
            style={{ background: "#0f172a", border: "none", color: "#fff", fontWeight: 700, padding: "8px 20px", borderRadius: 8, cursor: "pointer", fontSize: 13 }}>
            {token ? "Reconectar" : "Conectar ML"}
          </button>
          <SinoNotificacoes
            notificacoes={notificacoes}
            setNotificacoes={setNotificacoes}
            darkMode={darkMode}
          />
          <div style={{ display:"flex", alignItems:"center", gap:6, background:"#f8fafc", border:"1px solid #e2e8f0", borderRadius:8, padding:"5px 10px" }}>
            <div style={{ width:26, height:26, borderRadius:8, background:"#0f172a", display:"flex", alignItems:"center", justifyContent:"center", fontSize:12, fontWeight:800, color:"#ffe000" }}>
              {currentUser?.nome?.charAt(0).toUpperCase()}
            </div>
            <div style={{ fontSize:12, lineHeight:1.3 }}>
              <div style={{ fontWeight:600, color:"#0f172a" }}>{currentUser?.nome}</div>
              <div style={{ color:"#94a3b8", fontSize:10 }}>{currentUser?.admin?"Admin":"Usuário"}</div>
            </div>
          </div>
          <button onClick={function(){ setShowConfigPanel(true); setConfigPanelTab("config"); }}
            style={{ background:"#f8fafc", border:"1px solid #e2e8f0", color:"#334155", fontWeight:600, padding:"7px 14px", borderRadius:8, cursor:"pointer", fontSize:12 }}>
            ⚙️ Config
          </button>
          <button onClick={() => { clearSession(); clearSavedTokens(); setCurrentUser(null); setToken(null); setUser(null); }}
            style={{ background:"#fef2f2", border:"1px solid #fecaca", color:"#dc2626", fontWeight:600, padding:"7px 14px", borderRadius:8, cursor:"pointer", fontSize:12 }}>
            Sair
          </button>
        </div>
      </header>

      <main style={{ maxWidth: "100%", padding: "12px 20px" }}>
        {/* ── FILTRO DE PERÍODO e CARDS — apenas em Visão Geral, Anúncios e Pedidos ── */}
        {(tab === "overview" || tab === "listings" || tab === "orders") && <div style={{ display:"flex", gap:6, alignItems:"center", marginBottom:12, flexWrap:"wrap" }}>
          <span style={{ fontSize:12, color:"#94a3b8", fontWeight:500 }}>Período:</span>
          {[
            { key:"hoje", label:"Hoje" },
            { key:"semana", label:"7 dias" },
            { key:"mes", label:"Este mês" },
            { key:"ano", label:"Este ano" },
            { key:"tudo", label:"Tudo" },
            { key:"custom", label:"Personalizado" },
          ].map(p => (
            <button key={p.key} onClick={() => { setPeriodoFiltro(p.key); setShowMesPicker(false); }}
              style={{ padding:"5px 14px", borderRadius:20, border:"none", cursor:"pointer", fontSize:12, fontWeight:periodoFiltro===p.key?700:500,
                background:periodoFiltro===p.key?"#0f172a":"#f1f5f9",
                color:periodoFiltro===p.key?"#fff":"#64748b" }}>
              {p.label}
            </button>
          ))}
          {/* Seletor de mês específico */}
          <div style={{ position:"relative" }}>
            <button onClick={function(){ setShowMesPicker(function(v){return !v;}); }}
              style={{ padding:"5px 14px", borderRadius:20, border:"none", cursor:"pointer", fontSize:12,
                fontWeight: periodoFiltro==="mesSel" ? 700 : 500,
                background: periodoFiltro==="mesSel" ? "#0891b2" : "#f1f5f9",
                color: periodoFiltro==="mesSel" ? "#fff" : "#64748b",
                display:"flex", alignItems:"center", gap:4 }}>
              📅 {periodoFiltro==="mesSel"
                ? new Date(mesSelecionado+"-15").toLocaleDateString("pt-BR",{month:"short",year:"numeric"}).replace(".","")
                : "Mês"}
              <span style={{ fontSize:9, opacity:0.7 }}>▼</span>
            </button>
            {showMesPicker && (
              <div style={{ position:"absolute", top:36, left:0, background:"#fff", border:"1px solid #e2e8f0", borderRadius:12,
                boxShadow:"0 8px 24px rgba(0,0,0,.12)", zIndex:200, padding:12, minWidth:220 }}
                onMouseLeave={function(){ setShowMesPicker(false); }}>
                <div style={{ fontSize:11, color:"#94a3b8", fontWeight:600, marginBottom:8, textTransform:"uppercase" }}>Selecionar mês</div>
                {(function() {
                  var meses = [];
                  var agora = new Date();
                  for (var i = 0; i < 18; i++) {
                    var d = new Date(agora.getFullYear(), agora.getMonth() - i, 1);
                    var key = d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0");
                    meses.push({ key, label: d.toLocaleDateString("pt-BR",{month:"long",year:"numeric"}) });
                  }
                  return meses.map(function(m) {
                    var ativo = mesSelecionado === m.key && periodoFiltro === "mesSel";
                    return (
                      <button key={m.key} onClick={function(){
                          setMesSelecionado(m.key);
                          setPeriodoFiltro("mesSel");
                          setShowMesPicker(false);
                        }}
                        style={{ width:"100%", textAlign:"left", background: ativo?"#0891b2":"transparent",
                          border:"none", color: ativo?"#fff":"#334155", padding:"7px 10px",
                          borderRadius:7, cursor:"pointer", fontSize:13, fontWeight: ativo?600:400,
                          display:"block" }}
                        onMouseEnter={function(e){ if(!ativo) e.currentTarget.style.background="#f8fafc"; }}
                        onMouseLeave={function(e){ if(!ativo) e.currentTarget.style.background="transparent"; }}>
                        {m.label.charAt(0).toUpperCase() + m.label.slice(1)}
                      </button>
                    );
                  });
                })()}
              </div>
            )}
          </div>
          {periodoFiltro === "mesSel" && <span style={{ fontSize:12, color:"#0891b2", fontWeight:600 }}>{String(parseInt(mesSelecionado.slice(5))).padStart(2,"0")}/{mesSelecionado.slice(0,4)}</span>}
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
        </div>}

        {(tab === "overview" || tab === "listings" || tab === "orders") && <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 12, marginBottom: 24 }} className="fade-up">
          {[
            { label: "Fat. Bruto", value: fmt(fatBruto), color: "#0f172a", desc: `${allOrdersPeriodo.filter(o=>o.status==="paid").length} pedidos` },
            { label: "Fat. Líquido", value: fmt(fatLiquido), color: fatLiquido >= fatBruto ? "#0f172a" : "#dc2626", desc: canceladosDevolvidos.length > 0 ? `-${canceladosDevolvidos.length} cancel./devolv.` : "sem cancelamentos" },
            { label: "Tarifas ML", value: fmt(totalFees), color: "#d97706" },
            { label: "Frete (seu custo)", value: fmt(totalFreteSeller), color: "#7c3aed" },
            { label: "CMV (mercadorias)", value: fmt(totalCMV), color: "#be123c" },
            { label: "Margem média", value: fmtPct(avgMargin), color: avgMargin >= .25 ? "#15803d" : avgMargin >= .15 ? "#d97706" : "#dc2626" },
            { label: "Impostos (mês)", value: fmt(totalImpostosMes), color: "#dc2626", desc: pctImpostos > 0 ? `${(pctImpostos*100).toFixed(2)}% (IRPJ+CSLL)` : "configure em Financeiro" },
            { label: "Custos Fixos (mês)", value: fmt(totalCustosFixosMes), color: "#d97706" },
            { label: "Lucro Real", value: fmt(lucroReal), color: lucroReal >= 0 ? "#15803d" : "#dc2626" },
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
        </div>}

        {/* Abas agora estão no header */}

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
            {/* Sub-abas de Anúncios */}
            <div style={{ display:"flex", gap:2, borderBottom:"2px solid #f1f5f9", marginBottom:10 }}>
              {[
                { key:"ml",    label:"🟡 Anúncios Mercado Livre", badge: enriched.length },
                { key:"outros",label:"➕ Outros Marketplaces",    badge: null },
              ].map(function(t){
                var active = (abaAnuncio) === t.key;
                return (
                  <button key={t.key}
                    onClick={function(){ setAbaAnuncio(t.key); }}
                    style={{ display:"flex", alignItems:"center", gap:8, padding:"10px 20px", border:"none",
                      borderBottom: active?"2px solid #0f172a":"2px solid transparent", marginBottom:-2,
                      background:"transparent", color:active?"#0f172a":"#94a3b8",
                      fontWeight:active?700:400, fontSize:13, cursor:"pointer", fontFamily:"inherit" }}>
                    {t.label}
                    {t.badge != null && (
                      <span style={{ background:active?"#0f172a":"#e2e8f0", color:active?"#fff":"#64748b",
                        fontSize:11, fontWeight:700, padding:"1px 7px", borderRadius:20 }}>{t.badge}</span>
                    )}
                  </button>
                );
              })}
            </div>
            {/* Conteúdo — só ML por enquanto */}
            {(abaAnuncio) === "outros" ? (
              <div style={{ textAlign:"center", padding:"60px 20px", color:"#94a3b8" }}>
                <div style={{ fontSize:48, marginBottom:12 }}>🔌</div>
                <div style={{ fontWeight:700, fontSize:16, color:"#0f172a", marginBottom:8 }}>Em breve: outros marketplaces</div>
                <div style={{ fontSize:13 }}>Integração com Shopee, Shein, Amazon e outros em desenvolvimento</div>
              </div>
            ) : (
            <LayoutFiltros
              filtros={
                <>
                  <FiltroGrupo titulo="Status">
                    {[{key:"all",label:"Todos"},{key:"active",label:"● Ativos"},{key:"paused",label:"○ Pausados"}].map(function(f){
                      return <FiltroBotao key={f.key} label={f.label} active={statusFilter===f.key}
                        cor={f.key==="active"?"#15803d":f.key==="paused"?"#94a3b8":"#0f172a"}
                        bg={f.key==="active"?"#f0fdf4":f.key==="paused"?"#f8fafc":"#f1f5f9"}
                        onClick={function(){setStatusFilter(f.key);}} />;
                    })}
                  </FiltroGrupo>
                  <FiltroGrupo titulo="Situação">
                    {[{k:"all",l:"Todos"},{k:"sem_custo",l:"⚠️ Sem custo",cor:"#dc2626",bg:"#fef2f2"},{k:"sem_atacado",l:"🏷 Sem preço atacado",cor:"#7c3aed",bg:"#f5f3ff"},{k:"com_promo",l:"🔥 Com promoção",cor:"#7c3aed",bg:"#f5f3ff"},{k:"sem_promo",l:"○ Sem promoção",cor:"#64748b",bg:"#f8fafc"},{k:"frete_alto",l:"🚚 Frete acima do config.",cor:"#ea580c",bg:"#fff7ed"}].map(function(f){
                      return <FiltroBotao key={f.k} label={f.l} active={filterListingExtra===f.k}
                        cor={f.cor||"#0f172a"} bg={f.bg||"#f1f5f9"}
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
                      return <FiltroBotao key={o.k} label={o.l} active={sortBy===o.k} cor="#0f172a" bg="#f1f5f9" onClick={function(){setSortBy(o.k);}} />;
                    })}
                  </FiltroGrupo>
                  <div style={{ fontSize:11, color:"#94a3b8", marginTop:"auto" }}>{sorted.length} anúncio(s)</div>
                </>
              }
              busca={
                <div style={{ display:"flex", gap:6 }}>
                  <div style={{ position:"relative", flex:1 }}>
                    <span style={{ position:"absolute", left:10, top:"50%", transform:"translateY(-50%)", color:"#94a3b8", fontSize:13 }}>🔍</span>
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
                  ) : sorted.slice((paginaAnuncios-1)*POR_PAG_ANUNCIOS, paginaAnuncios*POR_PAG_ANUNCIOS).map(l => {
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
                                  <input type="number" value={minStock[l.id] ?? ""} onChange={e => setMinStockAndSave(m => ({ ...m, [l.id]: Number(e.target.value), ["_src_"+l.id]: "manual" }))} placeholder="0"
                                    title="Editar aqui marca como manual; para voltar a sincronizar com o cadastro do produto, defina o Estoque Mínimo em Produtos novamente"
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
                          {(function(){
                            try {
                              var fretesConf = JSON.parse(localStorage.getItem("fretes_config")||"{}");
                              var fc = parseFloat(fretesConf[l.id]||0);
                              var fr = l.freteSeller||0;
                              if (fc>0 && fr>fc) return (
                                <div style={{ marginTop:2 }}>
                                  <span style={{ fontSize:9, fontWeight:700, background:"#fff7ed", color:"#ea580c", border:"1px solid #fed7aa", padding:"1px 5px", borderRadius:3, whiteSpace:"nowrap" }}>
                                    🚚 frete +R${(fr-fc).toFixed(2).replace(".",",")}
                                  </span>
                                </div>
                              );
                            } catch {}
                            return null;
                          })()}
                        </td>
                        <td>
                          <span style={{ fontWeight: 700, color: "#15803d", fontSize: 13 }}>{fmt(l.youReceive)}</span>
                          <div style={{ fontSize: 10, color: "#94a3b8" }}>após tarifa e frete</div>
                        </td>
                        <td>
                          <input type="number" value={l.cost || ""} onChange={e => setCostsAndSave(c => ({ ...c, [l.id]: Number(e.target.value) }))} placeholder="0,00"
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
            <div style={{ display:"flex", gap:2, borderBottom:"2px solid #f1f5f9", marginBottom:10 }}>
              {[
                { key:"ml",    label:"🟡 Pedidos Mercado Livre", badge: enrichedOrders.length },
                { key:"outros",label:"➕ Outros Marketplaces",   badge: null },
              ].map(function(t){
                var active = (abaPedido) === t.key;
                return (
                  <button key={t.key}
                    onClick={function(){ setAbaPedido(t.key); }}
                    style={{ display:"flex", alignItems:"center", gap:8, padding:"10px 20px", border:"none",
                      borderBottom: active?"2px solid #0f172a":"2px solid transparent", marginBottom:-2,
                      background:"transparent", color:active?"#0f172a":"#94a3b8",
                      fontWeight:active?700:400, fontSize:13, cursor:"pointer", fontFamily:"inherit" }}>
                    {t.label}
                    {t.badge != null && (
                      <span style={{ background:active?"#0f172a":"#e2e8f0", color:active?"#fff":"#64748b",
                        fontSize:11, fontWeight:700, padding:"1px 7px", borderRadius:20 }}>{t.badge}</span>
                    )}
                  </button>
                );
              })}
            </div>
            {(abaPedido) === "outros" ? (
              <div style={{ textAlign:"center", padding:"60px 20px", color:"#94a3b8" }}>
                <div style={{ fontSize:48, marginBottom:12 }}>🔌</div>
                <div style={{ fontWeight:700, fontSize:16, color:"#0f172a", marginBottom:8 }}>Em breve: outros marketplaces</div>
                <div style={{ fontSize:13 }}>Integração com Shopee, Shein, Amazon e outros em desenvolvimento</div>
              </div>
            ) : (
            <LayoutFiltros
              filtros={
                <>
                  <FiltroGrupo titulo="Período">
                    {[{key:"today",l:"Hoje"},{key:"week",l:"7 dias"},{key:"thismonth",l:"Este mês"},{key:"month",l:"30 dias"},{key:"3months",l:"3 meses"},{key:"all",l:"Todos"}].map(function(f){
                      return <FiltroBotao key={f.key} label={f.l} active={orderFilter===f.key} cor="#0f172a" bg="#f1f5f9" onClick={function(){setOrderFilter(f.key);}} />;
                    })}
                  </FiltroGrupo>
                  <FiltroGrupo titulo="Status">
                    {[{key:"all",l:"Todos"},{key:"waiting",l:"⏳ Ag. envio"},{key:"shipped",l:"🚚 Enviados"},{key:"done",l:"✓ Concluídos"},{key:"cancelled",l:"✗ Cancelados"},{key:"refunded",l:"↩ Devolvidos"},{key:"mediation",l:"⚠ Disputa"}].map(function(f){
                      return <FiltroBotao key={f.key} label={f.l} active={orderStatusFilter===f.key} cor="#0f172a" bg="#f1f5f9" onClick={function(){setOrderStatusFilter(f.key);}} />;
                    })}
                  </FiltroGrupo>
                  <FiltroGrupo titulo="Tipo de Envio">
                    {[{key:"todos",l:"Todos"},{key:"FULL",l:"FULL",c:"#1d4ed8",bg:"#eff6ff"},{key:"Flex",l:"Flex",c:"#7c3aed",bg:"#f5f3ff"},{key:"ME2",l:"ME2",c:"#0891b2",bg:"#ecfeff"},{key:"ME1",l:"ME1",c:"#0369a1",bg:"#e0f2fe"}].map(function(e){
                      return <FiltroBotao key={e.key} label={e.l} active={filterEnvio===e.key} cor={e.c||"#0f172a"} bg={e.bg||"#f1f5f9"} onClick={function(){setFilterEnvio(e.key);setPaginaPedidos(1);}} />;
                    })}
                  </FiltroGrupo>
                  <FiltroGrupo titulo="Outros Filtros">
                    <input value={filterSku} onChange={function(e){setFilterSku(e.target.value);}} placeholder="SKU do produto..."
                      style={{ width:"100%", background:"#fff", border:"1px solid #e2e8f0", color:"#0f172a", padding:"6px 8px", borderRadius:7, fontSize:11, outline:"none" }} />
                    <select value={filterUF} onChange={function(e){setFilterUF(e.target.value);}}
                      style={{ width:"100%", background:"#fff", border:"1px solid #e2e8f0", color:"#334155", padding:"6px 8px", borderRadius:7, fontSize:11 }}>
                      <option value="">Estado (UF)</option>
                      {["AC","AL","AP","AM","BA","CE","DF","ES","GO","MA","MT","MS","MG","PA","PB","PR","PE","PI","RJ","RN","RS","RO","RR","SC","SP","SE","TO"].map(function(uf){return <option key={uf} value={uf}>{uf}</option>;})}
                    </select>
                    <div style={{ display:"flex", gap:4, alignItems:"center" }}>
                      <input type="date" value={dateFrom} onChange={function(e){setDateFrom(e.target.value);}}
                        style={{ flex:1, background:"#fff", border:"1px solid #e2e8f0", color:"#334155", padding:"5px 6px", borderRadius:7, fontSize:11 }} />
                    </div>
                    <div style={{ display:"flex", gap:4, alignItems:"center" }}>
                      <span style={{ fontSize:10, color:"#94a3b8" }}>até</span>
                      <input type="date" value={dateTo} onChange={function(e){setDateTo(e.target.value);}}
                        style={{ flex:1, background:"#fff", border:"1px solid #e2e8f0", color:"#334155", padding:"5px 6px", borderRadius:7, fontSize:11 }} />
                    </div>
                    {(filterSku||filterUF||dateFrom||dateTo) && (
                      <button onClick={function(){setFilterSku("");setFilterUF("");setDateFrom("");setDateTo("");}}
                        style={{ background:"#fef2f2", border:"1px solid #fecaca", color:"#dc2626", padding:"5px 8px", borderRadius:7, cursor:"pointer", fontSize:11, width:"100%" }}>✕ Limpar filtros</button>
                    )}
                  </FiltroGrupo>
                  <div style={{ fontSize:11, color:"#94a3b8", marginTop:"auto" }}>{enrichedOrders.length} pedido(s)<br/>{fmt(enrichedOrders.reduce(function(s,o){return s+o.price*o.qty;},0))}</div>
                </>
              }
              busca={
                <div style={{ position:"relative" }}>
                  <span style={{ position:"absolute", left:10, top:"50%", transform:"translateY(-50%)", color:"#94a3b8", fontSize:13 }}>🔍</span>
                  <input className="search-input" value={searchOrders} onChange={function(e){setSearchOrders(e.target.value);}}
                    placeholder="Buscar por nº pedido, cliente, CPF, e-mail..." style={{ width:"100%", paddingLeft:36 }} />
                </div>
              }>
              <div style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 12, overflow: "auto", boxShadow: "0 1px 3px rgba(0,0,0,.04)" }}>
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
                      return <th key={h} style={{ fontSize:11, color:"#94a3b8", textTransform:"uppercase", letterSpacing:0.8, padding:"10px 12px", borderBottom:"1px solid #f1f5f9", textAlign:align, fontWeight:600, background:"#fafafa", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{h}</th>;
                    })}
                  </tr>
                </thead>
                <tbody>
                  {enrichedOrdersComEnvio.length === 0 ? (
                    <tr><td colSpan={13} style={{ textAlign:"center", color:"#94a3b8", padding:40 }}>Nenhum pedido encontrado</td></tr>
                  ) : enrichedOrdersComEnvio.slice((paginaPedidos-1)*POR_PAG_PEDIDOS, paginaPedidos*POR_PAG_PEDIDOS).map(function(o) {
                    var youReceive = o.price - o.fee - o.freteSeller;
                    var sInfo = getOrderStatusInfo(o.status, o.tags, o.fulfilled, o.shipment_status);
                    var envLabel = detectTipoEnvio(o, shipmentStatuses) || "";
                    return (
                      <tr key={o.id} style={{ borderBottom:"1px solid #f8fafc" }}>
                        <td style={{ padding:"6px 9px", fontSize:11, color:"#64748b", fontFamily:"monospace", fontWeight:600, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>#{o.id}</td>
                        <td style={{ padding:"10px 12px" }}>
                          <span style={{ fontSize:11, fontWeight:600, color:sInfo.color, background:sInfo.bg, padding:"3px 8px", borderRadius:6, whiteSpace:"nowrap" }}>{sInfo.label}</span>
                        </td>
                        <td style={{ padding:"10px 12px" }}>
                          {envLabel ? <BadgeTipoEnvio tipo={envLabel} /> : <span style={{ color:"#94a3b8", fontSize:11 }}>—</span>}
                        </td>
                        <td style={{ padding:"10px 12px", overflow:"hidden" }}>
                          {o.buyerName ? (
                            <div style={{ position:"relative" }}>
                              <button onClick={function(){ setShowClienteDetalhe(showClienteDetalhe===o.id ? null : o.id); }}
                                style={{ background:"none", border:"none", color:"#0891b2", cursor:"pointer", fontSize:11, fontWeight:600, padding:0, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", maxWidth:"100%", display:"block" }}>
                                {o.buyerName}
                              </button>
                              {showClienteDetalhe === o.id && (
                                <div style={{ position:"fixed", zIndex:900, background:"#fff", border:"1px solid #e2e8f0", borderRadius:12, padding:"16px 18px", boxShadow:"0 8px 32px rgba(0,0,0,.15)", minWidth:260, marginTop:4 }}>
                                  <div style={{ fontWeight:700, fontSize:14, color:"#0f172a", marginBottom:10, display:"flex", justifyContent:"space-between" }}>
                                    👤 {o.buyerName}
                                    <button onClick={function(){ setShowClienteDetalhe(null); }} style={{ background:"none", border:"none", cursor:"pointer", color:"#94a3b8", fontSize:14 }}>✕</button>
                                  </div>
                                  {o.buyerDoc && <div style={{ fontSize:12, color:"#64748b", marginBottom:4 }}>{o.buyerDocType||"Doc"}: {o.buyerDoc}</div>}
                                  {o.buyerEmail && <div style={{ fontSize:12, color:"#64748b", marginBottom:4 }}>✉️ {o.buyerEmail}</div>}
                                  {o.buyerPhone && <div style={{ fontSize:12, color:"#64748b", marginBottom:4 }}>📞 {o.buyerPhone}</div>}
                                  {o.buyerCity && <div style={{ fontSize:12, color:"#64748b", marginBottom:4 }}>📍 {o.buyerCity}{o.buyerUF ? " - "+o.buyerUF : ""}{o.buyerZip ? " ("+o.buyerZip+")" : ""}</div>}
                                  {o.sku && <div style={{ fontSize:12, color:"#64748b" }}>SKU: {o.sku}</div>}
                                </div>
                              )}
                            </div>
                          ) : <span style={{ color:"#94a3b8", fontSize:11 }}>—</span>}
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
                              if (!title) return <span style={{ color:"#94a3b8", fontSize:12 }}>—</span>;
                              return link
                                ? <a href={link} target="_blank" rel="noreferrer" className="title-link" style={{ fontSize:12 }}>{title}</a>
                                : <span style={{ fontSize:12 }}>{title}</span>;
                            })()}
                          </div>
                        </td>
                        <td style={{ padding:"7px 10px", fontSize:11, color:"#64748b", whiteSpace:"nowrap" }}>{fmtDate(o.date)}</td>
                        <td style={{ padding:"7px 10px", fontSize:12, fontWeight:700, color:"#0f172a", textAlign:"right", whiteSpace:"nowrap" }}>{fmt(o.price)}</td>
                        <td style={{ padding:"7px 10px", fontSize:11, color:"#64748b", textAlign:"center" }}>×{o.qty}</td>
                        <td style={{ padding:"10px 12px", textAlign:"right", whiteSpace:"nowrap" }}><span style={{ color:"#d97706", fontWeight:600, fontSize:12 }}>{fmt(o.fee)}</span></td>
                        <td style={{ padding:"10px 12px", textAlign:"right", whiteSpace:"nowrap" }}><span style={{ color:"#7c3aed", fontWeight:600, fontSize:12 }}>{o.freteSeller > 0 ? fmt(o.freteSeller) : "—"}</span></td>
                        <td style={{ padding:"10px 12px", textAlign:"right", whiteSpace:"nowrap" }}><span style={{ color:"#15803d", fontWeight:700, fontSize:12 }}>{fmt(youReceive)}</span></td>
                        <td style={{ padding:"10px 12px", textAlign:"right", whiteSpace:"nowrap", fontSize:12, color:o.profit>=0?"#15803d":"#dc2626", fontWeight:700 }}>{o.cost > 0 ? fmt(o.profit) : "—"}</td>
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
            currentUser={currentUser}
            irpjCsllConfig={irpjCsllConfig}
            setIrpjCsllConfig={setIrpjCsllConfig}
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
            costs={costs}
            setCosts={setCostsAndSave}
            enriched={enriched}
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
            setCosts={setCostsAndSave}
            rawOrders={rawOrders}
          />
        )}



        {tab === "full" && currentUser?.permissoes?.includes("orders") && (
          <EnviosFULLTab
            produtos={produtos}
            listings={listings}
            estoqueDepositos={[]}
            depositos={[]}
          />
        )}

        {tab === "nfe_saida" && currentUser?.permissoes?.includes("orders") && (
          <NfSaidaTab
            enrichedOrders={enrichedOrders}
            nfeSaida={nfeSaida}
            setNfeSaida={setNfeSaida}
            loadingNfe={loadingNfe}
            setLoadingNfe={setLoadingNfe}
            token={token}
            getValidToken={getValidToken}
          />
        )}

        {tab === "ia_chat" && (
          <IAChatTab
            enriched={enriched}
            rawOrders={rawOrders}
            produtos={produtos}
            contasPagar={contasPagar}
            token={token}
          />
        )}

        {tab === "precificacao" && currentUser?.permissoes?.includes("listings") && (
          <PrecificacaoTab
            enriched={enriched}
            costs={costs}
            setCostsAndSave={setCostsAndSave}
            fretesConfig={fretesConfig}
            setFretesAndSave={setFretesAndSave}
            rawOrders={rawOrders}
          />
        )}



        {tab === "concorrencia" && currentUser?.permissoes?.includes("listings") && (
          <ConcorrenciaTab enriched={enriched} token={token} sellerId={user?.id} />
        )}

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
