import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './store.mjs';

const CACHE_FILE = path.join(DATA_DIR, 'pricing-models-dev.json');
const SOURCE = 'https://models.dev/api.json';
const USD_CNY = Number(process.env.BT_USD_CNY || 7.2) || 7.2;
const TTL = 24 * 3600 * 1000;

// 只保留会用到的 provider，避免缓存文件过大
const PROVIDERS = [
  'openai',
  'anthropic',
  'google',
  'deepseek',
  'moonshotai',
  'moonshotai-cn',
  'zhipuai',
  'minimax',
  'minimax-cn',
  'alibaba',
  'alibaba-cn',
  'xai',
  'xiaomi',
  'opencode',
  'openrouter',
];

// 静态兜底：models.dev 尚未拉取、或模型名对不上价格表时使用，单位：元 / 百万 tokens。
// 数值按各厂商官方人民币价目表核对（2026-11-17），美元价按 BT_USD_CNY（默认 7.2）折算。
const FALLBACK = [
  { re: /free/i, in: 0, out: 0, cache: 0, cacheW: 0, priced: true, label: '免费' },
  // DeepSeek 官方人民币价（高峰价；空闲时段为一半）
  { re: /deepseek.*pro/i, in: 9, out: 27, cache: 0.3, peak: true, priced: true, label: 'DeepSeek Pro' },
  { re: /deepseek/i, in: 2, out: 8, cache: 0.04, peak: true, priced: true, label: 'DeepSeek Flash' },
  // OpenAI（美元 × 7.2）
  { re: /gpt-6[.-]1-sol/i, in: 14.4, out: 72, cache: 0.72, cacheW: 18, priced: true, label: 'GPT-6.1 Sol' },
  { re: /gpt-6[.-]1-terra/i, in: 7.2, out: 36, cache: 0.36, cacheW: 9, priced: true, label: 'GPT-6.1 Terra' },
  { re: /gpt-6-astra|gpt-6-pro/i, in: 72, out: 360, cache: 7.2, cacheW: 90, priced: true, label: 'GPT-6 Astra' },
  { re: /gpt-6-sol/i, in: 14.4, out: 72, cache: 1.44, cacheW: 18, priced: true, label: 'GPT-6 Sol' },
  { re: /gpt-6-luna/i, in: 0.72, out: 3.6, cache: 0.072, cacheW: 0.9, priced: true, label: 'GPT-6 Luna' },
  { re: /gpt-5[.-]6-sol/i, in: 28.8, out: 144, cache: 2.88, cacheW: 36, priced: true, label: 'GPT-5.6 Sol' },
  { re: /gpt-5[.-]6-luna/i, in: 1.44, out: 8.64, cache: 0.144, cacheW: 1.8, priced: true, label: 'GPT-5.6 Luna' },
  { re: /gpt-5[.-]6-terra/i, in: 14.4, out: 86.4, cache: 1.44, cacheW: 18, priced: true, label: 'GPT-5.6 Terra' },
  { re: /gpt-5[.-]3-codex/i, in: 12.6, out: 100.8, cache: 1.26, priced: true, label: 'GPT-5.3 Codex' },
  { re: /gpt-6|gpt-5|codex/i, in: 14.4, out: 72, cache: 0.72, priced: true, label: 'GPT / Codex' },
  // Anthropic（美元 × 7.2）
  { re: /fable|mythos/i, in: 57.6, out: 288, cache: 1.44, cacheW: 72, priced: true, label: 'Claude Fable / Mythos' },
  { re: /claude.*opus-5[.-]5|claude.*opus-5\.5/i, in: 28.8, out: 144, cache: 1.44, cacheW: 36, priced: true, label: 'Claude Opus 5.5' },
  { re: /claude.*opus/i, in: 36, out: 180, cache: 3.6, cacheW: 45, priced: true, label: 'Claude Opus' },
  { re: /claude.*haiku/i, in: 0.72, out: 3.6, cache: 0.072, cacheW: 0.9, priced: true, label: 'Claude Haiku' },
  { re: /claude.*sonnet-5[.-]5|claude-sonnet-5\b/i, in: 14.4, out: 72, cache: 0.72, cacheW: 18, priced: true, label: 'Claude Sonnet 5.x' },
  { re: /claude.*sonnet/i, in: 21.6, out: 108, cache: 2.16, cacheW: 27, priced: true, label: 'Claude Sonnet 4.x' },
  { re: /claude/i, in: 14.4, out: 72, cache: 0.72, cacheW: 18, priced: true, label: 'Claude Sonnet' },
  // Google（美元 × 7.2）
  { re: /gemini-4-carbon|gemini-4-argon/i, in: 14.4, out: 72, cache: 0.72, priced: true, label: 'Gemini 4 Carbon / Argon' },
  { re: /gemini-4-hydrogen/i, in: 10.8, out: 54, cache: 0.54, priced: true, label: 'Gemini 4 Hydrogen' },
  { re: /gemini-4/i, in: 14.4, out: 72, cache: 0.72, priced: true, label: 'Gemini 4' },
  { re: /gemini-3[.-]8-flash/i, in: 5.4, out: 27, cache: 0.54, priced: true, label: 'Gemini 3.8 Flash' },
  { re: /gemini/i, in: 5.4, out: 27, cache: 0.54, priced: true, label: 'Gemini Flash' },
  // xAI（美元 × 7.2）
  { re: /grok-4[.-]7|grok-4[.-]6|grok-4[.-]5|grok-4[.-]3/i, in: 14.4, out: 43.2, cache: 3.6, priced: true, label: 'Grok' },
  { re: /grok/i, in: 9, out: 18, cache: 1.44, priced: true, label: 'Grok' },
  // 智谱（官方人民币价）
  { re: /glm-5[.-]3-flashx/i, in: 2, out: 7, cache: 0.57, priced: true, label: 'GLM-5.3-FlashX' },
  { re: /glm-5[.-]3-flash/i, in: 0.8, out: 2.8, cache: 0.23, priced: true, label: 'GLM-5.3-Flash' },
  { re: /glm-5[.-]3|glm-5[.-]2/i, in: 8, out: 28, cache: 2, priced: true, label: 'GLM-5.x' },
  { re: /glm/i, in: 8.6, out: 30.1, cache: 2.15, priced: true, label: 'GLM' },
  // 月之暗面（官方人民币价）
  { re: /kimi-k3[.-]1-pro/i, in: 22, out: 110, cache: 2.2, cacheW: 22, priced: true, label: 'Kimi K3.1 Pro' },
  { re: /kimi-k3/i, in: 20, out: 100, cache: 2, cacheW: 20, priced: true, label: 'Kimi K3' },
  { re: /kimi-k2[.-]7-code-highspeed/i, in: 13, out: 54, cache: 2.6, priced: true, label: 'Kimi K2.7 Code HS' },
  { re: /kimi-k2[.-]7/i, in: 6.5, out: 27, cache: 1.3, priced: true, label: 'Kimi K2.7' },
  { re: /kimi/i, in: 6.5, out: 27, cache: 1.1, priced: true, label: 'Kimi' },
  // MiniMax（官方人民币价）
  { re: /minimax-m3[.-]1-flash/i, in: 1, out: 4, cache: 0.1, priced: true, label: 'MiniMax M3.1 Flash' },
  { re: /minimax-m3/i, in: 2.1, out: 8.4, cache: 0.42, priced: true, label: 'MiniMax M3' },
  { re: /minimax/i, in: 2.1, out: 8.4, cache: 0.42, priced: true, label: 'MiniMax' },
  // 阿里云百炼（官方人民币价）
  { re: /qwen4-max|qwen-4-max/i, in: 10.2, out: 30.5, cache: 0.51, priced: true, label: 'Qwen4 Max' },
  { re: /qwen3[.-]8-max|qwen-3[.-]8-max/i, in: 11.9, out: 35.7, cache: 0.6, priced: true, label: 'Qwen3.8 Max' },
  { re: /qwen3-coder-flash/i, in: 1.04, out: 4.13, priced: true, label: 'Qwen3 Coder Flash' },
  { re: /qwen/i, in: 0.85, out: 2.88, cache: 0.11, priced: true, label: 'Qwen' },
  // 小米 MiMo（官方人民币价）
  { re: /mimo-v2[.-]6-pro/i, in: 3, out: 6, cache: 0.025, priced: true, label: 'MiMo V2.6 Pro' },
  { re: /mimo/i, in: 1, out: 2, cache: 0.02, priced: true, label: 'MiMo V2.6 Flash' },
  // 腾讯混元（TokenHub 官方人民币价）
  { re: /hy4[.-]?flash/i, in: 0.5, out: 2, cache: 0.02, priced: true, label: 'Hy4 Flash' },
  { re: /hy4/i, in: 6, out: 18, cache: 0.3, priced: true, label: 'Hy4' },
  { re: /hy3/i, in: 1, out: 4, cache: 0.25, priced: true, label: 'Hy3' },
  // Mistral（美元 × 7.2）
  { re: /mistral-large/i, in: 5.04, out: 15.12, cache: 0.5, priced: true, label: 'Mistral Large 4' },
  { re: /mistral-medium|vibe/i, in: 10.8, out: 54, cache: 1.08, priced: true, label: 'Mistral Medium 3.5' },
  { re: /mistral-small/i, in: 1.08, out: 4.32, cache: 0.11, priced: true, label: 'Mistral Small 4' },
  { re: /codestral/i, in: 2.16, out: 6.48, cache: 0.22, priced: true, label: 'Codestral' },
];

