// api/auth/app-login.js
// Login dos usuários internos do dashboard. A validação de senha acontece SOMENTE
// aqui no servidor — o navegador nunca recebe hashes de senha.

import {
  lerUsuarios,
  salvarUsuarios,
  verificarSenha,
  hashSenha,
  criarCookieSessao,
  verificarSessao,
  semSenha,
} from "../_lib/auth.js";

export default async function handler(req, res) {
  // GET: retorna a sessão atual (para o app validar o cookie ao abrir)
  if (req.method === "GET") {
    const sessao = await verificarSessao(req);
    if (!sessao) return res.status(200).json({ authenticated: false });
    const usuarios = await lerUsuarios();
    const user = usuarios.find(u => u.id === sessao.uid && u.ativo);
    if (!user) return res.status(200).json({ authenticated: false });
    return res.status(200).json({ authenticated: true, user: semSenha(user) });
  }

  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { usuario, senha } = req.body || {};
  if (!usuario || !senha) {
    return res.status(400).json({ error: "Informe usuário e senha" });
  }

  const usuarios = await lerUsuarios();
  const user = usuarios.find(
    u => u.usuario && u.usuario.toLowerCase() === String(usuario).toLowerCase()
  );

  if (!user || !user.ativo) {
    return res.status(401).json({ error: "Usuário ou senha incorretos, ou usuário inativo." });
  }

  const check = verificarSenha(senha, user.senhaHash);
  if (!check.ok) {
    return res.status(401).json({ error: "Usuário ou senha incorretos, ou usuário inativo." });
  }

  // Hash antigo (fraco, gerado no navegador): atualiza para scrypt no primeiro login
  if (check.precisaUpgrade) {
    try {
      const atualizados = usuarios.map(u =>
        u.id === user.id ? Object.assign({}, u, { senhaHash: hashSenha(senha) }) : u
      );
      await salvarUsuarios(atualizados);
    } catch {}
  }

  res.setHeader("Set-Cookie", await criarCookieSessao(user));
  return res.status(200).json({ ok: true, user: semSenha(user) });
}
