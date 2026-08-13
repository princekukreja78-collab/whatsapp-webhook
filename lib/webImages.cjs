// lib/webImages.cjs — fetch real car photos from the web (exact model + colour)
// Used for new-car deal listings that arrive as price sheets with no photos.
// DuckDuckGo image search (no API key needed) → download top results.
'use strict';

let _config = {};

function init(config) { _config = config || {}; }

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

async function _getVqd(query) {
  const resp = await _config.fetch(
    `https://duckduckgo.com/?q=${encodeURIComponent(query)}&iax=images&ia=images`,
    { headers: { 'User-Agent': UA } }
  );
  const html = await resp.text();
  const m = /vqd=["']?([\d-]+)["']?/.exec(html) || /vqd=([\d-]+)&/.exec(html);
  return m ? m[1] : null;
}

/**
 * Search images and return result URLs (largest first preference kept as ranked).
 */
async function searchImages(query, count = 4) {
  try {
    const vqd = await _getVqd(query);
    if (!vqd) return [];
    const url = `https://duckduckgo.com/i.js?l=en-in&o=json&q=${encodeURIComponent(query)}&vqd=${vqd}&f=,,,,,&p=1`;
    const resp = await _config.fetch(url, {
      headers: { 'User-Agent': UA, Referer: 'https://duckduckgo.com/' }
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    const results = Array.isArray(data.results) ? data.results : [];
    return results
      .filter(r => r.image && /\.(jpe?g|png)(\?|$)/i.test(r.image))
      .filter(r => (r.width || 0) >= 640)
      .slice(0, count)
      .map(r => r.image);
  } catch (e) {
    console.warn('webImages: search failed', e.message);
    return [];
  }
}

/**
 * Download up to `count` images for a query. Returns array of { buffer, ext }.
 */
async function fetchImages(query, count = 2) {
  const urls = await searchImages(query, count + 4);
  const out = [];
  for (const u of urls) {
    if (out.length >= count) break;
    try {
      const resp = await _config.fetch(u, { headers: { 'User-Agent': UA }, timeout: 15000 });
      if (!resp.ok) continue;
      const ct = String(resp.headers.get('content-type') || '');
      if (!/image\/(jpe?g|png)/.test(ct)) continue; // WhatsApp cards need jpg/png
      const buf = Buffer.from(await resp.arrayBuffer());
      if (buf.length < 30 * 1024 || buf.length > 8 * 1024 * 1024) continue; // skip icons / monsters
      const ext = ct.includes('png') ? '.png' : '.jpg';
      out.push({ buffer: buf, ext });
    } catch (e) {}
  }
  return out;
}

module.exports = { init, searchImages, fetchImages };
