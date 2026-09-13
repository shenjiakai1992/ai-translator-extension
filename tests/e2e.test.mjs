/**
 * 端到端测试：真实启动浏览器、真实加载扩展、真实调用模型接口。
 *
 * 覆盖：配置读写 → 连接测试 → 整页翻译 → 还原 → 二次翻译 → 双语对照 → 划词翻译 → 网页总结 → 异常处理
 *
 * 运行：node tests/e2e.test.mjs
 *
 * ⚠️ 关于浏览器：
 *   Chrome 137 起，**品牌版 Chrome** 移除了 --load-extension（官方出于安全考虑，未提供恢复方式），
 *   因此扩展的自动化测试必须使用 **Chrome for Testing** 或 **Chromium** —— 这也是谷歌官方推荐的测试路径。
 *   本脚本会自动按以下顺序寻找可用浏览器：
 *     1) 环境变量 AITX_CHROME
 *     2) ~/.workbuddy/binaries/browsers 下的 Chrome for Testing / Chromium
 *     3) ~/.cache/puppeteer、~/.cache/ms-playwright 下的同名浏览器
 *     4) 系统品牌版 Chrome（会失败，仅作兜底提示）
 *
 *   安装测试浏览器：
 *     npx @puppeteer/browsers install chrome@stable --path ~/.workbuddy/binaries/browsers
 *
 * 注意：内容脚本运行在「隔离世界」里，页面上下文读不到它设置的变量（如 window.__AITX_LOADED__）。
 *       因此本脚本一律通过 chrome.tabs.sendMessage 与内容脚本通信来探测状态。
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { testSettings } from './local.config.mjs';
import { group, test, info, assert, assertEqual, summary } from './harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(__dirname, '..');
const OUT_DIR = path.join(__dirname, 'output');

/* ------------------------------------------------------------------ */
/* 依赖与浏览器解析                                                    */
/* ------------------------------------------------------------------ */

function resolvePuppeteer() {
  const bases = [
    process.env.AITX_NODE_MODULES,
    path.join(EXT_PATH, 'node_modules') + path.sep,
    '/Users/mac/.workbuddy/binaries/node/workspace' + path.sep,
  ].filter(Boolean);
  for (const base of bases) {
    try {
      const req = createRequire(path.join(base, '__resolve__.js'));
      return req.resolve('puppeteer-core');
    } catch {
      /* 试下一个 */
    }
  }
  return null;
}

const BROWSER_BIN_NAMES = ['Google Chrome for Testing', 'Chromium', 'chrome'];

/** 在目录里递归找浏览器可执行文件（限制深度，避免全盘扫描） */
function findBrowserBins(root, depth = 0, found = []) {
  // Chrome for Testing 实际层级较深：
  // browsers/chrome/<版本>/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/<可执行文件>
  if (depth > 9 || !fs.existsSync(root)) return found;
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.endsWith('.app') && !fs.existsSync(path.join(full, 'Contents/MacOS'))) continue;
      findBrowserBins(full, depth + 1, found);
    } else if (BROWSER_BIN_NAMES.includes(entry.name)) {
      if (full.includes('.app/Contents/MacOS/') || !full.includes('.app/')) found.push(full);
    }
  }
  return found;
}

function resolveChrome() {
  const candidates = [];
  if (process.env.AITX_CHROME) candidates.push(process.env.AITX_CHROME);
  const roots = [
    '/Users/mac/.workbuddy/binaries/browsers',
    path.join(process.env.HOME || '', '.cache/puppeteer'),
    path.join(process.env.HOME || '', '.cache/ms-playwright'),
  ];
  for (const root of roots) candidates.push(...findBrowserBins(root));
  for (const p of candidates) {
    if (p && fs.existsSync(p) && !p.includes('/Applications/Google Chrome.app/')) {
      return { path: p, testBrowser: true };
    }
  }
  const branded = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (fs.existsSync(branded)) return { path: branded, testBrowser: false };
  return candidates[0] ? { path: candidates[0], testBrowser: true } : null;
}

