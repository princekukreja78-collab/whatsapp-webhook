// WhatsApp helper functions — extracted from server.cjs
// Usage:  const wa = require('./lib/whatsapp.cjs');
//         wa.init({ META_TOKEN, PHONE_NUMBER_ID, ADMIN_WA, DEBUG, fetch });

let _config = {};

function init(config) {
  _config = config;
}

if (typeof global.lastAlert === 'undefined') global.lastAlert = new Map();
const lastAlert = global.lastAlert;

// Low-level sender
async function waSendRaw(payload) {
  if (!_config.META_TOKEN || !_config.PHONE_NUMBER_ID) {
    console.warn("WA skipped - META_TOKEN or PHONE_NUMBER_ID missing");
    return null;
  }

  const url = `https://graph.facebook.com/v21.0/${_config.PHONE_NUMBER_ID}/messages`;

  try {
    if (_config.DEBUG) console.log("WA OUTGOING PAYLOAD:", JSON.stringify(payload).slice(0, 400));

    const r = await _config.fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${_config.META_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const j = await r.json().catch(() => ({}));

    if (!r.ok) {
      console.error("WA send error", r.status, j);
    } else if (_config.DEBUG) {
      console.log("WA send OK:", r.status, JSON.stringify(j).slice(0, 400));
    }

    return j;
  } catch (err) {
    console.error("waSendRaw exception:", err);
    return null;
  }
}

// Simple text
async function waSendText(to, body) {
  return waSendRaw({
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body }
  });
}

// Template (single, clean version)
async function waSendTemplate(to, templateName, components = []) {
  const payload = {
    messaging_product: "whatsapp",
    to: String(to).replace(/\D+/g, ""),
    type: "template",
    template: {
      name: templateName,
      language: { code: "en_US" },
      components: Array.isArray(components) ? components : []
    }
  };

  const r = await waSendRaw(payload);

  if (r && r.messages && r.messages.length > 0) {
    return { ok: true, resp: r };
  }

  return { ok: false, error: r?.error || r };
}

// Image (poster) – **USES LINK, NOT ID**
async function waSendImage(to, imageUrl, caption = "") {
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "image",
    image: {
      link: imageUrl,          // <<<<<< IMPORTANT
      caption: caption || ""
    }
  };

  const r = await waSendRaw(payload);

  if (r && r.messages) return { ok: true };
  return { ok: false, error: r?.error || r };
}

async function waSendImageLink(to, imageUrl, caption = "") {
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "image",
    image: {
      link: imageUrl,          // use URL, not media ID
      caption: caption || ""
    }
  };

  const r = await waSendRaw(payload);

  if (r && r.messages) return { ok: true, resp: r };
  return { ok: false, error: r?.error || r };
}

// compact buttons (used AFTER new-car quote)
async function sendNewCarButtons(to) {
  const buttons = [
    { type: 'reply', reply: { id: 'BTN_PANIND_YES',    title: 'Yes, Compare' } },
    { type: 'reply', reply: { id: 'BTN_PRICE_BREAKUP', title: 'Price Breakup' } },
    { type: 'reply', reply: { id: 'BTN_NEW_QUOTE',     title: 'Another Quote' } }
  ];
  const interactive = {
    type: 'button',
    body: { text: 'Would you like a *Pan-India on-road price comparison* for this variant?' },
    action: { buttons }
  };
  return waSendRaw({ messaging_product: 'whatsapp', to, type: 'interactive', interactive });
}

// service list (menu) — after greeting
async function waSendListMenu(to) {
  const rows = [
    { id: 'SRV_BEST_DEAL', title: 'Best Car Deal',  description: 'We negotiate the lowest price for you' },
    { id: 'SRV_NEW_CAR',  title: 'New Car Prices',  description: 'Instant on-road prices & offers' },
    { id: 'SRV_USED_CAR', title: 'Pre-Owned Cars', description: 'Certified used inventory' },
    { id: 'SRV_SELL_CAR', title: 'Sell My Car',    description: 'Get best quote for your car' },
    { id: 'SRV_TRADE_IN', title: 'Trade-In / Exchange', description: 'Value your old car against a new one' },
    { id: 'SRV_INSURANCE', title: 'Insurance',       description: 'New, renewal, claims & more' },
    { id: 'SRV_LOAN',     title: 'Loan / Finance', description: 'EMI & Bullet options' }
  ];
  const interactive = {
    type: 'list',
    header: { type: 'text', text: 'VehYra by MR. CAR SERVICES' },
    body:   { text: 'Please choose one option \u{1F447}' },
    footer: { text: 'Premium Deals \u2022 Trusted Service \u2022 Mr. Car' },
    action: { button: 'Select Service', sections: [ { title: 'Available', rows } ] }
  };
  return waSendRaw({ messaging_product: 'whatsapp', to, type: 'interactive', interactive });
}

// used car quick buttons (after used quote)
async function sendUsedCarButtons(to) {
  const buttons = [
    { type: 'reply', reply: { id: 'BTN_USED_MORE',     title: 'More Similar Cars' } },
    { type: 'reply', reply: { id: 'BTN_BOOK_TEST',     title: 'Book Test Drive' } },
    { type: 'reply', reply: { id: 'BTN_CONTACT_SALES', title: 'Contact Sales' } }
  ];
  const interactive = {
    type: 'button',
    body: { text: 'Quick actions:' },
    action: { buttons }
  };
  return waSendRaw({ messaging_product: 'whatsapp', to, type: 'interactive', interactive });
}

// ---------------- Admin alerts (throttled) ----------------
async function sendAdminAlert({ from, name, text }) {
  try {
    if (!_config.META_TOKEN || !_config.PHONE_NUMBER_ID || !_config.ADMIN_WA) return;
    const now = Date.now();
    const prev = lastAlert.get(from) || 0;
    const ALERT_WINDOW_MS = (Number(process.env.ALERT_WINDOW_MINUTES || 10)) * 60 * 1000;
    if (now - prev < ALERT_WINDOW_MS) {
      if (_config.DEBUG) console.log('throttled admin alert for', from);
      return;
    }
    lastAlert.set(from, now);
    const body =
      `\u{1F514} NEW WA LEAD\n` +
      `From: ${from}\n` +
      `Name: ${name || '-'}\n` +
      `Msg: ${String(text || '').slice(0, 1000)}`;
    const resp = await waSendRaw({
      messaging_product: 'whatsapp',
      to: _config.ADMIN_WA,
      type: 'text',
      text: { body }
    });
    if (_config.DEBUG) console.log('sendAdminAlert response', resp);
  } catch (e) {
    console.warn('sendAdminAlert failed', e && e.message ? e.message : e);
  }
}

// small delay helper so we don't spam WhatsApp too fast
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
  init,
  waSendRaw,
  waSendText,
  waSendTemplate,
  waSendImage,
  waSendImageLink,
  sendNewCarButtons,
  waSendListMenu,
  sendUsedCarButtons,
  sendAdminAlert,
  delay
};
