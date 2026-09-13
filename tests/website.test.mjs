/**
 * 宣传站验证测试（真浏览器）
 *
 * 检查项：
 *  1. 页面能正常加载，无控制台报错、无 404 资源
 *  2. 桌面端与手机端都不出现横向滚动条
 *  3. 移动端导航能展开、能收起
 *  4. 所有页内锚点都指向真实存在的元素
 *  5. 内容完整性（三大功能 / 安装步骤 / 注意要点 / 常见问题）
 *  6. 前端规范符合性（无行内样式、类名短横线、语义化标签、装饰图有替代文本）
 *  7. 产出桌面端与手机端截图
 *
 * 运行：
 *   node tests/website.test.mjs                                           # 测本地 docs/ 目录
 *   AITX_SITE_URL=https://xxx.github.io/repo/ node tests/website.test.mjs # 测已部署的线上地址
 *
 * 线上模式会额外走本机代理（AITX_PROXY，默认 http://127.0.0.1:7897），
 * 用来验证部署后的静态资源是否都能正常加载。
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { group, test, info, assert, assertEqual, summary } from './harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITE_DIR = path.resolve(__dirname, '..', 'docs');
const OUT_DIR = path.join(__dirname, 'output');

const LIVE_URL = (process.env.AITX_SITE_URL || '').trim();
const PROXY = process.env.AITX_PROXY || 'http://127.0.0.1:7897';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

/* ------------------------------------------------------------------ */
/* 依赖与浏览器                                                        */
/* ------------------------------------------------------------------ */

function resolvePuppeteer() {
  const bases = [
    process.env.AITX_NODE_MODULES,
    path.join(SITE_DIR, '..', 'node_modules') + path.sep,
    '/Users/mac/.workbuddy/binaries/node/workspace' + path.sep,
  ].filter(Boolean);
  for (const base of bases) {
    try {
      return createRequire(path.join(base, '__resolve__.js')).resolve('puppeteer-core');
    } catch {
      /* 试下一个 */
    }
  }
  return null;
}

const BROWSER_BIN_NAMES = ['Google Chrome for Testing', 'Chromium'];

function findBrowserBins(root, depth = 0, found = []) {
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
  if (process.env.AITX_CHROME && fs.existsSync(process.env.AITX_CHROME)) return process.env.AITX_CHROME;
  const roots = [
    '/Users/mac/.workbuddy/binaries/browsers',
    path.join(process.env.HOME || '', '.cache/puppeteer'),
  ];
  for (const root of roots) {
    const hit = findBrowserBins(root)[0];
    if (hit) return hit;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* 静态服务器：模拟真实部署环境，同时能捕获 404                        */
/* ------------------------------------------------------------------ */

function serveSite() {
  return new Promise((resolve) => {
    const missing = [];
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent(req.url.split('?')[0]);
      const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
      const file = path.join(SITE_DIR, rel);
      if (!file.startsWith(SITE_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        missing.push(urlPath);
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('404');
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME_TYPES[path.extname(file)] || 'application/octet-stream' });
      res.end(fs.readFileSync(file));
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, missing }));
  });
}

/* ------------------------------------------------------------------ */

let browser = null;
let server = null;
let missingAssets = [];
let baseUrl = '';
let ready = false;
const consoleErrors = [];
/** 状态码 >= 400 的响应，用来抓资源 404（线上模式下尤其重要） */
const failedResponses = [];

async function openSite(viewport) {
  const page = await browser.newPage();
  await page.setViewport(viewport);
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(String(err)));
  page.on('response', (res) => {
    if (res.status() >= 400) failedResponses.push(`${res.status()} ${res.url()}`);
  });
  await page.goto(baseUrl, { waitUntil: 'load', timeout: 20000 });
  await new Promise((r) => setTimeout(r, 400));
  return page;
}

