// 生成 README 功能展示页（演示数据，全部虚构）：node scripts/make-readme-shots.mjs
// 用插件真实的 charts.js + 真实 CSS 渲染，保证截图与真实 UI 一致；不含任何真实会话数据。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stackedBars, trendLines, donut, rankingBars, calendarHeatmap, activityTrend, compareTable } from '../src/client/charts.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// 从 src/client/index.js 安全求值 CSS 字符串常量（仅字符串拼接，无副作用）
const src = fs.readFileSync(path.join(root, 'src/client/index.js'), 'utf8');
const expr = (name) => {
  const line = src.split('\n').find((l) => l.trimStart().startsWith('const ' + name + ' ='));
  return new Function('return ' + line.trim().slice(('const ' + name + ' =').length).replace(/;\s*$/, ''))();
};
const CSS = expr('CSS');
const OVR = expr('CSS_OVERRIDES');

const FREEZE = '*,:before,:after{animation-duration:0s!important;animation-delay:0s!important;transition:none!important}';

// ---------- 演示数据（确定性伪随机，全部虚构） ----------
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20261120);
const TZ = 8 * 3600;
const NOW = Math.floor(Date.UTC(2026, 10, 20, 4, 0, 0) / 1000); // 2026-11-20 12:00 +08
const DAY = 86400;

const MODELS = [
  { provider: 'deepseek', model: 'deepseek-v4-pro', calls: 5200, tokAvg: 5200, price: 13.5, speed: 41.2, p50: 1450, p95: 6800, hit: 0.87, cov: 1 },
  { provider: 'anthropic', model: 'claude-opus-4-5-thinking', calls: 3100, tokAvg: 9800, price: 210, speed: 58.6, p50: 2300, p95: 11400, hit: 0.74, cov: 0.98 },
  { provider: 'moonshot', model: 'kimi-k2-thinking', calls: 2500, tokAvg: 7400, price: 39, speed: 47.3, p50: 1780, p95: 8200, hit: 0.81, cov: 1 },
  { provider: 'zai', model: 'glm-5.3', calls: 1900, tokAvg: 4300, price: 8, speed: 88.9, p50: 920, p95: 4100, hit: 0.9, cov: 1 },
  { provider: 'google', model: 'gemini-2.5-pro', calls: 1200, tokAvg: 8600, price: 84, speed: 63.4, p50: 1650, p95: 7600, hit: 0.79, cov: 0.96 },
  { provider: 'openai', model: 'gpt-5.2-codex', calls: 640, tokAvg: 11200, price: 120, speed: 72.1, p50: 2100, p95: 9800, hit: 0.68, cov: 0.92 },
  { provider: 'byted', model: 'doubao-seed-1-6-thinking', calls: 310, tokAvg: 5100, price: 16, speed: 66.8, p50: 1280, p95: 5600, hit: 0.83, cov: 1 },
  { provider: 'xai', model: 'grok-4-fast', calls: 96, tokAvg: 3600, price: 12, speed: 121.5, p50: 640, p95: 2800, hit: 0.55, cov: 0.88 },
];

function weekdayFactor(dayIdx) { const d = (dayIdx + 3) % 7; return d >= 5 ? 0.42 : 1; }

// 30 天逐日桶（消耗分布 / 调用趋势）
const stacks = [];
for (let i = 29; i >= 0; i--) {
  const start = Math.floor((NOW - i * DAY + TZ) / DAY) * DAY - TZ; // 当地日界
  const di = 29 - i;
  const cells = [];
  for (const m of MODELS) {
    if (m.calls < 200 && rnd() < 0.45) continue; // 小模型部分日子缺席
    const calls = Math.max(1, Math.round((m.calls / 30) * weekdayFactor(di) * (0.65 + rnd() * 0.8)));
    const tokens = Math.round(calls * m.tokAvg * (0.8 + rnd() * 0.5));
    const cost = (tokens / 1e6) * m.price;
    const cacheHitRate = (di + m.model.length) % 17 === 0 ? null : Math.max(0.35, Math.min(0.98, m.hit + ((di % 5) - 2) * 0.012));
    cells.push({ provider: m.provider, model: m.model, count: calls, tokens, cost, priced: true, cacheHitRate });
  }
  stacks.push({ start, gran: 'day', cells });
}

