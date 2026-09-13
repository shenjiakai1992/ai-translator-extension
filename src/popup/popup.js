/**
 * 弹窗逻辑：配置模型 + 触发页面翻译 / 还原 / 总结。
 * 弹窗可以直接读写 chrome.storage，但翻译请求统一走后台，保证只有一处接触 API Key。
 */

import { getSettings, saveSettings, LANGUAGES } from '../lib/settings.js';
import { inspectBaseUrl } from '../lib/llm.js';
import { MSG, PAGE_CMD } from '../lib/protocol.js';

const el = (id) => document.getElementById(id);
const ui = {
  statusLine: el('statusLine'),
  btnToggleSettings: el('btnToggleSettings'),
  btnTranslate: el('btnTranslate'),
  btnSummary: el('btnSummary'),
  btnRestore: el('btnRestore'),
  translateSub: el('translateSub'),
  banner: el('banner'),
  settings: el('settings'),
  baseUrl: el('baseUrl'),
  baseUrlHint: el('baseUrlHint'),
  apiKey: el('apiKey'),
  btnToggleKey: el('btnToggleKey'),
  model: el('model'),
  targetLang: el('targetLang'),
  displayMode: el('displayMode'),
  disableThinking: el('disableThinking'),
  selectionTranslate: el('selectionTranslate'),
  autoTranslate: el('autoTranslate'),
  btnTest: el('btnTest'),
  btnSave: el('btnSave'),
  testOut: el('testOut'),
  flash: el('flash'),
  footNote: el('footNote'),
};

let settings = null;
let activeTab = null;
let pageReady = false;
let pageState = { translated: false, running: false };

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

function flash(text) {
  ui.flash.textContent = text;
  ui.flash.hidden = false;
  clearTimeout(flash._t);
  flash._t = setTimeout(() => (ui.flash.hidden = true), 1600);
}

function showBanner(text, kind = 'error') {
  ui.banner.textContent = text;
  ui.banner.className = 'banner' + (kind === 'info' ? ' info' : '');
  ui.banner.hidden = false;
}

function hideBanner() {
  ui.banner.hidden = true;
}

async function sendToPage(type) {
  if (!activeTab?.id) throw new Error('没有找到当前标签页');
  const res = await chrome.tabs.sendMessage(activeTab.id, { type });
  if (!res) throw new Error('页面没有响应');
  return res;
}

/* ------------------------------------------------------------------ */
/* 初始化                                                              */
/* ------------------------------------------------------------------ */

async function init() {
  settings = await getSettings();

  // 语言下拉
  ui.targetLang.innerHTML = LANGUAGES.map(
    (l) => `<option value="${l.code}">${l.label}</option>`
  ).join('');

  // 回填表单
  ui.baseUrl.value = settings.baseUrl || '';
  ui.apiKey.value = settings.apiKey || '';
  ui.model.value = settings.model || '';
  ui.targetLang.value = settings.targetLang;
  ui.displayMode.value = settings.displayMode;
  ui.disableThinking.checked = settings.disableThinking !== false;
  ui.selectionTranslate.checked = settings.selectionTranslate !== false;
  ui.autoTranslate.checked = !!settings.autoTranslate;

  refreshUrlHint();
  if (!settings.apiKey) {
    expandSettings(true);
    showBanner('还没有配置 API Key。展开下方设置，填入接口地址、Key 和模型名后即可使用。', 'info');
  }
  syncStatus();

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTab = tab;
  await probePage();
}

/** 探测当前页面能不能用（浏览器内置页、应用商店页会失败） */
async function probePage() {
  // 先确认内容脚本是否就绪，顺便拿到当前页面的状态
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await sendToPage(PAGE_CMD.GET_STATE);
      pageReady = true;
      pageState = { translated: !!res.translated, running: !!res.running };
      paintPageState();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  pageReady = false;
  pageState = { translated: false, running: false };
  ui.btnTranslate.disabled = true;
  ui.btnSummary.disabled = true;
  ui.btnRestore.disabled = true;
  showBanner('当前页面不支持扩展（浏览器内置页面、应用商店或 PDF 阅读器中无法注入），请切换到普通网页再试。', 'info');
}

function paintPageState() {
  ui.btnTranslate.disabled = !pageReady;
  ui.btnSummary.disabled = !pageReady;
  ui.btnRestore.disabled = !pageReady || !pageState.translated;

  if (pageState.running) {
    ui.btnTranslate.querySelector('.qtitle').textContent = '正在翻译…';
    ui.translateSub.textContent = '请稍候，页面右上角可查看进度';
  } else if (pageState.translated) {
    ui.btnTranslate.querySelector('.qtitle').textContent = '还原本页';
    ui.translateSub.textContent = '点击可切回原文';
  } else {
    ui.btnTranslate.querySelector('.qtitle').textContent = '翻译本页';
    ui.translateSub.textContent =
      settings?.displayMode === 'bilingual' ? '译文 + 原文对照显示' : '整页替换为译文';
  }
}

function syncStatus() {
  if (!settings?.apiKey) {
    ui.statusLine.textContent = '未配置 API Key · 点右上角设置';
    ui.statusLine.className = 'warn';
    return;
  }
  const lang = LANGUAGES.find((l) => l.code === settings.targetLang);
  ui.statusLine.textContent = `${settings.model || '未填模型'} · 译为${lang ? lang.label : settings.targetLang}`;
  ui.statusLine.className = 'ok';
}

