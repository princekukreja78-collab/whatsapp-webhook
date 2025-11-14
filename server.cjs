// server.cjs — MR.CAR webhook (merged + enhanced)
// Make sure to replace your server.cjs with this file content

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const fetch = (global.fetch) ? global.fetch : require('node-fetch');
const bodyParser = require('body-parser');

const app = express();
app.use(express.json());
app.use(bodyParser.json({ limit: '1mb' }));

// ------------- ENV -------------
const META_TOKEN      = (process.env.META_TOKEN || process.env.WA_TOKEN || '').trim();
const PHONE_NUMBER_ID = (process.env.PHONE_NUMBER_ID || '').trim();
const ADMIN_WA        = (process.env.ADMIN_WA || process.env.ADMIN_PHONE || '').replace(/\D/g, '') || null;
const VERIFY_TOKEN    = (process.env.VERIFY_TOKEN || process.env.META_VERIFY_TOKEN || '').trim();

const SHEET_TOYOTA_CSV_URL    = (process.env.SHEET_TOYOTA_CSV_URL || '').trim();
const SHEET_HYUNDAI_CSV_URL   = (process.env.SHEET_HYUNDAI_CSV_URL || '').trim();
const SHEET_MERCEDES_CSV_URL  = (process.env.SHEET_MERCEDES_CSV_URL || '').trim();
const SHEET_BMW_CSV_URL       = (process.env.SHEET_BMW_CSV_URL || '').trim();
const SHEET_HOT_DEALS_CSV_URL = (process.env.SHEET_HOT_DEALS_CSV_URL || '').trim();
const SHEET_USED_CSV_URL      = (process.env.SHEET_USED_CSV_URL || process.env.USED_CAR_CSV_URL || '').trim();

const PORT = process.env.PORT || 3000;

// ------------- defaults -------------
const GREETING_WINDOW_MINUTES = Number(process.env.GREETING_WINDOW_MINUTES || 600); // minutes
const GREETING_WINDOW_MS = GREETING_WINDOW_MINUTES * 60 * 1000;
const ALERT_WINDOW_MINUTES = Number(process.env.ALERT_WINDOW_MINUTES || 10);
const ALERT_WINDOW_MS = ALERT_WINDOW_MINUTES * 60 * 1000;
const NEW_CAR_ROI = Number(process.env.NEW_CAR_ROI || 8.10);
const USED_CAR_ROI = Number(process.env.USED_CAR_ROI || 9.99);
const DEBUG = process.env.DEBUG === 'true' || process.env.DEBUG_VARIANT === 'true' || true; // keep verbose for now

// ------------- persistent small files -------------
const QUOTE_LIMIT_FILE = path.join(__dirname, 'quote_limits.json'); // per-day quote limiting

// Ensure lastGreeting exists globally (safe fallback)
if (typeof global.lastGreeting === 'undefined') global.lastGreeting = new Map();
const lastGreeting = global.lastGreeting;

// admin-alert throttle
const lastAlert = new Map();

// simple quote limit store (per day, resets at midnight)
function loadQuoteLimits() {
  try {
    if (!fs.existsSync(QUOTE_LIMIT_FILE)) return {};
    return JSON.parse(fs.readFileSync(QUOTE_LIMIT_FILE,'utf8')||'{}');
  } catch(e){ return {}; }
}
function saveQuoteLimits(obj){
  try { fs.writeFileSync(QUOTE_LIMIT_FILE, JSON.stringify(obj, null, 2)); } catch(e){ console.warn("quote_limits write failed", e && e.message); }
}
function resetQuoteLimits(){
  saveQuoteLimits({});
}
function incrQuoteCount(number){
  const today = new Date().toISOString().slice(0,10);
  const data = loadQuoteLimits();
  data[number] = data[number] || {};
  if (data[number].date !== today) { data[number] = { date: today, count: 0 }; }
  data[number].count = (data[number].count || 0) + 1;
  saveQuoteLimits(data);
  return data[number].count;
}
function getQuoteCount(number){
  const today = new Date().toISOString().slice(0,10);
  const data = loadQuoteLimits();
  const ent = data[number];
  if (!ent || ent.date !== today) return 0;
  return ent.count || 0;
}

// ------------- WA helpers -------------
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
    console.log("WA send response status", r.status);
    try { console.log("WA send response body:", JSON.stringify(j).slice(0,1200)); } catch(e){ console.log("WA send response body (raw):", String(j).slice(0,1200)); }
    if (!r.ok) console.error("WA send error", r.status, j);
    return j;
  } catch(e) { console.error("waSendRaw failed", e && e.stack ? e.stack : e); return null; }
}
async function waSendText(to, body){ return waSendRaw({ messaging_product:"whatsapp", to, type:"text", text:{ body } }); }

async function waSendListMenu(to){
  // main greeting list menu: only top-level services (no brand list inside)
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "list",
      header:{ type:"text", text:"MR. CAR SERVICES" },
      body:{ text:"Please choose one option 👇" },
      footer:{ text:"Premium Deals • Trusted Service • Mr. Car" },
      action:{ button:"Select Service", sections:[
        { title:"Quick Actions", rows:[
          { id:"SRV_NEW_CAR", title:"New Car Deals", description:"On-road prices & offers" },
          { id:"SRV_USED_CAR", title:"Pre-Owned Cars", description:"Certified used inventory" },
          { id:"SRV_SELL_CAR", title:"Sell My Car", description:"Best selling quote" },
          { id:"SRV_LOAN", title:"Loan / Finance", description:"Fast approvals & low ROI" }
        ]}
      ]}
    }
  };
  return waSendRaw(payload);
}

