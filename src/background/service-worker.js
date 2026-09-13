/**
 * 后台 Service Worker：扩展的“大脑”。
 *  - 所有模型请求都在这里发出（API Key 只存在于后台与弹窗，绝不进入网页上下文）
 *  - 处理右键菜单、快捷键、弹窗与页面之间的消息路由
 */

import { MSG, PAGE_CMD } from '../lib/protocol.js';
import { getSettings, saveSettings, toPublicSettings, languagePrompt } from '../lib/settings.js';
import { testConnection, LLMError } from '../lib/llm.js';
import { translateTexts, translateOne, summarizeContent } from '../lib/translator.js';
import {
  recordEvent,
  getHistory,
  getStats,
  deleteHistoryEntry,
  clearHistory,
  clearAll,
  summarizeStats,
} from '../lib/history.js';

const CONTEXT_MENU_ID = 'aitx-translate-selection';

/* ------------------------------------------------------------------ */
/* 右键菜单与快捷键                                                    */
/* ------------------------------------------------------------------ */

function setupContextMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create(
      {
        id: CONTEXT_MENU_ID,
        title: 'AI 翻译：“%s”',
        contexts: ['selection'],
      },
      () => void chrome.runtime.lastError
    );
    chrome.contextMenus.create(
      {
        id: 'aitx-translate-page',
        title: 'AI 翻译整个页面',
        contexts: ['page'],
      },
      () => void chrome.runtime.lastError
    );
  });
}

chrome.runtime.onInstalled.addListener(() => {
  setupContextMenu();
});
chrome.runtime.onStartup.addListener(() => {
  setupContextMenu();
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;
  try {
    if (info.menuItemId === 'aitx-translate-page') {
      const ensuredPage = await ensureContentScript(tab.id);
      if (ensuredPage.ok) await sendToTab(tab.id, { type: PAGE_CMD.TOGGLE_PAGE });
      return;
    }
    if (info.menuItemId !== CONTEXT_MENU_ID) return;
    const text = (info.selectionText || '').trim();
    if (!text) return;

    // 老标签页可能还没注入内容脚本，先补一次
    const ensured = await ensureContentScript(tab.id);
    if (!ensured.ok) {
      await sendToTab(tab.id, {
        type: MSG.SHOW_TRANSLATION,
        original: text,
        error: '当前页面不支持扩展（浏览器内置页面、应用商店或 PDF 阅读器），请换一个普通网页再试',
      }).catch(() => {});
      return;
    }

    const settings = await getSettings();
    const label = languagePrompt(settings.targetLang);
    const srcLabel = sourceLabelOf(settings);
    setBadge(tab.id, '…', '#4f7cff');
    const startedAt = Date.now();
    try {
      const { translation, model, usage } = await translateOne({
        settings,
        text,
        targetLangLabel: label,
        sourceLangLabel: srcLabel,
      });
      await sendToTab(tab.id, {
        type: MSG.SHOW_TRANSLATION,
        original: text,
        translation,
        model,
      });
      setBadge(tab.id, '', '#00000000');
      record(
        {
          type: 'menu',
          model,
          sourceLang: settings.sourceLang,
          targetLang: settings.targetLang,
          items: 1,
          chars: text.length,
          prompt: usage?.prompt_tokens,
          completion: usage?.completion_tokens,
          durationMs: Date.now() - startedAt,
          url: tab.url || '',
          title: tab.title || '',
          src: text,
          dst: translation,
        },
        settings
      );
    } catch (err) {
      record(
        {
          type: 'menu',
          model: settings.model,
          sourceLang: settings.sourceLang,
          targetLang: settings.targetLang,
          items: 1,
          chars: text.length,
          durationMs: Date.now() - startedAt,
          status: 'failed',
          error: err?.message || String(err),
          src: text,
        },
        settings
      );
      setBadge(tab.id, '!', '#e5484d');
      await sendToTab(tab.id, {
        type: MSG.SHOW_TRANSLATION,
        original: text,
        error: err?.message || String(err),
      });
    }
  } catch (err) {
    console.warn('[AI 翻译助手] 右键菜单处理失败', err);
  }
});

chrome.commands?.onCommand.addListener(async (command) => {
  if (command !== 'toggle-page-translate') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  const ensured = await ensureContentScript(tab.id);
  if (ensured.ok) await sendToTab(tab.id, { type: PAGE_CMD.TOGGLE_PAGE }).catch(() => {});
});

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

function setBadge(tabId, text, color) {
  try {
    chrome.action.setBadgeText({ tabId, text: text || '' });
    if (color) chrome.action.setBadgeBackgroundColor({ tabId, color });
  } catch {
    /* 忽略：标签页可能已关闭 */
  }
}

