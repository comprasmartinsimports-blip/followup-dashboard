// api/auth/session.js
// Retorna se o usuário está autenticado no ML e dados básicos da sessão.
// A conexão do ML é ISOLADA por usuário do sistema — o fallback do KV usa o
// token do PRÓPRIO usuário logado (mlmargem_ml_token_<uid>), nunca o de outra conta.

import { verificarSessao, lerMLToken } from "../_lib/auth.js";

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

  // Se este navegador não tem cookie próprio, herda a conexão do MESMO usuário do
  // sistema (ex: o usuário abriu em outro navegador). Nunca herda a de outro usuário.
  if (!accessToken || !userId) {
    const sessao = await verificarSessao(req);
    if (sessao && sessao.uid) {
      const meu = await lerMLToken(sessao.uid);
      if (meu && meu.accessToken && meu.userId) {
        accessToken = meu.accessToken;
        userId = meu.userId;
        expiresAt = meu.expiresAt || 0;
        viaShared = true;
      }
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
