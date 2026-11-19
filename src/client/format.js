// 客户端格式化工具（纯函数；构建时合并进 lib/client.js）
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** CSV 单元格转义；文本公式前缀加 apostrophe，避免表格软件执行注入公式。 */
export function csvCell(value) {
  let text = String(value ?? '');
  if (typeof value === 'string' && /^\s*[=+\-@]/.test(text)) text = "'" + text;
  return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

export function fmtInt(n) { return Math.round(n || 0).toLocaleString('en-US'); }

export function fmtTokens(n) {
  n = n || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(Math.round(n));
}

export function fmtCost(n, currency = 'CNY') {
  if (n == null) return '未配置';
  const symbol = String(currency).toUpperCase() === 'USD' ? '$' : '¥';
  return symbol + (n >= 100 ? n.toFixed(2) : n.toFixed(2));
}

export function fmtPct(x) { return x == null ? '—' : (x * 100).toFixed(1) + '%'; }

// 面向用户的模型名称：保留原始值用于筛选/查询，仅在展示层翻译内部事件标签。
export function displayModelName(model) {
  const raw = String(model ?? '');
  // 内部 compaction 事件可能带 provider/ 前缀；只翻译末尾的模型标识，避免破坏筛选用原值。
  const match = raw.match(/^(.*\/)?(?:\(compaction\)|compaction)$/i);
  return match ? (match[1] || '') + '上下文压缩' : raw;
}

export function fmtMs(ms) {
  if (ms == null) return '—';
  if (ms < 1000) return Math.round(ms) + 'ms';
  return (ms / 1000).toFixed(ms < 10000 ? 2 : 1) + 's';
}

export function fmtSpeed(x) { return x == null ? '—' : x.toFixed(1) + ' t/s'; }

export function fmtDay(ts, gran, tz) {
  const d = new Date((ts + (tz | 0)) * 1000);
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  if (gran === 'minute') return mm + '-' + dd + ' ' + String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0');
  if (gran === 'hour') return mm + '-' + dd + ' ' + String(d.getUTCHours()).padStart(2, '0') + ':00';
  if (gran === 'month') return d.getUTCFullYear() + '-' + mm;
  return mm + '-' + dd;
}

export function fmtFullDay(ts, tz) {
  const d = new Date((ts + (tz | 0)) * 1000);
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
}
