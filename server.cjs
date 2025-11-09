// --- safe csv-parse sync import (fallbacks if path differs) ---
let parseSync;
try {
} catch (e1) {
  try {
    parseSync = require("csv-parse/lib/sync").parse;
  } catch (e2) {
    console.error("Failed to import csv-parse sync module", e1, e2);
    throw e2 || e1;
  }
}
// alias so existing code using `parse(...)` keeps working
const parse = (text, opts) => parseSync(text, opts);

/*
  Minimal MR.CAR CRM webhook (CommonJS)
  - healthz
  - webhook POST handler (Meta shape)
  - CSV loader + variant matching (deterministic)
  - admin reload endpoint
  - CRM prompt & lead post helpers
*/
require('dotenv').config();
const express = require('express');
const fetch = global.fetch || require('node-fetch');
const fs = require('fs');

const app = express();
app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT || 10000;
const DEBUG = process.env.DEBUG_VARIANT === 'true' || false;

const CRM_URL = (process.env.CRM_URL || '').trim();
const CRM_API_KEY = (process.env.CRM_API_KEY || '').trim();
const META_TOKEN = (process.env.META_TOKEN || process.env.WA_TOKEN || '').trim();
const PHONE_NUMBER_ID = (process.env.PHONE_NUMBER_ID || '').trim();
const ADMIN_WA = (process.env.ADMIN_WA || '').replace(/\D/g, '') || null;

const SHEET_TOYOTA_CSV_URL = (process.env.SHEET_TOYOTA_CSV_URL || '').trim();
const PRICING_CACHE_MS = 3 * 60 * 1000;
let PRICING_CACHE = { ts: 0, tables: {} };

// ---------------- helpers ----------------
function log(...args){ if (DEBUG) console.log('[DEBUG]', ...args); }
function normForMatch(s=''){ return String(s||'').toLowerCase().replace(/[^a-z0-9\s]/g,' ').replace(/\s+/g,' ').trim(); }
function fmtMoney(n){ const x = Number(String(n).replace(/[,₹\s]/g,'')); if (!isFinite(x)) return '-'; return x.toLocaleString('en-IN'); }

