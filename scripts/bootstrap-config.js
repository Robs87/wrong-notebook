#!/usr/bin/env node

/**
 * wrong-notebook 部署配置引导脚本（M5 改造版）
 * =============================================
 * 配置已从 config/app-config.json 迁移到 Prisma AppSetting 表。
 * 本脚本交互式收集一建提示词 + AI 提供商配置，加密密钥后直接写入数据库。
 *
 * 用法：
 *   1. 克隆仓库 + 创建目录
 *      git clone https://github.com/Robs87/wrong-notebook.git
 *      cd wrong-notebook
 *      mkdir -p data config
 *
 *   2. 确保已运行 prisma migrate（建表）：
 *      npx prisma migrate deploy
 *
 *   3. 设置 NEXTAUTH_SECRET（配置密钥用它派生加密）
 *      export NEXTAUTH_SECRET="$(openssl rand -base64 32)"
 *
 *   4. 运行引导脚本
 *      node scripts/bootstrap-config.js
 *
 *   5. 启动容器 / 开发服务
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function generateId() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function prompt(question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

// ============ 密钥加密（与 src/lib/crypto-utils.ts 保持一致） ============
const ALGO = 'aes-256-gcm';
const KEY_LEN = 32;
const IV_LEN = 12;
const HKDF_INFO = 'wrong-notebook-config-encryption-v1';
const HKDF_SALT = 'wrong-notebook';
const CIPHER_PREFIX = 'enc:v1:';

function getDerivedKey() {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) {
    console.warn('⚠️  NEXTAUTH_SECRET 未设置，密钥将以明文写入数据库。强烈建议先设置 NEXTAUTH_SECRET。');
    return null;
  }
  const derived = crypto.hkdfSync('sha256', secret, HKDF_SALT, HKDF_INFO, KEY_LEN);
  return Buffer.from(derived);
}

function encryptSecret(plaintext) {
  if (!plaintext) return '';
  const key = getDerivedKey();
  if (!key) return plaintext; // 无 secret 退化明文
  try {
    const iv = crypto.randomBytes(IV_LEN);
    const cipher = crypto.createCipheriv(ALGO, key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${CIPHER_PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
  } catch (e) {
    console.warn(`⚠️  加密失败，该密钥将以明文存储: ${e.message}`);
    return plaintext;
  }
}

function encryptAppConfig(config) {
  const copy = JSON.parse(JSON.stringify(config));
  if (copy.gemini?.apiKey) copy.gemini.apiKey = encryptSecret(copy.gemini.apiKey);
  if (copy.azure?.apiKey) copy.azure.apiKey = encryptSecret(copy.azure.apiKey);
  if (copy.openai?.instances) {
    copy.openai.instances = copy.openai.instances.map((inst) => ({
      ...inst,
      apiKey: encryptSecret(inst.apiKey),
    }));
  }
  return copy;
}

async function main() {
  console.log(`
╔══════════════════════════════════════════════════╗
║   wrong-notebook 部署配置引导                     ║
║   一建定制版（配置写入数据库）                     ║
╚══════════════════════════════════════════════════╝
`);

  // ========================
  // 1. 读取一建提示词模板
  // ========================
  const snippetPath = path.join(__dirname, '..', '一建备考提示词-config-snippet.json');
  if (!fs.existsSync(snippetPath)) {
    console.error('❌ 未找到 一建备考提示词-config-snippet.json');
    console.error('   请确保在仓库根目录运行此脚本');
    process.exit(1);
  }
  const promptData = JSON.parse(fs.readFileSync(snippetPath, 'utf-8'));
  console.log('✅ 已加载一建提示词模板');

  // ========================
  // 2. 收集 AI 提供商配置
  // ========================
  console.log('\n📡 AI 提供商配置\n');

  const provider = await prompt('选择默认 AI 提供商 [openai/gemini/azure] (默认: openai): ') || 'openai';

  let config = {
    aiProvider: provider,
    allowRegistration: false,
    openai: { instances: [], activeInstanceId: '' },
    gemini: { apiKey: '', baseUrl: '', model: 'gemini-2.0-flash' },
    azure: { apiKey: '', endpoint: '', deploymentName: '', apiVersion: '2024-02-15-preview', model: 'gpt-4o' },
    prompts: { analyze: '', similar: '', reanswer: '' },
    timeouts: { analyze: 180000 },
  };

  if (provider === 'openai') {
    const instanceCount = parseInt(
      await prompt('配置几个 OpenAI 兼容实例？(默认: 1): ') || '1',
      10
    );
    for (let i = 0; i < instanceCount; i++) {
      console.log(`\n--- 实例 ${i + 1} ---`);
      const name = await prompt(`  实例名称 (默认: instance-${i + 1}): `) || `instance-${i + 1}`;
      const apiKey = await prompt(`  API Key (留空则设为占位符): `);
      const baseUrl = await prompt(`  Base URL (默认: https://api.openai.com/v1): `) || 'https://api.openai.com/v1';
      const model = await prompt(`  模型名 (默认: gpt-4o): `) || 'gpt-4o';
      const id = generateId();
      config.openai.instances.push({ id, name, apiKey: apiKey || 'YOUR_API_KEY_HERE', baseUrl, model });
      if (i === 0) config.openai.activeInstanceId = id;
    }
  } else if (provider === 'gemini') {
    config.gemini.apiKey = await prompt('Gemini API Key (留空则设为占位符): ') || 'YOUR_GEMINI_API_KEY';
    config.gemini.model = await prompt('模型 (默认: gemini-2.0-flash): ') || 'gemini-2.0-flash';
  } else if (provider === 'azure') {
    config.azure.apiKey = await prompt('Azure API Key: ') || 'YOUR_AZURE_KEY';
    config.azure.endpoint = await prompt('Endpoint (如 https://xxx.openai.azure.com): ') || 'https://YOUR_ENDPOINT.openai.azure.com';
    config.azure.deploymentName = await prompt('部署名称: ') || 'gpt-4o';
    config.azure.model = await prompt('模型 (默认: gpt-4o): ') || 'gpt-4o';
  }

  // ========================
  // 3. 注入一建提示词到 bySubject
  // ========================
  console.log('\n🔄 注入一建提示词...');
  config.prompts.bySubject = {};
  for (const subject of ['一建管理', '一建经济']) {
    config.prompts.bySubject[subject] = {
      analyze: promptData.analyze,
      similar: promptData.similar,
      reanswer: promptData.reanswer,
    };
  }
  console.log('✅ 已注入 2 个科目的自定义提示词');

  // ========================
  // 4. 加密密钥并写入数据库
  // ========================
  console.log('\n🔐 加密 API Key 并写入数据库...');
  const encrypted = encryptAppConfig(config);
  const value = JSON.stringify(encrypted);

  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();
  try {
    await prisma.appSetting.upsert({
      where: { id: 1 },
      update: { value },
      create: { id: 1, value },
    });
    console.log('✅ 配置已写入数据库 AppSetting 表');
  } finally {
    await prisma.$disconnect();
  }

  // ========================
  // 5. 后续步骤提示
  // ========================
  console.log(`
╔══════════════════════════════════════════════════╗
║   下一步                                          ║
╚══════════════════════════════════════════════════╝

1. 设置 NEXTAUTH_SECRET（配置密钥用它派生加密）
   docker-compose.yml 中的 NEXTAUTH_SECRET= 需要改为随机值
   可以用 openssl rand -base64 32 生成

2. 启动容器
   docker compose up -d

3. 首次登录
   在 docker-compose.yml 中设置至少 12 位的 ADMIN_PASSWORD
   管理员邮箱: admin@localhost
   访问 http://<你的IP>:3000

4. 后续通过 Web UI 修改 AI 配置
   设置页面 → 可增删 AI 实例、切换模型

注意：配置已迁移到数据库，不再使用 config/app-config.json。
      如有旧 JSON 文件，应用启动时会自动迁移一次，之后以数据库为准。
`);
  rl.close();
}

main().catch((err) => {
  console.error('❌ 错误:', err.message);
  process.exit(1);
});
