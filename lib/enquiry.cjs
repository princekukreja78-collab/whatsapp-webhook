// lib/enquiry.cjs — Car enquiry flow (customer → MR.CAR → dealer → customer)
// PROD collects enquiry, forwards to STAGING API.
// STAGING routes to salesman, collects deal, sends back to PROD.

const fs = require('fs');
const path = require('path');

let _config = {};

function init(config) {
  _config = config;
  // Load existing enquiries from disk
  _loadEnquiries();
}

// ==================== STORAGE ====================
const ENQUIRY_FILE = path.join(__dirname, '..', 'enquiry_data.json');
const enquiries = new Map(); // enquiryId → enquiry object
const customerEnquiry = new Map(); // customerPhone → enquiryId (active)
const salesmanEnquiry = new Map(); // salesmanPhone → enquiryId (active)

function _loadEnquiries() {
  try {
    if (!fs.existsSync(ENQUIRY_FILE)) return;
    const data = JSON.parse(fs.readFileSync(ENQUIRY_FILE, 'utf8'));
    if (Array.isArray(data)) {
      for (const e of data) {
        enquiries.set(e.id, e);
        if (e.state !== 'CLOSED' && e.state !== 'EXPIRED') {
          if (e.customerPhone) customerEnquiry.set(e.customerPhone, e.id);
          if (e.salesmanPhone) salesmanEnquiry.set(e.salesmanPhone, e.id);
        }
      }
    }
    console.log(`Enquiry: loaded ${enquiries.size} enquiries`);
  } catch (e) {
    console.warn('Enquiry: load failed', e.message);
  }
}

function _saveEnquiries() {
  try {
    const arr = Array.from(enquiries.values());
    fs.writeFileSync(ENQUIRY_FILE, JSON.stringify(arr, null, 2), 'utf8');
  } catch (e) {
    console.warn('Enquiry: save failed', e.message);
  }
}

function _genId() {
  return 'ENQ-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
}

// ==================== CONVERSATION STATES ====================
// Per-customer state machine stored in sessionService via setLastService
//
// States:
//   ENQ_ASK_MODEL    → waiting for car model name
//   ENQ_ASK_VARIANT  → waiting for variant selection
//   ENQ_ASK_COLOR    → waiting for color preference
//   ENQ_ASK_NAME     → waiting for customer name + city
//   ENQ_CONFIRM      → waiting for YES/NO confirmation
//   ENQ_WAITING      → enquiry forwarded, waiting for deal
//   ENQ_DEAL_READY   → deal received, sent to customer

// Temp storage for in-progress enquiry data (before confirmation)
const enquiryDraft = new Map(); // customerPhone → { model, variant, color, name, city }

// ==================== PROD: CUSTOMER-FACING FLOW ====================

// Entry point — called when customer selects "Best Car Deal" from menu
async function startEnquiry(from) {
  // Check if customer already has active enquiry
  const existingId = customerEnquiry.get(from);
  if (existingId) {
    const existing = enquiries.get(existingId);
    if (existing && !['CLOSED', 'EXPIRED'].includes(existing.state)) {
      await _config.waSendText(from,
        `You already have an active enquiry for *${existing.carModel} ${existing.variant || ''}*.\n\n` +
        `We're working on getting you the best deal. Please wait for our response.`
      );
      return true;
    }
  }

  enquiryDraft.set(from, {});
  _config.setLastService(from, 'ENQ_ASK_MODEL');

  await _config.waSendText(from,
    `*MR. CAR — Best Deal Service*\n\n` +
    `We negotiate with multiple dealers to get you the *lowest price* with full transparency.\n\n` +
    `Which car are you interested in?\n` +
    `_(e.g., Fortuner, Creta, Innova HyCross, Thar, City)_`
  );
  return true;
}

