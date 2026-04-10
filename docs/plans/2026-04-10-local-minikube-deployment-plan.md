# Local Minikube Deployment Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Gooseherd runnable end-to-end inside local `minikube`, so a normal dashboard or Slack-triggered run can execute through `SANDBOX_RUNTIME=kubernetes` without depending on host-side `docker compose` for the control plane.

**Architecture:** Keep the current one-`Job`-per-run model and API-native Kubernetes backend. Add a minimal local deployment package for `minikube`: Gooseherd app `Deployment`, PostgreSQL, `ServiceAccount`/RBAC, `Service`, and a simple access path such as `port-forward` or `minikube service`. Preserve the existing `docker compose` flow as the recommended local path for `SANDBOX_RUNTIME=local|docker`.

**Tech Stack:** Kubernetes (`minikube`), Docker image build/load, TypeScript/Node.js Gooseherd app, PostgreSQL, YAML manifests or minimal Helm/kustomize-free deployment bundle

---

### Task 1: Define Local Minikube Deployment Shape

**Files:**
- Create: `docs/plans/2026-04-10-local-minikube-deployment-plan.md`
- Modify: `README.md`
- Modify: `docs/installation-kubernetes.md`

- [ ] Document the local target topology:
  - Gooseherd app runs in `minikube`
  - PostgreSQL runs in `minikube`
  - Gooseherd app reaches Kubernetes API through pod `ServiceAccount`
  - runner jobs reach Gooseherd through cluster DNS
  - local user reaches Gooseherd through `kubectl port-forward` or `minikube service`
- [ ] Make the docs explicitly distinguish:
  - `docker compose` path for `SANDBOX_RUNTIME=local|docker`
  - `minikube` path for `SANDBOX_RUNTIME=kubernetes`
- [ ] Commit docs-only clarification if desired before manifest work.

### Task 2: Add Minimal Local Kubernetes Manifests

**Files:**
- Create: `kubernetes/local/namespace.yaml`
- Create: `kubernetes/local/postgres.yaml`
- Create: `kubernetes/local/gooseherd-configmap.yaml`
- Create: `kubernetes/local/gooseherd-secret.example.yaml`
- Create: `kubernetes/local/gooseherd-rbac.yaml`
- Create: `kubernetes/local/gooseherd-deployment.yaml`
- Create: `kubernetes/local/gooseherd-service.yaml`
- Create: `kubernetes/local/README.md`

- [ ] Create a dedicated local namespace, for example `gooseherd`.
- [ ] Define PostgreSQL deployment/service or statefulset/service suitable for local `minikube`.
- [ ] Define Gooseherd `ConfigMap` with Kubernetes-mode values:
  - `SANDBOX_RUNTIME=kubernetes`
  - `KUBERNETES_NAMESPACE=gooseherd`
  - `KUBERNETES_INTERNAL_BASE_URL=http://gooseherd.gooseherd.svc.cluster.local:8787`
  - `WORK_ROOT=/app/.work`
  - `DATA_DIR=/app/data`
  - `DASHBOARD_HOST=0.0.0.0`
- [ ] Define Gooseherd `Secret` example for:
  - `DATABASE_URL`
  - `ENCRYPTION_KEY`
  - GitHub/LLM/Slack credentials as needed
- [ ] Define `ServiceAccount`, `Role`, and `RoleBinding` matching current runtime needs:
  - `jobs`
  - `pods`
  - `pods/log`
  - `secrets`
- [ ] Define Gooseherd `Deployment` that uses:
  - the app image
  - the `ServiceAccount`
  - persistent volumes for `/app/.work` and `/app/data` if needed for local survivability
- [ ] Define Gooseherd `Service` for port `8787` and optionally `9090`.

### Task 3: Add Local Image Build And Load Workflow

**Files:**
- Create: `scripts/kubernetes/build-app-image.sh`
- Modify: `scripts/kubernetes/build-runner-image.sh`
- Modify: `README.md`
- Modify: `kubernetes/local/README.md`

- [ ] Create a local script that builds the Gooseherd app image from the current worktree and loads it into `minikube`.
- [ ] Keep runner image build/load separate, because the app image and runner image serve different purposes.
- [ ] Make the local docs show the exact order:
  - build app image
  - build runner image
  - `kubectl apply` local manifests
  - wait for app readiness
  - `kubectl port-forward` service or use `minikube service`

### Task 4: Add A Repeatable Local Launch Flow

**Files:**
- Create: `scripts/kubernetes/local-up.sh`
- Create: `scripts/kubernetes/local-down.sh`
- Create: `scripts/kubernetes/local-status.sh`
- Modify: `package.json`
- Modify: `README.md`

- [ ] Add one script to:
  - ensure `minikube` is running
  - build/load app image
  - build/load runner image
  - apply local manifests
  - wait for `Deployment` readiness
  - print the exact `port-forward` command for UI access
- [ ] Add one script to remove the local Kubernetes deployment cleanly.
- [ ] Add one script to inspect:
  - Gooseherd pods
  - PostgreSQL pod
  - runner jobs
  - recent logs
- [ ] Add `npm` helpers if they improve discoverability, for example:
  - `npm run k8s:local-up`
  - `npm run k8s:local-down`
  - `npm run k8s:local-status`

### Task 5: Verify Full Local Kubernetes Flow

**Files:**
- Modify if needed: `README.md`
- Modify if needed: `docs/installation-kubernetes.md`
- Modify if needed: `kubernetes/local/README.md`

- [ ] Verify the local sequence end-to-end:
  - Gooseherd pod becomes ready
  - dashboard is reachable locally
  - a normal run triggered from UI or `local:trigger` reaches `running`
  - Gooseherd creates `Secret` and `Job`
  - runner pod reaches Gooseherd internal API via cluster DNS
  - run finalizes as `completed`
  - cleanup removes `Job`/`Pod`/`Secret`
- [ ] Capture any remaining local-only caveats:
  - image pull policy behavior
  - how to update images after code changes
  - whether `port-forward` must remain open
  - storage reset expectations after `minikube delete`

### Task 6: Update Top-Level Docs

**Files:**
- Modify: `README.md`
- Modify: `docs/deployment.md`
- Modify: `docs/installation-kubernetes.md`

- [ ] Make the top-level docs unambiguous:
  - `docker compose` quick start is for `local|docker`
  - `minikube` quick start is for `kubernetes`
- [ ] Link the local `minikube` workflow from the top-level README.
- [ ] Keep the current caveat that this is still `Job`-based orchestration, not CRD/operator-based orchestration.
