const express = require('express');
const router = express.Router();
let _config = {};
function init(config) { _config = config; }
// config: { META_TOKEN, PHONE_NUMBER_ID, ADMIN_WA, DEBUG, fetch, fs, path, waSendRaw, waSendText, waSendTemplate, sendSheetWelcomeTemplate, BROADCAST_TEMPLATE_NAME, CONTACT_SHEET_CSV_URL, CONTACT_POSTER_URL, getAllLeads }

/* --- FORCE: serve /assets from public/dashboard/assets (regex fallback) --- */
router.get(/^\/assets\/(.*)$/, (req, res) => {
  try {
    const rel = (req.params && req.params[0]) || req.path.replace(/^\/assets\//, "");
    const filePath = _config.path.join(__dirname, "..", "public", "dashboard", "assets", rel);
    if (_config.fs.existsSync(filePath)) return res.sendFile(filePath);
    return res.status(404).send("asset not found");
  } catch (e) {
    console.error("assets fallback error", e && e.message ? e.message : e);
    return res.status(500).send("internal");
  }
});

/* Serve vite.svg at root (safe) */
router.get("/vite.svg", (req, res) => {
  try {
    const p = _config.path.join(__dirname, "..", "public", "dashboard", "vite.svg");
    if (_config.fs.existsSync(p)) return res.sendFile(p);
    return res.status(404).send("vite.svg not found");
  } catch (e) {
    console.error("vite.svg handler error", e && e.message ? e.message : e);
    return res.status(500).send("internal");
  }
});
/* --- end snippet --- */
// --- MRCAR: manual ingest from JSON (dedupe, replace global leads) ---
router.post('/api/leads/ingest-from-json', async (req, res) => {
  try {
    const arr = req.body;
    if (!Array.isArray(arr)) {
      return res.status(400).json({ ok:false, error:'Body must be JSON array' });
    }

    // Deduplicate (id > phone > name)
    const seen = new Set();
    const uniq = [];
    for (const l of arr) {
      const key = (l.id || l.phone || l.name || '').toString().trim();
      if (!key) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      uniq.push(l);
    }


globalThis.leads = uniq;
try { global.leadsDB = uniq; } catch(e) { /* ignore */ }

    return res.json({ ok:true, replaced: uniq.length });
  } catch(e){
    console.error("ingest-from-json error", e);
    return res.status(500).json({ ok:false, error:String(e) });
  }
});
// === IMAGE UPLOAD ENDPOINT (for sending pics on WhatsApp) ===
const multer = require("multer");

const imageStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, "public/uploads");
  },
  filename: function (req, file, cb) {
    const unique = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, unique + "-" + file.originalname.replace(/\s+/g, "_"));
  }
});

const uploadImage = multer({ storage: imageStorage });

router.post("/api/uploads/image", uploadImage.single("image"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ ok: false, error: "No image uploaded" });
  }
  const url = "/uploads/" + req.file.filename;
  return res.json({ ok: true, url });
});

// === BULK WHATSAPP SENDER ===
router.post("/api/bulk/send", async (req, res) => {
  const rows = req.body.rows || [];
  let sent = 0;

  for (const r of rows) {
    if (!r.phone || !r.message) continue;

    try {
      await _config.waSendText(r.phone, r.message);
      sent++;
      await new Promise(r => setTimeout(r, 350)); // avoid Meta rate-limit
    } catch (err) {
      console.warn("bulk send failed for", r.phone, err.message);
    }
  }

  res.json({ ok: true, sent });
});

