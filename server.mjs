import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  loadState,
  saveState,
  uid,
  readMemory,
  writeMemory,
  defaultQuota,
  defaultBilling,
  emptyUsage,
  quotaLabel,
  SOURCES,
  DATA_DIR,
  BOTS_DIR,
  GROUPS_DIR,
  UPLOADS_DIR,
  normalizeSource,
  repairSources,
  EFFORTS,
  AVATARS,
  pickAvatar,
  LEADER_PERSONA,
  DEFAULT_VOICE,
  normalizePermission,
  ensureGroupProjects,
  botWorkspace,
} from './lib/store.mjs';
import { runTurn, addMessage, compactChat, runWorkflowNode, setChatQueueRunner } from './lib/orchestrator.mjs';
import { childEnv, resolveCmd, killActiveChildren, reapOrphanChildren, ensureAgyHome, runBot } from './lib/agents.mjs';
import { registerEditor, unregisterEditor, takeEditorOps, ackEditorOp, touchEditor } from './lib/editor-bridge.mjs';
import {
  ensureUsageFile,
  summarizeUsage,
  summarizeUsageDetail,
  fetchBalances,
  providerSummaries,
  recordUsage,
} from './lib/usage.mjs';
import { syncMimoLogin, fetchMimoBalance } from './lib/mimo-sync.mjs';
import { initPricing, pricingMeta, creditsForRun, creditMoney } from './lib/pricing.mjs';
import { browserDiagnostics } from './lib/browser-cookies.mjs';
import { setupProxy } from './lib/net.mjs';
import { buildWorkflowHtml } from './lib/wf-export.mjs';
import { DEFAULT_FLOW_DESIGN_RULES } from './lib/flow-rules.mjs';
import { translateTexts, explainText, summarizeText, rewriteText } from './lib/translate.mjs';

const PORT = Number(process.env.PORT || 4820);
const PUBLIC = path.join(import.meta.dirname, 'public');
const state = loadState();

// 预先用 AI 生成好的技能大白话说明（按名字匹配；新装的技能可再调 /api/skills/explain 生成）
let STATIC_SKILL_SUMMARIES = {};
try {
  STATIC_SKILL_SUMMARIES = JSON.parse(
    fs.readFileSync(path.join(import.meta.dirname, 'lib/skill-summaries.json'), 'utf8')
  );
} catch {}

// 老数据只有一条 chat.workflow，补成可切换的流程列表
(function repairWorkflowSets() {
  let changed = false;
  for (const chat of state.chats || []) {
    if (chat.type !== 'group') continue;
    const before = JSON.stringify(chat.workflows || null) + '|' + (chat.activeWorkflowId || '');
    ensureWorkflowSet(chat);
    const after = JSON.stringify(chat.workflows || null) + '|' + (chat.activeWorkflowId || '');
    if (before !== after) changed = true;
  }
  if (changed) saveState(state);
})();

// 修掉私聊里把老板的话记成领导说的历史消息（多 Bot 私聊时的旧 bug）
(function repairDmAuthors() {
  let changed = false;
  const leaderId = state.settings?.leaderId;
  if (!leaderId) return;
  for (const chat of state.chats || []) {
    if (chat.type !== 'dm') continue;
    for (const m of state.messages?.[chat.id] || []) {
      if (m.senderId === leaderId && m.meta?.viaUser) {
        m.senderId = 'user';
        m.meta = null;
        changed = true;
      }
    }
  }
  if (changed) saveState(state);
})();

// 修掉历史数据里被存成 "[object Object]" 的模型列表
(function repairApiModels() {
  let changed = false;
  for (const bot of state.bots || []) {
    const api = bot.api;
    if (!api) continue;
    const before = Array.isArray(api.models) ? api.models : [];
    const fixed = [
      ...new Set(
        before
          .map((x) => {
            if (typeof x === 'string') return x.trim();
            if (x && typeof x === 'object') return String(x.id || x.name || x.model || '').trim();
            return '';
          })
          .filter((x) => x && x !== '[object Object]')
      ),
    ];
    if (!fixed.length && typeof bot.model === 'string' && bot.model.trim()) {
      fixed.push(bot.model.trim());
    }
    if (JSON.stringify(before) !== JSON.stringify(fixed)) {
      api.models = fixed;
      changed = true;
    }
  }
  if (changed) saveState(state);
})();

function addTombstone(entry) {
  state.deleted ||= [];
  state.deleted = state.deleted.filter(
    (x) => !(x.type === entry.type && x.id === entry.id)
  );
  state.deleted.push({ ...entry, deletedAt: Date.now() });
  if (state.deleted.length > 500) state.deleted = state.deleted.slice(-500);
}
const runtime = new Map();
Object.defineProperty(state, '__runtime', {
  value: runtime,
  enumerable: false,
  writable: true,
  configurable: true,
});

const ADMIN_BIN_DIR = path.join(DATA_DIR, 'bin');
const ADMIN_CLI_PATH = path.join(ADMIN_BIN_DIR, 'bt.mjs');
const ADMIN_MANUAL_PATH = path.join(DATA_DIR, 'admin.md');
function installAdminTools() {
  try {
    fs.mkdirSync(ADMIN_BIN_DIR, { recursive: true });
    const cli = fs.readFileSync(path.join(import.meta.dirname, 'lib/bt-cli.mjs'), 'utf8');
    fs.writeFileSync(ADMIN_CLI_PATH, cli, { mode: 0o755 });
    try {
      fs.chmodSync(ADMIN_CLI_PATH, 0o755);
    } catch {}
    const manual = fs.readFileSync(
      path.join(import.meta.dirname, 'lib/bot-team-admin.md'),
      'utf8'
    );
    fs.writeFileSync(ADMIN_MANUAL_PATH, manual);
  } catch (e) {
    console.error('[admin] install failed:', e?.message || e);
  }
}
installAdminTools();
process.env.BOT_TEAM_CLI = ADMIN_CLI_PATH;
process.env.BOT_TEAM_ADMIN_FILE = ADMIN_MANUAL_PATH;
ensureUsageFile(state);

const clients = new Set();
const queues = new Map();
const loopTimers = new Map();
const runAborts = new Map();
const workflowRuns = new Map();
const LOOP_PROMPT =
  '继续按当前目标推进。先检查上一轮交付和未完成事项，再继续做；不要重复已经完成的工作。如果全部完成，或必须老板决策才能继续，就在最后单独一行输出 @@DONE，系统会暂停自动运行。';
let pendingBrowser = null;
let shuttingDown = false;

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  killActiveChildren();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
let serverPort = PORT;
let tunnelProcess = null;
let tunnelUrl = '';
let tunnelStarting = null;
let tunnelError = '';
let tunnelWanted = false;
let tunnelRetries = 0;
let tailscaleIp = '';
let tailscaleCheckedAt = 0;

const TAILSCALE_BINS = [
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  '/opt/homebrew/bin/tailscale',
  '/usr/local/bin/tailscale',
];

function tailscaleBin() {
  for (const p of TAILSCALE_BINS) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {}
  }
  return '';
}

async function refreshTailscale() {
  if (Date.now() - tailscaleCheckedAt < 60000) return;
  tailscaleCheckedAt = Date.now();
  const bin = tailscaleBin();
  if (!bin) {
    tailscaleIp = '';
    return;
  }
  await new Promise((resolve) => {
    execFile(bin, ['ip', '-4'], { timeout: 4000, env: childEnv() }, (err, out) => {
      tailscaleIp = err ? '' : String(out || '').split('\n')[0].trim();
      resolve();
    });
  });
}

if (!state.settings.remoteToken) {
  state.settings.remoteToken = crypto.randomBytes(24).toString('hex');
  saveState(state);
}

function clientIp(req) {
  return String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
}

function isTunnelRequest(req) {
  return !!(req.headers['cf-connecting-ip'] || req.headers['cf-ray'] || req.headers['x-forwarded-for']);
}

function isLocalRequest(req) {
  if (isTunnelRequest(req)) return false;
  const ip = clientIp(req);
  return ip === '127.0.0.1' || ip === '::1' || ip === 'localhost';
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k) out[k] = decodeURIComponent(rest.join('=') || '');
  }
  return out;
}

function remoteToken() {
  return String(state.settings.remoteToken || '');
}

function lanUrls() {
  const urls = [];
  const port = serverPort;
  const token = remoteToken();
  for (const list of Object.values(os.networkInterfaces() || {})) {
    for (const net of list || []) {
      if (net.family !== 'IPv4' || net.internal) continue;
      urls.push(`http://${net.address}:${port}/m?token=${encodeURIComponent(token)}`);
    }
  }
  return urls;
}

function remoteStatus() {
  const token = remoteToken();
  const port = serverPort;
  const tailscaleUrls = tailscaleIp
    ? [`http://${tailscaleIp}:${port}/m?token=${encodeURIComponent(token)}`]
    : [];
  return {
    running: !!tunnelUrl,
    starting: !!tunnelStarting && !tunnelUrl,
    publicUrl: tunnelUrl,
    localUrls: lanUrls(),
    publicMobile: tunnelUrl ? `${tunnelUrl}/m?token=${encodeURIComponent(token)}` : '',
    error: tunnelError,
    port,
    token,
    auto: !!state.settings.remoteAuto,
    tailscaleInstalled: !!tailscaleBin(),
    tailscaleIp,
    tailscaleUrls,
    hasCloudflared: !!resolveCmd('cloudflared'),
  };
}

function remoteLoginPage() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Bot Team 登录</title><style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#12100e;color:#eee;font-family:-apple-system,sans-serif}
  form{width:min(88vw,340px);padding:22px;border-radius:18px;background:#1e1b19;border:1px solid #3a332e}
  h1{font-size:17px;margin:0 0 8px}p{font-size:12px;color:#9b958f;line-height:1.6}
  input{width:100%;box-sizing:border-box;margin:12px 0;padding:12px;border-radius:10px;border:1px solid #4a413a;background:#141210;color:#fff;font-size:14px}
  button{width:100%;padding:12px;border:none;border-radius:10px;background:#7c6cf5;color:#fff;font-size:14px;font-weight:600}
  </style></head><body><form method="get" action="/m">
  <h1>Bot Team 手机端</h1><p>输入桌面端「设置 → 手机远程」里显示的访问令牌。</p>
  <input name="token" placeholder="访问令牌" autocomplete="off" autofocus />
  <button type="submit">进入</button></form></body></html>`;
}

async function startTunnel() {
  tunnelWanted = true;
  if (tunnelUrl) return remoteStatus();
  if (tunnelStarting) return tunnelStarting;
  tunnelError = '';
  tunnelStarting = new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      tunnelStarting = null;
      resolve(remoteStatus());
    };
    try {
      const cmd = resolveCmd('cloudflared');
      tunnelProcess = spawn(cmd, ['tunnel', '--url', `http://127.0.0.1:${serverPort}`, '--no-autoupdate'], {
        env: childEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      done();
      return;
    }
    const onData = (d) => {
      const text = d.toString();
      const m = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
      if (m && !tunnelUrl) {
        tunnelUrl = m[0].replace(/\/$/, '');
        tunnelError = '';
        tunnelRetries = 0;
        emit('remote', remoteStatus());
        done();
      }
      if (!tunnelUrl && /status 429|provisioning failed|failed to request/i.test(text)) {
        tunnelError = 'Cloudflare 临时隧道被限流（429）。稍后再试，或改用命名隧道 / Tailscale。';
        emit('remote', remoteStatus());
        done();
      }
    };
    tunnelProcess.stdout?.on('data', onData);
    tunnelProcess.stderr?.on('data', onData);
    tunnelProcess.on('error', (e) => {
      tunnelError = `无法启动 cloudflared：${e.message}`;
      tunnelProcess = null;
      emit('remote', remoteStatus());
      done();
    });
    tunnelProcess.on('close', () => {
      tunnelProcess = null;
      const hadUrl = !!tunnelUrl;
      tunnelUrl = '';
      if (!hadUrl && !tunnelError) tunnelError = '隧道进程已退出，请检查 cloudflared。';
      emit('remote', remoteStatus());
      done();
      // 自动重连：只要还希望保持远程（开机自动模式或手动开启过），就退避重试
      if (tunnelWanted && !shuttingDown && tunnelRetries < 6) {
        tunnelRetries += 1;
        const wait = Math.min(30000, 3000 * tunnelRetries);
        setTimeout(() => {
          if (tunnelWanted && !tunnelUrl) {
            tunnelError = `隧道已断开，正在第 ${tunnelRetries} 次重连…`;
            startTunnel().catch(() => {});
          }
        }, wait);
      }
    });
    setTimeout(done, 15000);
  });
  return tunnelStarting;
}

function stopTunnel() {
  tunnelWanted = false;
  tunnelRetries = 0;
  if (tunnelProcess) {
    try {
      tunnelProcess.kill('SIGTERM');
    } catch {}
    tunnelProcess = null;
  }
  tunnelUrl = '';
  tunnelStarting = null;
  tunnelError = '';
}

function emit(event, data) {
  if (event === 'status' && data?.botId) {
    const prev = runtime.get(data.botId) || {};
    if (data.running) {
      runtime.set(data.botId, {
        ...prev,
        botId: data.botId,
        name: data.name || prev.name,
        chatId: data.chatId || prev.chatId,
        chatTitle: data.chatTitle || prev.chatTitle,
        running: true,
        queued: !!data.queued,
        task: data.task || prev.task,
        startedAt: data.queued
          ? prev.startedAt || Date.now()
          : prev.running
            ? prev.startedAt || Date.now()
            : Date.now(),
        lastError: data.error || (data.running ? null : prev.lastError),
      });
    } else {
      runtime.set(data.botId, {
        ...prev,
        botId: data.botId,
        name: data.name || prev.name,
        chatId: data.chatId || prev.chatId,
        chatTitle: data.chatTitle || prev.chatTitle,
        running: false,
        queued: false,
        endedAt: Date.now(),
        lastError: data.error || prev.lastError,
      });
    }
  }
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch {}
  }
}

