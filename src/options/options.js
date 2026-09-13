/**
 * 管理面板逻辑。
 *
 * 数据来源分两类：
 *  - 配置项：面板本身就是扩展页面，直接走 settings.js 读写（与弹窗一致）
 *  - 历史 / 统计：统一走后台，保证聚合与裁剪逻辑只有一处实现
 */

import { getSettings, saveSettings, LANGUAGES, SOURCE_LANGUAGES, languageLabel } from '../lib/settings.js';
import { inspectBaseUrl } from '../lib/llm.js';
import { MSG } from '../lib/protocol.js';
import { TYPE_LABELS } from '../lib/history.js';

const el = (id) => document.getElementById(id);
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

let settings = null;
let historyCache = [];
let flashTimer = null;

/* ------------------------------------------------------------------ */
/* 通用工具                                                            */
/* ------------------------------------------------------------------ */

function flash(text) {
  const node = el('flash');
  node.textContent = text;
  node.hidden = false;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => (node.hidden = true), 1800);
}

/** 调用后台并解包 {ok, data} */
async function call(type, payload = {}) {
  const res = await chrome.runtime.sendMessage({ type, ...payload });
  if (!res?.ok) throw new Error(res?.error?.message || '后台无响应');
  return res.data;
}

function fmtNum(n) {
  const v = Number(n) || 0;
  if (v >= 1e8) return (v / 1e8).toFixed(2) + ' 亿';
  if (v >= 1e4) return (v / 1e4).toFixed(v >= 1e5 ? 0 : 1) + ' 万';
  return v.toLocaleString('zh-CN');
}

function fmtTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const p = (n) => String(n).padStart(2, '0');
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  if (sameDay) return `今天 ${hm}`;
  if (d.getFullYear() === now.getFullYear()) return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${hm}`;
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${hm}`;
}

function fmtDuration(ms) {
  const v = Number(ms) || 0;
  if (!v) return '—';
  return v >= 1000 ? (v / 1000).toFixed(1) + 's' : v + 'ms';
}

/** 费用可能很小（几厘钱），按量级决定小数位，别把真实费用显示成 0.00 */
function fmtCost(v) {
  const n = Number(v) || 0;
  if (n === 0) return '0.00';
  if (n < 0.01) return n.toFixed(4);
  if (n < 1) return n.toFixed(3);
  return n.toFixed(2);
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function truncate(s, n = 70) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch { /* 忽略 */ }
    ta.remove();
  }
  if (btn) {
    const old = btn.textContent;
    btn.textContent = '已复制 ✓';
    setTimeout(() => (btn.textContent = old), 1200);
  }
}

/* ------------------------------------------------------------------ */
/* 标签页切换                                                          */
/* ------------------------------------------------------------------ */

function switchTab(name) {
  for (const btn of $$('#nav .nav-item')) btn.classList.toggle('active', btn.dataset.tab === name);
  for (const section of $$('.tab')) section.classList.toggle('active', section.id === `tab-${name}`);
  if (name === 'history') renderHistory();
  if (name === 'usage') renderUsage();
  if (location.hash !== `#${name}`) history.replaceState(null, '', `#${name}`);
}

/* ------------------------------------------------------------------ */
/* 初始化                                                              */
/* ------------------------------------------------------------------ */

async function init() {
  settings = await getSettings();

  // 下拉选项
  el('sourceLang').innerHTML = SOURCE_LANGUAGES.map(
    (l) => `<option value="${l.code}">${l.label}</option>`
  ).join('');
  el('targetLang').innerHTML = LANGUAGES.map((l) => `<option value="${l.code}">${l.label}</option>`).join('');

  fillForms();
  bindEvents();

  const initial = (location.hash || '#overview').slice(1);
  switchTab($$('#nav .nav-item').some((b) => b.dataset.tab === initial) ? initial : 'overview');

  await Promise.all([refreshStats(), refreshHistory()]);
  renderOverviewMeta();
}

