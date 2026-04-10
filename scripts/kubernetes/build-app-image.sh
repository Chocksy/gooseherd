#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IMAGE_TAG="${1:-gooseherd/app:dev}"
DOCKERFILE_PATH="${KUBERNETES_APP_DOCKERFILE:-${ROOT_DIR}/kubernetes/app.Dockerfile}"
MINIKUBE_PROFILE="${MINIKUBE_PROFILE:-minikube}"
MINIKUBE_BUILD_IN_NODE="${MINIKUBE_BUILD_IN_NODE:-0}"
DOCKER_CONFIG="${DOCKER_CONFIG:-/tmp/gooseherd-docker-config}"

mkdir -p "${DOCKER_CONFIG}"
export DOCKER_CONFIG

if [[ "${MINIKUBE_BUILD_IN_NODE}" == "1" ]]; then
  echo "[image] building ${IMAGE_TAG} directly in ${MINIKUBE_PROFILE} docker daemon"
  eval "$(minikube -p "${MINIKUBE_PROFILE}" docker-env)"
  # The local minikube app image consistently completes with the legacy builder,
  # while BuildKit occasionally stalls near the export path on this host.
  DOCKER_BUILDKIT=0 docker build -f "${DOCKERFILE_PATH}" -t "${IMAGE_TAG}" "${ROOT_DIR}"
else
  # The local host app image consistently completes with the legacy builder,
  # while BuildKit occasionally stalls near the export path on this host.
  DOCKER_BUILDKIT=0 docker build -f "${DOCKERFILE_PATH}" -t "${IMAGE_TAG}" "${ROOT_DIR}"
  minikube image load "${IMAGE_TAG}"
fi

printf 'Loaded app image into minikube: %s\n' "${IMAGE_TAG}"
