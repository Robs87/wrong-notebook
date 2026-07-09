/**
 * 答案判分的本地兜底实现（纯函数，server / client 通用）。
 *
 * 第一性原理：举一反三的判分主路径是 AI 语义判分（见 AIService.judgeAnswer
 * 与 /api/practice/check）。但 AI 可能超时、配额耗尽或返回不可解析结果，
 * 因此必须有一个"无外部依赖、确定性强、永不抛错"的本地兜底，保证用户
 * 在任何情况下都能看到一个判定结果。
 *
 * 这个兜底无法做到语义等价（那是 AI 的职责），只能覆盖最常见的字面差异：
 * 大小写、空白、中英文标点、括号、LaTeX 定界符、纯数值相等、单选字母。
 * 不要试图在这里穷举 LaTeX / 分数 / 单位等价——那是 over-engineering，
 * 且会让本地路径与 AI 路径产生分歧。
 */

/**
 * 把答案归一化为可比较的最简字符串形式。
 * 刻意保守：只消除"显然的字面差异"，不做语义推断。
 *
 * 注意：此函数会移除小数点等标点，因此"数值相等"判定（5 = 5.0 = +5）
 * 不能依赖本函数的输出，必须在更上游用原始字符串单独做数值比较
 * （见 judgeAnswerLocally 中对原始 userAnswer/answerKey 的 toPureNumber 调用）。
 */
export function normalizeAnswerForCompare(s: string): string {
    if (!s) return '';
    return s
        .toLowerCase()
        // LaTeX 行内/块级定界符 $ $$ 先去掉，避免 $\frac{1}{2}$ 与 1/2 因 $ 不匹配
        .replace(/\${1,2}/g, '')
        // 仅安全还原"明确可比较"的结构：\frac{a}{b} -> a/b
        .replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, '$1/$2')
        // 注意：不要无差别删除 \sqrt / \sin / \cos / \log / \angle 等命令名。
        // 否则 \sqrt{2} 会塌缩成 2、\sin 30 塌缩成 30、\angle A 塌缩成 A，
        // 导致 judgeAnswerLocally('2', '$\sqrt{2}$') 等被判对（假阳性）。
        // 这些命令的语义等价只有 AI 主路径能判，本地保守地保留命令、不归约。
        // 去括号：中英文圆括号、方括号、花括号、书名号
        .replace(/[()[\]{}【】《》]/g, '')
        // 去所有空白（含全角空格 \u3000、换行、制表符）
        .replace(/\s+/g, '')
        // 去常见中英文标点（含小数点；数值相等已在上游单独处理）
        .replace(/[.,;:!?，。；：！？、·]/g, '')
        // 去引号
        .replace(/["'“”‘’「」『』]/g, '')
        .trim();
}

/**
 * 把"保留小数点与正负号"的纯数字字符串解析为数值。
 * 输入需先经 stripForNumber（仅去空白/定界符/前缀文字，保留 . - 和数字），
 * 再用本函数校验是否为合法数值。非纯数字（如 "1/2"、"x=5"）返回 null。
 */
function toPureNumber(s: string): number | null {
    if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
}

/**
 * 把字符串尽量剥成"最像最终数值"的形式，用于数值比较。
 * 保留小数点与负号，去掉 = 前缀、单位、定界符等。
 */
function stripForNumber(s: string): string {
    return s
        .toLowerCase()
        .replace(/\${1,2}/g, '')
        .replace(/\\[a-zA-Z]+/g, '')
        .replace(/[()[\]{}【】《》]/g, '')
        .replace(/\s+/g, '')
        // 去掉常见前缀如 x= / y = / 解：
        .replace(/^[a-z]+=|^解[:：]/, '')
        .replace(/[.,;:!?，。；：！？、·]/g, m => (m === '.' ? '.' : ''))
        .trim();
}

function tryNumber(s: string): number | null {
    // 含 LaTeX 命令（如 \sqrt{2}、\sin 30、\angle A）的字符串无法在本地
    // 归约为纯数值——否则会把"函数的参数"当成最终值，造成 \sqrt{2}→2 的假阳性。
    // 保守返回 null，语义等价交给 AI 主路径判定。
    if (/\\[a-zA-Z]/.test(s)) return null;
    return toPureNumber(stripForNumber(s));
}

/**
 * 本地判分兜底：用户答案与标准答案（或机器可判的 answerKey）是否一致。
 *
 * @param userAnswer    用户输入
 * @param standardAnswer AI 生成的完整答案文本（富文本，用于展示）
 * @param answerKey     AI 生成的"机器可判"极简答案（优先比较，若存在）
 * @returns 是否判对
 */
export function judgeAnswerLocally(
    userAnswer: string,
    standardAnswer: string,
    answerKey?: string
): boolean {
    const u = normalizeAnswerForCompare(userAnswer);
    if (!u) return false;

    // answerKey 优先（它是为判分量身定制的），其次回退到完整答案
    const candidates = [answerKey, standardAnswer].filter(
        (v): v is string => !!v && v.trim().length > 0
    );

    for (const candidate of candidates) {
        const c = normalizeAnswerForCompare(candidate);
        if (!c) continue;

        // 1) 字面相等
        if (u === c) return true;

        // 2) 纯数值相等（5 / 5.0 / +5 / x=5→5）
        //    必须用保留小数点的 stripForNumber，而非已去小数点的 normalizeAnswerForCompare
        const un = tryNumber(userAnswer);
        const cn = tryNumber(candidate);
        if (un !== null && cn !== null && Math.abs(un - cn) < 1e-9) return true;

        // 3) 选择题：用户输入单个 a-d，标准答案（去标点后）以该字母开头
        if (/^[a-d]$/.test(u) && c.startsWith(u)) return true;
    }

    return false;
}
