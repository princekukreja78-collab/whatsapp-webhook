const fs = require("fs");
const path = require("path");
const express = require("express");
const router = express.Router();

const LEADS_FILE = path.join(__dirname, "..", "crm_leads.json");

// -------- Optional CRM core (crm_helpers.cjs) --------
let getAllLeadsFn = null;
try {
  const crm = require("../crm_helpers.cjs");
  if (crm && typeof crm.getAllLeads === "function") {
    getAllLeadsFn = crm.getAllLeads;
    console.log("routes/leads.cjs: using crm_helpers.getAllLeads() for /api/leads");
  }
} catch (e) {
  console.warn(
    "routes/leads.cjs: crm_helpers.cjs not available, falling back to local file only.",
    e && e.message ? e.message : e
  );
}

// -------- Local file helpers (fallback) --------
function loadLeadsFromFile() {
  try {
    if (!fs.existsSync(LEADS_FILE)) return [];
    const raw = fs.readFileSync(LEADS_FILE, "utf8") || "[]";
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.leads)) return parsed.leads;
    return [];
  } catch (e) {
    console.error("loadLeadsFromFile error", e && e.message ? e.message : e);
    return [];
  }
}

function saveLeadsToFile(list) {
  try {
    fs.writeFileSync(LEADS_FILE, JSON.stringify(list || [], null, 2), "utf8");
    return true;
  } catch (e) {
    console.error("saveLeadsToFile error", e && e.message ? e.message : e);
    return false;
  }
}

// Normalize a raw lead into a consistent shape for the dashboard
function normalizeLead(raw) {
  if (!raw || typeof raw !== "object") return null;

  const get = (...keys) => {
    for (const k of keys) {
      if (raw[k] !== undefined && raw[k] !== null && String(raw[k]).trim() !== "") {
        return raw[k];
      }
    }
    return "";
  };

  const ID        = get("ID", "Id", "id", "LeadID", "leadId", "from", "Phone", "phone");
  const Name      = get("Name", "name", "CustomerName", "customer_name");
  const Phone     = get("Phone", "phone", "from", "Mobile", "mobile");
  const Status    = get("Status", "status");
  const Purpose   = get("Purpose", "purpose", "service");
  const lastMsg   = get("lastMessage", "LastMessage", "last_message", "text");
  const LeadType  = get("LeadType", "leadType", "lead_type", "Source", "source");
  const Timestamp = get("Timestamp", "timestamp", "CreatedAt", "createdAt", "ts");

  return {
    ID,
    Name,
    Phone,
    Status,
    Purpose,
    lastMessage: lastMsg,
    LeadType,
    Timestamp
  };
}

// Load canonical leads: prefer CRM core, else fall back to file
async function loadCanonicalLeads() {
  // 1) Try central CRM helper
  if (getAllLeadsFn) {
    try {
      const arr = await getAllLeadsFn();
      if (Array.isArray(arr) && arr.length) {
        return arr
          .map(normalizeLead)
          .filter(Boolean);
      }
    } catch (e) {
      console.warn(
        "routes/leads.cjs: getAllLeads() failed, falling back to local file.",
        e && e.message ? e.message : e
      );
    }
  }

  // 2) Fallback: local file (crm_leads.json)
  const fileLeads = loadLeadsFromFile();
  return fileLeads
    .map(normalizeLead)
    .filter(Boolean);
}

// -------- GET /api/leads  (main API for dashboard) --------
router.get("/", async (req, res) => {
  try {
    const leads = await loadCanonicalLeads();
    return res.json({ ok: true, leads });
  } catch (e) {
    console.error("/api/leads main route error", e && e.message ? e.message : e);
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

// -------- GET: Download Leads as CSV --------
router.get("/export", async (req, res) => {
  try {
    const leads = await loadCanonicalLeads();

    const header = "ID,Name,Phone,Status,Purpose,Timestamp,LastMessage,LeadType\n";
    const rows = leads
      .map((l) =>
        [
          l.ID || "",
          l.Name || "",
          l.Phone || "",
          l.Status || "",
          l.Purpose || "",
          l.Timestamp || "",
          (l.lastMessage || "").replace(/\r?\n/g, " "),
          l.LeadType || ""
        ].join(",")
      )
      .join("\n");

    res.setHeader("Content-Type", "text/csv");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="mr_car_leads_${Date.now()}.csv"`
    );

    return res.send(header + rows);
  } catch (e) {
    console.error("/api/leads/export error", e && e.message ? e.message : e);
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

// -------- POST: Import Leads (CSV Upload -> local file) --------
router.post("/import", express.raw({ type: "text/csv" }), (req, res) => {
  try {
    const csv = req.body.toString("utf8");
    const lines = csv.split("\n").filter((x) => x.trim());
    const leads = loadLeadsFromFile();

    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(",");
      leads.push({
        id: Date.now() + "_" + i,
        name: cols[0]?.trim(),
        phone: cols[1]?.trim(),
        city: cols[2]?.trim(),
        status: cols[3]?.trim() || "new",
        createdAt: new Date().toISOString()
      });
    }

    saveLeadsToFile(leads);
    return res.json({ ok: true, imported: lines.length - 1 });
  } catch (e) {
    console.error("import error", e && e.message ? e.message : e);
    return res.status(500).json({ ok: false });
  }
});

module.exports = router;
