/**
 * 翻译历史与 token 用量统计。
 *
 * 设计取舍：
 *  1. 历史与统计分开存。历史会按上限裁剪，统计不会——否则删记录会把用量数字也删掉。
 *  2. 统计按「天 / 模型 / 操作类型」三个维度预聚合，面板直接读，不用每次遍历全部历史。
 *  3. 写入走串行队列。内容脚本和后台可能同时写，读-改-写会互相覆盖。
 *  4. 纯函数（聚合、裁剪、拼装）与本文件的 chrome.storage 封装分开，前者可被 Node 直接测试。
 */

export const HISTORY_KEY = 'aitx_history';
export const STATS_KEY = 'aitx_stats';

export const HISTORY_HARD_LIMIT = 1000; // 用户可设上限，但不能超过这个值
export const DAY_RETENTION = 180; // 按天统计最多保留多少天
export const PREVIEW_LIMIT = 500; // 单条历史里正文预览最多存多少字

/** 操作类型 → 面板里展示的名字 */
export const TYPE_LABELS = {
  page: '整页翻译',
  selection: '划词翻译',
  menu: '右键翻译',
  summary: '网页总结',
};

/* ================================================================== */
/* 纯函数（可单元测试）                                                */
/* ================================================================== */

/** 生成当天日期串（本地时区），格式 YYYY-MM-DD */
export function dayKey(ts = Date.now()) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 截断正文，避免一条记录把存储撑爆 */
export function truncatePreview(text, limit = PREVIEW_LIMIT) {
  const s = String(text ?? '');
  if (s.length <= limit) return s;
  return s.slice(0, limit) + `…（已截断，共 ${s.length} 字）`;
}

export function emptyStats() {
  return {
    total: { requests: 0, prompt: 0, completion: 0, tokens: 0, chars: 0, items: 0 },
    byDay: {},
    byModel: {},
    byType: {},
    firstAt: null,
    updatedAt: null,
  };
}

function zeroBucket() {
  return { requests: 0, prompt: 0, completion: 0, tokens: 0, chars: 0, items: 0 };
}

function addInto(bucket, delta) {
  bucket.requests += 1;
  bucket.prompt += delta.prompt;
  bucket.completion += delta.completion;
  bucket.tokens += delta.tokens;
  bucket.chars += delta.chars;
  bucket.items += delta.items;
}

/** 把一次用量累加进统计（返回新对象，不修改入参） */
export function addUsage(stats, entry) {
  const base = stats && stats.total ? structuredCloneSafe(stats) : emptyStats();
  const delta = {
    prompt: num(entry.prompt),
    completion: num(entry.completion),
    tokens: num(entry.tokens ?? num(entry.prompt) + num(entry.completion)),
    chars: num(entry.chars),
    items: num(entry.items),
  };
  const day = entry.day || dayKey(entry.ts);
  const model = entry.model || '未知模型';
  const type = entry.type || 'page';

  addInto(base.total, delta);
  base.byDay[day] = base.byDay[day] || zeroBucket();
  addInto(base.byDay[day], delta);
  base.byModel[model] = base.byModel[model] || zeroBucket();
  addInto(base.byModel[model], delta);
  base.byType[type] = base.byType[type] || zeroBucket();
  addInto(base.byType[type], delta);

  base.firstAt = base.firstAt || entry.ts;
  base.updatedAt = entry.ts;
  return base;
}

