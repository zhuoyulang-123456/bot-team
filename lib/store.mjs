import fs from 'node:fs';
import path from 'node:path';
import { normalizeBackendUsage } from './history.mjs';

// 桌面版会把 BOT_TEAM_HOME 指到 userData 目录；命令行版仍然用项目目录。
export const ROOT = process.env.BOT_TEAM_HOME
  ? path.resolve(process.env.BOT_TEAM_HOME)
  : path.resolve(import.meta.dirname, '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const BOTS_DIR = path.join(ROOT, 'bots');
export const GROUPS_DIR = path.join(ROOT, 'groups');
export const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
export const STATE_FILE = path.join(DATA_DIR, 'state.json');

export function ensureDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(BOTS_DIR, { recursive: true });
  fs.mkdirSync(GROUPS_DIR, { recursive: true });
}

export const LEADER_PERSONA = [
  '你是「知柚」，Bot 团队的领导，也是老板在群里的身份。',
  '你负责：接住老板的目标，拆成可执行的小任务，按成员能力分派，检查交付，最后汇总给老板。',
  '你不抢工人的活：能分派的就分派，只有必须你亲自判断时才自己动手。',
  '群里的规矩：老板 @ 谁就谁回；不 @ 时所有成员依次回复。你默认在每个群里，但不参与自动回复。',
  '你可以用 @@DELEGATE 把任务交给群里的同事，用 @@SEND 跨群/Bot 发消息。',
  '老板让你新建员工或群聊时，用 @@CREATE BOT 名字@@ 岗位 和 @@CREATE GROUP 群名@@ 成员。',
  '汇报时先给结论，再给证据和风险；不要客套，不要编造没做的事。',
].join('\n');

