# Multi-arch Dockerfile for wrong-notebook
#
# Build strategy by architecture:
# - amd64 (CI): native build, full pipeline
# - arm64 (CI, GitHub arm64 runner): native build, full pipeline
# - armv7 (server, QEMU): skip `npm run build` (too slow), copy from pre-built context
#
# For armv7 builds, the build context must include pre-built .next/ output.
# Use scripts/build-armv7.sh which handles this automatically.

FROM node:22-alpine AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS jsbuilder
ARG TARGETPLATFORM
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN apk add --no-cache openssl

ENV DATABASE_URL="file:/app/prisma/dev.db"
RUN npx prisma generate
RUN npx tsc scripts/rebuild-system-tags.ts --outDir dist-scripts --esModuleInterop --resolveJsonModule --skipLibCheck --module commonjs --target ES2020

ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_OPTIONS="--max-old-space-size=4096"

# For armv7: skip npm run build (too slow under QEMU)
# Instead, copy pre-built .next from build context (placed there by build script)
# For amd64/arm64: build normally
RUN if [ "${TARGETPLATFORM}" = "linux/arm/v7" ]; then \
      echo "armv7: copying pre-built .next from context"; \
      cp -r /app/.next-prebuilt .next 2>/dev/null || \
        (echo "ERROR: .next-prebuilt not found. Run scripts/build-armv7.sh instead of docker build directly." && exit 1); \
    else \
      echo "Building Next.js (native arch)..."; \
      npm run build; \
    fi

FROM node:22-alpine AS runner
ARG TARGETPLATFORM
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN apk add --no-cache su-exec openssl \
    && addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 nextjs

COPY --from=jsbuilder --chown=nextjs:nodejs /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=jsbuilder --chown=nextjs:nodejs /app/node_modules/prisma ./node_modules/prisma
COPY --from=jsbuilder --chown=nextjs:nodejs /app/node_modules/@prisma/client ./node_modules/@prisma/client
COPY --from=jsbuilder --chown=nextjs:nodejs /app/prisma ./prisma
COPY --from=jsbuilder /app/public ./public
COPY --from=jsbuilder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=jsbuilder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=jsbuilder --chown=nextjs:nodejs /app/config ./config
COPY --from=jsbuilder --chown=nextjs:nodejs /app/dist-scripts ./dist-scripts
COPY --from=jsbuilder --chown=nextjs:nodejs /app/node_modules ./node_modules

# For armv7: copy Prisma engines from build context
RUN if [ "${TARGETPLATFORM}" = "linux/arm/v7" ] && [ -d /app/engines/armv7 ]; then \
      mkdir -p /app/node_modules/@prisma/engines ;\
      cp /app/engines/armv7/libquery_engine-linux-arm-openssl-3.0.x.so.node /app/node_modules/@prisma/engines/ ;\
      cp /app/engines/armv7/schema-engine-linux-arm /app/node_modules/@prisma/engines/schema-engine-linux-arm-openssl-3.0.x ;\
      cp /app/engines/armv7/query-engine-linux-arm /app/node_modules/@prisma/engines/query-engine-linux-arm-openssl-3.0.x ;\
      cp /app/engines/armv7/prisma-fmt-linux-arm /app/node_modules/@prisma/engines/prisma-fmt-linux-arm-openssl-3.0.x ;\
    fi

RUN mkdir -p /app/data && chown -R nextjs:nodejs /app/data

COPY --chown=nextjs:nodejs --chmod=755 docker-entrypoint.sh ./
COPY --chown=nextjs:nodejs https-server.js ./

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
ENV DATABASE_URL="file:/app/data/dev.db"
ENV AUTH_TRUST_HOST=true
ENV PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING=1

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "server.js"]
