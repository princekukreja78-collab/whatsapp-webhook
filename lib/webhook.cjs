// lib/webhook.cjs — Extracted webhook handler from server.cjs
// All logic preserved exactly as-is, with config injection pattern.

const express = require('express');
const router = express.Router();

let _config = {};
function init(config) { _config = config; }

// Module-local dedup lock
const PHONE_RE = /^\d{10,15}$/;

// Parse used car query: "Creta around 12 lakh" → { model: "creta", minBudget: 10, maxBudget: 14 }
function _parseUsedCarQuery(text) {
  const t = (text || '').toLowerCase().trim();
  const result = { model: '', city: '', minBudget: 0, maxBudget: 0, panIndia: false };

  // Detect "pan india" / "all india" / "nationwide"
  if (/\b(pan\s*india|all\s*india|nationwide|any\s*city|all\s*cities)\b/i.test(t)) {
    result.panIndia = true;
  }

  // Extract budget: "around 12 lakh" or "under 15 lakh" or "10-15 lakh"
  const rangeMatch = t.match(/(\d+)\s*[-–to]+\s*(\d+)\s*(?:lakh|lac|l\b)/i);
  const aroundMatch = t.match(/(?:around|about|near|approx)\s*(\d+)\s*(?:lakh|lac|l\b)/i);
  const underMatch = t.match(/(?:under|below|within|upto|up to|max)\s*(\d+)\s*(?:lakh|lac|l\b)/i);
  const budgetMatch = t.match(/(?:budget)\s*(\d+)\s*(?:lakh|lac|l\b)?/i);

  if (rangeMatch) {
    result.minBudget = Number(rangeMatch[1]);
    result.maxBudget = Number(rangeMatch[2]);
  } else if (aroundMatch) {
    const val = Number(aroundMatch[1]);
    result.minBudget = Math.max(1, val - 2);
    result.maxBudget = val + 2;
  } else if (underMatch) {
    result.maxBudget = Number(underMatch[1]);
  } else if (budgetMatch) {
    const val = Number(budgetMatch[1]);
    result.minBudget = Math.max(1, val - 2);
    result.maxBudget = val + 2;
  }

  // Extract city (skip if pan india)
  if (!result.panIndia) {
    const cities = ['delhi', 'mumbai', 'bangalore', 'bengaluru', 'hyderabad', 'chennai', 'pune', 'kolkata', 'ahmedabad', 'jaipur', 'lucknow', 'chandigarh', 'noida', 'gurgaon', 'gurugram', 'ghaziabad'];
    for (const c of cities) {
      if (t.includes(c)) { result.city = c; break; }
    }
  }

  // Extract model: remove known noise words and budget phrases
  let cleaned = t
    .replace(/\b(used|pre[-\s]?owned|preowned|second[-\s]?hand|car|cars|around|about|near|under|below|within|upto|up to|max|budget|approx|lakh|lac|in|pan\s*india|all\s*india|nationwide|any\s*city|all\s*cities)\b/gi, '')
    .replace(/\b(19|20)\d{2}\b/g, '') // remove years
    .replace(/\d+/g, '') // remove numbers
    .replace(/[-–]/g, ' ')
    .trim();

  // Remove city from model string
  const cities = ['delhi', 'mumbai', 'bangalore', 'bengaluru', 'hyderabad', 'chennai', 'pune', 'kolkata', 'ahmedabad', 'jaipur', 'lucknow', 'chandigarh', 'noida', 'gurgaon', 'gurugram', 'ghaziabad'];
  for (const c of cities) {
    cleaned = cleaned.replace(new RegExp('\\b' + c + '\\b', 'gi'), '');
  }

  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  if (cleaned.length >= 2) result.model = cleaned;

  return result;
}

// ---- healthz ----
router.get('/healthz', (req, res) => {
  res.json({ ok: true, t: Date.now(), debug: _config.DEBUG });
});

// ---- webhook verify ----
router.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === _config.VERIFY_TOKEN && challenge) {
    console.log('Webhook verified ✅');
    return res.status(200).type('text/plain').send(String(challenge));
  }
  return res.sendStatus(403);
});

// -------------- CRM API ROUTES ---------------
router.get('/crm/leads', async (req, res) => {
  try {
    // 1) Prefer canonical CRM helper if available (from crm_helpers.cjs)
    try {
      if (typeof _config.getAllLeads === 'function') {
        const leads = await _config.getAllLeads();
        if (Array.isArray(leads) && leads.length) {
          return res.json({ ok: true, leads });
        }
      }
    } catch (e) {
      console.warn('crm/leads: getAllLeads failed, falling back to file.', e && e.message ? e.message : e);
    }

    // 2) Fallback: try reading from LEADS_FILE (crm_leads.json)
    let fileLeads = [];
    try {
      if (_config.fs.existsSync(_config.LEADS_FILE)) {
        const raw = _config.fs.readFileSync(_config.LEADS_FILE, 'utf8');
        if (raw && raw.trim()) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            fileLeads = parsed;
          } else if (parsed && Array.isArray(parsed.leads)) {
            fileLeads = parsed.leads;
          }
        }
      }
    } catch (e) {
      console.warn('crm/leads: failed to read LEADS_FILE', e && e.message ? e.message : e);
    }

    return res.json({ ok: true, leads: fileLeads });

  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});


