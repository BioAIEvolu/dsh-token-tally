import test from 'node:test';
import assert from 'node:assert/strict';
import { foldSession, mergeStates } from '../src/core/rollup.js';
import { buildInsights, buildSessions, buildStacks } from '../src/core/query.js';
import { activityTrend, trendLines, rankingBars } from '../src/client/charts.js';

const NOW = Math.floor(Date.UTC(2026, 10, 25, 12) / 1000);
const DAY = 86400;
const pricer = {
  target: 'CNY',
  estimate: (_provider, _model, usage) => ({
    priced: true,
    amount: (usage.input + usage.output + usage.cacheRead + usage.cacheWrite) / 1e6,
    currency: 'CNY',
  }),
};

function record(daysAgo, provider, model, input, output, cacheRead = 0, cacheWrite = 0) {
  return {
    ts: NOW - daysAgo * DAY,
    provider,
    model,
    ok: true,
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    cacheObserved: true,
  };
}

function fixture() {
  const a = foldSession([
    record(0, 'deepseek', 'v4', 100, 50, 20),
    record(1, 'deepseek', 'v4', 200, 100),
    record(2, 'deepseek', 'v4', 300, 100),
    record(4, 'deepseek', 'v4', 400, 100),
    record(0, 'internal', '(compaction)', 999999, 999999),
  ]);
  const b = foldSession([
    record(0, 'openai', 'gpt', 1000, 500, 100),
    record(8, 'deepseek', 'v4', 100, 50),
  ]);
  return {
    sessions: new Map([
      ['session-a', { state: a, meta: { workspace: 'D:/demo/alpha' } }],
      ['session-b', { state: b, meta: { workspace: 'D:/demo/beta' } }],
    ]),
    mergedStates() { return mergeStates([a, b]); },
  };
}

test('buildInsights：活跃卡片与供应商拆分来自同一批小时桶，compaction 不计入', () => {
  const result = buildInsights(fixture(), { range: '7d', tz: 0 }, pricer, NOW);
  assert.equal(result.cards.streak.current, 3, '今天 / 昨天 / 前天连续活跃');
  assert.equal(result.cards.streak.best, 3);
  assert.equal(result.cards.peakDay.tokens, 1770, '今天两个会话合计为范围内最高单日');
  assert.equal(result.cards.week.current, 2970);
  assert.equal(result.cards.week.previous, 150);
  assert.ok(Math.abs(result.cards.todayCache.cacheHitRate - 120 / 1220) < 1e-9);
  assert.deepEqual(result.providers.map((p) => [p.provider, p.tokens]), [['openai', 1600], ['deepseek', 1370]]);
  assert.ok(result.providers.every((p) => p.costPriced));
  assert.ok(result.providers[0].share > result.providers[1].share);
});

test('buildSessions：独立会话逐行汇总，保留工作区并排除内部压缩行', () => {
  const result = buildSessions(fixture(), { range: '7d', tz: 0 }, pricer, NOW);
  assert.equal(result.total, 2);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.sessions.map((s) => [s.sessionId, s.tokens]), [['session-b', 1600], ['session-a', 1370]]);
  assert.equal(result.sessions[0].workspace, 'D:/demo/beta');
  assert.equal(result.sessions[1].workspace, 'D:/demo/alpha');
  assert.ok(result.sessions.every((s) => s.costPriced));
  assert.ok(result.sessions.every((s) => s.tokens < 999999));
  assert.deepEqual(result.projects.map((p) => [p.workspace, p.tokens]), [['D:/demo/beta', 1600], ['D:/demo/alpha', 1370]]);
  assert.equal(result.projects[0].share, 1600 / 2970);
});

test('buildSessions：超过 100 个会话仍全部返回，不截断滚动数据源', () => {
  const entries = Array.from({ length: 120 }, (_, i) => ['session-' + i, {
    state: foldSession([record(0, 'p', 'm', i + 1, 1)]),
    meta: { workspace: 'D:/demo/project-' + (i % 3) },
  }]);
  const store = {
    sessions: new Map(entries),
    mergedStates() { return mergeStates(entries.map(([, entry]) => entry.state)); },
  };
  const result = buildSessions(store, { range: 'today', tz: 0 }, pricer, NOW);
  assert.equal(result.total, 120);
  assert.equal(result.sessions.length, 120);
  assert.equal(result.truncated, false);
  assert.equal(result.sessions[0].tokens, 121, 'Tokens 最大的会话仍排第一');
  assert.equal(result.sessions.at(-1).tokens, 2, 'Tokens 最小的会话也没有被截掉');
});

