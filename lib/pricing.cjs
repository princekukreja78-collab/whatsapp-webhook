// ==================================================
// PRICING / CSV / SHEET FUNCTIONS — extracted from server.cjs
// ==================================================
// Usage:
//   const pricing = require('./lib/pricing.cjs');
//   pricing.init({ env: process.env, fetch, fs, path, DEBUG });
//   ... then call pricing.loadPricingFromSheets(), etc.

let _config = {};

function init(config) {
  _config = config || {};
}

// ==================================================
// PRICING SHEET CACHE (GLOBAL, IN-MEMORY)
// ==================================================
const SHEET_CACHE = new Map();
// key   → sheet URL
// value → { data, loadedAt }

const SHEET_CACHE_TTL = 30 * 60 * 1000; // 30 minutes (safe default)

function isSheetExpired(entry) {
  if (!entry || !entry.loadedAt) return true;
  return (Date.now() - entry.loadedAt) > SHEET_CACHE_TTL;
}

async function getPricingSheetCached(sheetUrl, brandKey = null) {
  if (!sheetUrl) return null;

  const cached = SHEET_CACHE.get(sheetUrl);
  if (cached && cached.data && !isSheetExpired(cached)) {
    return cached.data;
  }

  // First load or refresh
  const table = await loadPricingFromUrl(sheetUrl, brandKey);
  if (table) {
    SHEET_CACHE.set(sheetUrl, {
      data: table,
      loadedAt: Date.now()
    });
  }

  return table;
}

async function loadAllBrandSheetsCached() {
  const tables = {};
  const env = _config.env || {};

  for (const [envKey, envVal] of Object.entries(env)) {
    if (!envKey.endsWith('_SHEET_URL')) continue;
    if (!envVal) continue;

    const brand = envKey.replace('_SHEET_URL', '').toUpperCase();

    try {
      const table = await getPricingSheetCached(envVal, brand);
      if (table) {
        tables[brand] = table;
      }
    } catch (e) {
      console.warn(`Pricing sheet load failed for ${brand}:`, e?.message || e);
    }
  }

  return tables;
}

// ---------------- CSV parser ----------------
function parseCsv(text) {
  const rows = [];
  let cur = '';
  let row = [];
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQ = false;
        }
      } else {
        cur += ch;
      }
    } else {
      if (ch === '"') {
        inQ = true;
      } else if (ch === ',') {
        row.push(cur);
        cur = '';
      } else if (ch === '\n') {
        row.push(cur);
        rows.push(row);
        row = [];
        cur = '';
      } else if (ch !== '\r') {
        cur += ch;
      }
    }
  }
  if (cur.length || row.length) {
    row.push(cur);
    rows.push(row);
  }
  return rows;
}

async function fetchCsv(url) {
  if (!url) throw new Error('CSV URL missing');
  const fetchFn = _config.fetch || globalThis.fetch;
  const r = await fetchFn(url, { cache: 'no-store', redirect: 'follow' });
  if (!r.ok) throw new Error(`CSV fetch failed ${r.status}`);
  const txt = await r.text();
  return parseCsv(txt);
}

function toHeaderIndexMap(headerRow) {
  const map = {};
  headerRow.forEach((h, i) => {
    map[String((h || '').trim()).toUpperCase()] = i;
  });
  return map;
}
// ---------- PRICE INDEX FALLBACK helper ----------
function findPriceIndexFallback(header, tab) {
  if (!Array.isArray(header) || header.length === 0) return -1;

  for (let i = 0; i < header.length; i++) {
    const h = header[i] || '';
    if (/(ON[-_ ]?ROAD|ONROAD|ON[-_ ]?ROAD PRICE|ONROAD PRICE|OTR|ONR|PRICE)/i.test(h)) {
      return i;
    }
  }

  let bestIdx = -1;
  let bestCount = 0;
  if (!tab || !Array.isArray(tab.data)) return -1;

  for (let i = 0; i < header.length; i++) {
    let cnt = 0;
    for (const r of tab.data) {
      const v = String(r[i] || '').replace(/[,₹\s]/g, '');
      if (/^\d{4,}$/.test(v)) cnt++;
    }
    if (cnt > bestCount) {
      bestCount = cnt;
      bestIdx = i;
    }
  }

  return bestCount >= 2 ? bestIdx : -1;
}