// ---------- ADMIN TEST ALERT ----------
router.post('/admin/test_alert', async (req, res) => {
  try {
    const payload = {
      messaging_product: "whatsapp",
      to: process.env.ADMIN_WA,
      type: "text",
      text: {
        body: `🔔 ADMIN TEST ALERT\n\nThis is a test admin alert from MR.CAR server.\nTime: ${new Date().toLocaleString()}`
      }
    };

    console.log("ADMIN TEST ALERT → WA PAYLOAD:", JSON.stringify(payload, null, 2));

    const resp = await fetch(
      `https://graph.facebook.com/v19.0/${process.env.PHONE_NUMBER_ID}/messages`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.META_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      }
    );

    const result = await resp.json();
    console.log("ADMIN ALERT WA RESPONSE:", result);

    return res.json({ ok: true, result });

  } catch (e) {
    console.error("ADMIN TEST ALERT FAILED:", e);
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

// ---------------- main webhook handler ----------------
router.post('/webhook', async (req, res) => {
  try {
    // ensure `short` exists in the outer scope so later code can't throw ReferenceError
    let short = {};

        if (_config.DEBUG) {
      short = {
        object: req.body && req.body.object,
        entry0: Array.isArray(req.body?.entry)
          ? Object.keys(req.body.entry[0] || {})
          : undefined
      };
      console.log('📩 Incoming webhook (short):', JSON.stringify(short));
    }

    // --- Safely derive entry / change / value once, before using anywhere ---
    let entry  = null;
    let change = null;
    let value  = {};

    try {
      if (Array.isArray(req.body?.entry) && req.body.entry.length > 0) {
        entry = req.body.entry[0] || null;

        if (Array.isArray(entry?.changes) && entry.changes.length > 0) {
          change = entry.changes[0] || null;
          value  = change?.value || {};
        }
      }
    } catch (e) {
      console.warn("WEBHOOK PARSE FAILED:", e?.message || e);
      entry  = null;
      change = null;
      value  = {};
    }

          /* AUTO-INGEST using actual WhatsApp message fields + photo forward + AI vision */
    try {
      const msg     = value.messages?.[0];
      const contact = value.contacts?.[0];

      if (msg && msg.from) {
        const senderForAuto     = msg.from;
        const senderNameForAuto = contact?.profile?.name || senderForAuto;
        const lastMsgForAuto =
          msg.text?.body ||
          msg.interactive?.button_reply?.title ||
          msg.interactive?.list_reply?.title ||
          "";

        // ---- 1. FORWARD ANY PHOTO USER SENDS TO ADMIN ----
        try {
          if (msg.type === "image" && msg.image?.id && _config.ADMIN_WA && senderForAuto !== _config.ADMIN_WA) {
            await _config.waForwardImage(
              _config.ADMIN_WA,
              msg.image.id,
              `📷 Customer sent an image\nFrom: ${senderForAuto}\nName: ${senderNameForAuto || "UNKNOWN"}`
            );
            if (_config.DEBUG) console.log("Forwarded user image to admin WA:", msg.image.id);
          }
        } catch (err) {
          console.warn("Forward image to admin failed:", err?.message || err);
        }

               // ---- 2. AI VISION: TEMP – run for ANY image to test pipeline ----
        try {
          if (msg.type === "image" && msg.image?.id) {
            const caption = msg.image?.caption || "";
            const combinedText = `${lastMsgForAuto || ""} ${caption || ""}`.toLowerCase();

            if (_config.DEBUG) {
              console.log("AI VISION candidate image:", {
                caption,
                lastMsgForAuto,
                combinedText
              });
            }

            const mediaUrl = await _config.getMediaUrl(msg.image.id);
            if (mediaUrl) {
              const analysis = await _config.analyzeCarImageFaultWithOpenAI(mediaUrl, combinedText);
              await _config.waSendText(
                senderForAuto,
                `*Preliminary check based on your photo:*\n\n${analysis}`
              );
              _config.setLastService(senderForAuto, "FAULT_ANALYSIS");
            } else if (_config.DEBUG) {
              console.log("AI VISION: no mediaUrl returned for image id:", msg.image.id);
            }
          }
        } catch (err) {
          console.warn("AI vision fault analysis failed:", err?.message || err);
          // Do not return; let rest of flow continue
        }

        // ---- 3. AUTO-INGEST TO CRM (existing behaviour) ----
        await _config.autoIngest({
          bot: "MR.CAR",
          channel: "whatsapp",
          from: senderForAuto,
          name: senderNameForAuto,
          lastMessage: lastMsgForAuto,
          meta: { source: "webhook-auto" }
        });

await _config.pushLeadToGoogleSheet({
  id: senderForAuto,
  name: senderNameForAuto,
  phone: senderForAuto,
  status: 'auto-ingested',
  timestamp: new Date().toISOString(),
  car_enquired: lastMsgForAuto,
  budget: '',
  last_ai_reply: '',
  ai_quote: '',
  lead_type: 'whatsapp_query'
});

        // ---- 4. ADMIN TEXT ALERT (existing behaviour) ----
        try {
          if (_config.ADMIN_WA && senderForAuto !== _config.ADMIN_WA) {
            const body =
              `🔔 *New Lead Received*\n\n` +
              `👤 Name: ${senderNameForAuto}\n` +
              `📱 Phone: ${senderForAuto}\n` +
              `💬 Message: ${lastMsgForAuto || 'No text'}\n` +
              `⏰ Time: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`;

            await _config.waSendText(_config.ADMIN_WA, body);

            if (_config.DEBUG) {
              console.log('Admin alert sent for incoming message', { from: senderForAuto });
            }
          }
        } catch (err) {
          console.warn(
            'Admin alert send failed:',
            err && err.message ? err.message : err
          );
        }
      }
    } catch (e) {
      console.warn("AUTO-INGEST FAILED:", e?.message || e);
    }
    // ---- WhatsApp delivery status tracking ----
if (value.statuses && !value.messages) {
  for (const st of value.statuses) {
    try {
      const status      = st.status;              // 'sent', 'delivered', 'read', 'failed'
      const messageId   = st.id;
      const recipient   = st.recipient_id;
      const ts          = st.timestamp ? Number(st.timestamp) * 1000 : Date.now();
      const errorCode   = st.errors && st.errors[0] ? st.errors[0].code : null;
      const errorTitle  = st.errors && st.errors[0] ? st.errors[0].title : null;
      const errorDetail = st.errors && st.errors[0]
        ? (st.errors[0].details || st.errors[0].error_data)
        : null;

      // 1) Log to console
      console.log('WA DELIVERY STATUS EVENT:', {
        recipient,
        status,
        messageId,
        errorCode,
        errorTitle
      });

      // 2) Save into CRM
      _config.recordDeliveryStatusForPhone(recipient, {
        status,
        messageId,
        errorCode,
        errorTitle,
        errorDetail,
        ts
      });

    } catch (e) {
      console.warn('Error handling WA status event:', e?.message || e);
    }
  }

  if (_config.DEBUG) {
    console.log('Status-only event processed for delivery tracking.');
  }
  return res.sendStatus(200);  // Important: DO NOT REMOVE THIS
}

    const msg     = value?.messages?.[0];
    const contact = value?.contacts?.[0];
// ------------------------------------------------------------------
// MESSAGE DE-DUPLICATION LOCK (CRITICAL)
// ------------------------------------------------------------------
if (!global.__WA_MSG_LOCK__) global.__WA_MSG_LOCK__ = new Set();

const dedupKey =
  msg?.id ||
  `${msg?.from || 'unknown'}_${msg?.timestamp || Date.now()}`;

if (global.__WA_MSG_LOCK__.has(dedupKey)) {
  if (_config.DEBUG) console.log('Duplicate WA message ignored:', dedupKey);
  return res.sendStatus(200);
}

global.__WA_MSG_LOCK__.add(dedupKey);
    const from = msg.from;
    const type = msg.type;
    const name = (contact?.profile?.name || 'Unknown').toString().toUpperCase();

    // Extract selectedId (buttons/list) and msgText depending on incoming message type
    let msgText = '';
    let selectedId = null;

    try {
      if (type === 'text' && msg.text && typeof msg.text.body === 'string') {
        msgText = String(msg.text.body || '').trim();
      } else if (type === 'interactive' && msg.interactive) {
        const inter = msg.interactive;
        if (inter.type === 'button_reply' && inter.button_reply) {
          selectedId = inter.button_reply.id || inter.button_reply.title || null;
          msgText = inter.button_reply.title || '';
        } else if (inter.type === 'list_reply' && inter.list_reply) {
          selectedId = inter.list_reply.id || inter.list_reply.title || null;
          msgText = inter.list_reply.title || '';
        } else {
          msgText = (inter.body || inter.header || '') || '';
        }
      } else if (type === 'image' || type === 'document' || type === 'video' || type === 'audio') {
        msgText = (msg?.image?.caption || msg?.document?.caption || msg?.video?.caption || '') || '';
      } else {
        msgText = '';
      }
    } catch (e) {
      if (_config.DEBUG) console.warn('message parsing failed', e && e.message ? e.message : e);
      msgText = '';
    }
// ==================================================
// SMART AUTO-DETECT: CAR LISTING vs CUSTOMER ENQUIRY
// No manual number lists needed. Works for everyone.
// If message looks like a car listing → ingest silently
// If it's a greeting/question/enquiry → reply normally
// ==================================================
if (_config.groupIngest) {
  // Groups: always 100% silent (never reply)
  if (_config.groupIngest.isGroupOrMuted(from)) {
    await _config.groupIngest.handleGroupMessage(from, msgText, name, type, msg?.image?.id || null);
    return res.sendStatus(200);
  }

  // Everyone else: auto-detect car listings → ingest silently
  // Normal messages pass through to bot as usual
  const ingested = await _config.groupIngest.handleAutoIngest(from, msgText, name);
  if (ingested) return res.sendStatus(200);
}

// ==================================================
// SERIAL NUMBER VARIANT SELECTION (TOP PRIORITY)
// ==================================================
if (!global.lastVariantList) global.lastVariantList = new Map();
if (!global.lastUsedCarList) global.lastUsedCarList = new Map();

const numMatch = msgText && msgText.trim().match(/^(\d{1,2})$/);

if (numMatch) {

  // ================= NEW CAR SERIAL SELECTION =================
  const rec = global.lastVariantList.get(from);

  if (rec) {
    // 🔒 Expired list
    if (Date.now() - rec.ts > 5 * 60 * 1000) {
      global.lastVariantList.delete(from);
      return res.sendStatus(200);
    }

    const idx = Number(numMatch[1]) - 1;

    // 🔒 Invalid number
    if (!rec.variants[idx]) {
      return res.sendStatus(200);
    }

    const chosen = rec.variants[idx];
    global.lastVariantList.delete(from);

    let queryText = '';

    if (chosen.row && typeof chosen.idxModel === 'number') {
      const mdl = chosen.row[chosen.idxModel] || '';
      const varr =
        (typeof chosen.idxVariant === 'number' && chosen.row[chosen.idxVariant])
          ? chosen.row[chosen.idxVariant]
          : '';
      queryText = `${mdl} ${varr}`.trim();
    } else if (chosen.title) {
      queryText = String(chosen.title).trim();
    }

    if (queryText) {
      await _config.tryQuickNewCarQuote(queryText, from);
    }

    return res.sendStatus(200);
  }

  // ================= AGGREGATED SEARCH SERIAL SELECTION =================
  if (!global.lastUsedSearchResults) global.lastUsedSearchResults = new Map();
  const searchRec = global.lastUsedSearchResults.get(from);
  if (searchRec && Array.isArray(searchRec) && searchRec.length > 0) {
    const sIdx = Number(numMatch[1]) - 1;
    if (searchRec[sIdx] && _config.carSearch) {
      const car = searchRec[sIdx];
      // Calculate EMI for display
      let emiInfo = null;
      if (car.price > 0) {
        const loanAmt = Math.round(car.price * 0.85); // 85% LTV
        const rate = 9.99;
        const months = 60;
        const monthlyRate = rate / 100 / 12;
        const emi = Math.round(loanAmt * monthlyRate * Math.pow(1 + monthlyRate, months) / (Math.pow(1 + monthlyRate, months) - 1));
        emiInfo = { emi: `₹${emi.toLocaleString('en-IN')}`, tenure: months, rate };
      }
      const msg = _config.carSearch.formatSingleCar(car, emiInfo);
      await _config.waSendText(from, msg);
      global.lastUsedSearchResults.delete(from);
      await _config.sendUsedCarButtons(from);
      _config.setLastService(from, 'USED');
      return res.sendStatus(200);
    }
  }

  // ================= USED CAR SERIAL SELECTION =================
  const usedRec = global.lastUsedCarList.get(from);

  if (!usedRec) {
    return res.sendStatus(200);
  }

  // 🔒 Expired list
  if (Date.now() - usedRec.ts > 5 * 60 * 1000) {
    global.lastUsedCarList.delete(from);
    return res.sendStatus(200);
  }

  const idx = Number(numMatch[1]) - 1;

  // 🔒 Invalid number
  if (!usedRec.rows || !usedRec.rows[idx]) {
    return res.sendStatus(200);
  }

  const row = usedRec.rows[idx];
  global.lastUsedCarList.delete(from);

  const { text, picLink } = await _config.buildSingleUsedCarQuote(row, from);

  if (picLink) {
    await _config.waSendImage(from, picLink, text);
  } else {
    await _config.waSendText(from, text);
  }

  _config.setLastService(from, 'USED');
  return res.sendStatus(200);
}
// ================= GLOBAL LOAN INTENT INTERCEPTOR =================

// Check last service to avoid hijacking active loan flows
const lastSvc = _config.getLastService(from);
const inLoanFlow = ['LOAN', 'LOAN_NEW', 'LOAN_USED'].includes(lastSvc);

// Avoid intercepting numeric EMI inputs
const looksLikeEmiInput =
  /\d/.test(msgText || '') &&
  /(year|years|yr|yrs|month|months|lakh|lac|₹|rs)/i.test(msgText || '');

if (!selectedId && msgText && !inLoanFlow && !looksLikeEmiInput) {
  const normText = msgText.toLowerCase();

  const isLoanIntent = _config.LOAN_KEYWORDS.some(k => normText.includes(k));

  if (isLoanIntent) {
    console.log('GLOBAL LOAN INTENT HIT:', msgText);

    _config.setLastService(from, 'LOAN');

    await _config.waSendRaw({
      messaging_product: 'whatsapp',
      to: from,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: 'Loan & EMI options:' },
        action: {
          buttons: [
            { type: 'reply', reply: { id: 'BTN_LOAN_NEW',  title: 'New Car Loan' } },
            { type: 'reply', reply: { id: 'BTN_LOAN_USED', title: 'Used Car Loan' } },
            { type: 'reply', reply: { id: 'BTN_LOAN_CUSTOM', title: 'Manual EMI' } }
          ]
        }
      }
    });

    return res.sendStatus(200); // 🔒 stop further processing
  }
}

// ================= PRIORITY INTERACTIVE HANDLING =================
if (selectedId === 'SRV_LOAN') {
  console.log('PRIORITY HIT: SRV_LOAN');

  _config.setLastService(from, 'LOAN');

  await _config.waSendRaw({
    messaging_product: 'whatsapp',
    to: from,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: 'Choose loan option:' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'BTN_LOAN_NEW',  title: 'New Car Loan' } },
          { type: 'reply', reply: { id: 'BTN_LOAN_USED', title: 'Used Car Loan' } },
          { type: 'reply', reply: { id: 'BTN_LOAN_CUSTOM', title: 'Manual EMI' } }
        ]
      }
    }
  });

  return res.sendStatus(200); // 🔒 stop before intent engine
}
// ================= LOAN TYPE BUTTON HANDLING =================
if (selectedId === 'BTN_LOAN_NEW') {
  _config.setLastService(from, 'LOAN_NEW');

  await _config.waSendText(
    from,
    '🆕 *New Car Loan*\n\nPlease share *loan amount + tenure*.\nExample:\n`10 lakh 5 years`'
  );

  return res.sendStatus(200);
}

