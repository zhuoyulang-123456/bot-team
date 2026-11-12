import fs from 'node:fs';
import path from 'node:path';
import { buildOpencodeEvents } from './opencode-history.mjs';

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** 不同 CLI 的 usage 字段不一样，按 backend 归一化，避免重复计算缓存/推理 */
export function normalizeBackendUsage(raw, backend) {
  if (!raw || typeof raw !== 'object') {
    return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cacheIncluded: false, total: 0 };
  }
  const input = num(raw.input ?? raw.input_tokens ?? raw.prompt_tokens);
  const output = num(raw.output ?? raw.output_tokens ?? raw.completion_tokens);
  const totalRaw = num(raw.total ?? raw.total_tokens);
  if (backend === 'opencode') {
    const reasoning = num(raw.reasoning);
    const cacheRead = num(raw.cache?.read ?? raw.cache_read);
    const cacheWrite = num(raw.cache?.write ?? raw.cache_write);
    return {
      input,
      output,
      reasoning,
      cacheRead,
      cacheWrite,
      cacheIncluded: false,
      total: totalRaw || input + output + reasoning + cacheRead + cacheWrite,
    };
  }
  if (backend === 'codex') {
    const cacheRead = num(raw.cached_input_tokens ?? raw.input_tokens_details?.cached_tokens);
    const cacheWrite = num(raw.cache_write_input_tokens);
    return {
      input,
      output,
      reasoning: 0,
      cacheRead,
      cacheWrite,
      cacheIncluded: cacheRead > 0,
      total: totalRaw || input + output,
    };
  }
  if (backend === 'agy') {
    // Gemini 的 thinking tokens 已包含在 output_tokens 里。
    // cache_read_tokens 有时是跨多步的累计值（会大于 input），口径不一致时不要按缓存价重复计费。
    const rawCache = num(raw.cache_read_tokens);
    const cacheRead = rawCache > 0 && rawCache <= input ? rawCache : 0;
    return {
      input,
      output,
      reasoning: 0,
      cacheRead,
      cacheWrite: 0,
      cacheIncluded: cacheRead > 0,
      total: totalRaw || input + output,
    };
  }
  if (backend === 'codebuddy' || backend === 'qoder' || backend === 'claude') {
    // Anthropic 风格：input 不含缓存；OpenAI 风格：prompt_tokens 含缓存。
    const cacheRead = num(raw.cache_read_input_tokens);
    const cacheWrite = num(raw.cache_creation_input_tokens);
    const cachedInPrompt = num(raw.prompt_tokens_details?.cached_tokens);
    const cacheIncluded = cacheRead === 0 && cachedInPrompt > 0;
    return {
      input,
      output,
      reasoning: 0,
      cacheRead: cacheRead || cachedInPrompt,
      cacheWrite,
      cacheIncluded,
      total: totalRaw || input + output + cacheWrite + (cacheIncluded ? 0 : cacheRead),
    };
  }
  const reasoning = num(raw.reasoning ?? raw.reasoning_tokens);
  const cacheRead = num(raw.cache?.read ?? raw.cache_read_tokens ?? raw.cache_read_input_tokens);
  const cacheWrite = num(raw.cache?.write ?? raw.cache_creation_input_tokens);
  return {
    input,
    output,
    reasoning,
    cacheRead,
    cacheWrite,
    cacheIncluded: false,
    total: totalRaw || input + output + reasoning + cacheRead + cacheWrite,
  };
}

function chatInfo(state, chatId) {
  const chat = (state.chats || []).find((c) => c.id === chatId);
  if (!chat) {
    return {
      chatId: chatId || null,
      chatType: null,
      groupId: null,
      groupTitle: null,
      projectTitle: null,
    };
  }
  const linked = chat.linkedGroupId
    ? (state.chats || []).find((c) => c.id === chat.linkedGroupId)
    : null;
  const group = chat.type === 'group' ? chat : linked;
  return {
    chatId: chat.id,
    chatType: chat.type,
    groupId: group?.id || null,
    groupTitle: group?.title || null,
    projectTitle: chat.type === 'dm' ? chat.project || chat.title || null : null,
  };
}

