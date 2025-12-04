const fs = require("fs");
const path = require("path");
const express = require("express");
const router = express.Router();

const LEADS_FILE = path.join(__dirname, "..", "crm_leads.json");

// -------- Helpers --------
function loadLeads() {
  try {
    if (!fs.existsSync(LEADS_FILE)) return [];
    const raw = fs.readFileSync(LEADS_FILE, "utf8") || "[]";
    return JSON.parse(raw);
  } catch (e) {
    console.error("loadLeads error", e);
    return [];
  }
}

function saveLeads(list) {
  try {
    fs.writeFileSync(LEADS_FILE, JSON.stringify(list, null, 2), "utf8");
    return true;
  } catch (e) {
    console.error("saveLeads error", e);
    return false;
  }
}

function findLeadById(id) {
  return loadLeads().find((x) => x.id === id) || null;
}

// -------- GET: Download Leads as CSV --------
router.get("/export", (req, res) => {
  const leads = loadLeads();

  const header = "id,name,phone,city,status,createdAt\n";
  const rows = leads
    .map(
      (l) =>
        `${l.id},${l.name || ""},${l.phone || ""},${l.city || ""},${l.status || ""},${l.createdAt || ""}`
    )
    .join("\n");

  res.setHeader("Content-Type", "text/csv");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="mr_car_leads_${Date.now()}.csv"`
  );

  return res.send(header + rows);
});

// -------- POST: Import Leads (CSV Upload) --------
router.post("/import", express.raw({ type: "text/csv" }), (req, res) => {
  try {
    const csv = req.body.toString("utf8");
    const lines = csv.split("\n").filter((x) => x.trim());
    const leads = loadLeads();

    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(",");
      leads.push({
        id: Date.now() + "_" + i,
        name: cols[0]?.trim(),
        phone: cols[1]?.trim(),
        city: cols[2]?.trim(),
        status: cols[3]?.trim() || "new",
        createdAt: new Date().toISOString(),
      });
    }

    saveLeads(leads);
    return res.json({ ok: true, imported: lines.length - 1 });
  } catch (e) {
    console.error("import error", e);
    return res.status(500).json({ ok: false });
  }
});

module.exports = router;

