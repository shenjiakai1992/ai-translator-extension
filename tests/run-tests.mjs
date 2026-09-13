/**
 * 自动化测试（不需要浏览器）
 *   A 组：纯函数单元测试
 *   B 组：本地 Mock 服务测试自愈逻辑（拆批重试、思考参数降级、并发控制）
 *   C 组：真实模型接口联调（翻译 / 划词 / 总结 / 错误处理）
 *
 * 运行：node tests/run-tests.mjs
 */

import http from 'node:http';
import { testSettings, LOCAL_CONFIG } from './local.config.mjs';
import { group, test, info, assert, assertEqual, assertMatch, summary } from './harness.mjs';
import {
  chunkArray,
  splitWhitespace,
  parseJsonArray,
  shouldTranslate,
  isProbablyTargetLang,
  truncateText,
  renderSimpleMarkdown,
  escapeHtml,
  hasCJK,
} from '../src/lib/text-utils.js';
import { normalizeChatUrl, inspectBaseUrl, chat, testConnection, resetCapabilityCache } from '../src/lib/llm.js';
import {
  dayKey,
  truncatePreview,
  emptyStats,
  addUsage,
  pruneStats,
  makeHistoryEntry,
  pushHistory,
  summarizeStats,
  HISTORY_HARD_LIMIT,
  PREVIEW_LIMIT,
} from '../src/lib/history.js';
import { translateTexts, translateOne, summarizeContent, mapPool } from '../src/lib/translator.js';
import { languagePrompt } from '../src/lib/settings.js';

/* ------------------------------------------------------------------ */
/* A 组：纯函数                                                        */
/* ------------------------------------------------------------------ */

