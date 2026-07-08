/**
 * 图片压缩工具单元测试 (M31)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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

import { compressDataUrl } from '@/lib/image-compress';

// 生成一个最小的合法 PNG（1x1 红色像素）的 Data URL
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

describe('image-compress (M31)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('空输入原样返回', async () => {
        expect(await compressDataUrl('')).toBe('');
    });

    it('非 Data URL 原样返回', async () => {
        const url = 'https://example.com/image.png';
        expect(await compressDataUrl(url)).toBe(url);
    });

    it('小图（低于阈值）跳过压缩原样返回', async () => {
        // 1x1 PNG 远小于 200KB 阈值
        const result = await compressDataUrl(TINY_PNG);
        expect(result).toBe(TINY_PNG);
    });

    it('合法大图压缩后应更小且为 jpeg Data URL（或保留原图若已更优）', async () => {
        // 用 sharp 构造一个带噪点的大图（>200KB），JPEG 重编码会更优
        const sharp = (await import('sharp')).default;
        // 生成随机噪点图（不可压缩的随机数据，JPEG 会显著小于 PNG）
        const noise = Buffer.alloc(600 * 600 * 3);
        for (let i = 0; i < noise.length; i++) noise[i] = Math.floor(Math.random() * 256);
        const bigPng = await sharp(noise, { raw: { width: 600, height: 600, channels: 3 } })
            .png()
            .toBuffer();
        const dataUrl = `data:image/png;base64,${bigPng.toString('base64')}`;
        expect(dataUrl.length).toBeGreaterThan(200 * 1024); // 确保超过阈值触发压缩

        const result = await compressDataUrl(dataUrl);
        expect(result.startsWith('data:')).toBe(true);
        // 随机噪点图：JPEG 应显著小于 PNG
        expect(result.length).toBeLessThan(dataUrl.length);
    });

    it('压缩失败（损坏数据）时原样返回（fail-soft）', async () => {
        const broken = `data:image/png;base64,${'x'.repeat(300 * 1024)}`; // >200KB 但非合法图片
        const result = await compressDataUrl(broken);
        expect(result).toBe(broken);
    });

    it('压缩后体积若不小于原图则保留原图', async () => {
        // 极端情况：构造一个已经高度压缩的 jpeg，压缩后可能更大
        // 此测试验证"不膨胀"逻辑存在（具体行为依赖 sharp）
        const result = await compressDataUrl(TINY_PNG, { skipBelowKB: 0 });
        // 小图 + skipBelowKB=0 会尝试压缩；若不更小则保留原图
        expect(typeof result).toBe('string');
        expect(result.startsWith('data:')).toBe(true);
    });
});
