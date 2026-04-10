# Kubernetes Sandbox Runtime Spec

## Goal

Add a new sandbox runtime switch for Gooseherd:

- `SANDBOX_RUNTIME=local|docker|kubernetes`

This setting replaces the old boolean `SANDBOX_ENABLED`.

Scope of the switch:

- `postgres` + main `gooseherd` app continue to run locally via `docker compose`
- only sandbox/run execution changes between `local`, `docker`, and `kubernetes`

## Runtime Modes

### `local`

- Runs directly on the host
- No sandbox container or Kubernetes workload is created
- Uses the same orchestration contract as other runtimes through a shared execution backend

### `docker`

- Preserves the current model
- One long-lived sandbox container per `runId`
- Gooseherd performs multiple `exec` calls into the running container
- Workspace is preserved across commands via mounted work directory

### `kubernetes`

- Uses one Kubernetes `Job` per `runId`
- The runner inside the Job executes the full pipeline end-to-end inside one pod
- Gooseherd does not perform multiple `exec` calls into the pod
- Workspace is ephemeral and local to the pod via `emptyDir`

## Architectural Decision

Kubernetes mode is not a container backend replacement for the current Docker sandbox flow.

Instead, Gooseherd introduces a higher-level run execution abstraction implemented by all runtimes:

- `local`
- `docker`
- `kubernetes`

The important requirement is unified ownership of run lifecycle semantics:

- start
- status
- progress
- cancellation
- completion
- cleanup

Method names may evolve, but ownership must stay in one backend layer rather than being split across unrelated services.

## Truth Model

Three different truths must stay separate:

- Kubernetes is the source of infra execution state
- runner completion record is the source of semantic execution result
- Gooseherd is the source of final business run status

This means:

- Kubernetes `Job` / `Pod` state alone is not enough to determine final run outcome
- runner must emit a machine-readable completion record
- Gooseherd interprets runtime facts plus runner result and writes final state into its own store

## Kubernetes Execution Model

### Workload

- One `Job` per `runId`
- `backoffLimit: 0`
- explicit Gooseherd-side cleanup is the primary cleanup mechanism
- `ttlSecondsAfterFinished` may be used only as a safety net

### Pod model

- One pod owned by the `Job`
- One main execution container inside the pod
- Workspace mounted at `/work`
- Workspace volume type: `emptyDir`

### Runtime dependencies for repository execution

Repository validation and test flows may require runtime dependencies beyond the main execution container.

Examples:

- PostgreSQL
- Redis
- other service dependencies needed by `validation` or `local_test`

The Kubernetes runtime must define how these dependencies are provided.

Acceptable models may include:

- sidecar/service containers in the same pod
- access to externally provisioned services
- repo-specific dependency topology defined as part of execution image/runtime metadata

This is required because a single main container is not sufficient for all repository pipelines.

### Supported dependency boundary for v1

Kubernetes runtime v1 supports only externally provisioned runtime dependencies.

Rules:

- sidecars are not part of the v1 contract
- Job spec builder does not provision repo-specific database or cache sidecars in v1
- repositories executed in Kubernetes mode must rely on pre-existing reachable services when tests require dependencies such as PostgreSQL or Redis

Dependency ownership in v1:

- Gooseherd Kubernetes runtime does not create or own repo test dependency services
- repository environment or surrounding infrastructure is responsible for making required external services reachable

### Dependency configuration contract for v1

Prepared repositories using Kubernetes runtime must expose dependency configuration in a control-plane-readable form.

At minimum, that configuration must define:

- dependency type
- service endpoint or service identifier
- credential source class
- whether the dependency is required for Kubernetes compatibility

Source of truth for v1:

- dependency configuration lives in Gooseherd control-plane metadata for the prepared repository
- configuration may be synchronized from repository config, but control-plane metadata is the canonical runtime source of truth

Environment binding for v1:

- dependency resolution is environment-specific
- Gooseherd resolves dependency endpoints and credentials for the target environment before Job creation
- the runner receives only the already resolved environment-specific dependency metadata needed for execution