let cache = null;
try {
  cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
} catch {}

function compact(api) {
  const providers = {};
  for (const id of PROVIDERS) {
    const p = api[id];
    if (!p?.models) continue;
    const models = {};
    for (const [mid, m] of Object.entries(p.models)) {
      const c = m.cost || {};
      if (c.input == null && c.output == null) continue;
      models[mid] = {
        i: Number(c.input) || 0,
        o: Number(c.output) || 0,
        cr: Number(c.cache_read) || 0,
        cw: Number(c.cache_write) || 0,
        n: m.name || mid,
      };
    }
    providers[id] = models;
  }
  return providers;
}

export async function initPricing(force = false) {
  if (!force && cache && Date.now() - cache.at < TTL) return cache;
  try {
    const res = await fetch(SOURCE, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return cache;
    const api = await res.json();
    const next = {
      at: Date.now(),
      source: SOURCE,
      rate: USD_CNY,
      providers: compact(api),
    };
    cache = next;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(CACHE_FILE, JSON.stringify(next), 'utf8');
    } catch {}
    return next;
  } catch {
    return cache;
  }
}

export function pricingMeta() {
  return {
    source: 'models.dev',
    url: SOURCE,
    updatedAt: cache?.at || 0,
    usdCny: USD_CNY,
    live: !!cache,
  };
}

