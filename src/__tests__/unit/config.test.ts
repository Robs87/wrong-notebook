/**
 * 应用配置模块单元测试（M5 数据库存储版）
 * 测试 getAppConfig / loadConfigFromDB / updateAppConfig / 密钥加密往返
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

// Mock crypto-utils：透传加解密（用真实实现验证往返，但隔离 NEXTAUTH_SECRET 依赖）
vi.mock('@/lib/crypto-utils', async () => {
    const actual = await vi.importActual<typeof import('@/lib/crypto-utils')>('@/lib/crypto-utils');
    return actual;
});

// Mock prisma：可控的 appSetting 表
const mockAppSetting = {
    findUnique: vi.fn(),
    upsert: vi.fn(),
};
const mockWithWriteRetry = vi.fn(async (fn: () => Promise<unknown>) => fn());

vi.mock('@/lib/prisma', () => ({
    prisma: { appSetting: mockAppSetting },
    withWriteRetry: mockWithWriteRetry,
}));

// 存储原始 env
const originalEnv = { ...process.env };

describe('config module (M5 DB-backed)', () => {
    let getAppConfig: typeof import('@/lib/config').getAppConfig;
    let loadConfigFromDB: typeof import('@/lib/config').loadConfigFromDB;
    let updateAppConfig: typeof import('@/lib/config').updateAppConfig;
    let getActiveOpenAIConfig: typeof import('@/lib/config').getActiveOpenAIConfig;

    beforeEach(() => {
        vi.clearAllMocks();
        process.env = { ...originalEnv, NEXTAUTH_SECRET: 'test-secret-for-encryption-32b!' };
        mockAppSetting.findUnique.mockResolvedValue(null);
        mockAppSetting.upsert.mockResolvedValue({});
        vi.resetModules();
    });

    afterEach(() => {
        process.env = originalEnv;
    });

    async function importFresh() {
        const mod = await import('@/lib/config');
        getAppConfig = mod.getAppConfig;
        loadConfigFromDB = mod.loadConfigFromDB;
        updateAppConfig = mod.updateAppConfig;
        getActiveOpenAIConfig = mod.getActiveOpenAIConfig;
    }

    describe('getAppConfig', () => {
        it('缓存未加载时返回 env 种子默认值', async () => {
            await importFresh();
            const config = getAppConfig();
            expect(config.aiProvider).toBe('gemini');
            expect(config.allowRegistration).toBe(false);
            expect(config.timeouts?.analyze).toBe(180000);
        });

        it('loadConfigFromDB 后缓存被填充', async () => {
            await importFresh();
            await loadConfigFromDB();
            const config = getAppConfig();
            // DB 为空 + 无旧文件 → 默认配置持久化
            expect(config.aiProvider).toBe('gemini');
            // 应调用 upsert 持久化
            expect(mockWithWriteRetry).toHaveBeenCalled();
        });

        it('DB 有配置行时解密并缓存', async () => {
            // 先用真实加密构造一行
            const { encryptSecret } = await import('@/lib/crypto-utils');
            const storedConfig = {
                aiProvider: 'openai',
                allowRegistration: true,
                gemini: { apiKey: encryptSecret('secret-gemini-key'), baseUrl: '', model: 'g' },
                azure: { apiKey: '', endpoint: '', deploymentName: '', apiVersion: '', model: '' },
                openai: { instances: [{ id: 'i1', name: 'n', apiKey: encryptSecret('sk-openai'), baseUrl: 'b', model: 'm' }], activeInstanceId: 'i1' },
            };
            mockAppSetting.findUnique.mockResolvedValue({ id: 1, value: JSON.stringify(storedConfig) });

            await importFresh();
            await loadConfigFromDB();
            const config = getAppConfig();

            expect(config.aiProvider).toBe('openai');
            expect(config.allowRegistration).toBe(true);
            // 密钥应被解密回明文
            expect(config.gemini?.apiKey).toBe('secret-gemini-key');
            expect(config.openai?.instances?.[0].apiKey).toBe('sk-openai');
        });
    });

    describe('updateAppConfig', () => {
        it('合并新配置并刷新缓存 + 加密持久化', async () => {
            await importFresh();
            await loadConfigFromDB();

            const updated = await updateAppConfig({ aiProvider: 'azure', allowRegistration: true });
            expect(updated.aiProvider).toBe('azure');
            expect(updated.allowRegistration).toBe(true);
            // 内存缓存已刷新
            expect(getAppConfig().aiProvider).toBe('azure');
            // 持久化被调用
            expect(mockWithWriteRetry).toHaveBeenCalled();
            const upsertArg = mockWithWriteRetry.mock.calls.at(-1)?.[0];
            expect(typeof upsertArg).toBe('function');
        });

        it('持久化时密钥应被加密', async () => {
            const { isEncrypted } = await import('@/lib/crypto-utils');
            await importFresh();
            await loadConfigFromDB();

            await updateAppConfig({
                gemini: { apiKey: 'plain-key-123', baseUrl: '', model: 'm' },
            });

            // 捕获写入 DB 的 value
            const upsertFn = mockWithWriteRetry.mock.calls.at(-1)?.[0] as (() => Promise<unknown>) | undefined;
            expect(upsertFn).toBeDefined();
            // mockAppSetting.upsert 被调用，检查 value 里的密钥已加密
            const upsertCall = mockAppSetting.upsert.mock.calls.at(-1)?.[0] as { update?: { value?: string } } | undefined;
            const storedValue = upsertCall?.update?.value;
            expect(storedValue).toBeDefined();
            const parsed = JSON.parse(storedValue as string);
            expect(isEncrypted(parsed.gemini.apiKey)).toBe(true);
            expect(parsed.gemini.apiKey).not.toBe('plain-key-123');
        });
    });

    describe('密钥加密往返', () => {
        it('encrypt → decrypt 还原明文', async () => {
            const { encryptSecret, decryptSecret } = await import('@/lib/crypto-utils');
            const ct = encryptSecret('my-api-key-xyz');
            expect(ct).not.toBe('my-api-key-xyz');
            expect(decryptSecret(ct)).toBe('my-api-key-xyz');
        });

        it('空值不加密', async () => {
            const { encryptSecret } = await import('@/lib/crypto-utils');
            expect(encryptSecret('')).toBe('');
        });

        it('解密失败返回空（fail-soft）', async () => {
            const { decryptSecret } = await import('@/lib/crypto-utils');
            expect(decryptSecret('enc:v1:invalid:data:here')).toBe('');
        });

        it('明文/旧数据原样返回（向后兼容）', async () => {
            const { decryptSecret } = await import('@/lib/crypto-utils');
            expect(decryptSecret('legacy-plaintext-key')).toBe('legacy-plaintext-key');
            expect(decryptSecret('')).toBe('');
        });
    });

    describe('getActiveOpenAIConfig', () => {
        it('返回 activeInstanceId 对应的实例', async () => {
            const { encryptSecret } = await import('@/lib/crypto-utils');
            const storedConfig = {
                aiProvider: 'openai',
                openai: {
                    instances: [
                        { id: 'i1', name: 'A', apiKey: encryptSecret('k1'), baseUrl: '', model: '' },
                        { id: 'i2', name: 'B', apiKey: encryptSecret('k2'), baseUrl: '', model: '' },
                    ],
                    activeInstanceId: 'i2',
                },
            };
            mockAppSetting.findUnique.mockResolvedValue({ id: 1, value: JSON.stringify(storedConfig) });
            await importFresh();
            await loadConfigFromDB();

            const active = getActiveOpenAIConfig();
            expect(active?.id).toBe('i2');
            expect(active?.name).toBe('B');
        });
    });
});
