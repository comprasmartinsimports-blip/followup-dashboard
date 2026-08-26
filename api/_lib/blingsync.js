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

// ── Onde cada entidade parou ─────────────────────────────────────────────────
// A API limita requisições por segundo e a função tem tempo máximo. Em vez de
// recomeçar do zero a cada clique (e bater no limite de novo), cada entidade guarda
// a próxima página a buscar.

async function lerCursor(entidade) {
  const sql = sqlClient();
  const rows = await sql`select proxima_pagina from flow.bling_sync_estado where entidade = ${entidade}`;
  return rows.length ? rows[0].proxima_pagina : 1;
}

async function gravarCursor(entidade, pagina) {
  const sql = sqlClient();
  await sql`
    insert into flow.bling_sync_estado (entidade, proxima_pagina, atualizado_em)
    values (${entidade}, ${pagina}, now())
    on conflict (entidade) do update set proxima_pagina = excluded.proxima_pagina, atualizado_em = now()
  `;
}

// ── Produtos ─────────────────────────────────────────────────────────────────
// O Bling é fonte de INFORMAÇÃO, não de cadastro: só entram os produtos cujo código
// já existe no cadastro do Flow. Um produto que existe no Bling e não no Flow é
// ignorado — a importação nunca cria produto novo.

// Gravar registro a registro custa uma ida ao banco por linha: com 4 mil linhas,
// isso sozinho consumia todo o tempo da função e a última etapa ficava sem nada.
// unnest manda o lote inteiro numa consulta só.
const TAMANHO_LOTE = 300;

function emLotes(lista, tamanho) {
  const partes = [];
  for (let i = 0; i < lista.length; i += (tamanho || TAMANHO_LOTE)) {
    partes.push(lista.slice(i, i + (tamanho || TAMANHO_LOTE)));
  }
  return partes;
}

function coluna(lista, campo) {
  return lista.map(function(x) { return x[campo]; });
}

function normalizarSku(v) {
  return v === null || v === undefined ? "" : String(v).trim().toLowerCase();
}

// SKUs cadastrados no Flow, de todas as contas (produtos_cadastro no sync_store).
export async function skusDoFlow() {
  const sql = sqlClient();
  const rows = await sql`
    select distinct lower(trim(e->>'sku')) as sku
    from flow.sync_store s, jsonb_array_elements(s.valor) e
    where s.chave = 'produtos_cadastro'
      and jsonb_typeof(s.valor) = 'array'
      and coalesce(trim(e->>'sku'), '') <> ''
  `;
  return new Set(rows.map(function(r) { return r.sku; }));
}

