// lib/photoIngest.cjs — Analyze dealer photos via GPT-4o-mini, ask for details, save to sheet
// When a dealer sends a photo to staging with no text, the bot:
// 1. Analyzes the photo with GPT vision
// 2. Replies with detected details and asks for confirmation + price/km
// 3. On dealer's reply, saves everything to Google Sheet with a unique ID

const fs = require('fs');
const path = require('path');

let _config = {};

// Track pending photo ingests: dealerPhone → { id, photos[], analysis, stage }
const pendingPhotos = new Map();
// Track incoming photo batches: dealerPhone → { photos[], timer, carId, name }
const photoBatch = new Map();

const BATCH_WAIT_MS = 15000;

// A short diary of what the intake actually did. Without it, "I uploaded a car
// and nothing happened" can only be answered by asking for screenshots.
const _events = [];
function _note(from, kind, detail) {
  _events.push({ at: new Date().toISOString(), from: String(from || '').slice(-4), kind, detail: String(detail || '').slice(0, 160) });
  if (_events.length > 60) _events.shift();
  console.log(`PhotoIngest[${kind}] ${detail || ''}`);
}
function intakeState() {
  return {
    events: _events.slice(-30).reverse(),
    collecting: [...photoBatch.entries()].map(([from, b]) => ({ from: from.slice(-4), carId: b.carId, photos: b.photos.length, captions: b.captions })),
    awaitingDetails: [...pendingPhotos.entries()].map(([from, p]) => ({ from: from.slice(-4), id: p.id, stage: p.stage, photos: p.photoCount || (p.photos || []).length, since: p.createdAt }))
  };
} // Wait 15 seconds for more photos before analyzing

const INVENTORY_SHEET_WEBHOOK = ''; // Set via init from env

function init(config) {
  _config = config;
}

/**
 * Handle a photo-only message on staging number.
 * Analyzes with GPT, asks dealer for details.
 * @param {string} from — dealer phone
 * @param {string} name — dealer name
 * @param {string} imageId — WhatsApp media ID
 * @param {string} caption — image caption (may be empty)
 * @returns {boolean} true if handled
 */
async function handlePhoto(from, name, imageId, caption) {
  if (!imageId) return false;
  if (!_config.openai) return false;

  // If already awaiting details for previous car, skip new photos
  const existing = pendingPhotos.get(from);
  if (existing && existing.stage === 'AWAITING_CONFIRM') {
    // Save additional photo to existing pending entry
    try {
      let localUrl = null;
      if (_config.mediaStore) {
        localUrl = await _config.mediaStore.saveMedia(imageId, 'pending_' + existing.id, from, existing.id);
      }
      if (!existing.extraPhotos) existing.extraPhotos = [];
      existing.extraPhotos.push(localUrl || imageId);
      console.log(`PhotoIngest: added extra photo to pending ${existing.id} (total: ${1 + existing.extraPhotos.length})`);
    } catch (e) {}
    return true; // silently accept, don't ask again
  }

  // Batch photos: collect all photos sent within 15 seconds
  let batch = photoBatch.get(from);

  if (!batch) {
    // First photo — start batch
    const carId = 'CAR-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).slice(2, 5).toUpperCase();
    batch = { carId, name, photos: [], captions: [] };
    photoBatch.set(from, batch);
  }

  // Download and save this photo
  try {
    const imageUrl = await _downloadMedia(imageId);
    if (imageUrl) {
      batch.photos.push(imageUrl);
      if (caption) batch.captions.push(caption);

      // Save locally
      if (_config.mediaStore) {
        await _config.mediaStore.saveMedia(imageId, 'pending_' + batch.carId, from, batch.carId);
      }
    }
  } catch (e) {
    console.warn('PhotoIngest: download failed for batch photo', e.message);
  }

  _note(from, 'photo', `#${batch.photos.length} in batch ${batch.carId}`);

  // Reset debounce timer — wait for more photos
  if (batch.timer) clearTimeout(batch.timer);
  batch.timer = setTimeout(async () => {
    try {
      await _processBatch(from);
    } catch (e) {
      console.error('PhotoIngest: batch processing failed', e.message);
    }
  }, BATCH_WAIT_MS);

  photoBatch.set(from, batch);
  return true;
}