// 汇总
const agg = new Map();
for (const b of stacks) for (const c of b.cells) {
  const a = agg.get(c.model) || { provider: c.provider, model: c.model, calls: 0, ok: 0, failed: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cost: 0, priced: true };
  a.calls += c.count; a.ok += Math.round(c.count * 0.985); a.failed += c.count - Math.round(c.count * 0.985);
  a.totalTokens += c.tokens; a.inputTokens += Math.round(c.tokens * 0.78); a.outputTokens += Math.round(c.tokens * 0.22);
  a.cacheReadTokens += Math.round(c.tokens * 0.41); a.cost += c.cost;
  agg.set(c.model, a);
}
const all = [...agg.values()];
for (const m of MODELS) { const a = agg.get(m.model); a.currency = 'CNY'; a.costPerMillionTokens = (a.cost / a.totalTokens) * 1e6; a.speedTokensPerSec = m.speed; a.p50 = m.p50; a.p95 = m.p95; a.cacheHitRate = m.hit; a.cacheCoverage = m.cov; }

const donutItems = all.map((a) => ({ provider: a.provider, model: a.model, calls: a.calls, tokens: a.totalTokens, cost: a.cost, priced: true }));
const rankingRows = all.map((a) => ({ provider: a.provider, model: a.model, calls: a.calls, totalTokens: a.totalTokens, cost: a.cost, priced: true }));
const compareRows = [...all].sort((a, b) => b.cost - a.cost);

// 53 周热力图：12 个月日 token（确定性波动 + 周末低谷 + 少量空白）
const days = [];
for (let i = 370; i >= 0; i--) {
  const day = Math.floor((NOW - i * DAY + TZ) / DAY) * DAY - TZ;
  const di = 370 - i;
  const wave = 0.55 + 0.45 * Math.sin(di / 9) + 0.25 * Math.sin(di / 3.1);
  const growth = 0.35 + 0.65 * (di / 370);
  let tokens = 9e6 * wave * growth * weekdayFactor(di) * (0.6 + rnd() * 0.9);
  if (rnd() < 0.05) tokens = 0;
  if (di === 0) tokens = 6.2e6;
  days.push({ day, tokens: Math.max(0, Math.round(tokens)) });
}

// ---------- UI 壳（类名与 ui.js 一致） ----------
const TABS = [['消耗分布', 'stacks'], ['调用趋势', 'trend'], ['调用次数分布', 'dist'], ['调用次数排行', 'rank'], ['模型对比', 'compare'], ['会话明细', 'sessions']];
const tabsHtml = (active) => '<div class="mca-tabs" role="tablist">' + TABS.map(([label, key]) =>
  '<button role="tab" class="mca-tab' + (key === active ? ' on' : '') + '">' + label + '</button>').join('') + '</div>';

const seg = (pairs, onKey, sm) => '<div class="mca-seg' + (sm ? ' mca-seg-sm' : '') + '">' +
  pairs.map(([label, key]) => '<button class="mca-seg-btn' + (key === onKey ? ' on' : '') + '">' + label + '</button>').join('') + '</div>';
const filtersHtml = (rangeOn, granOn) => '<div class="mca-filters"><div class="mca-toolbar-main">' +
  seg([['今天', 'today'], ['24H', '24h'], ['7D', '7d'], ['30D', '30d'], ['90D', '90d']], rangeOn) +
  (granOn ? seg([['小时', 'hour'], ['天', 'day'], ['月', 'month']], granOn, true) : '') +
  '<details class="mca-drop"><summary class="mca-drop-btn">筛选<span class="mca-count">2</span></summary></details>' +
  '</div><div class="mca-toolbar-side"><button class="mca-settings-btn">费用设置</button></div></div>';