/** 把配置回填到各个表单 */
function fillForms() {
  el('baseUrl').value = settings.baseUrl || '';
  el('apiKey').value = settings.apiKey || '';
  el('model').value = settings.model || '';

  el('sourceLang').value = settings.sourceLang || 'auto';
  el('targetLang').value = settings.targetLang || 'zh-CN';
  el('displayMode').value = settings.displayMode || 'replace';
  el('disableThinking').checked = settings.disableThinking !== false;
  el('selectionTranslate').checked = settings.selectionTranslate !== false;
  el('autoTranslate').checked = !!settings.autoTranslate;

  el('historyEnabled').checked = settings.historyEnabled !== false;
  el('historyStoreText').checked = settings.historyStoreText !== false;
  el('historyLimit').value = String(settings.historyLimit || 300);

  el('pricePromptPerM').value = settings.pricePromptPerM || '';
  el('priceCompletionPerM').value = settings.priceCompletionPerM || '';

  refreshUrlHint();
  refreshSideStatus();
  refreshLangHint();
}

/** 侧栏底部的状态指示 */
function refreshSideStatus() {
  const dot = el('sideDot');
  const text = el('sideStatus');
  if (!settings?.apiKey) {
    dot.className = 'status-dot warn';
    text.textContent = '还没配置 API Key，去「模型配置」填写后才能使用';
    return;
  }
  dot.className = 'status-dot ok';
  text.textContent = `已就绪 · ${settings.model || '未填模型'}`;
}

function renderOverviewMeta() {
  el('ovBaseUrl').textContent = settings.baseUrl || '—';
  el('ovModel').textContent = settings.model || '—';
  el('ovKey').textContent = settings.apiKey
    ? settings.apiKey.slice(0, 6) + '••••••' + settings.apiKey.slice(-4)
    : '未配置';
  el('ovLangs').textContent = `${languageLabel(settings.sourceLang || 'auto')} → ${languageLabel(settings.targetLang)}`;
}

function refreshUrlHint() {
  const raw = el('baseUrl').value.trim();
  const check = inspectBaseUrl(raw);
  const node = el('baseUrlHint');
  if (!raw) {
    node.textContent = '例如 https://api.deepseek.com/v1 （多数服务需要带 /v1）';
    node.className = 'hint';
    return true;
  }
  node.textContent = check.ok
    ? '地址格式正常。填 https://api.deepseek.com 也会自动补全为 /v1/chat/completions'
    : check.hint;
  node.className = 'hint' + (check.ok ? '' : ' bad');
  return check.ok;
}

function refreshLangHint() {
  const src = el('sourceLang').value;
  const dst = el('targetLang').value;
  const node = el('langHint');
  if (src === 'auto') {
    node.textContent = '源语言选「自动检测」时由模型自行判断原文语言。';
  } else if (src === dst) {
    node.textContent = '源语言和目标语言相同，翻译结果会和原文一样，记得改一下。';
    node.className = 'hint bad';
    return;
  } else {
    node.textContent = `当前方向：${languageLabel(src)} → ${languageLabel(dst)}。`;
  }
  node.className = 'hint';
}

/* ------------------------------------------------------------------ */
/* 事件绑定                                                            */
/* ------------------------------------------------------------------ */

