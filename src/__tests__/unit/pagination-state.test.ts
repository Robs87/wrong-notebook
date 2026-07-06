import { describe, expect, it } from 'vitest';
import { parsePageParam, clampPage } from '@/lib/pagination-state';

describe('parsePageParam', () => {
    it('缺省/空值时返回默认页 1', () => {
        expect(parsePageParam(null)).toBe(1);
        expect(parsePageParam(undefined)).toBe(1);
        expect(parsePageParam('')).toBe(1);
        expect(parsePageParam('   ')).toBe(1);
    });

    it('解析合法整数页码（含前后空白）', () => {
        expect(parsePageParam('1')).toBe(1);
        expect(parsePageParam('3')).toBe(3);
        expect(parsePageParam(' 12 ')).toBe(12);
    });

    it('拒绝非法/越界值并回退到默认页', () => {
        expect(parsePageParam('0')).toBe(1);
        expect(parsePageParam('-2')).toBe(1);
        expect(parsePageParam('abc')).toBe(1);
        expect(parsePageParam('3.5')).toBe(1);
        expect(parsePageParam('3abc')).toBe(1);
    });

    it('支持自定义 fallback', () => {
        expect(parsePageParam(null, 5)).toBe(5);
        expect(parsePageParam('bad', 2)).toBe(2);
        expect(parsePageParam('-1', 7)).toBe(7);
    });
});

describe('clampPage', () => {
    it('保持合法页码不变', () => {
        expect(clampPage(2, 5)).toBe(2);
        expect(clampPage(5, 5)).toBe(5);
        expect(clampPage(1, 5)).toBe(1);
    });

    it('超出最大页时裁剪到最大页（删除错题导致总页数变少的场景）', () => {
        expect(clampPage(9, 5)).toBe(5);
        expect(clampPage(6, 5)).toBe(5);
    });

    it('未知最大页时仅保证结果 >= 1', () => {
        expect(clampPage(7)).toBe(7);
        expect(clampPage(7, 0)).toBe(7);
        expect(clampPage(7, undefined)).toBe(7);
    });

    it('非法输入回退到 1', () => {
        expect(clampPage(-3, 5)).toBe(1);
        expect(clampPage(NaN, 5)).toBe(1);
        expect(clampPage(2.9, 5)).toBe(2);
        expect(clampPage(0, 5)).toBe(1);
    });
});
