console.log("MR.CAR Webhook Server Booting...");

/* Load .env early so process.env is populated for subsequent reads */
require('dotenv').config({ debug: false });

const fs = require('fs');
const path = require('path');
const express = require('express');
const OpenAI = require("openai");

const app = express();

// ==================== ENV ====================
const SIGNATURE_MODEL = process.env.OPENAI_MODEL || process.env.SIGNATURE_BRAIN_MODEL || process.env.SIGNATURE_MODEL || process.env.ENGINE_USED || 'gpt-4o-mini';
console.log("MODEL SELECTED (SIGNATURE_MODEL)=", SIGNATURE_MODEL);

const GREETING_TEMPLATE_NAME = process.env.GREETING_TEMPLATE_NAME || 'mr_car_broadcast_en';
const GREETING_MEDIA_TEMPLATE_NAME = process.env.GREETING_MEDIA_TEMPLATE_NAME || 'mr_car_broadcast_en';
const BROADCAST_TEMPLATE_NAME = process.env.BROADCAST_TEMPLATE_NAME || GREETING_TEMPLATE_NAME;
const WA_TEMPLATE_LANG = process.env.WA_TEMPLATE_LANG || 'en';

console.log('GREETING_TEMPLATE_NAME =', GREETING_TEMPLATE_NAME);
console.log('GREETING_MEDIA_TEMPLATE_NAME =', GREETING_MEDIA_TEMPLATE_NAME);
console.log('BROADCAST_TEMPLATE_NAME =', BROADCAST_TEMPLATE_NAME);
console.log('WA_TEMPLATE_LANG =', WA_TEMPLATE_LANG);

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
const MAX_QUOTE_PER_DAY       = Number(process.env.MAX_QUOTE_PER_DAY || 10);
const QUOTE_LIMIT_FILE        = path.resolve(__dirname, 'quote_limit.json');
const LEADS_FILE              = path.resolve(__dirname, 'crm_leads.json');
const NEW_CAR_ROI             = Number(process.env.NEW_CAR_ROI || 8.10);
const USED_CAR_ROI_VISIBLE    = Number(process.env.USED_CAR_ROI_VISIBLE || 9.99);
const USED_CAR_ROI_INTERNAL   = Number(process.env.USED_CAR_ROI_INTERNAL || 10.0);
const DEBUG = (process.env.DEBUG_VARIANT === 'true') || false;

const GREETING_WINDOW_MINUTES = Number(process.env.GREETING_WINDOW_MINUTES || 5);
const GREETING_WINDOW_MS = GREETING_WINDOW_MINUTES * 60 * 1000;

// ==================== FETCH ====================
const fetch = (global.fetch) ? global.fetch : require('node-fetch');

// ==================== OPENAI ====================
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || process.env.OPENAI_KEY
});

// ==================== GLOBAL MAPS ====================
if (typeof global.lastGreeting === 'undefined') global.lastGreeting = new Map();
const lastGreeting = global.lastGreeting;

if (typeof global.lastAlert === 'undefined') global.lastAlert = new Map();
const lastAlert = global.lastAlert;

if (typeof global.sessionService === 'undefined') global.sessionService = new Map();
const sessionService = global.sessionService;

// ==================== LOAD MODULES ====================
const { getRAG } = require("./rag_loader.cjs");
const { findRelevantChunks } = require("./vector_search.cjs");

// -- Pricing
const pricing = require('./lib/pricing.cjs');
pricing.init({ env: process.env, fetch, fs, path, DEBUG });

// -- Brands
const brands = require('./lib/brands.cjs');

// -- WhatsApp helpers
const wa = require('./lib/whatsapp.cjs');
wa.init({ META_TOKEN, PHONE_NUMBER_ID, ADMIN_WA, DEBUG, fetch });

// -- Advisory / RAG / Vision
const advisory = require('./lib/advisory.cjs');
advisory.init({ openai, SIGNATURE_MODEL, getRAG, findRelevantChunks, DEBUG });

// -- Used cars
const usedCars = require('./lib/usedCars.cjs');
usedCars.init({
  waSendText: wa.waSendText,
  SHEET_USED_CSV_URL,
  USED_CAR_ROI_VISIBLE,
  USED_CAR_ROI_INTERNAL,
  DEBUG
});

// -- Car Search (aggregated used car search across CarWale + CarDekho + dealer sheet)
const carSearch = require('./lib/carSearch.cjs');
carSearch.init({
  fetch,
  loadUsedSheetRows: pricing.loadUsedSheetRows
});

// -- Group Ingest (silent observer for dealer WhatsApp groups)
const groupIngest = require('./lib/groupIngest.cjs');
groupIngest.init({
  openai,
  MUTED_NUMBERS: (process.env.MUTED_NUMBERS || '').trim(),
  DEBUG
});

