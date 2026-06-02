// api/auth/session.js
// Retorna se o usuário está autenticado e dados básicos da sessão
export default function handler(req, res) {
  const cookies = Object.fromEntries(
    (req.headers.cookie || "").split(";").map(c => {
      const [k, ...v] = c.trim().split("=");
      return [k.trim(), v.join("=")];
    })
  );

  const accessToken = cookies.ml_access_token;
  const userId = cookies.ml_user_id;
  const expiresAt = parseInt(cookies.ml_expires_at || "0");

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
  });
}
