#!/usr/bin/env node
/**
 * Load the Mercedes dealer discounts into the price-override layer.
 *
 * The brand sheets are publish-to-web CSVs and cannot be written to, so the
 * discounts land as overrides that every quote path already consults.
 *
 * Discounts are kept as TIERS, not flattened to one number: Mercedes quotes a
 * different figure by year of manufacture (S 450 is 12.5L on YOM-25 stock but
 * 10L on YOM-26), so a single figure would promise the wrong benefit on the
 * wrong car. Prices are deliberately left null — this only adds the benefit.
 *
 *   node scripts/load_merc_discounts.cjs           # dry run, prints bindings
 *   node scripts/load_merc_discounts.cjs --apply   # writes price_overrides.json
 */
require('dotenv').config({ path: process.env.ENV_FILE || '.env.staging' });
const fs = require('fs');
const path = require('path');

const APPLY = process.argv.includes('--apply');
const L = 100000; // one lakh

// From the dealer sheet "July price list". yom25/yom26 are stock-year discounts.
// wp/as are held back deliberately — see NOTE at the bottom.
const PDF = [
  { m: 'C 200',                       sheet: 'C 200',                          ex: 61.2,   yom26: 3.00, wp: 1 },
  { m: 'C 220d',                      sheet: 'C 220D',                         ex: 61.2,   yom26: 1.00, wp: 1 },
  { m: 'C 300 AMG Line',              sheet: 'C 300 AMG Line',                 ex: 67,     wp: 1 },
  { m: 'E 200',                       sheet: 'E 200',                          ex: 81.5,   wp: 1, as: 2 },
  { m: 'E 220d',                      sheet: 'E220d',                          ex: 83.5,   wp: 1, as: 2 },
  { m: 'E 450 4MATIC AMG Line',       sheet: null,                             ex: 95.5,   wp: 1 },
  { m: 'S 350d',                      sheet: 'S 350 d',                        ex: 184.60, yom25: 12.50 },
  { m: 'S 450 4MATIC',                sheet: 'S 450 4 Matic',                  ex: 195.80, yom25: 12.50, yom26: 10.00 },
  { m: 'GLA 200',                     sheet: 'GLA 200',                        ex: 51.80,  yom26: 3.50, wp: 1 },
  { m: 'GLA 220d 4MATIC AMG Line',    sheet: 'GLA 220D 4 Matic AMG Line',      ex: 55.00,  yom26: 1.00, wp: 1 },
  { m: 'GLA 220d 4MATIC Progressive', sheet: 'GLA 220D 4 Matic',               ex: 53.00,  yom26: 1.00, wp: 1 },
  { m: 'GLC 300 4MATIC',              sheet: 'GLC 300 4 Matic',                ex: 77.00,  yom26: 3.50, wp: 1, as: 1 },
  { m: 'GLC 220d 4MATIC',             sheet: 'GLC 220d 4 Matic',               ex: 77.00,  yom26: 3.50, wp: 1, as: 1 },
  { m: 'GLE 300d 4MATIC AMG Line',    sheet: 'GLE 300d 4 Matic AMG line',      ex: 100,    yom26: 4.00, as: 1 },
  { m: 'GLE 450 4MATIC AMG Line',     sheet: 'GLE 450 4 Matic AMG Line',       ex: 111.5,  yom26: 6.00, as: 4 },
  { m: 'GLE 450d 4MATIC AMG Line',    sheet: 'GLE 450d 4 Matic AMG Line',      ex: 116.50, yom26: 6.00 },
  { m: 'GLS 450 4MATIC',              sheet: 'GLS 450 4 Matic Non AMG Line',   ex: 127.90 },
  { m: 'GLS 450d 4MATIC',             sheet: 'GLS 450d 4 Matic Non AMG Line',  ex: 133.50, yom25: 7.00 },
  { m: 'GLS 450 AMG 4MATIC',          sheet: 'GLS 450 4 Matic AMG Line',       ex: 137.5,  yom25: 7.00, yom26: 3.50, as: 3 },
  { m: 'GLS 450d AMG 4MATIC',         sheet: 'GLS 450d 4 Matic AMG Line',      ex: 139.7,  yom25: 7.00, yom26: 3.50, as: 1 },
  { m: 'AMG GLE 53 4MATIC Coupe',     sheet: 'AMG GLE 53 4MATIC Coup',         ex: 144.66, yom25: 3.00 },
  { m: 'EQS SUV 450 (Non Celeb.)',    sheet: 'EQS SUV 450 4 Matic',            ex: 133.50, yom25: 8.00, yom26: 4.00 },
  { m: 'EQS SUV 580 (Non Celeb.)',    sheet: 'EQS SUV 580 4 Matic',            ex: 147.50, yom25: 8.00, yom26: 4.00, as: 3 },
  { m: 'Maybach S 580',               sheet: 'Maybach S 580 4MATIC',           ex: 287.50, yom25: 10.00 },
  { m: 'Maybach EQS SUV 680',         sheet: 'Mercedes- Maybach EQS SUV 680',  ex: 240,    yom25: 5.00 },
];

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

