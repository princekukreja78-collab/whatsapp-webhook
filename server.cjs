// server.cjs — MR.CAR webhook (patched)
// Paste this file over your existing server.cjs (keep a backup before replacing)

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const fetch = (global.fetch) ? global.fetch : require('node-fetch');
const app = express();
app.use(express.json());

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

const LOCAL_USED_CSV_PATH = path.resolve(__dirname, "PRE OWNED CAR PRICING - USED CAR.csv");

const PORT = process.env.PORT || 10000;
const DEBUG = process.env.DEBUG_VARIANT === "true" || true;

const MAX_QUOTE_PER_DAY = Number(process.env.MAX_QUOTE_PER_DAY || 10); // competitor protection
const QUOTE_LIMIT_FILE = path.resolve(__dirname, "quote_limit.json");
const LEADS_FILE = path.resolve(__dirname, "crm_leads.json");

const NEW_CAR_ROI = Number(process.env.NEW_CAR_ROI || 8.10);
const USED_CAR_ROI_VISIBLE = 9.99; // shown to users for used cars
const USED_CAR_ROI_INTERNAL = 10.00; // internal computation rate for bullet math

// ---------------- Helpers ----------------
function safeJsonRead(filename){
  try {
    if (!fs.existsSync(filename)) return {};
    const txt = fs.readFileSync(filename, 'utf8') || '';
    return txt ? JSON.parse(txt) : {};
  } catch(e) { return {}; }
}
function safeJsonWrite(filename, obj){
  try { fs.writeFileSync(filename, JSON.stringify(obj, null, 2), 'utf8'); return true; } catch(e){ return false; }
}

// ---------------- CRM lead persistence ----------------
function saveLead(lead) {
  try {
    const existing = Array.isArray(safeJsonRead(LEADS_FILE)) ? safeJsonRead(LEADS_FILE) : (safeJsonRead(LEADS_FILE).leads || []);
    let arr = Array.isArray(existing) ? existing : (Array.isArray(existing.leads) ? existing.leads : []);
    arr.unshift({ ...lead, ts: Date.now() });
    arr = arr.slice(0, 1000);
    fs.writeFileSync(LEADS_FILE, JSON.stringify(arr, null, 2), 'utf8');
    if (DEBUG) console.log("✅ Lead saved:", lead.from, (lead.text||'').slice(0,120));
    return true;
  } catch (e) { console.error("❌ Failed to save lead", e && e.message ? e.message : e); return false; }
}
app.get("/leads", (req, res) => {
  try {
    if (fs.existsSync(LEADS_FILE)) {
      const raw = fs.readFileSync(LEADS_FILE, "utf8") || "[]";
      return res.json(JSON.parse(raw));
    }
    res.json([]);
  } catch (e) { res.json([]); }
});

// ---------------- Quote limits ----------------
function loadQuoteLimits(){ return safeJsonRead(QUOTE_LIMIT_FILE) || {}; }
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
  } catch(e) {}
}

// ---------------- WA helpers ----------------
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
    return j;
  } catch(e) { console.error("waSendRaw failed", e && e.stack ? e.stack : e); return null; }
}
async function waSendText(to, body){ return waSendRaw({ messaging_product:"whatsapp", to, type:"text", text:{ body } }); }

// compact list menu (keep it simple and clear)
async function waSendListMenu(to){
  const interactive = {
    type: "list",
    header:{ type:"text", text:"MR. CAR SERVICES" },
    body:{ text:"Please choose one option 👇" },
    footer:{ text:"Premium Deals • Trusted Service • Mr. Car" },
    action:{ button:"Select Service", sections:[ { title:"Available", rows: [
      { id:"SRV_NEW_CAR", title:"New Car Deals", description:"On-road prices & offers" },
      { id:"SRV_USED_CAR", title:"Pre-Owned Cars", description:"Certified used inventory" },
      { id:"SRV_SELL_CAR", title:"Sell My Car", description:"Best selling quote" },
      { id:"SRV_LOAN", title:"Loan / Finance", description:"Fast approvals & low ROI" }
    ] } ] }
  };
  return waSendRaw({ messaging_product:"whatsapp", to, type:"interactive", interactive });
}