if (selectedId === 'BTN_LOAN_USED') {
  _config.setLastService(from, 'LOAN_USED');

  await _config.waSendText(
    from,
    '🚗 *Used Car Loan*\n\nPlease share *loan amount + tenure*.\nExample:\n`5 lakh 4 years`'
  );

  return res.sendStatus(200);
}

if (selectedId === 'BTN_LOAN_CUSTOM') {
  _config.setLastService(from, 'LOAN_MANUAL');

  await _config.waSendRaw({
    messaging_product: 'whatsapp',
    to: from,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: '📊 Choose EMI type:' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'BTN_EMI_NORMAL', title: 'Normal EMI' } },
          { type: 'reply', reply: { id: 'BTN_EMI_BULLET', title: 'Bullet EMI' } }
        ]
      }
    }
  });

  return res.sendStatus(200);
}
// ================= END LOAN TYPE HANDLING =================
// ================= MANUAL EMI MODE HANDLING =================
if (selectedId === 'BTN_EMI_NORMAL') {
  _config.setLastService(from, 'LOAN_MANUAL_NORMAL');

  await _config.waSendText(
    from,
    '📘 *Normal EMI*\n\nPlease share:\n*Loan Amount + Tenure + ROI*\n\nExample:\n`10 lakh 5 years 9%`'
  );

  return res.sendStatus(200);
}

