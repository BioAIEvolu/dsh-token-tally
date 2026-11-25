import test from 'node:test';
import assert from 'node:assert/strict';
import { esc, fmtTokens, fmtCost, fmtMs, fmtPct, fmtDay, fmtFullDay, fmtInt, displayModelName, csvCell } from '../src/client/format.js';
import { stackedBars, trendLines, donut, rankingBars, calendarHeatmap, compareTable, alignWeekStart } from '../src/client/charts.js';

const now = 1794000000;

function fakeStacks() {
  return [
    { start: now - 7200, cells: [
      { provider: 'a', model: 'm-1', count: 3, tokens: 300, cost: 0.3, priced: true },
      { provider: 'b', model: 'm-2', count: 1, tokens: 100, cost: 0, priced: false },
    ] },
    { start: now - 3600, cells: [
      { provider: 'a', model: 'm-1', count: 2, tokens: 200, cost: 0.2, priced: true },
    ] },
  ];
}

test('format：基础口径', () => {
  assert.equal(fmtTokens(1500), '1.5K');
  assert.equal(fmtTokens(2.34e8), '234.0M');
  assert.equal(fmtCost(null), '未配置');
  assert.equal(fmtCost(1.5), '¥1.50');
  assert.equal(fmtCost(1.5, 'USD'), '$1.50');
  assert.equal(fmtMs(5000), '5.00s');
  assert.equal(fmtPct(0.965), '96.5%');
  assert.equal(displayModelName('(compaction)'), '上下文压缩');
  assert.equal(displayModelName('provider/(compaction)'), 'provider/上下文压缩');
  assert.equal(esc('<a & "b">'), '&lt;a &amp; &quot;b&quot;&gt;');
  assert.ok(/^\d{2}-\d{2} \d{2}:00$/.test(fmtDay(now, 'hour', 0)));
  assert.ok(/^\d{2}-\d{2} \d{2}:\d{2}$/.test(fmtDay(now, 'minute', 0)));
});

test('csvCell：转义分隔符并阻断公式注入', () => {
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(csvCell('a,"b"\n'), '"a,""b""\n"');
  assert.equal(csvCell('=1+1'), "'=1+1");
  assert.equal(csvCell('  @SUM(A1)'), "'  @SUM(A1)");
  assert.equal(csvCell('+cmd'), "'+cmd");
  assert.equal(csvCell('-2+3'), "'-2+3");
  assert.equal(csvCell(-2), '-2');
  assert.equal(csvCell(null), '');
});

test('stackedBars：段数/无 NaN/图例', () => {
  const svg = stackedBars(fakeStacks(), { metric: 'tokens' });
  assert.ok(svg.includes('viewBox="0 0 920 260"'));
  assert.ok(!svg.includes('NaN'));
  const segs = svg.match(/style="fill:var\(--mca-c\d+\)"/g) || [];
  assert.ok(segs.length >= 3 + 2); // 3 段 + 图例 2
  assert.ok(svg.includes('<title>')); // 原生 tooltip
  assert.ok(svg.includes('mca-anim-bar'), 'bars animate in');
  assert.ok(svg.includes('上下文压缩') === false, 'fixture has no compaction');
  const pctSvg = stackedBars(fakeStacks(), { metric: 'tokens', percentMode: true });
  assert.ok(pctSvg.includes('25%'));
});

