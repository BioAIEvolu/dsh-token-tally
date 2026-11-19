// 查询层：范围解析、筛选、端点载荷构建（分钟桶在查询层按粒度合并）
import {
  mergeStates, alignStart, percentileFromHist, splitKey, HOUR,
} from './rollup.js';

const DAY = 86400;
const VALID_GRANULARITIES = new Set(['minute', 'hour', 'day', 'month']);

/**
 * 看板自动粒度：短窗口按小时，中窗口按天，长窗口按月。
 * 手动选择 hour/day/month 时不覆盖用户选择；图表只负责降低标签密度。
 */
export function autoGranularity(fromTs, toTs) {
  const span = Math.max(0, toTs - fromTs);
  // 近 1 天按小时、近 90 天按天、跨度更大按月，避免历史数据被周桶过度压缩。
  if (span <= 6 * 3600) return 'minute';
  if (span <= DAY) return 'hour';
  if (span <= 90 * DAY) return 'day';
  return 'month';
}

export function resolveRange(params = {}, nowSec) {
  const now = Math.floor(nowSec ?? Date.now() / 1000);
  const tz = params.tz | 0;
  const range = params.range || '24h';
  let fromTs;
  switch (range) {
    case 'today': fromTs = alignStart(now, 'day', tz); break;
    case '7d': fromTs = now - 7 * DAY; break;
    case '30d': fromTs = now - 30 * DAY; break;
    case '90d': fromTs = now - 90 * DAY; break;
    case 'all': fromTs = 0; break;
    case 'custom': fromTs = params.from || 0; break;
    default: fromTs = now - DAY; // 24h
  }
  const toTs = range === 'custom' ? (params.to || now) : now;
  const requested = String(params.granularity || 'auto').toLowerCase();
  const gran = VALID_GRANULARITIES.has(requested) ? requested : autoGranularity(fromTs, toTs);
  // 桶数护栏：细粒度 × 大范围会爆桶（分钟×7天=1万桶、分钟×全部=几十万桶），拖垮构建与渲染。
  // 只在 minute/hour 两档内降档（day 桶数=实际天数，量级天然可控）；响应的 granularity 字段反映实际粒度。
  const MAX_BUCKETS = 2500;
  const stepOf = (g) => (g === 'minute' ? 60 : g === 'hour' ? 3600 : 0);
  let safe = gran;
  while ((safe === 'minute' || safe === 'hour') && (toTs - fromTs) / stepOf(safe) > MAX_BUCKETS) {
    safe = safe === 'minute' ? 'hour' : 'day';
  }
  return { fromTs, toTs, gran: safe, granularity: requested, tz, range };
}

function makeSets(params) {
  const toSet = (values) => Array.isArray(values) && values.length
    ? new Set(values.map((s) => String(s).toLowerCase()))
    : null;
  return {
    modelKeys: toSet(params.modelKeys),
    models: toSet(params.models),
    providers: toSet(params.providers),
  };
}

export function matchRow(provider, model, sets) {
  const p = String(provider ?? '').toLowerCase();
  const m = String(model ?? '').toLowerCase();
  // 新筛选键绑定 provider + model，避免跨供应商同名模型形成笛卡尔积误匹配。
  if (sets.modelKeys && !sets.modelKeys.has(p + '\u0000' + m)) return false;
  // 旧客户端仍可按模型名、供应商分别筛选；与新键同时出现时按交集处理。
  if (sets.models && !sets.models.has(m)) return false;
  if (sets.providers && !sets.providers.has(p)) return false;
  return true;
}

/** 展开合并 state → [{provider, model, b}]（含范围与筛选） */
export function iterBuckets(store, params = {}, nowSec = undefined) {
  const { fromTs, toTs, gran, granularity, tz } = resolveRange(params, nowSec);
  const sets = makeSets(params);
  // 优先用 store 的版本记忆快照（多路由共享一次全量合并）；测试用的裸 store 走旧路径
  const merged = store && typeof store.mergedStates === 'function'
    ? store.mergedStates()
    : mergeStates(collectStates(store));
  const out = [];
  for (const key of Object.keys(merged)) {
    const b = merged[key];
    if (b.hour < fromTs || b.hour > toTs) continue;
    const { provider, model } = splitKey(key);
    if (!matchRow(provider, model, sets)) continue;
    out.push({ provider, model, b });
  }
  return { rows: out, fromTs, toTs, gran, granularity, tz };
}

