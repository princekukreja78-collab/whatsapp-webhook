// lib/scrapers/olx.cjs — OLX India used car scraper (stub)
// OLX blocks server-side requests behind Akamai CDN.
// Full implementation requires Puppeteer (headless browser).
// This stub returns empty results until Puppeteer is added.

let _fetch = null;

function init(config) {
  _fetch = config.fetch || globalThis.fetch;
}

/**
 * Search OLX used cars
 * NOTE: Currently returns empty — OLX requires headless browser.
 * To enable: npm install puppeteer, then implement with real browser automation.
 * @param {Object} opts - { model, brand, city, minBudget, maxBudget }
 * @returns {Array} normalized car listings (empty until Puppeteer added)
 */
async function search(opts = {}) {
  // TODO: Implement with Puppeteer when ready
  // URL pattern: https://www.olx.in/cars_c84?filter=make_eq_hyundai
  // Selectors: data-aut-id="itemTitle", data-aut-id="itemPrice", etc.
  console.log('OLX: scraper not yet enabled (needs Puppeteer)');
  return [];
}

module.exports = { init, search };