Before Job creation, Gooseherd must validate that:

- required dependencies are declared
- required endpoints are resolvable for the target environment
- required credentials are available for injection

If dependency validation fails, Gooseherd must reject Kubernetes execution before launching the Job.

### Runner model

The pod starts a Gooseherd runner that lives in this repository.

The runner:

- loads run payload
- executes the pipeline sequentially inside the pod
- emits structured progress/events
- checks cancellation periodically
- emits a machine-readable completion record

## Payload Model

The Job must receive only lightweight identifiers and references through env vars or args.

The full payload is not embedded in the Job spec.

Job input should include references such as:

- `RUN_ID`
- `PAYLOAD_REF`
- `RUN_TOKEN`
- feature flags
- minimal runtime metadata

The full run payload is stored outside Kubernetes.

Runner resolves payload on startup and fetches:

- task text
- branch / base branch
- pipeline options
- image metadata
- feature flags
- dependency metadata

In Kubernetes runtime v1, runner does not fetch unresolved credential references from payload.

Instead:

- control-plane resolves credential references before Job creation
- runner receives only ready-to-use run-scoped credentials through per-run secrets
- payload may describe credential classes, but not unresolved secret references

## Internal API Contract

Runner communicates with Gooseherd through internal API endpoints authenticated by a one-time run token.

The exact v1 protocol is specified separately in:

- [runner-control-plane-api-spec.md](/home/vsevolod/work/hubstaff/gooseherd/docs/runner-control-plane-api-spec.md)

That document is required for Kubernetes runtime implementation.

## Control-Plane Connectivity

Kubernetes mode requires explicit network connectivity from the runner pod to the Gooseherd control-plane API.

This is a hard requirement because the runner depends on the internal API for:

- payload fetch
- progress/event reporting
- cancellation polling
- completion reporting

### Connectivity contract

- runner receives `GOOSEHERD_INTERNAL_BASE_URL`
- this is the canonical control-plane base URL used by the runner inside the pod
- Kubernetes backend must not infer or guess this address implicitly

### Local development topology

For the first version, the supported local Kubernetes target is `minikube`.

In local development:

- Gooseherd control-plane may continue to run outside Kubernetes via `docker compose`
- Gooseherd must be exposed on an address reachable from `minikube` pods
- runner uses `GOOSEHERD_INTERNAL_BASE_URL` to reach that endpoint

### TLS policy

For local development:

- plain `http` is allowed

For non-local environments:

- `https` should be the default expected mode

### Reachability requirement

Reachability must be validated explicitly.

Rules:

- Kubernetes backend must validate that the configured control-plane endpoint is reachable before relying on Kubernetes execution
- runner should perform an early startup connectivity check before beginning pipeline execution
- if control-plane endpoint is unreachable, the run must fail fast with an infra/runtime error rather than hanging indefinitely

### Ownership

- Gooseherd control-plane owner is responsible for publishing a reachable internal API endpoint
- Kubernetes runtime consumes that endpoint as configuration
- network reachability is part of the runtime contract, not an implicit implementation detail

## Authentication

Job authenticates to the internal API with a one-time run token.

Rules:

- Gooseherd generates token when creating the Job
- token is passed to the Job through a Kubernetes `Secret`
- token is scoped to a single run
- token is used only for internal Gooseherd endpoints

## Secrets Model

Runner must not have broad access to the global secret inventory.

Rules:

- Gooseherd resolves credential references before Job creation
- Gooseherd passes only the minimum secrets required for the specific run
- per-run secrets are delivered to the Job via Kubernetes `Secret`

### Git and GitHub credential contract

Git and GitHub operations in Kubernetes mode are executed by the runner using ready-to-use run-scoped credentials.

In Kubernetes runtime v1:

