// lib/webLeads.cjs — leads captured on vehyra.in (name + phone + the car they
// asked about) land in the CRM, the Google Sheet, and as an instant WhatsApp
// alert on the owner's number so a call can go out while the customer is warm.
'use strict';

const express = require('express');

let _config = {};
function init(config) { _config = config || {}; }

const digits = s => String(s || '').replace(/[^\d]/g, '');
const money = n => `₹${Number(n || 0).toLocaleString('en-IN')}`;

function normalisePhone(raw) {
  const d = digits(raw);
  if (d.length === 10) return `91${d}`;
  if (d.length === 12 && d.startsWith('91')) return d;
  if (d.length === 11 && d.startsWith('0')) return `91${d.slice(1)}`;
  return d.length >= 10 ? d : null;
}

async function captureLead(body = {}) {
  const phone = normalisePhone(body.phone);
  if (!phone) return { ok: false, error: 'A valid 10-digit mobile number is needed' };

  const name = String(body.name || '').trim().slice(0, 60) || 'Website enquiry';
  const car = [body.car, body.variant].filter(Boolean).join(' ').trim();
  const lead = {
    id: `WEB${Date.now()}`,
    name,
    phone,
    status: 'website-lead',
    source: body.source || 'vehyra.in',
    timestamp: new Date().toISOString(),
    car,
    city: body.city || '',
    budget: Number(body.budget) || Number(body.price) || 0,
    emi: Number(body.emi) || 0,
    interest: body.interest || 'Best deal enquiry',
    raw: body
  };

  // 1. CRM store
  try {
    const leads = _config.loadCrmLeadsSafe ? _config.loadCrmLeadsSafe() : [];
    leads.push(lead);
    if (_config.saveCrmLeadsSafe) _config.saveCrmLeadsSafe(leads);
  } catch (e) { console.warn('WebLeads: CRM save failed', e.message); }

  // 2. Google Sheet (fire and forget)
  if (typeof _config.pushLeadToGoogleSheet === 'function') {
    _config.pushLeadToGoogleSheet(lead).catch(() => {});
  }

  // 3. Owner alert — the part that actually wins the deal
  const admin = digits(process.env.ADMIN_WA || '');
  if (admin && typeof _config.waSendText === 'function') {
    const lines = [
      '🔔 *New website lead — VehYra*',
      '',
      `👤 *${name}*`,
      `📞 ${phone.replace(/^91/, '+91 ')}`,
      car ? `🚘 Interested in: *${car}*` : null,
      lead.budget ? `💰 On-road: ${money(lead.budget)}` : null,
      lead.emi ? `💳 EMI shown: ${money(lead.emi)}/mo` : null,
      lead.city ? `📍 ${lead.city}` : null,
      body.plan ? `🏦 Plan viewed: ${body.plan}` : null,
      '',
      `_Call now — they are on the site right now._`,
      `wa.me/${phone}`
    ].filter(Boolean);
    _config.waSendText(admin, lines.join('\n')).catch(e =>
      console.warn('WebLeads: admin alert failed', e.message));
  }

  console.log(`WebLeads: captured ${name} ${phone} for ${car || 'general enquiry'}`);
  return { ok: true, lead: { id: lead.id, name, phone } };
}

const router = express.Router();

router.post('/api/vehyra/lead', express.json(), async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    res.json(await captureLead(req.body || {}));
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

module.exports = { init, router, captureLead };
