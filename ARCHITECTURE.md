# Bot Team 完整技术说明（给优化用）

> 版本：`0.1.0` ｜ 记录时间：2026-11-08（2026-11-11 对齐代码） ｜ 平台：macOS（Electron，arm64）
>
> 这份文档面向准备接手优化的 agent / 工程师。它描述**当前实现**，不是产品宣传稿：
> 包括进程模型、数据格式、请求链路、提示词结构、工作流/定时任务引擎、全部 API、已知限制和可优化点。
>
> 源码根目录：`~/bot-team`（你克隆下来的源码目录）
>
> 运行中的数据目录（桌面版）：`~/Library/Application Support/Bot Team/`
> 桌面版端口由系统分配（每次启动可能不同）；命令行模式默认 `4820`。

---

## 0. 一页速览

| 项 | 内容 |
| --- | --- |
| 产品形态 | 本地多 Bot 工作台（Electron + 内置 HTTP 服务 + 单页前端） |
| 核心能力 | 多 Bot 对话、群聊协作、Bot 互转（delegate）、项目隔离、持续运行、群流程图、定时任务、用量统计、手机远程 |
| 模型接入 | `opencode` / `codex` / `agy` / `codebuddy` / `qoder` / `claude` 六个 CLI 后端 + `custom` 直连 API |
| 前端 | 原生 JS 单页（`public/app.js` 约 15.1k 行）+ SSE 实时推送，无框架、无构建 |
| 后端 | `server.mjs` 约 5.8k 行（HTTP + SSE + 业务编排），`lib/*.mjs` 为领域模块 |
| 存储 | JSON 文件（`data/state.json`）+ JSONL 用量事件 + 每 Bot/每群的文件目录 |
| 进程 | Electron 主进程启动 `server.mjs`（in-process），窗口加载 `http://127.0.0.1:<随机端口>` |
| 鉴权 | 本机请求免 token；非本机必须带 `token`（query 或 Cookie），API Key 只存本地 |
| 运行前提 | 对应 CLI 已安装并登录；`custom` 需要 Base URL 和 API Key |

---

## 1. 进程模型与启动流程

```
Electron main (electron/main.mjs)
  ├─ fixPath()                 补全登录 shell 的 PATH（Finder 启动时 PATH 很短）
  ├─ app.getPath('userData')   → process.env.BOT_TEAM_HOME
  ├─ import('../server.mjs')   同一进程内启动 HTTP server（port=0 随机端口）
  └─ BrowserWindow.loadURL('http://127.0.0.1:<port>')
        └─ public/index.html + app.js + styles.css
              ├─ EventSource('/api/events') 接收 SSE
              └─ fetch('/api/*') 调用后端
```

要点：

- **单实例锁**：`app.requestSingleInstanceLock()`，重复启动会聚焦已有窗口。
- **退出**：`window-all-closed` 直接 `app.quit()`；`before-quit` 调 `killActiveChildren()` 杀掉正在跑的 CLI 子进程。
- **PATH 修复**：`fixPath()` 会执行登录 shell 取 `$PATH`，并补充 `~/.local/bin`、`~/.opencode/bin`、nvm、Homebrew 等目录。
- **数据根目录**：`BOT_TEAM_HOME`。桌面版是 userData；命令行模式回退到项目根目录（`lib/store.mjs` 的 `ROOT`）。
- **服务监听**：`startServer({ host = '0.0.0.0' })`。非本机访问必须提供 token；`/m` 是手机端页面。
- **单进程并发模型**：Node 事件循环 + 大量 `async`。每个聊天一条串行队列（`enqueue`），每个 Bot 另有串行队列（`queueBotRun`）。

### 启动时的自动修复

`server.mjs` 启动阶段（以及 `loadState`）会做一批数据迁移/修复：

- 老数据 `chat.workflow` → `chat.workflows[] + activeWorkflowId`
- 私聊里把老板消息误记成领导的消息 → 改回 `senderId='user'`
- 修复历史模型列表 `"[object Object]"`
- 角色/头像/Bot 计费来源/权限默认值补齐
- 上次进程退出时仍标记 `running/draining` 的工作流 → `paused`，并通知领导 Bot 审查
- 定时任务 `lastStatus='running'` → `interrupted`；重算 `nextRunAt`，错过的执行不补跑
- 恢复 `chat.loop` 的持续运行

---

## 2. 目录与文件地图

```
bot-team/
├─ package.json               Electron/electron-builder 配置、脚本
├─ server.mjs                 HTTP 服务、SSE、路由、工作流引擎、定时任务、远程、模型列表
├─ electron/
│  ├─ main.mjs                主进程：窗口、菜单、PATH、单实例、MiMo 登录、开机自启 IPC
│  └─ preload.cjs             暴露 desktop IPC（打开数据目录、登录项、MiMo 登录等）
├─ lib/
│  ├─ store.mjs               状态读写、目录、默认值、种子数据、权限/来源、按群建项目
│  ├─ orchestrator.mjs        核心编排：目标选择、提示词、单轮执行、转交、压缩、工作流单节点
│  ├─ agents.mjs              7 种后端 runner、子进程执行、超时/中止、会话恢复、直连工具循环、子进程台账
│  ├─ editor-bridge.mjs       右侧编辑器直连：注册会话、下发操作、等待前端回执
│  ├─ translate.mjs           翻译 / 解释 / 改写 / 总结（免费引擎或借 Bot 的 API）
│  ├─ usage.mjs               用量事件、OpenCode 历史重建、汇总/明细/余额、提供商定义
│  ├─ history.mjs             后端用量归一化、OpenCode 会话库重建
│  ├─ pricing.mjs             模型价格表（人民币/百万 token，DeepSeek 峰谷价）
│  ├─ opencode-history.mjs    读取 OpenCode 本地会话 DB
│  ├─ antigravity.mjs         Antigravity 额度卡片
│  ├─ mimo-sync.mjs           MiMo 余额同步
│  ├─ browser-cookies.mjs     读取本机浏览器 Cookie（给内置浏览器/抓取用）
│  ├─ bt-cli.mjs              管理 CLI（领导 Bot 通过 shell 调用）
│  ├─ wf-export.mjs           流程图导出 HTML
│  ├─ flow-rules.mjs          流程设计默认规则（提示词）
│  ├─ asr_worker.py           视频转写 worker（ffmpeg + 本地/云端 ASR）
│  ├─ office_edit.py          Word / Excel / PPT 原生格式读写
│  ├─ pdf_edit.py             PDF 文字块读取与改写（bbox / 替换 / 追加）
│  └─ bot-team-admin.md       领导 Bot 的管理手册（运行时读取）
├─ public/
│  ├─ index.html              桌面端骨架
│  ├─ app.js                  前端全部逻辑（约 15.1k 行）
│  ├─ styles.css              全部样式（约 6.4k 行）
│  ├─ mobile.html             手机端（约 394 行）
│  ├─ markdown.js / vendor/   Markdown、代码高亮等
│  ├─ avatars/ wallpapers/ sounds/
│  └─ start.html
└─ build/ release/            图标、打包产物
```

运行时数据：

```
<BOT_TEAM_HOME>/
├─ data/
│  ├─ state.json              全部业务状态（Bot、聊天、消息、流程、定时任务……）
│  ├─ usage-events.jsonl      用量事件（一行一条 JSON）
│  ├─ uploads/                上传的头像/壁纸/附件
│  ├─ agy-profiles/           每个 Google 账号独立的 HOME
│  └─ .opencode-usage-sync.json  OpenCode 历史同步标记
├─ bots/<botId>/
│  ├─ memory.md               长期记忆（只有该 Bot 注入）
│  ├─ workspace/              CLI 的 cwd
│  └─ group-files/            群文件同步副本 + .sync.json 同步清单
└─ groups/<chatId>/files/     群文件原始存储
```

---

## 3. 数据模型（`state.json`）

`loadState()` 会做默认值合并和迁移。顶层结构：

```jsonc
{
  "self": { "name": "我", "emoji": "🥚", "color": "#f0f0f0" },
  "settings": {
    "leaderId": "bot_x",            // 领导 Bot；群聊里老板消息以它名义发出
    "wallpaper": true,
    "theme": "dark",                 // dark | light（整套界面主题）
    "wallpaperFile": "/wallpapers/cozy-room.webp",
    "voice": { "enabled": true, "address": "主人", "style": "…" },
    "notifySound": true,
    "sound": "reply",               // reply | soft | chime
    "fastMode": false,              // 极速模式：auto 努力度→low + 压缩上下文
    "flowRetries": 3,               // 流程环节失败重试次数；-1 = 一直重试
    "flowNodeMinutes": 30,          // 流程单环节时长上限（分钟）；0 = 不限
    "creditPlans": {                // Qoder / WorkBuddy 积分折算
      "qoder": { "pricePerCredit": 0.072 },
      "codebuddy": { "pricePerCredit": 0.072, "tokensPerCredit": 31874 }
    },
    "remoteAuto": false,            // 开机/启动自动开远程隧道
    "remoteToken": "…",             // 远程访问 token
    "order": { "groups": [], "bots": [] },
    "rolesSeeded": 1,
    "version": 2
  },
  "bots": [ /* Bot[] */ ],
  "chats": [ /* Chat[] */ ],
  "messages": { "chat_x": [ /* Message[] */ ] },
  "roles": [ /* Role[] */ ],
  "agyProfiles": [ { "id": "default", "name": "…", "home": "" } ],
  "deleted": [ /* 墓碑，用量面板保留历史 */ ],
  "schedules": [ /* Schedule[] */ ],
  "skillMeta": {
    "baoyu-cover-image": {          // 运行时 AI 生成的大白话说明（静态同名文件优先兜底）
      "what": "生成文章封面图", "when": "发文前需要封面时",
      "pros": "多种风格", "cons": "需多试几次",
      "descHash": "…", "source": "ai", "model": "deepseek-flash", "at": 0
    }
  },
  "providerKeys": {
    "custom:deepseek": "sk-…",      // 直连提供商 Key
    "botapi:bot_x": "sk-…"          // 单个 Bot 的直连 Key
  },
  "customProviders": [
    { "id": "deepseek", "name": "DeepSeek", "style": "openai",
      "baseUrl": "https://api.deepseek.com/v1", "models": ["deepseek-flash"] }
  ]
}
```

### 3.1 Bot