function collectStates(store) {
  const states = [];
  for (const entry of store.sessions.values()) if (entry.meta) states.push(entry.state);
  return states;
}

function collectSessionCount(store, fromTs, toTs, sets, pred = null) {
  let sessions = 0;
  for (const entry of store.sessions.values()) {
    const state = entry && entry.state;
    if (!state) continue;
    for (const key of Object.keys(state)) {
      const b = state[key];
      if (b.hour < fromTs || b.hour > toTs) continue;
      const { provider, model } = splitKey(key);
      if (!matchRow(provider, model, sets)) continue;
      if (pred && !pred(provider, model)) continue;
      sessions++;
      break;
    }
  }
  return sessions;
}

// 总额口径对齐 dsh-context「上下文洞察 / 计费 Token」：
// tokensOf = input + output + cacheRead + cacheWrite（reasoningTokens 不进总额，仍在 compare 表单列）；
// internal/(compaction)（内部压缩调用 usage）同样不计入总额/分布/趋势/热力图，仅在 compare 表保留台账行。
const tokensOf = (b) => b.inputTokens + b.outputTokens + b.cacheReadTokens + b.cacheWriteTokens;
const isCompactionRow = (provider, model) => provider === 'internal' || model === '(compaction)';

function pricingCurrency(pricer) {
  return String((pricer && pricer.target) || 'CNY').toUpperCase();
}

function costOfBucket(b, pricer, provider, model) {
  const currency = pricingCurrency(pricer);
  if (!pricer) return { priced: false, currency };
  const est = pricer.estimate(provider, model, {
    input: b.inputTokens, output: b.outputTokens, cacheRead: b.cacheReadTokens, cacheWrite: b.cacheWriteTokens,
  });
  return { ...est, currency: est.currency || currency };
}

function cacheKpi(t) {
  const hitRate = t.cacheObservedTokens > 0 ? t.cacheReadTokens / t.cacheObservedTokens : null;
  const billedInput = t.inputTokens + t.cacheReadTokens + t.cacheWriteTokens;
  const coverage = billedInput > 0 ? t.cacheObservedTokens / billedInput : null;
  return { cacheHitRate: hitRate, cacheCoverage: coverage };
}

const emptyTotals = (currency) => ({
  cost: null, costPriced: false, currency, requests: 0, okCount: 0, failCount: 0,
  inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
  totalTokens: 0, cacheHitRate: null, cacheCoverage: null,
});

/** KPI + 趋势 + 模型分布（消耗分布页/环形图共用 dist） */
export function buildUsage(store, params = {}, pricer = null, nowSec = undefined) {
  const { rows, fromTs, toTs, gran } = iterBuckets(store, params, nowSec);
  // 总额口径排除内部压缩桶（见 isCompactionRow 注释；compare 表仍保留该行）
  const core = rows.filter(({ provider, model }) => !isCompactionRow(provider, model));
  const currency = pricingCurrency(pricer);
  const totals = emptyTotals(currency);
  const distMap = new Map();
  const trendMap = new Map();
  for (const { provider, model, b } of core) {
    const est = costOfBucket(b, pricer, provider, model);
    totals.requests += b.count;
    totals.okCount += b.okCount;
    totals.failCount += b.failCount;
    totals.inputTokens += b.inputTokens;
    totals.outputTokens += b.outputTokens;
    totals.cacheReadTokens += b.cacheReadTokens;
    totals.cacheWriteTokens += b.cacheWriteTokens;
    totals.reasoningTokens += b.reasoningTokens;
    totals.totalTokens += tokensOf(b);
    if (est.priced) { totals.cost = (totals.cost ?? 0) + est.amount; totals.costPriced = true; }

    const mk = provider + '\u0000' + model;
    let d = distMap.get(mk);
    if (!d) { d = { provider, model, tokens: 0, calls: 0, cost: 0, priced: false, currency }; distMap.set(mk, d); }
    d.tokens += tokensOf(b); d.calls += b.count;
    if (est.priced) { d.cost += est.amount; d.priced = true; d.currency = est.currency; }

    const start = alignStart(b.hour, gran, params.tz | 0);
    let tr = trendMap.get(start);
    if (!tr) { tr = { start, count: 0, tokens: 0, cost: 0, priced: false, currency }; trendMap.set(start, tr); }
    tr.count += b.count; tr.tokens += tokensOf(b);
    if (est.priced) { tr.cost += est.amount; tr.priced = true; tr.currency = est.currency; }
  }
  if (core.length) {
    const all = core.map((r) => r.b);
    const merged = {
      ...all.reduce((acc, b) => ({
        ...acc,
        inputTokens: acc.inputTokens + b.inputTokens,
        cacheReadTokens: acc.cacheReadTokens + b.cacheReadTokens,
        cacheWriteTokens: acc.cacheWriteTokens + b.cacheWriteTokens,
        cacheObservedTokens: (acc.cacheObservedTokens ?? 0) + b.cacheObservedTokens,
      }), { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cacheObservedTokens: 0 }),
    };
    Object.assign(totals, cacheKpi(merged));
  }

  const dist = [...distMap.values()]
    .map((d) => ({ ...d, share: totals.totalTokens > 0 ? d.tokens / totals.totalTokens : 0 }))
    .sort((a, b2) => (b2.priced ? b2.cost : -1) - (a.priced ? a.cost : -1) || b2.tokens - a.tokens);
  const trend = [...trendMap.values()].sort((a, b2) => a.start - b2.start);
  const sessions = core.length ? collectSessionCount(store, fromTs, toTs, makeSets(params), (p, m) => !isCompactionRow(p, m)) : 0;
  return { range: { fromTs, toTs, gran }, currency, kpi: { ...totals, sessions }, trend, dist };
}

