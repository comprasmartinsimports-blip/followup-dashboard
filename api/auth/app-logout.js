// api/auth/app-logout.js
// Encerra a sessão do usuário interno (limpa o cookie assinado).

import { cookieLogout } from "../_lib/auth.js";

export default function handler(req, res) {
  res.setHeader("Set-Cookie", cookieLogout());
  return res.status(200).json({ ok: true });
}
