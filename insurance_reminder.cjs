// insurance_reminder.cjs — Insurance Renewal Reminder System
// Reads Google Sheet, sends WhatsApp reminders to customer + admin for expiring policies

const fs = require("fs");
const path = require("path");
const { waSendRaw } = require("./helpers.cjs");
const { getSheetsClient } = require("./google_auth.cjs");

// ── Config ──────────────────────────────────────────────────
const ADMIN_WA = process.env.ADMIN_WA || "919090404909";
const INSURANCE_SHEET_ID = process.env.INSURANCE_SHEET_ID || "";
const INSURANCE_SHEET_RANGE = "InsuranceRenewals!A2:L"; // skip header row

// Reminder windows (days before expiry)
const REMINDER_WINDOWS = [30, 15, 7, 3, 1, 0];

// Column indices (0-based, matching Google Sheet layout)
const COL = {
  NAME: 0,       // A — Customer Name
  PHONE: 1,      // B — Phone (with country code, e.g. 919090404909)
  CAR_MODEL: 2,  // C — Car Model
  REG_NO: 3,     // D — Registration Number
  POLICY_NO: 4,  // E — Policy Number
  INSURER: 5,    // F — Insurance Company
  EXPIRY: 6,     // G — Policy Expiry Date (DD/MM/YYYY or YYYY-MM-DD)
  STATUS: 7,     // H — Status (active / renewed / expired / reminded_30d etc.)
  LAST_REMINDER: 8, // I — Last Reminder Date
  REMINDER_NOTE: 9, // J — Reminder Note (auto-filled)
  PREMIUM: 10,   // K — Premium Amount (optional)
  CHASSIS_NO: 11 // L — Chassis/VIN Number (for new cars without reg no)
};

// ── Date Helpers ────────────────────────────────────────────
function parseExpiryDate(dateStr) {
  if (!dateStr) return null;
  const s = String(dateStr).trim();

  // DD/MM/YYYY
  const ddmm = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (ddmm) return new Date(+ddmm[3], +ddmm[2] - 1, +ddmm[1]);

  // YYYY-MM-DD
  const iso = s.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
  if (iso) return new Date(+iso[1], +iso[2] - 1, +iso[3]);

  // Try native parse as last resort
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function daysUntil(expiryDate) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const exp = new Date(expiryDate);
  exp.setHours(0, 0, 0, 0);
  return Math.round((exp - today) / (1000 * 60 * 60 * 24));
}

function todayStr() {
  const d = new Date();
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
}

function formatDate(d) {
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
}

// ── WhatsApp Message Templates ──────────────────────────────
function customerReminderMsg(row, daysLeft) {
  const name = row[COL.NAME] || "Customer";
  const car = row[COL.CAR_MODEL] || "your car";
  const regNo = row[COL.REG_NO] || "";
  const insurer = row[COL.INSURER] || "";
  const expiry = row[COL.EXPIRY] || "";
  const policyNo = row[COL.POLICY_NO] || "";
  const premium = row[COL.PREMIUM] || "";

  if (daysLeft <= 0) {
    return `🚨 *Insurance EXPIRED* 🚨\n\nDear ${name},\n\nYour car insurance has *expired*!\n\n🚗 Car: ${car}${regNo ? ` (${regNo})` : ""}\n📋 Policy: ${policyNo}\n🏢 Insurer: ${insurer}\n📅 Expired: ${expiry}\n\n⚠️ Driving without insurance is illegal and risky. Please renew immediately.\n\n📞 Contact Mr. Car for best renewal rates!\nWhatsApp: wa.me/${process.env.SALES_WHATSAPP_NUMBER || ADMIN_WA}`;
  }

  let urgency = "";
  if (daysLeft <= 3) urgency = "🚨 *URGENT* — ";
  else if (daysLeft <= 7) urgency = "⚠️ *Important* — ";
  else urgency = "🔔 *Reminder* — ";

  return `${urgency}Insurance Renewal\n\nDear ${name},\n\nYour car insurance is expiring in *${daysLeft} day${daysLeft > 1 ? "s" : ""}*!\n\n🚗 Car: ${car}${regNo ? ` (${regNo})` : ""}\n📋 Policy: ${policyNo}\n🏢 Insurer: ${insurer}\n📅 Expiry: ${expiry}${premium ? `\n💰 Premium: ₹${premium}` : ""}\n\n✅ Renew early to avoid:\n• Lapse in coverage\n• Higher premium on renewal\n• Legal penalties\n\n📞 Contact Mr. Car for the best renewal quotes!\nWhatsApp: wa.me/${process.env.SALES_WHATSAPP_NUMBER || ADMIN_WA}`;
}

