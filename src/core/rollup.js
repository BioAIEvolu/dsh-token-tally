// 小时桶 rollup 引擎（纯函数，无 I/O）
// 设计要点：
// - 桶键 = provider \0 model \0 minuteStart；minuteStart = ts - ts % 60，查询层再按粒度合并
// - rollup 只存原始 token/次数/时长/延迟直方图，**费用在查询层现算**（价目变更无需失效缓存）
// - foldSession(records) ≡ records 逐条 foldAppend（字节级一致，单测保证）
// - 延迟：固定对数分桶直方图（50ms 起，×1.5 步进，40 桶 + 溢出），跨窗口可合并求分位

export const MINUTE = 60;
export const HOUR = 3600;
export const LAT_BASE_MS = 50;
export const LAT_GROWTH = 1.5;
export const LAT_BUCKETS = 40;

export function latencyBucket(ms) {
  let t = LAT_BASE_MS;
  for (let i = 0; i < LAT_BUCKETS; i++) {
    if (ms < t) return i;
    t *= LAT_GROWTH;
  }
  return LAT_BUCKETS; // 溢出桶
}

export function latencyMsOfBucket(i) {
  let v = LAT_BASE_MS;
  for (let k = 0; k < i; k++) v *= LAT_GROWTH;
  return Math.round(v);
}

/** 对数直方图求分位（p∈(0,1]），返回桶下界近似毫秒；无数据返回 null */
export function percentileFromHist(hist, p) {
  let total = 0;
  for (const c of hist) total += c;
  if (!total) return null;
  const target = total * p;
  let acc = 0;
  for (let i = 0; i < hist.length; i++) {
    acc += hist[i];
    if (acc >= target) return latencyMsOfBucket(i);
  }
  return latencyMsOfBucket(hist.length - 1);
}

export function emptyBucket(hour) {
  return {
    hour,
    count: 0,
    okCount: 0,
    failCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheObserved: 0,
    cacheObservedTokens: 0,
    reasoningTokens: 0,
    genMsSum: 0,
    latencySumMs: 0,
    latencyCount: 0,
    latencyHist: new Array(LAT_BUCKETS + 1).fill(0),
  };
}

export function bucketKeyOf(rec) {
  const minute = rec.ts - (rec.ts % MINUTE);
  return rec.provider + '\u0000' + rec.model + '\u0000' + minute;
}

/** 单事件增量折叠；state 为普通对象（可 JSON 序列化，latencyHist 为数组） */
export function foldAppend(state, rec) {
  const key = bucketKeyOf(rec);
  let b = state[key];
  if (!b) {
    b = emptyBucket(rec.ts - (rec.ts % MINUTE));
    state[key] = b;
  }
  b.count += 1;
  if (rec.ok) b.okCount += 1; else b.failCount += 1;
  b.inputTokens += Number.isFinite(rec.inputTokens) && rec.inputTokens > 0 ? rec.inputTokens : 0;
  b.outputTokens += Number.isFinite(rec.outputTokens) && rec.outputTokens > 0 ? rec.outputTokens : 0;
  b.cacheReadTokens += Number.isFinite(rec.cacheReadTokens) && rec.cacheReadTokens > 0 ? rec.cacheReadTokens : 0;
  b.cacheWriteTokens += Number.isFinite(rec.cacheWriteTokens) && rec.cacheWriteTokens > 0 ? rec.cacheWriteTokens : 0;
  b.cacheObserved += Number.isFinite(rec.cacheObserved) && rec.cacheObserved > 0 ? rec.cacheObserved : 0;
  if (rec.cacheObserved) b.cacheObservedTokens += (Number.isFinite(rec.inputTokens) && rec.inputTokens > 0 ? rec.inputTokens : 0) + (Number.isFinite(rec.cacheReadTokens) && rec.cacheReadTokens > 0 ? rec.cacheReadTokens : 0) + (Number.isFinite(rec.cacheWriteTokens) && rec.cacheWriteTokens > 0 ? rec.cacheWriteTokens : 0);
  b.reasoningTokens += Number.isFinite(rec.reasoningTokens) && rec.reasoningTokens > 0 ? rec.reasoningTokens : 0;
  if (Number.isFinite(rec.genMs)) b.genMsSum += rec.genMs;
  if (Number.isFinite(rec.latencyMs) && rec.latencyMs >= 0) {
    b.latencyHist[latencyBucket(rec.latencyMs)] += 1;
    b.latencySumMs += rec.latencyMs;
    b.latencyCount += 1;
  }
  return state;
}

export function foldSession(records) {
  const state = {};
  for (const r of records) foldAppend(state, r);
  return state;
}