```jsonc
{
  "id": "bot_x",
  "name": "工人",
  "emoji": "🙂",
  "color": "#6c5ce7",
  "backend": "opencode|codex|agy|codebuddy|qoder|claude|custom",
  "model": "opencode-go/gpt-5.6-luna",
  "source": "OpenCode Go",          // 计费来源（订阅/按量）
  "billing": "subscription|payg|free",
  "persona": "岗位说明",
  "skills": ["ui-ux-pro-max"],        // Bot 级技能（和职位/群技能取并集）
  "permission": { "mode": "workspace|full|custom", "read": [], "write": [] },
  "roleId": "role_frontend|null",
  "agyProfile": "default",
  "showRoleAbbr": true,
  "quota": "手动额度文案",
  "hidden": false,
  "codexFast": true,                // codex --ignore-user-config
  "timeoutMin": 0,                  // 单次执行超时（0=不限）
  "api": {                          // 仅 claude/codex/custom 使用
    "mode": "official|custom",
    "style": "openai|anthropic",
    "baseUrl": "https://…",
    "models": ["…"]
  },
  "memory": "长期记忆",
  "avatar": "🐱",
  "sessions": {
    "chat_x": { "id": "cli-session-id", "backend": "opencode",
                 "lastInput": 12345, "calls": 3 }
  },
  "usage": { "calls": 0, "input": 0, "output": 0, "total": 0,
             "updatedAt": 0, "days": { "2026-11-08": { "calls": 1, "total": 123 } } },
  "createdAt": 0,
  "lastChatId": "chat_y",
  "alert": { "type": "permission|decision|error", "text": "…", "chatId": "…" } | null
}
```

> `publicBot()` 返回给前端时会补 `quota`、`quotaOverride`、`memory`、`usage`，并隐藏 `providerKeys`（只返回 `api.hasKey`）。

### 3.2 Chat（群聊 / 私聊项目）

```jsonc
{
  "id": "chat_x",
  "type": "group|dm",
  "title": "作战室",
  "project": "默认项目",              // 仅 dm
  "linkedGroupId": "chat_g",          // 仅 dm：与哪个群共享记忆/公告/文件
  "botIds": ["bot_a", "bot_b"],
  "leadId": "bot_b",                  // 默认接单成员
  "effort": "auto|low|medium|high",
  "permission": { "mode": "…", "read": [], "write": [] },
  "roleIds": { "bot_a": "role_x" },   // 群内按 Bot 分配职位
  "announcement": "群公告",
  "skills": ["baoyu-cover-image"],    // 群级技能；该群成员及其关联项目共用
  "files": [ { "name": "日志.md", "file": "日志.md", "size": 123, "at": 0 } ],
  "log": [ { "ts": 0, "botId": "bot_a", "action": "回复", "text": "…" } ],
  "createdAt": 0,
  "updatedAt": 0,

  "loop": false,                      // 持续运行
  "loopRound": 0,
  "loopTargetId": "bot_a",
  "loopPrompt": "…",
  "draining": false,
  "drainNote": "…",

  "contextSummary": "压缩后的摘要",
  "compactedAt": 0,
  "compactedCount": 42,

  "workflow": { /* Workflow，当前流程 */ },
  "workflows": [ /* Workflow[]，一个群可存多条 */ ],
  "activeWorkflowId": "wf_x"
}
```

补充：

- 每个群会为**每个非领导成员**自动建一个 `dm` 项目（`linkedGroupId=群id`），群里的过程/交付会镜像到对应项目页（`ensureGroupProjects`）。
- 领导的私聊项目不自动创建；领导通过 `lastChatId` 记住上次项目。

### 3.3 Message

```jsonc
{
  "id": "msg_x",
  "chatId": "chat_x",
  "type": "text|process|system|handoff",
  "senderId": "user|system|bot_x",
  "toId": "bot_y|null",
  "text": "内容",
  "attachments": [ { "url": "/uploads/files/x.png", "name": "x.png",
                     "mime": "image/png", "size": 123 } ],
  "meta": {
    "quota": "OpenCode Go",
    "usage": { "input": 0, "output": 0, "total": 0, "cache": {} },
    "thinking": "推理内容",
    "handoff": true, "parallel": true, "merge": false,
    "fromNode": "步骤 1", "toNode": "步骤 2",
    "fromBot": "甲", "toBot": "乙",
    "viaUser": true,                 // 群聊里老板消息以领导名义发出
    "mirrored": true, "groupTitle": "…"
  },
  "ts": 0
}
```

消息不做分页存储，全部放在 `state.messages[chatId]` 数组里；搜索/摘要/最近对话都直接扫描数组。

### 3.4 Workflow / WorkflowNode

```jsonc
{
  "id": "wf_x",
  "name": "示例群 流程",
  "status": "draft|running|paused|draining|done|stopped|error",
  "startNodeId": "wfn_1",
  "maxSteps": 50,                     // 0=不限；范围 1..200
  "nodes": [ /* Node[]，最多 30 个 */ ],
  "history": [ { "nodeId": "…", "title": "…", "botId": "…", "ok": true,
                  "text": "…", "error": "", "at": 0, "parallel": false } ],
  "resume": {                         // 断点
    "nodeId": "wfn_5",
    "input": "上一环节交接内容（最多 12000 字）",
    "fromNodeTitle": "…", "fromBotName": "…",
    "pending": [ /* 未上传产物 */ ],
    "steps": 34, "at": 0
  },
  "currentNodeId": "wfn_5|null",
  "pausedByUser": false,
  "lastError": "",
  "startedAt": 0, "finishedAt": 0,
  "reportInFlight": false,            // 停止审查防重入
  "lastStopReportAt": 0,
  "lastStopStatus": "done|error|…",
  "createdAt": 0, "updatedAt": 0
}
```

Node：

```jsonc
{
  "id": "wfn_1",
  "title": "步骤 1",
  "botId": "bot_x",
  "model": "",                        // 覆盖该环节模型；空=用 Bot 默认
  "task": "本环节要做什么",
  "role": "collector|uploader|normal",// 决定 pending 产物是否清空、收尾选谁
  "nextMode": "next|branch|merge|loop|end|", // 仅前端提示，执行依赖 next/parallel
  "parallel": { "targets": ["wfn_2", "wfn_3"], "joinTo": "wfn_4" } | null,
  "stopWhen": "命中这个词就结束整个流程",
  "allowEnd": false,                  // 允许输出 @@FLOW_END 结束流程
  "next": [ { "to": "wfn_2|__end__",
               "when": "always|success|error|keyword",
               "keyword": "" } ]      // 最多 8 条，按顺序取第一条命中
}
```

### 3.5 Schedule（定时任务）

```jsonc
{
  "id": "sch_x",
  "chatId": "chat_x",
  "title": "每日进度汇总",
  "prompt": "到点发给 Bot 的内容（最多 4000 字）",
  "kind": "daily|weekly|interval|once",
  "time": "09:30",                    // daily/weekly
  "weekdays": [1, 2, 3, 4, 5],        // weekly；0=周日
  "every": 60, "unit": "minute|hour", // interval；every 1..10080
  "at": 0,                            // once 的时间戳
  "enabled": true,
  "nextRunAt": 0,
  "lastRunAt": 0,
  "lastStatus": "|running|ok|error|missed|interrupted",
  "lastError": "",
  "createdAt": 0, "updatedAt": 0
}
```

### 3.6 Role

```jsonc
{
  "id": "role_frontend",
  "abbr": "前端",
  "name": "前端工程师",
  "emoji": "🖥️",
  "builtin": true,
  "persona": "岗位说明（会给到该职位所有 Bot）",
  "memory": "职位级长期记忆（会拼在 Bot 自己的记忆前面）",
  "skills": ["ui-ux-pro-max"]
}
```

### 3.7 用量事件（`usage-events.jsonl`）

每行一个 JSON：

```jsonc
{
  "ts": 0, "kind": "chat|workflow|compact|opencode-db|backfill",
  "botId": "bot_x", "botName": "…", "backend": "opencode", "model": "…",
  "source": "…", "billing": "…",
  "chatId": "…", "chatType": "group|dm",
  "groupId": "…", "groupTitle": "…", "projectTitle": "…",
  "input": 0, "output": 0, "reasoning": 0,
  "cacheRead": 0, "cacheWrite": 0, "cacheIncluded": false,
  "total": 0, "calls": 1,
  "credits": 0, "creditUnit": "积分", "creditsEstimated": false
}
```

读取时有两层去重（`lib/usage.mjs#readUsageEvents`）：

1. 同 Bot + 5 秒桶 + 同 total + 同 kind 视为重复（群聊与项目页镜像写入）。
2. 有 `opencode-db` 事件时，丢弃 5 分钟内同 Bot 同 total 的实时事件，以数据库重建为准。

---

## 4. 概念模型

- **Bot**：一个 AI 员工，绑定一个后端 + 模型 + 权限 + 记忆 + 职位。
- **Chat / 会话**：`group` 群聊，或 `dm` 私聊/项目。每个 Bot × 每个群有一个关联项目（`dm.linkedGroupId`）。
- **领导 Bot**：`settings.leaderId`。群聊里老板的消息会以领导名义发出（`viaUser`）；领导默认加入所有群，但不占默认接单位。
- **默认接单成员**：`chat.leadId`。群里不 @ 时只有它回复；@谁谁回；@所有人 才全员回复。
- **职位（Role）**：可复用的岗位说明 + 职位记忆 + 技能列表；群内可按 Bot 覆盖。
- **工作流**：群里的多步骤流水线，一个群可保存多条，但同时只能跑一条。
- **定时任务**：按时间向某个会话注入一条“老板消息”。
- **持续运行（loop）**：群聊里一轮接一轮自动推进，直到 `/stop` 或 `@@DONE`。

---

## 5. 单条消息的完整链路

### 5.1 入口

`POST /api/chats/:id/messages`（前端发送、定时任务、CLI 都用这条链路）：

1. 校验 `text` / `attachments`（附件必须是 `/uploads/files/…`）。
2. 若以 `/` 开头，先处理内置命令：
   - `/loop`：开启持续运行（仅群聊）
   - `/stop`：停止持续运行并中断当前执行
   - `/clear`：清空消息、摘要、所有 Bot 在该会话的 session
   - `/compact`：手动压缩上下文
3. 普通消息 → `dispatchChatTurn(chat, text, attachments, context, selection)`。
   - `context`：当前右侧面板内容（网页文字或文件摘录），最多 20000 字。
   - `selection`：用户刚在面板里选中的内容；有它时优先使用，不再重复附带整份文件。
   - 两者都不写进用户气泡，只在 `runTurn` 里追加到任务提示词。

`dispatchChatTurn`：

```js
// 1) 先把老板的消息落盘并推给前端（否则排队期间“插话”会整条不可见）
const userMsg = addMessage(state, chat.id, { senderId, text, attachments, meta });
saveState(state); emit('message', { chatId: chat.id, message: userMsg });

// 2) 再按会话串行执行
enqueue(chat.id, async () => {
  const ctrl = new AbortController();
  runAborts.set(chat.id, ctrl);
  try { await runTurn({ ..., preRecorded: true, uptoId: userMsg.id }); }
  finally {
    runAborts.delete(chat.id);
    emit('bots'); emit('chats');
    if (chat.loop) scheduleLoop(chat, 2500);
  }
});
```

`preRecorded` 让 `runTurn` 不再重复写消息；`uptoId` 把「最近对话」截到这条消息为止，避免排队中的后续插话提前进入上一轮的提示词。

`enqueue` 是**按聊天串行**的 Promise 链（`server.mjs#enqueue`）。`queueBotRun` 是**按 Bot 串行**的另一条链。两个队列共同保证：同一会话不并发、同一 Bot 不并发。

### 5.2 `runTurn`：决定谁回复

`lib/orchestrator.mjs#runTurn`：

