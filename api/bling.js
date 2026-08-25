// api/bling.js
// Rotas da integração com o Bling: /api/bling/login, /callback, /status,
// /sincronizar, /desconectar e /diagnostico.
// Todas exigem sessão do aplicativo; conectar, sincronizar e desconectar exigem admin.

import { verificarSessao } from "./_lib/auth.js";
import { dbEnabled } from "./_lib/db.js";
import {
  blingConfigurado, urlAutorizacao, trocarCodigoPorToken, lerConexao, apagarConexao,
  chamarBling, garantirToken, ENTIDADES,
} from "./_lib/bling.js";
import { sincronizarTudo } from "./_lib/blingsync.js";
import { sqlClient } from "./_lib/db.js";

// A sincronização percorre várias páginas de várias entidades — pede mais que os 10s padrão.
export const config = { maxDuration: 60 };

function faltaConfig(res) {
  if (!dbEnabled()) {
    return res.status(503).json({
      error: "SUPABASE_DB_URL não configurada no servidor — sem banco não há onde guardar a conexão com o Bling.",
    });
  }
  if (!blingConfigurado()) {
    return res.status(503).json({
      error: "Bling não configurado no servidor: defina BLING_CLIENT_ID, BLING_CLIENT_SECRET e " +
             "BLING_REDIRECT_URI nas variáveis de ambiente do Vercel.",
    });
  }
  return null;
}

export default async function handler(req, res) {
  const caminho = req.url.replace(/^\/api\/bling/, "").split("?")[0] || "/";

  // O retorno do Bling chega pelo navegador do usuário, direto da autorização.
  // Trata antes da checagem de sessão para poder redirecionar com a mensagem certa.
  if (caminho === "/callback") {
    const { code, error: erroOAuth, error_description: descricao } = req.query || {};
    if (erroOAuth) {
      return res.redirect("/?bling=erro&msg=" + encodeURIComponent(descricao || erroOAuth));
    }
    if (!code) return res.redirect("/?bling=erro&msg=" + encodeURIComponent("O Bling não devolveu o código de autorização."));
    const falta = faltaConfig(res); if (falta) return falta;
    try {
      await trocarCodigoPorToken(code);
      return res.redirect("/?bling=ok");
    } catch (e) {
      return res.redirect("/?bling=erro&msg=" + encodeURIComponent((e && e.message) || "falha ao autorizar"));
    }
  }

  const sessao = await verificarSessao(req);
  if (!sessao) return res.status(401).json({ error: "Não autenticado. Faça login no sistema." });

  // Manda o usuário para a tela de autorização do Bling.
  if (caminho === "/login") {
    if (!sessao.admin) return res.status(403).json({ error: "Apenas administradores podem conectar o Bling." });
    const falta = faltaConfig(res); if (falta) return falta;
    return res.redirect(302, urlAutorizacao("u" + sessao.uid));
  }

  // Situação da conexão + quanto de cada coisa já foi importado.
  if (caminho === "/status") {
    const estado = {
      bancoConfigurado: dbEnabled(),
      credenciaisConfiguradas: blingConfigurado(),
      conectado: false,
      expiraEm: null,
      atualizadoEm: null,
      contagens: {},
    };
    if (!dbEnabled()) return res.status(200).json(estado);
    try {
      const con = await lerConexao();
      estado.conectado = !!(con && con.access_token);
      estado.expiraEm = con && con.expira_em ? new Date(con.expira_em).toISOString() : null;
      estado.atualizadoEm = con && con.atualizado_em ? new Date(con.atualizado_em).toISOString() : null;
      const sql = sqlClient();
      const [prod, est, ctas, notas] = await Promise.all([
        sql`select count(*)::int as n from flow.bling_produto`,
        sql`select count(*)::int as n from flow.bling_estoque`,
        sql`select tipo, count(*)::int as n from flow.bling_conta group by tipo`,
        sql`select count(*)::int as n from flow.bling_nota`,
      ]);
      estado.contagens = {
        produtos: prod[0].n,
        estoque: est[0].n,
        contas_pagar: (ctas.find(function(r){ return r.tipo === "pagar"; }) || { n: 0 }).n,
        contas_receber: (ctas.find(function(r){ return r.tipo === "receber"; }) || { n: 0 }).n,
        notas: notas[0].n,
      };
    } catch (e) {
      estado.erro = (e && e.message) || "falha ao ler a conexão";
    }
    return res.status(200).json(estado);
  }

  if (caminho === "/sincronizar") {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
    if (!sessao.admin) return res.status(403).json({ error: "Apenas administradores podem sincronizar." });
    const falta = faltaConfig(res); if (falta) return falta;
    const somente = req.body && Array.isArray(req.body.somente) ? req.body.somente : null;
    const relatorio = await sincronizarTudo(somente);
    const algumOk = relatorio.some(function(r) { return r.ok; });
    // 207: parte funcionou. Assim a tela mostra o que entrou e o que falhou, em vez
    // de tratar tudo como sucesso ou tudo como erro.
    return res.status(algumOk ? (relatorio.every(function(r){ return r.ok; }) ? 200 : 207) : 502)
      .json({ relatorio });
  }

  if (caminho === "/desconectar") {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
    if (!sessao.admin) return res.status(403).json({ error: "Apenas administradores podem desconectar." });
    await apagarConexao();
    return res.status(200).json({ ok: true });
  }

  // Bate em cada endpoint pedindo 1 registro e conta o que respondeu. Serve para
  // descobrir rapidamente se algum caminho da API mudou, sem gravar nada.
  if (caminho === "/diagnostico") {
    if (!sessao.admin) return res.status(403).json({ error: "Apenas administradores." });
    const falta = faltaConfig(res); if (falta) return falta;
    let token;
    try { token = await garantirToken(); }
    catch (e) { return res.status(200).json({ token: false, erro: (e && e.message) || "sem token", testes: [] }); }
    const testes = [];
    for (const [chave, info] of Object.entries(ENTIDADES)) {
      // Saldos exige ids de produto; testar sem eles daria um falso negativo.
      if (chave === "estoques") { testes.push({ chave, rotulo: info.rotulo, pulado: "precisa de ids de produto" }); continue; }
      try {
        const r = await chamarBling(info.caminho, { pagina: 1, limite: 1 }, token);
        testes.push({ chave, rotulo: info.rotulo, caminho: info.caminho, ok: true, itens: Array.isArray(r.data) ? r.data.length : 0 });
      } catch (e) {
        testes.push({ chave, rotulo: info.rotulo, caminho: info.caminho, ok: false, status: (e && e.status) || 0, erro: (e && e.message) || "falha" });
      }
    }
    return res.status(200).json({ token: true, testes });
  }

  return res.status(404).json({ error: "Rota não encontrada: /api/bling" + caminho });
}
