# Unified Dashboard Webhooks Design

## Goal

Serve `POST /webhooks/*` from the same HTTP server and public port as the dashboard so local and tunneled deployments only need one externally exposed port.

## Design

- Keep webhook parsing, signature verification, and event translation in `src/observer/webhook-server.ts`.
- Reuse that module as a request handler instead of always starting a dedicated HTTP listener.
- Route `/webhooks/*` through `src/dashboard-server.ts` before dashboard auth runs.
- Preserve logical separation:
  - dashboard auth continues to protect dashboard and `/api/*`
  - webhook routes stay HMAC/secret protected and do not depend on dashboard cookies or bearer tokens
- Preserve backward compatibility:
  - if dashboard is disabled, observer may still bind its dedicated webhook listener on `OBSERVER_WEBHOOK_PORT`
  - if dashboard is enabled, observer should not open the extra webhook port

## Risks

- Accidentally running dashboard auth before webhook handling would break GitHub deliveries with `401` or redirects.
- Accidentally dropping observer side effects would break event enqueueing and work-item webhook sync.
- Local Kubernetes docs and service manifests may still mention the old two-port flow and need tightening.

## Verification

- `checkAuth()` allows `/webhooks/*` through unchanged.
- Dashboard server accepts webhook requests on `DASHBOARD_PORT`.
- `ObserverDaemon.start()` does not fail when `observerWebhookPort` is unavailable but `dashboardEnabled=true`.
- Existing `/healthz` stays intact.
