/**
 * 配置密钥加解密工具（M5）。
 *
 * 第一性原理：AI API Key 等密钥即将从明文 JSON 文件迁移到 Prisma 表，
 * 但 DB 文件仍可能被备份/泄漏，因此密钥在入库前必须加密。
 *
 * 密钥派生：复用 NEXTAUTH_SECRET（应用启动时已强制要求强随机值），
 * 经 HKDF-SHA256 派生为 AES-256-GCM 的对称密钥。不新增环境变量，保持一键部署。
 *
 * 失败策略（fail-soft）：加解密失败（如密钥变更、数据损坏）不抛异常导致启动崩溃，
 * 而是返回空字符串——配置页会显示为空，管理员可重新填入。
 */
import crypto from 'crypto';
import { createLogger } from './logger';

const logger = createLogger('crypto-utils');

const ALGO = 'aes-256-gcm';
const KEY_LEN = 32; // AES-256
const IV_LEN = 12; // GCM 推荐 12 字节
const HKDF_INFO = 'wrong-notebook-config-encryption-v1';
const HKDF_SALT = 'wrong-notebook'; // 固定盐；info 已提供版本隔离
const CIPHER_PREFIX = 'enc:v1:';

let cachedKey: Buffer | null = null;

/**
 * 从 NEXTAUTH_SECRET 经 HKDF 派生 AES-256 密钥。
 * 无 secret 时返回 null（fail-soft：调用方按明文处理）。
 */
function getDerivedKey(): Buffer | null {
    if (cachedKey) return cachedKey;
    const secret = process.env.NEXTAUTH_SECRET;
    if (!secret) {
        logger.warn('NEXTAUTH_SECRET not set — config secrets cannot be encrypted at rest');
        return null;
    }
    const derived = crypto.hkdfSync('sha256', secret, HKDF_SALT, HKDF_INFO, KEY_LEN);
    cachedKey = Buffer.from(derived);
    return cachedKey;
}

/**
 * 加密明文密钥。返回 `enc:v1:<iv>:<tag>:<ct>`（均 base64）。
 * 输入为空或无 secret 时原样返回（空值不加密，无 secret 时退化为明文存储）。
 */
export function encryptSecret(plaintext: string): string {
    if (!plaintext) return '';
    const key = getDerivedKey();
    if (!key) return plaintext; // 无 secret，退化为明文（fail-soft）

    try {
        const iv = crypto.randomBytes(IV_LEN);
        const cipher = crypto.createCipheriv(ALGO, key, iv);
        const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
        const tag = cipher.getAuthTag();
        return `${CIPHER_PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
    } catch (error) {
        logger.error({ error: error instanceof Error ? error.message : String(error) }, 'encryptSecret failed');
        return plaintext; // 失败退化明文，不阻断写入
    }
}

/**
 * 解密密文。输入非 `enc:v1:` 前缀（明文或旧数据）时原样返回，保证向后兼容。
 * 解密失败返回空字符串（fail-soft），管理员会看到空值需重新填写。
 */
export function decryptSecret(stored: string): string {
    if (!stored || !stored.startsWith(CIPHER_PREFIX)) return stored; // 明文/空值，原样返回

    const key = getDerivedKey();
    if (!key) return ''; // 有密文但无 secret，无法解密 → 空

    try {
        const parts = stored.slice(CIPHER_PREFIX.length).split(':');
        if (parts.length !== 3) return '';
        const iv = Buffer.from(parts[0], 'base64');
        const tag = Buffer.from(parts[1], 'base64');
        const ct = Buffer.from(parts[2], 'base64');

        const decipher = crypto.createDecipheriv(ALGO, key, iv);
        decipher.setAuthTag(tag);
        const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
        return pt.toString('utf8');
    } catch (error) {
        logger.warn({ error: error instanceof Error ? error.message : String(error) }, 'decryptSecret failed (key changed or data corrupted)');
        return ''; // 解密失败 → 空，管理员重新填写
    }
}

/**
 * 判断存储值是否已加密（用于迁移逻辑判断）。
 */
export function isEncrypted(stored: string): boolean {
    return !!stored && stored.startsWith(CIPHER_PREFIX);
}
