// policy_extractor.cjs — Extract insurance policy details from PDF using AI
// When a PDF is uploaded to Google Drive, this reads it, extracts fields via OpenAI,
// and auto-fills the Google Sheet. Phone number must be added manually.

const { google } = require("googleapis");
const fs = require("fs");
const path = require("path");
const OpenAI = require("openai");
const { getAuth } = require("./google_auth.cjs");

const INSURANCE_SHEET_ID = process.env.INSURANCE_SHEET_ID || "";
const DRIVE_FOLDER_ID = process.env.INSURANCE_DRIVE_FOLDER_ID || "";
const TEMP_DIR = path.join(__dirname, "tmp_policies");

// Track processed files to avoid duplicates
const PROCESSED_LOG = path.join(__dirname, ".crm_data", "processed_policies.json");

function getOpenAI() {
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

function loadProcessedFiles() {
  try {
    if (fs.existsSync(PROCESSED_LOG)) return JSON.parse(fs.readFileSync(PROCESSED_LOG, "utf8"));
  } catch (e) {}
  return {};
}

function saveProcessedFiles(data) {
  const dir = path.dirname(PROCESSED_LOG);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(PROCESSED_LOG, JSON.stringify(data, null, 2));
}

// ── Extract text from PDF ───────────────────────────────────
async function extractTextFromPDF(filePath) {
  const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.mjs");
  const buffer = fs.readFileSync(filePath);
  const uint8 = new Uint8Array(buffer);

  const doc = await pdfjsLib.getDocument({ data: uint8, useSystemFonts: true }).promise;
  let fullText = "";

  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items.map(item => item.str).join(" ");
    fullText += pageText + "\n";
  }

  return fullText;
}

// ── AI: Extract policy fields from text ─────────────────────
async function extractPolicyFields(pdfText) {
  const openai = getOpenAI();
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

  const response = await openai.chat.completions.create({
    model,
    temperature: 0,
    messages: [
      {
        role: "system",
        content: `You are an insurance policy document parser for Indian motor insurance policies.
Extract the following fields from the policy document text. Return ONLY valid JSON, no markdown.

Required JSON format:
{
  "customerName": "Full name of policy holder",
  "carModel": "Make and model (e.g. Toyota Fortuner, Hyundai Creta)",
  "regNo": "Registration number (e.g. DL01AB1234) or null if new car without registration",
  "policyNo": "Policy number",
  "insurer": "Insurance company name (short, e.g. ICICI Lombard, HDFC Ergo)",
  "expiryDate": "Policy expiry date in DD/MM/YYYY format",
  "startDate": "Policy start date in DD/MM/YYYY format",
  "premium": "Total premium amount (number only, no currency symbol)",
  "chassisNo": "Chassis/VIN number or null",
  "engineNo": "Engine number or null",
  "vehicleType": "Car type (Sedan/SUV/Hatchback/etc) or null",
  "fuelType": "Petrol/Diesel/CNG/Electric or null",
  "idv": "Insured Declared Value (number only) or null",
  "coverType": "Comprehensive/Third Party/Own Damage or null"
}

Rules:
- If a field is not found in the document, set it to null
- For dates, always use DD/MM/YYYY format
- For premium/IDV, extract just the number (no ₹ or Rs)
- Registration number may not exist for new car first policy — that's OK, set to null
- Look for policy period end date as expiry date
- Be precise with policy numbers — copy exactly as shown`
      },
      {
        role: "user",
        content: `Extract insurance policy details from this document:\n\n${pdfText.slice(0, 8000)}`
      }
    ]
  });

  const content = response.choices[0]?.message?.content || "";

  // Parse JSON from response (handle markdown code blocks)
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("AI did not return valid JSON");

  return JSON.parse(jsonMatch[0]);
}

// ── Append extracted data to Google Sheet ────────────────────
async function appendToSheet(fields, driveFileId) {
  if (!INSURANCE_SHEET_ID) throw new Error("No INSURANCE_SHEET_ID");

  const auth = await getAuth();
  const sheets = google.sheets({ version: "v4", auth });

  // Check if policy already exists in sheet (by policyNo)
  if (fields.policyNo) {
    const existing = await sheets.spreadsheets.values.get({
      spreadsheetId: INSURANCE_SHEET_ID,
      range: "InsuranceRenewals!E2:E500"
    });
    const policyNos = (existing.data.values || []).flat();
    if (policyNos.some(p => p && p.toLowerCase() === fields.policyNo.toLowerCase())) {
      console.log(`⏭️ Policy ${fields.policyNo} already in sheet, skipping`);
      return { ok: true, skipped: true, reason: "already_exists" };
    }
  }

  // Row: Name, Phone, CarModel, RegNo, PolicyNo, Insurer, Expiry, Status, LastReminder, ReminderNote, Premium, ChassisNo
  const row = [
    fields.customerName || "",
    "",  // Phone — must be filled manually
    fields.carModel || "",
    fields.regNo || "",  // Empty for new cars
    fields.policyNo || "",
    fields.insurer || "",
    fields.expiryDate || "",
    "active",
    "",
    fields.regNo ? "" : "⚠️ New car — no reg no yet. Add phone manually.",
    fields.premium || "",
    fields.chassisNo || ""
  ];

  await sheets.spreadsheets.values.append({
    spreadsheetId: INSURANCE_SHEET_ID,
    range: "InsuranceRenewals!A2:L",
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [row] }
  });

  console.log(`✅ Added to sheet: ${fields.customerName} — ${fields.carModel} — ${fields.policyNo}`);
  return { ok: true, added: true, fields };
}

