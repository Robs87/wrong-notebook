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
 * 从文本中提取 XML 风格标签内容。
 * 特殊处理：当 tagName 为 'analysis' 且闭合标签丢失（通常是被 max_tokens 截断），
 * 读取到字符串末尾，避免最后一个标签因截断而解析失败。
 */
export function extractTag(text: string, tagName: string): string | null {
    const startTag = `<${tagName}>`;
    const endTag = `</${tagName}>`;
    const startIndex = text.indexOf(startTag);

    if (startIndex === -1) {
        return null;
    }

    const contentStartIndex = startIndex + startTag.length;
    const endIndex = text.lastIndexOf(endTag);

    // 截断兜底：analysis 标签常出现在最后，闭合标签可能因 max_tokens 丢失
    if (endIndex === -1 && tagName === 'analysis') {
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
