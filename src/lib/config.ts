import fs from 'fs';
import path from 'path';
import { prisma, withWriteRetry } from './prisma';
import { encryptSecret, decryptSecret } from './crypto-utils';
import { createLogger } from './logger';

const logger = createLogger('config');

const CONFIG_FILE_PATH = path.join(process.cwd(), 'config', 'app-config.json');

// OpenAI 实例配置
export interface OpenAIInstance {
    id: string;
    name: string;
    apiKey: string;
    baseUrl: string;
    model: string;
}

export interface AppConfig {
    aiProvider: 'gemini' | 'openai' | 'azure';
    allowRegistration?: boolean;
    openai?: {
        instances?: OpenAIInstance[];
        activeInstanceId?: string;
    };
    gemini?: {
        apiKey?: string;
        baseUrl?: string;
        model?: string;
    };
    azure?: {
        apiKey?: string;
        endpoint?: string; // https://xxx.openai.azure.com
        deploymentName?: string;
        apiVersion?: string;
        model?: string;
    };
    prompts?: {
        analyze?: string;
        similar?: string;
        reanswer?: string;
        bySubject?: Record<string, {
            analyze?: string;
            similar?: string;
            reanswer?: string;
        }>;
    };
    timeouts?: {
        analyze?: number; // milliseconds
    };
}

// 旧版 OpenAI 配置（迁移用）
interface LegacyOpenAIConfig {
    apiKey?: string;
    baseUrl?: string;
    model?: string;
}

function isLegacyOpenAIConfig(config: unknown): config is LegacyOpenAIConfig {
    return typeof config === 'object' && config !== null && 'apiKey' in config && !('instances' in config);
}

function migrateOpenAIConfig(legacy: LegacyOpenAIConfig): { instances: OpenAIInstance[]; activeInstanceId?: string } {
    const id = generateId();
    return {
        instances: [{
            id,
            name: 'Default',
            apiKey: legacy.apiKey || '',
            baseUrl: legacy.baseUrl || '',
            model: legacy.model || 'gpt-4o',
        }],
        activeInstanceId: id,
    };
}

function generateId(): string {
    return Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
}

const DEFAULT_CONFIG: AppConfig = {
    aiProvider: (process.env.AI_PROVIDER as 'gemini' | 'openai' | 'azure') || 'gemini',
    // 默认关闭注册：避免默认部署对公网开放账号创建，由管理员在设置页显式开启
    allowRegistration: false,
    openai: {
        instances: process.env.OPENAI_API_KEY ? [{
            id: 'env-default',
            name: 'Default',
            apiKey: process.env.OPENAI_API_KEY,
            baseUrl: process.env.OPENAI_BASE_URL || '',
            model: process.env.OPENAI_MODEL || 'gpt-4o',
        }] : [],
        activeInstanceId: process.env.OPENAI_API_KEY ? 'env-default' : undefined,
    },
    gemini: {
        apiKey: process.env.GOOGLE_API_KEY || '',
        baseUrl: process.env.GEMINI_BASE_URL || '',
        model: process.env.GEMINI_MODEL || 'gemini-2.0-flash',
    },
    azure: {
        apiKey: process.env.AZURE_OPENAI_API_KEY || '',
        endpoint: process.env.AZURE_OPENAI_ENDPOINT || '',
        deploymentName: process.env.AZURE_OPENAI_DEPLOYMENT_NAME || '',
        apiVersion: process.env.AZURE_OPENAI_API_VERSION || '2024-02-15-preview',
        model: process.env.AZURE_OPENAI_MODEL || '',
    },
    prompts: {
        analyze: '',
        similar: '',
        reanswer: '',
    },
    timeouts: {
        analyze: 180000,
    },
};

// ============ 密钥加密/解密（仅对 apiKey 字段） ============

