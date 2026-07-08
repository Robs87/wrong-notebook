
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { internalError, unauthorized, forbidden, badRequest } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { compare } from "bcryptjs";

const logger = createLogger('api:admin:system-reset');

// 确认口令需匹配的预期字符串（防误触/无脑重放）
const CONFIRM_STRING = 'RESET ALL DATA';

export async function POST(request: Request) {
    const session = await getServerSession(authOptions);

    if (!session || !session.user) {
        return unauthorized();
    }

    // Strictly enforce Admin role
    if (session.user.role !== 'admin') {
        return forbidden("Admin access required for system reset");
    }

    const userId = session.user.id;
    if (!userId) {
        return unauthorized();
    }

    try {
        // 二次认证：要求请求体携带当前 admin 的口令 + 确认字符串，
        // 防止仅凭一个（可能已过期的）admin token 即可一键清库。
        const body = await request.json().catch(() => null);
        const password = typeof body?.password === 'string' ? body.password : '';
        const confirm = typeof body?.confirm === 'string' ? body.confirm : '';

        if (!password) {
            return badRequest("Password confirmation required");
        }
        if (confirm !== CONFIRM_STRING) {
            return badRequest(`Confirmation string must be exactly: ${CONFIRM_STRING}`);
        }

        // 校验口令
        const admin = await prisma.user.findUnique({
            where: { id: userId },
            select: { password: true, email: true },
        });
        if (!admin) {
            return unauthorized();
        }
        const passwordOk = await compare(password, admin.password);
        if (!passwordOk) {
            logger.warn({ userId }, 'System reset password confirmation failed');
            return forbidden("Password confirmation failed");
        }

        logger.info({ email: admin.email }, 'System reset initiated (password confirmed)');

        await prisma.$transaction(async (tx) => {
            // 1. Delete Practice Records
            await tx.practiceRecord.deleteMany({});

            // 2. Delete Error Items
            await tx.errorItem.deleteMany({});

            // 3. Delete Subjects (Notebooks)
            await tx.subject.deleteMany({});

            // 4. Delete Custom Tags (keep system tags)
            await tx.knowledgeTag.deleteMany({
                where: {
                    isSystem: false,
                }
            });

            // 5. Delete other users, protect the current admin
            await tx.user.deleteMany({
                where: {
                    id: { not: userId },
                }
            });
        });

        logger.info('System reset completed successfully');
        return NextResponse.json({ success: true, message: "System reset complete" });
    } catch (error) {
        logger.error({ error }, 'System reset error');
        return internalError("Failed to reset system");
    }
}