function bindEvents() {
  for (const btn of $$('#nav .nav-item')) btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  for (const btn of $$('[data-goto]')) {
    btn.addEventListener('click', () => switchTab(btn.dataset.goto));
  }

  el('baseUrl').addEventListener('input', refreshUrlHint);
  el('btnToggleKey').addEventListener('click', () => {
    const hidden = el('apiKey').type === 'password';
    el('apiKey').type = hidden ? 'text' : 'password';
    el('btnToggleKey').textContent = hidden ? '隐藏' : '显示';
  });

  el('btnSaveModel').addEventListener('click', saveModelForm);
  el('btnTest').addEventListener('click', () => runTest(el('btnTest'), el('testOut')));
  el('ovTest').addEventListener('click', () => runTest(el('ovTest'), el('ovTestOut')));

  el('sourceLang').addEventListener('change', refreshLangHint);
  el('targetLang').addEventListener('change', refreshLangHint);
  el('btnSwap').addEventListener('click', async () => {
    const src = el('sourceLang').value;
    const dst = el('targetLang').value;
    if (src === 'auto') {
      flash('源语言是「自动检测」，无法互换');
      return;
    }
    el('sourceLang').value = dst;
    el('targetLang').value = src;
    refreshLangHint();
    await persist({ sourceLang: dst, targetLang: src }, '已互换语言方向');
  });

  el('btnSaveLang').addEventListener('click', async () => {
    const src = el('sourceLang').value;
    const dst = el('targetLang').value;
    if (src === dst && src !== 'auto') {
      flash('源语言和目标语言不能相同');
      return;
    }
    await persist(
      {
        sourceLang: src,
        targetLang: dst,
        displayMode: el('displayMode').value,
        disableThinking: el('disableThinking').checked,
        selectionTranslate: el('selectionTranslate').checked,
        autoTranslate: el('autoTranslate').checked,
      },
      '设置已保存'
    );
  });

  // 开关类：改动即存
  for (const id of ['disableThinking', 'selectionTranslate', 'autoTranslate']) {
    el(id).addEventListener('change', () => persist({ [id]: el(id).checked }, '已自动保存', true));
  }
  el('displayMode').addEventListener('change', () =>
    persist({ displayMode: el('displayMode').value }, '已自动保存', true)
  );

  // 历史设置
  el('historyEnabled').addEventListener('change', () =>
    persist({ historyEnabled: el('historyEnabled').checked }, '已自动保存', true)
  );
  el('historyStoreText').addEventListener('change', () =>
    persist({ historyStoreText: el('historyStoreText').checked }, '已自动保存', true)
  );
  el('historyLimit').addEventListener('change', async () => {
    await persist({ historyLimit: Number(el('historyLimit').value) }, '已自动保存', true);
    await refreshHistory();
  });

  el('historyFilter').addEventListener('change', renderHistory);
  el('historySearch').addEventListener('input', renderHistory);

  el('btnClearHistory').addEventListener('click', async () => {
    if (!confirm('确定清空全部历史记录吗？累计用量统计会保留。')) return;
    const r = await call(MSG.CLEAR_HISTORY);
    await refreshHistory();
    flash(`已清空 ${r.removed} 条历史`);
  });

  el('btnSavePrice').addEventListener('click', async () => {
    await persist(
      {
        pricePromptPerM: Number(el('pricePromptPerM').value) || 0,
        priceCompletionPerM: Number(el('priceCompletionPerM').value) || 0,
      },
      '单价已保存'
    );
    await refreshStats();
  });

  el('btnClearStats').addEventListener('click', async () => {
    if (!confirm('确定清空用量统计吗？历史记录也会一并清空。')) return;
    await call(MSG.CLEAR_STATS);
    await Promise.all([refreshStats(), refreshHistory()]);
    flash('统计与历史已清空');
  });
}

async function persist(patch, message = '已保存', quiet = false) {
  settings = await saveSettings(patch);
  if (!quiet) flash(message);
  refreshSideStatus();
  renderOverviewMeta();
  renderHistory();
  return settings;
}

/* ------------------------------------------------------------------ */
/* 保存与测试                                                          */
/* ------------------------------------------------------------------ */

async function saveModelForm() {
  if (!refreshUrlHint()) {
    flash('接口地址看起来不对，请检查');
    el('baseUrl').focus();
    return;
  }
  const apiKey = el('apiKey').value.trim();
  if (!apiKey) {
    flash('API Key 不能为空');
    el('apiKey').focus();
    return;
  }
  await persist(
    {
      baseUrl: el('baseUrl').value.trim().replace(/\/+$/, ''),
      apiKey,
      model: el('model').value.trim(),
    },
    '模型配置已保存'
  );
}

