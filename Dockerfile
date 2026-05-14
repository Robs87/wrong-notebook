# Dockerfile — multi-arch Docker build (amd64, arm64, armv7)
#
# For armv7 builds under QEMU:
#   - JS output (.next, dist-scripts) is pre-built on amd64 and copied into context
#   - npm ci runs with --ignore-scripts to skip native module compilation
#   - better-sqlite3 armv7 pre-compiled binary is downloaded and placed correctly
#   - Prisma engines for armv7 are copied from engines/armv7/ in build context
#   - Only prisma generate runs under QEMU (fast)

FROM node:22-alpine AS deps
RUN apk add --no-cache libc6-compat curl
WORKDIR /app
COPY package.json package-lock.json ./
ARG SKIP_BUILD=
RUN if [ -z "$SKIP_BUILD" ]; then \
      npm ci; \
    else \
      npm ci --ignore-scripts; \
    fi

FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN apk add --no-cache openssl

ARG SKIP_BUILD=
ENV DATABASE_URL="file:/app/prisma/dev.db"

# For armv7: install pre-compiled native modules, skip JS compilation
RUN if [ -n "$SKIP_BUILD" ]; then \
      echo "=== armv7: installing pre-compiled native modules ===" && \
      # Install armv7 better-sqlite3 pre-compiled binary \
      mkdir -p node_modules/better-sqlite3/prebuilds/linux-arm && \
      curl -L -o /tmp/better-sqlite3-armv7.tar.gz \
        "https://github.com/WiseLibs/better-sqlite3/releases/download/v12.10.0/better-sqlite3-v12.10.0-node-v127-linux-arm.tar.gz" && \
      tar xzf /tmp/better-sqlite3-armv7.tar.gz -C node_modules/better-sqlite3/prebuilds/linux-arm && \
      rm /tmp/better-sqlite3-armv7.tar.gz && \
      # Copy armv7 Prisma engines \
      mkdir -p node_modules/@prisma/engines && \
      cp engines/armv7/libquery_engine-linux-arm-openssl-3.0.x.so.node node_modules/@prisma/engines/ && \
      cp engines/armv7/schema-engine-linux-arm-openssl-3.0.x node_modules/@prisma/engines/ && \
      cp engines/armv7/query-engine-linux-arm-openssl-3.0.x node_modules/@prisma/engines/ && \
      cp engines/armv7/prisma-fmt-linux-arm-openssl-3.0.x node_modules/@prisma/engines/ && \
      # Generate Prisma client using local engines \
      PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING=1 \
      PRISMA_QUERY_ENGINE_LIBRARY=/app/node_modules/@prisma/engines/libquery_engine-linux-arm-openssl-3.0.x.so.node \
      PRISMA_SCHEMA_ENGINE_BINARY=/app/node_modules/@prisma/engines/schema-engine-linux-arm-openssl-3.0.x \
      npx prisma generate && \
      echo "=== armv7 native modules ready ==="; \
    else \
      echo "=== Building from source ===" && \
      npx prisma generate && \
      npx tsc scripts/rebuild-system-tags.ts --outDir dist-scripts --esModuleInterop --resolveJsonModule --skipLibCheck --module commonjs --target ES2020 && \
      NEXT_TELEMETRY_DISABLED=1 NODE_OPTIONS="--max-old-space-size=4096" npm run build; \
    fi

FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING=1

RUN apk add --no-cache su-exec openssl \
    && addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 nextjs

COPY --from=builder --chown=nextjs:nodejs /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/prisma ./node_modules/prisma
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/@prisma/client ./node_modules/@prisma/client
COPY --from=builder --chown=nextjs:nodejs /app/prisma ./prisma
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/config ./config
COPY --from=builder --chown=nextjs:nodejs /app/dist-scripts ./dist-scripts
COPY --from=builder --chown=nextjs:nodejs /app/node_modules ./node_modules

RUN mkdir -p /app/data && chown -R nextjs:nodejs /app/data

COPY --chown=nextjs:nodejs --chmod=755 docker-entrypoint.sh ./
COPY --chown=nextjs:nodejs https-server.js ./

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
ENV DATABASE_URL="file:/app/data/dev.db"
ENV AUTH_TRUST_HOST=true

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "server.js"]