test('activityTrend：周聚合与累计曲线共用整组入场，无逐格动画', () => {
  const days = [
    { day: NOW - 8 * DAY, tokens: 100 },
    { day: NOW - DAY, tokens: 200 },
    { day: NOW, tokens: 300 },
  ];
  const week = activityTrend(days, { mode: 'week', now: NOW, tz: 0 });
  const cumulative = activityTrend(days, { mode: 'cumulative', now: NOW, tz: 0 });
  assert.ok(week.includes('mca-activity-entrance'));
  assert.ok(week.includes('<rect'));
  assert.ok(cumulative.includes('<polyline'));
  assert.ok(!week.includes('mca-anim-heat'));
  assert.ok(!cumulative.includes('mca-anim-point'));
  assert.ok(activityTrend([], { mode: 'week', now: NOW }).includes('当前范围暂无数据'));
});

test('buildStacks + trendLines：缓存命中折线全窗连续，圆点只标实测', () => {
  const stacks = buildStacks(fixture(), { range: 'today', granularity: 'day', tz: 0 }, pricer, NOW).buckets;
  const deepseek = stacks[0].cells.find((c) => c.provider === 'deepseek');
  const openai = stacks[0].cells.find((c) => c.provider === 'openai');
  assert.equal(deepseek.cacheHitRate, 20 / 120);
  assert.equal(openai.cacheHitRate, 100 / 1100);
  const withGap = [
    { start: NOW - 3 * DAY, gran: 'day', cells: [{ provider: 'p', model: 'm', cacheHitRate: 0.5 }] },
    { start: NOW - 2 * DAY, gran: 'day', cells: [{ provider: 'p', model: 'm', cacheHitRate: 0.6 }] },
    { start: NOW - DAY, gran: 'day', cells: [{ provider: 'p', model: 'm', cacheHitRate: null }] },
    { start: NOW, gran: 'day', cells: [{ provider: 'p', model: 'm', cacheHitRate: 0.75 }] },
  ];
  const svg = trendLines(withGap, { metric: 'cache', tz: 0 });
  assert.equal((svg.match(/mca-anim-point/g) || []).length, 3, '只画三个有遥测的点');
  assert.equal((svg.match(/class="mca-anim-line"/g) || []).length, 1, '同一模型只有一条贯穿全窗的折线');
  const coords = /class="mca-anim-line"[^>]*points="([^"]+)"/.exec(svg)[1].split(' ');
  assert.equal(coords.length, 4, '缺失遥测的桶也由插值折线覆盖');
  assert.ok(coords.every((pair, i, all) => i === 0 || Number(pair.split(',')[0]) > Number(all[i - 1].split(',')[0])));
  assert.ok(svg.includes('50.0%') && svg.includes('60.0%') && svg.includes('75.0%'));
  assert.ok(svg.includes('65.0%（实测）') === false, '65% 插值不生成实测圆点');
  assert.ok(!svg.includes('m · 0.0%'), '缺失遥测不能显示成 0% 命中');
  assert.ok(svg.includes('折线含插值，圆点为实测'));

  const sparse = trendLines([
    { start: NOW - 4 * DAY, gran: 'day', cells: [] },
    { start: NOW - 3 * DAY, gran: 'day', cells: [{ provider: 'p', model: 'm', cacheHitRate: 0.5 }] },
    { start: NOW - 2 * DAY, gran: 'day', cells: [] },
    { start: NOW - DAY, gran: 'day', cells: [] },
    { start: NOW, gran: 'day', cells: [] },
  ], { metric: 'cache', tz: 0 });
  const sparseCoords = /class="mca-anim-line"[^>]*points="([^"]+)"/.exec(sparse)[1].split(' ');
  assert.equal(sparseCoords.length, 5, '首尾缺失段也保持连续，不出现孤立小段');
  assert.equal(new Set(sparseCoords.map((p) => p.split(',')[1])).size, 1, '单侧实测时以最近实测值水平延伸');
});

test('rankingBars：项目维度显示短路径，tooltip 保留完整工作区', () => {
  const svg = rankingBars([{ provider: '', model: 'D:/work/token-tally', displayName: '…/work/token-tally', fullName: 'D:/work/token-tally', calls: 3, totalTokens: 120, cost: 1, priced: true, currency: 'CNY' }], { metric: 'tokens' });
  assert.ok(svg.includes('…/work/token-tally'));
  assert.ok(svg.includes('<title>D:/work/token-tally · 120</title>'));
});
