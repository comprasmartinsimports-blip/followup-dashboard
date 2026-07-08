// api/_kv.js
// Helper de leitura/escrita no Vercel KV, compartilhado entre as functions de auth e o proxy do ML.
// Arquivos que começam com "_" dentro de /api NÃO são tratados como rotas pela Vercel,
// então este arquivo não conta para o limite de Serverless Functions do plano.

export async function kvGet(key) {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return null;
  try {
    const r = await fetch(process.env.KV_REST_API_URL + "/get/" + key, {
      headers: { Authorization: "Bearer " + process.env.KV_REST_API_TOKEN },
    });
    const d = await r.json();
    if (d && d.result) return JSON.parse(d.result);
  } catch {}
  return null;
}

export async function kvSet(key, value) {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return false;
  try {
    await fetch(process.env.KV_REST_API_URL + "/set/" + key, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + process.env.KV_REST_API_TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ value: JSON.stringify(value) }),
    });
    return true;
  } catch {}
  return false;
}

// Chave única onde fica a conexão ML compartilhada por toda a equipe.
export const SHARED_ML_TOKEN_KEY = "mlmargem_shared_ml_token";
