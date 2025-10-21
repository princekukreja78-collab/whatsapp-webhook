// Basic WhatsApp Webhook Server for Mr. Car
const express = require("express");
const bodyParser = require("body-parser");

const app = express();
app.use(bodyParser.json());

// ✅ Replace with your token (must match what you type in Meta Dashboard)
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "MrCarSecure2025";

// Webhook verification (Meta will call this)
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verified successfully");
    return res.status(200).send(challenge);
  } else {
    console.log("❌ Verification failed");
    return res.sendStatus(403);
  }
});

// Handle webhook messages (POST)
app.post("/webhook", (req, res) => {
  console.log("Incoming webhook:", JSON.stringify(req.body, null, 2));
  res.status(200).send("EVENT_RECEIVED");
});

// Run server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚗 Mr. Car Webhook running on port ${PORT}`));
