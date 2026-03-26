// ==================================================
// QUOTE FUNCTIONS — extracted from server.cjs
// ==================================================
// Usage:
//   const quotes = require('./lib/quotes.cjs');
//   quotes.init({ waSendText, waSendRaw, sendNewCarButtons, setLastService, getLastService,
//                 incrementQuoteUsage, canSendQuote, DEBUG, NEW_CAR_ROI, SIGNATURE_MODEL,
//                 callSignatureBrain, isAdvisory, findRelevantBrochures, loadBrochureIndex,
//                 extractModelsForComparisonFallback, findPhonesInBrochures,
//                 SignatureAI_RAG, findRelevantChunks, CITY_TO_STATE, BRAND_HINTS, MODEL_ALIASES });
//   ... then call quotes.trySmartNewCarIntent(msgText, to), etc.

const pricing = require('./pricing.cjs');
const brands = require('./brands.cjs');

const {
  normForMatch, fmtMoney, calcEmiSimple, loadPricingFromSheets,
  extractPanIndiaPricesFromRow, detectExShowIdx, pickFuelIndex,
  pickOnRoadPriceIndex, findPriceIndexFallback, resolveStateFromRow,
  simulateBulletPlan, MODEL_ALIAS_MAP, parseCsv, fetchCsv, toHeaderIndexMap
} = pricing;

const {
  detectBrandFromText, detectModelsFromText, detectUserSuffix, rowHasSuffix,
  _makeLoosePat, GLOBAL_BRAND_SET, GLOBAL_MODEL_SET, GLOBAL_MODEL_BRAND,
  SPECIAL_SUFFIXES_RAW, buildGlobalRegistryFromSheets, normalizeCompactModel
} = brands;

let _config = {};

function init(config) {
  _config = config || {};
}

// ============================================================================
// SMART NEW-CAR INTENT ENGINE + ENHANCED tryQuickNewCarQuote (FULL REPLACEMENT)
// - Adaptive min-score, normalized comparisons, brand alias strengthening,
//   softer suffix penalties, robust price index fallback, improved RAG/spec retry,
//   capped relaxed matches and improved debug logs.
// NOTE: relies on existing runtime helpers listed earlier in your system.
// ============================================================================

/* eslint-disable no-unused-vars */

