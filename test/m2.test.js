// M2 集成测试：会话发现 / zstd 多帧读取 / 回填与缓存 / seed 切断 / 实时缓冲 / 守卫 / 查询载荷
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { listSessionFiles, pickLogFile } from '../src/core/session-files.js';
import { readSessionFile } from '../src/core/log-reader.js';
import { RollupStore } from '../src/core/store.js';
import { isLoopbackRequest, parseQuery } from '../src/core/route-guard.js';
import { resolveRange, buildUsage, buildStacks, buildCompare, buildHeatmap, buildModels, matchRow } from '../src/core/query.js';
import { emptyBucket } from '../src/core/rollup.js';
import { parsePricingCsv, makePricer } from '../src/core/pricing.js';
import { apply as hostApply } from '../src/host.js';

const T0 = 1794000000000; // epoch ms
const canZstd = typeof zlib.zstdDeflateSync === 'function';

function mkTemp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mca-test-')); }

function writeSession(root, ws, dirName, frames) {
  const dir = path.join(root, ws, dirName);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'session.v4.jsonl.zstd');
  const lines = (arr) => arr.map((e) => JSON.stringify(e)).join('\n') + '\n';
  if (canZstd && frames.length > 1) {
    const buf = Buffer.concat(frames.map((f) => zlib.zstdDeflateSync(Buffer.from(lines(f)))));
    fs.writeFileSync(file, buf);
  } else {
    fs.writeFileSync(file, Buffer.from(lines(frames.flat())));
  }
  return file;
}

function usageEvent(seq, time, provider, model, usage, extra = {}) {
  return {
    type: 'assistant/message', seq, time, surfaceOp: 'append',
    data: {
      turn: extra.turn ?? 1, step: extra.step ?? 1,
      message: { role: 'assistant', source: { kind: 'model', provider, model } },
      usage,
    },
  };
}

function makeStore(root, cacheDir) {
  return new RollupStore({ root, cacheDir, budgetMs: 5000 });
}

test('session-files：v4 优先于 v3，裸 uuid（子代理）目录一并列出', () => {
  const root = mkTemp();
  const ws = '--T--';
  const dirV = path.join(root, ws, 'session-def');
  fs.mkdirSync(dirV, { recursive: true });
  fs.writeFileSync(path.join(dirV, 'session.v3.jsonl.zstd'), 'x');
  fs.writeFileSync(path.join(dirV, 'session.v4.jsonl.zstd'), 'x');
  const bareId = '96521d7b-f130-4caa-8516-2e461c4e07d5';
  const dirSub = path.join(root, ws, bareId);
  fs.mkdirSync(dirSub, { recursive: true });
  fs.writeFileSync(path.join(dirSub, 'session.v4.jsonl.zstd'), 'x');
  const dirOther = path.join(root, ws, 'not-a-session-dir');
  fs.mkdirSync(dirOther, { recursive: true });
  fs.writeFileSync(path.join(dirOther, 'session.v4.jsonl.zstd'), 'x');

  const picked = pickLogFile(dirV);
  assert.match(picked, /session\.v4\.jsonl\.zstd$/);
  const all = listSessionFiles(root);
  assert.deepEqual(all.map((f) => f.sessionId).sort(), [bareId, 'def'].sort());
});

test('log-reader：多帧 zstd 拼接解码（或纯文本兜底）', () => {
  const root = mkTemp();
  const file = writeSession(root, '--T--', 'session-multi', [
    [{ type: 'session', seq: 0, time: T0, data: { id: 'multi', isSeeded: false } }],
    [usageEvent(1, T0 + 100, 'deepseek', 'deepseek-flash', { inputTokens: 7, outputTokens: 3 })],
  ]);
  const events = readSessionFile(file);
  assert.equal(events.length, 2);
  assert.equal(events[0].type, 'session');
  assert.equal(events[1].data.usage.inputTokens, 7);
});

