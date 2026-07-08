// api/auth/session.js
// Retorna se o usuário está autenticado e dados básicos da sessão
import { kvGet, SHARED_ML_TOKEN_KEY } from "../_kv.js";

export default async function handler(req, res) {
  const cookies = Object.fromEntries(
    (req.headers.cookie || "").split(";").map(c => {
      const [k, ...v] = c.trim().split("=");
      return [k.trim(), v.join("=")];
    })
  );

  let accessToken = cookies.ml_access_token;
  let userId = cookies.ml_user_id;
  let expiresAt = parseInt(cookies.ml_expires_at || "0");
  let viaShared = false;

  // Se este navegador nunca conectou (sem cookie), usa a conexão compartilhada da equipe —
  // assim qualquer usuário do sistema já entra conectado ao ML automaticamente.
  if (!accessToken || !userId) {
    const shared = await kvGet(SHARED_ML_TOKEN_KEY);
    if (shared && shared.accessToken && shared.userId) {
      accessToken = shared.accessToken;
      userId = shared.userId;
      expiresAt = shared.expiresAt || 0;
      viaShared = true;
    }
  }

  if (!accessToken || !userId) {
    return res.json({ authenticated: false });
  }

  // Verificar se o token está próximo de expirar (menos de 10 minutos)
  const expiresInMs = expiresAt - Date.now();
  const almostExpired = expiresInMs < 10 * 60 * 1000;

  return res.json({
    authenticated: true,
    userId,
    accessToken,
    expiresAt,
    almostExpired,
    sharedConnection: viaShared,
  });
}
