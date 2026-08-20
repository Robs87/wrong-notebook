import { describe, expect, it } from 'vitest';
import { normalizeProxyUrl } from '@/lib/proxy';

describe('proxy URL validation', () => {
    it('空值表示直连', () => {
        expect(normalizeProxyUrl('')).toEqual({ ok: true, url: undefined });
        expect(normalizeProxyUrl(undefined)).toEqual({ ok: true, url: undefined });
    });

    it.each([
        'http://127.0.0.1:7890',
        'https://proxy.example.com:8443',
        'socks5://127.0.0.1:1080',
    ])('接受支持的代理协议：%s', (url) => {
        const result = normalizeProxyUrl(url);
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.url).toBe(url);
    });

    it('拒绝不支持的代理协议', () => {
        const result = normalizeProxyUrl('ftp://proxy.example.com:21');
        expect(result).toMatchObject({ ok: false });
    });

    it('拒绝缺少主机的代理地址', () => {
        const result = normalizeProxyUrl('http://:7890');
        expect(result).toMatchObject({ ok: false });
    });
});
