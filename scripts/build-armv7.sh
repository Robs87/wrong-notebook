#!/bin/bash
# build-armv7.sh — Build armv7 Docker image on Oracle Cloud ARM server
#
# Strategy:
# 1. Temporarily remove linux-arm-openssl-3.0.x from schema (not available on Prisma CDN)
# 2. Build JS output natively on arm64 (fast)
# 3. Restore schema with linux-arm-openssl-3.0.x
# 4. docker buildx + QEMU: copies pre-built .next + armv7 engines, skips next build
#
# Usage: ./build-armv7.sh [tag]

set -euo pipefail

TAG="${1:-latest}"
IMAGE="ghcr.io/wttwins/wrong-notebook:${TAG}-armv7"
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENGINES_DIR="${SCRIPT_DIR}/engines/armv7"

export PATH="${SCRIPT_DIR}/node_modules/.bin:${PATH}"

echo "=== Building armv7 Docker image: ${IMAGE} ==="

# Step 1: Download pre-compiled armv7 Prisma engines
echo "→ Checking armv7 Prisma engines..."
mkdir -p "${ENGINES_DIR}"
for engine in libquery_engine schema-engine query-engine prisma-fmt; do
  file="${ENGINES_DIR}/${engine}-linux-arm-openssl-3.0.x"
  [ "$engine" = "libquery_engine" ] && file="${ENGINES_DIR}/libquery_engine-linux-arm-openssl-3.0.x.so.node"
  [ "$engine" = "schema-engine" ] && file="${ENGINES_DIR}/schema-engine-linux-arm-openssl-3.0.x"
  url="https://github.com/idootop/armv7-prisma-engine/releases/download/5.14.0/${engine}"
  if [ ! -f "${file}" ]; then
    echo "  Downloading ${engine}..."
    curl -L -o "${file}" "${url}"
  else
    echo "  ${engine} already exists"
  fi
done

# Step 2: Build JS output natively
echo "→ Building Next.js output natively..."
cd "${SCRIPT_DIR}"

if [ ! -d node_modules ]; then
  echo "  Running npm ci..."
  npm ci
fi

# Temporarily remove arm binaryTarget from schema so prisma generate doesn't try to download it
echo "  Preparing schema (removing arm binaryTarget)..."
cp prisma/schema.prisma prisma/schema.prisma.bak
sed -i 's/ "linux-arm-openssl-3.0.x"//' prisma/schema.prisma
sed -i 's/, *]/]/' prisma/schema.prisma
sed -i 's/,,/,/' prisma/schema.prisma

echo "  Generating Prisma client..."
prisma generate

echo "  Compiling scripts..."
tsc scripts/rebuild-system-tags.ts --outDir dist-scripts --esModuleInterop --resolveJsonModule --skipLibCheck --module commonjs --target ES2020

echo "  Running next build..."
NEXT_TELEMETRY_DISABLED=1 NODE_OPTIONS="--max-old-space-size=4096" npm run build

# Restore schema
echo "  Restoring schema..."
mv prisma/schema.prisma.bak prisma/schema.prisma

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

# Step 4: Build armv7 Docker image
echo "→ Building armv7 Docker image (QEMU, pre-built JS, armv7 engines)..."
docker buildx build \
  --platform linux/arm/v7 \
  --tag "${IMAGE}" \
  --push \
  --file Dockerfile.armv7 \
  .

echo ""
echo "=== Done: ${IMAGE} ==="
echo ""

# Step 5: Merge into multi-arch manifest
echo "→ Merging into multi-arch manifest..."
if bash scripts/merge-manifest.sh "${TAG}" 2>&1; then
  echo ""
  echo "=== All done: ${REGISTRY}/${IMAGE_NAME}:${TAG} (amd64 + arm64 + armv7) ==="
else
  echo ""
  echo "⚠️  Merge skipped (CI images may not be ready yet)."
  echo "    Run manually later: bash scripts/merge-manifest.sh ${TAG}"
fi
