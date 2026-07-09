/**
 * response-parser 单元测试
 *
 * 重点关注两类修复：
 * 1. extractTag 的「最后一个开标签 + 其后首个闭标签」配对策略，
 *    用于防御推理模型把 CoT 泄漏进标签导致重复开标签 / 闭标签吞掉。
 * 2. recoverAnalysisFromAnswerText 的「analysis 缺失时从 answer_text 拆分」补救。
 * 这两者共同覆盖了 unraid 实测日志中 agnes-2.0-flash 100% 解析失败的形态。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock logger（response-parser 内部有 warn 日志）
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

// Mock jsonrepair（parseJsonLoose 依赖，此处不测 JSON 路径，透传即可）
vi.mock('jsonrepair', () => ({
    jsonrepair: vi.fn((str: string) => str),
}));

import { extractTag, recoverAnalysisFromAnswerText } from '@/lib/ai/response-parser';

describe('extractTag', () => {
    describe('基础提取（回归）', () => {
        it('应正确提取单一标签内容', () => {
            expect(extractTag('<test>content</test>', 'test')).toBe('content');
        });

        it('应去除首尾空白', () => {
            expect(extractTag('<test>  content  </test>', 'test')).toBe('content');
        });

        it('标签不存在时返回 null', () => {
            expect(extractTag('<other>x</other>', 'test')).toBeNull();
        });

        it('应处理多行内容', () => {
            const text = '<test>\nline1\nline2\n</test>';
            expect(extractTag(text, 'test')).toBe('line1\nline2');
        });
    });

    describe('CoT 泄漏容错（核心修复）', () => {
        it('重复开标签时，应取最后一个开标签的内容（跳过泄漏的 CoT）', () => {
            // 模型先输出含思考链的第一块，再输出最终定稿块
            const text = [
                '<answer_text>让我重新算一下... 等等，数据不对',
                '让我重新设计题目...</answer_text>',
                '<answer_text>正确答案：B</answer_text>',
            ].join('\n');
            // 注意：第一块有闭标签，第二块也有。新逻辑取最后开标签 + 其后首个闭。
            const result = extractTag(text, 'answer_text');
            expect(result).toBe('正确答案：B');
        });

        it('开标签缺失（只有孤立闭标签）时返回 null', () => {
            // 实测样本：模型只甩了一个孤立的 </analysis>，没有开标签
            const text = '一些内容\n</analysis>';
            expect(extractTag(text, 'analysis')).toBeNull();
        });
    });

    describe('截断兜底', () => {
        it('analysis 闭标签缺失时读取到末尾（回归）', () => {
            const text = '<analysis>被截断的解析内容';
            expect(extractTag(text, 'analysis')).toBe('被截断的解析内容');
        });

        it('answer_text 闭标签缺失时读取到末尾（新增：内容标签集兜底）', () => {
            const text = '<answer_text>答案内容没有闭合';
            expect(extractTag(text, 'answer_text')).toBe('答案内容没有闭合');
        });

        it('question_text 闭标签缺失时读取到末尾（新增）', () => {
            const text = '<question_text>题干被截断';
            expect(extractTag(text, 'question_text')).toBe('题干被截断');
        });

        it('短标签（如 subject）闭标签缺失时仍返回 null（不启用兜底）', () => {
            // subject 是枚举短标签，闭标签缺失不应读到末尾污染
            const text = '<subject>其他';
            expect(extractTag(text, 'subject')).toBeNull();
        });
    });

    describe('边界情况', () => {
        it('开闭标签顺序倒置（闭在前开在后）返回 null', () => {
            const text = '</test><test>';
            expect(extractTag(text, 'test')).toBeNull();
        });

        it('紧邻的空内容标签（开闭无间隔）返回 null', () => {
            // 新配对策略：最后开标签 + 其后首个闭标签；<test></test> 中
            // 内容起点 == 闭标签起点 → contentStartIndex >= endIndex → null。
            // 实际 AI 不会输出空标签，此为防御性边界。
            expect(extractTag('<test></test>', 'test')).toBeNull();
        });

        it('有空白间隔的标签返回中间内容（含空字符串）', () => {
            expect(extractTag('<test> </test>', 'test')).toBe('');
        });
    });
});

describe('recoverAnalysisFromAnswerText', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('analysis 已存在时，原样返回不拆分', () => {
        const result = recoverAnalysisFromAnswerText('答案AB', '完整解析内容');
        expect(result).toEqual({
            answerText: '答案AB',
            analysis: '完整解析内容',
            recovered: false,
        });
    });

    it('analysis 缺失且 answer_text 无解析标记时，无法拆分', () => {
        const result = recoverAnalysisFromAnswerText('答案：B', null);
        expect(result.recovered).toBe(false);
        expect(result.analysis).toBe('');
        expect(result.answerText).toBe('答案：B');
    });

    it('analysis 缺失且 answer_text 含【答案解析】标记时，正确拆分', () => {
        // 模拟实测失败样本：答案+解析全塞进 answer_text
        const answerText = '【正确答案】AB\n【答案解析】\n1. 流水步距计算...\n2. 工作队数计算...';
        const result = recoverAnalysisFromAnswerText(answerText, null);
        expect(result.recovered).toBe(true);
        expect(result.answerText).toBe('【正确答案】AB');
        expect(result.analysis).toContain('【答案解析】');
        expect(result.analysis).toContain('流水步距计算');
    });

    it('analysis 缺失且 answer_text 含 **解析** 标记时，正确拆分', () => {
        const answerText = '答案：B\n**解析**\n选项B正确因为...';
        const result = recoverAnalysisFromAnswerText(answerText, null);
        expect(result.recovered).toBe(true);
        expect(result.answerText).toBe('答案：B');
        expect(result.analysis).toContain('**解析**');
    });

    it('拆分后若 answer_text 部分为空（标记在最开头），不拆分', () => {
        // 标记在开头，切分后前半段为空 → 不拆分，避免丢答案
        const answerText = '【答案解析】\n只有解析没有答案';
        const result = recoverAnalysisFromAnswerText(answerText, null);
        expect(result.recovered).toBe(false);
    });

    it('answer_text 为空时，原样返回空', () => {
        const result = recoverAnalysisFromAnswerText(null, null);
        expect(result).toEqual({ answerText: '', analysis: '', recovered: false });
    });

    it('取最早出现的解析标记（多个标记时）', () => {
        const answerText = '答案B\n【答案解析】\n第一段解析\n**解析**\n第二段';
        const result = recoverAnalysisFromAnswerText(answerText, null);
        expect(result.recovered).toBe(true);
        expect(result.answerText).toBe('答案B');
        // 应从最早的标记【答案解析】处切分，包含后续全部
        expect(result.analysis).toContain('第一段解析');
        expect(result.analysis).toContain('第二段');
    });
});
