/**
 * 本地判分兜底 judge.ts 单元测试。
 *
 * 重点验证：第一性原理里点名的那些"对判错"场景，在本地兜底里都不再误判。
 * 注意本地兜底覆盖面有限（不做 LaTeX 语义等价），所以这里只断言它能命中的，
 * 不假装它能解决 AI 才能解决的问题。
 */
import { describe, it, expect } from 'vitest';
import { normalizeAnswerForCompare, judgeAnswerLocally } from '@/lib/ai/judge';

describe('normalizeAnswerForCompare', () => {
    it('消除大小写/空白/中英文标点差异', () => {
        expect(normalizeAnswerForCompare('  A.  ')).toBe('a');
        expect(normalizeAnswerForCompare('5。')).toBe('5');
        expect(normalizeAnswerForCompare('x = 5')).toBe('x=5');
        expect(normalizeAnswerForCompare('$\\frac{1}{2}$')).toBe('1/2');
    });

    it('空输入返回空串', () => {
        expect(normalizeAnswerForCompare('')).toBe('');
        expect(normalizeAnswerForCompare('   ')).toBe('');
    });
});

describe('judgeAnswerLocally', () => {
    describe('应该判对 (回归旧 bug 误判的场景)', () => {
        const cases: Array<[string, string, string | undefined, string]> = [
            // [student, standardAnswer, answerKey, desc]
            ['5', '解：x = 5', '5', '有 answerKey 时单字符数字不再因 length>1 兜底失效而判错'],
            ['5.0', '5', undefined, '纯数值等价 5=5.0（本地数值比较，非去小数点后的字符串）'],
            ['b', 'B. 三角形内角和为180°', 'B', '选择题大小写'],
            ['1/2', '$\\frac{1}{2}$', '1/2', '分数与 LaTeX 字面归一'],
        ];
        for (const [student, standard, key, desc] of cases) {
            it(desc, () => {
                expect(judgeAnswerLocally(student, standard, key)).toBe(true);
            });
        }
    });

    describe('应该判错', () => {
        const cases: Array<[string, string, string | undefined, string]> = [
            ['7', 'x = 5', '5', '数值不同'],
            ['d', 'B. xxx', 'B', '选择题选错'],
            ['', '5', '5', '空答案判错而非崩溃'],
            ['xyz', '5', '5', '完全不相关'],
        ];
        for (const [student, standard, key, desc] of cases) {
            it(desc, () => {
                expect(judgeAnswerLocally(student, standard, key)).toBe(false);
            });
        }
    });

    it('answerKey 优先于 standardAnswer', () => {
        // standardAnswer 是富文本，answerKey 是精简值；优先用 answerKey 判
        expect(judgeAnswerLocally('3', '完整答案很长包含无关字符 12', '3')).toBe(true);
    });

    it('不修复旧逻辑的"错判对"假阳回归（子串误命中仍可能残留，这里确认数值场景不误判）', () => {
        // 用户答 7，标准答案是某年份 2017，answerKey 不存在时不应单凭子串判对
        // 注：本地兜底不再有"任意子串判对"逻辑，数值不同即判错
        expect(judgeAnswerLocally('7', '2017年', undefined)).toBe(false);
    });

    it('诚实记录本地兜底的局限：富文本内嵌数字无 answerKey 时本地无法判对（这是 AI 路径的职责）', () => {
        // answerText 是 "解：x = 5"，用户答 "5"，无 answerKey。
        // 本地兜底不做 NLP，无法可靠提取出最终值 5，故判错——
        // 这类场景必须依赖 AI 判分主路径，不应指望本地兜底。
        expect(judgeAnswerLocally('5', '解：x = 5', undefined)).toBe(false);
    });

    describe('LaTeX 命令不应造成假阳性（回归 \\[a-zA-Z]+ 无差别删除的 bug）', () => {
        // 旧逻辑把 \sqrt / \sin / \angle 等命令名直接删掉、只留参数，
        // 于是 \sqrt{2} 塌缩成 2、\sin 30 塌缩成 30、\angle A 塌缩成 A，
        // 与学生的裸值/裸字母误判为相等。本地兜底不评估这些函数，应判错，
        // 语义等价交给 AI 主路径。
        const cases: Array<[string, string, string | undefined, string]> = [
            ['2', '$\\sqrt{2}$', undefined, '\\sqrt{2} 不能塌缩成裸值 2'],
            ['30', '$\\sin 30$', undefined, '\\sin 30 不能塌缩成裸值 30'],
            ['a', '$\\angle A$', undefined, '\\angle A 不能塌缩成裸字母 a'],
        ];
        for (const [student, standard, key, desc] of cases) {
            it(desc, () => {
                expect(judgeAnswerLocally(student, standard, key)).toBe(false);
            });
        }
    });
});
