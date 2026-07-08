-- CreateTable：全局应用配置表（单行，id 固定为 1）
-- 整个 AppConfig 序列化为 JSON 存于 value；API Key 字段在写入前加密。
CREATE TABLE "AppSetting" (
    "id" INTEGER NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AppSetting_pkey" PRIMARY KEY ("id")
);
