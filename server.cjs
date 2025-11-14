// server.cjs — MR.CAR webhook (merged + enhanced)
// Replace your existing server.cjs with this file. Backup before replacing.
//
// Features:
// - Greeting -> Service List (Quick Actions only)
// - After service selected -> prompt + contextual 3-button interactive message
// - New car quick quote using pricing CSVs (variant matching + fallback)
// - Used car budget search, list, select -> full details + EMI + bullet simulation
// - Bullet EMI simulation uses internal 10.00% for bullet math, but visible ROI shown as 9.99%
// - Quote throttle (per-number per day), crm_leads.json persistence
// - Admin alerts, debug logging, /healthz, /leads endpoints
// - Loads optional crm_helpers.cjs for postLeadToCRM / fetchCRMReply
//
// Usage: set env vars (META_TOKEN, PHONE_NUMBER_ID, ADMIN_WA, SHEET_*_CSV_URL, SHEET_USED_CSV_URL, etc.)
// Start: PORT=10000 node server.cjs > /tmp/server.log 2>&1 &

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const app = express();
app.use(express.json());

// global fetch compatibility
const fetch = (global.fetch) ? global.fetch : require('node-fetch');

// ---------------- ENV ----------------
const META_TOKEN      = (process.env.META_TOKEN || process.env.WA_TOKEN || '').trim();
const PHONE_NUMBER_ID = (process.env.PHONE_NUMBER_ID || process.env.PHONE_ID || '').trim();
const ADMIN_WA        = (process.env.ADMIN_WA || '').replace(/\D/g, '') || null;
const VERIFY_TOKEN    = (process.env.VERIFY_TOKEN || process.env.META_VERIFY_TOKEN || '').trim();

const SHEET_TOYOTA_CSV_URL    = (process.env.SHEET_TOYOTA_CSV_URL || '').trim();
const SHEET_HYUNDAI_CSV_URL   = (process.env.SHEET_HYUNDAI_CSV_URL || '').trim();
const SHEET_MERCEDES_CSV_URL  = (process.env.SHEET_MERCEDES_CSV_URL || '').trim();
const SHEET_BMW_CSV_URL       = (process.env.SHEET_BMW_CSV_URL || '').trim();
const SHEET_HOT_DEALS_CSV_URL = (process.env.SHEET_HOT_DEALS_CSV_URL || '').trim();
const SHEET_USED_CSV_URL      = (process.env.SHEET_USED_CSV_URL || process.env.USED_CAR_CSV_URL || '').trim();

const LOCAL_USED_CSV_PATH = path.resolve(__dirname, "PRE OWNED CAR PRICING - USED CAR.csv");

const PORT = process.env.PORT || 10000;

// ---------------- Configs & constants ----------------
const MAX_QUOTE_PER_DAY = Number(process.env.MAX_QUOTE_PER_DAY || 10);
const QUOTE_LIMIT_FILE = path.resolve(__dirname, "quote_limit.json");
const LEADS_FILE = path.resolve(__dirname, "crm_leads.json");

const NEW_CAR_ROI = Number(process.env.NEW_CAR_ROI || 8.10);
const USED_CAR_ROI_VISIBLE = Number(process.env.USED_CAR_ROI_VISIBLE || 9.99);
const USED_CAR_ROI_INTERNAL = Number(process.env.USED_CAR_ROI_INTERNAL || 10.00);

const DEBUG = process.env.DEBUG_VARIANT === "true" || true;

// optional greeting window (minutes)
let GREETING_WINDOW_MINUTES = Number(process.env.GREETING_WINDOW_MINUTES || 600);
let GREETING_WINDOW_MS = GREETING_WINDOW_MINUTES * 60 * 1000;

