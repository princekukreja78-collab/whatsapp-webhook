// routes/sheets.cjs
const express = require("express");
const { google } = require("googleapis");
const fs = require("fs");
const path = require("path");

const router = express.Router();

// Load JSON key
const CREDENTIALS_PATH = path.join(__dirname, "..", ".credentials", "service-account.json");
const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf8"));

const SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive"
];

function getAuth() {
  return new google.auth.GoogleAuth({
    credentials,
    scopes: SCOPES
  });
}

// POST → Import sheet → return rows
router.post("/import", async (req, res) => {
  try {
    const body = req.body || {};
    const spreadsheetId = body.spreadsheetId || process.env.GOOGLE_SHEET_ID;
    if (!spreadsheetId) {
      return res.status(400).json({ ok: false, error: "spreadsheetId required (pass in JSON or set GOOGLE_SHEET_ID in .env)" });
    }
    const range = body.range || "Sheet1!A1:Z1000";

    const auth = await getAuth();
    const sheets = google.sheets({ version: "v4", auth });

    const result = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range
    });

    return res.json({
      ok: true,
      rows: result.data.values || []
    });
  } catch (e) {
    console.error("Sheet import error:", e && e.stack ? e.stack : e);
    return res.status(500).json({ ok: false, error: String(e && e.message ? e.message : e) });
  }
});

// POST → Export current leads.json → push to sheet (append mode, robust + debug logging)
router.post("/export", async (req, res) => {
  try {
    const body = req.body || {};
    console.log('DEBUG /api/sheets/export body=', JSON.stringify(body));

    const spreadsheetId = body.spreadsheetId || process.env.GOOGLE_SHEET_ID;
    if (!spreadsheetId) {
      return res.status(400).json({ ok: false, error: "spreadsheetId required (body.spreadsheetId or GOOGLE_SHEET_ID)" });
    }

    // Accept caller-provided range (sheet name or full A1 notation) but normalize.
    let range = (body.range || process.env.GOOGLE_SHEET_RANGE || "'Sheet 1'!A1:Z").toString().trim();
    console.log("DEBUG /api/sheets/export raw range=", JSON.stringify(body.range), "resolved range(before normalize)=", range);

    // If caller passed just a sheet name without '!' assume they meant the whole sheet:
    if (range && !range.includes("!")) {
      const maybeQuoted = /^'.*'$/.test(range) ? range : (/\s/.test(range) ? `'${range.replace(/^'+|'+$/g, "")}'` : range);
      range = `${maybeQuoted}!A1:Z`;
      console.log("DEBUG /api/sheets/export auto-normalized sheet-name-only to range=", range);
    }

    const leadsPath = path.join(__dirname, "..", "crm_leads.json");
    if (!fs.existsSync(leadsPath)) {
      fs.writeFileSync(leadsPath, JSON.stringify([], null, 2), "utf8");
    }
    const leadsRaw = fs.readFileSync(leadsPath, "utf8");
    const leads = (() => {
      try { return JSON.parse(leadsRaw || "[]"); } catch(e) {
        console.error("ERROR parsing leads file, using empty array", e);
        return [];
      }
    })();

    const rows = [
      ["ID", "Name", "Phone", "Status", "Timestamp"],
      ...Array.isArray(leads) ? leads.map(l => [
        l.id || l.lead_id || "",
        l.name || "",
        l.phone || "",
        l.status || "",
        l.created_at || l.ts || ""
      ]) : []
    ];

    // If nothing to append, return early
    if (rows.length <= 1) {
      return res.json({ ok: true, exported: 0, message: "no leads to export" });
    }

    const auth = await getAuth();
    const sheets = google.sheets({ version: "v4", auth });

    // --- build prioritized range and discover sheet title ---
    const endRow = rows.length; // header + data rows (used only for diagnostics)
    const colRange = "A1:Z"; // columns we intend to write
    const r = range;

    // Try to discover the actual sheet title from spreadsheet metadata (sanitized)
    let discoveredSheetNameOnly = null;
    try {
      const meta = await sheets.spreadsheets.get({
        spreadsheetId,
        fields: "sheets.properties.title"
      });

      const props = Array.isArray(meta.data.sheets) ? meta.data.sheets.map(s => s.properties) : [];
      const providedName = r && r.includes("!") ? r.split("!")[0].replace(/^'+|'+$/g, "") : (r || "").replace(/^'+|'+$/g, "");

      // exact match
      let matched = props.find(p => p && p.title === providedName);

      // case-insensitive fallback
      if (!matched) {
        matched = props.find(p => p && p.title && p.title.toLowerCase() === (providedName || "").toLowerCase());
      }

      // final fallback: first sheet
      if (!matched) matched = props[0];

      const rawTitle = (matched && matched.title) ? matched.title.toString() : null;
      const leftBeforeBang = rawTitle ? rawTitle.split("!")[0] : rawTitle;
      const cleanTitle = leftBeforeBang ? leftBeforeBang.replace(/^'+|'+$/g, "").trim() : null;

      if (cleanTitle) {
        discoveredSheetNameOnly = cleanTitle; // store raw name without quotes
        console.log("DEBUG /api/sheets/export discovered sheet name:", discoveredSheetNameOnly);
      } else {
        discoveredSheetNameOnly = null;
        console.warn("WARN /api/sheets/export: could not determine a valid sheet title from metadata");
      }
    } catch (eMeta) {
      console.warn("WARN /api/sheets/export could not get sheet metadata:", eMeta && eMeta.message ? eMeta.message : eMeta);
      discoveredSheetNameOnly = null;
    }

    // choose final safe sheet name (raw, no quotes); prefer discovered, else derive from r
    const sheetNameOnly = discoveredSheetNameOnly || (r.split("!")[0].replace(/^'+|'+$/g, "").trim());
    const safeSheetName = /\s/.test(sheetNameOnly) ? `'${sheetNameOnly}'` : sheetNameOnly;

    console.log("DEBUG /api/sheets/export using safeSheetName:", safeSheetName);

    // --- APPEND MODE: use only the sheet name (no A1:Z) so API appends to the sheet end reliably ---
    const appendRange = safeSheetName; // pass just the sheet name (e.g. 'Sheet 1')

    // perform append (skip header row)
    const appendRes = await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: appendRange,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: rows.slice(1) }
    });

    console.log("DEBUG /api/sheets/export append response:", appendRes.data && appendRes.data.updates && appendRes.data.updates.updatedRange);

    return res.json({
      ok: true,
      exported: rows.length - 1,
      usedRange: appendRange,
      updatedRange: appendRes.data && appendRes.data.updates && appendRes.data.updates.updatedRange
    });
  } catch (e) {
    console.error("ERROR /api/sheets/export failed:", e && e.message ? e.message : e);
    return res.status(500).json({ ok: false, error: "export_failed", message: (e && e.message) ? e.message : String(e) });
  }
}); // closes router.post

