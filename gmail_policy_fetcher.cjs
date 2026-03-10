// gmail_policy_fetcher.cjs — Auto-fetch insurance policy PDFs from Gmail
// Scans inbox for insurance policy emails, downloads PDF attachments, saves to ./policies/
//
// SETUP (Google Workspace — domain-wide delegation):
// 1. Enable Gmail API in Google Cloud Console (same project as service account)
// 2. Google Admin Console → Security → API Controls → Domain-wide Delegation
//    → Add new: Client ID from service account, Scope: https://www.googleapis.com/auth/gmail.readonly
// 3. Set INSURANCE_GMAIL in .env (e.g. princekukreja@mrcar.co.in)
// 4. Run: node gmail_policy_fetcher.cjs --fetch
//
// FALLBACK (personal Gmail — OAuth2):
// 1. Create OAuth2 Desktop credentials in Cloud Console
// 2. Save as .credentials/gmail-oauth.json
// 3. Run: node gmail_policy_fetcher.cjs --auth
// 4. Run: node gmail_policy_fetcher.cjs --code YOUR_CODE
// 5. Run: node gmail_policy_fetcher.cjs --fetch

const { google } = require("googleapis");
const fs = require("fs");
const path = require("path");

const POLICIES_DIR = path.join(__dirname, "policies");
const SA_PATH = path.join(__dirname, ".credentials", "service-account.json");
const OAUTH_PATH = path.join(__dirname, ".credentials", "gmail-oauth.json");
const TOKEN_PATH = path.join(__dirname, ".credentials", "gmail-token.json");
const GMAIL_USER = process.env.INSURANCE_GMAIL || "princekukreja@mrcar.co.in";

// Search queries to find insurance policy emails
const GMAIL_SEARCH_QUERIES = [
  "subject:(insurance policy) has:attachment filename:pdf",
  "subject:(policy document) has:attachment filename:pdf",
  "subject:(motor insurance) has:attachment filename:pdf",
  "subject:(vehicle insurance) has:attachment filename:pdf",
  "subject:(car insurance) has:attachment filename:pdf",
  "subject:(policy schedule) has:attachment filename:pdf",
  "subject:(policy copy) has:attachment filename:pdf",
  "subject:(renewal) has:attachment filename:pdf",
  "from:(icici lombard OR hdfc ergo OR bajaj allianz OR new india OR tata aig OR sbi general OR national insurance OR oriental insurance OR united india OR acko OR digit OR go digit OR royal sundaram OR reliance general OR cholamandalam OR iffco tokio OR magma) has:attachment filename:pdf"
];

// ── Auth: Try Service Account (Workspace) first, fallback to OAuth2 ──
async function getGmailAuth() {
  // Option 1: Service account with domain-wide delegation (Google Workspace)
  if (fs.existsSync(SA_PATH)) {
    try {
      const creds = JSON.parse(fs.readFileSync(SA_PATH, "utf8"));
      const auth = new google.auth.JWT({
        email: creds.client_email,
        key: creds.private_key,
        scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
        subject: GMAIL_USER // Impersonate this user
      });
      await auth.authorize();
      console.log(`📧 Gmail auth via service account (impersonating ${GMAIL_USER})`);
      return auth;
    } catch (e) {
      console.warn("Service account Gmail auth failed (domain-wide delegation may not be set up):", e?.message || e);
    }
  }

  // Option 2: OAuth2 (personal Gmail or if delegation not set up)
  if (fs.existsSync(OAUTH_PATH) && fs.existsSync(TOKEN_PATH)) {
    const oauthCreds = JSON.parse(fs.readFileSync(OAUTH_PATH, "utf8"));
    const { client_id, client_secret, redirect_uris } = oauthCreds.installed || oauthCreds.web || {};
    const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris?.[0] || "urn:ietf:wg:oauth:2.0:oob");
    const token = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8"));
    oAuth2Client.setCredentials(token);
    console.log("📧 Gmail auth via OAuth2 token");
    return oAuth2Client;
  }

  throw new Error(
    "Gmail auth not available.\n" +
    "Option A (Workspace): Enable domain-wide delegation for service account\n" +
    "Option B (OAuth2): Run: node gmail_policy_fetcher.cjs --auth"
  );
}