const kpiHtml = '<div class="mca-kpis">' + [
  ['预估费用', '¥ 1,284.60', ''],
  ['计费 Tokens', '68.42M', ''],
  ['输入 Tokens', '41.26M', ''],
  ['输出 Tokens', '8.74M', ''],
  ['缓存 Tokens', '18.42M', '读 17.96M · 写 0.46M'],
  ['缓存命中率', '81.4%', '遥测覆盖 98.6%'],
  ['用量请求', '14,946', ''],
  ['会话数', '312', ''],
].map(([l, v, s]) => '<div class="mca-kpi"><div class="mca-kpi-label">' + l + '</div><div class="mca-kpi-value">' + v + '</div>' + (s ? '<div class="mca-kpi-sub">' + s + '</div>' : '') + '</div>').join('') + '</div>';

const card = (title, sub, tools, body) => '<div class="mca-card"><div class="mca-card-head"><div class="mca-card-title-wrap"><span class="mca-card-title">' + title + '</span>' + (sub ? '<span class="mca-card-sub">' + sub + '</span>' : '') + '</div><div class="mca-card-tools">' + tools + '</div></div>' + body + '</div>';
const pills = (on) => seg([['Token', 'tokens'], ['费用', 'cost'], ['次数', 'count']], on, true);
const trendPills = (on) => seg([['Token', 'tokens'], ['费用', 'cost'], ['次数', 'count'], ['缓存', 'cache']], on, true);
const RANGE_LABEL = '最近 30 天';

const page = (title, inner, width, rootClass = '', rootStyle = '') => `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title>
<style>
:root{--dsw-alias-bg-layer-1:#16181d;--dsw-alias-bg-layer-2:#1f232b;--dsw-alias-label-primary:#e8eaf0;--dsw-alias-label-secondary:#9aa2b1;--dsw-alias-border-l1:#2a2f3a;--dsw-alias-state-error-primary:#e5484d}
body{background:#0d0f13;color:#e8eaf0;font-family:system-ui,'Segoe UI','Microsoft YaHei',sans-serif;margin:0;padding:18px 20px 24px;width:${width}px;box-sizing:border-box}
${CSS}
${OVR}
${FREEZE}
.dsh-window-bar{display:flex;align-items:center;gap:8px;margin-bottom:10px;color:#9aa2b1;font-size:12px}
.dsh-window-bar .dot{width:10px;height:10px;border-radius:50%;display:inline-block}
</style></head><body class="mca-root ${rootClass}" style="${rootStyle}">${inner}</body></html>`;

const outDir = path.join(root, 'out', 'shots');
fs.mkdirSync(outDir, { recursive: true });
const write = (name, html) => { fs.writeFileSync(path.join(outDir, name), html); console.log('written', name); };

// ① 消耗分布（主视图 hero）
write('hero.html', page('消耗分布',
  '<div class="dsh-window-bar"><span class="dot" style="background:#e5484d"></span><span class="dot" style="background:#f5a623"></span><span class="dot" style="background:#46d976"></span><span style="margin-left:10px">DeepSeek Harness — 设置 → Token 台账</span></div>'
  + tabsHtml('stacks') + filtersHtml('30d', 'day') + kpiHtml
  + card('模型消耗分布', RANGE_LABEL, pills('tokens'), stackedBars(stacks, { metric: 'tokens', tz: TZ, currency: 'CNY' }))
  + card('用量活动', '连续活跃 12 天 · 最高单日 18.6M（11-06） · 近 7 日 +18.6%', seg([['日', 'daily'], ['周', 'week'], ['累计', 'cumulative']], 'daily', true), calendarHeatmap(days, { tz: TZ, now: NOW })),
  1240));

// ② 调用趋势
write('trend.html', page('调用趋势',
  tabsHtml('trend') + filtersHtml('30d', 'day')
  + card('调用趋势', RANGE_LABEL, trendPills('count'), trendLines(stacks, { metric: 'count', tz: TZ, currency: 'CNY' })),
  1240));

// ②b 缓存命中率趋势（折线连续衔接，圆点只标实测）
write('cache.html', page('缓存命中率趋势',
  tabsHtml('trend') + filtersHtml('30d', 'day')
  + card('调用趋势', RANGE_LABEL + ' · 缓存命中率 · 折线含插值，圆点为实测', trendPills('cache'), trendLines(stacks, { metric: 'cache', tz: TZ, currency: 'CNY' })),
  1240));

