// crm_helpers.cjs — safe isolated CRM helper functions (CommonJS)
const fetch = (global.fetch) ? global.fetch : require('node-fetch');

const CRM_URL = process.env.CRM_URL || "http://127.0.0.1:10000";

async function postLeadToCRM(lead){
  try {
    await fetch(`${CRM_URL}/leads`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(lead)
    });
  } catch (e) {
    console.warn("CRM postLead failed", e && e.message ? e.message : e);
  }
}

async function fetchCRMReply({from,msgText}){
  try {
    const r = await fetch(`${CRM_URL}/prompt?text=${encodeURIComponent(msgText||"")}`);
    if(!r.ok) return null;
    const j = await r.json().catch(()=>({}));
    return j.reply || j.text || null;
  } catch(e){
    console.warn("CRM fetch failed", e && e.message ? e.message : e);
    return null;
  }
}

module.exports = { CRM_URL, postLeadToCRM, fetchCRMReply };
