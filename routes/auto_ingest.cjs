// routes/auto_ingest.cjs
// Central auto-ingest helper: called from webhook when a WhatsApp event arrives.
// - Normalises basic lead fields
// - Adds status, timestamp, leadType and enquiry
// - POSTs to /crm/ingest (local or via CRM_URL)

const fetch = (global.fetch) ? global.fetch : require('node-fetch');

module.exports = async function autoIngest(opts) {
  const DEBUG =
    process.env.DEBUG === 'true' ||
    process.env.DEBUG === '1' ||
    process.env.DEBUG_VARIANT === 'true';

  try {
    const nowIso = new Date().toISOString();

    const fromRaw = (opts && opts.from) ? String(opts.from) : '';
    const phone   = fromRaw.replace(/\D/g, '') || null;
    const name    = (opts && opts.name) || 'UNKNOWN';
    const lastMsg = (opts && opts.lastMessage ? String(opts.lastMessage) : '').trim();
    const meta    = (opts && opts.meta) || {};

    // --- Detect leadType from explicit meta or last message text ---
    let leadType = (meta.leadType || '').toLowerCase();

    if (!leadType && lastMsg) {
      const lm = lastMsg.toLowerCase();
      if (lm.includes('new car')) {
        leadType = 'new';
      } else if (lm.includes('used car') || lm.includes('pre-owned') || lm.includes('pre owned')) {
        leadType = 'used';
      } else if (lm.includes('loan') || lm.includes('emi') || lm.includes('finance')) {
        leadType = 'finance';
      } else if (lm.includes('sell') || lm.includes('sell my car')) {
        leadType = 'sell';
      }
    }

    // --- Build payload for /crm/ingest ---
    const payload = {
      // "id": if equal to phone, we'll hide duplicate in UI
      id: phone || undefined,
      name,
      phone,
      status: 'auto-ingested',
      timestamp: nowIso,

      // enquiry / purpose fields used by dashboard:
      leadType,                            // 'new' | 'used' | 'finance' | 'sell' | ''
      enquiry: lastMsg || undefined,       // last WhatsApp message text

      // generic meta:
      bot: opts.bot || 'MR.CAR',
      channel: opts.channel || 'whatsapp',
      meta
    };

    // --- Compute CRM base URL ---
    const portEnv = process.env.PORT || 10000;
    const rawBase =
      (process.env.CRM_URL && process.env.CRM_URL.trim()) ||
      `http://127.0.0.1:${portEnv}`;

    const url = `${rawBase.replace(/\/+$/, '')}/crm/ingest`;

    if (DEBUG) {
      console.log('AUTO-INGEST: POST', url, 'payload:', payload);
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.warn(
        'AUTO-INGEST: /crm/ingest non-OK',
        res.status,
        res.statusText,
        text
      );
    } else if (DEBUG) {
      const text = await res.text().catch(() => '');
      console.log('AUTO-INGEST: /crm/ingest OK', res.status, text);
    }
  } catch (err) {
    console.warn(
      'AUTO-INGEST: posting to /crm/ingest failed',
      err && err.message ? err.message : err
    );
  }
};

