// UI 装配（React 契约层）：createUI(React, api) → { App }
// 构建时与 format/charts/index 合并为单文件 client 产物，import/export 会被剥离
import { esc, fmtInt, fmtTokens, fmtCost, fmtPct, fmtDay, displayModelName, csvCell } from './format.js';
import { stackedBars, trendLines, donut, rankingBars, calendarHeatmap, activityTrend, compareTable } from './charts.js';

const TABS = [
  { key: 'stacks', label: '消耗分布' },
  { key: 'trend', label: '调用趋势' },
  { key: 'dist', label: '调用次数分布' },
  { key: 'rank', label: '调用次数排行' },
  { key: 'compare', label: '模型对比' },
  { key: 'sessions', label: '会话明细' },
];
const RANGES = [
  { key: 'today', label: '今天' },
  { key: '24h', label: '24H' },
  { key: '7d', label: '7D' },
  { key: '30d', label: '30D' },
  { key: '90d', label: '90D' },
  { key: 'all', label: '全部' },
  { key: 'custom', label: '自定义' },
];
// 时间粒度按分钟、小时、天、月划分；旧版自动/周偏好会迁移到当前可见粒度。
const GRANULARITIES = [
  { key: 'minute', label: '分钟' },
  { key: 'hour', label: '时' },
  { key: 'day', label: '天' },
  { key: 'month', label: '月' },
];

function visibleGranularity(value, range) {
  if (value === 'minute' || value === 'hour' || value === 'day' || value === 'month') return value;
  if (value === 'week') return 'day';
  if (range === 'today' || range === '24h') return 'hour';
  if (range === '90d' || range === 'all') return 'month';
  return 'day';
}
// 桶数护栏（与服务端 resolveRange 的 MAX_BUCKETS 同值）：细粒度 × 大范围会爆桶。
const MAX_BUCKETS = 2500;
function spanSecondsOf(range, custom, nowSec) {
  const now = nowSec ?? Math.floor(Date.now() / 1000);
  if (range === 'today' || range === '24h') return 86400;
  if (range === '7d') return 7 * 86400;
  if (range === '30d') return 30 * 86400;
  if (range === '90d') return 90 * 86400;
  if (range === 'all') return Infinity; // 数据跨度未知：分钟不提供，时/天/月交给服务端护栏兜底
  return Math.max(0, (custom.to || now) - (custom.from || 0));
}
function granularityFits(g, spanSec) {
  const step = g === 'minute' ? 60 : g === 'hour' ? 3600 : g === 'day' ? 86400 : 0;
  if (!step) return true;
  if (!isFinite(spanSec)) return g !== 'minute';
  return spanSec / step <= MAX_BUCKETS;
}
const POLL_MS = 30000;
const PREFS_KEY = 'mca.prefs.v1';
function loadPrefs() {
  try {
    const prefs = JSON.parse(localStorage.getItem(PREFS_KEY)) || {};
    // 旧版本把 NUL 分隔符写进 HTML 属性，浏览器会替换成 U+FFFD；载入时修复这类历史脏数据
    if (Array.isArray(prefs.modelKeys)) {
      prefs.modelKeys = prefs.modelKeys
        .map((k) => String(k).replace(/\uFFFD/g, '\u0000'))
        .filter((k) => k && !k.startsWith('\u0000') && !k.endsWith('\u0000'));
    }
    return prefs;
  } catch { return {}; }
}
function savePrefs(p) { try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* ignore */ } }
function normalizeModelKey(key) { return String(key ?? '').replace(/\uFFFD/g, '\u0000'); }
function shortWorkspace(value) {
  const text = String(value || '未标记工作区');
  const parts = text.split(/[\\/]+/).filter(Boolean);
  return parts.length <= 2 ? parts.join('/') : '…/' + parts.slice(-2).join('/');
}