test('store：回填 + seed 切断 + 子代理排除 + 磁盘缓存命中', async () => {
  const root = mkTemp();
  const cacheDir = mkTemp();
  const inherited = usageEvent(1, T0 + 10, 'deepseek', 'deepseek-flash', { inputTokens: 9999, outputTokens: 0 });
  writeSession(root, '--W--', 'session-abc', [
    [
      { type: 'session', seq: 0, time: T0, data: { id: 'abc', cwd: 'D:\\T', isSeeded: true, seedLength: 2 } },
      inherited,
      { type: 'session/end-seed', seq: 2, time: T0 + 20, data: { inherited: 2 } },
    ],
    [
      { type: 'step/start', seq: 3, time: T0 + 100, data: { turn: 1, step: 1 } },
      usageEvent(4, T0 + 5100, 'deepseek', 'deepseek-flash', { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 5000 }),
      usageEvent(5, T0 + 5200, 'z-ai', 'glm-5.1', { inputTokens: 10, outputTokens: 20, cacheWriteTokens: 5 }),
    ],
  ]);

  const store = makeStore(root, cacheDir);
  await store.init();
  assert.ok(store.sessions.has('abc'));
  assert.equal(store.sessions.size, 1);
  const r1 = buildUsage(store, { range: 'custom', from: 0, to: T0 / 1000 + 1e6, tz: 0 }, null);
  assert.equal(r1.kpi.requests, 2);
  assert.equal(r1.kpi.inputTokens, 1010); // 9999 被 seed 切断

  // 磁盘缓存已写
  assert.ok(fs.existsSync(path.join(cacheDir, 'abc.json')));
  // 第二个 store 命中缓存
  const store2 = makeStore(root, cacheDir);
  await store2.init();
  assert.equal(store2.sessions.get('abc').fromCache, true);
  const r2 = buildUsage(store2, { range: 'custom', from: 0, to: T0 / 1000 + 1e6, tz: 0 }, null);
  assert.equal(r2.kpi.requests, 2);
});

test('store：实时事件先缓冲，回填后按 seq 排水防双计', async () => {
  const root = mkTemp();
  const store = makeStore(root, mkTemp());
  // 文件尚未写：先来两个实时事件（seq 6、7）
  store.onLiveEvent('abc', usageEvent(6, T0 + 9000, 'deepseek', 'deepseek-flash', { inputTokens: 1 }));
  store.onLiveEvent('abc', usageEvent(7, T0 + 9100, 'deepseek', 'deepseek-flash', { inputTokens: 1 }));
  writeSession(root, '--W--', 'session-abc', [
    [
      { type: 'session', seq: 0, time: T0, data: { id: 'abc', isSeeded: false } },
      usageEvent(5, T0 + 8000, 'deepseek', 'deepseek-flash', { inputTokens: 100 }),
    ],
  ]);
  await store.init();
  const r = buildUsage(store, { range: 'custom', from: 0, to: T0 / 1000 + 1e6, tz: 0 }, null);
  assert.equal(r.kpi.requests, 3); // 文件 1 条 + 实时 2 条排水，无重复
});

