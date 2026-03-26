// lib/carSearch.cjs — Unified used car search across all sources
// Queries CarWale + CarDekho + OLX (+ your dealer sheet) in parallel,
// deduplicates, scores deals, and returns ranked results.

const carwale = require('./scrapers/carwale.cjs');
const cardekho = require('./scrapers/cardekho.cjs');
const olx = require('./scrapers/olx.cjs');

let _config = {};

// Cache: key = "model|city|budget" → { results, ts }
const _cache = new Map();
const CACHE_TTL = 15 * 60 * 1000; // 15 minutes

function init(config) {
  _config = config;
  carwale.init({ fetch: config.fetch });
  cardekho.init({ fetch: config.fetch });
  olx.init({ fetch: config.fetch });
}

/**
 * Unified search across all platforms
 * @param {Object} query
 *   - model: "creta" (required)
 *   - brand: "hyundai" (optional, auto-detected)
 *   - city: "delhi" (default)
 *   - minBudget: 5 (lakhs, optional)
 *   - maxBudget: 15 (lakhs, optional)
 *   - limit: 5 (max results to return)
 * @returns {{ results: Array, stats: Object }}
 */
async function search(query = {}) {
  const model = (query.model || '').trim().toLowerCase();
  if (!model) return { results: [], stats: { total: 0 } };

  const city = (query.city || 'delhi').trim().toLowerCase();
  const minBudget = query.minBudget || 0;
  const maxBudget = query.maxBudget || 999;
  const limit = query.limit || 5;

  // Check cache
  const cacheKey = `${model}|${city}|${minBudget}-${maxBudget}`;
  const cached = _cache.get(cacheKey);
  if (cached && (Date.now() - cached.ts < CACHE_TTL)) {
    return { results: cached.results.slice(0, limit), stats: cached.stats };
  }

  // Auto-detect brand from common models
  const brand = query.brand || _detectBrand(model);

  const opts = { model, brand, city, minBudget, maxBudget, pages: 1 };

  // Query all sources in parallel
  const [cwResults, cdResults, olxResults, dealerResults] = await Promise.allSettled([
    carwale.search(opts),
    cardekho.search(opts),
    olx.search(opts),
    _searchDealerSheet(opts)
  ]);

  let all = [];
  const sourceCount = {};

  for (const [name, result] of [
    ['carwale', cwResults],
    ['cardekho', cdResults],
    ['olx', olxResults],
    ['dealer', dealerResults]
  ]) {
    if (result.status === 'fulfilled' && Array.isArray(result.value)) {
      sourceCount[name] = result.value.length;
      all.push(...result.value);
    } else {
      sourceCount[name] = 0;
    }
  }

  // Filter by budget
  if (minBudget > 0 || maxBudget < 999) {
    const minPrice = minBudget * 100000;
    const maxPrice = maxBudget * 100000;
    all = all.filter(c => c.price >= minPrice && c.price <= maxPrice);
  }

  // Deduplicate (same VIN or very similar title+price)
  all = _deduplicate(all);

  // Calculate market average for deal scoring
  const avgPrice = all.length > 0
    ? all.reduce((s, c) => s + c.price, 0) / all.length
    : 0;

  // Score and rank
  all = all.map(c => ({
    ...c,
    dealScore: _scoreDeal(c, avgPrice),
    priceFormatted: _fmtPrice(c.price),
    kmFormatted: _fmtKm(c.km)
  }));

  // Sort: best deals first (highest score)
  all.sort((a, b) => b.dealScore - a.dealScore);

  const stats = {
    total: all.length,
    sources: sourceCount,
    avgPrice: Math.round(avgPrice),
    avgPriceFormatted: _fmtPrice(avgPrice)
  };

  // Cache
  _cache.set(cacheKey, { results: all, stats, ts: Date.now() });

  return { results: all.slice(0, limit), stats };
}

// ==================== DEAL SCORING ====================

