#!/usr/bin/env node

/**
 * wrong-notebook 部署配置引导脚本
 * =================================
 * 在新机器上克隆仓库后，运行此脚本生成 app-config.json
 * 包含一建备考自定义提示词 + AI 提供商占位配置
 *
 * 用法：
 *   1. 克隆仓库 + 创建目录
 *      git clone https://github.com/Robs87/wrong-notebook.git
 *      cd wrong-notebook
 *      mkdir -p data config
 *
 *   2. 运行引导脚本
 *      node scripts/bootstrap-config.js
 *
 *   3. 按提示填入 AI 提供商信息（API Key 等）
 *      或在生成的 config/app-config.json 中手动编辑
 *
 *   4. 启动容器
 *      docker compose up -d
 *
 *   5. （可选）初始化后通过 Web UI → 设置页面修改
 */

const fs = require('fs');
const path = require('path');
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

async function main() {
  console.log(`
╔══════════════════════════════════════════════════╗
║   wrong-notebook 部署配置引导                     ║
║   一建定制版                                       ║
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
  console.log(`   analyze:  ${promptData.analyze.length} 字符`);
  console.log(`   similar:  ${promptData.similar.length} 字符`);
  console.log(`   reanswer: ${promptData.reanswer.length} 字符`);

  // ========================
  // 2. 收集 AI 提供商配置
  // ========================
  console.log('\n📡 AI 提供商配置');
  console.log('支持：OpenAI 兼容接口（agnes/GLM/DeepSeek 等）、Gemini、Azure\n');

  const provider = await prompt('选择默认 AI 提供商 [openai/gemini/azure] (默认: openai): ') || 'openai';

  let config = {
    aiProvider: provider,
    allowRegistration: false,
    openai: {
      instances: [],
      activeInstanceId: '',
    },
    gemini: {
      apiKey: '',
      baseUrl: '',
      model: 'gemini-2.0-flash',
    },
    azure: {
      apiKey: '',
      endpoint: '',
      deployment: '',
      apiVersion: '2024-02-15-preview',
      model: 'gpt-4o',
    },
    prompts: {
      analyze: '',
      similar: '',
    },
    timeouts: {
      analyze: 180000,
    },
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
      config.openai.instances.push({
        id,
        name,
        apiKey: apiKey || 'YOUR_API_KEY_HERE',
        baseUrl,
        model,
      });
      if (i === 0) config.openai.activeInstanceId = id;
    }
  } else if (provider === 'gemini') {
    config.gemini.apiKey = await prompt('Gemini API Key (留空则设为占位符): ') || 'YOUR_GEMINI_API_KEY';
    config.gemini.model = await prompt('模型 (默认: gemini-2.0-flash): ') || 'gemini-2.0-flash';
  } else if (provider === 'azure') {
    config.azure.apiKey = await prompt('Azure API Key: ') || 'YOUR_AZURE_KEY';
    config.azure.endpoint = await prompt('Endpoint (如 https://xxx.openai.azure.com): ') || 'https://YOUR_ENDPOINT.openai.azure.com';
    config.azure.deployment = await prompt('部署名称: ') || 'gpt-4o';
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
  // 4. 写入文件
  // ========================
  const configDir = path.join(__dirname, '..', 'config');
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  const configPath = path.join(configDir, 'app-config.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
  console.log(`\n✅ 配置文件已生成: ${configPath}`);
  console.log(`   文件大小: ${fs.statSync(configPath).size} 字节`);

  // ========================
  // 5. 后续步骤提示
  // ========================
  console.log(`
╔══════════════════════════════════════════════════╗
║   下一步                                          ║
╚══════════════════════════════════════════════════╝

1. 检查/修改配置
   ${'cat config/app-config.json'}  # 确认 API Key 等

2. 创建数据目录（如果还没有）
   ${'mkdir -p data'}

3. 设置 NEXTAUTH_SECRET
   docker-compose.yml 中的 NEXTAUTH_SECRET= 需要改为随机值
   可以用 ${'openssl rand -base64 32'} 生成

4. 启动容器
   ${'docker compose up -d'}

5. 首次登录
   默认管理员: admin@localhost / 123456
   访问 http://<你的IP>:3000

6. 后续通过 Web UI 修改 AI 配置
   设置页面 → 可增删 AI 实例、切换模型

7. 添加更多一建科目
   在 UI 创建错题本（科目名设为"一建法规"等）
   然后手动编辑 app-config.json 的 prompts.bySubject，
   添加对应的科目提示词，重启容器即可
`);
  rl.close();
}

main().catch((err) => {
  console.error('❌ 错误:', err.message);
  process.exit(1);
});
