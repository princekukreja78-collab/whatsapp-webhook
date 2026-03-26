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

// ==================== HELPERS ====================

function _fmtPrice(p) {
  if (!p || p <= 0) return '';
  if (p >= 10000000) return `₹${(p / 10000000).toFixed(2)} Cr`;
  if (p >= 100000) return `₹${(p / 100000).toFixed(1)}L`;
  return `₹${p.toLocaleString('en-IN')}`;
}

/**
 * Extract asking price and last price from dealer's reply text.
 * Handles: "asking 12 lakh last 10.5", "AP 12L LP 10.5L",
 *          "12 lakh asking, best 10.5", "price 850000 last 750000"
 */
function _extractPricesFromReply(text) {
  const t = (text || '').toLowerCase();
  const result = { askingPrice: 0, lastPrice: 0 };

  // Helper: parse a price value
  function parsePrice(str) {
    if (!str) return 0;
    const s = str.replace(/[,₹\s]/g, '');
    const lakhMatch = s.match(/([\d.]+)\s*(?:l|lakh|lac)/i);
    if (lakhMatch) return Math.round(Number(lakhMatch[1]) * 100000);
    const crMatch = s.match(/([\d.]+)\s*(?:cr|crore)/i);
    if (crMatch) return Math.round(Number(crMatch[1]) * 10000000);
    const num = Number(s.match(/[\d.]+/)?.[0]);
    if (num > 10000) return Math.round(num);
    if (num > 0 && num < 200) return Math.round(num * 100000); // assume lakhs
    return 0;
  }

  // Pattern: "asking X last Y" or "ask X last Y"
  const askLastMatch = t.match(/(?:asking|ask|ap|quoted?)\s*[:\-]?\s*([\d.,]+\s*(?:l|lakh|lac|cr|crore)?)\s*.*?(?:last|best|bottom|final|lp|lowest)\s*[:\-]?\s*([\d.,]+\s*(?:l|lakh|lac|cr|crore)?)/i);
  if (askLastMatch) {
    result.askingPrice = parsePrice(askLastMatch[1]);
    result.lastPrice = parsePrice(askLastMatch[2]);
    return result;
  }

  // Pattern: "last X asking Y" (reversed)
  const lastAskMatch = t.match(/(?:last|best|bottom|final|lp|lowest)\s*[:\-]?\s*([\d.,]+\s*(?:l|lakh|lac|cr|crore)?)\s*.*?(?:asking|ask|ap|quoted?)\s*[:\-]?\s*([\d.,]+\s*(?:l|lakh|lac|cr|crore)?)/i);
  if (lastAskMatch) {
    result.lastPrice = parsePrice(lastAskMatch[1]);
    result.askingPrice = parsePrice(lastAskMatch[2]);
    return result;
  }

  // Pattern: two prices mentioned — first = asking, second = last
  const allPrices = [];
  const priceRegex = /([\d.,]+)\s*(?:l|lakh|lac|cr|crore)/gi;
  let m;
  while ((m = priceRegex.exec(t)) !== null) {
    allPrices.push(parsePrice(m[0]));
  }
  // Also check raw numbers > 50000
  const rawNums = t.match(/\b(\d{5,8})\b/g);
  if (rawNums) rawNums.forEach(n => allPrices.push(Number(n)));

  if (allPrices.length >= 2) {
    // Higher = asking, lower = last
    allPrices.sort((a, b) => b - a);
    result.askingPrice = allPrices[0];
    result.lastPrice = allPrices[allPrices.length - 1];
  } else if (allPrices.length === 1) {
    // Only one price — treat as last price (dealer giving final number)
    result.lastPrice = allPrices[0];
    result.askingPrice = allPrices[0];
  }

  return result;
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

  // Build dealer message — always on INDIVIDUAL number, never in group
  // Identify as MR. CAR and ask for photos + asking price + last price
  const BUSINESS_NAME = process.env.MRCAR_BUSINESS_NAME || 'MR. CAR, Ashok Vihar';

  let msg;
  if (enquiry.requestType === 'PHOTO_PRICE') {
    msg =
      `Hi, this is an assistant from *${BUSINESS_NAME}*.\n\n` +
      `We have a customer interested in your *${enquiry.carModel}*.\n` +
      (enquiry.color && enquiry.color !== 'Any' ? `Color preference: *${enquiry.color}*\n` : '') +
      (enquiry.rawText ? `\n_Ref: "${enquiry.rawText.slice(0, 150)}"_\n` : '') +
      `\nKindly share:\n` +
      `1. *Photos* (2-3 pics)\n` +
      `2. *Asking price*\n` +
      `3. *Last price* (best you can offer)\n\n` +
      `Please reply here with the details. Thank you.`;
  } else {
    msg =
      `Hi, this is an assistant from *${BUSINESS_NAME}*.\n\n` +
      `We have a customer enquiry:\n\n` +
      `Car: *${enquiry.carModel}*\n` +
      `Variant: *${enquiry.variant || 'Any'}*\n` +
      `Color: *${enquiry.color || 'Any'}*\n` +
      `City: *${enquiry.city || '-'}*\n\n` +
      `Kindly share:\n` +
      `1. *Asking price*\n` +
      `2. *Last price* (best you can offer)\n` +
      `3. *Availability & current offers*\n\n` +
      `Please reply here. Thank you.`;
  }

  // Contact dealer on INDIVIDUAL number — never in group
  // Priority: original dealer phone (from group post) → matched salesman from sheet
  const directDealer = enquiry.dealerPhone || null;
  const targetPhone = directDealer || match.salesmanPhone;

  // If we have the direct dealer number, prefer it
  if (directDealer && directDealer !== match.salesmanPhone) {
    try {
      await _config.waSendText(directDealer, msg);
      salesmanEnquiry.set(directDealer, enquiry.id);
      console.log(`Enquiry: sent to dealer direct number ${directDealer}`);
    } catch (e) {
      console.warn('Enquiry: direct dealer contact failed, falling back to sheet match', e.message);
    }
  }

  await _config.waSendText(match.salesmanPhone, msg);

  console.log(`Enquiry: forwarded ${enquiry.id} to ${match.salesmanName} (${match.salesmanPhone})`);

  return { ok: true, salesman: match.salesmanName, dealer: match.dealerName };
}