export async function sincronizarProdutos(ate) {
  const sql = sqlClient();
  const skus = await skusDoFlow();
  // Sem catálogo lido não dá para filtrar. Parar aqui é proposital: seguir em frente
  // importaria o Bling inteiro, exatamente o que não se quer.
  if (!skus.size) {
    throw new ErroBling(
      "Nenhum produto com SKU encontrado no cadastro do Flow. A importação só atualiza " +
      "produtos que já existem aqui, então não há o que atualizar.", 0
    );
  }
  const desdePagina = await lerCursor("produtos");
  const { itens, acabou, proximaPagina, truncado } =
    await listarPaginado(ENTIDADES.produtos.caminho, {}, { ate, desdePagina });
  let ignorados = 0;
  const aGravar = [];
  for (const p of itens) {
    const id = texto(valor(p, ["id"]));
    if (!id) continue;
    const codigo = valor(p, ["codigo", "sku"]);
    // Fora do cadastro do Flow: passa direto, sem gravar nada.
    if (!skus.has(normalizarSku(codigo))) { ignorados++; continue; }
    aGravar.push({
      id: id,
      codigo: texto(codigo),
      nome: texto(valor(p, ["nome", "descricao", "descricaoCurta"])),
      preco: numero(valor(p, ["preco", "precoVenda"])),
      custo: numero(valor(p, ["precoCusto", "custo", "precoCompra", "estoque.custoMedio", "fornecedor.precoCusto"])),
      situacao: texto(valor(p, ["situacao"])),
      raw: JSON.stringify(p),
    });
  }
  for (const lote of emLotes(aGravar)) {
    await sql`
      insert into flow.bling_produto (id, codigo, nome, preco, custo, situacao, raw, atualizado_em)
      select id, codigo, nome, preco, custo, situacao, raw, now()
      from unnest(
        ${sql.array(coluna(lote, "id"))}::text[],
        ${sql.array(coluna(lote, "codigo"))}::text[],
        ${sql.array(coluna(lote, "nome"))}::text[],
        ${sql.array(coluna(lote, "preco"))}::numeric[],
        ${sql.array(coluna(lote, "custo"))}::numeric[],
        ${sql.array(coluna(lote, "situacao"))}::text[],
        ${sql.array(coluna(lote, "raw"))}::jsonb[]
      ) as t(id, codigo, nome, preco, custo, situacao, raw)
      on conflict (id) do update set
        codigo = excluded.codigo, nome = excluded.nome, preco = excluded.preco,
        -- custo só é sobrescrito quando veio preenchido: nem toda listagem traz custo
        custo = coalesce(excluded.custo, flow.bling_produto.custo),
        situacao = excluded.situacao, raw = excluded.raw, atualizado_em = now()
    `;
  }
  await gravarCursor("produtos", proximaPagina);
  return { registros: itens.length - ignorados, ignorados, truncado, acabou, desdePagina };
}

// ── Estoque ──────────────────────────────────────────────────────────────────
// O endpoint de saldos pede os ids dos produtos, então usa o que já foi importado.

export async function sincronizarEstoque(ate) {
  const sql = sqlClient();
  const produtos = await sql`select id from flow.bling_produto order by id`;
  if (!produtos.length) {
    throw new ErroBling("Nenhum produto importado ainda — sincronize os produtos antes do estoque.", 0);
  }
  const token = await garantirToken();
  const ids = produtos.map(function(r) { return String(r.id); });
  let gravados = 0;
  const aGravar = [];
  // Em lotes: a consulta de saldos recebe vários produtos de uma vez.
  let parou = false;
  for (let i = 0; i < ids.length; i += 50) {
    // Respeita o tempo da função: o que sobrar entra na próxima sincronização.
    if (ate && Date.now() > ate - 3000) { parou = true; break; }
    const lote = ids.slice(i, i + 50);
    const params = new URLSearchParams();
    lote.forEach(function(id) { params.append("idsProdutos[]", id); });
    // Passa o URLSearchParams inteiro: Object.fromEntries() colapsaria idsProdutos[]
    // repetido em um único valor, e o lote de 50 produtos virava um pedido de 1 só.
    const resposta = await chamarBling(ENTIDADES.estoques.caminho, params, token);
    const linhas = Array.isArray(resposta.data) ? resposta.data : [];
    for (const s of linhas) {
      const produtoId = texto(valor(s, ["produto.id", "idProduto", "id"]));
      if (!produtoId) continue;
      const depositos = Array.isArray(s.depositos) && s.depositos.length
        ? s.depositos
        : [{ id: "geral", saldoFisico: valor(s, ["saldoFisicoTotal", "saldoVirtualTotal", "saldo"]) }];
      for (const d of depositos) {
        aGravar.push({
          produto_id: produtoId,
          deposito_id: texto(valor(d, ["id", "idDeposito"])) || "geral",
          deposito_nome: texto(valor(d, ["descricao", "nome"])),
          saldo: numero(valor(d, ["saldoFisico", "saldoVirtual", "saldo"])),
        });
        gravados++;
      }
    }
  }
  for (const lote of emLotes(aGravar)) {
    await sql`
      insert into flow.bling_estoque (produto_id, deposito_id, deposito_nome, saldo, atualizado_em)
      select produto_id, deposito_id, deposito_nome, saldo, now()
      from unnest(
        ${sql.array(coluna(lote, "produto_id"))}::text[],
        ${sql.array(coluna(lote, "deposito_id"))}::text[],
        ${sql.array(coluna(lote, "deposito_nome"))}::text[],
        ${sql.array(coluna(lote, "saldo"))}::numeric[]
      ) as t(produto_id, deposito_id, deposito_nome, saldo)
      on conflict (produto_id, deposito_id) do update set
        deposito_nome = excluded.deposito_nome, saldo = excluded.saldo, atualizado_em = now()
    `;
  }
  return { registros: gravados, truncado: parou };
}