/* ------------------------------------------------------------------ */
/* 辅助函数                                                            */
/* ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeout = 90000, interval = 400, label = '条件' } = {}) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeout) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) {
      last = err.message;
    }
    await sleep(interval);
  }
  throw new Error(`等待超时（${timeout}ms）：${label}${last ? ` · 最后状态：${JSON.stringify(last)}` : ''}`);
}

/** 只服务 tests/fixtures 的本地静态服务器（file:// 页面默认不允许扩展注入） */
function serveFixtures() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const name = path.basename(decodeURIComponent(req.url.split('?')[0])) || 'page-en.html';
      const file = path.join(__dirname, 'fixtures', name);
      if (!fs.existsSync(file)) {
        res.writeHead(404);
        return res.end('not found');
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(file));
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/* ------------------------------------------------------------------ */
/* 全局状态                                                            */
/* ------------------------------------------------------------------ */

let puppeteer = null;
let browser = null;
let ctrl = null; // 扩展页面，用来调用 chrome.* API
let page = null; // 被测网页
let server = null;
let fixtureOrigin = '';
let extId = '';
let ready = false;
let settings = null;
let originalSnapshot = {};

/* ------------------------------------------------------------------ */
/* 扩展控制面                                                          */
/* ------------------------------------------------------------------ */

async function fixtureTabId() {
  return ctrl.evaluate(async (host) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => (t.url || '').includes(host));
    return tab ? tab.id : null;
  }, fixtureOrigin);
}

async function sendToPage(type, payload = {}) {
  const tabId = await fixtureTabId();
  if (!tabId) throw new Error('找不到被测网页的标签页');
  return ctrl.evaluate(
    async (id, msg) => {
      try {
        return await chrome.tabs.sendMessage(id, msg);
      } catch (err) {
        return { __error: String(err?.message || err) };
      }
    },
    tabId,
    { type, ...payload }
  );
}

async function setStoredSettings(patch) {
  return ctrl.evaluate(async (p) => {
    const cur = (await chrome.storage.local.get('aitx_settings')).aitx_settings || {};
    const next = { ...cur, ...p };
    await chrome.storage.local.set({ aitx_settings: next });
    return next;
  }, patch);
}

async function getBadgeText() {
  const tabId = await fixtureTabId();
  if (!tabId) return '';
  return ctrl.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), tabId);
}

async function snapshotPage() {
  return page.evaluate(() => {
    const ids = [
      'nav-home', 'nav-features', 'nav-pricing', 'nav-contact', 'hero-title', 'hero-desc',
      'cta-primary', 'code-block', 'p1', 'p2', 'li1', 'li2', 'li3', 'faq1', 'footer',
    ];
    const out = {};
    for (const id of ids) {
      const el = document.getElementById(id);
      out[id] = el ? el.textContent.trim() : '';
    }
    return out;
  });
}

async function countCJKNodes() {
  return page.evaluate(() => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let total = 0;
    let cjk = 0;
    let node;
    while ((node = walker.nextNode())) {
      const t = (node.nodeValue || '').trim();
      if (t.length < 2) continue;
      if (node.parentElement?.closest('#aitx-host')) continue;
      if (node.parentElement?.closest('.aitx-bi')) continue;
      total++;
      if (/[\u4e00-\u9fff]/.test(t)) cjk++;
    }
    return { total, cjk };
  });
}

/** 打开扩展页面。扩展刚重载时 chrome-extension:// 会被短暂拦截（ERR_BLOCKED_BY_CLIENT），所以带重试。 */
async function openCtrlPage(retries = 24) {
  let lastErr = '未知';
  for (let i = 0; i < retries; i++) {
    const p = await browser.newPage();
    try {
      await p.setViewport({ width: 380, height: 660, deviceScaleFactor: 2 });
      await p.goto(`chrome-extension://${extId}/src/popup/popup.html`, {
        waitUntil: 'domcontentloaded',
        timeout: 5000,
      });
      const ready = await p.evaluate(() => Boolean(document.getElementById('baseUrl'))).catch(() => false);
      if (ready) return p;
      lastErr = '页面元素未就绪';
    } catch (err) {
      lastErr = err?.message?.split('\n')[0] || String(err);
    }
    await p.close().catch(() => {});
    await sleep(700);
  }
  throw new Error(`扩展页面一直打不开：${lastErr}`);
}

