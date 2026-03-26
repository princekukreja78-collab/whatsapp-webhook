// lib/priceAlerts.cjs — Price drop alerts for customers
// Tracks what each customer enquired about + price.
// When a new lower price is found (via scrapers or dealer sheet), alerts them.

const fs = require('fs');
const path = require('path');

let _config = {};

const ALERTS_FILE = path.join(__dirname, '..', 'price_alerts.json');
let alerts = []; // { phone, name, model, city, quotedPrice, quotedAt, alertSent, alertCount }

function init(config) {
  _config = config;
  _loadAlerts();
  // Check for price drops every 30 minutes
  setInterval(_checkPriceDrops, 30 * 60 * 1000);
  console.log(`PriceAlerts: loaded ${alerts.length} price watches`);
}

function _loadAlerts() {
  try {
    if (fs.existsSync(ALERTS_FILE)) {
      alerts = JSON.parse(fs.readFileSync(ALERTS_FILE, 'utf8')) || [];
    }
  } catch (e) { alerts = []; }
}

function _saveAlerts() {
  try {
    // Keep last 1000
    if (alerts.length > 1000) alerts = alerts.slice(-1000);
    fs.writeFileSync(ALERTS_FILE, JSON.stringify(alerts, null, 2), 'utf8');
  } catch (e) { console.warn('PriceAlerts: save failed', e.message); }
}

// IST working hours
function _isWorkingHours() {
  const now = new Date();
  const istMinutes = (now.getUTCHours() * 60 + now.getUTCMinutes()) + 330;
  const istHour = Math.floor((istMinutes % 1440) / 60);
  const day = now.getUTCDay();
  const istDay = istMinutes >= 1440 ? (day + 1) % 7 : day;
  if (istDay === 0) return false;
  return istHour >= 10 && istHour < 19;
}

// ==================== PUBLIC API ====================

/**
 * Track a customer's price point for future alerts.
 * Call this after every quote sent to a customer.
 */
function trackPrice(data) {
  const { phone, name, model, city, quotedPrice } = data;
  if (!phone || !model || !quotedPrice) return;

  // Find existing or create new
  const existing = alerts.find(a =>
    a.phone === phone &&
    a.model.toLowerCase() === model.toLowerCase()
  );

  if (existing) {
    // Update with latest quote
    existing.quotedPrice = quotedPrice;
    existing.quotedAt = new Date().toISOString();
    existing.alertSent = false; // Reset — new quote, new threshold
    existing.name = name || existing.name;
    existing.city = city || existing.city;
  } else {
    alerts.push({
      phone,
      name: name || '',
      model: model || '',
      city: city || 'delhi',
      quotedPrice,
      quotedAt: new Date().toISOString(),
      alertSent: false,
      alertCount: 0
    });
  }

  _saveAlerts();
}

/**
 * Remove a customer from price watch (they bought or opted out).
 */
function removeWatch(phone, model) {
  const idx = alerts.findIndex(a => a.phone === phone && (!model || a.model.toLowerCase() === model.toLowerCase()));
  if (idx >= 0) {
    alerts.splice(idx, 1);
    _saveAlerts();
  }
}

// ==================== PRICE DROP CHECK ====================

async function _checkPriceDrops() {
  if (!_isWorkingHours()) return;
  if (!_config.carSearch || !_config.waSendText) return;

  // Only check alerts that haven't been sent yet and are at least 2 days old
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  const pending = alerts.filter(a =>
    !a.alertSent &&
    a.alertCount < 3 && // Max 3 price alerts per model per customer
    a.quotedAt < twoDaysAgo
  );

  if (!pending.length) return;

  // Group by model to batch searches
  const byModel = {};
  for (const a of pending) {
    const key = a.model.toLowerCase();
    if (!byModel[key]) byModel[key] = [];
    byModel[key].push(a);
  }

  let sent = 0;

  for (const [model, group] of Object.entries(byModel)) {
    if (sent >= 3) break; // Max 3 alerts per cycle

    try {
      // Search current prices
      const city = group[0].city || 'delhi';
      const { results } = await _config.carSearch.search({
        model,
        city,
        panIndia: false,
        limit: 5
      });

      if (!results.length) continue;

      // Find cheapest current price
      const cheapest = results.reduce((min, r) => r.price < min.price ? r : min, results[0]);

      for (const alert of group) {
        if (sent >= 3) break;

        // Only alert if price dropped at least 5%
        const drop = alert.quotedPrice - cheapest.price;
        const dropPct = (drop / alert.quotedPrice) * 100;

        if (dropPct < 5) continue; // Not significant enough

        const name = alert.name || 'there';
        const modelDisplay = model.charAt(0).toUpperCase() + model.slice(1);

        const msg =
          `Hi ${name}, great news on *${modelDisplay}*!\n\n` +
          `Your last quoted price: *${_fmtPrice(alert.quotedPrice)}*\n` +
          `New price found: *${_fmtPrice(cheapest.price)}* (${_fmtPrice(drop)} lower)\n\n` +
          `${cheapest.title || ''}\n` +
          `${cheapest.km ? (cheapest.km / 1000).toFixed(0) + 'K km' : ''} | ${cheapest.fuel || ''} | ${cheapest.owners || ''}\n\n` +
          `Reply *YES* to grab this deal before it's gone.\n` +
          `_MR. CAR — we find the deals, you save the money._`;

        await _config.waSendText(alert.phone, msg);
        console.log(`PriceAlerts: sent drop alert to ${alert.phone} for ${model} (${dropPct.toFixed(0)}% drop)`);

        alert.alertSent = true;
        alert.alertCount = (alert.alertCount || 0) + 1;
        sent++;

        await new Promise(r => setTimeout(r, 2000)); // Rate limit
      }
    } catch (e) {
      console.warn(`PriceAlerts: check failed for ${model}`, e.message);
    }
  }

  if (sent > 0) _saveAlerts();
}

function _fmtPrice(p) {
  if (!p || p <= 0) return '';
  if (p >= 10000000) return `₹${(p / 10000000).toFixed(2)} Cr`;
  if (p >= 100000) return `₹${(p / 100000).toFixed(1)}L`;
  return `₹${p.toLocaleString('en-IN')}`;
}

function getAlertStats() {
  const active = alerts.filter(a => !a.alertSent && a.alertCount < 3).length;
  const sent = alerts.filter(a => a.alertSent).length;
  return { total: alerts.length, active, sent };
}

module.exports = {
  init,
  trackPrice,
  removeWatch,
  getAlertStats
};
