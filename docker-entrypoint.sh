#!/bin/sh
set -e

# Define paths
SOURCE_DB="/app/prisma/dev.db"
TARGET_DB="/app/data/dev.db"
SEED_MARKER="/app/data/.seed_completed"
VERSION_FILE="/app/data/.app_version"
# Use local Prisma CLI from node_modules
PRISMA_BIN="node /app/node_modules/prisma/build/index.js"
SEED_ADMIN_SCRIPT="/app/dist-scripts/scripts/seed-admin.js"
REBUILD_TAGS_SCRIPT="/app/dist-scripts/scripts/rebuild-system-tags.js"
SYNC_YIJIAN_SCRIPT="/app/dist-scripts/scripts/sync-yijian-prompts.js"

# Get current app version from package.json
CURRENT_VERSION=$(node -p "require('./package.json').version" 2>/dev/null || echo "unknown")

# ─────────────────────────────────────────────────────────────
# 前置校验：NEXTAUTH_SECRET
# 生产镜像（NODE_ENV=production）运行时缺/弱 NEXTAUTH_SECRET，
# src/lib/auth.ts 的 assertSecretStrength() 会在 import 阶段直接 throw，
# 表现为「站点 500 / 登录页打不开 / 容器反复重启」，报错淹没在日志里。
# 在这里提前拦截，给出清晰的中文指引，避免用户排查半天才发现少配环境变量。
# build 阶段（NEXT_PHASE=phase-production-build）auth.ts 本就跳过校验，
# 这里也跳过，保持一致。
# ─────────────────────────────────────────────────────────────
if [ "$NEXT_PHASE" != "phase-production-build" ]; then
    SECRET="${NEXTAUTH_SECRET:-}"
    if [ -z "$SECRET" ]; then
        echo ""
        echo "============================================================"
        echo " ❌ 启动失败：缺少 NEXTAUTH_SECRET 环境变量"
        echo "------------------------------------------------------------"
        echo " 本镜像运行在生产模式，必须配置一个高强度密钥用于签发登录"
        echo " session，否则任何人都能离线伪造登录态（含管理员）。"
        echo ""
        echo " 解决方法（任选其一）："
        echo "   1) Unraid：容器编辑 → Add Variable"
        echo "        Name:  NEXTAUTH_SECRET"
        echo "        Value: openssl rand -base64 32 生成的字符串"
        echo "   2) docker run：  -e NEXTAUTH_SECRET=\$(openssl rand -base64 32)"
        echo "   3) docker-compose.yml： environment: 增加 NEXTAUTH_SECRET"
        echo ""
        echo " 生成密钥命令："
        echo "   openssl rand -base64 32"
        echo "============================================================"
        echo ""
        exit 1
    fi
    # 与 src/lib/auth.ts 的 weakValues / 长度门槛保持一致
    case "$SECRET" in
        supersecret-dev-secret|changeme|secret|your-secret-key)
            echo "❌ NEXTAUTH_SECRET 是已知占位符（$SECRET），请用 openssl rand -base64 32 重新生成。" >&2
            exit 1
            ;;
    esac
    SECRET_LEN=${#SECRET}
    if [ "$SECRET_LEN" -lt 16 ]; then
        echo "❌ NEXTAUTH_SECRET 太短（$SECRET_LEN 字符，至少 16）。请用 openssl rand -base64 32 重新生成。" >&2
        exit 1
    fi
fi

# Fix permissions for data and config directories
chown -R nextjs:nodejs /app/data /app/config

# Check if the persistent database exists
if [ ! -s "$TARGET_DB" ]; then
    echo "[Entrypoint] Initializing database..."
    if [ -f "$SOURCE_DB" ]; then
        echo "[Entrypoint] Copying pre-packaged database from $SOURCE_DB to $TARGET_DB"
        cp "$SOURCE_DB" "$TARGET_DB"
        # Ensure correct permissions
        chown nextjs:nodejs "$TARGET_DB"
        # Mark as seeded since pre-packaged DB includes seed data
        touch "$SEED_MARKER"
        # Record initial version
        echo "$CURRENT_VERSION" > "$VERSION_FILE"
    else
        echo "[Entrypoint] Source database not found at $SOURCE_DB. Initializing with migrations."
    fi
else
    echo "[Entrypoint] Database already exists at $TARGET_DB."
fi

# Check for version upgrade
PREVIOUS_VERSION=""
if [ -f "$VERSION_FILE" ]; then
    PREVIOUS_VERSION=$(cat "$VERSION_FILE")
fi

# Run migrations to ensure DB schema is available and up to date. A partially migrated
# database is not a safe runtime state, so failures are fatal under `set -e`.
echo "[Entrypoint] Running database migrations to sync schema..."
cd /app
$PRISMA_BIN migrate deploy --schema=./prisma/schema.prisma
echo "[Entrypoint] Migrations completed successfully."

# Always run seed after migrations to ensure admin user has correct role/isActive
# (migration may have reset role to default 'user' for existing installs)
echo "[Entrypoint] Ensuring admin user exists with correct role..."
node "$SEED_ADMIN_SCRIPT"
echo "[Entrypoint] Admin seed completed successfully."
touch "$SEED_MARKER" 2>/dev/null

# Check if version changed - rebuild system tags automatically
if [ "$PREVIOUS_VERSION" != "$CURRENT_VERSION" ]; then
    echo "[Entrypoint] Version upgrade detected: $PREVIOUS_VERSION -> $CURRENT_VERSION"
    echo "[Entrypoint] Rebuilding system tags to sync with new version..."
    cd /app && node "$REBUILD_TAGS_SCRIPT" && {
        echo "[Entrypoint] System tags rebuilt successfully."
    } || echo "[Entrypoint] Tag rebuild failed (non-fatal, continuing...)."
    # Update version marker
    echo "$CURRENT_VERSION" > "$VERSION_FILE"
fi

# Sync 一建 prompts to bySubject（幂等）——每次容器启动都执行，不绑版本判断：
#   - 我们经常只改代码、不 bump package 版本就发布修复镜像。若同步绑在版本
#     变化上，生产的 .app_version 已是当前版本，拉到修复镜像也不会触发同步，
#     警告无法真正消失。脚本本身幂等：已与镜像一致时直接跳过，无多余写入。
#   - 方式二新用户（纯拉镜像未跑 bootstrap）：注入一建提示词
#   - 老用户：升级 bySubject 到镜像内权威版本
#   - 已一致：跳过。只碰 bySubject 三模板，密钥字段字节不动。
if [ -f "$SYNC_YIJIAN_SCRIPT" ]; then
    echo "[Entrypoint] Syncing 一建 prompts (idempotent)..."
    node "$SYNC_YIJIAN_SCRIPT" && {
        echo "[Entrypoint] 一建 prompts synced successfully."
    } || echo "[Entrypoint] 一建 prompt sync failed (non-fatal, continuing...)."
fi

# HTTPS Setup
CERT_DIR="/app/certs"
CERT_FILE="$CERT_DIR/cert.pem"
KEY_FILE="$CERT_DIR/key.pem"

if [ "$HTTPS_ENABLED" = "true" ]; then
    echo "[Entrypoint] HTTPS enabled"
    
    # 确保证书目录存在
    mkdir -p "$CERT_DIR"
    chown nextjs:nodejs "$CERT_DIR"
    
    # 检查证书是否存在
    if [ ! -f "$CERT_FILE" ] || [ ! -f "$KEY_FILE" ]; then
        echo "[Entrypoint] 证书不存在，自动生成自签名证书..."
        
        # 获取证书 CN（优先使用环境变量，否则使用 localhost）
        CERT_CN="${CERT_DOMAIN:-localhost}"
        
        # 生成自签名证书（有效期 10 年）
        openssl req -x509 -newkey rsa:2048 \
            -keyout "$KEY_FILE" \
            -out "$CERT_FILE" \
            -days 3650 \
            -nodes \
            -subj "/CN=$CERT_CN" \
            2>/dev/null
        
        if [ $? -eq 0 ]; then
            echo "[Entrypoint] 自签名证书生成成功: CN=$CERT_CN"
            chown nextjs:nodejs "$CERT_FILE" "$KEY_FILE"
        else
            echo "[Entrypoint] 警告: 证书生成失败，HTTPS 将不可用"
        fi
    else
        echo "[Entrypoint] 使用已有证书: $CERT_FILE"
    fi
    
    # 启动 HTTPS 代理
    if [ -f "$CERT_FILE" ] && [ -f "$KEY_FILE" ]; then
        echo "[Entrypoint] 启动 HTTPS 代理 (端口 443)..."
        su-exec nextjs:nodejs node /app/https-server.js &
    fi
fi

# Execute the main container command as nextjs user
exec su-exec nextjs:nodejs "$@"