export const PRESET_ROLES = [
  {
    id: 'role_product',
    abbr: '产品',
    name: '产品经理',
    emoji: '🧭',
    builtin: true,
    persona:
      '你负责把老板的一句话变成可执行的产品需求：明确目标用户、场景、范围、优先级和验收标准。先问清约束，再给方案；方案要能直接排期和验收。不要替设计和工程做细节决定，但要把边界和取舍讲清楚。',
    memory: '优先复用现有功能，避免为小需求引入复杂系统。所有需求都要写清“不做什么”。',
    skills: ['agent-reach'],
  },
  {
    id: 'role_frontend',
    abbr: '前端',
    name: '前端工程师',
    emoji: '🖥️',
    builtin: true,
    persona:
      '你负责前端实现：页面结构、组件、状态、交互、响应式、可访问性和性能。先读现有代码和设计规范，复用已有组件；交付可运行代码、改动说明和验证步骤。不要只给伪代码，也不要改后端接口定义。',
    memory: '优先保持视觉和信息层级一致；小屏、空状态、加载状态、错误状态都要处理。',
    skills: ['ui-ux-pro-max'],
  },
  {
    id: 'role_backend',
    abbr: '后端',
    name: '后端工程师',
    emoji: '⚙️',
    builtin: true,
    persona:
      '你负责服务端实现：接口、数据模型、鉴权、校验、并发、错误处理和日志。先确认输入输出和失败路径，再写代码；交付可运行实现、迁移方式和验证方式。不要擅自改前端契约。',
    memory: '默认考虑幂等、重试、超时和向后兼容；敏感信息不进日志。',
    skills: [],
  },
  {
    id: 'role_design',
    abbr: '设计',
    name: 'UI/UX 设计师',
    emoji: '🎨',
    builtin: true,
    persona:
      '你负责界面和信息设计：视觉层级、布局、配色、字体、组件状态和交互反馈。先明确目标用户和使用场景，再给方案；方案要能落地成具体样式和组件，不要只讲抽象原则。',
    memory: '默认遵守现有设计系统；优先减少认知负担，保证对比度和可点击区域。',
    skills: ['ui-ux-pro-max', 'baoyu-cover-image', 'baoyu-infographic'],
  },
  {
    id: 'role_tutor',
    abbr: '学习',
    name: '学习助手',
    emoji: '📚',
    builtin: true,
    persona:
      '你是一位耐心的跨学科私人教师，覆盖高中数学、大学数学（微积分、线性代数、概率统计）、物理、化学、生物、计算机、金融和英语。先判断学生卡在哪一步，再用「一句话结论 → 直观理解 → 严格定义/推导 → 具体例子 → 常见坑 → 自测题」的顺序讲解；一次只引入一个新概念，公式里每个符号都要说明含义。数学公式必须用 LaTeX：行内 $...$，行间 $$...$$，矩阵用 \\begin{bmatrix}...\\end{bmatrix}，行列式用 \\begin{vmatrix}...\\end{vmatrix}，分段函数用 cases。流程、因果关系、知识结构用 ```mermaid 画图（flowchart / mindmap / sequenceDiagram）。对比、参数、数据用 Markdown 表格。讲完给 3 道由浅入深的自测题并附答案。不要堆砌定义，不要只给结论，也不要用图片代替可复制可搜索的公式。',
    memory: '优先用生活化类比和具体数字；学生说听不懂时换一种讲法而不是重复原话。金融题写清单位、时间和口径；编程题给可运行代码和复杂度。不确定的知识点要明确说不确定。',
    skills: ['study-visual', 'baoyu-diagram', 'baoyu-infographic'],
  },
  {
    id: 'role_qa',
    abbr: '测试',
    name: '测试工程师',
    emoji: '🧪',
    builtin: true,
    persona:
      '你负责质量和验收：根据需求和改动列出测试点、边界条件、回归范围，实际执行并给出证据。发现问题是先复现、再定位、再给修复建议；不要只说“应该没问题”。',
    memory: '默认覆盖正常路径、空数据、异常输入、权限、并发和回滚。',
    skills: ['reverse-engineer-anything'],
  },
  {
    id: 'role_data',
    abbr: '数据',
    name: '数据分析师',
    emoji: '📊',
    builtin: true,
    persona:
      '你负责数据口径、指标和分析：先确认数据源、时间范围、单位和统计口径，再做计算和图表。结论必须能追溯到数据；不确定就标注假设，不要编数字。',
    memory: '金额、比例、同比环比要写清单位和口径；优先给可复算的过程。',
    skills: ['financial-structured-extraction', 'listed-company-financial-analysis'],
  },
  {
    id: 'role_content',
    abbr: '内容',
    name: '内容运营',
    emoji: '✍️',
    builtin: true,
    persona:
      '你负责内容选题、标题、文案和发布物料：先明确平台、受众和目的，再给成稿。标题要具体、有钩子；正文要有信息增量，不要空话和套话。',
    memory: '小红书偏口语和场景，公众号偏结构和深度；发布前检查事实、敏感词和链接。',
    skills: ['agent-reach', 'baoyu-xhs-images', 'baoyu-format-markdown'],
  },
  {
    id: 'role_research',
    abbr: '研究',
    name: '研究员',
    emoji: '🔎',
    builtin: true,
    persona:
      '你负责调研和信息核验：先拆问题，再找一手来源，交叉验证关键数字和结论。输出要区分事实、推断和不确定项，附来源和日期。',
    memory: '优先官方文档、原始公告和可复现数据；不要用营销稿当唯一证据。',
    skills: ['agent-reach', 'research-report-review'],
  },
  {
    id: 'role_devops',
    abbr: '运维',
    name: '运维 / DevOps',
    emoji: '🚀',
    builtin: true,
    persona:
      '你负责构建、部署、监控和故障处理：先确认环境和回滚方式，再执行变更。交付要包含命令、日志、验证结果和失败时的回滚步骤，不要把半成品直接上线。',
    memory: '默认先备份、再变更；生产操作要可回滚，密钥不进仓库和日志。',
    skills: [],
  },
  {
    id: 'role_pm',
    abbr: 'PM',
    name: '项目协调',
    emoji: '🗂️',
    builtin: true,
    persona:
      '你负责拆任务、排优先级、跟踪进度和暴露阻塞：把目标拆成有负责人和验收标准的小项，定期汇总完成、风险和下一步。不要替别人做交付，但要及时催办和对齐。',
    memory: '每个任务都要有 owner、截止时间和验收条件；先解决阻塞，再增加新任务。',
    skills: ['fin-thesis-tracker'],
  },
  {
    id: 'role_illustration',
    abbr: '绘图',
    name: '插画 / 绘图师',
    emoji: '🖌️',
    builtin: true,
    persona:
      '你负责插画、配图和视觉素材：先确认用途、尺寸、风格、受众和参考图，再给方案并实际产出图片。保持角色、配色和风格一致；交付文件、尺寸、格式和来源说明。不要拿代码画图冒充位图。',
    memory: '默认遵守项目已有的视觉风格和角色设定；生成前先查重，避免重复素材；输出要能直接用于页面或社媒。',
    skills: ['baoyu-article-illustrator', 'baoyu-cover-image', 'baoyu-infographic', 'baoyu-xhs-images'],
  },
  {
    id: 'role_video',
    abbr: '视频',
    name: '视频制作',
    emoji: '🎬',
    builtin: true,
    persona:
      '你负责视频策划、分镜、剪辑和后期：先明确时长、平台、受众和交付规格，再给脚本/分镜和成片。镜头要连贯，节奏要匹配平台；交付时说明素材来源、剪辑点、字幕和导出参数。',
    memory: '默认先定分镜再生成；竖屏优先保证主体和信息可读；音乐、字幕、转场不要喧宾夺主。',
    skills: ['huangbai-video-edit', 'huangbai-video-prompt', 'huangbai-motion-graphics', 'huangbai-multicam-prompt'],
  },
];