function adminSummaryMsg(reminders) {
  if (!reminders.length) return null;

  let msg = `📋 *Insurance Renewal Report* — ${todayStr()}\n\n`;
  msg += `Total policies due: *${reminders.length}*\n\n`;

  // Group by urgency
  const expired = reminders.filter(r => r.daysLeft <= 0);
  const urgent = reminders.filter(r => r.daysLeft > 0 && r.daysLeft <= 3);
  const soon = reminders.filter(r => r.daysLeft > 3 && r.daysLeft <= 7);
  const upcoming = reminders.filter(r => r.daysLeft > 7);

  if (expired.length) {
    msg += `🚨 *EXPIRED (${expired.length}):*\n`;
    expired.forEach(r => { msg += `• ${r.name} — ${r.car} (${r.regNo}) — Expired ${r.expiry}\n`; });
    msg += "\n";
  }
  if (urgent.length) {
    msg += `⚠️ *1-3 Days (${urgent.length}):*\n`;
    urgent.forEach(r => { msg += `• ${r.name} — ${r.car} — ${r.daysLeft}d left\n`; });
    msg += "\n";
  }
  if (soon.length) {
    msg += `🔔 *4-7 Days (${soon.length}):*\n`;
    soon.forEach(r => { msg += `• ${r.name} — ${r.car} — ${r.daysLeft}d left\n`; });
    msg += "\n";
  }
  if (upcoming.length) {
    msg += `📅 *8-30 Days (${upcoming.length}):*\n`;
    upcoming.forEach(r => { msg += `• ${r.name} — ${r.car} — ${r.daysLeft}d left\n`; });
  }

  return msg;
}