test('stackedBars：整柱 <g> 连续生长，分层色块不再各自动画', () => {
  const svg = stackedBars(fakeStacks(), { metric: 'tokens' });
  // 每根有数据的柱子一个动画组；柱子数量 = 桶数
  assert.equal((svg.match(/<g class="mca-anim-bar/g) || []).length, 2);
  // 分段 rect 自身不再挂生长动画类（避免上层色块凭空出现）
  assert.equal((svg.match(/<rect class="mca-anim-bar/g) || []).length, 0);
  // 组内分段数不变（色块带 mca-bar-seg，用于单块悬停高亮）
  assert.equal((svg.match(/<rect class="mca-bar-seg"/g) || []).length, 3);
});

function legendOf(svgLike, isHtml) {
  const out = new Map();
  const re = isHtml
    ? /background:(var\(--mca-c\d+\))[^"]*"><\/span><span class="mca-leg-name"[^>]*>([^<]+)</g
    : /style="fill:(var\(--mca-c\d+\))"/g;
  if (isHtml) {
    let m2;
    while ((m2 = re.exec(svgLike))) out.set(m2[2], m2[1]);
    return out;
  }
  // SVG 图例：色块 rect 后紧跟同名 text，按相邻顺序还原配对
  const pairs = [...svgLike.matchAll(/style="fill:(var\(--mca-c\d+\))"[^>]*\/><text[^>]*>([^<]+)<\/text>/g)];
  for (const m of pairs) out.set(m[2], m[1]);
  return out;
}

/** 环形图引线标签的文字颜色（text 上 style="fill:var(--mca-cN)"） */
function labelColors(svg) {
  const out = new Map();
  const pairs = [...svg.matchAll(/style="fill:(var\(--mca-c\d+\))"[^>]*>([^<]+)<\/text>/g)];
  for (const m of pairs) out.set(m[2].trim(), m[1]);
  return out;
}

test('颜色跨图表一致：同一模型在堆叠柱/趋势/环形中同色，且与数据顺序无关', () => {
  const mk = (model, tokens) => ({ provider: 'p', model, count: 1, tokens, cost: 0.1, priced: true, currency: 'CNY' });
  const cellsA = [mk('m-1', 300), mk('m-2', 200), mk('m-3', 100)];
  const cellsB = [mk('m-3', 100), mk('m-1', 300), mk('m-2', 200)]; // 顺序打乱
  const barA = legendOf(stackedBars([{ start: now - 3600, cells: cellsA }], { metric: 'tokens' }), false);
  const barB = legendOf(stackedBars([{ start: now - 3600, cells: cellsB }], { metric: 'tokens' }), false);
  const trendA = legendOf(trendLines([{ start: now - 3600, cells: cellsA }], { metric: 'tokens' }), false);
  const items = [{ model: 'm-1', calls: 3, tokens: 300 }, { model: 'm-2', calls: 2, tokens: 200 }, { model: 'm-3', calls: 1, tokens: 100 }];
  // 环形图已去掉左侧列表，改为从引线标签的文字颜色取色
  const donutA = labelColors(donut(items, { metric: 'tokens' }));
  const donutB = labelColors(donut([...items].reverse(), { metric: 'tokens' }));
  for (const model of ['m-1', 'm-2', 'm-3']) {
    assert.ok(barA.has(model) && barB.has(model) && trendA.has(model) && donutA.has(model) && donutB.has(model), model + ' 出现在全部图例');
    const color = barA.get(model);
    assert.equal(barB.get(model), color, '堆叠柱内顺序无关：' + model);
    assert.equal(trendA.get(model), color, '趋势图同色：' + model);
    assert.equal(donutA.get(model), color, '环形图同色：' + model);
    assert.equal(donutB.get(model), color, '环形图顺序无关：' + model);
  }
});

test('donut：引线标签、无重复图例列表、紧凑模式只画环', () => {
  const items = [
    { provider: 'a', model: 'm-1', calls: 10, tokens: 500, cost: 1.2, priced: true },
    { provider: 'b', model: 'm-2', calls: 5, tokens: 300, cost: null, priced: false },
  ];
  const full = donut(items, { metric: 'tokens' });
  assert.ok(full.includes('mca-donut-arc'), '扇区带悬停类');
  assert.ok(!full.includes('mca-leg-col'), '不再输出与引线标签重复的左侧图例列表');
  assert.ok(full.includes('mca-donut-label'), '扇区外侧文字标签');
  assert.equal((full.match(/mca-donut-leader/g) || []).length, 2, '每个切片一条引线');
  assert.ok(full.includes('总 Tokens'), '保留中心总计');
  const compact = donut(items, { metric: 'tokens', compact: true });
  assert.ok(compact.includes('mca-donut-arc'), '紧凑模式仍有环');
  assert.ok(!compact.includes('mca-donut-leader'), '紧凑模式不画引线');
});

test('donut：扇区为独立环形扇段 + 背景色描边缝隙 + 弹出 + 短标签', () => {
  const items = [
    { provider: 'ark-agent-plan', model: 'glm-5.3-flash', calls: 6, tokens: 600, cost: 1, priced: true },
    { provider: 'codex', model: 'gpt-6.1-terra', calls: 4, tokens: 400, cost: 1, priced: true },
  ];
  const full = donut(items, { metric: 'tokens' });
  // 扇区是 stroke 的 circle（stroke-dasharray 单时间线方案）
  const arcs = full.match(/<circle[^>]*class="mca-donut-arc[^>]*>/g) || [];
  assert.equal(arcs.length, 2, '每个扇区一个 stroke circle');
  for (const a of arcs) {
    assert.ok(/stroke="[^"]*"/.test(a), 'circle 用 stroke 上色');
    assert.ok(/stroke-linecap="butt"/.test(a), 'linecap=butt 保持缝隙外观');
    const seg = /--seg-len:([\d.]+)/.exec(a);
    assert.ok(seg && Number(seg[1]) > 0, '扇区可见弧长 > 0（缝隙修剪封顶一半弧长）');
    assert.ok(/--circ:[\d.]+/.test(a), '周长逐图内联（compact r=76 / wide r=84 不同）');
    assert.ok(!/animation:/.test(a), '扇区不带独立动画（唯一时间线在插件级 CSS）');
  }
  assert.ok(full.includes('<g class="mca-donut-grow" style="--progress:1">'), '静态终态内联兜底（禁动画/reduced-motion 时呈完整环）');
  assert.ok(!full.includes('<style>'), '不再内联 keyframes（多图同名互相覆盖）');
  assert.ok(!full.includes('mca-arc-'), '无逐扇区 keyframes 残留');
  // 径向弹出向量在包裹层 .mca-pop（circle 自身只有 rotate）
  const pops = full.match(/<g class="mca-pop" style="--dx:-?[\d.]+;--dy:-?[\d.]+">/g) || [];
  assert.equal(pops.length, 2, '每个扇区一个弹出包裹层');
  for (const a of arcs) {
    assert.ok(/transform="rotate\(-90/.test(a), 'circle 带 rotate(-90) 让起点在 12点钟');
  }
  // 扇区组带整圆生长动画（单时间线方案：CSS 类提供动画，无内联 keyframes）
  assert.ok(/<g class="mca-donut-grow" style="--progress:1">/.test(full), '弧段组带生长动画类与静态兜底');
  // 扇区改为 circle + stroke，而非 path 扇段
  assert.ok(/<circle[^>]*class="mca-donut-arc"/.test(full), '扇区用 circle 实现');
  // 标签只显示模型名（无 provider 前缀），防压环；完整标识在 tooltip
  const labels = [...full.matchAll(/class="mca-donut-label"[^>]*>([^<]+)</g)].map((m) => m[1]);
  assert.deepEqual(labels.sort(), ['glm-5.3-flash', 'gpt-6.1-terra'], '标签只显示模型名');
  assert.ok(full.includes('ark-agent-plan/glm-5.3-flash'), '完整 provider/model 在 tooltip');
});

test('donut：极小扇区仍可见（缝隙修剪封顶一半弧长）', () => {
  const items = [
    { provider: 'a', model: 'big', calls: 9998, tokens: 9998, cost: 1, priced: true },
    { provider: 'b', model: 'tiny', calls: 2, tokens: 2, cost: 1, priced: true }, // 0.02%，远小于 1° 缝隙
  ];
  const svg = donut(items, { metric: 'tokens' });
  const tiny = /data-model="tiny"[^>]*style="[^"]*--seg-len:([\d.]+)/.exec(svg);
  assert.ok(tiny, '0.02% 小扇区存在');
  assert.ok(Number(tiny[1]) > 0, '小扇区弧长 > 0：缝隙修剪不会吞掉整段（旧行为 fullLen-1° 会变负/归零）');
});

test('donut：两种半径共用连续的描画长度，终帧仅保留设计间隙', () => {
  for (const compact of [true, false]) {
    for (const weights of [[60, 20, 20], [9998, 2], [100]]) {
      const items = weights.map((tokens, i) => ({ model: 'm' + i, tokens }));
      const svg = donut(items, { metric: 'tokens', compact });
      const circles = svg.match(/<circle[^>]*class="mca-donut-arc"[^>]*>/g);
      const circumference = 2 * Math.PI * (compact ? 76 : 84);
      let painted = 0;
      for (const [i, circle] of circles.entries()) {
        const variable = name => parseFloat(circle.match(new RegExp('--' + name + ':([^;]+)'))[1]);
        const start = variable('paint-start');
        const length = variable('seg-len');
        const total = variable('paint-total');
        const raw = circumference * weights[i] / weights.reduce((a, b) => a + b);
        const expectedGap = weights.length === 1 ? 0 : Math.min(circumference / 360, raw / 2);
        assert.ok(Math.abs(raw - length - expectedGap) < 1e-5);
        assert.ok(Math.abs(start - painted) < 1e-5, '下一色从上一色完成的同一进度接续');
        assert.ok(total - start >= length - 1e-5, '终帧可画满每段，包括最后一段');
        const dash = circle.match(/stroke-dasharray="([^"]+)"/)[1].split(/\s+/).map(Number);
        assert.ok(Math.abs(dash[0] - length) < 1e-5 && Math.abs(dash[1] - circumference) < 1e-5, '静态属性也是完整弧长');
        painted += length;
        if (i === circles.length - 1) assert.ok(Math.abs(painted - total) < 1e-5);
      }
    }
  }
});

test('trendLines：零值桶不画圆点（省 DOM 且不再堆在 0 轴线上）', () => {
  const stacks = [
    { start: now - 3600, cells: [{ provider: 'p', model: 'm-1', count: 2, tokens: 500, cost: 1, priced: true }] },
    { start: now - 1800, cells: [] }, // 空桶补零：线贴 0，但不应产生圆点
    { start: now, cells: [{ provider: 'p', model: 'm-1', count: 1, tokens: 300, cost: 1, priced: true }] },
  ];
  const svg = trendLines(stacks, { metric: 'tokens' });
  const dots = (svg.match(/<circle/g) || []).length;
  assert.equal(dots, 2, '只有两个非零数据点有圆点，零值桶不画');
  // 非零点的延迟 = 笔尖到达时刻（线性 900ms）
  const delays = [...svg.matchAll(/animation-delay:(\d+)ms/g)].map((m) => Number(m[1]));
  assert.deepEqual(delays, [0, 900]);
});

test('stackedBars：USD 费用与空数据空态', () => {
  const stacks = fakeStacks().map((b) => ({ ...b, cells: b.cells.map((c) => ({ ...c, currency: 'USD' })) }));
  const svg = stackedBars(stacks, { metric: 'cost' });
  assert.ok(svg.includes('$0.30'));
  assert.ok(svg.includes('$0.50'));
  assert.ok(!svg.includes('¥'));
  const empty = stackedBars([], { metric: 'cost' });
  assert.ok(empty.includes('mca-empty'));
  assert.ok(empty.includes('当前范围暂无数据'));
});

test('trendLines：折线不填充（防黑色遮挡）+ 归一化长度绘制 + 圆点跟随延迟', () => {
  const svg = trendLines(fakeStacks(), { metric: 'tokens' });
  const poly = /<polyline[^>]*>/.exec(svg)[0];
  assert.ok(poly.includes('fill="none"'), '折线必须 fill:none，否则闭合区域会被黑色填充');
  assert.ok(poly.includes('pathLength="100"'), '归一化长度用于从左到右绘制动画');
  assert.ok(!poly.includes('stroke-dasharray="2000"'), '不再使用未归一化的旧 dash 参数');
  // 每条折线自身延迟递增（跨线会重新从 0 开始，所以只校验第一条线）。
  // 每模型输出顺序：可见折线 → 命中线 → 圆点，第一条线的圆点落在第 3 个 polyline 之前。
  const thirdPoly = (() => { let i = -1; for (let k = 0; k < 3; k++) { i = svg.indexOf('<polyline', i + 1); if (i < 0) return svg.length; } return i; })();
  const firstLine = svg.slice(svg.indexOf('<polyline'), thirdPoly);
  const dots = [...firstLine.matchAll(/animation-delay:(\d+)ms/g)].map((m) => Number(m[1]));
  assert.ok(dots.length >= 2, '每个数据点都有圆点');
  assert.ok(dots.every((d, i) => i === 0 || d >= dots[i - 1]), '同一条线的延迟随位置递增，跟随线尖');
});

test('donut：孤岛标注引线也不得填充', () => {
  const svg = donut([{ provider: 'a', model: 'm-1', calls: 1, tokens: 10, cost: 1, priced: true }], { metric: 'tokens' });
  for (const m of svg.matchAll(/<polyline class="mca-donut-leader"[^>]*>/g)) {
    assert.ok(!/fill="(?!none)/.test(m[0]), '引线不应带填充色');
  }
});

test('trendLines：折线与圆点', () => {
  const svg = trendLines(fakeStacks(), {});
  assert.ok(svg.includes('<polyline'));
  assert.ok(svg.includes('mca-anim-line'), 'lines animate in');
  assert.ok((svg.match(/<circle/g) || []).length >= 3);
  assert.ok(!svg.includes('NaN'));
  // 线体悬浮提示：加宽透明命中线（显式 fill:none 防黑填充），带模型名 title
  const hit = /<polyline class="mca-line-hit"[^>]*>/.exec(svg);
  assert.ok(hit, '每条折线都有命中线');
  assert.ok(hit[0].includes('fill="none"'), '命中线必须 fill:none，否则下方被黑色填充');
  assert.ok(hit[0].includes('stroke="transparent"'), '命中线透明不遮挡可见折线');
  assert.ok(/<polyline class="mca-line-hit"[^>]*><title>[^<]+<\/title>/.test(svg), '命中线带模型名 tooltip');
  // 圆点在命中线之后绘制，保持最上层不被遮挡
  assert.ok(svg.indexOf('mca-line-hit') < svg.indexOf('<circle'), '圆点应绘制在命中线之上');
});

test('trendLines：缺桶补零，线段从左到右连续（newapi 式）', () => {
  const sparse = [
    { start: now - 7200, cells: [{ provider: 'a', model: 'm-1', count: 1, tokens: 100, cost: 0.1, priced: true }] },
    { start: now - 3600, cells: [] }, // 空桶
    { start: now, cells: [{ provider: 'a', model: 'm-1', count: 1, tokens: 50, cost: 0.1, priced: true }] },
  ];
  const svg = trendLines(sparse, { metric: 'tokens' });
  // 单一模型在全部 3 个桶都有折线顶点（含补零），线段横贯整个窗口；
  // 零值桶只贡献线段不画圆点（零值点跳过）。
  assert.equal((svg.match(/<circle/g) || []).length, 2);
  const points = /points="([^"]+)"/.exec(svg)[1].trim().split(/\s+/);
  assert.equal(points.length, 3);
  assert.ok(!svg.includes('NaN'));
});

test('trendLines：Y 轴按指标格式化并使用计价币种', () => {
  const stacks = [{ start: now, cells: [{ provider: 'a', model: 'm-1', count: 1, tokens: 2000, cost: 2, priced: true, currency: 'USD' }] }];
  const costSvg = trendLines(stacks, { metric: 'cost' });
  assert.ok(costSvg.includes('$1.00'));
  assert.ok(!costSvg.includes('¥'));
  const tokenSvg = trendLines(stacks, { metric: 'tokens' });
  assert.ok(tokenSvg.includes('>1.0K</text>'));
  assert.ok(trendLines([], {}).includes('mca-empty'));
});

test('donut：弧段与中心值，cost 未配置计 0', () => {
  const items = [
    { provider: 'a', model: 'm-1', calls: 10, tokens: 500, cost: 1.2, priced: true },
    { provider: 'b', model: 'm-2', calls: 5, tokens: 300, cost: null, priced: false },
  ];
  const c = donut(items, { metric: 'count' });
  assert.equal((c.match(/<circle[^>]*class="mca-donut-arc/g) || []).length, 2);
  assert.ok(c.includes('mca-donut-grow'), 'donut has circular growth animation');
  assert.ok(c.includes(fmtInt(15)));
  const costDonut = donut(items, { metric: 'cost' });
  assert.ok(costDonut.includes(fmtCost(1.2)));
  const usdDonut = donut(items.map((it) => ({ ...it, currency: 'USD' })), { metric: 'cost' });
  assert.ok(usdDonut.includes('$1.20'));
  assert.ok(!usdDonut.includes('¥'));
  const empty = donut([], { metric: 'count' });
  assert.ok(/class="mca-center-v"[^>]*>0<\/text>/.test(empty));
  assert.ok(donut([], { metric: 'tokens' }).includes('>0</text>'));
  assert.ok(donut([], { metric: 'cost', currency: 'USD' }).includes('>$0.00</text>'));
});

test('rankingBars：垂直柱 + 底部图例（无柱子标签）', () => {
  const rows = [
    { provider: 'a', model: 'm-1', calls: 2, totalTokens: 100, priced: false },
    { provider: 'b', model: 'm-2', calls: 8, totalTokens: 50, priced: true, cost: 3 },
  ];
  const svg = rankingBars(rows, { metric: 'count' });
  assert.ok(svg.includes('mca-rank-svg'), '垂直柱状图容器');
  assert.equal((svg.match(/class="mca-bar-seg"/g) || []).length, 2, '每模型一根柱');
  assert.ok(!svg.includes('mca-axis-label'), '柱子上无斜标签（避免与图例重复）');
  assert.ok(!(/rotate\(-\d+/.test(svg) && svg.includes('text-anchor')), '无倾斜文字标签');
  assert.ok(svg.indexOf('m-2') < svg.indexOf('m-1'), '按调用次数降序绘柱');
  const usd = rankingBars(rows.map((r) => ({ ...r, currency: 'USD' })), { metric: 'cost' });
  assert.ok(usd.includes('$3.00'));
  assert.ok(!usd.includes('¥'));
  assert.ok(rankingBars([], {}).includes('当前范围暂无数据'));
});

test('calendarHeatmap：历史日期网格与层级配色 + 月标签与星期标签', () => {
  const days = [{ day: now, tokens: 2e6 }];
  const svg = calendarHeatmap(days, { now, tz: 0 });
  assert.ok(svg.includes('mca-h2')); // 2e6 → 层级 2
  assert.ok(svg.includes(fmtFullDay(now)));
  assert.ok(svg.includes('mca-heat-legend'));
  assert.ok(svg.includes('mca-heat-day-label'), 'weekday labels use dedicated typography');
  assert.equal((svg.match(/2025-11-03/g) || []).length, 1, 'grid starts on Monday');
  const firstLabel = /class="mca-heat-day-label">([^<]+)</.exec(svg);
  assert.equal(firstLabel && firstLabel[1], '周一', 'first row is Monday (CN convention)');
  assert.ok(svg.includes('mca-heat-legend-label'), 'legend labels use dedicated layout');
  assert.ok(svg.includes('mca-heat-entrance'), 'heatmap fades in as one group (376 per-cell animations would starve the donut sweep)');
  assert.ok(!svg.includes('mca-anim-heat'), 'no per-cell heat animations');
  assert.ok(/>\d{1,2}月</.test(svg), 'renders month labels');       // 顶部月标签
  assert.ok(svg.includes('>周日<') && svg.includes('>周一<') && svg.includes('>周三<') && svg.includes('>周六<'), 'renders weekday labels');
});

test('alignWeekStart：周一为界', () => {
  const tz = 0;
  // 1794000000 对应的周起点应是周一 00:00 UTC
  const start = alignWeekStart(now, tz);
  const DAY = 86400;
  const dayIndex = Math.floor((start + tz) / DAY);
  assert.equal((dayIndex + 3) % 7, 0);
});

test('compareTable：列头/排序标记/转义/空态', () => {
  const rows = [{ provider: 'a', model: '<x>&', calls: 3, ok: 3, failed: 0, totalTokens: 100, cost: 0.5, costPerMillionTokens: 12.34, currency: 'USD', priced: true, p50: 120, p95: 300, speedTokensPerSec: 12.3, cacheHitRate: 0.9, cacheCoverage: 0.95 }];
  const html = compareTable(rows, { sortKey: 'cost', sortDir: 'desc' });
  assert.ok(html.includes('&lt;x&gt;&amp;'));
  assert.ok(html.includes('data-sort="cost"'));
  assert.ok(html.includes('↓'));
  assert.ok(html.includes('mca-cmp-row'));
  assert.ok(html.includes('data-model-key="a\u0000&lt;x&gt;&amp;"'));
  assert.ok(html.includes('$0.50'));
  assert.ok(html.includes('$12.34/M'));
  assert.ok(!html.includes('¥'));
  assert.ok((html.match(/tabindex="0" role="button"/g) || []).length >= 10, '9 sortable headers and the row are keyboard focusable');
  const empty = compareTable([], {});
  assert.ok(empty.includes('当前范围暂无数据'));
});
