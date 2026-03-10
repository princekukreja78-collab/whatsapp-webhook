// policy_lookup.cjs — Lookup customer's insurance policy from Google Sheet + Google Drive
// Policies (PDF files) stored in Google Drive folder, shared with service account
// Fallback: local ./policies/ folder

const { google } = require("googleapis");
const fs = require("fs");
const path = require("path");
const { getAuth } = require("./google_auth.cjs");

const POLICIES_DIR = path.join(__dirname, "policies");
const TEMP_DIR = path.join(__dirname, "tmp_policies");
const INSURANCE_SHEET_ID = process.env.INSURANCE_SHEET_ID || "";
const INSURANCE_SHEET_RANGE = "InsuranceRenewals!A2:L";
const DRIVE_FOLDER_ID = process.env.INSURANCE_DRIVE_FOLDER_ID || "";

// Column indices (same as insurance_reminder.cjs)
const COL = {
  NAME: 0, PHONE: 1, CAR_MODEL: 2, REG_NO: 3, POLICY_NO: 4,
  INSURER: 5, EXPIRY: 6, STATUS: 7, LAST_REMINDER: 8, REMINDER_NOTE: 9, PREMIUM: 10, CHASSIS_NO: 11
};

// ── Google Drive: search for policy PDF ─────────────────────
let _driveFileCache = null;
let _driveCacheTime = 0;
const DRIVE_CACHE_TTL = 10 * 60 * 1000; // 10 min cache

async function listDriveFiles() {
  if (!DRIVE_FOLDER_ID) return [];

  // Return cached if fresh
  if (_driveFileCache && (Date.now() - _driveCacheTime) < DRIVE_CACHE_TTL) {
    return _driveFileCache;
  }

  const auth = await getAuth();
  const drive = google.drive({ version: "v3", auth });

  const res = await drive.files.list({
    q: `'${DRIVE_FOLDER_ID}' in parents and mimeType='application/pdf' and trashed=false`,
    fields: "files(id, name, size, modifiedTime)",
    pageSize: 500
  });

  _driveFileCache = res.data.files || [];
  _driveCacheTime = Date.now();
  return _driveFileCache;
}

async function downloadDriveFile(fileId, filename) {
  if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

  const destPath = path.join(TEMP_DIR, filename);

  // Return cached download if exists and recent (< 1 hour)
  if (fs.existsSync(destPath)) {
    const age = Date.now() - fs.statSync(destPath).mtimeMs;
    if (age < 60 * 60 * 1000) return destPath;
  }

  const auth = await getAuth();
  const drive = google.drive({ version: "v3", auth });

  const res = await drive.files.get(
    { fileId, alt: "media" },
    { responseType: "stream" }
  );

  return new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(destPath);
    res.data.pipe(ws);
    ws.on("finish", () => resolve(destPath));
    ws.on("error", reject);
  });
}

/**
 * Find policy PDF on Google Drive by matching filename to policy/regNo/phone
 */
async function findPolicyOnDrive(policy) {
  if (!DRIVE_FOLDER_ID) return null;

  const candidates = [];
  if (policy.policyNo) candidates.push(policy.policyNo.replace(/[^a-zA-Z0-9\-]/g, "").toLowerCase());
  if (policy.regNo) candidates.push(policy.regNo.replace(/[^a-zA-Z0-9]/g, "").toLowerCase());
  if (policy.chassisNo) candidates.push(policy.chassisNo.replace(/[^a-zA-Z0-9]/g, "").toLowerCase());
  if (policy.phone) {
    const ph = policy.phone.replace(/[^0-9]/g, "");
    candidates.push(ph);
    if (policy.policyNo) candidates.push(`${ph}_${policy.policyNo.replace(/[^a-zA-Z0-9\-]/g, "")}`.toLowerCase());
  }

  if (!candidates.length) return null;

  try {
    const files = await listDriveFiles();

    for (const candidate of candidates) {
      const match = files.find(f => {
        const base = path.basename(f.name, path.extname(f.name)).toLowerCase().replace(/[^a-z0-9]/g, "");
        return base === candidate.replace(/[^a-z0-9]/g, "") || base.includes(candidate.replace(/[^a-z0-9]/g, ""));
      });

      if (match) {
        // Download to temp and return local path
        const localPath = await downloadDriveFile(match.id, match.name);
        console.log(`📄 Policy PDF fetched from Drive: ${match.name}`);
        return localPath;
      }
    }
  } catch (e) {
    console.warn("Drive policy search failed:", e?.message || e);
  }

  return null;
}

