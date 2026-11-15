// Windows / 本机可跑的回归测试：验证这批修复真的生效。
// 用法：node scripts/test-win-fixes.mjs
// 不需要外网、不需要 API Key：自带一个本地 OpenAI 兼容 mock 服务。
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-test-'));
const APP_PORT = 4827;
const MOCK_PORT = 4899;
const uploadsDir = path.join(HOME, 'data', 'uploads', 'files');
fs.mkdirSync(uploadsDir, { recursive: true });
// 1x1 PNG
fs.writeFileSync(
  path.join(uploadsDir, 'pixel.png'),
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  )
);

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} · ${name}${detail ? ` · ${detail}` : ''}`);
};

/* ---------- 本地 mock API ---------- */
const seen = [];
function sse(res, chunks, usage = { prompt_tokens: 10, completion_tokens: 5 }) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for (const c of chunks) {
    res.write(`data: ${JSON.stringify({ choices: [{ delta: c, index: 0 }] })}\n\n`);
  }
  res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage })}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}
const mock = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => (raw += d));
  req.on('end', () => {
    let body = {};
    try {
      body = JSON.parse(raw);
    } catch {}
    seen.push(body);
    const model = String(body.model || '');
    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [{ message: { content: '非流式回复', role: 'assistant' } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        })
      );
      return;
    }
    if (model === 'mock-tools') {
      const toolMsgs = (body.messages || []).filter((m) => m.role === 'tool').length;
      if (toolMsgs < 3) {
        sse(res, [
          {
            tool_calls: [
              {
                index: 0,
                id: `call_${toolMsgs + 1}`,
                type: 'function',
                function: { name: 'list_dir', arguments: '{"path":"."}' },
              },
            ],
          },
        ]);
        return;
      }
      sse(res, [{ content: '收尾完成：文件都列出来了。' }]);
      return;
    }
    if (model === 'mock-vision') {
      sse(res, [{ reasoning_content: '先看看图片…' }, { content: '我看到图了' }, { content: '：一张测试图片。' }]);
      return;
    }
    sse(res, [{ content: '好的' }]);
  });
});

/* ---------- Bot Team 服务 ---------- */
function waitFor(fn, timeout = 30000, step = 250) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = async () => {
      try {
        const v = await fn();
        if (v) return resolve(v);
      } catch {}
      if (Date.now() - started > timeout) return reject(new Error('timeout'));
      setTimeout(tick, step);
    };
    tick();
  });
}
async function api(p, init) {
  const r = await fetch(`http://127.0.0.1:${APP_PORT}${p}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers || {}) },
  });
  const text = await r.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text, status: r.status };
  }
}

