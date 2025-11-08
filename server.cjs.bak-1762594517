// ===== Mr. Car x Signature Savings Webhook (FINAL – OpenAI only) =====
require('dotenv').config({ path: './.env' });
const fetch = global.fetch || ((...args) => import('node-fetch').then(({ default: f }) => f(...args)));

const express = require('express');
const fs = require('fs');
const crypto = require('crypto');
const bodyParser = require('body-parser');

const app = express();

// Capture raw body for signature verification
function rawBodySaver(req, res, buf, encoding) {
  if (buf && buf.length) req.rawBody = buf.toString(encoding || 'utf8');
}
app.use(bodyParser.json({ verify: rawBodySaver }));

// Env vars
const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || process.env.VERIFY_TOKEN || '';
const APP_SECRET   = process.env.META_APP_SECRET   || process.env.APP_SECRET   || '';
const PHONE_ID     = process.env.WHATSAPP_PHONE_ID || process.env.PHONE_NUMBER_ID || process.env.PHONE_ID || '';
const META_TOKEN   = process.env.META_TOKEN        || process.env.WA_TOKEN     || '';
const CRM_URL      = process.env.CRM_URL || 'http://localhost:3000';
const PORT         = process.env.PORT || 3000;
const DB_FILE      = process.env.DB_FILE || './crm_db.json';
const SKIP_SIGNATURE = process.env.SKIP_SIGNATURE === "1";

// Verify Meta signature
function verifySignature(req) {
  if (!APP_SECRET) return true;
  const sig = req.headers['x-hub-signature-256'];
  if (!sig || !req.rawBody) return false;
  const hmac = crypto.createHmac('sha256', APP_SECRET);
  hmac.update(req.rawBody);
  const digest = 'sha256=' + hmac.digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(sig)); }
  catch { return false; }
}

// Webhook verify
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ Webhook verified');
    return res.status(200).send(challenge);
  }
  res.status(403).send('Verification failed');
});

app.get('/', (_,res)=>res.send("OK"));
app.get('/health', (_,res)=>res.json({ ok:true, time:new Date().toISOString() }));

// Greeting logic
function getGreeting(from, text) {
  const greetings = ['hi','hello','hey','namaste','good morning','good evening','good afternoon'];
  const isGreeting = greetings.some(g=>text.toLowerCase().includes(g));
  let db = fs.existsSync(DB_FILE) ? JSON.parse(fs.readFileSync(DB_FILE,'utf8')) : {};
  db.sessions = db.sessions || {};
  const session = db.sessions[from];
  const now = Date.now();
  if (!session || now-session.lastActive>10*60*1000 || isGreeting) {
    db.sessions[from] = { lastActive: now };
    fs.writeFileSync(DB_FILE, JSON.stringify(db,null,2));
    return "Namaste (🙏) Mr. Car welcomes you. We can assist you with pre-owned cars, the finest new car deals, automotive loans, and insurance services. For your enquiry, our team is ready to assist you instantly and ensure a seamless experience.";
  }
  db.sessions[from].lastActive = now;
  fs.writeFileSync(DB_FILE, JSON.stringify(db,null,2));
  return null;
}

// WhatsApp inbound
app.post('/webhook', async (req,res)=>{
  try {
    if (!verifySignature(req)) return res.sendStatus(403);
    const entry = req.body?.entry?.[0];
    const msg = entry?.changes?.[0]?.value?.messages?.[0];
    if (!msg) return res.sendStatus(200);

    const from  = msg.from;
    const text  = msg?.text?.body || '';

    // Send greeting first, but DO NOT return — continue to AI
    const greet = getGreeting(from, text);
    if (greet) await sendText(from, greet);

    // forward to local /prompt brain
    let reply = "AI temporarily unavailable.";
    try {
      const r = await fetch(`${CRM_URL}/brain`,{
        method:"POST",
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({from,message:text})
      });
      if (r.ok) { const j = await r.json(); reply = j.reply || reply; }
      else console.error('CRM /prompt not ok:', r.status);
    } catch(e){ console.error('CRM error:', e.message); }

    await sendText(from, reply);
    res.sendStatus(200);
  } catch (e) {
    console.error('Webhook error:', e);
    res.sendStatus(500);
  }
});

// Send WA message
async function sendText(to,msg){
  if(!PHONE_ID||!META_TOKEN){console.warn("⚠️ Missing PHONE_ID or META_TOKEN");return}
  const url=`https://graph.facebook.com/v17.0/${PHONE_ID}/messages`;
  const body={ messaging_product:"whatsapp", to:String(to).replace(/\D/g,''), type:"text", text:{body:msg}};
  try{
    const resp = await fetch(url,{
      method:"POST",
      headers:{Authorization:`Bearer ${META_TOKEN}`,"Content-Type":"application/json"},
      body:JSON.stringify(body)
    });
    const txt = await resp.text();
    if(!resp.ok) console.error('Meta send error:', resp.status, txt);
    else console.log('✅ Meta send success:', txt);
  }catch(e){ console.error("WA Send Err:",e.message); }
}