async function runUnitTests() {
  group('A. 纯函数单元测试');

  await test('chunkArray 能正确切块且不丢项', () => {
    const arr = Array.from({ length: 25 }, (_, i) => i);
    const chunks = chunkArray(arr, 10);
    assertEqual(chunks.length, 3);
    assertEqual(chunks[2].length, 5);
    assertEqual(chunks.flat().length, 25);
    assertEqual(chunkArray([], 5).length, 0, '空数组应返回空');
    assertEqual(chunkArray(arr, 0).length, 25, 'size 非法时应退化为 1');
  });

  await test('splitWhitespace 保留首尾空白', () => {
    const r = splitWhitespace('  Hello world  ');
    assertEqual(r.prefix, '  ');
    assertEqual(r.core, 'Hello world');
    assertEqual(r.suffix, '  ');
    const r2 = splitWhitespace('没有空白');
    assertEqual(r2.prefix, '');
    assertEqual(r2.core, '没有空白');
  });

  await test('parseJsonArray 能吃下各种模型输出格式', () => {
    assertEqual(JSON.stringify(parseJsonArray('["a","b"]')), '["a","b"]');
    assertEqual(JSON.stringify(parseJsonArray('```json\n["a","b"]\n```')), '["a","b"]');
    assertEqual(
      JSON.stringify(parseJsonArray('好的，结果如下：\n["你好","世界"]\n希望有帮助！')),
      '["你好","世界"]',
      '应能从多余文字中提取数组'
    );
    assertEqual(
      JSON.stringify(parseJsonArray('{"translations":["x","y"]}')),
      '["x","y"]',
      '应能识别对象包裹的数组'
    );
    assertEqual(JSON.stringify(parseJsonArray('1. 你好\n2. 世界')), '["你好","世界"]', '应支持编号列表兜底');
    assertEqual(parseJsonArray('完全无法解析的内容'), null, '垃圾输入应返回 null');
    assertEqual(parseJsonArray(''), null);
    assertEqual(JSON.stringify(parseJsonArray('["a", 3, null]')), '["a","3",""]', '非字符串元素应被规范化');
    // expectedLength 相关：单条宽松、多条严格
    assertEqual(
      JSON.stringify(parseJsonArray('你好世界', 1)),
      '["你好世界"]',
      '只翻一条时，模型直接给纯译文应当接受'
    );
    assertEqual(
      parseJsonArray('1. 你好\n2. 世界', 5),
      null,
      '条数不吻合时，编号列表兜底必须拒绝'
    );
    assertEqual(
      JSON.stringify(parseJsonArray('1. 你好\n2. 世界', 2)),
      '["你好","世界"]',
      '条数吻合时应接受编号列表'
    );
  });

  await test('shouldTranslate 能过滤掉不值得翻译的内容', () => {
    assert(shouldTranslate('Hello world'), '正常英文应通过');
    assert(shouldTranslate('中文文本'), '中文应通过');
    assert(!shouldTranslate('   '), '空白应过滤');
    assert(!shouldTranslate('12345'), '纯数字应过滤');
    assert(!shouldTranslate('!!!???'), '纯符号应过滤');
    assert(!shouldTranslate('https://example.com/a/b'), '纯网址应过滤');
    assert(!shouldTranslate('a'.repeat(5000)), '超长文本应过滤');
    assert(!shouldTranslate(null), 'null 应过滤');
  });

  await test('isProbablyTargetLang 正确识别已是目标语言的文本', () => {
    assert(isProbablyTargetLang('这是一段中文内容', 'zh-CN'), '纯中文在中文目标下应被识别');
    assert(!isProbablyTargetLang('This is English', 'zh-CN'), '英文不应被识别为中文');
    assert(!isProbablyTargetLang('中文 with English', 'zh-CN'), '中英混排应翻译');
    assert(!isProbablyTargetLang('这是中文', 'en'), '目标是英文时中文要翻译');
  });

  await test('truncateText 在句子边界截断', () => {
    const text = '第一句话。第二句话。第三句话。'.repeat(20);
    const out = truncateText(text, 30);
    assert(out.length <= 30, `截断后长度应不超过 30，实际 ${out.length}`);
    assert(out.endsWith('。'), '应在句末截断');
    assertEqual(truncateText('短的', 100), '短的', '短文本不应改动');
  });

  await test('renderSimpleMarkdown 正确渲染且转义 XSS', () => {
    const html = renderSimpleMarkdown('# 标题\n\n**加粗** 内容\n\n- 项目一\n- 项目二\n\n1. 有序');
    assert(html.includes('<h3>标题</h3>'), '标题应渲染');
    assert(html.includes('<strong>加粗</strong>'), '加粗应渲染');
    assert(html.includes('<li>项目一</li>'), '无序列表应渲染');
    assert(html.includes('<ol>'), '有序列表应渲染');
    const evil = renderSimpleMarkdown('<img src=x onerror=alert(1)>');
    assert(!evil.includes('<img'), '危险标签必须被转义');
    assert(evil.includes('&lt;img'), '应输出转义后的文本');
    assertEqual(escapeHtml('a<b>c&d'), 'a&lt;b&gt;c&amp;d');
  });

  await test('normalizeChatUrl 兼容各种 Base URL 写法', () => {
    assertEqual(normalizeChatUrl('https://api.deepseek.com'), 'https://api.deepseek.com/v1/chat/completions');
    assertEqual(normalizeChatUrl('https://api.deepseek.com/v1'), 'https://api.deepseek.com/v1/chat/completions');
    assertEqual(
      normalizeChatUrl('https://api.deepseek.com/v1/chat/completions'),
      'https://api.deepseek.com/v1/chat/completions'
    );
    assertEqual(normalizeChatUrl('https://api.openai.com/v1/'), 'https://api.openai.com/v1/chat/completions');
    assertEqual(normalizeChatUrl('api.deepseek.com'), 'https://api.deepseek.com/v1/chat/completions');
    assertEqual(
      normalizeChatUrl('https://platform.deepseek.com/api_keys'),
      'https://api.deepseek.com/v1/chat/completions',
      '密钥管理页应被自动纠正为接口地址'
    );
  });

  await test('inspectBaseUrl 能识别常见误填', () => {
    assert(inspectBaseUrl('https://platform.deepseek.com/api_keys').ok === false, '应识别密钥页误填');
    assert(inspectBaseUrl('api.deepseek.com').ok === false, '缺少协议头应提示');
    assert(inspectBaseUrl('https://api.deepseek.com/v1').ok === true, '正确地址应通过');
    assert(inspectBaseUrl('').ok === false, '空值应提示');
  });

  await test('mapPool 并发数受控', async () => {
    let running = 0;
    let peak = 0;
    const items = Array.from({ length: 12 }, (_, i) => i);
    const out = await mapPool(items, 3, async (x) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 20));
      running--;
      return x * 2;
    });
    assert(peak <= 3, `并发峰值应不超过 3，实际 ${peak}`);
    assertEqual(out.length, 12);
    assertEqual(out[11], 22, '结果顺序应保持一致');
  });

  await test('hasCJK / languagePrompt 辅助函数正常', () => {
    assert(hasCJK('中文'), '应识别中文');
    assert(!hasCJK('abc'), '不应把英文当中文');
    assertEqual(languagePrompt('zh-CN'), '简体中文');
    assertEqual(languagePrompt('en'), '英语');
    assertEqual(languagePrompt('未知语言'), '简体中文', '未知语言应回退到简体中文');
  });
}

