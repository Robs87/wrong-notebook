import OpenAI from "openai";
import type { ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions";
import { AIService, ParsedQuestion, DifficultyLevel, AIConfig, ReanswerQuestionResult, GeogebraAnalysisResult, JudgeAnswerResult } from "./types";
import { generateAnalyzePrompt, generateSimilarQuestionPrompt, generateGeogebraPrompt, generateJudgeAnswerPrompt, parseJudgeResponse, resolvePromptTemplate } from './prompts';
import { getAppConfig } from '../config';
import { safeParseParsedQuestion } from './schema';
import { getMathTagsFromDB, getTagsFromDB } from './tag-service';
import { createLogger } from '../logger';
import { normalizeMistakeStatusForSave } from '../mistake-status';
import { extractResponseText, extractTag, parseJsonLoose, recoverAnalysisFromAnswerText } from './response-parser';
import { assertTrustedBaseUrl } from '../url-safety';

const logger = createLogger('ai:openai');

type OpenAIUserContent = string | Array<
    { type: "text"; text: string } |
    { type: "image_url"; image_url: { url: string } }
>;

type OpenAIMessage = {
    role: string;
    content: unknown;
};

type CompletionResponseLike = {
    choices: Array<{
        message?: unknown;
    }>;
};

type OpenAIClientContext = {
    client: OpenAI;
    model: string;
    baseURL: string;
    apiKey: string;
    isLongCat: boolean;
    label: string;
};

type OpenAIRequestOptions = {
    signal: AbortSignal;
    timeout: number;
};

type AttemptControl = OpenAIRequestOptions & {
    didTimeout: () => boolean;
    cleanup: () => void;
};

// 一次原始请求 + 一次重试；请求失败后才切换同模型备用实例。
// 保持有界，避免上游长时间挂起时把一次用户操作放大成无限等待。
const MAX_TRANSIENT_ATTEMPTS = 2;
const RETRY_DELAY_MS = 250;
const REQUEST_DEADLINE_BUFFER_MS = 5000;
// 视觉模型通常需要先完成图片编码/理解，再开始生成。不能因为配置了多个
// fallback 就把 active 的首次请求预切成十几秒；总 deadline 仍是硬上限。
const MIN_VISION_ATTEMPT_TIMEOUT_MS = 60_000;

const RETRYABLE_STATUS_CODES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
// 这些状态不适合在同一实例上重复请求，但切换到用户配置的另一实例仍有意义：
// 例如 active 渠道余额耗尽（402）、密钥失效（401）或模型只在某个网关开放（404）。
const FAILOVER_STATUS_CODES = new Set([401, 402, 403, 404, ...RETRYABLE_STATUS_CODES]);

function getErrorStatus(error: unknown): number | undefined {
    if (!isRecord(error)) return undefined;
    if (typeof error.status === 'number') return error.status;
    if (isRecord(error.response) && typeof error.response.status === 'number') {
        return error.response.status;
    }
    return undefined;
}

function getErrorText(error: unknown): string {
    const messages: string[] = [];
    let current: unknown = error;
    for (let depth = 0; depth < 3 && current; depth += 1) {
        if (current instanceof Error) {
            messages.push(current.message);
            current = current.cause;
        } else if (isRecord(current)) {
            if (typeof current.message === 'string') messages.push(current.message);
            current = current.cause;
        } else {
            break;
        }
    }
    return messages.join(' ').toLowerCase();
}

function isTransientError(error: unknown): boolean {
    const status = getErrorStatus(error);
    if (status !== undefined) return RETRYABLE_STATUS_CODES.has(status);

    const message = getErrorText(error);
    return /connection error|fetch failed|network|aborted|abort|econnreset|econnrefused|enotfound|eai_again|etimedout|socket hang up|timed out|timeout|\b(?:408|409|425|429|500|502|503|504)\b/.test(message);
}

function isFailoverError(error: unknown): boolean {
    const status = getErrorStatus(error);
    if (status !== undefined) return FAILOVER_STATUS_CODES.has(status);

    const message = getErrorText(error);
    return isTransientError(error) || /unauthorized|forbidden|not found|payment required|insufficient|quota|balance/.test(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

export class OpenAIProvider implements AIService {
    private model: string;
    private baseURL: string;
    private requestTimeoutMs: number;
    private clientContexts: OpenAIClientContext[];
    private visionClientContexts: OpenAIClientContext[];

    constructor(
        config?: AIConfig,
        fallbackConfigs: AIConfig[] = [],
        visionFallbackConfigs: AIConfig[] = [],
    ) {
        // 从全局配置读取单次 AI 调用的超时上限，避免上游挂起导致请求无限阻塞
        const appConfig = getAppConfig();
        this.requestTimeoutMs = appConfig?.timeouts?.analyze || 180000;

        const primaryCandidate = this.createClientContext(config, true);
        if (!primaryCandidate) {
            throw new Error("AI_AUTH_ERROR: OPENAI_API_KEY is required for OpenAI provider");
        }
        const primary = primaryCandidate;
        const fallbacks = fallbackConfigs
            .map((candidate) => this.createClientContext(candidate, false))
            .filter((candidate): candidate is OpenAIClientContext => candidate !== null);
        this.clientContexts = [primary, ...fallbacks];
        const visionFallbacks = visionFallbackConfigs
            .map((candidate) => this.createClientContext(candidate, false))
            .filter((candidate): candidate is OpenAIClientContext => candidate !== null);
        this.visionClientContexts = [...this.clientContexts, ...visionFallbacks];

        // 保留主实例字段用于日志；实际请求由 withTransientRetry() 按主实例
        // → 同模型备用实例执行。
        this.model = primary.model;
        this.baseURL = primary.baseURL;

        logger.info({
            provider: 'OpenAI',
            model: this.model,
            baseURL: this.baseURL,
            timeoutMs: this.requestTimeoutMs,
            hasKey: true,
            fallbackCount: this.clientContexts.length - 1,
            visionFallbackCount: this.visionClientContexts.length - this.clientContexts.length,
        }, 'AI Provider initialized');
    }

    private createClientContext(config: AIConfig | undefined, primary: boolean): OpenAIClientContext | null {
        const apiKey = config?.apiKey;
        if (!apiKey) {
            if (primary) {
                throw new Error("AI_AUTH_ERROR: OPENAI_API_KEY is required for OpenAI provider");
            }
            logger.warn({ instance: config?.name || config?.id || 'unnamed' }, 'Skipping OpenAI fallback without API key');
            return null;
        }

        const baseURL = config?.baseUrl;
        const trustedBaseUrl = assertTrustedBaseUrl(baseURL || 'https://api.openai.com/v1');
        if (!trustedBaseUrl.ok) {
            if (primary) {
                throw new Error(`AI_CONFIG_ERROR: unsafe OpenAI base URL (${trustedBaseUrl.error})`);
            }
            logger.warn({ instance: config?.name || config?.id || 'unnamed', reason: trustedBaseUrl.error }, 'Skipping unsafe OpenAI fallback');
            return null;
        }

        const origin = trustedBaseUrl.origin!;
        const client = new OpenAI({
            apiKey,
            baseURL: origin,
            // SDK retries are disabled so retry/failover remains explicit, bounded,
            // and covered by this provider's regression tests.
            timeout: this.requestTimeoutMs,
            maxRetries: 0,
            defaultHeaders: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            },
        });

        return {
            client,
            model: config?.model || 'gpt-4o',
            baseURL: origin,
            apiKey,
            isLongCat: origin.includes('longcat.chat'),
            label: config?.name || config?.id || origin,
        };
    }

    private async withTransientRetry<T>(
        operation: string,
        request: (context: OpenAIClientContext, options: OpenAIRequestOptions) => Promise<T>,
        contexts: OpenAIClientContext[] = this.clientContexts,
        minimumAttemptTimeoutMs = 0,
    ): Promise<T> {
        let lastError: unknown;
        // 前端也会在 analyzeTimeoutMs 后中止请求。为避免服务端继续在浏览器
        // 已经放弃后重试，预留一个小缓冲，让 API 有机会返回准确的错误类型。
        const deadline = Date.now() + Math.max(
            1,
            this.requestTimeoutMs - Math.min(
                REQUEST_DEADLINE_BUFFER_MS,
                Math.max(1, Math.floor(this.requestTimeoutMs / 10)),
            ),
        );

        for (let contextIndex = 0; contextIndex < contexts.length; contextIndex += 1) {
            const context = contexts[contextIndex];

            for (let attempt = 1; attempt <= MAX_TRANSIENT_ATTEMPTS; attempt += 1) {
                const attemptsRemaining =
                    (contexts.length - contextIndex) * MAX_TRANSIENT_ATTEMPTS - (attempt - 1);
                const control = this.createAttemptControl(
                    deadline,
                    attemptsRemaining,
                    minimumAttemptTimeoutMs,
                );
                if (!control) {
                    throw this.createTimeoutError(lastError);
                }

                try {
                    return await request(context, control);
                } catch (error) {
                    lastError = error;
                    const transient = control.didTimeout() || isTransientError(error);
                    // OpenAI-compatible网关常用 400 表示“当前模型不支持该媒体/模型名
                    // 不存在”。只有图片请求拥有跨模型候选时才继续尝试，避免普通文本
                    // 请求把真正的参数错误静默转给另一个同模型实例。
                    const crossModelVisionFailover = contexts.length > this.clientContexts.length;
                    const failoverEligible = control.didTimeout() || isFailoverError(error) ||
                        (crossModelVisionFailover && getErrorStatus(error) === 400);
                    const budgetRemaining = deadline - Date.now();
                    const canRetry = transient && attempt < MAX_TRANSIENT_ATTEMPTS && budgetRemaining > 0;
                    const canFailover = failoverEligible && contextIndex < contexts.length - 1 && budgetRemaining > 0;

                    if (!canRetry && !canFailover) {
                        if (control.didTimeout() || budgetRemaining <= 0) {
                            throw this.createTimeoutError(error);
                        }
                        throw error;
                    }

                    logger.warn({
                        operation,
                        instance: context.label,
                        model: context.model,
                        attempt,
                        status: getErrorStatus(error),
                        timeoutMs: control.timeout,
                        remainingMs: Math.max(0, budgetRemaining),
                        action: canRetry ? 'retry' : 'failover',
                    }, 'Transient AI request failure');

                    if (canRetry) {
                        const delayMs = RETRY_DELAY_MS * attempt;
                        if (Date.now() + delayMs >= deadline) {
                            if (canFailover) {
                                break;
                            }
                            throw this.createTimeoutError(error);
                        }
                        await new Promise((resolve) => setTimeout(resolve, delayMs));
                    } else {
                        // 当前实例的最后一次尝试失败后立即切换备用实例。
                        break;
                    }
                } finally {
                    control.cleanup();
                }
            }
        }

        if (Date.now() >= deadline) {
            throw this.createTimeoutError(lastError);
        }
        throw lastError instanceof Error ? lastError : new Error('AI request failed');
    }

    private createAttemptControl(
        deadline: number,
        attemptsRemaining: number,
        minimumTimeoutMs = 0,
    ): AttemptControl | null {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) return null;

        const controller = new AbortController();
        const fairShare = Math.floor(remainingMs / Math.max(1, attemptsRemaining));
        const timeout = Math.min(
            remainingMs,
            Math.max(1, fairShare, minimumTimeoutMs),
        );
        let didTimeout = false;
        const timeoutId = setTimeout(() => {
            didTimeout = true;
            controller.abort();
        }, timeout);

        return {
            signal: controller.signal,
            timeout,
            didTimeout: () => didTimeout,
            cleanup: () => clearTimeout(timeoutId),
        };
    }

    private createTimeoutError(cause?: unknown): Error {
        const error = new Error('AI_TIMEOUT_ERROR: AI request deadline exceeded');
        if (cause !== undefined) {
            error.cause = cause;
        }
        return error;
    }

    private adaptMessagesForLongCat(messages: OpenAIMessage[]): OpenAIMessage[] {
        return messages.map(msg => {
            if (typeof msg.content === 'string') {
                return { ...msg, content: [{ type: 'text', text: msg.content }] };
            }
            if (Array.isArray(msg.content)) {
                const adapted = msg.content.map((part) => {
                    if (isRecord(part) && part.type === 'image_url' && isRecord(part.image_url) && typeof part.image_url.url === 'string') {
                        return {
                            type: 'input_image',
                            input_image: { data: [part.image_url.url], type: 'url' }
                        };
                    }
                    return part;
                });
                return { ...msg, content: adapted };
            }
            return msg;
        });
    }

    private parseResponse(text: string): ParsedQuestion {
        logger.debug({ textLength: text.length }, 'Parsing AI response');

        const questionText = extractTag(text, "question_text");
        const answerKey = extractTag(text, "answer_key") || "";
        const answerText = extractTag(text, "answer_text");
        const analysis = extractTag(text, "analysis");
        const subjectRaw = extractTag(text, "subject");
        const knowledgePointsRaw = extractTag(text, "knowledge_points");
        const requiresImageRaw = extractTag(text, "requires_image");
        const wrongAnswerText = extractTag(text, "wrong_answer_text") || "";
        const mistakeAnalysis = extractTag(text, "mistake_analysis") || "";
        const mistakeStatusRaw = extractTag(text, "mistake_status");

        // analysis 缺失补救：推理模型常把答案+解析全塞进 <answer_text> 而漏掉
        // <analysis> 开标签。尝试从 answer_text 拆分出解析内容，避免整体解析失败。
        const recovered = recoverAnalysisFromAnswerText(answerText, analysis);
        const finalAnswerText = recovered.answerText;
        const finalAnalysis = recovered.analysis;
        const analysisWasRecovered = recovered.recovered;

        // Basic Validation - require answer and analysis, questionText is optional
        // (reanswer template doesn't output <question_text>)
        if (!finalAnswerText || !finalAnalysis) {
            logger.error({ rawTextSample: text.substring(0, 500), analysisWasRecovered }, 'Missing critical XML tags');
            // 消息须含 "parse" 关键字，使 handleError 正确归类为 AI_RESPONSE_ERROR
            // 而非 AI_UNKNOWN_ERROR（旧消息缺少可识别关键词，被误报为未知错误）
            throw new Error("AI_RESPONSE_ERROR: failed to parse AI output, missing/malformed XML tags (<answer_text> or <analysis>)");
        }

                // Process Subject
                let subject: ParsedQuestion['subject'] = '其他';
                const validSubjects: ParsedQuestion['subject'][] = ["数学", "物理", "化学", "生物", "英语", "语文", "历史", "地理", "政治", "其他"];
                if (subjectRaw && (validSubjects as string[]).includes(subjectRaw)) {
                    subject = subjectRaw as ParsedQuestion['subject'];
                }

                // Process Knowledge Points
                let knowledgePoints: string[] = [];
                if (knowledgePointsRaw) {
                    knowledgePoints = knowledgePointsRaw.split(/[,，\n]/).map(k => k.trim()).filter(k => k.length > 0);
                }

                // Process requiresImage
                const requiresImage = requiresImageRaw?.toLowerCase().trim() === 'true';
                const mistakeStatus = normalizeMistakeStatusForSave(mistakeStatusRaw, wrongAnswerText);

                // Default questionText to empty string if not present (reanswer scenario)
                const safeQuestionText = questionText || "";

                // Construct Result
                const result: ParsedQuestion = {
                    questionText: safeQuestionText,
                    answerText: finalAnswerText,
                    analysis: finalAnalysis,
                    wrongAnswerText,
                    mistakeAnalysis,
                    mistakeStatus,
                    subject,
                    knowledgePoints,
                    requiresImage,
                    // answerKey 仅 similar 模板会产出；其他场景为空字符串，schema 允许 undefined
                    ...(answerKey ? { answerKey } : {}),
                };

        // Final Schema Validation (just to be safe, though likely compliant by now)
        const validation = safeParseParsedQuestion(result);
        if (validation.success) {
            logger.debug('Validated successfully via XML tags');
            return validation.data;
        } else {
            logger.warn({ validationError: validation.error.format() }, 'Schema validation warning');
            // We still return it as we trust our extraction more than the schema at this point (or we can throw)
            // Let's return the extracted data to be permissive
            return result;
        }
    }

    async analyzeImage(imageBase64: string, mimeType: string = "image/jpeg", language: 'zh' | 'en' = 'zh', grade?: 7 | 8 | 9 | 10 | 11 | 12 | null, subject?: string | null, gradeSemester?: string | null): Promise<ParsedQuestion> {
        const config = getAppConfig();

        // 从数据库获取各学科标签
        // 如果指定了学科，只获取该学科；否则获取所有学科标签供 AI 判断
        const prefetchedMathTags = (subject === '数学' || !subject) ? await getMathTagsFromDB(grade || null) : [];
        const prefetchedPhysicsTags = (subject === '物理' || !subject) ? await getTagsFromDB('physics') : [];
        const prefetchedChemistryTags = (subject === '化学' || !subject) ? await getTagsFromDB('chemistry') : [];
        const prefetchedBiologyTags = (subject === '生物' || !subject) ? await getTagsFromDB('biology') : [];
        const prefetchedEnglishTags = (subject === '英语' || !subject) ? await getTagsFromDB('english') : [];

        const systemPrompt = generateAnalyzePrompt(language, grade, subject, {
            customTemplate: resolvePromptTemplate(config, 'analyze', subject),
            prefetchedMathTags,
            prefetchedPhysicsTags,
            prefetchedChemistryTags,
            prefetchedBiologyTags,
            prefetchedEnglishTags,
        }, gradeSemester);

        logger.box('🔍 AI Image Analysis Request', {
            provider: 'OpenAI',
            endpoint: `${this.baseURL}/chat/completions`,
            imageSize: `${imageBase64.length} bytes`,
            mimeType,
            model: this.model,
            language,
            grade: grade || 'all'
        });
        logger.box('📝 Full System Prompt', systemPrompt);

        try {
            // 构建请求参数（用于日志显示，图片数据截断）
            const requestParamsForLog = {
                model: this.model,
                messages: [
                    {
                        role: "system",
                        content: systemPrompt
                    },
                    {
                        role: "user",
                        content: [
                            {
                                type: "image_url",
                                image_url: {
                                    url: `data:${mimeType};base64,[...${imageBase64.length} bytes base64 data...]`,
                                },
                            },
                        ],
                    },
                ],
                max_tokens: 8192,
            };

            logger.box('📤 API Request (发送给 AI 的原始请求)', JSON.stringify(requestParamsForLog, null, 2));

            const response = await this.withTransientRetry('image analysis', async (context, requestOptions) => {
                if (context.isLongCat) {
                    // LongCat 使用不同的多模态格式，绕过 SDK 直接请求
                    const messages = this.adaptMessagesForLongCat([
                        { role: "system", content: systemPrompt },
                        {
                            role: "user",
                            content: [
                                {
                                    type: "image_url",
                                    image_url: {
                                        url: `data:${mimeType};base64,${imageBase64}`,
                                    },
                                },
                            ],
                        },
                    ]);

                    const res = await fetch(`${context.baseURL}/chat/completions`, {
                        method: 'POST',
                        redirect: 'error',
                        headers: {
                            'Authorization': `Bearer ${context.apiKey}`,
                            'Content-Type': 'application/json',
                        },
                        signal: requestOptions.signal,
                        body: JSON.stringify({
                            model: context.model,
                            messages,
                            max_tokens: 8192,
                            ...getDisableThinkingBody(),
                        }),
                    });

                    if (!res.ok) {
                        const errBody = await res.text();
                        logger.error({ status: res.status, body: errBody }, 'LongCat API error');
                        throw new Error(`${res.status} status code (${errBody})`);
                    }

                    return await res.json() as CompletionResponseLike;
                }

                const params: ChatCompletionCreateParamsNonStreaming = {
                    model: context.model,
                    messages: [
                        {
                            role: "system",
                            content: systemPrompt
                        },
                        {
                            role: "user",
                            content: [
                                {
                                    type: "image_url",
                                    image_url: {
                                        url: `data:${mimeType};base64,${imageBase64}`,
                                    },
                                },
                            ],
                        },
                    ],
                    // response_format: { type: "json_object" }, // Removing to improve compatibility with 3rd party providers
                    max_tokens: 8192,
                    ...getDisableThinkingBody(),
                };
                return await context.client.chat.completions.create(params, requestOptions) as CompletionResponseLike;
            }, this.visionClientContexts, MIN_VISION_ATTEMPT_TIMEOUT_MS);

            logger.box('📦 Full API Response', JSON.stringify(response, null, 2));

            // 检查响应是否有效
            if (!response || !response.choices || response.choices.length === 0) {
                logger.error({ response: JSON.stringify(response) }, 'Invalid API response - no choices array');
                throw new Error("AI_RESPONSE_ERROR: API returned empty or invalid response");
            }

            const text = extractResponseText(response.choices[0]?.message);

            logger.box('🤖 AI Raw Response', text);

            if (!text) throw new Error("Empty response from AI");
            const parsedResult = this.parseResponse(text);

            logger.box('✅ Parsed & Validated Result', JSON.stringify(parsedResult, null, 2));

            return parsedResult;

        } catch (error) {
            logger.box('❌ Error during AI analysis', {
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined
            });
            this.handleError(error);
            throw error;
        }
    }

    async generateSimilarQuestion(originalQuestion: string, knowledgePoints: string[], language: 'zh' | 'en' = 'zh', difficulty: DifficultyLevel = 'medium', gradeSemester?: string | null, subject?: string | null): Promise<ParsedQuestion> {
        const config = getAppConfig();
        const systemPrompt = generateSimilarQuestionPrompt(language, originalQuestion, knowledgePoints, difficulty, {
            customTemplate: resolvePromptTemplate(config, 'similar', subject)
        }, gradeSemester);
        const userPrompt = `\nOriginal Question: "${originalQuestion}"\nKnowledge Points: ${knowledgePoints.join(", ")}\n    `;

        logger.box('🎯 Generate Similar Question Request', {
            provider: 'OpenAI',
            endpoint: `${this.baseURL}/chat/completions`,
            model: this.model,
            originalQuestion: originalQuestion.substring(0, 100) + '...',
            knowledgePoints: knowledgePoints.join(', '),
            difficulty,
            language
        });
        logger.box('📝 System Prompt', systemPrompt);
        logger.box('📝 User Prompt', userPrompt);

        try {
            const response = await this.withTransientRetry('similar question generation', (context, requestOptions) => {
                const params: ChatCompletionCreateParamsNonStreaming = {
                    model: context.model,
                    messages: [
                        { role: "system", content: systemPrompt },
                        { role: "user", content: userPrompt },
                    ],
                    // response_format: { type: "json_object" }, // Removing to improve compatibility with 3rd party providers
                    max_tokens: 8192,
                    ...getDisableThinkingBody(),
                };
                return context.client.chat.completions.create(params, requestOptions) as Promise<CompletionResponseLike>;
            });

            const text = extractResponseText(response.choices[0]?.message);

            logger.box('🤖 AI Raw Response', text);

            if (!text) throw new Error("Empty response from AI");
            const parsedResult = this.parseResponse(text);

            logger.box('✅ Parsed & Validated Result', JSON.stringify(parsedResult, null, 2));

            return parsedResult;

        } catch (error) {
            logger.box('❌ Error during question generation', {
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined
            });
            this.handleError(error);
            throw error;
        }
    }

    async reanswerQuestion(questionText: string, language: 'zh' | 'en' = 'zh', subject?: string | null, imageBase64?: string, gradeSemester?: string | null): Promise<ReanswerQuestionResult> {
        const { generateReanswerPrompt } = await import('./prompts');
        const config = getAppConfig();
        const customTemplate = resolvePromptTemplate(config, 'reanswer', subject);
        const prompt = generateReanswerPrompt(language, questionText, subject, { customTemplate }, gradeSemester);

        logger.info({
            provider: 'OpenAI',
            endpoint: `${this.baseURL}/chat/completions`,
            model: this.model,
            questionLength: questionText.length,
            subject: subject || 'auto',
            hasImage: !!imageBase64
        }, 'Reanswer Question Request');
        logger.debug({ prompt }, 'Full prompt');

        try {
            // 根据是否有图片构建不同的消息内容
            let userContent: OpenAIUserContent = "请根据上述题目提供答案和解析。";
            if (imageBase64) {
                // 如果有图片，构建多模态消息
                const imageUrl = imageBase64.startsWith('data:') ? imageBase64 : `data:image/jpeg;base64,${imageBase64}`;
                logger.debug({ imageLength: imageUrl.length }, 'Image added to request');
                userContent = [
                    { type: "text", text: "请结合图片和题目描述提供答案和解析。" },
                    { type: "image_url", image_url: { url: imageUrl } }
                ];
            } else {
                logger.debug({ imageBase64Type: typeof imageBase64, hasValue: !!imageBase64 }, 'No image data');
            }

            // 打印请求参数
            const requestParams = {
                model: this.model,
                messages: [
                    { role: "system", content: prompt.substring(0, 200) + "..." },
                    { role: "user", content: typeof userContent === 'string' ? userContent : "[包含图片的多模态消息]" }
                ],
                max_tokens: 8192
            };
            logger.debug({ requestParams }, 'Request parameters');

            const response = await this.withTransientRetry('reanswer question', (context, requestOptions) => {
                const params: ChatCompletionCreateParamsNonStreaming = {
                    model: context.model,
                    messages: [
                        { role: "system", content: prompt },
                        { role: "user", content: userContent }
                    ],
                    max_tokens: 8192,
                    ...getDisableThinkingBody(),
                };
                return context.client.chat.completions.create(params, requestOptions) as Promise<CompletionResponseLike>;
            });

            logger.debug({ response: JSON.stringify(response) }, 'Full API response');

            // 检查响应是否有效
            if (!response || !response.choices || response.choices.length === 0) {
                logger.error({ response: JSON.stringify(response) }, 'Invalid API response - no choices array');
                throw new Error("AI_RESPONSE_ERROR: API returned empty or invalid response");
            }

            const text = extractResponseText(response.choices[0]?.message);

            logger.debug({ rawResponse: text }, 'AI raw response');

            if (!text) throw new Error("Empty response from AI");

            // Use shared parseResponse for consistent tag extraction with analyze flow
            const parsedResult = this.parseResponse(text);

            logger.info('Reanswer parsed successfully');

            return {
                answerText: parsedResult.answerText,
                analysis: parsedResult.analysis,
                knowledgePoints: parsedResult.knowledgePoints,
                wrongAnswerText: parsedResult.wrongAnswerText || "",
                mistakeAnalysis: parsedResult.mistakeAnalysis || "",
                mistakeStatus: parsedResult.mistakeStatus,
            };

        } catch (error) {
            logger.error({ error, stack: error instanceof Error ? error.stack : undefined }, 'Error during reanswer');
            this.handleError(error);
            throw error;
        }
    }

    async judgeAnswer(params: {
        questionText: string;
        standardAnswer: string;
        answerKey?: string;
        studentAnswer: string;
        language?: 'zh' | 'en';
    }): Promise<JudgeAnswerResult> {
        const { questionText, standardAnswer, answerKey, studentAnswer, language = 'zh' } = params;
        const prompt = generateJudgeAnswerPrompt(questionText, standardAnswer, answerKey, studentAnswer, language);

        logger.info({
            provider: 'OpenAI',
            endpoint: `${this.baseURL}/chat/completions`,
            model: this.model,
            studentAnswerLen: studentAnswer.length,
        }, 'Judge Answer Request');

        try {
            const response = await this.withTransientRetry('answer judging', (context, requestOptions) => {
                const params: ChatCompletionCreateParamsNonStreaming = {
                    model: context.model,
                    messages: [
                        { role: "system", content: prompt },
                        { role: "user", content: "请判定学生答案是否正确。" }
                    ],
                    max_tokens: 256,
                    ...getDisableThinkingBody(),
                };
                return context.client.chat.completions.create(params, requestOptions) as Promise<CompletionResponseLike>;
            });

            const text = extractResponseText(response.choices[0]?.message);
            logger.debug({ rawResponse: text }, 'Judge AI raw response');

            if (!text) throw new Error("Empty response from AI");

            const verdict = parseJudgeResponse(text);
            if (!verdict) {
                logger.warn({ rawTextSample: text.substring(0, 300) }, 'Judge verdict unparseable');
                throw new Error("AI_RESPONSE_ERROR: judge verdict unparseable");
            }

            return { isCorrect: verdict.isCorrect, reason: verdict.reason, judgedBy: 'ai' };
        } catch (error) {
            logger.error({ error, stack: error instanceof Error ? error.stack : undefined }, 'Error during answer judging');
            this.handleError(error);
            throw error;
        }
    }

    async analyzeForGeogebra(questionText: string, answerText: string, analysis: string): Promise<GeogebraAnalysisResult> {
        const prompt = generateGeogebraPrompt(questionText, answerText, analysis);

        logger.info({
            provider: 'OpenAI',
            model: this.model,
            questionLength: questionText.length,
        }, 'GeoGebra Analysis Request');

        try {
            const response = await this.withTransientRetry('GeoGebra analysis', (context, requestOptions) => {
                const params: ChatCompletionCreateParamsNonStreaming = {
                    model: context.model,
                    messages: [
                        { role: "system", content: prompt },
                        { role: "user", content: "请分析上述题目并生成 GeoGebra 演示命令。" }
                    ],
                    max_tokens: 4096,
                    ...getDisableThinkingBody(),
                };
                return context.client.chat.completions.create(params, requestOptions) as Promise<CompletionResponseLike>;
            });

            const text = extractResponseText(response.choices[0]?.message);
            logger.debug({ rawResponse: text }, 'GeoGebra AI raw response');

            if (!text) throw new Error("Empty response from AI");

            const parsed = parseJsonLoose(text) as { suitable?: unknown; commands?: unknown; description?: string };

            return {
                suitable: Boolean(parsed.suitable),
                commands: Array.isArray(parsed.commands) ? parsed.commands : [],
                description: parsed.description || "",
            };
        } catch (error) {
            logger.error({ error, stack: error instanceof Error ? error.stack : undefined }, 'Error during GeoGebra analysis');
            this.handleError(error);
            throw error;
        }
    }

    private handleError(error: unknown) {
        logger.error({ error }, 'OpenAI error');
        if (error instanceof Error) {
            const msg = error.message.toLowerCase();
            if (msg.includes('fetch failed') || msg.includes('network') || msg.includes('connect')) {
                throw new Error("AI_CONNECTION_FAILED");
            }
            // 超时错误 (包括 408 Request Timeout)
            if (msg.includes('timeout') || msg.includes('timed out') || msg.includes('aborted') || msg.includes('408')) {
                throw new Error("AI_TIMEOUT_ERROR");
            }
            // 配额/频率限制错误
            if (msg.includes('quota') || msg.includes('额度') || msg.includes('rate limit') || msg.includes('429') || msg.includes('402') || msg.includes('payment required') || msg.includes('insufficient') || msg.includes('balance') || msg.includes('too many')) {
                throw new Error("AI_QUOTA_EXCEEDED");
            }
            // 权限/403 错误
            if (msg.includes('403') || msg.includes('forbidden') || msg.includes('permission')) {
                throw new Error("AI_PERMISSION_DENIED");
            }
            // 资源不存在/404 错误
            if (msg.includes('404') || msg.includes('not found') || msg.includes('does not exist')) {
                throw new Error("AI_NOT_FOUND");
            }
            // 服务器错误 (500/502/503/504)
            if (msg.includes('500') || msg.includes('502') || msg.includes('503') || msg.includes('504') ||
                msg.includes('无可用') || msg.includes('overloaded') || msg.includes('unavailable')) {
                throw new Error("AI_SERVICE_UNAVAILABLE");
            }
            if (msg.includes('invalid json') || msg.includes('parse')) {
                throw new Error("AI_RESPONSE_ERROR");
            }
            if (msg.includes('api key') || msg.includes('unauthorized') || msg.includes('401')) {
                throw new Error("AI_AUTH_ERROR");
            }
        }
        throw new Error("AI_UNKNOWN_ERROR");
    }
}

/**
 * 获取禁用推理模式的 extra_body 参数。
 * 部分 vLLM 推理模型（如 agnes-2.0-flash）默认启用思考模式，
 * 返回冗余的 reasoning_content，徒增延迟和 token 消耗。
 * 通过 chat_template_kwargs.enable_thinking=false 要求服务端跳过推理步骤。
 * 不支持的 provider 会静默忽略此参数，不影响正常请求。
 */
function getDisableThinkingBody(): Record<string, unknown> {
    return {
        chat_template_kwargs: {
            enable_thinking: false,
        },
    };
}
