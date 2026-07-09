/**
 * AI 响应解析的共享工具。
 *
 * 第一性原理：三个 provider（OpenAI / Azure / Gemini）解析模型文本输出的逻辑
 * 必须完全一致，否则会出现"换 provider 行为不同"的 bug。历史上：
 *  - 只有 OpenAI 处理了 reasoning_content 拆分（vLLM 推理模型把 XML 放到该字段）
 *  - 只有 OpenAI 处理了 <analysis> 标签被 max_tokens 截断的情况
 *  - GeoGebra 的 JSON 解析都用裸 JSON.parse，截断时直接抛错（jsonrepair 依赖却没用）
 *
 * 这里把三段逻辑统一抽出来，供所有 provider 复用。
 */
import { jsonrepair } from 'jsonrepair';
import { createLogger } from '../logger';

const logger = createLogger('ai:response-parser');

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

/**
 * 从 OpenAI/Gemini 风格的 message 对象中提取有效文本。
 * 兼容推理模型把结构化输出拆到 reasoning_content 字段的情况：
 * 若 content 缺少 <answer_text> 而 reasoning_content 含有，则合并。
 */
export function extractResponseText(message: unknown): string {
    const content = isRecord(message) && typeof message.content === 'string' ? message.content : "";
    const reasoning = isRecord(message) && typeof message.reasoning_content === 'string' ? message.reasoning_content : "";

    if (!content) return reasoning;
    if (!reasoning) return content;

    // content 缺少关键标签 → 推理模型将 XML 拆到了 reasoning_content
    if (!content.includes("<answer_text>") && reasoning.includes("<answer_text>")) {
        logger.warn('content 缺少 <answer_text>，检测到 reasoning_content 拆分，合并两个字段');
        return reasoning + "\n" + content;
    }

    return content;
}

/**
 * 内容型标签集合：这些标签承载长文本（题干/答案/解析），最容易被推理模型
 * 泄漏 CoT 或被 max_tokens 截断导致闭标签丢失。对它们启用「闭标签缺失 →
 * 读到末尾」的兜底，避免整段解析失败。短标签（subject/mistake_status 等）
 * 不在此列，闭标签缺失仍返回 null，避免污染枚举/布尔字段。
 */
const CONTENT_TAGS_WITH_TRUNCATION_FALLBACK = new Set([
    'question_text',
    'answer_text',
    'analysis',
]);

/**
 * 从文本中提取 XML 风格标签内容。
 *
 * 配对策略（关键）：开标签取**最后一个**，闭标签取**其后第一个**。
 *
 * 第一性原理：部分推理模型（如 agnes-2.0-flash）会把自我验算/重新设计的
 * 思考链泄漏进标签内部，产生重复的开标签并把闭标签吞掉，例如：
 *   <answer_text> 让我重新算... <answer_text> 真正答案 </answer_text>
 * 旧实现用「首个开 + 末个闭」会取到从 CoT 起点贯穿到最终答案的错误区间。
 * 改用「末个开 + 其后首个闭」能稳定取到模型**最后定稿**的那一段。
 * 对格式正确的输出（单一开闭标签）行为完全不变。
 *
 * 截断兜底：内容标签（见 CONTENT_TAGS_WITH_TRUNCATION_FALLBACK）的闭标签
 * 缺失时（被 max_tokens 截断或被 CoT 吞掉），读取到字符串末尾，避免
 * 最后一个标签因截断而整体解析失败。
 */
export function extractTag(text: string, tagName: string): string | null {
    const startTag = `<${tagName}>`;
    const endTag = `</${tagName}>`;

    // 开标签取最后一个：跳过模型重复/泄漏的前置同名标签，定位到最终定稿块
    const startIndex = text.lastIndexOf(startTag);

    if (startIndex === -1) {
        return null;
    }

    const contentStartIndex = startIndex + startTag.length;
    // 闭标签取其后第一个：与最后一个开标签正确配对
    const endIndex = text.indexOf(endTag, contentStartIndex);

    // 截断兜底：内容标签闭标签缺失时，读到末尾（被截断或被 CoT 吞掉）
    if (endIndex === -1 && CONTENT_TAGS_WITH_TRUNCATION_FALLBACK.has(tagName)) {
        logger.warn({ tagName }, 'Tag was verified unclosed, treating as truncated and reading to end');
        return text.substring(contentStartIndex).trim();
    }

    if (endIndex === -1 || contentStartIndex >= endIndex) {
        return null;
    }

    return text.substring(contentStartIndex, endIndex).trim();
}

