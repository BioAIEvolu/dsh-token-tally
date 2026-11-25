// 程序化目检：断言每个演示页的关键元素数量正确（等价于目检图表是否画全）
import { chromium } from 'file:///D:/Project/DSH/dsh-md-studio/node_modules/playwright-core/index.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const exe = process.env.LOCALAPPDATA + '\\ms-playwright\\chromium-1254\\chrome-win64\\chrome.exe';
const browser = await chromium.launch({ executablePath: exe, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

const checks = [
  ['hero.html', async () => ({
    bars: await page.locator('.mca-bar-seg').count(),
    legendItems: await page.locator('.mca-legend-item, .mca-legend-entry').count(),
    heatCells: await page.locator('rect[class*="mca-h"]').count(),
    kpis: await page.locator('.mca-kpi').count(),
    tabs: await page.locator('.mca-tab').count(),
    svgs: await page.locator('svg.mca-svg').count(),
  })],
  ['trend.html', async () => ({
    lines: await page.locator('.mca-anim-line').count(),
    points: await page.locator('.mca-anim-point').count(),
    svgs: await page.locator('svg.mca-svg').count(),
  })],
  ['cache.html', async () => ({
    lines: await page.locator('.mca-anim-line').count(),
    points: await page.locator('.mca-anim-point').count(),
    svgs: await page.locator('svg.mca-svg').count(),
    emptyCells: await page.locator('.mca-empty').count(),
  })],
  ['donut.html', async () => ({
    arcs: await page.locator('.mca-donut-arc').count(),
    pops: await page.locator('.mca-pop').count(),
    svgs: await page.locator('svg.mca-svg').count(),
  })],
  ['rank.html', async () => ({
    bars: await page.locator('.mca-bar-seg').count(),
    svgs: await page.locator('svg.mca-svg').count(),
  })],
  ['compare.html', async () => ({
    rows: await page.locator('.mca-cmp-row').count(),
    cols: await page.locator('.mca-table thead th').count(),
    emptyCells: await page.locator('.mca-empty').count(),
    rootHeight: await page.locator('.mca-compare-page').evaluate((el) => el.getBoundingClientRect().height),
    cardHeight: await page.locator('.mca-compare-page > .mca-body > .mca-card').evaluate((el) => el.getBoundingClientRect().height),
    scrollHeight: await page.locator('.mca-compare-scroll').evaluate((el) => el.getBoundingClientRect().height),
    scrollOverflow: await page.locator('.mca-compare-scroll').evaluate((el) => getComputedStyle(el).overflow),
  })],
  ['sessions.html', async () => ({
    rows: await page.locator('.mca-table tbody tr').count(),
    cols: await page.locator('.mca-table thead th').count(),
    emptyCells: await page.locator('.mca-empty').count(),
    sessionIds: await page.locator('.mca-session-id').count(),
    rootHeight: await page.locator('.mca-compare-page').evaluate((el) => el.getBoundingClientRect().height),
    scrollHeight: await page.locator('.mca-session-scroll').evaluate((el) => el.getBoundingClientRect().height),
    scrollOverflow: await page.locator('.mca-session-scroll').evaluate((el) => getComputedStyle(el).overflow),
    providerFilter: await page.locator('select[aria-label="筛选供应商"]').count(),
    workspaceFilter: await page.locator('select[aria-label="筛选工作区"]').count(),
  })],
];

let fail = 0;
for (const [file, fn] of checks) {
  await page.goto('file:///' + path.join(root, 'out', 'shots', file).replace(/\\/g, '/'));
  await page.waitForTimeout(200);
  const r = await fn();
  console.log(file, JSON.stringify(r));
  if (r.rows === 0 || r.svgs === 0 || (r.emptyCells ?? 0) > 0) fail++;
  if (file === 'hero.html' && r.tabs !== 6) fail++;
  if (file === 'cache.html' && (r.points < 100 || r.emptyCells > 0)) fail++;
  if (file === 'sessions.html' && (r.rows !== 6 || r.cols !== 8 || r.sessionIds !== 6 || r.rootHeight < 700 || r.scrollHeight < 400 || r.scrollOverflow !== 'auto' || r.providerFilter !== 1 || r.workspaceFilter !== 1)) fail++;
  if (file === 'compare.html' && (r.rootHeight < 700 || r.cardHeight < 500 || r.scrollHeight < 400 || r.scrollOverflow !== 'auto')) fail++;
}
await browser.close();
console.log('page errors:', errors.length ? errors.slice(0, 4) : 'none');
console.log(fail === 0 && errors.length === 0 ? 'ALL DOM CHECKS PASS' : 'CHECKS FAILED: ' + fail);
process.exit(fail === 0 && errors.length === 0 ? 0 : 1);
