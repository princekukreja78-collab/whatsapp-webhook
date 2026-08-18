// lib/variantSearch.cjs — website search that answers like the WhatsApp bot:
// type a model, get every variant with its on-road price for the chosen state,
// each row ready for a "Get best deal" ask. Reads the same brand pricing sheets
// the quote engine uses, and applies any price overrides on top.
'use strict';

const express = require('express');

let _config = {};
function init(config) { _config = config || {}; }

const num = v => Number(String(v ?? '').replace(/[^\d.]/g, '')) || 0;
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// State/profile → the sheet's own on-road and road-tax columns
const STATE_KEYS = {
  DELHI: { onRoad: ['ON ROAD PRICE DELHI INDIVIDUAL'], tax: ['ROAD TAX DELHI INDIVIDUAL'] },
  'DELHI-CORPORATE': { onRoad: ['ON ROAD PRICE DELHI CORPORATE'], tax: ['ROAD TAX DELHI CORPORATE'] },
  HARYANA: { onRoad: ['ON ROAD PRICE HARYANA'], tax: ['HARYANA(HR)', 'HARYANA'] },
  'UTTAR PRADESH': { onRoad: ['ON ROAD PRICE UTTARPRADESH', 'ON ROAD PRICE UTTAR PRADESH'], tax: ['UTTAR PRADESH'] },
  'HIMACHAL PRADESH': { onRoad: ['ON ROAD PRICE HIMACHAL'], tax: ['HIMACHAL'] }
};

function pickState(city) {
  const c = String(city || 'Delhi').toUpperCase();
  if (c.includes('HARYANA') || c.includes('GURGA') || c.includes('FARID')) return 'HARYANA';
  if (c.includes('UTTAR') || c.includes('NOIDA') || c.includes('GHAZIA') || c.includes('U.P')) return 'UTTAR PRADESH';
  if (c.includes('HIMACHAL') || c.includes('SHIMLA') || c.includes('H.P')) return 'HIMACHAL PRADESH';
  return 'DELHI';
}

function colIndex(header, candidates) {
  const H = header.map(h => String(h || '').toUpperCase().replace(/\s+/g, ' ').trim());
  for (const cand of candidates) {
    const i = H.findIndex(h => h.includes(cand));
    if (i >= 0) return i;
  }
  return -1;
}

function _cols(header) {
  return {
    make: colIndex(header, ['MAKE']),
    model: colIndex(header, ['MODEL']),
    variant: colIndex(header, ['VARIANT']),
    keywords: colIndex(header, ['VARIANT_KEYWORDS', 'KEYWORD']),
    fuel: colIndex(header, ['FUEL']),
    ex: colIndex(header, ['EX SHOWROOM', 'EX-SHOWROOM']),
    special: colIndex(header, ['SPECIAL PRICING']),
    benefit: colIndex(header, ['CUSTOMER BENEFIT']),
    tcs: colIndex(header, ['TCS']),
    cess: colIndex(header, ['GREEN CESS']),
    insShowroom: colIndex(header, ['INSURANCE (CONSUMABLES', 'INSURANCE (']),
    insAll: colIndex(header, ['INSURANCE WITH ALL COVERAGE']),
  };
}

/**
 * Read a budget out of the query the way the bot does: "under 15 lakh",
 * "around 12L", "budget 20 lakh", "1.2 crore", or a plain 6-8 digit number.
 */
function parseBudget(query) {
  const t = String(query || '').toLowerCase();
  const cr = t.match(/(\d+(?:\.\d+)?)\s*(?:cr\b|crore)/);
  if (cr) return Math.round(parseFloat(cr[1]) * 1e7);
  const lakh = t.match(/(\d+(?:\.\d+)?)\s*(?:lakh|lakhs|lac|lacs|l\b)/);
  if (lakh) return Math.round(parseFloat(lakh[1]) * 1e5);
  const plain = t.match(/\b(\d{6,8})\b/);
  if (plain) {
    const v = Number(plain[1]);
    if (v >= 200000 && v <= 5e7) return v;
  }
  return 0;
}

