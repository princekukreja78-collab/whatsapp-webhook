// MR. CAR — Inventory Studio, hosted copy.
// Served by the bot backend itself at /studio.html, so every call is same-origin.
// The desktop copy in ~/Desktop/mr-car-dashboard keeps the backend picker.

let editingId = null;
let editingCar = null;
let carType = 'used';
let schemes = [];
let selectedSchemes = new Set();
let editingSchemeId = null;
let selectedPlans = new Set(['reducing', 'bullet']);

const BALLOON_CATEGORIES = {
  new: ['High Selling OEMs', 'Other OEMs', 'EV Cars'],
  used: ['0-59 months', '60-83 months', '84-107 months']
};

function syncBalloonCategories() {
  const preset = $('s_balloonPreset').value;
  const cats = BALLOON_CATEGORIES[preset] || [];
  $('s_balloonCategory').innerHTML = cats.map(c => `<option value="${c}">${c}</option>`).join('') || '<option value="">—</option>';
  $('wrapCategory').style.display = cats.length ? '' : 'none';
  renderSchemePreview();
}

const PLAN_LABELS = {
  reducing: 'Normal EMI',
  bullet: 'Bullet',
  balloon: 'Balloon / Flex Pay'
};

function renderPlanChips() {
  $('planChips').innerHTML = Object.entries(PLAN_LABELS).map(([k, label]) =>
    `<span class="chip ${selectedPlans.has(k) ? 'on' : ''}" onclick="togglePlan('${k}')">${label}</span>`).join('');
  $('wrapBullet').style.display = selectedPlans.has('bullet') ? '' : 'none';
  const bal = selectedPlans.has('balloon');
  $('wrapBalloon').style.display = bal ? '' : 'none';
  $('wrapExt').style.display = bal ? '' : 'none';
  $('wrapPreset').style.display = bal ? '' : 'none';
  $('wrapCategory').style.display = bal && $('s_balloonPreset').value ? '' : 'none';
  renderSchemePreview();
}

function togglePlan(k) {
  if (selectedPlans.has(k)) {
    if (selectedPlans.size === 1) return toast('A scheme needs at least one plan', true);
    selectedPlans.delete(k);
  } else selectedPlans.add(k);
  renderPlanChips();
}

// Live sanity check on a ₹20L loan so the numbers can be eyeballed before saving
function renderSchemePreview() {
  const el = $('schemePreview');
  if (!el) return;
  const roi = Number($('s_roi').value);
  if (!roi) { el.innerHTML = '<span class="hint">Enter an interest rate to preview the EMIs.</span>'; return; }
  const price = 2000000;
  const downPct = Number($('s_minDownPct').value) || 0;
  const n = Math.min(Number($('s_maxTenure').value) || 60, 60);
  const loan = Math.round(price * (1 - downPct / 100));
  const r = roi / 1200, f = Math.pow(1 + r, n);
  const term = r > 0 ? (loan * r * f) / (f - 1) : loan / n;
  const money = v => '₹' + Math.round(v).toLocaleString('en-IN');
  const parts = [`<b>Normal</b> ${money(term)}/mo`];
  if (selectedPlans.has('bullet')) {
    const pct = (Number($('s_bulletPct').value) || 25) / 100;
    const bt = loan * pct;
    const base = r > 0 ? ((loan - bt) * r * f) / (f - 1) : (loan - bt) / n;
    parts.push(`<b style="color:var(--accent2)">Bullet</b> ${money(base + bt * r)}/mo + ${money(bt / Math.max(1, Math.floor(n / 12)))}/yr`);
  }
  if (selectedPlans.has('balloon')) {
    const bpct = (Number($('s_balloonPct').value) || 35) / 100;
    const B = loan * bpct;
    const bEmi = r > 0 ? term - (B * r) / (f - 1) : (loan - B) / n;
    const ext = Number($('s_extensionTenure').value) || 36;
    const fe = Math.pow(1 + r, ext);
    const extEmi = r > 0 ? (B * r * fe) / (fe - 1) : B / ext;
    parts.push(`<b style="color:var(--green)">Flex Pay</b> ${money(bEmi)}/mo, balloon ${money(B)} (or extend ${ext} mo @ ${money(extEmi)})`);
  }
  el.innerHTML = `<div class="hint" style="margin:0 0 6px">Preview on a ₹20,00,000 car · ${downPct}% down · ${n} months</div>${parts.join(' &nbsp;·&nbsp; ')}`;
}

