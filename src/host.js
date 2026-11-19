// host 半边：cordis 服务装配 + 只读 JSON 路由（仅 loopback）
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { RollupStore } from './core/store.js';
import { parsePricingCsv, makePricer, mergePriceRows, builtinPrices } from './core/pricing.js';
import { fetchOnlinePrices } from './core/pricing-online.js';

const PRICE_CONFIG_NAME = 'pricing.json';

function priceConfigPath(cacheDir) { return path.join(cacheDir, PRICE_CONFIG_NAME); }

function readPriceConfig(cacheDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(priceConfigPath(cacheDir), 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch { return {}; }
}

function rowsToConfig(rows) {
  return (rows || []).map((r) => ({
    provider: r.provider || '*', model: r.modelId, currency: r.currency || 'CNY',
    input: r.perMillion && r.perMillion.input, output: r.perMillion && r.perMillion.output,
    cacheRead: r.perMillion && r.perMillion.cacheRead, cacheWrite: r.perMillion && r.perMillion.cacheWrite,
  }));
}

function configToRows(config) {
  if (!Array.isArray(config && config.rows)) return [];
  return config.rows.map((r) => ({
    provider: String(r.provider || '*').trim(), modelId: String(r.model || r.modelId || '').trim().toLowerCase(),
    currency: String(r.currency || 'CNY').trim().toUpperCase(),
    perMillion: { input: Number.isFinite(Number(r.input)) ? Number(r.input) : null, output: Number.isFinite(Number(r.output)) ? Number(r.output) : null, cacheRead: Number.isFinite(Number(r.cacheRead)) ? Number(r.cacheRead) : null, cacheWrite: Number.isFinite(Number(r.cacheWrite)) ? Number(r.cacheWrite) : null },
  })).filter((r) => r.modelId);
}

function savePriceConfig(cacheDir, config) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const target = priceConfigPath(cacheDir);
  const temp = target + '.tmp-' + process.pid;
  fs.writeFileSync(temp, JSON.stringify(config, null, 2) + '\n', 'utf8');
  fs.renameSync(temp, target);
}
import { isLoopbackRequest, parseQuery } from './core/route-guard.js';
import { buildUsage, buildTrend, buildStacks, buildCompare, buildHeatmap, buildModels } from './core/query.js';

export const name = 'token-tally';

// 不声明必需 inject：cordis 对声明了必需服务的插件，缺任一服务就静默不调用 apply。
// webServer 在 apply 内按需注入（skin-market 同款形态）。

function pricingPayload(cacheDir, pricer, onlineRows = []) {
  const saved = readPriceConfig(cacheDir);
  const defaults = onlineRows.length ? onlineRows : builtinPrices();
  return {
    version: 1,
    currency: (pricer && pricer.target) || saved.currency || 'CNY',
    rates: saved.rates || {},
    rows: rowsToConfig(configToRows(saved)),
    defaults: rowsToConfig(defaults),
    updatedAt: saved.updatedAt || null,
    source: onlineRows.length ? 'builtin+online' : 'builtin',
  };
}

const ROUTES = [
  { path: '/token-tally-api/usage', build: buildUsage },
  { path: '/token-tally-api/pricing', build: (store, params, pricer) => pricingPayload(params.__cacheDir, pricer, params.__onlineRows || []) },
  { path: '/token-tally-api/pricing/save', build: (store, params, pricer) => {
    try {
      const incoming = JSON.parse(String(params.config || '{}'));
      const rows = configToRows(incoming);
      savePriceConfig(params.__cacheDir, { version: 1, currency: incoming.currency || 'CNY', rates: incoming.rates || {}, rows: rowsToConfig(rows), updatedAt: new Date().toISOString(), source: 'manual' });
      params.__savedPricer = makeConfiguredPricer(params.__cacheDir, params.__config || {}, params.__onlineRows || []);
      if (params.__pricerRef) params.__pricerRef.current = params.__savedPricer;
      if (params.__respCache) params.__respCache.clear();
    } catch { /* malformed imports are ignored and current config is returned */ }
    return pricingPayload(params.__cacheDir, params.__savedPricer || pricer, params.__onlineRows || []);
  }},
  { path: '/token-tally-api/trend', build: buildTrend },
  { path: '/token-tally-api/stacks', build: buildStacks },
  { path: '/token-tally-api/compare', build: buildCompare },
  { path: '/token-tally-api/heatmap', build: buildHeatmap },
  { path: '/token-tally-api/models', build: buildModels },
];

