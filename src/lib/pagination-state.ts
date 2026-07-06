/**
 * 分页页码的 URL 状态工具。
 *
 * 错题列表通过 URL 的 `page` 查询参数保存当前页码，这样：
 * - 进入/返回错题详情时（浏览器后退或路由返回），列表能恢复到上次查看的页；
 * - 避免每次回到列表都被重置到最新/第一页。
 *
 * 这里刻意保持为纯函数，便于单元测试（项目目前没有前端组件级测试基础设施）。
 */

/**
 * 把 URL 中的 `page` 查询参数解析为安全的页码。
 * - 缺省 / 非整数 / 小于 1 时回退到 `fallback`（默认 1）。
 * - 仅接受纯整数，避免 `3.5`、`3abc` 等被静默接受。
 */
export function parsePageParam(raw: string | null | undefined, fallback = 1): number {
    if (raw === null || raw === undefined || raw.trim() === "") return fallback;
    const trimmed = raw.trim();
    if (!/^\d+$/.test(trimmed)) return fallback;
    const n = parseInt(trimmed, 10);
    if (!Number.isFinite(n) || n < 1) return fallback;
    return n;
}

/**
 * 把页码裁剪到合法范围 `[1, maxPage]`。
 * - `maxPage` 缺省或 <= 0 时视为未知，仅保证结果 >= 1。
 * - 用于删除错题导致总页数变少后，避免停留在越界的页码上。
 */
export function clampPage(page: number, maxPage?: number): number {
    const safe = Number.isFinite(page) && page >= 1 ? Math.floor(page) : 1;
    if (maxPage !== undefined && maxPage >= 1) {
        return Math.min(safe, maxPage);
    }
    return safe;
}
