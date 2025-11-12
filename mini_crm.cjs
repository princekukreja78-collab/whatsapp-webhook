// mini_crm.cjs — local lightweight CRM (CommonJS)
const express = require('express');
const app = express();
app.use(express.json());

const leads = []; // in-memory lead store (most recent first)

// POST /leads — webhook posts new WhatsApp leads here
app.post('/leads', (req, res) => {
  const { from, name, text, ts } = req.body || {};
  if (!from) return res.status(400).send('Missing from');
  const lead = { from, name: name || '', text: text || '', ts: ts || new Date().toISOString() };
  leads.unshift(lead);
  console.log('CRM: new lead', lead.from, '-', (lead.text||'').slice(0,120));
  res.send('OK');
});

// GET /leads (HTML dashboard)
app.get('/leads', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  const rows = leads.map(l => `<tr>
    <td style="white-space:nowrap">${l.ts}</td>
    <td>${l.from}</td>
    <td>${(l.name||'').replace(/</g,'&lt;')}</td>
    <td>${(l.text||'').replace(/</g,'&lt;')}</td>
  </tr>`).join('');
  const html = `<!doctype html>
  <html><head><meta charset="utf-8"><meta http-equiv="refresh" content="12">
  <title>Mr.Car — Leads</title>
  <style>
    body{font-family:Inter,system-ui,sans-serif;background:#f6f7fb;padding:20px}
    h1{color:#222} table{width:100%;border-collapse:collapse;background:#fff;box-shadow:0 1px 4px rgba(0,0,0,0.06)}
    th,td{padding:10px;border:1px solid #e6e8ee;text-align:left}
    th{background:#0b5fff;color:#fff}
    tr:nth-child(even){background:#fbfbfd}
    .small{font-size:12px;color:#666}
  </style></head><body>
  <h1>Mr.Car Leads Dashboard</h1>
  <p class="small">Auto-refresh every 12s. Newest first.</p>
  <table><thead><tr><th>Time</th><th>From</th><th>Name</th><th>Message</th></tr></thead>
  <tbody>${rows}</tbody></table>
  </body></html>`;
  res.send(html);
});

// GET /prompt — simple rule-based reply (simulate Signature Savings GPT)
app.get('/prompt', (req, res) => {
  const q = String(req.query.text || req.query.msg || '').toLowerCase();
  let reply = 'Thanks! Our representative will contact you shortly.';
  if (/loan|finance|emi|interest|roi/.test(q)) {
    reply = 'Current new car ROI is 8.1% and used car ROI approx 9.99%. Would you like EMI options?';
  } else if (/exchange|part-?exchange|trade/.test(q)) {
    reply = 'Yes, we support exchange. Please share your current car make, model, year, and approximate km.';
  } else if (/price|quote|on-?road|ex-?showroom/.test(q)) {
    reply = 'Please mention brand, model, variant and city for an exact quote.';
  } else if (/hycross|fortuner|innova|x1|bmw|mercedes/i.test(q)) {
    reply = 'Got your model request — would you like finance options or to book a test drive?';
  }
  return res.json({ reply });
});

// health check
app.get('/healthz', (req, res) => res.json({ ok: true, t: Date.now() }));

const PORT = process.env.CRM_PORT || 10000;
app.listen(PORT, () => console.log(`mini CRM running on :${PORT}`));
