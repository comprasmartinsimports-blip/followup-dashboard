// api/_lib/bling.js
// Integração com a API v3 do Bling (OAuth 2.0 — Authorization Code).
// Tudo aqui roda SOMENTE no servidor: o client_secret e os tokens nunca chegam
// ao navegador. A conexão fica em flow.conexao_bling, ao lado dos demais dados.

import { sqlClient } from "./db.js";

// ── Endereços da API ─────────────────────────────────────────────────────────
// Reunidos num só lugar de propósito: se o Bling mudar algum caminho, é uma
// linha para corrigir, e o /api/bling/diagnostico aponta qual deles falhou.
export const BLING = {
  autorizar: "https://www.bling.com.br/Api/v3/oauth/authorize",
  token: "https://www.bling.com.br/Api/v3/oauth/token",
  api: "https://api.bling.com.br/Api/v3",
};

// Endpoints por entidade. limite=100 é o teto por página na v3.
export const ENTIDADES = {
  produtos:        { caminho: "/produtos",         rotulo: "Produtos" },
  estoques:        { caminho: "/estoques/saldos",  rotulo: "Estoque" },
  contas_pagar:    { caminho: "/contas/pagar",     rotulo: "Contas a pagar" },
  contas_receber:  { caminho: "/contas/receber",   rotulo: "Contas a receber" },
  notas:           { caminho: "/nfe",              rotulo: "Notas fiscais" },
};

export class ErroBling extends Error {
  constructor(mensagem, status) {
    super(mensagem);
    this.name = "ErroBling";
    this.status = status || 0;
  }
}

export function blingConfigurado() {
  return !!(process.env.BLING_CLIENT_ID && process.env.BLING_CLIENT_SECRET && process.env.BLING_REDIRECT_URI);
}

function credencialBasica() {
  const par = process.env.BLING_CLIENT_ID + ":" + process.env.BLING_CLIENT_SECRET;
  return "Basic " + Buffer.from(par).toString("base64");
}

// URL para onde o usuário é mandado para autorizar o aplicativo.
export function urlAutorizacao(state) {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: process.env.BLING_CLIENT_ID,
    redirect_uri: process.env.BLING_REDIRECT_URI,
    state: state || "flow",
  });
  return BLING.autorizar + "?" + q.toString();
}

// ── Conexão guardada ─────────────────────────────────────────────────────────

export async function lerConexao() {
  const sql = sqlClient();
  if (!sql) throw new ErroBling("Banco não configurado (SUPABASE_DB_URL).", 0);
  const rows = await sql`
    select access_token, refresh_token, expira_em, atualizado_em
    from flow.conexao_bling where id = 'bling' limit 1
  `;
  return rows.length ? rows[0] : null;
}

export async function salvarConexao(accessToken, refreshToken, expiraEmMs) {
  const sql = sqlClient();
  if (!sql) throw new ErroBling("Banco não configurado (SUPABASE_DB_URL).", 0);
  const expira = expiraEmMs ? new Date(expiraEmMs).toISOString() : null;
  await sql`
    insert into flow.conexao_bling (id, access_token, refresh_token, expira_em, atualizado_em)
    values ('bling', ${accessToken}, ${refreshToken}, ${expira}, now())
    on conflict (id) do update set
      access_token = excluded.access_token,
      -- o Bling nem sempre devolve refresh novo: preserva o que já vale
      refresh_token = coalesce(excluded.refresh_token, flow.conexao_bling.refresh_token),
      expira_em = excluded.expira_em,
      atualizado_em = now()
  `;
  return true;
}

export async function apagarConexao() {
  const sql = sqlClient();
  if (!sql) return false;
  await sql`delete from flow.conexao_bling where id = 'bling'`;
  return true;
}