async function trySmartNewCarIntent(msgText, to) {
  console.log("EXEC_PATH: trySmartNewCarIntent HIT", msgText);
  if (!msgText) return false;

  // ================= PAN-INDIA YES / NO HANDLER =================
  const panSvc = (_config.getLastService(to) || '').toUpperCase();

  if (panSvc === 'PAN_INDIA_PROMPT') {
    const reply = String(msgText || '').trim().toLowerCase();
    const isYes = reply === 'yes' || reply === 'y';
    const isNo  = reply === 'no'  || reply === 'n';

    // HARD GUARD: accept ONLY pure YES / NO
    if (reply.includes(' ') || reply.length > 3) {
      await _config.waSendText(to, 'Please reply with *YES* or *NO* only.');
      return true; // 🔒 HARD STOP
    }

    // YES → show Pan-India pricing
    if (isYes) {
      const ctx = global.panIndiaPrompt && global.panIndiaPrompt.get(to);

      if (!ctx || !ctx.row || !ctx.header) {
        await _config.waSendText(
          to,
          'Sorry, I could not retrieve the variant again. Please ask for the quote once more.'
        );
        _config.setLastService(to, 'NEW');
        return true;
      }

      const aggregate = extractPanIndiaPricesFromRow(ctx.row, ctx.header);
      const states = Object.keys(aggregate || {});

      if (!states.length) {
        await _config.waSendText(
          to,
          'State-wise pricing is not available for this variant.'
        );
        global.panIndiaPrompt.delete(to);
        _config.setLastService(to, 'NEW');
        return true;
      }

      states.sort((a, b) => aggregate[a] - aggregate[b]);

      const out = [];
      out.push(`*${ctx.title} — Pan-India On-Road Pricing*`);
      out.push('');
      out.push(`✅ *Lowest:* ${states[0]} — ₹ ${fmtMoney(aggregate[states[0]])}`);
      out.push(`❌ *Highest:* ${states[states.length - 1]} — ₹ ${fmtMoney(aggregate[states[states.length - 1]])}`);
      out.push('');
      out.push('*State-wise prices:*');

      states.forEach(st => {
        out.push(`• *${st}* → ₹ ${fmtMoney(aggregate[st])}`);
      });

      await _config.waSendText(to, out.join('\n'));

      global.panIndiaPrompt.delete(to);
      _config.setLastService(to, 'NEW');
      return true; // 🔒 HARD STOP
    }

    // NO → clean exit
    if (isNo) {
      await _config.waSendText(
        to,
        'No problem 👍 Let me know if you want EMI options, specs, or another quote.'
      );

      global.panIndiaPrompt.delete(to);
      _config.setLastService(to, 'NEW');
      return true; // 🔒 HARD STOP
    }

    // Anything else → prompt again
    await _config.waSendText(to, 'Please reply with *YES* or *NO*.');
    return true; // 🔒 HARD STOP
  }

  // 👇 ONLY AFTER THIS SHOULD NORMAL INTENT LOGIC RUN
  const tRaw = String(msgText || "");
  let t = tRaw.toLowerCase().trim();

// --------------------------------------------------
// FORCE AUTOMATIC INTO userNorm (CRITICAL FIX)
// --------------------------------------------------
if (/\bautomatic\b/.test(t) && !userNorm.includes('at')) {
  userNorm += ' at';
}

// --------------------------------------------------
// SAFE BUDGET INITIALISATION (MUST EXIST FOR ALL PATHS)
// --------------------------------------------------
let userBudget = null;
try {
  userBudget = parseBudgetFromText(t);
} catch (e) {
  userBudget = null;
}

// -------- DRIVETRAIN NORMALIZATION (SAFE & ADDITIVE) --------
t = t.replace(/\b4\s*x\s*2\b/g, '4/2');
t = t.replace(/\b4\s*\*\s*2\b/g, '4/2');

t = t.replace(/\b4\s*\/\s*4\b/g, '4x4');
t = t.replace(/\b4\s*\*\s*4\b/g, '4x4');

// ================= LOAN CONTEXT HARD GUARD =================
// If user is already in LOAN flow, NEVER enter pricing/budget logic
const lastSvc = (_config.getLastService(to) || '').toLowerCase();

if (
  lastSvc.includes('loan') &&
  /emi|loan|finance|lakh|lac|₹|\d{5,}/i.test(t)
) {
  if (_config.DEBUG) console.log('LOAN CONTEXT LOCK → bypass pricing/budget', { t, lastSvc });

  await _config.waSendText(
    to,
    '💰 *EMI Calculation*\n\n' +
    'Please share:\n' +
    '• *Loan amount*\n' +
    '• *Tenure* (up to 7 years)\n\n' +
    'Examples:\n' +
    '• `10 lakh 5 years`\n' +
    '• `₹12,00,000 60`\n' +
    '• `1200000 5`\n\n' +
    '_Interest rate will be applied automatically._'
  );

  return true; // ⛔ STOP everything else
}
// ============================================================

// --------------------------------------------------
// INTENT GUARDS — MUST BE DEFINED FIRST
// --------------------------------------------------
const hasPricingIntent =
  !lastSvc.includes('loan') && // 🔒 KEY FIX
  /\b(price|prices|pricing|on[- ]?road|quote|cost|deal|offer)\b/i.test(t);

const wantsAllStates =
  /\b(all states|pan india|india wide|state wise|across states|all india)\b/i.test(t);

const hasComparisonIntent =
  /\b(vs|compare|comparison|difference|better|which is better)\b/i.test(t);

const wantsSpecs =
  /\b(spec|specs|specification|specifications|feature|features)\b/i.test(t);

const wantsModelList =
  /\b(models?|variants?|available cars?|car list|show models|what cars|portfolio|lineup)\b/i.test(t);

const explicitStatePricingIntent =
  /\b(price in|on[- ]?road in|cost in|rate in)\b/i.test(t);

const hasVariantLock =
  /\b(4x4|4\/2|4x2|automatic|auto|at|mt)\b/i.test(t);

// ---------------- DEBUG: INTENT SNAPSHOT ----------------
if (_config.DEBUG) {
  console.log('DEBUG_INTENT_SNAPSHOT:', {
    text: t,
    wantsModelList,
    hasPricingIntent,
    hasComparisonIntent,
    wantsSpecs,
    wantsAllStates,
    lastSvc
  });
}
// --------------------------------------------------
// SAFE LOCATION BOOTSTRAP — REQUIRED FOR BUDGET FLOW
// --------------------------------------------------
const safeCity =
  (typeof city === 'string' && city.trim())
    ? city.trim()
    : 'Delhi';

const cityToken = safeCity.split(' ')[0].toUpperCase();

// PAN-INDIA safe default (budget flow does not depend on exact state)
const stateMatch = 'DELHI';

// ======================================================
// HARD EXIT: MODEL LIST REQUEST (STOP BEFORE QUOTE ENGINE)
// ======================================================
if (
  wantsModelList &&
  !hasPricingIntent &&
  !hasComparisonIntent &&
  !wantsSpecs &&
  !wantsAllStates
) {
  if (_config.DEBUG) console.log('HARD_EXIT_MODEL_LIST');

  try {
    const tables = await loadPricingFromSheets();
    const modelSet = new Set();

    // simple brand detection from text (do NOT rely on brandGuess)
    const tUpper = t.toUpperCase();

    for (const [brand, tab] of Object.entries(tables || {})) {
      if (!tab || !tab.data || !tab.header) continue;

      // If user typed "toyota models", enforce brand here
      if (tUpper.includes(brand)) {
        // allowed
      } else if (/\bmodels?\b/.test(tUpper)) {
        continue; // skip other brands
      }

      const header = tab.header.map(h => String(h || '').toUpperCase());
      const idxModel = header.findIndex(h => h.includes('MODEL'));
      if (idxModel < 0) continue;

      for (const row of tab.data) {
        if (row[idxModel]) {
          modelSet.add(String(row[idxModel]).trim());
        }
      }
    }

    if (modelSet.size) {
      const models = Array.from(modelSet).sort();
      const out = [];

      out.push('*Available Models*');
      out.push('');
      models.forEach(m => out.push(`• ${m}`));
      out.push('');
      out.push('Reply with the *model name* to see variants, prices & offers.');

      await _config.waSendText(to, out.join('\n'));
      _config.setLastService(to, 'NEW');
      return true; // ⛔ THIS IS THE KEY
    }
  } catch (e) {
    console.warn('MODEL_LIST_HARD_EXIT_FAILED:', e?.message || e);
  }
}

// --------------------------------------------------
// SEGMENT INTENT FLAGS (REQUIRED FOR BUDGET ENGINE)
// --------------------------------------------------
const wantsSUV   = /\b(suv|crossover)\b/i.test(t);
const wantsSedan = /\b(sedan)\b/i.test(t);
const wantsHatch = /\b(hatch|hatchback)\b/i.test(t);
const wantsMPV   = /\b(mpv|7 seater|7-seater|people mover)\b/i.test(t);

// --------------------------------------------------
// INTENT PRIORITY NORMALISER (CRITICAL)
// --------------------------------------------------

if (hasPricingIntent || hasVariantLock || wantsAllStates) {
  if (_config.DEBUG) {
    console.log('INTENT_PRIORITY: PRICE_OR_VARIANT_OR_PAN_INDIA', {
      hasPricingIntent,
      hasVariantLock,
      wantsAllStates
    });
  }
  // Let quote engine handle it
}
// --------------------------------------------------
// HARD BLOCK: PAN-INDIA MUST NOT ENTER BUDGET FLOW
// --------------------------------------------------
if (wantsAllStates) {
  if (_config.DEBUG) console.log('PAN-INDIA REQUEST → skipping budget & advisory flows');
  return false; // hand over to tryQuickNewCarQuote
}
// ======================================================
// HARD OVERRIDE: EXPLICIT MODEL LIST REQUEST
// (MUST RUN BEFORE ANY MATCHING / SCORING)
// ======================================================
if (
  wantsModelList &&
  !hasPricingIntent &&
  !hasComparisonIntent &&
  !wantsSpecs
) {
  if (_config.DEBUG) console.log('MODEL_LIST_OVERRIDE_TRIGGERED');

  try {
    const tables = await loadPricingFromSheets();
    const modelSet = new Set();

    for (const [brand, tab] of Object.entries(tables || {})) {
      if (!tab || !tab.data || !tab.header) continue;

      // Respect brand filter if detected (e.g. "toyota models")
      if (brandGuess && brand !== String(brandGuess).toUpperCase()) continue;

      const header = tab.header.map(h => String(h || '').toUpperCase());
      const idxModel = header.findIndex(h => h.includes('MODEL'));
      if (idxModel < 0) continue;

      for (const row of tab.data) {
        if (row[idxModel]) {
          modelSet.add(String(row[idxModel]).trim());
        }
      }
    }

    if (modelSet.size) {
      const models = Array.from(modelSet).sort();
      const out = [];

      const brandLabel = brandGuess
        ? String(brandGuess).toUpperCase()
        : 'Available';

      out.push(`*${brandLabel} Models*`);
      out.push('');

      models.forEach(m => out.push(`• ${m}`));

      out.push('');
      out.push('Reply with the *model name* to see variants, prices & offers.');

      await _config.waSendText(to, out.join('\n'));
      _config.setLastService(to, 'NEW');
      return true; // ⛔ ABSOLUTE STOP — NO MATCHING AFTER THIS
    }
  } catch (e) {
    console.warn('MODEL_LIST_OVERRIDE_FAILED:', e?.message || e);
  }
}

 // ---------- PRICE INDEX FALLBACK helper ----------
function findPriceIndexFallback(header, tab) {
  // header: array of header strings (uppercased)
  // tab: table object containing .data (rows)
  if (!Array.isArray(header) || header.length === 0) return -1;

  // common header patterns first
  for (let i = 0; i < header.length; i++) {
    const h = header[i] || '';
    if (/(ON[-_ ]?ROAD|ONROAD|ON[-_ ]?ROAD PRICE|ONROAD PRICE|OTR|ON-RD|ONR|ONROAD₹|ONSITE PRICE|ONROADAMOUNT|PRICE)/i.test(h)) return i;
    if (/(ON[-_ ]?ROAD|ONROAD|PRICE|AMOUNT)/i.test(h) && /₹|rs|inr/i.test(String(header[i+1] || ''))) return i;
  }

  // fallback: pick the column with the most numeric cells (likely a price column)
  let bestIdx = -1;
  let bestCount = 0;
  for (let i = 0; i < header.length; i++) {
    let cnt = 0;
    if (!tab || !Array.isArray(tab.data)) continue;
    for (const r of tab.data) {
      const v = String(r[i] || '').replace(/[,₹\s]/g, '');
      if (/^\d{4,}$/.test(v)) cnt++; // number with 4+ digits likely a price
    }
    if (cnt > bestCount) { bestCount = cnt; bestIdx = i; }
  }
  // require at least 2 numeric occurrences to be considered valid
  return bestCount >= 2 ? bestIdx : -1;
}
// ---------- end PRICE INDEX FALLBACK helper ----------
// ---------- STATE RESOLUTION helper (PAN-INDIA SAFE) ----------
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
// ---------- end STATE RESOLUTION helper ----------

  // ------------------------------
  // DICTIONARIES
  // ------------------------------
  const FEATURE_TOPICS = [
    "adas","cvt","automatic","mt","diesel","hybrid","ev","awd","4x4","cruise","toyota safety sense",
    "airbags","turbo","sunroof","engine","mileage","bs6","e20"
  ];

 // ======================================================
// 1️⃣ COMPARISON INTENT (MINIMAL, SAFE)
// ======================================================
if (hasComparisonIntent && !wantsAllStates) {

  let foundModels = [];

if (typeof detectModelsFromText === 'function') {
  foundModels = await detectModelsFromText(t);
}

// 🔁 FALLBACK: simple text-based extraction
if (!Array.isArray(foundModels) || foundModels.length < 2) {
  foundModels = _config.extractModelsForComparisonFallback(t);
}
  if (Array.isArray(foundModels) && foundModels.length >= 2) {
    const m1 = foundModels[0];
    const m2 = foundModels[1];

    const out = [];
    out.push(`*${m1} vs ${m2} — Quick Comparison*`);
    out.push('');
    out.push('• *Price:* Depends on variant & city');
    out.push('• *Engine & performance:* Varies by powertrain');
    out.push('• *Mileage:* Differs by fuel type');
    out.push('• *Features & safety:* Variant-dependent');
    out.push('• *Comfort & space:* Segment-specific');
    out.push('');
    out.push('Reply with *PRICE*, *SPEC*, or *COMPARE VARIANTS* to go deeper.');

    await _config.waSendText(to, out.join('\n'));
    _config.setLastService(to, 'NEW');
    return true; // ⛔ HARD STOP
  }

  await _config.waSendText(
    to,
    'Please tell me the two models to compare (example: *Creta vs Hyryder*).'
  );
  return true;
}

// 🔒 GUARD: Skip NEW-car budget when USED-car intent is active
if (
  lastSvc &&
  typeof lastSvc === 'string' &&
  lastSvc.includes('used')
) {
  // do nothing — let USED-car flow handle it
} else {

  // ------------------------------
  // 2️⃣ BUDGET INTENT (SUV / Sedan / Hatch)
  // ------------------------------
  let budget = null;
  const budgetMatch = t.match(/\b(\d{1,2})\s?(lakh|lakhs|lac|lacs)\b/);
  if (budgetMatch) budget = Number(budgetMatch[1]) * 100000;
  else {
    const priceNumber = t.match(/\b(\d{5,7})\b/);
    if (priceNumber) {
      const v = Number(priceNumber[1]);
      if (v >= 300000 && v <= 4000000) budget = v;
    }
  }

  if (budget) {
    const CARS = [
      { model:"Toyota Glanza",        type:"HATCH", price:750000 },
      { model:"Toyota Hyryder",       type:"SUV",   price:1200000 },
      { model:"Toyota Rumion",        type:"MPV",   price:1100000 },
      { model:"Hyundai Creta",        type:"SUV",   price:1150000 },
      { model:"Hyundai Venue",        type:"SUV",   price:900000 },
      { model:"Honda City",           type:"SEDAN", price:1200000 },
      { model:"Maruti Brezza",        type:"SUV",   price:900000 },
      { model:"Kia Sonet",            type:"SUV",   price:900000 },
      { model:"Kia Carens",           type:"MPV",   price:1100000 }
    ];

    try {
      const sheets = await loadPricingFromSheets();
      if (sheets && Object.keys(sheets).length) {
        const dynamicPicks = [];
        for (const [brand, tab] of Object.entries(sheets)) {
          if (!tab || !tab.data) continue;
          const header = Array.isArray(tab.header) ? tab.header.map(h => String(h || '').toUpperCase()) : [];
          const idxMap = tab.idxMap || toHeaderIndexMap(header);
const priceIdx = pickOnRoadPriceIndex(
  idxMap,
  cityToken || '',
  'individual',
  stateMatch || ''
) || -1;
         const idxModel = header.findIndex(h => h.includes('MODEL') || h.includes('VEHICLE'));
          const idxVariant = header.findIndex(h => h.includes('VARIANT') || h.includes('SUFFIX'));

          for (const row of tab.data) {
            let onroad = 0;
            if (priceIdx >= 0) onroad = Number(String(row[priceIdx] || '').replace(/[,₹\s]/g, '')) || 0;
           // Fallback scan ONLY if no on-road column exists
if (!onroad && priceIdx < 0) {
  for (let i = 0; i < row.length; i++) {
    const v = String(row[i] || '').replace(/[,₹\s]/g,'');
    if (v && /^\d+$/.test(v)) {
      const n = Number(v);
      if (n >= 200000) {
        onroad = n;
        break;
      }
    }
  }
}
 if (!onroad) continue;
            const modelCell = idxModel>=0 ? String(row[idxModel]||'').toLowerCase() : '';
            const variantCell = idxVariant>=0 ? String(row[idxVariant]||'').toLowerCase() : '';
          const text = `${modelCell} ${variantCell}`.toLowerCase();

// Default
let seg = 'ANY';

// =======================
// SUV / CROSSOVER
// =======================
if (/\b(suv|crossover|xuv|scorpio|thar|jimny|fortuner|legender|gloster|endeavour|creta|seltos|sonet|venue|taigun|kushaq|hector|astor|harrier|safari|compass|meridian|kodiaq|tucson|q2|q3|q5|q7|q8|x1|x3|x5|x7|gla|glc|gle|gls|g class|xc40|xc60|xc90|nx|rx|lx|ux)\b/.test(text)) {
  seg = 'SUV';
}

// =======================
// SEDAN
// =======================
else if (/\b(sedan|city|verna|ciaz|slavia|virtus|civic|accord|camry|octavia|superb|a3|a4|a6|a8|3 series|5 series|7 series|c class|e class|s class|es|is|ls|s60|s90)\b/.test(text)) {
  seg = 'SEDAN';
}

// =======================
// HATCHBACK
// =======================
else if (/\b(hatch|swift|baleno|glanza|i10|i20|alto|wagonr|celerio|tiago|altroz|polo|a class|1 series)\b/.test(text)) {
  seg = 'HATCH';
}

// =======================
// MPV
// =======================
else if (/\b(mpv|innova|hycross|crysta|ertiga|xl6|carens|marazzo|carnival|vellfire)\b/.test(text)) {
  seg = 'MPV';
}

// =======================
// LUXURY BRAND FALLBACK
// =======================
else if (/\b(mercedes|bmw|audi|lexus|volvo|porsche|land rover|range rover|jaguar)\b/.test(text)) {
  seg = 'LUXURY';
}

// =======================
// FILTER ONLY IF USER ASKED
// =======================
if (
  (wantsSUV && seg !== 'SUV' && seg !== 'LUXURY') ||
  (wantsSedan && seg !== 'SEDAN' && seg !== 'LUXURY') ||
  (wantsHatch && seg !== 'HATCH') ||
  (wantsMPV && seg !== 'MPV')
) {
  continue;
}

   if (onroad <= budget * 1.2) {
              const titleParts = [];
              if (idxModel>=0 && row[idxModel]) titleParts.push(String(row[idxModel]).trim());
              if (idxVariant>=0 && row[idxVariant]) titleParts.push(String(row[idxVariant]).trim());
              dynamicPicks.push({ brand, model: titleParts.join(' '), onroad, seg });
            }
          }
        }
        if (dynamicPicks.length) {
          dynamicPicks.sort((a,b) => Math.abs(a.onroad - budget) - Math.abs(b.onroad - budget));
          const out = [];
          out.push(`*Best New Car Options Around ₹${fmtMoney(budget)}*`);
          out.push('');
          if (wantsSUV) out.push('• Segment: *SUV*'); else if (wantsSedan) out.push('• Segment: *Sedan*'); else if (wantsHatch) out.push('• Segment: *Hatchback*'); else out.push('• Segment: *Any*');
          out.push('');
          dynamicPicks.slice(0,25).forEach(p => out.push(`• *${p.brand} ${p.model || ''}* — On-road ~ ₹${fmtMoney(p.onroad)}`));
          out.push('', 'Reply with the model name for exact *on-road price*, *offers* and *EMI*.');
          await _config.waSendText(to, out.join('\n'));
          _config.setLastService(to, 'NEW');
          return true;
        }
      }
    } catch (e) {
      if (typeof _config.DEBUG !== 'undefined' && _config.DEBUG) console.warn('Dynamic budget picks failed, falling back to static list:', e && e.message);
    }

    // Fallback static behaviour
    const picks = CARS.filter(c => c.price <= budget && ((wantsSUV && c.type === "SUV") || (wantsSedan && c.type === "SEDAN") || (wantsHatch && c.type === "HATCH") || (!wantsSUV && !wantsSedan && !wantsHatch)));
    if (picks.length > 0) {
      const out = [];
      out.push(`*Best New Car Options Around ₹${fmtMoney(budget)}*`);
      if (wantsSUV) out.push("• Segment: *SUV*"); else if (wantsSedan) out.push("• Segment: *Sedan*"); else if (wantsHatch) out.push("• Segment: *Hatchback*"); else out.push("• Segment: *Any*");
      out.push("");
      picks.slice(0, 6).forEach(c => { out.push(`• *${c.model}* — starts at ₹${fmtMoney(c.price)}`); });
      out.push("");
      out.push("Tell me the model name for exact *on-road price*, *offers* and *EMI*.");
      await _config.waSendText(to, out.join('\n'));
      _config.setLastService(to, "NEW");
      return true;
    }

    await _config.waSendText(to, `I noted your budget of *₹${fmtMoney(budget)}*.\nDo you prefer *SUV*, *Sedan* or *Hatchback*?`);
    _config.setLastService(to, "NEW");
    return true;
  }
  } // 🔒 END of NEW-car budget guard
// ------------------------------
// 3️⃣ FEATURE EXPLANATION MODE (STRICT, SAFE)
// Trigger ONLY when user intent is clearly educational
// ------------------------------
for (const ft of FEATURE_TOPICS) {
  if (
  t.includes(ft) &&
  !hasPricingIntent &&
  !hasVariantLock &&        // 🔒 CRITICAL FIX
  !wantsSpecs &&
  !hasComparisonIntent &&
  !wantsAllStates &&
  !userBudget
) {
   const expl = (typeof _config.SignatureAI_RAG === 'function')
      ? await _config.SignatureAI_RAG(
          `Explain "${ft}" in simple car-buyer language (India context, concise, non-technical).`
        )
      : `Explanation for ${ft}`;

    await _config.waSendText(
      to,
      `*${ft.toUpperCase()} — Simple Explanation*\n\n${expl}`
    );
    _config.setLastService(to, "NEW");
    return true;
  }
}
  // ------------------------------
  // 4️⃣ RECOMMENDATION MODE
  // ------------------------------
if (/which car should i buy|recommend.*car|suggest.*car|help me choose/.test(t)) {
  await _config.waSendText(
    "*I'll help you pick the right new car.*\n\n" +
    "Please tell me:\n" +
    "• Budget\n• City\n• Usage (daily / highway)\n• Preference (SUV / Sedan / Any)"
  );
  _config.setLastService(to, "NEW");
  return true;
}

// ------------------------------
// 6️⃣ FINANCE / EMI MODE (CONTEXT-AWARE)
// ------------------------------
if (
  /emi|finance|loan|0 down|zero down/.test(t) &&
  !hasPricingIntent &&
  !wantsAllStates &&
  lastSvc.includes('loan')   // 🔒 KEY LINE
) {
  await _config.waSendText(
    to,
    'To calculate your *EMI*, please share:\n' +
    '• Loan amount\n' +
    '• Tenure (up to 7 years)\n\n' +
    'Examples:\n' +
    '• `10 lakh 5 years`\n' +
    '• `₹12,00,000 60`\n' +
    '• `1200000 5`\n\n' +
    '_Interest rate will be applied automatically._'
  );
  return true;
}

return false;
}

