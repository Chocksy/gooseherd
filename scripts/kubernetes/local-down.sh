#!/usr/bin/env bash
set -euo pipefail

NAMESPACE="gooseherd"

kubectl delete namespace "${NAMESPACE}" --ignore-not-found=true --wait=true
echo "[local-down] deleted namespace ${NAMESPACE}"