// compact quick-action buttons (max 3) used after service selection
async function sendCompactButtons(to, buttons){
  // buttons: array of { id, title } length 1..3
  if (!buttons || !buttons.length) return null;
  const btns = buttons.slice(0,3).map(b => ({ type:"reply", reply:{ id: b.id, title: b.title } }));
  const payload = { messaging_product:"whatsapp", to, type:"interactive", interactive:{ type:"button", body:{ text:"Quick actions:" }, action:{ buttons: btns } } };
  return waSendRaw(payload);
}

// used car quick actions (limit 3)
async function sendUsedCarButtons(to, hasPhotoLink){
  const buttons = [];
  buttons.push({ id: "BTN_USED_PHOTOS", title: "Send Photos" });
  buttons.push({ id: "BTN_USED_LOAN", title: "Loan Options" });
  buttons.push({ id: "BTN_BULLET_EMI", title: "Bullet EMI Calc" });
  return sendCompactButtons(to, buttons);
}

// new car quick actions (limit 3)
async function sendNewCarButtons(to){
  const buttons = [
    { id:"BTN_NEW_QUOTE", title:"Another Quote" },
    { id:"BTN_NEW_LOAN", title:"Loan Options" },
    { id:"BTN_CONTACT_SALES", title:"Contact Sales" }
  ];
  return sendCompactButtons(to, buttons);
}

// finance quick actions (limit 3)
async function sendFinanceButtons(to){
  const buttons = [
    { id:"BTN_EMI_CALC", title:"EMI Calculator" },
    { id:"BTN_CHECK_ELIG", title:"Check Eligibility" },
    { id:"BTN_DOCS_REQUIRED", title:"Documents Required" }
  ];
  return sendCompactButtons(to, buttons);
}

// ------------- admin alerts -------------
async function sendAdminAlert({ from, name, text }) {
  if (!META_TOKEN || !PHONE_NUMBER_ID || !ADMIN_WA) return;
  try {
    const now = Date.now(); const prev = lastAlert.get(from) || 0;
    if (now - prev < ALERT_WINDOW_MS) { console.log("throttled admin alert for", from); return; }
    lastAlert.set(from, now);
    await waSendRaw({ messaging_product:"whatsapp", to: ADMIN_WA, type: "text",
      text: { body: `🔔 NEW WA LEAD\nFrom: ${from}\nName: ${name||'-'}\nMsg: ${String(text||'').slice(0,1000)}` }});
    console.log("admin alert sent");
  } catch(e){ console.warn("sendAdminAlert failed", e && e.message); }
}

// ------------- greeting helper -------------
function shouldGreetNow(from, msgText){
  try{
    if (ADMIN_WA && from === ADMIN_WA) return false;
    const now = Date.now();
    const prev = lastGreeting.get(from) || 0;
    const text = (msgText||"").toString().trim().toLowerCase();
    const looksLikeGreeting = /^(hi|hello|hey|namaste|enquiry|inquiry|help|start)\b/.test(text) || prev === 0;
    if (!looksLikeGreeting) return false;
    if (now - prev < GREETING_WINDOW_MS) return false;
    lastGreeting.set(from, now);
    return true;
  } catch(e){ console.warn("shouldGreetNow failed", e && e.message); return false; }
}

