FROM node:22-alpine AS base

# Install dependencies only when needed
FROM base AS deps
# Check https://github.com/nodejs/docker-node/tree/b4117f9333da4138b03a546ec926ef50a31506c3#nodealpine to understand why libc6-compat might be needed.
RUN apk add --no-cache libc6-compat
WORKDIR /app

# Install dependencies based on the preferred package manager
COPY package.json package-lock.json ./
# Skip Prisma engine download during npm ci (engines are copied manually for arm/v7)
ARG TARGETPLATFORM
RUN if [ "${TARGETPLATFORM}" = "linux/arm/v7" ]; then \
      PRISMA_SKIP_POSTINSTALL_GENERATE=1 npm ci ;\
    else \
      npm ci ;\
    fi

# Rebuild the source code only when needed
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Install OpenSSL for Prisma
RUN apk add --no-cache openssl

# Copy pre-compiled armv7 engines (downloaded by CI before build)
# For amd64/arm64 this directory doesn't exist in build context
ARG TARGETPLATFORM
RUN if [ "${TARGETPLATFORM}" = "linux/arm/v7" ] && [ -d /app/engines/armv7 ]; then \
      mkdir -p /app/node_modules/@prisma/engines ;\
      cp /app/engines/armv7/libquery_engine-linux-arm-openssl-3.0.x.so.node /app/node_modules/@prisma/engines/ ;\
      cp /app/engines/armv7/schema-engine-linux-arm /app/node_modules/@prisma/engines/schema-engine-linux-arm-openssl-3.0.x ;\
      cp /app/engines/armv7/query-engine-linux-arm /app/node_modules/@prisma/engines/query-engine-linux-arm-openssl-3.0.x ;\
      cp /app/engines/armv7/prisma-fmt-linux-arm /app/node_modules/@prisma/engines/prisma-fmt-linux-arm-openssl-3.0.x ;\
    fi

# Temporarily remove linux-arm-openssl-3.0.x from binaryTargets for all platforms
# to avoid 404 errors during prisma generate
RUN sed -i 's/ "linux-arm-openssl-3.0.x"//' prisma/schema.prisma
RUN sed -i 's/, *]/]/' prisma/schema.prisma
RUN sed -i 's/,,/,/' prisma/schema.prisma

# Generate Prisma Client FIRST (needed for tsc and everything after)
ENV DATABASE_URL="file:/app/prisma/dev.db"

# For armv7: engines are already in @prisma/engines/ (copied above).
# PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING=1 makes Prisma skip download when
# .sha256 checksum file is missing (which it is for our pre-compiled engines).
RUN if [ "${TARGETPLATFORM}" = "linux/arm/v7" ]; then \
      PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING=1 \
      PRISMA_CLI_BINARY_TARGETS="native" \
      npx prisma generate ;\
    else \
      npx prisma generate ;\
    fi

# Migrate and seed
RUN npx prisma migrate deploy && npx prisma db seed

# Pre-compile runtime scripts (needs PrismaClient from generate above)
RUN npx tsc scripts/rebuild-system-tags.ts --outDir dist-scripts --esModuleInterop --resolveJsonModule --skipLibCheck --module commonjs --target ES2020

# Run seed script that depends on compiled tsc output
RUN node ./dist-scripts/scripts/rebuild-system-tags.js

# For armv7 builds: restore arm binaryTarget in schema
RUN if [ "${TARGETPLATFORM}" = "linux/arm/v7" ]; then \
      sed -i 's/"linux-musl-openssl-3.0.x"/"linux-musl-openssl-3.0.x", "linux-arm-openssl-3.0.x"/' prisma/schema.prisma ;\
    fi

# Next.js collects completely anonymous telemetry data about general usage.
# Learn more here: https://nextjs.org/telemetry
# Uncomment the following line in case you want to disable telemetry during the build.
ENV NEXT_TELEMETRY_DISABLED=1

RUN npm run build

# Production image, copy all the files and run next
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
# Uncomment the following line in case you want to disable telemetry during runtime.
ENV NEXT_TELEMETRY_DISABLED=1

# Install dependencies and create user
RUN apk add --no-cache su-exec openssl \
    && addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 nextjs

# Copy Prisma CLI and engine files from builder
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/prisma ./node_modules/prisma
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/@prisma ./node_modules/@prisma

COPY --from=builder /app/public ./public

# Automatically leverage output traces to reduce image size
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# Copy Prisma schema and migrations for runtime usage if needed (e.g. for migrations)
COPY --from=builder --chown=nextjs:nodejs /app/prisma ./prisma

# Copy config directory for runtime
COPY --from=builder --chown=nextjs:nodejs /app/config ./config

# Copy pre-compiled runtime scripts
COPY --from=builder --chown=nextjs:nodejs /app/dist-scripts ./dist-scripts

# Create data directory for SQLite persistence
RUN mkdir -p /app/data && chown -R nextjs:nodejs /app/data

# Copy entrypoint script
COPY --chown=nextjs:nodejs --chmod=755 docker-entrypoint.sh ./
COPY --chown=nextjs:nodejs https-server.js ./

EXPOSE 3000

ENV PORT=3000
# set hostname to localhost
ENV HOSTNAME="0.0.0.0"

# Environment variables
# Point to the persistent data location
ENV DATABASE_URL="file:/app/data/dev.db"
ENV AUTH_TRUST_HOST=true

# Ignore checksum errors for armv7 engines (third-party compiled)
ENV PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING=1

# Use entrypoint script to handle DB initialization
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "server.js"]