// ── OAuth2 Flow (fallback for non-Workspace) ────────────────
async function authorizeGmail() {
  if (!fs.existsSync(OAUTH_PATH)) {
    console.log("❌ OAuth credentials not found at", OAUTH_PATH);
    console.log("Download from Google Cloud Console → Credentials → Create OAuth Client ID (Desktop App)");
    console.log("Save as: .credentials/gmail-oauth.json");
    return;
  }

  const creds = JSON.parse(fs.readFileSync(OAUTH_PATH, "utf8"));
  const { client_id, client_secret, redirect_uris } = creds.installed || creds.web || {};
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris?.[0] || "urn:ietf:wg:oauth:2.0:oob");

  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: "offline",
    scope: ["https://www.googleapis.com/auth/gmail.readonly"]
  });

  console.log("\n🔗 Open this URL in your browser to authorize Gmail access:\n");
  console.log(authUrl);
  console.log("\nAfter authorizing, you'll get a code. Run:");
  console.log(`  node gmail_policy_fetcher.cjs --code YOUR_CODE_HERE\n`);
}

async function saveAuthCode(code) {
  const creds = JSON.parse(fs.readFileSync(OAUTH_PATH, "utf8"));
  const { client_id, client_secret, redirect_uris } = creds.installed || creds.web || {};
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris?.[0] || "urn:ietf:wg:oauth:2.0:oob");

  const { tokens } = await oAuth2Client.getToken(code);
  oAuth2Client.setCredentials(tokens);
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
  console.log("✅ Gmail token saved to", TOKEN_PATH);
  return tokens;
}

// ── Fetch Policies from Gmail ───────────────────────────────
async function fetchPoliciesFromGmail(opts = {}) {
  const auth = await getGmailAuth();
  const gmail = google.gmail({ version: "v1", auth });

  if (!fs.existsSync(POLICIES_DIR)) fs.mkdirSync(POLICIES_DIR, { recursive: true });

  const maxResults = opts.maxResults || 50;
  const allMessages = new Map(); // id → true (dedup)
  const downloaded = [];
  const skipped = [];

  // Search with multiple queries
  for (const query of GMAIL_SEARCH_QUERIES) {
    try {
      const res = await gmail.users.messages.list({
        userId: "me",
        q: query,
        maxResults
      });

      const messages = res.data.messages || [];
      for (const m of messages) allMessages.set(m.id, true);
    } catch (e) {
      console.warn("Gmail search failed for query:", query.slice(0, 60), "→", e?.message || e);
    }
  }

  console.log(`📧 Found ${allMessages.size} unique insurance-related emails`);

  // Process each email
  for (const msgId of allMessages.keys()) {
    try {
      const msg = await gmail.users.messages.get({
        userId: "me",
        id: msgId,
        format: "full"
      });

      const headers = msg.data.payload?.headers || [];
      const subject = headers.find(h => h.name.toLowerCase() === "subject")?.value || "";
      const from = headers.find(h => h.name.toLowerCase() === "from")?.value || "";
      const date = headers.find(h => h.name.toLowerCase() === "date")?.value || "";

      // Find PDF attachments
      const parts = getAllParts(msg.data.payload);
      const pdfParts = parts.filter(p =>
        p.filename &&
        (p.filename.toLowerCase().endsWith(".pdf") || p.mimeType === "application/pdf") &&
        p.body?.attachmentId
      );

      for (const part of pdfParts) {
        const safeName = sanitizeFilename(part.filename);
        const destPath = path.join(POLICIES_DIR, safeName);

        // Skip if already downloaded
        if (fs.existsSync(destPath)) {
          skipped.push(safeName);
          continue;
        }

        // Download attachment
        const attachment = await gmail.users.messages.attachments.get({
          userId: "me",
          messageId: msgId,
          id: part.body.attachmentId
        });

        const data = Buffer.from(attachment.data.data, "base64");
        fs.writeFileSync(destPath, data);

        console.log(`📄 Downloaded: ${safeName} (${(data.length / 1024).toFixed(1)}KB) — ${subject.slice(0, 60)}`);

        downloaded.push({
          filename: safeName,
          path: destPath,
          subject,
          from,
          date,
          size: data.length
        });
      }
    } catch (e) {
      console.warn("Failed to process email", msgId, e?.message || e);
    }
  }

  console.log(`\n✅ Downloaded ${downloaded.length} new policy PDFs to ./policies/`);
  if (skipped.length) console.log(`⏭️ Skipped ${skipped.length} already-existing files`);

  return { ok: true, total: allMessages.size, downloaded: downloaded.length, skipped: skipped.length, files: downloaded };
}

