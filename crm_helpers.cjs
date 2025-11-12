// crm_helpers.cjs
// Simple CRM helper used by server.cjs
// Exports: CRM_URL, postLeadToCRM(lead), fetchCRMReply({from,msgText})
// Designed to be resilient and log failures but not crash the webhook.

const fetch = (global.fetch) ? global.fetch : require('node-fetch');

const CRM_URL = (process.env.CRM_URL || 'http://127.0.0.1:10000').replace(/\/+$/, '');

async function postLeadToCRM(lead = {}) {
  // lead: { from, name, text, ts? }
  try {
    if (!CRM_URL) throw new Error('CRM_URL not configured');
    const url = `${CRM_URL}/leads`;
    const payload = Object.assign({ ts: Date.now() }, lead);
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      // small timeout not supported in node-fetch v2 easily; keep simple
    });
    if (!r) throw new Error('no-response-from-crm');
    const text = await r.text().catch(()=>null);
    if (!r.ok) {
      console.warn('CRM postLead failed', r.status, text && text.slice ? text.slice(0,1000) : text);
      return false;
    }
    if (process.env.DEBUG_VARIANT === 'true') console.log('CRM postLead ok', url, payload);
    return true;
  } catch (e) {
    console.warn('CRM postLead failed', e && e.message ? e.message : e);
    return false;
  }
}

async function fetchCRMReply({ from, msgText } = {}) {
  // Expect the CRM to have /prompt?text=... or POST /prompt
  try {
    if (!CRM_URL) throw new Error('CRM_URL not configured');
    const qs = encodeURIComponent(String(msgText || ''));
    const url = `${CRM_URL}/prompt?text=${qs}&from=${encodeURIComponent(String(from||''))}`;
    const r = await fetch(url, { method: 'GET', headers: { 'Accept': 'application/json' } });
    if (!r) {
      console.warn('CRM fetch failed - no response');
      return null;
    }
    const ctype = (r.headers && r.headers.get && r.headers.get('content-type')) || '';
    if (!r.ok) {
      const body = await r.text().catch(()=>null);
      console.warn('CRM fetch non-ok', r.status, body && body.slice ? body.slice(0,1000) : body);
      return null;
    }
    if (ctype.includes('application/json')) {
      const j = await r.json().catch(()=>null);
      if (!j) return null;
      // Accept either { reply: "text" } or plain string in { text } or { reply }
      if (typeof j === 'string') return j;
      if (j.reply) return String(j.reply);
      if (j.text) return String(j.text);
      // fallback to first string-like property
      for (const k of Object.keys(j)) {
        if (typeof j[k] === 'string') return j[k];
      }
      return null;
    } else {
      // plain text
      const txt = await r.text().catch(()=>null);
      if (!txt) return null;
      return String(txt).slice(0,4000);
    }
  } catch (e) {
    console.warn('fetchCRMReply failed', e && e.message ? e.message : e);
    return null;
  }
}

module.exports = { CRM_URL, postLeadToCRM, fetchCRMReply };