// What's left of the query once the budget words are removed — the model, if any
function stripBudgetWords(query) {
  return String(query || '')
    .replace(/(\d+(?:\.\d+)?)\s*(cr\b|crore|lakh|lakhs|lac|lacs|l\b)/gi, ' ')
    .replace(/\b(under|below|within|upto|up to|max|budget|around|about|near|approx|price|in|rs|inr|₹)\b/gi, ' ')
    .replace(/\b\d{4,8}\b/g, ' ')
    .trim();
}

/**
 * Search every brand pricing sheet for variants matching the query.
 */
async function search({ query, city = 'Delhi', limit = 14 }) {
  const budget = parseBudget(query);
  const modelPart = budget ? stripBudgetWords(query) : query;
  const q = norm(modelPart);
  // A pure budget query ("under 15 lakh") has no model left to match on
  const budgetOnly = budget > 0 && q.length < 3;
  if ((!q && !budget) || typeof _config.loadPricingFromSheets !== 'function') {
    return { cars: [], state: pickState(city) };
  }

  const state = pickState(city);
  const keys = STATE_KEYS[state] || STATE_KEYS.DELHI;
  const tables = await _config.loadPricingFromSheets();
  const out = [];

  for (const [brand, tb] of Object.entries(tables || {})) {
    if (brand === 'USED' || !tb || !Array.isArray(tb.data)) continue;
    const c = _cols(tb.header);
    if (c.variant < 0 || c.ex < 0) continue; // not a pricing sheet (e.g. a leads tab)
    const onRoadIdx = colIndex(tb.header, keys.onRoad);
    const taxIdx = colIndex(tb.header, keys.tax);

    for (const row of tb.data) {
      const make = String(row[c.make] || '').trim();
      let model = String(row[c.model] || '').trim();
      let variant = String(row[c.variant] || '').trim();
      if (!model && !variant) continue;

      // Sheets repeat themselves — "BMW BMW X7", variant echoing the model
      if (make && norm(model).startsWith(norm(make)) && norm(model) !== norm(make)) {
        model = model.replace(new RegExp(`^\\s*${make.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`, 'i'), '').trim();
      }
      if (variant && norm(model) && (norm(variant) === norm(model) || norm(variant).startsWith(norm(model)))) {
        const trimmed = variant.slice(model.length).trim();
        variant = trimmed || variant;
        if (norm(variant) === norm(model)) variant = '';
      }

      const hay = norm(`${make} ${model} ${variant} ${c.keywords >= 0 ? row[c.keywords] || '' : ''}`);
      if (!budgetOnly && q && !hay.includes(q)) continue;

      const ex = num(row[c.ex]);
      if (!ex) continue;
      const special = c.special >= 0 ? num(row[c.special]) : 0;
      // The "customer benefit" column means different things per brand sheet — only
      // trust it when it reads like a net ex-showroom figure, else derive it
      const benefitVal = c.benefit >= 0 ? num(row[c.benefit]) : 0;
      const netEx = benefitVal > ex * 0.5 ? benefitVal : ex - special;

      // Same guard on the state being searched: a bad column quoted a 12 lakh
      // Sonet at 22 lakh in UP. Better to omit the variant than to misprice it.
      const stateTaxCell = taxIdx >= 0 ? num(row[taxIdx]) : 0;
      if (stateTaxCell && _config.pricing && typeof _config.pricing.plausibleRoadTax === 'function'
          && !_config.pricing.plausibleRoadTax(ex, stateTaxCell, c.fuel >= 0 ? String(row[c.fuel] || '') : '')) {
        continue;
      }

      const sheetOnRoad = onRoadIdx >= 0 ? num(row[onRoadIdx]) : 0;
      let onRoad = sheetOnRoad;
      if (!onRoad) {
        // Sheet leaves the formula cell blank on export — rebuild it
        onRoad = netEx
          + (c.tcs >= 0 ? num(row[c.tcs]) : 0)
          + (c.cess >= 0 ? num(row[c.cess]) : 0)
          + (taxIdx >= 0 ? num(row[taxIdx]) : 0)
          + (c.insAll >= 0 ? num(row[c.insAll]) : (c.insShowroom >= 0 ? num(row[c.insShowroom]) : 0));
      }
      if (!onRoad) continue;

      // A price correction forwarded on WhatsApp wins over the sheet.
      // effEx/effNetEx carry the corrected ex-showroom forward: the EMI runs on
      // ex-showroom and the breakup prints it, so leaving them on the sheet value
      // would show a corrected on-road beside a stale EMI.
      let overridden = false, discountNote = null;
      let effEx = ex, effNetEx = netEx;
      if (_config.priceSync) {
        const o = _config.priceSync.lookup(make || brand, model, variant);
        if (o) {
          if (o.exShowroom) {
            onRoad = onRoad - ex + o.exShowroom;
            effNetEx = netEx - ex + o.exShowroom;
            effEx = o.exShowroom;
            overridden = true;
          }
          if (o.onRoad) { onRoad = o.onRoad; overridden = true; }
          discountNote = _config.priceSync.discountLine(o);
        }
        // Always carry a discount note, so the site's benefit column is never blank
        if (!discountNote) discountNote = _config.priceSync.discountLine(null);
      }

      // Banks fund 100% of ex-showroom on a new car — same basis the bot quotes
      const emi = typeof _config.calcEmiSimple === 'function'
        ? _config.calcEmiSimple(Math.round(effEx), 8.1, 60)
        : 0;

      const roadTax = taxIdx >= 0 ? num(row[taxIdx]) : 0;
      const insShowroom = c.insShowroom >= 0 ? num(row[c.insShowroom]) : 0;
      const insurance = c.insAll >= 0 ? num(row[c.insAll]) : insShowroom;
      // Benefit 1: our insurance rate against the showroom quote
      const insuranceBenefit = insShowroom > insurance ? insShowroom - insurance : 0;
      const tcs = c.tcs >= 0 ? num(row[c.tcs]) : 0;
      const cess = c.cess >= 0 ? num(row[c.cess]) : 0;

      out.push({
        id: `${brand}-${out.length}`,
        // Itemised on-road build-up, in the shape the website's breakup panel renders.
        // otherCharges absorbs the residual so the parts always add up to the total.
        breakup: {
          exShowroom: Math.round(effEx),
          customerBenefit: special || 0,
          tcs, greenCess: cess, roadTax,
          insuranceAll: insurance,
          insuranceShowroom: insShowroom,
          insuranceBenefit,
          otherCharges: Math.round(onRoad - (effNetEx + tcs + cess + roadTax + insurance)),
          total: Math.round(onRoad),
          hasExactData: sheetOnRoad > 0,
          state
        },
        fuel: c.fuel >= 0 && row[c.fuel] ? String(row[c.fuel]).trim() : '',
        brand: make || brand,
        model,
        variant,
        // Shape the website already renders
        price: Math.round(onRoad),
        emi: Math.round(emi),
        tags: [
          c.fuel >= 0 && row[c.fuel] ? String(row[c.fuel]).trim() : null,
          `${state.replace('UTTAR PRADESH', 'U.P.')} on-road`,
          special ? `₹${special.toLocaleString('en-IN')} benefit` : null,
          overridden ? 'updated price' : null
        ].filter(Boolean),
        exShowroom: Math.round(ex),
        discount: special || null,
        insuranceBenefit,
        discountNote,
        state
      });
      if (!budget && out.length >= limit) break;
    }
    if (!budget && out.length >= limit) break;
  }

  if (budget) {
    const margin = Number(process.env.NEW_CAR_BUDGET_MARGIN || 0.2);
    const ceiling = Math.round(budget * (1 + margin));
    const within = out.filter(c => c.price <= budget);
    const stretch = out
      .filter(c => c.price > budget && c.price <= ceiling)
      .map(c => ({ ...c, stretch: true, tags: [...c.tags, 'slightly above budget'] }));

    // One row per model — a budget shopper wants choice, not 14 trims of one car
    const bestPerModel = new Map();
    for (const c of [...within].sort((a, b) => b.price - a.price)) {
      const key = norm(`${c.brand} ${c.model}`);
      if (!bestPerModel.has(key)) bestPerModel.set(key, c); // richest variant that fits
    }
    const picks = [...bestPerModel.values()].sort((a, b) => b.price - a.price).slice(0, limit);

    if (picks.length < 4 && stretch.length) {
      const seen = new Set(picks.map(c => norm(`${c.brand} ${c.model}`)));
      for (const c of stretch.sort((a, b) => a.price - b.price)) {
        const key = norm(`${c.brand} ${c.model}`);
        if (seen.has(key)) continue;
        seen.add(key);
        picks.push(c);
        if (picks.length >= limit) break;
      }
    }
    return { cars: picks, state, budget, mode: budgetOnly ? 'budget' : 'model+budget' };
  }

  // Cheapest variant first — customers scan upward from the entry price
  out.sort((a, b) => a.price - b.price);
  return { cars: out, state };
}

