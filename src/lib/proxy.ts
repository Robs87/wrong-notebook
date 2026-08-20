import { ProxyAgent } from 'undici';

const SUPPORTED_PROXY_PROTOCOLS = new Set(['http:', 'https:', 'socks:', 'socks5:']);
const proxyAgentCache = new Map<string, ProxyAgent>();

export type ProxyUrlValidation =
    | { ok: true; url?: string }
    | { ok: false; error: string };

/**
 * Validate an optional per-instance proxy URL.
 *
 * Proxy hosts are intentionally not passed through the AI endpoint SSRF
 * allowlist: a local proxy (for example 127.0.0.1:7890) is a valid, explicit
 * administrator choice. The URL is still restricted to protocols supported by
 * undici's ProxyAgent.
 */
export function normalizeProxyUrl(raw?: string): ProxyUrlValidation {
    const value = raw?.trim() || '';
    if (!value) return { ok: true, url: undefined };

    let parsed: URL;
    try {
        parsed = new URL(value);
    } catch {
        return { ok: false, error: 'Proxy URL is invalid' };
    }

    if (!SUPPORTED_PROXY_PROTOCOLS.has(parsed.protocol)) {
        return { ok: false, error: 'Proxy protocol is not supported' };
    }
    if (!parsed.hostname) {
        return { ok: false, error: 'Proxy host is required' };
    }

    return { ok: true, url: value };
}

/** Return a cached dispatcher for an instance-level proxy, or undefined for direct access. */
export function getProxyAgent(raw?: string): ProxyAgent | undefined {
    const validation = normalizeProxyUrl(raw);
    if (!validation.ok) throw new Error(validation.error);
    if (!validation.url) return undefined;

    const cached = proxyAgentCache.get(validation.url);
    if (cached) return cached;

    try {
        const agent = new ProxyAgent(validation.url);
        proxyAgentCache.set(validation.url, agent);
        return agent;
    } catch {
        throw new Error('Proxy URL is invalid');
    }
}