test('store：并行回填（worker 路径）与串行口径一致，子代理被排除', async (t) => {
  const root = mkTemp();
  const cacheDir = mkTemp();
  writeSession(root, '--W--', 'session-a1', [[
    { type: 'session', seq: 0, time: T0, data: { id: 'a1', isSeeded: false } },
    usageEvent(1, T0 + 100, 'deepseek', 'deepseek-flash', { inputTokens: 100, outputTokens: 10 }),
  ]]);
  writeSession(root, '--W--', 'session-a2', [[
    { type: 'session', seq: 0, time: T0, data: { id: 'a2', isSeeded: false } },
    usageEvent(1, T0 + 100, 'z-ai', 'glm-5.1', { inputTokens: 50, outputTokens: 5 }),
  ]]);
  writeSession(root, '--W--', 'session-a3', [[
    { type: 'session', seq: 0, time: T0, data: { id: 'a3', isSeeded: false } },
    usageEvent(1, T0 + 100, 'deepseek', 'deepseek-flash', { inputTokens: 30, outputTokens: 3 }),
  ]]);
  // 裸 uuid 子代理目录：含 v4 日志才有效；这里只验证目录扫描，排除语义由 excluded 覆盖
  const sub = path.join(root, '--W--', '96521d7b-0000-4000-8000-000000000001');
  fs.mkdirSync(sub, { recursive: true });

  const store = makeStore(root, cacheDir);
  await store.init();
  assert.equal(store.sessions.size, 3, '三个主会话都装载（misses>=2 走 worker 路径）');
  const usage = buildUsage(store, { range: 'custom', from: 0, to: T0 / 1000 + 1e6, tz: 0 }, null);
  assert.equal(usage.kpi.requests, 3);
  assert.equal(usage.kpi.inputTokens, 180, 'worker 折叠与主线程 buildSession 同口径');
  assert.equal(usage.kpi.outputTokens, 18);
  // 第二个 store 全部命中磁盘缓存（worker 写回的缓存可用）
  const store2 = makeStore(root, cacheDir);
  await store2.init();
  assert.equal(store2.sessions.get('a1').fromCache, true, 'worker 写回的缓存可被后续装载命中');
  t.after(() => { try { for (const w of store.workerPool() || []) w.terminate(); } catch {} });
});

test('route-guard：loopback 白名单 + Origin 同源校验 + 查询解析', () => {
  assert.equal(isLoopbackRequest({ headers: { host: '127.0.0.1:52440' } }), true);
  assert.equal(isLoopbackRequest({ headers: { host: 'localhost' } }), true);
  assert.equal(isLoopbackRequest({ headers: { host: 'example.com' } }), false);
  assert.equal(isLoopbackRequest({ headers: { host: '127.0.0.1', origin: 'http://evil.com' } }), false);
  assert.equal(isLoopbackRequest({ headers: { host: '127.0.0.1', origin: 'http://127.0.0.1:52440' } }), true);

  const q = parseQuery('/token-tally-api/usage?range=custom&granularity=hour&from=100&to=200&tz=28800&models=A,B&providers=x&modelKeys=x%00A,y%00B&modelKeys=z%00C');
  assert.equal(q.range, 'custom');
  assert.equal(q.granularity, 'hour');
  assert.equal(q.from, 100);
  assert.equal(q.tz, 28800);
  assert.deepEqual(q.models, ['A', 'B']);
  assert.deepEqual(q.providers, ['x']);
  assert.deepEqual(q.modelKeys, ['x\u0000A', 'y\u0000B', 'z\u0000C']);
});

test('query：自动粒度 + 用户手动粒度', () => {
  const now = 1794000000;
  assert.equal(resolveRange({ range: 'custom', from: now - 2 * 3600, to: now }, now).gran, 'minute');
  assert.equal(resolveRange({ range: '24h' }, now).gran, 'hour');
  assert.equal(resolveRange({ range: '30d' }, now).gran, 'day');
  assert.equal(resolveRange({ range: '7d' }, now).gran, 'day');
  assert.equal(resolveRange({ range: 'custom', from: now - 10 * 3600, to: now }, now).gran, 'hour');
  assert.equal(resolveRange({ range: 'custom', from: now - 400 * DAY(), to: now }, now).gran, 'month');
  assert.equal(resolveRange({ range: '30d', granularity: 'hour' }, now).gran, 'hour');
  assert.equal(resolveRange({ range: 'all' }, now).gran, 'month');
  assert.equal(resolveRange({ range: 'all', granularity: 'month' }, now).gran, 'month');
  function DAY() { return 86400; }
});