function _scoreDeal(car, avgPrice) {
  let score = 50; // base

  // Price vs average: lower = better
  if (avgPrice > 0 && car.price > 0) {
    const pctDiff = ((avgPrice - car.price) / avgPrice) * 100;
    score += Math.min(pctDiff * 2, 30); // up to +30 for being below avg
  }

  // Low km bonus
  if (car.km > 0 && car.km < 20000) score += 15;
  else if (car.km < 40000) score += 10;
  else if (car.km < 60000) score += 5;
  else if (car.km > 100000) score -= 10;

  // First owner bonus
  const owners = (car.owners || '').toLowerCase();
  if (owners.includes('first') || owners.includes('1st')) score += 10;
  else if (owners.includes('second') || owners.includes('2nd')) score += 5;
  else if (owners.includes('third') || owners.includes('3rd')) score -= 5;

  // Recent year bonus
  const age = new Date().getFullYear() - (car.year || 2020);
  if (age <= 2) score += 10;
  else if (age <= 4) score += 5;
  else if (age > 7) score -= 5;

  // Dealer network bonus (your own inventory)
  if (car.source === 'dealer') score += 8;

  return Math.round(Math.max(0, Math.min(100, score)));
}

function _dealTag(score) {
  if (score >= 75) return 'GREAT DEAL';
  if (score >= 60) return 'GOOD DEAL';
  if (score >= 45) return 'FAIR';
  return 'ABOVE MARKET';
}

// ==================== HELPERS ====================