// ---------------- router ----------------
const router = express.Router();

router.post('/api/vehyra/search', express.json(), async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const query = String(req.body?.query || req.body?.msgText || '').trim();
    if (!query) return res.json({ ok: false, error: 'Query missing' });
    const city = req.body?.city || req.body?.state || 'Delhi';

    // Cars physically in stock come first — they can be seen today
    let stock = [];
    if (_config.inventory && typeof _config.inventory.searchLive === 'function') {
      stock = _config.inventory.searchLive(query);
    }
    const { cars, state, budget, mode } = await search({ query, city });
    res.json({ ok: true, cars: [...stock, ...cars], state, budget: budget || 0, mode: mode || 'model', source: 'sheets' });
  } catch (e) {
    console.warn('variantSearch failed', e.message);
    res.json({ ok: false, error: String(e.message || e), cars: [] });
  }
});

/**
 * On-road for one variant across every state the sheets price.
 * The WhatsApp bot has offered this comparison for a while; the site had no way
 * to ask for it. Same columns, same numbers, so the two never disagree.
 */
async function statePrices({ brand, model, variant }) {
  const tables = await _config.loadPricingFromSheets();
  const want = norm(`${model} ${variant}`);
  if (!want) return { rows: [] };

  for (const [tblBrand, tb] of Object.entries(tables || {})) {
    if (!tb || !Array.isArray(tb.data)) continue;
    if (brand && norm(tblBrand) !== norm(brand) && norm(String(tb.data[0]?.[_cols(tb.header).make] || '')) !== norm(brand)) {
      // keep looking unless the caller named no brand
      if (norm(tblBrand) !== norm(brand)) continue;
    }
    const c = _cols(tb.header);
    if (c.variant < 0 || c.ex < 0) continue;

    for (const row of tb.data) {
      const rModel = String(row[c.model] || '').trim();
      const rVariant = String(row[c.variant] || '').trim();
      if (norm(`${rModel} ${rVariant}`) !== want) continue;

      const ex = num(row[c.ex]);
      if (!ex) continue;

      const rows = [];
      for (const [stateName, keys] of Object.entries(STATE_KEYS)) {
        const oi = colIndex(tb.header, keys.onRoad);
        const ti = colIndex(tb.header, keys.tax);
        const onRoad = oi >= 0 ? num(row[oi]) : 0;
        if (!onRoad) continue;
        const stateTax = ti >= 0 ? num(row[ti]) : 0;
        // A tax cell outside every Indian slab means the column holds something
        // else; withhold that state rather than quote a figure off by lakhs.
        if (stateTax && _config.pricing && typeof _config.pricing.plausibleRoadTax === 'function'
            && !_config.pricing.plausibleRoadTax(ex, stateTax, String(row[c.fuel] || ''))) {
          continue;
        }
        rows.push({ state: stateName, onRoad: Math.round(onRoad), roadTax: Math.round(stateTax) });
      }
      if (!rows.length) continue;

      rows.sort((a, b) => a.onRoad - b.onRoad);
      const cheapest = rows[0].onRoad;
      rows.forEach(r => { r.extraOverCheapest = r.onRoad - cheapest; });
      return {
        rows,
        brand: String(row[c.make] || tblBrand).trim(),
        model: rModel,
        variant: rVariant,
        exShowroom: Math.round(ex),
        cheapest: rows[0].state,
        spread: rows[rows.length - 1].onRoad - cheapest
      };
    }
  }
  return { rows: [] };
}

router.post('/api/vehyra/state-prices', express.json(), async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const { brand, model, variant } = req.body || {};
    if (!model && !variant) return res.json({ ok: false, error: 'model/variant missing', rows: [] });
    const out = await statePrices({ brand, model, variant });
    if (!out.rows.length) return res.json({ ok: false, error: 'No state pricing for this variant', rows: [] });
    return res.json({ ok: true, ...out });
  } catch (e) {
    console.warn('statePrices failed', e.message);
    return res.json({ ok: false, error: String(e.message || e), rows: [] });
  }
});

module.exports = { init, router, search, statePrices };