async function waSendRaw(payload){
  if (!META_TOKEN || !PHONE_NUMBER_ID) { log('wa skipped - token/phone missing'); return null; }
  const url = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`;
  try {
    const r = await fetch(url, { method:'POST', headers:{ Authorization:`Bearer ${META_TOKEN}`, 'Content-Type':'application/json' }, body: JSON.stringify(payload) });
    const j = await r.json().catch(()=>({}));
    if (!r.ok) console.error('WA send error', r.status, j);
    return j;
  } catch(e){ console.error('waSendRaw fail', e); return null; }
}
async function waSendText(to, text){ return waSendRaw({ messaging_product:'whatsapp', to, type:'text', text:{ body: String(text) } }); }

// ---------------- CSV & variant map ----------------
function parseCsvText(txt){
  try {
    const records = parse(txt, { columns: true, skip_empty_lines: true });
    return records;
  } catch(e){
    // fallback naive parse: header line -> rows
    const lines = txt.split(/\r?\n/).filter(Boolean);
    const header = (lines.shift()||'').split(',');
    return lines.map(l => {
      const cols = l.split(',');
      const obj = {};
      header.forEach((h,i)=> obj[String(h||'').trim()] = cols[i]||'');
      return obj;
    });
  }
}

function buildVariantMap(rows){
  const map = [];
  rows.forEach((r, idx) => {
    const model = r['MODEL'] || r['Model'] || r['model'] || '';
    const variant = r['VARIANT'] || r['Variant'] || r['variant'] || r['SUFFIX'] || r['Suffix'] || '';
    const vk = r['VARIANT_KEYWORDS'] || r['Variant_Keywords'] || r['variant_keywords'] || '';
    const kws = new Set();
    if (model) kws.add(normForMatch(model));
    if (variant) kws.add(normForMatch(variant));
    if (vk) {
      // allow comma, pipe, semicolon
      vk.toString().split(/[\|,;]+/).map(s=>s.trim()).filter(Boolean).forEach(p=>kws.add(normForMatch(p)));
    }
    // also add ngrams and tokens
    const addTokens = txt => {
      const n = normForMatch(txt);
      if (!n) return;
      kws.add(n);
      const toks = n.split(' ');
      for (let i=0;i<toks.length;i++){
        kws.add(toks[i]);
        if (i+1<toks.length) kws.add(toks[i]+' '+toks[i+1]);
      }
    };
    addTokens(model); addTokens(variant);
    map.push({ idx, model, variant, row: r, keywords: Array.from(kws) });
  });
  return map;
}

function matchVariantFromText(text, variantMap){
  if (!text) return null;
  const q = normForMatch(text);
  // exact keyword contains
  const exact = [];
  variantMap.forEach(v => {
    v.keywords.forEach(kw => { if (kw && q.includes(kw)) exact.push({ v, kw, len: kw.length }); });
  });
  if (exact.length){
    exact.sort((a,b)=> b.len - a.len);
    return exact[0].v;
  }
  // token overlap
  const qT = q.split(' ').filter(Boolean);
  let best = null, bestScore=0, second=0;
  variantMap.forEach(v => {
    const all = v.keywords.join(' ');
    const vt = all.split(' ').filter(Boolean);
    let score=0;
    qT.forEach(t => {
      vt.forEach(vtk => {
        if (vtk === t) score += 6;
        else if (vtk.includes(t) || t.includes(vtk)) score += 4;
      });
    });
    if (score > bestScore){ second = bestScore; bestScore=score; best=v; }
    else if (score > second) second = score;
  });
  if (!best) return null;
  if (bestScore < 8) return null;
  if (second > 0 && bestScore < second * 1.3 + 4) return null;
  return best;
}

// ---------------- pricing loader ----------------
async function fetchCsvUrl(url){
  if (!url) throw new Error('csv url missing');
  const r = await fetch(url, { cache:'no-store' });
  if (!r.ok) throw new Error('csv fetch failed '+r.status);
  const t = await r.text();
  return parseCsvText(t);
}

async function loadPricing(){
  const now = Date.now();
  if (PRICING_CACHE.ts && (now - PRICING_CACHE.ts < PRICING_CACHE_MS)) return PRICING_CACHE.tables;
  const tables = {};
  if (SHEET_TOYOTA_CSV_URL){
    try {
      const rows = await fetchCsvUrl(SHEET_TOYOTA_CSV_URL);
      tables.TOYOTA = { rows, variantMap: buildVariantMap(rows), headerKeys: Object.keys(rows[0]||{}) };
      log('TOYOTA rows', rows.length, 'header sample', tables.TOYOTA.headerKeys.slice(0,10));
    } catch(e){ console.error('loadPricing TOYOTA failed', e && e.message ? e.message : e); }
  }
  PRICING_CACHE = { ts: now, tables };
  return tables;
}

// ---------------- CRM helpers ----------------
async function crmPostLead(lead){
  if (!CRM_URL) return null;
  try {
    const headers = { 'Content-Type':'application/json' };
    if (CRM_API_KEY) headers['x-api-key'] = CRM_API_KEY;
    const r = await fetch(`${CRM_URL.replace(/\/$/,'')}/leads`, { method:'POST', headers, body: JSON.stringify(lead) });
    return await r.json().catch(()=>null);
  } catch(e){ console.warn('crmPostLead failed', e && e.message); return null; }
}
async function crmFetchPrompt(payload){
  if (!CRM_URL) return null;
  try {
    const headers = { 'Content-Type':'application/json' };
    if (CRM_API_KEY) headers['x-api-key'] = CRM_API_KEY;
    const r = await fetch(`${CRM_URL.replace(/\/$/,'')}/prompt`, { method:'POST', headers, body: JSON.stringify(payload) });
    if (!r.ok) { console.warn('CRM /prompt non-ok', r.status); return null; }
    return await r.json().catch(()=>null);
  } catch(e){ console.warn('crmFetchPrompt failed', e && e.message); return null; }
}

// ---------------- main new-car quick quote ----------------
async function tryQuickNewCarQuote(msgText, from){
  if (!msgText) return false;
  const city = (msgText.match(/\b(delhi|dilli|haryana|hr|chandigarh|chd|uttar pradesh|up|himachal|hp)\b/i)||[])[1] || 'delhi';
  const profile = (msgText.match(/\b(individual|company|corporate|firm|personal)\b/i)||[])[1] || 'individual';
  const tables = await loadPricing();
  const tab = tables.TOYOTA;
  if (!tab) return false;
  const vm = tab.variantMap;
  const match = matchVariantFromText(msgText, vm || []);
  if (!match) return false;
  const row = match.row;
  // try to find on-road price
  const rowVals = Object.values(row || {});
  let onroad = 0;
  for (const v of rowVals){ const n = Number(String(v||'').replace(/[,₹\s]/g,'')); if (n && n>10000){ onroad = n; break; } }
  const exShow = onroad; // fallback
  const emi = Math.round(exShow * 0.02); // dummy EMI calc for test
  // record lead
  const lead = { from, original_message: msgText, brand_guess: 'TOYOTA', model: match.model, variant: match.variant, city, profile, onroad, ex_showroom: exShow, timestamp: Date.now() };
  crmPostLead(lead).catch(()=>null);
  // ask CRM for final reply
  const promptPayload = { from, message: msgText, quote: lead, timestamp: Date.now() };
  const crmResp = await crmFetchPrompt(promptPayload);
  const replyText = (crmResp && crmResp.text) ? crmResp.text : `Found ${match.model} ${match.variant} • On-Road ≈ ₹ ${fmtMoney(onroad)} • EMI ~ ₹ ${fmtMoney(emi)} (est)`;
  await waSendText(from, replyText);
  return true;
}

// ---------------- admin reload ----------------
app.post('/admin/reload-csv', express.json(), async (req,res)=>{
  const caller = req.body?.from || '';
  if (ADMIN_WA && !String(caller).includes(ADMIN_WA)) return res.status(403).json({ ok:false, msg:'forbidden' });
  try {
    PRICING_CACHE = { ts:0, tables:{} };
    await loadPricing();
    return res.json({ ok:true, rows: Object.keys(PRICING_CACHE.tables).reduce((s,k)=> s + (PRICING_CACHE.tables[k].rows?.length||0),0) });
  } catch(e){
    return res.status(500).json({ ok:false, error: String(e) });
  }
});

// ---------------- webhook & health ----------------
app.get('/healthz', (req,res) => res.json({ ok:true, t: Date.now(), debug: DEBUG }));

app.post('/webhook', async (req,res) => {
  res.sendStatus(200);
  try {
    const body = req.body || {};
    const msg = body?.messages?.[0] || body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0] || null;
    const contact = body?.contacts?.[0] || body?.entry?.[0]?.changes?.[0]?.value?.contacts?.[0] || {};
    const from = msg?.from || (body?.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id) || 'unknown';
    const name = contact?.profile?.name || 'Unknown';
    const type = msg?.type || 'unknown';
    const text = (type === 'text') ? (msg.text?.body || '') : (msg?.interactive?.list_reply?.title || msg?.interactive?.button_reply?.title || JSON.stringify(msg).slice(0,220));
    console.log('INBOUND', { from, type, sample: String(text).slice(0,200) });
    // admin alert (throttle omitted for brevity)
    // greeting logic omitted for brevity
    // try new car quick path
    if (type === 'text' && text) {
      const ok = await tryQuickNewCarQuote(text, from);
      if (ok) return;
    }
    // fallback
    await waSendText(from, "Please send *city + model + variant + profile (individual/company)* e.g., 'Delhi Hycross ZXO individual'");
  } catch(e){
    console.error('webhook error', e && e.stack ? e.stack : e);
  }
});

// ---------------- start ----------------
app.listen(PORT, ()=> {
  console.log('✅ CRM running on', PORT);
  console.log('ENV summary:', { SHEET_TOYOTA_CSV_URL: !!SHEET_TOYOTA_CSV_URL, PHONE_NUMBER_ID: !!PHONE_NUMBER_ID, META_TOKEN: !!META_TOKEN, ADMIN_WA: !!ADMIN_WA, CRM_URL: !!CRM_URL, DEBUG });
});
