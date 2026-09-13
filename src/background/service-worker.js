/**
 * 后台 Service Worker：扩展的“大脑”。
 *  - 所有模型请求都在这里发出（API Key 只存在于后台与弹窗，绝不进入网页上下文）
 *  - 处理右键菜单、快捷键、弹窗与页面之间的消息路由
 */

import { MSG, PAGE_CMD } from '../lib/protocol.js';
import { getSettings, saveSettings, toPublicSettings, languagePrompt, languageLabel } from '../lib/settings.js';
import { testConnection, LLMError } from '../lib/llm.js';
import { translateTexts, translateOne, summarizeContent } from '../lib/translator.js';

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
      await sendToTab(tab.id, { type: PAGE_CMD.TOGGLE_PAGE });
      return;
    }
    if (info.menuItemId !== CONTEXT_MENU_ID) return;
    const text = (info.selectionText || '').trim();
    if (!text) return;

    const settings = await getSettings();
    const label = languagePrompt(settings.targetLang);
    setBadge(tab.id, '…', '#4f7cff');
    try {
      const { translation, model } = await translateOne({ settings, text, targetLangLabel: label });
      await sendToTab(tab.id, {
        type: MSG.SHOW_TRANSLATION,
        original: text,
        translation,
        model,
      });
      setBadge(tab.id, '', '#00000000');
    } catch (err) {
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
  if (tab?.id) await sendToTab(tab.id, { type: PAGE_CMD.TOGGLE_PAGE }).catch(() => {});
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

    case MSG.TEST_CONNECTION: {
      // 允许用弹窗里「未保存」的值直接测试
      const merged = msg.settings ? { ...settings, ...msg.settings } : settings;
      return testConnection(merged);
    }

    case MSG.TRANSLATE_TEXTS: {
      const stop = startKeepAlive();
      try {
        const label = languagePrompt(msg.targetLang || settings.targetLang);
        return await translateTexts({
          settings,
          texts: msg.texts || [],
          targetLangLabel: label,
        });
      } finally {
        stop();
      }
    }

    case MSG.TRANSLATE_ONE: {
      const label = languagePrompt(msg.targetLang || settings.targetLang);
      const stop = startKeepAlive();
      try {
        return await translateOne({ settings, text: msg.text, targetLangLabel: label });
      } finally {
        stop();
      }
    }

    case MSG.SUMMARIZE: {
      const label = languagePrompt(msg.targetLang || settings.targetLang);
      const stop = startKeepAlive();
      try {
        return await summarizeContent({
          settings,
          title: msg.title,
          url: msg.url,
          text: msg.text,
          targetLangLabel: label,
          style: msg.style || settings.summaryStyle,
        });
      } finally {
        stop();
      }
    }

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
