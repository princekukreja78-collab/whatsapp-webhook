// lib/groupIngest.cjs — Silent group observer for dealer WhatsApp groups
// Bot stays completely silent in groups. Only observes car posts and builds inventory.
// Uses GPT to extract car details from dealer messages.

const fs = require('fs');
const path = require('path');

let _config = {};

const INVENTORY_FILE = path.join(__dirname, '..', 'group_inventory.json');
let inventory = [];

function init(config) {
  _config = config;
  _loadInventory();
}

function _loadInventory() {
  try {
    if (fs.existsSync(INVENTORY_FILE)) {
      inventory = JSON.parse(fs.readFileSync(INVENTORY_FILE, 'utf8')) || [];
      console.log(`GroupIngest: loaded ${inventory.length} cars from group inventory`);
    }
  } catch (e) {
    console.warn('GroupIngest: load failed', e.message);
    inventory = [];
  }
}

function _saveInventory() {
  try {
    // Keep last 500 entries
    if (inventory.length > 500) inventory = inventory.slice(-500);
    fs.writeFileSync(INVENTORY_FILE, JSON.stringify(inventory, null, 2), 'utf8');
  } catch (e) {
    console.warn('GroupIngest: save failed', e.message);
  }
}

/**
 * Check if a message is from a WhatsApp group.
 * WhatsApp Cloud API group indicators:
 * - msg.context.forwarded or msg.context.frequently_forwarded
 * - The "from" field in groups is still sender's number, but
 *   metadata contains group_id in some API versions
 *
 * Since WhatsApp Cloud API has limited group support,
 * we use a MUTE LIST approach: numbers added to MUTED_GROUPS env
 * are treated as group contexts → bot stays silent, only ingests.
 */
