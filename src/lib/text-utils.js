/**
 * 纯函数工具集：文本分块、模型输出解析、语言判断、迷你 Markdown 渲染。
 * 不依赖任何浏览器 API，因此可以在 Node 里直接跑单元测试。
 */

/** 把数组按固定长度切成若干块 */
export function chunkArray(arr, size) {
  const n = Math.max(1, Math.floor(size) || 1);
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/** 拆出文本首尾空白，便于替换时保留原有排版 */
export function splitWhitespace(text) {
  const m = String(text).match(/^(\s*)([\s\S]*?)(\s*)$/) || [];
  return { prefix: m[1] || '', core: m[2] || '', suffix: m[3] || '' };
}

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const CJK_GLOBAL_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g;
const LATIN_RE = /[A-Za-z\u00c0-\u024f\u0400-\u04ff\u0370-\u03ff]/;
const LETTER_RE = /[\p{L}]/u;

export function hasCJK(text) {
  return CJK_RE.test(String(text));
}

export function countCJK(text) {
  const m = String(text).match(CJK_GLOBAL_RE);
  return m ? m.length : 0;
}

export function hasLatinLetters(text) {
  return LATIN_RE.test(String(text));
}

/**
 * 判断一段文本是否值得送去翻译。
 * 过滤掉纯数字、纯符号、纯空白、纯 URL、以及超长文本块。
 */
export function shouldTranslate(text, { maxLength = 4000 } = {}) {
  if (typeof text !== 'string') return false;
  const t = text.trim();
  if (!t) return false;
  if (t.length > maxLength) return false;
  if (!LETTER_RE.test(t)) return false; // 必须含字母（含中日韩表意文字）
  if (/^https?:\/\/\S+$/i.test(t)) return false; // 纯网址
  if (/^[\d\s.,:%+\-/()]+$/.test(t)) return false; // 纯数字与符号
  // 单个字母或单个汉字没有翻译价值
  if (t.length < 2 && !CJK_RE.test(t)) return false;
  return true;
}

/**
 * 目标语言是中文时，纯中文文本不需要翻译（避免把页面里本就中文的菜单再翻一遍）。
 * 只在“无拉丁字母 且 中文占比很高”时才跳过。
 */
export function isProbablyTargetLang(text, targetLang) {
  const t = String(text);
  const isZhTarget = targetLang === 'zh-CN' || targetLang === 'zh-TW';
  if (!isZhTarget) {
    if (hasLatinLetters(t) && !hasCJK(t)) {
      // 目标非中文时，纯拉丁文本也可能是要翻译的内容，不能一刀切跳过
      return false;
    }
    return false;
  }
  if (hasLatinLetters(t)) return false;
  const cjk = countCJK(t);
  if (cjk < 2) return false;
  const meaningful = t.replace(/[\s\p{P}\p{S}]/gu, '').length || 1;
  return cjk / meaningful > 0.8;
}

/** 截断长文本，尽量在句子边界处断开 */
export function truncateText(text, max = 12000) {
  const t = String(text || '');
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const lastStop = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('.'), cut.lastIndexOf('\n'), cut.lastIndexOf('！'), cut.lastIndexOf('!'));
  return lastStop > max * 0.6 ? cut.slice(0, lastStop + 1) : cut;
}

/**
 * 稳健解析模型返回的「字符串数组」。
 * 依次尝试：直接 JSON（含对象包裹）→ 提取 [] → 提取 {} → 单条宽松兜底 → 编号列表兜底。
 * 解析失败返回 null，由调用方决定是否拆批重试。
 *
 * @param {string} raw 模型原始输出
 * @param {number|null} expectedLength 期望条数。给定时会更严格：只翻译一条时接受纯译文文本，
 *        多条时编号列表兜底必须条数吻合，避免把模型的解释文字当成译文。
 */
export function parseJsonArray(raw, expectedLength = null) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  // 去掉 ```json ... ``` 代码围栏
  s = s.replace(/^```[a-zA-Z0-9_-]*\s*/, '').replace(/\s*```$/, '').trim();

  const tryParse = (t) => {
    try {
      return JSON.parse(t);
    } catch {
      return undefined;
    }
  };

  /** 是数组就直接用；是对象则找它内部的第一个数组 */
  const unwrapArray = (v) => {
    if (Array.isArray(v)) return v;
    if (v && typeof v === 'object') {
      const arr = Object.values(v).find((x) => Array.isArray(x));
      if (arr) return arr;
    }
    return undefined;
  };

  let value = unwrapArray(tryParse(s));

  if (value === undefined) {
    const a = s.indexOf('[');
    const b = s.lastIndexOf(']');
    if (a >= 0 && b > a) value = unwrapArray(tryParse(s.slice(a, b + 1)));
  }

  if (value === undefined) {
    const a = s.indexOf('{');
    const b = s.lastIndexOf('}');
    if (a >= 0 && b > a) value = unwrapArray(tryParse(s.slice(a, b + 1)));
  }

  // 只请求一条翻译时，模型直接给出纯译文也接受（比报错更有用）
  if (value === undefined && expectedLength === 1) {
    const text = s.replace(/^["“「『]+|["”」』]+$/g, '').trim();
    if (text) value = [text];
  }

  // 兜底：模型把结果输出成了编号列表（必须条数吻合才算数）
  if (value === undefined && !/[{}[\]]/.test(s)) {
    const lines = s
      .split('\n')
      .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.、)）])?\s*/, '').trim())
      .filter((l) => l.length > 0);
    if (lines.length > 1 && (expectedLength == null || lines.length === expectedLength)) value = lines;
  }

  if (!Array.isArray(value)) return null;
  return value.map((v) => {
    if (typeof v === 'string') return v;
    if (v == null) return '';
    if (typeof v === 'object') {
      const inner = v.text ?? v.translation ?? v.result ?? v.value;
      if (typeof inner === 'string') return inner;
      return JSON.stringify(v);
    }
    return String(v);
  });
}

export function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 把模型返回的轻量 Markdown 渲染成安全 HTML。
 * 支持：标题、无序/有序列表、加粗、行内代码、段落。先转义再按行渲染，杜绝 XSS。
 */
export function renderSimpleMarkdown(md) {
  const lines = String(md || '').split(/\r?\n/);
  const out = [];
  let listType = null;

  const inline = (s) =>
    escapeHtml(s)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');

  const closeList = () => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line.trim()) {
      closeList();
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      closeList();
      const level = Math.min(6, heading[1].length + 2);
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }
    const ul = line.match(/^\s*[-*•]\s+(.*)$/);
    if (ul) {
      if (listType !== 'ul') {
        closeList();
        out.push('<ul>');
        listType = 'ul';
      }
      out.push(`<li>${inline(ul[1])}</li>`);
      continue;
    }
    const ol = line.match(/^\s*\d+[.、)）]\s+(.*)$/);
    if (ol) {
      if (listType !== 'ol') {
        closeList();
        out.push('<ol>');
        listType = 'ol';
      }
      out.push(`<li>${inline(ol[1])}</li>`);
      continue;
    }
    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  return out.join('');
}

/** 把错误对象转成给用户看的中文提示 */
export function friendlyError(err) {
  const msg = err && err.message ? String(err.message) : String(err || '未知错误');
  return msg;
}

// —— 仅用于测试辅助 ——
export function reverseArray(a) {
  return a.slice().reverse();
}