async function sendToTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (err) {
    throw new LLMError('当前页面无法使用扩展（可能是浏览器内置页面或应用商店页面），请换一个普通网页再试', {
      code: 'no_content_script',
      fatal: true,
    });
  }
}

/**
 * 确保标签页里有可用的内容脚本。
 *
 * 为什么需要它：扩展刚安装或重载时，**已经打开的标签页不会自动注入内容脚本**
 * （这是 Chrome 的行为，只有刷新后的页面才会注入）。以前遇到这种情况只能提示用户
 * 「请刷新页面」，现在主动补注入一次，用户无感。
 * 对浏览器内置页（chrome://）、应用商店、PDF 阅读器，Chrome 会拒绝注入，此时返回失败由上层提示。
 */
async function ensureContentScript(tabId) {
  const ping = async () => {
    try {
      const res = await chrome.tabs.sendMessage(tabId, { type: PAGE_CMD.PING });
      return !!res?.ok;
    } catch {
      return false;
    }
  };

  if (await ping()) return { ok: true, alreadyInjected: true };

  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      files: ['src/content/content.js'],
    });
  } catch (err) {
    return { ok: false, reason: err?.message || String(err) };
  }

  // 内容脚本要先动态加载共享模块、注册好消息监听才算就绪，给它一点时间
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 120));
    if (await ping()) return { ok: true, injected: true };
  }
  return { ok: false, reason: '注入后仍无响应' };
}

function serializeError(err) {
  if (err instanceof LLMError) {
    return { message: err.message, code: err.code, status: err.status, fatal: err.fatal };
  }
  return { message: err?.message || String(err), code: 'unknown', status: 0, fatal: false };
}

/**
 * 长时间任务保活：MV3 的 Service Worker 空闲 30 秒会被回收，
 * 翻译/总结期间定时调用一次扩展 API，避免中途被杀导致消息无响应。
 */
function startKeepAlive() {
  const timer = setInterval(() => {
    chrome.runtime.getPlatformInfo().catch(() => {});
  }, 20000);
  return () => clearInterval(timer);
}

/** 源语言的 prompt 形式；auto 时返回空串，由模型自行判断 */
function sourceLabelOf(settings) {
  const code = settings.sourceLang || 'auto';
  return code === 'auto' ? '' : languagePrompt(code);
}

/** 写历史与统计。失败不能影响主流程，所以内部吞掉异常。 */
async function record(payload, settings) {
  try {
    return await recordEvent({
      ...payload,
      historyEnabled: settings.historyEnabled !== false,
      historyLimit: settings.historyLimit,
      storeText: settings.historyStoreText !== false,
    });
  } catch (err) {
    console.warn('[AI 翻译助手] 记录历史失败', err);
    return { recorded: false };
  }
}

/* ------------------------------------------------------------------ */
/* 消息路由                                                            */
/* ------------------------------------------------------------------ */

