const fs = require('fs');
const path = require('path');

// crm_leads.json in project root (used by /crm/leads + dashboard)
const leadsFile = path.join(__dirname, '..', 'crm_leads.json');

function loadLeads() {
  try {
    if (!fs.existsSync(leadsFile)) return [];
    const txt = fs.readFileSync(leadsFile, 'utf8');
    if (!txt.trim()) return [];
    return JSON.parse(txt);
  } catch (err) {
    console.warn('crm_ingest: failed to read crm_leads.json:', err.message || err);
    return [];
  }
}

function saveLeads(leads) {
  try {
    fs.writeFileSync(leadsFile, JSON.stringify(leads, null, 2), 'utf8');
  } catch (err) {
    console.error('crm_ingest: failed to write crm_leads.json:', err.message || err);
  }
}

module.exports = async (req, res) => {
  try {
    const body = req.body || {};

    const nowIso = new Date().toISOString();
    const nowTs  = Date.now();

    const id =
      body.ID ||
      body.id ||
      body.phone ||
      body.from ||
      `L${nowTs}`;

    const phone =
      body.Phone ||
      body.phone ||
      body.from ||
      '';

    const firstText =
      body.text ||
      (body.raw && (body.raw.text || body.raw.message || body.raw.body)) ||
      body.message ||
      '';

    const name =
      body.Name ||
      body.name ||
      body.contact_name ||
      'UNKNOWN';

    const status =
      body.Status ||
      body.status ||
      'auto-ingested';

    const tsIso =
      body.Timestamp ||
      body.timestamp ||
      body.ts ||
      nowIso;

    // Normalized lead shape for dashboard + sheet
    const lead = {
      // Sheet / CONTACT SHEET headers (UPPER)
      ID: id,
      Name: name,
      Phone: phone,
      Status: status,
      Timestamp: tsIso,
      'Car Enquired':
        body['Car Enquired'] ||
        body.carEnquired ||
        firstText,
      Budget: body.Budget || body.budget || '',
      'Last AI Reply': body['Last AI Reply'] || body.lastAiReply || body.last_ai_reply || '',
      'AI Quote': body['AI Quote'] || body.aiQuote || body.ai_quote || '',
      'Lead Type':
        body['Lead Type'] ||
        body.leadType ||
        body.lead_type ||
        (firstText ? 'whatsapp_query' : 'auto-ingested'),

      // Dashboard JS (lowercase / snake-case) compatibility
      id,
      name,
      phone,
      status,
      timestamp: tsIso,
      ts: nowTs,

      // keep raw payload for debugging
      raw: body,
    };

    const leads = loadLeads();
    leads.push(lead);
    saveLeads(leads);

    console.log('CRM /crm/ingest saved lead (dashboard compatible):', {
      ID: lead.ID,
      Phone: lead.Phone,
      Name: lead.Name,
      Status: lead.Status,
      CarEnquired: lead['Car Enquired'],
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
