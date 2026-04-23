#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IMAGE_TAG="${1:-gooseherd/app:dev}"
DOCKERFILE_PATH="${KUBERNETES_APP_DOCKERFILE:-${ROOT_DIR}/kubernetes/app.Dockerfile}"
MINIKUBE_PROFILE="${MINIKUBE_PROFILE:-minikube}"
DOCKER_CONFIG="${DOCKER_CONFIG:-/tmp/gooseherd-docker-config}"

mkdir -p "${DOCKER_CONFIG}"
export DOCKER_CONFIG

host_image_id() {
  docker image inspect --format '{{.Id}}' "${IMAGE_TAG}"
}

node_image_id() {
  docker exec "${MINIKUBE_PROFILE}" docker image inspect --format '{{.Id}}' "${IMAGE_TAG}" 2>/dev/null || true
}

# The local host app image consistently completes with the legacy builder,
# while BuildKit occasionally stalls near the export path on this host.
echo "[image] building ${IMAGE_TAG} on the host docker daemon"
DOCKER_BUILDKIT=0 docker build -f "${DOCKERFILE_PATH}" -t "${IMAGE_TAG}" "${ROOT_DIR}"

HOST_IMAGE_ID="$(host_image_id)"
NODE_IMAGE_ID="$(node_image_id)"
if [[ -n "${NODE_IMAGE_ID}" && "${NODE_IMAGE_ID}" == "${HOST_IMAGE_ID}" ]]; then
  echo "[image] ${IMAGE_TAG} already present in ${MINIKUBE_PROFILE}"
else
  echo "[image] streaming ${IMAGE_TAG} into ${MINIKUBE_PROFILE} docker daemon"
  docker save "${IMAGE_TAG}" | docker exec -i "${MINIKUBE_PROFILE}" docker load
fi

printf 'Loaded app image into minikube: %s\n' "${IMAGE_TAG}"