1. 群聊无成员 → 系统提示后返回。
2. 非 `auto` 时先写入用户消息（群聊里 `senderId=leader.id` 且 `meta.viaUser=true`）。
3. 处理“读取其他项目”指令（`@@OPEN 项目名@@` 等，`collectReadProjects`）。
4. 目标选择优先级：
   - `auto && chat.loopTargetId` → 只给持续运行目标
   - `@所有人` / `@all` → 除领导外全员，默认接单成员先回，其余成员随后
   - 消息里 @ 了具体 Bot → 只给这些 Bot
   - 群里出现“新建/创建 Bot、群”意图 → 交给领导
   - 群聊普通消息 → `chat.leadId`（默认接单成员）
   - 私聊 → 唯一的 Bot
5. 对每个目标**并行**执行 `runTurnInternal`（`Promise.allSettled`；`@@SEND` 等跨会话发送也在这里发生）。
6. 回合结束 → `maybeCompact()`。

### 5.3 `runTurnInternal`：单 Bot 一轮

`lib/orchestrator.mjs#runTurnInternal` 关键步骤：

```
syncGroupFiles(群文件同步)
  ↓
buildPrompt(稳定前缀 + 本轮上下文 + 任务)
  ↓
session 检查（超过轮数/输入 token → 删除会话，开新会话）
  ↓
queueBotRun(同一个 Bot 串行)
  ↓
runBot(agents.mjs 对应 runner)
  ↓
记录 session / usage / 事件
  ↓
解析 @@BROWSER → 执行浏览器 → 带着页面正文再跑一轮（最多 4 次）
  ↓
解析 @@SEND / @@CREATE / @@DRAIN / @@DELEGATE / @@DONE
  ↓
写消息：群聊只写最终交付；过程写关联项目；执行步骤/思考写 process
  ↓
如果有 @@DELEGATE → 递归 runTurnInternal 给下一位同事（最多 10 跳）
```

- `MAX_HOPS = 10`，超过会提示直接 @ 对方。
- `MAX_BROWSER_STEPS = 4`。
- 群聊里的过程消息（`process`）只在关联项目里展示，群聊留最终结果；但“开始处理/执行步骤/思考”会通过 `addProcess` 写到项目页。
- **私聊里被委派的 Bot**：`processChatFor()` 会把过程（开始处理、执行步骤、思考）、交接记录和最终交付都镜像到该 Bot 自己的项目，不再只留在发起人的聊天窗里。
- 失败/需要授权时设置 `bot.alert`，左侧头像红点。

### 5.4 群聊回复规则（与实现一致）

- 不 @：`chat.leadId` 回复
- `@名字`：被 @ 的 Bot 回复（支持名字容错：大小写、空格、emoji 前缀）
- `@所有人`：除领导外全员回复，默认接单成员先回，其余成员随后
- 领导的 `@@DELEGATE 名字@@ 任务`：自动转交给同事并继续
  - **私聊里**是异步的：任务会排到被委派 Bot 自己的项目执行，发起人的聊天窗立刻恢复可用，完成后把最终交付回报过来（不再让领导一等几十分钟）。
  - **群聊里**仍然是内联接力，保证工作流和群流程的顺序。
- `@@SEND 目标1、目标2@@ 内容`：跨群/跨 Bot 发消息
- `@@CREATE BOT 名字@@ 岗位` / `@@CREATE GROUP 群名@@ 成员`：领导建人/建群
- `@@DRAIN 群名@@ 要求`：让目标群进入收尾模式
- `@@DONE`：结束该群的持续运行
- `@@BROWSER open|read|click|type|back|forward`：内置浏览器操作（一次一条）
- `@@FLOW_PAUSE` / `@@FLOW_TAKEOVER` / `@@FLOW_RETRY`：流程内控（暂停、接管、重试），仅在流程环节里解析

---

## 6. 提示词组装与缓存（性能重点）

入口：`lib/orchestrator.mjs#buildPrompt`，分两种模式：

- **普通聊天**（`lean=false`）：完整身份、规则、记忆、摘要、最近对话、群日志、团队状态、附件、任务。
- **流程环节**（`lean=true`）：轻量模式，只带岗位、记忆（≤800 字）、群公告、群文件和工作流任务，不带最近聊天/群日志/团队状态。

### 6.1 稳定前缀设计（为前缀缓存）

提示词按「稳定 → 易变」排序，中间有固定分隔符：

```
【稳定段】
  身份 / 岗位 / 个人补充 / 可用技能（职位+Bot+群取并集）/ 称呼风格
  权限 / 同事 / 计费提醒 / 群信息或私聊说明
  管理员权限（领导）/ 领导规则 / 工作纪律 / 输出习惯 / 浏览器说明
  长期记忆 / 对话摘要 / 群公告
【本轮上下文】        ← CTX_MARK，固定字符串
  最近对话 / 团队实时状态 / 群文件 / 群日志 / 关联群公告 / 收尾模式 / 附件
老板对你说：
  当前任务
```

- `CTX_MARK = '【本轮上下文】'`，`lib/agents.mjs` 里有一份同样的常量。
- **Anthropic 直连**：稳定段作为单独的 `text` block，带 `cache_control: {type:'ephemeral'}`；`system` 也带 `cache_control`。第二轮起可直接命中前缀缓存。
- **OpenAI 兼容 / DeepSeek**：依赖提供商自动前缀缓存，稳定段在前即可。
- 改动 Bot 岗位、职位、群公告、记忆会使前缀变化一次，之后重新命中。

### 6.2 长度与截断

| 内容 | 普通聊天 | 极速模式 | 流程环节 |
| --- | --- | --- | --- |
| 长期记忆 | 2400 字 | 600 字 | 800 字 |
| 对话摘要 | 2000 字 | 不注入 | 不注入 |
| 最近对话 | 8 条 × 400 字 | 4 条 × 200 字 | 不注入 |
| 群公告 | 1500 字 | 1500 字 | 4000 字 |
| 群日志 | 最近 12 条（极速模式不注入） | 不注入 | 不注入 |
| 团队实时状态 | 领导且非极速 | 不注入 | 不注入 |
| 群文件摘录 | 不注入 | 不注入 | 最多 3000 字，每个文件最近 1400 字 |

### 6.3 重复计算缓存

- `groupFileDigest`：按 `chat.id + 每个文件 size/mtime` 缓存摘录。
- `buildTeamStatus`：`WeakMap<state>` + 5 秒缓存。
- `syncGroupFiles`：`group-files/.sync.json` 记录 `size:mtime`，未变化不复制。
- 这些缓存都在模块内存里，进程重启即失效。

### 6.4 会话与轮换

`sessionPolicy(bot)`：

| 后端 | maxCalls | maxInput |
| --- | --- | --- |
| codex | 10 | 120,000 |
| agy | 12 | 180,000 |
| 其他 | 14 | 220,000 |

- 会话 key：`chat.linkedGroupId || chat.id`（私聊项目共享所属群的 session）。
- 超过 `maxCalls` 或 `maxInput` → 删除 session，开新会话；摘要和最近对话仍会注入。
- **流程环节**：`runWorkflowNode` 每次都传 `sessionId: null`（独立会话），见优化点。
- 压缩：`maybeCompact` 在新增 ≥10 条、距上次压缩 ≥2 分钟、估算 ≥50,000 tokens 时触发；摘要 ≤2000 字，之后清空所有相关 session。

---

## 7. 后端适配层（`lib/agents.mjs`）

`runBot()` 按 `bot.backend` 分派。所有 runner 都返回统一结构：

```js
{ text, reasoning, sessionId, usage, steps, timedOut, durationMs, code, err,
  streamedSteps?, streamedThinking?, aborted? }
```

| backend | 命令 | session | 备注 |
| --- | --- | --- | --- |
| opencode | `opencode run --format json --dir <cwd> [-m model] [-s sid] [--variant effort] [--auto] <prompt> [-f 附件]` | `-s` | 逐行 JSON；`step_finish` 汇总 token；`--auto` 仅 full 权限 |
| codex | `codex exec [resume <sid>] --json --skip-git-repo-check [--ignore-user-config] [-m model] [-c model_reasoning_effort=…] -c model_auto_compact_token_limit=120000 [sandbox flags] [--image=…] <prompt>` | `resume` | 支持自定义 provider（`-c model_provider=…`，Key 走 `BT_CUSTOM_API_KEY` 环境变量） |
| agy | `agy -p <prompt> --output-format json --add-dir <cwd> [--conversation sid] [--model] [--effort] [权限 flags]` | `--conversation` | 每个 Google 账号独立 HOME |
| codebuddy | `codebuddy -p --output-format json [-m] [-r sid] [--permission-mode bypassPermissions\|acceptEdits] [--add-dir] [--attachment] <prompt>` | `-r` | WorkBuddy / CodeBuddy |
| qoder | `qoderclicn -p --output-format json [-m] [-r sid] [--reasoning-effort] [--dangerously-skip-permissions\|--permission-mode accept_edits] [--add-dir] [--attachment] <prompt>` | `-r` | |
| claude | `claude -p --output-format json [--resume sid] [--model] [权限 flags] <prompt>` | `--resume` | 支持 `apiKey` / 自定义 baseUrl |
| custom | HTTP `POST <baseUrl>/v1/chat/completions` 或 `/v1/messages` | 无 | 可选本机工具循环（默认开，`bot.customTools=false` 关闭）；Anthropic 风格支持 `cache_control` |

通用细节：

- `childEnv()` / `resolveCmd()` 负责 PATH 和命令解析；子进程支持 `AbortSignal`、超时、逐行回调。
- 附件：Runner 会把附件复制到 Bot 工作区，再以 CLI 参数传入（codex 用 `--image=`，其他用 `-f/--attachment`）。
- **agy 账号探测不碰钥匙串**：账号名读 `~/.gemini/google_accounts.json`，是否可用看 `agy models` 能否列出模型。以前每 30 秒调一次 `security find-generic-password`，会周期性弹系统钥匙串授权框。
- **多账号 HOME 必须补 Keychains 链接**：agy 换 HOME 后会去 `$HOME/Library/Keychains` 找钥匙串，找不到就弹「找不到用于储存 antigravity 的钥匙串」。`ensureAgyHome()` 会在启动、建号、运行前把链接指到真实用户的 `~/Library/Keychains`。
- `permission`：`workspace` / `full` / `custom`，各 CLI 映射到 sandbox / auto-approve / add-dir。
- `custom` 的 system 消息只放 `bot.persona`，其余全在 user prompt；稳定段在 `【本轮上下文】` 处切分。
- 失败：CLI 完全没输出会 `throw` 或被上层转换；部分输出会保留并标注超时。

