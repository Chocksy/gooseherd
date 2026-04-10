import { escapeHtml } from "./html.js";

export function agentProfileWizardHtml(appName: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(appName)} - Agent Profile Wizard</title>
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
      padding: 32px 16px;
    }
    .wizard {
      background: #0f172a;
      border: 1px solid #22314f;
      border-radius: 16px;
      padding: 36px;
      width: 100%;
      max-width: 760px;
      box-shadow: 0 14px 36px rgba(1,6,18,0.55);
    }
    h1 { font-size: 24px; margin-bottom: 6px; }
    .subtitle { color: #94a3b8; font-size: 13px; margin-bottom: 28px; line-height: 1.5; }
    .steps { display: flex; gap: 8px; margin-bottom: 28px; }
    .step-dot { flex: 1; height: 4px; border-radius: 999px; background: #1e293b; }
    .step-dot.active { background: #2563eb; }
    .step-dot.done { background: #22c55e; }
    .step { display: none; }
    .step.active { display: block; }
    .step h2 { font-size: 18px; margin-bottom: 6px; }
    .step p { color: #94a3b8; font-size: 13px; margin-bottom: 18px; }
    label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 6px; }
    input[type="text"], textarea, select {
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
    textarea { min-height: 110px; resize: vertical; font-family: ui-monospace, monospace; font-size: 12px; }
    input:focus, textarea:focus, select:focus { border-color: #60a5fa; }
    .choice-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; margin-bottom: 18px; }
    .choice {
      border: 1px solid #22314f;
      border-radius: 12px;
      padding: 14px;
      cursor: pointer;
      background: #0a1325;
    }
    .choice.active { border-color: #60a5fa; background: #0f1d35; }
    .choice strong { display: block; margin-bottom: 4px; }
    .choice span { color: #94a3b8; font-size: 12px; line-height: 1.5; }
    .note { color: #94a3b8; font-size: 12px; margin-top: -6px; margin-bottom: 14px; }
    .error { color: #ef4444; font-size: 13px; min-height: 18px; margin-bottom: 12px; }
    .success { color: #22c55e; font-size: 13px; min-height: 18px; margin-bottom: 12px; }
    .status-box {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 12px 14px;
      border: 1px solid #22314f;
      border-radius: 10px;
      background: #0a1325;
      color: #94a3b8;
      font-size: 13px;
      margin-bottom: 14px;
    }
    .btn-row { display: flex; gap: 10px; margin-top: 20px; }
    .btn {
      flex: 1;
      padding: 10px 12px;
      border: none;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      font-family: inherit;
    }
    .btn-primary { background: #2563eb; color: #fff; }
    .btn-secondary { background: #1e293b; color: #cbd5e1; }
    .btn-tertiary { background: transparent; color: #94a3b8; border: 1px solid #22314f; }
    .preview {
      background: #08101f;
      border: 1px solid #22314f;
      border-radius: 10px;
      padding: 12px;
      white-space: pre-wrap;
      word-break: break-word;
      font-family: ui-monospace, monospace;
      font-size: 12px;
      line-height: 1.6;
      min-height: 110px;
    }
    .review {
      border: 1px solid #22314f;
      border-radius: 12px;
      padding: 16px;
      background: #0a1325;
      margin-bottom: 18px;
    }
    .review-row { display: flex; justify-content: space-between; gap: 16px; padding: 8px 0; border-bottom: 1px solid #16233b; font-size: 13px; }
    .review-row:last-child { border-bottom: none; }
    .review-row .label { color: #94a3b8; }
    .hidden { display: none; }
    .spinner {
      width: 14px;
      height: 14px;
      border: 2px solid #334155;
      border-top-color: #60a5fa;
      border-radius: 50%;
      animation: spin 0.6s linear infinite;
      flex: 0 0 auto;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
<div class="wizard">
  <h1>Agent Profile Wizard</h1>
  <div class="subtitle">Create a structured agent profile. The shell command is derived from runtime, provider, model, and tool choices.</div>

  <div class="steps">
    <div class="step-dot active" data-step="0"></div>
    <div class="step-dot" data-step="1"></div>
    <div class="step-dot" data-step="2"></div>
    <div class="step-dot" data-step="3"></div>
    <div class="step-dot" data-step="4"></div>
  </div>

  <div class="step active" id="step-0">
    <h2>Choose Runtime</h2>
    <p>Select the CLI/runtime that will execute coding tasks.</p>
    <div class="error" id="runtime-error"></div>
    <label for="profile-name">Profile name</label>
    <input type="text" id="profile-name" placeholder="e.g. Pi + OpenRouter" />
    <label for="profile-description">Description</label>
    <input type="text" id="profile-description" placeholder="Short human-readable summary" />
    <div class="choice-grid" id="runtime-grid"></div>
    <div class="btn-row">
      <button class="btn btn-tertiary" onclick="window.location.href='/agent-profiles'">Cancel</button>
      <button class="btn btn-primary" onclick="nextFromRuntime()">Continue</button>
    </div>
  </div>

  <div class="step" id="step-1">
    <h2>Choose Provider</h2>
    <p>Only configured providers are selectable. Unsupported runtime/provider pairs are hidden.</p>
    <div class="error" id="provider-error"></div>
    <div class="choice-grid" id="provider-grid"></div>
    <div id="custom-provider-note" class="note hidden">Custom runtime skips provider selection.</div>
    <div class="btn-row">
      <button class="btn btn-secondary" onclick="goStep(0)">Back</button>
      <button class="btn btn-primary" onclick="nextFromProvider()">Continue</button>
    </div>
  </div>

  <div class="step" id="step-2">
    <h2>Choose Model</h2>
    <p>The wizard loads the live model catalog from the backend. Manual entry still works.</p>
    <div class="error" id="model-error"></div>
    <div class="success" id="model-success"></div>
    <div class="status-box hidden" id="model-loading-box">
      <div class="spinner"></div>
      <div id="model-loading-text">Loading live model catalog...</div>
    </div>
    <div id="model-fields">
      <label for="model-select">Catalog model</label>
      <select id="model-select">
        <option value="">Choose model</option>
      </select>
      <label for="model-manual">Manual model id</label>
      <input type="text" id="model-manual" placeholder="e.g. openai/gpt-5.3-codex" />
    </div>
    <div id="custom-model-note" class="note hidden">Custom runtime skips provider-backed model loading.</div>
    <div class="btn-row">
      <button class="btn btn-secondary" onclick="goStep(1)">Back</button>
      <button class="btn btn-tertiary" onclick="loadModels()">Reload Models</button>
      <button class="btn btn-primary" onclick="nextFromModel()">Continue</button>
    </div>
  </div>

  <div class="step" id="step-3">
    <h2>Tools & Command Shape</h2>
    <p>Define tools and optional runtime-specific extras, or use a raw command for the custom escape hatch.</p>
    <div class="error" id="tools-error"></div>
    <div id="structured-fields">
      <div id="tools-fields">
        <label for="profile-tools">Tools</label>
        <input type="text" id="profile-tools" value="read,write,edit,bash" />
        <div class="note">Comma-separated. For Claude this maps to allowed tools. For Pi it maps to runtime tool flags.</div>
      </div>
      <label for="profile-mode">Mode (optional)</label>
      <input type="text" id="profile-mode" placeholder="Optional mode value" />
      <div class="note">Mode is a runtime-specific extra. For example, Pi can use it to append an additional mode flag. Leave it empty unless your chosen CLI expects one.</div>
      <label for="profile-extensions">Extensions (optional)</label>
      <input type="text" id="profile-extensions" placeholder="Comma-separated extensions" />
      <label for="profile-extra-args">Extra runtime args (optional)</label>
      <input type="text" id="profile-extra-args" placeholder="Raw extra args" />
    </div>
    <div id="custom-fields" class="hidden">
      <label for="custom-command">Custom command template</label>
      <textarea id="custom-command" placeholder="cd {{repo_dir}} && custom-agent @{{prompt_file}}"></textarea>
    </div>
    <label style="display:flex; align-items:center; gap:8px; margin-top:8px; font-size:13px;">
      <input type="checkbox" id="profile-active" checked />
      Make active immediately
    </label>
    <div class="btn-row">
      <button class="btn btn-secondary" onclick="goStep(2)">Back</button>
      <button class="btn btn-primary" onclick="nextFromTools()">Continue</button>
    </div>
  </div>

  <div class="step" id="step-4">
    <h2>Review & Save</h2>
    <p>Review the structured profile and generated command preview before saving.</p>
    <div class="error" id="review-error"></div>
    <div class="success" id="review-success"></div>
    <div class="review" id="review-box"></div>
    <div class="preview" id="command-preview">Loading preview...</div>
    <div class="btn-row">
      <button class="btn btn-secondary" onclick="goStep(3)">Back</button>
      <button class="btn btn-tertiary" onclick="window.location.href='/agent-profiles'">Cancel</button>
      <button class="btn btn-primary" id="save-btn" onclick="saveProfile()">Save Profile</button>
    </div>
  </div>
</div>

<script>
const state = {
  name: '',
  description: '',
  runtime: 'pi',
  provider: '',
  model: '',
  tools: ['read', 'write', 'edit', 'bash'],
  mode: '',
  extensions: [],
  extraArgs: '',
  customCommandTemplate: '',
  isActive: true,
  providers: [],
};

const runtimeMeta = {
  pi: { title: 'pi', description: 'Pi CLI with structured model + tool selection.' },
  codex: { title: 'codex', description: 'Codex one-shot execution with model and tool flags.' },
  claude: { title: 'claude', description: 'Claude CLI with allowed tool configuration.' },
  custom: { title: 'custom', description: 'Escape hatch for a raw command template.' },
};

function supportedProviders(runtime) {
  if (runtime === 'pi') return ['openai', 'openrouter', 'anthropic'];
  if (runtime === 'codex') return ['openai'];
  if (runtime === 'claude') return ['anthropic', 'openrouter'];
  return [];
}

function goStep(n) {
  document.querySelectorAll('.step').forEach((step) => step.classList.remove('active'));
  document.getElementById('step-' + n).classList.add('active');
  document.querySelectorAll('.step-dot').forEach((dot, i) => {
    dot.classList.remove('active', 'done');
    if (i < n) dot.classList.add('done');
    if (i === n) dot.classList.add('active');
  });
  if (n === 4) renderReview();
}

function setError(id, text) {
  document.getElementById(id).textContent = text || '';
}

function setSuccess(id, text) {
  document.getElementById(id).textContent = text || '';
}

function renderRuntimeChoices() {
  const grid = document.getElementById('runtime-grid');
  grid.innerHTML = Object.entries(runtimeMeta).map(([id, meta]) =>
    '<div class="choice' + (state.runtime === id ? ' active' : '') + '" data-runtime="' + id + '">' +
    '<strong>' + meta.title + '</strong><span>' + meta.description + '</span></div>'
  ).join('');
  grid.querySelectorAll('[data-runtime]').forEach((el) => {
    el.onclick = () => {
      state.runtime = el.getAttribute('data-runtime');
      renderRuntimeChoices();
      renderProviderChoices();
      toggleRuntimeSpecificFields();
    };
  });
}

function renderProviderChoices() {
  const grid = document.getElementById('provider-grid');
  const note = document.getElementById('custom-provider-note');
  if (state.runtime === 'custom') {
    grid.innerHTML = '';
    note.classList.remove('hidden');
    return;
  }
  note.classList.add('hidden');
  const allowed = supportedProviders(state.runtime);
  const visible = state.providers.filter((provider) => provider.configured && allowed.includes(provider.id));
  grid.innerHTML = visible.map((provider) =>
    '<div class="choice' + (state.provider === provider.id ? ' active' : '') + '" data-provider="' + provider.id + '">' +
    '<strong>' + provider.label + '</strong><span>Configured via ' + provider.envVar + '</span></div>'
  ).join('');
  grid.querySelectorAll('[data-provider]').forEach((el) => {
    el.onclick = () => {
      state.provider = el.getAttribute('data-provider');
      state.model = '';
      document.getElementById('model-manual').value = '';
      renderProviderChoices();
    };
  });
}

function toggleRuntimeSpecificFields() {
  const isCustom = state.runtime === 'custom';
  const isCodex = state.runtime === 'codex';
  document.getElementById('structured-fields').classList.toggle('hidden', isCustom);
  document.getElementById('custom-fields').classList.toggle('hidden', !isCustom);
  document.getElementById('custom-model-note').classList.toggle('hidden', !isCustom);
  document.getElementById('model-fields').classList.toggle('hidden', isCustom);
  document.getElementById('model-loading-box').classList.toggle('hidden', isCustom);
  document.getElementById('tools-fields').classList.toggle('hidden', isCodex || isCustom);
}

function setModelLoading(isLoading, text) {
  const loadingBox = document.getElementById('model-loading-box');
  const loadingText = document.getElementById('model-loading-text');
  const modelSelect = document.getElementById('model-select');
  const manualInput = document.getElementById('model-manual');
  if (loadingText && text) loadingText.textContent = text;
  loadingBox.classList.toggle('hidden', !isLoading);
  modelSelect.disabled = isLoading;
  manualInput.disabled = isLoading;
}

async function fetchJson(url, options) {
  const response = await fetch(url, Object.assign({ credentials: 'same-origin' }, options || {}));
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || 'Request failed');
  }
  return data;
}

async function loadProviders() {
  const data = await fetchJson('/api/agent-providers');
  state.providers = Array.isArray(data.providers) ? data.providers : [];
  renderProviderChoices();
}

async function loadModels() {
  setError('model-error', '');
  setSuccess('model-success', '');
  if (state.runtime === 'custom') {
    setModelLoading(false);
    setSuccess('model-success', 'Custom runtime uses a raw command template.');
    return;
  }
  if (!state.provider) {
    setModelLoading(false);
    setError('model-error', 'Select a provider first.');
    return;
  }
  setModelLoading(true, 'Loading live model catalog for ' + state.provider + '...');
  try {
    const data = await fetchJson('/api/agent-models?provider=' + encodeURIComponent(state.provider));
    const models = Array.isArray(data.models) ? data.models : [];
    const select = document.getElementById('model-select');
    select.innerHTML = '<option value="">Choose model</option>' + models.map((model) => '<option value="' + model + '">' + model + '</option>').join('');
    if (state.model) select.value = state.model;
    setSuccess('model-success', models.length ? 'Loaded ' + models.length + ' models.' : 'Catalog empty. Manual entry still works.');
  } finally {
    setModelLoading(false);
  }
}

function nextFromRuntime() {
  state.name = document.getElementById('profile-name').value.trim();
  state.description = document.getElementById('profile-description').value.trim();
  if (!state.name) {
    setError('runtime-error', 'Profile name is required.');
    return;
  }
  setError('runtime-error', '');
  goStep(1);
}

function nextFromProvider() {
  if (state.runtime !== 'custom' && !state.provider) {
    setError('provider-error', 'Choose a configured provider.');
    return;
  }
  setError('provider-error', '');
  goStep(2);
  if (state.runtime !== 'custom') loadModels().catch((err) => setError('model-error', err.message));
}

function nextFromModel() {
  const manual = document.getElementById('model-manual').value.trim();
  const selected = document.getElementById('model-select').value.trim();
  state.model = manual || selected;
  if (state.runtime !== 'custom' && !state.model) {
    setError('model-error', 'Model is required.');
    return;
  }
  setError('model-error', '');
  goStep(3);
}

function nextFromTools() {
  state.tools = state.runtime === 'codex'
    ? []
    : document.getElementById('profile-tools').value.split(',').map((v) => v.trim()).filter(Boolean);
  state.mode = document.getElementById('profile-mode').value.trim();
  state.extensions = document.getElementById('profile-extensions').value.split(',').map((v) => v.trim()).filter(Boolean);
  state.extraArgs = document.getElementById('profile-extra-args').value.trim();
  state.customCommandTemplate = document.getElementById('custom-command').value.trim();
  state.isActive = document.getElementById('profile-active').checked;
  if (state.runtime === 'custom' && !state.customCommandTemplate) {
    setError('tools-error', 'Custom command template is required.');
    return;
  }
  setError('tools-error', '');
  goStep(4);
}

function buildPayload() {
  return {
    name: state.name,
    description: state.description || undefined,
    runtime: state.runtime,
    provider: state.runtime === 'custom' ? undefined : state.provider,
    model: state.runtime === 'custom' ? undefined : (state.model || undefined),
    tools: state.runtime === 'custom' ? [] : state.tools,
    mode: state.mode || undefined,
    extensions: state.extensions,
    extraArgs: state.extraArgs || undefined,
    customCommandTemplate: state.runtime === 'custom' ? state.customCommandTemplate : undefined,
    isActive: state.isActive,
  };
}

async function renderReview() {
  setError('review-error', '');
  setSuccess('review-success', '');
  const payload = buildPayload();
  document.getElementById('review-box').innerHTML =
    '<div class="review-row"><span class="label">Name</span><span>' + (payload.name || '') + '</span></div>' +
    '<div class="review-row"><span class="label">Runtime</span><span>' + payload.runtime + '</span></div>' +
    '<div class="review-row"><span class="label">Provider</span><span>' + (payload.provider || '-') + '</span></div>' +
    '<div class="review-row"><span class="label">Model</span><span>' + (payload.model || '-') + '</span></div>' +
    '<div class="review-row"><span class="label">Tools</span><span>' + ((payload.tools || []).join(', ') || '-') + '</span></div>' +
    '<div class="review-row"><span class="label">Activate</span><span>' + (payload.isActive ? 'yes' : 'no') + '</span></div>';
  try {
    const data = await fetchJson('/api/agent-profiles/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const text = (data.errors && data.errors.length ? 'Validation: ' + data.errors.join('; ') + '\\n\\n' : '') + (data.commandTemplate || '');
    document.getElementById('command-preview').textContent = text;
    if (data.ok) {
      setSuccess('review-success', 'Profile validates successfully.');
    } else {
      setError('review-error', data.errors.join('; '));
    }
  } catch (err) {
    setError('review-error', err.message || 'Failed to generate preview.');
    document.getElementById('command-preview').textContent = '';
  }
}

async function saveProfile() {
  const payload = buildPayload();
  const btn = document.getElementById('save-btn');
  btn.disabled = true;
  setError('review-error', '');
  try {
    await fetchJson('/api/agent-profiles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    window.location.href = '/';
  } catch (err) {
    setError('review-error', err.message || 'Failed to save profile.');
    btn.disabled = false;
  }
}

document.getElementById('model-select').addEventListener('change', (event) => {
  const value = event.target.value.trim();
  if (value) {
    state.model = value;
    document.getElementById('model-manual').value = value;
  }
});

renderRuntimeChoices();
toggleRuntimeSpecificFields();
loadProviders().catch((err) => setError('provider-error', err.message || 'Failed to load providers.'));
</script>
</body>
</html>`;
}
