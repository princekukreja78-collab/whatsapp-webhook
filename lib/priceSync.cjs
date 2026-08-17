// lib/priceSync.cjs — forward a dealer price list on WhatsApp → AI reads every row →
// diff against the live Google Sheet → admin confirms → corrections stored as an
// override layer the quote engine applies on top of the sheet.
//
// Why an override layer instead of writing the sheet directly: the brand pricing
// sheets are published-to-web CSVs (no document ID / edit scope), so writes aren't
// possible today. Overrides take effect immediately, are reversible, and carry an
// audit trail. If a writable mapping is configured via PRICE_SHEET_MAP
// ({"toyota":{"spreadsheetId":"...","tab":"Sheet1"}}), the same corrections are
// also pushed into the sheet on apply.
'use strict';

const fs = require('fs');
const path = require('path');

let _config = {};

const DATA_DIR = process.env.INVENTORY_DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'price_overrides.json');

// phone → { rows, diff, createdAt }
const pending = new Map();

let store = { overrides: [], history: [] };

// Corrections worked out from dealer price lists ship in the repo. On Render the
// live store sits on the persistent disk, outside the repo, so without this seed
// those corrections would never leave the laptop.
const SEED_FILE = path.join(__dirname, '..', 'data', 'price_overrides.seed.json');

/**
 * Merge the shipped seed into the live store.
 * A seeded row is refreshed when the seed version moves on; a row someone
 * entered by forwarding a price list on WhatsApp is never overwritten.
 */
function _mergeSeed() {
  let seed;
  try {
    if (!fs.existsSync(SEED_FILE)) return 0;
    seed = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
  } catch (e) { console.warn('PriceSync: seed unreadable', e.message); return 0; }
  const version = String(seed.version || '');
  let added = 0, refreshed = 0;
  for (const entry of seed.overrides || []) {
    if (!entry || !entry.key) continue;
    const idx = store.overrides.findIndex(o => o.key === entry.key);
    if (idx < 0) {
      store.overrides.push({ ...entry, seed: true, seedVersion: version });
      added++;
    } else if (store.overrides[idx].seed && store.overrides[idx].seedVersion !== version) {
      store.overrides[idx] = { ...entry, seed: true, seedVersion: version };
      refreshed++;
    }
  }
  if (added || refreshed) {
    _save();
    console.log(`PriceSync: seed ${version} → ${added} added, ${refreshed} refreshed`);
  }
  return added + refreshed;
}

function init(config) {
  _config = config || {};
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(FILE)) store = { overrides: [], history: [], ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };
  } catch (e) { console.warn('PriceSync: load failed', e.message); }
  try { _mergeSeed(); } catch (e) { console.warn('PriceSync: seed merge failed', e.message); }
  console.log(`PriceSync: ${store.overrides.length} price overrides active`);
}

function _save() {
  try { fs.writeFileSync(FILE, JSON.stringify(store, null, 2), 'utf8'); }
  catch (e) { console.warn('PriceSync: save failed', e.message); }
}

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const num = v => Number(String(v ?? '').replace(/[^\d.]/g, '')) || 0;

function fmt(n) {
  const v = Number(n) || 0;
  if (v >= 1e7) return `₹${(v / 1e7).toFixed(2).replace(/\.?0+$/, '')} Cr`;
  if (v >= 1e5) return `₹${(v / 1e5).toFixed(2).replace(/\.?0+$/, '')} L`;
  return `₹${v.toLocaleString('en-IN')}`;
}

// ---------------- 1. Read the forwarded list ----------------
/**
 * Vision pass tuned for MULTI-ROW price lists (a model's variant table).
 * Returns { brand, model, rows: [{variant, exShowroom, onRoad, discount}] } or null.
 */