// /prompt (OpenAI brain only)
app.post('/prompt', async (req,res)=>{
  try{
    const {message}=req.body||{};
    const OA_KEY=process.env.OPENAI_API_KEY;
    if(!OA_KEY) return res.json({reply:"AI temporarily unavailable."});

    const MODEL=process.env.OPENAI_MODEL||"gpt-4o-mini";
    const sys="You are Signature Savings auto consultant. Be crisp, professional, and luxury tone. If user asks for prices, ask city and variant if missing.";

    const r=await fetch("https://api.openai.com/v1/chat/completions",{
      method:"POST",
      headers:{Authorization:`Bearer ${OA_KEY}`,"Content-Type":"application/json"},
      body:JSON.stringify({
        model:MODEL,
        messages:[{role:"system",content:sys},{role:"user",content:message||""}],
        max_tokens:250
      })
    });

    const j=await r.json();
    console.log("DEBUG OpenAI status:", r.status, "body:", JSON.stringify(j).slice(0,300));
    if(!r.ok) return res.json({reply:"AI temporarily unavailable."});

    const text=j?.choices?.[0]?.message?.content?.trim();
    return res.json({reply:text || "…"});

  }catch(err){
    console.error("/prompt fatal:",err);
    return res.json({reply:"AI temporarily unavailable."});
  }
});

app.listen(PORT,()=>console.log(`🚀 Running on ${PORT}`));

// --- DEV-ONLY: webhook-test (no signature) ---
app.post('/webhook-test', async (req, res) => {
  try {
    const entry = req.body?.entry?.[0];
    const msg = entry?.changes?.[0]?.value?.messages?.[0];
    if (!msg) return res.sendStatus(200);

    const from  = msg.from;
    const text  = msg?.text?.body || '';

    // Send greeting first (no early return)
    const greet = getGreeting(from, text);
    if (greet) await sendText(from, greet);

    // forward to local /prompt brain
    let reply = "AI temporarily unavailable.";
    try {
      const r = await fetch(`${CRM_URL}/brain`,{
        method:"POST",
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({from,message:text})
      });
      if (r.ok) { const j = await r.json(); reply = j.reply || reply; }
      else console.error('CRM /prompt not ok (test):', r.status);
    } catch(e){ console.error('CRM error (test):', e.message); }

    await sendText(from, reply);
    res.sendStatus(200);
  } catch (e) {
    console.error('Webhook-test error:', e);
    res.sendStatus(500);
  }
});

// ===== live pricing loader (Google Sheet CSV or local JSON) =====
const PRICING_CACHE = { data: null, ts: 0 };
const PRICING_TTL_MS = 5 * 60 * 1000; // 5 min cache

async function loadPricing() {
  const SHEET_URL = process.env.PRICING_SHEET_URL || '';
  const now = Date.now();
  if (PRICING_CACHE.data && now - PRICING_CACHE.ts < PRICING_TTL_MS) return PRICING_CACHE.data;

  let data = null;
  try {
    if (SHEET_URL) {
      const r = await fetch(SHEET_URL);
      const text = await r.text();
      const [head, ...rows] = text.trim().split(/\r?\n/).map(l=>l.split(','));
      const keys = head.map(k=>k.trim().toLowerCase().replace(/\s+/g,'_'));
      data = rows.map(r => Object.fromEntries(r.map((v,i)=>[keys[i], (v||'').trim()])));
    }
  } catch (e) { console.error('pricing sheet fetch failed:', e.message); }

  if (!data) {
    try {
      const db = fs.existsSync(DB_FILE) ? JSON.parse(fs.readFileSync(DB_FILE,'utf8')) : {};
      data = db.pricing_data || [];
    } catch { data = []; }
  }
  PRICING_CACHE.data = data; PRICING_CACHE.ts = now;
  return data;
}

app.get('/pricing', async (req,res)=>{
  const data = await loadPricing();
  res.json({ count: data.length, sample: data.slice(0,3) });
});

// ===== SECURE SYNC FROM GPT (Actions) =====
const SYNC_KEY = process.env.SYNC_KEY || ""; // set in env (Render)

app.post('/sync-knowledge', (req, res) => {
  try {
    if (!SYNC_KEY || req.headers['x-sync-key'] !== SYNC_KEY) {
      return res.status(401).json({ ok:false, error:'unauthorized' });
    }
    const payload = req.body || {};
    const db = fs.existsSync(DB_FILE) ? JSON.parse(fs.readFileSync(DB_FILE,'utf8')) : {};
    if (payload.system_prompt) db.system_prompt = payload.system_prompt;
    if (payload.reply_signature) db.reply_signature = payload.reply_signature;
    if (Array.isArray(payload.pricing_data)) db.pricing_data = payload.pricing_data;
    if (Array.isArray(payload.faq)) db.faq = payload.faq; // [{q,a}]
    db.last_synced = new Date().toISOString();
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
    return res.json({ ok:true, stored:{
      pricing: (db.pricing_data||[]).length,
      faq: (db.faq||[]).length
    }});
  } catch (e) {
    console.error('sync-knowledge error', e);
    return res.status(500).json({ ok:false, error:'sync_failed' });
  }
});

