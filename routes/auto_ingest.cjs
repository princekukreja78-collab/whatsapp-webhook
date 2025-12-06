// routes/auto_ingest.cjs
// Auto-ingest helper for MR.CAR → posts leads to CRM /crm/ingest

const fetch = (global.fetch) ? global.fetch : require('node-fetch');

module.exports = async function autoIngest(enriched = {}) {
  // Prefer CRM_URL from env (Render: ngrok URL; Local: optional override)
  // Fallback: local server at 127.0.0.1:PORT (default 10000)
  const portEnv = process.env.PORT || 10000;
  const baseEnv = (process.env.CRM_URL || '').trim();
  const baseUrl = (baseEnv || `http://127.0.0.1:${portEnv}`).replace(/\/+$/, '');

  const url = `${baseUrl}/crm/ingest`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(enriched)
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.warn(
        'AUTO-INGEST: /crm/ingest non-OK',
        res.status,
        res.statusText,
        text
      );
    } else {
      console.log('AUTO-INGEST: posted to', url, 'for', enriched.from || 'UNKNOWN');
    }
  } catch (e) {
    console.warn(
      'AUTO-INGEST: posting to',
      url,
      'failed',
      e && e.message ? e.message : e
    );
  }
};