async function runTest(btn, out) {
  const form = {
    baseUrl: el('baseUrl').value.trim().replace(/\/+$/, ''),
    apiKey: el('apiKey').value.trim(),
    model: el('model').value.trim(),
  };
  if (!form.apiKey) {
    flash('请先填写 API Key');
    return;
  }
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = '测试中…';
  out.hidden = false;
  out.className = 'test-out';
  out.textContent = `正在请求 ${form.model || '(未填模型)'} …`;
  try {
    const d = await call(MSG.TEST_CONNECTION, { settings: form });
    out.className = 'test-out ok';
    out.textContent = `连接成功 ✓ 模型 ${d.model} · 耗时 ${(d.elapsedMs / 1000).toFixed(1)}s · 返回：${d.text}`;
  } catch (err) {
    out.className = 'test-out bad';
    out.textContent = '连接失败 ✗ ' + (err?.message || String(err));
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

/* ------------------------------------------------------------------ */
/* 数据刷新                                                            */
/* ------------------------------------------------------------------ */

async function refreshHistory() {
  const data = await call(MSG.GET_HISTORY);
  historyCache = data.list || [];
  el('historyPill').textContent = String(historyCache.length);
  renderHistory();
  renderOverviewRecent();
}

async function refreshStats() {
  const stats = await call(MSG.GET_STATS, { days: 14 });
  renderUsage(stats);
  renderOverviewStats(stats);
  return stats;
}

/* ------------------------------------------------------------------ */
/* 概览渲染                                                            */
/* ------------------------------------------------------------------ */

function renderOverviewStats(stats) {
  const t = stats.total;
  el('ovRequests').textContent = fmtNum(t.requests);
  el('ovFirstAt').textContent = stats.firstAt ? `始于 ${fmtTime(stats.firstAt)}` : '还没有数据';

  el('ovTokens').textContent = fmtNum(t.tokens);
  el('ovTokensSub').textContent = t.tokens ? `输入 ${fmtNum(t.prompt)} / 输出 ${fmtNum(t.completion)}` : '还没有数据';

  el('ovToday').textContent = fmtNum(stats.today.tokens);
  el('ovTodaySub').textContent = stats.today.requests
    ? `今日 ${stats.today.requests} 次请求`
    : '今天还没有使用';

  el('ovChars').textContent = fmtNum(t.chars);
  el('ovCharsSub').textContent = t.items ? `共 ${fmtNum(t.items)} 段文本` : '还没有数据';
}

function renderOverviewRecent() {
  const list = el('ovRecent');
  const recent = historyCache.slice(0, 5);
  if (!recent.length) {
    list.innerHTML = '<li class="muted">还没有记录</li>';
    return;
  }
  list.innerHTML = recent
    .map((e) => {
      const preview = e.dst || e.src || e.title || e.url || '(无内容预览)';
      const tag = `<span class="tag ${e.status === 'failed' ? 'failed' : e.type}">${
        TYPE_LABELS[e.type] || e.type
      }</span>`;
      return `<li>${tag}<span class="txt" title="${escapeHtml(preview)}">${escapeHtml(
        truncate(preview, 60)
      )}</span><span class="meta">${fmtNum(e.tokens)} tok · ${fmtTime(e.ts)}</span></li>`;
    })
    .join('');
}

/* ------------------------------------------------------------------ */
/* 历史渲染                                                            */
/* ------------------------------------------------------------------ */

function filteredHistory() {
  const type = el('historyFilter').value;
  const q = el('historySearch').value.trim().toLowerCase();
  return historyCache.filter((e) => {
    if (type && e.type !== type) return false;
    if (!q) return true;
    const hay = [e.src, e.dst, e.url, e.title, e.model, e.error].join(' ').toLowerCase();
    return hay.includes(q);
  });
}

function renderHistory() {
  if (!el('historyList')) return;
  const list = filteredHistory();
  const wrap = el('historyList');
  const empty = el('historyEmpty');

  if (!list.length) {
    wrap.innerHTML = '';
    empty.hidden = false;
    empty.textContent = historyCache.length
      ? '没有符合筛选条件的记录。'
      : '还没有历史记录。去翻译一个页面试试？';
    return;
  }
  empty.hidden = true;

  wrap.innerHTML = list
    .map((e) => {
      // 类型标签始终显示（筛选是按类型来的），失败状态另加一个标签，避免混在一起看不明白
      const typeTag = `<span class="tag ${e.type}">${TYPE_LABELS[e.type] || e.type}</span>`;
      const statusTag =
        e.status === 'failed'
          ? '<span class="tag failed">失败</span>'
          : e.status === 'partial'
          ? '<span class="tag failed">部分失败</span>'
          : '';
      const preview = e.dst || e.src || e.title || e.url || '(无内容预览)';
      return `
      <li class="hitem" data-id="${e.id}">
        <div class="hhead">
          ${typeTag}${statusTag}
          <span class="titleline" title="${escapeHtml(preview)}">${escapeHtml(truncate(preview, 90))}</span>
          <span class="meta">
            <span>${fmtNum(e.tokens)} tok</span>
            <span>${languageLabel(e.sourceLang || 'auto')}→${languageLabel(e.targetLang)}</span>
            <span>${fmtTime(e.ts)}</span>
          </span>
          <span class="caret">▶</span>
        </div>
        <div class="hbody">${renderHistoryBody(e)}</div>
      </li>`;
    })
    .join('');

  for (const head of $$('#historyList .hhead')) {
    head.addEventListener('click', () => head.parentElement.classList.toggle('open'));
  }
  for (const btn of $$('#historyList [data-copy]')) {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const item = btn.closest('.hitem');
      const entry = historyCache.find((x) => x.id === item.dataset.id);
      copyText(entry?.[btn.dataset.copy] || '', btn);
    });
  }
  for (const btn of $$('#historyList [data-del]')) {
    btn.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const item = btn.closest('.hitem');
      await call(MSG.DELETE_HISTORY, { id: item.dataset.id });
      await refreshHistory();
      flash('已删除该条记录');
    });
  }
}

