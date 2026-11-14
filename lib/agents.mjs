import { execFile, execFileSync } from 'node:child_process';
import crossSpawn from 'cross-spawn';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getActiveEditor, requestEditorOp } from './editor-bridge.mjs';
import { isWin, which, pythonCommand, killProcessTree } from './platform.mjs';

// 0 = 不设上限：由用户 / 停止按钮控制，避免长任务被固定时间掐断
const DEFAULT_TIMEOUT = 0;

/* ---------------- CLI 定位 ---------------- */

const cmdCache = new Map();

function findWinOpenCodeDesktopCli() {
  if (!isWin) return '';
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const cliRoot = path.join(appData, 'ai.opencode.desktop', 'cli');
  try {
    const entries = fs.readdirSync(cliRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        const exe = path.join(cliRoot, d.name, 'opencode-cli.exe');
        try {
          const st = fs.statSync(exe);
          return st.isFile() ? { exe, mtimeMs: st.mtimeMs } : null;
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    return entries[0]?.exe || '';
  } catch {
    return '';
  }
}

export function resolveCmd(cmd) {
  if (!cmd) return '';
  if (cmd.includes('/') || cmd.includes('\\')) return cmd;
  if (cmdCache.has(cmd)) return cmdCache.get(cmd);
  // Windows 上若已安装 OpenCode Desktop，优先使用其自带的 opencode-cli.exe，
  // 避免 npm 全局旧版 opencode-ai (v1.x) 读取 v2.x opencode.db 时报 "no session table"。
  if (isWin && cmd === 'opencode') {
    const desktopCli = findWinOpenCodeDesktopCli();
    if (desktopCli) {
      cmdCache.set(cmd, desktopCli);
      return desktopCli;
    }
  }
  const found = which(cmd);
  if (found) {
    cmdCache.set(cmd, found);
    return found;
  }
  return cmd;
}

// 从 Electron / OpenCode 桌面端 / 各种 IDE 里启动时，环境里会带着 OPENCODE_*、
// ELECTRON_* 这类标记，直接透传给 CLI 会让它去连错会话甚至卡住。子进程一律用干净环境。
export function childEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(OPENCODE|ELECTRON|CHROME_|VITE_|CODEX|CLAUDE|CURSOR|__CFBundle)/.test(k)) continue;
    if (k === 'NODE_OPTIONS' || k === 'NODE_PATH') continue;
    env[k] = v;
  }
  env.NO_COLOR = '1';
  env.CI = '1';
  return env;
}

const activeChildren = new Set();

/* ---------------- 子进程台账 ----------------
   Bot Team 退出（或崩溃、被强杀）时，正在跑的 CLI 会变成 ppid=1 的孤儿进程，
   一直占着管道和额度。这里把 pid 落盘，下次启动先清理上一轮遗留的孤儿。 */

function childRegistryFile() {
  const home = process.env.BOT_TEAM_HOME || path.resolve(import.meta.dirname, '..');
  return path.join(home, 'data', 'cli-children.json');
}

let childPids = null;

function loadChildPids() {
  if (childPids) return childPids;
  childPids = {};
  try {
    const raw = JSON.parse(fs.readFileSync(childRegistryFile(), 'utf8'));
    if (raw && typeof raw === 'object') childPids = raw;
  } catch {}
  return childPids;
}

function saveChildPids() {
  try {
    const file = childRegistryFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(loadChildPids()));
  } catch {}
}

function trackChild(child, bin) {
  if (!child || !child.pid) return;
  loadChildPids()[child.pid] = { bin: String(bin || ''), at: Date.now() };
  saveChildPids();
}

function untrackChild(child) {
  if (!child || !child.pid) return;
  const pids = loadChildPids();
  if (pids[child.pid]) {
    delete pids[child.pid];
    saveChildPids();
  }
}

/**
 * 清理上一轮进程退出后遗留的 CLI 子进程。
 * 只杀同时满足「ppid=1（已无父进程）」「命令行里还能看到当初的可执行文件」的进程，
 * 避免 pid 被系统复用后误杀别人的进程。
 */