router.post('/send-image', async (req, res) => {
try {
const { to, imageUrl, caption } = req.body || {};
if (!to || !imageUrl) return res.status(400).json({ ok:false, error:'missing to or imageUrl' });

// If imageUrl is a local path (starts with /uploads or does not start with http)
let mediaId = null;
let useLink = null;
if (String(imageUrl).startsWith('/uploads') || !/^https?:\/\//i.test(imageUrl)) {
// treat as local server file
const localRel = imageUrl.replace(/^\//, ''); // e.g. public/uploads/xxx
const localPath = _config.path.join(__dirname, '..', localRel);
if (!_config.fs.existsSync(localPath)) return res.status(404).json({ ok:false, error:'local file not found' });
mediaId = await uploadMediaToWhatsApp(localPath);
} else {
// If fully public URL, optionally try sending directly (provider may require public URL)
useLink = imageUrl;
}

// send via WhatsApp Cloud API
const token = process.env.META_TOKEN;
const phoneNumberId = process.env.PHONE_NUMBER_ID;
if (!token || !phoneNumberId) return res.status(500).json({ ok:false, error:'missing META_TOKEN or PHONE_NUMBER_ID' });

const body = {
messaging_product: 'whatsapp',
to: String(to).replace(/\D/g, ''),
type: 'image',
image: mediaId ? { id: mediaId, caption: caption || '' } : { link: useLink, caption: caption || '' }
};

const sendResp = await fetch(`https://graph.facebook.com/v17.0/${phoneNumberId}/messages`, {
method: 'POST',
headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
body: JSON.stringify(body)
});
const jr = await sendResp.json();
if (!sendResp.ok) return res.status(500).json({ ok:false, error: jr });
return res.json({ ok:true, sent:true, resp: jr });
} catch (e) {
console.error('send-image error', e && e.message ? e.message : e);
return res.status(500).json({ ok:false, error: String(e) });
}
});
// === waSendImage helper (WhatsApp Cloud API) ===
async function waSendImage(to, mediaId, caption="") {
  const token = process.env.META_TOKEN;
  const phoneNumberId = process.env.PHONE_NUMBER_ID;
  const url = `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`;

  const payload = {
    messaging_product: "whatsapp",
    to: to,
    type: "image",
    image: { id: mediaId, caption: caption }
  };

  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const j = await r.json();
  return j;
}

// === WhatsApp media helper: download and expose via our server ===
async function getMediaUrl(mediaId) {
  try {
    if (!mediaId) throw new Error("No mediaId provided");

    if (!_config.META_TOKEN) {
      throw new Error("META_TOKEN missing – cannot fetch media");
    }

    const GRAPH_API_BASE = process.env.GRAPH_API_BASE || "https://graph.facebook.com/v21.0";
    const baseUrl = process.env.PUBLIC_BASE_URL || "";

    if (!baseUrl) {
      throw new Error("PUBLIC_BASE_URL not set – cannot expose media URL");
    }

    // 1) First call: get media metadata (URL) from Graph API
    const metaResp = await fetch(`${GRAPH_API_BASE}/${mediaId}`, {
      headers: {
        Authorization: `Bearer ${_config.META_TOKEN}`
      }
    });

    if (!metaResp.ok) {
      const errText = await metaResp.text();
      throw new Error(`Media meta fetch failed: ${metaResp.status} ${errText}`);
    }

    const metaJson = await metaResp.json();
    const waUrl = metaJson.url;
    if (!waUrl) throw new Error("No url field in media meta");

    // 2) Second call: download actual binary from that URL
    const fileResp = await fetch(waUrl, {
      headers: {
        Authorization: `Bearer ${_config.META_TOKEN}`
      }
    });

    if (!fileResp.ok) {
      const errText = await fileResp.text();
      throw new Error(`Media download failed: ${fileResp.status} ${errText}`);
    }

    const contentType = fileResp.headers.get("content-type") || "image/jpeg";
    const arrayBuf = await fileResp.arrayBuffer();
    const buf = Buffer.from(arrayBuf);

    // Decide file extension
    let ext = "jpg";
    if (contentType.includes("png")) ext = "png";
    else if (contentType.includes("jpeg")) ext = "jpg";
    else if (contentType.includes("webp")) ext = "webp";

    // Ensure uploads directory exists
    const uploadsDir = _config.path.join(__dirname, "..", "public", "uploads");
    if (!_config.fs.existsSync(uploadsDir)) {
      _config.fs.mkdirSync(uploadsDir, { recursive: true });
    }

    // Save file locally
    const fileName = `wa_${mediaId}.${ext}`;
    const filePath = _config.path.join(uploadsDir, fileName);
    await _config.fs.promises.writeFile(filePath, buf);

    // Public URL for OpenAI
    const publicUrl = `${baseUrl}/uploads/${fileName}`;
    if (_config.DEBUG) console.log("getMediaUrl: stored media at", publicUrl);

    return publicUrl;
  } catch (err) {
    console.warn("getMediaUrl failed:", err?.message || err);
    return null;
  }
}

// === Forward existing WhatsApp media to another number ===
async function waForwardImage(to, mediaId, caption = "") {
  const url = `https://graph.facebook.com/v21.0/${_config.PHONE_NUMBER_ID}/messages`;

  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "image",
    image: {
      id: mediaId,
      caption
    }
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${_config.META_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const data = await resp.json();
  if (_config.DEBUG) console.log("waForwardImage →", JSON.stringify(data));
  return data;
}


// === uploadMediaToWhatsApp: upload a local file to WhatsApp Cloud and return media_id ===
async function uploadMediaToWhatsApp(localPath) {
  try {
    const token = process.env.META_TOKEN || process.env.WA_TOKEN || process.env.META_ACCESS_TOKEN;
    const phoneNumberId = (process.env.PHONE_NUMBER_ID || process.env.WA_PHONE_NUMBER_ID || "").trim();
    if (!token || !phoneNumberId) throw new Error('Missing META_TOKEN or PHONE_NUMBER_ID');

    // resolve local file path (accept "/uploads/xxx" or "uploads/xxx" or "public/uploads/xxx")
    const rel = String(localPath).replace(/^\/+/, '');
    let fullPath = _config.path.resolve(__dirname, '..', rel);
    if (!_config.fs.existsSync(fullPath)) {
      // try under public/
      fullPath = _config.path.resolve(__dirname, '..', 'public', rel);
    }
    if (!_config.fs.existsSync(fullPath)) throw new Error('Local file not found: ' + fullPath);

    const form = new FormData();
    form.append('file', _config.fs.createReadStream(fullPath));
    form.append('messaging_product', 'whatsapp');

    const resp = await fetch(`https://graph.facebook.com/v17.0/${phoneNumberId}/media`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, ...form.getHeaders() },
      body: form
    });

    const j = await resp.json().catch(() => null);
    if (!resp.ok) {
      throw new Error('Upload failed: ' + JSON.stringify(j));
    }
    // usually { id: "..." }
    return j && (j.id || j.media || j) ;
  } catch (e) {
    console.error('uploadMediaToWhatsApp error', e && e.message ? e.message : e);
    throw e;
  }
}

router.post('/send-image', async (req, res) => {
  try {
    const { to, file, caption } = req.body;
    if (!to || !file) return res.json({ ok:false, error:"Missing to/file" });

    const localPath = _config.path.join(__dirname, '..', 'public/uploads', file);

    if (!_config.fs.existsSync(localPath)) {
      return res.json({ ok:false, error:"File not found in uploads/" });
    }

    const uploaded = await uploadMediaToWhatsApp(localPath);
    const mediaId = uploaded.id;

    if (!mediaId) return res.json({ ok:false, error:"Upload failed", uploaded });

    const sent = await waSendImage(to, mediaId, caption || "");

    res.json({ ok:true, mediaId, sent });
  }
  catch (e) {
    console.error("send-image error:", e);
    res.json({ ok:false, error:String(e) });
  }
});
// ============================================================================
//  Sheet broadcast helpers (do NOT affect normal "Hi" → Namaste flow)
// ============================================================================