// ③ 调用次数分布（环形）+ 排行
write('donut.html', page('调用次数分布',
  tabsHtml('dist') + filtersHtml('30d', null)
  + card('模型调用次数占比', '点击扇区可筛选', pills('tokens'), donut(donutItems, { metric: 'tokens', tz: TZ, currency: 'CNY' })),
  1240));

// ④ 调用次数排行
write('rank.html', page('调用次数排行',
  tabsHtml('rank') + filtersHtml('30d', null)
  + card('模型调用排行', '总计 ' + all.reduce((s, m) => s + m.calls, 0).toLocaleString() + ' 次请求', seg([['模型', 'model'], ['供应商', 'provider'], ['项目', 'project']], 'model', true) + pills('count'), rankingBars(rankingRows, { metric: 'count', tz: TZ, currency: 'CNY' })),
  1240));

// ⑤ 模型对比表
write('compare.html', page('模型对比',
  tabsHtml('compare') + filtersHtml('30d', null)
  + '<div class="mca-body">' + card('模型对比', '点击行可筛选全看板', '', '<div class="mca-unsafe mca-compare-scroll">' + compareTable(compareRows, { tz: TZ, currency: 'CNY', sortKey: 'cost', sortDir: 'desc' }) + '</div>') + '</div>',
  1240, 'mca-compare-page', 'height:calc(100vh - 36px)'));

// ⑥ 会话明细：独立日志行 + 工作区 + 精确 usage 汇总（全部虚构）
const sessionDemo = [
  ['a83f21c9', 'D:/work/token-tally', 'deepseek / moonshot', 842, '18.6M', '86.2%', '¥286.40', '11-20 11:00'],
  ['b67e09a1', 'D:/work/agent-tools', 'anthropic', 516, '12.4M', '74.8%', '¥2,604.00', '11-20 10:00'],
  ['c48d77e2', 'D:/work/data-pipeline', 'openai / google', 388, '9.8M', '71.5%', '¥1,024.60', '11-20 09:00'],
  ['d92a10f4', 'D:/work/research-notes', 'zai / deepseek', 264, '7.2M', '89.1%', '¥92.80', '11-19 22:00'],
  ['e15b63c8', 'D:/work/web-frontend', 'byted / xai', 126, '3.6M', '68.4%', '¥58.20', '11-19 20:00'],
  ['f70c42d5', 'D:/work/model-evals', 'moonshot / deepseek', 94, '2.1M', '82.7%', '¥76.50', '11-19 18:00'],
];
const sessionRows = sessionDemo.map(([id, workspace, providers, requests, tokens, hit, cost, active]) => '<tr>'
  + '<td class="mca-session-id" title="演示会话 ' + id + '">' + id + '</td>'
  + '<td><span class="mca-ellipsis">' + workspace + '</span></td>'
  + '<td><span class="mca-ellipsis">' + providers + '</span></td>'
  + '<td class="num">' + requests + '</td><td class="num">' + tokens + '</td><td class="num">' + hit + '</td><td class="num">' + cost + '</td><td class="num">' + active + '</td></tr>').join('');
write('sessions.html', page('会话明细',
  tabsHtml('sessions') + filtersHtml('30d', null)
  + '<div class="mca-body">' + card('会话明细', '6 个独立会话；主会话与子会话按各自日志逐行', '<div class="mca-session-tools"><select class="mca-session-select" aria-label="筛选供应商"><option>全部供应商</option></select><select class="mca-session-select" aria-label="筛选工作区"><option>全部工作区</option></select><input class="mca-session-search" placeholder="搜索会话 / 工作区 / 供应商" aria-label="搜索会话"/><button class="mca-pill sm">导出 CSV</button></div>',
    '<div class="mca-insight-note">显示 6 / 6 个会话 · 全部可滚动查看</div><div class="mca-session-scroll"><div class="mca-table-wrap"><table class="mca-table"><thead><tr>' + ['会话', '工作区', '供应商', '请求', 'Tokens ↓', '缓存命中', '预估费用', '最近活跃'].map((x) => '<th role="button" tabindex="0">' + x + '</th>').join('') + '</tr></thead><tbody>' + sessionRows + '</tbody></table></div></div>') + '</div>',
  1240, 'mca-compare-page', 'height:calc(100vh - 36px)'));

console.log('all pages written to', outDir);