const $ = id => document.getElementById(id);

// Two logins share this page. Staff add cars; the owner publishes, deletes and
// prices. The server enforces it either way — hiding the buttons just stops
// staff walking into a 403.
let ROLE = 'admin';
const isStaff = () => ROLE === 'staff';
async function loadRole() {
  try {
    const r = await fetch(API() + '/api/inventory/whoami', { headers: HDRS() });
    const d = await r.json();
    ROLE = d && d.role === 'staff' ? 'staff' : 'admin';
  } catch (e) { ROLE = 'admin'; }
  document.body.classList.toggle('staffRole', isStaff());
  const badge = $('roleBadge');
  if (badge) badge.textContent = isStaff() ? 'Staff — add & edit drafts' : '';
}
const API = () => $('envSel').value;
const HDRS = () => ({ 'x-admin-token': $('tokenInput').value.trim() });
const JHDRS = () => ({ ...HDRS(), 'Content-Type': 'application/json' });

function toast(msg, bad) {
  const t = $('toast');
  t.textContent = msg;
  t.style.borderColor = bad ? '#ef5350' : '#25d366';
  t.style.display = 'block';
  clearTimeout(t._h);
  t._h = setTimeout(() => (t.style.display = 'none'), 2600);
}

async function api(path, opts = {}) {
  const r = await fetch(API() + path, opts);
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.ok === false) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

// ---------------- settings persistence + connectivity ----------------
function initSettings() {
  // Hosted copy: the API is this same server, so there is nothing to choose.
  $('envSel').value = '';
  $('tokenInput').value = localStorage.getItem('mcinv_token') || '';
  $('tokenInput').onchange = () => { localStorage.setItem('mcinv_token', $('tokenInput').value.trim()); refreshAll(); };
}

async function checkConn() {
  try {
    await api('/api/inventory/loan-schemes', { headers: HDRS() });
    $('connDot').className = 'dot ok';
    return true;
  } catch (e) {
    $('connDot').className = 'dot';
    return false;
  }
}

// ---------------- tabs ----------------
document.querySelectorAll('.tab').forEach(tab => {
  tab.onclick = () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    $('page-' + tab.dataset.page).classList.add('active');
    if (tab.dataset.page === 'cars') loadCars();
    if (tab.dataset.page === 'schemes') loadSchemes();
  };
});
function gotoTab(name) { document.querySelector(`.tab[data-page=${name}]`).click(); }

// ---------------- cars list ----------------
function money(n) {
  n = Number(n) || 0;
  if (n >= 1e7) return '₹' + (n / 1e7).toFixed(2).replace(/\.?0+$/, '') + ' Cr';
  if (n >= 1e5) return '₹' + (n / 1e5).toFixed(2).replace(/\.?0+$/, '') + ' L';
  return n ? '₹' + n.toLocaleString('en-IN') : '—';
}
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function loadCars() {
  if (!(await checkConn())) { $('carGrid').innerHTML = '<p style="color:#8b96a5">Not connected — check backend + admin token (top right).</p>'; return; }
  const q = new URLSearchParams();
  if ($('fStatus').value) q.set('status', $('fStatus').value);
  if ($('fType').value) q.set('type', $('fType').value);
  if ($('fQ').value.trim()) q.set('q', $('fQ').value.trim());
  const { cars } = await api('/api/inventory/cars?' + q, { headers: HDRS() });
  const grid = $('carGrid');
  if (!cars.length) { grid.innerHTML = '<p style="color:#8b96a5">No cars yet — add your first deal from the ➕ Add Car tab.</p>'; return; }
  grid.innerHTML = cars.map(c => {
    const cover = (c.photos || []).find(p => p.cover) || (c.photos || [])[0];
    const title = [c.year, c.make, c.model, c.variant].filter(Boolean).join(' ');
    const price = Number(c.price?.offer) || Number(c.price?.asking) || Number(c.price?.onRoad) || 0;
    const meta = [c.km ? Number(c.km).toLocaleString('en-IN') + ' km' : null, c.fuel, c.transmission].filter(Boolean).join(' • ');
    return `<div class="carCard">
      <div class="thumb" style="${cover ? `background-image:url('${API()}${cover.url}')` : ''}">${cover ? '' : '🚘'}</div>
      <div class="body">
        <span class="badge ${c.status}">${c.status}</span>
        <span class="badge ${c.type}">${c.type}</span>
        ${c.consignment ? `<span class="badge live" title="${esc(c.sourceDealerName || 'partner dealer')}">consignment</span>` : ''}
        <h3>${esc(title)}</h3>
        <div class="meta">${esc(meta || c.id)}</div>
        <div class="price">${money(price)}</div>
        ${c.deal?.headline ? `<div class="meta">🔥 ${esc(c.deal.headline)}</div>` : ''}
      </div>
      <div class="actions">
        ${isStaff() && c.status === 'live' ? '' : `<button onclick="editCar('${c.id}')">✏️ Edit</button>`}
        <button class="ghost" onclick="openPreview('${c.id}')">👁</button>
        ${isStaff() ? '' : `
        <button class="${c.status === 'live' ? 'ghost' : 'success'}" onclick="setStatus('${c.id}','${c.status === 'live' ? 'draft' : 'live'}')">${c.status === 'live' ? '⏸ Unpublish' : '🚀 Publish'}</button>
        <button class="ghost" onclick="sendCard('${c.id}')">📲</button>
        <button class="ghost" onclick="blastDeal('${c.id}')" title="Send to matched leads">📣</button>
        <button class="ghost" onclick="setStatus('${c.id}','sold')">SOLD</button>
        <button class="danger" onclick="delCar('${c.id}')">🗑</button>`}
      </div>
    </div>`;
  }).join('');
}
['fStatus', 'fType'].forEach(id => { $(id).onchange = loadCars; });
$('fQ').onkeydown = e => { if (e.key === 'Enter') loadCars(); };

