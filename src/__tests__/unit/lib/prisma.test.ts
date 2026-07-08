/**
 * Prisma SQLite 加固单元测试 (M7)
 *
 * 验证：pragma 被执行、withWriteRetry 在写冲突时重试、非冲突错误不重试。
 */
import { describe, it, expect, vi } from 'vitest';

// Mock logger
vi.mock('@/lib/logger', () => ({
    createLogger: vi.fn(() => ({
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        box: vi.fn(),
        divider: vi.fn(),
    })),
}));

// Mock @prisma/client：构造一个可控的 PrismaClient + Prisma 命名空间
const mockExecuteRawUnsafe = vi.fn();

vi.mock('@prisma/client', () => {
    return {
        PrismaClient: class MockPrismaClient {
            $executeRawUnsafe = mockExecuteRawUnsafe;
        },
        Prisma: {
            PrismaClientKnownRequestError: class PrismaClientKnownRequestError extends Error {
                code: string;
                constructor(message: string, { code }: { code: string }) {
                    super(message);
                    this.code = code;
                    this.name = 'PrismaClientKnownRequestError';
                }
            },
        },
    };
});

describe('SQLite 加固 (M7)', () => {
    it('模块加载时应执行 WAL / busy_timeout / synchronous / foreign_keys pragma', async () => {
        // 在测试内导入，确保 mock 已完全连接，并给 fire-and-forget 的 pragma 时间完成
        await import('@/lib/prisma');
        await new Promise((r) => setTimeout(r, 80));

        const calls = mockExecuteRawUnsafe.mock.calls.map((c) => c[0]);
        expect(calls).toContain('PRAGMA journal_mode=WAL');
        expect(calls).toContain('PRAGMA busy_timeout=5000');
        expect(calls).toContain('PRAGMA synchronous=NORMAL');
        expect(calls).toContain('PRAGMA foreign_keys=ON');
    });

    it('withWriteRetry: 成功时直接返回，不重试', async () => {
        const { withWriteRetry } = await import('@/lib/prisma');
        const fn = vi.fn().mockResolvedValue('ok');
        const result = await withWriteRetry(fn);
        expect(result).toBe('ok');
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('withWriteRetry: SQLITE_BUSY 错误应重试直到成功', async () => {
        const { withWriteRetry } = await import('@/lib/prisma');
        const fn = vi.fn()
            .mockRejectedValueOnce(new Error('SQLITE_BUSY: database is locked'))
            .mockRejectedValueOnce(new Error('database is locked'))
            .mockResolvedValueOnce('ok');

        const result = await withWriteRetry(fn, 3);
        expect(result).toBe('ok');
        expect(fn).toHaveBeenCalledTimes(3);
    });

    it('withWriteRetry: P2028 事务冲突应重试', async () => {
        const { withWriteRetry } = await import('@/lib/prisma');
        const { Prisma } = await import('@prisma/client');
        const conflictError = new (Prisma.PrismaClientKnownRequestError as unknown as new (m: string, o: { code: string }) => Error)(
            'Transaction conflict',
            { code: 'P2028' }
        );
        const fn = vi.fn()
            .mockRejectedValueOnce(conflictError)
            .mockResolvedValueOnce('ok');

        const result = await withWriteRetry(fn, 3);
        expect(result).toBe('ok');
        expect(fn).toHaveBeenCalledTimes(2);
    });

    it('withWriteRetry: 超过最大重试次数后抛出最后错误', async () => {
        const { withWriteRetry } = await import('@/lib/prisma');
        const fn = vi.fn().mockRejectedValue(new Error('SQLITE_BUSY'));
        await expect(withWriteRetry(fn, 2)).rejects.toThrow('SQLITE_BUSY');
        // 1 次初始 + 2 次重试 = 3 次
        expect(fn).toHaveBeenCalledTimes(3);
    });

    it('withWriteRetry: 非写冲突错误（如连接失败）不应重试', async () => {
        const { withWriteRetry } = await import('@/lib/prisma');
        const fn = vi.fn().mockRejectedValue(new Error('AI_CONNECTION_FAILED'));
        await expect(withWriteRetry(fn, 3)).rejects.toThrow('AI_CONNECTION_FAILED');
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('prisma 单例被导出', async () => {
        const { prisma } = await import('@/lib/prisma');
        expect(prisma).toBeDefined();
        expect(typeof prisma.$executeRawUnsafe).toBe('function');
    });
});