// Handle customer messages during enquiry flow
async function handleEnquiryMessage(from, msgText, lastSvc) {
  if (!lastSvc || !lastSvc.startsWith('ENQ_')) return false;

  const text = (msgText || '').trim();
  if (!text) return false;

  switch (lastSvc) {
    case 'ENQ_ASK_MODEL':
      return await _handleModelReply(from, text);
    case 'ENQ_ASK_VARIANT':
      return await _handleVariantReply(from, text);
    case 'ENQ_ASK_COLOR':
      return await _handleColorReply(from, text);
    case 'ENQ_ASK_NAME':
      return await _handleNameReply(from, text);
    case 'ENQ_CONFIRM':
      return await _handleConfirmReply(from, text);
    case 'ENQ_WAITING':
      // Customer asking about status
      await _config.waSendText(from,
        `Your enquiry is being processed. Our team is negotiating the best deal for you.\n\n` +
        `We'll get back to you shortly with the best price and availability.`
      );
      return true;
    default:
      return false;
  }
}

async function _handleModelReply(from, text) {
  const draft = enquiryDraft.get(from) || {};
  draft.model = text;
  enquiryDraft.set(from, draft);

  _config.setLastService(from, 'ENQ_ASK_VARIANT');
  await _config.waSendText(from,
    `Great choice — *${text}*!\n\n` +
    `Which variant are you looking for?\n` +
    `_(e.g., ZX, VX, GX, base model, top model, or "not sure")_`
  );
  return true;
}

async function _handleVariantReply(from, text) {
  const draft = enquiryDraft.get(from) || {};
  draft.variant = text.toLowerCase() === 'not sure' ? 'Any' : text;
  enquiryDraft.set(from, draft);

  _config.setLastService(from, 'ENQ_ASK_COLOR');

  // Send color as interactive buttons (top 3 + "Any")
  const buttons = [
    { type: 'reply', reply: { id: 'ENQ_CLR_WHITE', title: 'White' } },
    { type: 'reply', reply: { id: 'ENQ_CLR_BLACK', title: 'Black / Grey' } },
    { type: 'reply', reply: { id: 'ENQ_CLR_OTHER', title: 'Other / Any' } }
  ];
  await _config.waSendRaw({
    messaging_product: 'whatsapp', to: from, type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: 'What color do you prefer?' },
      action: { buttons }
    }
  });
  return true;
}

async function _handleColorReply(from, text) {
  const draft = enquiryDraft.get(from) || {};

  // Handle button IDs or free text
  if (text === 'ENQ_CLR_WHITE') draft.color = 'White';
  else if (text === 'ENQ_CLR_BLACK') draft.color = 'Black / Grey';
  else if (text === 'ENQ_CLR_OTHER') draft.color = 'Any';
  else draft.color = text;

  enquiryDraft.set(from, draft);

  _config.setLastService(from, 'ENQ_ASK_NAME');
  await _config.waSendText(from,
    `Almost done! Please share your:\n\n` +
    `*Name* and *City*\n` +
    `_(e.g., Rahul, Delhi)_`
  );
  return true;
}

async function _handleNameReply(from, text) {
  const draft = enquiryDraft.get(from) || {};

  // Try to split "Name, City"
  const parts = text.split(/[,\-\/]+/).map(s => s.trim()).filter(Boolean);
  draft.name = parts[0] || text;
  draft.city = parts[1] || '';

  enquiryDraft.set(from, draft);

  _config.setLastService(from, 'ENQ_CONFIRM');

  // Show summary and ask for confirmation
  const summary =
    `*Your Enquiry Summary:*\n\n` +
    `Car: *${draft.model}*\n` +
    `Variant: *${draft.variant || 'Any'}*\n` +
    `Color: *${draft.color || 'Any'}*\n` +
    `Name: *${draft.name}*\n` +
    (draft.city ? `City: *${draft.city}*\n` : '') +
    `\nShall we proceed? Reply *YES* to confirm or *NO* to cancel.`;

  await _config.waSendText(from, summary);
  return true;
}

