/**
 * Setup wizard — full-page HTML/CSS/JS for first-run configuration.
 *
 * 5-step flow: Password → GitHub → LLM → Slack → Review & Finish
 */

import { escapeHtml } from "./html.js";

export function wizardHtml(appName: string, reconfig = false): string {
  const title = reconfig ? "Reconfigure" : "Setup";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(appName)} — ${title}</title>
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
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .wizard {
      background: #0f172a;
      border: 1px solid #22314f;
      border-radius: 16px;
      padding: 40px 36px;
      width: 100%;
      max-width: 520px;
      box-shadow: 0 14px 36px rgba(1,6,18,0.55);
    }
    h1 { font-size: 22px; margin-bottom: 4px; }
    .subtitle { color: #94a3b8; font-size: 13px; margin-bottom: 28px; }
    .steps {
      display: flex;
      gap: 8px;
      margin-bottom: 28px;
    }
    .step-dot {
      width: 32px;
      height: 4px;
      border-radius: 2px;
      background: #1e293b;
      transition: background 0.3s;
    }
    .step-dot.active { background: #2563eb; }
    .step-dot.done { background: #22c55e; }
    .step { display: none; }
    .step.active { display: block; }
    .step h2 { font-size: 17px; margin-bottom: 6px; }
    .step p { color: #94a3b8; font-size: 13px; margin-bottom: 20px; }
    label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 6px; }
    input[type="text"],
    input[type="password"],
    textarea,
    select {
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
    input:focus, textarea:focus, select:focus { border-color: #60a5fa; }
    textarea { resize: vertical; min-height: 80px; font-family: monospace; font-size: 12px; }
    .field-row { margin-bottom: 0; }
    .radio-group { display: flex; gap: 12px; margin-bottom: 14px; }
    .radio-group label {
      display: flex;
      align-items: center;
      gap: 6px;
      cursor: pointer;
      font-weight: 400;
    }
    .btn-row { display: flex; gap: 10px; margin-top: 20px; }
    .btn {
      flex: 1;
      padding: 10px;
      border: none;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      font-family: inherit;
    }
    .btn-primary { background: #2563eb; color: #fff; }
    .btn-primary:hover { background: #1d4ed8; }
    .btn-primary:disabled { background: #334155; color: #64748b; cursor: default; }
    .btn-secondary { background: #1e293b; color: #94a3b8; }
    .btn-secondary:hover { background: #334155; }
    .btn-skip { background: transparent; color: #64748b; border: 1px solid #22314f; }
    .btn-skip:hover { background: #1e293b; }
    .btn-skip.ready { background: rgba(37, 99, 235, 0.2); color: #dbeafe; border-color: #3b82f6; box-shadow: inset 0 0 0 1px rgba(96, 165, 250, 0.25); }
    .btn-skip.ready:hover { background: rgba(37, 99, 235, 0.32); }
    .btn-validate { background: #0f766e; color: #fff; flex: none; width: auto; padding: 10px 18px; }
    .btn-validate:hover { background: #115e59; }
    .error { color: #ef4444; font-size: 13px; margin-bottom: 12px; min-height: 18px; }
    .success { color: #22c55e; font-size: 13px; margin-bottom: 12px; min-height: 18px; }
    .warn { color: #f59e0b; font-size: 13px; margin-bottom: 12px; }
    .prefill-summary {
      display: none;
      margin-bottom: 16px;
      padding: 10px 12px;
      border: 1px solid #22314f;
      border-radius: 10px;
      background: #0a1325;
      color: #cbd5e1;
      font-size: 12px;
      line-height: 1.6;
    }
    .prefill-summary.active { display: block; }
    .prefill-summary strong { color: #e2e8f0; }
    .hidden { display: none; }
    .review-list { list-style: none; padding: 0; }
    .review-list li {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 0;
      border-bottom: 1px solid #1e293b;
      font-size: 14px;
    }
    .review-list li:last-child { border-bottom: none; }
    .check { color: #22c55e; }
    .warn-icon { color: #f59e0b; }
    .masked { color: #64748b; font-family: monospace; font-size: 13px; }
    .spinner {
      display: inline-block;
      width: 14px;
      height: 14px;
      border: 2px solid #334155;
      border-top-color: #60a5fa;
      border-radius: 50%;
      animation: spin 0.6s linear infinite;
      margin-right: 6px;
      vertical-align: middle;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
<div class="wizard">
  <h1>${escapeHtml(appName)}</h1>
  <div class="subtitle">${reconfig ? "Reconfigure your instance" : "Welcome! Let's get you set up."}</div>

  <div class="steps">
    <div class="step-dot active" data-step="0"></div>
    <div class="step-dot" data-step="1"></div>
    <div class="step-dot" data-step="2"></div>
    <div class="step-dot" data-step="3"></div>
    <div class="step-dot" data-step="4"></div>
  </div>

  <!-- Step 1: Password -->
  <div class="step active" id="step-0">
    <h2>Set Dashboard Password</h2>
    <p>This password protects your dashboard. Minimum 8 characters.</p>
    <div class="error" id="pw-error"></div>
    <label for="pw">Password</label>
    <input type="password" id="pw" minlength="8" required />
    <label for="pw-confirm">Confirm Password</label>
    <input type="password" id="pw-confirm" minlength="8" required />
    <div class="btn-row">
      <button class="btn btn-primary" onclick="savePassword()">Continue</button>
    </div>
  </div>

  <!-- Step 2: GitHub -->
  <div class="step" id="step-1">
    <h2>Connect GitHub</h2>
    <p>Configure how Gooseherd accesses your repositories.</p>
    <div class="error" id="gh-error"></div>
    <div class="success" id="gh-success"></div>
    <div class="prefill-summary" id="gh-prefill-summary"></div>

    <div class="radio-group">
      <label><input type="radio" name="gh-mode" value="pat" checked onchange="toggleGhMode()"> Personal Access Token</label>
      <label><input type="radio" name="gh-mode" value="app" onchange="toggleGhMode()"> GitHub App</label>
    </div>

    <div id="gh-pat-fields">
      <label for="gh-token">GitHub Token</label>
      <input type="password" id="gh-token" placeholder="ghp_..." />
      <label for="gh-owner">Default Owner (optional)</label>
      <input type="text" id="gh-owner" placeholder="your-org" />
    </div>

    <div id="gh-app-fields" class="hidden">
      <label for="gh-app-id">App ID</label>
      <input type="text" id="gh-app-id" />
      <label for="gh-install-id">Installation ID</label>
      <input type="text" id="gh-install-id" />
      <label for="gh-key">Private Key (PEM)</label>
      <textarea id="gh-key" placeholder="-----BEGIN RSA PRIVATE KEY-----"></textarea>
    </div>

    <div class="btn-row">
      <button class="btn btn-skip" id="gh-skip-btn" onclick="goStep(2)">Skip</button>
      <button class="btn btn-validate" id="gh-validate-btn" onclick="validateGithub()">Validate</button>
      <button class="btn btn-primary" onclick="saveGithub()">Save & Continue</button>
    </div>
  </div>

  <!-- Step 3: LLM -->
  <div class="step" id="step-2">
    <h2>Configure LLM</h2>
    <p>Choose your AI provider for orchestration and analysis.</p>
    <div class="error" id="llm-error"></div>
    <div class="success" id="llm-success"></div>
    <div class="prefill-summary" id="llm-prefill-summary"></div>

    <label for="llm-provider">Provider</label>
    <select id="llm-provider">
      <option value="openrouter">OpenRouter (recommended)</option>
      <option value="anthropic">Anthropic</option>
      <option value="openai">OpenAI</option>
    </select>

    <label for="llm-key">API Key</label>
    <input type="password" id="llm-key" />

    <label for="llm-model">Default Model (optional)</label>
    <input type="text" id="llm-model" placeholder="e.g. anthropic/claude-sonnet-4-20250514" />

    <div class="btn-row">
      <button class="btn btn-secondary" onclick="goStep(1)">Back</button>
      <button class="btn btn-skip" id="llm-skip-btn" onclick="goStep(3)">Skip</button>
      <button class="btn btn-validate" id="llm-validate-btn" onclick="validateLlm()">Validate</button>
      <button class="btn btn-primary" onclick="saveLlm()">Save & Continue</button>
    </div>
  </div>

  <!-- Step 4: Slack -->
  <div class="step" id="step-3">
    <h2>Connect Slack</h2>
    <p>Set up a Slack bot so Gooseherd can receive commands and post updates.</p>
    <div class="error" id="slack-error"></div>
    <div class="success" id="slack-success"></div>
    <div class="prefill-summary" id="slack-prefill-summary"></div>

    <details style="margin-bottom:18px; color:#94a3b8; font-size:13px;">
      <summary style="cursor:pointer; color:#60a5fa; font-weight:600; margin-bottom:8px;">How to create a Slack App</summary>
      <ol style="padding-left:18px; line-height:1.7;">
        <li>Go to <a href="https://api.slack.com/apps" target="_blank" style="color:#60a5fa;">api.slack.com/apps</a> and click <strong>Create New App → From scratch</strong>.</li>
        <li>Name it (e.g. "Gooseherd") and pick your workspace.</li>
        <li><strong>Socket Mode</strong> — go to <em>Socket Mode</em> in the sidebar, enable it, and generate an <strong>App-Level Token</strong> with scope <code>connections:write</code>. Copy it (starts with <code>xapp-</code>).</li>
        <li><strong>Bot Token Scopes</strong> — go to <em>OAuth & Permissions</em> → <em>Scopes</em> → <em>Bot Token Scopes</em> and add:
          <code style="display:block; background:#0a1325; padding:8px; border-radius:6px; margin:6px 0; font-size:12px; line-height:1.6;">chat:write, commands, app_mentions:read, channels:history, channels:read, groups:history, groups:read, im:history, im:read, reactions:write, files:write, users:read</code>
        </li>
        <li><strong>Event Subscriptions</strong> — go to <em>Event Subscriptions</em>, enable events, then under <em>Subscribe to bot events</em> add: <code>app_mention</code>, <code>message.channels</code>, <code>message.groups</code>, <code>message.im</code>.</li>
        <li><strong>Slash Command</strong> — go to <em>Slash Commands</em> and create one (e.g. <code>/gooseherd</code>). Set the request URL to anything — Socket Mode handles routing.</li>
        <li><strong>Install App</strong> — go to <em>Install App</em> and install to your workspace. Copy the <strong>Bot User OAuth Token</strong> (starts with <code>xoxb-</code>).</li>
        <li><strong>Browser login</strong> — in <em>Basic Information</em>, copy the <strong>Client ID</strong> and <strong>Client Secret</strong>. In <em>OAuth & Permissions</em>, add a redirect URL like <code>/auth/slack/callback</code> under your dashboard base URL.</li>
        <li>Back in <em>Basic Information</em>, copy the <strong>Signing Secret</strong>.</li>
      </ol>
    </details>

    <label for="slack-bot-token">Bot Token</label>
    <input type="password" id="slack-bot-token" placeholder="xoxb-..." />

    <label for="slack-app-token">App-Level Token (Socket Mode)</label>
    <input type="password" id="slack-app-token" placeholder="xapp-..." />

    <label for="slack-signing-secret">Signing Secret (optional)</label>
    <input type="password" id="slack-signing-secret" />

    <label for="slack-command">Slash Command Name (optional)</label>
    <input type="text" id="slack-command" placeholder="/gooseherd" />

    <label for="slack-client-id">Client ID (optional)</label>
    <input type="text" id="slack-client-id" placeholder="111.222" />

    <label for="slack-client-secret">Client Secret (optional)</label>
    <input type="password" id="slack-client-secret" />

    <label for="slack-auth-redirect-uri">Auth Redirect URI (optional)</label>
    <input type="text" id="slack-auth-redirect-uri" placeholder="/auth/slack/callback" />

    <div class="btn-row">
      <button class="btn btn-secondary" onclick="goStep(2)">Back</button>
      <button class="btn btn-skip" id="slack-skip-btn" onclick="goStep(4)">Skip</button>
      <button class="btn btn-validate" id="slack-validate-btn" onclick="validateSlack()">Validate</button>
      <button class="btn btn-primary" onclick="saveSlack()">Save & Continue</button>
    </div>
  </div>

  <!-- Step 5: Review -->
  <div class="step" id="step-4">
    <h2>Review & Finish</h2>
    <p>Here's a summary of your configuration.</p>
    <div class="error" id="finish-error"></div>
    <ul class="review-list" id="review-list"></ul>
    <div class="btn-row">
      <button class="btn btn-secondary" onclick="goStep(3)">Back</button>
      <button class="btn btn-primary" onclick="finishSetup()">Finish Setup</button>
    </div>
  </div>
</div>

<script>
let currentStep = 0;
const state = { password: false, github: false, llm: false, slack: false };
const prefillState = {
  github: { token: false, appId: false, installationId: false, privateKey: false },
  llm: { apiKey: false },
  slack: { botToken: false, appToken: false }
};

function goStep(n) {
  document.querySelectorAll('.step').forEach(s => s.classList.remove('active'));
  document.getElementById('step-' + n).classList.add('active');
  document.querySelectorAll('.step-dot').forEach((d, i) => {
    d.classList.remove('active', 'done');
    if (i < n) d.classList.add('done');
    if (i === n) d.classList.add('active');
  });
  currentStep = n;
  syncSkipButtons();
  if (n === 4) renderReview();
}

function toggleGhMode() {
  const mode = document.querySelector('input[name="gh-mode"]:checked').value;
  document.getElementById('gh-pat-fields').classList.toggle('hidden', mode !== 'pat');
  document.getElementById('gh-app-fields').classList.toggle('hidden', mode !== 'app');
  syncSkipButtons();
}

function hasValue(id) {
  const el = document.getElementById(id);
  return !!el && typeof el.value === 'string' && el.value.trim().length > 0;
}

function hasPrefillValue(field) {
  return !!field && !!field.source && field.source !== 'none';
}

function hasGithubRequiredFields() {
  const mode = document.querySelector('input[name="gh-mode"]:checked')?.value;
  if (mode === 'app') {
    return hasValue('gh-app-id') && hasValue('gh-install-id') && hasValue('gh-key');
  }
  return hasValue('gh-token');
}

function hasLlmRequiredFields() {
  return hasValue('llm-key');
}

function hasSlackRequiredFields() {
  return hasValue('slack-bot-token') && hasValue('slack-app-token');
}

function hasGithubReadyForSkip() {
  const mode = document.querySelector('input[name="gh-mode"]:checked')?.value;
  if (mode === 'app') {
    return hasGithubRequiredFields() || (prefillState.github.appId && prefillState.github.installationId && prefillState.github.privateKey);
  }
  return hasGithubRequiredFields() || prefillState.github.token;
}

function hasLlmReadyForSkip() {
  return hasLlmRequiredFields() || prefillState.llm.apiKey;
}

function hasSlackReadyForSkip() {
  return hasSlackRequiredFields() || (prefillState.slack.botToken && prefillState.slack.appToken);
}

function syncSkipButtons() {
  document.getElementById('gh-skip-btn')?.classList.toggle('ready', hasGithubReadyForSkip() || state.github);
  document.getElementById('llm-skip-btn')?.classList.toggle('ready', hasLlmReadyForSkip() || state.llm);
  document.getElementById('slack-skip-btn')?.classList.toggle('ready', hasSlackReadyForSkip() || state.slack);
}

function sourceLabel(source) {
  return source === 'env' ? 'From ENV' : source === 'wizard' ? 'Saved in wizard' : '';
}

function setInputValue(id, field) {
  if (!field || !field.value) return;
  const el = document.getElementById(id);
  if (!el) return;
  el.value = field.value;
}

function setGitHubAuthMode(field) {
  if (!field || !field.value) return;
  const radio = document.querySelector('input[name="gh-mode"][value="' + field.value + '"]');
  if (!radio) return;
  radio.checked = true;
  toggleGhMode();
}

function renderPrefillSummary(containerId, rows) {
  const el = document.getElementById(containerId);
  const filtered = rows.filter(row => row.source && row.source !== 'none');
  if (!el) return;
  if (filtered.length === 0) {
    el.classList.remove('active');
    el.innerHTML = '';
    return;
  }
  el.classList.add('active');
  el.innerHTML = filtered.map(row =>
    '<div><strong>' + row.label + ':</strong> ' + sourceLabel(row.source) + (row.value ? ' (' + row.value + ')' : '') + '</div>'
  ).join('');
}

function applySetupPrefill(prefill) {
  if (!prefill) return;

  prefillState.github.token = hasPrefillValue(prefill.github?.token);
  prefillState.github.appId = hasPrefillValue(prefill.github?.appId);
  prefillState.github.installationId = hasPrefillValue(prefill.github?.installationId);
  prefillState.github.privateKey = hasPrefillValue(prefill.github?.privateKey);
  prefillState.llm.apiKey = hasPrefillValue(prefill.llm?.apiKey);
  prefillState.slack.botToken = hasPrefillValue(prefill.slack?.botToken);
  prefillState.slack.appToken = hasPrefillValue(prefill.slack?.appToken);

  setGitHubAuthMode(prefill.github?.authMode);
  setInputValue('gh-owner', prefill.github?.defaultOwner);
  setInputValue('gh-app-id', prefill.github?.appId);
  setInputValue('gh-install-id', prefill.github?.installationId);
  renderPrefillSummary('gh-prefill-summary', [
    { label: 'Auth mode', source: prefill.github?.authMode?.source, value: prefill.github?.authMode?.value },
    { label: 'Default owner', source: prefill.github?.defaultOwner?.source, value: prefill.github?.defaultOwner?.value },
    { label: 'Token', source: prefill.github?.token?.source },
    { label: 'App ID', source: prefill.github?.appId?.source, value: prefill.github?.appId?.value },
    { label: 'Installation ID', source: prefill.github?.installationId?.source, value: prefill.github?.installationId?.value },
    { label: 'Private key', source: prefill.github?.privateKey?.source },
  ]);

  if (prefill.llm?.provider?.value) {
    document.getElementById('llm-provider').value = prefill.llm.provider.value;
  }
  setInputValue('llm-model', prefill.llm?.defaultModel);
  renderPrefillSummary('llm-prefill-summary', [
    { label: 'Provider', source: prefill.llm?.provider?.source, value: prefill.llm?.provider?.value },
    { label: 'API key', source: prefill.llm?.apiKey?.source },
    { label: 'Default model', source: prefill.llm?.defaultModel?.source, value: prefill.llm?.defaultModel?.value },
  ]);

  setInputValue('slack-command', prefill.slack?.commandName);
  setInputValue('slack-client-id', prefill.slack?.clientId);
  setInputValue('slack-auth-redirect-uri', prefill.slack?.authRedirectUri);
  renderPrefillSummary('slack-prefill-summary', [
    { label: 'Bot token', source: prefill.slack?.botToken?.source },
    { label: 'App token', source: prefill.slack?.appToken?.source },
    { label: 'Signing secret', source: prefill.slack?.signingSecret?.source },
    { label: 'Slash command', source: prefill.slack?.commandName?.source, value: prefill.slack?.commandName?.value },
    { label: 'Client ID', source: prefill.slack?.clientId?.source, value: prefill.slack?.clientId?.value },
    { label: 'Client secret', source: prefill.slack?.clientSecret?.source },
    { label: 'Auth redirect URI', source: prefill.slack?.authRedirectUri?.source, value: prefill.slack?.authRedirectUri?.value },
  ]);

  syncSkipButtons();
}

async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'same-origin'
  });
  return res;
}

async function savePassword() {
  const pw = document.getElementById('pw').value;
  const confirm = document.getElementById('pw-confirm').value;
  const errEl = document.getElementById('pw-error');
  errEl.textContent = '';

  if (pw.length < 8) { errEl.textContent = 'Password must be at least 8 characters.'; return; }
  if (pw !== confirm) { errEl.textContent = 'Passwords do not match.'; return; }

  const res = await post('/api/setup/password', { password: pw });
  if (!res.ok) {
    const data = await res.json();
    errEl.textContent = data.error || 'Failed to save password.';
    return;
  }
  state.password = true;
  goStep(1);
}

async function validateGithub() {
  const btn = document.getElementById('gh-validate-btn');
  const errEl = document.getElementById('gh-error');
  const successEl = document.getElementById('gh-success');
  errEl.textContent = '';
  successEl.textContent = '';
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Validating...';

  const body = buildGithubBody();
  const res = await post('/api/setup/validate-github', body);
  const data = await res.json();
  btn.disabled = false;
  btn.textContent = 'Validate';

  if (res.ok) {
    successEl.textContent = 'Connected as ' + (data.username || 'unknown') + ' (' + (data.repoCount || 0) + ' repos accessible)';
  } else {
    errEl.textContent = data.error || 'Validation failed.';
  }
}

function buildGithubBody() {
  const mode = document.querySelector('input[name="gh-mode"]:checked').value;
  if (mode === 'pat') {
    return {
      authMode: 'pat',
      token: document.getElementById('gh-token').value,
      defaultOwner: document.getElementById('gh-owner').value || undefined
    };
  }
  return {
    authMode: 'app',
    appId: document.getElementById('gh-app-id').value,
    installationId: document.getElementById('gh-install-id').value,
    privateKey: document.getElementById('gh-key').value
  };
}

async function saveGithub() {
  const errEl = document.getElementById('gh-error');
  errEl.textContent = '';

  const body = buildGithubBody();
  const res = await post('/api/setup/github', body);
  if (!res.ok) {
    const data = await res.json();
    errEl.textContent = data.error || 'Failed to save.';
    return;
  }
  state.github = true;
  syncSkipButtons();
  goStep(2);
}

async function validateLlm() {
  const btn = document.getElementById('llm-validate-btn');
  const errEl = document.getElementById('llm-error');
  const successEl = document.getElementById('llm-success');
  errEl.textContent = '';
  successEl.textContent = '';
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Validating...';

  const body = buildLlmBody();
  const res = await post('/api/setup/validate-llm', body);
  const data = await res.json();
  btn.disabled = false;
  btn.textContent = 'Validate';

  if (res.ok) {
    successEl.textContent = 'API key validated successfully.';
  } else {
    errEl.textContent = data.error || 'Validation failed.';
  }
}

function buildLlmBody() {
  return {
    provider: document.getElementById('llm-provider').value,
    apiKey: document.getElementById('llm-key').value,
    defaultModel: document.getElementById('llm-model').value || undefined
  };
}

async function saveLlm() {
  const errEl = document.getElementById('llm-error');
  errEl.textContent = '';

  const body = buildLlmBody();
  if (!body.apiKey) { errEl.textContent = 'API key is required.'; return; }

  const res = await post('/api/setup/llm', body);
  if (!res.ok) {
    const data = await res.json();
    errEl.textContent = data.error || 'Failed to save.';
    return;
  }
  state.llm = true;
  syncSkipButtons();
  goStep(3); // → Slack step
}

function buildSlackBody() {
  return {
    botToken: document.getElementById('slack-bot-token').value,
    appToken: document.getElementById('slack-app-token').value,
    signingSecret: document.getElementById('slack-signing-secret').value || undefined,
    commandName: document.getElementById('slack-command').value || undefined,
    clientId: document.getElementById('slack-client-id').value || undefined,
    clientSecret: document.getElementById('slack-client-secret').value || undefined,
    authRedirectUri: document.getElementById('slack-auth-redirect-uri').value || undefined
  };
}

async function validateSlack() {
  const btn = document.getElementById('slack-validate-btn');
  const errEl = document.getElementById('slack-error');
  const successEl = document.getElementById('slack-success');
  errEl.textContent = '';
  successEl.textContent = '';
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Validating...';

  const body = buildSlackBody();
  const res = await post('/api/setup/validate-slack', body);
  const data = await res.json();
  btn.disabled = false;
  btn.textContent = 'Validate';

  if (res.ok) {
    successEl.textContent = 'Connected as ' + (data.botName || 'bot') + ' in ' + (data.teamName || 'workspace');
  } else {
    errEl.textContent = data.error || 'Validation failed.';
  }
}

async function saveSlack() {
  const errEl = document.getElementById('slack-error');
  errEl.textContent = '';

  const body = buildSlackBody();
  if (!body.botToken) { errEl.textContent = 'Bot Token is required.'; return; }
  if (!body.appToken) { errEl.textContent = 'App-Level Token is required.'; return; }

  const res = await post('/api/setup/slack', body);
  if (!res.ok) {
    const data = await res.json();
    errEl.textContent = data.error || 'Failed to save.';
    return;
  }
  state.slack = true;
  syncSkipButtons();
  goStep(4);
}

function renderReview() {
  const list = document.getElementById('review-list');
  const items = [
    { label: 'Dashboard password', ok: state.password },
    { label: 'GitHub connection', ok: state.github },
    { label: 'LLM provider', ok: state.llm },
    { label: 'Slack bot', ok: state.slack },
  ];
  list.innerHTML = items.map(i =>
    '<li>' +
    (i.ok ? '<span class="check">&#10003;</span>' : '<span class="warn-icon">&#9888;</span>') +
    '<span>' + i.label + (i.ok ? '' : ' <span class="masked">(skipped)</span>') + '</span>' +
    '</li>'
  ).join('');
}

async function finishSetup() {
  const errEl = document.getElementById('finish-error');
  errEl.textContent = '';

  if (!state.password) { errEl.textContent = 'Password is required.'; return; }

  const res = await post('/api/setup/complete', {});
  if (!res.ok) {
    const data = await res.json();
    errEl.textContent = data.error || 'Failed to complete setup.';
    return;
  }
  window.location.href = '/';
}

// Check initial status
['gh-token', 'gh-owner', 'gh-app-id', 'gh-install-id', 'gh-key', 'llm-key', 'llm-model', 'slack-bot-token', 'slack-app-token', 'slack-signing-secret', 'slack-command', 'slack-client-id', 'slack-client-secret', 'slack-auth-redirect-uri']
  .forEach(id => document.getElementById(id)?.addEventListener('input', syncSkipButtons));
document.querySelectorAll('input[name="gh-mode"]').forEach(el => el.addEventListener('change', syncSkipButtons));
syncSkipButtons();

fetch('/api/setup/status', { credentials: 'same-origin' })
  .then(r => r.json())
  .then(data => {
    if (data.hasPassword) state.password = true;
    if (data.hasGithub) state.github = true;
    if (data.hasLlm) state.llm = true;
    if (data.hasSlack) state.slack = true;
    applySetupPrefill(data.prefill);
    syncSkipButtons();
    ${reconfig ? "// In reconfig mode, start from step 1 (skip password if already set)\n    if (state.password) goStep(1);" : ""}
  })
  .catch(() => {});
</script>
</body>
</html>`;
}
