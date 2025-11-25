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

// ---- RAG modules (optional; won't crash if missing) ----
let findRelevantChunks = () => [];
let getRAG = null;

try {
  // try different filenames: vector_search(.cjs/.js)
  ({ findRelevantChunks } = require('./vector_search'));
} catch (e1) {
  try {
    ({ findRelevantChunks } = require('./vector_search.cjs'));
  } catch (e2) {
    try {
      ({ findRelevantChunks } = require('./vector_search.js'));
    } catch (e3) {
      console.warn(
        'vector_search module not found, continuing without vector search:',
        (e3 && e3.message) || e3
      );
    }
  }
}

try {
  ({ getRAG } = require('./rag_loader'));
} catch (e1) {
  try {
    ({ getRAG } = require('./rag_loader.cjs'));
  } catch (e2) {
    try {
      ({ getRAG } = require('./rag_loader.js'));
    } catch (e3) {
      console.warn(
        'rag_loader module not found, continuing without RAG loader:',
        (e3 && e3.message) || e3
      );
    }
  }
}

const fs = require('fs');
const path = require('path');
const express = require('express');
const app = express();
app.use(express.json());

// fetch compatibility
const fetch = (global.fetch) ? global.fetch : require('node-fetch');

// ---------------- ENV ----------------
const META_TOKEN      = (process.env.META_TOKEN || process.env.WA_TOKEN || '').trim();
const PHONE_NUMBER_ID = (process.env.PHONE_NUMBER_ID || '').trim();
const ADMIN_WA        = (process.env.ADMIN_WA || '').replace(/\D/g, '') || null;
const VERIFY_TOKEN    = (process.env.VERIFY_TOKEN || process.env.META_VERIFY_TOKEN || '').trim();

const SHEET_TOYOTA_CSV_URL    = (process.env.SHEET_TOYOTA_CSV_URL || '').trim();
const SHEET_HYUNDAI_CSV_URL   = (process.env.SHEET_HYUNDAI_CSV_URL || '').trim();
const SHEET_MERCEDES_CSV_URL  = (process.env.SHEET_MERCEDES_CSV_URL || '').trim();
const SHEET_BMW_CSV_URL       = (process.env.SHEET_BMW_CSV_URL || '').trim();
const SHEET_HOT_DEALS_CSV_URL = (process.env.SHEET_HOT_DEALS_CSV_URL || '').trim();
const SHEET_USED_CSV_URL      = (process.env.SHEET_USED_CSV_URL || process.env.USED_CAR_CSV_URL || '').trim();

const LOCAL_USED_CSV_PATH = path.resolve(__dirname, 'PRE OWNED CAR PRICING - USED CAR.csv');

