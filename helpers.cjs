/* helpers.cjs — safe fallback helpers to prevent runtime crashes */
const fs = require('fs');
const path = require('path');

async function waSendRaw(payload) {
  try {
    const META_TOKEN = (process.env.META_TOKEN || process.env.WA_TOKEN || '').trim();
    const PHONE_NUMBER_ID = (process.env.PHONE_NUMBER_ID || '').trim();
    if (META_TOKEN && PHONE_NUMBER_ID && typeof fetch === 'function') {
      const url = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`;
      const r = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${META_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const j = await r.json().catch(()=>null);
      if (!r.ok) console.warn('waSendRaw HTTP error', r.status, j);
      return j;
    }
    console.log('waSendRaw (fallback) →', JSON.stringify(payload).slice(0,800));
    return null;
  } catch (e) {
    console.warn('waSendRaw fallback failed', e && e.message ? e.message : e);
    return null;
  }
}

function getLastService(from) {
  try {
    if (typeof global.sessionService !== 'undefined' && global.sessionService && typeof global.sessionService.get === 'function') {
      return global.sessionService.get(from)?.svc || null;
    }
  } catch (e) {}
  return null;
}

/* safeJsonRead: synchronous safe read returning object or default */
function safeJsonRead(filename) {
  try {
    if (!filename) return {};
    if (!fs.existsSync(filename)) return {};
    const txt = fs.readFileSync(filename, 'utf8') || '';
    return txt ? JSON.parse(txt) : {};
  } catch (e) {
    console.warn('safeJsonRead failed', e && e.message ? e.message : e);
    return {};
  }
}

/* logConversationToCRM: async so callers can use .catch() */
async function logConversationToCRM(conv) {
  try {
    const LOG = path.join(__dirname, 'conversations.log.json');
    const line = JSON.stringify(conv) + '\n';
    fs.appendFileSync(LOG, line, 'utf8');
    return true;
  } catch (e) {
    console.warn('logConversationToCRM failed', e && e.message ? e.message : e);
    // keep promise rejection so callers can catch if they want
    throw e;
  }
}

/* sendAdminAlert: simple, non-blocking admin alert */
async function sendAdminAlert({ from, name, text }) {
  try {
    if (!process.env.ADMIN_WA) return;
    const body = `🔔 ADMIN ALERT\nFrom: ${from}\nName: ${name || '-'}\nMsg: ${(text||'').slice(0,500)}`;
    await waSendRaw({ messaging_product: 'whatsapp', to: process.env.ADMIN_WA, type: 'text', text: { body } });
    console.log('Admin alert sent ->', process.env.ADMIN_WA);
  } catch (e) {
    console.warn('sendAdminAlert failed', e && e.message ? e.message : e);
  }
}

module.exports = { waSendRaw, getLastService, safeJsonRead, logConversationToCRM, sendAdminAlert };
