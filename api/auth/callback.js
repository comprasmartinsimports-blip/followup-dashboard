// api/auth/callback.js
// Recebe o code do ML e troca por access_token + refresh_token.
// A conexão fica ISOLADA por usuário do sistema (mlmargem_ml_token_<uid>) — assim
// duas contas diferentes do Mercado Livre convivem sem uma derrubar a outra.

import { verificarSessao, salvarMLToken } from "../_lib/auth.js";

export default async function handler(req, res) {
  const { code } = req.query;
  const APP_ID = process.env.ML_APP_ID;
  const APP_SECRET = process.env.ML_APP_SECRET;
  const REDIRECT_URI = process.env.ML_REDIRECT_URI;

  if (!code) {
    return res.redirect("/?auth=error&msg=code_missing");
  }

  try {
    const response = await fetch("https://api.mercadolibre.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: APP_ID,
        client_secret: APP_SECRET,
        code: code,
        redirect_uri: REDIRECT_URI,
      }),
    });

    const data = await response.json();

    if (data.error) {
      console.error("ML OAuth error:", data);
      return res.redirect(`/?auth=error&msg=${encodeURIComponent(data.error_description || data.error)}`);
    }

    // Salvar tokens em cookies httpOnly seguros (para este navegador)
    const maxAge = data.expires_in || 21600; // 6 horas padrão

    res.setHeader("Set-Cookie", [
      `ml_access_token=${data.access_token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`,
      `ml_refresh_token=${data.refresh_token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`,
      `ml_user_id=${data.user_id}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`,
      `ml_expires_at=${Date.now() + maxAge * 1000}; Path=/; Max-Age=${maxAge}`,
    ]);

    // Guarda a conexão no KV SOMENTE para o usuário do sistema que fez o login (isolada).
    // Outros usuários (em outros navegadores) só herdam essa conexão se forem o MESMO usuário.
    const sessao = await verificarSessao(req);
    if (sessao && sessao.uid) {
      await salvarMLToken(sessao.uid, {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        userId: data.user_id,
        expiresAt: Date.now() + maxAge * 1000,
      });
    }

    // Redirecionar de volta ao dashboard
    return res.redirect("/?auth=success");
  } catch (err) {
    console.error("Callback error:", err);
    return res.redirect(`/?auth=error&msg=${encodeURIComponent(err.message)}`);
  }
}
