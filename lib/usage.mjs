import fs from 'node:fs';
import { liveAntigravityCard } from './antigravity.mjs';
import path from 'node:path';
import os from 'node:os';
import { DATA_DIR, BOTS_DIR } from './store.mjs';
import { opencodeDbStat } from './opencode-history.mjs';
import { buildHistory, normalizeBackendUsage } from './history.mjs';
import { priceForModel, pricingMeta, creditsForRun, creditMoney } from './pricing.mjs';

export const USAGE_FILE = path.join(DATA_DIR, 'usage-events.jsonl');
const AUTH_FILE = path.join(os.homedir(), '.local/share/opencode/auth.json');

const BACKEND_LABEL = {
  opencode: 'OpenCode',
  codex: 'Codex',
  agy: 'Antigravity',
  codebuddy: 'WorkBuddy',
  qoder: 'Qoder',
};

const SOURCE_LABEL = {
  'OpenCode API': 'OpenCode API（按量）',
  'OpenCode Go': 'OpenCode Go（订阅）',
  'ChatGPT Plus': 'ChatGPT Plus / Codex（订阅）',
  'Google One': 'Google One / Antigravity（订阅）',
  'WorkBuddy 中国版': 'WorkBuddy 中国版（订阅）',
  'Qoder 中国版': 'Qoder 中国版（订阅）',
  'DeepSeek 按量': 'DeepSeek 官方（按量）',
  '智谱 GLM 按量': '智谱 GLM（按量）',
  'Kimi 按量': 'Kimi 官方（按量）',
  'MiniMax 按量': 'MiniMax 官方（按量）',
  'Claude API 按量': 'Claude API（按量）',
  'Google API 按量': 'Google API（按量）',
};

// 估算单价：人民币 / 百万 token。仅用于面板估算，不是账单。
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function dayKey(ts = Date.now()) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function lastDays(n) {
  const out = [];
  const now = new Date();
  const p = (v) => String(v).padStart(2, '0');
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    out.push(`${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`);
  }
  return out;
}

function normalizeUsage(raw, backend) {
  return normalizeBackendUsage(raw, backend || '');
}

function chatInfo(state, chat) {
  if (!chat) return { chatId: null, chatType: null, groupId: null, groupTitle: null, projectTitle: null };
  const linked = chat.linkedGroupId
    ? state.chats.find((c) => c.id === chat.linkedGroupId)
    : null;
  const group = chat.type === 'group' ? chat : linked;
  return {
    chatId: chat.id,
    chatType: chat.type,
    groupId: group?.id || null,
    groupTitle: group?.title || null,
    projectTitle:
      chat.type === 'dm' ? chat.project || chat.title || null : null,
  };
}

export function recordUsage(state, { bot, chat, usage, kind = 'chat', model, credits, creditsEstimated }) {
  if (!bot) return;
  const u = normalizeUsage(usage, bot.backend);
  const info = chatInfo(state, chat);
  const event = {
    ts: Date.now(),
    kind,
    botId: bot.id,
    botName: bot.name,
    backend: bot.backend || '',
    model: model || bot.model || '',
    source: bot.source || '',
    billing: bot.billing || '',
    ...info,
    input: u.input,
    output: u.output,
    reasoning: u.reasoning,
    cacheRead: u.cacheRead,
    cacheWrite: u.cacheWrite,
    cacheIncluded: u.cacheIncluded,
    total: u.total,
    calls: 1,
  };
  const creditInfo = creditsForRun({
    backend: bot.backend,
    model: event.model,
    usage: u,
    credits,
    settings: state.settings,
  });
  if (creditInfo) {
    event.credits = creditInfo.credits;
    event.creditUnit = creditInfo.unit;
    event.creditsEstimated = creditsEstimated ?? creditInfo.estimated;
  }
  try {
    fs.mkdirSync(path.dirname(USAGE_FILE), { recursive: true });
    fs.appendFileSync(USAGE_FILE, `${JSON.stringify(event)}\n`, 'utf8');
  } catch (e) {
    console.error('[usage] write failed:', e?.message || e);
  }
}

export function ensureUsageFile(state) {
  try {
    if (fs.existsSync(USAGE_FILE) && fs.statSync(USAGE_FILE).size > 0) return false;
    const events = [];
    for (const bot of state.bots || []) {
      const days = bot.usage?.days || {};
      for (const [key, d] of Object.entries(days)) {
        const input = num(d.input);
        const output = num(d.output);
        const total = num(d.total) || input + output;
        if (!d.calls && !total) continue;
        const [y, m, day] = key.split('-').map(Number);
        events.push({
          ts: new Date(y, m - 1, day, 12, 0, 0).getTime(),
          kind: 'backfill',
          botId: bot.id,
          botName: bot.name,
          backend: bot.backend || '',
          model: bot.model || '',
          source: bot.source || '',
          billing: bot.billing || '',
          chatId: null,
          chatType: null,
          groupId: null,
          groupTitle: null,
          projectTitle: null,
          input,
          output,
          total,
          calls: num(d.calls) || 1,
          note: '历史日汇总，无项目明细',
        });
      }
    }
    fs.mkdirSync(path.dirname(USAGE_FILE), { recursive: true });
    fs.writeFileSync(
      USAGE_FILE,
      events.map((e) => JSON.stringify(e)).join('\n') + (events.length ? '\n' : ''),
      'utf8'
    );
    return true;
  } catch (e) {
    console.error('[usage] backfill failed:', e?.message || e);
    return false;
  }
}

const OPENCODE_SYNC_MARKER = path.join(DATA_DIR, '.opencode-usage-sync.json');

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 用本机 OpenCode 会话库重建历史用量。
 * 旧版本每轮只记录最后一个 step，这里按每轮对话聚合所有 step，修正历史成本。
 */
