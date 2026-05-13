#!/bin/bash
# build-armv7.sh — Build armv7 Docker image on Oracle Cloud ARM server
#
# Strategy:
# 1. Build JS output (next build) natively on arm64 — fast
# 2. Place pre-built output in .next-prebuilt/
# 3. Use docker buildx + QEMU to build armv7 image
#    Dockerfile copies .next-prebuilt/ instead of running next build under QEMU
# 4. Only native module compilation (better-sqlite3) runs under QEMU — much faster
#
# Prerequisites:
#   - docker, docker buildx, qemu-user-static
#   - docker login ghcr.io -u <username>
#   - npm ci already done (or will be done by Dockerfile)
#
# Usage:
#   ./build-armv7.sh [tag]
#   Default tag: latest

set -euo pipefail

TAG="${1:-latest}"
IMAGE="ghcr.io/wttwins/wrong-notebook:${TAG}-armv7"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENGINES_DIR="${SCRIPT_DIR}/engines/armv7"

echo "=== Building armv7 Docker image: ${IMAGE} ==="

# Step 1: Download pre-compiled armv7 Prisma engines
echo "→ Checking armv7 Prisma engines..."
mkdir -p "${ENGINES_DIR}"

maybe_download() {
  local url="$1" file="$2"
  if [ ! -f "${file}" ]; then
    echo "  Downloading $(basename ${file})..."
    curl -L -o "${file}" "${url}"
  else
    echo "  $(basename ${file}) already exists"
  fi
}

maybe_download "https://github.com/idootop/armv7-prisma-engine/releases/download/5.14.0/libquery_engine.so.node" \
  "${ENGINES_DIR}/libquery_engine-linux-arm-openssl-3.0.x.so.node"
maybe_download "https://github.com/idootop/armv7-prisma-engine/releases/download/5.14.0/schema-engine" \
  "${ENGINES_DIR}/schema-engine-linux-arm-openssl-3.0.x"
maybe_download "https://github.com/idootop/armv7-prisma-engine/releases/download/5.14.0/query-engine" \
  "${ENGINES_DIR}/query-engine-linux-arm-openssl-3.0.x"
maybe_download "https://github.com/idootop/armv7-prisma-engine/releases/download/5.14.0/prisma-fmt" \
  "${ENGINES_DIR}/prisma-fmt-linux-arm-openssl-3.0.x"

# Step 2: Build JS output natively (on arm64, this is fast)
echo "→ Building Next.js output natively..."
cd "${SCRIPT_DIR}"

# Ensure dependencies are installed
if [ ! -d node_modules ]; then
  echo "  Running npm ci..."
  npm ci
fi

# Generate Prisma client
echo "  Generating Prisma client..."
npx prisma generate

# Compile rebuild-system-tags.ts
echo "  Compiling scripts..."
npx tsc scripts/rebuild-system-tags.ts --outDir dist-scripts --esModuleInterop --resolveJsonModule --skipLibCheck --module commonjs --target ES2020

# Build Next.js
echo "  Running next build..."
NEXT_TELEMETRY_DISABLED=1 NODE_OPTIONS="--max-old-space-size=4096" npm run build

# Copy build output to .next-prebuilt for Dockerfile to use
echo "  Copying build output to .next-prebuilt/..."
rm -rf .next-prebuilt
cp -r .next .next-prebuilt

# Step 3: Verify QEMU
echo "→ Verifying QEMU armv7 emulation..."
if ! docker run --rm --platform linux/arm/v7 arm32v7/alpine uname -m 2>/dev/null | grep -q "armv7l"; then
  echo "ERROR: QEMU armv7 emulation not working."
  echo "  Install: docker run --rm --privileged multiarch/qemu-user-static --reset -p yes"
  exit 1
fi
echo "  QEMU OK"

# Step 4: Build armv7 Docker image using buildx
echo "→ Building armv7 Docker image (QEMU, but no next build needed)..."
docker buildx build \
  --platform linux/arm/v7 \
  --tag "${IMAGE}" \
  --push \
  --file Dockerfile \
  .

echo ""
echo "=== Done: ${IMAGE} ==="
echo ""
echo "To add to multi-arch manifest, run:"
echo "  docker manifest create ghcr.io/wttwins/wrong-notebook:${TAG} \\"
echo "    --amend ghcr.io/wttwins/wrong-notebook:${TAG}-amd64 \\"
echo "    --amend ghcr.io/wttwins/wrong-notebook:${TAG}-arm64 \\"
echo "    --amend ghcr.io/wttwins/wrong-notebook:${TAG}-armv7"
echo "  docker manifest push ghcr.io/wttwins/wrong-notebook:${TAG}"