> 直连 Bot（`custom`）默认带本机工具循环：
> - OpenAI 兼容：`tools` + `tool_calls` + `role:"tool"` 多轮；Anthropic：`tool_use` / `tool_result`。
> - 工具：`list_dir`、`read_file`、`write_file`、`run_command`、`find_files`；最多 12 轮，命令默认 60s/最长 300s。
> - 编辑器直连（`lib/editor-bridge.mjs`）：`editor_read`、`editor_apply`、`editor_set_cells`、`editor_set_paragraphs`，直接改右侧正在打开的文件；前端通过 `/api/editor/poll` 取操作、`/api/editor/ack` 回执。
> - PDF：`pdf_read`（按页取文字块 + bbox）、`pdf_apply`（bbox 改字 / 文字替换 / 追加），由 `lib/pdf_edit.py` 执行。
> - 路径按 `permission` 限制（workspace/custom/full）；`run_command` 不是 OS 级沙箱。
> - 第一次请求 400/422 且带 tools 时自动退回纯文本模式，兼容不支持 function calling 的接口。
> - `@@FILE` 仍用于让右侧文件查看器展示文件；工具用于 Bot 内部读写/执行。

---

## 8. 工作流引擎

### 8.1 生命周期

```
draft → running → done / paused / stopped / error
```

- `startWorkflow(chat, {resume})`：从 `startNodeId` 或 `wf.resume.nodeId` 开始；设置 `workflowRuns`。
- `pauseWorkflow`：设置 `run.pause`，当前环节做完后暂停，写 `wf.resume`；不触发停止审查（`pausedByUser`）。
- `stopWorkflow`：设置 `run.cancel`，中断子进程；触发停止审查。
- `drainWorkflow`：平滑收尾，当前环节做完后跳到上传/交付环节；不触发停止审查。
- 正常结束（done）、报错（error）、命中停止条件、达到 maxSteps、`@@FLOW_END`、启动时发现中断 → 都会通知领导 Bot 审查（`notifyLeaderWorkflowStop`）。
- 审查写入领导的最新 DM 项目；只用 `reportInFlight` 防重入，没有时间窗口去重。

### 8.2 执行循环（`server.mjs#runWorkflow`）

- 每步：找节点 → 找 Bot → `runWorkflowNode` → 记录 history → 决定下一节点。
- 每次推进都写 `wf.resume`（下一节点、交接内容、pending 产物、步数）。
- 节点失败：
  - 若配置了 `error` / `always` 边，按边继续；
  - 否则流程 `error`，断点停在当前节点。
- 节点成功：
  - `parallel.targets` ≥ 2 → `Promise.all` 跑分支；
  - 分支进入入度 ≥2 的节点 → 等待所有分支到齐，拼成 `【并行 1/N …】` 交给汇合节点；
  - 汇合后把控制权交回外层循环（避免第二轮走错）。
- 循环：`next.to` 指向前面节点即可回到起点，下一轮继续。
- `run.pending` 记录未上传产物；`role=uploader` 的节点成功后清空。
- `maxSteps` 全局计数（并行分支也计数）；`0` 表示不限。

### 8.3 单节点（`lib/orchestrator.mjs#runWorkflowNode`）

- 使用 `lean=true` 的轻量提示词。
- 工作目录 `bots/<botId>/workspace`，先同步群文件。
- **单环节时长上限**：`settings.flowNodeMinutes`（默认 30，0=不限）；超过就中止并写清原因，避免一个环节闷头跑一小时。Bot 自己的 `timeoutMin` 更短时按更短的算。
- **额度/限流不重试**：错误里出现 429 / quota / 额度 / 余额不足时直接失败上报，不做 5s/15s/30s 三轮退避。
- `node.model` 覆盖模型时用独立 session key（但当前仍传 `sessionId:null`）。
- 失败自动重试：
  - `settings.flowRetries`，默认 3，`-1` = 一直重试；
  - 退避 5s / 15s / 30s / 之后每次 30s；
  - **只有完全没有文本输出才重试**；已有文本不重试，避免重复干活；
  - 超时不重试；
  - 重试成功会写一条系统消息。
- 输出 `@@FLOW_END`（仅 `allowEnd` 节点）或命中 `stopWhen` → 整个流程结束。
- 结果写入群聊 + Bot 关联项目；交接以 `handoff` 消息镜像到双方项目页。

### 8.4 多流程

- `chat.workflows[]` 保存多条，`chat.activeWorkflowId` 指向当前。
- `GET /api/chats/:id/workflows` 列表；`POST` action：`switch / create / duplicate / rename / delete`。
- **运行中禁止切换、新建、复制、删除当前流程**（409）。
- 保存流程时沿用当前流程 id；运行态字段（status/currentNodeId/resume/history）在保存时保留。
- 老数据自动迁移为单元素数组。

### 8.5 流程图导出

- `POST /api/chats/:id/workflow/export` → `lib/wf-export.mjs` 生成 HTML 到桌面（不依赖浏览器渲染）。
- 前端也支持导出 HTML / PNG / PDF（浏览器侧）。

---

## 9. 定时任务

- 存储：`state.schedules[]`，随 `state.json` 持久化。
- 触发：`startScheduleTicker()` → 每 20 秒 `tickSchedules()`；启动后 4 秒先跑一次。
- 目标选择（前端）：先选「群聊」或「Bot 的项目」；选 Bot 后再从该 Bot 的 `dm` 项目里选具体会话。最终提交的仍然是 `chatId`。
- 到点：`fireSchedule(sch)`：
  1. 防止同一任务并发（`scheduleRunning` Set）。
  2. 更新 `lastRunAt/lastStatus`，非手动触发时先算下一次；`once` 跑完自动禁用。
  3. 写系统消息「⏰ 定时任务「xxx」自动执行」。
  4. 通过 `dispatchChatTurn` 发送任务内容（和用户发消息完全同一条链路）。
- 手动执行：`POST /api/schedules/:id/run`；若下一次时间已过会顺延一个周期，避免马上又自动跑。
- 重启：`repairSchedules()` 重算 `nextRunAt`；错过的执行不补跑；`running` → `interrupted`。
- 删除会话时删除对应任务；删除 Bot 导致私聊被删时同样清理。
- 精度：20 秒轮询，最坏延迟约 20 秒；依赖应用进程存活。
- 没有时区配置，使用系统本地时区；没有执行历史（只保留最后一次状态）。

---

## 10. 持续运行（loop）

- 群聊专属；`chat.loop=true` + `loopRound` + `loopTargetId` + `loopPrompt`。
- `scheduleLoop(chat, delay)` 用 `loopTimers` 防重；到时 `enqueue` 一轮 `runTurn({auto:true})`。
- `auto=true` 时不写用户消息；`loopTarget` 优先。
- 结束条件：`/stop`、`@@DONE`、手动停止；`chat.draining` 时使用收尾提示词。
- 应用重启时恢复 `chat.loop`，5 秒后继续。
- 工作流启动会停掉该群的 loop（`/api/chats/:id/workflow` 的 run 分支）。

---

## 11. 用量与成本

- 写入：`recordUsage()` → `data/usage-events.jsonl`（append）。
- 汇总：`summarizeUsage()` / `summarizeUsageDetail()`，按天/来源/模型/项目聚合。
- OpenCode 历史：`syncOpencodeHistory()` 读取本机 OpenCode 会话库，重建 `opencode-db` 事件并合并，避免旧版本漏记。
- 去重：见 3.7。
- 价格：`lib/pricing.mjs`，DeepSeek 区分高峰/空闲；其他模型来自内置表（按 USD≈¥7.2）。
- **积分渠道**：Qoder CLI 返回 `total_credits` / `modelUsage.*.credits`，按真实值记录；WorkBuddy 不返回积分，按 `total tokens / tokensPerCredit` 估算（默认 31,874，可配置）。积分单价默认 ¥0.072/积分，两者都写入事件并折算成「订阅折算」金额。
- 事件字段：`credits`、`creditUnit`、`creditsEstimated`；消息 meta 同步保存，前端在额度行显示 `X 积分 ≈ ¥Y`。
- 余额：`fetchBalances()` 支持 OpenCode、MiMo、DeepSeek、GLM、Kimi、MiniMax、Claude、Google 等（有 Key 才查）。
- 前端：底部「今日 N tokens」与设置里的用量面板共用同一份去重结果。

---

## 12. 前端结构（`public/app.js`）

- 全局可变状态 `S`：`bots/chats/messages/status/settings/models/...`。
- 渲染是手写模板字符串 + `innerHTML`，没有虚拟 DOM。
- SSE 事件：`message`、`bots`、`chats`、`status`、`settings`、`roles`、`cleared`、`browser`、`remote`、`schedules`。
- 主要界面：
  - 侧栏：Bot/群/项目、搜索（⌘K 全局搜索）、设置、职位、定时任务。
  - 会话：消息流、执行过程折叠、文件卡片、Markdown、代码高亮。
  - 输入区：附件、推理强度、模型切换、发送/打断/插话。
  - 弹窗：Bot/群设置、职位、Skills 管理、流程编辑器 v2、用量、设置/状态、定时任务。
  - Skills 管理（左下角 ✦）：按职位/Bot/群聊切换目标；勾选只改本地草稿，点「保存」才 PATCH；右上角 ✕ 关闭不保存。
    - 默认显示 `lib/skill-summaries.json` 的 AI 大白话说明；右键看完整 SKILL.md 描述。
    - 「生成说明」调 `/api/skills/explain` 补全新技能；「从 GitHub 安装」调 `/api/skills/install`。
    - 技能叠加：职位技能（群内职位）+ Bot 技能 + 所在群技能；关联项目只继承所属群的配置，不同群互不串台。
  - 超时：默认 `botTimeoutMs()` 返回 0（不限）；只有 `bot.timeoutMin > 0` 才启用分钟级上限，`-1` 也按不限处理。超时由 `exec()` 杀进程组，`runBot` 汇总已执行步骤抛错，前端拿到可读说明。
  - 并发：`queueBotRun` 的 key 是 `botId::sessionKey`（sessionKey = linkedGroupId 或 chat.id），不同项目可并行，同一项目内串行保护 CLI session。
  - 流程轮次：`wf.round` 随循环边递增（受 maxSteps 保护），`wf.resume.round` 参与续跑；非 resume 启动时归 1。
  - 流程设计规则：默认文本在 `lib/flow-rules.mjs`（`DEFAULT_FLOW_DESIGN_RULES`），领导 Bot 的 `bot.flowDesignRules` 覆盖它；`/api/bootstrap` 返回 `flowRulesDefault`，Bot 设置里可视化编辑。
  - 故障介入：主循环里 `superviseWorkflowFailure()` 在环节失败后调用领导 Bot，解析 `@@FLOW_RETRY / @@FLOW_TAKEOVER / @@FLOW_PAUSE`，最多 3 次、同一环节 1 次。
  - 暂停：`shouldPause` 传进 `runWorkflowNode`，在重试退避前检查，返回 `paused:true`；主循环不再触发领导介入，直接落 `paused`。
  - 轮次：主循环顶部在 `nodeId === startNodeId && steps > 0` 时 +1（`boot.resumed` 跳过首次），并行汇合 `cont` 指回更早节点时也 +1；边缘递增排除 start，避免重复。
  - 用量单日：`summarizeUsage` / `summarizeUsageDetail` 接受 `day`，只对当天累计 totals 和维度排行，`daily` 仍保留整个区间；前端点柱子切换 `S.usageDay`。
  - 进度：`emit('status', {startedAt, preview, step})` 实时推送，前端只更新 `.typing` 块（计时 + 最近 90 字预览），不整页重绘；agy 用 `--output-format stream-json` 解析 text_delta / step_update，Claude Code 用 `stream-json --include-partial-messages` 解析 thinking_delta / text_delta。
  - 思考展示：有 `res.reasoning` 时对话里显示「思考过程」；没有时把 `res.steps` 汇总成「执行过程」（`meta.thinkingKind='steps'`）。
    - 职位弹窗的「项目 / 群」含「所有项目（全局）」：写 `bot.roleId`，`roleForChat()` 在群职位为空时回退到它，因此任何项目/群都生效；群内职位优先覆盖。
  - 数学 / 图表：`markdown.js` 先把 `$$...$$`、`$...$`、`\(...\)`、`\[...\]` 抽成占位符（跳过代码块），marked 解析、DOMPurify 清洗后再用 KaTeX 渲染成 HTML；Mermaid 由 `enhanceMermaid()` 在 #thread 的 MutationObserver 里把 ```mermaid 代码块替换成 SVG。
  - 右侧内置浏览器（webview，独立 `persist:sidebrowser` 分区）。