async function _processBatch(from) {
  const batch = photoBatch.get(from);
  if (!batch || !batch.photos.length) return;
  photoBatch.delete(from);

  _note(from, 'batch', `${batch.photos.length} photo(s), analysing`);

  // Analyze ALL photos in one vision call (car ID + variant + RC card detection)
  const analysis = await _analyzeCarPhotos(batch.photos, batch.captions.join(' '));

  // Deal admin + no price sheet found on the first pass? WhatsApp compression can hide
  // the numbers — run a focused extraction pass before falling to the used-car flow.
  // Photos of an actual car are never a price sheet. An unregistered GT 63 was
  // read as one, and the deal flow then demanded "NEW or DEMO + colours" while
  // the dealer was trying to list the car itself.
  const looksLikeACar = !!(analysis.brand || analysis.model || analysis.color || analysis.condition);
  if (!looksLikeACar && !analysis.price_sheet && _isDealAdmin(from)) {
    const cap = batch.captions.join(' ');
    const looksLikeSheet = /\b(new|demo)\b/i.test(cap) ||
      (!analysis.color && !analysis.condition && !analysis.rc);
    if (looksLikeSheet) {
      analysis.price_sheet = await _extractPriceSheet(batch.photos[0]);
    }
  }

  // Price sheet from a NON-admin number: don't run the used-car questionnaire on a
  // cost table — tell the admin which number tried, so it can be allow-listed.
  if (analysis.price_sheet && !_isDealAdmin(from)) {
    console.log(`PhotoIngest: price sheet from non-admin ${from} — ignored`);
    const admin = String(process.env.ADMIN_WA || '').replace(/[^\d]/g, '');
    if (admin && admin !== String(from).replace(/[^\d]/g, '')) {
      _config.waSendText(admin, `📋 Price sheet received from ${from} but that number is not a deal admin. Add it to DEAL_ADMIN_NUMBERS to enable deal creation.`).catch(() => {});
    }
    return;
  }

  // ── MULTI-VARIANT PRICE LIST (deal admins only): sync sheet prices ──
  // A used-car listing is not a price list. "RUN - 39000 / FIRST OWNER / HR26
  // REG / LAST DIGIT - 4797" was read as a new-car sheet for the Range Rover
  // Evoque, and the model invented three variants at 70, 75 and 80 lakh.
  const captionText = batch.captions.join(' ');
  const looksUsed = /\b(run|driven|odo)\s*[-:]?\s*\d|\b(first|second|third|1st|2nd|3rd|single)\s*owner\b|\blast\s*digits?\b|\b[a-z]{2}\s?\d{1,2}\s*reg\b|\bboth key\b|\bservice record\b/i.test(captionText);
  if (looksUsed) {
    console.log('PhotoIngest: caption reads as a used-car listing — skipping the price-list path');
  }
  if (!looksUsed && _isDealAdmin(from) && _config.priceSync) {
    try {
      const handledList = await _config.priceSync.handlePriceList(from, batch.photos);
      if (handledList) return;
    } catch (e) { console.warn('PhotoIngest: price list handling failed', e.message); }
  }

  // ── NEW-CAR PRICE SHEET (deal admins only): create a 15-day live deal ──
  // If we have already asked this dealer to confirm a car's details, a later
  // price-sheet reading must not seize the conversation from under the answer
  // they are typing.
  const midQuestionnaire = (() => {
    const p = pendingPhotos.get(from);
    return !!(p && p.stage === 'AWAITING_CONFIRM');
  })();
  if (analysis.price_sheet && !looksLikeACar && !midQuestionnaire && _isDealAdmin(from) && _config.inventory) {
    const sheet = analysis.price_sheet;
    const caption = batch.captions.join(' ');
    const inline = _parseDealReply(caption); // "new carbon black, dusk blue" typed as the caption?

    if (inline) {
      await _createDealFromSheet(from, sheet, inline.dealType, inline.colours);
    } else {
      pendingPhotos.set(from, {
        id: batch.carId, sheet, stage: 'AWAITING_DEAL_TYPE',
        dealerPhone: from, createdAt: new Date().toISOString()
      });
      const onRoad = Number(String(sheet.onRoad || '').replace(/[^\d]/g, '')) || 0;
      await _config.waSendText(from,
        `📋 *Price sheet detected*\n\n` +
        `Model: *${sheet.model || 'unknown'}*\n` +
        (onRoad ? `On-road: *₹${onRoad.toLocaleString('en-IN')}*${sheet.regState ? ` (${sheet.regState})` : ''}\n` : '') +
        `\nReply with *NEW* or *DEMO* + colours to publish a 15-day deal, e.g.:\n` +
        `_new Carbon Black, Night Dusk Blue_`
      );
    }
    return;
  }

  // Paperwork in the batch is kept but never published — work out which is which
  // now, while every photo of this batch is still in hand.
  const documentIndexes = await _findDocumentPhotos(batch.photos);
  if (documentIndexes.length) {
    console.log(`PhotoIngest: ${documentIndexes.length} paperwork photo(s) in ${batch.carId} — will stay private`);
  }

  // Store as pending
  pendingPhotos.set(from, {
    id: batch.carId,
    analysis,
    documentIndexes,
    photos: batch.photos,
    photoCount: batch.photos.length,
    dealerPhone: from,
    dealerName: batch.name,
    caption: batch.captions.join(' '),
    stage: 'AWAITING_CONFIRM',
    createdAt: new Date().toISOString()
  });

  // Reply ONCE with detected details
  const BUSINESS_NAME = process.env.MRCAR_BUSINESS_NAME || 'MR. CAR, Ashok Vihar';
  let msg = `Hi, this is an assistant from *${BUSINESS_NAME}*.\n\n`;
  msg += `*${batch.photos.length} photo(s) received — ID: ${batch.carId}*\n\n`;
  msg += `Our system detected:\n`;
  if (analysis.brand) msg += `Brand: *${analysis.brand}*\n`;
  if (analysis.model) msg += `Model: *${analysis.model}*\n`;
  if (analysis.variant) msg += `Variant: *${analysis.variant}*\n`;
  if (analysis.year) msg += `Year: *~${analysis.year}*\n`;
  if (analysis.color) msg += `Color: *${analysis.color}*\n`;
  if (analysis.fuel) msg += `Fuel: *${analysis.fuel}*\n`;
  if (analysis.condition) msg += `Condition: ${analysis.condition}\n`;
  if (analysis.rc && analysis.rc.regNumber) {
    msg += `\n📄 *RC detected:* ${analysis.rc.regNumber}`;
    if (analysis.rc.regYear) msg += ` • ${analysis.rc.regYear}`;
    if (analysis.rc.cc) msg += ` • ${analysis.rc.cc}cc`;
    msg += `\n`;
  }
  msg += `\nPlease confirm above and share:\n`;
  msg += `1. *Correct model & year* (if different)\n`;
  msg += `2. *KM driven*\n`;
  msg += `3. *Asking price*\n`;
  msg += `4. *Last price* (best offer)\n`;
  msg += `5. *Owner* (1st/2nd/3rd)\n`;
  msg += `6. *Registration city*\n\n`;
  msg += `_Just reply with the details in any format._`;

  await _config.waSendText(from, msg);
}

/**
 * Handle dealer's text reply after photo analysis.
 * Extract details, save to sheet.
 * @returns {boolean} true if this was a pending photo confirmation
 */