// ==================== HELPERS (kept in server.cjs — small, wiring-dependent) ====================

// -- File helpers
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

// -- Session service
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

function isLoanContext(from) {
  const svc = (getLastService(from) || '').toLowerCase();
  return svc.includes('loan');
}

// -- Quote limits
function loadQuoteLimits() { return safeJsonRead(QUOTE_LIMIT_FILE) || {}; }
function saveQuoteLimits(obj) { return safeJsonWrite(QUOTE_LIMIT_FILE, obj); }

function canSendQuote(from) {
  try {
    const q = loadQuoteLimits();
    const today = new Date().toISOString().slice(0, 10);
    const rec = q[from] || { date: today, count: 0 };
    if (rec.date !== today) { rec.date = today; rec.count = 0; }
    return rec.count < MAX_QUOTE_PER_DAY;
  } catch (e) { return true; }
}

function incrementQuoteUsage(from) {
  try {
    const q = loadQuoteLimits();
    const today = new Date().toISOString().slice(0, 10);
    const rec = q[from] || { date: today, count: 0 };
    if (rec.date !== today) { rec.date = today; rec.count = 0; }
    rec.count = Number(rec.count || 0) + 1;
    q[from] = rec;
    saveQuoteLimits(q);
    if (DEBUG) console.log('Quote usage', from, rec);
  } catch (e) {
    console.warn('incrementQuoteUsage failed', e && e.message ? e.message : e);
  }
}

// -- CRM leads file helpers
const CRM_LEADS_PATH = path.join(__dirname, 'crm_leads.json');

function loadCrmLeadsSafe() {
  try {
    const raw = fs.readFileSync(CRM_LEADS_PATH, 'utf8');
    const data = JSON.parse(raw);
    if (Array.isArray(data)) return data;
    if (Array.isArray(data.leads)) return data.leads;
    return [];
  } catch (e) {
    if (DEBUG) console.warn('loadCrmLeadsSafe failed:', e && e.message ? e.message : e);
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

function recordDeliveryStatusForPhone(phone, statusPayload) {
  if (!phone) return;
  const leads = loadCrmLeadsSafe();
  const phoneNorm = String(phone).replace(/\s+/g, '');
  let hit = null;
  for (const lead of leads) {
    const lp = String(lead.Phone || lead.phone || '').replace(/\s+/g, '');
    if (!lp) continue;
    if (lp === phoneNorm) { hit = lead; break; }
  }
  if (!hit) {
    hit = {
      ID: phoneNorm, Name: 'UNKNOWN', Phone: phoneNorm,
      Status: 'auto-ingested', Timestamp: new Date().toISOString(),
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
      phone: phoneNorm, status: hit.lastDeliveryStatus,
      code: hit.lastDeliveryCode, reason: hit.lastDeliveryReason
    });
  }
}

// -- Greeting helper
function shouldGreetNow(from, msgText) {
  try {
    if (ADMIN_WA && from === ADMIN_WA) return false;
    const now = Date.now();
    const prev = lastGreeting.get(from) || 0;
    const text = (msgText || '').trim().toLowerCase();
    const looksLikeGreeting =
      /^(hi|hello|hey|namaste|enquiry|inquiry|help|start)\b/.test(text) &&
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

// -- CRM helpers
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

// -- Google Sheet push
async function pushLeadToGoogleSheet(lead) {
  const url = process.env.GOOGLE_SHEET_WEBHOOK_URL;
  if (!url) return;
  try {
    console.log('GSHEET: pushing lead', lead.phone);
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(lead)
    });
    const text = await resp.text();
    if (!resp.ok) console.error('GSHEET: failed', resp.status, text);
    else console.log('GSHEET: success', text);
  } catch (e) {
    console.error('GSHEET: exception', e?.message || e);
  }
}

// -- Auto-ingest
const crmIngestHandler = require('./routes/crm_ingest.cjs');

async function autoIngest(enriched = {}) {
  const portEnv = process.env.PORT || 10000;
  const baseEnv = (process.env.CRM_URL || '').trim();
  let baseUrl = (baseEnv || `http://127.0.0.1:${portEnv}`).replace(/\/+$/, '');
  // Prevent double path: if CRM_URL already ends with /crm/ingest, don't append again
  const url = baseUrl.endsWith('/crm/ingest') ? baseUrl : `${baseUrl}/crm/ingest`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(enriched)
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.warn('AUTO-INGEST: non-OK', res.status, res.statusText, text);
    } else {
      console.log('AUTO-INGEST: posted to', url, 'for', enriched.from || 'UNKNOWN');
    }
  } catch (e) {
    console.warn('AUTO-INGEST: failed', e && e.message ? e.message : e);
  }
}

