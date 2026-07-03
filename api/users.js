// api/users.js
// Sincronização de usuários entre dispositivos via Vercel KV
// Se não tiver KV configurado, usa um arquivo JSON simples em memória (não persiste entre deploys)
// Para persistência real: adicionar VERCEL_KV no painel Vercel

let usuariosEmMemoria = null; // cache em memória (dura enquanto o serverless estiver ativo)

// Usuário admin padrão se não houver nenhum
const ADMIN_PADRAO = {
  id: "admin",
  nome: "Administrador",
  usuario: "admin",
  // senha: admin123 — hash simples
  senhaHash: Array.from("admin123").reduce((h, c) => (Math.imul(31, h) + c.charCodeAt(0)) | 0, 0).toString(36),
  ativo: true,
  admin: true,
  permissoes: ["overview","listings","orders","financeiro","produtos","usuarios","nfe","full"],
  criadoEm: new Date().toLocaleDateString("pt-BR"),
};

// Tenta usar Vercel KV se disponível
async function getKV() {
  try {
    if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
      return {
        async get(key) {
          const r = await fetch(`${process.env.KV_REST_API_URL}/get/${key}`, {
            headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}` }
          });
          const d = await r.json();
          return d.result ? JSON.parse(d.result) : null;
        },
        async set(key, value) {
          await fetch(`${process.env.KV_REST_API_URL}/set/${key}`, {
            method: "POST",
            headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}`, "Content-Type": "application/json" },
            body: JSON.stringify({ value: JSON.stringify(value) })
          });
        }
      };
    }
  } catch {}
  return null;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  const kv = await getKV();

  // GET /api/users — retorna lista de usuários
  if (req.method === "GET") {
    try {
      let usuarios = null;
      if (kv) {
        usuarios = await kv.get("mlmargem_usuarios");
      } else {
        usuarios = usuariosEmMemoria;
      }
      if (!usuarios || usuarios.length === 0) {
        usuarios = [ADMIN_PADRAO];
      }
      // Nunca retornar senhaHash
      const seguros = usuarios.map(function(u) {
        const { senhaHash, ...resto } = u;
        return resto;
      });
      return res.status(200).json(seguros);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // POST /api/users — salva lista completa de usuários
  if (req.method === "POST") {
    try {
      const { usuarios, senhaHashMap } = req.body;
      if (!Array.isArray(usuarios)) return res.status(400).json({ error: "Formato inválido" });

      // Mescla senhaHash (não trafega em GET mas precisa persistir)
      let atual = null;
      if (kv) {
        atual = await kv.get("mlmargem_usuarios");
      } else {
        atual = usuariosEmMemoria;
      }
      const atualMap = {};
      (atual || [ADMIN_PADRAO]).forEach(u => { atualMap[u.id] = u; });

      const novos = usuarios.map(u => ({
        ...atualMap[u.id],
        ...u,
        senhaHash: (senhaHashMap && senhaHashMap[u.id]) || atualMap[u.id]?.senhaHash || ADMIN_PADRAO.senhaHash,
      }));

      if (kv) {
        await kv.set("mlmargem_usuarios", novos);
      } else {
        usuariosEmMemoria = novos;
      }

      return res.status(200).json({ ok: true, total: novos.length });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}
