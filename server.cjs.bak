console.log("🚀 MR.CAR Webhook Server Booted (Verbose Logging ON)");

/* Canonical SIGNATURE_MODEL wired from env */
const SIGNATURE_MODEL = process.env.OPENAI_MODEL || process.env.SIGNATURE_BRAIN_MODEL || process.env.SIGNATURE_MODEL || process.env.ENGINE_USED || 'gpt-4o-mini';
console.log('MODEL SELECTED (SIGNATURE_MODEL)=', SIGNATURE_MODEL);
/* Auto-insert: use OPENAI_MODEL or ENGINE_USED from env */
console.log("MODEL SELECTED (SIGNATURE_MODEL)=", SIGNATURE_MODEL);
console.log('MODEL SELECTED (SIGNATURE_MODEL)=', SIGNATURE_MODEL);
require('dotenv').config({ debug: false });
// --- Template names from env (text + media) ---
const GREETING_TEMPLATE_NAME =
  process.env.GREETING_TEMPLATE_NAME || 'mr_car_broadcast_en';

const GREETING_MEDIA_TEMPLATE_NAME =
  process.env.GREETING_MEDIA_TEMPLATE_NAME || 'mr_car_broadcast_en';

const BROADCAST_TEMPLATE_NAME =
  process.env.BROADCAST_TEMPLATE_NAME || GREETING_TEMPLATE_NAME;

console.log('GREETING_TEMPLATE_NAME =', GREETING_TEMPLATE_NAME);
console.log('GREETING_MEDIA_TEMPLATE_NAME =', GREETING_MEDIA_TEMPLATE_NAME);
console.log('BROADCAST_TEMPLATE_NAME =', BROADCAST_TEMPLATE_NAME);
// --- WhatsApp template language (force English = 'en') ---
const WA_TEMPLATE_LANG = process.env.WA_TEMPLATE_LANG || 'en';
console.log('WA_TEMPLATE_LANG =', WA_TEMPLATE_LANG);

// --- startup compatibility shim: ensure greeting & CRM helpers exist ---
// Insert this *once* near top of server.cjs (after dotenv config)
try {
  // shouldGreetNow: keep the canonical behaviour if missing
  if (typeof shouldGreetNow === 'undefined') {
    global.shouldGreetNow = function(from, msgText) {
      try {
        if (!from && !msgText) return false;
        const t = String(msgText || '').trim().toLowerCase();
        if (!t) return false;
        const looksLikeGreeting =
          /^(hi|hello|hey|namaste|enquiry|inquiry|help|start)\b/.test(t) &&
          (t.split(/\s+/).filter(Boolean).length <= 4);
        return looksLikeGreeting;
      } catch (e) {
        return false;
      }
    };
    // also create a local var in case code references it directly (non-global)
    try { var shouldGreetNow = global.shouldGreetNow; } catch(e){}
  }

  // CRM helpers: try to require and bind real functions, otherwise fallbacks
  let crm = null;
  try { crm = require('./crm_helpers.cjs'); } catch(e) {
    try { crm = require('./routes/crm_helpers.cjs'); } catch(e2) { crm = null; }
  }

  if (crm) {
    // prefer real exports where present
    if (typeof crm.postLeadToCRM === 'function') global.postLeadToCRM = crm.postLeadToCRM;
    if (typeof crm.fetchCRMReply === 'function') global.fetchCRMReply = crm.fetchCRMReply;
    if (typeof crm.getAllLeads === 'function') global.getAllLeads = crm.getAllLeads;
  }

  // create safe no-op fallbacks if still missing
  if (typeof postLeadToCRM === 'undefined') {
    global.postLeadToCRM = async function() { return false; };
    try { var postLeadToCRM = global.postLeadToCRM; } catch(e) {}
  }
  if (typeof fetchCRMReply === 'undefined') {
    global.fetchCRMReply = async function() { return null; };
    try { var fetchCRMReply = global.fetchCRMReply; } catch(e) {}
  }
  if (typeof getAllLeads === 'undefined') {
    global.getAllLeads = async function() { return []; };
    try { var getAllLeads = global.getAllLeads; } catch(e) {}
  }
} catch(e) {
  // if anything goes wrong here, keep running with the no-op fallbacks
  if (typeof postLeadToCRM === 'undefined') global.postLeadToCRM = async () => false;
  if (typeof fetchCRMReply === 'undefined') global.fetchCRMReply = async () => null;
  if (typeof getAllLeads === 'undefined') global.getAllLeads = async () => [];
  if (typeof shouldGreetNow === 'undefined') global.shouldGreetNow = () => false;
}

/* Small helper: log the RAG message only once (prevents duplicate printed lines) */
function logOnceRag(msg) {
  try {
    if (global.__MR_CAR_RAG_LOGGED__) return;
    global.__MR_CAR_RAG_LOGGED__ = true;
  } catch(e) {
    global.__MR_CAR_RAG_LOGGED__ = true;
  }
  console.log(msg);
}
require('dotenv').config({ debug: false });

/* ===== SUFFIX MATCH PATCH (ZXO / VXO / GXO with loose matching) ===== */

// canonical list – longest-first will be applied below
const SPECIAL_SUFFIXES_RAW = ['zxo','vxo','gxo','zx','vx','gx'];

function _makeLoosePat(s) {
  const clean = String(s||"").toLowerCase().replace(/[^a-z0-9]/g,"");
  const parts = clean.split("").map(ch => ch.replace(/[-\/\\^$*+?.()|[\]{}]/g,"\\$&") + "[\\s\\-\\.]*");
  return new RegExp("\\b" + parts.join("") + "\\b");
}

// override userSuffix detection
function detectUserSuffix(userNorm) {
  const specialSuffixes = SPECIAL_SUFFIXES_RAW.slice().sort((a,b)=>b.length - a.length);
  for (const sfx of specialSuffixes) {
    try {
      const pat = _makeLoosePat(sfx);
      if (pat.test(userNorm)) return sfx;
    } catch(e) {
      if (userNorm.includes(sfx)) return sfx;
    }
  }
  return null;
}

// override row suffix detection
function rowHasSuffix(variantNorm, suffixNorm, varKwNorm) {
  const specialSuffixes = SPECIAL_SUFFIXES_RAW.slice().sort((a,b)=>b.length - a.length);
  try {
    for (const sfx of specialSuffixes) {
      const pat = _makeLoosePat(sfx);
      if (pat.test(variantNorm||"") || pat.test(suffixNorm||"") || pat.test(varKwNorm||"")) {
        return true;
      }
    }
  } catch(e) {
    for (const sfx of specialSuffixes) {
      if ((variantNorm||"").includes(sfx) || (suffixNorm||"").includes(sfx) || (varKwNorm||"").includes(sfx))
        return true;
    }
  }
  return false;
}

/* ===== END SUFFIX MATCH PATCH ===== */
// ============================================================================
// GLOBAL CAR BRAND & MODEL DICTIONARY + HELPERS
// ============================================================================

// Brand hints: any of these tokens in user text strongly suggest that brand
const BRAND_HINTS = {
  MERCEDES: [
    'mercedes','merc','benz',
    'gla','gle','gls',
    'e200','e 200','e220','e 220','e250','e 250','e300','e 300','e350','e 350',
    'e class','e-class','eclass',
    'c class','c-class','cclass','c200','c 200','c220',
    's class','s-class','sclass','s350','s 350','s450','s 450','maybach','eqs'
  ],
  BMW: [
    'bmw','b m w','beemer','bemer',
    'x1','x 1','x3','x 3','x5','x 5','x7','x 7',
    '3 series','3-series','3series','320d','320 d','330i','330 i',
    '5 series','5-series','5series','520d','520 d','530i','530 i',
    '7 series','7-series','7series','730ld','730 ld'
  ],
  AUDI: [
    'audi','odi','awdi',
    'a3','a 3','a4','a 4','a6','a 6','a8','a 8',
    'q3','q 3','q5','q 5','q7','q 7'
  ],
  VOLVO: [
    'volvo','wolvo','vulvo',
    'xc40','xc 40','xc60','xc 60','xc90','xc 90','c40','c 40','recharge'
  ],
  TOYOTA: [
    'toyota','toyata',
    'innova','crysta','hycross','hykros','hy ryder','hyryder',
    'fortuner','fortu','legender','glanza','camry','rumion'
  ],
  HYUNDAI: [
    'hyundai','hundai',
    'creta','venue','exter','alcazar','tucson','verna','i20','i 20','grand i10','i10'
  ],
  KIA: [
    'kia','seltos','sonet','carens','ev6'
  ],
  MAHINDRA: [
    'mahindra','mahindara','m&m',
    'xuv700','xuv 700','700','xuv300','xuv 300','scorpio','scorpio n','thar','bolero'
  ],
  MARUTI: [
    'maruti','suzuki','maruti suzuki',
    'swift','baleno','brezza','fronx','ciaz','dzire','ertiga'
  ],
  HONDA: [
    'honda','city','amaz','amaze','elevate','wrv'
  ]
};

// Model aliases: map a "canonical model name" → list of ways people type it.
// Keep this focused on ambiguous / popular models only.
const MODEL_ALIASES = {
  'mercedes gla': ['gla','gla 200','gla 220d'],
  'mercedes gls': ['gls','gls 450','gls 600','gls maybach'],
  'mercedes e class': ['e class','e-class','eclass','e200','e 200','e220d','e 220d','e350'],
  'mercedes c class': ['c class','c-class','cclass','c200','c 200','c220'],
  'mercedes s class': ['s class','s-class','sclass','s350','s 350','s450','s 450'],
  'bmw 3 series': ['3 series','3-series','3series','320d','320 d','330i','330 i'],
  'bmw 5 series': ['5 series','5-series','5series','520d','520 d','530i','530 i'],
  'bmw 7 series': ['7 series','7-series','7series','730ld','730 ld'],
  'bmw x1': ['x1','x 1'],
  'bmw x3': ['x3','x 3'],
  'bmw x5': ['x5','x 5'],
  'bmw x7': ['x7','x 7'],
  'audi q3': ['q3','q 3'],
  'audi q5': ['q5','q 5'],
  'audi q7': ['q7','q 7'],
  'volvo xc40': ['xc40','xc 40'],
  'volvo xc60': ['xc60','xc 60'],
  'volvo xc90': ['xc90','xc 90'],
  'toyota innova hycross': ['hycross','innova hycross','hycros','hykros'],
  'toyota innova crysta': ['crysta','innova crysta'],
  'toyota fortuner': ['fortuner','fortu','legender'],
  'toyota hyryder': ['hyryder','hy ryder'],
  'hyundai creta': ['creta'],
  'hyundai venue': ['venue'],
  'kia seltos': ['seltos'],
  'kia sonet': ['sonet'],
  'mahindra xuv700': ['xuv700','xuv 700','700'],
  'mahindra scorpio n': ['scorpio n','scorpion','scropio n'],
  'mahindra thar': ['thar','thaar']
};

// -------- Helper: detect brand from free text --------
function detectBrandFromText(text) {
  const t = String(text || '').toLowerCase();
  // 1) direct brand words
  if (/\bbmw\b/.test(t)) return 'BMW';
  if (/\baudi\b/.test(t)) return 'AUDI';
  if (/\b(mercedes|merc|benz)\b/.test(t)) return 'MERCEDES';
  if (/\b(volvo|wolvo|vulvo)\b/.test(t)) return 'VOLVO';
  if (/\b(toyota|toyata)\b/.test(t)) return 'TOYOTA';
  if (/\b(hyundai|hundai)\b/.test(t)) return 'HYUNDAI';
  if (/\bkia\b/.test(t)) return 'KIA';
  if (/\bmahindra\b/.test(t)) return 'MAHINDRA';
  if (/\bmaruti\b|\bsuzuki\b/.test(t)) return 'MARUTI';
  if (/\bhonda\b/.test(t)) return 'HONDA';

  // 2) brand hints (model short codes etc.)
  outer: for (const [brand, hints] of Object.entries(BRAND_HINTS)) {
    for (const h of hints) {
      const pat = new RegExp(`\\b${h.replace(/\s+/g, '\\s*')}\\b`, 'i');
      if (pat.test(t)) {
        return brand; // e.g. "MERCEDES"
      }
    }
  }

  return null;
}

// -------- Helper: detect possible models in free text (for comparison, logging, etc.) --------
function detectModelsFromText(text) {
  const t = String(text || '').toLowerCase();
  const found = [];

  for (const [canonical, aliases] of Object.entries(MODEL_ALIASES)) {
    const canPat = new RegExp(`\\b${canonical.replace(/\s+/g, '\\s*')}\\b`, 'i');
    if (canPat.test(t)) {
      found.push(canonical);
      continue;
    }
    for (const a of aliases) {
      const pat = new RegExp(`\\b${a.replace(/\s+/g, '\\s*')}\\b`, 'i');
      if (pat.test(t)) {
        found.push(canonical);
        break;
      }
    }
  }

  // remove duplicates
  return Array.from(new Set(found));
}

// server.cjs — MR.CAR webhook (New + Used, multi-bot CRM core)
// - Greeting => service list (no quick buttons).
// - New-car quote => New-car buttons only.
// - Used-car quote => Used-car buttons only.
// - Used loan = 95% LTV of Expected Price, EMI, Bullet option.
// - Loan menu: EMI Calculator, Loan Documents, Loan Eligibility.
// - Central CRM core: /crm/leads (GET), /crm/ingest (POST) for all bots.

require('dotenv').config();

const OpenAI = require("openai");
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || process.env.OPENAI_KEY
});
// === AI Vision: Analyze car image for faults + repaint + upgrades + PPF advice ===
async function analyzeCarImageFaultWithOpenAI(imageUrl, userText = "") {
  const model = process.env.OPENAI_VISION_MODEL || process.env.ENGINE_USED || "gpt-4o-mini";

  const systemPrompt = `
You are *MR.CAR* – a professional car evaluator, bodyshop and detailing advisor.
You ONLY see 1–2 photos plus a short text from the customer.

Your goals:
1) Identify visible issues or risks (mechanical, body, tires, lights, glass, rust, leaks, etc.).
2) Comment on *paint condition* and *possible repainting*:
   - Look for colour mismatch between panels.
   - Uneven orange-peel texture or waviness on one panel vs others.
   - Masking/paint lines near rubber, chrome, badges, door handles.
   - Overspray on rubbers or trims.
   - Unusual panel gaps or alignment.
   - Scratches/buff marks indicating heavy polishing.
   You are NOT a lab – clearly state this is a visual opinion, not 100% proof.
3) Give *PPF / coating / detailing* advice:
   - When is PPF advisable? (highway usage, new car, expensive colour, lots of chips risk)
   - Suggest whether full body PPF, frontal kit (bumper+bonnet+mirrors), or only high-contact areas.
   - Mention cheaper alternatives like ceramic/graphene coating, wax, or only repaint+polish if needed.
4) Give *upgrade suggestions*:
   - If interior visible: suggest seat cover type (fabric, PU, leather), colour combos (eg. black–tan, black–red) and possible carbon-fibre or piano-black trim areas (steering, central console, door switch panels).
   - If exterior mainly visible: suggest alloys, dechroming, black roof, mild spoilers, projector/LED headlamp upgrades – BUT keep it classy, not boy-racer.
5) If the user text mentions "problem", "noise", "check engine", "warning light", etc., treat that as a service concern and first address that.

Output format (very important):
1) *Quick Summary* – 2–3 lines.
2) *Visible Issues / Faults* – bullet points (or "None clearly visible").
3) *Repaint / Bodywork Opinion* – explain if any panel looks possibly repainted and WHY, with low/medium/high confidence.
4) *PPF / Protection Advice* – what you recommend (eg. "frontal kit PPF", "only touch-ups and polish", etc.).
5) *Interior / Exterior Upgrade Ideas* – concise, 3–5 bullets max.
6) *Disclaimer* – remind that this is based only on photos and is not a physical inspection.
`.trim();

  const userPrompt = `
User context/message (may be empty):
"${userText || "N/A"}"

Now analyse the attached car photo(s) and respond in the requested format.
`.trim();

  const completion = await openai.chat.completions.create({
    model,
    messages: [
      {
        role: "system",
        content: systemPrompt
      },
      {
        role: "user",
        content: [
          { type: "text", text: userPrompt },
          {
            type: "image_url",
            image_url: { url: imageUrl }
          }
        ]
      }
    ]
  });

  const text =
    (completion.choices &&
      completion.choices[0] &&
      completion.choices[0].message &&
      completion.choices[0].message.content) ||
    "Sorry, I could not clearly understand this photo. Please send a clearer image.";

  return text.trim();
}

const { findRelevantChunks } = require("./vector_search.cjs");
const { getRAG } = require("./rag_loader.cjs");

const fs = require('fs');
const path = require('path');
const express = require('express');
const app = express();
const FormData = require('form-data');
const crmIngestHandler = require('./routes/crm_ingest.cjs');
const autoIngest = require('./routes/auto_ingest.cjs');


// ---- Delivery status tracking (CRM + console) ----
const CRM_LEADS_PATH = path.join(__dirname, 'crm_leads.json');

function loadCrmLeadsSafe() {
  try {
    const raw = fs.readFileSync(CRM_LEADS_PATH, 'utf8');
    const data = JSON.parse(raw);
    // can be array or { leads: [...] }
    if (Array.isArray(data)) return data;
    if (Array.isArray(data.leads)) return data.leads;
    return [];
  } catch (e) {
    if (DEBUG) console.warn('loadCrmLeadsSafe failed, returning []:', e && e.message ? e.message : e);
    return [];
  }
}

function saveCrmLeadsSafe(leads) {
  try {
    const payload = Array.isArray(leads) ? leads : [];
    fs.writeFileSync(CRM_LEADS_PATH, JSON.stringify(payload, null, 2), 'utf8');
  } catch (e) {
    console.error('saveCrmLeadsSafe failed:', e && e.message ? e.message : e);
  }
}

/**
 * Record a WhatsApp delivery status against a lead (by phone).
 * Stores:
 *  - lastDeliveryStatus: 'sent' | 'delivered' | 'read' | 'failed'
 *  - lastDeliveryCode: error code if any (e.g. 131021)
 *  - lastDeliveryReason: short text (e.g. 'not a WhatsApp user')
 *  - lastDeliveryAt: ISO timestamp
 *  - lastDeliveryMessageId: WA message id
 */
function recordDeliveryStatusForPhone(phone, statusPayload) {
  if (!phone) return;

  const leads = loadCrmLeadsSafe();
  const phoneNorm = String(phone).replace(/\s+/g, '');

  let hit = null;
  for (const lead of leads) {
    const lp = String(lead.Phone || lead.phone || '').replace(/\s+/g, '');
    if (!lp) continue;
    if (lp === phoneNorm) {
      hit = lead;
      break;
    }
  }

  // if no existing lead, optionally create one so we still track
  if (!hit) {
    hit = {
      ID: phoneNorm,
      Name: 'UNKNOWN',
      Phone: phoneNorm,
      Status: 'auto-ingested',
      Timestamp: new Date().toISOString(),
      LeadType: 'wa_delivery_only'
    };
    leads.push(hit);
  }

  hit.lastDeliveryStatus    = statusPayload.status || '';
  hit.lastDeliveryCode      = statusPayload.errorCode || null;
  hit.lastDeliveryReason    = statusPayload.errorTitle || statusPayload.errorDetail || null;
  hit.lastDeliveryAt        = new Date(statusPayload.ts || Date.now()).toISOString();
  hit.lastDeliveryMessageId = statusPayload.messageId || '';

  saveCrmLeadsSafe(leads);

  if (DEBUG) {
    console.log('DELIVERY_STATUS_TRACKED', {
      phone: phoneNorm,
      status: hit.lastDeliveryStatus,
      code: hit.lastDeliveryCode,
      reason: hit.lastDeliveryReason
    });
  }
}


// ensure canonical CRM mount
app.use("/crm", require("./routes/crm.cjs"));

app.use(express.json());

// === CRM ingest route: used by auto_ingest & webhook to store leads ===
app.post('/crm/ingest', async (req, res) => {
  try {
    await crmIngestHandler(req, res);
  } catch (err) {
    console.error('CRM /crm/ingest error:', err && err.message ? err.message : err);
    if (!res.headersSent) {
      res
        .status(500)
        .json({ ok: false, error: err.message || String(err) });
    }
  }
});

app.use(express.static(path.join(__dirname, "public")));

