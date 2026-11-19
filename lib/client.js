window.__ModuleLoader__.load({
  id: "dsh-token-tally",
  factory: (require) => {
    var module = { exports: {} };
    var React = require("react");
// 客户端格式化工具（纯函数；构建时合并进 lib/client.js）
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** CSV 单元格转义；文本公式前缀加 apostrophe，避免表格软件执行注入公式。 */
function csvCell(value) {
  let text = String(value ?? '');
  if (typeof value === 'string' && /^\s*[=+\-@]/.test(text)) text = "'" + text;
  return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

function fmtInt(n) { return Math.round(n || 0).toLocaleString('en-US'); }

function fmtTokens(n) {
  n = n || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(Math.round(n));
}

function fmtCost(n, currency = 'CNY') {
  if (n == null) return '未配置';
  const symbol = String(currency).toUpperCase() === 'USD' ? '$' : '¥';
  return symbol + (n >= 100 ? n.toFixed(2) : n.toFixed(2));
}

function fmtPct(x) { return x == null ? '—' : (x * 100).toFixed(1) + '%'; }

// 面向用户的模型名称：保留原始值用于筛选/查询，仅在展示层翻译内部事件标签。
function displayModelName(model) {
  const raw = String(model ?? '');
  // 内部 compaction 事件可能带 provider/ 前缀；只翻译末尾的模型标识，避免破坏筛选用原值。
  const match = raw.match(/^(.*\/)?(?:\(compaction\)|compaction)$/i);
  return match ? (match[1] || '') + '上下文压缩' : raw;
}

function fmtMs(ms) {
  if (ms == null) return '—';
  if (ms < 1000) return Math.round(ms) + 'ms';
  return (ms / 1000).toFixed(ms < 10000 ? 2 : 1) + 's';
}

function fmtSpeed(x) { return x == null ? '—' : x.toFixed(1) + ' t/s'; }

function fmtDay(ts, gran, tz) {
  const d = new Date((ts + (tz | 0)) * 1000);
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  if (gran === 'minute') return mm + '-' + dd + ' ' + String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0');
  if (gran === 'hour') return mm + '-' + dd + ' ' + String(d.getUTCHours()).padStart(2, '0') + ':00';
  if (gran === 'month') return d.getUTCFullYear() + '-' + mm;
  return mm + '-' + dd;
}

function fmtFullDay(ts, tz) {
  const d = new Date((ts + (tz | 0)) * 1000);
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
}

// 手写 SVG 图表（纯字符串构建，无第三方依赖；tooltips 用原生 <title>）


// 配色对齐 dsh-context：Tailwind 500 分类色（蓝/青/琥珀/绿/红/紫/粉/紫罗兰/靛/橙）+ 两个中性色。
// 通过 CSS 变量注入（与 dsh-context 的 var(--color-*) 用法一致），深浅主题都稳定。
const PALETTE = [
  'var(--mca-c1)', 'var(--mca-c2)', 'var(--mca-c3)', 'var(--mca-c4)', 'var(--mca-c5)', 'var(--mca-c6)',
  'var(--mca-c7)', 'var(--mca-c8)', 'var(--mca-c9)', 'var(--mca-c10)', 'var(--mca-c11)', 'var(--mca-c12)',
];
const NEUTRAL_COLOR = 'var(--mca-c11)';
const W = 920; const H = 260;
const M = { l: 60, r: 10, t: 26, b: 30 };

// SVG 动效由 CSS 驱动：首次挂载时从轻微位移/透明度自然进入；
// prefers-reduced-motion 由宿主 CSS 关闭，避免无障碍用户被强制动画。
function animClass(kind, index = 0) {
  return 'mca-anim-' + kind + ' mca-delay-' + (Math.min(12, Math.max(0, index)));
}
function modelLabel(model) { return displayModelName(model); }

function modelColor(i) { return PALETTE[((i % PALETTE.length) + PALETTE.length) % PALETTE.length]; }

// 跨图表颜色一致性：按模型名哈希确定性取色 + 同图内冲突探测，避免一张图里出现多个近似蓝。
// 分配顺序固定为「模型名排序」，因此同一批模型在不同图里拿到的颜色一致，与数据出现顺序无关。
const COLOR_KEY_CACHE = new Map();
function modelHash(key) {
  let h = COLOR_KEY_CACHE.get(key);
  if (h === undefined) {
    const s = String(key);
    h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    COLOR_KEY_CACHE.set(key, h);
  }
  return h;
}

 /** 为一组模型构造取色器：同图内互不重复，跨图（同一批模型）保持一致。
 * 只在前 10 个系列色槽里分配，c11/c12 保留给「其他」等中性用途。 */
const SERIES_SLOTS = 10;
function makeColorizer(keys) {
  const slots = new Map();
  const used = new Set();
  const names = [...new Set(keys)].sort();
  for (const name of names) {
    let slot = ((modelHash(name) % SERIES_SLOTS) + SERIES_SLOTS) % SERIES_SLOTS;
    // 线性探测到下一个空槽；色板用尽后允许重复
    for (let probe = 0; probe < SERIES_SLOTS && used.has(slot) && used.size < SERIES_SLOTS; probe++) {
      slot = (slot + 1) % SERIES_SLOTS;
    }
    used.add(slot);
    slots.set(name, slot);
  }
  return (key) => {
    const slot = slots.get(key);
    if (slot !== undefined) return PALETTE[slot];
    return modelColor(((modelHash(key) % SERIES_SLOTS) + SERIES_SLOTS) % SERIES_SLOTS);
  };
}

function modelColorKey(key) {
  return modelColor(((modelHash(key) % PALETTE.length) + PALETTE.length) % PALETTE.length);
}

function cellValue(cell, metric) {
  if (metric === 'cost') return cell.priced ? cell.cost : 0;
  if (metric === 'count') return cell.count;
  return cell.tokens;
}
function cellText(cell, metric, currency) {
  if (metric === 'cost') return cell.priced ? fmtCost(cell.cost, currency) : '未配置';
  if (metric === 'count') return fmtInt(cell.count) + ' 次';
  return fmtTokens(cell.tokens) + ' tok';
}

function emptyChart() {
  return '<div class="mca-empty" role="status">当前范围暂无数据</div>';
}

function currencyOf(opts, rows) {
  const hit = rows.find((r) => r && r.currency);
  return opts.currency || (hit && hit.currency) || 'CNY';
}

function niceMax(v) {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  return Math.ceil(v / p) * p;
}

function fmtAxis(v, metric, currency) {
  if (metric === 'cost') return fmtCost(v, currency);
  if (metric === 'count') return fmtInt(v);
  return fmtTokens(v);
}

function stackTooltip(b, metric, tz, currency) {
  const title = fmtDay(b.start, b.gran || 'day', tz);
  const rows = b.cells.map((c) => '<div><b>' + esc(modelLabel((c.provider ? c.provider + '/' : '') + c.model)) + '</b> · ' + esc(cellText(c, metric, currency)) + '</div>').join('');
  return '<div class="mca-stack-tip"><strong>' + esc(title) + '</strong>' + rows + '</div>';
}

// 图例文本宽度估算：中日韩全角字符按 12px，其余 6.6px，避免中文标签相互挤在一起。
const LEGEND_ROW_H = 17;
const LEGEND_MAX = 12;
function legendTextWidth(label) {
  let w = 0;
  for (const ch of String(label)) {
    w += /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]/.test(ch) ? 12 : 6.6;
  }
  return Math.min(180, Math.ceil(w) + 8);
}
/** 网格布局图例：返回 {rows, svg}，固定3列对齐，长尾合并为「其他 N 个模型」。 */
function buildLegend(entries, opts = {}) {
  const startY = opts.startY ?? 6;
  const maxItems = opts.maxItems ?? LEGEND_MAX;
  const shown = entries.length > maxItems ? entries.slice(0, maxItems - 1) : entries;
  const items = shown.slice();
  if (entries.length > shown.length) items.push(['其他 ' + (entries.length - shown.length) + ' 个模型', NEUTRAL_COLOR]);
  
  const cols = 3; // 固定3列
  const colWidth = (W - M.l - M.r) / cols;
  let svg = '';
  
  items.forEach(([label, fill], i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = M.l + col * colWidth;
    const y = startY + row * LEGEND_ROW_H;
    svg += '<rect class="' + animClass('legend', i) + '" x="' + x.toFixed(1) + '" y="' + y + '" width="9" height="9" rx="2" style="fill:' + fill + '"/><text class="' + animClass('legend', i) + ' mca-leg" x="' + (x + 13).toFixed(1) + '" y="' + (y + 9) + '">' + esc(label) + '</text>';
  });
  
  const rows = Math.ceil(items.length / cols);
  return { rows, svg, startY };
}

function xLabels(stacks, tz, geom) {
  const n = stacks.length;
  if (!n) return '';
  const step = Math.max(1, Math.ceil(n / 10));
  let out = '';
  for (let i = 0; i < n; i += step) {
    const x = geom ? geom.originX + (i + 0.5) * geom.slot : M.l + ((i + 0.5) / n) * (W - M.l - M.r);
    out += '<text x="' + x + '" y="' + (H - 8) + '" text-anchor="middle" class="mca-ax">' + esc(fmtDay(stacks[i].start, stacks[i].gran || 'day', tz)) + '</text>';
  }
  return out;
}

/** 消耗分布：按模型堆叠柱，支持绝对值 / 100% 占比切换 */
function stackedBars(stacks, opts = {}) {
  if (!stacks.some((b) => b.cells && b.cells.length)) return emptyChart();
  const metric = opts.metric || 'tokens';
  const percentMode = !!opts.percentMode;
  const tz = opts.tz | 0;
  const currency = currencyOf(opts, stacks.flatMap((b) => b.cells));
  const modelNames = [...new Set(stacks.flatMap((b) => b.cells.map((c) => c.model)))];
  // 图例：按模型总量降序，最多 12 项，长尾合并为「其他」；先算布局再定图表区起点。
  const totalsByModel = new Map();
  for (const b of stacks) for (const c of b.cells) totalsByModel.set(c.model, (totalsByModel.get(c.model) || 0) + cellValue(c, metric));
  const rankedModels = [...modelNames].sort((a, b) => (totalsByModel.get(b) || 0) - (totalsByModel.get(a) || 0));
  // 颜色只按进入图例的模型分配（柱体中未入图例的长尾模型回退到哈希色）
  const color = makeColorizer(rankedModels.slice(0, LEGEND_MAX));
  const legend = buildLegend(rankedModels.map((m) => [modelLabel(m), color(m)]));
  const chartTop = M.t + legend.rows * LEGEND_ROW_H + 6;
  const plotW = W - M.l - M.r; const plotH = H - chartTop - M.b;
  const val = (c) => cellValue(c, metric);
  const maxTotal = Math.max(1, ...stacks.map((b) => b.cells.reduce((s, c) => s + val(c), 0)));
  const yMax = percentMode ? 1 : niceMax(maxTotal);
  // 生长动画挂在整根柱子的 <g> 上：transform-origin=柱子底部，所有分层一起从基线连续生长。
  // 悬停高亮只作用于单个色块（.mca-bar-seg），不再整柱高亮。
  let bars = ''; let cols = '';
  const n = Math.max(1, stacks.length);
  // 桶少时柱宽放大并整体居中，避免 4 根柱被拉满整幅画布显得空旷。
  const maxSpan = 104;
  const slot = n * maxSpan <= plotW ? maxSpan : plotW / n;
  const originX = M.l + (plotW - slot * n) / 2;
  const barW = Math.max(6, Math.min(72, slot * 0.6));
  stacks.forEach((b, bi) => {
    const total = b.cells.reduce((s, c) => s + val(c), 0);
    const x = originX + (bi + 0.5) * slot - barW / 2;
    let y = chartTop + plotH;
    let segs = '';
    for (const c of b.cells) {
      const v = val(c);
      const hgt = percentMode ? (total > 0 ? (v / total) * plotH : 0) : (v / yMax) * plotH;
      if (hgt <= 0) continue;
      y -= hgt;
      const fill = color(c.model);
      const pctTxt = total > 0 ? ' (' + ((v / total) * 100).toFixed(1) + '%)' : '';
      const modelKey = c.provider ? c.provider + '\u0000' + c.model : c.model;
      segs += '<rect class="mca-bar-seg" data-provider="' + esc(c.provider || '') + '" data-model="' + esc(c.model) + '" x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + barW.toFixed(1) + '" height="' + Math.max(0.5, hgt).toFixed(1) + '" rx="1.5" style="fill:' + fill + '"><title>' + esc(fmtDay(b.start, b.gran || 'day', tz)) + ' · ' + esc(modelLabel(c.model)) + '\n' + esc(cellText(c, metric, currency)) + esc(pctTxt) + '</title></rect>';
    }
    if (segs) bars += '<g class="' + animClass('bar', bi) + '">' + segs + '</g>';
    cols += '<rect class="mca-stack-hit" x="' + (originX + bi * slot).toFixed(1) + '" y="' + M.t + '" width="' + slot.toFixed(1) + '" height="' + plotH + '" fill="transparent"><title>' + esc(fmtDay(b.start, b.gran || 'day', tz)) + '\n合计 ' + (percentMode ? esc(fmtPct(total > 0 ? 1 : 0)) : esc(metric === 'cost' ? fmtCost(total, currency) : metric === 'count' ? fmtInt(total) : fmtTokens(total))) + '</title></rect>';
  });
  let grid = '';
  for (let g = 0; g <= 4; g++) {
    const gy = chartTop + plotH - (g / 4) * plotH;
    const gv = (g / 4) * yMax;
    grid += '<line x1="' + M.l + '" y1="' + gy + '" x2="' + (W - M.r) + '" y2="' + gy + '" class="mca-grid"/>';
    grid += '<text x="' + (M.l - 6) + '" y="' + (gy + 4) + '" text-anchor="end" class="mca-ax">' + esc(percentMode ? (g * 25) + '%' : fmtAxis(gv, metric, currency)) + '</text>';
  }
  // 图例（流式换行）
  return '<svg viewBox="0 0 ' + W + ' ' + H + '" class="mca-svg" role="img" data-gran="' + esc(stacks[0] && stacks[0].gran || '') + '">' + grid + cols + bars + xLabels(stacks, tz, { originX, slot }) + legend.svg + '</svg>';
}

/** 调用趋势：每模型折线 */
function trendLines(stacks, opts = {}) {
  if (!stacks.some((b) => b.cells && b.cells.length)) return emptyChart();
  const tz = opts.tz | 0;
  const metric = opts.metric || 'count';
  const currency = currencyOf(opts, stacks.flatMap((b) => b.cells));
  const color = makeColorizer(stacks.flatMap((b) => b.cells.map((c) => c.model)));
  const plotW = W - M.l - M.r;
  const models = new Map();
  const valueOf = (c) => metric === 'tokens' ? c.tokens : metric === 'cost' ? (c.priced ? c.cost : 0) : c.count;
  stacks.forEach((b, bi) => { for (const c of b.cells) { if (!models.has(c.model)) models.set(c.model, new Array(stacks.length).fill(null)); models.get(c.model)[bi] = valueOf(c); } });
  const maxV = Math.max(1, ...[...models.values()].flat().filter((v) => v != null));
  const yMax = niceMax(maxV);
  // 图例先算布局（流式换行 + 长尾合并），绘图区从图例下方开始，避免溢出或压住折线。
  const legend = buildLegend([...models.keys()].map((m) => [modelLabel(m), color(m)]));
  const plotTop = M.t + legend.rows * LEGEND_ROW_H + 6;
  const plotH = H - plotTop - M.b;
  let body = '';
  for (let g = 0; g <= 4; g++) {
    const gy = plotTop + plotH - (g / 4) * plotH;
    body += '<line x1="' + M.l + '" y1="' + gy + '" x2="' + (W - M.r) + '" y2="' + gy + '" class="mca-grid"/>';
    body += '<text x="' + (M.l - 6) + '" y="' + (gy + 4) + '" text-anchor="end" class="mca-ax">' + esc(fmtAxis((g / 4) * yMax, metric, currency)) + '</text>';
  }
  let li = 0;
  for (const [model, arr] of models) {
    const fill = color(model);
    const pts = [];
    // 缺桶补零：线段从左到右横贯整个窗口（对齐 newapi 的连续曲线），断档处贴 0 而非跳线。
    arr.forEach((v, bi) => {
      const vv = v == null ? 0 : v;
      const x = M.l + ((bi + 0.5) / Math.max(1, stacks.length)) * plotW;
      const y = plotTop + plotH - (vv / yMax) * plotH;
      pts.push([x, y]);
    });
    if (pts.length) {
      // pathLength 归一化到 100 + 线性 dash 绘制：笔尖位置 = 时间进度 × 线长，
      // 圆点延迟即「笔尖经过该点的时刻」，点与线严格同步（不再点先冒出来等线）。
      body += '<polyline class="mca-anim-line" pathLength="100" fill="none" style="stroke:' + fill + '" points="' + pts.map((p) => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ') + '"/>';
      // 加宽透明命中线：线体任意位置悬浮都能看到模型提示（与柱状/环形图的悬浮信息一致）。
      // 放在圆点之前：圆点保持最上层，自身悬浮放大与提示不被命中线遮挡。
      const total = arr.reduce((s, v) => s + (v ?? 0), 0);
      const totalText = metric === 'tokens' ? fmtTokens(total) : metric === 'cost' ? fmtCost(total, currency) : fmtInt(total);
      body += '<polyline class="mca-line-hit" fill="none" stroke="transparent" stroke-width="12" stroke-linejoin="round" stroke-linecap="round" points="' + pts.map((p) => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ') + '"><title>' + esc(modelLabel(model)) + ' · 合计 ' + esc(totalText) + '</title></polyline>';
      const drawMs = 900;
      for (const [pi, [x, y]] of pts.entries()) {
        // 零值点不渲染：大量空桶模型在 0 轴线上堆几百个动画节点（卡顿来源），且视觉无信息量
        if (!(arr[pi] > 0)) continue;
        const delay = pts.length > 1 ? Math.round((pi / (pts.length - 1)) * drawMs) : 0;
        body += '<circle class="mca-anim-point" cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="2.5" style="fill:' + fill + ';animation-delay:' + delay + 'ms"><title>' + esc(modelLabel(model)) + '</title></circle>';
      }
    }
    li++;
  }
  return '<svg viewBox="0 0 ' + W + ' ' + H + '" class="mca-svg" role="img">' + body + xLabels(stacks, tz) + legend.svg + '</svg>';
}

/** 环形图（调用次数分布 / Token 分布）：左侧图例列表 + 环形引出线标签（参考 newapi）。
 * opts.showLegend=false 时只画环（与堆叠柱图例并列时避免重复长列表）。 */
function donut(items, opts = {}) {
  const metric = opts.metric || 'count';
  const currency = currencyOf(opts, items);
  const val = (it) => (metric === 'tokens' ? it.tokens : metric === 'cost' ? (it.priced ? it.cost : 0) : (it.calls || 0));
  const total = items.reduce((s, it) => s + val(it), 0);
  const denominator = total || 1;
  const centerLabel = metric === 'tokens' ? '总 Tokens' : metric === 'cost' ? '总费用' : '总次数';
  const pricedCost = items.some((it) => it.priced) ? items.reduce((s, it) => s + (it.priced ? it.cost : 0), 0) : null;
  const centerVal = metric === 'cost' ? fmtCost(items.length ? pricedCost : 0, currency) : metric === 'tokens' ? fmtTokens(total) : fmtInt(total);

  // 切片：按值降序，最多 10 项，长尾合并为「其他 N 个模型」
  const MAX = 10;
  const sorted = [...items].sort((a, b2) => val(b2) - val(a));
  const head = sorted.slice(0, MAX);
  const tail = sorted.slice(MAX);
  const tailSum = tail.reduce((s, it) => s + val(it), 0);
  const color = makeColorizer(head.map((it) => it.model));
  const slices = head.map((it) => ({
    // 引线标签只显示模型名（provider 前缀过长会压环）；完整标识放 tooltip
    name: modelLabel(it.model),
    fullName: modelLabel((it.provider ? it.provider + '/' : '') + it.model),
    v: val(it), it, fill: color(it.model), priced: it.priced,
  }));
  if (tail.length) slices.push({ name: '其他 ' + tail.length + ' 个模型', fullName: '其他 ' + tail.length + ' 个模型', v: tailSum, it: { model: '__other__' }, fill: NEUTRAL_COLOR, priced: true });

  const TAU = Math.PI * 2;
  let acc = 0;
  const withAngles = slices.map((s, i) => {
    const frac = s.v / denominator;
    const start = acc; acc += frac;
    const mid = start + frac / 2;
    return { ...s, i, frac, start, mid, localMid: mid * TAU };
  });

  const NOON = -Math.PI / 2; // 12 点钟方向

  // 扇区 = stroke-dasharray 圆弧，整圆顺时针单时间线生长（参考 new-api）：
  // 所有扇区共用 .mca-donut-grow 上唯一一段 --progress（0→1）插值——先快后慢只发生一次，
  // 扇区端只用 calc(clamp(...)) 按「已画总弧长 - 本段累计起始弧长」计算描边长度，接缝处笔尖速度连续，
  // 不再逐段「刹车再起步」。缝隙仍按 1° 修剪但封顶为该段弧长的一半（0.02% 级小扇区也可见）。
  // 静态兜底：g 上内联 --progress:1，动画被禁/未跑/reduced-motion 时直接呈现完整环。
  
  function arcMarkup(ccx, ccy, radius, ringW) {
    const circumference = TAU * radius;
    const positive = withAngles.filter(s => s.frac > 0);
    const gapLength = positive.length > 1 ? circumference / 360 : 0;
    // 几何起点包含留白；动画进度只走有颜色的弧长，使换色和闭环都没有空走的帧。
    const lengths = positive.map(s => {
      const length = s.frac * circumference;
      return length - Math.min(gapLength, length / 2);
    });
    const paintTotal = lengths.reduce((sum, length) => sum + length, 0);
    let painted = 0;
    let arcs = '';
    positive.forEach((s, index) => {
      const segLen = lengths[index];
      const paintStart = painted;
      painted += segLen;
      const offsetLength = s.start * circumference;

      const pop = 6;
      const dir = s.localMid + NOON;
      const dx = Math.cos(dir) * pop;
      const dy = Math.sin(dir) * pop;
      const valueText = metric === 'cost' ? (s.it.priced ? fmtCost(s.v, currency) : '未配置') : fmtInt(s.v);

      // 不带内联 animation：唯一时间线在插件级 CSS（.mca-donut-grow 的 --progress keyframes），
      // 避免逐扇区 keyframes 在多图同屏时同名冲突互相覆盖。
      arcs += '<g class="mca-pop" style="--dx:' + dx.toFixed(1) + ';--dy:' + dy.toFixed(1) + '">' +
        '<circle tabindex="0" class="mca-donut-arc" ' +
        'data-provider="' + esc(s.it.provider || '') + '" data-model="' + esc(s.it.model) + '" ' +
        'cx="' + ccx + '" cy="' + ccy + '" r="' + radius + '" ' +
        'fill="none" stroke="' + s.fill + '" stroke-width="' + ringW + '" ' +
        'stroke-linecap="butt" ' +
        'stroke-dashoffset="' + (-offsetLength).toFixed(2) + '" ' +
        'transform="rotate(-90 ' + ccx + ' ' + ccy + ')" ' +
        'stroke-dasharray="' + segLen.toFixed(6) + ' ' + circumference.toFixed(6) + '" ' +
        'style="--paint-start:' + paintStart.toFixed(6) + 'px;--paint-total:' + paintTotal.toFixed(6) + 'px;--seg-len:' + segLen.toFixed(6) + 'px;--circ:' + circumference.toFixed(6) + 'px;color:' + s.fill + '">' +
        '<title>' + esc(s.fullName) + ': ' + esc(valueText) + ' (' + (s.frac * 100).toFixed(1) + '%)</title>' +
        '</circle></g>';
    });
    // The mounted panel owns the clock outside the replaceable SVG. Standalone
    // consumers still get the same single sweep with a complete static fallback.
    return (opts.externalClock ? '<g>' : '<g class="mca-donut-grow" style="--progress:1">') + arcs + '</g>';
  }

  // 紧凑模式（与堆叠柱并排的侧栏）：只画环与中心总计
  if (opts.compact) {
    const S = 240; const ccx = 120; const ccy = 120;
    return '<div class="mca-donut-wrap"><svg viewBox="0 0 ' + S + ' ' + S + '" class="mca-svg mca-donut">' + arcMarkup(ccx, ccy, 76, 40, 4) +
      '<text x="' + ccx + '" y="' + (ccy - 4) + '" text-anchor="middle" class="mca-center-v">' + esc(centerVal) + '</text>' +
      '<text x="' + ccx + '" y="' + (ccy + 18) + '" text-anchor="middle" class="mca-center-l">' + esc(centerLabel) + '</text></svg></div>';
  }

  // 完整模式几何：680x320，环心 cx=340 居中；引线学 dsh-context 短线风格——
  // 起点贴住环外缘 → 短径向段 → 一小截水平段，文字紧贴线端向外生长（不再拉到固定文字带）；
  // 超宽按宽度估算截断加省略号，完整名称保留在 <title>。
  const W3 = 680; const H3 = 320;
  const cx = 340; const cy = 160; const r = 84; const sw = 26;
  const rOut = r + sw / 2 + 6;           // 引线起点：贴住环外缘（短线风格）
  const kneeOff = r + sw / 2 + 18;       // 肘点：短径向段终点，环外 18
  const LEADER_RUN = 14;                 // 水平段长度：线端即文字锚点旁
  const TEXT_MAX = 150;                  // 标签最大宽度（viewBox 单位）
  const MIN_GAP = 18;                    // 相邻标签最小间距（≈12px 字号行高）
  const topLimit = 26; const bottomLimit = H3 - 26;

  // 标签宽度估算（viewBox 单位）：CJK 全角 12px、其余 6.6px（与 legendTextWidth 同口径）
  function labelTextWidth(label) {
    let w = 0;
    for (const ch of String(label)) w += /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]/.test(ch) ? 12 : 6.6;
    return w;
  }
  // 截断到文字带宽度并加省略号；完整名称在扇区/引线的 <title> 里
  function truncateToWidth(label, maxW) {
    const s = String(label);
    if (labelTextWidth(s) <= maxW) return s;
    let out = '';
    let w = 6.6; // 预留省略号宽度
    for (const ch of s) {
      const cw = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]/.test(ch) ? 12 : 6.6;
      if (w + cw > maxW) break;
      out += ch; w += cw;
    }
    return out + '…';
  }

  // 引线标签：左右分组（12 点钟归右侧），组内按自然外缘 y 排序后做
  // 「前向推挤（每项 y ≥ 前项 y + MIN_GAP）→ 底部钳制 → 后向回推 → 顶部钳制」，
  // 代替旧的均匀铺满：引线更短、不交叉，小切片聚簇时文字也永不互相叠。
  const left = withAngles.filter((s) => Math.cos((s.mid * TAU) - Math.PI / 2) < 0);
  const right = withAngles.filter((s) => Math.cos((s.mid * TAU) - Math.PI / 2) >= 0);
  const place = (group, side) => {
    if (!group.length) return [];
    const theta = (s) => (s.mid * TAU) - Math.PI / 2;
    const ordered = [...group].sort((a, b2) => Math.sin(theta(a)) - Math.sin(theta(b2)));
    const ys = ordered.map((s) => cy + Math.sin(theta(s)) * rOut);
    for (let k = 1; k < ys.length; k++) ys[k] = Math.max(ys[k], ys[k - 1] + MIN_GAP); // 前向推挤
    if (ys[ys.length - 1] > bottomLimit) { // 底部钳制 + 后向回推
      ys[ys.length - 1] = bottomLimit;
      for (let k = ys.length - 2; k >= 0; k--) ys[k] = Math.min(ys[k], ys[k + 1] - MIN_GAP);
    }
    for (let k = 0; k < ys.length; k++) ys[k] = Math.max(ys[k], topLimit); // 顶部钳制
    return ordered.map((s, k) => {
      const y = ys[k];
      const th = theta(s);
      const px = cx + Math.cos(th) * rOut;
      const py = cy + Math.sin(th) * rOut;
      const kneeX = side === 'left' ? cx - kneeOff : cx + kneeOff;
      const lineEndX = side === 'left' ? kneeX - LEADER_RUN : kneeX + LEADER_RUN; // 短水平段：文字紧贴线端
      const anchorX = side === 'left' ? lineEndX - 4 : lineEndX + 4;
      const textAnchor = side === 'left' ? 'end' : 'start';
      // 引线三段：环外缘点(px,py) → 肘点(kneeX,y) → 线端点(lineEndX,y)；截断标签的完整名称放引线 <title>
      const line = '<polyline class="mca-donut-leader" points="' + [px, py, kneeX, y, lineEndX, y].map((v) => v.toFixed(1)).join(' ') + '" style="stroke:' + s.fill + '"><title>' + esc(s.fullName) + '</title></polyline>';
      const text = '<text class="mca-donut-label" x="' + anchorX.toFixed(1) + '" y="' + (y + 4).toFixed(1) + '" text-anchor="' + textAnchor + '" style="fill:' + s.fill + '">' + esc(truncateToWidth(s.name, TEXT_MAX)) + '</text>';
      return { line, text };
    });
  };
  const leftPlaced = place(left, 'left');
  const rightPlaced = place(right, 'right');

  const svg = '<svg viewBox="0 0 ' + W3 + ' ' + H3 + '" class="mca-svg mca-donut">' + arcMarkup(cx, cy, r, sw, 4) +
    leftPlaced.map((p) => p.line).join('') + rightPlaced.map((p) => p.line).join('') +
    leftPlaced.map((p) => p.text).join('') + rightPlaced.map((p) => p.text).join('') +
    '<text x="' + cx + '" y="' + (cy - 4) + '" text-anchor="middle" class="mca-center-v">' + esc(centerVal) + '</text>' +
    '<text x="' + cx + '" y="' + (cy + 18) + '" text-anchor="middle" class="mca-center-l">' + esc(centerLabel) + '</text></svg>';
  return '<div class="mca-donut-wrap mca-donut-wide">' + svg + '</div>';
}

/** 调用次数排行（垂直柱 + 倾斜模型名 + 底部图例，参考 newapi） */
function rankingBars(rows, opts = {}) {
  if (!rows.length) return emptyChart();
  const metric = opts.metric || 'count';
  const currency = currencyOf(opts, rows);
  const val = (r) => (metric === 'tokens' ? r.totalTokens : metric === 'cost' ? (r.priced ? r.cost : 0) : r.calls);
  const fmt = (v) => (metric === 'tokens' ? fmtTokens(v) : metric === 'cost' ? fmtCost(v, currency) : fmtInt(v));
  const sorted = [...rows].sort((a, b2) => val(b2) - val(a)).slice(0, 12);
  const color = makeColorizer(sorted.map((r) => r.model));
  const legendItems = sorted.map((r) => [modelLabel((r.provider ? r.provider + '/' : '') + r.model), color(r.model)]);

  const W4 = 920;
  const top = 26; const plotH = 200; const left = 56; const right = 16;
  const legendMeasure = buildLegend(legendItems, { startY: 0 });
  const legendH = legendMeasure.rows * LEGEND_ROW_H;
  const labelBand = 12; // 移除柱子标签后只需要底部图例的空间
  const H4 = top + plotH + labelBand + legendH + 12;
  const legend = buildLegend(legendItems, { startY: H4 - legendH - 6 });

  const maxV = Math.max(1, ...sorted.map(val));
  const yMax = niceMax(maxV);
  const baseline = top + plotH;
  const plotW = W4 - left - right;
  const n = sorted.length;
  const slot = plotW / n;
  const barW = Math.max(10, Math.min(58, slot * 0.58));

  let grid = '';
  for (let g = 0; g <= 4; g++) {
    const gy = baseline - (g / 4) * plotH;
    const gv = (g / 4) * yMax;
    grid += '<line x1="' + left + '" y1="' + gy.toFixed(1) + '" x2="' + (W4 - right) + '" y2="' + gy.toFixed(1) + '" class="mca-grid"/>';
    grid += '<text x="' + (left - 8) + '" y="' + (gy + 4).toFixed(1) + '" text-anchor="end" class="mca-ax">' + esc(fmtAxis(gv, metric, currency)) + '</text>';
  }

  let bars = '';
  sorted.forEach((r, i) => {
    const v = val(r);
    const h = Math.max(1, (v / yMax) * plotH);
    const x = left + (i + 0.5) * slot - barW / 2;
    const name = modelLabel((r.provider ? r.provider + '/' : '') + r.model);
    const fill = color(r.model);
    const y = baseline - h;
    bars += '<g class="' + animClass('bar', i) + '"><rect class="mca-bar-seg" data-provider="' + esc(r.provider) + '" data-model="' + esc(r.model) + '" tabindex="0" x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + barW.toFixed(1) + '" height="' + h.toFixed(1) + '" rx="3" style="fill:' + fill + '"><title>' + esc(name) + ' · ' + esc(fmt(v)) + '</title></rect></g>';
  });

  return '<svg viewBox="0 0 ' + W4 + ' ' + H4 + '" class="mca-svg mca-rank-svg" role="img">' + grid + bars + legend.svg + '</svg>';
}

const HEAT_LEVELS = [1e5, 1e6, 1e7, 5e7]; // ≥1e5 / ≥1e6 / ≥1e7 / ≥5e7 → h1..h4
const HEAT_MONTHS = 12; // 视觉标题/查询范围按 12 个月

function alignWeekStart(tsSec, tz) {
  const DAY = 86400;
  const local = tsSec + (tz | 0);
  const dayStart = local - (local % DAY);
  const dayIndex = Math.floor(dayStart / DAY);
  const dow = (dayIndex + 3) % 7; // 周一=0
  return dayStart - dow * DAY - (tz | 0);
}

/** 12 个月日历热力图：保留每一天的历史数据，并按本地日期对齐。周一开头（国内习惯）。 */
const MONTHS_CN = ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'];
const ROW_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

function calendarHeatmap(days, opts = {}) {
  const tz = opts.tz | 0;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const map = new Map();
  for (const d of days || []) map.set(d.day, d.tokens || 0);
  const DAY = 86400;
  const endDay = Math.floor((now + tz) / DAY) * DAY - tz;
  const endDayIndex = Math.floor((endDay + tz) / DAY);
  const endDow = (endDayIndex + 3) % 7; // 周一=0（周日收尾，符合国内习惯）
  // 53 列完整周：从起始周一到当前周日，保证首尾周一都存在。
  const daysInRange = 53 * 7;
  const startDay = endDay - endDow * DAY - (53 - 1) * 7 * DAY;
  const gridEndDay = startDay + daysInRange * DAY - DAY;
  void gridEndDay;
  const CS = 9; const GAP = 3;
  // 左侧给完整星期名留出宽度，顶部/底部独立留白避免文字和格子相撞。
  const X0 = 58; const Y0 = 34; const LABEL_GAP = 12;
  const cols = Math.ceil(daysInRange / 7);
  const W2 = X0 + cols * (CS + GAP) + 28;
  const H2 = Y0 + 7 * (CS + GAP) + 34;
  let cells = '';
  for (let i = 0; i < daysInRange; i++) {
    const day = startDay + i * DAY;
    const col = Math.floor(i / 7); const row = i % 7;
    const tokens = map.get(day) || 0;
    let lv = 0;
    for (let k = HEAT_LEVELS.length - 1; k >= 0; k--) if (tokens >= HEAT_LEVELS[k]) { lv = k + 1; break; }
    const x = X0 + col * (CS + GAP); const y = Y0 + row * (CS + GAP);
    cells += '<rect x="' + x + '" y="' + y + '" width="' + CS + '" height="' + CS + '" rx="2" tabindex="0" class="mca-h' + lv + ' ' + animClass('heat', col) + '"><title>' + esc(fmtFullDay(day, tz)) + ': ' + esc(fmtTokens(tokens)) + ' tokens</title></rect>';
  }
  // 行标签：完整星期名称，确保每一行的日期位置可读。
  let rowLabels = '';
  for (let r = 0; r < 7; r++) {
    if (!ROW_LABELS[r]) continue;
    rowLabels += '<text x="' + (X0 - LABEL_GAP) + '" y="' + (Y0 + r * (CS + GAP) + CS - 1) + '" text-anchor="end" class="mca-heat-day-label">' + ROW_LABELS[r] + '</text>';
  }
  // 月标签：按本地日期检测月份切换，历史月份不会被隐藏。
  let months = '';
  let lastMonthKey = '';
  for (let col = 0; col < cols; col++) {
    const day = startDay + col * 7 * DAY;
    const local = day + tz;
    const date = new Date(local * 1000);
    const key = date.getUTCFullYear() + '-' + date.getUTCMonth();
    if (key !== lastMonthKey) {
      months += '<text x="' + (X0 + col * (CS + GAP)) + '" y="' + (Y0 - 14) + '" class="mca-heat-month-label">' + (date.getUTCMonth() + 1) + '月</text>';
      lastMonthKey = key;
    }
  }
  // 图例贴住网格左下角、与首列单元格对齐，视觉上属于图表本体，而不是浮在右下角。
  return '<svg viewBox="0 0 ' + W2 + ' ' + H2 + '" class="mca-svg" role="img">' +
    '<g>' + months + '</g>' + rowLabels + cells +
    '<g class="mca-heat-legend" transform="translate(' + X0 + ' ' + (H2 - 20) + ')">' +
    '<text x="0" y="10" class="mca-heat-legend-label">少</text>' +
    [0, 1, 2, 3, 4].map((i) => '<rect x="' + (22 + i * (CS + GAP)) + '" y="0" width="' + CS + '" height="' + CS + '" rx="2" class="mca-h' + i + '"/>').join('') +
    '<text x="' + (22 + 5 * (CS + GAP) + 2) + '" y="10" class="mca-heat-legend-label">多</text></g></svg>';
}

/** 模型对比表（列排序由调用方 ui 处理；此处输出行数据已排序） */
function compareTable(models, opts = {}) {
  const tz = opts.tz | 0;
  void tz;
  const cols = [
    { key: 'model', label: '模型', render: (m) => esc(modelLabel((m.provider ? m.provider + '/' : '') + m.model)) },
    { key: 'calls', label: '调用', num: true, render: (m) => esc(fmtInt(m.calls)), titleFn: (m) => '成功 ' + esc(fmtInt(m.ok)) + ' / 失败 ' + esc(fmtInt(m.failed)) },
    { key: 'totalTokens', label: 'Tokens', num: true, render: (m) => esc(fmtTokens(m.totalTokens)), titleFn: (m) => '入 ' + esc(fmtTokens(m.inputTokens)) + ' · 出 ' + esc(fmtTokens(m.outputTokens)) + ' · 缓存读 ' + esc(fmtTokens(m.cacheReadTokens)) },
    { key: 'cost', label: '费用', num: true, render: (m) => esc(m.priced ? fmtCost(m.cost, opts.currency || m.currency || 'CNY') : '未配置') },
    { key: 'costPerMillionTokens', label: '实际单价', num: true, render: (m) => esc(m.costPerMillionTokens == null ? '—' : fmtCost(m.costPerMillionTokens, opts.currency || m.currency || 'CNY') + '/M') },
    { key: 'speedTokensPerSec', label: '输出速度', num: true, render: (m) => esc(fmtSpeed(m.speedTokensPerSec)) },
    { key: 'p50', label: 'P50', num: true, render: (m) => esc(fmtMs(m.p50)) },
    { key: 'p95', label: 'P95', num: true, render: (m) => esc(fmtMs(m.p95)) },
    { key: 'cacheHitRate', label: '缓存命中', num: true, render: (m) => esc(fmtPct(m.cacheHitRate)) + (m.cacheCoverage != null && m.cacheCoverage < 0.999 ? ' ⚠' : '') },
  ];
  let head = ''; let sortKey = opts.sortKey || 'cost';
  let dir = opts.sortDir || 'desc';
  for (const c of cols) {
    const arrow = c.key === sortKey ? (dir === 'desc' ? ' ↓' : ' ↑') : '';
    head += '<th class="' + (c.num ? 'num' : '') + '" data-sort="' + c.key + '" tabindex="0" role="button">' + esc(c.label) + esc(arrow) + '</th>';
  }
  let body = '';
  for (const m of models) {
    body += '<tr class="mca-cmp-row" data-model="' + esc(m.model) + '" data-provider="' + esc(m.provider) + '" data-model-key="' + esc(m.provider + '\u0000' + m.model) + '" tabindex="0" role="button">';
    for (const c of cols) body += '<td class="' + (c.num ? 'num' : '') + '"' + (c.titleFn ? ' title="' + c.titleFn(m) + '"' : '') + '>' + c.render(m) + '</td>';
    body += '</tr>';
  }
  return '<div class="mca-table-wrap"><table class="mca-table"><thead><tr>' + head + '</tr></thead><tbody>' + (body || '<tr><td colspan="9" class="mca-empty">当前范围暂无数据</td></tr>') + '</tbody></table></div>';
}

// UI 装配（React 契约层）：createUI(React, api) → { App }
// 构建时与 format/charts/index 合并为单文件 client 产物，import/export 会被剥离



const TABS = [
  { key: 'stacks', label: '消耗分布' },
  { key: 'trend', label: '调用趋势' },
  { key: 'dist', label: '调用次数分布' },
  { key: 'rank', label: '调用次数排行' },
  { key: 'compare', label: '模型对比' },
];
const RANGES = [
  { key: 'today', label: '今天' },
  { key: '24h', label: '24H' },
  { key: '7d', label: '7D' },
  { key: '30d', label: '30D' },
  { key: '90d', label: '90D' },
  { key: 'all', label: '全部' },
  { key: 'custom', label: '自定义' },
];
// 时间粒度按分钟、小时、天、月划分；旧版自动/周偏好会迁移到当前可见粒度。
const GRANULARITIES = [
  { key: 'minute', label: '分钟' },
  { key: 'hour', label: '时' },
  { key: 'day', label: '天' },
  { key: 'month', label: '月' },
];

function visibleGranularity(value, range) {
  if (value === 'minute' || value === 'hour' || value === 'day' || value === 'month') return value;
  if (value === 'week') return 'day';
  if (range === 'today' || range === '24h') return 'hour';
  if (range === '90d' || range === 'all') return 'month';
  return 'day';
}
// 桶数护栏（与服务端 resolveRange 的 MAX_BUCKETS 同值）：细粒度 × 大范围会爆桶。
const MAX_BUCKETS = 2500;
function spanSecondsOf(range, custom, nowSec) {
  const now = nowSec ?? Math.floor(Date.now() / 1000);
  if (range === 'today' || range === '24h') return 86400;
  if (range === '7d') return 7 * 86400;
  if (range === '30d') return 30 * 86400;
  if (range === '90d') return 90 * 86400;
  if (range === 'all') return Infinity; // 数据跨度未知：分钟不提供，时/天/月交给服务端护栏兜底
  return Math.max(0, (custom.to || now) - (custom.from || 0));
}
function granularityFits(g, spanSec) {
  const step = g === 'minute' ? 60 : g === 'hour' ? 3600 : g === 'day' ? 86400 : 0;
  if (!step) return true;
  if (!isFinite(spanSec)) return g !== 'minute';
  return spanSec / step <= MAX_BUCKETS;
}
const POLL_MS = 30000;
const PREFS_KEY = 'mca.prefs.v1';
function loadPrefs() {
  try {
    const prefs = JSON.parse(localStorage.getItem(PREFS_KEY)) || {};
    // 旧版本把 NUL 分隔符写进 HTML 属性，浏览器会替换成 U+FFFD；载入时修复这类历史脏数据
    if (Array.isArray(prefs.modelKeys)) {
      prefs.modelKeys = prefs.modelKeys
        .map((k) => String(k).replace(/\uFFFD/g, '\u0000'))
        .filter((k) => k && !k.startsWith('\u0000') && !k.endsWith('\u0000'));
    }
    return prefs;
  } catch { return {}; }
}
function savePrefs(p) { try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* ignore */ } }

function createUI(React, api) {
  const h = React.createElement;
  const { useState, useEffect, useRef } = React;

  function App() {
    const tz = useRef(-new Date().getTimezoneOffset() * 60).current;
    const p0 = useRef(null);
    if (p0.current === null) {
      const p = loadPrefs();
      p0.current = {
        range: p.range || '7d',
        granularity: p.granularity || 'auto',
        custom: p.custom || { from: Math.floor(Date.now() / 1000) - 30 * 86400, to: Math.floor(Date.now() / 1000) },
        modelKeys: Array.isArray(p.modelKeys) ? p.modelKeys : [],
        providers: Array.isArray(p.providers) ? p.providers : [],
        tab: p.tab || 'stacks',
        metric: p.metric || 'tokens',
        percentMode: !!p.percentMode,
      };
    }
    const [range, setRange] = useState(p0.current.range);
    const [granularity, setGranularity] = useState(visibleGranularity(p0.current.granularity, p0.current.range));
    const [custom, setCustom] = useState(p0.current.custom);
    const [modelKeys, setModelKeys] = useState(p0.current.modelKeys);
    const [providers, setProviders] = useState(p0.current.providers);
    const [tab, setTab] = useState(p0.current.tab);
    const [metric, setMetric] = useState(p0.current.metric);
    const [percentMode, setPercentMode] = useState(p0.current.percentMode);
    // null = 跟随最新时间窗口；用户滚轮浏览后保存明确偏移。
    const [chartWindow, setChartWindow] = useState(null);
    const [sort, setSort] = useState({ key: 'cost', dir: 'desc' });
    const [showPricing, setShowPricing] = useState(false);
    const [pricing, setPricing] = useState(null);
    const [pricingDraft, setPricingDraft] = useState(null);
    const [pricingStatus, setPricingStatus] = useState('');
    const [pricingSearch, setPricingSearch] = useState('');
    const pricingFileRef = useRef(null);
    const pricingDialogRef = useRef(null);
    const pricingCloseRef = useRef(null);
    const [data, setData] = useState(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(false);
    const loadSeq = useRef(0);
    const responses = useRef(new Map());
    // Keep a short, panel-local cache. Pending switches to the same query share
    // their promise; failed requests are always retryable.
    function request(path, query, refresh, keyQuery = query) {
      const cache = responses.current;
      const key = JSON.stringify([path, keyQuery]);
      const hit = cache.get(key);
      if (hit && (hit.pending || (!refresh && Date.now() - hit.at < POLL_MS))) return hit.promise;
      const entry = { pending: true, at: 0 };
      entry.promise = api.call(path, query).then(value => {
        entry.pending = false;
        entry.at = Date.now();
        return value;
      }, err => {
        if (cache.get(key) === entry) cache.delete(key);
        throw err;
      });
      cache.delete(key);
      cache.set(key, entry);
      if (cache.size > 40) cache.delete(cache.keys().next().value);
      return entry.promise;
    }

    const params = { range, granularity, from: custom.from, to: custom.to, tz, modelKeys: modelKeys.length ? modelKeys : null, providers: providers.length ? providers : null };
    const paramsRef = useRef(params);
    const paramsKey = JSON.stringify(params);
    paramsRef.current = params;

    const openPricing = () => {
      setPricingStatus(pricing ? '' : '读取中…');
      setShowPricing(true);
      if (pricing) return;
      api.call('pricing', {}).then((p) => { setPricing(p); setPricingDraft(p); }).catch(() => setPricingStatus('读取失败'));
    };
    const savePricing = () => {
      if (!pricingDraft) return;
      setPricingStatus('保存中…');
      // 默认目录可能包含数千行；保存请求只传手动覆盖，避免把完整目录塞进 URL。
      const payload = { version: 1, currency: pricingDraft.currency || 'CNY', rates: pricingDraft.rates || {}, rows: Array.isArray(pricingDraft.rows) ? pricingDraft.rows : [] };
      api.call('pricing/save', { config: JSON.stringify(payload) }).then((p) => { setPricing(p); setPricingDraft(p); setPricingStatus('已保存'); responses.current.clear(); load(true); }).catch(() => setPricingStatus('保存失败'));
    };
    const importPricingFile = (event) => {
      const file = event.target.files && event.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const text = String(reader.result || '');
          let rows;
          if (/^\s*[\[{]/.test(text)) {
            const value = JSON.parse(text);
            rows = Array.isArray(value) ? value : (Array.isArray(value.rows) ? value.rows : []);
          } else {
            rows = text.split(/\r?\n/).filter((line) => line.trim() && !line.trim().startsWith('#')).map((line) => {
              const c = line.split(',').map((x) => x.trim());
              return { provider: c[0] || '*', model: c[1] || '', currency: c[2] || 'CNY', input: c[3] || '', output: c[4] || '', cacheRead: c[5] || '', cacheWrite: c[6] || '' };
            }).filter((r) => r.model);
          }
          setPricingDraft({ ...(pricingDraft || {}), currency: (pricingDraft && pricingDraft.currency) || 'CNY', rows });
          setPricingStatus('已导入 ' + rows.length + ' 条；请核对 DSH provider/model 后保存');
        } catch { setPricingStatus('导入失败：只支持 JSON 或 CSV'); }
      };
      reader.readAsText(file);
      event.target.value = '';
    };

    const load = (silent) => {
      const seq = ++loadSeq.current;
      if (!silent) setBusy(true);
      const current = paramsRef.current;
      if (!silent) setChartWindow(null);
      const now = Math.floor(Date.now() / 1000);
      const heatParams = { range: 'custom', granularity: 'day', from: now - 12 * 31 * 86400 - 7 * 86400, to: now, tz: current.tz, modelKeys: current.modelKeys, providers: current.providers };
      // 次级汇总页只跟随时间范围和筛选条件，不跟随图表时间粒度。
      const summaryParams = { ...current, granularity: 'day' };
      // 筛选项元数据始终不带模型/供应商筛选，避免勾选后菜单自我锁死。
      const metaParams = { range: current.range, granularity: 'day', from: current.from, to: current.to, tz: current.tz };
      Promise.allSettled([
        request('usage', summaryParams, silent),
        request('stacks', current, silent),
        request('compare', summaryParams, silent),
        request('models', metaParams, silent),
        request('heatmap', heatParams, silent, [current.tz, Math.floor((now + current.tz) / 86400), current.modelKeys, current.providers]),
      ]).then(results => {
        if (seq !== loadSeq.current) return;
        const keys = ['usage', 'stacks', 'compare', 'modelsMeta', 'heatmap'];
        const labels = ['总览', '趋势数据', '模型对比', '筛选列表', '热力图'];
        const snapshot = {};
        const failures = [];
        results.forEach((result, i) => {
          if (result.status === 'fulfilled') snapshot[keys[i]] = result.value;
          else failures.push(labels[i] + '（' + (result.reason?.message || '请求失败') + '）');
        });
        const { stacks } = snapshot;
        // Never combine panels from different filters. Only reuse last-good
        // values from this same request scope when a background refresh fails.
        const scope = JSON.stringify(current);
        setData(previous => {
          const same = previous?.scope === scope ? previous : null;
          return same || Object.keys(snapshot).length ? { ...same, ...snapshot, scope } : null;
        });
        setError(failures.join('、'));
        setBusy(false);
        // 服务端护栏降档后回写按钮状态（如「全部」范围选了超量的细粒度被降为天），
        // 让选中态与实际渲染一致；收敛后不再触发。
        if (stacks && stacks.granularity && stacks.granularity !== current.granularity) {
          setGranularity(stacks.granularity);
        }
      }).catch(() => {
        if (seq !== loadSeq.current) return;
        setError(true);
        setBusy(false);
      });
    };

    useEffect(() => {
      savePrefs({ range, granularity, custom, modelKeys, providers, tab, metric, percentMode });
    }, [range, granularity, custom, modelKeys, providers, tab, metric, percentMode]);
    useEffect(() => {
      // 粒度与当前范围不匹配（历史偏好中毒 / 自定义范围收窄 / 旧版迁移）时先纠正再加载，
      // 避免带着会被服务端降档的参数白跑一趟。
      if (!granularityFits(granularity, spanSecondsOf(range, custom))) {
        setGranularity(visibleGranularity('auto', range));
        return;
      }
      load(false);
    }, [paramsKey]); // eslint-disable-line react-hooks/exhaustive-deps
    useEffect(() => {
      const t = setInterval(() => { if (document.visibilityState === 'visible') load(true); }, POLL_MS);
      return () => clearInterval(t);
    }, []);
    useEffect(() => {
      if (!showPricing || typeof document === 'undefined') return undefined;
      const previous = document.activeElement;
      const getFocusable = () => {
        const root = pricingDialogRef.current;
        if (!root) return [];
        return [...root.querySelectorAll('button, input, select, [tabindex="0"]')].filter((el) => !el.disabled && !el.hidden);
      };
      (pricingCloseRef.current || pricingDialogRef.current)?.focus?.();
      const onKeyDown = (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          setShowPricing(false);
          return;
        }
        if (e.key !== 'Tab') return;
        const items = getFocusable();
        if (!items.length) return;
        const first = items[0]; const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      };
      document.addEventListener('keydown', onKeyDown);
      return () => {
        document.removeEventListener('keydown', onKeyDown);
        previous?.focus?.();
      };
    }, [showPricing]);

    const toggleModel = (key) => {
      setModelKeys((current) => current.includes(key) ? current.filter((m) => m !== key) : current.concat([key]));
    };
    const toggleProvider = (provider) => {
      setProviders((current) => current.includes(provider) ? current.filter((p) => p !== provider) : current.concat([provider]));
    };
    const clearFilters = () => { setModelKeys([]); setProviders([]); };

    const u = data && data.usage;
    const stacks = (data && data.stacks && data.stacks.buckets) || [];
    const chartSize = 24;
    const chartMaxOffset = Math.max(0, stacks.length - chartSize);
    const chartOffset = chartWindow == null ? chartMaxOffset : Math.max(0, Math.min(chartMaxOffset, chartWindow));
    const visibleStacks = stacks.slice(chartOffset, chartOffset + chartSize);
    const onChartWheel = (e) => {
      if (stacks.length <= chartSize) return;
      e.preventDefault();
      const delta = e.deltaY > 0 ? 1 : -1;
      setChartWindow((value) => {
        const base = value == null ? chartMaxOffset : Math.max(0, Math.min(chartMaxOffset, value));
        return Math.max(0, Math.min(chartMaxOffset, base + delta));
      });
    };
    const chartPosition = null; // 技术性时间窗提示已移除，改用可读的区间副标题
    const cmp = (data && data.compare && data.compare.models) || [];
    const dist = (u && u.dist) || [];
    // React retains this clock while polling replaces the SVG inside it. Start a
    // fresh sweep on navigation, a metric change or the first non-empty result.
    const ringClockKey = JSON.stringify([tab, metric, range, custom, modelKeys, providers, dist.length > 0]);
    const anyUnpriced = dist.some((d) => !d.priced);

    const cmpSorted = [...cmp].sort((a, b2) => {
      const k = sort.key; const dirMul = sort.dir === 'desc' ? -1 : 1;
      const va = a[k]; const vb = b2[k];
      const na = va == null ? -1 : va; const nb = vb == null ? -1 : vb;
      if (typeof na === 'string' || typeof nb === 'string') return String(na).localeCompare(String(nb)) * dirMul;
      return (na - nb) * dirMul;
    });

    const currency = (u && u.kpi && u.kpi.currency) || (cmp.find((m) => m.priced && m.currency) || {}).currency || 'CNY';
    const changeRange = (key) => {
      if (key === 'custom' && custom.from > custom.to) {
        const now = Math.floor(Date.now() / 1000);
        setCustom({ from: now - 7 * 86400, to: now });
      }
      setRange(key);
      setGranularity(visibleGranularity('auto', key));
    };
    const chartNav = chartMaxOffset > 0 ? h('div', { className: 'mca-chart-nav', role: 'group', 'aria-label': '时间窗口' },
      h('button', { className: 'mca-pill sm', disabled: chartOffset <= 0, onClick: () => setChartWindow(Math.max(0, chartOffset - 1)), 'aria-label': '较早一个时间桶' }, '←'),
      h('button', { className: 'mca-pill sm', disabled: chartOffset >= chartMaxOffset, onClick: () => setChartWindow(Math.min(chartMaxOffset, chartOffset + 1)), 'aria-label': '较晚一个时间桶' }, '→'),
      h('button', { className: 'mca-pill sm', disabled: chartWindow == null, onClick: () => setChartWindow(null) }, '最新'),
    ) : null;
    const sortBy = (key) => setSort((s) => ({ key, dir: s.key === key && s.dir === 'desc' ? 'asc' : 'desc' }));
    const activateCompareRow = (tr) => {
      if (tr && tr.dataset && tr.dataset.modelKey) toggleModel(tr.dataset.modelKey);
    };
    const onCompareKeyDown = (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const th = e.target && e.target.closest && e.target.closest('th[data-sort]');
      if (th) { e.preventDefault(); sortBy(th.getAttribute('data-sort')); return; }
      const tr = e.target && e.target.closest && e.target.closest('tr.mca-cmp-row');
      if (tr) { e.preventDefault(); activateCompareRow(tr); }
    };
    const downloadCompare = () => {
      if (typeof document === 'undefined' || typeof URL === 'undefined') return;
      const columns = [
        ['provider', 'Provider'], ['model', 'Model'], ['calls', '调用次数'], ['ok', '成功次数'], ['failed', '失败次数'],
        ['inputTokens', '输入 Tokens'], ['outputTokens', '输出 Tokens'], ['cacheReadTokens', '缓存读 Tokens'], ['cacheWriteTokens', '缓存写 Tokens'],
        ['totalTokens', '总 Tokens'], ['cost', '预估费用'], ['currency', '币种'], ['costPerMillionTokens', '每百万 Token 费用'],
        ['speedTokensPerSec', '输出速度(tok/s)'], ['p50', 'P50(ms)'], ['p95', 'P95(ms)'], ['cacheHitRate', '缓存命中率'], ['cacheCoverage', '缓存遥测覆盖率'],
      ];
      const lines = [columns.map(([, label]) => csvCell(label)).join(',')];
      for (const row of cmpSorted) lines.push(columns.map(([key]) => csvCell(row[key])).join(','));
      const blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'token-tally-compare.csv';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    };

    const rangeLabel = (() => {
      if (!visibleStacks.length) return null;
      const first = visibleStacks[0]; const last = visibleStacks[visibleStacks.length - 1];
      const f = fmtDay(first.start, first.gran || 'day', tz);
      const l = fmtDay(last.start, last.gran || 'day', tz);
      return f === l ? f : f + ' – ' + l;
    })();

    // 图表点击筛选：柱子/扇区分别携带 data-provider 与 data-model，点击后拼成 provider+model 筛选键
    const onChartPick = (e) => {
      const el = e.target && e.target.closest && e.target.closest('[data-model]');
      if (!el) return;
      const provider = el.getAttribute('data-provider') || '';
      const model = el.getAttribute('data-model') || '';
      if (!model) return;
      toggleModel(provider ? provider + '\u0000' + model : model);
    };

    // 已选筛选 chip（可单个移除），比「清除」更直观
    const chips = [];
    for (const key of modelKeys) {
      const sep = key.indexOf('\u0000');
      const provider = sep >= 0 ? key.slice(0, sep) : '';
      const model = sep >= 0 ? key.slice(sep + 1) : key;
      chips.push(h('span', { key, className: 'mca-chip' },
        h('span', { className: 'mca-chip-text', title: provider ? provider + '/' + model : model }, displayModelName(model)),
        h('button', { className: 'mca-chip-x', onClick: () => toggleModel(key), 'aria-label': '移除筛选 ' + model }, '×'),
      ));
    }
    for (const provider of providers) {
      chips.push(h('span', { key: 'p:' + provider, className: 'mca-chip' },
        h('span', { className: 'mca-chip-text', title: provider }, provider),
        h('button', { className: 'mca-chip-x', onClick: () => toggleProvider(provider), 'aria-label': '移除筛选 ' + provider }, '×'),
      ));
    }

    // 粒度只作用于时序图（消耗分布/调用趋势）；分布/排行/对比是范围级汇总，显示按钮反而像"点了没反应"。
    const granularitiesVisible = tab === 'stacks' || tab === 'trend';
    const granChoices = GRANULARITIES.filter((g) => granularityFits(g.key, spanSecondsOf(range, custom)));
    const filterBar = h('div', { className: 'mca-filters' },
      h('div', { className: 'mca-toolbar-main' },
        h('div', { className: 'mca-seg' }, RANGES.map((r) => h('button', {
          key: r.key, className: 'mca-seg-btn' + (range === r.key ? ' on' : ''),
          onClick: () => changeRange(r.key),
        }, r.label))),
        granularitiesVisible ? h('div', { className: 'mca-seg mca-seg-sm' }, granChoices.map((g) => h('button', {
          key: g.key, className: 'mca-seg-btn' + (granularity === g.key ? ' on' : ''),
          title: '按' + g.label + '聚合',
          onClick: () => setGranularity(g.key),
        }, g.label))) : null,
        range === 'custom' ? h('span', { className: 'mca-custom' },
          h('input', {
            type: 'date', value: localDateStr(custom.from), 'aria-label': '开始日期', onChange: (e) => {
              if (!e.target.value) return;
              const from = localTs(e.target.value, false, tz);
              setCustom({ from, to: Math.max(custom.to, from + 86399) });
            },
          }),
          h('span', { className: 'mca-sep' }, '→'),
          h('input', {
            type: 'date', value: localDateStr(custom.to), 'aria-label': '结束日期', onChange: (e) => {
              if (!e.target.value) return;
              const to = localTs(e.target.value, true, tz);
              setCustom({ from: Math.min(custom.from, to - 86399), to });
            },
          }),
        ) : null,
        h('details', { className: 'mca-drop' },
          h('summary', { className: 'mca-drop-btn' }, '筛选', (modelKeys.length + providers.length) ? h('span', { className: 'mca-count' }, String(modelKeys.length + providers.length)) : null),
          h('div', { className: 'mca-menu' },
            (data && data.modelsMeta && data.modelsMeta.models || []).map((g) => h('div', { key: g.provider, className: 'mca-vendor' },
              h('label', { className: 'mca-vendor-name mca-menu-item' },
                h('input', { type: 'checkbox', checked: providers.includes(g.provider), onChange: () => toggleProvider(g.provider), 'aria-label': '筛选供应商 ' + g.provider }),
                h('span', null, g.provider),
              ),
              g.models.map((m) => {
                const key = g.provider + '\u0000' + m;
                return h('label', { key, className: 'mca-menu-item mca-model-item' },
                  h('input', { type: 'checkbox', checked: modelKeys.includes(key), onChange: () => toggleModel(key) }),
                  h('span', null, displayModelName(m)),
                );
              }),
            )),
            (data && data.modelsMeta && data.modelsMeta.models || []).length === 0 ? h('div', { className: 'mca-empty' }, busy ? '加载中…' : '当前范围暂无模型') : null,
          ),
        ),
        chips.length ? h('button', { className: 'mca-clear', onClick: clearFilters }, '清除') : null,
      ),
      h('div', { className: 'mca-toolbar-side' },
        busy ? h('span', { className: 'mca-busy', role: 'status' }, '统计中') : null,
        error ? h('span', { className: 'mca-err', role: 'alert' }, '加载失败 ' + (typeof error === 'string' ? error : '') + ' ', h('button', { className: 'mca-retry', onClick: () => load(false) }, '重试')) : null,
        h('button', { className: 'mca-settings-btn', onClick: openPricing, title: '管理模型价格' }, '费用设置'),
      ),
    );

    const chipRow = chips.length ? h('div', { className: 'mca-chips' }, chips) : null;

    const kpi = u ? h('div', { className: 'mca-kpis' },
      kpiCard('预估费用', u.kpi.cost == null ? '未配置' : fmtCost(u.kpi.cost, u.kpi.currency || currency), u.kpi.costPriced ? '' : 'mca-dim', anyUnpriced ? '部分模型未配置价格' : null),
      kpiCard('会话数', fmtInt(u.kpi.sessions ?? 0)),
      kpiCard('用量请求', fmtInt(u.kpi.requests)),
      kpiCard('计费 Tokens', fmtTokens(u.kpi.totalTokens)),
      kpiCard('缓存命中率', fmtPct(u.kpi.cacheHitRate), '', u.kpi.cacheCoverage != null ? '遥测覆盖 ' + fmtPct(u.kpi.cacheCoverage) : null),
    ) : (error ? h('div', { className: 'mca-kpis mca-kpis-placeholder' }, h('div', { className: 'mca-empty' }, '数据加载失败')) : h('div', { className: 'mca-kpis' }, [0, 1, 2, 3, 4].map((i) => h('div', { key: i, className: 'mca-kpi mca-kpi-skeleton' },
      h('div', { className: 'mca-skeleton mca-skeleton-label' }),
      h('div', { className: 'mca-skeleton mca-skeleton-value' }),
    ))));

    const tabNav = h('div', { className: 'mca-tabs', role: 'tablist' }, TABS.map((t) => h('button', {
      key: t.key, role: 'tab', 'aria-selected': tab === t.key,
      className: 'mca-tab' + (tab === t.key ? ' on' : ''), onClick: () => setTab(t.key),
    }, t.label)));

    // 口径切换做成一个分段控件，视觉上与筛选栏区分
    const metricPills = (k) => h('div', { className: 'mca-seg mca-seg-sm' },
      [['tokens', 'Token'], ['cost', '费用'], ['count', '次数']].map(([key, label]) => h('button', {
        key, className: 'mca-seg-btn' + (metric === key ? ' on' : ''), onClick: () => { setMetric(key); if (k) setTab(k); },
      }, label)));

    let body = null;
    if (error && !data) {
      body = h('div', { className: 'mca-card mca-error-state', role: 'alert' },
        h('div', { className: 'mca-empty' }, '台账数据加载失败，请检查本地服务后重试。'),
        h('button', { className: 'mca-pill on', onClick: () => load(false) }, '重新加载'),
      );
    } else if (tab === 'stacks') {
      // newapi 式：堆叠柱 + 环形占比并排，占比一目了然
      body = h('div', { className: 'mca-card' },
        h('div', { className: 'mca-card-head' },
          h('div', { className: 'mca-card-title-wrap' },
            h('span', { className: 'mca-card-title' }, '模型消耗分布'),
            rangeLabel ? h('span', { className: 'mca-card-sub' }, rangeLabel) : null,
          ),
          h('div', { className: 'mca-card-tools' },
            chartNav,
            h('button', { className: 'mca-pill sm' + (percentMode ? ' on' : ''), onClick: () => setPercentMode(!percentMode), 'aria-pressed': percentMode, title: '绝对值 / 100% 占比切换' }, '占比'),
            metricPills(null),
          ),
        ),
        h('div', { className: 'mca-split' },
          h('div', { className: 'mca-unsafe mca-split-main mca-chart-wrap', onWheel: onChartWheel, onClick: onChartPick, dangerouslySetInnerHTML: { __html: stackedBars(visibleStacks, { metric, tz, percentMode, currency }) } }),
          // 消耗分布页与堆叠柱并排：用紧凑环（不画引线标签与长图例，颜色与柱图图例一致）。
          h('div', { key: ringClockKey, className: 'mca-donut-grow mca-split-side mca-unsafe', style: { '--progress': 1 }, onClick: onChartPick, dangerouslySetInnerHTML: { __html: donut(dist, { metric, currency, compact: true, externalClock: true }) } }),
        ),
      );
    } else if (tab === 'trend') {
      body = h('div', { className: 'mca-card' },
        h('div', { className: 'mca-card-head' },
          h('div', { className: 'mca-card-title-wrap' },
            h('span', { className: 'mca-card-title' }, '调用趋势'),
            rangeLabel ? h('span', { className: 'mca-card-sub' }, rangeLabel) : null,
          ),
          h('div', { className: 'mca-card-tools' }, chartNav, metricPills('trend')),
        ),
        h('div', { className: 'mca-unsafe mca-chart-wrap', onWheel: onChartWheel, dangerouslySetInnerHTML: { __html: trendLines(visibleStacks, { tz, metric, currency }) } }),
      );
    } else if (tab === 'dist') {
      body = h('div', { className: 'mca-card' },
        h('div', { className: 'mca-card-head' },
          h('div', { className: 'mca-card-title-wrap' },
            h('span', { className: 'mca-card-title' }, '模型调用次数占比'),
            h('span', { className: 'mca-card-sub' }, '点击扇区可筛选'),
          ),
          h('div', { className: 'mca-card-tools' }, metricPills(null)),
        ),
        h('div', { key: ringClockKey, className: 'mca-donut-grow mca-unsafe', style: { '--progress': 1 }, onClick: onChartPick, dangerouslySetInnerHTML: { __html: donut(dist, { metric, currency, externalClock: true }) } }),
      );
    } else if (tab === 'rank') {
      // 排行榜与总额同口径：排除 internal/(compaction) 内部压缩台账行（compare 表仍保留该行）
      const ranked = cmp.filter((m) => !(m.provider === 'internal' || m.model === '(compaction)'));
      body = h('div', { className: 'mca-card' },
        h('div', { className: 'mca-card-head' },
          h('div', { className: 'mca-card-title-wrap' },
            h('span', { className: 'mca-card-title' }, '模型调用排行'),
            h('span', { className: 'mca-card-sub' }, '总计 ' + fmtInt(ranked.reduce((s, m) => s + (m.calls || 0), 0)) + ' 次请求'),
          ),
          h('div', { className: 'mca-card-tools' }, metricPills(null)),
        ),
        h('div', { className: 'mca-unsafe', onClick: onChartPick, dangerouslySetInnerHTML: { __html: rankingBars(ranked, { metric, currency }) } }),
      );
    } else {
      body = h('div', { className: 'mca-card' },
        h('div', { className: 'mca-card-head' },
          h('div', { className: 'mca-card-title-wrap' },
            h('span', { className: 'mca-card-title' }, '模型对比'),
            h('span', { className: 'mca-card-sub' }, modelKeys.length ? '已筛选 ' + modelKeys.length + ' 个模型' : '点击行可筛选全看板'),
          ),
          h('div', { className: 'mca-card-tools' },
            h('button', { className: 'mca-pill sm', onClick: downloadCompare, disabled: !cmpSorted.length }, '导出 CSV'),
          ),
        ),
        h('div', {
          className: 'mca-unsafe mca-compare-scroll',
          onClick: (e) => {
            const th = e.target && e.target.closest && e.target.closest('th[data-sort]');
            if (th) { sortBy(th.getAttribute('data-sort')); return; }
            const tr = e.target && e.target.closest && e.target.closest('tr.mca-cmp-row');
            activateCompareRow(tr);
          },
          onKeyDown: onCompareKeyDown,
          dangerouslySetInnerHTML: { __html: compareTable(cmpSorted, { sortKey: sort.key, sortDir: sort.dir, currency }) },
        }),
      );
    }

    const heat = data && data.heatmap;
    // 热力图只作为「消耗分布」页的补充视图；其它页签不渲染，避免与当前主题无关又挤占版面
    const heatCard = tab === 'stacks' ? h('div', { className: 'mca-card' },
      h('div', { className: 'mca-card-head' },
        h('div', { className: 'mca-card-title-wrap' },
          h('span', { className: 'mca-card-title' }, '用量热力图'),
          h('span', { className: 'mca-card-sub' }, '最近 12 个月'),
        ),
      ),
      heat ? h('div', { className: 'mca-unsafe mca-heat-wrap', dangerouslySetInnerHTML: { __html: calendarHeatmap(heat.days, { tz, now: Math.floor(Date.now() / 1000) }) } }) : h('div', { className: 'mca-empty' }, error ? '暂时无法加载，请点击上方“重试”' : '加载中…'),
    ) : null;

    return h('div', { className: 'mca-root' },
      filterBar,
      chipRow,
      kpi,
      tabNav,
      h('div', { key: tab, className: 'mca-body' }, body),
      heatCard,
      showPricing ? pricingDialog(h, {
        pricing, pricingDraft, pricingStatus, pricingSearch, pricingFileRef, pricingDialogRef, pricingCloseRef,
        setPricingDraft, setPricingSearch, setShowPricing, savePricing, importPricingFile,
      }) : null,
    );
  }

  function pricingDialog(h, scope) {
    const {
      pricing, pricingDraft, pricingStatus, pricingSearch, pricingFileRef, pricingDialogRef, pricingCloseRef,
      setPricingDraft, setPricingSearch, setShowPricing, savePricing, importPricingFile,
    } = scope;
    const draft = pricingDraft || { currency: 'CNY', rows: [], defaults: [] };
    const rows = Array.isArray(draft.rows) ? draft.rows : [];
    const defaults = Array.isArray(draft.defaults) ? draft.defaults : [];
    const needle = pricingSearch.trim().toLowerCase();
    const visibleRows = rows.filter((r) => !needle || String(r.provider || '').toLowerCase().includes(needle) || String(r.model || '').toLowerCase().includes(needle));
    const updateRow = (i, key, value) => setPricingDraft({ ...draft, rows: rows.map((r, n) => n === i ? { ...r, [key]: value } : r) });
    return h('div', { className: 'mca-modal-backdrop', onClick: (e) => { if (e.target === e.currentTarget) setShowPricing(false); } },
      h('div', { className: 'mca-price-modal', role: 'dialog', 'aria-modal': true, 'aria-label': '费用设置', ref: pricingDialogRef, tabIndex: -1 },
        h('div', { className: 'mca-price-head' }, h('div', null, h('div', { className: 'mca-price-title' }, '费用设置'), h('div', { className: 'mca-price-sub' }, '按 DSH 的 provider / model 记录价格，单位：每百万 token')), h('button', { className: 'mca-icon-btn', onClick: () => setShowPricing(false), 'aria-label': '关闭', ref: pricingCloseRef }, '×')),
        h('div', { className: 'mca-price-note' }, '内置价格与在线目录作为默认值；手动覆盖只作用于完全匹配的 provider + model。不同平台的 ID 可在导入时映射后保存。价格单位为每百万 token，缓存读写单价可留空。默认目录共 ' + defaults.length + ' 条；DSH 记录的 provider/model 不会被自动猜测改名。'),
        h('div', { className: 'mca-price-toolbar' }, h('label', null, '币种 ', h('select', { value: draft.currency || 'CNY', onChange: (e) => setPricingDraft({ ...draft, currency: e.target.value }) }, h('option', { value: 'CNY' }, 'CNY · 人民币'), h('option', { value: 'USD' }, 'USD · 美元'))), h('input', { className: 'mca-price-search', value: pricingSearch, onChange: (e) => setPricingSearch(e.target.value), placeholder: '搜索 provider / model' }), h('button', { className: 'mca-pill sm', onClick: () => setPricingDraft({ ...draft, rows: rows.concat([{ provider: '*', model: '', currency: draft.currency || 'CNY', input: '', output: '', cacheRead: '', cacheWrite: '' }]) }) }, '添加模型'), h('button', { className: 'mca-pill sm', onClick: () => pricingFileRef.current && pricingFileRef.current.click() }, '导入'), h('input', { ref: pricingFileRef, type: 'file', accept: '.csv,.json,text/csv,application/json', hidden: true, onChange: importPricingFile })), 
        h('div', { className: 'mca-price-help' }, '导入建议：先把 provider 与 model 映射成 DSH 实际记录值，再填写四档价格。CSV 列顺序：provider,model,currency,input,output,cacheRead,cacheWrite。'),
        h('div', { className: 'mca-price-table-wrap' }, h('table', { className: 'mca-price-table' }, h('thead', null, h('tr', null, ['Provider', 'Model ID（DSH）', '输入 / M', '输出 / M', '缓存读 / M', '缓存写 / M', ''].map((x) => h('th', { key: x }, x)))), h('tbody', null, visibleRows.map((r, i) => h('tr', { key: rows.indexOf(r) }, h('td', null, h('input', { value: r.provider || '*', onChange: (e) => updateRow(rows.indexOf(r), 'provider', e.target.value) })), h('td', null, h('input', { value: r.model || '', onChange: (e) => updateRow(rows.indexOf(r), 'model', e.target.value), placeholder: '如 gpt-6-astra' })), ...['input', 'output', 'cacheRead', 'cacheWrite'].map((key) => h('td', { key }, h('input', { type: 'number', min: '0', step: 'any', value: r[key] == null ? '' : r[key], onChange: (e) => updateRow(rows.indexOf(r), key, e.target.value) }))), h('td', null, h('button', { className: 'mca-remove-btn', onClick: () => { const index = rows.indexOf(r); setPricingDraft({ ...draft, rows: rows.filter((_, n) => n !== index) }); } }, '删除'))))), rows.length ? null : h('tr', null, h('td', { colSpan: 7, className: 'mca-empty' }, '暂无手动覆盖；你可以添加 provider / model 价格')))),
        h('div', { className: 'mca-price-foot' }, h('span', { className: 'mca-price-status', role: 'status' }, pricingStatus || (pricing && pricing.source === 'builtin+online' ? '默认价格已加载' : '')), h('button', { className: 'mca-pill', onClick: () => setShowPricing(false) }, '取消'), h('button', { className: 'mca-pill on', onClick: savePricing, disabled: !pricingDraft }, '保存价格')),
      ),
    );
  }

  function kpiCard(label, value, cls, sub) {
    return h('div', { className: 'mca-kpi' + (cls ? ' ' + cls : '') },
      h('div', { className: 'mca-kpi-label' }, label),
      h('div', { className: 'mca-kpi-value' }, String(value)),
      sub ? h('div', { className: 'mca-kpi-sub' }, sub) : null,
    );
  }

  function localDateStr(ts) {
    const d = new Date((ts + tzOff()) * 1000);
    return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
  }
  function localTs(str, endOfDay) {
    const t = Math.floor(new Date(str + 'T00:00:00').getTime() / 1000);
    return endOfDay ? t + 86399 : t;
  }
  function tzOff() { return -new Date().getTimezoneOffset() * 60; }

  return { App, pricingDialog };
}

// client 入口：模块契约 {inject:['slots'], apply(ctx)} + 样式注入 + 同源 API
// 构建时与 format/charts/ui 合并为单文件 lib/client.js（window.__ModuleLoader__.load 工厂）

// client 入口：模块契约 {inject:['slots'], apply(ctx)} + 样式注入 + 同源 API
// 构建时与 format/charts/ui 合并为单文件 lib/client.js（window.__ModuleLoader__.load 工厂）

const REQUEST_TIMEOUT_MS = 12000;

function registerStylesEffect(ctx, injectStyles) {
  if (ctx.effect) return ctx.effect(() => injectStyles(), 'token-tally: styles');
  return injectStyles();
}

function makeErrorBoundary(React) {
  const h = React.createElement;
  return class TokenTallyErrorBoundary extends React.Component {
    constructor(props) {
      super(props);
      this.state = { error: null, revision: 0 };
    }
    static getDerivedStateFromError(error) { return { error }; }
    componentDidCatch(error) {
      if (typeof console !== 'undefined' && console.error) console.error('[token-tally] render failed', error);
    }
    render() {
      if (this.state.error) {
        return h('div', { className: 'mca-root mca-fatal', role: 'alert' },
          h('div', { className: 'mca-card mca-error-state' },
            h('h2', null, 'Token 台账暂时无法显示'),
            h('p', { className: 'mca-empty' }, '界面组件发生异常。你可以重试；筛选偏好仍保留在本机。'),
            h('button', { className: 'mca-pill on', onClick: () => this.setState((s) => ({ error: null, revision: s.revision + 1 })) }, '重试'),
          ),
        );
      }
      return h('div', { key: this.state.revision, className: 'mca-boundary' }, this.props.children);
    }
  };
}

function makeModule(React) {
  const h = React.createElement;
  const ErrorBoundary = makeErrorBoundary(React);

  const api = {
    call(path, params) {
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries(params || {})) {
        if (v == null || v === '') continue;
        if (Array.isArray(v)) { if (v.length) q.set(k, v.join(',')); } else q.set(k, String(v));
      }
      const qs = q.toString();
      const url = '/token-tally-api/' + path + (qs ? '?' + qs : '');
      // 桌面端自定义协议偶尔会让未知路径的请求一直挂起（不返回也不报错）。
      // 用 Promise.race 保证一定超时：即使 fetch 永不 settle，界面也能退出「统计中…」并显示重试。
      const ctl = typeof AbortController === 'function' ? new AbortController() : null;
      const request = fetch(url, ctl ? { signal: ctl.signal } : undefined).then((r) => {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      });
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          try { ctl && ctl.abort(); } catch { /* ignore */ }
          reject(new Error('timeout'));
        }, REQUEST_TIMEOUT_MS);
        request.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
      });
    },
  };

  const { App } = createUI(React, api);

  // 全部颜色走 DSH 官方主题 token（--dsw-alias-*），深浅主题自动跟随，无写死色。
  const CSS = ''+ '.mca-root{--mca-text:var(--dsw-alias-label-primary);--mca-muted:var(--dsw-alias-label-secondary);--mca-faint:var(--dsw-alias-label-secondary);--mca-border:var(--dsw-alias-border-l1);--mca-surface:var(--dsw-alias-bg-layer-1);--mca-hover:var(--dsw-alias-bg-layer-2);--mca-ax:var(--dsw-alias-label-secondary);--mca-grid:var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary);font-family:system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;font-size:13px;padding:4px 2px}.mca-anim-bar{transform-box:fill-box;transform-origin:center bottom;animation:mca-bar-in .6s ease-out both;animation-delay:calc(var(--mca-delay,0) * 40ms);will-change:transform,opacity;transition:filter .16s ease,opacity .16s ease}.mca-anim-bar:hover{filter:brightness(1.35);opacity:1}.mca-stack-hit{cursor:crosshair}.mca-stack-hit:hover{fill:var(--mca-hover);fill-opacity:.18}.mca-anim-point{transition:r .16s ease,stroke-width .16s ease}.mca-anim-point:hover{r:5;stroke:var(--mca-text);stroke-width:1.5}.mca-anim-line{transition:filter .16s ease,opacity .16s ease}.mca-anim-line:hover{filter:brightness(1.3)}.mca-anim-line{animation:mca-line-in .9s linear both;animation-delay:calc(var(--mca-delay,0) * 55ms)}.mca-anim-point{animation:mca-point-in .3s ease-out both;animation-delay:calc(var(--mca-delay,0) * 42ms)}.mca-anim-heat{transform-box:fill-box;transform-origin:center;animation:mca-heat-in .52s ease-out both;animation-delay:calc(var(--mca-delay,0) * 18ms)}.mca-anim-legend{animation:mca-fade-up .48s ease-out both;animation-delay:calc(var(--mca-delay,0) * 45ms)}.mca-delay-0{--mca-delay:0}.mca-delay-1{--mca-delay:1}.mca-delay-2{--mca-delay:2}.mca-delay-3{--mca-delay:3}.mca-delay-4{--mca-delay:4}.mca-delay-5{--mca-delay:5}.mca-delay-6{--mca-delay:6}.mca-delay-7{--mca-delay:7}.mca-delay-8{--mca-delay:8}.mca-delay-9{--mca-delay:9}.mca-delay-10{--mca-delay:10}.mca-delay-11{--mca-delay:11}.mca-delay-12{--mca-delay:12}@keyframes mca-bar-in{0%{opacity:0;transform:scaleY(0.1)}60%{opacity:1;transform:scaleY(1.03)}82%{transform:scaleY(0.98)}100%{opacity:1;transform:scaleY(1)}}@keyframes mca-line-in{from{opacity:0;stroke-dasharray:0 100;stroke-dashoffset:0}to{opacity:1;stroke-dasharray:100 0;stroke-dashoffset:0}}@keyframes mca-point-in{from{opacity:0;transform:scale(.2)}to{opacity:1;transform:scale(1)}}@keyframes mca-heat-in{from{opacity:0;transform:scale(.35)}to{opacity:1;transform:scale(1)}}@keyframes mca-fade-up{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}@media (prefers-reduced-motion:reduce){.mca-root *,.mca-root *::before,.mca-root *::after{animation-duration:1ms!important;animation-delay:0ms!important;transition-duration:1ms!important}}.mca-root{--mca-c1:oklch(62.3% .214 259.815);--mca-c2:oklch(70.4% .14 182.503);--mca-c3:oklch(76.9% .188 70.08);--mca-c4:oklch(72.3% .219 149.579);--mca-c5:oklch(63.7% .237 25.331);--mca-c6:oklch(62.7% .265 303.9);--mca-c7:oklch(65.6% .241 354.308);--mca-c8:oklch(60.6% .25 292.717);--mca-c9:oklch(58.5% .233 277.117);--mca-c10:oklch(70.5% .213 47.604);--mca-c11:oklch(70.4% .04 256.788);--mca-c12:oklch(55.6% 0 none);--mca-h0:color-mix(in srgb,var(--dsw-alias-label-secondary) 16%,transparent);--mca-h1:color-mix(in srgb,var(--mca-c1) 28%,transparent);--mca-h2:color-mix(in srgb,var(--mca-c1) 50%,transparent);--mca-h3:color-mix(in srgb,var(--mca-c1) 72%,transparent);--mca-h4:color-mix(in srgb,var(--mca-c1) 92%,transparent)}.mca-filters{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:12px}.mca-gran-label{color:var(--mca-muted);font-size:11px;margin-left:2px}.mca-settings-btn{border:1px solid var(--mca-border);background:var(--mca-surface);color:var(--mca-muted);border-radius:7px;padding:4px 9px;font-size:12px;cursor:pointer}.mca-settings-btn:hover{color:var(--mca-text);border-color:var(--mca-text)}.mca-modal-backdrop{position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,.48);display:flex;align-items:center;justify-content:center;padding:24px}.mca-price-modal{width:min(980px,calc(100vw - 48px));max-height:min(760px,calc(100vh - 48px));overflow:hidden;background:var(--mca-surface);border:1px solid var(--mca-border);border-radius:14px;box-shadow:0 18px 60px rgba(0,0,0,.36);display:flex;flex-direction:column;color:var(--mca-text)}.mca-price-head{display:flex;justify-content:space-between;align-items:flex-start;padding:20px 24px 14px;border-bottom:1px solid var(--mca-border)}.mca-price-title{font-size:18px;font-weight:650}.mca-price-sub,.mca-price-note,.mca-price-status{color:var(--mca-muted);font-size:12px}.mca-price-sub{margin-top:5px}.mca-price-note{padding:12px 24px;line-height:1.6;background:var(--mca-hover)}.mca-icon-btn{border:0;background:transparent;color:var(--mca-muted);font-size:22px;cursor:pointer}.mca-price-toolbar{display:flex;align-items:center;justify-content:space-between;padding:14px 24px}.mca-price-toolbar select{margin-left:8px;background:var(--mca-surface);color:var(--mca-text);border:1px solid var(--mca-border);border-radius:7px;padding:6px 10px}.mca-price-search{width:170px;margin-left:8px;background:var(--mca-hover);color:var(--mca-text);border:1px solid var(--mca-border);border-radius:7px;padding:6px 9px;font-size:12px}.mca-price-help{padding:0 24px 12px;color:var(--mca-muted);font-size:11px}.mca-price-table-wrap{overflow:auto;padding:0 24px;flex:1}.mca-price-table{width:100%;border-collapse:collapse;font-size:12px}.mca-price-table th{color:var(--mca-muted);font-weight:550;text-align:left;padding:9px 7px;border-bottom:1px solid var(--mca-border);white-space:nowrap}.mca-price-table td{padding:7px;border-bottom:1px solid color-mix(in srgb,var(--mca-border) 60%,transparent)}.mca-price-table input{box-sizing:border-box;width:100%;min-width:72px;background:var(--mca-hover);color:var(--mca-text);border:1px solid transparent;border-radius:5px;padding:6px}.mca-price-table input:focus{border-color:var(--mca-text);outline:0}.mca-price-table td:nth-child(1) input{min-width:110px}.mca-price-table td:nth-child(2) input{min-width:180px}.mca-remove-btn{border:0;background:transparent;color:var(--mca-muted);cursor:pointer}.mca-remove-btn:hover{color:var(--mca-text)}.mca-price-foot{display:flex;align-items:center;justify-content:flex-end;gap:10px;padding:14px 24px;border-top:1px solid var(--mca-border)}.mca-price-status{margin-right:auto}@media(max-width:760px){.mca-modal-backdrop{padding:10px}.mca-price-modal{width:100%;max-height:calc(100vh - 20px)}.mca-price-head,.mca-price-toolbar,.mca-price-foot{padding-left:16px;padding-right:16px}.mca-price-table-wrap{padding:0 16px}}.mca-heat-day-label{font-family:"Segoe UI","Microsoft YaHei","PingFang SC",sans-serif;font-size:10px;font-weight:500;fill:var(--mca-muted)}.mca-heat-month-label{font-family:"Segoe UI","Microsoft YaHei","PingFang SC",sans-serif;font-size:11px;font-weight:600;fill:var(--mca-text)}.mca-heat-legend-label{font-family:"Segoe UI","Microsoft YaHei","PingFang SC",sans-serif;font-size:11px;font-weight:500;fill:var(--mca-muted)}.mca-granularity{background:var(--mca-hover);border-radius:7px}.mca-pills{display:inline-flex;align-items:center;gap:2px;border-radius:999px;padding:2px;flex-wrap:wrap;border:1px solid var(--mca-border)}.mca-pill{border:none;background:transparent;color:var(--mca-muted);border-radius:999px;padding:3px 10px;font-size:12px;cursor:pointer;font-family:inherit}.mca-pill:hover{color:var(--mca-text)}.mca-pill.on{background:var(--mca-text);color:var(--mca-surface);font-weight:600}.mca-pill.sm{font-size:11px;padding:2px 8px}.mca-custom{display:inline-flex;align-items:center;gap:6px}.mca-custom input{border:1px solid var(--mca-border);background:var(--mca-surface);color:var(--mca-text);border-radius:4px;padding:2px 6px;font-size:12px;font-family:inherit}.mca-sep{color:var(--mca-faint)}.mca-drop{position:relative}.mca-drop-btn{cursor:pointer;list-style:none;border:1px solid var(--mca-border);border-radius:999px;padding:3px 12px;font-size:12px;color:var(--mca-muted);background:var(--mca-surface);font-family:inherit}.mca-drop-btn::-webkit-details-marker{display:none}.mca-count{display:inline-block;margin-left:6px;padding:0 6px;border-radius:999px;background:var(--mca-text);color:var(--mca-surface);font-weight:600}.mca-menu{position:absolute;z-index:60;top:calc(100% + 4px);left:0;min-width:240px;max-height:280px;overflow:auto;background:var(--mca-surface);border:1px solid var(--mca-border);border-radius:8px;box-shadow:0 8px 20px rgba(0,0,0,.12);padding:6px}.mca-vendor-name{font-size:11px;color:var(--mca-faint);padding:4px 6px 2px;font-weight:600}.mca-menu-item{display:flex;align-items:center;gap:6px;padding:3px 6px;border-radius:4px;font-size:12px;color:var(--mca-text);cursor:pointer}.mca-menu-item:hover{background:var(--mca-hover)}.mca-clear{border:none;background:none;color:var(--dsw-alias-state-error-primary);cursor:pointer;font-size:12px;font-family:inherit;padding:3px 6px}.mca-busy{color:var(--mca-muted);font-size:11px}.mca-err{color:var(--dsw-alias-state-error-primary);font-size:11px}.mca-kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:12px}@media (max-width:760px){.mca-kpis{grid-template-columns:repeat(2,1fr)}}.mca-kpi{border:1px solid var(--mca-border);background:var(--mca-surface);border-radius:8px;padding:12px 14px;min-width:0}.mca-kpi-label{font-size:12px;color:var(--mca-muted);margin-bottom:4px}.mca-kpi-value{font-size:22px;font-weight:700;font-variant-numeric:tabular-nums;color:var(--mca-text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.mca-kpi-sub{font-size:11px;color:var(--mca-faint);margin-top:2px}.mca-kpi.mca-dim .mca-kpi-value{color:var(--mca-faint)}.mca-tabs{display:flex;justify-content:flex-end;gap:2px;margin-bottom:12px}.mca-card{border:1px solid var(--mca-border);background:var(--mca-surface);border-radius:8px;padding:16px 18px;margin-bottom:12px;min-width:0}.mca-card-head{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:12px}.mca-card-title{font-size:14px;font-weight:600;color:var(--mca-text)}.mca-card-tools{display:inline-flex;align-items:center;gap:8px;flex-wrap:wrap}.mca-note{font-size:11px;color:var(--mca-faint)}.mca-svg{display:block;width:100%;height:auto;font-family:system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}.mca-ax{font-size:11px;fill:var(--mca-ax);font-family:ui-monospace,Consolas,monospace}.mca-leg{font-size:12px;fill:var(--mca-text);font-family:system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}.mca-grid{stroke:var(--mca-grid);stroke-width:1}.mca-h0{fill:var(--mca-h0);transition:filter .16s ease,stroke .16s ease}.mca-h1{fill:var(--mca-h1);transition:filter .16s ease,stroke .16s ease}.mca-h2{fill:var(--mca-h2);transition:filter .16s ease,stroke .16s ease}.mca-h3{fill:var(--mca-h3);transition:filter .16s ease,stroke .16s ease}.mca-h4{fill:var(--mca-h4);transition:filter .16s ease,stroke .16s ease}.mca-h0:hover,.mca-h1:hover,.mca-h2:hover,.mca-h3:hover,.mca-h4:hover{filter:brightness(1.35);stroke:var(--mca-text);stroke-width:1}.mca-donut-wrap{display:flex;align-items:center;gap:26px;flex-wrap:wrap;padding:6px 2px}.mca-donut{width:260px;height:auto;flex:none}.mca-center-v{font-size:20px;font-weight:700;fill:var(--mca-text);font-variant-numeric:tabular-nums;font-family:system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}.mca-center-l{font-size:11px;fill:var(--mca-faint);font-family:system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}.mca-leg-col{display:flex;flex-direction:column;gap:6px;min-width:0;flex:1}.mca-leg-item{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--mca-text);min-width:0;transition:color .16s ease,transform .16s ease}.mca-leg-item:hover{color:var(--mca-text);transform:translateX(2px)}.mca-dot{width:10px;height:10px;border-radius:50%;flex:none}.mca-leg-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mca-leg-pct{color:var(--mca-faint);font-variant-numeric:tabular-nums}.mca-rank{display:flex;flex-direction:column;gap:6px}.mca-rank-row{display:flex;align-items:center;gap:10px;min-width:0}.mca-rank-name{width:230px;flex:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--mca-text)}.mca-rank-track{flex:1;height:14px;border-radius:4px;background:var(--mca-hover);overflow:hidden;min-width:0}.mca-rank-fill{display:block;height:100%;background:var(--mca-c1);border-radius:4px;transition:filter .16s ease,transform .16s ease}.mca-rank-row:hover .mca-rank-fill{filter:brightness(1.35);transform:scaleY(1.12)}.mca-rank-row:hover{background:var(--mca-hover);border-radius:5px}.mca-rank-val{width:90px;flex:none;text-align:right;color:var(--mca-muted);font-variant-numeric:tabular-nums}.mca-table-wrap{overflow-x:auto}.mca-compare-scroll{max-height:420px;overflow:auto;overscroll-behavior:contain;border-radius:6px}.mca-compare-scroll .mca-table-wrap{overflow:visible}.mca-compare-scroll .mca-table thead th{position:sticky;top:0;z-index:2;box-shadow:0 1px 0 var(--mca-border);}.mca-heat-wrap{overflow-x:auto;padding-bottom:4px}.mca-chart-wrap{position:relative;overflow-x:auto;overscroll-behavior:contain}.mca-chart-wrap svg{min-width:760px}.mca-chart-tooltip{position:absolute;display:none;pointer-events:none;min-width:180px;max-width:280px;padding:8px 10px;border:1px solid var(--mca-border);border-radius:6px;background:var(--mca-surface);color:var(--mca-text);box-shadow:0 6px 20px rgba(0,0,0,.28);font-size:12px;line-height:1.45;z-index:4}.mca-chart-tooltip.on{display:block}.mca-stack-tip{font-size:12px}.mca-stack-tip strong{display:block;margin-bottom:4px;color:var(--mca-text)}.mca-heat-wrap .mca-svg{min-width:640px}.mca-table{width:100%;border-collapse:collapse;min-width:760px}.mca-table th{font-size:13px;font-weight:650;line-height:1.35;letter-spacing:.01em;color:var(--mca-text);text-align:left;padding:10px 12px;border-bottom:1px solid var(--mca-border);background:color-mix(in srgb,var(--mca-surface) 72%,transparent);cursor:pointer;white-space:nowrap;user-select:none}.mca-table th.num{text-align:right}.mca-table td{font-size:12px;color:var(--mca-text);padding:6px 10px;border-bottom:1px solid var(--mca-hover);font-variant-numeric:tabular-nums;white-space:nowrap}.mca-table td.num{text-align:right}.mca-table tbody tr:hover td{background:var(--mca-hover)}.mca-empty{padding:28px 0;text-align:center;color:var(--mca-faint);font-size:12px;width:100%}.mca-split{display:flex;gap:20px;align-items:flex-start}.mca-split-main{flex:1;min-width:0}.mca-split-side{width:280px;flex:none}@media (max-width:900px){.mca-split{flex-direction:column}.mca-split-side{width:100%}}@property --progress{syntax:"<number>";initial-value:0;inherits:true}.mca-donut-grow{animation:mca-donut-grow .95s cubic-bezier(.25,.5,.5,1) both}@media(prefers-reduced-motion:reduce){.mca-root .mca-donut-grow{animation:none}}.mca-donut-arc{stroke-dasharray:calc(clamp(0px,var(--progress,1)*var(--paint-total) - var(--paint-start),var(--seg-len))) var(--circ)}@keyframes mca-donut-grow{from{--progress:0}to{--progress:1}}';

  const CSS_OVERRIDES = '.mca-boundary{min-width:0}.mca-kpis{grid-template-columns:repeat(auto-fit,minmax(150px,1fr))}.mca-kpis-placeholder{grid-template-columns:1fr}.mca-error-state{display:flex;flex-direction:column;align-items:flex-start;gap:12px}.mca-fatal{padding:16px}.mca-fatal h2{margin:0;font-size:18px}.mca-fatal p{margin:0}.mca-retry{border:0;background:transparent;color:inherit;text-decoration:underline;cursor:pointer;padding:0 0 0 4px}.mca-chart-nav{display:inline-flex;gap:4px}.mca-model-item{padding-left:22px}.mca-vendor-name{font-weight:600}.mca-price-modal:focus{outline:2px solid var(--mca-c1);outline-offset:-2px}.mca-cmp-row:focus,.mca-table th[role="button"]:focus{outline:2px solid var(--mca-c1);outline-offset:-2px}.mca-chart-wrap svg{max-height:330px}.mca-heat-wrap svg{width:100%;height:auto;min-width:0}.mca-line-hit{fill:none;cursor:pointer}.mca-anim-line:has(~ .mca-line-hit:hover){filter:brightness(1.35)}.mca-svg:has(.mca-line-hit:hover) .mca-anim-line:not(:has(~ .mca-line-hit:hover)){opacity:.35}.mca-bar-seg{cursor:pointer;transition:filter .14s ease}.mca-bar-seg:hover{filter:brightness(1.15);stroke:var(--mca-c1);stroke-width:1.2;stroke-opacity:.9}.mca-stack-hit:hover{fill:transparent}.mca-pop{transition:transform .22s ease-out}.mca-donut-arc{transition:opacity .16s ease,filter .16s ease;cursor:pointer}.mca-donut:has(.mca-pop:hover) .mca-pop:not(:hover) .mca-donut-arc{opacity:.28}.mca-pop:hover .mca-donut-arc{opacity:1}.mca-pop:hover{transform:translate(calc(var(--dx,0)*1px),calc(var(--dy,0)*1px))}.mca-pop:hover .mca-donut-arc{filter:brightness(1.4)}.mca-split-side{display:flex;align-items:center;justify-content:center}.mca-donut-wide{display:flex;align-items:center;gap:8px;width:100%}.mca-donut-wide .mca-donut{width:auto;flex:1 1 460px;min-width:0;max-width:100%;height:auto}.mca-donut-leader{fill:none;stroke-width:1;opacity:.75}.mca-donut-label{font-size:12px;font-weight:500}.mca-donut-wide .mca-center-v{font-size:13px}.mca-donut-wide .mca-center-l{font-size:8px}.mca-axis-label{font-size:10px;fill:var(--mca-ax)}.mca-rank-svg .mca-ax{font-size:9px;fill:var(--mca-muted)}.mca-rank-svg .mca-axis-label{font-size:8.6px;fill:var(--mca-muted)}.mca-rank-svg .mca-leg{font-size:5.6px}.mca-filters{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin:2px 0 10px}.mca-toolbar-main{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}.mca-toolbar-side{display:flex;align-items:center;gap:8px;margin-left:auto}.mca-seg{display:inline-flex;align-items:center;gap:2px;padding:2px;border:1px solid var(--mca-border);border-radius:9px;background:color-mix(in srgb,var(--mca-surface) 60%,transparent)}.mca-seg-btn{appearance:none;border:0;background:transparent;color:var(--mca-muted);font:inherit;font-size:12px;line-height:1;padding:5px 9px;border-radius:7px;cursor:pointer;transition:background .14s ease,color .14s ease}.mca-seg-btn:hover{background:var(--mca-hover);color:var(--mca-text)}.mca-seg-btn.on{background:var(--mca-c1);color:#fff;font-weight:600}.mca-seg-sm .mca-seg-btn{font-size:11px;padding:4px 7px}.mca-chips{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:0 0 10px}.mca-chip{display:inline-flex;align-items:center;gap:2px;max-width:240px;padding:2px 4px 2px 8px;border-radius:999px;border:1px solid color-mix(in srgb,var(--mca-c1) 45%,transparent);background:color-mix(in srgb,var(--mca-c1) 12%,transparent);font-size:11px}.mca-chip-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mca-chip-x{appearance:none;border:0;background:transparent;color:var(--mca-muted);cursor:pointer;font-size:12px;line-height:1;padding:1px 4px;border-radius:999px}.mca-chip-x:hover{color:var(--mca-text);background:var(--mca-hover)}.mca-card{border:1px solid var(--mca-border);border-radius:12px;padding:14px 16px 10px;margin-bottom:12px;background:color-mix(in srgb,var(--mca-surface) 88%,transparent);transition:border-color .16s ease,box-shadow .16s ease}.mca-card:hover{border-color:color-mix(in srgb,var(--mca-c1) 30%,var(--mca-border))}.mca-card-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:8px}.mca-card-title-wrap{display:flex;flex-direction:column;gap:2px;min-width:0}.mca-card-title{font-size:13px;font-weight:600;letter-spacing:.01em}.mca-card-sub{font-size:11px;color:var(--mca-muted);font-variant-numeric:tabular-nums}.mca-card-tools{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end}.mca-tabs{display:flex;align-items:center;gap:2px;margin:0 0 10px;border-bottom:1px solid var(--mca-border);padding-bottom:2px}.mca-tab{appearance:none;border:0;background:transparent;color:var(--mca-muted);font:inherit;font-size:12px;padding:6px 10px 7px;cursor:pointer;border-radius:8px 8px 0 0;transition:color .14s ease,background .14s ease}.mca-tab:hover{color:var(--mca-text);background:var(--mca-hover)}.mca-tab.on{color:var(--mca-text);font-weight:600;box-shadow:inset 0 -2px 0 var(--mca-c1)}.mca-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:12px}.mca-kpi{border:1px solid var(--mca-border);border-radius:12px;padding:11px 13px;background:color-mix(in srgb,var(--mca-surface) 88%,transparent);transition:transform .16s ease,border-color .16s ease}.mca-kpi:hover{transform:translateY(-1px);border-color:color-mix(in srgb,var(--mca-c1) 30%,var(--mca-border))}.mca-kpi-label{font-size:11px;color:var(--mca-muted);margin-bottom:4px}.mca-kpi-value{font-size:20px;font-weight:650;line-height:1.15;font-variant-numeric:tabular-nums;letter-spacing:-.01em}.mca-kpi-sub{font-size:10px;color:var(--mca-muted);margin-top:3px}.mca-kpi-skeleton{border-style:dashed}.mca-skeleton{display:block;border-radius:6px;background:linear-gradient(90deg,var(--mca-hover) 25%,color-mix(in srgb,var(--mca-hover) 55%,transparent) 37%,var(--mca-hover) 63%);background-size:400% 100%;animation:mca-shimmer 1.4s ease infinite}.mca-skeleton-label{height:9px;width:52%;margin-bottom:8px}.mca-skeleton-value{height:20px;width:78%}@keyframes mca-shimmer{from{background-position:100% 0}to{background-position:0 0}}.mca-body{animation:mca-fade-in .26s ease both}@keyframes mca-fade-in{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}.mca-bar-seg{cursor:pointer}.mca-donut-arc{cursor:pointer}.mca-split{gap:14px}.mca-split-side{flex:0 0 clamp(180px,26%,240px)}.mca-split-side svg{max-width:100%;height:auto}.mca-leg-item{gap:6px}.mca-leg-name{font-size:11px}.mca-leg-pct{font-size:11px;color:var(--mca-muted);font-variant-numeric:tabular-nums}.mca-heat-wrap{padding:2px 0 0}.mca-anim-bar:hover{filter:none}.mca-stack-hit:hover{fill:transparent}@media (max-width:900px){.mca-split{flex-direction:column}.mca-split-side{flex:1 1 auto;align-self:center}.mca-toolbar-side{margin-left:0}}@keyframes mca-line-draw{from{stroke-dashoffset:100}to{stroke-dashoffset:0}}.mca-anim-line{fill:none;stroke-width:2;stroke-linejoin:round;stroke-linecap:round;stroke-dasharray:100;stroke-dashoffset:100;animation:mca-line-draw .9s cubic-bezier(.4,0,.2,1) both}@keyframes mca-dot-pop{from{opacity:0;transform:scale(.35)}60%{opacity:1}to{opacity:1;transform:scale(1)}}.mca-anim-point{transform-box:fill-box;transform-origin:center;animation:mca-dot-pop .2s ease-out both}.mca-anim-point:hover{transform:scale(1.5);transition:transform .12s ease}.mca-rank-svg{max-height:none}';

  function injectStyles() {
    if (typeof document === 'undefined') return () => {};
    const tag = document.createElement('style');
    tag.id = 'mca-styles';
    tag.textContent = CSS + CSS_OVERRIDES;
    document.head.appendChild(tag);
    return () => { tag.remove(); };
  }

  const inject = ['slots'];
  function apply(ctx) {
    const slots = ctx.get && ctx.get('slots');
    if (slots === undefined) return;
    registerStylesEffect(ctx, injectStyles);
    // 左侧导航栏快捷入口：panellist 条目 id 与 main key 同名（点击图标 → 主面板切换），dsh-context 同款
    slots.inject('main', () => slots.register(
      { name: 'main', key: 'token-tally', label: () => 'Token 台账' },
      () => h(ErrorBoundary, null, h(App, null)),
    ));
    slots.inject('sidebar.panellist', () => slots.register(
      { name: 'sidebar.panellist', id: 'token-tally', order: 45, label: () => 'Token 台账' },
      (props) => h(PanelIcon, { size: props && typeof props.size === 'number' ? props.size : 18 }),
    ));
  }

  function PanelIcon(props) {
    const s = props.size;
    return h('svg', {
      width: s, height: s, viewBox: '0 0 16 16', fill: 'currentColor',
      'aria-hidden': 'true', focusable: 'false',
    },
      h('rect', { x: 1.5, y: 2.2, width: 13, height: 2.6, rx: 1.3 }),
      h('rect', { x: 1.5, y: 6.7, width: 8.2, height: 2.6, rx: 1.3 }),
      h('rect', { x: 1.5, y: 11.2, width: 10.6, height: 2.6, rx: 1.3 }),
    );
  }

  return { inject, apply };
}
    var __mca = makeModule(React);
    module.exports.inject = __mca.inject;
    module.exports.apply = __mca.apply;
    return module.exports;
  }
});
