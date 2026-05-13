#!/bin/bash
# merge-manifest.sh — Merge armv7 image into the multi-arch manifest (latest)
# Run this on the server after build-armv7.sh succeeds
#
# Prerequisites:
#   - docker logged in to GHCR (via PAT with write:packages)
#   - amd64 and arm64 images already pushed by CI (via GitHub Actions)
#   - armv7 image already pushed by build-armv7.sh
#
# Usage:
#   bash scripts/merge-manifest.sh [tag]
#   Default tag: latest

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "${SCRIPT_DIR}"

TAG="${1:-latest}"
REGISTRY="ghcr.io"
IMAGE_NAME="wttwins/wrong-notebook"
FULL_IMAGE="${REGISTRY}/${IMAGE_NAME}"

echo "=== Merging multi-arch manifest: ${FULL_IMAGE}:${TAG} ==="
echo ""

# Check all three arch images exist
echo "→ Checking arch images exist..."
for arch in amd64 arm64 armv7; do
  if docker manifest inspect "${FULL_IMAGE}:${TAG}-${arch}" > /dev/null 2>&1; then
    echo "  ✅ ${TAG}-${arch}"
  else
    echo "  ❌ ${TAG}-${arch} not found!"
    echo ""
    echo "All three arch images must exist before merging."
    echo "Make sure CI has pushed amd64/arm64 and build-armv7.sh has pushed armv7."
    exit 1
  fi
done

echo ""
echo "→ Creating multi-arch manifest..."
docker manifest create \
  "${FULL_IMAGE}:${TAG}" \
  --amend "${FULL_IMAGE}:${TAG}-amd64" \
  --amend "${FULL_IMAGE}:${TAG}-arm64" \
  --amend "${FULL_IMAGE}:${TAG}-armv7"

echo "→ Pushing manifest..."
docker manifest push "${FULL_IMAGE}:${TAG}"

echo ""
echo "=== Done: ${FULL_IMAGE}:${TAG} (amd64 + arm64 + armv7) ==="
echo ""
echo "Deploy with: image: ${FULL_IMAGE}:${TAG}"
echo "Docker will automatically pull the correct arch."
