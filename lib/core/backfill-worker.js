// 回填工作线程：读日志 + 折叠为 state（与 RollupStore.buildSession 同语义）。
// 主线程只在磁盘缓存未命中时派发任务；zstd 解压与 JSON 解析是 CPU 密集，
// 多线程并行把冷启动全量回填从串行 ~14s 压到接近核数分之一。
import { parentPort } from 'node:worker_threads';
import { readSessionFile } from './log-reader.js';
import { makeSessionAdapter } from './normalize.js';
import { foldAppend } from './rollup.js';
import { isInheritedSeed } from './store.js';

function seedCutOf(events) {
  let cut = 0;
  for (const ev of events) {
    if (!ev || typeof ev.seq !== 'number') continue;
    if (ev.type === 'session/end-seed' || ev.type === 'session-end-seed') {
      const inh = ev.data && ev.data.inherited;
      if (typeof inh === 'number') cut = Math.max(cut, inh);
    } else if (ev.type === 'session') {
      cut = Math.max(cut, Number(ev.data?.seedLength) || 0);
    }
  }
  return cut;
}

function excludedReason(header, excludeSubagents) {
  if (!excludeSubagents || !header) return null;
  const h = header.data || header;
  if ((Number(h.delegationDepth) || 0) > 0) return 'delegationDepth';
  if (h.parentSession) return 'parentSession';
  if (h.origin === 'subagent') return 'origin';
  return null;
}

parentPort.on('message', (job) => {
  try {
    const events = readSessionFile(job.file);
    const header = events.find((e) => e && e.type === 'session') || null;
    const reason = excludedReason(header, job.excludeSubagents);
    if (reason) { parentPort.postMessage({ id: job.id, excluded: reason }); return; }
    const cut = seedCutOf(events);
    const adapter = makeSessionAdapter();
    let state = {};
    let maxSeq = 0;
    for (const ev of events) {
      if (!ev || typeof ev.seq !== 'number') continue;
      if (ev.seq > maxSeq) maxSeq = ev.seq;
      if (isInheritedSeed(ev)) { state = {}; adapter.reset(); continue; }
      if (ev.seq <= cut) continue;
      const rec = adapter.feed(ev);
      if (rec) foldAppend(state, rec);
    }
    parentPort.postMessage({ id: job.id, state, maxSeq });
  } catch (err) {
    parentPort.postMessage({ id: job.id, error: String((err && err.message) || err) });
  }
});