function resolveStoreRoot(ctx) {
  try {
    const persist = ctx.get && ctx.get('sessionPersistence');
    if (persist && typeof persist.root === 'string' && persist.root) return persist.root;
  } catch { /* 服务缺省时回退 */ }
  return path.join(os.homedir(), '.dsh', 'sessions');
}

// 价目表：内置兜底 + 用户 CSV 覆盖立即生效；后台拉 LiteLLM 在线表成功后原子合并（CSV 仍优先）
function readBundledPriceRows() {
  try {
    const csvUrl = new URL('../pricing/models.csv', import.meta.url);
    return parsePricingCsv(fs.readFileSync(csvUrl, 'utf8'));
  } catch { return []; }
}

function makeConfiguredPricer(cacheDir, config, onlineRows = []) {
  const saved = readPriceConfig(cacheDir);
  const target = saved.currency || (config && config.currency) || 'CNY';
  const rates = saved.rates || (config && config.rates);
  const savedRows = configToRows(saved);
  const bundledRows = readBundledPriceRows();
  // builtin → online → bundled CSV → saved manual overrides
  const rows = mergePriceRows(savedRows, bundledRows, builtinPrices().concat(onlineRows || []));
  return makePricer(rows, { target, rates });
}

function loadPricer(config, onRefresh, cacheDir) {
  const saved = readPriceConfig(cacheDir);
  const target = saved.currency || (config && config.currency) || 'CNY';
  const rates = saved.rates || (config && config.rates);
  const savedRows = configToRows(saved);
  const csvRows = readBundledPriceRows();
  const pricer = makePricer(mergePriceRows(savedRows, csvRows, builtinPrices()), { target, rates });
  // 后台异步拉 LiteLLM 在线价格（8s 超时），成功后合并刷新；失败静默保留现状
  fetchOnlinePrices({ timeoutMs: 8000 }).then((onlineRows) => {
    if (onlineRows && onlineRows.length) {
      const merged = makeConfiguredPricer(cacheDir, config, onlineRows);
      if (onRefresh) onRefresh(merged, onlineRows.length, onlineRows);
    }
  }).catch(() => {});
  return pricer;
}

function bootLog(cacheDir, message) {
  // 启动诊断落盘：Loader 对插件失败静默，这里留本机证据（~/.dsh/token-tally-cache/boot.log）
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.appendFileSync(path.join(cacheDir, 'boot.log'),
      `${new Date().toISOString()} ${message}\n`);
  } catch { /* ignore */ }
}