// -- Greeting template sender
async function sendSheetWelcomeTemplate(phone, name = "Customer") {
  if (!META_TOKEN || !PHONE_NUMBER_ID) throw new Error("META_TOKEN or PHONE_NUMBER_ID not set");
  const displayName = name || "Customer";
  const headerImageLink =
    (CONTACT_POSTER_URL && CONTACT_POSTER_URL.trim()) ||
    "https://whatsapp-gpt-crm.onrender.com/uploads/mrcar_poster.png";
  const components = [
    { type: "header", parameters: [{ type: "image", image: { link: headerImageLink } }] },
    { type: "body", parameters: [{ type: "text", text: displayName }] }
  ];
  console.log(`Broadcast: sending media template to ${phone} with header ${headerImageLink}`);
  const res = await wa.waSendTemplate(phone, BROADCAST_TEMPLATE_NAME, components);
  if (!res.ok) { console.warn("sendSheetWelcomeTemplate failed", phone, res.error); return false; }
  console.log("Greeting template sent OK:", phone);
  return true;
}

// ==================== INIT QUOTE ENGINES ====================
const quotes = require('./lib/quotes.cjs');
quotes.init({
  waSendText: wa.waSendText,
  waSendRaw: wa.waSendRaw,
  sendNewCarButtons: wa.sendNewCarButtons,
  setLastService,
  getLastService,
  incrementQuoteUsage,
  canSendQuote,
  DEBUG,
  NEW_CAR_ROI,
  SIGNATURE_MODEL,
  callSignatureBrain: advisory.callSignatureBrain,
  isAdvisory: advisory.isAdvisory,
  findRelevantBrochures: advisory.findRelevantBrochures,
  loadBrochureIndex: advisory.loadBrochureIndex,
  extractModelsForComparisonFallback: advisory.extractModelsForComparisonFallback,
  findPhonesInBrochures: advisory.findPhonesInBrochures
});

// ==================== EXPRESS MIDDLEWARE ====================
app.use("/crm", require("./routes/crm.cjs"));
app.use(express.json());