/** 合并一组桶（同模型或任意范围），用于查询层 */
export function mergeBuckets(buckets) {
  const out = emptyBucket(buckets.length ? buckets[0].hour : 0);
  for (const b of buckets) {
    out.count += b.count;
    out.okCount += b.okCount;
    out.failCount += b.failCount;
    out.inputTokens += b.inputTokens;
    out.outputTokens += b.outputTokens;
    out.cacheReadTokens += b.cacheReadTokens;
    out.cacheWriteTokens += b.cacheWriteTokens;
    out.cacheObserved += b.cacheObserved;
    out.cacheObservedTokens += b.cacheObservedTokens;
    out.reasoningTokens += b.reasoningTokens;
    out.genMsSum += b.genMsSum;
    out.latencySumMs += b.latencySumMs;
    out.latencyCount += b.latencyCount;
    for (let i = 0; i < out.latencyHist.length; i++) out.latencyHist[i] += b.latencyHist[i];
  }
  return out;
}

export function collectInRange(state, fromTs, toTs, pred) {
  const out = [];
  for (const key of Object.keys(state)) {
    const b = state[key];
    if (b.hour < fromTs || b.hour > toTs) continue;
    if (pred && !pred(key, b)) continue;
    out.push(b);
  }
  return out;
}

/** 合并多个会话 state → 单一合并 state（查询层用） */
export function mergeStates(states) {
  const grouped = new Map();
  for (const st of states) {
    for (const key of Object.keys(st)) {
      let list = grouped.get(key);
      if (!list) { list = []; grouped.set(key, list); }
      list.push(st[key]);
    }
  }
  const out = {};
  for (const [key, list] of grouped) out[key] = mergeBuckets(list);
  return out;
}

export function splitKey(key) {
  const i = key.indexOf('\u0000');
  const j = key.indexOf('\u0000', i + 1);
  return { provider: key.slice(0, i), model: key.slice(i + 1, j), hour: key.slice(j + 1) };
}

/** 粒度对齐：hour | day | month（tzOffsetSec：本地时区偏移，正=东区） */
export function alignStart(ts, gran, tzOffsetSec = 0) {
  if (gran === 'minute') return ts - (ts % MINUTE);
  if (gran === 'hour') return ts - (ts % HOUR);
  const DAY = 86400;
  const local = ts + tzOffsetSec;
  const dayStart = local - (local % DAY);
  if (gran === 'day') return dayStart - tzOffsetSec;
  if (gran === 'month') {
    const localDate = new Date(local * 1000);
    const monthStart = Date.UTC(localDate.getUTCFullYear(), localDate.getUTCMonth(), 1) / 1000;
    return monthStart - tzOffsetSec;
  }
  // 兼容旧调用方：历史 week 参数仍按周一对齐，但新 UI 不再暴露周粒度。
  const dayIndex = Math.floor(dayStart / DAY);
  const dow = (dayIndex + 3) % 7; // 1970-01-01 为周四；周一=0
  return dayStart - dow * DAY - tzOffsetSec;
}

/** 时间序列：[{ start, ...sums }] */
export function queryTrend(buckets, gran, tzOffsetSec = 0) {
  const map = new Map();
  for (const b of buckets) {
    const start = alignStart(b.hour, gran, tzOffsetSec);
    let agg = map.get(start);
    if (!agg) { agg = { start, count: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cacheObserved: 0, genMsSum: 0, latencyHist: new Array(LAT_BUCKETS + 1).fill(0) }; map.set(start, agg); }
    agg.count += b.count;
    agg.inputTokens += b.inputTokens;
    agg.outputTokens += b.outputTokens;
    agg.cacheReadTokens += b.cacheReadTokens;
    agg.cacheWriteTokens += b.cacheWriteTokens;
    agg.cacheObserved += b.cacheObserved;
    agg.genMsSum += b.genMsSum;
    for (let i = 0; i < agg.latencyHist.length; i++) agg.latencyHist[i] += b.latencyHist[i];
  }
  return [...map.values()].sort((a, b2) => a.start - b2.start);
}

/** 按 (provider,model) 聚合 → [{ provider, model, bucket }] */
export function queryByModel(state, fromTs, toTs) {
  const map = new Map();
  for (const key of Object.keys(state)) {
    const b = state[key];
    if (b.hour < fromTs || b.hour > toTs) continue;
    const { provider, model } = splitKey(key);
    const k = provider + '\u0000' + model;
    let entry = map.get(k);
    if (!entry) {
      entry = { provider, model, list: [] };
      map.set(k, entry);
    }
    entry.list.push(b);
  }
  return [...map.values()].map(({ provider, model, list }) => ({ provider, model, bucket: mergeBuckets(list) }));
}

/** 日历热力图：Map(localDayStart → totalTokens) */
export function queryHeatmap(state, fromTs, toTs, tzOffsetSec = 0) {
  const map = new Map();
  for (const key of Object.keys(state)) {
    const b = state[key];
    if (b.hour < fromTs || b.hour > toTs) continue;
    const start = alignStart(b.hour, 'day', tzOffsetSec);
    map.set(start, (map.get(start) || 0) + b.inputTokens + b.outputTokens + b.cacheReadTokens + b.cacheWriteTokens);
  }
  return map;
}
