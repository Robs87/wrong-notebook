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

# Download Prisma engines for all target architectures
ARG TARGETPLATFORM
RUN case "${TARGETPLATFORM}" in \
    "linux/amd64") echo "Building for amd64" ;; \
    "linux/arm64") echo "Building for arm64" ;; \
    "linux/arm/v7") \
        echo "Building for arm/v7 - downloading pre-compiled engines" ;\
        mkdir -p /app/engines/armv7 ;\
        curl -L -o /app/engines/armv7/libquery_engine-linux-arm-openssl-3.0.x.so.node "https://github.com/idootop/armv7-prisma-engine/releases/download/5.14.0/libquery_engine.so.node" ;\
        curl -L -o /app/engines/armv7/schema-engine-linux-arm "https://github.com/idootop/armv7-prisma-engine/releases/download/5.14.0/schema-engine" ;\
        curl -L -o /app/engines/armv7/query-engine-linux-arm "https://github.com/idootop/armv7-prisma-engine/releases/download/5.14.0/query-engine" ;\
        curl -L -o /app/engines/armv7/prisma-fmt-linux-arm "https://github.com/idootop/armv7-prisma-engine/releases/download/5.14.0/prisma-fmt" ;\
        ;; \
    *) echo "Building for unknown platform: ${TARGETPLATFORM}" ;; \
    esac

# Temporarily remove linux-arm-openssl-3.0.x from binaryTargets for all platforms
# to avoid 404 errors during multi-arch builds. For amd64/arm64 this target is
# unused. For armv7 we handle it separately below.
# Step 1: remove the arm target (with leading space)
# Step 2: clean up trailing comma before ]
# Step 3: clean up double commas
RUN sed -i 's/ "linux-arm-openssl-3.0.x"//' prisma/schema.prisma
RUN sed -i 's/, *]/]/' prisma/schema.prisma
RUN sed -i 's/,,/,/' prisma/schema.prisma

# For armv7 builds: copy pre-compiled engines BEFORE prisma generate
# so Prisma can find the native engine at the expected location
RUN if [ "${TARGETPLATFORM}" = "linux/arm/v7" ]; then \
      mkdir -p /app/node_modules/.prisma/client ;\
      cp /app/engines/armv7/libquery_engine-linux-arm-openssl-3.0.x.so.node /app/node_modules/.prisma/client/ ;\
      cp /app/engines/armv7/schema-engine-linux-arm /app/node_modules/.prisma/client/ ;\
    fi

# Generate Prisma Client and Seed Database
# We temporarily set DATABASE_URL to a local file for the build process to generate the file
ENV DATABASE_URL="file:/app/prisma/dev.db"

# Pre-compile runtime scripts FIRST (needed for tag seeding)
RUN npx tsc scripts/rebuild-system-tags.ts --outDir dist-scripts --esModuleInterop --resolveJsonModule --skipLibCheck --module commonjs --target ES2020

# Initialize database: generate client, run migrations, seed admin user, seed system tags
# PRISMA_CLI_BINARY_TARGETS="" prevents Prisma from downloading any engines.
# For amd64/arm64, engines are downloaded during npm ci (postinstall).
# For armv7, we manually copy pre-compiled engines before this step.
# PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING: skip checksum validation for third-party engines
RUN PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING=1 \
    PRISMA_CLI_BINARY_TARGETS="" \
    npx prisma generate \
    && npx prisma migrate deploy \
    && npx prisma db seed \
    && node ./dist-scripts/scripts/rebuild-system-tags.js

# For armv7 builds: restore arm binaryTarget in schema and ensure engine files are in place
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
