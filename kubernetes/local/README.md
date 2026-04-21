# Local Minikube Deployment

This directory contains the minimal Kubernetes manifests for running Gooseherd end-to-end inside local `minikube`.

The local app image is intentionally built from `kubernetes/app.Dockerfile`, not the heavier top-level `Dockerfile`.
That keeps the local Kubernetes control-plane image focused on dashboard/API/runtime orchestration instead of browser tooling and local sandbox dependencies.

The intended flow is:

1. build/load the Gooseherd app image
2. build/load the runner image
3. create the `gooseherd` namespace and local PostgreSQL
4. create the Gooseherd app `Secret` from your local `.env`
5. create the Gooseherd runtime `ConfigMap` with Kubernetes-specific values
6. apply RBAC, deployment, PVC, and service
7. bootstrap the setup wizard through a temporary local `port-forward`
8. reach the dashboard with `kubectl port-forward`

`npm run k8s:local-up` applies the namespace, PostgreSQL deployment, work PVC, RBAC, and service manifests directly, then creates `gooseherd-env` and `gooseherd-config` dynamically so the current runner image tag and cluster DNS callback URL are injected into the deployment.

The local bundle keeps `/app/.work` on a `PersistentVolumeClaim` named `gooseherd-work`.
That means run logs and artifacts survive normal `gooseherd` pod restarts inside the namespace.

The repo also includes `kubernetes/local/gooseherd-runner-network-policy.yaml` as an optional restrictive egress policy for runner pods. `npm run k8s:local-up` does not apply it by default.

Recommended commands:

```bash
npm run k8s:local-up
kubectl -n gooseherd port-forward svc/gooseherd 8787:8787 9090:9090
```

The local helper prints the bootstrap dashboard password after deployment.
By default it is `gooseherd-local`, and you can override it with `GOOSEHERD_LOCAL_DASHBOARD_PASSWORD`.

To inspect status:

```bash
npm run k8s:local-status
```

To tear the local deployment down:

```bash
npm run k8s:local-down
```
