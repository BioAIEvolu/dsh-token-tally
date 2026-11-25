// RollupStore：会话发现、回填（预算制）、磁盘 rollup 缓存、实时事件接入
// 缓存契约：{v, id, file, mtimeMs, size, state}，v 变更或 file+mtime+size 不全等即失效
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { foldAppend, mergeStates } from './rollup.js';
import { makeSessionAdapter } from './normalize.js';
import { readSessionFile } from './log-reader.js';
import { listSessionFiles } from './session-files.js';

// v1→v2：口径变更（纳入子代理会话 + 对齐 dsh-context 的继承种子重置语义），旧缓存整体失效重建
export const CACHE_FORMAT_VERSION = 2;
const ID_RE = /^[A-Za-z0-9._-]{1,200}$/;

function statOf(file) {
  try {
    const st = fs.statSync(file);
    return { file, mtimeMs: Math.round(st.mtimeMs), size: st.size };
  } catch { return null; }
}

function sanitizeId(id) { return typeof id === 'string' && ID_RE.test(id) ? id : null; }

/** 布尔型继承种子标记（DSH v4 日志：session/end-seed{inherited:true}） */
export function isInheritedSeed(ev) {
  if (!ev || (ev.type !== 'session/end-seed' && ev.type !== 'session-end-seed')) return false;
  return (ev.data || {}).inherited === true;
}

function maxSeqOf(events) {
  let m = 0;
  for (const ev of events) if (ev && typeof ev.seq === 'number' && ev.seq > m) m = ev.seq;
  return m;
}

export class RollupStore {
  constructor(opts = {}) {
    this.root = opts.root;
    this.cacheDir = opts.cacheDir;
    this.budgetMs = opts.budgetMs ?? 30000;
    // v2 口径默认纳入子代理/委派会话（对齐 dsh-context）；config.includeSubagents=false 可显式回退旧行为
    this.excludeSubagents = opts.excludeSubagents === true;
    /** id -> { state, adapter, meta:{file,mtimeMs,size}|null, buffer:[], fromCache } */
    this.sessions = new Map();
    this.excluded = new Map();   // id -> reason（子代理等）
    this.pending = [];
    this.cursor = 0;
    this.knownIds = new Set();
    // 合并快照记忆：查询层多路由（usage/stacks/compare/models/heatmap）共享一次全量合并；
    // 任何会话状态变更（回填/实时事件/扫描删除）都会 bump 版本使快照失效。
    this.__merged = null;
    this.__version = 0;
    this.__workers = null;
  }

  /** 回填线程池（惰性创建）；不可用时返回 null，调用方回退主线程同步解析。
   * 每个 worker 挂常驻 message/error 分发器，按任务 id 路由结果（避免每任务叠加监听器）。 */
  workerPool() {
    if (this.__workers) return this.__workers;
    try {
      const size = Math.max(1, Math.min(4, (os.availableParallelism?.() ?? os.cpus()?.length ?? 2) - 1));
      this.__workers = Array.from({ length: size }, () => {
        const w = new Worker(new URL('./backfill-worker.js', import.meta.url));
        w.__pending = new Map();
        w.on('message', (m) => {
          const resolve = w.__pending.get(m && m.id);
          if (resolve) { w.__pending.delete(m.id); resolve(m); }
        });
        w.on('error', (err) => {
          for (const resolve of w.__pending.values()) resolve({ error: String((err && err.message) || err) });
          w.__pending.clear();
        });
        w.unref(); // 不阻止宿主进程退出
        return w;
      });
      return this.__workers;
    } catch { this.__workers = null; return null; }
  }

  /** 把 worker（或主线程同步）折叠结果落到 sessions；返回是否处理成功 */
  applyFolded(job, res) {
    const { id, meta } = job;
    if (res && res.excluded) { this.excluded.set(id, res.excluded); this.sessions.delete(id); this.touch(); return true; }
    try {
      if (!res || !res.state) throw new Error(res && res.error || 'worker failed');
      const cur = this.sessions.get(id);
      const entry = { state: res.state, adapter: makeSessionAdapter(), meta, buffer: [], fromCache: false };
      // 排水：解析期间到达的实时事件，按 seq 防双计
      if (cur && cur.buffer && cur.buffer.length) {
        for (const ev of cur.buffer) {
          if (ev && typeof ev.seq === 'number' && ev.seq <= res.maxSeq) continue;
          const rec = entry.adapter.feed(ev);
          if (rec) foldAppend(entry.state, rec);
        }
      }
      this.sessions.set(id, entry);
      this.saveCache(id, entry);
      this.touch();
      return true;
    } catch { return false; }
  }

