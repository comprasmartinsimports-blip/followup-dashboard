// api/ai-chat.js
// Proxy único para o modelo de IA usado nas análises de anúncio. A chave fica
// SOMENTE no servidor (variável de ambiente do Vercel) e o endpoint exige sessão
// do aplicativo — sem isso qualquer visitante poderia consumir a chave.
//
// Motor: Claude por padrão, que foi a escolha do dono do sistema. AI_MOTOR
// ("claude" ou "chatgpt") sobrepõe quando se quer o outro.
//
// O padrão já foi o ChatGPT, e isso deu exatamente o problema que este comentário
// existe para não repetir: com as DUAS chaves definidas no servidor, a análise ia
// para o ChatGPT — sem saldo — enquanto o Claude, pago e pronto, ficava parado. A
// preferência tem de estar no código, não depender de alguém lembrar de apagar a
// chave que sobrou.
//
// A RESPOSTA sai sempre no mesmo formato ({ content: [{ type, text }] }),
// independente de qual motor respondeu: a tela não precisa saber quem atendeu.

import { verificarSessao } from "./_lib/auth.js";

// Trocável por variável de ambiente sem mexer no código. gpt-4o é o padrão por
// ser amplamente disponível; se a conta tiver outro modelo, basta definir OPENAI_MODEL.
const MODELO_OPENAI = process.env.OPENAI_MODEL || "gpt-4o";
// Haiku 4.5 é o mais barato da linha e dá conta de pontuar anúncio — a análise é
// um pedido curto, com resposta curta. Trocável por ANTHROPIC_MODEL sem mexer aqui.
const MODELO_ANTHROPIC = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5";

function respostaDeTexto(texto) {
  return { content: [{ type: "text", text: texto }] };
}

// Mensagem de erro útil: diz o que aconteceu e, quando dá, o que fazer.
function mensagemDeErro(status, corpo, motor) {
  const detalhe =
    (corpo && corpo.error && (corpo.error.message || corpo.error.type)) ||
    (typeof corpo === "string" ? corpo.slice(0, 300) : null);
  if (status === 401 || status === 403) {
    return "A chave da API do " + motor + " foi recusada (HTTP " + status + "). Confira a variável de ambiente no Vercel." +
      (detalhe ? " Detalhe: " + detalhe : "");
  }
  if (status === 429) {
    return "O " + motor + " recusou por limite de uso ou saldo insuficiente." +
      (detalhe ? " Detalhe: " + detalhe : "");
  }
  return "O " + motor + " respondeu HTTP " + status + (detalhe ? ": " + detalhe : ".");
}

async function chamarOpenAI(system, messages, maxTokens) {
  // Modelos mais novos trocaram max_tokens por max_completion_tokens. Em vez de
  // apostar em um dos dois, tenta o clássico e repete com o novo se for recusado
  // exatamente por causa desse campo.
  async function enviar(campoTokens) {
    const corpo = {
      model: MODELO_OPENAI,
      messages: (system ? [{ role: "system", content: system }] : []).concat(messages || []),
    };
    corpo[campoTokens] = maxTokens;
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + process.env.OPENAI_API_KEY,
      },
      body: JSON.stringify(corpo),
      signal: AbortSignal.timeout(60000),
    });
    let dados = null;
    try { dados = await r.json(); } catch (e) { /* resposta não-JSON */ }
    return { status: r.status, ok: r.ok, dados };
  }

  let r = await enviar("max_tokens");
  const recusouCampo =
    !r.ok && r.dados && r.dados.error &&
    /max_tokens/.test(String(r.dados.error.message || "")) &&
    /unsupported|not supported|use .?max_completion_tokens/i.test(String(r.dados.error.message || ""));
  if (recusouCampo) r = await enviar("max_completion_tokens");

  if (!r.ok) {
    const e = new Error(mensagemDeErro(r.status, r.dados, "ChatGPT"));
    e.status = r.status;
    throw e;
  }
  const escolha = r.dados && Array.isArray(r.dados.choices) ? r.dados.choices[0] : null;
  const texto = escolha && escolha.message ? (escolha.message.content || "") : "";
  if (!texto) throw new Error("O ChatGPT respondeu sem conteúdo.");
  return texto;
}

