// scripts/build_synonyms.cjs
const fs = require('fs');
const path = require('path');
const levenshtein = require('fast-levenshtein');

const LOG_PATH = path.resolve(__dirname, '..', '.crm_data', 'advisory_queries.json');
const OUT_DIR = path.resolve(__dirname, '..', '.crm_data');
const SYN_FILE = path.join(OUT_DIR, 'synonyms.json');
const TOP_FILE = path.join(OUT_DIR, 'top_intents.json');
const BACKUP_DIR = path.resolve(__dirname, '..', 'backups');

function ensureDir(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }
function tokenize(s) { return (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean); }
function mostCommon(arr, top = 200) {
  const freq = {};
  for (const a of arr) freq[a] = (freq[a] || 0) + 1;
  return Object.entries(freq).sort((a,b) => b[1]-a[1]).slice(0, top).map(x => ({ token: x[0], count: x[1] }));
}

ensureDir(OUT_DIR);
ensureDir(BACKUP_DIR);

if (!fs.existsSync(LOG_PATH)) {
  console.error('No advisory log found at', LOG_PATH);
  process.exit(1);
}

const raw = fs.readFileSync(LOG_PATH, 'utf8') || '[]';
let logs;
try { logs = JSON.parse(raw); } catch (e) { console.error('advisory log parse failed', e); process.exit(1); }

const tokens = [];
for (const l of logs) {
  const t = tokenize(l.text || '');
  tokens.push(...t);
}

const topTokens = mostCommon(tokens, 400);

// Build synonym groups by Levenshtein distance
const threshold = 2; // tuneable (2 is conservative)
const canonical = {};
const tokenList = topTokens.map(x => x.token);

for (const t of tokenList) {
  if (canonical[t]) continue;
  canonical[t] = t;
  for (const s of tokenList) {
    if (s === t) continue;
    if (canonical[s]) continue;
    if (Math.abs(t.length - s.length) > 3) continue;
    const d = levenshtein.get(t, s);
    if (d <= threshold) {
      const tCount = topTokens.find(x => x.token === t)?.count || 0;
      const sCount = topTokens.find(x => x.token === s)?.count || 0;
      const chosen = (tCount >= sCount) ? t : s;
      canonical[s] = chosen;
      canonical[t] = chosen;
    }
  }
}

// Create final synonyms map (only where different)
const synonyms = {};
for (const k of Object.keys(canonical)) {
  const v = canonical[k];
  if (k !== v) synonyms[k] = v;
}

// Backup previous synonyms
if (fs.existsSync(SYN_FILE)) {
  const bk = path.join(BACKUP_DIR, `synonyms-${new Date().toISOString().replace(/[:.]/g,'-')}.json`);
  fs.copyFileSync(SYN_FILE, bk);
  console.log('Previous synonyms backed up to', bk);
}

// Write out
fs.writeFileSync(SYN_FILE, JSON.stringify(synonyms, null, 2), 'utf8');
fs.writeFileSync(TOP_FILE, JSON.stringify(topTokens.slice(0,200), null, 2), 'utf8');

console.log('Wrote', SYN_FILE, 'and', TOP_FILE);
console.log('Top tokens sample:', topTokens.slice(0,20).map(t => `${t.token}(${t.count})`).join(', '));
process.exit(0);