// ── Core: Check & Send Reminders ────────────────────────────
async function checkAndSendReminders(opts = {}) {
  const sheetId = opts.sheetId || INSURANCE_SHEET_ID;
  if (!sheetId) {
    console.error("❌ INSURANCE_SHEET_ID not set. Set it in .env or pass to checkAndSendReminders()");
    return { ok: false, error: "INSURANCE_SHEET_ID not configured" };
  }

  const dryRun = opts.dryRun || false;
  const sheets = await getSheetsClient();

  // 1. Read all rows
  const result = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: INSURANCE_SHEET_RANGE
  });

  const rows = result.data.values || [];
  if (!rows.length) {
    console.log("ℹ️ No insurance records found in sheet.");
    return { ok: true, total: 0, reminded: 0 };
  }

  console.log(`📋 Found ${rows.length} insurance records`);

  const remindersToSend = [];
  const sheetUpdates = []; // { rowIndex, col, value }

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const phone = String(row[COL.PHONE] || "").replace(/[^0-9]/g, "");
    const expiry = parseExpiryDate(row[COL.EXPIRY]);
    const status = String(row[COL.STATUS] || "").toLowerCase().trim();

    // Skip renewed/cancelled
    if (["renewed", "cancelled", "canceled"].includes(status)) continue;
    if (!expiry) continue;
    if (!phone || phone.length < 10) continue;

    const daysLeft = daysUntil(expiry);

    // Only send for policies within our reminder windows
    const matchedWindow = REMINDER_WINDOWS.find(w => daysLeft <= w);
    if (matchedWindow === undefined) continue; // More than 30 days out

    // Check if we already reminded today
    const lastReminder = String(row[COL.LAST_REMINDER] || "").trim();
    if (lastReminder === todayStr()) continue; // Already reminded today

    // Check status to avoid double reminders at same window
    const currentStatusTag = `reminded_${matchedWindow}d`;
    if (status === currentStatusTag) continue;

    remindersToSend.push({
      rowIndex: i + 2, // +2 because row 1 is header, sheets is 1-indexed
      phone,
      name: row[COL.NAME] || "Customer",
      car: row[COL.CAR_MODEL] || "",
      regNo: row[COL.REG_NO] || "",
      expiry: row[COL.EXPIRY] || "",
      daysLeft,
      window: matchedWindow,
      row
    });
  }

  console.log(`📬 ${remindersToSend.length} reminders to send`);

  if (!remindersToSend.length) {
    return { ok: true, total: rows.length, reminded: 0 };
  }

  // 2. Send customer reminders
  let sentCount = 0;
  for (const r of remindersToSend) {
    const msg = customerReminderMsg(r.row, r.daysLeft);

    if (dryRun) {
      console.log(`[DRY RUN] Would send to ${r.phone}: ${msg.slice(0, 100)}...`);
    } else {
      try {
        await waSendRaw({
          messaging_product: "whatsapp",
          to: r.phone,
          type: "text",
          text: { body: msg }
        });
        console.log(`✅ Reminder sent → ${r.name} (${r.phone}) — ${r.daysLeft}d left`);
        sentCount++;
      } catch (e) {
        console.warn(`❌ Failed to send to ${r.phone}:`, e?.message || e);
      }
    }

    // Queue sheet update
    sheetUpdates.push(
      { range: `InsuranceRenewals!H${r.rowIndex}`, value: r.daysLeft <= 0 ? "expired" : `reminded_${r.window}d` },
      { range: `InsuranceRenewals!I${r.rowIndex}`, value: todayStr() },
      { range: `InsuranceRenewals!J${r.rowIndex}`, value: `Auto-reminder: ${r.daysLeft}d before expiry` }
    );
  }

  // 3. Send admin summary
  const adminMsg = adminSummaryMsg(remindersToSend);
  if (adminMsg) {
    if (dryRun) {
      console.log(`[DRY RUN] Would send admin summary to ${ADMIN_WA}`);
    } else {
      try {
        await waSendRaw({
          messaging_product: "whatsapp",
          to: ADMIN_WA,
          type: "text",
          text: { body: adminMsg }
        });
        console.log(`✅ Admin summary sent → ${ADMIN_WA}`);
      } catch (e) {
        console.warn("❌ Admin summary failed:", e?.message || e);
      }
    }
  }

  // 4. Batch update sheet (status, last reminder date, note)
  if (!dryRun && sheetUpdates.length) {
    try {
      const data = sheetUpdates.map(u => ({
        range: u.range,
        values: [[u.value]]
      }));

      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: sheetId,
        requestBody: {
          valueInputOption: "USER_ENTERED",
          data
        }
      });
      console.log(`📝 Sheet updated: ${sheetUpdates.length} cells`);
    } catch (e) {
      console.warn("❌ Sheet update failed:", e?.message || e);
    }
  }

  return { ok: true, total: rows.length, reminded: sentCount, pending: remindersToSend.length };
}

