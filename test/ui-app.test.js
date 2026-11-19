import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import TestRenderer from 'react-test-renderer';
import { createUI } from '../src/client/ui.js';
import { makeErrorBoundary } from '../src/client/index.js';

const h = React.createElement;
const { act } = TestRenderer;

function textOf(node) {
  return (node.children || []).map((child) => typeof child === 'string' ? child : textOf(child)).join('');
}

// react-test-renderer：查询 API 在 renderer.root（ReactTestInstance）上。
function all(root, pred) { return root.root.findAll(pred); }
function one(root, pred) { return root.root.find(pred); }
function button(root, label) {
  return all(root, (n) => n.type === 'button' && (textOf(n).trim() === label || n.props['aria-label'] === label))[0];
}

function payload(overrides = {}) {
  const buckets = Array.from({ length: 30 }, (_, i) => ({
    start: 1794000000 + i * 3600,
    gran: 'hour',
    cells: [{ provider: 'p', model: 'm-' + i, count: 1, tokens: 100 + i, cost: 0.1, priced: true, currency: 'CNY' }],
  }));
  return {
    usage: { kpi: { cost: 1, costPriced: true, currency: 'CNY', sessions: 1, requests: 1, totalTokens: 100, cacheHitRate: null, cacheCoverage: null }, dist: [{ provider: 'p', model: 'm', calls: 1, tokens: 100, cost: 1, priced: true, currency: 'CNY' }] },
    stacks: { buckets },
    compare: { models: [{ provider: 'p', model: 'm', calls: 1, ok: 1, failed: 0, totalTokens: 100, inputTokens: 60, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 1, priced: true, currency: 'CNY' }] },
    models: { models: [{ provider: 'p', models: ['m', 'shared'] }, { provider: 'q', models: ['shared'] }] },
    heatmap: { days: [] },
    pricing: { version: 1, currency: 'CNY', rows: [], defaults: [], source: 'builtin' },
    'pricing/save': { version: 1, currency: 'CNY', rows: [], defaults: [], source: 'manual' },
    ...overrides,
  };
}

function installGlobals(t) {
  const old = {
    localStorage: globalThis.localStorage,
    document: globalThis.document,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
  };
  const intervals = [];
  const store = new Map();
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) };
  globalThis.document = { visibilityState: 'visible', activeElement: null, addEventListener() {}, removeEventListener() {} };
  globalThis.setInterval = (fn) => { intervals.push(fn); return intervals.length; };
  globalThis.clearInterval = () => {};
  const createNodeMock = (type) => ({
    focus() {}, click() {}, querySelectorAll() { return []; },
    disabled: !!type.disabled, hidden: !!type.hidden,
  });
  t.after(() => {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
  });
  return { intervals, createNodeMock };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function mount(t, env, el) {
  let root;
  await act(async () => { root = TestRenderer.create(el, { createNodeMock: env.createNodeMock }); });
  t.after(() => { if (!root._isUnmounted) root.unmount(); root._isUnmounted = true; });
  await flush();
  return root;
}

test('App：真实挂载后打开费用设置，不再因 pricingDraft 作用域崩溃', async (t) => {
  const data = payload();
  const api = { call: async (path) => data[path] };
  const env = installGlobals(t);
  const { App } = createUI(React, api);
  const root = await mount(t, env, h(App));
  assert.ok(button(root, '费用设置'));
  await act(async () => { button(root, '费用设置').props.onClick(); });
  await flush();
  assert.equal(all(root, (n) => n.props && n.props.role === 'dialog').length, 1);
  assert.ok(button(root, '保存价格'));
  await act(async () => { button(root, '关闭').props.onClick(); });
  assert.equal(all(root, (n) => n.props && n.props.role === 'dialog').length, 0);
});

test('App：复合模型筛选不锁死选项，元数据请求不带筛选', async (t) => {
  const data = payload();
  const calls = [];
  const api = { call: async (path, params) => { calls.push({ path, params }); return data[path]; } };
  const env = installGlobals(t);
  const { App } = createUI(React, api);
  const root = await mount(t, env, h(App));
  const modelBox = all(root, (n) => n.type === 'input' && n.props.type === 'checkbox' && !n.props['aria-label'])[0];
  await act(async () => { modelBox.props.onChange(); });
  await flush();
  const modelRequests = calls.filter((c) => c.path === 'models');
  assert.equal(modelRequests.length, 1, '切换筛选时复用未过滤的模型目录');
  assert.equal(modelRequests.at(-1).params.modelKeys, undefined);
  assert.equal(modelRequests.at(-1).params.providers, undefined);
  const usageRequest = calls.filter((c) => c.path === 'usage').at(-1);
  assert.deepEqual(usageRequest.params.modelKeys, ['p\0m']);
  assert.ok(all(root, (n) => n.type === 'input' && n.props.type === 'checkbox').length >= 4, '所有供应商和模型选项仍保留');
});

