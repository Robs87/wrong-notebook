/**
 * docker-entrypoint.sh 结构守卫（静态断言）
 * ============================================================
 *
 * 部署链根因：sync-yijian-prompts.js 曾被放在「版本变化」条件分支内，
 * 但我们常只改代码、不 bump package 版本就发修复镜像。生产 .app_version
 * 已是当前版本 → 拉到修复镜像也不会触发同步 → 警告不会真正消失。
 *
 * 修复：把一建提示词同步移到版本判断之外，每次容器启动都执行（脚本幂等，
 * 已一致时跳过）。系统标签重建 rebuild-system-tags 仍只在版本变化时执行。
 *
 * 本测试以纯文本解析 entrypoint，锁定上述结构不变：
 *   1. 同步调用全局唯一（无重复粘贴）
 *   2. 同步调用位于版本 if 分支【之外】
 *   3. rebuild-system-tags 仍在版本 if 分支【之内】
 *   4. 版本 marker 写入仍在版本 if 分支【之内】（不破坏既有行为）
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const ENTRYPOINT = fs.readFileSync(
    path.resolve(__dirname, '../../../docker-entrypoint.sh'),
    'utf-8',
);

// 从「版本变化 if」起始行起，按 if/fi 配对找到其闭合 fi，返回 [startIdx, fiIdx]（行号）
function findVersionIfBlock(lines: string[]): [number, number] {
    const startIdx = lines.findIndex((l) => l.includes('PREVIOUS_VERSION') && l.includes('CURRENT_VERSION') && /^\s*if\b/.test(l));
    expect(startIdx).toBeGreaterThanOrEqual(0);
    let depth = 0;
    for (let i = startIdx; i < lines.length; i++) {
        if (/^\s*if\b/.test(lines[i])) depth++;
        if (/^\s*fi\b/.test(lines[i])) {
            depth--;
            if (depth === 0) return [startIdx, i];
        }
    }
    throw new Error('未找到版本 if 的闭合 fi');
}

describe('docker-entrypoint.sh - 一建同步调用位置守卫', () => {
    const lines = ENTRYPOINT.split('\n');
    const [ifIdx, fiIdx] = findVersionIfBlock(lines);
    const versionBlock = lines.slice(ifIdx, fiIdx + 1).join('\n');

    it('SYNC_YIJIAN_SCRIPT 调用全局唯一（不重复）', () => {
        const invocations = (ENTRYPOINT.match(/node "\$SYNC_YIJIAN_SCRIPT"/g) || []).length;
        expect(invocations).toBe(1);
    });

    it('SYNC_YIJIAN_SCRIPT 同步位于版本 if 分支之外（每次启动都跑）', () => {
        // 版本分支体内不得包含同步调用
        expect(versionBlock).not.toContain('SYNC_YIJIAN_SCRIPT');
        // 且同步调用行号必须大于版本分支闭合 fi 行号
        const syncLineIdx = lines.findIndex((l) => l.includes('node "$SYNC_YIJIAN_SCRIPT"'));
        expect(syncLineIdx).toBeGreaterThan(fiIdx);
    });

    it('REBUILD_TAGS_SCRIPT 仍在版本 if 分支之内（仅版本变化时执行）', () => {
        expect(versionBlock).toContain('node "$REBUILD_TAGS_SCRIPT"');
        const rebuildCount = (ENTRYPOINT.match(/node "\$REBUILD_TAGS_SCRIPT"/g) || []).length;
        expect(rebuildCount).toBe(1);
    });

    it('VERSION_FILE marker 写入仍在版本 if 分支之内（不破坏 marker 行为）', () => {
        expect(versionBlock).toContain('"$CURRENT_VERSION" > "$VERSION_FILE"');
    });
});
