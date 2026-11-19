import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  foldAppend, foldSession, mergeBuckets, queryTrend, queryByModel, queryHeatmap,
  latencyBucket, percentileFromHist, alignStart, collectInRange, splitKey, LAT_BUCKETS,
} from '../src/core/rollup.js';

function rec(partial) {
  return {
    ts: 1794000000, provider: 'deepseek', model: 'deepseek-flash', ok: true,
    inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0,
    cacheObserved: 0, reasoningTokens: 0, ...partial,
  };
}

test('foldSession 与逐条 foldAppend 结果一致（字节级等价）', () => {
  const records = [];
  let seed = 42;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < 200; i++) {
    records.push(rec({
      ts: 1794000000 + Math.floor(rnd() * 7200),
      model: rnd() > 0.5 ? 'm-a' : 'm-b',
      inputTokens: Math.floor(rnd() * 5000),
      latencyMs: rnd() > 0.3 ? Math.floor(rnd() * 90000) : undefined,
      genMs: rnd() > 0.3 ? Math.floor(rnd() * 30000) : undefined,
    }));
  }
  const a = foldSession(records);
  const b = {};
  for (const r of records) foldAppend(b, r);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test('分钟桶保留原始时间，查询时可按小时聚合', () => {
  const s = foldSession([rec({ ts: 100 }), rec({ ts: 2000 }), rec({ ts: 3700 })]);
  assert.equal(Object.keys(s).length, 3);
  const minutes = Object.keys(s).map((k) => splitKey(k).hour).sort();
  assert.deepEqual(minutes, ['1980', '3660', '60']);
  assert.equal(queryTrend(Object.values(s), 'hour', 0).length, 2);
});

test('分位：直方图非空返回数值且单调，空直方图返回 null', () => {
  const hist = new Array(LAT_BUCKETS + 1).fill(0);
  for (let i = 0; i < 10; i++) hist[latencyBucket(100)] += 1; // 100ms → 桶2（覆盖 [75, 112.5)）
  const p50 = percentileFromHist(hist, 0.5);
  const p95 = percentileFromHist(hist, 0.95);
  assert.equal(p50, 113); // 桶下界 50×1.5² = 112.5 → 取整 113
  assert.ok(p95 >= p50);
  assert.equal(percentileFromHist(new Array(LAT_BUCKETS + 1).fill(0), 0.5), null);
});

test('queryTrend：按日聚合（含时区偏移）', () => {
  const DAY = 86400;
  const d0 = 1794000000 - (1794000000 % DAY); // UTC 某日 00:00
  const s = foldSession([rec({ ts: d0 + 3600 }), rec({ ts: d0 + 7200 }), rec({ ts: d0 + DAY + 3600 })]);
  const trend = queryTrend(Object.values(s), 'day', 0);
  assert.equal(trend.length, 2);
  assert.equal(trend[0].count, 2);
  assert.equal(trend[1].count, 1);
});

test('alignStart：东八区下本地日界正确', () => {
  const DAY = 86400;
  const tz = 8 * 3600;
  const utcNoon = 1794000000; // 假设某日 UTC 12:xx
  const local = alignStart(utcNoon, 'day', tz);
  assert.equal((local + tz) % DAY, 0); // 本地零点
});

test('queryByModel：跨小时合并出模型行，合并桶数值正确', () => {
  const s = foldSession([
    rec({ ts: 100, model: 'm-a', inputTokens: 10 }),
    rec({ ts: 3700, model: 'm-a', inputTokens: 20 }),
    rec({ ts: 200, model: 'm-b', inputTokens: 5 }),
  ]);
  const rows = queryByModel(s, 0, Number.MAX_SAFE_INTEGER);
  const ma = rows.find((r) => r.model === 'm-a');
  assert.equal(ma.bucket.count, 2);
  assert.equal(ma.bucket.inputTokens, 30);
});

test('queryHeatmap：同日跨小时合并 token', () => {
  const s = foldSession([rec({ ts: 100 }), rec({ ts: 3700 })]);
  const heat = queryHeatmap(s, 0, Number.MAX_SAFE_INTEGER, 0);
  assert.equal(heat.size, 1);
  assert.equal([...heat.values()][0], 220); // (100+10) × 2
});

test('collectInRange + mergeBuckets：范围过滤', () => {
  const s = foldSession([rec({ ts: 100 }), rec({ ts: 1794003600 * 1000 })]); // 第二条在远未来
  const inRange = collectInRange(s, 0, 7200);
  assert.equal(inRange.length, 1);
  assert.equal(mergeBuckets(inRange).count, 1);
});