// ── Contas a pagar ───────────────────────────────────────────────────────────

// O Bling manda a situação como número. 1 e 2 saíram dos próprios dados: o código 1
// concentra as contas a vencer (inclusive com vencimento anos à frente) e o 2 é 99%
// vencido — em aberto e pago. O 3 foi confirmado no Bling: são contas com baixa
// PARCIAL de pagamento.
// ATENÇÃO para quem for usar estes dados: nas parciais o campo valor continua sendo
// o valor ORIGINAL da conta, não o saldo devedor. Quem somar valor achando que é o
// que falta pagar vai superestimar a dívida.
// Código desconhecido vira "código N" em vez de receber um rótulo errado.
const SITUACAO_CONTA = { "1": "em aberto", "2": "pago", "3": "parcialmente pago" };

function situacaoTexto(codigo) {
  const c = texto(codigo);
  if (c === null) return null;
  return SITUACAO_CONTA[c] || ("código " + c);
}

// Só contas a PAGAR. Contas a receber não são buscadas em lugar nenhum deste arquivo.
export async function sincronizarContasPagar(ate) {
  const sql = sqlClient();
  const desdePagina = await lerCursor("contas_pagar");
  const { itens, proximaPagina, truncado } =
    await listarPaginado(ENTIDADES.contas_pagar.caminho, {}, { ate, desdePagina });
  const aGravar = [];
  for (const c of itens) {
    const id = texto(valor(c, ["id"]));
    if (!id) continue;
    aGravar.push({
      id: id,
      situacao: texto(valor(c, ["situacao"])),
      situacao_texto: situacaoTexto(valor(c, ["situacao"])),
      vencimento: data(valor(c, ["vencimento", "dataVencimento", "vencimentoOriginal"])),
      valor: numero(valor(c, ["valor", "valorTotal", "saldo"])),
      contato: texto(valor(c, ["contato.nome", "fornecedor.nome", "cliente.nome"])),
      raw: JSON.stringify(c),
    });
  }
  for (const lote of emLotes(aGravar)) {
    await sql`
      insert into flow.bling_conta (id, tipo, situacao, situacao_texto, vencimento, valor, contato, raw, atualizado_em)
      select id, 'pagar', situacao, situacao_texto, vencimento, valor, contato, raw, now()
      from unnest(
        ${sql.array(coluna(lote, "id"))}::text[],
        ${sql.array(coluna(lote, "situacao"))}::text[],
        ${sql.array(coluna(lote, "situacao_texto"))}::text[],
        ${sql.array(coluna(lote, "vencimento"))}::date[],
        ${sql.array(coluna(lote, "valor"))}::numeric[],
        ${sql.array(coluna(lote, "contato"))}::text[],
        ${sql.array(coluna(lote, "raw"))}::jsonb[]
      ) as t(id, situacao, situacao_texto, vencimento, valor, contato, raw)
      on conflict (id) do update set
        situacao = excluded.situacao, situacao_texto = excluded.situacao_texto,
        vencimento = excluded.vencimento, valor = excluded.valor,
        -- o nome do fornecedor vem da etapa de contatos: não apagar com o nulo da listagem
        contato = coalesce(excluded.contato, flow.bling_conta.contato),
        raw = excluded.raw, atualizado_em = now()
    `;
  }
  await gravarCursor("contas_pagar", proximaPagina);
  return { registros: itens.length, truncado, desdePagina };
}

// ── Fornecedores das contas ──────────────────────────────────────────────────
// A listagem de contas traz o contato só como id. Aqui cada fornecedor é buscado
// uma vez e o nome preenche todas as contas dele.

