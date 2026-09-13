/**
 * 配置项的默认值与读写封装。
 * 背景页(Service Worker)与弹窗(Popup)共用；内容脚本不直接读，统一走消息由背景页下发。
 */

export const STORAGE_KEY = 'aitx_settings';

/** 支持的目标语言：code 用于展示与状态判断，prompt 用于喂给模型的自然语言描述 */
export const LANGUAGES = [
  { code: 'zh-CN', label: '中文（简体）', prompt: '简体中文', zh: true },
  { code: 'zh-TW', label: '中文（繁體）', prompt: '繁体中文', zh: true },
  { code: 'en', label: 'English 英语', prompt: '英语' },
  { code: 'ja', label: '日本語 日语', prompt: '日语' },
  { code: 'ko', label: '한국어 韩语', prompt: '韩语' },
  { code: 'fr', label: 'Français 法语', prompt: '法语' },
  { code: 'de', label: 'Deutsch 德语', prompt: '德语' },
  { code: 'es', label: 'Español 西班牙语', prompt: '西班牙语' },
  { code: 'ru', label: 'Русский 俄语', prompt: '俄语' },
  { code: 'pt', label: 'Português 葡萄牙语', prompt: '葡萄牙语' },
];

export function languagePrompt(code) {
  const hit = LANGUAGES.find((l) => l.code === code);
  return hit ? hit.prompt : '简体中文';
}

export function languageLabel(code) {
  if (code === 'auto') return '自动检测';
  const hit = LANGUAGES.find((l) => l.code === code);
  return hit ? hit.label : code;
}

/** 源语言多一个「自动检测」选项；目标语言不需要，因为必须指定一个明确的目标 */
export const SOURCE_LANGUAGES = [{ code: 'auto', label: '自动检测', prompt: '' }, ...LANGUAGES];

export const DEFAULT_SETTINGS = {
  // —— 模型接入（OpenAI 兼容协议）——
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: '',
  model: 'deepseek-flash',

  // —— 翻译偏好 ——
  sourceLang: 'auto', // auto = 自动检测；其余同 LANGUAGES 的 code
  targetLang: 'zh-CN',
  displayMode: 'replace', // replace = 仅显示译文；bilingual = 译文 + 原文对照
  disableThinking: true, // 关闭模型思考链，翻译更快更省 token（不支持的接口会自动降级）
  selectionTranslate: true, // 划词翻译开关
  autoTranslate: false, // 打开网页自动整页翻译

  // —— 性能参数 ——
  batchSize: 20, // 单次请求翻译的文本条数
  concurrency: 3, // 同时进行的请求数
  temperature: 0.2,
  timeoutMs: 60000,

  // —— 总结偏好 ——
  summaryStyle: 'bullets', // bullets = 要点式；outline = 大纲式
  summaryMaxChars: 12000,

  // —— 历史记录与用量统计 ——
  historyEnabled: true, // 是否记录翻译历史（关闭后不再新增，已有记录保留）
  historyLimit: 300, // 最多保留多少条历史
  historyStoreText: true, // 是否在历史里保存原文/译文正文（关闭则只留元信息）
  pricePromptPerM: 0, // 输入单价，元 / 百万 token；0 = 不计费
  priceCompletionPerM: 0, // 输出单价，元 / 百万 token；0 = 不计费
};

/** 内容脚本能看到的字段（不含 API Key，避免密钥出现在页面上下文） */
export function toPublicSettings(s) {
  return {
    sourceLang: s.sourceLang,
    targetLang: s.targetLang,
    displayMode: s.displayMode,
    selectionTranslate: s.selectionTranslate,
    autoTranslate: s.autoTranslate,
    model: s.model,
  };
}

export async function getSettings() {
  const raw = await chrome.storage.local.get(STORAGE_KEY);
  const stored = raw?.[STORAGE_KEY] || {};
  return { ...DEFAULT_SETTINGS, ...stored };
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ [STORAGE_KEY]: next });
  return next;
}
