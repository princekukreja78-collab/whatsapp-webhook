// ===== Mr. Car x Signature Savings webhook (final merged version) =====
require('dotenv').config();

const express = require('express');
const fs = require('fs');
const crypto = require('crypto');
const fetch = require('node-fetch');
const bodyParser = require('body-parser');

const app = express();

// raw body capture for signature verification
function rawBodySaver(req, res, buf, encoding) {
  if (buf && buf.length) req.rawBody = buf.toString(encoding || 'utf8');
}
app.use(bodyParser.json({ verify: rawBodySaver }));

// Environment variables (supports both local and Render names)
const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || process.env.VERIFY_TOKEN || '';
const APP_SECRET = process.env.META_APP_SECRET || process.env.APP_SECRET || '';
const PHONE_ID = process.env.WHATSAPP_PHONE_ID || process.env.PHONE_NUMBER_ID || process.env.PHONE_ID || '';
const META_TOKEN = process.env.META_TOKEN || process.env.WA_TOKEN || '';
const CRM_URL = process.env.CRM_URL || 'http://localhost:4000';
const PORT = process.env.PORT || 3000;
const DB_FILE = process.env.DB_FILE || './crm_db.json';

// verify signature
function verifySignature(req) {
  if (!APP_SECRET) return true; // skip locally if not set
  const sig = req.headers['x-hub-signature-256'];
  if (!sig || !req.rawBody) return false;
  const hmac = crypto.createHmac('sha256', APP_SECRET);
  hmac.update(req.rawBody);
  const digest = 'sha256=' + hmac.digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(sig));
  } catch {
    return false;
  }
}

// webhook verification (GET)
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ Webhook verified');
    return res.status(200).send(challenge);
  }
  return res.status(403).send('Verification failed');
});

// incoming message handler (POST)
app.post('/webhook', async (req, res) => {
  try {
    if (!verifySignature(req)) {
      console.warn('❌ Signature verification failed');
      return res.sendStatus(403);
    }

    const body = req.body;
    console.log('Incoming webhook body:', JSON.stringify(body, null, 2));
    const entry = (body.entry && body.entry[0]) || null;
    const change = entry && entry.changes && entry.changes[0];
    const value = change ? change.value : (body && body.object ? body : null);
    const messages = value && value.messages;

    if (!messages || messages.length === 0) return res.sendStatus(200);

    const msg = messages[0];
    const from = msg.from;
    const text = (msg.text && msg.text.body) || '';

    // --- Mr. Car official greeting injection ---
    function getGreetingIfNeeded(from, messageText) {
      const greetings = ['hi', 'hello', 'hey', 'namaste', 'good morning', 'good evening', 'good afternoon'];
      const isGreeting = greetings.some(g => messageText.toLowerCase().includes(g));
      const dbPath = DB_FILE;
      let db = {};
      if (fs.existsSync(dbPath)) db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
      db.sessions = db.sessions || {};
      const session = db.sessions[from];
      const now = Date.now();

      if (!session || now - session.lastActive > 10 * 60 * 1000 || isGreeting) {
        db.sessions[from] = { lastActive: now };
        fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
        return "Namaste (🙏) Mr. Car welcomes you. We can assist you with pre-owned cars, the finest new car deals, automotive loans, and insurance services. For your enquiry, our team is ready to assist you instantly and ensure a seamless experience.";
      }

      db.sessions[from].lastActive = now;
      fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
      return null;
    }

    // Inject greeting before CRM call
    const greetingText = getGreetingIfNeeded(from, text);
    if (greetingText) {
      await sendTextMessage(from, greetingText);
      return res.sendStatus(200);
    }

    // send to CRM (Signature Savings GPT logic)
    let crmJson = { reply: 'Sorry, no CRM response', type: 'text' };
    try {
      const crmResp = await fetch(`${CRM_URL}/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, message: text }),
      });
      if (crmResp.ok) crmJson = await crmResp.json();
    } catch (e) {
      console.error('CRM error:', e.message);
    }

    const replyText = crmJson.reply || 'Temporary issue, please retry.';
    await sendTextMessage(from, replyText);
    res.sendStatus(200);
  } catch (err) {
    console.error('Webhook handler error:', err);
    res.sendStatus(500);
  }
});

// helper: send text via WhatsApp Cloud API
async function sendTextMessage(to, messageText) {
  if (!PHONE_ID || !META_TOKEN) {
    console.warn('⚠️ Missing PHONE_ID or META_TOKEN');
    return;
  }
  const toClean = String(to).replace(/\D/g, '');
  const url = `https://graph.facebook.com/v17.0/${PHONE_ID}/messages`;
  const body = {
    messaging_product: 'whatsapp',
    to: toClean,
    type: 'text',
    text: { body: messageText }
  };
  console.log('➡️ Sending message:', JSON.stringify(body));
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${META_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  const txt = await resp.text();
  if (!resp.ok) console.error('Meta send error:', resp.status, txt);
  else console.log('✅ Meta send success:', txt);
}

// --- CRM dashboard helpers ---
app.get('/crm', (req, res) => {
  try {
    const data = fs.existsSync(DB_FILE)
      ? JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))
      : {};
    res.json(data);
  } catch {
    res.json({});
  }
});

app.post('/update', (req, res) => {
  try {
    const { system_prompt, pricing_data, tone, reply_signature } = req.body;
    const newData = { system_prompt, pricing_data, tone, reply_signature, last_updated: new Date().toISOString() };
    fs.writeFileSync(DB_FILE, JSON.stringify(newData, null, 2));
    console.log('✅ CRM updated:', newData);
    res.status(200).send('CRM updated successfully');
  } catch (e) {
    console.error('CRM update error:', e);
    res.status(500).send('CRM update failed');
  }
});

app.listen(PORT, () => console.log(`🚀 Webhook server running on port ${PORT}`));
