import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { unauthorized, internalError, badRequest, forbidden } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { compressDataUrl } from "@/lib/image-compress";

const logger = createLogger('api:import');

interface ImportData {
    version: number;
    exportedAt: string;
    scope?: string;
    user: {
        id: string;
        email: string;
        name: string | null;
        educationStage: string | null;
        enrollmentYear: number | null;
        role: string;
    };
    users?: Array<{
        id: string;
        email: string;
        passwordHash: string;
        name: string | null;
        educationStage: string | null;
        enrollmentYear: number | null;
        role: string;
        isActive: boolean;
        createdAt: string;
        updatedAt: string;
    }>;
    subjects: Array<{
        id: string;
        name: string;
        userId: string;
        createdAt: string;
        updatedAt: string;
    }>;
    customTags: Array<{
        id: string;
        name: string;
        subject: string;
        parentId: string | null;
        order: number;
        code: string | null;
        isSystem: boolean;
        userId: string;
        createdAt: string;
        updatedAt: string;
    }>;
    errorItems: Array<{
        id: string;
        userId: string;
        subjectId: string | null;
        originalImageUrl: string;
        ocrText: string | null;
        questionText: string | null;
        answerText: string | null;
        analysis: string | null;
        wrongAnswerText: string | null;
        mistakeAnalysis: string | null;
        mistakeStatus: string | null;
        knowledgePoints: string | null;
        geogebraCommands?: string | null;
        source: string | null;
        errorType: string | null;
        userNotes: string | null;
        masteryLevel: number;
        gradeSemester: string | null;
        paperLevel: string | null;
        createdAt: string;
        updatedAt: string;
        tags: Array<{ id: string; name: string; subject: string }>;
    }>;
    reviewSchedules: Array<{
        id: string;
        errorItemId: string;
        scheduledFor: string;
        completedAt: string | null;
        isCorrect: boolean | null;
        createdAt: string;
    }>;
    practiceRecords: Array<{
        id: string;
        userId: string;
        subject: string | null;
        difficulty: string | null;
        isCorrect: boolean | null;
        createdAt: string;
    }>;
}

const MAX_IMPORT_BYTES = 50 * 1024 * 1024;

class ImportValidationError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read the stream with an actual byte ceiling; Content-Length alone is attacker-controlled/optional. */
async function readLimitedJson(req: Request): Promise<unknown> {
    const declaredLength = Number(req.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_IMPORT_BYTES) {
        throw new ImportValidationError('Request body too large (max 50MB)');
    }
    if (!req.body) throw new ImportValidationError('Request body is required');

    const reader = req.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_IMPORT_BYTES) {
            await reader.cancel();
            throw new ImportValidationError('Request body too large (max 50MB)');
        }
        chunks.push(value);
    }

    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    try {
        return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
        throw new ImportValidationError('Invalid JSON import data');
    }
}

