// 会话存储发现与日志文件选择（优先级对齐参考实现）
import fs from 'node:fs';
import path from 'node:path';

const LOG_PRECEDENCE = [
  { re: /^session\.v(\d+)\.jsonl\.zstd$/, versioned: true },
  { re: /^session\.v(\d+)\.jsonl$/, versioned: true },
  { re: /^session\.jsonl\.zstd$/, versioned: false },
  { re: /^session\.jsonl$/, versioned: false },
];

// 裸 uuid 目录 = 子代理/委派会话（实证 <ws>/<uuid>/session.vN.jsonl.zstd，header 带 parentSession/origin=subagent）。
// v2 口径纳入统计以对齐 dsh-context：其上下文洞察 overview 会把子代理会话并入父会话 family 计入总额。
const BARE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function pickLogFile(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return null; }
  for (const tier of LOG_PRECEDENCE) {
    if (tier.versioned) {
      let best = null; let bestV = -1;
      for (const n of names) {
        const m = n.match(tier.re);
        if (!m) continue;
        const v = Number(m[1]) || 0;
        if (v > bestV) { best = n; bestV = v; }
      }
      if (best) return path.join(dir, best);
    } else {
      const hit = names.find((n) => tier.re.test(n));
      if (hit) return path.join(dir, hit);
    }
  }
  return null;
}

/**
 * 枚举会话日志：`<root>/<工作区>/session-<uuid>/<logfile>` 主会话，
 * 以及 `<root>/<工作区>/<裸uuid>/<logfile>` 子代理/委派会话（对齐 dsh-context 计入）。
 */
export function listSessionFiles(root) {
  const out = [];
  const seenIds = new Set();
  let workspaces;
  try { workspaces = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const w of workspaces) {
    if (!w.isDirectory()) continue;
    const wdir = path.join(root, w.name);
    let sess;
    try { sess = fs.readdirSync(wdir, { withFileTypes: true }); } catch { continue; }
    for (const s of sess) {
      if (!s.isDirectory()) continue;
      const isMain = /^session-/.test(s.name);
      const isBare = !isMain && BARE_UUID_RE.test(s.name);
      if (!isMain && !isBare) continue;
      const sdir = path.join(wdir, s.name);
      const file = pickLogFile(sdir);
      if (!file) continue;
      const sessionId = isMain ? s.name.slice('session-'.length) : s.name;
      if (seenIds.has(sessionId)) continue; // 同 id 冲突时主会话目录优先
      seenIds.add(sessionId);
      out.push({ sessionId, dir: sdir, file, workspace: w.name });
    }
  }
  return out;
}
