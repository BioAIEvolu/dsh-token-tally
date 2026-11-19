// HTTP 只读路由守卫：仅接受 loopback（口径对齐 model-usage-plugin：Host 为回环地址且 Origin 与 Host 一致）

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1', '[::ffff:127.0.0.1]']);

function hostnameOf(value) {
  const v = String(value || '').trim();
  if (!v) return '';
  try {
    return new URL(v.includes('://') ? v : 'http://' + v).hostname.toLowerCase();
  } catch { return v.toLowerCase(); }
}

export function isLoopbackRequest(req) {
  const host = hostnameOf(req.headers && req.headers.host);
  if (!LOOPBACK.has(host)) return false;
  const origin = req.headers && req.headers.origin;
  if (origin) {
    const oh = hostnameOf(origin);
    if (oh && oh !== host) return false;
  }
  return true;
}

export function parseQuery(url) {
  const u = new URL(url, 'http://loopback.invalid');
  const numOpt = (k) => {
    const v = u.searchParams.get(k);
    if (v == null || v === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const list = (k) => {
    const arr = u.searchParams.getAll(k)
      .flatMap((v) => v.split(','))
      .map((s) => s.trim())
      .filter(Boolean);
    return arr.length ? arr : null;
  };
  return {
    range: u.searchParams.get('range') || '24h',
    granularity: u.searchParams.get('granularity') || 'auto',
    from: numOpt('from'),
    to: numOpt('to'),
    tz: numOpt('tz') || 0,
    modelKeys: list('modelKeys'),
    models: list('models'),
    providers: list('providers'),
    config: u.searchParams.get('config') || undefined,
  };
}
