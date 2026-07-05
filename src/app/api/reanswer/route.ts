import { NextResponse } from "next/server";
import { getAIService } from "@/lib/ai";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { badRequest, createErrorResponse, ErrorCode, forbidden, unauthorized } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";

const logger = createLogger('api:reanswer');

export async function POST(req: Request) {
    logger.info('Reanswer API called');

    const session = await getServerSession(authOptions);

    // 认证检查
    if (!session?.user) {
        logger.warn('Unauthorized access attempt');
        return unauthorized();
    }

    try {
        const body = await req.json();
        const { questionText, language = 'zh', subject, subjectId, imageBase64, gradeSemester } = body;
        let userId: string | undefined = session.user.id;

        if (!userId && session.user.email) {
            const user = await prisma.user.findUnique({
                where: { email: session.user.email },
                select: { id: true },
            });
            userId = user?.id;
        }

        if (!userId) {
            return unauthorized();
        }

        // 从数据库获取原始科目名（与 analyze/route.ts 保持一致的逻辑）
        let resolvedSubject = subject;
        if (subjectId) {
            try {
                const subjectRecord = await prisma.subject.findUnique({
                    where: { id: subjectId }
                });
                if (!subjectRecord || subjectRecord.userId !== userId) {
                    return forbidden("Not authorized to access this subject");
                }
                if (subjectRecord) {
                    resolvedSubject = subjectRecord.name;
                }
            } catch (dbErr) {
                logger.warn({ subjectId, dbErr }, 'Failed to fetch subject by ID, falling back to request subject');
            }
        }

        logger.debug({
            questionLength: questionText?.length,
            language,
            subject: resolvedSubject,
            hasImage: !!imageBase64,
            gradeSemester
        }, 'Reanswer request received');

        if (!questionText || questionText.trim().length === 0) {
            logger.warn('Missing question text');
            return badRequest("Missing question text");
        }

        const aiService = getAIService();

        // 根据是否有图片选择不同的重新解题方式
        const result = await aiService.reanswerQuestion(questionText, language, resolvedSubject, imageBase64, gradeSemester);

        logger.info('Reanswer successful');

        return NextResponse.json(result);
    } catch (error: unknown) {
        const errorMessageFromError = error instanceof Error ? error.message : String(error);
        const stack = error instanceof Error ? error.stack : undefined;
        logger.error({ error: errorMessageFromError, stack }, 'Reanswer error occurred');

        let errorMessage = errorMessageFromError || "Failed to reanswer question";

        if (errorMessageFromError.includes('AI_AUTH_ERROR')) {
            errorMessage = 'AI_AUTH_ERROR';
        } else if (errorMessageFromError === 'AI_CONNECTION_FAILED') {
            errorMessage = 'AI_CONNECTION_FAILED';
        } else if (errorMessageFromError === 'AI_RESPONSE_ERROR') {
            errorMessage = 'AI_RESPONSE_ERROR';
        }

        return createErrorResponse(errorMessage, 500, ErrorCode.AI_ERROR);
    }
}
