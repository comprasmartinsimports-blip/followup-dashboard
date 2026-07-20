// api/ai-chat.js
// Proxy único para a API da Anthropic. A chave ANTHROPIC_API_KEY fica SOMENTE
// no servidor (variável de ambiente do Vercel) e o endpoint exige sessão do
// aplicativo — sem isso qualquer visitante poderia consumir a chave.

import { verificarSessao } from "./_lib/auth.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const sessao = await verificarSessao(req);
  if (!sessao) {
    return res.status(401).json({ error: "Não autenticado. Faça login no sistema." });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY não configurada no servidor" });
  }

  try {
    // max_tokens é opcional e limitado — o modelo é sempre definido aqui no servidor
    const maxTokens = Math.min(parseInt(req.body.max_tokens, 10) || 1024, 4096);
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: maxTokens,
        system: req.body.system,
        messages: req.body.messages,
      }),
    });
    const data = await r.json();
    return res.status(r.status).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