/* 自定义 API 的单价（元 / 百万 tokens），由用户在 Bot 设置里填写，按模型名精确匹配 */
let customPrices = {};

export function setCustomPrices(map) {
  const next = {};
  for (const [k, v] of Object.entries(map || {})) {
    const key = String(k || '').trim().toLowerCase();
    if (!key || !v || typeof v !== 'object') continue;
    const row = {};
    for (const f of ['in', 'out', 'cache', 'cacheW']) {
      const n = Number(v[f]);
      if (Number.isFinite(n) && n >= 0) row[f] = n;
    }
    if (Object.keys(row).length) next[key] = row;
  }
  customPrices = next;
}

export function customPriceFor(model) {
  const key = String(model || '').trim().toLowerCase();
  if (!key) return null;
  if (customPrices[key]) return { ...customPrices[key], priced: true, label: '自定义单价' };
  const bare = key.split('/').pop();
  if (customPrices[bare]) return { ...customPrices[bare], priced: true, label: '自定义单价' };
  return null;
}

function normalizeModel(model) {
  let m = String(model || '').toLowerCase().trim();
  if (!m) return { bare: '', provider: '', free: false };
  const free = /-free$|(^|\/)free/i.test(m);
  m = m.replace(/-free$/, '');
  let provider = '';
  const slash = m.indexOf('/');
  if (slash > 0) {
    provider = m.slice(0, slash);
    m = m.slice(slash + 1);
  }
  // 常见变体后缀：-high / -low / -medium / -thinking / -reasoning / -latest / @date
  m = m
    .replace(/@.*$/, '')
    .replace(/-(high|low|medium|thinking|reasoning|latest)$/i, '');
  return { bare: m, provider, free };
}