test('query：细粒度×大范围自动降档（防万桶爆炸）', () => {
  const now = 1794000000;
  // 分钟×7天=10080桶 → 降为时；分钟×24h=1440桶 → 保留
  assert.equal(resolveRange({ range: '7d', granularity: 'minute' }, now).gran, 'hour');
  assert.equal(resolveRange({ range: '24h', granularity: 'minute' }, now).gran, 'minute');
  assert.equal(resolveRange({ range: '30d', granularity: 'minute' }, now).gran, 'hour');
  // 全部范围 from=0 巨跨度：分钟连降两档到天；时降一档到天
  assert.equal(resolveRange({ range: 'all', granularity: 'minute' }, now).gran, 'day');
  assert.equal(resolveRange({ range: 'all', granularity: 'hour' }, now).gran, 'day');
  // 30d×时=720桶 不降；day 永不降档（桶数=实际天数）
  assert.equal(resolveRange({ range: '30d', granularity: 'hour' }, now).gran, 'hour');
  assert.equal(resolveRange({ range: 'all', granularity: 'day' }, now).gran, 'day');
});

test('store：mergedStates 版本记忆——多查询共享一次合并，实时事件使快照失效', async () => {
  const root = mkTemp();
  writeSession(root, '--W--', 'session-abc', [
    [
      { type: 'session', seq: 0, time: T0, data: { id: 'abc', isSeeded: false } },
      usageEvent(1, T0 + 100, 'deepseek', 'deepseek-flash', { inputTokens: 100, outputTokens: 10 }),
    ],
  ]);
  const store = makeStore(root, mkTemp());
  await store.init();
  const m1 = store.mergedStates();
  const m2 = store.mergedStates();
  assert.strictEqual(m1, m2, '无变更时重复调用返回同一快照');
  // 5 个路由查询都走同一快照
  const u = buildUsage(store, { range: 'custom', from: 0, to: T0 / 1000 + 1e6, tz: 0 }, null);
  assert.equal(u.kpi.requests, 1);
  assert.strictEqual(store.mergedStates(), m1, '查询不改变快照引用');
  // 实时事件 → 版本 bump → 快照重建
  store.onLiveEvent('abc', usageEvent(9, T0 + 9900, 'deepseek', 'deepseek-flash', { inputTokens: 5 }));
  const m3 = store.mergedStates();
  assert.notStrictEqual(m3, m1, '实时事件后快照必须重建');
  const u2 = buildUsage(store, { range: 'custom', from: 0, to: T0 / 1000 + 1e6, tz: 0 }, null);
  assert.equal(u2.kpi.inputTokens, 105, '新快照包含实时事件数据');
});