async function _handleConfirmReply(from, text) {
  const reply = text.toLowerCase().trim();

  if (reply === 'no' || reply === 'n' || reply === 'cancel') {
    enquiryDraft.delete(from);
    _config.setLastService(from, 'NEW');
    await _config.waSendText(from, 'Enquiry cancelled. Feel free to start a new one anytime!');
    await _config.waSendListMenu(from);
    return true;
  }

  if (reply !== 'yes' && reply !== 'y') {
    await _config.waSendText(from, 'Please reply with *YES* to confirm or *NO* to cancel.');
    return true;
  }

  // Confirmed — create enquiry
  const draft = enquiryDraft.get(from) || {};
  const enquiry = {
    id: _genId(),
    customerPhone: from,
    customerName: draft.name || 'Customer',
    carModel: draft.model || '',
    variant: draft.variant || 'Any',
    color: draft.color || 'Any',
    city: draft.city || '',
    state: 'FORWARDED',
    createdAt: new Date().toISOString(),
    salesmanPhone: null,
    dealerName: null,
    bestPrice: null,
    availability: null,
    respondedAt: null
  };

  enquiries.set(enquiry.id, enquiry);
  customerEnquiry.set(from, enquiry.id);
  enquiryDraft.delete(from);
  _saveEnquiries();

  _config.setLastService(from, 'ENQ_WAITING');

  await _config.waSendText(from,
    `*Enquiry Submitted!*\n\n` +
    `We're now contacting multiple dealers to get you the *best deal* on your *${enquiry.carModel} ${enquiry.variant}*.\n\n` +
    `You'll receive the best offer with price and availability shortly.\n` +
    `Enquiry ID: ${enquiry.id}`
  );

  // Forward to staging (dealer side)
  await _forwardToStaging(enquiry);

  return true;
}

// ==================== PROD → STAGING FORWARDING ====================

