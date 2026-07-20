/**
 * 一建提示词同步 - 安全校验纯函数单元测试
 * ============================================================
 *
 * 锁定安全不变量：只允许一建四科（一建管理/经济/法规/实务）的
 * analyze/similar/reanswer 三个模板发生新增或替换；任何其他配置字段、
 * 任何非一建科目、任何科目对象内额外字段变化必须被 diffConfigs 拦截。
 *
 * 场景 1（新增法规/实务三模板）是回归测试：当前实现会把"新增整个科目对象"
 * 在 prompts.bySubject.<新科目> 层误判为非法差异（a=undefined vs b=object），
 * 必须先失败，修复后通过。
 */
import { describe, it, expect } from 'vitest';
import {
    diffConfigs,
    buildAuthoritativeBySubject,
    YIJIAN_SUBJECTS,
} from '../../../scripts/yijian-prompt-safety';

// 一份与镜像 snippet 同构的模板（内容用短串即可，安全校验只关心结构/路径）
const TEMPLATE = {
    analyze: 'ANALYZE_V1',
    similar: 'SIMILAR_V1',
    reanswer: 'REANSWER_V1',
};

// 构造一份"基线旧配置"：仅含一建管理/经济两科（模拟尚未注入法规/实务的老库）
function baselineConfig(): any {
    return {
        aiProvider: 'gemini',
        openai: { instances: [{ apiKey: 'sk-old' }], activeInstanceId: '' },
        gemini: { apiKey: 'gem-key-old', baseUrl: '', model: 'gemini-2.0-flash' },
        azure: { apiKey: 'az-key-old', endpoint: '', deploymentName: '', apiVersion: 'x', model: '' },
        prompts: {
            analyze: '',
            similar: '',
            reanswer: '',
            bySubject: {
                一建管理: { ...TEMPLATE },
                一建经济: { ...TEMPLATE },
            },
        },
        timeouts: { analyze: 180000 },
    };
}

// 深拷贝辅助
const clone = (o: any) => JSON.parse(JSON.stringify(o));

describe('diffConfigs - 一建提示词安全校验', () => {
    it('场景1（回归）: 新增法规/实务三模板应被允许（diffs 为空）', () => {
        const oldCfg = baselineConfig();
        const newCfg = clone(oldCfg);
        // 模拟同步脚本：注入全部四科（新增 一建法规 / 一建实务 整个科目对象）
        newCfg.prompts.bySubject = buildAuthoritativeBySubject(TEMPLATE);
        const diffs = diffConfigs(oldCfg, newCfg);
        expect(diffs).toEqual([]);
    });

    it('场景2: 替换既有三模板应被允许（diffs 为空）', () => {
        const oldCfg = baselineConfig();
        const newCfg = clone(oldCfg);
        // 仅替换一建管理的三模板内容
        newCfg.prompts.bySubject['一建管理'] = {
            analyze: 'ANALYZE_V2',
            similar: 'SIMILAR_V2',
            reanswer: 'REANSWER_V2',
        };
        const diffs = diffConfigs(oldCfg, newCfg);
        expect(diffs).toEqual([]);
    });

    it('场景3: 修改 apiKey 等其他字段应被拒绝', () => {
        const oldCfg = baselineConfig();
        const newCfg = clone(oldCfg);
        newCfg.gemini.apiKey = 'gem-key-tampered';
        const diffs = diffConfigs(oldCfg, newCfg);
        expect(diffs.length).toBeGreaterThan(0);
        expect(diffs.some((d) => d.startsWith('gemini.apiKey'))).toBe(true);
    });

    it('场景3b: 修改 openai 实例 apiKey 应被拒绝', () => {
        const oldCfg = baselineConfig();
        const newCfg = clone(oldCfg);
        newCfg.openai.instances[0].apiKey = 'sk-tampered';
        const diffs = diffConfigs(oldCfg, newCfg);
        expect(diffs.length).toBeGreaterThan(0);
        expect(diffs.some((d) => d.startsWith('openai.instances.0.apiKey'))).toBe(true);
    });

    it('场景4a: 修改非一建科目应被拒绝', () => {
        const oldCfg = baselineConfig();
        // 旧库已存在一个非一建科目（用户自有提示词）
        (oldCfg.prompts.bySubject as any)['二级建造'] = { analyze: 'A1', similar: 'S1', reanswer: 'R1' };
        const newCfg = clone(oldCfg);
        // 同步脚本不应碰它，但若被改动必须拦截
        (newCfg.prompts.bySubject as any)['二级建造'].analyze = 'A1-TAMPERED';
        const diffs = diffConfigs(oldCfg, newCfg);
        expect(diffs.length).toBeGreaterThan(0);
        expect(diffs.some((d) => d.includes('二级建造'))).toBe(true);
    });

    it('场景4b: 新增非一建科目应被拒绝', () => {
        const oldCfg = baselineConfig();
        const newCfg = clone(oldCfg);
        // 不应允许同步脚本悄悄塞入一个非一建科目
        (newCfg.prompts.bySubject as any)['二级建造'] = { analyze: 'A1', similar: 'S1', reanswer: 'R1' };
        const diffs = diffConfigs(oldCfg, newCfg);
        expect(diffs.length).toBeGreaterThan(0);
        expect(diffs.some((d) => d.includes('二级建造'))).toBe(true);
    });

    it('场景4c: 科目对象内额外字段应被拒绝', () => {
        const oldCfg = baselineConfig();
        const newCfg = clone(oldCfg);
        // 一建管理对象里多出一个非法键
        (newCfg.prompts.bySubject['一建管理'] as any).extra = 'leak';
        const diffs = diffConfigs(oldCfg, newCfg);
        expect(diffs.length).toBeGreaterThan(0);
        expect(diffs.some((d) => d.includes('一建管理.extra'))).toBe(true);
    });
});

describe('buildAuthoritativeBySubject', () => {
    it('只产出四科，每科三模板与入参一致', () => {
        const result = buildAuthoritativeBySubject(TEMPLATE);
        expect(Object.keys(result).sort()).toEqual([...YIJIAN_SUBJECTS].sort());
        for (const s of YIJIAN_SUBJECTS) {
            expect(result[s]).toEqual(TEMPLATE);
        }
    });
});