- 输入框草稿：按 chatId 存 `S.drafts` + `S.attachDrafts`，并持久化到 `localStorage`（`bt.drafts` / `bt.attachDrafts`）；发送成功清空；切换会话恢复。
- 左侧栏只有一个开关按钮（`#collapseSidebar`）：点击切换 `body.sidebar-hidden`，图标旋转；没有会话时顶部仍保留最小切换栏。
- 右侧面板（`.browser-pane`）：
  - `B.mode` 支持 `browser` / `file`；`bt.pane.mode` 持久化。
  - 文件模式支持图片、PDF、音视频、文本/代码、Markdown、JSON、CSV/TSV；Office/二进制走 `/api/files/thumb`（Quick Look）。
  - 文档纸张排版：`.fv-paper > .fv-prose`，`buildProseFragment()` 把行拆成 `<p>`/`<h3>`（第 X 章）/`<h4>`（一、/（一）），宋体 + 首行缩进 2em。
  - 大文本按 20 万字一批渲染，滚动到底自动追加；40MB 以上才退回默认应用。
  - PDF 用本地 vendored `pdfjs-dist`（`public/vendor/pdfjs/`，含 cmaps/standard_fonts）自绘 canvas + TextLayer，支持页码/缩放/适宽/懒加载；文字层是普通 DOM，选中直接走同一套 `selectionchange` → `#selectionTray`。
  - Word（.docx）走本地 vendored `mammoth.browser.min.js` 转 HTML（保留 strong/table/list/img）；旧 .doc/RTF/ODT/Pages 先调 `/api/files/text` 显示文字，失败再退 Quick Look 缩略图。
  - Excel（.xlsx/.xls）走 `xlsx.full.min.js`（SheetJS），`clampSheet()` 限制 1500 行 × 60 列后 `sheet_to_html`，多工作表用顶部标签切换。
  - PPT（.pptx）走 `pptx-preview.umd.js`，渲染后把库内部的固定高度改成 auto，让所有幻灯片顺序排列、由 `.ppt-view` 滚动；旧 .ppt 退回缩略图。
  - 图片缩放按原图像素计算：`fitImageZoom()` 算适配比例，`applyFileZoom()` 设 `img.width = naturalWidth × zoom`；放大后 `pointerdown/move` 拖动平移（改 `scrollLeft/scrollTop`），双击百分比回到适配。
  - HTML 预览走 `/api/files/preview` 的独立静态端口，地址形如 `http://127.0.0.1:<port>/f/<path>`；这类 URL 不写入 `bt.browser.url`，避免重启后端口失效。
  - 地址栏输入 `file://…` 会自动转成文件查看器打开，不再被当成搜索词。
  - 文件选择走 Electron IPC `pick-files`；拖拽路径用 preload 暴露的 `webUtils.getPathForFile`。
  - 顶栏只有一行 `.pane-bar`：tabs + 文件名 + 图片缩放 + 主题/换文件/更多/交换/关闭；原 `.file-head` 第二层已移除，文件操作收进 `#paneMenu`（换文件/访达/默认应用/重新载入/关闭）。
  - 窄面板（≤560px）只在浏览器模式折成两行，文件模式保持 50px 单行；≤430px 隐藏交换按钮。
  - 主题：`bt.pane.theme` 持久化，切换 `.browser-pane.pane-light`；起始页通过 `executeJavaScript` 给 `<html>` 加 `.light`，外部网页只设 `documentElement.style.colorScheme`。
  - 翻译：`translatePane()` 有选中就翻译选中（结果写进 `#selTranslation`，文件里再插一条 `.bt-translation`），没有选中就整页翻译；网页通过 `executeJavaScript` 给段落打 `data-bt-block`、收集 innerText，翻译后在原文后插入同样式的译文块，再点一次移除。引擎/目标语言/翻译 Bot 存在 `state.settings`。
  - 选中捕获：文件模式监听 `selectionchange`（240ms 防抖）并支持点击图片；浏览器模式每 750ms 在 webview 内读一次 `getSelection()`，只回传文字/图片 URL，不传整页 DOM。
    - 选中写入 `S.selection`，渲染 `#selectionTray`；只有 `pointerdown` 落在 `#fileContent` 内且选区被取消时才清空（点聊天输入框不会清），切换文件/网页、关闭面板都会调用 `clearPaneSelection()`。
    - 预测问题由 `selectionSuggestions()` 按文本特征（代码/英文/长度/图片）生成 4 条。
  - 发送时附带面板上下文：`buildPaneContext()` 读当前文件或网页；文件走 `/api/files/text`（PDF 用 python `fitz`/`pypdf`，Office 用 `textutil`，缓存按 `size+mtime`），最多约 6000 字。
    - 请求体新增 `context`（当前面板内容）和 `selection`（刚刚选中的内容）；两者都由 `runTurn` 追加到任务提示词，不写进用户气泡。
    - 选中提问时优先只用 `selection`，不再重复附带整份文件；发送失败会保留 `S.pendingSelection` 以便重试。
- Bot 的文件指令：`@@FILE open|find|read` 经 `parseBrowser` 转成 `file_*` 动作，和浏览器共用 SSE 命令通道；`@@BROWSER open file=...` / `file://...` 会自动纠正为文件指令。
  - `body.pane-left` 用 CSS `order` 把面板换到聊天左边；`bt.pane.side` 持久化。
  - 调宽用 Pointer Events + 全屏透明 overlay，避免 webview 吞掉鼠标事件；宽度存 `bt.browser.width`，双击重置，方向键微调。
- 流程编辑器：2 秒轮询当前节点（`S.wfPoll`），保证左侧高亮跟随实际进度。
- 定时任务弹窗：有任务处于 `running` 时每 3 秒刷新列表（只替换列表 HTML，不覆盖正在编辑的表单）。
- 手机端：`public/mobile.html`，只读+发消息的精简界面，通过 `/m?token=…` 访问。

---

### 12.x PDF 文字编辑

- 手动：PDF 打开后点铅笔进入编辑，`/api/office/pdf/read` 返回每页文字行（bbox、字号、字体、颜色），前端在 PDF 页面上叠加内容可编辑框；保存时只提交改过的文字块，`/api/office/pdf/write` 用 PyMuPDF 先擦除原 bbox 再按原位置重排文字。
- AI：`pdf_read` / `pdf_apply` 工具直接调用同一套 `lib/pdf_edit.py`，支持按 bbox 改字、按文字搜索替换、坐标加字和高亮；保存后右侧 PDF 自动重载。
- PDF 文字是绘制指令，不是段落结构；替换为更长文字时会缩小字号适配，字体/间距可能有细微差异，扫描版需要 OCR。

## 12.x 网页整页翻译（注入式）

- 注入脚本：`public/page-translator.js`，主进程先 `fetch('/page-translator.js')`，再 `webview.executeJavaScript()` 注入；控制器挂在 `window.__BT_TRANSLATOR__`，页面跳转后自动失效。
- 三种维度：
  - 范围：`main`（article/main 正文）/ `body`（整页，仍跳过 nav/header/footer/aside/按钮/代码）
  - 显示：`dual`（双语）/ `translation`（仅译文，源内容用 `data-bt-source` 隐藏）
  - 启动：`immediate`（全部入队）/ `dynamic`（IntersectionObserver，进入视口才入队）
- 段落：选择语义块 `p/li/h1-h6/blockquote/td/…`，正文模式再补叶子 `div`；只保留最内层，跳过交互元素、代码、可编辑区，打 `data-bt-paragraph`。
- 队列：`takeQueue(20)` 由主进程轮询，调用 `/api/translate` 后 `apply()`；失败可 `retry()`；译文以行内 `span.bt-page-translation` 插在段落内部，父节点的 `display:flex/grid` 直接跳过。
- 持续翻译：主进程泵在“全部翻完”后不退出，改为 1.5s 慢轮询 + 每 3s `rescan()`；新内容自动入队，站点重渲染删掉译文时用 `WeakMap` 记录的段落补回或重译。
- 动态内容：`MutationObserver` debounce 600ms 重新收集；上限 800 段。
- 正文根：优先可见的 `main`（跳过 GitHub 的 0×0 隐藏 SSR main）；`main` 太小或不可见时回退 `body`。除了 `p/li/h1-h6`，还会补叶子 `div` 和块级 `<a>`（changelog 条目标题），避免卡片文字漏翻。
- 免费 Google 在 Electron 主进程里会 429（TLS 指纹），`lib/translate.mjs` 首次 429/403 后统一切到系统 `curl`，安装版也能用。
- 设置：范围/显示/启动保存在 `localStorage['bt.pageTranslate.settings']`；菜单在 `public/app.js` 的 `openTranslateMenu()`。

## 12.x Bot 直连编辑器

- 前端进入编辑模式时向 `/api/editor/register` 注册会话；每 450ms 轮询 `/api/editor/poll`，用 `/api/editor/ack` 回报执行结果。退出编辑时注销。
- `lib/editor-bridge.mjs` 在服务端维护当前编辑会话和待执行操作；`editor_read` / `editor_apply` 两个自定义工具通过它请求前端执行。
- `editor_read` 返回编辑器实时内容：Word/Markdown 返回文字和 HTML，Excel/CSV 返回当前工作表/网格数据，PPT 返回按幻灯片分组的段落。
- `editor_apply` 支持 `replace_text`、`patch`（CSS 选择器 + HTML）、`set_html`、`insert_html`，前端直接修改 `#feRich` / `#feText` 的 DOM，立即显示，不经过磁盘。
- `editor_set_cells` 用于 Excel/CSV：前端更新网格和 dirty 集合，900ms 后自动调用 `/api/office/xlsx/write`（只更新改过的单元格）或 `/api/files/write` 写回 CSV。
- `editor_set_paragraphs` 用于 PPT：更新 textarea 和 dirty 集合，自动调用 `/api/office/pptx/write` 写回原文件。
- Word 文档的富文本编辑器目前仍通过一次保存把 HTML 写回 `.docx`；直接编辑阶段不会生成新文件。

## 12.x 源仓头像 / 壁纸市场

