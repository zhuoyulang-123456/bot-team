import fs from 'node:fs';
import path from 'node:path';
import { runBot, isQuotaErrorText, isAuthErrorText } from './agents.mjs';
import { DEFAULT_FLOW_DESIGN_RULES } from './flow-rules.mjs';
import { recordUsage } from './usage.mjs';
import { creditsForRun, creditMoney } from './pricing.mjs';
import {
  botWorkspace,
  GROUPS_DIR,
  UPLOADS_DIR,
  uid,
  readMemory,
  addUsage,
  quotaLabel,
  pickAvatar,
  emptyUsage,
  defaultBilling,
  normalizeSource,
  mergePermissions,
  ensureGroupProjects,
} from './store.mjs';

const MAX_HOPS = 10;
const DRAIN_PROMPT =
  '收尾模式：不要再生产任何新内容，也不要再向其他成员要新批次。检查已经交付但还没上传的批次，把已完成的全部上传、核验、补版本公告和工作日志；没有待上传的就直接总结。完成后在最后单独一行输出 @@DONE，停止自动运行。';
const MAX_BROWSER_STEPS = 4;
const CONTEXT_LIMIT = 50000;
const CONTEXT_BATCH = 10;
const botQueues = new Map();

// 会话级串行队列由 server.mjs 注入（避免 orchestrator 反向 import server）。
// 私聊里的委派会用它把任务排到目标 Bot 自己的项目，而不是阻塞发起人的聊天窗。
let chatQueueRunner = null;
export function setChatQueueRunner(fn) {
  chatQueueRunner = typeof fn === 'function' ? fn : null;
}
function runInChatQueue(chatId, fn) {
  if (chatQueueRunner) return chatQueueRunner(chatId, fn);
  return Promise.resolve().then(fn).catch(() => {});
}

// 单次执行超时：Bot 设置里的 timeoutMin（分钟），0 / 留空 = 不限
function botTimeoutMs(bot) {
  const min = Number(bot?.timeoutMin);
  // 默认完全不限时；只有用户显式设了分钟数才启用
  if (min === -1) return 0;
  if (Number.isFinite(min) && min > 0) return Math.round(min * 60000);
  return 0;
}

// 同一个 Bot 的同一个会话串行（避免 Codex/OpenCode 的 session 被两个进程同时写）；
// 不同项目/群使用不同 session key，可以真正并行跑。
function queueBotRun(queueKey, fn, onStart) {
  const prev = botQueues.get(queueKey) || Promise.resolve();
  const run = prev
    .catch(() => {})
    .then(() => {
      onStart?.();
      return fn();
    });
  botQueues.set(queueKey, run);
  run
    .finally(() => {
      if (botQueues.get(queueKey) === run) botQueues.delete(queueKey);
    })
    .catch(() => {});
  return run;
}

export function addMessage(state, chatId, msg) {
  const m = {
    id: uid('msg'),
    chatId,
    type: msg.type || 'text',
    senderId: msg.senderId || 'system',
    toId: msg.toId || null,
    text: msg.text || '',
    attachments: msg.attachments || null,
    meta: msg.meta || null,
    ts: Date.now(),
  };
  (state.messages[chatId] ||= []).push(m);
  const chat = state.chats.find((c) => c.id === chatId);
  if (chat) chat.updatedAt = m.ts;
  return m;
}

// 群聊里只交付结果；过程写到该 Bot 和群同名的关联项目
function linkedGroupProject(state, groupChat, bot) {
  if (!groupChat || groupChat.type !== 'group' || !bot) return null;
  return (
    state.chats.find(
      (c) =>
        c.type === 'dm' &&
        c.linkedGroupId === groupChat.id &&
        c.botIds[0] === bot.id
    ) || null
  );
}

// 找到「这条过程应该写到哪个会话」。
// 群聊：镜像到该 Bot 在群里的关联项目。
// 私聊：如果说话的不是这个私聊的主人（比如领导在私聊里 @@DELEGATE 同事），
//       写到被委派 Bot 自己的项目，否则它自己的界面会一片空白。
function processChatFor(state, chat, bot) {
  if (!chat || !bot) return null;
  if (chat.type === 'group') return linkedGroupProject(state, chat, bot);
  const owner = chat.botIds?.[0];
  if (owner === bot.id) return null;
  if (chat.linkedGroupId) {
    const project = state.chats.find(
      (c) =>
        c.type === 'dm' &&
        c.botIds[0] === bot.id &&
        c.linkedGroupId === chat.linkedGroupId
    );
    if (project) return project;
  }
  if (bot.lastChatId) {
    const own = state.chats.find(
      (c) => c.type === 'dm' && c.id === bot.lastChatId && c.botIds[0] === bot.id
    );
    if (own) return own;
  }
  return state.chats.find((c) => c.type === 'dm' && c.botIds[0] === bot.id) || null;
}

function addProcess(state, groupChat, bot, text, save, emit, type = 'process', targetChat = null) {
  const project = targetChat || processChatFor(state, groupChat, bot);
  if (!project) return null;
  const m = addMessage(state, project.id, {
    type,
    senderId: bot?.id || 'system',
    text,
  });
  save();
  emit('message', { chatId: project.id, message: m });
  return m;
}

function updateProcessMessage(state, chatId, msgId, text, save, emit) {
  const m = (state.messages[chatId] || []).find((x) => x.id === msgId);
  if (!m) return null;
  m.text = text;
  save();
  emit('message-update', { chatId, message: m });
  return m;
}

function alertBot(state, groupChat, bot, type, text, save, emit) {
  bot.alert = {
    type,
    text: String(text || '').slice(0, 300),
    chatId: groupChat?.id || null,
    at: Date.now(),
  };
  emit('alert', {
    botId: bot.id,
    chatId: groupChat?.id || null,
    type: bot.alert.type,
    text: bot.alert.text,
  });
  save();
}

function looksLikePermission(text) {
  return /permission|approval|authorize|authorization|not permitted|access denied|external_directory|权限|授权|审批|拒绝访问/i.test(
    String(text || '')
  );
}

function looksLikeDecision(text) {
  return /(需要|请).{0,8}(老板|你).{0,8}(确认|决定|批准|授权|允许)|是否(允许|需要|继续)|要不要|需要你.{0,4}判断/i.test(
    String(text || '')
  );
}

// 群日志：每个 Bot 干了什么，所有人（包括 Bot）都能看到
export function addLog(chat, botId, action, text) {
  chat.log ||= [];
  chat.log.push({
    ts: Date.now(),
    botId: botId || null,
    action: String(action || '').slice(0, 40),
    text: String(text || '').slice(0, 300),
  });
  if (chat.log.length > 200) chat.log = chat.log.slice(-200);
}

function normName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\s\-_·.。:：'"“”‘’]/g, '')
    .trim();
}

// 模型经常把名字写成「open code工人」「OpenCode工人」「@OpenCode 工人」，
// 这里做归一化匹配：去空格/大小写/标点，再退到包含关系和编辑距离。
export function resolveBot(state, raw) {
  const target = String(raw || '').replace(/^@+/, '').trim();
  const n = normName(target);
  if (!n) return null;
  const bots = state.bots || [];

  const norm = (b) => normName(b.name);
  let hit = bots.find((b) => norm(b) === n || b.id === target);
  if (hit) return hit;

  hit = bots.find((b) => norm(b).includes(n) || n.includes(norm(b)));
  if (hit) return hit;

  // 编辑距离 <= 2 容错
  const dist = (a, b) => {
    const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
    for (let j = 1; j <= b.length; j++) dp[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        dp[i][j] = Math.min(
          dp[i - 1][j] + 1,
          dp[i][j - 1] + 1,
          dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
        );
      }
    }
    return dp[a.length][b.length];
  };
  let best = null;
  let bestD = Infinity;
  for (const b of bots) {
    const d = dist(n, norm(b));
    if (d < bestD) {
      bestD = d;
      best = b;
    }
  }
  return best && bestD <= 2 ? best : null;
}

function mentionTokens(state, bot) {
  const role = (state.roles || []).find((r) => r.id === bot.roleId);
  const list = [`@${bot.name}`];
  if (role?.abbr) list.push(`@${bot.name}（${role.abbr}）`, `@${bot.name}(${role.abbr})`);
  return list;
}

function findMentionedBots(state, chat, text) {
  const members = state.bots.filter((b) => chat.botIds.includes(b.id) && !b.hidden);
  const sorted = [...members].sort((a, b) => b.name.length - a.name.length);
  const hits = [];
  for (const b of sorted) {
    let best = null;
    for (const token of mentionTokens(state, b)) {
      const idx = text.indexOf(token);
      if (idx >= 0 && (!best || idx < best.index)) best = { bot: b, index: idx, token };
    }
    if (best) hits.push(best);
  }
  if (hits.length) return hits.sort((a, b) => a.index - b.index);
  const flat = normName(text);
  for (const b of sorted) {
    const idx = flat.indexOf(`@${normName(b.name)}`);
    if (idx >= 0) hits.push({ bot: b, index: idx, token: `@${b.name}` });
  }
  return hits.sort((a, b) => a.index - b.index);
}

function findMentionedBot(state, chat, text) {
  const hit = findMentionedBots(state, chat, text)[0];
  if (!hit) return null;
  return { bot: hit.bot, text: text.replace(hit.token, '').trim() };
}

function pickTarget(state, chat, text) {
  const leaderId = state.settings?.leaderId;
  const hit = findMentionedBot(state, chat, text);
  if (hit && hit.bot.id !== leaderId) return { bot: hit.bot, task: hit.text || text };

  // 领导是「我」的身份，群里不参与接单；只有和领导的私聊由它本人回复
  const members = state.bots.filter(
    (b) => chat.botIds.includes(b.id) && b.id !== leaderId
  );
  if (!members.length) {
    const leader = state.bots.find((b) => b.id === leaderId && chat.botIds.includes(b.id));
    return leader ? { bot: leader, task: text } : null;
  }
  const lead = members.find((b) => b.id === chat.leadId) || members[0];
  return lead ? { bot: lead, task: text } : null;
}

function memberLine(state, chat) {
  return state.bots
    .filter((b) => chat.botIds.includes(b.id))
    .map((b) => `${b.name}（${quotaLabel(b)}）`)
    .join('、');
}

function chatLogPrompt(state, chat) {
  const log = (chat.log || []).slice(-12);
  if (!log.length) return '';
  const lines = log.map((e) => {
    const who = e.botId ? state.bots.find((b) => b.id === e.botId)?.name || 'Bot' : '系统';
    const time = new Date(e.ts).toLocaleTimeString('zh-CN', { hour12: false });
    return `- ${time} ${who} ${e.action}：${e.text || ''}`;
  });
  return `群日志（最近，所有人共享）：\n${lines.join('\n')}`;
}

function messageSpeaker(state, m) {
  if (m.senderId === 'user') return '老板';
  return state.bots.find((b) => b.id === m.senderId)?.name || 'Bot';
}

// 只带最近几条文本，配合摘要使用；不把工具输出和历史全塞回去
function recentTranscript(state, chat, task, limit = 8, per = 400, uptoId = '') {
  let msgs = state.messages[chat.id] || [];
  if (uptoId) {
    const idx = msgs.findIndex((m) => m.id === uptoId);
    if (idx >= 0) msgs = msgs.slice(0, idx + 1);
  }
  msgs = msgs.filter((m) => m.type === 'text' && m.text && m.text !== task);
  return msgs
    .slice(-limit)
    .map((m) => {
      const text = String(m.text).replace(/\s+/g, ' ').trim();
      return `${messageSpeaker(state, m)}：${text.length > per ? `${text.slice(0, per)}…` : text}`;
    })
    .join('\n');
}

// 极速模式下，没有单独指定强度的聊天默认用 low，明显更快更省。
function effortForChat(state, chat) {
  const effort = chat?.effort || 'auto';
  if (state?.settings?.fastMode && (!effort || effort === 'auto')) return 'low';
  return effort;
}

function sessionPolicy(bot) {
  if (bot.backend === 'codex') return { maxInput: 120000, maxCalls: 10 };
  if (bot.backend === 'agy') return { maxInput: 180000, maxCalls: 12 };
  return { maxInput: 220000, maxCalls: 14 };
}

export function projectLabel(state, chat) {
  if (!chat || chat.type !== 'dm') return chat?.title || '项目';
  const bot = state.bots.find((b) => b.id === chat.botIds[0]);
  return `${bot?.name || 'Bot'} · ${chat.project || '默认项目'}`;
}

function agyHomeFor(state, bot) {
  if (!bot || bot.backend !== 'agy') return '';
  const p = (state.agyProfiles || []).find((x) => x.id === (bot.agyProfile || 'default'));
  return p?.home || '';
}

export function roleForChat(state, chat, bot) {  if (!chat || !bot) return null;
  let roleId = null;
  if (chat.type === 'group') roleId = chat.roleIds?.[bot.id] || null;
  else if (chat.linkedGroupId) {
    const group = state.chats.find((c) => c.id === chat.linkedGroupId);
    roleId = group?.roleIds?.[bot.id] || null;
  }
  if (!roleId) roleId = bot.roleId || null;
  if (!roleId) return null;
  return (state.roles || []).find((r) => r.id === roleId) || null;
}