/**
 * 从可能被 markdown 包裹 / 被截断的文本中解析 JSON。
 * 先剥离 ```json 代码块与多余文本，再用 jsonrepair 修复常见截断/语法问题，
 * 最后 JSON.parse。失败则抛出可识别的错误。
 */
export function parseJsonLoose(rawText: string): unknown {
    let jsonStr = rawText.trim();

    // 剥离 markdown 代码块
    const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
        jsonStr = jsonMatch[1].trim();
    }

    // 截取最外层 { ... }
    const objStart = jsonStr.indexOf('{');
    const objEnd = jsonStr.lastIndexOf('}');
    if (objStart !== -1 && objEnd !== -1) {
        jsonStr = jsonStr.substring(objStart, objEnd + 1);
    }

    try {
        return JSON.parse(jsonStr);
    } catch {
        // 裸解析失败：用 jsonrepair 尝试修复（处理截断、尾逗号等）
        try {
            const repaired = jsonrepair(jsonStr);
            return JSON.parse(repaired);
        } catch (repairError) {
            logger.error(
                { repairError: repairError instanceof Error ? repairError.message : String(repairError) },
                'jsonrepair also failed to parse AI JSON output'
            );
            throw new Error("AI_RESPONSE_ERROR: Failed to parse JSON response");
        }
    }
}

/**
 * 当 analysis 标签缺失时，尝试从 answer_text 中拆分出解析内容。
 *
 * 第一性原理：部分推理模型（如 agnes-2.0-flash）会把"答案 + 完整解析"全部
 * 写进 <answer_text>，最后只甩一个孤立的 </analysis>（无开标签）。实测日志
 * 证实这是举一反三 100% 失败的主要形态。解析内容真实存在，只是标签错配。
 *
 * 拆分依据：解析段落通常以解析性标题开头，如「【答案解析】」「逐项分析」
 * 「**逐项/逐条分析**」「变式意图」「解析」等。从首个此类标记处切分：
 *  - 切分点之前 → 保留为 answer_text（含答案核心）
 *  - 切分点及之后 → 作为 analysis
 *
 * 仅当 analysis 缺失且 answer_text 中能识别到解析标记时才执行，否则返回
 * 原样（调用方再决定是否抛错）。answer_text 过短（无解析迹象）时不拆。
 */
const ANALYSIS_SECTION_MARKERS = [
    '【答案解析】',
    '【解析】',
    '**逐项',
    '逐项分析',
    '逐条分析',
    '**解析**',
    '**变式意图',
    '变式意图',
    '\n解析',
];

export interface RecoveredAnswerFields {
    answerText: string;
    analysis: string;
    recovered: boolean; // 是否执行了拆分补救
}

export function recoverAnalysisFromAnswerText(
    answerText: string | null,
    analysis: string | null
): RecoveredAnswerFields {
    // analysis 已存在，无需补救
    if (analysis && analysis.trim()) {
        return { answerText: answerText || '', analysis, recovered: false };
    }
    if (!answerText || !answerText.trim()) {
        return { answerText: answerText || '', analysis: '', recovered: false };
    }

    // 在 answer_text 中定位首个解析段落标记
    let splitIndex = -1;
    for (const marker of ANALYSIS_SECTION_MARKERS) {
        const idx = answerText.indexOf(marker);
        if (idx > 0) {
            // 取最早出现的标记
            if (splitIndex === -1 || idx < splitIndex) splitIndex = idx;
        }
    }

    if (splitIndex === -1) {
        // 无解析标记，无法安全拆分
        return { answerText, analysis: '', recovered: false };
    }

    const recoveredAnalysis = answerText.substring(splitIndex).trim();
    const remainingAnswer = answerText.substring(0, splitIndex).trim();

    // 拆分后 answer_text 不能为空（至少要保留答案核心）
    if (!remainingAnswer) {
        return { answerText, analysis: '', recovered: false };
    }

    logger.warn(
        { markerPos: splitIndex, analysisLen: recoveredAnalysis.length },
        'analysis tag missing; recovered analysis content from answer_text (CoT/misplaced-tag fallback)'
    );

    return {
        answerText: remainingAnswer,
        analysis: recoveredAnalysis,
        recovered: true,
    };
}
