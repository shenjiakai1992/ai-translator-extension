/**
 * OpenAI 兼容协议的极简客户端。
 * 只用全局 fetch，因此浏览器扩展（Service Worker）和 Node 都能直接跑。
 *
 * 关键能力：
 *  - 自动补全 /chat/completions 路径（用户填 https://api.deepseek.com 也能用）
 *  - 自动纠正常见误填（例如把 DeepSeek 的密钥管理页当成接口地址）
 *  - 关闭模型思考链（更快更省），接口不支持时自动降级重试
 *  - 429 / 5xx 自动退避重试，401 / 403 直接判定为致命错误不再重试
 *  - 全部错误归一化成中文可读提示
 */

export class LLMError extends Error {
  constructor(message, { status = 0, code = 'unknown', fatal = false, raw = '' } = {}) {
    super(message);
    this.name = 'LLMError';
    this.status = status;
    this.code = code;
    this.fatal = fatal;
    this.raw = raw;
  }
}

/** 已知的填错的地址 → 正确地址 */
const BASE_URL_FIXES = [
  {
    test: /^https?:\/\/platform\.deepseek\.com/i,
    fix: 'https://api.deepseek.com/v1',
    hint: 'platform.deepseek.com/api_keys 是密钥管理页面，不是接口地址，已自动改成 api.deepseek.com/v1',
  },
  {
    test: /^https?:\/\/api\.deepseek\.com\/api_keys/i,
    fix: 'https://api.deepseek.com/v1',
    hint: '检测到误填了密钥管理路径，已自动改成 api.deepseek.com/v1',
  },
  {
    test: /^https?:\/\/api\.openai\.com\/(?!v1)/i,
    fix: 'https://api.openai.com/v1',
    hint: 'OpenAI 官方接口地址已自动补全为 /v1',
  },
];