if (selectedId === 'BTN_EMI_BULLET') {
  _config.setLastService(from, 'LOAN_MANUAL_BULLET');

  await _config.waSendText(
    from,
    '🎯 *Bullet EMI*\n\nPlease share:\n*Loan Amount + Tenure + ROI*\n\nExample:\n`10 lakh 3 years 10%`'
  );

  return res.sendStatus(200);
}
// ================= END MANUAL EMI MODE HANDLING =================

// ================= LOAN TYPE BUTTON HANDLING =================
if (selectedId === 'BTN_LOAN_NEW') {
  _config.setLastService(from, 'LOAN_NEW');

  await _config.waSendText(
    from,
    '🆕 *New Car Loan*\n\nPlease share *loan amount + tenure*.\nExample:\n`10 lakh 5 years`'
  );

  return res.sendStatus(200);
}

if (selectedId === 'BTN_LOAN_USED') {
  _config.setLastService(from, 'LOAN_USED');

  await _config.waSendText(
    from,
    '🚗 *Used Car Loan*\n\nPlease share *loan amount + tenure*.\nExample:\n`5 lakh 4 years`'
  );

  return res.sendStatus(200);
}

if (selectedId === 'BTN_LOAN_CUSTOM') {
  _config.setLastService(from, 'LOAN');

  await _config.waSendText(
    from,
    '📊 *Manual EMI*\n\nPlease share *loan amount + tenure*.\nExample:\n`7 lakh 60 months`'
  );

  return res.sendStatus(200);
}
// ================= END LOAN TYPE HANDLING =================


// ================= LOAN EMI FREE-TEXT HANDLER (SAFE) =================
const svc = (lastSvc || '').toUpperCase();

// ================= MANUAL EMI (NORMAL / BULLET) =================
if (
  (svc === 'LOAN_MANUAL_NORMAL' || svc === 'LOAN_MANUAL_BULLET') &&
  msgText &&
  /\d/.test(msgText)
) {
  let amt = null;
  let months = null;
  let roi = null;

  // ---- amount ----
  const lakhMatch = msgText.match(/(\d+(?:\.\d+)?)\s*(lakh|lac)/i);
  if (lakhMatch) {
    amt = Number(lakhMatch[1]) * 100000;
  } else {
    const numMatch = msgText.replace(/[,₹]/g, '').match(/\b\d{5,}\b/);
    if (numMatch) amt = Number(numMatch[0]);
  }

  // ---- tenure ----
  const yearMatch = msgText.match(/(\d+)\s*(year|yr)/i);
  const monthMatch = msgText.match(/(\d+)\s*(month)/i);
  if (yearMatch) months = Number(yearMatch[1]) * 12;
  else if (monthMatch) months = Number(monthMatch[1]);

  // ---- ROI (mandatory) ----
  const roiMatch = msgText.match(/(\d+(?:\.\d+)?)\s*%/);
  if (roiMatch) roi = Number(roiMatch[1]);

  if (!amt || !months || !roi) {
    await _config.waSendText(
      from,
      'Please share *Loan Amount + Tenure + ROI*.\nExample:\n`10 lakh 5 years 9%`'
    );
    _config.setLastService(from, lastSvc);
    return res.sendStatus(200);
  }

  months = Math.min(months, 84);

  // ---------- MANUAL BULLET EMI ----------
if (svc === 'LOAN_MANUAL_BULLET') {
  const bulletPct = 0.25;

  const bulletSim = _config.simulateBulletPlan({
    amount: amt,
    rate: roi,
    months,
    bulletPct
  });

  const bulletEmi =
  bulletSim?.monthly_emi ||
  bulletSim?.monthlyEmi ||
  bulletSim?.emi ||
  null;

const bulletAmt =
  bulletSim?.bullet_amount ||
  bulletSim?.bulletAmount ||
  Math.round(amt * bulletPct);


  if (!bulletEmi || !bulletAmt) {
    await _config.waSendText(
      from,
      'Unable to calculate Bullet EMI. Please try again.'
    );
    _config.setLastService(from, lastSvc);
    return res.sendStatus(200);
  }

  const perBullet = Math.round(bulletAmt / 5);
  const bulletSchedule = [12, 24, 36, 48, 60]
    .map(m => `₹ ${_config.fmtMoney(perBullet)} at month ${m}`)
    .join('\n');

  await _config.waSendText(
    from,
    `🎯 *Bullet EMI (25%)*\n\n` +
    `Loan Amount: ₹ *${_config.fmtMoney(amt)}*\n` +
    `Tenure: *${months} months*\n` +
    `ROI: *${roi}%*\n\n` +
    `Monthly EMI (approx): ₹ *${_config.fmtMoney(bulletEmi)}*\n` +
    `Bullet total (25% of loan): ₹ *${_config.fmtMoney(bulletAmt)}*\n\n` +
    `Bullets:\n${bulletSchedule}\n\n` +
    `✅ Loan approval possible in ~30 minutes (T&Cs apply)\n\n` +
    `Terms & Conditions Apply ✅`
  );

  _config.setLastService(from, lastSvc);
  return res.sendStatus(200);
}

  // ---------- MANUAL NORMAL EMI ----------
  const emi = _config.calcEmiSimple(amt, roi, months);

  await _config.waSendText(
    from,
    `📘 *Normal EMI*\n\n` +
    `Loan Amount: ₹ *${_config.fmtMoney(amt)}*\n` +
    `Tenure: *${months} months*\n` +
    `ROI: *${roi}%*\n\n` +
    `👉 EMI: ₹ *${_config.fmtMoney(emi)}*`
  );

  _config.setLastService(from, lastSvc);
  return res.sendStatus(200);
}
// ================= END MANUAL EMI =================
// ================= AUTO LOAN EMI (NEW / USED) =================
if (
  (svc === 'LOAN_NEW' || svc === 'LOAN_USED') &&
  msgText &&
  /\d/.test(msgText)
) {
  let amt = null;
  let months = null;

  // amount
  const lakhMatch = msgText.match(/(\d+(?:\.\d+)?)\s*(lakh|lac)/i);
  if (lakhMatch) amt = Number(lakhMatch[1]) * 100000;
  else {
    const numMatch = msgText.replace(/[,₹]/g, '').match(/\b\d{5,}\b/);
    if (numMatch) amt = Number(numMatch[0]);
  }

  // tenure
  const yearMatch = msgText.match(/(\d+)\s*(year|yr)/i);
  const monthMatch = msgText.match(/(\d+)\s*(month)/i);
  if (yearMatch) months = Number(yearMatch[1]) * 12;
  else if (monthMatch) months = Number(monthMatch[1]);

  if (!amt || !months) {
    await _config.waSendText(
      from,
      'Please share *loan amount + tenure*.\nExample:\n`10 lakh 5 years`'
    );
    _config.setLastService(from, lastSvc);
    return res.sendStatus(200);
  }

  const rate =
    svc === 'LOAN_USED'
      ? _config.USED_CAR_ROI_INTERNAL
      : _config.NEW_CAR_ROI;

  const emi = _config.calcEmiSimple(amt, rate, months);

  await _config.waSendText(
    from,
    `💰 *Loan EMI*\n\n` +
    `Loan Amount: ₹ *${_config.fmtMoney(amt)}*\n` +
    `Tenure: *${months} months*\n` +
    `ROI: *${rate}%*\n\n` +
    `👉 EMI: ₹ *${_config.fmtMoney(emi)}*`
  );

  _config.setLastService(from, lastSvc);
  return res.sendStatus(200);
}
// ================= END AUTO EMI =================