async function handleMessage(msg, sender) {
  const settings = await getSettings();

  switch (msg?.type) {
    case MSG.GET_PUBLIC_SETTINGS:
      return toPublicSettings(settings);

    case MSG.GET_SETTINGS:
      return settings;

    case MSG.SAVE_SETTINGS:
      return saveSettings(msg.patch || {});

    case MSG.SET_BADGE: {
      const tabId = sender?.tab?.id;
      if (tabId) setBadge(tabId, msg.text || '', msg.color);
      return true;
    }

    case MSG.ENSURE_CONTENT: {
      const tabId = msg.tabId ?? sender?.tab?.id;
      if (!tabId) throw new LLMError('没有指定要检查的标签页', { code: 'no_tab' });
      return ensureContentScript(tabId);
    }

    case MSG.TEST_CONNECTION: {
      // 允许用弹窗里「未保存」的值直接测试
      const merged = msg.settings ? { ...settings, ...msg.settings } : settings;
      return testConnection(merged);
    }

    case MSG.TRANSLATE_TEXTS: {
      // 注意：整页翻译在这里是按批次来的，所以**不在这里写历史**——
      // 内容脚本会累计各批用量，等整页结束后统一上报一次（见 RECORD_HISTORY）。
      const stop = startKeepAlive();
      try {
        const label = languagePrompt(msg.targetLang || settings.targetLang);
        return await translateTexts({
          settings,
          texts: msg.texts || [],
          targetLangLabel: label,
          sourceLangLabel: sourceLabelOf(settings),
        });
      } finally {
        stop();
      }
    }

    case MSG.TRANSLATE_ONE: {
      const label = languagePrompt(msg.targetLang || settings.targetLang);
      const stop = startKeepAlive();
      const startedAt = Date.now();
      try {
        const res = await translateOne({
          settings,
          text: msg.text,
          targetLangLabel: label,
          sourceLangLabel: sourceLabelOf(settings),
        });
        record(
          {
            type: msg.origin === 'menu' ? 'menu' : 'selection',
            model: res.model,
            sourceLang: settings.sourceLang,
            targetLang: settings.targetLang,
            items: 1,
            chars: (msg.text || '').length,
            prompt: res.usage?.prompt_tokens,
            completion: res.usage?.completion_tokens,
            durationMs: Date.now() - startedAt,
            url: sender?.tab?.url || '',
            title: sender?.tab?.title || '',
            src: msg.text,
            dst: res.translation,
          },
          settings
        );
        return res;
      } catch (err) {
        record(
          {
            type: 'selection',
            model: settings.model,
            sourceLang: settings.sourceLang,
            targetLang: settings.targetLang,
            items: 1,
            chars: (msg.text || '').length,
            durationMs: Date.now() - startedAt,
            status: 'failed',
            error: err?.message || String(err),
            src: msg.text,
          },
          settings
        );
        throw err;
      } finally {
        stop();
      }
    }

    case MSG.SUMMARIZE: {
      const label = languagePrompt(msg.targetLang || settings.targetLang);
      const stop = startKeepAlive();
      const startedAt = Date.now();
      try {
        const res = await summarizeContent({
          settings,
          title: msg.title,
          url: msg.url,
          text: msg.text,
          targetLangLabel: label,
          style: msg.style || settings.summaryStyle,
        });
        record(
          {
            type: 'summary',
            model: res.model,
            sourceLang: settings.sourceLang,
            targetLang: settings.targetLang,
            items: 1,
            chars: (msg.text || '').length,
            prompt: res.usage?.prompt_tokens,
            completion: res.usage?.completion_tokens,
            durationMs: Date.now() - startedAt,
            url: msg.url || '',
            title: msg.title || '',
            dst: res.summary,
          },
          settings
        );
        return res;
      } catch (err) {
        record(
          {
            type: 'summary',
            model: settings.model,
            sourceLang: settings.sourceLang,
            targetLang: settings.targetLang,
            chars: (msg.text || '').length,
            durationMs: Date.now() - startedAt,
            status: 'failed',
            error: err?.message || String(err),
            url: msg.url || '',
            title: msg.title || '',
          },
          settings
        );
        throw err;
      } finally {
        stop();
      }
    }

    // —— 历史记录与用量统计 ——

    case MSG.RECORD_HISTORY: {
      // 内容脚本在整页翻译结束后统一上报，msg 里带累计用量
      const r = await record(
        {
          type: 'page',
          model: msg.model || settings.model,
          sourceLang: settings.sourceLang,
          targetLang: settings.targetLang,
          items: msg.items,
          chars: msg.chars,
          prompt: msg.prompt,
          completion: msg.completion,
          durationMs: msg.durationMs,
          status: msg.status,
          error: msg.error,
          url: msg.url || sender?.tab?.url || '',
          title: msg.title || sender?.tab?.title || '',
          src: msg.src,
          dst: msg.dst,
        },
        settings
      );
      return r;
    }

    case MSG.GET_HISTORY: {
      const list = await getHistory();
      return { list, limit: settings.historyLimit, enabled: settings.historyEnabled !== false };
    }

    case MSG.DELETE_HISTORY:
      return deleteHistoryEntry(msg.id);

    case MSG.CLEAR_HISTORY:
      return clearHistory();

    case MSG.GET_STATS: {
      const stats = await getStats();
      return summarizeStats(stats, {
        days: msg.days || 14,
        prices: {
          pricePromptPerM: settings.pricePromptPerM,
          priceCompletionPerM: settings.priceCompletionPerM,
        },
      });
    }

    case MSG.CLEAR_STATS:
      return clearAll();

    // 页面翻译完成/还原时刷新角标
    case 'AITX_PAGE_STATE': {
      const tabId = sender?.tab?.id;
      if (tabId) {
        if (msg.translated) setBadge(tabId, '译', '#4f7cff');
        else setBadge(tabId, '', '#00000000');
      }
      return true;
    }

    default:
      throw new LLMError(`未知消息类型：${msg?.type}`, { code: 'unknown_message' });
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((err) => {
      console.warn('[AI 翻译助手] 处理失败', msg?.type, err);
      sendResponse({ ok: false, error: serializeError(err) });
    });
  return true; // 保持消息通道开启以支持异步响应
});
