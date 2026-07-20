/**
 * 一建备考提示词同步脚本 - 可在 Docker entrypoint 中自动运行
 * ============================================================
 *
 * 用途：把镜像内打包的权威一建提示词（来自 一建备考提示词-config-snippet.json）
 *      同步到数据库 AppSetting.prompts.bySubject，覆盖三类部署场景：
 *
 *   1. 方式一新用户（clone + bootstrap-config.js）：bootstrap 已注入，本脚本幂等跳过。
 *   2. 方式二新用户（纯拉 ghcr 镜像，不跑 bootstrap）：DB 无 bySubject → 注入。
 *   3. 老用户（已部署，DB 有旧版提示词）：升级到镜像内的新版。
 *
 * 触发时机：docker-entrypoint.sh 的版本升级分支内（紧跟 rebuild-system-tags 之后）。
 *          首次启动（PREVIOUS_VERSION 为空）也会触发，覆盖全新部署。
 *
 * 安全原则（第一性原理：最小变更 + 可回滚 + 密钥零接触）：
 *   - 只碰 prompts.bySubject 这一层；analyze/similar/reanswer 以镜像 snippet 为权威源覆盖。
 *   - apiKey 等密钥字段字节不动（深拷贝旧配置 → 只改 bySubject → stringify）。
 *   - 写前自动备份当前 value 到 /app/data/yijian-prompt-backup-<ts>.json。
 *   - 幂等：内容已与镜像一致则跳过，不产生多余写入。
 *   - 失败 non-fatal：entrypoint 用 `|| ...` 兜底，本脚本错误不应阻断应用启动。
 *
 * 幂等性原理：本脚本每次启动（版本升级时）都跑，但只在内容不一致时才写 DB。
 *            这保证：用户重启容器不会反复改 DB；snippet 升级后下次启动自动同步。
 */
import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';
// 直接 import 镜像内打包的权威 snippet（resolveJsonModule 已开启）
// 编译产物在 dist-scripts/scripts/，snippet 在 /app/根目录，故用 ../../
import snippet from '../一建备考提示词-config-snippet.json';
// 纯函数安全逻辑（可单测）：与 Prisma / JSON snippet 解耦
import {
    YIJIAN_SUBJECTS,
    buildAuthoritativeBySubject,
    bySubjectEquals,
    diffConfigs,
} from './yijian-prompt-safety';

const prisma = new PrismaClient();

const LOG_PREFIX = '[SyncYijian]';
const BACKUP_DIR = process.env.DATA_DIR || '/app/data';

