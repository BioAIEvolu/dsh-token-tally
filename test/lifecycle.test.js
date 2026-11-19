import test from 'node:test';
import assert from 'node:assert/strict';
import { registerStylesEffect } from '../src/client/index.js';

test('client: stylesheet stays mounted until effect disposal', () => {
  let mounted = 0;
  let removed = 0;
  const cleanups = [];
  const ctx = {
    effect(setup) {
      const cleanup = setup();
      assert.equal(typeof cleanup, 'function');
      cleanups.push(cleanup);
      return cleanup;
    },
  };
  registerStylesEffect(ctx, () => {
    mounted++;
    return () => { mounted--; removed++; };
  });
  assert.equal(mounted, 1);
  assert.equal(removed, 0, 'setup must not invoke stylesheet cleanup');
  assert.equal(cleanups.length, 1);
  cleanups[0]();
  assert.equal(mounted, 0);
  assert.equal(removed, 1);
});
