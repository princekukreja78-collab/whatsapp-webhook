// lib/inventory.cjs — Car deal inventory: store, admin/public API, WhatsApp deal cards
// Cars (new + used) with photos, specs, features, deal terms and loan schemes.
// Admin uploads via dashboard → listing stored in data/inventory.json,
// photos in media_store/inventory/<carId>/ (served by existing /media_store static).
// WhatsApp: sendCarCard() sends photo card + [Features | Specs | Deal & EMI] buttons;
// handleButton() answers INV_* button taps from webhook.cjs.
'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const webImages = require('./webImages.cjs');

let _config = {};

// On Render the project filesystem is ephemeral — point both dirs at a
// persistent Disk via INVENTORY_DATA_DIR / INVENTORY_MEDIA_DIR.
const DATA_DIR = process.env.INVENTORY_DATA_DIR || path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'inventory.json');
const MEDIA_ROOT = process.env.INVENTORY_MEDIA_DIR || path.join(__dirname, '..', 'media_store', 'inventory');

let db = { seq: 1, schemeSeq: 1, cars: [], loanSchemes: [] };

function init(config) {
  _config = config || {};
  if (_config.fetch) webImages.init({ fetch: _config.fetch });
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(MEDIA_ROOT)) fs.mkdirSync(MEDIA_ROOT, { recursive: true });
  _load();
  console.log(`Inventory: ${db.cars.length} cars, ${db.loanSchemes.length} loan schemes`);
  // Hourly sweep: auto-unpublish deals past their expiry (15-day new-car deals etc.)
  setInterval(_expirySweep, 60 * 60 * 1000).unref?.();
  _expirySweep();
}

function _expirySweep() {
  try {
    const now = Date.now();
    let changed = 0;
    for (const car of db.cars) {
      if (car.status === 'live' && car.expiresAt && Date.parse(car.expiresAt) < now) {
        car.status = 'draft';
        car.updatedAt = new Date().toISOString();
        changed++;
        console.log(`Inventory: deal ${car.id} (${carTitle(car)}) expired — unpublished`);
        if (typeof _config.sendAdminAlert === 'function') {
          _config.sendAdminAlert({ from: 'system', name: '', text: `⏳ Deal expired & unpublished: ${carTitle(car)} (${car.id})` }).catch(() => {});
        }
      }
    }
    if (changed) _save();
  } catch (e) { console.warn('Inventory: expiry sweep failed', e.message); }
}

function _load() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      if (raw && Array.isArray(raw.cars)) db = { seq: 1, schemeSeq: 1, loanSchemes: [], ...raw };
    }
  } catch (e) { console.warn('Inventory: load failed', e.message); }
}

function _save() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2), 'utf8');
  } catch (e) { console.warn('Inventory: save failed', e.message); }
}

// ---------------- helpers ----------------
function _nextCarId() {
  const id = `MC-${String(db.seq).padStart(4, '0')}`;
  db.seq += 1;
  return id;
}
function _nextSchemeId() {
  const id = `LS-${String(db.schemeSeq).padStart(2, '0')}`;
  db.schemeSeq += 1;
  return id;
}

function fmtMoney(n) {
  if (typeof _config.fmtMoney === 'function') {
    try {
      const s = String(_config.fmtMoney(n));
      return s.includes('₹') ? s : `₹${s}`;
    } catch (e) {}
  }
  const num = Number(n) || 0;
  if (num >= 1e7) return `₹${(num / 1e7).toFixed(2).replace(/\.?0+$/, '')} Cr`;
  if (num >= 1e5) return `₹${(num / 1e5).toFixed(2).replace(/\.?0+$/, '')} Lakh`;
  return `₹${num.toLocaleString('en-IN')}`;
}

function calcEmi(principal, annualRoi, months) {
  const P = Number(principal) || 0;
  const n = Number(months) || 0;
  const r = (Number(annualRoi) || 0) / 1200;
  if (P <= 0 || n <= 0) return 0;
  if (r <= 0) return Math.round(P / n);
  const f = Math.pow(1 + r, n);
  return Math.round((P * r * f) / (f - 1));
}

function _effectivePrice(car) {
  return Number(car?.price?.offer) || Number(car?.price?.asking) || Number(car?.price?.onRoad) || 0;
}

function carTitle(car) {
  return [car.year, car.make, car.model, car.variant].filter(Boolean).join(' ').trim() || car.id;
}

function _schemesForCar(car) {
  const ids = Array.isArray(car.loanSchemeIds) ? car.loanSchemeIds : [];
  const attached = db.loanSchemes.filter(s => ids.includes(s.id));
  if (attached.length) return attached;
  // Fallback: default in-house scheme so Deal & EMI always answers
  const roi = car.type === 'new' ? 8.75 : 9.5;
  return [{ id: 'DEFAULT', bank: 'Mr. Car Finance Partner', roi, maxTenure: 72, minDownPct: 10, processingFee: 0 }];
}

function findCar(id) {
  return db.cars.find(c => c.id === id) || null;
}

/**
 * EMI table rows for one scheme: Normal vs Bullet plan per tenure.
 * Bullet plan = 25% of loan paid as yearly lump sums, EMI on the remaining 75%.
 */