function json(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(s);
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => {
      try {
        resolve(b ? JSON.parse(b) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function writeExportFile(name, ext, buf) {
  const home = os.homedir();
  const desktop = path.join(home, 'Desktop');
  const dir = fs.existsSync(desktop) ? desktop : home;
  const base =
    String(name || '流程图')
      .replace(/[\\/:*?"<>|\n\r]/g, '_')
      .slice(0, 80) || '流程图';
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  let file = path.join(dir, `${base}-${stamp}.${ext}`);
  let i = 2;
  while (fs.existsSync(file)) file = path.join(dir, `${base}-${stamp}-${i++}.${ext}`);
  fs.writeFileSync(file, buf);
  return file;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.zip': 'application/zip',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.ico': 'image/x-icon',
};

function serveUpload(req, res, pathname) {
  const m = pathname.match(/^\/uploads\/(avatars|wallpapers|files)\/([^/]+)$/);
  if (!m) return false;
  const file = path.join(UPLOADS_DIR, m[1], decodeURIComponent(m[2]));
  if (!file.startsWith(UPLOADS_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404);
    res.end('not found');
    return true;
  }
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, {
    'content-type': MIME[ext] || 'application/octet-stream',
    'cache-control': 'public, max-age=31536000, immutable',
  });
  fs.createReadStream(file).pipe(res);
  return true;
}

function uploadedAvatars() {
  const dir = path.join(UPLOADS_DIR, 'avatars');
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => /\.(png|jpe?g|webp|gif|avif)$/i.test(f))
      .sort()
      .map((f) => `/uploads/avatars/${encodeURIComponent(f)}`);
  } catch {
    return [];
  }
}

// 从市场下载或自己上传的壁纸都落在 uploads/wallpapers，随时可以再次选用。
function uploadedWallpapers() {
  const dir = path.join(UPLOADS_DIR, 'wallpapers');
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => /\.(png|jpe?g|webp|gif|avif)$/i.test(f))
      .sort()
      .reverse()
      .map((f) => `/uploads/wallpapers/${encodeURIComponent(f)}`);
  } catch {
    return [];
  }
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.join(PUBLIC, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  const ext = path.extname(file);
  const headers = { 'content-type': MIME[ext] || 'application/octet-stream' };
  if (['.html', '.js', '.css'].includes(ext)) headers['cache-control'] = 'no-store';
  res.writeHead(200, headers);
  fs.createReadStream(file).pipe(res);
}

function enqueue(chatId, fn) {
  const prev = queues.get(chatId) || Promise.resolve();
  const next = prev.then(fn).catch(() => {});
  queues.set(chatId, next);
  return next;
}

// 让编排层能把「私聊里被委派的任务」排到目标 Bot 自己的会话队列。
setChatQueueRunner((chatId, fn) => enqueue(chatId, fn));

// 统一入口：把一条「老板说的话」交给某个会话执行。消息接口和定时任务都走这里。
// 注意：消息必须在这里就落盘并推给前端。放进队列里再写，会让「插话」在上一轮跑完前
// 完全不可见（前端看不到、刷新后消失），这是之前用户反馈的直觉 bug。
function dispatchChatTurn(chat, text, attachments = [], context = '', selection = '') {
  const leader = state.settings?.leaderId
    ? state.bots.find((b) => b.id === state.settings.leaderId)
    : null;
  const asLeader = !!leader && chat.type !== 'dm';
  const userMsg = addMessage(state, chat.id, {
    senderId: asLeader ? leader.id : 'user',
    text,
    attachments,
    meta: asLeader ? { viaUser: true } : null,
  });
  saveState(state);
  emit('message', { chatId: chat.id, message: userMsg });
  return enqueue(chat.id, async () => {
    const ctrl = new AbortController();
    runAborts.set(chat.id, ctrl);
    try {
      await runTurn({
        state,
        chat,
        text,
        attachments,
        context,
        selection,
        preRecorded: true,
        uptoId: userMsg.id,
        save: () => saveState(state),
        emit,
        browser: runBrowserCommand,
        signal: ctrl.signal,
      });
    } finally {
      if (runAborts.get(chat.id) === ctrl) runAborts.delete(chat.id);
      emit('bots', { bots: state.bots.map(publicBot) });
      emit('chats', { chats: state.chats });
      if (chat.loop) scheduleLoop(chat, 2500);
    }
  });
}

/* ---------------- 定时任务 ---------------- */

const SCHEDULE_KINDS = ['daily', 'weekly', 'interval', 'once'];
const scheduleRunning = new Set();
let scheduleTimer = null;

function normalizeScheduleTime(t) {
  const m = String(t || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return '09:00';
  const h = Math.min(23, Math.max(0, Number(m[1])));
  const min = Math.min(59, Math.max(0, Number(m[2])));
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

function normalizeWeekdays(list) {
  const arr = (Array.isArray(list) ? list : [])
    .map((n) => Number(n))
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
  return [...new Set(arr.length ? arr : [1, 2, 3, 4, 5])].sort((a, b) => a - b);
}

// 计算下一次执行时间（都在本地时区）。算不出来就返回 null。
function computeNextRun(sch, from = Date.now()) {
  if (!sch || sch.enabled === false) return null;
  if (sch.kind === 'once') {
    const at = Number(sch.at) || 0;
    return at > from ? at : null;
  }
  if (sch.kind === 'interval') {
    const unit = sch.unit === 'hour' ? 3600000 : 60000;
    const every = Math.max(1, Math.min(10080, Number(sch.every) || 60));
    const base = Number(sch.lastRunAt) || Number(sch.createdAt) || from;
    let next = base + every * unit;
    if (next <= from) next = from + every * unit;
    return next;
  }
  const [hh, mm] = normalizeScheduleTime(sch.time).split(':').map(Number);
  const d = new Date(from);
  d.setSeconds(0, 0);
  if (sch.kind === 'weekly') {
    const days = normalizeWeekdays(sch.weekdays);
    for (let i = 0; i < 8; i += 1) {
      const cand = new Date(d);
      cand.setDate(d.getDate() + i);
      cand.setHours(hh, mm, 0, 0);
      if (cand.getTime() > from && days.includes(cand.getDay())) return cand.getTime();
    }
    return null;
  }
  const cand = new Date(d);
  cand.setHours(hh, mm, 0, 0);
  if (cand.getTime() <= from) cand.setDate(cand.getDate() + 1);
  return cand.getTime();
}

function publicSchedules() {
  return (state.schedules || [])
    .map((sch) => {
      const chat = state.chats.find((c) => c.id === sch.chatId);
      return {
        ...sch,
        chatTitle: chat
          ? chat.type === 'group'
            ? chat.title
            : `${state.bots.find((b) => b.id === chat.botIds?.[0])?.name || 'Bot'} · ${
                chat.project || '默认项目'
              }`
          : '（会话已删除）',
        chatType: chat?.type || '',
        chatMissing: !chat,
      };
    })
    .sort((a, b) => (a.nextRunAt || Infinity) - (b.nextRunAt || Infinity));
}

function repairSchedules() {
  state.schedules = Array.isArray(state.schedules) ? state.schedules : [];
  let changed = false;
  for (const sch of state.schedules) {
    if (!SCHEDULE_KINDS.includes(sch.kind)) {
      sch.kind = 'daily';
      changed = true;
    }
    if (sch.lastStatus === 'running') {
      sch.lastStatus = 'interrupted';
      changed = true;
    }
    if (!state.chats.some((c) => c.id === sch.chatId)) {
      sch.enabled = false;
      sch.nextRunAt = null;
      sch.lastError = '会话已删除';
      changed = true;
      continue;
    }
    if (sch.enabled === false) {
      if (sch.nextRunAt) {
        sch.nextRunAt = null;
        changed = true;
      }
      continue;
    }
    const next = computeNextRun(sch, Date.now());
    if (!next) {
      sch.enabled = false;
      sch.nextRunAt = null;
      if (sch.kind === 'once') sch.lastStatus = sch.lastStatus || 'missed';
      changed = true;
    } else if (next !== sch.nextRunAt) {
      sch.nextRunAt = next;
      changed = true;
    }
  }
  if (changed) saveState(state);
}

function fireSchedule(sch, { manual = false } = {}) {
  const chat = state.chats.find((c) => c.id === sch.chatId);
  if (!chat) throw new Error('会话已删除');
  if (scheduleRunning.has(sch.id)) return false;
  scheduleRunning.add(sch.id);
  const now = Date.now();
  sch.lastRunAt = now;
  sch.lastStatus = 'running';
  sch.lastError = '';
  if (!manual) {
    sch.nextRunAt = sch.kind === 'once' ? null : computeNextRun(sch, now);
    if (sch.kind === 'once') sch.enabled = false;
  } else if (sch.enabled && sch.kind !== 'once' && (!sch.nextRunAt || sch.nextRunAt <= now + 1000)) {
    // 手动执行后，如果下一次时间已经过去（或就在眼前），顺延到下一个周期，避免马上又自动跑一遍
    sch.nextRunAt = computeNextRun(sch, now);
  }
  saveState(state);
  const note = addMessage(state, chat.id, {
    type: 'system',
    text: `⏰ 定时任务「${sch.title}」${manual ? '手动触发' : '自动执行'}`,
  });
  saveState(state);
  emit('message', { chatId: chat.id, message: note });
  emit('schedules', { schedules: publicSchedules() });
  dispatchChatTurn(chat, sch.prompt, [])
    .then(() => {
      sch.lastStatus = 'ok';
    })
    .catch((e) => {
      sch.lastStatus = 'error';
      sch.lastError = String(e?.message || e).slice(0, 300);
    })
    .finally(() => {
      scheduleRunning.delete(sch.id);
      saveState(state);
      emit('schedules', { schedules: publicSchedules() });
    });
  return true;
}

function tickSchedules() {
  if (!state.schedules?.length) return;
  const now = Date.now();
  for (const sch of [...state.schedules]) {
    if (!sch.enabled || !sch.nextRunAt || sch.nextRunAt > now) continue;
    try {
      fireSchedule(sch);
    } catch {}
  }
}

function startScheduleTicker() {
  if (scheduleTimer) return;
  repairSchedules();
  scheduleTimer = setInterval(tickSchedules, 20000);
  setTimeout(tickSchedules, 4000);
}

function addGroupSystem(chat, text) {
  const m = addMessage(state, chat.id, { type: 'system', text });
  saveState(state);
  emit('message', { chatId: chat.id, message: m });
  return m;
}

function sanitizeWorkflow(chat, raw) {
  if (!raw || typeof raw !== 'object') return null;
  const inputNodes = Array.isArray(raw.nodes) ? raw.nodes : [];
  const ids = new Set();
  const nodes = [];
  for (let i = 0; i < inputNodes.length && nodes.length < 30; i++) {
    const n = inputNodes[i] || {};
    let id = String(n.id || uid('wfn')).slice(0, 80);
    if (ids.has(id)) id = uid('wfn');
    ids.add(id);
    const botId = chat.botIds.includes(n.botId)
      ? n.botId
      : chat.leadId && chat.botIds.includes(chat.leadId)
        ? chat.leadId
        : chat.botIds[0];
    if (!botId) continue;
    const nextRaw = Array.isArray(n.next) ? n.next : [];
    const next = nextRaw.slice(0, 8).map((e) => ({
      to: String(e?.to || '__end__'),
      when: ['always', 'success', 'error', 'keyword'].includes(e?.when)
        ? e.when
        : 'always',
      keyword: String(e?.keyword || '').slice(0, 120),
    }));
    nodes.push({
      id,
      title: String(n.title || `步骤 ${i + 1}`).slice(0, 80),
      botId,
      model: String(n.model || '').slice(0, 120),
      task: String(n.task || '').slice(0, 4000),
      role: ['collector', 'uploader', 'normal'].includes(n.role) ? n.role : 'normal',
      nextMode: ['next', 'branch', 'merge', 'loop', 'end'].includes(n.nextMode)
        ? n.nextMode
        : '',
      parallel: n.parallel && typeof n.parallel === 'object'
        ? {
            targets: Array.isArray(n.parallel.targets) ? n.parallel.targets : [],
            joinTo: String(n.parallel.joinTo || ''),
          }
        : null,
      stopWhen: String(n.stopWhen || '').slice(0, 120),
      allowEnd: n.allowEnd === true,
      next: next.length ? next : [{ to: '__end__', when: 'always', keyword: '' }],
    });
  }
  if (!nodes.length) return null;
  const nodeIds = new Set(nodes.map((n) => n.id));
  for (const n of nodes) {
    n.next = n.next.map((e) => ({
      ...e,
      to: e.to === '__end__' || nodeIds.has(e.to) ? e.to : '__end__',
    }));
    if (n.parallel && typeof n.parallel === 'object') {
      const targets = [
        ...new Set((n.parallel.targets || []).filter((id) => nodeIds.has(id) && id !== n.id)),
      ].slice(0, 8);
      const joinTo =
        nodeIds.has(n.parallel.joinTo) &&
        n.parallel.joinTo !== n.id &&
        !targets.includes(n.parallel.joinTo)
          ? n.parallel.joinTo
          : '';
      n.parallel = targets.length >= 2 ? { targets, joinTo } : null;
    } else {
      n.parallel = null;
    }
  }
  return {
    id: String(raw.id || uid('wf')).slice(0, 80),
    name: String(raw.name || '群流程').slice(0, 80),
    status: 'draft',
    startNodeId: nodeIds.has(raw.startNodeId) ? raw.startNodeId : nodes[0].id,
    maxSteps:
      Number(raw.maxSteps) === 0
        ? 0
        : Math.min(Math.max(Number(raw.maxSteps) || 50, 1), 200),
    nodes,
    history: [],
    createdAt: raw.createdAt || Date.now(),
    updatedAt: Date.now(),
  };
}

// 一个群可以保存多条流程，但同一时间只有 chat.workflow 是「当前流程」。
function ensureWorkflowSet(chat) {
  if (!chat || chat.type !== 'group') return;
  if (!Array.isArray(chat.workflows)) chat.workflows = chat.workflow ? [chat.workflow] : [];
  for (const wf of chat.workflows) if (!wf.id) wf.id = uid('wf');
  if (chat.workflow && !chat.workflows.some((w) => w.id === chat.workflow.id)) {
    chat.workflows.push(chat.workflow);
  }
  let active = chat.workflows.find((w) => w.id === chat.activeWorkflowId) || null;
  if (!active && chat.workflow) active = chat.workflow;
  if (!active) active = chat.workflows[0] || null;
  chat.workflow = active;
  chat.activeWorkflowId = active?.id || null;
}

function pickWorkflowNext(node, result) {
  for (const e of node.next || []) {
    if (!e.to) continue;
    if (e.when === 'always') return e;
    if (e.when === 'success' && result.ok) return e;
    if (e.when === 'error' && !result.ok) return e;
    if (e.when === 'keyword' && e.keyword && String(result.text || '').includes(e.keyword)) {
      return e;
    }
  }
  return null;
}

function nodeRole(node) {
  if (node?.role === 'collector' || node?.role === 'uploader') return node.role;
  const text = `${node?.title || ''} ${node?.task || ''}`;
  if (/上传|发布|提交|交付|入库|汇总上传|upload|publish|submit/i.test(text)) return 'uploader';
  if (/收集|采集|抓取|下载|整理|调研|搜集|collect|gather|scrape/i.test(text)) return 'collector';
  return 'normal';
}

// 工作流从「运行中」变成「不运行」时，强制交给领导 Bot 审查（手动停止/暂停/收尾除外）。
async function notifyLeaderWorkflowStop(chat, wf, finalStatus, run) {
  try {
    if (!wf) return;
    if (wf.pausedByUser) return;
    if (run?.manualStop || run?.pause || run?.drain) return;
    const leaderId = state.settings?.leaderId;
    if (!leaderId) return;
    const leader = state.bots.find((b) => b.id === leaderId);
    if (!leader) return;
    if (wf.reportInFlight) return;
    const dms = state.chats.filter((c) => c.type === 'dm' && (c.botIds || []).includes(leaderId));
    const dm =
      dms.find((c) => c.id === leader.lastChatId) ||
      dms.find((c) => (c.project || '') === '默认项目') ||
      dms[0];
    if (!dm) return;
    wf.reportInFlight = true;
    wf.lastStopReportAt = Date.now();
    wf.lastStopStatus = finalStatus;
    saveState(state);

    const lastSteps = (wf.history || [])
      .slice(-4)
      .map((h) => `${h.title}${h.ok ? ' 完成' : ' 失败'}${h.error ? `（${String(h.error).slice(0, 80)}）` : ''}`)
      .join('；');
    const resumeNode = wf.resume?.nodeId
      ? (wf.nodes || []).find((n) => n.id === wf.resume.nodeId)
      : null;
    const text = [
      '【工作流停止审查 · 强制】',
      `群：${chat.title}（chatId=${chat.id}）`,
      `流程：${wf.name || '未命名流程'}`,
      `结束状态：${finalStatus}${finalStatus === 'error' ? `（${wf.lastError || '未知错误'}）` : ''}`,
      `最后几步：${lastSteps || '没有执行记录'}`,
      `断点：${
        resumeNode
          ? `${resumeNode.title}（可执行 bt workflow-resume ${chat.id} 原地接上）`
          : '没有可用断点'
      }`,
      '',
      '请立刻判断：这是正常交付完成，还是异常中断？',
      '- 正常完成：核对最后一步的交付（上传/发布/版本号）确实完成后，简短回报，不要重启。',
      `- 异常中断：先排查原因（网络/额度/CLI），能修就修，然后执行 bt workflow-resume ${chat.id} 推动继续；修不了就说明卡在哪。`,
      '不要只解释，必须给出结论和动作。',
    ].join('\n');

    const note = addMessage(state, dm.id, {
      type: 'system',
      text: `工作流停止审查：${chat.title} · ${wf.name || '流程'}（${finalStatus}）`,
    });
    saveState(state);
    emit('message', { chatId: dm.id, message: note });

    enqueue(dm.id, async () => {
      const ctrl = new AbortController();
      runAborts.set(dm.id, ctrl);
      try {
        await runTurn({
          state,
          chat: dm,
          text,
          auto: true,
          save: () => saveState(state),
          emit,
          browser: runBrowserCommand,
          signal: ctrl.signal,
        });
      } catch {}
      finally {
        if (runAborts.get(dm.id) === ctrl) runAborts.delete(dm.id);
        wf.reportInFlight = false;
        saveState(state);
        emit('bots', { bots: state.bots.map(publicBot) });
        emit('chats', { chats: state.chats });
      }
    });
  } catch (e) {
    console.error('[workflow] leader notify failed:', e?.message || e);
  }
}

// 流程环节失败/空结果时，先请领导 Bot 判断并处理，而不是直接判死流程
async function superviseWorkflowFailure({ chat, wf, node, bot, result, run }) {
  try {
    const leaderId = state.settings?.leaderId;
    if (!leaderId || leaderId === bot.id) return null;
    const leader = state.bots.find((b) => b.id === leaderId);
    if (!leader || !chat.botIds.includes(leader.id)) return null;
    run.supervisor ||= { count: 0, nodes: {} };
    if (run.supervisor.count >= 3) return null;
    if ((run.supervisor.nodes[node.id] || 0) >= 1) return null;
    run.supervisor.nodes[node.id] = 1;
    run.supervisor.count += 1;

    const stepsText = (result.steps || [])
      .slice(-10)
      .map((x) => `· ${x.tool}${x.title ? `：${x.title}` : ''}`)
      .join('\n');
    const prompt = [
      `你是「${leader.name}」，Bot Team 的领导。`,
      `群「${chat.title}」的流程「${wf.name}」在环节「${node.title}」失败，执行者是 ${bot.name}（${bot.backend}）。`,
      `错误：${String(result.error || '没有返回内容').slice(0, 800)}`,
      stepsText ? `已执行的步骤：\n${stepsText}` : '',
      chat.announcement ? `群公告：\n${String(chat.announcement).slice(0, 1500)}` : '',
      '请先判断原因，能修就修：可以读写文件、执行命令、检查日志和上次产物。',
      '处理完在最后单独一行输出一个标记：',
      '@@FLOW_RETRY —— 问题已修好，重跑这个环节',
      '@@FLOW_TAKEOVER —— 你直接把这个环节做完（把结果写在标记前面）',
      '@@FLOW_PAUSE —— 需要老板确认，先暂停流程',
      '只处理这一处，不要重跑整个流程，不要输出其他标记。',
    ]
      .filter(Boolean)
      .join('\n');

    addGroupSystem(
      chat,
      `流程故障：${node.title} · ${bot.name} 失败，按规则请领导 ${leader.name} 介入判断`
    );
    const res = await runBot({
      bot: leader,
      prompt,
      sessionId: null,
      cwd: botWorkspace(leader.id),
      effort: 'auto',
      permission: leader.permission,
      signal: run.controller?.signal,
      apiKey: state.providerKeys?.[`botapi:${leader.id}`] || '',
      timeoutMs: 0,
    });
    const raw = String(res.text || '').trim();
    const supCredit = creditsForRun({
      backend: leader.backend,
      model: leader.model,
      usage: res.usage,
      credits: res.credits,
      settings: state.settings,
    });
    recordUsage(state, {
      bot: leader,
      chat,
      usage: res.usage,
      kind: 'workflow',
      model: leader.model,
      credits: res.credits,
      creditsEstimated: supCredit?.estimated,
    });
    const action = /@@FLOW_TAKEOVER/.test(raw)
      ? 'takeover'
      : /@@FLOW_RETRY/.test(raw)
        ? 'retry'
        : /@@FLOW_PAUSE/.test(raw)
          ? 'pause'
          : 'pause';
    const clean = raw.replace(/@@FLOW_(RETRY|TAKEOVER|PAUSE)/g, '').trim();
    const msg = addMessage(state, chat.id, {
      senderId: leader.id,
      type: 'text',
      text: `【流程故障处理】${clean || '已介入处理。'}`,
      meta: {
        supervisor: true,
        action,
        node: node.title,
        ...(supCredit && supCredit.credits > 0
          ? {
              credits: supCredit.credits,
              creditUnit: supCredit.unit,
              creditsEstimated: supCredit.estimated,
              creditCost: creditMoney(leader.backend, supCredit.credits, state.settings),
            }
          : {}),
      },
    });
    saveState(state);
    emit('message', { chatId: chat.id, message: msg });
    emit('bots', { bots: state.bots.map(publicBot) });
    return { action, text: clean, leader };
  } catch (e) {
    console.error('[workflow] supervisor failed:', e?.message || e);
    return null;
  }
}

async function runWorkflow(chat, run, boot = {}) {
  const wf = chat.workflow;
  let nodeId = boot.startNodeId || wf.startNodeId;
  let previous = boot.input || '';
  let fromNodeTitle = boot.fromNodeTitle || '';
  let fromBotName = boot.fromBotName || '';
  let steps = Number(boot.steps) || 0;
  let round = Number(boot.round) || Number(wf.round) || 1;
  let justResumed = !!boot.resumed;
  wf.round = round;

  // 断点续跑：每推进一步就把「下一个要跑的环节 + 交接内容 + 未上传产物」写进 wf.resume，
  // 应用重启或中途停掉后可以从这里原地接上。
  const persistResume = (next) => {
    if (!next?.nodeId) {
      wf.resume = null;
      return;
    }
    wf.resume = {
      nodeId: next.nodeId,
      input: String(next.input || '').slice(0, 12000),
      fromNodeTitle: next.fromNodeTitle || '',
      fromBotName: next.fromBotName || '',
      pending: (run.pending || []).slice(-12),
      steps,
      round,
      at: Date.now(),
    };
  };
  let finalStatus = 'done';
  const maxStepsNow = () => (Number(wf.maxSteps) > 0 ? Number(wf.maxSteps) : 0);
  const maxLabel = maxStepsNow() || '不限';
  const mergeStates = new Map();
  const incomingCount = (targetId) =>
    wf.nodes.reduce(
      (count, n) => count + (n.next || []).filter((e) => e.to === targetId).length,
      0
    );
  const recordBranch = (n, b, res) => {
    wf.history ||= [];
    wf.history.push({
      nodeId: n.id,
      title: n.title,
      botId: b.id,
      ok: !!res.ok,
      text: String(res.text || '').slice(0, 1200),
      error: res.error || '',
      at: Date.now(),
      parallel: true,
    });
    if (wf.history.length > 60) wf.history = wf.history.slice(-60);
    if (res.ok) {
      const rec = {
        id: n.id,
        title: n.title,
        bot: b.name,
        text: String(res.text || '').slice(0, 3000),
      };
      run.outputs[n.id] = rec;
      if (nodeRole(n) === 'uploader') run.pending = [];
      else {
        run.pending.push(rec);
        if (run.pending.length > 60) run.pending = run.pending.slice(-60);
      }
    }
  };
  // 流程图交接既是「Bot 之间说话」，也在每个当事人 Bot 的项目页留同一张卡片。
  const mirrorHandoffToBots = (fromId, toId, text, meta) => {
    for (const botId of [...new Set([fromId, toId].filter(Boolean))]) {
      const dm = state.chats.find(
        (c) =>
          c.type === 'dm' &&
          c.linkedGroupId === chat.id &&
          (c.botIds || []).includes(botId)
      );
      if (!dm) continue;
      const copy = addMessage(state, dm.id, {
        type: 'handoff',
        senderId: fromId,
        toId,
        text,
        meta: { ...meta, mirrored: true, groupTitle: chat.title },
      });
      emit('message', { chatId: dm.id, message: copy });
    }
  };
  const addParallelHandoff = (fromBot, fromNode, toBot, toNode, merge = false, preview = '') => {
    const text = merge
      ? `@${toBot.name} 并行分支「${fromNode.title}」已到达汇合点「${toNode.title}」。`
      : `@${toBot.name} 并行分支「${fromNode.title}」已完成，交给「${toNode.title}」。`;
    const message = addMessage(state, chat.id, {
      senderId: fromBot.id,
      toId: toBot.id,
      type: 'text',
      text,
      meta: {
        handoff: true,
        parallel: true,
        merge,
        fromNode: fromNode.title,
        toNode: toNode.title,
        fromBot: fromBot.name,
        toBot: toBot.name,
        preview: String(preview || '').slice(0, 1500),
      },
    });
    saveState(state);
    emit('message', { chatId: chat.id, message });
    mirrorHandoffToBots(fromBot.id, toBot.id, text, message.meta);
  };
  const runBranch = async (startId, input, fromTitle, fromBot) => {
    let nodeId = startId;
    let prev = input;
    let ft = fromTitle;
    let fb = fromBot;
    const releaseMergeWaiters = () => {
      for (const st of mergeStates.values()) st.waiters.forEach((resolve) => resolve());
      mergeStates.clear();
    };
    while (nodeId && !run.cancel) {
      if (run.pause) {
        releaseMergeWaiters();
        return { ok: false, paused: true, error: '已暂停' };
      }
      if (maxStepsNow() && steps >= maxStepsNow()) {
        return { ok: false, limit: true, error: `达到最多运行步数（${maxStepsNow()}）` };
      }
      const n = wf.nodes.find((x) => x.id === nodeId);
      const b = n
        ? state.bots.find((x) => x.id === n.botId && chat.botIds.includes(x.id))
        : null;
      if (!n || !b) return { ok: false, error: '并行分支没有可用的 Bot' };
      steps += 1;
      const res = await runWorkflowNode({
        state,
        chat,
        node: n,
        bot: b,
        input: prev,
        fromNodeTitle: ft,
        fromBotName: fb,
        signal: run.controller.signal,
        shouldPause: () => !!run.pause,
        save: () => saveState(state),
        emit,
      });
      recordBranch(n, b, res);
      if (res.paused) {
        releaseMergeWaiters();
        return { ok: false, paused: true, error: '已暂停', node: n };
      }
      if (!res.ok) {
        releaseMergeWaiters();
        return { ok: false, error: res.error || '并行分支环节失败', text: res.text, node: n };
      }
      const edge = pickWorkflowNext(n, res);
      if (!edge || edge.to === '__end__') return { ok: true, text: res.text, node: n, bot: b };
      const next = wf.nodes.find((x) => x.id === edge.to);
      const nb = next
        ? state.bots.find((x) => x.id === next.botId && chat.botIds.includes(x.id))
        : null;
      if (!next || !nb) {
        releaseMergeWaiters();
        return { ok: false, error: '并行分支找不到下一步' };
      }
      const indeg = incomingCount(next.id);
      if (indeg >= 2) {
        let st = mergeStates.get(next.id);
        if (!st) {
          st = { expected: indeg, arrived: [], waiters: [] };
          mergeStates.set(next.id, st);
        }
        addParallelHandoff(b, n, nb, next, true, res.text);
        st.arrived.push({ node: n, bot: b, res });
        if (st.arrived.length < st.expected) {
          await new Promise((resolve) => st.waiters.push(resolve));
          return { ok: true, text: res.text, node: n, bot: b };
        }
        const combined = st.arrived
          .map(
            (a, i) =>
              `【并行 ${i + 1}/${st.arrived.length} · ${a.node.title} · ${
                a.bot.name
              }】\n${String(a.res.text || '').slice(0, 3500)}`
          )
          .join('\n\n')
          .slice(0, 15000);
        addGroupSystem(
          chat,
          `并行汇合：「${next.title}」收到 ${st.arrived.length} 个分支结果，按顺序处理`
        );
        steps += 1;
        const mergeRes = await runWorkflowNode({
          state,
          chat,
          node: next,
          bot: nb,
          input: combined,
          fromNodeTitle: n.title,
          fromBotName: b.name,
          signal: run.controller.signal,
          shouldPause: () => !!run.pause,
          save: () => saveState(state),
          emit,
        });
        recordBranch(next, nb, mergeRes);
        st.waiters.forEach((resolve) => resolve());
        // 汇合点每跑完一次就清掉状态，否则下一轮会带着上一轮的分支结果重复汇合
        mergeStates.delete(next.id);
        if (!mergeRes.ok) {
          // 汇合环节失败：断点记在汇合点，继续流程时只需重跑它
          persistResume({
            nodeId: next.id,
            input: combined,
            fromNodeTitle: n.title,
            fromBotName: b.name,
          });
          saveState(state);
          return {
            ok: false,
            error: mergeRes.error || '汇合环节失败',
            text: mergeRes.text,
            node: next,
          };
        }
        if (nodeRole(next) === 'uploader') run.pending = [];
        const mEdge = pickWorkflowNext(next, mergeRes);
        if (!mEdge || mEdge.to === '__end__') {
          return { ok: true, text: mergeRes.text, node: next, bot: nb };
        }
        // 汇合之后不要在这个分支里继续跑，交回外层循环，
        // 否则循环回到起点后遇到并行节点会走错路径（第二轮刚开始就结束）。
        return {
          ok: true,
          text: mergeRes.text,
          node: next,
          bot: nb,
          cont: {
            nodeId: mEdge.to,
            input: mergeRes.text || '',
            fromTitle: next.title,
            fromBot: nb.name,
          },
        };
      }
      addParallelHandoff(b, n, nb, next, false, res.text);
      prev = res.text || '';
      ft = n.title;
      fb = b.name;
      nodeId = edge.to;
    }
    return { ok: false, aborted: true };
  };
  try {
    while (nodeId && !run.cancel) {
      if (run.pause) {
        finalStatus = 'paused';
        const nextNode = wf.nodes.find((n) => n.id === nodeId);
        addGroupSystem(
          chat,
          `流程已暂停：下次从「${nextNode?.title || '下一环节'}」继续，已完成的环节不会重跑。`
        );
        break;
      }
      if (maxStepsNow() && steps >= maxStepsNow()) {
        finalStatus = 'stopped';
        wf.lastError = '';
        addGroupSystem(chat, `流程已停止：达到最多运行步数（${maxStepsNow()}）`);
        break;
      }
      if (steps > 0 && nodeId === wf.startNodeId) {
        if (justResumed) {
          justResumed = false;
        } else {
          round += 1;
          wf.round = round;
          saveState(state);
          emit('chats', { chats: state.chats });
          addGroupSystem(chat, `进入第 ${round} 轮循环`);
        }
      } else {
        justResumed = false;
      }
      const node = wf.nodes.find((n) => n.id === nodeId);
      if (!node) {
        finalStatus = 'error';
        wf.lastError = '找不到下一个环节';
        addGroupSystem(chat, `流程出错：${wf.lastError}`);
        break;
      }
      let bot = state.bots.find(
        (b) => b.id === node.botId && chat.botIds.includes(b.id)
      );
      if (!bot) {
        finalStatus = 'error';
        wf.lastError = `环节「${node.title}」没有可用的 Bot`;
        addGroupSystem(chat, `流程出错：${wf.lastError}`);
        break;
      }
      steps += 1;
      wf.status = 'running';
      wf.currentNodeId = node.id;
      persistResume({
        nodeId: node.id,
        input: previous,
        fromNodeTitle,
        fromBotName,
      });
      saveState(state);
      emit('chats', { chats: state.chats });
      addGroupSystem(
        chat,
        `第 ${round} 轮 · 第 ${steps} 步 · ${node.title} · ${bot.name}${
          node.model ? ` · ${node.model}` : ''
        }`
      );

      let result = await runWorkflowNode({
        state,
        chat,
        node,
        bot,
        input: previous,
        fromNodeTitle,
        fromBotName,
        drainMode: !!run.drain && node.id === run.drain.finishNodeId,
        signal: run.controller.signal,
        shouldPause: () => !!run.pause,
        save: () => saveState(state),
        emit,
      });

      // 失败或空结果：先让领导 Bot 判断是重跑、接手还是暂停
      let supervisorPaused = false;
      if (result.paused) {
        supervisorPaused = true;
        finalStatus = 'paused';
        addGroupSystem(chat, `流程已暂停：下次从「${node.title}」继续，已完成的环节不会重跑。`);
      }
      if (!result.ok && !result.paused && !run.cancel && !result.aborted) {
        const decision = await superviseWorkflowFailure({
          chat,
          wf,
          node,
          bot,
          result,
          run,
        });
        if (decision) {
          if (decision.action === 'pause') {
            supervisorPaused = true;
            finalStatus = 'paused';
            wf.pauseRequested = false;
            wf.lastError = result.error || '需要人工确认';
            addGroupSystem(
              chat,
              `流程已暂停：领导判断需要老板确认（${String(
                decision.text || result.error || '环节失败'
              ).slice(0, 160)}）。修好后点「继续流程」从本环节接上。`
            );
          } else if (decision.action === 'takeover') {
            addGroupSystem(chat, `领导 ${decision.leader.name} 直接接手「${node.title}」`);
            bot = decision.leader;
            result = await runWorkflowNode({
              state,
              chat,
              node,
              bot: decision.leader,
              input: previous,
              fromNodeTitle: '故障接手',
              fromBotName: bot.name,
              signal: run.controller.signal,
              save: () => saveState(state),
              emit,
            });
          } else {
            addGroupSystem(chat, `领导 ${decision.leader.name} 已处理，重跑「${node.title}」`);
            result = await runWorkflowNode({
              state,
              chat,
              node,
              bot,
              input: previous,
              fromNodeTitle,
              fromBotName,
              drainMode: !!run.drain && node.id === run.drain.finishNodeId,
              signal: run.controller.signal,
              save: () => saveState(state),
              emit,
            });
          }
        }
      }

      wf.history ||= [];
      wf.history.push({
        nodeId: node.id,
        title: node.title,
        botId: bot.id,
        ok: !!result.ok,
        text: String(result.text || '').slice(0, 1200),
        error: result.error || '',
        at: Date.now(),
      });
      if (wf.history.length > 30) wf.history = wf.history.slice(-30);
      saveState(state);
      emit('chats', { chats: state.chats });
      if (supervisorPaused) break;

      if (run.cancel || result.aborted) {
        finalStatus = 'stopped';
        break;
      }
      if (result.ok) {
        const rec = {
          id: node.id,
          title: node.title,
          bot: bot.name,
          text: String(result.text || '').slice(0, 3000),
        };
        run.outputs[node.id] = rec;
        if (nodeRole(node) === 'uploader') run.pending = [];
        else {
          run.pending.push(rec);
          if (run.pending.length > 60) run.pending = run.pending.slice(-60);
        }
      }
      if (run.drain) {
        const finish = run.drain.finishNodeId
          ? wf.nodes.find((n) => n.id === run.drain.finishNodeId)
          : null;
        if (!result.ok) {
          finalStatus = 'error';
          wf.lastError = result.error || '收尾环节失败';
          addGroupSystem(chat, `平滑收尾失败：${node.title} · ${wf.lastError}`);
          break;
        }
        if (!finish) {
          finalStatus = 'done';
          addGroupSystem(chat, `平滑收尾完成：「${node.title}」已完成，循环结束`);
          break;
        }
        if (node.id === finish.id || run.drainFinishQueued) {
          finalStatus = 'done';
          addGroupSystem(chat, `平滑收尾完成：「${finish.title}」已完成，循环结束`);
          break;
        }
        const finishBot = state.bots.find(
          (b) => b.id === finish.botId && chat.botIds.includes(b.id)
        );
        if (!finishBot) {
          finalStatus = 'error';
          wf.lastError = `收尾环节「${finish.title}」没有可用的 Bot`;
          addGroupSystem(chat, `平滑收尾失败：${wf.lastError}`);
          break;
        }
        run.drainFinishQueued = true;
        const pendingText = run.pending
          .map((p) => `【${p.title} · ${p.bot}】\n${p.text}`)
          .join('\n\n')
          .slice(0, 12000);
        const action = /上传|交付|发布|提交/.test(finish.title) ? '上传/交付' : '处理';
        const handoffText = `@${finishBot.name} 循环收尾：请把大家已完成的结果统一${action}，完成后结束循环。`;
        const hm = addMessage(state, chat.id, {
          senderId: bot.id,
          toId: finishBot.id,
          type: 'text',
          text: handoffText,
          meta: {
            handoff: true,
            drain: true,
            fromNode: node.title,
            toNode: finish.title,
            fromBot: bot.name,
            toBot: finishBot.name,
            preview: pendingText.slice(0, 1500),
          },
        });
        saveState(state);
        emit('message', { chatId: chat.id, message: hm });
        mirrorHandoffToBots(bot.id, finishBot.id, handoffText, hm.meta);
        addGroupSystem(chat, `平滑收尾 · 「${node.title}」完成 · 交给 ${finishBot.name} → ${finish.title}`);
        fromNodeTitle = node.title;
        fromBotName = bot.name;
        previous = pendingText || result.text || '';
        persistResume({
          nodeId: finish.id,
          input: previous,
          fromNodeTitle: node.title,
          fromBotName: bot.name,
        });
        saveState(state);
        nodeId = finish.id;
        continue;
      }
      if (result.ok && node.parallel?.targets?.length) {
        const targets = node.parallel.targets.filter((id) => wf.nodes.some((n) => n.id === id));
        if (targets.length < 2) {
          finalStatus = 'error';
          wf.lastError = '并行分支至少需要两个有效环节';
          addGroupSystem(chat, `流程出错：${wf.lastError}`);
          break;
        }
        addGroupSystem(
          chat,
          `并行分支开始：${targets
            .map((id) => wf.nodes.find((n) => n.id === id)?.title || '?')
            .join('、')}`
        );
        const branchResults = await Promise.all(
          targets.map((id) => runBranch(id, result.text || '', node.title, bot.name))
        );
        if (run.cancel) {
          finalStatus = 'stopped';
          break;
        }
        if (branchResults.some((r) => r.paused)) {
          finalStatus = 'paused';
          addGroupSystem(chat, '流程已暂停：并行分支已停下，进度会保留，可以稍后继续。');
          break;
        }
        const okCount = branchResults.filter((r) => r.ok).length;
        if (!okCount) {
          finalStatus = 'error';
          wf.lastError = '所有并行分支都失败了';
          addGroupSystem(chat, `流程出错：${wf.lastError}`);
          break;
        }
        if (branchResults.some((r) => r.limit)) {
          finalStatus = 'stopped';
          addGroupSystem(chat, `流程已停止：并行分支达到最多运行步数（${maxLabel}）`);
          break;
        }
        if (run.drain) {
          finalStatus = 'done';
          addGroupSystem(chat, `平滑收尾完成：并行分支已全部处理，循环结束`);
          break;
        }
        const cont = branchResults.map((r) => r.cont).find(Boolean);
        const failedBranch = branchResults.find((r) => !r.ok && !r.paused);
        if (!cont && failedBranch) {
          finalStatus = 'error';
          wf.lastError = `${failedBranch.node?.title || '并行分支'}：${
            failedBranch.error || '没有返回内容'
          }`;
          addGroupSystem(
            chat,
            `流程中断：${failedBranch.node?.title || '并行分支'} 失败 · ${
              failedBranch.error || '没有返回内容'
            }。修好后点「继续流程」会从这个环节接着跑。`
          );
          break;
        }
        if (cont) {
          const contIdx = wf.nodes.findIndex((x) => x.id === cont.nodeId);
          const curIdx = wf.nodes.findIndex((x) => x.id === node.id);
          if (contIdx >= 0 && contIdx <= curIdx && cont.nodeId !== wf.startNodeId) {
            round += 1;
            wf.round = round;
            saveState(state);
            emit('chats', { chats: state.chats });
            addGroupSystem(chat, `进入第 ${round} 轮循环`);
          }
          addGroupSystem(
            chat,
            `并行分支完成：${okCount}/${branchResults.length} 成功 → 继续 ${cont.nodeId === wf.startNodeId ? '下一轮' : '下一步'}`
          );
          previous = cont.input || '';
          fromNodeTitle = cont.fromTitle || '';
          fromBotName = cont.fromBot || '';
          persistResume({
            nodeId: cont.nodeId,
            input: previous,
            fromNodeTitle,
            fromBotName,
          });
          saveState(state);
          nodeId = cont.nodeId;
          continue;
        }
        finalStatus = 'done';
        addGroupSystem(chat, `并行分支完成：${okCount}/${branchResults.length} 成功`);
        break;
      }
      if (result.ok && result.flowEnd) {
        finalStatus = 'done';
        addGroupSystem(chat, `「${node.title}」标记整个流程完成（@@FLOW_END）`);
        break;
      }
      if (node.stopWhen && String(result.text || '').includes(node.stopWhen)) {
        finalStatus = 'done';
        addGroupSystem(chat, `「${node.title}」命中停止条件「${node.stopWhen}」→ 整个流程结束`);
        break;
      }
      const edge = pickWorkflowNext(node, result);
      if (!result.ok) {
        // 失败分支：如果配置了 error / always 分支就继续走，否则整个流程报错停止
        if (edge && edge.to !== '__end__') {
          previous = result.text || result.error || '';
          fromNodeTitle = node.title;
          fromBotName = bot.name;
          nodeId = edge.to;
          continue;
        }
        finalStatus = 'error';
        wf.lastError = result.error || '流程环节失败';
        addGroupSystem(chat, `流程出错：${node.title} · ${wf.lastError}`);
        break;
      }
      if (!edge || edge.to === '__end__') {
        finalStatus = 'done';
        addGroupSystem(chat, `「${node.title}」已完成 → 流程结束（没有下一步）`);
        break;
      }
      const nextNode = wf.nodes.find((n) => n.id === edge.to);
      const nextBot = nextNode
        ? state.bots.find((b) => b.id === nextNode.botId && chat.botIds.includes(b.id))
        : null;
      if (nextNode && nextBot) {
        const fromIdx = wf.nodes.findIndex((n) => n.id === node.id);
        const toIdx = wf.nodes.findIndex((n) => n.id === nextNode.id);
        const isLoop = toIdx <= fromIdx;
        if (isLoop && edge.to !== wf.startNodeId && (!maxStepsNow() || steps < maxStepsNow())) {
          round += 1;
          wf.round = round;
          saveState(state);
          emit('chats', { chats: state.chats });
          addGroupSystem(chat, `进入第 ${round} 轮循环`);
        }
        const handoffText = isLoop
          ? `@${nextBot.name} 请重新开始「${nextNode.title}」（循环）。\n「${node.title}」已经完成，结果已交回给你。`
          : `@${nextBot.name} 请开始「${nextNode.title}」。\n「${node.title}」已经完成，上一环节的结果已交接给你。`;
        const hm = addMessage(state, chat.id, {
          senderId: bot.id,
          toId: nextBot.id,
          type: 'text',
          text: handoffText,
          meta: {
            handoff: true,
            loop: isLoop,
            fromNode: node.title,
            toNode: nextNode.title,
            fromBot: bot.name,
            toBot: nextBot.name,
            preview: String(result.text || '').slice(0, 1500),
          },
        });
        saveState(state);
        emit('message', { chatId: chat.id, message: hm });
        mirrorHandoffToBots(bot.id, nextBot.id, handoffText, hm.meta);
      }
      fromNodeTitle = node.title;
      fromBotName = bot.name;
      previous = result.text || '';
      persistResume({
        nodeId: edge.to,
        input: previous,
        fromNodeTitle: node.title,
        fromBotName: bot.name,
      });
      saveState(state);
      nodeId = edge.to;
    }
    if (run.cancel) finalStatus = 'stopped';
  } catch (e) {
    finalStatus = 'error';
    wf.lastError = String(e?.message || e).slice(0, 500);
    addGroupSystem(chat, `流程出错：${wf.lastError}`);
  } finally {
    wf.status = finalStatus;
    wf.currentNodeId = null;
    wf.finishedAt = Date.now();
    wf.pauseRequested = false;
    if (finalStatus === 'done') wf.resume = null;
    saveState(state);
    emit('chats', { chats: state.chats });
    workflowRuns.delete(chat.id);
    void notifyLeaderWorkflowStop(chat, wf, finalStatus, run);
    if (finalStatus === 'done') {
      addGroupSystem(chat, `流程完成：${wf.name}（${steps} 步）`);
    } else if (finalStatus === 'paused') {
      addGroupSystem(chat, `流程已暂停：${wf.name}，进度已保留，可以稍后继续`);
    } else if (finalStatus === 'stopped') {
      addGroupSystem(chat, `流程已停止：${wf.name}`);
    } else {
      addGroupSystem(
        chat,
        `流程结束（有错误）：${wf.name}${wf.lastError ? ` · ${wf.lastError}` : ''}`
      );
    }
  }
}

function drainWorkflow(chat, { reason = '', nodeId = '' } = {}) {
  const run = workflowRuns.get(chat.id);
  if (!run) return { error: '这个流程没有在运行' };
  if (run.cancel) return { error: '流程已经停止' };
  const wf = chat.workflow;
  if (run.drain) {
    return { ok: true, already: true, finishNodeId: run.drain.finishNodeId || '' };
  }
  let finish = nodeId ? wf.nodes.find((n) => n.id === nodeId) : null;
  if (!finish) {
    finish = [...wf.nodes].reverse().find((n) => nodeRole(n) === 'uploader') || null;
  }
  const current = wf.nodes.find((n) => n.id === wf.currentNodeId);
  run.drain = {
    requestedAt: Date.now(),
    reason: String(reason || '').slice(0, 300),
    finishNodeId: finish?.id || '',
    finishTitle: finish?.title || '',
  };
  run.drainFinishQueued = false;
  wf.status = 'draining';
  wf.drain = { ...run.drain };
  wf.lastError = '';
  saveState(state);
  emit('chats', { chats: state.chats });
  let msg;
  if (finish && current && current.id === finish.id) {
    msg = `收到平滑收尾请求：当前上传/交付环节「${finish.title}」完成后，循环结束。`;
  } else if (finish) {
    msg = `收到平滑收尾请求：当前环节「${current?.title || '进行中'}」会先完成，然后交给「${finish.title}」统一上传/交付，完成后循环结束。`;
  } else {
    msg = `收到平滑收尾请求：当前环节完成后停止循环，不再开始新一轮。`;
  }
  addGroupSystem(chat, msg);
  return {
    ok: true,
    finishNodeId: finish?.id || '',
    finishTitle: finish?.title || '',
    currentNodeId: current?.id || '',
  };
}

function startWorkflow(chat, { resume = false } = {}) {
  if (workflowRuns.has(chat.id)) return { error: '流程正在运行' };
  const wf = chat.workflow;
  if (!wf?.nodes?.length) return { error: '这个群还没有发布流程' };
  const saved = resume ? wf.resume : null;
  if (resume && !saved?.nodeId) return { error: '没有可续跑的进度，只能重新开始' };
  const startNode = saved ? wf.nodes.find((n) => n.id === saved.nodeId) : null;
  if (resume && !startNode) return { error: '上次中断的环节已经不在了，只能重新开始' };
  stopLoop(chat);
  chat.loop = false;
  const controller = new AbortController();
  const run = {
    controller,
    cancel: false,
    round: saved ? Number(saved.round) || Number(wf.round) || 1 : 1,
    supervisor: { count: 0, nodes: {} },
    steps: saved ? Number(saved.steps) || 0 : 0,
    startedAt: Date.now(),
    outputs: {},
    pending: saved?.pending ? [...saved.pending] : [],
    drain: null,
    drainFinishQueued: false,
  };
  workflowRuns.set(chat.id, run);
  wf.status = 'running';
  wf.pausedByUser = false;
  wf.currentNodeId = saved ? saved.nodeId : wf.startNodeId;
  if (!resume) {
    wf.history = [];
    wf.startedAt = Date.now();
    wf.resume = null;
    wf.round = 1;
  } else {
    wf.round = run.round;
  }
  wf.finishedAt = null;
  wf.lastError = '';
  saveState(state);
  emit('chats', { chats: state.chats });
  addGroupSystem(
    chat,
    resume
      ? `流程继续：第 ${run.round} 轮，从「${startNode.title}」接着跑（已执行 ${run.steps} 步）`
      : `流程开始：第 1 轮 · ${wf.name}（${wf.nodes.length} 个环节）`
  );
  void runWorkflow(
    chat,
    run,
    saved
      ? {
          startNodeId: saved.nodeId,
          input: saved.input,
          fromNodeTitle: saved.fromNodeTitle,
          fromBotName: saved.fromBotName,
          steps: run.steps,
          round: run.round,
          resumed: true,
        }
      : {}
  );
  return { ok: true, resumed: !!resume, from: startNode?.title || '' };
}

function pauseWorkflow(chat) {
  const run = workflowRuns.get(chat.id);
  const wf = chat.workflow;
  if (!run) {
    if (wf && ['running', 'draining'].includes(wf.status)) {
      wf.status = 'paused';
      wf.drain = null;
      saveState(state);
      emit('chats', { chats: state.chats });
      return { ok: true, already: false };
    }
    return { error: '这个流程没有在运行' };
  }
  run.pause = true;
  run.manualStop = true;
  if (wf) {
    wf.pauseRequested = true;
    wf.pausedByUser = true;
  }
  saveState(state);
  emit('chats', { chats: state.chats });
  addGroupSystem(
    chat,
    '收到暂停请求：当前环节完成后暂停，进度会保留；回来说「继续」就能从断点接上。'
  );
  return { ok: true };
}

function stopWorkflow(chat) {
  const run = workflowRuns.get(chat.id);
  if (run) {
    run.cancel = true;
    run.manualStop = true;
    try {
      run.controller.abort();
    } catch {}
    return { ok: true };
  }
  if (chat.workflow?.status === 'running') {
    chat.workflow.status = 'stopped';
    chat.workflow.currentNodeId = null;
    saveState(state);
    emit('chats', { chats: state.chats });
    addGroupSystem(chat, `流程已停止：${chat.workflow.name}`);
    return { ok: true };
  }
  return { error: '流程没有在运行' };
}

function stopLoop(chat) {
  chat.loop = false;
  const timer = loopTimers.get(chat.id);
  if (timer) clearTimeout(timer);
  loopTimers.delete(chat.id);
  const ctrl = runAborts.get(chat.id);
  if (ctrl) ctrl.abort();
}

function pickLoopTarget(chat, requested) {
  const ids = chat.botIds || [];
  if (requested && ids.includes(requested)) return requested;
  if (chat.loopTargetId && ids.includes(chat.loopTargetId)) return chat.loopTargetId;
  if (chat.leadId && ids.includes(chat.leadId)) return chat.leadId;
  return ids[0] || null;
}

function scheduleLoop(chat, delay = 2500) {
  if (!chat?.loop) return;
  if (loopTimers.has(chat.id)) return;
  const timer = setTimeout(() => {
    loopTimers.delete(chat.id);
    if (!chat.loop) return;
    enqueue(chat.id, async () => {
      if (!chat.loop) return;
      if (!chat.botIds?.length) {
        stopLoop(chat);
        saveState(state);
        emit('chats', { chats: state.chats });
        return;
      }
      if (!chat.loopTargetId || !chat.botIds.includes(chat.loopTargetId)) {
        chat.loopTargetId = pickLoopTarget(chat);
      }
      chat.loopRound = (chat.loopRound || 0) + 1;
      saveState(state);
      const ctrl = new AbortController();
      runAborts.set(chat.id, ctrl);
      try {
        await runTurn({
          state,
          chat,
          text: chat.loopPrompt || LOOP_PROMPT,
          auto: true,
          save: () => saveState(state),
          emit,
          browser: runBrowserCommand,
          signal: ctrl.signal,
        });
      } finally {
        if (runAborts.get(chat.id) === ctrl) runAborts.delete(chat.id);
        emit('bots', { bots: state.bots.map(publicBot) });
        emit('chats', { chats: state.chats });
        if (chat.loop) scheduleLoop(chat, 3000);
      }
    });
  }, delay);
  loopTimers.set(chat.id, timer);
}

// 让界面执行浏览器操作，并把页面内容回传给 Bot
function runBrowserCommand(action, args) {
  return new Promise((resolve) => {
    if (!clients.size) return resolve({ ok: false, error: '没有可用的界面连接' });
    if (pendingBrowser) return resolve({ ok: false, error: '另一个浏览器操作还在进行' });
    const id = uid('br');
    const timer = setTimeout(() => {
      if (pendingBrowser?.id === id) {
        pendingBrowser = null;
        resolve({ ok: false, error: '浏览器操作超时' });
      }
    }, 45000);
    pendingBrowser = {
      id,
      resolve: (result) => {
        clearTimeout(timer);
        pendingBrowser = null;
        resolve(result);
      },
    };
    emit('browser', { id, action, args });
  });
}

function applyDerivedSource(bot) {
  if (bot.backend === 'custom' || (['claude', 'codex'].includes(bot.backend) && bot.api?.mode === 'custom')) {
    bot.source = '自定义 API';
    bot.billing = 'payg';
    return;
  }
  if (bot.backend === 'claude') {
    bot.source = 'Claude 订阅';
    bot.billing = 'subscription';
  } else if (bot.backend === 'codex') {
    bot.source = 'ChatGPT Plus';
    bot.billing = 'subscription';
  }
}

function publicBot(b) {
  const api = b.api
    ? {
        mode: b.api.mode === 'custom' ? 'custom' : 'official',
        style: b.api.style || (b.backend === 'claude' ? 'anthropic' : 'openai'),
        baseUrl: b.api.baseUrl || '',
        models: Array.isArray(b.api.models) ? b.api.models : [],
        hasKey: !!state.providerKeys?.[`botapi:${b.id}`],
      }
    : null;
  return {
    ...b,
    api,
    quota: quotaLabel(b),
    quotaOverride: b.quota || '',
    memory: b.memory || readMemory(b.id),
    usage: { ...emptyUsage(), ...(b.usage || {}) },
  };
}

function normalizeBotApi(raw, backend, fallbackModels = []) {
  if (!raw || typeof raw !== 'object') return null;
  const mode = backend === 'custom' || raw.mode === 'custom' ? 'custom' : 'official';
  let style = ['openai', 'anthropic'].includes(raw.style) ? raw.style : '';
  if (!style) style = backend === 'claude' ? 'anthropic' : 'openai';
  const pickModel = (x) => {
    if (typeof x === 'string') return x.trim();
    if (x && typeof x === 'object') return String(x.id || x.name || x.model || '').trim();
    return '';
  };
  const models = Array.isArray(raw.models)
    ? [...new Set(raw.models.map(pickModel).filter((x) => x && x !== '[object Object]'))].slice(0, 100)
    : Array.isArray(fallbackModels)
      ? fallbackModels.map(pickModel).filter(Boolean).slice(0, 100)
      : [];
  return {
    mode,
    style,
    baseUrl: String(raw.baseUrl || '').trim().slice(0, 500),
    models,
  };
}

function applyBotApi(bot, raw) {
  if (!['claude', 'codex', 'custom'].includes(bot.backend)) return;
  state.providerKeys ||= {};
  if (!raw || typeof raw !== 'object') return;
  const api = normalizeBotApi(raw, bot.backend, bot.api?.models || []);
  if (api) bot.api = api;
  const key = typeof raw.key === 'string' ? raw.key.trim().slice(0, 4000) : '';
  if (key) state.providerKeys[`botapi:${bot.id}`] = key;
  if (raw.clearKey) delete state.providerKeys?.[`botapi:${bot.id}`];
}

const AGY_PROFILES_DIR = path.join(DATA_DIR, 'agy-profiles');
let agyKeychainCache = { at: 0, value: null };

function agyProfileHome(profile) {
  if (!profile || profile.id === 'default' || !profile.home) return os.homedir();
  return profile.home;
}

function decodeJwtEmail(token) {
  try {
    const payload = String(token || '').split('.')[1];
    if (!payload) return '';
    const decoded = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return JSON.parse(decoded).email || '';
  } catch {
    return '';
  }
}

function emailFromAgyToken(data) {
  if (!data || typeof data !== 'object') return '';
  const direct = String(data.id_token_email || data.email || data.account || '').trim();
  if (direct) return direct;
  return decodeJwtEmail(data.id_token || data.token?.id_token || '');
}

function agyKeychain() {
  const now = Date.now();
  // 命中 10 分钟；读取失败/为空要缓存更久（6 小时），否则系统会每隔几十秒
  // 弹一次钥匙串授权框——用户反馈的「找不到钥匙串」就是这个。
  const ttl = agyKeychainCache.value ? 10 * 60 * 1000 : 6 * 60 * 60 * 1000;
  if (agyKeychainCache.at && now - agyKeychainCache.at < ttl) return agyKeychainCache.value;
  let value = null;
  try {
    const raw = execFileSync(
      '/usr/bin/security',
      ['find-generic-password', '-s', 'gemini', '-a', 'antigravity', '-w'],
      { timeout: 2500, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim();
    if (raw) {
      const payload = raw.startsWith('go-keyring-base64:')
        ? Buffer.from(raw.slice('go-keyring-base64:'.length), 'base64').toString('utf8')
        : raw;
      let parsed = null;
      try { parsed = JSON.parse(payload); } catch {}
      value = parsed ? { email: emailFromAgyToken(parsed), raw: payload } : { email: '', raw: payload };
    }
  } catch {}
  agyKeychainCache = { at: now, value };
  return value;
}

function agyAccountEmail(home, profile, { probeKeychain = false } = {}) {
  const token = path.join(home, '.gemini/antigravity-cli/antigravity-oauth-token');
  try {
    if (fs.existsSync(token)) {
      const data = JSON.parse(fs.readFileSync(token, 'utf8'));
      const email = emailFromAgyToken(data);
      if (email) return email;
    }
  } catch {}
  // agy 把当前账号写在 google_accounts.json，读它不会触发钥匙串授权弹窗。
  try {
    return JSON.parse(fs.readFileSync(path.join(home, '.gemini/google_accounts.json'), 'utf8')).active || '';
  } catch {}
  if (probeKeychain && (!profile || profile.id === 'default' || !profile.home)) {
    const keychain = agyKeychain();
    if (keychain?.email) return keychain.email;
  }
  return '';
}

function agyProfileInfo(profile, { probeKeychain = false } = {}) {
  const home = agyProfileHome(profile);
  const token = path.join(home, '.gemini/antigravity-cli/antigravity-oauth-token');
  const cachedModels = agyProfileModelsCache.get(String(profile?.id || 'default'))?.models;
  const globalModels =
    !profile || profile.id === 'default' || !profile.home ? modelCache.agy?.length || 0 : 0;
  let ready =
    fs.existsSync(token) ||
    (Array.isArray(cachedModels) && cachedModels.length > 0) ||
    globalModels > 0;
  if (!ready && probeKeychain && (!profile || profile.id === 'default' || !profile.home)) {
    ready = !!agyKeychain()?.raw;
  }
  return {
    ...profile,
    home,
    ready,
    account: agyAccountEmail(home, profile, { probeKeychain }),
  };
}

function agyProfilesPayload() {
  return (state.agyProfiles || []).map(agyProfileInfo);
}

let agyProfileModelsCache = new Map();

function repairAgyBotModels(profileId, models) {
  if (!Array.isArray(models) || !models.length) return false;
  let changed = false;
  for (const bot of state.bots || []) {
    if (bot.backend !== 'agy') continue;
    if ((bot.agyProfile || 'default') !== profileId) continue;
    if (bot.model && !models.includes(bot.model)) {
      bot.model = models[0];
      changed = true;
    }
  }
  if (changed) {
    saveState(state);
    emit('bots', { bots: state.bots.map(publicBot) });
  }
  return changed;
}

async function fetchAgyModels(profile) {
  const id = String(profile?.id || 'default');
  const cached = agyProfileModelsCache.get(id);
  if (cached && Date.now() - cached.at < 5 * 60 * 1000) return cached;
  const info = agyProfileInfo(profile);
  // 不再用钥匙串判断是否登录：直接让 agy 自己列模型，能列出来就说明可用。
  // 这样既不会反复弹系统钥匙串授权框，也能在换账号后立刻拿到新模型。
  const home = agyProfileHome(profile);
  ensureAgyHome(home);
  const out = await new Promise((resolve) => {
    execFile(
      resolveCmd('agy') || 'agy',
      ['models'],
      { timeout: 30000, env: { ...childEnv(), HOME: home } },
      (err, stdout) => resolve(err ? '' : String(stdout || ''))
    );
  });
  const models = out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.includes('\t'))
    .map((line) => line.split('\t')[0].trim())
    .filter(Boolean);
  const value = { at: Date.now(), models, account: info.account || '' };
  agyProfileModelsCache.set(id, value);
  return value;
}

function agyProfileById(id) {
  return (state.agyProfiles || []).find((p) => p.id === id) || null;
}

function settingsPublic() {
  const out = JSON.parse(JSON.stringify(state.settings || { leaderId: null }));
  for (const key of ['translateConfig', 'explainConfig']) {
    if (out[key]) {
      out[key].hasKey = !!out[key].apiKey;
      delete out[key].apiKey;
    }
  }
  return out;
}

const SETUP_BACKENDS = [
  {
    id: 'opencode',
    name: 'OpenCode',
    cmd: 'opencode',
    install: 'npm i -g opencode-ai',
    login: 'opencode auth login',
    note: 'OpenCode 模型池 / 自定义 API',
  },
  {
    id: 'codex',
    name: 'Codex / ChatGPT',
    cmd: 'codex',
    install: 'npm i -g @openai/codex',
    login: 'codex login',
    note: 'ChatGPT Plus 订阅，或 Responses API',
  },
  {
    id: 'claude',
    name: 'Claude Code',
    cmd: 'claude',
    install: 'npm i -g @anthropic-ai/claude-code',
    login: 'claude 然后输入 /login',
    note: 'Claude 订阅，或 Anthropic 兼容 API',
  },
  {
    id: 'agy',
    name: 'Antigravity',
    cmd: 'agy',
    install: '需要单独安装 Antigravity CLI（agy），不在 npm 上',
    login: 'agy 登录 Google 账号',
    note: 'Google One / Antigravity 配额',
  },
  {
    id: 'codebuddy',
    name: 'WorkBuddy',
    cmd: 'codebuddy',
    install: 'npm i -g @tencent-ai/codebuddy-code',
    login: 'codebuddy 登录 WorkBuddy 账号',
    note: 'WorkBuddy 中国版',
  },
  {
    id: 'qoder',
    name: 'Qoder',
    cmd: 'qoderclicn',
    install: '安装 Qoder 中国版 CLI（qoderclicn）',
    login: 'qoderclicn 登录',
    note: 'Qoder 中国版积分',
  },
  {
    id: 'custom',
    name: '自定义 API',
    cmd: '',
    install: '',
    login: '不需要 CLI，填 Base URL + API Key',
    note: 'OpenAI / Anthropic 兼容接口',
    always: true,
  },
];

function hasFile(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function setupStatus() {
  const home = os.homedir();
  const backends = SETUP_BACKENDS.map((b) => {
    if (b.always) {
      return { ...b, installed: true, loggedIn: null };
    }
    const found = resolveCmd(b.cmd);
    const installed = !!found && found !== b.cmd && hasFile(found);
    let loggedIn = null;
    if (b.id === 'codex') loggedIn = hasFile(path.join(home, '.codex/auth.json'));
    else if (b.id === 'opencode') loggedIn = hasFile(path.join(home, '.local/share/opencode/auth.json'));
    else if (b.id === 'claude') loggedIn = hasFile(path.join(home, '.claude.json'));
    return { ...b, installed, loggedIn };
  });
  return {
    firstRun: !state.settings?.setupDone && (state.bots || []).length === 0,
    setupDone: !!state.settings?.setupDone,
    platform: process.platform,
    arch: process.arch,
    node: process.versions.node,
    appVersion: (() => {
      try {
        return JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'package.json'), 'utf8')).version || '';
      } catch {
        return '';
      }
    })(),
    backends,
  };
}

function resolveEngine(kind = 'translate') {
  const key = kind === 'explain' ? 'explainConfig' : 'translateConfig';
  const cfg = state.settings?.[key] || {};
  const legacyMode = kind === 'translate'
    ? (state.settings?.translateEngine === 'bot' ? 'bot' : 'free')
    : 'bot';
  const mode = cfg.mode || legacyMode;
  if (kind === 'translate' && mode === 'free') return { engine: 'free' };
  if (mode === 'custom') {
    if (!cfg.baseUrl || !cfg.model) throw new Error('自定义 API 还没填 Base URL 和模型');
    const bot = {
      name: '自定义 API',
      model: cfg.model,
      api: {
        style: cfg.style === 'anthropic' ? 'anthropic' : 'openai',
        baseUrl: cfg.baseUrl,
        models: [cfg.model],
      },
    };
    return { engine: 'custom', bot, apiKey: cfg.apiKey || '' };
  }
  const wanted =
    cfg.botId ||
    (kind === 'explain'
      ? state.settings?.explainBotId || state.settings?.translateBotId
      : state.settings?.translateBotId) ||
    '';
  let bot = wanted ? state.bots.find((b) => b.id === wanted) : null;
  if (!bot) {
    bot =
      state.bots.find(
        (b) => b.backend === 'custom' && b.api?.baseUrl && b.model && state.providerKeys?.[`botapi:${b.id}`]
      ) ||
      state.bots.find((b) => b.backend === 'custom' && b.api?.baseUrl && b.model) ||
      null;
  }
  if (!bot) throw new Error('没有可用的 API Bot，请在设置里配置翻译/解释引擎');
  return {
    engine: 'bot',
    bot,
    apiKey: state.providerKeys?.[`botapi:${bot.id}`] || '',
  };
}

const VIDEO_EXTS = new Set([
  'mp4','m4v','mov','mkv','webm','avi','flv','wmv','ts','mts','m2ts','3gp','ogv',
]);

let asrProcess = null;
let asrStart = null;
let asrPending = null;
let asrChain = Promise.resolve();

function asrWorkerPath() {
  const src = path.join(import.meta.dirname, 'lib/asr_worker.py');
  const dst = path.join(DATA_DIR, 'asr_worker.py');
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const needCopy =
      !fs.existsSync(dst) ||
      fs.statSync(dst).size !== fs.statSync(src).size;
    if (needCopy) fs.copyFileSync(src, dst);
    return dst;
  } catch {
    return src;
  }
}

function officeEditScriptPath() {
  const src = path.join(import.meta.dirname, 'lib/office_edit.py');
  const dst = path.join(DATA_DIR, 'office_edit.py');
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const needCopy =
      !fs.existsSync(dst) ||
      fs.statSync(dst).size !== fs.statSync(src).size;
    if (needCopy) fs.copyFileSync(src, dst);
    return dst;
  } catch {
    return src;
  }
}

let marketCache = { at: 0, data: null };

function marketPathUrl(value, prefix = '') {
  const encoded = String(value || '')
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
  return new URL(prefix + encoded, 'https://yuancang.me/').href;
}

async function getMarketData() {
  const now = Date.now();
  if (marketCache.data && now - marketCache.at < 10 * 60 * 1000) return marketCache.data;
  let text = '';
  try {
    const response = await fetch('https://yuancang.me/wall', {
      headers: { 'user-agent': 'BotTeam/1.0' },
      signal: AbortSignal.timeout(25000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    text = await response.text();
  } catch (e) {
    if (marketCache.data) return { ...marketCache.data, stale: true };
    throw e;
  }
  const start = text.indexOf('const pictures=');
  const end = text.indexOf('const categories=', start);
  if (start < 0 || end < 0) throw new Error('源仓页面结构变了，找不到图片列表');
  let raw = text.slice(start + 'const pictures='.length, end).trim();
  raw = raw.replace(/;\s*$/, '').trim();
  let pictures;
  try {
    pictures = JSON.parse(raw);
  } catch (e) {
    throw new Error('解析源仓图片列表失败');
  }
  const allowed = new Set(['avatar', 'desktop', 'phone']);
  const items = (Array.isArray(pictures) ? pictures : [])
    .filter((p) => p && allowed.has(String(p.type || '')))
    .map((p) => ({
      id: String(p.id || p.file || ''),
      type: String(p.type || ''),
      title: String(p.title || p.style || p.file || '未命名'),
      style: String(p.style || ''),
      category: String(p.category || ''),
      tags: Array.isArray(p.tags) ? p.tags.slice(0, 8).map(String) : [],
      credit: String(p.credit || ''),
      width: Number(p.width) || 0,
      height: Number(p.height) || 0,
      thumb: marketPathUrl(p.thumb),
      full: marketPathUrl(p.download, 'wallpapers/'),
    }));
  const data = {
    items,
    updatedAt: new Date().toISOString(),
    count: items.length,
    source: 'https://yuancang.me/wall',
  };
  marketCache = { at: now, data };
  return data;
}

function pdfEditScriptPath() {
  const src = path.join(import.meta.dirname, 'lib/pdf_edit.py');
  const dst = path.join(DATA_DIR, 'pdf_edit.py');
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const needCopy =
      !fs.existsSync(dst) ||
      fs.statSync(dst).size !== fs.statSync(src).size;
    if (needCopy) fs.copyFileSync(src, dst);
    return dst;
  } catch {
    return src;
  }
}

async function runPdfEdit(action, target, payload = {}) {
  const tmp = path.join(
    os.tmpdir(),
    `bt-pdf-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
  );
  fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
  try {
    const r = await execFileP(
      resolveCmd('python3') || 'python3',
      [pdfEditScriptPath(), action, target, tmp],
      { timeout: 180000 }
    );
    let data = null;
    try {
      data = JSON.parse(String(r.out || '').trim() || '{}');
    } catch {
      throw new Error((r.err || r.out || 'PDF 操作失败').slice(0, 300));
    }
    if (data?.error) throw new Error(String(data.error).slice(0, 300));
    if (!r.ok) throw new Error(String(r.err || r.out || 'PDF 操作失败').slice(0, 300));
    return data || {};
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch {}
  }
}

async function runOfficeEdit(action, target, payload = {}) {
  const tmp = path.join(os.tmpdir(), `bt-office-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
  try {
    const r = await execFileP(
      resolveCmd('python3') || 'python3',
      [officeEditScriptPath(), action, target, tmp],
      { timeout: 180000 }
    );
    let data = null;
    try {
      data = JSON.parse(String(r.out || '').trim() || '{}');
    } catch {
      throw new Error((r.err || r.out || 'Office 操作失败').slice(0, 300));
    }
    if (data?.error) throw new Error(String(data.error).slice(0, 300));
    if (!r.ok) throw new Error(String(r.err || r.out || 'Office 操作失败').slice(0, 300));
    return data || {};
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch {}
  }
}

function startAsrWorker() {
  if (asrStart) return asrStart;
  const child = spawn(resolveCmd('python3') || 'python3', [asrWorkerPath()], {
    env: { ...childEnv(), BT_ASR_MODEL: process.env.BT_ASR_MODEL || 'base' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  asrProcess = child;
  const rl = readline.createInterface({ input: child.stdout });
  asrStart = new Promise((resolve, reject) => {
    let ready = false;
    rl.on('line', (line) => {
      let msg = null;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.ready) {
        ready = true;
        resolve(true);
        return;
      }
      const pending = asrPending;
      if (!pending) return;
      asrPending = null;
      if (msg.error) pending.reject(new Error(msg.error));
      else pending.resolve(msg);
    });
    child.on('error', (e) => { if (!ready) reject(e); });
    child.on('exit', () => {
      asrProcess = null;
      asrStart = null;
      if (!ready) reject(new Error('ASR 进程启动失败'));
      if (asrPending) {
        asrPending.reject(new Error('ASR 进程已退出'));
        asrPending = null;
      }
    });
  }).catch((e) => {
    asrStart = null;
    asrProcess = null;
    throw e;
  });
  child.stderr.on('data', (d) => {
    const text = d.toString().trim();
    if (text) console.log('[asr]', text.slice(0, 300));
  });
  return asrStart;
}

function asrOnce(wav, language) {
  return new Promise((resolve, reject) => {
    asrPending = { resolve, reject };
    asrProcess.stdin.write(JSON.stringify({ wav, language: language || '' }) + '\n');
  });
}

function asrWav(wav, language) {
  const run = asrChain.then(async () => {
    await startAsrWorker();
    return asrOnce(wav, language);
  });
  asrChain = run.catch(() => {});
  return run;
}

const videoJobs = new Map();

function videoCachePath(file, st) {
  const hash = crypto
    .createHash('sha1')
    .update(`${file}|${st.size}|${st.mtimeMs}`)
    .digest('hex');
  return path.join(DATA_DIR, 'transcripts', `${hash}.json`);
}

async function probeDuration(file) {
  const r = await execFileP(resolveCmd('ffprobe') || 'ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file,
  ], { timeout: 20000 });
  return Number.parseFloat(r.out) || 0;
}

async function runVideoJob(id, file, language) {
  const job = videoJobs.get(id);
  if (!job) return;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-video-'));
  job.status = 'running';
  job.progress = 1;
  try {
    job.progress = 3;
    const duration = await probeDuration(file);
    const wav = path.join(tmp, 'audio.wav');
    const ext = await execFileP(resolveCmd('ffmpeg') || 'ffmpeg', [
      '-y', '-i', file, '-vn', '-ac', '1', '-ar', '16000', wav,
    ], { timeout: 120000 });
    if (!ext.ok || !fs.existsSync(wav)) throw new Error(`提取音频失败：${ext.err.slice(0, 160)}`);
    job.progress = 10;
    await execFileP(resolveCmd('ffmpeg') || 'ffmpeg', [
      '-y', '-i', wav, '-f', 'segment', '-segment_time', '30', '-c:a', 'pcm_s16le',
      path.join(tmp, 'chunk-%03d.wav'),
    ], { timeout: 120000 });
    const chunks = fs
      .readdirSync(tmp)
      .filter((f) => /^chunk-\d+\.wav$/.test(f))
      .sort();
    if (!chunks.length) throw new Error('没有提取到音频');
    const segments = [];
    let detected = '';
    for (let i = 0; i < chunks.length; i += 1) {
      const r = await asrWav(path.join(tmp, chunks[i]), language);
      detected = detected || r.language || '';
      for (const s of r.segments || []) {
        segments.push({
          start: Number(s.start) + i * 30,
          end: Number(s.end) + i * 30,
          text: String(s.text || '').trim(),
        });
      }
      job.progress = 10 + Math.round(((i + 1) / chunks.length) * 60);
    }

    const target = state.settings?.translateTarget || 'zh-CN';
    const source = String(detected || '');
    const sameLang = source && source.startsWith('zh') && target.startsWith('zh');
    if (segments.length && !sameLang) {
      try {
        const resolved = resolveEngine('translate');
        const texts = segments.map((s) => s.text);
        const out = new Array(texts.length).fill('');
        for (let i = 0; i < texts.length; i += 40) {
          const part = await translateTexts(texts.slice(i, i + 40), {
            engine: resolved.engine === 'free' ? 'free' : 'bot',
            target,
            bot: resolved.bot || null,
            apiKey: resolved.apiKey || '',
          });
          part.forEach((t, j) => { out[i + j] = t; });
          job.progress = 70 + Math.round(((i + 40) / texts.length) * 20);
        }
        segments.forEach((s, i) => { s.translation = out[i] || ''; });
      } catch (e) {
        job.translateError = String(e?.message || e).slice(0, 300);
      }
    }

    job.progress = 92;
    let summary = '';
    if (segments.length) {
      try {
        const resolved = resolveEngine('explain');
        summary = await summarizeText(segments.map((s) => s.text).join('\n'), {
          bot: resolved.bot,
          apiKey: resolved.apiKey || '',
        });
      } catch (e) {
        job.summaryError = String(e?.message || e).slice(0, 300);
      }
    }

    job.result = { segments, language: detected, duration, summary };
    job.status = 'done';
    job.progress = 100;
    const st = fs.statSync(file);
    const cacheFile = videoCachePath(file, st);
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(job.result));
  } catch (e) {
    job.status = 'error';
    job.error = String(e?.message || e).slice(0, 500);
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    while (videoJobs.size > 30) {
      const first = videoJobs.keys().next().value;
      videoJobs.delete(first);
    }
  }
}

async function liveTranscribe(file, start, duration, language) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-live-'));
  try {
    const wav = path.join(tmp, 'chunk.wav');
    const r = await execFileP(resolveCmd('ffmpeg') || 'ffmpeg', [
      '-y', '-ss', String(Math.max(0, start)), '-t', String(Math.max(1, duration)),
      '-i', file, '-vn', '-ac', '1', '-ar', '16000', wav,
    ], { timeout: 30000 });
    if (!r.ok || !fs.existsSync(wav)) throw new Error('截取音频失败');
    const res = await asrWav(wav, language);
    return {
      language: res.language || '',
      segments: (res.segments || []).map((s) => ({
        start: Number(s.start) + Number(start),
        end: Number(s.end) + Number(start),
        text: s.text,
      })),
    };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

function snapshot() {
  return {
    self: state.self,
    settings: settingsPublic(),
    flowRulesDefault: DEFAULT_FLOW_DESIGN_RULES,
    bots: state.bots.map(publicBot),
    chats: state.chats,
    roles: state.roles || [],
    schedules: publicSchedules(),
    agyProfiles: agyProfilesPayload(),
    runtime: [...runtime.values()],
    admin: { cli: ADMIN_CLI_PATH, manual: ADMIN_MANUAL_PATH },
    sources: SOURCES,
    avatars: [...uploadedAvatars(), ...AVATARS],
    wallpapers: uploadedWallpapers(),
  };
}

/* ------------- model lists ------------- */

let modelCache = { at: 0, opencode: [], agy: [], codex: [], codebuddy: [], qoder: [] };
const modelFetchCache = new Map();
let modelRefreshing = null;

function refreshModels() {
  if (Date.now() - modelCache.at < 10 * 60 * 1000) return Promise.resolve(modelCache);
  if (modelRefreshing) return modelRefreshing;
  modelRefreshing = (async () => {
    const run = (cmd, args) =>
      new Promise((resolve) => {
        execFile(resolveCmd(cmd), args, { timeout: 30000, env: childEnv() }, (err, out) =>
          resolve(err ? '' : out)
        );
      });
    const [oc, ag, cx, cb, qd] = await Promise.all([
      run('opencode', ['models']),
      run('agy', ['models']),
      run('codex', ['debug', 'models']),
      run('codebuddy', ['--help']),
      run('qoderclicn', ['--list-models']),
    ]);

    let codex = [];
    try {
      const parsed = JSON.parse(cx);
      codex = (parsed.models || [])
        .filter((m) => m.visibility !== 'hide')
        .sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999))
        .map((m) => ({ id: m.slug, name: m.display_name || m.slug, desc: m.description || '' }))
        .filter((m) => m.id);
    } catch {}

    const cbMatch = cb.match(/Currently supported:\s*\(([^)]+)\)/s);
    const codebuddy = cbMatch
      ? cbMatch[1]
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
    const qoder = qd
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s && !/^MODEL$/i.test(s))
      .filter((s) => /^[\w.:-]+$/.test(s));

    modelCache = {
      at: Date.now(),
      opencode: oc.split('\n').map((s) => s.trim()).filter((s) => s.includes('/')),
      agy: ag
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s.includes('\t'))
        .map((s) => s.split('\t')[0].trim()),
      codex,
      codebuddy,
      qoder,
    };
    // 旧数据里“来源”和模型 provider 对不上的，趁模型列表刚拿到修一遍
    if (repairSources(state.bots, modelCache)) {
      saveState(state);
      emit('bots', { bots: state.bots.map(publicBot) });
    }
    modelRefreshing = null;
    return modelCache;
  })();
  return modelRefreshing;
}

