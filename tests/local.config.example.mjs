/**
 * 测试配置模板。
 *
 * 使用方法：把本文件复制为同目录下的 local.config.mjs，填入你自己的模型服务信息。
 * local.config.mjs 已在 .gitignore 中排除，不会被提交到版本库。
 *
 * 也可以不建文件，直接用环境变量覆盖：
 *   export AITX_BASE_URL=https://api.deepseek.com/v1
 *   export AITX_API_KEY=sk-xxxx
 *   export AITX_MODEL=deepseek-flash
 */

export const LOCAL_CONFIG = {
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: 'sk-在这里填入你自己的-API-Key',
  model: 'deepseek-flash',
};

export function testSettings() {
  return {
    baseUrl: process.env.AITX_BASE_URL || LOCAL_CONFIG.baseUrl,
    apiKey: process.env.AITX_API_KEY || LOCAL_CONFIG.apiKey,
    model: process.env.AITX_MODEL || LOCAL_CONFIG.model,
    targetLang: 'zh-CN',
    displayMode: 'replace',
    disableThinking: true,
    batchSize: 20,
    concurrency: 3,
    temperature: 0.2,
    timeoutMs: 90000,
    summaryStyle: 'bullets',
  };
}
