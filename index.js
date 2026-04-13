const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());

// =============================
// ⚙️ SUAS CONFIGURAÇÕES
// =============================
const ZAPI_INSTANCE = "3F18CB8D6A8F5293C0319ED390C0144C";
const ZAPI_TOKEN = "10403D4244F69B15B8BFAF61";
const ZAPI_CLIENT_TOKEN = "F8b9ceb83dc0d4685af084e5c3bc9522fS";
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY || "SUA_CHAVE_AQUI";
const ZAPI_URL = `https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}`;

// =============================
// 💾 BANCO DE DADOS (arquivo JSON simples)
// =============================
const DB_PATH = path.join(__dirname, "lista.json");

function lerLista() {
  if (!fs.existsSync(DB_PATH)) fs.writeFileSync(DB_PATH, "[]");
  return JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
}

function salvarLista(lista) {
  fs.writeFileSync(DB_PATH, JSON.stringify(lista, null, 2));
}

// =============================
// 🤖 IA - Interpretar mensagem
// =============================
async function interpretarMensagem(texto) {
  try {
    const response = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-haiku-4-5-20251001",
        max_tokens: 300,
        messages: [
          {
            role: "user",
            content: `Você é um assistente de lista de compras. Analise a mensagem abaixo e extraia informações de compra.

Mensagem: "${texto}"

Responda APENAS com JSON neste formato exato (sem explicações):
{
  "ehPedido": true ou false,
  "item": "nome do item",
  "quantidade": "quantidade e unidade",
  "categoria": "uma de: Alimentação, Limpeza, Escritório, Manutenção, Saúde, Outros"
}

Se não for um pedido de compra, retorne: {"ehPedido": false}`,
          },
        ],
      },
      {
        headers: {
          "x-api-key": CLAUDE_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
      }
    );

    const texto_resposta = response.data.content[0].text
      .trim()
      .replace(/```json/g, "")
      .replace(/```/g, "")
      .trim();
    return JSON.parse(texto_resposta);
  } catch (err) {
    console.error("Erro na IA:", err.message);
    return { ehPedido: false };
  }
}

// =============================
// 📤 Enviar mensagem no WhatsApp
// =============================
async function enviarMensagem(telefone, mensagem, isGrupo) {
  try {
    // Z-API: grupos usam formato "ID-group", contatos usam só o número
    let phone = String(telefone).replace(/@.*$/, "");
    // Para contatos, remove o -group se vier por engano
    if (!isGrupo) phone = phone.replace(/-group$/, "");

    console.log(`📤 Enviando para: ${phone}, grupo: ${isGrupo}`);

    await axios.post(`${ZAPI_URL}/send-text`, {
      phone: phone,
      message: mensagem,
    }, {
      headers: { "Client-Token": ZAPI_CLIENT_TOKEN }
    });
  } catch (err) {
    console.error("Erro ao enviar mensagem:", err.message);
    if (err.response) console.error("Detalhes:", JSON.stringify(err.response.data));
  }
}

// =============================
// 📋 Gerar resumo da lista
// =============================
function gerarResumo() {
  const lista = lerLista().filter((i) => !i.comprado);
  if (!lista.length) return "📭 Lista vazia no momento.";

  const cats = ["Alimentação", "Limpeza", "Escritório", "Manutenção", "Saúde", "Outros"];
  const emojis = { Alimentação: "🥩", Limpeza: "🧴", Escritório: "📦", Manutenção: "🔧", Saúde: "💊", Outros: "📋" };

  let resumo = `🛒 *LISTA DE COMPRAS*\n📅 ${new Date().toLocaleDateString("pt-BR")}\n\n`;

  cats.forEach((cat) => {
    const itens = lista.filter((i) => i.categoria === cat);
    if (!itens.length) return;
    resumo += `*${emojis[cat]} ${cat}*\n`;
    itens.forEach((i) => (resumo += `  • ${i.item} — ${i.quantidade} (${i.autor})\n`));
    resumo += "\n";
  });

  resumo += `_Total: ${lista.length} item(s) pendente(s)_`;
  return resumo;
}

// =============================
// 🔔 WEBHOOK - Recebe mensagens
// =============================
app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // responde rápido pro Z-API

  const body = req.body;

  // ignora mensagens enviadas pelo próprio bot
  if (body.fromMe) return;

  const texto = body.text?.message || body.message || "";
  const telefone = body.phone || body.from;
  const autor = body.senderName || body.pushName || "Funcionário";
  const isGrupo = body.isGroup || false;

  console.log(`📱 Telefone recebido: ${JSON.stringify(telefone)}, isGrupo: ${isGrupo}`);

  if (!texto || !telefone) return;

  console.log(`📨 Mensagem de ${autor}: ${texto}`);

  // Comandos especiais
  const cmd = texto.trim().toLowerCase();

  if (cmd === "!lista") {
    await enviarMensagem(telefone, gerarResumo(), isGrupo);
    return;
  }

  if (cmd === "!ajuda") {
    await enviarMensagem(
      telefone,
      `🤖 *Comandos disponíveis:*\n\n` +
      `• Manda qualquer item naturalmente:\n  _"preciso de papel A4, 2 caixas"_\n\n` +
      `• *!lista* — ver todos os itens pendentes\n` +
      `• *!ajuda* — ver esta mensagem`,
      isGrupo
    );
    return;
  }

  // Interpreta com IA
  const resultado = await interpretarMensagem(texto);

  if (!resultado.ehPedido) return; // ignora mensagens que não são pedidos

  // Salva na lista
  const lista = lerLista();
  const novoItem = {
    id: Date.now(),
    item: resultado.item,
    quantidade: resultado.quantidade,
    categoria: resultado.categoria,
    autor: autor,
    data: new Date().toLocaleDateString("pt-BR"),
    comprado: false,
  };
  lista.push(novoItem);
  salvarLista(lista);

  console.log(`✅ Item adicionado: ${resultado.item}`);

  // Confirma no grupo
  await enviarMensagem(
    telefone,
    `✅ *${resultado.item}* adicionado à lista!\n` +
    `📦 Qtd: ${resultado.quantidade}\n` +
    `🏷️ Categoria: ${resultado.categoria}\n` +
    `👤 Solicitado por: ${autor}\n\n` +
    `_Digite !lista para ver todos os itens_`,
    isGrupo
  );
});

// =============================
// ⏰ RELATÓRIO DIÁRIO ÀS 8H
// =============================
const GRUPO_ID = "120363423230103539-group";

function agendarRelatorio() {
  const agora = new Date();
  const proximo = new Date();
  proximo.setHours(8, 0, 0, 0);
  if (proximo <= agora) proximo.setDate(proximo.getDate() + 1);
  const diff = proximo - agora;

  setTimeout(async () => {
    const lista = lerLista().filter(i => !i.comprado);
    if (lista.length > 0) {
      const resumo = `☀️ *BOM DIA! Lista de compras do dia:*\n\n` + gerarResumo();
      await enviarMensagem(GRUPO_ID, resumo, true);
      console.log("📅 Relatório diário enviado!");
    }
    agendarRelatorio(); // reagenda para o próximo dia
  }, diff);

  console.log(`⏰ Próximo relatório em ${Math.round(diff/1000/60)} minutos`);
}

agendarRelatorio();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Bot rodando na porta ${PORT}`));
