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

  // ── Acesso de emergência (break-glass) ──────────────────────────────────────
  // Se a variável de ambiente ADMIN_RECOVERY_PASSWORD estiver definida no projeto
  // (Vercel → Environment Variables) e a senha enviada for igual a ela, o login é
  // liberado para o usuário digitado (ou, se não existir, o 1º admin da lista): a
  // conta é REATIVADA e a senha é redefinida para essa senha de recuperação. Só quem
  // tem acesso às variáveis de ambiente consegue habilitar isso — resgate controlado.
  const recovery = process.env.ADMIN_RECOVERY_PASSWORD;
  if (recovery && String(senha) === String(recovery)) {
    let alvo = user || usuarios.find(u => u.admin) || usuarios[0];
    if (alvo) {
      try {
        const atualizados = usuarios.map(u =>
          u.id === alvo.id ? Object.assign({}, u, { ativo: true, senhaHash: hashSenha(recovery) }) : u
        );
        await salvarUsuarios(atualizados);
      } catch {}
      alvo = Object.assign({}, alvo, { ativo: true });
      res.setHeader("Set-Cookie", await criarCookieSessao(alvo));
      return res.status(200).json({ ok: true, user: semSenha(alvo), recovery: true });
    }
  }

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
