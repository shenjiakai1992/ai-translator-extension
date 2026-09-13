/**
 * 翻译 / 总结的业务编排层。
 * 负责：批量拆分、并发控制、失败拆批重试、进度回调。
 * 只依赖 llm.js / prompts.js / text-utils.js，可在 Node 中直接测试。
 */

import { chat, LLMError } from './llm.js';
import {
  buildBatchTranslateMessages,
  buildSingleTranslateMessages,
  buildSummaryMessages,
} from './prompts.js';
import { chunkArray, parseJsonArray } from './text-utils.js';

/** 并发受限的任务池 */
export async function mapPool(items, limit, worker) {
  const size = Math.max(1, Math.min(limit || 1, items.length || 1));
  const results = new Array(items.length);
  let cursor = 0;
  const runners = new Array(size).fill(0).map(async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * 请求一批文本的翻译。返回值长度必须与入参一致，否则抛错交由上层拆批。
 */
async function requestBatch({ texts, targetLangLabel, sourceLangLabel, settings, signal }) {
  const messages = buildBatchTranslateMessages({ texts, targetLangLabel, sourceLangLabel });
  // 单批最多 40 条，按每条平均 40 token 输出估算，预留充足额度给模型可能的思考过程
  const maxTokens = Math.min(8192, Math.max(2048, 512 + texts.length * 160));
  const res = await chat({ settings, messages, maxTokens, signal });
  const arr = parseJsonArray(res.text, texts.length);
  if (!arr) {
    throw new LLMError(`模型未按 JSON 数组格式返回，准备拆小重试`, { code: 'bad_format' });
  }
  if (arr.length !== texts.length) {
    throw new LLMError(`模型返回条数不匹配（期望 ${texts.length}，实际 ${arr.length}），准备拆小重试`, {
      code: 'length_mismatch',
    });
  }
  return { translations: arr, usage: res.usage, model: res.model };
}

/**
 * 带自愈能力的批量翻译：一批失败就二分拆小重试，直到单条。
 * 单条仍失败时保留原文，并把错误收集起来（不阻塞整页）。
 */
async function translateChunkWithFallback({ texts, targetLangLabel, sourceLangLabel, settings, signal, errors }) {
  try {
    const { translations, usage, model } = await requestBatch({ texts, targetLangLabel, sourceLangLabel, settings, signal });
    return { translations, usage, model };
  } catch (err) {
    if (err instanceof LLMError && (err.fatal || err.code === 'aborted')) throw err;
    if (err?.code === 'no_api_key' || err?.code === 'no_base_url' || err?.code === 'no_model') throw err;

    if (texts.length === 1) {
      errors.push({ text: texts[0].slice(0, 40), message: err?.message || String(err) });
      return { translations: [texts[0]], usage: null, model: '', failed: 1 };
    }
    const mid = Math.ceil(texts.length / 2);
    const left = await translateChunkWithFallback({
      texts: texts.slice(0, mid),
      targetLangLabel,
      sourceLangLabel,
      settings,
      signal,
      errors,
    });
    const right = await translateChunkWithFallback({
      texts: texts.slice(mid),
      targetLangLabel,
      sourceLangLabel,
      settings,
      signal,
      errors,
    });
    return {
      translations: [...left.translations, ...right.translations],
      usage: null,
      model: left.model || right.model || '',
      failed: (left.failed || 0) + (right.failed || 0),
    };
  }
}

/**
 * 批量翻译主入口。
 * @returns {Promise<{translations: string[], errors: Array, stats: object}>}
 */
export async function translateTexts({
  settings,
  texts,
  targetLangLabel,
  sourceLangLabel,
  onProgress,
  signal,
}) {
  if (!Array.isArray(texts) || texts.length === 0) {
    return { translations: [], errors: [], stats: { total: 0, failed: 0 } };
  }
  const size = Math.max(1, Math.min(settings.batchSize || 20, 40));
  const chunks = chunkArray(texts, size);
  const errors = [];
  let done = 0;
  let modelUsed = '';
  let usageTotal = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

  const results = await mapPool(chunks, settings.concurrency || 3, async (chunk) => {
    const r = await translateChunkWithFallback({
      texts: chunk,
      targetLangLabel,
      sourceLangLabel,
      settings,
      signal,
      errors,
    });
    done += chunk.length;
    if (r.model && !modelUsed) modelUsed = r.model;
    if (r.usage) {
      usageTotal.prompt_tokens += r.usage.prompt_tokens || 0;
      usageTotal.completion_tokens += r.usage.completion_tokens || 0;
      usageTotal.total_tokens += r.usage.total_tokens || 0;
    }
    if (typeof onProgress === 'function') {
      onProgress({ done, total: texts.length, failed: errors.length });
    }
    return r.translations;
  });

  return {
    translations: results.flat(),
    errors,
    stats: { total: texts.length, failed: errors.length, usage: usageTotal, model: modelUsed },
  };
}

/** 单条翻译（划词 / 右键菜单） */
export async function translateOne({ settings, text, targetLangLabel, sourceLangLabel, signal }) {
  const messages = buildSingleTranslateMessages({ text, targetLangLabel, sourceLangLabel });
  const res = await chat({ settings, messages, maxTokens: 2048, signal });
  return { translation: res.text.trim().replace(/^["「『]+|["」』]+$/g, ''), usage: res.usage, model: res.model };
}

/** 网页总结 */
export async function summarizeContent({ settings, title, url, text, targetLangLabel, style, signal }) {
  const messages = buildSummaryMessages({ title, url, text, targetLangLabel, style });
  const res = await chat({ settings, messages, maxTokens: 4096, signal });
  return { summary: res.text.trim(), usage: res.usage, model: res.model };
}