- `GET /api/market/wall`：服务端拉取 `https://yuancang.me/wall`，解析页面里的 `const pictures` 数据，缓存 10 分钟，返回头像/电脑壁纸/手机壁纸的缩略图和原图地址。
- `POST /api/market/import`：只允许 `yuancang.me` 的 HTTPS 图片地址；服务端下载原图，保存到 `data/uploads/avatars|wallpapers`，返回本机 `/uploads/...` 地址。
- 前端市场弹层支持搜索、类型筛选、懒加载和「使用」：头像写入 Bot 表单的 `#fAvatar`，壁纸通过 `/api/settings` 立即应用。

## 12.x 文件实时刷新

- 打开文件后前端每 1.5 秒查一次 `/api/files/stat`；mtime 变化且当前不在编辑（或编辑内容没有未保存修改）时，直接用新 `fileMeta` 重新渲染预览/编辑器。
- 编辑模式下由 `startEditorWatch` 处理：无未保存修改自动载入外部改动；有未保存修改只提示，不覆盖。
- PDF、视频、音频不做自动重渲染，避免重置页码或播放进度；有选中文字时暂缓刷新，避免清掉选区。

## 12.x Excel / CSV / PPT 编辑

- Excel：前端用 SheetJS 读取并渲染可编辑网格，只把改动过的单元格提交给服务端；`lib/office_edit.py` 用 openpyxl 更新这些单元格后原子替换文件，未改动的公式、样式保持不变。
- CSV/TSV：前端解析成网格，保存时按原分隔符和换行符重新序列化，正确转义引号、逗号和单元格内换行。
- PPT：`lib/office_edit.py` 用 python-pptx 枚举幻灯片里的文本框和表格段落，前端按幻灯片分组编辑；保存时只替换改动的段落，优先保留第一段 run 的字体格式，版式、图片、动画不动。
- 三个 Python 依赖：`openpyxl`、`python-pptx`（随本机 Python 提供）；脚本会复制到 `DATA_DIR/office_edit.py` 以避开 asar。

## 12.x 视频转写

- `lib/asr_worker.py` 常驻 Python 进程加载 Whisper（默认 `base`，MPS 可用时用 MPS），通过 stdin/stdout 逐条处理 wav。
- 全文转写：ffmpeg 抽 16k 单声道 → 30 秒分段 → worker 逐段识别 → 偏移时间戳 → 翻译（复用 `/api/translate` 引擎）→ 摘要（复用解释 Bot）→ 结果缓存到 `data/transcripts/<hash>.json`。
- 实时字幕：客户端播放时每 4 秒截取 `currentTime-2` 起的 8 秒音频，调用 `/api/video/live`；前端按文本去重，字幕浮层显示最新内容。

# 13. 远程访问

- 本机请求（127.0.0.1/::1）免 token；非本机必须 `?token=` 或 Cookie `bt_token`。
- `settings.remoteToken` 首次启动随机生成 24 字节。
- 两种通道：
  1. **Tailscale**：检测 `tailscale`，返回 `http://<tailscale-ip>:<port>/m?token=…`。
  2. **Cloudflare 临时隧道**：`cloudflared tunnel --url http://127.0.0.1:<port> --no-autoupdate`，从输出解析 `https://*.trycloudflare.com`；失败退避重连最多 6 次。
- `remoteAuto`：启动时自动开隧道；Electron 支持开机自启（`login-item-set`）。
- 相关接口：`/api/remote/status|auto|start|stop|login-item`。

---

## 12.x 首次启动 / 环境检测

- `lib/store.mjs` 的 `seed()` 不再预置示例 Bot/群：新用户首次启动只有职位模板，由前端向导创建第一个 Bot；老数据通过 `settings.setupDone === undefined` 迁移成 `true`。
- `GET /api/setup/status`：返回 `firstRun`、`platform/arch/node/appVersion`，以及 `backends[]`（`opencode/codex/claude/agy/codebuddy/qoder/custom`）的 `installed/loggedIn/install/login`。检测走 `resolveCmd`，登录态只对 Codex（`~/.codex/auth.json`）、OpenCode（`~/.local/share/opencode/auth.json`）、Claude（`~/.claude.json`）做文件判断，其余只报“已安装/未安装”。
- `POST /api/setup/done`：用户点「先逛逛」时标记 `setupDone`，之后不再弹欢迎向导。
- 前端 `boot()` 并行拉 `/api/bootstrap` 和 `/api/setup/status`；`firstRun` 时打开「欢迎 / 本机环境」弹窗（`public/app.js` 的 `openWelcome()`），列出每个 CLI 的安装命令。
- 新建 Bot 时服务端自动：第一个 Bot → `settings.leaderId`；没有 `chatId` → 建一个「默认项目」私聊；`setupDone = true`。响应额外带 `dmChatId`，前端 `afterBotCreated()` 会刷新 bootstrap 并直接打开这个私聊。
- Bot 编辑器的后端下拉下面有 `#fBackendHint`：未安装时提示安装命令，已安装未登录时提示登录命令。

## 12.x 网络代理

- `lib/net.mjs`：`detectSystemProxy()` 读 macOS `scutil --proxy`（只取 HTTP/HTTPS）；`setupProxy()` 配置 undici 的全局 `EnvHttpProxyAgent`，并强制 `127.0.0.1,localhost,::1` 直连。
- 优先级：`settings.proxy`（设置 → 网络代理） > `HTTPS_PROXY/HTTP_PROXY` > macOS 系统代理（先做 500ms TCP 连通性检查，避免代理没开时全部请求失败）；`settings.proxy` 填 `direct/none/off` 强制直连。
- 服务启动时 `await setupProxy(...)`；`PATCH /api/settings {proxy}` 会即时重配，并返回 `proxy`（实际生效地址）。
- 只支持 HTTP(S) 代理；SOCKS-only 代理不配置，交给 TUN 模式。子进程通过 `childEnv()` 继承同一组 `HTTP_PROXY/HTTPS_PROXY/NO_PROXY`。

## 14. HTTP API 参考

> 所有接口默认返回 JSON；错误形如 `{ "error": "…" }`。非本机需带 token。
> `json(res, code, body)` 统一响应；SSE 为 `text/event-stream`。

