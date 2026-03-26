// lib/usedCars.cjs — Used-car quote functions extracted from server.cjs
'use strict';

const { normForMatch, fmtMoney, calcEmiSimple, loadUsedSheetRows, simulateBulletPlan, parseCsv, fetchCsv } = require('./pricing.cjs');

let _config = {};
function init(config) { _config = config; }

// ---------- header index helper (copied from server.cjs) ----------
function toHeaderIndexMap(headerRow) {
  const map = {};
  headerRow.forEach((h, i) => {
    map[String((h || '').trim()).toUpperCase()] = i;
  });
  return map;
}

// ---------------- Build SINGLE used car quote (REUSE EXISTING FORMAT) ----------------
async function buildSingleUsedCarQuote(row, from) {
  if (!row || !Array.isArray(row)) {
    return { text: 'Used car details unavailable.' };
  }

  // Build a query from the row so we reuse the SAME formatter
  const parts = [];
  for (const v of row) {
    const s = String(v || '').trim();
    if (!s) continue;

    // Pick likely identifiers: brand / model / year
    if (
      /\b(19|20)\d{2}\b/.test(s) ||   // year
      s.length <= 20                  // brand / model / variant
    ) {
      parts.push(s);
    }

    if (parts.length >= 3) break;
  }

  const queryText = parts.join(' ');

  // Reuse the existing used-car quote engine
  const res = await buildUsedCarQuoteFreeText({
    query: queryText,
    from
  });

  return res || { text: 'Used car quote unavailable.' };
}
// ---------------- Build used car quote ----------------
async function buildUsedCarQuoteFreeText({ query, from }) {
  const rows = await loadUsedSheetRows();
  if (!rows || !rows.length) {
    return { text: 'Used car pricing not configured.' };
  }

  const header = rows[0].map(h => String(h || '').trim().toUpperCase());
  const idxMap = toHeaderIndexMap(header);
  const data   = rows.slice(1);

  const makeIdx = idxMap['MAKE'] ?? idxMap['BRAND'] ?? header.findIndex(h => h.includes('MAKE') || h.includes('BRAND'));
  const modelIdx = idxMap['MODEL'] ?? header.findIndex(h => h.includes('MODEL'));
  const subModelIdx = idxMap['SUB MODEL'] ?? idxMap['SUBMODEL'] ?? header.findIndex(h => h.includes('SUB MODEL') || h.includes('SUBMODEL') || h.includes('VARIANT'));
  const colourIdx = idxMap['COLOUR'] ?? idxMap['COLOR'] ?? header.findIndex(h => h.includes('COLOUR') || h.includes('COLOR'));
  const yearIdx = idxMap['MANUFACTURING YEAR'] ?? idxMap['YEAR'] ?? header.findIndex(h => h.includes('MANUFACTURING') && h.includes('YEAR'));
  const regIdx = (() => {
    const keys = Object.keys(idxMap);
    for (const k of keys) {
      const u = k.toUpperCase();
      if (u.includes('REGISTRATION') || u.includes('REGN') || u.includes('REG PLACE')) {
        return idxMap[k];
      }
    }
    return -1;
  })();

  const expectedCandidates = [
    'EXPECTED PRICE',
    'EXPECTED_PRICE',
    'EXPECTED PRICE (₹)',
    'EXPECTED PRICE(INR)',
    'EXPECTED PRICE INR',
    'EXPECTED',
    'PRICE'
  ];
  let expectedIdx = -1;
  for (const key of expectedCandidates) {
    if (typeof idxMap[key] !== 'undefined') {
      expectedIdx = idxMap[key];
      break;
    }
  }
  if (expectedIdx < 0) {
    const ei = header.findIndex(h => h.includes('EXPECTED') && h.includes('PRICE'));
    if (ei >= 0) expectedIdx = ei;
  }

  const pictureIdx = (() => {
    const keys = Object.keys(idxMap);
    for (const k of keys) {
      const u = k.toUpperCase();
      if (u.includes('PICTURE') || u.includes('PHOTO') || u.includes('IMAGE') || u.includes('LINK')) {
        return idxMap[k];
      }
    }
    return -1;
  })();

  const qLower = (query || '').toLowerCase();
  const tokens = qLower.replace(/[^\w\s]/g, ' ').split(/\s+/).filter(Boolean);
  // ---- Budget-based search for used cars (± ₹10 lakh) ----
  let budgetRs = 0;

  // Find a number like "20 lakh", "20 lac", "20 l", or a plain "2000000"
  const mBudget = qLower.match(/(\d+(\.\d+)?)\s*(lakh|lakhs|lac|lacs|l\b|rs|₹|rupees)?/);
  if (mBudget) {
    const num = parseFloat(mBudget[1]);
    if (num > 0) {
      // If the number is small (e.g., 20), treat as lakhs → 20 * 1,00,000
      budgetRs = num < 1000 ? num * 100000 : num;
    }
  }

  // Helper for simple INR formatting
  function fmtINR(v) {
    const n = Math.round(Number(v) || 0);
    return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  if (budgetRs > 0 && expectedIdx >= 0) {
    const min = budgetRs - 1000000; // - 10 lakh
    const max = budgetRs + 1000000; // + 10 lakh

    const budgetMatches = [];

    for (let r = 0; r < data.length; r++) {
      const row = data[r];

      let expectedVal = 0;
      if (expectedIdx >= 0) {
        const exStr = String(row[expectedIdx] || '');
        expectedVal = Number(exStr.replace(/[,₹\s]/g, '')) || 0;
      }
      if (!expectedVal) continue;
      if (expectedVal < min || expectedVal > max) continue;

      budgetMatches.push({ row, expectedVal });
    }

    if (budgetMatches.length) {
      // Sort by price closest to requested budget
      budgetMatches.sort((a, b) => {
        const da = Math.abs(a.expectedVal - budgetRs);
        const db = Math.abs(b.expectedVal - budgetRs);
        return da - db;
      });

      const lines = [];
      lines.push(`*PRE-OWNED OPTIONS AROUND YOUR BUDGET*`);
      lines.push(
        `(Showing cars roughly between ₹${fmtINR(min)} and ₹${fmtINR(max)})`
      );

      const limit = Math.min(10, budgetMatches.length);
      for (let i = 0; i < limit; i++) {
        const { row, expectedVal } = budgetMatches[i];

        const makeDisp  = (row[makeIdx]  || '').toString().toUpperCase();
        const modelDisp = (row[modelIdx] || '').toString().toUpperCase();
        const subDisp   = subModelIdx >= 0 && row[subModelIdx]
          ? row[subModelIdx].toString().toUpperCase()
          : '';
        const yearDisp  = yearIdx >= 0 && row[yearIdx] ? String(row[yearIdx]) : '';
        const regPlace  = regIdx >= 0 && row[regIdx] ? String(row[regIdx]) : '';

        const titleParts = [];
        if (makeDisp)  titleParts.push(makeDisp);
        if (modelDisp) titleParts.push(modelDisp);
        if (subDisp)   titleParts.push(subDisp);

        const infoParts = [];
        if (yearDisp)  infoParts.push(yearDisp);
        if (regPlace)  infoParts.push(regPlace);

        const lineTitle = titleParts.length
          ? `*${titleParts.join(' ')}*`
          : '*PRE-OWNED CAR*';

        const lineInfo = infoParts.length
          ? ` (${infoParts.join(' | ')})`
          : '';

        lines.push(
          `${i + 1}. ${lineTitle}${lineInfo}\n   Expected: ₹${fmtINR(expectedVal)}`
        );
      }

      // Pick first available picture (if any)
      let picLink = '';
      if (pictureIdx >= 0) {
        for (const bm of budgetMatches) {
          const link = bm.row[pictureIdx];
          if (link) {
            picLink = String(link);
            break;
          }
        }
      }
// ---- STORE USED CAR LIST FOR SERIAL SELECTION (BUDGET FLOW) ----
if (!global.lastUsedCarList) global.lastUsedCarList = new Map();
global.lastUsedCarList.set(from, {
  ts: Date.now(),
  rows: budgetMatches.map(bm => bm.row)
});

      return { text: lines.join('\n'), picLink };
    }
    // If no cars found in that price band, fall through to normal text-based matching below
  }

  const matches = [];
  for (let r = 0; r < data.length; r++) {
    const row = data[r];
    const make = String(row[makeIdx] || '').toLowerCase();
    const model = String(row[modelIdx] || '').toLowerCase();
    const sub  = subModelIdx >= 0 ? String(row[subModelIdx] || '').toLowerCase() : '';

    let score = 0;
    for (const t of tokens) {
      if (!t) continue;
      if (make.includes(t)) score += 8;
      if (model.includes(t)) score += 10;
      if (sub.includes(t)) score += 6;
    }
    if (score > 0) {
      matches.push({ r, score, make, model, sub, row });
    }
  }

  if (!matches.length) {
    return {
      text:
        `Sorry, I couldn't find an exact match for "${query}".\n` +
        `Please share brand and model (e.g., "Audi A6 2018") or give a budget and I'll suggest options.`
    };
  }

  // Brand-level search: e.g. "audi", "used audi", "pre owned audi"
  const genericWords = new Set([
    'used', 'preowned', 'pre-owned', 'pre', 'owned', 'second', 'secondhand', 'second-hand',
    'car', 'cars'
  ]);
  const coreTokens = tokens.filter(t => t && !genericWords.has(t));
  if (coreTokens.length === 1) {
    const brandTok = coreTokens[0];
    let brandMatches = matches.filter(m => m.make.includes(brandTok));
    if (!brandMatches.length) brandMatches = matches;
    if (brandMatches.length > 1) {
      brandMatches.sort((a, b) => b.score - a.score);
      const top = brandMatches.slice(0, Math.min(10, brandMatches.length));
      const lines = [];
      const brandLabel = brandTok.toUpperCase();
      lines.push(`*PRE-OWNED OPTIONS – ${brandLabel}*`);
      for (let i = 0; i < top.length; i++) {
        const row = top[i].row;
        const makeDisp  = (row[makeIdx]  || '').toString().toUpperCase();
        const modelDisp = (row[modelIdx] || '').toString().toUpperCase();
        const subDisp   = subModelIdx >= 0 && row[subModelIdx]
          ? row[subModelIdx].toString().toUpperCase()
          : '';
        const yearDisp  = yearIdx >= 0 && row[yearIdx] ? String(row[yearIdx]) : '';
        const regPlace  = regIdx >= 0 && row[regIdx] ? String(row[regIdx]) : '';

        let expectedVal = 0;
        if (expectedIdx >= 0) {
          const exStr = String(row[expectedIdx] || '');
          expectedVal = Number(exStr.replace(/[,₹\s]/g, '')) || 0;
        }

        const titleParts = [];
        if (makeDisp)  titleParts.push(makeDisp);
        if (modelDisp) titleParts.push(modelDisp);
        if (subDisp)   titleParts.push(subDisp);
        if (yearDisp)  titleParts.push(yearDisp);
        const title = titleParts.join(' ');

        let line = `${i + 1}) *${title}*`;
        if (expectedVal) line += ` – ₹ ${fmtMoney(expectedVal)}`;
        if (regPlace)   line += ` – Reg: ${regPlace}`;
        lines.push(line);
      }
      lines.push('');
      lines.push(
  'Reply with the *number* (1, 2, 3…) to get full details instantly, or type the *car name* (e.g. "Audi A6 2018").'
);

// ---- STORE USED CAR LIST FOR SERIAL SELECTION (BRAND FLOW) ----
if (!global.lastUsedCarList) global.lastUsedCarList = new Map();
global.lastUsedCarList.set(from, {
  ts: Date.now(),
  rows: top.map(t => t.row)
});

      return { text: lines.join('\n') };
    }
  }

  // Single best match (normal flow)
  matches.sort((a, b) => b.score - a.score);
  const selRow = matches[0].row;

  const make  = (selRow[makeIdx]  || '').toString().toUpperCase();
  const model = (selRow[modelIdx] || '').toString().toUpperCase();
  const sub   = subModelIdx >= 0 && selRow[subModelIdx] ? selRow[subModelIdx].toString().toUpperCase() : '';
  const colour = colourIdx >= 0 && selRow[colourIdx] ? selRow[colourIdx].toString().toUpperCase() : '';
  const year   = yearIdx >= 0 && selRow[yearIdx] ? String(selRow[yearIdx]) : '';
  const regPlace = regIdx >= 0 && selRow[regIdx] ? String(selRow[regIdx]) : '';

  const expectedStr = expectedIdx >= 0 ? String(selRow[expectedIdx] || '') : '';
  let expected = Number(expectedStr.replace(/[,₹\s]/g, '')) || 0;
  if (!expected) {
    for (let i = 0; i < selRow.length; i++) {
      const v = String(selRow[i] || '').replace(/[,₹\s]/g, '');
      if (/^\d+$/.test(v) && Number(v) > 100000) {
        expected = Number(v);
        break;
      }
    }
  }
  if (!expected) {
    return { text: `Price for *${make} ${model}* not available in sheet.` };
  }

  const USED_CAR_ROI_INTERNAL = _config.USED_CAR_ROI_INTERNAL;
  const USED_CAR_ROI_VISIBLE  = _config.USED_CAR_ROI_VISIBLE;

  const LTV_PCT = 95;
  const loanAmt = Math.round(expected * (LTV_PCT / 100));
  const tenure  = 60;

  const emiNormal = calcEmiSimple(loanAmt, USED_CAR_ROI_INTERNAL, tenure);
const bulletSim = simulateBulletPlan({
  amount: loanAmt,                 // ✔ loan amount
  rate:  USED_CAR_ROI_INTERNAL,    // ✔ your internal ROI (10%)
  months: tenure,                  // ✔ same tenure as normal EMI
  bulletPct: 0.25                  // ✔ 25% bullet
});

  let picLink = null;
  if (pictureIdx >= 0 && selRow[pictureIdx]) {
    const cellVal = String(selRow[pictureIdx] || '');
    if (cellVal.includes('http')) picLink = cellVal.trim();
  } else {
    for (const c of selRow) {
      const s = String(c || '');
      if (s.includes('http')) {
        picLink = s.trim();
        break;
      }
    }
  }

  const lines = [];
  lines.push('*PRE-OWNED CAR QUOTE*');
  lines.push(`Make/Model: *${make} ${model}${sub ? ' - ' + sub : ''}*`);
  if (year)     lines.push(`Manufacturing Year: ${year}`);
  if (colour)   lines.push(`Colour: ${colour}`);
  if (regPlace) lines.push(`Registration Place: ${regPlace}`);
  lines.push('');
  lines.push(`Expected Price: ₹ *${fmtMoney(expected)}*`);
  lines.push(`Loan up to *${LTV_PCT}% LTV*: ₹ *${fmtMoney(loanAmt)}*`);
  lines.push('');
  lines.push('*OPTION 1 – NORMAL EMI*');
  lines.push(`Tenure: ${tenure} months`);
  lines.push(`Approx EMI: ₹ *${fmtMoney(emiNormal)}* (@ *${USED_CAR_ROI_VISIBLE}%* p.a.)`);
  if (bulletSim) {
    lines.push('');
    lines.push('*OPTION 2 – BULLET EMI (25%)*');
    lines.push(`Tenure: ${bulletSim.months} months`);
    lines.push(`Monthly EMI (approx): ₹ *${fmtMoney(bulletSim.monthly_emi)}*`);
    lines.push(`Bullet total (25% of loan): ₹ *${fmtMoney(bulletSim.bullet_total)}*`);
    lines.push(
      `Bullets: ₹ *${fmtMoney(bulletSim.bullet_each)}* at months ` +
      Array.from({ length: bulletSim.num_bullets }, (_, i) => 12 * (i + 1)).join(', ')
    );
  }
  lines.push('');
  lines.push('✅ *Loan approval possible in ~30 minutes (T&Cs apply)*');
  lines.push('\n*Terms & Conditions Apply ✅*');

  return { text: lines.join('\n'), picLink };
}

module.exports = { init, buildSingleUsedCarQuote, buildUsedCarQuoteFreeText };
