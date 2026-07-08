/**
 * Models Route 单元测试
 *
 * 测试 /api/ai/models 端点的 Gemini 和 OpenAI 模型列表功能。
 * 该端点使用 POST + body 传递 apiKey/baseUrl（避免密钥出现在 URL/日志）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// Mock logger
vi.mock('@/lib/logger', () => ({
    createLogger: vi.fn(() => ({
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        box: vi.fn(),
        divider: vi.fn(),
    })),
}));

// Mock url-safety：测试中不真实做 DNS 解析，直接放行（SSRF 逻辑另测）
vi.mock('@/lib/url-safety', () => ({
    assertSafeBaseUrl: vi.fn(async (raw: string) => {
        const u = new URL(raw);
        // 保留路径（去除尾部斜杠），与真实实现一致
        return { ok: true, origin: `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}` };
    }),
    DEFAULT_ALLOWED_HOSTS: ['generativelanguage.googleapis.com', 'api.openai.com'],
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const authMocks = vi.hoisted(() => ({
    mockGetServerSession: vi.fn(),
}));

vi.mock('next-auth', () => ({
    getServerSession: authMocks.mockGetServerSession,
}));

vi.mock('@/lib/auth', () => ({
    authOptions: {},
}));

import { POST } from '@/app/api/ai/models/route';

function makeRequest(body: Record<string, unknown>): NextRequest {
    return new NextRequest('http://localhost/api/ai/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

describe('POST /api/ai/models - Gemini provider', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        authMocks.mockGetServerSession.mockResolvedValue({
            user: {
                id: 'admin-1',
                email: 'admin@example.com',
                role: 'admin',
            },
        });
    });

    it('未登录应该拒绝获取模型列表', async () => {
        authMocks.mockGetServerSession.mockResolvedValueOnce(null);

        const req = makeRequest({ provider: 'gemini', apiKey: 'test-key' });
        const res = await POST(req);

        expect(res.status).toBe(401);
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('普通用户应该拒绝获取模型列表', async () => {
        authMocks.mockGetServerSession.mockResolvedValueOnce({
            user: {
                id: 'user-1',
                email: 'user@example.com',
                role: 'user',
            },
        });

        const req = makeRequest({ provider: 'gemini', apiKey: 'test-key' });
        const res = await POST(req);

        expect(res.status).toBe(403);
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('应该正确获取并返回 Gemini 视觉模型列表', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                models: [
                    { name: 'models/gemini-2.0-flash', displayName: 'Gemini 2.0 Flash' },
                    { name: 'models/gemini-1.5-pro', displayName: 'Gemini 1.5 Pro' },
                    { name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash' },
                ],
            }),
        });

        const req = makeRequest({ provider: 'gemini', apiKey: 'test-key' });
        const res = await POST(req);
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.models).toHaveLength(3);
        expect(body.models[0]).toEqual({
            id: 'gemini-2.0-flash',
            name: 'gemini-2.0-flash',
            owned_by: 'Google',
        });
        expect(body.models[1].id).toBe('gemini-1.5-pro');
        expect(body.models[2].id).toBe('gemini-2.5-flash');
    });

    it('应使用 header 传递 apiKey（而非 URL query）', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ models: [] }),
        });

        const req = makeRequest({ provider: 'gemini', apiKey: 'my-key' });
        await POST(req);

        expect(mockFetch).toHaveBeenCalledWith(
            expect.not.stringContaining('key=my-key'),
            expect.objectContaining({
                headers: expect.objectContaining({ 'x-goog-api-key': 'my-key' }),
            }),
        );
    });

    it('应返回所有模型（不区分视觉/非视觉）', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                models: [
                    { name: 'models/gemini-2.0-flash' },
                    { name: 'models/text-embedding-004' },
                    { name: 'models/gemini-1.5-pro' },
                    { name: 'models/text-to-speech-01' },
                ],
            }),
        });

        const req = makeRequest({ provider: 'gemini', apiKey: 'test-key' });
        const res = await POST(req);
        const body = await res.json();

        expect(body.models).toHaveLength(4);
        expect(body.models.map((m: { id: string }) => m.id)).toEqual([
            'gemini-2.0-flash',
            'text-embedding-004',
            'gemini-1.5-pro',
            'text-to-speech-01',
        ]);
    });

    it('API 返回空 models 数组时应返回空列表', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ models: [] }),
        });

        const req = makeRequest({ provider: 'gemini', apiKey: 'test-key' });
        const res = await POST(req);
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.models).toEqual([]);
    });

    it('API 返回无 models 字段时应返回空列表', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({}),
        });

        const req = makeRequest({ provider: 'gemini', apiKey: 'test-key' });
        const res = await POST(req);
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.models).toEqual([]);
    });

    it('Gemini API 返回错误时应返回 200 和空模型列表', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: false,
            status: 403,
            text: async () => 'Forbidden',
        });

        const req = makeRequest({ provider: 'gemini', apiKey: 'bad-key' });
        const res = await POST(req);
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.models).toEqual([]);
        expect(body.error).toBe('Failed to fetch models');
    });

    it('缺少 apiKey 时应返回 400', async () => {
        const req = makeRequest({ provider: 'gemini' });
        const res = await POST(req);
        const body = await res.json();

        expect(res.status).toBe(400);
        expect(body.error).toBe('API key is required');
    });
});

describe('POST /api/ai/models - OpenAI provider', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        authMocks.mockGetServerSession.mockResolvedValue({
            user: {
                id: 'admin-1',
                email: 'admin@example.com',
                role: 'admin',
            },
        });
    });

    it('应该正确获取并返回 OpenAI 视觉模型列表', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                data: [
                    { id: 'gpt-4o', owned_by: 'openai' },
                    { id: 'gpt-4-turbo', owned_by: 'openai' },
                    { id: 'text-embedding-3-small', owned_by: 'openai' },
                ],
            }),
        });

        const req = makeRequest({ apiKey: 'test-key' });
        const res = await POST(req);
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.models).toHaveLength(3);
        expect(body.models[0].id).toBe('gpt-4o');
        expect(body.models[1].id).toBe('gpt-4-turbo');
        expect(body.models[2].id).toBe('text-embedding-3-small');
    });

    it('OpenAI API 返回错误时应返回 200 和空模型列表', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: false,
            statusText: 'Unauthorized',
            status: 401,
        });

        const req = makeRequest({ apiKey: 'bad-key' });
        const res = await POST(req);
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.models).toEqual([]);
        expect(body.error).toBe('Failed to fetch models');
    });
});