export async function sincronizarContatos(ate) {
  const sql = sqlClient();
  // Confere a conexão antes de qualquer atalho: sem isso, "nada pendente" e "não
  // conectado" davam a mesma linha verde no relatório, escondendo a desconexão.
  await garantirToken();
  const pendentes = await sql`
    select distinct c.raw->'contato'->>'id' as id
    from flow.bling_conta c
    where c.raw->'contato'->>'id' is not null
      and not exists (select 1 from flow.bling_contato b where b.id = c.raw->'contato'->>'id')
    limit 400
  `;
  if (!pendentes.length) return { registros: 0, truncado: false };
  const token = await garantirToken();
  let gravados = 0, parou = false;
  for (const linha of pendentes) {
    if (ate && Date.now() > ate - 3000) { parou = true; break; }
    let dados = null;
    try {
      const resposta = await chamarBling(ENTIDADES.contatos.caminho + "/" + linha.id, {}, token);
      dados = resposta && resposta.data ? resposta.data : null;
    } catch (e) {
      // Contato apagado no Bling: registra como desconhecido para não ficar tentando
      // de novo a cada sincronização. Qualquer outro erro interrompe de verdade.
      if (!e || e.status !== 404) throw e;
    }
    const nome = texto(valor(dados || {}, ["nome", "razaoSocial", "fantasia"])) || "(fornecedor não encontrado)";
    await sql`
      insert into flow.bling_contato (id, nome, raw, atualizado_em)
      values (${linha.id}, ${nome}, ${sql.json(dados || {})}, now())
      on conflict (id) do update set nome = excluded.nome, raw = excluded.raw, atualizado_em = now()
    `;
    await sql`update flow.bling_conta set contato = ${nome} where raw->'contato'->>'id' = ${linha.id}`;
    gravados++;
  }
  return { registros: gravados, truncado: parou || gravados < pendentes.length };
}

// ── Sincronização completa ───────────────────────────────────────────────────
// Uma entidade que falha não derruba as outras: cada uma vira uma linha do
// relatório, com o erro que o próprio Bling devolveu.

const TAREFAS = [
  { chave: "produtos",     rotulo: "Produtos",       executar: sincronizarProdutos },
  { chave: "estoque",      rotulo: "Estoque",        executar: sincronizarEstoque },
  { chave: "contas_pagar", rotulo: "Contas a pagar", executar: sincronizarContasPagar },
  { chave: "contatos",     rotulo: "Fornecedores",    executar: sincronizarContatos },
];

// A função tem tempo máximo no Vercel; 45s deixa margem para responder. O prazo é
// repartido entre as entidades que ainda faltam, para nenhuma monopolizar o tempo.
const PRAZO_TOTAL_MS = 45000;

export async function sincronizarTudo(somente) {
  const alvo = Array.isArray(somente) && somente.length
    ? TAREFAS.filter(function(t) { return somente.includes(t.chave); })
    : TAREFAS;
  const fimGeral = Date.now() + PRAZO_TOTAL_MS;
  const relatorio = [];
  let restantes = alvo.length;
  for (const tarefa of alvo) {
    // Reserva o tempo das etapas que ainda faltam antes de repartir o que sobra.
    // Sem isso, as primeiras (que sempre têm mais páginas) comiam o prazo inteiro e
    // a última recebia um prazo já vencido — foi o que deixou Fornecedores em zero.
    const reservaDosOutros = (restantes - 1) * 8000;
    const disponivel = fimGeral - Date.now() - reservaDosOutros;
    const fatia = Math.max(6000, disponivel);
    restantes--;
    try {
      const r = await tarefa.executar(Math.min(fimGeral, Date.now() + fatia));
      relatorio.push({
        chave: tarefa.chave, rotulo: tarefa.rotulo, ok: true,
        registros: r.registros, ignorados: r.ignorados || 0, truncado: !!r.truncado,
        desdePagina: r.desdePagina || 1,
      });
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
