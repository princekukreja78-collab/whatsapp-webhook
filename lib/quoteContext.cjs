// ==================================================
// QUOTE CONTEXT — the row behind the last quote, kept across restarts
// ==================================================
// The Compare and Price Breakup buttons need the sheet row that produced the
// quote. That lived in a plain in-memory Map, so every deploy or restart threw
// it away and the next button press answered "I could not retrieve the variant
// again" — on a host that redeploys often, that is most presses.
//
// This is a Map subclass so no call site has to change: it hydrates from disk at
// boot and writes back on set/delete. Entries expire after a day, which is the
// WhatsApp free-form window anyway.

const fs = require('fs');
const path = require('path');

const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 500;

class PersistentContext extends Map {
  constructor(file) {
    super();
    this.file = file;
    this._hydrate();
  }

  _hydrate() {
    try {
      if (!fs.existsSync(this.file)) return;
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const now = Date.now();
      let kept = 0;
      for (const [k, v] of Object.entries(raw || {})) {
        if (!v || (v._at && now - v._at > TTL_MS)) continue;
        super.set(k, v);
        kept++;
      }
      console.log(`QuoteContext: ${kept} quote context(s) restored`);
    } catch (e) {
      console.warn('QuoteContext: hydrate failed', e && e.message);
    }
  }

  _persist() {
    try {
      const now = Date.now();
      const obj = {};
      // newest first, so the cap drops the stalest
      const rows = [...super.entries()]
        .filter(([, v]) => v && (!v._at || now - v._at <= TTL_MS))
        .sort((a, b) => (b[1]._at || 0) - (a[1]._at || 0))
        .slice(0, MAX_ENTRIES);
      for (const [k, v] of rows) obj[k] = v;
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(obj), 'utf8');
    } catch (e) {
      console.warn('QuoteContext: persist failed', e && e.message);
    }
  }

  set(k, v) {
    if (v && typeof v === 'object' && !v._at) v._at = Date.now();
    super.set(k, v);
    this._persist();
    return this;
  }

  get(k) {
    const v = super.get(k);
    if (v && v._at && Date.now() - v._at > TTL_MS) { this.delete(k); return undefined; }
    return v;
  }

  delete(k) {
    const r = super.delete(k);
    if (r) this._persist();
    return r;
  }
}

/** Install as global.panIndiaPrompt, replacing whatever plain Map was there. */
function install(dataDir) {
  const file = path.join(dataDir, 'quote_context.json');
  const store = new PersistentContext(file);
  // carry over anything a module already put in the plain Map at require time
  if (global.panIndiaPrompt instanceof Map) {
    for (const [k, v] of global.panIndiaPrompt.entries()) store.set(k, v);
  }
  global.panIndiaPrompt = store;
  return store;
}

module.exports = { install, PersistentContext };
