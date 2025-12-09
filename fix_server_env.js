const fs = require('fs');
const p = 'server.cjs';
const backup = p + '.bak';
if (!fs.existsSync(p)) {
  console.error('ERROR: server.cjs not found in cwd:', process.cwd());
  process.exit(1);
}
const orig = fs.readFileSync(p, 'utf8');
// create backup
fs.writeFileSync(backup, orig, 'utf8');
let s = orig;

// Remove all existing dotenv require lines (any args allowed)
s = s.replace(/require\(['"]dotenv['"]\)\.config\([^)]*\);\s*\n?/g, '');

// Ensure there's exactly one MODEL SELECTED log — remove all occurrences for now
const modelLogRegex = /console\.log\('MODEL SELECTED \(SIGNATURE_MODEL\)=',\s*SIGNATURE_MODEL\);\s*\n?/g;
const modelLogMatches = s.match(modelLogRegex) || [];
s = s.replace(modelLogRegex, '');

// Insert single dotenv require right after the boot log line
const bootLine = 'console.log("🚀 MR.CAR Webhook Server Booted (Verbose Logging ON)");';
if (s.indexOf(bootLine) !== -1) {
  // if already have our inserted dotenv snippet, avoid double-inserting
  const alreadyInserted = s.indexOf("/* Load .env early so process.env is populated for subsequent reads */");
  if (alreadyInserted === -1) {
    s = s.replace(bootLine, bootLine + "\n\n/* Load .env early so process.env is populated for subsequent reads */\nrequire('dotenv').config({ debug: false });\n");
  }
} else {
  // boot line not found: prepend dotenv at top (safe fallback)
  if (s.indexOf("require('dotenv').config") === -1) {
    s = "/* Load .env early so process.env is populated for subsequent reads */\nrequire('dotenv').config({ debug: false });\n\n" + s;
  }
}

// Ensure SIGNATURE_MODEL declaration exists; insert single MODEL SELECTED log after it
const sigDeclIdx = s.indexOf('const SIGNATURE_MODEL =');
if (sigDeclIdx !== -1) {
  // find end of that line (first newline after declaration)
  const afterLine = s.indexOf('\n', sigDeclIdx);
  // insert the single model log right after the declaration line if not already present immediately after
  const snippetToCheck = s.slice(afterLine, afterLine + 200);
  if (!/MODEL SELECTED \(SIGNATURE_MODEL\)/.test(snippetToCheck)) {
    s = s.slice(0, afterLine + 1) + "console.log('MODEL SELECTED (SIGNATURE_MODEL)=', SIGNATURE_MODEL);\n" + s.slice(afterLine + 1);
  } else {
    // if a model log already exists near, put back a single occurrence by ensuring only one in file
    // (we already removed all earlier, so this branch shouldn't trigger)
  }
} else {
  // if signature declaration not found, append the model log near top to be safe
  if (!/MODEL SELECTED \(SIGNATURE_MODEL\)/.test(s)) {
    s = "console.log('MODEL SELECTED (SIGNATURE_MODEL)=', process.env.OPENAI_MODEL || process.env.ENGINE_USED || 'gpt-4o-mini');\n" + s;
  }
}

// Write updated file
fs.writeFileSync(p, s, 'utf8');
console.log('Patched', p, ' — backup at', backup);
console.log('Please run: node server.cjs (or DEBUG=1 node server.cjs) and verify the boot logs.');