test('App：全部范围切换日/月只加载新时间桶，切回命中缓存', async (t) => {
  const env = installGlobals(t);
  globalThis.localStorage.setItem('mca.prefs.v1', JSON.stringify({ range: 'all', granularity: 'day' }));
  const data = payload();
  const calls = [];
  const api = { call: async (path, params) => { calls.push([path, params.granularity]); return data[path]; } };
  const { App } = createUI(React, api);
  const root = await mount(t, env, h(App));
  calls.length = 0;
  await act(async () => { button(root, '月').props.onClick(); });
  await flush();
  assert.deepEqual(calls, [['stacks', 'month']]);
  calls.length = 0;
  await act(async () => { button(root, '天').props.onClick(); });
  await flush();
  assert.deepEqual(calls, []);
});

test('App：默认显示最新 24 桶，静默刷新保留用户浏览窗口', async (t) => {
  const data = payload();
  const api = { call: async (path) => data[path] };
  const env = installGlobals(t);
  const { App } = createUI(React, api);
  const root = await mount(t, env, h(App));
  const chart = () => one(root, (n) => n.props && n.props.className === 'mca-unsafe mca-split-main mca-chart-wrap').props.dangerouslySetInnerHTML.__html;
  assert.ok(chart().includes('m-29'));
  assert.ok(!chart().includes('m-0<'));
  await act(async () => { button(root, '较早一个时间桶').props.onClick(); });
  assert.ok(chart().includes('m-5'));
  assert.ok(!chart().includes('m-29'));
  assert.equal(env.intervals.length, 1);
  await act(async () => { env.intervals[0](); });
  await flush();
  assert.ok(chart().includes('m-5'), '30 秒静默刷新不重置用户窗口');
  assert.ok(!chart().includes('m-29'));
});

test('App：小环和大环在轮询更新数据时复用动画宿主', async (t) => {
  const data = payload();
  const env = installGlobals(t);
  const { App } = createUI(React, { call: async path => data[path] });
  const root = await mount(t, env, h(App));
  const clock = () => one(root, n => n.type === 'div' && n.props.className?.split(' ').includes('mca-donut-grow'));
  for (const tab of ['消耗分布', '调用次数分布']) {
    await act(async () => { button(root, tab).props.onClick(); });
    const before = clock();
    const markup = before.props.dangerouslySetInnerHTML.__html;
    data.usage = { ...data.usage, dist: data.usage.dist.map(d => ({ ...d, tokens: d.tokens + 200 })) };
    await act(async () => { env.intervals[0](); });
    await flush();
    assert.strictEqual(clock(), before);
    assert.notEqual(clock().props.dangerouslySetInnerHTML.__html, markup);
    assert.ok(!markup.includes('mca-donut-grow'), '可替换的 SVG 内无第二个入场时钟');
  }
});

test('App：100% 占比按钮已接线，失败态可手动重试', async (t) => {
  const data = payload();
  let fail = true;
  let usageCalls = 0;
  const api = { call: async (path) => {
    if (path === 'usage') { usageCalls++; if (fail) throw new Error('offline'); }
    return data[path];
  } };
  const env = installGlobals(t);
  const { App } = createUI(React, api);
  const root = await mount(t, env, h(App));
  assert.ok(button(root, '占比'), '总览失败时已加载的时序图仍可用');
  assert.ok(all(root, n => n.props?.role === 'alert' && textOf(n).includes('总览（offline）')).length);
  fail = false;
  await act(async () => { button(root, '重试').props.onClick(); });
  await flush();
  assert.ok(usageCalls >= 2);
  const percent = button(root, '占比');
  assert.equal(percent.props['aria-pressed'], false);
  await act(async () => { percent.props.onClick(); });
  assert.equal(button(root, '占比').props['aria-pressed'], true);
  const chart = one(root, (n) => n.props && n.props.className === 'mca-unsafe mca-split-main mca-chart-wrap').props.dangerouslySetInnerHTML.__html;
  assert.ok(chart.includes('25%'));
});

test('错误边界：组件异常显示可见错误，重试后恢复', async (t) => {
  const Boundary = makeErrorBoundary(React);
  let fail = true;
  function Child() { if (fail) throw new Error('boom'); return h('div', null, '已恢复'); }
  t.mock.method(console, 'error', () => {});
  const env = installGlobals(t);
  const root = await mount(t, env, h(Boundary, null, h(Child)));
  assert.ok(button(root, '重试'));
  assert.ok(all(root, (n) => textOf(n).includes('Token 台账暂时无法显示')).length > 0);
  fail = false;
  await act(async () => { button(root, '重试').props.onClick(); });
  assert.ok(all(root, (n) => textOf(n) === '已恢复').length > 0);
});