  /** 主线程同步解析单文件（worker 失败时的兜底路径，与 buildSession 同语义） */
  applyFoldedSync(job) {
    try {
      const events = readSessionFile(job.file);
      const header = this.headerOf(events);
      const reason = this.excludedReason(header);
      if (reason) { this.excluded.set(job.id, reason); this.sessions.delete(job.id); this.touch(); return true; }
      const maxSeq = maxSeqOf(events);
      return this.applyFolded(job, { state: this.buildSession(events), maxSeq }) || true;
    } catch { return false; }
  }

  /** 单个 worker 顺序消费任务队列 */
  async drainWithWorker(worker, misses, startRef, deadline) {
    while (startRef.next < misses.length) {
      if (Date.now() > deadline) return;
      const job = misses[startRef.next++];
      let res = null;
      try {
        res = await new Promise((resolve) => {
          worker.__pending.set(job.id, resolve);
          worker.postMessage({ id: job.id, file: job.file, excludeSubagents: this.excludeSubagents });
        });
      } catch { /* worker.__pending 分发器不会 reject */ }
      if (!this.applyFolded(job, res)) this.applyFoldedSync(job);
    }
  }

  /** 会话状态发生变更时调用：使合并快照失效 */
  touch() { this.__version++; }

  /** 全量合并快照（带版本记忆）；未发生任何变更时重复调用零成本 */
  mergedStates() {
    if (this.__merged && this.__merged.version === this.__version) return this.__merged.data;
    const states = [];
    for (const entry of this.sessions.values()) if (entry.meta) states.push(entry.state);
    const data = mergeStates(states);
    this.__merged = { version: this.__version, data };
    return data;
  }

  headerOf(events) { return events.find((e) => e && e.type === 'session') || null; }

  excludedReason(header) {
    if (!this.excludeSubagents || !header) return null;
    const h = header.data || header;
    if ((Number(h.delegationDepth) || 0) > 0) return 'delegationDepth';
    if (h.parentSession) return 'parentSession';
    if (h.origin === 'subagent') return 'origin';
    return null;
  }

  seedCutOf(events) {
    let cut = 0;
    for (const ev of events) {
      if (!ev || typeof ev.seq !== 'number') continue;
      // 仅数字型 inherited（旧日志）走 seq 截断；布尔 inherited:true 由 buildSession 流式重置处理
      if (ev.type === 'session/end-seed' || ev.type === 'session-end-seed') {
        const inh = ev.data && ev.data.inherited;
        if (typeof inh === 'number') cut = Math.max(cut, inh);
      } else if (ev.type === 'session') {
        const h = ev.data || ev;
        cut = Math.max(cut, Number(h.seedLength) || 0);
      }
    }
    return cut;
  }

  buildSession(events) {
    const adapter = makeSessionAdapter();
    const cut = this.seedCutOf(events);
    let state = {};
    for (const ev of events) {
      if (!ev || typeof ev.seq !== 'number') continue;
      // 对齐 dsh-context activity fold：session/end-seed{inherited:true} 表示其前缀是继承自父会话的
      // 历史（这些 token 已计入父会话），遇到即重置已累计状态，避免父历史被双计（v4 日志为布尔 inherited）。
      if (isInheritedSeed(ev)) { state = {}; adapter.reset(); continue; }
      if (ev.seq <= cut) continue;
      const rec = adapter.feed(ev);
      if (rec) foldAppend(state, rec);
    }
    return state;
  }

  /** 枚举 + 与现有条目比对（file+mtime+size 全等即跳过） */
  scan() {
    const files = listSessionFiles(this.root);
    this.pending = [];
    const previousIds = this.knownIds;
    this.knownIds = new Set();
    for (const id of previousIds) {
      if (!files.some((f) => f.sessionId === id)) { this.sessions.delete(id); this.touch(); }
    }
    for (const f of files) {
      const id = sanitizeId(f.sessionId);
      if (!id || this.excluded.has(id)) continue;
      this.knownIds.add(id);
      const stat = statOf(f.file);
      if (!stat) continue;
      const meta = { ...stat, workspace: f.workspace };
      const cur = this.sessions.get(id);
      if (cur && cur.meta && cur.meta.file === meta.file && cur.meta.mtimeMs === meta.mtimeMs && cur.meta.size === meta.size) continue;
      this.pending.push({ id, file: f.file, meta });
    }
    return this.pending.length;
  }

