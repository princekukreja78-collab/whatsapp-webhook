// server.cjs — MR.CAR webhook (FINAL with new-car variants & loan menu)
// ✅ Used car: LTV=95% + normal/bullet EMI + registration place
// ✅ New car: quick quote + variant list when only model name is given
// ✅ Budget queries: 15 lakh / 15 lac budget handled
// ✅ Loan & finance: 3-option menu (EMI calculator, Documents, Eligibility)
// ✅ Admin alerts, CRM posting, status-only events ignored

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const app = express();
app.use(express.json());

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

const LOCAL_USED_CSV_PATH = path.resolve(__dirname, "PRE OWNED CAR PRICING - USED CAR.csv");

const PORT = process.env.PORT || 10000;

// ---------------- Configs ----------------
const MAX_QUOTE_PER_DAY   = Number(process.env.MAX_QUOTE_PER_DAY || 10);
const QUOTE_LIMIT_FILE    = path.resolve(__dirname, "quote_limit.json");
const LEADS_FILE          = path.resolve(__dirname, "crm_leads.json");

const NEW_CAR_ROI         = Number(process.env.NEW_CAR_ROI || 8.10);
const USED_CAR_ROI_VISIBLE   = Number(process.env.USED_CAR_ROI_VISIBLE || 9.99);
const USED_CAR_ROI_INTERNAL  = Number(process.env.USED_CAR_ROI_INTERNAL || 10.0);
const USED_CAR_LTV_PCT       = Number(process.env.USED_CAR_LTV_PCT || 95); // loan as % of price

// DEBUG controlled only by env
const DEBUG = String(process.env.DEBUG_VARIANT || "true").toLowerCase() === "true";

// ---------------- file helpers ----------------
function safeJsonRead(filename){
  try {
    if (!fs.existsSync(filename)) return {};
    const txt = fs.readFileSync(filename, 'utf8') || '';
    return txt ? JSON.parse(txt) : {};
  } catch(e) {
    if (DEBUG) console.warn("safeJsonRead failed", e && e.message ? e.message : e);
    return {};
  }
}
function safeJsonWrite(filename, obj){
  try {
    fs.writeFileSync(filename, JSON.stringify(obj, null, 2), 'utf8');
    return true;
  } catch(e) {
    console.error("safeJsonWrite failed", e && e.message ? e.message : e);
    return false;
  }
}

// ---------------- in-memory maps ----------------
if (typeof global.lastGreeting === "undefined") global.lastGreeting = new Map();
const lastGreeting = global.lastGreeting;

if (typeof global.lastAlert === "undefined") global.lastAlert = new Map();
const lastAlert = global.lastAlert;