async function sendNewCarButtons(to){
  const payload = { messaging_product:"whatsapp", to, type:"interactive", interactive:{
    type:"button", body:{ text:"You can continue with these quick actions:" }, action:{ buttons:[
      { type:"reply", reply:{ id:"BTN_NEW_QUOTE", title:"Another Quote" } },
      { type:"reply", reply:{ id:"BTN_NEW_LOAN", title:"Loan / EMI Calc" } },
      { type:"reply", reply:{ id:"BTN_CONTACT_SALES", title:"Contact Sales" } }
    ]}}};
  return waSendRaw(payload);
}

// sendUsedCarButtons now caps to 3, prefer photos, loan, bullet
async function sendUsedCarButtons(to, hasPhotoLink){
  const buttons = [];
  if (hasPhotoLink) buttons.push({ type:"reply", reply:{ id:"BTN_USED_PHOTOS", title:"View Photos 📸" } });
  buttons.push({ type:"reply", reply:{ id:"BTN_USED_LOAN", title:"Loan Options" } });
  buttons.push({ type:"reply", reply:{ id:"BTN_USED_BULLET", title:"Bullet EMI Calc" } });
  const finalButtons = buttons.slice(0,3);
  return waSendRaw({ messaging_product:"whatsapp", to, type:"interactive", interactive:{ type:"button", body:{ text:"Quick actions:" }, action:{ buttons: finalButtons } }});
}

// admin alert
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

// ---------------- CSV parsing ----------------
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

// Robust fetchCsv — follows redirects and extracts CSV href if Google returns Temporary Redirect page
async function fetchCsv(url){
  if(!url) throw new Error("CSV URL missing");
  const opts = { cache: "no-store", redirect: "follow", headers: { "User-Agent": "Mozilla/5.0 (compatible; MR.CAR/1.0)" } };
  try {
    const r = await fetch(url, opts);
    const txt = await r.text();
    if (/<html/i.test(txt) || /Temporary Redirect/i.test(txt)) {
      const hrefMatch = txt.match(/href="([^"]*output=csv[^"]*)"/i) || txt.match(/href="([^"]*)"/i);
      if (hrefMatch && hrefMatch[1]) {
        const candidate = hrefMatch[1].replace(/&amp;/g,'&');
        if (candidate.startsWith('http')) {
          const r2 = await fetch(candidate, opts);
          if (!r2.ok) throw new Error(`CSV fetch failed (redirect target) ${r2.status}`);
          return parseCsv(await r2.text());
        }
      }
      const location = r.headers && (r.headers.get && r.headers.get('location'));
      if (location) {
        const r3 = await fetch(location, opts);
        if (!r3.ok) throw new Error(`CSV fetch failed (location) ${r3.status}`);
        return parseCsv(await r3.text());
      }
      throw new Error("CSV fetch returned HTML and no redirect link was found.");
    }
    if (!r.ok) throw new Error(`CSV fetch failed ${r.status}`);
    return parseCsv(txt);
  } catch (e) {
    throw new Error("fetchCsv error: " + (e && e.message ? e.message : String(e)));
  }
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

function toHeaderIndexMap(headerRow){
  const map = {};
  headerRow.forEach((h,i) => { map[String((h||"").trim()).toUpperCase()] = i; });
  return map;
}

// helper: build variant map (if table contains VARIANT_KEYWORDS or VARIANT)
function normForMatch(s){
  return (s||"").toString().toLowerCase()
    .replace(/(automatic|automatic transmission|\bauto\b)/g, " at ")
    .replace(/\bautomatic\b/g," at ")
    .replace(/\bauto\b/g," at ")
    .replace(/\bmanual\b/g," mt ")
    .replace(/\bman\b/g," mt ")
    .replace(/[\*\/\\]/g, "x")
    .replace(/\s*x\s*/g, "x")
    .replace(/(\d)\s*x\s*(\d)/g,"$1x$2")
    .replace(/[^a-z0-9\s]/g," ")
    .replace(/\s+/g," ")
    .trim();
}