// Minimal OpenAPI schema so GPT Action can call /sync-knowledge
app.get('/openapi.json', (req, res) => {
  res.json({
    openapi: "3.1.0",
    info: { title: "Signature Savings Sync API", version: "1.0.0" },
    paths: {
      "/sync-knowledge": {
        post: {
          operationId: "syncKnowledge",
          description: "Push latest pricing/knowledge into WhatsApp CRM store",
          parameters: [
            {
              in: "header", name: "x-sync-key", required: true,
              schema: { type:"string" }, description:"Shared secret"
            }
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    system_prompt: { type: "string" },
                    reply_signature: { type: "string" },
                    pricing_data: { type: "array", items: { type: "object" } },
                    faq: { type: "array", items: {
                      type: "object",
                      properties: { q:{type:"string"}, a:{type:"string"} },
                      required: ["q","a"]
                    } }
                  }
                }
              }
            }
          },
          responses: { "200": { description: "OK" } }
        }
      }
    }
  });
});

// ===== unified brain endpoint (uses synced pricing & faq) =====
app.post('/brain', async (req,res)=>{
  try{
    const { from, message } = req.body || {};
    const OA_KEY = process.env.OPENAI_API_KEY || "";
    if(!OA_KEY) return res.json({ reply: "AI temporarily unavailable." });

    const db = fs.existsSync(DB_FILE) ? JSON.parse(fs.readFileSync(DB_FILE,'utf8')) : {};
    const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
    const systemPrompt = db.system_prompt || "You are Signature Savings assistant. Luxury, concise, accurate. Confirm city & variant if missing. Use provided pricing_data & faq strictly.";
    const replySignature = db.reply_signature || "";

    const pricing = await loadPricingByType(message); // live or local
    const faqs    = db.faq || [];

    const contextBlock = [
      `PRICING_ROWS: ${Array.isArray(pricing)?pricing.length:0}`,
      Array.isArray(pricing)&&pricing.length ? `FIELDS: ${Object.keys(pricing[0]||{}).join(', ')}` : 'NO PRICING',
      `FAQ_ROWS: ${Array.isArray(faqs)?faqs.length:0}`
    ].join('\n');

    const dataAttachment = JSON.stringify({ pricing, faqs }).slice(0, 35000); // keep safe

    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method:"POST",
      headers:{ Authorization:`Bearer ${OA_KEY}`, "Content-Type":"application/json" },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: systemPrompt + "\n\n" + contextBlock },
          { role: "system", content: dataAttachment },
          { role: "user", content: message || "" }
        ],
        max_tokens: 350
      })
    });

    const j = await r.json();
    console.log("DEBUG OpenAI status:", r.status, "body:", JSON.stringify(j).slice(0,300));
    if (!r.ok) return res.json({ reply: replySignature || "AI temporarily unavailable." });

    const text = j?.choices?.[0]?.message?.content?.trim();
    const final = (text && replySignature) ? `${text}\n${replySignature}` : (text || replySignature || "...");
    return res.json({ reply: final, type: "text" });
  }catch(err){
    console.error("/brain fatal:", err);
    return res.json({ reply: "AI temporarily unavailable." });
  }
});

// ===== smart loader: picks NEW vs USED sheet based on message/type =====
// ===== smart loader: picks NEW vs USED sheet based on message/type =====
async function loadPricingByType(messageOrType) {
  try {
    const t = String(messageOrType||'').toLowerCase();
    // detect intent (keywords for used car)
    const isUsed = [
      'used','pre-owned','preowned','second hand','2nd hand',
      'km','odometer','owner','model year','year',
      '2020','2021','2022','2023','2024','2025'
    ].some(k => t.includes(k))
      || t === 'used' || t === 'preowned' || t === 'pre-owned';

    const urlNew  = process.env.PRICING_SHEET_URL_NEW  || '';
    const urlUsed = process.env.PRICING_SHEET_URL_USED || '';
    const chosenUrl = isUsed ? (urlUsed || urlNew) : (urlNew || urlUsed);
    if (!chosenUrl) return await loadPricing();

    const r = await fetch(chosenUrl);
    const text = await r.text();
    const [head, ...rows] = text.trim().split(/\r?\n/).map(l => l.split(','));
    const keys = head.map(k => k.trim().toLowerCase().replace(/\s+/g,'_'));
    return rows.map(r => Object.fromEntries(r.map((v,i)=>[keys[i], (v||'').trim()])));
  } catch (e) {
    console.error('loadPricingByType error:', e.message);
    return await loadPricing();
  }
}

app.get('/pricing-by-type', async (req, res) => {
  const t = req.query.type || 'auto';
  const data = await loadPricingByType(t);
  res.json({ type: t, count: (data||[]).length, sample: (data||[]).slice(0,3) });
});