const leadsRouter = require('./routes/leads.cjs');
app.use('/api/leads', leadsRouter);

// GET /api/uploads/list — list files in public/uploads
app.get('/api/uploads/list', (req, res) => {
try {
const dir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(dir)) return res.json({ ok: true, files: [] });
const names = fs.readdirSync(dir).filter(f => fs.statSync(path.join(dir,
f)).isFile());
const files = names.map(n => ({ name: n, url: `/uploads/${n}` }));
return res.json({ ok: true, files });
} catch (e) {
console.error('/api/uploads/list error', e && e.message ? e.message : e);
return res.status(500).json({ ok: false, error: String(e) });
}
});

// === Google Sheets Sync Routes (optional if credentials/googleapis available) ===
try {
  const sheetsRouter = require('./routes/sheets.cjs');
  app.use('/api/sheets', sheetsRouter);
} catch (e) {
  console.warn(
    'Sheets routes disabled (missing googleapis or .credentials/service-account.json):',
    e && e.message ? e.message : e
  );
}

// === Dashboard Routes (SPA) ===
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard', 'index.html'));
});

// --- Serve SPA index for /dashboard and any subpath (regex handler) ---
// --- Fixed SPA handler for /dashboard and subpaths inserted here ---

app.get(/^\/dashboard(?:\/.*)?$/, (req, res) => {
  try {
    res.sendFile(path.join(__dirname, 'public', 'dashboard', 'index.html'));
  } catch (e) {
    console.error('sendFile error', e && e.message ? e.message : e);
    return res.status(500).send('internal');
  }
});

// routes/auto_ingest.cjs
// Auto-ingest helper for MR.CAR → posts leads to CRM /crm/ingest

const fetch = (global.fetch) ? global.fetch : require('node-fetch');

module.exports = async function autoIngest(enriched = {}) {
  // Prefer CRM_URL from env (Render: ngrok URL; Local: optional override)
  // Fallback: local server at 127.0.0.1:PORT (default 10000)
  const portEnv = process.env.PORT || 10000;
  const baseEnv = (process.env.CRM_URL || '').trim();
  const baseUrl = (baseEnv || `http://127.0.0.1:${portEnv}`).replace(/\/+$/, '');

  const url = `${baseUrl}/crm/ingest`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(enriched)
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.warn(
        'AUTO-INGEST: /crm/ingest non-OK',
        res.status,
        res.statusText,
        text
      );
    } else {
      console.log('AUTO-INGEST: posted to', url, 'for', enriched.from || 'UNKNOWN');
    }
  } catch (e) {
    console.warn(
      'AUTO-INGEST: posting to',
      url,
      'failed',
      e && e.message ? e.message : e
    );
  }
};

// ---------------- ENV ----------------
const META_TOKEN      = (process.env.META_TOKEN || process.env.WA_TOKEN || '').trim();
const PHONE_NUMBER_ID = (process.env.PHONE_NUMBER_ID || '').trim();
const ADMIN_WA        = (process.env.ADMIN_WA || '').replace(/\D/g, '') || null;
const VERIFY_TOKEN    = (process.env.VERIFY_TOKEN || process.env.META_VERIFY_TOKEN || '').trim();

const CONTACT_SHEET_CSV_URL = (process.env.CONTACT_SHEET_CSV_URL || '').trim();
const CONTACT_POSTER_URL    = (process.env.CONTACT_POSTER_URL || '').trim();
const SHEET_TOYOTA_CSV_URL    = (process.env.SHEET_TOYOTA_CSV_URL || '').trim();
const SHEET_HYUNDAI_CSV_URL   = (process.env.SHEET_HYUNDAI_CSV_URL || '').trim();
const SHEET_MERCEDES_CSV_URL  = (process.env.SHEET_MERCEDES_CSV_URL || '').trim();
const SHEET_BMW_CSV_URL       = (process.env.SHEET_BMW_CSV_URL || '').trim();
const SHEET_HOT_DEALS_CSV_URL = (process.env.SHEET_HOT_DEALS_CSV_URL || '').trim();
const SHEET_USED_CSV_URL      = (process.env.SHEET_USED_CSV_URL || process.env.USED_CAR_CSV_URL || '').trim();

const LOCAL_USED_CSV_PATH = path.resolve(__dirname, 'PRE OWNED CAR PRICING - USED CAR.csv');

const PORT = process.env.PORT || 10000;

// ---------------- Configs ----------------
const MAX_QUOTE_PER_DAY       = Number(process.env.MAX_QUOTE_PER_DAY || 10);
const QUOTE_LIMIT_FILE        = path.resolve(__dirname, 'quote_limit.json');
const LEADS_FILE              = path.resolve(__dirname, 'crm_leads.json');

const NEW_CAR_ROI             = Number(process.env.NEW_CAR_ROI || 8.10);
const USED_CAR_ROI_VISIBLE    = Number(process.env.USED_CAR_ROI_VISIBLE || 9.99);
const USED_CAR_ROI_INTERNAL   = Number(process.env.USED_CAR_ROI_INTERNAL || 10.0);

// keep DEBUG false by default unless env enables it explicitly
const DEBUG = (process.env.DEBUG_VARIANT === 'true') || false;

// ---------------- file helpers ----------------
function safeJsonRead(filename) {
  try {
    if (!fs.existsSync(filename)) return {};
    const txt = fs.readFileSync(filename, 'utf8') || '';
    return txt ? JSON.parse(txt) : {};
  } catch (e) {
    if (DEBUG) console.warn('safeJsonRead failed', e && e.message ? e.message : e);
    return {};
  }
}

function safeJsonWrite(filename, obj) {
  try {
    fs.writeFileSync(filename, JSON.stringify(obj, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error('safeJsonWrite failed', e && e.message ? e.message : e);
    return false;
  }
}

// ---------------- in-memory maps ----------------
if (typeof global.lastGreeting === 'undefined') global.lastGreeting = new Map();
const lastGreeting = global.lastGreeting;

if (typeof global.lastAlert === 'undefined') global.lastAlert = new Map();
const lastAlert = global.lastAlert;

// per-user service context (NEW / USED / SELL / LOAN)
if (typeof global.sessionService === 'undefined') global.sessionService = new Map();
const sessionService = global.sessionService;

function setLastService(from, svc) {
  try {
    if (!from) return;
    sessionService.set(from, { svc, ts: Date.now() });
  } catch (e) {
    if (DEBUG) console.warn('setLastService failed', e && e.message ? e.message : e);
  }
}

function getLastService(from) {
  try {
    if (!from) return null;
    const rec = sessionService.get(from);
    if (!rec) return null;
    const MAX_AGE_MS = 60 * 60 * 1000;
    if (Date.now() - rec.ts > MAX_AGE_MS) return null;
    return rec.svc || null;
  } catch (e) {
    if (DEBUG) console.warn('getLastService failed', e && e.message ? e.message : e);
    return null;
  }
}

// ---------------- Quote limits ----------------
function loadQuoteLimits() {
  return safeJsonRead(QUOTE_LIMIT_FILE) || {};
}

function saveQuoteLimits(obj) {
  return safeJsonWrite(QUOTE_LIMIT_FILE, obj);
}

function canSendQuote(from) {
  try {
    const q = loadQuoteLimits();
    const today = new Date().toISOString().slice(0, 10);
    const rec = q[from] || { date: today, count: 0 };
    if (rec.date !== today) {
      rec.date = today;
      rec.count = 0;
    }
    return rec.count < MAX_QUOTE_PER_DAY;
  } catch (e) {
    return true;
  }
}

function incrementQuoteUsage(from) {
  try {
    const q = loadQuoteLimits();
    const today = new Date().toISOString().slice(0, 10);
    const rec = q[from] || { date: today, count: 0 };
    if (rec.date !== today) {
      rec.date = today;
      rec.count = 0;
    }
    rec.count = Number(rec.count || 0) + 1;
    q[from] = rec;
    saveQuoteLimits(q);
    if (DEBUG) console.log('Quote usage', from, rec);
  } catch (e) {
    console.warn('incrementQuoteUsage failed', e && e.message ? e.message : e);
  }
}
// ---------------- WA helpers ----------------

async function waSendImageLink(to, imageUrl, caption = "") {
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "image",
    image: {
      link: imageUrl,          // use URL, not media ID
      caption: caption || ""
    }
  };

  const r = await waSendRaw(payload);

  if (r && r.messages) return { ok: true, resp: r };
  return { ok: false, error: r?.error || r };
}

// Low-level sender
async function waSendRaw(payload) {
  if (!META_TOKEN || !PHONE_NUMBER_ID) {
    console.warn("WA skipped - META_TOKEN or PHONE_NUMBER_ID missing");
    return null;
  }

  const url = `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`;

  try {
    if (DEBUG) console.log("WA OUTGOING PAYLOAD:", JSON.stringify(payload).slice(0, 400));

    const r = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${META_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const j = await r.json().catch(() => ({}));

    if (!r.ok) {
      console.error("WA send error", r.status, j);
    } else if (DEBUG) {
      console.log("WA send OK:", r.status, JSON.stringify(j).slice(0, 400));
    }

    return j;
  } catch (err) {
    console.error("waSendRaw exception:", err);
    return null;
  }
}

// Simple text
async function waSendText(to, body) {
  return waSendRaw({
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body }
  });
}

// Template (single, clean version)
async function waSendTemplate(to, templateName, components = []) {
  const payload = {
    messaging_product: "whatsapp",
    to: String(to).replace(/\D+/g, ""),
    type: "template",
    template: {
      name: templateName,
      language: { code: "en_US" },
      components: Array.isArray(components) ? components : []
    }
  };

  const r = await waSendRaw(payload);

  if (r && r.messages && r.messages.length > 0) {
    return { ok: true, resp: r };
  }

  return { ok: false, error: r?.error || r };
}

// Image (poster) – **USES LINK, NOT ID**
async function waSendImage(to, imageUrl, caption = "") {
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "image",
    image: {
      link: imageUrl,          // <<<<<< IMPORTANT
      caption: caption || ""
    }
  };

  const r = await waSendRaw(payload);

  if (r && r.messages) return { ok: true };
  return { ok: false, error: r?.error || r };
}
// === ONE SINGLE GREETING (image header + personalised text body) ===
async function sendSheetWelcomeTemplate(phone, name = "Customer") {
  if (!META_TOKEN || !PHONE_NUMBER_ID) {
    throw new Error("META_TOKEN or PHONE_NUMBER_ID not set");
  }

  const displayName = name || "Customer";

  // Use env URL if set, otherwise fall back to known poster URL
  const headerImageLink =
    (CONTACT_POSTER_URL && CONTACT_POSTER_URL.trim()) ||
    "https://whatsapp-gpt-crm.onrender.com/uploads/mrcar_poster.png";

  const components = [
    {
      // HEADER: IMAGE, as required by mr_car_broadcast_en
      type: "header",
      parameters: [
        {
          type: "image",
          image: {
            link: headerImageLink
          }
        }
      ]
    },
    {
      // BODY: fills {{1}} in "Namaste {{1}}, welcome to Mr.Car! ..."
      type: "body",
      parameters: [
        { type: "text", text: displayName }
      ]
    }
  ];

  console.log(
    `Broadcast: sending media template to ${phone} with header ${headerImageLink}`
  );

  const res = await waSendTemplate(
    phone,
    BROADCAST_TEMPLATE_NAME,
    components
  );

  if (!res.ok) {
    console.warn("sendSheetWelcomeTemplate failed", phone, res.error);
    return false;
  }

  console.log("Greeting template sent OK:", phone);
  return true;
}

// small delay helper so we don’t spam WhatsApp too fast
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// compact buttons (used AFTER new-car quote)
async function sendNewCarButtons(to) {
  const buttons = [
    { type: 'reply', reply: { id: 'BTN_NEW_LOAN',  title: 'Loan Options' } },
    { type: 'reply', reply: { id: 'BTN_NEW_QUOTE', title: 'Another Quote' } }
  ];
  const interactive = {
    type: 'button',
    body: { text: 'You can continue with these quick actions:' },
    action: { buttons }
  };
  return waSendRaw({ messaging_product: 'whatsapp', to, type: 'interactive', interactive });
}

// service list (menu) — after greeting
async function waSendListMenu(to) {
  const rows = [
    { id: 'SRV_NEW_CAR',  title: 'New Car Deals',  description: 'On-road prices & offers' },
    { id: 'SRV_USED_CAR', title: 'Pre-Owned Cars', description: 'Certified used inventory' },
    { id: 'SRV_SELL_CAR', title: 'Sell My Car',    description: 'Get best quote for your car' },
    { id: 'SRV_LOAN',     title: 'Loan / Finance', description: 'EMI & Bullet options' }
  ];
  const interactive = {
    type: 'list',
    header: { type: 'text', text: 'MR. CAR SERVICES' },
    body:   { text: 'Please choose one option 👇' },
    footer: { text: 'Premium Deals • Trusted Service • Mr. Car' },
    action: { button: 'Select Service', sections: [ { title: 'Available', rows } ] }
  };
  return waSendRaw({ messaging_product: 'whatsapp', to, type: 'interactive', interactive });
}

// used car quick buttons (after used quote)
async function sendUsedCarButtons(to) {
  const buttons = [
    { type: 'reply', reply: { id: 'BTN_USED_MORE',     title: 'More Similar Cars' } },
    { type: 'reply', reply: { id: 'BTN_BOOK_TEST',     title: 'Book Test Drive' } },
    { type: 'reply', reply: { id: 'BTN_CONTACT_SALES', title: 'Contact Sales' } }
  ];
  const interactive = {
    type: 'button',
    body: { text: 'Quick actions:' },
    action: { buttons }
  };
  return waSendRaw({ messaging_product: 'whatsapp', to, type: 'interactive', interactive });
}

// ---------------- Admin alerts (throttled) ----------------
async function sendAdminAlert({ from, name, text }) {
  try {
    if (!META_TOKEN || !PHONE_NUMBER_ID || !ADMIN_WA) return;
    const now = Date.now();
    const prev = lastAlert.get(from) || 0;
    const ALERT_WINDOW_MS = (Number(process.env.ALERT_WINDOW_MINUTES || 10)) * 60 * 1000;
    if (now - prev < ALERT_WINDOW_MS) {
      if (DEBUG) console.log('throttled admin alert for', from);
      return;
    }
    lastAlert.set(from, now);
    const body =
      `🔔 NEW WA LEAD\n` +
      `From: ${from}\n` +
      `Name: ${name || '-'}\n` +
      `Msg: ${String(text || '').slice(0, 1000)}`;
    const resp = await waSendRaw({
      messaging_product: 'whatsapp',
      to: ADMIN_WA,
      type: 'text',
      text: { body }
    });
    if (DEBUG) console.log('sendAdminAlert response', resp);
  } catch (e) {
    console.warn('sendAdminAlert failed', e && e.message ? e.message : e);
  }
}

// ---------------- CSV parser ----------------
function parseCsv(text) {
  const rows = [];
  let cur = '';
  let row = [];
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQ = false;
        }
      } else {
        cur += ch;
      }
    } else {
      if (ch === '"') {
        inQ = true;
      } else if (ch === ',') {
        row.push(cur);
        cur = '';
      } else if (ch === '\n') {
        row.push(cur);
        rows.push(row);
        row = [];
        cur = '';
      } else if (ch !== '\r') {
        cur += ch;
      }
    }
  }
  if (cur.length || row.length) {
    row.push(cur);
    rows.push(row);
  }
  return rows;
}

async function fetchCsv(url) {
  if (!url) throw new Error('CSV URL missing');
  const r = await fetch(url, { cache: 'no-store', redirect: 'follow' });
  if (!r.ok) throw new Error(`CSV fetch failed ${r.status}`);
  const txt = await r.text();
  return parseCsv(txt);
}

function toHeaderIndexMap(headerRow) {
  const map = {};
  headerRow.forEach((h, i) => {
    map[String((h || '').trim()).toUpperCase()] = i;
  });
  return map;
}