/** 把被测页面恢复到干净状态：写入指定配置 → 重新加载 → 等内容脚本就绪 */
async function resetFixture(patch = {}) {
  await setStoredSettings({
    apiKey: settings.apiKey,
    targetLang: 'zh-CN',
    displayMode: 'replace',
    selectionTranslate: true,
    autoTranslate: false,
    disableThinking: true,
    ...patch,
  });
  // 页面若在后台，浏览器会把渲染进程冻结，操作前先切到前台
  await page.bringToFront();
  await page.reload({ waitUntil: 'load' });
  await waitFor(async () => (await sendToPage('AITX_PING'))?.ok === true, {
    timeout: 25000,
    interval: 300,
    label: '内容脚本就绪',
  });
  const st = await sendToPage('AITX_GET_STATE');
  assertEqual(st.translated, false, '重置后页面应为原文状态');
}

async function translatePageAndWait(label = '整页翻译完成', timeout = 120000) {
  const accepted = await sendToPage('AITX_TOGGLE_PAGE');
  assert(accepted?.ok, `翻译指令应被接受，实际 ${JSON.stringify(accepted)}`);
  await waitFor(
    async () => {
      const st = await sendToPage('AITX_GET_STATE');
      return st?.running === false && st?.translated === true;
    },
    { timeout, interval: 600, label }
  );
}

async function restorePageAndWait() {
  await sendToPage('AITX_RESTORE_PAGE');
  await waitFor(async () => (await sendToPage('AITX_GET_STATE'))?.translated === false, {
    timeout: 15000,
    interval: 300,
    label: '页面还原',
  });
}

/* ------------------------------------------------------------------ */
/* 测试主体                                                            */
/* ------------------------------------------------------------------ */