const PROVIDER_ALIAS = {
  openai: 'openai',
  anthropic: 'anthropic',
  google: 'google',
  gemini: 'google',
  deepseek: 'deepseek',
  moonshotai: 'moonshotai',
  moonshot: 'moonshotai',
  kimi: 'moonshotai',
  zhipu: 'zhipuai',
  zhipuai: 'zhipuai',
  glm: 'zhipuai',
  minimax: 'minimax-cn',
  alibaba: 'alibaba-cn',
  qwen: 'alibaba-cn',
  xai: 'xai',
  grok: 'xai',
  xiaomi: 'xiaomi',
  mimo: 'xiaomi',
  opencode: 'opencode',
  'opencode-go': 'opencode',
};

function guessProvider(bare) {
  if (/^(gpt|o\d|codex|daybreak)/i.test(bare)) return 'openai';
  if (/claude|fable/i.test(bare)) return 'anthropic';
  if (/gemini|gemma|nano-banana/i.test(bare)) return 'google';
  if (/deepseek/i.test(bare)) return 'deepseek';
  if (/kimi|moonshot/i.test(bare)) return 'moonshotai';
  if (/glm/i.test(bare)) return 'zhipuai';
  if (/minimax/i.test(bare)) return 'minimax-cn';
  if (/qwen/i.test(bare)) return 'alibaba-cn';
  if (/grok/i.test(bare)) return 'xai';
  if (/mimo/i.test(bare)) return 'xiaomi';
  return '';
}

function lookupFromCache(model) {
  if (!cache?.providers) return null;
  const { bare, provider, free } = normalizeModel(model);
  if (free) return { zero: true };
  const order = [];
  const mapped = PROVIDER_ALIAS[provider];
  if (mapped) order.push(mapped);
  const guessed = guessProvider(bare);
  if (guessed && !order.includes(guessed)) order.push(guessed);
  // 没有明确 provider 时，最后再尝试 OpenCode 的模型目录
  if (!order.includes('opencode')) order.push('opencode');
  for (const p of PROVIDERS) if (!order.includes(p)) order.push(p);
  const aliasBare =
    bare === 'deepseek-v4.1-flash' || bare === 'deepseek-v4-flash' ? 'deepseek-flash' : bare;
  for (const p of order) {
    const models = cache.providers[p];
    if (!models) continue;
    if (models[aliasBare]) return { hit: models[aliasBare], provider: p };
    let best = null;
    for (const id of Object.keys(models)) {
      if (aliasBare === id || aliasBare.startsWith(id + '-') || aliasBare.startsWith(id + '.')) {
        if (!best || id.length > best.id.length) best = { id, m: models[id] };
      }
    }
    if (best) return { hit: best.m, provider: p };
  }
  return null;
}

function staticPrice(model) {
  for (const p of FALLBACK) {
    if (p.re.test(model)) return { ...p };
  }
  return { in: 2, out: 8, cache: 0.2, cacheW: 2, priced: false, label: '未定价（按国产模型估算）' };
}

/**
 * 返回人民币 / 百万 tokens 价格。
 * DeepSeek 使用官方人民币价（区分高峰/空闲），其他模型用 models.dev 的美元价按汇率折算。
 */
