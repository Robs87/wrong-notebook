import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { createLogger } from '@/lib/logger';
import { assertSafeBaseUrl, DEFAULT_ALLOWED_HOSTS } from '@/lib/url-safety';

const logger = createLogger('api:ai:models');

interface ModelInfo {
    id: string;
    name: string;
    owned_by?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

// 从模型 ID 中提取短名称
function extractModelName(modelId: string): string {
    // models/gemini-2.0-flash -> gemini-2.0-flash
    return modelId.replace(/^models\//, '');
}

async function fetchGeminiModels(apiKey: string, baseUrl: string): Promise<ModelInfo[]> {
    // baseUrl 已经过 assertSafeBaseUrl 校验为安全 origin，此处安全拼接
    const url = `${baseUrl}/v1beta/models`;

    const response = await fetch(url, {
        headers: {
            'Content-Type': 'application/json',
            // Gemini 的 key 通过 header 传递，避免出现在 URL/日志里
            'x-goog-api-key': apiKey,
        },
    });

    if (!response.ok) {
        logger.error({ status: response.status }, 'Gemini models API error');
        throw new Error(`Gemini API error: ${response.status}`);
    }

    const data = await response.json();
    const models = isRecord(data) && Array.isArray(data.models) ? data.models : [];
    return models
        .filter((model): model is { name: string } => isRecord(model) && typeof model.name === 'string')
        .map((model) => {
            const id = extractModelName(model.name);
            return {
                id,
                name: id,
                owned_by: 'Google',
            };
        });
}

async function fetchOpenAIModels(apiKey: string, baseUrl: string): Promise<ModelInfo[]> {
    // baseUrl 已经过 assertSafeBaseUrl 校验
    const url = `${baseUrl}/models`;

    const response = await fetch(url, {
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
    });

    if (!response.ok) {
        logger.error({ status: response.status }, 'OpenAI models API error');
        throw new Error(`API error: ${response.status}`);
    }

    const data = await response.json();
    const models = isRecord(data) && Array.isArray(data.data) ? data.data : [];

    return models
        .filter((model): model is { id: string; owned_by?: string } => isRecord(model) && typeof model.id === 'string')
        .map((model) => ({
            id: model.id,
            name: model.id,
            owned_by: model.owned_by,
        }));
}

export async function POST(request: NextRequest) {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        if (session.user.role !== 'admin') {
            return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
        }

        const body = await request.json().catch(() => null);
        const provider = typeof body?.provider === 'string' ? body.provider : null;
        const apiKey = typeof body?.apiKey === 'string' ? body.apiKey : null;
        const baseUrlRaw = typeof body?.baseUrl === 'string' ? body.baseUrl : null;

        if (!apiKey) {
            return NextResponse.json(
                { error: 'API key is required' },
                { status: 400 }
            );
        }

        let effectiveBaseUrl: string;
        if (provider === 'gemini') {
            effectiveBaseUrl = baseUrlRaw || 'https://generativelanguage.googleapis.com';
        } else {
            // OpenAI-compatible
            effectiveBaseUrl = baseUrlRaw || 'https://api.openai.com/v1';
        }

        // SSRF 防护：仅信任服务端硬编码的官方主机白名单，不接受请求体里的 allowedHosts，
        // 防止 admin 通过 body 注入私网地址绕过校验。私网地址无条件拒绝。
        const safe = await assertSafeBaseUrl(effectiveBaseUrl, DEFAULT_ALLOWED_HOSTS);
        if (!safe.ok) {
            logger.warn({ reason: safe.error }, 'Blocked unsafe base URL');
            return NextResponse.json(
                { error: 'Blocked: base URL points to a private or disallowed host', models: [] },
                { status: 400 }
            );
        }

        let models: ModelInfo[] = [];
        if (provider === 'gemini') {
            models = await fetchGeminiModels(apiKey, safe.origin!);
        } else {
            models = await fetchOpenAIModels(apiKey, safe.origin!);
        }

        return NextResponse.json({ models });

    } catch (error) {
        logger.error({ error: error instanceof Error ? error.message : 'unknown' }, 'Error fetching models');
        // 返回 200 + 空 models 让前端可手动输入，但不泄漏原始错误细节
        return NextResponse.json(
            { error: 'Failed to fetch models', models: [] },
            { status: 200 }
        );
    }
}
