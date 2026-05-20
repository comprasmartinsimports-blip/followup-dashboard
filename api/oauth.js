// api/oauth.js — Vercel Serverless Function
// Processa OAuth do Mercado Livre com segurança (Client Secret fica no servidor)

export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const CLIENT_ID     = process.env.ML_CLIENT_ID;
  const CLIENT_SECRET = process.env.ML_CLIENT_SECRET;

  if (!CLIENT_ID || !CLIENT_SECRET) {
    return res.status(500).json({ error: "Credenciais ML não configuradas no servidor" });
  }

  const { grant_type, code, refresh_token, redirect_uri } = req.body;

  let payload;
  if (grant_type === "authorization_code") {
    payload = new URLSearchParams({
      grant_type:    "authorization_code",
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      redirect_uri:  redirect_uri || "https://followup-dashboard.vercel.app",
    });
  } else if (grant_type === "refresh_token") {
    payload = new URLSearchParams({
      grant_type:    "refresh_token",
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token,
    });
  } else {
    return res.status(400).json({ error: "grant_type inválido" });
  }

  try {
    const response = await fetch("https://api.mercadolibre.com/oauth/token", {
      method:  "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
      body:    payload.toString(),
    });
    const data = await response.json();
    if (!response.ok) {
      return res.status(response.status).json(data);
    }
    return res.status(200).json(data);
  } catch (e) {
    return res.status(500).json({ error: "Erro ao conectar com ML: " + e.message });
  }
}
