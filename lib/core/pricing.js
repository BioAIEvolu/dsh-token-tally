// 模型 id 归一 + 价目表 + 费用估算（纯函数，无 I/O、无第三方依赖）
// 口径：单价为「每百万 token」；缓存命中/未命中/写入/输出四档分开计价；
// 未匹配价目的模型一律 priced:false，由 UI 显示「未配置价格」，绝不计 0。

export function normalizeModelId(raw) {
  if (typeof raw !== 'string' || !raw) return '';
  let id = raw.trim().toLowerCase();
  const slash = id.lastIndexOf('/');
  if (slash >= 0) id = id.slice(slash + 1); // z-ai/glm-5.3 → glm-5.3
  id = id.replace(/^(global|cn):/, '');
  id = id.replace(/:batch$/, '');
  const marketSuffixes = ['-sg', '-eu', '-us', '-jp'];
  for (const s of marketSuffixes) {
    if (id.endsWith(s)) { id = id.slice(0, -s.length); break; }
  }
  // 日期后缀：-YYYYMMDD、-MMDD、-YYYY-MM-DD（最多剥两轮，deepseek-v4-flash-0731 → deepseek-v4-flash）
  for (let i = 0; i < 2; i++) {
    const m = id.match(/-(?:\d{8}|\d{4}|\d{4}-\d{2}-\d{2})$/);
    if (!m) break;
    id = id.slice(0, -m[0].length);
  }
  return id;
}

/** 解析价目 CSV：provider,model,currency,input,output,cacheRead,cacheWrite（单价/百万 token） */
export function parsePricingCsv(text) {
  const rows = [];
  const lines = String(text ?? '').split(/\r?\n/);
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const cols = t.split(',').map((c) => c.trim());
    if (cols.length < 7) continue;
    const [provider, model, currency, input, output, cacheRead, cacheWrite] = cols;
    if (!model) continue;
    const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : null);
    rows.push({
      provider: provider || '*',
      modelId: normalizeModelId(model),
      currency: currency || 'CNY',
      perMillion: { input: num(input), output: num(output), cacheRead: num(cacheRead), cacheWrite: num(cacheWrite) },
    });
  }
  return rows;
}

const DEFAULT_RATES = { CNY: 1, USD: 7.2 }; // rates[from] = 1 单位外币兑多少目标币（target 默认 CNY）；可在配置覆盖

// 别名表（口径对齐 model-usage-plugin，MIT）：已下线旧 id 由现型号服务并按现价计费；
// 可通过 opts.aliases 追加，禁止前缀正则匹配（防误计价）
const DEFAULT_ALIASES = {
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-v4.1-flash': 'deepseek-flash',
  'ox-alpha': 'glm-5.3-flash',
};

// 内置兜底价（官方公开价，USD/百万 token；在线 LiteLLM 表拉取失败时用）
// 常见模型覆盖：DeepSeek / OpenAI / Anthropic / Google / GLM / Kimi
const BUILTIN_PRICES = [
  { provider: 'deepseek', modelId: 'deepseek-chat', currency: 'USD', perMillion: { input: 0.27, output: 1.10, cacheRead: 0.07, cacheWrite: 0.28 } },
  { provider: 'deepseek', modelId: 'deepseek-reasoner', currency: 'USD', perMillion: { input: 0.55, output: 2.19, cacheRead: 0.14, cacheWrite: 0.28 } },
  { provider: 'deepseek', modelId: 'deepseek-flash', currency: 'USD', perMillion: { input: 0.14, output: 0.55, cacheRead: 0.035, cacheWrite: 0.14 } },
  { provider: 'openai', modelId: 'gpt-4o', currency: 'USD', perMillion: { input: 2.50, output: 10.00, cacheRead: 1.25, cacheWrite: null } },
  { provider: 'openai', modelId: 'gpt-4o-mini', currency: 'USD', perMillion: { input: 0.15, output: 0.60, cacheRead: 0.075, cacheWrite: null } },
  { provider: 'openai', modelId: 'gpt-4.1', currency: 'USD', perMillion: { input: 2.00, output: 8.00, cacheRead: 0.50, cacheWrite: null } },
  { provider: 'openai', modelId: 'gpt-4.1-mini', currency: 'USD', perMillion: { input: 0.40, output: 1.60, cacheRead: 0.10, cacheWrite: null } },
  { provider: 'openai', modelId: 'o3', currency: 'USD', perMillion: { input: 2.00, output: 8.00, cacheRead: 0.50, cacheWrite: null } },
  { provider: 'openai', modelId: 'o4-mini', currency: 'USD', perMillion: { input: 1.10, output: 4.40, cacheRead: 0.275, cacheWrite: null } },
  { provider: 'anthropic', modelId: 'claude-sonnet-4-5', currency: 'USD', perMillion: { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75 } },
  { provider: 'anthropic', modelId: 'claude-opus-4-1', currency: 'USD', perMillion: { input: 15.00, output: 75.00, cacheRead: 1.50, cacheWrite: 18.75 } },
  { provider: 'anthropic', modelId: 'claude-haiku-4-5', currency: 'USD', perMillion: { input: 1.00, output: 5.00, cacheRead: 0.10, cacheWrite: 1.25 } },
  { provider: 'google', modelId: 'gemini-2.5-pro', currency: 'USD', perMillion: { input: 1.25, output: 10.00, cacheRead: 0.125, cacheWrite: null } },
  { provider: 'google', modelId: 'gemini-2.5-flash', currency: 'USD', perMillion: { input: 0.30, output: 2.50, cacheRead: 0.03, cacheWrite: null } },
  { provider: 'google', modelId: 'gemini-2.0-flash', currency: 'USD', perMillion: { input: 0.10, output: 0.40, cacheRead: 0.01, cacheWrite: null } },
  { provider: 'z-ai', modelId: 'glm-4.5', currency: 'USD', perMillion: { input: 0.60, output: 1.80, cacheRead: 0.15, cacheWrite: null } },
  { provider: 'z-ai', modelId: 'glm-4.5-flash', currency: 'USD', perMillion: { input: 0.0, output: 0.0, cacheRead: 0.0, cacheWrite: null } }, // 免费
  { provider: 'moonshot', modelId: 'kimi-k2', currency: 'USD', perMillion: { input: 0.60, output: 2.50, cacheRead: 0.15, cacheWrite: null } },
];

