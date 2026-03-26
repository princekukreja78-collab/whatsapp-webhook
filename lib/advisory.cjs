const fs = require('fs');
const path = require('path');

let _config = {};
function init(config) { _config = config; }
// config = { openai, SIGNATURE_MODEL, getRAG, findRelevantChunks, DEBUG }

// === AI Vision: Analyze car image for faults + repaint + upgrades + PPF advice ===
async function analyzeCarImageFaultWithOpenAI(imageUrl, userText = "") {
  const model = process.env.OPENAI_VISION_MODEL || process.env.ENGINE_USED || "gpt-4o-mini";

  const systemPrompt = `
You are *MR.CAR* – a professional car evaluator, bodyshop and detailing advisor.
You ONLY see 1–2 photos plus a short text from the customer.

Your goals:
1) Identify visible issues or risks (mechanical, body, tires, lights, glass, rust, leaks, etc.).
2) Comment on *paint condition* and *possible repainting*:
   - Look for colour mismatch between panels.
   - Uneven orange-peel texture or waviness on one panel vs others.
   - Masking/paint lines near rubber, chrome, badges, door handles.
   - Overspray on rubbers or trims.
   - Unusual panel gaps or alignment.
   - Scratches/buff marks indicating heavy polishing.
   You are NOT a lab – clearly state this is a visual opinion, not 100% proof.
3) Give *PPF / coating / detailing* advice:
   - When is PPF advisable? (highway usage, new car, expensive colour, lots of chips risk)
   - Suggest whether full body PPF, frontal kit (bumper+bonnet+mirrors), or only high-contact areas.
   - Mention cheaper alternatives like ceramic/graphene coating, wax, or only repaint+polish if needed.
4) Give *upgrade suggestions*:
   - If interior visible: suggest seat cover type (fabric, PU, leather), colour combos (eg. black–tan, black–red) and possible carbon-fibre or piano-black trim areas (steering, central console, door switch panels).
   - If exterior mainly visible: suggest alloys, dechroming, black roof, mild spoilers, projector/LED headlamp upgrades – BUT keep it classy, not boy-racer.
5) If the user text mentions "problem", "noise", "check engine", "warning light", etc., treat that as a service concern and first address that.

Output format (very important):
1) *Quick Summary* – 2–3 lines.
2) *Visible Issues / Faults* – bullet points (or "None clearly visible").
3) *Repaint / Bodywork Opinion* – explain if any panel looks possibly repainted and WHY, with low/medium/high confidence.
4) *PPF / Protection Advice* – what you recommend (eg. "frontal kit PPF", "only touch-ups and polish", etc.).
5) *Interior / Exterior Upgrade Ideas* – concise, 3–5 bullets max.
6) *Disclaimer* – remind that this is based only on photos and is not a physical inspection.
`.trim();

  const userPrompt = `
User context/message (may be empty):
"${userText || "N/A"}"

Now analyse the attached car photo(s) and respond in the requested format.
`.trim();

  const completion = await _config.openai.chat.completions.create({
    model,
    messages: [
      {
        role: "system",
        content: systemPrompt
      },
      {
        role: "user",
        content: [
          { type: "text", text: userPrompt },
          {
            type: "image_url",
            image_url: { url: imageUrl }
          }
        ]
      }
    ]
  });

  const text =
    (completion.choices &&
      completion.choices[0] &&
      completion.choices[0].message &&
      completion.choices[0].message.content) ||
    "Sorry, I could not clearly understand this photo. Please send a clearer image.";

  return text.trim();
}

/* =======================================================================
   Signature GPT & Brochure helpers
   ======================================================================= */
const BROCHURE_INDEX_PATH = process.env.BROCHURE_INDEX_PATH || './brochures/index.json';

// advisory intent detector
function isAdvisory(msgText) {
  const t = (msgText || '').toLowerCase();
  if (!t) return false;

  const advisoryPhrases = [
  // ---------- Comparison / Decision ----------
  'which is better',
  'better than',
  'which to buy',
  'which should i buy',
  'which to choose',
  'compare',
  'comparison',
  'vs',

  // ---------- Specifications / Technical ----------
  'spec',
  'specs',
  'specification',
  'specifications',
  'technical',
  'engine',
  'engine specs',
  'bhp',
  'power',
  'torque',
  'transmission',
  'automatic',
  'manual',
  'gearbox',
  'mileage',
  'average',
  'fuel efficiency',
  'range',
  'drivetrain',
  'awd',
  '4x4',
  '4wd',

  // ---------- Features / Comfort ----------
  'features',
  'feature wise',
  'variant wise',
  'top model',
  'base model',
  'sunroof',
  'panoramic',
  'adas',
  'cruise',
  'ventilated',
  'seat',
  'infotainment',
  'touchscreen',
  'speaker',
  'audio',
  'boot space',
  'luggage',
  'space',
  'legroom',
  'headroom',
  'dimensions',
  'ground clearance',

  // ---------- Safety ----------
  'safety',
  'airbags',
  'abs',
  'esc',
  'traction',
  'global ncap',
  'bharat ncap',
  'crash rating',
  'safety rating',

  // ---------- Ownership ----------
  'warranty',
  'extended warranty',
  'service cost',
  'maintenance',
  'running cost',
  'ownership cost',

  // ---------- Indian Natural Language ----------
  'kitna deti',
  'kitna mileage',
  'service kitna',
  'maintenance kitna',
  'safe hai',
  'achhi hai',
  'worth it'
];

  for (const p of advisoryPhrases) {
    if (t.includes(p)) return true;
  }

  // simple "A vs B" detector
  if (t.includes(' vs ') || t.includes(' v/s ') || /\bvs\b/.test(t)) return true;

  return false;
}