export function reapOrphanChildren() {
  if (isWin) {
    childPids = {};
    saveChildPids();
    return 0;
  }
  const pids = loadChildPids();
  let killed = 0;
  for (const [key, info] of Object.entries(pids)) {
    const pid = Number(key);
    if (!pid) continue;
    try {
      const line = execFileSync('/bin/ps', ['-o', 'ppid=,command=', '-p', String(pid)], {
        encoding: 'utf8',
        timeout: 3000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (!line) continue;
      const ppid = Number(line.trim().split(/\s+/)[0]);
      if (ppid !== 1) continue;
      const bin = String(info?.bin || '');
      // 命令行必须是「以这个可执行文件开头」或「作为一个完整路径出现在中间」，
      // 不能只按 basename 模糊匹配，否则别的进程可能被误杀。
      const cmd = line.trim().replace(/^\d+\s+/, '');
      const matches = bin
        ? cmd === bin || cmd.startsWith(`${bin} `) || cmd.includes(` ${bin} `) || cmd.endsWith(` ${bin}`)
        : false;
      if (!matches) continue;
      process.kill(pid, 'SIGKILL');
      killed += 1;
    } catch {}
  }
  childPids = {};
  saveChildPids();
  return killed;
}

export function killActiveChildren() {
  for (const child of activeChildren) {
    killProcessTree(child, 'SIGKILL');
    untrackChild(child);
  }
  activeChildren.clear();
}


function exec(cmd, args, { cwd, timeoutMs = DEFAULT_TIMEOUT, env: extraEnv, onLine, signal, maxOut = 0 } = {}) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let lineBuf = '';
    let timedOut = false;
    let aborted = false;
    let child;
    const startedAt = Date.now();
    try {
      child = crossSpawn(resolveCmd(cmd), args, {
        cwd,
        env: { ...childEnv(), ...(extraEnv || {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (e) {
      resolve({ code: -1, out, err: String(e?.message || e), timedOut, durationMs: 0 });
      return;
    }
    activeChildren.add(child);
    trackChild(child, resolveCmd(cmd));
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            killProcessTree(child, 'SIGKILL');
            err += `\n[timeout after ${timeoutMs}ms]`;
          }, timeoutMs)
        : null;
    const onAbort = () => {
      aborted = true;
      killProcessTree(child, 'SIGKILL');
      err += '\n[stopped by user]';
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }
    child.stdout.on('data', (d) => {
      const s = d.toString();
      out += s;
      if (maxOut && out.length > maxOut) {
        out = `${out.slice(0, maxOut)}\n[output truncated]`;
        killProcessTree(child, 'SIGKILL');
      }
      if (!onLine) return;
      lineBuf += s;
      let idx;
      while ((idx = lineBuf.indexOf('\n')) >= 0) {
        const line = lineBuf.slice(0, idx).trim();
        lineBuf = lineBuf.slice(idx + 1);
        if (line) {
          try {
            onLine(line);
          } catch {}
        }
      }
    });
    child.stderr.on('data', (d) => {
      err += d.toString();
      if (err.length > 512000) err = `${err.slice(0, 512000)}\n[stderr truncated]`;
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      activeChildren.delete(child);
      untrackChild(child);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve({
        code: -1,
        out,
        err: err + String(e?.message || e),
        timedOut,
        aborted,
        durationMs: Date.now() - startedAt,
      });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      activeChildren.delete(child);
      untrackChild(child);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (onLine && lineBuf.trim()) {
        try {
          onLine(lineBuf.trim());
        } catch {}
      }
      resolve({
        code,
        out,
        err,
        timedOut,
        aborted,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

/** 一轮对话可能包含多个 step，用量需要把每个 step 的 tokens 累加，不能只取最后一个 */
function mergeStepTokens(acc, t) {
  const base = acc || {
    total: 0,
    input: 0,
    output: 0,
    reasoning: 0,
    cache: { read: 0, write: 0 },
  };
  return {
    total: (base.total || 0) + (t.total || 0),
    input: (base.input || 0) + (t.input || 0),
    output: (base.output || 0) + (t.output || 0),
    reasoning: (base.reasoning || 0) + (t.reasoning || 0),
    cache: {
      read: (base.cache?.read || 0) + (t.cache?.read || 0),
      write: (base.cache?.write || 0) + (t.cache?.write || 0),
    },
  };
}

function jsonLines(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      rows.push(JSON.parse(t));
    } catch {}
  }
  return rows;
}

/* ---------------- 推理强度 ---------------- */

// 统一成 low / medium / high / xhigh，再按后端翻译
const EFFORT_MAP = {
  low: { opencode: 'low', codex: 'low', agy: 'low' },
  medium: { opencode: 'medium', codex: 'medium', agy: 'medium' },
  high: { opencode: 'high', codex: 'high', agy: 'high' },
  xhigh: { opencode: 'max', codex: 'xhigh', agy: 'xhigh' },
};

function effortFor(backend, effort) {
  if (!effort || effort === 'auto') return '';
  return EFFORT_MAP[effort]?.[backend] || '';
}

/* ---------------- permissions ---------------- */

function expandDir(d) {
  const s = String(d || '').trim();
  if (s === '~') return os.homedir();
  if (s.startsWith('~/')) return path.join(os.homedir(), s.slice(2));
  return s;
}

function dirPattern(d) {
  const s = expandDir(d).replace(/\/+$/, '');
  if (!s) return '';
  return /[*?]/.test(s) ? s : `${s}/**`;
}

function permissionDirs(perm, kind) {
  const list = Array.isArray(perm?.[kind]) ? perm[kind] : [];
  return [...new Set(list.map(expandDir).filter(Boolean))];
}

function opencodePermissionEnv(perm) {
  if (!perm || perm.mode === 'workspace') return {};
  if (perm.mode === 'full') {
    return {
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        permission: { external_directory: 'allow', edit: 'allow', bash: 'allow', webfetch: 'allow' },
      }),
    };
  }
  const external = {};
  const edit = {};
  for (const d of [...permissionDirs(perm, 'write'), ...permissionDirs(perm, 'read')]) {
    const p = dirPattern(d);
    if (p) external[p] = 'allow';
  }
  for (const d of permissionDirs(perm, 'read')) {
    const p = dirPattern(d);
    if (p) edit[p] = 'deny';
  }
  return {
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      permission: { external_directory: external, edit },
    }),
  };
}

function codexPermissionArgs(perm) {
  if (!perm || perm.mode === 'workspace') return [];
  if (perm.mode === 'full') {
    return ['--dangerously-bypass-approvals-and-sandbox'];
  }
  const dirs = permissionDirs(perm, 'write');
  if (!dirs.length) return [];
  return [
    '-c',
    'sandbox_mode="workspace-write"',
    '-c',
    `sandbox_workspace_write.writable_roots=${JSON.stringify(dirs)}`,
  ];
}

function agyPermissionArgs(perm) {
  if (!perm || perm.mode === 'workspace') return [];
  const dirs = [...permissionDirs(perm, 'write'), ...permissionDirs(perm, 'read')];
  const args = [];
  for (const d of [...new Set(dirs)]) args.push('--add-dir', d);
  if (perm.mode === 'full') args.push('--dangerously-skip-permissions');
  else if (permissionDirs(perm, 'write').length) args.push('--mode', 'accept-edits');
  return args;
}

/* ---------------- opencode ---------------- */

let opencodeHasDirFlag = null;
function supportsOpencodeDirFlag() {
  if (opencodeHasDirFlag !== null) return opencodeHasDirFlag;
  try {
    const bin = resolveCmd('opencode');
    const help = execFileSync(bin, ['run', '--help'], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    opencodeHasDirFlag = /(^|\s)--dir(\s|,|=|$)/m.test(help);
  } catch {
    opencodeHasDirFlag = false;
  }
  return opencodeHasDirFlag;
}

async function runOpencode({ bot, prompt, sessionId, cwd, effort, permission, attachments = [], onProgress, signal, timeoutMs }) {
  const args = ['run', '--format', 'json'];
  if (supportsOpencodeDirFlag()) args.push('--dir', cwd);
  if (bot.model) args.push('-m', bot.model);
  if (sessionId) args.push('-s', sessionId);
  const eff = effortFor('opencode', effort);
  if (eff) args.push('--variant', eff);
  if (permission?.mode === 'full') args.push('--auto');
  args.push(prompt);
  for (const a of attachments) args.push('-f', a.path);

  const steps = [];
  let streamedThinking = '';
  const onLine = (line) => {
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      return;
    }
    if ((r.type === 'reasoning' || r.part?.type === 'reasoning') && r.part?.text) {
      streamedThinking += (streamedThinking ? '\n' : '') + r.part.text;
      onProgress?.({ type: 'thinking', text: r.part.text });
    }
    if (r.type === 'tool_use' && r.part?.tool) {
      const input = r.part.state?.input || {};
      const title =
        r.part.title ||
        input.filePath ||
        input.path ||
        input.command ||
        input.pattern ||
        '';
      const step = { tool: r.part.tool, title: String(title).slice(0, 300) };
      steps.push(step);
      onProgress?.({ type: 'step', ...step });
    }
  };

  const { code, out, err, timedOut, durationMs } = await exec('opencode', args, {
    signal,
    cwd,
    env: opencodePermissionEnv(permission),
    onLine,
    timeoutMs,
  });
  const rows = jsonLines(out);
  let text = '';
  let reasoning = streamedThinking;
  let sid = sessionId || null;
  let usage = null;
  const parsedSteps = [];
  for (const r of rows) {
    if (r.sessionID) sid = r.sessionID;
    if (r.type === 'text' && r.part?.text) {
      text += (text ? '\n' : '') + r.part.text;
    }
    if ((r.type === 'reasoning' || r.part?.type === 'reasoning') && r.part?.text) {
      if (!streamedThinking) reasoning += (reasoning ? '\n' : '') + r.part.text;
    }
    if (r.type === 'tool_use' && r.part?.tool) {
      const input = r.part.state?.input || {};
      const title =
        r.part.title ||
        input.filePath ||
        input.path ||
        input.command ||
        input.pattern ||
        '';
      parsedSteps.push({ tool: r.part.tool, title: String(title).slice(0, 300) });
    }
    if (r.type === 'step_finish' && r.part?.tokens) {
      usage = mergeStepTokens(usage, r.part.tokens);
    }
  }
  return {
    text: text.trim(),
    reasoning: reasoning.trim(),
    sessionId: sid,
    usage,
    steps: steps.length ? steps : parsedSteps,
    streamedSteps: steps.length > 0,
    streamedThinking: !!streamedThinking,
    timedOut,
    durationMs,
    code,
    err,
  };
}

/* ---------------- codex ---------------- */

async function runCodex({ bot, prompt, sessionId, cwd, effort, permission, attachments = [], onProgress, signal, timeoutMs, apiKey }) {
  const args = ['exec'];
  if (sessionId) args.push('resume', sessionId);
  args.push('--json', '--skip-git-repo-check');
  if (bot.codexFast !== false) args.push('--ignore-user-config');
  if (bot.model) args.push('-m', bot.model);
  const customApi = bot.api?.mode === 'custom' && String(bot.api?.baseUrl || '').trim();
  if (customApi) {
    args.push(
      '-c',
      'model_provider="bt-custom"',
      '-c',
      'model_providers.bt-custom.name="Bot Team 自定义 API"',
      '-c',
      `model_providers.bt-custom.base_url=${JSON.stringify(String(bot.api.baseUrl).trim())}`,
      '-c',
      'model_providers.bt-custom.env_key="BT_CUSTOM_API_KEY"',
      '-c',
      'model_providers.bt-custom.wire_api="responses"'
    );
  }
  const eff = effortFor('codex', effort);
  if (eff) args.push('-c', `model_reasoning_effort=${eff}`);
  args.push('-c', 'model_auto_compact_token_limit=120000');
  args.push(...codexPermissionArgs(permission));
  // codex 的 -i/--image 是「多值」参数，会把后面的 prompt 一起吞掉（prompt 变成从 stdin 读，
  // 界面就报 No prompt provided via stdin）。所以图片用 --image=<路径> 的等号写法，且必须放在 prompt 之前。
  for (const a of attachments) {
    if (/^image\//i.test(a.mime || '') || /\.(png|jpe?g|webp|gif|avif)$/i.test(a.name || '')) {
      args.push(`--image=${a.path}`);
    }
  }
  args.push(prompt);

  const steps = [];
  let streamedThinking = false;
  const onLine = (line) => {
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      return;
    }
    if (r.type === 'item.completed' && r.item?.type === 'reasoning') {
      streamedThinking = true;
      const parts = [];
      for (const s of r.item.summary || []) if (s?.text) parts.push(s.text);
      for (const s of r.item.content || []) if (s?.text) parts.push(s.text);
      if (r.item.text) parts.push(r.item.text);
      if (parts.length) onProgress?.({ type: 'thinking', text: parts.join('\n') });
    }
    if (
      r.type === 'item.completed' &&
      r.item?.type &&
      !['agent_message', 'reasoning', 'error', 'todo_list'].includes(r.item.type)
    ) {
      const title =
        r.item.command ||
        r.item.path ||
        r.item.tool ||
        r.item.text ||
        r.item.name ||
        '';
      const step = { tool: r.item.type, title: String(title).slice(0, 300) };
      steps.push(step);
      onProgress?.({ type: 'step', ...step });
    }
  };

  const env = customApi && apiKey ? { BT_CUSTOM_API_KEY: apiKey } : undefined;
  const { code, out, err, timedOut, durationMs } = await exec('codex', args, {
    cwd,
    onLine,
    signal,
    env,
    timeoutMs,
  });
  const rows = jsonLines(out);
  let text = '';
  let reasoning = '';
  let sid = sessionId || null;
  let usage = null;
  let errText = '';
  const parsedSteps = [];
  for (const r of rows) {
    if (r.type === 'thread.started' && r.thread_id) sid = r.thread_id;
    if (r.type === 'item.completed' && r.item?.type === 'agent_message' && r.item.text) {
      text += (text ? '\n' : '') + r.item.text;
    }
    if (r.type === 'item.completed' && r.item?.type === 'reasoning') {
      const parts = [];
      for (const s of r.item.summary || []) if (s?.text) parts.push(s.text);
      for (const s of r.item.content || []) if (s?.text) parts.push(s.text);
      if (r.item.text) parts.push(r.item.text);
      if (parts.length) reasoning += (reasoning ? '\n' : '') + parts.join('\n');
    }
    if (
      r.type === 'item.completed' &&
      r.item?.type &&
      !['agent_message', 'reasoning', 'error', 'todo_list'].includes(r.item.type)
    ) {
      const title =
        r.item.command ||
        r.item.path ||
        r.item.tool ||
        r.item.text ||
        r.item.name ||
        '';
      parsedSteps.push({ tool: r.item.type, title: String(title).slice(0, 300) });
    }
    if (r.type === 'turn.completed' && r.usage) usage = r.usage;
    if (r.type === 'error' && r.message) errText = r.message;
    if (r.type === 'turn.failed' && r.error?.message) errText = r.error.message;
  }
  return {
    text: text.trim(),
    reasoning: reasoning.trim(),
    sessionId: sid,
    usage,
    steps: steps.length ? steps : parsedSteps,
    streamedSteps: steps.length > 0,
    streamedThinking,
    timedOut,
    durationMs,
    code,
    err: [err, errText].filter(Boolean).join('\n'),
  };
}

/* ---------------- antigravity (agy) ---------------- */

// 多账号 profile 换 HOME 后，agy 找不到 ~/Library/Keychains，会弹
// 「找不到用于储存 antigravity 的钥匙串」。启动前把 Keychains 链接补上。
export function ensureAgyHome(home) {
  if (!home) return '';
  const target = path.resolve(String(home));
  if (isWin) return target;
  const real = os.homedir();
  if (target === path.resolve(real)) return target;
  try {
    const lib = path.join(target, 'Library');
    fs.mkdirSync(lib, { recursive: true });
    const link = path.join(lib, 'Keychains');
    if (!fs.existsSync(link)) {
      fs.symlinkSync(path.join(real, 'Library', 'Keychains'), link, 'dir');
    }
  } catch {}
  return target;
}

async function runAgy({ bot, prompt, sessionId, cwd, effort, permission, onProgress, agyHome = '', signal, timeoutMs }) {
  if (agyHome) ensureAgyHome(agyHome);
  const args = ['-p', prompt, '--output-format', 'stream-json', '--add-dir', cwd];
  if (sessionId) args.push('--conversation', sessionId);
  if (bot.model) args.push('--model', bot.model);
  // 模型名本身带 -low/-medium/-high 时不能再传 --effort，否则 agy 直接报冲突
  const modelHasEffort = /-(low|medium|high|xhigh|max)$/i.test(String(bot.model || ''));
  const eff = effortFor('agy', effort);
  if (eff && !modelHasEffort) args.push('--effort', eff);
  if (timeoutMs > 0) args.push('--print-timeout', `${Math.max(1, Math.round(timeoutMs / 1000))}s`);
  args.push(...agyPermissionArgs(permission));

  let text = '';
  let reasoning = '';
  let sid = sessionId || null;
  let usage = null;
  let result = null;
  const steps = [];

  const onLine = (line) => {
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      return;
    }
    if (r.event === 'init' && r.conversation_id) sid = r.conversation_id;
    if (r.event === 'step_update') {
      const step = r.step_update || {};
      if (step.conversation_id) sid = step.conversation_id;
      if (step.state === 'ACTIVE' && step.step_type === 'agent_response' && step.text_delta) {
        text += step.text_delta;
        onProgress?.({ type: 'text', text: step.text_delta });
      }
      if (
        step.state === 'DONE' &&
        step.step_type &&
        !['user_input', 'agent_response'].includes(step.step_type)
      ) {
        const title =
          step.tool_name ||
          step.command ||
          step.file_path ||
          step.query ||
          step.title ||
          step.step_type;
        const one = { tool: step.step_type, title: String(title).slice(0, 300) };
        if (!steps.some((x) => x.tool === one.tool && x.title === one.title)) {
          steps.push(one);
          onProgress?.({ type: 'step', ...one });
        }
      }
      if (step.usage) usage = step.usage;
    }
    if (r.event === 'result' && r.result) {
      result = r.result;
      if (r.result.conversation_id) sid = r.result.conversation_id;
      if (r.result.reasoning || r.result.thinking || r.result.thought) {
        reasoning = String(r.result.reasoning || r.result.thinking || r.result.thought);
      }
      if (r.result.usage) usage = r.result.usage;
    }
  };

  const { code, out, err, timedOut, durationMs } = await exec('agy', args, {
    cwd,
    signal,
    env: agyHome ? { HOME: agyHome } : {},
    timeoutMs,
    onLine,
  });

  // 兜底：如果流式事件没解析到正文，按最终 result / 原始输出兜底
  let finalText = String(result?.response || text || '').trim();
  if (!finalText) {
    const rows = jsonLines(out);
    for (const r of rows) {
      if (r.event === 'result' && r.result?.response) finalText = String(r.result.response).trim();
    }
  }
  // 进程被中断时 out 里可能只有 NDJSON 事件，绝不能把它当回复贴给老板
  if (!finalText) {
    const raw = String(out || '').trim();
    const looksJson = raw.startsWith('{') && /"event"\s*:/.test(raw.slice(0, 300));
    if (raw && !looksJson) finalText = raw;
  }
  if (/^\{"event"\s*:/.test(finalText)) finalText = '';
  return {
    text: finalText,
    reasoning: reasoning.trim(),
    sessionId: sid,
    usage,
    steps,
    streamedSteps: steps.length > 0,
    streamedThinking: false,
    timedOut,
    durationMs,
    code,
    err,
  };
}

/* ---------------- WorkBuddy / CodeBuddy ---------------- */

function parseCodebuddy(out) {
  try {
    const parsed = JSON.parse(out);
    if (Array.isArray(parsed)) return parsed;
  } catch {}
  return jsonLines(out);
}

async function runCodebuddy({ bot, prompt, sessionId, cwd, effort, permission, attachments = [], signal, timeoutMs }) {
  const args = ['-p', '--output-format', 'json'];
  if (bot.model) args.push('--model', bot.model);
  if (sessionId) args.push('-r', sessionId);
  if (permission?.mode === 'full') args.push('--permission-mode', 'bypassPermissions');
  else args.push('--permission-mode', 'acceptEdits');
  for (const a of attachments) args.push('--attachment', a.path);
  args.push(prompt);
  if (permission?.mode === 'custom') {
    for (const d of [...permissionDirs(permission, 'write'), ...permissionDirs(permission, 'read')]) {
      args.push('--add-dir', d);
    }
  }

  const { code, out, err, timedOut, durationMs } = await exec('codebuddy', args, { cwd, signal, timeoutMs });
  const rows = parseCodebuddy(out);
  const result = [...rows].reverse().find((r) => r.type === 'result' || r.subtype === 'success');
  let text = String(result?.result || '').trim();
  let reasoning = '';
  let sid = result?.session_id || result?.sessionId || sessionId || null;
  let usage = result?.usage || null;
  const numTurns = Number(result?.num_turns) || 0;
  for (const r of rows) {
    if (r.type === 'message' && Array.isArray(r.content)) {
      for (const c of r.content) {
        if (/thinking|reasoning/i.test(c.type || '') && c.text) {
          reasoning += (reasoning ? '\n' : '') + c.text;
        }
        if (!text && c.type === 'output_text' && c.text) text += c.text;
      }
      if (r.sessionId) sid = r.sessionId;
    }
  }
  return { text, reasoning, sessionId: sid, usage, numTurns, steps: [], timedOut, durationMs, code, err };
}

/* ---------------- Qoder CN ---------------- */
function parseQoder(out) {
  try {
    const parsed = JSON.parse(out);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {}
  const rows = jsonLines(out);
  return rows[rows.length - 1] || {};
}

async function runQoder({ bot, prompt, sessionId, cwd, effort, permission, attachments = [], signal, timeoutMs }) {
  const args = ['-p', '--output-format', 'json'];
  if (bot.model) args.push('-m', bot.model);
  if (sessionId) args.push('-r', sessionId);
  if (effort && effort !== 'auto') args.push('--reasoning-effort', effort);
  if (permission?.mode === 'full') args.push('--dangerously-skip-permissions');
  else {
    args.push('--permission-mode', 'accept_edits');
    if (permission?.mode === 'custom') {
      for (const d of [...permissionDirs(permission, 'write'), ...permissionDirs(permission, 'read')]) {
        args.push('--add-dir', d);
      }
    }
  }
  for (const a of attachments) args.push('--attachment', a.path);
  args.push(prompt);

  const { code, out, err, timedOut, durationMs } = await exec('qoderclicn', args, { cwd, signal, timeoutMs });
  const result = parseQoder(out);
  const text = String(result.result || result.response || result.text || '').trim();
  const reasoning = String(result.reasoning || result.thinking || '').trim();
  const sid = result.session_id || result.sessionId || sessionId || null;
  const usage = result.usage || null;
  // Qoder CLI 直接给出本轮消耗的 Credits（modelUsage 里按模型拆分）
  let credits = Number(result.total_credits);
  if (!Number.isFinite(credits) || credits <= 0) {
    credits = 0;
    for (const m of Object.values(result.modelUsage || {})) {
      credits += Number(m?.credits) || 0;
    }
  }
  return { text, reasoning, sessionId: sid, usage, credits, steps: [], timedOut, durationMs, code, err };
}

/* ---------------- Claude Code ---------------- */

function joinApiUrl(base, suffix) {
  let b = String(base || '').trim().replace(/\/+$/, '');
  if (!b) return '';
  if (b.endsWith(suffix)) return b;
  if (suffix.startsWith('/v1/') && /\/v1$/i.test(b)) return b + suffix.slice(3);
  return b + suffix;
}

function claudePermissionArgs(perm) {
  if (perm?.mode === 'full') return ['--dangerously-skip-permissions'];
  return ['--permission-mode', 'acceptEdits'];
}

async function runClaude({ bot, prompt, sessionId, cwd, permission, signal, timeoutMs, apiKey, onProgress }) {
  const args = ['-p', '--output-format', 'stream-json', '--include-partial-messages', '--verbose'];
  if (sessionId) args.push('--resume', sessionId);
  if (bot.model) args.push('--model', bot.model);
  args.push(...claudePermissionArgs(permission));
  args.push(prompt);

  const env = {};
  if (bot.api?.mode === 'custom') {
    const key = apiKey || bot.apiKey || '';
    if (bot.api.baseUrl) env.ANTHROPIC_BASE_URL = String(bot.api.baseUrl).trim();
    if (key) {
      env.ANTHROPIC_AUTH_TOKEN = key;
      env.ANTHROPIC_API_KEY = key;
    }
    if (bot.model) {
      env.ANTHROPIC_MODEL = bot.model;
      env.ANTHROPIC_DEFAULT_SONNET_MODEL = bot.model;
      env.ANTHROPIC_DEFAULT_OPUS_MODEL = bot.model;
      env.ANTHROPIC_DEFAULT_HAIKU_MODEL = bot.model;
    }
  }

  let liveText = '';
  let liveThinking = '';
  const onLine = (line) => {
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      return;
    }
    if (r.type === 'stream_event') {
      const ev = r.event || {};
      if (ev.type === 'content_block_delta') {
        const d = ev.delta || {};
        if (d.type === 'thinking_delta' && d.thinking) {
          liveThinking += d.thinking;
          onProgress?.({ type: 'thinking', text: d.thinking });
        }
        if (d.type === 'text_delta' && d.text) {
          liveText += d.text;
          onProgress?.({ type: 'text', text: d.text });
        }
      }
    }
    if (r.type === 'assistant' && r.message?.content) {
      for (const block of r.message.content) {
        if (block?.type === 'thinking' && block.thinking) liveThinking += block.thinking;
        if (block?.type === 'text' && block.text) liveText += block.text;
      }
    }
  };

  const startedAt = Date.now();
  const { code, out, err, timedOut } = await exec('claude', args, {
    cwd,
    env,
    signal,
    timeoutMs,
    onLine,
  });
  const rows = jsonLines(out);
  const result = [...rows].reverse().find((r) => r?.type === 'result') || rows[rows.length - 1] || {};
  const text = String(result.result || liveText || '').trim();
  const reasoning = liveThinking.trim();
  return {
    text,
    reasoning,
    sessionId: result.session_id || sessionId || null,
    usage: result.usage || null,
    steps: [],
    streamedThinking: !!reasoning,
    timedOut,
    durationMs: Date.now() - startedAt,
    code,
    err: err || (rows.length ? '' : String(out || '').slice(-1500)),
  };
}

/* ---------------- 自定义 API（无需任何 CLI） ---------------- */

function readOpenAIText(message) {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .map((p) => (typeof p === 'string' ? p : p?.text || p?.content || ''))
      .join('');
  }
  return '';
}

// 提示词里的稳定段/易变段分隔符，和 orchestrator.mjs 的 CTX_MARK 保持一致。
const CTX_MARK = '【本轮上下文】';

function splitStablePrompt(prompt) {
  const idx = String(prompt || '').indexOf(CTX_MARK);
  if (idx < 0) return null;
  const head = prompt.slice(0, idx + CTX_MARK.length).trim();
  const tail = prompt.slice(idx + CTX_MARK.length).trim();
  if (!head || !tail) return null;
  return { head, tail };
}

/* ---------------- 自定义 API 的本机工具 ---------------- */

function pdfToolScriptPath() {
  const src = path.join(import.meta.dirname, 'pdf_edit.py');
  const base = process.env.BOT_TEAM_HOME
    ? path.join(process.env.BOT_TEAM_HOME, 'data')
    : path.join(os.tmpdir(), 'bot-team-pdf');
  const dst = path.join(base, 'pdf_edit.py');
  try {
    fs.mkdirSync(base, { recursive: true });
    const needCopy =
      !fs.existsSync(dst) ||
      fs.statSync(dst).size !== fs.statSync(src).size;
    if (needCopy) fs.copyFileSync(src, dst);
    return dst;
  } catch {
    return src;
  }
}

function runPdfTool(action, target, payload = {}) {
  return new Promise((resolve, reject) => {
    const tmp = path.join(
      os.tmpdir(),
      `bt-pdf-tool-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
    );
    try {
      fs.writeFileSync(tmp, JSON.stringify(payload || {}), 'utf8');
    } catch (e) {
      reject(e);
      return;
    }
    const py = pythonCommand();
    execFile(
      py.cmd,
      [...py.args, pdfToolScriptPath(), action, target, tmp],
      { timeout: 180000, maxBuffer: 16 * 1024 * 1024, env: childEnv(), windowsHide: true },
      (err, stdout, stderr) => {
        try { fs.rmSync(tmp, { force: true }); } catch {}
        let data = null;
        try {
          data = JSON.parse(String(stdout || '').trim() || '{}');
        } catch {}
        if (data?.error) {
          reject(new Error(String(data.error)));
          return;
        }
        if (err) {
          reject(new Error(String(stderr || err.message || 'PDF 操作失败').slice(0, 400)));
          return;
        }
        resolve(data || {});
      }
    );
  });
}

const CUSTOM_TOOLS = [
  {
    name: 'list_dir',
    description: '列出目录里的文件和文件夹。查看某个目录有什么时使用。',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '目录路径，默认当前工作区' } },
    },
  },
  {
    name: 'read_file',
    description: '读取一个文本文件的内容。适合代码、Markdown、JSON、日志等。',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '文件路径' } },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: '创建或覆盖一个文本文件；会自动创建父目录。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径' },
        content: { type: 'string', description: '要写入的内容' },
        append: { type: 'boolean', description: '为 true 时追加到文件末尾' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'run_command',
    description: '在本机执行一条 shell 命令（zsh），用于跑脚本、构建、查看版本、处理文件等。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的命令' },
        cwd: { type: 'string', description: '工作目录，默认 Bot 工作区' },
        timeout_seconds: { type: 'number', description: '超时秒数，默认 60，最大 300' },
      },
      required: ['command'],
    },
  },
  {
    name: 'find_files',
    description: '按文件名在允许的目录里查找文件，返回匹配路径。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '文件名或其中一部分' },
        root: { type: 'string', description: '从哪个目录开始找，默认工作区' },
      },
      required: ['name'],
    },
  },
  {
    name: 'pdf_read',
    description:
      '读取右侧正在编辑的 PDF 页面文字块和坐标。返回每页 width/height 和 blocks（bbox、text、fontsize、font、color）；修改 PDF 文字前先调用。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'PDF 路径；省略时使用右侧正在编辑的 PDF' },
      },
    },
  },
  {
    name: 'pdf_apply',
    description:
      '直接修改右侧正在编辑的 PDF 并写回原文件。updates 按 bbox 替换文字；replacements 按 find/replace 搜索替换；additions 在指定坐标加文字；highlights 高亮。PDF 文字是绘制出来的，保存后字体/间距可能与原文略有差异。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'PDF 路径；省略时使用右侧正在编辑的 PDF' },
        updates: {
          type: 'array',
          description: '按 bbox 替换文字块',
          items: {
            type: 'object',
            properties: {
              page: { type: 'number' },
              bbox: { type: 'array', items: { type: 'number' } },
              text: { type: 'string' },
              fontsize: { type: 'number' },
              color: { type: 'number' },
              font: { type: 'string' },
            },
            required: ['page', 'bbox', 'text'],
          },
        },
        replacements: {
          type: 'array',
          description: '搜索并替换文字',
          items: {
            type: 'object',
            properties: {
              page: { type: 'number' },
              find: { type: 'string' },
              replace: { type: 'string' },
              all: { type: 'boolean' },
              fontsize: { type: 'number' },
            },
            required: ['page', 'find', 'replace'],
          },
        },
        additions: {
          type: 'array',
          description: '在指定坐标添加文字',
          items: {
            type: 'object',
            properties: {
              page: { type: 'number' },
              x: { type: 'number' },
              y: { type: 'number' },
              text: { type: 'string' },
              size: { type: 'number' },
              width: { type: 'number' },
              height: { type: 'number' },
              color: { type: 'number' },
            },
            required: ['page', 'x', 'y', 'text'],
          },
        },
        highlights: {
          type: 'array',
          description: '按文字搜索并高亮',
          items: {
            type: 'object',
            properties: {
              page: { type: 'number' },
              find: { type: 'string' },
              all: { type: 'boolean' },
            },
            required: ['page', 'find'],
          },
        },
      },
    },
  },
  {
    name: 'editor_read',
    description:
      '读取右侧当前正在编辑的文件内容（编辑器里的实时内容，不是磁盘旧版本）。在修改当前文件前先用它确认 HTML/文字结构。只有右侧文件处于编辑状态时可用。',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'editor_set_cells',
    description:
      '直接修改右侧正在编辑的 Excel/CSV 单元格，改动会立即显示并在后台自动写回原文件。cells 每项格式：{sheet?: string, cell: "A1", value: string}；CSV 可省略 sheet。',
    parameters: {
      type: 'object',
      properties: {
        cells: {
          type: 'array',
          description: '要修改的单元格',
          items: {
            type: 'object',
            properties: {
              sheet: { type: 'string', description: '工作表名；Excel 可用，CSV 省略' },
              cell: { type: 'string', description: '单元格坐标，例如 A1、C7' },
              value: { type: 'string', description: '单元格新内容' },
            },
            required: ['cell', 'value'],
          },
        },
      },
      required: ['cells'],
    },
  },
  {
    name: 'editor_set_paragraphs',
    description:
      '直接修改右侧正在编辑的 PPT 文字段落，改动会立即显示并在后台自动写回原 .pptx。paragraphs 每项：{index: number, text: string}；index 来自 editor_read 返回的段落编号。',
    parameters: {
      type: 'object',
      properties: {
        paragraphs: {
          type: 'array',
          description: '要修改的段落',
          items: {
            type: 'object',
            properties: {
              index: { type: 'number', description: '段落全局索引' },
              text: { type: 'string', description: '新的段落文字' },
            },
            required: ['index', 'text'],
          },
        },
      },
      required: ['paragraphs'],
    },
  },
  {
    name: 'editor_apply',
    description:
      '直接修改右侧当前正在编辑的富文本/文本内容，改动会立刻显示在编辑器里，不需要保存后重新打开。支持 replace_text（按文字替换）、patch（用 CSS 选择器替换某个元素，例如 table、p:nth-of-type(1)）、set_html（整体替换富文本内容）、insert_html。适合 Word/Markdown/纯文本编辑器；Excel/CSV 请用 editor_set_cells，PPT 请用 editor_set_paragraphs。',
    parameters: {
      type: 'object',
      properties: {
        operations: {
          type: 'array',
          description: '按顺序执行的编辑操作',
          items: {
            type: 'object',
            properties: {
              type: {
                type: 'string',
                enum: ['replace_text', 'patch', 'set_html', 'insert_html'],
                description: '操作类型',
              },
              find: { type: 'string', description: 'replace_text 要查找的文字' },
              replace: { type: 'string', description: 'replace_text 替换后的文字' },
              all: { type: 'boolean', description: 'replace_text 是否替换全部匹配' },
              selector: { type: 'string', description: 'patch/insert_html 的 CSS 选择器' },
              html: { type: 'string', description: 'patch/set_html/insert_html 的 HTML' },
              position: {
                type: 'string',
                enum: ['beforebegin', 'afterbegin', 'beforeend', 'afterend'],
                description: 'insert_html 的插入位置',
              },
            },
          },
        },
      },
      required: ['operations'],
    },
  },
];

const CUSTOM_TOOLS_ANTHROPIC = CUSTOM_TOOLS.map((t) => ({
  name: t.name,
  description: t.description,
  input_schema: t.parameters,
}));
const CUSTOM_TOOLS_OPENAI = CUSTOM_TOOLS.map((t) => ({
  type: 'function',
  function: { name: t.name, description: t.description, parameters: t.parameters },
}));

function toolPath(raw, cwd) {
  let value = String(raw || '').trim() || '.';
  if (value === '~') value = os.homedir();
  else if (value.startsWith('~/')) value = path.join(os.homedir(), value.slice(2));
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(cwd, value);
}

function toolAllowedRoots(permission, cwd, write = false) {
  if (permission?.mode === 'full') return null;
  const roots = [path.resolve(cwd)];
  const extra = write
    ? permission?.write || []
    : [...(permission?.read || []), ...(permission?.write || [])];
  for (const item of extra) {
    try {
      roots.push(path.resolve(String(item).replace(/^~\//, `${os.homedir()}/`)));
    } catch {}
  }
  return [...new Set(roots)];
}

function assertToolPath(target, roots) {
  if (!roots) return;
  const resolved = path.resolve(target);
  if (!roots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`))) {
    throw new Error(`没有权限访问这个路径：${resolved}`);
  }
}

function listDirText(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true }).slice(0, 400);
  return entries
    .map((entry) => {
      const full = path.join(dir, entry.name);
      let size = '';
      try {
        if (entry.isFile()) size = `  ${fs.statSync(full).size} B`;
      } catch {}
      return `${entry.isDirectory() ? '📁' : '📄'} ${entry.name}${size}`;
    })
    .join('\n');
}