// Troca o código de autorização (ou o refresh token) por um access_token.
async function pedirToken(corpo) {
  let res;
  try {
    res = await fetch(BLING.token, {
      method: "POST",
      headers: {
        Authorization: credencialBasica(),
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams(corpo),
    });
  } catch (e) {
    throw new ErroBling("Não foi possível falar com o Bling: " + ((e && e.message) || "falha de rede"), 0);
  }
  const texto = await res.text();
  let dados = {};
  try { dados = texto ? JSON.parse(texto) : {}; } catch { /* resposta não-JSON cai no erro abaixo */ }
  if (!res.ok || dados.error || !dados.access_token) {
    const detalhe = dados.error_description || dados.error ||
      (texto ? texto.slice(0, 300) : "sem detalhes");
    throw new ErroBling("O Bling recusou o token (HTTP " + res.status + "): " + detalhe, res.status);
  }
  return dados;
}

export async function trocarCodigoPorToken(code) {
  const dados = await pedirToken({
    grant_type: "authorization_code",
    code: code,
    redirect_uri: process.env.BLING_REDIRECT_URI,
  });
  const validade = (parseInt(dados.expires_in, 10) || 21600) * 1000;
  await salvarConexao(dados.access_token, dados.refresh_token || null, Date.now() + validade);
  return dados;
}

async function renovarToken(refreshToken) {
  const dados = await pedirToken({ grant_type: "refresh_token", refresh_token: refreshToken });
  const validade = (parseInt(dados.expires_in, 10) || 21600) * 1000;
  await salvarConexao(dados.access_token, dados.refresh_token || refreshToken, Date.now() + validade);
  return dados.access_token;
}

// Devolve um access_token válido, renovando quando estiver perto de expirar.
export async function garantirToken() {
  const con = await lerConexao();
  if (!con || !con.access_token) {
    throw new ErroBling("Bling não conectado. Use o botão Conectar em Integrações.", 401);
  }
  const expira = con.expira_em ? new Date(con.expira_em).getTime() : 0;
  // 5 minutos de folga: evita usar um token que expira no meio da sincronização.
  if (expira && expira - Date.now() > 5 * 60 * 1000) return con.access_token;
  if (!con.refresh_token) {
    throw new ErroBling("A autorização do Bling expirou e não há refresh token. Conecte novamente.", 401);
  }
  return await renovarToken(con.refresh_token);
}

// Uma chamada à API já autenticada. Devolve o JSON; lança ErroBling com a
// mensagem do próprio Bling quando a resposta não é 2xx.
export async function chamarBling(caminho, params, token) {
  const acesso = token || (await garantirToken());
  const q = new URLSearchParams(params || {});
  const url = BLING.api + caminho + (q.toString() ? "?" + q.toString() : "");
  let res;
  try {
    res = await fetch(url, {
      headers: { Authorization: "Bearer " + acesso, Accept: "application/json" },
    });
  } catch (e) {
    throw new ErroBling("Falha de rede ao chamar " + caminho + ": " + ((e && e.message) || "erro"), 0);
  }
  const texto = await res.text();
  let dados = null;
  try { dados = texto ? JSON.parse(texto) : null; } catch { /* tratado abaixo */ }
  if (!res.ok) {
    const erro = dados && dados.error;
    const detalhe = (erro && (erro.description || erro.message || erro.type)) ||
      (texto ? texto.slice(0, 300) : "sem detalhes");
    throw new ErroBling(caminho + " respondeu HTTP " + res.status + ": " + detalhe, res.status);
  }
  if (dados == null) throw new ErroBling(caminho + " devolveu uma resposta vazia ou inválida.", res.status);
  return dados;
}

// Percorre as páginas de um endpoint de listagem. Para quando a página vem vazia,
// quando o total pedido é atingido ou no teto de páginas — nunca em laço infinito.
export async function listarPaginado(caminho, params, opcoes) {
  const cfg = opcoes || {};
  const maxPaginas = cfg.maxPaginas || 50;
  const limite = cfg.limite || 100;
  const token = await garantirToken();
  const itens = [];
  let pagina = 1;
  for (; pagina <= maxPaginas; pagina++) {
    const resposta = await chamarBling(caminho, Object.assign({}, params, { pagina, limite }), token);
    const lote = Array.isArray(resposta.data) ? resposta.data : [];
    itens.push(...lote);
    if (lote.length < limite) break;
  }
  return { itens, paginas: Math.min(pagina, maxPaginas), truncado: pagina > maxPaginas };
}