/** 加密 AppConfig 中的所有密钥字段，返回可安全入库的副本。 */
function encryptAppConfig(config: AppConfig): AppConfig {
    const encrypted = JSON.parse(JSON.stringify(config)) as AppConfig;
    if (encrypted.gemini?.apiKey) {
        encrypted.gemini.apiKey = encryptSecret(encrypted.gemini.apiKey);
    }
    if (encrypted.azure?.apiKey) {
        encrypted.azure.apiKey = encryptSecret(encrypted.azure.apiKey);
    }
    if (encrypted.openai?.instances) {
        encrypted.openai.instances = encrypted.openai.instances.map((inst) => ({
            ...inst,
            apiKey: encryptSecret(inst.apiKey),
        }));
    }
    return encrypted;
}

/** 解密从 DB 读出的 AppConfig 中的密钥字段。 */
function decryptAppConfig(config: AppConfig): AppConfig {
    const decrypted = JSON.parse(JSON.stringify(config)) as AppConfig;
    if (decrypted.gemini?.apiKey) {
        decrypted.gemini.apiKey = decryptSecret(decrypted.gemini.apiKey);
    }
    if (decrypted.azure?.apiKey) {
        decrypted.azure.apiKey = decryptSecret(decrypted.azure.apiKey);
    }
    if (decrypted.openai?.instances) {
        decrypted.openai.instances = decrypted.openai.instances.map((inst) => ({
            ...inst,
            apiKey: decryptSecret(inst.apiKey),
        }));
    }
    return decrypted;
}

/** 深合并用户配置与默认配置，确保所有字段存在（保留旧 JSON 文件的 merge 语义）。 */
function mergeWithDefaults(userConfig: Partial<AppConfig>): AppConfig {
    // 检测并迁移旧版 OpenAI 配置（仅在内存中迁移）
    let openaiInstances: OpenAIInstance[] | undefined;
    let openaiActiveId: string | undefined;
    if (isLegacyOpenAIConfig(userConfig.openai)) {
        logger.info('Detected legacy OpenAI config, applying in-memory migration');
        const migrated = migrateOpenAIConfig(userConfig.openai as LegacyOpenAIConfig);
        openaiInstances = migrated.instances;
        openaiActiveId = migrated.activeInstanceId;
    } else {
        openaiInstances = (userConfig.openai as AppConfig['openai'])?.instances;
        openaiActiveId = (userConfig.openai as AppConfig['openai'])?.activeInstanceId;
    }

    return {
        ...DEFAULT_CONFIG,
        ...userConfig,
        openai: {
            instances: openaiInstances || DEFAULT_CONFIG.openai?.instances || [],
            activeInstanceId: openaiActiveId || DEFAULT_CONFIG.openai?.activeInstanceId,
        },
        gemini: { ...DEFAULT_CONFIG.gemini, ...userConfig.gemini },
        azure: { ...DEFAULT_CONFIG.azure, ...userConfig.azure },
        prompts: { ...DEFAULT_CONFIG.prompts, ...userConfig.prompts },
        timeouts: { ...DEFAULT_CONFIG.timeouts, ...userConfig.timeouts },
    };
}

// ============ 内存缓存（保持 getAppConfig 同步签名） ============

let cachedConfig: AppConfig | null = null;

/**
 * 同步读取配置：返回内存缓存。
 * 缓存未就绪（启动早期或 loadConfigFromDB 未完成）时返回 env 种子默认值。
 *
 * 注意：保持同步签名是关键约束——getAIService() 及 3 个 provider 构造函数
 * 都是同步调用，不能改为异步。缓存由 instrumentation.ts 在启动时 await
 * loadConfigFromDB() 填充。
 */
export function getAppConfig(): AppConfig {
    if (cachedConfig) return cachedConfig;
    return DEFAULT_CONFIG;
}

/**
 * 从 DB 加载配置到内存缓存。启动时调用。
 * - DB 无 AppSetting 行：尝试从旧 JSON 文件迁移；无 JSON 则用 DEFAULT_CONFIG。
 * - DB 有行：解密密钥字段后缓存。
 * 首次写入新行（含迁移结果），之后以 DB 为准。
 */