function structuredCloneSafe(v) {
  return JSON.parse(JSON.stringify(v));
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 丢掉过期的按天统计，避免无限增长 */
export function pruneStats(stats, { keepDays = DAY_RETENTION, now = Date.now() } = {}) {
  const cutoff = dayKey(now - keepDays * 86400000);
  const byDay = {};
  for (const [day, bucket] of Object.entries(stats.byDay || {})) {
    if (day >= cutoff) byDay[day] = bucket;
  }
  return { ...stats, byDay };
}

/** 组装一条历史记录（不做存储） */
export function makeHistoryEntry(payload) {
  const ts = payload.ts || Date.now();
  const prompt = num(payload.prompt);
  const completion = num(payload.completion);
  return {
    id: `${ts}-${Math.random().toString(36).slice(2, 8)}`,
    ts,
    day: dayKey(ts),
    type: payload.type || 'page',
    model: payload.model || '',
    sourceLang: payload.sourceLang || 'auto',
    targetLang: payload.targetLang || '',
    items: num(payload.items),
    chars: num(payload.chars),
    prompt,
    completion,
    tokens: num(payload.tokens ?? prompt + completion),
    durationMs: num(payload.durationMs),
    status: payload.status || 'ok',
    error: payload.error ? String(payload.error).slice(0, 300) : '',
    title: payload.title ? String(payload.title).slice(0, 120) : '',
    url: payload.url ? String(payload.url).slice(0, 300) : '',
    src: payload.storeText === false ? '' : truncatePreview(payload.src),
    dst: payload.storeText === false ? '' : truncatePreview(payload.dst),
  };
}

/** 新记录插到最前面，并按上限裁剪（返回新数组） */
export function pushHistory(list, entry, limit = 300) {
  const max = Math.min(Math.max(1, num(limit) || 300), HISTORY_HARD_LIMIT);
  return [entry, ...(Array.isArray(list) ? list : [])].slice(0, max);
}

/** 汇总出面板要用的数据：总量、今天、近 N 天曲线、模型/类型分布、费用估算 */
export function summarizeStats(stats, { days = 14, now = Date.now(), prices = {} } = {}) {
  const base = stats && stats.total ? stats : emptyStats();
  const series = [];
  for (let i = days - 1; i >= 0; i--) {
    const ts = now - i * 86400000;
    const key = dayKey(ts);
    const bucket = base.byDay[key] || zeroBucket();
    series.push({ day: key, label: key.slice(5), ...bucket });
  }
  const today = base.byDay[dayKey(now)] || zeroBucket();
  const week = { ...zeroBucket() };
  for (const point of series.slice(-7)) {
    week.requests += point.requests;
    week.prompt += point.prompt;
    week.completion += point.completion;
    week.tokens += point.tokens;
    week.chars += point.chars;
    week.items += point.items;
  }

  const byModel = Object.entries(base.byModel || {})
    .map(([model, b]) => ({ model, ...b }))
    .sort((a, b) => b.tokens - a.tokens);
  const byType = Object.entries(base.byType || {})
    .map(([type, b]) => ({ type, label: TYPE_LABELS[type] || type, ...b }))
    .sort((a, b) => b.tokens - a.tokens);

  const priceIn = num(prices.pricePromptPerM);
  const priceOut = num(prices.priceCompletionPerM);
  const cost =
    priceIn || priceOut
      ? (base.total.prompt / 1e6) * priceIn + (base.total.completion / 1e6) * priceOut
      : null;

  return {
    total: base.total,
    today,
    week,
    series,
    byModel,
    byType,
    cost,
    priced: Boolean(priceIn || priceOut),
    firstAt: base.firstAt,
    updatedAt: base.updatedAt,
  };
}

/* ================================================================== */
/* 存储层（带串行队列，避免并发读-改-写互相覆盖）                        */
/* ================================================================== */

let queue = Promise.resolve();

function serialize(task) {
  const next = queue.then(task, task);
  queue = next.catch(() => {});
  return next;
}

async function readKey(key, fallback) {
  try {
    const raw = await chrome.storage.local.get(key);
    return raw?.[key] ?? fallback;
  } catch {
    return fallback;
  }
}

export function getHistory() {
  return readKey(HISTORY_KEY, []);
}

export function getStats() {
  return readKey(STATS_KEY, emptyStats());
}

/**
 * 记录一次操作：同时写历史与统计。
 * @param {object} payload 见 makeHistoryEntry；另需 historyEnabled / historyLimit / storeText
 */
export async function recordEvent(payload) {
  if (payload?.historyEnabled === false) {
    // 关闭记录时连统计也不记，避免「关了还在统计」的困惑
    return { recorded: false, reason: 'disabled' };
  }
  return serialize(async () => {
    const entry = makeHistoryEntry(payload);
    const [list, stats] = await Promise.all([getHistory(), getStats()]);
    const nextList = pushHistory(list, entry, payload.historyLimit);
    const nextStats = pruneStats(addUsage(stats, entry), { now: entry.ts });
    await chrome.storage.local.set({ [HISTORY_KEY]: nextList, [STATS_KEY]: nextStats });
    return { recorded: true, entry };
  });
}

export function deleteHistoryEntry(id) {
  return serialize(async () => {
    const list = await getHistory();
    const next = list.filter((e) => e.id !== id);
    await chrome.storage.local.set({ [HISTORY_KEY]: next });
    return { removed: list.length - next.length };
  });
}

/** 只清历史，保留累计统计（统计是「花了多少 token」，不该被清历史带走） */
export function clearHistory() {
  return serialize(async () => {
    const list = await getHistory();
    await chrome.storage.local.set({ [HISTORY_KEY]: [] });
    return { removed: list.length };
  });
}

/** 清空统计，同时清历史（否则历史还在、统计归零会很怪） */
export function clearAll() {
  return serialize(async () => {
    const list = await getHistory();
    await chrome.storage.local.set({ [HISTORY_KEY]: [], [STATS_KEY]: emptyStats() });
    return { removed: list.length };
  });
}