- runner may perform clone, fetch, push, and PR-related operations when required by the pipeline
- runner does not receive GitHub App private credentials
- runner does not mint GitHub installation tokens by itself
- Gooseherd control-plane resolves upstream GitHub credentials before Job creation
- Gooseherd injects a ready short-lived repo-scoped Git/GitHub token into the Job as a per-run secret

Delivery model for v1:

- the token is delivered via Kubernetes `Secret`
- runner consumes it as a directly usable credential for Git and GitHub operations

This removes ambiguity about whether the runner receives references or already usable credentials.

## Database Model

Two concerns must stay separate:

- Gooseherd control-plane state
- repo/runtime database usage for tests, scripts, or app-level execution

Kubernetes runner must not depend on direct access to Gooseherd control-plane database.

Primary contract:

- runner talks to Gooseherd through internal API

Repo-level runtime databases may still exist independently for validation or test execution.

## Completion Model

Runner must send a machine-readable completion record to Gooseherd.

Completion record should include fields such as:

- `status`
- `reason`
- `metadata`
- `commitSha`
- `changedFiles`
- `prUrl`
- `tokenUsage`
- `title`

Gooseherd then:

- validates the completion payload
- correlates it with Kubernetes runtime state
- writes final run status to DB/store

## State Machine, Idempotency, And Reconciliation

Kubernetes mode requires an explicit run state model with deterministic conflict resolution.

This is necessary to handle races between:

- Kubernetes Job state changes
- runner completion callbacks
- cancellation
- Gooseherd restarts
- duplicate or delayed delivery

### State model

The exact state names may evolve, but the model must distinguish:

- non-terminal orchestration states
- terminal business states
- cancellation intent

Representative states:

- `queued`
- `starting`
- `running`
- `cancel_requested`
- `completed`
- `failed`
- `cancelled`

### Terminal states

Terminal states are:

- `completed`
- `failed`
- `cancelled`

Once a run reaches a terminal state:

- finalization must be idempotent
- no later event may transition it to a different terminal state

### Truth precedence rules

The following precedence rules apply:

- Kubernetes Job state is an infra/runtime fact, not a business outcome by itself
- runner completion record is required for semantic success/failure interpretation
- Gooseherd writes the final business state

Specific rules:

- `Job Succeeded` without a valid completion record must not be treated as successful business completion
- `Job Failed` without a completion record may be finalized as infra/runtime failure after reconciliation determines completion will not arrive
- a valid completion record has higher semantic weight than bare Kubernetes success/failure state
- `cancel_requested` that is accepted before terminal finalization has priority over a later success callback
- a late completion callback after terminal cancellation must not reopen or overwrite the run

### Finalization decision table

Reconciliation must use the following v1 precedence matrix for unfinished runs:

| Cancellation accepted before finalization | Completion status | Kubernetes terminal state | Final Gooseherd business status |
| --- | --- | --- | --- |
| yes | any | any | `cancelled` |
| no | `success` | `Succeeded` | `completed` |
| no | `success` | `Failed` | `failed` |
| no | `success` | missing / force-deleted / unknown | `failed` |
| no | `failed` | `Succeeded` | `failed` |
| no | `failed` | `Failed` | `failed` |
| no | `failed` | missing / force-deleted / unknown | `failed` |
| no | none within completion wait window | `Succeeded` | `failed` |
| no | none within completion wait window | `Failed` | `failed` |

Additional rules:

- completion received after a run is already terminal is a no-op unless logged as a conflict
- completion received after force-delete does not reopen the run
- semantic success requires both a valid success completion and non-contradictory runtime evidence

### Completion idempotency

`POST /internal/runs/:runId/complete` must be idempotent.

Rules:

- completion payload must carry an idempotency key
- Gooseherd must safely accept retries of the same completion callback
- duplicate delivery of the same completion record must be a no-op
- conflicting completion payloads for an already finalized run must be rejected and logged

The exact idempotency key shape may evolve, but it must uniquely identify a completion attempt for a run.

### Reconciliation loop

Gooseherd must run a reconciliation loop for in-flight and recently finished Kubernetes runs.