// ================= END LOAN EMI HANDLER =================

   // ------------------------------------------------------------------
  // STEP-2: SMART NEW CAR INTENT ENGINE (handles budget, compare, etc.)
// ------------------------------------------------------------------
try {
  const smartText = (typeof msgText === 'string' && msgText.trim())
    ? msgText.trim()
    : '';

  const smartFrom = from || null;

  if (smartText && smartFrom) {

    // 🔒 BYPASS smart intent for explicit variant queries
    const variantExplicit =
      /\b(4x4|4wd|awd|automatic|auto|at)\b/i.test(smartText);

    const hasPricingIntent =
      /\b(price|prices|pricing|on[- ]?road|quote|cost|deal|offer)\b/i.test(smartText);

    const explicitStatePricingIntent =
      /\b(price in|on[- ]?road in|cost in|rate in)\b/i.test(smartText);

    if (!variantExplicit || hasPricingIntent || explicitStatePricingIntent) {
      const handled = await _config.trySmartNewCarIntent(smartText, smartFrom);
      if (handled) {
        if (_config.DEBUG) {
          console.log("SMART NEW CAR INTENT handled.", {
            from: smartFrom,
            text: smartText
          });
        }
        return res.sendStatus(200);
      }
    } else if (_config.DEBUG) {
      console.log("SMART NEW CAR INTENT bypassed for variant-explicit query", {
        from: smartFrom,
        text: smartText
      });
    }

  } // ✅ CLOSES: if (smartText && smartFrom)

} catch (e) {
  console.warn("Smart intent engine failed:", e?.message || e);
}

    // ---- Admin alert for real incoming messages ----
    try {
      // Only if ADMIN_WA is set, we have a sender, and it's not the admin number itself
      if (_config.ADMIN_WA && from && from !== _config.ADMIN_WA) {
        // Basic filters: if you want alerts only for text/interactive, uncomment next line:
        // if (!(type === 'text' || type === 'interactive')) { /* skip */ } else {

        const lines = [
          '🚨 *New WhatsApp message*',
          `From: ${name} (${from})`,
          `Type: ${type}`,
          msgText ? `Message: ${msgText}` : null,
        ].filter(Boolean);

        const body = lines.join('\n');

        // Use the same helper that /admin/test_alert uses
        await _config.waSendText(_config.ADMIN_WA, body);

        if (_config.DEBUG) {
          console.log('Admin alert sent for incoming message', { from });
        }
        // } // <-- closing brace if you add type filter above
      }
    } catch (err) {
      console.warn(
        'Admin alert send failed:',
        err && err.message ? err.message : err
      );
    }

    // ---- RAG EMBEDDING + VECTOR SEARCH BLOCK ----
    let queryEmbedding = null;
    try {
      if (msgText) {
        const embedResp = await _config.openai.embeddings.create({
          model: "text-embedding-3-large",
          input: msgText
        });
        queryEmbedding = embedResp.data?.[0]?.embedding || null;
      }
    } catch (e) {
      console.error("Embedding error:", e);
    }

    let ragHits = [];
    try {
      if (queryEmbedding && typeof _config.findRelevantChunks === 'function') {
        const ragData = await (_config.getRAG ? _config.getRAG() : Promise.resolve(null));
        if (ragData) {
          ragHits = _config.findRelevantChunks(queryEmbedding, ragData, 5) || [];
        }
      }
    } catch (e) {
      if (_config.DEBUG) console.warn('RAG search failed', e && e.message ? e.message : e);
      ragHits = [];
    }
    // ---- END RAG BLOCK ----

         // save lead locally + CRM (non-blocking)
    try {
      // derive service + purpose once
      const lastServiceValue = _config.getLastService(from) || null;
      let purpose = "new";

      if (lastServiceValue) {
        const svc = String(lastServiceValue).toLowerCase();
        if (svc.includes("used")) purpose = "used";
        else if (svc.includes("sell")) purpose = "sell";
        else if (svc.includes("loan")) purpose = "loan";
        else purpose = "new";
      } else if (msgText) {
        const tLow = msgText.toLowerCase();
        if (/used|pre[-\s]?owned|second[-\s]?hand/.test(tLow)) {
          purpose = "used";
        } else if (/sell my car|sell car|selling my car/.test(tLow)) {
          purpose = "sell";
        } else if (/loan|finance|emi|bullet/.test(tLow)) {
          purpose = "loan";
        } else {
          purpose = "new";
        }
      }
      const lead = {
        bot: 'MR_CAR_AUTO',
        channel: 'whatsapp',
        from,
        name,
        lastMessage: msgText,
        service: lastServiceValue,
        purpose,                // ✅ send to CRM core
        tags: [],
        meta: {}
      };

      // send to central CRM (non-blocking)
      _config.postLeadToCRM(lead).catch(() => {});

      // also log a normalized copy into local file for /api/leads fallback
      let existing = _config.safeJsonRead(_config.LEADS_FILE);
      if (Array.isArray(existing)) {
        // ok
      } else if (Array.isArray(existing.leads)) {
        existing = existing.leads;
      } else {
        existing = [];
      }

      existing.unshift({
        ID: from,
        Name: name,
        Phone: from,
        Status: 'auto-ingested',
        Purpose: purpose,
        lastMessage: msgText,
        LeadType: 'whatsapp_query',
        Timestamp: new Date().toISOString()
      });

      existing = existing.slice(0, 1000);
      _config.fs.writeFileSync(_config.LEADS_FILE, JSON.stringify(existing, null, 2), 'utf8');

      if (_config.DEBUG) {
        console.log('✅ Lead saved (local + CRM):', from, purpose, (msgText || '').slice(0, 120));
      }
    } catch (e) {
      console.warn('lead save failed', e && e.message ? e.message : e);
    }

    // interactive choices
    if (selectedId) {
      // Enquiry color buttons → treat as text reply
      if (selectedId.startsWith('ENQ_CLR_')) {
        if (_config.handleEnquiryMessage) {
          const handled = await _config.handleEnquiryMessage(from, selectedId, _config.getLastService(from));
          if (handled) return res.sendStatus(200);
        }
      }

      switch (selectedId) {
        case 'SRV_BEST_DEAL':
          if (_config.startEnquiry) {
            await _config.startEnquiry(from);
          } else {
            await _config.waSendText(from, 'This service is coming soon. Please try New Car Prices.');
          }
          return res.sendStatus(200);

        case 'SRV_NEW_CAR':
        case 'BTN_NEW_QUOTE':
          _config.setLastService(from, 'NEW');
await _config.waSendText(
  from,
  '🚗 *New Car Pricing & Finance*\n\n' +
  'Get details in 4 simple ways:\n\n' +
  '1️⃣ *Model only*\n' +
  'Example: `Hycross`\n' +
  '→ View all available variants & prices\n\n' +
  '2️⃣ *Exact variant + state/city + buyer type*\n' +
  'Examples:\n' +
  '• `Hycross ZXO Delhi Individual`\n' +
  '• `Hycross ZXO Delhi Company`\n' +
  '→ On-road price (profile-wise) + EMI options\n\n' +
  '3️⃣ *Pan-India comparison*\n' +
  'Example: `Hycross ZXO Pan India`\n' +
  '→ Lowest & highest prices across states\n\n' +
  '4️⃣ *Budget-based search*\n' +
  'Examples:\n' +
  '• `SUV around 20 lakh`\n' +
  '• `Car around 15 lakh`\n' +
  '• `Budget 15 lakh`\n\n' +
  '→ Best options available in your budget\n\n' +
  'Type exactly as shown above.'
);
  return res.sendStatus(200);

     case 'SRV_USED_CAR':
case 'BTN_USED_MORE':
  _config.setLastService(from, 'USED');
  await _config.waSendText(
  from,
  '*Pre-Owned Car Search*\n\n' +
  'Just type what you\'re looking for:\n\n' +
  '*By model:*  `Creta` or `BMW X1`\n' +
  '*By budget:*  `SUV around 15 lakh`\n' +
  '*With city:*  `Fortuner Mumbai`\n' +
  '*Pan India:*  `GLC Pan India`\n\n' +
  '_Default: Delhi NCR. Add city name or "Pan India" for wider search._\n\n' +
  'Reply with the *number* from any list for full details.'
);
return res.sendStatus(200);
        case 'SRV_SELL_CAR':
          _config.setLastService(from, 'SELL');
          await _config.waSendText(
            from,
            'Please share *car make/model, year, km, city* and a few photos. We\'ll get you the best quote.'
          );
          return res.sendStatus(200);

case 'SRV_LOAN':
  console.log('HIT: SRV_LOAN');
  _config.setLastService(from, 'LOAN');
  await _config.waSendRaw({
    messaging_product: 'whatsapp',
    to: from,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: 'Choose loan option:' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'BTN_LOAN_NEW',  title: 'New Car Loan' } },
          { type: 'reply', reply: { id: 'BTN_LOAN_USED', title: 'Used Car Loan' } },
          { type: 'reply', reply: { id: 'BTN_LOAN_CUSTOM', title: 'Manual EMI' } }
        ]
      }
    }
  });
  return res.sendStatus(200); // ⬅ THIS LINE IS THE FIX