const PORT = process.env.PORT || 3000;

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
async function waSendRaw(payload) {
  if (!META_TOKEN || !PHONE_NUMBER_ID) {
    console.warn('WA skipped - META_TOKEN or PHONE_NUMBER_ID missing');
    return null;
  }
  const url = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`;
  try {
    if (DEBUG) console.log('WA OUTGOING PAYLOAD:', JSON.stringify(payload).slice(0, 400));
    const r = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${META_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const j = await r.json().catch(() => ({}));
    if (DEBUG) console.log('WA send response status', r.status, typeof j === 'object' ? JSON.stringify(j).slice(0, 800) : String(j).slice(0, 800));
    if (!r.ok) console.error('WA send error', r.status, j);
    return j;
  } catch (e) {
    console.error('waSendRaw failed', e && e.stack ? e.stack : e);
    return null;
  }
}

async function waSendText(to, body) {
  return waSendRaw({ messaging_product: 'whatsapp', to, type: 'text', text: { body } });
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
const SHEET_URLS = {
  HOT:      SHEET_HOT_DEALS_CSV_URL || '',
  TOYOTA:   SHEET_TOYOTA_CSV_URL || '',
  HYUNDAI:  SHEET_HYUNDAI_CSV_URL || '',
  MERCEDES: SHEET_MERCEDES_CSV_URL || '',
  BMW:      SHEET_BMW_CSV_URL || ''
};

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

// ---------------- Bullet EMI simulation (USED) ----------------
function simulateBulletPlan({ loanAmount, months, internalRatePct, bulletPct = 0.25 }) {
  const L = Number(loanAmount || 0);
  const N = Number(months || 0);
  const r = Number(internalRatePct || USED_CAR_ROI_INTERNAL) / 12 / 100;
  if (!L || !N || !isFinite(r)) return null;

  const bullet_total = Math.round(L * Number(bulletPct || 0.25));
  const num_bullets  = Math.max(1, Math.floor(N / 12));
  const bullet_each  = Math.round(bullet_total / num_bullets);

  const principal_for_emi = L - bullet_total;
  const monthly_emi = calcEmiSimple(principal_for_emi, internalRatePct, N);

  let principal           = principal_for_emi;
  let total_interest      = 0;
  let total_emi_paid      = 0;
  let total_bullets_paid  = 0;

  for (let m = 1; m <= N; m++) {
    const interest = Math.round(principal * r);
    let principal_paid_by_emi = monthly_emi - interest;
    if (principal_paid_by_emi < 0) principal_paid_by_emi = 0;
    principal = Math.max(0, principal - principal_paid_by_emi);
    total_interest += interest;
    total_emi_paid += monthly_emi;

    if (m % 12 === 0) {
      const remaining_bullets = bullet_total - total_bullets_paid;
      const bullet_paid = Math.max(0, Math.min(bullet_each, remaining_bullets));
      total_bullets_paid += bullet_paid;
      principal = Math.max(0, principal - bullet_paid);
    }
  }

  const total_payable = total_emi_paid + total_bullets_paid;
  return {
    loan: L,
    months: N,
    internalRatePct,
    monthly_emi,
    bullet_total,
    num_bullets,
    bullet_each,
    total_interest,
    total_emi_paid,
    total_bullets_paid,
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
  const fuelIdx = idxMap['FUEL'] ?? idxMap['FUEL TYPE'] ?? idxMap['FUELTYPE'] ??
    header.findIndex(h => h.includes('FUEL'));
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
        const fuelDisp  = fuelIdx >= 0 && row[fuelIdx] ? String(row[fuelIdx]).toUpperCase() : '';

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
        if (fuelDisp)  line += ` – ${fuelDisp}`;
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
  const regPlace = regIdx >= 0 && selRow[regIdx] ? String(selRow[regIdx]) : '';
  const yearDisp = yearIdx >= 0 && selRow[yearIdx] ? String(selRow[yearIdx]) : '';
  const fuelDisp = fuelIdx >= 0 && selRow[fuelIdx] ? String(selRow[fuelIdx]).toUpperCase() : '';

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
    loanAmount: loanAmt,
    months: tenure,
    internalRatePct: USED_CAR_ROI_INTERNAL,
    bulletPct: 0.25
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
  if (yearDisp) lines.push(`Manufacturing Year: ${yearDisp}`);
  if (fuelDisp) lines.push(`Fuel Type: ${fuelDisp}`);
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

function shouldGreetNow(from, msgText) {
  try {
    if (ADMIN_WA && from === ADMIN_WA) return false;
    const now = Date.now();
    const prev = lastGreeting.get(from) || 0;
    const text = (msgText || '').trim().toLowerCase();
    const looksLikeGreeting =
      /^(hi|hello|hey|namaste|enquiry|inquiry|help|start)\b/.test(text) || prev === 0;
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
   Signature GPT & Brochure helpers (Advisory)
   ======================================================================= */

const SIGNATURE_MODEL = process.env.SIGNATURE_BRAIN_MODEL || process.env.SIGNATURE_MODEL || 'gpt-4o-mini';
const BROCHURE_INDEX_PATH = process.env.BROCHURE_INDEX_PATH || './brochures/index.json';

function isAdvisory(msgText) {
  const t = (msgText || '').toLowerCase();

  const advisoryPhrases = [
    'which is better','better than','which to buy','which to choose','compare','comparison',
    'pros and cons','pros & cons','vs ',' v ',
    'spec','specs','specifications','features','variant details',
    'warranty','extended warranty','service cost','maintenance','amc',
    'ground clearance','boot space','dimensions','length','width','height','wheelbase',
    'mileage','average','fuel economy',
    'power','torque','bhp','nm',
    'safety rating','airbags','abs','esp',
    'rsa','roadside','helpline','service interval','service schedule'
  ];

  for (const p of advisoryPhrases) {
    if (t.includes(p)) return true;
  }

  const modelTyposMap = {
    hycross: ['hcyross','hycros','hycoss','hiycross'],
    hyryder: ['hyrydar','hyrider','hyrydr','hyrydar'],
    fortuner: ['fotuner','forutner'],
    innova: ['innova crysta','innova']
  };

  const toks = t.replace(/[^\w\s]/g, ' ').split(/\s+/).filter(Boolean);
  const tokSet = new Set(toks);

  let modelMentions = 0;
  for (const [canonical, typos] of Object.entries(modelTyposMap)) {
    if (tokSet.has(canonical)) modelMentions++;
    else {
      for (const s of typos) {
        if (t.includes(s)) { modelMentions++; break; }
      }
    }
  }
  if (modelMentions >= 2) return true;

  const brands = ['toyota','hyundai','bmw','mercedes','kia','tata','honda','mahindra','audi','skoda'];
  for (const b of brands) {
    if (t.includes(b)) {
      if (t.includes('compare') || t.includes('is better') || t.includes('vs ')) return true;
    }
  }

  if (/\bis\s+better\b/.test(t) || /\bbetter\b.*\bor\b/.test(t)) return true;

  return false;
}

function loadBrochureIndex() {
  try {
    const p = path.resolve(__dirname, BROCHURE_INDEX_PATH || './brochures/index.json');
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
    scored.sort((a,b) => b.score - a.score);
    return scored.slice(0,3).map(x => x.b);
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
        else if (low.includes('service') || low.includes('service center') || low.includes('service helpline')) label = 'Service helpline';
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

// updated signature function to accept an object (used elsewhere in code)
async function callSignatureBrain({ from, name, msgText, lastService, ragHits = [] } = {}) {
  try {
    if (!msgText) return null;

    const sys = `You are SIGNATURE SAVINGS — a crisp dealership advisory assistant for MR.CAR.
Focus on *advisory, comparison, features and specifications* for cars (new & used).
Use only the data given in "Relevant Data" and brochure-like knowledge; do not invent exact prices.
You may mention approximate price bands only if clearly present in the context.
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
      max_tokens: 700,
      temperature: 0.25
    });

    return resp?.choices?.[0]?.message?.content || null;

  } catch (err) {
    console.error("SignatureBrain error:", err?.message || err);
    return null;
  }
}

