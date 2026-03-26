const { normForMatch, MODEL_ALIAS_MAP } = require('./pricing.cjs');

/* ===== SUFFIX MATCH PATCH (ZXO / VXO / GXO with loose matching) ===== */

// canonical list – longest-first will be applied below
const SPECIAL_SUFFIXES_RAW = ['zxo','vxo','gxo','zx','vx','gx'];

function _makeLoosePat(s) {
  const clean = String(s||"").toLowerCase().replace(/[^a-z0-9]/g,"");
  const parts = clean.split("").map(ch => ch.replace(/[-\/\\^$*+?.()|[\]{}]/g,"\\$&") + "[\\s\\-\\.]*");
  return new RegExp("\\b" + parts.join("") + "\\b");
}

// override userSuffix detection
function detectUserSuffix(userNorm) {
  const specialSuffixes = SPECIAL_SUFFIXES_RAW.slice().sort((a,b)=>b.length - a.length);
  for (const sfx of specialSuffixes) {
    try {
      const pat = _makeLoosePat(sfx);
      if (pat.test(userNorm)) return sfx;
    } catch(e) {
      if (userNorm.includes(sfx)) return sfx;
    }
  }
  return null;
}

// override row suffix detection
function rowHasSuffix(variantNorm, suffixNorm, varKwNorm) {
  const specialSuffixes = SPECIAL_SUFFIXES_RAW.slice().sort((a,b)=>b.length - a.length);
  try {
    for (const sfx of specialSuffixes) {
      const pat = _makeLoosePat(sfx);
      if (pat.test(variantNorm||"") || pat.test(suffixNorm||"") || pat.test(varKwNorm||"")) {
        return true;
      }
    }
  } catch(e) {
    for (const sfx of specialSuffixes) {
      if ((variantNorm||"").includes(sfx) || (suffixNorm||"").includes(sfx) || (varKwNorm||"").includes(sfx))
        return true;
    }
  }
  return false;
}

/* ===== END SUFFIX MATCH PATCH ===== */
// ============================================================================
// AUTO-DISCOVERED BRAND & MODEL DETECTION (SHEET-DRIVEN, INDIA-WIDE)
// ============================================================================

// Global registries (populated once pricing sheets are loaded)
const GLOBAL_BRAND_SET   = new Set();
const GLOBAL_MODEL_SET   = new Set();
const GLOBAL_MODEL_BRAND = {}; // modelNorm -> BRAND

function buildGlobalRegistryFromSheets(tables) {
  if (!tables || typeof tables !== 'object') return;

  for (const [brandKey, tab] of Object.entries(tables)) {
    if (!tab || !Array.isArray(tab.data)) continue;

    const BRAND = String(brandKey).toUpperCase().trim();
    GLOBAL_BRAND_SET.add(BRAND);

    const header = (tab.header || []).map(h => String(h || '').toUpperCase());
    const idxModel = header.findIndex(h => h.includes('MODEL'));

    if (idxModel < 0) continue;

    for (const row of tab.data) {
      if (!row || !row[idxModel]) continue;

     const modelRaw  = String(row[idxModel]).trim();
let modelNorm = normForMatch(modelRaw);

// Apply canonical alias if present
if (MODEL_ALIAS_MAP[modelNorm]) {
  modelNorm = MODEL_ALIAS_MAP[modelNorm];
}

if (!modelNorm) continue;

// ---- BASE MODEL (CONTROLLED & SAFE) ----
const parts = modelNorm.split(' ');
let baseModel = null;

// Allow single-token models (e.g. Thar, Fortuner)
if (parts.length === 1) {
  baseModel = parts[0];
}
// Allow two-word alphabetic base models for luxury brands (E CLASS, C CLASS, S CLASS)
if (
  parts.length === 2 &&
  /^[a-z]+$/.test(parts[0]) &&
  /^[a-z]+$/.test(parts[1]) &&
  BRAND === 'MERCEDES'
) {
  baseModel = parts.join(' ');
}

// Allow numeric two-token models ONLY for known compact families
if (
  parts.length === 2 &&
  /^\d+$/.test(parts[1]) &&
  /^(xuv|be|x)$/i.test(parts[0])
) {
  baseModel = parts.join(' ');
}

GLOBAL_MODEL_SET.add(modelNorm);
GLOBAL_MODEL_BRAND[modelNorm] = BRAND;

if (baseModel && baseModel.length >= 3) {
  GLOBAL_MODEL_SET.add(baseModel);
  if (!GLOBAL_MODEL_BRAND[baseModel]) {
    GLOBAL_MODEL_BRAND[baseModel] = BRAND;
  }
}

// ---- REGISTER BASE MODEL (NON-AGGRESSIVE) ----
if (baseModel && baseModel.length >= 3) {
  GLOBAL_MODEL_SET.add(baseModel);
  if (!GLOBAL_MODEL_BRAND[baseModel]) {
    GLOBAL_MODEL_BRAND[baseModel] = BRAND;
  }
}


    }
  }

  if (typeof DEBUG !== 'undefined' && DEBUG) {
    console.log(
      `[GLOBAL REGISTRY] Brands=${GLOBAL_BRAND_SET.size}, Models=${GLOBAL_MODEL_SET.size}`
    );
  }
}
function normalizeCompactModel(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/-/g, '');
}

// -------- Detect brand from text (NO hardcoding) --------
function detectBrandFromText(text) {
  const t = normForMatch(text);

  // 1️⃣ Explicit brand words
  for (const brand of GLOBAL_BRAND_SET) {
    if (t.includes(normForMatch(brand))) return brand;
  }

  // 2️⃣ Infer brand from model name
  for (const model of GLOBAL_MODEL_SET) {
    if (t.includes(model)) {
      return GLOBAL_MODEL_BRAND[model] || null;
    }
  }

  return null;
}

// -------- Detect models from text (for comparison, logging, etc.) --------
function detectModelsFromText(text) {
  const t = normForMatch(text);
  const found = [];

  for (const model of GLOBAL_MODEL_SET) {
    if (t.includes(model)) found.push(model);
  }

  return Array.from(new Set(found)).slice(0, 3);
}

module.exports = { SPECIAL_SUFFIXES_RAW, _makeLoosePat, detectUserSuffix, rowHasSuffix, GLOBAL_BRAND_SET, GLOBAL_MODEL_SET, GLOBAL_MODEL_BRAND, buildGlobalRegistryFromSheets, normalizeCompactModel, detectBrandFromText, detectModelsFromText };
