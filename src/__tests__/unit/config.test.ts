/**
 * 应用配置模块单元测试（M5 数据库存储版）
 * 测试 getAppConfig / loadConfigFromDB / updateAppConfig / 密钥加密往返
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';

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
        // 清空 globalThis 上的共享配置缓存，保证用例之间互不影响
        // （生产中该缓存跨 chunk 共享；测试需显式重置）
        delete (globalThis as Record<symbol, unknown>)[Symbol.for('wrong-notebook.appConfig.v1')];
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

        it('持久化失败时不应该发布未落盘的内存配置', async () => {
            await importFresh();
            await loadConfigFromDB();
            const before = getAppConfig().aiProvider;
            mockWithWriteRetry.mockRejectedValueOnce(new Error('disk full'));

            await expect(updateAppConfig({ aiProvider: 'azure' })).rejects.toThrow('disk full');

            expect(getAppConfig().aiProvider).toBe(before);
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

    describe('部分迁移：DB 不完整时从 legacy JSON 安全补回', () => {
        afterEach(() => {
            vi.restoreAllMocks();
        });

        it('补回 prompts.bySubject 与额外 openai 实例，且不覆盖 DB 已有加密 apiKey', async () => {
            const { encryptSecret } = await import('@/lib/crypto-utils');
            // DB 配置：仅 1 个 openai 实例（加密密钥），prompts.bySubject 为空
            const dbConfig = {
                aiProvider: 'openai',
                openai: {
                    instances: [
                        { id: 'db-1', name: '主实例', apiKey: encryptSecret('secret-db'), baseUrl: 'https://db.example.com/v1', model: 'm1' },
                    ],
                    activeInstanceId: 'db-1',
                },
                prompts: { analyze: '', similar: '', reanswer: '' },
            };
            mockAppSetting.findUnique.mockResolvedValue({ id: 1, value: JSON.stringify(dbConfig) });

            // legacy JSON：3 个实例（l-1 与 DB 同 baseUrl 应被去重跳过）+ bySubject 完整
            const legacy = {
                aiProvider: 'openai',
                openai: {
                    instances: [
                        { id: 'l-1', name: '主实例(旧)', apiKey: 'legacy-should-not-overwrite', baseUrl: 'https://db.example.com/v1', model: 'm1' },
                        { id: 'l-2', name: 'agnes', apiKey: 'legacy-agnes-key', baseUrl: 'https://apihub.agnes-ai.com/v1', model: 'agnes-2.0-flash' },
                        { id: 'l-3', name: 'bigmodel', apiKey: 'legacy-bigmodel-key', baseUrl: 'https://open.bigmodel.cn/api', model: 'glm-4' },
                    ],
                    activeInstanceId: 'l-2',
                },
                prompts: {
                    bySubject: {
                        '一建管理': { analyze: 'p-analyze', similar: 'p-similar', reanswer: 'p-reanswer' },
                    },
                },
                timeouts: { analyze: 240000 },
            };
            const existsSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(true);
            const readSpy = vi.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify(legacy));

            await importFresh();
            await loadConfigFromDB();
            const config = getAppConfig();

            // prompts.bySubject 被补回
            expect(config.prompts?.bySubject?.['一建管理']).toBeDefined();
            expect(config.prompts?.bySubject?.['一建管理'].analyze).toBe('p-analyze');

            // openai 实例从 1 补到 3（l-1 因与 DB 同 baseUrl 被去重，l-2/l-3 被补回）
            expect(config.openai?.instances?.length).toBe(3);

            // DB 已有实例的加密 apiKey 不被 legacy 覆盖
            const dbInst = config.openai?.instances?.find((i) => i.id === 'db-1');
            expect(dbInst?.apiKey).toBe('secret-db');

            // 补回的 agnes 实例存在
            const agnes = config.openai?.instances?.find((i) => i.baseUrl === 'https://apihub.agnes-ai.com/v1');
            expect(agnes?.model).toBe('agnes-2.0-flash');

            // 合并后应重新加密持久化（一次性修复）
            expect(mockAppSetting.upsert).toHaveBeenCalled();
            const upsertCall = mockAppSetting.upsert.mock.calls.at(-1)?.[0] as { update?: { value?: string } } | undefined;
            const stored = JSON.parse(upsertCall?.update?.value ?? '{}');
            // 持久化的密钥必须为密文，明文不得落库
            expect(stored.openai.instances[0].apiKey).not.toBe('secret-db');

            existsSpy.mockRestore();
            readSpy.mockRestore();
        });

        it('DB 已完整时不会触发 legacy 合并（避免复活用户删除的字段）', async () => {
            const { encryptSecret } = await import('@/lib/crypto-utils');
            // DB 已有 2 个实例 + 非空 bySubject，属于完整配置
            const dbConfig = {
                aiProvider: 'openai',
                openai: {
                    instances: [
                        { id: 'a', name: 'A', apiKey: encryptSecret('ka'), baseUrl: 'https://a.example/v1', model: 'm' },
                        { id: 'b', name: 'B', apiKey: encryptSecret('kb'), baseUrl: 'https://b.example/v1', model: 'm' },
                    ],
                    activeInstanceId: 'a',
                },
                prompts: { bySubject: { 数学: { analyze: 'x', similar: '', reanswer: '' } } },
            };
            mockAppSetting.findUnique.mockResolvedValue({ id: 1, value: JSON.stringify(dbConfig) });

            const legacy = {
                openai: {
                    instances: [{ id: 'z', name: 'Z', apiKey: 'legacy-z', baseUrl: 'https://z.example/v1', model: 'm' }],
                },
                prompts: { bySubject: { 一建管理: { analyze: 'legacy-prompt', similar: '', reanswer: '' } } },
            };
            const existsSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(true);
            const readSpy = vi.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify(legacy));

            await importFresh();
            await loadConfigFromDB();
            const config = getAppConfig();

            // DB 实例数量(2) 不小于 legacy(1)，不应补回；bySubject 保留 DB 的，不被 legacy 覆盖
            expect(config.openai?.instances?.length).toBe(2);
            expect(config.prompts?.bySubject?.['数学']).toBeDefined();
            expect(config.prompts?.bySubject?.['一建管理']).toBeUndefined();
            // 未触发合并，不应再次持久化
            expect(mockAppSetting.upsert).not.toHaveBeenCalled();

            existsSpy.mockRestore();
            readSpy.mockRestore();
        });
    });

    describe('globalThis 共享缓存（跨 bundle chunk）', () => {
        it('缓存经 globalThis 跨模块实例共享，而非各自独立', async () => {
            // 模块实例 1：加载并写入一个非默认值（azure）到全局缓存
            const mod1 = await import('@/lib/config');
            await mod1.loadConfigFromDB();
            await mod1.updateAppConfig({ aiProvider: 'azure' });
            expect(mod1.getAppConfig().aiProvider).toBe('azure');

            // 模拟新 chunk 重新 import 模块（resetModules 后函数引用是全新的）
            vi.resetModules();
            const mod2 = await import('@/lib/config');

            // 若缓存为模块级，mod2 会回退 DEFAULT_CONFIG(gemini)；
            // 经 globalThis 共享则应读到 mod1 写入的 azure。
            expect(mod2.getAppConfig().aiProvider).toBe('azure');
        });
    });
});
