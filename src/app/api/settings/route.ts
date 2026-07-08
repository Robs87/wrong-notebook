import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getAppConfig, updateAppConfig } from "@/lib/config";
import { forbidden, internalError, unauthorized } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { OpenAIInstance } from "@/types/api";

const logger = createLogger('api:settings');

export const dynamic = 'force-dynamic';

function maskSecret(value?: string) {
    return value ? '********' : value;
}

function sanitizeConfig(config: ReturnType<typeof getAppConfig>, includeSecrets: boolean) {
    if (includeSecrets) {
        return config;
    }

    return {
        aiProvider: config.aiProvider,
        allowRegistration: config.allowRegistration,
        openai: {
            activeInstanceId: config.openai?.activeInstanceId,
            instances: (config.openai?.instances || []).map(instance => ({
                ...instance,
                apiKey: maskSecret(instance.apiKey),
            })),
        },
        gemini: {
            baseUrl: config.gemini?.baseUrl,
            model: config.gemini?.model,
            apiKey: maskSecret(config.gemini?.apiKey),
        },
        azure: {
            endpoint: config.azure?.endpoint,
            deploymentName: config.azure?.deploymentName,
            apiVersion: config.azure?.apiVersion,
            model: config.azure?.model,
            apiKey: maskSecret(config.azure?.apiKey),
        },
        prompts: config.prompts,
        timeouts: config.timeouts,
    };
}

export async function GET() {
    const session = await getServerSession(authOptions);

    if (!session?.user) {
        return unauthorized("Authentication required");
    }

    const config = getAppConfig();
    return NextResponse.json(sanitizeConfig(config, session.user.role === 'admin'));
}

export async function POST(req: Request) {
    const session = await getServerSession(authOptions);

    if (!session?.user) {
        return unauthorized("Authentication required");
    }

    if (session.user.role !== 'admin') {
        return forbidden("Admin access required");
    }

    try {
        const body = await req.json();
        const currentConfig = getAppConfig();

        // Don't save masked keys if they somehow get sent back (for Gemini)
        if (body.gemini?.apiKey === '********') {
            // 保留原有的 API Key
            body.gemini.apiKey = currentConfig.gemini?.apiKey;
        }

        // For OpenAI instances, preserve original keys for masked entries
        if (body.openai?.instances) {
            const currentInstances = currentConfig.openai?.instances || [];
            body.openai.instances = body.openai.instances.map((instance: OpenAIInstance) => {
                if (instance.apiKey === '********') {
                    // 查找原有实例并保留其 API Key
                    const originalInstance = currentInstances.find((i: OpenAIInstance) => i.id === instance.id);
                    return {
                        ...instance,
                        apiKey: originalInstance?.apiKey || '',
                    };
                }
                return instance;
            });
        }

        // For Azure, preserve original key if masked
        if (body.azure?.apiKey === '********') {
            body.azure.apiKey = currentConfig.azure?.apiKey;
        }

        const updatedConfig = await updateAppConfig(body);
        return NextResponse.json(sanitizeConfig(updatedConfig, true));
    } catch (error) {
        logger.error({ error }, 'Failed to update settings');
        return internalError("Failed to update settings");
    }
}

