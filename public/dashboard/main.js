/* main.js — injected dashboard helper: adds filters and richer lead rendering */
(async function () {
  // helper: safe fetch
  async function api(path) {
    try {
      const r = await fetch(path);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) {
      console.error('api error', e);
      return { ok: false, leads: [] };
    }
  }

  // normalize lead object from crm
  function normalize(l) {
    return {
      id: l.id || l.from || ('L' + (Date.now())),
      name: (l.name && l.name !== 'UNKNOWN') ? l.name : (l.name || 'UNKNOWN'),
      phone: l.phone || l.from || '',
      status: l.status || l.follow_up || l.lead_status || 'auto-ingested',
      created_at: l.created_at || (new Date()).toISOString(),
      last_message: l.last_message || l.text || '',
      // optional fields (may be absent)
      car_enquired: l.car_enquired || l.car || l.query || l.enquiry || '',
      variant: l.variant || '',
      budget: l.budget || l.price || '',
      ai_reply: l.ai_reply || l.ai_last_reply || '',
      ai_quote: l.ai_quote || l.quote || '',
      follow_up: (l.follow_up || l.lead_status || l.status || '').toString().toLowerCase()
    };
  }

  // fetch leads from /crm/leads and return normalized array
  async function fetchLeads({ status = '', q = '' } = {}) {
    const res = await api('/crm/leads');
    const arr = (res && Array.isArray(res.leads)) ? res.leads : [];
    const norm = arr.map(normalize);

    // filter text (name / phone / car / budget)
    const qLower = (q || '').trim().toLowerCase();
    const filtered = norm.filter(l => {
      if (status) {
        // allow "hot","follow-up","cold" match where follow_up or status fields used
        if (!((l.follow_up || '').includes(status) || (l.status || '').toLowerCase().includes(status))) return false;
      }
      if (!qLower) return true;
      const hay = [
        l.id, l.name, l.phone, l.car_enquired, l.variant, l.budget, l.last_message, l.ai_reply
      ].join(' ').toLowerCase();
      return hay.indexOf(qLower) !== -1;
    });

    // sort by date desc
    filtered.sort((a,b)=> new Date(b.created_at) - new Date(a.created_at));
    return filtered;
  }

  // attempt to find the page's table and search area
  const table = document.querySelector('table') || (() => {
    console.warn('No table found on dashboard page');
    // create a table if none exists
    const wrap = document.createElement('div');
    wrap.innerHTML = '<table style="width:100%;border-collapse:collapse"><thead></thead><tbody></tbody></table>';
    document.body.appendChild(wrap);
    return document.querySelector('table');
  })();

  // ensure thead structure we want
  function ensureTableHeader() {
    let thead = table.querySelector('thead');
    if (!thead) {
      thead = document.createElement('thead');
      table.insertBefore(thead, table.firstChild);
    }
    thead.innerHTML = `
      <tr>
        <th>ID</th>
        <th>Name</th>
        <th>Phone</th>
        <th>Car Enquired</th>
        <th>Budget</th>
        <th>Last AI Reply</th>
        <th>AI Quote</th>
        <th>Lead Status</th>
        <th>TimestampTimestamp</th>
      </tr>
    `;
  }

  // render rows
  function renderTableRows(leads) {
    ensureTableHeader();
    let tbody = table.querySelector('tbody');
    if (!tbody) {
      tbody = document.createElement('tbody');
      table.appendChild(tbody);
    }
    tbody.innerHTML = '';
    for (const l of leads) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${escapeHtml(l.id)}</td>
        <td>${escapeHtml(l.name)}</td>
        <td>${escapeHtml(l.phone)}</td>
        <td>${escapeHtml(l.car_enquired || '')}${ l.variant ? ' / '+escapeHtml(l.variant) : ''}</td>
        <td>${escapeHtml(l.budget || '')}</td>
        <td title="${escapeAttr(l.ai_reply||'')}">${escapeHtml(truncate(l.ai_reply, 90))}</td>
        <td>${escapeHtml(l.ai_quote || '')}</td>
        <td>${escapeHtml(l.follow_up || l.status || '')}</td>
        <td>${new Date(l.created_at).toLocaleString()}</td>
      `;
      tbody.appendChild(tr);
    }
  }

  // small helpers
  function truncate(s, n) { if (!s) return ''; return s.length > n ? s.slice(0,n)+'…' : s; }
  function escapeHtml(s){ if (!s) return ''; return String(s).replace(/[&<>"']/g, (m)=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[m]); }
  function escapeAttr(s){ return escapeHtml(s).replace(/\n/g,' '); }

  // inject controls near existing search input if found
  function injectControls() {
    const existingSearch = document.querySelector('input[placeholder*="Search"], input[placeholder*="search"], input[type="search"]');
    const controlsHTML = document.createElement('div');
    controlsHTML.style.display='flex';
    controlsHTML.style.gap='8px';
    controlsHTML.style.alignItems='center';
    controlsHTML.style.marginBottom='10px';
    controlsHTML.innerHTML = `
      <input id="mc-lead-search" placeholder="Search name / phone / car" style="padding:8px;border:1px solid #ddd;border-radius:6px;width:260px">
      <select id="mc-lead-status" style="padding:8px;border:1px solid #ddd;border-radius:6px">
        <option value="">All statuses</option>
        <option value="hot">Hot</option>
        <option value="follow-up">Follow-up</option>
        <option value="cold">Cold</option>
      </select>
      <button id="mc-lead-refresh" style="padding:8px 12px;border-radius:6px;border:1px solid #2b6cb0;background:#2b6cb0;color:#fff;cursor:pointer">Refresh</button>
      <span id="mc-lead-total" style="margin-left:12px;color:#666"></span>
    `;
    if (existingSearch && existingSearch.parentNode) {
      existingSearch.parentNode.insertBefore(controlsHTML, existingSearch.nextSibling);
    } else {
      // fallback: put into left column if exists (search for a left panel)
      const leftPanel = Array.from(document.querySelectorAll('aside, .sidebar, .left, .panel')).find(n => n && /lead/i.test(n.innerText || ''));
      if (leftPanel) leftPanel.insertBefore(controlsHTML, leftPanel.firstChild);
      else document.body.insertBefore(controlsHTML, document.body.firstChild);
    }

    // attach events
    document.getElementById('mc-lead-refresh').addEventListener('click', refreshLeads);
    document.getElementById('mc-lead-status').addEventListener('change', refreshLeads);
    document.getElementById('mc-lead-search').addEventListener('keyup', (e) => { if (e.key === 'Enter') refreshLeads(); });
  }

  // main refresh
  async function refreshLeads() {
    const statusRaw = (document.getElementById('mc-lead-status') || {}).value || '';
    const status = statusRaw ? statusRaw.toLowerCase() : '';
    const q = (document.getElementById('mc-lead-search') || {}).value || '';
    const leads = await fetchLeads({ status, q });
    renderTableRows(leads);
    const totalEl = document.getElementById('mc-lead-total');
    if (totalEl) totalEl.innerText = 'Total: ' + leads.length;
  }

  // startup
  injectControls();
  await refreshLeads();

  // expose for console troubleshooting
  window.MR_CAR_DASH = { fetchLeads, refreshLeads, renderTableRows };
})();
