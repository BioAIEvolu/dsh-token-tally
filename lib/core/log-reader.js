// 会话日志读取：zstd 多帧拼接逐帧解码（M0-B 实证唯一可行路径）+ 纯 jsonl 兜底
import fs from 'node:fs';
import zlib from 'node:zlib';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

export function looksZstd(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(4);
    fs.readSync(fd, head, 0, 4, 0);
    return head.equals(MAGIC);
  } finally { fs.closeSync(fd); }
}

/** 逐帧切片解码；返回 { chunks, ok, failed }（魔数误报切片跳过并计数） */
export function decodeZstdMultiFrame(buf) {
  const chunks = [];
  let ok = 0, failed = 0;
  let start = -1;
  let i = 0;
  for (;;) {
    const hit = buf.indexOf(MAGIC, i);
    if (hit === -1) break;
    if (start >= 0) {
      try { chunks.push(zlib.zstdDecompressSync(buf.subarray(start, hit))); ok++; }
      catch { failed++; }
    }
    start = hit;
    i = hit + 1;
  }
  if (start >= 0) {
    try { chunks.push(zlib.zstdDecompressSync(buf.subarray(start))); ok++; }
    catch { failed++; }
  }
  return { chunks, ok, failed };
}

function pushLines(events, buf) {
  for (const line of buf.toString('utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { events.push(JSON.parse(t)); } catch { /* 半行（帧尾）跳过 */ }
  }
}

/** 读整个会话日志 → 事件数组（含 session 头） */
export function readSessionFile(file) {
  const buf = fs.readFileSync(file);
  const events = [];
  if (looksZstd(file)) {
    const { chunks } = decodeZstdMultiFrame(buf);
    for (const c of chunks) pushLines(events, c);
  } else {
    pushLines(events, buf);
  }
  return events;
}