/** 调用趋势（次数/Token/费用三口径共用一套桶，客户端选指标） */
export function buildTrend(store, params = {}, pricer = null, nowSec = undefined) {
  const u = buildUsage(store, params, pricer, nowSec);
  return { range: u.range, currency: u.currency, granularity: u.range.gran, buckets: u.trend };
}

/** 模型 × 时间桶序列（消耗分布堆叠柱 / 调用趋势折线共用） */
export function buildStacks(store, params = {}, pricer = null, nowSec = undefined) {
  const { rows, fromTs, toTs, gran } = iterBuckets(store, params, nowSec);
  const currency = pricingCurrency(pricer);
  const map = new Map();
  for (const { provider, model, b } of rows) {
    if (isCompactionRow(provider, model)) continue; // 与总额同口径：内部压缩桶不进趋势/堆叠柱
    const start = alignStart(b.hour, gran, params.tz | 0);
    let bucket = map.get(start);
    if (!bucket) { bucket = new Map(); map.set(start, bucket); }
    const mk = provider + '\u0000' + model;
    let cell = bucket.get(mk);
    if (!cell) { cell = { provider, model, count: 0, tokens: 0, cost: 0, priced: false, currency }; bucket.set(mk, cell); }
    cell.count += b.count;
    cell.tokens += tokensOf(b);
    const est = costOfBucket(b, pricer, provider, model);
    if (est.priced) { cell.cost += est.amount; cell.priced = true; cell.currency = est.currency; }
  }
  // 按粒度补齐空桶：只在「首个到最后一个有数据的桶」之间补零，
  // 折线断档处贴 0 连续延伸（对齐 newapi），同时避免「全部」范围从 1970 年补出数百个空桶。
  const tz = params.tz | 0;
  const bucketStarts = [...map.keys()].sort((a, b) => a - b);
  if (!bucketStarts.length) return { range: { fromTs, toTs, gran }, currency, granularity: gran, buckets: [] };
  const stepSec = gran === 'minute' ? 60 : gran === 'hour' ? 3600 : gran === 'day' ? 86400 : 0;
  const buckets = [];
  let cursor = alignStart(Math.max(fromTs, bucketStarts[0]), gran, tz);
  const endAligned = alignStart(Math.min(toTs, bucketStarts[bucketStarts.length - 1]), gran, tz);
  while (cursor <= endAligned) {
    const hit = map.get(cursor);
    buckets.push(hit
      ? { start: cursor, gran, currency, cells: [...hit.values()].sort((x, y) => y.tokens - x.tokens) }
      : { start: cursor, gran, currency, cells: [] });
    if (stepSec) cursor += stepSec;
    else { // month：+40 天后对齐回下月起点（与 alignStart 的月对齐语义一致）
      const next = alignStart(cursor + 40 * 86400, 'month', tz);
      if (next <= cursor) break;
      cursor = next;
    }
  }
  return { range: { fromTs, toTs, gran }, currency, granularity: gran, buckets };
}

