module.exports = async function autoIngest(enriched) {
  try {
    // POST to local ingestion endpoint (reliable)
    await fetch('http://127.0.0.1:10000/crm/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(enriched)
    });
    console.log('AUTO-INGEST: posted to /crm/ingest for', enriched.from);
  } catch (e) {
    console.warn('AUTO-INGEST: posting to /crm/ingest failed', e && e.message ? e.message : e);
  }
};