function validateImportData(value: unknown, importAll: boolean): asserts value is ImportData {
    if (!isRecord(value) || !Number.isInteger(value.version) || !isRecord(value.user)) {
        throw new ImportValidationError('Invalid import data format');
    }
    const arrayFields = ['subjects', 'customTags', 'errorItems', 'reviewSchedules', 'practiceRecords'] as const;
    for (const field of arrayFields) {
        if (!Array.isArray(value[field])) throw new ImportValidationError(`Invalid ${field} array`);
    }
    if (typeof value.user.id !== 'string' || typeof value.user.email !== 'string') {
        throw new ImportValidationError('Invalid export owner');
    }

    for (const [field, entries] of arrayFields.map((field) => [field, value[field]] as const)) {
        for (const entry of entries as unknown[]) {
            if (!isRecord(entry) || typeof entry.id !== 'string' || !entry.id) {
                throw new ImportValidationError(`Invalid item in ${field}`);
            }
        }
    }
    for (const item of value.errorItems as Array<Record<string, unknown>>) {
        if (typeof item.userId !== 'string' ||
            (item.subjectId !== null && item.subjectId !== undefined && typeof item.subjectId !== 'string') ||
            typeof item.originalImageUrl !== 'string' || !Array.isArray(item.tags) ||
            item.tags.some((tag) => !isRecord(tag) || typeof tag.id !== 'string' ||
                typeof tag.name !== 'string' || typeof tag.subject !== 'string')) {
            throw new ImportValidationError('Invalid error item');
        }
    }
    for (const subject of value.subjects as Array<Record<string, unknown>>) {
        if (typeof subject.name !== 'string' || typeof subject.userId !== 'string') {
            throw new ImportValidationError('Invalid subject');
        }
    }
    for (const tag of value.customTags as Array<Record<string, unknown>>) {
        if (typeof tag.name !== 'string' || typeof tag.subject !== 'string' || typeof tag.userId !== 'string' ||
            (tag.parentId !== null && tag.parentId !== undefined && typeof tag.parentId !== 'string') ||
            !Number.isInteger(tag.order)) {
            throw new ImportValidationError('Invalid custom tag');
        }
    }
    for (const schedule of value.reviewSchedules as Array<Record<string, unknown>>) {
        if (typeof schedule.errorItemId !== 'string' || typeof schedule.scheduledFor !== 'string') {
            throw new ImportValidationError('Invalid review schedule');
        }
    }
    for (const record of value.practiceRecords as Array<Record<string, unknown>>) {
        if (typeof record.userId !== 'string') throw new ImportValidationError('Invalid practice record');
    }

    if (importAll) {
        if (value.scope !== 'all' || (value.version as number) < 2 || !Array.isArray(value.users)) {
            throw new ImportValidationError('Full restore requires a version 2 full backup with users');
        }
        const ids = new Set<string>();
        const emails = new Set<string>();
        for (const candidate of value.users) {
            if (!isRecord(candidate) || typeof candidate.id !== 'string' || typeof candidate.email !== 'string' ||
                typeof candidate.passwordHash !== 'string' || !/^\$2[aby]\$\d{2}\$.{53}$/.test(candidate.passwordHash) ||
                !['admin', 'user'].includes(String(candidate.role)) || typeof candidate.isActive !== 'boolean') {
                throw new ImportValidationError('Invalid user in full backup');
            }
            const normalizedEmail = candidate.email.trim().toLowerCase();
            if (!normalizedEmail || ids.has(candidate.id) || emails.has(normalizedEmail)) {
                throw new ImportValidationError('Duplicate user identity in full backup');
            }
            ids.add(candidate.id);
            emails.add(normalizedEmail);
        }
        const references = [
            ...(value.subjects as Array<Record<string, unknown>>).map((item) => item.userId),
            ...(value.customTags as Array<Record<string, unknown>>).map((item) => item.userId),
            ...(value.errorItems as Array<Record<string, unknown>>).map((item) => item.userId),
            ...(value.practiceRecords as Array<Record<string, unknown>>).map((item) => item.userId),
        ];
        if (references.some((id) => typeof id !== 'string' || !ids.has(id))) {
            throw new ImportValidationError('Backup contains records for an unknown user');
        }
    }
}

/** Validate and parse a date string, returning undefined if invalid */
function safeParseDate(dateStr: string | undefined | null): Date | undefined {
    if (!dateStr) return undefined;
    const d = new Date(dateStr);
    return isNaN(d.getTime()) ? undefined : d;
}

/** Validate masteryLevel is an integer in range [0, 2] */
function safeMasteryLevel(val: unknown): number {
    const n = typeof val === 'number' ? val : Number(val);
    if (!Number.isInteger(n) || n < 0 || n > 2) return 0;
    return n;
}