// ================= NEW CAR LOAN (AUTO ROI @ 8.1%) =================
case 'BTN_LOAN_NEW':
  _config.setLastService(from, 'LOAN_NEW');

  await _config.waSendText(
    from,
    '🚗 *New Car Loan*\n\n' +
    'Please share:\n' +
    '• *Loan amount*\n' +
    '• *Tenure* (up to 7 years)\n\n' +
    'You can type naturally, for example:\n' +
    '• `10 lakh 3 years`\n' +
    '• `₹15,00,000 60`\n' +
    '• `1500000 5`\n\n' +
    '_Interest rate is applied automatically._'
  );

  await _config.waSendRaw({
    messaging_product: 'whatsapp',
    to: from,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: 'Choose EMI type:' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'BTN_NEW_EMI_NORMAL', title: 'Normal EMI' } },
          { type: 'reply', reply: { id: 'BTN_NEW_EMI_BULLET', title: 'Bullet EMI' } },
          { type: 'reply', reply: { id: 'BTN_LOAN_DOCS', title: 'Loan Documents' } }
        ]
      }
    }
  });

  return res.sendStatus(200);


// -------- Normal EMI (New Car) --------
case 'BTN_NEW_EMI_NORMAL':
  await _config.waSendText(
    from,
    '✅ *Normal EMI — New Car*\n\n' +
    'Send *loan amount + tenure* in any format.\n\n' +
    'Examples:\n' +
    '• `10 lakh 5 years`\n' +
    '• `₹12,00,000 60`\n' +
    '• `1200000 5`\n\n' +
    '_EMI will be calculated automatically at 8.1%._'
  );
  return res.sendStatus(200);


// -------- Bullet EMI (New Car) --------
case 'BTN_NEW_EMI_BULLET':
  await _config.waSendText(
    from,
    '🟡 *Bullet EMI — New Car*\n\n' +
    'Send *loan amount + tenure* in any format.\n\n' +
    'Examples:\n' +
    '• `10 lakh 3 years`\n' +
    '• `₹10,00,000 36`\n\n' +
    'ℹ️ *Bullet EMI structure:*\n' +
    '• EMI is paid every month\n' +
    '• Every *12th EMI* has a higher principal component'
  );
  return res.sendStatus(200);


// ================= USED CAR LOAN (AUTO ROI @ 10%, SHOWN @ 9.99%) =================
case 'BTN_LOAN_USED':
  _config.setLastService(from, 'LOAN_USED');

  await _config.waSendText(
    from,
    '🚘 *Used Car Loan*\n\n' +
    'Please share:\n' +
    '• *Loan amount*\n' +
    '• *Tenure* (up to 7 years)\n\n' +
    'Examples:\n' +
    '• `6 lakh 4 years`\n' +
    '• `₹6,00,000 48`\n' +
    '• `600000 4`\n\n' +
    '_Interest rate is applied automatically._'
  );

  await _config.waSendRaw({
    messaging_product: 'whatsapp',
    to: from,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: 'Choose EMI type:' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'BTN_USED_EMI_NORMAL', title: 'Normal EMI' } },
          { type: 'reply', reply: { id: 'BTN_USED_EMI_BULLET', title: 'Bullet EMI' } },
          { type: 'reply', reply: { id: 'BTN_LOAN_DOCS', title: 'Loan Documents' } },
          { type: 'reply', reply: { id: 'BTN_LOAN_ELIGIBILITY', title: 'Eligibility' } }
        ]
      }
    }
  });

  return res.sendStatus(200);


// -------- Normal EMI (Used Car) --------
case 'BTN_USED_EMI_NORMAL':
  await _config.waSendText(
    from,
    '✅ *Normal EMI — Used Car*\n\n' +
    'Send *loan amount + tenure* in any format.\n\n' +
    'Examples:\n' +
    '• `6 lakh 4 years`\n' +
    '• `₹6,00,000 48`\n\n' +
    '_EMI will be calculated automatically (shown @ 9.99%)._'
  );
  return res.sendStatus(200);


