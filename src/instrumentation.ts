
export async function register() {
    if (process.env.NEXT_RUNTIME === 'nodejs') {
        const { setupGlobalProxy } = await import('./lib/global-proxy');
        setupGlobalProxy();

        // 启动时从 DB 加载应用配置到内存缓存（含旧 JSON 文件迁移）。
        // getAppConfig() 是同步的，必须在首个请求前完成缓存填充。
        const { loadConfigFromDB } = await import('./lib/config');
        await loadConfigFromDB();
    }
}
