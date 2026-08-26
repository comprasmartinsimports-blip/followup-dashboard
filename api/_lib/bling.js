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
// Só o que o sistema realmente consome. Contas a receber, notas fiscais (entrada e
// saída) e histórico de vendas ficam de fora por decisão de escopo: nenhum endpoint
// desses é chamado, então esse dado nunca sai do Bling.
export const ENTIDADES = {
  produtos:        { caminho: "/produtos",         rotulo: "Produtos" },
  estoques:        { caminho: "/estoques/saldos",  rotulo: "Estoque" },
  contas_pagar:    { caminho: "/contas/pagar",     rotulo: "Contas a pagar" },
};

// Toda chamada ao Bling tem prazo. Sem isso, uma conexão que trava fica pendurada
// até a plataforma matar a função inteira por tempo esgotado (504), e o usuário
// recebe uma tela de erro genérica em vez do motivo real.
export const TEMPO_LIMITE_MS = 8000;

// A API do Bling limita requisições por segundo. Sem ritmo, a sincronização dispara
// as páginas em rajada e leva HTTP 429 já na primeira. 400ms entre chamadas fica
// com folga abaixo do limite.
const INTERVALO_ENTRE_CHAMADAS_MS = 400;
let proximaVaga = 0;

async function esperarVez() {
  const agora = Date.now();
  const quando = Math.max(agora, proximaVaga);
  proximaVaga = quando + INTERVALO_ENTRE_CHAMADAS_MS;
  const espera = quando - agora;
  if (espera > 0) await new Promise(function(r) { setTimeout(r, espera); });
}

function esperaDoCabecalho(res) {
  const bruto = res.headers && res.headers.get && res.headers.get("retry-after");
  const segundos = parseFloat(bruto);
  // Respeita o que o servidor pedir, com teto para não segurar a função até o limite.
  if (isFinite(segundos) && segundos > 0) return Math.min(segundos * 1000, 5000);
  return null;
}

// Prazo para QUALQUER operação, inclusive as do banco. A resposta ao usuário nunca
// deve depender de algo que pode não terminar: sem isto, a função morre por tempo
// esgotado e o navegador mostra uma tela de 504 sem explicação nenhuma.
export function comPrazo(promessa, ms, oQue) {
  let id;
  const limite = new Promise(function(_, rejeitar) {
    id = setTimeout(function() {
      rejeitar(new ErroBling((oQue || "A operação") + " não terminou em " + Math.round(ms / 1000) + "s.", 0));
    }, ms);
  });
  return Promise.race([promessa, limite]).finally(function() { clearTimeout(id); });
}

async function fetchComPrazo(url, opcoes, ms) {
  const prazo = ms || TEMPO_LIMITE_MS;
  try {
    return await fetch(url, Object.assign({}, opcoes, { signal: AbortSignal.timeout(prazo) }));
  } catch (e) {
    const abortou = e && (e.name === "TimeoutError" || e.name === "AbortError");
    throw new ErroBling(
      abortou
        ? "O Bling não respondeu em " + Math.round(prazo / 1000) + "s (" + url + ")."
        : "Não foi possível falar com o Bling (" + url + "): " + ((e && e.message) || "falha de rede"),
      0
    );
  }
}

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
  const rows = await comPrazo(sql`
    select access_token, refresh_token, expira_em, atualizado_em
    from flow.conexao_bling where id = 'bling' limit 1
  `, 10000, "A leitura da conexão no banco");
  return rows.length ? rows[0] : null;
}

