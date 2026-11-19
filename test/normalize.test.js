import { test } from 'node:test';
import assert from 'node:assert/strict';
import { usageEventToRecord, makeSessionAdapter } from '../src/core/normalize.js';

const BASE = {
  type: 'assistant/message',
  seq: 26,
  time: 1793979897605,
  data: {
    turn: 3,
    step: 1,
    message: { role: 'assistant', source: { kind: 'model', provider: 'codex', model: 'gpt-6-astra' } },
    usage: { inputTokens: 4638, outputTokens: 201, cacheReadTokens: 51456, reasoningTokens: 179 },
  },
};

test('assistant/message：字段映射与 cacheObserved（hasOwn 判定）', () => {
  const r = usageEventToRecord(BASE);
  assert.ok(r);
  assert.equal(r.ts, 1793979897); // epoch ms → s
  assert.equal(r.provider, 'codex');
  assert.equal(r.model, 'gpt-6-astra');
  assert.equal(r.inputTokens, 4638);
  assert.equal(r.cacheObserved, 1); // 有 cacheReadTokens 字段
  assert.equal(r.cacheWriteTokens, 0); // 缺省归 0
  assert.equal(r.kind, 'message');
});

test('无任何缓存遥测字段 → cacheObserved = 0', () => {
  const ev = structuredClone(BASE);
  delete ev.data.usage.cacheReadTokens;
  const r = usageEventToRecord(ev);
  assert.equal(r.cacheObserved, 0);
  assert.equal(r.cacheReadTokens, 0);
});

test('compaction/summary 也带 usage：归为 compaction 计入', () => {
  const ev = {
    type: 'compaction/summary', time: 1793979999000,
    data: { usage: { inputTokens: 5000, outputTokens: 800 } },
  };
  const r = usageEventToRecord(ev);
  assert.ok(r);
  assert.equal(r.kind, 'compaction');
  assert.equal(r.model, '(compaction)');
  assert.equal(r.provider, 'internal');
  assert.equal(r.cacheObserved, 0);
});

test('连字符类型写法同样识别（口径兜底）', () => {
  const ev = structuredClone(BASE);
  ev.type = 'assistant-message';
  assert.ok(usageEventToRecord(ev));
});

test('无关事件返回 null', () => {
  assert.equal(usageEventToRecord({ type: 'tool-call', time: 1, data: {} }), null);
  assert.equal(usageEventToRecord({ type: 'assistant/message', time: 1, data: {} }), null); // 无 usage
  assert.equal(usageEventToRecord(null), null);
});

test('SessionTimer：step/start 配对出响应时长', () => {
  const adapter = makeSessionAdapter();
  assert.equal(adapter.feed({ type: 'step/start', time: 1793979888000, data: { turn: 3, step: 1 } }), null);
  const r = adapter.feed(BASE);
  assert.ok(r);
  assert.equal(r.latencyMs, 9605); // 1793979897605 - 1793979888000
});

test('SessionTimer：无配对步时不设 latencyMs', () => {
  const adapter = makeSessionAdapter();
  const r = adapter.feed(BASE);
  assert.ok(r);
  assert.equal(r.latencyMs, undefined);
});

test('连字符 step-start 同样配对', () => {
  const adapter = makeSessionAdapter();
  adapter.feed({ type: 'step-start', time: 1793979888000, data: { turn: 3, step: 1 } });
  const r = adapter.feed(BASE);
  assert.equal(r.latencyMs, 9605);
});
