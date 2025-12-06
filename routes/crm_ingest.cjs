const fs = require('fs');
const path = require('path');

/**
 * CRM ingest handler.
 * - Accepts JSON body from auto_ingest / webhook.
 * - Enriches with id + timestamp.
 * - Appends to data/crm_leads.json.
 * - Responds with { ok: true, lead }.
 *
 * This is self-contained and does NOT touch your new/used car quote logic.
 */

const dataDir   = path.join(__dirname, '..', 'data');
const leadsFile = path.join(dataDir, 'crm_leads.json');

function loadLeads() {
  try {
    if (!fs.existsSync(leadsFile)) return [];
    const txt = fs.readFileSync(leadsFile, 'utf8');
    if (!txt.trim()) return [];
    return JSON.parse(txt);
  } catch (err) {
    console.warn('crm_ingest: failed to read leads file:', err.message || err);
    return [];
  }
}

function saveLeads(leads) {
  try {
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(leadsFile, JSON.stringify(leads, null, 2), 'utf8');
  } catch (err) {
    console.error('crm_ingest: failed to write leads file:', err.message || err);
  }
}

module.exports = async (req, res) => {
  try {
    const body = req.body || {};

    const nowIso = new Date().toISOString();
    const id = body.id || body.phone || body.from || `L${Date.now()}`;

    const lead = {
      id,
      name: body.name || body.contact_name || 'UNKNOWN',
      phone: body.phone || body.from || '',
      status: body.status || 'auto-ingested',
      source: body.source || 'whatsapp',
      timestamp: nowIso,
      raw: body,
    };

    const leads = loadLeads();
    leads.push(lead);
    saveLeads(leads);

    console.log('CRM /crm/ingest saved lead:', {
      id: lead.id,
      phone: lead.phone,
      name: lead.name,
      status: lead.status,
    });

    return res.json({ ok: true, lead });
  } catch (err) {
    console.error('CRM /crm/ingest handler error:', err && err.message ? err.message : err);
    return res.status(500).json({
      ok: false,
      error: err.message || String(err),
    });
  }
};
