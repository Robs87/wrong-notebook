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
