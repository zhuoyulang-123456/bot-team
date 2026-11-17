import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isWin, which } from './platform.mjs';

const require = createRequire(import.meta.url);

// Node 22.5+ 自带 sqlite，优先用它，避免 Windows 上没有 /usr/bin/sqlite3。
// 这里只在加载时屏蔽内置 sqlite 的实验性警告，不影响其他告警。
let DatabaseSync = null;
try {
  const originalEmitWarning = process.emitWarning;
  process.emitWarning = function (warning, ...rest) {
    const msg = typeof warning === 'string' ? warning : warning?.message || '';
    if (/SQLite is an experimental feature/i.test(msg)) return;
    return originalEmitWarning.call(this, warning, ...rest);
  };
  ({ DatabaseSync } = require('node:sqlite'));
} catch {}

function dbCandidates() {
  const home = os.homedir();
  const list = [];
  if (process.env.XDG_DATA_HOME) list.push(path.join(process.env.XDG_DATA_HOME, 'opencode', 'opencode.db'));
  list.push(path.join(home, '.local', 'share', 'opencode', 'opencode.db'));
  // Windows 上 OpenCode 也可能把数据放在 Local/Roaming AppData
  if (process.env.LOCALAPPDATA) list.push(path.join(process.env.LOCALAPPDATA, 'opencode', 'opencode.db'));
  if (process.env.APPDATA) list.push(path.join(process.env.APPDATA, 'opencode', 'opencode.db'));
  return [...new Set(list)];
}

function findDb() {
  for (const file of dbCandidates()) {
    try {
      if (fs.statSync(file).isFile()) return file;
    } catch {}
  }
  return dbCandidates()[0];
}

export const OPENCODE_DB = findDb();

