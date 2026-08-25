// api/_lib/db.js
// Conexão direta com o Postgres do Supabase (via pooler de transação), usada pelo
// adaptador do /api/ml/_sync. Fica SOMENTE no servidor: a connection string (com senha)
// vem de SUPABASE_DB_URL (env var do Vercel). Enquanto essa env não estiver configurada,
// dbEnabled() é false e o sistema segue 100% no Vercel KV — deploy seguro sem quebrar nada.

import postgres from "postgres";

let _sql = null;

// true quando o Supabase está configurado no servidor.
export function dbEnabled() {
  return !!process.env.SUPABASE_DB_URL;
}

function getSql() {
  if (!dbEnabled()) return null;
  if (!_sql) {
    _sql = postgres(process.env.SUPABASE_DB_URL, {
      prepare: false,      // pooler em modo transação não suporta prepared statements
      ssl: "require",
      idle_timeout: 20,
      // Antes era 1. Com uma conexão só, uma consulta presa (função encerrada no meio
      // de uma gravação) deixava a instância inteira na fila atrás dela. Com folga, o
      // pedido seguinte usa outra conexão em vez de travar junto.
      max: 3,
      // Sem estes dois, uma conexão que não estabelece deixa a consulta esperando
      // para sempre — e a função inteira morre por tempo esgotado, sem dizer o motivo.
      connect_timeout: 10, // segundos para abrir a conexão
      max_lifetime: 60 * 5,
    });
  }
  return _sql;
}

// Cliente SQL cru (postgres.js) para módulos que precisam de queries próprias (ex.: mlsync).
// Retorna null se o Supabase não estiver configurado.
export function sqlClient() { return getSql(); }

// Lista as conexões com o Mercado Livre (uma por conta) — usada pelo cron para sincronizar
// cada conta sem o usuário estar logado.
export async function listConexoesMl() {
  const sql = getSql();
  if (!sql) return [];
  return await sql`select seller_id, access_token, refresh_token, expira_em from flow.conexao_ml`;
}

// Busca a conexão ML de uma conta (para o webhook pegar o token e sincronizar em tempo real).
export async function getConexaoMl(sellerId) {
  const sql = getSql();
  if (!sql) return null;
  const rows = await sql`select seller_id, access_token, refresh_token, expira_em from flow.conexao_ml where seller_id=${String(sellerId)} limit 1`;
  return rows.length ? rows[0] : null;
}

// Lê uma página de anúncios do cache (raw = item ML completo, mesma shape do fetchAllListings).
export async function listCacheListings(sellerId, limit, offset) {
  const sql = getSql();
  if (!sql) return [];
  return await sql`select raw from flow.ml_listing where seller_id=${String(sellerId)} order by id limit ${limit} offset ${offset}`;
}

// Lê uma página de pedidos do cache (raw = pedido ML completo, mesma shape do fetchAllOrders).
export async function listCacheOrders(sellerId, limit, offset) {
  const sql = getSql();
  if (!sql) return [];
  return await sql`select raw from flow.ml_order where seller_id=${String(sellerId)} order by date_created desc nulls last limit ${limit} offset ${offset}`;
}

// Guarda/atualiza o token do ML de uma conta em flow.conexao_ml, para o servidor
// (cron/webhook) sincronizar sem o usuário estar logado. Preserva o refresh_token antigo
// se o novo vier vazio.
export async function upsertConexaoMl(sellerId, accessToken, refreshToken, expiraEmMs) {
  const sql = getSql();
  if (!sql) return false;
  const expira = expiraEmMs ? new Date(expiraEmMs).toISOString() : null;
  await sql`
    insert into flow.conexao_ml (seller_id, access_token, refresh_token, expira_em, atualizado_em)
    values (${String(sellerId)}, ${accessToken}, ${refreshToken}, ${expira}, now())
    on conflict (seller_id) do update set
      access_token = excluded.access_token,
      refresh_token = coalesce(excluded.refresh_token, flow.conexao_ml.refresh_token),
      expira_em = excluded.expira_em,
      atualizado_em = now()
  `;
  return true;
}

// Lê um valor de negócio do flow.sync_store. Retorna o valor (jsonb → objeto) ou null.
export async function syncGet(ns, chave) {
  const sql = getSql();
  if (!sql) return null;
  const rows = await sql`select valor from flow.sync_store where ns = ${ns} and chave = ${chave} limit 1`;
  return rows.length ? rows[0].valor : null;
}

// Grava (upsert) um valor de negócio no flow.sync_store.
export async function syncSet(ns, chave, valor) {
  const sql = getSql();
  if (!sql) return false;
  await sql`
    insert into flow.sync_store (ns, chave, valor)
    values (${ns}, ${chave}, ${sql.json(valor)})
    on conflict (ns, chave) do update set valor = excluded.valor, atualizado_em = now()
  `;
  return true;
}

// ── Usuários do sistema ──────────────────────────────────────────────────────
// Ficavam SÓ no Vercel KV: sem KV configurado, criar usuário respondia ok e o
// cadastro se perdia, enquanto o resto do sistema seguia funcionando pelo Postgres.
// Aqui eles passam a viver na mesma base dos outros dados.

// Converte a linha do banco para o formato usado pelo app.
function usuarioDaLinha(r) {
  return {
    id: r.id,
    nome: r.nome || "",
    usuario: r.usuario || "",
    email: r.email || "",
    senhaHash: r.senha_hash || null,
    ativo: r.ativo !== false,
    admin: r.admin === true,
    permissoes: Array.isArray(r.permissoes) ? r.permissoes : [],
    criadoEm: r.criado_em ? new Date(r.criado_em).toISOString().slice(0, 10) : null,
  };
}

export async function lerUsuariosDb() {
  const sql = getSql();
  if (!sql) return [];
  const rows = await sql`
    select id, nome, usuario, email, senha_hash, ativo, admin, permissoes, criado_em
    from flow.usuario order by criado_em
  `;
  return rows.map(usuarioDaLinha);
}

// Grava a lista inteira: faz upsert de cada usuário e apaga quem saiu dela.
// Tudo numa transação — uma falha no meio não deixa a equipe pela metade.
export async function salvarUsuariosDb(usuarios) {
  const sql = getSql();
  if (!sql) return false;
  const lista = (usuarios || []).filter(function(u) { return u && u.id; });
  await sql.begin(async function(tx) {
    for (const u of lista) {
      await tx`
        insert into flow.usuario (id, nome, usuario, email, senha_hash, ativo, admin, permissoes, criado_em)
        values (
          ${String(u.id)}, ${u.nome || ""}, ${u.usuario || ""}, ${u.email || null},
          ${u.senhaHash || null}, ${u.ativo !== false}, ${u.admin === true},
          ${sql.array(Array.isArray(u.permissoes) ? u.permissoes : [])},
          ${u.criadoEm ? new Date(u.criadoEm).toISOString() : new Date().toISOString()}
        )
        on conflict (id) do update set
          nome = excluded.nome,
          usuario = excluded.usuario,
          email = excluded.email,
          -- senha só é trocada quando veio uma nova; senão mantém a que está gravada
          senha_hash = coalesce(excluded.senha_hash, flow.usuario.senha_hash),
          ativo = excluded.ativo,
          admin = excluded.admin,
          permissoes = excluded.permissoes
      `;
    }
    const ids = lista.map(function(u) { return String(u.id); });
    if (ids.length) await tx`delete from flow.usuario where id <> all(${sql.array(ids)})`;
    else await tx`delete from flow.usuario`;
  });
  return true;
}