function refreshUrlHint() {
  const raw = ui.baseUrl.value.trim();
  const check = inspectBaseUrl(raw);
  if (!raw) {
    ui.baseUrlHint.textContent = '例如 https://api.deepseek.com/v1 （多数服务需要带 /v1）';
    ui.baseUrlHint.className = 'hint';
    return true;
  }
  ui.baseUrlHint.textContent = check.ok
    ? '地址格式正常。填 https://api.deepseek.com 也会自动补全为 /v1/chat/completions'
    : check.hint;
  ui.baseUrlHint.className = 'hint' + (check.ok ? '' : ' bad');
  return check.ok;
}

/* ------------------------------------------------------------------ */
/* 设置面板                                                            */
/* ------------------------------------------------------------------ */

function expandSettings(expand) {
  ui.settings.hidden = !expand;
  ui.btnToggleSettings.classList.toggle('active', expand);
}

ui.btnToggleSettings.addEventListener('click', () => expandSettings(ui.settings.hidden));
ui.baseUrl.addEventListener('input', refreshUrlHint);

ui.btnToggleKey.addEventListener('click', () => {
  const hidden = ui.apiKey.type === 'password';
  ui.apiKey.type = hidden ? 'text' : 'password';
  ui.btnToggleKey.textContent = hidden ? '隐藏' : '显示';
});

function collectForm() {
  return {
    baseUrl: ui.baseUrl.value.trim().replace(/\/+$/, ''),
    apiKey: ui.apiKey.value.trim(),
    model: ui.model.value.trim(),
    targetLang: ui.targetLang.value,
    displayMode: ui.displayMode.value,
    disableThinking: ui.disableThinking.checked,
    selectionTranslate: ui.selectionTranslate.checked,
    autoTranslate: ui.autoTranslate.checked,
  };
}

async function persist(patch, { quiet = false } = {}) {
  settings = await saveSettings(patch);
  syncStatus();
  if (!quiet) flash('已保存');
}

ui.btnSave.addEventListener('click', async () => {
  const form = collectForm();
  if (!refreshUrlHint()) {
    showBanner('接口地址看起来不对：' + ui.baseUrlHint.textContent, 'error');
    ui.baseUrl.focus();
    return;
  }
  if (!form.apiKey) {
    showBanner('API Key 不能为空。', 'error');
    ui.apiKey.focus();
    return;
  }
  hideBanner();
  await persist(form);
  paintPageState();
});

// 开关与下拉改动即时生效（不写进表单待保存状态，避免用户忘记点保存）
for (const node of [ui.targetLang, ui.displayMode]) {
  node.addEventListener('change', async () => {
    await persist({ [node.id]: node.value }, { quiet: true });
    flash('已自动保存');
    paintPageState();
  });
}
for (const node of [ui.disableThinking, ui.selectionTranslate, ui.autoTranslate]) {
  node.addEventListener('change', async () => {
    await persist({ [node.id]: node.checked }, { quiet: true });
    flash('已自动保存');
  });
}

ui.btnTest.addEventListener('click', async () => {
  const form = collectForm();
  if (!refreshUrlHint()) {
    showBanner('接口地址看起来不对：' + ui.baseUrlHint.textContent, 'error');
    return;
  }
  if (!form.apiKey) {
    showBanner('请先填写 API Key 再测试。', 'error');
    return;
  }
  hideBanner();
  ui.btnTest.disabled = true;
  ui.btnTest.textContent = '测试中…';
  ui.testOut.hidden = false;
  ui.testOut.className = 'testout';
  ui.testOut.textContent = `正在请求 ${form.model || '(未填模型)'} …`;

  try {
    const res = await chrome.runtime.sendMessage({
      type: MSG.TEST_CONNECTION,
      settings: form, // 用表单里未保存的值测试
    });
    if (!res?.ok) throw new Error(res?.error?.message || '测试失败');
    const d = res.data;
    ui.testOut.className = 'testout ok';
    ui.testOut.textContent = `连接成功 ✓ 模型 ${d.model} · 耗时 ${(d.elapsedMs / 1000).toFixed(1)}s · 返回：${d.text}`;
  } catch (err) {
    ui.testOut.className = 'testout bad';
    ui.testOut.textContent = '连接失败 ✗ ' + (err?.message || String(err));
  } finally {
    ui.btnTest.disabled = false;
    ui.btnTest.textContent = '测试连接';
  }
});

/* ------------------------------------------------------------------ */
/* 页面操作                                                            */
/* ------------------------------------------------------------------ */

ui.btnTranslate.addEventListener('click', async () => {
  if (!pageReady) return;
  if (!settings?.apiKey) {
    expandSettings(true);
    showBanner('请先配置 API Key 再翻译。', 'error');
    return;
  }
  try {
    await sendToPage(PAGE_CMD.TOGGLE_PAGE);
    window.close();
  } catch (err) {
    showBanner('操作失败：' + (err?.message || String(err)), 'error');
  }
});

ui.btnRestore.addEventListener('click', async () => {
  if (!pageReady) return;
  try {
    await sendToPage(PAGE_CMD.RESTORE_PAGE);
    flash('已还原');
    pageState.translated = false;
    paintPageState();
  } catch (err) {
    showBanner('操作失败：' + (err?.message || String(err)), 'error');
  }
});

ui.btnSummary.addEventListener('click', async () => {
  if (!pageReady) return;
  if (!settings?.apiKey) {
    expandSettings(true);
    showBanner('请先配置 API Key 再总结。', 'error');
    return;
  }
  try {
    await sendToPage(PAGE_CMD.SUMMARIZE_PAGE);
    window.close();
  } catch (err) {
    showBanner('操作失败：' + (err?.message || String(err)), 'error');
  }
});

init().catch((err) => {
  ui.statusLine.textContent = '初始化失败：' + (err?.message || String(err));
  ui.statusLine.className = 'warn';
});