function buildVariantMapForTable(table){
  if(!table||!table.idxMap) return null;
  const im = table.idxMap;
  const data = table.data||[];
  const vIdx = im["VARIANT"] ?? im["SUFFIX"] ?? -1;
  const kwIdx = im["VARIANT_KEYWORDS"] ?? -1;
  const mIdx = im["MODEL"] ?? im["VEHICLE"] ?? -1;
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
      try { tab.variantMap = buildVariantMapForTable(tab); } catch(e){ tab.variantMap = null; }
      tables[brand] = tab;
      if (DEBUG) console.log("Loaded pricing table:", brand, "rows:", data.length, "headers:", header.slice(0,8));
    } catch(e) { console.warn("CSV load failed for", brand, e && e.message ? e.message : e); }
  }
  PRICING_CACHE.tables = tables; PRICING_CACHE.ts = Date.now();
  return tables;
}

// ---------------- Used car sheet loader (local fallback) ----------------
async function loadUsedSheet(){
  // prefer remote URL env var
  if (SHEET_USED_CSV_URL){
    try {
      const rows = await fetchCsv(SHEET_USED_CSV_URL);
      if (rows && rows.length) return rows;
    } catch(e) { if (DEBUG) console.warn("remote used csv fetch failed", e && e.message ? e.message : e); }
  }
  // fallback to local file if present
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
function calcEmiSimple(p, annualRatePct, months){
  const P = Number(p); const r = Number(annualRatePct)/12/100;
  if(!P || !isFinite(r) || months <= 0) return 0;
  const pow = Math.pow(1+r, months);
  const emi = Math.round(P * r * pow / (pow - 1));
  return emi;
}
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
      bullet_paid = Math.min(bullet_each, Math.max(0, (L - (principal + total_bullets_paid))));
      if (m === (num_bullets * 12)) {
        const already = total_bullets_paid;
        bullet_paid = Math.max(0, bullet_total - already);
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

// ---------------- Build used car quote ----------------
async function buildUsedCarQuote({ make, model, year }) {
  try {
    const rows = await loadUsedSheet();
    if (!rows || !rows.length) return { text: "Used car pricing not configured." };
    const header = rows[0].map(h => String(h||"").toUpperCase());
    const data = rows.slice(1);

    // debug header
    if (DEBUG) console.log("USED sheet header:", header.slice(0,12));

    // find indexes robustly
    const findHeaderIndex = (cands) => {
      for (const c of cands){
        const idx = header.findIndex(h => String(h||"").includes(c));
        if (idx >= 0) return idx;
      }
      return -1;
    };
    const makeIdx = findHeaderIndex(["MAKE","BRAND","MANUFACTURER"]);
    const modelIdx = findHeaderIndex(["MODEL","VEHICLE","CAR"]);
    const expectedIdx = findHeaderIndex(["EXPECTED","EXPECTED PRICE","EXPECTED_PRICE","PRICE","EXPECTED_PRICE (INR)","EXPECTED VALUE"]);
    // fallback to numeric first column if expected not found
    let expectedStr = "";
    if (expectedIdx >= 0) expectedStr = String(rows[1][expectedIdx]||'');
    let price = Number(String(expectedStr||'').replace(/[,₹\s]/g,'')) || 0;
    if (!price) {
      // search row for first numeric cell (per row found)
    }

    // find candidate row matching make/model
    const makeLower = (make||"").toLowerCase();
    const modelLower = (model||"").toLowerCase();
    let findRow = null;
    for (const r of data) {
      const a = String(r[makeIdx]||"").toLowerCase();
      const b = String(r[modelIdx]||"").toLowerCase();
      if (a.includes(makeLower) && b.includes(modelLower)) { findRow = r; break; }
    }
    if (!findRow) {
      for (const r of data){
        const a = String(r[makeIdx]||"").toLowerCase();
        const b = String(r[modelIdx]||"").toLowerCase();
        if (a.includes(makeLower) || b.includes(modelLower)) { findRow = r; break; }
      }
    }
    if (!findRow) return { text: `Sorry, I couldn’t find the used car *${make} ${model}* right now.` };

    // determine price from matched row
    let rowPrice = 0;
    if (expectedIdx >= 0) rowPrice = Number(String(findRow[expectedIdx]||'').replace(/[,₹\s]/g,'')) || 0;
    if (!rowPrice) {
      // fallback: pick first numeric cell in the row
      for (let i=0;i<findRow.length;i++){
        const v = String(findRow[i]||"").replace(/[,₹\s]/g,"");
        if (/^\d+$/.test(v)) { rowPrice = Number(v); break; }
      }
    }
    if (!rowPrice) return { text: `Price for *${make} ${model}* not available.` };

    const loanAmt = rowPrice;
    const tenureDefault = 60;
    const normalEMI_display = calcEmiSimple(loanAmt, USED_CAR_ROI_INTERNAL, tenureDefault);
    const bulletSim = simulateBulletPlan({ loanAmount: loanAmt, months: tenureDefault, internalRatePct: USED_CAR_ROI_INTERNAL, bulletPct: 0.25 });

    const makeText = String(findRow[makeIdx]||"").toUpperCase();
    const modelText = String(findRow[modelIdx]||"").toUpperCase();
    const lines = [];
    lines.push(`*PRE-OWNED CAR QUOTE*`);
    lines.push(`Make/Model: *${makeText} ${modelText}*`);
    lines.push(`Expected Price: ₹ *${fmtMoney(rowPrice)}*`);
    lines.push(`ROI (Used Car): *${USED_CAR_ROI_VISIBLE}%* (visible)`);
    lines.push(`Tenure (example): *${tenureDefault} months*`);
    lines.push("");
    lines.push(`📌 *Normal EMI*`);
    lines.push(`• EMI (${tenureDefault} months): ₹ *${fmtMoney(normalEMI_display)}*`);
    lines.push("");
    if (bulletSim) {
      lines.push(`📌 *Bullet EMI Plan (25% across tenure)*`);
      lines.push(`• Monthly EMI: ₹ *${fmtMoney(bulletSim.monthly_emi)}*`);
      lines.push(`• Bullet total (25%): ₹ *${fmtMoney(bulletSim.bullet_total)}*`);
      lines.push(`  → ₹ *${fmtMoney(bulletSim.bullet_each)}* on months: ${Array.from({length: bulletSim.num_bullets}, (_,i) => (12*(i+1))).join(" • ")}`);
      lines.push("");
      lines.push(`📊 *Total payable (EMIs + bullets):* ₹ *${fmtMoney(bulletSim.total_payable)}*`);
      lines.push(`💰 *Interest (approx):* ₹ *${fmtMoney(bulletSim.total_interest)}*`);
      lines.push("");
      lines.push(`✅ *Loan approval possible in ~30 minutes (T&Cs apply)*`);
    }
    lines.push("");
    lines.push(`\n*Terms & Conditions Apply ✅*`);
    const text = lines.filter(Boolean).join("\n");
    return { text, picLink: null };
  } catch(e){
    console.error("buildUsedCarQuote error", e && e.stack ? e.stack : e);
    return { text: "Used car pricing failed." , picLink:null};
  }
}

// ---------------- Try quick new car quote ----------------
function detectExShowIdx(idxMap){
  let exIdx = idxMap["EX SHOWROOM PRICE"] ?? idxMap["EX-SHOWROOM PRICE"] ?? idxMap["EX SHOWROOM"] ?? idxMap["EX SHOWROOM PRICE (₹)"] ?? idxMap["EX SHOWROOM PRICE (INR)"] ?? -1;
  if(exIdx<0){
    const headerKeys=Object.keys(idxMap);
    const fuzzyKey = headerKeys.find(h=>/EX[\s\-_\/A-Z0-9]*SHOWROOM/.test(String(h)));
    if(fuzzyKey) exIdx = idxMap[fuzzyKey];
  }
  if(exIdx<0){
    const headerKeysLower = Object.keys(idxMap).map(k=>String(k).toLowerCase());
    const pick = headerKeysLower.find(k => k.includes("ex") && k.includes("showroom"));
    if(pick){ const orig = Object.keys(idxMap).find(k => String(k).toLowerCase()===pick); if(orig) exIdx = idxMap[orig]; }
  }
  return exIdx;
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
    let raw = t.replace(/\b(delhi|dilli|haryana|hr|chandigarh|chd|uttar pradesh|up|himachal|hp)\b/g," ")
      .replace(/\b(individual|company|corporate|firm|personal)\b/g," ")
      .replace(/[^\w\s]/g," ").replace(/\s+/g," ").trim();
    const modelGuess = raw.split(' ').slice(0,2).join(' ');
    for (const [brand, tab] of Object.entries(tables)){
      if (!tab || !tab.data) continue;
      const header = tab.header.map(h => String(h||"").toUpperCase());
      const idxModel = header.findIndex(h=> h.includes("MODEL") || h.includes("VEHICLE"));
      const idxVariant = header.findIndex(h => h.includes("VARIANT") || h.includes("SUFFIX"));
      // try variantMap first if available
      try {
        const vm = tab.variantMap;
        if (vm) {
          const vmatch = vm.find(v => Array.from(v.keywords).some(k => modelGuess && modelGuess.includes(k)) );
          if (vmatch) {
            const hit = tab.data[vmatch.rowIndex];
            const idxMap = tab.idxMap || toHeaderIndexMap(header);
            const priceIdx = (Object.values(idxMap).find(i => true), (() => {
              const cityToken = city.split(' ')[0].toUpperCase();
              for (const k of Object.keys(idxMap)){ if (k.includes("ON ROAD") && k.includes(cityToken)) return idxMap[k]; }
              // fallback numeric
              for (let i=0;i<hit.length;i++){
                const v = String(hit[i]||"").replace(/[,₹\s]/g,"");
                if (/^\d+$/.test(v)) return i;
              }
              return -1;
            })());
            const onroad = priceIdx >= 0 ? Number(String(hit[priceIdx]||"").replace(/[,₹\s]/g,"")) || 0 : 0;
            const exShow = detectExShowIdx(idxMap) >= 0 ? Number(String(hit[detectExShowIdx(idxMap)]||"").replace(/[,₹\s]/g,"")) || 0 : 0;
            const loanAmt = exShow || onroad || 0;
            const emi60 = loanAmt ? calcEmiSimple(loanAmt, NEW_CAR_ROI, 60) : 0;
            const lines = [
              `*${brand}* ${String(hit[idxModel]||"").toUpperCase()} ${String(hit[idxVariant]||"").toUpperCase()}`,
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
      } catch(e){}
      // fallback row scan
      for (const row of tab.data){
        const modelCell = idxModel>=0 ? String(row[idxModel]||"").toLowerCase() : "";
        const variantCell = idxVariant>=0 ? String(row[idxVariant]||"").toLowerCase() : "";
        if ((modelCell && modelCell.includes(modelGuess)) || (variantCell && variantCell.includes(modelGuess))) {
          const idxMap = tab.idxMap || toHeaderIndexMap(header);
          // find on road by city
          let priceIdx = -1;
          const cityToken = city.split(' ')[0].toUpperCase();
          for (const k of Object.keys(idxMap)){
            if (k.includes("ON ROAD") && k.includes(cityToken)) { priceIdx = idxMap[k]; break; }
          }
          if (priceIdx < 0) {
            for (let i=0;i<row.length;i++){
              const v = String(row[i]||"").replace(/[,₹\s]/g,"");
              if (v && /^\d+$/.test(v)) { priceIdx = i; break; }
            }
          }
          const priceStr = priceIdx >= 0 ? String(row[priceIdx]||"") : "";
          const onroad = Number(String(priceStr||"").replace(/[,₹\s]/g,"")) || 0;
          if (!onroad) continue;
          const exShow = detectExShowIdx(idxMap) >= 0 ? Number(String(row[detectExShowIdx(idxMap)]||"").replace(/[,₹\s]/g,"")) || 0 : 0;
          const loanAmt = exShow || onroad || 0;
          const emi60 = loanAmt ? calcEmiSimple(loanAmt, NEW_CAR_ROI, 60) : 0;
          const lines = [
            `*${brand}* ${String(row[idxModel]||"").toUpperCase()} ${String(row[idxVariant]||"").toUpperCase()}`,
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

// ---------------- Greeting helper ----------------
if (typeof global.lastGreeting === "undefined") global.lastGreeting = new Map();
const lastGreeting = global.lastGreeting;
if (typeof global.resetGreetingEndpointAdded === "undefined") global.resetGreetingEndpointAdded = false;

const GREETING_WINDOW_MINUTES = Number(process.env.GREETING_WINDOW_MINUTES || 600);
function shouldGreetNow(from, msgText){
  try {
    if (ADMIN_WA && from === ADMIN_WA) return false;
    const now = Date.now(); const prev = lastGreeting.get(from) || 0;
    const text = (msgText||"").trim().toLowerCase();
    const looksLikeGreeting = /^(hi|hello|hey|namaste|enquiry|inquiry|help|start)\b/.test(text) || prev === 0;
    if (!looksLikeGreeting) return false;
    if (now - prev < GREETING_WINDOW_MINUTES * 60 * 1000) return false;
    lastGreeting.set(from, now);
    return true;
  } catch(e){ return false; }
}

// ---------------- CRM helpers (external file) ----------------
let postLeadToCRM = async ()=>{};
let fetchCRMReply = async ()=>{ return null; };
try {
  const crmHelpers = require('./crm_helpers.cjs');
  postLeadToCRM = crmHelpers.postLeadToCRM || postLeadToCRM;
  fetchCRMReply = crmHelpers.fetchCRMReply || fetchCRMReply;
  if (DEBUG) console.log("crm_helpers.cjs loaded");
} catch(e) { if (DEBUG) console.log("crm_helpers.cjs not loaded (ok for dev).", e && e.message ? e.message : e); }

// ---------------- Webhook & routing ----------------
app.get("/healthz", (req, res) => res.json({ ok: true, t: Date.now(), debug: DEBUG }));

// META verify (GET)
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

// MAIN handler (POST)
app.post('/webhook', async (req, res) => {
  if (DEBUG) console.log("📩 Incoming webhook hit:", typeof req.body === 'object' ? JSON.stringify(req.body).slice(0,1000) : String(req.body).slice(0,1000));
  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value || {};
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

    if (from !== ADMIN_WA) await sendAdminAlert({ from, name, text: msgText });

    try {
      const lead = { from, name, text: msgText };
      postLeadToCRM({ from, name, text: msgText }).catch(()=>{});
      saveLead(lead);
    } catch (e) {}

    if (selectedId) {
      switch(selectedId){
        case "SRV_NEW_CAR":
        case "BTN_NEW_QUOTE":
          await waSendText(from, "Please share your *city, model, variant/suffix & profile (individual/company)*.");
          break;
        case "SRV_USED_CAR":
        case "BTN_USED_MORE":
          await waSendText(from, "Share *make, model, year* (optional colour/budget) and I’ll suggest options.");
          break;
        case "SRV_SELL_CAR":
          await waSendText(from, "Please share *car make/model, year, km, city* and a few photos. We’ll get you the best quote.");
          break;
        case "SRV_LOAN":
        case "BTN_NEW_LOAN":
        case "BTN_USED_LOAN":
          await waSendText(from, `For loan assistance, share *city + car model + budget*. New car ROI from *${NEW_CAR_ROI}%*, Used car *${USED_CAR_ROI_VISIBLE}%*.`);
          break;
        case "BTN_USED_PHOTOS":
          await waSendText(from, "Please tap the Google Drive link in the quote to view photos. If missing, reply “photos please”.");
          break;
        case "BTN_USED_BULLET":
          await waSendText(from, "To calculate bullet EMI (used car), reply: `bullet <loan amount> <tenure months>` e.g., `bullet 750000 60`");
          break;
        case "BTN_CONTACT_SALES":
          await waSendText(from, "Thanks — our sales team will contact you shortly. Please share preferred callback time.");
          break;
        default:
          await waSendText(from, "Thanks! You can type your request anytime.");
      }
      return res.sendStatus(200);
    }

    if (shouldGreetNow(from, msgText)){
      await waSendText(from, `🔴 *MR. CAR* welcomes you!\nNamaste 🙏\n\nWe assist with *pre-owned cars*, *new car deals*, *loans* and *insurance*.\nTell us how we can help — or pick an option below.`);
      await waSendListMenu(from);
      return res.sendStatus(200);
    }

    if (msgText && type === "text") {
      const servedNew = await tryQuickNewCarQuote(msgText, from);
      if (servedNew) return res.sendStatus(200);
    }

    const usedMatch = (msgText || "").match(/used\s+(?<make>[a-z0-9]+)\s+(?<model>[a-z0-9]+)\s*(?<year>\d{4})?/i)
                    || (msgText || "").match(/(?<make>[a-z0-9]+)\s+(?<model>[a-z0-9]+)\s*(?<year>\d{4})?/i);
    if (usedMatch && usedMatch.groups) {
      const { make, model, year } = usedMatch.groups;
      const q = await buildUsedCarQuote({ make, model, year });
      if (q && q.text) {
        await waSendText(from, q.text);
        await sendUsedCarButtons(from, !!q.picLink);
        return res.sendStatus(200);
      }
    }

    const bulletCmd = (msgText||"").trim().match(/^bullet\s+([\d,]+)\s*(\d+)?/i);
    if (bulletCmd) {
      const loanRaw = String(bulletCmd[1]||"").replace(/[,₹\s]/g,"");
      const months = Number(bulletCmd[2]||60);
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
      lines.push(`ROI (shown): *${USED_CAR_ROI_VISIBLE}%*`);
      lines.push(`Tenure: *${sim.months} months*`);
      lines.push("");
      lines.push(`📌 Monthly EMI (amortising principal excluding bullets): ₹ *${fmtMoney(sim.monthly_emi)}*`);
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

    try {
      const crmReply = await fetchCRMReply({ from, msgText });
      if (crmReply) { await waSendText(from, crmReply); return res.sendStatus(200); }
    } catch (e) { console.warn("CRM reply failed", e && e.message ? e.message : e); }

    await waSendText(from, "Tell me your *city + make/model + variant/suffix + profile (individual/company)*. e.g., *Delhi Hycross ZXO individual* or *HR BMW X1 sDrive18i company*.");
    return res.sendStatus(200);
  } catch (err) {
    console.error("Webhook error:", err && err.stack ? err.stack : err);
    try { await waSendText(process.env.ADMIN_WA, `Webhook crash: ${String(err && err.message ? err.message : err)}`); } catch(e){}
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

  // add admin helper endpoints (non-destructive)
  try {
    if (!global.resetGreetingEndpointAdded) {
      app.post('/admin/reset_greetings', (req, res) => {
        try { lastGreeting.clear(); return res.json({ ok: true, msg: "greetings cleared" }); } catch(e){ return res.status(500).json({ ok:false, err:String(e) }); }
      });
      app.post('/admin/set_greeting_window', (req, res) => {
        try {
          const mins = Number(req.query.minutes || req.body.minutes || 0);
          if (!isFinite(mins) || mins < 0) return res.status(400).json({ ok:false, err: "invalid minutes" });
          process.env.GREETING_WINDOW_MINUTES = String(mins);
          return res.json({ ok:true, minutes: mins });
        } catch(e){ return res.status(500).json({ ok:false, err:String(e) }); }
      });
      global.resetGreetingEndpointAdded = true;
    }
  } catch(e){}
});
