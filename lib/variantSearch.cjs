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
    ins: colIndex(header, ['INSURANCE (', 'INSURANCE']),
  };
}

/**
 * Search every brand pricing sheet for variants matching the query.
 */
async function search({ query, city = 'Delhi', limit = 14 }) {
  const q = norm(query);
  if (!q || typeof _config.loadPricingFromSheets !== 'function') return { cars: [], state: pickState(city) };

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
      const model = String(row[c.model] || '').trim();
      const variant = String(row[c.variant] || '').trim();
      if (!model && !variant) continue;

      const hay = norm(`${make} ${model} ${variant} ${c.keywords >= 0 ? row[c.keywords] || '' : ''}`);
      if (!hay.includes(q)) continue;

      const ex = num(row[c.ex]);
      if (!ex) continue;
      const special = c.special >= 0 ? num(row[c.special]) : 0;
      // The "customer benefit" column means different things per brand sheet — only
      // trust it when it reads like a net ex-showroom figure, else derive it
      const benefitVal = c.benefit >= 0 ? num(row[c.benefit]) : 0;
      const netEx = benefitVal > ex * 0.5 ? benefitVal : ex - special;

      let onRoad = onRoadIdx >= 0 ? num(row[onRoadIdx]) : 0;
      if (!onRoad) {
        // Sheet leaves the formula cell blank on export — rebuild it
        onRoad = netEx
          + (c.tcs >= 0 ? num(row[c.tcs]) : 0)
          + (c.cess >= 0 ? num(row[c.cess]) : 0)
          + (taxIdx >= 0 ? num(row[taxIdx]) : 0)
          + (c.ins >= 0 ? num(row[c.ins]) : 0);
      }
      if (!onRoad) continue;

      // A price correction forwarded on WhatsApp wins over the sheet
      let overridden = false, discountNote = null;
      if (_config.priceSync) {
        const o = _config.priceSync.lookup(make || brand, model, variant);
        if (o) {
          if (o.onRoad) { onRoad = o.onRoad; overridden = true; }
          else if (o.exShowroom) { onRoad = onRoad - ex + o.exShowroom; overridden = true; }
          discountNote = _config.priceSync.discountLine(o);
        }
      }

      const emi = typeof _config.calcEmiSimple === 'function'
        ? _config.calcEmiSimple(Math.round(onRoad * 0.9), 8.1, 60)
        : 0;

      const roadTax = taxIdx >= 0 ? num(row[taxIdx]) : 0;
      const insurance = c.ins >= 0 ? num(row[c.ins]) : 0;
      const tcs = c.tcs >= 0 ? num(row[c.tcs]) : 0;
      const cess = c.cess >= 0 ? num(row[c.cess]) : 0;

      out.push({
        id: `${brand}-${out.length}`,
        // Itemised on-road build-up the website expands under each variant
        breakup: {
          exShowroom: Math.round(ex),
          discount: special || 0,
          netExShowroom: Math.round(netEx),
          tcs, greenCess: cess, roadTax, insurance,
          onRoad: Math.round(onRoad),
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
        discountNote,
        state
      });
      if (out.length >= limit) break;
    }
    if (out.length >= limit) break;
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
    const { cars, state } = await search({ query, city });
    res.json({ ok: true, cars: [...stock, ...cars], state, source: 'sheets' });
  } catch (e) {
    console.warn('variantSearch failed', e.message);
    res.json({ ok: false, error: String(e.message || e), cars: [] });
  }
});

module.exports = { init, router, search };
