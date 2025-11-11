// server.cjs — MR.CAR webhook (final drop-in — transmission synonyms + token-subset matching)
// CommonJS — ready for Render. DEBUG_VARIANT active by default.

require('dotenv').config();
const express = require('express');
const fetch = (global.fetch) ? global.fetch : require('node-fetch');
const app = express();
app.use(express.json());

// ------------- ENV -------------
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

const PORT = process.env.PORT || 10000;

// ------------- defaults -------------
const GREETING_WINDOW_MINUTES = Number(process.env.GREETING_WINDOW_MINUTES || 600);
const ALERT_WINDOW_MINUTES = Number(process.env.ALERT_WINDOW_MINUTES || 10);
const GREETING_WINDOW_MS = GREETING_WINDOW_MINUTES * 60 * 1000;
const ALERT_WINDOW_MS = ALERT_WINDOW_MINUTES * 60 * 1000;
const NEW_CAR_ROI = Number(process.env.NEW_CAR_ROI || 8.10);
const USED_CAR_ROI = Number(process.env.USED_CAR_ROI || 9.99);
if (!process.env.DEBUG_VARIANT) process.env.DEBUG_VARIANT = "true";

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
    if (!r.ok) console.error("WA send error", r.status, j);
    return j;
  } catch(e) { console.error("waSendRaw failed", e && e.stack ? e.stack : e); return null; }
}
async function waSendText(to, body){ return waSendRaw({ messaging_product:"whatsapp", to, type:"text", text:{ body } }); }
async function waSendListMenu(to){
  const payload = {
    messaging_product: "whatsapp", to, type: "interactive",
    interactive: {
      type: "list",
      header:{ type:"text", text:"MR. CAR SERVICES" },
      body:{ text:"Please choose one option 👇" },
      footer:{ text:"Victory. Luxury. Mr. Car." },
      action:{ button:"Select Service", sections:[
        { title:"Available", rows:[
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
async function sendNewCarButtons(to){
  const payload = { messaging_product:"whatsapp", to, type:"interactive", interactive:{
    type:"button", body:{ text:"You can continue with these quick actions:" }, action:{ buttons:[
      { type:"reply", reply:{ id:"BTN_NEW_LOAN", title:"Loan Options" } },
      { type:"reply", reply:{ id:"BTN_NEW_QUOTE", title:"Another Quote" } }
    ]}}};
  return waSendRaw(payload);
}
async function sendUsedCarButtons(to, hasPhotoLink){
  const buttons = [
    { type:"reply", reply:{ id:"BTN_USED_LOAN", title:"Loan Options" } },
    { type:"reply", reply:{ id:"BTN_USED_MORE", title:"More Options" } }
  ];
  if (hasPhotoLink) buttons.unshift({ type:"reply", reply:{ id:"BTN_USED_PHOTOS", title:"View Photos 📸" } });
  return waSendRaw({ messaging_product:"whatsapp", to, type:"interactive", interactive:{ type:"button", body:{ text:"Quick actions:" }, action:{ buttons } }});
}

// ------------- admin alerts -------------
const lastAlert = new Map();
async function sendAdminAlert({ from, name, text }) {
  if (!META_TOKEN || !PHONE_NUMBER_ID || !ADMIN_WA) return;
  const now = Date.now(); const prev = lastAlert.get(from) || 0;
  if (now - prev < ALERT_WINDOW_MS) { console.log("throttled admin alert for", from); return; }
  lastAlert.set(from, now);
  await waSendRaw({ messaging_product:"whatsapp", to: ADMIN_WA, type:"text",
    text: { body: `🔔 NEW WA LEAD\nFrom: ${from}\nName: ${name||'-'}\nMsg: ${String(text||'').slice(0,1000)}` }});
  console.log("admin alert sent");
}

// ------------- greeting -------------
const lastGreeting = new Map();
function shouldGreetNow(from, msgText){
  if (ADMIN_WA && from === ADMIN_WA) return false;
  const now = Date.now(); const prev = lastGreeting.get(from) || 0;
  const text = (msgText||"").trim().toLowerCase();
  const looksLikeGreeting = /^(hi|hello|hey|namaste|enquiry|inquiry|help|start)\b/.test(text) || prev === 0;
  if (!looksLikeGreeting) return false;
  if (now - prev < GREETING_WINDOW_MS) return false;
  lastGreeting.set(from, now); return true;
}

// ------------- CSV utils -------------
function parseCsv(text){ const rows=[]; let cur="", row=[], inQ=false; for(let i=0;i<text.length;i++){const ch=text[i]; if(inQ){ if(ch==='"'){ if(text[i+1]==='"'){ cur+='"'; i++; } else inQ=false; } else cur+=ch; } else { if(ch==='"') inQ=true; else if(ch===','){ row.push(cur); cur=""; } else if(ch==='\n'){ row.push(cur); rows.push(row); row=[]; cur=""; } else if(ch!=='\r') cur+=ch; } } if(cur.length||row.length){ row.push(cur); rows.push(row);} return rows; }
async function fetchCsv(url){ if(!url) throw new Error("CSV URL missing"); const r=await fetch(url,{cache:"no-store"}); if(!r.ok) throw new Error(`CSV fetch failed ${r.status}`); const txt=await r.text(); return parseCsv(txt); }
function toHeaderIndexMap(headerRow){ const map={}; headerRow.forEach((h,i)=>{ map[String(h||"").trim().toUpperCase()] = i; }); return map; }

// ------------- fuzzy city -------------
function levenshtein(a,b){ if(!a||!b) return Math.max(a?a.length:0,b?b.length:0); a=a.toLowerCase(); b=b.toLowerCase(); const m=a.length,n=b.length; const dp=Array.from({length:m+1},()=>Array(n+1).fill(0)); for(let i=0;i<=m;i++)dp[i][0]=i; for(let j=0;j<=n;j++)dp[0][j]=j; for(let i=1;i<=m;i++){ for(let j=1;j<=n;j++){ const cost=a[i-1]===b[j-1]?0:1; dp[i][j]=Math.min(dp[i-1][j]+1,dp[i][j-1]+1,dp[i-1][j-1]+cost); } } return dp[m][n]; }
const CITY_CANON=["delhi","haryana","chandigarh","uttar pradesh","himachal pradesh","up","hp","chd"];
function fuzzyCityDetect(text){ if(!text) return null; const toks=text.toLowerCase().replace(/[^\w\s]/g," ").split(/\s+/).filter(Boolean); let best={city:null,score:999}; for(const tok of toks){ for(const cand of CITY_CANON){ const d=levenshtein(tok,cand.split(" ")[0]); if(d<best.score) best={city:cand,score:d}; }} return (best.city && best.score<=2)?best.city:null; }

// ------------- money/emi -------------
function fmtMoney(n){ const x=Number(n); if(!isFinite(x)) return "-"; return x.toLocaleString("en-IN",{maximumFractionDigits:0}); }
function calcEmi(p,annualRatePct,months=60){ const P=Number(p); const r=Number(annualRatePct)/12/100; if(!P||!r) return 0; const pow=Math.pow(1+r,months); return Math.round(P*r*pow/(pow-1)); }

// ------------- synonyms & normalization -------------
const MODEL_SYNS = { "hycross":["innova hycross","innova hc","hy cross","hycross"], "fortuner":["fortuner","ftnr"] };
const SUFFIX_SYNS = { "zx":["zx","zx(o)","zxo","zx o"], "vx":["vx"], "g":["g"] };
const COLOR_SYNS = { "attitude black":["attitude black","black"], "white":["white","pearl white"] };
function norm(s){ return (s||"").toLowerCase().trim(); }
function pickKeyWithSyn(map,text){ const t=norm(text); for(const [canon,list] of Object.entries(map)){ if(canon===t) return canon; for(const alias of list) if(t.includes(norm(alias))) return canon; } return null; }
function normalizeSuffix(s){ return pickKeyWithSyn(SUFFIX_SYNS,s) || s; }
function normalizeColor(s){ return pickKeyWithSyn(COLOR_SYNS,s) || s; }
function normalizeModel(s){ if(!s) return s; const t=norm(s); for(const [canon,list] of Object.entries(MODEL_SYNS)){ if(t===canon) return canon; for(const alias of list) if(t.includes(norm(alias))) return canon;} return s; }
function matchesWithSyns(value,target,synMap){ const v=norm(value), t=norm(target); if(!t) return true; if(v===t) return true; const syns = synMap[t]||[]; return syns.some(s => v===norm(s) || v.includes(norm(s))); }

// ------------- robust normalization for matching -------------
function normForMatch(s){
  // key normalizations:
  // - treat / and * as 'x' (4/2 -> 4x2)
  // - map automatic/auto -> at ; manual/man -> mt
  // - compact whitespace and remove punctuation
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

// ------------- build variant map (expanded tokens & n-grams) -------------
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
    // Expand n-grams of canonical and keywords to help partial matches (e.g., '4x2 at', '4x2')
    const addTokens = (txt)=>{
      const n = normForMatch(txt);
      if(!n) return;
      keywords.add(n);
      const toks = n.split(' ').filter(Boolean);
      for(let i=0;i<toks.length;i++){
        // unigrams and bigrams
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

// ------------- match variant from map (subset & token overlap) -------------
function matchVariantFromMap(userText, variantMap){
  if(!userText||!variantMap||!variantMap.length) return null;
  const qRaw = normForMatch(userText);
  // 1) exact or keyword hit
  for(const v of variantMap){
    if(!v) continue;
    if(v.canonical && normForMatch(v.canonical) === qRaw) return v;
    if(v.keywords && v.keywords.has(qRaw)) return v;
  }
  // 2) cleaned (strip city/profile) exact
  const cleaned = qRaw.replace(/\b(delhi|dilli|haryana|hr|chandigarh|chd|uttar|up|hp|himachal|individual|company|corporate|firm|personal)\b/g," ").replace(/\s+/g," ").trim();
  if(cleaned && cleaned !== qRaw){
    for(const v of variantMap){
      if(!v) continue;
      if(v.keywords.has(cleaned)) return v;
    }
  }
  // 3) token-subset matching & overlap scoring
  const qTokens = (cleaned||qRaw).split(' ').filter(Boolean);
  let best=null, bestScore=0, second=0;
  for(const v of variantMap){
    const all = Array.from(v.keywords).join(' ');
    const vTokens = all.split(' ').filter(Boolean);
    // quick subset checks
    const qInV = qTokens.every(t => vTokens.includes(t));
    const vInQ = vTokens.every(t => qTokens.includes(t));
    if(qInV) { return v; } // user tokens fully match variant tokens -> high confidence
    // scoring: exact token matches stronger; partial matches weaker
    let score=0;
    for(const t of qTokens){
      for(const vt of vTokens){
        if(vt===t) score += 6;
        else if(vt.includes(t) || t.includes(vt)) score += 4;
      }
    }
    // special boosts
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

// ------------- load pricing -------------
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

// ------------- bestRowMatch fallback -------------
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

// ------------- city→col map -------------
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

// ------------- tryQuickNewCarQuote -------------
async function tryQuickNewCarQuote(msgText, to){
  try{
    if(!msgText||!msgText.trim()) return false;
    const t = msgText.toLowerCase();
    // city detection
    let cityMatch = (t.match(/\b(delhi|dilli|haryana|hr|chandigarh|chd|uttar\s*pradesh|up|himachal|hp)\b/)||[])[1] || null;
    if(cityMatch){ if(cityMatch==="dilli") cityMatch="delhi"; if(cityMatch==="hr") cityMatch="haryana"; if(cityMatch==="chd") cityMatch="chandigarh"; if(cityMatch==="up") cityMatch="uttar pradesh"; if(cityMatch==="hp") cityMatch="himachal pradesh"; }
    else { const fuzz = fuzzyCityDetect(t); if(fuzz){ cityMatch=fuzz; if(process.env.DEBUG_VARIANT==="true") console.log("FUZZY_CITY corrected ->", fuzz, "for input:", msgText); } else cityMatch="delhi"; }
    const city = cityMatch;
    const profile = (t.match(/\b(individual|company|corporate|firm|personal)\b/)||[])[1]||"individual";
    // suffix
    const rawSuffix = (t.match(/\b(zx(?:\(o\))?|zxo|vxo?|vx|g|inn?d\d|zx o)\b/)||[])[1]||"";
    const suffix = normalizeSuffix(rawSuffix);
    // color
    const colorMatch = (t.match(/\b(attitude black|pearl white|black|white|grey|silver|pearl)\b/)||[])[0]||"";
    const color = normalizeColor(colorMatch);
    // model extraction
    let rawModel = t.replace(/\b(delhi|dilli|haryana|hr|chandigarh|chd|uttar\s*pradesh|up|himachal|hp)\b/g," ")
      .replace(/\b(individual|company|corporate|firm|personal)\b/g," ")
      .replace(/\b(zx(?:\(o\))?|zxo|vxo?|vx|g|inn?d\d|zx o)\b/g," ")
      .replace(/\b(attitude black|pearl white|black|white|grey|silver|pearl)\b/g," ")
      .replace(/\b(price|price\s*pls|price\s*please|price\s*now)\b/g," ")
      .replace(/[^\w\s]/g," ").replace(/\s+/g," ").trim();
    if(!rawModel) rawModel = t;
    const model = normalizeModel(rawModel.split(' ').slice(0,2).join(' ')) || rawModel.split(' ')[0];
    // load sheets
    const tables = await loadPricingFromSheets();
    const order = ["HOT","TOYOTA","HYUNDAI","MERCEDES","BMW"];
    let hit=null, hitBrand=null, idxMap=null, header=null;
    // 1) variantMap matches
    for(const b of order){
      const tab = tables[b]; if(!tab) continue;
      try{
        const vm = tab.variantMap;
        if(vm){
          const vmatch = matchVariantFromMap(msgText, vm);
          if(process.env.DEBUG_VARIANT==="true"){
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
    // 2) fallback bestRowMatch
    if(!hit){
      for(const b of order){
        const tab = tables[b]; if(!tab) continue;
        const row = bestRowMatch(tab, model, suffix, color);
        if(row){ hit=row; hitBrand=b; idxMap=tab.idxMap; header=tab.header; console.log("bestRowMatch:", b); break; }
      }
    }
    // debug selected row
    if(process.env.DEBUG_VARIANT==="true"){
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
    const make = hit[idxMap["MAKE"]] || ""; const modl = hit[idxMap["MODEL"]] || ""; const varnt = hit[idxMap["VARIANT"]] || hit[idxMap["SUFFIX"]] || ""; const colr = hit[idxMap["COLOUR"]] || hit[idxMap["COLOR"]] || "";
    const cityLabel = city ? city.toUpperCase() : "DELHI"; const profLabel = (profile||"individual").toUpperCase();
    const lines = [
      `*${make} ${modl}* ${varnt ? `(${varnt})` : ""}${colr ? ` – ${colr}` : ""}`,
      `*City:* ${cityLabel} • *Profile:* ${profLabel}`,
      exShow ? `*Ex-Showroom:* ₹ ${fmtMoney(exShow)}` : null,
      onroad ? `*On-Road:* ₹ ${fmtMoney(onroad)}` : null,
      loanAmt ? `*Loan:* 100% of Ex-Showroom → ₹ ${fmtMoney(loanAmt)} @ *${NEW_CAR_ROI}%* (60m) → *EMI ≈ ₹ ${fmtMoney(emi60)}*` : `*Loan:* up to 100% of Ex-Showroom`,
      `\n*Terms & Conditions Apply ✅*`
    ].filter(Boolean);
    await waSendText(to, lines.join("\n"));
    await sendNewCarButtons(to);
    return true;
  } catch(e){ console.error("tryQuickNewCarQuote error:", e && e.stack ? e.stack : e); return false; }
}

// ------------- ex-showroom detect -------------
function detectExShowIdx(idxMap){
  let exIdx = idxMap["EX SHOWROOM PRICE"] ?? idxMap["EX-SHOWROOM PRICE"] ?? idxMap["EX SHOWROOM"] ?? idxMap["EX SHOWROOM PRICE (₹)"] ?? idxMap["EX SHOWROOM PRICE (INR)"] ?? -1;
  if(exIdx<0){ const headerKeys=Object.keys(idxMap); const fuzzyKey = headerKeys.find(h=>/EX[\s\-_\/A-Z0-9]*SHOWROOM/.test(String(h))); if(fuzzyKey) exIdx = idxMap[fuzzyKey]; }
  if(exIdx<0){ const headerKeysLower = Object.keys(idxMap).map(k=>String(k).toLowerCase()); const pick = headerKeysLower.find(k => k.includes("ex") && k.includes("showroom")); if(pick){ const orig = Object.keys(idxMap).find(k => String(k).toLowerCase()===pick); if(orig) exIdx = idxMap[orig]; } }
  return exIdx;
}

// ------------- used car -------------
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
    return { text: lines.join("\n"), picLink: null };
  } catch(e){ console.error("buildUsedCarQuote error", e && e.stack ? e.stack : e); return { text:"Used car pricing failed." }; }
}

// ------------- webhook -------------
app.get("/webhook", (req,res)=>{
  const mode = req.query["hub.mode"], token = req.query["hub.verify_token"], challenge = req.query["hub.challenge"];
  if(mode==="subscribe" && token===VERIFY_TOKEN && challenge){ console.log("Webhook verified ✅"); return res.status(200).type("text/plain").send(String(challenge)); }
  return res.sendStatus(403);
});

app.post("/webhook", async (req,res)=>{
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
    if(selectedId){
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
          await waSendText(from, `For loan assistance, share *city + car model + budget*. New car ROI from *${NEW_CAR_ROI}%*, Used car *${USED_CAR_ROI}%*.`);
          break;
        case "BTN_USED_PHOTOS":
          await waSendText(from, "Please tap the Google Drive link in the quote to view photos. If missing, reply “photos please”.");
          break;
        default:
          await waSendText(from, "Thanks! You can type your request anytime.");
      }
      return res.sendStatus(200);
    }
    if(shouldGreetNow(from, msgText)){
      await waSendText(from, `🔴 *MR. CAR* welcomes you!\nNamaste 🙏\n\nWe assist with *pre-owned cars*, *new car deals*, *loans* and *insurance*.\nTell us how we can help — or pick an option below.`);
      await waSendListMenu(from); return res.sendStatus(200);
    }
    if(msgText && type==="text"){
      const served = await tryQuickNewCarQuote(msgText, from);
      if(served) return res.sendStatus(200);
    }
    const usedMatch = msgText.match(/used\s+(?<make>[a-z0-9]+)\s+(?<model>[a-z0-9]+)\s*(?<year>\d{4})?/i) || msgText.match(/(?<make>[a-z0-9]+)\s+(?<model>[a-z0-9]+)\s*(?<year>\d{4})?/i);
    if(usedMatch && usedMatch.groups){ const { make, model, year } = usedMatch.groups; const q = await buildUsedCarQuote({ make, model, year }); await waSendText(from, q.text); await sendUsedCarButtons(from, !!q.picLink); if(q.picLink) await waSendText(from, `Photos: ${q.picLink}`); return res.sendStatus(200); }
    await waSendText(from, "Tell me your *city + make/model + variant/suffix + profile (individual/company)*. e.g., *Delhi Hycross ZXO individual* or *HR BMW X1 sDrive18i company*.");
    return res.sendStatus(200);
  } catch(e){ console.error("Webhook error:", e && e.stack ? e.stack : e); return res.sendStatus(200); }
});

// ------------- health & start -------------
app.get("/healthz", (req,res)=> res.json({ ok:true, t:Date.now(), debug: process.env.DEBUG_VARIANT === "true" }));
app.listen(PORT, ()=> {
  console.log(`✅ CRM running on ${PORT}`);
  console.log("ENV summary:", { SHEET_TOYOTA_CSV_URL: !!SHEET_TOYOTA_CSV_URL, PHONE_NUMBER_ID: !!PHONE_NUMBER_ID, META_TOKEN: !!META_TOKEN, ADMIN_WA: !!ADMIN_WA, DEBUG_VARIANT: process.env.DEBUG_VARIANT });
});