// ---- New-car deal helpers ----
// Focused pass: ONLY read a cost table. Returns price_sheet object or null.
/**
 * Which photos in this batch are PAPERWORK rather than the car. An RC card shows
 * the registration number, the owner's name and the chassis number, and the
 * intake actively asks for it — so it lands in the same batch as the car photos
 * and would otherwise be published. Cheap low-detail pass over the WHOLE batch;
 * the identification call above only ever sees the first six.
 * Returns 0-based indexes.
 */
async function _findDocumentPhotos(photos) {
  const list = photos || [];
  if (!_config.openai || !list.length) return [];
  try {
    const images = list.slice(0, 20).map(url => ({ type: 'image_url', image_url: { url, detail: 'low' } }));
    const resp = await _config.openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          // Labelling EVERY image beats asking for "the numbers of the paperwork":
          // the list form answered "none" even for a full-frame text image, while
          // this one sorted a 12-image batch (2 logos, 1 text poster) perfectly.
          role: 'system',
          content: `You are sorting ${images.length} images numbered 1..${images.length}, in order, sent by a car dealer.
Label EVERY image with exactly one word:
CAR = a photograph of a vehicle — exterior, interior, dashboard, boot, engine bay, wheels, damage close-up. A visible number plate does NOT change this.
DOC = anything that is not a photograph of a vehicle — an RC / registration certificate, insurance policy, invoice, price or cost sheet, service record, ID card, chassis/VIN plate close-up, a screenshot, or any image that is mostly text or graphics.
Reply with one line per image, exactly: "<number>:<CAR or DOC>". No other text.`
        },
        { role: 'user', content: images }
      ],
      temperature: 0,
      max_tokens: 200
    });
    const txt = String(resp.choices?.[0]?.message?.content || '');
    const docs = [];
    for (const line of txt.split(/[\n,]/)) {
      const m = /^\s*(\d+)\s*:\s*(CAR|DOC)\s*$/i.exec(line);
      if (m && m[2].toUpperCase() === 'DOC') {
        const i = Number(m[1]) - 1;
        if (i >= 0 && i < list.length) docs.push(i);
      }
    }
    return [...new Set(docs)];
  } catch (e) {
    // Fail open: hiding every photo would empty the listing. The ack warns the
    // admin instead when an RC was read but no photo could be pinned to it.
    console.warn('PhotoIngest: document check failed', e.message);
    return [];
  }
}

async function _extractPriceSheet(imageUrl) {
  if (!imageUrl || !_config.openai) return null;
  try {
    const resp = await _config.openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `The image may be a car dealer PRICE SHEET (a table with rows like Ex-Showroom, TCS, Insurance, Road Tax, ON ROAD). If it is, return ONLY JSON:
{"model":"","exShowroom":"","tcs":"","accessories":"","misc":"","insurance":"","roadTax":"","onRoad":"","regState":""}
model = the header text naming the car; every amount as plain digits (no commas or currency symbols); regState from the road-tax row. If the image is NOT a price/cost table, return exactly null.`
        },
        { role: 'user', content: [{ type: 'image_url', image_url: { url: imageUrl } }] }
      ],
      temperature: 0,
      max_tokens: 250
    });
    const content = resp.choices?.[0]?.message?.content || '';
    const m = content.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const sheet = JSON.parse(m[0]);
    const num = v => Number(String(v || '').replace(/[^\d]/g, '')) || 0;
    if (!num(sheet.onRoad) && !num(sheet.exShowroom)) return null;
    console.log('PhotoIngest: focused price-sheet extraction succeeded');
    return sheet;
  } catch (e) {
    console.warn('PhotoIngest: price-sheet extraction failed', e.message);
    return null;
  }
}

function _isDealAdmin(from) {
  if (_config.inventory && typeof _config.inventory.isDealAdmin === 'function') {
    return _config.inventory.isDealAdmin(from);
  }
  return false;
}

// "new Carbon Black, Night Dusk Blue" / "Carbon Black AND Dusk Blue FOR NEW CAR"
// → { dealType, colours[] }. Requires the word new or demo somewhere.
function _parseDealReply(text) {
  const t = String(text || '').trim();
  const dealType = /\bdemo\b/i.test(t) ? 'demo' : (/\bnew\b/i.test(t) ? 'new' : null);
  if (!dealType) return null;
  const colours = t
    .replace(/\b(for|the|a|new|demo|car|cars|deal)\b/gi, ',')
    .split(/,|\band\b|\/|\n/i)
    .map(s => s.replace(/[^\w\s-]/g, '').trim())
    .filter(s => s.length > 2)
    .slice(0, 4);
  return { dealType, colours };
}

async function _createDealFromSheet(from, sheet, dealType, colours) {
  await _config.waSendText(from, `⏳ Creating ${dealType} car deal — fetching ${colours.length ? colours.join(' & ') + ' ' : ''}photos & specs…`);
  try {
    const { car, photoCount } = await _config.inventory.createNewCarDeal({
      sheetModel: sheet.model,
      dealType,
      colours,
      breakup: sheet,
      regState: sheet.regState || ''
    });
    let blastLine = '';
    if (_config.dealBlast) {
      try {
        const matched = _config.dealBlast.findMatchedLeads(car, { limit: 50 });
        if (matched.length) blastLine = `\n📣 *${matched.length} matched lead(s)* — reply *BLAST ${car.id}* to send them this deal.`;
      } catch (e) {}
    }
    const photoHint = photoCount ? '' : `\n_Tip: run 🖼 Fetch web photos on ${car.id} in Inventory Studio._`;
    await _config.waSendText(from,
      `✅ *${car.id} LIVE for 15 days* (till ${car.deal.validTill})\n\n` +
      `${[car.year, car.make, car.model, car.variant].filter(Boolean).join(' ')}\n` +
      `${car.deal.headline}\n` +
      `📸 ${photoCount} web photo(s)${photoCount ? ' — AI picked the hero' : ' — ⚠️ none found'}${photoHint}\n\n` +
      `See it: https://www.vehyra.in/cars/${car.id}` + blastLine
    );
  } catch (e) {
    await _config.waSendText(from, `⚠️ Could not create the deal: ${e.message}. Try again or add it in Inventory Studio.`);
  }
}