// ---------------- Helpers: file-safe JSON read/write ----------------
function safeJsonRead(filename){
  try {
    if (!fs.existsSync(filename)) return {};
    const txt = fs.readFileSync(filename, 'utf8') || '';
    return txt ? JSON.parse(txt) : {};
  } catch (e) {
    console.warn("safeJsonRead failed", e && e.message ? e.message : e);
    return {};
  }
}
function safeJsonWrite(filename, obj){
  try {
    fs.writeFileSync(filename, JSON.stringify(obj, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error("safeJsonWrite failed", e && e.message ? e.message : e);
    return false;
  }
}

// ---------------- CRM lead persistence ----------------
function saveLead(lead) {
  try {
    // existing format: array of leads
    let arr = [];
    if (fs.existsSync(LEADS_FILE)) {
      const raw = fs.readFileSync(LEADS_FILE, 'utf8') || '[]';
      arr = Array.isArray(JSON.parse(raw)) ? JSON.parse(raw) : (JSON.parse(raw).leads || []);
    }
    arr.unshift({ ...lead, ts: Date.now() });
    arr = arr.slice(0, 2000);
    fs.writeFileSync(LEADS_FILE, JSON.stringify(arr, null, 2), 'utf8');
    if (DEBUG) console.log("✅ Lead saved:", lead.from, (lead.text||'').slice(0,120));
    return true;
  } catch (e) {
    console.error("❌ Failed to save lead", e && e.message ? e.message : e);
    return false;
  }
}

app.get("/leads", (req, res) => {
  try {
    if (fs.existsSync(LEADS_FILE)) {
      const raw = fs.readFileSync(LEADS_FILE, 'utf8') || "[]";
      return res.json(JSON.parse(raw));
    }
    res.json([]);
  } catch (e) { console.warn("GET /leads read error", e); res.json([]); }
});

// ---------------- Quote limits (competitor protection) ----------------
function loadQuoteLimits(){
  const js = safeJsonRead(QUOTE_LIMIT_FILE);
  return js || {};
}
function saveQuoteLimits(obj){ safeJsonWrite(QUOTE_LIMIT_FILE, obj); }
function canSendQuote(from){
  try {
    const q = loadQuoteLimits();
    const today = new Date().toISOString().slice(0,10);
    const rec = q[from] || { date: today, count: 0 };
    if (rec.date !== today) { rec.date = today; rec.count = 0; }
    return rec.count < MAX_QUOTE_PER_DAY;
  } catch(e) { return true; }
}
function incrementQuoteUsage(from){
  try {
    const q = loadQuoteLimits();
    const today = new Date().toISOString().slice(0,10);
    const rec = q[from] || { date: today, count: 0 };
    if (rec.date !== today) { rec.date = today; rec.count = 0; }
    rec.count = Number(rec.count || 0) + 1;
    q[from] = rec;
    saveQuoteLimits(q);
    if (DEBUG) console.log("Quote usage", from, rec);
  } catch(e) { console.warn("incrementQuoteUsage failed", e && e.message ? e.message : e); }
}

// ---------------- WA helpers (send) ----------------
async function waSendRaw(payload) {
  if (!META_TOKEN || !PHONE_NUMBER_ID) { console.warn("WA skipped - META_TOKEN or PHONE_NUMBER_ID missing"); return null; }
  const url = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`;
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${META_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const j = await r.json().catch(()=>({}));
    if (DEBUG) console.log("WA send response status", r.status, typeof j === 'object' ? JSON.stringify(j).slice(0,800) : String(j).slice(0,800));
    if (!r.ok) console.error("WA send error", r.status, j);
    // log outgoing payload briefly
    try { console.log("WA OUTGOING PAYLOAD:", JSON.stringify(payload).slice(0,800)); } catch(e){}
    return j;
  } catch(e) {
    console.error("waSendRaw failed", e && e.stack ? e.stack : e);
    return null;
  }
}
async function waSendText(to, body){ return waSendRaw({ messaging_product:"whatsapp", to, type:"text", text:{ body } }); }

// ---------------- List menu (Quick Actions only) ----------------
async function waSendListMenu(to){
  const rows = [
    { id:"SRV_NEW_CAR", title:"New Car Deals", description:"On-road prices & offers" },
    { id:"SRV_USED_CAR", title:"Pre-Owned Cars", description:"Certified used inventory" },
    { id:"SRV_SELL_CAR", title:"Sell My Car", description:"Best selling quote" },
    { id:"SRV_LOAN", title:"Loan / Finance", description:"Fast approvals & low ROI" }
  ];
  const interactive = {
    type: "list",
    header:{ type:"text", text:"MR. CAR SERVICES" },
    body:{ text:"Please choose one option 👇" },
    footer:{ text:"Premium Deals • Trusted Service • Mr. Car" },
    action:{ button:"Select Service", sections:[ { title:"Quick Actions", rows } ] }
  };
  return waSendRaw({ messaging_product:"whatsapp", to, type:"interactive", interactive });
}

// ---------------- Compact 3-button helpers (contextual) ----------------
async function sendNewCarButtons(to) {
  const payload = { messaging_product:'whatsapp', to, type:'interactive', interactive:{
    type:'button', body:{ text:'Quick actions — New Car:' }, action:{ buttons:[
      { type:'reply', reply:{ id:'BTN_NEW_QUOTE', title:'Another Quote' } },
      { type:'reply', reply:{ id:'BTN_NEW_LOAN', title:'Loan / EMI Calculator' } },
      { type:'reply', reply:{ id:'BTN_CONTACT_SALES', title:'Contact Sales' } }
    ] }
  }};
  return waSendRaw(payload);
}

async function sendUsedCarButtons(to) {
  const payload = { messaging_product:'whatsapp', to, type:'interactive', interactive:{
    type:'button', body:{ text:'Quick actions — Used Car:' }, action:{ buttons:[
      { type:'reply', reply:{ id:'BTN_USED_PHOTOS', title:'Send Photos' } },
      { type:'reply', reply:{ id:'BTN_USED_LOAN', title:'Loan Options' } },
      { type:'reply', reply:{ id:'BTN_BULLET_CALC', title:'Bullet EMI Calc' } }
    ] }
  }};
  return waSendRaw(payload);
}

async function sendSellCarButtons(to) {
  const payload = { messaging_product:'whatsapp', to, type:'interactive', interactive:{
    type:'button', body:{ text:'Quick actions — Sell My Car:' }, action:{ buttons:[
      { type:'reply', reply:{ id:'BTN_SELL_QUOTE', title:'Get Quick Quote' } },
      { type:'reply', reply:{ id:'BTN_SELL_HOW', title:'How it works' } },
      { type:'reply', reply:{ id:'BTN_CONTACT_SALES', title:'Contact Sales' } }
    ] }
  }};
  return waSendRaw(payload);
}

async function sendLoanButtons(to) {
  const payload = { messaging_product:'whatsapp', to, type:'interactive', interactive:{
    type:'button', body:{ text:'Quick actions — Finance:' }, action:{ buttons:[
      { type:'reply', reply:{ id:'BTN_NEW_LOAN', title:'EMI Calculator' } },
      { type:'reply', reply:{ id:'BTN_CHECK_ELIG', title:'Check Eligibility' } },
      { type:'reply', reply:{ id:'BTN_DOCS', title:'Documents Required' } }
    ] }
  }};
  return waSendRaw(payload);
}

// ---------------- admin alerts & throttling ----------------
const lastAlert = new Map();
async function sendAdminAlert({ from, name, text }) {
  if (!META_TOKEN || !PHONE_NUMBER_ID || !ADMIN_WA) return;
  const now = Date.now(); const prev = lastAlert.get(from) || 0;
  const ALERT_WINDOW_MS = (Number(process.env.ALERT_WINDOW_MINUTES || 10)) * 60 * 1000;
  if (now - prev < ALERT_WINDOW_MS) { if (DEBUG) console.log("throttled admin alert for", from); return; }
  lastAlert.set(from, now);
  await waSendRaw({ messaging_product:"whatsapp", to: ADMIN_WA, type:"text",
    text: { body: `🔔 NEW WA LEAD\nFrom: ${from}\nName: ${name||'-'}\nMsg: ${String(text||'').slice(0,1000)}` }});
  if (DEBUG) console.log("admin alert sent");
}

// ---------------- CSV parse / fetch ----------------
function parseCsv(text){
  const rows=[]; let cur="", row=[], inQ=false;
  for(let i=0;i<text.length;i++){
    const ch=text[i];
    if(inQ){
      if(ch==='"'){ if(text[i+1]==='"'){ cur+='"'; i++; } else inQ=false; }
      else cur+=ch;
    } else {
      if(ch==='"') inQ=true;
      else if(ch===','){ row.push(cur); cur=""; }
      else if(ch==='\n'){ row.push(cur); rows.push(row); row=[]; cur=""; }
      else if(ch!=='\r') cur+=ch;
    }
  }
  if(cur.length||row.length){ row.push(cur); rows.push(row); }
  return rows;
}
async function fetchCsv(url){
  if(!url) throw new Error("CSV URL missing");
  const r = await fetch(url, { cache: "no-store" });
  if(!r.ok) throw new Error(`CSV fetch failed ${r.status}`);
  const txt = await r.text();
  return parseCsv(txt);
}
function toHeaderIndexMap(headerRow){
  const map = {};
  headerRow.forEach((h,i) => { map[String((h||"").trim()).toUpperCase()] = i; });
  return map;
}

// ---------------- Normalization helpers ----------------
function normForMatch(s){
  return (s||"").toString().toLowerCase()
    .replace(/(automatic|automatic transmission|\bauto\b)/g, " at ")
    .replace(/\bmanual\b/g," mt ")
    .replace(/[\*\/\\]/g, "x")
    .replace(/\s*x\s*/g, "x")
    .replace(/(\d)\s*x\s*(\d)/g,"$1x$2")
    .replace(/[^a-z0-9\s]/g," ")
    .replace(/\s+/g," ")
    .trim();
}
function fmtMoney(n){ const x=Number(n||0); if(!isFinite(x)) return "-"; return x.toLocaleString("en-IN",{maximumFractionDigits:0}); }
function calcEmiSimple(p, annualRatePct, months){
  const P = Number(p); const r = Number(annualRatePct)/12/100;
  if(!P || !isFinite(r) || months <= 0) return 0;
  const pow = Math.pow(1+r, months);
  const emi = Math.round(P * r * pow / (pow - 1));
  return emi;
}

// ---------------- Pricing loader ----------------
const SHEET_URLS = {
  HOT: SHEET_HOT_DEALS_CSV_URL || "",
  TOYOTA: SHEET_TOYOTA_CSV_URL || "",
  HYUNDAI: SHEET_HYUNDAI_CSV_URL || "",
  MERCEDES: SHEET_MERCEDES_CSV_URL || "",
  BMW: SHEET_BMW_CSV_URL || ""
};
const PRICING_CACHE = { tables: null, ts: 0 };
const PRICING_CACHE_MS = 3*60*1000;

function buildVariantMapForTable(table){
  if(!table || !table.idxMap) return null;
  const im = table.idxMap;
  const data = table.data||[];
  const vIdx = im["VARIANT"] ?? im["SUFFIX"] ?? -1;
  const kwIdx = im["VARIANT_KEYWORDS"] ?? -1;
  const mIdx = im["MODEL"] ?? -1;
  const map = [];
  for(let r=0;r<data.length;r++){
    const row = data[r];
    const variantRaw = vIdx>=0 ? (row[vIdx]||"") : "";
    const modelRaw = mIdx>=0 ? (row[mIdx]||"") : "";
    const canonical = String(variantRaw||"").trim();
    const keywords = new Set();
    if(canonical) keywords.add(normForMatch(canonical));
    if(modelRaw) keywords.add(normForMatch(modelRaw));
    if(canonical && modelRaw) keywords.add(normForMatch(`${modelRaw} ${canonical}`));
    if(kwIdx>=0){
      const cell = String(row[kwIdx]||"");
      const parts = cell.split(',').map(x=>x.trim()).filter(Boolean);
      for(const p of parts) keywords.add(normForMatch(p));
    }
    const addTokens = (txt)=>{
      const n = normForMatch(txt);
      if(!n) return;
      keywords.add(n);
      const toks = n.split(' ').filter(Boolean);
      for(let i=0;i<toks.length;i++){
        keywords.add(toks[i]);
        if(i+1 < toks.length) keywords.add(`${toks[i]} ${toks[i+1]}`);
      }
    };
    addTokens(canonical);
    addTokens(modelRaw);
    if(kwIdx>=0) addTokens(String(row[kwIdx]||""));
    map.push({ canonical, model: normForMatch(modelRaw), keywords, rowIndex: r, rawRow: row });
  }
  return map;
}

async function loadPricingFromSheets(){
  const now = Date.now();
  if (PRICING_CACHE.tables && now - PRICING_CACHE.ts < PRICING_CACHE_MS) return PRICING_CACHE.tables;
  const tables = {};
  for (const [brand, url] of Object.entries(SHEET_URLS)){
    if (!url) continue;
    try {
      const rows = await fetchCsv(url);
      if (!rows || !rows.length) continue;
      const header = rows[0].map(h => String(h||"").trim());
      const idxMap = toHeaderIndexMap(header);
      const data = rows.slice(1);
      const tab = { header, idxMap, data };
      try { tab.variantMap = buildVariantMapForTable(tab); } catch(e){ tab.variantMap = null; console.error("variantMap build failed", e && e.message ? e.message : e); }
      tables[brand] = tab;
    } catch(e) { console.warn("CSV load failed for", brand, e && e.message ? e.message : e); }
  }
  PRICING_CACHE.tables = tables; PRICING_CACHE.ts = Date.now();
  return tables;
}

// ---------------- Used car sheet loader (local fallback) ----------------
async function loadUsedSheet(){
  if (SHEET_USED_CSV_URL){
    try {
      const rows = await fetchCsv(SHEET_USED_CSV_URL);
      if (rows && rows.length) return rows;
    } catch(e){ if (DEBUG) console.warn("remote used csv fetch failed", e && e.message ? e.message : e); }
  }
  try {
    if (fs.existsSync(LOCAL_USED_CSV_PATH)){
      const txt = fs.readFileSync(LOCAL_USED_CSV_PATH, 'utf8');
      const rows = parseCsv(txt);
      if (rows && rows.length) return rows;
    }
  } catch(e){ if (DEBUG) console.warn("local used csv read failed", e && e.message ? e.message : e); }
  return [];
}

// ---------------- Bullet EMI simulation ----------------
function simulateBulletPlan({ loanAmount, months, internalRatePct, bulletPct=0.25 }){
  const L = Number(loanAmount || 0);
  const N = Number(months || 0);
  const r = Number(internalRatePct || USED_CAR_ROI_INTERNAL) / 12 / 100;
  if (!L || !N || !isFinite(r)) return null;
  const bullet_total = Math.round(L * Number(bulletPct || 0.25));
  const num_bullets = Math.max(1, Math.floor(N / 12));
  const bullet_each = Math.round(bullet_total / num_bullets);
  const principal_for_emi = L - bullet_total;
  const monthly_emi = calcEmiSimple(principal_for_emi, internalRatePct, N);
  let principal = principal_for_emi;
  let total_interest = 0;
  let total_emi_paid = 0;
  let total_bullets_paid = 0;
  const schedule = [];
  for (let m = 1; m <= N; m++){
    const interest = Math.round(principal * r);
    let principal_paid_by_emi = monthly_emi - interest;
    if (principal_paid_by_emi < 0) principal_paid_by_emi = 0;
    principal = Math.max(0, principal - principal_paid_by_emi);
    total_interest += interest;
    total_emi_paid += monthly_emi;
    let bullet_paid = 0;
    if (m % 12 === 0) {
      // compute bullet payment (handle rounding on final)
      if (m === num_bullets * 12) {
        const already = total_bullets_paid;
        bullet_paid = Math.max(0, bullet_total - already);
      } else {
        bullet_paid = Math.min(bullet_each, Math.max(0, (L - (principal + total_bullets_paid))));
      }
      total_bullets_paid += bullet_paid;
      principal = Math.max(0, principal - bullet_paid);
    }
    schedule.push({ month: m, interest, emi: monthly_emi, principal_remaining: principal, bullet_paid });
  }
  const total_payable = total_emi_paid + total_bullets_paid;
  return {
    loan: L,
    months: N,
    internalRatePct: internalRatePct,
    monthly_emi,
    bullet_total,
    num_bullets,
    bullet_each,
    total_interest,
    total_emi_paid,
    total_bullets_paid,
    total_payable,
    schedule
  };
}

// ---------------- Build used car quote (budget list + full details) ----------------
async function buildUsedCarQuote({ make, model, year }) {
  try {
    const rows = await loadUsedSheet();
    if (!rows || !rows.length) return { text: "Used car pricing not configured." };
    const header = rows[0].map(h => String(h||"").trim().toUpperCase());
    const data = rows.slice(1);
    const makeIdx = header.findIndex(h => h.includes("MAKE"));
    const modelIdx = header.findIndex(h => h.includes("MODEL"));
    const expectedIdx = header.findIndex(h => h.includes("EXPECTED")||h.includes("EXPECTED_PRICE")||h.includes("EXPECTED PRICE"));
    // find first matching row
    const findRow = data.find(r => String(r[makeIdx]||"").toLowerCase().includes((make||"").toLowerCase()) && String(r[modelIdx]||"").toLowerCase().includes((model||"").toLowerCase()));
    if (!findRow) return { text: `Sorry, I couldn’t find the used car *${make} ${model}* right now.` };
    const price = expectedIdx>=0 ? Number(String(findRow[expectedIdx]||'').replace(/[,₹\s]/g,'')) || 0 : 0;
    const maxLoan = Math.round(price * 0.95);
    const emi = calcEmiSimple(maxLoan, USED_CAR_ROI_VISIBLE, 60);
    // bullet sim (use internal rate)
    const bulletSim = simulateBulletPlan({ loanAmount: maxLoan, months: 60, internalRatePct: USED_CAR_ROI_INTERNAL, bulletPct: 0.25 });
    const lines = [
      `*PRE-OWNED CAR QUOTE*`,
      `Make/Model: *${String(findRow[makeIdx]||"").toUpperCase()} ${String(findRow[modelIdx]||"").toUpperCase()}*`,
      price ? `Expected Price: ₹ *${fmtMoney(price)}*` : null,
      `Loan up to *95%*: ₹ ${fmtMoney(maxLoan)} @ *${USED_CAR_ROI_VISIBLE}%* (60m) → EMI ≈ ₹ *${fmtMoney(emi)}*`,
      ``
    ].filter(Boolean);
    if (bulletSim) {
      lines.push(`📌 *Bullet EMI Plan (25% bullets)*`);
      lines.push(`• Monthly EMI (amortising): ₹ *${fmtMoney(bulletSim.monthly_emi)}*`);
      lines.push(`• Bullet total: ₹ *${fmtMoney(bulletSim.bullet_total)}* (paid every 12 months)`);
      lines.push(`• Bullet each: ₹ *${fmtMoney(bulletSim.bullet_each)}* on months: ${Array.from({length: bulletSim.num_bullets}, (_,i) => (12*(i+1))).join(" • ")}`);
      lines.push(``);
      lines.push(`📊 *Total payable (EMIs + bullets):* ₹ *${fmtMoney(bulletSim.total_payable)}*`);
      lines.push(`💰 *Interest (approx):* ₹ *${fmtMoney(bulletSim.total_interest)}*`);
      lines.push(``);
      lines.push(`✅ *Loan approval possible in ~30 minutes (T&Cs apply)*`);
    }
    lines.push(`\n*Terms & Conditions Apply ✅*`);
    return { text: lines.join("\n"), picLink: null };
  } catch (e) {
    console.error("buildUsedCarQuote error", e && e.stack ? e.stack : e);
    return { text: "Used car pricing failed." , picLink:null };
  }
}

// ---------------- Used-car budget search
// Accepts budget in INR (number) or strings like "15l", "15 lac"
function parseBudgetText(s){
  if(!s) return 0;
  const raw = String(s).toLowerCase().replace(/[,₹\s]/g,"");
  const m = raw.match(/(\d+(\.\d+)?)(l|lac|k|th)?/);
  if(!m) return Number(raw) || 0;
  let val = Number(m[1]);
  const unit = m[3] || '';
  if(unit === 'l' || unit === 'lac') val = val * 100000;
  else if(unit === 'k' || unit === 'th') val = val * 1000;
  return Math.round(val);
}
function budgetRangeFromAmount(amount){
  // returns {min, max}
  if (!amount || amount <= 500000) return { min: 0, max: 500000 };
  if (amount <= 1500000) return { min: 500001, max: 1500000 };
  if (amount <= 3000000) return { min: 1500001, max: 3000000 };
  if (amount <= 5000000) return { min: 3000001, max: 5000000 };
  return { min: 5000001, max: 999999999 };
}
async function searchUsedByBudget(amount, maxResults=8){
  const rows = await loadUsedSheet();
  if(!rows || !rows.length) return [];
  const header = rows[0].map(h => String(h||"").trim().toUpperCase());
  const data = rows.slice(1);
  const expectedIdx = header.findIndex(h => h.includes("EXPECTED")||h.includes("EXPECTED_PRICE")||h.includes("EXPECTED PRICE"));
  const makeIdx = header.findIndex(h => h.includes("MAKE"));
  const modelIdx = header.findIndex(h => h.includes("MODEL"));
  const kmIdx = header.findIndex(h => h.includes("KM") || h.includes("ODO") || h.includes("KMS"));
  const colorIdx = header.findIndex(h => h.includes("COLOR") || h.includes("COLOUR"));
  const regIdx = header.findIndex(h => h.includes("REGISTRATION") || h.includes("PLACE") || h.includes("REGISTERED"));
  const { min, max } = budgetRangeFromAmount(amount);
  const out = [];
  for(const r of data){
    const price = expectedIdx>=0 ? Number(String(r[expectedIdx]||'').replace(/[,₹\s]/g,'')) || 0 : 0;
    if (!price) continue;
    if (price >= min && price <= max) {
      out.push({
        price,
        make: String(r[makeIdx]||""),
        model: String(r[modelIdx]||""),
        km: String(r[kmIdx]||""),
        color: String(r[colorIdx]||""),
        reg: String(r[regIdx]||""),
        raw: r
      });
      if (out.length >= maxResults) break;
    }
  }
  return out;
}

// ---------------- Try quick new car quote ----------------
function detectExShowIdx(idxMap){
  let exIdx = -1;
  for (const k of Object.keys(idxMap)) {
    const up = String(k).toUpperCase();
    if (up.includes("EX") && up.includes("SHOWROOM")) { exIdx = idxMap[k]; break; }
  }
  return exIdx;
}
function findColumnNameFor(city, profile){ // fallback mapping - best-effort
  const c = (city||'').toLowerCase();
  const p = (profile||'individual').toLowerCase();
  const key = `${c}:${p}`;
  const map = {
    "delhi:individual": "ON ROAD PRICE DELHI INDIVIDUAL",
    "delhi:company": "ON ROAD PRICE DELHI CORPORATE/COMPANY/FIRM",
    "haryana:individual": "ON ROAD PRICE HARYANA(HR)",
    "haryana:company": "ON ROAD PRICE HARYANA(HR)",
    "chandigarh:individual": "ON ROAD PRICE CHANDIGARH (CHD)",
    "chandigarh:company": "ON ROAD PRICE CHANDIGARH (CHD)"
  };
  for (const k of Object.keys(map)) {
    if (k === key) return map[k];
  }
  return null;
}

function matchVariantFromMap(userText, variantMap){
  if(!userText||!variantMap) return null;
  const qRaw = normForMatch(userText);
  for(const v of variantMap){
    if(!v) continue;
    if(v.canonical && normForMatch(v.canonical) === qRaw) return v;
    if(v.keywords && v.keywords.has(qRaw)) return v;
  }
  const cleaned = qRaw.replace(/\b(delhi|dilli|haryana|hr|chandigarh|chd|uttar|up|himachal|individual|company|corporate|firm|personal)\b/g," ").replace(/\s+/g," ").trim();
  const qTokens = (cleaned||qRaw).split(' ').filter(Boolean);
  let best=null, bestScore=0, second=0;
  for(const v of variantMap){
    if(!v) continue;
    const all = Array.from(v.keywords).join(' ');
    const vTokens = all.split(' ').filter(Boolean);
    const qInV = qTokens.every(t => vTokens.includes(t));
    if(qInV) { return v; }
    let score=0;
    for(const t of qTokens){
      for(const vt of vTokens){
        if(vt===t) score += 6;
        else if(vt.includes(t) || t.includes(vt)) score += 4;
      }
    }
    if(/\b4x2\b/.test(cleaned||qRaw) && /\b4x2\b/.test(all)) score += 12;
    if(/\b4x4\b/.test(cleaned||qRaw) && /\b4x4\b/.test(all)) score += 12;
    if(/\bat\b/.test(cleaned||qRaw) && /\bat\b/.test(all)) score += 8;
    if(/\bmt\b/.test(cleaned||qRaw) && /\bmt\b/.test(all)) score += 8;
    if(score > bestScore){ second = bestScore; bestScore = score; best = v; }
    else if(score > second) second = score;
  }
  if(!best) return null;
  if(bestScore < 12) return null;
  if(second > 0 && bestScore < second * 1.4 + 5) return null;
  return best;
}

async function tryQuickNewCarQuote(msgText, to){
  try {
    if (!msgText || !msgText.trim()) return false;
    if (!canSendQuote(to)) {
      await waSendText(to, "You’ve reached today’s assistance limit for quotes. Please try again tomorrow or provide your details for a personalised quote.");
      return true;
    }
    const tables = await loadPricingFromSheets();
    if (!tables || Object.keys(tables).length === 0) return false;
    const t = String(msgText || "").toLowerCase();
    let cityMatch = (t.match(/\b(delhi|dilli|haryana|hr|chandigarh|chd|uttar pradesh|up|himachal|hp)\b/)||[])[1] || null;
    if(cityMatch){ if(cityMatch==="dilli") cityMatch="delhi"; if(cityMatch==="hr") cityMatch="haryana"; if(cityMatch==="chd") cityMatch="chandigarh"; if(cityMatch==="up") cityMatch="uttar pradesh"; if(cityMatch==="hp") cityMatch="himachal pradesh"; }
    else cityMatch = "delhi";
    const city = cityMatch;
    const profile = (t.match(/\b(individual|company|corporate|firm|personal)\b/)||[])[1] || "individual";
    // try variantMap match first
    const order = ["HOT","TOYOTA","HYUNDAI","MERCEDES","BMW"];
    for (const b of order) {
      const tab = tables[b];
      if (!tab) continue;
      if (tab.variantMap) {
        const vmatch = matchVariantFromMap(msgText, tab.variantMap);
        if (vmatch) {
          const hit = tab.data[vmatch.rowIndex];
          const idxMap = tab.idxMap;
          const exIdx = detectExShowIdx(idxMap);
          // find onroad using findColumnNameFor or first numeric
          let priceIdx = -1;
          const priceColName = findColumnNameFor(city, profile);
          if (priceColName) priceIdx = idxMap[(priceColName||"").toUpperCase()] ?? -1;
          if (priceIdx < 0) {
            // find first numeric in row
            for (let i=0;i<hit.length;i++){
              const v = String(hit[i]||"").replace(/[,₹\s]/g,"");
              if (v && /^\d+$/.test(v)) { priceIdx = i; break; }
            }
          }
          const onroad = priceIdx>=0 ? Number(String(hit[priceIdx]||"").replace(/[,₹\s]/g,"")) || 0 : 0;
          const exShow = exIdx>=0 ? Number(String(hit[exIdx]||"").replace(/[,₹\s]/g,"")) || 0 : 0;
          const loanAmt = exShow || onroad || 0;
          const emi60 = loanAmt ? calcEmiSimple(loanAmt, NEW_CAR_ROI, 60) : 0;
          const make = hit[idxMap["MAKE"]] || "";
          const modl = hit[idxMap["MODEL"]] || "";
          const varnt = hit[idxMap["VARIANT"]] || hit[idxMap["SUFFIX"]] || "";
          const colr = hit[idxMap["COLOUR"]] || hit[idxMap["COLOR"]] || "";
          const lines = [
            `*${String(make||"").toUpperCase()} ${String(modl||"").toUpperCase()}* ${varnt ? `(${varnt})` : ""}${colr ? ` – ${colr}` : ""}`,
            `*City:* ${city.toUpperCase()} • *Profile:* ${profile.toUpperCase()}`,
            exShow ? `*Ex-Showroom:* ₹ ${fmtMoney(exShow)}` : null,
            onroad ? `*On-Road:* ₹ ${fmtMoney(onroad)}` : null,
            loanAmt ? `*Loan:* 100% of Ex-Showroom → ₹ ${fmtMoney(loanAmt)} @ *${NEW_CAR_ROI}%* (60m) → *EMI ≈ ₹ ${fmtMoney(emi60)}*` : null,
            `\n*Terms & Conditions Apply ✅*`
          ].filter(Boolean).join("\n");
          await waSendText(to, lines);
          await sendNewCarButtons(to);
          incrementQuoteUsage(to);
          return true;
        }
      }
      // fallback scanning by model text
      const header = tab.header.map(h => String(h||"").toUpperCase());
      const idxModel = header.findIndex(h=> h.includes("MODEL") || h.includes("VEHICLE"));
      const idxVariant = header.findIndex(h=> h.includes("VARIANT") || h.includes("SUFFIX"));
      for (const row of (tab.data||[])) {
        const modelCell = idxModel>=0 ? String(row[idxModel]||"").toLowerCase() : "";
        const variantCell = idxVariant>=0 ? String(row[idxVariant]||"").toLowerCase() : "";
        if ((modelCell && modelCell.includes(t)) || (variantCell && variantCell.includes(t))) {
          // similar to above
          const idxMap = tab.idxMap;
          const exIdx = detectExShowIdx(idxMap);
          let priceIdx = -1;
          const priceColName = findColumnNameFor(city, profile);
          if (priceColName) priceIdx = idxMap[(priceColName||"").toUpperCase()] ?? -1;
          if (priceIdx < 0) {
            for (let i=0;i<row.length;i++){
              const v = String(row[i]||"").replace(/[,₹\s]/g,"");
              if (v && /^\d+$/.test(v)) { priceIdx = i; break; }
            }
          }
          const onroad = priceIdx>=0 ? Number(String(row[priceIdx]||"").replace(/[,₹\s]/g,"")) || 0 : 0;
          const exShow = exIdx>=0 ? Number(String(row[exIdx]||"").replace(/[,₹\s]/g,"")) || 0 : 0;
          const loanAmt = exShow || onroad || 0;
          const emi60 = loanAmt ? calcEmiSimple(loanAmt, NEW_CAR_ROI, 60) : 0;
          const make = row[idxMap["MAKE"]] || "";
          const modl = row[idxMap["MODEL"]] || "";
          const varnt = row[idxMap["VARIANT"]] || row[idxMap["SUFFIX"]] || "";
          const colr = row[idxMap["COLOUR"]] || row[idxMap["COLOR"]] || "";
          const lines = [
            `*${String(make||"").toUpperCase()} ${String(modl||"").toUpperCase()}* ${varnt ? `(${varnt})` : ""}${colr ? ` – ${colr}` : ""}`,
            `*City:* ${city.toUpperCase()} • *Profile:* ${profile.toUpperCase()}`,
            exShow ? `*Ex-Showroom:* ₹ ${fmtMoney(exShow)}` : null,
            onroad ? `*On-Road:* ₹ ${fmtMoney(onroad)}` : null,
            loanAmt ? `*Loan:* 100% of Ex-Showroom → ₹ ${fmtMoney(loanAmt)} @ *${NEW_CAR_ROI}%* (60m) → *EMI ≈ ₹ ${fmtMoney(emi60)}*` : null,
            `\n*Terms & Conditions Apply ✅*`
          ].filter(Boolean).join("\n");
          await waSendText(to, lines);
          await sendNewCarButtons(to);
          incrementQuoteUsage(to);
          return true;
        }
      }
    }
    return false;
  } catch(e){
    console.error("tryQuickNewCarQuote error", e && e.stack ? e.stack : e);
    return false;
  }
}

// ---------------- CRM helpers (external file) ----------------
let postLeadToCRM = async ()=>{};
let fetchCRMReply = async ()=>{ return null; };
try {
  const crmHelpers = require('./crm_helpers.cjs');
  postLeadToCRM = crmHelpers.postLeadToCRM || postLeadToCRM;
  fetchCRMReply = crmHelpers.fetchCRMReply || fetchCRMReply;
  if (DEBUG) console.log("crm_helpers.cjs loaded");
} catch(e) {
  if (DEBUG) console.log("crm_helpers.cjs not loaded (ok for dev).", e && e.message ? e.message : e);
}

// ---------------- Greeting helper (safe global lastGreeting) ----------------
if (typeof global.lastGreeting === "undefined") global.lastGreeting = new Map();
const lastGreeting = global.lastGreeting;

if (typeof global.shouldGreetNow === "undefined") {
  function shouldGreetNow(from, msgText){
    if (ADMIN_WA && from === ADMIN_WA) return false;
    try {
      const now = Date.now(); const prev = lastGreeting.get(from) || 0;
      const text = (msgText||"").toString().trim().toLowerCase();
      const looksLikeGreeting = /^(hi|hello|hey|namaste|enquiry|inquiry|help|start)\b/.test(text) || prev === 0;
      if (!looksLikeGreeting) return false;
      if (now - prev < GREETING_WINDOW_MS) return false;
      lastGreeting.set(from, now);
      return true;
    } catch (e) { console.warn("shouldGreetNow failed", e); return false; }
  }
  global.shouldGreetNow = shouldGreetNow;
}
const shouldGreetNow = global.shouldGreetNow;

// ---------------- Webhook & routing ----------------
app.get("/healthz", (req, res) => res.json({ ok: true, t: Date.now(), debug: DEBUG }));

// META verify
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN && challenge) {
    console.log("Webhook verified ✅");
    return res.status(200).type("text/plain").send(String(challenge));
  }
  return res.sendStatus(403);
});

// admin endpoints
app.post('/admin/reset_greetings', (req, res) => {
  try {
    lastGreeting.clear();
    return res.json({ ok: true, msg: "greetings cleared" });
  } catch (e) {
    return res.status(500).json({ ok:false, err: String(e && e.message ? e.message : e) });
  }
});
app.post('/admin/set_greeting_window', (req, res) => {
  try {
    const mins = Number(req.query.minutes || req.body.minutes || GREETING_WINDOW_MINUTES);
    if (!isFinite(mins) || mins < 0) return res.status(400).json({ ok:false, err: "invalid minutes" });
    GREETING_WINDOW_MINUTES = mins;
    GREETING_WINDOW_MS = GREETING_WINDOW_MINUTES * 60 * 1000;
    return res.json({ ok:true, GREETING_WINDOW_MINUTES });
  } catch(e) { return res.status(500).json({ ok:false, err: String(e && e.message ? e.message : e) }); }
});

// MAIN webhook handler
app.post('/webhook', async (req, res) => {
  try {
    const body = req.body || {};
    if (DEBUG) console.log("📩 Incoming webhook hit:", typeof body === 'object' ? JSON.stringify(body).slice(0,800) : String(body).slice(0,800));
    // handle different webhook shapes
    const entry = body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value || body.entry?.[0]?.changes?.[0]?.value || body;
    const msg = value?.messages?.[0];
    const contact = value?.contacts?.[0];
    if (!msg) return res.sendStatus(200);

    const from = msg.from;
    const type = msg.type;
    const name = contact?.profile?.name || "Unknown";
    let msgText = "";
    let selectedId = null;
    if (type === "text") msgText = msg.text?.body || "";
    else if (type === "interactive") {
      selectedId = msg.interactive?.button_reply?.id || msg.interactive?.list_reply?.id || null;
      msgText = msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || "";
    } else {
      msgText = JSON.stringify(msg);
    }
    if (DEBUG) console.log("INBOUND", { from, type, sample: (msgText||'').slice(0,300) });

    // send admin alert (throttled)
    if (from !== ADMIN_WA) await sendAdminAlert({ from, name, text: msgText });

    // save lead locally + post to CRM non-blocking
    try {
      const lead = { from, name, text: msgText };
      saveLead(lead);
      postLeadToCRM({ from, name, text: msgText }).catch(()=>{});
    } catch (e) { console.warn("lead log failed", e && e.message ? e.message : e); }

    // handle interactive selections first
    if (selectedId) {
      switch (selectedId) {
        case "SRV_NEW_CAR":
          await waSendText(from, "Please share your *city, model, variant/suffix & profile (individual/company)*.");
          try { await sendNewCarButtons(from); } catch(e) { console.warn("sendNewCarButtons failed", e); }
          break;
        case "SRV_USED_CAR":
          await waSendText(from, "Share *make, model, year* (optional colour/budget) and I’ll suggest options.");
          try { await sendUsedCarButtons(from); } catch(e) { console.warn("sendUsedCarButtons failed", e); }
          break;
        case "SRV_SELL_CAR":
          await waSendText(from, "Please share *car make/model, year, km, city* and a few photos. We’ll get you the best quote.");
          try { await sendSellCarButtons(from); } catch(e) { console.warn("sendSellCarButtons failed", e); }
          break;
        case "SRV_LOAN":
          await waSendText(from, `For loan assistance, share *city + car model + budget*. New car ROI from *${NEW_CAR_ROI}%*, Used car *${USED_CAR_ROI_VISIBLE}%*.`);
          try { await sendLoanButtons(from); } catch(e) { console.warn("sendLoanButtons failed", e); }
          break;
        case "BTN_NEW_QUOTE":
          await waSendText(from, "Sure — please share city + model + variant/suffix + profile (individual/company).");
          break;
        case "BTN_NEW_LOAN":
        case "BTN_CHECK_ELIG":
          await waSendText(from, `You can use the EMI calculator by typing: \`emi <loan> <rate% optional> <months>\` e.g. \`emi 1500000 9.5 60\`.`);
          break;
        case "BTN_CONTACT_SALES":
          await waSendText(from, "Our sales team will contact you shortly. Please confirm your preferred time and phone number.");
          break;
        case "BTN_USED_PHOTOS":
          await waSendText(from, "Please upload photos (interior + exterior) and the RC copy. We'll evaluate and revert.");
          break;
        case "BTN_USED_LOAN":
          await waSendText(from, `For used car loans we generally approve in ~30 minutes subject to documents. To compute EMIs type \`emi <loan> <rate%> <months>\`.`);
          break;
        case "BTN_BULLET_CALC":
          await waSendText(from, "To calculate bullet EMI (used car), reply: `bullet <loan amount> <tenure months>` e.g., `bullet 750000 60`");
          break;
        case "BTN_SELL_QUOTE":
          await waSendText(from, "Please send RC copy, car pics, km driven, colour, make & model, and owner serial. We'll generate a quick quote.");
          break;
        case "BTN_SELL_HOW":
          await waSendText(from, "Our sell flow: 1) Upload details & photos 2) We evaluate & send offer 3) Book inspection 4) Payment / transfer. Docs required will be requested.");
          break;
        case "BTN_DOCS":
          // try fetch from CRM/SignatureSavings
          try {
            const docs = await fetchCRMReply({ from, msgText: "DOCS_LIST" });
            if (docs) await waSendText(from, docs);
            else await waSendText(from, "Documents generally required: 1) RC, 2) Insurance, 3) Address proof, 4) PAN, 5) Bank statements. (We will fetch detailed list soon.)");
          } catch(e){ await waSendText(from, "Documents generally required: RC, Insurance, Address proof, PAN, Bank statements."); }
          break;
        default:
          await waSendText(from, "Thanks! You can type your request anytime.");
      }
      return res.sendStatus(200);
    }

    // greeting
    if (shouldGreetNow(from, msgText)){
      await waSendText(from, `🔴 *MR. CAR* welcomes you!\nNamaste 🙏\n\nWe assist with *pre-owned cars*, *new car deals*, *loans* and *insurance*.\nTell us how we can help — or pick an option below.`);
      await waSendListMenu(from);
      return res.sendStatus(200);
    }

    // quick new car quote attempt
    if (msgText && type === "text") {
      const servedNew = await tryQuickNewCarQuote(msgText, from);
      if (servedNew) return res.sendStatus(200);
    }

    // used car budget search (message starting with budget or "budget <amount>")
    const budgetCmd = (msgText||"").trim().match(/^(?:budget|price)\s+(.+)$/i);
    if (budgetCmd) {
      const amt = parseBudgetText(budgetCmd[1]);
      if (!amt) { await waSendText(from, "Send: `budget <amount>` e.g. `budget 15l` or `budget 1500000`."); return res.sendStatus(200); }
      const results = await searchUsedByBudget(amt, 8);
      if (!results.length) { await waSendText(from, `No used cars found in that budget range. Would you like us to show similar models? Reply 'brands' or ask again.`); return res.sendStatus(200); }
      // list compact results
      const lines = [`*SEARCH RESULTS — Budget: ₹ ${fmtMoney(amt)}*`];
      results.forEach((r,i)=>{
        lines.push(`${i+1}) ${String(r.make||"").toUpperCase()} ${String(r.model||"").toUpperCase()} — ₹ ${fmtMoney(r.price)} — ${String(r.km||"")} — ${String(r.color||"")} — ${String(r.reg||"")}`);
      });
      lines.push(`\nReply with the *number* to get full details & EMI (e.g., reply '1').`);
      await waSendText(from, lines.join("\n"));
      // store last search into leads (so selection mapping can reference); simple in-memory store per number
      try {
        const qb = safeJsonRead(path.resolve(__dirname, 'last_budget_search.json'));
        qb[from] = results.map(r => ({ price: r.price, make: r.make, model: r.model, raw: r.raw }));
        safeJsonWrite(path.resolve(__dirname, 'last_budget_search.json'), qb);
      } catch(e){}
      await sendUsedCarButtons(from);
      return res.sendStatus(200);
    }

    // number selection after budget list (user replies "1" or "2")
    const selNumber = (msgText||"").trim().match(/^(\d{1,2})$/);
    if (selNumber) {
      const idx = Number(selNumber[1]) - 1;
      try {
        const qb = safeJsonRead(path.resolve(__dirname, 'last_budget_search.json')) || {};
        const arr = qb[from] || [];
        if (arr && arr[idx]) {
          const rec = arr[idx];
          // build full details & EMIs
          const price = Number(rec.price || 0);
          const loanAmt = Math.round(price * 0.95);
          const normal_emi = calcEmiSimple(loanAmt, USED_CAR_ROI_VISIBLE, 60);
          const bulletSim = simulateBulletPlan({ loanAmount: loanAmt, months: 60, internalRatePct: USED_CAR_ROI_INTERNAL, bulletPct: 0.25 });
          const lines = [];
          lines.push(`*${String(rec.make||"").toUpperCase()} ${String(rec.model||"").toUpperCase()}*`);
          lines.push(`Expected Price: ₹ *${fmtMoney(price)}*`);
          lines.push(`Loan (95%): ₹ *${fmtMoney(loanAmt)}*`);
          lines.push(`📌 *EMI (Normal 60m @ ${USED_CAR_ROI_VISIBLE}%):* ₹ *${fmtMoney(normal_emi)}*`);
          if (bulletSim) {
            lines.push(`📌 *Bullet Plan (25% bullets across tenure)*`);
            lines.push(`• Monthly EMI (amortising): ₹ *${fmtMoney(bulletSim.monthly_emi)}*`);
            lines.push(`• Bullet each: ₹ *${fmtMoney(bulletSim.bullet_each)}* on months: ${Array.from({length: bulletSim.num_bullets}, (_,i) => (12*(i+1))).join(" • ")}`);
            lines.push(`📊 Total payable (EMIs + bullets): ₹ *${fmtMoney(bulletSim.total_payable)}*`);
            lines.push(`💰 Interest (approx): ₹ *${fmtMoney(bulletSim.total_interest)}*`);
            lines.push(`\n*Shown ROI:* ${USED_CAR_ROI_VISIBLE}% — *Bullet math uses ${USED_CAR_ROI_INTERNAL}% internally.*`);
            lines.push(`✅ *Loan approval possible in ~30 minutes (T&Cs apply)*`);
          }
          lines.push("\n*Terms & Conditions Apply ✅*");
          await waSendText(from, lines.join("\n"));
          await sendUsedCarButtons(from);
          return res.sendStatus(200);
        }
      } catch(e){}
    }

    // bullet calculator "bullet 750000 60" or with rate
    const bulletCmd = (msgText||"").trim().match(/^bullet\s+([\d,]+)\s*(\d+)?(?:\s*([\d.]+))?/i);
    if (bulletCmd) {
      const loanRaw = String(bulletCmd[1]||"").replace(/[,₹\s]/g,"");
      const months = Number(bulletCmd[2] || 60);
      const loanAmt = Number(loanRaw);
      if (!loanAmt || !months) {
        await waSendText(from, "Please send: `bullet <loan amount> <tenure months>` e.g. `bullet 750000 60`");
        return res.sendStatus(200);
      }
      const sim = simulateBulletPlan({ loanAmount: loanAmt, months, internalRatePct: USED_CAR_ROI_INTERNAL, bulletPct:0.25 });
      if (!sim) { await waSendText(from, "Bullet calculation failed."); return res.sendStatus(200); }
      const lines = [];
      lines.push(`🔷 *Bullet EMI Plan — Used Car*`);
      lines.push(`Loan Amount: ₹ *${fmtMoney(sim.loan)}*`);
      lines.push(`Tenure: *${sim.months} months*`);
      lines.push(`📌 Monthly EMI (amortising): ₹ *${fmtMoney(sim.monthly_emi)}*`);
      lines.push(`📌 Bullet total (25%): ₹ *${fmtMoney(sim.bullet_total)}*`);
      lines.push(`• Bullet each: ₹ *${fmtMoney(sim.bullet_each)}* on months: ${Array.from({length: sim.num_bullets}, (_,i) => (12*(i+1))).join(" • ")}`);
      lines.push("");
      lines.push(`📊 Total payable (EMIs + bullets): ₹ *${fmtMoney(sim.total_payable)}*`);
      lines.push(`💰 Total interest (approx): ₹ *${fmtMoney(sim.total_interest)}*`);
      lines.push("");
      lines.push(`✅ *Loan approval possible in ~30 minutes (T&Cs apply)*`);
      lines.push("");
      lines.push(`\n*Terms & Conditions Apply ✅*`);
      await waSendText(from, lines.join("\n"));
      try { postLeadToCRM({ from, name, text: `BULLET_CALC ${loanAmt} ${months}` }); } catch(e){}
      return res.sendStatus(200);
    }

    // emi calculator
    const emiCmd = (msgText||"").trim().match(/^emi\s+([\d,]+)(?:\s+([\d\.]+)%?)?\s*(\d+)?/i);
    if (emiCmd) {
      const loanRaw = String(emiCmd[1]||"").replace(/[,₹\s]/g,"");
      let rate = Number(emiCmd[2] || NEW_CAR_ROI);
      const months = Number(emiCmd[3] || 60);
      const loanAmt = Number(loanRaw);
      if (!loanAmt || !months) {
        await waSendText(from, "Please send: `emi <loan amount> <rate% optional> <tenure months>` e.g. `emi 1500000 9.5 60`");
        return res.sendStatus(200);
      }
      const monthly = calcEmiSimple(loanAmt, rate, months);
      const total = monthly * months;
      const interest = total - loanAmt;
      const lines = [
        `🔸 EMI Calculation`,
        `Loan: ₹ *${fmtMoney(loanAmt)}*`,
        `Rate: *${rate}%* p.a.`,
        `Tenure: *${months} months*`,
        ``,
        `📌 Monthly EMI: ₹ *${fmtMoney(monthly)}*`,
        `📊 Total Payable: ₹ *${fmtMoney(total)}*`,
        `💰 Total Interest: ₹ *${fmtMoney(interest)}*`,
        ``,
        `✅ *Loan approval possible in ~30 minutes (T&Cs apply)*`,
        `\n*Terms & Conditions Apply ✅*`
      ].join("\n");
      await waSendText(from, lines);
      return res.sendStatus(200);
    }

    // ask CRM for reply fallback
    try {
      const crmReply = await fetchCRMReply({ from, msgText });
      if (crmReply) { await waSendText(from, crmReply); return res.sendStatus(200); }
    } catch (e) { console.warn("CRM reply failed", e && e.message ? e.message : e); }

    // default fallback
    await waSendText(from, "Tell me your *city + make/model + variant/suffix + profile (individual/company)*. e.g., *Delhi Hycross ZXO individual* or *HR BMW X1 sDrive18i company*.");
    return res.sendStatus(200);
  } catch (err) {
    console.error("Webhook error:", err && err.stack ? err.stack : err);
    try { if (ADMIN_WA) await waSendText(ADMIN_WA, `Webhook crash: ${String(err && err.message ? err.message : err)}`); } catch(e){}
    return res.sendStatus(200);
  }
});

// ---------------- start server ----------------
app.listen(PORT, ()=> {
  console.log(`✅ MR.CAR webhook CRM server running on port ${PORT}`);
  console.log("ENV summary:", {
    SHEET_TOYOTA_CSV_URL: !!SHEET_TOYOTA_CSV_URL,
    SHEET_USED_CSV_URL: !!SHEET_USED_CSV_URL || fs.existsSync(LOCAL_USED_CSV_PATH),
    PHONE_NUMBER_ID: !!PHONE_NUMBER_ID, META_TOKEN: !!META_TOKEN, ADMIN_WA: !!ADMIN_WA, DEBUG
  });
});
