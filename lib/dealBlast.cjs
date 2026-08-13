// lib/dealBlast.cjs — send a live deal to matched CRM leads via an approved
// Meta marketing template (works beyond the 24h window).
// Template (env DEAL_TEMPLATE_NAME, default mr_car_deal_card, lang en_US):
//   HEADER image | BODY {{1}} title, {{2}} price line, {{3}} deal line, {{4}} valid till
//   BUTTONS: quick_reply "Deal & EMI" (payload INV_DEAL_<id>),
//            quick_reply "Book Test Drive" (payload INV_TD_<id>),
//            URL "View Car" → https://www.vehyra.in/cars/{{1}}
// Never auto-sends: callers must confirm (BLAST command / dashboard button).
'use strict';

const express = require('express');

let _config = {};

function init(config) { _config = config || {}; }

const TEMPLATE = () => (process.env.DEAL_TEMPLATE_NAME || 'mr_car_deal_card').trim();

function _phoneOf(lead) {
  const p = String(lead?.phone || lead?.raw?.phone || lead?.raw?.from || '').replace(/[^\d]/g, '');
  if (p.length === 10) return '91' + p;
  return p.length >= 12 ? p : null;
}

/**
 * Match leads whose stored text mentions this car's make/model.
 */
function findMatchedLeads(car, { days = 90, limit = 50 } = {}) {
  let leads = [];
  try { leads = _config.loadCrmLeadsSafe() || []; } catch (e) {}
  if (!Array.isArray(leads)) leads = [];

  const tokens = [car.make, car.model, ...(String(car.model || '').split(/\s+/))]
    .map(t => String(t || '').toLowerCase().trim())
    .filter(t => t.length > 2);
  if (!tokens.length) return [];

  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const seen = new Set();
  const out = [];
  for (const lead of leads) {
    const phone = _phoneOf(lead);
    if (!phone || seen.has(phone)) continue;
    const ts = Date.parse(lead.timestamp || lead.createdAt || '') || 0;
    if (ts && ts < cutoff) continue;
    const text = JSON.stringify(lead).toLowerCase();
    if (tokens.some(t => text.includes(t))) {
      seen.add(phone);
      out.push({ phone, name: lead.name || '', leadId: lead.id || '' });
      if (out.length >= limit) break;
    }
  }
  return out;
}

function _fmt(n) {
  try {
    const s = String(_config.fmtMoney(n));
    return s.includes('₹') ? s : `₹${s}`;
  } catch (e) { return `₹${Number(n).toLocaleString('en-IN')}`; }
}

function _bodyParams(car) {
  const clean = s => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 120) || '-';
  const title = [car.year, car.make, car.model, car.variant].filter(Boolean).join(' ');
  const price = Number(car.price?.offer) || Number(car.price?.asking) || Number(car.price?.onRoad) || 0;
  let priceLine = price ? _fmt(price) : 'Best price on request';
  if (car.type === 'new' && car.price?.onRoad) priceLine = `${_fmt(car.price.onRoad)} on-road`;
  return [
    clean(title),
    clean(priceLine),
    clean(car.deal?.headline || 'Exclusive Mr. Car deal'),
    clean(car.deal?.validTill || 'limited period')
  ];
}

/**
 * Send the deal template to matched leads (or an explicit list).
 */
async function blastDeal(carId, { limit = 50, dryRun = false, to = null } = {}) {
  const car = _config.inventory.findCar(carId);
  if (!car) return { ok: false, error: 'Car not found' };
  if (car.status !== 'live') return { ok: false, error: 'Publish the car first' };

  const base = String(process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');
  const cover = (car.photos || []).find(p => p.cover) || (car.photos || [])[0];
  if (!base || !cover) return { ok: false, error: 'Car needs at least one photo for the blast card' };
  const heroUrl = `${base}${cover.url}`;

  const targets = to
    ? [{ phone: String(to).replace(/[^\d]/g, ''), name: '' }]
    : findMatchedLeads(car, { limit });
  if (!targets.length) return { ok: true, matched: 0, sent: 0, failed: 0, dryRun };
  if (dryRun) return { ok: true, matched: targets.length, sent: 0, failed: 0, dryRun: true, sample: targets.slice(0, 5) };

  const body = _bodyParams(car);
  let sent = 0, failed = 0;
  const errors = [];
  for (const t of targets) {
    const components = [
      { type: 'header', parameters: [{ type: 'image', image: { link: heroUrl } }] },
      { type: 'body', parameters: body.map(text => ({ type: 'text', text })) },
      { type: 'button', sub_type: 'quick_reply', index: '0', parameters: [{ type: 'payload', payload: `INV_DEAL_${car.id}` }] },
      { type: 'button', sub_type: 'quick_reply', index: '1', parameters: [{ type: 'payload', payload: `INV_TD_${car.id}` }] },
      { type: 'button', sub_type: 'url', index: '2', parameters: [{ type: 'text', text: car.id }] }
    ];
    try {
      const r = await _config.waSendTemplate(t.phone, TEMPLATE(), components);
      if (r?.ok) sent++;
      else { failed++; if (errors.length < 3) errors.push(r?.error?.message || JSON.stringify(r?.error || r).slice(0, 120)); }
    } catch (e) { failed++; if (errors.length < 3) errors.push(e.message); }
    await new Promise(r => setTimeout(r, 350));
  }
  console.log(`DealBlast: ${car.id} → sent ${sent}, failed ${failed} of ${targets.length}`);
  return { ok: true, matched: targets.length, sent, failed, errors: errors.length ? errors : undefined };
}

// ---------------- Router (admin) ----------------
const router = express.Router();
router.use('/api/inventory/cars/:id/blast', express.json(), (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  const expected = String(process.env.INVENTORY_ADMIN_TOKEN || '').trim();
  if (!expected || String(req.headers['x-admin-token'] || '').trim() !== expected) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  next();
});

router.post('/api/inventory/cars/:id/blast', async (req, res) => {
  try {
    const out = await blastDeal(req.params.id, {
      limit: Number(req.body?.limit) || 50,
      dryRun: !!req.body?.dryRun,
      to: req.body?.to || null
    });
    res.json(out);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

module.exports = { init, router, findMatchedLeads, blastDeal };
