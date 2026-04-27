#!/usr/bin/env bash
set -euo pipefail

NAMESPACE="gooseherd"

if ! kubectl get namespace "${NAMESPACE}" >/dev/null 2>&1; then
  echo "[local-status] namespace ${NAMESPACE} does not exist"
  exit 0
fi

echo "[local-status] resources in namespace ${NAMESPACE}"
kubectl -n "${NAMESPACE}" get deployments,svc,pods,jobs,secrets,pvc

echo
echo "[local-status] gooseherd logs"
kubectl -n "${NAMESPACE}" logs deployment/gooseherd --tail=40 || true

echo
echo "[local-status] postgres logs"
kubectl -n "${NAMESPACE}" logs deployment/postgres --tail=20 || true
