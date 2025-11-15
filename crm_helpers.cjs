// crm_helpers.cjs — mini CRM integration for MR.CAR
// Local storage only. No ngrok, no external API required.

const fs = require('fs');
const path = require('path');

const CRM_LEADS_FILE = path.resolve(__dirname, 'crm_leads_master.json');

// ------------ JSON HELPERS --------------
function safeReadJson(file) {
  try {
    if (!fs.existsSync(file)) return [];
    const txt = fs.readFileSync(file, 'utf8') || '[]';
    const j = JSON.parse(txt);
    if (Array.isArray(j)) return j;
    if (Array.isArray(j.leads)) return j.leads;
    return [];
  } catch (e) {
    console.warn("CRM Json read failed:", e.message);
    return [];
  }
}

function safeWriteJson(file, obj) {
  try {
    fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
  } catch (e) {
    console.warn("CRM Json write failed:", e.message);
  }
}

// ------------- MAIN FUNCTIONS -------------

// Save lead locally
async function postLeadToCRM(lead) {
  try {
    const all = safeReadJson(CRM_LEADS_FILE);
    all.unshift({ ...lead, ts: Date.now() });
    safeWriteJson(CRM_LEADS_FILE, all.slice(0, 5000));    // keep latest 5000
  } catch (e) {
    console.warn("postLeadToCRM error:", e.message);
  }
}

// No external CRM reply for now
async function fetchCRMReply({ from, msgText }) {
  return null;
}

module.exports = {
  postLeadToCRM,
  fetchCRMReply
};