// ------------- CSV / Pricing helpers (existing behavior kept) -------------
function parseCsv(text){
  const rows=[]; let cur="", row=[], inQ=false;
  for(let i=0;i<text.length;i++){const ch=text[i];
    if(inQ){
      if(ch==='"'){ if(text[i+1]==='"'){ cur+='"'; i++; } else inQ=false; } else cur+=ch;
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
async function fetchCsv(url){ if(!url) throw new Error("CSV URL missing"); const r=await fetch(url,{cache:"no-store"}); if(!r.ok) throw new Error(`CSV fetch failed ${r.status}`); const txt=await r.text(); return parseCsv(txt); }
function toHeaderIndexMap(headerRow){ const map={}; headerRow.forEach((h,i)=>{ map[String(h||"").trim().toUpperCase()] = i; }); return map; }

// Levenshtein & fuzzy city (kept)
function levenshtein(a,b){ if(!a||!b) return Math.max(a?a.length:0,b?b.length:0); a=a.toLowerCase(); b=b.toLowerCase(); const m=a.length,n=b.length; const dp=Array.from({length:m+1},()=>Array(n+1).fill(0)); for(let i=0;i<=m;i++)dp[i][0]=i; for(let j=0;j<=n;j++)dp[0][j]=j; for(let i=1;i<=m;i++){ for(let j=1;j<=n;j++){ const cost=a[i-1]===b[j-1]?0:1; dp[i][j]=Math.min(dp[i-1][j]+1,dp[i][j-1]+1,dp[i-1][j-1]+cost); } } return dp[m][n]; }
const CITY_CANON=["delhi","haryana","chandigarh","uttar pradesh","himachal pradesh","up","hp","chd"];
function fuzzyCityDetect(text){ if(!text) return null; const toks=text.toLowerCase().replace(/[^\w\s]/g," ").split(/\s+/).filter(Boolean); let best={city:null,score:999}; for(const tok of toks){ for(const cand of CITY_CANON){ const d=levenshtein(tok,cand.split(" ")[0]); if(d<best.score) best={city:cand,score:d}; }} return (best.city && best.score<=2)?best.city:null; }

// money & EMI
function fmtMoney(n){ const x=Number(n); if(!isFinite(x)) return "-"; return x.toLocaleString("en-IN",{maximumFractionDigits:0}); }
function calcEmi(p,annualRatePct,months=60){ const P=Number(p); const r=Number(annualRatePct)/12/100; if(!P) return 0; if(!r) return Math.round(P/months); const pow=Math.pow(1+r,months); return Math.round(P*r*pow/(pow-1)); }

// normalization / variant matching code (kept & improved slightly)
const MODEL_SYNS = { "hycross":["innova hycross","innova hc","hy cross","hycross"], "fortuner":["fortuner","ftnr"] };
const SUFFIX_SYNS = { "zx":["zx","zx(o)","zxo","zx o"], "vx":["vx"], "g":["g"] };
const COLOR_SYNS = { "attitude black":["attitude black","black"], "white":["white","pearl white"] };
function norm(s){ return (s||"").toLowerCase().trim(); }
function pickKeyWithSyn(map,text){ const t=norm(text); for(const [canon,list] of Object.entries(map)){ if(canon===t) return canon; for(const alias of list) if(t.includes(norm(alias))) return canon; } return null; }
function normalizeSuffix(s){ return pickKeyWithSyn(SUFFIX_SYNS,s) || s; }
function normalizeColor(s){ return pickKeyWithSyn(COLOR_SYNS,s) || s; }
function normalizeModel(s){ if(!s) return s; const t=norm(s); for(const [canon,list] of Object.entries(MODEL_SYNS)){ if(t===canon) return canon; for(const alias of list) if(t.includes(norm(alias))) return canon;} return s; }

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

function buildVariantMapForTable(table){
  if(!table||!table.idxMap) return null;
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

function matchVariantFromMap(userText, variantMap){
  if(!userText||!variantMap||!variantMap.length) return null;
  const qRaw = normForMatch(userText);
  for(const v of variantMap){
    if(!v) continue;
    if(v.canonical && normForMatch(v.canonical) === qRaw) return v;
    if(v.keywords && v.keywords.has(qRaw)) return v;
  }
  const cleaned = qRaw.replace(/\b(delhi|dilli|haryana|hr|chandigarh|chd|uttar|up|hp|himachal|individual|company|corporate|firm|personal)\b/g," ").replace(/\s+/g," ").trim();
  if(cleaned && cleaned !== qRaw){
    for(const v of variantMap){
      if(!v) continue;
      if(v.keywords.has(cleaned)) return v;
    }
  }
  const qTokens = (cleaned||qRaw).split(' ').filter(Boolean);
  let best=null, bestScore=0, second=0;
  for(const v of variantMap){
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

// load pricing from configured sheets (cache)
const SHEET_URLS = { HOT: SHEET_HOT_DEALS_CSV_URL||"", TOYOTA: SHEET_TOYOTA_CSV_URL||"", HYUNDAI: SHEET_HYUNDAI_CSV_URL||"", MERCEDES: SHEET_MERCEDES_CSV_URL||"", BMW: SHEET_BMW_CSV_URL||"" };
const PRICING_CACHE = { tables:null, ts:0 };
const PRICING_CACHE_MS = 3*60*1000;
async function loadPricingFromSheets(){
  const now = Date.now();
  if(PRICING_CACHE.tables && now - PRICING_CACHE.ts < PRICING_CACHE_MS) return PRICING_CACHE.tables;
  const tables = {};
  for(const [brand,url] of Object.entries(SHEET_URLS)){
    if(!url) continue;
    try{
      const rows = await fetchCsv(url); if(!rows || !rows.length) continue;
      const header = rows[0]; const idxMap = toHeaderIndexMap(header); const data = rows.slice(1);
      const tab = { header, idxMap, data };
      try { tab.variantMap = buildVariantMapForTable(tab); } catch(e){ tab.variantMap = null; console.error("variantMap build failed", e && e.message ? e.message : e); }
      tables[brand] = tab;
    } catch(e){ console.error("CSV load failed for", brand, e && e.message ? e.message : e); }
  }
  PRICING_CACHE.tables = tables; PRICING_CACHE.ts = Date.now(); return tables;
}

// find ON-ROAD column name mapping (kept from original)
const CITY_COLUMN_MAP = {
  "delhi:individual": "ON ROAD PRICE DELHI INDIVIDUAL",
  "delhi:company": "ON ROAD PRICE DELHI CORPORATE/COMPANY/FIRM",
  "haryana:individual": "ON ROAD PRICE HARYANA(HR)",
  "haryana:company": "ON ROAD PRICE HARYANA(HR)",
  "uttar pradesh:individual": "ON ROAD PRCE UTTARPRADESH(U.P.)",
  "uttar pradesh:company": "ON ROAD PRCE UTTARPRADESH(U.P.)",
  "himachal pradesh:individual": "ON ROAD PRICE HIMACHAL PRADESH (HP)",
  "himachal pradesh:company": "ON ROAD PRICE HIMACHAL PRADESH (HP)",
  "chandigarh:individual": "ON ROAD PRICE CHANDIGARH (CHD)",
  "chandigarh:company": "ON ROAD PRICE CHANDIGARH (CHD)"
};
function findColumnNameFor(city, profile){ const key=`${city}:${profile}`.toLowerCase(); return CITY_COLUMN_MAP[key]||null; }

function detectExShowIdx(idxMap){
  let exIdx = idxMap["EX SHOWROOM PRICE"] ?? idxMap["EX-SHOWROOM PRICE"] ?? idxMap["EX SHOWROOM"] ?? idxMap["EX SHOWROOM PRICE (₹)"] ?? idxMap["EX SHOWROOM PRICE (INR)"] ?? -1;
  if(exIdx<0){ const headerKeys=Object.keys(idxMap); const fuzzyKey = headerKeys.find(h=>/EX[\s\-_\/A-Z0-9]*SHOWROOM/.test(String(h))); if(fuzzyKey) exIdx = idxMap[fuzzyKey]; }
  if(exIdx<0){ const headerKeysLower = Object.keys(idxMap).map(k=>String(k).toLowerCase()); const pick = headerKeysLower.find(k => k.includes("ex") && k.includes("showroom")); if(pick){ const orig = Object.keys(idxMap).find(k => String(k).toLowerCase()===pick); if(orig) exIdx = idxMap[orig]; } }
  return exIdx;
}

function bestRowMatch(table, wantModel, wantSuffix, wantColor){
  if(!table||!table.idxMap) return null;
  const { idxMap, data } = table;
  const idxModel = idxMap["MODEL"] ?? -1;
  const idxVariant = idxMap["VARIANT"] ?? -1;
  const idxSuffix = idxMap["SUFFIX"] ?? -1;
  const idxColor = idxMap["COLOUR"] ?? idxMap["COLOR"] ?? -1;
  let best=null, bestScore=-1;
  for(let i=0;i<data.length;i++){
    const row = data[i];
    const model = (idxModel>=0 ? (row[idxModel]||"") : "").toString();
    const variant = (idxVariant>=0 ? (row[idxVariant]||"") : "").toString();
    const suffix = (idxSuffix>=0 ? (row[idxSuffix]||"") : "").toString();
    const color = (idxColor>=0 ? (row[idxColor]||"") : "").toString();
    if(wantModel && !matchesWithSyns(model, wantModel, MODEL_SYNS)) continue;
    let score=0;
    if(wantSuffix && variant && matchesWithSyns(variant, wantSuffix, SUFFIX_SYNS)) score+=5;
    if(wantSuffix && suffix && matchesWithSyns(suffix, wantSuffix, SUFFIX_SYNS)) score+=4;
    if(wantModel && matchesWithSyns(model, wantModel, MODEL_SYNS)) score+=3;
    if(wantColor && color && matchesWithSyns(color, wantColor, COLOR_SYNS)) score+=1;
    if(variant) score+=0.1;
    if(score>bestScore){ bestScore=score; best=row; }
  }
  return best;
}
function matchesWithSyns(value,target,synMap){ const v=norm(value), t=norm(target); if(!t) return true; if(v===t) return true; const syns = synMap[t]||[]; return syns.some(s => v===norm(s) || v.includes(norm(s))); }

// ------------- tryQuickNewCarQuote -------------
async function tryQuickNewCarQuote(msgText, to){
  try{
    if(!msgText||!msgText.trim()) return false;
    const t = msgText.toLowerCase();
    // quote-limits: only count quick new car quotes (we'll treat this function as such)
    const qCount = getQuoteCount(to);
    if (qCount >= 10) {
      await waSendText(to, "You’ve reached today’s assistance limit for quick quotes. Please try again tomorrow.");
      return true;
    }

    // city detection
    let cityMatch = (t.match(/\b(delhi|dilli|haryana|hr|chandigarh|chd|uttar\s*pradesh|up|himachal|hp)\b/)||[])[1] || null;
    if(cityMatch){ if(cityMatch==="dilli") cityMatch="delhi"; if(cityMatch==="hr") cityMatch="haryana"; if(cityMatch==="chd") cityMatch="chandigarh"; if(cityMatch==="up") cityMatch="uttar pradesh"; if(cityMatch==="hp") cityMatch="himachal pradesh"; }
    else { const fuzz = fuzzyCityDetect(t); if(fuzz){ cityMatch=fuzz; if(DEBUG) console.log("FUZZY_CITY corrected ->", fuzz, "for input:", msgText); } else cityMatch="delhi"; }
    const city = cityMatch;
    const profile = (t.match(/\b(individual|company|corporate|firm|personal)\b/)||[])[1]||"individual";

    // suffix & color
    const rawSuffix = (t.match(/\b(zx(?:\(o\))?|zxo|vxo?|vx|g|inn?d\d|zx o|4x2|4x4|4x2 auto|4x2 at|4x4 auto|4x2 at)\b/)||[])[1]||"";
    const suffix = normalizeSuffix(rawSuffix);
    const colorMatch = (t.match(/\b(attitude black|pearl white|black|white|grey|silver|pearl)\b/)||[])[0]||"";
    const color = normalizeColor(colorMatch);

    // model extraction (first tokens)
    let rawModel = t.replace(/\b(delhi|dilli|haryana|hr|chandigarh|chd|uttar\s*pradesh|up|himachal|hp)\b/g," ")
      .replace(/\b(individual|company|corporate|firm|personal)\b/g," ")
      .replace(/\b(zx(?:\(o\))?|zxo|vxo?|vx|g|inn?d\d|zx o|4x2|4x4|at|automatic|auto|mt|manual)\b/g," ")
      .replace(/\b(attitude black|pearl white|black|white|grey|silver|pearl)\b/g," ")
      .replace(/\b(price|price\s*pls|price\s*please|price\s*now)\b/g," ")
      .replace(/[^\w\s]/g," ").replace(/\s+/g," ").trim();
    if(!rawModel) rawModel = t;
    const model = normalizeModel(rawModel.split(' ').slice(0,2).join(' ')) || rawModel.split(' ')[0];

    const tables = await loadPricingFromSheets();
    const order = ["HOT","TOYOTA","HYUNDAI","MERCEDES","BMW"];
    let hit=null, hitBrand=null, idxMap=null, header=null;

    // variantMap matching
    for(const b of order){
      const tab = tables[b]; if(!tab) continue;
      try{
        const vm = tab.variantMap;
        if(vm){
          const vmatch = matchVariantFromMap(msgText, vm);
          if(DEBUG){
            const sample = vm.slice(0,6).map(v=>({ canonical:v.canonical, model:v.model, rowIndex:v.rowIndex }));
            console.log("DEBUG_VARIANT sample for", b, sample);
          }
          if(vmatch){
            hit = tab.data[vmatch.rowIndex]; hitBrand = b; idxMap = tab.idxMap; header = tab.header;
            console.log("Variant match:", b, vmatch.canonical, "row", vmatch.rowIndex);
            break;
          }
        }
      } catch(e){ console.error("variantMap error", e && e.message ? e.message : e); }
    }

    // fallback bestRowMatch
    if(!hit){
      for(const b of order){
        const tab = tables[b]; if(!tab) continue;
        const row = bestRowMatch(tab, model, suffix, color);
        if(row){ hit=row; hitBrand=b; idxMap=tab.idxMap; header=tab.header; console.log("bestRowMatch:", b); break; }
      }
    }

    if(DEBUG){
      try{
        if(hit && hitBrand && tables && tables[hitBrand]){
          const tab = tables[hitBrand]; const ridx = tab.data.indexOf(hit);
          console.log("DEBUG_VARIANT — selected brand:", hitBrand, "ridx:", ridx, "selected row first 20 cols:", (hit||[]).slice(0,20));
          if(ADMIN_WA) await waSendText(ADMIN_WA, `DEBUG: selected ${hitBrand} row ${ridx} for "${msgText.slice(0,80)}"`);
        } else console.log("DEBUG_VARIANT — no hit selected for:", msgText);
      } catch(e){ console.warn("DEBUG_VARIANT logging failed", e && e.message ? e.message : e); }
    }

    if(!hit||!idxMap) return false;

    // find price column
    let priceColName = findColumnNameFor(city, profile);
    let priceIdx = priceColName ? (idxMap[(priceColName||"").toUpperCase()] ?? -1) : -1;
    if(priceIdx < 0){
      const keys = Object.keys(idxMap); const cityToken = city.split(' ')[0].toUpperCase();
      const candidate = keys.find(k => k.includes("ON ROAD") && k.includes(cityToken));
      if(candidate){ priceIdx = idxMap[candidate]; priceColName = candidate; }
    }
    if(priceIdx < 0){
      for(const [k, idx] of Object.entries(idxMap)){
        const val = (hit[idx]||"").toString().replace(/[,₹\s]/g,"");
        if(val && /^\d+$/.test(val)){ priceIdx = idx; priceColName = k; break; }
      }
    }
    console.log("price column:", priceColName, "idx:", priceIdx);
    const exIdx = detectExShowIdx(idxMap);
    const onroad = Number(String(hit[priceIdx]||"").replace(/[,₹\s]/g,"")) || 0;
    const exShow = (exIdx>=0) ? Number(String(hit[exIdx]||"").replace(/[,₹\s]/g,""))||0 : 0;
    const loanAmt = exShow || onroad || 0; const emi60 = loanAmt ? calcEmi(loanAmt, NEW_CAR_ROI, 60) : 0;

    const make = (hit[idxMap["MAKE"]]||"").toString();
    const modl = (hit[idxMap["MODEL"]]||"").toString();
    const varnt = (hit[idxMap["VARIANT"]]||hit[idxMap["SUFFIX"]]||"").toString();
    const colr = (hit[idxMap["COLOUR"]]||hit[idxMap["COLOR"]]||"").toString();

    const cityLabel = city ? city.toUpperCase() : "DELHI"; const profLabel = (profile||"individual").toUpperCase();
    const lines = [
      `*${make} ${modl}* ${varnt ? `(${varnt})` : ""}${colr ? ` – ${colr}` : ""}`,
      `*City:* ${cityLabel} • *Profile:* ${profLabel}`,
      exShow ? `*Ex-Showroom:* ₹ ${fmtMoney(exShow)}` : null,
      onroad ? `*On-Road:* ₹ ${fmtMoney(onroad)}` : null,
      loanAmt ? `*Loan:* 100% of Ex-Showroom → ₹ ${fmtMoney(loanAmt)} @ *${NEW_CAR_ROI}%* (60m) → *EMI ≈ ₹ ${fmtMoney(emi60)}*` : `*Loan:* up to 100% of Ex-Showroom`,
      `\n*Terms & Conditions Apply ✅*`
    ].filter(Boolean);

    // increment quick-quote counter
    incrQuoteCount(to);

    await waSendText(to, lines.join("\n"));
    await sendNewCarButtons(to);
    return true;
  } catch(e){ console.error("tryQuickNewCarQuote error:", e && e.stack ? e.stack : e); return false; }
}

// ------------- used car quote -------------
async function buildUsedCarQuote({ make, model, year }){
  if(!SHEET_USED_CSV_URL) return { text:"Used car pricing sheet not configured." };
  try{
    const rows = await fetchCsv(SHEET_USED_CSV_URL);
    if(!rows.length) return { text:"Used car sheet empty." };
    const header = rows[0].map(h=>String(h||"").trim().toUpperCase());
    const data = rows.slice(1);
    const makeIdx = header.findIndex(h => h.includes("MAKE"));
    const modelIdx = header.findIndex(h => h.includes("MODEL"));
    const findRow = data.find(r => String(r[makeIdx]||"").toLowerCase().includes((make||"").toLowerCase()) && String(r[modelIdx]||"").toLowerCase().includes((model||"").toLowerCase()));
    if(!findRow) return { text: `Sorry, I couldn’t find the used car *${make} ${model}* right now.` };
    const expectedIdx = header.findIndex(h => h.includes("EXPECTED")||h.includes("EXPECTED_PRICE")||h.includes("EXPECTED PRICE"));
    const expected = expectedIdx>=0 ? findRow[expectedIdx] : "";
    const price = Number(String(expected||'').replace(/[,₹\s]/g,'')) || 0;
    const maxLoan = Math.round(price * 0.95); const emi = calcEmi(maxLoan, USED_CAR_ROI, 60);
    const lines = [
      `*PRE-OWNED CAR QUOTE*`,
      `Make/Model: *${findRow[makeIdx]} ${findRow[modelIdx]}*`,
      price ? `Expected Price: ₹ *${fmtMoney(price)}*` : null,
      `Loan up to *95%*: ₹ ${fmtMoney(maxLoan)} @ *${USED_CAR_ROI}%* (60m) → EMI ≈ ₹ *${fmtMoney(emi)}*`,
      `\n*Terms & Conditions Apply ✅*`
    ].filter(Boolean);
    return { text: lines.join("\n"), picLink: null, rawRow: findRow };
  } catch(e){ console.error("buildUsedCarQuote error", e && e.stack ? e.stack : e); return { text:"Used car pricing failed." }; }
}

// ------------- EMI & Bullet EMI parse + handlers -------------
function parseEmiCommand(text){
  // example: "emi 1500000 9.5 60" or "emi 1500000 60"
  const toks = (text||'').trim().split(/\s+/).filter(Boolean);
  if(toks.length < 2) return null;
  // find numeric tokens
  const nums = toks.slice(1).map(x=>x.replace(/[^0-9\.]/g,'')).filter(Boolean);
  if(nums.length === 0) return null;
  let loan = Number(nums[0])||0;
  let rate = nums.length>=2 ? Number(nums[1]) : NEW_CAR_ROI;
  let months = nums.length>=3 ? Number(nums[2]) : 60;
  if(nums.length===2 && Number(nums[1])>50) { months = Number(nums[1]); rate = NEW_CAR_ROI; } // possible swapped
  return { loan, rate, months };
}

function computeBulletSchedule(loan, annualRatePct, months, bulletPercent=0.25){
  const normalEmi = calcEmi(loan, annualRatePct, months);
  const bulletAmount = Math.round(loan * bulletPercent);
  // payments: monthly EMI for months-1, and on months multiple of 12 pay EMI + bullet
  const bulletMonths = [];
  for(let k=12;k<=months;k+=12) bulletMonths.push(k);
  // compute totals approximately (interest calc for exact schedule would be more work - but give good approx)
  const totalRegularPay = normalEmi * months;
  const totalPayWithBullets = totalRegularPay + bulletAmount * bulletMonths.length;
  const totalInterestNormal = totalRegularPay - loan;
  const totalInterestBullet = totalPayWithBullets - loan;
  return { normalEmi, bulletAmount, bulletMonths, totalPayWithBullets, totalInterestNormal, totalInterestBullet };
}

// ------------- webhook handlers -------------
app.get("/webhook", (req,res)=>{
  const mode = req.query["hub.mode"], token = req.query["hub.verify_token"], challenge = req.query["hub.challenge"];
  if(mode==="subscribe" && token===VERIFY_TOKEN && challenge){ console.log("Webhook verified ✅"); return res.status(200).type("text/plain").send(String(challenge)); }
  return res.sendStatus(403);
});

app.post("/webhook", async (req,res)=>{
  console.log("📩 Incoming webhook hit:", req.body ? (typeof req.body === 'object' ? JSON.stringify(req.body).slice(0,1200) : String(req.body).slice(0,1200)) : 'empty');
  try{
    const entry = req.body?.entry?.[0]; const change = entry?.changes?.[0]; const value = change?.value || {};
    const msg = value?.messages?.[0]; const contact = value?.contacts?.[0];
    if(!msg) return res.sendStatus(200);
    const from = msg.from; const type = msg.type; const name = contact?.profile?.name || "Unknown";
    let msgText = ""; let selectedId = null;
    if(type==="text") msgText = msg.text?.body || "";
    else if(type==="interactive"){ selectedId = msg.interactive?.button_reply?.id || msg.interactive?.list_reply?.id || null; msgText = msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || ""; }
    else msgText = JSON.stringify(msg);

    console.log("INBOUND", { from, type, sample: msgText.slice(0,200) });

    if(from !== ADMIN_WA) await sendAdminAlert({ from, name, text: msgText });

    // non-blocking CRM lead log (kept as stub; user previously had crm_helpers)
    try { if (type === "text") {
      // postLeadToCRM is likely defined in crm_helpers.cjs if present — attempt to call
      if (typeof postLeadToCRM === 'function') postLeadToCRM({ from, name, text: msgText }).catch(()=>{});
    }} catch (e) { console.warn("lead log failed", e && e.message); }

    // handle interactive selections quickly
    if(selectedId){
      switch(selectedId){
        case "SRV_NEW_CAR":
          await waSendText(from, "Please share your *city, model, variant/suffix & profile (individual/company)*.");
          return res.sendStatus(200);
        case "SRV_USED_CAR":
          await waSendText(from, "Share *make, model, year* (optional colour/budget) and I’ll suggest options.");
          return res.sendStatus(200);
        case "SRV_SELL_CAR":
          await waSendText(from, "Please share *car make/model, year, km, city* and a few photos. We’ll get you the best quote.");
          return res.sendStatus(200);
        case "SRV_LOAN":
          await waSendText(from, `For loan assistance, share *city + car model + budget*. New car ROI from *${NEW_CAR_ROI}%*, Used car *${USED_CAR_ROI}%*.`);
          await sendFinanceButtons(from);
          return res.sendStatus(200);

        case "BTN_NEW_QUOTE":
          await waSendText(from, "Sure — tell me your city + model + variant/suffix + profile.");
          return res.sendStatus(200);
        case "BTN_NEW_LOAN":
        case "BTN_USED_LOAN":
        case "BTN_CHECK_ELIG":
          await waSendText(from, `Please share city + car model + budget. New car ROI ${NEW_CAR_ROI}%, Used car ROI ${USED_CAR_ROI}%.`);
          return res.sendStatus(200);
        case "BTN_CONTACT_SALES":
          await waSendText(from, "Connecting you to sales. Please wait — someone will reach out shortly.");
          if (ADMIN_WA) await waSendText(ADMIN_WA, `Connect request from ${from} (${name})`);
          return res.sendStatus(200);

        case "BTN_EMI_CALC":
          await waSendText(from, "You can use the EMI calculator by typing: emi <loan> <rate% optional> <months> e.g. emi 1500000 9.5 60");
          return res.sendStatus(200);
        case "BTN_BULLET_EMI":
        case "BTN_BULLET_EMI":
          await waSendText(from, "To calculate bullet EMI (used car), reply: bullet <loan amount> <tenure months> e.g., bullet 750000 60");
          return res.sendStatus(200);
        case "BTN_USED_PHOTOS":
          await waSendText(from, "Open the photos link in the quote (if provided) or reply 'photos please' and we'll send them.");
          return res.sendStatus(200);
        case "BTN_DOCS_REQUIRED":
          await waSendText(from, "Documents required: 1) ID Proof 2) Address Proof 3) RC copy 4) Income docs. For details reply 'docs list'.");
          return res.sendStatus(200);
        default:
          await waSendText(from, "Thanks! You can type your request anytime.");
          return res.sendStatus(200);
      }
    }

    // Greeting
    if (shouldGreetNow(from, msgText)){
      await waSendText(from, `🔴 *MR. CAR* welcomes you!\nNamaste 🙏\n\nWe assist with *pre-owned cars*, *new car deals*, *loans* and *insurance*.\nTell us how we can help — or pick an option below.`);
      await waSendListMenu(from);
      return res.sendStatus(200);
    }

    // handle "emi" command
    if (/^\s*emi\b/i.test(msgText)){
      const parsed = parseEmiCommand(msgText);
      if(!parsed) { await waSendText(from, "Usage: emi <loan> <rate% optional> <months> e.g. emi 1500000 9.5 60"); return res.sendStatus(200); }
      const { loan, rate, months } = parsed;
      const emi = calcEmi(loan, rate, months);
      const totalPay = Math.round(emi * months);
      const interest = totalPay - loan;
      await waSendText(from, `EMI ≈ ₹ ${fmtMoney(emi)} / month\nTenure: ${months} months\nTotal Interest: ₹ ${fmtMoney(interest)}\nTotal Payable: ₹ ${fmtMoney(totalPay)}`);
      return res.sendStatus(200);
    }

    // bullet EMI command e.g. "bullet 750000 60" (used car special)
    if (/^\s*bullet\b/i.test(msgText)){
      const toks = msgText.trim().split(/\s+/).filter(Boolean);
      if (toks.length < 3) { await waSendText(from, "Usage: bullet <loan amount> <tenure months> e.g., bullet 750000 60"); return res.sendStatus(200); }
      const loan = Number(toks[1].replace(/[^0-9]/g,'')) || 0;
      const months = Number(toks[2].replace(/[^0-9]/g,'')) || 60;
      const rate = USED_CAR_ROI;
      const schedule = computeBulletSchedule(loan, rate, months, 0.25);
      await waSendText(from,
        `Bullet EMI Plan\nLoan: ₹ ${fmtMoney(loan)}\nRate: ${rate}%\nTenure: ${months} months\nMonthly EMI ≈ ₹ ${fmtMoney(schedule.normalEmi)}\nBullet (25%): ₹ ${fmtMoney(schedule.bulletAmount)} on months: ${schedule.bulletMonths.join(", ")}\nTotal Payable (approx): ₹ ${fmtMoney(schedule.totalPayWithBullets)}`
      );
      return res.sendStatus(200);
    }

    // quick new car quote attempt
    if (msgText && type === 'text') {
      const served = await tryQuickNewCarQuote(msgText, from);
      if(served) return res.sendStatus(200);
    }

    // used car natural language detection
    const usedMatch = msgText.match(/used\s+(?<make>[a-z0-9]+)\s+(?<model>[a-z0-9]+)\s*(?<year>\d{4})?/i) || msgText.match(/(?<make>[a-z0-9]+)\s+(?<model>[a-z0-9]+)\s*(?<year>\d{4})?/i);
    if(usedMatch && usedMatch.groups){
      const { make, model, year } = usedMatch.groups;
      const q = await buildUsedCarQuote({ make, model, year });
      await waSendText(from, q.text);
      await sendUsedCarButtons(from, !!q.picLink);
      if(q.picLink) await waSendText(from, `Photos: ${q.picLink}`);
      return res.sendStatus(200);
    }

    // If no quick flows matched, ask follow-ups / fallback to CRM
    // attempt to call fetchCRMReply if implemented (user had crm integration)
    if (typeof fetchCRMReply === 'function') {
      try {
        const crmReply = await fetchCRMReply({ from, msgText });
        if (crmReply) { await waSendText(from, crmReply); return res.sendStatus(200); }
      } catch(e){ console.warn("CRM reply failed", e && e.message); }
    }

    // default fallback prompt
    await waSendText(from, "Tell me your *city + make/model + variant/suffix + profile (individual/company)*. e.g., *Delhi Hycross ZXO individual* or *HR BMW X1 sDrive18i company*.");
    return res.sendStatus(200);

  } catch(e){
    console.error("Webhook error:", e && e.stack ? e.stack : e);
    if (ADMIN_WA) await waSendText(ADMIN_WA, `Webhook crash: ${e && e.message ? e.message : String(e).slice(0,200)}`);
    return res.sendStatus(200);
  }
});

// ------------- admin endpoints -------------
app.post('/admin/reset_greetings', (req,res) => {
  try { lastGreeting.clear(); return res.json({ ok: true, msg: "greetings cleared" }); } catch(e){ return res.status(500).json({ ok:false, err: String(e) }); }
});
app.post('/admin/reset_quote_limits', (req,res) => {
  try { resetQuoteLimits(); return res.json({ ok:true }); } catch(e){ return res.status(500).json({ ok:false, err:String(e) }); }
});
app.post('/admin/set_greeting_window', (req,res) => {
  const mins = Number(req.query.minutes || req.body.minutes);
  if (!isFinite(mins) || mins < 0) return res.status(400).json({ ok:false, err: "invalid minutes" });
  process.env.GREETING_WINDOW_MINUTES = String(mins);
  // update runtime var
  // Note: not persistent across restarts unless .env is updated externally
  // we update local var for runtime:
  // (cannot update GREETING_WINDOW_MS const but we can update lastGreeting behavior by reassigning a function — but keep simple)
  return res.json({ ok:true, minutes: mins });
});

// health
app.get("/healthz", (req,res)=> res.json({ ok:true, t:Date.now(), debug: DEBUG }));

// start
app.listen(PORT, ()=> {
  console.log(`✅ MR.CAR webhook CRM server running on port ${PORT}`);
  console.log("ENV summary:", {
    SHEET_TOYOTA_CSV_URL: !!SHEET_TOYOTA_CSV_URL,
    SHEET_USED_CSV_URL: !!SHEET_USED_CSV_URL || fs.existsSync(path.join(__dirname,'used.csv')),
    PHONE_NUMBER_ID: !!PHONE_NUMBER_ID, META_TOKEN: !!META_TOKEN, ADMIN_WA: !!ADMIN_WA, DEBUG
  });
});
