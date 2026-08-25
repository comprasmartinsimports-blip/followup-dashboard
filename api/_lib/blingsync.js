// api/_lib/blingsync.js
// Traz os dados do Bling para o Postgres (flow.bling_*). Cada entidade é
// independente: se uma falhar, as outras continuam e o relatório diz qual quebrou.

import { sqlClient } from "./db.js";
import { chamarBling, listarPaginado, garantirToken, ENTIDADES, ErroBling } from "./bling.js";

// Os nomes de campo da v3 variam entre entidades (e entre versões da doc). Em vez
// de apostar num único nome, procura o primeiro caminho que exista de fato. O
// registro completo vai para a coluna raw, então nenhum dado se perde no caminho.
function valor(obj, caminhos) {
  for (const caminho of caminhos) {
    let atual = obj;
    let achou = true;
    for (const parte of caminho.split(".")) {
      if (atual && typeof atual === "object" && parte in atual) atual = atual[parte];
      else { achou = false; break; }
    }
    if (achou && atual !== null && atual !== undefined && atual !== "") return atual;
  }
  return null;
}

function numero(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(",", "."));
  return isFinite(n) ? n : null;
}

function data(v) {
  if (!v) return null;
  const s = String(v).trim();
  // Aceita "2026-08-25", "2026-08-25 10:00:00" e "25/08/2026".
  const br = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (br) return br[3] + "-" + br[2] + "-" + br[1];
  const iso = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return iso ? iso[1] : null;
}

function texto(v) {
  return v === null || v === undefined ? null : String(v);
}

// ── Produtos ─────────────────────────────────────────────────────────────────

export async function sincronizarProdutos() {
  const sql = sqlClient();
  const { itens, truncado } = await listarPaginado(ENTIDADES.produtos.caminho, {});
  for (const p of itens) {
    const id = texto(valor(p, ["id"]));
    if (!id) continue;
    await sql`
      insert into flow.bling_produto (id, codigo, nome, preco, custo, situacao, raw, atualizado_em)
      values (
        ${id},
        ${texto(valor(p, ["codigo", "sku"]))},
        ${texto(valor(p, ["nome", "descricao", "descricaoCurta"]))},
        ${numero(valor(p, ["preco", "precoVenda"]))},
        ${numero(valor(p, ["precoCusto", "custo", "precoCompra", "estoque.custoMedio", "fornecedor.precoCusto"]))},
        ${texto(valor(p, ["situacao"]))},
        ${sql.json(p)}, now()
      )
      on conflict (id) do update set
        codigo = excluded.codigo, nome = excluded.nome, preco = excluded.preco,
        -- custo só é sobrescrito quando veio preenchido: nem toda listagem traz custo
        custo = coalesce(excluded.custo, flow.bling_produto.custo),
        situacao = excluded.situacao, raw = excluded.raw, atualizado_em = now()
    `;
  }
  return { registros: itens.length, truncado };
}

// ── Estoque ──────────────────────────────────────────────────────────────────
// O endpoint de saldos pede os ids dos produtos, então usa o que já foi importado.

export async function sincronizarEstoque() {
  const sql = sqlClient();
  const produtos = await sql`select id from flow.bling_produto order by id`;
  if (!produtos.length) {
    throw new ErroBling("Nenhum produto importado ainda — sincronize os produtos antes do estoque.", 0);
  }
  const token = await garantirToken();
  const ids = produtos.map(function(r) { return String(r.id); });
  let gravados = 0;
  // Em lotes: a consulta de saldos recebe vários produtos de uma vez.
  for (let i = 0; i < ids.length; i += 50) {
    const lote = ids.slice(i, i + 50);
    const params = new URLSearchParams();
    lote.forEach(function(id) { params.append("idsProdutos[]", id); });
    const resposta = await chamarBling(ENTIDADES.estoques.caminho, Object.fromEntries(params), token);
    const linhas = Array.isArray(resposta.data) ? resposta.data : [];
    for (const s of linhas) {
      const produtoId = texto(valor(s, ["produto.id", "idProduto", "id"]));
      if (!produtoId) continue;
      const depositos = Array.isArray(s.depositos) && s.depositos.length
        ? s.depositos
        : [{ id: "geral", saldoFisico: valor(s, ["saldoFisicoTotal", "saldoVirtualTotal", "saldo"]) }];
      for (const d of depositos) {
        await sql`
          insert into flow.bling_estoque (produto_id, deposito_id, deposito_nome, saldo, atualizado_em)
          values (
            ${produtoId},
            ${texto(valor(d, ["id", "idDeposito"])) || "geral"},
            ${texto(valor(d, ["descricao", "nome"]))},
            ${numero(valor(d, ["saldoFisico", "saldoVirtual", "saldo"]))},
            now()
          )
          on conflict (produto_id, deposito_id) do update set
            deposito_nome = excluded.deposito_nome, saldo = excluded.saldo, atualizado_em = now()
        `;
        gravados++;
      }
    }
  }
  return { registros: gravados, truncado: false };
}

