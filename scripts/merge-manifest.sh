#!/bin/bash
# merge-manifest.sh — Merge armv7 image into the multi-arch manifest (latest)
#
# Prerequisites:
#   - docker logged in to GHCR (via PAT with write:packages)
#   - amd64 and arm64 already in the latest manifest (pushed by CI)
#   - armv7 image pushed by build-armv7.sh (as latest-armv7)
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

# Step 1: Verify armv7 image exists
echo "→ Checking armv7 image..."
if ! docker manifest inspect "${FULL_IMAGE}:${TAG}-armv7" > /dev/null 2>&1; then
  echo "  ❌ ${TAG}-armv7 not found! Run build-armv7.sh first."
  exit 1
fi
echo "  ✅ ${TAG}-armv7"

# Step 2: Get existing manifest digests for amd64/arm64
echo ""
echo "→ Reading existing ${TAG} manifest for amd64/arm64 digests..."
MANIFEST_JSON=$(docker manifest inspect "${FULL_IMAGE}:${TAG}" 2>/dev/null) || {
  echo "  ❌ ${TAG} manifest not found! Make sure CI has pushed amd64/arm64 first."
  exit 1
}

AMD64_DIGEST=$(echo "$MANIFEST_JSON" | python3 -c "
import json,sys
d=json.load(sys.stdin)
for m in d.get('manifests',[]):
    if m.get('platform',{}).get('architecture')=='amd64':
        print(m['digest']); break
" 2>/dev/null)

ARM64_DIGEST=$(echo "$MANIFEST_JSON" | python3 -c "
import json,sys
d=json.load(sys.stdin)
for m in d.get('manifests',[]):
    if m.get('platform',{}).get('architecture')=='arm64':
        print(m['digest']); break
" 2>/dev/null)

if [ -z "$AMD64_DIGEST" ] || [ -z "$ARM64_DIGEST" ]; then
  echo "  ❌ Could not find amd64 and/or arm64 in ${TAG} manifest"
  echo "  Manifest content:"
  echo "$MANIFEST_JSON"
  exit 1
fi

echo "  ✅ amd64: ${AMD64_DIGEST:0:20}..."
echo "  ✅ arm64: ${ARM64_DIGEST:0:20}..."

# Step 3: Delete old manifest (so we can recreate with same tag)
echo ""
echo "→ Removing old manifest..."
docker manifest rm "${FULL_IMAGE}:${TAG}" 2>/dev/null || true

# Step 4: Recreate manifest with all 3 archs
echo ""
echo "→ Creating new multi-arch manifest (amd64 + arm64 + armv7)..."
docker manifest create \
  "${FULL_IMAGE}:${TAG}" \
  --amend "${FULL_IMAGE}@${AMD64_DIGEST}" \
  --amend "${FULL_IMAGE}@${ARM64_DIGEST}" \
  --amend "${FULL_IMAGE}:${TAG}-armv7"

echo "→ Pushing manifest..."
docker manifest push "${FULL_IMAGE}:${TAG}"

echo ""
echo "=== Done: ${FULL_IMAGE}:${TAG} (amd64 + arm64 + armv7) ==="
echo ""
echo "Deploy with: image: ${FULL_IMAGE}:${TAG}"
echo "Docker will automatically pull the correct arch."