// ---------- STATE RESOLUTION helper ----------
function resolveStateFromRow(row, idxMap) {
  if (!row || !idxMap) return 'UNKNOWN';

  const candidates = ['STATE', 'REGION', 'LOCATION', 'RTO', 'CITY'];
  for (const key of candidates) {
    const idx = idxMap[key];
    if (typeof idx === 'number' && idx >= 0) {
      const v = String(row[idx] || '').trim();
      if (v) return v.toUpperCase();
    }
  }
  return 'UNKNOWN';
}

// ---------------- normalization & helpers ----------------
function normForMatch(s) {
  return (s || '').toString().toLowerCase()
    .replace(/(automatic|automatic transmission|\bauto\b)/g, ' at ')
    .replace(/\bmanual\b/g, ' mt ')
    .replace(/(\d)\s*\/\s*(\d)/g, '$1x$2')
    .replace(/[\*\/\\]/g, 'x')
    .replace(/\s*x\s*/g, 'x')
    .replace(/(\d)\s*x\s*(\d)/g, '$1x$2')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ============================================================================
// MODEL ALIASES (SINGLE SOURCE OF TRUTH)
// MUST BE DEFINED BEFORE ANY USAGE
// ============================================================================

const MODEL_ALIASES_RAW = {
  'thar roxx':   ['tharroxx', 'thar roxx', 'roxx'],
  'scorpio n':   ['scorpio n', 'scorpion'],
  'scorpio classic': ['scorpio classic', 'classic scorpio'],
  'xuv 700':     ['xuv700', 'xuv 700'],
  'xuv 400':     ['xuv400', 'xuv 400', 'xuv 400 ev'],
  'be 6':        ['be6', 'be 6e', 'be 6 ev'],
  'bmw x5':      ['bmw x5', 'x5'],
  'bmw x7':      ['bmw x7', 'x7'],
  'wagon r':     ['wagonr', 'wagon r'],
  's presso':    ['spresso', 's presso'],
  'clavis ev':   ['clavis ev', 'clavis electric']
};

// aliasNorm → canonicalNorm
const MODEL_ALIAS_MAP = {};
for (const [canon, aliases] of Object.entries(MODEL_ALIASES_RAW)) {
  const canonNorm = normForMatch(canon);
  MODEL_ALIAS_MAP[canonNorm] = canonNorm;

  for (const a of aliases) {
    MODEL_ALIAS_MAP[normForMatch(a)] = canonNorm;
  }
}

function fmtMoney(n) {
  const x = Number(n || 0);
  if (!isFinite(x)) return '-';
  return x.toLocaleString('en-IN', { maximumFractionDigits: 0 });
}

function calcEmiSimple(p, annualRatePct, months) {
  const P = Number(p);
  const r = Number(annualRatePct) / 12 / 100;
  if (!P || !isFinite(r) || months <= 0) return 0;
  const pow = Math.pow(1 + r, months);
  const emi = Math.round(P * r * pow / (pow - 1));
  return emi;
}
function extractPanIndiaPricesFromRow(row, header) {
  const out = {};
  if (!Array.isArray(row) || !Array.isArray(header)) return out;

  for (let i = 0; i < header.length; i++) {
    const hRaw = String(header[i] || '').toUpperCase();

    // STRICT: only ON ROAD PRICE columns
    if (!hRaw.includes('ON ROAD PRICE')) continue;

    let state = null;

    if (hRaw.includes('DELHI')) state = 'DELHI';
    else if (hRaw.includes('HARYANA') || hRaw.includes('(HR)')) state = 'HARYANA';
    else if (hRaw.includes('UTTAR') || hRaw.includes('(U.P')) state = 'UTTAR PRADESH';
    else if (hRaw.includes('HIMACHAL') || hRaw.includes('(HP)')) state = 'HIMACHAL PRADESH';
    else if (hRaw.includes('CHANDIGARH')) state = 'CHANDIGARH';

    if (!state) continue;

    const val = Number(String(row[i] || '').replace(/[,₹\s]/g, ''));
    if (!val || val < 200000) continue;

    // If INDIVIDUAL & CORPORATE both exist, keep the lower one
    if (!out[state] || val < out[state]) {
      out[state] = val;
    }
  }

  return out;
}

// ================= PRICE BREAKUP =================

const STATE_ROAD_TAX_RATES = {
  'DELHI': 0.06, 'HARYANA': 0.06, 'UTTAR PRADESH': 0.08,
  'HIMACHAL PRADESH': 0.05, 'CHANDIGARH': 0.05, 'MAHARASHTRA': 0.11,
  'KARNATAKA': 0.11, 'TAMIL NADU': 0.10, 'TELANGANA': 0.12,
  'RAJASTHAN': 0.08, 'PUNJAB': 0.07, 'GUJARAT': 0.06,
  'KERALA': 0.07, 'WEST BENGAL': 0.07, 'MADHYA PRADESH': 0.08
};
const DEFAULT_ROAD_TAX_RATE = 0.08;

function extractBreakupFromCSV(row, header, stateMatch) {
  if (!row || !header || !header.length) return null;
  const idxMap = toHeaderIndexMap(header);
  const keys = Object.keys(idxMap);

  function parseVal(idx) {
    if (idx < 0 || !row || idx >= row.length) return 0;
    return Number(String(row[idx] || '0').replace(/[^0-9.\-]/g, '')) || 0;
  }

  const exShowIdx = detectExShowIdx(idxMap);
  if (exShowIdx < 0) return null;

  let tcsIdx = -1;
  for (const k of keys) { if (/\bTCS\b/.test(k)) { tcsIdx = idxMap[k]; break; } }

  let greenCessIdx = -1;
  for (const k of keys) { if (k.includes('GREEN') && k.includes('CESS')) { greenCessIdx = idxMap[k]; break; } }

  let insAllIdx = -1;
  for (const k of keys) {
    if (k.includes('INSURANCE') && k.includes('ALL') && k.includes('COVERAGE')) { insAllIdx = idxMap[k]; break; }
  }

  // Showroom insurance (column: "Insurance (Consumables G nil depreciation) #")
  let insShowroomIdx = -1;
  for (const k of keys) {
    if (k.includes('INSURANCE') && (k.includes('CONSUMABLE') || k.includes('DEPRECIATION')) && !k.includes('ALL')) { insShowroomIdx = idxMap[k]; break; }
  }

  let benefitIdx = -1;
  for (const k of keys) {
    if (k.includes('CUSTOMER') && k.includes('BENEFIT')) { benefitIdx = idxMap[k]; break; }
  }

  const normState = String(stateMatch || 'DELHI').toLowerCase().replace(/[^a-z]/g, '');
  const STATE_ABBREV = { 'himachalpradesh':'hp', 'uttarpradesh':'up', 'haryana':'hr', 'maharashtra':'mh', 'madhyapradesh':'mp', 'tamilnadu':'tn', 'karnataka':'ka', 'telangana':'ts', 'rajasthan':'rj', 'punjab':'pb', 'gujarat':'gj', 'kerala':'kl', 'westbengal':'wb', 'andhrapradesh':'ap', 'chandigarh':'ch' };
  const stateFirstWord = normState.match(/^[a-z]+/)?.[0] || normState;
  const stateAbbr = STATE_ABBREV[normState] || '';
  const stateTokens = [normState, stateFirstWord, stateAbbr].filter(Boolean);

  let roadTaxIdx = -1;
  const excludePatterns = ['onroad', 'insurance', 'exshowroom', 'showroom', 'specialpricing', 'customerbenefit', 'model', 'variant', 'colour', 'color', 'fuel', 'suffix', 'keyword', 're0'];
  for (const k of keys) {
    const normKey = k.toLowerCase().replace(/[^a-z]/g, '');
    if (excludePatterns.some(p => normKey.includes(p))) continue;
    if (!stateTokens.some(tok => normKey.includes(tok))) continue;
    if (normState === 'delhi' && (normKey.includes('corporate') || normKey.includes('company') || normKey.includes('firm'))) continue;
    roadTaxIdx = idxMap[k];
    break;
  }

  const onRoadIdx = pickOnRoadPriceIndex(idxMap, stateMatch, 'individual', stateMatch);

  const exShowroom = parseVal(exShowIdx);
  if (!exShowroom) return null;

  const tcs = parseVal(tcsIdx);
  const greenCess = parseVal(greenCessIdx);
  const roadTax = parseVal(roadTaxIdx);
  const insuranceAll = parseVal(insAllIdx);
  const insuranceShowroom = parseVal(insShowroomIdx);
  const customerBenefit = parseVal(benefitIdx);
  const onRoad = parseVal(onRoadIdx);

  const knownSum = exShowroom + tcs + greenCess + roadTax + insuranceAll - customerBenefit;
  const otherCharges = onRoad > knownSum ? (onRoad - knownSum) : 0;

  return {
    exShowroom, tcs, greenCess, roadTax, insuranceAll, insuranceShowroom,
    customerBenefit, otherCharges, total: onRoad,
    hasExactData: roadTaxIdx >= 0 && insAllIdx >= 0
  };
}

function calculatePriceBreakup(exShowroom, onRoad, state) {
  let exShow = Number(exShowroom) || 0;
  const onRoadVal = Number(onRoad) || 0;
  if (!exShow && onRoadVal) exShow = Math.round(onRoadVal * 0.85);
  if (!exShow) return null;

  const stateKey = (state || '').toUpperCase().trim();
  const taxRate = STATE_ROAD_TAX_RATES[stateKey] || DEFAULT_ROAD_TAX_RATE;

  const roadTax = Math.round(exShow * taxRate);
  const insuranceAll = Math.round(exShow * (exShow > 1000000 ? 0.03 : 0.025) * 0.70);
  const tcs = exShow > 1000000 ? Math.round(exShow * 0.01) : 0;
  const greenCess = 0;
  const customerBenefit = 0;
  const knownTotal = exShow + roadTax + insuranceAll + tcs + greenCess;
  const otherCharges = onRoadVal > knownTotal ? (onRoadVal - knownTotal) : 0;

  return {
    exShowroom: exShow, tcs, greenCess, roadTax, insuranceAll,
    customerBenefit, otherCharges,
    total: onRoadVal || (knownTotal + otherCharges),
    hasExactData: false
  };
}

function formatPriceBreakup(breakup, title, state) {
  if (!breakup) return 'Price breakup not available.';
  const lines = [];
  lines.push('*' + (title || 'Price Breakup') + '*');
  if (state) lines.push('📍 *State:* ' + state.toUpperCase());
  lines.push('');
  lines.push('📋 *Component-wise Breakup:*');
  lines.push('');
  lines.push('🏭 Ex-Showroom: ₹ ' + fmtMoney(breakup.exShowroom));
  lines.push('📑 TCS: ₹ ' + fmtMoney(breakup.tcs));
  if (breakup.greenCess > 0) lines.push('🌿 Green Cess: ₹ ' + fmtMoney(breakup.greenCess));
  lines.push('🛣️ Road Tax (incl. RTO/Reg/HSRP): ₹ ' + fmtMoney(breakup.roadTax));
  if (breakup.insuranceShowroom > 0 && breakup.insuranceAll > 0 && breakup.insuranceShowroom > breakup.insuranceAll) {
    lines.push('🛡️ Insurance (All Coverage): ₹ ' + fmtMoney(breakup.insuranceAll) + ' _(Showroom: ₹' + fmtMoney(breakup.insuranceShowroom) + ')_');
  } else {
    lines.push('🛡️ Insurance (All Coverage): ₹ ' + fmtMoney(breakup.insuranceAll));
  }
  if (breakup.otherCharges > 0) lines.push('📦 Other Charges: ₹ ' + fmtMoney(breakup.otherCharges));
  if (breakup.customerBenefit > 0) lines.push('🎁 Customer Benefit: - ₹ ' + fmtMoney(breakup.customerBenefit));
  lines.push('');
  lines.push('💰 *On-Road Price: ₹ ' + fmtMoney(breakup.total) + '*');
  lines.push('');
  lines.push('_Insurance includes 0-dep + consumables at best rates (~30% less vs showroom)._');
  if (!breakup.hasExactData) lines.push('_Breakup is estimated. Actual may vary._');
  return lines.join('\n');
}

// ---------------- pricing loader (NEW CARS) ----------------
// Auto-detect all SHEET_*_CSV_URL env vars, so new brands work without code change.
function _buildSheetUrls() {
  const env = _config.env || {};
  const urls = {};

  // 1) Keep explicit mapping for known brands (backwards-compatible)
  const explicit = {
    HOT:      env.SHEET_HOT_DEALS_CSV_URL,
    TOYOTA:   env.SHEET_TOYOTA_CSV_URL,
    HYUNDAI:  env.SHEET_HYUNDAI_CSV_URL,
    MERCEDES: env.SHEET_MERCEDES_CSV_URL,
    BMW:      env.SHEET_BMW_CSV_URL
  };

  for (const [brand, val] of Object.entries(explicit)) {
    if (val) urls[brand] = val.trim();
  }

  // 2) Auto-discover any SHEET_<BRAND>_CSV_URL (e.g. SHEET_MAHINDRA_CSV_URL)
  for (const [envKey, value] of Object.entries(env)) {
    if (!value) continue;
    const m = envKey.match(/^SHEET_([A-Z0-9]+)_CSV_URL$/);
    if (!m) continue;
    const brandKey = m[1]; // e.g. TOYOTA, HYUNDAI, BMW, MAHINDRA, MG
    if (!urls[brandKey]) {
      urls[brandKey] = value.trim();
    }
  }

  return urls;
}

const PRICING_CACHE = { tables: null, ts: 0 };
const PRICING_CACHE_MS = 3 * 60 * 1000;

async function loadPricingFromSheets() {
  const now = Date.now();
  if (PRICING_CACHE.tables && now - PRICING_CACHE.ts < PRICING_CACHE_MS) {
    return PRICING_CACHE.tables;
  }
  const SHEET_URLS = _buildSheetUrls();
  const tables = {};
  for (const [brand, url] of Object.entries(SHEET_URLS)) {
    if (!url) continue;
    try {
      const rows = await fetchCsv(url);
      if (!rows || !rows.length) continue;
      const header = rows[0].map(h => String(h || '').trim());
      const idxMap = toHeaderIndexMap(header);
      const data   = rows.slice(1);
      tables[brand] = { header, idxMap, data };
    } catch (e) {
      console.warn('CSV load failed for', brand, e && e.message ? e.message : e);
    }
  }
  PRICING_CACHE.tables = tables;
  PRICING_CACHE.ts = Date.now();
  return tables;
}

// NOTE: loadPricingFromUrl is called by getPricingSheetCached but was not
// defined in server.cjs. It follows the same pattern as loadPricingFromSheets
// for a single URL. Providing a matching implementation:
async function loadPricingFromUrl(sheetUrl, brandKey) {
  if (!sheetUrl) return null;
  const rows = await fetchCsv(sheetUrl);
  if (!rows || !rows.length) return null;
  const header = rows[0].map(h => String(h || '').trim());
  const idxMap = toHeaderIndexMap(header);
  const data   = rows.slice(1);
  return { header, idxMap, data };
}

function detectExShowIdx(idxMap) {
  const keys = Object.keys(idxMap || {});
  for (const k of keys) {
    if (/EX[\s\-_\/A-Z0-9]*SHOWROOM/.test(String(k))) return idxMap[k];
  }
  const lowerKeys = keys.map(k => k.toLowerCase());
  const i = lowerKeys.findIndex(k => k.includes('ex') && k.includes('showroom'));
  if (i >= 0) return idxMap[keys[i]];
  return -1;
}
// ---- NEW CAR HELPERS: fuel type + on-road price column ----
function pickFuelIndex(idxMap) {
  const keys = Object.keys(idxMap || {});
  for (const k of keys) {
    const kl = k.toLowerCase();
    if (kl.includes('fuel') && kl.includes('type')) {
      return idxMap[k];
    }
  }
  return -1;
}

// audience = 'individual' | 'corporate', cityToken e.g. 'DELHI'
function pickOnRoadPriceIndex(idxMap, cityToken, audience, stateMatch) {
  const keys = Object.keys(idxMap || {});
  const cityLower = String(cityToken || '').toLowerCase();
  const aud = String(audience || '').toLowerCase();

  let best = null;

  // ---- STEP-3: STATE-AWARE PRIORITY (NORMALIZED MATCH) ----
if (stateMatch) {
  const normState = String(stateMatch)
    .toLowerCase()
    .replace(/[^a-z]/g, ''); // remove spaces, brackets, dots

  for (const k of keys) {
    const normKey = String(k)
      .toLowerCase()
      .replace(/[^a-z]/g, '');

    if (
      normKey.includes('onroadprice') &&
      normKey.includes(normState)
    ) {
      return idxMap[k];
    }
  }
}

  function scoreKey(k) {
    const kl = k.toLowerCase();
    let s = 0;

    // Strong signals: "on road" + city
    if (kl.includes('on road') || (kl.includes('on') && kl.includes('road'))) s += 5;
    if (cityLower && kl.includes(cityLower)) s += 4;

    // Audience-specific scoring
    if (aud) {
      if (aud === 'corporate') {
        if (kl.includes('corporate') || kl.includes('company') || kl.includes('firm') || kl.includes('corp')) {
          s += 6;
        }
      } else if (aud === 'individual') {
        if (kl.includes('individual') || kl.includes('retail') || kl.includes('personal')) {
          s += 6;
        }
      }
    } else {
      // No explicit audience → slight bias to individual
      if (kl.includes('individual') || kl.includes('retail') || kl.includes('personal')) s += 2;
      if (kl.includes('corporate') || kl.includes('company') || kl.includes('firm') || kl.includes('corp')) s -= 1;
    }

    return s;
  }

  for (const k of keys) {
    const s = scoreKey(k);
    if (s <= 0) continue;
    if (!best || s > best.score) {
      best = { key: k, score: s };
    }
  }

  if (best) {
    return idxMap[best.key];
  }

  // Fallback: any column with city + 'road'
  for (const k of keys) {
    const kl = k.toLowerCase();
    if (cityLower && kl.includes(cityLower) && kl.includes('road')) {
      return idxMap[k];
    }
  }

  // Final fallback: any 'on road' column
  for (const k of keys) {
    const kl = k.toLowerCase();
    if (kl.includes('on road') || (kl.includes('on') && kl.includes('road'))) {
      return idxMap[k];
    }
  }

  return -1;
}

// ---------------- USED sheet loader ----------------
async function loadUsedSheetRows() {
  const env = _config.env || {};
  const fs = _config.fs;
  const path = _config.path;
  const DEBUG = _config.DEBUG;

  const SHEET_USED_CSV_URL = (env.SHEET_USED_CSV_URL || env.USED_CAR_CSV_URL || '').trim();
  const LOCAL_USED_CSV_PATH = path ? path.resolve(path.dirname(require.main?.filename || __filename), 'PRE OWNED CAR PRICING - USED CAR.csv') : '';

  if (SHEET_USED_CSV_URL) {
    try {
      const rows = await fetchCsv(SHEET_USED_CSV_URL);
      if (rows && rows.length) return rows;
    } catch (e) {
      if (DEBUG) console.warn('remote used csv fetch failed', e && e.message ? e.message : e);
    }
  }
  try {
    if (fs && LOCAL_USED_CSV_PATH && fs.existsSync(LOCAL_USED_CSV_PATH)) {
      const txt = fs.readFileSync(LOCAL_USED_CSV_PATH, 'utf8');
      const rows = parseCsv(txt);
      if (rows && rows.length) return rows;
    }
  } catch (e) {
    if (DEBUG) console.warn('local used csv read failed', e && e.message ? e.message : e);
  }
  return [];
}

// Simulate a bullet loan plan for MR.CAR.
// - amount: loan amount
// - rate: annual ROI %, if missing defaults to 10
// - months: tenure in months, if missing defaults to 60
// - bulletPct: fraction (0.25 = 25%), defaults to 0.25
function simulateBulletPlan({ amount, rate, months, bulletPct }) {
  const L   = Number(amount || 0);            // loan amount
  const R   = Number(rate || 10);             // use 10% if not provided
  const n   = Number(months || 60);           // default 60 months
  const pct = (bulletPct !== undefined && bulletPct !== null)
    ? Number(bulletPct)
    : 0.25;                                   // default 25%

  if (!L || !n || !pct) {
    return null;
  }

  const bullet_total = L * pct;               // bullet principal total
  const principal_for_emi = L - bullet_total; // EMI principal only

  const r = R / 12 / 100;                     // monthly rate

  // Base EMI on non-bullet principal
  let base_emi = 0;
  if (principal_for_emi > 0 && r > 0) {
    const pow = Math.pow(1 + r, n);
    base_emi = (principal_for_emi * r * pow) / (pow - 1);
  } else if (principal_for_emi > 0 && n > 0) {
    base_emi = principal_for_emi / n;
  }

  // Number of bullets: yearly bullets within tenure
  const num_bullets = Math.max(1, Math.floor(n / 12));
  const bullet_each = bullet_total / num_bullets;

  let remainingBullet     = bullet_total;
  let total_emi_paid      = 0;
  let total_bullets_paid  = 0;
  let monthly_emi_example = 0;

  for (let m = 1; m <= n; m++) {
    // Interest on remaining bullet principal this month
    const bulletInterestThisMonth = remainingBullet * r;

    const paymentThisMonth = base_emi + bulletInterestThisMonth;
    total_emi_paid += paymentThisMonth;

    // Pay one bullet principal chunk every 12 months
    if (m % 12 === 0 && remainingBullet > 0) {
      const pay = Math.min(bullet_each, remainingBullet);
      remainingBullet    -= pay;
      total_bullets_paid += pay;
    }

    if (m === 1) {
      monthly_emi_example = Math.round(paymentThisMonth);
    }
  }

  const total_payable = Math.round(total_emi_paid + total_bullets_paid);

  return {
    loan: Math.round(L),
    rate: R,
    months: n,
    bulletPct: pct,

    principal_for_emi: Math.round(principal_for_emi),

    // for display as "Monthly EMI (approx)"
    monthly_emi: Math.round(monthly_emi_example),
    base_emi: Math.round(base_emi),

    bullet_total: Math.round(bullet_total),
    num_bullets,
    bullet_each: Math.round(bullet_each),

    total_emi_paid: Math.round(total_emi_paid),
    total_bullets_paid: Math.round(total_bullets_paid),
    total_payable
  };
}

// ==================================================
// EXPORTS
// ==================================================
module.exports = {
  init,

  // Cache
  SHEET_CACHE,
  SHEET_CACHE_TTL,
  isSheetExpired,
  getPricingSheetCached,
  loadAllBrandSheetsCached,

  // CSV
  parseCsv,
  fetchCsv,
  toHeaderIndexMap,
  findPriceIndexFallback,

  // State
  resolveStateFromRow,

  // Normalization & helpers
  normForMatch,
  MODEL_ALIASES_RAW,
  MODEL_ALIAS_MAP,
  fmtMoney,
  calcEmiSimple,
  extractPanIndiaPricesFromRow,

  // Price breakup
  extractBreakupFromCSV,
  calculatePriceBreakup,
  formatPriceBreakup,

  // Pricing loader
  PRICING_CACHE,
  PRICING_CACHE_MS,
  loadPricingFromSheets,
  loadPricingFromUrl,

  // New car helpers
  detectExShowIdx,
  pickFuelIndex,
  pickOnRoadPriceIndex,

  // Used cars
  loadUsedSheetRows,

  // Bullet plan
  simulateBulletPlan,

  // Internal (exposed for flexibility)
  _buildSheetUrls
};
