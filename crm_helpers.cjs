// crm_helpers.cjs — multi-file JSON CRM helper for MR.CAR
// Stores leads in separate files per bot (lightweight, safe)

// Node fetch compatibility
const fs = require('fs');
const path = require('path');
const fetch = (global.fetch) ? global.fetch : require('node-fetch');

const DATA_DIR = path.resolve(__dirname, '.crm_data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Per-bot files (names)
const FILES = {
  MR_CAR:     path.join(DATA_DIR, 'crm_mr_car.json'),
  SIGNATURE:  path.join(DATA_DIR, 'crm_signature.json'),
  PROPERTY:   path.join(DATA_DIR, 'crm_property.json'),
  LOAN:       path.join(DATA_DIR, 'crm_loan.json'),
  MASTER:     path.join(DATA_DIR, 'crm_leads_master.json')
};

const CRM_URL = process.env.SIGNATURE_CRM_URL || process.env.CRM_BASE_URL || null;
const CRM_KEY = process.env.SIGNATURE_CRM_KEY || null;
const CRM_AUTH_HEADER = process.env.SIGNATURE_CRM_AUTH_HEADER || null;
const DEBUG = (process.env.DEBUG === 'true') || true;

// ---------- simple JSON helpers ----------
function safeReadJson(file) {
  try {
    if (!fs.existsSync(file)) return [];
    const txt = fs.readFileSync(file, 'utf8') || '[]';
    const j = JSON.parse(txt);
    if (Array.isArray(j)) return j;
    if (j && Array.isArray(j.leads)) return j.leads;
    return [];
  } catch (e) {
    if (DEBUG) console.warn('safeReadJson failed for', file, e && e.message ? e.message : e);
    return [];
  }
}

function safeWriteJson(file, obj) {
  try {
    fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
    return true;
  } catch (e) {
    if (DEBUG) console.warn('safeWriteJson failed for', file, e && e.message ? e.message : e);
    return false;
  }
}

// ensure file exists with array
function ensureFile(file) {
  try {
    if (!fs.existsSync(file)) safeWriteJson(file, []);
    return true;
  } catch (e) {
    if (DEBUG) console.warn('ensureFile failed', e && e.message ? e.message : e);
    return false;
  }
}

// ---------- CRM local storage operations ----------
function addLeadToFile(file, lead) {
  try {
    ensureFile(file);
    const arr = safeReadJson(file);
    arr.unshift(lead);
    // keep a reasonable size
    const capped = arr.slice(0, 5000);
    safeWriteJson(file, capped);
    return true;
  } catch (e) {
    if (DEBUG) console.warn('addLeadToFile failed', e && e.message ? e.message : e);
    return false;
  }
}

// append to master file too
function addLeadToMaster(lead) {
  try {
    ensureFile(FILES.MASTER);
    const all = safeReadJson(FILES.MASTER);
    all.unshift(lead);
    safeWriteJson(FILES.MASTER, all.slice(0, 10000));
    return true;
  } catch (e) {
    if (DEBUG) console.warn('addLeadToMaster failed', e && e.message ? e.message : e);
    return false;
  }
}

// ---------- helper: build auth headers ----------
function buildAuthHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  if (CRM_KEY && CRM_AUTH_HEADER) headers[CRM_AUTH_HEADER] = CRM_KEY;
  else if (CRM_KEY) headers['Authorization'] = `Bearer ${CRM_KEY}`;
  return headers;
}

// ---------- safe remote POST with retries ----------
async function safeRemotePost(url, payload, attempts = 3, backoff = 300) {
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: buildAuthHeaders(),
        body: JSON.stringify(payload),
        timeout: 6000
      });
      const txt = await r.text().catch(() => '');
      let body = null;
      try { body = txt ? JSON.parse(txt) : null; } catch(e) { body = txt; }
      if (r.ok) return { ok: true, status: r.status, body };
      if (r.status >= 400 && r.status < 500) return { ok: false, status: r.status, body };
    } catch (e) {
      if (DEBUG) console.warn('safeRemotePost exception', e && e.message ? e.message : e);
    }
    await new Promise(r => setTimeout(r, backoff * (i + 1)));
  }
  return { ok: false, status: 0, body: 'failed' };
}

// ---------- exported functions ----------

/**
 * postLeadToCRM(lead)
 * lead: { bot, channel, from, name, lastMessage, service, tags[], meta{}, createdAt }
 */
