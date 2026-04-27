import { escapeHtml } from "./html.js";

export function usersHtml(appName: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(appName)} - Users</title>
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
      max-width: 1180px;
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
    .body {
      display: grid;
      grid-template-columns: 360px 1fr;
      gap: 0;
      min-height: 620px;
    }
    .list-pane {
      border-right: 1px solid #22314f;
      background: #0a1325;
      padding: 20px;
    }
    .editor-pane {
      padding: 24px 28px 28px;
    }
    .toolbar { display: flex; justify-content: space-between; align-items: center; gap: 10px; margin-bottom: 16px; }
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
    .list { display: grid; gap: 10px; }
    .user-card {
      border: 1px solid #22314f;
      border-radius: 12px;
      padding: 12px;
      background: #0f172a;
      cursor: pointer;
    }
    .user-card.active { border-color: #60a5fa; background: #10203a; }
    .meta { color: #94a3b8; font-size: 12px; line-height: 1.5; }
    .empty {
      color: #94a3b8;
      font-size: 13px;
      text-align: center;
      padding: 24px;
      border: 1px dashed #22314f;
      border-radius: 12px;
    }
    .status {
      min-height: 20px;
      margin-bottom: 12px;
      font-size: 13px;
    }
    .status.error { color: #f87171; }
    .status.success { color: #4ade80; }
    label {
      display: block;
      font-size: 13px;
      font-weight: 600;
      margin-bottom: 6px;
    }
    input[type="text"] {
      width: 100%;
      padding: 10px 12px;
      font-size: 14px;
      font-family: inherit;
      border: 1px solid #22314f;
      border-radius: 8px;
      background: #0a1325;
      color: #e2e8f0;
      outline: none;
      margin-bottom: 14px;
    }
    input[type="text"]:focus { border-color: #60a5fa; }
    .checkbox-row {
      display: flex;
      align-items: center;
      gap: 10px;
      margin: 6px 0 20px;
      color: #cbd5e1;
      font-size: 13px;
    }
    .actions {
      display: flex;
      gap: 10px;
      margin-top: 10px;
    }
  </style>
</head>
<body>
  <div class="shell">
    <div class="header">
      <div>
        <h1>Users</h1>
        <div class="subtitle">Manage Slack, GitHub, and Jira identity links for Gooseherd users.</div>
      </div>
      <div>
        <a class="btn ghost" href="/">Back</a>
      </div>
    </div>
    <div class="body">
      <div class="list-pane">
        <div class="toolbar">
          <div style="font-size:12px; text-transform:uppercase; letter-spacing:0.08em; color:#94a3b8;">Directory</div>
          <button class="btn primary" id="new-user-btn">New User</button>
        </div>
        <div class="list" id="user-list">Loading...</div>
      </div>
      <div class="editor-pane">
        <div style="font-size:12px; text-transform:uppercase; letter-spacing:0.08em; color:#94a3b8; margin-bottom:10px;">Editor</div>
        <div class="status" id="form-status"></div>
        <label for="display-name">Display Name</label>
        <input id="display-name" type="text" />
        <label for="slack-user-id">Slack User ID</label>
        <input id="slack-user-id" type="text" placeholder="U12345678" />
        <label for="github-login">GitHub Login</label>
        <input id="github-login" type="text" placeholder="octocat" />
        <label for="jira-account-id">Jira Account ID</label>
        <input id="jira-account-id" type="text" placeholder="JIRA_123" />
        <label class="checkbox-row">
          <input id="is-active" type="checkbox" checked />
          <span>Active</span>
        </label>
        <div class="actions">
          <button class="btn primary" id="save-user-btn">Save</button>
          <button class="btn ghost" id="cancel-user-btn">Cancel</button>
        </div>
      </div>
    </div>
  </div>

<script>
const state = {
  users: [],
  selectedUserId: null,
  draft: emptyDraft(),
};

const el = {
  userList: document.getElementById('user-list'),
  newUserBtn: document.getElementById('new-user-btn'),
  saveUserBtn: document.getElementById('save-user-btn'),
  cancelUserBtn: document.getElementById('cancel-user-btn'),
  formStatus: document.getElementById('form-status'),
  displayName: document.getElementById('display-name'),
  slackUserId: document.getElementById('slack-user-id'),
  githubLogin: document.getElementById('github-login'),
  jiraAccountId: document.getElementById('jira-account-id'),
  isActive: document.getElementById('is-active'),
};

function emptyDraft() {
  return {
    id: null,
    displayName: '',
    slackUserId: '',
    githubLogin: '',
    jiraAccountId: '',
    isActive: true,
  };
}

function esc(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function fetchJson(url, options) {
  const response = await fetch(url, Object.assign({ credentials: 'same-origin' }, options || {}));
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function setStatus(message, kind) {
  el.formStatus.textContent = message || '';
  el.formStatus.className = 'status' + (kind ? ' ' + kind : '');
}

function renderList() {
  if (!state.users.length) {
    el.userList.innerHTML = '<div class="empty">No users yet.</div>';
    return;
  }

  el.userList.innerHTML = state.users.map((user) => {
    const meta = [
      user.slackUserId || 'No Slack',
      user.githubLogin || 'No GitHub',
      user.jiraAccountId || 'No Jira',
      user.isActive ? 'Active' : 'Inactive',
    ].join(' · ');
    const activeClass = user.id === state.selectedUserId ? ' active' : '';
    return '<button class="user-card' + activeClass + '" data-user-id="' + esc(user.id) + '">' +
      '<div style="font-weight:700; margin-bottom:6px;">' + esc(user.displayName) + '</div>' +
      '<div class="meta">' + esc(meta) + '</div>' +
      '</button>';
  }).join('');

  el.userList.querySelectorAll('[data-user-id]').forEach((button) => {
    button.onclick = () => {
      const id = button.getAttribute('data-user-id');
      const user = state.users.find((entry) => entry.id === id);
      if (!user) return;
      state.selectedUserId = user.id;
      state.draft = {
        id: user.id,
        displayName: user.displayName || '',
        slackUserId: user.slackUserId || '',
        githubLogin: user.githubLogin || '',
        jiraAccountId: user.jiraAccountId || '',
        isActive: Boolean(user.isActive),
      };
      setStatus('', '');
      renderForm();
      renderList();
    };
  });
}

function renderForm() {
  el.displayName.value = state.draft.displayName || '';
  el.slackUserId.value = state.draft.slackUserId || '';
  el.githubLogin.value = state.draft.githubLogin || '';
  el.jiraAccountId.value = state.draft.jiraAccountId || '';
  el.isActive.checked = Boolean(state.draft.isActive);
}

function currentPayload() {
  return {
    displayName: el.displayName.value,
    slackUserId: el.slackUserId.value,
    githubLogin: el.githubLogin.value,
    jiraAccountId: el.jiraAccountId.value,
    isActive: el.isActive.checked,
  };
}

async function loadUsers() {
  const data = await fetchJson('/api/users');
  state.users = Array.isArray(data.users) ? data.users : [];
  if (!state.selectedUserId && state.users.length) {
    const first = state.users[0];
    state.selectedUserId = first.id;
    state.draft = {
      id: first.id,
      displayName: first.displayName || '',
      slackUserId: first.slackUserId || '',
      githubLogin: first.githubLogin || '',
      jiraAccountId: first.jiraAccountId || '',
      isActive: Boolean(first.isActive),
    };
  }
  renderList();
  renderForm();
}

el.newUserBtn.onclick = () => {
  state.selectedUserId = null;
  state.draft = emptyDraft();
  setStatus('', '');
  renderForm();
  renderList();
};

el.cancelUserBtn.onclick = () => {
  if (!state.selectedUserId) {
    state.draft = emptyDraft();
    renderForm();
    return;
  }
  const existing = state.users.find((user) => user.id === state.selectedUserId);
  if (!existing) return;
  state.draft = {
    id: existing.id,
    displayName: existing.displayName || '',
    slackUserId: existing.slackUserId || '',
    githubLogin: existing.githubLogin || '',
    jiraAccountId: existing.jiraAccountId || '',
    isActive: Boolean(existing.isActive),
  };
  setStatus('', '');
  renderForm();
};

el.saveUserBtn.onclick = async () => {
  setStatus('Saving...', '');
  try {
    const payload = currentPayload();
    if (state.selectedUserId) {
      await fetchJson('/api/users/' + encodeURIComponent(state.selectedUserId), {
        method: 'PATCH',
        body: JSON.stringify(payload),
      });
      setStatus('User updated.', 'success');
    } else {
      const data = await fetchJson('/api/users', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      state.selectedUserId = data.user && data.user.id ? data.user.id : null;
      setStatus('User created.', 'success');
    }
    await loadUsers();
  } catch (error) {
    setStatus(error && error.message ? error.message : 'Failed to save user.', 'error');
  }
};

loadUsers().catch((error) => {
  el.userList.innerHTML = '<div class="empty">Failed to load users.</div>';
  setStatus(error && error.message ? error.message : 'Failed to load users.', 'error');
});
</script>
</body>
</html>`;
}
