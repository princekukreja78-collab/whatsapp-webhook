#!/usr/bin/env node
/**
 * Refresh ex-showroom prices from the current dealer price lists.
 *
 * The brand sheets are publish-to-web CSVs and cannot be written to, so the
 * corrections land in the price-override layer. Both the bot (quotes.cjs) and
 * the site (variantSearch.cjs) shift the on-road by the ex-showroom delta, so
 * one override fixes price, on-road and EMI together.
 *
 * Matching is deliberately strict. A sheet variant like "AX7L" can correspond to
 * several dealer rows (MT/AT, 2WD/AWD, 6/7 seat) that differ by lakhs, so a row
 * is only applied when (model, variant, fuel) resolves to EXACTLY ONE dealer
 * row. Anything ambiguous is reported and skipped rather than guessed.
 *
 *   node scripts/refresh_ex_showroom.cjs           # dry run
 *   node scripts/refresh_ex_showroom.cjs --apply
 */
require('dotenv').config({ path: process.env.ENV_FILE || '.env.staging' });
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const APPLY = process.argv.includes('--apply');
const DL = path.join(os.homedir(), 'Downloads');
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const N = v => Number(String(v ?? '').replace(/[^\d.-]/g, '')) || 0;

// Scorpio-N was repriced on 06 Aug'26; the July file for the same model is stale
// and must never win. Any file whose product is superseded is dropped outright.
const SUPERSEDED = [/SCORPIO-N-\s*Diesel\s*-\s*Price List -Jul/i, /SCORPIO-?N.*Jul'26/i];
const isSuperseded = f => /scorpio/i.test(f) && /jul/i.test(f) && !/classic/i.test(f);

function mahindraRows() {
  const files = fs.readdirSync(DL).filter(f => /\.pdf$/i.test(f) && /Price/i.test(f) && !/MG KAROL/i.test(f) && !/Brochure/i.test(f));
  const rows = [];
  for (const f of files) {
    if (isSuperseded(f)) { console.log(`  (skipping superseded: ${f})`); continue; }
    let txt = '';
    try { txt = execFileSync('pdftotext', ['-layout', path.join(DL, f), '-'], { encoding: 'utf8', maxBuffer: 1e8 }); }
    catch (e) { continue; }
    const pm = txt.match(/Product\s*\n?\s*Name\s*Name?\s+([A-Z0-9 \-&']+?)\s{2,}/i) || txt.match(/Product Name\s+([A-Z0-9 \-&']+?)\s{2,}/i);
    const product = pm ? pm[1].trim() : '';
    for (const raw of txt.split('\n')) {
      const line = raw.replace(/\s+/g, ' ').trim();
      const amts = line.match(/₹?\s?\b\d{1,2},\d{2},\d{3}\b|\b\d{6,8}\b/g);
      if (!amts || amts.length < 4) continue;
      const head = line.slice(0, line.search(/₹|\b\d{1,2},\d{2},\d{3}\b|\b\d{6,8}\b/)).trim();
      if (!head) continue;
      const ex = N(amts[0]);
      if (ex < 300000 || ex > 9000000) continue;
      const fuel = /diesel/i.test(head) || /diesel/i.test(f) ? 'DIESEL'
        : /petrol/i.test(head) || /petrol/i.test(f) ? 'PETROL'
        : /electric|ev\b/i.test(head) || /\bEV\b/i.test(f) ? 'ELECTRIC' : '';
      // trim = the head with fuel/transmission/drive/seat tokens stripped
      const trim = head.replace(/\b(PETROL|DIESEL|ELECTRIC|MT|AT|AMT|CVT|2WD|4WD|AWD|\d)\b/gi, ' ').replace(/\s+/g, ' ').trim();
      rows.push({ file: f, product, head, trim, fuel, ex });
    }
  }
  return rows;
}

(async () => {
  const pricing = require('../lib/pricing.cjs');
  pricing.init({ env: process.env, fetch, fs, path, DEBUG: false });
  const tables = await pricing.loadPricingFromSheets();

  console.log('\n--- reading dealer PDFs ---');
  const pdf = mahindraRows();
  console.log(`dealer rows parsed: ${pdf.length}\n`);

  const tb = tables.MAHINDRA;
  const h = tb.header.map(c => String(c || '').replace(/\n/g, ' ').trim());
  const iMake = h.findIndex(c => /^MAKE$/i.test(c));
  const iM = h.findIndex(c => /^MODEL$/i.test(c));
  const iV = h.findIndex(c => /^VARIANT$/i.test(c));
  const iF = h.findIndex(c => /FUEL/i.test(c));
  const iEx = h.findIndex(c => /Ex Showroom/i.test(c));

  // The sheet carries no transmission/drive column, so a variant name repeated at
  // two prices is really MT vs AT (or 2WD vs AWD). Nothing in the row says which,
  // so those rows cannot be matched to a dealer price without guessing — and
  // guessing here mapped an MT row to an AT price, a 1.9 lakh error. Skip them.
  const sheetKeyCount = new Map();
  // lookup() has no fuel dimension either, so an override written for the diesel
  // MX2 PRO also answers for the petrol MX2 PRO. Only variant names unique across
  // fuels can be corrected safely until lookup() is keyed by fuel.
  const nameFuels = new Map();
  for (const r of tb.data) {
    if (!N(r[iEx])) continue;
    const k = norm(`${r[iM]} ${r[iV]} ${r[iF]}`);
    sheetKeyCount.set(k, (sheetKeyCount.get(k) || 0) + 1);
    const nk = norm(`${r[iM]} ${r[iV]}`);
    if (!nameFuels.has(nk)) nameFuels.set(nk, new Set());
    nameFuels.get(nk).add(String(r[iF] || '').toUpperCase().trim());
  }

  const apply = [], ambiguous = [], nomatch = [], same = [], dupSheet = [], multiFuel = [];
  for (const r of tb.data) {
    const ex = N(r[iEx]); if (!ex) continue;
    if (sheetKeyCount.get(norm(`${r[iM]} ${r[iV]} ${r[iF]}`)) > 1) {
      dupSheet.push({ model: String(r[iM] || ''), variant: String(r[iV] || ''), fuel: String(r[iF] || ''), ex });
      continue;
    }
    const make = String(r[iMake] || 'Mahindra').trim();
    const model = String(r[iM] || '').trim();
    const variant = String(r[iV] || '').trim();
    const fuel = String(r[iF] || '').toUpperCase().trim();
    if (!variant) continue;
    if ((nameFuels.get(norm(`${model} ${variant}`)) || new Set()).size > 1) {
      multiFuel.push({ model, variant, fuel, ex });
      continue;
    }

    const mk = norm(model), vk = norm(variant);
    let cands = pdf.filter(p => {
      const pk = norm(p.product), tk = norm(p.trim);
      const modelOk = pk && mk && (pk.includes(mk) || mk.includes(pk));
      if (!modelOk) return false;
      return tk === vk;                      // exact trim equality only
    });
    if (fuel) {
      const want = fuel.includes('DIESEL') ? 'DIESEL' : fuel.includes('PETROL') ? 'PETROL' : fuel.includes('ELECTRIC') ? 'ELECTRIC' : '';
      // Fuel must match. Falling back to the unfiltered list when nothing matches
      // put a PETROL Thar Roxx price on the DIESEL row — a no-match is the
      // correct answer here, not a looser one.
      if (want) cands = cands.filter(p => p.fuel === want);
    }
    const uniqEx = [...new Set(cands.map(c => c.ex))];
    if (!cands.length) { nomatch.push({ model, variant, fuel, ex }); continue; }
    if (uniqEx.length > 1) { ambiguous.push({ model, variant, fuel, ex, options: uniqEx.sort((a, b) => a - b) }); continue; }
    const pdfEx = uniqEx[0];
    if (pdfEx === ex) { same.push({ model, variant }); continue; }
    apply.push({ make, model, variant, fuel, oldEx: ex, newEx: pdfEx, delta: pdfEx - ex, src: cands[0].file });
  }

  console.log(`already correct : ${same.length}`);
  console.log(`TO UPDATE       : ${apply.length}`);
  console.log(`ambiguous(skip) : ${ambiguous.length}`);
  console.log(`no dealer row   : ${nomatch.length}`);
  console.log(`multi-fuel name : ${multiFuel.length}  (same name in petrol+diesel — one override key)`);
  console.log(`dup sheet name  : ${dupSheet.length}  (same variant twice = hidden MT/AT — cannot match)\n`);

  // The override key is brand+model+variant with no fuel dimension, so a petrol
  // and a diesel row of the same name collide and the last write wins — which put
  // the diesel Scorpio N Z2 price on the petrol one. Drop such pairs entirely
  // until lookup() can be keyed by fuel.
  const byKey = new Map();
  for (const x of apply) {
    const k = norm(`${x.make} ${x.model} ${x.variant}`);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(x);
  }
  const collided = [];
  for (const [k, list] of byKey) {
    if (list.length > 1 && new Set(list.map(v => v.newEx)).size > 1) collided.push(...list);
  }
  if (collided.length) {
    const drop = new Set(collided);
    for (let i = apply.length - 1; i >= 0; i--) if (drop.has(apply[i])) apply.splice(i, 1);
    console.log(`\n⚠️  dropped ${collided.length} row(s) — same name, different fuel, one override key:`);
    collided.forEach(x => console.log(`   ${x.model} ${x.variant} (${x.fuel}) would have written ${x.newEx}`));
    console.log('');
  }

  console.log('MODEL        VARIANT              FUEL      oldEx     newEx     delta');
  apply.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).forEach(x => console.log(
    `${x.model.slice(0, 12).padEnd(13)}${x.variant.slice(0, 20).padEnd(21)}${x.fuel.slice(0, 8).padEnd(10)}${String(x.oldEx).padStart(8)} ${String(x.newEx).padStart(9)} ${(x.delta > 0 ? '+' : '') + x.delta}`));

  if (ambiguous.length) {
    console.log('\n--- ambiguous, left alone (one sheet row, several dealer rows) ---');
    ambiguous.slice(0, 12).forEach(x => console.log(`   ${x.model} ${x.variant} (${x.fuel}) sheet=${x.ex} dealer options: ${x.options.join(' / ')}`));
    if (ambiguous.length > 12) console.log(`   …${ambiguous.length - 12} more`);
  }

  if (!APPLY) { console.log('\nDRY RUN — rerun with --apply to write.'); process.exit(0); }

  const DATA_DIR = process.env.INVENTORY_DATA_DIR || path.join(__dirname, '..', 'data');
  const FILE = path.join(DATA_DIR, 'price_overrides.json');
  let store = { overrides: [], history: [] };
  if (fs.existsSync(FILE)) store = { overrides: [], history: [], ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };

  const now = new Date().toISOString();
  for (const x of apply) {
    const key = norm(`${x.make} ${x.model} ${x.variant}`);
    const idx = store.overrides.findIndex(o => o.key === key);
    const prev = idx >= 0 ? store.overrides[idx] : {};
    const entry = {
      ...prev,
      key, brand: x.make, model: x.model, variant: x.variant,
      exShowroom: x.newEx,
      onRoad: prev.onRoad || null,
      source: `dealer price list ${x.src}`,
      updatedAt: now
    };
    if (idx >= 0) store.overrides[idx] = entry; else store.overrides.push(entry);
  }
  store.history.push({ at: now, from: 'refresh_ex_showroom', brand: 'MAHINDRA', applied: apply.length });
  fs.writeFileSync(FILE, JSON.stringify(store, null, 2), 'utf8');
  console.log(`\n✅ wrote ${apply.length} ex-showroom overrides → ${FILE}`);
})();
