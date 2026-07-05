import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { createLogger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/error-utils';

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
    const url = `${baseUrl}/v1beta/models?key=${apiKey}`;

    const response = await fetch(url, {
        headers: { 'Content-Type': 'application/json' },
    });

    if (!response.ok) {
        const errorText = await response.text();
        logger.error({ status: response.status, errorText }, 'Gemini models API error');
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
    const url = `${baseUrl}/models`;

    const response = await fetch(url, {
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
    });

    if (!response.ok) {
        logger.error({ statusText: response.statusText }, 'OpenAI models API error');
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

export async function GET(req: NextRequest) {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        if (session.user.role !== 'admin') {
            return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
        }

        const { searchParams } = new URL(req.url);
        const provider = searchParams.get('provider');
        const apiKey = searchParams.get('apiKey');
        const baseUrl = searchParams.get('baseUrl');

        if (!apiKey) {
            return NextResponse.json(
                { error: 'API key is required' },
                { status: 400 }
            );
        }

        let models: ModelInfo[] = [];

        if (provider === 'gemini') {
            const effectiveBaseUrl = baseUrl || 'https://generativelanguage.googleapis.com';
            models = await fetchGeminiModels(apiKey, effectiveBaseUrl);
        } else {
            // OpenAI-compatible
            const effectiveBaseUrl = baseUrl || 'https://api.openai.com/v1';
            models = await fetchOpenAIModels(apiKey, effectiveBaseUrl);
        }

        return NextResponse.json({ models });

    } catch (error) {
        logger.error({ error }, 'Error fetching models');
        return NextResponse.json(
            { error: getErrorMessage(error, 'Internal server error'), models: [] },
            { status: 200 } // Return 200 with empty models to allow manual input
        );
    }
}
