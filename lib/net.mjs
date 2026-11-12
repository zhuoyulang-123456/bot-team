/* 网络出口：统一处理系统代理。
   Node 的 fetch 默认不读 macOS 系统代理；Clash / Surge 这类用户如果不开 TUN，
   ChatGPT 用量、API 余额、翻译等请求会直接失败。这里在服务启动时和设置变更时
   配置 undici 的全局 dispatcher，并对 127.0.0.1 / localhost 强制直连。 */
import { execFileSync } from 'node:child_process';
import net from 'node:net';
import { EnvHttpProxyAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';

const defaultDispatcher = getGlobalDispatcher();
const LOCAL_BYPASS = '127.0.0.1,localhost,::1';
let activeProxy = '';

function parseScutil(out) {
  const map = {};
  for (const line of String(out || '').split('\n')) {
    const m = line.match(/^\s*([A-Za-z]+)\s*:\s*(.+?)\s*$/);
    if (m) map[m[1]] = m[2];
  }
  return map;
}

/** macOS 系统代理；只支持 HTTP(S)，SOCKS-only 的情况留给 TUN 模式 */
export function detectSystemProxy() {
  if (process.platform !== 'darwin') return '';
  try {
    const out = execFileSync('/usr/sbin/scutil', ['--proxy'], {
      encoding: 'utf8',
      timeout: 3000,
    });
    const p = parseScutil(out);
    if (p.HTTPSEnable === '1' && p.HTTPSProxy) {
      return `http://${p.HTTPSProxy}:${p.HTTPSPort || '443'}`;
    }
    if (p.HTTPEnable === '1' && p.HTTPProxy) {
      return `http://${p.HTTPProxy}:${p.HTTPPort || '80'}`;
    }
  } catch {}
  return '';
}

function proxyReachable(url, timeout = 500) {
  try {
    const u = new URL(url);
    if (!u.hostname || !u.port) return false;
    return new Promise((resolve) => {
      const socket = net.connect({ host: u.hostname, port: Number(u.port) });
      const done = (ok) => {
        socket.destroy();
        resolve(ok);
      };
      socket.setTimeout(timeout);
      socket.once('connect', () => done(true));
      socket.once('timeout', () => done(false));
      socket.once('error', () => done(false));
    });
  } catch {
    return Promise.resolve(false);
  }
}

function mergeNoProxy(value) {
  const parts = new Set(
    String(value || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  );
  for (const host of LOCAL_BYPASS.split(',')) parts.add(host);
  return [...parts].join(',');
}

/**
 * 配置全局代理。
 * @param {string} preferred 用户在设置里填的代理；留空则依次看环境变量 / macOS 系统代理
 * @returns {Promise<string>} 实际生效的代理地址；空字符串表示直连
 */
export async function setupProxy(preferred = '') {
  const explicit = String(preferred || '').trim();
  if (/^(direct|none|off|no)$/i.test(explicit)) {
    setGlobalDispatcher(defaultDispatcher);
    activeProxy = '';
    return '';
  }
  const fromEnv = String(process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '').trim();
  let proxy = explicit || fromEnv;
  if (!proxy) {
    const detected = detectSystemProxy();
    if (detected && (await proxyReachable(detected))) proxy = detected;
  }
  if (!proxy) {
    setGlobalDispatcher(defaultDispatcher);
    activeProxy = '';
    return '';
  }
  if (!/^https?:\/\//i.test(proxy)) {
    // SOCKS-only 代理 undici 的 EnvHttpProxyAgent 不支持，保持直连并让上层提示
    setGlobalDispatcher(defaultDispatcher);
    activeProxy = '';
    return '';
  }
  try {
    const noProxy = mergeNoProxy(process.env.NO_PROXY);
    process.env.HTTP_PROXY = proxy;
    process.env.HTTPS_PROXY = proxy;
    process.env.NO_PROXY = noProxy;
    setGlobalDispatcher(
      new EnvHttpProxyAgent({
        httpProxy: proxy,
        httpsProxy: proxy,
        noProxy,
      })
    );
    activeProxy = proxy;
    return proxy;
  } catch {
    setGlobalDispatcher(defaultDispatcher);
    activeProxy = '';
    return '';
  }
}

export function currentProxy() {
  return activeProxy;
}