export function apply(ctx, config) {
  const cacheDir = (config && config.cacheDir) || path.join(os.homedir(), '.dsh', 'token-tally-cache');
  try {
    const root = resolveStoreRoot(ctx);
    const store = new RollupStore({
      root, cacheDir,
      budgetMs: (config && config.backfillBudgetMs) ?? 30000,
      // v2 口径默认纳入子代理/委派会话（对齐 dsh-context 总额）；includeSubagents:false 可显式回退 v1 行为
      excludeSubagents: (config && config.includeSubagents) === false,
    });
    // pricer 可在线刷新：在线 LiteLLM 表拉成功后原子替换，handler 闭包引用同一对象
    const pricerRef = { current: null, onlineRows: [], config: config || {} };
    pricerRef.current = loadPricer(config, (fresh, n, onlineRows) => {
      pricerRef.current = fresh;
      pricerRef.onlineRows = onlineRows || [];
      bootLog(cacheDir, `online prices merged: ${n} models from LiteLLM`);
    }, cacheDir);

  // 实时事件：增量折叠（未回填完成的会话自动进缓冲，按 seq 防双计）
  ctx.on && ctx.on('session/event', (session, ev) => {
    try { store.onLiveEvent(session && session.id, ev); } catch { /* 单事件失败不传染 */ }
  });

  // 60s 对账：新会话/变更文件；孤儿缓存清理
  const timer = setInterval(() => {
    try { store.reconcile().then(() => store.cleanupOrphans()); } catch { /* ignore */ }
  }, 60000);
  timer.unref && timer.unref();
  ctx.effect && ctx.effect(() => () => clearInterval(timer), 'token-tally: reconcile timer');

  // 首次回填（后台、预算制，不阻塞启动）
  store.init().catch(() => {});

  // 请求级缓存：30s TTL（单飞简化为 key 级在途 Promise）
  const respCache = new Map();   // key -> { at, data }
  const inflight = new Map();    // key -> Promise
  async function cached(key, make) {
    const now = Date.now();
    const hit = respCache.get(key);
    if (hit && now - hit.at < 30000) return hit.data;
    // 无界增长防护：超限时先清理过期项（key 含筛选/粒度组合，长期使用会持续产生新键）
    if (respCache.size > 128) {
      for (const [k, v] of respCache) if (now - v.at >= 30000) respCache.delete(k);
    }
    let p = inflight.get(key);
    if (!p) {
      p = (async () => {
        try { const data = await make(); respCache.set(key, { at: Date.now(), data }); return data; }
        finally { inflight.delete(key); }
      })();
      inflight.set(key, p);
    }
    return p;
  }

  // 路由注册（精确复刻 dsh-skin-market 的 ctx.inject(['webServer','loader']) 形态）
  ctx.inject && ctx.inject(['webServer', 'loader'], (host) => {
    // 服务名探测：枚举 host 全部键 + 逐个试常见名，结果落盘（loader 对插件静默，证据必须落盘）
    let hostKeys = [];
    try { hostKeys = host && typeof host === 'object' ? Object.keys(host) : []; } catch { hostKeys = ['<err>']; }
    const svcNames = ['webServer', 'router', 'httpServer', 'server', 'http', 'web'];
    const probe = svcNames.map((n) => {
      try {
        const v = (host && host[n]) ?? (ctx.get && ctx.get(n));
        return `${n}=${typeof v}(${v && typeof v === 'object' ? Object.keys(v).slice(0,8).join('|') : ''})`;
      } catch { return `${n}=ERR`; }
    }).join(' ');
    bootLog(cacheDir, `inject cb fired. hostKeys=[${hostKeys.join(',')}] probe: ${probe}`);
    let server = null;
    for (const n of svcNames) {
      const v = (host && host[n]) ?? (ctx.get && ctx.get(n));
      if (v && typeof v.register === 'function') { server = { name: n, svc: v }; break; }
    }
    if (!server) { bootLog(cacheDir, 'no server service with .register found'); return; }
    bootLog(cacheDir, `using server service: ${server.name}`);
    try {
      const disposers = [];
      for (const r of ROUTES) {
        disposers.push(server.svc.register({
        kind: 'exact',
        path: r.path,
        async handler(request, response) {
          try {
            if (!isLoopbackRequest(request)) {
              response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
              response.end('forbidden (loopback only)');
              return;
            }
            const params = parseQuery(request.url ?? '/');
            params.__cacheDir = cacheDir;
            params.__onlineRows = pricerRef.onlineRows;
            params.__config = config || {};
            params.__pricerRef = pricerRef;
            params.__respCache = respCache;
            // 缓存键只用「路径 + 原始查询串」：轻量且天然区分粒度/范围/筛选。
            // （旧实现 JSON.stringify 整个 params，会把 __onlineRows 价目表与 pricer 对象
            //   一起序列化进 key —— 每键几十 KB 且与缓存判等无关。）
            const key = r.path + '?' + String((request.url || '').split('?')[1] || '');
            const data = await cached(key, () => Promise.resolve(r.build(store, params, pricerRef.current)));
            response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
            response.end(JSON.stringify(data));
          } catch (e) {
            try {
              response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
              response.end(String((e && e.message) || e));
            } catch { /* 已响应 */ }
          }
        },
      }));
    }
      ctx.effect && ctx.effect(() => () => {
        for (const d of disposers) { try { d(); } catch { /* ignore */ } }
      }, 'token-tally: web routes');
      bootLog(cacheDir, `routes registered on [${server.name}]: ${ROUTES.map((r) => r.path).join(', ')}`);
    } catch (e) {
      bootLog(cacheDir, `register failed: ${(e && e.stack) || String(e)}`);
    }
    });
  } catch (e) {
    bootLog(cacheDir, `apply failed: ${(e && e.stack) || String(e)}`);
    try { ctx.effect && ctx.effect(() => {}, 'token-tally: failed apply'); } catch { /* ignore */ }
  }
}
