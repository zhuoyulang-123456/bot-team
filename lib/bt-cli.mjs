#!/usr/bin/env node
/**
 * Bot Team 管理 CLI（独立脚本，不依赖应用内的模块）。
 * 领导 Bot 通过 shell 调用它来管理 Bot Team。
 *
 * 环境变量：
 *   BOT_TEAM_URL   应用地址，例如 http://127.0.0.1:4820
 *   BOT_TEAM_TOKEN 可选；本机访问通常不需要
 */
import fs from 'node:fs';
import path from 'node:path';

const base = (process.env.BOT_TEAM_URL || 'http://127.0.0.1:4820').replace(/\/+$/, '');
const token = process.env.BOT_TEAM_TOKEN || '';
const args = process.argv.slice(2);
const cmd = args[0] || 'help';

async function req(method, p, body) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(base + p, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  if (!res.ok) {
    const msg = typeof data === 'string' ? data : JSON.stringify(data);
    throw new Error(`HTTP ${res.status}: ${msg}`);
  }
  return data;
}

function jsonArg(raw) {
  if (!raw) return {};
  if (raw.startsWith('@')) return JSON.parse(fs.readFileSync(raw.slice(1), 'utf8'));
  return JSON.parse(raw);
}

function out(value) {
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

function short(s, n = 80) {
  return String(s || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, n);
}

function botName(data, id) {
  return data.bots?.find((b) => b.id === id)?.name || id || '?';
}

async function status() {
  const d = await req('GET', '/api/bootstrap');
  const rt = new Map((d.runtime || []).map((x) => [x.botId, x]));
  const leader = d.bots?.find((b) => b.id === d.settings?.leaderId);
  console.log(`Bot Team  ${base}`);
  console.log(
    `领导：${leader?.name || '未设置'}  |  壁纸：${
      d.settings?.wallpaper === false ? '关' : '开'
    }${d.settings?.wallpaperFile ? `（${d.settings.wallpaperFile}）` : ''}`
  );
  console.log('\n群：');
  for (const c of (d.chats || []).filter((x) => x.type === 'group')) {
    const target = d.bots?.find((b) => b.id === c.loopTargetId);
    console.log(
      `- ${c.title}  [${c.id}]  loop=${c.loop ? `on 第${c.loopRound || 0}轮 target=${target?.name || '?'}` : 'off'}${
        c.draining ? '  收尾模式' : ''
      }  members=${(c.botIds || []).length}  lead=${botName(d, c.leadId)}`
    );
  }
  console.log('\nBot：');
  for (const b of d.bots || []) {
    const r = rt.get(b.id);
    let state = '空闲';
    if (r?.running) state = r.queued ? '排队中' : `正在工作${r.chatTitle ? ` · ${r.chatTitle}` : ''}`;
    else if (b.alert) state = `需要处理：${short(b.alert.text, 50)}`;
    else if (r?.lastError) state = `上次出错：${short(r.lastError, 50)}`;
    console.log(
      `- ${b.name}  [${b.id}]  ${b.backend} · ${b.model || '默认'}  ${state}${
        r?.task ? `  任务：${short(r.task, 80)}` : ''
      }`
    );
  }
  console.log('\n职位：' + (d.roles || []).length + ' 个');
  for (const r of d.roles || []) {
    console.log(`- ${r.name}（${r.abbr || ''}） [${r.id}]  skills=${(r.skills || []).join('、') || '无'}`);
  }
}

async function bots() {
  const d = await req('GET', '/api/bootstrap');
  const rt = new Map((d.runtime || []).map((x) => [x.botId, x]));
  for (const b of d.bots || []) {
    const r = rt.get(b.id);
    console.log(
      [
        b.id,
        b.name,
        `${b.backend} · ${b.model || '默认'}`,
        b.source || '-',
        b.permission?.mode || 'workspace',
        b.roleId || '-',
        r?.running ? (r.queued ? 'queued' : 'running') : 'idle',
      ].join(' | ')
    );
  }
}

async function chats() {
  const d = await req('GET', '/api/bootstrap');
  for (const c of d.chats || []) {
    const who = (c.botIds || []).map((id) => botName(d, id)).join('、');
    const kind = c.type === 'group' ? '群' : c.linkedGroupId ? '项目' : '私聊';
    console.log(
      `[${c.id}] ${kind} ${c.title}  loop=${c.loop ? 'on' : 'off'}  draining=${c.draining ? 'yes' : 'no'}  bots=${who}`
    );
  }
}

async function roles() {
  const d = await req('GET', '/api/bootstrap');
  for (const r of d.roles || []) {
    console.log(
      `[${r.id}] ${r.name}（${r.abbr || ''}）  persona=${short(r.persona, 90)}  skills=${(r.skills || []).join('、') || '无'}`
    );
  }
}

async function projects() {
  const d = await req('GET', '/api/bootstrap');
  for (const c of (d.chats || []).filter((x) => x.type === 'dm' && x.linkedGroupId)) {
    console.log(
      `[${c.id}] ${c.title}  bot=${botName(d, c.botIds?.[0])}  群=${c.linkedGroupId}  project=${c.project || ''}`
    );
  }
}

async function logs(chatId, n = 20) {
  if (!chatId) throw new Error('用法：bt logs <chatId> [条数]');
  const d = await req('GET', '/api/bootstrap');
  const j = await req('GET', `/api/chats/${encodeURIComponent(chatId)}`);
  const list = (j.messages || []).slice(-Number(n || 20));
  for (const m of list) {
    const who = m.senderId === 'user' ? '老板' : botName(d, m.senderId);
    console.log(
      `${new Date(m.ts).toLocaleString('zh-CN', { hour12: false })} [${m.type}] ${who}: ${short(
        m.text,
        200
      )}`
    );
  }
}

async function upload(kind, file, name) {
  if (!file) throw new Error('用法：bt upload <avatar|wallpaper|file> <文件> [名称]');
  const buf = fs.readFileSync(file);
  const ext = path.extname(file).toLowerCase().replace('.', '') || 'bin';
  const mime =
    ext === 'png'
      ? 'image/png'
      : ext === 'jpg' || ext === 'jpeg'
        ? 'image/jpeg'
        : ext === 'webp'
          ? 'image/webp'
          : ext === 'gif'
            ? 'image/gif'
            : 'application/octet-stream';
  const r = await req('POST', '/api/uploads', {
    kind,
    name: name || path.basename(file),
    mime,
    data: buf.toString('base64'),
  });
  return r;
}

async function main() {
  const sub = args[0];
  if (sub === 'help' || !sub) {
    console.log(`Bot Team 管理 CLI
用法：
  bt status
  bt bots
  bt chats
  bt roles
  bt projects
  bt runtime
  bt logs <chatId> [条数]
  bt get <path>
  bt post <path> [json|@file]
  bt patch <path> [json|@file]
  bt delete <path>
  bt loop <chatId> on|off [botId] [prompt]
  bt drain <chatId> [收尾要求]
  bt upload <avatar|wallpaper|file> <file> [name]
  bt wallpaper <file>
  bt avatar <botId> <file>
  bt model <botId> <model> [source] [billing]
  bt permission <botId> <full|workspace|custom>
  bt workflow <chatId> [@file|json]      查看/保存群流程图
  bt workflow-run <chatId>              从头运行流程图
  bt workflow-resume <chatId>           从断点继续（保留已完成环节）
  bt skill-install <github-url> --bot <botId> | --group <chatId> | --role <roleId>
                                        从 GitHub 安装 skill 并加到 Bot/群/职位
  bt workflow-pause <chatId>            当前环节做完后暂停，进度保留
  bt models                             看每个 CLi 后端可用的模型 + 当前 Bot 选型
  bt providers                          看已保存的直连 API 提供商（Key 已存在本机）
  bt new-bot <名字> [岗位说明] [--backend codex] [--model 模型] [--provider deepseek]
                                         新建 Bot，返回 id
  bt new-group <群名> <成员1、成员2...>  用现有 Bot 建群，返回群 id
  bt workflow <chatId> @flow.json       保存/发布流程图
  bt workflow-run <chatId>              运行流程图
  bt workflow-export <chatId>           导出流程图（HTML，存到桌面）
  bt workflow-drain <chatId> [--node id] [原因]
                                        平滑收尾：当前环节做完后交给上传环节
  bt workflow-stop <chatId>             强制停止流程图

环境：BOT_TEAM_URL=${base}`);
    return;
  }

  if (sub === 'status') return status();
  if (sub === 'bots') return bots();
  if (sub === 'chats') return chats();
  if (sub === 'roles') return roles();
  if (sub === 'projects') return projects();
  if (sub === 'runtime') {
    const d = await req('GET', '/api/bootstrap');
    return out(d.runtime || []);
  }
  if (sub === 'logs') return logs(args[1], args[2]);

  if (sub === 'get') {
    if (!args[1]) throw new Error('用法：bt get <path>');
    return out(await req('GET', args[1]));
  }
  if (sub === 'post' || sub === 'patch') {
    if (!args[1]) throw new Error(`用法：bt ${sub} <path> [json|@file]`);
    const body = jsonArg(args[2]);
    return out(await req(sub.toUpperCase(), args[1], body));
  }
  if (sub === 'delete') {
    if (!args[1]) throw new Error('用法：bt delete <path>');
    return out(await req('DELETE', args[1]));
  }
  if (sub === 'loop') {
    const id = args[1];
    const flag = args[2];
    if (!id || !['on', 'off'].includes(flag)) throw new Error('用法：bt loop <chatId> on|off [botId] [prompt]');
    const body = { enabled: flag === 'on' };
    if (args[3]) body.loopTargetId = args[3];
    if (args[4]) body.loopPrompt = args.slice(4).join(' ');
    return out(await req('POST', `/api/chats/${encodeURIComponent(id)}/loop`, body));
  }
  if (sub === 'drain') {
    const id = args[1];
    if (!id) throw new Error('用法：bt drain <chatId> [收尾要求]');
    const note = args.slice(2).join(' ') || '停止生产新内容；只上传已完成批次；完成后输出 @@DONE。';
    const j = await req('GET', `/api/chats/${encodeURIComponent(id)}`);
    const c = j.chat;
    const prompt =
      '收尾模式：不要再生产任何新内容，也不要再向其他成员要新批次。检查已经交付但还没上传的批次，把已完成的全部上传、核验、补版本公告和工作日志；没有待上传的就直接总结。完成后在最后单独一行输出 @@DONE，停止自动运行。';
    const body = {
      draining: true,
      drainNote: note,
      loopPrompt: prompt,
      loopTargetId:
        c.loopTargetId ||
        (c.botIds || []).find((id) => id !== (j.settings?.leaderId || '')) ||
        c.botIds?.[0],
    };
    const r = await req('PATCH', `/api/chats/${encodeURIComponent(id)}`, body);
    console.log(
      `已设置收尾模式：${c.title}（loop=${c.loop ? 'on' : 'off'}）。${
        c.loop ? '下一轮会执行收尾。' : '群当前没开持续运行，需要开启循环或让领导用 @@DRAIN 触发一次。'
      }`
    );
    return out(r);
  }
  if (sub === 'upload') {
    const r = await upload(args[1], args[2], args[3]);
    return out(r);
  }
  if (sub === 'wallpaper') {
    if (!args[1]) throw new Error('用法：bt wallpaper <图片文件>');
    const up = await upload('wallpaper', args[1], args[2]);
    const r = await req('PATCH', '/api/settings', { wallpaper: true, wallpaperFile: up.url });
    console.log(`壁纸已更新：${up.url}`);
    return out(r);
  }
  if (sub === 'avatar') {
    const botId = args[1];
    const file = args[2];
    if (!botId || !file) throw new Error('用法：bt avatar <botId> <图片文件>');
    const up = await upload('avatar', file, args[3]);
    const r = await req('PATCH', `/api/bots/${encodeURIComponent(botId)}`, { avatar: up.url });
    console.log(`头像已更新：${botId} -> ${up.url}`);
    return out(r);
  }
  if (sub === 'model') {
    const botId = args[1];
    const model = args[2];
    if (!botId || !model) throw new Error('用法：bt model <botId> <model> [source] [billing]');
    const body = { model };
    if (args[3]) body.source = args[3];
    if (args[4]) body.billing = args[4];
    return out(await req('PATCH', `/api/bots/${encodeURIComponent(botId)}`, body));
  }
  if (sub === 'workflow') {
    const id = args[1];
    if (!id) throw new Error('用法：bt workflow <chatId> [@file|json]');
    if (!args[2]) {
      const j = await req('GET', `/api/chats/${encodeURIComponent(id)}`);
      return out(j.chat?.workflow || null);
    }
    const wf = jsonArg(args[2]);
    const r = await req('PATCH', `/api/chats/${encodeURIComponent(id)}`, { workflow: wf });
    return out(r.workflow || null);
  }
  if (sub === 'workflow-run' || sub === 'workflow-stop') {
    const id = args[1];
    if (!id) throw new Error(`用法：bt ${sub} <chatId>`);
    return out(
      await req('POST', `/api/chats/${encodeURIComponent(id)}/workflow`, {
        action: sub === 'workflow-run' ? 'run' : 'stop',
      })
    );
  }
  if (sub === 'providers') {
    const r = await req('GET', '/api/providers/custom');
    const list = (r.providers || []).map(
      (p) =>
        `- ${p.name} [${p.id}]  ${p.baseUrl}  ${p.style}  ${(p.models || []).length} 个模型${
          p.hasKey ? '  Key✓' : '  无 Key'
        }`
    );
    return out(list.length ? list.join('\n') : '还没有保存的直连 API 提供商');
  }
  if (sub === 'models') {
    const [m, st] = await Promise.all([
      req('GET', '/api/models'),
      req('GET', '/api/bootstrap'),
    ]);
    const blocks = [];
    const labels = {
      opencode: 'OpenCode',
      codex: 'Codex (ChatGPT)',
      agy: 'Antigravity (Google)',
      claude: 'Claude',
      qoder: 'Qoder',
      codebuddy: 'WorkBuddy / CodeBuddy',
    };
    for (const [backend, list] of Object.entries(m || {})) {
      if (!Array.isArray(list) || !list.length) continue;
      blocks.push(
        `[${labels[backend] || backend}] ${list.length} 个可选用\n` +
          list.slice(0, 40).map((x) => `  - ${x}`).join('\n')
      );
    }
    const bots = (st.bots || []).map(
      (b) =>
        `  - ${b.name}  ${b.backend}${b.model ? ` / ${b.model}` : '（默认模型）'}${
          b.billing === 'payg' ? '  [按量计费]' : b.billing ? `  [${b.billing}]` : ''
        }`
    );
    return out(`${blocks.join('\n\n')}\n\n当前 Bot 选型：\n${bots.join('\n')}`);
  }
  if (sub === 'new-bot') {
    const rest = args.slice(1);
    let backend = '';
    let model = '';
    let provider = '';
    const words = [];
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--backend') {
        backend = rest[++i] || '';
        continue;
      }
      if (rest[i] === '--model') {
        model = rest[++i] || '';
        continue;
      }
      if (rest[i] === '--provider') {
        provider = rest[++i] || '';
        continue;
      }
      words.push(rest[i]);
    }
    const name = words.shift();
    if (!name)
      throw new Error(
        '用法：bt new-bot <名字> [岗位说明] [--backend codex|opencode|agy|custom] [--model 模型] [--provider deepseek]'
      );
    const body = { name, persona: words.join(' ') };
    if (backend) body.backend = backend;
    if (model) body.model = model;
    if (provider) body.provider = provider;
    return out(await req('POST', '/api/bots', body));
  }
  if (sub === 'new-group') {
    const title = args[1];
    if (!title) throw new Error('用法：bt new-group <群名> <成员1、成员2...>');
    const names = args
      .slice(2)
      .join(' ')
      .split(/[、,，\s]+/)
      .map((x) => x.trim())
      .filter(Boolean);
    const st = await req('GET', '/api/bootstrap');
    const bots = st.bots || [];
    const ids = [];
    const missing = [];
    for (const n of names) {
      const bot =
        bots.find((b) => b.name === n) ||
        bots.find((b) => b.name.includes(n)) ||
        bots.find((b) => n.includes(b.name));
      if (bot && !ids.includes(bot.id)) ids.push(bot.id);
      else if (!bot) missing.push(n);
    }
    if (!ids.length) throw new Error(`没有找到成员：${names.join('、') || '（空）'}`);
    const chat = await req('POST', '/api/chats', {
      type: 'group',
      title,
      botIds: ids,
      leadId: ids[0],
    });
    return out({ ...chat, missing });
  }
  if (sub === 'workflow-pause') {
    const id = args[1];
    if (!id) throw new Error('用法：bt workflow-pause <chatId>');
    return out(
      await req('POST', `/api/chats/${encodeURIComponent(id)}/workflow`, { action: 'pause' })
    );
  }
  if (sub === 'workflow-resume') {
    const id = args[1];
    if (!id) throw new Error('用法：bt workflow-resume <chatId>');
    return out(
      await req('POST', `/api/chats/${encodeURIComponent(id)}/workflow`, { action: 'resume' })
    );
  }
  if (sub === 'workflow-export') {
    const id = args[1];
    if (!id) throw new Error('用法：bt workflow-export <chatId>');
    return out(await req('POST', `/api/chats/${encodeURIComponent(id)}/workflow/export`, {}));
  }
  if (sub === 'workflow-drain') {
    const id = args[1];
    if (!id) throw new Error('用法：bt workflow-drain <chatId> [--node id] [原因]');
    let nodeId = '';
    const words = [];
    for (let i = 2; i < args.length; i++) {
      if (args[i] === '--node') {
        nodeId = args[++i] || '';
        continue;
      }
      words.push(args[i]);
    }
    return out(
      await req('POST', `/api/chats/${encodeURIComponent(id)}/workflow`, {
        action: 'drain',
        nodeId,
        reason: words.join(' '),
      })
    );
  }
  if (sub === 'skill-install') {
    let url = '';
    let targetType = '';
    let targetId = '';
    for (let i = 1; i < args.length; i++) {
      if (args[i] === '--bot') { targetType = 'bot'; targetId = args[++i] || ''; continue; }
      if (args[i] === '--group' || args[i] === '--chat') { targetType = 'group'; targetId = args[++i] || ''; continue; }
      if (args[i] === '--role') { targetType = 'role'; targetId = args[++i] || ''; continue; }
      if (!url) url = args[i];
    }
    if (!url || !targetType || !targetId) {
      throw new Error('用法：bt skill-install <github-url> --bot <botId> | --group <chatId> | --role <roleId>');
    }
    return out(
      await req('POST', '/api/skills/install', { url, targetType, targetId })
    );
  }
  if (sub === 'permission') {
    const botId = args[1];
    const mode = args[2];
    if (!botId || !['full', 'workspace', 'custom'].includes(mode))
      throw new Error('用法：bt permission <botId> <full|workspace|custom>');
    return out(
      await req('PATCH', `/api/bots/${encodeURIComponent(botId)}`, { permission: { mode } })
    );
  }

  throw new Error(`未知命令：${sub}（bt help 查看用法）`);
}

main().catch((e) => {
  console.error(String(e?.message || e));
  process.exit(1);
});