function projectTranscript(state, chat, max = 6000) {
  const msgs = (state.messages[chat.id] || []).filter((m) => m.text && m.type !== 'system');
  const lines = msgs.slice(-60).map((m) => {
    const who =
      m.senderId === 'user'
        ? '老板'
        : state.bots.find((b) => b.id === m.senderId)?.name || 'Bot';
    return `${who}：${m.text}`;
  });
  const body = lines.join('\n');
  return body.length > max ? body.slice(-max) : body;
}

// 老板明确让某个 Bot 读别的项目时，把那个项目的记录带进本轮任务；默认不带。
export function collectReadProjects(state, currentChat, text) {
  const projects = state.chats.filter(
    (c) => c.type === 'dm' && c.id !== currentChat.id
  );
  const hits = [];
  const add = (c) => {
    if (c && c.id !== currentChat.id && !hits.some((h) => h.id === c.id)) hits.push(c);
  };

  const explicit = /读取项目[「"“]([^」"”\n]+)[」"”]/g;
  let m;
  while ((m = explicit.exec(text))) {
    const label = m[1].trim();
    add(projects.find((c) => projectLabel(state, c) === label));
    add(projects.find((c) => c.project === label));
  }

  const idRe = /@@READ\s+(chat_[a-zA-Z0-9]+)/g;
  while ((m = idRe.exec(text))) add(projects.find((c) => c.id === m[1]));

  const wantsRead = /(读取|读一下|读读|读下|看看|看一下|参考|了解|翻一下|查一下)/.test(text);
  if (wantsRead) {
    for (const c of projects) {
      const label = projectLabel(state, c);
      const name = c.project || '默认项目';
      if (text.includes(label) || (name.length >= 2 && text.includes(name))) {
        add(c);
      }
    }
    // 「读一下 DeepSeek 工人的项目」：没点名具体项目时，取该 Bot 最近的项目
    for (const bot of state.bots) {
      if (!text.includes(bot.name) || !/项目/.test(text)) continue;
      const latest = projects
        .filter((c) => c.botIds[0] === bot.id)
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
      add(latest);
    }
  }

  const picked = hits.slice(0, 3);
  return {
    names: picked.map((c) => projectLabel(state, c)),
    context: picked
      .map((c) => `【项目记录：${projectLabel(state, c)}】\n${projectTranscript(state, c)}`)
      .join('\n\n'),
  };
}

