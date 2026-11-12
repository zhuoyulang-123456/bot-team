import { findCookiesEverywhere, readCookies, chromiumProfiles } from './browser-cookies.mjs';

const MIMO_HOSTS = ['xiaomimimo.com'];
const XIAOMI_HOSTS = ['xiaomi.com'];
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36';

function platformCookieHeader(cookies) {
  return cookies
    .filter((c) => c.host.includes('xiaomimimo.com'))
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}

function accountVars(cookies) {
  const passToken = cookies.find((c) => c.name === 'passToken')?.value || '';
  const userId = cookies.find((c) => c.name === 'userId')?.value || '';
  return { passToken, userId };
}

export async function fetchMimoBalance(cookie) {
  const r = await fetch('https://platform.xiaomimimo.com/api/v1/balance', {
    headers: {
      cookie,
      accept: 'application/json, text/plain, */*',
      referer: 'https://platform.xiaomimimo.com/#/console/balance',
      'user-agent': UA,
    },
    signal: AbortSignal.timeout(20000),
  });
  let body = '';
  try {
    body = await r.text();
  } catch {}
  let data = null;
  try {
    data = JSON.parse(body);
  } catch {}
  const expired =
    r.status === 401 ||
    (r.status >= 300 && r.status < 400) ||
    (data && Number(data.code) === 401);
  return {
    ok: r.ok && data && Number(data.code) === 0,
    status: r.status,
    expired,
    data,
    body,
  };
}

/** 用小米账号 passToken 换 MiMo 平台 serviceToken */
export async function renewMimoSession({ passToken, userId }) {
  if (!passToken) throw new Error('缺少 passToken');
  const url =
    'https://account.xiaomi.com/pass/serviceLogin?_dc=' +
    Date.now() +
    '&sid=api-platform&callback=' +
    encodeURIComponent('https://platform.xiaomimimo.com/sts');
  const cookieParts = [`passToken=${passToken}`];
  if (userId) cookieParts.push(`userId=${userId}`);
  const r = await fetch(url, {
    headers: {
      cookie: cookieParts.join('; '),
      accept: 'application/json, text/plain, */*',
      'user-agent': UA,
    },
    signal: AbortSignal.timeout(20000),
  });
  let text = await r.text();
  if (text.startsWith('&&&START&&&')) text = text.slice(11);
  let j = null;
  try {
    j = JSON.parse(text);
  } catch {}
  if (!j || j.result !== 'ok' || !j.serviceToken) {
    throw new Error('小米账号登录态已失效，请用 Chrome 重新登录小米账号');
  }
  const parts = [`api-platform_serviceToken="${j.serviceToken}"`];
  if (j.userId) parts.push(`userId=${j.userId}`);
  if (j.ph) parts.push(`api-platform_ph="${j.ph}"`);
  if (j.slh) parts.push(`api-platform_slh="${j.slh}"`);
  return { cookie: parts.join('; '), userId: String(j.userId || userId || '') };
}

/**
 * 从本机浏览器读取 MiMo 登录态：
 * 1. 逐个 Chromium profile 找 platform.xiaomimimo.com Cookie 并验证
 * 2. 平台 Cookie 失效时，用账号 passToken 换新 serviceToken
 * 3. 返回可用 Cookie；找不到时抛出可读错误
 */
export async function syncMimoLogin() {
  const profiles = chromiumProfiles();
  let bestAccount = null;
  let lastReason = '';

  for (const p of profiles) {
    let cookies = [];
    try {
      cookies = readCookies(p.db, [...MIMO_HOSTS, ...XIAOMI_HOSTS]);
    } catch {
      continue;
    }
    if (!cookies.length) continue;
    const cookie = platformCookieHeader(cookies);
    const account = accountVars(cookies);
    if (!bestAccount && account.passToken) {
      bestAccount = { ...account, browser: p.name, profile: p.profile };
    }
    if (!cookie) continue;
    try {
      const res = await fetchMimoBalance(cookie);
      if (res.ok) {
        return {
          cookie,
          passToken: account.passToken,
          userId: account.userId,
          browser: p.name,
          profile: p.profile,
          balance: res.data?.data || null,
        };
      }
      lastReason = res.expired ? '平台登录态已过期' : `HTTP ${res.status}`;
    } catch (e) {
      lastReason = String(e.message || e);
    }
  }

  // 没有可用的平台 Cookie：尝试用小米账号 passToken 续期
  if (bestAccount?.passToken) {
    try {
      const renewed = await renewMimoSession(bestAccount);
      const res = await fetchMimoBalance(renewed.cookie);
      if (res.ok) {
        return {
          cookie: renewed.cookie,
          passToken: bestAccount.passToken,
          userId: renewed.userId || bestAccount.userId,
          browser: bestAccount.browser,
          profile: bestAccount.profile,
          balance: res.data?.data || null,
          renewed: true,
        };
      }
      lastReason = res.expired ? '续期后仍被平台拒绝' : `HTTP ${res.status}`;
    } catch (e) {
      lastReason = String(e.message || e);
    }
  }

  const found = findCookiesEverywhere(MIMO_HOSTS);
  throw new Error(
    lastReason
      ? `读取到浏览器登录态，但无法查询：${lastReason}。请确认已用 Chrome 登录 MiMo 控制台。`
      : found
        ? '读取到浏览器登录态，但无法查询余额。请重新登录 MiMo 控制台后再试。'
        : '没有在 Chrome / Edge / Brave 中找到 MiMo 登录态。请先用这些浏览器登录 platform.xiaomimimo.com。'
  );
}