// ── Contas a pagar / receber ─────────────────────────────────────────────────

export async function sincronizarContas(tipo) {
  const sql = sqlClient();
  const caminho = tipo === "pagar" ? ENTIDADES.contas_pagar.caminho : ENTIDADES.contas_receber.caminho;
  const { itens, truncado } = await listarPaginado(caminho, {});
  for (const c of itens) {
    const id = texto(valor(c, ["id"]));
    if (!id) continue;
    await sql`
      insert into flow.bling_conta (id, tipo, situacao, vencimento, valor, contato, raw, atualizado_em)
      values (
        ${id}, ${tipo},
        ${texto(valor(c, ["situacao"]))},
        ${data(valor(c, ["vencimento", "dataVencimento", "vencimentoOriginal"]))},
        ${numero(valor(c, ["valor", "valorTotal", "saldo"]))},
        ${texto(valor(c, ["contato.nome", "fornecedor.nome", "cliente.nome"]))},
        ${sql.json(c)}, now()
      )
      on conflict (id) do update set
        tipo = excluded.tipo, situacao = excluded.situacao, vencimento = excluded.vencimento,
        valor = excluded.valor, contato = excluded.contato, raw = excluded.raw, atualizado_em = now()
    `;
  }
  return { registros: itens.length, truncado };
}

// ── Notas fiscais ────────────────────────────────────────────────────────────

export async function sincronizarNotas() {
  const sql = sqlClient();
  const { itens, truncado } = await listarPaginado(ENTIDADES.notas.caminho, {});
  for (const n of itens) {
    const id = texto(valor(n, ["id"]));
    if (!id) continue;
    // No Bling o tipo costuma vir como 0/1 (entrada/saída) ou já como texto.
    const tipoBruto = valor(n, ["tipo"]);
    const tipo = tipoBruto === 0 || tipoBruto === "0" ? "entrada"
      : tipoBruto === 1 || tipoBruto === "1" ? "saida"
      : texto(tipoBruto);
    await sql`
      insert into flow.bling_nota (id, tipo, numero, serie, situacao, data_emissao, valor, raw, atualizado_em)
      values (
        ${id}, ${tipo},
        ${texto(valor(n, ["numero"]))},
        ${texto(valor(n, ["serie"]))},
        ${texto(valor(n, ["situacao"]))},
        ${data(valor(n, ["dataEmissao", "data", "dataOperacao"]))},
        ${numero(valor(n, ["valorNota", "valor", "total"]))},
        ${sql.json(n)}, now()
      )
      on conflict (id) do update set
        tipo = excluded.tipo, numero = excluded.numero, serie = excluded.serie,
        situacao = excluded.situacao, data_emissao = excluded.data_emissao,
        valor = excluded.valor, raw = excluded.raw, atualizado_em = now()
    `;
  }
  return { registros: itens.length, truncado };
}

// ── Sincronização completa ───────────────────────────────────────────────────
// Uma entidade que falha não derruba as outras: cada uma vira uma linha do
// relatório, com o erro que o próprio Bling devolveu.

const TAREFAS = [
  { chave: "produtos",       rotulo: "Produtos",          executar: sincronizarProdutos },
  { chave: "estoque",        rotulo: "Estoque",           executar: sincronizarEstoque },
  { chave: "contas_pagar",   rotulo: "Contas a pagar",    executar: function() { return sincronizarContas("pagar"); } },
  { chave: "contas_receber", rotulo: "Contas a receber",  executar: function() { return sincronizarContas("receber"); } },
  { chave: "notas",          rotulo: "Notas fiscais",     executar: sincronizarNotas },
];

export async function sincronizarTudo(somente) {
  const alvo = Array.isArray(somente) && somente.length
    ? TAREFAS.filter(function(t) { return somente.includes(t.chave); })
    : TAREFAS;
  const relatorio = [];
  for (const tarefa of alvo) {
    try {
      const r = await tarefa.executar();
      relatorio.push({ chave: tarefa.chave, rotulo: tarefa.rotulo, ok: true, registros: r.registros, truncado: !!r.truncado });
    } catch (e) {
      relatorio.push({
        chave: tarefa.chave, rotulo: tarefa.rotulo, ok: false, registros: 0,
        erro: (e && e.message) || "falha desconhecida",
        status: (e && e.status) || 0,
      });
    }
  }
  return relatorio;
}