// ---------------- Quote limits ----------------
function loadQuoteLimits(){ return safeJsonRead(QUOTE_LIMIT_FILE) || {}; }
function saveQuoteLimits(obj){ return safeJsonWrite(QUOTE_LIMIT_FILE, obj); }
function canSendQuote(from){
  try {
    const q = loadQuoteLimits();
    const today = new Date().toISOString().slice(0,10);
    const rec = q[from] || { date: today, count: 0 };
    if (rec.date !== today) { rec.date = today; rec.count = 0; }
    return rec.count < MAX_QUOTE_PER_DAY;
  } catch(e){ return true; }
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

// ---------------- WA helpers ----------------
async function waSendRaw(payload) {
  if (!META_TOKEN || !PHONE_NUMBER_ID) { if (DEBUG) console.warn("WA skipped - META_TOKEN or PHONE_NUMBER_ID missing"); return null; }
  const url = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`;
  try {
    if (DEBUG) console.log("WA OUTGOING PAYLOAD:", JSON.stringify(payload).slice(0,300));
    const r = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${META_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const j = await r.json().catch(()=>({}));
    if (DEBUG) console.log("WA send response status", r.status, typeof j === 'object' ? JSON.stringify(j).slice(0,800) : String(j).slice(0,800));
    if (!r.ok) console.error("WA send error", r.status, j);
    return j;
  } catch(e) {
    console.error("waSendRaw failed", e && e.stack ? e.stack : e);
    return null;
  }
}
async function waSendText(to, body){ return waSendRaw({ messaging_product:"whatsapp", to, type:"text", text:{ body } }); }

// quick buttons (used *after quotes*, not on greeting)
async function waSendQuickButtons(to){
  const buttons = [
    { type:"reply", reply:{ id:"BTN_NEW_QUOTE", title:"Another Quote" } },
    { type:"reply", reply:{ id:"BTN_NEW_LOAN", title:"Loan / EMI Calc" } },
    { type:"reply", reply:{ id:"BTN_CONTACT_SALES", title:"Contact Sales" } }
  ];
  return waSendRaw({ messaging_product:"whatsapp", to, type:"interactive", interactive:{ type:"button", body:{ text:"Choose a quick action:" }, action:{ buttons } }});
}

// service list (menu)
async function waSendListMenu(to){
  const rows = [
    { id:"SRV_NEW_CAR", title:"New Car Deals", description:"On-road prices & offers" },
    { id:"SRV_USED_CAR", title:"Pre-Owned Cars", description:"Certified used inventory" },
    { id:"SRV_SELL_CAR", title:"Sell My Car", description:"Get best quote for your car" },
    { id:"SRV_LOAN", title:"Loan / Finance", description:"EMI & Bullet options" }
  ];
  const interactive = {
    type: "list",
    header:{ type:"text", text:"MR. CAR SERVICES" },
    body:{ text:"Please choose one option 👇" },
    footer:{ text:"Premium Deals • Trusted Service • Mr. Car" },
    action:{ button:"Select Service", sections:[ { title:"Available", rows } ] }
  };
  return waSendRaw({ messaging_product:"whatsapp", to, type:"interactive", interactive });
}

// used car quick buttons (after used quote)
async function sendUsedCarButtons(to, hasPhotoLink){
  const buttons = [
    { type:"reply", reply:{ id:"BTN_USED_MORE", title:"More Similar Cars" } },
    { type:"reply", reply:{ id:"BTN_BOOK_TEST", title:"Book Test Drive" } },
    { type:"reply", reply:{ id:"BTN_CONTACT_SALES", title:"Contact Sales" } }
  ];
  return waSendRaw({ messaging_product:"whatsapp", to, type:"interactive", interactive:{ type:"button", body:{ text:"Quick actions:" }, action:{ buttons } }});
}

// new car quick buttons (after new car quote)
async function sendNewCarButtons(to){
  const payload = { messaging_product:"whatsapp", to, type:"interactive", interactive:{
    type:"button", body:{ text:"You can continue with these quick actions:" }, action:{ buttons:[
      { type:"reply", reply:{ id:"BTN_NEW_LOAN", title:"Loan Options" } },
      { type:"reply", reply:{ id:"BTN_NEW_QUOTE", title:"Another Quote" } }
    ]}}};
  return waSendRaw(payload);
}

// loan options (3 buttons: EMI calc, docs, eligibility)
async function waSendLoanMenu(to){
  const buttons = [
    { type:"reply", reply:{ id:"BTN_LOAN_EMI",  title:"EMI Calculator" } },
    { type:"reply", reply:{ id:"BTN_LOAN_DOCS", title:"Loan Documents" } },
    { type:"reply", reply:{ id:"BTN_LOAN_ELIG", title:"Loan Eligibility" } }
  ];
  return waSendRaw({
    messaging_product:"whatsapp",
    to,
    type:"interactive",
    interactive:{
      type:"button",
      body:{ text:"Choose a loan option:" },
      action:{ buttons }
    }
  });
}

// ---------------- admin alerts (throttled) ----------------
async function sendAdminAlert({ from, name, text }) {
  if (!META_TOKEN || !PHONE_NUMBER_ID || !ADMIN_WA) return;
  const now = Date.now(); const prev = lastAlert.get(from) || 0;
  const ALERT_WINDOW_MS = (Number(process.env.ALERT_WINDOW_MINUTES || 10)) * 60 * 1000;
  if (now - prev < ALERT_WINDOW_MS) { if (DEBUG) console.log("throttled admin alert for", from); return; }
  lastAlert.set(from, now);
  try {
    const resp = await waSendRaw({ messaging_product:"whatsapp", to: ADMIN_WA, type:"text",
      text: { body: `🔔 NEW WA LEAD\nFrom: ${from}\nName: ${name||'-'}\nMsg: ${String(text||'').slice(0,1000)}` }});
    if (DEBUG) console.log("sendAdminAlert response", JSON.stringify(resp).slice(0,200));
  } catch(e){
    console.warn("sendAdminAlert failed", e && e.message ? e.message : e);
  }
}

// ---------------- CSV + helpers ----------------
function parseCsv(text){
  const rows=[]; let cur="", row=[], inQ=false;
  if(!text) return rows;
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
  const r = await fetch(url, { cache: "no-store", redirect: "follow" });
  if(!r.ok) throw new Error(`CSV fetch failed ${r.status}`);
  const txt = await r.text();
  return parseCsv(txt);
}
function toHeaderIndexMap(headerRow){
  const map = {};
  headerRow.forEach((h,i) => { map[String((h||"").trim()).toUpperCase()] = i; });
  return map;
}

// ---------------- normalization & fuzzy ----------------
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
function fmtMoney(n){ const x=Number(n||0); if(!isFinite(x)) return "-"; return x.toLocaleString("en-IN",{maximumFractionDigits:0}); }
function calcEmiSimple(p, annualRatePct, months){
  const P = Number(p); const r = Number(annualRatePct)/12/100;
  if(!P || !isFinite(r) || months <= 0) return 0;
  const pow = Math.pow(1+r, months);
  const emi = Math.round(P * r * pow / (pow - 1));
  return emi;
}

// small Levenshtein
function levenshtein(a,b){
  if(!a||!b) return Math.max(a?a.length:0,b?b.length:0);
  a=a.toLowerCase(); b=b.toLowerCase();
  const m=a.length, n=b.length;
  const dp = Array.from({length:m+1},()=>Array(n+1).fill(0));
  for(let i=0;i<=m;i++) dp[i][0]=i;
  for(let j=0;j<=n;j++) dp[0][j]=j;
  for(let i=1;i<=m;i++){
    for(let j=1;j<=n;j++){
      const cost = a[i-1]===b[j-1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i-1][j]+1, dp[i][j-1]+1, dp[i-1][j-1]+cost);
    }
  }
  return dp[m][n];
}
function fuzzyTokenMatch(a,b){
  if(!a||!b) return false;
  a = a.toLowerCase(); b = b.toLowerCase();
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;
  const d = levenshtein(a,b);
  return d <= Math.max(1, Math.floor(Math.min(a.length,b.length)/6));
}

// ---------------- pricing loader ----------------
const SHEET_URLS = {
  HOT: SHEET_HOT_DEALS_CSV_URL || "",
  TOYOTA: SHEET_TOYOTA_CSV_URL || "",
  HYUNDAI: SHEET_HYUNDAI_CSV_URL || "",
  MERCEDES: SHEET_MERCEDES_CSV_URL || "",
  BMW: SHEET_BMW_CSV_URL || ""
};
const PRICING_CACHE = { tables: null, ts: 0 };
const PRICING_CACHE_MS = 3*60*1000;

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
      tables[brand] = { header, idxMap, data };
    } catch(e) { if (DEBUG) console.warn("CSV load failed for", brand, e && e.message ? e.message : e); }
  }
  PRICING_CACHE.tables = tables; PRICING_CACHE.ts = Date.now();
  return tables;
}

// ---------------- Used sheet loader ----------------
async function loadUsedSheetRows(){
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

// ---------------- Shortlist for used (per user) ----------------
function shortlistPathFor(from){ return path.resolve(__dirname, "shortlist_" + String(from).replace(/\D/g,"") + ".json"); }
function saveShortlistForUser(from, shortlist){
  try { fs.writeFileSync(shortlistPathFor(from), JSON.stringify({ ts: Date.now(), shortlist }, null, 2), "utf8"); return true; }
  catch(e){ if (DEBUG) console.warn("saveShortlistForUser failed", e && e.message ? e.message : e); return false; }
}
function loadShortlistForUser(from){
  try { const p = shortlistPathFor(from); if(!fs.existsSync(p)) return null; const j = JSON.parse(fs.readFileSync(p,"utf8")||"{}"); return j.shortlist || null; }
  catch(e){ if (DEBUG) console.warn("loadShortlistForUser failed", e && e.message ? e.message : e); return null; }
}
function clearShortlistForUser(from){
  try { const p = shortlistPathFor(from); if(fs.existsSync(p)) fs.unlinkSync(p); return true; } catch(e){ return false; }
}

// ---------------- Bullet EMI ----------------
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
  for (let m = 1; m <= N; m++){
    const interest = Math.round(principal * r);
    let principal_paid_by_emi = monthly_emi - interest;
    if (principal_paid_by_emi < 0) principal_paid_by_emi = 0;
    principal = Math.max(0, principal - principal_paid_by_emi);
    total_interest += interest;
    total_emi_paid += monthly_emi;
    if (m % 12 === 0) {
      const paid = Math.min(bullet_each, Math.max(0, (bullet_total - total_bullets_paid)));
      total_bullets_paid += paid;
      principal = Math.max(0, principal - paid);
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

// ---------------- Used car quote (free-text) ----------------
async function buildUsedCarQuoteFreeText({ query, requestedBrand, requestedModel }){
  try {
    const rows = await loadUsedSheetRows();
    if (!rows || !rows.length) return { text: "Used car pricing not configured." };

    const header = rows[0].map(h => String(h||"").trim().toUpperCase());
    const idx = toHeaderIndexMap(header);
    const data = rows.slice(1);

    const makeIdx = idx["MAKE"] ?? idx["BRAND"] ?? header.findIndex(h => h.includes("MAKE"));
    const modelIdx = idx["MODEL"] ?? idx["MODEL NAME"] ?? header.findIndex(h => h.includes("MODEL"));
    const subModelIdx = idx["SUB MODEL"] ?? idx["SUBMODEL"] ?? -1;
    const colourIdx = idx["COLOUR"] ?? idx["COLOR"] ?? header.findIndex(h => h.includes("COLOUR") || h.includes("COLOR"));

    const expectedIdxCandidates = ["EXPECTED PRICE","EXPECTED_PRICE","EXPECTED PRICE (₹)","EXPECTED_PRICE (INR)","EXPECTED PRICE(INR)","EXPECTED"];
    let expectedIdx = -1;
    for (const k of expectedIdxCandidates){ if (typeof idx[k] !== 'undefined') { expectedIdx = idx[k]; break; } }
    if (expectedIdx < 0) {
      const ei = header.findIndex(h => h.includes("EXPECTED") || h.includes("PRICE"));
      expectedIdx = ei >= 0 ? ei : -1;
    }
    let regIdx = idx["REGISTRATION PLACE"] ?? idx["REGISTRATION"] ?? header.findIndex(h => h.includes("REGISTR"));
    if (regIdx < 0) regIdx = -1;

    const q = (query || "").toLowerCase();
    const qTokens = q.replace(/[^\w\s]/g," ").split(/\s+/).filter(Boolean);
    const brandHint = requestedBrand ? requestedBrand.toLowerCase() : null;
    const modelHint = requestedModel ? requestedModel.toLowerCase() : null;

    const matches = [];
    for (let r = 0; r < data.length; r++){
      const row = data[r];
      const make = String(row[makeIdx]||"").toLowerCase();
      const model = String(row[modelIdx]||"").toLowerCase();
      const submodel = subModelIdx >= 0 ? String(row[subModelIdx]||"").toLowerCase() : "";
      let score = 0;
      if (brandHint && fuzzyTokenMatch(make, brandHint)) score += 40;
      if (modelHint && fuzzyTokenMatch(model, modelHint)) score += 50;
      for (const t of qTokens){
        if (!t) continue;
        if (make.includes(t)) score += 8;
        if (model.includes(t)) score += 10;
        if (submodel.includes(t)) score += 6;
      }
      if (fuzzyTokenMatch(make, qTokens.join(' '))) score += 5;
      if (fuzzyTokenMatch(model, qTokens.join(' '))) score += 5;
      if (score > 0) matches.push({ r, score, make, model, submodel, row });
    }

    if (!matches.length){
      for (let r=0;r<data.length;r++){
        const row = data[r];
        const make = String(row[makeIdx]||"").toLowerCase();
        const model = String(row[modelIdx]||"").toLowerCase();
        if (q.includes(make) || q.includes(model) || (brandHint && fuzzyTokenMatch(make, brandHint)) || (modelHint && fuzzyTokenMatch(model, modelHint))){
          matches.push({ r, score: 5 + (q.includes(make)?5:0) + (q.includes(model)?5:0), make, model, submodel: String(row[subModelIdx]||"").toLowerCase(), row });
        }
      }
    }

    if (!matches.length) {
      return { text: `Sorry, I couldn’t find an exact match for "${query}".\nPlease share brand and model (e.g., "Audi A6 2018") or give a budget and I’ll suggest options.` };
    }

    matches.sort((a,b) => b.score - a.score);
    const uniqueList = [];
    const seen = new Set();
    for (const item of matches.slice(0,12)){
      const key = `${item.make} ${item.model}`.trim();
      if (!seen.has(key)){
        seen.add(key);
        uniqueList.push(item);
      }
    }

    if (uniqueList.length > 1 && uniqueList[0].score < 40) {
      const lines = [];
      lines.push(`I found multiple matching vehicles. Please reply with the option number for the exact car you want:`);
      uniqueList.forEach((it, idxi) => {
        const makeDisplay = (it.make||"").toUpperCase();
        const modelDisplay = (it.model||"").toUpperCase();
        const sub = (it.submodel||"").toUpperCase();
        const colour = String(it.row[colourIdx]||"");
        lines.push(`${idxi+1}. ${makeDisplay} ${modelDisplay}${sub ? ` • ${sub}` : ""}${colour ? ` • ${colour}` : ""}`);
      });
      lines.push("");
      lines.push("Example reply: `1` or `Audi A6 2018`");
      const shortlist = uniqueList.slice(0,6).map(u => ({ r: u.r, make: u.make, model: u.model }));
      return { text: lines.join("\n"), shortlist };
    }

    const sel = uniqueList[0] || matches[0];
    const selRow = sel.row;
    const expectedStr = expectedIdx>=0 ? String(selRow[expectedIdx]||"") : "";
    let price = Number(String(expectedStr||'').replace(/[,₹\s]/g,'')) || 0;
    if (!price) {
      for (let i=0;i<selRow.length;i++){
        const v = String(selRow[i]||"").replace(/[,₹\s]/g,"");
        if (/^\d+$/.test(v) && Number(v) > 100000) { price = Number(v); break; }
      }
    }
    if (!price) return { text: `Price for *${sel.make.toUpperCase()} ${sel.model.toUpperCase()}* not available.` };

    const loanAmt = Math.round(price * (USED_CAR_LTV_PCT/100));
    const tenureDefault = 60;
    const normal_emi = calcEmiSimple(loanAmt, USED_CAR_ROI_VISIBLE, tenureDefault);
    const bulletSim = simulateBulletPlan({ loanAmount: loanAmt, months: tenureDefault, internalRatePct: USED_CAR_ROI_INTERNAL, bulletPct: 0.25 });

    let regPlace = "";
    if (regIdx >= 0 && selRow[regIdx]) regPlace = String(selRow[regIdx]||"").trim();

    let picLink = null;
    for (const c of selRow){
      if (String(c||"").includes("http")) { picLink = String(c||"").trim(); break; }
    }

    const lines = [];
    lines.push(`*PRE-OWNED CAR QUOTE*`);
    lines.push(`Make/Model: *${(sel.make||"").toUpperCase()} ${(sel.model||"").toUpperCase()}*`);
    if (subModelIdx >= 0 && selRow[subModelIdx]) lines.push(`Variant: ${(selRow[subModelIdx]||"").toString().toUpperCase()}`);
    if (selRow[colourIdx]) lines.push(`Colour: ${(selRow[colourIdx]||"").toString().toUpperCase()}`);
    if (regPlace) lines.push(`Registration Place: ${regPlace.toUpperCase()}`);
    lines.push(``);
    lines.push(`Expected Price: ₹ *${fmtMoney(price)}*`);
    lines.push(`Loan: ₹ *${fmtMoney(loanAmt)}*  •  LTV: *${USED_CAR_LTV_PCT}%*`);
    lines.push(`ROI (Shown): *${USED_CAR_ROI_VISIBLE}%* • Tenure: *${tenureDefault} months*`);
    lines.push(``);
    lines.push(`OPTION 1 — NORMAL EMI`);
    lines.push(`📌 EMI (on ₹ ${fmtMoney(loanAmt)}): ₹ *${fmtMoney(normal_emi)}*`);
    if (bulletSim) {
      lines.push(``);
      lines.push(`OPTION 2 — BULLET EMI`);
      lines.push(`📌 Monthly EMI (amortising): ₹ *${fmtMoney(bulletSim.monthly_emi)}*`);
      lines.push(` • Bullet total: ₹ *${fmtMoney(bulletSim.bullet_total)}*`);
      lines.push(` • Bullet each: ₹ *${fmtMoney(bulletSim.bullet_each)}* on months: ${Array.from({length: bulletSim.num_bullets}, (_,i) => (12*(i+1))).join(" • ")}`);
    }
    lines.push("");
    lines.push(`✅ Loan approval possible in ~30 minutes (subject to documents & verification)`);

    return { text: lines.join("\n"), picLink, selRowIndex: sel.r };
  } catch(e){
    console.error("buildUsedCarQuoteFreeText error", e && e.stack ? e.stack : e);
    return { text: "Used car pricing failed." , picLink:null};
  }
}

// ---------------- New car helpers ----------------
function detectExShowIdx(idxMap){
  const keys = Object.keys(idxMap || {});
  for (const k of keys){
    if (/EX[\s\-_\/A-Z0-9]*SHOWROOM/.test(String(k))) return idxMap[k];
  }
  const lowerKeys = keys.map(k => k.toLowerCase());
  const i = lowerKeys.findIndex(k => k.includes("ex") && k.includes("showroom"));
  if (i >= 0) return idxMap[keys[i]];
  return -1;
}

// When user sends only "hyryder" / "fortuner" -> list variants instead of guessing a row
async function sendVariantListIfModelOnly(msgText, tables, to){
  const t = String(msgText || "").toLowerCase();
  // strip city/profile words first
  let raw = t.replace(/\b(delhi|dilli|haryana|hr|chandigarh|chd|uttar pradesh|up|himachal|hp|mumbai|bangalore|bengaluru|chennai)\b/g," ")
             .replace(/\b(individual|company|corporate|firm|personal)\b/g," ")
             .replace(/[^\w\s]/g," ").replace(/\s+/g," ").trim();
  const tokens = raw.split(/\s+/).filter(Boolean);
  if (tokens.length !== 1) return false; // not model-only
  const modelToken = tokens[0];

  for (const [brand, tab] of Object.entries(tables)){
    if (!tab || !tab.data) continue;
    const header = tab.header.map(h => String(h||"").toUpperCase());
    const idxModel = header.findIndex(h=> h.includes("MODEL") || h.includes("VEHICLE"));
    const idxVariant = header.findIndex(h => h.includes("VARIANT") || h.includes("SUFFIX"));

    if (idxModel < 0 || idxVariant < 0) continue;
    const variantsSet = new Set();
    for (const row of tab.data){
      const modelCell = String(row[idxModel]||"").toLowerCase();
      if (modelCell.includes(modelToken)) {
        const v = String(row[idxVariant]||"").trim();
        if (v) variantsSet.add(v);
      }
    }
    const variants = Array.from(variantsSet);
    if (variants.length) {
      const lines = [];
      lines.push(`*${brand.toUpperCase()} ${modelToken.toUpperCase()} — AVAILABLE VARIANTS*`);
      variants.forEach((v,i)=> lines.push(`${i+1}. ${v}`));
      lines.push("");
      lines.push(`Please reply with *exact variant + city + profile* to get price.`);
      lines.push(`Example: _Delhi ${modelToken} ${variants[0]} individual_`);
      await waSendText(to, lines.join("\n"));
      return true;
    }
  }
  return false;
}

async function tryQuickNewCarQuote(msgText, to){
  try {
    if (!msgText || !msgText.trim()) return false;
    const tables = await loadPricingFromSheets();
    if (!tables || Object.keys(tables).length === 0) return false;

    const t = String(msgText || "").toLowerCase();

    // FIRST: if only model name (no variant) -> list variants and stop
    const listed = await sendVariantListIfModelOnly(msgText, tables, to);
    if (listed) return true;

    if (!canSendQuote(to)) {
      await waSendText(to, "You’ve reached today’s assistance limit for quotes. Please try again tomorrow or provide your details for a personalised quote.");
      return true;
    }

    let cityMatch = (t.match(/\b(delhi|dilli|haryana|hr|chandigarh|chd|uttar pradesh|up|himachal|hp|chennai|mumbai|bangalore|bengaluru)\b/)||[])[1] || null;
    if(cityMatch){ if(cityMatch==="dilli") cityMatch="delhi"; if(cityMatch==="hr") cityMatch="haryana"; if(cityMatch==="chd") cityMatch="chandigarh"; if(cityMatch==="up") cityMatch="uttar pradesh"; if(cityMatch==="hp") cityMatch="himachal pradesh"; }
    else cityMatch = "delhi";
    const city = cityMatch;
    const profile = (t.match(/\b(individual|company|corporate|firm|personal)\b/)||[])[1] || "individual";

    let raw = t.replace(/\b(delhi|dilli|haryana|hr|chandigarh|chd|uttar pradesh|up|himachal|hp|mumbai|bangalore|bengaluru|chennai)\b/g," ")
      .replace(/\b(individual|company|corporate|firm|personal)\b/g," ")
      .replace(/[^\w\s]/g," ").replace(/\s+/g," ").trim();
    const modelGuess = raw.split(' ').slice(0,3).join(' ');

    for (const [brand, tab] of Object.entries(tables)){
      if (!tab || !tab.data) continue;
      const header = tab.header.map(h => String(h||"").toUpperCase());
      const idxModel = header.findIndex(h=> h.includes("MODEL") || h.includes("VEHICLE"));
      const idxVariant = header.findIndex(h => h.includes("VARIANT") || h.includes("SUFFIX"));
      const idxMap = tab.idxMap || toHeaderIndexMap(header);
      for (const row of tab.data){
        const modelCell = idxModel>=0 ? String(row[idxModel]||"").toLowerCase() : "";
        const variantCell = idxVariant>=0 ? String(row[idxVariant]||"").toLowerCase() : "";
        if ((modelCell && modelCell.includes(modelGuess)) || (variantCell && variantCell.includes(modelGuess)) || modelCell.includes(raw) || variantCell.includes(raw)) {
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
          const exIdx = detectExShowIdx(idxMap);
          const exShow = (exIdx>=0) ? Number(String(row[exIdx]||"").replace(/[,₹\s]/g,""))||0 : 0;
          const loanAmt = exShow || onroad || 0;
          const emi60 = loanAmt ? calcEmiSimple(loanAmt, NEW_CAR_ROI, 60) : 0;
          const lines = [
            `*${brand}* ${String(row[idxModel]||"").toUpperCase()} ${String(row[idxVariant]||"").toUpperCase()}`,
            `*City:* ${city.toUpperCase()} • *Profile:* ${profile.toUpperCase()}`,
            exShow ? `*Ex-Showroom:* ₹ ${fmtMoney(exShow)}` : null,
            onroad ? `*On-Road:* ₹ ${fmtMoney(onroad)}` : null,
            loanAmt ? `*Loan:* 100% of Ex-Showroom → ₹ ${fmtMoney(loanAmt)} @ *${NEW_CAR_ROI}%* (60m) → *EMI ≈ ₹ ${fmtMoney(emi60)}*` : null,
            `\n*Terms & Conditions Apply*`
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

// ---------------- Greeting ----------------
const GREETING_WINDOW_MINUTES = Number(process.env.GREETING_WINDOW_MINUTES || 600);
const GREETING_WINDOW_MS = GREETING_WINDOW_MINUTES * 60 * 1000;
function shouldGreetNow(from, msgText){
  try {
    if (ADMIN_WA && from === ADMIN_WA) return false;
    const now = Date.now(); const prev = lastGreeting.get(from) || 0;
    const text = (msgText||"").trim().toLowerCase();
    const looksLikeGreeting = /^(hi|hello|hey|namaste|enquiry|inquiry|help|start)\b/.test(text) || prev === 0;
    if (!looksLikeGreeting) return false;
    if (now - prev < GREETING_WINDOW_MS) return false;
    lastGreeting.set(from, now);
    return true;
  } catch(e){ if (DEBUG) console.warn("shouldGreetNow failed", e && e.message ? e.message : e); return false; }
}

// ---------------- CRM helpers ----------------
let postLeadToCRM = async ()=>{};
let fetchCRMReply = async ()=>{ return null; };
try {
  const crmHelpers = require('./crm_helpers.cjs');
  postLeadToCRM = crmHelpers.postLeadToCRM || postLeadToCRM;
  fetchCRMReply = crmHelpers.fetchCRMReply || fetchCRMReply;
  if (DEBUG) console.log("crm_helpers.cjs loaded");
} catch(e) { if (DEBUG) console.log("crm_helpers.cjs not loaded (ok for dev)."); }

// ---------------- HTTP endpoints ----------------
app.get("/healthz", (req, res) => res.json({ ok: true, t: Date.now(), debug: DEBUG }));

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN && challenge) {
    console.log("Webhook verified ✅"); return res.status(200).type("text/plain").send(String(challenge));
  }
  return res.sendStatus(403);
});

app.post('/admin/reset_greetings', (req, res) => { try { lastGreeting.clear(); return res.json({ ok: true, msg: "greetings cleared" }); } catch(e){ return res.status(500).json({ ok:false, e:String(e) }); } });

// ---------------- MAIN webhook ----------------
app.post('/webhook', async (req, res) => {
  if (DEBUG) {
    try { console.log("📩 Incoming webhook (short):", JSON.stringify({
      object: req.body && req.body.object,
      entry0: req.body && req.body.entry && req.body.entry[0] && Object.keys(req.body.entry[0]).slice(0,5)
    }).slice(0,1000)); } catch(e){}
  }
  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value || {};

    // Ignore status-only callbacks
    if (!value?.messages && value?.statuses) {
      if (DEBUG) console.log("Received status-only event (sent/delivered/read) — ignoring for replies.");
      return res.sendStatus(200);
    }

    const msg = value?.messages?.[0];
    const contact = value?.contacts?.[0];
    if (!msg) {
      if (DEBUG) console.log("No message in webhook body — ignoring.");
      return res.sendStatus(200);
    }

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

    // Admin alert (throttled)
    if (from !== ADMIN_WA) {
      try { await sendAdminAlert({ from, name, text: msgText }); } catch(e){}
    }

    // Lead logging (CRM + local)
    try {
      const lead = { from, name, text: msgText };
      (async ()=>{ try{ await postLeadToCRM({ from, name, text: msgText }); }catch(e){ if(DEBUG) console.warn("CRM post failed", e && e.message ? e.message : e); } })();
      try {
        const raw = safeJsonRead(LEADS_FILE);
        let arr = Array.isArray(raw) ? raw : (Array.isArray(raw.leads) ? raw.leads : []);
        arr.unshift({ ...lead, ts: Date.now() });
        arr = arr.slice(0, 1000);
        fs.writeFileSync(LEADS_FILE, JSON.stringify(arr, null, 2), 'utf8');
        if (DEBUG) console.log("✅ Lead saved:", from, (msgText||'').slice(0,120));
      } catch(e){ if (DEBUG) console.warn("lead save failed", e && e.message ? e.message : e); }
    } catch(e){}

    // 1) Interactive buttons
    if (selectedId){
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
          await waSendText(from, `Loan assistance options below 👇`);
          await waSendLoanMenu(from);
          break;
        case "BTN_USED_PHOTOS":
          await waSendText(from, "Please tap the Google Drive link in the quote to view photos. If missing, reply “photos please”.");
          break;
        case "BTN_CONTACT_SALES":
          await waSendText(from, "Our sales team will contact you shortly. Share your preferred time and contact details.");
          break;
        case "BTN_BOOK_TEST":
          await waSendText(from, "Thanks — share preferred date/time and we'll call to confirm the test drive.");
          break;
        // Loan menu sub-options
        case "BTN_LOAN_EMI":
          await waSendText(from, "For EMI calculation, reply like:\n`emi 1500000 9.5 60`\n\nFormat: `emi <loan amount> <rate% optional> <months>`");
          break;
        case "BTN_LOAN_DOCS":
          await waSendText(from, "Basic loan documents:\n• PAN & Aadhaar\n• 3/6 months bank statements\n• 2/3 years ITR or salary slips\n• Address proof\n• Photos & car details\n\nReply with *city + salaried/self-employed* to get exact checklist.");
          break;
        case "BTN_LOAN_ELIG":
          await waSendText(from, "For eligibility, please share:\n• City\n• Salaried / Self-employed\n• Monthly income\n• Existing EMIs (if any)\n\nExample: `Delhi salaried 1.2L income 15k existing EMI`");
          break;
        default:
          await waSendText(from, "Thanks! You can type your request anytime.");
      }
      return res.sendStatus(200);
    }

    // 2) Numeric reply = used-car shortlist selection
    try {
      const numericOnly = (msgText||"").trim().match(/^(\d{1,2})$/);
      if (numericOnly && numericOnly[1]) {
        const choice = Number(numericOnly[1]);
        const shortlist = loadShortlistForUser(from);
        if (Array.isArray(shortlist) && shortlist.length >= choice && choice >= 1) {
          const sel = shortlist[choice-1];
          if (sel && typeof sel.r === "number") {
            const rowsAll = await loadUsedSheetRows();
            if (rowsAll && rowsAll.length > sel.r) {
              const header = rowsAll[0].map(h => String(h||"").trim().toUpperCase());
              const idxmap = toHeaderIndexMap(header);
              const row = rowsAll[ sel.r ];

              const makeIdx = idxmap["MAKE"] ?? idxmap["BRAND"] ?? header.findIndex(h=>h.includes("MAKE"));
              const modelIdx = idxmap["MODEL"] ?? header.findIndex(h=>h.includes("MODEL"));
              const subModelIdx = idxmap["SUB MODEL"] ?? idxmap["SUBMODEL"] ?? -1;
              const colourIdx = idxmap["COLOUR"] ?? idxmap["COLOR"] ?? header.findIndex(h => h.includes("COLOUR") || h.includes("COLOR"));

              const expectedIdxCandidates = ["EXPECTED PRICE","EXPECTED_PRICE","EXPECTED PRICE (₹)","EXPECTED_PRICE (INR)","EXPECTED"];
              let expectedIdx = -1;
              for (const k of expectedIdxCandidates) if (typeof idxmap[k] !== 'undefined') { expectedIdx = idxmap[k]; break; }
              if (expectedIdx < 0) { const ei = header.findIndex(h => h.includes("EXPECTED")||h.includes("PRICE")); expectedIdx = ei>=0?ei:-1; }
              let regIdx = idxmap["REGISTRATION PLACE"] ?? idxmap["REGISTRATION"] ?? header.findIndex(h => h.includes("REGISTR"));
              if (regIdx < 0) regIdx = -1;

              const expectedStr = expectedIdx>=0 ? String(row[expectedIdx]||"") : "";
              let price = Number(String(expectedStr||'').replace(/[,₹\s]/g,'')) || 0;
              if (!price) {
                for (let i=0;i<row.length;i++){
                  const v = String(row[i]||"").replace(/[,₹\s]/g,"");
                  if (/^\d+$/.test(v) && Number(v) > 100000) { price = Number(v); break; }
                }
              }
              if (price) {
                const loanAmt = Math.round(price * (USED_CAR_LTV_PCT/100));
                const tenureDefault = 60;
                const normal_emi = calcEmiSimple(loanAmt, USED_CAR_ROI_VISIBLE, tenureDefault);
                const bulletSim = simulateBulletPlan({ loanAmount: loanAmt, months: tenureDefault, internalRatePct: USED_CAR_ROI_INTERNAL, bulletPct: 0.25 });
                let regPlace = "";
                if (regIdx >= 0 && row[regIdx]) regPlace = String(row[regIdx]||"").trim();

                const lines = [];
                lines.push(`*PRE-OWNED CAR QUOTE*`);
                const make = (row[makeIdx]||"").toString().toUpperCase();
                const model = (row[modelIdx]||"").toString().toUpperCase();
                lines.push(`Make/Model: *${make} ${model}*`);
                if (subModelIdx >= 0 && row[subModelIdx]) lines.push(`Variant: ${(row[subModelIdx]||"").toString().toUpperCase()}`);
                if (row[colourIdx]) lines.push(`Colour: ${(row[colourIdx]||"").toString().toUpperCase()}`);
                if (regPlace) lines.push(`Registration Place: ${regPlace.toUpperCase()}`);
                lines.push("");
                lines.push(`Expected Price: ₹ *${fmtMoney(price)}*`);
                lines.push(`Loan: ₹ *${fmtMoney(loanAmt)}*  •  LTV: *${USED_CAR_LTV_PCT}%*`);
                lines.push(`ROI (Shown): *${USED_CAR_ROI_VISIBLE}%* • Tenure: *${tenureDefault} months*`);
                lines.push("");
                lines.push(`OPTION 1 — NORMAL EMI`);
                lines.push(`📌 EMI (on ₹ ${fmtMoney(loanAmt)}): ₹ *${fmtMoney(normal_emi)}*`);
                if (bulletSim) {
                  lines.push("");
                  lines.push(`OPTION 2 — BULLET EMI`);
                  lines.push(`📌 Monthly EMI (amortising): ₹ *${fmtMoney(bulletSim.monthly_emi)}*`);
                  lines.push(` • Bullet total: ₹ *${fmtMoney(bulletSim.bullet_total)}*`);
                  lines.push(` • Bullet each: ₹ *${fmtMoney(bulletSim.bullet_each)}* on months: ${Array.from({length: bulletSim.num_bullets}, (_,i) => (12*(i+1))).join(" • ")}`);
                }
                lines.push("");
                lines.push(`✅ Loan approval possible in ~30 minutes (subject to documents & verification)`);
                await waSendText(from, lines.join("\n"));
                clearShortlistForUser(from);
                let picLink = null;
                for (const c of row) { if (String(c||"").includes("http")) { picLink = String(c||"").trim(); break; } }
                if (picLink) await waSendText(from, `Photos: ${picLink}`);
                await sendUsedCarButtons(from, !!picLink);
                return res.sendStatus(200);
              }
            }
          }
        }
      }
    } catch(e){ if (DEBUG) console.warn("numeric shortlist handler failed", e && e.message ? e.message : e); }

    // 3) Budget-only handling (e.g., "15 lac", "20 lakh budget")
    if (type === "text") {
      const low = (msgText || "").toLowerCase();
      const budgetMatch = low.match(/(\d+(\.\d+)?)\s*(lakh|lac|lacs|lakhs)\b/);
      if (budgetMatch) {
        const lakhs = parseFloat(budgetMatch[1] || "0");
        const amt = Math.round(lakhs * 100000);
        const lines = [];
        lines.push(`Noted approx budget: ₹ *${fmtMoney(amt)}* (about ${lakhs} lakh).`);
        lines.push("");
        lines.push(`To help you best, please share:`);
        lines.push(`• *New* or *Pre-owned*`);
        lines.push(`• Brand & model (e.g., Toyota Hyryder / BMW X1)`);
        lines.push(`• City & profile (individual/company)`);
        lines.push("");
        lines.push(`Example: _New Toyota Hyryder around ${lakhs} lakh in Delhi individual_`);
        lines.push(`\nFor approximate EMI, you can also send: \`emi ${amt} 9.5 60\``);
        await waSendText(from, lines.join("\n"));
        return res.sendStatus(200);
      }
    }

    // 4) Used car detection (keywords / known make / year)
    try {
      let usedMakes = [];
      if (SHEET_USED_CSV_URL) {
        try {
          const usedCsv = await fetchCsv(SHEET_USED_CSV_URL);
          if (usedCsv && usedCsv.length > 1) {
            const usedHeader = usedCsv[0].map(h => String(h || "").trim().toUpperCase());
            const makeIdx = usedHeader.findIndex(h => h.includes("MAKE"));
            if (makeIdx >= 0) {
              usedMakes = Array.from(new Set(usedCsv.slice(1).map(r => String(r[makeIdx] || "").trim().toLowerCase()).filter(Boolean))).slice(0, 200);
              if (DEBUG) console.log("USED sheet loaded, makes sample:", usedMakes.slice(0, 10));
            }
          }
        } catch (e) {
          if (DEBUG) console.warn("Failed fetching USED sheet:", String(e).slice(0,200));
        }
      }

      const textLower = (msgText || "").toLowerCase();
      const explicitUsed = /\b(used|pre-?owned|pre owned|preowned|second hand|secondhand)\b/.test(textLower);
      const hasKnownMake = usedMakes.some(m => m && textLower.includes(m));
      const hasYear = /\b(19|20)\d{2}\b/.test(textLower);

      if (explicitUsed || hasKnownMake || hasYear) {
        const qRes = await buildUsedCarQuoteFreeText({ query: msgText });
        if (qRes && qRes.text) {
          if (qRes.shortlist && qRes.shortlist.length) {
            saveShortlistForUser(from, qRes.shortlist);
            await waSendText(from, qRes.text);
            return res.sendStatus(200);
          }
          await waSendText(from, qRes.text);
          if (qRes.picLink) {
            await waSendText(from, `Photos: ${qRes.picLink}`);
          }
          await sendUsedCarButtons(from, !!qRes.picLink);
          return res.sendStatus(200);
        }
      }
    } catch(e){ if (DEBUG) console.warn("Used-detection error", e && e.message ? e.message : e); }

    // 5) Greeting
    if (shouldGreetNow(from, msgText)){
      await waSendText(from, `🔴 *MR. CAR* welcomes you!\nNamaste 🙏\n\nWe assist with *pre-owned cars*, *new car deals*, *loans* and *insurance*.\nTell us how we can help — or pick an option below.`);
      await waSendListMenu(from);
      return res.sendStatus(200);
    }

    // 6) New car quick quote
    if (msgText && type === "text") {
      const servedNew = await tryQuickNewCarQuote(msgText, from);
      if (servedNew) return res.sendStatus(200);
    }

    // 7) Bullet command
    const bulletCmd = (msgText||"").trim().match(/^bullet\s+([\d,]+)\s*(\d+)?/i);
    if (bulletCmd) {
      const loanRaw = String(bulletCmd[1]||"").replace(/[,₹\s]/g,"");
      const months = Number(bulletCmd[2] || 60);
      const loanAmt = Number(loanRaw);
      if (!loanAmt || !months) { await waSendText(from, "Please send: `bullet <loan amount> <tenure months>` e.g. `bullet 750000 60`"); return res.sendStatus(200); }
      const sim = simulateBulletPlan({ loanAmount: loanAmt, months, internalRatePct: USED_CAR_ROI_INTERNAL, bulletPct:0.25 });
      if (!sim) { await waSendText(from, "Bullet calculation failed."); return res.sendStatus(200); }
      const lines = [];
      lines.push(`🔷 *Bullet EMI Plan — Used Car*`);
      lines.push(`Loan Amount: ₹ *${fmtMoney(sim.loan)}*`);
      lines.push(`ROI (shown): *${USED_CAR_ROI_VISIBLE}%*`);
      lines.push(`Tenure: *${sim.months} months*`);
      lines.push("");
      lines.push(`📌 Monthly EMI (amortising): ₹ *${fmtMoney(sim.monthly_emi)}*`);
      lines.push(`📌 Bullet total (25%): ₹ *${fmtMoney(sim.bullet_total)}*`);
      lines.push(`• Bullet each: ₹ *${fmtMoney(sim.bullet_each)}* on months: ${Array.from({length: sim.num_bullets}, (_,i) => (12*(i+1))).join(" • ")}`);
      lines.push("");
      lines.push(`✅ *Loan approval possible in ~30 minutes (T&Cs apply)*`);
      await waSendText(from, lines.join("\n"));
      return res.sendStatus(200);
    }

    // 8) EMI calculator
    const emiCmd = (msgText||"").trim().match(/^emi\s+([\d,]+)(?:\s+([\d\.]+)%?)?\s*(\d+)?/i);
    if (emiCmd){
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
        `✅ *Loan approval possible in ~30 minutes (T&Cs apply)*`
      ].join("\n");
      await waSendText(from, lines);
      return res.sendStatus(200);
    }

    // 9) CRM fallback
    try {
      const crmReply = await fetchCRMReply({ from, msgText });
      if (crmReply) { await waSendText(from, crmReply); return res.sendStatus(200); }
    } catch (e) { if (DEBUG) console.warn("CRM reply failed", e && e.message ? e.message : e); }

    // 10) Default fallback
    await waSendText(from, "Tell me your *city + make/model + variant/suffix + profile (individual/company)*. e.g., *Delhi Hycross ZXO individual* or *HR BMW X1 sDrive18i company*.");
    return res.sendStatus(200);

  } catch (err) {
    console.error("Webhook error:", err && err.stack ? err.stack : err);
    try { if (ADMIN_WA) await waSendText(ADMIN_WA, `Webhook crash: ${String(err && err.message ? err.message : err)}`); } catch(e){}
    return res.sendStatus(200);
  }
});

// ---------------- Start server ----------------
app.listen(PORT, ()=> {
  console.log(`✅ MR.CAR webhook CRM server running on port ${PORT}`);
  console.log("ENV summary:", {
    SHEET_TOYOTA_CSV_URL: !!SHEET_TOYOTA_CSV_URL,
    SHEET_USED_CSV_URL: !!SHEET_USED_CSV_URL || fs.existsSync(LOCAL_USED_CSV_PATH),
    PHONE_NUMBER_ID: !!PHONE_NUMBER_ID,
    META_TOKEN: !!META_TOKEN,
    ADMIN_WA: !!ADMIN_WA,
    DEBUG
  });
});
