// api/ml.js
// Proxy para a API do Mercado Livre — usa token do cookie automaticamente
export default async function handler(req, res) {
  // Pegar token: 1) cookie httpOnly, 2) header Authorization (modo manual legado)
  const cookies = Object.fromEntries(
    (req.headers.cookie || "").split(";").map(c => {
      const [k, ...v] = c.trim().split("=");
      return [k.trim(), v.join("=")];
    })
  );

  let token = cookies.ml_access_token;

  // Fallback para header Authorization (compatibilidade com modo manual)
  if (!token && req.headers.authorization) {
    token = req.headers.authorization.replace("Bearer ", "");
  }

  if (!token) {
    return res.status(401).json({ error: "Não autenticado. Faça login com o Mercado Livre." });
  }

  const path = req.url.replace(/^\/api\/ml/, "");
  const mlUrl = `https://api.mercadolibre.com${path}`;

  try {
    const mlRes = await fetch(mlUrl, {
      method: req.method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: req.method !== "GET" && req.method !== "HEAD" ? JSON.stringify(req.body) : undefined,
    });

    // Se token expirou, tentar renovar automaticamente
    if (mlRes.status === 401) {
      const refreshToken = cookies.ml_refresh_token;
      if (refreshToken) {
        try {
          const refreshRes = await fetch(`${process.env.VERCEL_URL ? "https://" + process.env.VERCEL_URL : ""}/api/auth/refresh`, {
            method: "POST",
            headers: { cookie: req.headers.cookie || "" },
          });
          if (refreshRes.ok) {
            const refreshData = await refreshRes.json();
            // Tentar novamente com o novo token
            const retryRes = await fetch(mlUrl, {
              method: req.method,
              headers: {
                Authorization: `Bearer ${refreshData.access_token}`,
                "Content-Type": "application/json",
                "Accept": "application/json",
              },
              body: req.method !== "GET" ? JSON.stringify(req.body) : undefined,
            });
            // Passar Set-Cookie do refresh
            const setCookie = refreshRes.headers.get("set-cookie");
            if (setCookie) res.setHeader("Set-Cookie", setCookie);
            const data = await retryRes.json();
            return res.status(retryRes.status).json(data);
          }
        } catch (e) {}
      }
      return res.status(401).json({ error: "Token expirado. Reconecte ao Mercado Livre." });
    }

    const data = await mlRes.json();
    return res.status(mlRes.status).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