function renderHistoryBody(e) {
  const parts = [];
  if (e.error) {
    parts.push(`<div class="hrow"><div class="hrow-label"><span>错误</span></div>
      <div class="hrow-text">${escapeHtml(e.error)}</div></div>`);
  }
  if (e.src) {
    parts.push(`<div class="hrow">
      <div class="hrow-label"><span>原文</span><button class="btn ghost sm" data-copy="src">复制</button></div>
      <div class="hrow-text">${escapeHtml(e.src)}</div></div>`);
  }
  if (e.dst) {
    parts.push(`<div class="hrow">
      <div class="hrow-label"><span>${e.type === 'summary' ? '总结' : '译文'}</span>
        <button class="btn ghost sm" data-copy="dst">复制</button></div>
      <div class="hrow-text dst">${escapeHtml(e.dst)}</div></div>`);
  }
  if (!e.src && !e.dst && !e.error) {
    parts.push('<div class="hrow"><div class="hrow-text muted">这条记录没有保存正文（可在上方关闭「保存正文」后仅保留元信息）。</div></div>');
  }

  const meta = [
    `<span>模型：${escapeHtml(e.model || '—')}</span>`,
    `<span>方向：${languageLabel(e.sourceLang || 'auto')} → ${languageLabel(e.targetLang)}</span>`,
    `<span>文本：${fmtNum(e.items)} 段 / ${fmtNum(e.chars)} 字</span>`,
    `<span>token：输入 ${fmtNum(e.prompt)} · 输出 ${fmtNum(e.completion)} · 合计 ${fmtNum(e.tokens)}</span>`,
    `<span>耗时：${fmtDuration(e.durationMs)}</span>`,
    `<span>时间：${fmtTime(e.ts)}</span>`,
  ];
  if (e.url) {
    meta.push(`<span>来源：<a href="${escapeHtml(e.url)}" target="_blank" rel="noreferrer">${escapeHtml(truncate(e.title || e.url, 50))}</a></span>`);
  }
  parts.push(`<div class="hrow-meta">${meta.join('')}</div>`);
  parts.push(`<div class="hacts"><button class="btn ghost sm" data-del="1">删除这条记录</button></div>`);
  return parts.join('');
}

/* ------------------------------------------------------------------ */
/* 用量渲染                                                            */
/* ------------------------------------------------------------------ */

