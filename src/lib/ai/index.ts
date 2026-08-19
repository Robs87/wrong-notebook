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
        // 仅将同模型的其它已配置实例作为瞬时故障备用，避免把用户主动配置的
        // 不同模型/协议实例悄悄混入同一次请求。
        const fallbackConfigs = (config.openai?.instances || []).filter((instance) => (
            instance.id !== activeConfig?.id &&
            !!instance.apiKey &&
            (instance.model || 'gpt-4o') === activeModel
        ));
        logger.info({
            activeInstance: activeConfig?.name,
            fallbackInstances: fallbackConfigs.map((instance) => instance.name),
        }, 'Using OpenAI Provider');
        return new OpenAIProvider(activeConfig, fallbackConfigs);
    } else if (provider === "azure") {
        logger.info({ deployment: config.azure?.deploymentName }, 'Using Azure OpenAI Provider');
        return new AzureOpenAIProvider(config.azure);
    } else {
        logger.info('Using Gemini Provider');
        return new GeminiProvider(config.gemini);
    }
}
