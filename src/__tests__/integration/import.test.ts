import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
    const tx = {
        user: {
            findMany: vi.fn(),
            create: vi.fn(),
            update: vi.fn(),
        },
        subject: {
            findFirst: vi.fn(),
            create: vi.fn(),
        },
        knowledgeTag: {
            findFirst: vi.fn(),
            findMany: vi.fn(),
            create: vi.fn(),
        },
        errorItem: {
            findFirst: vi.fn(),
            create: vi.fn(),
            update: vi.fn(),
        },
        reviewSchedule: {
            findFirst: vi.fn(),
            create: vi.fn(),
        },
        practiceRecord: {
            findFirst: vi.fn(),
            create: vi.fn(),
        },
    };

    return {
        tx,
        userFindUnique: vi.fn(),
        transaction: vi.fn(async (callback: (client: typeof tx) => Promise<void>) => callback(tx)),
        getServerSession: vi.fn(),
    };
});

vi.mock('@/lib/prisma', () => ({
    prisma: {
        user: { findUnique: mocks.userFindUnique },
        $transaction: mocks.transaction,
    },
}));

vi.mock('next-auth', () => ({
    getServerSession: mocks.getServerSession,
}));

vi.mock('@/lib/auth', () => ({ authOptions: {} }));

vi.mock('@/lib/image-compress', () => ({
    compressDataUrl: vi.fn((value: string) => value),
}));

import { POST } from '@/app/api/import/route';

