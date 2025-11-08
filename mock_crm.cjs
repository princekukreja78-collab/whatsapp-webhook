// SignatureGPT-Luxury CRM — Dual-mode (Hugging Face / GPT 3.5)
const express = require("express");
const bodyParser = require("body-parser");
const fs = require("fs");
require("dotenv").config();

const app = express();
app.use(bodyParser.json());

// ===== SETTINGS =====
const PORT = process.env.PORT || 4000;
// choose model source: "hf" (Hugging Face free) or "openai" (GPT 3.5)
const MODEL_SOURCE = process.env.MODEL_SOURCE || "hf";

// Hugging Face model (free tier)
const HF_URL = process.env.HF_URL || "https://api-inference.huggingface.co/models/mistralai/Mistral-7B-Instruct-v0.3";
const HF_KEY = process.env.HF_KEY || "";

// OpenAI GPT 3.5 (paid)
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const OPENAI_KEY = process.env.OPENAI_API_KEY || "";

// local cache file
const STATE_FILE = "crm_state.json";

// ====== Helper ======
async function queryModel(promptText) {
  if (MODEL_SOURCE === "hf") {
    const res = await fetch(HF_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${HF_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        inputs: promptText,
        parameters: { max_new_tokens: 150, temperature: 0.7 },
      }),
    });
    const data = await res.json();
    return data?.[0]?.generated_text || "Signature Savings: (HF) reply unavailable.";
  }

  // GPT 3.5 mode
  const res = await fetch(OPENAI_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-3.5-turbo-0125",
      messages: [
        {
          role: "system",
          content:
            "You are SignatureGPT, a luxury automotive consultant representing Mr. Car. " +
            "Provide elegant, concise replies about Toyota cars, pricing, finance, or delivery. " +
            "End with 'Victory. Luxury. Mr. Car.' when appropriate.",
        },
        { role: "user", content: promptText },
      ],
    }),
  });
  const data = await res.json();
  return data?.choices?.[0]?.message?.content || "Signature Savings: (GPT) reply unavailable.";
}

// ====== API Endpoints ======

// Ping /prompt from webhook
app.post("/prompt", async (req, res) => {
  const { from, message } = req.body;
  console.log(`📩 Received from ${from}: ${message}`);

  const crmState = fs.existsSync(STATE_FILE)
    ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8"))
    : {};

  const promptText =
    `System Prompt: ${crmState.system_prompt || "Signature Savings test"}\n` +
    `Tone: ${crmState.tone || "luxury"}\n` +
    `Pricing Data: ${crmState.pricing_data || "hycross zx delhi"}\n` +
    `User: ${message}`;

  let replyText;
  try {
    replyText = await queryModel(promptText);
  } catch (err) {
    console.error("❌ Model error:", err);
    replyText = "Temporary AI service error.";
  }

  const responsePayload = {
    reply: replyText,
    type: "text",
    metadata: {
      model: crmState.pricing_data || "unknown",
      tone: crmState.tone || "luxury",
    },
  };

  console.log("✅ AI reply:", responsePayload.reply);
  res.json(responsePayload);
});

// Health check
app.get("/", (req, res) => res.send("✅ SignatureGPT-Luxury CRM active."));

app.listen(PORT, () => console.log(`✅ Mock CRM (SignatureGPT) listening on port ${PORT}`));

app.post('/prompt', (req, res) => {
  const { from, message } = req.body || {};
  console.log('📩 Received from webhook:', { from, message });
  res.json({
    reply: `Signature Savings: Received "${message}" from ${from}.`,
    type: 'text',
    metadata: { model: 'TOYOTA HYCROSS ZX', price: 3450000, tone: 'luxury' }
  });
});

app.listen(4000, () => console.log('✅ Mock CRM (CJS) listening on port 4000'));