// keep router export at end of file
module.exports = router;

/**
 * POST /api/sheets/sync
 * Imports Google Sheet rows and writes crm_leads.json
 */
router.post("/sync", async (req, res) => {
  try {
    const body = req.body || {};
    const spreadsheetId = body.spreadsheetId || process.env.GOOGLE_SHEET_ID;
    const range = body.range || process.env.GOOGLE_SHEET_RANGE || "Sheet1!A1:Z1000";

    if (!spreadsheetId) {
      return res.status(400).json({ ok: false, error: "spreadsheetId required" });
    }

    const auth = await getAuth();
    const sheets = google.sheets({ version: "v4", auth });

    const result = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range
    });

    const rows = result.data.values || [];

    // Parse rows assuming header: ID | Name | Phone | Status | Timestamp
    const parsed = [];
    const header = rows[0] || [];

    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      if (!r || r.length === 0) continue;
      parsed.push({
        id: r[0] || "",
        name: r[1] || "",
        phone: r[2] || "",
        status: r[3] || "",
        created_at: r[4] || ""
      });
    }

    const leadsPath = require("path").join(__dirname, "..", "crm_leads.json");
    require("fs").writeFileSync(leadsPath, JSON.stringify(parsed, null, 2), "utf8");

    return res.json({ ok: true, imported: parsed.length });
  } catch (e) {
    console.error("ERROR /api/sheets/sync:", e);
    return res.status(500).json({
      ok: false,
      error: "sync_failed",
      message: e && e.message ? e.message : String(e)
    });
  }
});
