# Kubernetes Post-Deploy Follow-Ups

## Purpose

This note captures the work that should happen **after** the first successful Gooseherd deployment on Kubernetes.

Scope:

- Kubernetes MVP runtime is already deployed
- normal runs can be started
- runner jobs can execute and report completion

This is **not** the next-generation architecture roadmap (`Pod` vs `Job`, CRD/operator, warm pools).
It is the practical checklist required to move from "it deployed and runs" to "the Kubernetes MVP can be responsibly closed."

## Definition Of "Post-Deploy"

These items start **after** all of the following are true in a real Kubernetes environment:

- Gooseherd app is running in-cluster
- PostgreSQL connectivity is working
- `SANDBOX_RUNTIME=kubernetes` is enabled
- a normal run can be triggered through the product path
- a runner `Job` starts, completes, and reconciles back into Gooseherd

## Must Do Before Closing The Kubernetes MVP

### 1. Stabilize artifact and log persistence

Current local deployment uses ephemeral container storage paths for run outputs.
That is acceptable for local validation, but not strong enough for a real deployment closure.

Required outcome:

- define the supported persistence model for `run.log` and future run artifacts
- ensure logs/artifacts survive normal app pod restarts where expected
- document whether the source of truth is:
  - persistent volume storage
  - object storage
  - or an explicitly temporary local-only mode

Minimum acceptance:

- the team can explain where run logs live in production
- the location survives the failure modes we claim to support
- DevOps has explicit storage expectations in deployment docs

### 2. Hard-test reconciliation on real product paths

The success path already works, but reconciliation is still the highest-risk part of the runtime.

Required scenarios:

- runner reaches terminal Kubernetes state before completion is observed
- completion arrives late after terminal runtime state
- cancellation is requested during a real Kubernetes run
- control-plane process restarts while a Kubernetes run is in flight
- Kubernetes workload disappears unexpectedly

Minimum acceptance:

- terminal run status remains correct after each scenario
- no permanent `running` / `cancel_requested` zombies remain
- cleanup does not erase evidence needed for reconciliation

### 3. Verify cancellation semantics in a real deployment

The code path for Kubernetes cancellation exists, but it should be validated as an operational flow, not only as logic.

Required outcome:

- start a real Kubernetes run
- request cancel through the normal product path
- verify the run ends as `cancelled` rather than `failed`
- verify the Kubernetes workload is cleaned up correctly

Minimum acceptance:

- user-visible status is correct
- no stuck `Job` / `Pod` / per-run `Secret` remains
- no contradictory final states are written back into the run record

### 4. Freeze the deployment contract for DevOps

The deployment is now possible, but the operational contract should be tightened before the MVP is called done.

Required decisions to document explicitly:

- app image and runner image ownership
- required RBAC verbs/resources
- service account expectations
- namespace assumptions
- image pull secret expectations
- resource requests and limits
- storage requirements for logs/artifacts
- required environment variables

Minimum acceptance:

- a DevOps engineer can deploy without reading the implementation code
- no critical runtime dependency remains implicit

## Should Do Soon After MVP Closure

These are important, but they are not blockers for calling the Kubernetes MVP complete.

### 1. Add stronger failure-path coverage

Expand from the current harness and smoke flows into more product-shaped failure verification:

- image pull failures in real deployed environments
- temporary control-plane outages
- invalid token or secret drift cases
- resource pressure / unschedulable workloads

### 2. Improve resource configurability

The current job spec is intentionally minimal.

Likely next knobs:

- `imagePullSecrets`
- `serviceAccountName` override for runner jobs
- CPU and memory requests/limits
- tolerations / node selectors if needed

### 3. Revisit workload primitive choice

The current MVP uses `Job`, which is acceptable.
After MVP closure, revisit whether the long-term primitive should remain:

- Kubernetes `Job`
- bare `Pod`
- CRD/operator-backed sandbox

## Explicitly Not Required For MVP Closure

The following items are valuable, but should not block closing the current Kubernetes MVP:

- switching from `Job` to bare `Pod`
- adopting `agent-sandbox`
- implementing warm pools
- pause/resume support
- full CRD/operator architecture

## Exit Condition

The Kubernetes MVP can be considered responsibly closed once:

- deployment docs are sufficient for DevOps
- artifact/log persistence expectations are explicit and supported
- reconciliation has been exercised on real deployment failure cases
- cancellation has been validated through the normal product path
- a successful run and a cancelled run have both been verified in the deployed environment