function isGroupOrMuted(from) {
  if (!from) return false;

  // Check explicit mute list (comma-separated phone numbers / group IDs)
  const muteList = (_config.MUTED_NUMBERS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (muteList.includes(from)) return true;

  // WhatsApp group JIDs end with @g.us (if using on-premise API)
  if (from.includes('@g.us')) return true;

  return false;
}

/**
 * Process a message from a muted/group context.
 * Extract car details using GPT, add to inventory.
 * NEVER replies.
 * @returns {boolean} true if this was a group message (so webhook can skip reply)
 */
async function handleGroupMessage(from, msgText, senderName, msgType, imageId) {
  if (!isGroupOrMuted(from)) return false;

  // Log silently
  console.log(`GroupIngest: [SILENT] from=${from} name=${senderName} type=${msgType}`);

  // Skip empty or very short messages
  if (!msgText && !imageId) return true; // still return true to block reply
  if (msgText && msgText.length < 10 && !imageId) return true;

  // Try to extract car details from text
  if (msgText && msgText.length >= 10) {
    const carData = await _extractCarFromText(msgText, senderName, from);
    if (carData) {
      inventory.push(carData);
      _saveInventory();
      console.log(`GroupIngest: added ${carData.model || carData.brand || 'car'} from ${senderName}`);
    }
  }

  return true; // Always true = bot stays silent
}

/**
 * Extract car details from a dealer's text message using pattern matching.
 * Falls back to GPT if available and text is complex.
 */
async function _extractCarFromText(text, senderName, groupId) {
  const t = (text || '').trim();
  if (!t) return null;

  const entry = {
    source: 'dealer_group',
    rawText: t.slice(0, 500),
    senderName: senderName || '',
    groupId: groupId || '',
    ingestedAt: new Date().toISOString(),
    brand: '',
    model: '',
    year: 0,
    price: 0,
    km: 0,
    fuel: '',
    color: '',
    owners: '',
    city: '',
    transmission: '',
    phone: ''
  };

  // ---- Pattern extraction ----

  // Year: 2018, 2019, 2020, etc.
  const yearMatch = t.match(/\b(20[1-2]\d)\b/);
  if (yearMatch) entry.year = Number(yearMatch[1]);

  // Price: "12.5 lakh", "₹8,50,000", "8.5L", "850000"
  const priceLakh = t.match(/(?:₹\s*)?(\d+(?:\.\d+)?)\s*(?:lakh|lac|l\b)/i);
  const priceRaw = t.match(/(?:₹\s*)?(\d{1,2}[,.]?\d{2}[,.]?\d{3})/);
  if (priceLakh) {
    entry.price = Math.round(Number(priceLakh[1]) * 100000);
  } else if (priceRaw) {
    entry.price = Number(priceRaw[1].replace(/[,]/g, ''));
  }

  // KM: "45000 km", "45k km", "45,000km"
  const kmMatch = t.match(/(\d[\d,]*)\s*(?:km|kms|kilometer)/i);
  const kmShort = t.match(/(\d+)\s*k\s*km/i);
  if (kmMatch) {
    entry.km = Number(kmMatch[1].replace(/,/g, ''));
  } else if (kmShort) {
    entry.km = Number(kmShort[1]) * 1000;
  }

  // Fuel
  if (/\b(diesel|dsl)\b/i.test(t)) entry.fuel = 'Diesel';
  else if (/\b(petrol|pet)\b/i.test(t)) entry.fuel = 'Petrol';
  else if (/\b(electric|ev|bev)\b/i.test(t)) entry.fuel = 'Electric';
  else if (/\b(hybrid|hev|phev)\b/i.test(t)) entry.fuel = 'Hybrid';
  else if (/\b(cng)\b/i.test(t)) entry.fuel = 'CNG';

  // Transmission
  if (/\b(auto|automatic|at|cvt|dct|amt)\b/i.test(t)) entry.transmission = 'Automatic';
  else if (/\b(manual|mt)\b/i.test(t)) entry.transmission = 'Manual';

  // Owner
  if (/\b(1st|first|single)\s*owner/i.test(t)) entry.owners = 'First Owner';
  else if (/\b(2nd|second)\s*owner/i.test(t)) entry.owners = 'Second Owner';
  else if (/\b(3rd|third)\s*owner/i.test(t)) entry.owners = 'Third Owner';

  // Color
  const colors = ['white', 'black', 'silver', 'grey', 'gray', 'red', 'blue', 'brown', 'beige', 'green', 'maroon', 'orange', 'gold', 'pearl'];
  for (const c of colors) {
    if (t.toLowerCase().includes(c)) { entry.color = c.charAt(0).toUpperCase() + c.slice(1); break; }
  }

  // Phone number
  const phoneMatch = t.match(/(?:\+91|91)?[\s-]?([6-9]\d{9})\b/);
  if (phoneMatch) entry.phone = '91' + phoneMatch[1];

  // Brand + Model detection using known brands
  const brands = {
    toyota: ['fortuner', 'innova', 'hycross', 'glanza', 'camry', 'urban cruiser', 'hilux', 'vellfire'],
    hyundai: ['creta', 'venue', 'verna', 'i20', 'tucson', 'alcazar', 'exter', 'aura'],
    mahindra: ['thar', 'xuv700', 'xuv400', 'xuv 3xo', 'scorpio', 'bolero', 'be 6'],
    maruti: ['swift', 'brezza', 'baleno', 'dzire', 'ertiga', 'grand vitara', 'fronx', 'jimny', 'alto', 'wagon r', 'ciaz'],
    tata: ['nexon', 'harrier', 'safari', 'punch', 'altroz', 'curvv', 'tiago'],
    kia: ['seltos', 'sonet', 'carens', 'carnival', 'ev6'],
    honda: ['city', 'amaze', 'elevate'],
    mg: ['hector', 'astor', 'gloster', 'comet', 'zs'],
    skoda: ['kushaq', 'slavia', 'octavia', 'superb'],
    volkswagen: ['taigun', 'virtus', 'tiguan'],
    bmw: ['x1', 'x3', 'x5', 'x7', '3 series', '5 series', '7 series'],
    mercedes: ['gla', 'glc', 'gle', 'gls', 'c class', 'e class', 's class', 'a class', 'amg'],
    audi: ['q3', 'q5', 'q7', 'q8', 'a4', 'a6', 'a8', 'e-tron'],
    volvo: ['xc40', 'xc60', 'xc90'],
    jeep: ['compass', 'meridian', 'wrangler', 'grand cherokee'],
    'land rover': ['range rover', 'defender', 'discovery', 'evoque'],
    porsche: ['cayenne', 'macan', 'taycan', '911'],
    lexus: ['nx', 'rx', 'lx', 'es', 'ls']
  };

  const tLower = t.toLowerCase();
  for (const [brand, models] of Object.entries(brands)) {
    for (const model of models) {
      if (tLower.includes(model)) {
        entry.brand = brand.charAt(0).toUpperCase() + brand.slice(1);
        entry.model = model.charAt(0).toUpperCase() + model.slice(1);
        break;
      }
    }
    if (entry.model) break;
    // Check brand name alone
    if (tLower.includes(brand)) {
      entry.brand = brand.charAt(0).toUpperCase() + brand.slice(1);
    }
  }

  // If we couldn't extract at least a brand or model, try GPT (if available)
  if (!entry.brand && !entry.model && _config.openai) {
    try {
      const gptResult = await _extractWithGPT(t);
      if (gptResult) Object.assign(entry, gptResult);
    } catch (e) {
      // Silent fail — pattern matching already did its best
    }
  }

  // Only save if we got something useful
  if (!entry.brand && !entry.model && !entry.price) return null;

  entry.title = `${entry.year || ''} ${entry.brand} ${entry.model}`.trim();
  return entry;
}

async function _extractWithGPT(text) {
  if (!_config.openai) return null;

  try {
    const resp = await _config.openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'Extract car details from this dealer message. Return JSON only: {"brand":"","model":"","year":0,"price":0,"km":0,"fuel":"","color":"","owners":"","city":"","transmission":""}. Price in INR (number). If not found, use empty string or 0.'
        },
        { role: 'user', content: text.slice(0, 500) }
      ],
      temperature: 0,
      max_tokens: 200
    });

    const content = resp.choices?.[0]?.message?.content || '';
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        brand: parsed.brand || '',
        model: parsed.model || '',
        year: Number(parsed.year) || 0,
        price: Number(parsed.price) || 0,
        km: Number(parsed.km) || 0,
        fuel: parsed.fuel || '',
        color: parsed.color || '',
        owners: parsed.owners || '',
        city: parsed.city || '',
        transmission: parsed.transmission || ''
      };
    }
  } catch (e) {
    console.warn('GroupIngest: GPT extraction failed', e.message);
  }
  return null;
}

// ==================== SEARCH GROUP INVENTORY ====================

function searchInventory(query) {
  const model = (query.model || '').toLowerCase();
  const brand = (query.brand || '').toLowerCase();
  if (!model && !brand) return [];

  return inventory.filter(car => {
    if (model && !(car.model || '').toLowerCase().includes(model) && !(car.title || '').toLowerCase().includes(model)) return false;
    if (brand && !(car.brand || '').toLowerCase().includes(brand)) return false;
    if (query.maxBudget && car.price > query.maxBudget * 100000) return false;
    if (query.minBudget && car.price < query.minBudget * 100000) return false;
    return true;
  }).slice(0, 10);
}

function getInventoryCount() {
  return inventory.length;
}

module.exports = {
  init,
  isGroupOrMuted,
  handleGroupMessage,
  searchInventory,
  getInventoryCount
};
