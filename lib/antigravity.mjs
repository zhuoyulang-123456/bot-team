import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isWin } from './platform.mjs';

const HUB_DIR = path.join(os.homedir(), '.gemini/antigravity/daemon');
const APP_STORAGE = path.join(
  os.homedir(),
  'Library/Application Support/Antigravity/app_storage.json'
);

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 找到当前正在运行的 Antigravity 语言服务（本地 hub） */
function findHub() {
  let files = [];
  try {
    files = fs
      .readdirSync(HUB_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        const file = path.join(HUB_DIR, f);
        const stat = fs.statSync(file);
        return { file, mtime: stat.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    return null;
  }
  for (const { file } of files) {
    const j = readJson(file);
    if (!j) continue;
    if (!pidAlive(Number(j.pid))) continue;
    if (!j.httpPort || !j.csrfToken) continue;
    return j;
  }
  return null;
}

/** 当前 Antigravity / Antigravity CLI 登录的账号 */
export function antigravityAccount() {
  if (isWin) return '';
  const storage = readJson(APP_STORAGE);
  const email = storage?.['jetski.onboarding.lastLoginUsername'];
  if (email && String(email).includes('@')) return String(email);
  try {
    const raw = execFileSync(
      '/usr/bin/security',
      ['find-generic-password', '-s', 'gemini', '-a', 'antigravity', '-w'],
      { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim();
    const b64 = raw.replace(/^go-keyring-base64:/, '');
    const j = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    if (j.id_token_email) return String(j.id_token_email);
  } catch {}
  return '';
}

function windowLabel(win) {
  if (win === '5h') return '5 小时';
  if (win === 'weekly') return '本周';
  return win || '额度';
}

function groupPrefix(name) {
  const d = String(name || '');
  if (/Gemini 4|Argon/i.test(d)) return 'Gemini 4';
  if (/Claude|GPT/i.test(d)) return 'Claude/GPT';
  if (/Gemini/i.test(d)) return 'Gemini';
  return d.replace(/\s*Models?$/i, '').trim() || '额度';
}

/** 从本地 hub 读取实时配额（Antigravity 正在运行时可用） */
export async function liveAntigravityCard() {
  if (isWin) return null;
  const hub = findHub();
  if (!hub) return null;
  const base = `http://127.0.0.1:${hub.httpPort}`;
  try {
    const r = await fetch(
      `${base}/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'connect-protocol-version': '1',
          'x-codeium-csrf-token': String(hub.csrfToken),
        },
        body: '{}',
        signal: AbortSignal.timeout(12000),
      }
    );
    if (!r.ok) return null;
    const j = await r.json();
    const groups = j?.response?.groups;
    if (!Array.isArray(groups) || !groups.length) return null;
    const windows = [];
    for (const g of groups) {
      const prefix = groupPrefix(g.displayName);
      for (const b of g.buckets || []) {
        const rem = Number(b.remainingFraction);
        if (!Number.isFinite(rem)) continue;
        windows.push({
          label: `${prefix} · ${windowLabel(b.window)}`,
          percent: Math.max(0, Math.min(100, Math.round((1 - rem) * 100))),
          resetsAt: b.resetTime || '',
        });
      }
    }
    if (!windows.length) return null;
    const email = antigravityAccount();
    return {
      id: 'antigravity-live',
      name: email ? `Antigravity · ${email}` : 'Antigravity · 当前登录账号',
      kind: 'quota',
      status: windows.some((w) => w.percent >= 100) ? 'limited' : 'ok',
      windows,
      detail: `实时 · 本地 Antigravity 登录${email ? ` · ${email}` : ''}`,
    };
  } catch {
    return null;
  }
}