// ── Sheet Lookup ────────────────────────────────────────────
async function findPoliciesByPhone(phone) {
  if (!INSURANCE_SHEET_ID) return [];

  const cleanPhone = String(phone).replace(/[^0-9]/g, "");
  if (!cleanPhone || cleanPhone.length < 10) return [];

  const auth = await getAuth();
  const sheets = google.sheets({ version: "v4", auth });

  const result = await sheets.spreadsheets.values.get({
    spreadsheetId: INSURANCE_SHEET_ID,
    range: INSURANCE_SHEET_RANGE
  });

  const rows = result.data.values || [];
  const matches = [];

  for (const row of rows) {
    const rowPhone = String(row[COL.PHONE] || "").replace(/[^0-9]/g, "");
    if (rowPhone.slice(-10) === cleanPhone.slice(-10)) {
      matches.push({
        name: row[COL.NAME] || "",
        phone: row[COL.PHONE] || "",
        car: row[COL.CAR_MODEL] || "",
        regNo: row[COL.REG_NO] || "",
        policyNo: row[COL.POLICY_NO] || "",
        insurer: row[COL.INSURER] || "",
        expiry: row[COL.EXPIRY] || "",
        status: row[COL.STATUS] || "",
        premium: row[COL.PREMIUM] || ""
      });
    }
  }

  return matches;
}

// ── Find Policy File (Drive first, then local fallback) ─────
async function findPolicyFile(policy) {
  // Try Google Drive first
  const drivePath = await findPolicyOnDrive(policy);
  if (drivePath) return drivePath;

  // Fallback: local ./policies/ folder
  if (!fs.existsSync(POLICIES_DIR)) return null;

  const candidates = [];
  if (policy.policyNo) candidates.push(policy.policyNo.replace(/[^a-zA-Z0-9\-]/g, ""));
  if (policy.regNo) candidates.push(policy.regNo.replace(/[^a-zA-Z0-9]/g, ""));
  if (policy.phone) {
    const ph = policy.phone.replace(/[^0-9]/g, "");
    candidates.push(ph);
    if (policy.policyNo) candidates.push(`${ph}_${policy.policyNo.replace(/[^a-zA-Z0-9\-]/g, "")}`);
  }

  const files = fs.readdirSync(POLICIES_DIR);

  for (const candidate of candidates) {
    const lower = candidate.toLowerCase();
    const match = files.find(f => {
      const base = path.basename(f, path.extname(f)).toLowerCase();
      return base === lower || base.includes(lower);
    });
    if (match) return path.join(POLICIES_DIR, match);
  }

  return null;
}

// ── Upload policy PDF to Google Drive ───────────────────────
async function uploadPolicyToDrive(filePath, filename) {
  if (!DRIVE_FOLDER_ID) throw new Error("INSURANCE_DRIVE_FOLDER_ID not set");

  const auth = await getAuth();
  const drive = google.drive({ version: "v3", auth });

  const res = await drive.files.create({
    requestBody: {
      name: filename,
      parents: [DRIVE_FOLDER_ID],
      mimeType: "application/pdf"
    },
    media: {
      mimeType: "application/pdf",
      body: fs.createReadStream(filePath)
    },
    fields: "id, name, webViewLink"
  });

  // Clear cache so new file is found immediately
  _driveFileCache = null;

  console.log(`📤 Uploaded to Drive: ${res.data.name} (${res.data.id})`);
  return res.data;
}

// ── Message Formatters ──────────────────────────────────────
function formatPolicyMessage(policies) {
  if (!policies.length) {
    return "We couldn't find any insurance policy linked to your number. Please contact us with your registration number or policy number for help.";
  }

  let msg = `📋 *Your Insurance Polic${policies.length > 1 ? "ies" : "y"}*\n\n`;

  for (let i = 0; i < policies.length; i++) {
    const p = policies[i];
    if (policies.length > 1) msg += `*Policy ${i + 1}:*\n`;
    msg += `🚗 Car: ${p.car}${p.regNo ? ` (${p.regNo})` : ""}\n`;
    msg += `📋 Policy No: ${p.policyNo || "N/A"}\n`;
    msg += `🏢 Insurer: ${p.insurer || "N/A"}\n`;
    msg += `📅 Expiry: ${p.expiry || "N/A"}\n`;
    msg += `📊 Status: ${p.status || "active"}\n`;
    if (p.premium) msg += `💰 Premium: ₹${p.premium}\n`;
    msg += "\n";
  }

  msg += "Need to renew or have questions? Just reply here!";
  return msg;
}

function isInsurancePolicyRequest(msgText) {
  if (!msgText) return false;
  const t = msgText.toLowerCase().trim();
  return /\b(my\s+)?insurance\b|\b(my\s+)?polic(y|ies)\b|\binsurance\s+(detail|copy|document|pdf|paper|status|info|renewal|expir)/i.test(t)
    || /\b(send|share|show|get|check)\s+(my\s+)?(insurance|polic)/i.test(t)
    || /\bpolicy\s*(number|no|copy|pdf|detail|status|expir)/i.test(t);
}

module.exports = {
  findPoliciesByPhone,
  findPolicyFile,
  findPolicyOnDrive,
  uploadPolicyToDrive,
  formatPolicyMessage,
  isInsurancePolicyRequest,
  POLICIES_DIR,
  DRIVE_FOLDER_ID
};
