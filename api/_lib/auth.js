// api/_lib/auth.js
// Autenticação do aplicativo (usuários internos) — usada por app-login, ml.js e ai-chat.js.
// Arquivos/pastas iniciados com "_" dentro de /api não viram rotas no Vercel, só podem ser importados.

import crypto from "node:crypto";

const USERS_KEY = "mlmargem_users";
const SECRET_KEY = "mlmargem_session_secret";
const COOKIE_NAME = "app_session";
const SESSION_MAX_AGE = 7 * 24 * 60 * 60; // 7 dias, em segundos

// ── KV (Upstash/Vercel KV via REST) ──────────────────────────

export async function kvGet(key) {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return null;
  try {
    const r = await fetch(process.env.KV_REST_API_URL + "/get/" + key, {
      headers: { Authorization: "Bearer " + process.env.KV_REST_API_TOKEN },
    });
    const d = await r.json();
    if (d && d.result) return JSON.parse(d.result);
  } catch {}
  return null;
}

export async function kvSet(key, value) {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return false;
  try {
    // A API REST do Upstash/Vercel KV usa o corpo da requisição como o próprio valor a gravar
    await fetch(process.env.KV_REST_API_URL + "/set/" + key, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + process.env.KV_REST_API_TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(value),
    });
    return true;
  } catch {}
  return false;
}

// ── Conexão com o Mercado Livre, ISOLADA por usuário do sistema ──────────────
// Cada usuário do app tem a sua própria conexão com o ML (seu próprio token),
// para que duas contas diferentes do Mercado Livre possam ser usadas ao mesmo
// tempo sem uma derrubar a outra. Chave no KV: mlmargem_ml_token_<uid>.
export function mlTokenKey(uid) { return "mlmargem_ml_token_" + uid; }

export async function lerMLToken(uid) {
  if (!uid) return null;
  return await kvGet(mlTokenKey(uid));
}

export async function salvarMLToken(uid, tokenData) {
  if (!uid) return false;
  return await kvSet(mlTokenKey(uid), tokenData);
}

// ── Senhas ───────────────────────────────────────────────────
// Formato novo: "s2$<salt hex>$<scrypt hex>". Hashes antigos (número simples,
// gerados pelo hash fraco que rodava no navegador) continuam aceitos no login
// e são atualizados para scrypt na primeira autenticação bem-sucedida.

function hashLegacy(senha) {
  let hash = 0;
  for (let i = 0; i < senha.length; i++) {
    const char = senha.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return String(Math.abs(hash)) + senha.length;
}

export function hashSenha(senha) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(senha), salt, 32).toString("hex");
  return "s2$" + salt + "$" + hash;
}

export function verificarSenha(senha, stored) {
  if (!senha || !stored) return { ok: false, precisaUpgrade: false };
  if (stored.startsWith("s2$")) {
    const partes = stored.split("$");
    if (partes.length !== 3) return { ok: false, precisaUpgrade: false };
    const calc = crypto.scryptSync(String(senha), partes[1], 32).toString("hex");
    const a = Buffer.from(calc, "hex");
    const b = Buffer.from(partes[2], "hex");
    const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
    return { ok, precisaUpgrade: false };
  }
  return { ok: hashLegacy(String(senha)) === stored, precisaUpgrade: true };
}

// ── Usuários ─────────────────────────────────────────────────

function adminPadrao() {
  // Sem KV configurado (ou primeira execução) existe apenas o admin inicial.
  // Defina ADMIN_INITIAL_PASSWORD nas variáveis de ambiente do Vercel; sem ela
  // a senha inicial é "admin123" e deve ser trocada no primeiro acesso.
  const senha = process.env.ADMIN_INITIAL_PASSWORD || "admin123";
  return [{
    id: "admin",
    nome: "Administrador",
    usuario: "admin",
    senhaHash: hashLegacy(senha),
    ativo: true,
    admin: true,
    permissoes: ["overview", "listings", "orders", "financeiro", "produtos", "admin", "nfe", "full"],
    criadoEm: new Date().toISOString().slice(0, 10),
  }];
}

let _usersCache = null;

export async function lerUsuarios() {
  const kv = await kvGet(USERS_KEY);
  if (Array.isArray(kv) && kv.length > 0) return kv;
  return _usersCache || adminPadrao();
}

export async function salvarUsuarios(usuarios) {
  _usersCache = usuarios;
  await kvSet(USERS_KEY, usuarios);
}

export function semSenha(u) {
  const s = Object.assign({}, u);
  delete s.senhaHash;
  return s;
}

// ── Sessão (cookie assinado com HMAC) ────────────────────────

let _secretCache = null;

async function getSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (_secretCache) return _secretCache;
  let s = await kvGet(SECRET_KEY);
  if (!s || typeof s !== "string") {
    s = crypto.randomBytes(32).toString("hex");
    await kvSet(SECRET_KEY, s);
  }
  _secretCache = s;
  return s;
}

function assinar(payload, secret) {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

export async function criarCookieSessao(user) {
  const secret = await getSecret();
  const payload = Buffer.from(JSON.stringify({
    uid: user.id,
    usuario: user.usuario,
    admin: !!user.admin,
    exp: Date.now() + SESSION_MAX_AGE * 1000,
  })).toString("base64url");
  const sig = assinar(payload, secret);
  return COOKIE_NAME + "=" + payload + "." + sig +
    "; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=" + SESSION_MAX_AGE;
}

export function cookieLogout() {
  return COOKIE_NAME + "=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0";
}

// Retorna o payload da sessão ({uid, usuario, admin, exp}) ou null.
export async function verificarSessao(req) {
  try {
    const cookies = Object.fromEntries(
      (req.headers.cookie || "").split(";").map(c => {
        const [k, ...v] = c.trim().split("=");
        return [k.trim(), v.join("=")];
      })
    );
    const raw = cookies[COOKIE_NAME];
    if (!raw) return null;
    const dot = raw.lastIndexOf(".");
    if (dot === -1) return null;
    const payload = raw.slice(0, dot);
    const sig = raw.slice(dot + 1);
    const secret = await getSecret();
    const esperado = assinar(payload, secret);
    const a = Buffer.from(sig);
    const b = Buffer.from(esperado);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const dados = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (!dados || !dados.uid || Date.now() > dados.exp) return null;
    return dados;
  } catch {
    return null;
  }
}
