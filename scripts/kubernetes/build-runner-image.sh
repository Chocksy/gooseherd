#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IMAGE_TAG="${1:-gooseherd/k8s-runner:dev}"
MINIKUBE_PROFILE="${MINIKUBE_PROFILE:-minikube}"
MINIKUBE_BUILD_IN_NODE="${MINIKUBE_BUILD_IN_NODE:-0}"
DOCKER_CONFIG="${DOCKER_CONFIG:-/tmp/gooseherd-docker-config}"

mkdir -p "${DOCKER_CONFIG}"
export DOCKER_CONFIG

host_image_id() {
  docker image inspect --format '{{.Id}}' "${IMAGE_TAG}"
}

node_image_id() {
  docker exec "${MINIKUBE_PROFILE}" docker image inspect --format '{{.Id}}' "${IMAGE_TAG}" 2>/dev/null || true
}

if [[ "${MINIKUBE_BUILD_IN_NODE}" == "1" ]]; then
  echo "[image] building ${IMAGE_TAG} on the host docker daemon"
  docker build -f "${ROOT_DIR}/kubernetes/runner.Dockerfile" -t "${IMAGE_TAG}" "${ROOT_DIR}"

  HOST_IMAGE_ID="$(host_image_id)"
  NODE_IMAGE_ID="$(node_image_id)"
  if [[ -n "${NODE_IMAGE_ID}" && "${NODE_IMAGE_ID}" == "${HOST_IMAGE_ID}" ]]; then
    echo "[image] ${IMAGE_TAG} already present in ${MINIKUBE_PROFILE}"
  else
    echo "[image] streaming ${IMAGE_TAG} into ${MINIKUBE_PROFILE} docker daemon"
    docker save "${IMAGE_TAG}" | docker exec -i "${MINIKUBE_PROFILE}" docker load
  fi
else
  docker build -f "${ROOT_DIR}/kubernetes/runner.Dockerfile" -t "${IMAGE_TAG}" "${ROOT_DIR}"
  minikube image load "${IMAGE_TAG}"
fi

printf 'Loaded runner image into minikube: %s\n' "${IMAGE_TAG}"
