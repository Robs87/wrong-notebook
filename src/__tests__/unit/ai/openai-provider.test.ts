/**
 * OpenAI Provider 单元测试
 *
 * 测试 OpenAI 服务初始化、响应解析和错误处理
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCompletionCreate = vi.hoisted(() => vi.fn());
const mockOpenAIOptions = vi.hoisted(() => vi.fn());

// Mock OpenAI SDK
vi.mock('openai', () => {
    return {
        default: class MockOpenAI {
            constructor(options: unknown) {
                mockOpenAIOptions(options);
            }

            chat = {
                completions: {
                    create: mockCompletionCreate,
                },
            };
        },
    };
});

// Mock logger
vi.mock('@/lib/logger', () => ({
    createLogger: vi.fn(() => ({
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        box: vi.fn(),
        divider: vi.fn(),
    })),
}));

// Mock config
vi.mock('@/lib/config', () => ({
    getAppConfig: vi.fn(() => ({
        aiProvider: 'openai',
        openai: {
            apiKey: 'test-key',
            model: 'gpt-4o',
        },
    })),
}));

// Mock tag service
vi.mock('@/lib/ai/tag-service', () => ({
    getMathTagsFromDB: vi.fn(() => Promise.resolve([])),
    getTagsFromDB: vi.fn(() => Promise.resolve([])),
}));

// Delayed import to ensure mocks are applied
import { OpenAIProvider } from '@/lib/ai/openai-provider';
import type { ParsedQuestion } from '@/lib/ai/types';

type PrivateOpenAIProvider = {
    parseResponse(text: string): ParsedQuestion;
    extractTag(text: string, tagName: string): string | null;
    handleError(error: unknown): never;
};

function asPrivateProvider(provider: OpenAIProvider): PrivateOpenAIProvider {
    return provider as unknown as PrivateOpenAIProvider;
}

describe('OpenAI Provider 响应解析', () => {
    let provider: OpenAIProvider;

    beforeEach(() => {
        vi.clearAllMocks();
        provider = new OpenAIProvider({
            apiKey: 'test-key',
            model: 'gpt-4o',
        });
    });

    describe('parseResponse', () => {
        it('应该正确解析包含所有必需标签的响应', () => {
            const mockResponse = `
<question_text>求函数 f(x) = x^2 的最小值</question_text>
<answer_text>最小值为 0</answer_text>
<analysis>这是一个二次函数,开口向上,顶点在原点,因此最小值为 0</analysis>
<subject>数学</subject>
<knowledge_points>二次函数, 函数最值</knowledge_points>
<requires_image>true</requires_image>
            `.trim();

            const result = asPrivateProvider(provider).parseResponse(mockResponse);

            expect(result.questionText).toBe('求函数 f(x) = x^2 的最小值');
            expect(result.answerText).toBe('最小值为 0');
            expect(result.analysis).toContain('二次函数');
            expect(result.subject).toBe('数学');
            expect(result.knowledgePoints).toContain('二次函数');
            expect(result.knowledgePoints).toContain('函数最值');
            expect(result.requiresImage).toBe(true);
        });

        it('应该解析错因分析相关可选标签', () => {
            const mockResponse = `
<question_text>求 2x + 3 = 7</question_text>
<answer_text>x = 2</answer_text>
<analysis>移项后计算。</analysis>
<wrong_answer_text>x = 4</wrong_answer_text>
<mistake_status>wrong_attempt</mistake_status>
<mistake_analysis>移项后没有正确处理常数项。</mistake_analysis>
            `.trim();

            const result = asPrivateProvider(provider).parseResponse(mockResponse);

            expect(result.wrongAnswerText).toBe('x = 4');
            expect(result.mistakeStatus).toBe('wrong_attempt');
            expect(result.mistakeAnalysis).toContain('常数项');
        });

        it('缺少错因标签时应该兼容旧响应并标记为未判断', () => {
            const mockResponse = `
<question_text>测试题目</question_text>
<answer_text>测试答案</answer_text>
<analysis>测试解析</analysis>
            `.trim();

            const result = asPrivateProvider(provider).parseResponse(mockResponse);

            expect(result.wrongAnswerText).toBe('');
            expect(result.mistakeAnalysis).toBe('');
            expect(result.mistakeStatus).toBe('unknown');
        });

        it('有 wrongAnswerText 时应该强制返回 wrong_attempt 状态', () => {
            const mockResponse = `
<question_text>测试题目</question_text>
<answer_text>测试答案</answer_text>
<analysis>测试解析</analysis>
<wrong_answer_text>错误解答</wrong_answer_text>
<mistake_status>unknown</mistake_status>
            `.trim();

            const result = asPrivateProvider(provider).parseResponse(mockResponse);

            expect(result.wrongAnswerText).toBe('错误解答');
            expect(result.mistakeStatus).toBe('wrong_attempt');
        });

        it('缺少必需标签时应该抛出错误', () => {
            const mockResponse = `
<question_text>测试题目</question_text>
<answer_text>测试答案</answer_text>
            `.trim();

            expect(() => asPrivateProvider(provider).parseResponse(mockResponse)).toThrow('AI_RESPONSE_ERROR');
        });

        it('CoT 泄漏进 answer_text（答案+解析全塞入、analysis 开标签缺失）时应成功解析', () => {
            // 复刻 unraid 实测失败样本：agnes-2.0-flash 把答案和完整解析写进
            // <answer_text>，只甩一个孤立 </analysis>。新逻辑应从 answer_text 拆分补救。
            const mockResponse = [
                '<question_text>流水步距计算题。</question_text>',
                '<answer_key>AB</answer_key>',
                '<answer_text>',
                '【正确答案】AB',
                '【答案解析】',
                '1. 流水步距等于各流水节拍的最大公约数。',
                '2. 专业工作队数为节拍除以步距之和。',
                '</analysis>',
            ].join('\n');

            const result = asPrivateProvider(provider).parseResponse(mockResponse);
            expect(result.questionText).toBe('流水步距计算题。');
            expect(result.answerKey).toBe('AB');
            expect(result.answerText).toBe('【正确答案】AB');
            expect(result.analysis).toContain('【答案解析】');
            expect(result.analysis).toContain('流水步距');
        });

        it('标签名下划线被写成空格（agnes-2.0-flash 实测）时仍应成功解析', () => {
            // 复刻 unraid 2026-07-27 14:40 实测失败样本：模型把 <answer_text>
            // 写成 <answer text>（下划线变空格），旧逻辑直接抛 AI_RESPONSE_ERROR
            // 导致用户看到「AI 返回数据格式异常，请重试。」。修复后应整体走通。
            const mockResponse = [
                '<subject>其他</subject>',
                '<knowledge_points>1Z304050 监督督管理</knowledge_points>',
                '<requires_image>false</requires_image>',
                '<question_text>87、政府对工程质量监督管理的内容包括（）。</question_text>',
                '<answer text>正确答案：ADE</answer_text>',
                '<wrong_answer_text></wrong_answer_text>',
                '<mistake_status>not_attempted</mistake_status>',
                '<mistake_analysis>预判错因为审题混淆。</mistake_analysis>',
                '<analysis>依据《建设工程质量管理条例》的详细解析。</analysis>',
            ].join('\n');

            const result = asPrivateProvider(provider).parseResponse(mockResponse);
            expect(result.subject).toBe('其他');
            expect(result.questionText).toContain('工程质量监督管理');
            expect(result.answerText).toBe('正确答案：ADE');
            expect(result.analysis).toContain('建设工程质量管理条例');
            expect(result.mistakeStatus).toBe('not_attempted');
            expect(result.requiresImage).toBe(false);
        });
    });
});

describe('OpenAI Provider 实例级代理', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('配置 proxyUrl 时只为该 OpenAI client 注入 dispatcher', () => {
        new OpenAIProvider({
            apiKey: 'test-key',
            baseUrl: 'https://api.openai.com/v1',
            model: 'test-model',
            proxyUrl: 'http://proxy.example.com:7890',
        });

        const options = mockOpenAIOptions.mock.calls.at(-1)?.[0] as {
            fetchOptions?: { dispatcher?: unknown };
        } | undefined;

        expect(options?.fetchOptions?.dispatcher).toBeDefined();
    });

    it('未配置 proxyUrl 时保持直连，不设置 dispatcher', () => {
        new OpenAIProvider({
            apiKey: 'test-key',
            baseUrl: 'https://api.openai.com/v1',
            model: 'test-model',
        });

        const options = mockOpenAIOptions.mock.calls.at(-1)?.[0] as {
            fetchOptions?: { dispatcher?: unknown };
        } | undefined;

        expect(options?.fetchOptions).toBeUndefined();
    });
});

describe('OpenAI Provider 重新解题错因同步', () => {
    let provider: OpenAIProvider;

    beforeEach(() => {
        vi.clearAllMocks();
        provider = new OpenAIProvider({
            apiKey: 'test-key',
            model: 'gpt-4o',
        });
    });

    it('重新解题应该返回新的错因字段，供前端覆盖旧错因', async () => {
        mockCompletionCreate.mockResolvedValueOnce({
            choices: [{
                message: {
                    content: `
<answer_text>x = 2</answer_text>
<analysis>两边同时减 3，再除以 2。</analysis>
<knowledge_points>一元一次方程</knowledge_points>
<wrong_answer_text>x = 4</wrong_answer_text>
<mistake_status>wrong_attempt</mistake_status>
<mistake_analysis>把 7 - 3 算错了。</mistake_analysis>
                    `.trim(),
                },
            }],
        });

        const result = await provider.reanswerQuestion('求解 2x + 3 = 7', 'zh', '数学');

        expect(result.answerText).toBe('x = 2');
        expect(result.knowledgePoints).toEqual(['一元一次方程']);
        expect(result.wrongAnswerText).toBe('x = 4');
        expect(result.mistakeStatus).toBe('wrong_attempt');
        expect(result.mistakeAnalysis).toContain('算错');
    });

    it('重新解题缺少错因标签时应该返回默认值', async () => {
        mockCompletionCreate.mockResolvedValueOnce({
            choices: [{
                message: {
                    content: `
<answer_text>x = 2</answer_text>
<analysis>移项计算。</analysis>
<knowledge_points>一元一次方程</knowledge_points>
                    `.trim(),
                },
            }],
        });

        const result = await provider.reanswerQuestion('求解 2x + 3 = 7', 'zh', '数学');

        expect(result.answerText).toBe('x = 2');
        expect(result.wrongAnswerText).toBe('');
        expect(result.mistakeAnalysis).toBe('');
        expect(result.mistakeStatus).toBe('unknown');
    });
});

describe('OpenAI Provider 错误处理', () => {
    let provider: OpenAIProvider;

    beforeEach(() => {
        vi.clearAllMocks();
        provider = new OpenAIProvider({
            apiKey: 'test-key',
            model: 'gpt-4o',
        });
    });

    it('连接异常后应自动重试并恢复分析请求', async () => {
        mockCompletionCreate
            .mockRejectedValueOnce(new Error('Connection error.'))
            .mockResolvedValueOnce({
                choices: [{
                    message: {
                        content: '<question_text>Q</question_text><answer_text>A</answer_text><analysis>An</analysis><subject>数学</subject>',
                    },
                }],
            });

        const result = await provider.analyzeImage('base64data');

        expect(result.questionText).toBe('Q');
        expect(mockCompletionCreate).toHaveBeenCalledTimes(2);
        const firstRequestOptions = mockCompletionCreate.mock.calls[0]?.[1] as {
            signal?: AbortSignal;
            timeout?: number;
        } | undefined;
        expect(firstRequestOptions?.signal).toBeDefined();
        // 超时是整次 AI 操作的预算切片，而不是给每次重试重复 180 秒。
        expect(firstRequestOptions?.timeout).toBeGreaterThan(80_000);
        expect(firstRequestOptions?.timeout).toBeLessThan(180_000);
    });

    it('多个视觉候选时不应预先均分 active 首次请求预算', async () => {
        provider = new OpenAIProvider(
            { apiKey: 'primary-key', baseUrl: 'https://api.openai.com/v1', model: 'vision-primary', name: 'primary' },
            [],
            [
                { apiKey: 'fallback-1', baseUrl: 'https://api.openai.com/v1', model: 'vision-1', name: 'vision-1' },
                { apiKey: 'fallback-2', baseUrl: 'https://api.openai.com/v1', model: 'vision-2', name: 'vision-2' },
                { apiKey: 'fallback-3', baseUrl: 'https://api.openai.com/v1', model: 'vision-3', name: 'vision-3' },
                { apiKey: 'fallback-4', baseUrl: 'https://api.openai.com/v1', model: 'vision-4', name: 'vision-4' },
            ],
        );
        mockCompletionCreate.mockResolvedValueOnce({
            choices: [{
                message: {
                    content: '<question_text>Q</question_text><answer_text>A</answer_text><analysis>An</analysis><subject>数学</subject>',
                },
            }],
        });

        await provider.analyzeImage('base64data');

        const firstRequestOptions = mockCompletionCreate.mock.calls[0]?.[1] as { timeout?: number } | undefined;
        // SiliconFlow 等视觉模型需要完整的单请求窗口；不能因为候选尚未发生就只给约 17 秒。
        expect(firstRequestOptions?.timeout).toBeGreaterThanOrEqual(60_000);
    });

    it('主实例重试耗尽后应切换到备用实例', async () => {
        provider = new OpenAIProvider(
            { apiKey: 'primary-key', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o', name: 'primary' },
            [{ apiKey: 'fallback-key', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o', name: 'fallback' }],
        );
        mockCompletionCreate
            .mockRejectedValueOnce(new Error('Connection error.'))
            .mockRejectedValueOnce(new Error('Connection error.'))
            .mockResolvedValueOnce({
                choices: [{
                    message: {
                        content: '<question_text>Q</question_text><answer_text>A</answer_text><analysis>An</analysis><subject>数学</subject>',
                    },
                }],
            });

        const result = await provider.analyzeImage('base64data');

        expect(result.questionText).toBe('Q');
        expect(mockCompletionCreate).toHaveBeenCalledTimes(3);
    });

    it('图片分析在同模型备用耗尽后才切换到显式配置的跨模型视觉备用', async () => {
        provider = new OpenAIProvider(
            { apiKey: 'primary-key', baseUrl: 'https://api.openai.com/v1', model: 'agnes-2.5-pro', name: 'primary' },
            [{ apiKey: 'same-model-key', baseUrl: 'https://api.openai.com/v1', model: 'agnes-2.5-pro', name: 'same-model' }],
            [{ apiKey: 'vision-key', baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4', model: 'vision-model', name: 'vision-fallback' }],
        );
        mockCompletionCreate
            .mockRejectedValueOnce(new Error('502 Upstream request failed'))
            .mockRejectedValueOnce(new Error('502 Upstream request failed'))
            .mockRejectedValueOnce(new Error('502 Upstream request failed'))
            .mockRejectedValueOnce(new Error('502 Upstream request failed'))
            .mockResolvedValueOnce({
                choices: [{
                    message: {
                        content: '<question_text>Q</question_text><answer_text>A</answer_text><analysis>An</analysis><subject>数学</subject>',
                    },
                }],
            });

        const result = await provider.analyzeImage('base64data');

        expect(result.questionText).toBe('Q');
        expect(mockCompletionCreate).toHaveBeenCalledTimes(5);
        expect(mockCompletionCreate.mock.calls[4]?.[0]?.model).toBe('vision-model');
    });

    it('active 渠道返回 402 时应直接切换备用，而不是在余额耗尽的渠道上重试', async () => {
        provider = new OpenAIProvider(
            { apiKey: 'primary-key', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o', name: 'primary' },
            [{ apiKey: 'fallback-key', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o', name: 'fallback' }],
        );
        const paymentRequired = Object.assign(new Error('402 Payment Required'), { status: 402 });
        mockCompletionCreate
            .mockRejectedValueOnce(paymentRequired)
            .mockResolvedValueOnce({
                choices: [{
                    message: {
                        content: '<question_text>Q</question_text><answer_text>A</answer_text><analysis>An</analysis><subject>数学</subject>',
                    },
                }],
            });

        const result = await provider.analyzeImage('base64data');

        expect(result.questionText).toBe('Q');
        expect(mockCompletionCreate).toHaveBeenCalledTimes(2);
    });

    it('跨模型视觉备用遇到网关 400 时应继续尝试下一个已配置实例', async () => {
        provider = new OpenAIProvider(
            { apiKey: 'primary-key', baseUrl: 'https://api.openai.com/v1', model: 'primary-model', name: 'primary' },
            [],
            [
                { apiKey: 'invalid-model-key', baseUrl: 'https://api.openai.com/v1', model: 'invalid-model', name: 'invalid-model' },
                { apiKey: 'vision-key', baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4', model: 'vision-model', name: 'vision-fallback' },
            ],
        );
        const invalidModel = Object.assign(new Error('400 model not found'), { status: 400 });
        mockCompletionCreate
            .mockRejectedValueOnce(new Error('502 Upstream request failed'))
            .mockRejectedValueOnce(new Error('502 Upstream request failed'))
            .mockRejectedValueOnce(invalidModel)
            .mockResolvedValueOnce({
                choices: [{
                    message: {
                        content: '<question_text>Q</question_text><answer_text>A</answer_text><analysis>An</analysis><subject>数学</subject>',
                    },
                }],
            });

        const result = await provider.analyzeImage('base64data');

        expect(result.questionText).toBe('Q');
        expect(mockCompletionCreate).toHaveBeenCalledTimes(4);
        expect(mockCompletionCreate.mock.calls[3]?.[0]?.model).toBe('vision-model');
    });

    describe('handleError', () => {
        it('应该将网络错误转换为 AI_CONNECTION_FAILED', () => {
            const networkError = new Error('fetch failed');
            expect(() => asPrivateProvider(provider).handleError(networkError)).toThrow('AI_CONNECTION_FAILED');
        });

        it('应该将认证错误转换为 AI_AUTH_ERROR', () => {
            const authError = new Error('Unauthorized: Invalid API key');
            expect(() => asPrivateProvider(provider).handleError(authError)).toThrow('AI_AUTH_ERROR');
        });

        it('应该将 JSON 解析错误转换为 AI_RESPONSE_ERROR', () => {
            const parseError = new Error('Invalid JSON format');
            expect(() => asPrivateProvider(provider).handleError(parseError)).toThrow('AI_RESPONSE_ERROR');
        });

        it('未知错误应该转换为 AI_UNKNOWN_ERROR', () => {
            const unknownError = new Error('Something went wrong');
            expect(() => asPrivateProvider(provider).handleError(unknownError)).toThrow('AI_UNKNOWN_ERROR');
        });
    });
});