function extractModelsForComparisonFallback(text) {
  if (!text) return [];
  const t = text.toLowerCase();

  // split on common comparison separators
  const parts = t.split(/\bvs\b|v\/s|compare|comparison|better than|difference between|or/i)
    .map(s => s.trim())
    .filter(Boolean);

  // take first 2 meaningful chunks
  return parts.slice(0, 2)
    .map(s =>
      s
        .replace(/price|onroad|on road|specs?|features?|mileage|compare|which is better/g, '')
        .trim()
    )
    .filter(s => s.length >= 3);
}

// brochure index loader
function loadBrochureIndex() {
  try {
    const p = path.resolve(__dirname, BROCHURE_INDEX_PATH);
    if (!fs.existsSync(p)) return [];
    const txt = fs.readFileSync(p, 'utf8') || '[]';
    const j = JSON.parse(txt);
    return Array.isArray(j) ? j : [];
  } catch (e) {
    if (_config.DEBUG) console.warn('loadBrochureIndex failed', e && e.message ? e.message : e);
    return [];
  }
}

function findRelevantBrochures(index, msgText) {
  try {
    if (!Array.isArray(index) || !index.length) return [];
    const q = (msgText || '').toLowerCase();
    const scored = index.map(b => {
      const title = (b.title || b.id || '').toString().toLowerCase();
      const brand = (b.brand || '').toString().toLowerCase();
      const variants = (b.variants || []).map(v => v.toString().toLowerCase());
      let score = 0;
      if (title && q.includes(title)) score += 30;
      if (brand && q.includes(brand)) score += 25;
      for (const v of variants) if (v && q.includes(v)) score += 18;
      if (b.summary && b.summary.toLowerCase().includes(q)) score += 15;
      return { b, score };
    }).filter(x => x.score > 0);
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 3).map(x => x.b);
  } catch (e) {
    if (_config.DEBUG) console.warn('findRelevantBrochures fail', e && e.message ? e.message : e);
    return [];
  }
}

const PHONE_RE = /(?:(?:\+?\d{1,3}[\s\-\.])?(?:\(?\d{2,4}\)?[\s\-\.])?\d{3,4}[\s\-\.]\d{3,4})(?:\s*(?:ext|x|ext.)\s*\d{1,5})?/g;

function extractPhonesFromText(text) {
  try {
    if (!text) return [];
    const found = (String(text).match(PHONE_RE) || []).map(s => s.trim());
    const norm = found.map(s => s.replace(/[\s\-\.\(\)]+/g, ''));
    const unique = [];
    const seen = new Set();
    for (let i = 0; i < norm.length; i++) {
      if (!seen.has(norm[i])) {
        seen.add(norm[i]);
        unique.push(found[i]);
      }
    }
    return unique;
  } catch (e) {
    if (_config.DEBUG) console.warn('extractPhonesFromText fail', e && e.message ? e.message : e);
    return [];
  }
}

function findPhonesInBrochures(entries) {
  const matches = [];
  try {
    for (const b of (entries || [])) {
      const srcId = b.id || b.title || b.url || 'unknown';
      const candidates = [];
      if (b.summary) candidates.push(b.summary);
      if (b.title) candidates.push(b.title);
      if (b.helpline) candidates.push(String(b.helpline));
      const joined = candidates.join(' \n ');
      const phones = extractPhonesFromText(joined);
      for (const p of phones) {
        const low = joined.toLowerCase();
        let label = '';
        if (low.includes('rsa') || low.includes('roadside')) label = 'RSA helpline';
        else if (low.includes('service')) label = 'Service helpline';
        else if (low.includes('warranty')) label = 'Warranty helpline';
        else if (low.includes('customer') || low.includes('care')) label = 'Customer care';
        else label = 'Helpline';
        matches.push({ label, phone: p, sourceId: srcId });
      }
    }
    const uniq = [];
    const seen = new Set();
    for (const m of matches) {
      const k = (m.phone || '').replace(/[\s\-\.\(\)]+/g, '');
      if (!seen.has(k)) {
        seen.add(k);
        uniq.push(m);
      }
    }
    return uniq;
  } catch (e) {
    if (_config.DEBUG) console.warn('findPhonesInBrochures fail', e && e.message ? e.message : e);
    return [];
  }
}

// Signature Brain wrapper
async function callSignatureBrain({ from, name, msgText, lastService, ragHits = [] } = {}) {
  try {
    if (!msgText) return null;

    const sys = `You are SIGNATURE SAVINGS — a crisp dealership advisory assistant for MR.CAR.
Answer concisely, with dealership-level accuracy.
Always end with: "Reply 'Talk to agent' to request a human."`;

    let context = "";
    if (Array.isArray(ragHits) && ragHits.length > 0) {
      context = ragHits.map(x => x.text).join("\n\n---\n\n");
    }

    const promptMessages = [
      { role: "system", content: sys },
      { role: "user", content: `User question: ${msgText}\n\nRelevant Data:\n${context}` }
    ];

    const resp = await _config.openai.chat.completions.create({
      model: _config.SIGNATURE_MODEL,
      messages: promptMessages,
      max_tokens: 600,
      temperature: 0.25
    });

    return resp?.choices?.[0]?.message?.content || null;

  } catch (err) {
    console.error("SignatureBrain error:", err?.message || err);
    return null;
  }
}

module.exports = {
  init,
  analyzeCarImageFaultWithOpenAI,
  isAdvisory,
  extractModelsForComparisonFallback,
  loadBrochureIndex,
  findRelevantBrochures,
  extractPhonesFromText,
  findPhonesInBrochures,
  callSignatureBrain,
  BROCHURE_INDEX_PATH,
  PHONE_RE
};