The reconciliation loop is responsible for detecting and resolving cases such as:

- Job finished but completion callback did not arrive
- completion callback arrived but Gooseherd crashed before finalization
- run marked `cancel_requested` while Job is still active
- duplicate completion delivery after restart
- orphaned Kubernetes Jobs or stale run states

### Recovery rules

Minimum recovery behavior:

- if Job reaches terminal runtime state and no completion record arrives within the configured reconciliation window, Gooseherd must finalize using infra/runtime failure semantics
- if completion record arrives after restart and matches an unfinished run, Gooseherd must resume finalization safely
- if run is already terminal, repeated reconciliation must not change the final outcome
- if Job object disappears unexpectedly, reconciliation must classify the run using the best available runtime and callback evidence

### Initial timing policy for v1

Kubernetes runtime v1 uses the following initial default timing policy:

- completion wait after terminal Job state: `30s`
- cancellation polling interval inside runner: `5s`
- cancellation grace period before force deletion: `30s`
- recoverable reconciliation window after restart or lost callback: `15m`

These values may later become configurable, but v1 requires concrete defaults so runtime behavior is deterministic.

### Finalization sequencing

Finalization order in v1 is:

1. collect terminal runtime evidence
2. wait for completion callback within the completion wait window
3. apply cancellation precedence if cancellation was accepted
4. resolve final business status via the decision table
5. persist final status idempotently
6. continue with cleanup subject to artifact retention sequencing

## Progress And Logs

Progress is a push-based contract from the runner to Gooseherd.

Required model:

- runner sends structured progress/events to API
- Gooseherd may also inspect pod logs as raw execution output when needed

Pod logs are supplemental raw output, not the only structured status channel.

### Progress and completion delivery model

Outbound runner callbacks are useful, but correctness must not depend exclusively on callback delivery.

Required model:

- control-plane-driven reconciliation is mandatory
- runner callbacks act as fast-path delivery for progress and completion
- callback failure or delay must not make finalization impossible

This means completion API is part of the execution contract, but reconciliation remains the canonical recovery path when callbacks are lost or duplicated.

## Artifacts

Artifacts must be handled separately from the completion callback.

This includes:

- run log
- screenshots
- browser console logs
- browser network logs
- diff summary
- patch/result bundle if needed

Completion callback should carry metadata and references, not large artifact payloads.

Artifacts should be uploaded to dedicated storage such as:

- object storage
- file-backed artifact store
- another explicit artifact persistence layer

### Required artifact contract

Because Kubernetes workspace uses `emptyDir`, artifacts cannot rely on the pod-local filesystem as their durable source of truth.

For Kubernetes mode, the system must define an explicit artifact upload contract.

At minimum, the design must support persistence for:

- raw run log
- screenshots
- browser console / network debug output
- diff summary
- other post-mortem debug artifacts required by dashboard or investigation flows

The artifact model must define:

- which artifacts are mandatory vs optional
- when artifacts are uploaded
- size limits
- retry policy for uploads
- behavior when pod exits or crashes before upload completes

### Canonical artifact backend for v1

Kubernetes runtime v1 uses object storage as the canonical artifact backend.

Rules:

- Gooseherd control-plane is the source of truth for artifact metadata
- Gooseherd provides upload targets or equivalent upload metadata for runner-produced artifacts
- runner uploads artifacts directly to object storage
- dashboard and post-mortem flows read artifact metadata through Gooseherd, not from pod-local filesystem assumptions

The completion callback carries artifact references and upload status, not large inline artifact payloads.

### Artifact upload protocol for v1

Artifact upload in v1 follows this protocol:

1. Gooseherd allocates run-scoped upload targets before or at runner startup
2. runner obtains upload metadata from control-plane via the internal API
3. runner persists the raw run log progressively during execution to the canonical artifact backend
4. runner uploads non-log artifacts during execution or during finalization using control-plane-issued targets
5. completion callback reports artifact references and artifact completeness state

Upload targets are not created implicitly by the runner.

