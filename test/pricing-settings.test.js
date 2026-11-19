import test from 'node:test';
import assert from 'node:assert/strict';
import { makePricer, normalizeModelId, parsePricingCsv } from '../src/core/pricing.js';

test('pricing settings CSV rows normalize DSH model IDs before lookup', () => {
  const rows = parsePricingCsv('codex,gpt-6-astra-2026-10-01,CNY,10,20,,\n');
  const pricer = makePricer(rows, { target: 'CNY' });
  assert.equal(normalizeModelId('gpt-6-astra-2026-10-01'), 'gpt-6-astra');
  assert.equal(pricer.estimate('codex', 'gpt-6-astra', { input: 1e6, output: 0 }).amount, 10);
});

test('pricing settings leave unknown IDs unpriced', () => {
  const pricer = makePricer([{ provider: 'codex', modelId: 'gpt-6-astra', currency: 'CNY', perMillion: { input: 1, output: 2 } }], { target: 'CNY' });
  assert.equal(pricer.estimate('other-provider', 'gpt-6-astra', { input: 1e6 }).priced, false);
});