// ---------------- normalization & helpers ----------------
function normForMatch(s) {
  return (s || '').toString().toLowerCase()
    .replace(/(automatic|automatic transmission|\bauto\b)/g, ' at ')
    .replace(/\bmanual\b/g, ' mt ')
    .replace(/[\*\/\\]/g, 'x')
    .replace(/\s*x\s*/g, 'x')
    .replace(/(\d)\s*x\s*(\d)/g, '$1x$2')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function fmtMoney(n) {
  const x = Number(n || 0);
  if (!isFinite(x)) return '-';
  return x.toLocaleString('en-IN', { maximumFractionDigits: 0 });
}

function calcEmiSimple(p, annualRatePct, months) {
  const P = Number(p);
  const r = Number(annualRatePct) / 12 / 100;
  if (!P || !isFinite(r) || months <= 0) return 0;
  const pow = Math.pow(1 + r, months);
  const emi = Math.round(P * r * pow / (pow - 1));
  return emi;
}

// ---------------- pricing loader (NEW CARS) ----------------
// Auto-detect all SHEET_*_CSV_URL env vars, so new brands work without code change.
const SHEET_URLS = (() => {
  const urls = {};

  // 1) Keep explicit mapping for known brands (backwards-compatible)
  const explicit = {
    HOT:      process.env.SHEET_HOT_DEALS_CSV_URL,
    TOYOTA:   process.env.SHEET_TOYOTA_CSV_URL,
    HYUNDAI:  process.env.SHEET_HYUNDAI_CSV_URL,
    MERCEDES: process.env.SHEET_MERCEDES_CSV_URL,
    BMW:      process.env.SHEET_BMW_CSV_URL
  };

  for (const [brand, val] of Object.entries(explicit)) {
    if (val) urls[brand] = val.trim();
  }

  // 2) Auto-discover any SHEET_<BRAND>_CSV_URL (e.g. SHEET_MAHINDRA_CSV_URL)
  for (const [envKey, value] of Object.entries(process.env)) {
    if (!value) continue;
    const m = envKey.match(/^SHEET_([A-Z0-9]+)_CSV_URL$/);
    if (!m) continue;
    const brandKey = m[1]; // e.g. TOYOTA, HYUNDAI, BMW, MAHINDRA, MG
    if (!urls[brandKey]) {
      urls[brandKey] = value.trim();
    }
  }

  return urls;
})();

const PRICING_CACHE = { tables: null, ts: 0 };
const PRICING_CACHE_MS = 3 * 60 * 1000;

async function loadPricingFromSheets() {
  const now = Date.now();
  if (PRICING_CACHE.tables && now - PRICING_CACHE.ts < PRICING_CACHE_MS) {
    return PRICING_CACHE.tables;
  }
  const tables = {};
  for (const [brand, url] of Object.entries(SHEET_URLS)) {
    if (!url) continue;
    try {
      const rows = await fetchCsv(url);
      if (!rows || !rows.length) continue;
      const header = rows[0].map(h => String(h || '').trim());
      const idxMap = toHeaderIndexMap(header);
      const data   = rows.slice(1);
      tables[brand] = { header, idxMap, data };
    } catch (e) {
      console.warn('CSV load failed for', brand, e && e.message ? e.message : e);
    }
  }
  PRICING_CACHE.tables = tables;
  PRICING_CACHE.ts = Date.now();
  return tables;
}

function detectExShowIdx(idxMap) {
  const keys = Object.keys(idxMap || {});
  for (const k of keys) {
    if (/EX[\s\-_\/A-Z0-9]*SHOWROOM/.test(String(k))) return idxMap[k];
  }
  const lowerKeys = keys.map(k => k.toLowerCase());
  const i = lowerKeys.findIndex(k => k.includes('ex') && k.includes('showroom'));
  if (i >= 0) return idxMap[keys[i]];
  return -1;
}
// ---- NEW CAR HELPERS: fuel type + on-road price column ----
function pickFuelIndex(idxMap) {
  const keys = Object.keys(idxMap || {});
  for (const k of keys) {
    const kl = k.toLowerCase();
    if (kl.includes('fuel') && kl.includes('type')) {
      return idxMap[k];
    }
  }
  return -1;
}

// audience = 'individual' | 'corporate', cityToken e.g. 'DELHI'
function pickOnRoadPriceIndex(idxMap, cityToken, audience) {
  const keys = Object.keys(idxMap || {});
  const cityLower = String(cityToken || '').toLowerCase();
  const aud = String(audience || '').toLowerCase();

  let best = null;

  function scoreKey(k) {
    const kl = k.toLowerCase();
    let s = 0;

    // Strong signals: "on road" + city
    if (kl.includes('on road') || (kl.includes('on') && kl.includes('road'))) s += 5;
    if (cityLower && kl.includes(cityLower)) s += 4;

    // Audience-specific scoring
    if (aud) {
      if (aud === 'corporate') {
        if (kl.includes('corporate') || kl.includes('company') || kl.includes('firm') || kl.includes('corp')) {
          s += 6;
        }
      } else if (aud === 'individual') {
        if (kl.includes('individual') || kl.includes('retail') || kl.includes('personal')) {
          s += 6;
        }
      }
    } else {
      // No explicit audience → slight bias to individual
      if (kl.includes('individual') || kl.includes('retail') || kl.includes('personal')) s += 2;
      if (kl.includes('corporate') || kl.includes('company') || kl.includes('firm') || kl.includes('corp')) s -= 1;
    }

    return s;
  }

  for (const k of keys) {
    const s = scoreKey(k);
    if (s <= 0) continue;
    if (!best || s > best.score) {
      best = { key: k, score: s };
    }
  }

  if (best) {
    return idxMap[best.key];
  }

  // Fallback: any column with city + 'road'
  for (const k of keys) {
    const kl = k.toLowerCase();
    if (cityLower && kl.includes(cityLower) && kl.includes('road')) {
      return idxMap[k];
    }
  }

  // Final fallback: any 'on road' column
  for (const k of keys) {
    const kl = k.toLowerCase();
    if (kl.includes('on road') || (kl.includes('on') && kl.includes('road'))) {
      return idxMap[k];
    }
  }

  return -1;
}

// ---------------- USED sheet loader ----------------
async function loadUsedSheetRows() {
  if (SHEET_USED_CSV_URL) {
    try {
      const rows = await fetchCsv(SHEET_USED_CSV_URL);
      if (rows && rows.length) return rows;
    } catch (e) {
      if (DEBUG) console.warn('remote used csv fetch failed', e && e.message ? e.message : e);
    }
  }
  try {
    if (fs.existsSync(LOCAL_USED_CSV_PATH)) {
      const txt = fs.readFileSync(LOCAL_USED_CSV_PATH, 'utf8');
      const rows = parseCsv(txt);
      if (rows && rows.length) return rows;
    }
  } catch (e) {
    if (DEBUG) console.warn('local used csv read failed', e && e.message ? e.message : e);
  }
  return [];
}

// Simulate a bullet loan plan for MR.CAR.
// - amount: loan amount
// - rate: annual ROI %, if missing defaults to 10
// - months: tenure in months, if missing defaults to 60
// - bulletPct: fraction (0.25 = 25%), defaults to 0.25
function simulateBulletPlan({ amount, rate, months, bulletPct }) {
  const L   = Number(amount || 0);            // loan amount
  const R   = Number(rate || 10);             // use 10% if not provided
  const n   = Number(months || 60);           // default 60 months
  const pct = (bulletPct !== undefined && bulletPct !== null)
    ? Number(bulletPct)
    : 0.25;                                   // default 25%

  if (!L || !n || !pct) {
    return null;
  }

  const bullet_total = L * pct;               // bullet principal total
  const principal_for_emi = L - bullet_total; // EMI principal only

  const r = R / 12 / 100;                     // monthly rate

  // Base EMI on non-bullet principal
  let base_emi = 0;
  if (principal_for_emi > 0 && r > 0) {
    const pow = Math.pow(1 + r, n);
    base_emi = (principal_for_emi * r * pow) / (pow - 1);
  } else if (principal_for_emi > 0 && n > 0) {
    base_emi = principal_for_emi / n;
  }

  // Number of bullets: yearly bullets within tenure
  const num_bullets = Math.max(1, Math.floor(n / 12));
  const bullet_each = bullet_total / num_bullets;

  let remainingBullet     = bullet_total;
  let total_emi_paid      = 0;
  let total_bullets_paid  = 0;
  let monthly_emi_example = 0;

  for (let m = 1; m <= n; m++) {
    // Interest on remaining bullet principal this month
    const bulletInterestThisMonth = remainingBullet * r;

    const paymentThisMonth = base_emi + bulletInterestThisMonth;
    total_emi_paid += paymentThisMonth;

    // Pay one bullet principal chunk every 12 months
    if (m % 12 === 0 && remainingBullet > 0) {
      const pay = Math.min(bullet_each, remainingBullet);
      remainingBullet    -= pay;
      total_bullets_paid += pay;
    }

    if (m === 1) {
      monthly_emi_example = Math.round(paymentThisMonth);
    }
  }

  const total_payable = Math.round(total_emi_paid + total_bullets_paid);

  return {
    loan: Math.round(L),
    rate: R,
    months: n,
    bulletPct: pct,

    principal_for_emi: Math.round(principal_for_emi),

    // for display as "Monthly EMI (approx)"
    monthly_emi: Math.round(monthly_emi_example),
    base_emi: Math.round(base_emi),

    bullet_total: Math.round(bullet_total),
    num_bullets,
    bullet_each: Math.round(bullet_each),

    total_emi_paid: Math.round(total_emi_paid),
    total_bullets_paid: Math.round(total_bullets_paid),
    total_payable
  };
}

// ---------------- Build used car quote ----------------
async function buildUsedCarQuoteFreeText({ query }) {
  const rows = await loadUsedSheetRows();
  if (!rows || !rows.length) {
    return { text: 'Used car pricing not configured.' };
  }

  const header = rows[0].map(h => String(h || '').trim().toUpperCase());
  const idxMap = toHeaderIndexMap(header);
  const data   = rows.slice(1);

  const makeIdx = idxMap['MAKE'] ?? idxMap['BRAND'] ?? header.findIndex(h => h.includes('MAKE') || h.includes('BRAND'));
  const modelIdx = idxMap['MODEL'] ?? header.findIndex(h => h.includes('MODEL'));
  const subModelIdx = idxMap['SUB MODEL'] ?? idxMap['SUBMODEL'] ?? header.findIndex(h => h.includes('SUB MODEL') || h.includes('SUBMODEL') || h.includes('VARIANT'));
  const colourIdx = idxMap['COLOUR'] ?? idxMap['COLOR'] ?? header.findIndex(h => h.includes('COLOUR') || h.includes('COLOR'));
  const yearIdx = idxMap['MANUFACTURING YEAR'] ?? idxMap['YEAR'] ?? header.findIndex(h => h.includes('MANUFACTURING') && h.includes('YEAR'));
  const regIdx = (() => {
    const keys = Object.keys(idxMap);
    for (const k of keys) {
      const u = k.toUpperCase();
      if (u.includes('REGISTRATION') || u.includes('REGN') || u.includes('REG PLACE')) {
        return idxMap[k];
      }
    }
    return -1;
  })();

  const expectedCandidates = [
    'EXPECTED PRICE',
    'EXPECTED_PRICE',
    'EXPECTED PRICE (₹)',
    'EXPECTED PRICE(INR)',
    'EXPECTED PRICE INR',
    'EXPECTED',
    'PRICE'
  ];
  let expectedIdx = -1;
  for (const key of expectedCandidates) {
    if (typeof idxMap[key] !== 'undefined') {
      expectedIdx = idxMap[key];
      break;
    }
  }
  if (expectedIdx < 0) {
    const ei = header.findIndex(h => h.includes('EXPECTED') && h.includes('PRICE'));
    if (ei >= 0) expectedIdx = ei;
  }

  const pictureIdx = (() => {
    const keys = Object.keys(idxMap);
    for (const k of keys) {
      const u = k.toUpperCase();
      if (u.includes('PICTURE') || u.includes('PHOTO') || u.includes('IMAGE') || u.includes('LINK')) {
        return idxMap[k];
      }
    }
    return -1;
  })();

  const qLower = (query || '').toLowerCase();
  const tokens = qLower.replace(/[^\w\s]/g, ' ').split(/\s+/).filter(Boolean);
  // ---- Budget-based search for used cars (± ₹10 lakh) ----
  let budgetRs = 0;

  // Find a number like "20 lakh", "20 lac", "20 l", or a plain "2000000"
  const mBudget = qLower.match(/(\d+(\.\d+)?)\s*(lakh|lakhs|lac|lacs|l\b|rs|₹|rupees)?/);
  if (mBudget) {
    const num = parseFloat(mBudget[1]);
    if (num > 0) {
      // If the number is small (e.g., 20), treat as lakhs → 20 * 1,00,000
      budgetRs = num < 1000 ? num * 100000 : num;
    }
  }

  // Helper for simple INR formatting
  function fmtINR(v) {
    const n = Math.round(Number(v) || 0);
    return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  if (budgetRs > 0 && expectedIdx >= 0) {
    const min = budgetRs - 1000000; // - 10 lakh
    const max = budgetRs + 1000000; // + 10 lakh

    const budgetMatches = [];

    for (let r = 0; r < data.length; r++) {
      const row = data[r];

      let expectedVal = 0;
      if (expectedIdx >= 0) {
        const exStr = String(row[expectedIdx] || '');
        expectedVal = Number(exStr.replace(/[,₹\s]/g, '')) || 0;
      }
      if (!expectedVal) continue;
      if (expectedVal < min || expectedVal > max) continue;

      budgetMatches.push({ row, expectedVal });
    }

    if (budgetMatches.length) {
      // Sort by price closest to requested budget
      budgetMatches.sort((a, b) => {
        const da = Math.abs(a.expectedVal - budgetRs);
        const db = Math.abs(b.expectedVal - budgetRs);
        return da - db;
      });

      const lines = [];
      lines.push(`*PRE-OWNED OPTIONS AROUND YOUR BUDGET*`);
      lines.push(
        `(Showing cars roughly between ₹${fmtINR(min)} and ₹${fmtINR(max)})`
      );

      const limit = Math.min(10, budgetMatches.length);
      for (let i = 0; i < limit; i++) {
        const { row, expectedVal } = budgetMatches[i];

        const makeDisp  = (row[makeIdx]  || '').toString().toUpperCase();
        const modelDisp = (row[modelIdx] || '').toString().toUpperCase();
        const subDisp   = subModelIdx >= 0 && row[subModelIdx]
          ? row[subModelIdx].toString().toUpperCase()
          : '';
        const yearDisp  = yearIdx >= 0 && row[yearIdx] ? String(row[yearIdx]) : '';
        const regPlace  = regIdx >= 0 && row[regIdx] ? String(row[regIdx]) : '';

        const titleParts = [];
        if (makeDisp)  titleParts.push(makeDisp);
        if (modelDisp) titleParts.push(modelDisp);
        if (subDisp)   titleParts.push(subDisp);

        const infoParts = [];
        if (yearDisp)  infoParts.push(yearDisp);
        if (regPlace)  infoParts.push(regPlace);

        const lineTitle = titleParts.length
          ? `*${titleParts.join(' ')}*`
          : '*PRE-OWNED CAR*';

        const lineInfo = infoParts.length
          ? ` (${infoParts.join(' | ')})`
          : '';

        lines.push(
          `${i + 1}. ${lineTitle}${lineInfo}\n   Expected: ₹${fmtINR(expectedVal)}`
        );
      }

      // Pick first available picture (if any)
      let picLink = '';
      if (pictureIdx >= 0) {
        for (const bm of budgetMatches) {
          const link = bm.row[pictureIdx];
          if (link) {
            picLink = String(link);
            break;
          }
        }
      }

      return { text: lines.join('\n'), picLink };
    }
    // If no cars found in that price band, fall through to normal text-based matching below
  }

  const matches = [];
  for (let r = 0; r < data.length; r++) {
    const row = data[r];
    const make = String(row[makeIdx] || '').toLowerCase();
    const model = String(row[modelIdx] || '').toLowerCase();
    const sub  = subModelIdx >= 0 ? String(row[subModelIdx] || '').toLowerCase() : '';

    let score = 0;
    for (const t of tokens) {
      if (!t) continue;
      if (make.includes(t)) score += 8;
      if (model.includes(t)) score += 10;
      if (sub.includes(t)) score += 6;
    }
    if (score > 0) {
      matches.push({ r, score, make, model, sub, row });
    }
  }

  if (!matches.length) {
    return {
      text:
        `Sorry, I couldn’t find an exact match for "${query}".\n` +
        `Please share brand and model (e.g., "Audi A6 2018") or give a budget and I’ll suggest options.`
    };
  }

  // Brand-level search: e.g. "audi", "used audi", "pre owned audi"
  const genericWords = new Set([
    'used', 'preowned', 'pre-owned', 'pre', 'owned', 'second', 'secondhand', 'second-hand',
    'car', 'cars'
  ]);
  const coreTokens = tokens.filter(t => t && !genericWords.has(t));
  if (coreTokens.length === 1) {
    const brandTok = coreTokens[0];
    let brandMatches = matches.filter(m => m.make.includes(brandTok));
    if (!brandMatches.length) brandMatches = matches;
    if (brandMatches.length > 1) {
      brandMatches.sort((a, b) => b.score - a.score);
      const top = brandMatches.slice(0, Math.min(10, brandMatches.length));
      const lines = [];
      const brandLabel = brandTok.toUpperCase();
      lines.push(`*PRE-OWNED OPTIONS – ${brandLabel}*`);
      for (let i = 0; i < top.length; i++) {
        const row = top[i].row;
        const makeDisp  = (row[makeIdx]  || '').toString().toUpperCase();
        const modelDisp = (row[modelIdx] || '').toString().toUpperCase();
        const subDisp   = subModelIdx >= 0 && row[subModelIdx]
          ? row[subModelIdx].toString().toUpperCase()
          : '';
        const yearDisp  = yearIdx >= 0 && row[yearIdx] ? String(row[yearIdx]) : '';
        const regPlace  = regIdx >= 0 && row[regIdx] ? String(row[regIdx]) : '';

        let expectedVal = 0;
        if (expectedIdx >= 0) {
          const exStr = String(row[expectedIdx] || '');
          expectedVal = Number(exStr.replace(/[,₹\s]/g, '')) || 0;
        }

        const titleParts = [];
        if (makeDisp)  titleParts.push(makeDisp);
        if (modelDisp) titleParts.push(modelDisp);
        if (subDisp)   titleParts.push(subDisp);
        if (yearDisp)  titleParts.push(yearDisp);
        const title = titleParts.join(' ');

        let line = `${i + 1}) *${title}*`;
        if (expectedVal) line += ` – ₹ ${fmtMoney(expectedVal)}`;
        if (regPlace)   line += ` – Reg: ${regPlace}`;
        lines.push(line);
      }
      lines.push('');
      lines.push('Please reply with the *exact car* you are interested in (for example: "Audi A6 2018") for a detailed quote.');
      return { text: lines.join('\n') };
    }
  }

  // Single best match (normal flow)
  matches.sort((a, b) => b.score - a.score);
  const selRow = matches[0].row;

  const make  = (selRow[makeIdx]  || '').toString().toUpperCase();
  const model = (selRow[modelIdx] || '').toString().toUpperCase();
  const sub   = subModelIdx >= 0 && selRow[subModelIdx] ? selRow[subModelIdx].toString().toUpperCase() : '';
  const colour = colourIdx >= 0 && selRow[colourIdx] ? selRow[colourIdx].toString().toUpperCase() : '';
  const year   = yearIdx >= 0 && selRow[yearIdx] ? String(selRow[yearIdx]) : '';
  const regPlace = regIdx >= 0 && selRow[regIdx] ? String(selRow[regIdx]) : '';

  const expectedStr = expectedIdx >= 0 ? String(selRow[expectedIdx] || '') : '';
  let expected = Number(expectedStr.replace(/[,₹\s]/g, '')) || 0;
  if (!expected) {
    for (let i = 0; i < selRow.length; i++) {
      const v = String(selRow[i] || '').replace(/[,₹\s]/g, '');
      if (/^\d+$/.test(v) && Number(v) > 100000) {
        expected = Number(v);
        break;
      }
    }
  }
  if (!expected) {
    return { text: `Price for *${make} ${model}* not available in sheet.` };
  }

  const LTV_PCT = 95;
  const loanAmt = Math.round(expected * (LTV_PCT / 100));
  const tenure  = 60;

  const emiNormal = calcEmiSimple(loanAmt, USED_CAR_ROI_VISIBLE, tenure);
const bulletSim = simulateBulletPlan({
  amount: loanAmt,                 // ✔ loan amount
  rate:  USED_CAR_ROI_INTERNAL,    // ✔ your internal ROI (10%)
  months: tenure,                  // ✔ same tenure as normal EMI
  bulletPct: 0.25                  // ✔ 25% bullet
});

  let picLink = null;
  if (pictureIdx >= 0 && selRow[pictureIdx]) {
    const cellVal = String(selRow[pictureIdx] || '');
    if (cellVal.includes('http')) picLink = cellVal.trim();
  } else {
    for (const c of selRow) {
      const s = String(c || '');
      if (s.includes('http')) {
        picLink = s.trim();
        break;
      }
    }
  }

  const lines = [];
  lines.push('*PRE-OWNED CAR QUOTE*');
  lines.push(`Make/Model: *${make} ${model}${sub ? ' - ' + sub : ''}*`);
  if (year)     lines.push(`Manufacturing Year: ${year}`);
  if (colour)   lines.push(`Colour: ${colour}`);
  if (regPlace) lines.push(`Registration Place: ${regPlace}`);
  lines.push('');
  lines.push(`Expected Price: ₹ *${fmtMoney(expected)}*`);
  lines.push(`Loan up to *${LTV_PCT}% LTV*: ₹ *${fmtMoney(loanAmt)}*`);
  lines.push('');
  lines.push('*OPTION 1 – NORMAL EMI*');
  lines.push(`Tenure: ${tenure} months`);
  lines.push(`Approx EMI: ₹ *${fmtMoney(emiNormal)}* (@ *${USED_CAR_ROI_VISIBLE}%* p.a.)`);
  if (bulletSim) {
    lines.push('');
    lines.push('*OPTION 2 – BULLET EMI (25%)*');
    lines.push(`Tenure: ${bulletSim.months} months`);
    lines.push(`Monthly EMI (approx): ₹ *${fmtMoney(bulletSim.monthly_emi)}*`);
    lines.push(`Bullet total (25% of loan): ₹ *${fmtMoney(bulletSim.bullet_total)}*`);
    lines.push(
      `Bullets: ₹ *${fmtMoney(bulletSim.bullet_each)}* at months ` +
      Array.from({ length: bulletSim.num_bullets }, (_, i) => 12 * (i + 1)).join(', ')
    );
  }
  lines.push('');
  lines.push('✅ *Loan approval possible in ~30 minutes (T&Cs apply)*');
  lines.push('\n*Terms & Conditions Apply ✅*');

  return { text: lines.join('\n'), picLink };
}

// ---------------- Greeting helper ----------------
const GREETING_WINDOW_MINUTES = Number(process.env.GREETING_WINDOW_MINUTES || 600);
const GREETING_WINDOW_MS = GREETING_WINDOW_MINUTES * 60 * 1000;

/**
 * shouldGreetNow(from, msgText)
 *
 * Purpose:
 * - Return true only when the incoming message clearly looks like a greeting.
 * - Avoid treating longer queries (e.g. "Hycross ZXO Delhi individual" or "Hycross 2024")
 *   as greetings so they proceed to the pricing/advisory flows.
 *
 * Logic:
 * - Ignore admin number.
 * - Message must start with a greeting keyword (hi/hello/hey/namaste/enquiry/inquiry/help/start).
 * - Message must be short (<= 4 words) to avoid matching model/variant queries.
 * - Respect the GREETING_WINDOW_MS throttle to avoid repeated greetings.
function shouldGreetNow(from, msgText) {
  try {
    if (ADMIN_WA && from === ADMIN_WA) return false;
    const now = Date.now();
    const prev = lastGreeting.get(from) || 0;
    const text = (msgText || '').trim().toLowerCase();

    // Simple greeting keyword match (anchored at start) and short message check.
    const looksLikeGreeting =
      /^(hi|hello|hey|namaste|enquiry|inquiry|help|start)\b/.test(text) &&
      // keep it short to avoid false positives: max 4 words
      (text.length === 0 || text.split(/\s+/).filter(Boolean).length <= 4);

    if (!looksLikeGreeting) return false;
    if (now - prev < GREETING_WINDOW_MS) return false;

    lastGreeting.set(from, now);
    return true;
  } catch (e) {
    console.warn('shouldGreetNow failed', e);
    return false;
  }
}

// ---------------- CRM helpers placeholder ----------------
let postLeadToCRM = async () => {};
let fetchCRMReply = async () => null;
let getAllLeads   = async () => [];

try {
  const crmHelpers = require('./crm_helpers.cjs');
  postLeadToCRM = crmHelpers.postLeadToCRM || postLeadToCRM;
  fetchCRMReply = crmHelpers.fetchCRMReply || fetchCRMReply;
  getAllLeads   = crmHelpers.getAllLeads   || getAllLeads;
  if (DEBUG) console.log('crm_helpers.cjs loaded');
} catch (e) {
  if (DEBUG) console.log('crm_helpers.cjs not loaded (ok for dev).');
}

/* =======================================================================
   Signature GPT & Brochure helpers
   ======================================================================= */
const BROCHURE_INDEX_PATH = process.env.BROCHURE_INDEX_PATH || './brochures/index.json';

// advisory intent detector
function isAdvisory(msgText) {
  const t = (msgText || '').toLowerCase();
  if (!t) return false;

  const advisoryPhrases = [
    'which is better',
    'better than',
    'which to buy',
    'which to choose',
    'compare',
    'comparison',
    'pros and cons',
    'pros & cons',
    'features',
    'feature wise',
    'variant wise',
    'warranty',
    'extended warranty',
    'service cost',
    'maintenance',
    'ground clearance',
    'boot space',
    'dimensions',
    'mileage',
    'average',
    'kitna deti',
    'bhp',
    'torque',
    'safety rating',
    'global ncap'
  ];

  for (const p of advisoryPhrases) {
    if (t.includes(p)) return true;
  }

  // simple "A vs B" detector
  if (t.includes(' vs ') || t.includes(' v/s ') || /\bvs\b/.test(t)) return true;

  return false;
}

// brochure index loader
function loadBrochureIndex() {
  try {
    const p = path.resolve(__dirname, BROCHURE_INDEX_PATH);
    if (!fs.existsSync(p)) return [];
    const txt = fs.readFileSync(p, 'utf8') || '[]';
    const j = JSON.parse(txt);
    return Array.isArray(j) ? j : [];
  } catch (e) {
    if (DEBUG) console.warn('loadBrochureIndex failed', e && e.message ? e.message : e);
    return [];
  }
}

function findRelevantBrochures(index, msgText) {
  try {
    if (!Array.isArray(index) || !index.length) return [];
    const q = (msgText || '').toLowerCase();
    const scored = index.map(b => {
      const title = (b.title || b.id || '').toString().toLowerCase();
      const brand = (b.brand || '').toString().toLowerCase();
      const variants = (b.variants || []).map(v => v.toString().toLowerCase());
      let score = 0;
      if (title && q.includes(title)) score += 30;
      if (brand && q.includes(brand)) score += 25;
      for (const v of variants) if (v && q.includes(v)) score += 18;
      if (b.summary && b.summary.toLowerCase().includes(q)) score += 15;
      return { b, score };
    }).filter(x => x.score > 0);
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 3).map(x => x.b);
  } catch (e) {
    if (DEBUG) console.warn('findRelevantBrochures fail', e && e.message ? e.message : e);
    return [];
  }
}

const PHONE_RE = /(?:(?:\+?\d{1,3}[\s\-\.])?(?:\(?\d{2,4}\)?[\s\-\.])?\d{3,4}[\s\-\.]\d{3,4})(?:\s*(?:ext|x|ext.)\s*\d{1,5})?/g;

function extractPhonesFromText(text) {
  try {
    if (!text) return [];
    const found = (String(text).match(PHONE_RE) || []).map(s => s.trim());
    const norm = found.map(s => s.replace(/[\s\-\.\(\)]+/g, ''));
    const unique = [];
    const seen = new Set();
    for (let i = 0; i < norm.length; i++) {
      if (!seen.has(norm[i])) {
        seen.add(norm[i]);
        unique.push(found[i]);
      }
    }
    return unique;
  } catch (e) {
    if (DEBUG) console.warn('extractPhonesFromText fail', e && e.message ? e.message : e);
    return [];
  }
}

function findPhonesInBrochures(entries) {
  const matches = [];
  try {
    for (const b of (entries || [])) {
      const srcId = b.id || b.title || b.url || 'unknown';
      const candidates = [];
      if (b.summary) candidates.push(b.summary);
      if (b.title) candidates.push(b.title);
      if (b.helpline) candidates.push(String(b.helpline));
      const joined = candidates.join(' \n ');
      const phones = extractPhonesFromText(joined);
      for (const p of phones) {
        const low = joined.toLowerCase();
        let label = '';
        if (low.includes('rsa') || low.includes('roadside')) label = 'RSA helpline';
        else if (low.includes('service')) label = 'Service helpline';
        else if (low.includes('warranty')) label = 'Warranty helpline';
        else if (low.includes('customer') || low.includes('care')) label = 'Customer care';
        else label = 'Helpline';
        matches.push({ label, phone: p, sourceId: srcId });
      }
    }
    const uniq = [];
    const seen = new Set();
    for (const m of matches) {
      const k = (m.phone || '').replace(/[\s\-\.\(\)]+/g, '');
      if (!seen.has(k)) {
        seen.add(k);
        uniq.push(m);
      }
    }
    return uniq;
  } catch (e) {
    if (DEBUG) console.warn('findPhonesInBrochures fail', e && e.message ? e.message : e);
    return [];
  }
}

// Signature Brain wrapper
async function callSignatureBrain({ from, name, msgText, lastService, ragHits = [] } = {}) {
  try {
    if (!msgText) return null;

    const sys = `You are SIGNATURE SAVINGS — a crisp dealership advisory assistant for MR.CAR.
Answer concisely, with dealership-level accuracy.
Always end with: "Reply 'Talk to agent' to request a human."`;

    let context = "";
    if (Array.isArray(ragHits) && ragHits.length > 0) {
      context = ragHits.map(x => x.text).join("\n\n---\n\n");
    }

    const promptMessages = [
      { role: "system", content: sys },
      { role: "user", content: `User question: ${msgText}\n\nRelevant Data:\n${context}` }
    ];

    const resp = await openai.chat.completions.create({
      model: SIGNATURE_MODEL,
      messages: promptMessages,
      max_tokens: 600,
      temperature: 0.25
    });

    return resp?.choices?.[0]?.message?.content || null;

  } catch (err) {
    console.error("SignatureBrain error:", err?.message || err);
    return null;
  }
}
// ============================================================================
// SMART NEW-CAR INTENT ENGINE — SAFE ADDITIVE BLOCK
// Place ABOVE tryQuickNewCarQuote()
// This does NOT modify existing logic; only handles new intents FIRST
// ============================================================================
// ============================================================================
// SMART NEW-CAR INTENT ENGINE — SAFE ADDITIVE BLOCK
// ============================================================================

async function trySmartNewCarIntent(msgText, to) {
  if (!msgText) return false;
  const t = String(msgText || "").toLowerCase().trim();

  // If user is clearly asking for technical specs, let main new-car flow handle it
  if (/\b(spec|specs|specification|specifications)\b/i.test(t)) {
    return false; // don't consume, allow tryQuickNewCarQuote to run
  }

  // ------------------------------
  // DICTIONARIES
  // ------------------------------
  const FEATURE_TOPICS = [
    "adas","cvt","at","mt","diesel","hybrid","ev","awd","4x4","cruise","toyota safety sense",
    "airbags","turbo","sunroof","engine","mileage","bs6","e20"
  ];

  const WAITING_PERIODS = {
    "toyota fortuner": "4–12 weeks depending on color & variant.",
    "toyota innova hycross": "8–20 weeks (higher for ZX(O) Hybrid).",
    "mahindra scorpio n": "4–16 weeks.",
    "mahindra xuv700": "6–20 weeks.",
    "hyundai creta": "2–6 weeks.",
    "hyundai venue": "1–4 weeks.",
    "toyota hyryder": "6–10 weeks."
  };

  // ------------------------------
  // 1️⃣ COMPARISON INTENT
  // ------------------------------
  if (/vs|compare|better|difference between/.test(t)) {
    const foundModels = detectModelsFromText(t);   // uses global MODEL_ALIASES

    if (foundModels.length >= 2) {
      const m1 = foundModels[0];
      const m2 = foundModels[1];

      const comparison = await SignatureAI_RAG(
        `Provide a clean customer-friendly comparison between ${m1} and ${m2} covering:
         - Price
         - Engine & performance
         - Mileage
         - Features & safety
         - Comfort & space
         - Best for which type of customer`
      );

      await waSendText(
        to,
        `*${m1} vs ${m2} — Detailed Comparison*\n\n${comparison}`
      );
      setLastService(to, "NEW");
      return true;
    }

    // Comparison requested but not enough models detected
    await waSendText(
      to,
      "Please tell me the two car models you want me to compare (e.g., *Creta vs Hyryder* or *E Class vs 5 Series*)."
    );
    return true;
  }

  // ------------------------------
  // 2️⃣ BUDGET INTENT (SUV / Sedan / Hatch)
  // ------------------------------
  let budget = null;
  const budgetMatch = t.match(/\b(\d{1,2})\s?(lakh|lakhs|lac|lacs)\b/);
  if (budgetMatch) {
    budget = Number(budgetMatch[1]) * 100000;
  } else {
    const priceNumber = t.match(/\b(\d{5,7})\b/);
    if (priceNumber) {
      const v = Number(priceNumber[1]);
      if (v >= 300000 && v <= 4000000) budget = v;
    }
  }

  const wantsSUV = /\bsuv\b/.test(t);
  const wantsSedan = /\bsedan\b/.test(t);
  const wantsHatch = /\bhatch|hatchback\b/.test(t);

  if (budget) {
    const CARS = [
      { model:"Toyota Glanza",        type:"HATCH", price:750000 },
      { model:"Toyota Hyryder",       type:"SUV",   price:1200000 },
      { model:"Toyota Rumion",        type:"MPV",   price:1100000 },
      { model:"Hyundai Creta",        type:"SUV",   price:1150000 },
      { model:"Hyundai Venue",        type:"SUV",   price:900000 },
      { model:"Honda City",           type:"SEDAN", price:1200000 },
      { model:"Maruti Brezza",        type:"SUV",   price:900000 },
      { model:"Kia Sonet",            type:"SUV",   price:900000 },
      { model:"Kia Carens",           type:"MPV",   price:1100000 }
    ];

    const picks = CARS.filter(c =>
      c.price <= budget &&
      (
        (wantsSUV && c.type === "SUV") ||
        (wantsSedan && c.type === "SEDAN") ||
        (wantsHatch && c.type === "HATCH") ||
        (!wantsSUV && !wantsSedan && !wantsHatch)  // any body type if none specified
      )
    );

    if (picks.length > 0) {
      const out = [];
      out.push(`*Best New Car Options Under ₹${fmtMoney(budget)}*`);

      if (wantsSUV) out.push("• Segment: *SUV*");
      else if (wantsSedan) out.push("• Segment: *Sedan*");
      else if (wantsHatch) out.push("• Segment: *Hatchback*");
      else out.push("• Segment: *Any*");

      out.push("");

      picks.slice(0, 6).forEach(c => {
        out.push(`• *${c.model}* — starts at ₹${fmtMoney(c.price)}`);
      });

      out.push("");
      out.push("Tell me the model name for exact *on-road price*, *offers* and *EMI*.");

      await waSendText(to, out.join("\n"));
      setLastService(to, "NEW");
      return true;
    }

    await waSendText(
      to,
      `I noted your budget of *₹${fmtMoney(budget)}*.\nDo you prefer *SUV*, *Sedan* or *Hatchback*?`
    );
    setLastService(to, "NEW");
    return true;
  }

  // ------------------------------
  // 3️⃣ FEATURE EXPLANATION MODE (RAG)
  // ------------------------------
  for (const ft of FEATURE_TOPICS) {
    if (t.includes(ft)) {
      const expl = await SignatureAI_RAG(
        `Explain "${ft}" in simple car-buyer language (2–3 short paragraphs, India context).`
      );
      await waSendText(
        to,
        `*${ft.toUpperCase()} — Simple Explanation*\n\n${expl}`
      );
      setLastService(to, "NEW");
      return true;
    }
  }

  // ------------------------------
  // 4️⃣ RECOMMENDATION MODE
  // ------------------------------
  if (/which car should i buy|recommend.*car|suggest.*car|help me choose/.test(t)) {
    await waSendText(
      to,
      "*I'll help you pick the right new car.*\n\n" +
      "Please tell me:\n" +
      "1️⃣ Your *budget* (e.g., 10 lakh)\n" +
      "2️⃣ Preferred *body type* (SUV / Sedan / Hatchback)\n" +
      "3️⃣ Your *city*\n\n" +
      "I’ll suggest the best 2–3 options with on-road pricing."
    );
    return true;
  }

  // ------------------------------
  // 5️⃣ WAITING PERIOD & DELIVERY
  // ------------------------------
  for (const [modelName, wait] of Object.entries(WAITING_PERIODS)) {
    const key = modelName.split(" ")[1] || modelName; // e.g. "fortuner" from "toyota fortuner"
    if (t.includes(key.toLowerCase())) {
      await waSendText(
        to,
        `*${modelName.toUpperCase()} — Waiting Period*\n${wait}\n\n` +
        "Tell me your preferred *color* and *variant* to check the closest delivery timeline."
      );
      setLastService(to, "NEW");
      return true;
    }
  }

  // ------------------------------
  // 6️⃣ FINANCE / EMI MODE
  // ------------------------------
  if (/emi|finance|loan|0 down|zero down/.test(t)) {
    await waSendText(
      to,
      "To calculate your *EMI*, please tell me:\n" +
      "• Car model (e.g., *Fortuner ZX*, *Creta SX*, *City VX*)\n" +
      "• City\n" +
      "• Individual or Corporate profile\n\n" +
      "I’ll share the approx 60-month EMI and typical down payment."
    );
    return true;
  }

  // If no smart intent detected → let main flow handle it
  return false;
}

// ============================================================================
// END OF SMART BLOCK
// ============================================================================
// ---------------- tryQuickNewCarQuote ----------------
async function tryQuickNewCarQuote(msgText, to) {
  try {
    if (!msgText || !msgText.trim()) return false;

    // If user included a year (e.g. "2024"), treat as USED -> do not serve new-car flow here
    const yearMatch = (String(msgText).match(/\b(19|20)\d{2}\b/) || [])[0];
    if (yearMatch) {
      const y = Number(yearMatch);
      const nowYear = new Date().getFullYear();
      if (y >= 1990 && y <= nowYear) {
        if (DEBUG) console.log('User query contains year -> treat as USED:', msgText);
        return false;
      }
    }

    if (!canSendQuote(to)) {
      await waSendText(
        to,
        'You’ve reached today’s assistance limit for quotes. Please try again tomorrow or provide your details for a personalised quote.'
      );
      return true;
    }

    const tables = await loadPricingFromSheets();
    if (!tables || Object.keys(tables).length === 0) return false;

    const t = String(msgText || '').toLowerCase();
    const tUpper = t.toUpperCase();

    // --- unified brand detection (uses global helper) ---
    let brandGuess = detectBrandFromText(t);

    // city detection
    let cityMatch =
      (t.match(/\b(delhi|dilli|haryana|hr|chandigarh|chd|uttar pradesh|up|himachal|hp|mumbai|bombay|bangalore|bengaluru|chennai|kolkata|pune)\b/) || [])[1] ||
      null;
    if (cityMatch) {
      if (cityMatch === 'dilli') cityMatch = 'delhi';
      if (cityMatch === 'hr') cityMatch = 'haryana';
      if (cityMatch === 'chd') cityMatch = 'chandigarh';
      if (cityMatch === 'up') cityMatch = 'uttar pradesh';
      if (cityMatch === 'hp') cityMatch = 'himachal pradesh';
      if (cityMatch === 'bombay') cityMatch = 'mumbai';
    } else {
      cityMatch = 'delhi';
    }
    const city = cityMatch;

    const profile =
      (t.match(/\b(individual|company|corporate|firm|personal)\b/) || [])[1] || 'individual';

    // map profile → audience for price selection
    const audience =
      /company|corporate|firm/i.test(profile) ? 'corporate' : 'individual';
// ---------- BUDGET PARSER + PRICE RANGE ----------
function parseBudgetFromText(s) {
  if (!s) return null;
  const norm = String(s).toLowerCase().replace(/[,₹]/g, ' ').replace(/\s+/g, ' ').trim();

  // direct plain number (no unit)
  const plainNum = (norm.match(/\b([0-9]{5,9})\b/ ) || [])[1];
  if (plainNum) {
    const v = Number(plainNum);
    if (v > 10000) return v;
  }

  // lakh / lac / l
  let m = norm.match(/\b([0-9]+(?:\.[0-9]+)?)\s*(lakh|lac|l|k)\b/);
  if (!m) m = norm.match(/\b([0-9]+(?:\.[0-9]+)?)\s*(l)\b/);
  if (m) {
    const v = Number(m[1]) * 100000;
    if (!Number.isNaN(v)) return v;
  }

  // crore
  m = norm.match(/\b([0-9]+(?:\.[0-9]+)?)\s*(crore|cr|c)\b/);
  if (m) {
    const v = Number(m[1]) * 10000000;
    if (!Number.isNaN(v)) return v;
  }

  // compact like 15k (thousand)
  m = norm.match(/\b([0-9]+(?:\.[0-9]+)?)\s*k\b/);
  if (m) {
    const v = Number(m[1]) * 1000;
    if (!Number.isNaN(v)) return v;
  }

  // fallback: find any large number token
  const tokens = norm.split(/\s+/).filter(Boolean);
  for (const tok of tokens) {
    const n = Number(tok);
    if (!Number.isNaN(n) && n >= 50000) return n;
  }
  return null;
}

const userBudget = parseBudgetFromText(t); // in INR rupees, integer or null
let budgetMin = null, budgetMax = null;
if (userBudget) {
  const MARGIN = Number(process.env.NEW_CAR_BUDGET_MARGIN || 0.20); // default 20% if not set
  budgetMin = Math.round(userBudget * (1 - MARGIN));
  budgetMax = Math.round(userBudget * (1 + MARGIN));
  if (DEBUG) console.log("User budget parsed:", userBudget, "range:", budgetMin, budgetMax);
}
// ---------- end BUDGET block ----------

    // broaden raw: normalize 'auto' / 'automatic' to 'at' to match your variant suffix scheme
    let raw = t
      .replace(/\b(delhi|dilli|haryana|hr|chandigarh|chd|uttar pradesh|up|himachal|hp|mumbai|bombay|bangalore|bengaluru|chennai|kolkata|pune)\b/g, ' ')
      .replace(/\b(individual|company|corporate|firm|personal)\b/g, ' ')
      .replace(/\b(automatic transmission|automatic|auto)\b/g, ' at ')
      .replace(/[^\w\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!raw) return false;

    // base model guess (first few tokens)
    let modelGuess = raw.split(' ').slice(0, 4).join(' ');
    const userNorm = normForMatch(raw);
    const tokens = userNorm.split(' ').filter(Boolean);

    // short token (like "gla", "gls", "x5", "e200")
    const modelTok = (modelGuess.split(' ')[0] || '').toLowerCase();
    const isShortModelToken = modelTok && modelTok.length <= 4;

    // variant list limit
    const VARIANT_LIST_LIMIT = Number(process.env.VARIANT_LIST_LIMIT || 12);

    const SPECIAL_WORDS = ['LEADER', 'LEGENDER', 'GRS'];

    // helper: create loose pattern for suffixes like "zxo", "z x o", "zx", "z xo"
    function _makeLoosePat(sfx) {
      const parts = (sfx || '').toString().toLowerCase().split('');
      const escaped = parts.map(ch => ch.replace(/[^a-z0-9]/g, '\\$&'));
      return new RegExp('\\b' + escaped.join('[\\s\\W_]*') + '\\b', 'i');
    }

const cityToken = city.split(' ')[0].toUpperCase();

const allMatches = [];

// ---------- MULTI-BRAND DETECTION ----------
let allowedBrandSet = null;

if (brandGuess) {
  // If user mentioned a brand, keep it fixed
  allowedBrandSet = new Set([String(brandGuess).toUpperCase()]);
} else {
    // Otherwise detect multiple brand names from the query
  const mentionBrands = [];
  const allBrands = Object.keys(tables || {});

  // ----------------- STRENGTHEN BRAND DETECTION -----------------
  // Build a simple alias map from your tables' keys:
  const brandAliasMap = {};
  for (const b of allBrands) {
    if (!b) continue;
    const raw = String(b).trim();
    const lower = raw.toLowerCase();
    const canonical = raw;

    // whole-name
    brandAliasMap[lower] = canonical;
    // first token (toyota innova -> "toyota")
    const first = lower.replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)[0];
    if (first) brandAliasMap[first] = canonical;
    // strip common company suffixes
    const stripped = lower.replace(/\b(motors|cars|automobiles|auto|motors ltd|motors pvt|pvt|ltd)\b/g, ' ').replace(/\s+/g,' ').trim();
    if (stripped) brandAliasMap[stripped] = canonical;
    // short alias
    if (first && first.length <= 6) brandAliasMap[first] = canonical;
  }

  // detect brands by token and by substring
  const detectedBrands = new Set();
  const txtLower = t.toLowerCase();

  // 1) token-level detection (exact token matches to alias map)
  for (const token of txtLower.split(/\s+/).filter(Boolean)) {
    if (brandAliasMap[token]) detectedBrands.add(String(brandAliasMap[token]).toUpperCase());
  }

  // 2) substring detection (handles multi-word mentions like "toyota innova")
  for (const b of allBrands) {
    if (!b) continue;
    const bLow = String(b).toLowerCase();
    if (bLow.length > 2 && txtLower.includes(bLow)) {
      detectedBrands.add(String(b).toUpperCase());
    }
  }

  // 3) normalise fuzzy single-brand guesses from detectBrandFromText
  if (brandGuess) {
    const bgLow = String(brandGuess || '').toLowerCase();
    const exactKey = allBrands.find(x => String(x).toLowerCase() === bgLow);
    if (exactKey) {
      brandGuess = String(exactKey).toUpperCase();
      detectedBrands.add(brandGuess);
    } else {
      const partial = allBrands.find(x => String(x).toLowerCase().includes(bgLow));
      if (partial) {
        brandGuess = String(partial).toUpperCase();
        detectedBrands.add(brandGuess);
      }
    }
  }

  // Finalize allowedBrandSet: prefer explicit detected brands, else fall back to brandGuess if present
  if (detectedBrands.size > 0) {
    allowedBrandSet = new Set(Array.from(detectedBrands));
  } else if (brandGuess) {
    allowedBrandSet = new Set([String(brandGuess).toUpperCase()]);
  } else {
    allowedBrandSet = null; // keep null to allow all brands
  }

  if (DEBUG) {
    console.log("Brand alias map (sample):", Object.keys(brandAliasMap).slice(0,8));
    console.log("Detected brand candidates from text:", Array.from(detectedBrands));
    console.log("Final allowedBrandSet:", allowedBrandSet ? Array.from(allowedBrandSet) : "ALL");
  }
  // ----------------- END brand strengthening -----------------

  const txt = t.toLowerCase();
// --- strengthened multi-brand detection ---
for (const b of allBrands) {
  const bNorm = b.toLowerCase();
  // exact brand word match → very strong signal
  if (txt.includes(bNorm)) {
    mentionBrands.push(b);
  }
  // remove spaces: "landrover" = "land rover"
  if (txt.replace(/\s+/g, '').includes(bNorm.replace(/\s+/g, ''))) {
    mentionBrands.push(b);
  }
}

// If multiple brands found → pick the strongest one
if (mentionBrands.length === 1) {
  brandGuess = mentionBrands[0];
} else if (mentionBrands.length > 1) {
  // choose brand mention with longest overlap
  brandGuess = mentionBrands.sort((a, b) => b.length - a.length)[0];
}
  for (const b of allBrands) {
    const bLow = String(b || '').toLowerCase();
    if (!bLow) continue;

    // clean: remove symbols (toyota → toyota, mahindra-suv → mahindra)
    const bClean = bLow.replace(/[^a-z0-9]/g, ' ').split(/\s+/)[0];

    if (bClean && txt.includes(bClean)) {
      mentionBrands.push(String(b).toUpperCase());
    }
  }
  if (mentionBrands.length) {
    allowedBrandSet = new Set(mentionBrands);
    if (DEBUG) console.log("Multi-brand detection:", mentionBrands);
  }
}
// ---------- END MULTI-BRAND DETECTION ----------

for (const [brand, tab] of Object.entries(tables)) {
       if (!tab || !tab.data) continue;

      const brandKey = String(brand || '').toUpperCase();

      // strong brand lock: if we know the brand, ignore other sheets
      if (brandGuess && brandKey !== brandGuess.toUpperCase()) continue;

      const header = tab.header.map(h => String(h || '').toUpperCase());
      const idxMap = tab.idxMap || toHeaderIndexMap(header);
      const idxModel = header.findIndex(h => h.includes('MODEL') || h.includes('VEHICLE'));
      const idxVariant = header.findIndex(h => h.includes('VARIANT') || h.includes('SUFFIX'));
      const idxVarKw = header.findIndex(h => h.includes('VARIANT_KEYWORDS') || h.includes('KEYWORD'));
      const idxSuffixCol = header.findIndex(h => h.includes('SUFFIX'));
      const fuelIdx = pickFuelIndex(idxMap);
      const exIdx = detectExShowIdx(idxMap);
      const globalPriceIdx = pickOnRoadPriceIndex(idxMap, cityToken, audience);

      for (const row of tab.data) {
        const modelCell = idxModel >= 0 ? String(row[idxModel] || '').toLowerCase() : '';
        const variantCell = idxVariant >= 0 ? String(row[idxVariant] || '').toLowerCase() : '';
        const modelNorm = normForMatch(modelCell);
        const variantNorm = normForMatch(variantCell);

        // HARD FILTER for very short model tokens (GLA/GLS/E200/X5 etc.)
        if (brandGuess && isShortModelToken) {
          const modelWords = modelNorm.split(' ').filter(Boolean);
          if (!modelWords.includes(modelTok)) {
            continue; // row is NOT this model → SKIP
          }
        }

        let score = 0;

        // stronger signals for exact substring matches (keeps prior behaviour)
        if (modelCell && modelCell.includes(modelGuess)) score += 40;
        if (variantCell && variantCell.includes(modelGuess)) score += 45;
        if (raw && (modelCell.includes(raw) || variantCell.includes(raw))) score += 30;

        // normalized-match signals
        if (userNorm && modelNorm && (modelNorm.includes(userNorm) || userNorm.includes(modelNorm))) {
          score += 35;
        }
        if (userNorm && variantNorm && (variantNorm.includes(userNorm) || userNorm.includes(variantNorm))) {
          score += 35;
        }

        let varKwNorm = '';
        let suffixNorm = '';
        if (idxVarKw >= 0 && row[idxVarKw] != null) {
          varKwNorm = normForMatch(row[idxVarKw]);
        }
        if (idxSuffixCol >= 0 && row[idxSuffixCol] != null) {
          suffixNorm = normForMatch(row[idxSuffixCol]);
        }

        let fuelNorm = '';
        let fuelCell = '';
        if (fuelIdx >= 0 && row[fuelIdx] != null) {
          fuelCell = String(row[fuelIdx] || '');
          fuelNorm = normForMatch(fuelCell.toLowerCase());
        }

        for (const tok of tokens) {
          if (!tok) continue;
          if (modelNorm && modelNorm.includes(tok)) score += 5;
          if (variantNorm && variantNorm.includes(tok)) score += 8;
          if (suffixNorm && suffixNorm.includes(tok)) score += 10;
          if (varKwNorm && varKwNorm.includes(tok)) score += 15;
          if (fuelNorm && fuelNorm.includes(tok)) score += 6; // petrol / diesel / hybrid / cng
        }

        // improved suffix detection for ZX/VX/GX/ZXO/VXO/GXO (loose)
        const specialSuffixes = ['zxo', 'gxo', 'vxo', 'zx', 'vx', 'gx'];
        const searchTargets = [variantNorm || '', suffixNorm || '', varKwNorm || '', modelNorm || ''].join(' ');
        let userSuffix = null;
        for (const sfx of specialSuffixes) {
          const pat = _makeLoosePat(sfx);
          if (pat.test(userNorm) || pat.test(searchTargets)) {
            userSuffix = sfx;
            break;
          }
        }
        if (userSuffix) {
          const sPat = _makeLoosePat(userSuffix);
          const rowHasSuffix = sPat.test(variantNorm) || sPat.test(suffixNorm) || sPat.test(varKwNorm) || sPat.test(modelNorm);
          if (rowHasSuffix) score += 80;
          else score -= 15; // small penalty if row doesn't show suffix
        }

        const variantUpper = String(variantCell || '').toUpperCase();
        const varKwUpper = String(varKwNorm || '').toUpperCase();
        for (const sw of SPECIAL_WORDS) {
          if ((variantUpper.includes(sw) || varKwUpper.includes(sw)) && !tUpper.includes(sw.toLowerCase())) {
            score -= 25;
          }
        }

        if (score <= 0) continue;

        // pick on-road price column (Delhi INDIVIDUAL / CORPORATE)
        let priceIdx = globalPriceIdx;
        if (priceIdx < 0) {
          // Fallback: first numeric cell in row
          for (let i = 0; i < row.length; i++) {
            const v = String(row[i] || '').replace(/[,₹\s]/g, '');
            if (v && /^\d+$/.test(v)) {
              priceIdx = i;
              break;
            }
          }
        }

        const priceStr = priceIdx >= 0 ? String(row[priceIdx] || '') : '';
        const onroad = Number(priceStr.replace(/[,₹\s]/g, '')) || 0;
        if (!onroad) continue;

        const exShow = exIdx >= 0 ? Number(String(row[exIdx] || '').replace(/[,₹\s]/g, '')) || 0 : 0;

       let priceOk = true;
let priceScoreDelta = 0;

if (userBudget) {
  if (onroad >= budgetMin && onroad <= budgetMax) {
    priceScoreDelta += 60;
  } else {
    const mid = (budgetMin + budgetMax) / 2;
    const rel = Math.abs(onroad - mid) / (mid || 1);

    if (rel <= 0.30) priceScoreDelta -= Math.round(rel * 100);
    else priceOk = false;
  }
}

if (!priceOk) continue;

allMatches.push({
  brand: brandKey,
  row,
  idxModel,
  idxVariant,
  idxMap,
  onroad,
  exShow,
  score: score + priceScoreDelta,
  fuel: fuelCell
});
      }
    }

    // ---------- BUDGET RELAXATION: if no strict matches, retry without budget filter ----------
if (!allMatches.length) {
  if (userBudget) {
    if (DEBUG) console.log("No strict budget matches → relaxing budget filter.");

    for (const [brand, tab] of Object.entries(tables)) {
      if (!tab || !tab.data) continue;

      const brandKey2 = String(brand || '').toUpperCase();
      // obey multi-brand detection if active
      if (allowedBrandSet && !allowedBrandSet.has(brandKey2)) continue;

      const header2 = tab.header.map(h => String(h || '').toUpperCase());
      const idxMap2 = tab.idxMap || toHeaderIndexMap(header2);
      const priceIdx2 = pickOnRoadPriceIndex(idxMap2, cityToken, audience);

      for (const row2 of tab.data) {
        const priceStr2 = priceIdx2 >= 0 ? String(row2[priceIdx2] || '') : '';
        const onroad2 = Number(priceStr2.replace(/[,₹\s]/g, '')) || 0;
        if (!onroad2) continue;

        allMatches.push({
          brand: brandKey2,
          row: row2,
          idxModel: header2.findIndex(h => h.includes("MODEL") || h.includes("VEHICLE")),
          idxVariant: header2.findIndex(h => h.includes("VARIANT") || h.includes("SUFFIX")),
          idxMap: idxMap2,
          onroad: onroad2,
          exShow: 0,
          score: 10, // low priority
          fuel: ""
        });
      }
    }
  }

  // still nothing? fail gracefully
  if (!allMatches.length) return false;
}
// ---------- END RELAXATION BLOCK ----------

    // sort by score desc
    if (userBudget) {
  const mid = (budgetMin + budgetMax) / 2;
  allMatches.sort((a, b) => {
    const diff = b.score - a.score;
    if (diff !== 0) return diff;
    const da = Math.abs((a.onroad || 0) - mid);
    const db = Math.abs((b.onroad || 0) - mid);
    return da - db; // closer to budget comes first
  });
} else {
  allMatches.sort((a, b) => b.score - a.score);
}

    // if user asked only the brand/model (very short query) — show short variant list
    const genericWords = new Set(['car','cars','used','pre','preowned','pre-owned','second','secondhand','second-hand']);
    const coreTokens = tokens.filter(tk => tk && !genericWords.has(tk));
    if (coreTokens.length === 1) {
      // gather top distinct variants for that model/brand
      const distinct = [];
      const seenTitles = new Set();
      for (const m of allMatches) {
        const row = m.row;
        const modelVal = m.idxModel >= 0 ? String(row[m.idxModel] || '').toUpperCase() : '';
        const variantVal = m.idxVariant >= 0 ? String(row[m.idxVariant] || '').toUpperCase() : '';
        const titleParts = [];
        if (modelVal) titleParts.push(modelVal);
        if (variantVal) titleParts.push(variantVal);
        const title = titleParts.join(' ').trim();
        if (!title) continue;
        if (!seenTitles.has(title)) {
          seenTitles.add(title);
          distinct.push({ title, onroad: m.onroad, brand: m.brand });
        }
        if (distinct.length >= VARIANT_LIST_LIMIT) break;
      }

      if (distinct.length > 1) {
       const lines = [];
lines.push(`*Available variants (${distinct.length}) — ${coreTokens[0].toUpperCase()}*`);

// show budget if user provided one
if (userBudget) {
  lines.push(`*Budget:* ₹ ${fmtMoney(userBudget)}  (Showing ~ ${Math.round((budgetMin||userBudget)/1000)/1000}L - ${Math.round((budgetMax||userBudget)/1000)/1000}L)`);
  lines.push(''); // blank line
}

for (let i = 0; i < distinct.length; i++) {
  const d = distinct[i];
  lines.push(`${i + 1}) *${d.title}* – On-road ₹ ${fmtMoney(d.onroad)}`);
}
lines.push('');
lines.push('Reply with the *exact variant* (e.g., "Hycross ZXO Delhi individual") for a detailed deal.');
await waSendText(to, lines.join('\n'));

        setLastService(to, 'NEW');
        return true;
      }
    }

    // Single best match: pick top
    const best = allMatches[0];
    if (!best) return false;

    const loanAmt = best.exShow || best.onroad || 0;
    const emi60 = loanAmt ? calcEmiSimple(loanAmt, NEW_CAR_ROI, 60) : 0;

    const modelName  = best.idxModel   >= 0 ? String(best.row[best.idxModel]   || '').toUpperCase() : '';
    const variantStr = best.idxVariant >= 0 ? String(best.row[best.idxVariant] || '').toUpperCase() : '';
    const fuelStr    = best.fuel ? String(best.fuel).toUpperCase() : '';

    const lines = [];
    lines.push(`*${best.brand}* ${modelName} ${variantStr}`);
    lines.push(`*City:* ${city.toUpperCase()} • *Profile:* ${profile.toUpperCase()}`);
    if (fuelStr) lines.push(`*Fuel:* ${fuelStr}`);
    if (best.exShow) lines.push(`*Ex-Showroom:* ₹ ${fmtMoney(best.exShow)}`);
    if (best.onroad) lines.push(`*On-Road (${audience.toUpperCase()}):* ₹ ${fmtMoney(best.onroad)}`);
    if (loanAmt) {
      lines.push(
        `*Loan:* 100% of Ex-Showroom → ₹ ${fmtMoney(loanAmt)} @ *${NEW_CAR_ROI}%* (60m) → *EMI ≈ ₹ ${fmtMoney(emi60)}*`
      );
    }
        lines.push('\n*Terms & Conditions Apply ✅*');

    // --- SPEC SHEET: first try RAG, then fallback to Signature AI ---
    try {
      // 🔥 Make "specs / specification / features" all work
      const specIntent = /\b(spec|specs|specification|specifications|feature|features)\b/i;

      if (specIntent.test(t)) {
        const specQuery = `${best.brand} ${modelName} ${variantStr} full technical specifications for India (engine, bhp, torque, seating, dimensions, tyres, safety, mileage).`;

        let specText = "";

        // 1️⃣ Try direct RAG / vector search first
        try {
          if (typeof findRelevantChunks === "function") {
            const chunks = await findRelevantChunks(specQuery, 4);
            if (Array.isArray(chunks) && chunks.length) {
              const joined = chunks
                .map(c => (c.text || c.content || "").trim())
                .filter(Boolean)
                .join("\n");

              if (joined && joined.length > 80) {
                specText = joined;
              }
            }
          }
        } catch (ragErr) {
          if (DEBUG) console.warn("Spec RAG (chunks) failed:", ragErr && (ragErr.message || ragErr));
        }

        // 2️⃣ Fallback → Signature AI
        if (!specText && typeof SignatureAI_RAG === "function") {
          const specPrompt = `
You are Mr.Car Signature AI.

Give a clean, bullet-point technical specification sheet for:
${best.brand} ${modelName} ${variantStr}

Include (India-spec, approximate ok):
- Engine type & displacement
- Power (BHP / kW) and torque (Nm)
- Transmission (MT / AT / CVT / DCT) and drive type (FWD / RWD / AWD / 4x4)
- Fuel type and claimed mileage
- Seating capacity
- Tyre & wheel size
- Key safety features (airbags, ABS, ESP, ADAS if applicable)
Keep it concise, readable on WhatsApp and avoid marketing fluff.
          `.trim();

          try {
            const aiSpec = await SignatureAI_RAG(specPrompt);
            if (aiSpec && aiSpec.trim().length > 40) {
              specText = aiSpec.trim();
            }
          } catch (aiErr) {
            if (DEBUG) console.warn("Spec SignatureAI_RAG failed:", aiErr && (aiErr.message || aiErr));
          }
        }

        if (specText) {
          lines.push("");
          lines.push("*Key Specifications (approx., India spec)*");
          lines.push(specText);
        }
      }
    } catch (err) {
      if (DEBUG) console.warn("Spec block failed:", err && (err.message || err));
    }

    await waSendText(to, lines.join('\n'));
    await sendNewCarButtons(to);
    incrementQuoteUsage(to);
    setLastService(to, 'NEW');
    return true;

  } catch (e) {
    console.error('tryQuickNewCarQuote error', e && e.stack ? e.stack : e);
    return false;
  }
}

// ---------------- webhook verify & health ----------------
app.get('/healthz', (req, res) => {
  res.json({ ok: true, t: Date.now(), debug: DEBUG });
});

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN && challenge) {
    console.log('Webhook verified ✅');
    return res.status(200).type('text/plain').send(String(challenge));
  }
  return res.sendStatus(403);
});

