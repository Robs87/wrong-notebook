import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { getAIService } from "@/lib/ai";
import { badRequest, internalError, unauthorized } from "@/lib/api-errors";
import { judgeAnswerLocally } from "@/lib/ai/judge";
import { createLogger } from "@/lib/logger";

const logger = createLogger('api:practice:check');

/**
 * 举一反三答案判分接口。
 *
 * 第一性原理：判分必须以"语义等价"为准（1/2 ≈ 0.5 ≈ $\frac{1}{2}$），
 * 这只有 LLM 能可靠完成。因此主路径调用 aiService.judgeAnswer。
 * 但 AI 可能超时/配额耗尽/返回不可解析结果——此时不能让用户"判分失败"，
 * 而是用 judge.ts 的本地兜底给一个尽力而为的结果（judgedBy='fallback'）。
 *
 * 安全说明：questionText / standardAnswer / answerKey / studentAnswer 均由
 * 客户端提交，来自当前页面状态——它们**可以**被客户端构造或篡改，并非不可伪造。
 * 因此服务端仍需做防御性校验（非空 + 长度上限，见下方），并在进 prompt 前一律
 * 围栏化（fenceUserContent），防止 prompt injection 与伪造的结构化标签干扰解析。
 * answerKey 仅作为"语义判分"的提示，不作为可信真值来源。
 */

// 输入长度上限：questionText/standardAnswer 是题目与解析富文本，允许较长；
// answerKey 是机器可判的极简答案，应很短；studentAnswer 为学生作答。
// 超限直接 400，既防御滥用，也避免 prompt 过长。
const MAX_QUESTION_TEXT = 8000;
const MAX_STANDARD_ANSWER = 4000;
const MAX_ANSWER_KEY = 500;
const MAX_STUDENT_ANSWER = 2000;

export async function POST(req: Request) {
    const session = await getServerSession(authOptions);

    if (!session?.user) {
        return unauthorized("Authentication required");
    }

    try {
        const body = await req.json();
        const { questionText, standardAnswer, answerKey, studentAnswer, language } = body || {};

        // 入参校验：题目/标准答案/学生答案缺一不可
        if (!questionText || typeof questionText !== 'string' || !questionText.trim()) {
            return badRequest("questionText is required");
        }
        if (!standardAnswer || typeof standardAnswer !== 'string' || !standardAnswer.trim()) {
            return badRequest("standardAnswer is required");
        }
        if (!studentAnswer || typeof studentAnswer !== 'string' || !studentAnswer.trim()) {
            return badRequest("studentAnswer is required");
        }

        // answerKey 可选，且客户端可能传成任意类型（number/object/array…）。
        // 统一净化为 string | undefined：避免非字符串进 fallback 的
        // judgeAnswerLocally（其内部会对候选项调用 .trim()）而抛错导致 500。
        const safeAnswerKey = typeof answerKey === 'string' ? answerKey : undefined;

        // 长度上限校验：超限直接拒绝，不进 AI 链路
        if (questionText.length > MAX_QUESTION_TEXT) {
            return badRequest(`questionText 长度超过上限 ${MAX_QUESTION_TEXT}`);
        }
        if (standardAnswer.length > MAX_STANDARD_ANSWER) {
            return badRequest(`standardAnswer 长度超过上限 ${MAX_STANDARD_ANSWER}`);
        }
        if (studentAnswer.length > MAX_STUDENT_ANSWER) {
            return badRequest(`studentAnswer 长度超过上限 ${MAX_STUDENT_ANSWER}`);
        }
        if (safeAnswerKey && safeAnswerKey.length > MAX_ANSWER_KEY) {
            return badRequest(`answerKey 长度超过上限 ${MAX_ANSWER_KEY}`);
        }

        const lang: 'zh' | 'en' = language === 'en' ? 'en' : 'zh';

        const aiService = getAIService();
        try {
            const result = await aiService.judgeAnswer({
                questionText,
                standardAnswer,
                answerKey: safeAnswerKey,
                studentAnswer,
                language: lang,
            });
            return NextResponse.json(result);
        } catch (aiError) {
            // AI 主路径失败：降级到本地兜底，保证用户始终能看到判定结果
            const reason = aiError instanceof Error ? aiError.message : String(aiError);
            logger.warn({ reason }, 'AI judge failed, falling back to local judge');
            const isCorrect = judgeAnswerLocally(studentAnswer, standardAnswer, safeAnswerKey);
            return NextResponse.json({
                isCorrect,
                reason: lang === 'zh' ? 'AI 判分暂不可用，已使用本地兜底判定' : 'AI judging unavailable, used local fallback',
                judgedBy: 'fallback' as const,
            });
        }
    } catch (error) {
        logger.error({ error }, 'Error checking answer');
        return internalError("Failed to check answer");
    }
}
