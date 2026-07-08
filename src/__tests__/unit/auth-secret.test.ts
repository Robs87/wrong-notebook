/**
 * NEXTAUTH_SECRET 强度校验单元测试
 *
 * 核心回归点：assertSecretStrength() 在 next build（页面数据收集）阶段
 * 会随 auth.ts 被 import 而执行。build 环境没有运行时密钥是正常的，
 * 必须跳过，否则 Docker/CI 镜像构建会因 "Failed to collect page data" 失败。
 * 该用例锁定此行为，防止再次回归。
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

// process.env.NODE_ENV 在 @types/node 下被声明为只读，
// 通过单点断言的 helper 写入，避免在每个赋值点重复断言。
const env = process.env as Record<string, string | undefined>;

// auth.ts 是有副作用的模块（import 时即调用 assertSecretStrength），
// 通过重置模块注册表 + 控制环境变量来隔离每个用例。
async function importAuthFresh() {
    vi.resetModules();
    return await import('@/lib/auth');
}

const ORIGINAL = {
    NEXTAUTH_SECRET: process.env.NEXTAUTH_SECRET,
    NODE_ENV: process.env.NODE_ENV,
    NEXT_PHASE: process.env.NEXT_PHASE,
};

beforeEach(() => {
    // 每个用例前清掉可能影响判定的环境变量
    delete env.NEXTAUTH_SECRET;
    delete env.NEXT_PHASE;
});

afterEach(() => {
    env.NEXTAUTH_SECRET = ORIGINAL.NEXTAUTH_SECRET;
    env.NODE_ENV = ORIGINAL.NODE_ENV;
    env.NEXT_PHASE = ORIGINAL.NEXT_PHASE;
    vi.restoreAllMocks();
});

describe('NEXTAUTH_SECRET 强度校验', () => {
    it('build 阶段（NEXT_PHASE=phase-production-build）即使无 secret 也不应抛错', async () => {
        env.NEXT_PHASE = 'phase-production-build';
        env.NODE_ENV = 'production';
        // 不设 NEXTAUTH_SECRET —— 模拟 Docker/CI build 环境
        await expect(importAuthFresh()).resolves.toBeDefined();
    });

    it('运行时（非 build）production 模式下缺 secret 应抛 FATAL', async () => {
        env.NODE_ENV = 'production';
        // 不设 NEXT_PHASE —— 模拟真实启动
        await expect(importAuthFresh()).rejects.toThrow(/FATAL: NEXTAUTH_SECRET is not set/);
    });

    it('运行时 production 模式下弱 secret 应抛 FATAL', async () => {
        env.NODE_ENV = 'production';
        env.NEXTAUTH_SECRET = 'changeme';
        await expect(importAuthFresh()).rejects.toThrow(/too weak/);
    });

    it('dev 模式下缺 secret 不应抛错（仅警告）', async () => {
        env.NODE_ENV = 'development';
        await expect(importAuthFresh()).resolves.toBeDefined();
    });

    it('运行时 production 模式下强 secret 应正常加载', async () => {
        env.NODE_ENV = 'production';
        env.NEXTAUTH_SECRET = 'a-very-strong-random-secret-32-bytes!';
        await expect(importAuthFresh()).resolves.toBeDefined();
    });
});