function renderUsage(stats) {
  const t = stats.total;
  el('usTokens').textContent = fmtNum(t.tokens);
  el('usTokensSub').textContent = t.requests ? `共 ${fmtNum(t.requests)} 次请求` : '还没有数据';

  el('usSplit').textContent = t.tokens ? `${fmtNum(t.prompt)} / ${fmtNum(t.completion)}` : '—';
  el('usSplitSub').textContent = t.tokens
    ? `平均每次 ${fmtNum(Math.round(t.tokens / Math.max(1, t.requests)))} token`
    : '还没有数据';

  el('usWeek').textContent = fmtNum(stats.week.tokens);
  el('usWeekSub').textContent = stats.week.requests ? `${stats.week.requests} 次请求` : '近 7 天没有使用';

  el('usCost').textContent = stats.priced ? `¥ ${fmtCost(stats.cost)}` : '未设置单价';
  el('usCostSub').textContent = stats.priced
    ? '按你填写的单价估算'
    : '在下方填写单价后可估算';

  el('chartRange').textContent = stats.series.length
    ? `${stats.series[0].day} ~ ${stats.series[stats.series.length - 1].day}`
    : '';
  renderChart(stats.series);

  fillTable(el('byModelTable'), stats.byModel.map((m) => [m.model, m.requests, m.tokens]), t.tokens);
  fillTable(
    el('byTypeTable'),
    stats.byType.map((x) => [x.label, x.requests, x.tokens]),
    t.tokens
  );
}

function fillTable(table, rows, totalTokens) {
  const body = $('tbody', table);
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="3" class="muted">还没有数据</td></tr>';
    return;
  }
  body.innerHTML = rows
    .map(([name, req, tokens]) => {
      const pct = totalTokens ? Math.round((tokens / totalTokens) * 100) : 0;
      return `<tr><td>${escapeHtml(name)}${pct ? ` <span class="muted sm">${pct}%</span>` : ''}</td>
        <td class="num">${fmtNum(req)}</td><td class="num">${fmtNum(tokens)}</td></tr>`;
    })
    .join('');
}

/** 用内联 SVG 画柱状图，不引任何外部图表库 */
function renderChart(series) {
  const wrap = el('usageChart');
  if (!series.length || series.every((s) => !s.tokens)) {
    wrap.innerHTML = '<p class="empty">还没有可统计的用量数据。</p>';
    return;
  }
  const W = 680;
  const H = 200;
  const padL = 8;
  const padR = 8;
  const padT = 22;
  const padB = 26;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const max = Math.max(...series.map((s) => s.tokens), 1);
  const slot = plotW / series.length;
  const barW = Math.min(30, slot * 0.6);

  const bars = series
    .map((s, i) => {
      const x = padL + slot * i + (slot - barW) / 2;
      const h = s.tokens ? Math.max(3, (s.tokens / max) * plotH) : 0;
      const y = padT + plotH - h;
      const cls = s.tokens ? 'bar' : 'bar-empty';
      const val = s.tokens ? `<text class="val" x="${(x + barW / 2).toFixed(1)}" y="${(y - 6).toFixed(1)}" text-anchor="middle">${fmtNum(s.tokens)}</text>` : '';
      const label =
        i % 2 === 0 || i === series.length - 1
          ? `<text class="axis" x="${(x + barW / 2).toFixed(1)}" y="${H - 8}" text-anchor="middle">${s.label}</text>`
          : '';
      return `<rect class="${cls}" x="${x.toFixed(1)}" y="${(s.tokens ? y : padT + plotH - 2).toFixed(1)}" width="${barW.toFixed(
        1
      )}" height="${(s.tokens ? h : 2).toFixed(1)}" rx="4"><title>${s.day}：${fmtNum(s.tokens)} token（${
        s.requests
      } 次请求）</title></rect>${val}${label}`;
    })
    .join('');

  wrap.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="近 14 天 token 消耗">
      <defs>
        <linearGradient id="barGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#7c5cff"/>
          <stop offset="100%" stop-color="#4f7cff"/>
        </linearGradient>
      </defs>
      <line x1="${padL}" y1="${padT + plotH}" x2="${W - padR}" y2="${padT + plotH}"
        stroke="currentColor" stroke-opacity="0.14" stroke-width="1"/>
      ${bars}
    </svg>`;
}

/* ------------------------------------------------------------------ */

init().catch((err) => {
  el('sideStatus').textContent = '初始化失败：' + (err?.message || String(err));
  el('sideDot').className = 'status-dot warn';
});