// -------- Bullet EMI (Used Car) --------
case 'BTN_USED_EMI_BULLET':
  await _config.waSendText(
    from,
    '🟡 *Bullet EMI — Used Car*\n\n' +
    'Send *loan amount + tenure* in any format.\n\n' +
    'Examples:\n' +
    '• `6 lakh 3 years`\n' +
    '• `₹6,00,000 36`\n\n' +
    'ℹ️ *Bullet EMI structure:*\n' +
    '• EMI is paid every month\n' +
    '• Every *12th EMI* has a higher principal component'
  );
  return res.sendStatus(200);


// ================= COMMON LOAN HELP =================
case 'BTN_LOAN_DOCS':
  await _config.waSendText(
    from,
    '📄 *Loan Documents*\n\n' +
    '• PAN & Aadhaar\n' +
    '• 3–6 months bank statement\n' +
    '• Salary slips / ITRs\n' +
    '• Address proof\n\n' +
    'Share *city + profile (salaried / self-employed)* for an exact checklist.'
  );
  return res.sendStatus(200);

case 'BTN_LOAN_ELIGIBILITY':
  await _config.waSendText(
    from,
    '📊 *Loan Eligibility*\n\n' +
    'Please share:\n' +
    '• City\n' +
    '• Salaried / Self-employed\n' +
    '• Monthly income\n' +
    '• Existing EMIs (if any)\n\n' +
    'Example:\n`Delhi salaried 1.2L income 15k EMI`'
  );
  return res.sendStatus(200);


