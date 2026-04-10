import { escapeHtml } from "./html.js";

export function agentProfileListHtml(appName: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(appName)} - Agent Profiles</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&display=swap" rel="stylesheet" />
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: "Space Grotesk", system-ui, sans-serif;
      background: #060a14;
      color: #e2e8f0;
      min-height: 100vh;
      padding: 32px 16px;
    }
    .shell {
      max-width: 980px;
      margin: 0 auto;
      background: #0f172a;
      border: 1px solid #22314f;
      border-radius: 18px;
      box-shadow: 0 14px 36px rgba(1,6,18,0.55);
      overflow: hidden;
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
      padding: 24px 28px;
      border-bottom: 1px solid #22314f;
    }
    h1 { font-size: 24px; margin-bottom: 6px; }
    .subtitle { color: #94a3b8; font-size: 13px; line-height: 1.5; }
    .body { padding: 24px 28px 28px; }
    .toolbar { display: flex; gap: 10px; flex-wrap: nowrap; white-space: nowrap; align-items: center; }
    .btn {
      padding: 10px 14px;
      border-radius: 10px;
      border: 1px solid #22314f;
      background: #1e293b;
      color: #e2e8f0;
      text-decoration: none;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      font-family: inherit;
    }
    .btn.primary { background: #2563eb; border-color: #2563eb; }
    .btn.ghost { background: transparent; color: #94a3b8; }
    .section-title { font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; color: #94a3b8; margin-bottom: 10px; }
    .command-box {
      background: #08101f;
      border: 1px solid #22314f;
      border-radius: 12px;
      padding: 14px;
      white-space: pre-wrap;
      word-break: break-word;
      font-family: ui-monospace, monospace;
      font-size: 12px;
      line-height: 1.6;
      margin-bottom: 24px;
    }
    .grid { display: grid; gap: 12px; }
    .card {
      background: #0a1325;
      border: 1px solid #22314f;
      border-radius: 14px;
      padding: 16px;
    }
    .card-top {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 16px;
      margin-bottom: 10px;
    }
    .meta { color: #94a3b8; font-size: 12px; }
    .badge {
      display: inline-block;
      padding: 4px 8px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 700;
      background: #10203a;
      color: #93c5fd;
    }
    .badge.active { background: rgba(34,197,94,0.14); color: #4ade80; }
    .card-actions { display: flex; gap: 8px; margin-top: 12px; }
    .empty { color: #94a3b8; font-size: 13px; padding: 24px; text-align: center; border: 1px dashed #22314f; border-radius: 12px; }
  </style>
</head>
<body>
  <div class="shell">
    <div class="header">
      <div>
        <h1>Agent Profiles</h1>
        <div class="subtitle">Choose which structured profile renders the effective agent command, or create a new one through the wizard.</div>
      </div>
      <div class="toolbar">
        <a class="btn ghost" href="/">Back</a>
        <a class="btn primary" href="/agent-profiles/new">New Profile Wizard</a>
      </div>
    </div>
    <div class="body">
      <div class="section-title">Effective Agent Command</div>
      <div class="command-box" id="effective-command">Loading...</div>

      <div class="section-title">Profiles</div>
      <div class="grid" id="profile-list">Loading...</div>
    </div>
  </div>

<script>
async function fetchJson(url, options) {
  const response = await fetch(url, Object.assign({ credentials: 'same-origin' }, options || {}));
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function esc(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function renderPage() {
  const settings = await fetchJson('/api/settings');
  const profilesData = await fetchJson('/api/agent-profiles');
  const config = settings.config || {};
  const profiles = Array.isArray(profilesData.profiles) ? profilesData.profiles : [];
  document.getElementById('effective-command').textContent = config.agentCommandTemplate || '';

  const list = document.getElementById('profile-list');
  if (!profiles.length) {
    list.innerHTML = '<div class="empty">No structured profiles yet. Create one with the wizard.</div>';
    return;
  }

  list.innerHTML = profiles.map((profile) => {
    const meta = [profile.runtime, profile.provider, profile.model].filter(Boolean).join(' / ');
    return '<div class="card">' +
      '<div class="card-top">' +
      '<div><div style="font-size:15px; font-weight:700;">' + esc(profile.name) + '</div>' +
      '<div class="meta" style="margin-top:4px;">' + esc(profile.description || '') + '</div>' +
      '<div class="meta" style="margin-top:8px;">' + esc(meta || 'custom') + '</div></div>' +
      '<div>' + (profile.isActive ? '<span class="badge active">Active</span>' : '<span class="badge">Available</span>') + '</div>' +
      '</div>' +
      '<div class="command-box" style="margin-bottom:0;">' + esc(profile.commandTemplate || '') + '</div>' +
      '<div class="card-actions">' +
      (profile.isActive ? '' : '<button class="btn" data-activate="' + esc(profile.id) + '">Set Active</button>') +
      (!profile.isBuiltin ? '<button class="btn ghost" data-delete="' + esc(profile.id) + '">Delete</button>' : '') +
      '</div>' +
      '</div>';
  }).join('');

  list.querySelectorAll('[data-activate]').forEach((button) => {
    button.onclick = async () => {
      const id = button.getAttribute('data-activate');
      if (!id) return;
      await fetchJson('/api/agent-profiles/' + encodeURIComponent(id) + '/activate', { method: 'POST' });
      await renderPage();
    };
  });
  list.querySelectorAll('[data-delete]').forEach((button) => {
    button.onclick = async () => {
      const id = button.getAttribute('data-delete');
      if (!id || !confirm('Delete this profile?')) return;
      await fetchJson('/api/agent-profiles/' + encodeURIComponent(id), { method: 'DELETE' });
      await renderPage();
    };
  });
}

renderPage().catch((err) => {
  document.getElementById('profile-list').innerHTML = '<div class="empty">Failed to load profiles.</div>';
  document.getElementById('effective-command').textContent = err.message || 'Failed to load command.';
});
</script>
</body>
</html>`;
}
