// Leads view. Same token as Inventory Studio; the owner token and the staff
// token both open it, and the API refuses everything else.
const $ = (id) => document.getElementById(id);
let LEADS = [];

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
    !q || `${l.name || ''} ${l.phone || ''} ${l.car || l.car_enquired || ''} ${l.interest || ''}`.toLowerCase().includes(q)
  );
  if (!rows.length) {
    $('list').className = 'note';
    $('list').textContent = LEADS.length ? 'Nothing matches that search.' : 'No leads yet.';
    return;
  }
  $('list').className = '';
  $('list').innerHTML = rows.map((l) => {
    const car = l.car || l.car_enquired || '';
    const bits = [car, money(l.budget), l.emi ? money(l.emi) + '/mo' : '', l.city].filter(Boolean).join(' · ');
    const phone = String(l.phone || '').replace(/[^0-9]/g, '');
    return `<div class="row">
      <div class="top">
        <div>
          <div class="name">${esc(l.name || 'Website enquiry')}</div>
          ${phone ? `<a class="phone" href="https://wa.me/${phone.length === 10 ? '91' + phone : phone}">+${phone.length === 10 ? '91' + phone : phone}</a>` : ''}
        </div>
        <div style="text-align:right">
          ${l.source ? `<span class="tag">${esc(l.source)}</span>` : ''}
          <div class="when">${when(l.timestamp || l.createdAt || l.date)}</div>
        </div>
      </div>
      ${bits ? `<div class="meta">${esc(bits)}</div>` : ''}
      ${l.interest ? `<div class="meta">${esc(l.interest)}</div>` : ''}
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
      String(b.timestamp || b.createdAt || '').localeCompare(String(a.timestamp || a.createdAt || '')));
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
