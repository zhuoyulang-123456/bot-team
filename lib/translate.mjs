import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { curlCommand } from './platform.mjs';

const execFileP = promisify(execFile);
const FREE_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
// Electron 的 Node 用的是 BoringSSL/TLS 指纹，Google 的免费 gtx 接口会直接 429；
// 系统 curl 用的是 LibreSSL/OpenSSL，能正常拿到结果，所以 429 后统一切到 curl。
let freeUseCurl = false;

const cache = new Map();
const MAX_CACHE = 600;

function cacheKey(engine, target, text) {
  const h = crypto.createHash('sha1').update(text).digest('hex');
  return `${engine}|${target}|${h}`;
}

const TARGET_NAME = {
  'zh-CN': '简体中文',
  'zh-TW': '繁体中文',
  en: 'English',
  ja: '日本語',
  ko: '한국어',
};

function parseGoogleTranslate(data) {
  if (!Array.isArray(data?.[0])) throw new Error('免费翻译接口返回异常');
  return data[0].map((x) => x?.[0] || '').join('');
}

async function curlGoogleTranslate(url) {
  const { stdout } = await execFileP(
    curlCommand(),
    ['-sS', '--compressed', '-A', FREE_UA, '--max-time', '15', url],
    { maxBuffer: 4 * 1024 * 1024, timeout: 20000, windowsHide: true }
  );
  return parseGoogleTranslate(JSON.parse(stdout));
}

async function googleTranslateOne(text, target) {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(
    target
  )}&dt=t&q=${encodeURIComponent(text)}`;
  if (freeUseCurl) return curlGoogleTranslate(url);
  try {
    const r = await fetch(url, {
      headers: { 'user-agent': FREE_UA },
      signal: AbortSignal.timeout(15000),
    });
    if (r.status === 429 || r.status === 403) {
      freeUseCurl = true;
      return curlGoogleTranslate(url);
    }
    if (!r.ok) throw new Error(`免费翻译接口 HTTP ${r.status}`);
    return parseGoogleTranslate(await r.json());
  } catch (e) {
    // 证书/TLS/网络层失败也退回系统 curl
    if (/fetch failed|network|TLS|certificate|aborted|timeout/i.test(String(e?.message || e))) {
      freeUseCurl = true;
      return curlGoogleTranslate(url);
    }
    throw e;
  }
}

async function freeTranslate(texts, target) {
  const out = [];
  const queue = [...texts.keys()];
  const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
    while (queue.length) {
      const i = queue.shift();
      try {
        out[i] = await googleTranslateOne(texts[i], target);
      } catch (e) {
        out[i] = '';
      }
    }
  });
  await Promise.all(workers);
  return out;
}

function chunkTexts(texts, limit = 6000) {
  const chunks = [];
  let cur = [];
  let size = 0;
  for (let i = 0; i < texts.length; i += 1) {
    const t = texts[i];
    if (cur.length && size + t.length > limit) {
      chunks.push({ start: i - cur.length, texts: cur });
      cur = [];
      size = 0;
    }
    cur.push(t);
    size += t.length + 20;
  }
  if (cur.length) chunks.push({ start: texts.length - cur.length, texts: cur });
  return chunks;
}

function parseJsonArray(raw) {
  const text = String(raw || '').trim();
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  try {
    const arr = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(arr) ? arr.map((x) => String(x ?? '')) : null;
  } catch {
    return null;
  }
}



function joinApi(base, suffix) {
  const b = String(base || '').replace(/\/+$/, '');
  if (!b) return '';
  if (b.endsWith(suffix)) return b;
  if (suffix.startsWith('/v1/') && /\/v\d+$/i.test(b)) return b + suffix.slice(3);
  return b + suffix;
}

async function readJsonResponse(r, label) {
  const raw = await r.text();
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${label} 返回的不是 JSON（HTTP ${r.status}）：${raw.slice(0, 160)}`);
  }
}

async function callBotText(bot, apiKey, prompt, maxTokens = 4096) {
  const api = bot.api || {};
  const base = String(api.baseUrl || '').replace(/\/+$/, '');
  if (!base) throw new Error('Bot 没有配置 Base URL');
  const key = String(apiKey || '').trim();
  const style = api.style === 'anthropic' ? 'anthropic' : 'openai';
  if (style === 'anthropic') {
    const url = joinApi(base, '/v1/messages');
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        ...(key ? { 'x-api-key': key } : {}),
      },
      body: JSON.stringify({
        model: bot.model,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(120000),
    });
    const data = await readJsonResponse(r, '解释/翻译 API');
    if (!r.ok) throw new Error(data?.error?.message || `API HTTP ${r.status}`);
    return (data.content || []).map((b) => b?.text || '').join('');
  }
  const url = joinApi(base, '/v1/chat/completions');
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify({
      model: bot.model,
      temperature: 0.2,
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(120000),
  });
  const data = await readJsonResponse(r, '解释/翻译 API');
  if (!r.ok) throw new Error(data?.error?.message || `API HTTP ${r.status}`);
  return data?.choices?.[0]?.message?.content || '';
}