describe('/api/import', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getServerSession.mockResolvedValue({
            user: { id: 'user-1', email: 'user@example.com', role: 'user' },
        });
        mocks.userFindUnique.mockResolvedValue({
            id: 'user-1',
            email: 'user@example.com',
            role: 'user',
        });
    });

    it('应该保留同名但不同学科的自定义标签，而不是错误合并', async () => {
        const storedTags: Array<Record<string, unknown>> = [];
        let nextTagId = 1;
        let nextItemId = 1;

        mocks.tx.knowledgeTag.findFirst.mockImplementation(async ({ where }) => (
            storedTags.find((tag) =>
                tag.name === where.name &&
                tag.userId === where.userId &&
                (where.subject === undefined || tag.subject === where.subject) &&
                (where.parentId === undefined || tag.parentId === where.parentId)
            ) ?? null
        ));
        mocks.tx.knowledgeTag.create.mockImplementation(async ({ data }) => {
            const created = { id: `created-tag-${nextTagId++}`, ...data, parentId: data.parentId ?? null };
            storedTags.push(created);
            return created;
        });
        mocks.tx.knowledgeTag.findMany.mockResolvedValue([]);
        mocks.tx.errorItem.findFirst.mockResolvedValue(null);
        mocks.tx.errorItem.create.mockImplementation(async () => ({ id: `created-item-${nextItemId++}` }));
        mocks.tx.errorItem.update.mockResolvedValue({});

        const response = await POST(new Request('http://localhost/api/import', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                version: 1,
                exportedAt: new Date().toISOString(),
                user: {
                    id: 'user-1',
                    email: 'user@example.com',
                    name: 'User',
                    educationStage: null,
                    enrollmentYear: null,
                    role: 'user',
                },
                subjects: [],
                customTags: [
                    { id: 'math-tag', name: '计算', subject: 'math', parentId: null, order: 0, code: null, isSystem: false, userId: 'user-1' },
                    { id: 'physics-tag', name: '计算', subject: 'physics', parentId: null, order: 0, code: null, isSystem: false, userId: 'user-1' },
                ],
                errorItems: [
                    { id: 'math-item', userId: 'user-1', subjectId: null, originalImageUrl: '', questionText: 'math question', masteryLevel: 0, tags: [{ id: 'math-tag', name: '计算', subject: 'math' }] },
                    { id: 'physics-item', userId: 'user-1', subjectId: null, originalImageUrl: '', questionText: 'physics question', masteryLevel: 0, tags: [{ id: 'physics-tag', name: '计算', subject: 'physics' }] },
                ],
                reviewSchedules: [],
                practiceRecords: [],
            }),
        }));

        expect(response.status).toBe(200);
        expect(mocks.tx.knowledgeTag.create).toHaveBeenCalledTimes(2);
        const mathTag = storedTags.find(tag => tag.subject === 'math');
        const physicsTag = storedTags.find(tag => tag.subject === 'physics');
        expect(mocks.tx.errorItem.update).toHaveBeenNthCalledWith(1, expect.objectContaining({
            data: { tags: { connect: [{ id: mathTag?.id }] } },
        }));
        expect(mocks.tx.errorItem.update).toHaveBeenNthCalledWith(2, expect.objectContaining({
            data: { tags: { connect: [{ id: physicsTag?.id }] } },
        }));
    });

    it('全量导入应该拒绝不含用户映射的旧备份', async () => {
        mocks.getServerSession.mockResolvedValue({
            user: { id: 'admin-1', email: 'admin@example.com', role: 'admin' },
        });
        mocks.userFindUnique.mockResolvedValue({ id: 'admin-1', email: 'admin@example.com', role: 'admin' });

        const response = await POST(new Request('http://localhost/api/import?all=true', {
            method: 'POST',
            body: JSON.stringify({
                version: 1,
                scope: 'all',
                user: { id: 'admin-1', email: 'admin@example.com' },
                subjects: [], customTags: [], errorItems: [], reviewSchedules: [], practiceRecords: [],
            }),
        }));

        expect(response.status).toBe(400);
        expect(mocks.transaction).not.toHaveBeenCalled();
    });

    it('全量导入应该先按邮箱映射用户，不能直接信任备份 userId', async () => {
        mocks.getServerSession.mockResolvedValue({
            user: { id: 'current-admin', email: 'admin@example.com', role: 'admin' },
        });
        mocks.userFindUnique.mockResolvedValue({ id: 'current-admin', email: 'admin@example.com', role: 'admin' });
        mocks.tx.user.findMany.mockResolvedValue([{ id: 'db-existing', email: 'student@example.com' }]);
        mocks.tx.user.update.mockResolvedValue({ id: 'db-existing' });
        mocks.tx.subject.findFirst.mockResolvedValue(null);
        mocks.tx.subject.create.mockResolvedValue({ id: 'db-subject' });

        const response = await POST(new Request('http://localhost/api/import?all=true', {
            method: 'POST',
            body: JSON.stringify({
                version: 2,
                scope: 'all',
                user: { id: 'source-admin', email: 'admin@example.com' },
                users: [{
                    id: 'source-user',
                    email: 'Student@Example.com',
                    passwordHash: '$2b$12$01234567890123456789012345678901234567890123456789012',
                    name: 'Student', educationStage: null, enrollmentYear: null,
                    role: 'user', isActive: true,
                }],
                subjects: [{ id: 'source-subject', name: 'Math', userId: 'source-user' }],
                customTags: [], errorItems: [], reviewSchedules: [], practiceRecords: [],
            }),
        }));

        expect(response.status).toBe(200);
        expect(mocks.tx.subject.create).toHaveBeenCalledWith({
            data: { name: 'Math', userId: 'db-existing' },
        });
    });

    it('masteryLevel 必须是 0 到 2 的整数', async () => {
        mocks.tx.knowledgeTag.findMany.mockResolvedValue([]);
        mocks.tx.errorItem.findFirst.mockResolvedValue(null);
        mocks.tx.errorItem.create.mockResolvedValue({ id: 'created-item' });

        const response = await POST(new Request('http://localhost/api/import', {
            method: 'POST',
            body: JSON.stringify({
                version: 2,
                user: { id: 'user-1', email: 'user@example.com' },
                subjects: [], customTags: [], reviewSchedules: [], practiceRecords: [],
                errorItems: [{
                    id: 'item', userId: 'user-1', subjectId: null,
                    originalImageUrl: '', masteryLevel: 1.5, tags: [],
                }],
            }),
        }));

        expect(response.status).toBe(200);
        expect(mocks.tx.errorItem.create).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ masteryLevel: 0 }),
        }));
    });
});