// simple CSV parser for your contact sheet (no commas inside fields)
function parseCsvFromContactSheet(text) {
  const lines = String(text || '').trim().split(/\r?\n/);
  if (!lines.length) return [];

  const header = lines[0].split(',').map(h => h.trim().toLowerCase());
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw) continue;

    const parts = raw.split(',');
    const row = {};

    header.forEach((key, idx) => {
      row[key] = (parts[idx] || '').trim();
    });

    rows.push(row);
  }

  return rows;
}

// read contacts from the Google Sheet defined in CONTACT_SHEET_CSV_URL
async function fetchContactsFromSheet() {
  if (!_config.CONTACT_SHEET_CSV_URL) {
    throw new Error('CONTACT_SHEET_CSV_URL is not set in .env');
  }

  if (_config.DEBUG) console.log('Sheet broadcast: fetching contacts from', _config.CONTACT_SHEET_CSV_URL);

  const resp = await fetch(_config.CONTACT_SHEET_CSV_URL);
  if (!resp.ok) {
    throw new Error(`Sheet fetch failed: ${resp.status} ${resp.statusText}`);
  }

  const text = await resp.text();
  const rawRows = parseCsvFromContactSheet(text);

  const contacts = rawRows
    .map(row => {
      const name = row['name'] || row['Name'] || 'UNKNOWN';
      const phone = row['phone'] || row['Phone'] || '';
      const city = row['city'] || row['City'] || '';
      const leadFrom = row['lead from'] || row['lead_from'] || '';
      const customerType = row['customer type'] || row['customer_type'] || '';

      if (!phone) return null;

      return { name, phone, city, leadFrom, customerType };
    })
    .filter(Boolean);

  if (_config.DEBUG) console.log(`Sheet broadcast: parsed ${contacts.length} contacts from sheet`);
  return contacts;
}

// ---------------- SHEET BROADCAST SENDER ----------------
// ORDER = 1) TEMPLATE FIRST  2) POSTER IMAGE SECOND

async function sendSheetWelcomeTemplate_OLD(to, name = "Customer") {
  if (!_config.META_TOKEN || !_config.PHONE_NUMBER_ID) {
    throw new Error("META_TOKEN or PHONE_NUMBER_ID not set");
  }

  const displayName = name || "Customer";

  // 1️⃣ TEMPLATE FIRST
  console.log(`Broadcast: sending template to ${to}`);

  const components = [
    {
      type: "body",
      parameters: [
        { type: "text", text: displayName }
      ]
    }
  ];

  const t = await _config.waSendTemplate(
    to,
    _config.BROADCAST_TEMPLATE_NAME,     // must be mr_car_broadcast_en from .env
    components
  );

  if (!t.ok) {
    console.warn(
      "WA sheet-broadcast error (template send):",
      to,
      t.error
    );
    return false;
  }

  console.log("Template sent OK:", to);

  // 2️⃣ POSTER IMAGE SECOND
  const posterUrl = "https://whatsapp-gpt-crm.onrender.com/uploads/mrcar_poster.png";

  try {
    console.log(`Broadcast: sending poster image to ${to} via ${posterUrl}`);
    if (!img.ok) {
      console.warn("Poster image failed for:", to, img.error);
    } else {
      console.log("🖼 Poster send attempted for:", to);
    }
  } catch (e) {
    console.warn("Poster image exception for", to, e?.message || e);
  }

  return true;
}

// --------------------------------------------------------------------------
//  POST /tools/send-greeting-from-sheet
//  - Reads Google Sheet
//  - Sends mr_car_broadcast_en + poster to each valid phone
//  - DOES NOT change normal webhook flow
// --------------------------------------------------------------------------
router.post('/tools/send-greeting-from-sheet', async (req, res) => {
  try {
    console.log("🔥 GREETING ROUTE HIT");
    console.log("CONTACT_SHEET_CSV_URL =", _config.CONTACT_SHEET_CSV_URL);
    console.log("CONTACT_POSTER_URL =", _config.CONTACT_POSTER_URL);

    if (!_config.CONTACT_SHEET_CSV_URL) {
  return res.status(500).json({ ok: false, error: 'CONTACT_SHEET_CSV_URL missing in env' });
}
if (!_config.CONTACT_POSTER_URL && _config.DEBUG) {
  console.warn('Sheet broadcast: CONTACT_POSTER_URL missing, will send text-only template.');
}
    const contacts = await fetchContactsFromSheet();
    console.log("📄 Contacts fetched:", contacts.length);
// basic filter: Indian mobile numbers starting with 91 and at least 10 digits
const targets = contacts.filter(c => {
  const p = String(c.phone || '').replace(/\s+/g, '');
  return p && p.startsWith('91') && p.length >= 10;
});

console.log("🎯 Valid targets:", targets.length);
if (_config.DEBUG) console.log(`Sheet broadcast: will send to ${targets.length} contacts`);

let sent = 0;
const failed = [];

for (const c of targets) {
  const phone = String(c.phone || '').replace(/\s+/g, '');
  const name = c.name || 'Customer';

  console.log("Sheet broadcast → sending to:", phone, "Name:", name);

  // 1) Try sending poster image (NO TEMPLATE HERE)
  if (_config.CONTACT_POSTER_URL) {
    try {
      const caption =
        'Hello ' + name + ', 👋\n' +
        'Welcome to Mr.Car! 🚗✨\n' +
        'We are at your service. Just say "Hi" to get started.';

      console.log("🖼 Poster send attempted for:", phone);
    } catch (err) {
      console.warn(
        "WA sheet-broadcast error (poster image):",
        phone,
        err && err.message ? err.message : err
      );
      // we don't mark as failed here, text template send will still try
    }
  }

  // 2) Send text template (mr_car_broadcast_en) with 1 param = name
  try {
    const ok = await _config.sendSheetWelcomeTemplate(phone, name);

    if (ok) {
      sent++;
    } else {
      failed.push(phone);
    }
  } catch (err) {
    console.warn(
      "WA sheet-broadcast error (template send):",
      phone,
      err && err.message ? err.message : err
    );
    failed.push(phone);
  }

  // 0.8s pause between messages
  await delay(800);
}

if (_config.DEBUG) console.log(`Sheet broadcast: done. Sent=${sent}, Failed=${failed.length}`);

console.log("🏁 GREETING BROADCAST FINISHED — Sent:", sent, "Failed:", failed.length);

return res.json({
  ok: true,
  total: targets.length,
  sent,
  failed: failed.length,
  failedPhones: failed
});

  } catch (err) {
    console.error('Sheet broadcast route failed:', err);
    return res.status(500).json({
      ok: false,
      error: err && err.message ? err.message : String(err)
    });
  }
});

