/* ===== Mr. Car x Signature Savings Webhook (FINAL Render-Compatible Build) ===== */

require('dotenv').config({ path: './.env' });
const fetch = global.fetch || require('node-fetch');
const express = require('express');
const fs = require('fs');
const crypto = require('crypto');
const bodyParser = require('body-parser');
const { parse } = require('csv-parse/sync');

const app = express();

// Capture raw body for signature verification
function rawBodySaver(req, res, buf, encoding) {
  if (buf && buf.length) req.rawBody = buf.toString(encoding || 'utf8');
}
app.use(bodyParser.json({ verify: rawBodySaver }));

// --- Env ---
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || '';
const META_TOKEN = process.env.META_TOKEN || process.env.WA_TOKEN || '';
const PHONE_ID = process.env.PHONE_NUMBER_ID || '';
const ADMIN_WA = process.env.ADMIN_WA || '';
const CRM_URL = process.env.CRM_URL || 'http://127.0.0.1:10000';
const PORT = process.env.PORT || 10000;
const DEBUG_VARIANT = process.env.DEBUG_VARIANT === 'true';

// --- Memory cache for CSV ---
let PRICING_CACHE = { ts: 0, tables: {} };

// --- Helpers ---
async function waSendRaw(payload) {
  if (!META_TOKEN || !PHONE_ID) {
    console.error('Missing META_TOKEN or PHONE_ID');
    return;
  }
  const url = `https://graph.facebook.com/v20.0/${PHONE_ID}/messages`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${META_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  return await res.json();
}

async function waSendText(to, body) {
  try {
    const payload = {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body }
    };
    return await waSendRaw(payload);
  } catch (e) {
    console.error('waSendText failed', e);
  }
}

// --- CSV Loader ---
async function loadPricing() {
  try {
    const tables = {};
    for (const [brand, url] of Object.entries(process.env).filter(([k]) => k.startsWith('SHEET_') && k.endsWith('_CSV_URL'))) {
      const name = brand.replace(/^SHEET_/, '').replace(/_CSV_URL$/, '');
      const r = await fetch(url);
      const csv = await r.text();
      const rows = parse(csv, { columns: true, skip_empty_lines: true });
      tables[name] = { rows, updated: new Date().toISOString() };
    }
    PRICING_CACHE = { ts: Date.now(), tables };
    console.log('✅ Pricing loaded', Object.keys(tables));
  } catch (e) {
    console.error('❌ loadPricing failed', e);
  }
}

// --- Basic routes ---
app.get('/healthz', (req, res) => {
  res.json({ ok: true, t: Date.now(), debug: !!DEBUG_VARIANT });
});

// --- Admin reload CSV (POST) ---
app.post('/admin/reload-csv', express.json(), async (req, res) => {
  try {
    const from = String(req.body.from || '').replace(/\D/g, '');
    if (ADMIN_WA && !from.includes(ADMIN_WA.replace(/\D/g, ''))) {
      return res.status(403).json({ ok: false, msg: 'forbidden' });
    }
    PRICING_CACHE = { ts: 0, tables: {} };
    await loadPricing();
    const rows = Object.values(PRICING_CACHE.tables).reduce((sum, t) => sum + (t.rows?.length || 0), 0);
    res.json({ ok: true, rows });
  } catch (e) {
    console.error('admin reload POST error', e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// --- Admin reload CSV (GET) ---
app.get('/admin/reload-csv', async (req, res) => {
  try {
    const from = String(req.query.from || '').replace(/\D/g, '');
    if (ADMIN_WA && !from.includes(ADMIN_WA.replace(/\D/g, ''))) {
      return res.status(403).json({ ok: false, msg: 'forbidden' });
    }
    PRICING_CACHE = { ts: 0, tables: {} };
    await loadPricing();
    const rows = Object.values(PRICING_CACHE.tables).reduce((sum, t) => sum + (t.rows?.length || 0), 0);
    res.json({ ok: true, rows });
  } catch (e) {
    console.error('admin reload GET error', e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// --- Webhook verification ---
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.status(403).send('Forbidden');
});

// --- Webhook receiver ---
app.post('/webhook', async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const msg = change?.value?.messages?.[0];
    if (!msg) return res.sendStatus(200);

    const from = msg.from;
    const type = msg.type;
    const text = msg.text?.body?.trim();

    console.log('📩 Message from', from, ':', text);

    if (text?.toLowerCase() === 'hi') {
      await waSendText(from, "Namaste (🙏) Mr. Car welcomes you.\nWe assist with new cars, pre-owned, loans, and insurance.");
      return res.sendStatus(200);
    }

    // For any message, proxy to CRM /prompt
    (async () => {
      try {
        const r = await fetch(`${CRM_URL}/prompt`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ from, text })
        });
        if (!r.ok) throw new Error(`CRM /prompt non-ok ${r.status}`);
        const reply = await r.text();
        if (reply?.trim()) await waSendText(from, reply);
      } catch (e) {
        console.error('CRM /prompt error', e);
        await waSendText(from, 'Our team will reach out shortly. Thank you.');
      }
    })();

    res.sendStatus(200);
  } catch (e) {
    console.error('webhook error', e);
    res.sendStatus(500);
  }
});

// --- Startup ---
(async () => {
  await loadPricing();
  app.listen(PORT, () => {
    console.log(`✅ CRM running on ${PORT}`);
    console.log('ENV summary:', {
      SHEET_TOYOTA_CSV_URL: !!process.env.SHEET_TOYOTA_CSV_URL,
      PHONE_NUMBER_ID: !!PHONE_ID,
      META_TOKEN: !!META_TOKEN,
      ADMIN_WA: !!ADMIN_WA,
      CRM_URL,
      DEBUG_VARIANT
    });
  });
})();