export async function explainText(text, { bot, apiKey = '' } = {}) {
  if (!bot) throw new Error('没有可用于解释的 API Bot');
  const prompt = [
    '用最通俗的大白话解释下面这段内容。',
    '先给一句话结论，再用 3-5 句话展开；可以用一个生活化的类比。',
    '不要客套，不要用工具，不要输出标题或 Markdown。',
    '',
    String(text || '').slice(0, 4000),
  ].join('\n');
  const raw = await callBotText(bot, apiKey, prompt, 2048);
  return String(raw || '').trim();
}

export async function summarizeText(text, { bot, apiKey = '' } = {}) {
  if (!bot) throw new Error('没有可用于总结的 API Bot');
  const prompt = [
    '把下面这段视频转写内容用中文总结：',
    '1) 先用 2-3 句话概括主题和结论；',
    '2) 再列 5 个关键要点（每条一行，短句）；',
    '3) 最后给一句“适合谁看/能学到什么”。',
    '不要客套，不要编造转写里没有的内容。',
    '',
    String(text || '').slice(0, 12000),
  ].join('\n');
  const raw = await callBotText(bot, apiKey, prompt, 3000);
  return String(raw || '').trim();
}

export async function rewriteText(text, { instruction = '', bot, apiKey = '' } = {}) {
  if (!bot) throw new Error('没有可用于改写的 API Bot');
  const prompt = [
    '请改写下面这段文字。',
    instruction ? `要求：${instruction}` : '要求：润色，使表达更通顺、专业，保持原意。',
    '只输出改写后的文字，不要解释，不要加引号或标题。',
    '',
    String(text || '').slice(0, 8000),
  ].join('\n');
  const raw = await callBotText(bot, apiKey, prompt, 3000);
  return String(raw || '').trim();
}

async function botTranslate(texts, { bot, apiKey, target }) {
  const name = TARGET_NAME[target] || target;
  const api = bot.api || {};
  const base = String(api.baseUrl || '').replace(/\/+$/, '');
  if (!base) throw new Error('翻译 Bot 没有配置 Base URL');
  const key = String(apiKey || '').trim();
  const style = api.style === 'anthropic' ? 'anthropic' : 'openai';
  const out = new Array(texts.length).fill('');
  for (const chunk of chunkTexts(texts)) {
    const prompt = [
      `把下面 ${chunk.texts.length} 段文本翻译成${name}。`,
      '要求：逐段对应，合并不拆分；保留数字、代码、链接和专有名词；只输出 JSON 字符串数组，长度和顺序与输入完全一致，不要解释。',
      '输入：',
      JSON.stringify(chunk.texts),
    ].join('\n');
    let raw = '';
    if (style === 'anthropic') {
      const url = joinApi(base, '/v1/messages');
      const r = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01',
          ...(key ? { 'x-api-key': key } : {}),
        },
        body: JSON.stringify({
          model: bot.model,
          max_tokens: 8192,
          messages: [{ role: 'user', content: prompt }],
        }),
        signal: AbortSignal.timeout(120000),
      });
      const data = await readJsonResponse(r, '翻译 API');
      if (!r.ok) throw new Error(data?.error?.message || `翻译 API HTTP ${r.status}`);
      raw = (data.content || []).map((b) => b?.text || '').join('');
    } else {
      const url = joinApi(base, '/v1/chat/completions');
      const r = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(key ? { authorization: `Bearer ${key}` } : {}),
        },
        body: JSON.stringify({
          model: bot.model,
          temperature: 0.2,
          messages: [{ role: 'user', content: prompt }],
        }),
        signal: AbortSignal.timeout(120000),
      });
      const data = await readJsonResponse(r, '翻译 API');
      if (!r.ok) throw new Error(data?.error?.message || `翻译 API HTTP ${r.status}`);
      raw = data?.choices?.[0]?.message?.content || '';
    }
    let arr = parseJsonArray(raw);
    if (!arr || arr.length !== chunk.texts.length) {
      // 模型没按 JSON 返回时，按行兜底
      const lines = String(raw)
        .split('\n')
        .map((x) => x.replace(/^\s*[-*\d.、]+\s*/, '').trim())
        .filter(Boolean);
      arr = lines.length >= chunk.texts.length ? lines.slice(0, chunk.texts.length) : null;
    }
    if (!arr) throw new Error('翻译模型没有返回可解析的结果');
    arr.forEach((t, i) => {
      out[chunk.start + i] = t;
    });
  }
  return out;
}

export async function translateTexts(texts, { engine = 'free', target = 'zh-CN', bot = null, apiKey = '' } = {}) {
  const list = (Array.isArray(texts) ? texts : []).map((t) => String(t ?? ''));
  const out = new Array(list.length).fill('');
  const pending = [];
  list.forEach((text, i) => {
    if (!text.trim()) return;
    const key = cacheKey(engine, target, text);
    if (cache.has(key)) out[i] = cache.get(key);
    else pending.push({ i, text, key });
  });
  if (pending.length) {
    const results =
      engine === 'bot'
        ? await botTranslate(pending.map((p) => p.text), { bot, apiKey, target })
        : await freeTranslate(pending.map((p) => p.text), target);
    results.forEach((t, idx) => {
      const p = pending[idx];
      out[p.i] = t || '';
      if (t) {
        cache.set(p.key, t);
        if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
      }
    });
  }
  return out;
}
