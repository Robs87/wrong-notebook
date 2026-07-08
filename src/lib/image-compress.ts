/**
 * 服务端图片压缩（M31）。
 *
 * 第一性原理：原图 base64 直存 SQLite 导致 DB 膨胀、列表查询传输巨大 payload。
 * 在入库前用 sharp 统一压缩（缩放 + JPEG 重编码），显著减小存储与传输体积。
 *
 * 失败策略（fail-soft）：非图片/损坏/压缩异常时原样返回，不阻断上传流程——
 * 宁可存稍大的原图，也不让用户上传失败。
 */
import sharp from 'sharp';
import { createLogger } from './logger';

const logger = createLogger('image-compress');

export interface CompressOptions {
    /** 最大宽度（按比例缩放，不放大）。默认 1920。 */
    maxWidth?: number;
    /** JPEG 质量 1-100。默认 80。 */
    quality?: number;
    /** 小于此阈值（KB）则跳过压缩，直接返回原值。默认 200。 */
    skipBelowKB?: number;
}

const DEFAULTS: Required<CompressOptions> = {
    maxWidth: 1920,
    quality: 80,
    skipBelowKB: 200,
};

/**
 * 解析 Data URL，返回 {mime, base64}；非 Data URL 返回 null。
 */
function parseDataUrl(dataUrl: string): { mime: string; base64: string } | null {
    const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) return null;
    return { mime: match[1], base64: match[2] };
}

/**
 * 压缩 Data URL 图片。
 * - 非图片或解析失败 → 原样返回。
 * - 体积已很小 → 原样返回。
 * - 压缩失败 → 原样返回（fail-soft）。
 *
 * 输出统一为 JPEG（照片类内容体积最优）；PNG 透明度会丢失，但错题截图场景可接受。
 */
export async function compressDataUrl(
    dataUrl: string,
    options: CompressOptions = {}
): Promise<string> {
    if (!dataUrl) return dataUrl;

    const opts = { ...DEFAULTS, ...options };
    const parsed = parseDataUrl(dataUrl);
    if (!parsed) return dataUrl; // 非 Data URL，无法压缩

    const inputBuffer = Buffer.from(parsed.base64, 'base64');
    // 体积阈值检查（基于原始 base64 长度近似）
    if (inputBuffer.length < opts.skipBelowKB * 1024) {
        return dataUrl;
    }

    try {
        const compressed = await sharp(inputBuffer)
            .resize({
                width: opts.maxWidth,
                withoutEnlargement: true,
                fit: 'inside',
            })
            .jpeg({ quality: opts.quality, mozjpeg: true })
            .toBuffer();

        // 仅在压缩后更小时采用，否则保留原图（避免对已是高效编码的图反而变大）
        if (compressed.length >= inputBuffer.length) {
            return dataUrl;
        }

        logger.debug(
            { beforeKB: Math.round(inputBuffer.length / 1024), afterKB: Math.round(compressed.length / 1024) },
            'Image compressed'
        );
        return `data:image/jpeg;base64,${compressed.toString('base64')}`;
    } catch (error) {
        logger.warn(
            { error: error instanceof Error ? error.message : String(error) },
            'Image compression failed, keeping original'
        );
        return dataUrl;
    }
}