function emiRows(price, scheme) {
  const downPct = Number(scheme.minDownPct) || 10;
  const financed = Math.round((Number(price) || 0) * (1 - downPct / 100));
  const roi = Number(scheme.roi) || 9.5;
  const tenures = [36, 48, 60, 72, 84].filter(t => t <= (Number(scheme.maxTenure) || 60));
  return tenures.map(t => {
    const normalEmi = calcEmi(financed, roi, t);
    const row = {
      tenure: t,
      roi,
      downPct,
      financed,
      normal: { emi: normalEmi, totalPayable: normalEmi * t },
      bullet: null
    };
    if (typeof _config.simulateBulletPlan === 'function' && t >= 12) {
      try {
        const b = _config.simulateBulletPlan({ amount: financed, rate: roi, months: t, bulletPct: 0.25 });
        if (b) {
          row.bullet = {
            emi: b.monthly_emi,
            bulletEach: b.bullet_each,
            numBullets: b.num_bullets,
            totalPayable: b.total_payable
          };
        }
      } catch (e) {}
    }
    return row;
  });
}

// ---------------- AI enrichment (specs / features / cc) ----------------
/**
 * Fill missing specs + features from AI knowledge of the exact model/variant.
 * Only fills what is empty unless force=true. Returns the updated car.
 */
async function enrichCar(id, force) {
  const car = findCar(id);
  if (!car) return null;
  if (!_config.openai) throw new Error('AI not configured');
  const hasSpecs = Array.isArray(car.specs) && car.specs.length > 0;
  const hasFeatures = Array.isArray(car.features) && car.features.length > 0;
  if (hasSpecs && hasFeatures && !force) return car;

  const desc = [car.year, car.make, car.model, car.variant, car.fuel, car.transmission]
    .filter(Boolean).join(' ');
  const resp = await _config.openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content: `You are an Indian automotive database. For the exact car given, return ONLY JSON:
{"specs":[{"group":"","label":"","value":""}],"features":[""],"confidence":"high|medium|low"}
Rules:
- specs groups in this order: Engine (Engine, Displacement in cc, Power, Torque, Transmission), Performance (Mileage ARAI), Dimensions (Length, Width, Boot Space, Ground Clearance, Fuel Tank), Safety (Airbags, key safety kit).
- features: 8-14 headline comfort/tech features of THIS variant (sunroof, seats, infotainment size, camera, climate, cruise etc.).
- India-spec values only. If the variant is unknown, use the model's common mid variant and set confidence accordingly. Never invent niche numbers you are unsure of — omit that row instead.
- Return ONLY the JSON.`
      },
      { role: 'user', content: desc || 'unknown car' }
    ],
    temperature: 0,
    max_tokens: 900
  });
  const content = resp.choices?.[0]?.message?.content || '';
  const m = content.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('AI returned no JSON');
  const parsed = JSON.parse(m[0]);
  if ((!hasSpecs || force) && Array.isArray(parsed.specs)) {
    car.specs = parsed.specs.filter(s => s && s.label && s.value)
      .map(s => ({ group: String(s.group || ''), label: String(s.label), value: String(s.value) }));
  }
  if ((!hasFeatures || force) && Array.isArray(parsed.features)) {
    car.features = parsed.features.filter(Boolean).map(String);
  }
  car.aiEnriched = { at: new Date().toISOString(), confidence: parsed.confidence || 'medium' };
  car.updatedAt = new Date().toISOString();
  _save();
  return car;
}