export function syncOpencodeHistory(state, { force = false } = {}) {
  const stat = opencodeDbStat();
  let msgCount = 0;
  let msgMax = 0;
  for (const list of Object.values(state.messages || {})) {
    for (const m of list) {
      if (!m?.meta?.usage) continue;
      msgCount += 1;
      msgMax = Math.max(msgMax, Number(m.ts) || 0);
    }
  }
  if (!stat && !msgCount) return false;
  // 数据库/消息仍在写入时先跳过，避免和实时记录互相覆盖
  const lastWrite = Math.max(stat?.mtimeMs || 0, msgMax);
  if (!force && Date.now() - lastWrite < 60000) return false;
  const mark = readJsonSafe(OPENCODE_SYNC_MARKER);
  if (
    !force &&
    mark &&
    mark.mtimeMs === (stat?.mtimeMs || 0) &&
    mark.size === (stat?.size || 0) &&
    mark.msgCount === msgCount &&
    mark.msgMax === msgMax
  ) {
    return false;
  }
  let built = null;
  try {
    built = buildHistory(state, BOTS_DIR);
  } catch (e) {
    console.error('[usage] history rebuild failed:', e?.message || e);
    return false;
  }
  if (!built || !built.events.length) return false;
  const existing = readUsageEvents();
  const kept = existing.filter((e) => {
    if (!built.covered.has(e.botId)) return true;
    const r = built.ranges[e.botId];
    return !(r && e.ts >= r.min && e.ts <= r.max);
  });
  const merged = [...kept, ...built.events].sort((a, b) => a.ts - b.ts);
  try {
    const tmp = `${USAGE_FILE}.tmp`;
    fs.writeFileSync(
      tmp,
      merged.map((e) => JSON.stringify(e)).join('\n') + (merged.length ? '\n' : ''),
      'utf8'
    );
    fs.renameSync(tmp, USAGE_FILE);
    fs.writeFileSync(
      OPENCODE_SYNC_MARKER,
      JSON.stringify({
        mtimeMs: stat?.mtimeMs || 0,
        size: stat?.size || 0,
        msgCount,
        msgMax,
        at: Date.now(),
      }),
      'utf8'
    );
    return true;
  } catch (e) {
    console.error('[usage] opencode history write failed:', e?.message || e);
    return false;
  }
}

