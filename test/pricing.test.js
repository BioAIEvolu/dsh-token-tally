import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeModelId, parsePricingCsv, makePricer } from '../src/core/pricing.js';

test('normalizeModelId：作用域前缀/大小写/日期后缀/batch', () => {
  assert.equal(normalizeModelId('Z-AI/Glm-5.3'), 'glm-5.3');
  assert.equal(normalizeModelId('global:gpt-6-luna'), 'gpt-6-luna');
  assert.equal(normalizeModelId('cn:K3'), 'k3');
  assert.equal(normalizeModelId('deepseek-v4-flash-0731'), 'deepseek-v4-flash');
  assert.equal(normalizeModelId('k3:batch'), 'k3');
  assert.equal(normalizeModelId('Qwen3.8-Flash-sg'), 'qwen3.8-flash');
  assert.equal(normalizeModelId('claude-sonnet-5'), 'claude-sonnet-5');
  assert.equal(normalizeModelId('gemini-4-argon'), 'gemini-4-argon');
  assert.equal(normalizeModelId('gpt-5.6-luna-20261107'), 'gpt-5.6-luna');
});

test('estimate：四档分开计价', () => {
  const rows = parsePricingCsv('deepseek,deepseek-flash,CNY,1,4,0.2,2\n');
  const pricer = makePricer(rows, { target: 'CNY' });
  const r = pricer.estimate('deepseek', 'DeepSeek-V4-Flash-0731', { input: 1e6, output: 2e6, cacheRead: 3e6, cacheWrite: 0 });
  assert.equal(r.priced, true);
  assert.equal(r.currency, 'CNY');
  // 1×1 + 2×4 + 3×0.2 = 9.6
  assert.ok(Math.abs(r.amount - 9.6) < 1e-9);
});

test('estimate：未匹配价目 → priced:false（绝不计 0）', () => {
  const pricer = makePricer(parsePricingCsv('deepseek,deepseek-flash,CNY,1,4,0.2,2\n'));
  const r = pricer.estimate('openai', 'gpt-6-astra', { input: 1e6 });
  assert.deepEqual(r, { priced: false });
});

test('provider 级覆盖价优先于模型级默认价（统一折算到目标币）', () => {
  const rows = parsePricingCsv([
    '*,glm-5.1,USD,1.4,4.4,0.26,4.4',
    'bailian,glm-5.1,CNY,6,24,1.6,24',
  ].join('\n'));
  const pricer = makePricer(rows); // target 默认 CNY
  const bailian = pricer.estimate('bailian', 'glm-5.1', { output: 1e6 });
  assert.equal(bailian.currency, 'CNY');
  assert.ok(Math.abs(bailian.amount - 24) < 1e-9); // 命中 provider 覆盖价
  const generic = pricer.estimate('z-ai', 'glm-5.1', { output: 1e6 });
  assert.equal(generic.currency, 'CNY'); // 统一标注目标币
  assert.ok(Math.abs(generic.amount - 4.4 * 7.2) < 1e-9); // 回落通用价并按汇率折算
});

test('convert：外币折算到目标币', () => {
  const pricer = makePricer([], { target: 'CNY', rates: { CNY: 1, USD: 7.2 } });
  assert.ok(Math.abs(pricer.convert(2, 'USD') - 14.4) < 1e-9);
});
