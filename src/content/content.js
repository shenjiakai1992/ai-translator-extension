/**
 * 内容脚本 Content Script（注入到每个网页）
 *
 * 职责：
 *  1. 整页翻译：抽取页面文本 → 分批交给后台翻译 → 原地替换，支持一键还原、双语对照
 *  2. 划词翻译：选中文字后浮出「译」按钮，点击弹出译文卡片
 *  3. 网页总结：抓取正文，生成要点式总结侧边栏
 *
 * 所有 UI 都放在 Shadow DOM 里，避免与网页样式互相污染。
 * 本文件是普通脚本（内容脚本不能用 ES module），共享逻辑通过动态 import 扩展内的模块复用。
 */

(() => {
  'use strict';
  if (window.__AITX_LOADED__) return;
  window.__AITX_LOADED__ = true;

  const HOST_ID = 'aitx-host';

  /* ================================================================== */
  /* 状态                                                               */
  /* ================================================================== */

  const state = {
    settings: {
      targetLang: 'zh-CN',
      displayMode: 'replace',
      selectionTranslate: true,
      autoTranslate: false,
      model: '',
    },
    langLabel: '简体中文',
    translated: false,
    running: false,
    stopped: false,
    originals: new Map(), // TextNode -> 原始文本
    inserted: new Set(), // 双语对照插入的节点
    lastRange: null,
    lastText: '',
  };

  let utils = null; // 动态加载的 text-utils
  let MSG = null;
  let PAGE_CMD = null;

  const send = (type, payload) =>
    new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type, ...payload }, (res) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: { message: chrome.runtime.lastError.message, code: 'runtime' } });
            return;
          }
          resolve(res || { ok: false, error: { message: '后台无响应' } });
        });
      } catch (e) {
        resolve({ ok: false, error: { message: e?.message || String(e) } });
      }
    });

  const LANG_LABELS = {
    'zh-CN': '简体中文',
    'zh-TW': '繁体中文',
    en: 'English',
    ja: '日语',
    ko: '韩语',
    fr: '法语',
    de: '德语',
    es: '西班牙语',
    ru: '俄语',
    pt: '葡萄牙语',
  };

  function applyPublicSettings(data) {
    if (!data) return;
    state.settings = { ...state.settings, ...data };
    state.langLabel = LANG_LABELS[state.settings.targetLang] || state.settings.targetLang;
  }

  /** 每次动手前重新拉一次配置，用户在弹窗里改了语言/显示方式无需重开页面 */
  async function refreshSettings() {
    const res = await send(MSG.GET_PUBLIC_SETTINGS, {});
    if (res.ok) applyPublicSettings(res.data);
  }

  /* ================================================================== */
  /* Shadow DOM UI                                                      */
  /* ================================================================== */

  const CSS = `
:host { all: initial; }
* { box-sizing: border-box; margin: 0; padding: 0; }
.root {
  --accent: #4f7cff;
  --accent-2: #7c5cff;
  --bg: #ffffff;
  --bg-soft: #f6f7f9;
  --fg: #1c1f23;
  --muted: #6b7280;
  --border: rgba(15, 23, 42, .10);
  --shadow: 0 14px 38px rgba(15,23,42,.18), 0 2px 8px rgba(15,23,42,.08);
  --radius: 14px;
  font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  font-size: 14px;
  line-height: 1.6;
  color: var(--fg);
}
@media (prefers-color-scheme: dark) {
  .root {
    --bg: #1e2024;
    --bg-soft: #26282d;
    --fg: #e8eaed;
    --muted: #9aa0a6;
    --border: rgba(255,255,255,.12);
    --shadow: 0 14px 38px rgba(0,0,0,.5), 0 2px 8px rgba(0,0,0,.3);
  }
}
[hidden] { display: none !important; }

/* —— 划词按钮 —— */
.selbtn {
  position: fixed;
  z-index: 2147483647;
  pointer-events: auto;
  display: flex;
  align-items: center;
  gap: 4px;
  height: 32px;
  padding: 0 12px;
  border: none;
  border-radius: 999px;
  background: linear-gradient(135deg, var(--accent), var(--accent-2));
  color: #fff;
  font-size: 13px;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
  box-shadow: 0 6px 18px rgba(79,124,255,.42);
  transition: transform .12s ease, box-shadow .12s ease;
}
.selbtn:hover { transform: translateY(-1px); box-shadow: 0 10px 22px rgba(79,124,255,.5); }
.selbtn:active { transform: translateY(0); }

/* —— 通用卡片 —— */
.card {
  position: fixed;
  z-index: 2147483647;
  pointer-events: auto;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  overflow: hidden;
}
.cardhead {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-soft);
  cursor: grab;
  user-select: none;
}
.cardhead:active { cursor: grabbing; }
.cardtitle { font-size: 13px; font-weight: 650; letter-spacing: .01em; }
.tag {
  font-size: 11px;
  color: var(--accent);
  background: rgba(79,124,255,.12);
  padding: 1px 7px;
  border-radius: 999px;
  font-weight: 600;
}
.spacer { flex: 1; }
.iconbtn {
  width: 24px; height: 24px;
  display: flex; align-items: center; justify-content: center;
  border: none; border-radius: 7px;
  background: transparent; color: var(--muted);
  font-size: 14px; line-height: 1; font-family: inherit;
  cursor: pointer;
  transition: background .12s ease, color .12s ease;
}
.iconbtn:hover { background: rgba(127,127,127,.16); color: var(--fg); }
.iconbtn.done { color: #2fa36b; }

/* —— 划词结果面板 —— */
.panel { width: 380px; max-width: calc(100vw - 24px); }
.panelbody { max-height: 46vh; overflow-y: auto; padding: 12px; }
.sectionlabel {
  font-size: 11px; font-weight: 700; letter-spacing: .06em;
  color: var(--muted); text-transform: uppercase; margin-bottom: 4px;
}
.srctext {
  font-size: 13px; color: var(--muted);
  padding-bottom: 10px; margin-bottom: 10px;
  border-bottom: 1px dashed var(--border);
  word-break: break-word; white-space: pre-wrap;
}
.dsttext { font-size: 14.5px; word-break: break-word; white-space: pre-wrap; }
.dsttext.error { color: #e5484d; font-size: 13px; }

/* —— 加载态 —— */
.loading { display: flex; align-items: center; gap: 8px; color: var(--muted); font-size: 13px; padding: 6px 0; }
.spinner {
  width: 14px; height: 14px; flex: none;
  border: 2px solid rgba(127,127,127,.28);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin .7s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

/* —— 进度提示条 —— */
.toast {
  position: fixed; right: 20px; bottom: 20px;
  z-index: 2147483647; pointer-events: auto;
  display: flex; align-items: center; gap: 10px;
  min-width: 240px;
  padding: 11px 12px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 12px;
  box-shadow: var(--shadow);
  animation: rise .22s ease;
}
@keyframes rise { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
.toasttext { font-size: 13px; font-weight: 550; }
.toastsub { font-size: 11px; color: var(--muted); font-weight: 400; margin-top: 1px; }
.bar { height: 3px; border-radius: 2px; background: rgba(127,127,127,.2); overflow: hidden; margin-top: 6px; }
.barfill { height: 100%; width: 0%; background: linear-gradient(90deg, var(--accent), var(--accent-2)); transition: width .25s ease; }
.minibtn {
  flex: none;
  height: 26px; padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg);
  color: var(--fg);
  font-size: 12px; font-weight: 600; font-family: inherit;
  cursor: pointer;
}
.minibtn:hover { background: var(--bg-soft); }
.minibtn.primary { background: linear-gradient(135deg, var(--accent), var(--accent-2)); color: #fff; border-color: transparent; }

/* —— 总结侧边栏 —— */
.summary {
  position: fixed; top: 16px; right: 16px; bottom: 16px;
  width: 400px; max-width: calc(100vw - 24px);
  z-index: 2147483647; pointer-events: auto;
  display: flex; flex-direction: column;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  animation: slidein .24s ease;
}
@keyframes slidein { from { opacity: 0; transform: translateX(16px); } to { opacity: 1; transform: none; } }
.summarybody { padding: 14px 16px 20px; overflow-y: auto; flex: 1; font-size: 13.5px; }
.summarybody h3 { font-size: 14.5px; margin: 14px 0 6px; }
.summarybody h3:first-child { margin-top: 0; }
.summarybody h4 { font-size: 13.5px; margin: 12px 0 5px; color: var(--muted); }
.summarybody p { margin: 6px 0; }
.summarybody ul, .summarybody ol { margin: 6px 0 6px 18px; }
.summarybody li { margin: 4px 0; }
.summarybody strong { font-weight: 680; }
.summarybody code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px; background: var(--bg-soft); padding: 1px 5px; border-radius: 5px;
}
.summarybody::-webkit-scrollbar, .panelbody::-webkit-scrollbar { width: 8px; }
.summarybody::-webkit-scrollbar-thumb, .panelbody::-webkit-scrollbar-thumb {
  background: rgba(127,127,127,.3); border-radius: 4px;
}
`;

  let host = null;
  let $ = {};

  function ensureUI() {
    if (host && document.documentElement.contains(host)) return;
    host = document.createElement('div');
    host.id = HOST_ID;
    // 用内联样式兜底，确保关键属性不被网页样式覆盖
    host.style.cssText =
      'all: initial; position: fixed; top: 0; left: 0; width: 0; height: 0;' +
      ' z-index: 2147483647; pointer-events: none;';
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CSS;
    shadow.appendChild(style);

    const root = document.createElement('div');
    root.className = 'root';
    root.innerHTML = `
      <button class="selbtn" hidden>译</button>

      <div class="card panel" hidden>
        <div class="cardhead" data-drag="1">
          <span class="cardtitle">AI 翻译</span>
          <span class="tag" data-lang></span>
          <span class="spacer"></span>
          <button class="iconbtn" data-copy title="复制译文">⧉</button>
          <button class="iconbtn" data-close title="关闭">✕</button>
        </div>
        <div class="panelbody">
          <div class="sectionlabel">原文</div>
          <div class="srctext"></div>
          <div class="sectionlabel">译文</div>
          <div class="dsttext"></div>
        </div>
      </div>

      <div class="toast" hidden>
        <div class="spinner"></div>
        <div style="flex:1">
          <div class="toasttext">准备翻译…</div>
          <div class="toastsub"></div>
          <div class="bar"><div class="barfill"></div></div>
        </div>
        <button class="minibtn" data-stop hidden>停止</button>
        <button class="minibtn primary" data-restore hidden>还原</button>
      </div>

      <div class="summary" hidden>
        <div class="cardhead" data-drag="1">
          <span class="cardtitle">网页总结</span>
          <span class="spacer"></span>
          <button class="iconbtn" data-copy-summary title="复制总结">⧉</button>
          <button class="iconbtn" data-close-summary title="关闭">✕</button>
        </div>
        <div class="summarybody"></div>
      </div>
    `;
    shadow.appendChild(root);
    (document.body || document.documentElement).appendChild(host);

    $ = {
      root,
      selbtn: root.querySelector('.selbtn'),
      panel: root.querySelector('.panel'),
      panelSrc: root.querySelector('.srctext'),
      panelDst: root.querySelector('.dsttext'),
      langTag: root.querySelector('[data-lang]'),
      toast: root.querySelector('.toast'),
      toastText: root.querySelector('.toasttext'),
      toastSub: root.querySelector('.toastsub'),
      barFill: root.querySelector('.barfill'),
      spinner: root.querySelector('.spinner'),
      stopBtn: root.querySelector('[data-stop]'),
      restoreBtn: root.querySelector('[data-restore]'),
      summary: root.querySelector('.summary'),
      summaryBody: root.querySelector('.summarybody'),
    };

    // 绑定交互
    $.selbtn.addEventListener('mousedown', (e) => e.preventDefault()); // 保住选区
    $.selbtn.addEventListener('click', onSelectionButtonClick);
    root.querySelector('[data-close]').addEventListener('click', () => ($.panel.hidden = true));
    root.querySelector('[data-copy]').addEventListener('click', (e) => copyText($.panelDst.textContent, e.currentTarget));
    root.querySelector('[data-close-summary]').addEventListener('click', () => ($.summary.hidden = true));
    root.querySelector('[data-copy-summary]').addEventListener('click', (e) =>
      copyText($.summaryBody.innerText, e.currentTarget)
    );
    $.stopBtn.addEventListener('click', () => {
      state.stopped = true;
      showToast({ text: '正在停止…', spinner: true });
    });
    $.restoreBtn.addEventListener('click', () => {
      restorePage();
      showToast({ text: '已还原为原文', spinner: false, autoHide: 2500 });
    });
    makeDraggable($.panel);
    makeDraggable($.summary);
  }

  function makeDraggable(el) {
    const handle = el.querySelector('[data-drag]');
    if (!handle) return;
    let startX = 0;
    let startY = 0;
    let baseLeft = 0;
    let baseTop = 0;
    handle.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      const rect = el.getBoundingClientRect();
      baseLeft = rect.left;
      baseTop = rect.top;
      startX = e.clientX;
      startY = e.clientY;
      el.style.right = 'auto';
      el.style.bottom = 'auto';
      handle.setPointerCapture(e.pointerId);
      const move = (ev) => {
        const maxLeft = window.innerWidth - el.offsetWidth - 4;
        const maxTop = window.innerHeight - el.offsetHeight - 4;
        el.style.left = Math.min(Math.max(4, baseLeft + ev.clientX - startX), Math.max(4, maxLeft)) + 'px';
        el.style.top = Math.min(Math.max(4, baseTop + ev.clientY - startY), Math.max(4, maxTop)) + 'px';
      };
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
    });
  }

  async function copyText(text, btn) {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
      } catch {
        /* 忽略 */
      }
      ta.remove();
    }
    if (btn) {
      const old = btn.textContent;
      btn.textContent = '✓';
      btn.classList.add('done');
      setTimeout(() => {
        btn.textContent = old;
        btn.classList.remove('done');
      }, 1200);
    }
  }

  function showToast({ text, sub = '', progress = null, spinner = true, autoHide = 0 }) {
    ensureUI();
    $.toast.hidden = false;
    $.spinner.style.display = spinner ? '' : 'none';
    $.toastText.textContent = text;
    $.toastSub.textContent = sub;
    if (progress == null) {
      $.toast.querySelector('.bar').style.display = 'none';
    } else {
      $.toast.querySelector('.bar').style.display = '';
      $.barFill.style.width = Math.round(progress * 100) + '%';
    }
    $.stopBtn.hidden = !spinner;
    $.restoreBtn.hidden = spinner;
    if (showToast._t) clearTimeout(showToast._t);
    if (autoHide) showToast._t = setTimeout(() => ($.toast.hidden = true), autoHide);
  }

  function hideToast(delay = 0) {
    if (showToast._t) clearTimeout(showToast._t);
    if (delay) showToast._t = setTimeout(() => ($.toast.hidden = true), delay);
    else if ($.toast) $.toast.hidden = true;
  }

  /* ================================================================== */
  /* 划词翻译                                                            */
  /* ================================================================== */

  function currentSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
    const text = sel.toString().trim();
    if (!text) return null;
    const range = sel.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) return null;
    return { text, range, rect };
  }

  function placeSelectionButton(rect) {
    const btn = $.selbtn;
    const top = rect.top - 40;
    const left = rect.left + rect.width / 2 - btn.offsetWidth / 2;
    btn.style.top = Math.max(8, Math.min(top, window.innerHeight - 44)) + 'px';
    btn.style.left = Math.max(8, Math.min(left, window.innerWidth - btn.offsetWidth - 8)) + 'px';
  }

  function onMouseUp(e) {
    if (host && (e.target === host || e.composedPath?.().includes(host))) return;
    if (!state.settings.selectionTranslate) return;
    const info = currentSelection();
    if (!info || info.text.length > 5000) {
      if ($.selbtn) $.selbtn.hidden = true;
      return;
    }
    ensureUI();
    state.lastRange = info.range.cloneRange();
    state.lastText = info.text;
    $.selbtn.hidden = false;
    placeSelectionButton(info.rect);
  }

  function onSelectionButtonClick() {
    const info = currentSelection() || (state.lastText ? { text: state.lastText, rect: state.lastRange?.getBoundingClientRect() } : null);
    const text = state.lastText || info?.text;
    if (!text) return;
    $.selbtn.hidden = true;
    const rect = info?.rect || state.lastRange?.getBoundingClientRect();
    openPanel({ text, rect, loading: true });

    send(MSG.TRANSLATE_ONE, { text })
      .then((res) => {
        if (!res.ok) {
          renderPanelResult({ error: res.error?.message || '翻译失败' });
          return;
        }
        renderPanelResult({ translation: res.data.translation, model: res.data.model });
      })
      .catch((err) => renderPanelResult({ error: err?.message || String(err) }));
  }

  function openPanel({ text, rect, loading }) {
    const base = rect || { left: window.innerWidth / 2 - 190, top: 120, width: 0, height: 0 };
    const panel = $.panel;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    panel.style.left = Math.max(12, Math.min(base.left, window.innerWidth - 392)) + 'px';
    panel.style.top = Math.max(12, Math.min(base.top + base.height + 10, window.innerHeight - 120)) + 'px';
    $.langTag.textContent = state.langLabel;
    $.panelSrc.textContent = text;
    $.panelDst.className = 'dsttext';
    $.panelDst.innerHTML = loading ? '<div class="loading"><span class="spinner"></span>正在翻译…</div>' : '';
    panel.hidden = false;
  }

  function renderPanelResult({ translation, error, model }) {
    if (error) {
      $.panelDst.className = 'dsttext error';
      $.panelDst.textContent = '翻译失败：' + error;
      return;
    }
    $.panelDst.className = 'dsttext';
    $.panelDst.textContent = translation;
    if (model) $.toastSub.textContent = '';
  }

  /** 右键菜单翻译结果 —— 展示在同一张卡片里 */
  function showExternalTranslation({ original, translation, error }) {
    ensureUI();
    const rect = { left: window.innerWidth / 2 - 190, top: 100, width: 0, height: 0 };
    openPanel({ text: original, rect, loading: false });
    renderPanelResult(translation ? { translation } : { error: error || '翻译失败' });
  }

  document.addEventListener('mouseup', onMouseUp, true);
  document.addEventListener('mousedown', (e) => {
    if (host && (e.target === host || e.composedPath?.().includes(host))) return;
    if ($.selbtn) $.selbtn.hidden = true;
  }, true);
  document.addEventListener(
    'scroll',
    () => {
      if ($.selbtn && !$.selbtn.hidden && state.lastRange) {
        const rect = state.lastRange.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) $.selbtn.hidden = true;
        else placeSelectionButton(rect);
      }
    },
    { passive: true, capture: true }
  );

  /* ================================================================== */
  /* 整页翻译                                                            */
  /* ================================================================== */

  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION',
    'CODE', 'PRE', 'KBD', 'SAMP', 'VAR', 'SVG', 'CANVAS', 'IFRAME', 'OBJECT',
    'EMBED', 'VIDEO', 'AUDIO', 'TEMPLATE', 'MATH', 'TITLE', 'HEAD',
  ]);
  const MAX_NODES = 1500;
  const CONTENT_CHUNK = 60; // 每个消息携带的文本条数
  const CONTENT_CONCURRENCY = 2; // 同时在途的消息数

  function collectTargets() {
    const walker = document.createTreeWalker(
      document.body || document.documentElement,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          if (node.__aitxDone) return NodeFilter.FILTER_REJECT;
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          if (SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
          if (parent.isContentEditable) return NodeFilter.FILTER_REJECT;
          if (parent.closest('[data-aitx-skip]')) return NodeFilter.FILTER_REJECT;
          const value = node.nodeValue;
          if (!value || !value.trim()) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      }
    );

    const unique = new Map(); // 原文 -> 索引（页面里重复文案很多，去重能省大量 token）
    const texts = [];
    const targets = [];
    let scanned = 0;
    let node;
    while ((node = walker.nextNode())) {
      if (scanned++ > MAX_NODES * 4) break;
      const { prefix, core, suffix } = utils.splitWhitespace(node.nodeValue);
      if (!utils.shouldTranslate(core)) continue;
      if (utils.isProbablyTargetLang(core, state.settings.targetLang)) continue;
      let idx = unique.get(core);
      if (idx === undefined) {
        if (texts.length >= MAX_NODES) break;
        idx = texts.length;
        texts.push(core);
        unique.set(core, idx);
      }
      targets.push({ node, prefix, suffix, idx });
      if (targets.length >= MAX_NODES * 3) break;
    }
    return { texts, targets };
  }

  function applyTranslations({ texts, translations, targets }) {
    let applied = 0;
    for (const t of targets) {
      const dest = translations[t.idx];
      if (typeof dest !== 'string') continue;
      const clean = dest.trim();
      if (!clean || clean === texts[t.idx]) continue;
      const node = t.node;
      if (!node.isConnected) continue;
      if (!state.originals.has(node)) state.originals.set(node, node.nodeValue);
      node.nodeValue = t.prefix + clean + t.suffix;
      node.__aitxDone = true;
      if (state.settings.displayMode === 'bilingual') {
        const span = document.createElement('span');
        span.className = 'aitx-bi';
        span.setAttribute('data-aitx-skip', '1');
        span.textContent = ' ' + texts[t.idx];
        span.style.cssText =
          'color:#8b909a;font-size:.9em;opacity:.85;margin-left:4px;font-style:normal;';
        node.parentNode?.insertBefore(span, node.nextSibling);
        state.inserted.add(span);
      }
      applied++;
    }
    return applied;
  }

  function restorePage() {
    for (const [node, original] of state.originals) {
      try {
        node.nodeValue = original;
        // 关键：清掉已翻译标记，否则还原之后再翻译会被整页跳过
        delete node.__aitxDone;
      } catch {
        /* 忽略 */
      }
    }
    for (const el of state.inserted) {
      try {
        el.remove();
      } catch {
        /* 忽略 */
      }
    }
    state.originals.clear();
    state.inserted.clear();
    state.translated = false;
    state.running = false;
    state.stopped = false;
    send('AITX_PAGE_STATE', { translated: false });
  }

  async function translatePage() {
    if (state.running) return { started: false, reason: 'running' };
    if (state.translated) {
      restorePage();
      showToast({ text: '已还原为原文', spinner: false, autoHide: 2200 });
      return { started: true, restored: true };
    }
    if (!document.body) {
      showToast({ text: '页面尚未加载完成', spinner: false, autoHide: 2500 });
      return { started: false };
    }

    state.running = true;
    state.stopped = false;
    showToast({ text: '正在扫描页面文本…', sub: '', progress: 0 });

    const { texts, targets } = collectTargets();
    if (texts.length === 0) {
      state.running = false;
      showToast({ text: '这个页面没有找到需要翻译的内容', spinner: false, autoHide: 2600 });
      return { started: true, count: 0 };
    }

    showToast({
      text: `正在翻译 ${texts.length} 段文本…`,
      sub: `共 ${targets.length} 处 · 模型 ${state.settings.model || '默认'}`,
      progress: 0,
    });

    const chunks = [];
    for (let i = 0; i < texts.length; i += CONTENT_CHUNK) chunks.push(texts.slice(i, i + CONTENT_CHUNK));

    const translations = new Array(texts.length);
    const errors = [];
    let done = 0;
    let fatal = null;
    let cursor = 0;
    const startedAt = Date.now();

    const worker = async () => {
      while (cursor < chunks.length && !state.stopped && !fatal) {
        const index = cursor++;
        const chunk = chunks[index];
        const offset = index * CONTENT_CHUNK;
        let res;
        try {
          res = await send(MSG.TRANSLATE_TEXTS, { texts: chunk });
        } catch (err) {
          errors.push(err?.message || String(err));
          continue;
        }
        if (!res.ok) {
          errors.push(res.error?.message || '翻译请求失败');
          if (res.error?.fatal) {
            fatal = res.error.message;
            return;
          }
          continue;
        }
        const list = res.data?.translations || [];
        for (let i = 0; i < chunk.length; i++) translations[offset + i] = list[i];
        errors.push(...(res.data?.errors || []).map((e) => e.message));
        done += chunk.length;
        const applied = applyTranslations({ texts, translations, targets });
        showToast({
          text: `翻译中 ${Math.round((done / texts.length) * 100)}%`,
          sub: `已翻译 ${done}/${texts.length} 段 · 已替换 ${applied} 处`,
          progress: done / texts.length,
        });
      }
    };

    await Promise.all(new Array(Math.min(CONTENT_CONCURRENCY, chunks.length)).fill(0).map(worker));

    state.running = false;

    if (fatal) {
      if (state.originals.size > 0) {
        // 已经替换了一部分，保留结果并提示
        state.translated = true;
        showToast({ text: '翻译中断', sub: fatal, spinner: false, autoHide: 6000 });
      } else {
        showToast({ text: '翻译失败', sub: fatal, spinner: false, autoHide: 6000 });
      }
      return { started: true, error: fatal };
    }

    state.translated = state.originals.size > 0;
    send('AITX_PAGE_STATE', { translated: state.translated });

    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    if (state.stopped) {
      showToast({ text: '已停止翻译', sub: `已处理 ${done}/${texts.length} 段`, spinner: false, autoHide: 3000 });
    } else if (errors.length > 0) {
      showToast({
        text: '翻译完成（部分失败）',
        sub: `${state.originals.size} 处已替换 · ${errors.length} 段失败：${String(errors[0]).slice(0, 40)}`,
        spinner: false,
        autoHide: 7000,
      });
    } else {
      showToast({
        text: '翻译完成',
        sub: `${texts.length} 段 · ${state.originals.size} 处替换 · 耗时 ${seconds}s`,
        spinner: false,
        autoHide: 4000,
      });
    }
    return { started: true, count: texts.length, applied: state.originals.size };
  }

  /* ================================================================== */
  /* 网页总结                                                            */
  /* ================================================================== */

  function extractReadableText() {
    const pick = () => {
      const selectors = ['article', 'main', '[role="main"]', '#content', '.content', '#main', '.post', '.article', '.markdown-body'];
      let best = null;
      let bestLen = 0;
      for (const sel of selectors) {
        for (const el of document.querySelectorAll(sel)) {
          const len = (el.innerText || '').length;
          if (len > bestLen) {
            bestLen = len;
            best = el;
          }
        }
      }
      if (best && bestLen > 400) return best;
      return document.body;
    };

    const source = pick();
    if (!source) return '';
    const clone = source.cloneNode(true);
    clone
      .querySelectorAll(
        'script, style, noscript, nav, footer, aside, header, form, iframe, svg, button, [aria-hidden="true"], [data-aitx-skip], .ad, .ads, .advertisement'
      )
      .forEach((el) => el.remove());
    const text = (clone.innerText || clone.textContent || '')
      .replace(/[ \t\u00a0]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return text;
  }

  async function summarizePage() {
    ensureUI();
    const body = $.summaryBody;
    $.summary.hidden = false;
    body.innerHTML = '<div class="loading"><span class="spinner"></span>正在读取网页正文…</div>';

    const text = utils.truncateText(extractReadableText(), 12000);
    if (!text || text.length < 80) {
      body.innerHTML =
        '<div class="dsttext error">这个页面没有提取到足够的正文内容，换一个内容型网页试试。</div>';
      return { started: false };
    }

    body.innerHTML = `<div class="loading"><span class="spinner"></span>AI 正在总结（约 ${Math.round(
      text.length / 1000
    )}k 字）…</div>`;

    const res = await send(MSG.SUMMARIZE, {
      title: document.title,
      url: location.href,
      text,
    });

    if (!res.ok) {
      body.innerHTML = `<div class="dsttext error">总结失败：${utils.escapeHtml(
        res.error?.message || '未知错误'
      )}</div>`;
      return { started: true, error: res.error?.message };
    }
    body.innerHTML = utils.renderSimpleMarkdown(res.data.summary);
    return { started: true };
  }

  /* ================================================================== */
  /* 消息入口                                                            */
  /* ================================================================== */

  function handlePageMessage(msg) {
    switch (msg?.type) {
      case MSG.SHOW_TRANSLATION:
        showExternalTranslation(msg);
        return { ok: true };
      case PAGE_CMD.GET_STATE:
        return { ok: true, translated: state.translated, running: state.running, settings: state.settings };
      case PAGE_CMD.PING:
        return { ok: true };
      case PAGE_CMD.TOGGLE_PAGE:
        translatePage().catch((err) => console.warn('[AI 翻译助手] 整页翻译异常', err)); // 立即返回，避免弹窗关闭后通道断开
        return { ok: true, accepted: true };
      case PAGE_CMD.RESTORE_PAGE:
        restorePage();
        showToast({ text: '已还原为原文', spinner: false, autoHide: 2200 });
        return { ok: true };
      case PAGE_CMD.SUMMARIZE_PAGE:
        summarizePage().catch((err) => console.warn('[AI 翻译助手] 总结异常', err));
        return { ok: true, accepted: true };
      default:
        return undefined;
    }
  }

  function registerMessageListener() {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      const result = handlePageMessage(msg);
      if (result === undefined) return false;
      sendResponse(result);
      return true;
    });
  }

  /* ================================================================== */
  /* 启动                                                                */
  /* ================================================================== */

  (async () => {
    try {
      const [u, p] = await Promise.all([
        import(chrome.runtime.getURL('src/lib/text-utils.js')),
        import(chrome.runtime.getURL('src/lib/protocol.js')),
      ]);
      utils = u;
      MSG = p.MSG;
      PAGE_CMD = p.PAGE_CMD;
    } catch (err) {
      console.warn('[AI 翻译助手] 共享模块加载失败', err);
      return;
    }

    // 共享模块就绪后再开始接收消息，避免消息处理时 MSG 还是 null
    registerMessageListener();

    const res = await send(MSG.GET_PUBLIC_SETTINGS, {});
    if (res.ok) applyPublicSettings(res.data);

    if (state.settings.autoTranslate) {
      // 等页面稍微稳定一些再自动翻译
      setTimeout(() => translatePage().catch(() => {}), 1500);
    }
  })();
})();
