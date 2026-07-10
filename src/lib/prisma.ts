import { PrismaClient, Prisma } from '@prisma/client'
import { createLogger } from './logger'

const logger = createLogger('prisma');

const globalForPrisma = global as unknown as { prisma: PrismaClient }

export const prisma =
    globalForPrisma.prisma ||
    new PrismaClient({
        log: process.env.DEBUG_DB === 'true'
            ? ['query', 'error', 'warn']
            : (process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error']),
    })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma

/**
 * 应用 SQLite 加固 pragma。
 *
 * 第一性原理：SQLite 默认 journal_mode=DELETE，并发写会立即抛 SQLITE_BUSY。
 * 对于多用户 Web 应用，这会导致写操作在高并发下频繁失败。
 * - WAL 模式：读写不再互相阻塞，显著提升并发读 + 单写吞吐。
 * - busy_timeout=5000：遇到锁时内核内部重试 5 秒，而非立即失败。
 * - synchronous=NORMAL：WAL 模式下足够安全且更快（崩溃风险可接受，事务提交仍持久）。
 * - foreign_keys=ON：启用外键约束（SQLite 默认关闭）。
 *
 * 这是项目首次引入 raw SQL，仅限固定 pragma 字符串，不接受任何用户输入，无注入面。
 */
async function applySqlitePragmas(): Promise<void> {
    try {
        // 用 $queryRawUnsafe 而非 $executeRawUnsafe：journal_mode / busy_timeout 这两条
        // pragma 在赋值时会返回结果行，而 $executeRawUnsafe 走 SQLite 的 .run() 路径、
        // 不分配结果缓冲，遇到返回行会抛 "Execute returned results, which is not allowed in
        // SQLite."。$queryRawUnsafe 对"返回行"和"不返回行(返回 [])"两类 pragma 都安全，
        // 可让四项加固真正落地（此前 journal_mode / busy_timeout 被 try/catch 静默吞掉）。
        await prisma.$queryRawUnsafe('PRAGMA journal_mode=WAL');
        await prisma.$queryRawUnsafe('PRAGMA busy_timeout=5000');
        await prisma.$queryRawUnsafe('PRAGMA synchronous=NORMAL');
        await prisma.$queryRawUnsafe('PRAGMA foreign_keys=ON');
        logger.info('SQLite pragmas applied (WAL, busy_timeout=5000, synchronous=NORMAL, foreign_keys=ON)');
    } catch (error) {
        // pragma 失败不阻塞启动（兼容非 SQLite 或权限受限环境），仅告警
        logger.warn({ error: error instanceof Error ? error.message : String(error) }, 'Failed to apply SQLite pragmas (non-fatal)');
    }
}

// 模块加载时异步应用（fire-and-forget，不阻塞 import）。Next 构建的数据收集阶段
// 没有运行时 DATABASE_URL，也不应尝试连接数据库；pragma 留到容器启动后执行。
if (process.env.NEXT_PHASE !== 'phase-production-build') {
    applySqlitePragmas();
}

/**
 * 写操作重试包装：捕获 SQLite 写冲突（SQLITE_BUSY / Prisma P2028 事务冲突），
 * 指数退避重试最多 maxRetries 次。
 *
 * 适用于高冲突写路径（如 batch-upload、配置更新）。普通读操作无需包装。
 */
export async function withWriteRetry<T>(
    fn: () => Promise<T>,
    maxRetries = 3
): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;
            const isBusy =
                (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2028') ||
                (error instanceof Error && /SQLITE_BUSY|database is locked/i.test(error.message));
            if (!isBusy || attempt === maxRetries) {
                throw error;
            }
            const backoffMs = Math.min(50 * Math.pow(2, attempt), 500);
            logger.warn({ attempt: attempt + 1, maxRetries, backoffMs }, 'SQLite write conflict, retrying');
            await new Promise((resolve) => setTimeout(resolve, backoffMs));
        }
    }
    throw lastError;
}
