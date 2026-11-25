// 截图 README 展示图：node scripts/shoot-readme.mjs（依赖 md-studio 的 playwright-core 与本机 ms-playwright chromium）
import { chromium } from 'file:///D:/Project/DSH/dsh-md-studio/node_modules/playwright-core/index.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const shotsDir = path.join(root, 'out', 'shots');
const imgDir = path.join(root, 'docs', 'images');
fs.mkdirSync(imgDir, { recursive: true });

const exe = process.env.LOCALAPPDATA + '\\ms-playwright\\chromium-1254\\chrome-win64\\chrome.exe';
if (!fs.existsSync(exe)) throw new Error('chromium not found: ' + exe);

const browser = await chromium.launch({ executablePath: exe, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });

const shots = [
  ['hero.html', 'hero.png'],
  ['trend.html', 'trend.png'],
  ['cache.html', 'cache.png'],
  ['donut.html', 'donut.png'],
  ['rank.html', 'rank.png'],
  ['compare.html', 'compare.png'],
  ['sessions.html', 'sessions.png'],
];

for (const [src, dest] of shots) {
  await page.goto('file:///' + path.join(shotsDir, src).replace(/\\/g, '/'));
  await page.waitForTimeout(300);
  // 视口高度自适应内容，避免 fullPage 截出大片空白
  const h = await page.evaluate(() => Math.ceil(document.body.scrollHeight));
  await page.setViewportSize({ width: 1280, height: Math.max(360, Math.min(h, 1100)) });
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(imgDir, dest), fullPage: true });
  const kb = Math.round(fs.statSync(path.join(imgDir, dest)).size / 1024);
  console.log('shot', dest, kb + 'KB');
}
await browser.close();
console.log('done ->', imgDir);
