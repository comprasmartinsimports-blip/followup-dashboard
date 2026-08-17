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
      max: 1,              // serverless: 1 conexão por invocação
    });
  }
  return _sql;
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