// --------------------------------------------------------------------------
//  Simple UI for "Send Greeting" broadcast
//  URL: GET /tools/send-greeting-ui
//  Shows a single button that calls POST /tools/send-greeting-from-sheet
// --------------------------------------------------------------------------
router.get('/tools/send-greeting-ui', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Send Greeting • Mr.Car CRM</title>
  <style>
    body { font-family: system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; background:#0b1020; color:#f5f5f5; display:flex; align-items:center; justify-content:center; height:100vh; margin:0; }
    .card { background:#11162a; padding:24px 28px; border-radius:16px; box-shadow:0 18px 45px rgba(0,0,0,0.45); max-width:420px; width:100%; }
    h1 { font-size:20px; margin:0 0 8px 0; }
    p { font-size:14px; margin:4px 0 12px 0; color:#c0c4d0; }
    button { background:#2563eb; color:white; border:none; border-radius:999px; padding:10px 20px; font-size:14px; cursor:pointer; display:inline-flex; align-items:center; gap:8px; }
    button[disabled] { opacity:0.6; cursor:default; }
    small { display:block; font-size:11px; color:#9ca3af; margin-top:8px; }
    #status { margin-top:10px; font-size:13px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Send Greeting to Sheet Contacts</h1>
    <p>This will send the <strong>Namaste + poster</strong> template to all valid phone numbers in the Google Sheet.</p>
    <button id="sendBtn">
      <span>🚀 Send Greeting</span>
    </button>
    <small>Uses /tools/send-greeting-from-sheet on this server.</small>
    <div id="status">Idle.</div>
  </div>

  <script>
    (function () {
      const btn = document.getElementById('sendBtn');
      const status = document.getElementById('status');

      btn.addEventListener('click', async () => {
        const ok = window.confirm('Send Namaste greeting + poster to ALL contacts from Google Sheet now?');
        if (!ok) return;

        btn.disabled = true;
        const original = btn.textContent;
        btn.textContent = 'Sending...';
        status.textContent = 'Broadcast in progress...';

        try {
          const resp = await fetch('/tools/send-greeting-from-sheet', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
          });

          if (!resp.ok) {
            const text = await resp.text();
            console.error('Broadcast failed:', resp.status, text);
            alert('Error sending greeting. Check server logs.');
            status.textContent = 'Error sending greeting. Check server logs.';
            return;
          }

          const data = await resp.json();
          console.log('Broadcast result:', data);
          const msg = 'Greeting sent: ' + data.sent + '/' + data.total + ' delivered, ' + data.failed + ' failed.';
          alert(msg);
          status.textContent = msg;
        } catch (e) {
          console.error('Exception:', e);
          alert('Unexpected error. Check console/server logs.');
          status.textContent = 'Unexpected error. See logs.';
        } finally {
          btn.disabled = false;
          btn.textContent = original;
        }
      });
    })();
  </script>
</body>
</html>`);
});
// === WA delivery status log download ===
router.get('/api/wa-delivery-log', (req, res) => {
  const fs = require('fs');
  const path = require('path');
  const logPath = path.join(__dirname, '..', '.crm_data', 'wa_status_log.json');

  if (!fs.existsSync(logPath)) {
    return res.json({ ok: false, error: "No log file found" });
  }

  const data = fs.readFileSync(logPath, 'utf8');
  res.setHeader('Content-Type', 'application/json');
  res.send(data);
});

// SKIP: duplicate dashboard route registrations (lines 6334-6405) — already handled in server.cjs

// EXPORT_CSV_ENDPOINT_MARKER
// Minimal CSV export/import endpoints added for local dashboard export/import.
const csvStringifyLocal = (rows) => rows.map(r => r.map(c => '"' + String(c||'').replace(/"/g,'""') + '"').join(',')).join('\n');

try {
  const multer = require('multer');
  const upload = multer({ storage: multer.memoryStorage() });

  router.get('/api/leads/export-csv', async (req, res) => {
    try {
      let leads = [];
      if (typeof getLeadsFromDbOrCache === 'function') {
        leads = await getLeadsFromDbOrCache();
      } else if (typeof db !== 'undefined' && db.collection) {
        // try common fallback (may or may not apply)
        try { leads = await db.collection('leads').find().toArray(); } catch(e) {}
      }
      const rows = [['ID','Name','Phone','Status','Timestamp'], ...(leads||[]).map(l => [l.id||l._id||'', l.name||'', l.phone||'', l.status||'', l.timestamp||''])];
      const csv = csvStringifyLocal(rows);
      res.setHeader('Content-Type','text/csv');
      res.setHeader('Content-Disposition','attachment; filename="leads.csv"');
      return res.send(csv);
    } catch(err) {
      console.error('export-csv err', err);
      return res.status(500).send('export failed');
    }
  });

  router.post('/api/leads/import-csv', upload.single('file'), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ ok:false, error: 'no file uploaded' });
      const csv = req.file.buffer.toString('utf8');
      // naive CSV split (works for simple CSVs with quoted values)
      const rows = csv.split(/\r?\n/).filter(Boolean).map(line => {
        // split on commas not inside quotes (simple)
        return line.match(/(?:\"([^\"]*(?:\"\"[^\"]*)*)\")|([^,]+)/g).map(cell => (cell||'').replace(/^"|"$/g,'').replace(/""/g,'"'));
      });
      const header = rows.shift().map(h => h.toString().trim().toLowerCase());
      const docs = rows.map(r => {
        const obj = {};
        for (let i=0;i<header.length;i++) obj[header[i]] = (r[i]||'').toString().trim();
        return obj;
      });
      console.log('imported rows', docs.length);
      // TODO: plug into your ingest/save pipeline (e.g., await ingestLeads(docs))
      return res.json({ ok:true, imported: docs.length });
    } catch(e){
      console.error('import-csv err', e);
      return res.status(500).json({ ok:false, error: e.message });
    }
  });
} catch(e) {
  console.error('CSV endpoints setup error', e);
}
// MRCAR_API_LEADS_ENDPOINT_MARKER
try {
  router.get('/api/leads', async (req, res) => {
    try {
      const q = (req.query.q||'').toString().trim();
      const leadType = (req.query.lead_type||'').toString().trim().toLowerCase();
      let leads = [];
      if (typeof getLeadsFromDbOrCache === 'function') {
        try { leads = await getLeadsFromDbOrCache(); } catch(e) { console.error('getLeadsFromDbOrCache err', e); leads = []; }
      } else if (Array.isArray(globalThis.leads)) {
        leads = globalThis.leads;
      } else {
        leads = [];
      }
      leads = (leads||[]).map(l => ({
        id: l.id||l.ID||'', name: l.name||l.Name||'', phone: l.phone||l.Phone||'',
        status: l.status||l.Status||'', timestamp: l.timestamp||l.Timestamp||'',
        car_enquired: l.car_enquired||l.car||l.variant||'',
        budget: l.budget||l.Budget||'', last_ai_reply: l.last_ai_reply||'',
        ai_quote: l.ai_quote||'', _raw:l
      }))
      if (q) {
        const ql = q.toLowerCase();
        leads = leads.filter(x => ((x.id||'') + (x.name||'') + (x.phone||'') + (x.car_enquired||'')).toLowerCase().includes(ql));
      }
      if (leadType) {
        const lt = leadType;
        leads = leads.filter(x => (x.status||'').toLowerCase().includes(lt) || (x.car_enquired||'').toLowerCase().includes(lt));
      }
      return res.json({ ok:true, leads });
    } catch(e) {
      return res.status(500).json({ ok:false, error: e.message||String(e) });
    }
  });
  console.log('MRCAR: /api/leads endpoint installed (normalizes extra fields)');
} catch(e) {
  console.error('MRCAR: failed to install /api/leads endpoint', e);
}



// MRCAR_LEADS_DEBUG_MARKER
// Diagnostic endpoint to inspect possible lead sources and sample items
try {
  router.get('/api/leads/debug-sources', async (req, res) => {
    try {
      const out = { ok:true, found: {} };

      // helper to safe call functions
      async function tryFn(fn) {
        try {
          const v = await fn();
          return { ok:true, sample: Array.isArray(v) ? v.slice(0,3) : v };
        } catch(e) {
          return { ok:false, error: String(e) };
        }
      }

      // 1) getLeadsFromDbOrCache
      out.found.getLeadsFromDbOrCache = (typeof getLeadsFromDbOrCache === 'function') ? 'function' : 'none';
      if (typeof getLeadsFromDbOrCache === 'function') {
        out.getLeadsFromDbOrCache = await tryFn(() => getLeadsFromDbOrCache());
        out.getLeadsFromDbOrCache_count = Array.isArray(out.getLeadsFromDbOrCache.sample) ? out.getLeadsFromDbOrCache.sample.length : (out.getLeadsFromDbOrCache.sample ? 1 : 0);
      }

      // 2) db.collection('leads')
      out.found.db = (typeof db !== 'undefined' && db && db.collection) ? 'db-collection-available' : 'no-db';
      if (typeof db !== 'undefined' && db && db.collection) {
        try {
          const c = db.collection('leads');
          const sample = await c.find().limit(3).toArray().catch(e=>{throw e});
          out.db_collection_sample = sample;
          out.db_collection_count_guess = (Array.isArray(sample) ? sample.length : 0);
        } catch(e) {
          out.db_collection_error = String(e);
        }
      }

      // 3) global caches / common names
      const tries = ['globalLeadsCache','leadsCache','leadsList','leads','globalThis.leads'];
      out.found.globals = {};
      for (const k of tries) {
        try {
          let val = undefined;
          if (k === 'globalThis.leads') val = globalThis.leads;
          else if (typeof globalThis[k] !== 'undefined') val = globalThis[k];
          else if (typeof eval("typeof " + k + " !== 'undefined' && " + k) !== 'undefined') {
            // not reliable; skip
          }
          out.found.globals[k] = Array.isArray(val) ? ('array:' + val.length) : (val ? 'present' : 'none');
          if (Array.isArray(val)) out[k + '_sample'] = val.slice(0,3);
        } catch(e) {
          out.found.globals[k] = 'error';
          out[k + '_error'] = String(e);
        }
      }

      // 4) try to find a function that looks like "loadLeads" or "refreshLeads"
      const candidates = ['loadLeads','refreshLeads','fetchLeads','getAllLeads'];
      out.found.candidates = {};
      for (const fn of candidates) {
        out.found.candidates[fn] = (typeof globalThis[fn] === 'function') ? 'function' : 'none';
      }

      // 5) include a small portion of server.cjs where "leads" appears to help quick grep
      try {
        const fs = require('fs');
        const path = require('path');
        const serverText = fs.readFileSync(path.join(__dirname,'..','server.cjs'),'utf8');
        // return lines with "leads" (first 40 matches) to help debugging
        const lines = serverText.split(/\\r?\\n/).map((l,i)=>({i:i+1,l}));
        const matches = lines.filter(x => /\\bleads\\b/i.test(x.l)).slice(0,40).map(x => x.i + ':' + x.l);
        out.server_leads_lines = matches;
      } catch(e) {
        out.server_leads_lines_error = String(e);
      }

      return res.json(out);
    } catch(e) {
      console.error('leads debug endpoint error', e);
      return res.status(500).json({ ok:false, error: String(e) });
    }
  });
  console.log('MRCAR: /api/leads/debug-sources endpoint installed');
} catch(e){
  console.error('MRCAR: failed to install leads debug endpoint', e);
}


// MRCAR_GETALL_LEADS_MARKER
// Route to fetch leads using getAllLeads() and normalize for dashboard quickly
try {
  router.get('/api/leads/from-getall', async (req, res) => {
    try {
      if (typeof _config.getAllLeads !== 'function') return res.status(404).json({ ok:false, error: 'getAllLeads not present' });

      // call getAllLeads — handle sync or promise-returning functions
      let raw;
      try {
        raw = await Promise.resolve(_config.getAllLeads());
      } catch (e1) {
        // sometimes functions expect options object — try with empty object
        try { raw = await Promise.resolve(_config.getAllLeads({})); } catch(e2) { throw e1; }
      }

      // ensure array
      const arr = Array.isArray(raw) ? raw : (raw && raw.items && Array.isArray(raw.items) ? raw.items : []);
      const leads = (arr || []).map(l => {
        return {
          id: l.id || l._id || l.ID || '',
          name: l.name || l.Name || l.customerName || l.cust_name || '',
          phone: l.phone || l.Phone || l.mobile || l.Mobile || '',
          status: l.status || l.Status || '',
          timestamp: l.timestamp || l.Timestamp || l.ts || l._created || '',
          car_enquired: l.car_enquired || l.car || l.variant || l['Car Enquired'] || l['car_enquired'] || '',
          budget: l.budget || l.Budget || l.expected_budget || l['Budget'] || '',
          last_ai_reply: l.last_ai_reply || l.last_ai || l['Last AI Reply'] || '',
          ai_quote: l.ai_quote || l.quote || l['AI Quote'] || '',
          _raw: l
        };
      });

      return res.json({ ok:true, count: leads.length, leads: leads.slice(0, 30) });
    } catch (e) {
      console.error('MRCAR /api/leads/from-getall error', e);
      return res.status(500).json({ ok:false, error: String(e) });
    }
  });
  console.log('MRCAR: /api/leads/from-getall route installed');
} catch(e){
  console.error('MRCAR: failed to install /api/leads/from-getall', e);
}


// MRCAR_INGEST_FROM_SHEETS_MARKER
// Ingest leads from /api/sheets/export, normalize and populate globalThis.leads
try {
  router.post('/api/leads/ingest-from-sheets', async (req, res) => {
    try {
      // attempt to fetch rows from internal export logic
      let sheetResp;
      // prefer calling internal function if available
      if (typeof exports !== 'undefined' && exports && typeof exports.exportSheets === 'function') {
        sheetResp = await Promise.resolve(exports.exportSheets(req.body || {}));
      } else if (typeof fetch === 'function') {
        const url = (req.protocol ? (req.protocol + '://') : '') + (req.get ? req.get('host') : ('localhost:3000')) + '/api/sheets/export';
        // If internal host not resolvable, fallback to localhost
        const internalUrl = 'http://localhost:10000/api/sheets/export';
        const fresp = await fetch(internalUrl, { method: 'POST', headers: { 'content-type':'application/json' }, body: JSON.stringify(req.body || {}) }).catch(e=>null);
        sheetResp = fresp ? await fresp.json().catch(e=>null) : null;
      } else {
        return res.status(500).json({ ok:false, error:'No internal fetch available to call sheets export' });
      }

      if (!sheetResp || !sheetResp.ok) {
        return res.status(500).json({ ok:false, error: sheetResp && sheetResp.error ? sheetResp.error : 'sheets export failed or returned no rows' });
      }

      // sheetResp may contain .rows (csv-parsed) or .exported rows depending on implementation
      // Try common places
      const rawRows = sheetResp.rows || sheetResp.data || sheetResp.values || sheetResp.items || (sheetResp.exported ? sheetResp.rows : null) || null;
      // If no rows found but updatedRange present, try calling /api/sheets/export with fallback reading
      if (!rawRows || !Array.isArray(rawRows)) {
        // some implementations return CSV text as "csv" or "content"
        if (Array.isArray(sheetResp.rows)) {
          // leave as is
        } else if (Array.isArray(sheetResp.values)) {
          // already set
        } else {
          // Can't find rows array -> return debug text
          return res.status(500).json({ ok:false, error: 'unexpected sheets export format', sheetResp });
        }
      }

      // Normalize header+rows -> array of objects
      // if first row looks like header row (array of strings)
      let objs = [];
      if (Array.isArray(rawRows) && rawRows.length > 0 && Array.isArray(rawRows[0])) {
        const header = rawRows[0].map(h => String(h||'').trim());
        const rows = rawRows.slice(1);
        objs = rows.map(r => {
          const obj = {};
          for (let i=0;i<header.length;i++) {
            const key = header[i] ? header[i].toString().trim() : ('col'+i);
            obj[key] = r[i] !== undefined ? r[i] : '';
          }
          return obj;
        });
      } else if (Array.isArray(rawRows) && rawRows.length > 0 && typeof rawRows[0] === 'object') {
        objs = rawRows;
      }

      // Normalization: map likely column names to expected keys
      const normalized = (objs||[]).map(l => {
        const get = (names) => {
          for (const n of names) {
            if (Object.prototype.hasOwnProperty.call(l, n)) return l[n];
            // try lowercased keys
            const k = Object.keys(l).find(x => x && x.toLowerCase() === (n||'').toLowerCase());
            if (k) return l[k];
          }
          return '';
        };
        return {
          id: get(['ID','Id','id']) || get(['phone','Phone']) || '',
          name: get(['Name','name','Customer','customerName']) || '',
          phone: get(['Phone','phone','Mobile','mobile','Contact']) || '',
          status: get(['Status','status']) || '',
          timestamp: get(['Timestamp','timestamp','ts','created_at']) || '',
          car_enquired: get(['Car Enquired','Car','car_enquired','car_enquired','carEnquired','Variant','variant']) || '',
          budget: get(['Budget','budget','Expected Budget','expected_budget']) || '',
          last_ai_reply: get(['Last AI Reply','Last AI','last_ai_reply','lastAiReply']) || '',
          ai_quote: get(['AI Quote','ai_quote','Quote','quote']) || '',
          _raw: l
        };
      });

      // set into globalThis.leads so existing /api/leads uses it
      globalThis.leads = normalized;

      return res.json({ ok:true, imported: normalized.length, sample: normalized.slice(0,10) });
    } catch (e) {
      console.error('ingest-from-sheets error', e);
      return res.status(500).json({ ok:false, error: String(e) });
    }
  });
  console.log('MRCAR: /api/leads/ingest-from-sheets route installed');
} catch(e) {
  console.error('MRCAR: failed to install ingest-from-sheets route', e);
}


// MRCAR_INGEST_FROM_SHEETS_ROBUST_MARKER
// Robust ingest: if sheets export returns metadata only, fetch CSV (SHEET_TOYOTA_CSV_URL or built from GOOGLE_SHEET_ID)
try {
  router.post('/api/leads/ingest-from-sheets-robust', async (req, res) => {
    try {
      const fetchJson = async () => {
        // call internal sheets export endpoint
        try {
          const resp = await (typeof fetch === 'function' ? fetch('http://localhost:10000/api/sheets/export', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(req.body||{}) }) : null);
          if (!resp) return null;
          try { return await resp.json(); } catch(e) { return { ok:false, error:'invalid-json-from-sheets-export' }; }
        } catch(e) { return null; }
      };

      let sheetResp = await fetchJson();
      if (!sheetResp) {
        return res.status(500).json({ ok:false, error:'failed to call /api/sheets/export internally' });
      }

      // If sheetResp looks like it already had rows, reuse that logic
      if (Array.isArray(sheetResp.rows) && sheetResp.rows.length) {
        // let existing logic in ingest-from-sheets handle it if desired; here we will reuse that structure
        // convert to normalized objects below
      } else {
        // fallback: try to fetch CSV
        const env = process.env || {};
        let csvUrl = env.SHEET_TOYOTA_CSV_URL || env.SHEET_CSV_URL || '';
        if (!csvUrl && env.GOOGLE_SHEET_ID) {
          const gid = (sheetResp.updatedRange && /gid=(\\d+)/.test(sheetResp.updatedRange)) ? RegExp.$1 : '0';
          csvUrl = `https://docs.google.com/spreadsheets/d/${env.GOOGLE_SHEET_ID}/export?format=csv&gid=${gid}`;
        }
        if (!csvUrl) {
          return res.status(500).json({ ok:false, error:'no CSV url available (set SHEET_TOYOTA_CSV_URL or GOOGLE_SHEET_ID)' , sheetResp});
        }

        // fetch CSV
        let csvText = '';
        try {
          const resp2 = await (typeof fetch === 'function' ? fetch(csvUrl) : null);
          if (!resp2 || !resp2.ok) {
            // try node http fallback using native https
            const https = require('https');
            csvText = await new Promise((resolve, reject) => {
              let data = '';
              https.get(csvUrl, (r) => {
                r.on('data', chunk => data += chunk);
                r.on('end', () => resolve(data));
                r.on('error', reject);
              }).on('error', reject);
            }).catch(e=>null);
          } else {
            csvText = await resp2.text();
          }
        } catch(e) {
          return res.status(500).json({ ok:false, error:'failed to fetch sheet csv', e: String(e), csvUrl });
        }

        if (!csvText) return res.status(500).json({ ok:false, error:'empty csv fetched', csvUrl });

        // minimal CSV parse (handles quoted fields)
        const parseCSV = (text) => {
          const rows = [];
          let cur = '';
          let row = [];
          let inQuotes = false;
          for (let i=0;i<text.length;i++) {
            const ch = text[i];
            const next = text[i+1];
            if (ch === '"' ) {
              if (inQuotes && next === '"') { cur += '"'; i++; continue; } // escaped quote
              inQuotes = !inQuotes;
              continue;
            }
            if (ch === ',' && !inQuotes) { row.push(cur); cur=''; continue; }
            if ((ch === '\\n' || ch === '\\r') && !inQuotes) {
              // handle CRLF
              if (ch === '\\r' && text[i+1] === '\\n') { i++; }
              row.push(cur); rows.push(row); row=[]; cur=''; continue;
            }
            cur += ch;
          }
          // flush last
          if (cur !== '' || row.length) {
            row.push(cur);
            rows.push(row);
          }
          return rows.filter(r => r.length>1 || (r.length===1 && String(r[0]||'').trim()!==''));
        };

        const rows = parseCSV(csvText);
        // first row header?
        let objs = [];
        if (rows.length > 0 && rows[0].every(c => String(c||'').trim() !== '')) {
          const header = rows[0].map(h => String(h||'').trim());
          const dataRows = rows.slice(1);
          objs = dataRows.map(r => {
            const o = {};
            for (let i=0;i<header.length;i++) o[header[i]||('col'+i)] = r[i] !== undefined ? r[i] : '';
            return o;
          });
        } else {
          objs = rows.map(r => {
            const o = {};
            r.forEach((c,i)=>o['col'+i]=c);
            return o;
          });
        }

        // normalize (case-insensitive key matches)
        const normalized = objs.map(l => {
          const keys = Object.keys(l||{});
          const find = (names) => {
            for (const n of names) {
              const k = keys.find(x => x && x.toLowerCase() === (n||'').toLowerCase());
              if (k) return l[k];
            }
            return '';
          };
          return {
            id: find(['ID','Id','id']) || find(['Phone','phone']) || '',
            name: find(['Name','name','Customer','customerName']) || '',
            phone: find(['Phone','phone','Mobile','mobile','Contact']) || '',
            status: find(['Status','status']) || '',
            timestamp: find(['Timestamp','timestamp','ts','created_at']) || '',
            car_enquired: find(['Car Enquired','Car','car_enquired','Variant','variant']) || '',
            budget: find(['Budget','budget','Expected Budget','expected_budget']) || '',
            last_ai_reply: find(['Last AI Reply','Last AI','last_ai_reply','lastAiReply']) || '',
            ai_quote: find(['AI Quote','ai_quote','Quote','quote']) || '',
            _raw: l
          };
        });

        globalThis.leads = normalized;
        return res.json({ ok:true, imported: normalized.length, sample: normalized.slice(0,10), csvUrl });
      }

      // If we reach here, sheetResp already contained rows (not typical for your setup),
      // attempt to transform them similarly (left as fallback)
      const rawRows = sheetResp.rows || sheetResp.values || sheetResp.data || [];
      // Normalize header->objects if first row is header array
      let objs = [];
      if (Array.isArray(rawRows) && rawRows.length && Array.isArray(rawRows[0])) {
        const header = rawRows[0].map(h => String(h||'').trim());
        const dataRows = rawRows.slice(1);
        objs = dataRows.map(r => {
          const o = {};
          for (let i=0;i<header.length;i++) o[header[i]||('col'+i)] = r[i] !== undefined ? r[i] : '';
          return o;
        });
      } else if (Array.isArray(rawRows) && rawRows.length && typeof rawRows[0] === 'object') {
        objs = rawRows;
      }
      const normalized = objs.map(l => {
        const keys = Object.keys(l||{});
        const find = (names) => {
          for (const n of names) {
            const k = keys.find(x => x && x.toLowerCase() === (n||'').toLowerCase());
            if (k) return l[k];
          }
          return '';
        };
        return {
          id: find(['ID','Id','id']) || find(['Phone','phone']) || '',
          name: find(['Name','name','Customer','customerName']) || '',
          phone: find(['Phone','phone','Mobile','mobile','Contact']) || '',
          status: find(['Status','status']) || '',
          timestamp: find(['Timestamp','timestamp','ts','created_at']) || '',
          car_enquired: find(['Car Enquired','Car','car_enquired','Variant','variant']) || '',
          budget: find(['Budget','budget','Expected Budget','expected_budget']) || '',
          last_ai_reply: find(['Last AI Reply','Last AI','last_ai_reply','lastAiReply']) || '',
          ai_quote: find(['AI Quote','ai_quote','Quote','quote']) || '',
          _raw: l
        };
      });
      globalThis.leads = normalized;
      return res.json({ ok:true, imported: normalized.length, sample: normalized.slice(0,10) });
    } catch(e) {
      console.error('ingest-from-sheets-robust error', e);
      return res.status(500).json({ ok:false, error: String(e) });
    }
  });
  console.log('MRCAR: /api/leads/ingest-from-sheets-robust route installed');
} catch(e) {
  console.error('MRCAR: failed to install ingest-from-sheets-robust route', e);
}

// local delay helper
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { init, router };