// ================= MANUAL EMI (CUSTOM RATE) =================
case 'BTN_LOAN_CUSTOM':
  _config.setLastService(from, 'LOAN_CUSTOM');

  await _config.waSendText(
    from,
    '🧮 *Manual EMI Calculator*\n\n' +
    'Please share:\n' +
    '• Loan amount\n' +
    '• Interest rate\n' +
    '• Tenure\n\n' +
    'Examples:\n' +
    '• `10 lakh at 9.5% for 5 years`\n' +
    '• `₹10,00,000 9 60`\n\n' +
    'ℹ️ *Bullet EMI option available:*\n' +
    '• EMI paid monthly\n' +
    '• Every 12th EMI includes higher principal'
  );
  return res.sendStatus(200);
 }
}
    // Enquiry flow — handle active enquiry conversation
    if (_config.handleEnquiryMessage) {
      const lastSvc = _config.getLastService(from);
      if (lastSvc && lastSvc.startsWith('ENQ_')) {
        const handled = await _config.handleEnquiryMessage(from, msgText, lastSvc);
        if (handled) return res.sendStatus(200);
      }
    }

    // Salesman reply handler (STAGING side)
    if (_config.handleSalesmanReply) {
      const handled = await _config.handleSalesmanReply(from, msgText);
      if (handled) return res.sendStatus(200);
    }

    // Greeting — show menu (with or without welcome text)
    {
      const text = (msgText || '').trim().toLowerCase();
      const looksLikeGreeting =
        /^(hi|hello|hey|namaste|enquiry|inquiry|help|start|menu)\b/.test(text) &&
        (text.split(/\s+/).filter(Boolean).length <= 4);

      if (looksLikeGreeting) {
        // Full greeting with welcome text (respects throttle window)
        if (_config.shouldGreetNow(from, msgText)) {
          await _config.waSendText(
            from,
            '*VehYra by MR. CAR* welcomes you!\nNamaste\n\nWe assist with *pre-owned cars*, *new car deals*, *loans* and *insurance*.\nTell us how we can help — or pick an option below.'
          );
        }
        // Always show menu on greeting (resets context)
        await _config.waSendListMenu(from);
        _config.setLastService(from, '');
        return res.sendStatus(200);
      }
    }

    // bullet command
    const bulletCmd = (msgText || '').trim().match(/^bullet\s+([\d,]+)\s*([\d\.]+)?\s*(\d+)?/i);
    if (bulletCmd) {
      const loanRaw = String(bulletCmd[1] || '').replace(/[,₹\s]/g, '');
      const months  = Number(bulletCmd[3] || 60);
      const loanAmt = Number(loanRaw);
      if (!loanAmt || !months) {
        await _config.waSendText(
          from,
          'Please send: `bullet <loan amount> <rate% optional> <tenure months>` e.g. `bullet 750000 10 60`'
        );
        return res.sendStatus(200);
      }
      const sim = _config.simulateBulletPlan({
  amount: loanAmt,                  // ✔ correct parameter
  rate: _config.USED_CAR_ROI_INTERNAL,      // ✔ 10% internal
  months: months,                   // ✔ tenure
  bulletPct: 0.25                   // ✔ 25%
});
      if (!sim) {
        await _config.waSendText(from, 'Bullet calculation failed.');
        return res.sendStatus(200);
      }
      const lines = [];
      lines.push('🔷 *Bullet EMI Plan — Used Car*');
      lines.push(`Loan Amount: ₹ *${_config.fmtMoney(sim.loan)}*`);
      lines.push(`ROI (shown): *${_config.USED_CAR_ROI_VISIBLE}%*`);
      lines.push(`Tenure: *${sim.months} months*`);
      lines.push('');
      lines.push(`📌 Monthly EMI (approx): ₹ *${_config.fmtMoney(sim.monthly_emi)}*`);
      lines.push(`📌 Bullet total (25%): ₹ *${_config.fmtMoney(sim.bullet_total)}*`);
      lines.push(
        `• Bullet each: ₹ *${_config.fmtMoney(sim.bullet_each)}* on months: ` +
        Array.from({ length: sim.num_bullets }, (_, i) => 12 * (i + 1)).join(' • ')
      );
      lines.push('');
      lines.push('✅ *Loan approval possible in ~30 minutes (T&Cs apply)*');
      await _config.waSendText(from, lines.join('\n'));
      try {
        _config.postLeadToCRM({ bot: 'MR_CAR_AUTO', channel: 'whatsapp', from, name, lastMessage: `BULLET_CALC ${loanAmt} ${months}`, service: 'LOAN', tags: ['BULLET_EMI'], meta: {} });
      } catch (_) {}
      return res.sendStatus(200);
    }

    // emi command
    const emiCmd = (msgText || '').trim().match(/^emi\s+([\d,]+)(?:\s+([\d\.]+)%?)?\s*(\d+)?/i);
    if (emiCmd) {
      const loanRaw = String(emiCmd[1] || '').replace(/[,₹\s]/g, '');
      const rate    = Number(emiCmd[2] || _config.NEW_CAR_ROI);
      const months  = Number(emiCmd[3] || 60);
      const loanAmt = Number(loanRaw);
      if (!loanAmt || !months) {
        await _config.waSendText(
          from,
          'Please send: `emi <loan amount> <rate% optional> <tenure months>` e.g. `emi 1500000 9.5 60`'
        );
        return res.sendStatus(200);
      }
      const monthly = _config.calcEmiSimple(loanAmt, rate, months);
      const total   = monthly * months;
      const interest = total - loanAmt;
      const lines = [
        '🔸 EMI Calculation',
        `Loan: ₹ *${_config.fmtMoney(loanAmt)}*`,
        `Rate: *${rate}%* p.a.`,
        `Tenure: *${months} months*`,
        '',
        `📌 Monthly EMI: ₹ *${_config.fmtMoney(monthly)}*`,
        `📊 Total Payable: ₹ *${_config.fmtMoney(total)}*`,
        `💰 Total Interest: ₹ *${_config.fmtMoney(interest)}*`,
        '',
        '✅ *Loan approval possible in ~30 minutes (T&Cs apply)*',
        '\n*Terms & Conditions Apply ✅*'
      ];
      await _config.waSendText(from, lines.join('\n'));
      return res.sendStatus(200);
    }

    // numeric reply after used-car list (safe behaviour)
    if (type === 'text' && msgText) {
      const trimmed = msgText.trim();
      const lastSvc = _config.getLastService(from);
      if (lastSvc === 'USED' && /^[1-9]\d*$/.test(trimmed)) {
        await _config.waSendText(
          from,
          'Please reply with the *exact car name* from the list (for example: "Audi A6 2018") so that I can share an accurate quote.'
        );
        return res.sendStatus(200);
      }
    }

    // USED CAR detection
    if (type === 'text' && msgText) {
      const textLower = msgText.toLowerCase();
      const explicitUsed = /\b(used|pre[-\s]?owned|preowned|second[-\s]?hand)\b/.test(textLower);
      // NEW: treat year mention as used (e.g., "Hycross 2024" -> used)
      const hasYear = /\b(19|20)\d{2}\b/.test(textLower);
      const lastSvc = _config.getLastService(from);

      if (explicitUsed || hasYear || lastSvc === 'USED') {
        // Try aggregated search across CarWale + CarDekho + dealer sheet
        if (_config.carSearch) {
          try {
            // Extract model and budget from message
            const parsed = _parseUsedCarQuery(msgText);
            if (parsed.model) {
              const searchCity = parsed.panIndia ? '' : (parsed.city || 'delhi');
              const searchLabel = parsed.panIndia ? 'Pan India' : (searchCity.charAt(0).toUpperCase() + searchCity.slice(1));
              await _config.waSendText(from, `Searching *${parsed.model}* ${parsed.panIndia ? 'across India' : 'in ' + searchLabel}...`);
              const { results, stats } = await _config.carSearch.search({
                model: parsed.model,
                city: searchCity,
                panIndia: parsed.panIndia,
                minBudget: parsed.minBudget || 0,
                maxBudget: parsed.maxBudget || 999,
                limit: parsed.panIndia ? 8 : 5
              });
              if (results.length > 0) {
                const msg = _config.carSearch.formatForWhatsApp(results, stats, { model: parsed.model, city: parsed.panIndia ? 'Pan India' : searchCity });
                await _config.waSendText(from, msg);
                // Store results for serial number selection
                global.lastUsedSearchResults = global.lastUsedSearchResults || new Map();
                global.lastUsedSearchResults.set(from, results);
                await _config.sendUsedCarButtons(from);
                _config.setLastService(from, 'USED_SEARCH');
                return res.sendStatus(200);
              }
            }
          } catch (e) {
            console.warn('Aggregated car search failed, falling back:', e.message);
          }
        }

        // Fallback to existing dealer sheet search
        const usedRes = await _config.buildUsedCarQuoteFreeText({ query: msgText, from });
        await _config.waSendText(from, usedRes.text || 'Used car quote failed.');
        if (usedRes.picLink) {
          await _config.waSendText(from, `Photos: ${usedRes.picLink}`);
        }
        await _config.sendUsedCarButtons(from);
        _config.setLastService(from, 'USED');
        return res.sendStatus(200);
      }
    }

    // NEW CAR quick quote (only if NOT advisory-style)
    if (type === 'text' && msgText && !_config.isAdvisory(msgText)) {
      const served = await _config.tryQuickNewCarQuote(msgText, from);
      if (served) {
        return res.sendStatus(200);
      }
    }

    // Advisory handler (Signature GPT + brochures) — AFTER pricing
    if (type === 'text' && msgText && _config.isAdvisory(msgText)) {
      try {
        // Log advisory queries locally
        try {
          const logPath = _config.path.resolve(__dirname, '..', '.crm_data', 'advisory_queries.json');
          const dir = _config.path.dirname(logPath);
          if (!_config.fs.existsSync(dir)) _config.fs.mkdirSync(dir, { recursive: true });

          const existing = _config.fs.existsSync(logPath)
            ? JSON.parse(_config.fs.readFileSync(logPath, 'utf8') || '[]')
            : [];

          existing.unshift({
            ts: Date.now(),
            from,
            name,
            text: msgText.slice(0, 1000)
          });

          _config.fs.writeFileSync(logPath, JSON.stringify(existing.slice(0, 5000), null, 2), 'utf8');
          if (_config.DEBUG) console.log(`🧠 ADVISORY LOGGED: ${from} -> ${msgText.slice(0,60)}`);
        } catch (e) {
          if (_config.DEBUG) console.warn('advisory log failed', e && e.message ? e.message : e);
        }

        // quick helplines from brochure index
        try {
          const index = _config.loadBrochureIndex();
          const relevant = _config.findRelevantBrochures(index, msgText);
          const phones = _config.findPhonesInBrochures(relevant);
          if (phones && phones.length) {
            const lines = phones.map(p => `${p.label}: ${p.phone}`).slice(0,5);
            await _config.waSendText(from, `📞 Quick helplines:\n${lines.join('\n')}\n\n(Full advisory below.)`);
          }
        } catch (e) {
          if (_config.DEBUG) console.warn('advisory quick-phones failed', e && e.message ? e.message : e);
        }

        // Call Signature GPT
        const sigReply = await _config.callSignatureBrain({ from, name, msgText, lastService: _config.getLastService(from), ragHits });
        if (sigReply) {
          await _config.waSendText(from, sigReply);
          try {
            await _config.postLeadToCRM({
              bot: 'SIGNATURE_ADVISORY',
              channel: 'whatsapp',
              from,
              name,
              lastMessage: msgText,
              service: 'ADVISORY',
              tags: ['SIGNATURE_ADVISORY'],
              meta: { engine: _config.SIGNATURE_MODEL, snippet: sigReply.slice(0,300) },
              createdAt: Date.now()
            });
          } catch (e) {
            if (_config.DEBUG) console.warn('postLeadToCRM advisory log failed', e && e.message ? e.message : e);
          }
          return res.sendStatus(200);
        }
      } catch (e) {
        if (_config.DEBUG) console.warn('Advisory handler error', e && e.message ? e.message : e);
      }
    }

    // CRM fallback
    try {
      const crmReply = await _config.fetchCRMReply({ from, msgText });
      if (crmReply) {
        await _config.waSendText(from, crmReply);
        return res.sendStatus(200);
      }
    } catch (e) {
      console.warn('CRM reply failed', e && e.message ? e.message : e);
    }

   // NOTE: Deprecated duplicate fallback — handled earlier in flow
// This block is intentionally disabled to avoid duplicate replies
// await waSendText(
//   from,
//   '🚗 *New Car Pricing & Finance*'
// );
// return res.sendStatus(200);

  } catch (err) {
    console.error('Webhook error:', err && err.stack ? err.stack : err);
    try {
      if (process.env.ADMIN_WA) {
        await _config.waSendText(
          process.env.ADMIN_WA,
          `Webhook crash: ${String(err && err.message ? err.message : err)}`
        );
      }
    } catch (_) {}
    return res.sendStatus(200);
  }
});

module.exports = { init, router };