test('query：modelKeys 精确配对、会话数随范围筛选、聚合结果携带币种', () => {
  const bucket = (provider, model, hour, inputTokens = 10) => {
    const b = emptyBucket(hour);
    b.count = 1;
    b.okCount = 1;
    b.inputTokens = inputTokens;
    return [provider + '\u0000' + model + '\u0000' + hour, b];
  };
  const sessions = new Map();
  const add = (id, entries) => sessions.set(id, { meta: {}, state: Object.fromEntries(entries) });
  add('p1', [bucket('p1', 'shared', 1200, 10)]);
  add('p2', [bucket('p2', 'shared', 1200, 20)]);
  add('old', [bucket('p1', 'shared', 3000, 40)]);
  add('empty', []);
  const store = { sessions };
  const params = { range: 'custom', from: 1000, to: 2000, granularity: 'hour', tz: 0, modelKeys: ['p1\u0000shared'] };

  assert.equal(matchRow('p1', 'shared', { modelKeys: new Set(['p1\u0000shared']) }), true);
  assert.equal(matchRow('p2', 'shared', { modelKeys: new Set(['p1\u0000shared']) }), false);
  const exact = buildUsage(store, params);
  assert.equal(exact.kpi.requests, 1);
  assert.equal(exact.kpi.sessions, 1);
  assert.deepEqual(exact.dist.map((d) => [d.provider, d.model]), [['p1', 'shared']]);

  const legacy = buildUsage(store, { ...params, modelKeys: null, models: ['SHARED'] });
  assert.equal(legacy.kpi.requests, 2, 'legacy model filter matches both providers without mixing their buckets');
  assert.equal(legacy.kpi.sessions, 2, 'out-of-range and empty sessions are excluded');
  const legacyProvider = buildUsage(store, { ...params, modelKeys: null, models: ['shared'], providers: ['p2'] });
  assert.equal(legacyProvider.kpi.sessions, 1);
  assert.deepEqual(legacyProvider.dist.map((d) => d.provider), ['p2']);
  const noMatch = buildUsage(store, { ...params, modelKeys: ['p1\u0000missing'] });
  assert.equal(noMatch.kpi.sessions, 0);
  assert.equal(noMatch.kpi.requests, 0);

  const pricer = { target: 'USD', estimate: () => ({ priced: true, amount: 1.25, currency: 'USD' }) };
  const priced = buildUsage(store, params, pricer);
  assert.equal(priced.currency, 'USD');
  assert.equal(priced.kpi.currency, 'USD');
  assert.equal(priced.dist[0].currency, 'USD');
  assert.equal(priced.trend[0].currency, 'USD');
  const stacks = buildStacks(store, params, pricer);
  assert.equal(stacks.currency, 'USD');
  assert.equal(stacks.buckets[0].currency, 'USD');
  assert.equal(stacks.buckets[0].cells[0].currency, 'USD');
});

test('query：buildStacks 按粒度补齐空桶（趋势断档贴 0）', async () => {
  const root = mkTemp();
  const from = Math.floor(T0 / 1000); // 整秒起点
  writeSession(root, '--W--', 'session-gap', [
    [
      { type: 'session', seq: 0, time: T0, data: { id: 'gap', isSeeded: false } },
      usageEvent(1, T0 + 100, 'deepseek', 'deepseek-flash', { inputTokens: 10, outputTokens: 5 }),
      usageEvent(2, T0 + 2 * 3600 * 1000 + 100, 'deepseek', 'deepseek-flash', { inputTokens: 20, outputTokens: 5 }),
    ],
  ]);
  const store = makeStore(root, mkTemp());
  await store.init();
  const r = buildStacks(store, { range: 'custom', from, to: from + 3 * 3600, granularity: 'hour', tz: 0 });
  // 只在首个到最后一个有数据的桶之间补零：起点对齐整点后共 3 桶（中间 1 个空桶贴 0）。
  const start = from - (from % 3600);
  assert.equal(r.buckets.length, 3);
  assert.deepEqual(r.buckets.map((b) => b.start), [start, start + 3600, start + 7200]);
  assert.deepEqual(r.buckets.map((b) => b.cells.length), [1, 0, 1]);
  assert.equal(r.buckets[0].cells[0].tokens, 15);
  assert.equal(r.buckets[2].cells[0].tokens, 25);
});

test('query：buildStacks 无数据时不补零（避免「全部」范围生成数百空桶）', async () => {
  const root = mkTemp();
  const store = makeStore(root, mkTemp());
  await store.init();
  const r = buildStacks(store, { range: 'all', granularity: 'month', tz: 0 }, null, 1794000000);
  assert.deepEqual(r.buckets, []);
});