async function setStatus(id, status) {
  try {
    await api(`/api/inventory/cars/${id}/status`, { method: 'POST', headers: JHDRS(), body: JSON.stringify({ status }) });
    toast(status === 'live' ? '🚀 Live on Vehyra' : `Status → ${status}`);
    loadCars();
    if (editingId === id) editCar(id);
  } catch (e) { toast(e.message, true); }
}

async function delCar(id) {
  if (!confirm(`Delete ${id} permanently (photos too)?`)) return;
  try { await api(`/api/inventory/cars/${id}`, { method: 'DELETE', headers: HDRS() }); toast('Deleted'); loadCars(); }
  catch (e) { toast(e.message, true); }
}

// ---------------- add / edit form ----------------
function setType(t) {
  carType = t;
  $('segUsed').classList.toggle('on', t === 'used');
  $('segNew').classList.toggle('on', t === 'new');
  $('usedRow').style.opacity = t === 'used' ? 1 : 0.55;
}

function parseSpecs(text) {
  const out = []; let group = '';
  for (let line of String(text || '').split('\n')) {
    line = line.trim();
    if (!line) continue;
    const g = /^\[(.+)\]$/.exec(line) || /^#+\s*(.+)$/.exec(line);
    if (g) { group = g[1].trim(); continue; }
    const i = line.indexOf(':');
    if (i > 0) out.push({ group, label: line.slice(0, i).trim(), value: line.slice(i + 1).trim() });
    else out.push({ group, label: line, value: '' });
  }
  return out;
}
function specsToText(specs) {
  let out = [], g = '';
  for (const s of specs || []) {
    if ((s.group || '') !== g) { g = s.group || ''; if (g) out.push(`[${g}]`); }
    out.push(`${s.label}: ${s.value}`);
  }
  return out.join('\n');
}

function formBody() {
  return {
    type: carType,
    make: $('c_make').value.trim(), model: $('c_model').value.trim(), variant: $('c_variant').value.trim(),
    year: $('c_year').value.trim(), colour: $('c_colour').value.trim(),
    km: $('c_km').value.trim(), fuel: $('c_fuel').value, transmission: $('c_transmission').value,
    owners: $('c_owners').value.trim(), registration: $('c_registration').value.trim(),
    sourceDealerName: $('c_sourceDealerName').value.trim(),
    sourceDealerPhone: $('c_sourceDealerPhone').value.trim(),
    sourceDealerCity: $('c_sourceDealerCity').value.trim(),
    tradePrice: Number($('c_tradePrice').value) || 0,
    consignment: !!$('c_sourceDealerPhone').value.trim(),
    price: { asking: Number($('p_asking').value) || 0, offer: Number($('p_offer').value) || 0, onRoad: Number($('p_onRoad').value) || 0 },
    deal: {
      headline: $('d_headline').value.trim(), discount: $('d_discount').value.trim(),
      exchangeBonus: $('d_exchangeBonus').value.trim(), freebies: $('d_freebies').value.trim(),
      validTill: $('d_validTill').value.trim()
    },
    features: $('c_features').value.split('\n').map(s => s.trim()).filter(Boolean),
    specs: parseSpecs($('c_specs').value),
    loanSchemeIds: [...selectedSchemes]
  };
}