### Artifact completeness and finalization

Run finalization and artifact completeness are related but not identical.

Mandatory artifacts in v1:

- raw run log
- completion metadata

Optional artifacts in v1 unless required by active pipeline steps:

- screenshots
- browser console logs
- browser network logs
- diff summary
- patch/result bundle

Rules:

- successful business finalization requires mandatory artifact persistence to have been attempted
- optional artifact upload failure does not by itself prevent finalization
- completion must report whether artifact state is `complete`, `partial`, or `failed`
- dashboard and post-mortem flows must rely on stored artifact metadata rather than assuming all optional artifacts exist

### Artifact ownership

Kubernetes runner is responsible for producing artifacts and initiating upload of run-scoped artifacts before successful completion.

Gooseherd control-plane is responsible for:

- storing artifact metadata and references
- presenting artifacts in dashboard / post-mortem workflows
- applying retention policy

### Failure behavior

Artifact upload failures must not be hidden.

Rules:

- completion record should include artifact upload status or artifact reference metadata
- partial artifact persistence must be representable
- reconciliation and post-mortem tooling must not assume that pod-local files remain available after Job cleanup
- cancelled and infra-failed runs must still attempt mandatory artifact flush when feasible

## Cancellation Contract

Cancellation is required.

Minimum contract:

- Gooseherd marks run as `cancel_requested`
- runner periodically checks cancellation state
- runner exits gracefully when cancellation is observed
- Gooseherd may force-delete the Kubernetes `Job` after a grace period
- Gooseherd writes final business status

### Cancellation timing and hard-kill behavior

Kubernetes mode must define operational cancellation guarantees.

The final implementation must specify:

- cancellation polling interval
- expected maximum cancellation latency under normal conditions
- grace period between `cancel_requested` and force deletion

Hard-kill behavior must also be explicit.

Rules:

- if runner is force-terminated before sending completion, Gooseherd reconciliation must finalize the run from cancellation and runtime evidence
- forced deletion must not leave the run indefinitely non-terminal
- a run that was explicitly cancelled must not later become `completed` due to a delayed success signal
- cleanup of Job and pod resources must not happen before mandatory artifact flush has been attempted unless infrastructure failure makes that impossible

### Cleanup sequencing for v1

Cleanup sequencing in Kubernetes runtime v1 is:

1. request cancellation if applicable
2. allow runner grace period to flush mandatory artifacts and send completion
3. force-delete Job only after grace period expires or runner is unreachable
4. reconcile final business status
5. clean up Kubernetes runtime objects
6. retain artifact metadata and stored artifacts according to Gooseherd retention policy

Cancelled runs and infra-failed runs must still attempt mandatory artifact preservation before runtime object cleanup when feasible.

## Image Model

Kubernetes mode accepts only a ready execution image tag.

Rules:

- no dynamic build at runtime
- no `dockerfile` / `dockerfile_inline` build flow in Kubernetes mode
- repo configuration must resolve to a prebuilt image tag

Image build ownership:

- repository keeps its Dockerfile
- CI builds and publishes the execution image ahead of time
- Gooseherd runtime only consumes the published image tag

### Image source of truth

Kubernetes mode requires a deterministic source of truth for execution image resolution.

The system must define:

- how an image is resolved for a given `owner/repo`
- whether image selection is branch-specific
- what metadata is stored in Gooseherd for image lookup
- how image/version drift is detected

Representative resolution model:

- repo configuration resolves to a published execution image tag
- image metadata may optionally include branch, revision, or compatibility metadata
- Gooseherd validates that Kubernetes mode has a usable execution image before starting the run

Source of truth for v1:

- Gooseherd control-plane metadata for the prepared repository is the canonical source of execution image selection
- that metadata binds the target environment and repository context to a concrete published image tag or digest

### Compatibility contract for v1

Execution image compatibility with the deployed Gooseherd control-plane must be validated before Job creation.

V1 requirements:

