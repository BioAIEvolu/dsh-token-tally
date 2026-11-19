// 口径对齐测试（v2）：子代理纳入、布尔继承种子重置、总额排除 internal/(compaction) 与 reasoning、缓存版本失效
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listSessionFiles } from '../src/core/session-files.js';
import { RollupStore, CACHE_FORMAT_VERSION, isInheritedSeed } from '../src/core/store.js';
import { buildUsage, buildCompare, buildHeatmap } from '../src/core/query.js';

const T0 = 1794000000000; // epoch ms

function mkTemp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'tally-align-')); }

function writeSession(root, ws, dirName, frames) {
  const dir = path.join(root, ws, dirName);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'session.v4.jsonl.zstd');
  fs.writeFileSync(file, Buffer.from(frames.flat().map((e) => JSON.stringify(e)).join('\n') + '\n'));
  return file;
}

function usageEvent(seq, time, provider, model, usage, extra = {}) {
  return {
    type: 'assistant/message', seq, time,
    data: {
      turn: extra.turn ?? 1, step: extra.step ?? 1,
      message: { role: 'assistant', source: { kind: 'model', provider, model } },
      usage,
    },
  };
}

const RANGE = (T0) => ({ range: 'custom', from: 0, to: T0 / 1000 + 1e6, tz: 0 });

test('v2 口径：裸 uuid 子代理目录与 parentSession 主会话目录默认计入', async () => {
  const root = mkTemp();
  const cacheDir = mkTemp();
  writeSession(root, '--W--', '96521d7b-f130-4caa-8516-2e461c4e07d5', [
    { type: 'session', seq: 0, time: T0, data: { id: 'bare1', parentSession: 'session-p', origin: 'subagent', delegationDepth: 1 } },
    usageEvent(1, T0 + 100, 'deepseek', 'deepseek-flash', { inputTokens: 11, outputTokens: 2 }),
  ]);
  writeSession(root, '--W--', 'session-pflag', [
    { type: 'session', seq: 0, time: T0, data: { id: 'pflag', parentSession: 'session-p' } },
    usageEvent(1, T0 + 200, 'deepseek', 'deepseek-flash', { inputTokens: 22, outputTokens: 3 }),
  ]);
  writeSession(root, '--W--', 'session-root', [
    { type: 'session', seq: 0, time: T0, data: { id: 'root1', isSeeded: false } },
    usageEvent(1, T0 + 300, 'deepseek', 'deepseek-flash', { inputTokens: 44, outputTokens: 4 }),
  ]);

  const store = new RollupStore({ root, cacheDir, budgetMs: 5000 });
  await store.init();
  assert.equal(listSessionFiles(root).length, 3);
  assert.equal(store.sessions.size, 3, 'bare uuid + parentSession sessions are included by default');
  const r = buildUsage(store, RANGE(T0), null);
  assert.equal(r.kpi.requests, 3);
  assert.equal(r.kpi.inputTokens, 11 + 22 + 44);

  // 显式回退 v1：includeSubagents=false 等价 excludeSubagents=true
  const storeV1 = new RollupStore({ root, cacheDir: mkTemp(), budgetMs: 5000, excludeSubagents: true });
  await storeV1.init();
  assert.equal(storeV1.sessions.size, 1, 'opt-out still excludes bare + parentSession sessions');
  assert.equal(storeV1.excluded.size, 2);
});