// ---------------- tryQuickNewCarQuote (FULL REWRITE) ----------------
async function tryQuickNewCarQuote(msgText, to) {
  try {
console.log('DEBUG_FLOW: ENTER tryQuickNewCarQuote', msgText);
    if (!msgText || !msgText.trim()) return false;
const lastSvc = (_config.getLastService(to) || '').toLowerCase();

    // 🔒 HARD GUARD: If user is already in LOAN flow, do NOT treat numbers as budget

    if (lastSvc.includes('loan')) {
      if (typeof _config.DEBUG !== 'undefined' && _config.DEBUG) {
        console.log('LOAN CONTEXT ACTIVE → skipping new-car quote engine:', msgText);
      }
      return false;
    }

    // If user included a year (e.g. "2024"), treat as USED
    const yearMatch = (String(msgText).match(/\b(19|20)\d{2}\b/) || [])[0];
    if (yearMatch) {
      const y = Number(yearMatch);
      const nowYear = new Date().getFullYear();
      if (y >= 1990 && y <= nowYear) {
        if (typeof _config.DEBUG !== 'undefined' && _config.DEBUG) console.log('User query contains year -> treat as USED:', msgText);
        return false;
      }
    }

    if (!_config.canSendQuote(to)) {
      await _config.waSendText('You\u2019ve reached today\u2019s assistance limit for quotes. Please try again tomorrow or provide your details for a personalised quote.');
      return true;
    }

    // ---------- ROBUST SHEET LOADING (with one retry) ----------
let tables = null;
try {
  tables = await loadPricingFromSheets();
} catch (loadErr) {
  if (typeof _config.DEBUG !== 'undefined' && _config.DEBUG) console.warn("Initial loadPricingFromSheets failed:", loadErr && loadErr.message);
  try {
    // short retry
    tables = await loadPricingFromSheets();
  } catch (loadErr2) {
    if (typeof _config.DEBUG !== 'undefined' && _config.DEBUG) console.warn("Retry loadPricingFromSheets also failed:", loadErr2 && loadErr2.message);
    tables = null;
  }
}

if (!tables || Object.keys(tables).length === 0) {
  if (typeof _config.DEBUG !== 'undefined' && _config.DEBUG) console.log('loadPricingFromSheets returned empty tables. Continuing but dynamic pricing may be limited.');
}
// ---------- end ROBUST SHEET LOADING ----------

// ✅ BUILD GLOBAL BRAND / MODEL REGISTRY FROM SHEETS (ONCE PER CALL)
if (tables && Object.keys(tables).length) {
  buildGlobalRegistryFromSheets(tables);
}

    const tRaw = String(msgText || '');
    const t = tRaw.toLowerCase();
    const tUpper = t.toUpperCase();
// ------------------------------
// PAN-INDIA / ALL-STATES INTENT (LOCAL TO QUOTE ENGINE)
// ------------------------------
const wantsAllStates =
  /\b(all states|pan india|india wide|state wise|across states|all india)\b/i.test(t);


    // --- unified brand detection (uses global helper) ---
    let brandGuess = (typeof detectBrandFromText === 'function') ? detectBrandFromText(t) : null;

  // ---------------- CITY DETECTION (REAL CITIES ONLY) ----------------
let cityMatch =
  (t.match(/\b(delhi|dilli|gurgaon|gurugram|noida|faridabad|chandigarh|ch|mumbai|bombay|bangalore|bengaluru|chennai|kolkata|pune|shimla)\b/i) || [])[1] ||
  null;

if (cityMatch) {
  cityMatch = cityMatch.toLowerCase();
  if (cityMatch === 'dilli') cityMatch = 'delhi';
  if (cityMatch === 'bombay') cityMatch = 'mumbai';
  if (cityMatch === 'gurugram') cityMatch = 'gurgaon';
  if (cityMatch === 'bengaluru') cityMatch = 'bangalore';
  if (cityMatch === 'ch') cityMatch = 'chandigarh'; // ✅ ADDED
}

// ---------------- STATE DETECTION (SEPARATE) ----------------
let stateMatch =
  (t.match(/\b(himachal pradesh|hp|haryana|hr|uttar pradesh|up|maharashtra|mh)\b/i) || [])[1] ||
  null;

if (stateMatch) {
  stateMatch = stateMatch.toLowerCase();
  if (stateMatch === 'hp') stateMatch = 'himachal pradesh';
  if (stateMatch === 'hr') stateMatch = 'haryana';
  if (stateMatch === 'up') stateMatch = 'uttar pradesh';
  if (stateMatch === 'mh') stateMatch = 'maharashtra';
}

// ---------------- DEFAULT CITY (DELHI UNLESS EXPLICIT) ----------------
if (!cityMatch) {
  cityMatch = 'delhi';
}

const city = cityMatch;

// ---------- PROFILE / AUDIENCE ----------
const profile =
  (t.match(/\b(individual|company|corporate|firm|personal)\b/) || [])[1] ||
  'individual';

const audience = /company|corporate|firm/i.test(profile)
  ? 'corporate'
  : 'individual';

// ---------- PRICING CITY / STATE TOKEN (STRICT RULE) ----------
// Default pricing is DELHI
let priceCityToken = 'DELHI';

// Change pricing ONLY if user explicitly typed a non-Delhi city
const cityExplicit =
  typeof city === 'string' &&
  city.length > 0 &&
  city.toLowerCase() !== 'delhi' &&
  t.includes(city.toLowerCase());

if (cityExplicit) {
  try {
    if (typeof _config.CITY_TO_STATE === 'object' && _config.CITY_TO_STATE[city]) {
      priceCityToken = _config.CITY_TO_STATE[city].toUpperCase();
    } else {
      // fallback: use city itself if sheet supports city columns
      priceCityToken = city.toUpperCase();
    }
  } catch (e) {
    priceCityToken = 'DELHI';
  }
}

    // ---------- BUDGET PARSER ----------
    function parseBudgetFromText(s) {
      if (!s) return null;
      const norm = String(s).toLowerCase().replace(/[,₹]/g, ' ').replace(/\s+/g, ' ').trim();

      const plainNum = (norm.match(/\b([0-9]{5,9})\b/ ) || [])[1];
      if (plainNum) {
        const v = Number(plainNum);
        if (v > 10000) return v;
      }

      let m = norm.match(/\b([0-9]+(?:\.[0-9]+)?)\s*(lakh|lac|l|k)\b/);
      if (!m) m = norm.match(/\b([0-9]+(?:\.[0-9]+)?)\s*(l)\b/);
      if (m) {
        const v = Number(m[1]) * 100000;
        if (!Number.isNaN(v)) return v;
      }

      m = norm.match(/\b([0-9]+(?:\.[0-9]+)?)\s*(crore|cr|c)\b/);
      if (m) {
        const v = Number(m[1]) * 10000000;
        if (!Number.isNaN(v)) return v;
      }

      m = norm.match(/\b([0-9]+(?:\.[0-9]+)?)\s*k\b/);
      if (m) {
        const v = Number(m[1]) * 1000;
        if (!Number.isNaN(v)) return v;
      }

      const tokens = norm.split(/\s+/).filter(Boolean);
      for (const tok of tokens) {
        const n = Number(tok);
        if (!Number.isNaN(n) && n >= 50000) return n;
      }
      return null;
    }

    const userBudget = parseBudgetFromText(t);
    let budgetMin = null, budgetMax = null;
    if (userBudget) {
      const MARGIN = Number(process.env.NEW_CAR_BUDGET_MARGIN || 0.20);
      budgetMin = Math.round(userBudget * (1 - MARGIN));
      budgetMax = Math.round(userBudget * (1 + MARGIN));
      if (typeof _config.DEBUG !== 'undefined' && _config.DEBUG) console.log("User budget parsed:", userBudget, "range:", budgetMin, budgetMax);
    }

    // Preprocess input to remove city/profile tokens and normalize
let raw = t
  .replace(/\b(delhi|dilli|haryana|hr|chandigarh|chd|uttar pradesh|up|himachal|hp|mumbai|bombay|bangalore|bengaluru|chennai|kolkata|pune)\b/g, ' ')
  .replace(/\b(individual|company|corporate|firm|personal)\b/g, ' ')
  .replace(/\b(automatic transmission|automatic|auto)\b/g, ' at ')

// ---- DRIVETRAIN NORMALIZATION (CRITICAL) ----
.replace(/\b4\s*\/\s*4\b/g, ' 4x4 ')
.replace(/\b4\s*x\s*4\b/g, ' 4x4 ')
.replace(/\b4\s*[*]\s*4\b/g, ' 4x4 ')
.replace(/\b4\s*x\s*2\b/g, ' 4/2 ')
.replace(/\b4\s*[*]\s*2\b/g, ' 4/2 ')

.replace(/[^\w\s]/g, ' ')

  .replace(/\s+/g, ' ')
  .trim();

if (!raw) return false;
// ----------------- EXTRACT INTENT TOKENS (BEFORE normForMatch) -----------------
const rawWants4x4 = /\b4\s*x\s*4\b/i.test(raw) || /\b4\s*[/*]\s*4\b/i.test(raw);
const rawWants4x2 = /\b4\s*x\s*2\b/i.test(raw) || /\b4\s*[/*]\s*2\b/i.test(raw);
const rawWantsAT  = /\bat\b/i.test(raw);
const rawWantsMT  = /\bmt\b/i.test(raw);


// 1️⃣ Normalize user input
let userNorm = normForMatch(raw);
// 🔒 Re-inject lost intent tokens (CRITICAL)
if (rawWants4x4) userNorm += ' 4x4';
if (rawWants4x2) userNorm += ' 4/2';
if (rawWantsAT)  userNorm += ' at';
if (rawWantsMT)  userNorm += ' mt';

// 2️⃣ Apply MODEL ALIASES (canonicalize ONCE)
let canonicalUserNorm = userNorm;
for (const [alias, canon] of Object.entries(MODEL_ALIAS_MAP)) {
  if (canonicalUserNorm.includes(alias)) {
    canonicalUserNorm = canonicalUserNorm.replace(alias, canon);
  }
}

// 3️⃣ Tokens derived ONLY from canonicalUserNorm
const tokens = canonicalUserNorm.split(' ').filter(Boolean);

// 4️⃣ Model guess (used only for loose heuristics, not matching)
let modelGuess = canonicalUserNorm.split(' ').slice(0, 4).join(' ');

const modelTok = (modelGuess.split(' ')[0] || '').toLowerCase();
const isShortModelToken = modelTok && modelTok.length <= 4;

const VARIANT_LIST_LIMIT = Number(process.env.VARIANT_LIST_LIMIT || 25);
const SPECIAL_WORDS = ['LEADER', 'LEGENDER', 'GRS'];

function _makeLoosePatLocal(sfx) {
  const parts = (sfx || '').toString().toLowerCase().split('');
  const escaped = parts.map(ch => ch.replace(/[^a-z0-9]/g, '\\$&'));
  return new RegExp('\\b' + escaped.join('[\\s\\W_]*') + '\\b', 'i');
}

const cityToken = city.split(' ')[0].toUpperCase();

// ----------------- PRECOMPUTE: coreTokens -----------------
const genericWords = new Set([
  'car','cars','used','pre','preowned','pre-owned',
  'second','secondhand','second-hand'
]);

const coreTokensArr = canonicalUserNorm
  .split(' ')
  .filter(tk => tk && !genericWords.has(tk));

// Explicit variant intent: model + variant token present
const userHasExplicitVariant =
  Array.isArray(coreTokensArr) && coreTokensArr.length >= 2;

// -------- NORMALIZE XUV700 TOKEN (SAFE) --------
if (
  coreTokensArr.length === 1 &&
  /^xuv\s*700$/i.test(coreTokensArr[0])
) {
  coreTokensArr.splice(0, 1, 'xuv', '700');

  if (_config.DEBUG) {
    console.log('Normalized XUV700 token → [xuv, 700]');
  }
}


    // ---------------- BASE MODEL TOKEN (GLOBAL, SAFE) ----------------
const baseModelToken =
  coreTokensArr && coreTokensArr.length
    ? coreTokensArr[0].toUpperCase()
    : null;

    let exactModelHit = false;
    let resolvedModel = null;
    try {
      if (typeof _config.MODEL_ALIASES !== 'undefined') {
        const allModelSyns = new Set();
        for (const [canon, syns] of Object.entries(_config.MODEL_ALIASES)) {
          if (canon) allModelSyns.add(String(normForMatch(canon)).toUpperCase());
          if (Array.isArray(syns)) syns.forEach(s => s && allModelSyns.add(String(normForMatch(s)).toUpperCase()));
        }
        for (const tk of coreTokensArr) {
          if (!tk) continue;
          if (allModelSyns.has(String(normForMatch(tk)).toUpperCase())) {
            exactModelHit = true; break;
          }
        }
      }
    } catch (e) {
      if (typeof _config.DEBUG !== 'undefined' && _config.DEBUG) console.warn('exactModelHit detection failed:', e && e.message);
    }

  // ---------- MULTI-BRAND DETECTION (SAFE & NON-DESTRUCTIVE) ----------
let allowedBrandSet = null;

// 1) If brand was explicitly detected → hard lock
if (brandGuess) {
  allowedBrandSet = new Set([String(brandGuess).toUpperCase()]);
} else {
  // 2) Infer brands from text using BRAND_HINTS (no table scan yet)
  const inferredBrands = new Set();

  if (typeof _config.BRAND_HINTS !== 'undefined') {
    for (const [brand, hints] of Object.entries(_config.BRAND_HINTS)) {
      for (const h of hints) {
        const pat = new RegExp(`\\b${h.replace(/\s+/g, '\\s*')}\\b`, 'i');
        if (pat.test(t)) {
          inferredBrands.add(String(brand).toUpperCase());
          break;
        }
      }
    }
  }

  // 3) Lock inferred brands only if confident
  if (inferredBrands.size > 0) {
    allowedBrandSet = inferredBrands;
  }
}

// NOTE:
// - If allowedBrandSet === null → allow all brands (important for budget/SUV)
// - Do NOT filter tables here

  let allMatches = [];

    for (const [brand, tab] of Object.entries(tables)) {
      if (!tab || !tab.data) continue;

      const brandKey = String(brand || '').toUpperCase();

      // brand lock
      if (brandGuess && brandKey !== String(brandGuess).toUpperCase()) continue;
      if (allowedBrandSet && !allowedBrandSet.has(brandKey)) continue;

      const header = (Array.isArray(tab.header) ? tab.header : []).map(h => String(h || '').toUpperCase());
      const idxMap = tab.idxMap || toHeaderIndexMap(header);
      const idxModel = header.findIndex(h => h.includes('MODEL') || h.includes('VEHICLE'));
      const idxVariant = header.findIndex(h => h.includes('VARIANT') || h.includes('SUFFIX'));
      const idxVarKw = header.findIndex(h => h.includes('VARIANT_KEYWORDS') || h.includes('KEYWORD'));
      const idxSuffixCol = header.findIndex(h => h.includes('SUFFIX'));
      const fuelIdx = pickFuelIndex(idxMap);
      const exIdx = detectExShowIdx(idxMap);
     // --- determine globalPriceIdx (pickOnRoadPriceIndex OR header heuristics OR numeric fallback) ---
let globalPriceIdx = wantsAllStates
  ? findPriceIndexFallback(header, tab)
: pickOnRoadPriceIndex(idxMap, cityToken, audience, stateMatch);

// robust guard (in case pickOnRoadPriceIndex returns undefined)
if (typeof globalPriceIdx === 'undefined' || globalPriceIdx < 0) {
  // 1) header pattern scan (common names)
  for (let i = 0; i < header.length; i++) {
    const h = String(header[i] || '');
    if (/(ON[-_ ]?ROAD|ONROAD|ON[-_ ]?ROAD PRICE|ONROAD PRICE|OTR|ONR|ON[-_ ]?ROAD₹|ONR PRICE|ONROADAMOUNT|ONR|PRICE|ONR PRICE)/i.test(h)) {
      globalPriceIdx = i;
      break;
    }
  }
}

// 2) fallback: pick the column with the most numeric (4+ digit) occurrences — likely a price column
if (typeof globalPriceIdx === 'undefined' || globalPriceIdx < 0) {
  let bestIdx = -1;
  let bestCnt = 0;
  for (let i = 0; i < header.length; i++) {
    let cnt = 0;
    for (const r of (tab.data || [])) {
      const v = String(r[i] || '').replace(/[,₹\s]/g, '');
      if (/^\d{4,}$/.test(v)) cnt++;
    }
    if (cnt > bestCnt) { bestCnt = cnt; bestIdx = i; }
  }
  // require at least 2 numeric occurrences to consider it valid
  if (bestCnt >= 2) globalPriceIdx = bestIdx;
}

// DEBUG: show what we picked
if (typeof _config.DEBUG !== 'undefined' && _config.DEBUG) {
  console.log(`globalPriceIdx resolved=${globalPriceIdx} (headerCount=${header.length}) for brand=${brandKey}`);
}
      for (const row of tab.data) {
        const modelCell = idxModel >= 0 ? String(row[idxModel] || '').toLowerCase() : '';
        const variantCell = idxVariant >= 0 ? String(row[idxVariant] || '').toLowerCase() : '';
        const modelNorm = normForMatch(modelCell || '');
        const variantNorm = normForMatch(variantCell || '');

        // HARD FILTER for very short model tokens when brand guessed
        if (brandGuess && isShortModelToken) {
          const modelWords = modelNorm.split(' ').filter(Boolean);
          if (!modelWords.includes(modelTok)) continue;
        }

        let score = 0;

        // stronger signals for substring matches (normalized)
        try {
          const modelGuessNorm = normForMatch(modelGuess || '');
          const rawNorm = userNorm;
          if (modelNorm && modelGuessNorm && modelNorm.includes(modelGuessNorm)) score += 40;
          if (variantNorm && modelGuessNorm && variantNorm.includes(modelGuessNorm)) score += 45;
          if (rawNorm && (modelNorm.includes(rawNorm) || variantNorm.includes(rawNorm))) score += 30;
        } catch (e) {
          if (modelCell && modelCell.includes(modelGuess)) score += 40;
          if (variantCell && variantCell.includes(modelGuess)) score += 45;
          if (raw && (modelCell.includes(raw) || variantCell.includes(raw))) score += 30;
        }

        if (userNorm && modelNorm && (modelNorm.includes(userNorm) || userNorm.includes(modelNorm))) score += 35;
        if (userNorm && variantNorm && (variantNorm.includes(userNorm) || userNorm.includes(variantNorm))) score += 35;

        let varKwNorm = '';
        let suffixNorm = '';
        if (idxVarKw >= 0 && row[idxVarKw] != null) varKwNorm = normForMatch(row[idxVarKw]);
        if (idxSuffixCol >= 0 && row[idxSuffixCol] != null) suffixNorm = normForMatch(row[idxSuffixCol]);

        let fuelNorm = '';
        let fuelCell = '';
        if (fuelIdx >= 0 && row[fuelIdx] != null) {
          fuelCell = String(row[fuelIdx] || '');
          fuelNorm = normForMatch(fuelCell.toLowerCase());
        }

        for (const tok of tokens) {
          if (!tok) continue;
          if (modelNorm && modelNorm.includes(tok)) score += 5;
          if (variantNorm && variantNorm.includes(tok)) score += 8;
          if (suffixNorm && suffixNorm.includes(tok)) score += 10;
          if (varKwNorm && varKwNorm.includes(tok)) score += 15;
          if (fuelNorm && fuelNorm.includes(tok)) score += 6;
        }

        // improved suffix detection (loose)
        const specialSuffixes = ['zxo', 'gxo', 'vxo', 'zx', 'vx', 'gx'];
        const searchTargets = [variantNorm || '', suffixNorm || '', varKwNorm || '', modelNorm || ''].join(' ');
        let userSuffix = null;
        for (const sfx of specialSuffixes) {
          const pat = _makeLoosePatLocal(sfx);
          if (pat.test(userNorm) || pat.test(searchTargets)) {
            userSuffix = sfx; break;
          }
        }
        if (userSuffix) {
          const sPat = _makeLoosePatLocal(userSuffix);
          const rowHasSuffixLocal = sPat.test(variantNorm) || sPat.test(suffixNorm) || sPat.test(varKwNorm) || sPat.test(modelNorm);
          if (rowHasSuffixLocal) score += 80;
          else {
            // softer penalty: only penalize strongly if user clearly typed suffix longer than 1 char
            if (userSuffix.length > 1) score -= 8;
          }
        }
// -------- BMW X-SERIES HARD BRAND + MODEL LOCK --------
if (
  !allowedBrandSet &&
  /\b(bmw)?\s*x\s*([1-9])\b/i.test(t)
) {
  allowedBrandSet = new Set(['BMW']);

  const m = t.match(/\bx\s*([1-9])\b/i);
  if (m) {
    resolvedModel = 'x' + m[1]; // x5, x7, etc
  }

  if (_config.DEBUG) {
    console.log('BMW X-series hard lock applied:', resolvedModel);
  }
}

// -------- MAHINDRA XUV700 HARD BRAND + MODEL LOCK --------
if (
  !allowedBrandSet &&
  /\bxuv\s*700\b/i.test(t)
) {
  allowedBrandSet = new Set(['MAHINDRA']);
  resolvedModel = 'xuv700';

  if (_config.DEBUG) {
    console.log('Mahindra XUV700 hard lock applied');
  }
}
       // ---------- NORMALIZE SPECIAL_WORDS comparison + defensive suffix penalty ----------
const outerVariantNorm = String(normForMatch(String(variantCell || ''))).toLowerCase();
const variantNormUpper = outerVariantNorm.toUpperCase();
const varKwNormUpper = String(varKwNorm || '').toUpperCase();
const userNormUpper = String(normForMatch(String(t || ''))).toUpperCase();

const SPECIAL_WORDS_LIST = (typeof SPECIAL_WORDS !== 'undefined' && Array.isArray(SPECIAL_WORDS)) ? SPECIAL_WORDS : ['LEADER','LEGENDER','GRS'];

for (const sw of SPECIAL_WORDS_LIST) {
  if ((variantNormUpper.includes(sw) || varKwNormUpper.includes(sw)) && !userNormUpper.includes(sw)) {
    score -= 25;
    if (typeof _config.DEBUG !== 'undefined' && _config.DEBUG) {
      console.log(`Penalty: SPECIAL_WORD ${sw} present in row but not in user text -> -25 (model=${modelCell}, variant=${variantCell})`);
    }
  }
}

// small extra defensive step: if userSuffix is very short (<=3) and no allowedBrandSet,
// prefer rows that explicitly include the suffix; penalize slightly otherwise.
if (userSuffix && userSuffix.length <= 3 && !allowedBrandSet) {
  const suf = String(userSuffix).toLowerCase();
  const suffixPresent = (variantNorm.includes(suf) || (varKwNorm && String(varKwNorm).toLowerCase().includes(suf)) || (suffixNorm && String(suffixNorm).toLowerCase().includes(suf)));
  if (!suffixPresent) {
    score -= 10;
    if (typeof _config.DEBUG !== 'undefined' && _config.DEBUG) {
      console.log(`Penalty: userSuffix '${userSuffix}' not found in row -> -10 (model=${modelCell}, variant=${variantCell})`);
    }
  }
}
// ---------- end SPECIAL_WORDS / suffix block ----------

        // ---------- ADAPTIVE MIN SCORE (per-row) ----------
let ABS_MIN_SCORE = Number(process.env.MIN_MATCH_SCORE || 12);

// Relax the absolute floor for short queries / single token model guesses
if ((coreTokensArr && coreTokensArr.length === 1) || isShortModelToken) {
  ABS_MIN_SCORE = Math.min(8, ABS_MIN_SCORE); // allow down to 8 for short queries
}

const variantRescue =
  variantNorm &&
  coreTokensArr.some(tk => variantNorm.includes(tk));

if ((score <= 0 || score < ABS_MIN_SCORE) && !variantRescue) continue;

// ---------- end ADAPTIVE MIN SCORE ----------

        // pick price column (globalPriceIdx) else fallback to first numeric
        let priceIdx = globalPriceIdx;
        if (priceIdx < 0) {
          for (let i = 0; i < row.length; i++) {
            const v = String(row[i] || '').replace(/[,₹\s]/g, '');
            if (v && /^\d+$/.test(v)) {
              priceIdx = i; break;
            }
          }
        }

        const priceStr = priceIdx >= 0 ? String(row[priceIdx] || '') : '';
        const onroad = Number(priceStr.replace(/[,₹\s]/g, '')) || 0;
        if (!onroad) {
          if (typeof _config.DEBUG !== 'undefined' && _config.DEBUG) console.log(`skip row: no onroad price for brand=${brandKey} model=${modelCell} variant=${variantCell}`);
          continue;
        }

        const exShow = exIdx >= 0 ? Number(String(row[exIdx] || '').replace(/[,₹\s]/g, '')) || 0 : 0;

        // Price-based boosting/penalty when userBudget present
        let priceOk = true;
        let priceScoreDelta = 0;
        if (userBudget) {
          if (onroad >= budgetMin && onroad <= budgetMax) {
            priceScoreDelta += 60;
          } else {
            const mid = (budgetMin + budgetMax) / 2;
            const rel = Math.abs(onroad - mid) / (mid || 1);
            if (rel <= 0.30) priceScoreDelta -= Math.round(rel * 100);
            else if (rel <= 0.60) priceScoreDelta -= Math.round(rel * 80);
            else priceOk = false;
          }
        }
        if (!priceOk) {
          if (typeof _config.DEBUG !== 'undefined' && _config.DEBUG) console.log(`skip row: price out of range for userBudget; onroad=${onroad}, range=${budgetMin}-${budgetMax}`);
          continue;
        }

        allMatches.push({
          brand: brandKey,
          row,
          idxModel,
          idxVariant,
          idxMap,
          onroad,
          exShow,
          score: score + priceScoreDelta,
          fuel: fuelCell
        });
      }
    }
// 🔒 FINAL HARD MODEL LOCK (compact models only)
if (resolvedModel) {
  const rm = normalizeCompactModel(resolvedModel);
  allMatches = allMatches.filter(m => {
    const mdl = normalizeCompactModel(m.row[m.idxModel] || '');
    return mdl.includes(rm);
  });
}
// ================= HARD DRIVETRAIN LOCK (SAFE & FINAL) =================
const wants4x4 = /\b(4x4|4wd|awd)\b/i.test(userNorm);
const wants4x2 = /\b(4\/2|4x2)\b/i.test(userNorm);

if (wants4x4 && !wants4x2) {
  allMatches = allMatches.filter(m => {
    const v = normForMatch(
      (m.row[m.idxVariant] || '') + ' ' +
      (m.row[m.idxSuffix]  || '')
    );
    return /\b(4x4|4wd|awd)\b/i.test(v);
  });

  if (_config.DEBUG) {
    console.log('HARD_DRIVETRAIN_LOCK_APPLIED: 4x4 → remaining', allMatches.length);
  }
}

if (wants4x2 && !wants4x4) {
  allMatches = allMatches.filter(m => {
    const v = normForMatch(
      (m.row[m.idxVariant] || '') + ' ' +
      (m.row[m.idxSuffix]  || '')
    );
    return !/\b(4x4|4wd|awd)\b/i.test(v);
  });

  if (_config.DEBUG) {
    console.log('HARD_DRIVETRAIN_LOCK_APPLIED: 4x2 → remaining', allMatches.length);
  }
}
// ================= HARD TRANSMISSION LOCK (FINAL FIX) =================
const wantsAutomatic = /\b(at|automatic|auto)\b/i.test(userNorm);

if (wantsAutomatic) {
  allMatches = allMatches.filter(m => {
    const v = normForMatch(
      [
        m.row[m.idxModel],
        m.row[m.idxVariant],
        m.row[m.idxSuffix],
        m.row[m.idxTransmission],
        m.row[m.idxFuel]
      ].join(' ')
    );

    return /\b(at|automatic|cvt|dct|tc)\b/.test(v);
  });

  if (_config.DEBUG) {
    console.log(
      'HARD_TRANSMISSION_LOCK_APPLIED (EXPANDED): remaining',
      allMatches.length
    );
  }
}
   // ---------- PRUNE & RELAXED MATCHING (adaptive) ----------
if (!allMatches.length) {

// ================= FINAL VARIANT GUARANTEE =================
if (hasVariantLock) {
  const filtered = allMatches.filter(m => {
    const text = normForMatch(
  (m.row[m.idxVariant] || '') + ' ' +
  (m.row[m.idxSuffix]  || '') + ' ' +
  (m.row[m.idxModel]   || '')
);

    if (/\b4x4\b/.test(t)) {
      return /\b(4x4|4wd|awd)\b/.test(text);
    }

    if (/\bautomatic|auto|at\b/.test(t)) {
      return /\b(at|automatic|cvt|dct|tc)\b/.test(text);
    }

    return true;
  });

  // 🔴 If we found strict matches, NEVER fall back
  if (filtered.length) {
    allMatches = filtered;
  }
}

// ================================
// MODEL LIST FALLBACK (FINAL & SAFE)
// ================================
if (
  wantsModelList &&
  !hasPricingIntent &&
  !hasComparisonIntent &&
  !wantsSpecs
) {
  try {
    const modelSet = new Set();

    for (const [brand, tab] of Object.entries(tables || {})) {
      if (!tab || !tab.data || !tab.header) continue;
      if (allowedBrandSet && !allowedBrandSet.has(brand)) continue;

      const header = tab.header.map(h => String(h || '').toUpperCase());
      const idxModel = header.findIndex(h => h.includes('MODEL'));
      if (idxModel < 0) continue;

      for (const row of tab.data) {
        if (row[idxModel]) {
          modelSet.add(String(row[idxModel]).trim());
        }
      }
    }

    if (modelSet.size) {
      const models = Array.from(modelSet).sort().slice(0, 30);
      const out = [];

      out.push(
        allowedBrandSet
          ? '*Available Models*'
          : '*Available Car Models*'
      );
      out.push('');
      models.forEach(m => out.push(`• ${m}`));
      out.push('');
      out.push('Reply with the *model name* to see variants, prices & offers.');

      await _config.waSendText(to, out.join('\n'));
      return true;
    }
  } catch (e) {
    if (_config.DEBUG) console.warn('Model list fallback failed:', e?.message);
  }
}

  // ❌ fallback only if model list not requested
  await _config.waSendText(
    to,
    "I couldn't find an exact match for that query.\n" +
    "Please try:\n" +
    "• Model + Variant (e.g. *Hycross ZX(O)*)\n" +
    "• Or add city (e.g. *Delhi*, *HR*)"
  );
  return true;
}

if (allMatches.length > 0) {
  const topScore = Math.max(...allMatches.map(m => m.score || 0));
  const REL_MIN_FRAC = 0.12;

  // Recompute an adaptive absolute floor for pruning (mirror per-row behavior)
  let pruneAbsFloor = Number(process.env.MIN_MATCH_SCORE || 12);
  if ((coreTokensArr && coreTokensArr.length === 1) || isShortModelToken) {
    pruneAbsFloor = Math.min(8, pruneAbsFloor);
  }

  const before = allMatches.length;
  allMatches = allMatches.filter(m => {
    const s = m.score || 0;
    // Keep match if it exceeds the absolute floor OR is close enough to topScore
    if (s >= pruneAbsFloor) return true;
    if (topScore > 0 && s >= Math.max(pruneAbsFloor * 0.8, topScore * REL_MIN_FRAC)) return true;
    return false;
  });

  if (typeof _config.DEBUG !== 'undefined' && _config.DEBUG) {
    console.log(`Pruned matches: before=${before}, after=${allMatches.length}, topScore=${topScore}, pruneAbsFloor=${pruneAbsFloor}`);
  }
}

    // Relaxed matching when needed
    if (userBudget && allMatches.length < 3) {
      if (typeof _config.DEBUG !== 'undefined' && _config.DEBUG) console.log("Relaxing budget filter because strict matches < 3.");

      const relaxedMatches = [];
      const RELAX_LIMIT = Number(process.env.RELAXED_LIMIT || 60);
      const mid = (budgetMin + budgetMax) / 2;

      for (const [brand, tab] of Object.entries(tables)) {
        if (!tab || !tab.data) continue;
        const brandKey2 = String(brand || '').toUpperCase();
        if (allowedBrandSet && !allowedBrandSet.has(brandKey2)) continue;

        const header2 = (Array.isArray(tab.header) ? tab.header : []).map(h => String(h || '').toUpperCase());
        const idxMap2 = tab.idxMap || toHeaderIndexMap(header2);
let priceIdx2 = pickOnRoadPriceIndex(idxMap2, cityToken, audience, stateMatch);
        if (priceIdx2 < 0) {
          for (let i=0;i<header2.length;i++) {
            if (/(ON[-_ ]?ROAD|ONROAD|PRICE|ONROAD PRICE)/i.test(header2[i])) { priceIdx2 = i; break; }
          }
        }

        for (const row2 of tab.data) {
          if (relaxedMatches.length >= RELAX_LIMIT) break;
          const priceStr2 = priceIdx2 >= 0 ? String(row2[priceIdx2] || '') : '';
          const onroad2 = Number(priceStr2.replace(/[,₹\s]/g, '')) || 0;
          if (!onroad2) continue;
          const distFrac = Math.abs(onroad2 - mid) / (mid || 1);
          if (distFrac <= 1.2) {
            let rscore = Math.max(5, Math.round(100 - distFrac * 120));
            relaxedMatches.push({
              brand: brandKey2,
              row: row2,
              idxModel: header2.findIndex(h => h.includes("MODEL") || h.includes("VEHICLE")),
              idxVariant: header2.findIndex(h => h.includes("VARIANT") || h.includes("SUFFIX")),
              idxMap: idxMap2,
              onroad: onroad2,
              exShow: 0,
              score: rscore,
              fuel: ""
            });
          }
        }
        if (relaxedMatches.length >= RELAX_LIMIT) break;
      }
      if (relaxedMatches.length) allMatches.push(...relaxedMatches);
    }

    // sort
    if (userBudget && allMatches.length) {
      const mid = (budgetMin + budgetMax) / 2;
      allMatches.sort((a, b) => {
        const diff = (b.score || 0) - (a.score || 0);
        if (diff !== 0) return diff;
        const da = Math.abs((a.onroad || 0) - mid);
        const db = Math.abs((b.onroad || 0) - mid);
        return da - db;
      });
    } else {
      allMatches.sort((a, b) => (b.score || 0) - (a.score || 0));
    }

    if (typeof _config.DEBUG !== 'undefined' && _config.DEBUG) {
      console.log("DEBUG_QUICK: tokens=", tokens && tokens.slice(0,6));
      console.log("DEBUG_QUICK: coreTokens=", coreTokensArr.slice(0,6));
      console.log("DEBUG_QUICK: allMatches_before=", Array.isArray(allMatches) ? allMatches.length : typeof allMatches);
      console.log("DEBUG_QUICK top 8:", (allMatches||[]).slice(0,8).map(m=>({brand:m.brand, score:m.score, onroad:m.onroad, model:(m.row && m.idxModel>=0)?m.row[m.idxModel]:null, variant:(m.row && m.idxVariant>=0)?m.row[m.idxVariant]:null})));
    }

// =========================================================
// END PRE-STRICT RESPONSE HANDLER
// =========================================================

 // after allMatches is populated + sorted
// BEFORE strictModel filtering

// ---------------------------------------------------------
    // STRICT MODEL MATCHING ENGINE (Option A) — safer fallback
    // ---------------------------------------------------------
    let strictModel = null;
    try {
      const ALL_MODEL_KEYWORDS = new Set();
      if (typeof _config.MODEL_ALIASES !== 'undefined') {
        for (const [canon, syns] of Object.entries(_config.MODEL_ALIASES)) {
          if (canon) ALL_MODEL_KEYWORDS.add(String(normForMatch(canon)).toUpperCase());
          if (Array.isArray(syns)) syns.forEach(s => s && ALL_MODEL_KEYWORDS.add(String(normForMatch(s)).toUpperCase()));
        }
      }
      if (typeof _config.BRAND_HINTS !== 'undefined') {
        for (const arr of Object.values(_config.BRAND_HINTS)) {
          if (!Array.isArray(arr)) continue;
          for (const v of arr) {
            if (v) ALL_MODEL_KEYWORDS.add(String(normForMatch(v)).toUpperCase());
          }
        }
      }

      const tokenSource = (coreTokensArr && coreTokensArr.length) ? coreTokensArr : (tokens && tokens.length ? tokens : []);
      for (const tk of tokenSource) {
        const tku = String(normForMatch(tk || '')).toUpperCase();
        if (!tku) continue;
        if (ALL_MODEL_KEYWORDS.has(tku)) { strictModel = tku; break; }
      }
    } catch (e) {
      if (typeof _config.DEBUG !== 'undefined' && _config.DEBUG) console.warn('strictModel engine failed:', e && e.message);
    }

    if (strictModel) {
      const filteredMatches = allMatches.filter(m => {
  if (!m || typeof m.idxModel === 'undefined' || m.idxModel < 0) return false;

  const mdlRaw  = String(m.row[m.idxModel] || '').toUpperCase();
  const mdlNorm = String(normForMatch(mdlRaw)).toUpperCase();

  // Exact model match
  if (
  mdlNorm === strictModel ||
  (m.idxVariant >= 0 &&
   normForMatch(m.row[m.idxVariant]).toUpperCase().includes(strictModel))
) {
  return true;
}

  // Allow sub-variants ONLY if strictModel itself contains that keyword
  // e.g. "FORTUNER LEGENDER" should not match "FORTUNER"
  if (
    mdlNorm.startsWith(strictModel + ' ') &&
    !mdlNorm.includes('LEGENDER') &&
    !strictModel.includes('LEGENDER')
  ) {
    return true;
  }

  return false;
});

      if (typeof _config.DEBUG !== 'undefined' && _config.DEBUG) console.log("DEBUG_QUICK: strictModel=", strictModel, "filteredMatches=", filteredMatches.length);

      if (filteredMatches.length > 0) {
        allMatches = filteredMatches;
        if (allMatches.length > 1 && !hasVariantLock) {
          const out = [];
          out.push(`*Available variants — ${strictModel}*`);
          allMatches.forEach((m, i) => {
            const mdl = String(m.row[m.idxModel] || '').trim();

// ---- HARD FILTER: STRICT MODEL ONLY ----
if (
  strictModel &&
  mdl &&
  !mdl.toUpperCase().startsWith(strictModel)
) {
  return; // skip this row only
}

            const varr = String(m.row[m.idxVariant] || '').trim();
            out.push(`${i+1}) *${mdl} ${varr}* – On-road ₹ ${fmtMoney(m.onroad)}`);
          });
          await _config.waSendText(to, out.join("\n"));
          _config.setLastService(to, 'NEW');
          return true;
        }
      } else {
        strictModel = null;
      }
    }

    // if user asked only the brand/model (very short query) — show short variant list
    if (
  coreTokensArr.length === 1 &&
  !exactModelHit &&
  !wantsAllStates
) {
      const distinct = [];
      const seenTitles = new Set();
      for (const m of allMatches) {
  if (allowedBrandSet && !allowedBrandSet.has(m.brand)) continue;
  if ((m.score || 0) < Number(process.env.MIN_MATCH_SCORE || 12)) continue;

  const row = m.row;
  const modelVal = m.idxModel >= 0 ? String(row[m.idxModel] || '').toUpperCase() : '';
  const variantVal = m.idxVariant >= 0 ? String(row[m.idxVariant] || '').toUpperCase() : '';

  // 🔒 HARD BASE-MODEL LOCK (NO MIXING)
  if (
  baseModelToken &&
  !modelVal.includes(baseModelToken)
) continue;

  const title = [
  modelVal,
  variantVal,
  m.fuel || ''
].filter(Boolean).join(' ').trim();

  if (!title) continue;
  if (seenTitles.has(title)) continue;

  seenTitles.add(title);
  distinct.push({ title, onroad: m.onroad || 0, brand: m.brand, score: m.score || 0 });

  // ❗ DO NOT FILL FROM OTHER MODELS
  if (distinct.length >= VARIANT_LIST_LIMIT) break;
}
      if (distinct.length > 1) {

       if (userBudget) {
          const mid = (budgetMin + budgetMax) / 2;
          distinct.sort((a,b) => (b.score - a.score) || (Math.abs(a.onroad - mid) - Math.abs(b.onroad - mid)));
        } else {
          distinct.sort((a,b) => b.score - a.score);
        }

        const lines = [];
        lines.push(`*Available variants (${distinct.length}) — ${coreTokensArr[0].toUpperCase()}*`);
        if (userBudget) {
          lines.push(`*Budget:* ₹ ${fmtMoney(userBudget)}  (Showing ~ ${Math.round((budgetMin||userBudget)/100000)/10}L - ${Math.round((budgetMax||userBudget)/100000)/10}L)`);
          lines.push('');
        }
        for (let i = 0; i < distinct.length; i++) {
          const d = distinct[i];
          lines.push(`${i + 1}) *${d.title}* – On-road ₹ ${fmtMoney(d.onroad)}`);
        }
        lines.push('');
        lines.push('Reply with the *number* (1–25) to get the detailed on-road price & offers for that variant.');

// ---- STORE VARIANT LIST FOR SERIAL SELECTION ----
if (!global.lastVariantList) global.lastVariantList = new Map();
if (!global.panIndiaPrompt) global.panIndiaPrompt = new Map();

global.lastVariantList.set(to, {
  ts: Date.now(),
  variants: distinct   // EXACTLY what user sees
});

await _config.waSendText(to, lines.join('\n'));
_config.setLastService(to, 'NEW');
        return true;
      }
    }
// --------------------------------------------------
// PAN-INDIA MUST BE EXPLICIT (NO OVERRIDE OF SINGLE QUOTE)
// --------------------------------------------------
const explicitPanIndiaIntent =
  /\b(pan\s*india|all\s*india|all\s*states|state\s*wise|compare\s*states|across\s*states)\b/i.test(t);
const isPanIndiaFlow = explicitPanIndiaIntent === true;

// If user did NOT explicitly ask for comparison → skip Pan-India
if (wantsAllStates && !explicitPanIndiaIntent) {
  // Do nothing here, allow normal single-city quote logic to run
} else if (!explicitPanIndiaIntent) {
  // extra safety
}
// ================= PAN-INDIA PRICING (HARD BASE-MODEL LOCK) =================
if (!explicitPanIndiaIntent) {
  if (_config.DEBUG) console.log('PAN-INDIA SKIPPED: explicit intent not present');
} else {

// ================= PAN-INDIA PRICING (HARD BASE-MODEL LOCK) =================

// 1) Lock strictly to the base model user asked for (e.g. fortuner / legender)
const panBaseToken =
  coreTokensArr && coreTokensArr.length
    ? normForMatch(coreTokensArr[0])
    : null;

let panMatches = allMatches;

if (panBaseToken) {
  panMatches = allMatches.filter(m => {
    if (!m || m.idxModel < 0) return false;
    const mdlNorm = normForMatch(String(m.row[m.idxModel] || ''));
    return mdlNorm.startsWith(panBaseToken);
  });
}

// Safe fallback (never crash / never empty)
if (!panMatches.length) {
  panMatches = allMatches;
}

// 2) Use ONLY the locked match for pan-india extraction
const panIndiaMatch = panMatches[0];

const header = tables[panIndiaMatch.brand]?.header || [];
const aggregate = extractPanIndiaPricesFromRow(
  panIndiaMatch.row,
  header
);

const states = Object.keys(aggregate);
if (!states.length) {
  await _config.waSendText(
    to,
    "State-wise pricing is not available for this model. Please ask for a city-specific quote."
  );
  return true;
}

states.sort((a, b) => aggregate[a] - aggregate[b]);

const mdl =
  String(panIndiaMatch.row[panIndiaMatch.idxModel] || '').toUpperCase();
const varr =
  String(panIndiaMatch.row[panIndiaMatch.idxVariant] || '').toUpperCase();

const out = [];
out.push(`*${mdl} ${varr} — Pan-India On-Road Pricing*`);
out.push('');
out.push(`✅ *Lowest:* ${states[0]} — ₹ ${fmtMoney(aggregate[states[0]])}`);
out.push(`❌ *Highest:* ${states[states.length - 1]} — ₹ ${fmtMoney(aggregate[states[states.length - 1]])}`);
out.push('');
out.push('*State-wise prices:*');

states.forEach(st => {
  out.push(`• *${st}* → ₹ ${fmtMoney(aggregate[st])}`);
});

out.push('');
out.push('Reply with a *state or city name* to get the exact on-road price and finance details.');

await _config.waSendText(to, out.join('\n'));
_config.setLastService(to, 'NEW');
return true;
}
const distinct = [];
const seenTitles = new Set();

for (const m of allMatches) {
  if (allowedBrandSet && !allowedBrandSet.has(m.brand)) continue;
  if ((m.score || 0) < Number(process.env.MIN_MATCH_SCORE || 12)) continue;

  const row = m.row;
  const modelVal = m.idxModel >= 0 ? String(row[m.idxModel] || '').toUpperCase() : '';
  const variantVal = m.idxVariant >= 0 ? String(row[m.idxVariant] || '').toUpperCase() : '';

  // HARD BASE MODEL FILTER — SAFE (allow variant rescue)
const baseToken = coreTokensArr[0]?.toUpperCase();

if (
  baseToken &&
  !modelVal.includes(baseToken) &&
  !(variantVal && variantVal.startsWith(baseToken))
) {
  continue;
}

  const title = [
  modelVal,
  variantVal,
  m.fuel || ''
].filter(Boolean).join(' ').trim();

  if (!title || seenTitles.has(title)) continue;

  seenTitles.add(title);
  distinct.push({ title, onroad: m.onroad || 0 });

  if (distinct.length >= VARIANT_LIST_LIMIT) break;
}

console.log('DEBUG_FLOW: BEFORE SINGLE QUOTE', {
  allMatches: allMatches.length,
  exactModelHit,
  userBudget,
  wantsAllStates,
  explicitPanIndiaIntent
});

const isSingleQuote =
  !explicitPanIndiaIntent &&   // PAN-India explicitly asked → no EMI
  !wantsAllStates &&           // safety: state-wise request → no EMI
  !userBudget &&               // budget flow → no EMI
  allMatches.length >= 1;      // 👈 KEY FIX (was === 1)

// 2️⃣ VARIANT LIST (WHEN USER DID NOT SPECIFY VARIANT)
if (
  allMatches.length >= 2 &&
  !userHasExplicitVariant &&
  !userBudget &&
  !wantsAllStates
) {
  const seen = new Set();
  const variants = [];

  for (const m of allMatches) {
    const v = String(m.row[m.idxVariant] || '').trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    variants.push(m);
  }

  if (variants.length >= 2) {
    const out = [];
    out.push(`*Available Variants — ${resolvedModel || 'Model'}*`);

    variants.forEach((m, i) => {
      const mdl = String(m.row[m.idxModel] || '').trim();
      const varr = String(m.row[m.idxVariant] || '').trim();
      out.push(`${i + 1}) *${mdl} ${varr}*`);
    });

    out.push('');
    out.push('Reply with the *variant name* to get on-road price.');

    await _config.waSendText(to, out.join('\n'));
    return true; // ⛔ STOP — do NOT fall into single-quote
  }
}

// 3️⃣ SINGLE BEST QUOTE (PRIORITY)
if (
  allMatches.length >= 1 &&
  !userBudget &&
  !wantsAllStates &&
  (allMatches.length === 1 || userHasExplicitVariant)
) {
  const best = allMatches[0];
  if (!best) return false;

  const loanAmt =
  Number(String(best.exShow || '').replace(/[,₹\s]/g, '')) ||
  Number(String(best.onroad || '').replace(/[,₹\s]/g, '')) ||
  0;
  const roi = Number(process.env.NEW_CAR_ROI || 8.1); // default ROI
  const emi60 = loanAmt ? calcEmiSimple(loanAmt, roi, 60) : 0;

  const mdl =
    best.idxModel >= 0 ? String(best.row[best.idxModel] || '').toUpperCase() : '';
  const varr =
    best.idxVariant >= 0 ? String(best.row[best.idxVariant] || '').toUpperCase() : '';
  const fuelStr = best.fuel ? String(best.fuel).toUpperCase() : '';

  const lines = [];
lines.push(`*${best.brand}* ${mdl} ${varr}`);

// ✅ SAFE location display — no undefined variables
let pricingLocation = city;

try {
  // If pricing row contains a city/state column, prefer it
  if (
    best &&
    best.row &&
    typeof best.idxCity === 'number' &&
    best.idxCity >= 0 &&
    best.row[best.idxCity]
  ) {
    pricingLocation = String(best.row[best.idxCity]);
  }
} catch (e) {
  pricingLocation = city;
}

// ---------- LOCATION DISPLAY (FINAL & CORRECT) ----------
lines.push(
  `*Location:* ${(stateMatch || 'DELHI').toUpperCase()} • *Profile:* ${profile.toUpperCase()}`
);
  if (fuelStr) lines.push(`*Fuel:* ${fuelStr}`);
  if (best.exShow) lines.push(`*Ex-Showroom:* ₹ ${fmtMoney(best.exShow)}`);
  if (best.onroad)
    lines.push(`*On-Road (${audience.toUpperCase()}):* ₹ ${fmtMoney(best.onroad)}`);

// ---------- EMI (ONLY FOR SINGLE QUOTE) ----------
if (isSingleQuote && loanAmt > 0) {

  // 🔍 DEBUG — confirms EMI gate is entered
  if (_config.DEBUG) {
    console.log('DEBUG_EMI_RENDER:', {
      isSingleQuote,
      loanAmt,
      exShow: best.exShow,
      onroad: best.onroad,
      emi60,
      roi
    });
  }

  lines.push('*🔹 Loan & EMI Options*');
  lines.push('');

  // OPTION 1 — NORMAL EMI
  lines.push('*OPTION 1 – NORMAL EMI*');
  lines.push(`Loan Amount: 100% of Ex-Showroom → ₹ ${fmtMoney(loanAmt)}`);
  lines.push(`Tenure: 60 months @ ${roi}% p.a.`);
  lines.push(`Approx EMI: ₹ *${fmtMoney(emi60)}*`);

 // OPTION 2 — BULLET EMI (25%)  ✅ BANK-APPROVED LOGIC
try {
  const bulletPct = 0.25;

  // 🔁 EXACT SAME ENGINE AS MANUAL BULLET EMI
  const bulletSim = simulateBulletPlan({
    amount: loanAmt,
    rate: roi,
    months: 60,
    bulletPct
  });

  const bulletEmi =
    bulletSim?.monthly_emi ||
    bulletSim?.monthlyEmi ||
    bulletSim?.emi ||
    null;

  const bulletAmt =
    bulletSim?.bullet_amount ||
    bulletSim?.bulletAmount ||
    Math.round(loanAmt * bulletPct);

  if (!bulletEmi || !bulletAmt) {
    if (_config.DEBUG) console.warn('NEW CAR BULLET EMI FAILED');
  } else {
    const perBullet = Math.round(bulletAmt / 5);
    const bulletSchedule = [12, 24, 36, 48, 60]
      .map(m => `₹ ${fmtMoney(perBullet)} at month ${m}`)
      .join('\n');

    if (_config.DEBUG) {
      console.log('DEBUG_BULLET_NEW_CAR_BANK_ALIGNED:', {
        loanAmt,
        roi,
        bulletEmi,
        bulletAmt
      });
    }

    lines.push('');
    lines.push('*OPTION 2 – BULLET EMI (25%)*');
    lines.push(`Monthly EMI (approx): ₹ *${fmtMoney(bulletEmi)}*`);
    lines.push(`Bullet total (25% of loan): ₹ *${fmtMoney(bulletAmt)}*`);
    lines.push('');
    lines.push('*Bullets:*');
    lines.push(bulletSchedule);
  }
} catch (e) {
  if (_config.DEBUG) console.warn('NEW CAR BULLET EMI ERROR:', e?.message);
}
  lines.push('');
  lines.push('_EMI figures are indicative. Final approval, ROI & structure subject to bank terms._');
  lines.push('*Terms & Conditions Apply ✅*');
}


// ---------- CTA ----------
if (isSingleQuote) {
  lines.push('\nReply *SPEC model* for features or *EMI* for finance.');
}

// ---- PAN-INDIA FOLLOW-UP CONTEXT (SAFE) ----
global.panIndiaPrompt.set(to, {
  row: best.row,
  header: tables[best.brand]?.header || [],
  title: `${best.brand} ${mdl} ${varr}`
});

await _config.waSendText(to, lines.join('\n'));

await _config.waSendText(
  to,
  'Would you like a *Pan-India on-road price comparison* for this variant?\n\nReply *YES* or *NO*.'
);

_config.setLastService(to, 'PAN_INDIA_PROMPT');
return true;
}

   // ---------------- SPEC SHEET (FINAL, SAFE) ----------------
try {
  const specIntent = /\b(spec|specs|specification|specifications|feature|features)\b/i;

  if (wantsSpecs) {

    const specQuery = `${best.brand} ${modelName} ${variantStr} full technical specifications for India (engine, bhp, torque, seating, dimensions, tyres, safety, mileage).`;
    let specText = "";

    // 1) RAG attempt
    try {
      if (typeof _config.findRelevantChunks === "function") {
        const chunks = await _config.findRelevantChunks(specQuery, 4);
        if (Array.isArray(chunks) && chunks.length) {
          const joined = chunks
            .map(c => (c.text || c.content || "").trim())
            .filter(Boolean)
            .join("\n");
          if (joined && joined.length > 80) specText = joined;
        }
      }
    } catch (e) {
      if (_config.DEBUG) console.warn("Spec RAG failed:", e?.message);
    }

    // 2) Signature AI fallback (with retry)
    if (!specText && typeof _config.SignatureAI_RAG === "function") {
      try {
        let aiSpec = await _config.SignatureAI_RAG(
          `Provide concise India-spec technical specs for ${best.brand} ${modelName} ${variantStr}:\n` +
          `- Engine & displacement\n- Power & torque\n- Transmission\n- Mileage\n- Seating\n- Safety highlights`
        );

        if (!aiSpec || aiSpec.trim().length < 40) {
          aiSpec = await _config.SignatureAI_RAG(
            `6 bullet technical highlights for ${best.brand} ${modelName} ${variantStr}`
          );
        }

        if (aiSpec && aiSpec.trim().length > 30) specText = aiSpec.trim();
      } catch (e) {
        if (_config.DEBUG) console.warn("Spec SignatureAI fallback failed:", e?.message);
      }
    }

    // Append safely
    if (specText) {
      const MAX_SPEC_LEN = 1200;
      lines.push("");
      lines.push("*Key Specifications (Approx., India spec)*");
      lines.push(
        specText.length > MAX_SPEC_LEN
          ? specText.slice(0, MAX_SPEC_LEN) + "\u2026"
          : specText
      );
    }
  }
} catch (err) {
  if (_config.DEBUG) console.warn("Spec block error:", err?.message);
}
// ---------------- END SPEC SHEET ----------------
    await _config.waSendText(to, lines.join('\n'));
    await _config.sendNewCarButtons(to);
    _config.incrementQuoteUsage(to);
    _config.setLastService(to, 'NEW');
    return true;

  } catch (e) {
    console.error('tryQuickNewCarQuote error', e && e.stack ? e.stack : e);
    return false;
  }
}

module.exports = { init, trySmartNewCarIntent, tryQuickNewCarQuote };