/* ------------- skills ------------- */

let skillsCache = { at: 0, skills: [] };

// 解析 SKILL.md frontmatter 里的字段，支持 YAML 的多行写法（description: > / |）
function frontmatterField(block, key) {
  const re = new RegExp(`^${key}:\\s*(.*)$`, 'm');
  const m = block.match(re);
  if (!m) return '';
  let value = String(m[1] || '').trim();
  if (/^[>|][-+]?$/.test(value)) {
    const rest = block.slice((m.index || 0) + m[0].length).split('\n');
    const lines = [];
    for (const line of rest) {
      if (!line.trim()) {
        if (lines.length) lines.push('');
        continue;
      }
      if (!/^\s+/.test(line)) break;
      lines.push(line.replace(/^\s+/, ''));
    }
    value = lines.join(' ').replace(/\s+/g, ' ').trim();
  }
  return value.replace(/^["']|["']$/g, '').trim();
}

function readSkills(force = false) {
  if (!force && Date.now() - skillsCache.at < 5 * 60 * 1000) return skillsCache.skills;
  const roots = [
    path.join(os.homedir(), '.agents/skills'),
    path.join(os.homedir(), '.config/opencode/skills'),
    path.join(os.homedir(), '.codex/skills'),
    path.join(os.homedir(), '.claude/skills'),
    path.join(os.homedir(), '.dsh/skills'),
    path.join(os.homedir(), '.workbuddy/skills'),
    path.join(os.homedir(), '.qoder-cn/skills'),
    path.join(os.homedir(), '.qoder/skills'),
    path.join(os.homedir(), '.gemini/skills'),
    path.join(os.homedir(), '.minimax/skills'),
    path.join(os.homedir(), 'Doubao/skills'),
    path.join(os.homedir(), '.skills-manager/skills'),
  ];
  const seen = new Set();
  const skills = [];
  for (const root of roots) {
    let dirs = [];
    try {
      dirs = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of dirs) {
      // 有些工具目录里是软链接，也要当成目录处理
      if (!d.isDirectory() && !d.isSymbolicLink()) continue;
      let text = '';
      try {
        text = fs.readFileSync(path.join(root, d.name, 'SKILL.md'), 'utf8');
      } catch {
        continue;
      }
      const fm = text.match(/^---\s*\n([\s\S]*?)\n---/);
      const block = fm?.[1] || '';
      const name = (frontmatterField(block, 'name') || d.name)
        .trim()
        .replace(/^["']|["']$/g, '');
      const desc = frontmatterField(block, 'description').slice(0, 4000);
      if (!name || seen.has(name)) continue;
      seen.add(name);
      skills.push({ name, desc, path: path.join(root, d.name) });
    }
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));
  skillsCache = { at: Date.now(), skills };
  return skills;
}

function normalizeSkillList(value, max = 200) {
  const arr = Array.isArray(value) ? value : String(value || '').split(/[,，\n]/);
  return [...new Set(arr.map((x) => String(x).trim()).filter(Boolean))].slice(0, max);
}

function skillDescHash(desc) {
  return crypto.createHash('sha1').update(String(desc || '')).digest('hex').slice(0, 16);
}

function skillSummaryFor(name, desc) {
  const meta = state.skillMeta?.[name];
  if (meta && (!meta.descHash || meta.descHash === skillDescHash(desc))) {
    return { ...meta, source: meta.source || 'ai' };
  }
  const preset = STATIC_SKILL_SUMMARIES[name];
  if (preset) return { ...preset, source: 'builtin' };
  return null;
}

function skillsForClient() {
  return readSkills().map((s) => ({ ...s, summary: skillSummaryFor(s.name, s.desc) }));
}

function resolveSkillTarget(type, id) {
  if (type === 'role') return (state.roles || []).find((r) => r.id === id) || null;
  if (type === 'bot') return (state.bots || []).find((b) => b.id === id) || null;
  if (type === 'group') {
    return (state.chats || []).find((c) => c.id === id && c.type === 'group') || null;
  }
  return null;
}

function resolveExplainerBot(preferredId = '') {
  const bots = (state.bots || []).filter((b) => !b.hidden);
  if (preferredId) {
    const hit = bots.find((b) => b.id === preferredId);
    if (hit) return hit;
  }
  return (
    bots.find(
      (b) => b.backend === 'custom' && b.api?.baseUrl && state.providerKeys?.[`botapi:${b.id}`]
    ) ||
    bots.find((b) => b.backend === 'custom' && b.api?.baseUrl) ||
    bots.find((b) => b.id === state.settings?.leaderId) ||
    bots.find((b) => b.backend === 'custom') ||
    bots[0] ||
    null
  );
}

function parseGithubSkillUrl(raw) {
  let value = String(raw || '').trim();
  if (!value) return null;
  if (/^[\w.-]+\/[\w.-]+$/.test(value)) value = `https://github.com/${value}`;
  let u;
  try {
    u = new URL(value);
  } catch {
    return null;
  }
  if (u.hostname !== 'github.com' && u.hostname !== 'www.github.com') return null;
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/i, '');
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) return null;
  let branch = '';
  let sub = '';
  if (parts[2] === 'tree' && parts[3]) {
    branch = decodeURIComponent(parts[3]);
    sub = parts.slice(4).map(decodeURIComponent).join('/');
  } else if (parts[2] === 'blob' && parts[3]) {
    branch = decodeURIComponent(parts[3]);
    sub = parts.slice(4, -1).map(decodeURIComponent).join('/');
  }
  return { url: `https://github.com/${owner}/${repo}.git`, branch, sub };
}

function execFileP(cmd, args, { timeout = 120000 } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, env: childEnv(), maxBuffer: 8 * 1024 * 1024 }, (err, out, stderr) => {
      resolve({ ok: !err, out: String(out || ''), err: String(stderr || err?.message || '') });
    });
  });
}

