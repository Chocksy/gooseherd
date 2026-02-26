#!/usr/bin/env bash
set -euo pipefail

# Sandbox-compatible dummy agent for E2E testing.
# Makes a simple change and takes a screenshot using Chromium.
#
# Usage: sandbox-dummy-agent.sh <repo_dir> <prompt_file> <run_id>
# Expected to run INSIDE the sandbox container where /work is the run dir.

REPO_DIR="${1:?repo dir is required}"
PROMPT_FILE="${2:?prompt file is required}"
RUN_ID="${3:?run id is required}"
# Ignore extra arguments (e.g. MCP extension flags appended by implement node)
shift 3 || true

cd "$REPO_DIR"

# Read the task from prompt file
TASK=$(cat "$PROMPT_FILE" 2>/dev/null || echo "No task provided")

# Make a simple change — add a visible section to README
cat >> README.md <<EOF

## Sandbox Run ${RUN_ID}

This change was made by Gooseherd running inside an isolated Docker sandbox container.

**Task:** ${TASK}

*Generated at $(date -u +"%Y-%m-%dT%H:%M:%SZ")*
EOF

# Create a styled HTML page for the screenshot
cat > /tmp/sandbox-report.html <<'EOHTML'
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: linear-gradient(135deg, #0f0c29, #302b63, #24243e);
      color: #e0e0e0;
      min-height: 100vh;
      padding: 60px;
    }
    .card {
      background: rgba(255,255,255,0.08);
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 16px;
      padding: 48px;
      max-width: 800px;
      margin: 0 auto;
      backdrop-filter: blur(20px);
    }
    h1 {
      font-size: 32px;
      font-weight: 700;
      margin-bottom: 8px;
      background: linear-gradient(90deg, #a78bfa, #60a5fa);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .subtitle {
      color: #94a3b8;
      font-size: 14px;
      margin-bottom: 32px;
    }
    .field { margin-bottom: 20px; }
    .label {
      font-size: 12px;
      font-weight: 600;
      color: #94a3b8;
      text-transform: uppercase;
      letter-spacing: 1px;
      margin-bottom: 6px;
    }
    .value {
      font-size: 16px;
      color: #f1f5f9;
      line-height: 1.5;
    }
    .badge {
      display: inline-block;
      background: rgba(34, 197, 94, 0.15);
      color: #4ade80;
      padding: 4px 12px;
      border-radius: 20px;
      font-size: 13px;
      font-weight: 600;
    }
    .divider {
      border: none;
      border-top: 1px solid rgba(255,255,255,0.08);
      margin: 24px 0;
    }
    .footer {
      font-size: 12px;
      color: #64748b;
      text-align: center;
      margin-top: 32px;
    }
  </style>
</head>
<body>
  <div class="card">
    <h1>Gooseherd Sandbox Run</h1>
    <p class="subtitle">Docker-isolated agent execution</p>
    <hr class="divider">
    <div class="field">
      <div class="label">Status</div>
      <div class="value"><span class="badge">Completed</span></div>
    </div>
    <div class="field">
      <div class="label">Run ID</div>
      <div class="value" id="run-id"></div>
    </div>
    <div class="field">
      <div class="label">Environment</div>
      <div class="value">Docker container (gooseherd/sandbox:default)</div>
    </div>
    <div class="field">
      <div class="label">Changes Made</div>
      <div class="value">Updated README.md with sandbox run details</div>
    </div>
    <hr class="divider">
    <div class="footer">
      Gooseherd &mdash; Autonomous coding agent orchestrator
    </div>
  </div>
  <script>
    document.getElementById('run-id').textContent = 'PLACEHOLDER_RUN_ID';
  </script>
</body>
</html>
EOHTML

# Inject run ID into the HTML
sed -i "s/PLACEHOLDER_RUN_ID/${RUN_ID}/g" /tmp/sandbox-report.html

# Take screenshot — save to /work (the run directory root) so dashboard can serve it
chromium --headless --no-sandbox --disable-gpu --disable-software-rasterizer \
  --screenshot=/work/screenshot.png --window-size=1280,800 \
  file:///tmp/sandbox-report.html 2>/dev/null || echo "Screenshot capture failed (non-fatal)"

echo "[sandbox-dummy-agent] Done. Changed README.md, screenshot at /work/screenshot.png"
