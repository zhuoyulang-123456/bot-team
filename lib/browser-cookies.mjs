import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isWin } from './platform.mjs';

const CHROMIUM_BASES = [
  {
    name: 'Chrome',
    dir: 'Google/Chrome',
    service: 'Chrome Safe Storage',
    account: 'Chrome',
  },
  {
    name: 'Chrome Beta',
    dir: 'Google/Chrome Beta',
    service: 'Chrome Safe Storage',
    account: 'Chrome',
  },
  {
    name: 'Chrome Canary',
    dir: 'Google/Chrome Canary',
    service: 'Chrome Safe Storage',
    account: 'Chrome',
  },
  {
    name: 'Edge',
    dir: 'Microsoft Edge',
    service: 'Microsoft Edge Safe Storage',
    account: 'Microsoft Edge',
  },
  {
    name: 'Brave',
    dir: 'BraveSoftware/Brave-Browser',
    service: 'Brave Safe Storage',
    account: 'Brave',
  },
  {
    name: 'Chromium',
    dir: 'Chromium',
    service: 'Chromium Safe Storage',
    account: 'Chromium',
  },
  {
    name: 'Vivaldi',
    dir: 'Vivaldi',
    service: 'Vivaldi Safe Storage',
    account: 'Vivaldi',
  },
  {
    name: 'Arc',
    dir: 'Arc/User Data',
    service: 'Arc Safe Storage',
    account: 'Arc',
  },
];

function supportDir() {
  return path.join(os.homedir(), 'Library/Application Support');
}

const KNOWN_PROFILES = [
  'Default',
  'Guest Profile',
  ...Array.from({ length: 40 }, (_, i) => `Profile ${i + 1}`),
];

let accessIssues = [];

export function getAccessIssues() {
  return accessIssues;
}

/** 列出本机 Chromium 系浏览器的所有可见 profile 及其 Cookies 数据库 */
export function chromiumProfiles() {
  if (isWin) return [];
  const base = supportDir();
  const out = [];
  accessIssues = [];
  for (const b of CHROMIUM_BASES) {
    const root = path.join(base, b.dir);
    let names = [];
    try {
      names = fs
        .readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .filter((n) => n === 'Default' || /^Profile \d+$/.test(n) || n === 'Guest Profile');
    } catch (e) {
      if (e.code === 'EPERM' || e.code === 'EACCES') {
        // macOS 隐私权限只挡住了目录列举，已知 profile 路径往往仍可直接读
        accessIssues.push({
          browser: b.name,
          root,
          error: `${e.code}: operation not permitted`,
        });
        names = KNOWN_PROFILES;
      } else {
        continue;
      }
    }
    for (const p of names) {
      const db = path.join(root, p, 'Cookies');
      try {
        if (fs.existsSync(db)) out.push({ ...b, profile: p, db });
      } catch {}
    }
  }
  return out;
}

let chromeKeyCache = new Map();
let lastKeychainError = '';

export function keychainStatus() {
  return { error: lastKeychainError };
}