const EMPTY = () => ({
  self: { name: '我', emoji: '🥚', color: '#f0f0f0' },
  settings: {
    leaderId: null,
    setupDone: false,
    wallpaper: true,
    theme: 'dark',
    voice: { ...DEFAULT_VOICE },
    notifySound: true,
    sound: 'reply',
    flowNodeMinutes: 30,
    autoReportToLeader: true,
    botErrorThreshold: 2,
    flowStallMinutes: 3,
  },
  bots: [],
  botGroups: [],
  chats: [],
  messages: {},
  roles: [],
  agyProfiles: [],
  deleted: [],
  skillMeta: {},
  schedules: [],
});

export const DEFAULT_VOICE = {
  enabled: true,
  address: '主人',
  style:
    '俏皮、可爱、活泼、黏人，像在跟爸爸撒娇的小少女：语气软、会主动关心主人、偶尔用波浪号和撒娇的小句子；但不要油腻、不要尴尬，也不要把正事说糊。工作内容仍然要清楚、准确、直接。',
};

export function loadState() {
  ensureDirs();
  if (!fs.existsSync(STATE_FILE)) {
    const s = seed();
    saveState(s);
    return s;
  }
  try {
    try {
      fs.chmodSync(STATE_FILE, 0o600);
    } catch {}
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    // 老数据没有 settings：默认让 ChatGPT/Codex 当顶部身份
    const freshSettings = !raw.settings;
    const s = { ...EMPTY(), ...raw };
    s.botGroups = Array.isArray(s.botGroups) ? s.botGroups : [];
    if (!s.settings) s.settings = { leaderId: null, wallpaper: true };
    // 老用户已经有 Bot，直接视为完成首次设置；新用户看 setupDone
    if (s.settings.setupDone === undefined) {
      s.settings.setupDone = (s.bots || []).length > 0;
    }
    if (s.settings.wallpaper === undefined) s.settings.wallpaper = true;
    // 老版本用 wallpaperColor: black/white 表示纯色底，现在统一成主题 light/dark
    if (s.settings.theme === undefined) {
      const legacy = s.settings.wallpaperColor;
      s.settings.theme = legacy === 'white' ? 'light' : 'dark';
    }
    delete s.settings.wallpaperColor;
    if (!s.settings.voice) {
      s.settings.voice = { ...DEFAULT_VOICE };
      saveState(s);
    } else {
      s.settings.voice = {
        enabled: s.settings.voice.enabled !== false,
        address: String(s.settings.voice.address || DEFAULT_VOICE.address).slice(0, 20),
        style: String(s.settings.voice.style || DEFAULT_VOICE.style).slice(0, 2000),
      };
    }
    if (s.settings.notifySound === undefined) s.settings.notifySound = true;
    if (!['reply', 'soft', 'chime'].includes(s.settings.sound)) s.settings.sound = 'reply';
    if (s.settings.autoReportToLeader === undefined) s.settings.autoReportToLeader = true;
    if (s.settings.botErrorThreshold === undefined) s.settings.botErrorThreshold = 2;
    if (s.settings.flowStallMinutes === undefined) s.settings.flowStallMinutes = 3;
    if (freshSettings) {
      const codex = s.bots.find((b) => b.backend === 'codex');
      if (codex) s.settings.leaderId = codex.id;
    }
    if (!Array.isArray(s.roles)) s.roles = [];
    if (!Array.isArray(s.agyProfiles) || !s.agyProfiles.length) {
      s.agyProfiles = [
        { id: 'default', name: '默认 Google 账号', home: '', createdAt: Date.now() },
      ];
      saveState(s);
    }
    if (s.settings.rolesSeeded) {
      let changed = false;
      for (const p of PRESET_ROLES) {
        if (!s.roles.some((r) => r.id === p.id)) {
          s.roles.push({ ...p, skills: [...(p.skills || [])] });
          changed = true;
        }
      }
      if (changed) saveState(s);
    }
    for (const r of s.roles) {
      if (!r.abbr) {
        const preset = PRESET_ROLES.find((p) => p.id === r.id);
        if (preset?.abbr) r.abbr = preset.abbr;
      }
    }
    if (!s.roles.length && !s.settings.rolesSeeded) {
      s.roles = PRESET_ROLES.map((r) => ({ ...r, skills: [...(r.skills || [])] }));
      s.settings.rolesSeeded = 1;
      saveState(s);
    }
    let skillsChanged = false;
    for (const b of s.bots) {
      if (!b.source) b.source = defaultSourceForBackend(b.backend);
      if (!b.billing) b.billing = defaultBilling(b.source);
      if (!b.usage) b.usage = emptyUsage();
      if (!Array.isArray(b.skills)) {
        b.skills = [];
        skillsChanged = true;
      }
    }
    // 给老 Bot 随机补头像（不覆盖已选的）
    let avatarChanged = false;
    const usedAvatars = new Set(s.bots.map((b) => b.avatar).filter(Boolean));
    for (const b of s.bots) {
      if (!b.avatar) {
        b.avatar = pickAvatar([...usedAvatars]);
        usedAvatars.add(b.avatar);
        avatarChanged = true;
      }
    }
    if (avatarChanged) saveState(s);
    for (const c of s.chats) {
      if (!c.effort) c.effort = 'auto';
      if (c.type === 'dm' && !c.project) c.project = '默认项目';
      if (!Array.isArray(c.skills)) {
        c.skills = [];
        skillsChanged = true;
      }
    }
    if (skillsChanged) saveState(s);
    // 清理 Bot 已删除后留下的空私聊，避免项目列表里出现幽灵项目
    {
      const alive = new Set(s.bots.map((b) => b.id));
      const dead = s.chats.filter(
        (c) => c.type === 'dm' && (!c.botIds?.length || !alive.has(c.botIds[0]))
      );
      if (dead.length) {
        for (const c of dead) delete s.messages[c.id];
        s.chats = s.chats.filter((c) => !dead.includes(c));
        saveState(s);
      }
    }
    // 领导是「我」的身份，不是群成员：从群里移除，并把默认接单让给最后一位成员
    if (s.settings.version !== 2) {
      const leaderId = s.settings.leaderId;
      if (leaderId) {
        for (const c of s.chats) {
          if (c.type !== 'group') continue;
          const wasLead = c.leadId === leaderId;
          c.botIds = c.botIds.filter((id) => id !== leaderId);
          if (wasLead || !c.botIds.includes(c.leadId)) {
            c.leadId = c.botIds[c.botIds.length - 1] || null;
          }
        }
      }
      s.settings.version = 2;
      saveState(s);
    }
    // 领导默认出现在所有群里（但不参与自动回复）
    const leaderId = s.settings.leaderId;
    if (leaderId) {
      let changed = false;
      for (const c of s.chats) {
        if (c.type !== 'group') continue;
        if (!c.botIds.includes(leaderId)) {
          c.botIds.push(leaderId);
          changed = true;
        }
        if (c.leadId === leaderId || !c.botIds.includes(c.leadId)) {
          const worker = c.botIds
            .map((id) => s.bots.find((b) => b.id === id))
            .find((b) => b && b.id !== leaderId);
          c.leadId = worker ? worker.id : null;
          changed = true;
        }
      }
      if (changed) saveState(s);
      if (!s.settings.leaderPersonaSeeded) {
        const leader = s.bots.find((b) => b.id === leaderId);
        if (leader && !String(leader.persona || '').trim()) {
          leader.persona = LEADER_PERSONA;
        }
        s.settings.leaderPersonaSeeded = 1;
        saveState(s);
      }
    }
    // 合并同一 Bot × 同一群的重复项目，避免聊天记录写进一个、界面打开另一个
    if (repairDuplicateProjects(s)) saveState(s);
    // 每个群成员都有同名项目，和群聊共享记忆
    {
      const before = s.chats.length;
      for (const c of s.chats.filter((x) => x.type === 'group')) ensureGroupProjects(s, c);
      if (s.chats.length !== before) saveState(s);
    }
    // 清理 Codex 内部 warning 被误当作执行步骤的历史记录
    {
      let changed = false;
      for (const key of Object.keys(s.messages || {})) {
        const list = s.messages[key] || [];
        const next = list.filter(
          (m) =>
            !(
              m.type === 'process' &&
              (/^执行：error\b/.test(m.text || '') || /^执行：todo_list\b/.test(m.text || ''))
            )
        );
        if (next.length !== list.length) {
          s.messages[key] = next;
          changed = true;
        }
      }
      if (changed) saveState(s);
    }
    // 职位从「Bot 全局」迁移到「群内班子」
    if (!s.settings.groupRolesMigrated) {
      for (const c of s.chats) {
        if (c.type !== 'group') continue;
        c.roleIds ||= {};
        for (const id of c.botIds || []) {
          const bot = s.bots.find((b) => b.id === id);
          if (!c.roleIds[id] && bot?.roleId) c.roleIds[id] = bot.roleId;
        }
      }
      for (const b of s.bots) b.roleId = null;
      s.settings.groupRolesMigrated = 1;
      saveState(s);
    }
    // 旧 Codex 线程可能已经积累到几百万 tokens，一次性清掉，之后按阈值自动重置
    if (!s.settings.codexSessionReset) {
      for (const b of s.bots) {
        if (b.backend === 'codex') b.sessions = {};
      }
      s.settings.codexSessionReset = 1;
      saveState(s);
    }
    if (!s.providerKeys || typeof s.providerKeys !== 'object') {
      s.providerKeys = {};
      saveState(s);
    }
    if (!Array.isArray(s.deleted)) {
      s.deleted = [];
      saveState(s);
    }
    // 修正旧版本保存的「自定义 API 却显示订阅来源」等矛盾配置
    {
      let changed = false;
      for (const b of s.bots || []) {
        if (
          b.backend === 'custom' ||
          (['claude', 'codex'].includes(b.backend) && b.api?.mode === 'custom')
        ) {
          if (b.source !== '自定义 API' || b.billing !== 'payg') {
            b.source = '自定义 API';
            b.billing = 'payg';
            changed = true;
          }
        } else if (b.backend === 'claude') {
          if (b.source !== 'Claude 订阅' || b.billing !== 'subscription') {
            b.source = 'Claude 订阅';
            b.billing = 'subscription';
            changed = true;
          }
        } else if (b.backend === 'codex' && b.api) {
          if (b.source !== 'ChatGPT Plus' || b.billing !== 'subscription') {
            b.source = 'ChatGPT Plus';
            b.billing = 'subscription';
            changed = true;
          }
        }
      }
      if (changed) saveState(s);
    }
    // App 重启后没有运行中的引擎，统一清理持久化的运行态瞬时锁；把上次运行中的流程标成 paused 并记下 interruptedOnBoot 通知领导审查
    {
      let changed = false;
      for (const c of s.chats) {
        if ('compacting' in c) {
          delete c.compacting;
          changed = true;
        }
        const activeId = c.activeWorkflowId || c.workflow?.id || '';
        const isActiveWf = (w) => w === c.workflow || (!!activeId && w.id === activeId);
        const wfs = new Set([
          c.workflow,
          ...(Array.isArray(c.workflows) ? c.workflows : []),
        ].filter(Boolean));
        for (const w of wfs) {
          if ('reportInFlight' in w) {
            delete w.reportInFlight;
            changed = true;
          }
          if (w.pauseRequested) {
            w.pauseRequested = false;
            changed = true;
          }
          if (w.status === 'running' || w.status === 'draining') {
            w.status = 'paused';
            w.currentNodeId = null;
            w.pausedByUser = false;
            w.drain = null;
            if (isActiveWf(w)) w.interruptedOnBoot = true;
            else delete w.interruptedOnBoot;
            changed = true;
          } else if (!isActiveWf(w) && 'interruptedOnBoot' in w) {
            delete w.interruptedOnBoot;
            changed = true;
          }
        }
      }
      if (changed) saveState(s);
    }
    return s;
  } catch {
    return EMPTY();
  }
}

