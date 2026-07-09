// Re-export the Zod-validated type from schema.ts
export type { ParsedQuestionFromSchema as ParsedQuestion } from './schema';
import type { ParsedQuestionFromSchema } from './schema';

// Import and re-export MistakeStatus from the single source of truth
import type { MistakeStatus } from '../mistake-status';
export type { MistakeStatus };

export type DifficultyLevel = 'easy' | 'medium' | 'hard' | 'harder';

export interface ReanswerQuestionResult {
    answerText: string;
    analysis: string;
    knowledgePoints: string[];
    wrongAnswerText: string;
    mistakeAnalysis: string;
    mistakeStatus: MistakeStatus;
}

export interface GeogebraAnalysisResult {
    suitable: boolean;
    commands: string[];
    description: string;
}

/**
 * AI 答案判分结果。
 * - isCorrect: 学生答案是否正确
 * - reason: 判定理由（展示给用户）
 * - judgedBy: 'ai' 表示由 LLM 判定，'fallback' 表示本地兜底（AI 不可用/异常时）
 */
export interface JudgeAnswerResult {
    isCorrect: boolean;
    reason: string;
    judgedBy: 'ai' | 'fallback';
}

export interface AIService {
    analyzeImage(imageBase64: string, mimeType?: string, language?: 'zh' | 'en', grade?: 7 | 8 | 9 | 10 | 11 | 12 | null, subject?: string | null, gradeSemester?: string | null): Promise<ParsedQuestionFromSchema>;
    generateSimilarQuestion(originalQuestion: string, knowledgePoints: string[], language?: 'zh' | 'en', difficulty?: DifficultyLevel, gradeSemester?: string | null, subject?: string | null): Promise<ParsedQuestionFromSchema>;
    reanswerQuestion(questionText: string, language?: 'zh' | 'en', subject?: string | null, imageBase64?: string, gradeSemester?: string | null): Promise<ReanswerQuestionResult>;
    analyzeForGeogebra(questionText: string, answerText: string, analysis: string): Promise<GeogebraAnalysisResult>;
    /**
     * 用 LLM 判定学生答案是否与标准答案语义等价。
     * 调用方负责在 AI 异常/超时时走本地兜底（见 judge.ts）。
     */
    judgeAnswer(params: {
        questionText: string;
        standardAnswer: string;
        answerKey?: string;
        studentAnswer: string;
        language?: 'zh' | 'en';
    }): Promise<JudgeAnswerResult>;
}

export interface AIConfig {
    apiKey?: string;
    baseUrl?: string;
    model?: string;
    // Azure OpenAI 特有字段
    azureDeployment?: string;   // Azure 部署名称
    azureApiVersion?: string;   // API 版本 (如 2024-02-15-preview)
}
