import { describe, it, expect } from 'vitest';
import { cleanMarkdown } from '@/lib/markdown-utils';

describe('cleanMarkdown', () => {
    describe('LaTeX 文字命令保留(回归测试:粘贴丢字 bug)', () => {
        it('\\text{...} 内的文字应保留,而非被整体删除', () => {
            // 旧版 .replace(/\\text\{.*?\}/g, '') 会把 "则" 一起删掉
            // 现在保留花括号内容,仅去掉命令本身
            expect(cleanMarkdown('$\\text{则 }x=1$')).toBe('则 x=1');
        });

        it('\\mbox{...} 内的文字应保留', () => {
            expect(cleanMarkdown('\\mbox{合力}为0')).toBe('合力为0');
        });

        it('\\text 后带空格也正确', () => {
            expect(cleanMarkdown('\\text { 答案 }')).toBe('答案');
        });

        it('多个 \\text{...} 都保留', () => {
            expect(cleanMarkdown('\\text{当}\\text{x}=\\text{时}')).toBe('当x=时');
        });

        it('回归:不再删除 \\text 内的中文(旧版会返回 "x=1")', () => {
            const result = cleanMarkdown('$\\text{当且仅当} x>0$');
            expect(result).toContain('当且仅当');
        });
    });

    describe('基本 markdown 清洗仍正常', () => {
        it('剥离加粗/斜体标记', () => {
            expect(cleanMarkdown('**加粗**和*斜体*')).toBe('加粗和斜体');
        });

        it('剥离标题标记(strip-markdown 保留段落换行)', () => {
            expect(cleanMarkdown('# 标题\n正文')).toBe('标题\n\n正文');
        });

        it('LaTeX 符号映射', () => {
            expect(cleanMarkdown('$\\times$')).toBe('×');
            expect(cleanMarkdown('$\\frac{1}{2}$')).toBe('1/2');
        });

        it('空输入返回空串', () => {
            expect(cleanMarkdown('')).toBe('');
        });

        it('剥离 $ 定界符', () => {
            expect(cleanMarkdown('$x=1$')).toBe('x=1');
        });
    });
});