// ---------------- tryQuickNewCarQuote ----------------

// helper: when user says only "Innova / Hycross / Fortuner" → show variant list instead of single pick
async function tryVariantListForModel({ tables, brandGuess, city, profile, raw, to }) {
  if (!brandGuess || !tables || !tables[brandGuess]) return false;

  const lowerRaw = raw.toLowerCase();
  const modelKeywords = ['innova', 'hycross', 'fortuner', 'hyryder', 'glanza', 'camry', 'rumion'];
  const tokens = lowerRaw.split(/\s+/).filter(Boolean);

  if (tokens.length === 0 || tokens.length > 3) return false;

  let baseModelToken = null;
  for (const kw of modelKeywords) {
    if (lowerRaw.includes(kw)) {
      baseModelToken = kw;
      break;
    }
  }
  if (!baseModelToken) return false;

  const tab = tables[brandGuess];
  const header = tab.header.map(h => String(h || '').toUpperCase());
  const idxMap = tab.idxMap || toHeaderIndexMap(header);
  const idxModel = header.findIndex(h => h.includes('MODEL') || h.includes('VEHICLE'));
  const idxVariant = header.findIndex(h => h.includes('VARIANT') || h.includes('SUFFIX'));
  if (idxModel < 0 || idxVariant < 0) return false;

  const variants = [];

  const cityToken = city.split(' ')[0].toUpperCase();
  for (const row of tab.data) {
    const modelCell = idxModel >= 0 ? String(row[idxModel] || '').toLowerCase() : '';
    if (!modelCell.includes(baseModelToken)) continue;

    const variantCell = idxVariant >= 0 ? String(row[idxVariant] || '').toUpperCase() : '';
    if (!variantCell) continue;

    // pick on-road
    let priceIdx = -1;
    for (const k of Object.keys(idxMap)) {
      if (k.includes('ON ROAD') && k.includes(cityToken)) {
        priceIdx = idxMap[k];
        break;
      }
    }
    if (priceIdx < 0) {
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

    const exIdx = detectExShowIdx(idxMap);
    const exShow = exIdx >= 0 ? Number(String(row[exIdx] || '').replace(/[,₹\s]/g, '')) || 0 : 0;

    variants.push({
      variant: variantCell,
      model: String(row[idxModel] || '').toUpperCase(),
      onroad,
      exShow
    });
  }

  if (!variants.length) return false;

  // sort by ex-showroom or onroad
  variants.sort((a,b) => (a.exShow || a.onroad) - (b.exShow || b.onroad));

  const titleModel = baseModelToken.toUpperCase();
  const lines = [];
  lines.push(`*${brandGuess} ${titleModel} – Key Variants (${city.toUpperCase()}, ${profile.toUpperCase()})*`);

  const top = variants.slice(0, 10);
  top.forEach((v, i) => {
    let line = `${i + 1}) *${v.model} ${v.variant}*`;
    if (v.exShow) line += `\n   Ex-Showroom: ₹ ${fmtMoney(v.exShow)}`;
    if (v.onroad) line += `\n   On-Road: ₹ ${fmtMoney(v.onroad)}`;
    lines.push(line);
  });

  lines.push('');
  lines.push(`Reply with your full details like:`);
  lines.push(`*${city} ${titleModel} ${top[0].variant} individual*`);
  lines.push(`to get an exact quote with loan & EMI.`);

  await waSendText(to, lines.join('\n'));
  setLastService(to, 'NEW');
  return true;
}

async function tryQuickNewCarQuote(msgText, to) {
  try {
    if (!msgText || !msgText.trim()) return false;

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

    // brand guess from free text — only used to narrow search
    let brandGuess = null;
    if (/\b(bmw)\b/.test(t)) {
      brandGuess = 'BMW';
    } else if (/\b(mercedes|merc|benz)\b/.test(t)) {
      brandGuess = 'MERCEDES';
    } else if (/\b(hyundai|creta|verna|venue|alcazar|tucson|exter|grand i10|i20)\b/.test(t)) {
      brandGuess = 'HYUNDAI';
    } else if (/\b(toyota|fortuner|innova|crysta|legender|hyryder|hycross|glanza|camry|rumion|urban cruiser)\b/.test(t)) {
      brandGuess = 'TOYOTA';
    }

    let cityMatch =
      (t.match(/\b(delhi|dilli|haryana|hr|chandigarh|chd|uttar pradesh|up|himachal|hp|mumbai|bangalore|bengaluru|chennai)\b/) || [])[1] ||
      null;
    if (cityMatch) {
      if (cityMatch === 'dilli') cityMatch = 'delhi';
      if (cityMatch === 'hr') cityMatch = 'haryana';
      if (cityMatch === 'chd') cityMatch = 'chandigarh';
      if (cityMatch === 'up') cityMatch = 'uttar pradesh';
      if (cityMatch === 'hp') cityMatch = 'himachal pradesh';
    } else {
      cityMatch = 'delhi';
    }
    const city = cityMatch;

    const profile =
      (t.match(/\b(individual|company|corporate|firm|personal)\b/) || [])[1] || 'individual';

    let raw = t
      .replace(/\b(delhi|dilli|haryana|hr|chandigarh|chd|uttar pradesh|up|himachal|hp|mumbai|bangalore|bengaluru|chennai)\b/g, ' ')
      .replace(/\b(individual|company|corporate|firm|personal)\b/g, ' ')
      .replace(/[^\w\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!raw) return false;

    const modelGuess = raw.split(' ').slice(0, 3).join(' ');
    const userNorm = normForMatch(raw);
    const tokens = userNorm.split(' ').filter(Boolean);

    // 🔹 NEW: if user only gave "Innova/Hycross/Fortuner..." → show variant list first
    const variantListDone = await tryVariantListForModel({ tables, brandGuess, city, profile, raw, to });
    if (variantListDone) return true;

    let best = null; // {brand, row, idxModel, idxVariant, idxMap, onroad, exShow}

    const SPECIAL_WORDS = ['LEADER', 'LEGENDER', 'GRS'];

    for (const [brand, tab] of Object.entries(tables)) {
      if (!tab || !tab.data) continue;
      // if we have a brand guess, only search that brand
      if (brandGuess && brand !== brandGuess) continue;

      const header = tab.header.map(h => String(h || '').toUpperCase());
      const idxMap = tab.idxMap || toHeaderIndexMap(header);
      const idxModel = header.findIndex(h => h.includes('MODEL') || h.includes('VEHICLE'));
      const idxVariant = header.findIndex(h => h.includes('VARIANT') || h.includes('SUFFIX'));
      const idxVarKw = header.findIndex(h => h.includes('VARIANT_KEYWORDS') || h.includes('KEYWORD'));
      const idxSuffixCol = header.findIndex(h => h.includes('SUFFIX'));

      for (const row of tab.data) {
        const modelCell = idxModel >= 0 ? String(row[idxModel] || '').toLowerCase() : '';
        const variantCell = idxVariant >= 0 ? String(row[idxVariant] || '').toLowerCase() : '';
        const modelNorm = normForMatch(modelCell);
        const variantNorm = normForMatch(variantCell);

        let score = 0;

        if (modelCell && modelCell.includes(modelGuess)) score += 40;
        if (variantCell && variantCell.includes(modelGuess)) score += 45;
        if (raw && (modelCell.includes(raw) || variantCell.includes(raw))) score += 30;

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

        for (const tok of tokens) {
          if (!tok) continue;
          if (modelNorm && modelNorm.includes(tok)) score += 5;
          if (variantNorm && variantNorm.includes(tok)) score += 8;
          if (suffixNorm && suffixNorm.includes(tok)) score += 10;
          if (varKwNorm && varKwNorm.includes(tok)) score += 15;
        }

        // suffix detection: ZXO / VXO / GXO and optional ZX / VX / GX
        const specialSuffixes = ['zxo', 'gxo', 'vxo', 'zx', 'vx', 'gx'];
        const userSuffix = specialSuffixes.find(sfx => userNorm.includes(sfx));
        if (userSuffix) {
          const inVariant = variantNorm.includes(userSuffix);
          const inSuffix  = suffixNorm.includes(userSuffix);
          const inKw      = varKwNorm.includes(userSuffix);

          if (inVariant || inSuffix || inKw) score += 80;
          else score -= 20;
        }

        const variantUpper = String(variantCell || '').toUpperCase();
        const varKwUpper = String(varKwNorm || '').toUpperCase();
        for (const sw of SPECIAL_WORDS) {
          if ((variantUpper.includes(sw) || varKwUpper.includes(sw)) && !tUpper.includes(sw.toLowerCase())) {
            score -= 25;
          }
        }

        if (score <= 0) continue;

        // pick price
        let priceIdx = -1;
        const cityToken = city.split(' ')[0].toUpperCase();
        for (const k of Object.keys(idxMap)) {
          if (k.includes('ON ROAD') && k.includes(cityToken)) {
            priceIdx = idxMap[k];
            break;
          }
        }
        if (priceIdx < 0) {
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

        const exIdx = detectExShowIdx(idxMap);
        const exShow = exIdx >= 0 ? Number(String(row[exIdx] || '').replace(/[,₹\s]/g, '')) || 0 : 0;

        if (!best || score > best.score) {
          best = { brand, row, idxModel, idxVariant, idxMap, onroad, exShow, score };
        }
      }
    }

    if (!best) return false;

    const loanAmt = best.exShow || best.onroad || 0;
    const emi60 = loanAmt ? calcEmiSimple(loanAmt, NEW_CAR_ROI, 60) : 0;

    const modelName  = best.idxModel   >= 0 ? String(best.row[best.idxModel]   || '').toUpperCase() : '';
    const variantStr = best.idxVariant >= 0 ? String(best.row[best.idxVariant] || '').toUpperCase() : '';

    const lines = [];
    lines.push(`*${best.brand}* ${modelName} ${variantStr}`);
    lines.push(`*City:* ${city.toUpperCase()} • *Profile:* ${profile.toUpperCase()}`);
    if (best.exShow) lines.push(`*Ex-Showroom:* ₹ ${fmtMoney(best.exShow)}`);
    if (best.onroad) lines.push(`*On-Road:* ₹ ${fmtMoney(best.onroad)}`);
    if (loanAmt) {
      lines.push(
        `*Loan:* 100% of Ex-Showroom → ₹ ${fmtMoney(loanAmt)} @ *${NEW_CAR_ROI}%* (60m) → *EMI ≈ ₹ ${fmtMoney(emi60)}*`
      );
    }
    lines.push('\n*Terms & Conditions Apply ✅*');

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

// GET /crm/leads  (for dashboards)
app.get('/crm/leads', async (req, res) => {
  try {
    const limit = Number(req.query.limit || 100);
    const leads = await getAllLeads(limit);
    res.json({ ok: true, count: leads.length, leads });
  } catch (e) {
    console.error('CRM /crm/leads error:', e && e.message ? e.message : e);
    res.status(500).json({ ok: false, error: e && e.message ? e.message : String(e) });
  }
});

// POST /crm/ingest  (for other bots: Signature, Property, Loan, etc.)
app.post('/crm/ingest', async (req, res) => {
  try {
    const lead = req.body || {};
    const enrichedLead = {
      bot: lead.bot || 'UNKNOWN',
      channel: lead.channel || 'whatsapp',
      from: lead.from || '',
      name: lead.name || '',
      lastMessage: lead.lastMessage || lead.text || '',
      service: lead.service || null,
      tags: Array.isArray(lead.tags) ? lead.tags : [],
      meta: lead.meta || {}
    };
    await postLeadToCRM(enrichedLead);
    return res.json({ ok: true });
  } catch (e) {
    console.error('CRM /crm/ingest error:', e && e.message ? e.message : e);
    return res.status(500).json({ ok: false, error: e && e.message ? e.message : String(e) });
  }
});

// optional ADMIN route to clear greeting throttles
app.post('/admin/reset_greetings', (req, res) => {
  try {
    lastGreeting.clear();
    res.json({ ok: true, message: 'Greeting counters reset' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e && e.message ? e.message : String(e) });
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
    if (DEBUG) {
      const short = {
        object: req.body && req.body.object,
        entry0: Array.isArray(req.body?.entry)
          ? Object.keys(req.body.entry[0] || {})
          : undefined
      };
      console.log('📩 Incoming webhook (short):', JSON.stringify(short));
    }

    const entry  = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value  = change?.value || {};

    if (value.statuses && !value.messages) {
      if (DEBUG) console.log('Received status-only event (sent/delivered/read) — ignoring for replies.');
      return res.sendStatus(200);
    }

    const msg     = value?.messages?.[0];
    const contact = value?.contacts?.[0];
    if (!msg) return res.sendStatus(200);

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
      const lead = {
        bot: 'MR_CAR_AUTO',
        channel: 'whatsapp',
        from,
        name,
        lastMessage: msgText,
        service: getLastService(from) || null,
        tags: [],
        meta: {}
      };
      postLeadToCRM(lead).catch(() => {});
      let existing = safeJsonRead(LEADS_FILE);
      if (Array.isArray(existing)) {
        // ok
      } else if (Array.isArray(existing.leads)) {
        existing = existing.leads;
      } else {
        existing = [];
      }
      existing.unshift({ from, name, text: msgText, ts: Date.now() });
      existing = existing.slice(0, 1000);
      fs.writeFileSync(LEADS_FILE, JSON.stringify(existing, null, 2), 'utf8');
      if (DEBUG) console.log('✅ Lead saved:', from, (msgText || '').slice(0, 120));
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

    // pre-compute advisory intent ONCE
    const advisoryIntent = (type === 'text' && msgText && isAdvisory(msgText));

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
        loanAmount: loanAmt,
        months,
        internalRatePct: USED_CAR_ROI_INTERNAL,
        bulletPct: 0.25
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

    // 🔹 Advisory handler (runs BEFORE any pricing when advisoryIntent = true)
    if (advisoryIntent) {
      try {
        // Log advisory query locally
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

        // quick helplines from brochure index if present
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

        // Call Signature GPT with RAG
        const sigReply = await callSignatureBrain({ from, name, msgText, lastService: getLastService(from), ragHits });
        if (sigReply) {
          await waSendText(from, sigReply);
          // Log to CRM with advisory tag (non-blocking)
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
        // allow flow to continue if GPT failed
      }
    }

    // USED CAR detection
    if (type === 'text' && msgText) {
      const textLower = msgText.toLowerCase();
      const explicitUsed = /\b(used|pre[-\s]?owned|preowned|second[-\s]?hand)\b/.test(textLower);
      const lastSvc = getLastService(from);

      if (explicitUsed || lastSvc === 'USED') {
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

    // NEW CAR quick quote
    if (type === 'text' && msgText) {
      const served = await tryQuickNewCarQuote(msgText, from);
      if (served) {
        return res.sendStatus(200);
      }
    }

    // If RAG has something but we didn't classify as advisory/price, we can still try Signature as generic help
    if (type === 'text' && msgText && ragHits.length > 0 && !advisoryIntent) {
      try {
        const sig = await callSignatureBrain({ from, name, msgText, lastService: getLastService(from), ragHits });
        if (sig) {
          await waSendText(from, sig);
          return res.sendStatus(200);
        }
      } catch (e) {
        if (DEBUG) console.warn('Fallback RAG+Signature failed', e && e.message ? e.message : e);
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
app.listen(PORT, () => {
  console.log('==== MR.CAR BUILD TAG: 2025-11-25-NEWCAR-ADVISORY-FIX-V2 ====');
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
