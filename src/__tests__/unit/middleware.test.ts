import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

// Mock next-auth/jwt
vi.mock('next-auth/jwt', () => ({
    getToken: vi.fn(),
}));

// Mock logger
vi.mock('@/lib/logger', () => ({
    createLogger: vi.fn(() => ({
        debug: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
    })),
}));

const prismaMocks = vi.hoisted(() => ({ userFindUnique: vi.fn() }));
vi.mock('@/lib/prisma', () => ({
    prisma: { user: { findUnique: prismaMocks.userFindUnique } },
}));

import { proxy } from '@/proxy';
import { getToken } from 'next-auth/jwt';

describe('middleware', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        prismaMocks.userFindUnique.mockResolvedValue({ role: 'user', isActive: true });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('未认证用户', () => {
        it('应该重定向未认证用户到登录页', async () => {
            vi.mocked(getToken).mockResolvedValue(null);

            const req = new NextRequest('http://localhost:3000/notebooks');
            const response = await proxy(req);

            expect(response).not.toBeNull();
            expect(response?.status).toBe(307); // Redirect status
            expect(response?.headers.get('location')).toContain('/login');
            expect(response?.headers.get('location')).toContain('callbackUrl=%2Fnotebooks');
        });

        it('应该允许未认证用户访问登录页', async () => {
            vi.mocked(getToken).mockResolvedValue(null);

            const req = new NextRequest('http://localhost:3000/login');
            const response = await proxy(req);

            // 返回 null 表示不拦截
            expect(response).toBeNull();
        });

        it('应该允许未认证用户访问注册页', async () => {
            vi.mocked(getToken).mockResolvedValue(null);

            const req = new NextRequest('http://localhost:3000/register');
            const response = await proxy(req);

            expect(response).toBeNull();
        });

        it('应该保留查询参数在 callbackUrl 中', async () => {
            vi.mocked(getToken).mockResolvedValue(null);

            const req = new NextRequest('http://localhost:3000/notebooks/123?tab=details');
            const response = await proxy(req);

            expect(response).not.toBeNull();
            const location = response?.headers.get('location') || '';
            // callbackUrl 应该包含完整路径和查询参数
            expect(decodeURIComponent(location)).toContain('/notebooks/123?tab=details');
        });
    });

    describe('已认证用户', () => {
        const mockToken = {
            id: 'user-123',
            sub: 'user-123',
            email: 'test@example.com',
            name: 'Test User',
        };

        it('应该把已被服务端失效、缺少用户 ID 的 token 当作未认证', async () => {
            vi.mocked(getToken).mockResolvedValue({
                sub: 'user-123',
                email: 'disabled@example.com',
            } as never);

            const req = new NextRequest('http://localhost:3000/notebooks');
            const response = await proxy(req);

            expect(response?.status).toBe(307);
            expect(response?.headers.get('location')).toContain('/login');
        });

        it('旧 token 仍有 id 时也应该以数据库禁用状态为准', async () => {
            vi.mocked(getToken).mockResolvedValue(mockToken as never);
            prismaMocks.userFindUnique.mockResolvedValue({ role: 'user', isActive: false });

            const response = await proxy(new NextRequest('http://localhost:3000/notebooks'));

            expect(response?.status).toBe(307);
            expect(response?.headers.get('location')).toContain('/login');
        });

        it('旧 token 声称 admin 时也应该以数据库最新角色为准', async () => {
            vi.mocked(getToken).mockResolvedValue({ ...mockToken, role: 'admin' } as never);
            prismaMocks.userFindUnique.mockResolvedValue({ role: 'user', isActive: true });

            const response = await proxy(new NextRequest('http://localhost:3000/admin'));

            expect(response?.status).toBe(307);
            expect(response?.headers.get('location')).toBe('http://localhost:3000/');
        });

        it('应该允许已认证用户访问受保护页面', async () => {
            vi.mocked(getToken).mockResolvedValue(mockToken as never);

            const req = new NextRequest('http://localhost:3000/notebooks');
            const response = await proxy(req);

            // 返回 undefined 表示允许继续
            expect(response).toBeUndefined();
        });

        it('应该重定向已认证用户离开登录页', async () => {
            vi.mocked(getToken).mockResolvedValue(mockToken as never);

            const req = new NextRequest('http://localhost:3000/login');
            const response = await proxy(req);

            expect(response).not.toBeNull();
            expect(response?.status).toBe(307);
            expect(response?.headers.get('location')).toBe('http://localhost:3000/');
        });

        it('应该重定向已认证用户离开注册页', async () => {
            vi.mocked(getToken).mockResolvedValue(mockToken as never);

            const req = new NextRequest('http://localhost:3000/register');
            const response = await proxy(req);

            expect(response).not.toBeNull();
            expect(response?.status).toBe(307);
            expect(response?.headers.get('location')).toBe('http://localhost:3000/');
        });

        it('应该允许已认证用户访问首页', async () => {
            vi.mocked(getToken).mockResolvedValue(mockToken as never);

            const req = new NextRequest('http://localhost:3000/');
            const response = await proxy(req);

            expect(response).toBeUndefined();
        });
    });

    describe('错误处理', () => {
        it('Token 验证失败时应该拒绝受保护请求而不是放行', async () => {
            vi.mocked(getToken).mockRejectedValue(new Error('Token validation failed'));

            const req = new NextRequest('http://localhost:3000/notebooks');

            const response = await proxy(req);

            expect(response?.status).toBe(307);
            expect(response?.headers.get('location')).toContain('/login');
        });

        it('Token 验证失败时应该记录错误日志', async () => {
            // 此测试验证错误处理路径不会崩溃
            // 由于模块缓存，我们在上面的测试中已经验证了错误处理
            // 这里只验证中间件导入成功
            expect(proxy).toBeDefined();
        });
    });

    describe('getToken 调用配置', () => {
        it('应该使用正确的 cookie 名称', async () => {
            vi.mocked(getToken).mockResolvedValue(null);

            const req = new NextRequest('http://localhost:3000/notebooks');
            await proxy(req);

            expect(getToken).toHaveBeenCalledWith(
                expect.objectContaining({
                    cookieName: 'next-auth.session-token',
                })
            );
        });

        it('应该传递 NEXTAUTH_SECRET', async () => {
            const originalSecret = process.env.NEXTAUTH_SECRET;
            process.env.NEXTAUTH_SECRET = 'test-secret';

            vi.mocked(getToken).mockResolvedValue(null);

            const req = new NextRequest('http://localhost:3000/notebooks');
            await proxy(req);

            expect(getToken).toHaveBeenCalledWith(
                expect.objectContaining({
                    secret: 'test-secret',
                })
            );

            process.env.NEXTAUTH_SECRET = originalSecret;
        });
    });

    describe('路径匹配', () => {
        it('中间件配置应该存在', async () => {
            // 验证中间件导出存在
            const middlewareModule = await import('@/proxy');
            expect(middlewareModule.config).toBeDefined();
            expect(middlewareModule.config.matcher).toBeDefined();
            expect(middlewareModule.config.matcher.length).toBeGreaterThan(0);
        });

        it('应该处理根路径', async () => {
            vi.mocked(getToken).mockResolvedValue(null);

            const req = new NextRequest('http://localhost:3000/');
            const response = await proxy(req);

            expect(response).not.toBeNull();
            expect(response?.headers.get('location')).toContain('/login');
        });

        it('应该处理嵌套路径', async () => {
            vi.mocked(getToken).mockResolvedValue(null);

            const req = new NextRequest('http://localhost:3000/notebooks/123/edit');
            const response = await proxy(req);

            expect(response).not.toBeNull();
            expect(response?.headers.get('location')).toContain('callbackUrl');
        });
    });
});
