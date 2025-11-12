/*
  Minimal CRM stub for Mr.Car webhook integration
  - POST /prompt  => returns JSON { text: "...", buttons?: [...] }
  - POST /leads   => accepts leads, returns { ok:true, id: "<ts>" }
  - GET  /healthz => simple health check
*/
const express = require('express');
const bodyParser = require('body-parser');

const app = express();
app.use(bodyParser.json());

app.get('/healthz', (req, res) => {
  res.json({ ok: true, t: Date.now() });
});

app.post('/leads', (req, res) => {
  try {
    const lead = req.body || {};
    console.log('CRM_LEAD_RECEIVED', JSON.stringify(lead).slice(0, 2000));
    return res.json({ ok: true, id: `lead_${Date.now()}` });
  } catch (e) {
    console.error('leads err', e);
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

/*
 Expected payload for /prompt:
 { from, message, quote? }
 Returns: { text: "...", buttons?: ["a","b"] }
*/
app.post('/prompt', (req, res) => {
  try {
    const body = req.body || {};
    console.log('CRM_PROMPT_REQ', JSON.stringify(body).slice(0,2000));

    // Basic example logic: if quote present, return formatted reply.
    if (body.quote && body.quote.brand) {
      const q = body.quote;
      const text = `Quick Quote — ${q.brand} ${q.model || ''} ${q.variant || ''}\nEx: ₹${q.ex_showroom || 'N/A'} • On-Road: ₹${q.on_road || 'N/A'}\nEMI (60m): ₹${q.emi_60 || 'N/A'}`;
      return res.json({ text, buttons: ["Contact Dealer", "Loan Options"] });
    }

    // If message contains 'hi' or empty, send greeting
    const msg = (body.message || '').toString().toLowerCase();
    if (!msg || msg.match(/\b(hi|hello|hey|namaste)\b/)) {
      return res.json({ text: "Hello! I'm the CRM stub. Send a new-car query like: 'Delhi Hycross ZXO individual'." });
    }

    // Default fallback
    return res.json({ text: `CRM received your message: "${String(body.message || '').slice(0,200)}". We will respond shortly.` });
  } catch (e) {
    console.error('prompt err', e);
    return res.status(500).json({ ok:false, error: String(e) });
  }
});

// Start server
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`CRM stub listening on ${PORT}`);
});