/** 给 UI 用的提示：返回 {ok, hint} */
export function inspectBaseUrl(baseUrl) {
  const raw = String(baseUrl || '').trim();
  if (!raw) return { ok: false, hint: '请填写接口地址，例如 https://api.deepseek.com/v1' };
  if (!/^https?:\/\//i.test(raw)) return { ok: false, hint: '地址需要以 http:// 或 https:// 开头' };
  if (/\/api_keys?\b/i.test(raw)) {
    return {
      ok: false,
      hint: '这看起来是密钥管理页面，不是对话接口地址。以 DeepSeek 为例应填 https://api.deepseek.com/v1',
    };
  }
  return { ok: true, hint: '' };
}

/**
 * 把用户填写的 Base URL 规范化成完整的 chat/completions 地址。
 * 支持四种填法：
 *   https://api.deepseek.com                     → .../v1/chat/completions
 *   https://api.deepseek.com/v1                  → .../v1/chat/completions
 *   https://api.deepseek.com/v1/chat/completions → 原样
 *   https://xxx/v1/chat/completions              → 原样
 */
export function normalizeChatUrl(baseUrl) {
  let url = String(baseUrl || '').trim().replace(/\s+/g, '');
  if (!url) throw new LLMError('尚未配置接口地址，请点击右上角设置填写 Base URL', { code: 'no_base_url', fatal: true });

  for (const rule of BASE_URL_FIXES) {
    if (rule.test.test(url)) {
      url = rule.fix;
      break;
    }
  }
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  url = url.replace(/\/+$/, '');

  if (/\/chat\/completions$/i.test(url)) return url;
  if (/\/v1$/i.test(url)) return `${url}/chat/completions`;
  if (/\/v\d+$/i.test(url)) return `${url}/chat/completions`;
  return `${url}/v1/chat/completions`;
}

/** 让模型「别思考」的参数。部分第三方兼容接口不认，会返回 400，届时自动降级。 */
const NO_THINKING_PARAM = { thinking: { type: 'disabled' } };

/** 记录当前 Base URL + 模型是否不支持关闭思考，避免每次都白试一遍 */
const thinkingSupportCache = new Map();

export function resetCapabilityCache() {
  thinkingSupportCache.clear();
}

function mapHttpError(status, bodyText) {
  let detail = '';
  try {
    const j = JSON.parse(bodyText);
    detail = j?.error?.message || j?.message || j?.error || '';
  } catch {
    detail = String(bodyText || '').slice(0, 200);
  }
  const suffix = detail ? `（${String(detail).slice(0, 200)}）` : '';
  const map = {
    400: { code: 'bad_request', msg: `请求被拒绝，可能是模型名或参数不对${suffix}` },
    401: { code: 'unauthorized', msg: `API Key 无效或已失效，请在设置中重新填写${suffix}`, fatal: true },
    403: { code: 'forbidden', msg: `没有权限访问该模型，请检查 Key 的权限或模型名${suffix}`, fatal: true },
    404: { code: 'not_found', msg: `接口地址或模型不存在，请检查 Base URL 与模型名${suffix}`, fatal: true },
    422: { code: 'unprocessable', msg: `参数不被接口接受${suffix}` },
    429: { code: 'rate_limit', msg: `请求太频繁或额度不足，请稍后重试${suffix}` },
    500: { code: 'server_error', msg: `模型服务端错误，请稍后重试${suffix}` },
    502: { code: 'bad_gateway', msg: `模型服务网关错误，请稍后重试${suffix}` },
    503: { code: 'unavailable', msg: `模型服务暂时不可用，请稍后重试${suffix}` },
    504: { code: 'timeout', msg: `模型服务响应超时，请稍后重试${suffix}` },
  };
  const hit = map[status] || { code: 'http_error', msg: `请求失败（HTTP ${status}）${suffix}` };
  return new LLMError(hit.msg, { status, code: hit.code, fatal: !!hit.fatal, raw: bodyText });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 发起一次对话补全请求。
 * @param {object} opts
 * @param {object} opts.settings   完整配置（含 baseUrl / apiKey / model / timeoutMs）
 * @param {Array}  opts.messages   OpenAI 格式消息数组
 * @param {number} [opts.maxTokens]
 * @param {number} [opts.temperature]
 * @param {AbortSignal} [opts.signal]
 * @param {number} [opts.retries]  网络类错误的重试次数
 * @returns {Promise<{text: string, usage: object, model: string}>}
 */
export async function chat({
  settings,
  messages,
  maxTokens = 4096,
  temperature,
  signal,
  retries = 2,
}) {
  const url = normalizeChatUrl(settings.baseUrl);
  const apiKey = String(settings.apiKey || '').trim();
  if (!apiKey) {
    throw new LLMError('尚未配置 API Key，请点击扩展图标在设置里填写', { code: 'no_api_key', fatal: true });
  }
  const model = String(settings.model || '').trim();
  if (!model) {
    throw new LLMError('尚未配置模型名称，例如 deepseek-flash', { code: 'no_model', fatal: true });
  }

  const cacheKey = `${url}::${model}`;
  const wantNoThinking = settings.disableThinking !== false && !thinkingSupportCache.has(cacheKey);
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const body = {
      model,
      messages,
      temperature: temperature ?? settings.temperature ?? 0.2,
      max_tokens: maxTokens,
      stream: false,
    };
    if (wantNoThinking && !thinkingSupportCache.has(cacheKey)) Object.assign(body, NO_THINKING_PARAM);

    const controller = new AbortController();
    const timeoutMs = settings.timeoutMs || 60000;
    const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
    const onOuterAbort = () => controller.abort(new Error('aborted'));
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        throw new LLMError('已取消', { code: 'aborted', fatal: true });
      }
      signal.addEventListener('abort', onOuterAbort, { once: true });
    }

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        // 关闭思考的参数不被支持 → 记下来，去掉参数重试一次
        if (res.status === 400 && body.thinking && /think/i.test(text)) {
          thinkingSupportCache.set(cacheKey, false);
          lastError = new LLMError('该接口不支持关闭思考模式，已自动降级重试', { code: 'no_thinking_unsupported' });
          continue;
        }
        if (res.status === 400 && body.thinking) {
          thinkingSupportCache.set(cacheKey, false);
          lastError = new LLMError('接口不接受思考模式参数，已自动降级重试', { code: 'no_thinking_unsupported' });
          continue;
        }
        const err = mapHttpError(res.status, text);
        // 只有可重试的错误才继续循环
        if (!err.fatal && (res.status === 429 || res.status >= 500) && attempt < retries) {
          lastError = err;
          await sleep(600 * Math.pow(2, attempt) + Math.random() * 300);
          continue;
        }
        throw err;
      }

      const data = await res.json();
      const choice = data?.choices?.[0];
      const content = choice?.message?.content ?? '';
      const reasoning = choice?.message?.reasoning_content ?? '';

      if (!content || !String(content).trim()) {
        if (choice?.finish_reason === 'length') {
          throw new LLMError('模型输出被 token 上限截断，已无有效内容，请重试或调小批次', {
            code: 'truncated',
          });
        }
        if (reasoning) {
          throw new LLMError('模型只返回了思考过程、没有返回结果，请重试', { code: 'empty_content' });
        }
        throw new LLMError('模型返回了空内容，请重试', { code: 'empty_content' });
      }

      return {
        text: String(content),
        usage: data?.usage || {},
        model: data?.model || model,
      };
    } catch (err) {
      if (err instanceof LLMError) {
        if (err.code === 'aborted') throw err;
        if (err.code === 'no_thinking_unsupported') continue;
        lastError = err;
        if (err.fatal) throw err;
        if (attempt < retries && ['rate_limit', 'server_error', 'bad_gateway', 'unavailable', 'timeout'].includes(err.code)) {
          await sleep(600 * Math.pow(2, attempt) + Math.random() * 300);
          continue;
        }
        throw err;
      }
      // 网络层错误 / 超时
      const isTimeout = controller.signal.aborted && !(signal && signal.aborted);
      if (signal && signal.aborted) throw new LLMError('已取消', { code: 'aborted', fatal: true });
      lastError = new LLMError(
        isTimeout
          ? `请求超时（${Math.round(timeoutMs / 1000)} 秒），可能是网络不通或接口地址有误`
          : `网络请求失败：${err?.message || err}。请检查网络、Base URL 是否正确，或该接口是否允许浏览器直连`,
        { code: isTimeout ? 'timeout' : 'network' }
      );
      if (attempt < retries) {
        await sleep(600 * Math.pow(2, attempt));
        continue;
      }
      throw lastError;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onOuterAbort);
    }
  }

  throw lastError || new LLMError('请求失败', { code: 'unknown' });
}

/** 连通性测试：发一条极短请求，验证地址 / Key / 模型三件事 */
export async function testConnection(settings, { messages } = {}) {
  const started = Date.now();
  const res = await chat({
    settings,
    messages: messages || [
      { role: 'system', content: '你是翻译引擎，只输出 JSON 数组。' },
      { role: 'user', content: '把下面 JSON 数组翻译成简体中文，只输出 JSON 数组：["Hello","OK"]' },
    ],
    maxTokens: 1024,
    temperature: 0,
    retries: 0,
  });
  return {
    ok: true,
    elapsedMs: Date.now() - started,
    model: res.model,
    text: res.text.trim().slice(0, 120),
    usage: res.usage,
  };
}
