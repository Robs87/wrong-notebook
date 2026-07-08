/**
 * SSRF 防护：校验用户可控的 baseUrl / endpoint，防止服务端请求伪造。
 *
 * 第一性原理：服务器永远不应基于用户输入无约束地发起出站请求，
 * 否则攻击者可借此探测内网（RFC1918 / 链路本地）或云元数据服务。
 */
import { promises as dns } from 'dns';
import net from 'net';

/** 默认允许的 provider 官方主机白名单。 */
export const DEFAULT_ALLOWED_HOSTS = new Set<string>([
    'generativelanguage.googleapis.com',
    'api.openai.com',
    // 用户实际使用的 OpenAI 兼容 provider 网关（Cloudflare/智谱/商汤等公网入口）
    'apihub.agnes-ai.com',
    'open.bigmodel.cn',
    'token.sensenova.cn',
]);

/**
 * 判断 IPv4 字面量是否属于私有/内部/保留段。
 * 覆盖 RFC1918、环回、0.0.0.0/8、链路本地（含 AWS metadata）、CGNAT、多播/保留。
 */
function isPrivateIPv4(ip: string): boolean {
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
        return true; // 无法解析为合法 IPv4，按危险处理
    }
    const [a, b] = parts;
    if (a === 10) return true;
    if (a === 127) return true; // loopback
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 169 && b === 254) return true; // link-local（含 AWS metadata 169.254.169.254）
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // 多播/保留段
    return false;
}

/**
 * 判断 IPv6 字面量（已去方括号、小写）是否属于私有/内部/保留段。
 * 只拒绝明确的私有段：环回/未指定、链路本地(fe80::/10)、ULA(fc00::/7)、多播(ff00::/8)、
 * 文档保留(2001:db8::/32)，以及 IPv4-mapped/compatible 映射到私网 IPv4 的地址。
 * 关键修复：公网 IPv6（如 Cloudflare 2606:4700::）不再被误判为 private。
 */
function isPrivateIPv6(ip: string): boolean {
    if (ip === '::1' || ip === '::' || ip === '0:0:0:0:0:0:0:1') return true; // loopback / unspecified

    // IPv4-mapped (::ffff:a.b.c.d) 或 IPv4-compatible (::a.b.c.d)：映射 IPv4 私网即视为私网
    const mapped = ip.match(/^(?:::ffff:|::)(\d{1,3}(?:\.\d{1,3}){3})$/i);
    if (mapped && ip !== '::1') {
        return isPrivateIPv4(mapped[1]);
    }

    const first = ip.split(':')[0].toLowerCase();
    if (/^fe[89ab]/.test(first)) return true; // fe80::/10 链路本地（fe80~febf）
    if (first.startsWith('fc') || first.startsWith('fd')) return true; // fc00::/7 ULA
    if (first.startsWith('ff')) return true; // ff00::/8 多播
    if (ip.startsWith('2001:db8:')) return true; // 文档保留

    // 合法公网 IPv6 放行；含冒号但格式非法的保守拒绝
    return !net.isIPv6(ip);
}

/**
 * 判断一个主机名/IP字符串是否指向私有/内部网络。
 * 覆盖 IPv4 私有段、环回、链路本地、IPv6 私有段；公网 IPv4/IPv6 不判为私有。
 */
export function isPrivateHost(host: string): boolean {
    const lower = host.toLowerCase();
    if (lower === 'localhost' || lower.endsWith('.localhost')) return true;

    // URL.hostname 对 IPv6 字面量会带方括号（如 [::1]），统一去除后再判断
    const cleaned = lower.replace(/^\[|]$/g, '');

    // 含冒号 → IPv6 字面量（含 IPv4-mapped/compatible 混合记法）
    if (cleaned.includes(':')) {
        return isPrivateIPv6(cleaned);
    }
    if (net.isIPv4(cleaned)) {
        return isPrivateIPv4(cleaned);
    }
    return false;
}

/**
 * 解析主机名为 IP，判断是否解析到私有地址（防 DNS rebinding / 内网域名）。
 * 任一 A 记录落在私有段即视为不安全。
 */
export async function resolvesToPrivateHost(host: string): Promise<boolean> {
    // 非 IP 字面值才做 DNS 解析
    if (net.isIP(host)) return isPrivateHost(host);
    try {
        const records = await dns.lookup(host, { all: true, family: 0 });
        if (records.length === 0) return true; // 解析失败，按危险处理
        return records.some((r) => isPrivateHost(r.address));
    } catch {
        return true; // 解析失败，保守拒绝
    }
}

export interface SafeBaseUrlResult {
    ok: boolean;
    /** 规范化后的 origin（含协议，无尾斜杠），可直接拼接路径。 */
    origin?: string;
    error?: string;
}

/**
 * 校验用户提供的 baseUrl/endpoint 是否安全。
 * @param raw 用户输入（可能含路径）
 * @param allowedHosts 额外允许的主机白名单（除官方默认外，admin 可配置的自建网关）
 * @param checkDns 是否做 DNS 解析校验（默认 true）
 */
export async function assertSafeBaseUrl(
    raw: string,
    allowedHosts: Iterable<string> = [],
    checkDns = true
): Promise<SafeBaseUrlResult> {
    if (!raw) return { ok: false, error: 'Empty base URL' };

    let parsed: URL;
    try {
        parsed = new URL(raw);
    } catch {
        return { ok: false, error: 'Invalid URL' };
    }

    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        return { ok: false, error: `Unsupported protocol: ${parsed.protocol}` };
    }

    // URL.hostname 对 IPv6 字面量会带方括号（如 [::1]），统一去除后再判断
    const host = parsed.hostname.replace(/^\[|]$/g, '');
    const allowSet = new Set([...DEFAULT_ALLOWED_HOSTS, ...allowedHosts]);

    // 安全原则：私有/内部地址一律拒绝，**即便出现在白名单里也不能放行**
    // （防止 body 可控的 allowedHosts 绕过私网检查）
    if (isPrivateHost(host)) {
        return { ok: false, error: `Blocked private/internal host: ${host}` };
    }

    // 主机名白名单优先：命中即放行（官方 provider）
    const hostInAllowlist = [...allowSet].some(
        (h) => host === h || host.endsWith(`.${h}`)
    );

    if (!hostInAllowlist) {
        // 非白名单主机：还需确认不解析到内网（防 DNS rebinding / 内网域名）
        if (checkDns && (await resolvesToPrivateHost(host))) {
            return { ok: false, error: `Host resolves to private address: ${host}` };
        }
    }

    // 保留 pathname（如 /v1），只去除 query/hash，避免破坏 OpenAI 默认 baseUrl 的 /v1 路径
    const safeOrigin = `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, '')}`;
    return { ok: true, origin: safeOrigin };
}