export function builtinPrices() {
  return BUILTIN_PRICES.map((r) => ({ ...r, perMillion: { ...r.perMillion } }));
}

/**
 * 合并价目表：overrideRows（用户 CSV）> onlineRows（LiteLLM）> builtinRows（内置兜底）
 * 同名同 provider 时排前者胜；override 里 provider:'*' 的通用价也对 online/builtin 生效。
 */
export function mergePriceRows(overrideRows, onlineRows, builtinRows) {
  const byKey = new Map(); // provider\0modelId → row（后写覆盖先写）
  const put = (r) => {
    if (!r || !r.modelId) return;
    byKey.set((r.provider || '*') + '\u0000' + r.modelId, r);
  };
  for (const r of builtinRows || []) put(r);
  for (const r of onlineRows || []) put(r);
  for (const r of overrideRows || []) put(r);
  return [...byKey.values()];
}

export function makePricer(rows, opts = {}) {
  const target = opts.target || 'CNY';
  // rates[from] = target currency units per source unit; derive the inverse when target is USD.
  const baseRates = target === 'USD' ? { USD: 1, CNY: 1 / DEFAULT_RATES.USD } : DEFAULT_RATES;
  const rates = { ...baseRates, ...(opts.rates || {}) };
  const aliases = new Map([...Object.entries(DEFAULT_ALIASES), ...Object.entries(opts.aliases || {})]);
  const byModel = new Map();          // provider:'*' 的通用价
  const byProviderModel = new Map();  // provider 级覆盖价（优先）
  for (const r of rows) {
    if (!r.modelId) continue;
    const modelId = normalizeModelId(r.modelId);
    if (r.provider === '*') byModel.set(modelId, r);
    else byProviderModel.set((r.provider || '*') + '\u0000' + modelId, r);
  }

  function price(provider, model) {
    const id = normalizeModelId(model);
    for (const cand of new Set([id, aliases.get(id)]).values()) {
      if (!cand) continue;
      const hit = byProviderModel.get((provider || '*') + '\u0000' + cand) || byModel.get(cand);
      if (hit) return hit;
    }
    return null;
  }

  /** tokens: { input, output, cacheRead, cacheWrite } → { priced, amount, currency } | { priced:false } */
  function estimate(provider, model, tokens) {
    const p = price(provider, model);
    if (!p) return { priced: false };
    const t = tokens || {};
    const pm = p.perMillion;
    const amount =
      ((t.input || 0) * (pm.input ?? 0) +
        (t.output || 0) * (pm.output ?? 0) +
        (t.cacheRead || 0) * (pm.cacheRead ?? 0) +
        (t.cacheWrite || 0) * (pm.cacheWrite ?? 0)) / 1e6;
    const converted = amount * (rates[p.currency] ?? 1);
    return { priced: true, amount: converted, currency: target };
  }

  function convert(amount, from) {
    return amount * (rates[from] ?? 1);
  }

  return { price, estimate, convert, target };
}