function _deduplicate(cars) {
  const seen = new Set();
  return cars.filter(c => {
    // Dedup by VIN if available
    if (c.vin && c.vin !== '0' && c.vin.length > 5) {
      const vinKey = c.vin.toLowerCase();
      if (seen.has(vinKey)) return false;
      seen.add(vinKey);
      return true;
    }
    // Fallback: title + price combo
    const key = `${c.title.toLowerCase().replace(/\s+/g, '')}|${c.price}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const BRAND_MODEL_MAP = {
  creta: 'hyundai', venue: 'hyundai', verna: 'hyundai', i20: 'hyundai', tucson: 'hyundai', alcazar: 'hyundai', exter: 'hyundai',
  fortuner: 'toyota', innova: 'toyota', hycross: 'toyota', glanza: 'toyota', urban: 'toyota', hilux: 'toyota', camry: 'toyota',
  thar: 'mahindra', xuv700: 'mahindra', xuv400: 'mahindra', scorpio: 'mahindra', bolero: 'mahindra', 'xuv 3xo': 'mahindra',
  swift: 'maruti', brezza: 'maruti', baleno: 'maruti', dzire: 'maruti', ertiga: 'maruti', 'grand vitara': 'maruti', fronx: 'maruti', jimny: 'maruti',
  nexon: 'tata', harrier: 'tata', safari: 'tata', punch: 'tata', altroz: 'tata', curvv: 'tata',
  seltos: 'kia', sonet: 'kia', carens: 'kia', carnival: 'kia', 'ev6': 'kia',
  city: 'honda', amaze: 'honda', elevate: 'honda', 'wr-v': 'honda',
  kushaq: 'skoda', slavia: 'skoda', octavia: 'skoda', superb: 'skoda',
  taigun: 'volkswagen', virtus: 'volkswagen', tiguan: 'volkswagen',
  'c class': 'mercedes', 'e class': 'mercedes', gla: 'mercedes', glc: 'mercedes', gle: 'mercedes',
  '3 series': 'bmw', '5 series': 'bmw', x1: 'bmw', x3: 'bmw', x5: 'bmw',
  q3: 'audi', q5: 'audi', q7: 'audi', a4: 'audi', a6: 'audi',
  xc40: 'volvo', xc60: 'volvo', xc90: 'volvo',
  compass: 'jeep', meridian: 'jeep', wrangler: 'jeep',
  'range rover': 'land rover', defender: 'land rover', discovery: 'land rover',
  hector: 'mg', astor: 'mg', gloster: 'mg'
};

function _detectBrand(model) {
  const m = model.toLowerCase().trim();
  return BRAND_MODEL_MAP[m] || null;
}

function _fmtPrice(p) {
  if (!p || p <= 0) return '-';
  if (p >= 10000000) return `${(p / 10000000).toFixed(2)} Cr`;
  if (p >= 100000) return `${(p / 100000).toFixed(1)} L`;
  return `${(p / 1000).toFixed(0)}K`;
}

function _fmtKm(km) {
  if (!km || km <= 0) return '-';
  if (km >= 1000) return `${(km / 1000).toFixed(0)}K km`;
  return `${km} km`;
}

// ==================== DEALER SHEET SEARCH ====================

async function _searchDealerSheet(opts) {
  // Search your own SHEET_USED_CSV_URL inventory
  if (!_config.loadUsedSheetRows) return [];

  try {
    const rows = await _config.loadUsedSheetRows();
    if (!rows || !rows.length) return [];

    const model = (opts.model || '').toLowerCase();
    const results = [];

    for (const row of rows) {
      const rowModel = (row.model || row.Model || row.CAR || '').toLowerCase();
      if (!rowModel.includes(model)) continue;

      const price = Number(String(row.price || row.Price || row.PRICE || 0).replace(/[^\d]/g, ''));
      const km = Number(String(row.km || row.KM || row.Km || 0).replace(/[^\d]/g, ''));
      const year = Number(row.year || row.Year || row.YEAR || 0);

      results.push({
        source: 'dealer',
        title: `${year || ''} ${row.brand || row.Brand || ''} ${row.model || row.Model || ''}`.trim(),
        brand: row.brand || row.Brand || '',
        model: row.model || row.Model || '',
        year,
        price,
        km,
        fuel: row.fuel || row.Fuel || '',
        transmission: row.transmission || row.Transmission || '',
        color: row.color || row.Color || '',
        owners: row.owner || row.Owner || '',
        bodyType: '',
        city: row.city || row.City || '',
        url: '',
        images: [],
        vin: ''
      });
    }

    return results;
  } catch (e) {
    console.warn('Dealer sheet search error:', e.message);
    return [];
  }
}

// ==================== FORMAT FOR WHATSAPP ====================

function formatForWhatsApp(results, stats, query) {
  if (!results.length) {
    return `No used *${query.model || 'cars'}* found in ${query.city || 'your area'} within your budget.\n\nTry a broader search or different model.`;
  }

  const model = (query.model || 'Car').replace(/^\w/, c => c.toUpperCase());
  let msg = `*Used ${model} — Top ${results.length} Deals*\n`;
  if (stats.avgPriceFormatted) {
    msg += `_Market avg: ${stats.avgPriceFormatted} | ${stats.total} found across ${Object.values(stats.sources).filter(v => v > 0).length} sources_\n\n`;
  }

  results.forEach((car, i) => {
    const tag = _dealTag(car.dealScore);
    const tagEmoji = car.dealScore >= 75 ? '🟢' : car.dealScore >= 60 ? '🟡' : '⚪';

    msg += `*${i + 1}.* ${car.title || `${car.year} ${car.brand} ${car.model}`}\n`;
    msg += `   ${car.priceFormatted} | ${car.kmFormatted} | ${car.fuel || '-'} | ${car.transmission || '-'}\n`;
    msg += `   ${car.owners || '-'} | ${car.color || '-'} | ${car.city || '-'}\n`;
    msg += `   ${tagEmoji} ${tag} | _via ${car.source}_\n\n`;
  });

  msg += `Reply with the *number* (1-${results.length}) for full details + EMI calculation.\n`;
  msg += `_We negotiate the best deal — you never talk to the seller directly._`;

  return msg;
}

function formatSingleCar(car, emiInfo = null) {
  const tag = _dealTag(car.dealScore);
  const tagEmoji = car.dealScore >= 75 ? '🟢' : car.dealScore >= 60 ? '🟡' : '⚪';

  let msg = `*${car.title || `${car.year} ${car.brand} ${car.model}`}*\n\n`;
  msg += `Year: ${car.year || '-'} | KM: ${car.kmFormatted || '-'}\n`;
  msg += `Fuel: ${car.fuel || '-'} | Transmission: ${car.transmission || '-'}\n`;
  msg += `Color: ${car.color || '-'} | Owner: ${car.owners || '-'}\n`;
  msg += `Location: ${car.city || '-'}\n\n`;
  msg += `Price: *${car.priceFormatted}*\n`;
  msg += `${tagEmoji} *${tag}*\n`;

  if (emiInfo) {
    msg += `\nEMI: *${emiInfo.emi}/mo* (${emiInfo.tenure} months @ ${emiInfo.rate}%)\n`;
  }

  msg += `\n_Source: ${car.source}_\n`;
  msg += `\nInterested? We'll negotiate the best price for you.\n`;
  msg += `_You never contact the seller — MR. CAR handles everything._`;

  return msg;
}

module.exports = {
  init,
  search,
  formatForWhatsApp,
  formatSingleCar,
  _dealTag,
  _fmtPrice,
  _fmtKm,
  _detectBrand,
  BRAND_MODEL_MAP
};
