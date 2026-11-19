// 在线价格表获取：LiteLLM model_prices_and_context_window.json（社区日更，MIT 仓库的公开数据）
// 拉取成功后合并到本地价目表，用户 pricing/models.csv 覆盖永远优先。
// 单位换算：LiteLLM 是 USD/token；内部行是每百万 token → ×1e6。

const LITELLM_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

// 各厂商 litellm_provider → 内部 provider 短名（对齐 DSH 会话里记录的 provider 名）
const PROVIDER_MAP = {
  openai: 'openai', anthropic: 'anthropic', deepseek: 'deepseek',
  google: 'google', gemini: 'google', 'z-ai': 'z-ai', zhipu: 'z-ai',
  moonshot: 'moonshot', kimi: 'moonshot', mistral: 'mistral',
  meta: 'meta', cohere: 'cohere', xai: 'xai', groq: 'groq',
};

function normalizeProvider(litellmProvider) {
  if (!litellmProvider) return '*';
  return PROVIDER_MAP[litellmProvider.toLowerCase()] || '*';
}

/**
 * LiteLLM JSON → 内部价目行（只取 chat 类、有完整 input+output 价的模型）
 * @returns Array<{provider, modelId, currency:'USD', perMillion:{input,output,cacheRead,cacheWrite}}>
 */
export function litellmToRows(json) {
  const rows = [];
  for (const [fullId, entry] of Object.entries(json || {})) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.mode && entry.mode !== 'chat') continue; // 只要对话类
    const input = Number(entry.input_cost_per_token);
    const output = Number(entry.output_cost_per_token);
    if (!Number.isFinite(input) || !Number.isFinite(output)) continue;
    if (input <= 0 && output <= 0) continue; // 免费模型不计费
    // fullId 形如 "openai/gpt-4o" 或裸 "gpt-4o"（由 litellm_provider 推断厂商）
    const slash = fullId.lastIndexOf('/');
    const modelId = (slash >= 0 ? fullId.slice(slash + 1) : fullId).toLowerCase();
    if (!modelId || modelId === 'sample_spec') continue;
    const provider = normalizeProvider(entry.litellm_provider);
    rows.push({
      provider,
      modelId,
      currency: 'USD',
      perMillion: {
        input: input * 1e6,
        output: output * 1e6,
        cacheRead: Number.isFinite(Number(entry.cache_read_input_token_cost)) ? Number(entry.cache_read_input_token_cost) * 1e6 : null,
        cacheWrite: Number.isFinite(Number(entry.cache_creation_input_token_cost)) ? Number(entry.cache_creation_input_token_cost) * 1e6 : null,
      },
    });
  }
  return rows;
}

/**
 * 拉取 LiteLLM 价格表，带超时；失败返回 null（调用方静默回退内置表）
 * @param {{timeoutMs?: number, fetchImpl?: Function}} opts
 */
export async function fetchOnlinePrices(opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 8000;
  // 显式传入 null 表示测试/调用方禁用网络；未传入时才使用全局 fetch。
  const fetchImpl = Object.prototype.hasOwnProperty.call(opts, 'fetchImpl') ? opts.fetchImpl : globalThis.fetch;
  if (typeof fetchImpl !== 'function') return null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(LITELLM_URL, { signal: ctrl.signal });
    } finally {
      clearTimeout(t);
    }
    if (!res || !res.ok) return null;
    const json = await res.json();
    const rows = litellmToRows(json);
    return rows.length > 0 ? rows : null;
  } catch {
    return null;
  }
}
