// server.cjs — Final production-safe WhatsApp webhook relay

const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
require("dotenv").config();

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// === Configuration ===
const PORT = process.env.PORT || 10000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "MrCarSecure2025";
const CRM_URL = process.env.CRM_URL || "http://localhost:4000"; // optional CRM forward target

// === 1. Basic health check ===
app.get("/", (req, res) => {
  res.status(200).send("✅ WhatsApp Webhook server running fine.");
});

// === 2. Meta verification route ===
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  console.log("📥 Verification request:", { mode, token, challenge });
  console.log("📌 VERIFY_TOKEN in server:", VERIFY_TOKEN);

  if (mode && token) {
    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      console.log("✅ Webhook verified successfully!");
      return res.status(200).send(challenge);
    } else {
      console.log("⛔ Token mismatch! Check Render env VERIFY_TOKEN.");
      return res.status(403).send("Forbidden");
    }
  } else {
    return res.status(400).send("Bad Request");
  }
});

// === 3. Handle incoming WhatsApp messages ===
app.post("/webhook", async (req, res) => {
  try {
    console.log("📨 Incoming payload:", JSON.stringify(req.body, null, 2));

    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const message = changes?.value?.messages?.[0];

    if (message) {
      const from = message.from;
      const text = message.text?.body || "";
      console.log(`💬 Message from ${from}: ${text}`);

      // (Optional) Forward to your CRM
      const recordUrl = `${CRM_URL.replace(/\/$/, "")}/api/record`;
      await axios.post(recordUrl, { from, text }, { timeout: 10000 });
    }

    res.status(200).send("EVENT_RECEIVED");
  } catch (err) {
    console.error("❌ Error processing POST:", err.message);
    res.status(500).send("Internal Server Error");
  }
});

// === 4. Fallback route ===
app.all("*", (req, res) => {
  console.log("⚠️ Unknown route:", req.method, req.originalUrl);
  res.status(404).send("Not Found");
});

// === 5. Start server ===
app.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});