// ── Create Sheet Template (one-time setup) ──────────────────
async function createInsuranceSheet(spreadsheetId) {
  const sheetId = spreadsheetId || INSURANCE_SHEET_ID;
  if (!sheetId) throw new Error("No spreadsheetId provided");

  const sheets = await getSheetsClient();

  // Check if sheet tab already exists
  const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
  const existing = meta.data.sheets.find(s => s.properties.title === "InsuranceRenewals");

  if (!existing) {
    // Add the sheet tab
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: {
        requests: [{
          addSheet: {
            properties: { title: "InsuranceRenewals" }
          }
        }]
      }
    });
    console.log("✅ Created 'InsuranceRenewals' tab");
  }

  // Write header row
  const headers = [
    ["Customer Name", "Phone (91XXXXXXXXXX)", "Car Model", "Reg No", "Policy No",
     "Insurance Company", "Expiry Date (DD/MM/YYYY)", "Status", "Last Reminder",
     "Reminder Note", "Premium (₹)"]
  ];

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: "InsuranceRenewals!A1:K1",
    valueInputOption: "RAW",
    requestBody: { values: headers }
  });

  // Add sample rows
  const sampleRows = [
    ["Rahul Sharma", "919876543210", "Toyota Fortuner", "DL01AB1234", "POL-2025-001",
     "ICICI Lombard", "15/04/2026", "active", "", "", "45000"],
    ["Priya Singh", "919123456789", "Hyundai Creta", "HR26CK5678", "POL-2025-002",
     "HDFC Ergo", "25/03/2026", "active", "", "", "18000"],
    ["Amit Kumar", "919012345678", "Maruti Swift", "UP16GH9012", "POL-2025-003",
     "New India Assurance", "10/03/2026", "active", "", "", "12000"]
  ];

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: "InsuranceRenewals!A2:K4",
    valueInputOption: "RAW",
    requestBody: { values: sampleRows }
  });

  console.log("✅ Insurance sheet setup complete with headers + sample data");
  return { ok: true, spreadsheetId: sheetId };
}

// ── Renewal Welcome Message ─────────────────────────────────
function renewalWelcomeMsg(row, newPolicyNo, newExpiry) {
  const name = row[COL.NAME] || "Customer";
  const car = row[COL.CAR_MODEL] || "your car";
  const regNo = row[COL.REG_NO] || "";
  const insurer = row[COL.INSURER] || "";
  const premium = row[COL.PREMIUM] || "";

  return `🎉 *Insurance Renewed Successfully!*\n\nDear ${name},\n\nGreat news! Your car insurance has been renewed.\n\n🚗 Car: ${car}${regNo ? ` (${regNo})` : ""}\n📋 New Policy No: ${newPolicyNo || row[COL.POLICY_NO] || "N/A"}\n🏢 Insurer: ${insurer}\n📅 Valid Until: ${newExpiry || "N/A"}${premium ? `\n💰 Premium Paid: ₹${premium}` : ""}\n\n✅ Your vehicle is now fully covered.\n📄 We'll send your policy document shortly.\n\nDrive safe! 🚘\n— Team Mr. Car`;
}