async function extractPriceList(imageUrls) {
  if (!_config.openai || !imageUrls?.length) return null;
  try {
    const resp = await _config.openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You read Indian car dealer PRICE LISTS (tables listing several variants of a model with prices). Return ONLY JSON:
{"brand":"","model":"","rows":[{"variant":"","exShowroom":"","onRoad":"","discount":""}]}
- one row per variant line in the table
- amounts as plain digits only (no commas, no ₹). Leave a field "" if that column is absent.
- discount: only if the list explicitly states a discount/benefit/offer amount for that variant; otherwise "".
If the image is not a multi-variant price list, return null.`
        },
        { role: 'user', content: imageUrls.slice(0, 4).map(url => ({ type: 'image_url', image_url: { url } })) }
      ],
      temperature: 0,
      max_tokens: 1200
    });
    const content = resp.choices?.[0]?.message?.content || '';
    const m = content.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]);
    const rows = (parsed.rows || []).filter(r => r && (num(r.exShowroom) || num(r.onRoad)));
    if (rows.length < 2) return null; // single-car sheets are handled by the deal flow
    return { brand: parsed.brand || '', model: parsed.model || '', rows };
  } catch (e) {
    console.warn('PriceSync: extraction failed', e.message);
    return null;
  }
}

// ---------------- 2. Diff against the live sheet ----------------
async function _sheetRowsFor(brand) {
  const key = `SHEET_${String(brand || '').toUpperCase().replace(/[^A-Z]/g, '')}_CSV_URL`;
  const url = (process.env[key] || '').replace(/^"|"$/g, '').trim();
  if (!url || typeof _config.fetchCsv !== 'function') return null;
  try {
    const csv = await _config.fetchCsv(url);
    const rows = typeof _config.parseCsv === 'function' ? _config.parseCsv(csv) : null;
    return Array.isArray(rows) && rows.length ? rows : null;
  } catch (e) {
    console.warn('PriceSync: sheet read failed for', brand, e.message);
    return null;
  }
}

function _findCol(header, ...needles) {
  return header.findIndex(h => {
    const t = String(h || '').toUpperCase();
    return needles.some(n => t.includes(n));
  });
}

/**
 * Compare extracted rows against the sheet. Returns a per-row verdict:
 * 'new' (not in sheet), 'changed' (price differs), 'same'.
 */
async function diffAgainstSheet(list) {
  const sheet = await _sheetRowsFor(list.brand);
  const out = [];
  if (!sheet) {
    for (const r of list.rows) out.push({ ...r, verdict: 'unknown', sheetEx: 0, sheetOnRoad: 0 });
    return { out, sheetAvailable: false };
  }
  const header = sheet[0].map(h => String(h || ''));
  const vIdx = _findCol(header, 'VARIANT', 'SUB MODEL', 'MODEL');
  const exIdx = _findCol(header, 'EX-SHOWROOM', 'EX SHOWROOM', 'EXSHOWROOM');
  const orIdx = _findCol(header, 'ON ROAD', 'ON-ROAD', 'ONROAD');

  for (const r of list.rows) {
    const target = norm(`${list.model} ${r.variant}`);
    let match = null;
    for (const row of sheet.slice(1)) {
      const cand = norm(`${row[vIdx] || ''}`);
      if (!cand) continue;
      if (target.includes(cand) || cand.includes(norm(r.variant)) && norm(r.variant).length > 2) { match = row; break; }
    }
    const sheetEx = match && exIdx >= 0 ? num(match[exIdx]) : 0;
    const sheetOnRoad = match && orIdx >= 0 ? num(match[orIdx]) : 0;
    const newEx = num(r.exShowroom);
    const newOnRoad = num(r.onRoad);
    let verdict = 'same';
    if (!match) verdict = 'new';
    else if ((newEx && sheetEx && newEx !== sheetEx) || (newOnRoad && sheetOnRoad && newOnRoad !== sheetOnRoad)) verdict = 'changed';
    out.push({ ...r, verdict, sheetEx, sheetOnRoad });
  }
  return { out, sheetAvailable: true };
}

// ---------------- 3. Confirm flow ----------------
function summaryText(list, diff, sheetAvailable) {
  const lines = [];
  lines.push(`📋 *Price list read — ${[list.brand, list.model].filter(Boolean).join(' ') || 'unknown model'}*`);
  lines.push(`${diff.length} variant(s) found${sheetAvailable ? '' : ' _(sheet not readable — all will be stored as overrides)_'}`);
  lines.push('');
  for (const r of diff.slice(0, 12)) {
    const price = num(r.onRoad) || num(r.exShowroom);
    const tag = r.verdict === 'new' ? '🆕 NEW' : r.verdict === 'changed' ? '✏️ CHANGED' : r.verdict === 'same' ? '✅ same' : '•';
    let line = `${tag} ${r.variant || '—'}: ${fmt(price)}`;
    if (r.verdict === 'changed') {
      const old = num(r.onRoad) ? r.sheetOnRoad : r.sheetEx;
      if (old) line += `  _(was ${fmt(old)})_`;
    }
    line += num(r.discount) ? `  🎁 ${fmt(num(r.discount))} off` : `  🎁 discount: *variable*`;
    lines.push(line);
  }
  if (diff.length > 12) lines.push(`_…and ${diff.length - 12} more_`);
  lines.push('');
  lines.push('_Variants without a stated discount are marked *variable* — the bot will tell customers the discount is negotiable instead of quoting zero._');
  return lines.join('\n');
}

async function handlePriceList(from, imageUrls) {
  const list = await extractPriceList(imageUrls);
  if (!list) return false;

  const { out, sheetAvailable } = await diffAgainstSheet(list);
  pending.set(from, { list, diff: out, createdAt: Date.now() });

  await _config.waSendText(from, summaryText(list, out, sheetAvailable));
  await _config.waSendRaw({
    messaging_product: 'whatsapp', to: from, type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: 'Apply these prices? They take effect immediately for all quotes.' },
      footer: { text: 'VehYra by MR. CAR' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'PRICE_APPLY', title: '✅ Apply prices' } },
          { type: 'reply', reply: { id: 'PRICE_CANCEL', title: '✖️ Cancel' } }
        ]
      }
    }
  });
  return true;
}

function hasPending(from) { return pending.has(from); }

async function handleButton(from, selectedId) {
  if (selectedId !== 'PRICE_APPLY' && selectedId !== 'PRICE_CANCEL') return false;
  const p = pending.get(from);
  pending.delete(from);
  if (!p) {
    await _config.waSendText(from, 'That price list has expired — please forward it again.');
    return true;
  }
  if (selectedId === 'PRICE_CANCEL') {
    await _config.waSendText(from, '✖️ Cancelled — nothing changed.');
    return true;
  }

  const now = new Date().toISOString();
  let applied = 0;
  for (const r of p.diff) {
    if (r.verdict === 'same') continue;
    const key = norm(`${p.list.brand} ${p.list.model} ${r.variant}`);
    const entry = {
      key,
      brand: p.list.brand, model: p.list.model, variant: r.variant,
      exShowroom: num(r.exShowroom) || null,
      onRoad: num(r.onRoad) || null,
      // No stated discount → variable, so the bot invites a negotiation
      discount: num(r.discount) || null,
      discountVariable: !num(r.discount),
      source: `whatsapp price list from ${from}`,
      updatedAt: now
    };
    const idx = store.overrides.findIndex(o => o.key === key);
    if (idx >= 0) store.overrides[idx] = entry; else store.overrides.push(entry);
    applied++;
  }
  store.history.push({ at: now, from, brand: p.list.brand, model: p.list.model, applied });
  if (store.history.length > 200) store.history = store.history.slice(-200);
  _save();

  await _config.waSendText(from,
    `✅ *${applied} price(s) applied* for ${[p.list.brand, p.list.model].filter(Boolean).join(' ')}.\n\n` +
    `These now override the sheet in every quote. Variants without a stated discount will be quoted as *discount negotiable*.\n\n` +
    `_Send *PRICES* anytime to see all active overrides._`
  );
  return true;
}

// ---------------- 4. Used by the quote engine ----------------
/**
 * Look up an override for a model/variant. Returns null when none applies.
 */
function lookup(brand, model, variant) {
  const target = norm(`${brand} ${model} ${variant}`);
  if (!target) return null;
  const tv = norm(variant);
  const tm = norm(`${brand} ${model}`);
  let best = null;
  for (const o of store.overrides) {
    if (!o.key) continue;
    const ov = norm(o.variant || '');
    if (ov && tv) {
      // Both sides name a variant, so the variant must match outright. Loose
      // containment let "S11" and even "S" pick up the override written for
      // "S11 E" — one Scorpio Classic correction leaked onto three other trims.
      if (ov !== tv) continue;
      const om = norm(`${o.brand || ''} ${o.model || ''}`);
      if (om && tm && !(om.includes(tm) || tm.includes(om))) continue;
    } else if (!(target === o.key || target.includes(o.key) || o.key.includes(target))) {
      continue;
    }
    if (!best || o.key.length > best.key.length) best = o;
  }
  return best;
}

// The discount line is ALWAYS shown, even with nothing stated — the column stays
// on the quote. Manufacturer schemes change month to month (and are eligibility
// gated), so the standing wording promises the conversation, not a number.
const DISCOUNT_VARIES =
  `🎁 *Discount & schemes:* manufacturer schemes vary periodically — ` +
  `your exact benefit is confirmed upon finalisation. Tell us your budget and we'll get you the best possible price.`;

/**
 * Customer-facing discount line.
 *
 * Tiered discounts (Mercedes quotes a different figure by year of manufacture,
 * plus separate add-ons) are shown with their condition spelled out — flattening
 * them to one number would promise a YOM-25 discount on YOM-26 stock. Anything
 * we cannot state firmly reads as negotiable on finalisation rather than zero.
 */
function discountLine(o) {
  if (!o) return DISCOUNT_VARIES;
  if (Array.isArray(o.discountTiers) && o.discountTiers.length) {
    const parts = o.discountTiers
      .filter(t => t && t.amount > 0)
      .map(t => `   • ${t.label}: ${fmt(t.amount)}`);
    if (parts.length) {
      return [`🎁 *Benefits available* (subject to stock):`, ...parts,
        `   _Final benefit confirmed on finalisation._`].join('\n');
    }
  }
  if (o.discount) return `🎁 Discount available: ${fmt(o.discount)}`;
  return DISCOUNT_VARIES;
}

function listOverrides() {
  if (!store.overrides.length) return 'No price overrides active — forward a price list to add some.';
  const lines = ['💾 *Active price overrides*', ''];
  for (const o of store.overrides.slice(-20)) {
    lines.push(`• ${[o.brand, o.model, o.variant].filter(Boolean).join(' ')} — ${fmt(o.onRoad || o.exShowroom)}${o.discount ? ` · ${fmt(o.discount)} off` : ' · discount negotiable'}`);
  }
  if (store.overrides.length > 20) lines.push(`_…${store.overrides.length - 20} more_`);
  return lines.join('\n');
}

module.exports = {
  init, handlePriceList, handleButton, hasPending,
  lookup, discountLine, listOverrides, extractPriceList
};
