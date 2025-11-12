require('dotenv').config();
const fetch = global.fetch || require('node-fetch');
const { parse } = require('csv-parse/sync');

const CSV_URL = process.env.SHEET_TOYOTA_CSV_URL;
if (!CSV_URL) { console.error('Please set SHEET_TOYOTA_CSV_URL in .env'); process.exit(1); }

async function loadCsv(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('Fetch failed ' + r.status);
  const txt = await r.text();
  const rows = parse(txt, { columns: true, skip_empty_lines: true });
  return rows;
}

function simpleScoreRow(row, q) {
  const s = q.toLowerCase();
  const values = Object.values(row).map(v => String(v||'').toLowerCase()).join(' ');
  const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
  let score = 0;
  for (const t of tokens) if (values.includes(t)) score++;
  return score;
}

(async ()=>{
  try {
    console.log('Fetching CSV from', CSV_URL);
    const rows = await loadCsv(CSV_URL);
    console.log('Rows:', rows.length);
    const queries = [
      "Delhi Hycross ZXO individual",
      "HR Fortuner 4x2 AT individual",
      "Fortuner Leader Edition attitude black",
      "Hycross ZX OT company"
    ];
    for (const q of queries) {
      const scored = rows.map((r,i)=>({i,score:simpleScoreRow(r,q),row:r}));
      scored.sort((a,b)=>b.score-a.score);
      const top = scored.slice(0,5).filter(s=>s.score>0);
      console.log('\\nQuery:', q);
      if (!top.length) { console.log('  No matches'); continue; }
      for (const t of top) {
        console.log('  score=',t.score,' — sample fields:', {
          MODEL: t.row.Model || t.row.MODEL || t.row['Model Name'] || '',
          PRICE: (t.row['On Road Price']||t.row['ON ROAD PRICE']||t.row['price']||'').toString().slice(0,80),
          ROW_SAMPLE: Object.fromEntries(Object.entries(t.row).slice(0,6))
        });
      }
    }
  } catch (e) {
    console.error('Error', e && e.stack ? e.stack : e);
  }
})();
