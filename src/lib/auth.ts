import { NextAuthOptions } from "next-auth"
import { PrismaAdapter } from "@next-auth/prisma-adapter"
import CredentialsProvider from "next-auth/providers/credentials"
import { prisma } from "@/lib/prisma"
import { compare } from "bcryptjs"
import { createLogger } from "@/lib/logger"

const logger = createLogger('auth');

type NextAuthOptionsWithTrustHost = NextAuthOptions & {
    trustHost?: boolean;
};

/**
 * 生产环境强制要求高强度 NEXTAUTH_SECRET，防止用公开/弱密钥签 JWT
 * 导致可离线伪造任意用户（含 admin）的 session cookie。
 * dev 环境宽松，仅警告。
 */
function assertSecretStrength() {
    const secret = process.env.NEXTAUTH_SECRET;
    const isProd = process.env.NODE_ENV === 'production';
    if (!secret) {
        if (isProd) {
            throw new Error(
                'FATAL: NEXTAUTH_SECRET is not set. Refusing to boot in production without a strong secret. ' +
                'Generate one with: openssl rand -base64 32'
            );
        }
        logger.warn('NEXTAUTH_SECRET not set — using fallback for dev only. DO NOT use in production.');
        return;
    }
    // 弱密钥/占位符检测（与 .env.example 里的占位值一致）
    const weakValues = new Set([
        'supersecret-dev-secret',
        'changeme',
        'secret',
        'your-secret-key',
    ]);
    if (weakValues.has(secret) || secret.length < 16) {
        if (isProd) {
            throw new Error(
                'FATAL: NEXTAUTH_SECRET is too weak or a known placeholder. Refusing to boot in production. ' +
                'Generate one with: openssl rand -base64 32'
            );
        }
        logger.warn('NEXTAUTH_SECRET appears weak — fine for dev, but generate a strong one for production.');
    }
}

assertSecretStrength();

export const authOptions: NextAuthOptionsWithTrustHost = {
    adapter: PrismaAdapter(prisma),
    session: {
        strategy: "jwt",
    },
    trustHost: true,
    pages: {
        signIn: "/login",
    },
    // Force using a single cookie name to avoid HTTP/HTTPS mismatches in proxy environments
    // This allows running without NEXTAUTH_URL behind Cloudflare Tunnel
    cookies: {
        sessionToken: {
            name: "next-auth.session-token",
            options: {
                httpOnly: true,
                sameSite: "lax",
                path: "/",
                // 判断是否使用 secure cookie：
                // 1) 显式 AUTH_FORCE_SECURE_COOKIE=true → 强制（推荐任何 HTTPS/TLS 终端代理部署使用）
                // 2) NEXTAUTH_URL 以 https 开头 → 推断为 HTTPS
                // 默认允许 HTTP 局域网访问（见 README Docker 场景）。
                // 生产环境如部署在 HTTPS 反代后，强烈建议设置 AUTH_FORCE_SECURE_COOKIE=true。
                secure: process.env.NODE_ENV === "production" && (
                    process.env.AUTH_FORCE_SECURE_COOKIE === "true" ||
                    process.env.NEXTAUTH_URL?.startsWith("https") === true
                ),
            },
        },
    },
    providers: [
        CredentialsProvider({
            name: "Credentials",
            credentials: {
                email: { label: "Email", type: "email" },
                password: { label: "Password", type: "password" }
            },
            async authorize(credentials) {
                logger.debug({ email: credentials?.email }, 'Authorize called');
                if (!credentials?.email || !credentials?.password) {
                    logger.debug('Missing credentials');
                    return null
                }

                const user = await prisma.user.findUnique({
                    where: {
                        email: credentials.email
                    }
                })

                if (!user) {
                    logger.debug('User not found');
                    return null
                }

                // Check if user is active
                if (!user.isActive) {
                    logger.warn('User is disabled');
                    throw new Error("Account is disabled")
                }

                const isPasswordValid = await compare(credentials.password, user.password)

                if (!isPasswordValid) {
                    logger.debug('Invalid password');
                    return null
                }

                logger.info({ email: user.email }, 'Login successful');

                return {
                    id: user.id,
                    email: user.email,
                    name: user.name,
                    role: user.role,
                }
            }
        })
    ],
    // 仅在非生产环境开启 debug，避免 token/session 细节被打入生产日志
    debug: process.env.NODE_ENV !== 'production',
    logger: {
        error(code, metadata) {
            logger.error({ code, metadata }, 'NextAuth error');
        },
        warn(code) {
            logger.warn({ code }, 'NextAuth warning');
        },
        debug(code, metadata) {
            logger.debug({ code, metadata }, 'NextAuth debug');
        }
    },
    callbacks: {
        async session({ session, token }) {
            logger.debug({ userId: token.id }, 'Session callback');
            // token.id 为 undefined 表示 jwt 回调已判定账号被禁用/删除，
            // 此时返回的 session 不带有效用户身份，下游所有 requireSession/userId 检查会判为未登录。
            return {
                ...session,
                user: {
                    ...session.user,
                    id: token.id,
                    role: token.role,
                }
            }
        },
        async jwt({ token, user }) {
            if (user) {
                logger.debug({ userId: user.id }, 'JWT callback - Initial signin');
                return {
                    ...token,
                    id: user.id,
                    role: user.role,
                }
            }
            // 后续请求：每次从 DB 刷新 role / isActive，
            // 确保被降级或禁用的 admin 立即失去权限（不能等 JWT 自然过期）。
            if (token.id) {
                try {
                    const fresh = await prisma.user.findUnique({
                        where: { id: token.id as string },
                        select: { role: true, isActive: true },
                    });
                    if (!fresh || !fresh.isActive) {
                        // 账号被删除或禁用：清空关键声明，session 回调将得到无 role 的 token，等同登出
                        logger.warn({ userId: token.id }, 'User disabled or removed, invalidating session');
                        const invalidated = { ...token, id: undefined, role: undefined } as unknown as typeof token;
                        return invalidated;
                    }
                    return { ...token, role: fresh.role };
                } catch (error) {
                    logger.error({ error }, 'Failed to refresh user role in jwt callback');
                    // 查询失败时不升级权限，沿用旧 role（保守策略：避免 DB 抖动导致全员登出）
                    return token;
                }
            }
            return token
        }
    }
}

// Log startup check
logger.info({
    NODE_ENV: process.env.NODE_ENV,
    NEXTAUTH_URL: process.env.NEXTAUTH_URL,
    HAS_SECRET: !!process.env.NEXTAUTH_SECRET,
    AUTH_TRUST_HOST: process.env.AUTH_TRUST_HOST
}, 'AuthConfig loading');
