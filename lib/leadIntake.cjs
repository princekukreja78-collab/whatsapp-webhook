// lib/leadIntake.cjs — forward a customer requirement to the bot in plain language
// and it becomes a tracked lead: parsed by AI, written to the CRM and the Google
// Sheet, and put straight into the follow-up queue.
//
//   "LEAD Rahul 9876543210 wants a Creta under 12 lakh, Delhi, exchange his Swift"
//
// Admins only. Anything the AI can't read is asked back rather than guessed.
'use strict';

let _config = {};
function init(config) { _config = config || {}; }

const digits = s => String(s || '').replace(/[^\d]/g, '');
const money = n => `₹${Number(n || 0).toLocaleString('en-IN')}`;

function normalisePhone(raw) {
  const d = digits(raw);
  if (d.length === 10) return `91${d}`;
  if (d.length === 12 && d.startsWith('91')) return d;
  if (d.length === 11 && d.startsWith('0')) return `91${d.slice(1)}`;
  return d.length >= 10 ? d.slice(-12) : null;
}

/**
 * Does this look like a forwarded requirement? Either it is labelled, or — from an
 * admin who is not mid-flow — it simply carries a mobile number and some detail,
 * which is how a forwarded customer message actually arrives.
 */
function isLeadMessage(text, opts = {}) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (/^\s*(lead|new lead|customer|enquiry|requirement|req)\b[\s:,.\-–]/i.test(t)) return true;

  // Never hijack a conversation the bot is already having (photo details, colours…)
  if (opts.pendingFlow) return false;
  // …or a known command
  if (/^\s*(blast|prices|stop|start|new\b|demo\b|hi|hello|menu)/i.test(t)) return false;

  const hasMobile = /(?:^|\D)(?:\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}(?:\D|$)/.test(t);
  return hasMobile && t.split(/\s+/).length >= 3;
}

async function parseLead(text) {
  const fallback = { phone: normalisePhone(text) };
  if (!_config.openai) return fallback;
  try {
    const resp = await _config.openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `Read an Indian car dealer's note about a customer and return ONLY JSON:
{"name":"","phone":"","model":"","variant":"","budget":"","city":"","fuel":"","type":"","exchange":"","requirement":""}
- phone: digits only, as written
- budget: plain digits in rupees ("12 lakh" → 1200000, "under 8L" → 800000); "" if not stated
- type: "new" or "used" if stated, else ""
- exchange: the car they want to trade in, if mentioned
- requirement: one short line summarising what they want, in your own words
- Leave any field "" rather than guessing. Return ONLY the JSON.`
        },
        { role: 'user', content: String(text || '') }
      ],
      temperature: 0,
      max_tokens: 300
    });
    const m = (resp.choices?.[0]?.message?.content || '').match(/\{[\s\S]*\}/);
    if (!m) return fallback;
    const p = JSON.parse(m[0]);
    return {
      name: String(p.name || '').trim(),
      phone: normalisePhone(p.phone) || fallback.phone,
      model: String(p.model || '').trim(),
      variant: String(p.variant || '').trim(),
      budget: Number(String(p.budget || '').replace(/[^\d]/g, '')) || 0,
      city: String(p.city || '').trim(),
      fuel: String(p.fuel || '').trim(),
      type: String(p.type || '').trim(),
      exchange: String(p.exchange || '').trim(),
      requirement: String(p.requirement || '').trim()
    };
  } catch (e) {
    console.warn('LeadIntake: parse failed', e.message);
    return fallback;
  }
}

/**
 * Handle a forwarded requirement. Returns true when it was dealt with.
 */
async function handleForwardedLead(from, text) {
  const parsed = await parseLead(text);

  if (!parsed.phone) {
    await _config.waSendText(from,
      'I could not find a mobile number in that note. Send it again with the number, e.g.\n\n' +
      '_LEAD Rahul 9876543210 wants a Creta under 12 lakh, Delhi_');
    return true;
  }

  const name = parsed.name || 'Customer';
  const car = [parsed.model, parsed.variant].filter(Boolean).join(' ');
  const lead = {
    id: `FWD${Date.now()}`,
    name,
    phone: parsed.phone,
    status: 'forwarded-lead',
    source: `forwarded by ${from}`,
    timestamp: new Date().toISOString(),
    car,
    city: parsed.city || '',
    budget: parsed.budget || 0,
    fuel: parsed.fuel || '',
    carType: parsed.type || '',
    exchange: parsed.exchange || '',
    interest: parsed.requirement || String(text || '').slice(0, 200),
    raw: { text }
  };

  // 1. CRM
  try {
    const leads = _config.loadCrmLeadsSafe ? _config.loadCrmLeadsSafe() : [];
    leads.push(lead);
    if (_config.saveCrmLeadsSafe) _config.saveCrmLeadsSafe(leads);
  } catch (e) { console.warn('LeadIntake: CRM save failed', e.message); }

  // 2. Google Sheet
  if (typeof _config.pushLeadToGoogleSheet === 'function') {
    _config.pushLeadToGoogleSheet(lead).catch(() => {});
  }

  // 3. Follow-up sequence starts now
  let followOn = false;
  try {
    if (_config.followUp && typeof _config.followUp.addToQueue === 'function') {
      _config.followUp.addToQueue({
        phone: parsed.phone,
        name,
        model: parsed.model || '',
        variant: parsed.variant || '',
        lastQuotePrice: parsed.budget || 0
      });
      followOn = true;
    }
  } catch (e) { console.warn('LeadIntake: follow-up enqueue failed', e.message); }

  // 4. Confirm what was understood, so a wrong read is caught immediately
  const lines = [
    '✅ *Lead saved*',
    '',
    `👤 ${name}`,
    `📞 ${parsed.phone.replace(/^91/, '+91 ')}`,
    car ? `🚘 Looking for: *${car}*` : null,
    parsed.budget ? `💰 Budget: ${money(parsed.budget)}` : null,
    parsed.city ? `📍 ${parsed.city}` : null,
    parsed.exchange ? `🔁 Exchange: ${parsed.exchange}` : null,
    parsed.requirement ? `📝 ${parsed.requirement}` : null,
    '',
    followOn ? '🔔 Follow-up sequence started — the customer will be nudged automatically.' : '⚠️ Saved, but the follow-up engine is unavailable.',
    '📊 Added to the CRM and the Google Sheet.'
  ].filter(Boolean);
  await _config.waSendText(from, lines.join('\n'));

  console.log(`LeadIntake: ${name} ${parsed.phone} for ${car || 'unspecified'} (forwarded by ${from})`);
  return true;
}

module.exports = { init, isLeadMessage, handleForwardedLead, parseLead };
