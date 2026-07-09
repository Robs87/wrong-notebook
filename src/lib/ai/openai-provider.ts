import OpenAI from "openai";
import type { ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions";
import { AIService, ParsedQuestion, DifficultyLevel, AIConfig, ReanswerQuestionResult, GeogebraAnalysisResult, JudgeAnswerResult } from "./types";
import { generateAnalyzePrompt, generateSimilarQuestionPrompt, generateGeogebraPrompt, generateJudgeAnswerPrompt, parseJudgeResponse, resolvePromptTemplate } from './prompts';
import { getAppConfig } from '../config';
import { safeParseParsedQuestion } from './schema';
import { getMathTagsFromDB, getTagsFromDB } from './tag-service';
import { createLogger } from '../logger';
import { normalizeMistakeStatusForSave } from '../mistake-status';
import { extractResponseText, extractTag, parseJsonLoose } from './response-parser';

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
    choices?: Array<{
        message?: unknown;
    }>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

export class OpenAIProvider implements AIService {
    private openai: OpenAI;
    private model: string;
    private baseURL: string;
    private apiKey: string;
    private isLongCat: boolean;
    private requestTimeoutMs: number;

    constructor(config?: AIConfig) {
        const apiKey = config?.apiKey;
        const baseURL = config?.baseUrl;

        if (!apiKey) {
            throw new Error("AI_AUTH_ERROR: OPENAI_API_KEY is required for OpenAI provider");
        }

        // 从全局配置读取单次 AI 调用的超时上限，避免上游挂起导致请求无限阻塞
        const appConfig = getAppConfig();
        this.requestTimeoutMs = appConfig?.timeouts?.analyze || 180000;

        this.openai = new OpenAI({
            apiKey: apiKey,
            baseURL: baseURL || undefined,
            // OpenAI SDK 的 timeout 触发后会自动 abort 底层请求
            timeout: this.requestTimeoutMs,
            maxRetries: 0,
            defaultHeaders: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            },
        });

        this.model = config?.model || 'gpt-4o'; // Fallback for safety
        this.baseURL = baseURL || 'https://api.openai.com/v1';
        this.apiKey = apiKey;
        this.isLongCat = this.baseURL.includes('longcat.chat');

        logger.info({
            provider: 'OpenAI',
            model: this.model,
            baseURL: this.baseURL,
            timeoutMs: this.requestTimeoutMs,
            hasKey: true,
        }, 'AI Provider initialized');
    }

    /**
     * 创建带超时的 AbortSignal，用于显式控制 AI 调用时长。
     * 返回 signal 与 cleanup，调用方在 finally 中 clearTimeout 防止泄漏。
     */
    private createTimeoutSignal(): { signal: AbortSignal; timeoutId: NodeJS.Timeout } {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.requestTimeoutMs);
        return { signal: controller.signal, timeoutId };
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

        // Basic Validation
        // Basic Validation - require answer and analysis, questionText is optional
                // (reanswer template doesn't output <question_text>)
                if (!answerText || !analysis) {
                    logger.error({ rawTextSample: text.substring(0, 500) }, 'Missing critical XML tags');
                    throw new Error("Invalid AI response: Missing critical XML tags (<answer_text> or <analysis>)");
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
                    answerText,
                    analysis,
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

            let response: CompletionResponseLike;

            if (this.isLongCat) {
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

                const { signal: longcatSignal, timeoutId: longcatTimeoutId } = this.createTimeoutSignal();
                try {
                    const res = await fetch(`${this.baseURL}/chat/completions`, {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${this.apiKey}`,
                            'Content-Type': 'application/json',
                        },
                        signal: longcatSignal,
                        body: JSON.stringify({
                            model: this.model,
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

                    response = await res.json();
                } finally {
                    clearTimeout(longcatTimeoutId);
                }
            } else {
                const params: ChatCompletionCreateParamsNonStreaming = {
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
                response = await this.openai.chat.completions.create(params);
            }

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
            const params: ChatCompletionCreateParamsNonStreaming = {
                model: this.model,
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: userPrompt },
                ],
                // response_format: { type: "json_object" }, // Removing to improve compatibility with 3rd party providers
                max_tokens: 8192,
                ...getDisableThinkingBody(),
            };
            const response = await this.openai.chat.completions.create(params);

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

            const params: ChatCompletionCreateParamsNonStreaming = {
                model: this.model,
                messages: [
                    { role: "system", content: prompt },
                    { role: "user", content: userContent }
                ],
                max_tokens: 8192,
                ...getDisableThinkingBody(),
            };
            const response = await this.openai.chat.completions.create(params);

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
            const params: ChatCompletionCreateParamsNonStreaming = {
                model: this.model,
                messages: [
                    { role: "system", content: prompt },
                    { role: "user", content: "请判定学生答案是否正确。" }
                ],
                max_tokens: 256,
                ...getDisableThinkingBody(),
            };
            const response = await this.openai.chat.completions.create(params);

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
            const params: ChatCompletionCreateParamsNonStreaming = {
                model: this.model,
                messages: [
                    { role: "system", content: prompt },
                    { role: "user", content: "请分析上述题目并生成 GeoGebra 演示命令。" }
                ],
                max_tokens: 4096,
                ...getDisableThinkingBody(),
            };
            const response = await this.openai.chat.completions.create(params);

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
            if (msg.includes('quota') || msg.includes('额度') || msg.includes('rate limit') || msg.includes('429') || msg.includes('too many')) {
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