function findSkillDirs(base, depth = 0, out = []) {
  if (depth > 4 || out.length >= 12) return out;
  try {
    if (fs.existsSync(path.join(base, 'SKILL.md'))) {
      out.push(base);
      return out;
    }
    const entries = fs.readdirSync(base, { withFileTypes: true });
    for (const d of entries) {
      if (!d.isDirectory() || d.name.startsWith('.') || d.name === 'node_modules') continue;
      findSkillDirs(path.join(base, d.name), depth + 1, out);
      if (out.length >= 12) break;
    }
  } catch {}
  return out;
}

function fallbackSkillRoots(bot) {
  const home = os.homedir();
  const roots = [
    path.join(home, '.agents/skills'),
    path.join(home, '.config/opencode/skills'),
  ];
  const backendRoot = {
    codex: '.codex/skills',
    claude: '.claude/skills',
    agy: '.gemini/skills',
    qoder: '.qoder-cn/skills',
    codebuddy: '.workbuddy/skills',
  }[bot?.backend];
  if (backendRoot) roots.push(path.join(home, backendRoot));
  return [...new Set(roots)];
}

async function installSkillFromGithub(rawUrl, targetBot) {
  const parsed = parseGithubSkillUrl(rawUrl);
  if (!parsed) throw new Error('只支持 github.com 的仓库地址');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-skill-'));
  const cloneDir = path.join(tmp, 'repo');
  try {
    const args = ['clone', '--depth', '1'];
    if (parsed.branch) args.push('--branch', parsed.branch);
    args.push(parsed.url, cloneDir);
    const clone = await execFileP('git', args);
    if (!clone.ok) throw new Error(`下载失败：${clone.err.slice(0, 200) || 'git clone 失败'}`);
    const rootReal = path.resolve(cloneDir);
    const base = parsed.sub ? path.resolve(cloneDir, parsed.sub) : rootReal;
    if (base !== rootReal && !base.startsWith(rootReal + path.sep)) {
      throw new Error('仓库内的路径不合法');
    }
    const dirs = findSkillDirs(base);
    if (!dirs.length) throw new Error('这个仓库里没有找到 SKILL.md');
    const existing = new Set(readSkills().map((s) => s.name));
    const installed = [];
    const sync = resolveCmd('skill-sync');
    for (const dir of dirs) {
      let text = '';
      try {
        text = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
      } catch {
        continue;
      }
      const block = text.match(/^---\s*\n([\s\S]*?)\n---/)?.[1] || '';
      const rawName = frontmatterField(block, 'name') || path.basename(dir);
      const name = rawName.trim().replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 80);
      if (!name) continue;
      if (!existing.has(name)) {
        let ok = false;
        if (sync) {
          const r = await execFileP(sync, ['install', dir], { timeout: 180000 });
          ok = r.ok;
          if (!ok) console.log('[skills] skill-sync failed:', r.err.slice(0, 200));
        }
        if (!ok) {
          for (const root of fallbackSkillRoots(targetBot)) {
            const dst = path.join(root, name);
            try {
              fs.mkdirSync(root, { recursive: true });
              fs.rmSync(dst, { recursive: true, force: true });
              fs.cpSync(dir, dst, { recursive: true });
              ok = true;
            } catch {}
          }
        }
        if (!ok) throw new Error(`技能「${name}」安装失败`);
        existing.add(name);
      }
      installed.push({
        name,
        desc: frontmatterField(block, 'description').slice(0, 4000),
      });
    }
    skillsCache.at = 0;
    const fresh = readSkills(true);
    return installed.map((x) => {
      const hit = fresh.find((s) => s.name === x.name);
      return {
        name: x.name,
        desc: hit?.desc || x.desc,
        summary: skillSummaryFor(x.name, hit?.desc || x.desc),
      };
    });
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {}
  }
}

/* ------------- local file viewer ------------- */

const FILE_MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
  ogv: 'video/ogg',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac',
  flac: 'audio/flac', ogg: 'audio/ogg', oga: 'audio/ogg',
  txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8',
  markdown: 'text/plain; charset=utf-8', log: 'text/plain; charset=utf-8',
  json: 'text/plain; charset=utf-8', jsonl: 'text/plain; charset=utf-8',
  csv: 'text/plain; charset=utf-8', tsv: 'text/plain; charset=utf-8',
  yaml: 'text/plain; charset=utf-8', yml: 'text/plain; charset=utf-8',
  html: 'text/plain; charset=utf-8', htm: 'text/plain; charset=utf-8',
  css: 'text/plain; charset=utf-8', scss: 'text/plain; charset=utf-8',
  js: 'text/plain; charset=utf-8', mjs: 'text/plain; charset=utf-8',
  cjs: 'text/plain; charset=utf-8', jsx: 'text/plain; charset=utf-8',
  ts: 'text/plain; charset=utf-8', tsx: 'text/plain; charset=utf-8',
  py: 'text/plain; charset=utf-8', rb: 'text/plain; charset=utf-8',
  go: 'text/plain; charset=utf-8', rs: 'text/plain; charset=utf-8',
  java: 'text/plain; charset=utf-8', c: 'text/plain; charset=utf-8',
  h: 'text/plain; charset=utf-8', cpp: 'text/plain; charset=utf-8',
  sh: 'text/plain; charset=utf-8', bash: 'text/plain; charset=utf-8',
  zsh: 'text/plain; charset=utf-8', sql: 'text/plain; charset=utf-8',
  xml: 'text/plain; charset=utf-8', toml: 'text/plain; charset=utf-8',
  ini: 'text/plain; charset=utf-8', env: 'text/plain; charset=utf-8',
  gitignore: 'text/plain; charset=utf-8',
};

function expandLocalPath(raw) {
  const t = String(raw || '').trim();
  return t.startsWith('~/') ? path.join(os.homedir(), t.slice(2)) : t;
}

function fileViewerMime(file) {
  const ext = path.extname(file).slice(1).toLowerCase();
  return FILE_MIME[ext] || 'application/octet-stream';
}

function isTextExt(file) {
  const mime = fileViewerMime(file);
  return mime.startsWith('text/plain');
}

const PREVIEW_MIME = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8',
  xhtml: 'application/xhtml+xml; charset=utf-8',
  css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8', json: 'application/json; charset=utf-8',
  xml: 'application/xml; charset=utf-8', svg: 'image/svg+xml',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon',
  pdf: 'application/pdf',
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', ogg: 'audio/ogg',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  wasm: 'application/wasm',
  txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8',
};

function previewMime(file) {
  const ext = path.extname(file).slice(1).toLowerCase();
  return PREVIEW_MIME[ext] || FILE_MIME[ext] || 'application/octet-stream';
}

// 本地网页预览：单独起一个只监听 127.0.0.1 的静态服务，
// 这样 HTML 里的相对 css/js/图片能正常加载，同时和主应用不同源，脚本碰不到应用接口。
let previewServer = null;
let previewPort = 0;
let previewReady = null;

function startPreviewServer() {
  if (previewReady) return previewReady;
  previewServer = http.createServer((req, res) => {
    try {
      const u = new URL(req.url || '/', 'http://127.0.0.1');
      if (!u.pathname.startsWith('/f/')) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end('not found');
      }
      const rel = decodeURIComponent(u.pathname.slice(3));
      sendLocalFile(req, res, path.resolve('/', rel), previewMime(rel), {
        'x-content-type-options': 'nosniff',
      });
    } catch {
      try {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('bad request');
      } catch {}
    }
  });
  previewReady = new Promise((resolve) => {
    previewServer.listen(0, '127.0.0.1', () => {
      previewPort = previewServer.address().port;
      resolve(previewPort);
    });
  });
  return previewReady;
}

function sendLocalFile(req, res, target, mime, extraHeaders = {}) {
  let st;
  try {
    st = fs.statSync(target);
  } catch {
    return json(res, 404, { error: '文件不存在' });
  }
  if (!st.isFile()) return json(res, 400, { error: '这是一个目录' });
  if (!st.size) {
    res.writeHead(200, {
      'content-type': mime,
      'content-length': 0,
      'cache-control': 'private, max-age=60',
      ...extraHeaders,
    });
    return res.end();
  }
  const read = (start, end) => fs.createReadStream(target, { start, end });
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(String(range));
    if (m) {
      let start = m[1] ? Number(m[1]) : 0;
      let end = m[2] ? Number(m[2]) : st.size - 1;
      if (start > end || start >= st.size) {
        res.writeHead(416, { 'content-range': `bytes */${st.size}`, ...extraHeaders });
        return res.end();
      }
      end = Math.min(end, st.size - 1);
      res.writeHead(206, {
        'content-type': mime,
        'content-length': end - start + 1,
        'content-range': `bytes ${start}-${end}/${st.size}`,
        'accept-ranges': 'bytes',
        'cache-control': 'private, max-age=60',
        ...extraHeaders,
      });
      read(start, end).pipe(res);
      return;
    }
  }
  res.writeHead(200, {
    'content-type': mime,
    'content-length': st.size,
    'accept-ranges': 'bytes',
    'cache-control': 'private, max-age=60',
    ...extraHeaders,
  });
  read(0, st.size - 1).pipe(res);
}