async function saveCar() {
  const b = formBody();
  if (!b.make || !b.model) return toast('Make and model are required', true);
  try {
    let data;
    if (editingId) data = await api(`/api/inventory/cars/${editingId}`, { method: 'PUT', headers: JHDRS(), body: JSON.stringify(b) });
    else data = await api('/api/inventory/cars', { method: 'POST', headers: JHDRS(), body: JSON.stringify(b) });
    editingId = data.car.id; editingCar = data.car;
    toast(`💾 Saved ${data.car.id}`);
    enterEditMode(data.car);
  } catch (e) { toast(e.message, true); }
}

function enterEditMode(car) {
  $('editTitle').textContent = `Editing ${car.id} — ${[car.year, car.make, car.model].filter(Boolean).join(' ')}`;
  $('photoLocked').style.display = 'none';
  $('photoTools').style.display = 'block';
  $('publishBtn').style.display = isStaff() ? 'none' : '';
  $('publishBtn').textContent = car.status === 'live' ? '⏸ Unpublish' : '🚀 Publish Live';
  $('previewBtn').style.display = '';
  $('sendBtn').style.display = isStaff() ? 'none' : '';
  $('enrichBtn').style.display = '';
  $('webPhotoBtn').style.display = '';
  renderPhotos(car);
}

async function fetchWebPhotos() {
  if (!editingId) return;
  const colours = prompt('Colours to search (comma separated):', $('c_colour').value || '');
  if (colours === null) return;
  $('webPhotoBtn').textContent = '🖼 Searching…'; $('webPhotoBtn').disabled = true;
  try {
    const out = await api(`/api/inventory/cars/${editingId}/webphotos`, {
      method: 'POST', headers: JHDRS(),
      body: JSON.stringify({ colours: colours.split(',').map(s => s.trim()).filter(Boolean) })
    });
    editingCar = out.car; renderPhotos(out.car);
    toast(out.added ? `🖼 ${out.added} photo(s) added from the web` : 'No suitable photos found — try a simpler colour name', !out.added);
  } catch (e) { toast(e.message, true); }
  $('webPhotoBtn').textContent = '🖼 Fetch web photos'; $('webPhotoBtn').disabled = false;
}

async function enrichCar() {
  if (!editingId) return;
  const force = ($('c_specs').value.trim() || $('c_features').value.trim())
    ? confirm('Specs/features already filled — overwrite with AI data?') : true;
  if (!force) return;
  $('enrichBtn').textContent = '🤖 Filling…'; $('enrichBtn').disabled = true;
  try {
    const { car } = await api(`/api/inventory/cars/${editingId}/enrich`, { method: 'POST', headers: JHDRS(), body: JSON.stringify({ force: true }) });
    $('c_features').value = (car.features || []).join('\n');
    $('c_specs').value = specsToText(car.specs);
    editingCar = car;
    toast(`🤖 Filled (${car.aiEnriched?.confidence || 'ok'} confidence) — review before publishing`);
  } catch (e) { toast(e.message, true); }
  $('enrichBtn').textContent = '🤖 AI-fill Specs & Features'; $('enrichBtn').disabled = false;
}

async function editCar(id) {
  try {
    const { car } = await api(`/api/inventory/cars/${id}`, { headers: HDRS() });
    editingId = id; editingCar = car;
    setType(car.type);
    for (const f of ['make', 'model', 'variant', 'year', 'colour', 'km', 'owners', 'registration',
                     'sourceDealerName', 'sourceDealerPhone', 'sourceDealerCity', 'tradePrice']) {
      const el = $('c_' + f); if (el) el.value = car[f] ?? '';
    }
    $('c_fuel').value = car.fuel || ''; $('c_transmission').value = car.transmission || '';
    $('p_asking').value = car.price?.asking || ''; $('p_offer').value = car.price?.offer || ''; $('p_onRoad').value = car.price?.onRoad || '';
    for (const f of ['headline', 'discount', 'exchangeBonus', 'freebies', 'validTill']) $('d_' + f).value = car.deal?.[f] ?? '';
    $('c_features').value = (car.features || []).join('\n');
    $('c_specs').value = specsToText(car.specs);
    selectedSchemes = new Set(car.loanSchemeIds || []);
    renderSchemeChips();
    enterEditMode(car);
    gotoTab('edit');
  } catch (e) { toast(e.message, true); }
}