function keychainPassword(service, account) {
  if (isWin) return null;
  if (chromeKeyCache.has(service)) return chromeKeyCache.get(service);
  try {
    const args = ['find-generic-password', '-w', '-s', service];
    if (account) args.push('-a', account);
    const pw = execFileSync('/usr/bin/security', args, {
      encoding: 'utf8',
      timeout: 15000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    chromeKeyCache.set(service, pw || null);
    return pw || null;
  } catch (e) {
    lastKeychainError = String(e?.stderr || e?.message || e).slice(0, 300);
    chromeKeyCache.set(service, null);
    return null;
  }
}

function deriveKey(password) {
  return crypto.pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
}

const IV = Buffer.from(' '.repeat(16));

function decryptValue(encryptedHex, hostKey, key) {
  const raw = Buffer.from(encryptedHex || '', 'hex');
  if (!raw.length) return '';
  if (!key) return '';
  const prefix = raw.subarray(0, 3).toString('latin1');
  if (prefix !== 'v10' && prefix !== 'v11') {
    // 新版本可能直接存明文
    return raw.toString('utf8');
  }
  try {
    const d = crypto.createDecipheriv('aes-128-cbc', key, IV);
    const out = Buffer.concat([d.update(raw.subarray(3)), d.final()]);
    // Chrome 24+ 会在明文前加 32 字节 host hash
    const hash = crypto.createHash('sha256').update(hostKey).digest();
    const body = out.length > 32 && out.subarray(0, 32).equals(hash) ? out.subarray(32) : out;
    return body.toString('utf8');
  } catch {
    return '';
  }
}

function copyDb(db) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-cookies-'));
  const dest = path.join(dir, 'Cookies');
  for (const ext of ['', '-wal', '-shm']) {
    try {
      fs.copyFileSync(db + ext, dest + ext);
    } catch {}
  }
  return { dir, dest };
}

/**
 * 读取某个 profile 中指定域名（后缀匹配）的 Cookie。
 * @returns {{name:string,value:string,host:string,expires:number}[]}
 */
export function readCookies(db, hostSuffixes) {
  const { dir, dest } = copyDb(db);
  try {
    const where = hostSuffixes
      .map((s) => `host_key like '%${String(s).replace(/'/g, "''")}'`)
      .join(' or ');
    const sql = `select host_key,name,value,hex(encrypted_value) as enc,expires_utc from cookies where ${where}`;
    const raw = execFileSync('/usr/bin/sqlite3', ['-json', dest, sql], {
      encoding: 'utf8',
      timeout: 15000,
    });
    const rows = JSON.parse(raw || '[]');
    if (!rows.length) return [];
    const meta = findBrowserMeta(db);
    const pw = keychainPassword(meta.service, meta.account);
    const key = pw ? deriveKey(pw) : null;
    return rows
      .map((r) => {
        const value = r.value && String(r.value).length ? String(r.value) : decryptValue(r.enc, r.host_key, key);
        const expires = Number(r.expires_utc)
          ? (Number(r.expires_utc) / 1e6 - 11644473600) * 1000
          : 0;
        return { name: r.name, value, host: r.host_key, expires };
      })
      .filter((c) => c.value && c.value.length < 4096);
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
}

function findBrowserMeta(db) {
  for (const b of CHROMIUM_BASES) {
    if (db.includes(`/${b.dir}/`)) return b;
  }
  return CHROMIUM_BASES[0];
}

/** 在全部 Chromium profile 中查找域名 Cookie，返回第一个命中的浏览器信息 */
export function findCookiesEverywhere(hostSuffixes) {
  const profiles = chromiumProfiles();
  for (const p of profiles) {
    let cookies = [];
    try {
      cookies = readCookies(p.db, hostSuffixes);
    } catch {
      continue;
    }
    if (!cookies.length) continue;
    return {
      browser: p.name,
      profile: p.profile,
      cookies,
    };
  }
  return null;
}


/** 诊断：各浏览器 profile 是否可读、能解出多少 Cookie、钥匙串是否可用 */
export function browserDiagnostics(hostSuffixes = ['xiaomimimo.com', 'xiaomi.com']) {
  if (isWin) {
    return {
      unsupported: true,
      message: 'Windows 暂不支持自动读取浏览器 Cookie，请使用 App 内登录或手动填写 Cookie。',
      probes: [],
      profiles: [],
    };
  }
  const probes = [];
  for (const b of CHROMIUM_BASES) {
    const root = path.join(supportDir(), b.dir);
    const probe = { browser: b.name, root, exists: false, readdir: '', db: '' };
    try {
      probe.exists = fs.existsSync(root);
    } catch (e) {
      probe.exists = String(e.message || e);
    }
    if (probe.exists) {
      try {
        probe.dirs = fs.readdirSync(root).filter((x) => x === 'Default' || /^Profile \d+$/.test(x)).slice(0, 8);
      } catch (e) {
        probe.readdir = String(e.message || e).slice(0, 160);
      }
      const db = path.join(root, 'Default', 'Cookies');
      try {
        probe.db = fs.existsSync(db) ? 'ok' : 'missing';
      } catch (e) {
        probe.db = String(e.message || e).slice(0, 160);
      }
      if (probe.db === 'ok') {
        try {
          probe.fileRead = fs.readFileSync(db).length;
        } catch (e) {
          probe.fileRead = String(e.code || e.message || e).slice(0, 160);
        }
      }
    }
    probes.push(probe);
  }
  const out = [];
  for (const p of chromiumProfiles()) {
    let rows = 0;
    let cookies = [];
    let error = '';
    try {
      const tmp = copyDb(p.db);
      try {
        const where = hostSuffixes
          .map((x) => `host_key like '%${x}'`)
          .join(' or ');
        const raw = execFileSync(
          '/usr/bin/sqlite3',
          ['-json', tmp.dest, `select count(*) as n from cookies where ${where}`],
          { encoding: 'utf8', timeout: 15000 }
        );
        rows = JSON.parse(raw || '[]')[0]?.n || 0;
      } finally {
        fs.rmSync(tmp.dir, { recursive: true, force: true });
      }
      cookies = readCookies(p.db, hostSuffixes);
    } catch (e) {
      error = String(e.message || e).slice(0, 200);
    }
    out.push({
      browser: p.name,
      profile: p.profile,
      rows,
      decrypted: cookies.length,
      error,
    });
  }
  return { probes, profiles: out, keychain: keychainStatus() };
}
