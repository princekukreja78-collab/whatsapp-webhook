// google_auth.cjs — Shared Google auth helper
// Loads service account from GOOGLE_SA_JSON env var (for Render) or .credentials/service-account.json (local)

const { google } = require("googleapis");
const fs = require("fs");
const path = require("path");

const SA_FILE = path.join(__dirname, ".credentials", "service-account.json");
const RENDER_SA_FILE = "/etc/secrets/service-account.json";

let _credentials = null;

function getCredentials() {
  if (_credentials) return _credentials;

  // Option 1: Env var (Render / production)
  if (process.env.GOOGLE_SA_JSON) {
    try {
      _credentials = JSON.parse(process.env.GOOGLE_SA_JSON);
      return _credentials;
    } catch (e) {
      console.warn("Failed to parse GOOGLE_SA_JSON env var:", e?.message);
    }
  }

  // Option 2: Render Secret File
  if (fs.existsSync(RENDER_SA_FILE)) {
    _credentials = JSON.parse(fs.readFileSync(RENDER_SA_FILE, "utf8"));
    console.log("✅ Loaded Google credentials from Render secret file");
    return _credentials;
  }

  // Option 3: Local file
  if (fs.existsSync(SA_FILE)) {
    _credentials = JSON.parse(fs.readFileSync(SA_FILE, "utf8"));
    return _credentials;
  }

  throw new Error("No Google service account credentials found. Set GOOGLE_SA_JSON env var, add Render Secret File, or place .credentials/service-account.json");
}

function getAuth(scopes) {
  return new google.auth.GoogleAuth({
    credentials: getCredentials(),
    scopes: scopes || [
      "https://www.googleapis.com/auth/spreadsheets",
      "https://www.googleapis.com/auth/drive"
    ]
  });
}

async function getSheetsClient() {
  const auth = await getAuth();
  return google.sheets({ version: "v4", auth });
}

async function getDriveClient() {
  const auth = await getAuth();
  return google.drive({ version: "v3", auth });
}

module.exports = { getCredentials, getAuth, getSheetsClient, getDriveClient };
