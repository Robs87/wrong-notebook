/**
 * /api/practice/check 集成测试
 * 验证举一反三答案判分：AI 主路径 + 异常降级到本地兜底 + 入参校验。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
    mockAIService: {
        judgeAnswer: vi.fn(),
    },
    mockSession: {
        user: { id: 'user-123', email: 'user@example.com', name: 'Test User' },
        expires: '2025-12-31',
    },
}));

vi.mock('@/lib/ai', () => ({
    getAIService: vi.fn(() => mocks.mockAIService),
}));

vi.mock('next-auth', () => ({
    getServerSession: vi.fn(() => Promise.resolve(mocks.mockSession)),
}));

vi.mock('@/lib/auth', () => ({
    authOptions: {},
}));

import { POST as CHECK_POST } from '@/app/api/practice/check/route';
import { getServerSession } from 'next-auth';

describe('POST /api/practice/check', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getServerSession).mockResolvedValue(mocks.mockSession);
    });

    const validBody = {
        questionText: '求解 x + 2 = 5',
        standardAnswer: 'x = 3',
        answerKey: '3',
        studentAnswer: '3',
        language: 'zh',
    };

    function makeRequest(overrides: Record<string, unknown> = {}) {
        return new Request('http://localhost/api/practice/check', {
            method: 'POST',
            body: JSON.stringify({ ...validBody, ...overrides }),
            headers: { 'Content-Type': 'application/json' },
        });
    }

    it('AI 主路径判对时返回 isCorrect=true 且 judgedBy=ai', async () => {
        mocks.mockAIService.judgeAnswer.mockResolvedValue({
            isCorrect: true,
            reason: '学生答案与标准答案一致',
            judgedBy: 'ai',
        });

        const res = await CHECK_POST(makeRequest());
        const data = await res.json();

        expect(res.status).toBe(200);
        expect(data.isCorrect).toBe(true);
        expect(data.judgedBy).toBe('ai');
        expect(mocks.mockAIService.judgeAnswer).toHaveBeenCalledWith(expect.objectContaining({
            questionText: '求解 x + 2 = 5',
            answerKey: '3',
            studentAnswer: '3',
            language: 'zh',
        }));
    });

    it('AI 能识别语义等价（1/2 ≈ 0.5）—— 这是本次改造的核心目标', async () => {
        mocks.mockAIService.judgeAnswer.mockResolvedValue({
            isCorrect: true,
            reason: '0.5 与 1/2 数值相等',
            judgedBy: 'ai',
        });

        const res = await CHECK_POST(makeRequest({ standardAnswer: '$\\frac{1}{2}$', studentAnswer: '0.5' }));
        const data = await res.json();

        expect(res.status).toBe(200);
        expect(data.isCorrect).toBe(true);
    });

    it('AI 抛错时降级到本地兜底，返回 judgedBy=fallback', async () => {
        mocks.mockAIService.judgeAnswer.mockRejectedValue(new Error('AI_TIMEOUT_ERROR'));

        const res = await CHECK_POST(makeRequest());
        const data = await res.json();

        expect(res.status).toBe(200);
        // 本地兜底：学生答案 "3" 与 answerKey "3" 命中
        expect(data.isCorrect).toBe(true);
        expect(data.judgedBy).toBe('fallback');
    });

    it('AI 抛错且本地也判错时，兜底返回 false 而非崩溃', async () => {
        mocks.mockAIService.judgeAnswer.mockRejectedValue(new Error('boom'));
        const res = await CHECK_POST(makeRequest({ studentAnswer: '999' }));
        const data = await res.json();
        expect(res.status).toBe(200);
        expect(data.isCorrect).toBe(false);
        expect(data.judgedBy).toBe('fallback');
    });

    it('缺少 questionText 返回 400', async () => {
        const res = await CHECK_POST(makeRequest({ questionText: '' }));
        expect(res.status).toBe(400);
        expect(mocks.mockAIService.judgeAnswer).not.toHaveBeenCalled();
    });

    it('缺少 studentAnswer 返回 400', async () => {
        const res = await CHECK_POST(makeRequest({ studentAnswer: '' }));
        expect(res.status).toBe(400);
    });

    it('studentAnswer 超长返回 400 且不调用 AI', async () => {
        // MAX_STUDENT_ANSWER = 2000，构造超长答案触发长度上限
        const res = await CHECK_POST(makeRequest({ studentAnswer: 'a'.repeat(2001) }));
        expect(res.status).toBe(400);
        expect(mocks.mockAIService.judgeAnswer).not.toHaveBeenCalled();
    });

    it('answerKey 超长返回 400', async () => {
        // MAX_ANSWER_KEY = 500
        const res = await CHECK_POST(makeRequest({ answerKey: 'k'.repeat(501) }));
        expect(res.status).toBe(400);
        expect(mocks.mockAIService.judgeAnswer).not.toHaveBeenCalled();
    });

    it('answerKey 为非字符串且 AI 抛错时，应返回 200 fallback 而非 500', async () => {
        // 回归：旧 fallback 把原始 answerKey 直接传给 judgeAnswerLocally，
        // 非字符串（number/object/array）会使其内部对候选项调用 .trim() 时
        // 抛 TypeError → 被外层 catch 捕获 → 返回 500。净化后应正常降级。
        mocks.mockAIService.judgeAnswer.mockRejectedValue(new Error('AI_DOWN'));
        const res = await CHECK_POST(makeRequest({ answerKey: 123 }));
        const data = await res.json();
        expect(res.status).toBe(200);
        expect(data.judgedBy).toBe('fallback');
        expect(typeof data.isCorrect).toBe('boolean');
    });

    it('answerKey 缺失也能判分（回退 standardAnswer）', async () => {
        mocks.mockAIService.judgeAnswer.mockResolvedValue({
            isCorrect: false,
            reason: '不一致',
            judgedBy: 'ai',
        });
        const res = await CHECK_POST(makeRequest({ answerKey: undefined }));
        const data = await res.json();
        expect(res.status).toBe(200);
        // 应以 undefined 传给 aiService（而非空字符串）
        expect(mocks.mockAIService.judgeAnswer).toHaveBeenCalledWith(expect.objectContaining({
            answerKey: undefined,
        }));
        expect(data.isCorrect).toBe(false);
    });

    it('未登录返回 401', async () => {
        vi.mocked(getServerSession).mockResolvedValue(null);
        const res = await CHECK_POST(makeRequest());
        expect(res.status).toBe(401);
    });
});