/**
 * A deal admin's "new/demo + colours" text often arrives WHILE the photo batch is
 * still waiting — capture it as the batch caption so it isn't eaten by other flows.
 */
function captureDealText(from, text) {
  const batch = photoBatch.get(from);
  if (!batch) return false;
  if (!_isDealAdmin(from)) return false;
  const t = String(text || '').trim();
  if (!t) return false;
  // Anything typed while a batch is still collecting belongs to that car. It
  // used to accept only "new"/"demo", so a dealer typing "Price 19 lakh"
  // alongside a used car's photos fell through to the new-car quote engine and
  // got answered as if they were shopping. Commands still have to work.
  if (/^\s*(blast|prices?|price list|lead|new lead|stop|help|menu|hi|hello)\b\s*$/i.test(t)) return false;
  if (/^\s*(blast|lead|new lead)\b/i.test(t)) return false;
  batch.captions.push(t);
  console.log(`PhotoIngest: captured "${t.slice(0, 40)}" for pending batch from ${from}`);
  return true;
}

async function handleReply(from, msgText) {
  const pendingDeal = pendingPhotos.get(from);
  if (pendingDeal && pendingDeal.stage === 'AWAITING_DEAL_TYPE') {
    const parsed = _parseDealReply(msgText);
    if (!parsed) {
      await _config.waSendText(from, `Please reply starting with *NEW* or *DEMO*, then the colours.\nExample: _new Carbon Black, Night Dusk Blue_`);
      return true;
    }
    pendingPhotos.delete(from);
    await _createDealFromSheet(from, pendingDeal.sheet, parsed.dealType, parsed.colours);
    return true;
  }

  const pending = pendingPhotos.get(from);
  if (!pending || pending.stage !== 'AWAITING_CONFIRM') return false;

  _note(from, 'details', `reply for ${pending.id}`);

  // Parse dealer's reply to extract details
  // The listing text often arrives as the photo caption, with the dealer's reply
  // being little more than "yes". Read both together so nothing typed is lost.
  const detailSource = [pending.caption || '', msgText || ''].filter(Boolean).join('\n');
  const details = _parseDetails(detailSource, pending.analysis);

  // Build final car entry
  const entry = {
    id: pending.id,
    brand: details.brand || pending.analysis.brand || '',
    model: details.model || pending.analysis.model || '',
    year: details.year || pending.analysis.year || '',
    color: details.color || pending.analysis.color || '',
    fuel: details.fuel || pending.analysis.fuel || '',
    km: details.km || '',
    askingPrice: details.askingPrice || '',
    lastPrice: details.lastPrice || '',
    owner: details.owner || '',
    regCity: details.regCity || '',
    condition: pending.analysis.condition || '',
    photoId: pending.id,
    photoCount: pending.photoCount || 1,
    photoUrl: (pending.photos && pending.photos[0]) || pending.localPath || pending.photoUrl || '',
    dealerPhone: from,
    dealerName: pending.dealerName || '',
    addedAt: new Date().toISOString()
  };


  // Save to local inventory too (groupIngest)
  if (_config.addToInventory) {
    _config.addToInventory({
      source: 'dealer_photo',
      title: `${entry.year} ${entry.brand} ${entry.model}`.trim(),
      brand: entry.brand,
      model: entry.model,
      year: Number(entry.year) || 0,
      price: Number(String(entry.lastPrice).replace(/[^\d]/g, '')) || 0,
      km: Number(String(entry.km).replace(/[^\d]/g, '')) || 0,
      fuel: entry.fuel,
      color: entry.color,
      owners: entry.owner,
      city: entry.regCity,
      dealerPhone: from,
      dealerName: pending.dealerName,
      photoUrl: entry.photoUrl,
      carId: entry.id
    });
  }

  // Create a DRAFT inventory listing (photos + RC data + AI specs/features fill)
  let draftLine = '';
  let draftCar = null;
  if (_config.inventory) {
    try {
      const docs = pending.documentIndexes || [];
      draftCar = _config.inventory.createFromIngest({
        entry: { ...entry, variant: pending.analysis.variant || '' },
        photos: pending.photos || [],
        rc: pending.analysis.rc || null,
        documentIndexes: docs
      });
      draftLine = `\n📋 Draft listing *${draftCar.id}* created — specs & features being auto-filled. ` +
        `It is NOT on the website until it is published.\n`;
      if (docs.length) {
        draftLine += `🔒 ${docs.length} paperwork photo${docs.length > 1 ? 's' : ''} (RC etc.) saved but hidden — ` +
          `${docs.length > 1 ? 'they' : 'it'} will never show on the site, in the gallery or in a reel.\n`;
      } else if (pending.analysis.rc && pending.analysis.rc.regNumber) {
        draftLine += `⚠️ An RC was read from these photos but I could not tell which photo it is — ` +
          `check the gallery in Inventory Studio before publishing.\n`;
      }
      _note(from, 'created', `${draftCar.id} from ${entry.id}`);
    } catch (e) {
      // Silence here is how a dealer ends up believing a car is on the site when
      // nothing was ever written — a deploy unmounts the disk for a few seconds
      // and the listing simply never existed.
      _note(from, 'FAILED', e.message);
      draftLine = `\n⚠️ *The listing could not be created just now* — nothing has been saved to the site. ` +
        `Send the photos again in a minute.\n`;
    }
  }

  // Acknowledge
  await _config.waSendText(from,
    `*${entry.id}* — Saved!\n\n` +
    `${entry.year} ${entry.brand} ${entry.model}\n` +
    `KM: ${entry.km} | ${entry.fuel} | ${entry.owner}\n` +
    `Asking: ${entry.askingPrice} | Last: ${entry.lastPrice}\n` +
    draftLine +
    `\n_Something wrong? Reply *EDIT ${draftCar ? draftCar.id : entry.id} price 6.2 lakh* — also km, year, model, owner, colour._\n` +
    `\nThis car is now in our system. We'll contact you when a customer is interested.`
  );

  // The sheet is written AFTER the listing exists, so the row carries the
  // reference the dealer is given (MC-0009) and not just the intake batch id.
  await _pushToSheet({ ...entry, ref: draftCar ? draftCar.id : '', status: draftCar ? draftCar.status : 'not created' });

  // A draft never reaches the site on its own — offer the publish step right here
  // so an authorised uploader can put it live without opening Inventory Studio.
  if (draftCar && _isDealAdmin(from) && typeof _config.inventory.sendPublishPrompt === 'function') {
    try {
      await _config.inventory.sendPublishPrompt(from, draftCar);
    } catch (e) {
      console.warn('PhotoIngest: publish prompt failed', e.message);
    }
  }

  // Clean up
  pendingPhotos.delete(from);
  return true;
}

