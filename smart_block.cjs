// ===== smart loader: picks NEW vs USED sheet based on message/type =====
async function loadPricingByType(messageOrType) {
  try {
    const t = String(messageOrType||'').toLowerCase();
    // detect intent (keywords for used car)
    const isUsed = [
      'used','pre-owned','preowned','second hand','2nd hand',
      'km','odometer','owner','model year','year',
      '2020','2021','2022','2023','2024','2025'
    ].some(k => t.includes(k))
      || t === 'used' || t === 'preowned' || t === 'pre-owned';

    const urlNew  = process.env.PRICING_SHEET_URL_NEW  || '';
    const urlUsed = process.env.PRICING_SHEET_URL_USED || '';
    const chosenUrl = isUsed ? (urlUsed || urlNew) : (urlNew || urlUsed);
    if (!chosenUrl) return await loadPricing();

    const r = await fetch(chosenUrl);
    const text = await r.text();
    const [head, ...rows] = text.trim().split(/\r?\n/).map(l => l.split(','));
    const keys = head.map(k => k.trim().toLowerCase().replace(/\s+/g,'_'));
    return rows.map(r => Object.fromEntries(r.map((v,i)=>[keys[i], (v||'').trim()])));
  } catch (e) {
    console.error('loadPricingByType error:', e.message);
    return await loadPricing();
  }
}

app.get('/pricing-by-type', async (req, res) => {
  const t = req.query.type || 'auto';
  const data = await loadPricingByType(t);
  res.json({ type: t, count: (data||[]).length, sample: (data||[]).slice(0,3) });
});