function resetForm() {
  editingId = null; editingCar = null;
  document.querySelectorAll('#page-edit input, #page-edit textarea').forEach(i => { if (i.type !== 'file') i.value = ''; });
  $('c_fuel').value = ''; $('c_transmission').value = '';
  selectedSchemes = new Set(); renderSchemeChips();
  setType('used');
  $('editTitle').textContent = 'Add a Car Deal';
  $('photoLocked').style.display = ''; $('photoTools').style.display = 'none';
  $('publishBtn').style.display = 'none'; $('previewBtn').style.display = 'none'; $('sendBtn').style.display = 'none'; $('enrichBtn').style.display = 'none'; $('webPhotoBtn').style.display = 'none';
  $('photoRow').innerHTML = '';
}

async function togglePublish() {
  if (!editingId || !editingCar) return;
  await setStatus(editingId, editingCar.status === 'live' ? 'draft' : 'live');
}

// ---------------- photos ----------------
function renderPhotos(car) {
  $('photoRow').innerHTML = (car.photos || []).map(p => `
    <div class="ph ${p.cover ? 'cover' : ''} ${p.private ? 'hiddenPhoto' : ''}">
      <img src="${API()}${p.url}" />
      <div class="star" title="Make cover" onclick="makeCover('${p.file}')">⭐</div>
      <div class="x" title="Delete" onclick="delPhoto('${p.file}')">✕</div>
      <div class="eye" title="${p.private ? 'Hidden from the website and WhatsApp — click to show it' : 'Hide from the website and WhatsApp (RC, price sheet, paperwork)'}"
           onclick="togglePrivate('${p.file}', ${p.private ? 'false' : 'true'})">${p.private ? '🙈' : '👁'}</div>
    </div>`).join('');
}

// Paperwork (RC card, price sheet) is hidden automatically at intake. This is the
// escape hatch in both directions.
async function togglePrivate(file, hide) {
  const data = await api(`/api/inventory/cars/${editingId}/photos/${file}/private`, {
    method: 'POST', headers: JHDRS(), body: JSON.stringify({ private: hide })
  });
  editingCar = data.car; renderPhotos(data.car);
  toast(hide ? '🙈 Hidden from the website & WhatsApp' : '👁 Visible again');
}

async function uploadPhotos(files) {
  if (!editingId || !files.length) return;
  const fd = new FormData();
  for (const f of files) fd.append('photos', f);
  try {
    const data = await api(`/api/inventory/cars/${editingId}/photos`, { method: 'POST', headers: HDRS(), body: fd });
    editingCar = data.car; renderPhotos(data.car);
    toast(`📸 ${data.added.length} photo(s) added — AI is picking the hero shot…`);
    // AI hero selection runs server-side; refresh covers shortly after
    setTimeout(async () => {
      try {
        const { car } = await api(`/api/inventory/cars/${editingId}`, { headers: HDRS() });
        editingCar = car; renderPhotos(car);
      } catch (e) {}
    }, 6000);
  } catch (e) { toast(e.message, true); }
}
async function delPhoto(file) {
  const data = await api(`/api/inventory/cars/${editingId}/photos/${file}`, { method: 'DELETE', headers: HDRS() });
  editingCar = data.car; renderPhotos(data.car);
}
async function makeCover(file) {
  const data = await api(`/api/inventory/cars/${editingId}/cover`, { method: 'POST', headers: JHDRS(), body: JSON.stringify({ file }) });
  editingCar = data.car; renderPhotos(data.car);
}

const dz = $('dropZone');
dz.onclick = () => $('photoInput').click();
$('photoInput').onchange = e => uploadPhotos([...e.target.files]);
dz.ondragover = e => { e.preventDefault(); dz.classList.add('on'); };
dz.ondragleave = () => dz.classList.remove('on');
dz.ondrop = e => { e.preventDefault(); dz.classList.remove('on'); uploadPhotos([...e.dataTransfer.files]); };

