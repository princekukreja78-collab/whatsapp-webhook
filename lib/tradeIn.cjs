// lib/tradeIn.cjs — Trade-in calculator with T&C
// Estimates old car value and shows net cost for new car.
// Always displays terms and conditions.

let _config = {};

function init(config) {
  _config = config;
}

// ==================== DEPRECIATION MODEL ====================
// Indian market depreciation rates (approximate)
const DEPRECIATION = {
  1: 0.15,  // Year 1: 15% drop
  2: 0.12,  // Year 2: 12%
  3: 0.10,  // Year 3: 10%
  4: 0.09,  // Year 4: 9%
  5: 0.08,  // Year 5: 8%
  6: 0.07,
  7: 0.06,
  8: 0.05,
  9: 0.05,
  10: 0.04,
};

// Base ex-showroom prices for common models (in INR, approximate mid-variant)
const BASE_PRICES = {
  // Maruti
  swift: 700000, baleno: 750000, dzire: 750000, brezza: 1050000, ertiga: 900000,
  'grand vitara': 1200000, fronx: 850000, jimny: 1350000, alto: 400000, 'wagon r': 550000,
  ciaz: 1000000,
  // Hyundai
  creta: 1200000, venue: 850000, verna: 1100000, i20: 800000, tucson: 2800000,
  alcazar: 1750000, exter: 650000, aura: 700000,
  // Tata
  nexon: 900000, harrier: 1600000, safari: 1700000, punch: 650000, altroz: 700000,
  curvv: 1200000, tiago: 550000,
  // Mahindra
  thar: 1500000, xuv700: 1500000, scorpio: 1400000, bolero: 1000000,
  'xuv 3xo': 900000, xuv400: 1600000,
  // Toyota
  fortuner: 3500000, innova: 2000000, hycross: 2200000, glanza: 700000, camry: 4500000,
  hilux: 3200000, urban: 1100000,
  // Kia
  seltos: 1150000, sonet: 850000, carens: 1100000, carnival: 3300000,
  // Honda
  city: 1200000, amaze: 800000, elevate: 1200000,
  // Skoda / VW
  kushaq: 1200000, slavia: 1200000, taigun: 1250000, virtus: 1250000,
  octavia: 2800000, superb: 3500000, tiguan: 3500000,
  // MG
  hector: 1500000, astor: 1100000, gloster: 3800000,
  // Premium
  'c class': 5500000, 'e class': 7500000, gla: 4500000, glc: 6500000, gle: 9000000,
  '3 series': 5000000, '5 series': 7000000, x1: 4500000, x3: 6500000, x5: 9500000,
  q3: 4500000, q5: 6500000, q7: 8500000, a4: 4500000, a6: 6500000,
  xc40: 4500000, xc60: 6500000, xc90: 9000000,
  compass: 2200000, meridian: 3500000, wrangler: 6500000,
  'range rover': 15000000, defender: 10000000, discovery: 8000000,
  cayenne: 12000000, macan: 8500000,
  fortuner: 3500000,
};

// KM adjustment factor
function _kmAdjustment(km, age) {
  const expectedKm = age * 12000; // 12K km/year average
  if (!km) return 0;
  const diff = km - expectedKm;
  if (diff > 20000) return -0.05;  // High KM: -5%
  if (diff > 10000) return -0.03;
  if (diff < -10000) return 0.03;  // Low KM: +3%
  if (diff < -20000) return 0.05;
  return 0;
}

// Owner adjustment
function _ownerAdjustment(owners) {
  const o = (owners || '').toLowerCase();
  if (o.includes('1st') || o.includes('first') || o === '1') return 0.03;
  if (o.includes('2nd') || o.includes('second') || o === '2') return 0;
  if (o.includes('3rd') || o.includes('third') || o === '3') return -0.05;
  return -0.08; // 4+ owners
}

/**
 * Estimate trade-in value for a car.
 * @param {Object} car - { model, year, km, fuel, owners, color }
 * @returns {{ lowEstimate, highEstimate, midEstimate, age, basePrice }}
 */