/**
 * Check if a dealer has a pending photo awaiting details.
 */
// True while a photo batch is still collecting — the window in which every
// extra photo would otherwise look like a brand new lead.
function isCollecting(from) { return photoBatch.has(from); }

function hasPending(from) {
  const p = pendingPhotos.get(from);
  return !!(p && (p.stage === 'AWAITING_CONFIRM' || p.stage === 'AWAITING_DEAL_TYPE'));
}

// ==================== INTERNAL ====================

async function _downloadMedia(mediaId) {
  if (!_config.META_TOKEN || !_config.fetch) return null;
  try {
    const resp = await _config.fetch(`https://graph.facebook.com/v21.0/${mediaId}`, {
      headers: { Authorization: `Bearer ${_config.META_TOKEN}` }
    });
    const data = await resp.json();
    if (!data.url) return null;

    // Download actual binary
    const fileResp = await _config.fetch(data.url, {
      headers: { Authorization: `Bearer ${_config.META_TOKEN}` }
    });
    if (!fileResp.ok) return null;

    // Convert to data URI for GPT
    const buffer = Buffer.from(await fileResp.arrayBuffer());
    const mime = data.mime_type || 'image/jpeg';
    return `data:${mime};base64,${buffer.toString('base64')}`;
  } catch (e) {
    console.warn('PhotoIngest: download failed', e.message);
    return null;
  }
}