// ── Auto-match downloaded PDFs to Sheet records ─────────────
async function autoMatchPoliciesToSheet() {
  if (!fs.existsSync(POLICIES_DIR)) return { ok: false, error: "No policies dir" };
  const sheetId = process.env.INSURANCE_SHEET_ID;
  if (!sheetId) return { ok: false, error: "No INSURANCE_SHEET_ID" };

  const files = fs.readdirSync(POLICIES_DIR).filter(f => f.toLowerCase().endsWith(".pdf"));
  if (!files.length) return { ok: true, matched: 0, message: "No PDFs in policies/" };

  // Read sheet data
  const creds = JSON.parse(fs.readFileSync(SA_PATH, "utf8"));
  const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"] });
  const sheets = google.sheets({ version: "v4", auth: await auth });
  const result = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: "InsuranceRenewals!A2:K" });
  const rows = result.data.values || [];

  let matched = 0;
  const suggestions = [];

  for (const row of rows) {
    const regNo = String(row[3] || "").replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
    const policyNo = String(row[4] || "").replace(/[^a-zA-Z0-9\-]/g, "").toLowerCase();
    const phone = String(row[1] || "").replace(/[^0-9]/g, "");
    const name = String(row[0] || "").toLowerCase();

    // Check if any PDF filename matches
    const matchingFile = files.find(f => {
      const base = path.basename(f, ".pdf").toLowerCase().replace(/[^a-z0-9]/g, "");
      return (regNo && base.includes(regNo)) ||
             (policyNo && base.includes(policyNo.replace(/-/g, ""))) ||
             (phone && base.includes(phone.slice(-10)));
    });

    if (matchingFile) {
      matched++;
    } else {
      // Suggest renaming
      const suggestedName = regNo ? `${regNo.toUpperCase()}.pdf` : `${policyNo || phone}.pdf`;
      suggestions.push({ customer: row[0], regNo: row[3], policyNo: row[4], suggestedFilename: suggestedName });
    }
  }

  return { ok: true, matched, unmatched: suggestions.length, suggestions };
}

// ── Helpers ─────────────────────────────────────────────────
function getAllParts(payload) {
  const parts = [];
  if (!payload) return parts;
  if (payload.filename && payload.body?.attachmentId) parts.push(payload);
  if (payload.parts) {
    for (const p of payload.parts) parts.push(...getAllParts(p));
  }
  return parts;
}

function sanitizeFilename(name) {
  return String(name || "policy.pdf")
    .replace(/[^a-zA-Z0-9._\-()]/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 200);
}

// ── Express Routes ──────────────────────────────────────────
function mountGmailRoutes(app) {
  // Trigger Gmail policy fetch
  app.post("/api/insurance/fetch-from-gmail", async (req, res) => {
    try {
      const result = await fetchPoliciesFromGmail({ maxResults: req.body?.maxResults || 50 });
      res.json(result);
    } catch (e) {
      console.error("Gmail fetch error:", e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // Auto-match PDFs to sheet records
  app.get("/api/insurance/match-policies", async (req, res) => {
    try {
      const result = await autoMatchPoliciesToSheet();
      res.json(result);
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // List downloaded policies
  app.get("/api/insurance/policies", (req, res) => {
    try {
      if (!fs.existsSync(POLICIES_DIR)) return res.json({ ok: true, files: [] });
      const files = fs.readdirSync(POLICIES_DIR)
        .filter(f => f.toLowerCase().endsWith(".pdf"))
        .map(f => ({
          name: f,
          size: fs.statSync(path.join(POLICIES_DIR, f)).size,
          modified: fs.statSync(path.join(POLICIES_DIR, f)).mtime
        }));
      res.json({ ok: true, count: files.length, files });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  console.log("📧 Gmail policy routes mounted: /api/insurance/fetch-from-gmail, /api/insurance/policies, /api/insurance/match-policies");
}

// ── CLI Mode ────────────────────────────────────────────────
if (require.main === module) {
  require("dotenv").config();
  const args = process.argv.slice(2);

  if (args.includes("--auth")) {
    authorizeGmail().catch(e => console.error("Auth error:", e.message));
  } else if (args[0] === "--code" && args[1]) {
    saveAuthCode(args[1]).catch(e => console.error("Code error:", e.message));
  } else if (args.includes("--fetch")) {
    fetchPoliciesFromGmail().catch(e => console.error("Fetch error:", e.message));
  } else if (args.includes("--match")) {
    autoMatchPoliciesToSheet().then(r => console.log(JSON.stringify(r, null, 2))).catch(e => console.error(e.message));
  } else {
    console.log("Usage:");
    console.log("  node gmail_policy_fetcher.cjs --auth     # Start OAuth flow (non-Workspace)");
    console.log("  node gmail_policy_fetcher.cjs --code XX  # Save auth code");
    console.log("  node gmail_policy_fetcher.cjs --fetch    # Fetch policy PDFs from Gmail");
    console.log("  node gmail_policy_fetcher.cjs --match    # Match PDFs to sheet records");
  }
}

module.exports = { fetchPoliciesFromGmail, mountGmailRoutes, authorizeGmail, saveAuthCode, autoMatchPoliciesToSheet };