/** 从 Bot Team 自己的消息记录生成逐轮用量事件（带项目/群聊归属） */
function buildMessageEvents(state) {
  const events = [];
  const byBot = new Map();
  const seenUsage = new Set();
  const bots = new Map((state.bots || []).map((b) => [b.id, b]));
  for (const [chatId, messages] of Object.entries(state.messages || {})) {
    const info = chatInfo(state, chatId);
    for (const m of messages) {
      const usage = m?.meta?.usage;
      if (!usage) continue;
      const bot = bots.get(m.senderId);
      if (!bot) continue;
      const quota = String(m.meta?.quota || '');
      const sep = quota.indexOf(' · ');
      const qSource = sep > 0 ? quota.slice(0, sep) : '';
      const qModel = sep > 0 ? quota.slice(sep + 3) : '';
      const u = normalizeBackendUsage(usage, bot.backend);
      if (!u.total) continue;
      // 同一次回复可能同时出现在群聊和 Bot 项目页，按轮次去重，避免用量翻倍
      const dedupeKey = `${bot.id}|${Math.round((Number(m.ts) || 0) / 5000)}|${u.total}`;
      if (seenUsage.has(dedupeKey)) continue;
      seenUsage.add(dedupeKey);
      const e = {
        ts: Number(m.ts) || 0,
        kind: 'message-sync',
        botId: bot.id,
        botName: bot.name,
        backend: bot.backend || '',
        model: qModel || bot.model || '',
        source: qSource || bot.source || '',
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
      events.push(e);
      if (!byBot.has(bot.id)) byBot.set(bot.id, []);
      byBot.get(bot.id).push(e);
    }
  }
  for (const list of byBot.values()) list.sort((a, b) => a.ts - b.ts);
  return { events, byBot };
}

function nearestMessage(list, ts, windowMs) {
  if (!list?.length) return null;
  let lo = 0;
  let hi = list.length - 1;
  let idx = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].ts <= ts) {
      idx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  let best = null;
  for (const i of [idx - 1, idx, idx + 1]) {
    const m = list[i];
    if (!m) continue;
    const d = Math.abs(m.ts - ts);
    if (d <= windowMs && (!best || d < best.d)) best = { d, m };
  }
  return best?.m || null;
}

/**
 * 重建全部历史：
 * - OpenCode：按会话里每一轮对话聚合所有 step（token 准确），再用同一 Bot 的消息时间匹配项目/群聊
 * - 其他 CLI：直接用 Bot Team 消息里记录的每轮 usage（带项目/群聊）
 */
export function buildHistory(state, botsDir) {
  const { events: msgEvents, byBot } = buildMessageEvents(state);
  let db = null;
  try {
    db = buildOpencodeEvents(state, botsDir);
  } catch {}
  const dbEvents = (db?.events || []).map((e) => {
    const m = nearestMessage(byBot.get(e.botId), e.ts, 10 * 60 * 1000);
    if (!m) return e;
    return {
      ...e,
      chatId: m.chatId,
      chatType: m.chatType,
      groupId: m.groupId,
      groupTitle: m.groupTitle,
      projectTitle: m.projectTitle,
    };
  });
  const opencodeBots = new Set(dbEvents.map((e) => e.botId));
  const events = [...dbEvents, ...msgEvents.filter((e) => !opencodeBots.has(e.botId))];
  const covered = new Set(events.map((e) => e.botId));
  const ranges = {};
  for (const e of events) {
    if (!e.ts) continue;
    const r = ranges[e.botId] || { min: Infinity, max: -Infinity };
    r.min = Math.min(r.min, e.ts);
    r.max = Math.max(r.max, e.ts);
    ranges[e.botId] = r;
  }
  return { events, covered, ranges, stat: db?.stat || null };
}