(async () => {
  const pricing = require('../lib/pricing.cjs');
  pricing.init({ env: process.env, fetch, fs, path, DEBUG: false });
  const tb = (await pricing.loadPricingFromSheets()).MERCEDES;
  if (!tb) { console.error('No MERCEDES table'); process.exit(1); }

  const h = tb.header.map(c => String(c || '').replace(/\n/g, ' ').trim());
  const iMake = h.findIndex(c => /^MAKE$/i.test(c));
  const iM = h.findIndex(c => /^MODEL$/i.test(c));
  const iV = h.findIndex(c => /^VARIANT$/i.test(c));
  const iEx = h.findIndex(c => /Ex Showroom/i.test(c));
  const N = v => Number(String(v ?? '').replace(/[^\d.-]/g, '')) || 0;

  const rows = tb.data.filter(r => N(r[iEx]) > 0).map(r => ({
    make: String(r[iMake] || 'Mercedes').trim(),
    model: String(r[iM] || '').trim(),
    variant: String(r[iV] || '').trim(),
    ex: N(r[iEx])
  }));

  const bound = [], unbound = [];
  for (const p of PDF) {
    if (!p.sheet) { unbound.push({ ...p, why: 'not present in the sheet' }); continue; }
    // Exact, explicit binding. Fuzzy scoring put E 450 on a GLE and GLS 450d on
    // the AMG row, so every row is named outright and an ambiguous name is an error.
    const want = norm(p.sheet);
    let hits = rows.filter(r => norm(r.variant) === want);
    if (!hits.length) hits = rows.filter(r => norm(r.variant).startsWith(want));
    if (!hits.length) { unbound.push({ ...p, why: 'no sheet row matched' }); continue; }
    if (hits.length > 1) {
      const near = hits.filter(r => Math.abs(r.ex - p.ex * L) / (p.ex * L) < 0.08);
      if (near.length === 1) hits = near;
      else { unbound.push({ ...p, why: `ambiguous — ${hits.length} sheet rows` }); continue; }
    }
    const r = hits[0];
    const tiers = [];
    if (p.yom25) tiers.push({ label: 'On 2025-manufactured stock', amount: p.yom25 * L });
    if (p.yom26) tiers.push({ label: 'On 2026-manufactured stock', amount: p.yom26 * L });
    bound.push({ pdf: p, row: r, tiers, held: { wp: p.wp || null, as: p.as || null } });
  }

  console.log('=== BINDINGS (PDF row → sheet row) ===');
  for (const b of bound) {
    const gap = b.row.ex - b.pdf.ex * L;
    console.log(
      `${b.pdf.m.padEnd(30)} → ${`${b.row.model} | ${b.row.variant}`.slice(0, 42).padEnd(43)} ` +
      `sheetEx=${String(b.row.ex).padStart(9)} pdfEx=${String(Math.round(b.pdf.ex * L)).padStart(9)} ` +
      `${gap === 0 ? 'exact' : (gap > 0 ? '+' : '') + gap}`
    );
    console.log(`${' '.repeat(32)}tiers: ${b.tiers.map(t => `${t.label} ${t.amount}`).join(' | ') || '(none)'}` +
      (b.held.wp || b.held.as ? `   [held: WP=${b.held.wp || '-'} AS=${b.held.as || '-'}]` : ''));
  }
  if (unbound.length) {
    console.log('\n=== UNBOUND (no sheet row found) ===');
    unbound.forEach(p => console.log(`   ${p.m.padEnd(30)} (pdfEx ${Math.round(p.ex * L)}) — ${p.why}`));
  }

  const withTiers = bound.filter(b => b.tiers.length);
  console.log(`\nbound=${bound.length} unbound=${unbound.length} withDiscountTiers=${withTiers.length}`);

  if (!APPLY) { console.log('\nDRY RUN — rerun with --apply to write.'); process.exit(0); }

  const DATA_DIR = process.env.INVENTORY_DATA_DIR || path.join(__dirname, '..', 'data');
  const FILE = path.join(DATA_DIR, 'price_overrides.json');
  let store = { overrides: [], history: [] };
  if (fs.existsSync(FILE)) store = { overrides: [], history: [], ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };

  const now = new Date().toISOString();
  let applied = 0;
  for (const b of withTiers) {
    const key = norm(`${b.row.make} ${b.row.model} ${b.row.variant}`);
    const entry = {
      key,
      brand: b.row.make, model: b.row.model, variant: b.row.variant,
      exShowroom: null, onRoad: null,      // price untouched — benefit only
      discount: null,
      discountTiers: b.tiers,
      discountVariable: false,
      source: 'Mercedes dealer price list (July) — loaded 2026-08-17',
      updatedAt: now
    };
    const idx = store.overrides.findIndex(o => o.key === key);
    if (idx >= 0) store.overrides[idx] = entry; else store.overrides.push(entry);
    applied++;
  }
  store.history.push({ at: now, from: 'load_merc_discounts', brand: 'MERCEDES', applied });
  fs.writeFileSync(FILE, JSON.stringify(store, null, 2), 'utf8');
  console.log(`\n✅ wrote ${applied} Mercedes discount overrides → ${FILE}`);
})();

// NOTE: the WP and AS columns are read but NOT published to customers. Their
// meaning is not stated anywhere on the dealer sheet, and a mislabelled benefit
// in a quote is worse than an omitted one. Confirm what they stand for and they
// become two more tiers.
