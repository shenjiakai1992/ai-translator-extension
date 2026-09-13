/**
 * 提示词集中管理。所有发给模型的话术都放这里，方便单独调优。
 * 设计原则：
 *  1) 强约束输出格式（纯 JSON 数组），方便程序解析；
 *  2) 明确「不要翻译什么」（变量、代码、网址、数字），避免把页面里的占位符翻坏；
 *  3) 单条翻译与批量翻译用同一套规则，保证划词与整页结果一致。
 */

const COMMON_RULES = `翻译规则：
1. 忠实原意，语气自然，符合目标语言的表达习惯，不要逐字硬译。
2. 代码、变量名、函数名、命令行、文件路径、URL、邮箱一律保持原样，不要翻译。
3. 形如 %s、{0}、{{name}}、$VAR、<tag> 的占位符与标签原样保留。
4. 数字、单位、日期、型号保持不变。
5. 不要添加任何解释、注释、音译或括号补充（除非原文本身就有）。
6. 如果该条内容已经是目标语言，或只是符号、数字、专有名词，则原样返回。`;

/**
 * 批量翻译：一次翻多条，返回严格 JSON 数组。
 * @param {{texts: string[], targetLangLabel: string, sourceLangLabel?: string}} opts
 */
export function buildBatchTranslateMessages({ texts, targetLangLabel, sourceLangLabel }) {
  const n = texts.length;
  const system =
    '你是一个高速、精准的翻译引擎。你的唯一任务是把用户给出的 JSON 数组翻译成指定语言，' +
    '并且只输出一个同样长度的 JSON 数组。你从不输出解释、前言、markdown 代码块或任何额外文字。';

  const sourceLine =
    sourceLangLabel && sourceLangLabel !== 'auto'
      ? `源语言是「${sourceLangLabel}」。`
      : '源语言由你自动判断（可能是英文、中文或其他语言）。';

  const user = `把下面 JSON 数组中的 ${n} 个字符串全部翻译成「${targetLangLabel}」。
${sourceLine}

${COMMON_RULES}
7. 输出必须是一个 JSON 数组，元素个数严格等于 ${n}，顺序与输入一一对应。
8. 只输出 JSON 数组本身，不要加 \`\`\`json 围栏，不要在数组前后写任何字。

输入：
${JSON.stringify(texts, null, 0)}`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/**
 * 单条翻译（划词、右键菜单用）。同样要求纯文本输出。
 */
export function buildSingleTranslateMessages({ text, targetLangLabel, sourceLangLabel }) {
  const srcHint =
    sourceLangLabel && sourceLangLabel !== 'auto'
      ? `源语言是「${sourceLangLabel}」，`
      : '';
  const system =
    '你是一个专业的翻译引擎。你只输出译文本身，不输出原文、不输出解释、不输出引号或代码块。';
  const user = `${srcHint}请把下面的内容翻译成「${targetLangLabel}」。

${COMMON_RULES}

输出要求：只输出译文纯文本，不要重复原文，不要加任何前后缀。

原文：
${text}`;
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/**
 * 网页总结。让模型输出轻量 Markdown，前端用极简渲染器展示。
 */
export function buildSummaryMessages({ title, url, text, targetLangLabel, style = 'bullets' }) {
  const system =
    '你是一位资深的内容分析师，擅长快速读懂一篇长文并提炼出对读者真正有价值的信息。' +
    '你说话直接、不啰嗦、不吹捧，只讲事实和结论。';
  const shape =
    style === 'outline'
      ? `输出结构（Markdown）：
## 核心结论
用 2-3 句话说明这篇文章到底讲了什么、结论是什么。
## 内容大纲
按文章顺序列出 3-6 个层级要点，每条一行。
## 关键信息
列出值得记住的数据、结论或名词。`
      : `输出结构（Markdown）：
先用一句话（40 字以内）概括全文，加粗显示。
然后列出 4-6 条要点，每条以「- 」开头，每条不超过 40 字，聚焦结论与干货，不要复述废话。
最后单独一行：**适合谁看：** 一句话说明目标读者。`;

  const user = `请阅读并总结下面这个网页的内容，用「${targetLangLabel}」输出。

${shape}

要求：
1. 只依据正文内容总结，不要编造正文里没有的信息。
2. 忽略导航、广告、评论区、登录提示等噪音内容。
3. 直接输出 Markdown 正文，不要写「好的」「以下是总结」这类开场白。
4. 输出的所有文字都必须是「${targetLangLabel}」，包括上面结构里提到的各个小标题
   （例如「适合谁看」「核心结论」「内容大纲」这些标签也要译成目标语言，
   英文输出时应写成 "Who this is for" / "Key takeaways" 之类，不要留下中文标签）。

网页标题：${title || '(无标题)'}
网页地址：${url || '(未知)'}

网页正文：
${text}`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/** 连接测试用：要求极短的确定性输出 */
export function buildTestMessages() {
  return [
    { role: 'system', content: '你是翻译引擎，只输出 JSON 数组，不输出任何其他内容。' },
    {
      role: 'user',
      content: '把下面 JSON 数组翻译成简体中文，只输出 JSON 数组：\n["Hello","OK"]',
    },
  ];
}
