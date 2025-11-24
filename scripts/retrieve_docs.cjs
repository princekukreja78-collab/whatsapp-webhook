// scripts/retrieve_docs.cjs
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const fetch = global.fetch || require('node-fetch');

const EMBED_FILE = path.resolve(__dirname, '..', '.crm_data', 'embeddings.json');
const SYN_FILE = path.resolve(__dirname, '..', '.crm_data', 'synonyms.json');
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const EMBED_MODEL = process.env.EMBED_MODEL || 'text-embedding-3-small';

if (!OPENAI_KEY) {
  console.error('OPENAI_API_KEY not set in env');
  process.exit(1);
}

function loadJson(p) {
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8') || 'null'); } catch (e) { return null; }
}

function applySynonyms(text, synMap) {
  if (!synMap || typeof synMap !== 'object') return text;
  let out = text.toLowerCase();
  for (const [k, v] of Object.entries(synMap)) {
    const re = new RegExp(`\\b${k}\\b`, 'g');
    out = out.replace(re, v);
  }
  return out;
}

async function embedText(text) {
  const r = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: EMBED_MODEL, input: text })
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error('Embedding API failed: ' + txt);
  }
  const j = await r.json();
  return j.data?.[0]?.embedding || null;
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]*b[i];
    na += a[i]*a[i];
    nb += b[i]*b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * retrieveTopDocs(query, k)
 * returns array of top-k docs with score and snippet
 */
async function retrieveTopDocs(query, k = 3) {
  const embeddings = loadJson(EMBED_FILE);
  if (!embeddings || !Array.isArray(embeddings.docs)) {
    console.warn('No embeddings found at', EMBED_FILE);
    return [];
  }
  const syn = loadJson(SYN_FILE) || {};
  const normalized = applySynonyms(query, syn);
  const qVec = await embedText(normalized);
  if (!qVec) return [];

  const scored = [];
  for (const doc of embeddings.docs) {
    const score = cosine(qVec, doc.vector);
    scored.push({ score, doc });
  }
  scored.sort((a,b) => b.score - a.score);
  return scored.slice(0, k).map(s => ({ score: s.score, id: s.doc.id, meta: s.doc.meta, text: s.doc.text }));
}

// If run directly from CLI, allow quick test
if (require.main === module) {
  (async () => {
    const q = process.argv.slice(2).join(' ');
    if (!q) {
      console.log('Usage: node scripts/retrieve_docs.cjs "your question here"');
      process.exit(1);
    }
    try {
      const out = await retrieveTopDocs(q, 3);
      console.log(JSON.stringify(out, null, 2));
    } catch (e) {
      console.error('retrieve_docs error', e && e.message ? e.message : e);
    }
  })();
}

module.exports = { retrieveTopDocs };