- execution image must declare runner compatibility metadata
- control-plane must verify that the image is compatible with the required runner/control-plane protocol
- incompatible or missing compatibility metadata is a hard error

V1 compatibility handshake:

- execution image compatibility metadata is recorded in Gooseherd control-plane metadata for the prepared repository
- the canonical compared field is `runnerProtocolVersion`
- control-plane compares the image's declared `runnerProtocolVersion` against the control-plane supported protocol version set
- if no compatible protocol match exists, Gooseherd rejects the run before Job creation

This prevents version skew where control-plane semantics change while repo images lag behind.

### Missing image behavior

Behavior when no valid execution image exists must be explicit.

Rules:

- Kubernetes mode must fail fast with a user-visible configuration/runtime error if no execution image can be resolved
- there is no implicit fallback to runtime Docker build
- there is no implicit fallback to `dockerfile` / `dockerfile_inline`
- any fallback to a default image must be an explicit product policy, not an implementation accident

This is required to preserve predictable behavior for arbitrary repositories and branches.

### Supported repository scope

Kubernetes runtime v1 supports only prepared repositories with a prebuilt compatible execution image.

It does not define a general-purpose runtime for arbitrary GitHub repositories without prior image preparation.

If a repository does not have a valid Kubernetes execution image, Gooseherd must fail with a clear user-visible configuration/runtime error rather than attempting implicit fallback behavior.

## Runner Ownership

Because the runner code lives in this repository, repo execution images must include Gooseherd runner code.

The build model must be explicit. Acceptable approaches include:

- repo image built `FROM` a shared Gooseherd runner base image
- repo image layering in the Gooseherd runner as a dedicated runtime layer

This must not be implicit.

The execution image must contain:

- shell / git
- agent CLIs
- repo toolchain
- Gooseherd runner entrypoint

## Orchestration Boundary

Run execution backends share a lifecycle contract, but not necessarily the same process topology.

This distinction must be explicit.

### Shared contract

All runtimes participate in the same high-level run lifecycle:

- start
- progress
- status
- cancellation
- completion
- cleanup

### Different execution topologies

Current topology differs by runtime:

- `local` and `docker`: Gooseherd main process orchestrates the pipeline directly
- `kubernetes`: Gooseherd launches a Job, and runner inside the pod orchestrates the pipeline locally

This means the system does not have one single orchestration process model across all runtimes.

### Shared pipeline logic requirement

To avoid duplicated behavior and feature drift, pipeline node logic must remain shared even if orchestration topology differs.

The design goal is:

- one shared pipeline engine / pipeline node implementation library
- different runtime-specific entrypoints that invoke that shared logic

Canonical rule:

- the shared pipeline engine is the single source of truth for pipeline semantics across all runtimes
- Kubernetes runner must invoke the same pipeline engine, not a separately reimplemented pipeline model

This is required to avoid:

- duplicated node behavior
- feature parity drift between Docker and Kubernetes runtimes
- divergent cancellation or retry semantics

### Ownership rule

The run execution backend owns runtime lifecycle integration.

The pipeline engine owns pipeline semantics.

Those concerns must not be reimplemented independently per runtime.

## Cleanup Policy

Primary cleanup is Gooseherd-managed, not Kubernetes-managed.

Gooseherd must own retention policy for:

- logs
- artifacts
- debug data
- Kubernetes runtime objects

`ttlSecondsAfterFinished` may exist only as a safety net for orphaned workloads.

## Non-Goals For First Version

- no runtime image build in Kubernetes mode
- no direct reuse of Docker `exec`-based sandbox flow in Kubernetes mode
- no dependency on Kubernetes Job retry semantics
- no broad runner access to global secret inventory

## Summary

Final runtime contract:

- `local` uses host execution through the shared run execution backend
- `docker` preserves the current sandbox container + `exec` model
- `kubernetes` uses one `Job` per `runId`, with a Gooseherd runner executing the entire pipeline inside the pod

Final truth contract:

- Kubernetes = infra state
- runner completion record = semantic result
- Gooseherd = final business status
