// Body style by model. A customer asks for "an SUV under 15 lakh" far more often
// than for a model by name, and neither the pricing sheets nor a used listing
// carries a body-style column — so it lives here.

const BODY = {
  suv: ['creta', 'venue', 'exter', 'alcazar', 'tucson', 'seltos', 'sonet', 'syros', 'nexon', 'punch',
    'harrier', 'safari', 'curvv', 'brezza', 'fronx', 'jimny', 'grand vitara', 'hector', 'astor',
    'gloster', 'thar', 'thar roxx', 'xuv700', 'xuv300', 'xuv400', 'xuv 3xo', 'scorpio', 'scorpio n',
    'bolero', 'fortuner', 'hyryder', 'taisor', 'urban cruiser', 'elevate', 'wrv', 'kushaq', 'kodiaq',
    'taigun', 'tiguan', 'kiger', 'magnite', 'compass', 'meridian', 'wrangler', 'evoque', 'velar',
    'defender', 'discovery', 'cayenne', 'macan', 'glc', 'gle', 'gla', 'q3', 'q5', 'q7', 'x1', 'x3',
    'x5', 'ecosport', 'endeavour', 'sonet', 'kylaq'],
  muv: ['innova', 'hycross', 'crysta', 'ertiga', 'xl6', 'carens', 'carnival', 'triber', 'marazzo',
    'rumion', 'alcazar', 'bolero neo'],
  sedan: ['city', 'amaze', 'verna', 'ciaz', 'dzire', 'tigor', 'slavia', 'virtus', 'aura', 'a-class',
    'a200', 'camry', 'accord', 'octavia', 'superb', 'a4', 'a6', '3 series', '5 series', 'c-class',
    'e-class'],
  hatchback: ['swift', 'baleno', 'altroz', 'tiago', 'i20', 'glanza', 'polo', 'wagonr', 'wagon r',
    'celerio', 'ignis', 'santro', 'punch', 'comet']
};

const SYNONYM = {
  suv: 'suv', suvs: 'suv', 'sub compact suv': 'suv', 'compact suv': 'suv', crossover: 'suv',
  muv: 'muv', muvs: 'muv', mpv: 'muv', mpvs: 'muv', '7 seater': 'muv', 'seven seater': 'muv',
  sedan: 'sedan', sedans: 'sedan', saloon: 'sedan',
  hatchback: 'hatchback', hatch: 'hatchback', hatchbacks: 'hatchback'
};

/** Which body style is the customer asking for, if any. */
function askedBody(text) {
  const t = String(text || '').toLowerCase();
  for (const [word, body] of Object.entries(SYNONYM)) {
    if (new RegExp(`\\b${word.replace(/ /g, '\\s+')}\\b`, 'i').test(t)) return body;
  }
  return null;
}

/** The body style of a car, read from whatever text describes it. */
function bodyOf(text) {
  const t = String(text || '').toLowerCase();
  for (const [body, models] of Object.entries(BODY)) {
    for (const m of models) {
      if (new RegExp(`\\b${m.replace(/ /g, '\\s*')}\\b`, 'i').test(t)) return body;
    }
  }
  return null;
}

/** Does this car answer that request? */
function isBody(text, body) {
  if (!body) return true;
  return bodyOf(text) === body;
}

module.exports = { askedBody, bodyOf, isBody, BODY };