// 浏览器指令：@@BROWSER open https://...
export function parseBrowser(text) {
  const raw = String(text || '');
  const fileRe = /@@FILE[\s:：]+(open|find|read)\b([^\n]*)$/;
  const fm = raw.match(fileRe);
  if (fm) {
    return {
      clean: raw.slice(0, fm.index).trim(),
      command: { action: `file_${fm[1]}`, args: fm[2].trim() },
    };
  }
  const re = /@@BROWSER[\s:：]+(open|read|click|type|back|forward|reload)\b([^\n]*)$/;
  const m = raw.match(re);
  if (!m) return { clean: raw.trim(), command: null };
  const arg = m[2].trim();
  // 兜底：模型有时会把本地文件写成 @@BROWSER open file=xxx / file://xxx
  if (m[1] === 'open' && /^file:\/\//i.test(arg)) {
    let local = arg.replace(/^file:\/\//i, '');
    try {
      local = decodeURIComponent(local);
    } catch {}
    return {
      clean: raw.slice(0, m.index).trim(),
      command: { action: 'file_open', args: local },
    };
  }
  if (m[1] === 'open' && /^file=/i.test(arg)) {
    return {
      clean: raw.slice(0, m.index).trim(),
      command: { action: 'file_find', args: arg.replace(/^file=/i, '').trim() },
    };
  }
  return {
    clean: raw.slice(0, m.index).trim(),
    command: { action: m[1], args: arg },
  };
}

function browserActionLabel(cmd) {
  if (cmd.action === 'open') return `打开 ${cmd.args}`;
  if (cmd.action === 'read') return '读取当前页面';
  if (cmd.action === 'click') return `点击 ${cmd.args}`;
  if (cmd.action === 'type') return `输入 ${String(cmd.args).split('|||')[0].trim()}`;
  if (cmd.action === 'file_open') return `打开本地文件 ${cmd.args}`;
  if (cmd.action === 'file_find') return `查找并打开文件 ${cmd.args}`;
  if (cmd.action === 'file_read') return `读取本地文件 ${cmd.args}`;
  return cmd.action;
}

function browserResultTask(result) {
  if (!result || result.ok === false) {
    return `${result?.kind === 'file' ? '文件操作' : '浏览器操作'}失败：${
      result?.error || '未知错误'
    }。请向老板说明失败原因，或换个方式重试。`;
  }
  if (result.kind === 'file') {
    const files = (result.files || [])
      .slice(0, 12)
      .map((f) => `- ${f.path}`)
      .join('\n');
    return [
      '文件操作结果',
      result.path ? `已打开/读取: ${result.path}` : '',
      result.title ? `名称: ${result.title}` : '',
      files ? `匹配到的文件:\n${files}` : '',
      result.text || '',
    ]
      .filter(Boolean)
      .join('\n');
  }
  const links = (result.links || [])
    .slice(0, 20)
    .map((l) => `- ${l.text}: ${l.href}`)
    .join('\n');
  return [
    '浏览器结果',
    `URL: ${result.url}`,
    `标题: ${result.title}`,
    '正文:',
    String(result.text || '').slice(0, 8000),
    links ? `\n页面链接:\n${links}` : '',
  ].join('\n');
}

// 领导建团队：@@CREATE BOT 名字@@ 岗位说明 / @@CREATE GROUP 群名@@ 成员1、成员2
export function parseCreate(text) {
  let rest = String(text || '');
  const creates = [];
  const take = (re, type) => {
    let m;
    while ((m = rest.match(re))) {
      creates.push({ type, name: m[1].trim(), detail: (m[2] || '').trim() });
      rest = (rest.slice(0, m.index) + rest.slice(m.index + m[0].length)).trim();
    }
  };
  take(/@@CREATE\s+BOT[\s:：]+([^@\n]+?)\s*@@[\s:：]?([^\n]*)/i, 'bot');
  take(/@@CREATE\s+GROUP[\s:：]+([^@\n]+?)\s*@@[\s:：]?([^\n]*)/i, 'group');
  return { clean: rest.trim(), creates };
}

function findBotExact(state, name) {
  const n = normName(name);
  if (!n) return null;
  return (
    state.bots.find((b) => b.id === String(name).trim()) ||
    state.bots.find((b) => normName(b.name) === n) ||
    null
  );
}

function ensureBotGroupInState(state, rawName) {
  const name = String(rawName || '').trim().slice(0, 40);
  if (!name) return null;
  state.botGroups ||= [];
  let grp = state.botGroups.find((g) => g.name === name);
  if (!grp) {
    grp = { id: uid('bgrp'), name, collapsed: false, createdAt: Date.now() };
    state.botGroups.push(grp);
  }
  return grp;
}

function createBotByLeader(state, chat, name, persona) {
  const groupName =
    chat?.type === 'group' && chat.title
      ? chat.title
      : chat?.project && chat.project !== '默认项目'
        ? chat.project
        : '项目团队';
  const grp = ensureBotGroupInState(state, groupName);
  const bot = {
    id: uid('bot'),
    name: String(name || '新成员').slice(0, 40),
    emoji: '🙂',
    color: '#6c5ce7',
    backend: 'opencode',
    model: 'opencode-go/gpt-5.6-luna',
    source: 'OpenCode Go',
    billing: 'subscription',
    persona: String(persona || '').slice(0, 2000),
    quota: '',
    hidden: false,
    groupId: grp ? grp.id : null,
    memory: '',
    avatar: pickAvatar(state.bots.map((b) => b.avatar)),
    sessions: {},
    usage: emptyUsage(),
    createdAt: Date.now(),
  };
  normalizeSource(bot);
  bot.billing = defaultBilling(bot.source) || bot.billing;
  state.bots.push(bot);
  if (chat?.type === 'group' && !chat.botIds.includes(bot.id)) chat.botIds.push(bot.id);
  return bot;
}

function createGroupByLeader(state, title, memberText) {
  const leaderId = state.settings?.leaderId || null;
  const names = String(memberText || '')
    .split(/[、,，;；\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const botIds = [];
  const missing = [];
  for (const name of names) {
    const bot = findBotExact(state, name);
    if (bot && !botIds.includes(bot.id)) botIds.push(bot.id);
    else if (!bot) missing.push(name);
  }
  if (leaderId && !botIds.includes(leaderId)) botIds.push(leaderId);
  const workers = botIds.filter((id) => id !== leaderId);
  const chat = {
    id: uid('chat'),
    type: 'group',
    title: String(title || '新群聊').slice(0, 60),
    botIds,
    leadId: workers[0] || null,
    effort: 'auto',
    announcement: '',
    files: [],
    log: [],
    roleIds: {},
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  state.chats.push(chat);
  state.messages[chat.id] ||= [];
  ensureGroupProjects(state, chat);
  return { chat, missing };
}

function applyCreates({ state, chat, creates, bot }) {
  const made = [];
  const failed = [];
  for (const c of creates.slice(0, 4)) {
    if (c.type === 'bot') {
      if (!c.name) continue;
      if (findBotExact(state, c.name)) {
        failed.push(`Bot「${c.name}」已经存在`);
        continue;
      }
      const created = createBotByLeader(state, chat, c.name, c.detail);
      if (chat?.type === 'group') ensureGroupProjects(state, chat);
      addLog(chat, bot.id, '创建 Bot', `${created.name}${c.detail ? `（${c.detail}）` : ''}`);
      made.push(`Bot「${created.name}」已创建并加入本群`);
    } else if (c.type === 'group') {
      const { chat: created, missing } = createGroupByLeader(state, c.name, c.detail);
      addLog(chat, bot.id, '创建群聊', `${created.title}（${created.botIds.length} 位成员）`);
      made.push(`群聊「${created.title}」已创建`);
      if (missing.length) failed.push(`群聊里没找到：${missing.join('、')}`);
    }
  }
  return { made, failed };
}

// 领导可以 @@SEND 的目标：别的群 + 别的 Bot
function sendTargetList(state, chat, bot) {
  const groups = state.chats
    .filter((c) => c.type === 'group' && c.id !== chat.id)
    .map((c) => `群「${c.title}」`);
  const bots = state.bots
    .filter((b) => !b.hidden && b.id !== bot.id)
    .map((b) => `Bot「${b.name}」`);
  return [...groups, ...bots].join('、');
}

function shortText(v, n = 90) {
  return String(v || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, n);
}

function latestBotActivity(state, botId) {
  let best = null;
  for (const c of state.chats || []) {
    const inChat = c.type === 'group' ? c.botIds?.includes(botId) : c.botIds?.[0] === botId;
    if (!inChat) continue;
    const arr = state.messages?.[c.id];
    if (!arr?.length) continue;
    for (let i = arr.length - 1; i >= Math.max(0, arr.length - 20); i--) {
      const m = arr[i];
      if (m.senderId !== botId || !m.text) continue;
      if (!best || m.ts > best.ts) best = { ...m, chatTitle: c.title, chatType: c.type };
      break;
    }
  }
  return best;
}

// 团队状态每轮都要拼一次，但里面大多是运行态，5 秒内的结果够用。
const teamStatusCache = new WeakMap();
function buildTeamStatus(state) {
  const hit = teamStatusCache.get(state);
  if (hit && Date.now() - hit.at < 5000) return hit.text;
  const lines = [];
  for (const c of (state.chats || []).filter((x) => x.type === 'group')) {
    const target = state.bots.find((b) => b.id === c.loopTargetId);
    const text = c.loop
      ? `持续运行中 · 第 ${c.loopRound || 0} 轮${target ? ` · ${target.name} 牵头` : ''}${
          c.draining ? ' · 收尾模式' : ''
        }`
      : c.draining
        ? '收尾模式 · 未自动运行'
        : '未开启持续运行';
    lines.push(`群「${c.title}」：${text}`);
  }
  for (const b of (state.bots || []).filter((x) => !x.hidden)) {
    const rt = state.__runtime?.get?.(b.id);
    let status = '空闲';
    if (rt?.running) {
      status = rt.queued ? '排队中' : `正在工作${rt.chatTitle ? ` · ${rt.chatTitle}` : ''}`;
    } else if (b.alert) {
      status = `需要处理：${shortText(b.alert.text, 60)}`;
    } else if (rt?.lastError) {
      status = `上次出错：${shortText(rt.lastError, 60)}`;
    }
    const act = latestBotActivity(state, b.id);
    const task = rt?.running && rt.task ? ` · 当前任务：${shortText(rt.task, 110)}` : '';
    const last = act
      ? ` · 最近 ${new Date(act.ts).toLocaleTimeString('zh-CN', {
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        })}：${shortText(act.text, 60)}`
      : '';
    lines.push(`- ${b.name}：${status}${task}${last}`);
  }
  const text = lines.join('\n');
  teamStatusCache.set(state, { at: Date.now(), text });
  return text;
}

// 群文件里通常放着工作日志/进度清单。流程环节除了给路径，再自动摘录最近一段，
// 避免 Bot 明明有日志却跳过它、跑去翻其他 Bot 的目录。
const digestCache = new Map(); // chatId -> { sig, text }
function groupFileDigest(chat, maxChars = 3000) {
  const files = (chat?.files || []).filter((f) => /\.(md|txt)$/i.test(f.name || ''));
  if (!files.length) return '';
  // 文件没变就直接复用上次的摘录，避免每个环节都重新读一遍日志。
  const sigParts = [];
  for (const f of files) {
    const p = path.join(GROUPS_DIR, chat.id, 'files', f.file || f.name);
    let st = null;
    try {
      st = fs.statSync(p);
    } catch {}
    sigParts.push(`${f.name}@${st ? `${st.size}:${st.mtimeMs}` : 'missing'}`);
  }
  const sig = `${maxChars}|${sigParts.join('|')}`;
  const hit = digestCache.get(chat.id);
  if (hit && hit.sig === sig) return hit.text;

  let budget = maxChars;
  const out = [];
  for (const f of files) {
    if (budget <= 0) break;
    try {
      const p = path.join(GROUPS_DIR, chat.id, 'files', f.file || f.name);
      const text = fs.readFileSync(p, 'utf8').trim();
      if (!text) continue;
      const limit = Math.min(1400, budget);
      const body = text.length > limit ? `…${text.slice(-limit)}` : text;
      out.push(`【${f.name} · 最近内容】\n${body}`);
      budget -= Math.min(limit, text.length);
    } catch {}
  }
  const text = out.join('\n\n');
  digestCache.set(chat.id, { sig, text });
  return text;
}

// 提示词分成两段：前面是稳定的身份/规则（每轮完全一致，便于模型做前缀缓存），
// 后面是这一轮才会变的内容。agents.mjs 里的 Anthropic 直连会按这个标记切开，
// 给稳定段加 cache_control。
const CTX_MARK = '【本轮上下文】';

function buildPrompt({ state, chat, bot, task, attachments = [], fromName, lean = false, uptoId = '' }) {
  const role = roleForChat(state, chat, bot);
  const ownMemory = (readMemory(bot.id) || bot.memory || '').trim();
  const memory = [role?.memory || '', ownMemory].filter(Boolean).join('\n\n').trim();
  const voice = state.settings?.voice;
  const voiceLine =
    voice?.enabled !== false
      ? `和老板说话时，称呼老板为「${voice?.address || '主人'}」。说话风格：${
          voice?.style || '俏皮、可爱、活泼、黏人，像在撒娇的小少女'
        }。风格是外层，事实、判断和交付内容必须保持清楚准确。`
      : '';
  const isGroup = chat.type === 'group';
  const fast = !!state.settings?.fastMode;
  const recent = recentTranscript(state, chat, task, fast ? 4 : 8, fast ? 200 : 400, uptoId);
  const isLeader = state.settings?.leaderId === bot.id;
  const perm = mergePermissions(bot.permission, chat.permission);
  const linkedGroup =
    !isGroup && chat.linkedGroupId
      ? state.chats.find((c) => c.id === chat.linkedGroupId && c.type === 'group')
      : null;
  // 技能可以在职位、Bot、群聊三处配置，取并集注入提示词。
  const skillsChat = isGroup ? chat : linkedGroup;
  const skills = [
    ...new Set(
      [...(role?.skills || []), ...(bot.skills || []), ...(skillsChat?.skills || [])]
        .map((x) => String(x || '').trim())
        .filter(Boolean)
    ),
  ];
  const permissionLine =
    perm.mode === 'full'
      ? '权限范围：老板已授权你访问本机任意目录（含读写和命令）。'
      : perm.mode === 'custom'
        ? [
            perm.write.length ? `可读写目录：${perm.write.join('、')}` : '',
            perm.read.length ? `只读目录：${perm.read.join('、')}` : '',
            '其他目录不要访问；工作区始终可读写。',
          ]
            .filter(Boolean)
            .join('；')
        : '权限范围：只能访问当前工作区；不要读写工作区以外的目录。';
  const colleagues = state.bots
    .filter((b) => b.id !== bot.id && (isGroup ? chat.botIds.includes(b.id) : true))
    .map((b) => b.name)
    .join('、');
  const targets = isLeader ? sendTargetList(state, chat, bot) : '';
  const teamStatus = isLeader && !fast ? buildTeamStatus(state) : '';
  const adminLine = isLeader
    ? [
        '【Bot Team 管理员权限】',
        '你是这个软件的总管理员，可以直接管理所有 Bot、群、职位、项目、模型、头像、壁纸和持续运行。',
        `管理手册：${process.env.BOT_TEAM_ADMIN_FILE || '(未设置)'}（改软件前先读：cat "$BOT_TEAM_ADMIN_FILE"）`,
        'CLI：node "$BOT_TEAM_CLI" status / bots / chats / roles / projects / runtime / logs',
        '创建/修改：node "$BOT_TEAM_CLI" post|patch|delete <path> [json|@file]',
        '收尾：@@DRAIN 群名@@ 要求；改完必须再 get 验证，并把 id/名称/结果告诉老板。',
        '群流程图：node "$BOT_TEAM_CLI" workflow <群id> @/tmp/flow.json（schema 见手册），workflow-run/stop 运行/停止。',
        '删除 Bot/群/职位、清空消息、改 leaderId 只有老板明确要求才做；shell 不可用时先说明权限不足，不要假装完成。',
        '【流程设计规范】',
        String(bot.flowDesignRules || '').trim() || DEFAULT_FLOW_DESIGN_RULES,
      ].join('\n')
    : '';
  const leaderRules = isLeader
    ? [
        '你是这个团队的领导知柚，负责拆目标、分派、验收、汇总。',
        '除了回答老板，你还可以：',
        '· 在当前聊天里把任务交给同事：@@DELEGATE 同事名@@ 任务',
        '· 给别的群或别的 Bot 发消息：@@SEND 目标1、目标2@@ 消息内容',
        '  目标写群名或 Bot 名；发到群里时，如果消息里 @ 了某个成员，它会接着处理。',
        '· 老板说「暂停 / 先停一下 / 等我回来再跑」时，执行 node "$BOT_TEAM_CLI" workflow-pause <chatId>：当前环节做完后暂停，进度保留；等老板说「继续」再用 workflow-resume 接上。不要用 workflow-stop 代替暂停。',
        '· 收到【工作流停止审查 · 强制】时，必须判断是正常完成还是异常中断：正常就核对最后一步交付后简短回报；异常就排查原因并执行 bt workflow-resume <chatId> 推动继续，不能忽略、不能只解释不行动。',
        '· 收到【Bot 异常报告 · 自动调度】或【工作流停滞告警 · 强制】时，必须立刻排查并动手解决（不要只发消息解释）：额度不足 / 鉴权失败 / 连续报错时，先跑 node "$BOT_TEAM_CLI" models 找可用替代模型，再用 node "$BOT_TEAM_CLI" patch /api/bots/<botId> 切换模型或替换流程环节负责人；流程停滞/假运行时，先查 node "$BOT_TEAM_CLI" chats 和 status 定位卡点，修正后用 workflow-stop + workflow-resume 或直接 workflow-resume 恢复。只有在没有可用备用模型或必须老板决策时才汇报老板。',
        '· 老板说「续上 / 从断的地方继续 / 接着跑」时，执行 node "$BOT_TEAM_CLI" workflow-resume <chatId>；它会从断点接上，已完成的环节不重跑。只有老板说「从头开始 / 重新跑」才用 workflow-run。',
        '· 老板说「把某群的流程开起来 / 继续跑 / 重启流程」时，必须真的启动：先拿到群 ID（bt chats 或【定位】里的 chatId），再执行 node "$BOT_TEAM_CLI" workflow-run <chatId>；不要只发消息让成员接着干。',
        '· 老板要流程图时，执行 node "$BOT_TEAM_CLI" workflow-export <chatId>，把它返回的 path 原样写在回复里。',
        '· 老板让你装某个技能时，执行 node "$BOT_TEAM_CLI" skill-install <GitHub链接> --bot <botId> 或 --group <chatId>；会安装并自动加到目标。',
        '· 老板让你「建团队 + 设计流程 + 跑起来」，要一次做完，用 CLI 拿 ID：bt new-bot 建成员（务必带 --group "<项目组名>" 把同项目 Bot 归到同一文件夹）→ bt new-group 建群 → bt workflow <chatId> @/tmp/flow.json 保存 → bt workflow-run <chatId> 启动 → bt workflow-export <chatId> 导出，最后汇报路径和当前进度。可用 bt set-group <Bot名> <组名> 调整分组。',
        '· 需要新建「只要文字、要快」的 Bot 时，用直连 API：bt new-bot "名字" "岗位" --backend custom --provider deepseek --model deepseek-flash。Key 已经存在本机提供商里，绝对不要把 Key 写进聊天或日志，也不要向老板索要。',
        '· 建 Bot 和排流程时要自己选后端和模型：先跑 bt models 看可用模型；要读文件/跑命令/抓网页的环节必须有工具（codex / opencode / agy），只看文本的批量活可以用 custom 省钱；看截图和长文档用 agy；工程改造用 codex。新建成员时用 --backend / --model 指定，回复里一句话说明分工理由。',
        '· 收尾某个群：@@DRAIN 群名@@ 收尾要求',
        '  系统会切到收尾模式：不再生产新内容，只上传已完成批次，完成后自动停止。',
        '  只有老板明确要求查看/协调/收尾时才用 @@SEND 或 @@DRAIN，不要自己决定群发。',
        '· 老板让你查看谁在干活、协调或收尾时，先看下面的【团队实时状态】，直接给结论和行动，不要推给别的 Bot 去查。',
        '· 老板让你新建员工：@@CREATE BOT 名字@@ 岗位说明',
        '· 老板让你新建群聊：@@CREATE GROUP 群名@@ 成员1、成员2',
        '  新建 Bot 会自动加入当前群；成员用现有 Bot 的名字。',
        '  只有老板明确要求时才创建，不要自己扩张团队。',
        targets ? `可用目标：${targets}` : '',
      ]
        .filter(Boolean)
        .join('\n')
    : '';

  // 流程环节用轻量提示词：只带岗位、记忆、群公告和本环节任务，
  // 不带最近聊天、群日志、团队状态、管理指令，避免每步重复读大量上下文。
  if (lean) {
    return [
      `你是「${bot.name}」，一个 AI 员工。`,
      role
        ? `你的职位：${role.name}。\n岗位说明：${role.persona || ''}`
        : bot.persona
          ? `你的岗位说明：${bot.persona}`
          : '',
      role && bot.persona ? `个人补充：${bot.persona}` : '',
      skills.length ? `可用技能（支持就直接调用）：${skills.join('、')}` : '',
      bot.backend === 'custom' && bot.customTools !== false
        ? '你可以调用本机工具：list_dir、read_file、write_file、run_command、find_files。需要看/改文件或执行命令时直接调用工具，结果以工具实际返回为准，不要假装做过。'
        : '',
      voiceLine,
      permissionLine,
      bot.billing === 'payg' ? '注意：你按量计费，回答尽量简洁，不要重复无关内容。' : '',
      '输出习惯：',
      '1. 提到网页、文档、项目时用 markdown 链接，例如 [项目主页](https://example.com)，不要只贴裸网址。',
      '2. 生成了本地文件，就把它的绝对路径写在回复里（一行一个）；界面会自动显示成可打开的文件卡片。',
      '流程执行纪律：',
      '1. 只执行当前环节，直接给结果和证据，不要客套，不要复述任务。',
      '2. 先看群公告，再读 group-files 里的群文件（工作日志/清单就在里面），然后开始做；不要翻其他 Bot 的目录或记忆。',
      '3. 群公告、工作日志和线上最新状态优先于任务里写死的旧版本号；发现不一致时先说明以哪个为准。',
      '4. 不要转交、不要创建或删除 Bot/群。',
      '5. 没做的事不要说做完了。不确定就写“不确定”。',
      '6. 用中文，简洁。',
      '7. 只输出最终中文回复，不要把内部分析、计划、英文思考写进回复；推理过程由系统单独展示。',
      memory ? `长期记忆：\n${memory.slice(0, 800)}` : '',
      isGroup && chat.announcement
        ? `群公告（所有人都要遵守，优先按这里说的做）：\n${String(chat.announcement).slice(
            0,
            4000
          )}`
        : '',
      CTX_MARK,
      isGroup && chat.files?.length
        ? [
            `群文件（工作日志就是其中之一）已同步到：${path.join(
              botWorkspace(bot.id),
              'group-files'
            )}`,
            ...chat.files.map(
              (f) => `- ${f.name}${f.size ? `（${Math.max(1, Math.round(f.size / 1024))} KB）` : ''}`
            ),
            '需要背景、进度、日志或清单时，先读这里的文件；不要读取其他 Bot 的工作区或记忆。',
            groupFileDigest(chat)
              ? `群文件里的工作日志/清单自动摘录（只截取最近部分，完整内容请读上面的文件）：\n${groupFileDigest(
                  chat
                )}`
              : '',
          ]
            .filter(Boolean)
            .join('\n')
        : '',
      fromName === '用户' ? '老板对你说：' : `${fromName} 对你说：`,
      task,
    ]
      .filter((x) => x !== '')
      .join('\n');
  }

  return [
    `你是「${bot.name}」，一个 AI 员工。`,
    role
      ? `你的职位：${role.name}。\n岗位说明：${role.persona || ''}`
      : bot.persona
        ? `你的岗位说明：${bot.persona}`
        : '',
    role && bot.persona ? `个人补充：${bot.persona}` : '',
    skills.length ? `可用技能（支持就直接调用）：${skills.join('、')}` : '',
    bot.backend === 'custom' && bot.customTools !== false
      ? '你可以调用本机工具：list_dir、read_file、write_file、run_command、find_files。需要看/改文件或执行命令时直接调用工具，结果以工具实际返回为准，不要假装做过。'
      : '',
    voiceLine,
    permissionLine,
    colleagues ? `你的同事：${colleagues}。需要他们接手时，用下面的转交格式，系统会转交。` : '',
    bot.billing === 'payg' ? '注意：你按量计费，回答尽量简洁，不要重复无关内容。' : '',
    isGroup
      ? `你所在的群：${chat.title}。群成员：${memberLine(state, chat)}。`
      : linkedGroup
        ? `你正在和老板私聊。这个项目和群聊「${linkedGroup.title}」共享记忆，群公告和群文件同样适用。`
        : '你正在和老板私聊。',
    adminLine,
    leaderRules,
    '工作纪律：',
    '1. 直接给结论、结果、证据，不要客套话，不要复述任务。',
    '2. 你只能看到自己被派到的这一段，不需要假装知道整件事的全貌。',
    '3. 这件事你干不了、或者更适合别人时，在回答最后单独一行输出：',
    '   @@DELEGATE 同事名@@ 一句话说清交付物',
    '   名字必须用上面「你的同事」里的原名；一次最多转交一个人；能自己做的不要转交。',
    '4. 不要尝试调用工具、命令或其他程序去联系同事；转交只能通过 @@DELEGATE 这一行。',
    '5. 没做的事不要说做完了。不确定就写“不确定”。',
    '6. 用中文，简洁。',
    '7. 只输出最终中文回复，不要把内部分析、计划、英文思考写进回复；推理过程由系统单独展示。',
    '输出习惯：',
    '- 提到网页、文档、项目时，用 markdown 链接写出来，例如 [项目主页](https://example.com)；不要只贴裸网址。',
    '- 生成了本地文件，就在回复里写出它的绝对路径（一行一个）；界面会自动显示成可打开的文件卡片。',
    '你可以使用右侧面板（老板能看见）。需要看网页时，在回复最后单独一行输出：',
    '   @@BROWSER open https://example.com',
    '   @@BROWSER read （读取当前页面）',
    '   @@BROWSER click <css 选择器>',
    '   @@BROWSER type <css 选择器> ||| 要输入的文字',
    '需要打开本地文件时，用 @@FILE，不要用浏览器：',
    '   @@FILE open /绝对路径',
    '   @@FILE find 文件名（不知道路径时，系统会去桌面/文档/下载等处找并打开第一个）',
    '   @@FILE read /绝对路径（把文本内容返回给你）',
    '系统会执行并把页面正文/文件内容返回给你；一次只写一条，不要编造内容。没有工具权限时，也可以先让老板给你完整路径。',
    memory ? `长期记忆：\n${memory.slice(0, fast ? 600 : 2400)}` : '',
    !fast && chat.contextSummary
      ? `此前对话的摘要（更早的消息已压缩）：\n${chat.contextSummary.slice(0, 2000)}`
      : '',
    isGroup && chat.announcement
      ? `群公告（所有人都要遵守）：\n${String(chat.announcement).slice(0, 1500)}`
      : '',
    CTX_MARK,
    recent ? `最近对话（用于接续，不要复述）：\n${recent}` : '',
    teamStatus ? `【团队实时状态】（每次回答前更新，供你协调）\n${teamStatus}` : '',
    isGroup && chat.files?.length
      ? `群文件（已放在工作区 group-files/ 目录）：${chat.files.map((f) => f.name).join('、')}`
      : '',
    isGroup && !fast ? chatLogPrompt(state, chat) : '',
    linkedGroup && linkedGroup.announcement
      ? `关联群公告：\n${String(linkedGroup.announcement).slice(0, 1500)}`
      : '',
    linkedGroup && linkedGroup.files?.length
      ? `关联群文件（已放在工作区 group-files/）：${linkedGroup.files.map((f) => f.name).join('、')}`
      : '',
    isGroup && chat.draining
      ? `【收尾模式】${chat.drainNote || '不要再生产新内容；把已完成的交给调度 Bot 上传；完成后输出 @@DONE。'}`
      : '',
    attachments.length
      ? `老板发来的附件（已复制到工作区，可以直接读取）：\n${attachments
          .map((a) => `- ${a.name}：${a.path}`)
          .join('\n')}`
      : '',
    fromName === '用户' ? '老板对你说：' : `${fromName} 对你说：`,
    task,
  ]
    .filter((x) => x !== '')
    .join('\n');
}

export function parseDelegation(text, state) {
  // 只认「单独一行」的 @@DELEGATE 同事名@@ 任务，避免把提示词示例、
  // 模型解释规则时引用的『@@DELEGATE 同事名@@』误当成真的转交。
  const re = /(?:^|\n)\s*[-*·]?\s*@@DELEGATE[\s:：]+([^\n@]+?)\s*@@\s*([\s\S]*)$/;
  const m = String(text || '').match(re);
  if (!m) return { clean: String(text || '').trim(), delegation: null };
  const rawName = String(m[1] || '').trim();
  const task = String(m[2] || '').trim();
  const clean = String(text || '').slice(0, m.index).trim();
  const name = rawName.replace(/^[「『"'“”‘’]|[」』"'“”‘’]$/g, '').trim();
  // 名字里带引号、标点或长得像一段解释时，大概率不是转交指令。
  const looksLikeQuote =
    !name ||
    name.length > 24 ||
    /["'“”‘’`]/.test(rawName) ||
    /[:：。.!?？！，,；;]/.test(name) ||
    /\s{2,}|\n/.test(name) ||
    /^(the |this |that |it |system|prompt|instruction|rule|task|previous|actually|wait|here|let |i )/i.test(name);
  if (looksLikeQuote) return { clean: String(text || '').trim(), delegation: null };
  if (!resolveBot(state, name)) {
    return { clean, delegation: task ? { to: name, task } : null, unresolvable: true };
  }
  return { clean, delegation: task ? { to: name, task } : null };
}

function parseDrain(text) {
  const re = /@@DRAIN[\s:：]+([^@\n]+?)\s*@@\s*([\s\S]*)$/;
  const m = String(text || '').match(re);
  if (!m) return { clean: String(text || '').trim(), drain: null };
  return {
    clean: String(text || '').slice(0, m.index).trim(),
    drain: { to: m[1].trim(), note: m[2].trim() },
  };
}

function parseDone(text) {
  const hit = /@@(DONE|STOP)\b/i.test(text);
  return {
    done: hit,
    clean: String(text || '').replace(/@@(DONE|STOP)\b/gi, '').trim(),
  };
}

// 领导的跨会话指令：@@SEND 目标1、目标2@@ 内容
export function parseSend(text) {
  const re = /@@SEND[\s:：]+([^@\n]+?)\s*@@\s*([\s\S]*)$/;
  const m = text.match(re);
  if (!m) return { clean: text.trim(), sends: null };
  const targets = m[1]
    .split(/[、,，;；|]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const body = m[2].trim();
  const clean = text.slice(0, m.index).trim();
  return { clean, sends: body && targets.length ? { targets, body } : null };
}

// 模型可能把目标写成「群『作战室』」「Bot「Codex 工人」」，这里去掉包装
export function cleanTargetName(s) {
  return String(s || '')
    .replace(/^(群聊|群|Bot|bot)\s*[「“"'']?/, '')
    .replace(/[」”"'']$/, '')
    .trim();
}

// 把领导的一条消息投递到目标群/目标 Bot（目标 Bot 会接着回复）
async function applySends({ state, chat, leader, sends, save, emit, browser }) {
  const sent = [];
  for (const rawName of sends.targets.slice(0, 5)) {
    const name = cleanTargetName(rawName);
    const group = state.chats.find(
      (c) => c.type === 'group' && normName(c.title) === normName(name)
    );
    const bot = group ? null : resolveBot(state, name);

    if (!group && !bot) {
      const sys = addMessage(state, chat.id, {
        type: 'system',
        text: `发消息失败：找不到「${name}」`,
      });
      save();
      emit('message', { chatId: chat.id, message: sys });
      continue;
    }
    if (bot && bot.id === leader.id) {
      const sys = addMessage(state, chat.id, {
        type: 'system',
        text: `发消息失败：不能给自己发消息`,
      });
      save();
      emit('message', { chatId: chat.id, message: sys });
      continue;
    }

    if (group) {
      const m = addMessage(state, group.id, {
        senderId: leader.id,
        text: sends.body,
        meta: { quota: quotaLabel(leader), usage: null, relayed: true },
      });
      save();
      emit('message', { chatId: group.id, message: m });

      const hits = findMentionedBots(state, group, sends.body);
      if (hits.length) {
        await Promise.allSettled(
          hits.map((hit) =>
            runTurnInternal({
              state,
              chat: group,
              bot: hit.bot,
              task: hits.length === 1 ? sends.body.replace(hit.token, '').trim() || sends.body : sends.body,
              fromName: leader.name,
              save,
              emit,
              allowSend: false,
              browser,
            })
          )
        );
      }
      sent.push(name);
      continue;
    }

    let dm = state.chats
      .filter((c) => c.type === 'dm' && c.botIds.length === 1 && c.botIds[0] === bot.id)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
    if (!dm) {
      dm = {
        id: uid('chat'),
        type: 'dm',
        title: bot.name,
        project: '默认项目',
        botIds: [bot.id],
        leadId: bot.id,
        effort: 'auto',
        createdAt: Date.now(),
      };
      state.chats.push(dm);
      save();
      emit('chats', { chats: state.chats });
    }

    const m = addMessage(state, dm.id, {
      senderId: leader.id,
      text: sends.body,
      meta: { quota: quotaLabel(leader), usage: null, relayed: true },
    });
    save();
    emit('message', { chatId: dm.id, message: m });

    await runTurnInternal({
      state,
      chat: dm,
      bot,
      task: sends.body,
      fromName: leader.name,
      save,
      emit,
      allowSend: false,
      browser,
    });
    sent.push(name);
  }

  if (sent.length) {
    const receipt = addMessage(state, chat.id, {
      type: 'system',
      text: `已发送到：${sent.join('、')}`,
    });
    save();
    emit('message', { chatId: chat.id, message: receipt });
  }
}

function copyAttachments(bot, attachments) {
  const list = Array.isArray(attachments) ? attachments : [];
  if (!list.length) return [];
  const dir = path.join(botWorkspace(bot.id), 'attachments');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {}
  const out = [];
  for (const a of list) {
    const srcName = path.basename(String(a.url || ''));
    const src = path.join(UPLOADS_DIR, 'files', srcName);
    if (!fs.existsSync(src)) continue;
    let name = String(a.name || srcName).replace(/[\\/:*?"<>|]/g, '_').slice(-120) || srcName;
    let dest = path.join(dir, name);
    let i = 1;
    const base = name;
    const dot = base.lastIndexOf('.');
    while (fs.existsSync(dest)) {
      name = dot > 0 ? `${base.slice(0, dot)}-${i}${base.slice(dot)}` : `${base}-${i}`;
      dest = path.join(dir, name);
      i += 1;
    }
    try {
      fs.copyFileSync(src, dest);
      out.push({ name: a.name || name, path: dest, mime: a.mime || '', url: a.url });
    } catch {}
  }
  return out;
}

// 群文件同步到每个 Bot 自己的工作区。普通聊天和流程环节都必须先同步，
// 否则流程里的 Bot 会看到空工作区，转而去翻别的 Bot 的目录。
function syncGroupFiles(state, chat, bot) {
  const fileChat =
    chat.type === 'group'
      ? chat
      : chat.linkedGroupId
        ? state.chats.find((c) => c.id === chat.linkedGroupId)
        : null;
  if (!fileChat?.files?.length) return '';
  const dir = path.join(botWorkspace(bot.id), 'group-files');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {}
  // 用清单记住上次同步时的 size/mtime，没变就不重复复制。
  const manifestPath = path.join(dir, '.sync.json');
  let manifest = {};
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) || {};
  } catch {}
  let dirty = false;
  for (const f of fileChat.files) {
    const src = path.join(GROUPS_DIR, fileChat.id, 'files', f.file || f.name);
    const dst = path.join(dir, f.name);
    try {
      const st = fs.statSync(src);
      const sig = `${st.size}:${st.mtimeMs}`;
      if (manifest[f.name] === sig && fs.existsSync(dst)) continue;
      fs.copyFileSync(src, dst);
      manifest[f.name] = sig;
      dirty = true;
    } catch {}
  }
  if (dirty) {
    try {
      fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    } catch {}
  }
  return dir;
}

// 私聊委派：把任务排到目标 Bot 自己的项目，跑完再把最终交付回报到发起人的聊天窗。
// 不占用发起人的会话队列，领导把活派出去后可以立刻继续对话。
function scheduleDelegatedTurn({
  state,
  fromChat,
  targetChat,
  fromBot,
  toBot,
  task,
  chain = 0,
  save,
  emit,
  browser,
}) {
  return runInChatQueue(targetChat.id, async () => {
    const startedAt = Date.now();
    try {
      await runTurnInternal({
        state,
        chat: targetChat,
        bot: toBot,
        task,
        fromName: fromBot?.name || '同事',
        save,
        emit,
        allowSend: false,
        browser,
        chain: chain + 1,
      });
    } catch {}

    // 只回报这一轮真正产生的那条最终消息，避免把历史消息重复贴过去。
    const msgs = state.messages[targetChat.id] || [];
    const last = [...msgs]
      .reverse()
      .find((m) => m.type === 'text' && m.senderId === toBot.id && m.ts >= startedAt - 1000);
    if (!last) return;
    const report = addMessage(state, fromChat.id, {
      senderId: toBot.id,
      text: last.text,
      meta: {
        quota: last.meta?.quota || null,
        usage: last.meta?.usage || null,
        credits: last.meta?.credits,
        creditUnit: last.meta?.creditUnit,
        creditsEstimated: last.meta?.creditsEstimated,
        creditCost: last.meta?.creditCost,
        mirrored: true,
        fromBot: toBot.name,
        groupTitle: fromChat.title,
      },
    });
    save();
    emit('message', { chatId: fromChat.id, message: report });
  });
}

async function runTurnInternal({ state, chat, bot, task, attachments = [], fromName, save, emit, allowSend = false, browser, signal, uptoId = '', chain = 0 }) {
  let current = bot;
  let currentTask = task;
  let currentFrom = fromName;
  let hops = 0;

  syncGroupFiles(state, chat, bot);

  while (current && hops <= MAX_HOPS) {
    if (signal?.aborted) break;
    const runningBot = current;
    const attached = copyAttachments(current, attachments);
    let liveThink = null;
    let thinkBuf = '';
    let lastThinkAt = 0;
    const startedAt = Date.now();
    let lastPreviewAt = 0;
    let liveLog = '';
    // 过程/思考写到哪里：群聊是关联项目；私聊里被委派的 Bot 写回自己的项目。
    // chain > 0 表示这是“别人派给我的活”，此时连自己的私聊也显示过程（老板要看得见在干什么）。
    const procTarget = chain > 0 ? chat : processChatFor(state, chat, runningBot);
    const emitStatus = (extra = {}) =>
      emit('status', {
        chatId: chat.id,
        botId: runningBot.id,
        name: runningBot.name,
        running: true,
        chatTitle: chat.title,
        task: currentTask.slice(0, 300),
        startedAt,
        ...extra,
      });
    const pushPreview = (text, extra = {}) => {
      const value = String(text || '').replace(/\s+/g, ' ').trim();
      if (!value) return;
      if (Date.now() - lastPreviewAt < 350) return;
      lastPreviewAt = Date.now();
      emitStatus({ preview: value.slice(-90), ...extra });
    };
    emitStatus();
    try {
      let res = null;
      let botTask = currentTask;
      let botFrom = currentFrom;
      let browserSteps = 0;
      let creditsTotal = 0;
      let creditsEstimated = false;

      while (true) {
        const prompt = buildPrompt({
          state,
          chat,
          bot: current,
          task: botTask,
          attachments: attached,
          fromName: botFrom,
          uptoId,
        });
        const sessionKey = chat.linkedGroupId || chat.id;
        let session = current.sessions?.[sessionKey]?.id || null;
        const policy = sessionPolicy(current);
        const sessMeta = current.sessions?.[sessionKey];
        if (
          session &&
          ((sessMeta.calls || 0) >= policy.maxCalls ||
            (sessMeta.lastInput || 0) >= policy.maxInput)
        ) {
          delete current.sessions[sessionKey];
          session = null;
          if (chat.type === 'group') {
            addProcess(
              state,
              chat,
              current,
              '记忆窗口已轮换：保留摘要和最近对话，开启新会话以控制 token 和响应时间。',
              save,
              emit
            );
          }
        }
        const onProgress = (p) => {
          if (p.type === 'step') {
            const label = `执行：${p.tool}${p.title ? ` · ${p.title}` : ''}`;
            liveLog += (liveLog ? '\n' : '') + label;
            if (procTarget) addProcess(state, chat, current, label, save, emit, 'process', procTarget);
            pushPreview(label, { step: label, live: liveLog.slice(-4000) });
          } else if (p.type === 'thinking' && p.text) {
            thinkBuf += (thinkBuf ? '\n' : '') + p.text;
            if (procTarget) {
              if (!liveThink) {
                liveThink = addProcess(
                  state,
                  chat,
                  current,
                  '正在思考…',
                  save,
                  emit,
                  'thinking',
                  procTarget
                );
              }
              if (liveThink && Date.now() - lastThinkAt > 500) {
                lastThinkAt = Date.now();
                updateProcessMessage(state, liveThink.chatId, liveThink.id, thinkBuf, save, emit);
              }
            }
            pushPreview(thinkBuf, { thinking: thinkBuf.slice(-200), live: thinkBuf.slice(-4000) });
          } else if (p.type === 'text' && p.text) {
            pushPreview(p.text);
          }
        };
        const queueKey = `${current.id}::${sessionKey}`;
        const queued = botQueues.has(queueKey);
        if (queued) {
          emitStatus({ queued: true });
          addProcess(
            state,
            chat,
            current,
            `收到新任务，但上一条任务还在跑，这条先排队等待：${currentTask.slice(0, 180)}`,
            save,
            emit,
            'process',
            procTarget
          );
        }
        const onStart = () => {
          emitStatus({ queued: false });
          addProcess(
            state,
            chat,
            current,
            `开始处理：${currentTask.slice(0, 220)}`,
            save,
            emit,
            'process',
            procTarget
          );
        };
        res = await queueBotRun(
          queueKey,
          () =>
            runBot({
              bot: current,
              prompt,
              sessionId: session,
              cwd: botWorkspace(current.id),
              effort: effortForChat(state, chat),
              permission: mergePermissions(current.permission, chat.permission),
              attachments: attached,
              agyHome: agyHomeFor(state, current),
              onProgress,
              signal,
              apiKey: state.providerKeys?.[`botapi:${current.id}`] || '',
              timeoutMs: botTimeoutMs(current),
            }),
          onStart
        );

        if (signal?.aborted || res.aborted) return;

        current.sessions ||= {};
        if (res.sessionId) {
          const prev = current.sessions[sessionKey] || {};
          current.sessions[sessionKey] = {
            id: res.sessionId,
            backend: current.backend,
            lastInput: Number(res.usage?.input ?? res.usage?.input_tokens ?? 0) || prev.lastInput || 0,
            calls: (prev.calls || 0) + 1,
          };
        }
        current.usage = addUsage(current.usage, res.usage, current.backend);
        const creditInfo = creditsForRun({
          backend: current.backend,
          model: current.model,
          usage: res.usage,
          credits: res.credits,
          settings: state.settings,
        });
        if (creditInfo) {
          creditsTotal += creditInfo.credits;
          creditsEstimated = creditsEstimated || creditInfo.estimated;
        }
        recordUsage(state, {
          bot: current,
          chat,
          usage: res.usage,
          kind: 'chat',
          model: current.model,
          credits: res.credits,
          creditsEstimated: creditInfo?.estimated,
        });
        if (res.reasoning) res.reasoning = String(res.reasoning).slice(0, 8000);

        const bp = parseBrowser(res.text);
        if (!bp.command || !browser || browserSteps >= MAX_BROWSER_STEPS) break;

        if (bp.clean) {
          if (chat.type === 'group') {
            addProcess(state, chat, current, `阶段回复：${bp.clean}`, save, emit);
          } else {
            const mid = addMessage(state, chat.id, {
              senderId: current.id,
              text: bp.clean,
              meta: {
                quota: quotaLabel(current),
                usage: res.usage || null,
                thinking: res.reasoning || null,
              },
            });
            save();
            emit('message', { chatId: chat.id, message: mid });
          }
        }

        const bpIcon = String(bp.command.action || '').startsWith('file_') ? '📂' : '🌐';
        if (chat.type === 'group') {
          addProcess(state, chat, current, `${bpIcon} ${browserActionLabel(bp.command)}`, save, emit);
        } else {
          const note = addMessage(state, chat.id, {
            type: 'system',
            text: `${bpIcon} ${browserActionLabel(bp.command)}`,
          });
          save();
          emit('message', { chatId: chat.id, message: note });
        }
        addLog(
          chat,
          current.id,
          String(bp.command.action || '').startsWith('file_') ? '文件' : '浏览器',
          browserActionLabel(bp.command)
        );

        const result = await browser(bp.command.action, bp.command.args);
        browserSteps += 1;
        botTask = browserResultTask(result);
        botFrom = String(bp.command.action || '').startsWith('file_') ? '文件' : '浏览器';
      }

      const leftover = parseBrowser(res.text);
      const baseText = leftover.command ? leftover.clean : res.text;
      if (leftover.command) {
        const msg = browser
          ? '浏览器操作次数已达上限，先停在这一页。'
          : '当前环境没有内置浏览器。';
        if (chat.type === 'group') {
          addProcess(state, chat, current, msg, save, emit);
        } else {
          const sys = addMessage(state, chat.id, { type: 'system', text: msg });
          save();
          emit('message', { chatId: chat.id, message: sys });
        }
      }

      const isLeader = state.settings?.leaderId === current.id;
      if (res.timedOut) {
        recordBotFailure({
          state,
          chat,
          bot: current,
          error: new Error('执行超时（仅输出部分未完成内容）'),
          source: chat.type === 'group' ? 'group' : 'dm',
        });
      } else if (res.noToolPermission) {
        recordBotFailure({
          state,
          chat,
          bot: current,
          kind: 'stopped',
          error: new Error('工具权限被拒绝，降级纯文字模式无法完成工具操作'),
          source: chat.type === 'group' ? 'group' : 'dm',
        });
      } else {
        recordBotSuccess(current);
      }
      if (chat.type === 'group' && res.timedOut) {
        addProcess(
          state,
          chat,
          current,
          '执行超时，下面是已经生成的部分结果；可以拆小任务后重试。',
          save,
          emit,
          'error'
        );
      }
      if (chat.type === 'group' && Array.isArray(res.steps) && !res.streamedSteps) {
        for (const step of res.steps.slice(0, 20)) {
          addProcess(
            state,
            chat,
            current,
            `执行：${step.tool}${step.title ? ` · ${step.title}` : ''}`,
            save,
            emit
          );
        }
      }
      const sendParsed = parseSend(baseText);
      const sends = isLeader && allowSend ? sendParsed.sends : null;
      let clean = sendParsed.clean;
      let delegation = null;
      let drain = null;
      let creates = [];

      if (!sendParsed.sends && isLeader && allowSend) {
        const c = parseCreate(clean);
        clean = c.clean;
        creates = c.creates;
      }

      if (!sendParsed.sends) {
        const dp = parseDrain(clean);
        clean = dp.clean;
        drain = dp.drain;
      }

      if (!sendParsed.sends && !drain) {
        const d = parseDelegation(clean, state);
        clean = d.clean;
        delegation = d.delegation;
      }

      const doneParsed = parseDone(clean);
      clean = doneParsed.clean;
      if (doneParsed.done && chat.loop) {
        chat.loop = false;
        chat.loopRound = 0;
        const note = addMessage(state, chat.id, {
          type: 'system',
          text: '@@DONE：任务已完成，自动运行已停止。',
        });
        save();
        emit('message', { chatId: chat.id, message: note });
        emit('chats', { chats: state.chats });
      }

      if (drain && isLeader && allowSend) {
        const wanted = cleanTargetName(drain.to);
        const group = state.chats.find(
          (c) =>
            c.type === 'group' &&
            (c.id === drain.to || normName(c.title) === normName(wanted))
        );
        if (!group) {
          const fail = `收尾失败：找不到群「${drain.to}」`;
          if (chat.type === 'group') addProcess(state, chat, current, fail, save, emit, 'error');
          else {
            const sys = addMessage(state, chat.id, { type: 'system', text: fail });
            save();
            emit('message', { chatId: chat.id, message: sys });
          }
        } else {
          group.loopPrompt = DRAIN_PROMPT;
          group.draining = true;
          group.drainNote =
            drain.note || '停止生产新内容；只上传已完成批次；完成后输出 @@DONE，结束自动运行。';
          if (!group.loopTargetId || !group.botIds.includes(group.loopTargetId)) {
            group.loopTargetId =
              group.leadId && group.botIds.includes(group.leadId)
                ? group.leadId
                : group.botIds[0] || null;
          }
          const note = addMessage(state, group.id, {
            type: 'system',
            text: `${current.name} 发起收尾：${group.drainNote}`,
          });
          save();
          emit('message', { chatId: group.id, message: note });
          emit('chats', { chats: state.chats });
          addLog(group, current.id, '收尾', group.drainNote);

          if (!group.loop) {
            const target = state.bots.find((b) => b.id === group.loopTargetId);
            if (target) {
              await runTurnInternal({
                state,
                chat: group,
                bot: target,
                task: DRAIN_PROMPT,
                fromName: current.name,
                save,
                emit,
                allowSend: false,
                browser,
              });
            }
          }
        }
      }

      if (creates.length) {
        const { made, failed } = applyCreates({ state, chat, creates, bot: current });
        const lines = [...made.map((t) => `· ${t}`), ...failed.map((t) => `· ${t}`)];
        if (lines.length) {
          const note = addMessage(state, chat.id, {
            type: 'system',
            text: lines.join('\n'),
          });
          save();
          emit('message', { chatId: chat.id, message: note });
        }
        if (made.length) {
          emit('botGroups', { botGroups: state.botGroups || [] });
          emit('bots', { bots: state.bots });
          emit('chats', { chats: state.chats });
        }
      }

      const creditMeta =
        creditsTotal > 0
          ? {
              credits: creditsTotal,
              creditUnit: '积分',
              creditsEstimated,
              creditCost: creditMoney(current.backend, creditsTotal, state.settings),
            }
          : null;

      if ((clean || (!delegation && !sends)) && !(doneParsed.done && !clean)) {
        const replyText = clean || '（空回复）';
        if (liveThink) {
          updateProcessMessage(
            state,
            liveThink.chatId,
            liveThink.id,
            res.reasoning || thinkBuf || '没有返回可展示的思考内容。',
            save,
            emit
          );
        } else if (res.reasoning && procTarget) {
          addProcess(state, chat, current, res.reasoning, save, emit, 'thinking');
        }
        if (chat.type === 'group') {
          const project = linkedGroupProject(state, chat, current);
          if (project) {
            const pm = addMessage(state, project.id, {
              senderId: current.id,
              text: replyText,
              meta: { quota: quotaLabel(current), usage: res.usage || null, ...(creditMeta || {}) },
            });
            save();
            emit('message', { chatId: project.id, message: pm });
          }
          const msg = addMessage(state, chat.id, {
            senderId: current.id,
            text: replyText,
            meta: {
              quota: quotaLabel(current),
              usage: res.usage || null,
              ...(creditMeta || {}),
            },
          });
          addLog(chat, current.id, '回复', replyText);
          save();
          emit('message', { chatId: chat.id, message: msg });
          if (looksLikeDecision(replyText)) {
            alertBot(state, chat, current, 'decision', replyText, save, emit);
          }
        } else {
          const stepText =
            !res.reasoning && Array.isArray(res.steps) && res.steps.length
              ? res.steps
                  .slice(0, 30)
                  .map((x) => `· ${x.tool}${x.title ? `：${x.title}` : ''}`)
                  .join('\n')
              : '';
          const meta = {
            quota: quotaLabel(current),
            usage: res.usage || null,
            thinking: res.reasoning || stepText || null,
            thinkingKind: res.reasoning ? 'reasoning' : stepText ? 'steps' : null,
            ...(creditMeta || {}),
          };
          const msg = addMessage(state, chat.id, {
            senderId: current.id,
            text: replyText,
            meta,
          });
          addLog(chat, current.id, '回复', replyText);
          save();
          emit('message', { chatId: chat.id, message: msg });
          // 私聊里被委派的 Bot：把最终交付也镜像到它自己的项目，别只在别人的聊天窗里出现。
          // 如果当前就在它自己的项目里（chain > 0），上面已经写过，不能重复。
          if (procTarget && procTarget.id !== chat.id) {
            const pm = addMessage(state, procTarget.id, {
              senderId: current.id,
              text: replyText,
              meta: { ...meta, mirrored: true, groupTitle: chat.title },
            });
            save();
            emit('message', { chatId: procTarget.id, message: pm });
          }
        }
      }

      if (sends) {
        addLog(chat, current.id, '发消息', sends.targets.join('、'));
        await applySends({ state, chat, leader: current, sends, save, emit, browser });
        break;
      }
      if (!delegation) break;

      const next = resolveBot(state, delegation.to);
      if (!next) {
        const names = state.bots.map((b) => b.name).join('、');
        const text = `转交失败：找不到「${delegation.to}」。可用成员：${names}`;
        if (chat.type === 'group') addProcess(state, chat, current, text, save, emit, 'error');
        else {
          const sys = addMessage(state, chat.id, { type: 'system', text });
          save();
          emit('message', { chatId: chat.id, message: sys });
        }
        break;
      }
      if (next.id === current.id) break;
      if (chat.type === 'group' && !chat.botIds.includes(next.id)) {
        const text = `转交失败：${next.name} 不在这个群里，先在群设置里把它加进来。`;
        addProcess(state, chat, current, text, save, emit, 'error');
        break;
      }

      if (chat.type === 'group') {
        addProcess(
          state,
          chat,
          current,
          `转交给 ${next.name}：${delegation.task}`,
          save,
          emit
        );
        addProcess(
          state,
          chat,
          next,
          `收到 ${current.name} 的转交：${delegation.task}`,
          save,
          emit
        );
      } else {
        const handoff = addMessage(state, chat.id, {
          type: 'handoff',
          senderId: current.id,
          toId: next.id,
          text: delegation.task,
        });
        save();
        emit('message', { chatId: chat.id, message: handoff });
        // 被委派的 Bot 自己的项目里也留一条交接记录，方便追过程。
        const nextProject = processChatFor(state, chat, next);
        if (nextProject) {
          const hp = addMessage(state, nextProject.id, {
            type: 'handoff',
            senderId: current.id,
            toId: next.id,
            text: delegation.task,
            meta: { fromBot: current.name, toBot: next.name, mirrored: true, groupTitle: chat.title },
          });
          save();
          emit('message', { chatId: nextProject.id, message: hp });
        }
      }
      addLog(chat, current.id, '转交', `${next.name}：${delegation.task}`);
      // 私聊里不内联执行委派：把任务排到目标 Bot 自己的项目去跑，
      // 发起人的聊天窗立刻恢复可用（否则领导一分派，你就几十分钟没法说话）。
      const dmTargetChat = chat.type === 'dm' ? processChatFor(state, chat, next) : null;
      if (dmTargetChat) {
        if (chain >= MAX_HOPS) {
          const limitText = `转交链路过长（已 ${MAX_HOPS} 层），这次没有继续派发。请直接 @${next.name} 发消息。`;
          const sys = addMessage(state, chat.id, { type: 'system', text: limitText });
          save();
          emit('message', { chatId: chat.id, message: sys });
          break;
        }
        scheduleDelegatedTurn({
          state,
          fromChat: chat,
          targetChat: dmTargetChat,
          fromBot: current,
          toBot: next,
          task: delegation.task,
          chain,
          save,
          emit,
          browser,
        });
        if (!clean) {
          const note = addMessage(state, chat.id, {
            type: 'system',
            text: `已交给 ${next.name}，它会在自己的项目里执行，完成后在这里回报。`,
          });
          save();
          emit('message', { chatId: chat.id, message: note });
        }
        break;
      }
      if (hops >= MAX_HOPS) {
        const limitText = `转交次数已达上限（${MAX_HOPS} 次），${next.name} 没有执行。请直接 @${next.name} 发消息继续。`;
        if (chat.type === 'group') {
          addProcess(state, chat, current, limitText, save, emit, 'error');
        } else {
          const sys = addMessage(state, chat.id, { type: 'system', text: limitText });
          save();
          emit('message', { chatId: chat.id, message: sys });
        }
        alertBot(state, chat, current, 'error', limitText, save, emit);
        break;
      }

      currentFrom = current.name;
      current = next;
      currentTask = delegation.task;
      hops += 1;
    } catch (e) {
      if (signal?.aborted || e?.aborted) break;
      const errText = String(e?.message || e);
      if (liveThink) {
        updateProcessMessage(
          state,
          liveThink.chatId,
          liveThink.id,
          e?.partialReasoning || thinkBuf || '这次没有拿到完整的思考内容（可能被中断或超时）。',
          save,
          emit
        );
      }
      const isQuotaErr = !!(e?.quota || isQuotaErrorText(errText));
      const quotaDown = hops === 0 && chat.type === 'group' && isQuotaErr;
      const fallback = quotaDown
        ? (() => {
            const members = chat.botIds
              .map((id) => state.bots.find((b) => b.id === id))
              .filter((b) => b && b.id !== current.id);
            return members.find((b) => b.billing === 'subscription') || members[0] || null;
          })()
        : null;
      if (fallback) {
        recordBotFailure({
          state,
          chat,
          bot: current,
          error: e,
          kind: 'quota',
          source: 'group_fallback',
          forceReport: true,
        });
        const noteText = `${current.name} 额度不足，本次改由 ${fallback.name} 接单。`;
        if (chat.type === 'group') {
          addProcess(state, chat, current, noteText, save, emit);
          alertBot(state, chat, current, 'quota', noteText, save, emit);
        } else {
          const note = addMessage(state, chat.id, { type: 'system', text: noteText });
          save();
          emit('message', { chatId: chat.id, message: note });
        }
        addLog(chat, current.id, '额度不足', `改由 ${fallback.name} 接单`);
        current = fallback;
        currentTask = task;
        currentFrom = fromName;
        hops += 1;
        continue;
      }
      recordBotFailure({
        state,
        chat,
        bot: current,
        error: e,
        kind: isQuotaErr ? 'quota' : '',
        source: chat.type === 'group' ? 'group' : 'dm',
      });
      emit('status', {
        chatId: chat.id,
        botId: current.id,
        name: current.name,
        running: false,
        chatTitle: chat.title,
        error: errText.slice(0, 300),
      });
      const errorText = `${current.name} 出错：${errText.slice(0, 800)}`;
      if (chat.type === 'group') {
        addProcess(state, chat, current, errorText, save, emit, 'error');
        if (looksLikePermission(errText) || looksLikeDecision(errText)) {
          alertBot(
            state,
            chat,
            current,
            looksLikePermission(errText) ? 'permission' : 'decision',
            errText,
            save,
            emit
          );
        }
      } else {
        const sys = addMessage(state, chat.id, { type: 'system', text: errorText });
        save();
        emit('message', { chatId: chat.id, message: sys });
      }
      addLog(chat, current.id, '出错', errText.slice(0, 300));
      save();
      break;
    } finally {
      emit('status', { chatId: chat.id, botId: runningBot.id, running: false });
    }
  }
}

export async function runWorkflowNode({
  state,
  chat,
  node,
  bot,
  input = '',
  fromNodeTitle = '',
  fromBotName = '',
  drainMode = false,
  signal,
  shouldPause,
  onActivity = null,
  save,
  emit,
}) {
  if (!bot) return { ok: false, error: '流程环节没有指定 Bot', text: '' };
  if (signal?.aborted) return { ok: false, aborted: true, text: '' };

  syncGroupFiles(state, chat, bot);
  const project = linkedGroupProject(state, chat, bot);
  const runnerBot = node.model ? { ...bot, model: node.model } : bot;
  const notifyActivity = (type) => {
    try {
      onActivity?.({ type, nodeId: node.id, botId: bot.id });
    } catch {}
  };
  // 单环节时长上限：默认 30 分钟，避免一个环节闷头跑一小时才告诉你“什么都没产出”。
  // Bot 自己设了更短的超时则取更短的那个；0 = 不限。
  const capMin = Number(state.settings?.flowNodeMinutes ?? 30);
  const capMs = Number.isFinite(capMin) && capMin > 0 ? capMin * 60000 : 0;
  const botLimit = botTimeoutMs(runnerBot);
  const runTimeoutMs = capMs ? (botLimit > 0 ? Math.min(botLimit, capMs) : capMs) : botLimit;
  // 覆盖模型时单独开会话，避免同一 session 在不同模型之间切换导致 CLI 报错
  const sessionKey = node.model ? `wf:${chat.id}:${node.model}` : chat.id;
  const prevSession = bot.sessions?.[sessionKey] || {};
  const task = [
    '当前是群流程图执行模式，不是自由轮班；只执行下面这一个环节。',
    drainMode
      ? '【循环收尾模式】流程已经要求停止：不要再开始新的收集/生产，也不要转交；请把下面所有已完成但还没处理的结果整理并执行本环节（上传/交付/发布），不要遗漏。'
      : '',
    `【流程环节：${node.title}】`,
    node.task,
    input && /^【并行/.test(input)
      ? '【并行汇合】下面有多个并行分支的结果，请严格按 1→N 的顺序依次处理/上传：先完成第 1 个，再处理第 2 个，不要跳过、不要并行调用。'
      : '',
    input
      ? fromNodeTitle
        ? `上一环节「${fromNodeTitle}」由 ${fromBotName || '上一个 Bot'} 完成，并已把结果交接给你（只用于继续，不要复述）：\n${String(
            input
          ).slice(0, 12000)}`
        : `上一环节的结果（只用于继续，不要复述）：\n${String(input).slice(0, 12000)}`
      : '',
    '只完成这个环节，直接给出结果。不要转交、不要创建或删除 Bot/群。',
    node.allowEnd
      ? '如果你判断整个流程目标已经全部完成，请在结果最后单独输出一行 @@FLOW_END；没有完成就不要输出这个标记。'
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  let liveThink = null;
  let thinkBuf = '';
  let lastThinkAt = 0;
  const onProgress = (p) => {
    notifyActivity(p.type || 'progress');
    if (chat.type !== 'group') return;
    if (p.type === 'step') {
      addProcess(
        state,
        chat,
        bot,
        `执行：${p.tool}${p.title ? ` · ${p.title}` : ''}`,
        save,
        emit
      );
    } else if (p.type === 'thinking' && p.text) {
      thinkBuf += (thinkBuf ? '\n' : '') + p.text;
      if (!liveThink) {
        liveThink = addProcess(state, chat, bot, '正在思考…', save, emit, 'thinking');
      }
      if (liveThink && Date.now() - lastThinkAt > 500) {
        lastThinkAt = Date.now();
        updateProcessMessage(state, liveThink.chatId, liveThink.id, thinkBuf, save, emit);
      }
    }
  };

  emit('status', {
    chatId: chat.id,
    botId: bot.id,
    name: bot.name,
    running: true,
    chatTitle: chat.title,
    task: `流程：${node.title}`,
  });

  const onStart = () => {
    notifyActivity('start');
    emit('status', {
      chatId: chat.id,
      botId: bot.id,
      name: bot.name,
      running: true,
      queued: false,
      chatTitle: chat.title,
      task: `流程：${node.title}`,
    });
    addProcess(state, chat, bot, `开始流程环节：${node.title}`, save, emit);
  };

  try {
    const invoke = () =>
      queueBotRun(
        `${bot.id}::${sessionKey}`,
        () =>
          runBot({
            bot: runnerBot,
            prompt: buildPrompt({
              state,
              chat,
              bot,
              task,
              attachments: [],
              fromName: '流程',
              lean: true,
            }),
            sessionId: null,
            cwd: botWorkspace(bot.id),
            effort: effortForChat(state, chat),
            permission: mergePermissions(bot.permission, chat.permission),
            agyHome: agyHomeFor(state, bot),
            onProgress,
            signal,
            apiKey: state.providerKeys?.[`botapi:${runnerBot.id}`] || '',
            timeoutMs: runTimeoutMs,
          }),
        onStart
      );

    // runBot 在完全失败时会 throw，这里统一收成结果对象，方便重试
    const invokeSafe = async () => {
      try {
        return await invoke();
      } catch (e) {
        return {
          text: '',
          err: String(e?.message || e),
          steps: e?.steps || [],
          code: e?.code ?? -1,
          quota: !!e?.quota,
          auth: !!e?.auth,
          aborted: !!e?.aborted,
          timedOut: !!e?.timedOut,
        };
      }
    };

    const waitAbortable = (ms) =>
      new Promise((resolve) => {
        if (signal?.aborted) return resolve(false);
        const timer = setTimeout(() => {
          signal?.removeEventListener?.('abort', onAbort);
          resolve(true);
        }, ms);
        const onAbort = () => {
          clearTimeout(timer);
          resolve(false);
        };
        signal?.addEventListener?.('abort', onAbort, { once: true });
      });

    let res = await invokeSafe();
    // 环节失败自动重试：默认 3 次，退避 5s / 15s / 30s。
    // 只有「确实没有拿到内容」才重试；已经产出文字的不重试，避免重复干活。
    const retrySetting = Number(state.settings?.flowRetries ?? 3);
    const maxRetries =
      retrySetting < 0 ? Number.MAX_SAFE_INTEGER : Math.max(0, Math.min(10, retrySetting));
    const backoff = [5000, 15000, 30000, 30000, 30000, 30000, 30000, 30000, 30000, 30000];
    let retriesUsed = 0;
    let quotaReported = false;
    let quotaHit = !!(res.quota || isQuotaErrorText(res.err || ''));
    let authHit = !!(res.auth || isAuthErrorText(res.err || ''));
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      if (signal?.aborted || res.aborted) break;
      if (shouldPause?.()) {
        return { ok: false, paused: true, error: '已暂停' };
      }
      if (res.timedOut) break;
      quotaHit = !!(res.quota || isQuotaErrorText(res.err || ''));
      authHit = !!(res.auth || isAuthErrorText(res.err || ''));
      // 额度/限流或鉴权失败类错误重试也没用，直接交给上层和领导处理。
      if (quotaHit) {
        addProcess(state, chat, bot, '额度或限流不足，停止自动重试，交给领导处理。', save, emit, 'error');
        recordBotFailure({
          state,
          chat,
          bot: runnerBot,
          error: new Error(res.err || '额度或限流不足'),
          kind: 'quota',
          node,
          source: 'workflow',
          forceReport: true,
        });
        quotaReported = true;
        break;
      }
      if (authHit) {
        addProcess(state, chat, bot, '鉴权/登录失效，停止自动重试，交给领导处理。', save, emit, 'error');
        recordBotFailure({
          state,
          chat,
          bot: runnerBot,
          error: new Error(res.err || '鉴权/登录失效'),
          kind: 'stopped',
          node,
          source: 'workflow',
          forceReport: true,
        });
        quotaReported = true;
        break;
      }
      if (String(res.text || '').trim() && !res.noToolPermission) break;
      const why =
        (res.err || '').split('\n').filter(Boolean).slice(-1)[0] ||
        (res.noToolPermission ? '工具权限被拒绝' : '没有返回内容');
      recordBotFailure({
        state,
        chat,
        bot: runnerBot,
        error: new Error(why),
        kind: res.noToolPermission ? 'stopped' : 'error',
        node,
        source: 'workflow',
      });
      const wait = backoff[Math.min(attempt - 1, backoff.length - 1)];
      addProcess(
        state,
        chat,
        bot,
        `这一步失败（${String(why).slice(0, 120)}），${wait / 1000} 秒后第 ${attempt} 次重试…`,
        save,
        emit,
        'error'
      );
      const ok = await waitAbortable(wait);
      if (!ok) break;
      if (shouldPause?.()) {
        return { ok: false, paused: true, error: '已暂停' };
      }
      res = await invokeSafe();
      retriesUsed = attempt;
    }
    if (retriesUsed && String(res.text || '').trim() && !res.timedOut && !res.noToolPermission) {
      const note = addMessage(state, chat.id, {
        type: 'system',
        text: `「${node.title}」失败 ${retriesUsed} 次后重试成功`,
      });
      save();
      emit('message', { chatId: chat.id, message: note });
    }

    if (signal?.aborted || res.aborted) {
      return { ok: false, aborted: true, text: '' };
    }

    bot.sessions ||= {};
    if (res.sessionId) {
      bot.sessions[sessionKey] = {
        id: res.sessionId,
        backend: bot.backend,
        lastInput:
          Number(res.usage?.input ?? res.usage?.input_tokens ?? 0) ||
          prevSession.lastInput ||
          0,
        calls: (prevSession.calls || 0) + 1,
      };
    }
    bot.usage = addUsage(bot.usage, res.usage, bot.backend);
    const wfCredit = creditsForRun({
      backend: bot.backend,
      model: runnerBot.model,
      usage: res.usage,
      credits: res.credits,
      settings: state.settings,
    });
    recordUsage(state, {
      bot,
      chat,
      usage: res.usage,
      kind: 'workflow',
      model: runnerBot.model,
      credits: res.credits,
      creditsEstimated: wfCredit?.estimated,
    });

    quotaHit = !!(res.quota || isQuotaErrorText(res.err || ''));
    authHit = !!(res.auth || isAuthErrorText(res.err || ''));

    if (res.timedOut) {
      const partial = String(res.text || '').trim();
      const err = `流程环节超过单环节时长上限（${capMin > 0 ? `${capMin} 分钟` : '不限'}）被中止${
        partial ? '（仅输出部分未完成内容，未作为交付通过）' : '，没有返回内容'
      }。可在设置里调整「流程单环节时长上限」。`;
      addProcess(state, chat, bot, err, save, emit, 'error');
      if (!quotaReported) {
        recordBotFailure({
          state,
          chat,
          bot: runnerBot,
          error: new Error(err),
          kind: 'stopped',
          node,
          source: 'workflow',
          forceReport: true,
        });
      }
      return {
        ok: false,
        timedOut: true,
        error: err,
        text: '',
        partialText: partial.slice(0, 1000),
        steps: res.steps || [],
      };
    }

    if (res.noToolPermission) {
      const err = '工具权限被拒绝，降级纯文字模式无法完成环节操作';
      addProcess(state, chat, bot, err, save, emit, 'error');
      if (!quotaReported) {
        recordBotFailure({
          state,
          chat,
          bot: runnerBot,
          error: new Error(err),
          kind: 'stopped',
          node,
          source: 'workflow',
          forceReport: true,
        });
      }
      return { ok: false, noToolPermission: true, error: err, text: '', steps: res.steps || [] };
    }

    if (!res.text || !String(res.text).trim()) {
      const err = res.err
        ? `流程环节失败：${String(res.err).split('\n').filter(Boolean).slice(-2).join(' · ').slice(0, 240)}`
        : '流程环节没有返回内容';
      addProcess(state, chat, bot, err, save, emit, 'error');
      if (!quotaReported) {
        recordBotFailure({
          state,
          chat,
          bot: runnerBot,
          error: new Error(res.err || err),
          kind: quotaHit ? 'quota' : authHit ? 'stopped' : 'stopped',
          node,
          source: 'workflow',
          forceReport: true,
        });
      }
      return {
        ok: false,
        error: err,
        text: '',
        quota: quotaHit,
        auth: authHit,
        steps: res.steps || [],
      };
    }

    recordBotSuccess(runnerBot);

    const rawText = String(res.text).trim();
    const flowEnd = !!node.allowEnd && /@@FLOW_END/.test(rawText);
    const text = node.allowEnd
      ? rawText.replace(/^\s*@@FLOW_END\s*$/gm, '').trim() || rawText
      : rawText;
    const meta = {
      quota: quotaLabel(bot),
      usage: res.usage || null,
      thinking: res.reasoning || null,
      ...(wfCredit && wfCredit.credits > 0
        ? {
            credits: wfCredit.credits,
            creditUnit: wfCredit.unit,
            creditsEstimated: wfCredit.estimated,
            creditCost: creditMoney(bot.backend, wfCredit.credits, state.settings),
          }
        : {}),
    };
    if (liveThink) {
      updateProcessMessage(
        state,
        liveThink.chatId,
        liveThink.id,
        res.reasoning || thinkBuf || '没有返回可展示的思考内容。',
        save,
        emit
      );
    }
    const msg = addMessage(state, chat.id, { senderId: bot.id, text, meta });
    addLog(chat, bot.id, '流程', `${node.title}：${text}`);
    save();
    emit('message', { chatId: chat.id, message: msg });
    if (project) {
      const pm = addMessage(state, project.id, { senderId: bot.id, text, meta });
      save();
      emit('message', { chatId: project.id, message: pm });
    }
    return { ok: true, text, flowEnd };
  } catch (e) {
    if (signal?.aborted || e?.aborted) {
      return { ok: false, aborted: true, text: '' };
    }
    const error = String(e?.message || e).slice(0, 800);
    addProcess(state, chat, bot, `流程环节出错：${error}`, save, emit, 'error');
    recordBotFailure({
      state,
      chat,
      bot: runnerBot,
      error: e,
      kind: 'stopped',
      node,
      source: 'workflow',
      forceReport: true,
    });
    return { ok: false, error, text: '' };
  } finally {
    notifyActivity('end');
    emit('status', {
      chatId: chat.id,
      botId: bot.id,
      name: bot.name,
      running: false,
      chatTitle: chat.title,
    });
  }
}

export async function runTurn({ state, chat, text, attachments = [], auto = false, context = '', selection = '', preRecorded = false, uptoId = '', save, emit, browser, signal }) {
  if (signal?.aborted) return;

  if (chat.type === 'group' && chat.botIds.length === 0) {
    const m = addMessage(state, chat.id, {
      type: 'system',
      text: '这个群还没有成员，先加一个 bot。',
    });
    save();
    emit('message', { chatId: chat.id, message: m });
    return;
  }

  const leaderId = state.settings?.leaderId;
  const leader = leaderId ? state.bots.find((b) => b.id === leaderId) : null;
  const leaderDm =
    !!leader &&
    chat.type === 'dm' &&
    chat.botIds.length === 1 &&
    chat.botIds[0] === leader.id;
  // 私聊里老板永远以自己的身份说话；只有群聊里，老板的话才以领导的名义发出
  const asLeader = !!leader && chat.type !== 'dm';

  let anchorId = uptoId;
  if (!auto && !preRecorded) {
    const userMsg = addMessage(state, chat.id, {
      senderId: asLeader ? leader.id : 'user',
      text,
      attachments,
      meta: asLeader ? { viaUser: true } : null,
    });
    anchorId = userMsg.id;
    save();
    emit('message', { chatId: chat.id, message: userMsg });
  }

  const reading = collectReadProjects(state, chat, text);
  const readContext = reading.context
    ? `\n\n老板让你读取的其他项目记录（只用于这次回答，不要假装之前的对话里就有）：\n${reading.context}`
    : '';

  const loopTarget =
    auto && chat.loopTargetId
      ? state.bots.find((b) => b.id === chat.loopTargetId && chat.botIds.includes(b.id))
      : null;
  const mentionedList = findMentionedBots(state, chat, text);
  const mentionAll =
    chat.type === 'group' && /@(所有人|全体成员|全部成员|all)/i.test(text);
  const wantsCreate = /(新建|创建|建立|建个|建一个|起个|拉个|开个|加个|加一个)[^\n]{0,14}(bot|机器人|员工|群聊|群)/i.test(text);
  let targets = [];
  let task = text + readContext;

  if (loopTarget) {
    targets = [loopTarget];
  } else if (mentionAll) {
    const members = chat.botIds
      .map((id) => state.bots.find((b) => b.id === id))
      .filter((b) => b && b.id !== leaderId);
    const lead = members.find((b) => b.id === chat.leadId);
    targets = lead ? [lead, ...members.filter((b) => b.id !== lead.id)] : members;
    task =
      (text.replace(/@(所有人|全体成员|全部成员|all)/gi, '').trim() || text) +
      readContext;
  } else if (mentionedList.length) {
    // 一条消息里 @ 了几个，就让几个都收到
    targets = [...new Set(mentionedList.map((h) => h.bot))];
    task =
      (mentionedList.length === 1
        ? text.replace(mentionedList[0].token, '').trim() || text
        : text) + readContext;
  } else if (chat.type === 'group' && leader && wantsCreate) {
    // 老板明确要建人/建群时，由领导来创建
    targets = [leader];
  } else if (chat.type === 'group') {
    // 不 @ 时只让默认接单成员回；@谁谁回；@所有人 才全员回复
    const members = chat.botIds
      .map((id) => state.bots.find((b) => b.id === id))
      .filter((b) => b && b.id !== leaderId);
    const lead = members.find((b) => b.id === chat.leadId) || members[0];
    targets = lead ? [lead] : [];
  } else {
    const b = state.bots.find((x) => x.id === chat.botIds[0]);
    if (b) targets = [b];
  }

  if (context) {
    const contextText = String(context);
    task += `\n\n【右侧面板当前内容（用户没有单独选中，系统自动附带；回答时可参考）】\n${contextText.slice(
      0,
      20000
    )}`;
    if (contextText.includes('【当前打开的文件】')) {
      task += `\n\n【操作规则】如果老板说“直接改这个”“在这个上面改”“改当前文件”“直接在这个上面改”，默认指上面【当前打开的文件】里的路径；请直接修改这个文件，不要另存新文件，也不要改其他同名或相近的文件。改完要确认已经写回原路径。`;
      if (contextText.includes('正在编辑')) {
        task += `\n\n【编辑器直连】右侧文件正在编辑。如果工具列表里有 editor_read / editor_apply，优先用 editor_read 读取当前编辑器的实时内容，再用 editor_apply 直接修改编辑器（replace_text / patch）；改动会立即显示在右侧，不需要保存后重新打开，也不要另存新文件。
如果用户要求改完写回，或者当前是 Word/Excel/PPT 这类原生格式，请在 editor_apply 之后继续用 run_command / write_file 把同样的改动写回同一个原文件（优先保留原有格式），不要生成新文件，也不要把“保存”留给用户。完成后确认编辑器内容和原文件都已经更新。只有 editor 工具不可用时，才只用 write_file / run_command 修改磁盘。
Excel/CSV 直接用 editor_set_cells（cells: [{sheet?, cell:'A1', value:'...'}]）；PPT 直接用 editor_set_paragraphs（paragraphs: [{index, text}]）。这两类改动会立即显示，并在后台自动写回原文件，不需要再手动保存。
PDF 用 pdf_read 读取每页文字块和 bbox，再用 pdf_apply 的 updates（按 bbox 改字）、replacements（按文字搜索替换）、additions（加文字）修改；PDF 是绘制格式，字体和间距会有细微差异，改完检查一遍。`;
      }
    }
  }
  if (selection) {
    task += `\n\n【用户刚刚选中的内容（老板在右侧选中后直接提问，指的就是这段）】\n${String(
      selection
    ).slice(0, 20000)}`;
  }

  if (reading.names.length) {
    const noteText = `已读取项目：${reading.names.join('、')}`;
    if (chat.type === 'group') {
      for (const target of targets) addProcess(state, chat, target, noteText, save, emit);
    } else {
      const note = addMessage(state, chat.id, { type: 'system', text: noteText });
      save();
      emit('message', { chatId: chat.id, message: note });
    }
  }

  if (!targets.length) {
    const sys = addMessage(state, chat.id, {
      type: 'system',
      text: '这个群里没有可接单的 Bot，先加一个成员。',
    });
    save();
    emit('message', { chatId: chat.id, message: sys });
    return;
  }

  for (const target of targets) {
    addLog(chat, target.id, '接单', task);
    if (auto) {
      addProcess(state, chat, target, `自动继续第 ${chat.loopRound || 1} 轮`, save, emit);
    }
  }
  await Promise.allSettled(
    targets.map((target) =>
      runTurnInternal({
        state,
        chat,
        bot: target,
        task,
        attachments,
        fromName: auto ? '自动运行' : asLeader ? leader.name : '用户',
        save,
        emit,
        allowSend: true,
        browser,
        signal,
        uptoId: anchorId,
      })
    )
  );

  await maybeCompact({ state, chat, save, emit, bot: targets[0] });
}

function estimateChatTokens(state, chat) {
  const msgs = state.messages[chat.id] || [];
  let chars = 0;
  for (const m of msgs) chars += (m.text || '').length + (m.meta?.thinking?.length || 0);
  return Math.round(chars / 1.6);
}

function contextBot(state, chat) {
  if (chat.type === 'dm') return state.bots.find((b) => b.id === chat.botIds[0]) || null;
  const lead = state.bots.find((b) => b.id === chat.leadId && chat.botIds.includes(b.id));
  return lead || state.bots.find((b) => chat.botIds.includes(b.id)) || null;
}

// 把长对话压成摘要，并清掉原生 session，下一轮用「摘要 + 最近消息」继续
// 对话上下文压缩使用进程内内存锁，避免崩溃或重启后残留持久化标志位导致永久卡死
const compactingChats = new Set();

export async function compactChat({ state, chat, save, emit, bot = null }) {
  const msgs = state.messages[chat.id] || [];
  if (!msgs.length) return { ok: false, reason: '还没有对话' };
  const target = bot || contextBot(state, chat);
  if (!target) return { ok: false, reason: '没有可用的 Bot' };
  if (compactingChats.has(chat.id)) return { ok: false, reason: '正在压缩中' };
  compactingChats.add(chat.id);
  delete chat.compacting;
  try {
    const transcript = msgs
      .slice(-60)
      .map((m) => {
        const who =
          m.senderId === 'user'
            ? '老板'
            : state.bots.find((b) => b.id === m.senderId)?.name || '系统';
        return `${who}: ${String(m.text || '').slice(0, 600)}`;
      })
      .join('\n');

    const prompt = [
      '请把下面的对话压缩成不超过 600 字的中文摘要。',
      '保留：老板的目标、已确认的结论和数据、未完成事项、各成员的分工、重要的文件/链接/偏好。',
      '只输出摘要，不要客套话，不要使用任何工具。',
      chat.contextSummary ? `\n此前的摘要：\n${chat.contextSummary}` : '',
      '\n对话记录：\n' + transcript,
    ]
      .filter(Boolean)
      .join('\n');

    const res = await runBot({
      bot: target,
      prompt,
      sessionId: null,
      cwd: botWorkspace(target.id),
      effort: 'low',
      apiKey: state.providerKeys?.[`botapi:${target.id}`] || '',
      timeoutMs: botTimeoutMs(target),
    });
    if (!res.text) return { ok: false, reason: '模型没有返回摘要' };

    const summary = res.text.trim().slice(0, 2000);
    chat.contextSummary = summary;
    chat.compactedAt = Date.now();
    chat.compactedCount = msgs.length;
    target.usage = addUsage(target.usage, res.usage, target.backend);
    recordUsage(state, {
      bot: target,
      chat,
      usage: res.usage,
      kind: 'compact',
      model: target.model,
      credits: res.credits,
    });
    for (const b of state.bots) {
      const keys = new Set([chat.id]);
      if (chat.linkedGroupId) keys.add(chat.linkedGroupId);
      for (const p of state.chats) if (p.linkedGroupId === chat.id) keys.add(p.id);
      for (const k of keys) if (b.sessions?.[k]) delete b.sessions[k];
    }

    const est = estimateChatTokens(state, chat);
    const estText = est >= 1000 ? `约 ${(est / 1000).toFixed(1)}k tokens` : `${est} tokens`;
    const sys = addMessage(state, chat.id, {
      type: 'system',
      text: `上下文已压缩：${estText} → 摘要 ${summary.length} 字`,
    });
    save();
    emit('message', { chatId: chat.id, message: sys });
    return { ok: true, summary };
  } catch (e) {
    return { ok: false, reason: String(e?.message || e) };
  } finally {
    compactingChats.delete(chat.id);
    delete chat.compacting;
  }
}

export async function maybeCompact({ state, chat, save, emit, bot }) {
  if (compactingChats.has(chat.id)) return;
  const msgs = state.messages[chat.id] || [];
  const since = msgs.length - (chat.compactedCount || 0);
  if (since < CONTEXT_BATCH) return;
  if (Date.now() - (chat.compactedAt || 0) < 120000) return;
  if (estimateChatTokens(state, chat) < CONTEXT_LIMIT) return;
  await compactChat({ state, chat, save, emit, bot });
}

/* ---------------- Bot 健康追踪与异常自动汇报 ---------------- */

const botHealth = new Map();
let botIssueHandler = null;

export function setBotIssueHandler(fn) {
  botIssueHandler = typeof fn === 'function' ? fn : null;
}

export function getBotHealth(botId) {
  return (
    botHealth.get(botId) || {
      consecutiveErrors: 0,
      totalErrors: 0,
      lastErrorAt: 0,
      lastError: '',
      lastKind: '',
    }
  );
}

export function clearBotHealth(botId) {
  if (!botId) return;
  botHealth.delete(botId);
}

function recordBotSuccess(bot) {
  if (!bot?.id) return;
  const prev = botHealth.get(bot.id);
  if (prev && (prev.consecutiveErrors > 0 || prev.lastKind)) {
    botHealth.set(bot.id, {
      ...prev,
      consecutiveErrors: 0,
      lastError: '',
      lastKind: '',
      lastSuccessAt: Date.now(),
    });
  }
}

function isFatalStopError(err) {
  const msg = String(err?.message || err || '');
  return (
    !!err?.auth ||
    !!err?.noToolPermission ||
    /\b401\b|\b403\b|unauthorized|invalid api key|authentication failed|not logged in|login required|token expired|permission denied|未登录|登录已过期|密钥无效|鉴权失败/i.test(
      msg
    )
  );
}

function recordBotFailure({
  state,
  chat,
  bot,
  error,
  kind = '',
  node = null,
  source = 'chat',
  forceReport = false,
}) {
  if (!bot?.id) return { count: 0, kind: 'error', reported: false };
  const msg = String(error?.message || error || '');
  const detectedKind =
    kind ||
    (error?.quota
      ? 'quota'
      : isFatalStopError(error)
        ? 'stopped'
        : 'error');
  const prev = botHealth.get(bot.id) || { consecutiveErrors: 0, totalErrors: 0 };
  const next = {
    consecutiveErrors: prev.consecutiveErrors + 1,
    totalErrors: prev.totalErrors + 1,
    lastErrorAt: Date.now(),
    lastError: msg.slice(0, 500),
    lastKind: detectedKind,
  };
  botHealth.set(bot.id, next);

  if (state?.settings?.autoReportToLeader === false) {
    return { count: next.consecutiveErrors, kind: detectedKind, reported: false };
  }

  const thresholdRaw = Number(state?.settings?.botErrorThreshold ?? 2);
  const threshold = Number.isFinite(thresholdRaw) ? Math.max(0, Math.round(thresholdRaw)) : 2;
  const hitStreak = threshold > 0 && next.consecutiveErrors >= threshold;
  const shouldReport =
    forceReport || detectedKind === 'quota' || detectedKind === 'stopped' || hitStreak;

  if (shouldReport && botIssueHandler) {
    const reportKind =
      detectedKind === 'quota'
        ? 'quota'
        : hitStreak && detectedKind !== 'stopped'
          ? 'error_streak'
          : detectedKind;
    try {
      botIssueHandler({
        state,
        chat,
        bot,
        kind: reportKind,
        detail: msg.slice(0, 1200),
        node,
        source,
        health: next,
      });
    } catch {}
  }
  return { count: next.consecutiveErrors, kind: detectedKind, reported: shouldReport };
}