async function serveRawFile(req, res, url) {
  const target = expandLocalPath(url.searchParams.get('path'));
  if (!target) return json(res, 400, { error: '缺少 path' });
  let st;
  try {
    st = fs.statSync(target);
  } catch {
    return json(res, 404, { error: '文件不存在' });
  }
  if (!st.isFile()) return json(res, 400, { error: '这是一个目录' });
  const mime = fileViewerMime(target);
  if (!st.size) {
    res.writeHead(200, { 'content-type': mime, 'content-length': 0, 'cache-control': 'private, max-age=60' });
    return res.end();
  }
  const range = req.headers.range;
  const read = (start, end) => fs.createReadStream(target, { start, end });
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(String(range));
    if (m) {
      let start = m[1] ? Number(m[1]) : 0;
      let end = m[2] ? Number(m[2]) : st.size - 1;
      if (start > end || start >= st.size) {
        res.writeHead(416, { 'content-range': `bytes */${st.size}` });
        return res.end();
      }
      end = Math.min(end, st.size - 1);
      res.writeHead(206, {
        'content-type': mime,
        'content-length': end - start + 1,
        'content-range': `bytes ${start}-${end}/${st.size}`,
        'accept-ranges': 'bytes',
        'cache-control': 'private, max-age=60',
      });
      read(start, end).pipe(res);
      return;
    }
  }
  res.writeHead(200, {
    'content-type': mime,
    'content-length': st.size,
    'accept-ranges': 'bytes',
    'cache-control': 'private, max-age=60',
  });
  read(0, st.size - 1).pipe(res);
}

function searchLocalFiles(query) {
  const q = String(query || '').trim();
  if (!q) return [];
  const direct = expandLocalPath(q);
  if (direct.startsWith('/') || direct.startsWith('~')) {
    try {
      const st = fs.statSync(direct);
      if (st.isFile()) {
        return [{ path: direct, name: path.basename(direct), size: st.size, mtime: st.mtimeMs }];
      }
    } catch {}
  }
  const needle = q.toLowerCase();
  const normName = (v) => String(v || '').toLowerCase().replace(/[\s_\-·.()（）]+/g, '');
  const needleNorm = normName(needle);
  const home = os.homedir();
  const roots = [
    { dir: path.join(home, 'Desktop'), depth: 4 },
    { dir: path.join(home, 'Documents'), depth: 4 },
    { dir: path.join(home, 'Downloads'), depth: 4 },
    { dir: home, depth: 3 },
    { dir: DATA_DIR, depth: 6 },
  ];
  const out = [];
  const seen = new Set();
  const deadline = Date.now() + 2500;
  let visited = 0;
  const walk = (dir, depth) => {
    if (depth < 0 || out.length >= 40 || Date.now() > deadline || visited > 6000) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      visited += 1;
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth - 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (
        !entry.name.toLowerCase().includes(needle) &&
        !(needleNorm && normName(entry.name).includes(needleNorm))
      )
        continue;
      if (seen.has(full)) continue;
      seen.add(full);
      try {
        const st = fs.statSync(full);
        out.push({ path: full, name: entry.name, size: st.size, mtime: st.mtimeMs });
      } catch {}
      if (out.length >= 40) return;
    }
  };
  for (const root of roots) walk(root.dir, root.depth);
  out.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
  return out.slice(0, 40);
}

const fileTextCache = new Map();

function textExt(file) {
  return path.extname(file).slice(1).toLowerCase();
}

function readTextFileLimited(file, max) {
  const st = fs.statSync(file);
  if (st.size > 20 * 1024 * 1024) throw new Error('文件太大，先不要整篇读取');
  const raw = fs.readFileSync(file, 'utf8');
  return { text: raw.slice(0, max), truncated: raw.length > max, pages: 0, kind: 'text' };
}

async function extractPdfText(file, max) {
  const script = `
import sys, json
p = sys.argv[1]
limit = int(sys.argv[2])
out = []
pages = 0
try:
    import fitz
    doc = fitz.open(p)
    pages = doc.page_count
    total = 0
    for page in doc:
        t = page.get_text()
        if t:
            out.append(t)
            total += len(t)
            if total >= limit:
                break
except Exception as e:
    try:
        from pypdf import PdfReader
        reader = PdfReader(p)
        pages = len(reader.pages)
        total = 0
        for page in reader.pages:
            t = page.extract_text() or ''
            if t:
                out.append(t)
                total += len(t)
                if total >= limit:
                    break
    except Exception as e2:
        print('ERROR:' + str(e2))
        sys.exit(1)
text = chr(10).join(out)
print('PAGES:' + str(pages))
print(text[:limit])
`;
  const r = await execFileP('python3', ['-c', script, file, String(max)], { timeout: 30000 });
  if (!r.ok || !r.out) throw new Error(r.err.slice(0, 200) || 'PDF 文本提取失败');
  const pages = Number((r.out.match(/PAGES:(\d+)/) || [])[1]) || 0;
  const markerAt = r.out.indexOf('PAGES:');
  const afterMarker = markerAt >= 0 ? r.out.slice(markerAt) : r.out;
  const lineEnd = afterMarker.search(/\r?\n/);
  const text = lineEnd >= 0 ? afterMarker.slice(lineEnd + 1) : afterMarker;
  if (text.startsWith('ERROR:')) throw new Error(text.slice(6, 200));
  return { text: text.slice(0, max), truncated: text.length >= max, pages, kind: 'pdf' };
}

async function extractFileText(file, max) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    throw new Error('文件不存在');
  }
  if (!st.isFile()) throw new Error('这是一个目录');
  const cached = fileTextCache.get(file);
  if (cached && cached.size === st.size && cached.mtime === st.mtimeMs && cached.max >= max) {
    return { ...cached.value, text: cached.value.text.slice(0, max) };
  }
  const ext = textExt(file);
  let result;
  if (ext === 'pdf') {
    result = await extractPdfText(file, max);
  } else if (['doc', 'docx', 'rtf', 'rtfd', 'odt', 'html', 'htm'].includes(ext)) {
    const r = await execFileP('/usr/bin/textutil', ['-convert', 'txt', '-stdout', file], {
      timeout: 20000,
    });
    if (!r.ok && !r.out) throw new Error('这个文档暂时无法提取文字');
    const text = r.out || '';
    result = { text: text.slice(0, max), truncated: text.length > max, pages: 0, kind: ext };
  } else if (isTextExt(file)) {
    result = readTextFileLimited(file, max);
  } else {
    throw new Error('这个格式不是文本，无法直接读取');
  }
  fileTextCache.set(file, { size: st.size, mtime: st.mtimeMs, max, value: result });
  if (fileTextCache.size > 50) {
    const first = fileTextCache.keys().next().value;
    fileTextCache.delete(first);
  }
  return result;
}

async function serveThumb(req, res, url) {
  if (process.platform !== 'darwin') return json(res, 501, { error: '缩略图只支持 macOS' });
  const target = expandLocalPath(url.searchParams.get('path'));
  if (!target) return json(res, 400, { error: '缺少 path' });
  let st;
  try {
    st = fs.statSync(target);
  } catch {
    return json(res, 404, { error: '文件不存在' });
  }
  if (!st.isFile()) return json(res, 400, { error: '这是一个目录' });
  const cacheDir = path.join(DATA_DIR, 'thumb-cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  const key = crypto
    .createHash('sha1')
    .update(`${target}:${st.size}:${st.mtimeMs}`)
    .digest('hex');
  const cached = path.join(cacheDir, `${key}.png`);
  if (!fs.existsSync(cached)) {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-thumb-'));
    try {
      await execFileP('/usr/bin/qlmanage', ['-t', '-s', '1600', '-o', outDir, target], {
        timeout: 20000,
      });
      const png = fs.readdirSync(outDir).find((f) => f.toLowerCase().endsWith('.png'));
      if (!png) return json(res, 404, { error: '这个文件无法生成预览' });
      fs.copyFileSync(path.join(outDir, png), cached);
    } catch {
      return json(res, 404, { error: '这个文件无法生成预览' });
    } finally {
      try {
        fs.rmSync(outDir, { recursive: true, force: true });
      } catch {}
    }
  }
  res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'private, max-age=86400' });
  fs.createReadStream(cached).pipe(res);
}

