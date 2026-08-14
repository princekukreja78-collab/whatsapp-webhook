// lib/variantDetail.cjs — everything a buyer wants after picking a variant:
// specs, features, the colours it comes in, the benefits on offer, and every
// financier's EMI plan (normal / bullet / Flex Pay balloon) on that exact price.
// Specs & features are AI-filled once per variant and cached on disk.
'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');

let _config = {};

const DATA_DIR = process.env.INVENTORY_DATA_DIR || path.join(__dirname, '..', 'data');
const CACHE_FILE = path.join(DATA_DIR, 'variant_specs.json');
let cache = {};

function init(config) {
  _config = config || {};
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(CACHE_FILE)) cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) || {};
  } catch (e) { cache = {}; }
  console.log(`VariantDetail: ${Object.keys(cache).length} cached variant spec sets`);
}

function _saveCache() {
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(cache), 'utf8'); } catch (e) {}
}

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const num = v => Number(String(v ?? '').replace(/[^\d.]/g, '')) || 0;

// ---------------- colours offered, straight from the price sheet ----------------
async function coloursFor(brand, model) {
  try {
    const tables = await _config.loadPricingFromSheets();
    const wantedModel = norm(model);
    const seen = new Set();
    for (const tb of Object.values(tables || {})) {
      if (!tb || !Array.isArray(tb.data)) continue;
      const H = tb.header.map(h => String(h || '').toUpperCase());
      const mi = H.findIndex(h => h.includes('MODEL'));
      const ci = H.findIndex(h => h.includes('COLOUR') || h.includes('COLOR'));
      if (mi < 0 || ci < 0) continue;
      for (const row of tb.data) {
        if (norm(row[mi]) !== wantedModel) continue;
        const col = String(row[ci] || '').trim();
        if (col && !/^any colour$/i.test(col)) seen.add(col);
      }
    }
    return [...seen].slice(0, 12);
  } catch (e) { return []; }
}

// ---------------- specs + features (AI, cached) ----------------
async function specsFor(brand, model, variant) {
  const key = norm(`${brand} ${model} ${variant}`);
  if (cache[key]) return cache[key];
  if (!_config.openai) return { specs: [], features: [] };

  const desc = [brand, model, variant].filter(Boolean).join(' ');
  try {
    const resp = await _config.openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are an Indian automotive database. The input is DEALER SHORTHAND — first resolve it to the official India-market model, then answer for that car only (e.g. "TOYOTA HYCROSS" is the Toyota Innova Hycross, a 2.0L petrol/hybrid MPV — never a Maruti-derived model; "TOYOTA GLANZA" is the Baleno-derived hatchback). Return ONLY JSON:
{"resolvedName":"","specs":[{"group":"","label":"","value":""}],"features":[""]}
- resolvedName: the full official model name you answered for.
- specs groups in this order: Engine (Engine, Displacement in cc, Power, Torque, Transmission), Performance (Mileage ARAI), Dimensions (Length, Width, Boot Space, Ground Clearance, Fuel Tank), Safety (Airbags, key safety kit).
- features: 8-14 headline comfort/tech features of THIS variant.
- India-spec values only. Omit any row you are unsure of rather than inventing it.`
        },
        { role: 'user', content: desc }
      ],
      temperature: 0,
      max_tokens: 900
    });
    const m = (resp.choices?.[0]?.message?.content || '').match(/\{[\s\S]*\}/);
    if (!m) return { specs: [], features: [] };
    const parsed = JSON.parse(m[0]);
    const out = {
      resolvedName: String(parsed.resolvedName || ''),
      specs: (parsed.specs || []).filter(s => s && s.label && s.value)
        .map(s => ({ group: String(s.group || ''), label: String(s.label), value: String(s.value) })),
      features: (parsed.features || []).filter(Boolean).map(String)
    };
    cache[key] = out;
    _saveCache();
    return out;
  } catch (e) {
    console.warn('VariantDetail: spec fill failed', e.message);
    return { specs: [], features: [] };
  }
}

// ---------------- EMI plans from every financier ----------------
function emiPlansFor(exShowroom, onRoad, premium) {
  if (!_config.inventory || typeof _config.inventory.allSchemes !== 'function') return [];
  const loan = num(exShowroom) || num(onRoad);
  if (!loan) return [];
  const schemes = _config.inventory.allSchemes();
  return schemes.map(s => ({
    scheme: {
      bank: s.bank, roi: s.roi,
      plans: s.plans || ['reducing', 'bullet'],
      balloonPct: s.balloonPct, extensionTenure: s.extensionTenure,
      loanAmount: loan,
      basis: num(exShowroom) ? '100% of ex-showroom' : 'on-road price',
      surakshaPct: s.surakshaPct || 0,
      surakshaAmount: s.surakshaAmount || 0
    },
    // Loan = 100% of ex-showroom, so no down payment is deducted from it
    rows: _config.inventory.emiRows(loan, { ...s, minDownPct: 0 }, { premium })
  }));
}

// ---------------- benefits (what we call the discount) ----------------
function benefitsFor({ brand, model, variant, discount, insuranceBenefit }) {
  // Always present BOTH benefits, the way the WhatsApp quote does: a discount
  // benefit (a figure when we have one, otherwise openly negotiable) and the
  // insurance benefit from our rate versus the showroom quote.
  const list = [];
  let d = num(discount);
  let negotiable = false;

  if (_config.priceSync) {
    const o = _config.priceSync.lookup(brand, model, variant);
    if (o) {
      if (o.discount) d = o.discount;
      else if (o.discountVariable) negotiable = true;
    }
  }

  if (d) {
    list.push({ label: 'Discount benefit', value: d, kind: 'amount' });
  } else {
    list.push({
      label: 'Discount benefit',
      text: negotiable
        ? 'Negotiable — tell us your budget and we will get you the best possible price'
        : 'Negotiable — corporate, exchange and loyalty benefits negotiated for you',
      kind: 'negotiable'
    });
  }

  const ib = num(insuranceBenefit);
  list.push(ib
    ? {
        label: 'Insurance benefit',
        value: ib,
        text: '0-dep + consumables at our rate instead of the showroom quote',
        kind: 'amount'
      }
    : {
        label: 'Insurance benefit',
        text: '0-dep + consumables arranged at our rate — typically well below the showroom quote',
        kind: 'negotiable'
      });

  return list;
}

// ---------------- router ----------------
const router = express.Router();

router.post('/api/vehyra/variant-detail', express.json(), async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const { brand = '', model = '', variant = '', price = 0, exShowroom = 0, discount = 0, insuranceBenefit = 0 } = req.body || {};
    if (!model && !variant) return res.json({ ok: false, error: 'Car missing' });

    const [colours, sf] = await Promise.all([
      coloursFor(brand, model),
      specsFor(brand, model, variant)
    ]);

    res.json({
      ok: true,
      resolvedName: sf.resolvedName || '',
      colours,
      specs: sf.specs,
      features: sf.features,
      benefits: benefitsFor({ brand, model, variant, discount, insuranceBenefit }),
      emiTables: emiPlansFor(exShowroom, price, req.body?.premium)
    });
  } catch (e) {
    res.json({ ok: false, error: String(e.message || e) });
  }
});

module.exports = { init, router, coloursFor, specsFor, emiPlansFor, benefitsFor };