/* ------------------------------------------------------------------ */
/* A2 组：历史记录与用量统计（纯函数）                                 */
/* ------------------------------------------------------------------ */

async function runHistoryTests() {
  group('A2. 历史记录与用量统计（纯函数）');

  await test('dayKey 按本地时区生成 YYYY-MM-DD', () => {
    assertEqual(dayKey(new Date(2026, 8, 13, 0, 0, 0).getTime()), '2026-09-13');
    assertEqual(dayKey(new Date(2026, 0, 5, 23, 59, 0).getTime()), '2026-01-05');
    assertMatch(dayKey(), /^\d{4}-\d{2}-\d{2}$/, '默认参数应返回今天的日期串');
  });

  await test('truncatePreview 超长才截断，并标注原长度', () => {
    assertEqual(truncatePreview('短文本'), '短文本');
    assertEqual(truncatePreview(''), '');
    const long = 'a'.repeat(PREVIEW_LIMIT + 50);
    const out = truncatePreview(long);
    assert(out.length > PREVIEW_LIMIT, '应保留截断提示');
    assert(out.startsWith('a'.repeat(PREVIEW_LIMIT)), '前缀应保留原文');
    assert(out.includes(`共 ${long.length} 字`), '应标注原始长度');
    assertEqual(truncatePreview(long, 10).slice(0, 10), 'aaaaaaaaaa', '自定义长度应生效');
  });

  await test('addUsage 按天/模型/类型三个维度累加', () => {
    let stats = emptyStats();
    stats = addUsage(stats, { ts: new Date(2026, 8, 13, 10).getTime(), model: 'm1', type: 'page', prompt: 100, completion: 50, chars: 200, items: 5 });
    stats = addUsage(stats, { ts: new Date(2026, 8, 13, 15).getTime(), model: 'm1', type: 'selection', prompt: 20, completion: 10, chars: 30, items: 1 });
    stats = addUsage(stats, { ts: new Date(2026, 8, 12, 9).getTime(), model: 'm2', type: 'summary', prompt: 300, completion: 100, chars: 900, items: 1 });

    assertEqual(stats.total.requests, 3);
    assertEqual(stats.total.prompt, 420);
    assertEqual(stats.total.completion, 160);
    assertEqual(stats.total.tokens, 580, 'tokens 应在缺省时自动取 prompt+completion');
    assertEqual(stats.total.chars, 1130);
    assertEqual(stats.total.items, 7);

    assertEqual(Object.keys(stats.byDay).length, 2, '应分成两天');
    assertEqual(stats.byDay['2026-09-13'].requests, 2);
    assertEqual(stats.byDay['2026-09-13'].tokens, 180);
    assertEqual(stats.byDay['2026-09-12'].tokens, 400);

    assertEqual(stats.byModel.m1.requests, 2);
    assertEqual(stats.byModel.m1.tokens, 180);
    assertEqual(stats.byModel.m2.tokens, 400);
    assertEqual(stats.byType.page.tokens, 150);
    assertEqual(stats.byType.summary.tokens, 400);
    assert(stats.firstAt !== null && stats.updatedAt !== null, '应记录起止时间');
  });

  await test('addUsage 不修改入参（保持函数纯粹）', () => {
    const base = emptyStats();
    const next = addUsage(base, { model: 'm', type: 'page', prompt: 5, completion: 5 });
    assertEqual(base.total.requests, 0, '原对象不应被改动');
    assertEqual(next.total.requests, 1);
  });

  await test('pruneStats 丢弃过期天数，保留近期数据', () => {
    const now = new Date(2026, 8, 13, 12).getTime();
    let stats = emptyStats();
    stats = addUsage(stats, { ts: now, model: 'm', type: 'page', prompt: 10, completion: 10 });
    stats = addUsage(stats, { ts: now - 200 * 86400000, model: 'm', type: 'page', prompt: 99, completion: 99 });
    const pruned = pruneStats(stats, { keepDays: 180, now });
    assertEqual(Object.keys(pruned.byDay).length, 1, '只应留下未过期的那天');
    assertEqual(pruned.total.tokens, 218, '总量统计不受裁剪影响');
  });

  await test('makeHistoryEntry：storeText=false 时不保存正文', () => {
    const entry = makeHistoryEntry({
      ts: 1789285817000,
      type: 'page',
      model: 'deepseek-flash',
      sourceLang: 'auto',
      targetLang: 'zh-CN',
      prompt: 100,
      completion: 60,
      chars: 500,
      items: 10,
      durationMs: 3200,
      src: 'Hello world',
      dst: '你好，世界',
    });
    assertEqual(entry.tokens, 160);
    assertEqual(entry.day, dayKey(1789285817000));
    assertEqual(entry.src, 'Hello world');
    assertEqual(entry.dst, '你好，世界');
    assertMatch(entry.id, /^1789285817000-/, 'id 应包含时间戳前缀');

    const noText = makeHistoryEntry({ src: 'a', dst: 'b', storeText: false });
    assertEqual(noText.src, '', '关闭保存正文时 src 应为空');
    assertEqual(noText.dst, '', '关闭保存正文时 dst 应为空');

    const withError = makeHistoryEntry({ status: 'failed', error: 'x'.repeat(500) });
    assertEqual(withError.status, 'failed');
    assertEqual(withError.error.length, 300, '错误信息应被截断到 300 字');
  });

  await test('pushHistory 新记录在前，并按上限裁剪', () => {
    let list = [];
    for (let i = 0; i < 5; i++) list = pushHistory(list, { id: String(i) }, 3);
    assertEqual(list.length, 3, '应被裁剪到 3 条');
    assertEqual(list[0].id, '4', '最新的应在最前');
    assertEqual(list[2].id, '2');

    let big = [];
    big = pushHistory(big, { id: 'x' }, 99999);
    assertEqual(big.length, 1);
    const capped = pushHistory(
      Array.from({ length: 5 }, (_, i) => ({ id: String(i) })),
      { id: 'new' },
      HISTORY_HARD_LIMIT + 5000
    );
    assert(capped.length <= HISTORY_HARD_LIMIT, `上限应被限制在 ${HISTORY_HARD_LIMIT} 以内`);
  });

  await test('summarizeStats 输出面板需要的全部结构', () => {
    const now = new Date(2026, 8, 13, 12).getTime();
    let stats = emptyStats();
    stats = addUsage(stats, { ts: now, model: 'm1', type: 'page', prompt: 1000000, completion: 500000 });
    stats = addUsage(stats, { ts: now - 3 * 86400000, model: 'm2', type: 'summary', prompt: 200000, completion: 100000 });

    const s = summarizeStats(stats, { days: 14, now, prices: { pricePromptPerM: 1, priceCompletionPerM: 2 } });
    assertEqual(s.series.length, 14, '应返回 14 天序列');
    assertEqual(s.series[13].day, '2026-09-13', '最后一天应是今天');
    assertEqual(s.today.tokens, 1500000);
    assertEqual(s.week.tokens, 1500000 + 300000, '近 7 天应包含 3 天前那笔');
    assertEqual(s.byModel.length, 2);
    assertEqual(s.byModel[0].model, 'm1', '应按 token 倒序');
    assertEqual(s.byType[0].type, 'page');
    assertEqual(s.byType[0].label, '整页翻译', '类型应带上中文名');
    assertEqual(s.priced, true);
    // 1.5M 输入 × 1 元/M = 1.5；1.0M... 实际输入 1.2M、输出 0.6M
    const expectedCost = 1.2 * 1 + 0.6 * 2;
    assert(Math.abs(s.cost - expectedCost) < 1e-9, `费用估算应为 ${expectedCost}，实际 ${s.cost}`);

    const noPrice = summarizeStats(stats, { now });
    assertEqual(noPrice.cost, null, '未设置单价时不应给费用数字');
    assertEqual(noPrice.priced, false);
  });

  await test('summarizeStats 对空数据也安全', () => {
    const s = summarizeStats(emptyStats(), { days: 7 });
    assertEqual(s.total.tokens, 0);
    assertEqual(s.today.tokens, 0);
    assertEqual(s.series.length, 7);
    assertEqual(s.byModel.length, 0);
    assertEqual(s.byType.length, 0);
    assertEqual(s.cost, null);
  });
}