/* ------------- routes ------------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = url.pathname;

  const local = isLocalRequest(req);
  if (!local) {
    const token = url.searchParams.get('token') || parseCookies(req).bt_token || '';
    if (token && token === remoteToken()) {
      res.setHeader('set-cookie', `bt_token=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`);
    } else if (p === '/m' || p === '/m/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(remoteLoginPage());
      return;
    } else {
      return json(res, 401, { error: 'unauthorized' });
    }
  }

  if (p === '/m' || p === '/m/') {
    const file = path.join(PUBLIC, 'mobile.html');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
    return;
  }

  if (p === '/api/remote/status' && req.method === 'GET') {
    await refreshTailscale();
    const status = remoteStatus();
    if (local) status.token = remoteToken();
    return json(res, 200, status);
  }

  if (p === '/api/remote/auto' && req.method === 'POST') {
    if (!local) return json(res, 403, { error: 'only local' });
    const body = await readBody(req);
    state.settings.remoteAuto = !!body.enabled;
    saveState(state);
    if (state.settings.remoteAuto && !tunnelUrl) {
      startTunnel().catch(() => {});
    } else if (!state.settings.remoteAuto) {
      stopTunnel();
      tailscaleCheckedAt = 0;
    }
    await refreshTailscale();
    return json(res, 200, remoteStatus());
  }

  if (p === '/api/remote/login-item' && req.method === 'POST') {
    if (!local) return json(res, 403, { error: 'only local' });
    return json(res, 200, { ok: true });
  }

  if (p === '/api/remote/start' && req.method === 'POST') {
    if (!local) return json(res, 403, { error: 'only local' });
    const status = await startTunnel();
    await refreshTailscale();
    status.token = remoteToken();
    return json(res, 200, status);
  }

  if (p === '/api/remote/stop' && req.method === 'POST') {
    if (!local) return json(res, 403, { error: 'only local' });
    stopTunnel();
    const status = remoteStatus();
    status.token = remoteToken();
    return json(res, 200, status);
  }

  if (p.startsWith('/uploads/') && serveUpload(req, res, p)) return;
  if (p === '/api/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write('retry: 1500\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (p === '/api/search' && req.method === 'GET') {
    const u = new URL(req.url, 'http://local');
    const q = String(u.searchParams.get('q') || '').trim();
    if (!q) return json(res, 200, { results: [], total: 0, q });
    const needle = q.toLowerCase();
    const chatIds = String(u.searchParams.get('chats') || '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
    const botIds = String(u.searchParams.get('bots') || '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
    const kinds = String(u.searchParams.get('kinds') || 'message,file')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
    const limit = Math.min(300, Math.max(10, Number(u.searchParams.get('limit')) || 100));
    const snippet = (text, at) => {
      const s = String(text || '').replace(/\s+/g, ' ');
      const i = s.toLowerCase().indexOf(needle);
      if (i < 0) return s.slice(0, 160);
      const start = Math.max(0, i - 50);
      return `${start ? '…' : ''}${s.slice(start, i + needle.length + 90)}${i + needle.length + 90 < s.length ? '…' : ''}`;
    };
    const localFileRe = /(?:~\/|\/(?:Users|tmp|private|Volumes)\/)[^\s<>"'`()[\]{}]+?\.[A-Za-z0-9]{1,8}/g;
    const results = [];
    for (const chat of state.chats || []) {
      if (chatIds.length && !chatIds.includes(chat.id)) continue;
      const inChatBots = botIds.length
        ? (chat.botIds || []).some((id) => botIds.includes(id))
        : true;
      if (botIds.length && !inChatBots) continue;
      const base = {
        chatId: chat.id,
        chatTitle: chat.title,
        chatType: chat.type,
        project: chat.project || '',
      };
      if (kinds.includes('message')) {
        for (const m of state.messages?.[chat.id] || []) {
          if (!m.text || !String(m.text).toLowerCase().includes(needle)) continue;
          if (botIds.length && !botIds.includes(m.senderId) && !inChatBots) continue;
          results.push({
            ...base,
            kind: 'message',
            messageId: m.id,
            senderId: m.senderId,
            senderName:
              m.senderId === 'user'
                ? '我'
                : m.senderId === 'system'
                  ? '系统'
                  : state.bots.find((b) => b.id === m.senderId)?.name || 'Bot',
            ts: m.ts,
            snippet: snippet(m.text),
          });
        }
      }
      if (kinds.includes('file')) {
        for (const f of chat.files || []) {
          if (!String(f.name || '').toLowerCase().includes(needle)) continue;
          results.push({
            ...base,
            kind: 'groupfile',
            name: f.name,
            ts: f.at || chat.updatedAt || 0,
            snippet: `${f.name}${f.size ? ` · ${Math.max(1, Math.round(f.size / 1024))} KB` : ''}`,
          });
        }
        for (const m of state.messages?.[chat.id] || []) {
          for (const a of m.attachments || []) {
            if (!String(a.name || '').toLowerCase().includes(needle)) continue;
            results.push({
              ...base,
              kind: 'attachment',
              messageId: m.id,
              name: a.name,
              url: a.url,
              ts: m.ts,
              snippet: a.name,
            });
          }
          if (!m.text) continue;
          localFileRe.lastIndex = 0;
          let mm;
          while ((mm = localFileRe.exec(m.text))) {
            const path = mm[0];
            if (!path.toLowerCase().includes(needle)) continue;
            results.push({
              ...base,
              kind: 'localfile',
              messageId: m.id,
              name: path.split('/').pop(),
              path,
              ts: m.ts,
              snippet: path,
            });
          }
        }
      }
    }
    results.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    return json(res, 200, { q, total: results.length, results: results.slice(0, limit) });
  }

  if (p === '/api/setup/status' && req.method === 'GET') {
    return json(res, 200, setupStatus());
  }

  if (p === '/api/setup/done' && req.method === 'POST') {
    state.settings ||= { leaderId: null };
    state.settings.setupDone = true;
    saveState(state);
    return json(res, 200, setupStatus());
  }

  if (p === '/api/bootstrap' && req.method === 'GET') {
    // 首屏要快：先用已有缓存，模型列表在后台刷新，前端随后单独拉 /api/models。
    refreshModels().catch(() => {});
    return json(res, 200, { ...snapshot(), models: modelCache });
  }

  if (p === '/api/usage/summary' && req.method === 'GET') {
    if (!pricingMeta().live) {
      try {
        await initPricing();
      } catch {}
    }
    const q = new URL(req.url, 'http://localhost').searchParams;
    const data = summarizeUsage(state, {
      days: Number(q.get('days') || 30),
      day: q.get('day') || '',
      includeSubscription: q.get('includeSubscription') === '1',
    });
    return json(res, 200, data);
  }

  if (p === '/favicon.ico' || p === '/favicon.svg') {
    res.writeHead(204);
    return res.end();
  }

  if (p === '/api/providers' && req.method === 'GET') {
    return json(res, 200, { providers: providerSummaries(state) });
  }

  if (p === '/api/open-app' && req.method === 'POST') {
    const body = await readBody(req);
    const apps = {
      antigravity: ['Antigravity'],
      'antigravity-tools': ['Antigravity Tools', 'Antigravity'],
      qoder: ['Qoder CN', 'Qoder'],
      workbuddy: ['WorkBuddy AI', 'WorkBuddy'],
    };
    const names = apps[String(body.app || '')];
    if (!names) return json(res, 400, { error: '不支持的 App' });
    for (const name of names) {
      const ok = await new Promise((resolve) => {
        execFile('open', ['-a', name], (err) => resolve(!err));
      });
      if (ok) return json(res, 200, { ok: true, app: name });
    }
    return json(res, 404, { error: '未找到该 App，请先安装' });
  }

  if (p === '/api/usage/detail' && req.method === 'GET') {
    const q = new URL(req.url, 'http://localhost').searchParams;
    const dim = String(q.get('dim') || '');
    if (!dim) return json(res, 400, { error: '缺少 dim' });
    return json(
      res,
      200,
      summarizeUsageDetail(state, {
        days: q.get('days'),
        day: q.get('day') || '',
        dim,
        key: q.get('key') || '',
        includeSubscription: q.get('includeSubscription') === '1',
      })
    );
  }

  if (p === '/api/usage/balances' && req.method === 'GET') {
    const q = new URL(req.url, 'http://localhost').searchParams;
    const data = await fetchBalances(state, { force: q.get('refresh') === '1' });
    // 自动续期产生的 Cookie 顺手写回本地，下次就不用再换
    let changed = false;
    for (const card of data) {
      if (!card.renewedCookie) continue;
      state.providerKeys ||= {};
      state.providerKeys.mimo = card.renewedCookie;
      if (card.renewedUserId) state.providerKeys.mimoUserId = card.renewedUserId;
      if (card.renewedPassToken) state.providerKeys.mimoPassToken = card.renewedPassToken;
      delete card.renewedCookie;
      delete card.renewedUserId;
      delete card.renewedPassToken;
      changed = true;
    }
    if (changed) await saveState(state);
    return json(res, 200, { balances: data, at: Date.now() });
  }

  if (p === '/api/open-settings' && req.method === 'POST') {
    const body = await readBody(req);
    const urls = {
      fda: 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles',
      privacy: 'x-apple.systempreferences:com.apple.preference.security',
    };
    const url = urls[String(body.target || '')];
    if (!url) return json(res, 400, { error: '不支持的设置项' });
    execFile('open', [url], () => {});
    return json(res, 200, { ok: true });
  }

  if (p === '/api/providers/custom' && req.method === 'GET') {
    return json(res, 200, {
      providers: (state.customProviders || []).map((x) => ({
        id: x.id,
        name: x.name,
        baseUrl: x.baseUrl,
        style: x.style,
        models: x.models || [],
        hasKey: !!state.providerKeys?.[`custom:${x.id}`],
      })),
    });
  }

  if (p === '/api/providers/custom' && req.method === 'POST') {
    const body = await readBody(req);
    const name = String(body.name || '').trim().slice(0, 40);
    const baseUrl = String(body.baseUrl || '').trim().slice(0, 500);
    if (!name) return json(res, 400, { error: '需要提供商名字' });
    if (!/^https?:\/\//i.test(baseUrl)) return json(res, 400, { error: 'Base URL 需要以 http:// 或 https:// 开头' });
    const id =
      String(body.id || name)
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40) || `p${Date.now().toString(36)}`;
    const style = body.style === 'anthropic' ? 'anthropic' : 'openai';
    const models = Array.isArray(body.models)
      ? [...new Set(body.models.map((x) => String(x || '').trim()).filter(Boolean))].slice(0, 100)
      : [];
    state.customProviders ||= [];
    let prov = state.customProviders.find((x) => x.id === id);
    if (!prov) {
      prov = { id, name, baseUrl, style, models };
      state.customProviders.push(prov);
    } else {
      Object.assign(prov, { name, baseUrl, style, models });
    }
    const key = typeof body.key === 'string' ? body.key.trim().slice(0, 4000) : '';
    if (key) {
      state.providerKeys ||= {};
      state.providerKeys[`custom:${id}`] = key;
    }
    saveState(state);
    return json(res, 200, {
      provider: { ...prov, hasKey: !!state.providerKeys?.[`custom:${id}`] },
    });
  }

  {
    const provMatch = p.match(/^\/api\/providers\/custom\/([^/]+)$/);
    if (provMatch && req.method === 'DELETE') {
      const id = decodeURIComponent(provMatch[1]);
      state.customProviders = (state.customProviders || []).filter((x) => x.id !== id);
      if (state.providerKeys) delete state.providerKeys[`custom:${id}`];
      saveState(state);
      return json(res, 200, { ok: true });
    }
  }

  if (p === '/api/providers/mimo/cookie' && req.method === 'POST') {
    const body = await readBody(req);
    const cookie = String(body.cookie || '').trim().slice(0, 8000);
    if (!cookie) return json(res, 400, { error: '没有收到 Cookie' });
    const check = await fetchMimoBalance(cookie);
    if (!check.ok) {
      return json(res, 400, {
        error: check.expired ? '登录态无效，请重新登录 MiMo' : `余额查询失败（HTTP ${check.status}）`,
      });
    }
    state.providerKeys ||= {};
    state.providerKeys.mimo = cookie;
    await saveState(state);
    return json(res, 200, { ok: true, balance: check.data?.data || null });
  }

  if (p === '/api/providers/mimo/diag' && req.method === 'GET') {
    try {
      return json(res, 200, browserDiagnostics());
    } catch (e) {
      return json(res, 500, { error: String(e.message || e) });
    }
  }

  if (p === '/api/providers/mimo/sync' && req.method === 'POST') {
    try {
      const got = await syncMimoLogin();
      state.providerKeys ||= {};
      state.providerKeys.mimo = got.cookie;
      if (got.passToken) state.providerKeys.mimoPassToken = got.passToken;
      if (got.userId) state.providerKeys.mimoUserId = got.userId;
      await saveState(state);
      return json(res, 200, {
        ok: true,
        browser: got.browser,
        profile: got.profile,
        renewed: !!got.renewed,
        balance: got.balance,
      });
    } catch (e) {
      return json(res, 400, { error: String(e.message || e) });
    }
  }

  if (p === '/api/models/fetch' && req.method === 'POST') {
    const body = await readBody(req);
    const base = String(body.baseUrl || '').trim();
    const style = body.style === 'anthropic' ? 'anthropic' : 'openai';
    if (!/^https?:\/\//i.test(base)) {
      return json(res, 400, { error: 'Base URL 需要以 http:// 或 https:// 开头' });
    }
    let key = String(body.key || '').trim();
    if (!key && body.botId) key = state.providerKeys?.[`botapi:${body.botId}`] || '';
    const endpoint = (b) => {
      let u = b.replace(/\/+$/, '');
      if (/\/models$/i.test(u)) return u;
      if (/\/v1$/i.test(u)) return `${u}/models`;
      return `${u}/v1/models`;
    };
    const attempts = [{ url: endpoint(base), auth: style }];
    if (style === 'anthropic') {
      const plain = base.replace(/\/anthropic\/?$/i, '');
      if (plain !== base) attempts.push({ url: endpoint(plain), auth: 'openai' });
    }
    const cacheKey = crypto
      .createHash('sha1')
      .update(`${style}|${base}|${key}`)
      .digest('hex');
    const hit = modelFetchCache.get(cacheKey);
    if (hit && Date.now() - hit.at < 5 * 60 * 1000) {
      return json(res, 200, { models: hit.models, cached: true });
    }
    let lastError = '';
    for (const a of attempts) {
      try {
        const headers = { accept: 'application/json' };
        if (key) {
          if (a.auth === 'anthropic') {
            headers['x-api-key'] = key;
            headers['anthropic-version'] = '2023-06-01';
          } else {
            headers.authorization = `Bearer ${key}`;
          }
        }
        const r = await fetch(a.url, { headers, signal: AbortSignal.timeout(12000) });
        const text = await r.text();
        let data = null;
        try {
          data = JSON.parse(text);
        } catch {}
        if (!r.ok) {
          lastError =
            data?.error?.message || data?.message || text.slice(0, 300) || `HTTP ${r.status}`;
          continue;
        }
        const raw = Array.isArray(data) ? data : data?.data || data?.models || [];
        const models = raw
          .map((m) => {
            if (typeof m === 'string') return { id: m, name: m };
            const id = m?.id || m?.name || m?.model;
            return id ? { id: String(id), name: String(m.name || m.display_name || id) } : null;
          })
          .filter(Boolean)
          .slice(0, 300);
        if (!models.length) {
          lastError = '接口返回了空模型列表';
          continue;
        }
        modelFetchCache.set(cacheKey, { at: Date.now(), models });
        return json(res, 200, { models });
      } catch (e) {
        lastError = String(e?.message || e);
      }
    }
    return json(res, 400, { error: lastError || '拉取模型失败' });
  }

  if (p === '/api/models' && req.method === 'GET') {
    const models = await refreshModels();
    return json(res, 200, models);
  }

  if (p === '/api/skills' && req.method === 'GET') {
    const force = new URL(req.url, 'http://local').searchParams.get('refresh') === '1';
    if (force) readSkills(true);
    return json(res, 200, { skills: skillsForClient() });
  }

  if (p === '/api/skills/explain' && req.method === 'POST') {
    const body = await readBody(req);
    const force = !!body.force;
    const names = Array.isArray(body.names)
      ? body.names.map((x) => String(x)).filter(Boolean)
      : [];
    const all = readSkills();
    let pool = names.length ? all.filter((s) => names.includes(s.name)) : all;
    if (!force) pool = pool.filter((s) => !skillSummaryFor(s.name, s.desc));
    pool = pool.slice(0, 8);
    if (!pool.length) return json(res, 200, { results: {}, remaining: 0 });
    const bot = resolveExplainerBot(String(body.botId || ''));
    if (!bot) return json(res, 400, { error: '没有可以用来生成说明的 Bot' });
    const lines = pool
      .map(
        (s) =>
          `name: ${s.name}\ndesc: ${String(s.desc || '').replace(/\s+/g, ' ').slice(0, 500)}`
      )
      .join('\n\n');
    const prompt = [
      '你是技能说明编辑。请为下面的 skills 写“大白话说明”，面向不懂技术的团队成员。每个 skill 输出：',
      '- what：一句话说明它是干什么的（不超过 28 个字）',
      '- when：什么场景下该用它（不超过 34 个字）',
      '- pros：优势（不超过 26 个字）',
      '- cons：局限或注意事项（不超过 26 个字）',
      '要求：简体中文，具体，避免“强大/高效/全面”这类空话，不要照抄英文。',
      '只输出 JSON 数组，不要 markdown 代码块，格式：[{"name":"技能名","what":"...","when":"...","pros":"...","cons":"..."}]',
      '',
      lines,
    ].join('\n');
    try {
      const resBot = await runBot({
        bot,
        prompt,
        sessionId: null,
        cwd: botWorkspace(bot.id),
        effort: 'low',
        apiKey: state.providerKeys?.[`botapi:${bot.id}`] || '',
        timeoutMs: 180000,
      });
      let content = String(resBot.text || '').trim();
      recordUsage(state, {
        bot,
        usage: resBot.usage,
        kind: 'skills',
        model: bot.model,
        credits: resBot.credits,
      });
      content = content.replace(/```json/gi, '').replace(/```/g, '').trim();
      const m = content.match(/\[[\s\S]*\]/);
      if (!m) throw new Error('模型没有返回可解析的 JSON');
      const arr = JSON.parse(m[0]);
      if (!Array.isArray(arr)) throw new Error('模型返回格式不对');
      state.skillMeta ||= {};
      const results = {};
      for (const item of arr) {
        const name = String(item?.name || '').trim();
        const src = pool.find((s) => s.name === name);
        if (!src) continue;
        const meta = {
          what: String(item.what || '').trim().slice(0, 60),
          when: String(item.when || '').trim().slice(0, 80),
          pros: String(item.pros || '').trim().slice(0, 60),
          cons: String(item.cons || '').trim().slice(0, 60),
          descHash: skillDescHash(src.desc),
          source: 'ai',
          model: bot.model || '',
          at: Date.now(),
        };
        if (!meta.what) continue;
        state.skillMeta[name] = meta;
        results[name] = meta;
      }
      saveState(state);
      const remaining = names.length
        ? Math.max(0, pool.length - Object.keys(results).length)
        : readSkills().filter((s) => !skillSummaryFor(s.name, s.desc)).length;
      return json(res, 200, {
        results,
        remaining,
        bot: { id: bot.id, name: bot.name },
      });
    } catch (e) {
      return json(res, 502, { error: `生成说明失败：${String(e?.message || e).slice(0, 300)}` });
    }
  }

  if (p === '/api/skills/install' && req.method === 'POST') {
    const body = await readBody(req);
    const type = ['role', 'bot', 'group'].includes(body.targetType) ? body.targetType : '';
    const target = resolveSkillTarget(type, String(body.targetId || ''));
    if (!target) return json(res, 400, { error: '先选一个职位 / Bot / 群聊' });
    const targetBot =
      type === 'bot'
        ? target
        : type === 'group'
          ? state.bots.find((b) => (target.botIds || []).includes(b.id)) || null
          : null;
    try {
      const installed = await installSkillFromGithub(String(body.url || ''), targetBot);
      if (!installed.length) return json(res, 400, { error: '仓库里没有可用的技能' });
      target.skills = normalizeSkillList([
        ...(target.skills || []),
        ...installed.map((x) => x.name),
      ]);
      saveState(state);
      if (type === 'role') emit('roles', { roles: state.roles });
      else if (type === 'bot') emit('bots', { bots: state.bots.map(publicBot) });
      else emit('chats', { chats: state.chats });
      return json(res, 200, {
        installed,
        target: { type, id: target.id, skills: target.skills },
      });
    } catch (e) {
      return json(res, 400, { error: String(e?.message || e).slice(0, 400) });
    }
  }

  if (p === '/api/market/wall' && req.method === 'GET') {
    try {
      const data = await getMarketData();
      return json(res, 200, data);
    } catch (e) {
      return json(res, 502, { error: `源仓市场暂时打不开：${String(e?.message || e).slice(0, 200)}` });
    }
  }

  if (p === '/api/market/import' && req.method === 'POST') {
    const body = await readBody(req);
    let remote;
    try {
      remote = new URL(String(body.url || ''));
    } catch {
      return json(res, 400, { error: '图片地址无效' });
    }
    if (remote.protocol !== 'https:' || !/(^|\.)yuancang\.me$/i.test(remote.hostname)) {
      return json(res, 400, { error: '只能从源仓下载图片' });
    }
    let response;
    try {
      response = await fetch(remote, {
        redirect: 'follow',
        headers: { 'user-agent': 'BotTeam/1.0' },
        signal: AbortSignal.timeout(30000),
      });
    } catch (e) {
      return json(res, 502, { error: `下载失败：${String(e?.message || e).slice(0, 160)}` });
    }
    if (!response.ok) return json(res, 502, { error: `下载失败（HTTP ${response.status}）` });
    let finalHost = '';
    try { finalHost = new URL(response.url).hostname; } catch {}
    if (finalHost && !/(^|\.)yuancang\.me$/i.test(finalHost)) {
      return json(res, 400, { error: '图片被重定向到了非源仓地址' });
    }
    const mime = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const extMap = {
      'image/webp': 'webp',
      'image/png': 'png',
      'image/jpeg': 'jpg',
      'image/gif': 'gif',
      'image/avif': 'avif',
    };
    let ext = extMap[mime] || path.extname(remote.pathname).slice(1).toLowerCase();
    if (!['png', 'jpg', 'webp', 'gif', 'avif'].includes(ext)) {
      return json(res, 400, { error: '这个文件不是支持的图片格式' });
    }
    let buf;
    try {
      buf = Buffer.from(await response.arrayBuffer());
    } catch (e) {
      return json(res, 502, { error: `下载失败：${String(e?.message || e).slice(0, 160)}` });
    }
    if (!buf.length) return json(res, 502, { error: '下载到的图片是空的' });
    if (buf.length > 30 * 1024 * 1024) return json(res, 413, { error: '图片太大（上限 30MB）' });
    const kind = body.kind === 'wallpaper' ? 'wallpapers' : 'avatars';
    const dir = path.join(UPLOADS_DIR, kind);
    try {
      fs.mkdirSync(dir, { recursive: true });
      const filename = `${Date.now()}-market-${Math.random().toString(36).slice(2, 8)}.${ext}`;
      fs.writeFileSync(path.join(dir, filename), buf);
      return json(res, 200, {
        url: `/uploads/${kind}/${filename}`,
        size: buf.length,
        mime: mime || `image/${ext}`,
        source: 'https://yuancang.me/wall',
      });
    } catch (e) {
      return json(res, 500, { error: `保存失败：${String(e?.message || e).slice(0, 160)}` });
    }
  }

  if (p === '/api/uploads' && req.method === 'POST') {
    const body = await readBody(req);
    const kind =
      body.kind === 'wallpaper' ? 'wallpapers' : body.kind === 'file' ? 'files' : 'avatars';
    let data = String(body.data || '');
    let ext = '';
    let mime = String(body.mime || '');
    const dataUrl = data.match(/^data:([^;,]+);base64,(.+)$/i);
    if (dataUrl) {
      mime = mime || dataUrl[1].toLowerCase();
      data = dataUrl[2];
    }
    const rawName = String(body.name || 'file');
    const nameExt = path.extname(rawName).toLowerCase().replace('.', '');
    if (!ext) ext = nameExt;
    if (ext === 'jpeg') ext = 'jpg';
    ext = ext.replace(/[^a-z0-9]/g, '').slice(0, 8) || 'bin';
    const isImage = /^image\//i.test(mime) || ['png', 'jpg', 'webp', 'gif', 'avif'].includes(ext);
    if (kind !== 'files') {
      const allowed = ['png', 'jpg', 'webp', 'gif', 'avif'];
      if (!data || !allowed.includes(ext)) {
        return json(res, 400, { error: '只支持 png / jpg / webp / gif / avif 图片' });
      }
    }
    const limit = kind === 'files' ? 42 * 1024 * 1024 : 28 * 1024 * 1024;
    if (!data || data.length > limit) {
      return json(res, 413, { error: `文件太大（上限约 ${Math.round((limit * 3) / 4 / 1024 / 1024)}MB）` });
    }
    const dir = path.join(UPLOADS_DIR, kind);
    fs.mkdirSync(dir, { recursive: true });
    const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    let size = 0;
    try {
      const buf = Buffer.from(data, 'base64');
      size = buf.length;
      fs.writeFileSync(path.join(dir, filename), buf);
    } catch (e) {
      return json(res, 500, { error: `保存失败：${e.message}` });
    }
    return json(res, 200, {
      url: `/uploads/${kind}/${filename}`,
      name: rawName,
      size,
      mime: mime || (isImage ? `image/${ext}` : 'application/octet-stream'),
    });
  }

  if (p === '/api/workflows/export' && req.method === 'POST') {
    const body = await readBody(req);
    const ext = ['html', 'png', 'pdf'].includes(String(body.ext || '')) ? String(body.ext) : 'html';
    let buf;
    if (ext === 'html') {
      const html = String(body.html || '');
      if (!html || html.length > 4 * 1024 * 1024) {
        return json(res, 400, { error: '导出内容为空或过大' });
      }
      buf = Buffer.from(html, 'utf8');
    } else {
      const data = String(body.data || '');
      if (!data) return json(res, 400, { error: '导出内容为空' });
      buf = Buffer.from(data, 'base64');
      if (!buf.length || buf.length > 40 * 1024 * 1024) {
        return json(res, 400, { error: '导出文件过大' });
      }
    }
    try {
      const file = writeExportFile(String(body.name || '流程图'), ext, buf);
      return json(res, 200, { ok: true, path: file });
    } catch (e) {
      return json(res, 500, { error: `写入失败：${e.message}` });
    }
  }

  // 让领导 Bot / CLI 也能导出：服务端自己生成 HTML 并落盘
  const wfExportMatch = p.match(/^\/api\/chats\/([^/]+)\/workflow\/export$/);
  if (wfExportMatch && req.method === 'POST') {
    const chat = state.chats.find((c) => c.id === wfExportMatch[1]);
    if (!chat) return json(res, 404, { error: 'chat not found' });
    const wf = chat.workflow;
    if (!wf?.nodes?.length) return json(res, 400, { error: '这个群还没有发布流程图' });
    const bots = state.bots.filter((b) => (chat.botIds || []).includes(b.id));
    try {
      const html = buildWorkflowHtml(chat, wf, bots);
      const file = writeExportFile(`${chat.title}-${wf.name || '流程图'}`, 'html', Buffer.from(html, 'utf8'));
      return json(res, 200, { ok: true, path: file, name: wf.name || '流程图', nodes: wf.nodes.length });
    } catch (e) {
      return json(res, 500, { error: `导出失败：${e.message}` });
    }
  }

  // 聊天里出现的本地文件：检查是否存在、打开、在访达中显示
  if (p === '/api/files/raw' && req.method === 'GET') {
    return serveRawFile(req, res, url);
  }
  if (p === '/api/files/thumb' && req.method === 'GET') {
    return serveThumb(req, res, url);
  }
  if (p === '/api/files/preview' && req.method === 'GET') {
    const target = expandLocalPath(url.searchParams.get('path'));
    if (!target) return json(res, 400, { error: '缺少 path' });
    try {
      const st = fs.statSync(target);
      if (!st.isFile()) return json(res, 400, { error: '这是一个目录' });
    } catch {
      return json(res, 404, { error: '文件不存在' });
    }
    const port = await startPreviewServer();
    const encoded = target.split('/').map(encodeURIComponent).join('/');
    return json(res, 200, { url: `http://127.0.0.1:${port}/f${encoded}` });
  }
  if (p === '/api/files/find' && req.method === 'GET') {
    const q = url.searchParams.get('name') || url.searchParams.get('q') || '';
    return json(res, 200, { files: searchLocalFiles(q), q });
  }
  if (p === '/api/files/stat' && req.method === 'GET') {
    const target = expandLocalPath(url.searchParams.get('path'));
    if (!target) return json(res, 400, { error: '缺少 path' });
    try {
      const st = fs.statSync(target);
      return json(res, 200, { exists: true, isFile: st.isFile(), size: st.size, mtime: st.mtimeMs });
    } catch {
      return json(res, 404, { exists: false });
    }
  }

  if (p === '/api/files/write-docx' && req.method === 'POST') {
    const body = await readBody(req);
    const target = expandLocalPath(body.path);
    if (!target || !target.startsWith('/')) return json(res, 400, { error: '需要绝对路径' });
    if (path.extname(target).toLowerCase() !== '.docx') {
      return json(res, 400, { error: '这个接口只用于 .docx' });
    }
    let st;
    try { st = fs.statSync(target); } catch { return json(res, 404, { error: '文件不存在' }); }
    if (body.mtime && Math.abs(Number(body.mtime) - st.mtimeMs) > 2) {
      return json(res, 409, { error: '文件已被其他程序修改，先重新载入再保存', mtime: st.mtimeMs });
    }
    const html = String(body.html || '');
    if (html.length > 12 * 1024 * 1024) return json(res, 413, { error: '内容太大（上限 12MB）' });
    const stamp = `${process.pid}-${Date.now()}`;
    const tmpHtml = `${target}.bt-${stamp}.html`;
    const tmpDocx = `${target}.bt-${stamp}.docx`;
    try {
      const full = /<html[\s>]/i.test(html)
        ? html
        : `<!doctype html><html><head><meta charset="utf-8"></head><body>${html}</body></html>`;
      fs.writeFileSync(tmpHtml, full, 'utf8');
      const r = await execFileP('/usr/bin/textutil', ['-convert', 'docx', '-output', tmpDocx, tmpHtml], { timeout: 60000 });
      if (!r.ok || !fs.existsSync(tmpDocx)) throw new Error(r.err || 'textutil 转换失败');
      try { fs.chmodSync(tmpDocx, st.mode); } catch {}
      fs.renameSync(tmpDocx, target);
      const after = fs.statSync(target);
      return json(res, 200, { ok: true, mtime: after.mtimeMs, size: after.size });
    } catch (e) {
      return json(res, 500, { error: String(e?.message || e) });
    } finally {
      try { fs.rmSync(tmpHtml, { force: true }); } catch {}
      try { fs.rmSync(tmpDocx, { force: true }); } catch {}
    }
  }

  if (p === '/api/editor/register' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      const out = registerEditor({
        sessionId: body.sessionId,
        filePath: body.filePath,
        kind: body.kind,
      });
      return json(res, 200, out);
    } catch (e) {
      return json(res, 400, { error: String(e?.message || e).slice(0, 200) });
    }
  }

  if (p === '/api/editor/unregister' && req.method === 'POST') {
    const body = await readBody(req);
    unregisterEditor(body.sessionId);
    return json(res, 200, { ok: true });
  }

  if (p === '/api/editor/poll' && req.method === 'GET') {
    const sessionId = url.searchParams.get('sessionId') || '';
    if (!touchEditor(sessionId)) return json(res, 404, { error: '编辑器会话不存在' });
    return json(res, 200, { ops: takeEditorOps(sessionId) });
  }

  if (p === '/api/editor/ack' && req.method === 'POST') {
    const body = await readBody(req);
    const ok = ackEditorOp(body.sessionId, body.id, body.result);
    return json(res, 200, { ok });
  }

  if (p === '/api/office/pdf/read' && req.method === 'GET') {
    const target = expandLocalPath(url.searchParams.get('path'));
    if (!target || !target.startsWith('/')) return json(res, 400, { error: '需要绝对路径' });
    if (path.extname(target).toLowerCase() !== '.pdf') {
      return json(res, 400, { error: '只支持 .pdf' });
    }
    let st;
    try { st = fs.statSync(target); } catch { return json(res, 404, { error: '文件不存在' }); }
    try {
      const out = await runPdfEdit('read', target, {});
      return json(res, 200, { ...out, mtime: st.mtimeMs });
    } catch (e) {
      return json(res, 500, { error: String(e?.message || e).slice(0, 400) });
    }
  }

  if (p === '/api/office/pdf/write' && req.method === 'POST') {
    const body = await readBody(req);
    const target = expandLocalPath(body.path);
    if (!target || !target.startsWith('/')) return json(res, 400, { error: '需要绝对路径' });
    if (path.extname(target).toLowerCase() !== '.pdf') {
      return json(res, 400, { error: '只支持 .pdf' });
    }
    let st;
    try { st = fs.statSync(target); } catch { return json(res, 404, { error: '文件不存在' }); }
    if (body.mtime && Math.abs(Number(body.mtime) - st.mtimeMs) > 2) {
      return json(res, 409, { error: '文件已被其他程序修改，先重新载入再保存', mtime: st.mtimeMs });
    }
    const payload = {
      updates: Array.isArray(body.updates) ? body.updates : [],
      replacements: Array.isArray(body.replacements) ? body.replacements : [],
      additions: Array.isArray(body.additions) ? body.additions : [],
      highlights: Array.isArray(body.highlights) ? body.highlights : [],
    };
    if (
      !payload.updates.length &&
      !payload.replacements.length &&
      !payload.additions.length &&
      !payload.highlights.length
    ) {
      return json(res, 200, { ok: true, updated: 0, mtime: st.mtimeMs });
    }
    try {
      const out = await runPdfEdit('apply', target, payload);
      const after = fs.statSync(target);
      return json(res, 200, { ...out, mtime: after.mtimeMs });
    } catch (e) {
      return json(res, 500, { error: String(e?.message || e).slice(0, 400) });
    }
  }

  if (p === '/api/office/xlsx/write' && req.method === 'POST') {
    const body = await readBody(req);
    const target = expandLocalPath(body.path);
    if (!target || !target.startsWith('/')) return json(res, 400, { error: '需要绝对路径' });
    if (path.extname(target).toLowerCase() !== '.xlsx') {
      return json(res, 400, { error: '目前只能保存 .xlsx（旧版 .xls 请先另存为 .xlsx）' });
    }
    let st;
    try { st = fs.statSync(target); } catch { return json(res, 404, { error: '文件不存在' }); }
    if (!st.isFile()) return json(res, 400, { error: '这是一个目录' });
    if (body.mtime && Math.abs(Number(body.mtime) - st.mtimeMs) > 2) {
      return json(res, 409, { error: '文件已被其他程序修改，先重新载入再保存', mtime: st.mtimeMs });
    }
    const updates = Array.isArray(body.updates) ? body.updates : [];
    if (!updates.length) return json(res, 200, { ok: true, updated: 0, mtime: st.mtimeMs });
    try {
      const out = await runOfficeEdit('xlsx-write', target, { updates });
      const after = fs.statSync(target);
      return json(res, 200, { ok: true, updated: out.updated || updates.length, mtime: after.mtimeMs });
    } catch (e) {
      return json(res, 500, { error: String(e?.message || e).slice(0, 400) });
    }
  }

  if (p === '/api/office/pptx/outline' && req.method === 'GET') {
    const target = expandLocalPath(url.searchParams.get('path'));
    if (!target || !target.startsWith('/')) return json(res, 400, { error: '需要绝对路径' });
    if (path.extname(target).toLowerCase() !== '.pptx') {
      return json(res, 400, { error: '目前只能编辑 .pptx（旧版 .ppt 请先另存为 .pptx）' });
    }
    let st;
    try { st = fs.statSync(target); } catch { return json(res, 404, { error: '文件不存在' }); }
    try {
      const out = await runOfficeEdit('pptx-outline', target, {});
      return json(res, 200, { ...out, mtime: st.mtimeMs });
    } catch (e) {
      return json(res, 500, { error: String(e?.message || e).slice(0, 400) });
    }
  }

  if (p === '/api/office/pptx/write' && req.method === 'POST') {
    const body = await readBody(req);
    const target = expandLocalPath(body.path);
    if (!target || !target.startsWith('/')) return json(res, 400, { error: '需要绝对路径' });
    if (path.extname(target).toLowerCase() !== '.pptx') {
      return json(res, 400, { error: '目前只能保存 .pptx' });
    }
    let st;
    try { st = fs.statSync(target); } catch { return json(res, 404, { error: '文件不存在' }); }
    if (body.mtime && Math.abs(Number(body.mtime) - st.mtimeMs) > 2) {
      return json(res, 409, { error: '文件已被其他程序修改，先重新载入再保存', mtime: st.mtimeMs });
    }
    const paragraphs = Array.isArray(body.paragraphs) ? body.paragraphs : [];
    if (!paragraphs.length) return json(res, 200, { ok: true, updated: 0, mtime: st.mtimeMs });
    try {
      const out = await runOfficeEdit('pptx-write', target, { paragraphs });
      const after = fs.statSync(target);
      return json(res, 200, { ok: true, updated: out.updated || paragraphs.length, mtime: after.mtimeMs });
    } catch (e) {
      return json(res, 500, { error: String(e?.message || e).slice(0, 400) });
    }
  }

  if (p === '/api/files/write' && req.method === 'POST') {
    const body = await readBody(req);
    const target = expandLocalPath(body.path);
    if (!target || !target.startsWith('/')) return json(res, 400, { error: '需要绝对路径' });
    if (!isTextExt(target)) return json(res, 400, { error: '这个格式不支持直接编辑' });
    let st;
    try { st = fs.statSync(target); } catch { return json(res, 404, { error: '文件不存在' }); }
    if (!st.isFile()) return json(res, 400, { error: '这是一个目录' });
    const content = String(body.content ?? '');
    if (content.length > 8 * 1024 * 1024) return json(res, 413, { error: '内容太大（上限 8MB）' });
    if (body.mtime && Math.abs(Number(body.mtime) - st.mtimeMs) > 2) {
      return json(res, 409, { error: '文件已被其他程序修改，先重新载入再保存', mtime: st.mtimeMs });
    }
    try {
      const tmp = `${target}.bt-tmp-${process.pid}`;
      fs.writeFileSync(tmp, content, 'utf8');
      try { fs.chmodSync(tmp, st.mode); } catch {}
      fs.renameSync(tmp, target);
      const after = fs.statSync(target);
      return json(res, 200, { ok: true, mtime: after.mtimeMs, size: after.size });
    } catch (e) {
      return json(res, 500, { error: String(e?.message || e) });
    }
  }

  if (p === '/api/rewrite' && req.method === 'POST') {
    const body = await readBody(req);
    const text = String(body.text || '').slice(0, 8000);
    if (!text.trim()) return json(res, 400, { error: '没有要改写的内容' });
    try {
      const target = resolveEngine('explain');
      const out = await rewriteText(text, {
        instruction: String(body.instruction || '').slice(0, 500),
        bot: target.bot,
        apiKey: target.apiKey || '',
      });
      return json(res, 200, { text: out });
    } catch (e) {
      return json(res, 400, { error: String(e?.message || e).slice(0, 300) });
    }
  }

  if (p === '/api/files/text' && req.method === 'GET') {
    const target = expandLocalPath(url.searchParams.get('path'));
    const max = Math.min(30000, Math.max(1000, Number(url.searchParams.get('max')) || 12000));
    if (!target) return json(res, 400, { error: '缺少 path' });
    try {
      const result = await extractFileText(target, max);
      return json(res, 200, { path: target, ...result });
    } catch (e) {
      return json(res, 400, { error: String(e?.message || e).slice(0, 300) });
    }
  }

  const fileFileMatch = p.match(/^\/api\/files\/(check|open|reveal)$/);
  if (fileFileMatch && req.method === 'POST') {
    const body = await readBody(req);
    const action = fileFileMatch[1];
    const cleanPath = (v) => {
      const t = String(v || '').trim();
      return t.startsWith('~/') ? path.join(os.homedir(), t.slice(2)) : t;
    };
    if (action === 'check') {
      const list = Array.isArray(body.paths) ? body.paths.slice(0, 40) : [];
      const files = list.map((raw) => {
        const target = cleanPath(raw);
        try {
          const st = fs.statSync(target);
          return {
            path: String(raw),
            exists: true,
            isDir: st.isDirectory(),
            size: st.isFile() ? st.size : 0,
            mtime: st.mtimeMs,
            name: path.basename(target),
            ext: path.extname(target).slice(1).toLowerCase(),
          };
        } catch {
          return {
            path: String(raw),
            exists: false,
            isDir: false,
            size: 0,
            name: path.basename(target),
            ext: path.extname(target).slice(1).toLowerCase(),
          };
        }
      });
      return json(res, 200, { files });
    }
    const target = cleanPath(body.path);
    if (!target || !target.startsWith('/')) return json(res, 400, { error: '需要绝对路径' });
    if (!fs.existsSync(target)) return json(res, 404, { error: '文件不存在' });
    try {
      const args = action === 'reveal' ? ['-R', target] : [target];
      spawn('open', args, { stdio: 'ignore', detached: true }).unref();
      return json(res, 200, { ok: true });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  if (p === '/api/explain' && req.method === 'POST') {
    const body = await readBody(req);
    const text = String(body.text || '').slice(0, 4000);
    if (!text.trim()) return json(res, 400, { error: '没有要解释的内容' });
    try {
      const target = resolveEngine('explain');
      const out = await explainText(text, {
        bot: target.bot,
        apiKey: target.apiKey || '',
      });
      return json(res, 200, { text: out, bot: target.bot?.name || target.engine });
    } catch (e) {
      return json(res, 400, { error: String(e?.message || e).slice(0, 300) });
    }
  }

  if (p === '/api/video/transcribe' && req.method === 'POST') {
    const body = await readBody(req);
    const target = expandLocalPath(body.path);
    const ext = path.extname(target).slice(1).toLowerCase();
    if (!VIDEO_EXTS.has(ext)) return json(res, 400, { error: '不是支持的视频格式' });
    let st;
    try { st = fs.statSync(target); } catch { return json(res, 404, { error: '视频不存在' }); }
    if (!st.isFile()) return json(res, 400, { error: '这是一个目录' });
    const cacheFile = videoCachePath(target, st);
    if (fs.existsSync(cacheFile)) {
      try {
        return json(res, 200, { cached: true, result: JSON.parse(fs.readFileSync(cacheFile, 'utf8')) });
      } catch {}
    }
    const id = uid('vt');
    videoJobs.set(id, { id, path: target, status: 'queued', progress: 0, createdAt: Date.now() });
    void runVideoJob(id, target, String(body.language || ''));
    return json(res, 202, { id });
  }

  const videoJobMatch = p.match(/^\/api\/video\/transcribe\/([^/]+)$/);
  if (videoJobMatch && req.method === 'GET') {
    const job = videoJobs.get(videoJobMatch[1]);
    if (!job) return json(res, 404, { error: '任务不存在或已过期' });
    return json(res, 200, {
      id: job.id,
      status: job.status,
      progress: job.progress || 0,
      error: job.error || '',
      translateError: job.translateError || '',
      summaryError: job.summaryError || '',
      result: job.status === 'done' ? job.result : null,
    });
  }

  if (p === '/api/video/live' && req.method === 'POST') {
    const body = await readBody(req);
    const target = expandLocalPath(body.path);
    const ext = path.extname(target).slice(1).toLowerCase();
    if (!VIDEO_EXTS.has(ext)) return json(res, 400, { error: '不是支持的视频格式' });
    try {
      const out = await liveTranscribe(
        target,
        Number(body.start) || 0,
        Math.min(12, Math.max(2, Number(body.duration) || 5)),
        String(body.language || '')
      );
      return json(res, 200, out);
    } catch (e) {
      return json(res, 400, { error: String(e?.message || e).slice(0, 300) });
    }
  }

  if (p === '/api/translate' && req.method === 'POST') {
    const body = await readBody(req);
    const texts = (Array.isArray(body.texts) ? body.texts : [])
      .map((t) => String(t ?? '').slice(0, 4000))
      .slice(0, 80);
    if (!texts.length) return json(res, 400, { error: '没有要翻译的内容' });
    const target = ['zh-CN', 'zh-TW', 'en', 'ja', 'ko'].includes(body.target)
      ? body.target
      : state.settings?.translateTarget || 'zh-CN';
    try {
      const resolved = resolveEngine('translate');
      const translations = await translateTexts(texts, {
        engine: resolved.engine === 'free' ? 'free' : 'bot',
        target,
        bot: resolved.bot || null,
        apiKey: resolved.apiKey || '',
      });
      return json(res, 200, { translations, engine: resolved.engine, target });
    } catch (e) {
      return json(res, 400, { error: String(e?.message || e).slice(0, 300) });
    }
  }

  if (p === '/api/settings' && req.method === 'PATCH') {
    const body = await readBody(req);
    state.settings ||= { leaderId: null };
    if (body.leaderId !== undefined) {
      const leader = state.bots.find((b) => b.id === body.leaderId) || null;
      state.settings.leaderId = leader ? leader.id : null;
      if (leader && !String(leader.persona || '').trim()) {
        leader.persona = LEADER_PERSONA;
      }
      if (leader) {
        // 领导默认加入所有群，但不占默认接单
        for (const c of state.chats) {
          if (c.type !== 'group') continue;
          if (!c.botIds.includes(leader.id)) c.botIds.push(leader.id);
          if (c.leadId === leader.id || !c.botIds.includes(c.leadId)) {
            const worker = c.botIds
              .map((id) => state.bots.find((b) => b.id === id))
              .find((b) => b && b.id !== leader.id);
            c.leadId = worker ? worker.id : null;
          }
        }
      }
      state.settings.version = 2;
    }
    if (body.providerKeys && typeof body.providerKeys === 'object') {
      state.providerKeys ||= {};
      for (const [k, v] of Object.entries(body.providerKeys)) {
        if (typeof v === 'string') state.providerKeys[k] = v.trim().slice(0, 4000);
      }
    }
    if (body.wallpaper !== undefined) state.settings.wallpaper = !!body.wallpaper;
    if (body.voice !== undefined) {
      const v = body.voice || {};
      state.settings.voice = {
        enabled: v.enabled !== false,
        address: String(v.address || DEFAULT_VOICE.address).trim().slice(0, 20) || DEFAULT_VOICE.address,
        style: String(v.style || DEFAULT_VOICE.style).trim().slice(0, 2000) || DEFAULT_VOICE.style,
      };
    }
    if (body.notifySound !== undefined) state.settings.notifySound = !!body.notifySound;
    if (body.fastMode !== undefined) state.settings.fastMode = !!body.fastMode;
    for (const key of ['translateConfig', 'explainConfig']) {
      if (body[key] !== undefined) {
        const c = body[key] || {};
        const prev = state.settings[key] || {};
        const modes = key === 'explainConfig' ? ['bot', 'custom'] : ['free', 'bot', 'custom'];
        const next = {
          mode: modes.includes(c.mode) ? c.mode : modes[0],
          botId: state.bots.some((b) => b.id === c.botId) ? c.botId : '',
          baseUrl: String(c.baseUrl || '').slice(0, 500),
          model: String(c.model || '').slice(0, 200),
          style: c.style === 'anthropic' ? 'anthropic' : 'openai',
          apiKey:
            c.apiKey === undefined
              ? prev.apiKey || ''
              : String(c.apiKey || '').slice(0, 4000),
        };
        state.settings[key] = next;
      }
    }
    if (body.translateEngine !== undefined) {
      state.settings.translateEngine = body.translateEngine === 'bot' ? 'bot' : 'free';
    }
    if (body.translateBotId !== undefined) {
      const b = state.bots.find((x) => x.id === body.translateBotId);
      state.settings.translateBotId = b ? b.id : '';
    }
    if (body.translateTarget !== undefined) {
      state.settings.translateTarget = ['zh-CN', 'zh-TW', 'en', 'ja', 'ko'].includes(body.translateTarget)
        ? body.translateTarget
        : 'zh-CN';
    }
    if (body.flowRetries !== undefined) {
      const n = Number(body.flowRetries);
      if (n < 0) state.settings.flowRetries = -1;
      else state.settings.flowRetries = Number.isFinite(n) ? Math.max(0, Math.min(10, Math.round(n))) : 3;
    }
    if (body.flowNodeMinutes !== undefined) {
      const n = Number(body.flowNodeMinutes);
      state.settings.flowNodeMinutes = Number.isFinite(n)
        ? Math.max(0, Math.min(180, Math.round(n)))
        : 30;
    }
    if (body.creditPlans && typeof body.creditPlans === 'object') {
      const plans = {};
      for (const key of ['qoder', 'codebuddy']) {
        const raw = body.creditPlans[key];
        if (!raw || typeof raw !== 'object') continue;
        const price = Number(raw.pricePerCredit);
        const tokens = Number(raw.tokensPerCredit);
        plans[key] = {};
        if (Number.isFinite(price) && price >= 0 && price <= 100) {
          plans[key].pricePerCredit = price;
        }
        if (Number.isFinite(tokens) && tokens >= 0 && tokens <= 1e9) {
          plans[key].tokensPerCredit = tokens;
        }
      }
      state.settings.creditPlans = plans;
    }
    if (body.sound !== undefined) {
      state.settings.sound = ['reply', 'soft', 'chime'].includes(body.sound) ? body.sound : 'reply';
    }
    const themeInput = body.theme !== undefined ? body.theme : body.wallpaperColor;
    if (themeInput !== undefined) {
      const t = String(themeInput || '');
      const theme = t === 'light' || t === 'white' ? 'light' : t === 'dark' || t === 'black' ? 'dark' : '';
      if (theme) {
        state.settings.theme = theme;
        state.settings.wallpaperFile = null;
      }
    }
    if (body.wallpaperFile !== undefined) {
      const f = String(body.wallpaperFile || '');
      state.settings.wallpaperFile = /^\/(uploads|wallpapers)\//.test(f) ? f : null;
      if (state.settings.wallpaperFile) state.settings.theme = 'dark';
    }
    if (body.order && typeof body.order === 'object') {
      const cleanIds = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, 500) : []);
      state.settings.order = {
        groups: cleanIds(body.order.groups),
        bots: cleanIds(body.order.bots),
      };
    }
    let proxyApplied = '';
    if (body.proxy !== undefined) {
      state.settings.proxy = String(body.proxy || '').trim().slice(0, 500);
      proxyApplied = await setupProxy(state.settings.proxy);
    }
    saveState(state);
    emit('settings', { settings: settingsPublic() });
    emit('bots', { bots: state.bots.map(publicBot) });
    emit('chats', { chats: state.chats });
    return json(res, 200, { settings: settingsPublic(), proxy: proxyApplied });
  }

  if (p === '/api/chats' && req.method === 'POST') {
    const body = await readBody(req);
    const botIds = (body.botIds || []).filter((id) => state.bots.some((b) => b.id === id));
    const leader = state.bots.find((b) => b.id === state.settings?.leaderId);
    const isGroup = body.type !== 'dm';
    if (isGroup && leader && !botIds.includes(leader.id)) botIds.push(leader.id);
    const workerIds = botIds.filter((id) => !leader || id !== leader.id);
    const title = String(body.title || (isGroup ? '新群聊' : '私聊')).slice(0, 60);
    if (isGroup) {
      const dup = state.chats.find(
        (c) =>
          c.type === 'group' &&
          c.title === title &&
          Date.now() - (c.createdAt || 0) < 8000
      );
      if (dup) return json(res, 200, dup);
    }
    const chat = {
      id: uid('chat'),
      type: isGroup ? 'group' : 'dm',
      title,
      project: isGroup ? '' : String(body.project || '默认项目').slice(0, 40),
      botIds,
      leadId:
        body.leadId && workerIds.includes(body.leadId)
          ? body.leadId
          : workerIds[0] || botIds[0] || null,
      effort: 'auto',
      permission: normalizePermission(body.permission),
      roleIds: {},
      announcement: String(body.announcement || '').slice(0, 4000),
      skills: normalizeSkillList(body.skills),
      files: [],
      log: [],
      createdAt: Date.now(),
    };
    state.chats.push(chat);
    if (isGroup) ensureGroupProjects(state, chat);
    saveState(state);
    emit('chats', { chats: state.chats });
    return json(res, 200, chat);
  }

  const chatMatch = p.match(/^\/api\/chats\/([^/]+)$/);
  if (chatMatch) {
    const chat = state.chats.find((c) => c.id === chatMatch[1]);
    if (!chat) return json(res, 404, { error: 'chat not found' });
    if (req.method === 'GET') {
      return json(res, 200, { chat, messages: state.messages[chat.id] || [] });
    }
    if (req.method === 'PATCH') {
      const body = await readBody(req);
      if (body.title) chat.title = body.title;
      if (body.leadId) chat.leadId = body.leadId;
      if (Array.isArray(body.botIds)) chat.botIds = body.botIds;
      if (body.effort && EFFORTS.includes(body.effort)) chat.effort = body.effort;
      if (body.project !== undefined && chat.type === 'dm') {
        chat.project = String(body.project).trim().slice(0, 40) || '默认项目';
      }
      if (body.permission !== undefined) chat.permission = normalizePermission(body.permission);
      if (body.roleIds && typeof body.roleIds === 'object' && chat.type === 'group') {
        const clean = {};
        for (const [botId, roleId] of Object.entries(body.roleIds)) {
          if (!chat.botIds.includes(botId)) continue;
          if (!state.roles?.some((r) => r.id === roleId)) continue;
          clean[botId] = roleId;
        }
        chat.roleIds = clean;
      }
      if (chat.type === 'group' && chat.roleIds) {
        for (const id of Object.keys(chat.roleIds)) {
          if (!chat.botIds.includes(id)) delete chat.roleIds[id];
        }
      }
      if (chat.type === 'group' && chat.loopTargetId && !chat.botIds.includes(chat.loopTargetId)) {
        chat.loopTargetId = pickLoopTarget(chat);
      }
      if (body.announcement !== undefined) chat.announcement = String(body.announcement).slice(0, 4000);
      if (body.skills !== undefined) chat.skills = normalizeSkillList(body.skills);
      if (body.loopPrompt !== undefined) {
        chat.loopPrompt = String(body.loopPrompt || '').slice(0, 2000);
      }
      if (body.loopTargetId !== undefined) {
        chat.loopTargetId = chat.botIds.includes(body.loopTargetId)
          ? body.loopTargetId
          : pickLoopTarget(chat);
      }
      if (body.draining !== undefined) chat.draining = !!body.draining;
      if (body.drainNote !== undefined) {
        chat.drainNote = String(body.drainNote || '').slice(0, 1000);
      }
      if (body.workflow !== undefined) {
        if (body.workflow === null) {
          if (workflowRuns.has(chat.id)) {
            return json(res, 409, { error: '流程正在运行，不能删除，请先停止或暂停' });
          }
          ensureWorkflowSet(chat);
          const activeId = chat.workflow?.id;
          chat.workflows = (chat.workflows || []).filter((w) => w.id !== activeId);
          const next = chat.workflows[0] || null;
          chat.workflow = next;
          chat.activeWorkflowId = next?.id || null;
        } else {
          const wf = sanitizeWorkflow(chat, body.workflow);
          if (!wf) return json(res, 400, { error: '流程至少需要一个有效环节' });
          ensureWorkflowSet(chat);
          const prev = chat.workflow;
          if (prev) {
            // 同一个群的多条流程共用 id 命名空间，保存时沿用当前流程的 id
            wf.id = prev.id;
            // 运行中也能改：原地替换节点定义，保留运行时状态和历史。
            // 引擎每一步都会按 id 重新查节点，所以未跑的环节会立刻用新版；
            // 已经跑过的环节要等下一轮循环才会用新版。
            const runtime = {
              status: prev.status,
              currentNodeId: prev.currentNodeId,
              startedAt: prev.startedAt,
              finishedAt: prev.finishedAt,
              history: prev.history,
              resume: prev.resume,
              drain: prev.drain,
              pauseRequested: prev.pauseRequested,
              pausedByUser: prev.pausedByUser,
              lastError: prev.lastError,
              reportInFlight: prev.reportInFlight,
              lastStopReportAt: prev.lastStopReportAt,
              lastStopStatus: prev.lastStopStatus,
            };
            Object.assign(prev, wf, runtime);
            if (prev.resume && !prev.nodes.some((n) => n.id === prev.resume.nodeId)) {
              prev.resume = null;
            }
            if (!chat.workflows.some((w) => w.id === prev.id)) chat.workflows.push(prev);
            chat.workflow = prev;
            chat.activeWorkflowId = prev.id;
          } else {
            chat.workflow = wf;
            ensureWorkflowSet(chat);
          }
        }
      }
      if (chat.type === 'group') {
        const leader = state.bots.find((b) => b.id === state.settings?.leaderId);
        if (leader && !chat.botIds.includes(leader.id)) chat.botIds.push(leader.id);
        if (
          chat.leadId === leader?.id ||
          !chat.leadId ||
          !chat.botIds.includes(chat.leadId)
        ) {
          const worker = chat.botIds
            .map((id) => state.bots.find((b) => b.id === id))
            .find((b) => b && b.id !== leader?.id);
          chat.leadId = worker ? worker.id : chat.botIds[0] || null;
        }
        ensureGroupProjects(state, chat);
        for (const p of state.chats) {
          if (p.linkedGroupId !== chat.id) continue;
          p.project = chat.title;
          p.permission = normalizePermission(chat.permission);
        }
      }
      saveState(state);
      emit('chats', { chats: state.chats });
      return json(res, 200, chat);
    }
    if (req.method === 'DELETE') {
      addTombstone({
        type: chat.type === 'group' ? 'group' : 'chat',
        id: chat.id,
        title: chat.title,
        chatType: chat.type,
        project: chat.project || '',
      });
      state.chats = state.chats.filter((c) => c.id !== chat.id);
      delete state.messages[chat.id];
      state.schedules = (state.schedules || []).filter((sch) => sch.chatId !== chat.id);
      for (const p of state.chats) if (p.linkedGroupId === chat.id) p.linkedGroupId = null;
      saveState(state);
      emit('chats', { chats: state.chats });
      return json(res, 200, { ok: true });
    }
  }

  const fileMatch = p.match(/^\/api\/chats\/([^/]+)\/files(?:\/([^/]+))?$/);
  if (fileMatch) {
    const chat = state.chats.find((c) => c.id === fileMatch[1]);
    if (!chat) return json(res, 404, { error: 'chat not found' });
    chat.files ||= [];
    const dir = path.join(GROUPS_DIR, chat.id, 'files');
    fs.mkdirSync(dir, { recursive: true });

    if (req.method === 'POST' && !fileMatch[2]) {
      const body = await readBody(req);
      const rawName = String(body.name || '').trim();
      const data = String(body.data || '');
      if (!rawName || !data) return json(res, 400, { error: '缺少文件名或内容' });
      if (data.length > 36 * 1024 * 1024) return json(res, 413, { error: '文件太大（上限约 25MB）' });
      const safe = rawName.replace(/[\\/:*?"<>|]/g, '_').slice(-120) || 'file';
      let file = safe;
      let i = 1;
      while (chat.files.some((f) => f.file === file)) {
        const dot = safe.lastIndexOf('.');
        file = dot > 0 ? `${safe.slice(0, dot)}-${i}${safe.slice(dot)}` : `${safe}-${i}`;
        i += 1;
      }
      const buf = Buffer.from(data, 'base64');
      fs.writeFileSync(path.join(dir, file), buf);
      chat.files.push({ name: file, file, size: buf.length, at: Date.now() });
      saveState(state);
      emit('chats', { chats: state.chats });
      return json(res, 200, { files: chat.files });
    }

    if (req.method === 'DELETE' && fileMatch[2]) {
      const name = decodeURIComponent(fileMatch[2]);
      const hit = chat.files.find((f) => f.file === name || f.name === name);
      if (hit) {
        try {
          fs.rmSync(path.join(dir, hit.file || hit.name), { force: true });
        } catch {}
        chat.files = chat.files.filter((f) => f !== hit);
        saveState(state);
        emit('chats', { chats: state.chats });
      }
      return json(res, 200, { files: chat.files });
    }

    return json(res, 405, { error: 'method not allowed' });
  }

  /* ---- 定时任务 API ---- */
  if (p === '/api/schedules') {
    if (req.method === 'GET') return json(res, 200, { schedules: publicSchedules() });
    if (req.method === 'POST') {
      const body = await readBody(req);
      const chat = state.chats.find((c) => c.id === String(body.chatId || ''));
      if (!chat) return json(res, 400, { error: '先选一个会话' });
      const prompt = String(body.prompt || '').trim();
      if (!prompt) return json(res, 400, { error: '任务内容不能为空' });
      const kind = SCHEDULE_KINDS.includes(body.kind) ? body.kind : 'daily';
      const sch = {
        id: uid('sch'),
        chatId: chat.id,
        title: String(body.title || '').trim().slice(0, 60) || '定时任务',
        prompt: prompt.slice(0, 4000),
        kind,
        time: normalizeScheduleTime(body.time),
        weekdays: normalizeWeekdays(body.weekdays),
        every: Math.max(1, Math.min(10080, Number(body.every) || 60)),
        unit: body.unit === 'hour' ? 'hour' : 'minute',
        at: Number(body.at) || 0,
        enabled: body.enabled !== false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        lastRunAt: 0,
        lastStatus: '',
        lastError: '',
        nextRunAt: null,
      };
      if (kind === 'once') {
        if (!sch.at || sch.at <= Date.now()) return json(res, 400, { error: '执行时间要晚于现在' });
        sch.nextRunAt = sch.enabled ? sch.at : null;
      } else {
        sch.nextRunAt = sch.enabled ? computeNextRun(sch, Date.now()) : null;
      }
      state.schedules ||= [];
      state.schedules.push(sch);
      saveState(state);
      emit('schedules', { schedules: publicSchedules() });
      return json(res, 200, { schedule: publicSchedules().find((x) => x.id === sch.id) });
    }
    return json(res, 405, { error: 'method not allowed' });
  }

  const schRunMatch = p.match(/^\/api\/schedules\/([^/]+)\/run$/);
  if (schRunMatch && req.method === 'POST') {
    const sch = (state.schedules || []).find((x) => x.id === schRunMatch[1]);
    if (!sch) return json(res, 404, { error: '没有这个定时任务' });
    try {
      const started = fireSchedule(sch, { manual: true });
      return json(res, 200, { ok: true, started });
    } catch (e) {
      return json(res, 400, { error: String(e?.message || e) });
    }
  }

  const schMatch = p.match(/^\/api\/schedules\/([^/]+)$/);
  if (schMatch) {
    const sch = (state.schedules || []).find((x) => x.id === schMatch[1]);
    if (!sch) return json(res, 404, { error: '没有这个定时任务' });
    if (req.method === 'PATCH') {
      const body = await readBody(req);
      if (body.chatId !== undefined) {
        const chat = state.chats.find((c) => c.id === String(body.chatId || ''));
        if (!chat) return json(res, 400, { error: '没有这个会话' });
        sch.chatId = chat.id;
      }
      if (body.title !== undefined) {
        sch.title = String(body.title || '').trim().slice(0, 60) || sch.title;
      }
      if (body.prompt !== undefined) {
        const prompt = String(body.prompt || '').trim();
        if (!prompt) return json(res, 400, { error: '任务内容不能为空' });
        sch.prompt = prompt.slice(0, 4000);
      }
      if (body.kind !== undefined) {
        if (!SCHEDULE_KINDS.includes(body.kind)) return json(res, 400, { error: '频率不合法' });
        sch.kind = body.kind;
      }
      if (body.time !== undefined) sch.time = normalizeScheduleTime(body.time);
      if (body.weekdays !== undefined) sch.weekdays = normalizeWeekdays(body.weekdays);
      if (body.every !== undefined) {
        sch.every = Math.max(1, Math.min(10080, Number(body.every) || 60));
      }
      if (body.unit !== undefined) sch.unit = body.unit === 'hour' ? 'hour' : 'minute';
      if (body.at !== undefined) sch.at = Number(body.at) || 0;
      if (body.enabled !== undefined) sch.enabled = !!body.enabled;
      if (sch.kind === 'once') {
        if (!sch.at || sch.at <= Date.now()) {
          return json(res, 400, { error: '执行时间要晚于现在' });
        }
        if (sch.enabled) sch.nextRunAt = sch.at;
      } else if (sch.enabled) {
        sch.nextRunAt = computeNextRun(sch, Date.now());
      }
      if (!sch.enabled) sch.nextRunAt = null;
      sch.updatedAt = Date.now();
      saveState(state);
      emit('schedules', { schedules: publicSchedules() });
      return json(res, 200, { schedule: publicSchedules().find((x) => x.id === sch.id) });
    }
    if (req.method === 'DELETE') {
      state.schedules = (state.schedules || []).filter((x) => x.id !== sch.id);
      saveState(state);
      emit('schedules', { schedules: publicSchedules() });
      return json(res, 200, { ok: true });
    }
    return json(res, 405, { error: 'method not allowed' });
  }

  const wfSetMatch = p.match(/^\/api\/chats\/([^/]+)\/workflows$/);
  if (wfSetMatch) {
    const chat = state.chats.find((c) => c.id === wfSetMatch[1]);
    if (!chat) return json(res, 404, { error: 'chat not found' });
    ensureWorkflowSet(chat);
    if (req.method === 'GET') {
      return json(res, 200, {
        activeId: chat.activeWorkflowId,
        workflows: (chat.workflows || []).map((w) => ({
          id: w.id,
          name: w.name,
          status: w.status,
          updatedAt: w.updatedAt || w.createdAt || 0,
          nodes: (w.nodes || []).length,
          currentNodeId: w.id === chat.activeWorkflowId ? w.currentNodeId || null : null,
        })),
      });
    }
    if (req.method === 'POST') {
      const body = await readBody(req);
      const action = String(body.action || '');
      const running = () => workflowRuns.has(chat.id);
      const switchTo = (wf) => {
        chat.workflow = wf;
        chat.activeWorkflowId = wf?.id || null;
        saveState(state);
        emit('chats', { chats: state.chats });
      };
      if (action === 'switch') {
        if (running()) return json(res, 409, { error: '流程运行中，先暂停或停止再切换' });
        const target = (chat.workflows || []).find((w) => w.id === body.id);
        if (!target) return json(res, 404, { error: '没有这条流程' });
        switchTo(target);
        return json(res, 200, { ok: true, activeId: target.id });
      }
      if (action === 'create') {
        if (running()) return json(res, 409, { error: '流程运行中，先暂停或停止再新建' });
        const botId = chat.leadId || chat.botIds[0];
        if (!botId) return json(res, 400, { error: '这个群还没有 Bot' });
        const nodeId = `wfn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`;
        const wf = {
          id: uid('wf'),
          name: String(body.name || `流程 ${(chat.workflows || []).length + 1}`).slice(0, 80),
          status: 'draft',
          startNodeId: nodeId,
          maxSteps: 50,
          nodes: [
            {
              id: nodeId,
              title: '步骤 1',
              botId,
              model: '',
              task: '',
              role: 'normal',
              nextMode: 'end',
              stopWhen: '',
              allowEnd: false,
              parallel: null,
              next: [{ to: '__end__', when: 'always', keyword: '' }],
            },
          ],
          history: [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        chat.workflows.push(wf);
        switchTo(wf);
        return json(res, 200, { ok: true, id: wf.id, activeId: wf.id });
      }
      if (action === 'duplicate') {
        if (running()) return json(res, 409, { error: '流程运行中，先暂停或停止再复制' });
        const src = (chat.workflows || []).find((w) => w.id === (body.id || chat.activeWorkflowId));
        if (!src) return json(res, 404, { error: '没有这条流程' });
        const copy = JSON.parse(JSON.stringify(src));
        copy.id = uid('wf');
        copy.name = `${src.name || '流程'} 副本`.slice(0, 80);
        copy.status = 'draft';
        copy.history = [];
        copy.resume = null;
        copy.startedAt = null;
        copy.finishedAt = null;
        copy.createdAt = Date.now();
        copy.updatedAt = Date.now();
        chat.workflows.push(copy);
        switchTo(copy);
        return json(res, 200, { ok: true, id: copy.id, activeId: copy.id });
      }
      if (action === 'rename') {
        const wf = (chat.workflows || []).find((w) => w.id === (body.id || chat.activeWorkflowId));
        if (!wf) return json(res, 404, { error: '没有这条流程' });
        wf.name = String(body.name || wf.name).slice(0, 80);
        wf.updatedAt = Date.now();
        saveState(state);
        emit('chats', { chats: state.chats });
        return json(res, 200, { ok: true });
      }
      if (action === 'delete') {
        const id = String(body.id || chat.activeWorkflowId || '');
        if (running() && id === chat.workflow?.id) {
          return json(res, 409, { error: '流程运行中，先暂停或停止再删除' });
        }
        chat.workflows = (chat.workflows || []).filter((w) => w.id !== id);
        if (chat.activeWorkflowId === id) {
          const next = chat.workflows[0] || null;
          switchTo(next);
        } else {
          saveState(state);
          emit('chats', { chats: state.chats });
        }
        return json(res, 200, { ok: true });
      }
      return json(res, 400, { error: 'action 必须是 switch / create / duplicate / rename / delete' });
    }
  }

  const workflowMatch = p.match(/^\/api\/chats\/([^/]+)\/workflow$/);
  if (workflowMatch && req.method === 'POST') {
    const chat = state.chats.find((c) => c.id === workflowMatch[1]);
    if (!chat) return json(res, 404, { error: 'chat not found' });
    const body = await readBody(req);
    if (body.action === 'run' || body.action === 'resume') {
      const r = startWorkflow(chat, { resume: body.action === 'resume' });
      if (r.error) return json(res, 400, { error: r.error });
      return json(res, 200, {
        ok: true,
        status: chat.workflow?.status,
        resumed: !!r.resumed,
        from: r.from || '',
      });
    }
    if (body.action === 'drain') {
      const r = drainWorkflow(chat, { reason: body.reason, nodeId: body.nodeId });
      if (r.error) return json(res, 400, { error: r.error });
      return json(res, 200, r);
    }
    if (body.action === 'pause') {
      const r = pauseWorkflow(chat);
      if (r.error) return json(res, 400, { error: r.error });
      return json(res, 200, { ok: true });
    }
    if (body.action === 'stop') {
      const r = stopWorkflow(chat);
      if (r.error) return json(res, 400, { error: r.error });
      return json(res, 200, { ok: true });
    }
    return json(res, 400, { error: 'action 必须是 run / drain / stop' });
  }

  const loopMatch = p.match(/^\/api\/chats\/([^/]+)\/loop$/);
  if (loopMatch && req.method === 'POST') {
    const chat = state.chats.find((c) => c.id === loopMatch[1]);
    if (!chat) return json(res, 404, { error: 'chat not found' });
    const body = await readBody(req);
    if (body.enabled) {
      if (!chat.botIds?.length) return json(res, 400, { error: '这个群还没有 Bot' });
      if (workflowRuns.has(chat.id)) stopWorkflow(chat);
      chat.loopTargetId = pickLoopTarget(chat, body.loopTargetId);
      if (body.loopPrompt !== undefined) {
        chat.loopPrompt = String(body.loopPrompt || '').slice(0, 2000);
      } else if (chat.draining) {
        chat.loopPrompt = '';
        chat.draining = false;
        chat.drainNote = '';
      }
      chat.loop = true;
      chat.loopRound = 0;
      const m = addMessage(state, chat.id, {
        type: 'system',
        text: '已开启持续运行：Bot 会一轮接一轮推进，直到你说 /stop 或任务输出 @@DONE。',
      });
      saveState(state);
      emit('message', { chatId: chat.id, message: m });
      emit('chats', { chats: state.chats });
      scheduleLoop(chat, 0);
    } else {
      stopLoop(chat);
      const m = addMessage(state, chat.id, {
        type: 'system',
        text: '已停止：正在执行的任务已中断，自动运行已关闭。',
      });
      saveState(state);
      emit('message', { chatId: chat.id, message: m });
      emit('chats', { chats: state.chats });
    }
    return json(res, 200, { loop: !!chat.loop });
  }

  const stopTurnMatch = p.match(/^\/api\/chats\/([^/]+)\/stop$/);
  if (stopTurnMatch && req.method === 'POST') {
    const chat = state.chats.find((c) => c.id === stopTurnMatch[1]);
    if (!chat) return json(res, 404, { error: 'chat not found' });
    const ctrl = runAborts.get(chat.id);
    if (!ctrl) return json(res, 200, { ok: true, running: false });
    try {
      ctrl.abort();
    } catch {}
    return json(res, 200, { ok: true, running: true });
  }

  const steerMatch = p.match(/^\/api\/chats\/([^/]+)\/steer$/);
  if (steerMatch && req.method === 'POST') {
    const chat = state.chats.find((c) => c.id === steerMatch[1]);
    if (!chat) return json(res, 404, { error: 'chat not found' });
    const body = await readBody(req);
    const text = String(body.text || '').trim();
    const attachments = (Array.isArray(body.attachments) ? body.attachments : [])
      .filter((a) => a && /^\/uploads\/files\//.test(String(a.url || '')))
      .map((a) => ({
        url: a.url,
        name: String(a.name || '').slice(0, 120),
        mime: String(a.mime || ''),
        size: Number(a.size) || 0,
      }));
    if (!text && !attachments.length) return json(res, 400, { error: '没有要插话的内容' });
    const steerText = text
      ? `${text}\n\n（插话：并入上面的任务一起处理，不要从头重来。）`
      : text;
    // 和普通消息一样，先落盘再排队：否则插话会在上一轮结束前"消失"。
    const steerLeader = state.settings?.leaderId
      ? state.bots.find((b) => b.id === state.settings.leaderId)
      : null;
    const steerMsg = addMessage(state, chat.id, {
      senderId: steerLeader && chat.type !== 'dm' ? steerLeader.id : 'user',
      text: steerText,
      attachments,
      meta: steerLeader && chat.type !== 'dm' ? { viaUser: true, steer: true } : { steer: true },
    });
    saveState(state);
    emit('message', { chatId: chat.id, message: steerMsg });
    const ctrl = runAborts.get(chat.id);
    enqueue(chat.id, async () => {
      const c = new AbortController();
      runAborts.set(chat.id, c);
      try {
        await runTurn({
          state,
          chat,
          text: steerText,
          attachments,
          preRecorded: true,
          uptoId: steerMsg.id,
          save: () => saveState(state),
          emit,
          browser: runBrowserCommand,
          signal: c.signal,
        });
      } finally {
        if (runAborts.get(chat.id) === c) runAborts.delete(chat.id);
        emit('bots', { bots: state.bots.map(publicBot) });
        emit('chats', { chats: state.chats });
        if (chat.loop) scheduleLoop(chat, 2500);
      }
    });
    if (ctrl) {
      try {
        ctrl.abort();
      } catch {}
    }
    return json(res, 202, { ok: true, steered: !!ctrl });
  }

  const msgMatch = p.match(/^\/api\/chats\/([^/]+)\/messages$/);
  if (msgMatch && req.method === 'POST') {
    const chat = state.chats.find((c) => c.id === msgMatch[1]);
    if (!chat) return json(res, 404, { error: 'chat not found' });
    const body = await readBody(req);
    const text = String(body.text || '').trim();
    const attachments = (Array.isArray(body.attachments) ? body.attachments : [])
      .filter((a) => a && /^\/uploads\/files\//.test(String(a.url || '')))
      .map((a) => ({
        url: String(a.url),
        name: String(a.name || 'file').slice(0, 200),
        mime: String(a.mime || ''),
        size: Number(a.size || 0),
      }))
      .slice(0, 10);
    if (!text && !attachments.length) return json(res, 400, { error: 'empty' });
    const context = String(body.context || '').slice(0, 20000);
    const selection = String(body.selection || '').slice(0, 20000);

    if (text.startsWith('/')) {
      const [cmd, ...rest] = text.slice(1).split(/\s+/);
      if (cmd === 'loop') {
        if (chat.type !== 'group') return json(res, 400, { error: '持续运行只用于群聊' });
        if (!chat.botIds?.length) return json(res, 400, { error: '这个群还没有 Bot' });
        chat.loopTargetId = pickLoopTarget(chat);
        if (chat.draining) {
          chat.loopPrompt = '';
          chat.draining = false;
          chat.drainNote = '';
        }
        chat.loop = true;
        chat.loopRound = 0;
        const m = addMessage(state, chat.id, {
          type: 'system',
          text: '已开启持续运行：Bot 会一轮接一轮推进，直到你说 /stop 或任务输出 @@DONE。',
        });
        saveState(state);
        emit('message', { chatId: chat.id, message: m });
        emit('chats', { chats: state.chats });
        scheduleLoop(chat, 0);
        return json(res, 200, { ok: true, loop: true });
      }
      if (cmd === 'stop') {
        stopLoop(chat);
        const m = addMessage(state, chat.id, { type: 'system', text: '已停止：正在执行的任务已中断，自动运行已关闭。' });
        saveState(state);
        emit('message', { chatId: chat.id, message: m });
        emit('chats', { chats: state.chats });
        return json(res, 200, { ok: true });
      }
      if (cmd === 'clear') {
        delete state.messages[chat.id];        delete chat.contextSummary;
        delete chat.compactedAt;
        delete chat.compactedCount;
        for (const b of state.bots) {
          const keys = new Set([chat.id]);
          if (chat.linkedGroupId) keys.add(chat.linkedGroupId);
          for (const p of state.chats) if (p.linkedGroupId === chat.id) keys.add(p.id);
          for (const k of keys) if (b.sessions?.[k]) delete b.sessions[k];
        }
        saveState(state);
        emit('cleared', { chatId: chat.id });
        return json(res, 200, { ok: true });
      }
      if (cmd === 'compact') {
        enqueue(chat.id, async () => {
          const result = await compactChat({ state, chat, save: () => saveState(state), emit });
          if (!result.ok) {
            const m = addMessage(state, chat.id, {
              type: 'system',
              text: `压缩失败：${result.reason}`,
            });
            saveState(state);
            emit('message', { chatId: chat.id, message: m });
          }
          emit('bots', { bots: state.bots.map(publicBot) });
        });
        return json(res, 202, { ok: true });
      }
    }

    dispatchChatTurn(chat, text, attachments, context, selection);
    return json(res, 202, { ok: true });
  }

  if (p === '/api/agy/profiles' && req.method === 'GET') {
    return json(res, 200, { profiles: agyProfilesPayload() });
  }

  if (p === '/api/agy/profiles' && req.method === 'POST') {
    if (!local) return json(res, 403, { error: 'only local' });
    const body = await readBody(req);
    const name = String(body.name || '').trim().slice(0, 40) || 'Google 账号';
    const id = uid('agy');
    const home = path.join(AGY_PROFILES_DIR, id);
    const gemini = path.join(home, '.gemini');
    fs.mkdirSync(path.join(gemini, 'antigravity-cli'), { recursive: true });
    ensureAgyHome(home);
    try {
      const skills = path.join(os.homedir(), '.gemini/skills');
      if (fs.existsSync(skills)) fs.symlinkSync(skills, path.join(gemini, 'skills'), 'dir');
    } catch {}
    for (const rel of ['settings.json', 'antigravity-cli/settings.json']) {
      try {
        const src = path.join(os.homedir(), '.gemini', rel);
        if (fs.existsSync(src)) fs.copyFileSync(src, path.join(gemini, rel));
      } catch {}
    }
    const profile = { id, name, home, createdAt: Date.now() };
    state.agyProfiles ||= [];
    state.agyProfiles.push(profile);
    saveState(state);
    emit('agyProfiles', { profiles: agyProfilesPayload() });
    return json(res, 200, agyProfileInfo(profile));
  }

  const agyProfileMatch = p.match(/^\/api\/agy\/profiles\/([^/]+)(?:\/(login))?$/);
  const agyModelsMatch = p.match(/^\/api\/agy\/profiles\/([^/]+)\/models$/);
  if (agyModelsMatch && req.method === 'GET') {
    const profile = agyProfileById(agyModelsMatch[1]);
    if (!profile) return json(res, 404, { error: 'profile not found' });
    try {
      const out = await fetchAgyModels(profile);
      const repaired = repairAgyBotModels(profile.id, out.models);
      return json(res, 200, {
        profileId: profile.id,
        models: out.models,
        account: out.account,
        ready: agyProfileInfo(profile).ready,
        at: out.at,
        repaired,
      });
    } catch (e) {
      return json(res, 500, { error: String(e?.message || e).slice(0, 300) });
    }
  }

  if (agyProfileMatch && req.method === 'POST' && agyProfileMatch[2] === 'login') {
    if (!local) return json(res, 403, { error: 'only local' });
    const profile = agyProfileById(agyProfileMatch[1]);
    if (!profile) return json(res, 404, { error: 'profile not found' });
    agyProfileModelsCache.delete(profile.id);
    const home = agyProfileHome(profile);
    const realHome = os.homedir();
    const scriptPath = path.join(AGY_PROFILES_DIR, `${profile.id}-login.command`);
    const script = `#!/bin/zsh
REAL_HOME="${realHome.replace(/"/g, '\\"')}"
export HOME="${home.replace(/"/g, '\\"')}"
cd "$HOME"
if [ "$HOME" != "$REAL_HOME" ]; then
  mkdir -p "$HOME/Library"
  ln -sfn "$REAL_HOME/Library/Keychains" "$HOME/Library/Keychains"
fi
if [ -f "$REAL_HOME/Library/Keychains/login.keychain-db" ]; then
  security default-keychain -d user -s "$REAL_HOME/Library/Keychains/login.keychain-db" >/dev/null 2>&1
  security list-keychains -d user -s "$REAL_HOME/Library/Keychains/login.keychain-db" >/dev/null 2>&1
fi
"${resolveCmd('agy')}"
`;
    fs.mkdirSync(AGY_PROFILES_DIR, { recursive: true });
    fs.writeFileSync(scriptPath, script, { mode: 0o755 });
    execFile('open', ['-a', 'Terminal', scriptPath], () => {});
    return json(res, 200, { ok: true, scriptPath });
  }

  if (agyProfileMatch && req.method === 'DELETE') {
    if (!local) return json(res, 403, { error: 'only local' });
    const profile = agyProfileById(agyProfileMatch[1]);
    if (!profile) return json(res, 404, { error: 'profile not found' });
    if (profile.id === 'default') return json(res, 400, { error: '默认账号不能删除' });
    state.agyProfiles = state.agyProfiles.filter((p) => p.id !== profile.id);
    agyProfileModelsCache.delete(profile.id);
    for (const b of state.bots) if (b.agyProfile === profile.id) b.agyProfile = 'default';
    try {
      fs.rmSync(path.join(AGY_PROFILES_DIR, profile.id), { recursive: true, force: true });
    } catch {}
    saveState(state);
    emit('agyProfiles', { profiles: agyProfilesPayload() });
    emit('bots', { bots: state.bots.map(publicBot) });
    return json(res, 200, { ok: true });
  }

  if (p === '/api/roles' && req.method === 'POST') {
    const body = await readBody(req);
    const name = String(body.name || '').trim().slice(0, 40);
    if (!name) return json(res, 400, { error: '职位名称不能为空' });
    const role = {
      id: uid('role'),
      name,
      abbr: String(body.abbr || '').trim().slice(0, 12),
      emoji: String(body.emoji || '🧩').slice(0, 4),
      builtin: false,
      persona: String(body.persona || '').slice(0, 4000),
      memory: String(body.memory || '').slice(0, 4000),
      skills: Array.isArray(body.skills)
        ? body.skills.map((s) => String(s).trim()).filter(Boolean).slice(0, 200)
        : String(body.skills || '')
            .split(/[,，\n]/)
            .map((s) => s.trim())
            .filter(Boolean)
            .slice(0, 200),
      createdAt: Date.now(),
    };
    state.roles ||= [];
    state.roles.push(role);
    saveState(state);
    emit('roles', { roles: state.roles });
    return json(res, 200, role);
  }

  const roleMatch = p.match(/^\/api\/roles\/([^/]+)$/);
  if (roleMatch) {
    const role = (state.roles || []).find((r) => r.id === roleMatch[1]);
    if (!role) return json(res, 404, { error: 'role not found' });
    if (req.method === 'PATCH') {
      const body = await readBody(req);
      if (body.name !== undefined) role.name = String(body.name).trim().slice(0, 40);
      if (body.abbr !== undefined) role.abbr = String(body.abbr).trim().slice(0, 12);
      if (body.emoji !== undefined) role.emoji = String(body.emoji).slice(0, 4);
      if (body.persona !== undefined) role.persona = String(body.persona).slice(0, 4000);
      if (body.memory !== undefined) role.memory = String(body.memory).slice(0, 4000);
      if (body.skills !== undefined) {
        role.skills = Array.isArray(body.skills)
          ? body.skills.map((s) => String(s).trim()).filter(Boolean).slice(0, 200)
          : String(body.skills || '')
              .split(/[,，\n]/)
              .map((s) => s.trim())
              .filter(Boolean)
              .slice(0, 200);
      }
      saveState(state);
      emit('roles', { roles: state.roles });
      return json(res, 200, role);
    }
    if (req.method === 'DELETE') {
      state.roles = (state.roles || []).filter((r) => r.id !== role.id);
      for (const b of state.bots) if (b.roleId === role.id) b.roleId = null;
      for (const c of state.chats) {
        if (!c.roleIds) continue;
        for (const id of Object.keys(c.roleIds)) {
          if (c.roleIds[id] === role.id) delete c.roleIds[id];
        }
      }
      saveState(state);
      emit('roles', { roles: state.roles });
      emit('bots', { bots: state.bots.map(publicBot) });
      emit('chats', { chats: state.chats });
      return json(res, 200, { ok: true });
    }
  }

  if (p === '/api/bots' && req.method === 'POST') {
    const body = await readBody(req);
    const backend = ['opencode', 'codex', 'agy', 'codebuddy', 'qoder', 'claude', 'custom'].includes(
      body.backend
    )
      ? body.backend
      : 'opencode';
    const model = String(body.model || '');
    const source = String(body.source || '');
    const name = String(body.name || '新成员').slice(0, 40);
    const dup = state.bots.find(
      (b) =>
        b.name === name &&
        b.backend === backend &&
        String(b.model || '') === model &&
        Date.now() - (b.createdAt || 0) < 8000
    );
    if (dup) return json(res, 200, dup);
    const provider = body.provider
      ? (state.customProviders || []).find(
          (x) => x.id === String(body.provider) || x.name === String(body.provider)
        )
      : null;
    const bot = {
      id: uid('bot'),
      name,
      emoji: String(body.emoji || '🙂').slice(0, 4),
      color: String(body.color || '#6c5ce7'),
      backend,
      model,
      source,
      billing: ['subscription', 'payg', 'free'].includes(body.billing) ? body.billing : defaultBilling(source),
      persona: String(body.persona || ''),
      customTools: body.customTools !== false,
      skills: normalizeSkillList(body.skills),
      permission: normalizePermission(body.permission),
      roleId: state.roles?.some((r) => r.id === body.roleId) ? body.roleId : null,
      agyProfile:
        body.backend === 'agy' && state.agyProfiles?.some((p) => p.id === body.agyProfile)
          ? body.agyProfile
          : 'default',
      showRoleAbbr: body.showRoleAbbr !== false,
      quota: String(body.quota || '').trim(),
      hidden: !!body.hidden,
      codexFast: body.codexFast !== false,
      timeoutMin:
        Number.isFinite(Number(body.timeoutMin)) && Number(body.timeoutMin) > 0
          ? Math.min(Number(body.timeoutMin), 1440)
          : 0,
      api:
        provider && backend === 'custom'
          ? {
              mode: 'custom',
              style: provider.style || 'openai',
              baseUrl: provider.baseUrl,
              models: [...(provider.models || [])],
            }
          : ['claude', 'codex', 'custom'].includes(backend)
            ? normalizeBotApi(body.api, backend)
            : null,
      memory: String(body.memory || ''),
      avatar: String(body.avatar || '') || pickAvatar(state.bots.map((b) => b.avatar)),
      sessions: {},
      usage: emptyUsage(),
      createdAt: Date.now(),
    };
    normalizeSource(bot);
    applyDerivedSource(bot);
    if (['claude', 'codex', 'custom'].includes(backend)) {
      state.providerKeys ||= {};
      const key = typeof body.api?.key === 'string' ? body.api.key.trim().slice(0, 4000) : '';
      if (key) state.providerKeys[`botapi:${bot.id}`] = key;
      if (provider) {
        const pk = state.providerKeys[`custom:${provider.id}`];
        if (pk) state.providerKeys[`botapi:${bot.id}`] = pk;
      }
    }
    state.bots.push(bot);
    state.settings ||= { leaderId: null };
    // 第一个 Bot 自动成为领导；之后保持用户已选的领导
    if (!state.settings.leaderId || !state.bots.some((b) => b.id === state.settings.leaderId)) {
      state.settings.leaderId = bot.id;
    }
    let dmChatId = null;
    if (body.chatId) {
      const chat = state.chats.find((c) => c.id === body.chatId);
      if (chat && !chat.botIds.includes(bot.id)) chat.botIds.push(bot.id);
      if (chat?.type === 'group') ensureGroupProjects(state, chat);
    } else if (!state.chats.some((c) => c.type === 'dm' && (c.botIds || []).includes(bot.id))) {
      // 新建 Bot 时顺手建一个默认项目私聊，第一次点击就能直接聊
      const dm = {
        id: uid('chat'),
        type: 'dm',
        title: bot.name,
        project: '默认项目',
        botIds: [bot.id],
        leadId: bot.id,
        effort: 'auto',
        permission: normalizePermission(undefined),
        roleIds: {},
        announcement: '',
        skills: [],
        files: [],
        log: [],
        createdAt: Date.now(),
      };
      state.chats.push(dm);
      dmChatId = dm.id;
    }
    state.settings.setupDone = true;
    saveState(state);
    emit('bots', { bots: state.bots.map(publicBot) });
    if (dmChatId) emit('chats', { chats: state.chats });
    return json(res, 200, { ...bot, dmChatId });
  }

  const botMatch = p.match(/^\/api\/bots\/([^/]+)$/);
  if (botMatch) {
    const bot = state.bots.find((b) => b.id === botMatch[1]);
    if (!bot) return json(res, 404, { error: 'bot not found' });
    if (req.method === 'PATCH') {
      const body = await readBody(req);
      if (body.name !== undefined) bot.name = String(body.name).slice(0, 40);
      if (body.emoji !== undefined) bot.emoji = String(body.emoji).slice(0, 4);
      if (body.avatar !== undefined) bot.avatar = String(body.avatar);
      if (body.color !== undefined) bot.color = String(body.color);
      if (body.backend !== undefined) {
        if (['opencode', 'codex', 'agy', 'codebuddy', 'qoder', 'claude', 'custom'].includes(body.backend)) {
          if (bot.backend !== body.backend) bot.sessions = {};
          bot.backend = body.backend;
        }
      }
      if (body.provider !== undefined) {
        const provider = (state.customProviders || []).find(
          (x) => x.id === String(body.provider) || x.name === String(body.provider)
        );
        if (provider) {
          bot.backend = 'custom';
          bot.api = {
            mode: 'custom',
            style: provider.style || 'openai',
            baseUrl: provider.baseUrl,
            models: [...(provider.models || [])],
          };
          const pk = state.providerKeys?.[`custom:${provider.id}`];
          if (pk) {
            state.providerKeys ||= {};
            state.providerKeys[`botapi:${bot.id}`] = pk;
          }
        }
      }
      if (body.api !== undefined) applyBotApi(bot, body.api);
      if (body.model !== undefined) {
        if (bot.model !== body.model) bot.sessions = {};
        bot.model = String(body.model);
      }
      if (body.persona !== undefined) bot.persona = String(body.persona);
      if (body.customTools !== undefined) bot.customTools = body.customTools !== false;
      if (body.skills !== undefined) bot.skills = normalizeSkillList(body.skills);
      if (body.permission !== undefined) bot.permission = normalizePermission(body.permission);
      if (body.roleId !== undefined) {
        bot.roleId = state.roles?.some((r) => r.id === body.roleId) ? body.roleId : null;
      }
      if (body.showRoleAbbr !== undefined) bot.showRoleAbbr = body.showRoleAbbr !== false;
      if (body.agyProfile !== undefined) {
        bot.agyProfile = state.agyProfiles?.some((p) => p.id === body.agyProfile)
          ? body.agyProfile
          : 'default';
        bot.sessions = {};
      }
      if (body.hidden !== undefined) bot.hidden = !!body.hidden;
      if (body.lastChatId !== undefined) {
        bot.lastChatId = String(body.lastChatId || '').slice(0, 80);
      }
      if (body.codexFast !== undefined) bot.codexFast = body.codexFast !== false;
      if (body.flowDesignRules !== undefined) {
        bot.flowDesignRules = String(body.flowDesignRules || '').slice(0, 12000);
      }
      if (body.timeoutMin !== undefined) {
        const min = Number(body.timeoutMin);
        if (min === -1) bot.timeoutMin = -1;
        else if (Number.isFinite(min) && min > 0) bot.timeoutMin = Math.min(min, 1440);
        else bot.timeoutMin = 0;
      }
      if (body.alert !== undefined) bot.alert = body.alert || null;
      if (body.source !== undefined) bot.source = String(body.source);
      if (body.billing !== undefined) bot.billing = String(body.billing);
      if (body.memory !== undefined) {
        bot.memory = String(body.memory);
        writeMemory(bot.id, bot.memory);
      }
      if (body.quota !== undefined) bot.quota = String(body.quota).trim();
      normalizeSource(bot);
      applyDerivedSource(bot);
      saveState(state);
      emit('bots', { bots: state.bots.map(publicBot) });
      return json(res, 200, bot);
    }
    if (req.method === 'DELETE') {
      addTombstone({
        type: 'bot',
        id: bot.id,
        name: bot.name,
        emoji: bot.emoji,
        backend: bot.backend,
        model: bot.model,
        source: bot.source,
        billing: bot.billing,
        quota: quotaLabel(bot),
      });
      state.bots = state.bots.filter((b) => b.id !== bot.id);
      delete state.providerKeys?.[`botapi:${bot.id}`];
      if (state.settings?.leaderId === bot.id) state.settings.leaderId = null;
      for (const c of state.chats) {
        c.botIds = c.botIds.filter((id) => id !== bot.id);
        if (c.leadId === bot.id) c.leadId = c.botIds[0] || null;
        if (c.loopTargetId === bot.id) c.loopTargetId = c.botIds[0] || null;
        if (!c.botIds.length) {
          c.loop = false;
          c.loopTargetId = null;
        }
      }
      const dead = state.chats.filter((c) => c.type === 'dm' && c.botIds.length === 0);
      for (const c of dead) {
        addTombstone({
          type: 'chat',
          id: c.id,
          title: c.title,
          chatType: c.type,
          project: c.project || '',
        });
        delete state.messages[c.id];
      }
      state.chats = state.chats.filter((c) => !dead.includes(c));
      const deadIds = new Set(dead.map((c) => c.id));
      state.schedules = (state.schedules || []).filter((sch) => !deadIds.has(sch.chatId));
      saveState(state);
      emit('bots', { bots: state.bots.map(publicBot) });
      emit('chats', { chats: state.chats });
      emit('settings', { settings: settingsPublic() });
      return json(res, 200, { ok: true });
    }
  }

  const memMatch = p.match(/^\/api\/bots\/([^/]+)\/memory$/);
  if (memMatch && req.method === 'GET') {
    return json(res, 200, { memory: readMemory(memMatch[1]) });
  }

  const usageMatch = p.match(/^\/api\/bots\/([^/]+)\/usage$/);
  if (usageMatch && req.method === 'DELETE') {
    const bot = state.bots.find((b) => b.id === usageMatch[1]);
    if (!bot) return json(res, 404, { error: 'bot not found' });
    bot.usage = emptyUsage();
    saveState(state);
    emit('bots', { bots: state.bots.map(publicBot) });
    return json(res, 200, { ok: true, usage: bot.usage });
  }

  if (p === '/api/health' && req.method === 'GET') {
    const pick = (cmd) => {
      const full = resolveCmd(cmd);
      return full === cmd ? '' : full;
    };
    return json(res, 200, {
      cli: {
        opencode: pick('opencode'),
        codex: pick('codex'),
        agy: pick('agy'),
        codebuddy: pick('codebuddy'),
        qoder: pick('qoderclicn'),
        claude: pick('claude'),
      },
      dataDir: DATA_DIR,
      workdir: BOTS_DIR,
      desktop: !!process.env.BOT_TEAM_HOME,
    });
  }

  if (p === '/api/browser/result' && req.method === 'POST') {
    const body = await readBody(req);
    if (pendingBrowser && body.id === pendingBrowser.id) pendingBrowser.resolve(body);
    return json(res, 200, { ok: true });
  }

  if (p.startsWith('/api/')) return json(res, 404, { error: 'not found' });

  serveStatic(req, res, p);
});

export async function startServer({ port = PORT, host = process.env.BOT_TEAM_HOST || '0.0.0.0' } = {}) {
  // 先按设置 / 环境变量 / 系统代理配置出口；系统代理会先做 500ms 连通性检查
  await setupProxy(state.settings?.proxy || '').catch(() => '');
  // 上一轮进程被强杀/崩溃时留下的 CLI 孤儿，先回收，避免白占额度和管道。
  try {
    const reaped = reapOrphanChildren();
    if (reaped) console.log(`  已清理 ${reaped} 个上次遗留的 CLI 进程`);
  } catch {}
  // 旧版本建的多账号 profile 缺 Library/Keychains，启动时补上，避免 agy 弹「找不到钥匙串」
  try {
    for (const profile of state.agyProfiles || []) ensureAgyHome(profile?.home);
  } catch {}
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const actual = server.address().port;
      serverPort = actual;
      process.env.BOT_TEAM_URL = `http://127.0.0.1:${actual}`;
      // 上次退出时还标着「运行中」的流程，其实已经没有实例了，标成「已中断」让它能续跑
      let healed = false;
      const interrupted = [];
      for (const chat of state.chats) {
        const wf = chat.workflow;
        if (wf && ['running', 'draining'].includes(wf.status) && !workflowRuns.has(chat.id)) {
          wf.status = 'paused';
          wf.drain = null;
          wf.pausedByUser = false;
          healed = true;
          interrupted.push(chat);
        }
      }
      if (healed) saveState(state);
      if (interrupted.length) {
        setTimeout(() => {
          for (const c of interrupted) {
            void notifyLeaderWorkflowStop(c, c.workflow, 'interrupted', null);
          }
        }, 4000);
      }
      for (const chat of state.chats) if (chat.loop) scheduleLoop(chat, 5000);
      startScheduleTicker();
      refreshTailscale().catch(() => {});
      if (state.settings.remoteAuto) {
        setTimeout(() => {
          startTunnel().catch(() => {});
        }, 1500);
      }
      resolve({ port: actual, url: `http://${host}:${actual}` });
    });
  });
}

export function stopServer() {
  stopTunnel();
  return new Promise((resolve) => server.close(() => resolve()));
}

initPricing().catch(() => {});

const isEntry = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntry) {
  startServer().then(({ port }) => {
    console.log(`\n  Bot Team  →  http://127.0.0.1:${port}\n`);
    console.log(`  数据目录  →  ${DATA_DIR}`);
    console.log(`  工作区    →  ${BOTS_DIR}\n`);
  });
}
