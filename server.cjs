// server.cjs — MR.CAR webhook (merged final)
// Merged by assistant: combines latest stable logic, enriched interactive menus/buttons,
// greeting helpers, quote limits, used-car bullet EMI, admin endpoints.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const app = express();
app.use(express.json());

// fetch polyfill fallback
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

// defaults
const MAX_QUOTE_PER_DAY = Number(process.env.MAX_QUOTE_PER_DAY || 10);
const QUOTE_LIMIT_FILE = path.resolve(__dirname, "quote_limit.json");
const LEADS_FILE = path.resolve(__dirname, "crm_leads.json");
const NEW_CAR_ROI = Number(process.env.NEW_CAR_ROI || 8.10);
const USED_CAR_ROI_VISIBLE = 9.99;
const USED_CAR_ROI_INTERNAL = 10.00;
const DEBUG = (process.env.DEBUG_VARIANT === "true") || true;

// ensure lastGreeting exists globally to avoid TDZ issues
if (typeof global.lastGreeting === "undefined") global.lastGreeting = new Map();
const lastGreeting = global.lastGreeting;

// ---------------- Helpers: file safe read/write ----------------
function safeJsonRead(filename){
  try { if (!fs.existsSync(filename)) return {}; const txt = fs.readFileSync(filename,'utf8')||''; return txt?JSON.parse(txt):{}; } catch(e){ console.warn('safeJsonRead failed', e && e.message); return {}; }
}
function safeJsonWrite(filename,obj){ try{ fs.writeFileSync(filename, JSON.stringify(obj,null,2),'utf8'); return true;}catch(e){ console.error('safeJsonWrite failed', e && e.message); return false; }}

// ---------------- CRM helpers (external file optional) ----------------
let postLeadToCRM = async ()=>{};
let fetchCRMReply = async ()=>{ return null; };
try {
  const crmHelpers = require('./crm_helpers.cjs');
  postLeadToCRM = crmHelpers.postLeadToCRM || postLeadToCRM;
  fetchCRMReply = crmHelpers.fetchCRMReply || fetchCRMReply;
  if (DEBUG) console.log('crm_helpers.cjs loaded');
} catch(e){ if(DEBUG) console.log('crm_helpers.cjs not loaded (ok for dev).'); }

// ---------------- persistence: leads ----------------
function saveLead(lead){
  try{
    let arr = [];
    if (fs.existsSync(LEADS_FILE)){
      const raw = fs.readFileSync(LEADS_FILE,'utf8')||'[]';
      arr = JSON.parse(raw || '[]');
      if(!Array.isArray(arr)) arr = (arr.leads||[]);
    }
    arr.unshift({ ...lead, ts: Date.now() });
    arr = arr.slice(0,2000);
    fs.writeFileSync(LEADS_FILE, JSON.stringify(arr,null,2),'utf8');
    if (DEBUG) console.log('✅ Lead saved:', lead.from, (lead.text||'').slice(0,120));
    return true;
  } catch(e){ console.error('❌ Failed to save lead', e && e.message); return false; }
}
app.get('/leads',(req,res)=>{ try{ if(fs.existsSync(LEADS_FILE)){ const raw=fs.readFileSync(LEADS_FILE,'utf8')||'[]'; return res.json(JSON.parse(raw)); } return res.json([]); }catch(e){ console.warn('GET /leads read error',e); return res.json([]);} });

// ---------------- Quote limits (competitor protection) ----------------
function loadQuoteLimits(){ return safeJsonRead(QUOTE_LIMIT_FILE) || {}; }
function saveQuoteLimits(obj){ return safeJsonWrite(QUOTE_LIMIT_FILE,obj); }
function canSendQuote(from){ try{ const q=loadQuoteLimits(); const today=new Date().toISOString().slice(0,10); const rec=q[from]||{date:today,count:0}; if(rec.date!==today){ rec.date=today; rec.count=0; } return rec.count < MAX_QUOTE_PER_DAY; }catch(e){ return true; }}
function incrementQuoteUsage(from){ try{ const q=loadQuoteLimits(); const today=new Date().toISOString().slice(0,10); const rec=q[from]||{date:today,count:0}; if(rec.date!==today){ rec.date=today; rec.count=0; } rec.count = Number(rec.count||0)+1; q[from]=rec; saveQuoteLimits(q); if(DEBUG) console.log('Quote usage', from, rec); }catch(e){ console.warn('incrementQuoteUsage failed', e && e.message); }}