// ---------------- WhatsApp preview + send ----------------
function waFmt(s) {
  return esc(s)
    .replace(/\*([^*\n]+)\*/g, '<b>$1</b>')
    .replace(/~([^~\n]+)~/g, '<s>$1</s>')
    .replace(/_([^_\n]+)_/g, '<i>$1</i>');
}

async function openPreview(id) {
  if (!id) return;
  try {
    const p = await api(`/api/inventory/cars/${id}/preview`, { headers: HDRS() });
    const { car } = await api(`/api/inventory/cars/${id}`, { headers: HDRS() });
    const cover = (car.photos || []).find(x => x.cover) || (car.photos || [])[0];
    $('waBody').innerHTML = `
      <div class="bubble">${cover ? `<img src="${API()}${cover.url}" />` : ''}${waFmt(p.caption)}</div>
      <div class="btnRow"><div>✨ Features</div><div>⚙️ Specs</div><div>💰 Deal &amp; EMI</div></div>
      <div class="bubble">${waFmt(p.features)}</div>
      <div class="bubble">${waFmt(p.specs)}</div>
      <div class="bubble">${waFmt(p.deal)}</div>
      <div class="btnRow"><div>📅 Book Test Drive</div><div>🖼 More Photos</div><div>📞 Talk to Sales</div></div>`;
    $('waModal').classList.add('open');
  } catch (e) { toast(e.message, true); }
}

async function sendCard(id) {
  if (!id) return;
  const to = prompt('Send this deal card to WhatsApp number (10-digit or with country code):');
  if (!to) return;
  try {
    const r = await api(`/api/inventory/cars/${id}/send`, { method: 'POST', headers: JHDRS(), body: JSON.stringify({ to }) });
    toast(r.warning ? '📲 Sent with a warning: ' + r.warning : '📲 Deal card sent!', !!r.warning);
  } catch (e) { toast(e.message, true); }
}

async function blastDeal(id) {
  try {
    const dry = await api(`/api/inventory/cars/${id}/blast`, { method: 'POST', headers: JHDRS(), body: JSON.stringify({ dryRun: true }) });
    if (!dry.matched) return toast('No matched leads found for this car', true);
    if (!confirm(`📣 ${dry.matched} matched lead(s) will receive this deal card on WhatsApp. Send now?`)) return;
    const out = await api(`/api/inventory/cars/${id}/blast`, { method: 'POST', headers: JHDRS(), body: JSON.stringify({}) });
    toast(`📣 Sent ${out.sent}/${out.matched}${out.failed ? `, ${out.failed} failed (${(out.errors||[])[0]||''})` : ''}`, !!out.failed);
  } catch (e) { toast(e.message, true); }
}

// ---------------- loan schemes ----------------
async function loadSchemes() {
  try {
    const data = await api('/api/inventory/loan-schemes', { headers: HDRS() });
    schemes = data.schemes || [];
  } catch (e) { schemes = []; }
  $('schemeRows').innerHTML = schemes.map(s => `<tr>
      <td>${s.id}</td><td>${esc(s.bank)}</td>
      <td>${(Array.isArray(s.plans) && s.plans.length ? s.plans : ['reducing','bullet'])
        .map(p => `<span class="badge ${p === 'balloon' ? 'live' : p === 'bullet' ? 'used' : 'new'}">${PLAN_LABELS[p] || p}</span>`).join(' ')}</td>
      <td>${s.roi}%</td><td>${s.maxTenure} mo</td>
      <td>${s.minDownPct}%</td><td>${s.processingFee ? '₹' + Number(s.processingFee).toLocaleString('en-IN') : '—'}</td>
      <td><button class="ghost" onclick="editScheme('${s.id}')">✏️</button>
          <button class="danger" onclick="delScheme('${s.id}')">🗑</button></td>
    </tr>`).join('') || '<tr><td colspan="8" style="color:#8b96a5">No schemes yet.</td></tr>';
  renderSchemeChips();
}

function renderSchemeChips() {
  $('schemeChips').innerHTML = schemes.length
    ? schemes.map(s => `<span class="chip ${selectedSchemes.has(s.id) ? 'on' : ''}" onclick="toggleScheme('${s.id}')">${esc(s.bank)} @ ${s.roi}%</span>`).join('')
    : '<span class="hint">No schemes yet — add them in the 🏦 Loan Schemes tab. (Default scheme is used otherwise.)</span>';
}
function toggleScheme(id) {
  selectedSchemes.has(id) ? selectedSchemes.delete(id) : selectedSchemes.add(id);
  renderSchemeChips();
}