async function postLeadToCRM(lead) {
  try {
    if (!lead || typeof lead !== 'object') return false;
    const now = Date.now();
    const normalized = Object.assign({
      bot: lead.bot || 'MR_CAR',
      channel: lead.channel || 'whatsapp',
      from: lead.from || '',
      name: lead.name || '',
      lastMessage: lead.lastMessage || lead.text || '',
      service: lead.service || null,
      tags: Array.isArray(lead.tags) ? lead.tags : [],
      meta: lead.meta || {},
      createdAt: lead.createdAt || now
    }, lead);

    // ensure small fields
    if (typeof normalized.tags === 'string') normalized.tags = [normalized.tags];

    // local per-bot file
    const botKey = (normalized.bot || 'MR_CAR').toString().toUpperCase();
    let targetFile = FILES.MR_CAR;
    if (botKey.includes('SIGNATURE')) targetFile = FILES.SIGNATURE;
    else if (botKey.includes('PROPERTY')) targetFile = FILES.PROPERTY;
    else if (botKey.includes('LOAN')) targetFile = FILES.LOAN;
    else if (botKey.includes('MR') || botKey.includes('CAR')) targetFile = FILES.MR_CAR;

    // save locally (always)
    addLeadToFile(targetFile, normalized);
    addLeadToMaster(normalized);
    if (DEBUG) console.log('postLeadToCRM local save ok', normalized.from, normalized.bot);

    // Attempt remote CRM ingest if configured (non-blocking)
    if (CRM_URL) {
      const url = (CRM_URL || '').replace(/\/+$/, '') + '/crm/ingest';
      const resp = await safeRemotePost(url, normalized, 3, 400);
      if (DEBUG) console.log('postLeadToCRM remote resp', resp && resp.status ? resp.status : 'noresp');
      return resp.ok ? true : false;
    }

    return true;
  } catch (e) {
    if (DEBUG) console.warn('postLeadToCRM exception', e && e.message ? e.message : e);
    return false;
  }
}

/**
 * fetchCRMReply({from, msgText})
 * Optional: attempts remote /crm/reply if CRM_URL present; otherwise null.
 */
async function fetchCRMReply({ from, msgText } = {}) {
  try {
    if (!CRM_URL) return null;
    const url = (CRM_URL || '').replace(/\/+$/, '') + '/crm/reply';
    const resp = await safeRemotePost(url, { from, msgText }, 2, 200);
    if (resp.ok && resp.body && resp.body.reply) return resp.body.reply;
    return null;
  } catch (e) {
    if (DEBUG) console.warn('fetchCRMReply fail', e && e.message ? e.message : e);
    return null;
  }
}

/**
 * getAllLeads(limit) — returns merged master file (most recent)
 */
async function getAllLeads(limit = 100) {
  try {
    ensureFile(FILES.MASTER);
    const all = safeReadJson(FILES.MASTER) || [];
    const n = Math.max(1, Math.min(500, Number(limit) || 100));
    return all.slice(0, n);
  } catch (e) {
    if (DEBUG) console.warn('getAllLeads fail', e && e.message ? e.message : e);
    return [];
  }
}

module.exports = { postLeadToCRM, fetchCRMReply, getAllLeads };


// --- assistant-added fallback: postLeadToCRM ---
module.exports.postLeadToCRM = async function postLeadToCRM(lead) {
  const fs = require('fs');
  const path = require('path');
  try {
    const leadsPath = path.join(__dirname, '..', 'crm_leads.json');
    let arr = [];
    if (fs.existsSync(leadsPath)) {
      try { arr = JSON.parse(fs.readFileSync(leadsPath,'utf8') || '[]'); } catch(e){ arr = []; }
    }
    const now = new Date().toISOString();
    const newLead = {
      id: lead.from ? 'lead-' + lead.from + '-' + Date.now() : 'lead-' + Date.now(),
      name: lead.name || lead.from || '',
      phone: lead.from || '',
      status: 'new',
      created_at: now,
      lastMessage: lead.lastMessage || ''
    };
    arr.push(newLead);
    fs.writeFileSync(leadsPath, JSON.stringify(arr, null, 2), 'utf8');
    console.log('postLeadToCRM: saved lead', newLead.phone);
    return { ok: true, savedTo: 'crm_leads.json', lead: newLead };
  } catch (err) {
    console.error('postLeadToCRM error', err && err.stack ? err.stack : err);
    throw err;
  }
};
// --- end assistant-added block ---
