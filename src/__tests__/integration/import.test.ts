import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
    const tx = {
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
});