async function chamarAnthropic(system, messages, maxTokens) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODELO_ANTHROPIC,
      max_tokens: maxTokens,
      system: system,
      messages: messages,
    }),
    signal: AbortSignal.timeout(60000),
  });
  let dados = null;
  try { dados = await r.json(); } catch (e) { /* resposta não-JSON */ }
  if (!r.ok) {
    const e = new Error(mensagemDeErro(r.status, dados, "Claude"));
    e.status = r.status;
    throw e;
  }
  const texto = Array.isArray(dados.content)
    ? dados.content.map(function(b) { return b.text || ""; }).join("")
    : "";
  if (!texto) throw new Error("O Claude respondeu sem conteúdo.");
  return texto;
}

export default async function handler(req, res) {
  if (req.method !== "POST" && req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const sessao = await verificarSessao(req);
  if (!sessao) {
    return res.status(401).json({ error: "Não autenticado. Faça login no sistema." });
  }

  const temOpenAI = !!process.env.OPENAI_API_KEY;
  const temAnthropic = !!process.env.ANTHROPIC_API_KEY;
  // A preferência só vale se a chave dela existir: apontar para um motor sem chave
  // não faria a análise funcionar, apenas falharia adiante e com mensagem pior.
  const preferido = String(process.env.AI_MOTOR || "").trim().toLowerCase();
  const usarClaude = preferido === "chatgpt" ? !temOpenAI : temAnthropic;

  // GET = diagnóstico: qual motor ESTÁ configurado neste servidor. Não gasta chamada
  // nem revela a chave — só responde "qual motor atendeu a análise?" sem chute.
  if (req.method === "GET") {
    return res.status(200).json({
      motorAtivo: (temOpenAI || temAnthropic)
        ? (usarClaude ? "claude" : "chatgpt") + (preferido ? " (escolhido por AI_MOTOR)" : " (padrão)")
        : "nenhum",
      // Ter a chave do outro motor definida não muda nada: só o motor ativo é chamado.
      observacao: temOpenAI && temAnthropic
        ? "As duas chaves estão definidas. Só o motor ativo é usado; a outra chave fica ociosa."
        : undefined,
      OPENAI_API_KEY: temOpenAI ? "definida" : "NÃO definida",
      ANTHROPIC_API_KEY: temAnthropic ? "definida" : "NÃO definida",
      AI_MOTOR: preferido || "(não definida)",
      modeloChatgpt: MODELO_OPENAI,
      modeloClaude: MODELO_ANTHROPIC,
    });
  }
  if (!temOpenAI && !temAnthropic) {
    return res.status(503).json({
      error: "Nenhuma chave de IA configurada no servidor: defina OPENAI_API_KEY nas variáveis " +
             "de ambiente do Vercel para a análise usar o ChatGPT.",
    });
  }

  const corpo = req.body || {};
  // max_tokens é opcional e limitado — o modelo é sempre definido aqui no servidor.
  const maxTokens = Math.min(parseInt(corpo.max_tokens, 10) || 1024, 4096);
  const messages = Array.isArray(corpo.messages) ? corpo.messages : [];
  if (!messages.length) return res.status(400).json({ error: "Nenhuma mensagem enviada." });

  try {
    const texto = usarClaude
      ? await chamarAnthropic(corpo.system, messages, maxTokens)
      : await chamarOpenAI(corpo.system, messages, maxTokens);
    return res.status(200).json(respostaDeTexto(texto));
  } catch (err) {
    const abortou = err && (err.name === "TimeoutError" || err.name === "AbortError");
    let mensagem = abortou
      ? "A análise demorou mais de 60s e foi interrompida."
      : (err && err.message) || "Falha ao gerar a análise.";
    // Sem isto, o erro do motor que de fato respondeu parece um problema do outro.
    // Só aparece quando o motor usado NÃO foi o pedido — no caminho normal a
    // mensagem do próprio motor basta.
    if (preferido === "claude" && !temAnthropic) {
      mensagem += " AI_MOTOR pede o Claude, mas ANTHROPIC_API_KEY não está definida no servidor, " +
        "então a análise foi para o ChatGPT.";
    } else if (preferido === "chatgpt" && usarClaude) {
      mensagem += " AI_MOTOR pede o ChatGPT, mas OPENAI_API_KEY não está definida no servidor, " +
        "então a análise foi para o Claude.";
    }
    return res.status(abortou ? 504 : (err && err.status) || 502).json({ error: mensagem });
  }
}