function estimateValue(car) {
  const model = (car.model || '').toLowerCase().trim();
  const year = Number(car.year) || new Date().getFullYear() - 3;
  const km = Number(car.km) || 0;
  const now = new Date().getFullYear();
  const age = Math.max(0, now - year);

  // Find base price
  let basePrice = BASE_PRICES[model] || 0;
  if (!basePrice) {
    // Try partial match
    for (const [key, val] of Object.entries(BASE_PRICES)) {
      if (model.includes(key) || key.includes(model)) {
        basePrice = val;
        break;
      }
    }
  }
  if (!basePrice) basePrice = 800000; // default fallback

  // Apply depreciation year by year
  let currentValue = basePrice;
  for (let y = 1; y <= Math.min(age, 15); y++) {
    const rate = DEPRECIATION[y] || 0.04;
    currentValue *= (1 - rate);
  }

  // Adjustments
  const kmAdj = _kmAdjustment(km, age);
  const ownerAdj = _ownerAdjustment(car.owners);
  currentValue *= (1 + kmAdj + ownerAdj);

  // Diesel premium (holds value better)
  if ((car.fuel || '').toLowerCase().includes('diesel')) {
    currentValue *= 1.05;
  }

  const midEstimate = Math.round(currentValue);
  const lowEstimate = Math.round(midEstimate * 0.90);
  const highEstimate = Math.round(midEstimate * 1.10);

  return { lowEstimate, highEstimate, midEstimate, age, basePrice };
}

/**
 * Format trade-in offer for WhatsApp.
 */
function formatTradeInOffer(oldCar, newCarModel, newCarPrice) {
  const val = estimateValue(oldCar);
  const oldModel = (oldCar.model || 'your car').replace(/^\w/, c => c.toUpperCase());
  const yearStr = oldCar.year || '';

  let msg = `*Trade-In Estimate — ${yearStr} ${oldModel}*\n\n`;
  msg += `Estimated Value: *${_fmtPrice(val.lowEstimate)} — ${_fmtPrice(val.highEstimate)}*\n`;

  if (oldCar.km) msg += `KM: ${oldCar.km.toLocaleString('en-IN')} | `;
  if (oldCar.owners) msg += `Owner: ${oldCar.owners} | `;
  if (oldCar.fuel) msg += `${oldCar.fuel}`;
  msg += `\n`;

  if (newCarModel && newCarPrice) {
    const netCost = Math.max(0, newCarPrice - val.midEstimate);
    msg += `\n*New ${newCarModel}:* ${_fmtPrice(newCarPrice)}`;
    msg += `\n*Your trade-in:* -${_fmtPrice(val.midEstimate)}`;
    msg += `\n*You pay:* *${_fmtPrice(netCost)}*\n`;
  }

  msg += `\n---\n`;
  msg += `*Terms & Conditions:*\n`;
  msg += `1. Final price subject to physical inspection at our center\n`;
  msg += `2. Estimate valid for 7 days from date of this message\n`;
  msg += `3. Vehicle must have valid RC, insurance & no pending challans\n`;
  msg += `4. No flood-damaged, accident-repaired (structural), or hypothecated vehicles\n`;
  msg += `5. Odometer must be original and untampered\n`;
  msg += `6. Final offer may vary by ±15% based on physical condition\n`;
  msg += `7. Trade-in value applied only against purchase of a new/used car from MR. CAR\n`;
  msg += `\n_This is an indicative estimate. MR. CAR reserves the right to revise the offer after inspection._`;

  return msg;
}

/**
 * Parse trade-in request from customer text.
 * e.g., "trade in creta 2020 40000 km" or "exchange my swift 2019"
 */