/** 模型对比表 */
export function buildCompare(store, params = {}, pricer = null, nowSec = undefined) {
  const { rows, fromTs, toTs, gran } = iterBuckets(store, params, nowSec);
  const byModel = new Map();
  for (const { provider, model, b } of rows) {
    const mk = provider + '\u0000' + model;
    let item = byModel.get(mk);
    if (!item) { item = { provider, model, list: [] }; byModel.set(mk, item); }
    item.list.push(b);
  }
  const models = [...byModel.values()].map(({ provider, model, list }) => {
    const b = list.reduce(mergeTwo, null);
    const est = costOfBucket(b, pricer, provider, model);
    const totalTokens = tokensOf(b);
    const billedInput = b.inputTokens + b.cacheReadTokens + b.cacheWriteTokens;
    return {
      provider, model, calls: b.count, ok: b.okCount, failed: b.failCount,
      inputTokens: b.inputTokens, outputTokens: b.outputTokens,
      cacheReadTokens: b.cacheReadTokens, cacheWriteTokens: b.cacheWriteTokens,
      reasoningTokens: b.reasoningTokens, totalTokens,
      avgLatencyMs: b.latencyCount > 0 ? Math.round(b.latencySumMs / b.latencyCount) : null,
      p50: percentileFromHist(b.latencyHist, 0.5),
      p95: percentileFromHist(b.latencyHist, 0.95),
      speedTokensPerSec: b.latencySumMs > 0 ? Math.round((b.outputTokens / (b.latencySumMs / 1000)) * 10) / 10 : null,
      cacheHitRate: b.cacheObservedTokens > 0 ? b.cacheReadTokens / b.cacheObservedTokens : null,
      cacheCoverage: billedInput > 0 ? b.cacheObservedTokens / billedInput : null,
      cost: est.priced ? est.amount : null, currency: est.priced ? est.currency : null, priced: !!est.priced,
      costPerMillionTokens: est.priced && totalTokens > 0 ? est.amount / (totalTokens / 1e6) : null,
    };
  });
  models.sort((a, b2) => (b2.cost ?? -1) - (a.cost ?? -1) || b2.totalTokens - a.totalTokens);
  return { range: { fromTs, toTs }, currency: pricingCurrency(pricer), models };
}

function mergeTwo(acc, b) {
  if (!acc) return { ...b, latencyHist: b.latencyHist.slice() };
  acc.count += b.count; acc.okCount += b.okCount; acc.failCount += b.failCount;
  acc.inputTokens += b.inputTokens; acc.outputTokens += b.outputTokens;
  acc.cacheReadTokens += b.cacheReadTokens; acc.cacheWriteTokens += b.cacheWriteTokens;
  acc.cacheObserved += b.cacheObserved; acc.cacheObservedTokens += b.cacheObservedTokens;
  acc.reasoningTokens += b.reasoningTokens; acc.genMsSum += b.genMsSum;
  acc.latencySumMs += b.latencySumMs; acc.latencyCount += b.latencyCount;
  for (let i = 0; i < acc.latencyHist.length; i++) acc.latencyHist[i] += b.latencyHist[i];
  return acc;
}

/** 最近 12 个月日历热力图数据 */
export function buildHeatmap(store, params = {}, nowSec = undefined) {
  const { rows, fromTs, toTs, tz } = iterBuckets(store, params, nowSec);
  const map = new Map();
  for (const { provider, model, b } of rows) {
    if (isCompactionRow(provider, model)) continue; // 与总额同口径
    const start = alignStart(b.hour, 'day', tz | 0);
    map.set(start, (map.get(start) || 0) + tokensOf(b));
  }
  const days = [...map.entries()].map(([day, tokens]) => ({ day, tokens })).sort((a, b) => a.day - b.day);
  return { range: { fromTs, toTs }, days };
}

/** 供应商/模型筛选下拉数据源 */
export function buildModels(store, params = {}, nowSec = undefined) {
  const { rows } = iterBuckets(store, params, nowSec);
  const vendors = new Map();
  for (const { provider, model } of rows) {
    let list = vendors.get(provider);
    if (!list) { list = new Set(); vendors.set(provider, list); }
    list.add(model);
  }
  const models = [...vendors.entries()].map(([provider, set]) => ({ provider, models: [...set].sort() }))
    .sort((a, b2) => a.provider.localeCompare(b2.provider));
  return { models };
}
