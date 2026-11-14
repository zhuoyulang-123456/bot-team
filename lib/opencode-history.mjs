import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isWin } from './platform.mjs';

export const OPENCODE_DB = path.join(os.homedir(), '.local/share/opencode/opencode.db');

export function opencodeDbStat() {
  if (isWin) return null;
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

function queryTurns(cwd) {
  const sql = `with m as (
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
      and json_extract(data,'$.path.cwd')=${quote(cwd)}
  )
  select pid, min(ts) t0, max(ts) t1, provider, model,
         sum(input) input, sum(output) output, sum(reasoning) reasoning,
         sum(cache_read) cache_read, sum(cache_write) cache_write,
         sum(total) total, count(*) steps
  from m group by pid, provider, model`;
  const raw = execFileSync('/usr/bin/sqlite3', ['-json', OPENCODE_DB, sql], {
    encoding: 'utf8',
    timeout: 20000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(raw || '[]');
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
  for (const bot of state.bots || []) {
    if (bot.backend !== 'opencode' || bot.deleted) continue;
    const cwd = path.join(botsDir, bot.id, 'workspace');
    let rows = [];
    try {
      rows = queryTurns(cwd);
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
  return { events, syncedBots, ranges, stat };
}