function parseTradeInRequest(text) {
  const t = (text || '').toLowerCase().trim();
  if (!/\b(trade|exchange|tukar|sell my|apni gaadi|meri gaadi|old car)\b/i.test(t)) return null;

  const result = { model: '', year: 0, km: 0, fuel: '', owners: '' };

  // Year
  const yearMatch = t.match(/\b(20[0-2]\d)\b/);
  if (yearMatch) result.year = Number(yearMatch[1]);

  // KM
  const kmMatch = t.match(/(\d[\d,]*)\s*(?:km|kms)/i);
  const kmShort = t.match(/(\d+)\s*k\s*km/i);
  if (kmMatch) result.km = Number(kmMatch[1].replace(/,/g, ''));
  else if (kmShort) result.km = Number(kmShort[1]) * 1000;

  // Fuel
  if (/diesel/i.test(t)) result.fuel = 'Diesel';
  else if (/petrol/i.test(t)) result.fuel = 'Petrol';
  else if (/cng/i.test(t)) result.fuel = 'CNG';

  // Owner
  if (/\b(1st|first)\s*owner/i.test(t)) result.owners = '1st Owner';
  else if (/\b(2nd|second)\s*owner/i.test(t)) result.owners = '2nd Owner';

  // Model — remove noise words and extract
  let cleaned = t
    .replace(/\b(trade|exchange|tukar|sell|my|car|old|apni|meri|gaadi|in|for|want to|please|km|kms|diesel|petrol|cng|owner|1st|2nd|first|second)\b/gi, '')
    .replace(/\b20[0-2]\d\b/g, '')
    .replace(/\d+/g, '')
    .replace(/[-,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (cleaned.length >= 2) result.model = cleaned;

  return result.model ? result : null;
}

/**
 * Parse car details without requiring "trade/exchange" keyword.
 * Used when customer is already in TRADE_IN context.
 * e.g., "Seltos diesel 2020" or "Creta 2021 45000 km"
 */
function parseCarDetails(text) {
  const t = (text || '').toLowerCase().trim();
  if (t.length < 3) return null;

  const result = { model: '', year: 0, km: 0, fuel: '', owners: '' };

  // Year
  const yearMatch = t.match(/\b(20[0-2]\d)\b/);
  if (yearMatch) result.year = Number(yearMatch[1]);

  // KM
  const kmMatch = t.match(/(\d[\d,]*)\s*(?:km|kms)/i);
  const kmShort = t.match(/(\d+)\s*k\s*km/i);
  if (kmMatch) result.km = Number(kmMatch[1].replace(/,/g, ''));
  else if (kmShort) result.km = Number(kmShort[1]) * 1000;

  // Fuel
  if (/\bdiesel\b/i.test(t)) result.fuel = 'Diesel';
  else if (/\bpetrol\b/i.test(t)) result.fuel = 'Petrol';
  else if (/\bcng\b/i.test(t)) result.fuel = 'CNG';
  else if (/\bhybrid\b/i.test(t)) result.fuel = 'Hybrid';
  else if (/\belectric\b|\bev\b/i.test(t)) result.fuel = 'Electric';

  // Owner
  if (/\b(1st|first)\s*owner/i.test(t)) result.owners = '1st Owner';
  else if (/\b(2nd|second)\s*owner/i.test(t)) result.owners = '2nd Owner';
  else if (/\b(3rd|third)\s*owner/i.test(t)) result.owners = '3rd Owner';

  // Model — remove noise words
  let cleaned = t
    .replace(/\b(car|my|old|for|please|km|kms|diesel|petrol|cng|hybrid|electric|ev|owner|1st|2nd|3rd|first|second|third)\b/gi, '')
    .replace(/\b20[0-2]\d\b/g, '')
    .replace(/\d+/g, '')
    .replace(/[-,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (cleaned.length >= 2) result.model = cleaned;

  return result.model ? result : null;
}

function _fmtPrice(p) {
  if (!p || p <= 0) return '₹0';
  if (p >= 10000000) return `₹${(p / 10000000).toFixed(2)} Cr`;
  if (p >= 100000) return `₹${(p / 100000).toFixed(1)}L`;
  return `₹${p.toLocaleString('en-IN')}`;
}

module.exports = {
  init,
  estimateValue,
  parseCarDetails,
  formatTradeInOffer,
  parseTradeInRequest,
  BASE_PRICES
};