test('v2 口径：布尔 inherited:true 的继承种子触发状态重置（对齐 dsh-context）', async () => {
  const root = mkTemp();
  const store = new RollupStore({ root, cacheDir: mkTemp(), budgetMs: 5000 });
  writeSession(root, '--W--', 'session-fork', [
    [
      { type: 'session', seq: 0, time: T0, data: { id: 'fork', parentSession: 'session-p' } },
      usageEvent(1, T0 + 10, 'deepseek', 'deepseek-flash', { inputTokens: 9999 }), // 继承前缀：父会话已计
      usageEvent(2, T0 + 20, 'deepseek', 'deepseek-flash', { inputTokens: 7 }), // 继承前缀（种子标记之前全部丢弃）
      { type: 'session/end-seed', seq: 3, time: T0 + 30, data: { inherited: true } },
    ],
    [
      { type: 'step/start', seq: 4, time: T0 + 100, data: { turn: 1, step: 1 } },
      usageEvent(5, T0 + 5100, 'deepseek', 'deepseek-flash', { inputTokens: 100, outputTokens: 10 }),
    ],
  ]);
  await store.init();
  assert.ok(isInheritedSeed({ type: 'session/end-seed', data: { inherited: true } }));
  assert.equal(isInheritedSeed({ type: 'session/end-seed', data: { inherited: 3 } }), false);
  const r = buildUsage(store, RANGE(T0), null);
  assert.equal(r.kpi.totalTokens, 110, 'only post-seed tokens count; inherited prefix is reset');
  assert.equal(r.kpi.inputTokens, 100);
});

test('v2 口径：总额/分布/趋势排除 internal/(compaction) 桶与 reasoningTokens，compare 表保留台账', async () => {
  const root = mkTemp();
  const store = new RollupStore({ root, cacheDir: mkTemp(), budgetMs: 5000 });
  writeSession(root, '--W--', 'session-abc', [
    [
      { type: 'session', seq: 0, time: T0, data: { id: 'abc', isSeeded: false } },
      usageEvent(1, T0 + 100, 'deepseek', 'deepseek-flash', { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 500, reasoningTokens: 77 }),
      // 内部压缩调用：无 message.source → normalize 归为 internal/(compaction)
      { type: 'compaction/summary', seq: 2, time: T0 + 200, data: { usage: { inputTokens: 300, outputTokens: 30 } } },
    ],
  ]);
  await store.init();
  const r = buildUsage(store, RANGE(T0), null);
  assert.equal(r.kpi.totalTokens, 1600, 'total = 1000+100+500, compaction(330) 与 reasoning(77) 不进总额');
  assert.equal(r.kpi.reasoningTokens, 77, 'reasoning 仍单列 KPI 字段');
  assert.equal(r.kpi.requests, 1, 'compaction 请求数不进总额口径');
  assert.deepEqual(r.dist.map((d) => d.model), ['deepseek-flash'], '环形图分布不含 (compaction) 行');
  assert.equal(r.trend.reduce((a, b) => a + b.tokens, 0), 1600, '趋势与总额同口径');
  const hm = buildHeatmap(store, RANGE(T0), null);
  assert.equal(hm.days[0].tokens, 1600, '热力图与总额同口径');

  const cmp = buildCompare(store, RANGE(T0), null);
  const ds = cmp.models.find((m) => m.model === 'deepseek-flash');
  assert.equal(ds.totalTokens, 1600);
  assert.equal(ds.reasoningTokens, 77, 'compare 表保留 reasoningTokens 列');
  const cp = cmp.models.find((m) => m.model === '(compaction)');
  assert.ok(cp, 'compare 表保留 internal/(compaction) 台账行');
  assert.equal(cp.totalTokens, 330);
});

test('缓存版本：v1 旧缓存被 v2 拒绝并重建', async () => {
  const root = mkTemp();
  const cacheDir = mkTemp();
  const file = writeSession(root, '--W--', 'session-old', [
    { type: 'session', seq: 0, time: T0, data: { id: 'old', isSeeded: false } },
    usageEvent(1, T0 + 100, 'deepseek', 'deepseek-flash', { inputTokens: 5, outputTokens: 1 }),
  ]);
  const st = fs.statSync(file);
  fs.writeFileSync(path.join(cacheDir, 'old.json'), JSON.stringify({
    v: 1, id: 'old', file, mtimeMs: Math.round(st.mtimeMs), size: st.size, state: {},
  }));
  const store = new RollupStore({ root, cacheDir, budgetMs: 5000 });
  await store.init();
  assert.equal(CACHE_FORMAT_VERSION, 2);
  const entry = store.sessions.get('old');
  assert.ok(entry && entry.fromCache === false, 'v1 cache is rejected and rebuilt');
  const r = buildUsage(store, RANGE(T0), null);
  assert.equal(r.kpi.totalTokens, 6);
});
