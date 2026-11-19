import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// 防止只改 src、桌面端却继续加载旧 lib 的回归。
test('构建产物包含费用弹窗作用域修复和错误边界', () => {
  const code = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  assert.ok(code.includes('showPricing ? pricingDialog(h, {'), 'lib 必须显式传递费用弹窗状态');
  assert.ok(!code.includes('showPricing ? pricingDialog()'), 'lib 不得再调用无作用域的旧 pricingDialog');
  assert.ok(code.includes('function makeErrorBoundary'), 'lib 必须包含面板错误边界');
  assert.ok(code.includes('useState(null)'), 'lib 必须默认跟随最新时间窗口');
});

test('构建产物：环形图单时间线动画三件套齐备，旧掩膜/逐扇区方案无残留', () => {
  const code = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  assert.ok(code.includes('@property --progress'), '--progress 必须注册为 <number>，否则 keyframes 只能离散跳变');
  assert.ok(code.includes('@keyframes mca-donut-grow'), '整圆生长 keyframes 必须在插件级 CSS（唯一时间线）');
  assert.ok(code.includes('var(--progress,1)*var(--paint-total) - var(--paint-start)'), '进度、起点、段长必须统一为 SVG 弧长单位');
  assert.ok(code.includes('mca-line-in .9s linear'), '趋势线必须线性绘制，圆点延迟才能精确对齐笔尖');
  assert.ok(code.includes('stroke-dasharray:0 100;stroke-dashoffset:0'), '趋势线动画必须与 pathLength=100 的归一化单位一致');
  assert.ok(!code.includes('stroke-dashoffset:2000'), '不得残留未归一化的旧线条动画');
  assert.ok(code.includes('mca-point-in .3s'), '圆点快速落定，贴合笔尖经过时刻');
  assert.ok(code.includes('style="--progress:1"'), 'g 层静态终态兜底（禁动画/未跑时呈完整环）');
  assert.ok(!code.includes('mca-arc-'), '不得残留逐扇区 keyframes（多图同屏同名冲突）');
  for (const legacy of ['--sweep-angle', 'mca-donut-sweep', 'mca-donut-grow-mask']) {
    assert.ok(!code.includes(legacy), '旧掩膜方案残留：' + legacy);
  }
});