// ---------------- WhatsApp ingest → draft listing ----------------
function _savePhotoFromDataUri(carId, dataUri, index) {
  const m = /^data:(image\/\w+);base64,(.+)$/.exec(String(dataUri || ''));
  if (!m) return null;
  const ext = m[1] === 'image/png' ? '.png' : '.jpg';
  const dir = path.join(MEDIA_ROOT, carId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const name = `${Date.now()}_${index}${ext}`;
  fs.writeFileSync(path.join(dir, name), Buffer.from(m[2], 'base64'));
  return { file: name, url: `/media_store/inventory/${carId}/${name}`, cover: index === 0 };
}

/**
 * Create a draft listing from a WhatsApp photo-ingest entry.
 * entry: photoIngest's parsed details; photos: data-URI array; rc: RC-card data if detected.
 * AI enrichment runs in the background. Listing stays DRAFT until published.
 */
function createFromIngest({ entry, photos, rc }) {
  const toNum = v => Number(String(v || '').replace(/[^\d.]/g, '')) || 0;
  const parseLakh = v => {
    const s = String(v || '').toLowerCase();
    const n = parseFloat(s.replace(/[^\d.]/g, '')) || 0;
    return /l|lakh|lac/.test(s) ? Math.round(n * 100000) : Math.round(n);
  };
  const car = createCar({
    type: 'used',
    make: entry.brand || '', model: entry.model || '', variant: entry.variant || '',
    year: (rc && rc.regYear) || entry.year || '',
    colour: entry.color || '',
    km: toNum(entry.km) || '',
    fuel: (rc && rc.fuel) || entry.fuel || '',
    owners: entry.owner || '',
    registration: (rc && (rc.regNumber ? String(rc.regNumber).slice(0, 4).replace(/[^A-Za-z]/g, '').toUpperCase() : rc.regCity)) || entry.regCity || '',
    price: { asking: parseLakh(entry.askingPrice), offer: parseLakh(entry.lastPrice) },
    notes: [
      entry.condition ? `Condition: ${entry.condition}` : '',
      entry.dealerPhone ? `Source: WhatsApp ingest from ${entry.dealerName || ''} ${entry.dealerPhone}` : '',
      rc && rc.regNumber ? `RC: ${rc.regNumber}` : '',
      rc && rc.expiry ? `RC valid till: ${rc.expiry}` : ''
    ].filter(Boolean).join('\n')
  });
  if (rc && rc.cc) car.specs.push({ group: 'Engine', label: 'Displacement', value: `${rc.cc} cc` });
  (photos || []).forEach((p, i) => {
    const ph = _savePhotoFromDataUri(car.id, p, i);
    if (ph) car.photos.push(ph);
  });
  _save();
  // Fire-and-forget AI fill of specs/features + hero photo selection
  enrichCar(car.id).catch(e => console.warn('Inventory: auto-enrich failed', e.message));
  selectHeroPhoto(car.id).catch(e => console.warn('Inventory: hero selection failed', e.message));
  return car;
}

// ---------------- CRUD ----------------
const CAR_FIELDS = [
  'type', 'make', 'model', 'variant', 'year', 'colour', 'km', 'fuel',
  'transmission', 'owners', 'registration', 'notes'
];

function _applyCarBody(car, body) {
  for (const f of CAR_FIELDS) {
    if (body[f] !== undefined) car[f] = body[f];
  }
  if (body.price !== undefined && typeof body.price === 'object') car.price = { ...car.price, ...body.price };
  if (body.deal !== undefined && typeof body.deal === 'object') car.deal = { ...car.deal, ...body.deal };
  if (Array.isArray(body.specs)) car.specs = body.specs;         // [{group,label,value}]
  if (Array.isArray(body.features)) car.features = body.features; // [string]
  if (Array.isArray(body.loanSchemeIds)) car.loanSchemeIds = body.loanSchemeIds;
  car.updatedAt = new Date().toISOString();
}

function createCar(body) {
  const car = {
    id: _nextCarId(),
    status: 'draft',
    type: body.type === 'new' ? 'new' : 'used',
    price: {}, deal: {}, specs: [], features: [], photos: [], loanSchemeIds: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  _applyCarBody(car, body || {});
  db.cars.unshift(car);
  _save();
  return car;
}

function updateCar(id, body) {
  const car = findCar(id);
  if (!car) return null;
  _applyCarBody(car, body || {});
  _save();
  return car;
}

function deleteCar(id) {
  const idx = db.cars.findIndex(c => c.id === id);
  if (idx === -1) return false;
  db.cars.splice(idx, 1);
  _save();
  try { fs.rmSync(path.join(MEDIA_ROOT, id), { recursive: true, force: true }); } catch (e) {}
  return true;
}

function addPhotos(id, files) {
  const car = findCar(id);
  if (!car) return null;
  const dir = path.join(MEDIA_ROOT, id);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const added = [];
  for (const f of files || []) {
    const ext = (path.extname(f.originalname || '') || '.jpg').toLowerCase().replace(/[^.a-z0-9]/g, '') || '.jpg';
    const name = `${Date.now()}_${Math.floor(Math.random() * 1e4)}${ext}`;
    fs.writeFileSync(path.join(dir, name), f.buffer);
    car.photos.push({ file: name, url: `/media_store/inventory/${id}/${name}`, cover: car.photos.length === 0 });
    added.push(name);
  }
  car.updatedAt = new Date().toISOString();
  _save();
  return { car, added };
}

function removePhoto(id, file) {
  const car = findCar(id);
  if (!car) return null;
  const idx = car.photos.findIndex(p => p.file === file);
  if (idx === -1) return null;
  const wasCover = car.photos[idx].cover;
  car.photos.splice(idx, 1);
  if (wasCover && car.photos.length) car.photos[0].cover = true;
  try { fs.rmSync(path.join(MEDIA_ROOT, id, file), { force: true }); } catch (e) {}
  car.updatedAt = new Date().toISOString();
  _save();
  return car;
}

function setCover(id, file) {
  const car = findCar(id);
  if (!car) return null;
  car.photos.forEach(p => { p.cover = (p.file === file); });
  _save();
  return car;
}

function _leanCar(car) {
  const cover = car.photos.find(p => p.cover) || car.photos[0] || null;
  return {
    id: car.id, type: car.type, status: car.status,
    title: carTitle(car),
    make: car.make, model: car.model, variant: car.variant, year: car.year,
    km: car.km, fuel: car.fuel, transmission: car.transmission, colour: car.colour,
    price: car.price, deal: car.deal,
    cover: cover ? cover.url : null,
    photoCount: car.photos.length
  };
}

// ---------------- WhatsApp presentation ----------------
const DIVIDER = '━━━━━━━━━━━━━━';

function _publicPhotoUrl(car) {
  const base = String(
    _config.PUBLIC_BASE_URL || process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || ''
  ).replace(/\/+$/, '');
  const cover = car.photos.find(p => p.cover) || car.photos[0];
  if (!base || !cover) return null;
  return `${base}${cover.url}`;
}

/**
 * AI hero selection: look at all photos, pick the best front / front-three-quarter
 * exterior shot and make it the cover (the photo that rides on the WhatsApp card
 * and the website listing).
 */
async function selectHeroPhoto(id) {
  const car = findCar(id);
  if (!car || !_config.openai || (car.photos || []).length < 2) return car;

  const candidates = car.photos.slice(0, 10);
  const images = [];
  for (const p of candidates) {
    try {
      const buf = fs.readFileSync(path.join(MEDIA_ROOT, id, p.file));
      const mime = p.file.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
      images.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${buf.toString('base64')}`, detail: 'low' } });
    } catch (e) {}
  }
  if (images.length < 2) return car;

  const resp = await _config.openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content: `You see ${images.length} photos of ONE car for sale, numbered 1..${images.length} in order. Pick the single best HERO photo for the listing card: an EXTERIOR front or front-three-quarter shot showing the whole car, sharp, well-lit, clean background. Front-three-quarter beats straight-on; any exterior beats interior/dashboard/boot/documents. Reply with ONLY the number.`
      },
      { role: 'user', content: images }
    ],
    temperature: 0,
    max_tokens: 5
  });
  const n = parseInt(String(resp.choices?.[0]?.message?.content || '').replace(/[^\d]/g, ''), 10);
  if (n >= 1 && n <= candidates.length) {
    car.photos.forEach(p => { p.cover = false; });
    candidates[n - 1].cover = true;
    car.updatedAt = new Date().toISOString();
    _save();
    console.log(`Inventory: AI hero for ${id} → photo ${n} (${candidates[n - 1].file})`);
  }
  return car;
}

function buildCardCaption(car) {
  const lines = [];
  lines.push(`🚘 *${carTitle(car)}*`);
  lines.push(DIVIDER);

  const meta = [];
  if (car.type === 'used' && car.km) meta.push(`${Number(car.km).toLocaleString('en-IN')} km`);
  if (car.fuel) meta.push(car.fuel);
  if (car.transmission) meta.push(car.transmission);
  if (meta.length) lines.push(`📍 ${meta.join(' • ')}`);

  const meta2 = [];
  if (car.colour) meta2.push(car.colour);
  if (car.registration) meta2.push(`${car.registration} Reg`);
  if (car.owners) meta2.push(`${car.owners} Owner`);
  if (meta2.length) lines.push(`🎨 ${meta2.join(' • ')}`);

  lines.push('');
  const offer = Number(car.price?.offer) || 0;
  const asking = Number(car.price?.asking) || 0;
  if (offer && asking && offer < asking) {
    lines.push(`💰 *${fmtMoney(offer)}*  ~${fmtMoney(asking)}~`);
  } else if (_effectivePrice(car)) {
    lines.push(`💰 *${fmtMoney(_effectivePrice(car))}*${car.type === 'new' && car.price?.onRoad ? ' on-road' : ''}`);
  }
  if (car.deal?.headline) lines.push(`🔥 ${car.deal.headline}`);
  if (car.deal?.validTill) lines.push(`⏳ Offer valid till ${car.deal.validTill}`);

  lines.push('');
  lines.push(car.type === 'used'
    ? '✅ Mr. Car Certified • Inspected & Verified'
    : '✅ Best-in-market deal • Mr. Car Assured');
  return lines.join('\n');
}

async function _sendExploreButtons(to, car, exclude) {
  const all = [
    { id: `INV_FEAT_${car.id}`, title: '✨ Features' },
    { id: `INV_SPEC_${car.id}`, title: '⚙️ Specs' },
    { id: `INV_DEAL_${car.id}`, title: '💰 Deal & EMI' },
    { id: `INV_PICS_${car.id}`, title: '🖼 More Photos' }
  ];
  const buttons = all
    .filter(b => !String(b.id).startsWith(`INV_${exclude}_`))
    .slice(0, 3)
    .map(b => ({ type: 'reply', reply: b }));
  const interactive = {
    type: 'button',
    body: { text: 'Explore this deal 👇' },
    footer: { text: 'VehYra by MR. CAR' },
    action: { buttons }
  };
  return _config.waSendRaw({ messaging_product: 'whatsapp', to, type: 'interactive', interactive });
}

// Extract a human-readable error from a Meta API response (or wrapper)
function _waError(r) {
  if (!r) return 'No response from WhatsApp API (token/number not configured?)';
  const err = r.error || r.resp?.error;
  if (err) {
    const detail = err.error_data?.details || err.message || JSON.stringify(err);
    if (err.code === 131047 || /re-engagement/i.test(String(detail))) {
      return 'WhatsApp 24-hour window closed — ask the customer to message your business number first, then resend.';
    }
    return `WhatsApp API: ${detail}`;
  }
  return null;
}

async function sendCarCard(to, carId) {
  const car = findCar(carId);
  if (!car) return { ok: false, error: 'Car not found' };
  const caption = buildCardCaption(car).slice(0, 1024); // interactive body limit
  const photoUrl = _publicPhotoUrl(car);

  let cardRes;
  if (photoUrl) {
    // ONE message: hero photo header + deal text + buttons — nothing arrives out of order
    cardRes = await _config.waSendRaw({
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'button',
        header: { type: 'image', image: { link: photoUrl } },
        body: { text: caption },
        footer: { text: 'VehYra by MR. CAR' },
        action: {
          buttons: [
            { type: 'reply', reply: { id: `INV_FEAT_${car.id}`, title: '✨ Features' } },
            { type: 'reply', reply: { id: `INV_SPEC_${car.id}`, title: '⚙️ Specs' } },
            { type: 'reply', reply: { id: `INV_DEAL_${car.id}`, title: '💰 Deal & EMI' } }
          ]
        }
      }
    });
  } else {
    await _config.waSendText(to, caption);
    cardRes = await _sendExploreButtons(to, car, 'NONE');
  }

  const cardErr = _waError(cardRes);
  const delivered = !!(cardRes && (cardRes.messages || (cardRes.ok && cardRes.resp?.messages)));
  if (!delivered) {
    return { ok: false, error: cardErr || 'Message not accepted by WhatsApp' };
  }
  return { ok: true };
}

function buildFeaturesText(car) {
  const lines = [`✨ *Features — ${carTitle(car)}*`, DIVIDER];
  if (car.features?.length) {
    for (const f of car.features) lines.push(`✅ ${f}`);
  } else {
    lines.push('Feature list coming soon — ask us anything about this car!');
  }
  return lines.join('\n');
}

function buildSpecsText(car) {
  const lines = [`⚙️ *Specifications — ${carTitle(car)}*`, DIVIDER];
  if (car.specs?.length) {
    let lastGroup = null;
    for (const s of car.specs) {
      if (s.group && s.group !== lastGroup) {
        lines.push('');
        lines.push(`*${s.group}*`);
        lastGroup = s.group;
      }
      lines.push(`• ${s.label}: ${s.value}`);
    }
  } else {
    lines.push('Detailed specs coming soon — ask us anything about this car!');
  }
  return lines.join('\n');
}

function buildDealText(car) {
  const lines = [`💰 *Deal & Finance — ${carTitle(car)}*`, DIVIDER];
  const offer = Number(car.price?.offer) || 0;
  const asking = Number(car.price?.asking) || 0;
  const price = _effectivePrice(car);

  if (offer && asking && offer < asking) {
    lines.push(`*Price:* ${fmtMoney(offer)}  ~${fmtMoney(asking)}~`);
    lines.push(`💸 You save *${fmtMoney(asking - offer)}*`);
  } else if (price) {
    lines.push(`*Price:* ${fmtMoney(price)}`);
  }
  if (car.deal?.discount) lines.push(`🎁 Discount: ${car.deal.discount}`);
  if (car.deal?.exchangeBonus) lines.push(`🎁 Exchange Bonus: ${car.deal.exchangeBonus}`);
  if (car.deal?.freebies) lines.push(`🎁 ${car.deal.freebies}`);
  if (car.deal?.validTill) lines.push(`⏳ Valid till *${car.deal.validTill}*`);

  if (price) {
    const schemes = _schemesForCar(car);
    lines.push('');
    lines.push('*EMI Options* 👇');
    for (const s of schemes.slice(0, 3)) {
      const downPct = Number(s.minDownPct) || 10;
      const financed = Math.round(price * (1 - downPct / 100));
      lines.push('');
      lines.push(`🏦 *${s.bank}* @ ${s.roi}% p.a. (${downPct}% down · ${fmtMoney(financed)} financed)`);
      const tenures = [36, 48, 60, 72, 84].filter(t => t <= (Number(s.maxTenure) || 60));
      for (const t of tenures.slice(-3)) {
        lines.push(`  • ${t} months — *₹${calcEmi(financed, s.roi, t).toLocaleString('en-IN')}*/mo`);
      }
      if (s.processingFee) lines.push(`  _Processing fee: ${fmtMoney(s.processingFee)}_`);
    }
    // Bullet EMI comparison on the primary scheme — lower monthly outgo, yearly lump sums
    const rows = emiRows(price, schemes[0]).filter(r => r.bullet);
    if (rows.length) {
      const best = rows[rows.length - 1];
      lines.push('');
      lines.push(`💡 *Bullet EMI Plan* (${schemes[0].bank})`);
      lines.push(`_Keep your monthly EMI low — pay 25% as small yearly bullets:_`);
      for (const r of rows.slice(-2)) {
        lines.push(`  • ${r.tenure} mo — *₹${r.bullet.emi.toLocaleString('en-IN')}*/mo + ₹${r.bullet.bulletEach.toLocaleString('en-IN')}/yr ×${r.bullet.numBullets}`);
      }
      lines.push(`  _vs normal ₹${best.normal.emi.toLocaleString('en-IN')}/mo — you keep ~₹${(best.normal.emi - best.bullet.emi).toLocaleString('en-IN')}/mo in hand_`);
    }
    lines.push('');
    lines.push('_RC transfer support • Doorstep delivery • Best rates negotiated for you_');
  }
  return lines.join('\n');
}

async function _sendActionButtons(to, car) {
  const interactive = {
    type: 'button',
    body: { text: 'Ready to take it forward? 🚗' },
    footer: { text: 'VehYra by MR. CAR' },
    action: {
      buttons: [
        { type: 'reply', reply: { id: `INV_TD_${car.id}`, title: '📅 Book Test Drive' } },
        { type: 'reply', reply: { id: `INV_PICS_${car.id}`, title: '🖼 More Photos' } },
        { type: 'reply', reply: { id: `INV_CALL_${car.id}`, title: '📞 Talk to Sales' } }
      ]
    }
  };
  return _config.waSendRaw({ messaging_product: 'whatsapp', to, type: 'interactive', interactive });
}

/**
 * Handle an INV_* button tap. Returns true if handled.
 * IDs: INV_FEAT_<id> | INV_SPEC_<id> | INV_DEAL_<id> | INV_PICS_<id> | INV_TD_<id> | INV_CALL_<id>
 */
async function handleButton(from, selectedId) {
  const m = /^INV_(FEAT|SPEC|DEAL|PICS|TD|CALL)_(.+)$/.exec(String(selectedId || ''));
  if (!m) return false;
  const [, action, carId] = m;
  const car = findCar(carId);
  if (!car) {
    await _config.waSendText(from, 'This listing is no longer available. Reply *CARS* to see current deals.');
    return true;
  }

  try {
    if (action === 'FEAT') {
      await _config.waSendText(from, buildFeaturesText(car));
      await _sendExploreButtons(from, car, 'FEAT');
    } else if (action === 'SPEC') {
      await _config.waSendText(from, buildSpecsText(car));
      await _sendExploreButtons(from, car, 'SPEC');
    } else if (action === 'DEAL') {
      await _config.waSendText(from, buildDealText(car));
      await _sendActionButtons(from, car);
    } else if (action === 'PICS') {
      const base = String(_config.PUBLIC_BASE_URL || process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
      const extras = car.photos.filter(p => !p.cover).slice(0, 4);
      if (!base || !extras.length) {
        await _config.waSendText(from, 'More photos coming soon — tap *Talk to Sales* and we’ll send them personally.');
      } else {
        for (const p of extras) await _config.waSendImageLink(from, `${base}${p.url}`, '');
        // Let the images land before the buttons so they don't overtake them
        await new Promise(r => setTimeout(r, 3000));
        await _sendExploreButtons(from, car, 'PICS');
      }
    } else if (action === 'TD') {
      await _config.waSendText(from,
        `📅 *Test drive request received!*\n\nOur team will call you shortly to schedule your test drive of the *${carTitle(car)}*.\n\n_MR. CAR SERVICES • Ashok Vihar, Delhi_`);
      if (typeof _config.sendAdminAlert === 'function') {
        _config.sendAdminAlert({ from, name: '', text: `🚨 TEST DRIVE request: ${carTitle(car)} (${car.id}) from ${from}` }).catch(() => {});
      }
    } else if (action === 'CALL') {
      await _config.waSendText(from,
        `📞 *We're on it!*\n\nA Mr. Car advisor will call you shortly about the *${carTitle(car)}*.\n\n_MR. CAR SERVICES • Ashok Vihar, Delhi_`);
      if (typeof _config.sendAdminAlert === 'function') {
        _config.sendAdminAlert({ from, name: '', text: `🚨 SALES CALLBACK request: ${carTitle(car)} (${car.id}) from ${from}` }).catch(() => {});
      }
    }
  } catch (e) {
    if (_config.DEBUG) console.warn('inventory handleButton failed', e.message);
  }
  return true;
}

// ---------------- New-car / demo deal from a forwarded price sheet ----------------
const _n = v => Number(String(v ?? '').replace(/[^\d.]/g, '')) || 0;

/**
 * Create a LIVE new-car (or demo-car) deal from a WhatsApp price-sheet forward.
 * - AI-normalizes the sheet's model text (e.g. "IX1 2026 / Ix1 lwb" → BMW iX1 LWB 2026)
 * - Price breakup lands as a Specs group, on-road as the price
 * - Real photos of the exact colours are fetched from the web, AI picks the hero
 * - Deal auto-expires (unpublishes) after `days` (default 15)
 */
async function createNewCarDeal({ sheetModel, dealType, colours, breakup, regState, days = 15 }) {
  if (!_config.openai) throw new Error('AI not configured');

  // 1. Normalize the model name
  let id = { make: '', model: String(sheetModel || '').trim(), variant: '', year: '' };
  try {
    const resp = await _config.openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You normalize Indian car dealer shorthand into exact car identity. Return ONLY JSON {"make":"","model":"","variant":"","year":""}. variant must be a REAL factory trim (e.g. "M Sport", "ZX(O)") — if the text is just shorthand or repeats the model, leave variant "". Example: "IX1 2026 / Ix1 lwb" → {"make":"BMW","model":"iX1 LWB","variant":"","year":"2026"}.' },
        { role: 'user', content: String(sheetModel || '') }
      ],
      temperature: 0, max_tokens: 100
    });
    const m = (resp.choices?.[0]?.message?.content || '').match(/\{[\s\S]*\}/);
    if (m) id = { ...id, ...JSON.parse(m[0]) };
  } catch (e) { console.warn('Inventory: model normalize failed', e.message); }

  const onRoad = _n(breakup?.onRoad);
  const exShowroom = _n(breakup?.exShowroom);
  const isDemo = String(dealType || '').toLowerCase().includes('demo');
  const expires = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  const validTill = expires.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

  const breakupSpecs = [
    ['Ex-Showroom', exShowroom], ['TCS @ 1%', _n(breakup?.tcs)],
    ['Accessories', _n(breakup?.accessories)], ['Fastag / Cess / Temp No.', _n(breakup?.misc)],
    ['Insurance', _n(breakup?.insurance)], [`Road Tax${regState ? ' — ' + regState : ''}`, _n(breakup?.roadTax)],
    ['On-Road Total', onRoad]
  ].filter(([, v]) => v > 0).map(([label, v]) => ({ group: 'Price Breakup', label, value: fmtMoney(v) }));

  const car = createCar({
    type: 'new',
    make: id.make, model: id.model, variant: id.variant, year: id.year,
    colour: (colours || []).join(', '),
    price: { exShowroom, onRoad },
    deal: {
      headline: `${isDemo ? 'Demo car' : 'New car'} deal — On-road ${fmtMoney(onRoad)}${regState ? ' (' + regState + ' reg)' : ''}`,
      validTill
    },
    notes: `Auto-created from WhatsApp price sheet (${isDemo ? 'demo' : 'new'} car deal)`
  });
  car.expiresAt = expires.toISOString();
  car.specs = breakupSpecs;
  _save();

  // 2. Real photos of the exact colours from the web (up to 3 colours, 2 shots each)
  let photoCount = 0;
  for (const colour of (colours || []).slice(0, 3)) {
    const q = [id.year, id.make, id.model, id.variant, colour].filter(Boolean).join(' ');
    try {
      const imgs = await webImages.fetchImages(q, 2);
      const dir = path.join(MEDIA_ROOT, car.id);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      for (const img of imgs) {
        const name = `${Date.now()}_${Math.floor(Math.random() * 1e4)}${img.ext}`;
        fs.writeFileSync(path.join(dir, name), img.buffer);
        car.photos.push({ file: name, url: `/media_store/inventory/${car.id}/${name}`, cover: car.photos.length === 0 });
        photoCount++;
      }
    } catch (e) { console.warn('Inventory: web photos failed for', q, e.message); }
  }
  _save();

  // 3. Hero pick + spec/feature fill (specs merge: keep price breakup, add model specs)
  if (photoCount > 1) await selectHeroPhoto(car.id).catch(() => {});
  try {
    const before = car.specs;
    car.specs = [];
    await enrichCar(car.id, true);
    car.specs = [...before, ...car.specs];
    _save();
  } catch (e) { car.specs = car.specs.length ? car.specs : breakupSpecs; _save(); }

  car.status = 'live';
  car.updatedAt = new Date().toISOString();
  _save();
  return { car, photoCount };
}

