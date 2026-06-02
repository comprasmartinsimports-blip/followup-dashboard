// api/auth/logout.js
export default function handler(req, res) {
  res.setHeader("Set-Cookie", [
    "ml_access_token=; HttpOnly; Secure; Path=/; Max-Age=0",
    "ml_refresh_token=; HttpOnly; Secure; Path=/; Max-Age=0",
    "ml_user_id=; HttpOnly; Secure; Path=/; Max-Age=0",
    "ml_expires_at=; Path=/; Max-Age=0",
  ]);
  res.redirect("/?auth=logout");
}