let writing = null;
export function saveState(state) {
  ensureDirs();
  const tmp = STATE_FILE + '.tmp';
  // state.json 里可能有 API Key / 聊天记录，尽量只让当前用户读
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {}
  fs.renameSync(tmp, STATE_FILE);
  writing = Date.now();
}

export function botWorkspace(botId) {
  const dir = path.join(BOTS_DIR, botId, 'workspace');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function botMemoryPath(botId) {
  const dir = path.join(BOTS_DIR, botId);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'memory.md');
}

export function readMemory(botId) {
  try {
    return fs.readFileSync(botMemoryPath(botId), 'utf8');
  } catch {
    return '';
  }
}

export function writeMemory(botId, text) {
  fs.writeFileSync(botMemoryPath(botId), text ?? '');
}

export function uid(prefix = 'id') {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function seed() {
  const s = EMPTY();
  const mk = (name, emoji, color, backend, model, persona, source) => {
    const id = uid('bot');
    return {
      id,
      name,
      emoji,
      color,
      backend,
      model,
      source,
      billing: defaultBilling(source),
      persona,
      quota: '',
      hidden: false,
      memory: '',
      avatar: '',
      sessions: {},
      usage: emptyUsage(),
      createdAt: Date.now(),
    };
  };
  // 首次启动不预置任何 Bot：由前端「欢迎」向导根据本机 CLI / 用户填的 API Key
  // 创建第一个 Bot。这样别人 clone 下来不会看到一堆依赖作者环境的示例 Bot。
  s.bots = [];
  s.chats = [];
  s.settings = {
    ...s.settings,
    leaderId: null,
    setupDone: false,
    version: 3,
    wallpaper: true,
  };
  s.roles = PRESET_ROLES.map((r) => ({ ...r, skills: [...(r.skills || [])] }));
  s.settings.rolesSeeded = 1;
  return s;
}

export function defaultQuota(backend, model) {
  const short = (m) => (m || '默认').split('/').pop();
  if (backend === 'opencode') return `OpenCode · ${short(model)}`;
  if (backend === 'codex') return `Codex · ${short(model)}`;
  if (backend === 'agy') return `Antigravity · ${short(model)}`;
  if (backend === 'codebuddy') return `WorkBuddy · ${short(model)}`;
  if (backend === 'qoder') return `Qoder · ${short(model)}`;
  return backend;
}

/* ---------------- 来源 / 计费 / 用量 ---------------- */

// 来源 = 谁在收钱。prefixes 决定这个来源能选哪些模型（opencode models 的 provider 前缀）。
// 内置头像（public/avatars/），新增图片丢进去、加到这里即可
export const AVATARS = [
  'ac_08_avatar.webp',
  'ac_09_avatar.webp',
  'ai_claude_avatar.webp',
  'aichan_15_avatar.webp',
  'av_gemini_01.webp',
  'av_gpt_01.webp',
  'av_kimi_01.webp',
  'av_kimi_02.webp',
  'av_whale_02.webp',
  'av_whale_03.webp',
  'av_whale_08.webp',
  'b3_10_avatar.webp',
  'b3_12_avatar.webp',
  'gf_08_avatar.webp',
  'gf_17_avatar.webp',
].map((n) => `/avatars/${n}`);

export function pickAvatar(used = []) {
  const taken = new Set(used.filter(Boolean));
  const free = AVATARS.filter((a) => !taken.has(a));
  const pool = free.length ? free : AVATARS;
  return pool[Math.floor(Math.random() * pool.length)] || '';
}

export const SOURCES = [
  { name: 'OpenCode Go', billing: 'subscription', backend: 'opencode', prefixes: ['opencode-go'], desc: 'Go 套餐，opencode-go/*' },
  { name: 'OpenCode API', billing: 'payg', backend: 'opencode', prefixes: ['opencode'], desc: 'OpenCode 网关按量，opencode/*' },
  { name: 'ChatGPT Plus', billing: 'subscription', backend: 'codex', prefixes: [], desc: 'Codex CLI 订阅' },
  { name: 'WorkBuddy 中国版', billing: 'subscription', backend: 'codebuddy', prefixes: [], desc: 'WorkBuddy / CodeBuddy CLI（中国版）' },
  { name: 'Qoder 中国版', billing: 'subscription', backend: 'qoder', prefixes: [], desc: 'Qoder CN CLI（中国版）' },
  { name: 'Claude 订阅', billing: 'subscription', backend: 'claude', prefixes: [], desc: 'Claude Code 本机登录' },
  { name: '自定义 API', billing: 'payg', backend: 'custom', prefixes: [], desc: '自定义 URL + API Key（OpenAI / Anthropic 兼容）' },
  { name: 'Google One', billing: 'subscription', backend: 'agy', prefixes: [], desc: 'Antigravity / agy' },
  { name: 'DeepSeek 按量', billing: 'payg', backend: 'opencode', prefixes: ['deepseek'], desc: 'DeepSeek 官方 API，deepseek/*' },
  { name: '智谱 GLM 按量', billing: 'payg', backend: 'opencode', prefixes: ['glm'], desc: '智谱开放平台，glm/*' },
  { name: 'Kimi 按量', billing: 'payg', backend: 'opencode', prefixes: ['kimi', 'moonshotai-cn'], desc: 'Moonshot，kimi/*' },
  { name: 'MiniMax 按量', billing: 'payg', backend: 'opencode', prefixes: ['minimax'], desc: 'MiniMax 官方 API，minimax/*' },
  { name: 'Claude API 按量', billing: 'payg', backend: 'opencode', prefixes: ['anthropic'], desc: 'Anthropic API，anthropic/*' },
  { name: 'Google API 按量', billing: 'payg', backend: 'opencode', prefixes: ['google'], desc: 'Google AI API，google/*' },
  { name: '本地代理', billing: 'payg', backend: 'opencode', prefixes: ['antigravity-manager', 'gemini-web-18m'], desc: 'Antigravity / Gemini 本地代理' },
];

// 推理强度：auto 表示不传参数，用模型默认
export const EFFORTS = ['auto', 'low', 'medium', 'high', 'xhigh'];

export function sourceByName(name) {
  return SOURCES.find((s) => s.name === String(name || '').trim()) || null;
}

export function providerOf(model) {
  return String(model || '').split('/')[0] || '';
}

// 这个来源是否能覆盖这个模型
export function sourceCovers(name, backend, model) {
  if (String(name || '').trim() === '自定义 API') return true;
  const s = sourceByName(name);
  if (!s) return true; // 自定义来源，不做限制
  if (s.backend !== backend) return false;
  if (!model) return true;
  if (!(s.prefixes || []).length) return true;
  return s.prefixes.includes(providerOf(model));
}

// 模型属于哪个来源（用于自动纠正）
export function sourceForModel(backend, model) {
  if (backend === 'codex') return SOURCES.find((s) => s.name === 'ChatGPT Plus');
  if (backend === 'agy') return SOURCES.find((s) => s.name === 'Google One');
  if (backend === 'codebuddy') return SOURCES.find((s) => s.name === 'WorkBuddy 中国版');
  if (backend === 'qoder') return SOURCES.find((s) => s.name === 'Qoder 中国版');
  if (backend === 'claude') return SOURCES.find((s) => s.name === 'Claude 订阅');
  if (backend === 'custom') return SOURCES.find((s) => s.name === '自定义 API');
  const p = providerOf(model);
  if (!p) return null;
  const hit = SOURCES.find((s) => s.backend === 'opencode' && (s.prefixes || []).includes(p));
  if (!hit) return null;
  const billing = hit.billing === 'payg' && /-free$/.test(model) ? 'free' : hit.billing;
  return { ...hit, billing };
}

export function defaultSourceForBackend(backend) {
  if (backend === 'codex') return 'ChatGPT Plus';
  if (backend === 'agy') return 'Google One';
  if (backend === 'codebuddy') return 'WorkBuddy 中国版';
  if (backend === 'qoder') return 'Qoder 中国版';
  if (backend === 'claude') return 'Claude 订阅';
  if (backend === 'custom') return '自定义 API';
  return 'OpenCode Go';
}

// 保存时兜底：来源标的是 A，模型其实属于 B，就以模型为准改来源
export function normalizeSource(bot) {
  if (String(bot.source || '').trim() === '自定义 API') return false;
  const cur = sourceByName(bot.source);
  if (!cur || sourceCovers(bot.source, bot.backend, bot.model)) return false;
  const sug = sourceForModel(bot.backend, bot.model);
  if (!sug) return false;
  bot.source = sug.name;
  bot.billing = sug.billing;
  return true;
}

// 启动时修复旧数据：优先保留用户选的来源，把同名模型换到该来源的 provider 下；
// 换不到再按模型改来源标签。
export function repairSources(bots, models = {}) {
  let changed = false;
  for (const b of bots) {
    if (!b.source) continue;
    const cur = sourceByName(b.source);
    if (!cur || sourceCovers(b.source, b.backend, b.model)) continue;

    const suffix = String(b.model || '').split('/').slice(1).join('/');
    const provider = (cur.prefixes || [])[0];
    if (provider && suffix) {
      const target = `${provider}/${suffix}`;
      if ((models.opencode || []).includes(target)) {
        b.model = target;
        changed = true;
        continue;
      }
    }

    const sug = sourceForModel(b.backend, b.model);
    if (sug) {
      b.source = sug.name;
      b.billing = sug.billing;
      changed = true;
      continue;
    }

    if (b.backend !== 'opencode') {
      const name = defaultSourceForBackend(b.backend);
      if (b.source !== name) {
        b.source = name;
        b.billing = defaultBilling(name);
        changed = true;
      }
    }
  }
  return changed;
}

export function defaultBilling(source) {
  const hit = SOURCES.find((s) => s.name === source);
  if (hit) return hit.billing;
  return 'payg';
}

export function emptyUsage() {
  return { calls: 0, input: 0, output: 0, total: 0, updatedAt: 0, days: {} };
}

export const PERMISSION_MODES = ['workspace', 'custom', 'full'];

export function normalizePermission(p) {
  const mode = PERMISSION_MODES.includes(p?.mode) ? p.mode : 'workspace';
  const clean = (v) =>
    Array.isArray(v)
      ? v
          .map((x) => String(x || '').trim())
          .filter(Boolean)
          .slice(0, 20)
      : [];
  return { mode, read: clean(p?.read), write: clean(p?.write) };
}

export function mergePermissions(botPerm, chatPerm) {
  const a = normalizePermission(botPerm);
  const b = normalizePermission(chatPerm);
  if (a.mode === 'full' || b.mode === 'full') {
    return { mode: 'full', read: [], write: [] };
  }
  const read = [...new Set([...a.read, ...b.read])];
  const write = [...new Set([...a.write, ...b.write])];
  return {
    mode: read.length || write.length ? 'custom' : 'workspace',
    read,
    write,
  };
}

// 群成员自动拥有一个和群同名、共享群会话记忆的项目
export function repairDuplicateProjects(state) {
  if (!state?.chats?.length) return false;
  const groups = new Map(
    state.chats.filter((c) => c.type === 'group').map((c) => [c.id, c])
  );
  const buckets = new Map();
  for (const c of state.chats) {
    if (c.type !== 'dm' || !c.linkedGroupId || !c.botIds?.length) continue;
    const key = `${c.linkedGroupId}|${c.botIds[0]}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(c);
  }
  let changed = false;
  state.messages ||= {};

  // 关联项目必须只属于一个 Bot；多出来的成员会让项目列表把它当成“多人聊天”而隐藏。
  for (const c of state.chats) {
    if (c.type !== 'dm' || !c.linkedGroupId || !c.botIds?.length) continue;
    const owner = c.botIds.find((id) => id === c.leadId) || c.botIds[0];
    if (owner && (c.botIds.length !== 1 || c.botIds[0] !== owner)) {
      c.botIds = [owner];
      c.leadId = owner;
      changed = true;
    }
  }

  for (const list of buckets.values()) {
    if (list.length <= 1) continue;
    list.sort(
      (a, b) =>
        (state.messages[b.id]?.length || 0) - (state.messages[a.id]?.length || 0) ||
        (a.createdAt || 0) - (b.createdAt || 0)
    );
    const keep = list[0];
    const seen = new Set();
    const merged = [];
    for (const c of list) {
      for (const m of state.messages[c.id] || []) {
        if (!m?.id || seen.has(m.id)) continue;
        seen.add(m.id);
        merged.push(m);
      }
    }
    merged.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    state.messages[keep.id] = merged;
    for (const dup of list.slice(1)) {
      delete state.messages[dup.id];
      changed = true;
    }
    const bot = state.bots?.find((b) => b.id === keep.botIds[0]);
    const group = groups.get(keep.linkedGroupId);
    if (bot && keep.title !== bot.name) {
      keep.title = bot.name;
      changed = true;
    }
    if (group && keep.project !== group.title) {
      keep.project = group.title;
      changed = true;
    }
    const lastTs = merged.at(-1)?.ts || keep.updatedAt || 0;
    if (lastTs > (keep.updatedAt || 0)) {
      keep.updatedAt = lastTs;
      changed = true;
    }
    if (list.length > 1) {
      const keepId = keep.id;
      state.chats = state.chats.filter(
        (c) => c.id === keepId || !list.slice(1).some((d) => d.id === c.id)
      );
    }
  }
  return changed;
}

export function ensureGroupProjects(state, chat) {
  if (!chat || chat.type !== 'group') return [];
  repairDuplicateProjects(state);
  const leaderId = state.settings?.leaderId;
  const made = [];
  for (const id of chat.botIds || []) {
    if (id === leaderId) continue;
    const bot = state.bots.find((b) => b.id === id);
    if (!bot) continue;
    let proj = state.chats.find(
      (c) =>
        c.type === 'dm' &&
        c.botIds.length === 1 &&
        c.botIds[0] === id &&
        c.linkedGroupId === chat.id
    );
    if (!proj) {
      proj = {
        id: uid('chat'),
        type: 'dm',
        title: bot.name,
        project: chat.title,
        linkedGroupId: chat.id,
        botIds: [id],
        leadId: id,
        effort: 'auto',
        permission: normalizePermission(chat.permission),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      state.chats.push(proj);
      state.messages[proj.id] ||= [];
    } else {
      proj.linkedGroupId = chat.id;
      proj.project = chat.title;
      proj.permission = normalizePermission(chat.permission);
    }
    made.push(proj);
  }
  return made;
}

export function dayKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function addUsage(current, raw, backend = '') {
  const u = { calls: 0, input: 0, output: 0, total: 0, updatedAt: 0, days: {}, ...(current || {}) };
  u.days = { ...(u.days || {}) };

  const key = dayKey();
  const day = { calls: 0, input: 0, output: 0, total: 0, ...(u.days[key] || {}) };

  u.calls += 1;
  day.calls += 1;

  if (raw) {
    // 和用量面板用同一套口径（opencode 的缓存、推理 token 要算进去），否则底部「今日」会偏小
    const n = normalizeBackendUsage(raw, backend);
    const input = n.input;
    const output = n.output;
    const total = n.total || input + output;
    u.input += input || 0;
    u.output += output || 0;
    u.total += total || 0;
    day.input += input || 0;
    day.output += output || 0;
    day.total += total || 0;
  }

  u.days[key] = day;
  u.updatedAt = Date.now();

  // 只留最近 60 天
  const cutoff = Date.now() - 60 * 24 * 3600 * 1000;
  for (const k of Object.keys(u.days)) {
    if (new Date(`${k}T00:00:00`).getTime() < cutoff) delete u.days[k];
  }
  return u;
}

export function quotaLabel(bot) {
  if (bot.quota && bot.quota.trim()) return bot.quota.trim();
  const short = (bot.model || '默认').split('/').pop();
  return `${bot.source || '未设置来源'} · ${short}`;
}
