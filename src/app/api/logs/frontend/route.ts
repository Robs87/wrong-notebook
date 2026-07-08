import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { createLogger } from '@/lib/logger';

const logger = createLogger('frontend-logs');

export const runtime = 'nodejs';

// 批量日志上限，防止日志洪泛/磁盘耗尽
const MAX_LOG_BATCH = 50;
// 单字段长度上限，防止日志注入/超大 payload
const MAX_FIELD_LEN = 2000;

interface FrontendLogEntry {
  level: 'info' | 'warn' | 'error';
  prefix: string;
  message: string;
  context?: Record<string, unknown>;
  timestamp: string;
  url?: string;
  userAgent?: string;
}

function clampString(v: unknown): string {
  if (typeof v !== 'string') return '';
  return v.length > MAX_FIELD_LEN ? v.slice(0, MAX_FIELD_LEN) : v;
}

/**
 * POST /api/logs/frontend
 *
 * Receives frontend logs and writes them to backend logger
 * Supports both single log and batch log formats.
 * 要求登录鉴权，并对批量大小/字段长度做限制，防止匿名日志洪泛与注入。
 */
export async function POST(request: NextRequest) {
  try {
    // 必须登录：匿名客户端不得写入后端日志
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();

    // 支持批量日志格式 { logs: [...] } 和单条日志格式
    let logs: FrontendLogEntry[];
    if (Array.isArray(body?.logs)) {
      logs = body.logs;
    } else if (body && typeof body === 'object') {
      logs = [body];
    } else {
      return NextResponse.json({ success: false, error: 'Invalid payload' }, { status: 400 });
    }

    if (logs.length > MAX_LOG_BATCH) {
      return NextResponse.json(
        { success: false, error: `Too many log entries (max ${MAX_LOG_BATCH})` },
        { status: 413 }
      );
    }

    for (const entry of logs) {
      if (!entry || typeof entry !== 'object') continue;
      const level = entry.level === 'warn' || entry.level === 'error' ? entry.level : 'info';
      const message = clampString(entry.message);
      const prefix = clampString(entry.prefix);

      // 构建受控上下文：仅接受可序列化、长度受限的字段
      const logContext: Record<string, unknown> = {
        source: 'frontend',
        prefix,
        userId: session.user.id,
        url: clampString(entry.url || request.headers.get('referer') || ''),
        userAgent: clampString(entry.userAgent || request.headers.get('user-agent') || ''),
        clientTime: clampString(entry.timestamp),
      };
      if (entry.context && typeof entry.context === 'object') {
        const ctx = entry.context as Record<string, unknown>;
        for (const [k, v] of Object.entries(ctx)) {
          const key = clampString(k);
          if (!key) continue;
          logContext[key] = typeof v === 'string' ? clampString(v) : v;
        }
      }

      switch (level) {
        case 'error':
          logger.error(logContext, message);
          break;
        case 'warn':
          logger.warn(logContext, message);
          break;
        case 'info':
        default:
          logger.info(logContext, message);
          break;
      }
    }

    return NextResponse.json({ success: true, count: logs.length });
  } catch (error) {
    logger.error({ error }, 'Failed to process frontend log');
    return NextResponse.json({ success: false }, { status: 500 });
  }
}
