import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    getServerSession: vi.fn(),
    userFindUnique: vi.fn(),
    userFindMany: vi.fn(),
    subjectFindMany: vi.fn(),
    tagFindMany: vi.fn(),
    itemFindMany: vi.fn(),
    scheduleFindMany: vi.fn(),
    practiceFindMany: vi.fn(),
}));

vi.mock('next-auth', () => ({ getServerSession: mocks.getServerSession }));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));
vi.mock('@/lib/prisma', () => ({
    prisma: {
        user: { findUnique: mocks.userFindUnique, findMany: mocks.userFindMany },
        subject: { findMany: mocks.subjectFindMany },
        knowledgeTag: { findMany: mocks.tagFindMany },
        errorItem: { findMany: mocks.itemFindMany },
        reviewSchedule: { findMany: mocks.scheduleFindMany },
        practiceRecord: { findMany: mocks.practiceFindMany },
    },
}));

import { GET } from '@/app/api/export/route';

describe('/api/export', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getServerSession.mockResolvedValue({
            user: { id: 'admin-db', email: 'admin@example.com', role: 'admin' },
        });
        mocks.userFindUnique.mockResolvedValue({
            id: 'admin-db', email: 'admin@example.com', name: 'Admin',
            educationStage: null, enrollmentYear: null, role: 'admin',
        });
        mocks.subjectFindMany.mockResolvedValue([]);
        mocks.tagFindMany.mockResolvedValue([]);
        mocks.itemFindMany.mockResolvedValue([]);
        mocks.scheduleFindMany.mockResolvedValue([]);
        mocks.practiceFindMany.mockResolvedValue([]);
    });

    it('全量备份应包含可恢复的用户身份映射，但不暴露 password 字段名', async () => {
        mocks.userFindMany.mockResolvedValue([{
            id: 'source-user', email: 'student@example.com', password: '$2b$12$hash',
            name: 'Student', role: 'user', isActive: true,
        }]);

        const response = await GET(new Request('http://localhost/api/export?all=true'));
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(response.headers.get('cache-control')).toContain('no-store');
        expect(body.version).toBe(2);
        expect(body.scope).toBe('all');
        expect(body.users).toEqual([expect.objectContaining({
            id: 'source-user', email: 'student@example.com', passwordHash: '$2b$12$hash',
        })]);
        expect(body.users[0]).not.toHaveProperty('password');
    });

    it('个人导出不应包含其他用户或密码哈希', async () => {
        const response = await GET(new Request('http://localhost/api/export'));
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.scope).toBe('user');
        expect(body).not.toHaveProperty('users');
        expect(mocks.userFindMany).not.toHaveBeenCalled();
    });
});