async function _forwardToStaging(enquiry) {
  const stagingUrl = (_config.STAGING_API_URL || '').trim();
  if (!stagingUrl) {
    console.warn('Enquiry: STAGING_API_URL not set, cannot forward');
    // Alert admin
    if (_config.sendAdminAlert) {
      await _config.sendAdminAlert({
        from: enquiry.customerPhone,
        name: enquiry.customerName,
        text: `NEW ENQUIRY (no staging URL): ${enquiry.carModel} ${enquiry.variant} ${enquiry.color} — ${enquiry.city}`
      });
    }
    return;
  }

  try {
    const resp = await _config.fetch(`${stagingUrl}/api/enquiry/receive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(enquiry)
    });
    if (!resp.ok) {
      console.error('Enquiry: staging forward failed', resp.status);
    } else {
      console.log('Enquiry: forwarded to staging', enquiry.id);
    }
  } catch (e) {
    console.error('Enquiry: staging forward error', e.message);
  }
}

// ==================== STAGING: DEALER ROUTING ====================

// Load dealer-salesman mapping from Google Sheet CSV
// Sheet format: Dealership, City, Brand, Salesman Name, WhatsApp Number, Active
let _dealerCache = null;
let _dealerCacheAt = 0;
const DEALER_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

async function _loadDealerSheet() {
  if (_dealerCache && (Date.now() - _dealerCacheAt < DEALER_CACHE_TTL)) {
    return _dealerCache;
  }

  const sheetUrl = (_config.DEALER_SHEET_CSV_URL || '').trim();
  if (!sheetUrl) {
    console.warn('Enquiry: DEALER_SHEET_CSV_URL not set');
    return [];
  }

  try {
    const resp = await _config.fetch(sheetUrl);
    const text = await resp.text();
    const rows = _parseSimpleCsv(text);
    _dealerCache = rows;
    _dealerCacheAt = Date.now();
    console.log(`Enquiry: loaded ${rows.length} dealer entries`);
    return rows;
  } catch (e) {
    console.error('Enquiry: dealer sheet load failed', e.message);
    return _dealerCache || [];
  }
}

function _parseSimpleCsv(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) return [];

  const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
  const result = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',').map(c => c.trim());
    const row = {};
    headers.forEach((h, idx) => { row[h] = cols[idx] || ''; });
    result.push(row);
  }
  return result;
}

// Find best matching salesman for an enquiry
async function _findSalesman(enquiry) {
  const dealers = await _loadDealerSheet();
  if (!dealers.length) return null;

  const modelLower = (enquiry.carModel || '').toLowerCase();
  const cityLower = (enquiry.city || '').toLowerCase();

  // Score each dealer
  let bestMatch = null;
  let bestScore = -1;

  for (const d of dealers) {
    // Must be active
    const active = (d.active || '').toLowerCase();
    if (active !== 'yes' && active !== 'y' && active !== 'true') continue;

    const phone = (d['whatsapp number'] || d.phone || d.whatsapp || '').replace(/\D/g, '');
    if (!phone) continue;

    let score = 0;

    // Brand match
    const brand = (d.brand || '').toLowerCase();
    if (brand && modelLower.includes(brand)) score += 3;

    // City match
    const dealerCity = (d.city || '').toLowerCase();
    if (cityLower && dealerCity && cityLower.includes(dealerCity)) score += 2;
    if (cityLower && dealerCity && dealerCity.includes(cityLower)) score += 2;

    // Model match (if dealer has model column)
    const dealerModels = (d.models || d.model || '').toLowerCase();
    if (dealerModels && modelLower) {
      const models = dealerModels.split(/[,;\/]+/).map(m => m.trim());
      for (const m of models) {
        if (m && modelLower.includes(m)) score += 5;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestMatch = {
        dealerName: d.dealership || d.dealer || d.name || 'Dealer',
        salesmanName: d['salesman name'] || d.salesman || d.contact || 'Salesman',
        salesmanPhone: phone,
        city: d.city || '',
        brand: d.brand || ''
      };
    }
  }

  return bestMatch;
}

// Receive enquiry from PROD (called on STAGING side)
async function receiveEnquiry(enquiry) {
  console.log('Enquiry: received from prod', enquiry.id);

  // Store locally on staging
  enquiries.set(enquiry.id, enquiry);
  customerEnquiry.set(enquiry.customerPhone, enquiry.id);
  _saveEnquiries();

  // Find matching salesman
  const match = await _findSalesman(enquiry);

  if (!match) {
    console.warn('Enquiry: no matching salesman found for', enquiry.carModel, enquiry.city);
    // Alert admin on staging
    if (_config.ADMIN_WA) {
      await _config.waSendText(_config.ADMIN_WA,
        `No dealer found for enquiry ${enquiry.id}:\n` +
        `Car: ${enquiry.carModel} ${enquiry.variant}\n` +
        `City: ${enquiry.city}\n` +
        `Customer: ${enquiry.customerName}`
      );
    }
    return { ok: false, error: 'No matching salesman' };
  }

  // Update enquiry with salesman info
  enquiry.salesmanPhone = match.salesmanPhone;
  enquiry.dealerName = match.dealerName;
  enquiry.state = 'SENT_TO_DEALER';
  _saveEnquiries();

  // Track salesman → enquiry mapping
  salesmanEnquiry.set(match.salesmanPhone, enquiry.id);

  // Send enquiry to salesman via WhatsApp
  const msg =
    `*New Customer Enquiry — ${enquiry.id}*\n\n` +
    `Car: *${enquiry.carModel}*\n` +
    `Variant: *${enquiry.variant || 'Any'}*\n` +
    `Color: *${enquiry.color || 'Any'}*\n` +
    `City: *${enquiry.city || '-'}*\n\n` +
    `Please reply with:\n` +
    `*Best price, availability, and any current offers.*\n\n` +
    `_(Reply to this message with the deal details)_`;

  await _config.waSendText(match.salesmanPhone, msg);

  console.log(`Enquiry: forwarded ${enquiry.id} to ${match.salesmanName} (${match.salesmanPhone})`);

  return { ok: true, salesman: match.salesmanName, dealer: match.dealerName };
}

// Handle salesman's reply (called on STAGING side)
async function handleSalesmanReply(from, msgText) {
  const enquiryId = salesmanEnquiry.get(from);
  if (!enquiryId) return false;

  const enquiry = enquiries.get(enquiryId);
  if (!enquiry || enquiry.state === 'CLOSED') return false;

  // Salesman replied with deal details
  enquiry.bestPrice = msgText;
  enquiry.respondedAt = new Date().toISOString();
  enquiry.state = 'DEAL_RECEIVED';
  _saveEnquiries();

  // Acknowledge to salesman
  await _config.waSendText(from,
    `Thank you! Deal noted for enquiry ${enquiry.id}.\n` +
    `We'll share this with the customer.`
  );

  // Forward deal back to PROD
  await _forwardDealToProd(enquiry);

  // Clean up mapping
  salesmanEnquiry.delete(from);

  return true;
}

// STAGING → PROD: send deal back
async function _forwardDealToProd(enquiry) {
  const prodUrl = (_config.PROD_API_URL || '').trim();
  if (!prodUrl) {
    console.warn('Enquiry: PROD_API_URL not set');
    return;
  }

  try {
    const resp = await _config.fetch(`${prodUrl}/api/enquiry/deal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        enquiryId: enquiry.id,
        customerPhone: enquiry.customerPhone,
        carModel: enquiry.carModel,
        variant: enquiry.variant,
        color: enquiry.color,
        bestPrice: enquiry.bestPrice,
        respondedAt: enquiry.respondedAt
      })
    });
    if (resp.ok) {
      console.log('Enquiry: deal forwarded to prod', enquiry.id);
    } else {
      console.error('Enquiry: deal forward failed', resp.status);
    }
  } catch (e) {
    console.error('Enquiry: deal forward error', e.message);
  }
}

// ==================== PROD: RECEIVE DEAL & SEND TO CUSTOMER ====================

async function receiveDeal(dealData) {
  const { enquiryId, customerPhone, carModel, variant, color, bestPrice } = dealData;

  // Update local enquiry
  const enquiry = enquiries.get(enquiryId);
  if (enquiry) {
    enquiry.bestPrice = bestPrice;
    enquiry.respondedAt = dealData.respondedAt;
    enquiry.state = 'DEAL_READY';
    _saveEnquiries();
  }

  // Send deal to customer — NO dealer/salesman info exposed
  const dealMsg =
    `*Your Best Deal is Ready!*\n\n` +
    `Car: *${carModel} ${variant || ''}*\n` +
    `Color: *${color || 'As requested'}*\n\n` +
    `${bestPrice}\n\n` +
    `_This is the best negotiated price from our dealer network._\n\n` +
    `Interested? Reply *BOOK* to proceed or *NEW DEAL* for another enquiry.\n\n` +
    `_Powered by MR. CAR — Your Car Buying Partner_`;

  await _config.waSendText(customerPhone, dealMsg);

  // Mark as closed
  if (enquiry) {
    enquiry.state = 'CLOSED';
    customerEnquiry.delete(customerPhone);
    _saveEnquiries();
  }

  // Reset customer service state
  _config.setLastService(customerPhone, 'NEW');

  return { ok: true };
}

// ==================== EXPRESS ROUTES ====================

function getRouter() {
  const express = require('express');
  const router = express.Router();

  // STAGING endpoint: receive enquiry from PROD
  router.post('/api/enquiry/receive', async (req, res) => {
    try {
      const result = await receiveEnquiry(req.body);
      res.json(result);
    } catch (e) {
      console.error('Enquiry receive error:', e.message);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // PROD endpoint: receive deal from STAGING
  router.post('/api/enquiry/deal', async (req, res) => {
    try {
      const result = await receiveDeal(req.body);
      res.json(result);
    } catch (e) {
      console.error('Enquiry deal error:', e.message);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // Admin: list all enquiries
  router.get('/api/enquiries', (req, res) => {
    const arr = Array.from(enquiries.values())
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, 50);
    res.json({ ok: true, count: arr.length, enquiries: arr });
  });

  return router;
}

// ==================== WORKING HOURS CHECK ====================

function isWorkingHours() {
  // IST = UTC+5:30
  const now = new Date();
  const istHour = (now.getUTCHours() + 5 + (now.getUTCMinutes() + 30 >= 60 ? 1 : 0)) % 24;
  const istDay = now.getUTCDay(); // 0=Sun

  // Mon-Sat, 10am-7pm IST
  if (istDay === 0) return false; // Sunday off
  return istHour >= 10 && istHour < 19;
}

// ==================== EXPORTS ====================

module.exports = {
  init,
  startEnquiry,
  handleEnquiryMessage,
  handleSalesmanReply,
  receiveEnquiry,
  receiveDeal,
  getRouter,
  isWorkingHours,
  // For testing
  enquiries,
  customerEnquiry,
  salesmanEnquiry
};