export async function POST(req: Request) {
    const session = await getServerSession(authOptions);

    if (!session?.user?.email) {
        return unauthorized("Not authenticated");
    }

    const user = await prisma.user.findUnique({
        where: { email: session.user.email },
    });

    if (!user) {
        return unauthorized("User not found");
    }

    const { searchParams } = new URL(req.url);
    const importAll = searchParams.get('all') === 'true';

    // 只有管理员可以导入全部数据
    if (importAll && session.user.role !== 'admin') {
        return forbidden("Admin role required");
    }

    try {
        const parsedBody = await readLimitedJson(req);
        validateImportData(parsedBody, importAll);
        const body = parsedBody;

        // 非管理员模式：验证导出数据属于当前用户
        if (!importAll && body.user.email !== user.email) {
            return badRequest("Import data does not belong to current user");
        }

        const stats = {
            usersCreated: 0,
            usersUpdated: 0,
            subjectsCreated: 0,
            tagsCreated: 0,
            errorItemsCreated: 0,
            reviewSchedulesCreated: 0,
            practiceRecordsCreated: 0,
            tagsLinked: 0,
        };

        // 预压缩图片（在事务外，避免 sharp 阻塞事务、拉长锁持有时间）
        for (const item of body.errorItems) {
            if (item.originalImageUrl) {
                item.originalImageUrl = await compressDataUrl(item.originalImageUrl);
            }
        }

        // 使用事务确保数据一致性
        await prisma.$transaction(async (tx) => {
            // 全量恢复先以规范化邮箱建立 source userId -> 当前数据库 userId 映射。
            // 后续所有租户数据只能通过该映射落库，绝不直接信任备份中的 userId。
            const userIdMap = new Map<string, string>();
            if (importAll) {
                const existingUsers = await tx.user.findMany();
                const existingByEmail = new Map(existingUsers.map((entry) => [entry.email.toLowerCase(), entry]));
                for (const sourceUser of body.users!) {
                    const email = sourceUser.email.trim().toLowerCase();
                    const userData = {
                        email,
                        password: sourceUser.passwordHash,
                        name: sourceUser.name,
                        educationStage: sourceUser.educationStage,
                        enrollmentYear: sourceUser.enrollmentYear,
                        role: sourceUser.role,
                        isActive: sourceUser.isActive,
                    };
                    const existing = existingByEmail.get(email);
                    if (existing) {
                        const updated = await tx.user.update({ where: { id: existing.id }, data: userData });
                        userIdMap.set(sourceUser.id, updated.id);
                        stats.usersUpdated++;
                    } else {
                        const created = await tx.user.create({ data: userData });
                        userIdMap.set(sourceUser.id, created.id);
                        stats.usersCreated++;
                    }
                }
            } else {
                userIdMap.set(body.user.id, user.id);
            }
            const targetUserId = (sourceId: string): string => {
                const mapped = userIdMap.get(sourceId);
                if (!mapped) throw new ImportValidationError('Record references an unknown user');
                return mapped;
            };

            // 1. 导入 subjects
            const subjectIdMap = new Map<string, string>();
            for (const subject of (body.subjects || [])) {
                const mappedUserId = importAll ? targetUserId(subject.userId) : user.id;
                const existing = await tx.subject.findFirst({
                    where: { name: subject.name, userId: mappedUserId },
                });
                if (existing) {
                    subjectIdMap.set(subject.id, existing.id);
                } else {
                    const created = await tx.subject.create({
                        data: {
                            name: subject.name,
                            userId: mappedUserId,
                        },
                    });
                    subjectIdMap.set(subject.id, created.id);
                    stats.subjectsCreated++;
                }
            }

            // 2. 导入 custom tags
            // 标签的领域身份不是名称本身，而是 user + subject + parent + name。
            // 按父级依赖顺序处理，避免导出顺序恰好“子在父前”时丢失层级。
            const tagIdMap = new Map<string, string>();
            const customTags = body.customTags || [];
            const customTagIds = new Set(customTags.map(tag => tag.id));
            const pendingTags = [...customTags];

            while (pendingTags.length > 0) {
                let progressed = false;

                for (let index = pendingTags.length - 1; index >= 0; index--) {
                    const tag = pendingTags[index];
                    const hasPendingCustomParent = Boolean(
                        tag.parentId && customTagIds.has(tag.parentId) && !tagIdMap.has(tag.parentId)
                    );
                    if (hasPendingCustomParent) continue;

                    const mappedUserId = importAll ? targetUserId(tag.userId) : user.id;
                    const newParentId = tag.parentId ? tagIdMap.get(tag.parentId) ?? null : null;
                    const existing = await tx.knowledgeTag.findFirst({
                        where: {
                            name: tag.name,
                            subject: tag.subject,
                            userId: mappedUserId,
                            parentId: newParentId,
                            isSystem: false,
                        },
                    });

                    if (existing) {
                        tagIdMap.set(tag.id, existing.id);
                    } else {
                        const created = await tx.knowledgeTag.create({
                            data: {
                                name: tag.name,
                                subject: tag.subject,
                                isSystem: false,
                                userId: mappedUserId,
                                parentId: newParentId,
                                order: tag.order || 0,
                                code: tag.code,
                            },
                        });
                        tagIdMap.set(tag.id, created.id);
                        stats.tagsCreated++;
                    }

                    pendingTags.splice(index, 1);
                    progressed = true;
                }

                if (!progressed) {
                    throw new ImportValidationError('Invalid custom tag hierarchy in import data');
                }
            }

            // 3. 预加载所有需要的 tags（批量查询，避免 N+1）
            const allTagNames = new Set<string>();
            for (const item of body.errorItems) {
                if (item.tags) {
                    for (const tag of item.tags) {
                        allTagNames.add(tag.name);
                    }
                }
            }
            // 批量查询：系统 tag + 所有用户的自定义 tag
            const preloadedTags = await tx.knowledgeTag.findMany({
                where: {
                    name: { in: Array.from(allTagNames) },
                    OR: [
                        { isSystem: true },
                        ...(importAll ? [] : [{ userId: user.id }]),
                    ],
                },
            });
            const tagNameMap = new Map<string, string>();
            const tagIdentityKey = (subject: string, name: string) => `${subject}\u0000${name}`;
            for (const tag of preloadedTags) {
                const key = tagIdentityKey(tag.subject, tag.name);
                if (!tagNameMap.has(key) || (!importAll && tag.userId === user.id)) {
                    tagNameMap.set(key, tag.id);
                }
            }

            // 4. 导入 error items
            const errorItemIdMap = new Map<string, string>();
            for (const item of body.errorItems) {
                const mappedUserId = importAll ? targetUserId(item.userId) : user.id;
                const newSubjectId = item.subjectId ? subjectIdMap.get(item.subjectId) : undefined;
                const sourceSubject = item.subjectId
                    ? body.subjects.find((subject) => subject.id === item.subjectId)
                    : undefined;
                if (item.subjectId && !sourceSubject) {
                    throw new ImportValidationError('Error item references an unknown subject');
                }
                if (sourceSubject && sourceSubject.userId !== item.userId) {
                    throw new ImportValidationError('Error item references another user\'s subject');
                }

                // 去重：同一用户 + 同一科目 + 相同题目文本视为重复
                if (item.questionText) {
                    const existing = await tx.errorItem.findFirst({
                        where: {
                            userId: mappedUserId,
                            subjectId: newSubjectId || null,
                            questionText: item.questionText,
                        },
                    });
                    if (existing) {
                        // 跳过重复，但记录 ID 映射（后续 reviewSchedule 可能需要）
                        errorItemIdMap.set(item.id, existing.id);
                        continue;
                    }
                }

                const created = await tx.errorItem.create({
                    data: {
                        userId: mappedUserId,
                        subjectId: newSubjectId || undefined,
                        originalImageUrl: item.originalImageUrl || '',
                        ocrText: item.ocrText,
                        questionText: item.questionText,
                        answerText: item.answerText,
                        analysis: item.analysis,
                        wrongAnswerText: item.wrongAnswerText,
                        mistakeAnalysis: item.mistakeAnalysis,
                        mistakeStatus: item.mistakeStatus,
                        knowledgePoints: item.knowledgePoints,
                        geogebraCommands: item.geogebraCommands,
                        source: item.source,
                        errorType: item.errorType,
                        userNotes: item.userNotes,
                        masteryLevel: safeMasteryLevel(item.masteryLevel),
                        gradeSemester: item.gradeSemester,
                        paperLevel: item.paperLevel,
                        createdAt: safeParseDate(item.createdAt),
                    },
                });
                errorItemIdMap.set(item.id, created.id);
                stats.errorItemsCreated++;

                // 关联 tags
                if (item.tags && item.tags.length > 0) {
                    const tagConnections: { id: string }[] = [];
                    for (const tag of item.tags) {
                        if (tagIdMap.has(tag.id)) {
                            const sourceTag = body.customTags.find((candidate) => candidate.id === tag.id);
                            if (sourceTag && sourceTag.userId !== item.userId) {
                                throw new ImportValidationError('Error item references another user\'s custom tag');
                            }
                            tagConnections.push({ id: tagIdMap.get(tag.id)! });
                        } else {
                            const fallbackTagId = tagNameMap.get(tagIdentityKey(tag.subject, tag.name));
                            if (fallbackTagId) tagConnections.push({ id: fallbackTagId });
                        }
                    }

                    if (tagConnections.length > 0) {
                        await tx.errorItem.update({
                            where: { id: created.id },
                            data: {
                                tags: { connect: tagConnections },
                            },
                        });
                        stats.tagsLinked += tagConnections.length;
                    }
                }
            }

            // 5. 导入 review schedules
            for (const schedule of (body.reviewSchedules || [])) {
                const newErrorItemId = errorItemIdMap.get(schedule.errorItemId);
                if (newErrorItemId) {
                    const scheduledFor = safeParseDate(schedule.scheduledFor);
                    if (scheduledFor) {
                        // 去重：同一 errorItem + 相同 scheduledFor 视为重复
                        const existingSchedule = await tx.reviewSchedule.findFirst({
                            where: {
                                errorItemId: newErrorItemId,
                                scheduledFor,
                            },
                        });
                        if (existingSchedule) continue;

                        await tx.reviewSchedule.create({
                            data: {
                                errorItemId: newErrorItemId,
                                scheduledFor,
                                completedAt: safeParseDate(schedule.completedAt),
                                isCorrect: schedule.isCorrect,
                            },
                        });
                        stats.reviewSchedulesCreated++;
                    }
                }
            }

            // 6. 导入 practice records
            for (const record of (body.practiceRecords || [])) {
                const mappedUserId = importAll ? targetUserId(record.userId) : user.id;
                await tx.practiceRecord.create({
                    data: {
                        userId: mappedUserId,
                        subject: record.subject,
                        difficulty: record.difficulty,
                        isCorrect: record.isCorrect,
                        createdAt: safeParseDate(record.createdAt),
                    },
                });
                stats.practiceRecordsCreated++;
            }
        }, {
            timeout: 60000,
        });

        logger.info({
            userId: user.id,
            scope: importAll ? 'all' : 'user',
            ...stats,
        }, 'Data import completed');

        return NextResponse.json({
            success: true,
            stats,
        });
    } catch (error) {
        if (error instanceof ImportValidationError) {
            return badRequest(error.message);
        }
        logger.error({ error, userId: user.id }, 'Import failed');
        return internalError("Failed to import data");
    }
}