async function _analyzeCarPhotos(photos, caption) {
  const result = { brand: '', model: '', variant: '', year: '', color: '', fuel: '', condition: '', rc: null, price_sheet: null };

  try {
    const images = (photos || []).slice(0, 6).map(url => ({ type: 'image_url', image_url: { url } }));
    const resp = await _config.openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are an assistant for an Indian car dealer. FIRST decide what the photos show:
- TYPE A: photos of a physical car (exterior/interior, possibly an RC card)
- TYPE B: a PRICE SHEET — a table/screenshot of costs (rows like Ex-Showroom, TCS, Insurance, Road Tax, ON ROAD)
If TYPE B, you MUST fill "price_sheet" and leave brand/model/variant/year/color/fuel/condition as EMPTY strings.
Return ONLY a JSON object:
{"brand":"","model":"","variant":"","year":"","color":"","fuel":"","condition":"","rc":{"regNumber":"","regYear":"","fuel":"","cc":"","regCity":"","expiry":""},"price_sheet":{"model":"","exShowroom":"","tcs":"","accessories":"","misc":"","insurance":"","roadTax":"","onRoad":"","regState":""}}
- TYPE A: brand/model (e.g. Hyundai / Creta); variant from badges/interior; year approximate; color; fuel if visible; condition = brief honest note; set price_sheet to null. rc ONLY if a photo is an RC card/registration document — regNumber (e.g. "DL8CAF5030"), regYear, fuel, cc, regCity, expiry; else rc null.
- TYPE B: price_sheet.model = the header text naming the car (e.g. "IX1 2026 lx1 lwb"); each amount as plain digits (no commas/₹); regState from the road-tax row (e.g. "CHANDIGARH/HP"); set rc to null.
Return ONLY the JSON, no other text.`
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: caption || 'Identify this car from the photos.' },
            ...images
          ]
        }
      ],
      temperature: 0,
      max_tokens: 500
    });

    const content = resp.choices?.[0]?.message?.content || '';
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      Object.assign(result, parsed);
      if (result.rc && !result.rc.regNumber) result.rc = null;
      if (result.price_sheet && !(Number(String(result.price_sheet.onRoad || '').replace(/[^\d]/g, '')) || Number(String(result.price_sheet.exShowroom || '').replace(/[^\d]/g, '')))) {
        result.price_sheet = null;
      }
    }
  } catch (e) {
    console.warn('PhotoIngest: GPT analysis failed', e.message);
  }

  return result;
}

function _parseDetails(text, analysis) {
  const t = (text || '').toLowerCase();
  const result = {
    brand: analysis.brand || '',
    model: analysis.model || '',
    year: analysis.year || '',
    color: analysis.color || '',
    fuel: analysis.fuel || '',
    km: '',
    askingPrice: '',
    lastPrice: '',
    owner: '',
    regCity: ''
  };

  // Year
  const yearMatch = t.match(/\b(20[0-2]\d)\b/);
  if (yearMatch) result.year = yearMatch[1];

  // KM first, so its digits can't be read as a price further down. Dealers write
  // it every way: "45000 km", "km 45,000", "60k km", "60k".
  let kmText = '';
  let km;
  // "RUN - 32000", "DRIVEN 45,000", "ODO 32000" — a dealer's own listing rarely
  // says km at all.
  const runMatch = t.match(/\b(?:run|driven|odo|odometer)\s*[-:]?\s*(\d[\d,]{3,})/i);
  if (runMatch) { result.km = runMatch[1].replace(/,/g, ''); kmText = runMatch[0]; }
  if (!result.km)
  if ((km = t.match(/(\d+(?:\.\d+)?)\s*(?:lakh|lac)\s*(?:km|kms)\b/i))) {
    // "1.2 lakh km" = 1,20,000 km — and taking it out here stops it being read
    // as a ₹1.2 lakh price.
    result.km = String(Math.round(Number(km[1]) * 100000)); kmText = km[0];
  } else if ((km = t.match(/(\d+(?:\.\d+)?)\s*k\s*(?:km|kms)\b/i))) {
    result.km = String(Math.round(Number(km[1]) * 1000)); kmText = km[0];
  } else if ((km = t.match(/(\d[\d,]*)\s*(?:km|kms|kilometers?|kilometres?)\b/i))) {
    result.km = km[1].replace(/,/g, ''); kmText = km[0];
  } else if ((km = t.match(/\bkms?\s*[:\-]?\s*(\d[\d,]{2,})(?!\s*(?:lakh|lac|l\b))/i))) {
    result.km = km[1].replace(/,/g, ''); kmText = km[0];
  } else if ((km = t.match(/(\d+(?:\.\d+)?)\s*k\b(?!\s*(?:m|lakh|lac))/i))) {
    result.km = String(Math.round(Number(km[1]) * 1000)); kmText = km[0];
  }

  // Prices. A LABEL beats position: "45000 km asking 6.5 lakh" used to read the
  // km figure as the LAST price, and _effectivePrice prefers the offer over the
  // asking price — so a ₹6.5 lakh car went live at ₹45,000.
  const priceText = kmText ? t.replace(kmText, ' ') : t;
  const norm = (num, unit) => {
    const n = Number(String(num || '').replace(/,/g, ''));
    if (!Number.isFinite(n) || n <= 0) return '';
    if (unit) return `${n} lakh`;
    // A used car is never ₹45,000. An unlabelled small number is not a price.
    return n >= 50000 ? String(Math.round(n)) : '';
  };
  const grab = re => { const m = priceText.match(re); return m ? norm(m[1], m[2]) : ''; };
  result.askingPrice = grab(/(?:asking|ask|price|demand|quoting|quote)\s*(?:is|:|-)?\s*([\d.,]+)\s*(lakh|lac|l\b)?/i);
  result.lastPrice = grab(/(?:last|best|final|bottom|net|lowest)\s*(?:price|offer)?\s*(?:is|:|-)?\s*([\d.,]+)\s*(lakh|lac|l\b)?/i);

  if (!result.askingPrice || !result.lastPrice) {
    // Nothing labelled — fall back to the order they were typed in, still
    // ignoring anything too small to be a car price.
    const found = [];
    const lakhRe = /([\d.,]+)\s*(lakh|lac|l\b)/gi;
    let pm;
    while ((pm = lakhRe.exec(priceText)) !== null) {
      const v = norm(pm[1], pm[2]);
      if (v && !found.includes(v)) found.push(v);
    }
    if (!found.length) {
      (priceText.match(/\b\d{5,8}\b/g) || []).forEach(n => {
        const v = norm(n, null);
        if (v && !found.includes(v)) found.push(v);
      });
    }
    const spare = found.filter(v => v !== result.askingPrice && v !== result.lastPrice);
    if (!result.askingPrice) result.askingPrice = spare.shift() || '';
    if (!result.lastPrice) result.lastPrice = spare.shift() || '';
  }

  // "₹1,350,000.00" is how a forwarded listing states the price; the old reader
  // only understood "6.5 lakh" or a bare run of digits.
  if (!result.askingPrice) {
    const rupee = priceText.match(/₹\s*(\d[\d,]*(?:\.\d+)?)/);
    const grouped = priceText.match(/\b(\d{1,3}(?:,\d{2,3})+(?:\.\d+)?)\b/);
    const pick = (rupee && rupee[1]) || (grouped && grouped[1]);
    if (pick) {
      const n = Math.round(Number(String(pick).replace(/,/g, '')) || 0);
      if (n >= 50000) result.askingPrice = String(n);
    }
  }

  // The best offer can't be above the asking price — if they came out that way
  // round, the labels were guessed wrong.
  const toNum = v => {
    const n = parseFloat(String(v).replace(/[^\d.]/g, '')) || 0;
    return /lakh|lac|l/.test(String(v)) ? n * 100000 : n;
  };
  if (result.askingPrice && result.lastPrice && toNum(result.lastPrice) > toNum(result.askingPrice)) {
    const swap = result.askingPrice; result.askingPrice = result.lastPrice; result.lastPrice = swap;
  }

  // Owner
  if (/\b(1st|first|single)\s*owner/i.test(t)) result.owner = '1st Owner';
  else if (/\b(2nd|second)\s*owner/i.test(t)) result.owner = '2nd Owner';
  else if (/\b(3rd|third)\s*owner/i.test(t)) result.owner = '3rd Owner';
  else {
    const ownerNum = t.match(/(\d)\s*(?:owner|own)/i);
    if (ownerNum) result.owner = ownerNum[1] + ' Owner';
  }

  // Fuel (if not from analysis)
  if (!result.fuel) {
    if (/\b(diesel|dsl)\b/i.test(t)) result.fuel = 'Diesel';
    else if (/\b(petrol|pet)\b/i.test(t)) result.fuel = 'Petrol';
    else if (/\b(cng)\b/i.test(t)) result.fuel = 'CNG';
    else if (/\b(electric|ev)\b/i.test(t)) result.fuel = 'Electric';
    else if (/\b(hybrid)\b/i.test(t)) result.fuel = 'Hybrid';
  }

  // Registration city
  const cities = ['delhi', 'mumbai', 'bangalore', 'hyderabad', 'chennai', 'pune', 'kolkata', 'noida', 'gurgaon', 'jaipur', 'lucknow', 'chandigarh', 'ahmedabad', 'indore', 'bhopal'];
  for (const c of cities) {
    if (t.includes(c)) { result.regCity = c.charAt(0).toUpperCase() + c.slice(1); break; }
  }

  // "DL REG", "HR-26", "UP 16" — the state code is how a listing states it.
  if (!result.regCity) {
    const codes = { dl: 'Delhi', hr: 'Haryana', up: 'Uttar Pradesh', pb: 'Punjab', rj: 'Rajasthan',
      mh: 'Maharashtra', ka: 'Karnataka', ch: 'Chandigarh', hp: 'Himachal Pradesh', uk: 'Uttarakhand', ga: 'Goa' };
    // "HR26 REG" has no boundary between the letters and the digits, so the old
    // pattern only caught "HR REG".
    const cm = t.match(/\b(dl|hr|up|pb|rj|mh|ka|ch|hp|uk|ga)\s?-?\s?\d{1,2}\b/i)
      || t.match(/\b(dl|hr|up|pb|rj|mh|ka|ch|hp|uk|ga)\b\s*(?:reg|registration|number|no)/i);
    if (cm) result.regCity = codes[cm[1].toLowerCase()];
  }

  // Gearbox, stated as a trim suffix more often than as a field
  const tm = t.match(/\b(cvt|amt|dct|dsg|automatic|manual|at|mt)\b/i);
  if (tm) {
    const g = tm[1].toLowerCase();
    result.transmission = g === 'mt' || g === 'manual' ? 'Manual'
      : g === 'at' || g === 'automatic' ? 'Automatic' : g.toUpperCase();
  }

  // Everything a buyer asks about that has nowhere else to go
  const extras = [];
  if (/service record|service history/i.test(t)) extras.push('Service record available');
  if (/both key|2 key|two key/i.test(t)) extras.push('Both keys available');
  if (/insured till ([a-z]+ \d{4})|insurance till ([a-z]+ \d{4})/i.test(t)) {
    const im = t.match(/(?:insured|insurance)\s*(?:till|valid till|upto|up to)\s*([a-z]+\s*\d{4})/i);
    if (im) extras.push(`Insured till ${im[1].replace(/\s+/g, ' ').trim()}`);
  }
  if (/less driven|low driven|kam chala/i.test(t)) extras.push('Low mileage for the year');
  const mfg = t.match(/manufactur\w*\s*[-:]?\s*(\d{1,2})\s*[\/-]\s*(20\d\d)/i);
  if (mfg) extras.push(`Manufactured ${mfg[1]}/${mfg[2]}`);
  const lastDigits = t.match(/last\s*(?:4\s*)?digits?\s*[-:]?\s*(\d{4})/i);
  if (lastDigits) extras.push(`Reg ends ${lastDigits[1]}`);
  if (extras.length) result.notes = extras.join('\n');

  // Brand/model override from text (dealer correcting GPT)
  const brands = ['toyota', 'hyundai', 'mahindra', 'maruti', 'tata', 'kia', 'honda', 'bmw', 'mercedes', 'audi', 'mg', 'skoda', 'volkswagen', 'volvo', 'jeep',
    'land rover', 'range rover', 'jaguar', 'porsche', 'lexus', 'nissan', 'renault', 'ford', 'citroen', 'mini'];
  for (const b of brands) {
    if (t.includes(b)) { result.brand = b.charAt(0).toUpperCase() + b.slice(1); break; }
  }

  // The sheet-built registry is the better source, but it is only populated once
  // pricing has loaded — this covers the stock a Delhi dealer actually forwards.
  const MODEL_BRAND = {
    creta: 'Hyundai', venue: 'Hyundai', verna: 'Hyundai', i20: 'Hyundai', exter: 'Hyundai',
    alcazar: 'Hyundai', tucson: 'Hyundai', seltos: 'Kia', sonet: 'Kia', carens: 'Kia',
    carnival: 'Kia', syros: 'Kia', nexon: 'Tata', punch: 'Tata', harrier: 'Tata',
    safari: 'Tata', altroz: 'Tata', tiago: 'Tata', tigor: 'Tata', curvv: 'Tata',
    brezza: 'Maruti', baleno: 'Maruti', swift: 'Maruti', dzire: 'Maruti', ertiga: 'Maruti',
    xl6: 'Maruti', fronx: 'Maruti', jimny: 'Maruti', ciaz: 'Maruti', 'grand vitara': 'Maruti',
    hector: 'MG', astor: 'MG', gloster: 'MG', comet: 'MG', 'zs ev': 'MG',
    thar: 'Mahindra', xuv700: 'Mahindra', xuv300: 'Mahindra', xuv400: 'Mahindra',
    scorpio: 'Mahindra', bolero: 'Mahindra', marazzo: 'Mahindra',
    fortuner: 'Toyota', innova: 'Toyota', hycross: 'Toyota', crysta: 'Toyota',
    glanza: 'Toyota', taisor: 'Toyota', hyryder: 'Toyota', rumion: 'Toyota',
    city: 'Honda', amaze: 'Honda', elevate: 'Honda', wrv: 'Honda',
    kushaq: 'Skoda', slavia: 'Skoda', kodiaq: 'Skoda', taigun: 'Volkswagen',
    virtus: 'Volkswagen', tiguan: 'Volkswagen', kiger: 'Renault', triber: 'Renault',
    magnite: 'Nissan', compass: 'Jeep', meridian: 'Jeep', wrangler: 'Jeep',
    evoque: 'Land Rover', velar: 'Land Rover', defender: 'Land Rover',
    discovery: 'Land Rover',
    cayenne: 'Porsche', macan: 'Porsche', 'f-pace': 'Jaguar',
    glc: 'Mercedes-Benz', gle: 'Mercedes-Benz', gla: 'Mercedes-Benz',
    q3: 'Audi', q5: 'Audi', q7: 'Audi', x1: 'BMW', x3: 'BMW', x5: 'BMW',
    ecosport: 'Ford', endeavour: 'Ford', hector: 'MG'
  };
  // A named model in the dealer's own text beats the photo guess. Vision read an
  // MG Hector as an Astor — they are near-identical from the front — and the
  // listing said HECTOR in capitals three times.
  // Earliest mention wins, not whichever key the table happens to list first —
  // "RANGE ROVER EVOQUE 2020 ... DELHI CITY" came back as a Honda City because
  // 'city' sat higher in the table than 'evoque'.
  let best = null;
  for (const [mdl, brand] of Object.entries(MODEL_BRAND)) {
    const m = new RegExp(`\\b${mdl}\\b`, 'i').exec(t);
    if (!m) continue;
    // A longer name at the same spot is the more specific one.
    if (!best || m.index < best.index || (m.index === best.index && mdl.length > best.mdl.length)) {
      best = { mdl, brand, index: m.index };
    }
  }
  if (best) {
    result.model = best.mdl.replace(/\b\w/g, c => c.toUpperCase());
    if (!result.brand || result.brand.toLowerCase() !== best.brand.toLowerCase()) result.brand = best.brand;
  }

  // A dealer usually writes the model, not the make — "Creta 2021 SX(O)" never
  // says Hyundai. The bot's own model registry knows which brand that is.
  if (!result.brand || !result.model) {
    try {
      const brands = require('./brands.cjs');
      const found = typeof brands.detectModelsFromText === 'function' ? brands.detectModelsFromText(text) : null;
      const first = Array.isArray(found) ? found[0] : found;
      const mdl = first && (first.model || first);
      if (mdl) {
        if (!result.model) result.model = String(mdl).replace(/\b\w/g, c => c.toUpperCase());
        const owner = (brands.GLOBAL_MODEL_BRAND && brands.GLOBAL_MODEL_BRAND[String(mdl).toLowerCase()])
          || (first && first.brand);
        if (!result.brand && owner) result.brand = String(owner).replace(/\b\w/g, c => c.toUpperCase());
      }
    } catch (e) {}
  }

  // With no photos there is no vision result to fall back on, so read the model
  // and trim off the listing itself: "MG HECTOR 2023" then "SHARP PRO CVT".
  if (result.brand) {
    const lines = String(text || '').split(/\n+/).map(l => l.trim()).filter(Boolean);
    const brandRe = new RegExp(`\\b${result.brand}\\b`, 'i');
    const brandLine = lines.find(l => brandRe.test(l));
    if (brandLine && !result.model) {
      const after = brandLine.replace(brandRe, ' ').replace(/\b20\d\d\b/g, ' ').replace(/[^A-Za-z0-9 -]/g, ' ').trim();
      const word = after.split(/\s+/).filter(Boolean)[0];
      if (word && word.length > 2) result.model = word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    }
    if (brandLine && !result.variant) {
      const idx = lines.indexOf(brandLine);
      for (const l of lines.slice(idx + 1, idx + 4)) {
        const clean = l.replace(/[^A-Za-z0-9 ()-]/g, '').trim();
        const words = clean.split(/\s+/).filter(Boolean);
        if (!words.length || words.length > 4) continue;
        if (/^\d/.test(clean) || /\b(owner|petrol|diesel|cng|run|reg|month|km)\b/i.test(clean)) continue;
        // A listing repeats "HECTOR 2023" under the title — that is the model
        // again, not the trim.
        if (/\b20\d\d\b/.test(clean)) continue;
        if (result.model && new RegExp(`\\b${result.model}\\b`, 'i').test(clean)) continue;
        result.variant = clean.replace(/\b\w/g, c => c.toUpperCase());
        break;
      }
    }
  }

  return result;
}

async function _pushToSheet(entry) {
  const webhookUrl = (process.env.INVENTORY_SHEET_WEBHOOK_URL || process.env.GOOGLE_SHEET_WEBHOOK_URL || _config.INVENTORY_SHEET_WEBHOOK_URL || '').trim();
  if (!webhookUrl) {
    console.warn('PhotoIngest: INVENTORY_SHEET_WEBHOOK_URL not set, skipping sheet push');
    return;
  }

  try {
    const resp = await _config.fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        // The listing's own number — what the dealer is told, what EDIT and
        // PUBLISH take, and what the website URL ends with.
        ref: entry.ref || '',
        refNo: entry.ref || '',
        status: entry.status || '',
        id: entry.id,
        brand: entry.brand,
        model: entry.model,
        year: entry.year,
        color: entry.color,
        fuel: entry.fuel,
        km: entry.km,
        askingPrice: entry.askingPrice,
        lastPrice: entry.lastPrice,
        owner: entry.owner,
        regCity: entry.regCity,
        condition: entry.condition,
        photoUrl: entry.photoUrl,
        dealerPhone: entry.dealerPhone,
        dealerName: entry.dealerName,
        addedAt: entry.addedAt
      })
    });

    if (resp.ok) {
      console.log(`PhotoIngest: pushed ${entry.ref || entry.id} to sheet`);
    } else {
      console.warn('PhotoIngest: sheet push failed', resp.status);
    }
  } catch (e) {
    console.warn('PhotoIngest: sheet push error', e.message);
  }
}

module.exports = {
  init, handlePhoto, handleReply, hasPending, isCollecting, captureDealText, intakeState,
  // Exported for testing only
  _findDocumentPhotos, _parseDetails
};
