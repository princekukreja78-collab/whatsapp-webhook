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

const BATCH_WAIT_MS = 15000; // Wait 15 seconds for more photos before analyzing

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

  console.log(`PhotoIngest: photo ${batch.photos.length} from ${from} (batch ${batch.carId})`);

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

  console.log(`PhotoIngest: processing batch of ${batch.photos.length} photos from ${from}`);

  // Analyze only the first photo with GPT (best quality, usually front/exterior)
  const analysis = await _analyzeCarPhoto(batch.photos[0], batch.captions.join(' '));

  // Store as pending
  pendingPhotos.set(from, {
    id: batch.carId,
    analysis,
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
  if (analysis.year) msg += `Year: *~${analysis.year}*\n`;
  if (analysis.color) msg += `Color: *${analysis.color}*\n`;
  if (analysis.fuel) msg += `Fuel: *${analysis.fuel}*\n`;
  if (analysis.condition) msg += `Condition: ${analysis.condition}\n`;
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
async function handleReply(from, msgText) {
  const pending = pendingPhotos.get(from);
  if (!pending || pending.stage !== 'AWAITING_CONFIRM') return false;

  console.log(`PhotoIngest: dealer ${from} replied with details for ${pending.id}`);

  // Parse dealer's reply to extract details
  const details = _parseDetails(msgText, pending.analysis);

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

  // Save to Google Sheet
  await _pushToSheet(entry);

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

  // Acknowledge
  await _config.waSendText(from,
    `*${entry.id}* — Saved!\n\n` +
    `${entry.year} ${entry.brand} ${entry.model}\n` +
    `KM: ${entry.km} | ${entry.fuel} | ${entry.owner}\n` +
    `Asking: ${entry.askingPrice} | Last: ${entry.lastPrice}\n\n` +
    `This car is now in our system. We'll contact you when a customer is interested.`
  );

  // Clean up
  pendingPhotos.delete(from);
  return true;
}

/**
 * Check if a dealer has a pending photo awaiting details.
 */
function hasPending(from) {
  const p = pendingPhotos.get(from);
  return p && p.stage === 'AWAITING_CONFIRM';
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

async function _analyzeCarPhoto(imageUrl, caption) {
  const result = { brand: '', model: '', year: '', color: '', fuel: '', condition: '' };

  try {
    const resp = await _config.openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are a car identification expert. Analyze the car photo and return ONLY a JSON object with these fields:
{"brand":"","model":"","year":"","color":"","fuel":"","condition":""}
- brand: manufacturer (Toyota, Hyundai, etc.)
- model: specific model (Fortuner, Creta, etc.)
- year: approximate year (e.g., "2021" or "2020-2022")
- color: body color
- fuel: if visible (Diesel/Petrol/EV) or empty
- condition: brief note (e.g., "Well maintained", "Minor scratches on bumper")
Return ONLY the JSON, no other text.`
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: caption || 'Identify this car.' },
            { type: 'image_url', image_url: { url: imageUrl } }
          ]
        }
      ],
      temperature: 0,
      max_tokens: 200
    });

    const content = resp.choices?.[0]?.message?.content || '';
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      Object.assign(result, parsed);
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

  // KM
  const kmMatch = t.match(/(\d[\d,]*)\s*(?:km|kms)/i);
  if (kmMatch) result.km = kmMatch[1].replace(/,/g, '');
  else {
    const kmShort = t.match(/(\d+)\s*k\b/i);
    if (kmShort) result.km = String(Number(kmShort[1]) * 1000);
  }

  // Prices
  const prices = [];
  const priceRegex = /([\d.]+)\s*(?:l|lakh|lac)/gi;
  let m;
  while ((m = priceRegex.exec(t)) !== null) {
    prices.push(m[0].trim());
  }
  // Raw large numbers
  const rawNums = t.match(/\b(\d{5,8})\b/g);
  if (rawNums) rawNums.forEach(n => prices.push(n));

  if (prices.length >= 2) {
    result.askingPrice = prices[0];
    result.lastPrice = prices[1];
  } else if (prices.length === 1) {
    // Check if "asking" or "last" is mentioned
    if (/\b(last|best|final|bottom)\b/.test(t)) result.lastPrice = prices[0];
    else result.askingPrice = prices[0];
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

  // Brand/model override from text (dealer correcting GPT)
  const brands = ['toyota', 'hyundai', 'mahindra', 'maruti', 'tata', 'kia', 'honda', 'bmw', 'mercedes', 'audi', 'mg', 'skoda', 'volkswagen', 'volvo', 'jeep'];
  for (const b of brands) {
    if (t.includes(b)) { result.brand = b.charAt(0).toUpperCase() + b.slice(1); break; }
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
      console.log(`PhotoIngest: pushed ${entry.id} to sheet`);
    } else {
      console.warn('PhotoIngest: sheet push failed', resp.status);
    }
  } catch (e) {
    console.warn('PhotoIngest: sheet push error', e.message);
  }
}

module.exports = { init, handlePhoto, handleReply, hasPending };