export async function loadConfigFromDB(): Promise<void> {
    try {
        const row = await prisma.appSetting.findUnique({ where: { id: 1 } });
        if (row) {
            const parsed = JSON.parse(row.value) as AppConfig;
            cachedConfig = decryptAppConfig(mergeWithDefaults(parsed));
            logger.info('Config loaded from DB');
            return;
        }

        // DB 无行：尝试迁移旧 JSON 文件
        const migrated = migrateFromLegacyFile();
        const toStore = migrateFromBootstrapShape(migrated);
        const merged = mergeWithDefaults(toStore);
        cachedConfig = merged;
        // 持久化到 DB（加密密钥）
        await persistConfig(merged);
        logger.info({ source: migrated ? 'legacy-json' : 'default' }, 'Config initialized and persisted to DB');
    } catch (error) {
        logger.error({ error: error instanceof Error ? error.message : String(error) }, 'Failed to load config from DB, falling back to defaults');
        cachedConfig = DEFAULT_CONFIG;
    }
}

/**
 * 从旧 config/app-config.json 读取（迁移用）。返回 null 表示无文件。
 */
function migrateFromLegacyFile(): Partial<AppConfig> | null {
    if (!fs.existsSync(CONFIG_FILE_PATH)) return null;
    try {
        const fileContent = fs.readFileSync(CONFIG_FILE_PATH, 'utf-8');
        return JSON.parse(fileContent) as Partial<AppConfig>;
    } catch (error) {
        logger.warn({ error: error instanceof Error ? error.message : String(error) }, 'Failed to read legacy config file for migration');
        return null;
    }
}

/**
 * 规范化 bootstrap-config.js 写入的不一致 shape（如 azure.deployment → deploymentName）。
 */
function migrateFromBootstrapShape(config: Partial<AppConfig> | null): Partial<AppConfig> {
    if (!config) return {};
    const normalized = JSON.parse(JSON.stringify(config)) as Partial<AppConfig> & { azure?: { deployment?: string } };
    if (normalized.azure?.deployment && !normalized.azure.deploymentName) {
        normalized.azure.deploymentName = normalized.azure.deployment;
        delete (normalized.azure as { deployment?: string }).deployment;
    }
    return normalized;
}

/**
 * 加密并持久化配置到 DB（事务 + 写重试）。
 */
async function persistConfig(config: AppConfig): Promise<void> {
    const encrypted = encryptAppConfig(config);
    const value = JSON.stringify(encrypted);
    await withWriteRetry(() =>
        prisma.appSetting.upsert({
            where: { id: 1 },
            update: { value },
            create: { id: 1, value },
        })
    );
}

/**
 * 更新配置（async）：合并新配置 → 刷新缓存 → 加密持久化到 DB。
 * 替换旧版同步 updateAppConfig；唯一生产调用方 settings POST 改为 await。
 */
export async function updateAppConfig(newConfig: Partial<AppConfig>): Promise<AppConfig> {
    const currentConfig = getAppConfig();
    const updatedConfig: AppConfig = {
        ...currentConfig,
        ...newConfig,
        openai: {
            instances: newConfig.openai?.instances ?? currentConfig.openai?.instances ?? [],
            activeInstanceId: newConfig.openai?.activeInstanceId ?? currentConfig.openai?.activeInstanceId,
        },
        gemini: { ...currentConfig.gemini, ...newConfig.gemini },
        azure: { ...currentConfig.azure, ...newConfig.azure },
        prompts: { ...currentConfig.prompts, ...newConfig.prompts },
        timeouts: { ...currentConfig.timeouts, ...newConfig.timeouts },
    };

    // 先刷新缓存（即便持久化失败，内存配置也保持一致）
    cachedConfig = updatedConfig;
    await persistConfig(updatedConfig);
    return updatedConfig;
}

// 获取当前激活的 OpenAI 实例配置
export function getActiveOpenAIConfig(): OpenAIInstance | undefined {
    const config = getAppConfig();
    const activeId = config.openai?.activeInstanceId;
    if (!activeId) return config.openai?.instances?.[0];
    return config.openai?.instances?.find((i) => i.id === activeId);
}

export const MAX_OPENAI_INSTANCES = 10;