// ---------------- Express router ----------------
const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024, files: 12 } });

router.use(['/api/inventory', '/api/vehyra'], express.json({ limit: '2mb' }), (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Admin auth (public /api/vehyra/* stays open)
router.use('/api/inventory', (req, res, next) => {
  const expected = String(process.env.INVENTORY_ADMIN_TOKEN || '').trim();
  if (!expected) return res.status(503).json({ ok: false, error: 'INVENTORY_ADMIN_TOKEN not configured' });
  if (String(req.headers['x-admin-token'] || '').trim() !== expected) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  next();
});

// ---- Admin: storage diagnostic ----
router.get('/api/inventory/storage', (req, res) => {
  let writable = false;
  try { fs.accessSync(DATA_DIR, fs.constants.W_OK); writable = true; } catch (e) {}
  res.json({
    ok: true,
    version: 'deal-sheet-1',
    dataDir: DATA_DIR,
    mediaRoot: MEDIA_ROOT,
    dataDirWritable: writable,
    onPersistentDisk: DATA_DIR.startsWith('/var/data') && MEDIA_ROOT.startsWith('/var/data'),
    env: {
      INVENTORY_DATA_DIR: process.env.INVENTORY_DATA_DIR || null,
      INVENTORY_MEDIA_DIR: process.env.INVENTORY_MEDIA_DIR || null
    }
  });
});

// ---- Admin: cars ----
router.get('/api/inventory/cars', (req, res) => {
  let cars = db.cars;
  const { status, type, q } = req.query || {};
  if (status) cars = cars.filter(c => c.status === status);
  if (type) cars = cars.filter(c => c.type === type);
  if (q) {
    const needle = String(q).toLowerCase();
    cars = cars.filter(c => `${c.id} ${carTitle(c)}`.toLowerCase().includes(needle));
  }
  res.json({ ok: true, cars });
});

router.post('/api/inventory/cars', (req, res) => {
  const car = createCar(req.body || {});
  res.json({ ok: true, car });
});

router.get('/api/inventory/cars/:id', (req, res) => {
  const car = findCar(req.params.id);
  if (!car) return res.status(404).json({ ok: false, error: 'Not found' });
  res.json({ ok: true, car });
});

router.put('/api/inventory/cars/:id', (req, res) => {
  const car = updateCar(req.params.id, req.body || {});
  if (!car) return res.status(404).json({ ok: false, error: 'Not found' });
  res.json({ ok: true, car });
});

router.delete('/api/inventory/cars/:id', (req, res) => {
  if (!deleteCar(req.params.id)) return res.status(404).json({ ok: false, error: 'Not found' });
  res.json({ ok: true });
});

router.post('/api/inventory/cars/:id/status', (req, res) => {
  const status = String(req.body?.status || '');
  if (!['draft', 'live', 'sold'].includes(status)) return res.status(400).json({ ok: false, error: 'Bad status' });
  const car = updateCar(req.params.id, {});
  if (!car) return res.status(404).json({ ok: false, error: 'Not found' });
  car.status = status;
  _save();
  res.json({ ok: true, car });
});

router.post('/api/inventory/cars/:id/photos', upload.array('photos', 12), (req, res) => {
  const out = addPhotos(req.params.id, req.files);
  if (!out) return res.status(404).json({ ok: false, error: 'Not found' });
  // AI picks the hero (front shot) in the background — cover updates shortly after upload
  selectHeroPhoto(req.params.id).catch(e => console.warn('Inventory: hero selection failed', e.message));
  res.json({ ok: true, car: out.car, added: out.added });
});

// Re-run AI hero selection on demand
router.post('/api/inventory/cars/:id/hero', async (req, res) => {
  try {
    const car = await selectHeroPhoto(req.params.id);
    if (!car) return res.status(404).json({ ok: false, error: 'Not found' });
    res.json({ ok: true, car });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

router.delete('/api/inventory/cars/:id/photos/:file', (req, res) => {
  const car = removePhoto(req.params.id, req.params.file);
  if (!car) return res.status(404).json({ ok: false, error: 'Not found' });
  res.json({ ok: true, car });
});

router.post('/api/inventory/cars/:id/cover', (req, res) => {
  const car = setCover(req.params.id, String(req.body?.file || ''));
  if (!car) return res.status(404).json({ ok: false, error: 'Not found' });
  res.json({ ok: true, car });
});

// AI-fill missing specs/features (force=true re-fills)
router.post('/api/inventory/cars/:id/enrich', async (req, res) => {
  try {
    const car = await enrichCar(req.params.id, !!req.body?.force);
    if (!car) return res.status(404).json({ ok: false, error: 'Not found' });
    res.json({ ok: true, car });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// Preview the WhatsApp card texts without sending
router.get('/api/inventory/cars/:id/preview', (req, res) => {
  const car = findCar(req.params.id);
  if (!car) return res.status(404).json({ ok: false, error: 'Not found' });
  res.json({
    ok: true,
    caption: buildCardCaption(car),
    features: buildFeaturesText(car),
    specs: buildSpecsText(car),
    deal: buildDealText(car)
  });
});

// Send the deal card to a WhatsApp number
router.post('/api/inventory/cars/:id/send', async (req, res) => {
  const to = String(req.body?.to || '').replace(/[^\d]/g, '');
  if (!to || to.length < 10) return res.status(400).json({ ok: false, error: 'Valid phone required' });
  const full = to.length === 10 ? `91${to}` : to;
  try {
    const out = await sendCarCard(full, req.params.id);
    res.json(out);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ---- Admin: loan schemes ----
router.get('/api/inventory/loan-schemes', (req, res) => {
  res.json({ ok: true, schemes: db.loanSchemes });
});

router.post('/api/inventory/loan-schemes', (req, res) => {
  const b = req.body || {};
  const scheme = {
    id: _nextSchemeId(),
    bank: String(b.bank || 'Bank'),
    roi: Number(b.roi) || 9.5,
    maxTenure: Number(b.maxTenure) || 60,
    minDownPct: Number(b.minDownPct) || 10,
    processingFee: Number(b.processingFee) || 0,
    notes: String(b.notes || '')
  };
  db.loanSchemes.push(scheme);
  _save();
  res.json({ ok: true, scheme });
});

router.put('/api/inventory/loan-schemes/:id', (req, res) => {
  const scheme = db.loanSchemes.find(s => s.id === req.params.id);
  if (!scheme) return res.status(404).json({ ok: false, error: 'Not found' });
  const b = req.body || {};
  for (const k of ['bank', 'roi', 'maxTenure', 'minDownPct', 'processingFee', 'notes']) {
    if (b[k] !== undefined) scheme[k] = (k === 'bank' || k === 'notes') ? String(b[k]) : Number(b[k]);
  }
  _save();
  res.json({ ok: true, scheme });
});

router.delete('/api/inventory/loan-schemes/:id', (req, res) => {
  const idx = db.loanSchemes.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ ok: false, error: 'Not found' });
  db.loanSchemes.splice(idx, 1);
  db.cars.forEach(c => { c.loanSchemeIds = (c.loanSchemeIds || []).filter(x => x !== req.params.id); });
  _save();
  res.json({ ok: true });
});

// ---- Public (Vehyra website) ----
router.get('/api/vehyra/inventory', (req, res) => {
  let cars = db.cars.filter(c => c.status === 'live');
  const { type, q } = req.query || {};
  if (type) cars = cars.filter(c => c.type === type);
  if (q) {
    const needle = String(q).toLowerCase();
    cars = cars.filter(c => carTitle(c).toLowerCase().includes(needle));
  }
  res.json({ ok: true, cars: cars.map(_leanCar) });
});

router.get('/api/vehyra/inventory/:id', (req, res) => {
  const car = findCar(req.params.id);
  if (!car || car.status !== 'live') return res.status(404).json({ ok: false, error: 'Not found' });
  const { createdAt, updatedAt, notes, ...pub } = car;
  const schemes = _schemesForCar(car);
  const price = _effectivePrice(car);
  res.json({
    ok: true,
    car: {
      ...pub,
      title: carTitle(car),
      schemes,
      emiTables: price ? schemes.map(s => ({ scheme: s, rows: emiRows(price, s) })) : []
    }
  });
});

router.get('/api/vehyra/loan-schemes', (req, res) => {
  res.json({ ok: true, schemes: db.loanSchemes });
});

module.exports = {
  init,
  router,
  handleButton,
  sendCarCard,
  createFromIngest,
  createNewCarDeal,
  enrichCar,
  selectHeroPhoto,
  emiRows,
  // exposed for tests
  buildCardCaption, buildFeaturesText, buildSpecsText, buildDealText,
  calcEmi, findCar
};
