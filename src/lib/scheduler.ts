import { addDays } from "date-fns";

/**
 * 间隔复习（Ebbinghaus 遗忘曲线）日期计算工具。
 *
 * 注意：本文件仅提供纯计算函数，**不包含任何后台调度任务**。
 * ReviewSchedule 记录会被创建（scheduledFor + completedAt），但当前没有
 * cron / 定时器去触发"到期提醒"。到期判断由前端在打开错题列表时按需计算，
 * 而非服务端推送。如需真正的到期通知，需要额外引入后台任务机制。
 */

// Ebbinghaus intervals in days: 1, 2, 4, 7, 15, 30
const REVIEW_INTERVALS = [1, 2, 4, 7, 15, 30];

export function calculateNextReviewDate(currentStage: number): Date {
    const interval = REVIEW_INTERVALS[currentStage] || 30; // Default to 30 if stage exceeds
    return addDays(new Date(), interval);
}

export function getReviewStageDescription(stage: number): string {
    switch (stage) {
        case 0: return "First Review (1 day)";
        case 1: return "Second Review (2 days)";
        case 2: return "Third Review (4 days)";
        case 3: return "Fourth Review (7 days)";
        case 4: return "Fifth Review (15 days)";
        default: return "Maintenance Review (30 days)";
    }
}