/* ------------------------------------------------------------------ */
/* B 组：本地 Mock 服务，测自愈逻辑                                    */
/* ------------------------------------------------------------------ */

function startMockServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        let parsed = {};
        try {
          parsed = JSON.parse(body);
        } catch {
          /* ignore */
        }
        const reply = (status, payload) => {
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(payload));
        };
        handler(parsed, reply, req);
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function mockReply(content) {
  return {
    id: 'mock',
    model: 'mock-model',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
  };
}

/** 从批量翻译提示词里把输入数组抠出来 */
function extractInputArray(body) {
  const userMsg = body.messages?.find((m) => m.role === 'user')?.content || '';
  const m = userMsg.match(/输入：\n([\s\S]*)$/);
  if (!m) return null;
  try {
    return JSON.parse(m[1].trim());
  } catch {
    return null;
  }
}

async function runMockTests() {
  group('B. 自愈逻辑（本地 Mock 服务）');

  await test('模型输出条数不匹配时，自动拆批直到全部成功', async () => {
    let calls = 0;
    const { server, port } = await startMockServer((body, reply) => {
      calls++;
      const arr = extractInputArray(body);
      if (!arr) return reply(200, mockReply('not json'));
      if (arr.length === 1) return reply(200, mockReply(JSON.stringify(['【' + arr[0] + '】'])));
      // 故意返回条数不对，逼迫上层拆批
      return reply(200, mockReply(JSON.stringify(['错误'])));
    });

    try {
      const settings = { ...testSettings(), baseUrl: `http://127.0.0.1:${port}`, batchSize: 20, concurrency: 1 };
      const texts = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta'];
      const r = await translateTexts({ settings, texts, targetLangLabel: '简体中文' });
      assertEqual(r.translations.length, 8, '应返回 8 条译文');
      r.translations.forEach((t, i) => assertEqual(t, '【' + texts[i] + '】', `第 ${i} 条应来自单条请求`));
      assertEqual(r.stats.failed, 0, '不应有失败项');
      assert(calls > 1, `应触发多次拆批请求，实际 ${calls} 次`);
    } finally {
      server.close();
    }
  });

  await test('单条彻底失败时保留原文并记录错误，不阻塞其他条目', async () => {
    const { server, port } = await startMockServer((body, reply) => {
      const arr = extractInputArray(body);
      if (arr && arr.length === 1) {
        // 单条请求却返回两条 → 条数不匹配，属于彻底失败
        if (arr[0].includes('FAIL')) return reply(200, mockReply(JSON.stringify(['错', '还错'])));
        return reply(200, mockReply(JSON.stringify(['【' + arr[0] + '】'])));
      }
      return reply(200, mockReply(JSON.stringify(['错误'])));
    });
    try {
      const settings = { ...testSettings(), baseUrl: `http://127.0.0.1:${port}`, batchSize: 20, concurrency: 1 };
      const r = await translateTexts({
        settings,
        texts: ['good one', 'FAIL me', 'good two'],
        targetLangLabel: '简体中文',
      });
      assertEqual(r.translations.length, 3);
      assertEqual(r.translations[0], '【good one】');
      assertEqual(r.translations[1], 'FAIL me', '彻底失败的条目应保留原文');
      assertEqual(r.translations[2], '【good two】');
      assertEqual(r.stats.failed >= 1, true, '应记录失败项');
    } finally {
      server.close();
    }
  });

  await test('接口不支持关闭思考参数时自动降级重试', async () => {
    resetCapabilityCache();
    let sawThinking = 0;
    let sawWithout = 0;
    const { server, port } = await startMockServer((body, reply) => {
      if (body.thinking) {
        sawThinking++;
        return reply(400, { error: { message: 'unknown parameter: thinking' } });
      }
      sawWithout++;
      return reply(200, mockReply('["你好","世界"]'));
    });
    try {
      const settings = { ...testSettings(), baseUrl: `http://127.0.0.1:${port}`, disableThinking: true };
      const res = await chat({
        settings,
        messages: [{ role: 'user', content: '把下面 JSON 数组翻译成简体中文：["Hello","World"]' }],
        maxTokens: 256,
      });
      assertEqual(res.text, '["你好","世界"]', '降级后应正常拿到结果');
      assert(sawThinking === 1, '应先带着思考参数试一次');
      assert(sawWithout === 1, '应去掉参数据重试一次');

      // 第二次请求应直接不带思考参数（能力已缓存）
      await chat({ settings, messages: [{ role: 'user', content: '再来一次' }], maxTokens: 256 });
      assertEqual(sawThinking, 1, '能力已缓存，不应再次白试');
    } finally {
      server.close();
    }
  });

  await test('401 属于致命错误，不会盲目重试', async () => {
    let calls = 0;
    const { server, port } = await startMockServer((body, reply) => {
      calls++;
      reply(401, { error: { message: 'Invalid API key' } });
    });
    try {
      const settings = { ...testSettings(), baseUrl: `http://127.0.0.1:${port}` };
      let err = null;
      try {
        await chat({ settings, messages: [{ role: 'user', content: 'hi' }] });
      } catch (e) {
        err = e;
      }
      assert(err, '应抛出错误');
      assert(err.message.includes('API Key'), `错误提示应说明 Key 有问题，实际：${err.message}`);
      assertEqual(err.fatal, true, '应标记为致命错误');
      assertEqual(calls, 1, '致命错误不应重试');
    } finally {
      server.close();
    }
  });

  await test('429 会退避重试并最终成功', async () => {
    let calls = 0;
    const { server, port } = await startMockServer((body, reply) => {
      calls++;
      if (calls === 1) return reply(429, { error: { message: 'rate limited' } });
      return reply(200, mockReply('["ok"]'));
    });
    try {
      const settings = { ...testSettings(), baseUrl: `http://127.0.0.1:${port}` };
      const res = await chat({ settings, messages: [{ role: 'user', content: 'hi' }] });
      assertEqual(res.text, '["ok"]');
      assertEqual(calls, 2, '应在重试后成功');
    } finally {
      server.close();
    }
  });

  await test('缺少 API Key / 模型时给出明确的中文提示', async () => {
    const noKey = { ...testSettings(), apiKey: '' };
    let e1 = null;
    try {
      await chat({ settings: noKey, messages: [{ role: 'user', content: 'hi' }] });
    } catch (e) {
      e1 = e;
    }
    assert(e1 && e1.message.includes('API Key'), `应提示缺少 Key，实际：${e1?.message}`);

    const noModel = { ...testSettings(), model: '' };
    let e2 = null;
    try {
      await chat({ settings: noModel, messages: [{ role: 'user', content: 'hi' }] });
    } catch (e) {
      e2 = e;
    }
    assert(e2 && e2.message.includes('模型'), `应提示缺少模型，实际：${e2?.message}`);
  });
}