async function markRenewed(opts = {}) {
  const { phone, policyNo, newPolicyNo, newExpiry, newPremium, sheetId: sid } = opts;
  const sheetId = sid || INSURANCE_SHEET_ID;
  if (!sheetId) return { ok: false, error: "No INSURANCE_SHEET_ID" };
  if (!phone && !policyNo) return { ok: false, error: "Provide phone or policyNo" };

  const sheets = await getSheetsClient();
  const result = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: INSURANCE_SHEET_RANGE });
  const rows = result.data.values || [];

  const cleanPhone = phone ? String(phone).replace(/[^0-9]/g, "") : "";
  let matchIdx = -1;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowPhone = String(row[COL.PHONE] || "").replace(/[^0-9]/g, "");
    const rowPolicy = String(row[COL.POLICY_NO] || "").trim();

    if (policyNo && rowPolicy.toLowerCase() === policyNo.toLowerCase()) { matchIdx = i; break; }
    if (cleanPhone && rowPhone.slice(-10) === cleanPhone.slice(-10)) { matchIdx = i; break; }
  }

  if (matchIdx < 0) return { ok: false, error: "No matching policy found" };

  const row = rows[matchIdx];
  const rowNum = matchIdx + 2; // 1-indexed + header

  // Update sheet: status=renewed, new policy no, new expiry
  const updates = [
    { range: `InsuranceRenewals!H${rowNum}`, values: [["renewed"]] },
    { range: `InsuranceRenewals!I${rowNum}`, values: [[todayStr()]] },
    { range: `InsuranceRenewals!J${rowNum}`, values: [["Renewed on " + todayStr()]] }
  ];

  if (newPolicyNo) updates.push({ range: `InsuranceRenewals!E${rowNum}`, values: [[newPolicyNo]] });
  if (newExpiry) updates.push({ range: `InsuranceRenewals!G${rowNum}`, values: [[newExpiry]] });
  if (newPremium) updates.push({ range: `InsuranceRenewals!K${rowNum}`, values: [[newPremium]] });

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: { valueInputOption: "USER_ENTERED", data: updates }
  });

  // Send welcome message to customer
  const customerPhone = String(row[COL.PHONE] || "").replace(/[^0-9]/g, "");
  const welcomeMsg = renewalWelcomeMsg(row, newPolicyNo, newExpiry);

  if (customerPhone.length >= 10) {
    try {
      await waSendRaw({
        messaging_product: "whatsapp", to: customerPhone,
        type: "text", text: { body: welcomeMsg }
      });
      console.log(`🎉 Renewal welcome sent → ${customerPhone}`);
    } catch (e) {
      console.warn("Renewal welcome send failed:", e?.message || e);
    }
  }

  // Notify admin
  try {
    const adminMsg = `✅ *Insurance Renewed*\n\n👤 ${row[COL.NAME]}\n🚗 ${row[COL.CAR_MODEL]} (${row[COL.REG_NO] || ""})\n📋 Policy: ${newPolicyNo || row[COL.POLICY_NO]}\n📅 New Expiry: ${newExpiry || "N/A"}\n💰 Premium: ₹${newPremium || row[COL.PREMIUM] || "N/A"}`;
    await waSendRaw({
      messaging_product: "whatsapp", to: ADMIN_WA,
      type: "text", text: { body: adminMsg }
    });
  } catch (e) {
    console.warn("Admin renewal alert failed:", e?.message || e);
  }

  // Try to send policy PDF if available
  try {
    const { findPolicyFile } = require("./policy_lookup.cjs");
    const pdfPath = await findPolicyFile({
      policyNo: newPolicyNo || row[COL.POLICY_NO],
      regNo: row[COL.REG_NO],
      phone: customerPhone
    });

    if (pdfPath && typeof global.uploadMediaToWhatsApp === "function") {
      const mediaResp = await global.uploadMediaToWhatsApp(pdfPath);
      const mediaId = mediaResp?.id || mediaResp;
      if (mediaId) {
        await waSendRaw({
          messaging_product: "whatsapp", to: customerPhone,
          type: "document",
          document: {
            id: mediaId,
            caption: `Your renewed insurance policy — ${row[COL.CAR_MODEL]}`,
            filename: `${newPolicyNo || row[COL.POLICY_NO] || "policy"}.pdf`
          }
        });
        console.log("📄 Policy PDF sent with renewal welcome");
      }
    }
  } catch (e) {
    console.warn("Policy PDF send on renewal failed:", e?.message || e);
  }

  return { ok: true, customer: row[COL.NAME], phone: customerPhone };
}