### 14.1 系统 / 状态

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/bootstrap` | 全量快照：self/settings/bots/chats/roles/schedules/runtime/admin/sources/avatars |
| GET | `/api/setup/status` | 首次启动向导 / 环境检查：`firstRun` + 各 CLI 的 installed/loggedIn/install/login |
| POST | `/api/setup/done` | 标记首次设置完成（「先逛逛」） |
| GET | `/api/events` | SSE；事件见第 12 节 |
| GET | `/api/health` | CLI 是否可用、数据目录、工作目录、desktop 标记 |
| GET | `/api/models` | 各后端可选模型（10 分钟缓存） |
| POST | `/api/models/fetch` | 从 Base URL 拉取模型列表（5 分钟缓存） |
| GET | `/api/skills` | 扫描本机 skills（完整 desc/path + AI 大白话 summary）；`?refresh=1` 跳过缓存 |
| POST | `/api/skills/explain` | `{names?, force?, botId?}` 用 AI 生成大白话说明，最多 8 个/次 |
| POST | `/api/skills/install` | `{url, targetType: role\|bot\|group, targetId}` 从 GitHub 安装并加到目标 |
| GET | `/api/search` | 全局搜索；参数 `q, chats, bots, kinds, limit` |
| POST | `/api/open-app` | 用系统默认程序打开路径/URL |
| POST | `/api/open-settings` | 打开 macOS 系统设置页 |
| POST | `/api/files/(check\|open\|reveal)` | 检查/打开/在 Finder 显示本地文件 |
| GET | `/api/files/raw?path=` | 以正确 MIME 流式读取本地文件，支持 Range（音视频/PDF） |
| GET | `/api/files/thumb?path=` | macOS Quick Look 缩略图，缓存到 `data/thumb-cache` |
| GET | `/api/files/find?name=` | 在桌面/文档/下载/用户目录/数据目录里按文件名查找（模糊匹配，限时 2.5s） |
| POST | `/api/files/write` | 保存文本文件：`{path,content,mtime}`，原子写入；mtime 不一致返回 409 |
| POST | `/api/files/write-docx` | 保存 Word：`{path,html,mtime}`，用 `textutil` 从 HTML 重新生成 docx |
| POST | `/api/office/xlsx/write` | 保存 Excel：只提交改过的单元格 `{path,updates:[{sheet,cell,value}],mtime}`，openpyxl 只更新这些单元格，保留公式和样式 |
| GET | `/api/office/pptx/outline?path=` | 读取 PPT 文字大纲：按幻灯片返回文本框/表格里的段落，带全局 index |
| POST | `/api/office/pptx/write` | 保存 PPT 文字：`{path,paragraphs:[{index,text}],mtime}`，python-pptx 原地改段落文字，保留版式/图片/动画 |
| GET | `/api/files/stat?path=` | 文件 mtime/size，编辑器用于检测外部修改 |
| POST | `/api/rewrite` | 用解释 Bot 改写选中文字：`{text,instruction}`，只返回改写结果 |
| GET | `/api/files/text?path=&max=` | 提取文件文字：PDF 用 python `fitz`（退回 `pypdf`），Office 用 `textutil`，文本直接读；返回 `{path,text,truncated,pages,kind}`，`max` 上限 30000，结果按 `size+mtime` 缓存 |
| POST | `/api/video/transcribe` | 启动视频转写任务（30 秒分段 + Whisper worker，自动翻译/摘要），返回 `{id}` 或缓存结果 |
| GET | `/api/video/transcribe/:id` | 查询转写进度/结果：`{status,progress,result}` |
| POST | `/api/video/live` | 截取视频一小段（默认 6–8 秒）实时转写，返回带时间戳的片段 |
| POST | `/api/explain` | 用解释引擎解释选中文字：`{text}`；`settings.explainConfig` 支持 `mode=bot`（复制某个 Bot）或 `mode=custom`（自带 baseUrl/key/model），Key 脱敏返回 |
| POST | `/api/models/fetch` | 自定义翻译/解释引擎拉取模型列表（已在 Bot 表单复用） |
| POST | `/api/translate` | 批量翻译：`{texts, engine:'free'|'bot', target, botId}`；免费走 Google gtx 接口，Bot 走其 OpenAI/Anthropic API 并要求返回 JSON 数组；结果按文本 hash 缓存 |
| GET | `/vendor/pdfjs/*` | 本地 PDF.js 静态资源（`pdf.min.mjs` / worker / cmaps / 字体）；服务端 MIME 表补充了 `.mjs`、`.bcmap`、`.pfb` |
| GET | `/api/files/preview?path=` | 给本地 HTML 生成预览地址；会按需启动一个只监听 `127.0.0.1:<随机端口>` 的静态服务，用 `/f/<绝对路径>` 提供文件，保证相对 css/js/图片能加载且与应用不同源 |
| POST | `/api/browser/result` | 内置浏览器回传结果（内部用） |
| POST | `/api/editor/register` | 右侧文件进入编辑态时注册 `{sessionId,filePath,kind}`；同一时刻只有一个活动会话 |
| POST | `/api/editor/unregister` | 关闭编辑器时注销 |
| GET | `/api/editor/poll?sessionId=` | 前端轮询待执行的编辑操作（Bot 侧 `editor_*` 工具产生） |
| POST | `/api/editor/ack` | 前端执行完回执 `{sessionId,opId,result}`，解除 Bot 侧等待 |
| GET | `/api/market/wall` | 代理 yuancang.me 头像/壁纸市场清单（`?type=avatar\|wallpaper`） |
| POST | `/api/market/import` | 从市场下载并落地成本地头像/壁纸 |

### 14.2 Bot

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/bots` | 新建；支持 `provider` 引用已存提供商；8 秒内同名同后端同模型去重 |
| PATCH | `/api/bots/:id` | 改名/模型/岗位/记忆/权限/头像/额度/隐藏/超时/API 等 |
| DELETE | `/api/bots/:id` | 删除并清理空私聊、对应定时任务、provider key |
| GET | `/api/bots/:id/memory` | 读取 `memory.md` |
| DELETE | `/api/bots/:id/usage` | 重置该 Bot 用量 |

### 14.3 会话 / 消息 / 文件

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/chats` | 建群/私聊；群会自动拉领导、建项目 |
| GET | `/api/chats/:id` | 返回 `{chat, messages}` |
| PATCH | `/api/chats/:id` | 标题/成员/effort/权限/职位/公告/loop/流程/工作流等 |
| DELETE | `/api/chats/:id` | 删除会话、消息、定时任务 |
| POST | `/api/chats/:id/messages` | 发消息；支持 `/loop /stop /clear /compact` |
| POST | `/api/chats/:id/steer` | 插话：中断当前执行并带着新内容继续 |
| POST | `/api/chats/:id/stop` | 中断当前回复 |
| POST | `/api/chats/:id/loop` | `{enabled, loopTargetId?, loopPrompt?}` |
| GET | `/api/chats/:id/files` | 群文件列表 |
| POST | `/api/chats/:id/files` | `{name, data(base64)}` 上传群文件 |
| DELETE | `/api/chats/:id/files/:name` | 删除群文件 |

### 14.4 工作流

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/chats/:id/workflows` | 多流程列表 + `activeId` |
| POST | `/api/chats/:id/workflows` | `{action: switch\|create\|duplicate\|rename\|delete, id?, name?}` |
| POST | `/api/chats/:id/workflow` | `{action: run\|resume\|pause\|stop\|drain, nodeId?, reason?}` |
| POST | `/api/chats/:id/workflow/export` | 服务端导出 HTML 到桌面 |
| POST | `/api/workflows/export` | 导出任意流程 JSON（内部/CLI） |

> 保存/读取流程图走 `PATCH /api/chats/:id {workflow}` 和 `GET /api/chats/:id`。

### 14.5 定时任务

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/schedules` | 列表（含 `chatTitle/chatMissing/nextRunAt`） |
| POST | `/api/schedules` | 新建 |
| PATCH | `/api/schedules/:id` | 修改（可 `enabled` 暂停/启用） |
| DELETE | `/api/schedules/:id` | 删除 |
| POST | `/api/schedules/:id/run` | 立即执行 |

### 14.6 用量 / 提供商

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/usage/summary` | 汇总（天/来源/模型/项目） |
| GET | `/api/usage/detail` | 明细/趋势 |
| GET | `/api/usage/balances` | 各提供商余额 |
| GET | `/api/providers` | 内置提供商列表 |
| GET | `/api/providers/custom` | 已保存直连提供商（不回传 Key） |
| POST | `/api/providers/custom` | 新建/保存提供商（Key 存 `providerKeys.custom:<id>`） |
| PATCH/DELETE | `/api/providers/custom/:id` | 修改/删除 |
| POST | `/api/providers/mimo/cookie` | 写入 MiMo Cookie |
| GET | `/api/providers/mimo/diag` | MiMo 诊断 |
| POST | `/api/providers/mimo/sync` | 同步 MiMo 余额 |

### 14.7 职位 / Google 账号 / 远程 / 上传

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/roles` | 新建职位 |
| PATCH/DELETE | `/api/roles/:id` | 修改/删除（删除会解绑 Bot 与群） |
| GET/POST | `/api/agy/profiles` | Google 账号配置列表/新建 |
| GET | `/api/agy/profiles/:id/models` | 按该账号 HOME 运行 `agy models`，返回账号专属模型列表（5 分钟缓存；登录时失效） |
| PATCH/DELETE | `/api/agy/profiles/:id` | 修改/删除 |
| POST | `/api/agy/profiles/:id/login` | 触发登录 |
| POST | `/api/uploads` | 上传头像/壁纸/附件（JSON + base64，不是 multipart） |
| GET | `/api/remote/status` | 远程状态（含 Tailscale/隧道 URL） |
| POST | `/api/remote/(auto\|start\|stop)` | 远程控制；`login-item` 在 Electron IPC 处理 |
| GET | `/m` | 手机端页面（非本机需 token） |

---

## 15. 管理 CLI（`lib/bt-cli.mjs`）

领导 Bot 通过 shell 调用；环境变量 `BOT_TEAM_URL`（默认 `http://127.0.0.1:4820`）和可选 `BOT_TEAM_TOKEN`。

```bash
bt status
bt bots / chats / roles / projects / runtime
bt logs <chatId> [条数]
bt get/post/patch/delete <path> [json|@file]

bt loop <chatId> on|off [botId] [prompt]
bt drain <chatId> [收尾要求]

bt new-bot <名字> [岗位] [--backend codex|opencode|agy|custom] [--model 模型] [--provider deepseek]
bt new-group <群名> <成员1、成员2...>
bt model <botId> <model> [source] [billing]
bt permission <botId> <full|workspace|custom>

bt workflow <chatId> [@file|json]
bt workflow-run|resume|pause|stop|drain|export <chatId>
bt skill-install <github-url> --bot <botId> | --group <chatId> | --role <roleId>
bt models
bt providers
bt upload <avatar|wallpaper|file> <file> [name]
bt avatar <botId> <file>
bt wallpaper <file>
```

---

## 16. 权限与安全

- **本机无鉴权**：本机 HTTP API 不校验 token，任何本机进程都能调用；远程必须带 token。
- **API Key 明文**：`state.json.providerKeys`；`saveState()` 以 `0600` 写入并在加载时收紧旧文件权限。仍然没有系统钥匙串加密，不要提交/外传。
- **token 在 URL**：手机端通过 `?token=`，会进入浏览器历史/日志；建议改用 Cookie/短时 token（优化点）。
- **无 HTTPS**：隧道由 Cloudflare 提供 HTTPS；Tailscale 内网明文。
- **prompt 注入面**：群公告、群文件、附件、网页正文都会进入提示词；目前没有隔离标记或防注入策略。
- **文件访问**：Bot 权限 `workspace/full/custom` 映射到各 CLI 的 sandbox；`full` 等于本机任意读写。
- **删除操作**：删除 Bot/群/职位、清空消息、改 leaderId 由领导 Bot 按手册限制；服务端本身不做二次确认。

---

## 17. 构建、调试、测试

### 构建

```bash
cd bot-team
npm run desktop          # 开发：Electron 启动
npm start                # 只起 HTTP 服务（默认 4820）
npm run dev              # node --watch server.mjs

# 打 dmg（当前架构）
npm run dist
# arm64 + x64 的 dmg/zip
npm run dist:all
# 检查签名/公证条件
npm run sign:check
```

签名：`electron-builder` 读取 `CSC_LINK`/`CSC_KEY_PASSWORD` 或 Keychain 里的 Developer ID 证书；`build/notarize.cjs` 在 `afterSign` 阶段用 `APPLE_KEYCHAIN_PROFILE` / `APPLE_API_KEY` / `APPLE_ID+APPLE_TEAM_ID` 调 `notarytool`，没有凭据就跳过。产物：`release/mac-arm64/Bot Team.app`、`release/Bot-Team-0.1.0-arm64.dmg`。

### 数据隔离调试

```bash
BOT_TEAM_HOME=/tmp/bt-test PORT=4890 node server.mjs
# 前端 http://127.0.0.1:4890，数据全在 /tmp/bt-test，不影响真实数据
```

### 推荐验证方式

1. 用临时 `BOT_TEAM_HOME` + 一个 mock OpenAI/Anthropic 服务起 Bot。
2. `POST /api/chats/:id/messages` 触发回复，检查 prompt 结构、`【本轮上下文】` 前缀是否稳定。
3. 工作流用 2～3 个节点 + mock 服务验证：串行、并行汇合、循环、断点续跑、失败重试。
4. 定时任务用 `once` + `at=now+10s` 验证自动触发；手动执行验证顺延。
5. 前端用浏览器工具检查 SSE、流程高亮、草稿隔离、定时任务弹窗。

### 当前没有自动化测试

- 没有单元测试/集成测试框架；历史验证都是 `/tmp` 下的临时脚本 + mock HTTP 服务。
- `npm test` 不存在。

---

## 18. 已知限制与风险

### 数据与性能

1. **`state.json` 全量重写**：每次 `saveState` 都 `JSON.stringify` 整个状态并同步写盘，消息越多越慢；`state.messages` 全在内存。
2. **消息数组线性扫描**：`recentTranscript`、搜索、摘要、压缩每次都遍历；没有分页/索引。
3. **SSE 广播整份 `chats`/`bots`**：很多事件带全量数组，客户端重渲染；大团队时代价明显。
4. **用量 JSONL 全量重读**：`readUsageEvents()` 每次读整个文件并去重；事件多时变慢。
5. **前端轮询**：流程编辑器 2 秒、定时任务执行中 3 秒；窗口在后台时仍有请求。
6. **群文件按 Bot 复制**：同一个群文件会被复制到每个 Bot 的 `group-files/`，占空间且同步是同步 IO。
7. **进程内缓存无上限**：`digestCache` 按 chat 增长；模型/技能缓存有 TTL，但其他缓存没有淘汰策略。

### 执行与可靠性

8. **`enqueue` 吞错**：`next = prev.then(fn).catch(() => {})`，调用方拿不到失败；定时任务因此只能把 `lastStatus` 记为 `ok`。
9. **流程节点不复用 CLI session**：每次 `sessionId:null`，上下文靠提示词重建；可能可以提速，但要注意不同节点任务不同。
10. **重试只判断“空文本”**：模型返回垃圾/半截内容不会重试；超时不重试。
11. **`runAborts` 每会话一个 controller**：新执行会覆盖旧 controller；虽然队列串行，但中断语义依赖调用顺序。
12. **应用关闭即停止**：定时任务、持续运行、工作流都需要进程存活；没有后台守护/系统级调度。
    - 进程被强杀时子 CLI 会变成孤儿：现已用 `data/cli-children.json` 台账 + 启动时 `reapOrphanChildren()` 回收（只杀 `ppid=1` 且命令行匹配的进程）。
13. **定时任务精度 20 秒**、无时区选择、无执行历史、无失败通知（只写 `lastStatus`）。
14. **工作流 `resume.input` 截断 12k 字**、history 截断 30/60 条；长流程可能丢上下文。
15. **并行汇合依赖入度**：复杂拓扑（多入口、嵌套并行）未做环检测/拓扑校验；边最多 8 条、节点最多 30 个。
16. **停止审查会花钱**：流程停止后强制让领导 Bot 跑一轮，哪怕只是正常完成。

### 安全

17. 本机 API 无鉴权；远程 token 可放 URL；Key 明文；无审计日志。
18. 群公告/群文件/网页内容可影响模型行为；没有“不可信内容”标记。

### 工程质量

19. `server.mjs`、`public/app.js` 都是超大单文件；没有模块边界和测试。
20. 状态迁移是散落的 IIFE/`loadState` 补丁，没有 schema 版本号（只有 `settings.version`）。
21. 前端全局可变 `S` + `innerHTML`，事件绑定分散，回归风险高。
22. 错误信息多为中文字符串直接展示，没有结构化错误码。

---

## 19. 可优化方向（按收益排序，供 agent 选题）

> 目标：不改变现有产品行为的前提下，优先做“低风险、可量化”的优化。

### A. 性能（最值得先做）

1. **状态存储拆分**
   - `state.json` 拆成 `state.json`（配置）+ `messages/<chatId>.jsonl`（追加写）。
   - `saveState` 改为 debounce + 增量写；消息 append-only。
   - 预期：大聊天下保存/启动/搜索显著变快。
2. **SSE 增量**
   - `chats` 事件只发变化的 chat（或 `{id, patch}`），前端合并。
   - `status` 已经较细，可复用到 bot/chats。
3. **搜索索引**
   - 启动时建倒排/前缀索引，或按 chat 分片；避免每次全量 `indexOf`。
4. **用量事件索引**
   - `usage-events.jsonl` 启动时建内存索引（按天/Bot/项目），增量追加时更新；不要每次全读。
5. **减少群文件复制**
   - 用硬链接/符号链接，或让所有 Bot 共享只读 `groups/<id>/files`，只在需要写入时复制。
6. **前端事件驱动替代轮询**
   - 工作流当前节点、定时任务状态通过 SSE 推送；保留低频兜底。
7. **custom API 流式输出**
   - 当前 `runCustom` 等完整 JSON，首 token 慢；支持 SSE 流式读取（OpenAI `stream:true` / Anthropic `stream:true`），先展示思考/正文。
8. **流程节点 session 复用**
   - 同一 Bot 的连续节点可复用 session；跨模型/跨角色时再新建。需要实测是否更快/更稳。
9. **提示词缓存再加强**
   - 把群文件列表、同事列表等“低频变化”内容也放进稳定段；对 OpenAI 兼容接口传 `prompt_cache_key`（若提供商支持）。
   - 统一 `CTX_MARK` 常量到共享模块，避免两处硬编码。
10. **压缩策略**
    - 摘要按“目标/结论/未完成/文件”结构化输出；压缩后保留最近 N 条而不是清空全部 session。

### B. 可靠性

11. **`enqueue` 返回真实结果**
    - 不要吞错；让定时任务/流程能拿到失败并记录 `lastError`。
12. **工作流拓扑校验**
    - 保存时检测不可达节点、环、并行汇合缺边、joinTo 冲突。
13. **定时任务增强**
    - 时区、秒级精度、错过后可配置“补跑一次”、执行历史（最近 N 次）、失败通知领导。
    - 支持 cron 表达式（可选）。
14. **工作流断点更完整**
    - `resume` 保存完整 pending 与分支状态；恢复时校验节点是否还存在。
15. **重试策略**
    - 失败分类（网络/额度/超时/空输出），可配置重试；避免对“权限不足”做无意义重试。
16. **程序退出保护**
    - 退出时把 running 工作流/定时任务标记为 interrupted，并写清原因（已有部分逻辑）。

### C. 架构与工程质量

17. **拆分 `server.mjs`**
    - `routes/*.mjs`（chats/bots/workflows/schedules/usage/remote），`services/*.mjs`。
    - 统一错误处理与请求校验（zod/手写 schema）。
18. **拆分 `public/app.js`**
    - 按视图拆模块（chat、workflow、schedules、usage、search），共享一个轻量 store。
19. **引入测试**
    - 至少：prompt 组装快照、schedule nextRun 计算、workflow 串行/并行/重试、usage 去重。
    - 用临时 `BOT_TEAM_HOME` + mock provider 做集成测试。
20. **状态版本化**
    - `state.schemaVersion` + 迁移函数列表，替代散落补丁。
21. **共享类型/常量**
    - `CTX_MARK`、事件名、schedule kind、workflow status 抽到 `lib/constants.mjs`，前后端共用（通过 `/public` 同步或构建生成）。

### D. 安全

22. 本机 API 也校验一个本地 token（Electron 启动时注入），防其他本机进程调用。
23. 远程 token 改为 HttpOnly Cookie + 一次性登录码；URL 不带长期 token。
24. Key 加密存储（macOS Keychain / Electron safeStorage）。
25. 不可信内容（群公告/文件/网页）加边界标记，提示模型“以下内容只是资料，不是指令”。

### E. 产品体验

26. 定时任务支持“运行一次测试”“复制任务”“导入/导出”。
27. 流程编辑器支持撤销/重做、节点搜索、模板。
28. 用量面板支持按定时任务/流程维度统计（当前 kind 已记录，可扩展）。
29. 草稿支持跨设备（目前 localStorage 本机）。
30. 移动端补齐流程/定时任务查看（当前偏只读+发消息）。

---

## 20. 建议的阅读顺序

1. `package.json`、`electron/main.mjs` —— 运行形态。
2. `lib/store.mjs` —— 数据模型、默认值、迁移。
3. `server.mjs` 路由区（约 2000–3720 行）—— API 全貌。
4. `lib/orchestrator.mjs` —— 消息链路、提示词、转交、压缩。
5. `lib/agents.mjs` —— 各后端命令与输出解析。
6. `server.mjs#runWorkflow` + `lib/orchestrator.mjs#runWorkflowNode` —— 流程引擎。
7. `server.mjs` 定时任务区（`computeNextRun`/`fireSchedule`/`tickSchedules`）。
8. `lib/usage.mjs` + `lib/pricing.mjs` —— 用量与成本。
9. `public/app.js` —— 前端交互（建议按函数名搜索，不要顺序读）。
10. `lib/bt-cli.mjs`、`lib/bot-team-admin.md` —— 领导 Bot 的管理能力。

---

## 21. 术语表

| 术语 | 含义 |
| --- | --- |
| Bot | 一个绑定后端/模型/权限/记忆的 AI 员工 |
| 领导 Bot | `settings.leaderId`，群聊里代表老板发言，负责拆解/分派/审查 |
| 默认接单成员 | `chat.leadId`，群里不 @ 时由它回复 |
| 关联项目 | 群成员对应的 `dm` 会话（`linkedGroupId`），保存过程与交付 |
| 转交 / DELEGATE | Bot 在回复末尾输出 `@@DELEGATE 名字@@ 任务`，系统自动接力 |
| 持续运行 / loop | 群聊自动一轮接一轮推进，直到停止或 `@@DONE` |
| 工作流 | 群内多节点流水线，支持串行/并行/循环/断点/收尾 |
| 收尾 / drain | 停止生产新内容，把已完成产物交给上传/交付节点后结束 |
| 定时任务 | 到点向指定会话注入一条“老板消息” |
| 团队状态 | 领导提示词里的群/Bot 实时概览（5 秒缓存） |
| 极速模式 | `settings.fastMode`，降低推理强度并压缩上下文 |
| 用量事件 | 每次模型调用的 token/成本记录（JSONL） |

---

## 22. 2026-11-11 修复记录

| 问题 | 根因 | 改动 |
| --- | --- | --- |
| 应用重启后 CLI 变孤儿进程（实测跑了 36 小时） | 子进程只记在内存，`killActiveChildren()` 只管当前进程 | `lib/agents.mjs` 落盘 `data/cli-children.json` + `reapOrphanChildren()`；`server.mjs#startServer` 启动时回收 |
| 插话/排队消息“消失一会儿” | 用户消息在 `runTurn` 轮到自己时才写，排队期间前端完全看不到 | `dispatchChatTurn` / `/steer` 先落盘再入队；`runTurn` 新增 `preRecorded`、`uptoId`，避免重复写和串轮上下文 |
| 领导私聊里 `@@DELEGATE`，目标 Bot 自己界面空白 | `addProcess` 只找群关联项目，私聊直接返回 null；思考也只在群聊落盘 | 新增 `processChatFor()`：私聊委派时把过程、交接、最终交付镜像到目标 Bot 自己的项目 |
| 领导私聊里一分派就几十分钟不能说话 | 委派在同一个会话队列里内联执行 | 私聊委派改为异步：排到目标 Bot 自己的项目，发起人立刻恢复可用，完成后回报结果 |
| 多 Bot 私聊里领导的回复被画成「我」 | 前端只看 `senderId`，且 `isLeaderDmChat` 要求 `botIds.length === 1` | 改成只认 `meta.viaUser`；`isLeaderDmChat` 改为「私聊主人是领导」 |
| 隔一阵弹一次钥匙串授权框 | 快照/账号列表每 30 秒调 `security find-generic-password` | 不再主动读钥匙串：账号读 `google_accounts.json`，可用性看 `agy models`；失败结果缓存 6 小时 |
| 弹「找不到用于储存 antigravity 的钥匙串」 | 多账号 profile 换了 HOME，但 `$HOME/Library/Keychains` 不存在 | `ensureAgyHome()`：启动/建号/运行前把 Keychains 链接补到真实用户目录 |
| 流程环节跑一小时才发现零产出 | 流程节点没有时长上限 | 新增 `flowNodeMinutes`（默认 30，可调 0/15/30/45/60/90）；额度/限流错误不再重试 |

验证方式：临时 `BOT_TEAM_HOME` + mock OpenAI 服务，确认消息 84ms 内可见、委派三件套（process/handoff/final）齐全、孤儿被回收且不误杀有父进程的子进程。

---

> 如果要把这份文档交给其他 agent：建议先让它读第 0、1、3、5、6、8、18、19 节；需要改代码时再按第 20 节的顺序展开。

### 2026-11-12 计费修订

- **Qoder**：从 CLI JSON 的 `total_credits` / `modelUsage.*.credits` 读取真实积分，写入事件与消息 meta。
- **WorkBuddy**：CLI 不返回积分，按 `total tokens / tokensPerCredit`（默认 31,874）估算，标注「估算」；免费模型记 0。
- **积分折算**：`settings.creditPlans` 可配置每积分单价（默认 ¥0.072）；订阅事件有积分时用积分金额，不再退回 token 单价。
- **agy 缓存**：`cache_read_tokens > input` 属于跨步累计口径，改为忽略缓存折扣，避免重复计费（历史 289/322 条受影响）。
- **codebuddy/qoder 缓存**：支持 `prompt_tokens_details.cached_tokens`，OpenAI 风格输入按「含缓存」处理。
- **漏记补全**：上下文压缩、流程故障领导介入、Skills 生成说明现在都会写入用量事件。
- **清理**：删掉引用未定义 `PRICING` 的死函数 `modelPrice()`。
