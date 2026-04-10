# Runner / Control-Plane API Spec

## Goal

Define the v1 protocol between Kubernetes runner jobs and Gooseherd control-plane.

This document complements:

- [kubernetes-sandbox-runtime-spec.md](/home/vsevolod/work/hubstaff/gooseherd/docs/kubernetes-sandbox-runtime-spec.md)

## Authentication

All runner API calls use the one-time run token issued by Gooseherd for a single run.

Properties:

- scoped to one `runId`
- delivered to runner via Kubernetes `Secret`
- valid only for internal runner/control-plane endpoints

## Endpoint Set

V1 endpoint classes:

- payload fetch
- artifact upload target fetch
- event append
- cancellation state fetch
- completion submit

Representative endpoints:

- `GET /internal/runs/:runId/payload`
- `GET /internal/runs/:runId/artifacts`
- `POST /internal/runs/:runId/events`
- `GET /internal/runs/:runId/cancellation`
- `POST /internal/runs/:runId/complete`

## Response And Error Contract

V1 runner behavior depends on response classes rather than endpoint-specific ad hoc logic.

### Success

- `2xx`: request accepted or data returned; runner continues normally

### Authentication / authorization failure

- `401` / `403`: terminal auth failure for the current run token
- runner must stop retrying the same request and surface infra/runtime failure

### Not found

- `404`: terminal for payload and completion target lookup unless explicitly documented otherwise
- runner must stop retrying and fail the run as control-plane/runtime mismatch

### Conflict

- `409`: semantic conflict
- for `complete`, this means conflicting completion against already finalized state; runner must stop retrying and log conflict
- for `events`, Gooseherd may treat duplicate idempotent event submissions as accepted or conflict-equivalent no-op

### Validation failure

- `422`: terminal caller/input error
- runner must stop retrying and fail the run with protocol/runtime error

### Retryable server or transport failure

- `5xx`, timeout, connection reset, DNS/network failure: retryable
- runner should retry with bounded backoff
- if retry budget is exhausted, runner fails the run or relies on reconciliation where the runtime spec allows it

## Payload Endpoint

`GET /internal/runs/:runId/payload`

Returns run-scoped execution data, including:

- task text
- branch / base branch
- pipeline options
- image metadata
- feature flags
- dependency metadata
- artifact upload metadata or discovery references

The payload does not contain unresolved secret references in Kubernetes runtime v1.

## Artifact Upload Metadata Endpoint

`GET /internal/runs/:runId/artifacts`

Returns artifact upload targets or equivalent upload metadata for runner-produced artifacts.

V1 guarantees:

- targets are run-scoped
- mandatory artifact classes are identifiable
- repeated reads are idempotent

## Events Endpoint

`POST /internal/runs/:runId/events`

Appends structured runner events.

V1 semantics:

- append-only
- duplicate event submissions may occur
- callers should include event idempotency identifiers where available
- Gooseherd may safely de-duplicate repeated events

### Event schema and ordering for v1

Minimum required event fields:

- `eventId`
- `eventType`
- `timestamp`
- `sequence`
- `payload`

Required v1 event types:

- `run.started`
- `run.progress`
- `run.phase_changed`
- `run.warning`
- `run.artifact_status`
- `run.cancellation_observed`
- `run.completion_attempted`

Ordering rule:

- runner emits monotonically increasing `sequence` numbers per run attempt
- Gooseherd treats `sequence` as the canonical in-run ordering signal
- duplicate events are events with the same `eventId`
- de-duplication must not collapse distinct events that share `eventType` but have different `eventId` or `sequence`

`run.progress` is a progress update event.
`run.phase_changed` is a lifecycle transition event.

## Cancellation Endpoint

`GET /internal/runs/:runId/cancellation`

Returns state-based cancellation information, not edge-triggered delivery.

V1 semantics:

- runner polls this endpoint periodically
- response indicates whether cancellation has been requested and accepted
- repeated reads are safe and expected

## Completion Endpoint

`POST /internal/runs/:runId/complete`

Submits machine-readable completion for the run.

Completion payload includes:

- completion idempotency key
- semantic status
- reason / metadata
- artifact references
- artifact completeness state
- pipeline outputs such as commit SHA, changed files, PR URL, token usage, title

V1 semantics:

- idempotent for the same idempotency key
- retry after transport timeout is allowed
- duplicate submissions with the same idempotency key are no-ops
- conflicting submissions after finalization are rejected and logged

## Idempotency

The protocol requires idempotent completion handling and safe retry behavior.

Minimum rules:

- completion idempotency key uniquely identifies one completion attempt for one run
- transport uncertainty does not require the runner to read prior state before retrying completion
- control-plane must tolerate repeated delivery for events and completion

## Ownership

This API defines protocol semantics only.

Business status finalization, precedence rules, cleanup ordering, and runtime compatibility are governed by:

- [kubernetes-sandbox-runtime-spec.md](/home/vsevolod/work/hubstaff/gooseherd/docs/kubernetes-sandbox-runtime-spec.md)
