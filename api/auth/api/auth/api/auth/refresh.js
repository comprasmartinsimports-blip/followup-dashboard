// api/auth/refresh.js
// Renova o access_token usando o refresh_token
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

  const refreshToken = cookies.ml_refresh_token;

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
      // Refresh inválido — limpar cookies
      res.setHeader("Set-Cookie", [
        "ml_access_token=; HttpOnly; Secure; Path=/; Max-Age=0",
        "ml_refresh_token=; HttpOnly; Secure; Path=/; Max-Age=0",
        "ml_user_id=; HttpOnly; Secure; Path=/; Max-Age=0",
        "ml_expires_at=; Path=/; Max-Age=0",
      ]);
      return res.status(401).json({ error: data.error_description || data.error });
    }

    const maxAge = data.expires_in || 21600;

    // Atualizar cookies com novos tokens
    res.setHeader("Set-Cookie", [
      `ml_access_token=${data.access_token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`,
      `ml_refresh_token=${data.refresh_token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`,
      `ml_expires_at=${Date.now() + maxAge * 1000}; Path=/; Max-Age=${maxAge}`,
    ]);

    return res.json({
      access_token: data.access_token,
      user_id: data.user_id || cookies.ml_user_id,
      expires_in: maxAge,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