async function main() {
    const authoritative = buildAuthoritativeBySubject(snippet);
    console.log(`${LOG_PREFIX} 镜像内权威一建提示词已加载（科目: ${YIJIAN_SUBJECTS.join(', ')}）`);

    const row = await prisma.appSetting.findUnique({ where: { id: 1 } });

    // 场景 A：DB 无 AppSetting 行（全新部署，纯拉镜像未配置）
    // → 创建一个最小配置：仅含 bySubject + 必要默认值，provider 留空（不预置密钥占位）
    if (!row) {
        console.log(`${LOG_PREFIX} DB 无 AppSetting 行，注入初始 bySubject 配置`);
        const initialConfig = {
            aiProvider: 'gemini',
            allowRegistration: false,
            openai: { instances: [], activeInstanceId: '' },
            gemini: { apiKey: '', baseUrl: '', model: 'gemini-2.0-flash' },
            azure: {
                apiKey: '', endpoint: '', deploymentName: '',
                apiVersion: '2024-02-15-preview', model: ''
            },
            prompts: {
                analyze: '',
                similar: '',
                reanswer: '',
                bySubject: authoritative,
            },
            timeouts: { analyze: 180000 },
        };
        await prisma.appSetting.create({
            data: { id: 1, value: JSON.stringify(initialConfig) },
        });
        console.log(`${LOG_PREFIX} ✅ 已创建初始 AppSetting（含一建 bySubject）`);
        console.log(`${LOG_PREFIX} 注意：provider 配置为空，用户需在 Web UI 设置页填入 AI 密钥`);
        return;
    }

    // 场景 B/C：DB 有行，检查 bySubject 是否需要同步
    const oldValueStr = row.value;
    const oldCfg = JSON.parse(oldValueStr);
    const oldBySubject = oldCfg.prompts?.bySubject;

    // 幂等检测：内容已与镜像一致 → 完全跳过
    if (bySubjectEquals(oldBySubject, authoritative)) {
        console.log(`${LOG_PREFIX} bySubject 已与镜像一致，跳过（幂等）`);
        return;
    }

    // 需要更新：先打印现状摘要
    if (!oldBySubject || Object.keys(oldBySubject).length === 0) {
        console.log(`${LOG_PREFIX} bySubject 为空（方式二新用户），将注入 ${YIJIAN_SUBJECTS.length} 个科目`);
    } else {
        const oldKeys = Object.keys(oldBySubject);
        console.log(`${LOG_PREFIX} 现有 bySubject 科目: ${oldKeys.join(', ')}`);
        for (const k of YIJIAN_SUBJECTS) {
            const cur = oldBySubject[k];
            if (!cur) {
                console.log(`${LOG_PREFIX}   [${k}] 缺失 → 将注入`);
            } else {
                const diffs: string[] = [];
                if (cur.analyze !== authoritative[k].analyze) diffs.push('analyze');
                if (cur.similar !== authoritative[k].similar) diffs.push('similar');
                if (cur.reanswer !== authoritative[k].reanswer) diffs.push('reanswer');
                console.log(`${LOG_PREFIX}   [${k}] 需更新: ${diffs.length > 0 ? diffs.join('/') : '(无差异)'}`);
            }
        }
    }

    // 构造新配置：深拷贝旧配置（保留字段顺序与密钥），只替换 bySubject 为权威版本
    const newCfg = JSON.parse(JSON.stringify(oldCfg));
    if (!newCfg.prompts) newCfg.prompts = {};
    // 覆盖为权威 bySubject（以镜像 snippet 为准，确保三模板完全一致）
    newCfg.prompts.bySubject = JSON.parse(JSON.stringify(authoritative));
    const newValueStr = JSON.stringify(newCfg);

    // 安全校验：除一建四科的 analyze/similar/reanswer 外，所有字段必须字节不变
    const verifyOld = JSON.parse(oldValueStr);
    const verifyNew = JSON.parse(newValueStr);
    const diffs = diffConfigs(verifyOld, verifyNew);
    if (diffs.length > 0) {
        console.error(`${LOG_PREFIX} ❌ 安全校验失败：除 bySubject 模板外发现其他字段被改动:`);
        for (const d of diffs.slice(0, 20)) console.error(`   ${d}`);
        console.error(`${LOG_PREFIX}    共 ${diffs.length} 处差异，中止写入`);
        process.exit(1);
    }
    console.log(`${LOG_PREFIX} ✅ 安全校验通过：仅 bySubject 三模板被更新，密钥等其他字段字节不变`);

    // 备份当前 value
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backupPath = path.join(BACKUP_DIR, `yijian-prompt-backup-${ts}.json`);
    try {
        // 确保备份目录存在
        if (!fs.existsSync(BACKUP_DIR)) {
            fs.mkdirSync(BACKUP_DIR, { recursive: true });
        }
        fs.writeFileSync(backupPath, oldValueStr, 'utf-8');
        console.log(`${LOG_PREFIX} 📦 已备份当前 value 到 ${backupPath}`);
    } catch (e: any) {
        console.error(`${LOG_PREFIX} ❌ 备份失败: ${e?.message || e}`);
        console.error(`${LOG_PREFIX}    出于安全考虑，未写入数据库`);
        process.exit(1);
    }

    // 写入
    await prisma.appSetting.update({
        where: { id: 1 },
        data: { value: newValueStr },
    });
    console.log(`${LOG_PREFIX} ✅ 数据库已更新`);

    // 回读校验
    const reread = await prisma.appSetting.findUnique({ where: { id: 1 } });
    const rereadCfg = JSON.parse(reread!.value);
    const rereadBs = rereadCfg.prompts?.bySubject;
    let allOk = true;
    for (const k of YIJIAN_SUBJECTS) {
        const cur = rereadBs?.[k];
        const ok = cur && cur.analyze === authoritative[k].analyze
            && cur.similar === authoritative[k].similar
            && cur.reanswer === authoritative[k].reanswer;
        if (!ok) allOk = false;
        console.log(`${LOG_PREFIX}    回读 [${k}]: ${ok ? '✅ 三模板已生效' : '❌ 不一致'}`);
    }
    // 密钥字段未变（与备份比）
    const backupCfg = JSON.parse(fs.readFileSync(backupPath, 'utf-8'));
    const secretPaths: string[] = [
        'gemini.apiKey', 'azure.apiKey',
        ...((rereadCfg.openai?.instances || []).map((_: any, i: number) => `openai.instances.${i}.apiKey`)),
    ];
    const get = (obj: any, p: string) => p.split('.').reduce((o, kk) => (o == null ? o : o[kk]), obj);
    let secretOk = true;
    for (const sp of secretPaths) {
        if (get(backupCfg, sp) !== undefined && get(backupCfg, sp) !== get(rereadCfg, sp)) {
            console.error(`${LOG_PREFIX}    ❌ 密钥字段 ${sp} 被改动！`);
            secretOk = false;
        }
    }
    if (secretOk) console.log(`${LOG_PREFIX}    密钥字段校验: ✅ 全部未变`);

    if (!allOk || !secretOk) {
        console.error(`${LOG_PREFIX} ⚠️ 校验发现问题，value 备份在 ${backupPath}`);
        process.exit(1);
    }
    console.log(`${LOG_PREFIX} 🎉 一建提示词同步完成`);
}

main()
    .catch((e) => {
        // non-fatal：entrypoint 用 || 兜底，这里仅记错误退出
        console.error(`${LOG_PREFIX} Error:`, e?.message || e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
