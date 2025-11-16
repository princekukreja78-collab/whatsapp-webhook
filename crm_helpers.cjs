// crm_helpers.cjs — mini multi-bot CRM for MR.CAR / Signature / Property / Loan
// Local JSON storage, safe on Render & local.

const fs = require('fs');
const path = require('path');

const CRM_LEADS_FILE = path.resolve(__dirname, 'crm_leads_master.json');

// ---------- JSON helpers ----------
function safeReadJson(file) {
  try {
    if (!fs.existsSync(file)) return [];
    const txt = fs.readFileSync(file, 'utf8') || '[]';
    const j = JSON.parse(txt);
    if (Array.isArray(j)) return j;
    if (Array.isArray(j.leads)) return j.leads;
    return [];
  } catch (e) {
    console.warn('CRM Json read failed:', e && e.message ? e.message : e);
    return [];
  }
}

function safeWriteJson(file, obj) {
  try {
    fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
  } catch (e) {
    console.warn('CRM Json write failed:', e && e.message ? e.message : e);
  }
}

// ---------- main functions ----------

// lead structure:
// {
//   bot, channel, from, name, lastMessage, service, tags[], meta{}, createdAt, updatedAt
// }
async function postLeadToCRM(lead) {
  try {
    const all = safeReadJson(CRM_LEADS_FILE);
    const nowIso = new Date().toISOString();

    const cleanLead = {
      id: lead.id || `${lead.bot || 'UNKNOWN'}_${lead.from || 'NA'}_${Date.now()}`,
      bot: lead.bot || 'UNKNOWN',
      channel: lead.channel || 'whatsapp',
      from: lead.from || '',
      name: (lead.name || '').toString(),
      lastMessage: (lead.lastMessage || lead.text || '').toString(),
      service: lead.service || null,
      tags: Array.isArray(lead.tags) ? lead.tags : [],
      createdAt: lead.createdAt || nowIso,
      updatedAt: nowIso,
      meta: lead.meta || {}
    };

    all.unshift(cleanLead);
    safeWriteJson(CRM_LEADS_FILE, all.slice(0, 10000)); // keep last 10k
  } catch (e) {
    console.warn('postLeadToCRM error:', e && e.message ? e.message : e);
  }
}

async function getAllLeads(limit = 100) {
  const all = safeReadJson(CRM_LEADS_FILE);
  const n = Math.max(1, Math.min(500, Number(limit) || 100));
  return all.slice(0, n);
}

// For now no AI reply from CRM
async function fetchCRMReply({ from, msgText }) {
  return null;
}

module.exports = {
  postLeadToCRM,
  getAllLeads,
  fetchCRMReply
};

