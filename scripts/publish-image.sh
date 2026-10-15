#!/usr/bin/env bash
# Build the app image locally and push to Docker Hub.
# Usage:
#   ./scripts/publish-image.sh              # tags :latest
#   ./scripts/publish-image.sh 1.0.0        # tags :1.0.0 and :latest
#   AI_WORKER_IMAGE=myuser/ai-worker ./scripts/publish-image.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

IMAGE="${AI_WORKER_IMAGE:-sami1367/ai-worker}"
# Strip tag if caller passed image:tag as AI_WORKER_IMAGE
IMAGE="${IMAGE%%:*}"
VERSION="${1:-latest}"
# Bake a real semver into the image even when tagging :latest
APP_VERSION="${1:-$(node -p "require('./package.json').version")}"

echo "Building ${IMAGE}:${VERSION} (APP_VERSION=${APP_VERSION}; also :latest if version != latest)"
docker build --build-arg "APP_VERSION=${APP_VERSION}" -t "${IMAGE}:${VERSION}" .

if [[ "$VERSION" != "latest" ]]; then
  docker tag "${IMAGE}:${VERSION}" "${IMAGE}:latest"
fi

echo "Pushing ${IMAGE}:${VERSION}"
docker push "${IMAGE}:${VERSION}"
if [[ "$VERSION" != "latest" ]]; then
  docker push "${IMAGE}:latest"
fi

echo "Done. Others can run with docker-compose.yml:"
echo "  docker compose pull && docker compose up -d"