// ── Process a single PDF from Drive ─────────────────────────
async function processDriveFile(fileId, fileName) {
  if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

  const auth = await getAuth();
  const drive = google.drive({ version: "v3", auth });

  // Download
  const destPath = path.join(TEMP_DIR, fileName);
  const res = await drive.files.get({ fileId, alt: "media" }, { responseType: "stream" });

  await new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(destPath);
    res.data.pipe(ws);
    ws.on("finish", resolve);
    ws.on("error", reject);
  });

  // Extract text
  console.log(`📖 Reading PDF: ${fileName}`);
  const pdfText = await extractTextFromPDF(destPath);

  if (!pdfText || pdfText.trim().length < 50) {
    console.warn(`⚠️ PDF has very little text (${pdfText.length} chars) — may be scanned image. Skipping.`);
    // Cleanup
    try { fs.unlinkSync(destPath); } catch (e) {}
    return { ok: false, error: "PDF has no extractable text (scanned image?)", fileName };
  }

  // AI extract
  console.log(`🤖 Extracting fields via AI...`);
  const fields = await extractPolicyFields(pdfText);
  console.log(`📋 Extracted:`, JSON.stringify(fields, null, 2));

  // Append to sheet
  const result = await appendToSheet(fields, fileId);

  // Cleanup temp file
  try { fs.unlinkSync(destPath); } catch (e) {}

  return { ...result, fileName, fields };
}

// ── Scan Drive folder for new PDFs & process them ───────────
async function scanAndProcessNewPolicies() {
  if (!DRIVE_FOLDER_ID) return { ok: false, error: "No INSURANCE_DRIVE_FOLDER_ID" };

  const auth = await getAuth();
  const drive = google.drive({ version: "v3", auth });

  const res = await drive.files.list({
    q: `'${DRIVE_FOLDER_ID}' in parents and mimeType='application/pdf' and trashed=false`,
    fields: "files(id, name, size, createdTime)",
    pageSize: 100,
    orderBy: "createdTime desc"
  });

  const files = res.data.files || [];
  if (!files.length) {
    console.log("📂 No PDFs in Drive folder");
    return { ok: true, total: 0, processed: 0 };
  }

  console.log(`📂 Found ${files.length} PDFs in Drive folder`);

  // Load processed log
  const processed = loadProcessedFiles();
  const results = [];

  for (const file of files) {
    if (processed[file.id]) {
      console.log(`⏭️ Already processed: ${file.name}`);
      continue;
    }

    try {
      const result = await processDriveFile(file.id, file.name);
      results.push(result);

      // Mark as processed
      processed[file.id] = {
        name: file.name,
        processedAt: new Date().toISOString(),
        result: result.ok ? "success" : "failed"
      };
      saveProcessedFiles(processed);
    } catch (e) {
      console.error(`❌ Failed to process ${file.name}:`, e?.message || e);
      results.push({ ok: false, fileName: file.name, error: e?.message || e });
    }
  }

  const added = results.filter(r => r.added).length;
  const skipped = results.filter(r => r.skipped).length;
  const failed = results.filter(r => !r.ok).length;

  console.log(`\n✅ Done: ${added} added, ${skipped} skipped, ${failed} failed`);
  return { ok: true, total: files.length, added, skipped, failed, results };
}

// ── Express Routes ──────────────────────────────────────────
function mountExtractorRoutes(app) {
  // Scan Drive for new policies → extract → fill sheet
  app.post("/api/insurance/scan-drive", async (req, res) => {
    try {
      const result = await scanAndProcessNewPolicies();
      res.json(result);
    } catch (e) {
      console.error("Scan drive error:", e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // Process a single Drive file by ID
  app.post("/api/insurance/extract-policy", async (req, res) => {
    try {
      const { fileId, fileName } = req.body || {};
      if (!fileId) return res.status(400).json({ ok: false, error: "fileId required" });
      const result = await processDriveFile(fileId, fileName || "policy.pdf");
      res.json(result);
    } catch (e) {
      console.error("Extract policy error:", e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  console.log("🤖 Policy extractor routes mounted: /api/insurance/scan-drive, /api/insurance/extract-policy");
}

// ── CLI Mode ────────────────────────────────────────────────
if (require.main === module) {
  require("dotenv").config();
  const args = process.argv.slice(2);

  if (args.includes("--scan")) {
    scanAndProcessNewPolicies()
      .then(r => console.log("\nResult:", JSON.stringify(r, null, 2)))
      .catch(e => console.error("Error:", e.message));
  } else {
    console.log("Usage:");
    console.log("  node policy_extractor.cjs --scan    # Scan Drive folder, extract & fill sheet");
  }
}

module.exports = { scanAndProcessNewPolicies, processDriveFile, mountExtractorRoutes };