  loadCache(id, meta) {
    if (!this.cacheDir) return null;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(this.cacheDir, id + '.json'), 'utf8'));
      if (!raw || raw.v !== CACHE_FORMAT_VERSION || !raw.state) return null;
      if (raw.file !== meta.file || raw.mtimeMs !== meta.mtimeMs || raw.size !== meta.size) return null;
      return raw.state;
    } catch { return null; }
  }

  saveCache(id, entry) {
    if (!this.cacheDir || !entry.meta) return;
    try {
      fs.mkdirSync(this.cacheDir, { recursive: true });
      const payload = JSON.stringify({
        v: CACHE_FORMAT_VERSION, id, file: entry.meta.file, mtimeMs: entry.meta.mtimeMs, size: entry.meta.size, state: entry.state,
      });
      const tmp = path.join(this.cacheDir, id + '.json.tmp');
      fs.writeFileSync(tmp, payload);
      fs.renameSync(tmp, path.join(this.cacheDir, id + '.json'));
    } catch { /* 缓存失败不影响查询正确性 */ }
  }

  /** 预算制回填 pending；返回 { done, processed }。
   * 缓存命中在主线程直接装载；未命中且数量 ≥2 时派发线程池并行解析（CPU 密集），
   * worker 失败或环境不支持时逐个回退主线程同步路径。 */
  async backfillPending(deadline = Date.now() + this.budgetMs) {
    let processed = 0;
    const misses = [];
    while (this.cursor < this.pending.length) {
      if (Date.now() > deadline) return { done: false, processed };
      const job = this.pending[this.cursor++];
      const cached = this.loadCache(job.id, job.meta);
      if (cached) {
        const entry = { state: cached, adapter: makeSessionAdapter(), meta: job.meta, buffer: [], fromCache: true };
        const cur = this.sessions.get(job.id);
        if (cur && cur.buffer && cur.buffer.length) {
          for (const ev of cur.buffer) {
            const rec = entry.adapter.feed(ev);
            if (rec) foldAppend(entry.state, rec);
          }
        }
        this.sessions.set(job.id, entry);
        this.touch();
        processed++;
        continue;
      }
      misses.push(job);
    }

    if (misses.length >= 2) {
      const workers = this.workerPool();
      if (workers && workers.length) {
        // worker 已 unref：回填期间持有一个保活定时器，避免事件循环只剩 unref 句柄时提前退出
        const keepAlive = setInterval(() => {}, 1000);
        try {
          const startRef = { next: 0 };
          await Promise.all(workers.map((w) => this.drainWithWorker(w, misses, startRef, deadline)));
          processed += startRef.next;
          const done = startRef.next >= misses.length;
          if (!done) { this.cursor -= misses.length - startRef.next; } // 未派发的留给下一轮 reconcile
          return { done, processed };
        } finally { clearInterval(keepAlive); }
      }
    }

    // 串行路径：单文件、线程池不可用、或并行轮次超预算后的剩余文件
    let serial = 0;
    for (; serial < misses.length; serial++) {
      if (Date.now() > deadline) { this.cursor -= misses.length - serial; return { done: false, processed }; }
      this.applyFoldedSync(misses[serial]);
      processed++;
      await new Promise((r) => setImmediate(r));
    }
    return { done: true, processed };
  }

  /** 后台初始化：扫描 + 预算制回填 */
  init() {
    this.scan();
    this.cursor = 0;
    return this.backfillPending();
  }

  /** 60s 周期：新会话/变更文件入 pending 重处理；缓存命中路径开销极小 */
  reconcile() {
    this.scan();
    this.cursor = 0;
    return this.backfillPending();
  }

  /**
   * 实时事件入口。未完成回填的会话先进 buffer（按 seq 防双计，见 backfillPending 排水）。
   */
  onLiveEvent(sessionId, ev) {
    const id = sanitizeId(sessionId);
    if (!id || this.excluded.has(id) || !ev) return;
    let entry = this.sessions.get(id);
    if (!entry) {
      entry = { state: {}, adapter: makeSessionAdapter(), meta: null, buffer: [], fromCache: false };
      this.sessions.set(id, entry);
    }
    if (entry.meta === null) { entry.buffer.push(ev); return; }
    const rec = entry.adapter.feed(ev);
    if (rec) { foldAppend(entry.state, rec); this.touch(); }
  }

  cleanupOrphans(maxAgeMs = 3600_000) {
    if (!this.cacheDir) return;
    let names;
    try { names = fs.readdirSync(this.cacheDir); } catch { return; }
    const now = Date.now();
    for (const name of names) {
      if (!name.endsWith('.json') || name === 'pricing.json') continue;
      const id = name.slice(0, -'.json'.length);
      if (this.knownIds.has(id) || this.sessions.has(id)) continue;
      const full = path.join(this.cacheDir, name);
      try { if (now - fs.statSync(full).mtimeMs > maxAgeMs) fs.unlinkSync(full); } catch { /* ignore */ }
    }
  }
}
