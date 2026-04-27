export function modelPricesHtml(appName: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${appName} Model Prices</title>
  <style>
    :root { color-scheme: dark; --bg:#070b15; --panel:#111827; --panel2:#0b1220; --line:#253653; --text:#e5edf8; --muted:#9fb0c7; --accent:#2563eb; --bad:#f87171; --ok:#34d399; }
    * { box-sizing: border-box; }
    body { margin:0; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:var(--bg); color:var(--text); }
    .shell { max-width:1120px; margin:28px auto; border:1px solid var(--line); border-radius:16px; background:var(--panel); overflow:hidden; }
    header { display:flex; justify-content:space-between; gap:16px; align-items:center; padding:28px; border-bottom:1px solid var(--line); }
    h1 { margin:0 0 8px; font-size:26px; }
    p { margin:0; color:var(--muted); font-size:14px; }
    .actions { display:flex; gap:10px; }
    .btn { border:1px solid var(--line); background:#172033; color:var(--text); border-radius:10px; padding:10px 16px; font-weight:700; cursor:pointer; text-decoration:none; font-size:14px; }
    .btn.primary { background:var(--accent); border-color:var(--accent); }
    .content { padding:28px; }
    .stats { display:grid; grid-template-columns:repeat(4, minmax(0, 1fr)); gap:12px; margin-bottom:20px; }
    .stat { border:1px solid var(--line); border-radius:10px; padding:14px; background:var(--panel2); }
    .stat strong { display:block; font-size:22px; margin-bottom:4px; }
    .stat span { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.08em; }
    .tabs { display:flex; gap:8px; margin-bottom:14px; }
    .tab { border:1px solid var(--line); background:var(--panel2); color:var(--muted); border-radius:999px; padding:7px 12px; cursor:pointer; font-weight:700; }
    .tab.active { color:var(--text); border-color:#3b82f6; }
    .legend { border:1px solid var(--line); background:var(--panel2); border-radius:12px; padding:14px 16px; margin-bottom:18px; color:var(--muted); font-size:13px; line-height:1.5; }
    .legend strong { color:var(--text); }
    table { width:100%; border-collapse:collapse; overflow:hidden; border:1px solid var(--line); border-radius:12px; }
    th, td { padding:12px; border-bottom:1px solid var(--line); text-align:left; font-size:13px; vertical-align:middle; }
    th { color:var(--muted); text-transform:uppercase; letter-spacing:.08em; font-size:11px; background:#0d1628; }
    tr:last-child td { border-bottom:0; }
    code { color:#dbeafe; }
    input { width:105px; background:#071020; color:var(--text); border:1px solid var(--line); border-radius:8px; padding:8px; font:inherit; }
    .badge { display:inline-flex; align-items:center; border-radius:999px; padding:4px 8px; font-size:12px; font-weight:800; }
    .badge.missing { background:rgba(248,113,113,.16); color:var(--bad); }
    .badge.ready { background:rgba(52,211,153,.16); color:var(--ok); }
    .muted { color:var(--muted); }
    .empty { border:1px dashed var(--line); border-radius:12px; padding:28px; text-align:center; color:var(--muted); }
    .status { min-height:20px; margin:12px 0; color:var(--muted); }
    .error { color:var(--bad); }
  </style>
</head>
<body>
  <div class="shell">
    <header>
      <div>
        <h1>Model Prices</h1>
        <p>Manage token prices used to estimate RUN costs.</p>
      </div>
      <div class="actions">
        <a class="btn" href="/">Back</a>
        <button class="btn primary" id="recalc">Recalculate incomplete costs</button>
      </div>
    </header>
    <div class="content">
      <div class="stats" id="stats"></div>
      <div class="legend">
        <strong>Sources:</strong>
        <strong>manual</strong> means an admin entered the price.
        <strong>fallback</strong> means the price was seeded from ${appName}'s built-in price table.
        <strong>observed</strong> means the model appeared in a RUN, but no price is known yet.
      </div>
      <div class="tabs">
        <button class="tab active" data-filter="missing">Missing</button>
        <button class="tab" data-filter="configured">Configured</button>
        <button class="tab" data-filter="all">All</button>
      </div>
      <div class="status" id="status"></div>
      <div id="table"></div>
    </div>
  </div>
<script>
const state = { prices: [], stats: {}, filter: 'missing' };
const el = { stats: document.getElementById('stats'), table: document.getElementById('table'), status: document.getElementById('status') };
function esc(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
async function fetchJson(url, opts) {
  const res = await fetch(url, Object.assign({ headers: { 'content-type': 'application/json' } }, opts || {}));
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}
function renderStats() {
  const s = state.stats || {};
  el.stats.innerHTML =
    '<div class="stat"><strong>' + (s.totalModels || 0) + '</strong><span>Models</span></div>' +
    '<div class="stat"><strong>' + (s.missingPrices || 0) + '</strong><span>Missing prices</span></div>' +
    '<div class="stat"><strong>' + (s.incompleteRuns || 0) + '</strong><span>Incomplete runs</span></div>' +
    '<div class="stat"><strong>USD</strong><span>Currency</span></div>';
}
function visiblePrices() {
  const prices = state.prices.slice().sort((a, b) => Number(b.missing) - Number(a.missing) || a.model.localeCompare(b.model));
  if (state.filter === 'missing') return prices.filter(p => p.missing);
  if (state.filter === 'configured') return prices.filter(p => !p.missing);
  return prices;
}
function renderTable() {
  const rows = visiblePrices();
  if (!rows.length) {
    el.table.innerHTML = '<div class="empty">No model prices in this view.</div>';
    return;
  }
  el.table.innerHTML = '<table><thead><tr><th>Status</th><th>Model</th><th>Input / 1M</th><th>Output / 1M</th><th>Source</th><th>Last seen</th><th></th></tr></thead><tbody>' +
    rows.map(p => '<tr data-model="' + esc(p.model) + '">' +
      '<td><span class="badge ' + (p.missing ? 'missing' : 'ready') + '">' + (p.missing ? 'Missing' : 'Ready') + '</span></td>' +
      '<td><code>' + esc(p.model) + '</code></td>' +
      '<td><input type="number" step="0.000001" min="0" data-input value="' + esc(p.inputPerM ?? '') + '"></td>' +
      '<td><input type="number" step="0.000001" min="0" data-output value="' + esc(p.outputPerM ?? '') + '"></td>' +
      '<td class="muted">' + esc(p.source) + '</td>' +
      '<td class="muted">' + esc(p.lastSeenAt ? new Date(p.lastSeenAt).toLocaleString() : '-') + '</td>' +
      '<td><button class="btn" data-save>Save</button></td>' +
      '</tr>').join('') + '</tbody></table>';
  document.querySelectorAll('[data-save]').forEach(btn => btn.addEventListener('click', saveRow));
}
async function load() {
  el.status.textContent = 'Loading...';
  try {
    const data = await fetchJson('/api/model-prices');
    state.prices = Array.isArray(data.prices) ? data.prices : [];
    state.stats = data.stats || {};
    el.status.textContent = '';
    renderStats();
    renderTable();
  } catch (error) {
    el.status.innerHTML = '<span class="error">' + esc(error.message) + '</span>';
  }
}
async function saveRow(event) {
  const row = event.currentTarget.closest('tr');
  const model = row.getAttribute('data-model');
  const inputPerM = row.querySelector('[data-input]').value;
  const outputPerM = row.querySelector('[data-output]').value;
  el.status.textContent = 'Saving...';
  try {
    await fetchJson('/api/model-prices/' + encodeURIComponent(model), { method: 'PUT', body: JSON.stringify({ inputPerM, outputPerM }) });
    await load();
  } catch (error) {
    el.status.innerHTML = '<span class="error">' + esc(error.message) + '</span>';
  }
}
document.querySelectorAll('.tab').forEach(tab => tab.addEventListener('click', () => {
  state.filter = tab.getAttribute('data-filter');
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t === tab));
  renderTable();
}));
document.getElementById('recalc').addEventListener('click', async () => {
  el.status.textContent = 'Recalculating...';
  try {
    const result = await fetchJson('/api/model-prices/recalculate-incomplete', { method: 'POST' });
    el.status.textContent = 'Updated ' + (result.updated || 0) + ' runs.';
    await load();
  } catch (error) {
    el.status.innerHTML = '<span class="error">' + esc(error.message) + '</span>';
  }
});
load();
</script>
</body>
</html>`;
}
