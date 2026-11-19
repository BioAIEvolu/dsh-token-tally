// 归一化适配层：DSH 会话事件 → rollup 记录
// 字段名实证见 docs/data-format-notes.md（M0-A/B）：
// - 事件顶层 { type, seq, time(epoch ms), data }
// - 用量在 assistant/message（亦见 compaction/summary）：data.usage{inputTokens,outputTokens,
//   cacheReadTokens,reasoningTokens,cacheWriteTokens?(可缺省)}，data.message.source.{provider,model}
// - cacheWriteTokens 缺省 → 用 hasOwn 判定 cacheObserved（对齐参考实现 cacheKnown 语义）
// - compaction/summary 的 usage 是内部压缩调用的真实计费（参考实现漏计）→ kind:'compaction' 计入
// - 类型串同时接受斜杠/连字符两种写法（不同来源转写不一致，运行期兜底）
// TODO(M2)：usageSig 去重（消息id|time|provider|model|五元token）防崩溃重放双计

function num(x) {
  return typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : 0;
}

function isType(t, slash, dash) {
  return t === slash || t === dash;
}

export function usageEventToRecord(ev) {
  if (!ev || ev.time == null) return null;
  const type = ev.type;
  let kind = null;
  if (isType(type, 'assistant/message', 'assistant-message')) kind = 'message';
  else if (isType(type, 'compaction/summary', 'compaction-summary')) kind = 'compaction';
  else return null;
  const data = ev.data || {};
  const u = data.usage;
  if (!u) return null;
  const src = (data.message && data.message.source) || {};
  const model = src.model || (kind === 'compaction' ? '(compaction)' : '');
  if (!model) return null;
  const cacheKnown = Object.hasOwn(u, 'cacheReadTokens') || Object.hasOwn(u, 'cacheWriteTokens');
  return {
    ts: Math.floor(ev.time / 1000),
    provider: src.provider || (kind === 'compaction' ? 'internal' : '*'),
    model,
    kind,
    ok: true,
    inputTokens: num(u.inputTokens),
    outputTokens: num(u.outputTokens),
    cacheReadTokens: num(u.cacheReadTokens),
    cacheWriteTokens: num(u.cacheWriteTokens),
    cacheObserved: cacheKnown ? 1 : 0,
    reasoningTokens: num(u.reasoningTokens),
    latencyMs: undefined, // 由 SessionTimer 配对补齐
  };
}

function stepKeyOf(ev) {
  const d = ev.data || {};
  const t = d.turn !== undefined ? d.turn : (d.message && d.message.turn !== undefined ? d.message.turn : '*');
  const s = d.step !== undefined ? d.step : (d.message && d.message.step !== undefined ? d.message.step : '*');
  return t + ':' + s;
}

/**
 * 会话级适配器：维护 step/start → assistant/message 的开步表，配对出响应时长。
 * chunk 丢失（DSH v2+ 持久化会丢 chunk）时退化为消息时间差口径。
 */
export function makeSessionAdapter() {
  const openSteps = new Map();
  return {
    feed(ev) {
      if (!ev || ev.type == null) return null;
      if (isType(ev.type, 'step/start', 'step-start')) {
        const k = stepKeyOf(ev);
        if (k) openSteps.set(k, ev.time);
        return null;
      }
      const rec = usageEventToRecord(ev);
      if (!rec) return null;
      const k = stepKeyOf(ev);
      if (k && openSteps.has(k)) {
        const start = openSteps.get(k);
        if (ev.time >= start) rec.latencyMs = ev.time - start;
        openSteps.delete(k);
      }
      return rec;
    },
    reset() { openSteps.clear(); },
  };
}
