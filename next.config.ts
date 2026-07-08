import type { NextConfig } from "next";

const securityHeaders = [
  // 阻止 MIME 嗅探
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  // 控制引用信息，减少跨站信息泄漏
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  // 防点击劫持（本应用非框架嵌套场景）
  { key: 'X-Frame-Options', value: 'DENY' },
  // 限制跨域权限，按需收窄
  { key: 'Permissions-Policy', value: 'camera=(self), microphone=(), geolocation=()' },
];

const nextConfig: NextConfig = {
  output: 'standalone',
  serverExternalPackages: ['@prisma/client', 'bcryptjs'],
  // 不暴露 X-Powered-By: Next.js
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
