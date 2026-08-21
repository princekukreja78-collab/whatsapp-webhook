// Leads view. Same token as Inventory Studio; the owner token and the staff
// token both open it, and the API refuses everything else.
const $ = (id) => document.getElementById(id);
let LEADS = [];

// Two shapes reach this list: the bot's WhatsApp leads carry the sheet's
// capitalised column names, website enquiries carry lowercase ones. Read both
// rather than showing a column of blanks.
const pick = (l, ...keys) => {
  for (const k of keys) {
    const v = l[k];
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return '';
};
const F = {
  name: (l) => pick(l, 'name', 'Name'),
  phone: (l) => pick(l, 'phone', 'Phone', 'ID'),
  car: (l) => pick(l, 'car', 'car_enquired', 'Car'),
  when: (l) => pick(l, 'timestamp', 'Timestamp', 'createdAt', 'date'),
  source: (l) => pick(l, 'source', 'LeadType', 'Status'),
  note: (l) => pick(l, 'interest', 'car_enquired', 'lastMessage', 'enquiry', 'Purpose'),
  budget: (l) => pick(l, 'budget', 'Budget'),
  emi: (l) => pick(l, 'emi', 'EMI'),
  city: (l) => pick(l, 'city', 'City')
};

const when = (t) => {
  const d = new Date(t);
  if (isNaN(d)) return '';
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 60) return `${mins} min ago`;
  if (mins < 1440) return `${Math.round(mins / 60)} h ago`;
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
};
const money = (n) => (Number(n) ? '₹' + Number(n).toLocaleString('en-IN') : '');

function render() {
  const q = $('q').value.trim().toLowerCase();
  const rows = LEADS.filter((l) =>
    !q || `${F.name(l)} ${F.phone(l)} ${F.car(l)} ${F.note(l)}`.toLowerCase().includes(q)
  );
  if (!rows.length) {
    $('list').className = 'note';
    $('list').textContent = LEADS.length ? 'Nothing matches that search.' : 'No leads yet.';
    return;
  }
  $('list').className = '';
  $('list').innerHTML = rows.map((l) => {
    const car = F.car(l);
    const bits = [car, money(F.budget(l)), F.emi(l) ? money(F.emi(l)) + '/mo' : '', F.city(l)].filter(Boolean).join(' · ');
    const phone = String(F.phone(l)).replace(/[^0-9]/g, '');
    return `<div class="row">
      <div class="top">
        <div>
          <div class="name">${esc(F.name(l) || 'Unknown')}</div>
          ${phone ? `<a class="phone" href="https://wa.me/${phone.length === 10 ? '91' + phone : phone}">+${phone.length === 10 ? '91' + phone : phone}</a>` : ''}
        </div>
        <div style="text-align:right">
          ${F.source(l) ? `<span class="tag">${esc(F.source(l))}</span>` : ''}
          <div class="when">${when(F.when(l))}</div>
        </div>
      </div>
      ${bits ? `<div class="meta">${esc(bits)}</div>` : ''}
      ${F.note(l) ? `<div class="meta">${esc(F.note(l))}</div>` : ''}
    </div>`;
  }).join('');
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function load() {
  const tok = $('tok').value.trim();
  if (!tok) return;
  localStorage.setItem('mrcar_crm_token', tok);
  $('list').className = 'note';
  $('list').textContent = 'Loading…';
  try {
    const r = await fetch('/api/leads', { headers: { 'x-admin-token': tok } });
    if (r.status === 401) { $('list').textContent = 'That token was refused.'; return; }
    const d = await r.json();
    LEADS = (d.leads || d.data || []).slice().sort((a, b) =>
      String(F.when(b)).localeCompare(String(F.when(a))));
    render();
  } catch (e) {
    $('list').textContent = 'Could not reach the server.';
  }
}

$('tok').value = localStorage.getItem('mrcar_crm_token') || '';
$('go').onclick = load;
$('q').oninput = render;
$('tok').onchange = load;
if ($('tok').value) load();
