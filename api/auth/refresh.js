// api/auth/refresh.js
// Renova o access_token usando o refresh_token.
// A conexão do ML é ISOLADA por usuário do sistema: o fallback e a regravação no KV
// usam o token do PRÓPRIO usuário logado (mlmargem_ml_token_<uid>).

import { verificarSessao, lerMLToken, salvarMLToken } from "../_lib/auth.js";

export default async function handler(req, res) {
  const APP_ID = process.env.ML_APP_ID;
  const APP_SECRET = process.env.ML_APP_SECRET;

  // Pegar refresh_token do cookie
  const cookies = Object.fromEntries(
    (req.headers.cookie || "").split(";").map(c => {
      const [k, ...v] = c.trim().split("=");
      return [k, v.join("=")];
    })
  );

  const sessao = await verificarSessao(req);
  let refreshToken = cookies.ml_refresh_token;
  let viaShared = false;

  // Sem cookie próprio → usa o refresh_token do MESMO usuário do sistema (não de outra conta).
  if (!refreshToken && sessao && sessao.uid) {
    const meu = await lerMLToken(sessao.uid);
    if (meu && meu.refreshToken) {
      refreshToken = meu.refreshToken;
      viaShared = true;
    }
  }

  if (!refreshToken) {
    return res.status(401).json({ error: "refresh_token não encontrado" });
  }

  try {
    const response = await fetch("https://api.mercadolibre.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: APP_ID,
        client_secret: APP_SECRET,
        refresh_token: refreshToken,
      }),
    });

    const data = await response.json();

    if (data.error) {
      // Refresh inválido — limpar cookies deste navegador (não mexe na conexão salva no KV,
      // que pode ter sido renovada por outro navegador do mesmo usuário nesse meio tempo)
      if (!viaShared) {
        res.setHeader("Set-Cookie", [
          "ml_access_token=; HttpOnly; Secure; Path=/; Max-Age=0",
          "ml_refresh_token=; HttpOnly; Secure; Path=/; Max-Age=0",
          "ml_user_id=; HttpOnly; Secure; Path=/; Max-Age=0",
          "ml_expires_at=; Path=/; Max-Age=0",
        ]);
      }
      return res.status(401).json({ error: data.error_description || data.error });
    }

    const maxAge = data.expires_in || 21600;

    // Atualizar cookies deste navegador com os novos tokens
    res.setHeader("Set-Cookie", [
      `ml_access_token=${data.access_token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`,
      `ml_refresh_token=${data.refresh_token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`,
      `ml_user_id=${data.user_id || cookies.ml_user_id}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`,
      `ml_expires_at=${Date.now() + maxAge * 1000}; Path=/; Max-Age=${maxAge}`,
    ]);

    // Mantém a conexão do PRÓPRIO usuário atualizada no KV (para outros navegadores dele).
    if (sessao && sessao.uid) {
      await salvarMLToken(sessao.uid, {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        userId: data.user_id || cookies.ml_user_id,
        expiresAt: Date.now() + maxAge * 1000,
      });
    }

    return res.json({
      access_token: data.access_token,
      user_id: data.user_id || cookies.ml_user_id,
      expires_in: maxAge,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
