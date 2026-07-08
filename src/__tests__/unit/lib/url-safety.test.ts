/**
 * url-safety SSRF 防护单元测试
 *
 * 验证：私有/内部地址被拒绝、官方白名单放行、协议限制、DNS 解析。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isPrivateHost, assertSafeBaseUrl, DEFAULT_ALLOWED_HOSTS } from '@/lib/url-safety';

describe('isPrivateHost', () => {
    it('识别 RFC1918 私有 IPv4 段', () => {
        expect(isPrivateHost('10.0.0.1')).toBe(true);
        expect(isPrivateHost('10.255.255.255')).toBe(true);
        expect(isPrivateHost('172.16.0.1')).toBe(true);
        expect(isPrivateHost('172.31.255.255')).toBe(true);
        expect(isPrivateHost('192.168.1.1')).toBe(true);
        // 172.32 不在私有段
        expect(isPrivateHost('172.32.0.1')).toBe(false);
    });

    it('识别环回地址', () => {
        expect(isPrivateHost('127.0.0.1')).toBe(true);
        expect(isPrivateHost('127.1.2.3')).toBe(true);
        expect(isPrivateHost('localhost')).toBe(true);
    });

    it('识别链路本地（含 AWS metadata 169.254.169.254）', () => {
        expect(isPrivateHost('169.254.169.254')).toBe(true);
        expect(isPrivateHost('169.254.0.1')).toBe(true);
    });

    it('识别 0.0.0.0/8 与 CGNAT', () => {
        expect(isPrivateHost('0.0.0.0')).toBe(true);
        expect(isPrivateHost('100.64.0.1')).toBe(true);
    });

    it('公网 IP 不判为私有', () => {
        expect(isPrivateHost('8.8.8.8')).toBe(false);
        expect(isPrivateHost('1.1.1.1')).toBe(false);
        expect(isPrivateHost('142.250.190.46')).toBe(false);
    });

    it('多播/保留段判为私有', () => {
        expect(isPrivateHost('224.0.0.1')).toBe(true);
        expect(isPrivateHost('240.0.0.1')).toBe(true);
    });

    it('公网 IPv6（如 Cloudflare）不判为私有', () => {
        // 关键修复：此前任何非白名单 IPv6 都被误判 private，误杀公网 provider
        expect(isPrivateHost('2606:4700:4700::1111')).toBe(false); // Cloudflare DNS
        expect(isPrivateHost('2606:4700::1111')).toBe(false);
        expect(isPrivateHost('2a00:1450:4001:830::200e')).toBe(false); // Google 公网
    });

    it('私有/内部 IPv6 仍判为私有', () => {
        expect(isPrivateHost('::1')).toBe(true); // 环回
        expect(isPrivateHost('0:0:0:0:0:0:0:1')).toBe(true);
        expect(isPrivateHost('::')).toBe(true); // 未指定
        expect(isPrivateHost('fe80::1')).toBe(true); // 链路本地
        expect(isPrivateHost('febf::1')).toBe(true); // fe80::/10 上界
        expect(isPrivateHost('fc00::1')).toBe(true); // ULA
        expect(isPrivateHost('fd00::1')).toBe(true); // ULA
        expect(isPrivateHost('ff00::1')).toBe(true); // 多播
        expect(isPrivateHost('2001:db8::1')).toBe(true); // 文档保留
        expect(isPrivateHost('::ffff:10.0.0.1')).toBe(true); // IPv4-mapped 私网
        expect(isPrivateHost('::ffff:169.254.169.254')).toBe(true); // 映射到 metadata
        expect(isPrivateHost('::ffff:8.8.8.8')).toBe(false); // 映射到公网 IPv4 应放行
    });
});

describe('assertSafeBaseUrl', () => {
    beforeEach(() => {
        vi.resetModules();
    });

    it('官方 Gemini host 在白名单内，直接放行（不做 DNS）', async () => {
        const r = await assertSafeBaseUrl('https://generativelanguage.googleapis.com/v1beta');
        expect(r.ok).toBe(true);
        // 路径被保留（去除尾部斜杠）
        expect(r.origin).toBe('https://generativelanguage.googleapis.com/v1beta');
    });

    it('官方 OpenAI host 在白名单内放行', async () => {
        const r = await assertSafeBaseUrl('https://api.openai.com/v1');
        expect(r.ok).toBe(true);
    });

    it('拒绝非 http/https 协议（防 file:///etc/passwd）', async () => {
        const r = await assertSafeBaseUrl('file:///etc/passwd');
        expect(r.ok).toBe(false);
    });

    it('拒绝空输入', async () => {
        const r = await assertSafeBaseUrl('');
        expect(r.ok).toBe(false);
    });

    it('拒绝非法 URL', async () => {
        const r = await assertSafeBaseUrl('not-a-url');
        expect(r.ok).toBe(false);
    });

    it('拒绝 IP 字面值内网地址（关闭 DNS 时）', async () => {
        const r = await assertSafeBaseUrl('http://10.0.0.5:8080', [], false);
        expect(r.ok).toBe(false);
    });

    it('拒绝 metadata 服务地址', async () => {
        const r = await assertSafeBaseUrl('http://169.254.169.254/latest/meta-data', [], false);
        expect(r.ok).toBe(false);
    });

    it('拒绝 localhost', async () => {
        const r = await assertSafeBaseUrl('http://localhost:3000', [], false);
        expect(r.ok).toBe(false);
    });

    it('额外白名单 host 放行', async () => {
        const r = await assertSafeBaseUrl('https://my-gateway.example.com', ['my-gateway.example.com'], false);
        expect(r.ok).toBe(true);
    });

    it('白名单 host 的子域也放行', async () => {
        const r = await assertSafeBaseUrl('https://eu.gcp.gemini.example.com', ['gcp.gemini.example.com'], false);
        expect(r.ok).toBe(true);
    });

    it('规范 origin 保留路径（去除尾部斜杠）', async () => {
        // 必须保留 /v1 这类路径，否则破坏 OpenAI 默认 baseUrl
        const r = await assertSafeBaseUrl('https://api.openai.com/v1/some/path');
        expect(r.origin).toBe('https://api.openai.com/v1/some/path');
        const r2 = await assertSafeBaseUrl('https://api.openai.com/v1/');
        expect(r2.origin).toBe('https://api.openai.com/v1');
    });

    it('拒绝 IPv6 回环字面量（带方括号）', async () => {
        expect((await assertSafeBaseUrl('http://[::1]/', [], false)).ok).toBe(false);
        expect((await assertSafeBaseUrl('http://[::]/', [], false)).ok).toBe(false);
    });

    it('拒绝 IPv6 ULA / link-local 字面量', async () => {
        expect((await assertSafeBaseUrl('http://[fc00::1]/', [], false)).ok).toBe(false);
        expect((await assertSafeBaseUrl('http://[fe80::1]/', [], false)).ok).toBe(false);
    });

    it('DNS 解析到内网地址时拒绝（mocked）', async () => {
        // rebind-attack.example.com → 解析为 10.0.0.1
        const dns = await import('dns');
        vi.spyOn(dns.promises, 'lookup').mockResolvedValue([
            { address: '10.0.0.1', family: 4 },
        ] as never);
        const r = await assertSafeBaseUrl('https://rebind.example.com');
        expect(r.ok).toBe(false);
        vi.restoreAllMocks();
    });

    it('DEFAULT_ALLOWED_HOSTS 包含 Gemini 与 OpenAI 官方主机', () => {
        expect(DEFAULT_ALLOWED_HOSTS.has('generativelanguage.googleapis.com')).toBe(true);
        expect(DEFAULT_ALLOWED_HOSTS.has('api.openai.com')).toBe(true);
    });

    it('用户实际 provider 网关在默认白名单内，直接放行（不做 DNS）', async () => {
        // 关键修复：此前默认白名单只有 google/openai，agnes/智谱/商汤被误判私网拒绝
        expect(DEFAULT_ALLOWED_HOSTS.has('apihub.agnes-ai.com')).toBe(true);
        expect(DEFAULT_ALLOWED_HOSTS.has('open.bigmodel.cn')).toBe(true);
        expect(DEFAULT_ALLOWED_HOSTS.has('token.sensenova.cn')).toBe(true);

        // resolves 断言必须 await，否则 Vitest 会告警且断言未真正完成
        await expect(assertSafeBaseUrl('https://apihub.agnes-ai.com/v1')).resolves.toMatchObject({ ok: true });
        await expect(assertSafeBaseUrl('https://open.bigmodel.cn/api/paas/v4')).resolves.toMatchObject({ ok: true });
        await expect(assertSafeBaseUrl('https://token.sensenova.cn/v1')).resolves.toMatchObject({ ok: true });
    });

    it('公网 IPv6 字面量 baseUrl 放行（关闭 DNS 时）', async () => {
        // 关键修复：公网 IPv6 不再被 isPrivateHost 误杀
        const r = await assertSafeBaseUrl('https://[2606:4700:4700::1111]/v1', [], false);
        expect(r.ok).toBe(true);
    });
});