// ── Express Routes (to wire into server.cjs) ────────────────
function mountInsuranceRoutes(app) {
  // Mark a policy as renewed + send welcome message
  app.post("/api/insurance/mark-renewed", async (req, res) => {
    try {
      const { phone, policyNo, newPolicyNo, newExpiry, newPremium } = req.body || {};
      const result = await markRenewed({ phone, policyNo, newPolicyNo, newExpiry, newPremium });
      res.json(result);
    } catch (e) {
      console.error("Mark renewed error:", e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // Upload policy PDF → Google Drive
  const multer = require("multer");
  const policyUpload = multer({ dest: path.join(__dirname, "tmp_policies") });
  app.post("/api/insurance/upload-policy", policyUpload.single("file"), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ ok: false, error: "No file uploaded" });
      const { regNo, policyNo, phone } = req.body || {};
      const filename = (regNo || policyNo || phone || "policy").replace(/[^a-zA-Z0-9\-]/g, "") + ".pdf";

      // Try upload to Google Drive
      try {
        const { uploadPolicyToDrive, DRIVE_FOLDER_ID } = require("./policy_lookup.cjs");
        if (DRIVE_FOLDER_ID) {
          const driveFile = await uploadPolicyToDrive(req.file.path, filename);
          fs.unlinkSync(req.file.path); // cleanup temp
          return res.json({ ok: true, storage: "google_drive", file: driveFile });
        }
      } catch (driveErr) {
        console.warn("Drive upload failed, saving locally:", driveErr?.message || driveErr);
      }

      // Fallback: save to local policies/
      const policiesDir = path.join(__dirname, "policies");
      if (!fs.existsSync(policiesDir)) fs.mkdirSync(policiesDir, { recursive: true });
      const destPath = path.join(policiesDir, filename);
      fs.renameSync(req.file.path, destPath);
      res.json({ ok: true, storage: "local", path: destPath });
    } catch (e) {
      console.error("Policy upload error:", e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // Manual trigger: check & send reminders
  app.post("/api/insurance/check-reminders", async (req, res) => {
    try {
      const dryRun = req.body?.dryRun || req.query.dryRun === "true";
      const sheetId = req.body?.sheetId || INSURANCE_SHEET_ID;
      const result = await checkAndSendReminders({ sheetId, dryRun });
      res.json(result);
    } catch (e) {
      console.error("Insurance reminder error:", e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // Setup: create sheet template
  app.post("/api/insurance/setup-sheet", async (req, res) => {
    try {
      const sheetId = req.body?.spreadsheetId || INSURANCE_SHEET_ID;
      const result = await createInsuranceSheet(sheetId);
      res.json(result);
    } catch (e) {
      console.error("Insurance sheet setup error:", e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // View upcoming renewals (JSON)
  app.get("/api/insurance/upcoming", async (req, res) => {
    try {
      const sheetId = req.query.sheetId || INSURANCE_SHEET_ID;
      if (!sheetId) return res.status(400).json({ ok: false, error: "No sheetId" });

      const sheetsClient = await getSheetsClient();
      const result = await sheetsClient.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range: INSURANCE_SHEET_RANGE
      });

      const rows = result.data.values || [];
      const upcoming = [];

      for (const row of rows) {
        const expiry = parseExpiryDate(row[COL.EXPIRY]);
        if (!expiry) continue;
        const daysLeft = daysUntil(expiry);
        const status = String(row[COL.STATUS] || "").toLowerCase();
        if (["renewed", "cancelled"].includes(status)) continue;

        if (daysLeft <= 30) {
          upcoming.push({
            name: row[COL.NAME],
            phone: row[COL.PHONE],
            car: row[COL.CAR_MODEL],
            regNo: row[COL.REG_NO],
            policyNo: row[COL.POLICY_NO],
            insurer: row[COL.INSURER],
            expiry: row[COL.EXPIRY],
            daysLeft,
            status: row[COL.STATUS],
            premium: row[COL.PREMIUM]
          });
        }
      }

      upcoming.sort((a, b) => a.daysLeft - b.daysLeft);
      res.json({ ok: true, count: upcoming.length, upcoming });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  console.log("🛡️ Insurance reminder routes mounted: /api/insurance/*");
}

// ── Daily Cron (call from server.cjs setInterval) ───────────
let _cronRunning = false;
async function dailyCronCheck() {
  if (_cronRunning) return;
  _cronRunning = true;
  try {
    console.log("⏰ Insurance daily cron check...");
    const result = await checkAndSendReminders();
    console.log("⏰ Cron result:", JSON.stringify(result));
  } catch (e) {
    console.error("⏰ Insurance cron error:", e?.message || e);
  } finally {
    _cronRunning = false;
  }
}

module.exports = {
  checkAndSendReminders,
  createInsuranceSheet,
  mountInsuranceRoutes,
  dailyCronCheck,
  markRenewed
};