export async function salvarConexao(accessToken, refreshToken, expiraEmMs) {
  const sql = sqlClient();
  if (!sql) throw new ErroBling("Banco não configurado (SUPABASE_DB_URL).", 0);
  const expira = expiraEmMs ? new Date(expiraEmMs).toISOString() : null;
  await comPrazo(sql`
    insert into flow.conexao_bling (id, access_token, refresh_token, expira_em, atualizado_em)
    values ('bling', ${accessToken}, ${refreshToken}, ${expira}, now())
    on conflict (id) do update set
      access_token = excluded.access_token,
      -- o Bling nem sempre devolve refresh novo: preserva o que já vale
      refresh_token = coalesce(excluded.refresh_token, flow.conexao_bling.refresh_token),
      expira_em = excluded.expira_em,
      atualizado_em = now()
  `, 10000, "A gravação da conexão no banco");
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
  const res = await fetchComPrazo(BLING.token, {
    method: "POST",
    headers: {
      Authorization: credencialBasica(),
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams(corpo),
  });
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
export async function chamarBling(caminho, params, token, tentativa) {
  const acesso = token || (await garantirToken());
  const q = new URLSearchParams(params || {});
  const url = BLING.api + caminho + (q.toString() ? "?" + q.toString() : "");
  await esperarVez();
  const res = await fetchComPrazo(url, {
    headers: { Authorization: "Bearer " + acesso, Accept: "application/json" },
  }, 15000);
  const texto = await res.text();
  let dados = null;
  try { dados = texto ? JSON.parse(texto) : null; } catch { /* tratado abaixo */ }
  if (!res.ok) {
    // 429 = pedimos rápido demais. Espera o que o servidor mandar (ou um pouco mais
    // a cada tentativa) e insiste, em vez de derrubar a entidade inteira por isso.
    const vez = tentativa || 1;
    if (res.status === 429 && vez <= 3) {
      const espera = esperaDoCabecalho(res) || vez * 1200;
      await new Promise(function(r) { setTimeout(r, espera); });
      return await chamarBling(caminho, params, acesso, vez + 1);
    }
    const erro = dados && dados.error;
    const detalhe = (erro && (erro.description || erro.message || erro.type)) ||
      (texto ? texto.slice(0, 300) : "sem detalhes");
    throw new ErroBling(
      caminho + " respondeu HTTP " + res.status + ": " + detalhe +
      (res.status === 429 ? " (já tentei de novo " + (vez - 1) + "x com pausa)" : ""),
      res.status
    );
  }
  if (dados == null) throw new ErroBling(caminho + " devolveu uma resposta vazia ou inválida.", res.status);
  return dados;
}

// Percorre as páginas de um endpoint de listagem. Para quando a página vem vazia,
// quando o total pedido é atingido ou no teto de páginas — nunca em laço infinito.
// Percorre as páginas respeitando um prazo. Quando o tempo acaba antes do fim da
// lista, devolve o que trouxe e a próxima página — a sincronização seguinte continua
// dali, em vez de recomeçar do zero e gastar o limite de requisições de novo.
export async function listarPaginado(caminho, params, opcoes) {
  const cfg = opcoes || {};
  const limite = cfg.limite || 100;
  const ate = cfg.ate || (Date.now() + 40000);
  const token = await garantirToken();
  const itens = [];
  let pagina = cfg.desdePagina || 1;
  let acabou = false;
  while (true) {
    const resposta = await chamarBling(caminho, Object.assign({}, params, { pagina, limite }), token);
    const lote = Array.isArray(resposta.data) ? resposta.data : [];
    itens.push(...lote);
    if (lote.length < limite) { acabou = true; pagina++; break; }
    pagina++;
    // Só continua se ainda houver tempo para mais uma volta com folga.
    if (Date.now() > ate - 3000) break;
  }
  return { itens, acabou, proximaPagina: acabou ? 1 : pagina, truncado: !acabou };
}

// Checagem de infraestrutura, sem depender de estar conectado: mede se o servidor
// alcança o Bling e se alcança o banco. Serve para separar "a API não responde"
// de "o banco não responde" quando o callback estoura o tempo.
export async function checarRede() {
  const resultado = { token: null, banco: null };

  const inicioToken = Date.now();
  try {
    // Um refresh propositalmente inválido: o Bling responde 400/401 rápido. O que
    // importa aqui não é a resposta, é chegar até ela.
    const res = await fetchComPrazo(BLING.token, {
      method: "POST",
      headers: {
        Authorization: credencialBasica(),
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: "checagem-invalida" }),
    });
    const corpo = (await res.text()).slice(0, 200);
    resultado.token = { alcancavel: true, status: res.status, ms: Date.now() - inicioToken, resposta: corpo, url: BLING.token };
  } catch (e) {
    resultado.token = { alcancavel: false, ms: Date.now() - inicioToken, erro: (e && e.message) || "falha", url: BLING.token };
  }

  const inicioBanco = Date.now();
  try {
    const sql = sqlClient();
    if (!sql) resultado.banco = { alcancavel: false, erro: "SUPABASE_DB_URL não configurada" };
    else {
      await comPrazo(sql`select 1 as ok`, 10000, "A consulta ao banco");
      resultado.banco = { alcancavel: true, ms: Date.now() - inicioBanco };
    }
  } catch (e) {
    resultado.banco = { alcancavel: false, ms: Date.now() - inicioBanco, erro: (e && e.message) || "falha" };
  }

  return resultado;
}
