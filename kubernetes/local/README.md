# Local Minikube Deployment

This directory contains the minimal Kubernetes manifests for running Gooseherd end-to-end inside local `minikube`.

The local app image is intentionally built from `kubernetes/app.Dockerfile`, not the heavier top-level `Dockerfile`.
That keeps the local Kubernetes control-plane image focused on dashboard/API/runtime orchestration instead of browser tooling and local sandbox dependencies.

The intended flow is:

1. build/load the Gooseherd app image
2. build/load the runner image
3. create the `gooseherd` namespace and local PostgreSQL
4. create the Gooseherd app secret from your local `.env`
5. apply RBAC, config, deployment, and service
6. bootstrap the setup wizard through a temporary local `port-forward`
7. reach the dashboard with `kubectl port-forward`

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
