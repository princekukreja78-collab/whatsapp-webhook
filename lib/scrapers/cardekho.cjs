// lib/scrapers/cardekho.cjs — CarDekho public used car listing scraper
// Parses JSON-LD structured data from public listing pages (no API key needed)

let _fetch = null;

function init(config) {
  _fetch = config.fetch || globalThis.fetch;
}

const CITY_SLUGS = {
  delhi: 'new+delhi', 'new delhi': 'new+delhi', noida: 'noida', gurgaon: 'gurgaon', gurugram: 'gurgaon', ghaziabad: 'ghaziabad',
  mumbai: 'mumbai', 'navi mumbai': 'navi+mumbai', thane: 'thane',
  bangalore: 'bangalore', bengaluru: 'bangalore',
  hyderabad: 'hyderabad', chennai: 'chennai', pune: 'pune',
  kolkata: 'kolkata', ahmedabad: 'ahmedabad', jaipur: 'jaipur',
  lucknow: 'lucknow', chandigarh: 'chandigarh', kochi: 'kochi',
  indore: 'indore', bhopal: 'bhopal', patna: 'patna', nagpur: 'nagpur'
};

function _extractJsonLd(html) {
  const results = [];
  const regex = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    try {
      const data = JSON.parse(match[1]);
      const items = data['@graph'] || [data];
      for (const block of (Array.isArray(items) ? items : [items])) {
        if (block['@type'] === 'ItemList' && Array.isArray(block.itemListElement)) {
          for (const item of block.itemListElement) {
            const car = item.item || item;
            if (car['@type'] === 'Car') {
              results.push(_normalizeCar(car));
            }
          }
        }
      }
    } catch (e) { /* skip */ }
  }
  return results;
}

function _normalizeCar(car) {
  const price = car.offers?.price || car.offers?.lowPrice || 0;
  const km = car.mileageFromOdometer?.value || 0;

  return {
    source: 'cardekho',
    title: car.name || '',
    brand: car.brand?.name || '',
    model: car.model || '',
    year: Number(car.vehicleModelDate) || 0,
    price: Number(price),
    km: Number(km),
    fuel: car.vehicleEngine?.fuelType || car.fuelType || '',
    transmission: car.vehicleTransmission || '',
    color: car.color || '',
    owners: car.numberOfPreviousOwners || '',
    bodyType: car.bodyType || '',
    city: car.contentLocation?.address?.addressLocality || '',
    regPlace: car.contentLocation?.address?.addressRegion || '',
    insurance: '',
    url: car.url || '',
    images: Array.isArray(car.image)
      ? car.image.map(img => typeof img === 'string' ? img : img.contentUrl || img.url || '').filter(Boolean).slice(0, 3)
      : [],
    vin: car.vehicleIdentificationNumber || ''
  };
}

/**
 * Search CarDekho used cars
 * @param {Object} opts - { model, brand, city }
 * @returns {Array} normalized car listings
 */
async function search(opts = {}) {
  const citySlug = CITY_SLUGS[(opts.city || 'delhi').toLowerCase()] || 'new+delhi';
  const results = [];

  let url = `https://www.cardekho.com/used-cars+in+${citySlug}`;

  // Add brand/model filter
  if (opts.brand) {
    url += `/${encodeURIComponent(opts.brand.toLowerCase())}`;
    if (opts.model) {
      url += `+${encodeURIComponent(opts.model.toLowerCase())}`;
    }
  } else if (opts.model) {
    url += `/${encodeURIComponent(opts.model.toLowerCase())}`;
  }

  try {
    const resp = await _fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-IN,en;q=0.9'
      }
    });

    if (!resp.ok) {
      console.warn(`CarDekho: HTTP ${resp.status} for ${url}`);
      return results;
    }

    const html = await resp.text();
    const cars = _extractJsonLd(html);
    results.push(...cars);
  } catch (e) {
    console.warn('CarDekho scrape error:', e.message);
  }

  // Filter by model if needed
  if (opts.model) {
    const modelLower = opts.model.toLowerCase();
    return results.filter(c =>
      c.model.toLowerCase().includes(modelLower) ||
      c.title.toLowerCase().includes(modelLower)
    );
  }

  return results;
}

module.exports = { init, search, CITY_SLUGS };