// Handle salesman's reply (called on STAGING side)
// Accumulates replies — dealer may send photos first, then price.
// Waits 60s after last message before forwarding to customer.
async function handleSalesmanReply(from, msgText, imageUrl) {
  const enquiryId = salesmanEnquiry.get(from);
  if (!enquiryId) return false;

  const enquiry = enquiries.get(enquiryId);
  if (!enquiry || enquiry.state === 'CLOSED') return false;

  // Initialize accumulator
  if (!enquiry._replies) enquiry._replies = [];

  // Store this reply
  if (imageUrl) {
    enquiry._replies.push({ type: 'image', url: imageUrl });
    console.log(`Enquiry ${enquiry.id}: dealer sent image`);
  }
  if (msgText) {
    enquiry._replies.push({ type: 'text', text: msgText });

    // Try to extract asking price and last price from text
    const prices = _extractPricesFromReply(msgText);
    if (prices.askingPrice) enquiry.askingPrice = prices.askingPrice;
    if (prices.lastPrice) enquiry.lastPrice = prices.lastPrice;
    // Also store raw text
    enquiry.dealerRawReply = (enquiry.dealerRawReply ? enquiry.dealerRawReply + '\n' : '') + msgText;

    console.log(`Enquiry ${enquiry.id}: dealer sent text`, prices);
  }

  enquiry.respondedAt = new Date().toISOString();
  _saveEnquiries();

  // Debounce: wait 60s after last message to collect all photos + prices
  if (enquiry._forwardTimer) clearTimeout(enquiry._forwardTimer);

  enquiry._forwardTimer = setTimeout(async () => {
    try {
      enquiry.state = 'DEAL_RECEIVED';
      enquiry.dealerImages = enquiry._replies
        .filter(r => r.type === 'image')
        .map(r => r.url);

      // Calculate customer price = dealer last price + margin
      // Above 10L: 5% margin | Below 10L: flat ₹50,000
      const dealerLastPrice = enquiry.lastPrice || enquiry.askingPrice || 0;
      if (dealerLastPrice > 0) {
        if (dealerLastPrice > 1000000) {
          // Above 10 lakh → 5% margin
          enquiry.margin = Math.round(dealerLastPrice * 0.05);
        } else {
          // 10 lakh and below → flat ₹50,000
          enquiry.margin = 50000;
        }
        enquiry.customerPrice = dealerLastPrice + enquiry.margin;
      }

      // bestPrice for customer = formatted customer price (NOT dealer price)
      if (enquiry.customerPrice) {
        enquiry.bestPrice = `Price: *${_fmtPrice(enquiry.customerPrice)}*`;
        if (enquiry.askingPrice && enquiry.askingPrice > enquiry.customerPrice) {
          const saving = enquiry.askingPrice - enquiry.customerPrice;
          enquiry.bestPrice += `\n_Negotiated ${_fmtPrice(saving)} below asking price for you!_`;
        }
      }

      delete enquiry._replies;
      delete enquiry._forwardTimer;
      _saveEnquiries();

      // Acknowledge to dealer
      await _config.waSendText(from,
        `Thank you for the details! We'll get back to you if the customer wants to proceed.`
      );

      // Forward to PROD (customer gets customerPrice, never dealer's last price)
      await _forwardDealToProd(enquiry);

      salesmanEnquiry.delete(from);

      console.log(`Enquiry ${enquiry.id}: deal processed — dealer last: ${_fmtPrice(dealerLastPrice)}, customer: ${_fmtPrice(enquiry.customerPrice)}, margin: ${_fmtPrice(enquiry.margin)}`);
    } catch (e) {
      console.error('Enquiry forward after debounce failed:', e.message);
    }
  }, 60000); // 60 seconds debounce

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
        dealerImages: enquiry.dealerImages || [],
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
  const { enquiryId, customerPhone, carModel, variant, color, bestPrice, dealerImages } = dealData;

  // Update local enquiry
  const enquiry = enquiries.get(enquiryId);
  if (enquiry) {
    enquiry.bestPrice = bestPrice;
    enquiry.dealerImages = dealerImages || [];
    enquiry.respondedAt = dealData.respondedAt;
    enquiry.state = 'DEAL_READY';
    _saveEnquiries();
  }

  // Send photos to customer first (if any) — NO dealer info in caption
  const images = dealerImages || [];
  if (images.length > 0 && _config.waSendImageLink) {
    for (let i = 0; i < Math.min(images.length, 3); i++) {
      const caption = i === 0 ? `${carModel} ${variant || ''}`.trim() : '';
      await _config.waSendImageLink(customerPhone, images[i], caption);
      await new Promise(r => setTimeout(r, 500)); // small gap between images
    }
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
