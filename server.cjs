/*
  server.cjs - CommonJS WhatsApp webhook (for Node with "type":"module" in package.json)
  - Single CRM_URL declaration
  - No top-level await
  - Safe forwarding to CRM with axios
*/

const express = require('express');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(express.json());

// single CRM_URL (fallback)
const CRM_URL = process.env.CRM_URL || 'http://localhost:4000';

// verification endpoint (Meta webhook verification)
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || 'testtoken';

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook verified');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// webhook receiver - forward to CRM
app.post('/webhook', async (req, res) => {
  try {
    console.log('Incoming webhook payload:', JSON.stringify(req.body).slice(0, 1000));
    // Forward the payload to CRM
    await axios.post(CRM_URL.replace(/\/$/, '') + '/api/record', req.body, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000,
    });
    // Respond 200 so Meta/WhatsApp considers it received
    return res.status(200).send('EVENT_RECEIVED');
  } catch (err) {
    console.error('Error forwarding to CRM:', err?.response?.data || err?.message || err);
    // Still reply 200 to avoid webhook retries if CRM is flaky, you can change to 500 if you want retries
    return res.status(200).send('EVENT_RECEIVED');
  }
});

// small test route
app.get('/', (req, res) => res.send('WhatsApp webhook server (OK)'));

// start server inside async wrapper (no top-level await)
async function main() {
  try {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
      console.log(`🚀 Server listening on port ${PORT}`);
    });
  } catch (err) {
    console.error('Startup error:', err);
    process.exit(1);
  }
}

main();