let serverProc = null;
async function main() {
  await new Promise((r) => mock.listen(MOCK_PORT, '127.0.0.1', r));

  serverProc = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT,
    env: {
      ...process.env,
      BOT_TEAM_HOME: HOME,
      BOT_TEAM_HOST: '127.0.0.1',
      PORT: String(APP_PORT),
      BT_MAX_TOOL_ROUNDS: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  serverProc.stdout.on('data', () => {});
  serverProc.stderr.on('data', (d) => process.env.BT_TEST_VERBOSE && console.error(String(d)));

  await waitFor(async () => {
    const h = await api('/api/health');
    return h && h.cli ? h : null;
  });

  /* ---- 场景 0：老版本留下的「一个私聊塞了多个 Bot」脏数据，启动时自动拆开 ---- */
  {
    const legacyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-legacy-'));
    fs.mkdirSync(path.join(legacyHome, 'data'), { recursive: true });
    const legacy = {
      self: { name: 'me', emoji: '🥚', color: '#fff' },
      settings: { leaderId: 'bot_a', setupDone: true, wallpaper: true, theme: 'dark' },
      bots: [
        { id: 'bot_a', name: 'legacy-a', backend: 'custom', model: 'm', emoji: '🙂', color: '#111', skills: [] },
        { id: 'bot_b', name: 'legacy-b', backend: 'custom', model: 'm', emoji: '🙂', color: '#222', skills: [] },
      ],
      botGroups: [],
      chats: [
        {
          id: 'chat_mixed',
          type: 'dm',
          title: 'legacy-a',
          project: '默认项目',
          botIds: ['bot_a', 'bot_b'],
          leadId: 'bot_a',
          effort: 'auto',
          skills: [],
          files: [],
          log: [],
          createdAt: 1,
        },
      ],
      messages: {},
      roles: [],
      agyProfiles: [],
      deleted: [],
      skillMeta: {},
      schedules: [],
      providerKeys: {},
    };
    fs.writeFileSync(path.join(legacyHome, 'data', 'state.json'), JSON.stringify(legacy));
    const probePath = path.join(legacyHome, 'probe.mjs');
    fs.writeFileSync(
      probePath,
      `const { loadState } = await import(${JSON.stringify(
        pathToFileURL(path.join(ROOT, 'lib', 'store.mjs')).href
      )});\n` +
        `const s = loadState();\n` +
        `const dms = s.chats.filter((c) => c.type === 'dm').map((c) => ({ id: c.id, botIds: c.botIds }));\n` +
        `console.log(JSON.stringify(dms));\n`
    );
    const r = spawnSync(process.execPath, [probePath], {
      env: { ...process.env, BOT_TEAM_HOME: legacyHome },
      encoding: 'utf8',
      windowsHide: true,
      timeout: 60000,
    });
    const dms = (() => {
      try {
        return JSON.parse(String(r.stdout || '').trim().split(/\r?\n/).pop() || '[]');
      } catch {
        return [];
      }
    })();
    check(
      '旧脏数据：多 Bot 私聊被拆成各自独立私聊',
      dms.length === 2 && dms.every((d) => d.botIds.length === 1),
      JSON.stringify(dms)
    );
    fs.rmSync(legacyHome, { recursive: true, force: true });
  }

  /* ---- 场景 1：领导私聊里新建 Bot，不能污染领导 DM ---- */
  const leader = await api('/api/bots', {
    method: 'POST',
    body: JSON.stringify({ name: 'leader-a', backend: 'custom', model: 'mock-plain' }),
  });
  const boot1 = await api('/api/bootstrap');
  const leaderDm = boot1.chats.find((c) => c.type === 'dm' && c.botIds[0] === leader.id);
  check('领导 Bot 有独立私聊', !!leaderDm, leaderDm?.id || 'no dm');

  const worker = await api('/api/bots', {
    method: 'POST',
    body: JSON.stringify({
      name: 'worker-b',
      backend: 'custom',
      model: 'mock-plain',
      chatId: leaderDm?.id,
    }),
  });
  const boot2 = await api('/api/bootstrap');
  const leaderDm2 = boot2.chats.find((c) => c.id === leaderDm.id);
  check('新建 Bot 不会挤进领导私聊', leaderDm2.botIds.length === 1, `botIds=${leaderDm2.botIds.length}`);
  check('新 Bot 拿到自己的私聊', !!worker.dmChatId && worker.dmChatId !== leaderDm.id, worker.dmChatId || 'none');
  const workerDm = boot2.chats.find((c) => c.id === worker.dmChatId);
  check('新私聊只包含新 Bot', workerDm?.botIds?.length === 1 && workerDm.botIds[0] === worker.id);

  /* ---- 场景 2：自定义 API 读图 + 流式 ---- */
  const vision = await api('/api/bots', {
    method: 'POST',
    body: JSON.stringify({
      name: 'vision-bot',
      backend: 'custom',
      model: 'mock-vision',
      api: { mode: 'custom', style: 'openai', baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`, models: ['mock-vision'] },
    }),
  });
  seen.length = 0;
  await api(`/api/chats/${vision.dmChatId}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      text: '这张图里有什么？',
      attachments: [{ url: '/uploads/files/pixel.png', name: 'pixel.png', mime: 'image/png', size: 68 }],
    }),
  });
  const visionReq = await waitFor(() => seen.find((b) => b.model === 'mock-vision'), 30000);
  const userMsg = (visionReq.messages || []).find((m) => m.role === 'user');
  const parts = Array.isArray(userMsg?.content) ? userMsg.content : [];
  const imgPart = parts.find((p) => p.type === 'image_url');
  check(
    '图片以 image_url 形式发给模型',
    !!imgPart && /^data:image\/png;base64,/.test(imgPart.image_url?.url || ''),
    imgPart ? imgPart.image_url.url.slice(0, 32) : 'no image part'
  );
  check('请求开启了流式', visionReq.stream === true);

  const visionMsgs = await waitFor(async () => {
    const r = await api(`/api/chats/${vision.dmChatId}`);
    const hit = (r.messages || []).find((m) => m.type === 'text' && m.senderId === vision.id);
    return hit ? r.messages : null;
  }, 40000);
  const visionReply = visionMsgs.filter((m) => m.type === 'text' && m.senderId === vision.id).pop();
  check('流式回复内容完整', /我看到图了/.test(visionReply?.text || ''), String(visionReply?.text || '').slice(0, 40));
  check('思考过程被记录', /先看看图片/.test(visionReply?.meta?.thinking || ''), String(visionReply?.meta?.thinking || '').slice(0, 30));

  /* ---- 场景 3：工具轮数不再硬卡 40，且不会甩固定文案 ---- */
  const tools = await api('/api/bots', {
    method: 'POST',
    body: JSON.stringify({
      name: 'tools-bot',
      backend: 'custom',
      model: 'mock-tools',
      maxToolRounds: 3,
      api: { mode: 'custom', style: 'openai', baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`, models: ['mock-tools'] },
    }),
  });
  seen.length = 0;
  await api(`/api/chats/${tools.dmChatId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ text: '列一下目录里的文件' }),
  });
  const toolMsgs = await waitFor(async () => {
    const r = await api(`/api/chats/${tools.dmChatId}`);
    const hit = (r.messages || []).find((m) => m.type === 'text' && m.senderId === tools.id);
    return hit ? r.messages : null;
  }, 60000);
  const toolReply = toolMsgs.filter((m) => m.type === 'text' && m.senderId === tools.id).pop();
  check(
    '撞到轮数上限时给出真实收尾而不是固定文案',
    !/工具调用次数达到上限/.test(toolReply?.text || '') && /收尾完成/.test(toolReply?.text || ''),
    String(toolReply?.text || '').slice(0, 40)
  );
  const roundsSeen = seen.filter((b) => b.model === 'mock-tools').length;
  check('轮数上限可配置（maxToolRounds=3 生效）', roundsSeen <= 4, `requests=${roundsSeen}`);

  /* ---- 场景 4：默认上限不再是 40 ---- */
  const def = await api('/api/bots', {
    method: 'POST',
    body: JSON.stringify({ name: 'default-bot', backend: 'custom', model: 'mock-plain' }),
  });
  check('新建 Bot 默认不限 40 轮（maxToolRounds 字段存在，0=默认 200）', def.maxToolRounds === 0, `value=${def.maxToolRounds}`);

  /* ---- 场景 5（可选）：真实 codebuddy CLI 端到端，验证不再报 unknown option ---- */
  if (process.env.BT_TEST_CODEBUDDY === '1') {
    const cb = await api('/api/bots', {
      method: 'POST',
      body: JSON.stringify({ name: 'cb-bot', backend: 'codebuddy', model: '' }),
    });
    const token = `ZX${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    await api(`/api/chats/${cb.dmChatId}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        text: `请记住这个口令：${token}。只回复：记住了`,
        attachments: [{ url: '/uploads/files/pixel.png', name: 'pixel.png', mime: 'image/png', size: 68 }],
      }),
    });
    const msgs = await waitFor(async () => {
      const r = await api(`/api/chats/${cb.dmChatId}`);
      const hit = (r.messages || []).find((m) => m.type === 'text' && m.senderId === cb.id);
      return hit ? r.messages : null;
    }, 300000, 500).catch(() => null);
    const reply = (msgs || []).filter((m) => m.type === 'text' && m.senderId === cb.id).pop();
    const errMsg = (msgs || []).filter((m) => m.type === 'system' || m.meta?.error).map((m) => m.text).join(' ');
    check('codebuddy 有回复', !!reply?.text, String(reply?.text || '').slice(0, 40));
    check('不再出现 unknown option --attachment', !/unknown option/i.test(errMsg + (reply?.text || '')));
    check('codebuddy 流式思考被记录', !!reply?.meta?.thinking, String(reply?.meta?.thinking || '').slice(0, 30));

    // 上下文连贯性：第二轮必须记得第一轮的口令
    const botsAfter = await api('/api/bootstrap');
    const cbState = (botsAfter.bots || []).find((b) => b.id === cb.id);
    check(
      'codebuddy 会话 id 已存下（后续才能续接）',
      !!cbState?.sessions && Object.keys(cbState.sessions).length > 0,
      JSON.stringify(Object.keys(cbState?.sessions || {}))
    );
    await api(`/api/chats/${cb.dmChatId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ text: '我刚才让你记住的口令是什么？只回答口令本身。' }),
    });
    const msgs2 = await waitFor(
      async () => {
        const r = await api(`/api/chats/${cb.dmChatId}`);
        const hits = (r.messages || []).filter((m) => m.type === 'text' && m.senderId === cb.id);
        return hits.length >= 2 ? hits : null;
      },
      300000,
      500
    ).catch(() => null);
    const reply2 = (msgs2 || []).pop();
    check(
      'codebuddy 多轮上下文能接上',
      new RegExp(token).test(String(reply2?.text || '')),
      String(reply2?.text || '').slice(0, 60)
    );
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n== ${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error('测试异常：', e?.message || e);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      serverProc?.kill();
    } catch {}
    mock.close();
    await new Promise((r) => setTimeout(r, 300));
    try {
      fs.rmSync(HOME, { recursive: true, force: true });
    } catch {}
  });
