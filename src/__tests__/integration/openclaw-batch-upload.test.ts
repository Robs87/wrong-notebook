import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    userFindFirst: vi.fn(),
    userFindUnique: vi.fn(),
    compare: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
    prisma: {
        user: {
            findFirst: mocks.userFindFirst,
            findUnique: mocks.userFindUnique,
        },
    },
}));

vi.mock('bcryptjs', () => ({
    compare: mocks.compare,
}));

vi.mock('@/lib/image-compress', () => ({
    compressDataUrl: vi.fn((value: string) => value),
}));

import { POST } from '@/app/api/openclaw/batch-upload/route';

describe('/api/openclaw/batch-upload', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        process.env.OPENCLAW_AUTH_MODE = 'credentials';
        delete process.env.OPENCLAW_INTEGRATION_API_KEY;
        delete process.env.OPENCLAW_API_USER_EMAIL;
    });

    it('API Key 模式漏配密钥时应该拒绝，不能静默降级到密码认证', async () => {
        process.env.OPENCLAW_AUTH_MODE = 'apikey';
        const response = await POST(new Request('http://localhost/api/openclaw/batch-upload', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username: 'attacker@example.com',
                password: 'password',
                images: [{ base64: '', mimeType: 'image/png', filename: 'empty.png' }],
            }),
        }));

        expect(response.status).toBe(503);
        expect(mocks.userFindFirst).not.toHaveBeenCalled();
    });

    it('API Key 模式应该绑定环境变量中的用户，忽略 body.userEmail', async () => {
        process.env.OPENCLAW_AUTH_MODE = 'apikey';
        process.env.OPENCLAW_INTEGRATION_API_KEY = 'integration-secret';
        process.env.OPENCLAW_API_USER_EMAIL = 'bound@example.com';
        mocks.userFindUnique.mockResolvedValue({
            id: 'bound-user',
            email: 'bound@example.com',
            isActive: true,
        });

        const response = await POST(new Request('http://localhost/api/openclaw/batch-upload', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': 'integration-secret',
            },
            body: JSON.stringify({
                userEmail: 'victim@example.com',
                images: [{ base64: '', mimeType: 'image/png', filename: 'empty.png' }],
            }),
        }));

        expect(response.status).toBe(207);
        expect(mocks.userFindUnique).toHaveBeenCalledWith({
            where: { email: 'bound@example.com' },
        });
    });

    it('应该拒绝已被管理员禁用的账号', async () => {
        mocks.userFindFirst.mockResolvedValue({
            id: 'disabled-user',
            email: 'disabled@example.com',
            name: 'Disabled User',
            password: 'hashed-password',
            isActive: false,
        });
        mocks.compare.mockResolvedValue(true);

        const response = await POST(new Request('http://localhost/api/openclaw/batch-upload', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username: 'disabled@example.com',
                password: 'correct-password',
                images: [],
            }),
        }));

        expect(response.status).toBe(403);
        expect(mocks.compare).not.toHaveBeenCalled();
    });
});
