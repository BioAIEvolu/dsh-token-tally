// 帧率 A/B 实测：热力图逐格动画(现状) vs 整组动画(提议)，在「消耗分布」完整布局下采样 rAF 帧间隔
import { chromium } from 'file:///D:/Project/DSH/dsh-md-studio/node_modules/playwright-core/index.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stackedBars, trendLines, donut, rankingBars, calendarHeatmap, compareTable } from '../src/client/charts.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = fs.readFileSync(path.join(root, 'src/client/index.js'), 'utf8');
const expr = (name) => {
  const line = src.split('\n').find((l) => l.trimStart().startsWith('const ' + name + ' ='));
  return new Function('return ' + line.trim().slice(('const ' + name + ' =').length).replace(/;\s*$/, ''))();
};
const CSS = expr('CSS');
const OVR = expr('CSS_OVERRIDES');

// ---- 演示数据（与 make-readme-shots 相同口径，确定性）----
function mulberry32(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const rnd = mulberry32(20261120);
const TZ = 8 * 3600;
const NOW = Math.floor(Date.UTC(2026, 10, 20, 4, 0, 0) / 1000);
const DAY = 86400;
const MODELS = [
  { provider: 'deepseek', model: 'deepseek-v4-pro', calls: 5200, tokAvg: 5200, price: 13.5 },
  { provider: 'anthropic', model: 'claude-opus-4-5-thinking', calls: 3100, tokAvg: 9800, price: 210 },
  { provider: 'moonshot', model: 'kimi-k2-thinking', calls: 2500, tokAvg: 7400, price: 39 },
  { provider: 'zai', model: 'glm-5.3', calls: 1900, tokAvg: 4300, price: 8 },
  { provider: 'google', model: 'gemini-2.5-pro', calls: 1200, tokAvg: 8600, price: 84 },
  { provider: 'openai', model: 'gpt-5.2-codex', calls: 640, tokAvg: 11200, price: 120 },
  { provider: 'byted', model: 'doubao-seed-1-6-thinking', calls: 310, tokAvg: 5100, price: 16 },
  { provider: 'xai', model: 'grok-4-fast', calls: 96, tokAvg: 3600, price: 12 },
];
const stacks = [];
for (let i = 29; i >= 0; i--) {
  const start = Math.floor((NOW - i * DAY + TZ) / DAY) * DAY - TZ;
  const di = 29 - i;
  const cells = [];
  for (const m of MODELS) {
    if (m.calls < 200 && rnd() < 0.45) continue;
    const calls = Math.max(1, Math.round((m.calls / 30) * (di % 7 >= 5 ? 0.42 : 1) * (0.65 + rnd() * 0.8)));
    const tokens = Math.round(calls * m.tokAvg * (0.8 + rnd() * 0.5));
    cells.push({ provider: m.provider, model: m.model, count: calls, tokens, cost: (tokens / 1e6) * m.price, priced: true });
  }
  stacks.push({ start, gran: 'day', cells });
}
const days = [];
for (let i = 370; i >= 0; i--) {
  const day = Math.floor((NOW - i * DAY + TZ) / DAY) * DAY - TZ;
  const di = 370 - i;
  const wave = 0.55 + 0.45 * Math.sin(di / 9) + 0.25 * Math.sin(di / 3.1);
  const growth = 0.35 + 0.65 * (di / 370);
  let tokens = 9e6 * wave * growth * (di % 7 >= 5 ? 0.42 : 1) * (0.6 + rnd() * 0.9);
  if (rnd() < 0.05) tokens = 0;
  days.push({ day, tokens: Math.max(0, Math.round(tokens)) });
}

const donutSvg = donut([...stacks.flatMap((b) => b.cells).reduce((acc, c) => {
  const a = acc.get(c.model) || { provider: c.provider, model: c.model, calls: 0, tokens: 0, cost: 0, priced: true };
  a.calls += c.count; a.tokens += c.tokens; a.cost += c.cost; acc.set(c.model, a);
  return acc;
}, new Map()).values()], { metric: 'tokens', compact: true, tz: TZ, currency: 'CNY', externalClock: true });

// heatMode: 'cell'（模拟旧实现：逐格 animClass，按 DOM 顺序还原列号）| 'group'（新实现：整组一次）
function heatSvg(mode) {
  const original = calendarHeatmap(days, { tz: TZ, now: NOW });
  if (mode === 'group') return original;
  // 旧实现模拟：charts.js 已改为整组动画，这里按 DOM 顺序把逐格类还原回去
  let idx = 0;
  return original.replace(/class="mca-h(\d)"/g, (m, lv) => {
    const col = Math.floor(idx / 7); idx++;
    return 'class="mca-h' + lv + ' mca-anim-heat mca-delay-' + Math.min(12, col) + '"';
  });
}

const tabs = '<div class="mca-tabs" role="tablist"><button class="mca-tab on">消耗分布</button><button class="mca-tab">调用趋势</button><button class="mca-tab">调用次数分布</button><button class="mca-tab">调用次数排行</button><button class="mca-tab">模型对比</button></div>';
const filters = '<div class="mca-filters"><div class="mca-toolbar-main"><div class="mca-seg"><button class="mca-seg-btn">今天</button><button class="mca-seg-btn">24H</button><button class="mca-seg-btn">7D</button><button class="mca-seg-btn on">30D</button><button class="mca-seg-btn">90D</button></div><div class="mca-seg mca-seg-sm"><button class="mca-seg-btn">小时</button><button class="mca-seg-btn on">天</button><button class="mca-seg-btn">月</button></div></div><div class="mca-toolbar-side"><button class="mca-settings-btn">费用设置</button></div></div>';
const kpis = '<div class="mca-kpis">' + [['预估费用', '¥ 1,284.60'], ['会话数', '312'], ['用量请求', '14,946'], ['计费 Tokens', '68.42M'], ['缓存命中率', '81.4%']].map(([l, v]) => '<div class="mca-kpi"><div class="mca-kpi-label">' + l + '</div><div class="mca-kpi-value">' + v + '</div></div>').join('') + '</div>';
const card = (title, sub, body) => '<div class="mca-card"><div class="mca-card-head"><div class="mca-card-title-wrap"><span class="mca-card-title">' + title + '</span><span class="mca-card-sub">' + sub + '</span></div></div>' + body + '</div>';
// 真实宿主：externalClock + mca-donut-grow + --progress:1（与 ui.js L497 一致）
const donutHost = '<div class="mca-donut-grow" style="--progress:1">' + donutSvg + '</div>';

const page = (heatMode) => `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
:root{--dsw-alias-bg-layer-1:#16181d;--dsw-alias-bg-layer-2:#1f232b;--dsw-alias-label-primary:#e8eaf0;--dsw-alias-label-secondary:#9aa2b1;--dsw-alias-border-l1:#2a2f3a}
body{background:#0d0f13;color:#e8eaf0;font-family:system-ui,sans-serif;margin:0;padding:16px 20px;width:1240px;box-sizing:border-box}
${CSS}
${OVR}
${heatMode === 'group' ? '.mca-heat-entrance{transform-box:fill-box;transform-origin:center;animation:mca-heat-in .52s ease-out both}' : ''}
</style></head><body class="mca-root">
${tabs}${filters}${kpis}
${card('模型消耗分布', '最近 30 天', stackedBars(stacks, { metric: 'tokens', tz: TZ, currency: 'CNY' }))}
${card('用量热力图', '最近 12 个月', heatSvg(heatMode))}
${card('模型消耗占比', '环形', donutHost)}
</body></html>`;

const browser = await chromium.launch({ executablePath: process.env.LOCALAPPDATA + '\\ms-playwright\\chromium-1254\\chrome-win64\\chrome.exe', headless: true });
async function measure(mode) {
  const page1 = await browser.newPage({ viewport: { width: 1280, height: 1800 } });
  const tmp = path.join(root, 'out', 'shots', 'perf-' + mode + '.html');
  fs.mkdirSync(path.dirname(tmp), { recursive: true });
  fs.writeFileSync(tmp, page(mode));
  await page1.goto('file:///' + tmp.replace(/\\/g, '/'));
  // 采样 90 帧 rAF 间隔（动画窗口 0-1.5s）
  const deltas = await page1.evaluate(() => new Promise((res) => {
    const d = []; let last = performance.now(); let n = 0;
    function tick(t) { d.push(t - last); last = t; if (++n >= 90) return res(d); requestAnimationFrame(tick); }
    requestAnimationFrame(tick);
  }));
  const drops = deltas.filter((x) => x > 32).length;
  const stalls = deltas.filter((x) => x > 100).length;
  const p95 = [...deltas].sort((a, b) => a - b)[Math.floor(deltas.length * 0.95)] || 0;
  const avg = deltas.reduce((s, x) => s + x, 0) / deltas.length;
  console.log(`${mode.padEnd(6)} avg=${avg.toFixed(1)}ms p95=${p95.toFixed(0)}ms >32ms:${drops} >100ms:${stalls} max=${Math.max(...deltas).toFixed(0)}ms`);
  await page1.close();
}
await measure('cell');
await measure('group');
await measure('cell');
await measure('group');
await browser.close();