// -------------- CRM API ROUTES ---------------
app.get('/crm/leads', async (req, res) => {
  try {
    // 1) Prefer canonical CRM helper if available (from crm_helpers.cjs)
    try {
      if (typeof getAllLeads === 'function') {
        const leads = await getAllLeads();
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
      if (fs.existsSync(LEADS_FILE)) {
        const raw = fs.readFileSync(LEADS_FILE, 'utf8');
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
app.post('/admin/test_alert', async (req, res) => {
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
app.post('/webhook', async (req, res) => {
  try {
    // ensure `short` exists in the outer scope so later code can't throw ReferenceError
    let short = {};

        if (DEBUG) {
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
          if (msg.type === "image" && msg.image?.id && ADMIN_WA && senderForAuto !== ADMIN_WA) {
            await waForwardImage(
              ADMIN_WA,
              msg.image.id,
              `📷 Customer sent an image\nFrom: ${senderForAuto}\nName: ${senderNameForAuto || "UNKNOWN"}`
            );
            if (DEBUG) console.log("Forwarded user image to admin WA:", msg.image.id);
          }
        } catch (err) {
          console.warn("Forward image to admin failed:", err?.message || err);
        }

               // ---- 2. AI VISION: TEMP – run for ANY image to test pipeline ----
        try {
          if (msg.type === "image" && msg.image?.id) {
            const caption = msg.image?.caption || "";
            const combinedText = `${lastMsgForAuto || ""} ${caption || ""}`.toLowerCase();

            if (DEBUG) {
              console.log("AI VISION candidate image:", {
                caption,
                lastMsgForAuto,
                combinedText
              });
            }

            const mediaUrl = await getMediaUrl(msg.image.id);
            if (mediaUrl) {
              const analysis = await analyzeCarImageFaultWithOpenAI(mediaUrl, combinedText);
              await waSendText(
                senderForAuto,
                `*Preliminary check based on your photo:*\n\n${analysis}`
              );
              setLastService(senderForAuto, "FAULT_ANALYSIS");
            } else if (DEBUG) {
              console.log("AI VISION: no mediaUrl returned for image id:", msg.image.id);
            }
          }
        } catch (err) {
          console.warn("AI vision fault analysis failed:", err?.message || err);
          // Do not return; let rest of flow continue
        }

        // ---- 3. AUTO-INGEST TO CRM (existing behaviour) ----
        await autoIngest({
          bot: "MR.CAR",
          channel: "whatsapp",
          from: senderForAuto,
          name: senderNameForAuto,
          lastMessage: lastMsgForAuto,
          meta: { source: "webhook-auto" }
        });

        // ---- 4. ADMIN TEXT ALERT (existing behaviour) ----
        try {
          if (ADMIN_WA && senderForAuto !== ADMIN_WA) {
            const body =
              `🔔 *New Lead Received*\n\n` +
              `👤 Name: ${senderNameForAuto}\n` +
              `📱 Phone: ${senderForAuto}\n` +
              `💬 Message: ${lastMsgForAuto || 'No text'}\n` +
              `⏰ Time: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`;

            await waSendText(ADMIN_WA, body);

            if (DEBUG) {
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
      recordDeliveryStatusForPhone(recipient, {
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

  if (DEBUG) {
    console.log('Status-only event processed for delivery tracking.');
  }
  return res.sendStatus(200);  // Important: DO NOT REMOVE THIS
}

    const msg     = value?.messages?.[0];
    const contact = value?.contacts?.[0];	

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
      if (DEBUG) console.warn('message parsing failed', e && e.message ? e.message : e);
      msgText = '';
    }
    // ------------------------------------------------------------------
    // STEP-2: SMART NEW CAR INTENT ENGINE (handles budget, compare, etc.)
    // ------------------------------------------------------------------
    try {
      const smartText = (typeof msgText === 'string' && msgText.trim())
        ? msgText.trim()
        : '';

      const smartFrom = from || null;

      if (smartText && smartFrom) {
        const handled = await trySmartNewCarIntent(smartText, smartFrom);
        if (handled) {
          if (DEBUG) {
            console.log("SMART NEW CAR INTENT handled.", {
              from: smartFrom,
              text: smartText
            });
          }
          // We already replied from trySmartNewCarIntent
          return res.sendStatus(200);
        }
      } else if (DEBUG) {
        console.log("SMART NEW CAR INTENT skipped (missing smartText or smartFrom)", {
          smartText,
          smartFrom
        });
      }
    } catch (e) {
      console.warn("Smart intent engine failed:", e?.message || e);
    }

    // ---- Admin alert for real incoming messages ----
    try {
      // Only if ADMIN_WA is set, we have a sender, and it’s not the admin number itself
      if (ADMIN_WA && from && from !== ADMIN_WA) {
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
        await waSendText(ADMIN_WA, body);

        if (DEBUG) {
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
        const embedResp = await openai.embeddings.create({
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
      if (queryEmbedding && typeof findRelevantChunks === 'function') {
        const ragData = await (getRAG ? getRAG() : Promise.resolve(null));
        if (ragData) {
          ragHits = findRelevantChunks(queryEmbedding, ragData, 5) || [];
        }
      }
    } catch (e) {
      if (DEBUG) console.warn('RAG search failed', e && e.message ? e.message : e);
      ragHits = [];
    }
    // ---- END RAG BLOCK ----

         // save lead locally + CRM (non-blocking)
    try {
      // derive service + purpose once
      const lastServiceValue = getLastService(from) || null;
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
      postLeadToCRM(lead).catch(() => {});

      // also log a normalized copy into local file for /api/leads fallback
      let existing = safeJsonRead(LEADS_FILE);
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
      fs.writeFileSync(LEADS_FILE, JSON.stringify(existing, null, 2), 'utf8');

      if (DEBUG) {
        console.log('✅ Lead saved (local + CRM):', from, purpose, (msgText || '').slice(0, 120));
      }
    } catch (e) {
      console.warn('lead save failed', e && e.message ? e.message : e);
    }

    // interactive choices
    if (selectedId) {
      switch (selectedId) {
        case 'SRV_NEW_CAR':
        case 'BTN_NEW_QUOTE':
          setLastService(from, 'NEW');
          await waSendText(
            from,
            'Please share your *city, model, variant/suffix & profile (individual/company)*.'
          );
          break;

        case 'SRV_USED_CAR':
        case 'BTN_USED_MORE':
          setLastService(from, 'USED');
          await waSendText(
            from,
            'Share *make, model, year* (optional colour/budget) and I’ll suggest options.'
          );
          break;

        case 'SRV_SELL_CAR':
          setLastService(from, 'SELL');
          await waSendText(
            from,
            'Please share *car make/model, year, km, city* and a few photos. We’ll get you the best quote.'
          );
          break;

        case 'SRV_LOAN':
          setLastService(from, 'LOAN');
          await waSendText(from, 'Loan assistance options below 👇');
          await waSendRaw({
            messaging_product: 'whatsapp',
            to: from,
            type: 'interactive',
            interactive: {
              type: 'button',
              body: { text: 'Choose a loan option:' },
              action: {
                buttons: [
                  { type: 'reply', reply: { id: 'BTN_LOAN_EMI',         title: 'EMI Calculator' } },
                  { type: 'reply', reply: { id: 'BTN_LOAN_DOCS',        title: 'Loan Documents' } },
                  { type: 'reply', reply: { id: 'BTN_LOAN_ELIGIBILITY', title: 'Loan Eligibility' } }
                ]
              }
            }
          });
          break;

        case 'BTN_LOAN_EMI':
          await waSendText(
            from,
            'For EMI calculation, reply like:\n`emi 1500000 9.5 60`\n\nFormat: `emi <loan amount> <rate% optional> <months>`'
          );
          break;

        case 'BTN_LOAN_DOCS':
          await waSendText(
            from,
            'Basic loan documents:\n• PAN, Aadhaar\n• 3–6 months bank statement\n• Salary slips / ITRs\n• Address proof\n\nShare your *city + profile (salaried/self-employed)* for a precise list.'
          );
          break;

        case 'BTN_LOAN_ELIGIBILITY':
          await waSendText(
            from,
            'For eligibility, please share:\n• City\n• Salaried / Self-employed\n• Monthly income\n• Existing EMIs (if any)\n\nExample: `Delhi salaried 1.2L income 15k existing EMI`'
          );
          break;

        case 'BTN_NEW_LOAN':
          await waSendText(
            from,
            `For loan assistance, share *city + car model + budget*. New car ROI from *${NEW_CAR_ROI}%*, Used car *${USED_CAR_ROI_VISIBLE}%*.`
          );
          break;

        case 'BTN_CONTACT_SALES':
          await waSendText(
            from,
            'Our sales team will contact you shortly. Share your preferred time and contact details.'
          );
          break;

        case 'BTN_BOOK_TEST':
          await waSendText(
            from,
            'Thanks — share preferred date/time and we\'ll call to confirm the test drive.'
          );
          break;

        default:
          await waSendText(from, 'Thanks! You can type your request anytime.');
          break;
      }
      return res.sendStatus(200);
    }

    // Greeting first – ONLY service menu (no quick buttons now)
    if (shouldGreetNow(from, msgText)) {
      await waSendText(
        from,
        '🔴 *MR. CAR* welcomes you!\nNamaste 🙏\n\nWe assist with *pre-owned cars*, *new car deals*, *loans* and *insurance*.\nTell us how we can help — or pick an option below.'
      );
      await waSendListMenu(from);
      return res.sendStatus(200);
    }

    // bullet command
    const bulletCmd = (msgText || '').trim().match(/^bullet\s+([\d,]+)\s*([\d\.]+)?\s*(\d+)?/i);
    if (bulletCmd) {
      const loanRaw = String(bulletCmd[1] || '').replace(/[,₹\s]/g, '');
      const months  = Number(bulletCmd[3] || 60);
      const loanAmt = Number(loanRaw);
      if (!loanAmt || !months) {
        await waSendText(
          from,
          'Please send: `bullet <loan amount> <rate% optional> <tenure months>` e.g. `bullet 750000 10 60`'
        );
        return res.sendStatus(200);
      }
      const sim = simulateBulletPlan({
  amount: loanAmt,                  // ✔ correct parameter
  rate: USED_CAR_ROI_INTERNAL,      // ✔ 10% internal
  months: months,                   // ✔ tenure
  bulletPct: 0.25                   // ✔ 25%
});
      if (!sim) {
        await waSendText(from, 'Bullet calculation failed.');
        return res.sendStatus(200);
      }
      const lines = [];
      lines.push('🔷 *Bullet EMI Plan — Used Car*');
      lines.push(`Loan Amount: ₹ *${fmtMoney(sim.loan)}*`);
      lines.push(`ROI (shown): *${USED_CAR_ROI_VISIBLE}%*`);
      lines.push(`Tenure: *${sim.months} months*`);
      lines.push('');
      lines.push(`📌 Monthly EMI (approx): ₹ *${fmtMoney(sim.monthly_emi)}*`);
      lines.push(`📌 Bullet total (25%): ₹ *${fmtMoney(sim.bullet_total)}*`);
      lines.push(
        `• Bullet each: ₹ *${fmtMoney(sim.bullet_each)}* on months: ` +
        Array.from({ length: sim.num_bullets }, (_, i) => 12 * (i + 1)).join(' • ')
      );
      lines.push('');
      lines.push('✅ *Loan approval possible in ~30 minutes (T&Cs apply)*');
      await waSendText(from, lines.join('\n'));
      try {
        postLeadToCRM({ bot: 'MR_CAR_AUTO', channel: 'whatsapp', from, name, lastMessage: `BULLET_CALC ${loanAmt} ${months}`, service: 'LOAN', tags: ['BULLET_EMI'], meta: {} });
      } catch (_) {}
      return res.sendStatus(200);
    }

    // emi command
    const emiCmd = (msgText || '').trim().match(/^emi\s+([\d,]+)(?:\s+([\d\.]+)%?)?\s*(\d+)?/i);
    if (emiCmd) {
      const loanRaw = String(emiCmd[1] || '').replace(/[,₹\s]/g, '');
      const rate    = Number(emiCmd[2] || NEW_CAR_ROI);
      const months  = Number(emiCmd[3] || 60);
      const loanAmt = Number(loanRaw);
      if (!loanAmt || !months) {
        await waSendText(
          from,
          'Please send: `emi <loan amount> <rate% optional> <tenure months>` e.g. `emi 1500000 9.5 60`'
        );
        return res.sendStatus(200);
      }
      const monthly = calcEmiSimple(loanAmt, rate, months);
      const total   = monthly * months;
      const interest = total - loanAmt;
      const lines = [
        '🔸 EMI Calculation',
        `Loan: ₹ *${fmtMoney(loanAmt)}*`,
        `Rate: *${rate}%* p.a.`,
        `Tenure: *${months} months*`,
        '',
        `📌 Monthly EMI: ₹ *${fmtMoney(monthly)}*`,
        `📊 Total Payable: ₹ *${fmtMoney(total)}*`,
        `💰 Total Interest: ₹ *${fmtMoney(interest)}*`,
        '',
        '✅ *Loan approval possible in ~30 minutes (T&Cs apply)*',
        '\n*Terms & Conditions Apply ✅*'
      ];
      await waSendText(from, lines.join('\n'));
      return res.sendStatus(200);
    }

    // numeric reply after used-car list (safe behaviour)
    if (type === 'text' && msgText) {
      const trimmed = msgText.trim();
      const lastSvc = getLastService(from);
      if (lastSvc === 'USED' && /^[1-9]\d*$/.test(trimmed)) {
        await waSendText(
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
      const lastSvc = getLastService(from);

      if (explicitUsed || hasYear || lastSvc === 'USED') {
        const usedRes = await buildUsedCarQuoteFreeText({ query: msgText });
        await waSendText(from, usedRes.text || 'Used car quote failed.');
        if (usedRes.picLink) {
          await waSendText(from, `Photos: ${usedRes.picLink}`);
        }
        await sendUsedCarButtons(from);
        setLastService(from, 'USED');
        return res.sendStatus(200);
      }
    }

    // NEW CAR quick quote (only if NOT advisory-style)
    if (type === 'text' && msgText && !isAdvisory(msgText)) {
      const served = await tryQuickNewCarQuote(msgText, from);
      if (served) {
        return res.sendStatus(200);
      }
    }

    // Advisory handler (Signature GPT + brochures) — AFTER pricing
    if (type === 'text' && msgText && isAdvisory(msgText)) {
      try {
        // Log advisory queries locally
        try {
          const logPath = path.resolve(__dirname, '.crm_data', 'advisory_queries.json');
          const dir = path.dirname(logPath);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

          const existing = fs.existsSync(logPath)
            ? JSON.parse(fs.readFileSync(logPath, 'utf8') || '[]')
            : [];

          existing.unshift({
            ts: Date.now(),
            from,
            name,
            text: msgText.slice(0, 1000)
          });

          fs.writeFileSync(logPath, JSON.stringify(existing.slice(0, 5000), null, 2), 'utf8');
          if (DEBUG) console.log(`🧠 ADVISORY LOGGED: ${from} -> ${msgText.slice(0,60)}`);
        } catch (e) {
          if (DEBUG) console.warn('advisory log failed', e && e.message ? e.message : e);
        }

        // quick helplines from brochure index
        try {
          const index = loadBrochureIndex();
          const relevant = findRelevantBrochures(index, msgText);
          const phones = findPhonesInBrochures(relevant);
          if (phones && phones.length) {
            const lines = phones.map(p => `${p.label}: ${p.phone}`).slice(0,5);
            await waSendText(from, `📞 Quick helplines:\n${lines.join('\n')}\n\n(Full advisory below.)`);
          }
        } catch (e) {
          if (DEBUG) console.warn('advisory quick-phones failed', e && e.message ? e.message : e);
        }

        // Call Signature GPT
        const sigReply = await callSignatureBrain({ from, name, msgText, lastService: getLastService(from), ragHits });
        if (sigReply) {
          await waSendText(from, sigReply);
          try {
            await postLeadToCRM({
              bot: 'SIGNATURE_ADVISORY',
              channel: 'whatsapp',
              from,
              name,
              lastMessage: msgText,
              service: 'ADVISORY',
              tags: ['SIGNATURE_ADVISORY'],
              meta: { engine: SIGNATURE_MODEL, snippet: sigReply.slice(0,300) },
              createdAt: Date.now()
            });
          } catch (e) {
            if (DEBUG) console.warn('postLeadToCRM advisory log failed', e && e.message ? e.message : e);
          }
          return res.sendStatus(200);
        }
      } catch (e) {
        if (DEBUG) console.warn('Advisory handler error', e && e.message ? e.message : e);
      }
    }

    // CRM fallback
    try {
      const crmReply = await fetchCRMReply({ from, msgText });
      if (crmReply) {
        await waSendText(from, crmReply);
        return res.sendStatus(200);
      }
    } catch (e) {
      console.warn('CRM reply failed', e && e.message ? e.message : e);
    }

    // default fallback
    await waSendText(
      from,
      'Tell me your *city + make/model + variant/suffix + profile (individual/company)*. e.g., *Delhi Hycross ZXO individual* or *HR BMW X1 sDrive18i company*.'
    );
    return res.sendStatus(200);
  } catch (err) {
    console.error('Webhook error:', err && err.stack ? err.stack : err);
    try {
      if (process.env.ADMIN_WA) {
        await waSendText(
          process.env.ADMIN_WA,
          `Webhook crash: ${String(err && err.message ? err.message : err)}`
        );
      }
    } catch (_) {}
    return res.sendStatus(200);
  }
});

// ---------------- start server ----------------

/* --- FORCE: serve /assets from public/dashboard/assets (regex fallback) --- */
app.get(/^\/assets\/(.*)$/, (req, res) => {
  try {
    const rel = (req.params && req.params[0]) || req.path.replace(/^\/assets\//, "");
    const filePath = path.join(__dirname, "public", "dashboard", "assets", rel);
    if (fs.existsSync(filePath)) return res.sendFile(filePath);
    return res.status(404).send("asset not found");
  } catch (e) {
    console.error("assets fallback error", e && e.message ? e.message : e);
    return res.status(500).send("internal");
  }
});

/* Serve vite.svg at root (safe) */
app.get("/vite.svg", (req, res) => {
  try {
    const p = path.join(__dirname, "public", "dashboard", "vite.svg");
    if (fs.existsSync(p)) return res.sendFile(p);
    return res.status(404).send("vite.svg not found");
  } catch (e) {
    console.error("vite.svg handler error", e && e.message ? e.message : e);
    return res.status(500).send("internal");
  }
});
/* --- end snippet --- */
// --- MRCAR: manual ingest from JSON (dedupe, replace global leads) ---
app.post('/api/leads/ingest-from-json', async (req, res) => {
  try {
    const arr = req.body;
    if (!Array.isArray(arr)) {
      return res.status(400).json({ ok:false, error:'Body must be JSON array' });
    }

    // Deduplicate (id > phone > name)
    const seen = new Set();
    const uniq = [];
    for (const l of arr) {
      const key = (l.id || l.phone || l.name || '').toString().trim();
      if (!key) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      uniq.push(l);
    }

    
globalThis.leads = uniq;
try { global.leadsDB = uniq; } catch(e) { /* ignore */ }
  
    return res.json({ ok:true, replaced: uniq.length });
  } catch(e){
    console.error("ingest-from-json error", e);
    return res.status(500).json({ ok:false, error:String(e) });
  }
});
// === IMAGE UPLOAD ENDPOINT (for sending pics on WhatsApp) ===
const multer = require("multer");

const imageStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, "public/uploads");
  },
  filename: function (req, file, cb) {
    const unique = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, unique + "-" + file.originalname.replace(/\s+/g, "_"));
  }
});

const uploadImage = multer({ storage: imageStorage });

app.post("/api/uploads/image", uploadImage.single("image"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ ok: false, error: "No image uploaded" });
  }
  const url = "/uploads/" + req.file.filename;
  return res.json({ ok: true, url });
});

// === BULK WHATSAPP SENDER ===
app.post("/api/bulk/send", async (req, res) => {
  const rows = req.body.rows || [];
  let sent = 0;

  for (const r of rows) {
    if (!r.phone || !r.message) continue;

    try {
      await waSendText(r.phone, r.message);
      sent++;
      await new Promise(r => setTimeout(r, 350)); // avoid Meta rate-limit
    } catch (err) {
      console.warn("bulk send failed for", r.phone, err.message);
    }
  }

  res.json({ ok: true, sent });
});

app.post('/send-image', async (req, res) => {
try {
const { to, imageUrl, caption } = req.body || {};
if (!to || !imageUrl) return res.status(400).json({ ok:false, error:'missing to or imageUrl' });

// If imageUrl is a local path (starts with /uploads or does not start with http)
let mediaId = null;
let useLink = null;
if (String(imageUrl).startsWith('/uploads') || !/^https?:\/\//i.test(imageUrl)) {
// treat as local server file
const localRel = imageUrl.replace(/^\//, ''); // e.g. public/uploads/xxx
const localPath = path.join(__dirname, localRel);
if (!fs.existsSync(localPath)) return res.status(404).json({ ok:false, error:'local file not found' });
mediaId = await uploadMediaToWhatsApp(localPath);
} else {
// If fully public URL, optionally try sending directly (provider may require public URL)
useLink = imageUrl;
}

// send via WhatsApp Cloud API
const token = process.env.META_TOKEN;
const phoneNumberId = process.env.PHONE_NUMBER_ID;
if (!token || !phoneNumberId) return res.status(500).json({ ok:false, error:'missing META_TOKEN or PHONE_NUMBER_ID' });

const body = {
messaging_product: 'whatsapp',
to: String(to).replace(/\D/g, ''),
type: 'image',
image: mediaId ? { id: mediaId, caption: caption || '' } : { link: useLink, caption: caption || '' }
};

const sendResp = await fetch(`https://graph.facebook.com/v17.0/${phoneNumberId}/messages`, {
method: 'POST',
headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
body: JSON.stringify(body)
});
const jr = await sendResp.json();
if (!sendResp.ok) return res.status(500).json({ ok:false, error: jr });
return res.json({ ok:true, sent:true, resp: jr });
} catch (e) {
console.error('send-image error', e && e.message ? e.message : e);
return res.status(500).json({ ok:false, error: String(e) });
}
});
// === waSendImage helper (WhatsApp Cloud API) ===
async function waSendImage(to, mediaId, caption="") {
  const token = process.env.META_TOKEN;
  const phoneNumberId = process.env.PHONE_NUMBER_ID;
  const url = `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`;

  const payload = {
    messaging_product: "whatsapp",
    to: to,
    type: "image",
    image: { id: mediaId, caption: caption }
  };

  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const j = await r.json();
  return j;
}

// === WhatsApp media helper: download and expose via our server ===
async function getMediaUrl(mediaId) {
  try {
    if (!mediaId) throw new Error("No mediaId provided");

    if (!META_TOKEN) {
      throw new Error("META_TOKEN missing – cannot fetch media");
    }

    const GRAPH_API_BASE = process.env.GRAPH_API_BASE || "https://graph.facebook.com/v21.0";
    const baseUrl = process.env.PUBLIC_BASE_URL || "";

    if (!baseUrl) {
      throw new Error("PUBLIC_BASE_URL not set – cannot expose media URL");
    }

    // 1) First call: get media metadata (URL) from Graph API
    const metaResp = await fetch(`${GRAPH_API_BASE}/${mediaId}`, {
      headers: {
        Authorization: `Bearer ${META_TOKEN}`
      }
    });

    if (!metaResp.ok) {
      const errText = await metaResp.text();
      throw new Error(`Media meta fetch failed: ${metaResp.status} ${errText}`);
    }

    const metaJson = await metaResp.json();
    const waUrl = metaJson.url;
    if (!waUrl) throw new Error("No url field in media meta");

    // 2) Second call: download actual binary from that URL
    const fileResp = await fetch(waUrl, {
      headers: {
        Authorization: `Bearer ${META_TOKEN}`
      }
    });

    if (!fileResp.ok) {
      const errText = await fileResp.text();
      throw new Error(`Media download failed: ${fileResp.status} ${errText}`);
    }

    const contentType = fileResp.headers.get("content-type") || "image/jpeg";
    const arrayBuf = await fileResp.arrayBuffer();
    const buf = Buffer.from(arrayBuf);

    // Decide file extension
    let ext = "jpg";
    if (contentType.includes("png")) ext = "png";
    else if (contentType.includes("jpeg")) ext = "jpg";
    else if (contentType.includes("webp")) ext = "webp";

    // Ensure uploads directory exists
    const uploadsDir = path.join(__dirname, "public", "uploads");
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }

    // Save file locally
    const fileName = `wa_${mediaId}.${ext}`;
    const filePath = path.join(uploadsDir, fileName);
    await fs.promises.writeFile(filePath, buf);

    // Public URL for OpenAI
    const publicUrl = `${baseUrl}/uploads/${fileName}`;
    if (DEBUG) console.log("getMediaUrl: stored media at", publicUrl);

    return publicUrl;
  } catch (err) {
    console.warn("getMediaUrl failed:", err?.message || err);
    return null;
  }
}

// === Forward existing WhatsApp media to another number ===
async function waForwardImage(to, mediaId, caption = "") {
  const url = `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`;

  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "image",
    image: {
      id: mediaId,
      caption
    }
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${META_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const data = await resp.json();
  if (DEBUG) console.log("waForwardImage →", JSON.stringify(data));
  return data;
}


// === uploadMediaToWhatsApp: upload a local file to WhatsApp Cloud and return media_id ===
async function uploadMediaToWhatsApp(localPath) {
  try {
    const token = process.env.META_TOKEN || process.env.WA_TOKEN || process.env.META_ACCESS_TOKEN;
    const phoneNumberId = (process.env.PHONE_NUMBER_ID || process.env.WA_PHONE_NUMBER_ID || "").trim();
    if (!token || !phoneNumberId) throw new Error('Missing META_TOKEN or PHONE_NUMBER_ID');

    // resolve local file path (accept "/uploads/xxx" or "uploads/xxx" or "public/uploads/xxx")
    const rel = String(localPath).replace(/^\/+/, '');
    let fullPath = path.resolve(__dirname, rel);
    if (!fs.existsSync(fullPath)) {
      // try under public/
      fullPath = path.resolve(__dirname, 'public', rel);
    }
    if (!fs.existsSync(fullPath)) throw new Error('Local file not found: ' + fullPath);

    const form = new FormData();
    form.append('file', fs.createReadStream(fullPath));
    form.append('messaging_product', 'whatsapp');

    const resp = await fetch(`https://graph.facebook.com/v17.0/${phoneNumberId}/media`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, ...form.getHeaders() },
      body: form
    });

    const j = await resp.json().catch(() => null);
    if (!resp.ok) {
      throw new Error('Upload failed: ' + JSON.stringify(j));
    }
    // usually { id: "..." }
    return j && (j.id || j.media || j) ;
  } catch (e) {
    console.error('uploadMediaToWhatsApp error', e && e.message ? e.message : e);
    throw e;
  }
}

app.post('/send-image', async (req, res) => {
  try {
    const { to, file, caption } = req.body;
    if (!to || !file) return res.json({ ok:false, error:"Missing to/file" });

    const localPath = path.join(__dirname, 'public/uploads', file);

    if (!fs.existsSync(localPath)) {
      return res.json({ ok:false, error:"File not found in uploads/" });
    }

    const uploaded = await uploadMediaToWhatsApp(localPath);
    const mediaId = uploaded.id;

    if (!mediaId) return res.json({ ok:false, error:"Upload failed", uploaded });

    const sent = await waSendImage(to, mediaId, caption || "");

    res.json({ ok:true, mediaId, sent });
  }
  catch (e) {
    console.error("send-image error:", e);
    res.json({ ok:false, error:String(e) });
  }
});
// ============================================================================
//  Sheet broadcast helpers (do NOT affect normal "Hi" → Namaste flow)
// ============================================================================

// simple CSV parser for your contact sheet (no commas inside fields)
function parseCsvFromContactSheet(text) {
  const lines = String(text || '').trim().split(/\r?\n/);
  if (!lines.length) return [];

  const header = lines[0].split(',').map(h => h.trim().toLowerCase());
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw) continue;

    const parts = raw.split(',');
    const row = {};

    header.forEach((key, idx) => {
      row[key] = (parts[idx] || '').trim();
    });

    rows.push(row);
  }

  return rows;
}

// read contacts from the Google Sheet defined in CONTACT_SHEET_CSV_URL
async function fetchContactsFromSheet() {
  if (!CONTACT_SHEET_CSV_URL) {
    throw new Error('CONTACT_SHEET_CSV_URL is not set in .env');
  }

  if (DEBUG) console.log('Sheet broadcast: fetching contacts from', CONTACT_SHEET_CSV_URL);

  const resp = await fetch(CONTACT_SHEET_CSV_URL);
  if (!resp.ok) {
    throw new Error(`Sheet fetch failed: ${resp.status} ${resp.statusText}`);
  }

  const text = await resp.text();
  const rawRows = parseCsvFromContactSheet(text);

  const contacts = rawRows
    .map(row => {
      const name = row['name'] || row['Name'] || 'UNKNOWN';
      const phone = row['phone'] || row['Phone'] || '';
      const city = row['city'] || row['City'] || '';
      const leadFrom = row['lead from'] || row['lead_from'] || '';
      const customerType = row['customer type'] || row['customer_type'] || '';

      if (!phone) return null;

      return { name, phone, city, leadFrom, customerType };
    })
    .filter(Boolean);

  if (DEBUG) console.log(`Sheet broadcast: parsed ${contacts.length} contacts from sheet`);
  return contacts;
}

// ---------------- SHEET BROADCAST SENDER ----------------
// ORDER = 1) TEMPLATE FIRST  2) POSTER IMAGE SECOND

async function sendSheetWelcomeTemplate_OLD(to, name = "Customer") {
  if (!META_TOKEN || !PHONE_NUMBER_ID) {
    throw new Error("META_TOKEN or PHONE_NUMBER_ID not set");
  }

  const displayName = name || "Customer";

  // 1️⃣ TEMPLATE FIRST
  console.log(`Broadcast: sending template to ${to}`);

  const components = [
    {
      type: "body",
      parameters: [
        { type: "text", text: displayName }
      ]
    }
  ];

  const t = await waSendTemplate(
    to,
    BROADCAST_TEMPLATE_NAME,     // must be mr_car_broadcast_en from .env
    components
  );

  if (!t.ok) {
    console.warn(
      "WA sheet-broadcast error (template send):",
      to,
      t.error
    );
    return false;
  }

  console.log("Template sent OK:", to);

  // 2️⃣ POSTER IMAGE SECOND
  const posterUrl = "https://whatsapp-gpt-crm.onrender.com/uploads/mrcar_poster.png";

  try {
    console.log(`Broadcast: sending poster image to ${to} via ${posterUrl}`);
    if (!img.ok) {
      console.warn("Poster image failed for:", to, img.error);
    } else {
      console.log("🖼 Poster send attempted for:", to);
    }
  } catch (e) {
    console.warn("Poster image exception for", to, e?.message || e);
  }

  return true;
}

// --------------------------------------------------------------------------
//  POST /tools/send-greeting-from-sheet
//  - Reads Google Sheet
//  - Sends mr_car_broadcast_en + poster to each valid phone
//  - DOES NOT change normal webhook flow
// --------------------------------------------------------------------------
app.post('/tools/send-greeting-from-sheet', async (req, res) => {
  try {
    console.log("🔥 GREETING ROUTE HIT");
    console.log("CONTACT_SHEET_CSV_URL =", CONTACT_SHEET_CSV_URL);
    console.log("CONTACT_POSTER_URL =", CONTACT_POSTER_URL);

    if (!CONTACT_SHEET_CSV_URL) {
  return res.status(500).json({ ok: false, error: 'CONTACT_SHEET_CSV_URL missing in env' });
}
if (!CONTACT_POSTER_URL && DEBUG) {
  console.warn('Sheet broadcast: CONTACT_POSTER_URL missing, will send text-only template.');
}
    const contacts = await fetchContactsFromSheet();
    console.log("📄 Contacts fetched:", contacts.length);
// basic filter: Indian mobile numbers starting with 91 and at least 10 digits
const targets = contacts.filter(c => {
  const p = String(c.phone || '').replace(/\s+/g, '');
  return p && p.startsWith('91') && p.length >= 10;
});

console.log("🎯 Valid targets:", targets.length);
if (DEBUG) console.log(`Sheet broadcast: will send to ${targets.length} contacts`);

let sent = 0;
const failed = [];

for (const c of targets) {
  const phone = String(c.phone || '').replace(/\s+/g, '');
  const name = c.name || 'Customer';

  console.log("Sheet broadcast → sending to:", phone, "Name:", name);

  // 1) Try sending poster image (NO TEMPLATE HERE)
  if (CONTACT_POSTER_URL) {
    try {
      const caption =
        'Hello ' + name + ', 👋\n' +
        'Welcome to Mr.Car! 🚗✨\n' +
        'We are at your service. Just say "Hi" to get started.';

      console.log("🖼 Poster send attempted for:", phone);
    } catch (err) {
      console.warn(
        "WA sheet-broadcast error (poster image):",
        phone,
        err && err.message ? err.message : err
      );
      // we don’t mark as failed here, text template send will still try
    }
  }

  // 2) Send text template (mr_car_broadcast_en) with 1 param = name
  try {
    const ok = await sendSheetWelcomeTemplate(phone, name);

    if (ok) {
      sent++;
    } else {
      failed.push(phone);
    }
  } catch (err) {
    console.warn(
      "WA sheet-broadcast error (template send):",
      phone,
      err && err.message ? err.message : err
    );
    failed.push(phone);
  }

  // 0.8s pause between messages
  await delay(800);
}

if (DEBUG) console.log(`Sheet broadcast: done. Sent=${sent}, Failed=${failed.length}`);

console.log("🏁 GREETING BROADCAST FINISHED — Sent:", sent, "Failed:", failed.length);

return res.json({
  ok: true,
  total: targets.length,
  sent,
  failed: failed.length,
  failedPhones: failed
});

  } catch (err) {
    console.error('Sheet broadcast route failed:', err);
    return res.status(500).json({
      ok: false,
      error: err && err.message ? err.message : String(err)
    });
  }
});

// --------------------------------------------------------------------------
//  Simple UI for "Send Greeting" broadcast
//  URL: GET /tools/send-greeting-ui
//  Shows a single button that calls POST /tools/send-greeting-from-sheet
// --------------------------------------------------------------------------
app.get('/tools/send-greeting-ui', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Send Greeting • Mr.Car CRM</title>
  <style>
    body { font-family: system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; background:#0b1020; color:#f5f5f5; display:flex; align-items:center; justify-content:center; height:100vh; margin:0; }
    .card { background:#11162a; padding:24px 28px; border-radius:16px; box-shadow:0 18px 45px rgba(0,0,0,0.45); max-width:420px; width:100%; }
    h1 { font-size:20px; margin:0 0 8px 0; }
    p { font-size:14px; margin:4px 0 12px 0; color:#c0c4d0; }
    button { background:#2563eb; color:white; border:none; border-radius:999px; padding:10px 20px; font-size:14px; cursor:pointer; display:inline-flex; align-items:center; gap:8px; }
    button[disabled] { opacity:0.6; cursor:default; }
    small { display:block; font-size:11px; color:#9ca3af; margin-top:8px; }
    #status { margin-top:10px; font-size:13px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Send Greeting to Sheet Contacts</h1>
    <p>This will send the <strong>Namaste + poster</strong> template to all valid phone numbers in the Google Sheet.</p>
    <button id="sendBtn">
      <span>🚀 Send Greeting</span>
    </button>
    <small>Uses /tools/send-greeting-from-sheet on this server.</small>
    <div id="status">Idle.</div>
  </div>

  <script>
    (function () {
      const btn = document.getElementById('sendBtn');
      const status = document.getElementById('status');

      btn.addEventListener('click', async () => {
        const ok = window.confirm('Send Namaste greeting + poster to ALL contacts from Google Sheet now?');
        if (!ok) return;

        btn.disabled = true;
        const original = btn.textContent;
        btn.textContent = 'Sending...';
        status.textContent = 'Broadcast in progress...';

        try {
          const resp = await fetch('/tools/send-greeting-from-sheet', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
          });

          if (!resp.ok) {
            const text = await resp.text();
            console.error('Broadcast failed:', resp.status, text);
            alert('Error sending greeting. Check server logs.');
            status.textContent = 'Error sending greeting. Check server logs.';
            return;
          }

          const data = await resp.json();
          console.log('Broadcast result:', data);
          const msg = 'Greeting sent: ' + data.sent + '/' + data.total + ' delivered, ' + data.failed + ' failed.';
          alert(msg);
          status.textContent = msg;
        } catch (e) {
          console.error('Exception:', e);
          alert('Unexpected error. Check console/server logs.');
          status.textContent = 'Unexpected error. See logs.';
        } finally {
          btn.disabled = false;
          btn.textContent = original;
        }
      });
    })();
  </script>
</body>
</html>`);
});
// === WA delivery status log download ===
app.get('/api/wa-delivery-log', (req, res) => {
  const fs = require('fs');
  const path = require('path');
  const logPath = path.join(__dirname, '.crm_data', 'wa_status_log.json');

  if (!fs.existsSync(logPath)) {
    return res.json({ ok: false, error: "No log file found" });
  }

  const data = fs.readFileSync(logPath, 'utf8');
  res.setHeader('Content-Type', 'application/json');
  res.send(data);
});
// ==== DASHBOARD STATIC ROUTES (RESTORE) ====
app.use('/dashboard', express.static(path.join(__dirname, 'public', 'dashboard')));

app.get('/dashboard', (req, res) => {
  return res.sendFile(path.join(__dirname, 'public', 'dashboard', 'index.html'));
});

// Catch-all for internal dashboard routes
app.get(/^\/dashboard(?:\/.*)?$/, (req, res) => {
  return res.sendFile(path.join(__dirname, 'public', 'dashboard', 'index.html'));
});

app.listen(PORT, () => {
console.log("🟢 Server fully started — READY to receive greeting UI and webhook events");
  console.log('==== MR.CAR BUILD TAG: 2025-11-25-NEWCAR-ADVISORY-FIX ====');
  console.log(`✅ MR.CAR webhook CRM server running on port ${PORT}`);
  console.log('ENV summary:', {
    SHEET_TOYOTA_CSV_URL: !!SHEET_TOYOTA_CSV_URL,
    SHEET_USED_CSV_URL: !!SHEET_USED_CSV_URL || fs.existsSync(LOCAL_USED_CSV_PATH),
    PHONE_NUMBER_ID: !!PHONE_NUMBER_ID,
    META_TOKEN: !!META_TOKEN,
    ADMIN_WA: !!ADMIN_WA,
    DEBUG
  });
});

//    Uses existing LEADS_FILE and safeJsonRead helper.
if (!app._leads_compat_installed) {
  app.get('/leads', (req, res) => {
    try {
      const raw = safeJsonRead(LEADS_FILE) || {};
      // older backups stored { leads: [...] } or plain array
      let leads = [];
      if (Array.isArray(raw)) leads = raw;
      else if (Array.isArray(raw.leads)) leads = raw.leads;
      else if (raw && raw.leads && Array.isArray(raw.leads)) leads = raw.leads;
      res.json(leads);
    } catch (e) {
      console.error('GET /leads error', e && e.message ? e.message : e);
      res.json([]);
    }
  });
  app._leads_compat_installed = true;
}

/* --- test route: verify Express can serve the dashboard index.html --- */
try {
  if (typeof app !== 'undefined' && typeof path !== 'undefined') {
    app.get('/test-dashboard', (req, res) => {
      try {
        return res.sendFile(path.join(__dirname, 'public', 'dashboard', 'index.html'));
      } catch (e) {
        console.error('test-dashboard sendFile error', e && e.message ? e.message : e);
        return res.status(500).send('internal');
      }
    });
  } else {
    console.warn('Skipping /test-dashboard route: app or path not defined');
  }
} catch (e) {
  console.error('Failed to install /test-dashboard route', e && e.message ? e.message : e);
}

/* APPEND: SPA catch-all for /dashboard and subpaths (safe) */
app.get(/^\/dashboard(?:\/.*)?$/, (req, res) => {
  try {
    return res.sendFile(path.join(__dirname, 'public', 'dashboard', 'index.html'));
  } catch (e) {
    console.error('sendFile error for /dashboard', e && e.message ? e.message : e);
    return res.status(500).send('internal');
  }
});
/* end APPEND */

// EXPORT_CSV_ENDPOINT_MARKER
// Minimal CSV export/import endpoints added for local dashboard export/import.
const csvStringifyLocal = (rows) => rows.map(r => r.map(c => '"' + String(c||'').replace(/"/g,'""') + '"').join(',')).join('\n');

try {
  const multer = require('multer');
  const upload = multer({ storage: multer.memoryStorage() });

  app.get('/api/leads/export-csv', async (req, res) => {
    try {
      let leads = [];
      if (typeof getLeadsFromDbOrCache === 'function') {
        leads = await getLeadsFromDbOrCache();
      } else if (typeof db !== 'undefined' && db.collection) {
        // try common fallback (may or may not apply)
        try { leads = await db.collection('leads').find().toArray(); } catch(e) {}
      }
      const rows = [['ID','Name','Phone','Status','Timestamp'], ...(leads||[]).map(l => [l.id||l._id||'', l.name||'', l.phone||'', l.status||'', l.timestamp||''])];
      const csv = csvStringifyLocal(rows);
      res.setHeader('Content-Type','text/csv');
      res.setHeader('Content-Disposition','attachment; filename="leads.csv"');
      return res.send(csv);
    } catch(err) {
      console.error('export-csv err', err);
      return res.status(500).send('export failed');
    }
  });

  app.post('/api/leads/import-csv', upload.single('file'), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ ok:false, error: 'no file uploaded' });
      const csv = req.file.buffer.toString('utf8');
      // naive CSV split (works for simple CSVs with quoted values)
      const rows = csv.split(/\r?\n/).filter(Boolean).map(line => {
        // split on commas not inside quotes (simple)
        return line.match(/(?:\"([^\"]*(?:\"\"[^\"]*)*)\")|([^,]+)/g).map(cell => (cell||'').replace(/^"|"$/g,'').replace(/""/g,'"'));
      });
      const header = rows.shift().map(h => h.toString().trim().toLowerCase());
      const docs = rows.map(r => {
        const obj = {};
        for (let i=0;i<header.length;i++) obj[header[i]] = (r[i]||'').toString().trim();
        return obj;
      });
      console.log('imported rows', docs.length);
      // TODO: plug into your ingest/save pipeline (e.g., await ingestLeads(docs))
      return res.json({ ok:true, imported: docs.length });
    } catch(e){
      console.error('import-csv err', e);
      return res.status(500).json({ ok:false, error: e.message });
    }
  });
} catch(e) {
  console.error('CSV endpoints setup error', e);
}
// MRCAR_API_LEADS_ENDPOINT_MARKER
try {
  app.get('/api/leads', async (req, res) => {
    try {
      const q = (req.query.q||'').toString().trim();
      const leadType = (req.query.lead_type||'').toString().trim().toLowerCase();
      let leads = [];
      if (typeof getLeadsFromDbOrCache === 'function') {
        try { leads = await getLeadsFromDbOrCache(); } catch(e) { console.error('getLeadsFromDbOrCache err', e); leads = []; }
      } else if (Array.isArray(globalThis.leads)) {
        leads = globalThis.leads;
      } else {
        leads = [];
      }
      leads = (leads||[]).map(l => ({
        id: l.id||l.ID||'', name: l.name||l.Name||'', phone: l.phone||l.Phone||'',
        status: l.status||l.Status||'', timestamp: l.timestamp||l.Timestamp||'',
        car_enquired: l.car_enquired||l.car||l.variant||'',
        budget: l.budget||l.Budget||'', last_ai_reply: l.last_ai_reply||'',
        ai_quote: l.ai_quote||'', _raw:l
      }))
      if (q) {
        const ql = q.toLowerCase();
        leads = leads.filter(x => ((x.id||'') + (x.name||'') + (x.phone||'') + (x.car_enquired||'')).toLowerCase().includes(ql));
      }
      if (leadType) {
        const lt = leadType;
        leads = leads.filter(x => (x.status||'').toLowerCase().includes(lt) || (x.car_enquired||'').toLowerCase().includes(lt));
      }
      return res.json({ ok:true, leads });
    } catch(e) {
      return res.status(500).json({ ok:false, error: e.message||String(e) });
    }
  });
  console.log('MRCAR: /api/leads endpoint installed (normalizes extra fields)');
} catch(e) {
  console.error('MRCAR: failed to install /api/leads endpoint', e);
}



// MRCAR_LEADS_DEBUG_MARKER
// Diagnostic endpoint to inspect possible lead sources and sample items
try {
  app.get('/api/leads/debug-sources', async (req, res) => {
    try {
      const out = { ok:true, found: {} };

      // helper to safe call functions
      async function tryFn(fn) {
        try {
          const v = await fn();
          return { ok:true, sample: Array.isArray(v) ? v.slice(0,3) : v };
        } catch(e) {
          return { ok:false, error: String(e) };
        }
      }

      // 1) getLeadsFromDbOrCache
      out.found.getLeadsFromDbOrCache = (typeof getLeadsFromDbOrCache === 'function') ? 'function' : 'none';
      if (typeof getLeadsFromDbOrCache === 'function') {
        out.getLeadsFromDbOrCache = await tryFn(() => getLeadsFromDbOrCache());
        out.getLeadsFromDbOrCache_count = Array.isArray(out.getLeadsFromDbOrCache.sample) ? out.getLeadsFromDbOrCache.sample.length : (out.getLeadsFromDbOrCache.sample ? 1 : 0);
      }

      // 2) db.collection('leads')
      out.found.db = (typeof db !== 'undefined' && db && db.collection) ? 'db-collection-available' : 'no-db';
      if (typeof db !== 'undefined' && db && db.collection) {
        try {
          const c = db.collection('leads');
          const sample = await c.find().limit(3).toArray().catch(e=>{throw e});
          out.db_collection_sample = sample;
          out.db_collection_count_guess = (Array.isArray(sample) ? sample.length : 0);
        } catch(e) {
          out.db_collection_error = String(e);
        }
      }

      // 3) global caches / common names
      const tries = ['globalLeadsCache','leadsCache','leadsList','leads','globalThis.leads'];
      out.found.globals = {};
      for (const k of tries) {
        try {
          let val = undefined;
          if (k === 'globalThis.leads') val = globalThis.leads;
          else if (typeof globalThis[k] !== 'undefined') val = globalThis[k];
          else if (typeof eval("typeof " + k + " !== 'undefined' && " + k) !== 'undefined') {
            // not reliable; skip
          }
          out.found.globals[k] = Array.isArray(val) ? ('array:' + val.length) : (val ? 'present' : 'none');
          if (Array.isArray(val)) out[k + '_sample'] = val.slice(0,3);
        } catch(e) {
          out.found.globals[k] = 'error';
          out[k + '_error'] = String(e);
        }
      }

      // 4) try to find a function that looks like "loadLeads" or "refreshLeads"
      const candidates = ['loadLeads','refreshLeads','fetchLeads','getAllLeads'];
      out.found.candidates = {};
      for (const fn of candidates) {
        out.found.candidates[fn] = (typeof globalThis[fn] === 'function') ? 'function' : 'none';
      }

      // 5) include a small portion of server.cjs where "leads" appears to help quick grep
      try {
        const fs = require('fs');
        const path = require('path');
        const serverText = fs.readFileSync(path.join(__dirname,'server.cjs'),'utf8');
        // return lines with "leads" (first 40 matches) to help debugging
        const lines = serverText.split(/\\r?\\n/).map((l,i)=>({i:i+1,l}));
        const matches = lines.filter(x => /\\bleads\\b/i.test(x.l)).slice(0,40).map(x => x.i + ':' + x.l);
        out.server_leads_lines = matches;
      } catch(e) {
        out.server_leads_lines_error = String(e);
      }

      return res.json(out);
    } catch(e) {
      console.error('leads debug endpoint error', e);
      return res.status(500).json({ ok:false, error: String(e) });
    }
  });
  console.log('MRCAR: /api/leads/debug-sources endpoint installed');
} catch(e){
  console.error('MRCAR: failed to install leads debug endpoint', e);
}


// MRCAR_GETALL_LEADS_MARKER
// Route to fetch leads using getAllLeads() and normalize for dashboard quickly
try {
  app.get('/api/leads/from-getall', async (req, res) => {
    try {
      if (typeof getAllLeads !== 'function') return res.status(404).json({ ok:false, error: 'getAllLeads not present' });

      // call getAllLeads — handle sync or promise-returning functions
      let raw;
      try {
        raw = await Promise.resolve(getAllLeads());
      } catch (e1) {
        // sometimes functions expect options object — try with empty object
        try { raw = await Promise.resolve(getAllLeads({})); } catch(e2) { throw e1; }
      }

      // ensure array
      const arr = Array.isArray(raw) ? raw : (raw && raw.items && Array.isArray(raw.items) ? raw.items : []);
      const leads = (arr || []).map(l => {
        return {
          id: l.id || l._id || l.ID || '',
          name: l.name || l.Name || l.customerName || l.cust_name || '',
          phone: l.phone || l.Phone || l.mobile || l.Mobile || '',
          status: l.status || l.Status || '',
          timestamp: l.timestamp || l.Timestamp || l.ts || l._created || '',
          car_enquired: l.car_enquired || l.car || l.variant || l['Car Enquired'] || l['car_enquired'] || '',
          budget: l.budget || l.Budget || l.expected_budget || l['Budget'] || '',
          last_ai_reply: l.last_ai_reply || l.last_ai || l['Last AI Reply'] || '',
          ai_quote: l.ai_quote || l.quote || l['AI Quote'] || '',
          _raw: l
        };
      });

      return res.json({ ok:true, count: leads.length, leads: leads.slice(0, 30) });
    } catch (e) {
      console.error('MRCAR /api/leads/from-getall error', e);
      return res.status(500).json({ ok:false, error: String(e) });
    }
  });
  console.log('MRCAR: /api/leads/from-getall route installed');
} catch(e){
  console.error('MRCAR: failed to install /api/leads/from-getall', e);
}


// MRCAR_INGEST_FROM_SHEETS_MARKER
// Ingest leads from /api/sheets/export, normalize and populate globalThis.leads
try {
  app.post('/api/leads/ingest-from-sheets', async (req, res) => {
    try {
      // attempt to fetch rows from internal export logic
      let sheetResp;
      // prefer calling internal function if available
      if (typeof exports !== 'undefined' && exports && typeof exports.exportSheets === 'function') {
        sheetResp = await Promise.resolve(exports.exportSheets(req.body || {}));
      } else if (typeof fetch === 'function') {
        const url = (req.protocol ? (req.protocol + '://') : '') + (req.get ? req.get('host') : ('localhost:3000')) + '/api/sheets/export';
        // If internal host not resolvable, fallback to localhost
        const internalUrl = 'http://localhost:10000/api/sheets/export';
        const fresp = await fetch(internalUrl, { method: 'POST', headers: { 'content-type':'application/json' }, body: JSON.stringify(req.body || {}) }).catch(e=>null);
        sheetResp = fresp ? await fresp.json().catch(e=>null) : null;
      } else {
        return res.status(500).json({ ok:false, error:'No internal fetch available to call sheets export' });
      }

      if (!sheetResp || !sheetResp.ok) {
        return res.status(500).json({ ok:false, error: sheetResp && sheetResp.error ? sheetResp.error : 'sheets export failed or returned no rows' });
      }

      // sheetResp may contain .rows (csv-parsed) or .exported rows depending on implementation
      // Try common places
      const rawRows = sheetResp.rows || sheetResp.data || sheetResp.values || sheetResp.items || (sheetResp.exported ? sheetResp.rows : null) || null;
      // If no rows found but updatedRange present, try calling /api/sheets/export with fallback reading
      if (!rawRows || !Array.isArray(rawRows)) {
        // some implementations return CSV text as "csv" or "content"
        if (Array.isArray(sheetResp.rows)) {
          // leave as is
        } else if (Array.isArray(sheetResp.values)) {
          // already set
        } else {
          // Can't find rows array -> return debug text
          return res.status(500).json({ ok:false, error: 'unexpected sheets export format', sheetResp });
        }
      }

      // Normalize header+rows -> array of objects
      // if first row looks like header row (array of strings)
      let objs = [];
      if (Array.isArray(rawRows) && rawRows.length > 0 && Array.isArray(rawRows[0])) {
        const header = rawRows[0].map(h => String(h||'').trim());
        const rows = rawRows.slice(1);
        objs = rows.map(r => {
          const obj = {};
          for (let i=0;i<header.length;i++) {
            const key = header[i] ? header[i].toString().trim() : ('col'+i);
            obj[key] = r[i] !== undefined ? r[i] : '';
          }
          return obj;
        });
      } else if (Array.isArray(rawRows) && rawRows.length > 0 && typeof rawRows[0] === 'object') {
        objs = rawRows;
      }

      // Normalization: map likely column names to expected keys
      const normalized = (objs||[]).map(l => {
        const get = (names) => {
          for (const n of names) {
            if (Object.prototype.hasOwnProperty.call(l, n)) return l[n];
            // try lowercased keys
            const k = Object.keys(l).find(x => x && x.toLowerCase() === (n||'').toLowerCase());
            if (k) return l[k];
          }
          return '';
        };
        return {
          id: get(['ID','Id','id']) || get(['phone','Phone']) || '',
          name: get(['Name','name','Customer','customerName']) || '',
          phone: get(['Phone','phone','Mobile','mobile','Contact']) || '',
          status: get(['Status','status']) || '',
          timestamp: get(['Timestamp','timestamp','ts','created_at']) || '',
          car_enquired: get(['Car Enquired','Car','car_enquired','car_enquired','carEnquired','Variant','variant']) || '',
          budget: get(['Budget','budget','Expected Budget','expected_budget']) || '',
          last_ai_reply: get(['Last AI Reply','Last AI','last_ai_reply','lastAiReply']) || '',
          ai_quote: get(['AI Quote','ai_quote','Quote','quote']) || '',
          _raw: l
        };
      });

      // set into globalThis.leads so existing /api/leads uses it
      globalThis.leads = normalized;

      return res.json({ ok:true, imported: normalized.length, sample: normalized.slice(0,10) });
    } catch (e) {
      console.error('ingest-from-sheets error', e);
      return res.status(500).json({ ok:false, error: String(e) });
    }
  });
  console.log('MRCAR: /api/leads/ingest-from-sheets route installed');
} catch(e) {
  console.error('MRCAR: failed to install ingest-from-sheets route', e);
}


// MRCAR_INGEST_FROM_SHEETS_ROBUST_MARKER
// Robust ingest: if sheets export returns metadata only, fetch CSV (SHEET_TOYOTA_CSV_URL or built from GOOGLE_SHEET_ID)
try {
  app.post('/api/leads/ingest-from-sheets-robust', async (req, res) => {
    try {
      const fetchJson = async () => {
        // call internal sheets export endpoint
        try {
          const resp = await (typeof fetch === 'function' ? fetch('http://localhost:10000/api/sheets/export', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(req.body||{}) }) : null);
          if (!resp) return null;
          try { return await resp.json(); } catch(e) { return { ok:false, error:'invalid-json-from-sheets-export' }; }
        } catch(e) { return null; }
      };

      let sheetResp = await fetchJson();
      if (!sheetResp) {
        return res.status(500).json({ ok:false, error:'failed to call /api/sheets/export internally' });
      }

      // If sheetResp looks like it already had rows, reuse that logic
      if (Array.isArray(sheetResp.rows) && sheetResp.rows.length) {
        // let existing logic in ingest-from-sheets handle it if desired; here we will reuse that structure
        // convert to normalized objects below
      } else {
        // fallback: try to fetch CSV
        const env = process.env || {};
        let csvUrl = env.SHEET_TOYOTA_CSV_URL || env.SHEET_CSV_URL || '';
        if (!csvUrl && env.GOOGLE_SHEET_ID) {
          const gid = (sheetResp.updatedRange && /gid=(\\d+)/.test(sheetResp.updatedRange)) ? RegExp.$1 : '0';
          csvUrl = `https://docs.google.com/spreadsheets/d/${env.GOOGLE_SHEET_ID}/export?format=csv&gid=${gid}`;
        }
        if (!csvUrl) {
          return res.status(500).json({ ok:false, error:'no CSV url available (set SHEET_TOYOTA_CSV_URL or GOOGLE_SHEET_ID)' , sheetResp});
        }

        // fetch CSV
        let csvText = '';
        try {
          const resp2 = await (typeof fetch === 'function' ? fetch(csvUrl) : null);
          if (!resp2 || !resp2.ok) {
            // try node http fallback using native https
            const https = require('https');
            csvText = await new Promise((resolve, reject) => {
              let data = '';
              https.get(csvUrl, (r) => {
                r.on('data', chunk => data += chunk);
                r.on('end', () => resolve(data));
                r.on('error', reject);
              }).on('error', reject);
            }).catch(e=>null);
          } else {
            csvText = await resp2.text();
          }
        } catch(e) {
          return res.status(500).json({ ok:false, error:'failed to fetch sheet csv', e: String(e), csvUrl });
        }

        if (!csvText) return res.status(500).json({ ok:false, error:'empty csv fetched', csvUrl });

        // minimal CSV parse (handles quoted fields)
        const parseCSV = (text) => {
          const rows = [];
          let cur = '';
          let row = [];
          let inQuotes = false;
          for (let i=0;i<text.length;i++) {
            const ch = text[i];
            const next = text[i+1];
            if (ch === '"' ) {
              if (inQuotes && next === '"') { cur += '"'; i++; continue; } // escaped quote
              inQuotes = !inQuotes;
              continue;
            }
            if (ch === ',' && !inQuotes) { row.push(cur); cur=''; continue; }
            if ((ch === '\\n' || ch === '\\r') && !inQuotes) {
              // handle CRLF
              if (ch === '\\r' && text[i+1] === '\\n') { i++; }
              row.push(cur); rows.push(row); row=[]; cur=''; continue;
            }
            cur += ch;
          }
          // flush last
          if (cur !== '' || row.length) {
            row.push(cur);
            rows.push(row);
          }
          return rows.filter(r => r.length>1 || (r.length===1 && String(r[0]||'').trim()!==''));
        };

        const rows = parseCSV(csvText);
        // first row header?
        let objs = [];
        if (rows.length > 0 && rows[0].every(c => String(c||'').trim() !== '')) {
          const header = rows[0].map(h => String(h||'').trim());
          const dataRows = rows.slice(1);
          objs = dataRows.map(r => {
            const o = {};
            for (let i=0;i<header.length;i++) o[header[i]||('col'+i)] = r[i] !== undefined ? r[i] : '';
            return o;
          });
        } else {
          objs = rows.map(r => {
            const o = {};
            r.forEach((c,i)=>o['col'+i]=c);
            return o;
          });
        }

        // normalize (case-insensitive key matches)
        const normalized = objs.map(l => {
          const keys = Object.keys(l||{});
          const find = (names) => {
            for (const n of names) {
              const k = keys.find(x => x && x.toLowerCase() === (n||'').toLowerCase());
              if (k) return l[k];
            }
            return '';
          };
          return {
            id: find(['ID','Id','id']) || find(['Phone','phone']) || '',
            name: find(['Name','name','Customer','customerName']) || '',
            phone: find(['Phone','phone','Mobile','mobile','Contact']) || '',
            status: find(['Status','status']) || '',
            timestamp: find(['Timestamp','timestamp','ts','created_at']) || '',
            car_enquired: find(['Car Enquired','Car','car_enquired','Variant','variant']) || '',
            budget: find(['Budget','budget','Expected Budget','expected_budget']) || '',
            last_ai_reply: find(['Last AI Reply','Last AI','last_ai_reply','lastAiReply']) || '',
            ai_quote: find(['AI Quote','ai_quote','Quote','quote']) || '',
            _raw: l
          };
        });

        globalThis.leads = normalized;
        return res.json({ ok:true, imported: normalized.length, sample: normalized.slice(0,10), csvUrl });
      }

      // If we reach here, sheetResp already contained rows (not typical for your setup),
      // attempt to transform them similarly (left as fallback)
      const rawRows = sheetResp.rows || sheetResp.values || sheetResp.data || [];
      // Normalize header->objects if first row is header array
      let objs = [];
      if (Array.isArray(rawRows) && rawRows.length && Array.isArray(rawRows[0])) {
        const header = rawRows[0].map(h => String(h||'').trim());
        const dataRows = rawRows.slice(1);
        objs = dataRows.map(r => {
          const o = {};
          for (let i=0;i<header.length;i++) o[header[i]||('col'+i)] = r[i] !== undefined ? r[i] : '';
          return o;
        });
      } else if (Array.isArray(rawRows) && rawRows.length && typeof rawRows[0] === 'object') {
        objs = rawRows;
      }
      const normalized = objs.map(l => {
        const keys = Object.keys(l||{});
        const find = (names) => {
          for (const n of names) {
            const k = keys.find(x => x && x.toLowerCase() === (n||'').toLowerCase());
            if (k) return l[k];
          }
          return '';
        };
        return {
          id: find(['ID','Id','id']) || find(['Phone','phone']) || '',
          name: find(['Name','name','Customer','customerName']) || '',
          phone: find(['Phone','phone','Mobile','mobile','Contact']) || '',
          status: find(['Status','status']) || '',
          timestamp: find(['Timestamp','timestamp','ts','created_at']) || '',
          car_enquired: find(['Car Enquired','Car','car_enquired','Variant','variant']) || '',
          budget: find(['Budget','budget','Expected Budget','expected_budget']) || '',
          last_ai_reply: find(['Last AI Reply','Last AI','last_ai_reply','lastAiReply']) || '',
          ai_quote: find(['AI Quote','ai_quote','Quote','quote']) || '',
          _raw: l
        };
      });
      globalThis.leads = normalized;
      return res.json({ ok:true, imported: normalized.length, sample: normalized.slice(0,10) });
    } catch(e) {
      console.error('ingest-from-sheets-robust error', e);
      return res.status(500).json({ ok:false, error: String(e) });
    }
  });
  console.log('MRCAR: /api/leads/ingest-from-sheets-robust route installed');
} catch(e) {
  console.error('MRCAR: failed to install ingest-from-sheets-robust route', e);
}