test('query：heatmap 使用请求时区对齐本地日界', async () => {
  const root = mkTemp();
  // UTC 16:30 属于东八区次日 00:30，必须归入本地次日。
  const tsMs = Date.UTC(2026, 10, 6, 16, 30, 0);
  writeSession(root, '--TZ--', 'session-tz', [[
    { type: 'session', seq: 0, time: tsMs - 1000, data: { id: 'tz', isSeeded: false } },
    usageEvent(1, tsMs, 'deepseek', 'deepseek-chat', { inputTokens: 123, outputTokens: 7 }),
  ]]);
  const store = makeStore(root, mkTemp());
  await store.init();
  const heatmap = buildHeatmap(store, { range: 'custom', from: 0, to: 2000000000, tz: 28800 }, Math.floor(tsMs / 1000));
  assert.equal(heatmap.days.length, 1);
  assert.equal(heatmap.days[0].day, 1793980800); // 2026-11-07 00:00 +08:00（UTC 2026-11-06 16:00）
  assert.equal(heatmap.days[0].tokens, 130);
});

test('query：compare / heatmap / models 载荷（含费用与速度）', async () => {
  const root = mkTemp();
  writeSession(root, '--W--', 'session-abc', [
    [
      { type: 'session', seq: 0, time: T0, data: { id: 'abc', isSeeded: false } },
      { type: 'step/start', seq: 1, time: T0 + 100, data: { turn: 1, step: 1 } },
      usageEvent(2, T0 + 5100, 'deepseek', 'deepseek-flash', { inputTokens: 1_000_000, outputTokens: 200_000, cacheReadTokens: 0 }),
      usageEvent(3, T0 + 5200, 'z-ai', 'glm-5.1', { inputTokens: 10, outputTokens: 20, cacheWriteTokens: 5 }),
    ],
  ]);
  const store = makeStore(root, mkTemp());
  await store.init();
  const csv = parsePricingCsv(fs.readFileSync(path.join(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), 'pricing', 'models.csv'), 'utf8'));
  const pricer = makePricer(csv, { target: 'CNY' });
  const params = { range: 'custom', from: 0, to: T0 / 1000 + 1e6, tz: 0 };

  const cmp = buildCompare(store, params, pricer);
  const ds = cmp.models.find((m) => m.model === 'deepseek-flash');
  assert.ok(ds);
  assert.equal(ds.calls, 1);
  assert.equal(ds.speedTokensPerSec, 40000); // 200_000 tokens / 5s
  assert.ok(ds.p50 != null && ds.p95 >= ds.p50);
  assert.ok(ds.priced);
  assert.ok(Math.abs(ds.cost - (1_000_000 * 1 + 200_000 * 4) / 1e6) < 1e-9); // 1.8 CNY
  const glm = cmp.models.find((m) => m.model === 'glm-5.1');
  assert.equal(glm.p50, null); // 无 step 配对

  const hm = buildHeatmap(store, params);
  assert.equal(hm.days.length, 1);
  const usage = buildUsage(store, params, pricer);
  assert.ok(Math.abs(hm.days[0].tokens - usage.kpi.totalTokens) < 1e-9);

  const md = buildModels(store, params);
  const provs = md.models.map((m) => m.provider).sort();
  assert.deepEqual(provs, ['deepseek', 'z-ai']);

  // 次级汇总不应被图表粒度影响：小时/天/月只影响趋势柱桶。
  const summaries = ['hour', 'day', 'month'].map((granularity) => ({
    usage: buildUsage(store, { ...params, granularity }, pricer),
    compare: buildCompare(store, { ...params, granularity }, pricer),
  }));
  for (const s of summaries.slice(1)) {
    assert.deepEqual(s.usage.dist.map((d) => [d.provider, d.model, d.calls, d.tokens]), summaries[0].usage.dist.map((d) => [d.provider, d.model, d.calls, d.tokens]));
    assert.deepEqual(s.compare.models.map((m) => [m.provider, m.model, m.calls, m.totalTokens]), summaries[0].compare.models.map((m) => [m.provider, m.model, m.calls, m.totalTokens]));
  }
});

