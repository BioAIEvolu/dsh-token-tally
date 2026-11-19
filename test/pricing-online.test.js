import test from 'node:test';
import assert from 'node:assert/strict';
import { litellmToRows, fetchOnlinePrices } from '../src/core/pricing-online.js';
import { mergePriceRows, builtinPrices, makePricer } from '../src/core/pricing.js';

test('litellmToRows：USD/token → 每百万 token，跳过免费/非 chat', () => {
  const json = {
    'openai/gpt-4o': { mode: 'chat', input_cost_per_token: 2.5e-6, output_cost_per_token: 1e-5, cache_read_input_token_cost: 1.25e-6, litellm_provider: 'openai' },
    'anthropic/claude-sonnet-4-5': { mode: 'chat', input_cost_per_token: 3e-6, output_cost_per_token: 1.5e-5, litellm_provider: 'anthropic' },
    'free/model': { mode: 'chat', input_cost_per_token: 0, output_cost_per_token: 0, litellm_provider: 'openai' },
    'embedding/model': { mode: 'embedding', input_cost_per_token: 1e-7, output_cost_per_token: 0, litellm_provider: 'openai' },
    'sample_spec': { mode: 'chat', input_cost_per_token: 0, output_cost_per_token: 0 },
  };
  const rows = litellmToRows(json);
  assert.equal(rows.length, 2);
  const gpt = rows.find((r) => r.modelId === 'gpt-4o');
  assert.equal(gpt.provider, 'openai');
  assert.equal(gpt.currency, 'USD');
  assert.ok(Math.abs(gpt.perMillion.input - 2.5) < 1e-9);
  assert.ok(Math.abs(gpt.perMillion.output - 10.0) < 1e-9);
  assert.ok(Math.abs(gpt.perMillion.cacheRead - 1.25) < 1e-9);
});

test('mergePriceRows：CSV 覆盖 > 在线 > 内置', () => {
  const builtin = [{ provider: 'deepseek', modelId: 'deepseek-chat', currency: 'USD', perMillion: { input: 0.27, output: 1.10, cacheRead: 0.07, cacheWrite: 0.28 } }];
  const online = [{ provider: 'deepseek', modelId: 'deepseek-chat', currency: 'USD', perMillion: { input: 0.30, output: 1.20, cacheRead: 0.08, cacheWrite: 0.30 } }];
  const csv = [{ provider: 'deepseek', modelId: 'deepseek-chat', currency: 'CNY', perMillion: { input: 2.0, output: 8.0, cacheRead: 0.5, cacheWrite: 2.0 } }];
  const merged = mergePriceRows(csv, online, builtin);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].currency, 'CNY', 'CSV override wins');
  // 不传 CSV 时在线赢
  const merged2 = mergePriceRows([], online, builtin);
  assert.ok(Math.abs(merged2[0].perMillion.input - 0.30) < 1e-9, 'online wins over builtin');
});

test('makePricer：内置价能计价 deepseek-chat', () => {
  const pricer = makePricer(mergePriceRows([], [], builtinPrices()), { target: 'USD' });
  const est = pricer.estimate('deepseek', 'deepseek-chat', { input: 1e6, output: 1e6, cacheRead: 0, cacheWrite: 0 });
  assert.ok(est.priced);
  assert.ok(Math.abs(est.amount - (0.27 + 1.10)) < 1e-9, '1M in + 1M out = input+output');
  assert.equal(est.currency, 'USD');
});

test('fetchOnlinePrices：网络异常 / 非 200 / 无 fetch 时返回 null', async () => {
  const bad = await fetchOnlinePrices({ fetchImpl: async () => { throw new Error('network down'); } });
  assert.equal(bad, null);
  const http500 = await fetchOnlinePrices({ fetchImpl: async () => ({ ok: false, status: 500 }) });
  assert.equal(http500, null);
  const empty = await fetchOnlinePrices({ fetchImpl: async () => ({ ok: true, json: async () => ({}) }) });
  assert.equal(empty, null, 'empty JSON → null');
  const noFetch = await fetchOnlinePrices({ fetchImpl: null });
  assert.equal(noFetch, null);
});

test('fetchOnlinePrices：成功响应可转为在线价目表', async () => {
  const rows = await fetchOnlinePrices({ fetchImpl: async () => ({
    ok: true,
    json: async () => ({
      'openai/gpt-4o': { mode: 'chat', input_cost_per_token: 2.5e-6, output_cost_per_token: 1e-5, litellm_provider: 'openai' },
    }),
  }) });
  assert.ok(Array.isArray(rows));
  assert.equal(rows[0].modelId, 'gpt-4o');
  assert.equal(rows[0].provider, 'openai');
});
