// lib/followUp.cjs — Auto follow-up engine for dead leads
// Sends scheduled nudges to customers who enquired but didn't convert.
// Runs during working hours (10am-7pm IST, Mon-Sat).
// Stops the moment customer replies.

const fs = require('fs');
const path = require('path');

let _config = {};

const FOLLOWUP_FILE = path.join(__dirname, '..', 'followup_queue.json');
let queue = []; // { phone, name, model, variant, lastQuotePrice, enquiredAt, stage, nextFollowAt, stopped }

function init(config) {
  _config = config;
  _loadQueue();
  // Run checker every 5 minutes
  setInterval(_processQueue, 5 * 60 * 1000);
  console.log(`FollowUp: loaded ${queue.length} leads in queue`);
}

function _loadQueue() {
  try {
    if (fs.existsSync(FOLLOWUP_FILE)) {
      queue = JSON.parse(fs.readFileSync(FOLLOWUP_FILE, 'utf8')) || [];
    }
  } catch (e) { queue = []; }
}

function _saveQueue() {
  try {
    fs.writeFileSync(FOLLOWUP_FILE, JSON.stringify(queue, null, 2), 'utf8');
  } catch (e) { console.warn('FollowUp: save failed', e.message); }
}

// IST working hours check (10am-7pm, Mon-Sat)
function _isWorkingHours() {
  const now = new Date();
  const istMinutes = (now.getUTCHours() * 60 + now.getUTCMinutes()) + 330; // UTC+5:30
  const istHour = Math.floor((istMinutes % 1440) / 60);
  const day = now.getUTCDay();
  // Adjust day if IST crosses midnight
  const istDay = istMinutes >= 1440 ? (day + 1) % 7 : day;
  if (istDay === 0) return false; // Sunday
  return istHour >= 10 && istHour < 19;
}

// ==================== FOLLOW-UP STAGES ====================
// Stage 0: Just enquired (no follow-up yet)
// Stage 1: Day 1 — soft reminder
// Stage 2: Day 3 — price urgency
// Stage 3: Day 7 — better deal found
// Stage 4: Day 14 — final nudge + alt model
// Stage 5: Done (stop)

const STAGE_DELAYS = {
  0: 1,   // 1 day after enquiry
  1: 3,   // 3 days after enquiry
  2: 7,   // 7 days
  3: 14,  // 14 days
};

function _getMessage(lead, stage) {
  const name = lead.name || 'there';
  const model = lead.model || 'the car';
  const price = lead.lastQuotePrice || '';
  const priceStr = price ? ` at ${_fmtPrice(price)}` : '';

  switch (stage) {
    case 0:
      return `Hi ${name}, still looking for *${model}*? We have fresh deals available today.\n\nReply *YES* to get the latest price or *STOP* to opt out.`;

    case 1:
      return `Hi ${name}, quick update on *${model}* —\n\n` +
        `Prices may increase next month due to new regulations. ` +
        `Lock your price now${priceStr}.\n\n` +
        `Reply *YES* for updated pricing or *STOP* to opt out.`;

    case 2:
      return `Hi ${name}, we found a *better deal* on ${model}!\n\n` +
        `Our dealer network has new offers this week. Want us to negotiate the best price for you?\n\n` +
        `Reply *YES* or *STOP* to opt out.`;

    case 3:
      return `Hi ${name}, last check — are you still in the market for *${model}*?\n\n` +
        `If you've changed your mind, we can help with other options too.\n\n` +
        `Reply *YES* to continue or *STOP* to opt out.`;

    default:
      return null;
  }
}

// ==================== PUBLIC API ====================

/**
 * Add a lead to the follow-up queue after any quote/enquiry.
 * Call this after sending a price quote or enquiry confirmation.
 */
function addToQueue(lead) {
  const { phone, name, model, variant, lastQuotePrice } = lead;
  if (!phone) return;

  // Check if already in queue
  const existing = queue.find(q => q.phone === phone && q.model === model);
  if (existing) {
    // Reset — they enquired again, restart follow-up
    existing.stage = 0;
    existing.stopped = false;
    existing.enquiredAt = new Date().toISOString();
    existing.lastQuotePrice = lastQuotePrice || existing.lastQuotePrice;
    existing.nextFollowAt = _nextFollowTime(0);
    _saveQueue();
    return;
  }

  queue.push({
    phone,
    name: name || '',
    model: model || '',
    variant: variant || '',
    lastQuotePrice: lastQuotePrice || 0,
    enquiredAt: new Date().toISOString(),
    stage: 0,
    nextFollowAt: _nextFollowTime(0),
    stopped: false
  });

  _saveQueue();
  console.log(`FollowUp: added ${phone} for ${model}`);
}

/**
 * Stop follow-ups for a customer (they replied or said STOP).
 */
function stopFollowUp(phone) {
  const lead = queue.find(q => q.phone === phone && !q.stopped);
  if (lead) {
    lead.stopped = true;
    _saveQueue();
    console.log(`FollowUp: stopped for ${phone}`);
  }
}

/**
 * Mark customer as active (they replied to something).
 * Resets their follow-up timer since they're engaged.
 */
function markActive(phone) {
  const lead = queue.find(q => q.phone === phone && !q.stopped);
  if (lead) {
    // They're active — push next follow-up further out
    lead.nextFollowAt = _nextFollowTime(lead.stage);
  }
}

/**
 * Check if message is a STOP request.
 */
function isStopRequest(text) {
  return /^(stop|unsubscribe|opt out|no more|don'?t message|band karo)\s*$/i.test((text || '').trim());
}

// ==================== INTERNAL ====================

function _nextFollowTime(stage) {
  const days = STAGE_DELAYS[stage];
  if (!days) return null;
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

async function _processQueue() {
  if (!_isWorkingHours()) return;
  if (!_config.waSendText) return;

  const now = new Date().toISOString();
  let sent = 0;

  for (const lead of queue) {
    if (lead.stopped) continue;
    if (!lead.nextFollowAt) continue;
    if (lead.nextFollowAt > now) continue;
    if (lead.stage > 3) { lead.stopped = true; continue; }

    const msg = _getMessage(lead, lead.stage);
    if (!msg) { lead.stopped = true; continue; }

    try {
      await _config.waSendText(lead.phone, msg);
      console.log(`FollowUp: sent stage ${lead.stage} to ${lead.phone} (${lead.model})`);

      lead.stage++;
      lead.nextFollowAt = _nextFollowTime(lead.stage);
      sent++;

      // Don't spam — max 5 per cycle, 2s gap
      if (sent >= 5) break;
      await new Promise(r => setTimeout(r, 2000));
    } catch (e) {
      console.warn(`FollowUp: send failed for ${lead.phone}`, e.message);
    }
  }

  if (sent > 0) _saveQueue();
}

function _fmtPrice(p) {
  if (!p || p <= 0) return '';
  if (p >= 10000000) return `₹${(p / 10000000).toFixed(2)} Cr`;
  if (p >= 100000) return `₹${(p / 100000).toFixed(1)}L`;
  return `₹${p.toLocaleString('en-IN')}`;
}

function getQueueStats() {
  const active = queue.filter(q => !q.stopped).length;
  const stopped = queue.filter(q => q.stopped).length;
  return { total: queue.length, active, stopped };
}

module.exports = {
  init,
  addToQueue,
  stopFollowUp,
  markActive,
  isStopRequest,
  getQueueStats
};
