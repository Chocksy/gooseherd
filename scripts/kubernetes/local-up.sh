#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NAMESPACE="gooseherd"
APP_IMAGE="${KUBERNETES_APP_IMAGE:-gooseherd/app:dev}"
RUNNER_IMAGE="${KUBERNETES_RUNNER_IMAGE:-gooseherd/k8s-runner:dev}"
ENV_FILE="${GOOSEHERD_ENV_FILE:-${ROOT_DIR}/.env}"
LOCAL_DASHBOARD_PORT="${GOOSEHERD_LOCAL_DASHBOARD_PORT:-18787}"
LOCAL_DASHBOARD_PASSWORD="${GOOSEHERD_LOCAL_DASHBOARD_PASSWORD:-gooseherd-local}"

upsert_env_key() {
  local file="$1"
  local key="$2"
  local value="$3"
  local tmp_file
  tmp_file="$(mktemp)"
  awk -v key="${key}" -v value="${value}" '
    BEGIN { updated = 0 }
    $0 ~ "^" key "=" {
      print key "=" value
      updated = 1
      next
    }
    { print }
    END {
      if (updated == 0) {
        print key "=" value
      }
    }
  ' "${file}" > "${tmp_file}"
  mv "${tmp_file}" "${file}"
}

ensure_encryption_key() {
  local file="$1"
  local existing
  existing="$(awk -F= '$1 == "ENCRYPTION_KEY" { print substr($0, index($0, "=") + 1) }' "${file}" | tail -n 1)"
  if [[ -n "${existing}" ]]; then
    return
  fi

  local generated
  generated="$(node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))')"
  upsert_env_key "${file}" "ENCRYPTION_KEY" "${generated}"
}

if ! minikube status >/dev/null 2>&1; then
  echo "[local-up] starting minikube"
  minikube start --driver=docker
fi

bash "${ROOT_DIR}/scripts/kubernetes/build-app-image.sh" "${APP_IMAGE}"
bash "${ROOT_DIR}/scripts/kubernetes/build-runner-image.sh" "${RUNNER_IMAGE}"

kubectl apply -f "${ROOT_DIR}/kubernetes/local/namespace.yaml"
kubectl apply -f "${ROOT_DIR}/kubernetes/local/postgres.yaml"
kubectl apply -f "${ROOT_DIR}/kubernetes/local/gooseherd-rbac.yaml"
kubectl apply -f "${ROOT_DIR}/kubernetes/local/gooseherd-service.yaml"

kubectl -n "${NAMESPACE}" create configmap gooseherd-config \
  --from-literal=DASHBOARD_HOST=0.0.0.0 \
  --from-literal=DASHBOARD_PORT=8787 \
  --from-literal=WORK_ROOT=/app/.work \
  --from-literal=DATA_DIR=/app/data \
  --from-literal=SANDBOX_RUNTIME=kubernetes \
  --from-literal=KUBERNETES_NAMESPACE="${NAMESPACE}" \
  --from-literal=KUBERNETES_RUNNER_IMAGE="${RUNNER_IMAGE}" \
  --from-literal=KUBERNETES_INTERNAL_BASE_URL="http://gooseherd.${NAMESPACE}.svc.cluster.local:8787" \
  --dry-run=client \
  -o yaml \
  | kubectl apply -f -

TMP_ENV="$(mktemp)"
trap 'rm -f "${TMP_ENV}"' EXIT

if [[ -f "${ENV_FILE}" ]]; then
  cp "${ENV_FILE}" "${TMP_ENV}"
else
  cp "${ROOT_DIR}/.env.example" "${TMP_ENV}"
fi

ensure_encryption_key "${TMP_ENV}"
  upsert_env_key "${TMP_ENV}" "DATABASE_URL" "postgres://gooseherd:gooseherd@postgres.${NAMESPACE}.svc.cluster.local:5432/gooseherd"

kubectl -n "${NAMESPACE}" create secret generic gooseherd-env \
  --from-env-file="${TMP_ENV}" \
  --dry-run=client \
  -o yaml \
  | kubectl apply -f -

kubectl apply -f "${ROOT_DIR}/kubernetes/local/gooseherd-deployment.yaml"
kubectl -n "${NAMESPACE}" set image deployment/gooseherd gooseherd="${APP_IMAGE}"

kubectl -n "${NAMESPACE}" wait --for=condition=available deployment/postgres --timeout=180s
kubectl -n "${NAMESPACE}" wait --for=condition=available deployment/gooseherd --timeout=300s

bootstrap_setup_via_port_forward() {
  local cookie_jar
  local port_forward_log
  local port_forward_pid
  local status_json

  cookie_jar="$(mktemp)"
  port_forward_log="$(mktemp)"

  kubectl -n "${NAMESPACE}" port-forward svc/gooseherd "${LOCAL_DASHBOARD_PORT}:8787" >"${port_forward_log}" 2>&1 &
  port_forward_pid=$!

  cleanup_port_forward() {
    kill "${port_forward_pid}" >/dev/null 2>&1 || true
    wait "${port_forward_pid}" 2>/dev/null || true
    rm -f "${cookie_jar}" "${port_forward_log}"
  }

  for _ in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:${LOCAL_DASHBOARD_PORT}/healthz" >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done

  if ! curl -fsS "http://127.0.0.1:${LOCAL_DASHBOARD_PORT}/healthz" >/dev/null 2>&1; then
    cat "${port_forward_log}" >&2
    cleanup_port_forward
    return 1
  fi

  status_json="$(curl -fsS "http://127.0.0.1:${LOCAL_DASHBOARD_PORT}/api/setup/status")"
  if [[ "${status_json}" != *'"complete":true'* ]]; then
    curl -fsS -c "${cookie_jar}" \
      -X POST "http://127.0.0.1:${LOCAL_DASHBOARD_PORT}/api/setup/password" \
      -H "content-type: application/json" \
      --data "{\"password\":\"${LOCAL_DASHBOARD_PASSWORD}\"}" >/dev/null
    curl -fsS -b "${cookie_jar}" \
      -X POST "http://127.0.0.1:${LOCAL_DASHBOARD_PORT}/api/setup/complete" \
      -H "content-type: application/json" \
      --data '{}' >/dev/null
  fi

  cleanup_port_forward
}

bootstrap_setup_via_port_forward

cat <<EOF
[local-up] minikube deployment is ready
[local-up] namespace: ${NAMESPACE}
[local-up] app image: ${APP_IMAGE}
[local-up] runner image: ${RUNNER_IMAGE}
[local-up] dashboard password: ${LOCAL_DASHBOARD_PASSWORD}
[local-up] open the dashboard with:
kubectl -n ${NAMESPACE} port-forward svc/gooseherd 8787:8787 9090:9090
EOF