async function main() {
  console.log('\x1b[1m=== AI 翻译助手 · 端到端测试（真实浏览器 + 真实模型）===\x1b[0m');

  const resolved = resolvePuppeteer();
  if (!resolved) {
    console.log('\n\x1b[31m未找到 puppeteer-core，跳过端到端测试。\x1b[0m');
    console.log('安装方式：npm i -D puppeteer-core  或设置环境变量 AITX_NODE_MODULES 指向其所在目录\n');
    process.exit(0);
  }
  puppeteer = (await import(pathToFileURL(resolved).href)).default;
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const f of fs.readdirSync(OUT_DIR)) fs.rmSync(path.join(OUT_DIR, f), { force: true });
  settings = testSettings();

  /* ---------------- 环境准备 ---------------- */
  group('0. 环境准备');

  await test('启动测试浏览器并加载未打包扩展', async () => {
    const chrome = resolveChrome();
    assert(chrome?.path, '找不到可用的浏览器，请先安装 Chrome for Testing 或 Chromium');
    info(`浏览器：${chrome.path}`);
    if (!chrome.testBrowser) {
      info('\x1b[33m警告：只有品牌版 Chrome，它从 137 起禁用 --load-extension，测试会失败\x1b[0m');
      info('安装测试浏览器：npx @puppeteer/browsers install chrome@stable --path ~/.workbuddy/binaries/browsers');
    }

    browser = await puppeteer.launch({
      executablePath: chrome.path,
      headless: 'new',
      protocolTimeout: 180000,
      userDataDir: fs.mkdtempSync('/tmp/aitx-e2e-'),
      args: [
        '--no-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows',
        `--disable-extensions-except=${EXT_PATH}`,
        `--load-extension=${EXT_PATH}`,
      ],
    });

    const swTarget = await browser
      .waitForTarget((t) => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'), {
        timeout: 20000,
      })
      .catch(() => null);
    if (swTarget) {
      extId = new URL(swTarget.url()).host;
      info('后台 Service Worker 已启动');
    } else {
      const session = await browser.target().createCDPSession();
      const r = await session.send('Extensions.loadUnpacked', { path: EXT_PATH }).catch(() => null);
      extId = r?.id;
    }
    assert(extId, '未能加载扩展：品牌版 Chrome 不支持命令行加载扩展，请使用 Chrome for Testing');
    info(`扩展 ID = ${extId}`);
    ready = true;
  });

  if (!ready) {
    summary();
    process.exit(1);
  }

  await test('打开扩展配置页并写入测试用模型配置', async () => {
    ctrl = await openCtrlPage();
    const stored = await setStoredSettings({
      baseUrl: settings.baseUrl,
      apiKey: settings.apiKey,
      model: settings.model,
      targetLang: 'zh-CN',
      displayMode: 'replace',
      disableThinking: true,
      selectionTranslate: true,
      autoTranslate: false,
    });
    assertEqual(stored.model, settings.model, '配置应写入 storage');
    assertEqual(stored.baseUrl, settings.baseUrl);
    info(`已写入：${stored.baseUrl} / ${stored.model}`);
  });

  await test('本地测试页服务启动正常', async () => {
    const s = await serveFixtures();
    server = s.server;
    fixtureOrigin = `127.0.0.1:${s.port}`;
    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(`http://${fixtureOrigin}/page-en.html`, { waitUntil: 'load' });
    info(`测试页地址 http://${fixtureOrigin}/page-en.html`);
  });

  /* ---------------- 弹窗配置界面 ---------------- */
  group('1. 弹窗配置界面');

  await test('弹窗能正确回填已保存的配置', async () => {
    await ctrl.reload({ waitUntil: 'domcontentloaded' });
    await waitFor(() => ctrl.evaluate(() => document.getElementById('baseUrl').value.length > 0), {
      timeout: 10000,
      label: '弹窗表单回填',
    });
    const form = await ctrl.evaluate(() => ({
      baseUrl: document.getElementById('baseUrl').value,
      apiKey: document.getElementById('apiKey').value,
      model: document.getElementById('model').value,
      targetLang: document.getElementById('targetLang').value,
      displayMode: document.getElementById('displayMode').value,
      thinking: document.getElementById('disableThinking').checked,
      selection: document.getElementById('selectionTranslate').checked,
      options: document.getElementById('targetLang').options.length,
      status: document.getElementById('statusLine').textContent,
    }));
    assertEqual(form.baseUrl, settings.baseUrl, 'Base URL 应回填');
    assertEqual(form.apiKey, settings.apiKey, 'API Key 应回填');
    assertEqual(form.model, settings.model, '模型应回填');
    assertEqual(form.targetLang, 'zh-CN', '目标语言应回填');
    assertEqual(form.displayMode, 'replace', '显示方式应回填');
    assertEqual(form.thinking, true, '快速模式开关应回填');
    assertEqual(form.selection, true, '划词翻译开关应回填');
    assert(form.options >= 8, `语言下拉应有多个选项，实际 ${form.options}`);
    assert(!form.status.includes('未配置'), `状态栏应显示已配置，实际：${form.status}`);
    info(`状态栏：${form.status}`);
  });

  await test('弹窗「测试连接」按钮能真实连通模型', async () => {
    await ctrl.bringToFront();
    // 注意：在扩展页面上用 page.click() / page.$eval() 会卡死（headless 下的怪毛病），
    // 所有交互与读取统一走 page.evaluate()。
    await ctrl.evaluate(() => {
      document.getElementById('settings').hidden = false;
      document.getElementById('btnTest').click();
    });

    const busy = await ctrl.evaluate(() => document.getElementById('btnTest').textContent);
    assert(busy.includes('测试中'), `按钮应立刻进入测试中状态，实际：${busy}`);

    const out = await ctrl.evaluate(async () => {
      const box = document.getElementById('testOut');
      const started = Date.now();
      while (Date.now() - started < 90000) {
        if (!box.hidden && /连接成功|连接失败/.test(box.textContent)) {
          return { text: box.textContent, cls: box.className, elapsedMs: Date.now() - started };
        }
        await new Promise((r) => setTimeout(r, 300));
      }
      return { text: box.textContent || '(空)', cls: box.className, timeout: true };
    });

    assert(!out.timeout, `等待连接结果超时，最后内容：${out.text}`);
    assert(out.text.includes('连接成功'), `连接测试应成功，实际：${out.text}`);
    assert(out.cls.includes('ok'), '结果样式应为成功态');
    await ctrl.screenshot({ path: path.join(OUT_DIR, '01-popup-settings.png') });
    info(`${out.text}（等待 ${(out.elapsedMs / 1000).toFixed(1)}s）`);
  });

  await test('误填密钥管理页地址时给出提示，改回后提示消失', async () => {
    const bad = await ctrl.evaluate(() => {
      const input = document.getElementById('baseUrl');
      input.value = 'https://platform.deepseek.com/api_keys';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const hint = document.getElementById('baseUrlHint');
      return { text: hint.textContent, cls: hint.className };
    });
    assert(bad.cls.includes('bad'), '应标记为异常');
    assert(bad.text.includes('密钥管理'), `提示应说明这是密钥管理页，实际：${bad.text}`);
    info(`提示文案：${bad.text}`);

    const good = await ctrl.evaluate((v) => {
      const input = document.getElementById('baseUrl');
      input.value = v;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return document.getElementById('baseUrlHint').className;
    }, settings.baseUrl);
    assert(!good.includes('bad'), '改回正确地址后不应再报错');
  });

  await test('未填 API Key 时弹窗给出引导横幅', async () => {
    await setStoredSettings({ apiKey: '' });
    await ctrl.reload({ waitUntil: 'domcontentloaded' });
    const banner = await waitFor(
      () =>
        ctrl.evaluate(() => {
          const b = document.getElementById('banner');
          if (b.hidden || !b.textContent.includes('API Key')) return false;
          return { text: b.textContent, settingsOpen: !document.getElementById('settings').hidden };
        }),
      { timeout: 10000, label: '引导横幅出现' }
    );
    assert(banner.settingsOpen, '缺少 Key 时应自动展开设置面板');
    info(banner.text);
    await setStoredSettings({ apiKey: settings.apiKey });
  });

  await test('弹窗里的开关与下拉改动会即时保存', async () => {
    await ctrl.reload({ waitUntil: 'domcontentloaded' });
    await ctrl.bringToFront();
    await ctrl.evaluate(() => {
      document.getElementById('settings').hidden = false;
      const sel = document.getElementById('displayMode');
      sel.value = 'bilingual';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await waitFor(
      async () =>
        (await ctrl.evaluate(async () => (await chrome.storage.local.get('aitx_settings')).aitx_settings.displayMode)) ===
        'bilingual',
      { timeout: 5000, label: '显示方式自动保存' }
    );
    await ctrl.evaluate(() => {
      const sel = document.getElementById('displayMode');
      sel.value = 'replace';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await waitFor(
      async () =>
        (await ctrl.evaluate(async () => (await chrome.storage.local.get('aitx_settings')).aitx_settings.displayMode)) ===
        'replace',
      { timeout: 5000, label: '显示方式还原' }
    );
  });

  /* ---------------- 整页翻译 ---------------- */
  group('2. 整页翻译');

  await test('内容脚本注入成功，且能与扩展通信', async () => {
    await resetFixture();
    const st = await sendToPage('AITX_GET_STATE');
    assert(st?.ok, '内容脚本应能响应状态查询');
    assertEqual(st.translated, false, '初始应为未翻译状态');
    originalSnapshot = await snapshotPage();
    assert(originalSnapshot['hero-title'].includes('Build faster'), '原文快照应为英文');
    assert(originalSnapshot['code-block'].includes('AcmeClient'), '代码块原文应被采集到');
  });

  await test('整页翻译：正文变成中文，代码块与表单属性保持原样', async () => {
    const t0 = Date.now();
    await translatePageAndWait();
    const seconds = ((Date.now() - t0) / 1000).toFixed(1);
    const snap = await snapshotPage();
    const stat = await countCJKNodes();

    info(`耗时 ${seconds}s · 中文节点 ${stat.cjk}/${stat.total}`);
    info(`标题：${snap['hero-title']}`);
    info(`导航：${snap['nav-home']} / ${snap['nav-features']} / ${snap['nav-pricing']} / ${snap['nav-contact']}`);

    assert(/[\u4e00-\u9fff]/.test(snap['hero-title']), '主标题应被译为中文');
    assert(/[\u4e00-\u9fff]/.test(snap['hero-desc']), '首屏段落应被译为中文');
    assert(/[\u4e00-\u9fff]/.test(snap['p1']), '文章段落应被译为中文');
    assert(/[\u4e00-\u9fff]/.test(snap['li1']), '列表项应被译为中文');
    assert(/[\u4e00-\u9fff]/.test(snap['footer']), '页脚应被译为中文');
    assert(stat.cjk / stat.total > 0.7, `应有超过 7 成文本节点变成中文，实际 ${stat.cjk}/${stat.total}`);
    assertEqual(snap['code-block'], originalSnapshot['code-block'], '代码块内容不应被翻译');
    assertEqual(
      await page.$eval('input[type=email]', (e) => e.getAttribute('placeholder')),
      'you@company.com',
      'placeholder 属性不应被改动'
    );
    await page.screenshot({ path: path.join(OUT_DIR, '02-page-translated.png') });
  });

  await test('翻译完成后扩展角标显示「译」', async () => {
    assertEqual(await getBadgeText(), '译', '角标应显示译字');
  });

  await test('「还原原文」能一字不差地恢复页面', async () => {
    await restorePageAndWait();
    const restored = await snapshotPage();
    for (const key of Object.keys(originalSnapshot)) {
      assertEqual(restored[key], originalSnapshot[key], `节点 ${key} 应完全恢复原文`);
    }
    assertEqual(await getBadgeText(), '', '还原后角标应清空');
    info(`${Object.keys(originalSnapshot).length} 个关键节点全部与原文一致`);
  });

  await test('还原后可以再次翻译（回归：已翻译标记需被清理）', async () => {
    await translatePageAndWait('第二次翻译完成');
    const again = await snapshotPage();
    assert(/[\u4e00-\u9fff]/.test(again['hero-title']), '第二次翻译应生效');
    assert(/[\u4e00-\u9fff]/.test(again['p1']), '第二次翻译正文应生效');
    info(`二次翻译标题：${again['hero-title']}`);
    await restorePageAndWait();
  });

  await test('双语对照模式：译文旁附上原文，还原后对照节点被清理', async () => {
    await resetFixture({ displayMode: 'bilingual' });
    await translatePageAndWait('双语模式翻译完成');

    const bi = await page.evaluate(() => {
      const nodes = document.querySelectorAll('.aitx-bi');
      return { count: nodes.length, sample: nodes[0] ? nodes[0].textContent.trim() : '' };
    });
    assert(bi.count > 0, '双语模式下应插入原文对照节点');
    assert(/[A-Za-z]{3,}/.test(bi.sample), `对照节点里应是英文原文，实际：${bi.sample}`);
    info(`对照节点 ${bi.count} 个，示例：${bi.sample}`);
    await page.screenshot({ path: path.join(OUT_DIR, '03-bilingual.png') });

    await restorePageAndWait();
    const leftover = await page.evaluate(() => document.querySelectorAll('.aitx-bi').length);
    assertEqual(leftover, 0, '还原后对照节点应被清理');
    assertEqual((await snapshotPage())['hero-title'], originalSnapshot['hero-title'], '原文应完整恢复');
  });

  /* ---------------- 划词翻译 ---------------- */
  group('3. 划词翻译');

  await test('选中文字浮出按钮，点击得到译文', async () => {
    await resetFixture();

    await page.evaluate(() => {
      const el = document.getElementById('p1');
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 200, clientY: 320 }));
    });

    await waitFor(
      () =>
        page.evaluate(() => {
          const btn = document.getElementById('aitx-host')?.shadowRoot?.querySelector('.selbtn');
          return btn && !btn.hidden;
        }),
      { timeout: 8000, label: '划词按钮出现' }
    );

    await page.evaluate(() => {
      document.getElementById('aitx-host').shadowRoot.querySelector('.selbtn').click();
    });

    const translation = await waitFor(
      () =>
        page.evaluate(() => {
          const panel = document.getElementById('aitx-host')?.shadowRoot?.querySelector('.panel');
          if (!panel || panel.hidden) return false;
          const dst = panel.querySelector('.dsttext');
          // 注意：加载态文案「正在翻译…」本身也是中文，必须排除，否则会误判成译文
          if (!dst || dst.querySelector('.loading') || dst.classList.contains('error')) return false;
          const text = dst.textContent.trim();
          return /[\u4e00-\u9fff]/.test(text) && text.length > 10 ? text : false;
        }),
      { timeout: 60000, interval: 500, label: '划词译文返回' }
    );

    const src = await page.evaluate(() =>
      document.getElementById('aitx-host').shadowRoot.querySelector('.panel .srctext').textContent.trim()
    );
    assert(src.includes('Traditional deployments'), `原文应展示在面板里，实际：${src.slice(0, 40)}`);
    assert(translation.length > 10, `译文不应过短，实际：${translation}`);
    info(`原文：${src.slice(0, 46)}…`);
    info(`译文：${translation}`);
    await page.screenshot({ path: path.join(OUT_DIR, '04-selection-translate.png') });
  });

  await test('划词面板可复制、可关闭', async () => {
    const ok = await page.evaluate(() => {
      const root = document.getElementById('aitx-host').shadowRoot;
      root.querySelector('.panel [data-copy]').click();
      return !!root.querySelector('.panel [data-copy]');
    });
    assert(ok, '应有复制按钮');
    await page.evaluate(() => {
      document.getElementById('aitx-host').shadowRoot.querySelector('.panel [data-close]').click();
    });
    const hidden = await page.evaluate(
      () => document.getElementById('aitx-host').shadowRoot.querySelector('.panel').hidden
    );
    assert(hidden, '点击关闭后面板应隐藏');
  });

  /* ---------------- 网页总结 ---------------- */
  group('4. 网页总结');

  await test('网页总结：抓取正文并输出结构化中文要点', async () => {
    await resetFixture();
    const accepted = await sendToPage('AITX_SUMMARIZE_PAGE');
    assert(accepted?.ok, '总结指令应被接受');

    const result = await waitFor(
      () =>
        page.evaluate(() => {
          const panel = document.getElementById('aitx-host')?.shadowRoot?.querySelector('.summary');
          if (!panel || panel.hidden) return false;
          const body = panel.querySelector('.summarybody');
          if (body.querySelector('.loading')) return false;
          const text = body.innerText.trim();
          if (!text || text.length < 20) return false;
          return {
            html: body.innerHTML,
            text,
            lists: body.querySelectorAll('li').length,
            strong: body.querySelectorAll('strong').length,
            headings: body.querySelectorAll('h3,h4').length,
          };
        }),
      { timeout: 90000, interval: 600, label: '总结结果渲染' }
    );

    assert(/[\u4e00-\u9fff]/.test(result.text), '总结应为中文');
    assert(result.lists >= 3, `总结应包含要点列表，实际 ${result.lists} 条`);
    assert(result.strong + result.headings >= 1, '总结应包含加粗结论或小标题');
    assert(!result.html.includes('<script'), '渲染结果不应含脚本标签');
    info(`要点 ${result.lists} 条 · 加粗 ${result.strong} 处 · 小标题 ${result.headings} 个`);
    info(result.text.split('\n').slice(0, 8).join('\n'));
    await page.screenshot({ path: path.join(OUT_DIR, '05-page-summary.png') });
  });

  /* ---------------- 异常处理 ---------------- */
  group('5. 异常处理');

  await test('API Key 失效时给出可读的中文错误提示', async () => {
    await resetFixture({ apiKey: 'sk-this-key-is-invalid-000' });
    await sendToPage('AITX_TOGGLE_PAGE');

    const toast = await waitFor(
      () =>
        page.evaluate(() => {
          const t = document.getElementById('aitx-host')?.shadowRoot?.querySelector('.toast');
          if (!t || t.hidden) return false;
          const text = t.querySelector('.toasttext')?.textContent || '';
          const sub = t.querySelector('.toastsub')?.textContent || '';
          if (/失败|中断/.test(text)) return { text, sub };
          return false;
        }),
      { timeout: 60000, interval: 400, label: '错误提示出现' }
    );
    assert(
      toast.sub.includes('API Key') || toast.text.includes('API Key'),
      `提示应说明 API Key 有问题，实际：${toast.text} / ${toast.sub}`
    );
    info(`提示：${toast.text} — ${toast.sub}`);
    await page.screenshot({ path: path.join(OUT_DIR, '06-error-state.png') });
  });

  await test('回归：内容脚本缺失时后台能自动补注入（对应「先开网页、后装扩展」）', async () => {
    await resetFixture();
    const tabId = await fixtureTabId();

    // 1) 正常页面：探活应报告「本来就在」，不会多此一举地重复注入
    const first = await ctrl.evaluate(
      (id) => chrome.runtime.sendMessage({ type: 'AITX_ENSURE_CONTENT', tabId: id }),
      tabId
    );
    assert(first?.ok && first.data?.ok, `探活应成功，实际：${JSON.stringify(first)}`);
    assertEqual(first.data.alreadyInjected, true, '正常页面应报告 alreadyInjected');

    // 2) 补注入原语：验证 scripting 权限、脚本路径、共享模块动态加载都能跑通
    const injected = await ctrl.evaluate(
      (id) =>
        chrome.scripting
          .executeScript({ target: { tabId: id }, files: ['src/content/content.js'] })
          .then(() => true, (e) => String(e?.message || e)),
      tabId
    );
    assertEqual(injected, true, `应能注入内容脚本，实际：${injected}`);
    info('scripting.executeScript 注入成功（权限与路径均正确）');

    // 3) 幂等：重复注入应被守卫挡住，页面里不会出现两个扩展 UI 容器
    const again = await ctrl.evaluate(
      (id) =>
        chrome.scripting
          .executeScript({ target: { tabId: id }, files: ['src/content/content.js'] })
          .then(() => true, (e) => String(e?.message || e)),
      tabId
    );
    assertEqual(again, true, '重复注入不应报错');
    const hostCount = await page.evaluate(() => document.querySelectorAll('#aitx-host').length);
    assert(hostCount <= 1, `扩展 UI 容器应至多一个，实际 ${hostCount}`);
    assert((await sendToPage('AITX_PING'))?.ok, '注入后内容脚本仍应正常通信');
    await resetFixture();
  });

  await test('确实无法注入的页面：补注入返回失败并带原因', async () => {
    const blank = await browser.newPage();
    await blank.bringToFront();
    await blank.goto('data:text/html,<h1>no content script here</h1>', { waitUntil: 'domcontentloaded' });
    const tabId = await ctrl.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return tab?.id ?? null;
    });
    if (tabId == null) {
      info('浏览器未暴露该标签页 ID，跳过');
      await blank.close();
      return;
    }
    const res = await ctrl.evaluate(
      (id) => chrome.runtime.sendMessage({ type: 'AITX_ENSURE_CONTENT', tabId: id }),
      tabId
    );
    assert(res?.ok, '消息通道本身不应报错');
    assertEqual(res.data.ok, false, '这类页面补注入应返回失败');
    assert(res.data.reason, '失败时应带上原因，便于排查');
    info(`注入失败原因：${res.data.reason}`);
    await blank.close();
  });

  /* ---------------- 收尾 ---------------- */
  group('6. 收尾');

  await test('回到原文状态并生成完整截图存档', async () => {
    await resetFixture();
    // 前面的用例可能让扩展页失去上下文，这里兜底重建一次
    try {
      await ctrl.evaluate(() => 1);
    } catch {
      ctrl = await openCtrlPage();
    }
    await ctrl.bringToFront();
    await ctrl.reload({ waitUntil: 'domcontentloaded' });
    await sleep(1500);
    await ctrl.screenshot({ path: path.join(OUT_DIR, '01-popup-settings.png') });
    await page.bringToFront();
    await sleep(400);
    await page.screenshot({ path: path.join(OUT_DIR, '07-original-page.png') });
    const files = fs.readdirSync(OUT_DIR).filter((f) => f.endsWith('.png')).sort();
    assert(files.length >= 6, `应生成至少 6 张截图，实际 ${files.length}：${files.join(', ')}`);
    info(`截图目录：${OUT_DIR}`);
    info(files.join(', '));
  });
}

/* ------------------------------------------------------------------ */
/* 运行                                                                */
/* ------------------------------------------------------------------ */

(async () => {
  try {
    await main();
  } catch (err) {
    console.error('\n\x1b[31m测试流程异常中断：\x1b[0m', err);
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) server.close();
  }
  const failed = summary();
  process.exit(failed ? 1 : 0);
})();
