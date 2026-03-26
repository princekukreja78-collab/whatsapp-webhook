// lib/mediaStore.cjs — Store and retrieve car photos received from dealers on staging
// When dealer sends photos to staging number, we download and store them.
// Later when customer asks, we retrieve and forward via prod.

const fs = require('fs');
const path = require('path');

let _config = {};

const MEDIA_DIR = path.join(__dirname, '..', 'media_store');
const INDEX_FILE = path.join(MEDIA_DIR, 'index.json');
let index = {}; // carKey → { photos: [{ url, localPath, savedAt }], dealerPhone, carModel }

function init(config) {
  _config = config;
  if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });
  _loadIndex();
  console.log(`MediaStore: loaded ${Object.keys(index).length} car entries`);
}

function _loadIndex() {
  try {
    if (fs.existsSync(INDEX_FILE)) {
      index = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')) || {};
    }
  } catch (e) { index = {}; }
}

function _saveIndex() {
  try {
    fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2), 'utf8');
  } catch (e) { console.warn('MediaStore: save failed', e.message); }
}

/**
 * Generate a key for a car (brand + model + year or enquiry ID)
 */
function _carKey(carModel, enquiryId) {
  if (enquiryId) return enquiryId;
  return (carModel || 'unknown').toLowerCase().replace(/[^a-z0-9]/g, '_');
}

/**
 * Download a WhatsApp media file and store it locally.
 * @param {string} mediaId — WhatsApp media ID from incoming message
 * @param {string} carModel — e.g. "Hyundai Creta"
 * @param {string} dealerPhone — dealer's number
 * @param {string} enquiryId — if tied to a specific enquiry
 * @returns {string|null} — public URL of saved file, or null
 */
async function saveMedia(mediaId, carModel, dealerPhone, enquiryId) {
  if (!mediaId || !_config.META_TOKEN || !_config.fetch) return null;

  try {
    // Step 1: Get media URL from WhatsApp
    const metaResp = await _config.fetch(
      `https://graph.facebook.com/v21.0/${mediaId}`,
      { headers: { Authorization: `Bearer ${_config.META_TOKEN}` } }
    );
    const metaData = await metaResp.json();
    const mediaUrl = metaData.url;
    if (!mediaUrl) return null;

    // Step 2: Download the actual file
    const fileResp = await _config.fetch(mediaUrl, {
      headers: { Authorization: `Bearer ${_config.META_TOKEN}` }
    });
    if (!fileResp.ok) return null;

    const buffer = Buffer.from(await fileResp.arrayBuffer());

    // Step 3: Save locally
    const ext = (metaData.mime_type || 'image/jpeg').includes('png') ? 'png' : 'jpg';
    const filename = `${Date.now()}_${mediaId.slice(-8)}.${ext}`;
    const filePath = path.join(MEDIA_DIR, filename);
    fs.writeFileSync(filePath, buffer);

    // Step 4: Update index
    const key = _carKey(carModel, enquiryId);
    if (!index[key]) {
      index[key] = { photos: [], dealerPhone: dealerPhone || '', carModel: carModel || '' };
    }
    const publicUrl = `/media_store/${filename}`;
    index[key].photos.push({
      url: publicUrl,
      localPath: filePath,
      mediaId,
      savedAt: new Date().toISOString()
    });
    _saveIndex();

    console.log(`MediaStore: saved ${filename} for ${carModel || enquiryId}`);
    return publicUrl;
  } catch (e) {
    console.warn('MediaStore: save failed', e.message);
    return null;
  }
}

/**
 * Get stored photos for a car/enquiry.
 * @returns {Array<string>} — array of public URLs
 */
function getPhotos(carModel, enquiryId) {
  const key = _carKey(carModel, enquiryId);
  const entry = index[key];
  if (!entry || !entry.photos) return [];
  return entry.photos.map(p => p.url);
}

/**
 * Get all stored entries count.
 */
function getStats() {
  const totalPhotos = Object.values(index).reduce((s, e) => s + (e.photos?.length || 0), 0);
  return { cars: Object.keys(index).length, photos: totalPhotos };
}

module.exports = { init, saveMedia, getPhotos, getStats };