export function readUsageEvents() {
  try {
    if (!fs.existsSync(USAGE_FILE)) return [];
    const lines = fs.readFileSync(USAGE_FILE, 'utf8').split('\n');
    const out = [];
    const seen = new Set();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (!e || !Number.isFinite(e.ts)) continue;
        // 同一次回复可能被记到群聊和 Bot 项目页两条，按 机器人+时间+用量 去重，
        // 避免后台统计把同一轮算两次（底部「今日」和用量面板对不上就是这个原因）。
        // 群聊和 Bot 项目页的同一轮回复会差几十毫秒，按 5 秒桶去重
        const key = `${e.botId || e.botName || ''}|${Math.round(e.ts / 5000)}|${Number(e.total) || 0}|${e.kind || ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(e);
      } catch {}
    }
    // OpenCode 的用量会同时出现在「会话数据库重建」和「实时 workflow/chat」里，
    // 同一次调用会被算两次；以数据库重建为准，丢掉 5 分钟内同机器人同用量的实时记录。
    const dbKeys = new Set(
      out
        .filter((e) => e.kind === 'opencode-db')
        .map((e) => `${e.botId || ''}|${Number(e.total) || 0}|${Math.round(e.ts / 300000)}`)
    );
    if (dbKeys.size) {
      return out.filter((e) => {
        if (e.kind === 'opencode-db') return true;
        const k = `${e.botId || ''}|${Number(e.total) || 0}|${Math.round(e.ts / 300000)}`;
        return !dbKeys.has(k);
      });
    }
    return out;
  } catch {
    return [];
  }
}

function isDeepseekPeak(ts) {
  const t = Number(ts);
  if (!Number.isFinite(t) || !t) return true;
  // DeepSeek 高峰时段按北京时间：周一至周五 9:00-12:00、14:00-18:00
  const d = new Date(t + 8 * 3600 * 1000);
  const day = d.getUTCDay();
  const hour = d.getUTCHours();
  return day >= 1 && day <= 5 && ((hour >= 9 && hour < 12) || (hour >= 14 && hour < 18));
}

function estimate(event, includeSubscription, settings) {
  const price = priceForModel(event.model);
  const input = num(event.input);
  const output = num(event.output);
  const reasoning = num(event.reasoning);
  let cacheRead = num(event.cacheRead);
  let cacheWrite = num(event.cacheWrite);
  if (event.cacheRead == null && event.cacheWrite == null && event.reasoning == null) {
    // 旧事件只存了 total，把 total - input - output 视为缓存命中
    cacheRead = Math.max(0, num(event.total) - input - output);
    cacheWrite = 0;
  }
  const outTokens = output + reasoning;
  const inputBillable = Math.max(
    0,
    input - (event.cacheIncluded && Number.isFinite(cacheRead) ? cacheRead : 0)
  );
  let base =
    (inputBillable / 1e6) * price.in +
    (outTokens / 1e6) * price.out +
    (cacheRead / 1e6) * price.cache +
    (cacheWrite / 1e6) * (price.cacheW ?? price.in);
  // 历史日汇总没有真实调用时刻，按高峰价保守估算；真实调用按空闲/高峰折算
  if (price.peak && event.kind !== 'backfill' && !isDeepseekPeak(event.ts)) base *= 0.5;

  // 积分：优先用事件记录的真实值（Qoder CLI 直接返回）；WorkBuddy 只有 token，按套餐比例估算。
  let credits = Number(event.credits);
  let creditsEstimated = !!event.creditsEstimated;
  let creditInfo = null;
  if (!Number.isFinite(credits)) {
    creditInfo = creditsForRun({
      backend: event.backend,
      model: event.model,
      usage: { input, output, cacheRead, total: num(event.total) },
      settings,
    });
    credits = creditInfo ? creditInfo.credits : 0;
    creditsEstimated = creditInfo ? creditInfo.estimated : false;
  }
  const creditCost = creditMoney(event.backend, credits, settings);
  // Qoder / WorkBuddy 按积分计费：只要知道是积分渠道，就不要再退回 token 单价
  const creditBilled = Number.isFinite(Number(event.credits)) || creditInfo != null;

  const isSub = event.billing === 'subscription';
  const creditBase = creditBilled ? creditCost : base;
  const apiCost = creditBase;
  return {
    base,
    api: isSub ? 0 : apiCost,
    sub: isSub ? creditBase : 0,
    cost: isSub ? (includeSubscription ? creditBase : 0) : apiCost,
    priced: price.priced || creditBilled,
    cache: cacheRead,
    credits: credits || 0,
    creditsEstimated,
    creditCost,
    creditBase: creditBilled,
  };
}

function bump(map, key, label, event, cost, priced, extra, credit) {
  if (!key) key = 'unknown';
  let row = map.get(key);
  if (!row) {
    row = {
      key,
      label,
      total: 0,
      input: 0,
      output: 0,
      cache: 0,
      calls: 0,
      cost: 0,
      credits: 0,
      creditCost: 0,
      creditsEstimated: false,
      unpriced: 0,
      billing: event.billing || '',
      ...(extra || {}),
    };
    map.set(key, row);
  }
  if (extra?.deleted) row.deletedCount = (row.deletedCount || 0) + 1;
  else if (extra) row.liveCount = (row.liveCount || 0) + 1;
  row.total += num(event.total);
  row.input += num(event.input);
  row.output += num(event.output);
  row.cache +=
    event.cacheRead != null
      ? num(event.cacheRead)
      : Math.max(0, num(event.total) - num(event.input) - num(event.output));
  row.calls += num(event.calls) || 1;
  row.cost += cost;
  if (credit) {
    row.credits += credit.credits || 0;
    row.creditCost += credit.creditCost || 0;
    if (credit.creditsEstimated) row.creditsEstimated = true;
  }
  if (!priced) row.unpriced += num(event.total);
}

function placeKind(e) {
  if (e.groupTitle) return 'group';
  if (e.projectTitle) return 'project';
  if (e.chatId) return 'dm';
  return 'history';
}

const PLACE_KIND_RANK = { group: 0, project: 1, dm: 2, history: 3 };

export function summarizeUsage(state, { days = 30, includeSubscription = false, day = '' } = {}) {
  ensureUsageFile(state);
  try {
    syncOpencodeHistory(state);
  } catch (e) {
    console.error('[usage] opencode sync failed:', e?.message || e);
  }
  const n = [7, 30, 90].includes(Number(days)) ? Number(days) : 30;
  const keys = lastDays(n);
  const since = new Date(`${keys[0]}T00:00:00`).getTime();
  const scopeDay = /^\d{4}-\d{2}-\d{2}$/.test(String(day || '')) ? String(day) : '';
  const scopeStart = scopeDay ? new Date(`${scopeDay}T00:00:00`).getTime() : 0;
  const scopeEnd = scopeDay ? scopeStart + 86400000 : 0;
  const dailyMap = new Map(
    keys.map((k) => [k, { date: k, total: 0, input: 0, output: 0, calls: 0, cost: 0, credits: 0, creditCost: 0 }])
  );
  const dims = {
    model: new Map(),
    backend: new Map(),
    source: new Map(),
    bot: new Map(),
    group: new Map(),
    project: new Map(),
    place: new Map(),
  };
  const totals = {
    total: 0,
    input: 0,
    output: 0,
    cache: 0,
    calls: 0,
    cost: 0,
    apiCost: 0,
    subCost: 0,
    credits: 0,
    creditCost: 0,
    creditsEstimated: false,
    priced: 0,
    unpriced: 0,
    events: 0,
    backfill: 0,
    rebuilt: 0,
  };

  const liveBotIds = new Set((state.bots || []).map((b) => b.id));
  const liveChatIds = new Set((state.chats || []).map((c) => c.id));
  const tombBots = new Map(
    (state.deleted || []).filter((x) => x.type === 'bot').map((x) => [x.id, x])
  );
  const events = readUsageEvents();
  for (const e of events) {
    if (e.ts < since) continue;
    const c = estimate(e, includeSubscription, state.settings);
    const total = num(e.total);
    const input = num(e.input);
    const output = num(e.output);
    const calls = num(e.calls) || 1;
    const k = dayKey(e.ts);
    const dayRow = dailyMap.get(k);
    if (dayRow) {
      dayRow.total += total;
      dayRow.input += input;
      dayRow.output += output;
      dayRow.calls += calls;
      dayRow.cost += c.cost;
      dayRow.credits += c.credits;
      dayRow.creditCost += c.creditCost;
    }
    // 选中某一天时，顶部指标与下方排行只统计那一天，柱状图仍保留整个区间
    if (scopeDay && (e.ts < scopeStart || e.ts >= scopeEnd)) continue;
    totals.total += total;
    totals.input += input;
    totals.output += output;
    totals.cache += c.cache;
    totals.calls += calls;
    totals.cost += c.cost;
    totals.apiCost += c.api;
    totals.subCost += c.sub;
    totals.credits += c.credits;
    totals.creditCost += c.creditCost;
    if (c.creditsEstimated) totals.creditsEstimated = true;
    totals.events += 1;
    if (e.kind === 'backfill') totals.backfill += total;
    if (e.kind === 'opencode-db') totals.rebuilt += total;
    if (c.priced) totals.priced += total;
    else totals.unpriced += total;

    const labelModel = e.model || '未记录模型';
    const labelBackend = BACKEND_LABEL[e.backend] || e.backend || '未知 CLI';
    const sourceKey = `${e.source || '未设置来源'}|${e.billing || ''}`;
    const sourceLabel = SOURCE_LABEL[e.source] || e.source || '未设置来源';
    const billingLabel =
      e.billing === 'subscription' ? '订阅' : e.billing === 'free' ? '免费' : e.billing === 'payg' ? '按量' : '';
    const labelBot = e.botName || e.botId || '未知 Bot';
    const labelGroup = e.groupTitle || '历史汇总 / 未关联群';
    const labelProject = e.projectTitle || e.groupTitle || '历史汇总 / 未关联项目';
    const labelPlace = dimLabelFor('place', e);

    bump(dims.model, labelModel, labelModel, e, c.cost, c.priced, null, c);
    bump(dims.backend, e.backend || 'unknown', labelBackend, e, c.cost, c.priced, null, c);
    bump(
      dims.source,
      sourceKey,
      billingLabel ? `${sourceLabel} · ${billingLabel}` : sourceLabel,
      e,
      c.cost,
      c.priced,
      null,
      c
    );
    const botDeleted = !!e.botId && !liveBotIds.has(e.botId);
    const placeDeleted =
      (!!e.groupId && !liveChatIds.has(e.groupId)) ||
      (!!e.chatId && !liveChatIds.has(e.chatId));
    bump(dims.bot, e.botId || 'unknown', labelBot, e, c.cost, c.priced, {
      deleted: botDeleted,
    }, c);
    bump(dims.group, e.groupId || 'backfill', labelGroup, e, c.cost, c.priced, null, c);
    bump(dims.project, e.chatId || 'backfill', labelProject, e, c.cost, c.priced, null, c);
    bump(dims.place, dimKeyFor('place', e), labelPlace, e, c.cost, c.priced, {
      kind: placeKind(e),
      deleted: placeDeleted,
    }, c);
  }

  for (const row of dims.bot.values()) {
    row.deleted = (row.deletedCount || 0) > 0 && !(row.liveCount > 0);
    if (row.deleted) {
      const t = tombBots.get(row.key);
      row.lastModel = t?.model || '';
      row.lastSource = t?.source || '';
      row.lastQuota = t?.quota || '';
    }
  }
  for (const row of dims.place.values()) {
    row.deleted = (row.deletedCount || 0) > 0 && !(row.liveCount > 0);
  }

  const sortRows = (map) =>
    [...map.values()].sort((a, b) => b.total - a.total).slice(0, 20);
  return {
    days: n,
    scopeDay,
    includeSubscription: !!includeSubscription,
    currency: 'CNY',
    since,
    generatedAt: Date.now(),
    totals,
    daily: keys.map((k) => dailyMap.get(k)),
    dims: {
      model: sortRows(dims.model),
      backend: sortRows(dims.backend),
      source: sortRows(dims.source),
      bot: sortRows(dims.bot),
      group: sortRows(dims.group),
      project: sortRows(dims.project),
      place: [...dims.place.values()]
        .sort(
          (a, b) =>
            (PLACE_KIND_RANK[a.kind] ?? 9) - (PLACE_KIND_RANK[b.kind] ?? 9) ||
            b.total - a.total
        )
        .slice(0, 20),
    },
    pricing: pricingMeta(),
    priceNote:
      '成本按模型官方单价估算（DeepSeek 使用高峰价，空闲时段约为一半；其他模型按 models.dev 价格折算人民币）；缓存命中的输入按缓存价单独计算；Qoder 直接读取 CLI 返回的 Credits，WorkBuddy 的 CLI 不返回积分、按 token 估算（比例可在设置里改）；两者按设置的积分单价折算成人民币；Qoder 在本次版本之前的旧记录没有积分字段，无法补算，新调用开始精确记录；翻译 / 解释 / 改写等内置辅助调用暂未计入；订阅制默认不计入合计，以官方账单为准。',
  };
}

function dimKeyFor(dim, e) {
  switch (dim) {
    case 'model':
      return e.model || '未记录模型';
    case 'backend':
      return e.backend || 'unknown';
    case 'source':
      return `${e.source || '未设置来源'}|${e.billing || ''}`;
    case 'bot':
      return e.botId || 'unknown';
    case 'place':
      // 群聊和关联到该群的私聊统一按名称归并，避免同名群/项目被拆成多行
      if (e.groupTitle) return `title:${e.groupTitle}`;
      if (e.projectTitle) return `title:${e.projectTitle}`;
      if (e.chatId) return 'dm';
      return 'backfill';
    case 'group':
      return e.groupId || 'backfill';
    case 'project':
      return e.chatId || 'backfill';
    case 'cli':
      return e.backend || 'unknown';
    default:
      return '';
  }
}

function dimLabelFor(dim, e) {
  switch (dim) {
    case 'model':
      return e.model || '未记录模型';
    case 'backend':
    case 'cli':
      return BACKEND_LABEL[e.backend] || e.backend || '未知 CLI';
    case 'source': {
      const sourceLabel = SOURCE_LABEL[e.source] || e.source || '未设置来源';
      const billingLabel =
        e.billing === 'subscription'
          ? '订阅'
          : e.billing === 'free'
            ? '免费'
            : e.billing === 'payg'
              ? '按量'
              : '';
      return billingLabel ? `${sourceLabel} · ${billingLabel}` : sourceLabel;
    }
    case 'bot':
      return e.botName || e.botId || '未知 Bot';
    case 'place':
      if (e.groupId) return e.groupTitle || '未命名群聊';
      if (e.projectTitle) return e.projectTitle;
      if (e.chatId) return '私聊 / 未归属项目';
      return '历史汇总 / 未关联项目 / 群聊';
    case 'group':
      return e.groupTitle || '历史汇总 / 未关联群';
    case 'project':
      return e.projectTitle || e.groupTitle || '历史汇总 / 未关联项目';
    default:
      return '';
  }
}

/** 某个维度下单个条目的明细：各模型消耗 + 每日趋势 */
export function summarizeUsageDetail(
  state,
  { days = 30, dim = 'bot', key = '', includeSubscription = false, day = '' } = {}
) {
  try {
    ensureUsageFile(state);
    syncOpencodeHistory(state);
  } catch (e) {
    console.error('[usage] opencode sync failed:', e?.message || e);
  }
  const n = [7, 30, 90].includes(Number(days)) ? Number(days) : 30;
  const keys = lastDays(n);
  const since = new Date(`${keys[0]}T00:00:00`).getTime();
  const scopeDay = /^\d{4}-\d{2}-\d{2}$/.test(String(day || '')) ? String(day) : '';
  const scopeStart = scopeDay ? new Date(`${scopeDay}T00:00:00`).getTime() : 0;
  const scopeEnd = scopeDay ? scopeStart + 86400000 : 0;
  const dailyMap = new Map(
    keys.map((k) => [k, { date: k, total: 0, input: 0, output: 0, calls: 0, cost: 0, credits: 0, creditCost: 0 }])
  );
  const models = new Map();
  const bots = new Map();
  const totals = {
    total: 0,
    input: 0,
    output: 0,
    cache: 0,
    calls: 0,
    cost: 0,
    apiCost: 0,
    subCost: 0,
    credits: 0,
    creditCost: 0,
    creditsEstimated: false,
    unpriced: 0,
    events: 0,
  };
  let label = key;
  let kind = '';
  let matched = 0;
  let anyDeleted = false;
  let anyLive = false;
  const liveBotIds = new Set((state.bots || []).map((b) => b.id));
  const liveChatIds = new Set((state.chats || []).map((c) => c.id));

  for (const e of readUsageEvents()) {
    if (e.ts < since) continue;
    if (scopeDay && (e.ts < scopeStart || e.ts >= scopeEnd)) continue;
    if (dimKeyFor(dim, e) !== key) continue;
    matched += 1;
    if (dim === 'bot') {
      if (e.botId && !liveBotIds.has(e.botId)) anyDeleted = true;
      else anyLive = true;
    } else if (dim === 'place') {
      const gone =
        (!!e.groupId && !liveChatIds.has(e.groupId)) ||
        (!!e.chatId && !liveChatIds.has(e.chatId));
      if (gone) anyDeleted = true;
      else anyLive = true;
    }
    if (matched === 1) {
      label = dimLabelFor(dim, e);
      if (dim === 'place') kind = placeKind(e);
    }
    const c = estimate(e, includeSubscription, state.settings);
    const total = num(e.total);
    const input = num(e.input);
    const output = num(e.output);
    const calls = num(e.calls) || 1;
    totals.total += total;
    totals.input += input;
    totals.output += output;
    totals.cache += c.cache;
    totals.calls += calls;
    totals.cost += c.cost;
    totals.apiCost += c.api;
    totals.subCost += c.sub;
    totals.credits += c.credits;
    totals.creditCost += c.creditCost;
    if (c.creditsEstimated) totals.creditsEstimated = true;
    totals.events += 1;
    if (!c.priced) totals.unpriced += total;

    const dayRow = dailyMap.get(dayKey(e.ts));
    if (dayRow) {
      dayRow.total += total;
      dayRow.input += input;
      dayRow.output += output;
      dayRow.calls += calls;
      dayRow.cost += c.cost;
      dayRow.credits += c.credits;
      dayRow.creditCost += c.creditCost;
    }
    bump(models, e.model || '未记录模型', e.model || '未记录模型', e, c.cost, c.priced, null, c);
    bump(bots, e.botId || 'unknown', e.botName || e.botId || '未知 Bot', e, c.cost, c.priced, null, c);
  }

  const rows = [...models.values()].sort((a, b) => b.total - a.total);
  const botRows = [...bots.values()].sort((a, b) => b.total - a.total);
  return {
    days: n,
    scopeDay,
    dim,
    key,
    label,
    kind,
    deleted: anyDeleted && !anyLive,
    includeSubscription: !!includeSubscription,
    matched,
    totals,
    models: rows,
    bots: botRows,
    daily: keys.map((k) => dailyMap.get(k)),
    generatedAt: Date.now(),
  };
}

async function fetchJson(url, token, timeout = 8000) {
  const r = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(timeout),
  });
  const text = await r.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  if (!r.ok) throw new Error(`HTTP ${r.status} ${String(text).slice(0, 120)}`);
  return data;
}

function readJsonFile(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function readApiBalanceConfig() {
  return readJsonFile(path.join(os.homedir(), '.config/api-balance/config.json')) || {};
}

function qoderPat(state) {
  const fromState = state?.providerKeys?.qoder;
  if (fromState && String(fromState).trim()) return String(fromState).trim();
  if (process.env.QODER_PAT && process.env.QODER_PAT.trim()) return process.env.QODER_PAT.trim();
  const cfg = readApiBalanceConfig();
  const v = Array.isArray(cfg.qoder) ? cfg.qoder[0] : cfg.qoder;
  return v && String(v).trim() ? String(v).trim() : '';
}

function jwtPayload(token) {
  try {
    const part = String(token || '').split('.')[1];
    if (!part) return null;
    const b = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    return JSON.parse(b.toString('utf8'));
  } catch {
    return null;
  }
}

async function chatgptQuota() {
  const auth = readJsonFile(path.join(os.homedir(), '.codex/auth.json'));
  const t = auth?.tokens;
  if (!t?.access_token) return null;
  try {
    const headers = {
      authorization: `Bearer ${t.access_token}`,
      'User-Agent': 'codex_cli_rs/0.1',
      accept: 'application/json',
    };
    if (t.account_id) headers['ChatGPT-Account-Id'] = t.account_id;
    const r = await fetch('https://chatgpt.com/backend-api/wham/usage', {
      headers,
      signal: AbortSignal.timeout(12000),
    });
    if (r.status === 401 || r.status === 403) {
      return {
        id: 'chatgpt',
        name: 'ChatGPT Plus / Codex',
        kind: 'quota',
        status: 'error',
        detail: 'Codex 登录已过期，请打开 Codex 重新登录',
      };
    }
    if (!r.ok) {
      return {
        id: 'chatgpt',
        name: 'ChatGPT Plus / Codex',
        kind: 'quota',
        status: 'error',
        detail: `用量接口 HTTP ${r.status}`,
      };
    }
    const j = await r.json();
    const windows = [];
    const primary = j.rate_limit?.primary_window;
    const secondary = j.rate_limit?.secondary_window;
    if (primary && Number.isFinite(Number(primary.used_percent))) {
      windows.push({
        label: '5 小时',
        percent: Math.round(Number(primary.used_percent)),
        resetsAt: primary.reset_at ? new Date(primary.reset_at * 1000).toISOString() : '',
      });
    }
    if (secondary && Number.isFinite(Number(secondary.used_percent))) {
      windows.push({
        label: '本周',
        percent: Math.round(Number(secondary.used_percent)),
        resetsAt: secondary.reset_at ? new Date(secondary.reset_at * 1000).toISOString() : '',
      });
    }
    const claims = jwtPayload(t.id_token);
    const authClaims = claims?.['https://api.openai.com/auth'] || {};
    const until = authClaims.chatgpt_subscription_active_until
      ? new Date(authClaims.chatgpt_subscription_active_until)
      : null;
    const plan = String(j.plan_type || 'plus');
    const planLabel = plan.charAt(0).toUpperCase() + plan.slice(1);
    const bits = [`Plan ${planLabel}`];
    if (j.email) bits.push(j.email);
    if (until && !Number.isNaN(until.getTime())) {
      bits.push(`订阅到 ${until.toLocaleDateString('zh-CN')}`);
    }
    if (j.credits && Number(j.credits.balance) > 0) {
      bits.push(`余额 ${j.credits.balance}`);
    }
    const limited =
      j.rate_limit?.limit_reached === true || windows.some((w) => w.percent >= 100);
    return {
      id: 'chatgpt',
      name: 'ChatGPT Plus / Codex',
      kind: 'quota',
      status: limited ? 'limited' : 'ok',
      windows,
      detail: bits.join(' · '),
    };
  } catch (e) {
    return {
      id: 'chatgpt',
      name: 'ChatGPT Plus / Codex',
      kind: 'quota',
      status: 'error',
      detail: String(e.message || e),
    };
  }
}

async function qoderQuota(state) {
  const pat = qoderPat(state);
  if (!pat) return null;
  try {
    const ex = await fetch('https://openapi.qoder.com.cn/api/v1/jobToken/exchange', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ personal_token: pat }),
      signal: AbortSignal.timeout(15000),
    });
    if (!ex.ok) {
      return {
        id: 'qoder',
        name: 'Qoder 中国版',
        kind: 'quota',
        status: 'error',
        detail: 'Qoder PAT 无效或已过期',
      };
    }
    const exj = await ex.json();
    const token = exj.token;
    if (!token) {
      return {
        id: 'qoder',
        name: 'Qoder 中国版',
        kind: 'quota',
        status: 'error',
        detail: 'Qoder 令牌兑换失败',
      };
    }
    const r = await fetch('https://gateway.qoder.com.cn/api/v2/quota/usage', {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) {
      return {
        id: 'qoder',
        name: 'Qoder 中国版',
        kind: 'quota',
        status: 'error',
        detail: `积分查询 HTTP ${r.status}`,
      };
    }
    const j = await r.json();
    const q = j.userQuota || {};
    const total = Number(q.total) || 0;
    const used = Number(q.used) || 0;
    const remaining = Number(q.remaining);
    const pct = total > 0 ? Math.round((used / total) * 100) : Math.round(Number(j.totalUsagePercentage || 0) * 100);
    const unit = q.unit || 'credits';
    const bits = [
      Number.isFinite(remaining) && total
        ? `剩余 ${remaining.toLocaleString('zh-CN')} / ${total.toLocaleString('zh-CN')} ${unit}`
        : `已用 ${pct}%`,
      j.userType || '',
      j.orgResourcePackage?.available
        ? `团队包剩余 ${Number(j.orgResourcePackage.remaining || 0).toLocaleString('zh-CN')}`
        : '',
    ].filter(Boolean);
    return {
      id: 'qoder',
      name: 'Qoder 中国版',
      kind: 'quota',
      status: j.isQuotaExceeded ? 'limited' : 'ok',
      windows: [{ label: '积分', percent: Math.min(100, Math.max(0, pct)) }],
      detail: bits.join(' · '),
    };
  } catch (e) {
    return {
      id: 'qoder',
      name: 'Qoder 中国版',
      kind: 'quota',
      status: 'error',
      detail: String(e.message || e),
    };
  }
}

function antigravityCards() {
  const dir = path.join(os.homedir(), '.antigravity_tools/accounts');
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const cards = [];
  for (const file of files) {
    const j = readJsonFile(path.join(dir, file));
    const quota = j?.quota;
    const groups = quota?.quota_groups;
    if (!Array.isArray(groups) || !groups.length) continue;
    const windows = [];
    for (const g of groups) {
      const dname = String(g.display_name || g.displayName || '');
      const isGem4 = /Gemini 4|Argon/i.test(dname);
      const isClaudeGpt = /Claude|GPT/i.test(dname);
      const isGemini = /Gemini/i.test(dname) && !isGem4;
      for (const b of g.buckets || []) {
        const rem = Number(b.remaining_fraction ?? b.remainingFraction);
        if (!Number.isFinite(rem)) continue;
        const used = Math.max(0, Math.min(100, Math.round((1 - rem) * 100)));
        const win = String(b.window || '');
        const winLabel = win === '5h' ? '5 小时' : win === 'weekly' ? '本周' : win;
        const prefix = isGem4 ? 'Gemini 4' : isClaudeGpt ? 'Claude/GPT' : isGemini ? 'Gemini' : dname;
        windows.push({ label: `${prefix} · ${winLabel}`, percent: used });
      }
    }
    if (!windows.length) continue;
    const updated = Number(quota.last_updated) || 0;
    const updatedMs = updated > 1e12 ? updated : updated * 1000;
    const updatedDate = updatedMs ? new Date(updatedMs) : null;
    const stale = updatedDate ? Date.now() - updatedMs > 24 * 3600 * 1000 : true;
    const bits = [quota.subscription_tier || '', j.email || ''];
    bits.push('历史快照');
    if (updatedDate) bits.push(`更新 ${updatedDate.toLocaleString('zh-CN', { hour12: false })}${stale ? '（可能过期）' : ''}`);
    if (j.disabled) bits.push('账号已禁用');
    cards.push({
      id: `antigravity-${j.email || file}`,
      name: `Antigravity · ${j.email || j.name || 'Google 账号'}`,
      kind: 'quota',
      status: j.disabled || quota.is_forbidden ? 'error' : windows.some((w) => w.percent >= 100) ? 'limited' : 'ok',
      windows,
      detail: bits.filter(Boolean).join(' · '),
    });
  }
  return cards;
}

export const PROVIDER_DEFS = [
  {
    id: 'deepseek',
    name: 'DeepSeek 官方',
    placeholder: 'sk-...',
    env: 'DEEPSEEK_API_KEY',
  },
  {
    id: 'kimi',
    name: 'Kimi / Moonshot',
    placeholder: 'sk-...',
    env: 'KIMI_API_KEY',
  },
  {
    id: 'glm',
    name: '智谱 GLM',
    placeholder: 'id.secret',
    env: 'GLM_API_KEY',
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    placeholder: 'sk-api-...',
    env: 'MINIMAX_API_KEY',
  },
  {
    id: 'mimo',
    name: 'MiMo 小米',
    placeholder: '浏览器 Cookie',
    env: 'MIMO_COOKIE',
  },
  {
    id: 'opencodeGo',
    name: 'OpenCode Go',
    placeholder: 'API Key',
    env: 'OPENCODE_GO_KEY',
  },
  {
    id: 'qoder',
    name: 'Qoder 中国版',
    placeholder: 'Personal Access Token',
    env: 'QODER_PAT',
  },
];

function localProviderKey(state, id, auth, cfg) {
  switch (id) {
    case 'deepseek':
      return auth.deepseek?.key || cfg.deepseek || '';
    case 'kimi':
      return auth['moonshotai-cn']?.key || auth.kimi?.key || cfg.kimi || '';
    case 'glm':
      return auth.glm?.key || cfg.glm || '';
    case 'minimax':
      return auth.minimax?.key || cfg.minimax || '';
    case 'mimo':
      return cfg.mimo_cookie || cfg.mimo || '';
    case 'opencodeGo':
      return auth['opencode-go']?.key || cfg.opencode_api_key || '';
    case 'qoder':
      return qoderPat(state);
    default:
      return '';
  }
}

function providerKey(state, def, auth, cfg) {
  const stored = state?.providerKeys?.[def.id];
  if (stored && String(stored).trim()) return String(stored).trim();
  const env = def.env ? process.env[def.env] : '';
  if (env && String(env).trim()) return String(env).trim();
  return String(localProviderKey(state, def.id, auth, cfg) || '').trim();
}

export function providerSummaries(state) {
  let auth = {};
  try {
    auth = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
  } catch {}
  const cfg = readApiBalanceConfig();
  return PROVIDER_DEFS.map((def) => ({
    id: def.id,
    name: def.name,
    placeholder: def.placeholder,
    configured: !!providerKey(state, def, auth, cfg),
  }));
}

async function glmCard(key) {
  try {
    const j = await fetchJson(
      'https://open.bigmodel.cn/api/biz/account/query-customer-account-report',
      key
    );
    if (j.success === false || (j.code != null && j.code !== 0 && j.code !== 200)) {
      return {
        id: 'glm',
        name: '智谱 GLM',
        kind: 'api',
        status: 'error',
        detail: j.msg || `查询失败（code ${j.code}）`,
      };
    }
    const d = j.data || {};
    const amount = Number(d.availableBalance ?? d.balance);
    if (!Number.isFinite(amount)) {
      return { id: 'glm', name: '智谱 GLM', kind: 'api', status: 'error', detail: '响应解析失败' };
    }
    const parts = [];
    if (Number(d.frozenBalance)) parts.push(`冻结 ¥${Number(d.frozenBalance).toFixed(2)}`);
    if (Number(d.giveAmount)) parts.push(`赠送 ¥${Number(d.giveAmount).toFixed(2)}`);
    if (Number(d.rechargeAmount)) parts.push(`累计充值 ¥${Number(d.rechargeAmount).toFixed(2)}`);
    return {
      id: 'glm',
      name: '智谱 GLM',
      kind: 'api',
      status: 'ok',
      currency: 'CNY',
      amount,
      detail: parts.join(' · ') || '可用余额',
    };
  } catch (e) {
    return { id: 'glm', name: '智谱 GLM', kind: 'api', status: 'error', detail: String(e.message || e) };
  }
}

async function mimoCard(cookie) {
  try {
    const r = await fetch('https://platform.xiaomimimo.com/api/v1/balance', {
      headers: {
        Cookie: cookie,
        accept: 'application/json, text/plain, */*',
        referer: 'https://platform.xiaomimimo.com/#/console/balance',
        'user-agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
      },
      signal: AbortSignal.timeout(20000),
    });
    if (r.status === 401 || (r.status >= 300 && r.status < 400)) {
      return {
        id: 'mimo',
        name: 'MiMo 小米',
        kind: 'api',
        status: 'error',
        detail: 'MiMo 登录态过期，请更新 Cookie',
      };
    }
    if (!r.ok) {
      return { id: 'mimo', name: 'MiMo 小米', kind: 'api', status: 'error', detail: `HTTP ${r.status}` };
    }
    const j = await r.json();
    if (j.code != null && j.code !== 0) {
      return {
        id: 'mimo',
        name: 'MiMo 小米',
        kind: 'api',
        status: 'error',
        detail: j.message || `查询失败（code ${j.code}）`,
      };
    }
    return mimoOkCard(j.data || {});
  } catch (e) {
    return { id: 'mimo', name: 'MiMo 小米', kind: 'api', status: 'error', detail: String(e.message || e) };
  }
}

function mimoOkCard(d) {
  const amount = Number(d.balance);
  if (!Number.isFinite(amount)) {
    return { id: 'mimo', name: 'MiMo 小米', kind: 'api', status: 'error', detail: '响应解析失败' };
  }
  const currency = String(d.currency || 'CNY').toUpperCase();
  const parts = [];
  if (Number(d.cashBalance)) parts.push(`现金 ${Number(d.cashBalance)}`);
  if (Number(d.giftBalance)) parts.push(`赠金 ${Number(d.giftBalance)}`);
  return {
    id: 'mimo',
    name: 'MiMo 小米',
    kind: 'api',
    status: 'ok',
    currency,
    amount,
    detail: parts.join(' · ') || '可用余额',
  };
}

/** 查询 MiMo；失败时自动从本机浏览器重新读取登录态并重试 */
async function mimoCardAuto(state, cookie) {
  const card = await mimoCard(cookie);
  if (card.status !== 'error') return card;
  try {
    const { syncMimoLogin } = await import('./mimo-sync.mjs');
    const got = await syncMimoLogin();
    const data = got.balance || (await fetchMimoData(got.cookie));
    if (!data) return card;
    return {
      ...mimoOkCard(data),
      renewedCookie: got.cookie,
      renewedUserId: got.userId,
      renewedPassToken: got.passToken,
    };
  } catch {
    try {
      const { getAccessIssues } = await import('./browser-cookies.mjs');
      if (getAccessIssues().length) {
        card.accessIssue = 'fda';
        card.detail = 'MiMo 登录态过期；读取浏览器登录态需要「完全磁盘访问权限」或改用 App 内登录';
      }
    } catch {}
    return card;
  }
}

async function fetchMimoData(cookie) {
  try {
    const r = await fetch('https://platform.xiaomimimo.com/api/v1/balance', {
      headers: {
        cookie,
        accept: 'application/json, text/plain, */*',
        referer: 'https://platform.xiaomimimo.com/#/console/balance',
        'user-agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
      },
      signal: AbortSignal.timeout(20000),
    });
    const j = await r.json();
    return Number(j?.code) === 0 ? j.data : null;
  } catch {
    return null;
  }
}

let balanceCache = { at: 0, data: null };

export async function fetchBalances(state, { force = false } = {}) {
  if (!force && balanceCache.data && Date.now() - balanceCache.at < 2 * 60 * 1000) {
    return balanceCache.data;
  }
  let auth = {};
  try {
    auth = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
  } catch {}
  const cfg = readApiBalanceConfig();
  const keys = {};
  for (const def of PROVIDER_DEFS) keys[def.id] = providerKey(state, def, auth, cfg);
  const out = [];
  const push = (x) => out.push(x);

  if (keys.deepseek) {
    try {
      const j = await fetchJson('https://api.deepseek.com/user/balance', keys.deepseek);
      const b = j.balance_infos?.[0];
      if (b) {
        push({
          id: 'deepseek',
          name: 'DeepSeek 官方',
          kind: 'api',
          status: 'ok',
          currency: b.currency || 'CNY',
          amount: num(b.total_balance),
          detail: `剩余充值 ¥${num(b.topped_up_balance).toFixed(2)} · 赠送 ¥${num(b.granted_balance).toFixed(2)}`,
        });
      } else {
        push({ id: 'deepseek', name: 'DeepSeek 官方', kind: 'api', status: 'error', detail: '响应解析失败' });
      }
    } catch (e) {
      push({ id: 'deepseek', name: 'DeepSeek 官方', kind: 'api', status: 'error', detail: String(e.message || e) });
    }
  }

  if (keys.kimi) {
    try {
      const j = await fetchJson('https://api.moonshot.cn/v1/users/me/balance', keys.kimi);
      const d = j.data || {};
      push({
        id: 'kimi',
        name: 'Kimi / Moonshot',
        kind: 'api',
        status: 'ok',
        currency: 'CNY',
        amount: num(d.available_balance),
        detail: `现金 ¥${num(d.cash_balance).toFixed(2)} · 代金券 ¥${num(d.voucher_balance).toFixed(2)}`,
      });
    } catch (e) {
      push({ id: 'kimi', name: 'Kimi / Moonshot', kind: 'api', status: 'error', detail: String(e.message || e) });
    }
  }

  if (keys.minimax) {
    try {
      const j = await fetchJson('https://api.minimaxi.com/account/query_balance', keys.minimax);
      push({
        id: 'minimax',
        name: 'MiniMax',
        kind: 'api',
        status: 'ok',
        currency: 'CNY',
        amount: num(j.available_amount),
        detail: `现金 ¥${num(j.cash_balance).toFixed(2)} · 代金券 ¥${num(j.voucher_balance).toFixed(2)}`,
      });
    } catch (e) {
      push({ id: 'minimax', name: 'MiniMax', kind: 'api', status: 'error', detail: String(e.message || e) });
    }
  }

  if (keys.glm) push(await glmCard(keys.glm));
  if (keys.mimo) push(await mimoCardAuto(state, keys.mimo));

  if (keys.opencodeGo) {
    try {
      const j = await fetchJson('https://opencode.ai/zen/go/v1/usage', keys.opencodeGo);
      const u = j.usage || {};
      const windows = [
        ['5 小时', u.rolling],
        ['本周', u.weekly],
        ['本月', u.monthly],
      ]
        .filter(([, w]) => w && Number.isFinite(Number(w.percent)))
        .map(([label, w]) => ({
          label,
          percent: Number(w.percent),
          resetsAt: w.resetsAt || '',
          status: w.status || '',
        }));
      push({
        id: 'opencode-go',
        name: 'OpenCode Go',
        kind: 'quota',
        status: windows.some((w) => w.status === 'rate-limited') ? 'limited' : 'ok',
        windows,
        detail: windows.some((w) => w.status === 'rate-limited')
          ? '有窗口已限流，具体额度以官方为准'
          : '订阅额度窗口',
      });
    } catch (e) {
      push({ id: 'opencode-go', name: 'OpenCode Go', kind: 'quota', status: 'error', detail: String(e.message || e) });
    }
  }

  const cg = await chatgptQuota();
  if (cg) push(cg);
  if (keys.qoder) {
    const qd = await qoderQuota(state);
    if (qd) push(qd);
  }
  const liveAnt = await liveAntigravityCard();
  const ant = liveAnt ? [liveAnt] : antigravityCards();
  for (const card of ant) push(card);

  const bots = state.bots || [];
  const countSource = (name) => bots.filter((b) => b.source === name).length;
  const hasClaude = bots.some(
    (b) =>
      b.source === 'Claude API 按量' ||
      /claude|anthropic/i.test(String(b.model || '')) ||
      /claude|anthropic/i.test(String(b.source || ''))
  );

  const workbuddyCount = countSource('WorkBuddy 中国版');
  if (workbuddyCount) {
    push({
      id: 'workbuddy',
      name: 'WorkBuddy 中国版',
      kind: 'subscription',
      status: 'subscription',
      detail: `订阅制 · ${workbuddyCount} 个 Bot 在用`,
    });
  }
  if (hasClaude) {
    push({
      id: 'claude',
      name: 'Claude（订阅 / 按量）',
      kind: 'subscription',
      status: 'subscription',
      detail: '订阅 / 按量 · 使用中',
    });
  }
  if (!cg && countSource('ChatGPT Plus')) {
    push({
      id: 'chatgpt-sub',
      name: 'ChatGPT Plus / Codex',
      kind: 'subscription',
      status: 'subscription',
      detail: `订阅制 · ${countSource('ChatGPT Plus')} 个 Bot 在用`,
    });
  }
  if (!ant.length && countSource('Google One')) {
    push({
      id: 'google-sub',
      name: 'Google One / Antigravity',
      kind: 'subscription',
      status: 'subscription',
      detail: `订阅制 · ${countSource('Google One')} 个 Bot 在用`,
    });
  }

  for (const card of out) {
    if (card.status !== 'error' && card.status !== 'missing') continue;
    if (Array.isArray(card.actions) && card.actions.length) continue;
    card.actions = failureActions(card);
  }

  balanceCache = { at: Date.now(), data: out };
  return out;
}

const PROVIDER_HOME = {
  deepseek: {
    label: '打开 DeepSeek 充值页',
    url: 'https://platform.deepseek.com/top_up',
  },
  kimi: {
    label: '打开 Kimi 控制台',
    url: 'https://platform.moonshot.cn/console/account',
  },
  glm: {
    label: '打开智谱控制台',
    url: 'https://open.bigmodel.cn/usercenter/apikeys',
  },
  minimax: {
    label: '打开 MiniMax 控制台',
    url: 'https://platform.minimaxi.com/user-center/basic-information/interface-key',
  },
  mimo: {
    label: '打开 MiMo 控制台',
    url: 'https://platform.xiaomimimo.com/#/console/balance',
  },
  opencodeGo: {
    label: '打开 OpenCode 控制台',
    url: 'https://opencode.ai/auth',
  },
  qoder: {
    label: '打开 Qoder 账号页',
    url: 'https://qoder.com.cn',
  },
};

function failureActions(card) {
  const actions = [];
  const id = String(card.id || '');
  if (id.startsWith('antigravity-')) {
    actions.push({ label: '打开 Antigravity 获取实时额度', action: 'open-app', app: 'antigravity' });
  } else if (id === 'chatgpt' || id === 'chatgpt-sub') {
    actions.push({ label: '打开 ChatGPT 重新登录', url: 'https://chatgpt.com/' });
  } else {
    const providerId = id === 'opencode-go' ? 'opencodeGo' : id;
    const home = PROVIDER_HOME[providerId];
    if (providerId === 'mimo') {
      actions.push({ label: '在 App 内登录（推荐）', action: 'mimo-login' });
      actions.push({ label: '自动读取浏览器登录态', action: 'sync-mimo' });
      actions.push({ label: '手动更新 Cookie', action: 'provider', provider: 'mimo' });
      if (card.accessIssue === 'fda') {
        actions.push({ label: '开启完全磁盘访问权限', action: 'settings-fda' });
      }
    } else if (home) {
      actions.push({
        label: '更新 Key / Cookie',
        action: 'provider',
        provider: providerId,
      });
    }
    if (home?.url) actions.push({ label: home.label, url: home.url });
  }
  actions.push({ label: '重试', action: 'retry' });
  return actions;
}