export function priceForModel(model) {
  const name = String(model || '');
  if (!name) return staticPrice(name);
  // 免费模型永远按 0 计，不能被自定义单价覆盖
  if (/-free$|(^|\/)free/i.test(name)) {
    return { in: 0, out: 0, cache: 0, cacheW: 0, priced: true, label: '免费' };
  }
  const override = customPriceFor(name);
  if (override) return override;
  const { bare, provider } = normalizeModel(name);
  // DeepSeek 官方人民币价
  if (provider === 'deepseek' || (!provider && /deepseek/i.test(bare))) {
    return { ...staticPrice(`deepseek ${bare}`) };
  }
  const found = lookupFromCache(name);
  if (found?.zero) return { in: 0, out: 0, cache: 0, cacheW: 0, priced: true, label: '免费' };
  if (found?.hit) {
    const h = found.hit;
    const rate = cache?.rate || USD_CNY;
    return {
      in: h.i * rate,
      out: h.o * rate,
      cache: h.cr * rate,
      cacheW: (h.cw || h.i) * rate,
      priced: true,
      label: `${h.n || bare}（models.dev）`,
    };
  }
  return staticPrice(name);
}

/* ---------------- 订阅积分（Qoder / WorkBuddy） ---------------- */

// 这两个 CLI 按积分扣费，不走 token 单价。
// Qoder 的 CLI 会直接返回 total_credits；新版本 WorkBuddy 也会返回本轮真实积分。
// 默认值来自官方公开价格（可按自己的套餐在设置里改）：
//   Qoder：$20 / 2,000 Credits ≈ ¥0.072 / 积分
//   WorkBuddy：$10 / 1,000 Credits ≈ ¥0.072 / 积分
export const DEFAULT_CREDIT_PLANS = {
  qoder: {
    unit: '积分',
    pricePerCredit: 0.072,
    tokensPerCredit: 0,
    label: 'Qoder Credits',
  },
  codebuddy: {
    unit: '积分',
    pricePerCredit: 0.072,
    // WorkBuddy 的 CLI 现在会直接返回本轮积分（turnUsage.total.credits），
    // 只有老版本不返回时才按 token 估算，所以默认不再给一个猜出来的比例。
    tokensPerCredit: 0,
    label: 'WorkBuddy Credits',
  },
};

export function creditPlan(backend, settings) {
  const def = DEFAULT_CREDIT_PLANS[backend];
  if (!def) return null;
  const custom = settings?.creditPlans?.[backend] || {};
  const pick = (v, fallback) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : fallback);
  return {
    ...def,
    pricePerCredit: pick(custom.pricePerCredit, def.pricePerCredit),
    tokensPerCredit: pick(custom.tokensPerCredit, def.tokensPerCredit),
  };
}

/**
 * 一次运行消耗多少积分。
 * - CLI 直接返回（Qoder / 新版 WorkBuddy）→ 精确值，estimated=false
 * - WorkBuddy 老版本 → 只有配置了 tokensPerCredit 才估算，否则返回 null 交给 token 单价
 * 历史事件没有 credits 字段，返回 null，不做臆测。
 */
export function creditsForRun({ backend, model, usage, credits, settings } = {}) {
  const plan = creditPlan(backend, settings);
  if (!plan) return null;
  const exact = Number(credits);
  if (Number.isFinite(exact) && exact > 0) {
    return { credits: exact, estimated: false, unit: plan.unit };
  }
  // 免费模型（CLI 明确返回 0 积分）按 0 记，不要退回 token 估算
  if (exact === 0 && /free/i.test(String(model || ''))) {
    return { credits: 0, estimated: false, unit: plan.unit };
  }
  if (backend !== 'codebuddy') return null;
  const input = Number(usage?.input ?? usage?.input_tokens ?? usage?.prompt_tokens) || 0;
  const output = Number(usage?.output ?? usage?.output_tokens ?? usage?.completion_tokens) || 0;
  const cacheRead =
    Number(
      usage?.cacheRead ??
        usage?.cache_read_input_tokens ??
        usage?.prompt_tokens_details?.cached_tokens
    ) || 0;
  const tokens =
    Number(usage?.total ?? usage?.total_tokens) || input + output + cacheRead;
  if (!plan.tokensPerCredit || tokens <= 0) {
    // 没有可用的换算比例就不编数字：交给调用方按 token 单价估算
    return null;
  }
  return { credits: tokens / plan.tokensPerCredit, estimated: true, unit: plan.unit };
}

export function creditMoney(backend, credits, settings) {
  const plan = creditPlan(backend, settings);
  const n = Number(credits) || 0;
  if (!plan || n <= 0) return 0;
  return n * plan.pricePerCredit;
}