function findFilesTool(name, root, permission, cwd) {
  const needle = String(name || '').toLowerCase();
  if (!needle) return '';
  const roots = root ? [toolPath(root, cwd)] : toolAllowedRoots(permission, cwd, false) || [cwd];
  const out = [];
  const deadline = Date.now() + 2500;
  let visited = 0;
  const walk = (dir, depth) => {
    if (depth < 0 || out.length >= 60 || Date.now() > deadline || visited > 5000) return;
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
      if (entry.isFile() && entry.name.toLowerCase().includes(needle)) out.push(full);
      if (out.length >= 60) return;
    }
  };
  for (const r of roots) walk(r, 5);
  return out.slice(0, 60).join('\n');
}

async function executeCustomTool(name, args, { permission, cwd, signal }) {
  const a = args && typeof args === 'object' ? args : {};
  if (name === 'pdf_read') {
    const session = getActiveEditor();
    const target = String(a.path || (session?.kind === 'pdf' ? session.filePath : '') || '').trim();
    if (!target) throw new Error('右侧没有正在编辑的 PDF，请先打开 PDF 并点铅笔进入编辑');
    const result = await runPdfTool('read', target, {});
    return JSON.stringify(result);
  }
  if (name === 'pdf_apply') {
    const session = getActiveEditor();
    const target = String(a.path || (session?.kind === 'pdf' ? session.filePath : '') || '').trim();
    if (!target) throw new Error('右侧没有正在编辑的 PDF，请先打开 PDF 并点铅笔进入编辑');
    const result = await runPdfTool('apply', target, {
      updates: Array.isArray(a.updates) ? a.updates : [],
      replacements: Array.isArray(a.replacements) ? a.replacements : [],
      additions: Array.isArray(a.additions) ? a.additions : [],
      highlights: Array.isArray(a.highlights) ? a.highlights : [],
    });
    return JSON.stringify(result);
  }
  if (name === 'editor_read') {
    const session = getActiveEditor();
    if (!session) throw new Error('右侧没有正在编辑的文件，请先打开文件并点铅笔进入编辑模式');
    const result = await requestEditorOp(session.sessionId, { type: 'read' }, 20000);
    if (result?.error) throw new Error(String(result.error));
    return JSON.stringify(result);
  }
  if (name === 'editor_apply') {
    const session = getActiveEditor();
    if (!session) throw new Error('右侧没有正在编辑的文件，请先打开文件并点铅笔进入编辑模式');
    const operations = Array.isArray(a.operations) ? a.operations.slice(0, 50) : [];
    if (!operations.length) throw new Error('没有要执行的编辑操作');
    const result = await requestEditorOp(
      session.sessionId,
      { type: 'apply', operations },
      30000
    );
    if (result?.error) throw new Error(String(result.error));
    return JSON.stringify(result);
  }
  if (name === 'editor_set_cells') {
    const session = getActiveEditor();
    if (!session) throw new Error('右侧没有正在编辑的 Excel/CSV 文件');
    const cells = Array.isArray(a.cells) ? a.cells.slice(0, 500) : [];
    if (!cells.length) throw new Error('没有要写入的单元格');
    const result = await requestEditorOp(session.sessionId, { type: 'set_cells', cells }, 40000);
    if (result?.error) throw new Error(String(result.error));
    return JSON.stringify(result);
  }
  if (name === 'editor_set_paragraphs') {
    const session = getActiveEditor();
    if (!session) throw new Error('右侧没有正在编辑的 PPT 文件');
    const paragraphs = Array.isArray(a.paragraphs) ? a.paragraphs.slice(0, 500) : [];
    if (!paragraphs.length) throw new Error('没有要写入的段落');
    const result = await requestEditorOp(
      session.sessionId,
      { type: 'set_paragraphs', paragraphs },
      40000
    );
    if (result?.error) throw new Error(String(result.error));
    return JSON.stringify(result);
  }
  if (name === 'list_dir') {
    const target = toolPath(a.path || '.', cwd);
    assertToolPath(target, toolAllowedRoots(permission, cwd, false));
    const st = fs.statSync(target);
    if (!st.isDirectory()) throw new Error('这不是目录');
    return `目录 ${target}\n${listDirText(target)}`;
  }
  if (name === 'read_file') {
    const target = toolPath(a.path, cwd);
    assertToolPath(target, toolAllowedRoots(permission, cwd, false));
    const st = fs.statSync(target);
    if (!st.isFile()) throw new Error('这不是文件');
    const buf = fs.readFileSync(target);
    if (buf.subarray(0, 4096).includes(0)) throw new Error('这是二进制文件，不能按文本读取');
    return buf.toString('utf8').slice(0, 200000);
  }
  if (name === 'write_file') {
    const target = toolPath(a.path, cwd);
    assertToolPath(target, toolAllowedRoots(permission, cwd, true));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const content = String(a.content ?? '');
    if (a.append) fs.appendFileSync(target, content, 'utf8');
    else fs.writeFileSync(target, content, 'utf8');
    return `${a.append ? '已追加' : '已写入'} ${Buffer.byteLength(content)} 字节：${target}`;
  }
  if (name === 'run_command') {
    const command = String(a.command || '').trim();
    if (!command) throw new Error('缺少 command');
    const workdir = toolPath(a.cwd || cwd, cwd);
    assertToolPath(workdir, toolAllowedRoots(permission, cwd, true));
    const timeoutSec = Math.min(300, Math.max(1, Number(a.timeout_seconds) || 60));
    const shell = isWin
      ? { cmd: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', command] }
      : { cmd: '/bin/zsh', args: ['-lc', command] };
    const res = await exec(shell.cmd, shell.args, {
      cwd: workdir,
      timeoutMs: timeoutSec * 1000,
      signal,
      maxOut: 1024 * 1024,
    });
    return [
      `cwd: ${workdir}`,
      `exit: ${res.code}${res.timedOut ? '（超时）' : ''}`,
      res.out ? `stdout:\n${res.out.slice(0, 12000)}` : '',
      res.err ? `stderr:\n${res.err.slice(0, 6000)}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }
  if (name === 'find_files') {
    return `匹配文件：\n${findFilesTool(a.name, a.root, permission, cwd) || '（没有找到）'}`;
  }
  throw new Error(`未知工具：${name}`);
}

function addToolUsage(total, usage, style) {
  if (!usage) return total;
  if (style === 'anthropic') {
    total.input_tokens += Number(usage.input_tokens) || 0;
    total.output_tokens += Number(usage.output_tokens) || 0;
    total.cache_read_input_tokens += Number(usage.cache_read_input_tokens) || 0;
    total.cache_creation_input_tokens += Number(usage.cache_creation_input_tokens) || 0;
    return total;
  }
  total.input += Number(usage.prompt_tokens ?? usage.input) || 0;
  total.output += Number(usage.completion_tokens ?? usage.output) || 0;
  total.cache.read += Number(usage.prompt_tokens_details?.cached_tokens) || 0;
  return total;
}

function shortToolArgs(args) {
  try {
    const text = JSON.stringify(args || {});
    return text.length > 160 ? `${text.slice(0, 160)}…` : text;
  } catch {
    return '';
  }
}

async function runCustom({ bot, prompt, signal, timeoutMs, apiKey, onProgress, permission, cwd }) {
  const api = bot.api || {};
  const style = api.style === 'anthropic' ? 'anthropic' : 'openai';
  const base = String(api.baseUrl || '').trim();
  const key = String(apiKey || bot.apiKey || '').trim();
  const model = String(bot.model || '').trim();
  const workdir = cwd || process.cwd();
  const startedAt = Date.now();
  const fail = (msg) => ({
    text: '',
    reasoning: '',
    sessionId: null,
    usage: null,
    steps: [],
    timedOut: false,
    durationMs: Date.now() - startedAt,
    code: -1,
    err: msg,
  });
  if (!base) return fail('自定义 API 未配置 Base URL');
  if (!model) return fail('自定义 API 未配置模型名');

  const system = String(bot.persona || '').trim();
  const signals = [];
  if (timeoutMs > 0) signals.push(AbortSignal.timeout(timeoutMs));
  if (signal) signals.push(signal);
  const combined =
    signals.length > 1 && AbortSignal.any
      ? AbortSignal.any(signals)
      : signals[0] || undefined;
  onProgress?.({
    type: 'thinking',
    text: style === 'anthropic' ? '调用 Anthropic 兼容 API…' : '调用 OpenAI 兼容 API…',
  });

  let toolsEnabled = bot.customTools !== false;
  const steps = [];
  let finalText = '';
  let reasoning = '';
  const usageTotal =
    style === 'anthropic'
      ? { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
      : { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };

  const split = splitStablePrompt(prompt);
  const messages =
    style === 'anthropic'
      ? [
          {
            role: 'user',
            content: split
              ? [
                  { type: 'text', text: split.head, cache_control: { type: 'ephemeral' } },
                  { type: 'text', text: split.tail },
                ]
              : prompt,
          },
        ]
      : [
          ...(system ? [{ role: 'system', content: system }] : []),
          { role: 'user', content: prompt },
        ];

  const url =
    style === 'anthropic' ? joinApiUrl(base, '/v1/messages') : joinApiUrl(base, '/v1/chat/completions');
  const headers =
    style === 'anthropic'
      ? {
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01',
          ...(key ? { 'x-api-key': key } : {}),
        }
      : {
          'content-type': 'application/json',
          ...(key ? { authorization: `Bearer ${key}` } : {}),
        };

  try {
    const maxRounds = Math.max(12, Number(process.env.BT_MAX_TOOL_ROUNDS) || 40);
    for (let round = 0; round < maxRounds; round += 1) {
      const body =
        style === 'anthropic'
          ? {
              model,
              max_tokens: Number(api.maxTokens) || 8192,
              messages,
              ...(toolsEnabled ? { tools: CUSTOM_TOOLS_ANTHROPIC } : {}),
            }
          : {
              model,
              messages,
              ...(toolsEnabled ? { tools: CUSTOM_TOOLS_OPENAI } : {}),
            };
      if (style === 'anthropic' && system) {
        body.system = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
      }
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: combined,
      });
      const text = await res.text();
      let data = null;
      try {
        data = JSON.parse(text);
      } catch {}
      if (!res.ok) {
        // 有些兼容接口不支持 tools，第一次失败就退回普通文本模式
        if (round === 0 && toolsEnabled && (res.status === 400 || res.status === 422)) {
          toolsEnabled = false;
          continue;
        }
        const why =
          data?.error?.message || data?.message || text.slice(0, 800) || `HTTP ${res.status}`;
        return fail(`API 请求失败（HTTP ${res.status}）：${why}`);
      }

      if (style === 'anthropic') {
        addToolUsage(usageTotal, data?.usage, 'anthropic');
        const blocks = Array.isArray(data?.content) ? data.content : [];
        const textParts = [];
        const toolUses = [];
        for (const block of blocks) {
          if (block?.type === 'text' && block.text) textParts.push(block.text);
          if (block?.type === 'thinking' && block.thinking) {
            reasoning += (reasoning ? '\n' : '') + block.thinking;
          }
          if (block?.type === 'tool_use') toolUses.push(block);
        }
        if (!toolUses.length) {
          finalText = textParts.join('');
          break;
        }
        messages.push({ role: 'assistant', content: blocks });
        const results = [];
        for (const use of toolUses.slice(0, 8)) {
          const toolName = String(use.name || '');
          const args = use.input && typeof use.input === 'object' ? use.input : {};
          const step = { tool: toolName, title: shortToolArgs(args) };
          steps.push(step);
          onProgress?.({ type: 'step', ...step });
          let output = '';
          let isError = false;
          try {
            output = await executeCustomTool(toolName, args, { permission, cwd: workdir, signal });
          } catch (e) {
            isError = true;
            output = `工具执行失败：${String(e?.message || e)}`;
          }
          results.push({
            type: 'tool_result',
            tool_use_id: use.id,
            content: String(output).slice(0, toolName.startsWith('editor_') ? 40000 : 12000),
            ...(isError ? { is_error: true } : {}),
          });
        }
        messages.push({ role: 'user', content: results });
        continue;
      }

      addToolUsage(usageTotal, data?.usage, 'openai');
      const msg = data?.choices?.[0]?.message || {};
      const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
      if (!calls.length) {
        finalText = readOpenAIText(msg);
        reasoning = [reasoning, msg.reasoning_content || msg.reasoning || ''].filter(Boolean).join('\n');
        break;
      }
      messages.push({
        role: 'assistant',
        content: msg.content ?? null,
        tool_calls: calls,
      });
      for (const call of calls.slice(0, 8)) {
        const toolName = String(call?.function?.name || '');
        let args = {};
        try {
          args =
            typeof call?.function?.arguments === 'string'
              ? JSON.parse(call.function.arguments || '{}')
              : call?.function?.arguments || {};
        } catch {
          args = {};
        }
        const step = { tool: toolName, title: shortToolArgs(args) };
        steps.push(step);
        onProgress?.({ type: 'step', ...step });
        let output = '';
        try {
          output = await executeCustomTool(toolName, args, { permission, cwd: workdir, signal });
        } catch (e) {
          output = `工具执行失败：${String(e?.message || e)}`;
        }
        messages.push({
          role: 'tool',
          tool_call_id: call.id || `call_${steps.length}`,
          content: String(output).slice(0, toolName.startsWith('editor_') ? 40000 : 12000),
        });
      }
    }

    if (!finalText && steps.length) {
      finalText = '工具调用次数达到上限，任务可能还没有完成；可以继续发消息让我接着做。';
    }
    return {
      text: String(finalText).trim(),
      reasoning: String(reasoning || '').trim(),
      sessionId: null,
      usage: usageTotal,
      steps,
      streamedSteps: steps.length > 0,
      timedOut: false,
      durationMs: Date.now() - startedAt,
      code: 0,
      err: '',
    };
  } catch (e) {
    const timedOut = e?.name === 'TimeoutError' || /abort/i.test(String(e?.name || ''));
    return {
      text: '',
      reasoning: '',
      sessionId: null,
      usage: null,
      steps,
      timedOut,
      durationMs: Date.now() - startedAt,
      code: -1,
      err: String(e?.message || e),
    };
  }
}

const RUNNERS = {
  opencode: runOpencode,
  codex: runCodex,
  agy: runAgy,
  codebuddy: runCodebuddy,
  qoder: runQoder,
  claude: runClaude,
  custom: runCustom,
};

export function backendLabel(backend) {
  return {
    opencode: 'OpenCode',
    codex: 'Codex',
    agy: 'Antigravity',
    codebuddy: 'WorkBuddy',
    qoder: 'Qoder',
    claude: 'Claude Code',
    custom: '自定义 API',
  }[backend] || backend;
}

function looksLikeInternalAnalysis(text) {
  const t = String(text || '').trim();
  if (t.length < 400) return false;
  const cjk = (t.match(/[\u4e00-\u9fff]/g) || []).length;
  const latin = (t.match(/[A-Za-z]/g) || []).length;
  if (latin < cjk * 3) return false;
  return /^(the boss|the user|let me|i should|wait\s*[:：—-]|actually|ok\s*[:：,]|so\s*[:：,]|first\s*[:：,]|the task|the model|send to|answer\s*:|plan\s*:|here's|this is a)/i.test(t);
}

const QUOTA_ERROR_RE =
  /\b429\b|RESOURCE_EXHAUSTED|resource_exhausted|usage limit|rate limit|too many requests|insufficient(?:_quota| credits| balance)?|credit balance|out of credits|quota(?: exceeded)?|billing.*(?:limit|disabled|exhausted)|余额不足|额度(?:不足|已用完|耗尽|限制)?|限额|配额|请求过于频繁/i;
const AUTH_ERROR_RE =
  /unauthorized|invalid api key|authentication failed|not logged in|login required|token expired|\b401\b|\b403\b|未登录|登录已过期|密钥无效|鉴权失败/i;

export function isQuotaErrorText(text) {
  return QUOTA_ERROR_RE.test(String(text || ''));
}

export function isAuthErrorText(text) {
  return AUTH_ERROR_RE.test(String(text || ''));
}

export async function runBot({ bot, prompt, sessionId, cwd, effort, permission, attachments = [], onProgress, agyHome = '', signal, apiKey = '', timeoutMs = DEFAULT_TIMEOUT }) {
  const runner = RUNNERS[bot.backend];
  if (!runner) throw new Error(`未知后端：${bot.backend}`);
  // 提示词为空时各 CLI 会退回去读 stdin（Bot Team 的 stdin 是关闭的），
  // 报错会变成看不懂的「No prompt provided via stdin」。这里提前拦住。
  if (!String(prompt || '').trim()) {
    throw new Error('这一轮没有要执行的内容：提示词为空，已拦下，避免 CLI 去读 stdin 报怪错。');
  }

  let res = await runner({
    bot,
    prompt,
    sessionId,
    cwd,
    effort,
    permission,
    attachments,
    onProgress,
    agyHome,
    signal,
    apiKey,
    timeoutMs,
  });

  if (signal?.aborted || res.aborted) {
    const error = new Error('已停止');
    error.aborted = true;
    throw error;
  }

  // 少数模型会把英文内部分析直接当正文吐出来；再跑一次，要求只给最终中文回复。
  if (!signal?.aborted && res.text && looksLikeInternalAnalysis(res.text) && !res.retriedChinese) {
    try {
      const retry = await runner({
        bot,
        prompt: `${prompt}

重要：上一轮把英文内部分析直接输出了。这一轮只输出最终给老板的中文回复。不要输出英文思考过程、分析、计划或推理；直接给结论、结果和证据。需要转交时按原格式单独一行输出。控制在 1200 字以内。`,
        sessionId,
        cwd,
        effort,
        permission,
        attachments,
        onProgress,
        agyHome,
        signal,
        apiKey,
        timeoutMs,
      });
      if (!signal?.aborted && retry.text && !looksLikeInternalAnalysis(retry.text)) {
        retry.retriedChinese = true;
        res = retry;
      }
    } catch {}
  }

  // agy 在无界面模式下会拒绝工具权限，导致整轮没有文本输出。
  // 不放开权限，改成用更严格的提示再试一次：只输出文字，用 @@DELEGATE 转交。
  if (!res.text && /tool required .*permission|dangerously-skip-permissions/i.test(res.err || '')) {
    res = await runner({
      bot,
      prompt: `${prompt}\n\n重要：这次不要使用任何工具（不要执行命令、不要读写文件、不要发消息），只输出文字。需要同事接手就写 @@DELEGATE 同事名@@ 任务。`,
      sessionId,
      cwd,
      effort,
      permission,
      attachments,
      onProgress,
      agyHome,
      signal,
      apiKey,
      timeoutMs,
    });
    res.retriedNoTools = true;
    if (
      (!res.steps || !res.steps.length) &&
      (!res.text ||
        /没有.*权限|权限被拒绝|无权访问|unable to.*tool|cannot (?:run|execute|access|edit|write)|permission denied|blocked/i.test(
          res.text
        ))
    ) {
      res.noToolPermission = true;
    }
  }

  // 会话失效时，丢掉 session 重跑一次
  const failed = !res.text || res.code !== 0;
  const sessionLikeError = /session|conversation|thread/i.test(res.err || '') && /not found|invalid|unknown|expired|不存在/i.test(res.err || '');
  if (failed && sessionId && sessionLikeError) {
    res = await runner({ bot, prompt, sessionId: null, cwd, effort, permission, attachments, onProgress, agyHome, signal, apiKey, timeoutMs });
    res.sessionReset = true;
  }

  // Codex 同一个 thread 被另一个进程占用时，等它释放后重试一次
  if (/thread-store conflict|already has an active writer|code -32600/i.test(res.err || '')) {
    await new Promise((r) => setTimeout(r, 900));
    res = await runner({ bot, prompt, sessionId, cwd, effort, permission, attachments, onProgress, agyHome, signal, apiKey, timeoutMs });
  }

  // 若 CLI 以非 0 退出且无步骤，仅吐出短错误/额度文本，视为失败而非正常回复
  if (
    res.text &&
    res.code &&
    res.code !== 0 &&
    (!res.steps || !res.steps.length) &&
    res.text.length < 600 &&
    (isQuotaErrorText(res.text) || isAuthErrorText(res.text))
  ) {
    res.err = [res.err, res.text].filter(Boolean).join('\n');
    res.text = '';
  }

  if (!res.text) {
    const full = `${res.err || ''}\n${res.out || ''}`;
    const steps = Array.isArray(res.steps) ? res.steps : [];
    const stepLines = steps
      .slice(-6)
      .map((s) => `· ${s.tool}${s.title ? `：${s.title}` : ''}`)
      .join('\n');
    const secs = res.durationMs ? Math.round(res.durationMs / 1000) : 0;
    let detail;
    if (res.timedOut) {
      detail = [
        `执行超时（${secs ? `${Math.floor(secs / 60)} 分 ${secs % 60} 秒` : '时间上限'}）`,
        stepLines ? `已经执行到的步骤：\n${stepLines}` : '超时前没有返回可执行步骤。',
        res.reasoning ? `超时前的思考（截取）：\n${String(res.reasoning).slice(-1200)}` : '',
        '可以：把任务拆小、减少一次处理的数量，或换更快的模型后重试；也可以在 Bot 设置里把「单次执行超时」改成不限。',
      ]
        .filter(Boolean)
        .join('\n');
    } else {
      detail =
        (res.err || '').trim().split('\n').slice(-6).join('\n') ||
        String(res.out || '').trim().split('\n').slice(-6).join('\n') ||
        `${backendLabel(bot.backend)} 没有返回内容（exit ${res.code}）`;
      if (stepLines) detail += `\n已执行：\n${stepLines}`;
    }
    const error = new Error(detail);
    error.quota = isQuotaErrorText(full);
    error.auth = isAuthErrorText(full);
    error.code = res.code ?? -1;
    error.timedOut = !!res.timedOut;
    error.aborted = !!res.aborted || !!signal?.aborted;
    error.steps = steps;
    error.partialReasoning = res.reasoning || '';
    error.durationMs = res.durationMs || 0;
    throw error;
  }
  return res;
}
