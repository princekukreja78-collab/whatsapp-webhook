// lib/scrapers/carwale.cjs — CarWale public used car listing scraper
// Parses JSON-LD structured data from public listing pages (no API key needed)

let _fetch = null;

function init(config) {
  _fetch = config.fetch || globalThis.fetch;
}

const CITY_SLUGS = {
  delhi: 'delhi', 'new delhi': 'delhi', noida: 'delhi', gurgaon: 'delhi', gurugram: 'delhi', ghaziabad: 'delhi',
  mumbai: 'mumbai', 'navi mumbai': 'mumbai', thane: 'mumbai',
  bangalore: 'bangalore', bengaluru: 'bangalore',
  hyderabad: 'hyderabad', chennai: 'chennai', pune: 'pune',
  kolkata: 'kolkata', ahmedabad: 'ahmedabad', jaipur: 'jaipur',
  lucknow: 'lucknow', chandigarh: 'chandigarh', kochi: 'kochi',
  indore: 'indore', bhopal: 'bhopal', patna: 'patna', nagpur: 'nagpur'
};

// Budget bands in lakhs
function _budgetBand(minLakh, maxLakh) {
  return `${Math.floor(minLakh)}-${Math.ceil(maxLakh)}`;
}

// Extract JSON-LD from HTML
function _extractJsonLd(html) {
  const results = [];
  const regex = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    try {
      const data = JSON.parse(match[1]);
      // Handle @graph wrapper (CarWale uses this)
      const items = data['@graph'] || [data];
      for (const block of (Array.isArray(items) ? items : [items])) {
        if (block['@type'] === 'ItemList' && Array.isArray(block.itemListElement)) {
          for (const item of block.itemListElement) {
            const car = item.item || item;
            if (car['@type'] === 'Car') {
              results.push(_normalizeCar(car, 'carwale'));
            }
          }
        }
      }
    } catch (e) { /* skip malformed JSON-LD */ }
  }
  return results;
}

function _normalizeCar(car, source) {
  const price = car.offers?.price || car.offers?.lowPrice || 0;
  const km = car.mileageFromOdometer?.value || 0;

  return {
    source,
    title: car.name || '',
    brand: car.brand?.name || car.Brand?.name || '',
    model: car.model || '',
    year: Number(car.vehicleModelDate) || 0,
    price: Number(price),
    km: Number(km),
    fuel: car.fuelType || car.vehicleEngine?.fuelType || '',
    transmission: car.vehicleTransmission || '',
    color: car.color || '',
    owners: car.numberOfPreviousOwners || '',
    bodyType: car.bodyType || '',
    city: car.location?.address?.addressLocality || car.contentLocation?.address?.addressLocality || car.offers?.availableAtOrFrom?.address?.addressLocality || '',
    regPlace: car.location?.address?.addressRegion || car.contentLocation?.address?.addressRegion || '',
    insurance: car.insurance || '',
    url: car.url || '',
    images: Array.isArray(car.image)
      ? car.image.map(img => typeof img === 'string' ? img : img.contentUrl || img.url || '').filter(Boolean).slice(0, 3)
      : [],
    vin: car.vehicleIdentificationNumber || ''
  };
}

/**
 * Search CarWale used cars
 * @param {Object} opts - { model, brand, city, minBudget, maxBudget, pages }
 *   budget in lakhs (e.g., 10, 15)
 * @returns {Array} normalized car listings
 */
async function search(opts = {}) {
  const city = CITY_SLUGS[(opts.city || 'delhi').toLowerCase()] || 'delhi';
  const pages = opts.pages || 1;
  const results = [];

  let baseUrl = `https://www.carwale.com/used/cars-in-${city}/`;

  // Add brand/model to path if specified
  if (opts.brand && opts.model) {
    baseUrl = `https://www.carwale.com/used/cars-in-${city}/${encodeURIComponent(opts.brand.toLowerCase())}-${encodeURIComponent(opts.model.toLowerCase())}/`;
  }

  const params = [];
  if (opts.minBudget || opts.maxBudget) {
    const min = opts.minBudget || 1;
    const max = opts.maxBudget || 100;
    params.push(`budget=${_budgetBand(min, max)}`);
  }

  for (let page = 1; page <= pages; page++) {
    const pageParams = [...params];
    if (page > 1) pageParams.push(`page=${page}`);
    const url = baseUrl + (pageParams.length ? '?' + pageParams.join('&') : '');

    try {
      const resp = await _fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-IN,en;q=0.9'
        }
      });

      if (!resp.ok) {
        console.warn(`CarWale: HTTP ${resp.status} for ${url}`);
        continue;
      }

      const html = await resp.text();
      const cars = _extractJsonLd(html);
      results.push(...cars);

      // Small delay between pages
      if (page < pages) await new Promise(r => setTimeout(r, 800));
    } catch (e) {
      console.warn('CarWale scrape error:', e.message);
    }
  }

  // Filter by model if specified (JSON-LD may include other models)
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
