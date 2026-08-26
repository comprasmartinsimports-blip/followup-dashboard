// api/bling.js
// Rotas da integração com o Bling: /api/bling/login, /callback, /status,
// /sincronizar, /desconectar e /diagnostico.
// Todas exigem sessão do aplicativo; conectar, sincronizar e desconectar exigem admin.

import { verificarSessao } from "./_lib/auth.js";
import { dbEnabled } from "./_lib/db.js";
import {
  blingConfigurado, urlAutorizacao, trocarCodigoPorToken, lerConexao, apagarConexao,
  chamarBling, garantirToken, ENTIDADES, checarRede, comPrazo, chamarBlingBruto,
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

  // ── Sincronização agendada ────────────────────────────────────────────────
  // Chamada pelo agendador (pg_cron), não por um navegador: não há sessão, a
  // autenticação é o CRON_SECRET. É o que faz uma baixa registrada no Bling
  // aparecer aqui sozinha, sem ninguém clicar em Sincronizar.
  if (caminho === "/_cron_sync") {
    const segredo = req.headers["x-cron-secret"] || (req.headers.authorization || "").replace("Bearer ", "");
    if (!process.env.CRON_SECRET || segredo !== process.env.CRON_SECRET) {
      return res.status(403).json({ error: "Proibido." });
    }
    if (!dbEnabled() || !blingConfigurado()) {
      return res.status(200).json({ ok: false, motivo: "Bling ou banco não configurado no servidor." });
    }
    try {
      // Se o Bling não estiver conectado, não é erro do agendador: só não há o que fazer.
      await garantirToken();
    } catch (e) {
      return res.status(200).json({ ok: false, motivo: (e && e.message) || "sem conexão com o Bling" });
    }
    const relatorio = await sincronizarTudo(null);
    return res.status(200).json({ ok: true, relatorio });
  }

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
      // Rede de segurança: mesmo que algo novo trave aqui dentro, o usuário recebe
      // uma mensagem em vez da tela de 504 do Vercel. As etapas internas (chamada ao
      // Bling, gravação no banco) têm prazos próprios e dizem qual delas falhou.
      await comPrazo(trocarCodigoPorToken(code), 25000, "A conexão com o Bling");
      return res.redirect("/?bling=ok");
    } catch (e) {
      const motivo = (e && e.message) || "falha ao autorizar";
      // O código de autorização é de uso único: depois de falhar, só um novo
      // clique em Conectar gera outro. Dizer isso evita a tentativa inútil de recarregar.
      return res.redirect("/?bling=erro&msg=" + encodeURIComponent(motivo + " — clique em Conectar novamente para gerar um novo código."));
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
      const con = await comPrazo(lerConexao(), 12000, "A leitura da conexão");
      estado.conectado = !!(con && con.access_token);
      estado.expiraEm = con && con.expira_em ? new Date(con.expira_em).toISOString() : null;
      estado.atualizadoEm = con && con.atualizado_em ? new Date(con.atualizado_em).toISOString() : null;
      const sql = sqlClient();
      // A contagem é um conforto, não o essencial: se ela falhar (instância fria
      // reabrindo conexão, por exemplo), o estado da conexão continua valendo e a
      // tela avisa só que os números não vieram — sem alarme falso de erro.
      const [prod, est, ctas, semNome] = await comPrazo(Promise.all([
        sql`select count(*)::int as n from flow.bling_produto`,
        sql`select count(*)::int as n from flow.bling_estoque`,
        sql`select count(*)::int as n from flow.bling_conta where tipo = 'pagar'`,
        sql`select count(*)::int as n from flow.bling_conta where tipo = 'pagar' and contato is null`,
      ]), 20000, "A contagem do que já foi importado");
      estado.contagens = {
        produtos: prod[0].n, estoque: est[0].n, contas_pagar: ctas[0].n,
        contas_sem_fornecedor: semNome[0].n,
      };
    } catch (e) {
      // Já sabendo que está conectado, uma falha na contagem não é erro de conexão.
      if (estado.conectado) estado.avisoContagem = "Não foi possível contar agora o que já foi importado.";
      else estado.erro = (e && e.message) || "falha ao ler a conexão";
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

  // Mede se o servidor alcança o Bling e o banco. Não precisa estar conectado —
  // é justamente o que se usa quando o callback falha antes de guardar o token.
  if (caminho === "/checar-rede") {
    if (!sessao.admin) return res.status(403).json({ error: "Apenas administradores." });
    if (!blingConfigurado()) {
      return res.status(503).json({ error: "Faltam BLING_CLIENT_ID, BLING_CLIENT_SECRET e BLING_REDIRECT_URI no servidor." });
    }
    return res.status(200).json(await checarRede());
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

  // Descobre COMO o Bling recebe uma baixa, sem alterar nada: cada tentativa usa um
  // id de conta que não existe. Se a rota não existir, o Bling responde de um jeito;
  // se existir, responde "conta não encontrada" — e é isso que queremos saber antes
  // de escrever qualquer coisa de verdade no ERP.
  if (caminho === "/descobrir-baixa") {
    if (!sessao.admin) return res.status(403).json({ error: "Apenas administradores." });
    const falta = faltaConfig(res); if (falta) return falta;
    const token = await garantirToken();
    const ID_INEXISTENTE = "1";
    const candidatos = [
      { metodo: "POST", caminho: "/contas/pagar/" + ID_INEXISTENTE + "/baixar" },
      { metodo: "POST", caminho: "/contas/pagar/" + ID_INEXISTENTE + "/baixas" },
      { metodo: "POST", caminho: "/contas/pagar/baixas" },
      { metodo: "GET",  caminho: "/contas/pagar/" + ID_INEXISTENTE },
    ];
    const resultados = [];
    for (const c of candidatos) {
      try {
        const r = await chamarBlingBruto(c.metodo, c.caminho, token);
        resultados.push(Object.assign({ existe: r.status !== 404 || /conta/i.test(r.corpo) }, c, r));
      } catch (e) {
        resultados.push(Object.assign({ erro: (e && e.message) || "falha" }, c));
      }
    }
    return res.status(200).json({
      aviso: "Nenhuma conta real foi tocada: todas as tentativas usam um id inexistente.",
      resultados,
    });
  }

  return res.status(404).json({ error: "Rota não encontrada: /api/bling" + caminho });
}
