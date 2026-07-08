-- CreateIndex：为核心查询路径添加索引
-- list 接口高频按 userId + createdAt(desc) 分页，并按 subjectId / masteryLevel 筛选
-- 此前 ErrorItem 表零索引，SQLite 上为全表扫描，随错题量线性恶化。
CREATE INDEX "ErrorItem_userId_createdAt_idx" ON "ErrorItem"("userId", "createdAt");
CREATE INDEX "ErrorItem_userId_subjectId_idx" ON "ErrorItem"("userId", "subjectId");
CREATE INDEX "ErrorItem_userId_masteryLevel_idx" ON "ErrorItem"("userId", "masteryLevel");
