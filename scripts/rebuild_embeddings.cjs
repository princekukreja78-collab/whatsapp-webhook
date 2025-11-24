// scripts/rebuild_embeddings.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const fetch = global.fetch || require('node-fetch');

const BROCHURE_PATH = path.resolve(__dirname, '..', 'brochures', 'index.json');
const OUT_DIR = path.resolve(__dirname, '..', '.crm_data');
const OUT_FILE = path.join(OUT_DIR, 'embeddings.json');
const BACKUP_DIR = path.resolve(__dirname, '..', 'backups');
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const EMBED_MODEL = process.env.EMBED_MODEL || 'text-embedding-3-small';

if (!OPENAI_KEY) {
  console.error('OPENAI_API_KEY missing in env. Set it and re-run.');
  process.exit(1);
}

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

async function callOpenAIEmbedding(text) {
  const resp = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ input: text, model: EMBED_MODEL })
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Embeddings API failed: ${resp.status} ${txt}`);
  }
  const j = await resp.json();
  return j.data?.[0]?.embedding || null;
}

(async () => {
  try {
    ensureDir(OUT_DIR);
    ensureDir(BACKUP_DIR);

    if (!fs.existsSync(BROCHURE_PATH)) {
      console.error('brochures/index.json not found:', BROCHURE_PATH);
      process.exit(1);
    }

    const raw = fs.readFileSync(BROCHURE_PATH, 'utf8');
    const items = JSON.parse(raw);

    const docs = [];
    console.log(`Found ${items.length} brochures — building embeddings...`);

    for (let i = 0; i < items.length; i++) {
      const b = items[i];
      const textParts = [];
      if (b.title) textParts.push(b.title);
      if (b.brand) textParts.push(`Brand: ${b.brand}`);
      if (Array.isArray(b.variants) && b.variants.length) textParts.push(`Variants: ${b.variants.join(', ')}`);
      if (b.summary) textParts.push(b.summary);
      if (b.helpline) textParts.push(`Helpline: ${b.helpline}`);

      const text = textParts.join('\n');
      process.stdout.write(`(${i+1}/${items.length}) ${b.id || b.title} ... `);

      const vector = await callOpenAIEmbedding(text);
      if (!vector) {
        console.log('failed.');
        continue;
      }
      docs.push({
        id: b.id || b.title || `doc-${i}`,
        text,
        meta: { title: b.title || '', brand: b.brand || '', url: b.url || '', source: 'brochure' },
        vector
      });
      console.log('ok');

      await new Promise(r => setTimeout(r, 120));
    }

    const out = { meta: { createdAt: Date.now(), model: EMBED_MODEL, count: docs.length }, docs };

    if (fs.existsSync(OUT_FILE)) {
      const bak = path.join(BACKUP_DIR, `embeddings-${new Date().toISOString().replace(/[:.]/g,'-')}.json`);
      fs.copyFileSync(OUT_FILE, bak);
      console.log('Previous embeddings backed up to', bak);
    }

    fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2), 'utf8');
    console.log('Embeddings saved to', OUT_FILE);
    process.exit(0);

  } catch (e) {
    console.error('rebuild_embeddings error', e?.message || e);
    process.exit(2);
  }
})();