export function opencodeDbStat() {
  try {
    const s = fs.statSync(OPENCODE_DB);
    return { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    return null;
  }
}

function quote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

/**
 * 统一路径比较：Windows 不区分大小写，OpenCode 里存的是正斜杠，
 * 而 path.join 在 Windows 上给的是反斜杠。
 */
export function normalizeDbPath(p) {
  let s = String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (/^[a-z]:/i.test(s)) s = s[0].toUpperCase() + s.slice(1);
  return isWin ? s.toLowerCase() : s;
}

let sqliteCli = null;
function sqliteCliPath() {
  if (sqliteCli !== null) return sqliteCli;
  sqliteCli = which('sqlite3') || (isWin ? '' : '/usr/bin/sqlite3');
  try {
    if (sqliteCli && !fs.statSync(sqliteCli).isFile()) sqliteCli = '';
  } catch {
    sqliteCli = '';
  }
  return sqliteCli;
}

function openReadOnly() {
  if (DatabaseSync) {
    try {
      const db = new DatabaseSync(OPENCODE_DB, { readOnly: true });
      return { db, close: () => db.close() };
    } catch {}
  }
  return null;
}

function tableNames(db) {
  try {
    const rows = db.prepare("select name from sqlite_master where type in ('table','view')").all();
    return new Set(rows.map((r) => r.name));
  } catch {
    return new Set();
  }
}

/* ---- 旧版 schema：message 表，data JSON 里带 path.cwd ---- */

const OLD_TURNS_SQL = `with m as (
    select json_extract(data,'$.parentID') pid,
           json_extract(data,'$.time.created') ts,
           json_extract(data,'$.providerID') provider,
           json_extract(data,'$.modelID') model,
           json_extract(data,'$.tokens.input') input,
           json_extract(data,'$.tokens.output') output,
           json_extract(data,'$.tokens.reasoning') reasoning,
           json_extract(data,'$.tokens.cache.read') cache_read,
           json_extract(data,'$.tokens.cache.write') cache_write,
           json_extract(data,'$.tokens.total') total
    from message
    where json_extract(data,'$.role')='assistant'
      and json_extract(data,'$.path.cwd')=?
  )
  select pid, min(ts) t0, max(ts) t1, provider, model,
         sum(input) input, sum(output) output, sum(reasoning) reasoning,
         sum(cache_read) cache_read, sum(cache_write) cache_write,
         sum(total) total, count(*) steps
  from m group by pid, provider, model`;

/* ---- 新版 schema（OpenCode 2.x）：session_v2 + session_message ---- */

const NEW_TURNS_SQL = `with m as (
    select s.directory dir,
           sm.seq seq,
           sm.time_created ts,
           json_extract(sm.data,'$.model.providerID') provider,
           coalesce(json_extract(sm.data,'$.model.id'), json_extract(sm.data,'$.model.modelID')) model,
           coalesce(json_extract(sm.data,'$.tokens.input'),0) input,
           coalesce(json_extract(sm.data,'$.tokens.output'),0) output,
           coalesce(json_extract(sm.data,'$.tokens.reasoning'),0) reasoning,
           coalesce(json_extract(sm.data,'$.tokens.cache.read'),0) cache_read,
           coalesce(json_extract(sm.data,'$.tokens.cache.write'),0) cache_write,
           (select max(u.seq) from session_message u
             where u.session_id = sm.session_id and u.type='user' and u.seq < sm.seq) turn
    from session_message sm
    join session_v2 s on s.id = sm.session_id
    where sm.type='assistant'
  )
  select dir, turn, min(ts) t0, max(ts) t1, provider, model,
         sum(input) input, sum(output) output, sum(reasoning) reasoning,
         sum(cache_read) cache_read, sum(cache_write) cache_write,
         sum(input + output + reasoning + cache_read + cache_write) total,
         count(*) steps
  from m
  where turn is not null
  group by dir, turn, provider, model`;

function rowsViaCli(sql, cwd) {
  const bin = sqliteCliPath();
  if (!bin) throw new Error('no sqlite3');
  const text = sql.replace(/\?/g, quote(cwd));
  const raw = execFileSync(bin, ['-json', OPENCODE_DB, text], {
    encoding: 'utf8',
    timeout: 20000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(raw || '[]');
}

/**
 * 读取所有轮次；新版 schema 一次读出后按目录分组，
 * 旧版 schema 仍按 cwd 逐 Bot 查询。
 */
function readTurnsByDir() {
  const handle = openReadOnly();
  if (!handle) return null;
  const { db, close } = handle;
  try {
    const tables = tableNames(db);
    const rows = [];
    if (tables.has('session_message') && tables.has('session_v2')) {
      for (const r of db.prepare(NEW_TURNS_SQL).all()) rows.push(r);
    } else if (tables.has('message')) {
      // 旧版按 cwd 查询，交给调用方按 Bot 逐个读
      return { legacy: true, db, close };
    } else {
      close();
      return null;
    }
    close();
    const byDir = new Map();
    for (const r of rows) {
      const key = normalizeDbPath(r.dir);
      if (!key) continue;
      if (!byDir.has(key)) byDir.set(key, []);
      byDir.get(key).push(r);
    }
    return { legacy: false, byDir };
  } catch {
    try { close(); } catch {}
    return null;
  }
}

function readLegacyTurns(cwd) {
  const handle = openReadOnly();
  if (handle) {
    const { db, close } = handle;
    try {
      const rows = db.prepare(OLD_TURNS_SQL).all(cwd);
      close();
      return rows;
    } catch {
      try { close(); } catch {}
    }
  }
  return rowsViaCli(OLD_TURNS_SQL, cwd);
}

function sourceFor(provider, model, bot) {
  if (provider === 'deepseek') return { source: 'DeepSeek 按量', billing: 'payg' };
  if (/-free$/i.test(model || '')) return { source: '免费模型', billing: 'free' };
  if (provider === 'opencode-go' || provider === 'opencode') {
    return { source: 'OpenCode Go', billing: 'subscription' };
  }
  return { source: bot.source || provider || '', billing: bot.billing || '' };
}

/**
 * 从本机 OpenCode 会话数据库重建历史用量。
 * Bot Team 旧版本每轮只记录了最后一个 step，这里按「每轮对话」聚合所有 step。
 */
export function buildOpencodeEvents(state, botsDir) {
  const stat = opencodeDbStat();
  if (!stat) return null;
  const events = [];
  const syncedBots = new Set();
  const ranges = {};
  let reader = null;
  try {
    reader = readTurnsByDir();
  } catch {
    reader = null;
  }
  const legacyDb = reader?.legacy ? reader.db : null;
  try {
    for (const bot of state.bots || []) {
      if (bot.backend !== 'opencode' || bot.deleted) continue;
      const cwd = path.join(botsDir, bot.id, 'workspace');
      let rows = [];
      try {
        if (reader?.byDir) {
          rows = reader.byDir.get(normalizeDbPath(cwd)) || [];
        } else if (legacyDb) {
          rows = legacyDb.prepare(OLD_TURNS_SQL).all(cwd) || [];
        } else {
          rows = readLegacyTurns(cwd) || [];
        }
      } catch {
        continue;
      }
      if (!rows.length) continue;
      let min = Infinity;
      let max = -Infinity;
      for (const r of rows) {
        const ts = Number(r.t1) || 0;
        if (!ts) continue;
        min = Math.min(min, ts);
        max = Math.max(max, ts);
        const model = r.model || bot.model || '';
        const provider = r.provider || '';
        const { source, billing } = sourceFor(provider, model, bot);
        events.push({
          ts,
          kind: 'opencode-db',
          botId: bot.id,
          botName: bot.name,
          backend: 'opencode',
          model: provider ? `${provider}/${model}` : model,
          source,
          billing,
          chatId: null,
          chatType: null,
          groupId: null,
          groupTitle: null,
          projectTitle: null,
          input: Number(r.input) || 0,
          output: Number(r.output) || 0,
          reasoning: Number(r.reasoning) || 0,
          cacheRead: Number(r.cache_read) || 0,
          cacheWrite: Number(r.cache_write) || 0,
          total: Number(r.total) || 0,
          calls: 1,
          note: `OpenCode 会话重建 · ${Number(r.steps) || 1} 个 step`,
        });
      }
      if (min !== Infinity) {
        syncedBots.add(bot.id);
        ranges[bot.id] = { min, max };
      }
    }
  } finally {
    try { legacyDb?.close(); } catch {}
  }
  return { events, syncedBots, ranges, stat };
}