// ---------------- WA helpers ----------------
async function waSendRaw(payload){
  if(!META_TOKEN || !PHONE_NUMBER_ID){ console.warn('WA skipped - META_TOKEN or PHONE_NUMBER_ID missing'); return null; }
  const url = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`;
  try{
    if (DEBUG) console.log('WA OUTGOING PAYLOAD:', payload);
    const r = await fetch(url, { method:'POST', headers:{ Authorization:`Bearer ${META_TOKEN}`, 'Content-Type':'application/json' }, body: JSON.stringify(payload) });
    const j = await r.json().catch(()=>({}));
    if (DEBUG) console.log('WA send response status', r.status, JSON.stringify(j).slice(0,800));
    if(!r.ok) console.error('WA send error', r.status, j);
    return j;
  }catch(e){ console.error('waSendRaw failed', e && e.stack); return null; }
}
async function waSendText(to, body){ return waSendRaw({ messaging_product:'whatsapp', to, type:'text', text:{ body } }); }

// New improved List Menu (4 main actions + dynamic brands)
async function waSendListMenu(to){
  try{
    const mainRows = [
      { id:'SRV_NEW_CAR', title:'New Car Deals', description:'On-road prices & offers' },
      { id:'SRV_USED_CAR', title:'Pre-Owned Cars', description:'Certified used inventory' },
      { id:'SRV_SELL_CAR', title:'Sell My Car', description:'Best selling quote' },
      { id:'SRV_LOAN', title:'Loan / Finance', description:'Fast approvals & low ROI' }
    ];
    const brandRows = [];
    if (SHEET_TOYOTA_CSV_URL) brandRows.push({ id:'BRAND_TOYOTA', title:'Toyota', description:'Explore Toyota models' });
    if (SHEET_HYUNDAI_CSV_URL) brandRows.push({ id:'BRAND_HYUNDAI', title:'Hyundai', description:'Explore Hyundai models' });
    if (SHEET_MERCEDES_CSV_URL) brandRows.push({ id:'BRAND_MERCEDES', title:'Mercedes', description:'Explore Mercedes models' });
    if (SHEET_BMW_CSV_URL) brandRows.push({ id:'BRAND_BMW', title:'BMW', description:'Explore BMW models' });
    if (brandRows.length===0){ brandRows.push({ id:'BRAND_ALL', title:'All Brands', description:'Request price for any brand' }); brandRows.push({ id:'BRAND_REQUEST', title:'Request a Brand', description:'Tell us which brand you want' }); }
    const sections = [ { title:'Quick Actions', rows: mainRows }, { title:'Brands', rows: brandRows } ];
    const interactive = { type:'list', header:{ type:'text', text:'MR. CAR SERVICES' }, body:{ text:'Please choose one option 👇' }, footer:{ text:'Premium Deals • Trusted Service • Mr. Car' }, action:{ button:'Select Service', sections: sections.map(s=>({ title: s.title, rows: s.rows })) } };
    return waSendRaw({ messaging_product:'whatsapp', to, type:'interactive', interactive });
  }catch(e){ console.error('waSendListMenu failed', e && e.stack); return waSendText(to, 'Choose: New Car / Pre-Owned / Sell / Loan. Or type brand name.'); }
}

// Improved button payloads
async function sendNewCarButtons(to){
  const payload = { messaging_product:'whatsapp', to, type:'interactive', interactive:{ type:'button', body:{ text:'You can continue with these quick actions:' }, action:{ buttons:[ { type:'reply', reply:{ id:'BTN_NEW_QUOTE', title:'Another Quote' } }, { type:'reply', reply:{ id:'BTN_NEW_LOAN', title:'Loan / EMI Calculator' } }, { type:'reply', reply:{ id:'BTN_NEW_EMI', title:'EMI Calculator' } }, { type:'reply', reply:{ id:'BTN_CONTACT_SALES', title:'Contact Sales' } } ] } } };
  return waSendRaw(payload);
}
async function sendUsedCarButtons(to, hasPhotoLink){
  const buttons = [ { type:'reply', reply:{ id:'BTN_USED_LOAN', title:'Loan Options' } }, { type:'reply', reply:{ id:'BTN_USED_MORE', title:'More Options' } }, { type:'reply', reply:{ id:'BTN_USED_PHOTOS', title:'Send Photos' } }, { type:'reply', reply:{ id:'BTN_USED_TESTDRIVE', title:'Book Test Drive' } }, { type:'reply', reply:{ id:'BTN_BULLET_CALC', title:'Bullet EMI Calculation' } } ];
  if (hasPhotoLink) buttons.unshift({ type:'reply', reply:{ id:'BTN_USED_VIEWPHOTOS', title:'View Photos 📸' } });
  return waSendRaw({ messaging_product:'whatsapp', to, type:'interactive', interactive:{ type:'button', body:{ text:'Quick actions:' }, action:{ buttons } } });
}

// ---------------- admin alerts & throttling ----------------
const lastAlert = new Map();
async function sendAdminAlert({ from, name, text }){
  if(!META_TOKEN || !PHONE_NUMBER_ID || !ADMIN_WA) return;
  const now = Date.now(); const prev = lastAlert.get(from) || 0;
  const ALERT_WINDOW_MS = (Number(process.env.ALERT_WINDOW_MINUTES || 10))*60*1000;
  if(now - prev < ALERT_WINDOW_MS){ if(DEBUG) console.log('throttled admin alert for', from); return; }
  lastAlert.set(from, now);
  await waSendRaw({ messaging_product:'whatsapp', to: ADMIN_WA, type:'text', text:{ body:`🔔 NEW WA LEAD\nFrom: ${from}\nName: ${name||'-'}\nMsg: ${String(text||'').slice(0,1000)}` } });
  if(DEBUG) console.log('admin alert sent');
}

// ---------------- CSV utils & pricing loader ----------------
function parseCsv(text){ const rows=[]; let cur='', row=[], inQ=false; for(let i=0;i<text.length;i++){ const ch=text[i]; if(inQ){ if(ch==='"'){ if(text[i+1]==='"'){ cur+='"'; i++; } else inQ=false; } else cur+=ch; } else { if(ch==='"') inQ=true; else if(ch===','){ row.push(cur); cur=''; } else if(ch==='\n'){ row.push(cur); rows.push(row); row=[]; cur=''; } else if(ch!=='\r') cur+=ch; } } if(cur.length||row.length){ row.push(cur); rows.push(row); } return rows; }
async function fetchCsv(url){ if(!url) throw new Error('CSV URL missing'); const r = await fetch(url, { cache:'no-store' }); if(!r.ok) throw new Error('CSV fetch failed '+r.status); const txt = await r.text(); return parseCsv(txt); }
function toHeaderIndexMap(headerRow){ const map={}; headerRow.forEach((h,i)=>{ map[String(h||'').trim().toUpperCase()] = i; }); return map; }

// Pricing cache & loader (basic)
const SHEET_URLS = { HOT: SHEET_HOT_DEALS_CSV_URL||'', TOYOTA: SHEET_TOYOTA_CSV_URL||'', HYUNDAI: SHEET_HYUNDAI_CSV_URL||'', MERCEDES: SHEET_MERCEDES_CSV_URL||'', BMW: SHEET_BMW_CSV_URL||'' };
const PRICING_CACHE = { tables: null, ts: 0 };
const PRICING_CACHE_MS = 3*60*1000;
async function loadPricingFromSheets(){ const now=Date.now(); if(PRICING_CACHE.tables && now - PRICING_CACHE.ts < PRICING_CACHE_MS) return PRICING_CACHE.tables; const tables={}; for(const [brand,url] of Object.entries(SHEET_URLS)){ if(!url) continue; try{ const rows = await fetchCsv(url); if(!rows||!rows.length) continue; const header = rows[0].map(h=>String(h||'').trim()); const idxMap = toHeaderIndexMap(header); const data = rows.slice(1); tables[brand] = { header, idxMap, data }; }catch(e){ console.warn('CSV load failed for', brand, e && e.message); } } PRICING_CACHE.tables = tables; PRICING_CACHE.ts = Date.now(); return tables; }

// ---------------- Normalization helpers ----------------
function normForMatch(s){ return (s||'').toString().toLowerCase().replace(/(automatic|automatic transmission|\bauto\b)/g,' at ').replace(/[^a-z0-9\s]/g,' ').replace(/\s+/g,' ').trim(); }
function fmtMoney(n){ const x=Number(n||0); if(!isFinite(x)) return '-'; return x.toLocaleString('en-IN',{maximumFractionDigits:0}); }
function calcEmiSimple(p, annualRatePct, months){ const P=Number(p); const r=Number(annualRatePct)/12/100; if(!P || !isFinite(r) || months<=0) return 0; const pow = Math.pow(1+r, months); const emi = Math.round(P * r * pow / (pow - 1)); return emi; }

// ---------------- Bullet EMI simulation ----------------
function simulateBulletPlan({ loanAmount, months, internalRatePct, bulletPct=0.25 }){
  const L = Number(loanAmount||0); const N = Number(months||0); const r = Number(internalRatePct||USED_CAR_ROI_INTERNAL)/12/100; if(!L||!N||!isFinite(r)) return null; const bullet_total=Math.round(L*Number(bulletPct||0.25)); const num_bullets=Math.max(1,Math.floor(N/12)); const bullet_each=Math.round(bullet_total/num_bullets); const principal_for_emi = L - bullet_total; const monthly_emi = calcEmiSimple(principal_for_emi, internalRatePct, N); let principal = principal_for_emi; let total_interest=0; let total_emi_paid=0; let total_bullets_paid=0; const schedule=[]; for(let m=1;m<=N;m++){ const interest = Math.round(principal * r); let principal_paid_by_emi = monthly_emi - interest; if(principal_paid_by_emi<0) principal_paid_by_emi=0; principal = Math.max(0, principal - principal_paid_by_emi); total_interest += interest; total_emi_paid += monthly_emi; let bullet_paid = 0; if(m%12===0){ bullet_paid = Math.min(bullet_each, Math.max(0, (L - (principal + total_bullets_paid)))); if(m === (num_bullets*12)){ const already = total_bullets_paid; bullet_paid = Math.max(0, bullet_total - already); } total_bullets_paid += bullet_paid; principal = Math.max(0, principal - bullet_paid); } schedule.push({ month:m, interest, emi: monthly_emi, principal_remaining: principal, bullet_paid }); }
  const total_payable = total_emi_paid + total_bullets_paid; return { loan:L, months:N, internalRatePct: internalRatePct, monthly_emi, bullet_total, num_bullets, bullet_each, total_interest, total_emi_paid, total_bullets_paid, total_payable, schedule };
}

// ---------------- Build used car quote ----------------
async function loadUsedSheet(){
  if (SHEET_USED_CSV_URL){ try{ const rows = await fetchCsv(SHEET_USED_CSV_URL); if(rows && rows.length) return rows; }catch(e){ if(DEBUG) console.warn('remote used csv fetch failed', e && e.message); } }
  try{ if(fs.existsSync(LOCAL_USED_CSV_PATH)){ const txt=fs.readFileSync(LOCAL_USED_CSV_PATH,'utf8'); const rows = parseCsv(txt); if(rows && rows.length) return rows; } }catch(e){ if(DEBUG) console.warn('local used csv read failed', e && e.message); }
  return [];
}
async function buildUsedCarQuote({ make, model, year }){
  try{
    const rows = await loadUsedSheet(); if(!rows||!rows.length) return { text: 'Used car pricing not configured.' };
    const header = rows[0].map(h=>String(h||'').toUpperCase()); const data = rows.slice(1);
    const makeIdx = header.findIndex(h=>h.includes('MAKE')); const modelIdx = header.findIndex(h=>h.includes('MODEL'));
    let findRow = data.find(r=> String(r[makeIdx]||'').toLowerCase().includes((make||'').toLowerCase()) && String(r[modelIdx]||'').toLowerCase().includes((model||'').toLowerCase()));
    if(!findRow){ // try fuzzy
      for(const r of data){ if(String(r[makeIdx]||'').toLowerCase().includes((make||'').toLowerCase()) || String(r[modelIdx]||'').toLowerCase().includes((model||'').toLowerCase())){ findRow=r; break; } }
    }
    if(!findRow) return { text: `Sorry, I couldn’t find the used car *${make} ${model}* right now.` };
    const expectedIdx = header.findIndex(h=>h.includes('EXPECTED')||h.includes('EXPECTED_PRICE')||h.includes('EXPECTED PRICE'));
    const expected = expectedIdx>=0 ? String(findRow[expectedIdx]||'') : '';
    const price = Number(String(expected||'').replace(/[,₹\s]/g,'')) || 0;
    let finalPrice = price;
    if(!finalPrice){ // try numeric cell
      for(let i=0;i<findRow.length;i++){ const v=String(findRow[i]||'').replace(/[,₹\s]/g,''); if(/^[0-9]+$/.test(v)){ finalPrice = Number(v); break; } }
    }
    if(!finalPrice) return { text: 'Price for this car not available.' };
    const tenureDefault = 60; const normalEMI_display = calcEmiSimple(finalPrice, USED_CAR_ROI_INTERNAL, tenureDefault);
    const bulletSim = simulateBulletPlan({ loanAmount: finalPrice, months: tenureDefault, internalRatePct: USED_CAR_ROI_INTERNAL, bulletPct:0.25 });
    const lines = [];
    lines.push('*PRE-OWNED CAR QUOTE*');
    lines.push(`Make/Model: *${String(findRow[makeIdx]||'').toUpperCase()} ${String(findRow[modelIdx]||'').toUpperCase()}*`);
    lines.push(finalPrice ? `Expected Price: ₹ *${fmtMoney(finalPrice)}*` : null);
    lines.push(`ROI (Used Car): *${USED_CAR_ROI_VISIBLE}%* (visible)`);
    lines.push(`Tenure (example): *${tenureDefault} months*`);
    lines.push('');
    lines.push('📌 *Normal EMI*');
    lines.push(`• EMI (${tenureDefault} months): ₹ *${fmtMoney(normalEMI_display)}*`);
    lines.push('');
    if(bulletSim){ lines.push('📌 *Bullet EMI Plan (25% across tenure)*'); lines.push(`• Monthly EMI: ₹ *${fmtMoney(bulletSim.monthly_emi)}*`); lines.push(`• Bullet total (25%): ₹ *${fmtMoney(bulletSim.bullet_total)}*`); lines.push(`  → ₹ *${fmtMoney(bulletSim.bullet_each)}* on months: ${Array.from({length:bulletSim.num_bullets},(_,i)=>12*(i+1)).join(' • ')}`); lines.push(''); lines.push(`📊 *Total payable (EMIs + bullets):* ₹ *${fmtMoney(bulletSim.total_payable)}*`); lines.push(`💰 *Interest (approx):* ₹ *${fmtMoney(bulletSim.total_interest)}*`); lines.push(''); lines.push('✅ *Loan approval possible in ~30 minutes (T&Cs apply)*'); }
    lines.push(''); lines.push('\n*Terms & Conditions Apply ✅*');
    return { text: lines.filter(Boolean).join('\n'), picLink: null };
  }catch(e){ console.error('buildUsedCarQuote error', e && e.stack); return { text:'Used car pricing failed.' }; }
}

// ---------------- Quick new car quote (simplified) ----------------
async function tryQuickNewCarQuote(msgText, to){
  try{
    if(!msgText||!msgText.trim()) return false;
    if(!canSendQuote(to)){ await waSendText(to, "You’ve reached today’s assistance limit for quotes. Please try again tomorrow or provide your details for a personalised quote."); return true; }
    const tables = await loadPricingFromSheets(); if(!tables || Object.keys(tables).length===0) return false;
    const t = String(msgText||'').toLowerCase(); let city = (t.match(/\b(delhi|dilli|haryana|hr|chandigarh|chd|uttar pradesh|up|himachal|hp)\b/)||[])[1] || 'delhi'; if(city==='dilli') city='delhi'; if(city==='hr') city='haryana';
    const profile = (t.match(/\b(individual|company|corporate|firm|personal)\b/)||[])[1] || 'individual';
    // take first two tokens as guess
    const raw = t.replace(/[^\w\s]/g,' ').replace(/\s+/g,' ').trim(); const modelGuess = raw.split(' ').slice(0,2).join(' ');
    for(const [brand,tab] of Object.entries(tables)){
      if(!tab||!tab.data) continue; const header = tab.header.map(h=>String(h||'').toUpperCase()); const idxModel = header.findIndex(h=>h.includes('MODEL')||h.includes('VEHICLE')); const idxVariant = header.findIndex(h=>h.includes('VARIANT')||h.includes('SUFFIX'));
      for(const row of tab.data){ const modelCell = idxModel>=0?String(row[idxModel]||'').toLowerCase():''; const variantCell = idxVariant>=0?String(row[idxVariant]||'').toLowerCase():''; if((modelCell && modelCell.includes(modelGuess)) || (variantCell && variantCell.includes(modelGuess))){ // found
          // find price
          const idxMap = tab.idxMap || toHeaderIndexMap(tab.header);
          let priceIdx=-1; for(const k of Object.keys(idxMap)){ if(k.includes('ON ROAD') && k.includes(city.toUpperCase().split(' ')[0])){ priceIdx=idxMap[k]; break; } }
          if(priceIdx<0){ for(let i=0;i<row.length;i++){ const v=String(row[i]||'').replace(/[,₹\s]/g,''); if(/^[0-9]+$/.test(v)){ priceIdx=i; break; } } }
          const onroad = priceIdx>=0? Number(String(row[priceIdx]||'').replace(/[,₹\s]/g,'')) : 0; if(!onroad) continue; const exIdx = detectExShowIdx(idxMap); const exShow = exIdx>=0? Number(String(row[exIdx]||'').replace(/[,₹\s]/g,''))||0:0; const loanAmt = exShow || onroad || 0; const emi60 = loanAmt ? calcEmiSimple(loanAmt, NEW_CAR_ROI, 60) : 0;
          const lines = [ `*${brand}* ${String(row[idxModel]||'').toUpperCase()} ${String(row[idxVariant]||'').toUpperCase()}`, `*City:* ${city.toUpperCase()} • *Profile:* ${profile.toUpperCase()}`, exShow?`*Ex-Showroom:* ₹ ${fmtMoney(exShow)}`:null, onroad?`*On-Road:* ₹ ${fmtMoney(onroad)}`:null, loanAmt?`*Loan:* 100% of Ex-Showroom → ₹ ${fmtMoney(loanAmt)} @ *${NEW_CAR_ROI}%* (60m) → *EMI ≈ ₹ ${fmtMoney(emi60)}*`:null, '\n*Terms & Conditions Apply ✅*' ].filter(Boolean).join('\n');
          await waSendText(to, lines); await sendNewCarButtons(to); incrementQuoteUsage(to); return true;
      } }
    }
    return false;
  }catch(e){ console.error('tryQuickNewCarQuote error', e && e.stack); return false; }
}

function detectExShowIdx(idxMap){ try{ const keys=Object.keys(idxMap); for(const k of keys){ if(/EX[\s\-_\/A-Z0-9]*SHOWROOM/.test(String(k))) return idxMap[k]; } const lower = keys.map(k=>String(k).toLowerCase()); const i = lower.findIndex(k=>k.includes('ex') && k.includes('showroom')); if(i>=0) return idxMap[Object.keys(idxMap)[i]]; }catch(e){} return -1; }

// ---------------- greeting helper (safe) ----------------
if (typeof shouldGreetNow === 'undefined'){
  function shouldGreetNow(from, msgText){
    try{
      if (ADMIN_WA && from === ADMIN_WA) return false;
      const GREETING_WINDOW_MINUTES = Number(process.env.GREETING_WINDOW_MINUTES || 600);
      const GREETING_WINDOW_MS = GREETING_WINDOW_MINUTES * 60 * 1000;
      const now = Date.now(); const prev = (lastGreeting && lastGreeting.get(from)) || 0;
      const text = (msgText||'').toString().trim().toLowerCase();
      const looksLikeGreeting = /^(hi|hello|hey|namaste|enquiry|inquiry|help|start)\b/.test(text) || prev === 0;
      if(!looksLikeGreeting) return false;
      if(now - prev < GREETING_WINDOW_MS) return false;
      try{ if(lastGreeting && typeof lastGreeting.set === 'function') lastGreeting.set(from, now); }catch(e){}
      return true;
    }catch(e){ console.warn('shouldGreetNow failed', e); return false; }
  }
}

// ---------------- Webhook & routing ----------------
app.get('/healthz', (req,res)=> res.json({ ok:true, t:Date.now(), debug: DEBUG }));

app.get('/webhook', (req,res)=>{ const mode=req.query['hub.mode']; const token=req.query['hub.verify_token']; const challenge=req.query['hub.challenge']; if(mode==='subscribe' && token===VERIFY_TOKEN && challenge){ console.log('Webhook verified ✅'); return res.status(200).type('text/plain').send(String(challenge)); } return res.sendStatus(403); });

// admin utility endpoints
app.post('/admin/reset_greetings', (req,res)=>{ try{ if(typeof lastGreeting !== 'undefined' && lastGreeting && typeof lastGreeting.clear === 'function'){ lastGreeting.clear(); console.log('/admin/reset_greetings -> cleared lastGreeting'); } else console.log('/admin/reset_greetings -> lastGreeting not present'); return res.json({ ok:true, msg:'greetings cleared' }); }catch(e){ console.error('reset_greetings failed', e && e.stack); return res.status(500).json({ ok:false, err: String(e && e.message ? e.message : e) }); } });

app.post('/admin/set_greeting_window', (req,res)=>{ try{ const mins = Number(req.query.minutes || (req.body && req.body.minutes)); if(!isFinite(mins) || mins < 0) return res.status(400).json({ ok:false, err:'invalid minutes' }); process.env.GREETING_WINDOW_MINUTES = String(mins); console.log('/admin/set_greeting_window ->', mins, 'minutes'); return res.json({ ok:true, minutes: mins }); }catch(e){ return res.status(500).json({ ok:false, err: String(e && e.message ? e.message : e) }); } });

// MAIN handler
app.post('/webhook', async (req,res)=>{
  console.log('📩 Incoming webhook hit:', typeof req.body === 'object' ? JSON.stringify(req.body).slice(0,800) : String(req.body).slice(0,800));
  try{
    const entry = req.body?.entry?.[0]; const change = entry?.changes?.[0]; const value = change?.value || {};
    const msg = value?.messages?.[0]; const contact = value?.contacts?.[0];
    if(!msg) return res.sendStatus(200);
    const from = msg.from; const type = msg.type; const name = contact?.profile?.name || 'Unknown';
    let msgText = '';
    let selectedId = null;
    if(type === 'text') msgText = msg.text?.body || '';
    else if(type === 'interactive'){ selectedId = msg.interactive?.button_reply?.id || msg.interactive?.list_reply?.id || null; msgText = msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || ''; }
    else msgText = JSON.stringify(msg);
    if(DEBUG) console.log('INBOUND', { from, type, sample: (msgText||'').slice(0,300) });

    if(from !== ADMIN_WA) await sendAdminAlert({ from, name, text: msgText });

    // log lead locally & to CRM
    try{ const lead={ from, name, text: msgText }; postLeadToCRM({ from, name, text: msgText }).catch(()=>{}); saveLead(lead); }catch(e){ console.warn('lead log failed', e && e.message); }

    // handle interactive selections
    if(selectedId){
      switch(selectedId){
        case 'SRV_NEW_CAR': case 'BTN_NEW_QUOTE':
          await waSendText(from, 'Please share your *city, model, variant/suffix & profile (individual/company)*.'); break;
        case 'SRV_USED_CAR': case 'BTN_USED_MORE':
          await waSendText(from, 'Share *make, model, year* (optional colour/budget) and I’ll suggest options.'); break;
        case 'SRV_SELL_CAR':
          await waSendText(from, 'Please share *car make/model, year, km, city* and a few photos. We’ll get you the best quote.'); break;
        case 'SRV_LOAN': case 'BTN_NEW_LOAN': case 'BTN_USED_LOAN':
          await waSendText(from, `For loan assistance, share *city + car model + budget*. New car ROI from *${NEW_CAR_ROI}%*, Used car *${USED_CAR_ROI_VISIBLE}%*.`); break;
        case 'BTN_USED_PHOTOS': case 'BTN_USED_VIEWPHOTOS':
          await waSendText(from, 'Please tap the Google Drive link in the quote to view photos. If missing, reply “photos please”.'); break;
        case 'BTN_BULLET_CALC':
          await waSendText(from, 'To calculate bullet EMI (used car), reply: `bullet <loan amount> <tenure months>` e.g., `bullet 750000 60`'); break;
        case 'BRAND_TOYOTA':
          await waSendText(from, 'Share model & variant for Toyota (e.g., Delhi Hycross ZXO individual)'); break;
        default:
          await waSendText(from, 'Thanks! You can type your request anytime.');
      }
      return res.sendStatus(200);
    }

    // Greeting logic
    if (shouldGreetNow(from, msgText)){
      await waSendText(from, `🔴 *MR. CAR* welcomes you!\nNamaste 🙏\n\nWe assist with *pre-owned cars*, *new car deals*, *loans* and *insurance*.\nTell us how we can help — or pick an option below.`);
      await waSendListMenu(from);
      return res.sendStatus(200);
    }

    // quick new car quote
    if(msgText && type === 'text'){
      const servedNew = await tryQuickNewCarQuote(msgText, from);
      if(servedNew) return res.sendStatus(200);
    }

    // used car detection
    const usedMatch = (msgText || '').match(/used\s+(?<make>[a-z0-9]+)\s+(?<model>[a-z0-9]+)\s*(?<year>\d{4})?/i) || (msgText || '').match(/(?<make>[a-z0-9]+)\s+(?<model>[a-z0-9]+)\s*(?<year>\d{4})?/i);
    if(usedMatch && usedMatch.groups){ const { make, model, year } = usedMatch.groups; const q = await buildUsedCarQuote({ make, model, year }); if(q && q.text){ await waSendText(from, q.text); await sendUsedCarButtons(from, !!q.picLink); return res.sendStatus(200); } }

    // bullet calculator
    const bulletCmd = (msgText||'').trim().match(/^bullet\s+([\d,]+)\s*(\d+)?/i);
    if(bulletCmd){ const loanRaw = String(bulletCmd[1]||'').replace(/[,₹\s]/g,''); const months = Number(bulletCmd[2]||60); const loanAmt = Number(loanRaw); if(!loanAmt||!months){ await waSendText(from, 'Please send: `bullet <loan amount> <tenure months>` e.g. `bullet 750000 60`'); return res.sendStatus(200); } const sim = simulateBulletPlan({ loanAmount: loanAmt, months, internalRatePct: USED_CAR_ROI_INTERNAL, bulletPct:0.25 }); if(!sim){ await waSendText(from, 'Bullet calculation failed.'); return res.sendStatus(200); } const lines=[]; lines.push(`🔷 *Bullet EMI Plan — Used Car*`); lines.push(`Loan Amount: ₹ *${fmtMoney(sim.loan)}*`); lines.push(`ROI (shown): *${USED_CAR_ROI_VISIBLE}%*`); lines.push(`Tenure: *${sim.months} months*`); lines.push(''); lines.push(`📌 Monthly EMI (amortising principal excluding bullets): ₹ *${fmtMoney(sim.monthly_emi)}*`); lines.push(`📌 Bullet total (25%): ₹ *${fmtMoney(sim.bullet_total)}*`); lines.push(`• Bullet each: ₹ *${fmtMoney(sim.bullet_each)}* on months: ${Array.from({length: sim.num_bullets}, (_,i) => (12*(i+1))).join(' • ')}`); lines.push(''); lines.push(`📊 Total payable (EMIs + bullets): ₹ *${fmtMoney(sim.total_payable)}*`); lines.push(`💰 Total interest (approx): ₹ *${fmtMoney(sim.total_interest)}*`); lines.push(''); lines.push('✅ *Loan approval possible in ~30 minutes (T&Cs apply)*'); lines.push('\n*Terms & Conditions Apply ✅*'); await waSendText(from, lines.join('\n')); try{ postLeadToCRM({ from, name, text: `BULLET_CALC ${loanAmt} ${months}` }); }catch(e){} return res.sendStatus(200); }

    // emi calculator
    const emiCmd = (msgText||'').trim().match(/^emi\s+([\d,]+)(?:\s+([\d\.]+)%?)?\s*(\d+)?/i);
    if(emiCmd){ const loanRaw = String(emiCmd[1]||'').replace(/[,₹\s]/g,''); let rate = Number(emiCmd[2] || NEW_CAR_ROI); const months = Number(emiCmd[3] || 60); const loanAmt = Number(loanRaw); if(!loanAmt||!months){ await waSendText(from, 'Please send: `emi <loan amount> <rate% optional> <tenure months>` e.g. `emi 1500000 9.5 60`'); return res.sendStatus(200); } const monthly = calcEmiSimple(loanAmt, rate, months); const total = monthly * months; const interest = total - loanAmt; const lines = [ `🔸 EMI Calculation`, `Loan: ₹ *${fmtMoney(loanAmt)}*`, `Rate: *${rate}%* p.a.`, `Tenure: *${months} months*`, ``, `📌 Monthly EMI: ₹ *${fmtMoney(monthly)}*`, `📊 Total Payable: ₹ *${fmtMoney(total)}*`, `💰 Total Interest: ₹ *${fmtMoney(interest)}*`, ``, `✅ *Loan approval possible in ~30 minutes (T&Cs apply)*`, `\n*Terms & Conditions Apply ✅*` ].join('\n'); await waSendText(from, lines); return res.sendStatus(200); }

    // CRM fallback
    try{ const crmReply = await fetchCRMReply({ from, msgText }); if(crmReply){ await waSendText(from, crmReply); return res.sendStatus(200); } }catch(e){ console.warn('CRM reply failed', e && e.message); }

    await waSendText(from, "Tell me your *city + make/model + variant/suffix + profile (individual/company)*. e.g., *Delhi Hycross ZXO individual* or *HR BMW X1 sDrive18i company*." );
    return res.sendStatus(200);
  }catch(err){ console.error('Webhook error:', err && err.stack ? err.stack : err); try{ if(ADMIN_WA) await waSendText(ADMIN_WA, `Webhook crash: ${String(err && err.message ? err.message : err)}`); }catch(e){} return res.sendStatus(200); }
});

// ---------------- start server ----------------
app.listen(PORT, ()=>{
  console.log(`✅ MR.CAR webhook CRM server running on port ${PORT}`);
  console.log('ENV summary:', {
    SHEET_TOYOTA_CSV_URL: !!SHEET_TOYOTA_CSV_URL,
    SHEET_USED_CSV_URL: !!SHEET_USED_CSV_URL || fs.existsSync(LOCAL_USED_CSV_PATH),
    PHONE_NUMBER_ID: !!PHONE_NUMBER_ID, META_TOKEN: !!META_TOKEN, ADMIN_WA: !!ADMIN_WA, DEBUG
  });
});

module.exports = { app };
