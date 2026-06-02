// api/auth/login.js
// Redireciona o usuário para a página de autorização do Mercado Livre
export default function handler(req, res) {
  const APP_ID = process.env.ML_APP_ID;
  const REDIRECT_URI = process.env.ML_REDIRECT_URI;

  if (!APP_ID || !REDIRECT_URI) {
    return res.status(500).json({ error: "ML_APP_ID ou ML_REDIRECT_URI não configurado nas variáveis de ambiente" });
  }

  const mlAuthUrl =
    `https://auth.mercadolivre.com.br/authorization` +
    `?response_type=code` +
    `&client_id=${APP_ID}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;

  res.redirect(302, mlAuthUrl);
}
