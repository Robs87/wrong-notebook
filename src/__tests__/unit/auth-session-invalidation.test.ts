import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    userFindUnique: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
    prisma: {
        user: { findUnique: mocks.userFindUnique },
    },
}));

vi.mock('@next-auth/prisma-adapter', () => ({
    PrismaAdapter: vi.fn(() => ({})),
}));

import { authOptions } from '@/lib/auth';

describe('NextAuth session invalidation', () => {
    it('账号失效后应该移除整个 session.user，不能保留旧 email', async () => {
        const sessionCallback = authOptions.callbacks?.session;
        expect(sessionCallback).toBeTypeOf('function');

        const result = await (sessionCallback as CallableFunction)({
            session: {
                user: { id: 'old-id', email: 'disabled@example.com', role: 'user' },
                expires: '2026-12-31',
            },
            token: {
                email: 'disabled@example.com',
                id: undefined,
                role: undefined,
            },
        });

        expect(result.user).toBeUndefined();
    });

    it('jwt 检测到账号禁用时应该清空所有身份声明', async () => {
        mocks.userFindUnique.mockResolvedValueOnce({ role: 'user', isActive: false });
        const jwtCallback = authOptions.callbacks?.jwt;
        expect(jwtCallback).toBeTypeOf('function');

        const result = await (jwtCallback as CallableFunction)({
            token: {
                id: 'disabled-id',
                role: 'user',
                email: 'disabled@example.com',
                name: 'Disabled',
            },
        });

        expect(result).toEqual(expect.objectContaining({
            id: undefined,
            role: undefined,
            email: undefined,
            name: undefined,
        }));
    });

    it('jwt 无法从数据库确认账号状态时应该失效，而不是沿用旧权限', async () => {
        mocks.userFindUnique.mockRejectedValueOnce(new Error('database unavailable'));
        const jwtCallback = authOptions.callbacks?.jwt;

        const result = await (jwtCallback as CallableFunction)({
            token: {
                id: 'old-admin-id',
                role: 'admin',
                email: 'admin@example.com',
            },
        });

        expect(result).toEqual(expect.objectContaining({
            id: undefined,
            role: undefined,
            email: undefined,
        }));
    });
});