app.post('/crm/ingest', async (req, res) => {
  try {
    await crmIngestHandler(req, res);
  } catch (err) {
    console.error('CRM /crm/ingest error:', err && err.message ? err.message : err);
    if (!res.headersSent) res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

app.use(express.static(path.join(__dirname, "public")));

const leadsRouter = require('./routes/leads.cjs');
app.use('/api/leads', leadsRouter);

// GET /api/uploads/list
app.get('/api/uploads/list', (req, res) => {
  try {
    const dir = path.join(__dirname, 'public', 'uploads');
    if (!fs.existsSync(dir)) return res.json({ ok: true, files: [] });
    const names = fs.readdirSync(dir).filter(f => fs.statSync(path.join(dir, f)).isFile());
    const files = names.map(n => ({ name: n, url: `/uploads/${n}` }));
    return res.json({ ok: true, files });
  } catch (e) {
    console.error('/api/uploads/list error', e && e.message ? e.message : e);
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

// Google Sheets sync
try {
  const sheetsRouter = require('./routes/sheets.cjs');
  app.use('/api/sheets', sheetsRouter);
} catch (e) {
  console.warn('Sheets routes disabled:', e && e.message ? e.message : e);
}

// Dashboard (single registration)
app.get(/^\/dashboard(?:\/.*)?$/, (req, res) => {
  try {
    res.sendFile(path.join(__dirname, 'public', 'dashboard', 'index.html'));
  } catch (e) {
    console.error('sendFile error', e && e.message ? e.message : e);
    return res.status(500).send('internal');
  }
});

// ==================== ENQUIRY FLOW ====================
const enquiry = require('./lib/enquiry.cjs');
const STAGING_API_URL = (process.env.STAGING_API_URL || '').trim(); // e.g. http://localhost:3001
const PROD_API_URL = (process.env.PROD_API_URL || '').trim();       // e.g. http://localhost:3002
const DEALER_SHEET_CSV_URL = (process.env.DEALER_SHEET_CSV_URL || '').trim();

enquiry.init({
  waSendText: wa.waSendText,
  waSendRaw: wa.waSendRaw,
  waSendListMenu: wa.waSendListMenu,
  sendAdminAlert: wa.sendAdminAlert,
  setLastService,
  getLastService,
  fetch,
  STAGING_API_URL,
  PROD_API_URL,
  DEALER_SHEET_CSV_URL,
  ADMIN_WA,
  DEBUG
});

// Mount enquiry API routes
app.use('/', enquiry.getRouter());

// ==================== WEBHOOK ROUTES ====================
const webhook = require('./lib/webhook.cjs');
webhook.init({
  META_TOKEN, PHONE_NUMBER_ID, ADMIN_WA, VERIFY_TOKEN, DEBUG,
  // WA helpers
  waSendText: wa.waSendText,
  waSendRaw: wa.waSendRaw,
  waSendImage: wa.waSendImage,
  waSendImageLink: wa.waSendImageLink,
  waSendListMenu: wa.waSendListMenu,
  sendNewCarButtons: wa.sendNewCarButtons,
  sendUsedCarButtons: wa.sendUsedCarButtons,
  sendAdminAlert: wa.sendAdminAlert,
  // Enquiry flow
  startEnquiry: enquiry.startEnquiry,
  handleEnquiryMessage: enquiry.handleEnquiryMessage,
  handleSalesmanReply: enquiry.handleSalesmanReply,
  // Car search (aggregated)
  carSearch,
  // Group ingest (silent observer)
  groupIngest,
  // Session
  setLastService, getLastService, isLoanContext,
  // Quotes
  canSendQuote, incrementQuoteUsage,
  // CRM / ingest
  autoIngest, pushLeadToGoogleSheet,
  recordDeliveryStatusForPhone,
  shouldGreetNow,
  postLeadToCRM, fetchCRMReply, getAllLeads,
  loadCrmLeadsSafe, saveCrmLeadsSafe,
  LEADS_FILE, SHEET_USED_CSV_URL,
  // Vision / advisory
  analyzeCarImageFaultWithOpenAI: advisory.analyzeCarImageFaultWithOpenAI,
  getMediaUrl: null, // will be set from tools module if needed
  // Quote engines
  trySmartNewCarIntent: quotes.trySmartNewCarIntent,
  tryQuickNewCarQuote: quotes.tryQuickNewCarQuote,
  buildUsedCarQuoteFreeText: usedCars.buildUsedCarQuoteFreeText,
  buildSingleUsedCarQuote: usedCars.buildSingleUsedCarQuote,
  // Advisory
  isAdvisory: advisory.isAdvisory,
  callSignatureBrain: advisory.callSignatureBrain,
  findRelevantBrochures: advisory.findRelevantBrochures,
  loadBrochureIndex: advisory.loadBrochureIndex,
  findPhonesInBrochures: advisory.findPhonesInBrochures,
  // RAG
  getRAG, findRelevantChunks,
  // Pricing
  loadPricingFromSheets: pricing.loadPricingFromSheets,
  normForMatch: pricing.normForMatch,
  calcEmiSimple: pricing.calcEmiSimple,
  fmtMoney: pricing.fmtMoney,
  simulateBulletPlan: pricing.simulateBulletPlan,
  loadUsedSheetRows: pricing.loadUsedSheetRows,
  parseCsv: pricing.parseCsv,
  fetchCsv: pricing.fetchCsv,
  toHeaderIndexMap: pricing.toHeaderIndexMap,
  // Brands
  detectBrandFromText: brands.detectBrandFromText,
  buildGlobalRegistryFromSheets: brands.buildGlobalRegistryFromSheets,
  // Constants
  USED_CAR_ROI_VISIBLE, NEW_CAR_ROI,
  LOAN_KEYWORDS: [
    'loan', 'emi', 'finance', 'financing', 'interest',
    'loan chahiye', 'loan lena', 'loan lena hai',
    'emi bata', 'emi batao', 'emi kitni', 'emi kitna',
    'finance chahiye', 'car loan',
    'installment', 'instalment'
  ],
  // Node builtins
  fs, path
});
app.use('/', webhook.router);

// ==================== TOOLS / BROADCAST ROUTES ====================
const tools = require('./lib/tools.cjs');
tools.init({
  META_TOKEN, PHONE_NUMBER_ID, ADMIN_WA, DEBUG, fetch, fs, path,
  waSendRaw: wa.waSendRaw,
  waSendText: wa.waSendText,
  waSendTemplate: wa.waSendTemplate,
  sendSheetWelcomeTemplate,
  BROADCAST_TEMPLATE_NAME,
  CONTACT_SHEET_CSV_URL,
  CONTACT_POSTER_URL,
  getAllLeads
});
app.use('/', tools.router);

// ==================== START ====================
app.listen(PORT, () => {
  console.log("Server fully started — READY to receive webhook events");
  console.log(`MR.CAR webhook CRM server running on port ${PORT}`);
  console.log('ENV summary:', {
    SHEET_TOYOTA_CSV_URL: !!SHEET_TOYOTA_CSV_URL,
    SHEET_USED_CSV_URL: !!SHEET_USED_CSV_URL || fs.existsSync(LOCAL_USED_CSV_PATH),
    PHONE_NUMBER_ID: !!PHONE_NUMBER_ID,
    META_TOKEN: !!META_TOKEN,
    ADMIN_WA: !!ADMIN_WA,
    DEBUG
  });
});
