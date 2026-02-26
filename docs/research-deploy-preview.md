# Deploy Preview & Browser Verify — Research Findings

## Date: 2026-02-26

---

## 1. How Hubstaff's `/review deploy` Works

**Trigger chain:**
```
PR comment: "/review deploy"
  → peter-evans/slash-command-dispatch@v5 (review-dispatch.yml)
  → repository_dispatch: review-deploy-command
  → review-deploy-command.yml
  → NetsoftHoldings/github-actions/.github/workflows/review-deploy.yml (reusable)
```

**What happens:**
1. Init job extracts `pr_number` and `branch_ref` from `github.event.client_payload.pull_request`
2. Creates a K8s namespace: `hubstaff-{app_name}-review-{pr_number}`
3. Builds Docker image via `werf converge` and deploys to EKS
4. Creates a **GitHub Deployment** with `environment_url`:
   ```
   https://{pr_number}.app.review.hbstf.co
   ```
5. Posts PR comment with URL, namespace, console commands, Grafana log link

**URL pattern:** `https://{pr_number}.{app_subname}.review.hbstf.co`
- For `server`: `https://42.app.review.hbstf.co`
- For `marketing-api`: `https://42.api.marketing.review.hbstf.co`

**Status reporting:** Two channels:
- GitHub Deployment Status API (`chrnorm/deployment-action@v2` + `chrnorm/deployment-status@v2`)
- PR comment (`thollander/actions-comment-pull-request@v3`)

---

## 2. Coolify Preview Deployments for EpicPxls

### Current State
- pxls-staging-app UUID: `fsc8oog4c8kcocsk8s00gskc`
- Branch: `master`, FQDN: `https://stg.epicpxls.com`
- `preview_url_template: {{pr_id}}.{{domain}}` (already configured!)
- Preview deployments: **not yet enabled** (needs toggle + DNS)

### What Coolify Preview Deployments Do
- Auto-deploy isolated container per PR (on open/push)
- Auto-destroy on PR merge/close
- Posts PR comment with URL (via GitHub App method)
- Container named: `{app_uuid}-pr-{pr_id}`

### URL Pattern
With template `{{pr_id}}.{{domain}}` and domain `stg.epicpxls.com`:
```
PR #42 → https://42.stg.epicpxls.com
```

**Note:** Nested subdomains can cause SSL issues. Alternative:
```
{{pr_id}}-{{domain}} → https://42-stg.epicpxls.com
```

### What's Needed to Enable
1. **Wildcard DNS**: `*.stg.epicpxls.com` → `95.217.176.151` (Hetzner server IP)
2. **GitHub App permissions**: Pull Requests → Read/Write, subscribe to PR event
3. **Toggle ON** in Coolify: Application → Advanced Settings → Preview Deployments
4. (Optional) Set preview-specific env vars

### API Trigger (Alternative to Auto-Deploy)
```bash
curl -X GET "https://dash.chocksy.com/api/v1/deploy?uuid=fsc8oog4c8kcocsk8s00gskc&pr=42" \
  -H "Authorization: Bearer ${COOLIFY_TOKEN}"
```

---

## 3. The Three Deployment Platforms (for Install Script)

| Platform | URL Pattern | How URL is Obtained |
|----------|-------------|-------------------|
| **Coolify** | `{{pr_id}}.{{domain}}` | Deterministic — construct from PR number |
| **Hubstaff/EKS** | `{pr}.app.review.domain` | GitHub Deployment API (`environment_url`) |
| **Vercel** | Auto-generated | GitHub Deployment API (`environment_url`) |
| **Netlify** | `deploy-preview-{pr}--{site}.netlify.app` | Deterministic — construct from PR number |
| **Heroku Review Apps** | `{app}-pr-{pr}.herokuapp.com` | Deterministic — construct from PR number |
| **Custom command** | Varies | Extract URL from command stdout |

### Key Insight
Most platforms fall into **two categories**:
1. **Deterministic URL** — construct from PR number + domain template
2. **GitHub Deployment API** — poll for `environment_url` from deployment statuses

A third option (run a command, extract URL from stdout) is needed for custom setups.

---

## 4. Install Script Vision

The install script asks:

```
Do you use review/preview apps? [y/n]
→ y

How are preview URLs determined?

  1) URL pattern (I know the URL template)
     Example: https://{{prNumber}}.stg.epicpxls.com

  2) GitHub Deployment API (service posts deployment status)
     Works with: Vercel, Netlify, Hubstaff review, Render

  3) Deploy command (I run a command that outputs a URL)
     Example: review deploy {{branchName}}

→ 1

Enter URL pattern: https://{{prNumber}}.stg.epicpxls.com
Wait for URL to be ready? [y/n, default: y]: y
Readiness timeout (seconds) [default: 300]: 120
Capture screenshot? [y/n, default: y]: y
```

This generates the pipeline YAML node:

```yaml
- id: deploy_preview
  action: deploy_preview
  type: deterministic
  config:
    strategy: url_pattern
    url_pattern: "https://{{prNumber}}.stg.epicpxls.com"
    readiness_timeout_seconds: 120
    readiness_poll_interval_seconds: 10

- id: browser_verify
  action: browser_verify
  type: deterministic
  enabled: true
  on_soft_fail: warn
  config:
    screenshot: true
```

No env vars needed. Everything in the YAML. One code path per strategy.

---

## 5. Recommended Simplification of deploy_preview Node

Current code tries 3 strategies with env var fallbacks — this is the "slop" to clean up.

**New approach:** Single `strategy` field in node config, one code path:

```typescript
interface DeployPreviewConfig {
  strategy: "url_pattern" | "github_deployment_api" | "command";

  // For strategy: url_pattern
  url_pattern?: string;  // e.g. "https://{{prNumber}}.stg.epicpxls.com"

  // For strategy: github_deployment_api
  github_environment_pattern?: string;  // regex for deployment env name

  // For strategy: command
  command?: string;
  url_extract_pattern?: string;
  url_extract_strategy?: "last" | "first";

  // Shared
  readiness_timeout_seconds?: number;
  readiness_poll_interval_seconds?: number;
}
```

The node reads `config.strategy` and runs exactly ONE code path. No fallback chain.
No env vars (except for secrets like API tokens).
