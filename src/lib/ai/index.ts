import { AIService } from "./types";
import { GeminiProvider } from "./gemini-provider";
import { OpenAIProvider } from "./openai-provider";
import { AzureOpenAIProvider } from "./azure-provider";

export * from "./types";

import { getAppConfig, getActiveOpenAIConfig } from "../config";
import { createLogger } from "../logger";

const logger = createLogger('ai');

export function getAIService(): AIService {
    // Always get fresh config
    const config = getAppConfig();
    const provider = config.aiProvider;

    if (provider === "openai") {
        const activeConfig = getActiveOpenAIConfig();
        const activeModel = activeConfig?.model || 'gpt-4o';
        const configuredFallbacks = (config.openai?.instances || []).filter((instance) => (
            instance.id !== activeConfig?.id &&
            !!instance.apiKey
        ));
        // 普通文本操作只在同模型实例之间故障转移，避免改变用户主动选择的模型。
        const fallbackConfigs = configuredFallbacks.filter((instance) => (
            (instance.model || 'gpt-4o') === activeModel
        ));
        // 图片分析是多模态操作：同模型渠道全部不可用时，允许使用用户已经明确
        // 配置的其它 OpenAI-compatible 实例作为最后一级视觉备用。若端点/模型不
        // 支持图片，provider 会将其视为该渠道失败并继续尝试下一个实例。
        const visionFallbackConfigs = configuredFallbacks.filter((instance) => (
            (instance.model || 'gpt-4o') !== activeModel
        ));
        logger.info({
            activeInstance: activeConfig?.name,
            fallbackInstances: fallbackConfigs.map((instance) => instance.name),
            visionFallbackInstances: visionFallbackConfigs.map((instance) => instance.name),
        }, 'Using OpenAI Provider');
        return new OpenAIProvider(activeConfig, fallbackConfigs, visionFallbackConfigs);
    } else if (provider === "azure") {
        logger.info({ deployment: config.azure?.deploymentName }, 'Using Azure OpenAI Provider');
        return new AzureOpenAIProvider(config.azure);
    } else {
        logger.info('Using Gemini Provider');
        return new GeminiProvider(config.gemini);
    }
}