function schemeBody() {
  return {
    bank: $('s_bank').value.trim(), roi: Number($('s_roi').value),
    maxTenure: Number($('s_maxTenure').value) || 60, minDownPct: Number($('s_minDownPct').value) || 10,
    processingFee: Number($('s_processingFee').value) || 0, notes: $('s_notes').value.trim(),
    plans: [...selectedPlans],
    bulletPct: Number($('s_bulletPct').value) || 25,
    balloonPreset: $('s_balloonPreset').value || '',
    balloonCategory: $('s_balloonCategory').value || '',
    surakshaPct: Number($('s_surakshaPct').value) || 0,
    surakshaAmount: Number($('s_surakshaAmount').value) || 0,
    balloonPct: Number($('s_balloonPct').value) || 35,
    extensionTenure: Number($('s_extensionTenure').value) || 36
  };
}
async function saveScheme() {
  const b = schemeBody();
  if (!b.bank || !b.roi) return toast('Bank and ROI required', true);
  try {
    if (editingSchemeId) await api(`/api/inventory/loan-schemes/${editingSchemeId}`, { method: 'PUT', headers: JHDRS(), body: JSON.stringify(b) });
    else await api('/api/inventory/loan-schemes', { method: 'POST', headers: JHDRS(), body: JSON.stringify(b) });
    toast('💾 Scheme saved'); resetSchemeForm(); loadSchemes();
  } catch (e) { toast(e.message, true); }
}
function editScheme(id) {
  const s = schemes.find(x => x.id === id); if (!s) return;
  editingSchemeId = id;
  $('schemeFormTitle').textContent = `Editing ${id} — ${s.bank}`;
  $('s_bank').value = s.bank; $('s_roi').value = s.roi; $('s_maxTenure').value = s.maxTenure;
  $('s_minDownPct').value = s.minDownPct; $('s_processingFee').value = s.processingFee; $('s_notes').value = s.notes || '';
  $('s_bulletPct').value = s.bulletPct ?? 25;
  $('s_balloonPct').value = s.balloonPct ?? 35;
  $('s_extensionTenure').value = s.extensionTenure ?? 36;
  $('s_balloonPreset').value = s.balloonPreset || '';
  syncBalloonCategories();
  $('s_balloonCategory').value = s.balloonCategory || '';
  $('s_surakshaPct').value = s.surakshaPct || '';
  $('s_surakshaAmount').value = s.surakshaAmount || '';
  selectedPlans = new Set(Array.isArray(s.plans) && s.plans.length ? s.plans : ['reducing', 'bullet']);
  renderPlanChips();
  $('schemeCancel').style.display = '';
}
function resetSchemeForm() {
  editingSchemeId = null;
  $('schemeFormTitle').textContent = 'Add Loan Scheme';
  ['s_bank', 's_roi', 's_maxTenure', 's_minDownPct', 's_processingFee', 's_notes',
   's_bulletPct', 's_balloonPct', 's_extensionTenure', 's_surakshaPct', 's_surakshaAmount'].forEach(id => $(id).value = '');
  $('s_balloonPreset').value = ''; syncBalloonCategories();
  selectedPlans = new Set(['reducing', 'bullet']);
  renderPlanChips();
  $('schemeCancel').style.display = 'none';
}
async function delScheme(id) {
  if (!confirm(`Delete scheme ${id}?`)) return;
  try { await api(`/api/inventory/loan-schemes/${id}`, { method: 'DELETE', headers: HDRS() }); loadSchemes(); }
  catch (e) { toast(e.message, true); }
}

['s_roi', 's_maxTenure', 's_minDownPct', 's_bulletPct', 's_balloonPct', 's_extensionTenure', 's_surakshaPct', 's_surakshaAmount']
  .forEach(id => { const el = $(id); if (el) el.addEventListener('input', renderSchemePreview); });
$('s_balloonPreset').addEventListener('change', syncBalloonCategories);
$('s_balloonCategory').addEventListener('change', renderSchemePreview);

// ---------------- boot ----------------
async function refreshAll() {
  await loadRole();
  renderPlanChips();
  if (!isStaff()) await loadSchemes();
  await loadCars();
}
initSettings();
refreshAll();