async function main() {
  console.log('\x1b[1m=== 宣传站验证测试 ===\x1b[0m');

  const resolvedPuppeteer = resolvePuppeteer();
  if (!resolvedPuppeteer) {
    console.log('\n\x1b[31m未找到 puppeteer-core，跳过。\x1b[0m\n');
    process.exit(0);
  }
  const chromePath = resolveChrome();
  assert(chromePath, '找不到可用浏览器（需要 Chrome for Testing 或 Chromium）');
  const puppeteer = (await import(pathToFileURL(resolvedPuppeteer).href)).default;
  fs.mkdirSync(OUT_DIR, { recursive: true });

  group('0. 环境准备');

  if (LIVE_URL) {
    await test('线上模式：跳过本地文件检查', () => {
      info(`目标地址：${LIVE_URL}（经代理 ${PROXY}）`);
    });
  }

  if (!LIVE_URL) await test('静态站点文件齐全', () => {
    const required = [
      'index.html',
      'assets/css/variables.css',
      'assets/css/base.css',
      'assets/css/components.css',
      'assets/js/main.js',
      'assets/img/favicon.png',
    ];
    for (const rel of required) {
      assert(fs.existsSync(path.join(SITE_DIR, rel)), `缺少文件：${rel}`);
    }
    info(`站点目录：docs/（${required.length} 个必需文件齐全）`);
  });

  await test(LIVE_URL ? '打开线上站点' : '启动本地静态服务并打开页面', async () => {
    if (LIVE_URL) {
      baseUrl = LIVE_URL;
    } else {
      const s = await serveSite();
      server = s.server;
      missingAssets = s.missing;
      baseUrl = `http://127.0.0.1:${s.port}/`;
    }
    browser = await puppeteer.launch({
      executablePath: chromePath,
      headless: 'new',
      protocolTimeout: 120000,
      userDataDir: fs.mkdtempSync('/tmp/aitx-site-'),
      args: [
        '--no-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--no-first-run',
        '--hide-scrollbars',
        ...(LIVE_URL ? [`--proxy-server=${PROXY}`] : []),
      ],
    });
    ready = true;
    info(baseUrl);
  });

  if (!ready) {
    summary();
    process.exit(1);
  }

  group('1. 资源与报错');

  const desktop = await openSite({ width: 1440, height: 900 });

  await test('页面无控制台报错', () => {
    assertEqual(consoleErrors.length, 0, `不应有报错，实际：${consoleErrors.join(' | ')}`);
  });

  await test('所有资源都加载成功（无 404）', () => {
    const bad = [...missingAssets, ...failedResponses];
    assertEqual(bad.length, 0, `有资源加载失败：${bad.join(' | ')}`);
  });

  await test('三个样式文件都生效', async () => {
    const applied = await desktop.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      const header = document.querySelector('.site-header');
      return {
        sheets: document.styleSheets.length,
        brand: style.getPropertyValue('--color-brand').trim(),
        headerPosition: getComputedStyle(header).position,
      };
    });
    assert(applied.sheets >= 3, `应加载 3 个样式表，实际 ${applied.sheets}`);
    assertEqual(applied.brand, '#4f7cff', '设计令牌应生效');
    assertEqual(applied.headerPosition, 'sticky', '顶栏应为 sticky');
  });

  group('2. 布局与响应式');

  await test('桌面端不出现横向滚动', async () => {
    const overflow = await desktop.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    assert(
      overflow.scrollWidth <= overflow.innerWidth + 1,
      `桌面端横向溢出：scrollWidth=${overflow.scrollWidth} > innerWidth=${overflow.innerWidth}`
    );
  });

  await test('手机端（375px）不出现横向滚动', async () => {
    const mobile = await openSite({ width: 375, height: 812 });
    const overflow = await mobile.evaluate(() => {
      const doc = document.documentElement;
      // 逐块找出可能溢出的元素，便于定位问题
      const offenders = [...document.body.querySelectorAll('*')]
        .filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1)
        .slice(0, 5)
        .map((el) => `${el.tagName.toLowerCase()}.${(el.className || '').toString().split(' ')[0]}`);
      return { scrollWidth: doc.scrollWidth, innerWidth: window.innerWidth, offenders };
    });
    assert(
      overflow.scrollWidth <= overflow.innerWidth + 1,
      `手机端横向溢出：${overflow.scrollWidth} > ${overflow.innerWidth}｜越界元素：${overflow.offenders.join(', ')}`
    );
    await mobile.screenshot({ path: path.join(OUT_DIR, '11-site-mobile.png'), fullPage: false });
    await mobile.close();
  });

  await test('移动端导航可展开、可收起', async () => {
    const mobile = await openSite({ width: 375, height: 812 });
    const closed = await mobile.evaluate(() => {
      const nav = document.getElementById('site-nav');
      return { visible: nav.getBoundingClientRect().height > 0 && getComputedStyle(nav).visibility === 'visible' };
    });
    assert(!closed.visible, '默认应收起');

    // 展开 / 收起都带了 CSS 过渡，读取前要等过渡跑完，否则拿到的还是上一帧的状态
    const TRANSITION_SETTLE_MS = 320;

    await mobile.evaluate(() => document.getElementById('nav-toggle').click());
    const opened = await mobile.evaluate(async (waitMs) => {
      await new Promise((r) => setTimeout(r, waitMs));
      const nav = document.getElementById('site-nav');
      return {
        expanded: document.getElementById('nav-toggle').getAttribute('aria-expanded'),
        isOpen: nav.classList.contains('is-open'),
        visible: getComputedStyle(nav).visibility === 'visible',
        height: Math.round(nav.getBoundingClientRect().height),
        links: nav.querySelectorAll('.site-nav__link').length,
      };
    }, TRANSITION_SETTLE_MS);
    assertEqual(opened.expanded, 'true', 'aria-expanded 应同步');
    assert(opened.isOpen && opened.visible, `点击后应展开可见，实际 ${JSON.stringify(opened)}`);
    assert(opened.height > 0, '展开后应有可见高度');
    assertEqual(opened.links, 5, '应有 5 个导航项');

    await mobile.evaluate(() => document.getElementById('nav-toggle').click());
    const closedAgain = await mobile.evaluate(async (waitMs) => {
      await new Promise((r) => setTimeout(r, waitMs));
      const nav = document.getElementById('site-nav');
      return {
        isOpen: nav.classList.contains('is-open'),
        visible: getComputedStyle(nav).visibility === 'visible',
        expanded: document.getElementById('nav-toggle').getAttribute('aria-expanded'),
      };
    }, TRANSITION_SETTLE_MS);
    assert(!closedAgain.isOpen && !closedAgain.visible, '再次点击应收起');
    assertEqual(closedAgain.expanded, 'false', 'aria-expanded 应复位');
    info(`移动端导航：${opened.links} 项，展开高度 ${opened.height}px，展开/收起正常`);
    await mobile.close();
  });

  await test('桌面端导航常驻显示', async () => {
    const nav = await desktop.evaluate(() => {
      const node = document.getElementById('site-nav');
      const toggle = document.getElementById('nav-toggle');
      return {
        navVisible: getComputedStyle(node).visibility === 'visible' && node.getBoundingClientRect().height > 0,
        toggleHidden: getComputedStyle(toggle).display === 'none',
      };
    });
    assert(nav.navVisible, '桌面端导航应常驻显示');
    assert(nav.toggleHidden, '桌面端不应显示汉堡按钮');
  });

  group('3. 内容完整性');

  await test('页面结构包含全部主要分区', async () => {
    const sections = await desktop.evaluate(() =>
      ['features', 'panel', 'install', 'notes', 'faq'].map((id) => {
        const node = document.getElementById(id);
        return { id, exists: !!node, isSection: node?.tagName.toLowerCase() === 'section' };
      })
    );
    for (const s of sections) {
      assert(s.exists, `缺少分区 #${s.id}`);
      assert(s.isSection, `#${s.id} 应使用 <section> 语义标签`);
    }
    info(sections.map((s) => s.id).join(' / '));
  });

  await test('三大核心功能都有独立的演示块', async () => {
    const features = await desktop.evaluate(() =>
      [...document.querySelectorAll('.feature')].map((f) => ({
        title: f.querySelector('.feature__title')?.textContent.trim(),
        items: f.querySelectorAll('.feature__item').length,
        hasMockup: !!f.querySelector('.browser'),
        mockupLabel: f.querySelector('.browser')?.getAttribute('aria-label') || '',
      }))
    );
    assertEqual(features.length, 3, `应有 3 个功能块，实际 ${features.length}`);
    assertEqual(features[0].title, '全页面翻译', '第一个功能应为全页面翻译');
    assertEqual(features[1].title, '划词翻译', '第二个功能应为划词翻译');
    assertEqual(features[2].title, '网页总结', '第三个功能应为网页总结');
    for (const f of features) {
      assert(f.items >= 3, `${f.title} 应至少列 3 条卖点`);
      assert(f.hasMockup, `${f.title} 应有界面演示`);
      assert(f.mockupLabel.length > 6, `${f.title} 的演示图应有替代文本`);
    }
    info(features.map((f) => `${f.title}(${f.items} 条卖点)`).join(' · '));
  });

  await test('安装说明为分步流程且含可复制命令', async () => {
    const install = await desktop.evaluate(() => ({
      steps: [...document.querySelectorAll('.step')].map((s) => ({
        num: s.querySelector('.step__num')?.textContent.trim(),
        title: s.querySelector('.step__title')?.textContent.trim(),
      })),
      copyButtons: document.querySelectorAll('[data-copy-target]').length,
      hasChromeUrl: !!document.getElementById('cmd-extensions'),
      hasCloneCmd: !!document.getElementById('cmd-clone'),
      providers: document.querySelectorAll('.table tbody tr').length,
    }));
    assert(install.steps.length >= 4, `安装步骤应至少 4 步，实际 ${install.steps.length}`);
    assertEqual(install.steps[0].num, '1', '步骤应从 1 开始编号');
    assert(install.hasChromeUrl && install.hasCloneCmd, '应包含 chrome://extensions/ 与 git clone 命令');
    assertEqual(install.copyButtons, 2, '两条命令应各有一个复制按钮');
    assert(install.providers >= 5, `服务商对照表应有 5 行，实际 ${install.providers}`);
    info(install.steps.map((s) => `${s.num}.${s.title}`).join(' → '));
  });

  await test('注意要点覆盖关键风险项', async () => {
    const notes = await desktop.evaluate(() =>
      [...document.querySelectorAll('.note')].map((n) => ({
        title: n.querySelector('.note__title')?.textContent.trim(),
        text: n.textContent,
      }))
    );
    assert(notes.length >= 6, `注意要点应至少 6 条，实际 ${notes.length}`);
    const joined = notes.map((n) => n.title + n.text).join(' ');
    const mustHave = [
      ['自备 API Key', '必须自备 API Key'],
      ['Base URL 误填', 'Base URL 别填成密钥管理页'],
      ['不可用页面', '这三类页面用不了'],
      ['刷新页面', '已打开的网页要刷一下'],
      ['隐私', '都只存在本机'],
      ['token 消耗', 'token 消耗与费用'],
    ];
    for (const [label, keyword] of mustHave) {
      assert(joined.includes(keyword), `注意要点应包含「${label}」`);
    }
    info(`${notes.length} 条注意要点：${notes.map((n) => n.title).join(' / ')}`);
  });

  await test('常见问题用 details 折叠且内容非空', async () => {
    const faq = await desktop.evaluate(() =>
      [...document.querySelectorAll('.faq__item')].map((item) => ({
        q: item.querySelector('.faq__question')?.textContent.trim(),
        a: item.querySelector('.faq__answer')?.textContent.trim().length || 0,
        isDetails: item.tagName.toLowerCase() === 'details',
      }))
    );
    assert(faq.length >= 5, `常见问题应至少 5 条，实际 ${faq.length}`);
    for (const item of faq) {
      assert(item.isDetails, '常见问题应使用 <details> 以便无 JS 也能展开');
      assert(item.a > 20, `答案内容过短：${item.q}`);
    }
    info(`${faq.length} 条 FAQ，首条：${faq[0].q}`);
  });

  group('4. 规范符合性');

  await test('没有行内样式（style 属性）', async () => {
    const inline = await desktop.evaluate(() =>
      [...document.querySelectorAll('[style]')].map((el) => el.tagName.toLowerCase()).slice(0, 5)
    );
    assertEqual(inline.length, 0, `不应存在行内样式，实际：${inline.join(', ')}`);
  });

  await test('类名统一使用短横线 / BEM 写法', async () => {
    const bad = await desktop.evaluate(() => {
      const names = new Set();
      document.querySelectorAll('[class]').forEach((el) => {
        String(el.className)
          .split(/\s+/)
          .filter(Boolean)
          .forEach((n) => names.add(n));
      });
      // 允许小写字母、数字、短横线、下划线（BEM 双下划线/双短横线）
      return [...names].filter((n) => !/^[a-z][a-z0-9_-]*$/.test(n));
    });
    assertEqual(bad.length, 0, `存在不合规的类名：${bad.join(', ')}`);
  });

  await test('页内锚点全部指向真实元素', async () => {
    const broken = await desktop.evaluate(() =>
      [...document.querySelectorAll('a[href^="#"]')]
        .map((a) => a.getAttribute('href'))
        .filter((href) => href && href !== '#' && !document.querySelector(href))
    );
    assertEqual(broken.length, 0, `存在失效锚点：${broken.join(', ')}`);
  });

  await test('标题层级与语义标签正确', async () => {
    const structure = await desktop.evaluate(() => ({
      h1: document.querySelectorAll('h1').length,
      h2: document.querySelectorAll('h2').length,
      header: !!document.querySelector('header.site-header'),
      main: !!document.querySelector('main#main'),
      footer: !!document.querySelector('footer.site-footer'),
      lang: document.documentElement.lang,
      title: document.title,
      desc: document.querySelector('meta[name="description"]')?.content.length || 0,
      viewport: document.querySelector('meta[name="viewport"]')?.content || '',
    }));
    assertEqual(structure.h1, 1, '应有且仅有一个 h1');
    assert(structure.h2 >= 4, `应有多个 h2 分节，实际 ${structure.h2}`);
    assert(structure.header && structure.main && structure.footer, '应包含 header/main/footer 语义标签');
    assertEqual(structure.lang, 'zh-CN');
    assert(structure.title.length > 5 && structure.desc > 20, '应有标题与描述');
    assert(structure.viewport.includes('width=device-width'), 'viewport 应包含 width=device-width');
  });

  await test('复制按钮点击有反馈', async () => {
    const feedback = await desktop.evaluate(async () => {
      const btn = document.querySelector('[data-copy-target="cmd-extensions"]');
      const original = btn.textContent;
      btn.click();
      await new Promise((r) => setTimeout(r, 120));
      const after = btn.textContent;
      return { original, after };
    });
    assert(
      feedback.after === '已复制 ✓' || feedback.after === '请手动复制',
      `点击后应给出反馈，实际：${feedback.after}`
    );
    info(`复制按钮反馈：${feedback.after}`);
  });

  group('5. 截图存档');

  await test('生成桌面端与手机端截图', async () => {
    await desktop.bringToFront();
    await desktop.screenshot({ path: path.join(OUT_DIR, '12-site-desktop.png'), fullPage: false });
    const full = await openSite({ width: 1440, height: 900 });
    await full.screenshot({ path: path.join(OUT_DIR, '13-site-full.png'), fullPage: true });
    await full.close();
    const files = fs.readdirSync(OUT_DIR).filter((f) => f.startsWith('1') && f.endsWith('.png')).sort();
    assert(files.length >= 3, `应生成至少 3 张站点截图，实际 ${files.length}`);
    info(files.join(', '));
  });
}

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