/* ------------------------------------------------------------------ */
/* C 组：真实接口联调                                                  */
/* ------------------------------------------------------------------ */

async function runLiveTests() {
  group(`C. 真实接口联调（${LOCAL_CONFIG.model}）`);
  const settings = testSettings();

  await test('连接测试：Base URL + API Key + 模型可用', async () => {
    const r = await testConnection(settings);
    assert(r.ok, '应连接成功');
    assert(r.text.length > 0, '应返回内容');
    console.log(`      \x1b[90m模型=${r.model} 耗时=${r.elapsedMs}ms 返回=${r.text}\x1b[0m`);
  });

  await test('错误 Key 会得到可读的中文错误提示', async () => {
    let err = null;
    try {
      await testConnection({ ...settings, apiKey: 'sk-invalid-key-for-test' });
    } catch (e) {
      err = e;
    }
    assert(err, '应报错');
    assert(err.message.includes('API Key'), `提示应说明 Key 有问题，实际：${err.message}`);
  });

  await test('误填密钥管理页地址时能自动纠正并成功', async () => {
    const r = await testConnection({ ...settings, baseUrl: 'https://platform.deepseek.com/api_keys' });
    assert(r.ok, '自动纠正后应成功');
  });

  await test('批量翻译 20 条英文 → 中文（整页翻译的核心链路）', async () => {
    const texts = [
      'Hello world', 'Sign in', 'Forgot password?', 'Welcome back to our platform',
      'Please enter your email address', 'The quick brown fox jumps over the lazy dog',
      'Subscribe to our newsletter for weekly updates', 'This product is currently out of stock',
      'Terms of Service and Privacy Policy', 'Loading, please wait', 'Get started for free today',
      'Our team will contact you within 24 hours', 'Everything you need to build faster',
      'Trusted by over 10,000 developers worldwide', 'No credit card required',
      'Start your 14-day free trial now', 'Frequently Asked Questions',
      'Learn more about our pricing plans', 'Contact support if you have any questions',
      'Thank you for your purchase',
    ];
    const t0 = Date.now();
    const r = await translateTexts({ settings, texts, targetLangLabel: '简体中文' });
    const elapsed = Date.now() - t0;
    assertEqual(r.translations.length, 20, '必须返回 20 条，与输入一一对应');
    assertEqual(r.stats.failed, 0, `不应有失败项，实际失败 ${r.stats.failed}`);
    const chinese = r.translations.filter((t) => hasCJK(t)).length;
    assert(chinese >= 18, `至少 18 条应译为中文，实际 ${chinese} 条`);
    assertEqual(r.translations[1].includes('登') || r.translations[1].includes('录'), true, '“Sign in”应译为登录相关');
    console.log(`      \x1b[90m耗时=${elapsed}ms tokens=${JSON.stringify(r.stats.usage)}\x1b[0m`);
    console.log(`      \x1b[90m示例: ${r.translations.slice(0, 4).join(' | ')}\x1b[0m`);
  });

  await test('中文 → 英文（反向翻译）', async () => {
    const texts = ['你好，世界', '登录', '忘记密码？', '感谢您的购买', '我们的团队将在24小时内与您联系'];
    const r = await translateTexts({ settings, texts, targetLangLabel: '英语' });
    assertEqual(r.translations.length, 5);
    assertEqual(r.stats.failed, 0);
    const latin = r.translations.filter((t) => /[A-Za-z]{3,}/.test(t)).length;
    assert(latin >= 4, `至少 4 条应为英文，实际 ${latin} 条：${JSON.stringify(r.translations)}`);
    console.log(`      \x1b[90m示例: ${r.translations.slice(0, 3).join(' | ')}\x1b[0m`);
  });

  await test('划词翻译（单条，保持占位符与代码不翻译）', async () => {
    const text = 'Call the function getUserInfo() and print the result to %s before 2026-01-01.';
    const r = await translateOne({ settings, text, targetLangLabel: '简体中文' });
    assert(r.translation.length > 0, '应有译文');
    assert(hasCJK(r.translation), '划词结果应包含中文');
    assert(r.translation.includes('getUserInfo'), '函数名应保持原样');
    assert(r.translation.includes('%s'), '占位符应保留');
    console.log(`      \x1b[90m${text}\n      → ${r.translation}\x1b[0m`);
  });

  await test('网页总结输出结构化要点', async () => {
    const body = [
      'Chrome extensions in Manifest V3 moved background logic from persistent background pages to event-driven service workers.',
      'Service workers terminate after roughly thirty seconds of inactivity, which means any state kept in global variables can vanish at any time.',
      'Developers must therefore persist state in chrome.storage rather than in memory, and must re-register listeners at the top level of the script so they survive restarts.',
      'Cross-origin requests are now routed through the extensions host permissions, and remote code execution is forbidden entirely, which affects how libraries are bundled.',
      'The declarativeNetRequest API replaces most blocking webRequest use cases, offering better privacy guarantees because extensions no longer see raw request contents.',
      'Chrome Web Store review now requires a privacy justification for every permission an extension requests, and unused permissions cause rejection during review.',
    ].join(' ');
    const r = await summarizeContent({
      settings,
      title: 'Manifest V3 migration guide',
      url: 'https://example.com/mv3',
      text: body,
      targetLangLabel: '简体中文',
      style: 'bullets',
    });
    assert(r.summary.length > 40, '总结内容不应太短');
    assert(hasCJK(r.summary), '总结应为中文');
    assert(/[-*•]|\d\./.test(r.summary), '应包含列表结构');
    console.log(`      \x1b[90m${r.summary.replace(/\n/g, '\n      ')}\x1b[0m`);
  });

  await test('目标语言为英文时，总结也输出英文', async () => {
    const r = await summarizeContent({
      settings,
      title: 'AI and content creation',
      url: 'https://example.com',
      text: '人工智能正在改变内容创作的方式。创作者可以用大模型快速生成初稿、整理素材、优化标题，把精力放在判断和取舍上。工具不会替代创作者，但会淘汰不会用工具的人。',
      targetLangLabel: '英语',
      style: 'bullets',
    });
    assert(/[A-Za-z]{4,}/.test(r.summary), '应输出英文');
    // 允许偶然夹带个别人名/术语，但不允许出现连续的中文短语
    const longChineseRun = r.summary.match(/[\u4e00-\u9fff]{3,}/);
    assert(!longChineseRun, `不应夹带中文句子，却出现了「${longChineseRun?.[0]}」`);
    console.log(`      \x1b[90m${r.summary.replace(/\n/g, '\n      ')}\x1b[0m`);
  });

  await test('关闭思考模式确实省掉了推理 token', async () => {
    resetCapabilityCache();
    const withOff = await chat({
      settings: { ...settings, disableThinking: true },
      messages: [{ role: 'user', content: '把下面 JSON 数组翻译成简体中文，只输出 JSON 数组：["Hello","OK"]' }],
      maxTokens: 2048,
    });
    const reasoningOff = withOff.usage?.completion_tokens_details?.reasoning_tokens || 0;
    console.log(`      \x1b[90m关闭思考: 输出 tokens=${withOff.usage?.completion_tokens} 推理 tokens=${reasoningOff}\x1b[0m`);
    assert(reasoningOff === 0, `关闭思考后推理 token 应为 0，实际 ${reasoningOff}`);
  });

  await test('长文本批量翻译不丢条目（12 条含特殊符号）', async () => {
    const texts = [
      'Price: $19.99 (was $29.99)',
      'Email us at support@example.com',
      'Visit https://example.com/docs for details',
      'Use {user_name} to personalize',
      'Error 404: Page not found',
      '100% satisfaction guaranteed',
      'Copyright © 2026 Acme Inc.',
      'Step 1: Install the package',
      'C++ and Node.js are supported',
      'Hello, 世界! Mixed content.',
      '',
      'OK'
    ].filter(Boolean);
    const r = await translateTexts({ settings, texts, targetLangLabel: '简体中文' });
    assertEqual(r.translations.length, 11, '条数应与输入一致');
    assertEqual(r.stats.failed, 0, '不应有失败项');
    assert(r.translations[0].includes('19.99'), '价格数字应保留');
    assert(r.translations[1].includes('support@example.com'), '邮箱应保留');
    const joined = r.translations.join(' ');
    assert(joined.includes('https://example.com/docs'), '网址应保留');
    console.log(`      \x1b[90m${JSON.stringify(r.translations.slice(0, 5), null, 0)}\x1b[0m`);
  });
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

(async () => {
  console.log('\x1b[1m=== AI 翻译助手 · 自动化测试 ===\x1b[0m');
  const only = process.argv[2] || 'all';

  try {
    if (only === 'all' || only === 'unit') await runUnitTests();
    if (only === 'all' || only === 'unit') await runHistoryTests();
    if (only === 'all' || only === 'mock') await runMockTests();
    if (only === 'all' || only === 'live') await runLiveTests();
  } catch (err) {
    console.error('\n测试运行中断：', err);
  }

  const failed = summary();
  process.exit(failed ? 1 : 0);
})();
