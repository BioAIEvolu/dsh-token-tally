// 手写 SVG 图表（纯字符串构建，无第三方依赖；tooltips 用原生 <title>）
import { esc, fmtTokens, fmtCost, fmtInt, fmtDay, fmtFullDay, fmtMs, fmtSpeed, fmtPct, displayModelName } from './format.js';

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

export function modelColor(i) { return PALETTE[((i % PALETTE.length) + PALETTE.length) % PALETTE.length]; }

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
export function stackedBars(stacks, opts = {}) {
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
export function trendLines(stacks, opts = {}) {
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
export function donut(items, opts = {}) {
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
export function rankingBars(rows, opts = {}) {
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

export function alignWeekStart(tsSec, tz) {
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

export function calendarHeatmap(days, opts = {}) {
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
  // 入场动画挂在整组上（单次 fade-in）：53×7≈376 个格子若逐格动画，每个入场帧都要
  // 对整张宽幅 SVG 重算样式并整体重绘，与同屏的堆叠柱/环形图入场竞争主线程，
  // 表现为环形图扫描卡顿。整组一次动画把每帧样式重算从 376 个元素降到 1 个。
  for (let i = 0; i < daysInRange; i++) {
    const day = startDay + i * DAY;
    const col = Math.floor(i / 7); const row = i % 7;
    const tokens = map.get(day) || 0;
    let lv = 0;
    for (let k = HEAT_LEVELS.length - 1; k >= 0; k--) if (tokens >= HEAT_LEVELS[k]) { lv = k + 1; break; }
    const x = X0 + col * (CS + GAP); const y = Y0 + row * (CS + GAP);
    cells += '<rect x="' + x + '" y="' + y + '" width="' + CS + '" height="' + CS + '" rx="2" tabindex="0" class="mca-h' + lv + '"><title>' + esc(fmtFullDay(day, tz)) + ': ' + esc(fmtTokens(tokens)) + ' tokens</title></rect>';
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
    '<g>' + months + '</g>' + rowLabels + '<g class="mca-heat-entrance">' + cells + '</g>' +
    '<g class="mca-heat-legend" transform="translate(' + X0 + ' ' + (H2 - 20) + ')">' +
    '<text x="0" y="10" class="mca-heat-legend-label">少</text>' +
    [0, 1, 2, 3, 4].map((i) => '<rect x="' + (22 + i * (CS + GAP)) + '" y="0" width="' + CS + '" height="' + CS + '" rx="2" class="mca-h' + i + '"/>').join('') +
    '<text x="' + (22 + 5 * (CS + GAP) + 2) + '" y="10" class="mca-heat-legend-label">多</text></g></svg>';
}

/** 模型对比表（列排序由调用方 ui 处理；此处输出行数据已排序） */
export function compareTable(models, opts = {}) {
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