export function createUI(React, api) {
  const h = React.createElement;
  const { useState, useEffect, useRef } = React;

  function App() {
    const tz = useRef(-new Date().getTimezoneOffset() * 60).current;
    const p0 = useRef(null);
    if (p0.current === null) {
      const p = loadPrefs();
      p0.current = {
        range: p.range || '7d',
        granularity: p.granularity || 'auto',
        custom: p.custom || { from: Math.floor(Date.now() / 1000) - 30 * 86400, to: Math.floor(Date.now() / 1000) },
        modelKeys: Array.isArray(p.modelKeys) ? p.modelKeys : [],
        providers: Array.isArray(p.providers) ? p.providers : [],
        tab: TABS.some((t) => t.key === p.tab) ? p.tab : 'stacks',
        metric: p.metric === 'cache' && (p.tab || 'stacks') !== 'trend' ? 'tokens' : (p.metric || 'tokens'),
        percentMode: !!p.percentMode,
      };
    }
    const [range, setRange] = useState(p0.current.range);
    const [granularity, setGranularity] = useState(visibleGranularity(p0.current.granularity, p0.current.range));
    const [custom, setCustom] = useState(p0.current.custom);
    const [modelKeys, setModelKeys] = useState(p0.current.modelKeys);
    const [providers, setProviders] = useState(p0.current.providers);
    const [tab, setTab] = useState(p0.current.tab);
    const [metric, setMetric] = useState(p0.current.metric);
    const [percentMode, setPercentMode] = useState(p0.current.percentMode);
    // null = 跟随最新时间窗口；用户滚轮浏览后保存明确偏移。
    const [chartWindow, setChartWindow] = useState(null);
    const [sort, setSort] = useState({ key: 'cost', dir: 'desc' });
    const [activityMode, setActivityMode] = useState('daily');
    const [rankDimension, setRankDimension] = useState('model');
    const [sessionSearch, setSessionSearch] = useState('');
    const [sessionProvider, setSessionProvider] = useState('');
    const [sessionWorkspace, setSessionWorkspace] = useState('');
    const [sessionSort, setSessionSort] = useState({ key: 'tokens', dir: 'desc' });
    const [showPricing, setShowPricing] = useState(false);
    const [pricing, setPricing] = useState(null);
    const [pricingDraft, setPricingDraft] = useState(null);
    const [pricingStatus, setPricingStatus] = useState('');
    const [pricingSearch, setPricingSearch] = useState('');
    const pricingFileRef = useRef(null);
    const rootRef = useRef(null);
    const pricingDialogRef = useRef(null);
    const pricingCloseRef = useRef(null);
    const [data, setData] = useState(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(false);
    const loadSeq = useRef(0);
    const responses = useRef(new Map());
    // Keep a short, panel-local cache. Pending switches to the same query share
    // their promise; failed requests are always retryable.
    function request(path, query, refresh, keyQuery = query) {
      const cache = responses.current;
      const key = JSON.stringify([path, keyQuery]);
      const hit = cache.get(key);
      if (hit && (hit.pending || (!refresh && Date.now() - hit.at < POLL_MS))) return hit.promise;
      const entry = { pending: true, at: 0 };
      entry.promise = api.call(path, query).then(value => {
        entry.pending = false;
        entry.at = Date.now();
        return value;
      }, err => {
        if (cache.get(key) === entry) cache.delete(key);
        throw err;
      });
      cache.delete(key);
      cache.set(key, entry);
      if (cache.size > 40) cache.delete(cache.keys().next().value);
      return entry.promise;
    }

    const params = { range, granularity, from: custom.from, to: custom.to, tz, modelKeys: modelKeys.length ? modelKeys : null, providers: providers.length ? providers : null };
    const paramsRef = useRef(params);
    const paramsKey = JSON.stringify(params);
    paramsRef.current = params;

    const openPricing = () => {
      setPricingStatus(pricing ? '' : '读取中…');
      setShowPricing(true);
      if (pricing) return;
      api.call('pricing', {}).then((p) => { setPricing(p); setPricingDraft(p); }).catch(() => setPricingStatus('读取失败'));
    };
    const savePricing = () => {
      if (!pricingDraft) return;
      setPricingStatus('保存中…');
      // 默认目录可能包含数千行；保存请求只传手动覆盖，避免把完整目录塞进 URL。
      const payload = { version: 1, currency: pricingDraft.currency || 'CNY', rates: pricingDraft.rates || {}, rows: Array.isArray(pricingDraft.rows) ? pricingDraft.rows : [] };
      api.call('pricing/save', { config: JSON.stringify(payload) }).then((p) => { setPricing(p); setPricingDraft(p); setPricingStatus('已保存'); responses.current.clear(); load(true); }).catch(() => setPricingStatus('保存失败'));
    };
    const importPricingFile = (event) => {
      const file = event.target.files && event.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const text = String(reader.result || '');
          let rows;
          if (/^\s*[\[{]/.test(text)) {
            const value = JSON.parse(text);
            rows = Array.isArray(value) ? value : (Array.isArray(value.rows) ? value.rows : []);
          } else {
            rows = text.split(/\r?\n/).filter((line) => line.trim() && !line.trim().startsWith('#')).map((line) => {
              const c = line.split(',').map((x) => x.trim());
              return { provider: c[0] || '*', model: c[1] || '', currency: c[2] || 'CNY', input: c[3] || '', output: c[4] || '', cacheRead: c[5] || '', cacheWrite: c[6] || '' };
            }).filter((r) => r.model);
          }
          setPricingDraft({ ...(pricingDraft || {}), currency: (pricingDraft && pricingDraft.currency) || 'CNY', rows });
          setPricingStatus('已导入 ' + rows.length + ' 条；请核对 DSH provider/model 后保存');
        } catch { setPricingStatus('导入失败：只支持 JSON 或 CSV'); }
      };
      reader.readAsText(file);
      event.target.value = '';
    };

    const load = (silent) => {
      const seq = ++loadSeq.current;
      if (!silent) setBusy(true);
      const current = paramsRef.current;
      if (!silent) setChartWindow(null);
      const now = Math.floor(Date.now() / 1000);
      const heatParams = { range: 'custom', granularity: 'day', from: now - 12 * 31 * 86400 - 7 * 86400, to: now, tz: current.tz, modelKeys: current.modelKeys, providers: current.providers };
      // 次级汇总页只跟随时间范围和筛选条件，不跟随图表时间粒度。
      const summaryParams = { ...current, granularity: 'day' };
      // 筛选项元数据始终不带模型/供应商筛选，避免勾选后菜单自我锁死。
      const metaParams = { range: current.range, granularity: 'day', from: current.from, to: current.to, tz: current.tz };
      Promise.allSettled([
        request('usage', summaryParams, silent),
        request('stacks', current, silent),
        request('compare', summaryParams, silent),
        request('insights', summaryParams, silent),
        request('sessions', summaryParams, silent),
        request('models', metaParams, silent),
        request('heatmap', heatParams, silent, [current.tz, Math.floor((now + current.tz) / 86400), current.modelKeys, current.providers]),
      ]).then(results => {
        if (seq !== loadSeq.current) return;
        const keys = ['usage', 'stacks', 'compare', 'insights', 'sessions', 'modelsMeta', 'heatmap'];
        const labels = ['总览', '趋势数据', '模型对比', '活跃摘要', '会话明细', '筛选列表', '热力图'];
        const snapshot = {};
        const failures = [];
        results.forEach((result, i) => {
          if (result.status === 'fulfilled') snapshot[keys[i]] = result.value;
          else failures.push(labels[i] + '（' + (result.reason?.message || '请求失败') + '）');
        });
        const { stacks } = snapshot;
        // Never combine panels from different filters. Only reuse last-good
        // values from this same request scope when a background refresh fails.
        const scope = JSON.stringify(current);
        setData(previous => {
          const same = previous?.scope === scope ? previous : null;
          return same || Object.keys(snapshot).length ? { ...same, ...snapshot, scope } : null;
        });
        setError(failures.join('、'));
        setBusy(false);
        // 服务端护栏降档后回写按钮状态（如「全部」范围选了超量的细粒度被降为天），
        // 让选中态与实际渲染一致；收敛后不再触发。
        if (stacks && stacks.granularity && stacks.granularity !== current.granularity) {
          setGranularity(stacks.granularity);
        }
      }).catch(() => {
        if (seq !== loadSeq.current) return;
        setError(true);
        setBusy(false);
      });
    };

    useEffect(() => {
      savePrefs({ range, granularity, custom, modelKeys, providers, tab, metric, percentMode });
    }, [range, granularity, custom, modelKeys, providers, tab, metric, percentMode]);
    useEffect(() => {
      // 粒度与当前范围不匹配（历史偏好中毒 / 自定义范围收窄 / 旧版迁移）时先纠正再加载，
      // 避免带着会被服务端降档的参数白跑一趟。
      if (!granularityFits(granularity, spanSecondsOf(range, custom))) {
        setGranularity(visibleGranularity('auto', range));
        return;
      }
      load(false);
    }, [paramsKey]); // eslint-disable-line react-hooks/exhaustive-deps
    useEffect(() => {
      const t = setInterval(() => { if (document.visibilityState === 'visible') load(true); }, POLL_MS);
      return () => clearInterval(t);
    }, []);
    useEffect(() => {
      if (!showPricing || typeof document === 'undefined') return undefined;
      const previous = document.activeElement;
      const getFocusable = () => {
        const root = pricingDialogRef.current;
        if (!root) return [];
        return [...root.querySelectorAll('button, input, select, [tabindex="0"]')].filter((el) => !el.disabled && !el.hidden);
      };
      (pricingCloseRef.current || pricingDialogRef.current)?.focus?.();
      const onKeyDown = (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          setShowPricing(false);
          return;
        }
        if (e.key !== 'Tab') return;
        const items = getFocusable();
        if (!items.length) return;
        const first = items[0]; const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      };
      document.addEventListener('keydown', onKeyDown);
      return () => {
        document.removeEventListener('keydown', onKeyDown);
        previous?.focus?.();
      };
    }, [showPricing]);
    useEffect(() => {
      const el = rootRef.current;
      if (!el || !el.style || typeof window === 'undefined') return undefined;
      if (tab !== 'compare' && tab !== 'sessions') { el.style.height = ''; return undefined; }
      // 对比页按根节点到视口底部的真实距离占满剩余高度；其他页签保持自然文档流。
      const fit = () => {
        const viewportHeight = (window.visualViewport && window.visualViewport.height) || window.innerHeight;
        const top = el.getBoundingClientRect().top;
        el.style.height = Math.max(320, Math.floor(viewportHeight - top - 16)) + 'px';
      };
      fit();
      const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(fit) : null;
      if (observer && el.parentElement) observer.observe(el.parentElement);
      window.addEventListener('resize', fit);
      if (window.visualViewport) window.visualViewport.addEventListener('resize', fit);
      return () => {
        if (observer) observer.disconnect();
        window.removeEventListener('resize', fit);
        if (window.visualViewport) window.visualViewport.removeEventListener('resize', fit);
        el.style.height = '';
      };
    }, [tab, modelKeys, providers]);

    const toggleModel = (key) => {
      const normalized = normalizeModelKey(key);
      setModelKeys((current) => {
        const keys = current.map(normalizeModelKey);
        return keys.includes(normalized) ? keys.filter((m) => m !== normalized) : keys.concat([normalized]);
      });
    };
    const toggleProvider = (provider) => {
      setProviders((current) => current.includes(provider) ? current.filter((p) => p !== provider) : current.concat([provider]));
    };
    const clearFilters = () => { setModelKeys([]); setProviders([]); };

    const u = data && data.usage;
    const stacks = (data && data.stacks && data.stacks.buckets) || [];
    const chartSize = 24;
    const chartMaxOffset = Math.max(0, stacks.length - chartSize);
    const chartOffset = chartWindow == null ? chartMaxOffset : Math.max(0, Math.min(chartMaxOffset, chartWindow));
    const visibleStacks = stacks.slice(chartOffset, chartOffset + chartSize);
    const onChartWheel = (e) => {
      if (stacks.length <= chartSize) return;
      e.preventDefault();
      const delta = e.deltaY > 0 ? 1 : -1;
      setChartWindow((value) => {
        const base = value == null ? chartMaxOffset : Math.max(0, Math.min(chartMaxOffset, value));
        return Math.max(0, Math.min(chartMaxOffset, base + delta));
      });
    };
    const chartPosition = null; // 技术性时间窗提示已移除，改用可读的区间副标题
    const cmp = (data && data.compare && data.compare.models) || [];
    const dist = (u && u.dist) || [];
    // React retains this clock while polling replaces the SVG inside it. Start a
    // fresh sweep on navigation, a metric change or the first non-empty result.
    const ringClockKey = JSON.stringify([tab, metric, range, custom, modelKeys, providers, dist.length > 0]);
    const anyUnpriced = dist.some((d) => !d.priced);

    const cmpSorted = [...cmp].sort((a, b2) => {
      const k = sort.key; const dirMul = sort.dir === 'desc' ? -1 : 1;
      const va = a[k]; const vb = b2[k];
      const na = va == null ? -1 : va; const nb = vb == null ? -1 : vb;
      if (typeof na === 'string' || typeof nb === 'string') return String(na).localeCompare(String(nb)) * dirMul;
      return (na - nb) * dirMul;
    });

    const currency = (u && u.kpi && u.kpi.currency) || (cmp.find((m) => m.priced && m.currency) || {}).currency || 'CNY';
    const changeRange = (key) => {
      if (key === 'custom' && custom.from > custom.to) {
        const now = Math.floor(Date.now() / 1000);
        setCustom({ from: now - 7 * 86400, to: now });
      }
      setRange(key);
      setGranularity(visibleGranularity('auto', key));
    };
    const chartNav = chartMaxOffset > 0 ? h('div', { className: 'mca-chart-nav', role: 'group', 'aria-label': '时间窗口' },
      h('button', { className: 'mca-pill sm', disabled: chartOffset <= 0, onClick: () => setChartWindow(Math.max(0, chartOffset - 1)), 'aria-label': '较早一个时间桶' }, '←'),
      h('button', { className: 'mca-pill sm', disabled: chartOffset >= chartMaxOffset, onClick: () => setChartWindow(Math.min(chartMaxOffset, chartOffset + 1)), 'aria-label': '较晚一个时间桶' }, '→'),
      h('button', { className: 'mca-pill sm', disabled: chartWindow == null, onClick: () => setChartWindow(null) }, '最新'),
    ) : null;
    const sortBy = (key) => setSort((s) => ({ key, dir: s.key === key && s.dir === 'desc' ? 'asc' : 'desc' }));
    const activateCompareRow = (tr) => {
      if (!tr || !tr.dataset || !tr.dataset.model) return;
      const provider = tr.dataset.provider || '';
      const model = tr.dataset.model;
      // 与图表点击共用即时拼接逻辑；不读取可能被 HTML 规范化为 U+FFFD 的 data-model-key。
      toggleModel(provider ? provider + '\u0000' + model : model);
    };
    const onCompareKeyDown = (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const th = e.target && e.target.closest && e.target.closest('th[data-sort]');
      if (th) { e.preventDefault(); sortBy(th.getAttribute('data-sort')); return; }
      const tr = e.target && e.target.closest && e.target.closest('tr.mca-cmp-row');
      if (tr) { e.preventDefault(); activateCompareRow(tr); }
    };
    const downloadCompare = () => {
      if (typeof document === 'undefined' || typeof URL === 'undefined') return;
      const columns = [
        ['provider', 'Provider'], ['model', 'Model'], ['calls', '调用次数'], ['ok', '成功次数'], ['failed', '失败次数'],
        ['inputTokens', '输入 Tokens'], ['outputTokens', '输出 Tokens'], ['cacheReadTokens', '缓存读 Tokens'], ['cacheWriteTokens', '缓存写 Tokens'],
        ['totalTokens', '总 Tokens'], ['cost', '预估费用'], ['currency', '币种'], ['costPerMillionTokens', '每百万 Token 费用'],
        ['speedTokensPerSec', '输出速度(tok/s)'], ['p50', 'P50(ms)'], ['p95', 'P95(ms)'], ['cacheHitRate', '缓存命中率'], ['cacheCoverage', '缓存遥测覆盖率'],
      ];
      const lines = [columns.map(([, label]) => csvCell(label)).join(',')];
      for (const row of cmpSorted) lines.push(columns.map(([key]) => csvCell(row[key])).join(','));
      const blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'token-tally-compare.csv';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    };

    const downloadSessions = () => {
      if (typeof document === 'undefined' || typeof URL === 'undefined') return;
      const rows = (data && data.sessions && data.sessions.sessions) || [];
      const columns = [
        ['sessionId', 'Session ID'], ['workspace', '工作区'], ['providers', '供应商'],
        ['requests', '请求数'], ['totalTokens', 'Tokens'], ['cacheHitRate', '缓存命中率'],
        ['cost', '预估费用'], ['currency', '币种'], ['lastActive', '最近活跃桶'],
      ];
      const lines = [columns.map(([, label]) => csvCell(label)).join(',')];
      for (const row of rows) {
        lines.push(columns.map(([key]) => {
          if (key === 'providers') return csvCell((row.providers || []).join(' / '));
          if (key === 'totalTokens') return csvCell(row.tokens);
          return csvCell(row[key]);
        }).join(','));
      }
      const blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'token-tally-sessions.csv';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    };

    const rangeLabel = (() => {
      if (!visibleStacks.length) return null;
      const first = visibleStacks[0]; const last = visibleStacks[visibleStacks.length - 1];
      const f = fmtDay(first.start, first.gran || 'day', tz);
      const l = fmtDay(last.start, last.gran || 'day', tz);
      return f === l ? f : f + ' – ' + l;
    })();

    // 图表点击筛选：柱子/扇区分别携带 data-provider 与 data-model，点击后拼成 provider+model 筛选键
    const onChartPick = (e) => {
      const el = e.target && e.target.closest && e.target.closest('[data-model]');
      if (!el) return;
      const provider = el.getAttribute('data-provider') || '';
      const model = el.getAttribute('data-model') || '';
      if (!model) return;
      toggleModel(provider ? provider + '\u0000' + model : model);
    };

    // 已选筛选 chip（可单个移除），比「清除」更直观
    const chips = [];
    for (const key of modelKeys) {
      const sep = key.indexOf('\u0000');
      const provider = sep >= 0 ? key.slice(0, sep) : '';
      const model = sep >= 0 ? key.slice(sep + 1) : key;
      chips.push(h('span', { key, className: 'mca-chip' },
        h('span', { className: 'mca-chip-text', title: provider ? provider + '/' + model : model }, displayModelName(model)),
        h('button', { className: 'mca-chip-x', onClick: () => toggleModel(key), 'aria-label': '移除筛选 ' + model }, '×'),
      ));
    }
    for (const provider of providers) {
      chips.push(h('span', { key: 'p:' + provider, className: 'mca-chip' },
        h('span', { className: 'mca-chip-text', title: provider }, provider),
        h('button', { className: 'mca-chip-x', onClick: () => toggleProvider(provider), 'aria-label': '移除筛选 ' + provider }, '×'),
      ));
    }

    // 粒度只作用于时序图（消耗分布/调用趋势）；分布/排行/对比是范围级汇总，显示按钮反而像"点了没反应"。
    const granularitiesVisible = tab === 'stacks' || tab === 'trend';
    const granChoices = GRANULARITIES.filter((g) => granularityFits(g.key, spanSecondsOf(range, custom)));
    const filterBar = h('div', { className: 'mca-filters' },
      h('div', { className: 'mca-toolbar-main' },
        h('div', { className: 'mca-seg' }, RANGES.map((r) => h('button', {
          key: r.key, className: 'mca-seg-btn' + (range === r.key ? ' on' : ''),
          onClick: () => changeRange(r.key),
        }, r.label))),
        granularitiesVisible ? h('div', { className: 'mca-seg mca-seg-sm' }, granChoices.map((g) => h('button', {
          key: g.key, className: 'mca-seg-btn' + (granularity === g.key ? ' on' : ''),
          title: '按' + g.label + '聚合',
          onClick: () => setGranularity(g.key),
        }, g.label))) : null,
        range === 'custom' ? h('span', { className: 'mca-custom' },
          h('input', {
            type: 'date', value: localDateStr(custom.from), 'aria-label': '开始日期', onChange: (e) => {
              if (!e.target.value) return;
              const from = localTs(e.target.value, false, tz);
              setCustom({ from, to: Math.max(custom.to, from + 86399) });
            },
          }),
          h('span', { className: 'mca-sep' }, '→'),
          h('input', {
            type: 'date', value: localDateStr(custom.to), 'aria-label': '结束日期', onChange: (e) => {
              if (!e.target.value) return;
              const to = localTs(e.target.value, true, tz);
              setCustom({ from: Math.min(custom.from, to - 86399), to });
            },
          }),
        ) : null,
        h('details', { className: 'mca-drop' },
          h('summary', { className: 'mca-drop-btn' }, '筛选', (modelKeys.length + providers.length) ? h('span', { className: 'mca-count' }, String(modelKeys.length + providers.length)) : null),
          h('div', { className: 'mca-menu' },
            (data && data.modelsMeta && data.modelsMeta.models || []).map((g) => h('div', { key: g.provider, className: 'mca-vendor' },
              h('label', { className: 'mca-vendor-name mca-menu-item' },
                h('input', { type: 'checkbox', checked: providers.includes(g.provider), onChange: () => toggleProvider(g.provider), 'aria-label': '筛选供应商 ' + g.provider }),
                h('span', null, g.provider),
              ),
              g.models.map((m) => {
                const key = g.provider + '\u0000' + m;
                return h('label', { key, className: 'mca-menu-item mca-model-item' },
                  h('input', { type: 'checkbox', checked: modelKeys.includes(key), onChange: () => toggleModel(key) }),
                  h('span', null, displayModelName(m)),
                );
              }),
            )),
            (data && data.modelsMeta && data.modelsMeta.models || []).length === 0 ? h('div', { className: 'mca-empty' }, busy ? '加载中…' : '当前范围暂无模型') : null,
          ),
        ),
        chips.length ? h('button', { className: 'mca-clear', onClick: clearFilters }, '清除') : null,
      ),
      h('div', { className: 'mca-toolbar-side' },
        busy ? h('span', { className: 'mca-busy', role: 'status' }, '统计中') : null,
        error ? h('span', { className: 'mca-err', role: 'alert' }, '加载失败 ' + (typeof error === 'string' ? error : '') + ' ', h('button', { className: 'mca-retry', onClick: () => load(false) }, '重试')) : null,
        h('button', { className: 'mca-settings-btn', onClick: openPricing, title: '管理模型价格' }, '费用设置'),
      ),
    );

    const chipRow = chips.length ? h('div', { className: 'mca-chips' }, chips) : null;

    const kpi = u ? h('div', { className: 'mca-kpis' },
      kpiCard('预估费用', u.kpi.cost == null ? '未配置' : fmtCost(u.kpi.cost, u.kpi.currency || currency), u.kpi.costPriced ? '' : 'mca-dim', anyUnpriced ? '部分模型未配置价格' : null),
      kpiCard('计费 Tokens', fmtTokens(u.kpi.totalTokens)),
      kpiCard('输入 Tokens', fmtTokens(u.kpi.inputTokens)),
      kpiCard('输出 Tokens', fmtTokens(u.kpi.outputTokens)),
      kpiCard('缓存 Tokens', fmtTokens((u.kpi.cacheReadTokens || 0) + (u.kpi.cacheWriteTokens || 0)), '', '读 ' + fmtTokens(u.kpi.cacheReadTokens) + ' · 写 ' + fmtTokens(u.kpi.cacheWriteTokens)),
      kpiCard('缓存命中率', fmtPct(u.kpi.cacheHitRate), '', u.kpi.cacheCoverage != null ? '遥测覆盖 ' + fmtPct(u.kpi.cacheCoverage) : null),
      kpiCard('用量请求', fmtInt(u.kpi.requests)),
      kpiCard('会话数', fmtInt(u.kpi.sessions ?? 0)),
    ) : (error ? h('div', { className: 'mca-kpis mca-kpis-placeholder' }, h('div', { className: 'mca-empty' }, '数据加载失败')) : h('div', { className: 'mca-kpis' }, [0, 1, 2, 3, 4].map((i) => h('div', { key: i, className: 'mca-kpi mca-kpi-skeleton' },
      h('div', { className: 'mca-skeleton mca-skeleton-label' }),
      h('div', { className: 'mca-skeleton mca-skeleton-value' }),
    ))));

    const tabNav = h('div', { className: 'mca-tabs', role: 'tablist' }, TABS.map((t) => h('button', {
      key: t.key, role: 'tab', 'aria-selected': tab === t.key,
      className: 'mca-tab' + (tab === t.key ? ' on' : ''), onClick: () => { setTab(t.key); if (t.key !== 'trend' && metric === 'cache') setMetric('tokens'); },
    }, t.label)));

    // 口径切换做成一个分段控件，视觉上与筛选栏区分
    const metricPills = (k) => {
      const choices = [['tokens', 'Token'], ['cost', '费用'], ['count', '次数']];
      if (k === 'trend') choices.push(['cache', '缓存']);
      return h('div', { className: 'mca-seg mca-seg-sm' }, choices.map(([key, label]) => h('button', {
        key, className: 'mca-seg-btn' + (metric === key ? ' on' : ''), onClick: () => { setMetric(key); if (k) setTab(k); },
      }, label)));
    };

    let body = null;
    if (error && !data) {
      body = h('div', { className: 'mca-card mca-error-state', role: 'alert' },
        h('div', { className: 'mca-empty' }, '台账数据加载失败，请检查本地服务后重试。'),
        h('button', { className: 'mca-pill on', onClick: () => load(false) }, '重新加载'),
      );
    } else if (tab === 'stacks') {
      // newapi 式：堆叠柱 + 环形占比并排，占比一目了然
      body = h('div', { className: 'mca-card' },
        h('div', { className: 'mca-card-head' },
          h('div', { className: 'mca-card-title-wrap' },
            h('span', { className: 'mca-card-title' }, '模型消耗分布'),
            rangeLabel ? h('span', { className: 'mca-card-sub' }, rangeLabel) : null,
          ),
          h('div', { className: 'mca-card-tools' },
            chartNav,
            h('button', { className: 'mca-pill sm' + (percentMode ? ' on' : ''), onClick: () => setPercentMode(!percentMode), 'aria-pressed': percentMode, title: '绝对值 / 100% 占比切换' }, '占比'),
            metricPills(null),
          ),
        ),
        h('div', { className: 'mca-split' },
          h('div', { className: 'mca-unsafe mca-split-main mca-chart-wrap', onWheel: onChartWheel, onClick: onChartPick, dangerouslySetInnerHTML: { __html: stackedBars(visibleStacks, { metric, tz, percentMode, currency }) } }),
          // 消耗分布页与堆叠柱并排：用紧凑环（不画引线标签与长图例，颜色与柱图图例一致）。
          h('div', { key: ringClockKey, className: 'mca-donut-grow mca-split-side mca-unsafe', style: { '--progress': 1 }, onClick: onChartPick, dangerouslySetInnerHTML: { __html: donut(dist, { metric, currency, compact: true, externalClock: true }) } }),
        ),
      );
    } else if (tab === 'trend') {
      body = h('div', { className: 'mca-card' },
        h('div', { className: 'mca-card-head' },
          h('div', { className: 'mca-card-title-wrap' },
            h('span', { className: 'mca-card-title' }, '调用趋势'),
            rangeLabel ? h('span', { className: 'mca-card-sub' }, rangeLabel + (metric === 'cache' ? ' · 折线含插值，圆点为实测' : '')) : null,
          ),
          h('div', { className: 'mca-card-tools' }, chartNav, metricPills('trend')),
        ),
        h('div', { className: 'mca-unsafe mca-chart-wrap', onWheel: onChartWheel, dangerouslySetInnerHTML: { __html: trendLines(visibleStacks, { tz, metric, currency }) } }),
      );
    } else if (tab === 'dist') {
      body = h('div', { className: 'mca-card' },
        h('div', { className: 'mca-card-head' },
          h('div', { className: 'mca-card-title-wrap' },
            h('span', { className: 'mca-card-title' }, '模型调用次数占比'),
            h('span', { className: 'mca-card-sub' }, '点击扇区可筛选'),
          ),
          h('div', { className: 'mca-card-tools' }, metricPills(null)),
        ),
        h('div', { key: ringClockKey, className: 'mca-donut-grow mca-unsafe', style: { '--progress': 1 }, onClick: onChartPick, dangerouslySetInnerHTML: { __html: donut(dist, { metric, currency, externalClock: true }) } }),
      );
    } else if (tab === 'rank') {
      // 排行统一承载模型 / 供应商 / 项目三个维度，不再额外开一张供应商/项目表。
      const ranked = rankDimension === 'provider'
        ? ((data && data.insights && data.insights.providers) || []).map((p) => ({
          provider: '', model: p.provider, calls: p.calls, totalTokens: p.tokens,
          cost: p.cost, priced: p.costPriced, currency: p.currency,
        }))
        : rankDimension === 'project'
          ? ((data && data.sessions && data.sessions.projects) || []).map((p) => ({
            provider: '', model: p.workspace, displayName: shortWorkspace(p.workspace), fullName: p.workspace,
            calls: p.requests, totalTokens: p.tokens, cost: p.cost, priced: p.costPriced, currency: p.currency,
          }))
          : cmp.filter((m) => !(m.provider === 'internal' || m.model === '(compaction)'));
      const dimensionTitle = rankDimension === 'provider' ? '供应商调用排行' : rankDimension === 'project' ? '项目调用排行' : '模型调用排行';
      const dimensionSub = rankDimension === 'provider' ? '按供应商合并全部模型'
        : rankDimension === 'project' ? '按会话工作区汇总'
          : '总计 ' + fmtInt(ranked.reduce((s, m) => s + (m.calls || 0), 0)) + ' 次请求';
      body = h('div', { className: 'mca-card' },
        h('div', { className: 'mca-card-head' },
          h('div', { className: 'mca-card-title-wrap' },
            h('span', { className: 'mca-card-title' }, dimensionTitle),
            h('span', { className: 'mca-card-sub' }, dimensionSub),
          ),
          h('div', { className: 'mca-card-tools' },
            h('div', { className: 'mca-seg mca-seg-sm' }, [['model', '模型'], ['provider', '供应商'], ['project', '项目']].map(([key, label]) => h('button', {
              key, className: 'mca-seg-btn' + (rankDimension === key ? ' on' : ''), onClick: () => setRankDimension(key), 'aria-pressed': rankDimension === key,
            }, label))),
            metricPills(null),
          ),
        ),
        h('div', { className: 'mca-unsafe', onClick: rankDimension === 'model' ? onChartPick : undefined, dangerouslySetInnerHTML: { __html: rankingBars(ranked, { metric, currency }) } }),
      );
    } else if (tab === 'sessions') {
      const info = data && data.sessions;
      const rows = (info && info.sessions) || [];
      const providerOptions = [...new Set(rows.flatMap((r) => r.providers || []))].sort((a, b) => a.localeCompare(b));
      const workspaceOptions = [...new Set(rows.map((r) => r.workspace || '未标记工作区'))].sort((a, b) => a.localeCompare(b));
      const needle = sessionSearch.trim().toLowerCase();
      const filtered = rows.filter((r) => {
        if (sessionProvider && !(r.providers || []).includes(sessionProvider)) return false;
        if (sessionWorkspace && (r.workspace || '未标记工作区') !== sessionWorkspace) return false;
        return !needle || String(r.sessionId).toLowerCase().includes(needle) || String(r.workspace || '').toLowerCase().includes(needle) || (r.providers || []).join(' ').toLowerCase().includes(needle);
      });
      const sortSessionsBy = (key) => setSessionSort((current) => ({ key, dir: current.key === key && current.dir === 'desc' ? 'asc' : 'desc' }));
      const valueOf = (r, key) => {
        if (key === 'sessionId' || key === 'workspace') return String(r[key] || '未标记工作区');
        if (key === 'providers') return (r.providers || []).join(' / ');
        if (key === 'cost') return r.costPriced ? r.cost : -1;
        if (key === 'lastActive') return r.lastActive == null ? -1 : r.lastActive;
        if (key === 'cacheHitRate') return r.cacheHitRate == null ? -1 : r.cacheHitRate;
        return Number(r[key] || 0);
      };
      const visible = [...filtered].sort((a, b) => {
        const va = valueOf(a, sessionSort.key); const vb = valueOf(b, sessionSort.key);
        const dir = sessionSort.dir === 'desc' ? -1 : 1;
        if (typeof va === 'string' || typeof vb === 'string') return String(va).localeCompare(String(vb)) * dir;
        return (va - vb) * dir;
      });
      const headers = [
        ['sessionId', '会话', false], ['workspace', '工作区', false], ['providers', '供应商', false],
        ['requests', '请求', true], ['tokens', 'Tokens', true], ['cacheHitRate', '缓存命中', true],
        ['cost', '预估费用', true], ['lastActive', '最近活跃', true],
      ];
      const sessionTh = (key, label, numeric) => h('th', {
        key, className: numeric ? 'num' : '', role: 'button', tabIndex: 0,
        'aria-sort': sessionSort.key === key ? (sessionSort.dir === 'desc' ? 'descending' : 'ascending') : 'none',
        onClick: () => sortSessionsBy(key),
        onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); sortSessionsBy(key); } },
      }, label + (sessionSort.key === key ? (sessionSort.dir === 'desc' ? ' ↓' : ' ↑') : ''));
      body = h('div', { className: 'mca-card' },
        h('div', { className: 'mca-card-head' },
          h('div', { className: 'mca-card-title-wrap' },
            h('span', { className: 'mca-card-title' }, '会话明细'),
            h('span', { className: 'mca-card-sub' }, fmtInt((info && info.total) || 0) + ' 个独立会话；主会话与子会话按各自日志逐行'),
          ),
          h('div', { className: 'mca-session-tools' },
            h('select', { className: 'mca-session-select', value: sessionProvider, onChange: (e) => setSessionProvider(e.target.value), 'aria-label': '筛选供应商' },
              h('option', { value: '' }, '全部供应商'), providerOptions.map((p) => h('option', { key: p, value: p }, p))),
            h('select', { className: 'mca-session-select', value: sessionWorkspace, onChange: (e) => setSessionWorkspace(e.target.value), 'aria-label': '筛选工作区' },
              h('option', { value: '' }, '全部工作区'), workspaceOptions.map((w) => h('option', { key: w, value: w }, w))),
            h('input', { className: 'mca-session-search', value: sessionSearch, onChange: (e) => setSessionSearch(e.target.value), placeholder: '搜索会话 / 工作区 / 供应商', 'aria-label': '搜索会话' }),
            h('button', { className: 'mca-pill sm', onClick: downloadSessions, disabled: !rows.length }, '导出 CSV'),
          ),
        ),
        h('div', { className: 'mca-insight-note' }, '显示 ' + fmtInt(visible.length) + ' / ' + fmtInt(rows.length) + ' 个会话 · 全部可滚动查看'),
        visible.length ? h('div', { className: 'mca-session-scroll' }, h('div', { className: 'mca-table-wrap' }, h('table', { className: 'mca-table' },
          h('thead', null, h('tr', null, headers.map(([key, label, numeric]) => sessionTh(key, label, numeric)))),
          h('tbody', null, visible.map((r) => h('tr', { key: r.sessionId, className: 'mca-session-row', 'data-session-id': r.sessionId },
            h('td', { className: 'mca-session-id', title: r.sessionId }, String(r.sessionId).slice(0, 8)),
            h('td', { title: r.workspace || '未标记工作区' }, h('span', { className: 'mca-ellipsis' }, r.workspace || '未标记')),
            h('td', null, h('span', { className: 'mca-ellipsis', title: (r.providers || []).join(' / ') }, (r.providers || []).join(' / ') || '—')),
            h('td', { className: 'num', title: '失败 ' + fmtInt(r.failCount || 0) }, fmtInt(r.requests)),
            h('td', { className: 'num', title: fmtInt(r.tokens) }, fmtTokens(r.tokens)),
            h('td', { className: 'num' }, fmtPct(r.cacheHitRate)),
            h('td', { className: 'num' }, r.costPriced ? fmtCost(r.cost, r.currency || currency) : '未配置'),
            h('td', { className: 'num' }, r.lastActive == null ? '—' : fmtDay(r.lastActive, 'hour', tz)),
          ))),
        ))) : h('div', { className: 'mca-empty' }, rows.length ? '没有匹配当前筛选的会话' : '当前范围暂无会话数据'),
      );
    } else {
      body = h('div', { className: 'mca-card' },
        h('div', { className: 'mca-card-head' },
          h('div', { className: 'mca-card-title-wrap' },
            h('span', { className: 'mca-card-title' }, '模型对比'),
            h('span', { className: 'mca-card-sub' }, modelKeys.length ? '已筛选 ' + modelKeys.length + ' 个模型' : '点击行可筛选全看板'),
          ),
          h('div', { className: 'mca-card-tools' },
            h('button', { className: 'mca-pill sm', onClick: downloadCompare, disabled: !cmpSorted.length }, '导出 CSV'),
          ),
        ),
        h('div', {
          className: 'mca-unsafe mca-compare-scroll',
          onClick: (e) => {
            const th = e.target && e.target.closest && e.target.closest('th[data-sort]');
            if (th) { sortBy(th.getAttribute('data-sort')); return; }
            const tr = e.target && e.target.closest && e.target.closest('tr.mca-cmp-row');
            activateCompareRow(tr);
          },
          onKeyDown: onCompareKeyDown,
          dangerouslySetInnerHTML: { __html: compareTable(cmpSorted, { sortKey: sort.key, sortDir: sort.dir, currency }) },
        }),
      );
    }

    const heat = data && data.heatmap;
    const insightCards = (data && data.insights && data.insights.cards) || {};
    const peak = insightCards.peakDay;
    const streak = insightCards.streak || {};
    const week = insightCards.week || {};
    const summary = [
      streak.current > 0 ? '连续活跃 ' + fmtInt(streak.current) + ' 天' : null,
      peak ? '最高单日 ' + fmtTokens(peak.tokens) + '（' + fmtDay(peak.day, 'day', tz) + '）' : null,
      week.delta != null ? '近 7 日 ' + (week.delta >= 0 ? '+' : '') + (week.delta * 100).toFixed(1) + '%' : null,
    ].filter(Boolean).join(' · ');
    // 活动视图只在「消耗分布」出现，日/周/累计共享同一组数据，不再重复开独立洞察页。
    const heatCard = tab === 'stacks' ? h('div', { className: 'mca-card' },
      h('div', { className: 'mca-card-head' },
        h('div', { className: 'mca-card-title-wrap' },
          h('span', { className: 'mca-card-title' }, '用量活动'),
          h('span', { className: 'mca-card-sub' }, summary || '最近 12 个月'),
        ),
        h('div', { className: 'mca-seg mca-seg-sm' }, [['daily', '日'], ['week', '周'], ['cumulative', '累计']].map(([key, label]) => h('button', {
          key, className: 'mca-seg-btn' + (activityMode === key ? ' on' : ''), onClick: () => setActivityMode(key), 'aria-pressed': activityMode === key,
        }, label))),
      ),
      heat ? h('div', { className: 'mca-unsafe mca-heat-wrap', dangerouslySetInnerHTML: { __html: activityMode === 'daily'
        ? calendarHeatmap(heat.days, { tz, now: Math.floor(Date.now() / 1000) })
        : activityTrend(heat.days, { mode: activityMode, tz, now: Math.floor(Date.now() / 1000) }) } })
        : h('div', { className: 'mca-empty' }, error ? '暂时无法加载，请点击上方“重试”' : '加载中…'),
    ) : null;

    return h('div', { ref: rootRef, className: 'mca-root' + (tab === 'compare' || tab === 'sessions' ? ' mca-compare-page' : '') },
      filterBar,
      chipRow,
      kpi,
      tabNav,
      h('div', { key: tab, className: 'mca-body' }, body),
      heatCard,
      showPricing ? pricingDialog(h, {
        pricing, pricingDraft, pricingStatus, pricingSearch, pricingFileRef, pricingDialogRef, pricingCloseRef,
        setPricingDraft, setPricingSearch, setShowPricing, savePricing, importPricingFile,
      }) : null,
    );
  }

  function pricingDialog(h, scope) {
    const {
      pricing, pricingDraft, pricingStatus, pricingSearch, pricingFileRef, pricingDialogRef, pricingCloseRef,
      setPricingDraft, setPricingSearch, setShowPricing, savePricing, importPricingFile,
    } = scope;
    const draft = pricingDraft || { currency: 'CNY', rows: [], defaults: [] };
    const rows = Array.isArray(draft.rows) ? draft.rows : [];
    const defaults = Array.isArray(draft.defaults) ? draft.defaults : [];
    const needle = pricingSearch.trim().toLowerCase();
    const visibleRows = rows.filter((r) => !needle || String(r.provider || '').toLowerCase().includes(needle) || String(r.model || '').toLowerCase().includes(needle));
    const updateRow = (i, key, value) => setPricingDraft({ ...draft, rows: rows.map((r, n) => n === i ? { ...r, [key]: value } : r) });
    return h('div', { className: 'mca-modal-backdrop', onClick: (e) => { if (e.target === e.currentTarget) setShowPricing(false); } },
      h('div', { className: 'mca-price-modal', role: 'dialog', 'aria-modal': true, 'aria-label': '费用设置', ref: pricingDialogRef, tabIndex: -1 },
        h('div', { className: 'mca-price-head' }, h('div', null, h('div', { className: 'mca-price-title' }, '费用设置'), h('div', { className: 'mca-price-sub' }, '按 DSH 的 provider / model 记录价格，单位：每百万 token')), h('button', { className: 'mca-icon-btn', onClick: () => setShowPricing(false), 'aria-label': '关闭', ref: pricingCloseRef }, '×')),
        h('div', { className: 'mca-price-note' }, '内置价格与在线目录作为默认值；手动覆盖只作用于完全匹配的 provider + model。不同平台的 ID 可在导入时映射后保存。价格单位为每百万 token，缓存读写单价可留空。默认目录共 ' + defaults.length + ' 条；DSH 记录的 provider/model 不会被自动猜测改名。'),
        h('div', { className: 'mca-price-toolbar' }, h('label', null, '币种 ', h('select', { value: draft.currency || 'CNY', onChange: (e) => setPricingDraft({ ...draft, currency: e.target.value }) }, h('option', { value: 'CNY' }, 'CNY · 人民币'), h('option', { value: 'USD' }, 'USD · 美元'))), h('input', { className: 'mca-price-search', value: pricingSearch, onChange: (e) => setPricingSearch(e.target.value), placeholder: '搜索 provider / model' }), h('button', { className: 'mca-pill sm', onClick: () => setPricingDraft({ ...draft, rows: rows.concat([{ provider: '*', model: '', currency: draft.currency || 'CNY', input: '', output: '', cacheRead: '', cacheWrite: '' }]) }) }, '添加模型'), h('button', { className: 'mca-pill sm', onClick: () => pricingFileRef.current && pricingFileRef.current.click() }, '导入'), h('input', { ref: pricingFileRef, type: 'file', accept: '.csv,.json,text/csv,application/json', hidden: true, onChange: importPricingFile })), 
        h('div', { className: 'mca-price-help' }, '导入建议：先把 provider 与 model 映射成 DSH 实际记录值，再填写四档价格。CSV 列顺序：provider,model,currency,input,output,cacheRead,cacheWrite。'),
        h('div', { className: 'mca-price-table-wrap' }, h('table', { className: 'mca-price-table' }, h('thead', null, h('tr', null, ['Provider', 'Model ID（DSH）', '输入 / M', '输出 / M', '缓存读 / M', '缓存写 / M', ''].map((x) => h('th', { key: x }, x)))), h('tbody', null, visibleRows.map((r, i) => h('tr', { key: rows.indexOf(r) }, h('td', null, h('input', { value: r.provider || '*', onChange: (e) => updateRow(rows.indexOf(r), 'provider', e.target.value) })), h('td', null, h('input', { value: r.model || '', onChange: (e) => updateRow(rows.indexOf(r), 'model', e.target.value), placeholder: '如 gpt-6-astra' })), ...['input', 'output', 'cacheRead', 'cacheWrite'].map((key) => h('td', { key }, h('input', { type: 'number', min: '0', step: 'any', value: r[key] == null ? '' : r[key], onChange: (e) => updateRow(rows.indexOf(r), key, e.target.value) }))), h('td', null, h('button', { className: 'mca-remove-btn', onClick: () => { const index = rows.indexOf(r); setPricingDraft({ ...draft, rows: rows.filter((_, n) => n !== index) }); } }, '删除'))))), rows.length ? null : h('tr', null, h('td', { colSpan: 7, className: 'mca-empty' }, '暂无手动覆盖；你可以添加 provider / model 价格')))),
        h('div', { className: 'mca-price-foot' }, h('span', { className: 'mca-price-status', role: 'status' }, pricingStatus || (pricing && pricing.source === 'builtin+online' ? '默认价格已加载' : '')), h('button', { className: 'mca-pill', onClick: () => setShowPricing(false) }, '取消'), h('button', { className: 'mca-pill on', onClick: savePricing, disabled: !pricingDraft }, '保存价格')),
      ),
    );
  }

  function kpiCard(label, value, cls, sub) {
    return h('div', { className: 'mca-kpi' + (cls ? ' ' + cls : '') },
      h('div', { className: 'mca-kpi-label' }, label),
      h('div', { className: 'mca-kpi-value' }, String(value)),
      sub ? h('div', { className: 'mca-kpi-sub' }, sub) : null,
    );
  }

  function localDateStr(ts) {
    const d = new Date((ts + tzOff()) * 1000);
    return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
  }
  function localTs(str, endOfDay) {
    const t = Math.floor(new Date(str + 'T00:00:00').getTime() / 1000);
    return endOfDay ? t + 86399 : t;
  }
  function tzOff() { return -new Date().getTimezoneOffset() * 60; }

  return { App, pricingDialog };
}
