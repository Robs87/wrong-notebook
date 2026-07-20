/**
 * 一建提示词同步 - 纯函数安全模块（无副作用，便于单测）
 * ============================================================
 *
 * 本文件从 sync-yijian-prompts.ts 抽出，故意不 import Prisma / JSON snippet，
 * 以保证安全校验逻辑可被单元测试精确复现。
 *
 * 安全不变量（diffConfigs 必须维护）：
 *   - 只允许一建四科（一建管理/经济/法规/实务）的 analyze/similar/reanswer
 *     三个模板发生新增或替换。
 *   - 任何其他配置字段、任何非一建科目、任何科目对象内额外字段变化，
 *     仍必须被 diffConfigs 拦截并作为差异返回。
 */

// 一建涉及的科目（与 bootstrap-config.js 保持一致）
// 一建考试共 4 个科目，analyze 提示词内置"四科自适应策略"，AI 会按科目自动
// 切换诊断重点，因此四科共用同一套 snippet 模板，无需逐科定制。
export const YIJIAN_SUBJECTS = ['一建管理', '一建经济', '一建法规', '一建实务'];

// bySubject 内允许被同步覆盖的叶子模板键
export const ALLOWED_TEMPLATE_KEYS: readonly string[] = ['analyze', 'similar', 'reanswer'];

// snippet 的类型（与 src/lib/config.ts 的 bySubject 结构对齐）
export interface SubjectPrompts {
    analyze?: string;
    similar?: string;
    reanswer?: string;
}

/**
 * 从镜像 snippet 构造权威 bySubject 模板。
 * 以 snippet 的三份模板填充每个一建科目。纯函数：template 由调用方注入。
 */
export function buildAuthoritativeBySubject(template: SubjectPrompts): Record<string, SubjectPrompts> {
    const result: Record<string, SubjectPrompts> = {};
    for (const subject of YIJIAN_SUBJECTS) {
        result[subject] = {
            analyze: template.analyze,
            similar: template.similar,
            reanswer: template.reanswer,
        };
    }
    return result;
}

/**
 * 深度比较两个 bySubject 的三模板内容是否完全一致。
 */
export function bySubjectEquals(
    a: Record<string, SubjectPrompts> | undefined,
    b: Record<string, SubjectPrompts>,
): boolean {
    if (!a) return false;
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    for (const k of bKeys) {
        if (!a[k]) return false;
        if (a[k]!.analyze !== b[k].analyze) return false;
        if (a[k]!.similar !== b[k].similar) return false;
        if (a[k]!.reanswer !== b[k].reanswer) return false;
    }
    return true;
}

/**
 * 逐字段递归对比两个配置对象，返回差异路径列表（用于安全校验）。
 *
 * 仅一建四科（YIJIAN_SUBJECTS）的 analyze/similar/reanswer 三个叶子被允许
 * 新增或替换，不作为差异上报；其余任何字段差异都会被返回，由调用方决定是否
 * 中止写入。
 *
 * 注意：被允许的只有一建四科的三个模板叶子；非一建科目、科目对象内额外字段、
 * apiKey 等任何其他字段变化都必须被拦截。
 */
export function diffConfigs(a: any, b: any, pathStr = ''): string[] {
    const diffs: string[] = [];

    // 关键：在原始类型短路之前，先特判 prompts.bySubject.<subject> 这一层。
    // 否则"新增整个科目对象"（a=undefined, b=object）会在下面的原始类型分支被
    // 当作一处整体差异上报（undefined !== object），把合法的新增一建科目误判
    // 为非法改动。这里改为按叶子逐键校验。
    // 仅匹配 prompts.bySubject.<subject> 这一层（subject 名不含点）；
    // 更深的叶子路径（如 ...<subject>.analyze）交由下面的原始类型分支处理，
    // 否则正则会把整条尾巴当成科目名而漏掉叶子差异。
    const subjectMatch = pathStr.match(/^prompts\.bySubject\.([^.]+)$/);
    if (subjectMatch) {
        const subject = subjectMatch[1];
        const isYijian = YIJIAN_SUBJECTS.includes(subject);
        // 两端都缺失/为 null：无差异
        if (a == null && b == null) return diffs;
        const aObj = typeof a === 'object' && a !== null ? a : {};
        const bObj = typeof b === 'object' && b !== null ? b : {};
        const allKeys = new Set([...Object.keys(aObj), ...Object.keys(bObj)]);
        for (const k of allKeys) {
            // 仅一建科目的三模板叶子被豁免（允许新增/替换）
            if (isYijian && ALLOWED_TEMPLATE_KEYS.includes(k)) continue;
            // 非一建科目的任何键、或科目对象内额外字段 → 递归对比（必报）
            diffs.push(...diffConfigs(aObj[k], bObj[k], `${pathStr}.${k}`));
        }
        return diffs;
    }

    if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) {
        if (a !== b) diffs.push(`${pathStr}: ${JSON.stringify(a)} → ${JSON.stringify(b)}`);
        return diffs;
    }
    const allKeys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of allKeys) {
        const sub = pathStr ? `${pathStr}.${k}` : k;
        diffs.push(...diffConfigs(a[k], b[k], sub));
    }
    return diffs;
}