test('host：装配注册 6 条路由并保持到卸载，loopback 拒绝 + 正常 payload + 实时事件不抛错', async () => {
  const root = mkTemp();
  const cacheDir = mkTemp();
  writeSession(root, '--W--', 'session-abc', [
    [
      { type: 'session', seq: 0, time: T0, data: { id: 'abc', isSeeded: false } },
      usageEvent(1, T0 + 100, 'deepseek', 'deepseek-flash', { inputTokens: 100, outputTokens: 10 }),
    ],
  ]);
  const routes = [];
  const cleanups = [];
  let removedRoutes = 0;
  const ctx = {
    on(name, fn) { this.handlers = this.handlers || {}; this.handlers[name] = fn; },
    get(svc) { return svc === 'sessionPersistence' ? { root } : null; },
    inject(deps, fn) {
      const host = {
        webServer: { register(r) {
          routes.push(r);
          return () => {
            const i = routes.indexOf(r);
            if (i >= 0) { routes.splice(i, 1); removedRoutes++; }
          };
        } },
        loader: {},
        effect: this.effect.bind(this),
      };
      const disposer = fn(host);
      if (typeof disposer === 'function') cleanups.push(disposer);
    },
    // Cordis executes setup immediately; only its return value is a disposer.
    effect(setup) {
      const cleanup = setup();
      if (typeof cleanup === 'function') cleanups.push(cleanup);
      return cleanup;
    },
  };
  hostApply(ctx, { cacheDir, backfillBudgetMs: 3000 });
  assert.equal(routes.length, 8);
  assert.equal(removedRoutes, 0, 'route disposers must not run during effect setup');
  assert.equal(cleanups.length, 2, 'timer and route cleanup are owned by Cordis effects');

  const fakeRes = () => { const r = { status: null, body: '', writeHead(c) { this.status = c; return r; }, end(b) { this.body = b ?? ''; } }; return r; };

  // 回填未完成时也允许 200（空数据），等待预算完成再断言
  const usageRoute = routes.find((r) => r.path === '/token-tally-api/usage');
  const resForbidden = fakeRes();
  await usageRoute.handler({ headers: { host: 'example.com' }, url: '/token-tally-api/usage' }, resForbidden);
  assert.equal(resForbidden.status, 403);

  let payload = null;
  for (let i = 0; i < 200; i++) {
    const res = fakeRes();
    await usageRoute.handler({ headers: { host: '127.0.0.1' }, url: '/token-tally-api/usage?range=custom&from=0&to=99999999999&tz=0' }, res);
    payload = JSON.parse(res.body);
    if (payload.kpi && payload.kpi.requests > 0) break;
    await new Promise((r2) => setTimeout(r2, 10));
  }
  assert.equal(payload.kpi.requests, 1);
  assert.ok(payload.trend.length >= 1);
  assert.ok(payload.dist.length >= 1);

  const cmpRoute = routes.find((r) => r.path === '/token-tally-api/compare');
  const resCmp = fakeRes();
  await cmpRoute.handler({ headers: { host: 'localhost' }, url: '/token-tally-api/compare?range=custom&from=0&to=99999999999&tz=0' }, resCmp);
  const cmp = JSON.parse(resCmp.body);
  assert.ok(Array.isArray(cmp.models) && cmp.models.length >= 1);

  // 实时事件经 ctx.on 进入 store，不抛错
  ctx.handlers['session/event']({ id: 'abc' }, usageEvent(9, T0 + 9900, 'deepseek', 'deepseek-flash', { inputTokens: 5 }));
  const resAfter = fakeRes();
  await usageRoute.handler({ headers: { host: '127.0.0.1' }, url: '/token-tally-api/usage?range=custom&from=0&to=99999999999&tz=0' }, resAfter);
  assert.equal(JSON.parse(resAfter.body).kpi.requests, 1); // 请求缓存 30s 内

  // Disposal is the only point at which routes disappear.
  for (const cleanup of [...cleanups].reverse()) cleanup();
  assert.equal(routes.length, 0);
  assert.equal(removedRoutes, 8);
});
