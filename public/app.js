const $ = (sel) => document.querySelector(sel);

// 输入框草稿存一份到 localStorage：应用重启后回到原来的会话，草稿还在。
function readDraftStore(key) {
  try {
    const raw = JSON.parse(localStorage.getItem(key) || '{}');
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

const S = {
  self: { name: '我', emoji: '🥚' },
  settings: { leaderId: null, wallpaper: true },
  bots: [],
  chats: [],
  roles: [],
  agyProfiles: [],
  messages: {},
  thinkState: {},
  usageDays: 30,
  usageSub: false,
  usageDim: 'bot',
  usageBalanceTab: 'api',
  lastUsageSummary: null,
  lastBalances: null,
  models: { opencode: [], agy: [], codex: [], codebuddy: [], qoder: [] },
  agyProfileModels: {},
  sources: [],
  avatars: [],
  wallpapers: [],
  skills: [],
  activeChatId: null,
  status: {},
  filter: '',
  hiddenOpen: false,
  connOn: true,
  sidebarHidden: localStorage.getItem('bt.sidebar.hidden') === '1',
  pendingAttachments: [],
  target: null,
  selection: null,
  pendingSelection: '',
  selectionKey: '',
  setup: null,
  newBotPreset: null,
  // 每个会话各自的输入框草稿：切到别的 bot/群/项目再切回来，内容还在原处
  drafts: readDraftStore('bt.drafts'),
  attachDrafts: readDraftStore('bt.attachDrafts'),
};

let draftPersistTimer = null;
function persistDrafts() {
  clearTimeout(draftPersistTimer);
  draftPersistTimer = setTimeout(() => {
    try {
      localStorage.setItem('bt.drafts', JSON.stringify(S.drafts));
      localStorage.setItem('bt.attachDrafts', JSON.stringify(S.attachDrafts));
    } catch {}
  }, 300);
}

const B = { supported: !!window.desktop, view: null, ready: false, open: false, mode: 'browser', filePath: '', fileMeta: null, fileZoom: 1, pdfjs: null };

const DEFAULT_VOICE_UI = {
  enabled: true,
  address: '主人',
  style:
    '俏皮、可爱、活泼、黏人，像在跟爸爸撒娇的小少女：语气软、会主动关心主人、偶尔用波浪号和撒娇的小句子；但不要油腻、不要尴尬，也不要把正事说糊。工作内容仍然要清楚、准确、直接。',
};
let lastNotifyAt = 0;
let avatarClickTimer = null;

function playSound(name = 'reply', force = false) {
  const s = S.settings || {};
  if (!force && s.notifySound === false) return;
  const key = ['reply', 'soft', 'chime'].includes(name) ? name : 'reply';
  try {
    const audio = new Audio(`/sounds/${key}.mp3`);
    audio.volume = 0.9;
    audio.play().catch(() => {});
  } catch {}
}

function playNotify() {
  if (S.settings?.notifySound === false) return;
  const now = Date.now();
  if (now - lastNotifyAt < 700) return;
  lastNotifyAt = now;
  playSound(S.settings?.sound || 'reply');
}

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const mdCache = new Map();
function renderMarkdownCached(text, id = '') {
  const raw = String(text ?? '');
  const key = `${id}:${raw.length}:${raw.slice(0, 48)}`;
  if (mdCache.has(key)) return mdCache.get(key);
  const html = window.renderMarkdown
    ? window.renderMarkdown(raw)
    : esc(raw).replace(/\n/g, '<br>');
  if (mdCache.size > 4000) mdCache.clear();
  mdCache.set(key, html);
  return html;
}

const api = async (path, opts = {}) => {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
};

function apiErrorText(e) {
  const raw = String(e?.message || e);
  const m = raw.match(/^\d+\s+(\{[\s\S]*\})$/);
  if (m) {
    try {
      const j = JSON.parse(m[1]);
      if (j.error) return j.error;
    } catch {}
  }
  return raw;
}

const botById = (id) => S.bots.find((b) => b.id === id);

function roleById(id) {
  return (S.roles || []).find((r) => r.id === id) || null;
}

function roleForChat(chat, bot) {
  if (!chat || !bot) return null;
  let roleId = null;
  if (chat.type === 'group') roleId = chat.roleIds?.[bot.id] || null;
  else if (chat.linkedGroupId) {
    const group = chatById(chat.linkedGroupId);
    roleId = group?.roleIds?.[bot.id] || null;
  }
  if (!roleId) roleId = bot.roleId || null;
  if (!roleId) return null;
  return roleById(roleId);
}

function botDisplayName(bot, chat = null) {
  if (!bot) return '';
  const role = chat ? roleForChat(chat, bot) : null;
  if (bot.showRoleAbbr !== false && role?.abbr) return `${bot.name}（${role.abbr}）`;
  return bot.name;
}
const chatById = (id) => S.chats.find((c) => c.id === id);
const activeChat = () => chatById(S.activeChatId);

const IS_WIN = window.desktop?.platform === 'win32' || /Windows/i.test(navigator.userAgent || '');
const MOD_KEY = IS_WIN ? 'Ctrl+' : '⌘';
document.body.classList.toggle('desktop', !!window.desktop);
document.body.classList.toggle('win', IS_WIN);

const pad2 = (n) => String(n).padStart(2, '0');
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

const hhmm = (ts) => {
  const d = new Date(ts || Date.now());
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

// 消息时间按微信习惯收敛：今天只写几点几分，昨天加「昨天」，
// 今年内的更早消息写几月几号，跨年再补上年份。
function dayLabel(ts) {
  const d = new Date(ts || Date.now());
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86400000);
  if (days <= 0) return '';
  if (days === 1) return '昨天';
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

const timeLabel = (ts) => {
  const day = dayLabel(ts);
  return day ? `${day} ${hhmm(ts)}` : hhmm(ts);
};

const fullTime = (ts) => {
  const d = new Date(ts || Date.now());
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${hhmm(ts)}`;
};

function timeRange(a, b) {
  const da = dayLabel(a);
  const db = dayLabel(b);
  if (da === db) return `${da ? `${da} ` : ''}${hhmm(a)}–${hhmm(b)}`;
  return `${timeLabel(a)}–${timeLabel(b)}`;
}

const isFresh = (ts) => Date.now() - (ts || 0) < 2000;

let forceScroll = true;

const EFFORTS = [
  { key: 'auto', label: '自动', desc: '用模型默认强度，不额外传参数' },
  { key: 'low', label: '轻度', desc: '更快、更省 token，适合简单任务' },
  { key: 'medium', label: '中度', desc: '速度和质量平衡，日常够用' },
  { key: 'high', label: '高度', desc: '更深的推理，适合复杂问题' },
  { key: 'xhigh', label: '极高', desc: '最慢也最强，适合硬骨头和长链路任务' },
];

function renderEffort() {
  const chat = activeChat();
  const cur = chat?.effort || 'auto';
  let idx = EFFORTS.findIndex((e) => e.key === cur);
  if (idx < 0) idx = 0;
  const el = EFFORTS[idx];

  $('#effortBtn').classList.toggle('active', idx > 0);
  $('#effortLabel').textContent = el.label;

  const range = $('#effortRange');
  range.value = String(idx);
  range.style.setProperty('--pct', `${(idx / (EFFORTS.length - 1)) * 100}%`);

  $('#effortValue').textContent = el.label;
  $('#effortDesc').textContent = el.desc;
  [...$('#effortScale').children].forEach((s, i) => s.classList.toggle('on', i === idx));
}

// 聊天栏里换模型：私聊改对方，群聊改默认接单成员；只换模型，来源不动
function composerBot() {
  const chat = activeChat();
  if (!chat) return null;
  if (chat.type === 'dm') return botById(chat.botIds[0]);
  return botById(chat.leadId) || botById(chat.botIds[0]);
}

function modelDisplayName(id) {
  if (!id) return '默认模型';
  const hit = (S.models.codex || []).find((m) => m.id === id);
  if (hit) return hit.name;
  return String(id).split('/').pop();
}

function renderModelPill() {
  const bot = composerBot();
  const btn = $('#modelBtn');
  if (!bot) {
    btn.hidden = true;
    return;
  }
  btn.hidden = false;
  const label = bot.model
    ? modelDisplayName(bot.model)
    : ['codex', 'codebuddy', 'qoder'].includes(bot.backend)
      ? '默认模型'
      : '未设置模型';
  $('#modelPillLabel').textContent = label;
  $('#modelDot').style.background = bot.color || '#8b93a2';
  btn.title = `${bot.name} · ${bot.source || '自定义来源'} · ${bot.model || '默认模型'}`;
}

function modelChoicesForBot(bot) {
  if (!bot) return [];
  const api = bot.api;
  const custom =
    bot.backend === 'custom' || (['claude', 'codex'].includes(bot.backend) && api?.mode === 'custom');
  if (custom) {
    if (Array.isArray(api?.models) && api.models.length) return api.models;
    return bot.model ? [bot.model] : [];
  }
  const profile =
    bot.backend === 'agy' && S.agyProfileModels?.[bot.agyProfile || 'default'] !== undefined
      ? bot.agyProfile || 'default'
      : '';
  return modelsFor(bot.backend, bot.source, profile);
}

function renderModelList(bot, query = '') {
  const q = query.trim().toLowerCase();
  const items = modelChoicesForBot(bot).map((id) => ({
    id,
    name: modelDisplayName(id),
    sub:
      bot.backend === 'agy' && /argon/i.test(id)
        ? 'CLI 上可能几分钟无响应，建议选 Flash'
        : '',
  }));
  if (['codex', 'codebuddy', 'qoder'].includes(bot.backend))
    items.unshift({ id: '', name: '默认模型', sub: '留空使用 CLI 默认' });

  const rows = items.filter(
    (it) => !q || it.id.toLowerCase().includes(q) || it.name.toLowerCase().includes(q)
  );
  const cur = bot.model || '';
  $('#modelListBox').innerHTML = rows.length
    ? rows
        .map(
          (it) => `
          <button class="model-item ${it.id === cur ? 'active' : ''}" data-model="${esc(it.id)}">
            <span class="mi-name">${esc(it.name)}</span>
            ${it.sub ? `<span class="mi-sub">${esc(it.sub)}</span>` : ''}
            <span class="mi-check">✓</span>
          </button>`
        )
        .join('')
    : `<div class="muted" style="padding:10px 8px">没有匹配的模型</div>`;
}

async function toggleModelPop() {
  const pop = $('#modelPop');
  if (!pop.hidden) {
    pop.hidden = true;
    return;
  }
  let bot = composerBot();
  if (!bot) return;
  $('#effortPop').hidden = true;

  const apiCfg = bot.api;
  const customBot =
    bot.backend === 'custom' || (['claude', 'codex'].includes(bot.backend) && apiCfg?.mode === 'custom');
  if (customBot && !(apiCfg?.models || []).length && apiCfg?.baseUrl) {
    try {
      const r = await api('/api/models/fetch', {
        method: 'POST',
        body: {
          baseUrl: apiCfg.baseUrl,
          style: apiCfg.style || 'openai',
          botId: bot.id,
        },
      });
      const models = (r.models || []).map((m) => m.id).filter(Boolean).slice(0, 100);
      if (models.length) {
        bot.api.models = models;
        api(`/api/bots/${bot.id}`, {
          method: 'PATCH',
          body: {
            api: {
              mode: bot.api.mode,
              style: bot.api.style,
              baseUrl: bot.api.baseUrl,
              models,
            },
          },
        }).catch(() => {});
      }
    } catch {}
  }

  if (!modelChoicesForBot(bot).length) {
    try {
      S.models = await api('/api/models');
      bot = composerBot() || bot;
    } catch {}
  }

  const r = $('#modelBtn').getBoundingClientRect();
  const w = 300;
  pop.hidden = false;
  pop.style.left = `${Math.min(Math.max(12, r.left - 8), window.innerWidth - w - 12)}px`;
  pop.style.bottom = `${Math.max(12, window.innerHeight - r.top + 8)}px`;
  $('#modelPopFoot').textContent = `${bot.name} · ${bot.source || '自定义来源'} · 只切模型，渠道不变`;
  $('#modelSearch').value = '';
  renderModelList(bot, '');
  $('#modelSearch').focus();
}

async function applyComposerModel(model) {
  const bot = composerBot();
  if (!bot) return;
  $('#modelPop').hidden = true;
  if ((bot.model || '') === model) return;
  try {
    await api(`/api/bots/${bot.id}`, { method: 'PATCH', body: { model } });
    bot.model = model;
    renderSidebar();
    renderModelPill();
    renderThread();
    if (bot.backend === 'agy' && /argon/i.test(model)) {
      toast('Argon 系列目前在 CLI 上经常几分钟不返回，建议改用 Flash', 'err');
    }
  } catch (e) {
    toast(`切换模型失败：${e.message}`, 'err');
  }
}

function toast(text, kind = '', ms = 2600) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = text;
  $('#toastWrap').appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .2s, transform .2s';
    el.style.opacity = '0';
    el.style.transform = 'translateY(6px)';
    setTimeout(() => el.remove(), 220);
  }, ms);
  return el;
}

let lastThemeApplied = '';
function applyWallpaper() {
  const on = S.settings?.wallpaper !== false;
  const file = S.settings?.wallpaperFile || '';
  const theme = S.settings?.theme === 'light' ? 'light' : 'dark';
  const solid = !file;
  const body = document.body;
  // 浅色是完整主题（白底 + 浅色组件）；深色和照片壁纸沿用深色玻璃层。
  body.classList.toggle('theme-light', theme === 'light');
  body.classList.toggle('has-wallpaper', on && (!!file || theme === 'dark'));
  body.classList.toggle('wall-solid', on && solid);
  body.classList.toggle('wall-dark', on && solid && theme === 'dark');
  body.classList.toggle('wall-light', on && solid && theme === 'light');
  if (on && solid) body.style.setProperty('--wallpaper-color', theme === 'light' ? '#ffffff' : '#000000');
  else body.style.removeProperty('--wallpaper-color');
  if (on && file) body.style.setProperty('--wallpaper-image', `url("${file}")`);
  else body.style.removeProperty('--wallpaper-image');
  // 右侧浏览器/文件面板跟着应用主题走；用户之后仍可用面板里的按钮单独切换。
  if (lastThemeApplied !== theme) {
    lastThemeApplied = theme;
    try {
      applyPaneTheme(theme);
    } catch {}
  }
}

function wallHintText() {
  const file = S.settings?.wallpaperFile;
  if (file) return '当前使用图片壁纸。上传和从市场下载的图片都留在本机，随时可以再选。';
  return (S.settings?.theme === 'light')
    ? '当前使用浅色主题（白色底），适合白天或浅色系统。'
    : '当前使用深色主题（纯黑底，默认），适合深色系统。';
}

function wallGridHtml() {
  const file = S.settings?.wallpaperFile || '';
  const theme = S.settings?.theme === 'light' ? 'light' : 'dark';
  const items = [
    { type: 'theme', value: 'dark', label: '深色' },
    { type: 'theme', value: 'light', label: '浅色' },
    { type: 'file', value: '/wallpapers/cozy-room.webp', label: '暖色房间' },
    ...(S.wallpapers || []).map((url) => ({ type: 'file', value: url, label: '' })),
  ];
  return items
    .map((it) => {
      const on = it.type === 'theme' ? !file && theme === it.value : !!file && file === it.value;
      const bg =
        it.type === 'theme'
          ? `background:${it.value === 'light' ? '#ffffff' : '#0b0c10'}`
          : `background-image:url('${esc(it.value)}')`;
      const attr = it.type === 'theme' ? `data-wall-theme="${esc(it.value)}"` : `data-wall-file="${esc(it.value)}"`;
      return `<button type="button" class="wall-swatch ${on ? 'on' : ''} ${
        it.type === 'theme' ? 'solid' : ''
      }" ${attr} title="${esc(it.label || '使用这张壁纸')}" style="${bg}">${
        it.label ? `<span>${esc(it.label)}</span>` : ''
      }</button>`;
    })
    .join('');
}

function refreshWallGrid() {
  const grid = $('#wallGrid');
  if (grid) grid.innerHTML = wallGridHtml();
  const hint = $('#wallHint');
  if (hint) hint.textContent = wallHintText();
}

function syncSidebarToggle() {
  const btn = $('#collapseSidebar');
  if (!btn) return;
  const label = S.sidebarHidden ? '展开侧栏' : '收起侧栏';
  btn.title = label;
  btn.setAttribute('aria-label', label);
  btn.classList.toggle('collapsed', !!S.sidebarHidden);
}

function bindSidebarToggle() {
  const btn = $('#collapseSidebar');
  if (!btn) return;
  btn.onclick = () => {
    S.sidebarHidden = !S.sidebarHidden;
    applySidebar();
  };
  syncSidebarToggle();
}

function applySidebar() {
  document.body.classList.toggle('sidebar-hidden', !!S.sidebarHidden);
  syncSidebarToggle();
  localStorage.setItem('bt.sidebar.hidden', S.sidebarHidden ? '1' : '0');
  setTimeout(() => {
    B.clampPane?.();
    scheduleChatCompact();
  }, 0);
  scheduleChatCompact();
}

/* ---------------- slash menu ---------------- */

const SLASH_COMMANDS = [
  { action: 'help', name: '/help', desc: '查看命令和技能的使用方法' },
  { action: 'clear', name: '/clear', desc: '清空当前对话和所有 Bot 的会话记忆' },
  { action: 'compact', name: '/compact', desc: '把长对话压缩成摘要，释放上下文' },
  { action: 'read', name: '/read', desc: '读取另一个项目的记录' },
  { action: 'loop', name: '/loop', desc: '持续运行，直到你喊停' },
  { action: 'stop', name: '/stop', desc: '停止持续运行' },
  { action: 'new-bot', name: '/new-bot', desc: '新建一个 Bot' },
  { action: 'new-group', name: '/new-group', desc: '新建一个群聊' },
  { action: 'settings', name: '/settings', desc: '打开设置 / 状态' },
  { action: 'close', name: '/close', desc: '关闭当前聊天' },
];

let slashOpen = false;
let slashIndex = 0;
let slashItems = [];

function closeSlash() {
  slashOpen = false;
  const menu = $('#slashMenu');
  if (menu) menu.hidden = true;
}

function renderSlash() {
  const menu = $('#slashMenu');
  if (!menu || !slashOpen) return;

  const commands = slashItems.filter((i) => i.kind === 'command');
  const skills = slashItems.filter((i) => i.kind === 'skill');
  let idx = 0;
  const row = (item) => {
    const i = idx++;
    return `<button class="slash-item ${item.kind === 'skill' ? 'slash-skill' : ''} ${
      i === slashIndex ? 'active' : ''
    }" data-index="${i}">
      <span class="slash-name">${esc(item.name)}</span>
      <span class="slash-desc">${esc(item.desc || '')}</span>
    </button>`;
  };

  let html = '';
  if (commands.length) {
    html += '<div class="slash-head">命令</div>' + commands.map(row).join('');
  }
  if (skills.length) {
    html += '<div class="slash-head">技能</div>' + skills.map(row).join('');
  }
  if (!slashItems.length) html = '<div class="slash-empty">没有匹配的命令或技能</div>';
  menu.innerHTML = html;

  const box = document.querySelector('.composer-box');
  if (box) {
    const r = box.getBoundingClientRect();
    menu.style.left = `${Math.max(12, r.left)}px`;
    menu.style.width = `${Math.min(r.width, 720)}px`;
    menu.style.bottom = `${Math.max(12, window.innerHeight - r.top + 8)}px`;
  }
  menu.hidden = false;
  menu.querySelector('.slash-item.active')?.scrollIntoView({ block: 'nearest' });
}

function updateSlash() {
  const input = $('#input');
  const v = input?.value || '';
  if (!v.startsWith('/') || /[\s\n]/.test(v.slice(1))) {
    closeSlash();
    return;
  }
  const q = v.slice(1).trim().toLowerCase();
  const cmds = SLASH_COMMANDS.filter(
    (c) => !q || c.name.toLowerCase().includes(q) || c.desc.toLowerCase().includes(q)
  ).map((c) => ({ ...c, kind: 'command' }));
  const skills = (S.skills || [])
    .filter(
      (s) =>
        !q ||
        (s.name || '').toLowerCase().includes(q) ||
        (s.desc || s.description || '').toLowerCase().includes(q)
    )
    .slice(0, 24)
    .map((s) => ({ kind: 'skill', name: s.name, desc: s.desc || s.description || '' }));
  slashItems = [...cmds, ...skills];
  slashIndex = 0;
  slashOpen = true;
  renderSlash();
}

function moveSlash(delta) {
  if (!slashItems.length) return;
  slashIndex = (slashIndex + delta + slashItems.length) % slashItems.length;
  renderSlash();
}

function executeSlash(item) {
  if (!item) {
    closeSlash();
    return;
  }
  closeSlash();
  const input = $('#input');
  // 斜杠命令本身不算草稿，别把它留在输入框记录里
  if (S.activeChatId) delete S.drafts[S.activeChatId];
  persistDrafts();
  if (item.kind === 'skill') {
    const text = `使用技能「${item.name}」：`;
    input.value = text;
    input.focus();
    input.setSelectionRange(text.length, text.length);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return;
  }
  if (item.action === 'help') {
    input.value = '';
    syncSendState();
    toast('输入 / 选择命令；↑↓ 选择，Enter 执行；输入内容可过滤，比如 /mimo 或 /ui');
    return;
  }
  if (item.action === 'new-bot') {
    input.value = '';
    syncSendState();
    newBot();
    return;
  }
  if (item.action === 'new-group') {
    input.value = '';
    syncSendState();
    newGroup();
    return;
  }
  if (item.action === 'read') {
    input.value = '';
    syncSendState();
    openReadPicker();
    return;
  }
  if (item.action === 'loop' || item.action === 'stop') {
    input.value = '';
    syncSendState();
    setChatLoop(item.action === 'loop');
    return;
  }
  if (item.action === 'settings') {
    input.value = '';
    syncSendState();
    $('#gridBtn').click();
    return;
  }
  if (item.action === 'close') {
    const cid = S.activeChatId;
    if (cid && (S.pendingAttachments || []).length) {
      S.attachDrafts[cid] = S.pendingAttachments.slice();
    }
    input.value = '';
    input.style.height = 'auto';
    S.pendingAttachments = [];
    renderAttachChips();
    syncSendState();
    S.activeChatId = null;
    renderSidebar();
    renderThread();
    return;
  }
  input.value = item.name;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  send();
}

/* ---------------- @ mentions ---------------- */

let mentionOpen = false;
let mentionIndex = 0;
let mentionItems = [];
let mentionStart = -1;

function mentionCandidates() {
  const chat = activeChat();
  if (!chat || chat.type !== 'group') return [];
  const leaderId = S.settings?.leaderId;
  const bots = chat.botIds
    .map(botById)
    .filter((b) => b && !b.hidden && b.id !== leaderId);
  if (!bots.length) return [];
  return [
    { id: '__all__', name: '所有人', all: true, quota: `提醒群里 ${bots.length} 个 AI` },
    ...bots,
  ];
}

function closeMention() {
  mentionOpen = false;
  mentionStart = -1;
  const menu = $('#mentionMenu');
  if (menu) menu.hidden = true;
}

function renderMention() {
  const menu = $('#mentionMenu');
  if (!menu || !mentionOpen) return;
  let html = '<div class="mention-head">群里可 @ 的成员</div>';
  if (!mentionItems.length) {
    html += '<div class="mention-empty">没有匹配的成员</div>';
  } else {
    html += mentionItems
      .map(
        (b, i) => `<button class="mention-item ${i === mentionIndex ? 'active' : ''}" data-index="${i}">
          ${b.all ? '<div class="avatar mention-all">@</div>' : avatarFor(b)}
          <span class="mention-text">
            <span class="mention-name">${esc(botDisplayName(b, activeChat()))}</span>
            <span class="mention-sub">${esc(b.quota || b.source || '')}</span>
          </span>
        </button>`
      )
      .join('');
  }
  menu.innerHTML = html;
  const box = document.querySelector('.composer-box');
  if (box) {
    const r = box.getBoundingClientRect();
    menu.style.left = `${Math.max(12, r.left)}px`;
    menu.style.width = `${Math.min(300, r.width)}px`;
    menu.style.bottom = `${Math.max(12, window.innerHeight - r.top + 8)}px`;
  }
  menu.hidden = false;
  menu.querySelector('.mention-item.active')?.scrollIntoView({ block: 'nearest' });
}

function updateMention() {
  const input = $('#input');
  const chat = activeChat();
  if (!input || !chat || chat.type !== 'group') {
    closeMention();
    return;
  }
  const caret = input.selectionStart ?? input.value.length;
  const before = input.value.slice(0, caret);
  const m = before.match(/@([^\s@]*)$/);
  if (!m) {
    closeMention();
    return;
  }
  const q = m[1].trim().toLowerCase();
  const all = mentionCandidates();
  const items = all.filter(
    (b) =>
      !q ||
      b.name.toLowerCase().includes(q) ||
      botDisplayName(b, chat).toLowerCase().includes(q) ||
      (roleForChat(chat, b)?.abbr || '').toLowerCase().includes(q) ||
      (b.quota || '').toLowerCase().includes(q) ||
      (b.source || '').toLowerCase().includes(q)
  );
  mentionStart = caret - m[0].length;
  mentionItems = items;
  mentionIndex = 0;
  mentionOpen = true;
  renderMention();
}

function moveMention(delta) {
  if (!mentionItems.length) return;
  mentionIndex = (mentionIndex + delta + mentionItems.length) % mentionItems.length;
  renderMention();
}

function insertMention(bot) {
  if (!bot) return;
  const input = $('#input');
  const caret = input.selectionStart ?? input.value.length;
  const start = mentionStart >= 0 ? mentionStart : caret;
  const before = input.value.slice(0, start);
  const after = input.value.slice(caret);
  const token = `@${botDisplayName(bot) || bot.name} `;
  input.value = before + token + after;
  const pos = before.length + token.length;
  closeMention();
  input.focus();
  input.setSelectionRange(pos, pos);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

async function copyText(text) {
  try {
    await Promise.race([
      navigator.clipboard.writeText(text),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 800)),
    ]);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
    } catch {}
    ta.remove();
  }
  toast('已复制');
}

function findMessage(id) {
  return (S.messages[S.activeChatId] || []).find((m) => m.id === id) || null;
}

function quoteIntoComposer(text) {
  const ta = $('#input');
  if (!ta || $('#composer').hidden) return;
  const body = String(text || '').trim();
  if (!body) return;
  const quote = body
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n');
  const insert = `${quote}\n\n`;
  const start = ta.selectionStart ?? ta.value.length;
  const end = ta.selectionEnd ?? start;
  ta.value = ta.value.slice(0, start) + insert + ta.value.slice(end);
  const pos = start + insert.length;
  ta.focus();
  ta.setSelectionRange(pos, pos);
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  ta.scrollTop = 0;
}

function actionsHtml(m) {
  return `<span class="msg-actions">
    <button data-copy="${m.id}" title="复制" aria-label="复制"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="9" y="9" width="10" height="10" rx="2.2" stroke="currentColor" stroke-width="1.6"/><path d="M5.5 15V7a2 2 0 0 1 2-2H15" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button>
    <button data-quote="${m.id}" title="引用" aria-label="引用"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M9.5 8H6.8A1.8 1.8 0 0 0 5 9.8v3.4A1.8 1.8 0 0 0 6.8 15h2.7c0 1.7-1 3-3 4M19.5 8h-2.7A1.8 1.8 0 0 0 15 9.8v3.4a1.8 1.8 0 0 0 1.8 1.8h2.7c0 1.7-1 3-3 4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
  </span>`;
}

function todayTotals() {
  const key = lastNDays(1)[0];
  return S.bots.reduce(
    (acc, b) => {
      const d = (b.usage?.days || {})[key] || {};
      acc.total += d.total || 0;
      acc.calls += d.calls || 0;
      return acc;
    },
    { total: 0, calls: 0 }
  );
}

/* ---------------- sidebar ---------------- */

function avatarFor(bot, cls = '', mentionable = false) {
  const attrs = bot.id
    ? ` data-bot-avatar="${bot.id}" title="${
        mentionable
          ? `单击打开设置，双击 @${esc(botDisplayName(bot))}`
          : `单击打开 ${esc(botDisplayName(bot))} 的设置`
      }"${mentionable ? ` data-mention-bot="${bot.id}"` : ''}`
    : '';
  if (bot.avatar) {
    return `<div class="avatar ${cls}"${attrs} style="background:${bot.color}22;color:${bot.color}"><img src="${esc(
      bot.avatar
    )}" alt="" loading="lazy" /></div>`;
  }
  return `<div class="avatar ${cls}"${attrs} style="background:${bot.color}26;color:${bot.color}">${esc(
    bot.emoji
  )}</div>`;
}

function groupAvatar(chat) {
  const members = chat.botIds.map(botById).filter(Boolean).slice(0, 4);
  if (!members.length) return `<div class="avatar" style="background:#2a2c33">💬</div>`;
  if (members.length === 1) return avatarFor(members[0]);
  const cells = members
    .map(
      (m) =>
        `<span class="stack-cell">${
          m.avatar
            ? `<img src="${esc(m.avatar)}" alt="" loading="lazy" />`
            : esc(m.emoji)
        }</span>`
    )
    .join('');
  return `<div class="avatar stack ${
    members.length === 2 ? 'stack-2' : members.length === 3 ? 'stack-3' : ''
  }">${cells}</div>`;
}

function applyOrder(items, orderIds, getId = (x) => x.id) {
  if (!Array.isArray(orderIds) || !orderIds.length) return items;
  const rank = new Map(orderIds.map((id, i) => [id, i]));
  return [...items].sort((a, b) => {
    const ra = rank.has(getId(a)) ? rank.get(getId(a)) : 9999;
    const rb = rank.has(getId(b)) ? rank.get(getId(b)) : 9999;
    return ra - rb;
  });
}

function renderBotRowHtml(b, { activeDmBot, working, queued, inGroup = false }) {
  const pc = S.chats.filter(
    (c) => c.type === 'dm' && c.botIds.length === 1 && c.botIds[0] === b.id
  ).length;
  const isQueued = queued.has(b.id);
  const isWorking = working.has(b.id);
  const workLabel = isWorking
    ? `<span class="working-label${isQueued ? ' queued' : ''}">● ${
        isQueued ? '排队中' : '正在工作'
      }</span> · `
    : '';
  return `
    <div class="row ${inGroup ? 'in-folder' : ''} ${isWorking ? 'working' : ''} ${b.alert ? 'has-alert' : ''} ${
      activeDmBot === b.id ? 'active' : ''
    }" draggable="true" data-bot="${b.id}" data-drag-type="bot" data-drag-id="${b.id}">
      <div class="row-avatar">
        ${avatarFor(b)}
        ${b.alert ? `<span class="row-alert" title="${esc(b.alert.text || '需要处理')}"></span>` : ''}
      </div>
      <div class="row-text">
        <div class="row-name">${esc(botDisplayName(b))}</div>
        <div class="row-sub">${workLabel}${pc > 1 ? `${pc} 个项目 · ` : ''}额度：${esc(b.quota)}</div>
      </div>
      <button class="row-more" data-edit="${b.id}" title="编辑" aria-label="编辑 ${esc(b.name)}"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg></button>
    </div>`;
}

function renderSidebar() {
  const f = S.filter.trim().toLowerCase();
  const match = (b) => !f || b.name.toLowerCase().includes(f) || (b.quota || '').toLowerCase().includes(f);

  const leaderId = S.settings?.leaderId || null;
  const leader = leaderId ? botById(leaderId) : null;
  const order = S.settings?.order || {};
  const groups = applyOrder(
    S.chats.filter(
      (c) => c.type === 'group' && (!f || (c.title || '').toLowerCase().includes(f))
    ),
    order.groups
  );
  const workers = applyOrder(
    S.bots.filter((b) => b.id !== leaderId),
    order.bots
  );
  const visible = workers.filter((b) => !b.hidden && match(b));
  const hidden = workers.filter((b) => b.hidden && match(b));
  const chat = activeChat();
  const activeDmBot = chat && chat.type === 'dm' ? chat.botIds[0] : null;
  const working = new Set();
  const queued = new Set();
  for (const per of Object.values(S.status || {})) {
    for (const [id, st] of Object.entries(per || {})) {
      working.add(id);
      if (st?.queued) queued.add(id);
    }
  }

  const html = [];

  if (groups.length) {
    html.push(`<div class="section-label">群聊</div>`);
    for (const g of groups) {
      html.push(`
        <button class="row ${S.activeChatId === g.id ? 'active' : ''} ${
          ['running', 'draining'].includes(g.workflow?.status) ? 'workflow-running' : ''
        }" draggable="true" data-chat="${g.id}" data-drag-type="group" data-drag-id="${g.id}">
          ${groupAvatar(g)}
          <div class="row-text">
            <div class="row-name">${esc(g.title)}</div>
            <div class="row-sub">${g.botIds.length} 位成员 · ${
              g.loop
                ? '<span class="loop-badge">持续运行中</span>'
                : g.workflow?.status === 'running'
                  ? '<span class="loop-badge">流程运行中</span>'
                  : `${esc(botById(g.leadId)?.name || '默认')} 接单`
            }</div>
          </div>
        </button>`);
    }
    html.push(
      `<div class="section-label section-label-bots"><span>Bot</span><button type="button" class="section-add-btn" id="newBotGroupBtn" title="新建 Bot 分组" aria-label="新建 Bot 分组">📁+</button></div>`
    );
  } else if (visible.length || (S.botGroups || []).length) {
    html.push(
      `<div class="section-label section-label-bots"><span>Bot</span><button type="button" class="section-add-btn" id="newBotGroupBtn" title="新建 Bot 分组" aria-label="新建 Bot 分组">📁+</button></div>`
    );
  }

  const botGroups = S.botGroups || [];
  const validGroupIds = new Set(botGroups.map((g) => g.id));
  for (const grp of botGroups) {
    const members = visible.filter((b) => b.groupId === grp.id);
    if (f && !members.length && !grp.name.toLowerCase().includes(f)) continue;
    const collapsed = f ? false : !!grp.collapsed;
    html.push(`
      <div class="bot-folder ${collapsed ? 'collapsed' : ''}" data-bot-group="${grp.id}">
        <div class="bot-folder-head" data-folder-toggle="${grp.id}" data-drop-folder="${grp.id}">
          <span class="bot-folder-caret">${collapsed ? '▸' : '▾'}</span>
          <span class="bot-folder-icon">📁</span>
          <span class="bot-folder-name">${esc(grp.name)}</span>
          <span class="bot-folder-count">${members.length}</span>
          <span class="bot-folder-actions">
            <button type="button" class="bot-folder-btn" data-folder-rename="${grp.id}" title="重命名分组" aria-label="重命名分组">✎</button>
            <button type="button" class="bot-folder-btn" data-folder-del="${grp.id}" title="删除分组" aria-label="删除分组">×</button>
          </span>
        </div>
        ${
          collapsed
            ? ''
            : `<div class="bot-folder-body" data-drop-folder="${grp.id}">${
                members.length
                  ? members
                      .map((b) =>
                        renderBotRowHtml(b, { activeDmBot, working, queued, inGroup: true })
                      )
                      .join('')
                  : '<div class="bot-folder-empty">拖入 Bot 到此分组</div>'
              }</div>`
        }
      </div>`);
  }

  const ungrouped = visible.filter((b) => !b.groupId || !validGroupIds.has(b.groupId));
  html.push(
    `<div class="bot-ungrouped-zone ${!ungrouped.length && botGroups.length ? 'is-empty' : ''}" data-drop-folder="__ungrouped__">`
  );
  for (const b of ungrouped) {
    html.push(renderBotRowHtml(b, { activeDmBot, working, queued, inGroup: false }));
  }
  if (!ungrouped.length && botGroups.length) {
    html.push(`<div class="bot-ungrouped-hint">拖到此处移出分组</div>`);
  }
  html.push(`</div>`);

  if (!visible.length && !groups.length && !leader && !botGroups.length) {
    html.push(`<div class="muted" style="padding:16px 12px">还没有 bot。点右上角 ＋ 新建。</div>`);
  }

  $('#list').innerHTML = html.join('');

  $('#hiddenBlock').hidden = hidden.length === 0;
  $('#hiddenCount').textContent = String(hidden.length);
  $('#hiddenList').hidden = !S.hiddenOpen;
  $('#hiddenList').innerHTML = hidden
    .map(
      (b) => `
      <div class="row ${activeDmBot === b.id ? 'active' : ''}" data-bot="${b.id}">
        ${avatarFor(b)}
        <div class="row-text">
          <div class="row-name">${esc(botDisplayName(b))}</div>
          <div class="row-sub">额度：${esc(b.quota)}</div>
        </div>
        <button class="row-more" data-edit="${b.id}" title="编辑" aria-label="编辑 ${esc(b.name)}"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg></button>
      </div>`
    )
    .join('');

  const av = $('#selfAvatar');
  if (leader) {
    av.innerHTML = leader.avatar
      ? `<img src="${esc(leader.avatar)}" alt="" />`
      : esc(leader.emoji || '🙂');
    av.style.background = `${leader.color}26`;
    av.style.color = leader.color;
    $('#selfName').textContent = leader.name;
    $('#selfSub').textContent = `领导 · ${leader.source || '自定义来源'} · ${
      leader.model ? modelDisplayName(leader.model) : '默认模型'
    }`;
    $('#selfMore').hidden = false;
    $('#selfCard').title = `点击和 ${leader.name} 对话`;
  } else {
    av.textContent = S.self.emoji || '🥚';
    av.style.background = '';
    av.style.color = '';    $('#selfName').textContent = S.self.name || '我';
    $('#selfSub').textContent = 'AI 员工工作台';
    $('#selfMore').hidden = true;
    $('#selfCard').title = 'AI 员工工作台';
  }
  const today = todayTotals();
  $('#todayValue').textContent = today.total ? `${fmtCompact(today.total)} tokens` : '暂无消耗';
  $('#todayChip').title = today.total ? `今日 ${fmt(today.total)} tokens` : '今日暂无消耗';
}

/* ---------------- thread ---------------- */

function quotaLine(meta, bot) {
  if (!meta?.quota) return '';
  const usage = meta.usage;
  const total = usage?.total_tokens ?? usage?.total;
  const out = usage?.output_tokens ?? usage?.output;
  const planPrice = Number(S.settings?.creditPlans?.[bot?.backend]?.pricePerCredit);
  const unitPrice = Number.isFinite(planPrice) && planPrice >= 0 ? planPrice : 0.072;
  const creditCost = Number(meta.credits) > 0 ? Number(meta.credits) * unitPrice : 0;
  const creditText = Number(meta.credits) > 0
    ? `${fmtCredits(meta.credits)} ${meta.creditUnit || '积分'}${
        meta.creditsEstimated ? '（估算）' : ''
      }${creditCost > 0 ? ` ≈ ${usageMoneyFine(creditCost)}` : ''}`
    : '';
  const extra = [
    total ? `${fmt(total)} tokens` : out ? `输出 ${fmt(out)} tokens` : '',
    creditText,
  ]
    .filter(Boolean)
    .join(' · ');
  return `<div class="quota-line"${extra ? ` title="${esc(extra)}"` : ''}><span class="q-dot"></span><b>${esc(
    meta.quota
  )}</b>${creditText ? `<span class="q-credit">· ${esc(creditText)}</span>` : ''}</div>`;
}

function isLeaderDmChat(chatId) {
  const c = chatById(chatId);
  const lid = S.settings?.leaderId;
  // 只要这个私聊归领导所有就算，哪怕里面还拉了别的 Bot 进来。
  // 之前要求 botIds.length === 1，多 Bot 私聊会把领导的回复渲染成「我」说的话。
  return !!c && c.type === 'dm' && !!lid && c.botIds?.[0] === lid;
}

function attachmentsHtml(list) {
  if (!Array.isArray(list) || !list.length) return '';
  return `<div class="msg-files">${list
    .map((a) => {
      const image = isImageAttachment(a);
      return `<a class="msg-file" href="${esc(a.url)}" target="_blank" rel="noreferrer">
        ${
          image
            ? `<img src="${esc(a.url)}" alt="${esc(a.name || '')}" />`
            : `<span class="msg-file-icon">📄</span>`
        }
        <span class="msg-file-name">${esc(a.name || '附件')}</span>
      </a>`;
    })
    .join('')}</div>`;
}

function handoffCardHtml(m) {
  const from = botById(m.senderId);
  const to = botById(m.toId);
  const meta = m.meta || {};
  const kind = meta.drain
    ? '收尾交接'
    : meta.merge
      ? '汇合交接'
      : meta.parallel
        ? '并行交接'
        : meta.loop
          ? '循环交接'
          : meta.mirrored || (meta.fromNode && meta.toNode)
            ? '流程交接'
            : '转交';
  const route = meta.fromNode && meta.toNode ? `${meta.fromNode} → ${meta.toNode}` : '';
  const preview = String(meta.preview || '').trim();
  const task = String(m.text || '').trim();
  const body = preview || task;
  const long = body.includes('\n') || body.length > 110;
  return `<div class="handoff${meta.mirrored ? ' mirrored' : ''}">
    <div class="ho-card">
      <div class="ho-head">
        ${from ? avatarFor(from) : ''}
        <span class="ho-who">${esc(from?.name || '?')}</span>
        <span class="ho-arrow">→</span>
        <span class="ho-who">${esc(to?.name || '?')}</span>
        ${to ? avatarFor(to) : ''}
      </div>
      <div class="ho-meta">
        <span class="ho-kind">${esc(kind)}</span>
        ${route ? `<span class="ho-route">${esc(route)}</span>` : ''}
      </div>
      ${
        body
          ? `<div class="ho-task${long ? ' ho-task-long' : ''}">${esc(
              body.slice(0, 1200)
            )}${body.length > 1200 ? '…' : ''}</div>`
          : ''
      }
      ${meta.mirrored && meta.groupTitle ? `<div class="ho-from-group">来自群聊「${esc(meta.groupTitle)}」</div>` : ''}
    </div>
  </div>`;
}

/* ---------------- 聊天里的本地文件 ---------------- */

const FILE_PATH_RE =
  /(?:~\/|\/(?:Users|tmp|private|Volumes|opt|var|home)\/)[^\s<>"'`()[\]{}]+?\.[A-Za-z0-9]{1,8}/g;

const FILE_KINDS = [
  { re: /\.(xlsx?|csv|numbers|tsv)$/i, label: 'Excel 表格', icon: '📊', color: '#4ade80' },
  { re: /\.(docx?|pages|rtf)$/i, label: 'Word 文档', icon: '📄', color: '#60a5fa' },
  { re: /\.(pptx?|key)$/i, label: '演示文稿', icon: '📽️', color: '#fb923c' },
  { re: /\.pdf$/i, label: 'PDF', icon: '📕', color: '#ef4444' },
  { re: /\.(png|jpe?g|webp|gif|avif|svg|heic)$/i, label: '图片', icon: '🖼️', color: '#a78bfa' },
  { re: /\.(zip|rar|7z|tar|gz)$/i, label: '压缩包', icon: '🗜️', color: '#fbbf24' },
  { re: /\.(mp4|mov|webm|m4v|avi)$/i, label: '视频', icon: '🎬', color: '#f472b6' },
  { re: /\.(mp3|wav|m4a|flac|aac)$/i, label: '音频', icon: '🎵', color: '#34d399' },
  { re: /\.(md|txt)$/i, label: '文本', icon: '📝', color: '#94a3b8' },
  {
    re: /\.(html?|css|js|mjs|ts|tsx|jsx|py|go|rs|java|json|ya?ml|toml|sh|swift|kt)$/i,
    label: '代码',
    icon: '⌨️',
    color: '#38bdf8',
  },
];

function fileKindOf(filename) {
  for (const k of FILE_KINDS) if (k.re.test(filename)) return k;
  return { label: '文件', icon: '📎', color: '#94a3b8' };
}

function extractFilePaths(text) {
  const src = String(text || '');
  const out = [];
  // 单独成行的路径（允许路径里带空格，比如 "Application Support/Bot Team"）
  for (const line of src.split('\n')) {
    const t = line
      .trim()
      .replace(/^[-*]\s*/, '')
      .replace(/[.,;:!?，。；：、）】》"']+$/, '')
      .trim();
    if (!/^(?:~|\/(?:Users|tmp|private|Volumes|opt|var|home))\//.test(t)) continue;
    if (!/\.[A-Za-z0-9]{1,8}$/.test(t)) continue;
    if (t.length > 400) continue;
    if (!out.includes(t)) out.push(t);
    if (out.length >= 8) break;
  }
  // 正文里夹着的、没有空格的路径
  FILE_PATH_RE.lastIndex = 0;
  let m;
  while ((m = FILE_PATH_RE.exec(src))) {
    let p = m[0].replace(/[.,;:!?，。；：、）】》"']+$/, '');
    if (!p) continue;
    if (!out.includes(p)) out.push(p);
    if (out.length >= 8) break;
  }
  return out;
}

// 单独成行的绝对路径（没有扩展名，多半是目录）
function extractDirPaths(text) {
  const src = String(text || '');
  const out = [];
  let inFence = false;
  for (const line of src.split('\n')) {
    const t = line.trim();
    if (/^```/.test(t)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const bare = t.replace(/^[-*]\s*/, '').replace(/[.,;:!?，。；：、]+$/, '').trim();
    if (!/^(?:~|\/(?:Users|tmp|private|Volumes|opt|var|home))\//.test(bare)) continue;
    if (/\.[A-Za-z0-9]{1,8}$/.test(bare)) continue;
    if (bare.length < 6 || bare.length > 400) continue;
    if (/[，。；：！？]/.test(bare)) continue;
    if (!out.includes(bare)) out.push(bare);
    if (out.length >= 6) break;
  }
  return out;
}

// 正文里单独成行的本地路径，交给下面的文件卡片展示，正文里不再重复一大串路径
function stripFileLines(text, paths) {
  const src = String(text || '');
  if (!paths?.length) return src;
  const set = new Set(paths);
  const isPathLine = (line) => {
    const bare = String(line)
      .trim()
      .replace(/^[-*]\s*/, '')
      .replace(/^[*_`]+|[*_`]+$/g, '')
      .replace(/[.。,;:!?，；：、]+$/, '')
      .trim();
    if (!bare) return false;
    if (set.has(bare)) return true;
    return (
      /^(?:~|\/(?:Users|tmp|private|Volumes|opt|var|home))\//.test(bare) && !/\s/.test(bare)
    );
  };
  const lines = src.split('\n');
  const keep = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const t = raw.trim();
    if (/^```/.test(t)) {
      inFence = !inFence;
      keep.push(raw);
      continue;
    }
    if (inFence) {
      keep.push(raw);
      continue;
    }
    // 「群文件目录：」这类标题（可能被加粗成 **标题：**），如果下面全是路径就整块拿掉
    const head = t.replace(/^[*_`]+|[*_`]+$/g, '').trim();
    if (/[：:]$/.test(head) && head.length <= 32) {
      let j = i + 1;
      let any = false;
      let all = true;
      while (j < lines.length && lines[j].trim() !== '') {
        any = true;
        if (!isPathLine(lines[j])) {
          all = false;
          break;
        }
        j += 1;
      }
      if (any && all) {
        i = j - 1;
        continue;
      }
    }
    if (isPathLine(raw)) continue;
    keep.push(raw);
  }
  return keep.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function dedupeByBase(paths) {
  const seen = new Set();
  const out = [];
  for (const p of paths || []) {
    const base = String(p).split('/').pop();
    if (seen.has(base)) continue;
    seen.add(base);
    out.push(p);
  }
  return out;
}

function fileCardsHtml(paths) {
  if (!paths?.length) return '';
  return `<div class="file-cards">${paths
    .map((p) => {
      const kind = fileKindOf(p);
      const name = p.split('/').pop();
      return `<div class="file-card" data-file="${esc(p)}" data-label="${esc(kind.label)}"${
        /\.[A-Za-z0-9]{1,8}$/.test(p) ? '' : ' data-nonext="1"'
      } style="--fc:${kind.color}">
        <span class="fc-icon">${kind.icon}</span>
        <span class="fc-main">
          <span class="fc-name" title="${esc(p)}">${esc(name)}</span>
          <span class="fc-type"><span class="fc-dot"></span>${esc(kind.label)}<span class="fc-size"></span></span>
        </span>
        <span class="fc-actions">
          <button type="button" class="fc-open" data-file-menu>打开方式 ▾</button>
          <div class="fc-menu" hidden>
            <button type="button" data-file-act="open">打开</button>
            <button type="button" data-file-act="reveal">在访达中显示</button>
            <button type="button" data-file-act="copy">复制路径</button>
          </div>
        </span>
      </div>`;
    })
    .join('')}</div>`;
}

async function openLocalFile(filePath, action = 'open') {
  try {
    await api(`/api/files/${action}`, { method: 'POST', body: { path: filePath } });
  } catch (e) {
    toast(`打不开：${e.message}`, 'err');
  }
}

// 卡片先渲染出来，再批量问一次文件是否还在、多大，避免每条消息都发请求。
async function hydrateFileCards() {
  const cards = [...document.querySelectorAll('#thread .file-card[data-file]')].filter(
    (c) => !c.dataset.checked
  );
  if (!cards.length) return;
  S.fileInfo ||= new Map();
  const missing = [];
  for (const c of cards) {
    const p = c.dataset.file;
    if (!S.fileInfo.has(p)) missing.push(p);
    c.dataset.checked = '1';
  }
  if (missing.length) {
    try {
      const r = await api('/api/files/check', { method: 'POST', body: { paths: missing } });
      for (const f of r.files || []) S.fileInfo.set(f.path, f);
    } catch {}
  }
  for (const c of cards) {
    const info = S.fileInfo.get(c.dataset.file);
    if (!info) continue;
    if (!info.exists && c.dataset.nonext) {
      c.remove();
      continue;
    }
    c.classList.toggle('missing', !info.exists);
    if (info.exists && info.isDir) {
      c.classList.add('is-dir');
      const icon = c.querySelector('.fc-icon');
      if (icon) icon.textContent = '📁';
      const type = c.querySelector('.fc-type');
      if (type) type.innerHTML = '<span class="fc-dot"></span>文件夹';
      const btn = c.querySelector('[data-file-menu]');
      if (btn) btn.textContent = '在访达中显示 ▾';
      continue;
    }
    const size = c.querySelector('.fc-size');
    if (size) {
      size.textContent = info.exists
        ? ` · ${info.size >= 1024 * 1024 ? `${(info.size / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(info.size / 1024))} KB`}`
        : ' · 文件不在了';
    }
  }
}

function closeFileMenus(except = null) {
  document.querySelectorAll('#thread .fc-menu').forEach((m) => {
    if (m !== except) m.hidden = true;
  });
}

function fileMenuPortal() {
  let m = document.getElementById('fileMenuPortal');
  if (m) return m;
  m = document.createElement('div');
  m.id = 'fileMenuPortal';
  m.className = 'fc-menu fc-portal';
  m.hidden = true;
  document.body.appendChild(m);
  m.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-file-act]');
    if (!act) return;
    const p = m.dataset.file || '';
    const kind = act.dataset.fileAct;
    m.hidden = true;
    if (!p) return;
    if (kind === 'copy') {
      try {
        await navigator.clipboard.writeText(p);
        toast('路径已复制');
      } catch {
        toast('复制失败', 'err');
      }
    } else if (kind === 'preview') {
      openFileInPane(p);
    } else {
      openLocalFile(p, kind === 'reveal' ? 'reveal' : 'open');
    }
  });
  return m;
}

function openFileMenu(card, btn) {
  const m = fileMenuPortal();
  m.dataset.file = card.dataset.file || '';
  const isDir = card.classList.contains('is-dir');
  m.innerHTML = `${
    isDir ? '' : '<button type="button" data-file-act="preview">在右侧查看</button>'
  }
    <button type="button" data-file-act="open">打开</button>
    <button type="button" data-file-act="reveal">在访达中显示</button>
    <button type="button" data-file-act="copy">复制路径</button>`;
  m.hidden = false;
  const r = btn.getBoundingClientRect();
  const width = 158;
  const left = Math.max(8, Math.min(window.innerWidth - width - 8, r.right - width));
  const top = Math.min(window.innerHeight - 132, r.bottom + 6);
  m.style.left = `${left}px`;
  m.style.top = `${top}px`;
}

function isLocalLinkHref(rawHref) {
  const target = String(rawHref || '').trim();
  if (!target || target.startsWith('#') || /^(mailto:|tel:|javascript:)/i.test(target)) return false;
  if (/^https?:\/\//i.test(target)) {
    if (!target.startsWith(location.origin + '/')) return false;
    const rel = target.slice(location.origin.length + 1);
    return !rel.startsWith('api/') && !rel.startsWith('uploads/');
  }
  return true;
}

async function openLocalLinkHref(rawHref) {
  let target = String(rawHref || '').trim();
  if (!isLocalLinkHref(target)) return false;
  if (/^https?:\/\//i.test(target)) target = target.slice(location.origin.length + 1);
  if (/^file:\/\//i.test(target)) {
    target = target.replace(/^file:\/\//i, '');
    if (/^\/[A-Za-z]:[\\/]/.test(target)) target = target.slice(1);
  }
  try {
    target = decodeURIComponent(target);
  } catch {}
  if (/^([A-Za-z]:[\\/]|\\\\|\/|~[\\/])/.test(target)) {
    await openFileInPane(target);
    return true;
  }
  try {
    const files = await findLocalFiles(target);
    if (files.length) {
      await openFileInPane(files[0].path);
    } else {
      toast(`未找到文件：${target}`, 'err');
    }
  } catch (e) {
    toast(`打不开：${e.message}`, 'err');
  }
  return true;
}

function bindFileCards() {
  const thread = $('#thread');
  if (!thread) return;
  thread.addEventListener('click', async (e) => {
    const ref = e.target.closest('.file-ref');
    if (ref) {
      e.preventDefault();
      if (ref.dataset.btFile) openLocalFile(ref.dataset.btFile, 'open');
      return;
    }
    const mdLink = e.target.closest('.msg-text a');
    if (mdLink) {
      const rawHref = mdLink.getAttribute('href') || '';
      if (isLocalLinkHref(rawHref)) {
        e.preventDefault();
        openLocalLinkHref(rawHref);
        return;
      }
    }
    const card = e.target.closest('.file-card');
    const menuBtn = e.target.closest('[data-file-menu]');
    if (menuBtn && card) {
      e.stopPropagation();
      openFileMenu(card, menuBtn);
      return;
    }
    const act = e.target.closest('[data-file-act]');
    if (act && card) {
      const p = card.dataset.file;
      const kind = act.dataset.fileAct;
      closeFileMenus();
      if (kind === 'copy') {
        try {
          await navigator.clipboard.writeText(p);
          toast('路径已复制');
        } catch {
          toast('复制失败', 'err');
        }
      } else {
        openLocalFile(p, kind === 'reveal' ? 'reveal' : 'open');
      }
      return;
    }
    closeFileMenus();
    const portal = document.getElementById('fileMenuPortal');
    if (portal) portal.hidden = true;
  });
  setInterval(() => {
  document.querySelectorAll('.typing-text[data-start]').forEach((el) => {
    const secs = Math.max(0, Math.floor((Date.now() - Number(el.dataset.start)) / 1000));
    const span = el.querySelector('.typing-elapsed');
    if (span) span.textContent = ` · ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
  });
}, 1000);

document.addEventListener('click', (e) => {
    const portal = document.getElementById('fileMenuPortal');
    if (!portal || portal.hidden) return;
    if (portal.contains(e.target)) return;
    if (e.target.closest('[data-file-menu]')) return;
    portal.hidden = true;
  });
  thread.addEventListener('scroll', () => {
    const portal = document.getElementById('fileMenuPortal');
    if (portal) portal.hidden = true;
  });
  window.addEventListener('resize', () => {
    const portal = document.getElementById('fileMenuPortal');
    if (portal) portal.hidden = true;
  });
}

function msgHtml(m) {
  if (m.type === 'system') return `<div class="sys">${esc(m.text)}</div>`;

  if (m.type === 'process' || m.type === 'error' || m.type === 'alert') {
    const who = botById(m.senderId)?.name || '';
    return `<div class="proc ${m.type}">
      <span class="proc-dot"></span>
      ${who ? `<span class="proc-who">${esc(who)}</span>` : ''}
      <span class="proc-text">${esc(m.text)}</span>
      <span class="proc-time" title="${esc(fullTime(m.ts))}">${timeLabel(m.ts)}</span>
    </div>`;
  }

  if (m.type === 'thinking') {
    const who = botById(m.senderId)?.name || '';
    const key = `${m.id}:proc`;
    const open = S.thinkState?.[key] ?? false;
    return `<details class="proc-thinking" data-think-key="${esc(key)}" ${open ? 'open' : ''}>
      <summary>${who ? `${esc(who)} · ` : ''}思考过程 · ${fmt(
      (m.text || '').length
    )} 字</summary>
      <div class="proc-thinking-body">${esc(m.text)}</div>
    </details>`;
  }

  if (m.type === 'handoff' || m.meta?.handoff) return handoffCardHtml(m);

  const leaderId = S.settings?.leaderId;
  const chat = chatById(m.chatId);
  // 只有「老板在群里以领导名义发言」才是老板说的话；领导自己的回复永远算 Bot 说的。
  // 以前只看 senderId，会在多 Bot 私聊里把领导的回复也画成「我」。
  const asLeader = !!leaderId && m.senderId === leaderId && m.meta?.viaUser === true;
  if (m.senderId === 'user' || asLeader) {
    const bot = asLeader ? botById(leaderId) : null;
    return `
      <div class="msg user ${isFresh(m.ts) ? 'fresh' : ''}" data-msg="${m.id}">
        ${bot ? avatarFor(bot) : ''}
        <div class="msg-body">
          <div class="msg-name">${bot ? esc(botDisplayName(bot, chat)) : '我'} <span class="msg-time" title="${esc(
      fullTime(m.ts)
    )}">${timeLabel(m.ts)}</span>${actionsHtml(m)}</div>
          <div class="msg-line">
            <div class="bubble">${attachmentsHtml(m.attachments)}<div class="msg-text md">${renderMarkdownCached(
              m.text,
              m.id
            )}</div>${fileCardsHtml(extractFilePaths(m.text))}</div>
          </div>
        </div>
      </div>`;
  }

  const bot = botById(m.senderId) || { name: '未知', emoji: '❔', color: '#666' };
  const thinkKey = `${m.id}:meta`;
  const thinkOpen = S.thinkState?.[thinkKey] ?? false;
  const thinking =
    chatById(m.chatId)?.type !== 'group' && m.meta?.thinking
      ? `<details class="thinking" data-think-key="${esc(
          thinkKey
        )}" ${thinkOpen ? 'open' : ''}><summary>${
          m.meta.thinkingKind === 'steps' ? '执行过程' : '思考过程'
        } <span class="thinking-count">${fmt(
          m.meta.thinking.length
        )} 字</span></summary><div class="thinking-body">${esc(m.meta.thinking)}</div></details>`
      : '';
  return `
    <div class="msg ${isFresh(m.ts) ? 'fresh' : ''}" data-msg="${m.id}">
      ${avatarFor(bot, '', true)}
      <div class="msg-body">
        <div class="msg-name">${esc(botDisplayName(bot, chat))} <span class="msg-time" title="${esc(
  fullTime(m.ts)
)}">${timeLabel(m.ts)}</span>${actionsHtml(m)}</div>
        ${quotaLine(m.meta, bot)}
        <div class="msg-line">
          <div class="bubble">${thinking}<div class="msg-text md">${renderMarkdownCached(
            stripFileLines(m.text, [
              ...extractFilePaths(m.text),
              ...extractDirPaths(m.text),
            ]),
            m.id
          )}</div>${fileCardsHtml(
            dedupeByBase([...new Set([...extractFilePaths(m.text), ...extractDirPaths(m.text)])])
          )}</div>
        </div>
      </div>
    </div>`;
}

function typingHtml() {
  const chatId = S.activeChatId;
  const running = Object.values(S.status[chatId] || {});
  if (!running.length) return '';
  const names = running
    .map((s) => botDisplayName(botById(s.botId), chatById(chatId)) || s.name)
    .filter(Boolean);
  const avatars = running
    .slice(0, 4)
    .map((s) => {
      const bot = botById(s.botId);
      return bot ? avatarFor(bot) : '';
    })
    .join('');
  const anyQueued = running.some((s) => s.queued);
  const started = Math.min(
    ...running.map((s) => Number(s.startedAt) || Date.now())
  );
  const secs = Math.max(0, Math.floor((Date.now() - started) / 1000));
  const elapsed = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
  const preview =
    [...running]
      .reverse()
      .map((s) => s.preview || '')
      .find(Boolean) || '';
  const live =
    [...running]
      .reverse()
      .map((s) => s.live || '')
      .find(Boolean) || '';
  const liveTitle = running.some((s) => s.thinking) ? '思考过程' : '执行过程';
  return `
    <div class="typing">
      <div class="typing-avatars">${avatars}</div>
      <div class="typing-main">
        <div class="typing-text" data-start="${started}">${
          anyQueued
            ? `${running.length > 1 ? `${running.length} 位成员` : esc(names[0] || '成员')} 排队中，上一个任务还没结束…`
            : running.length > 1
              ? `${running.length} 位成员正在准备回复`
              : `${esc(names[0] || '成员')} 正在准备回复`
        }<span class="typing-elapsed"> · ${elapsed}</span>
          <span class="dots"><i></i><i></i><i></i></span>
        </div>
        ${
          live
            ? `<details id="liveThink" class="proc-thinking live-think" ${
                S.liveOpen !== false ? 'open' : ''
              }>
                 <summary>${esc(liveTitle)} · <span id="liveThinkCount">${fmt(
                   live.length
                 )}</span> 字（进行中）</summary>
                 <div class="proc-thinking-body" id="liveThinkBody">${esc(live)}</div>
               </details>`
            : preview
              ? `<div class="typing-preview">${esc(preview.slice(-96))}</div>`
              : ''
        }
      </div>
    </div>`;
}

// 只替换输入中的占位块，避免每秒整页重绘
function updateTyping() {
  const t = $('#thread');
  if (!t) return;
  const old = t.querySelector('.typing');
  const run = Object.values(S.status[S.activeChatId] || {});
  const live =
    [...run].reverse().map((s) => s.live || '').find(Boolean) || '';
  // 已有卡片时只更新内容，保留展开状态和滚动位置
  if (old && live) {
    const body = old.querySelector('#liveThinkBody');
    const count = old.querySelector('#liveThinkCount');
    if (body) {
      const nearBottom =
        body.scrollHeight - body.scrollTop - body.clientHeight < 30;
      body.textContent = live;
      if (nearBottom) body.scrollTop = body.scrollHeight;
      if (count) count.textContent = fmt(live.length);
      const started = Number(old.querySelector('.typing-text')?.dataset.start) || Date.now();
      const secs = Math.max(0, Math.floor((Date.now() - started) / 1000));
      const elapsed = old.querySelector('.typing-elapsed');
      if (elapsed)
        elapsed.textContent = ` · ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
      return;
    }
  }
  if (old) old.remove();
  const html = typingHtml();
  if (html) t.insertAdjacentHTML('beforeend', html);
}

function renderMessages(msgs) {
  const parts = [];
  for (let i = 0; i < msgs.length; ) {
    const m = msgs[i];
    if (m.type === 'process') {
      const group = [];
      while (i < msgs.length && msgs[i].type === 'process') group.push(msgs[i++]);
      if (group.length === 1) {
        parts.push(msgHtml(group[0]));
        continue;
      }
      const key = `procgroup:${group[0].id}`;
      const open = S.thinkState?.[key] ?? false;
      parts.push(`<details class="proc-group" data-think-key="${esc(key)}" ${
        open ? 'open' : ''
      }>
        <summary>执行过程 · ${group.length} 步 <span class="proc-group-time">${timeRange(
          group[0].ts,
          group[group.length - 1].ts
        )}</span></summary>
        <div class="proc-group-body">${group.map(msgHtml).join('')}</div>
      </details>`);
      continue;
    }
    parts.push(msgHtml(m));
    i++;
  }
  return parts.join('');
}

function renderThread() {
  const chat = activeChat();
  if (!chat) {
    $('#thread').innerHTML = '';
    $('#composer').hidden = true;
    $('#scrollDown').hidden = true;
    closeSlash();
    closeMention();
    $('#effortPop').hidden = true;
    $('#modelPop').hidden = true;
    $('#modelBtn').hidden = true;
    // 没有打开会话时也保留一个顶部按钮，保证侧栏能收能开
    const head = $('#chatHead');
    head.hidden = false;
    head.classList.add('head-minimal');
    head.innerHTML = `<button class="icon-btn head-collapse" id="collapseSidebar" type="button" title="收起侧栏" aria-label="收起侧栏">
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m15 6-6 6 6 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </button>`;
    bindSidebarToggle();
    return;
  }

  const msgs = S.messages[chat.id] || [];
  const t = $('#thread');
  $('#chatHead').hidden = false;
  $('#composer').hidden = false;
  const nearBottom = t.scrollHeight - t.scrollTop - t.clientHeight < 160;
  t.innerHTML = renderMessages(msgs) + typingHtml();
  hydrateFileCards();
  if (forceScroll || nearBottom) {
    t.scrollTop = t.scrollHeight;
    $('#scrollDown').hidden = true;
  } else {
    $('#scrollDown').hidden = false;
  }
  forceScroll = false;

  const members = chat.botIds.map(botById).filter(Boolean);
  const lead = botById(chat.leadId) || members[0];
  const stack =
    members
      .slice(0, 3)
      .map((b) => avatarFor(b))
      .join('') +
    (members.length > 3 ? `<div class="more">+${members.length - 3}</div>` : '');
  const wfLive = chat.workflow && ['running', 'draining'].includes(chat.workflow.status);
  const wfNode = wfLive
    ? chat.workflow.nodes?.find((n) => n.id === chat.workflow.currentNodeId)
    : null;
  const wfBot = wfNode ? botById(wfNode.botId) : null;
  const groupSub = wfLive
    ? `<span class="chat-flow-live"><i></i>${
        chat.workflow.status === 'draining' ? '收尾中' : '流程运行中'
      } · 第 ${Number(chat.workflow.round) || 1} 轮 · ${esc(
        wfNode?.title || '进行中'
      )}${wfBot ? ` · ${esc(wfBot.name)}` : ''}</span>`
    : `${members.length} 位成员 · 默认 ${esc(
        botById(chat.leadId)?.name || members.find((b) => b.id !== S.settings?.leaderId)?.name || '接单成员'
      )} 接单`;

  $('#chatHead').classList.remove('head-minimal');
  $('#chatHead').innerHTML = `
    <button class="icon-btn head-collapse" id="collapseSidebar" type="button" title="收起侧栏" aria-label="收起侧栏">
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m15 6-6 6 6 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </button>
    <div class="head-avatars">${stack || '<div class="avatar" style="background:#2a2c33">💬</div>'}</div>
    <div class="head-text">
      <div class="chat-title">${
        chat.type === 'dm'
          ? esc(botDisplayName(botById(chat.botIds[0]), chat) || chat.title)
          : esc(chat.title)
      }</div>
      <div class="chat-sub">${
        chat.type === 'dm'
          ? `项目：${esc(chat.project || '默认项目')} · 额度：${esc(lead?.quota || '未配置')}`
          : groupSub
      }</div>
    </div>
    <div class="head-actions">
      <div class="head-tools">
        <button class="tb-btn" id="browserToggle" type="button" title="内置浏览器">
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle cx="12" cy="12" r="8.2" stroke="currentColor" stroke-width="1.6"/>
            <path d="M3.8 12h16.4M12 3.8c2.2 2.2 3.3 5 3.3 8.2s-1.1 6-3.3 8.2c-2.2-2.2-3.3-5-3.3-8.2s1.1-6 3.3-8.2Z"
              stroke="currentColor" stroke-width="1.4"/>
          </svg>
        </button>
        <span class="conn-pill" id="connPill" data-state="on"><i></i><span id="connText">在线</span></span>
      </div>
      ${
        isLeaderDmChat(chat.id)
          ? `<button class="ghost-btn" id="targetBtn" title="指定这条任务针对的群聊 / Bot / 项目">定位</button>`
          : ''
      }
      ${
        isLeaderDmChat(chat.id)
          ? `<button class="ghost-btn drain-head-btn" id="drainBtn" title="让领导 Bot 协调正在运行的流程收尾">平滑结束${
              runningWorkflowChats().length ? `<i>${runningWorkflowChats().length}</i>` : ''
            }</button>`
          : ''
      }
      ${
        chat.type === 'dm'
          ? `<button class="ghost-btn" id="projectBtn">项目</button>`
          : `<button class="ghost-btn ${
              ['running', 'draining'].includes(chat.workflow?.status) ? 'workflow-on' : ''
            }" id="workflowBtn">${
              chat.workflow?.status === 'draining'
                ? '收尾中'
                : chat.workflow?.status === 'running'
                  ? '流程运行中'
                  : chat.workflow?.resume?.nodeId
                    ? '流程 · 可继续'
                    : '流程'
            }</button>`
      }
      <button class="ghost-btn" id="chatSettings">${
        chat.type === 'dm' ? 'Bot 设置' : '群设置'
      }</button>
      <button class="ghost-btn" id="closeChat">关闭</button>
    </div>`;

  $('#browserToggle').onclick = () => setBrowserOpen(!B.open);
  $('#browserToggle').classList.toggle('active', B.open);
  syncConnUI();
  bindSidebarToggle();
  const freshChat = () => chatById(chat.id) || chat;
  if ($('#projectBtn')) $('#projectBtn').onclick = () => openProjectManager(freshChat());
  if ($('#workflowBtn')) $('#workflowBtn').onclick = () => openWorkflow(freshChat());
  if ($('#drainBtn')) $('#drainBtn').onclick = () => openDrainPicker();
  if ($('#targetBtn')) $('#targetBtn').onclick = () => openTargetPicker();
  $('#chatSettings').onclick = () => {
    const c = freshChat();
    return c.type === 'dm' ? editBot(c.botIds[0]) : editGroup(c);
  };
  $('#closeChat').onclick = () => {
    stashComposerDraft();
    const inp = $('#input');
    if (inp) {
      inp.value = '';
      inp.style.height = 'auto';
    }
    S.activeChatId = null;
    S.pendingAttachments = [];
    renderAttachChips();
    closeSlash();
    renderSidebar();
    renderThread();
  };
  syncSendState();
  renderEffort();
  renderModelPill();
}

/* ---------------- chat open ---------------- */

// 输入框草稿按会话存，不跟人走：在哪个群/项目输入，就留在那个群/项目。
function stashComposerDraft(chatId = S.activeChatId) {
  if (!chatId) return;
  const input = $('#input');
  const text = input ? input.value : '';
  if (text) S.drafts[chatId] = text;
  else delete S.drafts[chatId];
  if ((S.pendingAttachments || []).length) S.attachDrafts[chatId] = S.pendingAttachments.slice();
  else delete S.attachDrafts[chatId];
  persistDrafts();
}

function restoreComposerDraft(chatId) {
  const input = $('#input');
  if (input) {
    input.value = S.drafts[chatId] || '';
    input.style.height = 'auto';
    const max = Math.min(420, Math.round(window.innerHeight * 0.42));
    input.style.height = `${Math.min(input.scrollHeight || 0, max)}px`;
  }
  S.pendingAttachments = (S.attachDrafts[chatId] || []).slice();
  renderAttachChips();
  syncSendState();
}

function clearComposerDraft(chatId) {
  if (!chatId) return;
  delete S.drafts[chatId];
  delete S.attachDrafts[chatId];
  persistDrafts();
}

async function openChat(chatId) {
  stashComposerDraft();
  S.activeChatId = chatId;
  S.pendingAttachments = [];
  S.target = null;
  renderTargetChip();
  renderAttachChips();
  forceScroll = true;
  closeSlash();
  closeMention();
  const current = chatById(chatId);
  const b = current?.type === 'dm' ? botById(current.botIds[0]) : null;
  if (b && b.lastChatId !== chatId) {
    b.lastChatId = chatId;
    api(`/api/bots/${b.id}`, { method: 'PATCH', body: { lastChatId: chatId } }).catch(() => {});
  }
  if (b?.alert && (!b.alert.chatId || current.linkedGroupId === b.alert.chatId)) {
    b.alert = null;
    renderSidebar();
    api(`/api/bots/${b.id}`, { method: 'PATCH', body: { alert: null } }).catch(() => {});
  }
  renderSidebar();
  const { messages } = await api(`/api/chats/${chatId}`);
  S.messages[chatId] = messages;
  renderThread();
  restoreComposerDraft(chatId);
  $('#input').focus();
}

async function openBot(botId) {
  const listFor = () =>
    S.chats
      .filter((c) => c.type === 'dm' && (c.botIds || []).includes(botId))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  let bot = botById(botId);
  let chats = listFor();
  // 首屏数据还没到时点进来，先补拉一次，避免误建一个空的「默认项目」
  if (!chats.length) {
    try {
      const fresh = await api('/api/bootstrap');
      S.chats = fresh.chats || S.chats;
      S.bots = fresh.bots || S.bots;
      bot = botById(botId) || bot;
      chats = listFor();
    } catch {}
  }
  let chat = chats.find((c) => c.id === bot?.lastChatId) || chats[0];
  if (!chat) {
    chat = await api('/api/chats', {
      method: 'POST',
      body: { type: 'dm', title: botById(botId)?.name || '私聊', botIds: [botId], project: '默认项目' },
    });
    S.chats = S.chats.filter((c) => c.id !== chat.id);
    S.chats.push(chat);
  }
  openChat(chat.id);
}

/* ---------------- projects ---------------- */

function dmProjectLabel(chat) {
  const bot = botById(chat?.botIds?.[0]);
  return `${bot ? botDisplayName(bot, chat) : 'Bot'} · ${chat?.project || '默认项目'}`;
}

function botProjects(botId) {
  return S.chats
    .filter((c) => c.type === 'dm' && (c.botIds || []).includes(botId))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

function projectRows(projects, activeId, withRead = false, withDelete = true, labeled = false) {
  if (!projects.length) return '<div class="muted" style="padding:8px 4px">还没有项目</div>';
  return projects
    .map((c) => {
      const time = c.updatedAt
        ? new Date(c.updatedAt).toLocaleString('zh-CN', {
            month: 'numeric',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
          })
        : '';
      return `<div class="project-row ${c.id === activeId ? 'active' : ''}">
        <button class="project-main" data-open-project="${c.id}">
          <span class="project-name">${esc(labeled ? dmProjectLabel(c) : c.project || '默认项目')}</span>
          <span class="project-meta">${c.linkedGroupId ? '关联群 · ' : ''}${esc(time)}${
            c.id === activeId ? ' · 当前' : ''
          }</span>
        </button>
        ${
          withRead && c.id !== activeId
            ? `<button class="project-read" data-read-project="${c.id}" title="让当前 Bot 读取这个项目">读取</button>`
            : ''
        }
        ${
          withDelete && !c.linkedGroupId
            ? `<button class="project-del" data-del-project="${c.id}" title="删除项目">×</button>`
            : ''
        }
      </div>`;
    })
    .join('');
}

function openProjectManager(chat) {
  const bot = botById(chat.botIds[0]);
  if (!bot) return;
  const projects = botProjects(bot.id);
  openModal(`
    <h3>${esc(botDisplayName(bot, chat))} 的项目</h3>
    <div class="field">
      <label>项目</label>
      <div class="project-list">${projectRows(projects, chat.id, true)}</div>
      <div class="field-hint">每个项目是独立聊天和独立会话，默认互不读取；点「读取」可以把该项目记录带进当前对话。</div>
    </div>
    <div class="field">
      <label>新建项目</label>
      <div class="project-new">
        <input id="pName" placeholder="比如 小红书选题、官网改版" maxlength="40" />
        <button class="btn primary" id="pCreate" type="button">新建</button>
      </div>
    </div>
    <div class="modal-actions">
      <button class="btn" id="pCancel">关闭</button>
    </div>`);
  $('#pCancel').onclick = closeModal;
  $('#pCreate').onclick = () => createProject(bot, chat);
  $('#pName').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      createProject(bot, chat);
    }
  });
  const list = document.querySelector('#modal .project-list');
  list.onclick = async (e) => {
    const open = e.target.closest('[data-open-project]');
    if (open) {
      closeModal();
      openChat(open.dataset.openProject);
      return;
    }
    const read = e.target.closest('[data-read-project]');
    if (read) {
      insertReadDirective(read.dataset.readProject);
      return;
    }
    const del = e.target.closest('[data-del-project]');
    if (del) {
      const c = chatById(del.dataset.delProject);
      if (!c) return;
      if (!confirm(`删除项目「${c.project || '默认项目'}」和它的全部聊天记录？`)) return;
      try {
        await api(`/api/chats/${c.id}`, { method: 'DELETE' });
        S.chats = S.chats.filter((x) => x.id !== c.id);
        if (S.activeChatId === c.id) S.activeChatId = null;
        const next = botProjects(bot.id)[0];
        closeModal();
        renderSidebar();
        if (next) openChat(next.id);
        else renderThread();
      } catch (err) {
        toast(`删除失败：${err.message}`, 'err');
      }
    }
  };
  setTimeout(() => $('#pName')?.focus(), 0);
}

async function createProject(bot, currentChat) {
  const name = $('#pName').value.trim();
  if (!name) return toast('先给项目起个名字', 'err');
  if (botProjects(bot.id).some((c) => (c.project || '默认项目') === name)) {
    return toast('这个项目已经存在', 'err');
  }
  try {
    const chat = await api('/api/chats', {
      method: 'POST',
      body: {
        type: 'dm',
        title: bot.name,
        botIds: [bot.id],
        project: name,
      },
    });
    S.chats = S.chats.filter((c) => c.id !== chat.id);
    S.chats.push(chat);
    closeModal();
    renderSidebar();
    openChat(chat.id);
  } catch (err) {
    toast(`新建失败：${err.message}`, 'err');
  }
}

function insertReadDirective(chatId) {
  const c = chatById(chatId);
  if (!c) return;
  closeModal();
  const input = $('#input');
  const text = `读取项目「${dmProjectLabel(c)}」：`;
  input.value = text;
  input.focus();
  input.setSelectionRange(text.length, text.length);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function openReadPicker() {
  const projects = S.chats
    .filter((c) => c.type === 'dm' && c.id !== S.activeChatId)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  openModal(`
    <h3>读取其他项目</h3>
    <div class="field">
      <label>选择要带进当前对话的项目</label>
      <div class="project-list">${projectRows(projects, null, false, false, true)}</div>
      <div class="field-hint">只会读取一次，不会把两个项目的聊天合并；默认情况下各项目互不可见。</div>
    </div>
    <div class="modal-actions">
      <button class="btn" id="pCancel">关闭</button>
    </div>`);
  $('#pCancel').onclick = closeModal;
  document.querySelector('#modal .project-list').onclick = (e) => {
    const open = e.target.closest('[data-open-project]');
    if (open) insertReadDirective(open.dataset.openProject);
  };
}


/* ---------------- send ---------------- */

async function send() {
  const chat = activeChat();
  const input = $('#input');
  const text = input.value.trim();
  const attachments = S.pendingAttachments.slice();
  if (!chat || (!text && !attachments.length)) return;
  closeSlash();
  closeMention();
  input.value = '';
  input.style.height = 'auto';
  clearComposerDraft(chat.id);
  S.pendingAttachments = [];
  renderAttachChips();
  syncSendState();
  const scoped = S.target && isLeaderDmChat(chat.id) ? targetRefLine(S.target) : '';
  const outText = scoped ? (text ? `${scoped}\n${text}` : scoped) : text;
  let paneContext = '';
  const selectionContext = S.pendingSelection || (S.selection ? selectionContextText(S.selection) : '');
  S.pendingSelection = '';
  if (!selectionContext && !S.suppressPaneContextOnce) {
    try {
      paneContext = await buildPaneContext();
    } catch {}
  } else if (selectionContext && B.mode === 'file' && B.filePath) {
    paneContext = `【当前打开的文件】\n路径：${B.filePath}\n编辑状态：${
      B.editing ? '正在编辑（可用 editor_read / editor_apply 直接修改编辑器内容）' : '预览'
    }`;
  }
  S.suppressPaneContextOnce = false;
  try {
    await api(`/api/chats/${chat.id}/messages`, {
      method: 'POST',
      body: {
        text: outText,
        attachments,
        context: paneContext,
        selection: selectionContext,
      },
    });
    if (S.selection) clearPaneSelection();
  } catch (e) {
    toast(`发送失败：${e.message}`, 'err');
    input.value = text;
    if (text) S.drafts[chat.id] = text;
    S.pendingAttachments = attachments;
    if (attachments.length) S.attachDrafts[chat.id] = attachments.slice();
    if (selectionContext) S.pendingSelection = selectionContext;
    persistDrafts();
    renderAttachChips();
    syncSendState();
  }
}

function isImageAttachment(a) {
  return (
    /^image\//i.test(a?.mime || '') ||
    /\.(png|jpe?g|webp|gif|avif)$/i.test(a?.name || '') ||
    /\.(png|jpe?g|webp|gif|avif)$/i.test(a?.url || '')
  );
}

async function setChatLoop(enabled) {
  const chat = activeChat();
  if (!chat) return;
  if (chat.type !== 'group') {
    toast('持续运行目前只用于群聊');
    return;
  }
  try {
    await api(`/api/chats/${chat.id}/loop`, {
      method: 'POST',
      body: { enabled: !!enabled },
    });
    chat.loop = !!enabled;
    renderThread();
    renderSidebar();
    toast(enabled ? '已开启持续运行，直到 /stop' : '已停止持续运行');
  } catch (e) {
    toast(`操作失败：${e.message}`, 'err');
  }
}

function renderAttachChips() {
  const box = $('#attachChips');
  if (!box) return;
  const list = S.pendingAttachments || [];
  box.hidden = !list.length;
  box.innerHTML = list
    .map((a, i) => {
      const image = isImageAttachment(a);
      return `<span class="attach-chip">
        ${
          image
            ? `<img src="${esc(a.url)}" alt="" />`
            : `<span class="attach-file-icon">📄</span>`
        }
        <span class="attach-name">${esc(a.name)}</span>
        <span class="attach-size">${fmtSize(a.size)}</span>
        <button type="button" data-remove-attach="${i}" title="移除">×</button>
      </span>`;
    })
    .join('');
}

// 粘贴/拖拽进来的文件常常没有像样的文件名（截图就是 image.png 或空的），
// 这里补一个带时间的名字，附件列表和对话记录里才好认。
function pastedFileName(file, index = 0) {
  const raw = String(file?.name || '').trim();
  const generic =
    !raw || raw === 'blob' || /^image\.(png|jpe?g|webp|gif|avif)$/i.test(raw);
  if (!generic) return raw;
  const now = new Date();
  const stamp = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())} ${pad2(
    now.getHours()
  )}.${pad2(now.getMinutes())}.${pad2(now.getSeconds())}`;
  const mime = String(file?.type || '');
  const ext = /^image\//i.test(mime)
    ? (mime.split('/')[1] || 'png').replace('jpeg', 'jpg')
    : /^application\/pdf$/i.test(mime)
      ? 'pdf'
      : '';
  const suffix = index ? `-${index + 1}` : '';
  return ext ? `粘贴 ${stamp}${suffix}.${ext}` : `粘贴 ${stamp}${suffix}`;
}

function renameFile(file, name) {
  try {
    return new File([file], name, { type: file.type, lastModified: Date.now() });
  } catch {
    return file;
  }
}

async function attachFiles(files, { pasted = false } = {}) {
  const incoming = [...(files || [])];
  const room = Math.max(0, 10 - (S.pendingAttachments || []).length);
  if (room <= 0) {
    toast('一条消息最多 10 个附件', 'err');
    return;
  }
  const list = (pasted ? incoming.map((f, i) => renameFile(f, pastedFileName(f, i))) : incoming).slice(
    0,
    room
  );
  if (!list.length) return;
  const busy = document.createElement('span');
  busy.className = 'attach-chip uploading';
  busy.innerHTML = `<span class="attach-file-icon">⏳</span><span class="attach-name">正在上传 ${list.length} 个文件…</span>`;
  const chips = $('#attachChips');
  if (chips) {
    chips.hidden = false;
    chips.appendChild(busy);
  }
  for (const file of list) {
    try {
      const res = await uploadAnyFile(file);
      S.pendingAttachments.push({
        url: res.url,
        name: res.name || file.name,
        size: res.size || file.size,
        mime: res.mime || file.type || '',
      });
      renderAttachChips();
      syncSendState();
    } catch (e) {
      toast(`上传失败：${e.message}`, 'err');
    }
  }
  busy.remove();
  renderAttachChips();
  syncSendState();
}

// 把文件拖进窗口任意位置都能进附件列表，不用先对准输入框。
function setupFileDrops() {
  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  const show = (on) => {
    document.body.classList.toggle('file-drop-active', on);
    const hint = $('#fileDropHint');
    if (hint) hint.hidden = !on;
    const box = document.querySelector('.composer-box');
    if (box) box.classList.toggle('dragging', on);
  };
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth += 1;
    show(true);
  });
  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (!depth) show(false);
  });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    show(false);
    const files = [...(e.dataTransfer?.files || [])];
    if (!files.length) return;
    // 拖到右侧面板：用文件查看器打开，不当作聊天附件
    const pane = $('#browserPane');
    if (pane && !pane.hidden && B.open) {
      const rect = pane.getBoundingClientRect();
      const inside =
        e.clientX >= rect.left &&
        e.clientX <= rect.right &&
        e.clientY >= rect.top &&
        e.clientY <= rect.bottom;
      if (inside) {
        const p = droppedFilePath(files[0]);
        if (p) {
          openFileInPane(p);
          return;
        }
      }
    }
    if (!activeChat()) {
      toast('先在左边选一个会话，再拖文件进来', 'err');
      return;
    }
    attachFiles(files);
  });
}

// 支持直接 Ctrl/⌘+V 粘贴截图或从访达复制的文件。
// 不再只认输入框：在聊天页粘贴也能进附件，但不会抢输入框、设置面板里的粘贴。
function bindPasteFiles() {
  document.addEventListener('paste', (e) => {
    const dt = e.clipboardData;
    if (!dt) return;
    const files = [...(dt.files || [])];
    if (!files.length) {
      for (const it of [...(dt.items || [])]) {
        if (it.kind !== 'file') continue;
        const f = it.getAsFile();
        if (f) files.push(f);
      }
    }
    if (!files.length) return;
    if ($('#composer')?.hidden) return;
    if ($('#modalMask') && !$('#modalMask').hidden) return;
    const el = document.activeElement;
    const editingElsewhere =
      el && el.id !== 'input' && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
    if (editingElsewhere) return;
    if (!activeChat()) {
      toast('先在左边选一个会话，再粘贴文件', 'err');
      return;
    }
    e.preventDefault();
    attachFiles(files, { pasted: true });
  });
}

const SEND_ICON = `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 12h13M13 6.5 18.5 12 13 17.5" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const STOP_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2.5" fill="currentColor"/></svg>`;

function chatIsBusy() {
  const chat = activeChat();
  if (!chat) return false;
  return Object.values(S.status[chat.id] || {}).some((s) => s && !s.queued);
}

function syncSendState() {
  const btn = $('#sendBtn');
  const steer = $('#steerBtn');
  const hasContent = !!$('#input').value.trim() || !!(S.pendingAttachments || []).length;
  const busy = chatIsBusy();
  if (btn) {
    btn.disabled = !busy && !hasContent;
    btn.classList.toggle('is-stop', busy);
    btn.title = busy ? '打断当前思考' : '发送';
    const want = busy ? STOP_ICON : SEND_ICON;
    if (btn.dataset.icon !== (busy ? 'stop' : 'send')) {
      btn.dataset.icon = busy ? 'stop' : 'send';
      btn.innerHTML = want;
    }
  }
  if (steer) {
    steer.hidden = !busy;
    steer.disabled = !hasContent;
  }
}

async function stopCurrentTurn() {
  const chat = activeChat();
  if (!chat) return;
  try {
    await api(`/api/chats/${chat.id}/stop`, { method: 'POST', body: {} });
    toast('已打断当前思考');
  } catch (e) {
    toast(`打断失败：${e.message}`, 'err');
  }
}

async function steerSend() {
  const chat = activeChat();
  const input = $('#input');
  if (!chat) return;
  const text = input.value.trim();
  const attachments = S.pendingAttachments.slice();
  if (!text && !attachments.length) return;
  input.value = '';
  input.style.height = 'auto';
  clearComposerDraft(chat.id);
  S.pendingAttachments = [];
  renderAttachChips();
  syncSendState();
  try {
    await api(`/api/chats/${chat.id}/steer`, {
      method: 'POST',
      body: { text, attachments },
    });
  } catch (e) {
    input.value = text;
    if (text) S.drafts[chat.id] = text;
    S.pendingAttachments = attachments;
    if (attachments.length) S.attachDrafts[chat.id] = attachments.slice();
    persistDrafts();
    renderAttachChips();
    syncSendState();
    toast(`插话失败：${e.message}`, 'err');
  }
}

/* ---------------- modals ---------------- */

let modalDirty = false;

function openModal(html, cls = '') {
  $('#modal').className = `modal${cls ? ` ${cls}` : ''}`;
  $('#modal').innerHTML = html;
  $('#modalMask').hidden = false;
  modalDirty = false;
}
function closeModal() {
  clearInterval(S.wfPoll);
  S.wfPoll = null;
  clearInterval(S.schPoll);
  S.schPoll = null;
  const skillDetail = document.getElementById('skillDetail');
  if (skillDetail) skillDetail.hidden = true;
  $('#modalMask').hidden = true;
  modalDirty = false;
  S.editingChatId = null;
}

// 点遮罩 / 按 Esc 时，先看看有没有还没保存的改动，别把用户填了一半的表单关掉。
function requestCloseModal() {
  if ($('#modal').classList.contains('welcome')) return;
  if (modalDirty && !$('#modal').classList.contains('usage')) {
    toast('还有没保存的修改，点「保存」或「取消」');
    return;
  }
  closeModal();
}

const DEFAULT_SOURCE_BY_BACKEND = {
  opencode: 'OpenCode Go',
  codex: 'ChatGPT Plus',
  agy: 'Google One',
  codebuddy: 'WorkBuddy 中国版',
  qoder: 'Qoder 中国版',
  claude: 'Claude 订阅',
  custom: '自定义 API',
};

const API_PRESETS = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    base: 'https://api.deepseek.com/v1',
    anthropic: 'https://api.deepseek.com/anthropic',
    model: 'deepseek-flash',
    targets: ['custom', 'codex', 'claude'],
  },
  {
    id: 'openai',
    name: 'OpenAI',
    base: 'https://api.openai.com/v1',
    model: 'gpt-6.1-sol',
    targets: ['custom', 'codex'],
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    base: 'https://api.anthropic.com',
    anthropic: 'https://api.anthropic.com',
    model: 'claude-sonnet-5-5',
    targets: ['custom', 'claude'],
  },
  {
    id: 'kimi',
    name: 'Kimi / Moonshot',
    base: 'https://api.moonshot.cn/v1',
    anthropic: 'https://api.moonshot.cn/anthropic',
    model: 'kimi-k3',
    targets: ['custom', 'claude'],
  },
  {
    id: 'glm',
    name: '智谱 GLM',
    base: 'https://open.bigmodel.cn/api/paas/v4',
    anthropic: 'https://open.bigmodel.cn/api/anthropic',
    model: 'glm-5.3',
    targets: ['custom', 'claude'],
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    base: 'https://api.minimaxi.com/v1',
    model: 'MiniMax-M2.7',
    targets: ['custom'],
  },
  {
    id: 'qwen',
    name: '通义千问 / DashScope',
    base: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen3.8-flash',
    targets: ['custom'],
  },
  {
    id: 'mimo',
    name: '小米 MiMo',
    base: 'https://api.xiaomimimo.com/v1',
    model: 'mimo-v2.6-flash',
    targets: ['custom'],
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    base: 'https://openrouter.ai/api/v1',
    model: 'deepseek/deepseek-chat',
    targets: ['custom'],
  },
  {
    id: 'siliconflow',
    name: 'SiliconFlow',
    base: 'https://api.siliconflow.cn/v1',
    model: 'deepseek-ai/DeepSeek-V3',
    targets: ['custom'],
  },
  {
    id: 'ollama',
    name: '本地 Ollama',
    base: 'http://127.0.0.1:11434/v1',
    model: 'qwen3:8b',
    targets: ['custom'],
  },
  {
    id: 'lmstudio',
    name: '本地 LM Studio',
    base: 'http://127.0.0.1:1234/v1',
    model: 'local-model',
    targets: ['custom'],
  },
];

function sourceMeta(name) {
  return (S.sources || []).find((s) => s.name === String(name || '').trim()) || null;
}

function modelProvider(model) {
  return String(model || '').split('/')[0] || '';
}

// 来源 → 能用的模型（按 provider 前缀过滤）
function modelsFor(backend, sourceName, agyProfileId = '') {
  let all = [];
  if (backend === 'opencode') all = S.models.opencode || [];
  else if (backend === 'agy') {
    all = agyProfileId
      ? Array.isArray(S.agyProfileModels?.[agyProfileId])
        ? S.agyProfileModels[agyProfileId]
        : []
      : S.models.agy || [];
  }
  else if (backend === 'codex') all = (S.models.codex || []).map((m) => m.id);
  else if (backend === 'codebuddy') all = S.models.codebuddy || [];
  else if (backend === 'qoder') all = S.models.qoder || [];
  else if (backend === 'claude')
    all = [
      'claude-sonnet-5-5',
      'claude-opus-5-5',
      'claude-haiku-5-5',
      'sonnet',
      'opus',
      'haiku',
    ];
  const meta = sourceMeta(sourceName);
  if (!meta || !(meta.prefixes || []).length) return all;
  return all.filter((m) => meta.prefixes.includes(modelProvider(m)));
}

async function loadAgyProfileModels(profileId, { switchModel = true, notify = false } = {}) {
  const id = String(profileId || 'default');
  try {
    const r = await api(`/api/agy/profiles/${encodeURIComponent(id)}/models`);
    S.agyProfileModels ||= {};
    S.agyProfileModels[id] = Array.isArray(r.models) ? r.models : [];
    const agySel = $('#fAgyProfile');
    if (!agySel || agySel.value !== id) return S.agyProfileModels[id];
    const model = $('#fModel');
    const list = modelsFor('agy', $('#fSource')?.value || '', id);
    const current = model?.value.trim() || '';
    if (switchModel && model && list.length && (!current || !list.includes(current))) {
      const next = list[0];
      model.value = next;
      model.dispatchEvent(new Event('change', { bubbles: true }));
      toast(`当前账号${current ? `没有 ${current}` : '还没有模型'}，已切换为 ${next}`);
    }
    const datalist = $('#modelList');
    if (datalist) {
      datalist.innerHTML = modelOptions('agy', model?.value.trim() || '', $('#fSource')?.value || '', id);
    }
    if (typeof B.agyRefresh === 'function') B.agyRefresh();
    else B.agyDrawPicker?.();
    if (notify) toast(`已拉取 ${list.length} 个模型`);
    return S.agyProfileModels[id];
  } catch (e) {
    if (notify) toast(`拉取模型失败：${apiErrorText(e)}`, 'err');
    return [];
  }
}

function sourceCoversModel(sourceName, backend, model) {
  if (String(sourceName || '').trim() === '自定义 API') return true;
  const meta = sourceMeta(sourceName);
  if (!meta) return true; // 自定义来源
  if (meta.backend !== backend) return false;
  if (!model) return true;
  if (!(meta.prefixes || []).length) return true;
  return meta.prefixes.includes(modelProvider(model));
}

function sourceForModel(backend, model) {
  if (backend === 'codex') return sourceMeta('ChatGPT Plus');
  if (backend === 'agy') return sourceMeta('Google One');
  if (backend === 'codebuddy') return sourceMeta('WorkBuddy 中国版');
  if (backend === 'qoder') return sourceMeta('Qoder 中国版');
  if (backend === 'claude') return sourceMeta('Claude 订阅');
  if (backend === 'custom') return sourceMeta('自定义 API');
  const p = modelProvider(model);
  if (!p) return null;
  return (
    (S.sources || []).find(
      (s) => s.backend === 'opencode' && (s.prefixes || []).includes(p)
    ) || null
  );
}

async function saveEngineConfig(prefix) {
  const key = prefix === 'tr' ? 'translateConfig' : 'explainConfig';
  const cfg = {
    mode: $(`#${prefix}Mode`)?.value || 'bot',
    botId: $(`#${prefix}Bot`)?.value || '',
    baseUrl: ($(`#${prefix}BaseUrl`)?.value || '').trim(),
    model: ($(`#${prefix}Model`)?.value || '').trim(),
    style: $(`#${prefix}Style`)?.value || 'openai',
  };
  if (cfg.mode === 'custom' && (!cfg.baseUrl || !cfg.model)) {
    toast('自定义 API 需要先填 Base URL 和模型', 'err');
    return;
  }
  const keyInput = $(`#${prefix}ApiKey`);
  if (keyInput && keyInput.value.trim()) cfg.apiKey = keyInput.value.trim();
  try {
    const res = await api('/api/settings', { method: 'PATCH', body: { [key]: cfg } });
    S.settings = res.settings;
    if (keyInput && cfg.apiKey) {
      keyInput.value = '';
      keyInput.placeholder = '已保存 Key，留空不改';
    }
    toast(prefix === 'tr' ? '翻译引擎已保存' : '解释引擎已保存');
  } catch (e) {
    toast(`保存失败：${e.message}`, 'err');
  }
}

async function fetchEngineModels(prefix) {
  const baseUrl = ($(`#${prefix}BaseUrl`)?.value || '').trim();
  if (!baseUrl) return toast('先填 Base URL', 'err');
  const btn = $(`#${prefix}Fetch`);
  if (btn) btn.disabled = true;
  try {
    const r = await api('/api/models/fetch', {
      method: 'POST',
      body: {
        baseUrl,
        key: ($(`#${prefix}ApiKey`)?.value || '').trim(),
        style: $(`#${prefix}Style`)?.value || 'openai',
        botId: $(`#${prefix}Bot`)?.value || '',
      },
    });
    const list = (r.models || []).map((m) => (typeof m === 'string' ? m : m.id)).filter(Boolean);
    const dl = $(`#${prefix}ModelList`);
    if (dl) dl.innerHTML = list.map((m) => `<option value="${esc(m)}"></option>`).join('');
    const input = $(`#${prefix}Model`);
    if (input && !input.value && list.length) input.value = list[0];
    toast(list.length ? `拉到 ${list.length} 个模型，点保存生效` : '没有拉到模型');
  } catch (e) {
    toast(`拉取失败：${e.message}`, 'err');
  } finally {
    if (btn) btn.disabled = false;
  }
}

function wireEngineConfig(prefix) {
  const mode = $(`#${prefix}Mode`);
  const botRow = $(`#${prefix}BotRow`);
  const customRow = $(`#${prefix}CustomRow`);
  const sync = () => {
    if (botRow) botRow.hidden = mode?.value !== 'bot';
    if (customRow) customRow.hidden = mode?.value !== 'custom';
  };
  sync();
  if (mode) {
    mode.onchange = () => {
      sync();
      saveEngineConfig(prefix);
    };
  }
  const bot = $(`#${prefix}Bot`);
  if (bot) bot.onchange = () => saveEngineConfig(prefix);
  for (const id of ['BaseUrl', 'Model', 'ApiKey', 'Style']) {
    const el = $(`#${prefix}${id}`);
    if (el) el.onchange = () => saveEngineConfig(prefix);
  }
  const preset = $(`#${prefix}Preset`);
  if (preset)
    preset.onchange = () => {
      const p = ENGINE_PRESETS[Number(preset.value)];
      if (!p) return;
      const base = $(`#${prefix}BaseUrl`);
      const style = $(`#${prefix}Style`);
      const model = $(`#${prefix}Model`);
      if (base) base.value = p.baseUrl;
      if (style) style.value = p.style;
      if (model && !model.value.trim()) model.value = p.model;
      saveEngineConfig(prefix);
    };
  const fetchBtn = $(`#${prefix}Fetch`);
  if (fetchBtn) fetchBtn.onclick = () => fetchEngineModels(prefix);
}

const ENGINE_PRESETS = [
  { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', style: 'openai', model: 'deepseek-chat' },
  { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', style: 'openai', model: 'gpt-4o-mini' },
  { name: 'Anthropic Claude', baseUrl: 'https://api.anthropic.com', style: 'anthropic', model: 'claude-sonnet-4-5' },
  { name: 'Moonshot / Kimi', baseUrl: 'https://api.moonshot.cn/v1', style: 'openai', model: 'moonshot-v1-8k' },
  { name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', style: 'openai', model: 'glm-4-flash' },
  { name: '阿里通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', style: 'openai', model: 'qwen-plus' },
  { name: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', style: 'openai', model: 'Qwen/Qwen2.5-7B-Instruct' },
  { name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', style: 'openai', model: 'openai/gpt-4o-mini' },
  { name: '本地 Ollama', baseUrl: 'http://127.0.0.1:11434/v1', style: 'openai', model: 'llama3.2' },
];

function engineConfigHtml(prefix, cfg = {}, withFree = false) {
  const p = prefix;
  const mode = cfg.mode || (withFree ? 'free' : 'bot');
  const bots = S.bots.filter((b) => b.api?.baseUrl || b.backend === 'custom');
  const label = prefix === 'tr' ? '翻译引擎' : '解释引擎';
  return `<div class="field">
      <label>${label}</label>
      <select id="${p}Mode">
        ${withFree ? `<option value="free" ${mode === 'free' ? 'selected' : ''}>免费（Google，无需 Key）</option>` : ''}
        <option value="bot" ${mode === 'bot' ? 'selected' : ''}>复制某个 Bot 的 API</option>
        <option value="custom" ${mode === 'custom' ? 'selected' : ''}>自定义 URL + Key + 模型</option>
      </select>
      <div id="${p}BotRow" style="margin-top:8px" ${mode === 'bot' ? '' : 'hidden'}>
        <select id="${p}Bot">
          <option value="">自动选第一个可用的 Bot</option>
          ${bots
            .map(
              (b) =>
                `<option value="${b.id}" ${cfg.botId === b.id ? 'selected' : ''}>${esc(
                  b.name
                )} · ${esc(b.model || b.backend)}</option>`
            )
            .join('')}
        </select>
      </div>
      <div id="${p}CustomRow" style="margin-top:8px" ${mode === 'custom' ? '' : 'hidden'}>
        <select id="${p}Preset" style="margin-bottom:8px">
          <option value="">常用服务商（点选自动填 URL / 模型）</option>
          ${ENGINE_PRESETS.map(
            (x, i) => `<option value="${i}">${esc(x.name)}</option>`
          ).join('')}
        </select>
        <input id="${p}BaseUrl" placeholder="Base URL，例如 https://api.deepseek.com/v1" value="${esc(
          cfg.baseUrl || ''
        )}" />
        <div class="row-2 even" style="margin-top:8px">
          <select id="${p}Style">
            <option value="openai" ${cfg.style !== 'anthropic' ? 'selected' : ''}>OpenAI 兼容</option>
            <option value="anthropic" ${cfg.style === 'anthropic' ? 'selected' : ''}>Anthropic 兼容</option>
          </select>
          <input id="${p}Model" placeholder="模型名，例如 deepseek-flash" value="${esc(
            cfg.model || ''
          )}" list="${p}ModelList" />
        </div>
        <input id="${p}ApiKey" type="password" style="margin-top:8px" placeholder="${
          cfg.hasKey ? '已保存 Key，留空不改' : 'API Key'
        }" />
        <div class="wallpaper-actions" style="margin-top:8px">
          <button type="button" class="btn" id="${p}Fetch">拉取模型</button>
        </div>
        <datalist id="${p}ModelList"></datalist>
      </div>
      <div class="field-hint">翻译/解释可以复制某个 Bot 的 API 配置，也可以直接填自定义 URL、Key 和模型。</div>
    </div>`;
}

function modelOptions(backend, current, sourceName, agyProfileId = '') {
  const list = modelsFor(backend, sourceName, backend === 'agy' ? agyProfileId || 'default' : '');
  if (!list.length) return '';
  if (backend === 'codex') {
    const names = Object.fromEntries((S.models.codex || []).map((m) => [m.id, m.name]));
    return list
      .map(
        (m) =>
          `<option value="${esc(m)}" label="${esc(names[m] || m)}"${
            m === current ? ' selected' : ''
          }></option>`
      )
      .join('');
  }
  return list.map((m) => `<option value="${esc(m)}"${m === current ? ' selected' : ''}></option>`).join('');
}

function botModelError(body) {
  const model = (body.model || '').trim();
  if (!model) return '';
  if (sourceCoversModel(body.source, body.backend, model)) return '';
  const sug = sourceForModel(body.backend, model);
  if (!sug) return ''; // 未知 provider，当作自定义，不拦
  return `模型 ${model} 属于「${sug.name}」，和当前来源「${body.source || '未设置'}」对不上`;
}

const fmt = (n) => Number(n || 0).toLocaleString('en-US');
// 左下角空间很小：大数字用「万 / 亿」，完整数字放到悬停提示里。
const fmtCompact = (n) => {
  const v = Number(n) || 0;
  if (v >= 1e12) return `${Number((v / 1e12).toFixed(2))}万亿`;
  if (v >= 1e8) return `${Number((v / 1e8).toFixed(2))}亿`;
  if (v >= 1e4) return `${Number((v / 1e4).toFixed(1))}万`;
  return fmt(v);
};

function lastNDays(n) {
  const out = [];
  const now = new Date();
  const p = (v) => String(v).padStart(2, '0');
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    out.push(`${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`);
  }
  return out;
}

function usageBlock(bot) {
  const u = { calls: 0, input: 0, output: 0, total: 0, updatedAt: 0, days: {}, ...(bot.usage || {}) };
  const days = u.days || {};
  const keys = lastNDays(7);
  const today = days[keys[keys.length - 1]] || {};
  const week = keys.reduce(
    (acc, k) => {
      const d = days[k] || {};
      acc.calls += d.calls || 0;
      acc.total += d.total || 0;
      return acc;
    },
    { calls: 0, total: 0 }
  );
  const max = Math.max(1, ...keys.map((k) => days[k]?.total || 0));
  const bars = keys
    .map((k) => {
      const d = days[k] || {};
      const h = Math.round(((d.total || 0) / max) * 42);
      return `<div class="bar-wrap" title="${k} · ${fmt(d.total || 0)} tokens · ${d.calls || 0} 次">
        <div class="bar" style="height:${h ? h + 3 : 2}px;opacity:${h ? 1 : 0.25}"></div>
        <div class="bar-label">${k.slice(5)}</div>
      </div>`;
    })
    .join('');

  const when = u.updatedAt ? new Date(u.updatedAt).toLocaleString('zh-CN', { hour12: false }) : '还没用过';
  return `
    <div class="usage">
      <div class="usage-row"><span>今日</span><b>${fmt(today.total || 0)} tokens · ${today.calls || 0} 次</b></div>
      <div class="usage-row"><span>最近 7 天</span><b>${fmt(week.total)} tokens · ${week.calls} 次</b></div>
      <div class="usage-row"><span>累计</span><b>${fmt(u.total)} tokens · ${fmt(u.calls)} 次</b></div>
      <div class="usage-row"><span>输入 / 输出</span><b>${fmt(u.input)} / ${fmt(u.output)}</b></div>
      <div class="chart">${bars}</div>
      <div class="usage-row"><span>最近使用</span><b>${esc(when)}</b></div>
    </div>`;
}

function readPermissionFields(modeSel, writeSel, readSel) {
  const split = (v) =>
    String(v || '')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  return {
    mode: $(modeSel)?.value || 'workspace',
    write: split($(writeSel)?.value),
    read: split($(readSel)?.value),
  };
}

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ''));
    r.onerror = () => reject(r.error || new Error('读取失败'));
    r.readAsDataURL(file);
  });
}

function ensureMarketOverlay() {
  let overlay = $('#marketOverlay');
  if (overlay) return overlay;
  overlay = document.createElement('div');
  overlay.id = 'marketOverlay';
  overlay.className = 'market-overlay';
  overlay.hidden = true;
  overlay.innerHTML = `<div class="market-panel" role="dialog" aria-modal="true">
    <div class="market-head">
      <div>
        <h3 id="marketTitle">源仓头像市场</h3>
        <div class="market-sub">来自 yuancang.me · 点「使用」直接下载到本机并应用</div>
      </div>
      <div class="market-head-actions">
        <a class="btn" id="marketLink" href="https://yuancang.me/wall" target="_blank" rel="noreferrer">在浏览器打开</a>
        <button type="button" class="btn" id="marketClose">关闭</button>
      </div>
    </div>
    <div class="market-toolbar">
      <input id="marketSearch" placeholder="搜索标题、风格、标签…" />
      <div id="marketFilters" class="market-filters"></div>
      <span id="marketCount" class="market-count"></span>
    </div>
    <div id="marketGrid" class="market-grid"></div>
    <button type="button" class="btn market-more" id="marketMore" hidden>加载更多</button>
  </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeMarket();
  });
  $('#marketClose').onclick = () => closeMarket();
  $('#marketMore').onclick = () => {
    S.marketShown = (S.marketShown || 120) + 120;
    renderMarket();
  };
  $('#marketSearch').oninput = () => {
    S.marketQuery = $('#marketSearch').value || '';
    S.marketShown = 120;
    renderMarket();
  };
  $('#marketFilters').onclick = (e) => {
    const btn = e.target.closest('[data-market-type]');
    if (!btn) return;
    S.marketType = btn.dataset.marketType;
    S.marketShown = 120;
    renderMarket();
  };
  $('#marketGrid').onclick = (e) => {
    const btn = e.target.closest('[data-market-use]');
    if (!btn) return;
    const item = (S.marketFiltered || [])[Number(btn.dataset.marketUse)];
    if (item) void useMarketItem(item, btn);
  };
  return overlay;
}

function marketTypeLabel(type) {
  return { avatar: '头像', desktop: '电脑壁纸', phone: '手机壁纸' }[type] || type || '图片';
}

function marketDownloadList() {
  try {
    const raw = JSON.parse(localStorage.getItem('bt.market.downloads') || '[]');
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function marketDownloadedKeys(kind) {
  return new Set(
    marketDownloadList()
      .filter((item) => item && String(item.kind || '') === kind && item.id)
      .map((item) => `${kind}:${item.id}`)
  );
}

function rememberMarketDownload(kind, id, url) {
  if (!id) return;
  try {
    const list = marketDownloadList().filter(
      (item) => !(String(item.kind || '') === kind && String(item.id) === String(id))
    );
    list.unshift({ kind, id: String(id), url, at: Date.now() });
    localStorage.setItem('bt.market.downloads', JSON.stringify(list.slice(0, 300)));
  } catch {}
}

function marketFilteredItems() {
  const kind = S.marketKind;
  const query = String(S.marketQuery || '').trim().toLowerCase();
  const downloaded = marketDownloadedKeys(kind);
  const list = (S.marketItems || []).filter((item) => {
    if (kind === 'avatar' && item.type !== 'avatar') return false;
    if (kind === 'wallpaper') {
      if (S.marketType === 'phone') {
        if (item.type !== 'phone') return false;
      } else if (item.type !== 'desktop') {
        return false;
      }
    }
    if (!query) return true;
    const hay = [item.title, item.style, item.category, ...(item.tags || [])]
      .join(' ')
      .toLowerCase();
    return hay.includes(query);
  });
  return list.sort((a, b) => {
    const da = downloaded.has(`${kind}:${a.id}`) ? 1 : 0;
    const db = downloaded.has(`${kind}:${b.id}`) ? 1 : 0;
    return db - da;
  });
}

function renderMarketFilters() {
  const box = $('#marketFilters');
  if (!box) return;
  const options =
    S.marketKind === 'wallpaper'
      ? [
          ['all', '全部'],
          ['phone', '手机壁纸'],
        ]
      : [['all', '全部头像']];
  box.innerHTML = options
    .map(
      ([value, label]) =>
        `<button type="button" class="market-filter${
          (S.marketType || 'all') === value ? ' on' : ''
        }" data-market-type="${value}">${label}</button>`
    )
    .join('');
}

function renderMarket() {
  const grid = $('#marketGrid');
  if (!grid) return;
  if (S.marketLoading) {
    grid.innerHTML = '<div class="usage-loading">正在加载源仓市场…</div>';
    return;
  }
  const list = marketFilteredItems();
  S.marketFiltered = list;
  const shown = Math.max(1, S.marketShown || 120);
  if (!list.length) {
    grid.innerHTML = '<div class="usage-loading">没有找到匹配的图片，换个关键词试试。</div>';
    $('#marketCount').textContent = '';
    $('#marketMore').hidden = true;
    return;
  }
  const downloaded = marketDownloadedKeys(S.marketKind);
  grid.innerHTML = list
    .slice(0, shown)
    .map((item, index) => {
      const thumb = esc(item.thumb || '');
      const title = esc(item.title || '未命名');
      const meta = esc([item.style, marketTypeLabel(item.type)].filter(Boolean).join(' · '));
      const isDownloaded = downloaded.has(`${S.marketKind}:${item.id}`);
      return `<article class="market-card market-type-${esc(item.type || '')}${
        isDownloaded ? ' is-downloaded' : ''
      }">
        <div class="market-thumb"><img src="${thumb}" alt="${title}" decoding="async" />${
          isDownloaded ? '<span class="market-badge">已下载</span>' : ''
        }</div>
        <div class="market-info">
          <div class="market-title" title="${title}">${title}</div>
          <div class="market-meta">${meta}</div>
        </div>
        <button type="button" class="btn primary market-use" data-market-use="${index}">使用</button>
      </article>`;
    })
    .join('');
  $('#marketCount').textContent = `共 ${list.length} 张`;
  const more = $('#marketMore');
  if (more) more.hidden = list.length <= shown;
}

async function openMarket(kind) {
  const overlay = ensureMarketOverlay();
  S.marketKind = kind === 'wallpaper' ? 'wallpaper' : 'avatar';
  S.marketType = 'all';
  S.marketQuery = '';
  S.marketShown = 120;
  $('#marketTitle').textContent =
    S.marketKind === 'wallpaper' ? '源仓壁纸市场' : '源仓头像市场';
  $('#marketSearch').value = '';
  renderMarketFilters();
  overlay.hidden = false;
  $('#marketSearch').focus();
  if (S.marketItems?.length) {
    S.marketLoading = false;
    renderMarket();
    return;
  }
  S.marketLoading = true;
  renderMarket();
  try {
    const data = await api('/api/market/wall');
    S.marketItems = data.items || [];
    S.marketLoading = false;
    renderMarket();
  } catch (e) {
    S.marketLoading = false;
    const grid = $('#marketGrid');
    if (grid) {
      grid.innerHTML = `<div class="market-error">市场加载失败：${esc(
        apiErrorText(e)
      )}<br/><br/>可以直接在浏览器打开 yuancang.me/wall 挑选。</div>`;
    }
  }
}

function closeMarket() {
  const overlay = $('#marketOverlay');
  if (overlay) overlay.hidden = true;
}

function applyMarketAvatar(url) {
  const hidden = $('#fAvatar');
  const pick = $('#fAvatarPick');
  if (!hidden || !pick) {
    toast('请先打开 Bot 设置再选头像', 'err');
    return false;
  }
  hidden.value = url;
  S.avatars = [url, ...(S.avatars || []).filter((item) => item !== url)];
  [...pick.children].forEach((child) => child.classList.remove('on'));
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'avatar-opt on';
  btn.dataset.avatar = url;
  btn.title = '使用这个头像';
  btn.innerHTML = `<img src="${esc(url)}" alt="" />`;
  pick.prepend(btn);
  return true;
}

async function applyMarketWallpaper(url) {
  const res = await api('/api/settings', {
    method: 'PATCH',
    body: { wallpaper: true, wallpaperFile: url },
  });
  S.settings = res.settings || S.settings;
  if (!(S.wallpapers || []).includes(url)) S.wallpapers = [url, ...(S.wallpapers || [])];
  applyWallpaper();
  refreshWallGrid();
  const toggle = $('#wallToggle');
  if (toggle) toggle.checked = true;
}

async function useMarketItem(item, btn) {
  if (!item) return;
  const kind = S.marketKind;
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = '下载中…';
  try {
    const res = await api('/api/market/import', {
      method: 'POST',
      body: { url: item.full, kind },
    });
    rememberMarketDownload(kind, item.id, res.url);
    if (kind === 'wallpaper') {
      await applyMarketWallpaper(res.url);
      toast('壁纸已下载并应用');
    } else {
      if (!applyMarketAvatar(res.url)) return;
      toast('头像已选中，保存 Bot 后生效');
    }
    setTimeout(() => closeMarket(), 450);
  } catch (e) {
    toast(`使用失败：${apiErrorText(e)}`, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}


function openTextPrompt({ title = '', label = '', value = '', placeholder = '', okText = '确定' } = {}) {
  return new Promise((resolve) => {
    let overlay = $('#btPromptOverlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'btPromptOverlay';
      overlay.className = 'bt-prompt-overlay';
      overlay.hidden = true;
      overlay.innerHTML = `<div class="bt-prompt-panel" role="dialog" aria-modal="true">
        <h3 id="btPromptTitle"></h3>
        <label id="btPromptLabel" for="btPromptInput"></label>
        <input id="btPromptInput" autocomplete="off" />
        <div class="bt-prompt-actions">
          <button type="button" class="btn" id="btPromptCancel">取消</button>
          <button type="button" class="btn primary" id="btPromptOk">确定</button>
        </div>
      </div>`;
      document.body.appendChild(overlay);
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) overlay._finish?.(null);
      });
      $('#btPromptCancel').onclick = () => overlay._finish?.(null);
      $('#btPromptOk').onclick = () => overlay._finish?.($('#btPromptInput').value.trim() || null);
      $('#btPromptInput').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          overlay._finish?.($('#btPromptInput').value.trim() || null);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          overlay._finish?.(null);
        }
      });
    }
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      overlay._finish = null;
      overlay.hidden = true;
      resolve(result);
    };
    overlay._finish = finish;
    $('#btPromptTitle').textContent = title || '请输入';
    $('#btPromptLabel').textContent = label || '';
    $('#btPromptLabel').hidden = !label;
    const input = $('#btPromptInput');
    input.value = value || '';
    input.placeholder = placeholder || '';
    $('#btPromptOk').textContent = okText || '确定';
    overlay.hidden = false;
    setTimeout(() => {
      input.focus();
      input.select();
    }, 30);
  });
}

async function uploadImage(kind, file) {
  if (!file) throw new Error('没有选择图片');
  if (!/^image\//i.test(file.type || '')) throw new Error('请选择图片文件');
  if (file.size > 20 * 1024 * 1024) throw new Error('图片太大（上限 20MB）');
  const dataUrl = await readFileAsDataURL(file);
  const data = dataUrl.split(',')[1] || '';
  const res = await api('/api/uploads', {
    method: 'POST',
    body: { kind, name: file.name, data },
  });
  return res.url;
}

async function uploadAnyFile(file) {
  if (!file) throw new Error('没有选择文件');
  if (file.size > 40 * 1024 * 1024) throw new Error('文件太大（上限 40MB）');
  const dataUrl = await readFileAsDataURL(file);
  const data = dataUrl.split(',')[1] || '';
  return api('/api/uploads', {
    method: 'POST',
    body: { kind: 'file', name: file.name, mime: file.type || '', data },
  });
}

function roleOptions(selected = '') {
  return (
    '<option value="">不设职位（用个人岗位说明）</option>' +
    (S.roles || [])
      .map(
        (r) =>
          `<option value="${esc(r.id)}"${r.id === selected ? ' selected' : ''}>${esc(
            r.emoji || '🧩'
          )} ${esc(r.name)}</option>`
      )
      .join('')
  );
}

/* ---------------- Skills 管理 ---------------- */

function skillTargetObjects(type) {
  if (type === 'role') return S.roles || [];
  if (type === 'bot') return S.bots || [];
  return (S.chats || [])
    .filter((c) => c.type === 'group')
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

function skillTargetLabel(type, obj) {
  if (!obj) return '';
  if (type === 'role') return `${obj.emoji || '🧩'} ${obj.name}`;
  if (type === 'bot') return `${obj.emoji || '🙂'} ${botDisplayName(obj)}`;
  return obj.title;
}

function skillTargetById(type, id) {
  return skillTargetObjects(type).find((x) => x.id === id) || null;
}

function skillDraftKey(type, id) {
  return `${type}:${id}`;
}

function skillSameList(a, b) {
  const x = (a || []).map(String);
  const y = (b || []).map(String);
  if (x.length !== y.length) return false;
  const set = new Set(x);
  return y.every((n) => set.has(n));
}

function skillSelectedFor(type, id, target) {
  const draft = S.skillDrafts?.[skillDraftKey(type, id)];
  if (Array.isArray(draft)) return draft.map(String);
  return (target?.skills || []).map(String);
}

function patchSkillTarget(type, id, skills) {
  const path =
    type === 'role'
      ? `/api/roles/${id}`
      : type === 'bot'
        ? `/api/bots/${id}`
        : `/api/chats/${id}`;
  return api(path, { method: 'PATCH', body: { skills } });
}

async function openSkills() {
  let data;
  try {
    data = await api('/api/skills');
  } catch (e) {
    toast(`读取 Skills 失败：${apiErrorText(e)}`, 'err');
    return;
  }
  S.skills = data.skills || [];
  S.skillDrafts = {};
  const active = chatById(S.activeChatId);
  let type = 'role';
  let targetId = (S.roles || [])[0]?.id || '';
  if (active?.type === 'group') {
    type = 'group';
    targetId = active.id;
  } else if (active?.type === 'dm') {
    type = 'bot';
    targetId = active.botIds?.[0] || '';
  }
  if (!skillTargetById(type, targetId)) targetId = skillTargetObjects(type)[0]?.id || '';
  if (!targetId) {
    for (const t of ['role', 'bot', 'group']) {
      const id = skillTargetObjects(t)[0]?.id;
      if (id) {
        type = t;
        targetId = id;
        break;
      }
    }
  }
  S.skillState = { type, targetId, q: '' };
  drawSkillsModal();
}

function drawSkillsModal() {
  const st = (S.skillState ||= { type: 'role', targetId: '', q: '' });
  if (!skillTargetById(st.type, st.targetId)) {
    st.targetId = skillTargetObjects(st.type)[0]?.id || '';
  }
  openModal(
    `<div class="sched-head">
       <div class="skills-title-row">
         <h3>Skills 管理</h3>
         <span class="skills-title-tip">本机技能池</span>
       </div>
       <button type="button" class="sched-close" id="skillsCloseTop" title="关闭（不保存）" aria-label="关闭">✕</button>
     </div>
     <div class="skills-sub">勾选只改草稿，点右下角「保存」才生效；右上角 ✕ 关闭不保存 · 右键任意 skill 查看专业描述</div>
     <div class="skills-toolbar">
       <div class="skills-tabs" id="skillsTabs">
         ${[
           ['role', '职位'],
           ['bot', 'Bot'],
           ['group', '群聊'],
         ]
           .map(
             ([value, label]) =>
               `<button type="button" class="skill-tab ${
                 st.type === value ? 'active' : ''
               }" data-skill-type="${value}">${label}</button>`
           )
           .join('')}
       </div>
       <select id="skillsTarget" class="skills-target"></select>
       <button type="button" class="btn ghost skills-mini-btn" id="skillsRefresh" title="重新扫描本机 skills">刷新</button>
       <button type="button" class="btn ghost skills-mini-btn" id="skillsExplain" title="用 AI 给还没有说明的技能写大白话介绍">生成说明</button>
       <button type="button" class="btn primary" id="skillsInstallBtn" title="从 GitHub 安装并加到当前目标">从 GitHub 安装</button>
     </div>
     <div class="skills-install" id="skillsInstallRow" hidden>
       <input id="skillsRepo" class="skills-search" placeholder="GitHub 链接或 owner/repo，例如 owner/skills" />
       <div class="skills-install-actions">
         <span class="field-hint" id="skillsInstallHint"></span>
         <button type="button" class="btn" id="skillsInstallGo">安装并添加</button>
         <button type="button" class="btn ghost" id="skillsInstallCancel">取消</button>
       </div>
     </div>
     <input id="skillsSearch" class="skills-search" placeholder="搜索本机 skills（名称或描述）" value="${esc(
       st.q || ''
     )}" />
     <div class="skills-summary" id="skillsSummary"></div>
     <div class="skills-list" id="skillsList"></div>
     <div class="skills-actions">
       <span class="skills-save-hint" id="skillsSaveHint">右键查看专业描述；勾选后点保存</span>
       <button type="button" class="btn primary" id="skillsSave" disabled>保存</button>
     </div>`,
    'wide skills-modal'
  );

  fillSkillTargets();
  renderSkillRows();
  $('#skillsCloseTop').onclick = () => {
    S.skillDrafts = {};
    closeModal();
  };
  $('#skillsRefresh').onclick = refreshSkills;
  $('#skillsExplain').onclick = () => explainSkills();
  $('#skillsSave').onclick = saveSkillDrafts;
  $('#skillsInstallBtn').onclick = () => {
    $('#skillsInstallRow').hidden = !$('#skillsInstallRow').hidden;
    if (!$('#skillsInstallRow').hidden) $('#skillsRepo').focus();
  };
  $('#skillsInstallCancel').onclick = () => {
    $('#skillsInstallRow').hidden = true;
  };
  $('#skillsInstallGo').onclick = installSkillFromGithub;

  $('#skillsTabs').onclick = (e) => {
    const btn = e.target.closest('[data-skill-type]');
    if (!btn) return;
    if (st.type === btn.dataset.skillType) return;
    st.type = btn.dataset.skillType;
    st.targetId = skillTargetObjects(st.type)[0]?.id || '';
    for (const b of document.querySelectorAll('.skill-tab')) {
      b.classList.toggle('active', b === btn);
    }
    fillSkillTargets();
    renderSkillRows();
  };
  $('#skillsTarget').onchange = (e) => {
    st.targetId = e.target.value;
    renderSkillRows();
  };
  $('#skillsSearch').oninput = (e) => {
    st.q = e.target.value;
    renderSkillRows();
  };
  $('#skillsList').onchange = (e) => {
    const cb = e.target.closest('input[type=checkbox][data-skill]');
    if (!cb) return;
    toggleSkill(cb.dataset.skill, cb.checked);
  };
  $('#skillsList').oncontextmenu = (e) => {
    const row = e.target.closest('.skill-card');
    if (!row) return;
    e.preventDefault();
    showSkillDetail(row.dataset.skill, e.clientX, e.clientY);
  };
}

function fillSkillTargets() {
  const st = S.skillState;
  const sel = $('#skillsTarget');
  if (!sel) return;
  const list = skillTargetObjects(st.type);
  if (!list.length) {
    sel.innerHTML = '<option value="">（没有可选的会话或职位）</option>';
    sel.disabled = true;
    st.targetId = '';
    return;
  }
  sel.disabled = false;
  sel.innerHTML = list
    .map(
      (o) =>
        `<option value="${esc(o.id)}"${o.id === st.targetId ? ' selected' : ''}>${esc(
          skillTargetLabel(st.type, o)
        )}</option>`
    )
    .join('');
  if (!list.some((o) => o.id === st.targetId)) {
    st.targetId = list[0].id;
    sel.value = st.targetId;
  }
}

function renderSkillRows() {
  const st = S.skillState || { type: 'role', targetId: '', q: '' };
  const target = skillTargetById(st.type, st.targetId);
  const selected = new Set(skillSelectedFor(st.type, st.targetId, target));
  const key = skillDraftKey(st.type, st.targetId);
  const dirty = !!S.skillDrafts?.[key];
  const all = S.skills || [];
  const q = String(st.q || '').trim().toLowerCase();
  const skills = all.filter(
    (s) =>
      !q ||
      String(s.name || '').toLowerCase().includes(q) ||
      String(s.desc || '').toLowerCase().includes(q) ||
      (s.summary &&
        `${s.summary.what} ${s.summary.when}`.toLowerCase().includes(q))
  );
  const missing = [...selected].filter((n) => !all.some((s) => s.name === n)).length;
  const noSummary = all.filter((s) => !s.summary).length;
  const summary = $('#skillsSummary');
  if (summary) {
    const chips = [
      `<span class="sk-chip">本机 ${all.length} 个</span>`,
      target
        ? `<span class="sk-chip accent">${esc(skillTargetLabel(st.type, target))} · 已选 ${
            selected.size
          } 个</span>`
        : '',
      missing ? `<span class="sk-chip">${missing} 个未扫描到</span>` : '',
      dirty ? '<span class="sk-chip warn">有未保存修改</span>' : '',
      noSummary ? `<span class="sk-chip">${noSummary} 个待生成说明</span>` : '',
    ]
      .filter(Boolean)
      .join('');
    summary.innerHTML = chips;
  }
  const saveBtn = $('#skillsSave');
  if (saveBtn) {
    const dirtyCount = Object.keys(S.skillDrafts || {}).length;
    saveBtn.disabled = !dirtyCount || !!S.skillSaving;
    saveBtn.textContent = S.skillSaving ? '保存中…' : '保存';
  }
  const saveHint = $('#skillsSaveHint');
  if (saveHint) {
    saveHint.textContent = Object.keys(S.skillDrafts || {}).length
      ? '有未保存的修改，点保存后才会生效'
      : '右键查看专业描述；勾选后点保存';
  }
  const installHint = $('#skillsInstallHint');
  if (installHint) {
    installHint.textContent = target
      ? `安装到：${skillTargetLabel(st.type, target)}`
      : '先选一个目标';
  }
  const box = $('#skillsList');
  if (!box) return;
  if (!skills.length) {
    box.innerHTML = `<div class="skills-empty">${
      all.length ? '没有匹配的 skills' : '没有扫描到本机 skills'
    }</div>`;
    return;
  }
  box.innerHTML = skills
    .map((s) => {
      const sum = s.summary;
      const body = sum
        ? `<div class="skill-what">${esc(sum.what)}</div>
           <div class="skill-facts">
             <div><i>场景</i><span>${esc(sum.when)}</span></div>
             <div><i>优势</i><span>${esc(sum.pros)}</span></div>
             <div><i>注意</i><span>${esc(sum.cons)}</span></div>
           </div>`
        : `<div class="skill-what skill-missing">还没有大白话说明</div>
           <div class="skill-facts">
             <div><i>提示</i><span>点顶部「生成说明」，右键可看专业描述</span></div>
           </div>`;
      return `<label class="skill-card ${selected.has(s.name) ? 'selected' : ''}" data-skill="${esc(
        s.name
      )}">
        <div class="skill-card-head">
          <input type="checkbox" data-skill="${esc(s.name)}" ${
            selected.has(s.name) ? 'checked' : ''
          } ${target ? '' : 'disabled'} />
          <span class="skill-name">${esc(s.name)}</span>
          ${sum?.source === 'ai' ? '<span class="skill-ai">AI</span>' : ''}
        </div>
        ${body}
      </label>`;
    })
    .join('');
}

function toggleSkill(name, checked) {
  const st = S.skillState;
  const target = skillTargetById(st.type, st.targetId);
  if (!target) return;
  const key = skillDraftKey(st.type, st.targetId);
  const saved = (target.skills || []).map(String);
  const set = new Set(skillSelectedFor(st.type, st.targetId, target));
  if (checked) set.add(name);
  else set.delete(name);
  const next = [...set];
  S.skillDrafts ||= {};
  if (skillSameList(next, saved)) delete S.skillDrafts[key];
  else S.skillDrafts[key] = next;
  renderSkillRows();
}

async function saveSkillDrafts() {
  const keys = Object.keys(S.skillDrafts || {});
  if (!keys.length) {
    toast('没有需要保存的修改');
    return;
  }
  S.skillSaving = true;
  renderSkillRows();
  let ok = 0;
  const errors = [];
  for (const key of keys) {
    const idx = key.indexOf(':');
    const type = key.slice(0, idx);
    const id = key.slice(idx + 1);
    const target = skillTargetById(type, id);
    if (!target) continue;
    const skills = S.skillDrafts[key];
    try {
      await patchSkillTarget(type, id, skills);
      target.skills = skills;
      delete S.skillDrafts[key];
      ok += 1;
    } catch (e) {
      errors.push(`${skillTargetLabel(type, target)}：${apiErrorText(e)}`);
    }
  }
  S.skillSaving = false;
  renderSkillRows();
  if (errors.length) toast(`保存失败：${errors[0]}`, 'err');
  else if (ok) toast(`已保存 ${ok} 个目标的技能`);
}

async function explainSkills(names = []) {
  if (S.skillExplaining) return;
  const btn = $('#skillsExplain');
  const targets = names.length
    ? (S.skills || []).filter((s) => names.includes(s.name) && !s.summary)
    : (S.skills || []).filter((s) => !s.summary);
  if (!targets.length) {
    if (!names.length) toast('所有 skills 都已经有大白话说明了');
    return;
  }
  S.skillExplaining = true;
  let done = 0;
  if (btn) {
    btn.disabled = true;
    btn.textContent = '生成中…';
  }
  try {
    for (let round = 0; round < 20; round += 1) {
      const pending = (S.skills || []).filter(
        (s) => !s.summary && (names.length ? names.includes(s.name) : true)
      );
      if (!pending.length) break;
      if (btn) btn.textContent = `生成中… (${done})`;
      let r;
      try {
        r = await api('/api/skills/explain', {
          method: 'POST',
          body: { names: pending.slice(0, 8).map((s) => s.name) },
        });
      } catch (e) {
        toast(`生成说明失败：${apiErrorText(e)}`, 'err');
        break;
      }
      const results = r.results || {};
      const count = Object.keys(results).length;
      if (!count) {
        toast('模型没有返回可用的说明，稍后再试', 'err');
        break;
      }
      for (const [name, meta] of Object.entries(results)) {
        const hit = (S.skills || []).find((s) => s.name === name);
        if (hit) hit.summary = meta;
      }
      done += count;
      renderSkillRows();
      if (r.remaining === 0) break;
    }
    if (done) toast(`已生成 ${done} 个技能说明`);
  } finally {
    S.skillExplaining = false;
    if (btn) {
      btn.disabled = false;
      btn.textContent = '生成说明';
    }
    renderSkillRows();
  }
}

async function refreshSkills() {
  const btn = $('#skillsRefresh');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '刷新中…';
  }
  try {
    const data = await api('/api/skills?refresh=1');
    S.skills = data.skills || [];
    renderSkillRows();
    toast(`已刷新：${S.skills.length} 个 skills`);
  } catch (e) {
    toast(`刷新失败：${apiErrorText(e)}`, 'err');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '刷新';
    }
  }
}

async function installSkillFromGithub() {
  const st = S.skillState;
  const target = skillTargetById(st.type, st.targetId);
  if (!target) {
    toast('先选一个职位 / Bot / 群聊', 'err');
    return;
  }
  const input = $('#skillsRepo');
  const url = String(input?.value || '').trim();
  if (!url) {
    toast('先填 GitHub 链接或 owner/repo', 'err');
    input?.focus();
    return;
  }
  const btn = $('#skillsInstallGo');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '安装中…';
  }
  try {
    const r = await api('/api/skills/install', {
      method: 'POST',
      body: { url, targetType: st.type, targetId: st.targetId },
    });
    const installed = r.installed || [];
    for (const item of installed) {
      const hit = (S.skills || []).find((s) => s.name === item.name);
      if (hit) {
        if (item.desc) hit.desc = item.desc;
        if (item.summary) hit.summary = item.summary;
      } else {
        S.skills.push({
          name: item.name,
          desc: item.desc || '',
          summary: item.summary || null,
          path: '',
        });
      }
    }
    S.skills.sort((a, b) => a.name.localeCompare(b.name));
    if (r.target?.skills) target.skills = r.target.skills;
    // 安装是显式动作，直接合并到当前草稿里，避免丢掉还没保存的勾选
    const key = skillDraftKey(st.type, st.targetId);
    const base = S.skillDrafts?.[key] || target.skills || [];
    const merged = [...new Set([...base, ...installed.map((x) => x.name)])];
    if (skillSameList(merged, target.skills || [])) delete S.skillDrafts?.[key];
    else {
      S.skillDrafts ||= {};
      S.skillDrafts[key] = merged;
    }
    if (input) input.value = '';
    $('#skillsInstallRow').hidden = true;
    renderSkillRows();
    toast(
      `已安装 ${installed.length} 个技能：${installed.map((x) => x.name).join('、') || '无'}`
    );
    const need = installed.filter((x) => !x.summary).map((x) => x.name);
    if (need.length) explainSkills(need);
  } catch (e) {
    toast(`安装失败：${apiErrorText(e)}`, 'err');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '安装并添加';
    }
  }
}

function showSkillDetail(name, x, y) {
  const s = (S.skills || []).find((item) => item.name === name);
  if (!s) return;
  let box = document.getElementById('skillDetail');
  if (!box) {
    box = document.createElement('div');
    box.id = 'skillDetail';
    box.className = 'skill-detail';
    document.body.appendChild(box);
  }
  const sum = s.summary;
  box.innerHTML = `<div class="sd-head"><b>${esc(s.name)}</b><button type="button" id="sdClose" aria-label="关闭">✕</button></div>
    <div class="sd-body">
      ${
        sum
          ? `<div class="sd-line"><i>干什么</i>${esc(sum.what)}</div>
             <div class="sd-line"><i>什么时候用</i>${esc(sum.when)}</div>
             <div class="sd-line"><i>优势</i>${esc(sum.pros)}</div>
             <div class="sd-line"><i>局限</i>${esc(sum.cons)}</div>`
          : '<div class="sd-line sd-muted">还没有大白话说明，可以点顶部「生成说明」。</div>'
      }
      <div class="sd-raw"><i>专业描述（SKILL.md）</i><div>${esc(
        s.desc || '（没有描述）'
      )}</div></div>
      ${s.path ? `<div class="sd-path">${esc(s.path)}</div>` : ''}
    </div>`;
  box.hidden = false;
  const width = Math.min(460, window.innerWidth - 24);
  box.style.width = `${width}px`;
  box.style.left = `${Math.min(Math.max(8, x + 10), window.innerWidth - width - 8)}px`;
  box.style.top = `${Math.min(Math.max(8, y + 10), window.innerHeight - 220)}px`;
  box.querySelector('#sdClose').onclick = (e) => {
    e.stopPropagation();
    box.hidden = true;
  };
}

document.addEventListener('click', (e) => {
  const ref = e.target.closest('#fileViewer .file-ref');
  if (ref && ref.dataset.btFile) {
    e.preventDefault();
    openFileInPane(ref.dataset.btFile);
    return;
  }
  const viewerLink = e.target.closest('#fileViewer a');
  if (viewerLink) {
    const rawHref = viewerLink.getAttribute('href') || '';
    if (isLocalLinkHref(rawHref)) {
      e.preventDefault();
      openLocalLinkHref(rawHref);
      return;
    }
  }
  const box = document.getElementById('skillDetail');
  if (!box || box.hidden) return;
  if (box.contains(e.target) || e.target.closest('.skill-card')) return;
  box.hidden = true;
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const box = document.getElementById('skillDetail');
  if (box) box.hidden = true;
});

/* ---------------- 定时任务 ---------------- */

const SCHED_DAY_NAMES = ['日', '一', '二', '三', '四', '五', '六'];

function scheduleWhen(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const now = new Date();
  const hm = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  if (d.toDateString() === now.toDateString()) return `今天 ${hm}`;
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (d.toDateString() === tomorrow.toDateString()) return `明天 ${hm}`;
  const md = `${d.getMonth() + 1}月${d.getDate()}日`;
  return d.getFullYear() === now.getFullYear() ? `${md} ${hm}` : `${d.getFullYear()}年${md} ${hm}`;
}

function scheduleRuleText(s) {
  if (!s) return '';
  if (s.kind === 'once') return `一次 · ${scheduleWhen(s.at)}`;
  if (s.kind === 'daily') return `每天 ${s.time || '09:00'}`;
  if (s.kind === 'weekly') {
    const days = (s.weekdays || []).map((d) => SCHED_DAY_NAMES[d]).join('、');
    return `每周${days || '一'} ${s.time || '09:00'}`;
  }
  const unit = s.unit === 'hour' ? '小时' : '分钟';
  return `每 ${s.every || 60} ${unit}`;
}

function scheduleChatLabel(chat) {
  if (!chat) return '（会话已删除）';
  return chat.type === 'group' ? chat.title : dmProjectLabel(chat);
}

function scheduleStatusText(s) {
  if (s.lastStatus === 'running') return '正在执行…';
  if (s.lastStatus === 'error') return `上次失败：${s.lastError || '未知错误'}`;
  if (s.lastStatus === 'missed') return '已错过执行时间';
  if (s.lastStatus === 'ok') return `上次执行：${scheduleWhen(s.lastRunAt)}`;
  return '还没执行过';
}

function toLocalDateTime(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(
    d.getMinutes()
  )}`;
}

async function openSchedules() {
  let data;
  try {
    data = await api('/api/schedules');
  } catch (e) {
    toast(`读取定时任务失败：${apiErrorText(e)}`, 'err');
    return;
  }
  S.schEditId = null;
  drawSchedules(data.schedules || []);
}

function scheduleRowsHtml(list) {
  if (!list.length) {
    return '<div class="sched-empty">还没有定时任务。在下面选一个会话，写清楚到点要做什么。</div>';
  }
  return list
    .map((s) => {
      const chat = chatById(s.chatId);
      return `<div class="sched-row" data-sch="${esc(s.id)}">
        <div class="sched-main">
          <div class="sched-title">${esc(s.title)}
            <span class="sched-tag ${s.enabled ? 'on' : 'off'}">${s.enabled ? '已启用' : '已暂停'}</span>
          </div>
          <div class="sched-meta">${esc(scheduleChatLabel(chat))} · ${esc(
            scheduleRuleText(s)
          )} · 下次 ${esc(scheduleWhen(s.nextRunAt))}</div>
          <div class="sched-prompt">${esc(String(s.prompt || '').slice(0, 140))}</div>
          <div class="sched-status ${s.lastStatus === 'error' ? 'err' : ''}">${esc(
            scheduleStatusText(s)
          )}</div>
        </div>
        <div class="sched-acts">
          <button class="btn ghost" data-sch-act="run" ${
            s.lastStatus === 'running' ? 'disabled' : ''
          }>立即执行</button>
          <button class="btn ghost" data-sch-act="toggle">${s.enabled ? '暂停' : '启用'}</button>
          <button class="btn ghost" data-sch-act="edit">编辑</button>
          <button class="btn ghost" data-sch-act="del">删除</button>
        </div>
      </div>`;
    })
    .join('');
}

function drawSchedules(list) {
  S.schList = list;
  const chats = [...(S.chats || [])].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const groups = chats.filter((c) => c.type === 'group');
  const bots = S.bots || [];
  const activeChatObj = chatById(S.activeChatId);
  // 目标分两层：先选群聊 / Bot，Bot 再选它自己的项目。
  const defaultType = activeChatObj?.type === 'dm' || !groups.length ? 'bot' : 'group';
  const defaultGroup =
    activeChatObj?.type === 'group' ? activeChatObj.id : groups[0]?.id || '';
  const defaultBot =
    activeChatObj?.type === 'dm' ? activeChatObj.botIds?.[0] || '' : bots[0]?.id || '';
  const defaultProject = activeChatObj?.type === 'dm' ? activeChatObj.id : '';
  const rows = scheduleRowsHtml(list);

  openModal(
    `<div class="sched-head">
       <h3>定时任务</h3>
       <button type="button" class="sched-close" id="schCloseTop" title="关闭" aria-label="关闭">✕</button>
     </div>
     <div class="field-hint">到点后系统会像你亲自发消息一样，把任务发给对应的 Bot / 群。应用需要保持打开（关掉窗口就不跑了）。</div>
     <div class="sched-list">${rows}</div>
     <div class="sched-form">
       <div class="sched-form-title" id="schFormTitle">新建定时任务</div>
       <div class="field"><span>先选发给谁</span>
         <div class="sched-target-type" id="schTargetType">
           <label><input type="radio" name="schTargetType" value="group" ${
             defaultType === 'group' ? 'checked' : ''
           } /> 群聊</label>
           <label><input type="radio" name="schTargetType" value="bot" ${
             defaultType === 'bot' ? 'checked' : ''
           } /> Bot 的项目</label>
         </div>
       </div>
       <label class="field" id="schGroupWrap" ${defaultType === 'bot' ? 'hidden' : ''}><span>群聊</span>
         <select id="schGroup">
           ${groups
             .map(
               (c) =>
                 `<option value="${esc(c.id)}"${c.id === defaultGroup ? ' selected' : ''}>${esc(
                   c.title
                 )}</option>`
             )
             .join('')}
         </select>
       </label>
       <div id="schBotWrap" ${defaultType === 'group' ? 'hidden' : ''}>
         <label class="field"><span>Bot</span>
           <select id="schBot">
             ${bots
               .map(
                 (b) =>
                   `<option value="${esc(b.id)}"${b.id === defaultBot ? ' selected' : ''}>${esc(
                     b.emoji || '🙂'
                   )} ${esc(botDisplayName(b))}</option>`
               )
               .join('')}
           </select>
         </label>
         <label class="field"><span>这个 Bot 的项目</span>
           <select id="schProject"></select>
         </label>
         <div class="field-hint" id="schNoProject" hidden>这个 Bot 还没有项目，先在左侧打开它一次，会自动建一个默认项目。</div>
       </div>
       <label class="field"><span>名称</span>
         <input id="schTitle" maxlength="60" placeholder="例如 每日进度汇总" />
       </label>
       <label class="field"><span>到点发给 Bot 的内容</span>
         <textarea id="schPrompt" rows="3" maxlength="4000" placeholder="例如：汇总今天的进度，列出未完成项，并说明下一步。"></textarea>
       </label>
       <label class="field"><span>频率</span>
         <select id="schKind">
           <option value="daily">每天</option>
           <option value="weekly">每周</option>
           <option value="interval">每隔一段时间</option>
           <option value="once">只执行一次</option>
         </select>
       </label>
       <div class="sched-sub" id="schTimeWrap"><span>时间</span><input type="time" id="schTime" value="09:00" /></div>
       <div class="sched-sub" id="schWeekWrap" hidden><span>星期</span><div class="sched-days">
         ${SCHED_DAY_NAMES.map(
           (n, i) =>
             `<label><input type="checkbox" value="${i}" ${
               i >= 1 && i <= 5 ? 'checked' : ''
             }/>${n}</label>`
         ).join('')}
       </div></div>
       <div class="sched-sub" id="schEveryWrap" hidden><span>每隔</span>
         <input type="number" id="schEvery" min="1" max="10080" value="60" />
         <select id="schUnit"><option value="minute">分钟</option><option value="hour">小时</option></select>
       </div>
       <div class="sched-sub" id="schAtWrap" hidden><span>执行时间</span><input type="datetime-local" id="schAt" /></div>
       <div class="sched-form-actions">
         <button class="btn" id="schSubmit">添加</button>
         <button class="btn ghost" id="schCancelEdit" hidden>取消编辑</button>
         <button class="btn ghost" id="schClose">关闭</button>
       </div>
     </div>`,
    'wide'
  );

  bindScheduleModal(list);
  startSchedulePoll(list);
}

// 有任务正在执行时，隔几秒刷新一次列表，执行完了就把状态换掉。
function startSchedulePoll(list) {
  clearInterval(S.schPoll);
  S.schPoll = null;
  if (!list.some((s) => s.lastStatus === 'running')) return;
  S.schPoll = setInterval(async () => {
    if ($('#modalMask').hidden || !document.querySelector('.sched-list')) {
      clearInterval(S.schPoll);
      S.schPoll = null;
      return;
    }
    try {
      const data = await api('/api/schedules');
      const fresh = data.schedules || [];
      S.schList = fresh;
      const box = $('.sched-list');
      if (box) box.innerHTML = scheduleRowsHtml(fresh);
      if (!fresh.some((s) => s.lastStatus === 'running')) {
        clearInterval(S.schPoll);
        S.schPoll = null;
      }
    } catch {}
  }, 3000);
}

function bindScheduleModal(list) {
  $('#schCloseTop').onclick = closeModal;
  $('#schClose').onclick = closeModal;

  const botProjects = (botId) =>
    (S.chats || [])
      .filter((c) => c.type === 'dm' && (c.botIds || []).includes(botId))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

  const fillProjects = (botId, selectedId = '') => {
    const sel = $('#schProject');
    if (!sel) return;
    const prev = selectedId || sel.value;
    const projects = botId ? botProjects(botId) : [];
    sel.innerHTML = projects
      .map(
        (c) =>
          `<option value="${esc(c.id)}">${esc(c.project || '默认项目')}${
            c.linkedGroupId ? ' · 关联群' : ''
          }</option>`
      )
      .join('');
    if (prev && projects.some((c) => c.id === prev)) sel.value = prev;
    else if (projects[0]) sel.value = projects[0].id;
    sel.disabled = !projects.length;
    $('#schNoProject').hidden = projects.length > 0;
  };

  const targetType = () =>
    document.querySelector('input[name="schTargetType"]:checked')?.value || 'group';
  const syncTarget = () => {
    const type = targetType();
    $('#schGroupWrap').hidden = type !== 'group';
    $('#schBotWrap').hidden = type !== 'bot';
    if (type === 'bot') fillProjects($('#schBot').value);
  };
  for (const radio of document.querySelectorAll('input[name="schTargetType"]')) {
    radio.onchange = syncTarget;
  }
  $('#schBot').onchange = () => fillProjects($('#schBot').value);

  const activeChatObj = chatById(S.activeChatId);
  const initialTarget = {
    type: activeChatObj?.type === 'dm' || !(S.chats || []).some((c) => c.type === 'group') ? 'bot' : 'group',
    group: activeChatObj?.type === 'group' ? activeChatObj.id : (S.chats || []).find((c) => c.type === 'group')?.id || '',
    bot: activeChatObj?.type === 'dm' ? activeChatObj.botIds?.[0] || '' : (S.bots || [])[0]?.id || '',
    project: activeChatObj?.type === 'dm' ? activeChatObj.id : '',
  };
  const applyTarget = (type, groupId, botId, projectId) => {
    const radio = document.querySelector(`input[name="schTargetType"][value="${type}"]`);
    if (radio) radio.checked = true;
    if (groupId && $('#schGroup')) $('#schGroup').value = groupId;
    if (botId && $('#schBot')) $('#schBot').value = botId;
    syncTarget();
    if (projectId) fillProjects(botId, projectId);
  };

  fillProjects($('#schBot').value, initialTarget.project);
  syncTarget();

  const kindSel = $('#schKind');
  const syncKind = () => {
    const kind = kindSel.value;
    $('#schTimeWrap').hidden = !(kind === 'daily' || kind === 'weekly');
    $('#schWeekWrap').hidden = kind !== 'weekly';
    $('#schEveryWrap').hidden = kind !== 'interval';
    $('#schAtWrap').hidden = kind !== 'once';
  };
  kindSel.onchange = syncKind;
  syncKind();

  const atInput = $('#schAt');
  if (atInput && !atInput.value) atInput.value = toLocalDateTime(Date.now() + 10 * 60 * 1000);

  const resetEdit = () => {
    S.schEditId = null;
    $('#schFormTitle').textContent = '新建定时任务';
    $('#schSubmit').textContent = '添加';
    $('#schCancelEdit').hidden = true;
    $('#schTitle').value = '';
    $('#schPrompt').value = '';
    $('#schKind').value = 'daily';
    applyTarget(initialTarget.type, initialTarget.group, initialTarget.bot, initialTarget.project);
    syncKind();
  };

  const startEdit = (s) => {
    S.schEditId = s.id;
    $('#schFormTitle').textContent = '编辑定时任务';
    $('#schSubmit').textContent = '保存修改';
    $('#schCancelEdit').hidden = false;
    const targetChat = chatById(s.chatId);
    if (targetChat?.type === 'group') {
      applyTarget('group', targetChat.id, '', '');
    } else if (targetChat?.type === 'dm') {
      applyTarget('bot', '', targetChat.botIds?.[0] || '', targetChat.id);
    }
    $('#schTitle').value = s.title || '';
    $('#schPrompt').value = s.prompt || '';
    $('#schKind').value = s.kind || 'daily';
    $('#schTime').value = s.time || '09:00';
    for (const cb of $('#schWeekWrap').querySelectorAll('input[type=checkbox]')) {
      cb.checked = (s.weekdays || []).includes(Number(cb.value));
    }
    $('#schEvery').value = s.every || 60;
    $('#schUnit').value = s.unit || 'minute';
    $('#schAt').value = s.at ? toLocalDateTime(s.at) : '';
    syncKind();
    $('.sched-form')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };

  $('#schCancelEdit').onclick = resetEdit;

  $('#schSubmit').onclick = async () => {
    const type = targetType();
    const targetChatId = type === 'group' ? $('#schGroup').value : $('#schProject').value;
    if (!targetChatId) {
      toast(type === 'group' ? '先选一个群聊' : '先选一个 Bot 的项目', 'err');
      return;
    }
    const body = {
      chatId: targetChatId,
      title: $('#schTitle').value.trim(),
      prompt: $('#schPrompt').value.trim(),
      kind: $('#schKind').value,
      time: $('#schTime').value || '09:00',
      weekdays: [...$('#schWeekWrap').querySelectorAll('input[type=checkbox]:checked')].map((x) =>
        Number(x.value)
      ),
      every: Number($('#schEvery').value) || 60,
      unit: $('#schUnit').value,
      at: $('#schAt').value ? new Date($('#schAt').value).getTime() : 0,
    };
    if (!body.prompt) {
      toast('先写到点要做什么', 'err');
      $('#schPrompt').focus();
      return;
    }
    if (body.kind === 'weekly' && !body.weekdays.length) {
      toast('每周任务至少要选一天', 'err');
      return;
    }
    try {
      if (S.schEditId) {
        await api(`/api/schedules/${S.schEditId}`, { method: 'PATCH', body });
        toast('定时任务已更新');
      } else {
        await api('/api/schedules', { method: 'POST', body });
        toast('定时任务已添加');
      }
      await openSchedules();
    } catch (e) {
      toast(`保存失败：${apiErrorText(e)}`, 'err');
    }
  };

  $('.sched-list').onclick = async (e) => {
    const btn = e.target.closest('[data-sch-act]');
    const row = e.target.closest('[data-sch]');
    if (!btn || !row) return;
    const s = (S.schList || list).find((x) => x.id === row.dataset.sch);
    if (!s) return;
    const act = btn.dataset.schAct;
    try {
      if (act === 'edit') return startEdit(s);
      if (act === 'run') {
        await api(`/api/schedules/${s.id}/run`, { method: 'POST', body: {} });
        toast('已触发，马上开始执行');
        return openSchedules();
      }
      if (act === 'toggle') {
        await api(`/api/schedules/${s.id}`, { method: 'PATCH', body: { enabled: !s.enabled } });
        return openSchedules();
      }
      if (act === 'del') {
        if (!confirm(`删除定时任务「${s.title}」？`)) return;
        await api(`/api/schedules/${s.id}`, { method: 'DELETE' });
        toast('已删除');
        return openSchedules();
      }
    } catch (err) {
      toast(`操作失败：${apiErrorText(err)}`, 'err');
    }
  };
}

const ROLE_SCOPE_ALL = '__all__';

function rolesLibraryHtml() {
  return `<div class="field">
      <label>职位库</label>
      <div class="role-list">
        ${(S.roles || [])
          .map(
            (r) => `<div class="role-card">
              <div class="role-card-head"><b>${esc(r.emoji || '🧩')} ${esc(
              r.name
            )}</b>${r.abbr ? `<span class="role-abbr">${esc(r.abbr)}</span>` : ''}${
              r.builtin ? '<span class="role-fixed">预设</span>' : ''
            }</div>
              <div class="role-card-desc">${esc((r.persona || '').slice(0, 180))}</div>
              ${
                (r.skills || []).length
                  ? `<div class="role-skills">${r.skills.map((s) => `<span>${esc(s)}</span>`).join('')}</div>`
                  : ''
              }
              <div class="role-card-actions">
                <button type="button" class="btn" data-edit-role="${r.id}">编辑</button>
                ${
                  r.builtin
                    ? ''
                    : `<button type="button" class="btn danger" data-del-role="${r.id}">删除</button>`
                }
              </div>
            </div>`
          )
          .join('')}
      </div>
    </div>`;
}

function bindRoleLibrary(scopeId) {
  $('#modal').querySelectorAll('[data-edit-role]').forEach((btn) => {
    btn.onclick = () => {
      const role = (S.roles || []).find((r) => r.id === btn.dataset.editRole);
      if (role) openRoleForm(role);
    };
  });
  $('#modal').querySelectorAll('[data-del-role]').forEach((btn) => {
    btn.onclick = async () => {
      const role = (S.roles || []).find((r) => r.id === btn.dataset.delRole);
      if (!role || !confirm(`删除职位「${role.name}」？`)) return;
      try {
        await api(`/api/roles/${role.id}`, { method: 'DELETE' });
        S.roles = S.roles.filter((r) => r.id !== role.id);
        for (const b of S.bots) if (b.roleId === role.id) b.roleId = null;
        for (const c of S.chats) {
          if (!c.roleIds) continue;
          for (const id of Object.keys(c.roleIds)) {
            if (c.roleIds[id] === role.id) delete c.roleIds[id];
          }
        }
        openRoles(scopeId);
      } catch (e) {
        toast(`删除失败：${e.message}`, 'err');
      }
    };
  });
}

function openRoles(scopeId = null) {
  const groups = S.chats.filter((c) => c.type === 'group');
  const globalMode = scopeId === ROLE_SCOPE_ALL;
  const activeChatNow = activeChat();
  let group = null;
  if (!globalMode) {
    if (!groups.length) {
      toast('先建一个群聊，职位是跟着群走的；也可以选「所有项目」设全局职位');
      return;
    }
    const activeId =
      scopeId ||
      (activeChatNow?.type === 'group'
        ? activeChatNow.id
        : activeChatNow?.linkedGroupId) ||
      groups[0].id;
    group = groups.find((g) => g.id === activeId) || groups[0];
  }
  const groupOptions =
    `<option value="${ROLE_SCOPE_ALL}"${globalMode ? ' selected' : ''}>所有项目（全局）</option>` +
    groups
      .map(
        (g) =>
          `<option value="${esc(g.id)}"${group && g.id === group.id ? ' selected' : ''}>${esc(
            g.title
          )}</option>`
      )
      .join('');

  if (globalMode) {
    const bots = (S.bots || []).filter((b) => !b.hidden);
    openModal(`
      <h3>全局职位 · 所有项目</h3>
      <div class="field">
        <label>项目 / 群</label>
        <select id="roleGroupPick">${groupOptions}</select>
        <div class="field-hint">全局职位对所有项目和群生效；某个群里单独设置会覆盖它。适合学习助手、财务顾问这类固定角色的 Bot。</div>
      </div>
      <div class="field">
        <label>全局职务</label>
        <div class="role-assign-list">
          ${
            bots
              .map(
                (b) => `<div class="role-assign">
              ${avatarFor(b)}
              <div class="role-assign-name">${esc(b.name)}</div>
              <select data-global-role="${b.id}">${roleOptions(b.roleId || '')}</select>
            </div>`
              )
              .join('') || '<div class="muted" style="font-size:11px">还没有 Bot</div>'
          }
        </div>
      </div>
      ${rolesLibraryHtml()}
      <div class="modal-actions">
        <button class="btn" id="roleNew">新建职位</button>
        <button class="btn primary" id="roleClose">关闭</button>
      </div>`);
    $('#roleClose').onclick = closeModal;
    $('#roleNew').onclick = () => openRoleForm(null);
    $('#roleGroupPick').onchange = (e) => openRoles(e.target.value);
    bindRoleLibrary(ROLE_SCOPE_ALL);
    document.querySelectorAll('[data-global-role]').forEach((sel) => {
      sel.onchange = async () => {
        try {
          await api(`/api/bots/${sel.dataset.globalRole}`, {
            method: 'PATCH',
            body: { roleId: sel.value || null },
          });
          const b = S.bots.find((x) => x.id === sel.dataset.globalRole);
          if (b) b.roleId = sel.value || null;
          toast('全局职位已更新');
          openRoles(ROLE_SCOPE_ALL);
        } catch (e) {
          toast(`更新失败：${e.message}`, 'err');
        }
      };
    });
    return;
  }

  const leaderId = S.settings?.leaderId;
  const members = group.botIds.map(botById).filter(Boolean);
  openModal(`
    <h3>群职位 · ${esc(group.title)}</h3>
    <div class="field">
      <label>项目 / 群</label>
      <select id="roleGroupPick">${groupOptions}</select>
      <div class="field-hint">职位在这个群里生效；想让 Bot 在所有项目里都固定同一个职位，选「所有项目（全局）」。</div>
    </div>
    <div class="field">
      <label>这个群的职务班子</label>
      <div class="role-assign-list">
        ${members
          .map((b) => {
            const fixed = b.id === leaderId;
            const roleId = group.roleIds?.[b.id] || '';
            return `<div class="role-assign">
              ${avatarFor(b)}
              <div class="role-assign-name">${esc(botDisplayName(b, group))}${
                fixed ? '<span class="role-fixed">领导</span>' : ''
              }</div>
              ${
                fixed
                  ? '<span class="muted" style="font-size:11px">固定领导职位</span>'
                  : `<select data-bot-role="${b.id}">${roleOptions(roleId)}</select>`
              }
            </div>`;
          })
          .join('')}
      </div>
    </div>
    ${rolesLibraryHtml()}
    <div class="modal-actions">
      <button class="btn" id="roleNew">新建职位</button>
      <button class="btn primary" id="roleClose">关闭</button>
    </div>`);
  $('#roleClose').onclick = closeModal;
  $('#roleNew').onclick = () => openRoleForm(null);
  $('#roleGroupPick').onchange = (e) => openRoles(e.target.value);
  document.querySelectorAll('[data-bot-role]').forEach((sel) => {
    sel.onchange = async () => {
      const next = { ...(group.roleIds || {}) };
      if (sel.value) next[sel.dataset.botRole] = sel.value;
      else delete next[sel.dataset.botRole];
      try {
        await api(`/api/chats/${group.id}`, {
          method: 'PATCH',
          body: { roleIds: next },
        });
        group.roleIds = next;
        toast('这个群的职位已更新');
        openRoles(group.id);
      } catch (e) {
        toast(`更新失败：${e.message}`, 'err');
      }
    };
  });
  bindRoleLibrary(group.id);
}

function openRoleForm(role) {
  const isNew = !role;
  const r = role || { name: '', emoji: '🧩', persona: '', memory: '', skills: [] };
  openModal(`
    <h3>${isNew ? '新建职位' : `编辑职位 · ${esc(r.name)}`}</h3>
    <div class="field row-2">
      <div><label>Emoji</label><input id="roleEmoji" value="${esc(r.emoji || '🧩')}" maxlength="4" /></div>
      <div><label>职位名称</label><input id="roleName" value="${esc(r.name)}" placeholder="比如 前端工程师" /></div>
    </div>
    <div class="field">
      <label>缩写（显示在 Bot 名字后面的括号里）</label>
      <input id="roleAbbr" value="${esc(r.abbr || '')}" maxlength="12" placeholder="比如 前端" />
    </div>
    <div class="field">
      <label>岗位说明（这个职位的人应该怎么干活）</label>
      <textarea id="rolePersona" placeholder="职责、工作方式、交付标准、不要做什么">${esc(
        r.persona || ''
      )}</textarea>
    </div>
    <div class="field">
      <label>职位长期记忆（该职位所有 Bot 都会带上）</label>
      <textarea id="roleMemory" placeholder="默认规范、偏好、踩过的坑">${esc(
        r.memory || ''
      )}</textarea>
    </div>
    <div class="field">
      <label>推荐技能（逗号分隔，比如 agent-reach, ui-ux-pro-max）</label>
      <input id="roleSkills" value="${esc((r.skills || []).join(', '))}" placeholder="可以留空" />
    </div>
    <div class="modal-actions">
      <button class="btn" id="roleCancel">取消</button>
      <button class="btn primary" id="roleSave">保存</button>
    </div>`);
  $('#roleCancel').onclick = () => openRoles();
  $('#roleSave').onclick = async () => {
    const name = $('#roleName').value.trim();
    if (!name) return toast('职位名称不能为空', 'err');
    const body = {
      name,
      abbr: $('#roleAbbr').value.trim(),
      emoji: $('#roleEmoji').value || '🧩',
      persona: $('#rolePersona').value,
      memory: $('#roleMemory').value,
      skills: $('#roleSkills')
        .value.split(/[,，\n]/)
        .map((s) => s.trim())
        .filter(Boolean),
    };
    try {
      if (isNew) {
        const created = await api('/api/roles', { method: 'POST', body });
        S.roles.push(created);
      } else {
        const updated = await api(`/api/roles/${r.id}`, { method: 'PATCH', body });
        const i = S.roles.findIndex((x) => x.id === r.id);
        if (i >= 0) S.roles[i] = updated;
      }
      openRoles();
    } catch (e) {
      toast(`保存失败：${e.message}`, 'err');
    }
  };
}

function botForm(bot) {
  const isNew = !bot;
  const freeAvatars = (S.avatars || []).filter((a) => !S.bots.some((x) => x.avatar === a));
  const avatarPool = freeAvatars.length ? freeAvatars : S.avatars || [];
  const b = bot || {
    name: '',
    emoji: '🙂',
    avatar: avatarPool[Math.floor(Math.random() * avatarPool.length)] || '',
    color: '#6c5ce7',
    backend: 'opencode',
    model: 'opencode-go/gpt-5.6-luna',
    source: 'OpenCode Go',
    billing: 'subscription',
    quota: '',
    quotaOverride: '',
    persona: '',
    memory: '',
    roleId: '',
    hidden: false,
    usage: null,
    permission: { mode: 'workspace', read: [], write: [] },
    timeoutMin: 0,
    api: null,
    ...(S.newBotPreset || {}),
  };
  const perm = b.permission || { mode: 'workspace', read: [], write: [] };
  const api = b.api || {
    mode: b.backend === 'custom' ? 'custom' : 'official',
    style: b.backend === 'claude' ? 'anthropic' : 'openai',
    baseUrl: '',
    hasKey: false,
  };
  const sourceOptions = (S.sources || []).map((s) => `<option value="${esc(s.name)}"></option>`).join('');
  return `
    <h3>${isNew ? '新建 Bot' : '编辑 Bot'}</h3>
    <input type="hidden" id="fBotId" value="${esc(b.id || '')}" />
    <input type="hidden" id="fApiModels" value="${esc(JSON.stringify(api.models || []))}" />

    <div class="field">
      <label>头像</label>
      <div class="avatar-pick" id="fAvatarPick">
        ${(S.avatars || [])
          .map(
            (src) =>
              `<button type="button" class="avatar-opt${b.avatar === src ? ' on' : ''}" data-avatar="${esc(
                src
              )}" title="使用这个头像"><img src="${esc(src)}" alt="" loading="lazy" /></button>`
          )
          .join('')}
      </div>
      <input type="hidden" id="fAvatar" value="${esc(b.avatar || '')}" />
      <div class="avatar-upload-row">
        <button type="button" class="btn" id="fAvatarUpload">上传头像图片</button>
        <button type="button" class="btn" id="fAvatarMarket">源仓头像市场</button>
        <input type="file" id="fAvatarFile" accept="image/*" hidden />
      </div>
      <div class="field-hint">点一个头像；没有头像时用下面的 emoji + 颜色</div>
    </div>

    <div class="field row-2">
      <div><label>Emoji</label><input id="fEmoji" value="${esc(b.emoji)}" maxlength="4" /></div>
      <div><label>名字</label><input id="fName" value="${esc(b.name)}" placeholder="比如 Codex 工人" /></div>
    </div>
    <div class="field row-2">
      <div><label>颜色</label><input id="fColor" type="color" value="${esc(b.color)}" style="padding:3px;height:38px" /></div>
      <div>
        <label>模型后端</label>
        <select id="fBackend">
          <option value="opencode"${b.backend === 'opencode' ? ' selected' : ''}>OpenCode（opencode CLI）</option>
          <option value="codex"${b.backend === 'codex' ? ' selected' : ''}>Codex（ChatGPT 订阅 / 自定义 API）</option>
          <option value="claude"${b.backend === 'claude' ? ' selected' : ''}>Claude Code（Claude 订阅 / 自定义 API）</option>
          <option value="agy"${b.backend === 'agy' ? ' selected' : ''}>Antigravity（agy CLI）</option>
          <option value="codebuddy"${b.backend === 'codebuddy' ? ' selected' : ''}>WorkBuddy 中国版（codebuddy CLI）</option>
          <option value="qoder"${b.backend === 'qoder' ? ' selected' : ''}>Qoder 中国版（qoderclicn CLI）</option>
          <option value="custom"${b.backend === 'custom' ? ' selected' : ''}>自定义 API（URL + Key，无需 CLI）</option>
        </select>
        <div class="field-hint" id="fBackendHint"></div>
      </div>
    </div>

    <div class="field" id="fAgyProfileField" ${
      b.backend === 'agy' ? '' : 'hidden'
    }>
      <label>Antigravity Google 账号</label>
      <div class="model-field-row">
        <select id="fAgyProfile">
          ${(S.agyProfiles || [])
            .map(
              (p) =>
                `<option value="${esc(p.id)}"${
                  (b.agyProfile || 'default') === p.id ? ' selected' : ''
                }>${esc(p.name)}${p.ready ? '（已登录）' : '（待登录）'}${
                  p.account ? ` · ${esc(p.account)}` : ''
                }</option>`
            )
            .join('')}
        </select>
        <button type="button" class="btn" id="fAgyAdd">添加账号</button>
        <button type="button" class="btn" id="fAgyLogin">登录</button>
      </div>
      <div class="field-hint">每个 Google 账号单独一个 HOME，模型列表也按账号独立；点「添加账号」会打开终端登录，登录完成后自动拉取该账号可用的模型。</div>
    </div>

    <div class="field" id="fApiConfig" hidden>
      <label>接入方式</label>
      <select id="fApiMode">
        <option value="official"${api.mode !== 'custom' ? ' selected' : ''}>本机登录 / 官方订阅</option>
        <option value="custom"${api.mode === 'custom' ? ' selected' : ''}>自定义 API（仅这个 Bot）</option>
      </select>
      <div class="field-hint" id="fApiModeHint"></div>
    </div>

    <div class="field" id="fApiCustom" hidden>
      <div class="field" style="margin:0 0 10px">
        <label>常用服务商</label>
        <select id="fApiPreset"><option value="">自定义 / 手动填写</option></select>
        <div class="field-hint">选一个会自动填 Base URL 和推荐模型，也可以自己改。</div>
      </div>
      <div class="field" id="fApiStyleField" style="margin:0 0 10px">
        <label>API 类型</label>
        <select id="fApiStyle">
          <option value="openai"${api.style === 'openai' ? ' selected' : ''}>OpenAI 兼容（/chat/completions）</option>
          <option value="anthropic"${api.style === 'anthropic' ? ' selected' : ''}>Anthropic 兼容（/v1/messages）</option>
        </select>
      </div>
      <div class="field" style="margin:0 0 10px">
        <label>Base URL</label>
        <input id="fApiBaseUrl" value="${esc(api.baseUrl || '')}" placeholder="https://api.deepseek.com/v1" />
      </div>
      <div>
        <label>API Key</label>
        <input id="fApiKey" type="password" autocomplete="off" placeholder="${
          api.hasKey ? '已保存，留空则不修改' : 'sk-...'
        }" />
        <div class="field-hint">Key 只保存在本机 data/state.json，不会进仓库；留空不会清空已保存的 Key。</div>
      </div>
    </div>

    <div class="field">
      <label>模型</label>
      <div class="model-field-row">
        <input id="fModel" value="${esc(b.model || '')}" list="modelList" placeholder="选择来源后从这里挑" />
        <button type="button" class="btn model-browse-btn" id="fModelFetchBtn" title="用当前 Base URL 和 API Key 拉取模型" hidden>拉取模型</button>
        <button type="button" class="btn model-browse-btn" id="fModelBrowseBtn" title="浏览 / 搜索全部模型">浏览</button>
      </div>
      <datalist id="modelList">${modelOptions(
        b.backend,
        b.model,
        b.source,
        b.agyProfile || 'default'
      )}</datalist>
      <div class="field-hint" id="modelInfo"></div>
      <div class="model-picker" id="fModelPicker" hidden>
        <input id="fModelSearch" placeholder="搜索模型，比如输入 mimo…" autocomplete="off" spellcheck="false" />
        <div class="model-picker-list" id="fModelPickerList"></div>
      </div>
      <div class="model-keep" id="fModelKeep" hidden>
        <div class="model-keep-head">
          <span>已拉取 <b id="fModelKeepCount">0</b> 个模型，勾选要保留的</span>
          <span class="model-keep-actions">
            <button type="button" class="btn ghost" id="fModelKeepAll">全选</button>
            <button type="button" class="btn ghost" id="fModelKeepNone">清空</button>
            <button type="button" class="btn" id="fModelKeepSave">保存所选</button>
          </span>
        </div>
        <div class="model-keep-list" id="fModelKeepList"></div>
        <div class="field-hint">勾选的会出现在聊天底部的模型切换里；取消勾选就不再显示。默认模型从勾选的里面选。</div>
      </div>
    </div>

    <div class="field">
      <label>单次执行超时</label>
      <select id="fTimeoutMin">
        ${[
          [0, '不限（默认，推荐）'],
          [2, '2 分钟'],
          [5, '5 分钟'],
          [10, '10 分钟'],
          [30, '30 分钟'],
          [60, '1 小时'],
          [120, '2 小时'],
        ]
          .map(([v, label]) => {
            const cur = b.timeoutMin > 0 ? Number(b.timeoutMin) : 0;
            return `<option value="${v}" ${cur === v ? 'selected' : ''}>${label}</option>`;
          })
          .join('')}
      </select>
      <div class="field-hint">默认不限制运行时间，任务会正常跑完；只有你在这里显式选了分钟数，才会到点自动中止。流程环节同样遵循这个设置。</div>
    </div>

    ${
      b.id && b.id === S.settings?.leaderId
        ? `<div class="field">
      <label>流程设计规则（领导 Bot 专用）</label>
      <textarea id="fFlowRules" rows="12" spellcheck="false">${esc(
        b.flowDesignRules || S.flowRulesDefault || ''
      )}</textarea>
      <div class="field-hint">这段提示词会放进领导 Bot 的每轮提示词，规定它怎么设计群流程；可以直接改，保存后立即生效。</div>
      <button type="button" class="btn" id="fFlowRulesReset">恢复默认</button>
    </div>`
        : ''
    }

    <div class="field row-2 even">
      <div>
        <label>额度来源</label>
        <input id="fSource" value="${esc(b.source || '')}" list="sourceList" placeholder="ChatGPT Plus" />
        <datalist id="sourceList">${sourceOptions}</datalist>
      </div>
      <div>
        <label>计费方式</label>
        <div class="form-static" id="fBillingText">按量（用多少扣多少）</div>
        <input type="hidden" id="fBilling" value="${esc(b.billing || 'payg')}" />
      </div>
    </div>

    <div class="field">
      <label>额度标签（左侧列表显示，留空自动拼成「来源 · 模型」）</label>
      <input id="fQuota" value="${esc(b.quotaOverride ?? b.quota ?? '')}" placeholder="留空即可" />
    </div>

    ${
      isNew
        ? ''
        : `<div class="field">
             <label>额度消耗（本机累计统计）</label>
             ${usageBlock(b)}
             <div style="margin-top:8px"><button class="btn" id="fResetUsage" style="font-size:12px;padding:6px 12px">重置统计</button></div>
           </div>`
    }

    <div class="field">
      <label>权限范围（文件 / 命令能碰哪些目录）</label>
      <select id="fPermMode">
        <option value="workspace"${perm.mode === 'workspace' ? ' selected' : ''}>仅工作区（默认，最安全）</option>
        <option value="custom"${perm.mode === 'custom' ? ' selected' : ''}>自定义目录</option>
        <option value="full"${perm.mode === 'full' ? ' selected' : ''}>完全访问（本机任意目录，谨慎）</option>
      </select>
      <div id="fPermFields" ${perm.mode === 'workspace' ? 'hidden' : ''} style="margin-top:10px">
        <div class="field">
          <label>可读写目录（每行一个）</label>
          <textarea id="fPermWrite" placeholder="/Users/you/project&#10;~/Downloads/website">${esc(
            (perm.write || []).join('\n')
          )}</textarea>
        </div>
        <div class="field">
          <label>只读目录（每行一个）</label>
          <textarea id="fPermRead" placeholder="~/Reference">${esc((perm.read || []).join('\n'))}</textarea>
        </div>
        <div class="field-hint">工作区始终可读写；只读目录会禁止文件编辑，但命令仍受各自 CLI 的沙箱限制。</div>
      </div>
    </div>

    <div class="field" id="fCustomToolsField" ${b.backend === 'custom' ? '' : 'hidden'}>
      <label class="check-line"><input type="checkbox" id="fCustomTools" ${
        b.customTools !== false ? 'checked' : ''
      } style="width:auto;margin-right:6px" />允许直连 API 调用本机工具（列目录 / 读写文件 / 执行命令）</label>
      <div class="field-hint">只对自定义 API Bot 生效；关闭后它只能聊天，不能碰本机文件和命令。</div>
    </div>

    <div class="field">
      <label class="check-line"><input type="checkbox" id="fCodexFast" ${
        b.codexFast !== false ? 'checked' : ''
      } style="width:auto;margin-right:6px" />Codex 快速模式（跳过 MCP / 用户插件，启动更快）</label>
      <div class="field-hint">只影响 Codex。如果这个 Bot 依赖你配置的 MCP 工具，可以关掉。</div>
    </div>

    <div class="field">
      <label class="check-line"><input type="checkbox" id="fShowRoleAbbr" ${
        b.showRoleAbbr !== false ? 'checked' : ''
      } style="width:auto;margin-right:6px" />在群里名字后显示职位缩写（默认开）</label>
      <div class="field-hint">职位是按群配置的：左侧公文包按钮 → 选择项目/群 → 分配这个群的职务班子。脱离这个群就不显示职位。</div>
    </div>

    <div class="field">
      <label>岗位说明（决定它怎么干活）</label>
      <textarea id="fPersona" placeholder="擅长什么、什么时候该转交">${esc(b.persona || '')}</textarea>
    </div>
    <div class="field">
      <label>长期记忆（只属于这个 bot，每次对话都会带上）</label>
      <textarea id="fMemory" placeholder="可以留空">${esc(b.memory || '')}</textarea>
    </div>
    <div class="field">
      <label><input type="checkbox" id="fHidden" ${b.hidden ? 'checked' : ''} style="width:auto;margin-right:6px" />在左侧隐藏</label>
    </div>
    <div class="modal-actions">
      ${isNew ? '' : '<button class="btn danger" id="fDelete">删除</button>'}
      <button class="btn" id="fCancel">取消</button>
      <button class="btn primary" id="fSave">保存</button>
    </div>`;
}

function wireBotForm() {
  const rulesReset = $('#fFlowRulesReset');
  if (rulesReset) {
    rulesReset.onclick = () => {
      const box = $('#fFlowRules');
      if (box) box.value = S.flowRulesDefault || '';
    };
  }
  const src = $('#fSource');
  const backend = $('#fBackend');
  const model = $('#fModel');
  const billing = $('#fBilling');
  const info = $('#modelInfo');
  const permMode = $('#fPermMode');
  const permFields = $('#fPermFields');
  if (permMode && permFields) {
    const syncPerm = () => (permFields.hidden = permMode.value === 'workspace');
    permMode.onchange = syncPerm;
    syncPerm();
  }
  if (!src || !backend || !model) return;

  const agyField = $('#fAgyProfileField');
  const agySel = $('#fAgyProfile');
  const renderAgyOptions = (selected) => {
    if (!agySel) return;
    const cur = selected || agySel.value || 'default';
    agySel.innerHTML = (S.agyProfiles || [])
      .map(
        (p) =>
          `<option value="${esc(p.id)}"${p.id === cur ? ' selected' : ''}>${esc(p.name)}${
            p.ready ? '（已登录）' : '（待登录）'
          }${p.account ? ` · ${esc(p.account)}` : ''}</option>`
      )
      .join('');
  };
  let agyPollToken = 0;
  const pollAgyLogin = async (profileId, initialAccount = '') => {
    const token = ++agyPollToken;
    for (let i = 0; i < 90; i += 1) {
      await new Promise((r) => setTimeout(r, 2000));
      if (token !== agyPollToken || !document.querySelector('#fAgyProfile')) return;
      try {
        const res = await api('/api/agy/profiles');
        S.agyProfiles = res.profiles || [];
        renderAgyOptions(profileId);
        const profile = S.agyProfiles.find((p) => p.id === profileId);
        if (profile?.ready && profile?.account && profile.account !== initialAccount) {
          await loadAgyProfileModels(profileId, { switchModel: true });
          toast(`账号已登录：${profile.account}`);
          return;
        }
      } catch {}
    }
  };
  const apiConfig = $('#fApiConfig');
  const apiMode = $('#fApiMode');
  const apiCustom = $('#fApiCustom');
  const apiStyle = $('#fApiStyle');
  const apiStyleField = $('#fApiStyleField');
  const apiBase = $('#fApiBaseUrl');
  const apiHint = $('#fApiModeHint');
  const apiPreset = $('#fApiPreset');
  const billingText = $('#fBillingText');
  const apiModeLabel = apiConfig?.querySelector('label');
  const fetchBtn = $('#fModelFetchBtn');
  let lastApiBackend = backend.value;
  const cleanModels = (list) => {
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const m of list) {
      const id =
        typeof m === 'string' ? m.trim() : m && typeof m === 'object' ? String(m.id || m.name || '').trim() : '';
      if (id && id !== '[object Object]' && !out.includes(id)) out.push(id);
    }
    return out.slice(0, 100);
  };
  let fetchedApiModels = [];
  let keptModels = [];
  try {
    fetchedApiModels = cleanModels(JSON.parse($('#fApiModels')?.value || '[]'));
  } catch {
    fetchedApiModels = [];
  }
  keptModels = [...fetchedApiModels];
  let refresh = () => {};
  const persistApiModels = () => {
    const el = $('#fApiModels');
    if (el) el.value = JSON.stringify(keptModels);
  };
  const renderKeepList = () => {
    const box = $('#fModelKeep');
    const listEl = $('#fModelKeepList');
    const countEl = $('#fModelKeepCount');
    if (!box || !listEl) return;
    box.hidden = !fetchedApiModels.length;
    if (!fetchedApiModels.length) return;
    if (countEl) countEl.textContent = `${keptModels.length} / ${fetchedApiModels.length}`;
    listEl.innerHTML = fetchedApiModels
      .map(
        (id) => `<label class="model-keep-row">
          <input type="checkbox" data-keep="${esc(id)}" ${
            keptModels.includes(id) ? 'checked' : ''
          } />
          <span class="mk-name">${esc(modelDisplayName(id))}</span>
          <em>${esc(id)}</em>
          ${
            model.value.trim() === id
              ? '<span class="mk-default">默认</span>'
              : `<button type="button" class="mk-set" data-default="${esc(id)}">设为默认</button>`
          }
        </label>`
      )
      .join('');
  };
  const isCustomApi = () =>
    ['custom', 'claude', 'codex'].includes(backend.value) &&
    (backend.value === 'custom' || apiMode?.value === 'custom');
  const effectiveModels = () => {
    const agyProfileId = backend.value === 'agy' ? agySel?.value || 'default' : '';
    return isCustomApi() && keptModels.length
      ? keptModels
      : modelsFor(backend.value, src.value, agyProfileId);
  };

  const renderApiPresets = () => {
    if (!apiPreset) return;
    const be = backend.value;
    const cur = apiPreset.value;
    const list = API_PRESETS.filter((p) => p.targets.includes(be));
    apiPreset.innerHTML =
      '<option value="">自定义 / 手动填写</option>' +
      list.map((p) => `<option value="${p.id}">${p.name}</option>`).join('');
    if (list.some((p) => p.id === cur)) apiPreset.value = cur;
  };

  const applyApiPreset = (id) => {
    const p = API_PRESETS.find((x) => x.id === id && x.targets.includes(backend.value));
    if (!p) return;
    const be = backend.value;
    const wantAnthropic = be === 'claude' || (be === 'custom' && apiStyle?.value === 'anthropic');
    if (wantAnthropic && p.anthropic) {
      if (apiStyle) apiStyle.value = 'anthropic';
      if (apiBase) apiBase.value = p.anthropic;
    } else if (be === 'claude' && p.anthropic) {
      if (apiStyle) apiStyle.value = 'anthropic';
      if (apiBase) apiBase.value = p.anthropic;
    } else {
      if (apiStyle) apiStyle.value = p.style === 'anthropic' ? 'anthropic' : 'openai';
      if (apiBase) apiBase.value = p.base;
    }
    if (model && !model.value.trim() && p.model) model.value = p.model;
    if (model) model.placeholder = p.model ? `例如 ${p.model}` : '选择来源后从这里挑';
    fetchedApiModels = [];
    persistApiModels();
    refresh();
  };

  const syncBilling = () => {
    if (!billing) return;
    const be = backend.value;
    const custom = be === 'custom' || (be === 'claude' || be === 'codex') && apiMode?.value === 'custom';
    let sourceVal = src.value;
    let lock = false;
    let bill = 'payg';
    if (be === 'custom') {
      sourceVal = '自定义 API';
      bill = 'payg';
      lock = true;
    } else if (be === 'claude') {
      sourceVal = custom ? '自定义 API' : 'Claude 订阅';
      bill = custom ? 'payg' : 'subscription';
      lock = true;
    } else if (be === 'codex') {
      sourceVal = custom ? '自定义 API' : 'ChatGPT Plus';
      bill = custom ? 'payg' : 'subscription';
      lock = true;
    } else if (['agy', 'codebuddy', 'qoder'].includes(be)) {
      sourceVal = DEFAULT_SOURCE_BY_BACKEND[be];
      bill = 'subscription';
      lock = true;
    } else {
      const meta = sourceMeta(src.value);
      bill = meta?.billing || 'payg';
    }
    if (lock) src.value = sourceVal;
    src.disabled = lock;
    billing.value = bill;
    if (billingText) {
      billingText.textContent =
        bill === 'subscription'
          ? '订阅（不额外花钱）'
          : bill === 'free'
            ? '免费额度'
            : '按量（用多少扣多少）';
    }
  };

  if (apiPreset) apiPreset.onchange = () => applyApiPreset(apiPreset.value);
  const syncApi = () => {
    const be = backend.value;
    const supported = ['claude', 'codex', 'custom'].includes(be);
    if (apiConfig) apiConfig.hidden = !supported;
    const ctField = $('#fCustomToolsField');
    if (ctField) ctField.hidden = be !== 'custom';
    if (!supported) {
      lastApiBackend = be;
      if (apiPreset) renderApiPresets();
      syncBilling();
      return;
    }
    if (be !== 'custom' && lastApiBackend === 'custom' && apiMode) {
      apiMode.value = 'official';
    }
    if (be === 'custom' && lastApiBackend !== 'custom' && apiStyle) {
      apiStyle.value = 'openai';
    }
    lastApiBackend = be;
    if (be === 'custom') apiMode.value = 'custom';
    if (be === 'claude' && apiStyle) apiStyle.value = 'anthropic';
    if (be === 'codex' && apiStyle) apiStyle.value = 'openai';
    const custom = be === 'custom' || apiMode?.value === 'custom';
    if (apiCustom) apiCustom.hidden = !custom;
    if (apiStyleField) apiStyleField.hidden = be !== 'custom';
    if (apiMode) apiMode.disabled = be === 'custom';
    if (apiHint) {
      if (be === 'claude') {
        apiHint.textContent = custom
          ? '只给这个 Bot 使用 Anthropic 兼容接口，例如 https://api.deepseek.com/anthropic；留空 Key 不会清空已保存的 Key。'
          : '使用本机 Claude Code 当前登录/全局配置；如果你用 cc-switch 把 Claude Code 接到了第三方，这里也会沿用那份配置。';
      } else if (be === 'codex') {
        apiHint.textContent = custom
          ? '只给这个 Bot 使用 OpenAI 兼容的 Responses API；Codex 的工具能力仍然可用。'
          : '使用本机 Codex / ChatGPT 登录；如果你全局改过 Codex 的 provider，这里会沿用。';
      } else {
        apiHint.textContent =
          '不需要安装任何 CLI，直接调用 OpenAI / Anthropic 兼容接口；该模式只能对话，不能读写文件或执行命令。';
      }
    }
    if (be === 'claude' || be === 'custom' || be === 'codex') {
      const want = custom || be === 'custom' ? '自定义 API' : be === 'claude' ? 'Claude 订阅' : 'ChatGPT Plus';
      if (src && src.value !== want && (custom || be === 'custom' || be === 'claude' || src.value === '自定义 API')) {
        src.value = want;
        const meta = sourceMeta(want);
        if (meta?.billing) billing.value = meta.billing;
      }
    }
    if (custom) billing.value = 'payg';
    if (apiMode) apiMode.style.display = be === 'custom' ? 'none' : '';
    if (apiModeLabel) {
      apiModeLabel.textContent = be === 'custom' ? '接入方式：直接调用 API' : '接入方式';
    }
    if (apiBase) {
      apiBase.placeholder =
        be === 'claude' || (be === 'custom' && apiStyle?.value === 'anthropic')
          ? 'https://api.deepseek.com/anthropic'
          : be === 'codex'
            ? 'https://api.deepseek.com/v1'
            : 'https://api.openai.com/v1';
    }
    if (fetchBtn) fetchBtn.hidden = !(be === 'custom' || (be === 'claude' || be === 'codex') && apiMode?.value === 'custom');
    if (apiPreset) renderApiPresets();
    syncBilling();
  };
  if (apiMode) apiMode.onchange = syncApi;
  if (apiStyle)
    apiStyle.onchange = () => {
      if (apiBase) {
        apiBase.placeholder =
          apiStyle.value === 'anthropic'
            ? 'https://api.deepseek.com/anthropic'
            : 'https://api.openai.com/v1';
      }
      applyApiPreset(apiPreset?.value || '');
    };
  const toggleAgy = () => {
    if (agyField) agyField.hidden = backend.value !== 'agy';
    renderAgyOptions();
    syncApi();
  };
  backend.addEventListener('change', toggleAgy);
  toggleAgy();
  if (agySel) {
    agySel.onchange = () => {
      void loadAgyProfileModels(agySel.value, { switchModel: true });
    };
  }
  if (backend.value === 'agy') {
    void loadAgyProfileModels(agySel?.value || 'default', { switchModel: true });
  }
  const agyAdd = $('#fAgyAdd');
  const agyLogin = $('#fAgyLogin');
  if (agyAdd)
    agyAdd.onclick = async () => {
      const name = await openTextPrompt({
        title: '添加 Google 账号',
        label: '给这个账号起个备注名',
        placeholder: '例如：Pro 账号 2',
        okText: '创建并登录',
      });
      if (!name) return;
      try {
        const p = await api('/api/agy/profiles', { method: 'POST', body: { name } });
        S.agyProfiles.push(p);
        renderAgyOptions(p.id);
        void loadAgyProfileModels(p.id, { switchModel: true });
        await api(`/api/agy/profiles/${p.id}/login`, { method: 'POST' });
        toast('已打开终端，请在新窗口完成 Google 登录');
        void pollAgyLogin(p.id, '');
      } catch (e) {
        toast(`添加失败：${e.message}`, 'err');
      }
    };
  if (agyLogin)
    agyLogin.onclick = async () => {
      const id = agySel?.value || 'default';
      const initialAccount = S.agyProfiles.find((p) => p.id === id)?.account || '';
      try {
        await api(`/api/agy/profiles/${id}/login`, { method: 'POST' });
        toast('已打开终端，请在窗口里完成 Google 登录');
        void pollAgyLogin(id, initialAccount);
      } catch (e) {
        toast(`打开登录失败：${e.message}`, 'err');
      }
    };

  const pick = $('#fAvatarPick');
  if (pick)
    pick.onclick = (e) => {
      const btn = e.target.closest('[data-avatar]');
      if (!btn) return;
      [...pick.children].forEach((c) => c.classList.toggle('on', c === btn));
      $('#fAvatar').value = btn.dataset.avatar;
    };

  const avatarMarket = $('#fAvatarMarket');
  if (avatarMarket) avatarMarket.onclick = () => openMarket('avatar');

  const avatarUpload = $('#fAvatarUpload');
  const avatarFile = $('#fAvatarFile');
  if (avatarUpload && avatarFile && pick) {
    avatarUpload.onclick = () => avatarFile.click();
    avatarFile.onchange = async () => {
      const file = avatarFile.files?.[0];
      if (!file) return;
      avatarUpload.disabled = true;
      avatarUpload.textContent = '上传中…';
      try {
        const url = await uploadImage('avatar', file);
        S.avatars = [url, ...(S.avatars || []).filter((a) => a !== url)];
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'avatar-opt on';
        btn.dataset.avatar = url;
        btn.title = '使用这个头像';
        btn.innerHTML = `<img src="${esc(url)}" alt="" />`;
        [...pick.children].forEach((c) => c.classList.remove('on'));
        pick.prepend(btn);
        $('#fAvatar').value = url;
        toast('头像已上传，已选中');
      } catch (e) {
        toast(`上传失败：${e.message}`, 'err');
      } finally {
        avatarUpload.disabled = false;
        avatarUpload.textContent = '上传头像图片';
        avatarFile.value = '';
      }
    };
  }

  const drawPicker = () => {
    const picker = $('#fModelPicker');
    const listEl = $('#fModelPickerList');
    if (!picker || picker.hidden || !listEl) return;
    const q = ($('#fModelSearch')?.value || '').trim().toLowerCase();
    let items = effectiveModels();
    if (['codex', 'codebuddy', 'qoder'].includes(backend.value) && !isCustomApi()) items = ['', ...items];
    const rows = items.filter((id) => {
      if (!q) return true;
      const name = modelDisplayName(id).toLowerCase();
      return id.toLowerCase().includes(q) || name.includes(q);
    });
    listEl.innerHTML = rows.length
      ? rows
          .map(
            (id) => `<button type="button" class="model-item ${
              id === model.value.trim() ? 'active' : ''
            }" data-pick="${esc(id)}">
              <span class="mi-name">${esc(modelDisplayName(id))}</span>
              <span class="mi-sub">${esc(id || '留空 -m')}</span>
              <span class="mi-check">✓</span>
            </button>`
          )
          .join('')
      : `<div class="muted" style="padding:8px">没有匹配的模型</div>`;
  };

  refresh = () => {
    const meta = sourceMeta(src.value);
    const list = effectiveModels();
    if (isCustomApi()) {
      $('#modelList').innerHTML = list
        .map((id) => `<option value="${esc(id)}"></option>`)
        .join('');
    } else {
      $('#modelList').innerHTML = modelOptions(
        backend.value,
        model.value.trim(),
        src.value,
        backend.value === 'agy' ? agySel?.value || 'default' : ''
      );
    }
    if (!model.value.trim() && list.length && !isCustomApi()) model.placeholder = list[0];
    renderKeepList();

    let text = '';
    let warn = false;
    if (isCustomApi()) {
      text = list.length
        ? `已从 API 拉取 ${list.length} 个模型（全部保留）；这里选默认模型，聊天时可在底部切换`
        : '点「拉取模型」从当前 URL 获取全部模型，也可以直接填模型名';
    } else if (backend.value === 'codex') {
      text = list.length
        ? `Codex：${list.length} 个模型 · 留空用默认`
        : 'Codex 可留空用默认模型，也可以填 codex 支持的模型名';
    } else if (backend.value === 'codebuddy') {
      text = list.length ? `WorkBuddy：${list.length} 个模型 · 留空用默认` : 'WorkBuddy 可留空用默认模型';
    } else if (backend.value === 'qoder') {
      text = list.length ? `Qoder：${list.length} 个模型 · 留空用默认` : 'Qoder 可留空用默认模型';
    } else if (backend.value === 'agy') {
      text = `Antigravity：${list.length} 个模型`;
    } else if (meta && (meta.prefixes || []).length) {
      text = `${meta.name}：${list.length} 个模型 · ${meta.prefixes.map((p) => p + '/*').join(' / ')}`;
    } else if (meta) {
      text = `${meta.name}：不限制模型，共 ${list.length} 个可用`;
    } else {
      text = `自定义来源：共 ${list.length} 个模型可用`;
    }

    const cur = model.value.trim();
    if (!isCustomApi() && !sourceCoversModel(src.value, backend.value, cur)) {
      const sug = sourceForModel(backend.value, cur);
      text = `「${src.value || '未设置来源'}」下没有这个模型` + (sug ? `，它属于「${sug.name}」` : '');
      warn = true;
    } else if (
      !isCustomApi() &&
      cur &&
      list.length &&
      !list.includes(cur) &&
      meta &&
      (meta.prefixes || []).length
    ) {
      text = `模型列表里没有 ${cur}，确认拼写或从下拉里选一个`;
      warn = true;
    }
    info.textContent = text;
    info.classList.toggle('warn', warn);
    if (list.length > 15) info.textContent = `${text} · 可点「浏览」搜索`;
    drawPicker();
  };
  B.agyRefresh = refresh;

  if (fetchBtn) {
    fetchBtn.onclick = async () => {
      const base = (apiBase?.value || '').trim();
      if (!base) return toast('先填写 Base URL', 'err');
      const style = apiStyle?.value === 'anthropic' ? 'anthropic' : 'openai';
      const oldText = fetchBtn.textContent;
      fetchBtn.disabled = true;
      fetchBtn.textContent = '拉取中…';
      try {
        const r = await api('/api/models/fetch', {
          method: 'POST',
          body: {
            baseUrl: base,
            style,
            key: ($('#fApiKey')?.value || '').trim(),
            botId: $('#fBotId')?.value || '',
          },
        });
        fetchedApiModels = cleanModels(r.models || []);
        if (!keptModels.length) keptModels = [...fetchedApiModels];
        if (!model.value.trim() && keptModels.length) model.value = keptModels[0];
        persistApiModels();
        refresh();
        const picker = $('#fModelPicker');
        if (picker) {
          picker.hidden = false;
          drawPicker();
        }
        toast(
          fetchedApiModels.length
            ? `拉取到 ${fetchedApiModels.length} 个模型，可以直接挑`
            : '接口没有返回模型'
        );
      } catch (e) {
        toast(`拉取失败：${apiErrorText(e)}`, 'err');
      } finally {
        fetchBtn.disabled = false;
        fetchBtn.textContent = oldText;
      }
    };
  }
  const clearFetched = () => {
    if (!isCustomApi()) return;
    fetchedApiModels = [];
    persistApiModels();
    refresh();
  };
  if (apiBase) apiBase.addEventListener('input', clearFetched);
  if (apiStyleField) apiStyle?.addEventListener('change', clearFetched);
  $('#fApiKey')?.addEventListener('input', clearFetched);

  const backendHint = $('#fBackendHint');
  const updateBackendHint = () => {
    if (!backendHint) return;
    const info = (S.setup?.backends || []).find((b) => b.id === backend.value);
    if (!info) {
      backendHint.textContent = '';
      return;
    }
    if (info.always) {
      backendHint.textContent = '不需要安装任何 CLI；填 Base URL + API Key 即可，只能对话，不能读写文件或执行命令。';
      return;
    }
    if (info.installed) {
      backendHint.textContent =
        info.loggedIn === false
          ? `已安装，但还没登录。先在终端运行：${info.login}`
          : `已安装。${info.login}`;
      return;
    }
    backendHint.textContent = `未检测到 ${info.cmd || info.name}。先安装：${info.install}；或者改用「自定义 API」。`;
  };
  backend.onchange = () => {
    model.value = '';
    const meta = sourceMeta(src.value);
    if (!meta || meta.backend !== backend.value) {
      src.value = DEFAULT_SOURCE_BY_BACKEND[backend.value] || src.value;
      const def = sourceMeta(src.value);
      if (def && def.billing) billing.value = def.billing;
    }
    if (backend.value === 'custom') {
      src.value = '自定义 API';
      billing.value = 'payg';
    }
    syncApi();
    updateBackendHint();
    refresh();
  };
  updateBackendHint();

  src.onchange = () => {
    const meta = sourceMeta(src.value);
    if (meta) {
      if (meta.backend && meta.backend !== backend.value) {
        backend.value = meta.backend;
        model.value = '';
      }
      if (meta.billing) billing.value = meta.billing;
    }
    const cur = model.value.trim();
    if (cur && !sourceCoversModel(src.value, backend.value, cur)) model.value = '';
    syncBilling();
    refresh();
  };

  const syncFromModel = () => {
    const cur = model.value.trim();
    const sug = sourceForModel(backend.value, cur);
    if (cur && sug && !sourceCoversModel(src.value, backend.value, cur)) {
      src.value = sug.name;
      if (sug.backend) backend.value = sug.backend;
      if (sug.billing) billing.value = sug.billing;
    }
    refresh();
  };
  model.onchange = syncFromModel;
  model.onblur = syncFromModel;

  const keepList = $('#fModelKeepList');
  if (keepList) {
    keepList.addEventListener('change', (e) => {
      const cb = e.target.closest('[data-keep]');
      if (!cb) return;
      const id = cb.dataset.keep;
      if (cb.checked) {
        if (!keptModels.includes(id)) keptModels.push(id);
      } else {
        keptModels = keptModels.filter((x) => x !== id);
      }
      persistApiModels();
      refresh();
    });
    keepList.addEventListener('click', (e) => {
      const set = e.target.closest('[data-default]');
      if (!set) return;
      model.value = set.dataset.default;
      persistApiModels();
      refresh();
    });
  }
  if ($('#fModelKeepAll'))
    $('#fModelKeepAll').onclick = () => {
      keptModels = [...fetchedApiModels];
      persistApiModels();
      if (!model.value.trim() && keptModels.length) model.value = keptModels[0];
      refresh();
    };
  if ($('#fModelKeepNone'))
    $('#fModelKeepNone').onclick = () => {
      keptModels = [];
      persistApiModels();
      refresh();
    };
  if ($('#fModelKeepSave'))
    $('#fModelKeepSave').onclick = () => {
      if (!keptModels.length) return toast('至少保留一个模型', 'err');
      if (!keptModels.includes(model.value.trim())) model.value = keptModels[0];
      persistApiModels();
      refresh();
      toast(`已保存 ${keptModels.length} 个模型`);
    };

  const browseBtn = $('#fModelBrowseBtn');
  const picker = $('#fModelPicker');
  if (browseBtn && picker) {
    browseBtn.onclick = () => {
      if (!picker.hidden) {
        picker.hidden = true;
        return;
      }
      picker.hidden = false;
      $('#fModelSearch').value = '';
      drawPicker();
      $('#fModelSearch').focus();
      picker.scrollIntoView({ block: 'center', behavior: 'smooth' });
    };
    $('#fModelSearch').oninput = drawPicker;
    $('#fModelPickerList').onclick = (e) => {
      const item = e.target.closest('[data-pick]');
      if (!item) return;
      model.value = item.dataset.pick;
      syncFromModel();
      picker.hidden = true;
    };
  }

  refresh();
}

function openWelcome() {
  const setup = S.setup;
  if (!setup) return;
  const firstRun = !!setup.firstRun;
  const rows = (setup.backends || [])
    .map((b) => {
      const state = b.installed
        ? b.loggedIn === true
          ? '已登录'
          : b.loggedIn === false
            ? '已安装 · 未登录'
            : '可用'
        : '未安装';
      return `<div class="welcome-cli ${b.installed ? 'ok' : 'miss'}">
        <span class="welcome-dot"></span>
        <div class="welcome-cli-main"><b>${esc(b.name)}</b><span>${esc(b.note || '')}</span></div>
        <div class="welcome-cli-state">${esc(state)}</div>
        ${b.installed ? '' : `<code>${esc(b.install || '')}</code>`}
      </div>`;
    })
    .join('');
  openModal(
    `<div class="welcome">
      <h3>${firstRun ? '欢迎使用 Bot Team' : '本机环境检查'}</h3>
      <p class="welcome-lead">${
        firstRun
          ? '把多个 AI 员工放进一个本地工作台。先检查这台机器已经有哪些 CLI；一个都没有也没关系，自定义 API 不需要安装任何东西。'
          : '下面是当前检测到的 CLI 和登录状态。装好/登录后点「重新检查」即可刷新。'
      }</p>
      <div class="welcome-env">
        <div class="welcome-env-title">本机环境</div>
        ${rows}
      </div>
      <div class="welcome-tip">安装和登录都在终端完成。装好后回到这里点「创建第一个 Bot」；之后也可以点侧栏右上角 <b>+</b> 随时新建。</div>
      <div class="modal-actions">
        ${firstRun ? '' : '<button type="button" class="btn" id="welcomeRecheck">重新检查</button>'}
        <button type="button" class="btn" id="welcomeSkip">${firstRun ? '先逛逛' : '关闭'}</button>
        <button type="button" class="btn primary" id="welcomeCreate">${firstRun ? '创建第一个 Bot' : '新建 Bot'}</button>
      </div>
    </div>`,
    'welcome'
  );
  const recheck = $('#welcomeRecheck');
  if (recheck)
    recheck.onclick = async () => {
      try {
        S.setup = await api('/api/setup/status');
        openWelcome();
      } catch (e) {
        toast(`检查失败：${e.message}`, 'err');
      }
    };
  $('#welcomeSkip').onclick = async () => {
    if (firstRun) {
      try {
        await api('/api/setup/done', { method: 'POST' });
        if (S.setup) S.setup.firstRun = false;
      } catch {}
      toast('随时点侧栏右上角「+」新建第一个 Bot', '', 4000);
    }
    closeModal();
  };
  $('#welcomeCreate').onclick = () => {
    const firstCli = (setup.backends || []).find((b) => b.id !== 'custom' && b.installed);
    const target = firstCli || (setup.backends || []).find((b) => b.id === 'custom');
    const backend = target?.id || 'custom';
    closeModal();
    newBot({
      name: '我的第一个 Bot',
      emoji: '🤖',
      backend,
      source: DEFAULT_SOURCE_BY_BACKEND[backend] || '自定义 API',
      billing: backend === 'custom' ? 'payg' : undefined,
      model: '',
      persona: '',
      api:
        backend === 'custom'
          ? { mode: 'custom', style: 'openai', baseUrl: '', hasKey: false }
          : undefined,
    });
  };
}

async function newBot(preset = null) {
  S.newBotPreset = preset;
  openModal(botForm(null));
  S.newBotPreset = null;
  wireBotForm();
  $('#fCancel').onclick = closeModal;
  const saveBtn = $('#fSave');
  saveBtn.addEventListener(
    'click',
    () => {
      saveBtn.disabled = true;
      setTimeout(() => (saveBtn.disabled = false), 1200);
    },
    { capture: true }
  );
  $('#fSave').onclick = async () => {
    const body = {
      name: $('#fName').value.trim() || '新成员',
      emoji: $('#fEmoji').value || '🙂',
      avatar: $('#fAvatar').value,
      color: $('#fColor').value,
      backend: $('#fBackend').value,
      agyProfile: $('#fAgyProfile')?.value || 'default',
      model: $('#fModel').value.trim(),
      source: $('#fSource').value.trim(),
      billing: $('#fBilling').value,
      quota: $('#fQuota').value.trim(),
      persona: $('#fPersona').value,
      customTools: $('#fCustomTools') ? $('#fCustomTools').checked : true,
      memory: $('#fMemory').value,
      hidden: $('#fHidden').checked,
      permission: readPermissionFields('#fPermMode', '#fPermWrite', '#fPermRead'),
      showRoleAbbr: $('#fShowRoleAbbr').checked,
      codexFast: $('#fCodexFast').checked,
      timeoutMin: (() => {
        const v = $('#fTimeoutMin')?.value;
        if (v === '' || v === undefined) return 0;
        const n = Number(v);
        return Number.isFinite(n) ? n : 0;
      })(),
      flowDesignRules: $('#fFlowRules') ? $('#fFlowRules').value : undefined,
      api: ['claude', 'codex', 'custom'].includes($('#fBackend').value)
        ? {
            mode: $('#fApiMode')?.value || 'official',
            style: $('#fApiStyle')?.value || '',
            baseUrl: ($('#fApiBaseUrl')?.value || '').trim(),
            key: ($('#fApiKey')?.value || '').trim(),
            models: (() => {
              try {
                const v = JSON.parse($('#fApiModels')?.value || '[]');
                return Array.isArray(v) ? v.slice(0, 100) : [];
              } catch {
                return [];
              }
            })(),
          }
        : undefined,
      chatId: S.activeChatId,
    };
    if (!body.source && body.model) {
      const sug = sourceForModel(body.backend, body.model);
      if (sug) body.source = sug.name;
    }
    const err = botModelError(body);
    if (err) return toast(err, 'err');
    try {
      const created = await api('/api/bots', { method: 'POST', body });
      closeModal();
      await afterBotCreated(created);
    } catch (e) {
      toast(`保存失败：${e.message}`, 'err');
    }
  };
}

async function afterBotCreated(created) {
  try {
    const fresh = await api('/api/bootstrap');
    S.self = fresh.self;
    S.settings = fresh.settings || S.settings;
    S.bots = fresh.bots || [];
    S.chats = fresh.chats || [];
    S.roles = fresh.roles || S.roles;
    S.agyProfiles = fresh.agyProfiles || S.agyProfiles;
    if (S.setup) S.setup.firstRun = false;
    renderSidebar();
    if (created?.dmChatId) await openChat(created.dmChatId);
    else renderThread();
  } catch {}
}

async function editBot(botId) {
  let bot = botById(botId);
  if (!bot) return;
  try {
    const fresh = await api('/api/bootstrap');
    S.bots = fresh.bots;
    S.chats = fresh.chats;
    S.settings = fresh.settings || S.settings;
    S.sources = fresh.sources || S.sources;
    bot = botById(botId) || bot;
  } catch {}
  openModal(botForm(bot));
  wireBotForm();
  $('#fCancel').onclick = closeModal;
  const saveBtn = $('#fSave');
  saveBtn.addEventListener(
    'click',
    () => {
      saveBtn.disabled = true;
      setTimeout(() => (saveBtn.disabled = false), 1200);
    },
    { capture: true }
  );
  $('#fSave').onclick = async () => {
    const body = {
      name: $('#fName').value.trim(),
      emoji: $('#fEmoji').value,
      avatar: $('#fAvatar').value,
      color: $('#fColor').value,
      backend: $('#fBackend').value,
      agyProfile: $('#fAgyProfile')?.value || 'default',
      model: $('#fModel').value.trim(),
      source: $('#fSource').value.trim(),
      billing: $('#fBilling').value,
      quota: $('#fQuota').value.trim(),
      persona: $('#fPersona').value,
      customTools: $('#fCustomTools') ? $('#fCustomTools').checked : true,
      memory: $('#fMemory').value,
      hidden: $('#fHidden').checked,
      permission: readPermissionFields('#fPermMode', '#fPermWrite', '#fPermRead'),
      showRoleAbbr: $('#fShowRoleAbbr').checked,
      codexFast: $('#fCodexFast').checked,
      timeoutMin: (() => {
        const v = $('#fTimeoutMin')?.value;
        if (v === '' || v === undefined) return 0;
        const n = Number(v);
        return Number.isFinite(n) ? n : 0;
      })(),
      flowDesignRules: $('#fFlowRules') ? $('#fFlowRules').value : undefined,
      api: ['claude', 'codex', 'custom'].includes($('#fBackend').value)
        ? {
            mode: $('#fApiMode')?.value || 'official',
            style: $('#fApiStyle')?.value || '',
            baseUrl: ($('#fApiBaseUrl')?.value || '').trim(),
            key: ($('#fApiKey')?.value || '').trim(),
            models: (() => {
              try {
                const v = JSON.parse($('#fApiModels')?.value || '[]');
                return Array.isArray(v) ? v.slice(0, 100) : [];
              } catch {
                return [];
              }
            })(),
          }
        : undefined,
    };
    if (!body.source && body.model) {
      const sug = sourceForModel(body.backend, body.model);
      if (sug) body.source = sug.name;
    }
    const err = botModelError(body);
    if (err) return toast(err, 'err');
    try {
      await api(`/api/bots/${botId}`, { method: 'PATCH', body });
      closeModal();
    } catch (e) {
      toast(`保存失败：${e.message}`, 'err');
    }
  };
  const reset = $('#fResetUsage');
  if (reset)
    reset.onclick = async () => {
      if (!confirm(`重置 ${bot.name} 的用量统计？`)) return;
      await api(`/api/bots/${botId}/usage`, { method: 'DELETE' });
      bot.usage = { calls: 0, input: 0, output: 0, total: 0, updatedAt: 0, days: {} };
      document.querySelector('.usage').outerHTML = usageBlock(bot);
    };
  $('#fDelete').onclick = async () => {
    if (!confirm(`删除 ${bot.name}？`)) return;
    await api(`/api/bots/${botId}`, { method: 'DELETE' });
    if (activeChat()?.botIds.includes(botId)) {
      clearComposerDraft(S.activeChatId);
      S.activeChatId = null;
    }
    closeModal();
    renderSidebar();
    renderThread();
  };
}

const fmtSize = (n) => {
  n = Number(n || 0);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
};

function groupFilesHtml(files) {
  if (!files || !files.length) return '<div class="muted" style="padding:6px 2px">还没有文件</div>';
  return files
    .map(
      (f) => `<div class="group-file">
        <span class="gf-name">${esc(f.name)}</span>
        <span class="gf-size">${fmtSize(f.size)}</span>
        <button type="button" class="gf-del" data-del-file="${esc(f.file || f.name)}" title="删除">×</button>
      </div>`
    )
    .join('');
}

function groupLogHtml(chat) {
  const log = (chat.log || []).slice(-40).reverse();
  if (!log.length) return '<div class="muted" style="padding:6px 2px">还没有记录</div>';
  return log
    .map((e) => {
      const who = e.botId ? botById(e.botId)?.name || 'Bot' : '系统';
      const time = timeLabel(e.ts);
      return `<div class="log-row">
        <span class="log-time" title="${esc(fullTime(e.ts))}">${time}</span>
        <span class="log-who">${esc(who)}</span>
        <span class="log-act">${esc(e.action || '')}</span>
        <span class="log-text">${esc(e.text || '')}</span>
      </div>`;
    })
    .join('');
}

function wireGroupFiles(chat) {
  if (!chat) return;
  const add = $('#gAddFile');
  const input = $('#gFileInput');
  const list = $('#gFileList');
  if (!add || !input || !list) return;

  const rerender = () => {
    list.innerHTML = groupFilesHtml(chat.files);
  };
  add.onclick = () => input.click();
  input.onchange = async () => {
    const files = [...(input.files || [])];
    for (const file of files) {
      try {
        const dataUrl = await new Promise((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(r.result);
          r.onerror = reject;
          r.readAsDataURL(file);
        });
        const data = String(dataUrl).split(',')[1] || '';
        const result = await api(`/api/chats/${chat.id}/files`, {
          method: 'POST',
          body: { name: file.name, data },
        });
        chat.files = result.files || chat.files;
      } catch (e) {
        toast(`上传失败：${e.message}`, 'err');
      }
    }
    input.value = '';
    rerender();
  };
  list.onclick = async (e) => {
    const btn = e.target.closest('[data-del-file]');
    if (!btn) return;
    const name = btn.dataset.delFile;
    if (!confirm(`删除群文件「${name}」？`)) return;
    try {
      const result = await api(`/api/chats/${chat.id}/files/${encodeURIComponent(name)}`, {
        method: 'DELETE',
      });
      chat.files = result.files || (chat.files || []).filter((f) => (f.file || f.name) !== name);
      rerender();
    } catch (e) {
      toast(`删除失败：${e.message}`, 'err');
    }
  };
}

function groupForm(chat) {
  const isNew = !chat;
  const leaderId = S.settings?.leaderId;
  const c = chat || { title: '', botIds: [], leadId: null, announcement: '', files: [], log: [] };
  const perm = c.permission || { mode: 'workspace', read: [], write: [] };
  return `
    <h3>${isNew ? '新建群聊' : '群设置'}</h3>
    <div class="field">
      <label>群名</label>
      <input id="gTitle" value="${esc(c.title)}" placeholder="比如 作战室" />
    </div>
    <div class="field">
      <label>群公告（所有成员都会看到）</label>
      <textarea id="gAnnouncement" placeholder="比如：本周目标、注意事项、当前结论">${esc(
        c.announcement || ''
      )}</textarea>
    </div>
    <div class="field">
      <label>成员</label>
      <div class="bot-pick">
        ${S.bots
          .filter((b) => !b.hidden)
          .map((b) => {
            const isLeader = b.id === leaderId;
            const checked = isLeader || c.botIds.includes(b.id);
            return `<label><input type="checkbox" data-bot="${b.id}" ${
              checked ? 'checked' : ''
            } ${isLeader ? 'disabled' : ''} />
              ${
                b.avatar
                  ? `<img class="pick-avatar" src="${esc(b.avatar)}" alt="" loading="lazy" />`
                  : esc(b.emoji)
              } ${esc(botDisplayName(b, c))} <span class="muted">· ${
                isLeader ? '领导（默认在群里）' : esc(b.quota)
              }</span></label>`;
          })
          .join('')}
      </div>
    </div>
    <div class="field">
      <label>默认接单成员（群里不 @ 任何人时只由它回复）</label>
      <select id="gLead">
        <option value="">第一个成员</option>
        ${S.bots
          .filter((b) => c.botIds.includes(b.id) && b.id !== leaderId)
          .map((b) => `<option value="${b.id}"${c.leadId === b.id ? ' selected' : ''}>${esc(botDisplayName(b, c))}</option>`)
          .join('')}
      </select>
    </div>
    <div class="field">
      <label>群权限范围（对本群所有成员生效）</label>
      <select id="gPermMode">
        <option value="workspace"${perm.mode === 'workspace' ? ' selected' : ''}>不额外授权（各自用工人的权限）</option>
        <option value="custom"${perm.mode === 'custom' ? ' selected' : ''}>额外授权目录</option>
        <option value="full"${perm.mode === 'full' ? ' selected' : ''}>完全访问（本机任意目录，谨慎）</option>
      </select>
      <div id="gPermFields" ${perm.mode === 'workspace' ? 'hidden' : ''} style="margin-top:10px">
        <div class="field">
          <label>可读写目录（每行一个）</label>
          <textarea id="gPermWrite" placeholder="/Users/you/shared-project">${esc(
            (perm.write || []).join('\n')
          )}</textarea>
        </div>
        <div class="field">
          <label>只读目录（每行一个）</label>
          <textarea id="gPermRead" placeholder="~/Reference">${esc((perm.read || []).join('\n'))}</textarea>
        </div>
        <div class="field-hint">群授权会和每个成员自己的权限取并集；完全访问会覆盖所有限制。</div>
      </div>
    </div>
    <div class="field">
      <label>这个群的职务班子</label>
      <button type="button" class="btn" id="gRoles" style="font-size:12px;padding:7px 12px">配置群职位</button>
      <div class="field-hint">职位只在这个群里生效；一个群一套班子。</div>
    </div>
    ${
      isNew
        ? `<div class="field"><div class="field-hint">保存群聊后可以添加群文件，群日志会自动记录。</div></div>`
        : `<div class="field">
             <label>群文件（所有成员都能在工作区 group-files/ 里读到）</label>
             <div class="group-files" id="gFileList">${groupFilesHtml(c.files)}</div>
             <div style="margin-top:8px">
               <button type="button" class="btn" id="gAddFile" style="font-size:12px;padding:7px 12px">添加文件</button>
               <input type="file" id="gFileInput" multiple hidden />
             </div>
           </div>
           <div class="field">
             <label>群日志（最近 12 条会注入给所有成员）</label>
             <div class="group-log">${groupLogHtml(c)}</div>
           </div>`
    }
    <div class="modal-actions">
      ${isNew ? '' : '<button class="btn danger" id="gDelete">删除群聊</button>'}
      <button class="btn" id="gCancel">取消</button>
      <button class="btn primary" id="gSave">保存</button>
    </div>`;
}

function wireGroupPerm() {
  const mode = $('#gPermMode');
  const fields = $('#gPermFields');
  if (!mode || !fields) return;
  const sync = () => (fields.hidden = mode.value === 'workspace');
  mode.onchange = sync;
  sync();
}

async function newGroup() {
  openModal(groupForm(null));
  wireGroupPerm();
  $('#gRoles').onclick = () => toast('先保存群聊，再配置这个群的职位');
  $('#gCancel').onclick = closeModal;
  const gSave = $('#gSave');
  gSave.addEventListener(
    'click',
    () => {
      gSave.disabled = true;
      setTimeout(() => (gSave.disabled = false), 1200);
    },
    { capture: true }
  );
  $('#gSave').onclick = async () => {
    const botIds = [...document.querySelectorAll('.bot-pick input:checked')].map((i) => i.dataset.bot);
    const chat = await api('/api/chats', {
      method: 'POST',
      body: {
        type: 'group',
        title: $('#gTitle').value.trim() || '新群聊',
        botIds,
        announcement: $('#gAnnouncement').value,
        permission: readPermissionFields('#gPermMode', '#gPermWrite', '#gPermRead'),
      },
    });
    S.chats = S.chats.filter((c) => c.id !== chat.id);
    S.chats.push(chat);
    closeModal();
    renderSidebar();
    openChat(chat.id);
  };
}

async function editGroup(chat) {
  S.editingChatId = chat.id;
  openModal(groupForm(chat));
  wireGroupPerm();
  wireGroupFiles(chat);
  $('#gRoles').onclick = () => openRoles(chat.id);
  $('#gCancel').onclick = closeModal;
  $('#gSave').onclick = async () => {
    const botIds = [...document.querySelectorAll('.bot-pick input:checked')].map((i) => i.dataset.bot);
    try {
      const updated = await api(`/api/chats/${chat.id}`, {
        method: 'PATCH',
        body: {
          title: $('#gTitle').value.trim(),
          botIds,
          leadId: $('#gLead').value || undefined,
          announcement: $('#gAnnouncement').value,
          permission: readPermissionFields('#gPermMode', '#gPermWrite', '#gPermRead'),
        },
      });
      const idx = S.chats.findIndex((c) => c.id === chat.id);
      if (idx >= 0) S.chats[idx] = { ...S.chats[idx], ...updated };
      closeModal();
      renderSidebar();
      if (S.activeChatId === chat.id) {
        renderThread();
        renderEffort();
        renderModelPill();
      }
    } catch (e) {
      toast(`保存失败：${apiErrorText(e)}`, 'err');
    }
  };
  $('#gDelete').onclick = async () => {
    if (!confirm('删除这个群聊？')) return;
    await api(`/api/chats/${chat.id}`, { method: 'DELETE' });
    clearComposerDraft(chat.id);
    S.activeChatId = null;
    closeModal();
    renderSidebar();
    renderThread();
  };
}


/* ---------------- workflow ---------------- */

const WF_WHEN = {
  always: '总是',
  success: '成功后',
  error: '失败后',
  keyword: '输出包含',
};

function wfStatusLabel(s) {
  return (
    {
      draft: '草稿',
      running: '运行中',
      draining: '收尾中',
      paused: '已暂停',
      done: '已完成',
      stopped: '已停止',
      error: '出错',
    }[s] || '草稿'
  );
}

function wfMembers(chat) {
  return (chat.botIds || []).map((id) => botById(id)).filter(Boolean);
}

function wfModelNames() {
  const set = new Set();
  for (const list of Object.values(S.models || {})) {
    if (!Array.isArray(list)) continue;
    for (const m of list) {
      const id = typeof m === 'string' ? m : m?.id || m?.name;
      if (id) set.add(String(id));
    }
  }
  return [...set].sort();
}

function wfDefault(chat) {
  const first = botById(chat.leadId) || wfMembers(chat)[0];
  const id = `wfn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`;
  return {
    id: '',
    name: `${chat.title} 流程`,
    status: 'draft',
    startNodeId: id,
    maxSteps: 50,
    history: [],
    nodes: [
      {
        id,
        title: '步骤 1',
        botId: first?.id || '',
        model: '',
        task: '',
        stopWhen: '',
        next: [{ to: '__end__', when: 'always', keyword: '' }],
      },
    ],
  };
}

function wfBranchRow(nodes, edge) {
  const to = edge.to || '__end__';
  const when = edge.when || 'always';
  return `<div class="wf-branch" data-wf-branch>
    <select data-wf-when>${Object.entries(WF_WHEN)
      .map(([k, v]) => `<option value="${k}" ${k === when ? 'selected' : ''}>${v}</option>`)
      .join('')}</select>
    <input data-wf-keyword value="${esc(edge.keyword || '')}" placeholder="关键词" ${
      when === 'keyword' ? '' : 'disabled'
    } />
    <span class="wf-branch-arrow">→</span>
    <select data-wf-to>
      <option value="__end__" ${to === '__end__' ? 'selected' : ''}>结束流程</option>
      ${nodes
        .map(
          (n) =>
            `<option value="${n.id}" ${to === n.id ? 'selected' : ''}>${esc(
              n.title || '未命名'
            )}</option>`
        )
        .join('')}
    </select>
    <button type="button" class="wf-icon" data-wf-del-branch title="删除分支">×</button>
  </div>`;
}

function wfNodeCard(chat, node, index, nodes, wf) {
  const members = wfMembers(chat);
  const next =
    Array.isArray(node.next) && node.next.length
      ? node.next
      : [{ to: '__end__', when: 'always', keyword: '' }];
  const running =
    ['running', 'draining'].includes(wf.status) && wf.currentNodeId === node.id;
  const isBranchNode = nodes.some((n) => n.parallel?.targets?.includes(node.id));
  const isMergeNode =
    nodes.reduce(
      (count, n) =>
        count + (n.next || []).filter((e) => e.to === node.id).length,
      0
    ) >= 2;
  return `<div class="wf-node ${running ? 'running' : ''}" data-wf-node data-node-id="${esc(
    node.id
  )}">
    <div class="wf-node-head">
      <span class="wf-node-index">${index + 1}</span>
      ${
        isBranchNode ? '<span class="wf-node-tag branch">并行分支</span>' : ''
      }
      ${isMergeNode ? '<span class="wf-node-tag join">汇合</span>' : ''}
      <input class="wf-node-title" data-wf-title value="${esc(node.title || '')}" placeholder="环节名称" />
      <div class="wf-node-tools">
        <button type="button" data-wf-up title="上移">↑</button>
        <button type="button" data-wf-down title="下移">↓</button>
        <button type="button" data-wf-del title="删除">×</button>
      </div>
    </div>
    <label class="wf-field"><span>执行 Bot</span>
      <select data-wf-bot>${members
        .map(
          (b) =>
            `<option value="${b.id}" ${b.id === node.botId ? 'selected' : ''}>${esc(
              botDisplayName(b, chat)
            )} · ${esc(b.backend)}${b.model ? ` / ${esc(b.model)}` : ''}</option>`
        )
        .join('')}</select>
    </label>
    <label class="wf-field"><span>任务</span>
      <textarea data-wf-task rows="4" placeholder="这个环节具体做什么">${esc(
        node.task || ''
      )}</textarea>
    </label>
    ${
      node.parallel
        ? `<div class="wf-parallel-summary">
            <div class="wf-parallel-head">并行分支</div>
            <div class="wf-parallel-text">${node.parallel.targets
              .map((id) => nodes.find((x) => x.id === id)?.title || '?')
              .join('、')}</div>
            <div class="wf-tip">分支会同时开工；各分支的「下一步」可以继续延伸，多个分支指向同一个步骤时会自动在那里汇合。</div>
            <div class="wf-parallel-actions">
              <button type="button" class="btn ghost wf-parallel-add-branch" data-wf-parallel-add-branch>＋ 添加分支</button>
              <button type="button" class="btn ghost wf-parallel-cancel" data-wf-parallel-cancel>取消并行</button>
            </div>
          </div>`
        : isBranchNode || isMergeNode
          ? ''
          : `<div class="wf-parallel-add">
              <button type="button" class="btn ghost" data-wf-parallel-add>＋ 添加并行分支</button>
              <span class="wf-tip">同时通知多个 Bot 开工；分支可以继续延伸，多个分支指向同一环节时自动汇合</span>
            </div>`
    }
    ${
      node.parallel
        ? ''
        : `<div class="wf-branches">
            <div class="wf-branches-head">下一步</div>
            ${next.map((e) => wfBranchRow(nodes, e)).join('')}
            <button type="button" class="btn ghost wf-add-branch" data-wf-add-branch>＋ 添加分支</button>
          </div>`
    }
    <details class="wf-advanced">
      <summary>高级设置（模型 / 角色 / 停止条件 / 主动结束）</summary>
      <label class="wf-field"><span>模型（可覆盖）</span>
        <input data-wf-model list="wfModels" value="${esc(
          node.model || ''
        )}" placeholder="跟随 Bot 默认" />
      </label>
      <label class="wf-field"><span>环节角色（平滑收尾用）</span>
        <select data-wf-role>
          <option value="normal" ${(node.role || 'normal') === 'normal' ? 'selected' : ''}>普通</option>
          <option value="collector" ${node.role === 'collector' ? 'selected' : ''}>收集 / 生产</option>
          <option value="uploader" ${node.role === 'uploader' ? 'selected' : ''}>上传 / 交付</option>
        </select>
      </label>
      <label class="wf-field"><span>停止条件（输出包含）</span>
        <input data-wf-stop value="${esc(
          node.stopWhen || ''
        )}" placeholder="例如：全部完成" />
      </label>
      <label class="wf-check">
        <input type="checkbox" data-wf-allow-end ${node.allowEnd ? 'checked' : ''} />
        允许本环节用 @@FLOW_END 主动结束整个流程
      </label>
    </details>
</div>`;
}

function wfPreview(chat, wf, nodes) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const depth = new Map();
  const startId = byId.has(wf.startNodeId) ? wf.startNodeId : nodes[0]?.id;
  if (startId) depth.set(startId, 0);
  for (let pass = 0; pass < nodes.length + 2; pass++) {
    let changed = false;
    for (const n of nodes) {
      const d = depth.get(n.id);
      if (d == null) continue;
      const outs = [
        ...(n.next || []).map((e) => e.to),
        ...(n.parallel?.targets || []),
      ];
      for (const to of outs) {
        if (to === '__end__' || !byId.has(to)) continue;
        if (depth.get(to) == null || depth.get(to) < d + 1) {
          depth.set(to, d + 1);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  let maxDepth = 0;
  for (const d of depth.values()) maxDepth = Math.max(maxDepth, d);
  for (const n of nodes) if (depth.get(n.id) == null) depth.set(n.id, maxDepth + 1);

  const columns = [];
  for (const n of nodes) {
    const d = depth.get(n.id) || 0;
    (columns[d] ||= []).push(n);
  }
  const incoming = (id) =>
    nodes.reduce((count, n) => count + (n.next || []).filter((e) => e.to === id).length, 0);

  const colHtml = columns
    .map((list, ci) => {
      const items = (list || [])
        .map((n) => {
          const bot = botById(n.botId);
          const isBranch = nodes.some((p) => p.parallel?.targets?.includes(n.id));
          const isMerge = incoming(n.id) >= 2;
          const running =
            ['running', 'draining'].includes(wf.status) && wf.currentNodeId === n.id;
          return `<div class="wf-graph-node ${running ? 'running' : ''}">
            <div class="wf-graph-title">${esc(n.title || '未命名')}
              ${wf.startNodeId === n.id ? '<i class="wf-start">起点</i>' : ''}
              ${isBranch ? '<i class="wf-node-tag branch">并行</i>' : ''}
              ${isMerge ? '<i class="wf-node-tag join">汇合</i>' : ''}
            </div>
            <div class="wf-graph-bot">${esc(bot?.name || '未指定 Bot')}</div>
            ${
              n.parallel?.targets?.length
                ? `<div class="wf-graph-fork">同时 → ${n.parallel.targets
                    .map((id) => esc(byId.get(id)?.title || '?'))
                    .join('、')}</div>`
                : ''
            }
          </div>`;
        })
        .join('');
      const parallelCol =
        list.length > 1 &&
        list.every((n) => nodes.some((p) => p.parallel?.targets?.includes(n.id)));
      return `<div class="wf-graph-col${parallelCol ? ' parallel-row' : ''}">${items}</div>`;
    })
    .join('<div class="wf-graph-arrow">→</div>');

  return `<div class="wf-preview-head">流程预览 <span>分支从左到右并行</span></div>
    <div class="wf-graph">${colHtml}</div>`;
}


/* ---------------- 流程编辑器 v2：左侧流程，右侧选中步骤 ---------------- */

function wf2Incoming(wf, id) {
  return wf.nodes.reduce(
    (count, n) => count + (n.next || []).filter((e) => e.to === id).length,
    0
  );
}

function wf2Depths(wf) {
  const byId = new Map(wf.nodes.map((n) => [n.id, n]));
  const depth = new Map();
  // 从起点做 BFS：第一次到达就算这一层。
  // 以前按「最长路径」反复松弛，遇到循环会越算越深，左边那排数字才会跑到 30 多。
  const start = byId.has(wf.startNodeId) ? wf.startNodeId : wf.nodes[0]?.id;
  const queue = [];
  if (start) {
    depth.set(start, 0);
    queue.push(start);
  }
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i];
    const node = byId.get(id);
    if (!node) continue;
    const d = depth.get(id) || 0;
    const outs = [
      ...(node.next || []).map((e) => e.to),
      ...(node.parallel?.targets || []),
    ];
    for (const to of outs) {
      if (to === '__end__' || !byId.has(to) || depth.has(to)) continue;
      depth.set(to, d + 1);
      queue.push(to);
    }
  }
  let max = 0;
  for (const d of depth.values()) max = Math.max(max, d);
  for (const n of wf.nodes) if (!depth.has(n.id)) depth.set(n.id, max + 1);
  return { depth, max };
}

function wf2Mode(wf, node) {
  if ((node.parallel?.targets || []).length >= 2) return 'branch';
  if (['next', 'merge', 'loop', 'end'].includes(node.nextMode)) return node.nextMode;
  const edge = (node.next || [])[0];
  if (!edge || edge.to === '__end__') return 'end';
  if (wf2Incoming(wf, edge.to) >= 2) return 'merge';
  const { depth } = wf2Depths(wf);
  const target = wf.nodes.find((n) => n.id === edge.to);
  if (target && (depth.get(target.id) || 0) <= (depth.get(node.id) || 0)) return 'loop';
  return 'next';
}

function wf2NodeIsBranch(wf, node) {
  return wf.nodes.some((n) => n.parallel?.targets?.includes(node.id));
}

const WF2_MODE_META = {
  next: { icon: '→', label: '下一步' },
  merge: { icon: '⇥', label: '汇合到' },
  loop: { icon: '↺', label: '回到' },
  end: { icon: '■', label: '结束' },
  branch: { icon: '⇉', label: '并行' },
};

function wf2ModeInfo(wf, node) {
  const mode = wf2Mode(wf, node);
  const meta = WF2_MODE_META[mode] || WF2_MODE_META.next;
  if (mode === 'end') return { mode, icon: meta.icon, text: '流程到此结束' };
  if (mode === 'branch') {
    const names = (node.parallel?.targets || [])
      .map((id) => wf.nodes.find((n) => n.id === id)?.title)
      .filter(Boolean);
    return {
      mode,
      icon: meta.icon,
      text: names.length ? `同时交给「${names.join('」「')}」` : `同时开始 ${node.parallel?.targets?.length || 2} 个分支`,
    };
  }
  const edge = (node.next || [])[0];
  const target = wf.nodes.find((n) => n.id === edge?.to);
  return { mode, icon: meta.icon, text: `${meta.label}「${target?.title || '?'}」` };
}

function wf2FlowHtml(chat, wf) {
  const { depth } = wf2Depths(wf);
  const stages = [];
  for (const n of wf.nodes) {
    const d = depth.get(n.id) || 0;
    (stages[d] ||= []).push(n);
  }
  const rows = stages.filter(Boolean);
  const startNode = wf.nodes.find((n) => n.id === wf.startNodeId);
  const loopBacks = new Map();
  for (const n of wf.nodes) {
    if (wf2Mode(wf, n) !== 'loop') continue;
    const target = wf.nodes.find((x) => x.id === (n.next || [])[0]?.to);
    if (!target) continue;
    if (!loopBacks.has(target.id)) loopBacks.set(target.id, []);
    loopBacks.get(target.id).push(n.title || '未命名');
  }
  const hasEnd = wf.nodes.some((n) => wf2Mode(wf, n) === 'end');

  const body = rows
    .map((row, ri) => {
      const isParallel = row.length > 1;
      const isStart = startNode && row.includes(startNode);
      const cards = row
        .map((n) => {
          const bot = botById(n.botId);
          const running =
            ['running', 'draining'].includes(wf.status) && wf.currentNodeId === n.id;
          const isBranch = wf2NodeIsBranch(wf, n);
          const isMerge = wf2Incoming(wf, n.id) >= 2;
          const info = wf2ModeInfo(wf, n);
          return `<div class="wf2-node ${running ? 'running' : ''} ${
            S.wfSelected === n.id ? 'selected' : ''
          } ${isBranch ? 'branch' : ''}" data-wf-select="${esc(n.id)}">
            ${isBranch ? `<button class="wf2-del" data-wf-branch-del="${esc(n.id)}" title="删除这个分支">×</button>` : ''}
            <div class="wf2-node-title"><span class="wf2-node-name">${esc(
              n.title || '未命名'
            )}</span>
              ${wf.startNodeId === n.id ? '<i class="wf-node-tag start">起点</i>' : ''}
              ${isMerge ? '<i class="wf-node-tag join">汇合</i>' : ''}
              ${isBranch ? '<i class="wf-node-tag branch">分支</i>' : ''}
              ${running ? '<i class="wf-node-tag live">运行中</i>' : ''}
            </div>
            <div class="wf2-node-bot"><span class="wf2-bot-emoji">${esc(
              bot?.emoji || '🤖'
            )}</span>${esc(bot?.name || '未指定 Bot')}</div>
            <div class="wf2-node-mode is-${info.mode}"><span class="wf2-mode-icon">${
              info.icon
            }</span>${esc(info.text)}</div>
          </div>`;
        })
        .join('');
      return `<section class="wf2-stage ${isParallel ? 'parallel' : ''} ${
        isStart ? 'start' : ''
      }" data-stage="${ri + 1}">
        <div class="wf2-stage-row">${cards}</div>
      </section>`;
    })
    .join('');

  // 循环回到起点时，在末尾再画一张「回到步骤 1」的虚影卡片，
  // 让人一眼看出这是首尾相接的环，而不是一条直线。
  const loops = [...loopBacks.entries()]
    .map(([targetId, fromTitles]) => {
      const target = wf.nodes.find((n) => n.id === targetId);
      if (!target) return '';
      const bot = botById(target.botId);
      return `<section class="wf2-stage loopback">
        <div class="wf2-stage-row">
          <div class="wf2-node ghost" data-wf-select="${esc(target.id)}">
            <div class="wf2-node-title">
              <span class="wf2-node-name">${esc(target.title || '未命名')}</span>
              <i class="wf-node-tag loop">下一轮</i>
            </div>
            <div class="wf2-node-bot"><span class="wf2-bot-emoji">${esc(
              bot?.emoji || '🤖'
            )}</span>${esc(bot?.name || '未指定 Bot')}</div>
            <div class="wf2-node-mode is-loop"><span class="wf2-mode-icon">↺</span>由「${esc(
              fromTitles.join('」「')
            )}」回到这里，进入下一轮</div>
          </div>
        </div>
      </section>`;
    })
    .filter(Boolean)
    .join('');

  const terminals = hasEnd
    ? `<div class="wf2-terminals"><div class="wf2-end-pill"><span>■</span>另有分支在这里结束</div></div>`
    : '';

  return `<div class="wf2-lane">${body}${loops}${terminals}</div>`;
}

function wf2InspectorHtml(chat, wf, node) {
  if (!node) return '<div class="wf2-empty">点左侧步骤开始编辑</div>';
  const mode = wf2Mode(wf, node);
  const members = wfMembers(chat);
  const targets = wf.nodes.filter((n) => n.id !== node.id);
  const edge = (node.next || [])[0] || { to: '__end__' };
  const branchIds = node.parallel?.targets || [];
  const option = (n) =>
    `<option value="${esc(n.id)}">${esc(n.title || '未命名')}</option>`;
  return `<div class="wf2-insp">
    <div class="wf2-insp-head">${esc(node.title || '未命名')}
      ${wf2NodeIsBranch(wf, node) ? '<i class="wf-node-tag branch">并行分支</i>' : ''}
    </div>
    <label class="wf2-field"><span>名称</span>
      <input data-wf2-field="title" value="${esc(node.title || '')}" />
    </label>
    <label class="wf2-field"><span>执行 Bot</span>
      <select data-wf2-field="botId">${members
        .map(
          (b) =>
            `<option value="${esc(b.id)}" ${b.id === node.botId ? 'selected' : ''}>${esc(
              botDisplayName(b, chat)
            )} · ${esc(b.backend)}</option>`
        )
        .join('')}</select>
    </label>
    <div class="wf2-field">
      <div class="wf2-field-head">
        <span>任务</span>
        <button type="button" class="wf2-mention-btn" data-wf-mention-btn title="插入群里任意 Bot 的名字">＋ Bot 名</button>
      </div>
      <div class="wf2-mention-wrap">
        <textarea data-wf2-field="task" rows="5" placeholder="这个环节具体做什么（输入 @ 也能选 Bot）">${esc(
          node.task || ''
        )}</textarea>
      </div>
      <div class="wf2-mention-menu" id="wf2MentionMenu" hidden>
        ${members
          .map(
            (b) =>
              `<button type="button" data-wf-mention="${esc(b.name)}"><span>${esc(
                b.emoji || '🤖'
              )}</span>${esc(b.name)}</button>`
          )
          .join('')}
      </div>
    </div>
    <div class="wf2-field"><span>接下来</span>
      <select data-wf2-mode>
        <option value="next" ${mode === 'next' ? 'selected' : ''}>正常下一步</option>
        <option value="branch" ${mode === 'branch' ? 'selected' : ''}>并行分支</option>
        <option value="merge" ${mode === 'merge' ? 'selected' : ''}>合并到</option>
        <option value="loop" ${mode === 'loop' ? 'selected' : ''}>循环回到</option>
        <option value="end" ${mode === 'end' ? 'selected' : ''}>结束</option>
      </select>
    </div>
    ${
      mode === 'branch'
        ? `<div class="wf2-field"><span>并行分支（每个分支可以继续设置下一步）</span>
            <div class="wf2-branches">
              ${branchIds
                .map((id) => {
                  const b = wf.nodes.find((n) => n.id === id);
                  return `<div class="wf2-branch-row">
                    <span>${esc(b?.title || '?')}</span>
                    <button type="button" data-wf2-del-branch="${esc(id)}">×</button>
                  </div>`;
                })
                .join('')}
            </div>
            <button type="button" class="btn ghost" data-wf2-add-branch>＋ 添加分支</button>
          </div>`
        : mode === 'end'
          ? ''
          : `<label class="wf2-field"><span>${
              mode === 'merge' ? '合并到哪个步骤' : mode === 'loop' ? '回到哪个步骤' : '下一步'
            }</span>
              <select data-wf2-target>
                ${targets
                  .map(
                    (n) =>
                      `<option value="${esc(n.id)}" ${
                        edge.to === n.id ? 'selected' : ''
                      }>${esc(n.title || '未命名')}</option>`
                  )
                  .join('')}
                <option value="__new__">＋ 新建一个步骤</option>
              </select>
            </label>`
    }
    <details class="wf-advanced">
      <summary>高级设置</summary>
      <label class="wf2-field"><span>模型覆盖</span>
        <input data-wf2-field="model" value="${esc(node.model || '')}" placeholder="跟随 Bot 默认" />
      </label>
      <label class="wf2-field"><span>环节角色（平滑收尾用）</span>
        <select data-wf2-field="role">
          <option value="normal" ${(node.role || 'normal') === 'normal' ? 'selected' : ''}>普通</option>
          <option value="collector" ${node.role === 'collector' ? 'selected' : ''}>收集 / 生产</option>
          <option value="uploader" ${node.role === 'uploader' ? 'selected' : ''}>上传 / 交付</option>
        </select>
      </label>
      <label class="wf2-field"><span>停止条件（输出包含）</span>
        <input data-wf2-field="stopWhen" value="${esc(node.stopWhen || '')}" />
      </label>
      <label class="wf-check"><input type="checkbox" data-wf2-field="allowEnd" ${
        node.allowEnd ? 'checked' : ''
      } /> 允许本环节用 @@FLOW_END 结束整个流程</label>
    </details>
  </div>`;
}

function wf2NewNode(wf, botId) {
  return {
    id: `wfn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`,
    title: `步骤 ${wf.nodes.length + 1}`,
    botId,
    model: '',
    task: '',
    stopWhen: '',
    allowEnd: false,
    role: 'normal',
    nextMode: 'end',
    next: [{ to: '__end__', when: 'always', keyword: '' }],
    parallel: null,
  };
}

function wf2Form(chat, wf) {
  const resumable = !!wf.resume?.nodeId && !['running', 'draining'].includes(wf.status);
  const resumeNode = resumable ? wf.nodes.find((n) => n.id === wf.resume.nodeId) : null;
  const resumeStep = Number(wf.resume?.steps) || 0;
  const resumeLabel = resumeNode
    ? `继续流程 · ${resumeNode.title}${resumeStep ? `（第 ${resumeStep + 1} 步）` : ''}`
    : '继续流程';
  return `<div class="wf2">
    <div class="wf2-head">
      <div><h3>群流程图 · ${esc(chat.title)}</h3>
        <div class="wf-sub">${wfStatusLabel(wf.status)} · 第 ${Number(
      wf.round
    ) || 1} 轮 · 左侧流程，点步骤在右侧编辑</div>
      </div>
      <button class="btn ghost" id="wf2Close">关闭</button>
    </div>
    <div class="wf2-setbar">
      <span class="wf2-set-label">流程</span>
      <select id="wf2SetSelect">
        ${(chat.workflows || (chat.workflow ? [chat.workflow] : []))
          .map(
            (w) =>
              `<option value="${esc(w.id)}" ${w.id === wf.id ? 'selected' : ''}>${esc(
                w.name || '未命名流程'
              )}${w.status === 'running' ? ' · 运行中' : w.status === 'draining' ? ' · 收尾中' : ''}</option>`
          )
          .join('')}
      </select>
      <button type="button" class="btn ghost" id="wf2SetNew" title="新建一条流程">＋ 新建</button>
      <button type="button" class="btn ghost" id="wf2SetDup" title="复制当前流程">复制</button>
      <span class="wf2-set-tip">一个群可以存多条流程，但同时只能运行一条</span>
    </div>
    <div class="wf2-toolbar">
      <label class="wf-field"><span>流程名称</span><input id="wf2Name" value="${esc(wf.name || '')}" /></label>
      <label class="wf-field"><span>最多运行轮数</span>
        <div class="wf2-max-row">
          <input id="wf2Max" type="number" min="0" max="100000" value="${
            wf.maxSteps === 0 ? 0 : Number(wf.maxSteps) || 50
          }" ${wf.maxSteps === 0 ? 'disabled' : ''} />
          <label class="wf-check"><input type="checkbox" id="wf2Unlimited" ${
            wf.maxSteps === 0 ? 'checked' : ''
          } /> 不限</label>
        </div>
      </label>
    </div>
    <div class="wf2-body">
      <div class="wf2-flow" id="wf2Flow">${wf2FlowHtml(chat, wf)}</div>
      <aside class="wf2-side" id="wf2Side">${wf2InspectorHtml(chat, wf, wf.nodes.find((n) => n.id === S.wfSelected) || wf.nodes[0])}</aside>
    </div>
    <div class="wf2-actions">
      <button class="btn" id="wf2Save">保存并发布</button>
      ${
        resumable
          ? `<button class="btn primary" id="wf2Resume">${esc(resumeLabel)}</button>
             <button class="btn ghost" id="wf2Run" ${['running','draining'].includes(wf.status) ? 'disabled' : ''}>从头开始</button>`
          : `<button class="btn primary" id="wf2Run" ${['running','draining'].includes(wf.status) ? 'disabled' : ''}>运行流程</button>`
      }
      ${
        ['running', 'draining'].includes(wf.status)
          ? '<button class="btn ghost" id="wf2Pause">暂停</button>'
          : ''
      }
      ${wf.status === 'running' ? '<button class="btn danger" id="wf2Stop">强制停止</button>' : ''}
      <div class="wf2-export" id="wf2ExportWrap">
        <button class="btn ghost" id="wf2Export" title="导出流程图">导出 ▾</button>
        <div class="wf2-export-menu" id="wf2ExportMenu" hidden>
          <button type="button" data-wf-export="html">HTML 网页</button>
          <button type="button" data-wf-export="png">PNG 图片</button>
          <button type="button" data-wf-export="pdf">PDF 文档</button>
        </div>
      </div>
      <button class="btn danger ghost" id="wf2Delete">删除流程</button>
    </div>
  </div>`;
}

function renderWf2(chat) {
  S.wfChatId = chat.id;
  // 流程运行中时轮询当前环节，保证左侧高亮跟着实际进度走
  clearInterval(S.wfPoll);
  S.wfPoll = setInterval(async () => {
    if (!S.wfChatId || $('#modalMask').hidden || !document.querySelector('.wf2')) return;
    try {
      const r = await api(`/api/chats/${S.wfChatId}/workflows`);
      if (r.activeId && S.wfDraft && S.wfDraft.id && r.activeId !== S.wfDraft.id) return;
      const active = (r.workflows || []).find((w) => w.id === r.activeId);
      if (!active || !S.wfDraft) return;
      const prev = `${S.wfDraft.status}:${S.wfDraft.currentNodeId || ''}`;
      const next = `${active.status}:${active.currentNodeId || ''}`;
      if (prev === next) return;
      S.wfDraft.status = active.status;
      S.wfDraft.currentNodeId = active.currentNodeId || null;
      const flow = $('#wf2Flow');
      const fresh = chatById(S.wfChatId);
      if (flow && fresh) flow.innerHTML = wf2FlowHtml(fresh, S.wfDraft);
    } catch {}
  }, 2000);
  if (!S.wfSelected || !S.wfDraft?.nodes?.some((n) => n.id === S.wfSelected)) {
    S.wfSelected = S.wfDraft?.startNodeId || S.wfDraft?.nodes?.[0]?.id || null;
  }
  openModal(wf2Form(chat, S.wfDraft), 'wide');
  wireWf2(chat);
}

function wireWf2(chat) {
  const refreshAll = () => {
    const flow = $('#wf2Flow');
    const side = $('#wf2Side');
    if (flow) flow.innerHTML = wf2FlowHtml(chat, S.wfDraft);
    const node = S.wfDraft.nodes.find((n) => n.id === S.wfSelected);
    if (side) side.innerHTML = wf2InspectorHtml(chat, S.wfDraft, node);
  };
  const node = () => S.wfDraft.nodes.find((n) => n.id === S.wfSelected);

  $('#wf2Close').onclick = closeModal;

  const reloadWorkflowEditor = async () => {
    const fresh = await api('/api/bootstrap');
    S.bots = fresh.bots || S.bots;
    S.chats = fresh.chats || S.chats;
    S.settings = fresh.settings || S.settings;
    const c = chatById(chat.id);
    if (c) openWorkflow(c);
  };
  const setSelect = $('#wf2SetSelect');
  if (setSelect)
    setSelect.onchange = async () => {
      const id = setSelect.value;
      if (id === chat.workflow?.id) return;
      try {
        await api(`/api/chats/${chat.id}/workflows`, {
          method: 'POST',
          body: { action: 'switch', id },
        });
        await reloadWorkflowEditor();
        toast('已切换流程');
      } catch (e) {
        setSelect.value = chat.workflow?.id || '';
        toast(`切换失败：${apiErrorText(e)}`, 'err');
      }
    };
  if ($('#wf2SetNew'))
    $('#wf2SetNew').onclick = async () => {
      try {
        await api(`/api/chats/${chat.id}/workflows`, {
          method: 'POST',
          body: { action: 'create' },
        });
        await reloadWorkflowEditor();
        toast('已新建流程');
      } catch (e) {
        toast(`新建失败：${apiErrorText(e)}`, 'err');
      }
    };
  if ($('#wf2SetDup'))
    $('#wf2SetDup').onclick = async () => {
      try {
        await api(`/api/chats/${chat.id}/workflows`, {
          method: 'POST',
          body: { action: 'duplicate', id: chat.workflow?.id },
        });
        await reloadWorkflowEditor();
        toast('已复制流程');
      } catch (e) {
        toast(`复制失败：${apiErrorText(e)}`, 'err');
      }
    };
  const maxInput = $('#wf2Max');
  const unlimited = $('#wf2Unlimited');
  if (maxInput && unlimited) {
    unlimited.onchange = () => {
      maxInput.disabled = unlimited.checked;
      if (unlimited.checked) maxInput.value = '0';
      else if (!Number(maxInput.value)) maxInput.value = '50';
    };
  }
  $('#wf2Flow').onclick = (e) => {
    const del = e.target.closest('[data-wf-branch-del]');
    if (del) {
      e.stopPropagation();
      const id = del.dataset.wfBranchDel;
      for (const n of S.wfDraft.nodes) {
        if (!n.parallel) continue;
        n.parallel.targets = n.parallel.targets.filter((x) => x !== id);
        if (n.parallel.targets.length < 2) n.parallel = null;
      }
      S.wfDraft.nodes = S.wfDraft.nodes.filter((n) => n.id !== id);
      if (S.wfSelected === id) S.wfSelected = S.wfDraft.startNodeId;
      refreshAll();
      return;
    }
    const sel = e.target.closest('[data-wf-select]');
    if (sel) {
      S.wfSelected = sel.dataset.wfSelect;
      refreshAll();
    }
  };

  const taskArea = () => $('#wf2Side [data-wf2-field="task"]');
  const mentionMenu = () => $('#wf2MentionMenu');
  let mentionAt = -1; // 用 @ 触发时记录 @ 的位置，选中后把它替换掉

  const closeMentionMenu = () => {
    const menu = mentionMenu();
    if (menu) menu.hidden = true;
    mentionAt = -1;
  };
  const insertIntoTask = (text) => {
    const area = taskArea();
    if (!area) return;
    const start = mentionAt >= 0 ? mentionAt : area.selectionStart ?? area.value.length;
    const end = mentionAt >= 0 ? area.selectionStart ?? start : area.selectionEnd ?? start;
    const before = area.value.slice(0, start);
    const after = area.value.slice(end);
    const lead = before && !/\s$/.test(before) ? ' ' : '';
    const tail = after && !/^\s/.test(after) ? ' ' : '';
    area.value = before + lead + text + tail + after;
    const pos = before.length + lead.length + text.length;
    area.setSelectionRange(pos, pos);
    area.focus();
    area.dispatchEvent(new Event('input', { bubbles: true }));
    closeMentionMenu();
  };
  const filterMentions = (q) => {
    const menu = mentionMenu();
    if (!menu) return;
    const key = String(q || '').toLowerCase();
    let shown = 0;
    for (const item of menu.querySelectorAll('[data-wf-mention]')) {
      const hit = !key || item.dataset.wfMention.toLowerCase().includes(key);
      item.hidden = !hit;
      if (hit) shown += 1;
    }
    menu.hidden = shown === 0;
  };

  $('#wf2Side').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-wf-mention-btn]');
    if (btn) {
      const menu = mentionMenu();
      if (menu) {
        const willOpen = menu.hidden;
        mentionAt = -1;
        filterMentions('');
        menu.hidden = !willOpen;
      }
      return;
    }
    const item = e.target.closest('[data-wf-mention]');
    if (item) {
      e.preventDefault();
      insertIntoTask(item.dataset.wfMention);
      return;
    }
    closeMentionMenu();
  });

  $('#wf2Side').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeMentionMenu();
  });

  $('#wf2Side').addEventListener('input', (e) => {
    const field = e.target.dataset.wf2Field;
    if (!field) return;
    const n = node();
    if (!n) return;
    if (field === 'allowEnd') n.allowEnd = e.target.checked;
    else n[field] = e.target.value;
    if (field === 'task') {
      const picked = e.target.value.slice(0, e.target.selectionStart).match(/@([^\s@]{0,24})$/);
      if (picked) {
        mentionAt = e.target.selectionStart - picked[1].length - 1;
        filterMentions(picked[1]);
      } else {
        closeMentionMenu();
      }
    }
    const flow = $('#wf2Flow');
    if (flow) flow.innerHTML = wf2FlowHtml(chat, S.wfDraft);
  });
  $('#wf2Side').addEventListener('change', async (e) => {
    const field = e.target.dataset.wf2Field;
    const n = node();
    if (!n) return;
    if (field) {
      if (field === 'allowEnd') n.allowEnd = e.target.checked;
      else n[field] = e.target.value;
      if (field === 'botId') refreshAll();
      return;
    }
    if (e.target.matches('[data-wf2-mode]')) {
      const mode = e.target.value;
      const oldTargets = n.parallel?.targets || [];
      if (mode !== 'branch' && oldTargets.length) {
        S.wfDraft.nodes = S.wfDraft.nodes.filter((x) => !oldTargets.includes(x.id));
      }
      n.nextMode = mode;
      if (mode === 'next') {
        n.parallel = null;
        let targetId = (n.next || [])[0]?.to || '';
        const valid =
          targetId &&
          targetId !== '__end__' &&
          S.wfDraft.nodes.some((x) => x.id === targetId && x.id !== n.id);
        if (!valid) {
          const other = S.wfDraft.nodes.find((x) => x.id !== n.id);
          if (other) targetId = other.id;
          else {
            const step = wf2NewNode(S.wfDraft, n.botId);
            S.wfDraft.nodes.push(step);
            targetId = step.id;
            S.wfSelected = step.id;
          }
        }
        n.next = [{ to: targetId, when: 'always', keyword: '' }];
        refreshAll();
        return;
      }
      if (mode === 'branch') {
        if (!(n.parallel?.targets || []).length) {
          const make = (i) => ({
            id: `wfn_${Date.now().toString(36)}_${i}_${Math.random().toString(36).slice(2, 4)}`,
            title: `并行分支 ${i + 1}`,
            botId: n.botId,
            model: '',
            task: '',
            stopWhen: '',
            allowEnd: false,
            role: 'collector',
            next: [{ to: '__end__', when: 'always', keyword: '' }],
            parallel: null,
          });
          const b1 = make(0);
          const b2 = make(1);
          n.parallel = { targets: [b1.id, b2.id] };
          S.wfDraft.nodes.push(b1, b2);
        }
        n.next = [{ to: '__end__', when: 'always', keyword: '' }];
      } else if (mode === 'end') {
        n.parallel = null;
        n.next = [{ to: '__end__', when: 'always', keyword: '' }];
      } else {
        n.parallel = null;
        const target = (S.wfDraft.nodes.find((x) => x.id !== n.id) || {}).id || '__end__';
        n.next = [{ to: target, when: 'always', keyword: '' }];
      }
      refreshAll();
      return;
    }
    if (e.target.matches('[data-wf2-target]')) {
      n.parallel = null;
      if (e.target.value === '__new__') {
        const step = wf2NewNode(S.wfDraft, n.botId);
        S.wfDraft.nodes.push(step);
        n.next = [{ to: step.id, when: 'always', keyword: '' }];
        S.wfSelected = step.id;
      } else {
        n.next = [{ to: e.target.value, when: 'always', keyword: '' }];
      }
      refreshAll();
    }
  });
  $('#wf2Side').addEventListener('click', (e) => {
    const n = node();
    if (!n) return;
    if (e.target.closest('[data-wf2-add-branch]')) {
      const id = `wfn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`;
      const branch = {
        id,
        title: `并行分支 ${(n.parallel?.targets || []).length + 1}`,
        botId: n.botId,
        model: '',
        task: '',
        stopWhen: '',
        allowEnd: false,
        role: 'collector',
        next: [{ to: '__end__', when: 'always', keyword: '' }],
        parallel: null,
      };
      n.parallel ||= { targets: [] };
      n.parallel.targets.push(id);
      S.wfDraft.nodes.push(branch);
      refreshAll();
      return;
    }
    const del = e.target.closest('[data-wf2-del-branch]');
    if (del) {
      const id = del.dataset.wf2DelBranch;
      n.parallel.targets = n.parallel.targets.filter((x) => x !== id);
      if (n.parallel.targets.length < 2) n.parallel = null;
      S.wfDraft.nodes = S.wfDraft.nodes.filter((x) => x.id !== id);
      refreshAll();
    }
  });

  $('#wf2Save').onclick = async () => {
    try {
      S.wfDraft.name = $('#wf2Name').value.trim() || S.wfDraft.name;
      S.wfDraft.maxSteps = $('#wf2Unlimited').checked
        ? 0
        : Number($('#wf2Max').value) || 50;
      const saved = await api(`/api/chats/${chat.id}`, {
        method: 'PATCH',
        body: { workflow: validateWorkflow(S.wfDraft) },
      });
      S.wfDraft = saved.workflow;
      const live = ['running', 'draining'].includes(saved.workflow?.status);
      toast(
        live
          ? '已保存：还没跑到的步骤会按新内容执行，已跑过的从下一轮生效'
          : '流程已保存'
      );
      closeModal();
    } catch (e) {
      toast(`保存失败：${apiErrorText(e)}`, 'err');
    }
  };
  if ($('#wf2Resume'))
    $('#wf2Resume').onclick = async () => {
      try {
        S.wfDraft.name = $('#wf2Name').value.trim() || S.wfDraft.name;
        S.wfDraft.maxSteps = $('#wf2Unlimited').checked
          ? 0
          : Number($('#wf2Max').value) || 50;
        await api(`/api/chats/${chat.id}`, {
          method: 'PATCH',
          body: { workflow: validateWorkflow(S.wfDraft) },
        });
        const r = await api(`/api/chats/${chat.id}/workflow`, {
          method: 'POST',
          body: { action: 'resume' },
        });
        toast(r.from ? `已从「${r.from}」接着跑` : '已继续流程');
        closeModal();
      } catch (e) {
        toast(`继续失败：${apiErrorText(e)}`, 'err');
      }
    };
  $('#wf2Run').onclick = async () => {
    try {
      S.wfDraft.name = $('#wf2Name').value.trim() || S.wfDraft.name;
      S.wfDraft.maxSteps = $('#wf2Unlimited').checked
        ? 0
        : Number($('#wf2Max').value) || 50;
      await api(`/api/chats/${chat.id}`, {
        method: 'PATCH',
        body: { workflow: validateWorkflow(S.wfDraft) },
      });
      await api(`/api/chats/${chat.id}/workflow`, { method: 'POST', body: { action: 'run' } });
      toast('流程已启动');
      closeModal();
    } catch (e) {
      toast(`启动失败：${apiErrorText(e)}`, 'err');
    }
  };
  if ($('#wf2Pause'))
    $('#wf2Pause').onclick = async () => {
      try {
        await api(`/api/chats/${chat.id}/workflow`, {
          method: 'POST',
          body: { action: 'pause' },
        });
        toast('已请求暂停：当前环节做完就停，进度保留');
        closeModal();
      } catch (e) {
        toast(`暂停失败：${apiErrorText(e)}`, 'err');
      }
    };
  if ($('#wf2Stop'))
    $('#wf2Stop').onclick = async () => {
      try {
        await api(`/api/chats/${chat.id}/workflow`, { method: 'POST', body: { action: 'stop' } });
        toast('已强制停止流程');
        closeModal();
      } catch (e) {
        toast(`停止失败：${apiErrorText(e)}`, 'err');
      }
    };
  const exportMenu = $('#wf2ExportMenu');
  $('#wf2Export').onclick = (e) => {
    e.stopPropagation();
    if (exportMenu) exportMenu.hidden = !exportMenu.hidden;
  };
  if (exportMenu) {
    exportMenu.onclick = async (e) => {
      const item = e.target.closest('[data-wf-export]');
      if (!item) return;
      exportMenu.hidden = true;
      const kind = item.dataset.wfExport;
      try {
        S.wfDraft.name = $('#wf2Name').value.trim() || S.wfDraft.name;
        S.wfDraft.maxSteps = $('#wf2Unlimited').checked
          ? 0
          : Number($('#wf2Max').value) || 50;
        const wf = validateWorkflow(S.wfDraft);
        toast(kind === 'html' ? '正在导出 HTML…' : kind === 'png' ? '正在生成 PNG…' : '正在生成 PDF…');
        const r = await exportWorkflowAs(chat, wf, kind);
        toast(`已导出：${r.path}`);
        api('/api/files/reveal', { method: 'POST', body: { path: r.path } }).catch(() => {});
      } catch (err) {
        toast(`导出失败：${apiErrorText(err)}`, 'err');
      }
    };
  }
  $('#wf2Delete').onclick = async () => {
    if (!confirm('删除这个群的流程图？')) return;
    await api(`/api/chats/${chat.id}`, { method: 'PATCH', body: { workflow: null } });
    closeModal();
  };
}

function wfForm(chat, wf) {
  const nodes = wf.nodes?.length ? wf.nodes : wfDefault(chat).nodes;
  const start = nodes.some((n) => n.id === wf.startNodeId) ? wf.startNodeId : nodes[0].id;
  return `<div class="wf">
    <div class="wf-head">
      <div><h3>群流程图 · ${esc(chat.title)}</h3>
        <div class="wf-sub">${wfStatusLabel(wf.status)} · ${nodes.length} 个环节</div>
        <div class="wf-hint">环节正常返回内容即视为完成，然后按「下一步」条件进入下一环节。下一步可以选择之前的步骤形成循环；循环由「停止条件」、勾选允许的 @@FLOW_END 或「最多步数」结束。交接时上一个 Bot 会自动 @ 下一个 Bot。环节可以标为「收集/生产」或「上传/交付」；循环运行时点「平滑收尾」（或让领导 Bot 执行 workflow-drain），会先让当前环节做完，再把所有未上传结果交给上传环节，完成后自动结束。</div>
      </div>
      <button class="btn ghost" id="wfCancel">关闭</button>
    </div>
    <div class="wf-toolbar">
      <label class="wf-field"><span>流程名称</span>
        <input id="wfName" value="${esc(wf.name || '')}" />
      </label>
      <label class="wf-field"><span>开始环节</span>
        <select id="wfStart">${nodes
          .map(
            (n) =>
              `<option value="${n.id}" ${n.id === start ? 'selected' : ''}>${esc(
                n.title || '未命名'
              )}</option>`
          )
          .join('')}</select>
      </label>
      <label class="wf-field"><span>最多步数</span>
        <input id="wfMaxSteps" type="number" min="1" max="200" value="${Number(wf.maxSteps) || 50}" />
      </label>
    </div>
    <div class="wf-layout">
      <div class="wf-editor" id="wfEditor">
        ${nodes.map((n, i) => wfNodeCard(chat, n, i, nodes, wf)).join('')}
        <button type="button" class="btn ghost" id="wfAddNode">＋ 添加步骤</button>
      </div>
      <aside class="wf-preview">${wfPreview(chat, wf, nodes)}</aside>
    </div>
    <div class="wf-leader">
      <div class="wf-leader-title">让领导 Bot 设计并发布</div>
      <textarea id="wfLeaderPrompt" rows="2" placeholder="描述你想要的目标、顺序或条件，例如：先让 Antigravity 收集 10 个项目，交给 DeepSeek 上传，成功后再让 Codex 出 10 张图，全部完成就停止。"></textarea>
      <div class="wf-leader-actions">
        <button class="btn ghost" id="wfLeader">发给知柚设计</button>
        <span class="wf-hint">它会读取群成员和职位，设计好后保存到这个群</span>
      </div>
    </div>
    <div class="wf-actions">
      <button class="btn" id="wfSave">保存并发布</button>
      <button class="btn primary" id="wfRun" ${
        wf.status === 'running' || wf.status === 'draining' ? 'disabled' : ''
      }>运行流程</button>
      ${
        wf.status === 'running'
          ? '<button class="btn" id="wfDrain">平滑收尾</button>'
          : wf.status === 'draining'
            ? '<button class="btn" disabled>收尾中…</button>'
            : ''
      }
      ${
        wf.status === 'running'
          ? '<button class="btn danger" id="wfStop">强制停止</button>'
          : ''
      }
      <button class="btn danger ghost" id="wfDelete">删除流程</button>
      <span class="wf-hint">运行流程会自动停止该群的持续运行</span>
    </div>
    <datalist id="wfModels">${wfModelNames()
      .map((m) => `<option value="${esc(m)}"></option>`)
      .join('')}</datalist>
  </div>`;
}

function collectWorkflowDraft(chat) {
  const nodes = [...document.querySelectorAll('#wfEditor [data-wf-node]')].map((el, i) => {
    const branches = [...el.querySelectorAll('[data-wf-branch]')].map((row) => ({
      to: row.querySelector('[data-wf-to]').value,
      when: row.querySelector('[data-wf-when]').value,
      keyword: row.querySelector('[data-wf-keyword]').value.trim(),
    }));
    return {
      id: el.dataset.nodeId,
      title: el.querySelector('[data-wf-title]').value.trim() || `步骤 ${i + 1}`,
      botId: el.querySelector('[data-wf-bot]').value,
      model: el.querySelector('[data-wf-model]').value.trim(),
      task: el.querySelector('[data-wf-task]').value.trim(),
      stopWhen: el.querySelector('[data-wf-stop]').value.trim(),
      allowEnd: !!el.querySelector('[data-wf-allow-end]')?.checked,
      role: el.querySelector('[data-wf-role]')?.value || 'normal',
      parallel:
        S.wfDraft?.nodes?.find((n) => n.id === el.dataset.nodeId)?.parallel || null,
      next: branches.length ? branches : [{ to: '__end__', when: 'always', keyword: '' }],
    };
  });
  const base = S.wfDraft || {};
  return {
    ...base,
    name: ($('#wfName')?.value || '').trim() || '群流程',
    startNodeId: $('#wfStart')?.value || nodes[0]?.id,
    maxSteps: Number($('#wfMaxSteps')?.value) || 50,
    nodes,
  };
}

function validateWorkflow(wf) {
  if (!wf.nodes.length) throw new Error('至少需要一个环节');
  if (!wf.nodes.some((n) => n.id === wf.startNodeId)) wf.startNodeId = wf.nodes[0].id;
  // 清理已经从流程里断开的孤立步骤
  const byId = new Map(wf.nodes.map((n) => [n.id, n]));
  const reachable = new Set();
  const queue = [wf.startNodeId];
  while (queue.length) {
    const id = queue.shift();
    if (!id || reachable.has(id) || !byId.has(id)) continue;
    reachable.add(id);
    const n = byId.get(id);
    for (const e of n.next || []) if (e.to && e.to !== '__end__') queue.push(e.to);
    for (const t of n.parallel?.targets || []) queue.push(t);
  }
  wf.nodes = wf.nodes.filter((n) => reachable.has(n.id));
  for (const n of wf.nodes) {
    if (!n.botId) throw new Error(`「${n.title}」没有选择执行 Bot`);
    if (!n.task) throw new Error(`「${n.title}」没有填写任务`);
  }
  return wf;
}

function renderWorkflowModal(chat) {
  S.wfChatId = chat.id;
  openModal(wfForm(chat, S.wfDraft), 'wide');
  wireWorkflowModal(chat);
}

/* ---------------- 领导 Bot：平滑结束（收尾） ---------------- */

function runningWorkflowChats() {
  return (S.chats || [])
    .filter(
      (c) => c.type === 'group' && c.workflow && ['running', 'draining'].includes(c.workflow.status)
    )
    .sort((a, b) => (b.workflow.startedAt || 0) - (a.workflow.startedAt || 0));
}

function wfElapsed(ts) {
  if (!ts) return '';
  const mins = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (mins < 1) return '刚开始';
  if (mins < 60) return `已跑 ${mins} 分钟`;
  return `已跑 ${Math.floor(mins / 60)} 小时 ${mins % 60} 分`;
}

/* ---------------- 领导 Bot：定位到群聊 / Bot / 项目 ---------------- */

function targetItems() {
  const groups = (S.chats || [])
    .filter((c) => c.type === 'group')
    .map((c) => ({
      id: c.id,
      title: c.title,
      members: (c.botIds || []).length,
      liveStatus: c.workflow?.status || '',
      hasWorkflow: !!(c.workflow?.nodes || []).length,
      resumable:
        !!c.workflow?.resume?.nodeId &&
        !['running', 'draining'].includes(c.workflow?.status || ''),
    }));
  const bots = (S.bots || []).map((b) => ({
    id: b.id,
    name: b.name,
    icon: b.emoji || '🤖',
    sub: `${b.backend}${b.model ? ` · ${b.model}` : ''}`,
  }));
  const projectsByBot = new Map();
  for (const c of (S.chats || []).filter((x) => x.type === 'dm')) {
    const botId = c.botIds?.[0];
    if (!botId) continue;
    if (!projectsByBot.has(botId)) projectsByBot.set(botId, []);
    projectsByBot.get(botId).push({ id: c.id, title: c.project || '默认项目' });
  }
  return { groups, bots, projectsByBot };
}

function targetRefLine(t) {
  if (!t) return '';
  if (t.kind === 'project' && t.projects?.length) {
    const items = t.projects
      .slice(0, 8)
      .map((p) => `「${p.title}」(${p.id})`)
      .join('、');
    const more = t.projects.length > 8 ? ` 等 ${t.projects.length} 个` : '';
    return `【定位】项目 · ${t.projects[0].botName}：${items}${more}`;
  }
  return `【定位】${t.label}「${t.title}」 · ${t.ref}`;
}

function renderTargetChip() {
  const row = $('#targetChipRow');
  if (!row) return;
  const t = S.target;
  row.hidden = !t;
  row.innerHTML = t
    ? `<span class="target-chip">
        <span class="tc-icon">${t.icon}</span>
        <span class="tc-label">${esc(t.label)} · ${esc(t.title)}</span>
        ${t.kind === 'project' ? '' : `<span class="tc-ref">${esc(t.ref)}</span>`}
        <button type="button" id="targetClear" title="取消定位">×</button>
      </span>`
    : '';
  const clear = $('#targetClear');
  if (clear)
    clear.onclick = () => {
      S.target = null;
      renderTargetChip();
    };
}

function openTargetPicker() {
  const { groups, bots, projectsByBot } = targetItems();
  let projBotId = null;
  let query = '';
  const picked = new Set();

  const applyTarget = (t) => {
    S.target = t;
    renderTargetChip();
    closeModal();
    toast(`已定位：${t.label} · ${t.title}`);
  };

  const liveText = (s) => (s === 'draining' ? '流程收尾中' : s === 'running' ? '流程运行中' : '');

  const mainHtml = () => `
    <div class="target-section" data-section="group">
      <div class="target-section-head">群聊<span>${groups.length}</span></div>
      ${groups
        .map((g) => {
          const live = ['running', 'draining'].includes(g.liveStatus);
          return `<div class="target-row" data-target-group="${esc(g.id)}">
            <span class="tr-icon">👥</span>
            <span class="tr-main">
              <span class="tr-title">${esc(g.title)}</span>
              <span class="tr-sub">群聊 · ${g.members} 位成员${
                live ? ` · ${liveText(g.liveStatus)}` : ''
              }</span>
            </span>
            <span class="tr-actions">
              ${
                g.hasWorkflow
                  ? `<button type="button" class="tr-act" data-wf-run="${esc(g.id)}">${
                      live ? '重启流程' : '启动流程'
                    }</button>`
                  : ''
              }
              ${
                !live && g.resumable
                  ? `<button type="button" class="tr-act" data-wf-resume="${esc(g.id)}">继续</button>`
                  : ''
              }
              ${
                live
                  ? `<button type="button" class="tr-act" data-wf-pause="${esc(g.id)}">暂停</button>
                     <button type="button" class="tr-act" data-wf-drain="${esc(g.id)}">收尾</button>
                     <button type="button" class="tr-act danger" data-wf-halt="${esc(g.id)}">停止</button>`
                  : ''
              }
            </span>
          </div>`;
        })
        .join('')}
    </div>
    <div class="target-section" data-section="bot">
      <div class="target-section-head">Bot<span>${bots.length}</span></div>
      ${bots
        .map(
          (b) => `<div class="target-row" data-target-bot="${esc(b.id)}">
            <span class="tr-icon">${esc(b.icon)}</span>
            <span class="tr-main">
              <span class="tr-title">${esc(b.name)}</span>
              <span class="tr-sub">Bot · ${esc(b.sub)}</span>
            </span>
            <span class="tr-ref">${esc(b.id)}</span>
          </div>`
        )
        .join('')}
    </div>
    <div class="target-section" data-section="project">
      <div class="target-section-head">项目<span>${[...projectsByBot.values()].reduce(
        (n, a) => n + a.length,
        0
      )}</span></div>
      ${bots
        .filter((b) => projectsByBot.has(b.id))
        .map(
          (b) => `<div class="target-row" data-proj-bot="${esc(b.id)}">
            <span class="tr-icon">${esc(b.icon)}</span>
            <span class="tr-main">
              <span class="tr-title">${esc(b.name)}</span>
              <span class="tr-sub">${projectsByBot.get(b.id).length} 个项目 · 点击选择</span>
            </span>
            <span class="tr-go">选择 →</span>
          </div>`
        )
        .join('')}
    </div>`;

  const projectHtml = () => {
    const bot = bots.find((b) => b.id === projBotId);
    const list = projectsByBot.get(projBotId) || [];
    const allChecked = list.length > 0 && list.every((p) => picked.has(p.id));
    return `<div class="target-sub">
      <div class="target-sub-head">
        <button type="button" class="target-back" data-target-back>← 返回</button>
        <span>${esc(bot?.name || 'Bot')} 的项目</span>
        <span class="target-sub-count">已选 ${picked.size} / ${list.length}</span>
      </div>
      <label class="target-check is-all">
        <input type="checkbox" data-proj-all ${allChecked ? 'checked' : ''} />
        <span>全部项目</span>
      </label>
      ${list
        .map(
          (p) => `<label class="target-check">
            <input type="checkbox" data-proj="${esc(p.id)}" ${
              picked.has(p.id) ? 'checked' : ''
            } />
            <span class="tc-name">${esc(p.title)}</span>
            <em>${esc(p.id)}</em>
          </label>`
        )
        .join('')}
      <div class="target-foot">
        <button type="button" class="btn primary" data-proj-apply ${
          picked.size ? '' : 'disabled'
        }>定位 ${picked.size || ''} 个项目</button>
      </div>
    </div>`;
  };

  const filter = () => {
    const q = query.trim().toLowerCase();
    for (const row of document.querySelectorAll('#targetBody .target-row, #targetBody .target-check')) {
      const hit = !q || row.textContent.toLowerCase().includes(q);
      row.hidden = !hit;
    }
    for (const sec of document.querySelectorAll('#targetBody .target-section')) {
      const any = [...sec.querySelectorAll('.target-row')].some((r) => !r.hidden);
      sec.hidden = !any;
    }
  };

  const render = () => {
    const body = $('#targetBody');
    if (!body) return;
    body.innerHTML = projBotId ? projectHtml() : mainHtml();
    filter();
    if (projBotId) {
      const back = body.querySelector('[data-target-back]');
      if (back) back.onclick = () => {
        projBotId = null;
        picked.clear();
        render();
      };
    }
  };

  openModal(
    `<div class="target-pick">
      <div class="drain-head">
        <div>
          <h3>定位到…</h3>
          <div class="wf-sub">选群聊、Bot，或点开某个 Bot 选它的一个 / 几个 / 全部项目。之后发的任务会自动带上名字和 ID。</div>
        </div>
        <button class="btn ghost" id="targetClose">关闭</button>
      </div>
      <input class="target-search" id="targetSearch" placeholder="搜索群聊、Bot、项目…" autocomplete="off" />
      <div class="target-list" id="targetBody"></div>
    </div>`,
    'wide'
  );

  $('#targetClose').onclick = closeModal;
  render();

  const search = $('#targetSearch');
  if (search) {
    search.focus();
    search.oninput = () => {
      query = search.value || '';
      filter();
    };
  }

  $('#targetBody').onclick = async (e) => {
    const act = e.target.closest(
      '[data-wf-run],[data-wf-resume],[data-wf-drain],[data-wf-halt],[data-wf-pause]'
    );
    if (act) {
      e.stopPropagation();
      const id =
        act.dataset.wfRun ||
        act.dataset.wfResume ||
        act.dataset.wfDrain ||
        act.dataset.wfHalt ||
        act.dataset.wfPause;
      const action = act.dataset.wfRun
        ? 'run'
        : act.dataset.wfResume
          ? 'resume'
          : act.dataset.wfDrain
            ? 'drain'
            : act.dataset.wfPause
              ? 'pause'
              : 'stop';
      try {
        await api(`/api/chats/${id}/workflow`, {
          method: 'POST',
          body: { action, reason: '老板在定位面板里操作' },
        });
        toast(
          action === 'run'
            ? '流程已启动'
            : action === 'resume'
              ? '已从断点继续'
              : action === 'drain'
                ? '已请求平滑收尾'
                : action === 'pause'
                  ? '已请求暂停：当前环节做完就停'
                  : '已停止流程'
        );
        closeModal();
        renderSidebar();
        renderThread();
      } catch (err) {
        toast(`操作失败：${err.message}`, 'err');
      }
      return;
    }
    const group = e.target.closest('[data-target-group]');
    if (group) {
      const g = groups.find((x) => x.id === group.dataset.targetGroup);
      if (g) applyTarget({ kind: 'group', icon: '👥', label: '群聊', title: g.title, ref: g.id });
      return;
    }
    const botRow = e.target.closest('[data-target-bot]');
    if (botRow) {
      const b = bots.find((x) => x.id === botRow.dataset.targetBot);
      if (b) applyTarget({ kind: 'bot', icon: '🤖', label: 'Bot', title: b.name, ref: b.id });
      return;
    }
    const projBot = e.target.closest('[data-proj-bot]');
    if (projBot) {
      projBotId = projBot.dataset.projBot;
      picked.clear();
      query = '';
      if (search) search.value = '';
      render();
      return;
    }
    const apply = e.target.closest('[data-proj-apply]');
    if (apply && projBotId) {
      const bot = bots.find((b) => b.id === projBotId);
      const list = (projectsByBot.get(projBotId) || []).filter((p) => picked.has(p.id));
      if (!list.length) return;
      applyTarget({
        kind: 'project',
        icon: '📁',
        label: '项目',
        title: `${bot?.name || 'Bot'} · ${list.length} 个项目`,
        ref: list.map((p) => p.id).join(','),
        projects: list.map((p) => ({ id: p.id, title: p.title, botName: bot?.name || 'Bot' })),
      });
    }
  };

  $('#targetBody').addEventListener('change', (e) => {
    const list = projectsByBot.get(projBotId) || [];
    if (e.target.matches('[data-proj-all]')) {
      if (e.target.checked) list.forEach((p) => picked.add(p.id));
      else picked.clear();
      render();
      return;
    }
    if (e.target.matches('[data-proj]')) {
      const id = e.target.dataset.proj;
      if (e.target.checked) picked.add(id);
      else picked.delete(id);
      render();
    }
  });
}

function openDrainPicker() {
  const list = runningWorkflowChats();
  const rows = list.length
    ? list
        .map((c) => {
          const wf = c.workflow;
          const node = (wf.nodes || []).find((n) => n.id === wf.currentNodeId);
          const bot = node ? botById(node.botId) : null;
          const draining = wf.status === 'draining';
          return `<button class="drain-row${draining ? ' is-draining' : ''}" data-drain-chat="${esc(
            c.id
          )}" ${draining ? 'disabled' : ''}>
            <span class="drain-emoji">${esc(bot?.emoji || '⚙️')}</span>
            <span class="drain-main">
              <span class="drain-title">${esc(c.title)}
                <i class="drain-chip ${draining ? 'draining' : 'running'}">${
                  draining ? '收尾中' : '运行中'
                }</i>
              </span>
              <span class="drain-sub">${esc(wf.name || '流程')} · 当前：${esc(
                node?.title || '进行中'
              )}${bot ? ` · ${esc(bot.name)}` : ''}</span>
            </span>
            <span class="drain-side">
              <span class="drain-time">${esc(wfElapsed(wf.startedAt))}</span>
              <span class="drain-go">${draining ? '已经在收尾' : '交给领导 Bot 收尾 →'}</span>
            </span>
          </button>`;
        })
        .join('')
    : `<div class="drain-empty">
        <div class="drain-empty-icon">🌤️</div>
        <div class="drain-empty-title">现在没有正在运行的流程</div>
        <div class="drain-empty-sub">等群里的流程图跑起来，这里就会列出来。</div>
      </div>`;

  openModal(
    `<div class="drain-pick">
      <div class="drain-head">
        <div>
          <h3>平滑结束</h3>
          <div class="wf-sub">选一个正在运行的流程，领导 Bot 会接手协调：当前环节先做完 → 没上传的成果统一交给上传/交付环节 → 完成后结束循环。</div>
        </div>
        <button class="btn ghost" id="drainClose">关闭</button>
      </div>
      <div class="drain-list" id="drainList">${rows}</div>
      <div class="drain-tip">不会中断正在跑的环节，也不会丢掉已经做完但还没上传的内容。</div>
    </div>`,
    'wide'
  );

  $('#drainClose').onclick = closeModal;
  const leaderChat = activeChat();
  $('#drainList').onclick = async (e) => {
    const row = e.target.closest('[data-drain-chat]');
    if (!row || row.disabled || row.classList.contains('sending')) return;
    const chatId = row.dataset.drainChat;
    const target = chatById(chatId);
    if (!target || !leaderChat) return;
    row.classList.add('sending');
    try {
      const r = await api(`/api/chats/${chatId}/workflow`, {
        method: 'POST',
        body: { action: 'drain', reason: '老板在领导 Bot 私聊里点了平滑结束' },
      });
      const wf = target.workflow || {};
      const node = (wf.nodes || []).find((n) => n.id === wf.currentNodeId);
      const nodeBot = node ? botById(node.botId) : null;
      const finish = r.finishTitle
        ? `收尾环节：${r.finishTitle}`
        : '没有单独的收尾环节，当前环节做完就停';
      await api(`/api/chats/${leaderChat.id}/messages`, {
        method: 'POST',
        body: {
          text: [
            `请协调「${target.title}」的流程平滑收尾。`,
            '',
            `- 群 ID：${chatId}`,
            `- 流程：${wf.name || '未命名流程'}`,
            `- 当前环节：${node?.title || '进行中'}${nodeBot ? ` · ${nodeBot.name}` : ''}`,
            `- ${finish}`,
            '',
            '要求：当前环节先做完、不要中途打断；把已经完成但还没上传的成果交给上传/交付环节；收尾完成后在群里回报结果。要看进度可以用 bt workflow-drain ' +
              chatId +
              '。',
          ].join('\n'),
        },
      });
      closeModal();
      toast(`已交给 ${botById(S.settings?.leaderId)?.name || '领导 Bot'} 协调「${target.title}」收尾`);
    } catch (err) {
      row.classList.remove('sending');
      toast(`发起收尾失败：${err.message}`, 'err');
    }
  };
}

/* ---------------- 导出流程图（独立 HTML） ---------------- */

function wfExportCut(text, max) {
  const s = String(text || '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function wfExportLayout(wf) {
  const { depth } = wf2Depths(wf);
  const stages = [];
  for (const n of wf.nodes) {
    const d = depth.get(n.id) || 0;
    (stages[d] ||= []).push(n);
  }
  const rows = stages.filter(Boolean);
  const CW = 252;
  const CH = 96;
  const GX = 30;
  const GY = 86;
  const PAD = 80;
  const rowWidth = (r) => r.length * CW + (r.length - 1) * GX;
  const widest = rows.reduce((m, r) => Math.max(m, rowWidth(r)), 0);
  const W = Math.max(1000, widest + PAD * 2);
  const top = 56;
  const H = top + rows.length * (CH + GY) + 18;
  const pos = new Map();
  rows.forEach((row, si) => {
    const rw = rowWidth(row);
    const x0 = (W - rw) / 2;
    row.forEach((n, i) => {
      pos.set(n.id, { x: x0 + i * (CW + GX), y: top + si * (CH + GY), w: CW, h: CH });
    });
  });
  return { rows, pos, W, H, CW, CH, GX, GY, top };
}

function wfExportTag(x, y, text, color) {
  const w = Math.max(30, String(text).length * 11 + 14);
  return `<g>
    <rect x="${x - w}" y="${y - 12}" width="${w}" height="19" rx="9.5" fill="${color}22" stroke="${color}66" stroke-width="1"/>
    <text x="${x - w / 2}" y="${y + 1.5}" text-anchor="middle" font-size="10" fill="${color}" font-family="inherit">${esc(
      text
    )}</text>
  </g>`;
}

function wfExportElbow(x1, y1, x2, y2, busY, dashed) {
  const dy = Math.max(14, (y2 - y1) / 2);
  const bus = busY == null ? y1 + dy : busY;
  const r = Math.min(12, Math.abs(x2 - x1) / 2 || 12);
  let d;
  if (Math.abs(x2 - x1) < 1.2) {
    d = `M${x1},${y1} L${x2},${y2}`;
  } else {
    const dir = x2 > x1 ? 1 : -1;
    d = `M${x1},${y1} L${x1},${bus - r} Q${x1},${bus} ${x1 + dir * r},${bus} L${x2 - dir * r},${bus} Q${x2},${bus} ${x2},${bus + r} L${x2},${y2}`;
  }
  return `<path d="${d}" fill="none" stroke="${dashed ? '#8f7cf0' : '#5b587d'}" stroke-width="${
    dashed ? 1.7 : 1.6
  }" stroke-dasharray="${dashed ? '6 6' : 'none'}" marker-end="url(#${
    dashed ? 'arrowLoop' : 'arrow'
  })" opacity="${dashed ? 0.9 : 0.85}"/>`;
}

function workflowExportSvg(chat, wf) {
  const { rows, pos, W, H, CW, CH, GY } = wfExportLayout(wf);
  const byId = new Map(wf.nodes.map((n) => [n.id, n]));
  const edges = [];
  const seen = new Set();
  for (const n of wf.nodes) {
    const outs = [...(n.next || []).map((e) => e.to), ...(n.parallel?.targets || [])];
    for (const to of outs) {
      if (!to || to === '__end__' || !pos.has(to)) continue;
      const key = `${n.id}->${to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push([n.id, to]);
    }
  }

  const cards = wf.nodes
    .map((n) => {
      const p = pos.get(n.id);
      if (!p) return '';
      const bot = botById(n.botId);
      const isStart = wf.startNodeId === n.id;
      const isBranch = wf2NodeIsBranch(wf, n);
      const isMerge = wf2Incoming(wf, n.id) >= 2;
      const info = wf2ModeInfo(wf, n);
      const stroke = isStart
        ? 'rgba(167,139,250,.75)'
        : isMerge
          ? 'rgba(61,220,151,.35)'
          : 'rgba(255,255,255,.1)';
      const fill = isStart ? 'url(#cardStart)' : 'url(#card)';
      let tags = '';
      let tx = p.x + p.w - 14;
      if (isBranch) {
        tags += wfExportTag(tx, p.y + 20, '分支', '#a78bfa');
        tx -= 44;
      }
      if (isMerge) {
        tags += wfExportTag(tx, p.y + 20, '汇合', '#3ddc97');
        tx -= 44;
      }
      if (isStart) tags += wfExportTag(tx, p.y + 20, '起点', '#c4b5fd');
      const accent = isStart
        ? '#7c6cf5'
        : isBranch
          ? 'rgba(124,108,245,.9)'
          : isMerge
            ? 'rgba(61,220,151,.75)'
            : 'rgba(255,255,255,.14)';
      return `<g>
        <title>${esc(`${n.title || ''}${n.task ? `\n${n.task}` : ''}`)}</title>
        <rect x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" rx="14" fill="${fill}" stroke="${stroke}" stroke-width="1.4"/>
        <rect x="${p.x}" y="${p.y + 14}" width="3" height="${p.h - 28}" rx="1.5" fill="${accent}" opacity="0.9"/>
        ${tags}
        <text x="${p.x + 18}" y="${p.y + 32}" font-size="15" font-weight="600" fill="#e8eaf0" font-family="inherit">${esc(
          wfExportCut(n.title || '未命名', 15)
        )}</text>
        <text x="${p.x + 18}" y="${p.y + 56}" font-size="11.5" fill="#8b93a5" font-family="inherit">${esc(
          wfExportCut(`${bot?.emoji ? `${bot.emoji} ` : ''}${bot?.name || '未指定 Bot'}`, 24)
        )}</text>
        <text x="${p.x + 18}" y="${p.y + 78}" font-size="10.5" fill="#a99cf0" font-family="inherit">${esc(
          wfExportCut(`${info.icon} ${info.text}`, 26)
        )}</text>
      </g>`;
    })
    .join('');

  const lines = edges
    .map(([from, to]) => {
      const a = pos.get(from);
      const b = pos.get(to);
      if (!a || !b) return '';
      const x1 = a.x + a.w / 2;
      const y1 = a.y + a.h;
      const x2 = b.x + b.w / 2;
      const y2 = b.y - 6;
      const back = b.y <= a.y;
      if (back) {
        const LX = 30;
        const sy = a.y + a.h / 2;
        const ty = b.y + b.h / 2;
        const d = `M${a.x},${sy} L${LX + 10},${sy} Q${LX},${sy} ${LX},${sy - 10} L${LX},${ty + 10} Q${LX},${ty} ${LX + 10},${ty} L${b.x - 6},${ty}`;
        const labelY = (sy + ty) / 2;
        return `<path d="${d}" fill="none" stroke="#8f7cf0" stroke-width="1.8" stroke-dasharray="7 7" marker-end="url(#arrowLoop)" opacity="0.9"/>
          <text transform="rotate(-90 ${LX - 15} ${labelY})" x="${LX - 15}" y="${labelY}" text-anchor="middle" font-size="10.5" fill="#a99cf0" stroke="#0b0d13" stroke-width="3" paint-order="stroke" stroke-linejoin="round" font-family="inherit">回到「${esc(
            wfExportCut(byId.get(to)?.title || '', 10)
          )}」· 下一轮</text>`;
      }
      return wfExportElbow(x1, y1, x2, y2, (y1 + y2) / 2, false);
    })
    .join('');

  // 结束标记：有环节明确结束时，在最后一行下面放一个收尾点
  const hasEnd = wf.nodes.some((n) => wf2Mode(wf, n) === 'end');
  const endMark = hasEnd
    ? `<g><rect x="${W / 2 - 46}" y="${H - 30}" width="92" height="24" rx="12" fill="rgba(255,255,255,.04)" stroke="rgba(255,255,255,.14)"/>
        <text x="${W / 2}" y="${H - 14}" text-anchor="middle" font-size="10.5" fill="#8b93a5" font-family="inherit">流程结束</text></g>`
    : '';

  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg" font-family="-apple-system,BlinkMacSystemFont,'PingFang SC','Helvetica Neue',Arial,sans-serif">
    <defs>
      <linearGradient id="card" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#1e2230"/><stop offset="1" stop-color="#171a24"/>
      </linearGradient>
      <linearGradient id="cardStart" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#2a2452"/><stop offset="1" stop-color="#1b1930"/>
      </linearGradient>
      <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
        <path d="M0 0 L10 5 L0 10 Z" fill="#6f6a9c"/>
      </marker>
      <marker id="arrowLoop" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
        <path d="M0 0 L10 5 L0 10 Z" fill="#8f7cf0"/>
      </marker>
      <pattern id="grid" width="34" height="34" patternUnits="userSpaceOnUse">
        <path d="M34 0H0V34" fill="none" stroke="rgba(255,255,255,0.022)"/>
      </pattern>
    </defs>
    <rect x="0" y="0" width="${W}" height="${H}" fill="url(#grid)"/>
    ${lines}
    ${cards}
    ${endMark}
  </svg>`;
}

function workflowExportHtml(chat, wf) {
  const count = wf.nodes.length;
  const maxSteps = wf.maxSteps === 0 ? '不限' : `${wf.maxSteps} 步`;
  const when = new Date();
  const stamp = `${when.getFullYear()}-${pad2(when.getMonth() + 1)}-${pad2(when.getDate())} ${pad2(
    when.getHours()
  )}:${pad2(when.getMinutes())}`;
  const branchCount = wf.nodes.filter((n) => (n.parallel?.targets || []).length >= 2).length;
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${esc(chat.title)} · ${esc(wf.name || '群流程图')}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    padding: 40px 24px 56px;
    background:
      radial-gradient(1100px 520px at 12% -10%, rgba(124,108,245,.18), transparent 60%),
      radial-gradient(900px 500px at 92% 4%, rgba(61,220,151,.08), transparent 55%),
      #0b0d13;
    color: #e8eaf0;
    font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", Arial, sans-serif;
    display: flex;
    justify-content: center;
  }
  .sheet {
    width: min(1240px, 100%);
    border-radius: 22px;
    border: 1px solid rgba(255,255,255,.08);
    background: linear-gradient(180deg, rgba(24,27,37,.96), rgba(15,17,24,.98));
    box-shadow: 0 30px 90px rgba(0,0,0,.55);
    padding: 28px 30px 22px;
  }
  .eyebrow { font-size: 12px; letter-spacing: .08em; color: #8b93a5; }
  h1 { margin: 6px 0 8px; font-size: 24px; letter-spacing: .01em; }
  .meta { display: flex; flex-wrap: wrap; gap: 8px; font-size: 11.5px; color: #8b93a5; }
  .meta span {
    padding: 3px 10px;
    border-radius: 999px;
    border: 1px solid rgba(255,255,255,.09);
    background: rgba(255,255,255,.03);
  }
  .canvas {
    margin: 18px 0 8px;
    border-radius: 18px;
    border: 1px solid rgba(255,255,255,.055);
    background:
      radial-gradient(120% 60% at 0% 0%, rgba(124,108,245,.1), transparent 60%),
      rgba(255,255,255,.012);
    overflow: auto;
  }
  .canvas svg { display: block; width: 100%; height: auto; min-width: 760px; }
  footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding-top: 14px;
    border-top: 1px solid rgba(255,255,255,.06);
    font-size: 11px;
    color: #7f8797;
  }
  .legend { display: flex; gap: 14px; flex-wrap: wrap; }
  .legend i {
    display: inline-block;
    width: 7px; height: 7px;
    border-radius: 50%;
    margin-right: 5px;
    vertical-align: middle;
  }
  @media print {
    body { padding: 0; background: #0b0d13; }
    .sheet { box-shadow: none; border: 0; }
  }
</style>
</head>
<body>
<main class="sheet">
  <div class="eyebrow">群流程图 · ${esc(chat.title)}</div>
  <h1>${esc(wf.name || '未命名流程')}</h1>
  <div class="meta">
    <span>${count} 个环节</span>
    <span>最多运行：${esc(maxSteps)}</span>
    ${branchCount ? `<span>${branchCount} 处并行分发</span>` : ''}
    <span>导出时间 ${stamp}</span>
  </div>
  <div class="canvas">${workflowExportSvg(chat, wf)}</div>
  <footer>
    <div class="legend">
      <span><i style="background:#7c6cf5"></i>起点</span>
      <span><i style="background:#a78bfa"></i>并行分支</span>
      <span><i style="background:#3ddc97"></i>汇合</span>
      <span><i style="background:#8f7cf0"></i>循环回到起点</span>
    </div>
    <div>Bot Team · 群流程图导出</div>
  </footer>
</main>
</body>
</html>`;
}

// 给 PNG / PDF 用的海报版式：标题 + 流程图 + 图例，一起栅格化。
function workflowPosterSvg(chat, wf) {
  const { W, H } = wfExportLayout(wf);
  const full = workflowExportSvg(chat, wf);
  const start = full.indexOf('>', full.indexOf('<svg')) + 1;
  const inner = full.slice(start, full.lastIndexOf('</svg>'));
  const pad = 44;
  const header = 132;
  const footer = 76;
  const PW = W + pad * 2;
  const PH = header + H + footer;
  const maxSteps = wf.maxSteps === 0 ? '不限' : `${wf.maxSteps} 步`;
  const branchCount = wf.nodes.filter((n) => (n.parallel?.targets || []).length >= 2).length;
  const now = new Date();
  const stamp = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())} ${pad2(
    now.getHours()
  )}:${pad2(now.getMinutes())}`;
  const meta = [
    `${wf.nodes.length} 个环节`,
    `最多运行：${maxSteps}`,
    branchCount ? `${branchCount} 处并行分发` : '',
    `导出时间 ${stamp}`,
  ]
    .filter(Boolean)
    .join('   ·   ');
  const legend = [
    ['#7c6cf5', '起点'],
    ['#a78bfa', '并行分支'],
    ['#3ddc97', '汇合'],
    ['#8f7cf0', '循环回到起点'],
  ];
  let lx = pad;
  const legendSvg = legend
    .map(([color, label]) => {
      const g = `<g><circle cx="${lx + 4}" cy="${PH - 26}" r="4" fill="${color}"/>
        <text x="${lx + 14}" y="${PH - 22}" font-size="11" fill="#8b93a5">${esc(label)}</text></g>`;
      lx += 18 + label.length * 12 + 16;
      return g;
    })
    .join('');
  return `<svg width="${PW}" height="${PH}" viewBox="0 0 ${PW} ${PH}" xmlns="http://www.w3.org/2000/svg" font-family="-apple-system,BlinkMacSystemFont,'PingFang SC','Helvetica Neue',Arial,sans-serif">
    <rect width="${PW}" height="${PH}" fill="#0b0d13"/>
    <rect width="${PW}" height="${PH}" fill="url(#posterGlow)"/>
    <defs>
      <radialGradient id="posterGlow" cx="12%" cy="-6%" r="90%">
        <stop offset="0" stop-color="#7c6cf5" stop-opacity="0.16"/>
        <stop offset="0.55" stop-color="#7c6cf5" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <text x="${pad}" y="40" font-size="12" fill="#8b93a5" letter-spacing="1">群流程图 · ${esc(
      chat.title
    )}</text>
    <text x="${pad}" y="74" font-size="26" font-weight="700" fill="#e8eaf0">${esc(
      wf.name || '未命名流程'
    )}</text>
    <text x="${pad}" y="100" font-size="11.5" fill="#8b93a5">${esc(meta)}</text>
    <line x1="${pad}" y1="${header - 16}" x2="${PW - pad}" y2="${header - 16}" stroke="rgba(255,255,255,.08)"/>
    <g transform="translate(${pad}, ${header})">${inner}</g>
    <line x1="${pad}" y1="${PH - 48}" x2="${PW - pad}" y2="${PH - 48}" stroke="rgba(255,255,255,.07)"/>
    ${legendSvg}
    <text x="${PW - pad}" y="${PH - 22}" text-anchor="end" font-size="11" fill="#6f7686">Bot Team · 群流程图导出</text>
  </svg>`;
}

async function wfExportRaster(chat, wf, { mime = 'image/png', quality = 0.92, scale = 2 } = {}) {
  const svg = workflowPosterSvg(chat, wf);
  const { W, H } = wfExportLayout(wf);
  const posterW = W + 88;
  const posterH = 132 + H + 76;
  const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('流程图渲染失败'));
      img.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(posterW * scale);
    canvas.height = Math.round(posterH * scale);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#0b0d13';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return { dataUrl: canvas.toDataURL(mime, quality), W: posterW, H: posterH, scale };
  } finally {
    URL.revokeObjectURL(url);
  }
}

// 用画布导出的 JPEG 拼一个最小 PDF，避免额外依赖。
function wfPdfFromJpeg(jpegBase64, pxW, pxH) {
  const bin = atob(jpegBase64);
  const jpeg = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) jpeg[i] = bin.charCodeAt(i);
  const pageW = Math.round(pxW / 2);
  const pageH = Math.round(pxH / 2);
  const enc = new TextEncoder();
  const parts = [];
  const offsets = [];
  let len = 0;
  const push = (str) => {
    const b = enc.encode(str);
    parts.push(b);
    len += b.length;
  };
  push('%PDF-1.4\n');
  offsets[1] = len;
  push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  offsets[2] = len;
  push('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');
  offsets[3] = len;
  push(
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>\nendobj\n`
  );
  offsets[4] = len;
  push(
    `4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${pxW} /Height ${pxH} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`
  );
  parts.push(jpeg);
  len += jpeg.length;
  push('\nendstream\nendobj\n');
  const content = `q\n${pageW} 0 0 ${pageH} 0 0 cm\n/Im0 Do\nQ\n`;
  offsets[5] = len;
  push(`5 0 obj\n<< /Length ${content.length} >>\nstream\n${content}endstream\nendobj\n`);
  const xref = len;
  push('xref\n0 6\n0000000000 65535 f \n');
  for (let i = 1; i <= 5; i++) push(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`);
  push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(len);
  let p = 0;
  for (const b of parts) {
    out.set(b, p);
    p += b.length;
  }
  return out;
}

async function exportWorkflowAs(chat, wf, kind) {
  const name = `${chat.title}-${wf.name || '流程图'}`;
  if (kind === 'html') {
    return api('/api/workflows/export', {
      method: 'POST',
      body: { name, html: workflowExportHtml(chat, wf), ext: 'html' },
    });
  }
  if (kind === 'png') {
    const { dataUrl } = await wfExportRaster(chat, wf, { mime: 'image/png', scale: 2 });
    return api('/api/workflows/export', {
      method: 'POST',
      body: { name, data: String(dataUrl).split(',')[1] || '', ext: 'png' },
    });
  }
  const { dataUrl, W, H, scale } = await wfExportRaster(chat, wf, {
    mime: 'image/jpeg',
    quality: 0.92,
    scale: 2,
  });
  const base64 = String(dataUrl).split(',')[1] || '';
  const pdf = wfPdfFromJpeg(base64, Math.round(W * scale), Math.round(H * scale));
  let raw = '';
  const chunk = 0x8000;
  for (let i = 0; i < pdf.length; i += chunk) {
    raw += String.fromCharCode(...pdf.subarray(i, i + chunk));
  }
  return api('/api/workflows/export', {
    method: 'POST',
    body: { name, data: btoa(raw), ext: 'pdf' },
  });
}

function openWorkflow(chat) {
  S.wfDraft = JSON.parse(JSON.stringify(chat.workflow || wfDefault(chat)));
  S.wfSelected = S.wfDraft.startNodeId || S.wfDraft.nodes?.[0]?.id || null;
  renderWf2(chat);
}

async function saveWorkflowDraft(chat) {
  const wf = validateWorkflow(collectWorkflowDraft(chat));
  await api(`/api/chats/${chat.id}`, { method: 'PATCH', body: { workflow: wf } });
  S.wfDraft = wf;
  return wf;
}

function wireWorkflowModal(chat) {
  $('#wfCancel').onclick = closeModal;

  $('#wfAddNode').onclick = () => {
    S.wfDraft = collectWorkflowDraft(chat);
    const id = `wfn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`;
    const prev = S.wfDraft.nodes[S.wfDraft.nodes.length - 1];
    S.wfDraft.nodes.push({
      id,
      title: `步骤 ${S.wfDraft.nodes.length + 1}`,
      botId: chat.leadId || chat.botIds[0] || '',
      model: '',
      task: '',
      stopWhen: '',
      next: [{ to: '__end__', when: 'always', keyword: '' }],
    });
    // 顺序流程默认衔接：上一步原本直接结束的，自动改成「总是 → 新步骤」
    if (
      prev &&
      (!prev.next?.length || prev.next.every((e) => !e.to || e.to === '__end__'))
    ) {
      prev.next = [{ to: id, when: 'always', keyword: '' }];
    }
    renderWorkflowModal(chat);
  };

  $('#wfSave').onclick = async () => {
    try {
      await saveWorkflowDraft(chat);
      toast('流程已保存发布');
      closeModal();
    } catch (e) {
      toast(`保存失败：${e.message}`, 'err');
    }
  };

  $('#wfRun').onclick = async () => {
    try {
      await saveWorkflowDraft(chat);
      await api(`/api/chats/${chat.id}/workflow`, {
        method: 'POST',
        body: { action: 'run' },
      });
      toast('流程已启动');
      closeModal();
    } catch (e) {
      toast(`启动失败：${e.message}`, 'err');
    }
  };

  if ($('#wfDrain')) {
    $('#wfDrain').onclick = async () => {
      try {
        const r = await api(`/api/chats/${chat.id}/workflow`, {
          method: 'POST',
          body: { action: 'drain' },
        });
        toast(
          r.finishTitle
            ? `已请求平滑收尾：当前环节完成后交给「${r.finishTitle}」`
            : '已请求平滑收尾：当前环节完成后结束'
        );
        closeModal();
      } catch (e) {
        toast(`收尾失败：${apiErrorText(e)}`, 'err');
      }
    };
  }

  if ($('#wfStop')) {
    $('#wfStop').onclick = async () => {
      try {
        await api(`/api/chats/${chat.id}/workflow`, {
          method: 'POST',
          body: { action: 'stop' },
        });
        toast('已停止流程');
        closeModal();
      } catch (e) {
        toast(`停止失败：${e.message}`, 'err');
      }
    };
  }

  $('#wfDelete').onclick = async () => {
    if (!confirm('删除这个群的流程图？')) return;
    try {
      await api(`/api/chats/${chat.id}`, { method: 'PATCH', body: { workflow: null } });
      toast('流程已删除');
      closeModal();
    } catch (e) {
      toast(`删除失败：${e.message}`, 'err');
    }
  };

  $('#wfLeader').onclick = async () => {
    const prompt = ($('#wfLeaderPrompt')?.value || '').trim();
    if (!prompt) return toast('先写一下你想要什么流程');
    const dm = S.chats
      .filter((c) => c.type === 'dm' && c.botIds[0] === S.settings?.leaderId)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
    if (!dm) return toast('领导还没有私聊项目', 'err');
    const members = wfMembers(chat)
      .map(
        (b) =>
          `${b.name}（id=${b.id}，${b.backend}${b.model ? `/${b.model}` : ''}，${
            roleForChat(chat, b)?.name || '无职位'
          }）`
      )
      .join('、');
    const text = `请为群「${chat.title}」设计并发布一个流程图。
目标/要求：${prompt}
群成员：${members}。
用管理员 CLI 的 workflow 命令保存到这个群（chatId=${chat.id}），先不要运行；保存后把每个环节、执行 Bot、模型、下一步和停止条件告诉我。`;
    try {
      await api(`/api/chats/${dm.id}/messages`, { method: 'POST', body: { text } });
      closeModal();
      toast('已发给知柚，设计完成后重新打开流程查看');
    } catch (e) {
      toast(`发送失败：${e.message}`, 'err');
    }
  };

  const editor = $('#wfEditor');
  editor.addEventListener('change', (e) => {
    if (e.target.matches('[data-wf-parallel]')) {
      const fields = e.target.closest('[data-wf-node]')?.querySelector('[data-wf-parallel-fields]');
      if (fields) fields.hidden = !e.target.checked;
    }
    if (e.target.closest('[data-wf-parallel], [data-wf-parallel-target]')) {
      const nodeEl = e.target.closest('[data-wf-node]');
      const join = nodeEl?.querySelector('[data-wf-parallel-join]');
      if (join) {
        const selected = new Set(
          [...nodeEl.querySelectorAll('[data-wf-parallel-target]:checked')].map((i) => i.value)
        );
        [...join.options].forEach((o) => {
          if (o.value) o.disabled = selected.has(o.value);
        });
        if (selected.has(join.value)) join.value = '';
      }
    }
    if (
      !e.target.closest(
        '[data-wf-to], [data-wf-when], [data-wf-parallel], [data-wf-parallel-target], [data-wf-parallel-join]'
      )
    ) {
      return;
    }
    S.wfDraft = collectWorkflowDraft(chat);
    const aside = document.querySelector('.wf-preview');
    if (aside) aside.innerHTML = wfPreview(chat, S.wfDraft, S.wfDraft.nodes);
  });
  editor.addEventListener('click', (e) => {
    const nodeEl = e.target.closest('[data-wf-node]');
    if (!nodeEl) return;
    const nodeId = nodeEl.dataset.nodeId;
    S.wfDraft = collectWorkflowDraft(chat);
    const index = S.wfDraft.nodes.findIndex((n) => n.id === nodeId);
    if (index < 0) return;
    if (e.target.closest('[data-wf-up]')) {
      if (index > 0) {
        [S.wfDraft.nodes[index - 1], S.wfDraft.nodes[index]] = [
          S.wfDraft.nodes[index],
          S.wfDraft.nodes[index - 1],
        ];
      }
      return renderWorkflowModal(chat);
    }
    if (e.target.closest('[data-wf-down]')) {
      if (index < S.wfDraft.nodes.length - 1) {
        [S.wfDraft.nodes[index + 1], S.wfDraft.nodes[index]] = [
          S.wfDraft.nodes[index],
          S.wfDraft.nodes[index + 1],
        ];
      }
      return renderWorkflowModal(chat);
    }
    if (e.target.closest('[data-wf-del]')) {
      if (S.wfDraft.nodes.length <= 1) return toast('至少保留一个环节');
      S.wfDraft.nodes.splice(index, 1);
      for (const n of S.wfDraft.nodes) {
        if (!n.parallel) continue;
        n.parallel.targets = n.parallel.targets.filter((id) => id !== nodeId);
        if (n.parallel.targets.length < 2 || n.parallel.joinTo === nodeId) n.parallel = null;
      }
      if (!S.wfDraft.nodes.some((n) => n.id === S.wfDraft.startNodeId)) {
        S.wfDraft.startNodeId = S.wfDraft.nodes[0].id;
      }
      return renderWorkflowModal(chat);
    }
    if (e.target.closest('[data-wf-parallel-add]')) {
      S.wfDraft = collectWorkflowDraft(chat);
      const cur = S.wfDraft.nodes[index];
      if (!cur) return;
      const nid = () =>
        `wfn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`;
      const mk = (title) => ({
        id: nid(),
        title,
        botId: cur.botId,
        model: '',
        task: '',
        stopWhen: '',
        allowEnd: false,
        role: 'collector',
        next: [{ to: '__end__', when: 'always', keyword: '' }],
        parallel: null,
      });
      const b1 = mk('并行分支 1');
      const b2 = mk('并行分支 2');
      cur.parallel = { targets: [b1.id, b2.id] };
      S.wfDraft.nodes.splice(index + 1, 0, b1, b2);
      renderWorkflowModal(chat);
      toast('已创建两个并行分支，分别设置它们的 Bot 和任务；分支可以继续往下一步延伸');
      return;
    }
    if (e.target.closest('[data-wf-parallel-add-branch]')) {
      S.wfDraft = collectWorkflowDraft(chat);
      const cur = S.wfDraft.nodes[index];
      if (!cur?.parallel) return;
      const id = `wfn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`;
      const branch = {
        id,
        title: `并行分支 ${cur.parallel.targets.length + 1}`,
        botId: cur.botId,
        model: '',
        task: '',
        stopWhen: '',
        allowEnd: false,
        role: 'collector',
        next: [{ to: '__end__', when: 'always', keyword: '' }],
        parallel: null,
      };
      cur.parallel.targets.push(id);
      S.wfDraft.nodes.splice(index + cur.parallel.targets.length, 0, branch);
      renderWorkflowModal(chat);
      return;
    }
    if (e.target.closest('[data-wf-parallel-cancel]')) {
      S.wfDraft = collectWorkflowDraft(chat);
      const cur = S.wfDraft.nodes[index];
      const p = cur?.parallel;
      if (p) {
        S.wfDraft.nodes = S.wfDraft.nodes.filter(
          (n) => !p.targets.includes(n.id) && n.id !== p.joinTo
        );
        cur.parallel = null;
        if (!S.wfDraft.nodes.some((n) => n.id === S.wfDraft.startNodeId)) {
          S.wfDraft.startNodeId = S.wfDraft.nodes[0]?.id;
        }
        renderWorkflowModal(chat);
      }
      return;
    }
    if (e.target.closest('[data-wf-add-branch]')) {
      S.wfDraft.nodes[index].next.push({ to: '__end__', when: 'always', keyword: '' });
      return renderWorkflowModal(chat);
    }
    if (e.target.closest('[data-wf-del-branch]')) {
      const row = e.target.closest('[data-wf-branch]');
      const rows = [...nodeEl.querySelectorAll('[data-wf-branch]')];
      const bi = rows.indexOf(row);
      if (bi >= 0 && S.wfDraft.nodes[index].next.length > 1) {
        S.wfDraft.nodes[index].next.splice(bi, 1);
      } else if (bi >= 0) {
        S.wfDraft.nodes[index].next = [{ to: '__end__', when: 'always', keyword: '' }];
      }
      return renderWorkflowModal(chat);
    }
  });

  editor.addEventListener('change', (e) => {
    if (!e.target.matches('[data-wf-when]')) return;
    const row = e.target.closest('[data-wf-branch]');
    const kw = row?.querySelector('[data-wf-keyword]');
    if (kw) kw.disabled = e.target.value !== 'keyword';
  });
}


/* ---------------- usage dashboard ---------------- */

function usageMoney(n) {
  const v = Number(n || 0);
  return `¥${v.toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function fmtCredits(n) {
  const v = Number(n || 0);
  if (!v) return '0';
  if (v < 10) return v.toFixed(2).replace(/\.?0+$/, '');
  return Math.round(v).toLocaleString('zh-CN');
}

function usageCreditText(credits, estimated, cost) {
  const n = Number(credits || 0);
  if (!n) return '';
  return `${fmtCredits(n)} 积分${estimated ? '（估算）' : ''}${
    cost > 0 ? ` · ${usageMoney(cost)}` : ''
  }`;
}

function usageMoneyFine(n) {
  const v = Number(n || 0);
  if (v >= 0.01 || v === 0) return usageMoney(v);
  return `¥${v.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}`;
}

function usageShell() {
  const range = [7, 30, 90]
    .map(
      (d) =>
        `<button data-usage-days="${d}" class="${S.usageDays === d ? 'active' : ''}">${d} 天</button>`
    )
    .join('');
  return `<div class="usage-dash">
    <div class="usage-head">
      <div>
        <h3>用量中心</h3>
        <div class="usage-sub">Token 消耗、成本估算、余额与订阅</div>
      </div>
      <div class="usage-controls">
        <div class="usage-range" id="usageRange">${range}</div>
        <label class="usage-toggle">
          <input type="checkbox" id="usageSub" ${S.usageSub ? 'checked' : ''} />
          订阅按套餐 / 积分估算
        </label>
        <button class="btn ghost" id="usageRefresh">刷新</button>
        <button class="btn ghost" id="usageClose">关闭</button>
      </div>
    </div>
    <div id="usageBody"><div class="usage-loading">正在统计…</div></div>
  </div>`;
}

function openUsageDashboard() {
  S.usageDays = [7, 30, 90].includes(Number(S.usageDays)) ? Number(S.usageDays) : 30;
  S.usageDay = '';
  try {
    S.usageSub = localStorage.getItem('bt.usage.sub') === '1';
  } catch {
    S.usageSub = false;
  }
  try {
    const dim = localStorage.getItem('bt.usage.dim');
    S.usageDim = USAGE_DIM_TABS.some((d) => d.id === dim) ? dim : 'bot';
  } catch {
    S.usageDim = 'bot';
  }
  openModal(usageShell(), 'usage');
  wireUsageDashboard();
  loadUsageDashboard();
}

function wireUsageDashboard() {
  $('#usageClose').onclick = closeModal;
  $('#usageRefresh').onclick = () => loadUsageDashboard(true, { silent: true });
  $('#usageSub').onchange = (e) => {
    S.usageSub = !!e.target.checked;
    try {
      localStorage.setItem('bt.usage.sub', S.usageSub ? '1' : '0');
    } catch {}
    loadUsageDashboard(false, { silent: true });
  };
  $('#usageRange').onclick = (e) => {
    const btn = e.target.closest('[data-usage-days]');
    if (!btn) return;
    S.usageDays = Number(btn.dataset.usageDays);
    S.usageDay = '';
    [...$('#usageRange').children].forEach((b) =>
      b.classList.toggle('active', b === btn)
    );
    loadUsageDashboard(false, { silent: true });
  };
}

async function loadUsageDashboard(force = false, { silent = false } = {}) {
  const body = $('#usageBody');
  if (!body) return;
  const modal = $('#modal');
  const keepTop = modal ? modal.scrollTop : 0;
  if (!silent) body.innerHTML = '<div class="usage-loading">正在统计…</div>';
  try {
    const [s, pv] = await Promise.all([
      api(
        `/api/usage/summary?days=${S.usageDays}&day=${encodeURIComponent(
          S.usageDay || ''
        )}&includeSubscription=${S.usageSub ? '1' : '0'}`
      ),
      api('/api/providers').catch(() => ({ providers: [] })),
    ]);
    S.lastUsageSummary = s;
    body.innerHTML = usageDashboardHtml(s, pv.providers || []);
    wireUsageCharts(body);
    if (modal) modal.scrollTop = keepTop;
    if (S.lastBalances) {
      const balNow = $('#usageBalances');
      if (balNow) balNow.innerHTML = usageBalancesHtml(S.lastBalances);
    }
    const syncMimo = $('#usageSyncMimo');
    if (syncMimo) syncMimo.onclick = () => syncMimoFromBrowser(syncMimo);
    const mimoLogin = $('#usageMimoLogin');
    if (mimoLogin) mimoLogin.onclick = () => mimoLoginInApp(mimoLogin);
    const saveProviders = $('#usageSaveProviders');
    if (saveProviders) {
      saveProviders.onclick = async () => {
        const keys = {};
        for (const input of document.querySelectorAll('[data-provider]')) {
          const v = (input.value || '').trim();
          if (v) keys[input.dataset.provider] = v;
        }
        if (!Object.keys(keys).length) return toast('没有填写新的 Key');
        try {
          await api('/api/settings', {
            method: 'PATCH',
            body: { providerKeys: keys },
          });
          toast('已保存连接，正在刷新余额');
          loadUsageDashboard(true);
        } catch (e) {
          toast(`保存失败：${e.message}`, 'err');
        }
      };
    }
    body.onclick = (e) => {
      const tab = e.target.closest('[data-usage-dim]');
      if (tab) {
        S.usageDim = tab.dataset.usageDim;
        try {
          localStorage.setItem('bt.usage.dim', S.usageDim);
        } catch {}
        const current = $('#usageBreakdown');
        if (current && S.lastUsageSummary) {
          current.outerHTML = usageBreakdownHtml(S.lastUsageSummary);
        }
        return;
      }
      const row = e.target.closest('.usage-dim-row[data-dim]');
      if (row) openUsageDetail(row.dataset.dim, row.dataset.key);
    };
    const balEl = $('#usageBalances');
    if (balEl) {
      balEl.onclick = async (e) => {
        const tab = e.target.closest('[data-balance-tab]');
        if (tab) {
          S.usageBalanceTab = tab.dataset.balanceTab;
          balEl.innerHTML = usageBalancesHtml(S.lastBalances || []);
          return;
        }
        const btn = e.target.closest('[data-balance-action]');
        if (!btn) return;
        const kind = btn.dataset.balanceAction;
        if (kind === 'provider') {
          const details = document.querySelector('.usage-connect');
          if (details) details.open = true;
          const input = document.querySelector(
            `[data-provider="${btn.dataset.provider}"]`
          );
          if (input) {
            input.scrollIntoView({ block: 'center', behavior: 'smooth' });
            input.focus();
            input.classList.add('usage-provider-focus');
            setTimeout(() => input.classList.remove('usage-provider-focus'), 1600);
          } else {
            toast('该供应商需要本机 CLI 登录，请查看下方说明', 'err');
          }
        } else if (kind === 'open-app') {
          try {
            await api('/api/open-app', {
              method: 'POST',
              body: { app: btn.dataset.app },
            });
          } catch (err) {
            toast(`打开失败：${err.message}`, 'err');
          }
        } else if (kind === 'settings-fda') {
          try {
            await api('/api/open-settings', {
              method: 'POST',
              body: { target: 'fda' },
            });
            toast('已打开系统设置：把「Bot Team」加入完全磁盘访问权限后重试');
          } catch (err) {
            toast(`打开失败：${err.message}`, 'err');
          }
        } else if (kind === 'sync-mimo') {
          await syncMimoFromBrowser(btn);
        } else if (kind === 'mimo-login') {
          await mimoLoginInApp(btn);
        } else if (kind === 'retry') {
          const el = $('#usageBalances');
          if (el) el.innerHTML = '<div class="usage-loading">查询余额中…</div>';
          try {
            const b = await api('/api/usage/balances?refresh=1');
            if (el) el.innerHTML = usageBalancesHtml(b.balances || []);
          } catch (err) {
            if (el) {
              el.innerHTML = `<div class="usage-empty">余额查询失败：${esc(
                err.message
              )}</div>`;
            }
          }
        }
      };
    }
    api(`/api/usage/balances${force ? '?refresh=1' : ''}`)
      .then((b) => {
        const el = $('#usageBalances');
        S.lastBalances = b.balances || [];
        if (el) el.innerHTML = usageBalancesHtml(S.lastBalances);
      })
      .catch((e) => {
        const el = $('#usageBalances');
        if (el) el.innerHTML = `<div class="usage-empty">余额查询失败：${esc(e.message)}</div>`;
      });
  } catch (e) {
    body.innerHTML = `<div class="usage-empty">用量加载失败：${esc(e.message)}</div>`;
  }
}

function usageKpi(label, value, sub, accent = '') {
  return `<div class="usage-kpi ${accent}">
    <div class="usage-kpi-label">${esc(label)}</div>
    <div class="usage-kpi-value">${value}</div>
    <div class="usage-kpi-sub">${sub}</div>
  </div>`;
}

function usageChart(daily) {
  const W = 1000;
  const H = 140;
  const padL = 12;
  const padR = 12;
  const padT = 14;
  const padB = 28;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const max = Math.max(1, ...daily.map((d) => d.total || 0));
  const step = innerW / Math.max(1, daily.length);
  const bw = Math.max(2, step * 0.62);
  const bars = daily
    .map((d, i) => {
      const h = ((d.total || 0) / max) * innerH;
      const x = padL + i * step + (step - bw) / 2;
      const y = padT + innerH - h;
      const sel = S.usageDay && S.usageDay === d.date ? ' selected' : '';
      return `<rect class="usage-bar${sel}" data-day="${esc(d.date)}" x="${x.toFixed(1)}" y="${y.toFixed(
        1
      )}" width="${bw.toFixed(1)}" height="${h > 0 ? Math.max(1, h).toFixed(1) : 0}" rx="2" fill="url(#usageBar)"/>`;
    })
    .join('');
  const hits = daily
    .map((d, i) => {
      const x = padL + i * step;
      return `<rect class="usage-hit" x="${x.toFixed(1)}" y="${padT}" width="${step.toFixed(
        1
      )}" height="${innerH}" data-date="${esc(d.date)}" data-tokens="${Number(
        d.total
      ) || 0}" data-calls="${Number(d.calls) || 0}" data-cost="${Number(d.cost) || 0}" data-credits="${Number(
        d.credits
      ) || 0}"/>`;
    })
    .join('');
  const every = Math.max(1, Math.ceil(daily.length / 8));
  const labels = daily
    .map((d, i) =>
      i % every === 0 || i === daily.length - 1
        ? `<text x="${(padL + i * step + step / 2).toFixed(
            1
          )}" y="${H - 8}" text-anchor="middle" class="usage-axis">${d.date.slice(
            5
          )}</text>`
        : ''
    )
    .join('');
  const grids = [0, 0.5, 1]
    .map((f) => {
      const y = padT + innerH * (1 - f);
      return `<line x1="${padL}" x2="${W - padR}" y1="${y}" y2="${y}" class="usage-gridline"/><text x="${padL}" y="${y - 3}" class="usage-axis">${fmt(
        max * f
      )}</text>`;
    })
    .join('');
  return `<div class="usage-chart-wrap">
    <svg class="usage-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="每日 token">
      <defs><linearGradient id="usageBar" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#b9a8ff"/><stop offset="100%" stop-color="#6c5ce7"/>
      </linearGradient></defs>
      <line class="usage-hover-line" x1="0" x2="0" y1="${padT}" y2="${padT + innerH}" hidden/>
      ${grids}${bars}${hits}${labels}
    </svg>
  </div>`;
}

function usageChartTipEl() {
  let el = document.getElementById('usageChartTip');
  if (!el) {
    el = document.createElement('div');
    el.id = 'usageChartTip';
    el.className = 'usage-chart-tip';
    el.hidden = true;
    document.body.appendChild(el);
  }
  return el;
}

function wireUsageCharts(root) {
  const tip = usageChartTipEl();
  root.querySelectorAll('.usage-chart-wrap').forEach((wrap) => {
    if (wrap.dataset.wired) return;
    wrap.dataset.wired = '1';
    const line = wrap.querySelector('.usage-hover-line');
    const bars = [...wrap.querySelectorAll('.usage-bar')];
    const hide = () => {
      tip.hidden = true;
      if (line) line.hidden = true;
      bars.forEach((b) => b.classList.remove('on'));
    };
    wrap.addEventListener('click', (e) => {
      const hit = e.target.closest('.usage-hit, .usage-bar');
      if (!hit) return;
      const d = hit.dataset.date || hit.dataset.day;
      if (!d) return;
      S.usageDay = S.usageDay === d ? '' : d;
      loadUsageDashboard(false, { silent: true });
    });
    wrap.addEventListener('pointermove', (e) => {
      const hit = e.target.closest('.usage-hit');
      if (!hit) return hide();
      const tokens = Number(hit.dataset.tokens) || 0;
      const calls = Number(hit.dataset.calls) || 0;
      const cost = Number(hit.dataset.cost) || 0;
      const credits = Number(hit.dataset.credits) || 0;
      tip.innerHTML = `<div class="tip-date">${esc(hit.dataset.date)}</div>
        <div class="tip-row"><span>Tokens</span><b>${fmt(tokens)}</b></div>
        ${credits ? `<div class="tip-row"><span>积分</span><b>${fmtCredits(credits)}</b></div>` : ''}
        <div class="tip-row"><span>消耗</span><b>${usageMoney(cost)}</b></div>
        <div class="tip-row"><span>调用</span><b>${fmt(calls)} 次</b></div>`;
      tip.hidden = false;
      const tw = tip.offsetWidth;
      const th = tip.offsetHeight;
      let left = e.clientX + 14;
      let top = e.clientY - th - 12;
      if (left + tw > window.innerWidth - 8) left = e.clientX - tw - 14;
      if (left < 8) left = 8;
      if (top < 8) top = e.clientY + 16;
      if (top + th > window.innerHeight - 8) top = window.innerHeight - th - 8;
      tip.style.left = `${left}px`;
      tip.style.top = `${top}px`;
      if (line) {
        const x = Number(hit.getAttribute('x')) + Number(hit.getAttribute('width')) / 2;
        line.setAttribute('x1', x);
        line.setAttribute('x2', x);
        line.hidden = false;
      }
      bars.forEach((b) => b.classList.toggle('on', b.dataset.day === hit.dataset.date));
    });
    wrap.addEventListener('pointerleave', hide);
    wrap.addEventListener('pointercancel', hide);
  });
}

const USAGE_PLACE_KINDS = {
  group: '群聊',
  project: '项目',
  dm: '私聊',
  history: '历史',
};

const USAGE_DIM_TABS = [
  { id: 'model', label: '按模型' },
  { id: 'backend', label: '按 CLI' },
  { id: 'source', label: '按渠道' },
  { id: 'bot', label: '按 Bot' },
  { id: 'place', label: '按项目 / 群聊' },
];

function usageBreakdownHtml(s) {
  const active = USAGE_DIM_TABS.some((d) => d.id === S.usageDim) ? S.usageDim : 'bot';
  const rows = s?.dims?.[active] || [];
  const max = Math.max(1, ...rows.map((r) => r.total || 0));
  const rowHtml = (r) => {
    const pct = Math.max(1.5, Math.round(((r.total || 0) / max) * 100));
    const kind = active === 'place' ? r.kind || '' : '';
    const kindTag =
      kind && USAGE_PLACE_KINDS[kind]
        ? `<i class="usage-bd-tag ${kind}">${USAGE_PLACE_KINDS[kind]}</i>`
        : '';
    const delTag = r.deleted ? '<i class="usage-bd-tag deleted">已删除</i>' : '';
    const tag = kindTag + delTag;
    const title = r.deleted
      ? `已删除${r.lastModel ? ` · 最后使用 ${r.lastModel}` : ''}${
          r.lastSource ? ` · ${r.lastSource}` : ''
        }`
      : '';
    return `<button class="usage-dim-row clickable usage-bd-row${
      r.deleted ? ' is-deleted' : ''
    }" data-dim="${esc(active)}" data-key="${esc(r.key)}" data-kind="${esc(
      kind
    )}"${title ? ` title="${esc(title)}"` : ''}>
      <span class="usage-bd-name">
        <span class="usage-bd-title"><b title="${esc(r.label)}">${esc(
          r.label
        )}</b>${tag}</span>
        <span>${fmt(r.calls)} 次 · ${usageMoney(r.cost)}${
          r.credits ? ` · ${fmtCredits(r.credits)} 积分${r.creditsEstimated ? '（估算）' : ''}` : ''
        }${
          r.unpriced ? ` · 未定价 ${fmt(r.unpriced)}` : ''
        }${r.deleted && r.lastQuota ? ` · 最后额度 ${esc(r.lastQuota)}` : ''}</span>
      </span>
      <span class="usage-bd-bar"><i style="width:${pct}%"></i></span>
      <span class="usage-bd-total">${fmt(r.total)}</span>
      <span class="usage-bd-go">→</span>
    </button>`;
  };
  const activeRows = rows.filter((r) => !r.deleted);
  const deletedRows = rows.filter((r) => r.deleted);
  const first = activeRows.slice(0, 10);
  const rest = activeRows.slice(10);
  const deletedBlock = deletedRows.length
    ? `<details class="usage-deleted">
        <summary>已删除（${deletedRows.length}）</summary>
        ${deletedRows.map(rowHtml).join('')}
      </details>`
    : '';
  const activeBlock = activeRows.length
    ? first.map(rowHtml).join('') +
      (rest.length
        ? `<details class="usage-more"><summary>查看全部 ${activeRows.length} 项</summary>${rest
            .map(rowHtml)
            .join('')}</details>`
        : '')
    : rows.length
      ? ''
      : '<div class="usage-empty">暂无记录</div>';
  return `<div id="usageBreakdown" class="usage-panel usage-breakdown">
    <div class="usage-breakdown-top">
      <div class="usage-dim-tabs" id="usageDimTabs">
        ${USAGE_DIM_TABS.map(
          (d) =>
            `<button data-usage-dim="${d.id}" class="${
              d.id === active ? 'active' : ''
            }">${d.label}</button>`
        ).join('')}
      </div>
      <span class="usage-breakdown-hint">${rows.length} 项${
        deletedRows.length ? `（含已删除 ${deletedRows.length}）` : ''
      } · 点击任意条目查看模型消耗</span>
    </div>
    <div class="usage-bd-head">
      <span>名称</span><span>占用</span><span>Tokens</span><span></span>
    </div>
    <div class="usage-bd-list">
      ${activeBlock}
      ${deletedBlock}
    </div>
  </div>`;
}

function usageBalanceActions(b) {
  const actions = Array.isArray(b.actions) ? b.actions : [];
  if (!actions.length) return '';
  return `<div class="usage-balance-actions">${actions
    .map((a) => {
      if (a.url) {
        return `<a class="usage-balance-action" href="${esc(
          a.url
        )}" target="_blank" rel="noreferrer">${esc(a.label)} ↗</a>`;
      }
      return `<button class="usage-balance-action" data-balance-action="${esc(
        a.action || ''
      )}" data-provider="${esc(a.provider || '')}" data-app="${esc(
        a.app || ''
      )}">${esc(a.label)}</button>`;
    })
    .join('')}</div>`;
}

const BALANCE_TABS = [
  { id: 'all', label: '全部', match: () => true },
  { id: 'api', label: 'API 余额', match: (b) => b.kind === 'api' },
  { id: 'quota', label: '额度', match: (b) => b.kind === 'quota' },
  { id: 'subscription', label: '订阅', match: (b) => b.kind === 'subscription' },
];

function usageBalanceCard(b) {
  const tag =
    b.kind === 'subscription' ? '订阅' : b.kind === 'quota' ? '额度' : 'API';
  let body = '';
  if (b.kind === 'quota' && b.windows?.length) {
    body = b.windows
      .map(
        (w) => `<div class="usage-quota">
          <span>${esc(w.label)}</span>
          <div class="usage-quota-bar"><i style="width:${Math.min(
            100,
            Math.max(0, Number(w.percent) || 0)
          )}%"></i></div>
          <b>${Number(w.percent) || 0}%</b>
        </div>`
      )
      .join('');
  } else if (b.status === 'ok' && Number.isFinite(Number(b.amount))) {
    body = `<div class="usage-balance-amount">${
      b.currency === 'CNY' ? '¥' : '$'
    }${Number(b.amount).toFixed(2)}</div>`;
  } else if (b.status === 'subscription') {
    body = '<div class="usage-balance-state">订阅制</div>';
  } else if (b.status === 'missing') {
    body = `<div class="usage-balance-state">${
      b.kind === 'quota' ? '未配置' : '无余额接口'
    }</div>`;
  } else if (b.status === 'limited') {
    body = '<div class="usage-balance-state warn">有限流</div>';
  } else {
    body = '<div class="usage-balance-state err">查询失败</div>';
  }
  return `<div class="usage-balance ${esc(b.status || '')}">
    <div class="usage-balance-head"><b>${esc(b.name || '')}</b><span class="usage-tag">${tag}</span></div>
    ${body}
    <div class="usage-balance-detail" title="${esc(b.detail || '')}">${esc(
      b.detail || ''
    )}</div>
    ${usageBalanceActions(b)}
  </div>`;
}

const BALANCE_NOTE =
  '<div class="usage-balance-note">只显示已连接或本机已登录的账号。Claude、WorkBuddy 没有官方剩余额度，只显示订阅状态或按 token 估算的消耗；OpenAI / Anthropic API 不显示余额。ChatGPT / Antigravity 读的是本机 CLI / 本地服务。</div>';

function usageBalancesHtml(balances) {
  if (!balances?.length)
    return `<div class="usage-empty">暂无余额数据</div>${BALANCE_NOTE}`;
  const tabs = BALANCE_TABS.filter(
    (t) => t.id === 'all' || balances.some(t.match)
  );
  const active = tabs.some((t) => t.id === S.usageBalanceTab)
    ? S.usageBalanceTab
    : 'api';
  const tab = tabs.find((t) => t.id === active) || tabs[0];
  const list = balances.filter(tab.match);
  return `<div class="usage-dim-tabs usage-balance-tabs" id="usageBalanceTabs">
      ${tabs
        .map(
          (t) =>
            `<button data-balance-tab="${t.id}" class="${
              t.id === tab.id ? 'active' : ''
            }">${t.label}<i>${
              t.id === 'all' ? balances.length : balances.filter(t.match).length
            }</i></button>`
        )
        .join('')}
    </div>
    <div class="usage-balances">${list.map(usageBalanceCard).join('')}</div>
    ${BALANCE_NOTE}`;
}

function usageConnectHtml(providers) {
  if (!providers?.length) return '';
  return `<details class="usage-connect">
    <summary>连接 API 账号 <span>DeepSeek / Kimi / GLM / MiniMax / MiMo / OpenCode Go / Qoder</span></summary>
    <div class="usage-provider-grid">
      ${providers
        .map(
          (p) => `<label class="usage-provider">
            <span>${esc(p.name)}${p.configured ? ' · 已配置' : ''}</span>
            <input type="password" autocomplete="off" data-provider="${esc(
              p.id
            )}" placeholder="${esc(p.placeholder || 'Key')}" />
          </label>`
        )
        .join('')}
    </div>
    <div class="usage-provider-actions">
      <button class="btn" id="usageSaveProviders">保存连接</button>
      ${
        window.desktop?.mimoLogin
          ? '<button class="btn" id="usageMimoLogin">在 App 内登录 MiMo</button>'
          : ''
      }
      <button class="btn" id="usageSyncMimo">从浏览器读取 MiMo 登录态</button>
      <span class="usage-hint">只保存在本机 data/state.json；留空不会清空已有 Key。读取浏览器登录态需要给 Bot Team「完全磁盘访问权限」；不想授权可直接用「在 App 内登录 MiMo」。</span>
    </div>
  </details>`;
}

async function mimoLoginInApp(button) {
  if (!window.desktop?.mimoLogin) {
    return toast('网页版不支持 App 内登录，请在下方手动粘贴 Cookie', 'err');
  }
  const label = button ? button.textContent : '';
  if (button) {
    button.disabled = true;
    button.textContent = '等待登录…';
  }
  try {
    const cookie = await window.desktop.mimoLogin();
    if (!cookie) throw new Error('没有获取到 MiMo 登录态');
    const r = await api('/api/providers/mimo/cookie', {
      method: 'POST',
      body: { cookie },
    });
    toast(
      `MiMo 登录成功${
        r.balance?.balance ? `，余额 ¥${r.balance.balance}` : ''
      }`
    );
    loadUsageDashboard(true);
  } catch (e) {
    toast(`登录未完成：${apiErrorText(e)}`, 'err');
    if (button) {
      button.disabled = false;
      button.textContent = label;
    }
  }
}

async function syncMimoFromBrowser(button) {
  const label = button ? button.textContent : '';
  if (button) {
    button.disabled = true;
    button.textContent = '读取中…';
  }
  try {
    const r = await api('/api/providers/mimo/sync', { method: 'POST' });
    toast(
      `已读取 ${r.browser || '浏览器'}${r.profile ? ` · ${r.profile}` : ''} 的 MiMo 登录态${
        r.renewed ? '（已自动续期）' : ''
      }`
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    loadUsageDashboard(true);
  } catch (e) {
    toast(`读取失败：${apiErrorText(e)}`, 'err');
    if (button) {
      button.disabled = false;
      button.textContent = label;
    }
  }
}

function usageDashboardHtml(s, providers = []) {
  const t = s.totals || {};
  const today = s.daily?.[s.daily.length - 1] || {};
  const subText = s.includeSubscription ? '已计入合计' : '未计入合计';
  return `<div class="usage-kpis">
    ${usageKpi(
      s.scopeDay ? `${s.scopeDay} 消耗` : `总 Tokens · ${s.days} 天`,
      fmt(t.total),
      s.scopeDay
        ? `${fmt(t.calls)} 次调用 · ${usageMoney(t.cost)}${
            t.credits ? ` · ${fmtCredits(t.credits)} 积分` : ''
          }`
        : `今日 ${fmt(today.total)} · ${fmt(t.calls)} 次调用${
            t.credits ? ` · 累计 ${fmtCredits(t.credits)} 积分` : ''
          }`
    )}
    ${usageKpi(
      '输入 / 输出',
      `${fmt(t.input)}`,
      `${fmt(t.output)} 输出${t.cache ? ` · 缓存 ${fmt(t.cache)}` : ''}`
    )}
    ${usageKpi('API 实付估算', usageMoney(t.apiCost), '按量渠道，估算值')}
    ${usageKpi('订阅折算', usageMoney(t.subCost), subText, s.includeSubscription ? 'accent' : '')}
    ${
      t.credits
        ? usageKpi(
            `积分 · ${s.days} 天`,
            fmtCredits(t.credits),
            `${usageMoney(t.creditCost)}${t.creditsEstimated ? ' · 含估算' : ''}`
          )
        : ''
    }
    ${usageKpi('合计估算', usageMoney(t.cost), 'API + 当前订阅折算')}
  </div>
  <div class="usage-panel usage-chart-panel">
    <div class="usage-panel-head"><b>每日 Token 消耗</b><span>${
      s.scopeDay ? `${s.scopeDay} · 再点一次返回最近 ${s.days} 天` : `最近 ${s.days} 天 · 点击柱子查看单日`
    }</span></div>
    ${usageChart(s.daily || [])}
  </div>
  ${usageBreakdownHtml(s)}
  ${usageConnectHtml(providers)}
  <div class="usage-panel">
    <div class="usage-panel-head"><b>余额与订阅</b><span>只显示已连接或已配置的账号</span></div>
    <div id="usageBalances" class="usage-balances-wrap"><div class="usage-loading">查询余额中…</div></div>
  </div>
  <div class="usage-note">
    ${esc(s.priceNote || '')}
    ${
      s.pricing
        ? ` 价格来源：models.dev${
            s.pricing.updatedAt
              ? `（缓存于 ${new Date(s.pricing.updatedAt).toLocaleDateString('zh-CN')}）`
              : ''
          }，按 1 USD ≈ ¥${s.pricing.usdCny} 折算；DeepSeek 使用官方人民币价。`
        : ''
    }
    ${t.unpriced ? ` 当前周期有 ${fmt(t.unpriced)} tokens 未命中价格表，成本未完整计入。` : ''}
    ${t.backfill ? ' 历史数据来自旧的日汇总，只有 Bot/模型/日期维度；群/项目细分从本次更新后开始完整记录。' : ''}
    ${t.rebuilt ? ' 历史用量已按本机会话与消息记录重建，项目/群聊归属已恢复；同一轮对话中的多个 step 已合并。' : ''}
    ${t.events ? ` 共 ${fmt(t.events)} 条用量记录。` : ''}
  </div>
  <div id="usageDetail" class="usage-detail" hidden></div>`;
}

const USAGE_DIM_NAME = {
  model: '模型',
  backend: 'CLI / 供应商',
  cli: 'CLI / 供应商',
  source: '渠道 / 计费方式',
  bot: 'Bot',
  place: '项目 / 群聊',
  group: '群聊',
  project: '项目',
};

async function openUsageDetail(dim, key) {
  const el = $('#usageDetail');
  if (!el) return;
  el.hidden = false;
  el.innerHTML = '<div class="usage-detail-card"><div class="usage-loading">正在统计模型消耗…</div></div>';
  try {
    const d = await api(
      `/api/usage/detail?days=${S.usageDays}&day=${encodeURIComponent(
        S.usageDay || ''
      )}&dim=${encodeURIComponent(dim)}&key=${encodeURIComponent(key)}&includeSubscription=${
        S.usageSub ? '1' : '0'
      }`
    );
    el.innerHTML = usageDetailHtml(d);
    wireUsageCharts(el);
    el.querySelectorAll('[data-detail-tab]').forEach((btn) => {
      btn.onclick = () => {
        el.querySelectorAll('[data-detail-tab]').forEach((b) =>
          b.classList.toggle('active', b === btn)
        );
        el.querySelectorAll('[data-detail-panel]').forEach((panel) => {
          panel.hidden = panel.dataset.detailPanel !== btn.dataset.detailTab;
        });
      };
    });
    const close = el.querySelector('[data-usage-detail-close]');
    if (close) {
      close.onclick = () => {
        el.hidden = true;
        el.innerHTML = '';
      };
    }
  } catch (e) {
    el.innerHTML = `<div class="usage-detail-card"><div class="usage-empty">统计失败：${esc(
      e.message
    )}</div><div class="usage-detail-actions"><button class="btn" data-usage-detail-close>关闭</button></div></div>`;
    const close = el.querySelector('[data-usage-detail-close]');
    if (close) close.onclick = () => { el.hidden = true; el.innerHTML = ''; };
  }
}

function usageDetailHtml(d) {
  const t = d.totals || {};
  const models = d.models || [];
  const max = Math.max(1, ...models.map((m) => m.total || 0));
  const rows = models.length
    ? models
        .map((m) => {
          const share = t.total ? Math.round(((m.total || 0) / t.total) * 100) : 0;
          const width = Math.max(2, Math.round(((m.total || 0) / max) * 100));
          return `<div class="usage-detail-model">
            <div class="usage-dim-top">
              <span class="usage-dim-label" title="${esc(m.label)}">${esc(m.label)}</span>
              <b>${fmt(m.total)}</b>
            </div>
            <div class="usage-dim-bar"><i style="width:${width}%"></i></div>
            <div class="usage-dim-meta">${share}% · ${fmt(m.calls)} 次 · ${usageMoney(
              m.cost
            )} · 输入 ${fmt(m.input)}${m.cache ? ` / 缓存 ${fmt(m.cache)}` : ''} / 输出 ${fmt(
              m.output
            )}${m.unpriced ? ` · 未定价 ${fmt(m.unpriced)}` : ''}</div>
          </div>`;
        })
        .join('')
    : '<div class="usage-empty">暂无模型记录</div>';
  return `<div class="usage-detail-card">
    <div class="usage-detail-head">
      <div>
        <b>${esc(d.label || d.key)}</b>
        <span>${esc(
          USAGE_PLACE_KINDS[d.kind] || USAGE_DIM_NAME[d.dim] || d.dim
        )} · 近 ${d.days} 天${d.matched ? ` · ${fmt(d.matched)} 条记录` : ''}${
          d.deleted ? ' · 已删除' : ''
        }</span>
      </div>
      <button class="btn" data-usage-detail-close>关闭</button>
    </div>
    <div class="usage-detail-kpis">
      ${usageKpi('Tokens', fmt(t.total), `${fmt(t.calls)} 次调用`)}
      ${usageKpi(
        '成本估算',
        usageMoney(t.cost),
        t.unpriced
          ? `未定价 ${fmt(t.unpriced)}`
          : t.subCost > 0
            ? d.includeSubscription
              ? `含订阅折算 ${usageMoney(t.subCost)}`
              : `订阅 ${usageMoney(t.subCost)} 未折算`
            : '全部已定价'
      )}
      ${usageKpi(
        '输入 / 输出',
        fmt(t.input),
        `${fmt(t.output)} 输出${t.cache ? ` · 缓存 ${fmt(t.cache)}` : ''}`
      )}
      ${
        t.credits
          ? usageKpi('积分', fmtCredits(t.credits), usageMoney(t.creditCost), 'accent')
          : ''
      }
    </div>
    <div class="usage-detail-section usage-detail-breakdown">
      <div class="usage-detail-tabs-row">
        <div class="usage-dim-tabs" id="usageDetailTabs">
          <button data-detail-tab="bot" class="active">按 Bot<i>${
            (d.bots || []).length
          }</i></button>
          <button data-detail-tab="model">按模型<i>${models.length}</i></button>
        </div>
        <span class="usage-breakdown-hint">点击标签切换</span>
      </div>
      <div data-detail-panel="bot">
        ${
          (d.bots || []).length
            ? d.bots
                .map((b) => {
                  const share = t.total
                    ? Math.round(((b.total || 0) / t.total) * 100)
                    : 0;
                  const bmax = Math.max(1, ...(d.bots || []).map((x) => x.total || 0));
                  const width = Math.max(2, Math.round(((b.total || 0) / bmax) * 100));
                  return `<div class="usage-detail-model">
                    <div class="usage-dim-top">
                      <span class="usage-dim-label" title="${esc(b.label)}">${esc(
                        b.label
                      )}</span>
                      <b>${fmt(b.total)}</b>
                    </div>
                    <div class="usage-dim-bar"><i style="width:${width}%"></i></div>
                    <div class="usage-dim-meta">${share}% · ${fmt(b.calls)} 次 · ${usageMoney(
                      b.cost
                    )}${b.credits ? ` · ${fmtCredits(b.credits)} 积分${b.creditsEstimated ? '（估算）' : ''}` : ''}${
                      b.unpriced ? ` · 未定价 ${fmt(b.unpriced)}` : ''
                    }</div>
                  </div>`;
                })
                .join('')
            : '<div class="usage-empty">暂无 Bot 记录</div>'
        }
      </div>
      <div data-detail-panel="model" hidden>${rows}</div>
    </div>
    <div class="usage-detail-section">
      <div class="usage-detail-title"><b>每日趋势</b><span>${fmt(t.total)} tokens</span></div>
      ${usageChart(d.daily || [])}
    </div>
  </div>`;
}

/* ---------------- events ---------------- */

window.addEventListener(
  'scroll',
  () => {
    const tip = document.getElementById('usageChartTip');
    if (tip) tip.hidden = true;
  },
  true
);

/* ---------------- 全局搜索 ---------------- */

function gsEsc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

function gsMark(text, q) {
  const raw = String(text || '');
  const key = String(q || '').trim();
  if (!key) return gsEsc(raw);
  const lower = raw.toLowerCase();
  const needle = key.toLowerCase();
  let out = '';
  let i = 0;
  while (i < raw.length) {
    const at = lower.indexOf(needle, i);
    if (at < 0) {
      out += gsEsc(raw.slice(i));
      break;
    }
    out += gsEsc(raw.slice(i, at)) + '<mark>' + gsEsc(raw.slice(at, at + needle.length)) + '</mark>';
    i = at + needle.length;
  }
  return out;
}

function gsTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

async function openChatAt(chatId, messageId) {
  await openChat(chatId);
  if (!messageId) return;
  const el = document.querySelector(`#thread [data-msg="${messageId}"]`);
  if (!el) return;
  el.scrollIntoView({ block: 'center' });
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 2000);
}

function openGlobalSearch(initial = '') {
  const selected = new Set();
  let kinds = ['message', 'file'];
  let scopeOpen = false;
  let seq = 0;

  const groups = (S.chats || []).filter((c) => c.type === 'group');
  const projectsByBot = new Map();
  for (const c of (S.chats || []).filter((x) => x.type === 'dm')) {
    const botId = c.botIds?.[0];
    if (!botId) continue;
    if (!projectsByBot.has(botId)) projectsByBot.set(botId, []);
    projectsByBot.get(botId).push({ id: c.id, title: c.project || '默认项目' });
  }

  const scopeHtml = () => `
    <div class="gs-scope-actions">
      <button type="button" class="btn ghost" data-scope-all>全选</button>
      <button type="button" class="btn ghost" data-scope-none>清空</button>
      <span class="gs-scope-tip">不选＝搜索全部</span>
    </div>
    <div class="gs-scope-section">群聊</div>
    ${groups
      .map(
        (g) =>
          `<label class="gs-scope-row"><input type="checkbox" data-scope-chat="${esc(g.id)}" ${
            selected.has(g.id) ? 'checked' : ''
          }/><span>${esc(g.title)}</span><em>${(g.botIds || []).length} 位成员</em></label>`
      )
      .join('')}
    <div class="gs-scope-section">Bot 的项目</div>
    ${[...projectsByBot.entries()]
      .map(([botId, list]) => {
        const bot = botById(botId);
        const all = list.every((p) => selected.has(p.id));
        return `<div class="gs-scope-bot">
          <label class="gs-scope-row is-bot">
            <input type="checkbox" data-scope-bot="${esc(botId)}" ${all ? 'checked' : ''}/>
            <span>${esc(bot?.emoji || '🤖')} ${esc(bot?.name || 'Bot')}</span>
            <em>${list.length} 个项目</em>
          </label>
          <div class="gs-scope-projects">
            ${list
              .map(
                (p) =>
                  `<label class="gs-scope-row"><input type="checkbox" data-scope-chat="${esc(
                    p.id
                  )}" ${selected.has(p.id) ? 'checked' : ''}/><span>${esc(p.title)}</span></label>`
              )
              .join('')}
          </div>
        </div>`;
      })
      .join('')}`;

  openModal(
    `<div class="gsearch">
      <div class="gsearch-head">
        <input id="gsInput" placeholder="搜索所有对话和文件…" value="${esc(initial)}" autocomplete="off" spellcheck="false"/>
        <button type="button" class="btn ghost" id="gsScopeBtn">范围${selected.size ? ` · ${selected.size}` : ''}</button>
        <button type="button" class="btn ghost" id="gsClose">关闭</button>
      </div>
      <div class="gsearch-filters">
        <button type="button" class="gs-chip active" data-kind="all">全部</button>
        <button type="button" class="gs-chip" data-kind="message">消息</button>
        <button type="button" class="gs-chip" data-kind="file">文件</button>
        <span class="gs-count" id="gsCount"></span>
      </div>
      <div class="gsearch-scope" id="gsScope" hidden></div>
      <div class="gsearch-results" id="gsResults"><div class="muted" style="padding:16px 4px">输入关键词开始搜索</div></div>
    </div>`,
    'wide'
  );

  const input = $('#gsInput');
  const results = $('#gsResults');
  const scope = $('#gsScope');
  const count = $('#gsCount');
  const scopeBtn = $('#gsScopeBtn');

  const renderScope = () => {
    if (!scope) return;
    scope.innerHTML = scopeHtml();
    if (scopeBtn) scopeBtn.textContent = `范围${selected.size ? ` · ${selected.size}` : ''}`;
  };

  const run = async () => {
    const q = input.value.trim();
    if (!q) {
      results.innerHTML = '<div class="muted" style="padding:16px 4px">输入关键词开始搜索</div>';
      if (count) count.textContent = '';
      return;
    }
    const my = ++seq;
    try {
      const params = new URLSearchParams({ q, kinds: kinds.join(','), limit: '120' });
      if (selected.size) params.set('chats', [...selected].join(','));
      const r = await api(`/api/search?${params.toString()}`);
      if (my !== seq) return;
      const list = r.results || [];
      if (count) count.textContent = `${r.total} 条结果${r.total > list.length ? ` · 显示前 ${list.length} 条` : ''}`;
      if (!list.length) {
        results.innerHTML = '<div class="muted" style="padding:16px 4px">没有找到匹配内容</div>';
        return;
      }
      results.innerHTML = list
        .map((it) => {
          const icon =
            it.kind === 'message' ? '💬' : it.kind === 'groupfile' ? '📎' : it.kind === 'attachment' ? '📄' : '🗂️';
          const who = it.kind === 'message' ? `${esc(it.senderName || '')} · ` : '';
          return `<button type="button" class="gs-result" data-chat="${esc(it.chatId)}" data-msg="${esc(
            it.messageId || ''
          )}">
            <span class="gs-icon">${icon}</span>
            <span class="gs-main">
              <span class="gs-title">${esc(it.chatTitle)}${it.project ? ` · ${esc(it.project)}` : ''}</span>
              <span class="gs-snippet">${who}${gsMark(it.snippet, q)}</span>
            </span>
            <span class="gs-time">${gsTime(it.ts)}</span>
          </button>`;
        })
        .join('');
    } catch (e) {
      if (my === seq) results.innerHTML = `<div class="muted" style="padding:16px 4px">搜索失败：${esc(e.message)}</div>`;
    }
  };

  let timer = null;
  input.oninput = () => {
    clearTimeout(timer);
    timer = setTimeout(run, 260);
  };
  input.focus();
  if (initial.trim()) run();

  $('#gsClose').onclick = closeModal;
  $('#gsScopeBtn').onclick = () => {
    scopeOpen = !scopeOpen;
    scope.hidden = !scopeOpen;
    if (scopeOpen) renderScope();
  };

  document.querySelectorAll('.gs-chip').forEach((chip) => {
    chip.onclick = () => {
      document.querySelectorAll('.gs-chip').forEach((c) => c.classList.toggle('active', c === chip));
      const kind = chip.dataset.kind;
      kinds = kind === 'all' ? ['message', 'file'] : [kind];
      run();
    };
  });

  scope.onclick = (e) => {
    const row = e.target.closest('[data-scope-chat]');
    if (row) {
      if (row.checked) selected.add(row.dataset.scopeChat);
      else selected.delete(row.dataset.scopeChat);
      renderScope();
      run();
      return;
    }
    const botCb = e.target.closest('[data-scope-bot]');
    if (botCb) {
      const list = projectsByBot.get(botCb.dataset.scopeBot) || [];
      if (botCb.checked) list.forEach((p) => selected.add(p.id));
      else list.forEach((p) => selected.delete(p.id));
      renderScope();
      run();
      return;
    }
    if (e.target.closest('[data-scope-all]')) {
      groups.forEach((g) => selected.add(g.id));
      for (const list of projectsByBot.values()) list.forEach((p) => selected.add(p.id));
      renderScope();
      run();
      return;
    }
    if (e.target.closest('[data-scope-none]')) {
      selected.clear();
      renderScope();
      run();
    }
  };

  results.onclick = (e) => {
    const row = e.target.closest('[data-chat]');
    if (!row) return;
    closeModal();
    openChatAt(row.dataset.chat, row.dataset.msg || '');
  };
}

function promptBotGroupName({ title, initial = '', submitText = '确定' }) {
  return new Promise((resolve) => {
    openModal(`
      <h3>${esc(title)}</h3>
      <div class="field">
        <label>分组名称</label>
        <input id="bgModalInput" type="text" maxlength="40" value="${esc(initial)}" placeholder="例如：HOMESTEAD 项目组、日常工具" />
        <div class="field-hint">可随时把左侧 Bot 拖进或拖出分组文件夹；删除分组不会删除成员。</div>
      </div>
      <div class="modal-actions">
        <button class="btn" id="bgModalClose" type="button">取消</button>
        <button class="btn primary" id="bgModalOk" type="button">${esc(submitText)}</button>
      </div>
    `);
    const input = $('#bgModalInput');
    const finish = (val) => {
      closeModal();
      resolve(val);
    };
    $('#bgModalClose').onclick = () => finish(null);
    $('#bgModalOk').onclick = () => finish(input.value.trim());
    input.onkeydown = (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        finish(input.value.trim());
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        finish(null);
      }
    };
    setTimeout(() => {
      input.focus();
      input.select();
    }, 20);
  });
}

function bind() {
  $('#list').addEventListener('click', async (e) => {
    if (e.target.closest('#newBotGroupBtn')) {
      e.stopPropagation();
      const name = await promptBotGroupName({ title: '新建 Bot 分组', submitText: '创建' });
      if (!name) return;
      try {
        const grp = await api('/api/bot-groups', { method: 'POST', body: { name } });
        S.botGroups ||= [];
        if (!S.botGroups.some((g) => g.id === grp.id)) S.botGroups.push(grp);
        renderSidebar();
      } catch (err) {
        toast(`创建分组失败：${err.message}`, 'err');
      }
      return;
    }
    const renameBtn = e.target.closest('[data-folder-rename]');
    if (renameBtn) {
      e.stopPropagation();
      const gid = renameBtn.dataset.folderRename;
      const grp = (S.botGroups || []).find((g) => g.id === gid);
      if (!grp) return;
      const name = await promptBotGroupName({ title: '重命名分组', initial: grp.name, submitText: '保存' });
      if (!name || name === grp.name) return;
      try {
        const updated = await api(`/api/bot-groups/${gid}`, { method: 'PATCH', body: { name } });
        grp.name = updated.name;
        renderSidebar();
      } catch (err) {
        toast(`重命名失败：${err.message}`, 'err');
      }
      return;
    }
    const delBtn = e.target.closest('[data-folder-del]');
    if (delBtn) {
      e.stopPropagation();
      const gid = delBtn.dataset.folderDel;
      const grp = (S.botGroups || []).find((g) => g.id === gid);
      if (!grp || !confirm(`删除分组「${grp.name}」？组内 Bot 不会被删除，将回到未分组列表。`)) return;
      try {
        await api(`/api/bot-groups/${gid}`, { method: 'DELETE' });
        S.botGroups = (S.botGroups || []).filter((g) => g.id !== gid);
        for (const b of S.bots) if (b.groupId === gid) b.groupId = null;
        renderSidebar();
      } catch (err) {
        toast(`删除分组失败：${err.message}`, 'err');
      }
      return;
    }
    const folderToggle = e.target.closest('[data-folder-toggle]');
    if (folderToggle) {
      const gid = folderToggle.dataset.folderToggle;
      const grp = (S.botGroups || []).find((g) => g.id === gid);
      if (!grp) return;
      grp.collapsed = !grp.collapsed;
      renderSidebar();
      api(`/api/bot-groups/${gid}`, { method: 'PATCH', body: { collapsed: grp.collapsed } }).catch(() => {});
      return;
    }
    const edit = e.target.closest('[data-edit]');
    if (edit) {
      e.stopPropagation();
      return editBot(edit.dataset.edit);
    }
    const chatBtn = e.target.closest('[data-chat]');
    if (chatBtn) return openChat(chatBtn.dataset.chat);
    const botBtn = e.target.closest('[data-bot]');
    if (botBtn) return openBot(botBtn.dataset.bot);
  });

  let dragInfo = null;
  const clearDrop = () => {
    document.querySelectorAll('#list .row.drop-target').forEach((r) => r.classList.remove('drop-target'));
    document.querySelectorAll('#list .drop-folder-target').forEach((r) => r.classList.remove('drop-folder-target'));
  };
  $('#list').addEventListener('dragstart', (e) => {
    const row = e.target.closest('[data-drag-type]');
    if (!row) return;
    dragInfo = { type: row.dataset.dragType, id: row.dataset.dragId };
    row.classList.add('dragging');
    if (dragInfo.type === 'bot') $('#list').classList.add('dragging-bot');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragInfo.id);
  });
  $('#list').addEventListener('dragend', () => {
    dragInfo = null;
    $('#list').classList.remove('dragging-bot');
    document.querySelectorAll('#list .row.dragging').forEach((r) => r.classList.remove('dragging'));
    clearDrop();
  });
  $('#list').addEventListener('dragover', (e) => {
    if (!dragInfo) return;
    const row = e.target.closest('[data-drag-type]');
    const folderZone = dragInfo.type === 'bot' ? e.target.closest('[data-drop-folder]') : null;
    if (dragInfo.type === 'bot' && folderZone) {
      const targetGid = folderZone.dataset.dropFolder === '__ungrouped__' ? null : folderZone.dataset.dropFolder;
      const draggedBot = botById(dragInfo.id);
      const sameGroupRow = row && row.dataset.dragType === 'bot' && row.dataset.dragId !== dragInfo.id && (botById(row.dataset.dragId)?.groupId || null) === (draggedBot?.groupId || null);
      if (sameGroupRow && !folderZone.classList.contains('bot-folder-head')) {
        e.preventDefault();
        clearDrop();
        row.classList.add('drop-target');
        return;
      }
      if ((draggedBot?.groupId || null) !== targetGid) {
        e.preventDefault();
        clearDrop();
        const highlightEl = folderZone.closest('.bot-folder') || folderZone;
        highlightEl.classList.add('drop-folder-target');
        return;
      }
    }
    if (!row || row.dataset.dragType !== dragInfo.type) return;
    if (row.dataset.dragId === dragInfo.id) return;
    e.preventDefault();
    clearDrop();
    row.classList.add('drop-target');
  });
  $('#list').addEventListener('drop', async (e) => {
    if (!dragInfo) return;
    const row = e.target.closest('[data-drag-type]');
    const folderZone = dragInfo.type === 'bot' ? e.target.closest('[data-drop-folder]') : null;
    const { type, id } = dragInfo;
    if (type === 'bot' && folderZone) {
      const targetGid = folderZone.dataset.dropFolder === '__ungrouped__' ? null : folderZone.dataset.dropFolder;
      const draggedBot = botById(id);
      const sameGroupRow = row && row.dataset.dragType === 'bot' && row.dataset.dragId !== id && (botById(row.dataset.dragId)?.groupId || null) === (draggedBot?.groupId || null);
      if (!(sameGroupRow && !folderZone.classList.contains('bot-folder-head')) && (draggedBot?.groupId || null) !== targetGid) {
        e.preventDefault();
        clearDrop();
        if (!draggedBot) return;
        draggedBot.groupId = targetGid;
        if (targetGid) {
          const grp = (S.botGroups || []).find((g) => g.id === targetGid);
          if (grp) grp.collapsed = false;
        }
        renderSidebar();
        try {
          await api(`/api/bots/${id}`, { method: 'PATCH', body: { groupId: targetGid } });
        } catch (err) {
          toast(`移动分组失败：${err.message}`, 'err');
        }
        return;
      }
    }
    if (!row || row.dataset.dragType !== type) return;
    e.preventDefault();
    const toId = row.dataset.dragId;
    clearDrop();
    if (id === toId) return;

    const leaderId = S.settings?.leaderId || null;
    const order = S.settings?.order || {};
    const ids =
      type === 'group'
        ? applyOrder(S.chats.filter((c) => c.type === 'group'), order.groups).map((c) => c.id)
        : applyOrder(S.bots.filter((b) => b.id !== leaderId), order.bots).map((b) => b.id);
    const from = ids.indexOf(id);
    const to = ids.indexOf(toId);
    if (from < 0 || to < 0) return;
    ids.splice(from, 1);
    ids.splice(to, 0, id);

    const next = { ...order, [type === 'group' ? 'groups' : 'bots']: ids };
    S.settings.order = next;
    renderSidebar();
    try {
      await api('/api/settings', { method: 'PATCH', body: { order: next } });
    } catch (err) {
      toast(`排序保存失败：${err.message}`, 'err');
    }
  });

  $('#hiddenList').addEventListener('click', (e) => {
    const edit = e.target.closest('[data-edit]');
    if (edit) {
      e.stopPropagation();
      return editBot(edit.dataset.edit);
    }
    const botBtn = e.target.closest('[data-bot]');
    if (botBtn) openBot(botBtn.dataset.bot);
  });

  $('#hiddenToggle').onclick = () => {
    S.hiddenOpen = !S.hiddenOpen;
    renderSidebar();
  };

  $('#selfCard').onclick = () => {
    const lid = S.settings?.leaderId;
    if (lid && botById(lid)) openBot(lid);
  };

  $('#selfMore').onclick = (e) => {
    e.stopPropagation();
    const lid = S.settings?.leaderId;
    if (lid) editBot(lid);
  };

  $('#searchInput').oninput = (e) => {
    S.filter = e.target.value;
    renderSidebar();
  };
  $('#searchInput').onkeydown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const q = e.target.value.trim();
      e.target.value = '';
      S.filter = '';
      renderSidebar();
      openGlobalSearch(q);
    }
  };
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && String(e.key).toLowerCase() === 'k') {
      e.preventDefault();
      openGlobalSearch('');
    }
  });

  $('#newBtn').onclick = (e) => {
    const menu = $('#newMenu');
    const r = e.currentTarget.getBoundingClientRect();
    menu.hidden = false;
    menu.style.left = `${r.right - 168}px`;
    menu.style.top = `${r.bottom + 8}px`;
  };

  $('#newMenu').onclick = (e) => {
    const act = e.target.dataset.act;
    $('#newMenu').hidden = true;
    if (act === 'bot') newBot();
    if (act === 'group') newGroup();
  };

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#newMenu') && !e.target.closest('#newBtn')) $('#newMenu').hidden = true;
    if (!e.target.closest('#effortPop') && !e.target.closest('#effortBtn')) {
      $('#effortPop').hidden = true;
    }
    if (!e.target.closest('#modelPop') && !e.target.closest('#modelBtn')) {
      $('#modelPop').hidden = true;
    }
    if (!e.target.closest('#slashMenu') && !e.target.closest('.composer')) {
      closeSlash();
    }
    if (!e.target.closest('#mentionMenu') && !e.target.closest('.composer')) {
      closeMention();
    }
  });

  let maskArmed = false;
  $('#modalMask').addEventListener('mousedown', (e) => {
    maskArmed = e.target.id === 'modalMask';
  });
  $('#modalMask').onclick = (e) => {
    if (e.target.id === 'modalMask' && maskArmed) {
      // 延后一拍：原生下拉/取色器关闭时可能补发一次 click，先让 change 事件跑完再判断。
      setTimeout(() => requestCloseModal(), 0);
    }
    maskArmed = false;
  };
  $('#modal').addEventListener('input', () => {
    modalDirty = true;
  });
  $('#modal').addEventListener('change', () => {
    modalDirty = true;
  });

  $('#sendBtn').onclick = () => (chatIsBusy() ? stopCurrentTurn() : send());
  const steerBtn = $('#steerBtn');
  if (steerBtn) steerBtn.onclick = () => steerSend();
  $('#input').addEventListener('keydown', (e) => {
    if (mentionOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        moveMention(1);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        moveMention(-1);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        closeMention();
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        if (mentionItems.length) insertMention(mentionItems[mentionIndex]);
        else closeMention();
        return;
      }
    }
    if (slashOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        moveSlash(1);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        moveSlash(-1);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        closeSlash();
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        if (slashItems.length) executeSlash(slashItems[slashIndex]);
        else {
          closeSlash();
          send();
        }
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });
  $('#input').addEventListener('input', (e) => {
    e.target.style.height = 'auto';
    const max = Math.min(420, Math.round(window.innerHeight * 0.42));
    e.target.style.height = `${Math.min(e.target.scrollHeight, max)}px`;
    const chat = activeChat();
    if (chat) {
      if (e.target.value) S.drafts[chat.id] = e.target.value;
      else delete S.drafts[chat.id];
      persistDrafts();
    }
    syncSendState();
    updateSlash();
    updateMention();
  });

  const slashMenu = $('#slashMenu');
  if (slashMenu) {
    slashMenu.addEventListener('mousedown', (e) => e.preventDefault());
    slashMenu.onclick = (e) => {
      const btn = e.target.closest('[data-index]');
      if (!btn) return;
      executeSlash(slashItems[Number(btn.dataset.index)]);
    };
  }
  const attachBtn = $('#attachBtn');
  const attachFile = $('#attachFile');
  if (attachBtn && attachFile) {
    attachBtn.onclick = () => attachFile.click();
    attachFile.onchange = () => {
      attachFiles(attachFile.files);
      attachFile.value = '';
    };
  }
  setupFileDrops();
  bindPasteFiles();
  bindFileCards();
  const attachChips = $('#attachChips');
  if (attachChips)
    attachChips.onclick = (e) => {
      const btn = e.target.closest('[data-remove-attach]');
      if (!btn) return;
      S.pendingAttachments.splice(Number(btn.dataset.removeAttach), 1);
      renderAttachChips();
      syncSendState();
    };

  const mentionMenu = $('#mentionMenu');
  if (mentionMenu) {
    mentionMenu.addEventListener('mousedown', (e) => e.preventDefault());
    mentionMenu.onclick = (e) => {
      const btn = e.target.closest('[data-index]');
      if (!btn) return;
      insertMention(mentionItems[Number(btn.dataset.index)]);
    };
  }
  $('#thread').addEventListener('click', (e) => {
    const av = e.target.closest('.msg > .avatar[data-bot-avatar]');
    if (!av) return;
    const botId = av.dataset.botAvatar;
    if (!botId) return;
    clearTimeout(avatarClickTimer);
    avatarClickTimer = setTimeout(() => {
      avatarClickTimer = null;
      if (botById(botId)) editBot(botId);
    }, 260);
  });
  $('#thread').addEventListener('dblclick', (e) => {
    const av = e.target.closest('.msg > .avatar[data-bot-avatar]');
    if (!av) return;
    clearTimeout(avatarClickTimer);
    avatarClickTimer = null;
    const chat = activeChat();
    const bot = botById(av.dataset.botAvatar);
    if (!bot) return;
    // 群里双击头像仍然是快速 @；私聊/领导头像双击直接打开设置
    if (!chat || chat.type !== 'group' || bot.id === S.settings?.leaderId) {
      e.preventDefault();
      editBot(bot.id);
      return;
    }
    e.preventDefault();
    mentionStart = -1;
    insertMention(bot);
  });
  window.addEventListener('resize', () => {
    closeSlash();
    closeMention();
  });

  $('#effortBtn').onclick = (e) => {
    e.stopPropagation();
    const pop = $('#effortPop');
    if (!pop.hidden) {
      pop.hidden = true;
      return;
    }
    $('#modelPop').hidden = true;
    renderEffort();
    const r = $('#effortBtn').getBoundingClientRect();
    const w = 268;
    pop.hidden = false;
    pop.style.left = `${Math.min(Math.max(12, r.left - 6), window.innerWidth - w - 12)}px`;
    pop.style.bottom = `${Math.max(12, window.innerHeight - r.top + 8)}px`;
  };

  $('#modelBtn').onclick = (e) => {
    e.stopPropagation();
    toggleModelPop();
  };

  $('#modelSearch').oninput = (e) => {
    const bot = composerBot();
    if (bot) renderModelList(bot, e.target.value);
  };

  $('#modelListBox').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-model]');
    if (btn) applyComposerModel(btn.dataset.model);
  });

  $('#effortRange').oninput = (e) => {
    const chat = activeChat();
    if (!chat) return;
    const idx = Math.max(0, Math.min(EFFORTS.length - 1, Number(e.target.value)));
    chat.effort = EFFORTS[idx].key;
    renderEffort();
  };

  $('#effortRange').onchange = async () => {
    const chat = activeChat();
    if (!chat) return;
    try {
      await api(`/api/chats/${chat.id}`, { method: 'PATCH', body: { effort: chat.effort } });
    } catch (err) {
      toast(`保存推理强度失败：${err.message}`, 'err');
    }
  };

  $('#thread').addEventListener('scroll', () => {
    const t = $('#thread');
    $('#scrollDown').hidden = t.scrollHeight - t.scrollTop - t.clientHeight < 120;
    $('#selTools').hidden = true;
  });

  // 记录「进行中思考」卡片的展开状态，重建时不跳回去
  $('#thread').addEventListener('click', (e) => {
    if (e.target.closest('#liveThink summary')) {
      S.liveOpen = !S.liveOpen;
    }
  });

  // 复制 / 引用
  $('#thread').addEventListener('click', (e) => {
    const copy = e.target.closest('[data-copy]');
    if (copy) {
      const m = findMessage(copy.dataset.copy);
      if (m) copyText(m.text);
      return;
    }
    const quote = e.target.closest('[data-quote]');
    if (quote) {
      const m = findMessage(quote.dataset.quote);
      if (m) quoteIntoComposer(m.text);
    }
  });

  // 思考过程折叠状态：重绘后保持用户的选择
  $('#thread').addEventListener('click', (e) => {
    const summary = e.target.closest('summary');
    if (!summary) return;
    const details = summary.parentElement;
    if (!details || details.tagName !== 'DETAILS' || !details.dataset.thinkKey) return;
    const key = details.dataset.thinkKey;
    S.thinkState ||= {};
    S.thinkState[key] = !details.open;
    setTimeout(() => {
      if (details.isConnected) S.thinkState[key] = details.open;
    }, 0);
  });

  let selState = null;
  const hideSelTools = () => {
    $('#selTools').hidden = true;
  };
  const updateSelTools = () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return hideSelTools();
    const range = sel.getRangeAt(0);
    let node = range.commonAncestorContainer;
    if (node.nodeType === 3) node = node.parentElement;
    const bubble = node?.closest?.('.bubble');
    if (!bubble) return hideSelTools();
    const text = sel.toString().trim();
    if (!text) return hideSelTools();
    const msgEl = bubble.closest('[data-msg]');
    selState = { text, msgId: msgEl?.dataset.msg || null };
    const rect = range.getBoundingClientRect();
    const tools = $('#selTools');
    tools.hidden = false;
    tools.style.left = `${Math.min(Math.max(80, rect.left + rect.width / 2), window.innerWidth - 80)}px`;
    tools.style.top = `${Math.max(8, rect.top - 38)}px`;
  };
  document.addEventListener('mouseup', (e) => {
    if (e.target?.closest?.('#selTools')) return;
    setTimeout(updateSelTools, 0);
  });
  document.addEventListener('keyup', (e) => {
    if (e.shiftKey || e.key === 'Shift') setTimeout(updateSelTools, 0);
  });
  $('#selTools').addEventListener('mousedown', (e) => e.preventDefault());
  $('#selQuote').onclick = () => {
    if (!selState) return;
    quoteIntoComposer(selState.text);
    hideSelTools();
    window.getSelection()?.removeAllRanges();
  };
  $('#selCopy').onclick = () => {
    if (!selState) return;
    copyText(selState.text);
    hideSelTools();
  };

  // 内置浏览器 / 文件查看器
  $('#browserClose').onclick = () => setBrowserOpen(false);
  $('#paneTheme').onclick = () =>
    applyPaneTheme(B.theme === 'light' ? 'dark' : 'light');
  $('#paneEdit').onclick = () => startEdit().catch(() => {});
  $('#paneTranslate').onclick = () => {
    if (B.mode === 'file') translatePane().catch(() => {});
    else openTranslateMenu();
  };
  $('#trGo').onclick = () => translateFloat().catch(() => {});
  $('#trExplain').onclick = () => explainFloat().catch(() => {});
  $('#trClose').onclick = () => dismissSelection();
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideTranslateFloat();
  });
  setupSelectionCapture();
  $('#paneBrowserTab').onclick = () => setPaneMode('browser');
  $('#paneFileTab').onclick = () => setPaneMode('file');
  $('#paneOpenFile').onclick = pickLocalFiles;
  $('#paneSwapSide').onclick = () =>
    applyPaneSide(document.body.classList.contains('pane-left') ? 'right' : 'left');
  $('#fileZoomOut').onclick = () => zoomFile(-0.25);
  $('#fileZoomIn').onclick = () => zoomFile(0.25);
  $('#fileZoomLabel').ondblclick = () => {
    B.fileZoom = fitImageZoom();
    applyFileZoom();
  };
  $('#paneMore').onclick = (e) => {
    e.stopPropagation();
    const menu = $('#paneMenu');
    if (menu) menu.hidden = !menu.hidden;
  };
  $('#paneMenu').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-pane-act]');
    if (!btn) return;
    const act = btn.dataset.paneAct;
    const menu = $('#paneMenu');
    if (menu) menu.hidden = true;
    if (act === 'pick') return pickLocalFiles();
    if (act === 'close') return setBrowserOpen(false);
    if (!B.filePath) return;
    if (act === 'reload') return openFileInPane(B.filePath);
    openLocalFile(B.filePath, act === 'reveal' ? 'reveal' : 'open');
  });
  document.addEventListener('click', (e) => {
    const menu = $('#paneMenu');
    if (!menu || menu.hidden) return;
    if (e.target.closest('#paneMenu') || e.target.closest('#paneMore')) return;
    menu.hidden = true;
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const menu = $('#paneMenu');
    if (menu && !menu.hidden) menu.hidden = true;
  });
  setupPaneDrops();
  $('#fileContent').addEventListener('scroll', maybeLoadMoreText, { passive: true });
  $('#browserBack').onclick = () => B.supported && B.view.goBack();
  $('#browserForward').onclick = () => B.supported && B.view.goForward();
  $('#browserReload').onclick = () => B.supported && B.view.reload();
  $('#browserUrl').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      navigateBrowser(e.target.value);
    }
  });
  initBrowserResizer();
  setupMermaidObserver();
  const savedWidth = Number(localStorage.getItem('bt.browser.width') || 0);
  if (savedWidth) B.setPaneWidth?.(savedWidth);
  initBrowser();
  const bootFile = new URLSearchParams(location.search).get('file');
  if (bootFile) setTimeout(() => openFileInPane(bootFile), 250);
  $('#scrollDown').onclick = () => {
    const t = $('#thread');
    t.scrollTo({ top: t.scrollHeight, behavior: 'smooth' });
  };

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const tag = (document.activeElement?.tagName || '').toUpperCase();
      const inField = ['INPUT', 'TEXTAREA', 'SELECT'].includes(tag);
      if (!$('#modalMask').hidden && !inField) requestCloseModal();
      $('#newMenu').hidden = true;
      $('#effortPop').hidden = true;
      $('#modelPop').hidden = true;
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k' && $('#modalMask').hidden) {
      e.preventDefault();
      $('#searchInput').focus();
      $('#searchInput').select();
    }
  });

  $('#todayChip').onclick = openUsageDashboard;
  $('#rolesBtn').onclick = () => openRoles();
  $('#skillsBtn').onclick = openSkills;
  $('#schedulesBtn').onclick = openSchedules;

  $('#gridBtn').onclick = async () => {
    // 先立刻给出反馈，再拉数据，避免点了没反应
    openModal(`<h3>设置 / 状态</h3><div class="usage-loading">正在加载设置…</div>`);
    let data;
    let health;
    try {
      // 模型列表用启动时缓存，不再等 /api/models 扫 CLI；健康检查最多等 1.2 秒
      const healthPromise = api('/api/health').catch(() => ({ cli: {} }));
      [data, health] = await Promise.all([
        api('/api/bootstrap'),
        Promise.race([
          healthPromise,
          new Promise((resolve) => setTimeout(() => resolve({ cli: {} }), 1200)),
        ]),
      ]);
    } catch (e) {
      closeModal();
      toast(`加载设置失败：${e.message}`, 'err');
      return;
    }
    const models = S.models || {};
    S.bots = data.bots;
    S.models = models;
    S.settings = data.settings || S.settings;
    S.flowRulesDefault = data.flowRulesDefault || S.flowRulesDefault;
    S.sources = data.sources || S.sources;

    const key = lastNDays(1)[0];
    const today = S.bots.reduce(
      (acc, b) => {
        const d = (b.usage?.days || {})[key] || {};
        acc.total += d.total || 0;
        acc.calls += d.calls || 0;
        return acc;
      },
      { total: 0, calls: 0 }
    );
    const bySource = {};
    for (const b of S.bots) {
      const d = (b.usage?.days || {})[key] || {};
      const k = b.source || '未设置';
      bySource[k] = (bySource[k] || 0) + (d.total || 0);
    }
    const rows = Object.entries(bySource)
      .filter(([, v]) => v > 0)
      .map(([k, v]) => `<div class="usage-row"><span>${esc(k)}</span><b>${fmt(v)} tokens</b></div>`)
      .join('');

    const cli = health.cli || {};
    const cliRows = [
      ['opencode', 'OpenCode'],
      ['codex', 'Codex'],
      ['agy', 'Antigravity'],
      ['codebuddy', 'WorkBuddy'],
      ['qoder', 'Qoder'],
      ['claude', 'Claude Code'],
    ]
      .map(
        ([k, label]) =>
          `<div class="usage-row"><span>${label}</span><b style="color:${
            cli[k] ? '#8fe3c0' : '#ea9a9a'
          }">${cli[k] ? '✓ 已找到' : '✗ 未找到'}</b></div>`
      )
      .join('');

    openModal(`
      <h3>设置 / 状态</h3>
      <div class="field"><label>领导 Bot</label>
        <select id="leaderSelect">
          <option value="">不设领导</option>
          ${S.bots
            .map(
              (b) =>
                `<option value="${b.id}"${S.settings?.leaderId === b.id ? ' selected' : ''}>${esc(
                  b.emoji
                )} ${esc(botDisplayName(b))}</option>`
            )
            .join('')}
        </select>
        <div class="field-hint">顶部「我」的身份；群聊里你的消息会以它的名义发出。模型在 Bot 设置里换。</div>
      </div>
      <div class="field">
        <label>外观主题与壁纸</label>
        <div class="wall-grid" id="wallGrid">${wallGridHtml()}</div>
        <div class="wallpaper-actions">
          <button type="button" class="btn" id="wallUpload">上传背景图片</button>
          <button type="button" class="btn" id="wallMarket">源仓壁纸市场</button>
          <input type="file" id="wallFile" accept="image/*" hidden />
        </div>
        <label class="check-line" style="margin-top:9px"><input type="checkbox" id="wallToggle" ${
          S.settings?.wallpaper !== false ? 'checked' : ''
        } /> 启用图片壁纸</label>
        <div class="field-hint" id="wallHint">${wallHintText()}</div>
      </div>
      <div class="field">
        <label class="check-line"><input type="checkbox" id="voiceOn" ${
          (S.settings?.voice || DEFAULT_VOICE_UI).enabled !== false ? 'checked' : ''
        } /> 全员亲昵称呼与撒娇语气</label>
        <div class="field" style="margin-top:8px">
          <label>称呼老板为</label>
          <input id="voiceAddress" value="${esc(
            (S.settings?.voice || DEFAULT_VOICE_UI).address
          )}" placeholder="主人 / 哥哥 / 老板" maxlength="20" />
        </div>
        <div class="field">
          <label>语言风格</label>
          <textarea id="voiceStyle" placeholder="描述语气、称呼、撒娇方式">${esc(
            (S.settings?.voice || DEFAULT_VOICE_UI).style
          )}</textarea>
        </div>
        <div class="wallpaper-actions">
          <button type="button" class="btn" id="voiceSave">保存语言风格</button>
          <button type="button" class="btn" id="voiceReset">恢复默认</button>
        </div>
        <div class="field-hint">对所有 Bot 生效，包括知柚。工作内容仍要清楚准确。</div>
      </div>
      <div class="field">
        <label class="check-line"><input type="checkbox" id="soundOn" ${
          S.settings?.notifySound !== false ? 'checked' : ''
        } /> Bot 回复提示音</label>
        <div class="wallpaper-actions">
          <select id="soundPick" style="flex:1;min-width:0">
            <option value="reply"${(S.settings?.sound || 'reply') === 'reply' ? ' selected' : ''}>原始提示音</option>
            <option value="soft"${S.settings?.sound === 'soft' ? ' selected' : ''}>轻柔版</option>
            <option value="chime"${S.settings?.sound === 'chime' ? ' selected' : ''}>清脆双音</option>
          </select>
          <button type="button" class="btn" id="soundPlay">试听</button>
        </div>
        <div class="field-hint">多个 Bot 同时回复时只响一次，不会连续轰炸。</div>
      </div>
      <div class="field">
        <label>流程环节失败自动重试</label>
        <select id="flowRetries">
          ${[
            [0, '不重试'],
            [1, '1 次'],
            [3, '3 次'],
            [5, '5 次'],
            [10, '10 次'],
            [-1, '一直重试（直到成功或手动停止）'],
          ]
            .map(
              ([n, label]) =>
                `<option value="${n}" ${
                  Number(S.settings?.flowRetries ?? 3) === n ? 'selected' : ''
                }>${label}</option>`
            )
            .join('')}
        </select>
        <div class="field-hint">失败后按 5s / 15s / 30s 退避重试，仍失败才中断；中断后点「继续流程」只补失败那一环，已完成的不会重跑。</div>
      </div>
      <div class="field">
        <label>流程单环节时长上限</label>
        <select id="flowNodeMinutes">
          ${[
            [0, '不限'],
            [15, '15 分钟'],
            [30, '30 分钟'],
            [45, '45 分钟'],
            [60, '60 分钟'],
            [90, '90 分钟'],
          ]
            .map(
              ([n, label]) =>
                `<option value="${n}" ${
                  Number(S.settings?.flowNodeMinutes ?? 30) === n ? 'selected' : ''
                }>${label}</option>`
            )
            .join('')}
        </select>
        <div class="field-hint">单个流程环节跑太久会自动中止并写清原因，避免闷头跑一小时才发现没产出。Bot 自己的「单次执行超时」更短时按更短的算。</div>
      </div>
      <div class="field">
        <label class="check-row">
          <input id="autoReportToLeader" type="checkbox" ${
            S.settings?.autoReportToLeader !== false ? 'checked' : ''
          } />
          <span>AI 异常与流程停滞自动汇报给领导 Bot</span>
        </label>
        <div class="field-hint">当成员额度不足、异常停止、连续报错，或流程显示运行中但实际无人干活时，自动私聊通知领导 Bot 协调切换模型或恢复流程。</div>
      </div>
      <div class="field row-2 even">
        <div>
          <label>连续报错触发汇报阈值</label>
          <select id="botErrorThreshold">
            ${[
              [1, '1 次（立即汇报）'],
              [2, '2 次（默认）'],
              [3, '3 次'],
              [5, '5 次'],
              [0, '仅额度与严重停止时汇报'],
            ]
              .map(
                ([n, label]) =>
                  `<option value="${n}" ${
                    Number(S.settings?.botErrorThreshold ?? 2) === n ? 'selected' : ''
                  }>${label}</option>`
              )
              .join('')}
          </select>
        </div>
        <div>
          <label>流程无人干活停滞告警</label>
          <select id="flowStallMinutes">
            ${[
              [2, '2 分钟'],
              [3, '3 分钟（默认）'],
              [5, '5 分钟'],
              [10, '10 分钟'],
              [15, '15 分钟'],
              [0, '关闭停滞检测'],
            ]
              .map(
                ([n, label]) =>
                  `<option value="${n}" ${
                    Number(S.settings?.flowStallMinutes ?? 3) === n ? 'selected' : ''
                  }>${label}</option>`
              )
              .join('')}
          </select>
        </div>
      </div>
      <div class="field">
        <label>积分计费（Qoder / WorkBuddy）</label>
        <div class="field row-2 even">
          <div>
            <label>Qoder 每积分单价（元）</label>
            <input id="creditPriceQoder" type="number" min="0" step="0.001" value="${esc(
              String(S.settings?.creditPlans?.qoder?.pricePerCredit ?? 0.072)
            )}" />
          </div>
          <div>
            <label>WorkBuddy 每积分单价（元）</label>
            <input id="creditPriceCodebuddy" type="number" min="0" step="0.001" value="${esc(
              String(S.settings?.creditPlans?.codebuddy?.pricePerCredit ?? 0.072)
            )}" />
          </div>
        </div>
        <div class="field" style="margin-top:8px">
          <label>WorkBuddy 多少 tokens 记 1 积分</label>
          <input id="creditTokensCodebuddy" type="number" min="0" step="1" value="${esc(
            String(S.settings?.creditPlans?.codebuddy?.tokensPerCredit ?? 31874)
          )}" />
        </div>
        <div class="field-hint">Qoder 直接读取 CLI 返回的真实积分；WorkBuddy 的 CLI 不返回积分，按 token 估算。默认 ¥0.072/积分、31,874 tokens/积分，可改成你的真实套餐。</div>
      </div>
      <div class="field">
        <label class="check-line"><input type="checkbox" id="fastModeOn" ${
          S.settings?.fastMode ? 'checked' : ''
        } /> 极速模式（更快、更省）</label>
        <div class="field-hint">对所有 Bot 生效：推理强度默认降到最低，最近对话、群日志、团队状态、长期记忆都会压缩。需要深推理时临时关掉。</div>
      </div>
      <div class="field">
        <label>翻译目标语言</label>
        <select id="setTranslateTarget">
          ${[
            ['zh-CN', '简体中文'],
            ['zh-TW', '繁体中文'],
            ['en', 'English'],
            ['ja', '日本語'],
            ['ko', '한국어'],
          ]
            .map(
              ([v, label]) =>
                `<option value="${v}" ${
                  (S.settings?.translateTarget || 'zh-CN') === v ? 'selected' : ''
                }>${label}</option>`
            )
            .join('')}
        </select>
        <div class="field-hint">左侧面板的「翻译」按钮和选中浮条都用下面的翻译引擎。</div>
      </div>
      ${engineConfigHtml('tr', S.settings?.translateConfig || {}, true)}
      ${engineConfigHtml('ex', S.settings?.explainConfig || {}, false)}
      <div class="field">
        <label>手机远程</label>
        <div id="remoteBox" class="remote-box"><div class="muted">正在检查…</div></div>
        <div class="wallpaper-actions">
          <button type="button" class="btn" id="remoteStart">开启公网隧道</button>
          <button type="button" class="btn" id="remoteStop">关闭隧道</button>
        </div>
        <label class="check-line" style="margin-top:8px"><input type="checkbox" id="remoteAuto" ${
          S.settings?.remoteAuto ? 'checked' : ''
        } /> 电脑开机后自动开启远程（隧道断了会自动重连）</label>
        <label class="check-line" id="loginItemRow" hidden><input type="checkbox" id="loginItemOn" /> 电脑开机自动启动 Bot Team</label>
        <div class="field-hint">同一 Wi-Fi 用局域网地址；不在同一网络时用 Tailscale 或公网隧道。链接里带访问令牌，别转发给别人。</div>
      </div>
      <div class="field"><label>今日消耗（全部 bot）</label>
        <div class="usage">
          <div class="usage-row"><span>合计</span><b>${fmt(today.total)} tokens · ${today.calls} 次</b></div>
          ${rows || '<div class="usage-row"><span>今天还没有调用</span><b>—</b></div>'}
        </div>
      </div>
      <div class="field"><label>CLI 检测</label>
        <div class="usage">${cliRows}</div>
      </div>
      <div class="field"><label>网络代理</label>
        <input id="proxyInput" value="${esc(S.settings?.proxy || '')}" placeholder="http://127.0.0.1:7897（留空自动检测；填 direct 强制直连）" />
        <div class="field-hint">主进程 API 请求和 CLI 共用；保存后立即生效。SOCKS-only 代理请用 TUN 模式。</div>
      </div>
      <div class="field"><label>可用模型</label>
        <div class="muted">OpenCode ${models.opencode.length} 个 · Antigravity ${
      models.agy.length
    } 个 · Codex ${(models.codex || []).length} 个 · ${
      window.desktop ? `桌面版 Electron ${esc(window.desktop.version)}` : '网页版'
    }</div>
      </div>
      <div class="field"><label>数据目录</label>
        <div class="muted" style="word-break:break-all">${esc(health.dataDir || '—')}</div>
      </div>
      <div class="field"><label>提示</label>
        <div class="muted">输入框里发 /clear 可以清空当前对话和所有 bot 在这个群的会话记忆。用量统计不受影响。</div>
      </div>
      <div class="modal-actions">
        ${window.desktop ? '<button class="btn" id="openData">打开数据文件夹</button>' : ''}
        <button class="btn" id="checkEnv">环境检查</button>
        <button class="btn primary" id="okBtn">好</button>
      </div>`);

    const openData = $('#openData');
    if (openData) openData.onclick = () => window.desktop.openDataDir();
    const checkEnv = $('#checkEnv');
    if (checkEnv)
      checkEnv.onclick = async () => {
        try {
          S.setup = await api('/api/setup/status');
          openWelcome();
        } catch (e) {
          toast(`环境检查失败：${e.message}`, 'err');
        }
      };

    const proxyInput = $('#proxyInput');
    if (proxyInput)
      proxyInput.onchange = async () => {
        try {
          const res = await api('/api/settings', {
            method: 'PATCH',
            body: { proxy: proxyInput.value.trim() },
          });
          S.settings = res.settings;
          toast(res.proxy ? `代理已启用：${res.proxy}` : '当前直连（未启用代理）');
        } catch (e) {
          toast(`代理设置失败：${e.message}`, 'err');
        }
      };

    const leaderSel = $('#leaderSelect');
    if (leaderSel)
      leaderSel.onchange = async () => {
        try {
          const res = await api('/api/settings', {
            method: 'PATCH',
            body: { leaderId: leaderSel.value || null },
          });
          S.settings = res.settings;
          applyWallpaper();
          renderSidebar();
          renderThread();
        } catch (e) {
          toast(`设置领导失败：${e.message}`, 'err');
        }
      };

    const wallToggle = $('#wallToggle');
    if (wallToggle)
      wallToggle.onchange = async () => {
        try {
          const res = await api('/api/settings', {
            method: 'PATCH',
            body: { wallpaper: wallToggle.checked },
          });
          S.settings = res.settings;
          applyWallpaper();
        } catch (e) {
          toast(`设置壁纸失败：${e.message}`, 'err');
          wallToggle.checked = !wallToggle.checked;
        }
      };

    const wallGrid = $('#wallGrid');
    if (wallGrid)
      wallGrid.onclick = async (ev) => {
        const btn = ev.target.closest('[data-wall-theme],[data-wall-file]');
        if (!btn) return;
        const body = { wallpaper: true };
        if (btn.dataset.wallTheme) body.theme = btn.dataset.wallTheme;
        else body.wallpaperFile = btn.dataset.wallFile;
        try {
          const res = await api('/api/settings', { method: 'PATCH', body });
          S.settings = res.settings;
          applyWallpaper();
          refreshWallGrid();
          if (wallToggle) wallToggle.checked = true;
          toast(body.theme === 'light' ? '已换成浅色主题' : body.theme === 'dark' ? '已换成深色主题' : '壁纸已更换');
        } catch (e) {
          toast(`更换壁纸失败：${e.message}`, 'err');
        }
      };

    const wallUpload = $('#wallUpload');
    const wallFile = $('#wallFile');
    if (wallUpload && wallFile) {
      wallUpload.onclick = () => wallFile.click();
      wallFile.onchange = async () => {
        const file = wallFile.files?.[0];
        if (!file) return;
        wallUpload.disabled = true;
        wallUpload.textContent = '上传中…';
        try {
          const url = await uploadImage('wallpaper', file);
          const res = await api('/api/settings', {
            method: 'PATCH',
            body: { wallpaper: true, wallpaperFile: url },
          });
          S.settings = res.settings;
          if (!(S.wallpapers || []).includes(url)) S.wallpapers = [url, ...(S.wallpapers || [])];
          applyWallpaper();
          refreshWallGrid();
          if (wallToggle) wallToggle.checked = true;
          toast('背景图片已更换，已存到本机');
        } catch (e) {
          toast(`上传失败：${e.message}`, 'err');
        } finally {
          wallUpload.disabled = false;
          wallUpload.textContent = '上传背景图片';
          wallFile.value = '';
        }
      };
    }
    const wallMarket = $('#wallMarket');
    if (wallMarket) wallMarket.onclick = () => openMarket('wallpaper');

    const voiceSave = $('#voiceSave');
    const voiceReset = $('#voiceReset');
    const saveVoice = async (voice) => {
      try {
        const res = await api('/api/settings', { method: 'PATCH', body: { voice } });
        S.settings = res.settings;
        toast('语言风格已保存');
      } catch (e) {
        toast(`保存失败：${e.message}`, 'err');
      }
    };
    if (voiceSave)
      voiceSave.onclick = () =>
        saveVoice({
          enabled: $('#voiceOn').checked,
          address: $('#voiceAddress').value.trim(),
          style: $('#voiceStyle').value.trim(),
        });
    if (voiceReset)
      voiceReset.onclick = () => {
        $('#voiceOn').checked = DEFAULT_VOICE_UI.enabled;
        $('#voiceAddress').value = DEFAULT_VOICE_UI.address;
        $('#voiceStyle').value = DEFAULT_VOICE_UI.style;
        saveVoice(DEFAULT_VOICE_UI);
      };

    const flowRetries = $('#flowRetries');
    if (flowRetries)
      flowRetries.onchange = async () => {
        try {
          const res = await api('/api/settings', {
            method: 'PATCH',
            body: { flowRetries: Number(flowRetries.value) },
          });
          S.settings = res.settings;
          toast(`流程失败将自动重试 ${flowRetries.value} 次`);
        } catch (e) {
          toast(`保存失败：${e.message}`, 'err');
        }
      };
    const flowNodeMinutes = $('#flowNodeMinutes');
    if (flowNodeMinutes)
      flowNodeMinutes.onchange = async () => {
        try {
          const res = await api('/api/settings', {
            method: 'PATCH',
            body: { flowNodeMinutes: Number(flowNodeMinutes.value) },
          });
          S.settings = res.settings;
          toast(
            Number(flowNodeMinutes.value) > 0
              ? `单个流程环节最长 ${flowNodeMinutes.value} 分钟`
              : '流程环节不再限制时长'
          );
        } catch (e) {
          toast(`保存失败：${e.message}`, 'err');
        }
      };
    const autoReport = $('#autoReportToLeader');
    if (autoReport)
      autoReport.onchange = async () => {
        try {
          const res = await api('/api/settings', {
            method: 'PATCH',
            body: { autoReportToLeader: !!autoReport.checked },
          });
          S.settings = res.settings;
          toast(
            autoReport.checked
              ? '已开启 AI 异常与流程停滞自动汇报领导'
              : '已关闭自动汇报领导'
          );
        } catch (e) {
          toast(`保存失败：${e.message}`, 'err');
        }
      };
    const botErrSel = $('#botErrorThreshold');
    if (botErrSel)
      botErrSel.onchange = async () => {
        try {
          const val = Number(botErrSel.value);
          const res = await api('/api/settings', {
            method: 'PATCH',
            body: { botErrorThreshold: val },
          });
          S.settings = res.settings;
          toast(val > 0 ? `同一 Bot 连续报错 ${val} 次将自动汇报领导` : '已设置为仅额度与严重停止时汇报');
        } catch (e) {
          toast(`保存失败：${e.message}`, 'err');
        }
      };
    const flowStallSel = $('#flowStallMinutes');
    if (flowStallSel)
      flowStallSel.onchange = async () => {
        try {
          const val = Number(flowStallSel.value);
          const res = await api('/api/settings', {
            method: 'PATCH',
            body: { flowStallMinutes: val },
          });
          S.settings = res.settings;
          toast(val > 0 ? `流程无人干活超过 ${val} 分钟将自动告警领导` : '已关闭流程停滞检测');
        } catch (e) {
          toast(`保存失败：${e.message}`, 'err');
        }
      };
    const creditInputs = ['creditPriceQoder', 'creditPriceCodebuddy', 'creditTokensCodebuddy']
      .map((id) => $(`#${id}`))
      .filter(Boolean);
    if (creditInputs.length) {
      const saveCreditPlans = async () => {
        try {
          const res = await api('/api/settings', {
            method: 'PATCH',
            body: {
              creditPlans: {
                qoder: { pricePerCredit: Number($('#creditPriceQoder')?.value) },
                codebuddy: {
                  pricePerCredit: Number($('#creditPriceCodebuddy')?.value),
                  tokensPerCredit: Number($('#creditTokensCodebuddy')?.value),
                },
              },
            },
          });
          S.settings = res.settings;
          toast('积分单价已保存');
        } catch (e) {
          toast(`保存失败：${e.message}`, 'err');
        }
      };
      for (const input of creditInputs) input.addEventListener('change', saveCreditPlans);
    }
    wireEngineConfig('tr');
    wireEngineConfig('ex');
    const trTarget = $('#setTranslateTarget');
    if (trTarget)
      trTarget.onchange = async () => {
        try {
          const res = await api('/api/settings', {
            method: 'PATCH',
            body: { translateTarget: trTarget.value },
          });
          S.settings = res.settings;
          toast('翻译目标语言已更新');
        } catch (e) {
          toast(`保存失败：${e.message}`, 'err');
        }
      };
    const fastModeOn = $('#fastModeOn');
    if (fastModeOn)
      fastModeOn.onchange = async () => {
        try {
          const res = await api('/api/settings', {
            method: 'PATCH',
            body: { fastMode: fastModeOn.checked },
          });
          S.settings = res.settings;
          toast(fastModeOn.checked ? '已开启极速模式' : '已关闭极速模式');
          renderThread();
        } catch (e) {
          toast(`保存失败：${e.message}`, 'err');
        }
      };
    const soundOn = $('#soundOn');
    const soundPick = $('#soundPick');
    const soundPlay = $('#soundPlay');
    const saveSound = async () => {
      try {
        const res = await api('/api/settings', {
          method: 'PATCH',
          body: { notifySound: soundOn.checked, sound: soundPick.value },
        });
        S.settings = res.settings;
      } catch (e) {
        toast(`保存失败：${e.message}`, 'err');
      }
    };
    if (soundOn) soundOn.onchange = saveSound;
    if (soundPick) soundPick.onchange = saveSound;
    if (soundPlay) soundPlay.onclick = () => playSound(soundPick.value, true);

    const remoteBox = $('#remoteBox');    const remoteStart = $('#remoteStart');
    const remoteStop = $('#remoteStop');
    let remotePoll = null;
    const drawRemote = (st) => {
      if (!remoteBox) return;
      if (!st) {
        remoteBox.innerHTML = '<div class="muted">读取失败</div>';
        return;
      }
      const links = [];
      for (const u of st.localUrls || []) links.push(`<a href="${esc(u)}" target="_blank">局域网打开</a>`);
      if (st.publicMobile) links.push(`<a href="${esc(st.publicMobile)}" target="_blank">公网打开</a>`);
      const tsLinks = (st.tailscaleUrls || []).map(
        (u) => `<a href="${esc(u)}" target="_blank">Tailscale 打开</a>`
      );
      remoteBox.innerHTML = `
        <div class="remote-state">${
          st.running ? '公网隧道：已开启' : st.starting ? '公网隧道：启动中…' : '公网隧道：未开启'
        }</div>
        ${st.error ? `<div class="remote-error">${esc(st.error)}</div>` : ''}
        ${links.length ? `<div class="remote-links">${links.join('')}</div>` : ''}
        <div class="remote-hint">${
          st.tailscaleInstalled
            ? tsLinks.length
              ? `Tailscale 已连接（${esc(st.tailscaleIp)}）：${tsLinks.join('')}`
              : 'Tailscale 已安装但未连接，打开 Tailscale 登录后这里会出现长期可用的地址。'
            : '想在外面随时用：电脑和手机都装 Tailscale 并登录同一账号，就能得到一个固定的私有地址，比临时公网隧道稳定。'
        }</div>
        ${st.token ? `<div class="remote-token"><span>访问令牌</span><code>${esc(
          st.token
        )}</code><button type="button" class="btn" id="remoteCopy">复制</button></div>` : ''}`;
      if (remoteStart) remoteStart.disabled = !!st.running || !!st.starting;
      if (remoteStop) remoteStop.disabled = !st.running && !st.starting;
      const copy = $('#remoteCopy');
      if (copy) copy.onclick = () => copyText(st.token || '');
    };
    const loadRemote = async () => {
      try {
        const st = await api('/api/remote/status');
        drawRemote(st);
        if (st.starting) {
          clearTimeout(remotePoll);
          remotePoll = setTimeout(loadRemote, 1500);
        }
      } catch {
        drawRemote(null);
      }
    };
    if (remoteStart)
      remoteStart.onclick = async () => {
        remoteStart.disabled = true;
        remoteStart.textContent = '启动中…';
        try {
          const st = await api('/api/remote/start', { method: 'POST' });
          drawRemote(st);
          if (st.starting) {
            clearTimeout(remotePoll);
            remotePoll = setTimeout(loadRemote, 1500);
          }
        } catch (e) {
          toast(`启动失败：${e.message}`, 'err');
        } finally {
          remoteStart.textContent = '开启公网隧道';
        }
      };
    if (remoteStop)
      remoteStop.onclick = async () => {
        try {
          const st = await api('/api/remote/stop', { method: 'POST' });
          drawRemote(st);
        } catch (e) {
          toast(`关闭失败：${e.message}`, 'err');
        }
      };
    loadRemote();

    const remoteAuto = $('#remoteAuto');
    if (remoteAuto)
      remoteAuto.onchange = async () => {
        try {
          const st = await api('/api/remote/auto', {
            method: 'POST',
            body: { enabled: remoteAuto.checked },
          });
          S.settings.remoteAuto = remoteAuto.checked;
          drawRemote(st);
          toast(remoteAuto.checked ? '已开启：电脑开着就会自动保持远程可用' : '已关闭自动远程');
        } catch (e) {
          remoteAuto.checked = !remoteAuto.checked;
          toast(`保存失败：${e.message}`, 'err');
        }
      };

    const loginRow = $('#loginItemRow');
    const loginOn = $('#loginItemOn');
    if (loginRow && loginOn && window.desktop?.getLoginItem) {
      loginRow.hidden = false;
      window.desktop
        .getLoginItem()
        .then((on) => {
          loginOn.checked = !!on;
        })
        .catch(() => {});
      loginOn.onchange = async () => {
        const on = await window.desktop.setLoginItem(loginOn.checked).catch(() => null);
        if (on === null) toast('设置失败', 'err');
        else {
          loginOn.checked = !!on;
          toast(on ? '已设置开机自启' : '已取消开机自启');
        }
      };
    }

    $('#okBtn').onclick = closeModal;
  };
}

/* ---------------- built-in browser ---------------- */

/* ---------------- 文件查看器 ---------------- */

const FILE_TEXT_EXTS = new Set(
  'txt md markdown mdx log json jsonl csv tsv yaml yml html htm css scss less js mjs cjs jsx ts tsx py rb go rs java kt kts c h cpp cc hpp cs php pl lua dart vue svelte astro swift m mm sh bash zsh fish ps1 bat sql xml toml ini cfg conf env srt vtt tex r gradle lock plist'.split(
    ' '
  )
);

function fileExt(p) {
  const m = String(p || '').match(/\.([a-zA-Z0-9]+)$/);
  return (m ? m[1] : '').toLowerCase();
}

function fileBase(p) {
  return String(p || '').split('/').pop() || '文件';
}

function fileIconFor(p) {
  const ext = fileExt(p);
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'svg'].includes(ext))
    return '🖼️';
  if (ext === 'pdf') return '📕';
  if (['mp4', 'mov', 'webm', 'm4v'].includes(ext)) return '🎬';
  if (['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg'].includes(ext)) return '🎵';
  if (['md', 'markdown', 'mdx'].includes(ext)) return '📝';
  if (['csv', 'tsv', 'xls', 'xlsx'].includes(ext)) return '📊';
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return '🗜️';
  if (FILE_TEXT_EXTS.has(ext)) return '📄';
  return '📄';
}

function fileRawUrl(p) {
  return `/api/files/raw?path=${encodeURIComponent(p)}`;
}

function fileThumbUrl(p) {
  return `/api/files/thumb?path=${encodeURIComponent(p)}`;
}

function fileKind(p) {
  const ext = fileExt(p);
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'svg'].includes(ext))
    return 'image';
  if (ext === 'pdf') return 'pdf';
  if (['mp4', 'mov', 'webm', 'm4v'].includes(ext)) return 'video';
  if (['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg'].includes(ext)) return 'audio';
  if (['md', 'markdown', 'mdx'].includes(ext)) return 'markdown';
  if (['csv', 'tsv'].includes(ext)) return 'csv';
  if (['json', 'jsonl'].includes(ext)) return 'json';
  if (FILE_TEXT_EXTS.has(ext)) return 'text';
  return 'binary';
}

/* ---------------- 左侧面板主题 / 选中内容 ---------------- */

let mermaidReady = false;

async function enhanceMermaid(root) {
  if (!window.mermaid || !root) return;
  const blocks = [
    ...root.querySelectorAll('pre > code.language-mermaid, pre > code.lang-mermaid'),
  ];
  if (!blocks.length) return;
  const light = !!root.closest('.browser-pane.pane-light');
  try {
    if (!mermaidReady) {
      window.mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: light ? 'default' : 'dark',
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", Arial, sans-serif',
      });
      mermaidReady = true;
    }
  } catch {}
  for (const code of blocks) {
    if (code.dataset.mermaidDone) continue;
    code.dataset.mermaidDone = '1';
    const src = code.textContent || '';
    const host = document.createElement('div');
    host.className = 'mermaid-block';
    const pre = code.parentElement;
    if (pre) pre.replaceWith(host);
    try {
      const id = `btm${Math.random().toString(36).slice(2, 9)}`;
      const { svg } = await window.mermaid.render(id, src);
      host.innerHTML = svg;
    } catch (e) {
      host.innerHTML = `<div class="mermaid-error">图渲染失败：${esc(
        String(e?.message || e)
      )}</div>`;
    }
  }
}

function setupMermaidObserver() {
  const thread = $('#thread');
  if (!thread || !window.MutationObserver) return;
  let timer = 0;
  const mo = new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(() => enhanceMermaid(thread), 260);
  });
  mo.observe(thread, { childList: true, subtree: true });
}

function applyPaneTheme(theme) {
  const value = theme === 'light' ? 'light' : 'dark';
  B.theme = value;
  localStorage.setItem('bt.pane.theme', value);
  const pane = $('#browserPane');
  if (pane) pane.classList.toggle('pane-light', value === 'light');
  const btn = $('#paneTheme');
  if (btn) btn.title = value === 'light' ? '切换到暗色主题' : '切换到亮色主题';
  if (B.supported && B.view) {
    try {
      B.view.executeJavaScript(
        `(() => {
          document.documentElement.style.colorScheme=${JSON.stringify(value)};
          if (location.pathname.endsWith('/start.html')) {
            document.documentElement.classList.toggle('light', ${value === 'light'});
          }
          return true;
        })()`,
        false
      );
    } catch {}
  }
}

function shortSelectionText(text, max = 500) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function selectionSuggestions(sel) {
  const text = sel?.text || '';
  if (sel?.img && !text) {
    return ['解释这张图', '提取图中的文字', '这张图有什么值得注意的', '可视化地讲解这张图'];
  }
  const code =
    /```|\bfunction\b|\bconst\b|\blet\b|\bimport\b|\bdef\b|\bclass\b|SELECT\s|<div|npm |pip |=>/.test(
      text
    );
  if (code) {
    return ['解释这段代码', '帮我检查这段代码有没有问题', '用大白话讲解这段代码', '这段代码可能有什么坑'];
  }
  const english = /[A-Za-z]{4,}/.test(text) && !/[\u4e00-\u9fff]/.test(text);
  const out = ['解释一下这个', '用最通俗的大白话讲解这段内容', '可视化的给我讲解这段内容'];
  if (english) out.push('翻译成中文');
  else if (text.length > 200) out.push('用三句话总结这段内容');
  else out.push('总结要点');
  return out;
}

function renderSelectionTray() {
  const tray = $('#selectionTray');
  if (!tray) return;
  const sel = S.selection;
  if (!sel || (!sel.text && !sel.img)) {
    tray.hidden = true;
    return;
  }
  tray.hidden = false;
  const tr = $('#selTranslation');
  if (tr) {
    tr.hidden = true;
    tr.textContent = '';
  }
  const source = $('#selSource');
  if (source) {
    source.textContent = sel.source || '选中内容';
    source.title = sel.url || sel.title || '';
  }
  const preview = $('#selPreview');
  if (preview) {
    const img = sel.img
      ? `<img src="${esc(sel.img)}" alt="" loading="lazy" />`
      : '';
    const text = sel.text ? `<div class="sel-text">${esc(shortSelectionText(sel.text, 700))}</div>` : '';
    preview.innerHTML = `${img}${text || '<div class="sel-text">（图片）</div>'}`;
  }
  const box = $('#selSuggestions');
  if (box) {
    box.innerHTML = selectionSuggestions(sel)
      .map((q) => `<button type="button" data-sel-q="${esc(q)}">${esc(q)}</button>`)
      .join('');
  }
}

function setPaneSelection(sel) {
  if (!sel || (!sel.text && !sel.img)) return;
  const key = [
    sel.source || '',
    sel.url || '',
    sel.img || '',
    String(sel.text || '').slice(0, 240),
  ].join('|');
  if (key === S.dismissedKey && Date.now() - (S.dismissedAt || 0) < 900) return;
  S.dismissedKey = '';
  // 同一个选区反复轮询时不要重绘浮条，否则刚翻译好的卡片会被重置
  if (key === S.selectionKey) return;
  S.dismissedKey = '';
  S.selectionKey = key;
  S.selection = sel;
  renderSelectionTray();
  showTranslateFloat(sel);
}

function clearPaneSelection() {
  S.selection = null;
  S.selectionKey = '';
  renderSelectionTray();
  hideTranslateFloat();
}

function hideTranslateFloat() {
  const box = $('#trFloat');
  if (box) box.hidden = true;
  S.trSel = null;
}

function dismissSelection() {
  S.dismissedKey = S.selectionKey;
  S.dismissedAt = Date.now();
  S.selection = null;
  S.selectionKey = '';
  try {
    window.getSelection()?.removeAllRanges();
  } catch {}
  if (B.supported && B.mode === 'browser' && B.view) {
    try {
      B.view.executeJavaScript('window.getSelection().removeAllRanges(); true', false);
    } catch {}
  }
  renderSelectionTray();
  hideTranslateFloat();
}

function showTranslateFloat(sel) {
  const box = $('#trFloat');
  if (!box || !sel?.text?.trim()) return;
  S.trSel = sel;
  const src = $('#trSrc');
  if (src) src.textContent = String(sel.text || '').slice(0, 1200);
  const dst = $('#trDst');
  if (dst) {
    dst.textContent = '';
    dst.classList.remove('loading');
  }
  const card = $('#trCard');
  if (card) card.hidden = true;
  const kind = $('#trKind');
  if (kind) kind.hidden = true;
  box.hidden = false;
  const r = sel.rect || {
    left: window.innerWidth / 2 - 200,
    top: window.innerHeight / 2,
    width: 0,
    height: 0,
  };
  const w = Math.min(400, window.innerWidth - 24);
  const left = Math.min(Math.max(8, r.left), window.innerWidth - w - 8);
  let top = r.top - 54;
  if (top < 8) top = r.top + (r.height || 0) + 10;
  box.style.width = `${w}px`;
  box.style.left = `${left}px`;
  box.style.top = `${top}px`;
}

async function translateFloat() {
  const sel = S.trSel;
  if (!sel?.text?.trim()) return;
  const card = $('#trCard');
  const dst = $('#trDst');
  if (!card || !dst) return;
  const kind = $('#trKind');
  if (kind) kind.hidden = true;
  card.hidden = false;
  dst.classList.add('loading');
  dst.textContent = '翻译中…';
  try {
    const [text] = await translateApi([sel.text]);
    dst.classList.remove('loading');
    dst.textContent = text || '没有拿到译文';
  } catch (e) {
    dst.classList.remove('loading');
    dst.textContent = `翻译失败：${apiErrorText(e)}`;
  }
}

async function explainFloat() {
  const sel = S.trSel;
  if (!sel?.text?.trim()) return;
  const card = $('#trCard');
  const dst = $('#trDst');
  if (!card || !dst) return;
  const kind = $('#trKind');
  if (kind) kind.hidden = false;
  card.hidden = false;
  dst.classList.add('loading');
  dst.textContent = '解释中…';
  try {
    const r = await api('/api/explain', {
      method: 'POST',
      body: { text: sel.text },
    });
    dst.classList.remove('loading');
    dst.textContent = r.text || '没有拿到解释';
  } catch (e) {
    dst.classList.remove('loading');
    dst.textContent = `解释失败：${apiErrorText(e)}`;
  }
}

async function translateApi(texts) {
  const r = await api('/api/translate', { method: 'POST', body: { texts } });
  return r.translations || [];
}

function insertFileTranslation(block, text) {
  if (!block || !block.isConnected || !text) return;
  const inside = ['LI', 'TD', 'TH', 'DD', 'DT', 'FIGCAPTION', 'SUMMARY'].includes(block.tagName);
  if (inside) {
    let d = block.querySelector(':scope > .bt-translation');
    if (!d) {
      d = document.createElement('div');
      d.className = 'bt-translation';
      block.appendChild(d);
    }
    d.textContent = text;
    return;
  }
  let next = block.nextElementSibling;
  if (!next || !next.classList?.contains('bt-translation')) {
    next = document.createElement('div');
    next.className = 'bt-translation';
    block.after(next);
  }
  next.textContent = text;
}

async function translateSelection() {
  const sel = S.selection;
  if (!sel?.text?.trim()) {
    toast('先在左侧选中一段文字', 'err');
    return;
  }
  if (S.translating) return;
  S.translating = true;
  const btn = $('#selTranslate');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '翻译中…';
  }
  try {
    const [text] = await translateApi([sel.text]);
    const box = $('#selTranslation');
    if (box) {
      box.textContent = text || '没有拿到译文';
      box.hidden = false;
    }
    if (text && B.mode === 'file') insertFileTranslation(sel.blockEl, text);
  } catch (e) {
    toast(`翻译失败：${apiErrorText(e)}`, 'err');
  } finally {
    S.translating = false;
    if (btn) {
      btn.disabled = false;
      btn.textContent = '翻译选中内容';
    }
  }
}

function translationBlocks(root) {
  const selector =
    '.fv-markdown p, .fv-markdown li, .fv-docx p, .fv-docx li, .fv-prose p, .fv-markdown h1, .fv-markdown h2, .fv-markdown h3, .fv-markdown h4, .fv-docx h1, .fv-docx h2, .fv-docx h3, .fv-prose h3, .fv-prose h4, .fv-docx td, .fv-markdown td';
  return [...root.querySelectorAll(selector)].filter((el) => {
    if (el.closest('.bt-translation')) return false;
    if (el.closest('pre, code')) return false;
    const t = el.textContent.trim();
    return t.length >= 2 && t.length <= 2000;
  });
}

async function translateFilePage() {
  const content = $('#fileContent');
  if (!content) return;
  const existing = [...content.querySelectorAll('.bt-translation')];
  if (existing.length) {
    existing.forEach((el) => el.remove());
    toast('已隐藏译文');
    return;
  }
  if (!content.querySelector('.fv-markdown, .fv-docx, .fv-prose')) {
    toast('这个文件暂不支持整页翻译，可以选中文字后翻译', 'err');
    return;
  }
  const blocks = translationBlocks(content).slice(0, 300);
  if (!blocks.length) {
    toast('没有找到可翻译的段落', 'err');
    return;
  }
  const tip = toast(`正在翻译 ${blocks.length} 段，请稍候…`, '', 120000);
  const texts = blocks.map((b) => b.textContent.trim());
  try {
    for (let i = 0; i < texts.length; i += 40) {
      const part = texts.slice(i, i + 40);
      const out = await translateApi(part);
      out.forEach((t, idx) => insertFileTranslation(blocks[i + idx], t));
      tip.textContent = `正在翻译 ${Math.min(i + 40, texts.length)}/${texts.length} 段…`;
    }
  } catch (e) {
    tip?.remove();
    toast(`翻译失败：${apiErrorText(e)}`, 'err');
    return;
  }
  tip?.remove();
  toast('整页翻译完成');
}

/* ---------------- 页面翻译（注入式，参考沉浸式翻译的段落/队列模型） ---------------- */

const PAGE_TR_KEY = 'bt.pageTranslate.settings';
const PAGE_TR_DEFAULTS = { area: 'main', display: 'dual', startMode: 'immediate' };
let pageTrLast = null;

function pageTrSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem(PAGE_TR_KEY) || '{}');
    return {
      area: raw.area === 'body' ? 'body' : 'main',
      display: raw.display === 'translation' ? 'translation' : 'dual',
      startMode: raw.startMode === 'dynamic' ? 'dynamic' : 'immediate',
    };
  } catch {
    return { ...PAGE_TR_DEFAULTS };
  }
}

function savePageTrSettings(settings) {
  try {
    localStorage.setItem(PAGE_TR_KEY, JSON.stringify(settings));
  } catch {}
}

let pageTranslatorCode = '';
async function ensurePageTranslator() {
  if (!B.supported || !B.view) throw new Error('内置浏览器不可用');
  if (!pageTranslatorCode) {
    const res = await fetch('/page-translator.js', { cache: 'no-store' });
    if (!res.ok) throw new Error('加载页面翻译器失败');
    pageTranslatorCode = await res.text();
  }
  await B.view.executeJavaScript(`${pageTranslatorCode}\n;true`, false);
}

function execPage(code) {
  if (!B.supported || !B.view) return Promise.reject(new Error('内置浏览器不可用'));
  return B.view.executeJavaScript(code, false);
}

function pageTrMenu() {
  return document.querySelector('#btTrMenu');
}

function ensurePageTrMenu() {
  let menu = pageTrMenu();
  if (menu) return menu;
  menu = document.createElement('div');
  menu.id = 'btTrMenu';
  menu.className = 'bt-tr-menu';
  menu.hidden = true;
  menu.innerHTML = `
    <div class="bt-tr-head">页面翻译</div>
    <div class="bt-tr-row"><span>范围</span><div class="bt-tr-seg" data-key="area">
      <button type="button" data-v="main">正文</button><button type="button" data-v="body">整页</button>
    </div></div>
    <div class="bt-tr-row"><span>显示</span><div class="bt-tr-seg" data-key="display">
      <button type="button" data-v="dual">双语</button><button type="button" data-v="translation">仅译文</button>
    </div></div>
    <div class="bt-tr-row"><span>启动</span><div class="bt-tr-seg" data-key="startMode">
      <button type="button" data-v="immediate">立即</button><button type="button" data-v="dynamic">随滚动</button>
    </div></div>
    <div class="bt-tr-status" id="btTrStatus">未开始</div>
    <div class="bt-tr-actions">
      <button type="button" class="btn primary" id="btTrStart">开始翻译</button>
      <button type="button" class="btn" id="btTrStop" hidden>停止</button>
      <button type="button" class="btn" id="btTrRetry" hidden>重试失败</button>
      <button type="button" class="btn" id="btTrRestore">清除译文</button>
    </div>
    <div class="bt-tr-hint">正文只翻 article / main；整页翻整个 body。立即不等滚动，随滚动进入视口才翻。</div>`;
  document.body.appendChild(menu);

  const close = (ev) => {
    if (menu.hidden) return;
    if (menu.contains(ev.target) || ev.target.closest?.('#paneTranslate')) return;
    menu.hidden = true;
    document.removeEventListener('pointerdown', close, true);
  };

  menu.addEventListener('click', async (ev) => {
    const seg = ev.target.closest('.bt-tr-seg button');
    if (seg) {
      const key = seg.parentElement.dataset.key;
      const settings = pageTrSettings();
      if (S.pageTr?.active && key !== 'display') {
        toast('翻译进行中，先停止或清除后再改范围/启动方式');
        return;
      }
      settings[key] = seg.dataset.v;
      savePageTrSettings(settings);
      if (key === 'display') {
        try {
          await execPage(
            `window.__BT_TRANSLATOR__?.setDisplay(${JSON.stringify(settings.display)})`
          );
        } catch {}
      }
      renderPageTrMenu();
      return;
    }
    if (ev.target.closest('#btTrStart')) {
      startPageTranslation(pageTrSettings()).catch((e) =>
        toast(`开始翻译失败：${e.message || e}`, 'err')
      );
    } else if (ev.target.closest('#btTrStop')) {
      stopPageTranslation('已停止翻译，已翻内容保留');
    } else if (ev.target.closest('#btTrRetry')) {
      retryPageTranslation();
    } else if (ev.target.closest('#btTrRestore')) {
      restorePageTranslation();
    }
  });

  menu._close = close;
  return menu;
}

function openTranslateMenu() {
  const menu = ensurePageTrMenu();
  if (!menu.hidden) {
    menu.hidden = true;
    document.removeEventListener('pointerdown', menu._close, true);
    return;
  }
  renderPageTrMenu();
  const btn = $('#paneTranslate');
  const rect = btn.getBoundingClientRect();
  menu.hidden = false;
  menu.style.top = `${Math.round(rect.bottom + 8)}px`;
  menu.style.right = `${Math.max(8, Math.round(window.innerWidth - rect.right))}px`;
  menu.style.left = 'auto';
  setTimeout(() => document.addEventListener('pointerdown', menu._close, true), 0);
}

function pageTrStatusText(st, finished) {
  if (!st) return '';
  const total = st.total || 0;
  const done = st.done || 0;
  const failed = st.failed || 0;
  const pending = Math.max(0, total - done - failed);
  if (!total) return '等待页面内容…（页面加载完会自动开始）';
  if (pending === 0 && (finished || st.queued === 0)) {
    return `已完成 ${done} / ${total} 段${failed ? ` · 失败 ${failed}` : ''} · 继续监听新内容`;
  }
  return `已翻译 ${done} / ${total} 段 · 待翻 ${pending}${
    failed ? ` · 失败 ${failed}` : ''
  }${st.startMode === 'dynamic' ? ' · 滚动继续' : ''}`;
}

function renderPageTrMenu() {
  const menu = pageTrMenu();
  if (!menu) return;
  const settings = pageTrSettings();
  for (const seg of menu.querySelectorAll('.bt-tr-seg')) {
    const key = seg.dataset.key;
    for (const b of seg.children) {
      b.classList.toggle('on', b.dataset.v === settings[key]);
      b.disabled = !!S.pageTr?.active && key !== 'display';
    }
  }
  const active = !!S.pageTr?.active;
  const start = menu.querySelector('#btTrStart');
  const stop = menu.querySelector('#btTrStop');
  const retry = menu.querySelector('#btTrRetry');
  const last = pageTrLast;
  if (start) start.hidden = active;
  if (stop) stop.hidden = !active;
  if (retry) retry.hidden = !((S.pageTr?.stats?.failed || 0) > 0 || (last?.failed || 0) > 0);
  const status = menu.querySelector('#btTrStatus');
  if (status) {
    if (active && S.pageTr?.stats) {
      status.textContent = pageTrStatusText(S.pageTr.stats, S.pageTr.finished);
    } else if (last) {
      status.textContent = `上次翻译：已翻 ${last.done || 0} / ${last.total || 0} 段${
        last.failed ? ` · 失败 ${last.failed} 段，可点“重试失败”` : ''
      }`;
    } else {
      status.textContent = `未开始 · 当前：${
        settings.area === 'main' ? '正文' : '整页'
      } / ${settings.display === 'dual' ? '双语' : '仅译文'} / ${
        settings.startMode === 'immediate' ? '立即' : '随滚动'
      }`;
    }
  }
}

function updatePageTrStatus(st) {
  if (S.pageTr) S.pageTr.stats = st;
  const menu = pageTrMenu();
  const el = menu?.querySelector('#btTrStatus');
  if (!el) return;
  if (!st) return;
  el.textContent = pageTrStatusText(st, S.pageTr?.finished);
  const retry = menu?.querySelector('#btTrRetry');
  if (retry) retry.hidden = !(st.failed > 0);
}

async function startPageTranslation(settings) {
  if (S.pageTr?.active) return;
  pageTrLast = null;
  savePageTrSettings(settings);
  await ensurePageTranslator();
  const res = await execPage(
    `window.__BT_TRANSLATOR__.start(${JSON.stringify(settings)})`
  );
  if (!res?.ok) {
    toast(res?.error || '没有找到可翻译的段落', 'err');
    return;
  }
  S.pageTr = {
    active: true,
    timer: 0,
    failures: 0,
    finished: false,
    idleTicks: 0,
    stats: res,
    settings,
  };
  renderPageTrMenu();
  updatePageTrStatus(res);
  const menu = pageTrMenu();
  if (menu) menu.hidden = true;
  pumpPageTranslation();
  toast(
    res.total
      ? `开始翻译 ${res.total} 段${res.truncated ? '（页面较长，最多 800 段）' : ''}`
      : '等待页面内容…加载完会自动翻译',
    '',
    3500
  );
}

function stopPageTranslation(message, isError = false) {
  const tr = S.pageTr;
  if (tr) tr.active = false;
  if (tr?.stats) pageTrLast = { ...tr.stats, at: Date.now() };
  if (tr?.timer) clearTimeout(tr.timer);
  S.pageTr = null;
  renderPageTrMenu();
  if (message) toast(message, isError ? 'err' : '');
}

async function pumpPageTranslation() {
  const tr = S.pageTr;
  if (!tr?.active) return;
  tr.timer = 0;
  let delay = 800;
  try {
    const batch = await execPage(
      'window.__BT_TRANSLATOR__ ? window.__BT_TRANSLATOR__.takeQueue(20) : []'
    );
    if (Array.isArray(batch) && batch.length) {
      delay = 160;
      let out = [];
      try {
        out = await translateApi(batch.map((x) => x.text));
        const missingIdx = out
          .map((t, i) => (String(t || '').trim() ? -1 : i))
          .filter((i) => i >= 0);
        if (missingIdx.length) {
          await new Promise((r) => setTimeout(r, 600));
          try {
            const again = await translateApi(missingIdx.map((i) => batch[i].text));
            again.forEach((t, j) => {
              if (String(t || '').trim()) out[missingIdx[j]] = t;
            });
          } catch {}
        }
      } catch (e) {
        await execPage(
          `window.__BT_TRANSLATOR__.fail(${JSON.stringify(
            batch.map((x) => x.id)
          )}, ${JSON.stringify(String(e.message || e))})`
        );
        tr.failures += 1;
        if (tr.failures >= 3) throw e;
        tr.timer = setTimeout(pumpPageTranslation, 1500);
        return;
      }
      const ok = [];
      const missing = [];
      batch.forEach((b, i) => {
        const text = String(out[i] || '').trim();
        if (text) ok.push({ id: b.id, text });
        else missing.push(b.id);
      });
      if (ok.length) {
        await execPage(`window.__BT_TRANSLATOR__.apply(${JSON.stringify(ok)})`);
      }
      if (missing.length) {
        await execPage(
          `window.__BT_TRANSLATOR__.fail(${JSON.stringify(
            missing
          )}, '翻译接口没有返回内容')`
        );
      }
      tr.failures = 0;
    }
    const st = await execPage(
      'window.__BT_TRANSLATOR__ ? window.__BT_TRANSLATOR__.status() : null'
    );
    if (!st?.active) {
      stopPageTranslation('页面翻译已结束');
      return;
    }
    const idle = st.total - st.done - st.failed <= 0 && !st.queued;
    if (idle) {
      delay = 1500;
      tr.idleTicks = (tr.idleTicks || 0) + 1;
      if (!tr.finished && st.total > 0) {
        tr.finished = true;
        toast(
          `翻译完成 · ${st.done} 段${st.failed ? `，失败 ${st.failed} 段` : ''}（新内容会自动继续翻译）`,
          '',
          4000
        );
      }
      // 页面内容晚渲染 / 站点重渲染会删掉译文；定期重扫补回
      if (tr.idleTicks % 2 === 0) {
        try {
          await execPage('window.__BT_TRANSLATOR__?.rescan()');
        } catch {}
      }
    } else {
      tr.finished = false;
      tr.idleTicks = 0;
    }
    updatePageTrStatus(st);
    tr.timer = setTimeout(pumpPageTranslation, delay);
  } catch (e) {
    tr.failures += 1;
    if (tr.failures >= 3) {
      stopPageTranslation(`翻译中断：${e.message || e}`, true);
      return;
    }
    tr.timer = setTimeout(pumpPageTranslation, 1200);
  }
}

async function retryPageTranslation() {
  try {
    const res = await execPage(
      'window.__BT_TRANSLATOR__ ? window.__BT_TRANSLATOR__.retry() : null'
    );
    if (!res) {
      toast('页面里没有翻译器，先开始一次翻译', 'err');
      return;
    }
    if (!S.pageTr) {
      S.pageTr = {
        active: true,
        timer: 0,
        failures: 0,
        finished: false,
        idleTicks: 0,
        stats: res,
        settings: pageTrSettings(),
      };
    } else {
      S.pageTr.finished = false;
      S.pageTr.idleTicks = 0;
    }
    updatePageTrStatus(res);
    renderPageTrMenu();
    pumpPageTranslation();
  } catch (e) {
    toast(`重试失败：${e.message || e}`, 'err');
  }
}

async function restorePageTranslation() {
  stopPageTranslation();
  pageTrLast = null;
  try {
    await execPage(
      'window.__BT_TRANSLATOR__ ? window.__BT_TRANSLATOR__.restore() : null'
    );
  } catch {}
  renderPageTrMenu();
  toast('已清除页面译文');
}

function resetPageTranslationOnNavigate() {
  if (!S.pageTr) return;
  S.pageTr.active = false;
  if (S.pageTr.timer) clearTimeout(S.pageTr.timer);
  S.pageTr = null;
  pageTrLast = null;
  renderPageTrMenu();
}

async function translatePane() {
  if (S.translating) return;
  if (B.mode !== 'file') {
    openTranslateMenu();
    return;
  }
  if (S.selection?.text?.trim()) return translateFloat();
  S.translating = true;
  try {
    await translateFilePage();
  } finally {
    S.translating = false;
  }
}


function selectionContextText(sel) {
  if (!sel) return '';
  const lines = String(sel.text || '')
    .split('\n')
    .slice(0, 80)
    .map((line) => `> ${line}`)
    .join('\n');
  const image =
    sel.img && !sel.img.startsWith('data:') ? `> [选中图片] ${sel.img}` : sel.img ? '> [选中图片]' : '';
  const source = sel.url ? `> 来源：${sel.url}` : '';
  return [lines, image, source].filter(Boolean).join('\n');
}

async function buildPaneContext() {
  if (!B.open) return '';
  if (B.mode === 'file' && B.filePath) {
    const meta = B.fileMeta;
    const lines = [`路径：${B.filePath}`];
    lines.push(
      B.editing
        ? '编辑状态：正在编辑（可用 editor_read / editor_apply 直接修改编辑器内容）'
        : '编辑状态：预览（用户还没进入编辑模式）'
    );
    if (meta?.size) lines.push(`大小：${fmtSize(meta.size)}`);
    try {
      const r = await api(
        `/api/files/text?path=${encodeURIComponent(B.filePath)}&max=6000`
      );
      if (r.pages) lines.push(`页数：${r.pages}`);
      if (r.text) lines.push('', '内容摘录：', String(r.text).slice(0, 6000));
    } catch {}
    return `【当前打开的文件】\n${lines.join('\n')}`;
  }
  if (B.mode === 'browser' && B.supported && B.view) {
    let url = '';
    try {
      url = B.view.getURL();
    } catch {}
    let title = '';
    let text = '';
    try {
      const info = await B.view.executeJavaScript(
        `({ title: document.title, text: String(document.body?.innerText || '').slice(0, 6000) })`,
        false
      );
      title = info?.title || '';
      text = info?.text || '';
    } catch {}
    return [
      '【当前浏览器页面】',
      title ? `标题：${title}` : '',
      url ? `URL：${url}` : '',
      text ? `\n正文摘录：\n${text}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function askAboutSelection(question) {
  const sel = S.selection;
  if (!sel) return;
  const input = $('#input');
  if (!input) return;
  S.pendingSelection = selectionContextText(sel);
  input.value = question;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  S.suppressPaneContextOnce = true;
  clearPaneSelection();
  send();
}

function setupSelectionCapture() {
  let fileTimer = 0;
  // 只有点在文件内容里取消选中才清空；点聊天输入框、点别处都保留引用
  let pointerInFile = false;
  let selecting = false;
  document.addEventListener(
    'pointerdown',
    (e) => {
      pointerInFile = !!e.target.closest('#fileContent');
      selecting = true;
    },
    true
  );
  document.addEventListener(
    'pointerup',
    () => {
      selecting = false;
      setTimeout(readFileSelection, 80);
    },
    true
  );
  const readFileSelection = () => {
    if (!B.open || B.mode !== 'file') return;
    // 拖拽选中的过程中不更新卡片，等松手再一次性出现，PDF 里不会抖
    if (selecting) return;
    const content = $('#fileContent');
    const sel = window.getSelection();
    if (!content || !sel || sel.isCollapsed || !sel.rangeCount) {
      if (pointerInFile && S.selection?.source?.startsWith('文件')) clearPaneSelection();
      return;
    }
    const range = sel.getRangeAt(0);
    if (!content.contains(range.commonAncestorContainer)) {
      if (pointerInFile && S.selection?.source?.startsWith('文件')) clearPaneSelection();
      return;
    }
    const text = String(sel).trim();
    let img = '';
    const selRect = range.getBoundingClientRect();
    const anchor = sel.anchorNode;
    const el = anchor && (anchor.nodeType === 1 ? anchor : anchor.parentElement);
    const found = el?.closest?.('img');
    if (found) img = found.currentSrc || found.src || '';
    if (!img) {
      const frag = range.cloneContents();
      const im = frag.querySelector?.('img');
      if (im) img = im.currentSrc || im.src || '';
    }
    if (!text && !img) return;
    const name = B.filePath ? B.filePath.split('/').pop() : '文件';
    const anchorEl =
      el && el.nodeType === 1 ? el : el?.parentElement || range.startContainer?.parentElement || null;
    const blockEl =
      anchorEl?.closest?.('p,li,h1,h2,h3,h4,h5,h6,td,dd,blockquote') || null;
    setPaneSelection({
      source: `文件 · ${name}`,
      text,
      img,
      url: B.filePath || '',
      blockEl,
      rect: { left: selRect.left, top: selRect.top, width: selRect.width, height: selRect.height },
    });
  };
  document.addEventListener('selectionchange', () => {
    clearTimeout(fileTimer);
    // 选中过程中 PDF 文字层会持续触发 selectionchange，稍微防抖一下，避免卡片抖动
    fileTimer = setTimeout(readFileSelection, 240);
  });
  // 文件查看器里直接点图片，也可以把它作为选中内容
  document.addEventListener('click', (e) => {
    if (!B.open || B.mode !== 'file') return;
    const img = e.target.closest('#fileContent img');
    if (!img) return;
    const name = B.filePath ? B.filePath.split('/').pop() : '文件';
    setPaneSelection({
      source: `文件 · ${name}`,
      text: '',
      img: img.currentSrc || img.src || '',
      url: B.filePath || '',
    });
  });

  // webview 里的选中无法直接监听事件，轻量轮询读取选区
  let browserSelText = '';
  setInterval(async () => {
    if (!B.supported || !B.open || B.mode !== 'browser') return;
    if (!B.view || typeof B.view.executeJavaScript !== 'function') return;
    try {
      const r = await B.view.executeJavaScript(
        `(() => {
          const s = window.getSelection();
          const text = s ? String(s).trim() : '';
          let img = '';
          if (s && s.rangeCount) {
            const n = s.anchorNode;
            const el = n && (n.nodeType === 1 ? n : n.parentElement);
            const im = el && el.closest ? el.closest('img') : null;
            if (im) img = im.currentSrc || im.src || '';
            if (!img) {
              const frag = s.getRangeAt(0).cloneContents();
              const im2 = frag.querySelector ? frag.querySelector('img') : null;
              if (im2) img = im2.currentSrc || im2.src || '';
            }
          }
          let rect = null;
          try {
            const rr = s.getRangeAt(0).getBoundingClientRect();
            rect = { x: rr.x, y: rr.y, w: rr.width, h: rr.height };
          } catch {}
          return { text, img, title: document.title, url: location.href, rect };
        })()`,
        false
      );
      if (!r || (!r.text && !r.img)) {
        browserSelText = '';
        if (S.selection?.source?.startsWith('浏览器')) clearPaneSelection();
        return;
      }
      if (r.text === browserSelText && !r.img) return;
      browserSelText = r.text;
      let rect = null;
      if (r.rect) {
        try {
          const wr = B.view.getBoundingClientRect();
          rect = {
            left: wr.left + r.rect.x,
            top: wr.top + r.rect.y,
            width: r.rect.w,
            height: r.rect.h,
          };
        } catch {}
      }
      setPaneSelection({
        source: `浏览器 · ${shortSelectionText(r.title || '', 40) || '页面'}`,
        text: r.text,
        img: r.img,
        title: r.title,
        url: r.url,
        rect,
      });
    } catch {}
  }, 750);

  const tray = $('#selectionTray');
  if (tray) {
    tray.addEventListener('click', (e) => {
      const chip = e.target.closest('[data-sel-q]');
      if (chip) {
        askAboutSelection(chip.dataset.selQ);
        return;
      }
      if (e.target.closest('#selClose')) dismissSelection();
    });
  }
}

function updateChatCompact() {
  const pane = $('#browserPane');
  const main = document.querySelector('.main');
  if (!pane || !main) return;
  const compact =
    !pane.hidden && main.getBoundingClientRect().width < pane.getBoundingClientRect().width / 2;
  document.body.classList.toggle('chat-compact', compact);
}

let compactRaf = 0;
function scheduleChatCompact() {
  if (compactRaf) return;
  compactRaf = requestAnimationFrame(() => {
    compactRaf = 0;
    updateChatCompact();
  });
}

function applyPaneSide(side) {
  const left = side === 'left';
  document.body.classList.toggle('pane-left', left);
  localStorage.setItem('bt.pane.side', left ? 'left' : 'right');
  $('#paneSwapSide')?.classList.toggle('swapped', left);
  scheduleChatCompact();
}

function setPaneMode(mode) {
  B.mode = mode === 'file' ? 'file' : 'browser';
  localStorage.setItem('bt.pane.mode', B.mode);
  const isFile = B.mode === 'file';
  $('#paneBrowserTab')?.classList.toggle('active', !isFile);
  $('#paneFileTab')?.classList.toggle('active', isFile);
  const nav = $('#browserNavGroup');
  if (nav) nav.hidden = isFile;
  const title = $('#paneFileTitle');
  if (title) title.hidden = !isFile;
  const fv = $('#fileViewer');
  if (fv) fv.hidden = !isFile;
  const view = document.querySelector('#browserView');
  if (view) view.style.display = isFile ? 'none' : '';
  $('#browserPane')?.classList.toggle('file-mode', isFile);
  if (isFile && B.filePath) startFileWatch(B.filePath);
  else stopFileWatch();
  const more = $('#paneMore');
  if (more) more.hidden = !isFile;
  const menu = $('#paneMenu');
  if (menu) menu.hidden = true;
  const openLabel = $('#paneOpenLabel');
  if (openLabel) openLabel.textContent = isFile ? '换文件' : '文件';
  const zoom = $('#paneZoom');
  if (zoom && !isFile) zoom.hidden = true;
  if (isFile && !B.filePath) renderFileEmpty();
}

function renderFileEmpty() {
  stopFileWatch();
  updateEditButton(false);
  teardownVideo();
  teardownPdf();
  const head = $('#fileHead');
  if (head) head.hidden = true;
  const zoomBar = $('#paneZoom');
  if (zoomBar) zoomBar.hidden = true;
  const title = $('#paneFileTitle');
  if (title) title.hidden = false;
  const name = $('#paneFileName');
  if (name) name.textContent = '文件查看器';
  const icon = $('#paneFileIcon');
  if (icon) icon.textContent = '📂';
  const content = $('#fileContent');
  if (!content) return;
  content.innerHTML = `<div class="fv-empty" id="fvDropZone">
    <div class="fv-empty-icon">📂</div>
    <div class="fv-empty-title">把文件拖进来，或者从本机选择</div>
    <div class="fv-empty-sub">图片、PDF、文本、代码、Markdown、JSON、CSV、音视频、Office 文档都能打开</div>
    <button type="button" class="btn primary" id="fvPickBtn">选择文件</button>
    <div class="fv-empty-types">也可以点右上角的「换文件」；文件不会上传，只在本机读取</div>
  </div>`;
  $('#fvPickBtn').onclick = (e) => {
    e.stopPropagation();
    pickLocalFiles();
  };
  $('#fvDropZone').onclick = (e) => {
    if (e.target.closest('button')) return;
    pickLocalFiles();
  };
}

async function pickLocalFiles() {
  if (window.desktop?.pickFiles) {
    const paths = await window.desktop.pickFiles();
    if (paths?.length) {
      if (paths.length > 1) toast(`先打开第一个，共选择了 ${paths.length} 个文件`);
      openFileInPane(paths[0]);
    }
    return;
  }
  toast('桌面版才能按路径打开本地文件', 'err');
}

function droppedFilePath(file) {
  if (!file) return '';
  try {
    const p = window.desktop?.getPathForFile?.(file);
    if (p) return p;
  } catch {}
  return file.path || '';
}

let fileWatchTimer = 0;

function stopFileWatch() {
  if (fileWatchTimer) {
    clearInterval(fileWatchTimer);
    fileWatchTimer = 0;
  }
}

async function refreshOpenFilePreview() {
  if (!B.open || B.mode !== 'file' || !B.filePath || B.editing || B.fileRefreshing) return;
  const p = B.filePath;
  const kind = fileKind(p);
  if (kind === 'pdf' || kind === 'video' || kind === 'audio') return;
  const content = $('#fileContent');
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed && content?.contains(sel.anchorNode)) return;
  let s;
  try {
    s = await api(`/api/files/stat?path=${encodeURIComponent(p)}`);
  } catch {
    return;
  }
  if (!s?.exists || !s.mtime) return;
  const prev = Number(B.fileMeta?.mtime) || 0;
  if (prev && Math.abs(Number(s.mtime) - prev) < 2) return;
  B.fileRefreshing = true;
  const scrollTop = content?.scrollTop || 0;
  const scrollLeft = content?.scrollLeft || 0;
  try {
    B.fileMeta = { ...(B.fileMeta || {}), ...s };
    await renderFile(p, B.fileMeta);
    const fresh = $('#fileContent');
    if (fresh) {
      fresh.scrollTop = scrollTop;
      fresh.scrollLeft = scrollLeft;
    }
    toast('文件已更新');
  } catch {
  } finally {
    B.fileRefreshing = false;
  }
}

function startFileWatch(p) {
  stopFileWatch();
  const target = String(p || '');
  if (!target) return;
  fileWatchTimer = setInterval(() => {
    if (!B.open || B.mode !== 'file' || B.filePath !== target) {
      stopFileWatch();
      return;
    }
    void refreshOpenFilePreview();
  }, 1500);
}

async function openFileInPane(filePath) {
  const p = String(filePath || '').trim();
  if (!p) return;
  if (B.editing) {
    if (B.editDirty && !confirm('有未保存的编辑，确定离开？')) return;
    exitEditMode();
  }
  teardownVideo();
  teardownPdf();
  clearPaneSelection();
  if (!B.open) setBrowserOpen(true);
  setPaneMode('file');
  B.filePath = p;
  B.fileMeta = null;
  B.fileZoom = 1;
  const icon = $('#paneFileIcon');
  if (icon) icon.textContent = fileIconFor(p);
  const name = $('#paneFileName');
  if (name) name.textContent = fileBase(p);
  const head = $('#fileHead');
  if (head) head.hidden = true;
  const content = $('#fileContent');
  if (content) {
    content.scrollTop = 0;
    content.innerHTML = '<div class="fv-loading"><span class="fv-spinner"></span>正在读取文件…</div>';
  }
  try {
    const r = await api('/api/files/check', { method: 'POST', body: { paths: [p] } });
    const meta = r.files?.[0];
    if (!meta?.exists) throw new Error('文件不存在或没有权限读取');
    if (meta.isDir) throw new Error('这是一个目录，请直接拖入文件');
    B.fileMeta = meta;
    await renderFile(p, meta);
    startFileWatch(p);
  } catch (e) {
    if (content) {
      content.innerHTML = `<div class="fv-error">
        <div class="fv-empty-icon">⚠️</div>
        <div class="fv-empty-title">打不开这个文件</div>
        <div class="fv-empty-sub">${esc(String(e?.message || e))}</div>
        <div class="fv-path">${esc(p)}</div>
      </div>`;
    }
  }
}

async function readFileText(p) {
  const res = await fetch(fileRawUrl(p), { cache: 'no-store' });
  if (!res.ok) throw new Error(`读取失败（HTTP ${res.status}）`);
  return await res.text();
}

function renderCsvTable(text, delim) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length && rows.length < 400; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delim) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (ch !== '\r') cell += ch;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  const body = rows
    .slice(0, 300)
    .map(
      (r, i) =>
        `<tr class="${i === 0 ? 'fv-tr-head' : ''}">${r
          .slice(0, 24)
          .map((c) => `<td>${esc(c)}</td>`)
          .join('')}</tr>`
    )
    .join('');
  return `<div class="fv-table-wrap"><table class="fv-table">${body}</table></div>`;
}

function clampSheet(ws) {
  if (!ws || !ws['!ref'] || !window.XLSX) return ws;
  const rng = window.XLSX.utils.decode_range(ws['!ref']);
  const maxR = Math.min(rng.e.r, 1500);
  const maxC = Math.min(rng.e.c, 60);
  if (maxR === rng.e.r && maxC === rng.e.c) return ws;
  const out = {};
  for (let R = 0; R <= maxR; R += 1) {
    for (let C = 0; C <= maxC; C += 1) {
      const addr = window.XLSX.utils.encode_cell({ r: R, c: C });
      if (ws[addr]) out[addr] = ws[addr];
    }
  }
  out['!ref'] = window.XLSX.utils.encode_range({
    s: { r: 0, c: 0 },
    e: { r: maxR, c: maxC },
  });
  if (ws['!merges']) {
    out['!merges'] = ws['!merges'].filter((m) => m.e.r <= maxR && m.e.c <= maxC);
  }
  if (ws['!cols']) out['!cols'] = ws['!cols'].slice(0, maxC + 1);
  return out;
}

function renderXlsx(wb, content, filePath) {
  const names = wb.SheetNames || [];
  content.innerHTML = `
    <div class="xlsx-view">
      <div class="xlsx-bar">
        ${
          names.length > 1
            ? `<div class="xlsx-tabs">${names
                .map(
                  (n, i) =>
                    `<button type="button" data-sheet="${i}" class="${
                      i === 0 ? 'active' : ''
                    }">${esc(n)}</button>`
                )
                .join('')}</div>`
            : `<span class="xlsx-name">${esc(names[0] || '工作表')}</span>`
        }
        <span class="xlsx-flex"></span>
        <button type="button" class="link-btn" id="xlsxOpen">用默认应用打开</button>
      </div>
      <div class="xlsx-body" id="xlsxBody"></div>
    </div>`;
  const body = $('#xlsxBody');
  const openBtn = $('#xlsxOpen');
  if (openBtn) openBtn.onclick = () => openLocalFile(filePath, 'open');
  const renderSheet = (index) => {
    const ws = wb.Sheets[names[index]];
    if (!ws) {
      body.innerHTML = '<div class="fv-empty-sub">这个工作表是空的</div>';
      return;
    }
    let html = '';
    try {
      html = window.XLSX.utils.sheet_to_html(clampSheet(ws), {
        header: '',
        footer: '',
      });
    } catch (e) {
      body.innerHTML = `<div class="fv-empty-sub">${esc(String(e.message || e))}</div>`;
      return;
    }
    body.innerHTML = `<div class="fv-sheet-scroll"><div class="fv-sheet">${html}</div></div>`;
    body.scrollTop = 0;
  };
  content.querySelectorAll('[data-sheet]').forEach((btn) => {
    btn.onclick = () => {
      content
        .querySelectorAll('[data-sheet]')
        .forEach((b) => b.classList.toggle('active', b === btn));
      renderSheet(Number(btn.dataset.sheet));
    };
  });
  renderSheet(0);
}

let pdfView = null;

function teardownPdf() {
  if (!pdfView) return;
  try {
    pdfView.observer?.disconnect();
  } catch {}
  try {
    pdfView.doc?.destroy();
  } catch {}
  pdfView = null;
}

async function loadPdfjs() {
  if (!B.pdfjs) {
    const mod = await import('/vendor/pdfjs/pdf.min.mjs');
    mod.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
    B.pdfjs = mod;
  }
  return B.pdfjs;
}

function setPdfEditStatus(extra = '') {
  const el = $('#pdfEditStatus');
  if (!el) return;
  const count = (B.pdfEditData?.pages || []).reduce(
    (n, page) => n + (page.blocks || []).filter((block) => block.dirty).length,
    0
  );
  el.textContent = [count ? `${count} 处修改` : '', extra].filter(Boolean).join(' · ');
}

function attachPdfEditOverlays(holder, st, pageData) {
  if (!B.editing || B.officeKind !== 'pdf' || !pageData || !holder) return;
  const old = holder.querySelector('.pdf-edit-layer');
  if (old) old.remove();
  const layer = document.createElement('div');
  layer.className = 'pdf-edit-layer';
  (pageData.blocks || []).forEach((block, index) => {
    const bbox = block.bbox || [];
    if (bbox.length !== 4 || !bbox.every((v) => Number.isFinite(Number(v)))) return;
    const [x0, y0, x1, y1] = bbox.map(Number);
    const box = document.createElement('div');
    box.className = 'pdf-edit-box';
    box.contentEditable = 'true';
    box.spellcheck = false;
    box.dataset.block = String(index);
    box.textContent = block.text || '';
    box.style.left = `${(x0 / pageData.width) * 100}%`;
    box.style.top = `${(y0 / pageData.height) * 100}%`;
    box.style.width = 'auto';
    box.style.minWidth = `${((Math.max(1, x1 - x0) * 1.04) / pageData.width) * 100}%`;
    box.style.maxWidth = `${((Math.max(1, pageData.width - x0)) / pageData.width) * 100}%`;
    box.style.height = `${((Math.max(1, y1 - y0) * 1.18) / pageData.height) * 100}%`;
    box.style.fontSize = `${Math.max(
      6,
      ((Number(block.fontsize) || 10) * holder.clientHeight * 0.96) / Math.max(1, pageData.height)
    )}px`;
    box.addEventListener('input', () => {
      block.text = String(box.innerText || '').replace(/\u00a0/g, ' ');
      block.dirty = true;
      B.editDirty = true;
      setPdfEditStatus();
    });
    layer.appendChild(box);
  });
  holder.appendChild(layer);
}

async function reloadPdfEditor() {
  if (!B.editing || B.officeKind !== 'pdf' || !B.filePath) return;
  const page = pdfView?.current || 1;
  const factor = pdfView?.factor || 1;
  const data = await api(`/api/office/pdf/read?path=${encodeURIComponent(B.filePath)}`);
  B.pdfEditData = data;
  B.editMtime = Number(data.mtime) || B.editMtime;
  B.editDirty = false;
  for (const p of data.pages || []) {
    for (const block of p.blocks || []) block.dirty = false;
  }
  await renderFile(B.filePath, B.fileMeta || { ext: 'pdf' });
  if (pdfView?.setFactor) pdfView.setFactor(factor);
  if (pdfView?.goTo) pdfView.goTo(page);
  setPdfEditStatus();
}

async function savePdfEdit() {
  if (!B.editing || B.officeKind !== 'pdf') return;
  const updates = [];
  for (const page of B.pdfEditData?.pages || []) {
    for (const block of page.blocks || []) {
      if (!block.dirty) continue;
      updates.push({
        page: page.index,
        bbox: block.bbox,
        text: block.text || '',
        fontsize: block.fontsize || 10,
        color: block.color || 0,
        font: block.font || '',
      });
    }
  }
  if (!updates.length) {
    toast('没有修改');
    return;
  }
  if (!B.editPdfWarned) {
    if (
      !confirm(
        'PDF 的文字是绘制出来的，保存会把修改的文字在原位置擦除并重新写入；字体、间距可能有细微差异，表格线会尽量保留。继续？'
      )
    ) {
      return;
    }
    B.editPdfWarned = true;
  }
  const btn = $('#pdfEditSave');
  if (btn) btn.disabled = true;
  setPdfEditStatus('保存中…');
  try {
    const r = await api('/api/office/pdf/write', {
      method: 'POST',
      body: { path: B.filePath, updates, mtime: B.editMtime },
    });
    B.editMtime = Number(r.mtime) || B.editMtime;
    B.editDirty = false;
    await reloadPdfEditor();
    toast('PDF 已保存');
  } catch (e) {
    if (/409/.test(String(e.message))) {
      const s = await api(`/api/files/stat?path=${encodeURIComponent(B.filePath)}`).catch(() => null);
      if (s?.mtime) B.editMtime = s.mtime;
      toast('文件已被其他程序改过，按保存再试一次', 'err');
    } else {
      toast(`保存失败：${apiErrorText(e)}`, 'err');
    }
    setPdfEditStatus();
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function startPdfEdit(p) {
  if (B.editing) return;
  let data;
  try {
    data = await api(`/api/office/pdf/read?path=${encodeURIComponent(p)}`);
  } catch (e) {
    toast(`读取 PDF 失败：${apiErrorText(e)}`, 'err');
    return;
  }
  B.editing = true;
  B.editDirty = false;
  B.editOffice = true;
  B.officeKind = 'pdf';
  B.editPdf = true;
  B.pdfEditData = data;
  B.editMtime = Number(data.mtime) || Number(B.fileMeta?.mtime) || 0;
  B.editSave = () => savePdfEdit();
  try {
    await renderFile(p, B.fileMeta || { ext: 'pdf' });
  } catch (e) {
    B.editing = false;
    B.editOffice = false;
    B.officeKind = '';
    B.editPdf = false;
    toast(`打开 PDF 编辑失败：${apiErrorText(e)}`, 'err');
    return;
  }
  void registerEditorSession();
  ensureEditKeyHandler();
  startEditorWatch();
}

async function renderPdfViewer(p, content) {
  teardownPdf();
  content.innerHTML = `
    <div class="pdf-view">
      <div class="pdf-bar">
        <div class="pdf-group">
          <button type="button" id="pdfPrev" title="上一页" aria-label="上一页">‹</button>
          <span class="pdf-pageinfo" id="pdfPageInfo">– / –</span>
          <button type="button" id="pdfNext" title="下一页" aria-label="下一页">›</button>
        </div>
        <div class="pdf-group">
          <button type="button" id="pdfZoomOut" title="缩小">−</button>
          <span class="pdf-zoominfo" id="pdfZoomInfo">100%</span>
          <button type="button" id="pdfZoomIn" title="放大">＋</button>
          <button type="button" class="pdf-fit" id="pdfFit" title="适应宽度">适宽</button>
        </div>
        <span class="pdf-flex"></span>
        ${
          B.editing && B.officeKind === 'pdf'
            ? `<div class="pdf-group pdf-edit-actions"><button type="button" id="pdfEditSave">保存</button><button type="button" id="pdfEditCancel">取消</button><span class="pdf-edit-status" id="pdfEditStatus"></span></div>`
            : ''
        }
        <button type="button" id="pdfExternal" title="用默认应用打开" aria-label="用默认应用打开">↗</button>
      </div>
      <div class="pdf-scroll" id="pdfScroll">
        <div class="pdf-loading"><span class="fv-spinner"></span><span>正在加载 PDF…</span></div>
        <div class="pdf-pages" id="pdfPages" hidden></div>
      </div>
    </div>`;
  const scrollEl = $('#pdfScroll');
  const pagesEl = $('#pdfPages');
  const info = $('#pdfPageInfo');
  const zoomInfo = $('#pdfZoomInfo');
  const loading = content.querySelector('.pdf-loading');

  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({
    url: fileRawUrl(p),
    cMapUrl: '/vendor/pdfjs/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: '/vendor/pdfjs/standard_fonts/',
    iccUrl: '/vendor/pdfjs/iccs/',
  }).promise;
  if (B.filePath !== p) {
    try { doc.destroy(); } catch {}
    return;
  }

  const first = await doc.getPage(1);
  const base = first.getViewport({ scale: 1 });
  const st = {
    doc,
    pagesEl,
    scrollEl,
    pointerDown: false,
    baseW: base.width,
    baseH: base.height,
    scale: 1,
    fit: 1,
    factor: 1,
    rendered: new Map(),
    pending: new Set(),
    queue: [],
    active: 0,
    current: 1,
    gen: 0,
  };
  pdfView = st;

  const computeFit = () => {
    const avail = Math.max(280, scrollEl.clientWidth - 48);
    st.fit = avail / st.baseW;
    st.scale = st.fit * st.factor;
  };
  computeFit();

  for (let i = 1; i <= doc.numPages; i += 1) {
    const holder = document.createElement('div');
    holder.className = 'pdf-page';
    holder.dataset.page = String(i);
    pagesEl.appendChild(holder);
  }
  const holders = [...pagesEl.children];

  const layout = () => {
    const w = Math.floor(st.baseW * st.scale);
    const h = Math.floor(st.baseH * st.scale);
    for (const holder of holders) {
      holder.style.width = `${w}px`;
      holder.style.height = `${h}px`;
    }
  };
  layout();

  const renderOne = async (n) => {
    const holder = holders[n - 1];
    if (!holder) return;
    // 正在拖选时不要替换 DOM，否则选区会突然跳几行
    if (st.pointerDown) return;
    const gen = st.gen;
    const page = await doc.getPage(n);
    if (gen !== st.gen) return;
    const vp = page.getViewport({ scale: st.scale });
    holder.style.width = `${Math.floor(vp.width)}px`;
    holder.style.height = `${Math.floor(vp.height)}px`;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const canvas = document.createElement('canvas');
    canvas.className = 'pdf-canvas';
    canvas.width = Math.floor(vp.width * dpr);
    canvas.height = Math.floor(vp.height * dpr);
    canvas.style.width = `${vp.width}px`;
    canvas.style.height = `${vp.height}px`;
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    try {
      await page.render({
        canvasContext: ctx,
        viewport: vp,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
      }).promise;
    } catch {
      return;
    }
    if (gen !== st.gen) return;
    if (st.pointerDown) return;
    const layer = document.createElement('div');
    layer.className = 'textLayer';
    layer.style.setProperty('--total-scale-factor', String(st.scale));
    layer.style.width = `${vp.width}px`;
    layer.style.height = `${vp.height}px`;
    holder.replaceChildren(canvas, layer);
    try {
      const textContent = await page.getTextContent();
      const textLayer = new pdfjs.TextLayer({
        textContentSource: textContent,
        container: layer,
        viewport: vp,
      });
      await textLayer.render();
    } catch (e) {
      console.warn('PDF 文字层失败', e);
    }
    st.rendered.set(n, { scale: st.scale, gen });
    if (B.editing && B.officeKind === 'pdf' && B.pdfEditData?.pages?.[n - 1]) {
      attachPdfEditOverlays(holder, st, B.pdfEditData.pages[n - 1]);
    }
  };

  const pump = () => {
    if (st.pointerDown) return;
    while (st.active < 2 && st.queue.length) {
      const n = st.queue.shift();
      const done = st.rendered.get(n);
      if (done && done.scale === st.scale) continue;
      st.active += 1;
      renderOne(n)
        .catch(() => {})
        .finally(() => {
          st.pending.delete(n);
          st.active -= 1;
          pump();
        });
    }
  };
  const queueRender = (n) => {
    if (st.pending.has(n) || st.rendered.get(n)?.scale === st.scale) return;
    st.pending.add(n);
    st.queue.push(n);
    pump();
  };

  st.observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) queueRender(Number(entry.target.dataset.page));
      }
    },
    { root: scrollEl, rootMargin: '1600px 0px' }
  );
  holders.forEach((h) => st.observer.observe(h));

  const updatePageInfo = () => {
    const y = scrollEl.scrollTop + 90;
    let cur = 1;
    for (const holder of holders) {
      if (holder.offsetTop <= y) cur = Number(holder.dataset.page);
      else break;
    }
    st.current = cur;
    if (info) info.textContent = `${cur} / ${doc.numPages}`;
  };

  const renderVisible = () => {
    if (st.pointerDown) return;
    const top = scrollEl.scrollTop;
    const bottom = top + scrollEl.clientHeight;
    for (const holder of holders) {
      const hTop = holder.offsetTop;
      if (hTop + holder.offsetHeight >= top - 900 && hTop <= bottom + 900) {
        queueRender(Number(holder.dataset.page));
      } else if (hTop + holder.offsetHeight < top - 3200 || hTop > bottom + 3200) {
        // 离得很远的页释放画布，避免几百页 PDF 占满内存
        if (holder.querySelector('canvas')) {
          holder.replaceChildren();
          st.rendered.delete(Number(holder.dataset.page));
        }
      }
    }
  };

  const endPointer = () => {
    if (!st.pointerDown) return;
    st.pointerDown = false;
    renderVisible();
  };
  scrollEl.addEventListener('pointerdown', (e) => {
    st.pointerDown = true;
    // 上一次选区还在时，直接按下会把旧选区整段拖动；先收起到鼠标位置，
    // 保证这次拖选从新按下的地方开始。
    if (e.button === 0 && !e.shiftKey) {
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) {
        try {
          const r = document.caretRangeFromPoint(e.clientX, e.clientY);
          if (r) {
            sel.removeAllRanges();
            sel.addRange(r);
          }
        } catch {}
      }
    }
  });
  const upHandler = () => {
    if (pdfView === st) endPointer();
  };
  window.addEventListener('pointerup', upHandler);
  window.addEventListener('pointercancel', upHandler);

  let raf = 0;
  scrollEl.addEventListener(
    'scroll',
    () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        updatePageInfo();
        renderVisible();
      });
    },
    { passive: true }
  );

  const setFactor = (next) => {
    const f = Math.min(3, Math.max(0.4, Math.round(next * 100) / 100));
    if (f === st.factor) return;
    st.factor = f;
    st.gen += 1;
    computeFit();
    layout();
    st.rendered.clear();
    for (const holder of holders) {
      if (holder.querySelector('canvas')) holder.replaceChildren();
    }
    if (zoomInfo) zoomInfo.textContent = `${Math.round(f * 100)}%`;
    renderVisible();
  };

  const goTo = (n) => {
    const holder = holders[n - 1];
    if (holder) scrollEl.scrollTo({ top: holder.offsetTop - 12, behavior: 'smooth' });
  };
  st.setFactor = setFactor;
  st.goTo = goTo;

  $('#pdfPrev').onclick = () => goTo(Math.max(1, st.current - 1));
  $('#pdfNext').onclick = () => goTo(Math.min(doc.numPages, st.current + 1));
  $('#pdfZoomIn').onclick = () => setFactor(st.factor + 0.2);
  $('#pdfZoomOut').onclick = () => setFactor(st.factor - 0.2);
  $('#pdfFit').onclick = () => setFactor(1);
  $('#pdfExternal').onclick = () => openLocalFile(p, 'open');
  const pdfSaveBtn = $('#pdfEditSave');
  if (pdfSaveBtn) pdfSaveBtn.onclick = () => savePdfEdit();
  const pdfCancelBtn = $('#pdfEditCancel');
  if (pdfCancelBtn) pdfCancelBtn.onclick = () => cancelEdit();
  if (B.editing && B.officeKind === 'pdf') {
    const page = Math.max(1, Math.min(doc.numPages, Number(B.pdfEditPage) || 1));
    if (page > 1) setTimeout(() => goTo(page), 120);
    setPdfEditStatus();
  }

  if (loading) loading.hidden = true;
  if (pagesEl) pagesEl.hidden = false;
  updatePageInfo();
  renderVisible();

  // 面板宽度变化时，适宽模式重新排版
  let resizeTimer = 0;
  const ro = new ResizeObserver(() => {
    if (st.factor !== 1) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (pdfView !== st || st.factor !== 1) return;
      st.gen += 1;
      computeFit();
      layout();
      st.rendered.clear();
      for (const holder of holders) {
        if (holder.querySelector('canvas')) holder.replaceChildren();
      }
      renderVisible();
    }, 180);
  });
  if (st.scrollEl) ro.observe(st.scrollEl);
}

let videoLiveTimer = 0;
let editorWatcher = 0;

const EDITABLE_EXTS = new Set(
  'txt md markdown mdx docx xlsx pptx pdf log json jsonl csv tsv yaml yml html htm css scss less js mjs cjs jsx ts tsx py rb go rs java kt kts c h cpp cc hpp cs php pl lua dart vue svelte astro swift m mm sh bash zsh fish ps1 bat sql xml toml ini cfg conf env srt vtt tex r gradle lock plist'.split(
    ' '
  )
);

function isMarkdownPath(p) {
  return /\.(md|markdown)$/i.test(String(p || ''));
}

function isDocxPath(p) {
  return /\.docx$/i.test(String(p || ''));
}

function isRichPath(p) {
  return isMarkdownPath(p) || isDocxPath(p);
}

function isEditablePath(p) {
  const ext = (String(p || '').split('.').pop() || '').toLowerCase();
  return EDITABLE_EXTS.has(ext);
}

function stopEditorWatch() {
  if (editorWatcher) {
    clearInterval(editorWatcher);
    editorWatcher = 0;
  }
}

function editorLength() {
  const rich = $('#feRich');
  if (rich) return (rich.innerText || '').replace(/\u200b/g, '').length;
  const ta = $('#feText');
  return ta ? ta.value.length : 0;
}

function setEditorStatus(extra = '') {
  const el = $('#feStatus');
  if (!el) return;
  const len = editorLength();
  const base = len ? `${len} 字${B.editDirty ? ' · 未保存' : ''}` : '';
  el.textContent = [base, extra].filter(Boolean).join(' · ');
}

function markEditorDirty() {
  B.editDirty = true;
  setEditorStatus();
}

function updateEditButton(editable) {
  const btn = $('#paneEdit');
  if (btn) btn.hidden = !editable;
}

function sanitizeHtml(html) {
  if (!window.DOMPurify) return String(html || '');
  try {
    return window.DOMPurify.sanitize(String(html || ''), { USE_PROFILES: { html: true } });
  } catch {
    return String(html || '');
  }
}

async function loadDocxHtml(p) {
  if (!window.mammoth) throw new Error('Word 解析库未加载');
  const buf = await (await fetch(fileRawUrl(p), { cache: 'no-store' })).arrayBuffer();
  const doc = await window.mammoth.convertToHtml(
    { arrayBuffer: buf },
    {
      convertImage: window.mammoth.images.imgElement((image) =>
        image
          .read('base64')
          .then((b64) => ({ src: `data:${image.contentType};base64,${b64}` }))
      ),
    }
  );
  return sanitizeHtml(doc.value || '');
}

function splitFrontmatter(text) {
  const raw = String(text || '');
  const m = raw.match(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!m) return { front: '', body: raw };
  let front = m[0];
  let body = raw.slice(front.length);
  const blanks = body.match(/^(?:\r?\n)+/);
  if (blanks) {
    front += blanks[0];
    body = body.slice(blanks[0].length);
  }
  return { front, body };
}

async function markdownToHtml(p) {
  const text = await readFileText(p);
  const { front, body } = splitFrontmatter(text);
  B.editFrontmatter = front;
  return window.renderMarkdown
    ? window.renderMarkdown(normalizeMarkdown(body), { breaks: false })
    : esc(body).replace(/\n/g, '<br>');
}

async function loadEditorHtml(p) {
  if (isDocxPath(p)) return loadDocxHtml(p);
  return sanitizeHtml(await markdownToHtml(p));
}

function textToHtml(text) {
  const parts = String(text || '').split(/\n{2,}/);
  const out = parts
    .map((part) => `<p>${esc(part).replace(/\n/g, '<br>')}</p>`)
    .join('');
  return out || '<p><br></p>';
}

function insertRewrittenText(range, text) {
  const BLOCK = 'p,h1,h2,h3,h4,h5,h6,li,blockquote,pre,td,th,div';
  const root = $('#feRich');
  const el = (n) => (n && n.nodeType === 1 ? n : n?.parentElement || null);
  const startBlock = el(range.startContainer)?.closest(BLOCK);
  const endBlock = el(range.endContainer)?.closest(BLOCK);
  const inline = startBlock && endBlock && startBlock === endBlock && startBlock !== root;
  if (inline) {
    document.execCommand('insertHTML', false, esc(text).replace(/\n/g, '<br>'));
    return;
  }
  range.deleteContents();
  const tpl = document.createElement('template');
  tpl.innerHTML = textToHtml(text);
  range.insertNode(tpl.content);
}

function makeTurndown() {
  if (!window.TurndownService) return null;
  const td = new window.TurndownService({
    headingStyle: 'atx',
    hr: '---',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    fence: '```',
    emDelimiter: '*',
    strongDelimiter: '**',
    linkStyle: 'inlined',
  });
  td.keep(['u', 'mark', 'sup', 'sub', 'details', 'summary', 'kbd']);
  td.addRule('fencedCodeWithLang', {
    filter: (node, options) =>
      options.codeBlockStyle === 'fenced' &&
      node.nodeName === 'PRE' &&
      node.firstChild &&
      node.firstChild.nodeName === 'CODE',
    replacement: (content, node, options) => {
      const code = String(node.firstChild.textContent || '').replace(/\n$/, '');
      const cls = node.firstChild.getAttribute('class') || '';
      const lang = (cls.match(/(?:language|lang)-([\w-]+)/) || [])[1] || '';
      return `\n\n${options.fence}${lang}\n${code}\n${options.fence}\n\n`;
    },
  });
  td.addRule('table', {
    filter: (node) => node.nodeName === 'TABLE',
    replacement: (content, node) => {
      const rows = Array.from(node.querySelectorAll('tr'))
        .map((tr) =>
          Array.from(tr.children).map((cell) =>
            String(cell.textContent || '')
              .replace(/\s+/g, ' ')
              .trim()
              .replace(/\|/g, '\\|')
          )
        )
        .filter((r) => r.length);
      if (!rows.length) return content;
      const width = Math.max(...rows.map((r) => r.length));
      const padded = rows.map((r) => {
        const copy = r.slice();
        while (copy.length < width) copy.push('');
        return copy;
      });
      const head = padded[0];
      const lines = [
        `| ${head.join(' | ')} |`,
        `| ${head.map(() => '---').join(' | ')} |`,
      ];
      for (const r of padded.slice(1)) lines.push(`| ${r.join(' | ')} |`);
      return `\n\n${lines.join('\n')}\n\n`;
    },
  });
  return td;
}

function richHtmlToMarkdown(html) {
  const td = makeTurndown();
  if (!td) throw new Error('Markdown 转换库未加载');
  return td.turndown(String(html || '')).replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

function resolveEditorImages(p) {
  const box = $('#feRich');
  if (!box) return;
  box.querySelectorAll('img').forEach((img) => {
    img.addEventListener('error', () => img.classList.add('is-broken'));
    const src = img.getAttribute('src') || '';
    if (!src || /^(https?:|data:|blob:)/i.test(src)) return;
    const clean = decodeURIComponent(src.split('#')[0].split('?')[0]);
    const isAbs = /^([A-Za-z]:[\\/]|\\\\|\/)/.test(clean);
    const sepIdx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
    const abs = isAbs
      ? clean
      : (sepIdx >= 0 ? p.slice(0, sepIdx + 1) : '') + clean.replace(/^\.[\\/]/, '');
    img.dataset.origSrc = src;
    img.src = fileRawUrl(abs);
  });
}

function editorHtmlForMarkdown() {
  const box = $('#feRich');
  if (!box) return '';
  const clone = box.cloneNode(true);
  clone.querySelectorAll('img[data-orig-src]').forEach((img) => {
    img.setAttribute('src', img.dataset.origSrc || '');
    img.removeAttribute('data-orig-src');
  });
  return clone.innerHTML;
}

const FV_ICONS = {
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h9a6 6 0 0 1 0 12h-3"/>',
  redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9h-9a6 6 0 0 0 0 12h3"/>',
  bullet:
    '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/>',
  numbered:
    '<path d="M9 6h11M9 12h11M9 18h11"/><path d="M4 5h1v4M3.6 9h2.2M3.5 14.2c.2-.6.7-1 1.3-1 .8 0 1.2.5 1.2 1.1 0 .9-1 1.3-2.4 3h2.6"/>',
  link:
    '<path d="M10 13a5 5 0 0 0 7.1 0l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1"/><path d="M14 11a5 5 0 0 0-7.1 0l-2 2A5 5 0 0 0 12 20.1l1.1-1.1"/>',
  table:
    '<rect x="3" y="4" width="18" height="16" rx="1.5"/><path d="M3 9h18M3 14h18M9 4v16M15 4v16"/>',
  eraser:
    '<path d="m4 15 7.5-7.5a2 2 0 0 1 2.8 0l3.2 3.2a2 2 0 0 1 0 2.8L12 19H7l-3-3Z"/><path d="M9 19h11"/>',
  alignLeft: '<path d="M4 6h16M4 12h10M4 18h13"/>',
  alignCenter: '<path d="M4 6h16M7 12h10M5.5 18h13"/>',
  alignRight: '<path d="M4 6h16M10 12h10M7 18h13"/>',
  code: '<path d="m8 8-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14"/>',
};

function fvIcon(name) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${FV_ICONS[name] || ''}</svg>`;
}

function richToolbarHtml(docx = false) {
  const btn = (cmd, label, title, value = '') =>
    `<button type="button" class="fv-ico" data-cmd="${cmd}"${
      value ? ` data-value="${value}"` : ''
    } title="${title}" aria-label="${title}">${label}</button>`;
  return `<div class="fv-editor-bar fv-rich-bar" id="feToolbar">
    <button type="button" class="btn primary" id="feSave">保存</button>
    <button type="button" class="btn" id="feCancel">取消</button>
    <span class="fv-tool-sep"></span>
    ${btn('undo', fvIcon('undo'), `撤销 (${MOD_KEY}Z)`)}
    ${btn('redo', fvIcon('redo'), IS_WIN ? '重做 (Ctrl+Y)' : '重做 (⇧⌘Z)')}
    <span class="fv-tool-sep"></span>
    <select id="feBlock" class="fv-select" title="段落样式">
      <option value="p">正文</option>
      <option value="h1">标题 1</option>
      <option value="h2">标题 2</option>
      <option value="h3">标题 3</option>
      <option value="h4">标题 4</option>
      <option value="blockquote">引用</option>
      <option value="pre">代码块</option>
    </select>
    ${btn('bold', '<b>B</b>', `加粗 (${MOD_KEY}B)`)}
    ${btn('italic', '<i>I</i>', `斜体 (${MOD_KEY}I)`)}
    ${btn('underline', '<u>U</u>', `下划线 (${MOD_KEY}U)`)}
    ${btn('strikeThrough', '<s>S</s>', '删除线')}
    ${btn('insertUnorderedList', fvIcon('bullet'), '项目符号')}
    ${btn('insertOrderedList', fvIcon('numbered'), '编号')}
    ${
      docx
        ? `${btn('justifyLeft', fvIcon('alignLeft'), '左对齐')}
           ${btn('justifyCenter', fvIcon('alignCenter'), '居中')}
           ${btn('justifyRight', fvIcon('alignRight'), '右对齐')}`
        : ''
    }
    <span class="fv-tool-sep"></span>
    ${btn('createLink', fvIcon('link'), '插入链接')}
    <button type="button" class="fv-ico" data-action="table" title="插入表格" aria-label="插入表格">${fvIcon(
      'table'
    )}</button>
    ${btn('formatBlock', '“', '引用', 'blockquote')}
    ${btn('formatBlock', fvIcon('code'), '代码块', 'pre')}
    ${btn('removeFormat', fvIcon('eraser'), '清除格式')}
    <span class="fv-tool-sep"></span>
    <span class="fv-editor-status" id="feStatus"></span>
  </div>`;
}

function insertEditorTable() {
  const box = $('#feRich');
  if (!box) return;
  let range = null;
  const sel = window.getSelection();
  if (sel && sel.rangeCount && !sel.isCollapsed && box.contains(sel.anchorNode)) {
    range = sel.getRangeAt(0).cloneRange();
  } else if (B.richRange && box.contains(B.richRange.startContainer)) {
    range = B.richRange.cloneRange();
  }
  const raw = prompt('插入表格：行数 × 列数', '3 × 4');
  if (!raw) return;
  const match = String(raw).match(/(\d+)\s*[x×*,\s]\s*(\d+)/i);
  const rows = Math.min(20, Math.max(1, Number(match?.[1]) || 3));
  const cols = Math.min(12, Math.max(1, Number(match?.[2]) || 4));
  let html = '<table><thead><tr>';
  for (let c = 0; c < cols; c += 1) html += '<th><br></th>';
  html += '</tr></thead><tbody>';
  for (let r = 1; r < rows; r += 1) {
    html += '<tr>';
    for (let c = 0; c < cols; c += 1) html += '<td><br></td>';
    html += '</tr>';
  }
  html += '</tbody></table><p><br></p>';
  box.focus();
  if (range) {
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(range);
  }
  document.execCommand('insertHTML', false, html);
  markEditorDirty();
}

function wireRichToolbar() {
  const box = $('#feRich');
  const bar = $('#feToolbar');
  if (!box || !bar) return;
  const remember = () => {
    const sel = window.getSelection();
    if (sel && sel.rangeCount && box.contains(sel.anchorNode)) {
      B.richRange = sel.getRangeAt(0).cloneRange();
    }
  };
  box.addEventListener('mouseup', remember);
  box.addEventListener('keyup', remember);
  box.addEventListener('input', markEditorDirty);
  box.addEventListener('paste', () => setTimeout(markEditorDirty, 0));
  box.addEventListener('drop', () => setTimeout(markEditorDirty, 0));
  bar.querySelectorAll('button[data-cmd],button[data-action]').forEach((btn) => {
    btn.onmousedown = (e) => e.preventDefault();
    btn.onclick = () => {
      if (btn.dataset.action === 'table') {
        insertEditorTable();
        return;
      }
      const cmd = btn.dataset.cmd;
      const value = btn.dataset.value || null;
      box.focus();
      if (cmd === 'createLink') {
        const url = prompt('链接地址（留空取消）');
        if (url) document.execCommand('createLink', false, url);
      } else {
        document.execCommand(cmd, false, value);
      }
      markEditorDirty();
    };
  });
  const block = $('#feBlock');
  if (block) {
    block.onmousedown = () => remember();
    block.onchange = () => {
      box.focus();
      document.execCommand('formatBlock', false, block.value);
      markEditorDirty();
    };
  }
}

function isXlsxPath(p) {
  return /\.xlsx$/i.test(String(p || ''));
}

function isCsvPath(p) {
  return /\.(csv|tsv)$/i.test(String(p || ''));
}

function isPptxPath(p) {
  return /\.pptx$/i.test(String(p || ''));
}

function isPdfPath(p) {
  return /\.pdf$/i.test(String(p || ''));
}

function ensureEditKeyHandler() {
  if (B.editKeyHandler) return;
  B.editKeyHandler = (e) => {
    if (!B.editing) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      if (B.editOffice && typeof B.editSave === 'function') B.editSave();
      else saveEdit();
    }
  };
  document.addEventListener('keydown', B.editKeyHandler);
}

function columnName(c) {
  let n = Number(c) + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out || 'A';
}

function parseDelimited(text, delim) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === delim) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (ch === '\r') {
      if (text[i + 1] === '\n') i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function trimGrid(rows) {
  const copy = rows.map((row) => row.map((v) => String(v ?? '')));
  while (copy.length && copy[copy.length - 1].every((v) => v === '')) copy.pop();
  let width = 0;
  for (const row of copy) {
    for (let i = 0; i < row.length; i += 1) {
      if (row[i] !== '') width = Math.max(width, i + 1);
    }
  }
  return copy.map((row) => {
    const out = row.slice(0, width);
    while (out.length < width) out.push('');
    return out;
  });
}

function serializeDelimited(rows, delim, newline = '\n', bom = false) {
  const body = rows
    .map((row) =>
      row
        .map((value) => {
          const text = String(value ?? '');
          const quote =
            text.includes('"') ||
            text.includes('\n') ||
            text.includes('\r') ||
            text.includes(delim);
          return quote ? `"${text.replace(/"/g, '""')}"` : text;
        })
        .join(delim)
    )
    .join(newline);
  return `${bom ? '\uFEFF' : ''}${body ? `${body}${newline}` : ''}`;
}

function detectDelimiter(text, ext) {
  if (String(ext).toLowerCase() === 'tsv') return '\t';
  const first = text.split(/\r?\n/).find((line) => line.trim()) || '';
  const tabs = (first.match(/\t/g) || []).length;
  const commas = (first.match(/,/g) || []).length;
  return tabs > commas ? '\t' : ',';
}

function cellDisplay(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const p = (n) => String(n).padStart(2, '0');
    return `${value.getFullYear()}-${p(value.getMonth() + 1)}-${p(value.getDate())}`;
  }
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  return String(value);
}

function xlsxSheetRows(book, name) {
  const ws = book?.Sheets?.[name];
  if (!ws) return { rows: [], usedRows: 0, usedCols: 0 };
  let usedRows = 0;
  let usedCols = 0;
  try {
    const range = window.XLSX.utils.decode_range(ws['!ref'] || 'A1');
    usedRows = Math.max(0, range.e.r + 1);
    usedCols = Math.max(0, range.e.c + 1);
  } catch {}
  let rows = [];
  try {
    rows = window.XLSX.utils.sheet_to_json(ws, {
      header: 1,
      raw: true,
      defval: null,
      blankrows: true,
    });
  } catch {
    rows = [];
  }
  return { rows, usedRows, usedCols };
}

function buildGridView(rows, usedRows, usedCols) {
  const maxRows = 800;
  const maxCols = 40;
  let colCount = usedCols;
  for (const row of rows) colCount = Math.max(colCount, row.length);
  colCount = Math.min(Math.max(colCount + 2, 8), maxCols);
  const rowCount = Math.min(Math.max(Math.max(usedRows, rows.length) + 5, 20), maxRows);
  const truncated = usedRows > maxRows || usedCols > maxCols || rows.length > maxRows;
  const view = [];
  for (let r = 0; r < rowCount; r += 1) {
    const source = rows[r] || [];
    const row = [];
    for (let c = 0; c < colCount; c += 1) row.push(cellDisplay(source[c]));
    view.push(row);
  }
  return { rows: view, rowCount, colCount, truncated };
}

function setOfficeStatus(extra = '') {
  const el = $('#feStatus');
  if (!el) return;
  let base = '';
  const count = B.officeDirty?.size || 0;
  if (B.officeKind === 'xlsx') base = count ? `${count} 个单元格未保存` : '';
  else if (B.officeKind === 'csv') base = count ? `${count} 处修改未保存` : '';
  else if (B.officeKind === 'pptx') base = count ? `${count} 段文字未保存` : '';
  else if (B.officeKind === 'pdf') {
    const changed = (B.pdfEditData?.pages || []).reduce(
      (n, page) => n + (page.blocks || []).filter((block) => block.dirty).length,
      0
    );
    base = changed ? `${changed} 处文字未保存` : '';
  }
  el.textContent = [base, extra].filter(Boolean).join(' · ');
}

function renderSheetEditor(p) {
  const kind = B.officeKind;
  const sheetNames = kind === 'xlsx' ? B.officeBook.SheetNames : [];
  let sourceRows = [];
  let usedRows = 0;
  let usedCols = 0;
  if (kind === 'xlsx') {
    let cache = B.officeSheetCache.get(B.officeSheet);
    if (!cache) {
      cache = xlsxSheetRows(B.officeBook, B.officeSheet);
      B.officeSheetCache.set(B.officeSheet, cache);
      const map = new Map();
      for (let r = 0; r < cache.rows.length; r += 1) {
        const row = cache.rows[r] || [];
        for (let c = 0; c < row.length; c += 1) {
          map.set(`${B.officeSheet}!${columnName(c)}${r + 1}`, cellDisplay(row[c]));
        }
      }
      B.officeOriginal.set(B.officeSheet, map);
    }
    sourceRows = cache.rows;
    usedRows = cache.usedRows;
    usedCols = cache.usedCols;
  } else {
    sourceRows = B.officeRows;
    usedRows = B.officeRows.length;
    for (const row of B.officeRows) usedCols = Math.max(usedCols, row.length);
  }
  const view = buildGridView(sourceRows, usedRows, usedCols);
  B.officeView = view;
  const wrap = $('.fv-grid-wrap');
  const scrollTop = wrap?.scrollTop || 0;
  const scrollLeft = wrap?.scrollLeft || 0;
  const sheetSelect =
    kind === 'xlsx'
      ? `<select id="feSheet" title="切换工作表">${sheetNames
          .map(
            (name) =>
              `<option value="${esc(name)}"${name === B.officeSheet ? ' selected' : ''}>${esc(name)}</option>`
          )
          .join('')}</select>`
      : '';
  const note =
    kind === 'xlsx'
      ? '公式/样式保留，保存会重写工作簿'
      : view.truncated
        ? '表格较大，只显示一部分'
        : '';
  const head = `<tr><th class="fv-grid-corner"></th>${Array.from(
    { length: view.colCount },
    (_, c) => `<th class="fv-grid-colhead">${columnName(c)}</th>`
  ).join('')}</tr>`;
  const body = view.rows
    .map((row, r) => {
      const cells = row
        .map((value, c) => {
          const key = kind === 'xlsx' ? `${B.officeSheet}!${columnName(c)}${r + 1}` : `${r}:${c}`;
          const dirty =
            kind === 'xlsx' ? B.officeDirty.has(key) : B.officeDirty.has(`${r}:${c}`);
          return `<td class="fv-grid-cell${dirty ? ' is-dirty' : ''}" contenteditable="true" spellcheck="false" data-r="${r}" data-c="${c}">${esc(
            value
          )}</td>`;
        })
        .join('');
      return `<tr><th class="fv-grid-rowhead">${r + 1}</th>${cells}</tr>`;
    })
    .join('');
  const content = $('#fileContent');
  content.innerHTML = `<div class="fv-editor fv-grid-editor">
    <div class="fv-editor-bar">
      <button type="button" class="btn primary" id="feSave">保存</button>
      <button type="button" class="btn" id="feCancel">取消</button>
      ${sheetSelect}
      <button type="button" class="btn" id="feGrowRows" title="在表格末尾插入一行"${view.truncated ? ' disabled' : ''}>插入行</button>
      <button type="button" class="btn" id="feGrowCols" title="在表格右侧插入一列"${view.truncated ? ' disabled' : ''}>插入列</button>
      <span class="fv-editor-note">${esc(note)}</span>
      <span class="fv-editor-status" id="feStatus"></span>
    </div>
    <div class="fv-grid-wrap" id="feGridWrap">
      <table class="fv-grid"><thead>${head}</thead><tbody>${body}</tbody></table>
    </div>
  </div>`;
  const wrap2 = $('#feGridWrap');
  if (wrap2) {
    wrap2.scrollTop = scrollTop;
    wrap2.scrollLeft = scrollLeft;
  }
  $('#feSave').onclick = () => saveSheetEdit();
  $('#feCancel').onclick = () => cancelEdit();
  const sheet = $('#feSheet');
  if (sheet) {
    sheet.onchange = () => {
      B.officeSheet = sheet.value;
      renderSheetEditor(p);
    };
  }
  $('#feGrowRows').onclick = () => growSheetRows(1);
  $('#feGrowCols').onclick = () => growSheetCols(1);
  content.querySelectorAll('td.fv-grid-cell').forEach((td) => {
    td.addEventListener('input', () => handleSheetCell(td));
    td.addEventListener('blur', () => handleSheetCell(td));
  });
  setOfficeStatus();
}

function handleSheetCell(td) {
  if (!B.editing || !B.editOffice) return;
  const r = Number(td.dataset.r);
  const c = Number(td.dataset.c);
  const value = String(td.innerText || '').replace(/\u00a0/g, ' ').replace(/\r/g, '');
  if (B.officeKind === 'xlsx') {
    const cell = `${columnName(c)}${r + 1}`;
    const key = `${B.officeSheet}!${cell}`;
    const cache = B.officeSheetCache.get(B.officeSheet);
    if (cache) {
      while (cache.rows.length <= r) cache.rows.push([]);
      const row = cache.rows[r] || (cache.rows[r] = []);
      while (row.length <= c) row.push('');
      row[c] = value;
    }
    const original = B.officeOriginal.get(B.officeSheet)?.get(key) ?? '';
    if (value === original) B.officeDirty.delete(key);
    else B.officeDirty.set(key, { sheet: B.officeSheet, cell, value });
    td.classList.toggle('is-dirty', B.officeDirty.has(key));
    B.editDirty = B.officeDirty.size > 0;
  } else {
    while (B.officeRows.length <= r) B.officeRows.push([]);
    const row = B.officeRows[r];
    while (row.length <= c) row.push('');
    row[c] = value;
    B.officeDirty.add(`${r}:${c}`);
    B.officeEditGen = (B.officeEditGen || 0) + 1;
    td.classList.add('is-dirty');
    B.editDirty = true;
  }
  setOfficeStatus();
}

function growSheetRows(count) {
  if (!B.editing || !B.editOffice) return;
  const n = Math.max(1, Number(count) || 1);
  if (B.officeKind === 'xlsx') {
    const cache = B.officeSheetCache.get(B.officeSheet);
    if (!cache) return;
    for (let i = 0; i < n; i += 1) cache.rows.push([]);
  } else {
    const width = Math.max(B.officeView?.colCount || 8, 1);
    for (let i = 0; i < n; i += 1) B.officeRows.push(new Array(width).fill(''));
    B.officeEditGen = (B.officeEditGen || 0) + 1;
    B.editDirty = true;
  }
  renderSheetEditor(B.filePath);
}

function growSheetCols(count) {
  if (!B.editing || !B.editOffice) return;
  const n = Math.max(1, Number(count) || 1);
  if (B.officeKind === 'xlsx') {
    const cache = B.officeSheetCache.get(B.officeSheet);
    if (!cache) return;
    for (const row of cache.rows) {
      for (let i = 0; i < n; i += 1) row.push('');
    }
  } else {
    for (const row of B.officeRows) {
      for (let i = 0; i < n; i += 1) row.push('');
    }
    B.officeEditGen = (B.officeEditGen || 0) + 1;
    B.editDirty = true;
  }
  renderSheetEditor(B.filePath);
}

async function startSheetEdit(p, kind) {
  if (B.editing) return;
  let book = null;
  let text = '';
  const ext = (String(p).split('.').pop() || '').toLowerCase();
  try {
    if (kind === 'xlsx') {
      if (!window.XLSX) throw new Error('Excel 解析库未加载');
      const buf = await (await fetch(fileRawUrl(p), { cache: 'no-store' })).arrayBuffer();
      book = window.XLSX.read(buf, { type: 'array', cellDates: true });
      if (!book.SheetNames?.length) throw new Error('工作簿里没有工作表');
    } else {
      text = await readFileText(p);
    }
  } catch (e) {
    toast(`读取失败：${apiErrorText(e)}`, 'err');
    return;
  }
  let mtime = Number(B.fileMeta?.mtime) || 0;
  if (!mtime) {
    try {
      const s = await api(`/api/files/stat?path=${encodeURIComponent(p)}`);
      mtime = Number(s.mtime) || 0;
    } catch {}
  }
  B.editing = true;
  B.editDirty = false;
  B.editOffice = true;
  B.editMtime = mtime;
  B.officeKind = kind;
  B.officeEditGen = 0;
  B.officeAutoTimer = 0;
  B.officeSaving = false;
  B.editSave = () => saveSheetEdit();
  if (kind === 'xlsx') {
    B.officeBook = book;
    B.officeSheet = book.SheetNames[0];
    B.officeSheetCache = new Map();
    B.officeOriginal = new Map();
    B.officeDirty = new Map();
    B.officeRows = null;
  } else {
    const bom = text.charCodeAt(0) === 0xfeff;
    const body = bom ? text.slice(1) : text;
    const delim = detectDelimiter(body, ext);
    B.officeRows = parseDelimited(body, delim);
    B.officeDelim = delim;
    B.officeNewline = body.includes('\r\n') ? '\r\n' : '\n';
    B.officeBom = bom;
    B.officeDirty = new Set();
    B.officeBook = null;
    B.officeSheet = '';
  }
  renderSheetEditor(p);
  void registerEditorSession();
  ensureEditKeyHandler();
  startEditorWatch();
}

async function saveSheetEdit() {
  if (!B.editing || !B.editOffice) return;
  const btn = $('#feSave');
  if (btn) btn.disabled = true;
  try {
    if (B.officeKind === 'xlsx') {
      const updates = [...B.officeDirty.values()];
      if (!updates.length) {
        exitEditMode();
        await openFileInPane(B.filePath);
        toast('没有修改');
        return;
      }
      if (!B.editOfficeWarned?.xlsx) {
        if (
          !confirm(
            '保存会重写 Excel 文件：现有样式、公式和大部分内容会保留，图表、图片、透视表等高级对象可能受影响。继续？'
          )
        ) {
          return;
        }
        B.editOfficeWarned = { ...(B.editOfficeWarned || {}), xlsx: true };
      }
      setOfficeStatus('保存中…');
      const r = await api('/api/office/xlsx/write', {
        method: 'POST',
        body: { path: B.filePath, updates, mtime: B.editMtime },
      });
      if (r?.mtime) B.editMtime = r.mtime;
    } else {
      if (!B.editDirty) {
        exitEditMode();
        await openFileInPane(B.filePath);
        return;
      }
      setOfficeStatus('保存中…');
      const content = serializeDelimited(
        trimGrid(B.officeRows),
        B.officeDelim,
        B.officeNewline,
        B.officeBom
      );
      const r = await api('/api/files/write', {
        method: 'POST',
        body: { path: B.filePath, content, mtime: B.editMtime },
      });
      if (r?.mtime) B.editMtime = r.mtime;
    }
    exitEditMode();
    await openFileInPane(B.filePath);
    toast('已保存');
  } catch (e) {
    if (/409/.test(String(e.message))) {
      const s = await api(`/api/files/stat?path=${encodeURIComponent(B.filePath)}`).catch(() => null);
      if (s?.mtime) B.editMtime = s.mtime;
      toast('文件已被其他程序改过，按保存再试一次（会用你当前编辑器里的内容覆盖）', 'err');
    } else {
      toast(`保存失败：${apiErrorText(e)}`, 'err');
    }
    setOfficeStatus();
  } finally {
    if (btn) btn.disabled = false;
  }
}

function autoGrowPptx(ta) {
  ta.style.height = 'auto';
  ta.style.height = `${Math.min(280, Math.max(30, ta.scrollHeight + 2))}px`;
}

function renderPptxEditor() {
  const outline = B.officePptx || { slides: [] };
  B.officePptxItems = new Map();
  const sections = (outline.slides || []).map((slide) => {
    const items = (slide.items || []).map((item) => {
      B.officePptxItems.set(item.index, item.text || '');
      const rows = Math.max(1, Math.min(6, String(item.text || '').split('\n').length));
      return `<div class="fv-ppt-item" style="margin-left:${Math.max(0, Number(item.level) || 0) * 14}px">
        <span class="fv-ppt-label" title="${esc(item.shape || '')}">${esc(item.shape || '文字')}</span>
        <textarea data-index="${item.index}" rows="${rows}" spellcheck="false">${esc(
          item.text || ''
        )}</textarea>
      </div>`;
    });
    return `<section class="fv-ppt-slide">
      <div class="fv-ppt-slide-head"><span class="fv-ppt-no">第 ${slide.index + 1} 张</span><span class="fv-ppt-title">${esc(
        slide.title || ''
      )}</span></div>
      ${items || '<div class="fv-ppt-empty">这一页没有可编辑文字</div>'}
    </section>`;
  });
  const content = $('#fileContent');
  content.innerHTML = `<div class="fv-editor fv-pptx-editor">
    <div class="fv-editor-bar">
      <button type="button" class="btn primary" id="feSave">保存</button>
      <button type="button" class="btn" id="feCancel">取消</button>
      <span class="fv-editor-note">只改文字，版式 / 图片 / 动画不动</span>
      <span class="fv-editor-status" id="feStatus"></span>
    </div>
    <div class="fv-ppt-scroll">
      ${sections.join('') || '<div class="usage-loading">这份 PPT 没有找到可编辑的文字</div>'}
    </div>
  </div>`;
  $('#feSave').onclick = () => savePptxEdit();
  $('#feCancel').onclick = () => cancelEdit();
  content.querySelectorAll('.fv-ppt-item textarea').forEach((ta) => {
    const index = Number(ta.dataset.index);
    const original = B.officePptxItems.get(index) ?? '';
    const update = () => {
      if (ta.value === original) B.officeDirty.delete(index);
      else B.officeDirty.add(index);
      B.editDirty = B.officeDirty.size > 0;
      autoGrowPptx(ta);
      setOfficeStatus();
    };
    ta.addEventListener('input', update);
    autoGrowPptx(ta);
  });
  setOfficeStatus();
}

async function startPptxEdit(p) {
  if (B.editing) return;
  let outline;
  try {
    outline = await api(`/api/office/pptx/outline?path=${encodeURIComponent(p)}`);
  } catch (e) {
    toast(`读取 PPT 失败：${apiErrorText(e)}`, 'err');
    return;
  }
  B.editing = true;
  B.editDirty = false;
  B.editOffice = true;
  B.editMtime = Number(outline.mtime) || 0;
  B.officeKind = 'pptx';
  B.officePptx = outline;
  B.officeDirty = new Set();
  B.officeEditGen = 0;
  B.officeAutoTimer = 0;
  B.officeSaving = false;
  B.editSave = () => savePptxEdit();
  renderPptxEditor();
  void registerEditorSession();
  ensureEditKeyHandler();
  startEditorWatch();
}

async function savePptxEdit() {
  if (!B.editing || B.officeKind !== 'pptx') return;
  const btn = $('#feSave');
  if (btn) btn.disabled = true;
  try {
    const updates = [...B.officeDirty].map((index) => {
      const ta = document.querySelector(`#fileContent textarea[data-index="${index}"]`);
      return { index, text: ta ? ta.value : B.officePptxItems.get(index) || '' };
    });
    if (!updates.length) {
      exitEditMode();
      await openFileInPane(B.filePath);
      toast('没有修改');
      return;
    }
    if (!B.editOfficeWarned?.pptx) {
      if (
        !confirm(
          '保存会重写 PPT 文件：文字内容会更新，版式、图片和动画通常保留，但极少数复杂对象可能受影响。继续？'
        )
      ) {
        return;
      }
      B.editOfficeWarned = { ...(B.editOfficeWarned || {}), pptx: true };
    }
    setOfficeStatus('保存中…');
    const r = await api('/api/office/pptx/write', {
      method: 'POST',
      body: { path: B.filePath, paragraphs: updates, mtime: B.editMtime },
    });
    if (r?.mtime) B.editMtime = r.mtime;
    exitEditMode();
    await openFileInPane(B.filePath);
    toast('已保存');
  } catch (e) {
    if (/409/.test(String(e.message))) {
      const s = await api(`/api/files/stat?path=${encodeURIComponent(B.filePath)}`).catch(() => null);
      if (s?.mtime) B.editMtime = s.mtime;
      toast('文件已被其他程序改过，按保存再试一次（会用你当前编辑器里的内容覆盖）', 'err');
    } else {
      toast(`保存失败：${apiErrorText(e)}`, 'err');
    }
    setOfficeStatus();
  } finally {
    if (btn) btn.disabled = false;
  }
}

function editorSessionKind() {
  if (B.officeKind) return B.officeKind;
  if (B.editDocx) return 'word';
  if (B.editRich) return 'markdown';
  return 'text';
}

function stopEditorBridge() {
  if (B.editorBridgeTimer) {
    clearInterval(B.editorBridgeTimer);
    B.editorBridgeTimer = 0;
  }
  const id = B.editorSessionId;
  B.editorSessionId = '';
  if (id) {
    try {
      fetch('/api/editor/unregister', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: id }),
        keepalive: true,
      }).catch(() => {});
    } catch {}
  }
}

async function registerEditorSession() {
  stopEditorBridge();
  const id = `ed_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  B.editorSessionId = id;
  try {
    await api('/api/editor/register', {
      method: 'POST',
      body: { sessionId: id, filePath: B.filePath, kind: editorSessionKind() },
    });
  } catch {}
  B.editorBridgeTimer = setInterval(() => {
    void pollEditorOps();
  }, 450);
}

function editorSnapshot() {
  if (B.officeKind === 'xlsx' || B.officeKind === 'csv') {
    const rows = (B.officeView?.rows || []).slice(0, 200).map((row) => row.slice(0, 40));
    return {
      ok: true,
      mode: 'grid',
      kind: B.officeKind,
      filePath: B.filePath,
      sheet: B.officeKind === 'xlsx' ? B.officeSheet : '',
      sheets: B.officeKind === 'xlsx' ? B.officeBook?.SheetNames || [] : [],
      rows,
      rowCount: B.officeView?.rowCount || rows.length,
      colCount: B.officeView?.colCount || 0,
      textLength: rows.reduce((n, row) => n + row.join('').length, 0),
    };
  }
  if (B.officeKind === 'pdf') {
    return {
      ok: true,
      mode: 'pdf',
      kind: 'pdf',
      filePath: B.filePath,
      pages: (B.pdfEditData?.pages || []).slice(0, 100).map((page) => ({
        index: page.index,
        width: page.width,
        height: page.height,
        blocks: (page.blocks || []).slice(0, 300),
      })),
      textLength: (B.pdfEditData?.pages || []).reduce(
        (n, page) => n + (page.blocks || []).reduce((m, block) => m + String(block.text || '').length, 0),
        0
      ),
    };
  }
  if (B.officeKind === 'pptx') {
    return {
      ok: true,
      mode: 'pptx',
      kind: 'pptx',
      filePath: B.filePath,
      slides: B.officePptx?.slides || [],
      count: B.officePptx?.count || 0,
      textLength: (B.officePptx?.slides || []).reduce(
        (n, slide) => n + (slide.items || []).reduce((m, item) => m + String(item.text || '').length, 0),
        0
      ),
    };
  }
  const rich = $('#feRich');
  const ta = $('#feText');
  if (rich) {
    const clone = rich.cloneNode(true);
    clone.querySelectorAll('img').forEach((img) => img.setAttribute('src', ''));
    const text = String(rich.innerText || '');
    let html = clone.innerHTML || '';
    if (html.length > 32000) html = html.slice(0, 32000);
    return {
      ok: true,
      mode: 'rich',
      filePath: B.filePath,
      kind: editorSessionKind(),
      textLength: text.length,
      text: text.slice(0, 20000),
      htmlLength: html.length,
      html,
    };
  }
  if (ta) {
    return {
      ok: true,
      mode: 'text',
      filePath: B.filePath,
      kind: 'text',
      textLength: ta.value.length,
      text: ta.value.slice(0, 20000),
    };
  }
  return { ok: false, error: '当前没有可编辑内容' };
}

function replaceInTextNodes(root, find, replace, all) {
  if (!find) return 0;
  let count = 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const value = node.nodeValue || '';
    if (!value.includes(find)) continue;
    if (all) {
      const parts = value.split(find);
      const n = parts.length - 1;
      if (n > 0) {
        node.nodeValue = parts.join(replace);
        count += n;
      }
    } else {
      node.nodeValue = value.replace(find, replace);
      count += 1;
      break;
    }
  }
  return count;
}

function applyEditorOperations(operations) {
  const rich = $('#feRich');
  const ta = $('#feText');
  if (!rich && !ta) return { ok: false, error: '当前没有可编辑内容' };
  let changed = 0;
  for (const item of operations || []) {
    const type = String(item?.type || '');
    if (rich) {
      if (type === 'replace_text') {
        changed += replaceInTextNodes(
          rich,
          String(item.find || ''),
          String(item.replace || ''),
          !!item.all
        );
        continue;
      }
      if (type === 'patch') {
        const selector = String(item.selector || '').trim();
        if (!selector) throw new Error('patch 缺少 selector');
        const target = rich.querySelector(selector);
        if (!target) throw new Error(`找不到要替换的元素：${selector}`);
        const safe = sanitizeHtml(String(item.html || ''));
        const tag = String(target.tagName || '').toLowerCase();
        const first = safe.trim().match(/^<([a-z0-9-]+)/i);
        if (first && first[1].toLowerCase() === tag) {
          const tpl = document.createElement('template');
          tpl.innerHTML = safe;
          const node = tpl.content.firstElementChild;
          if (node) {
            target.replaceWith(node);
            changed += 1;
            continue;
          }
        }
        target.innerHTML = safe;
        changed += 1;
        continue;
      }
      if (type === 'set_html') {
        rich.innerHTML = sanitizeHtml(String(item.html || ''));
        changed += 1;
        continue;
      }
      if (type === 'insert_html') {
        const selector = String(item.selector || '').trim();
        if (!selector) throw new Error('insert_html 缺少 selector');
        const target = rich.querySelector(selector);
        if (!target) throw new Error(`找不到要插入的位置：${selector}`);
        const position = ['beforebegin', 'afterbegin', 'beforeend', 'afterend'].includes(item.position)
          ? item.position
          : 'afterend';
        target.insertAdjacentHTML(position, sanitizeHtml(String(item.html || '')));
        changed += 1;
        continue;
      }
      throw new Error(`不支持的操作类型：${type || '空'}`);
    }
    if (type === 'replace_text') {
      const find = String(item.find || '');
      if (!find) continue;
      if (item.all) {
        const parts = ta.value.split(find);
        changed += parts.length - 1;
        ta.value = parts.join(String(item.replace || ''));
      } else {
        const next = ta.value.replace(find, String(item.replace || ''));
        if (next !== ta.value) changed += 1;
        ta.value = next;
      }
      continue;
    }
    if (type === 'set_text') {
      ta.value = String(item.text || '');
      changed += 1;
      continue;
    }
    throw new Error(`纯文本编辑器不支持操作：${type || '空'}`);
  }
  if (changed > 0) {
    B.editDirty = true;
    B.liveAiEditedAt = Date.now();
    setEditorStatus(
      B.editDocx
        ? 'AI 已直接修改编辑器 · 记得保存写回 Word'
        : 'AI 已直接修改编辑器 · 记得保存'
    );
  }
  const snapshot = editorSnapshot();
  return {
    ok: true,
    changed,
    filePath: B.filePath,
    kind: editorSessionKind(),
    textLength: snapshot.textLength || 0,
    textPreview: String(snapshot.text || '').slice(0, 1200),
  };
}

function ensureXlsxSheetCache(sheet) {
  let cache = B.officeSheetCache.get(sheet);
  if (!cache) {
    cache = xlsxSheetRows(B.officeBook, sheet);
    B.officeSheetCache.set(sheet, cache);
    const map = new Map();
    for (let r = 0; r < cache.rows.length; r += 1) {
      const row = cache.rows[r] || [];
      for (let c = 0; c < row.length; c += 1) {
        map.set(`${sheet}!${columnName(c)}${r + 1}`, cellDisplay(row[c]));
      }
    }
    B.officeOriginal.set(sheet, map);
  }
  return cache;
}

function decodeCellRef(ref) {
  const clean = String(ref || '').replace(/\$/g, '').trim().toUpperCase();
  const match = clean.match(/^([A-Z]+)(\d+)$/);
  if (!match) return null;
  let col = 0;
  for (const ch of match[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
  const row = Number(match[2]);
  if (!Number.isFinite(row) || row < 1) return null;
  return { r: row - 1, c: col - 1 };
}

function updateGridCellDom(r, c, value, dirty) {
  const td = document.querySelector(
    `#fileContent td.fv-grid-cell[data-r="${r}"][data-c="${c}"]`
  );
  if (!td) return;
  td.innerText = value;
  td.classList.toggle('is-dirty', !!dirty);
}

function refreshGridDirtyClasses() {
  document.querySelectorAll('#fileContent td.fv-grid-cell').forEach((td) => {
    const r = Number(td.dataset.r);
    const c = Number(td.dataset.c);
    const dirty =
      B.officeKind === 'xlsx'
        ? B.officeDirty.has(`${B.officeSheet}!${columnName(c)}${r + 1}`)
        : B.officeDirty.has(`${r}:${c}`);
    td.classList.toggle('is-dirty', dirty);
  });
}

function applyEditorCells(cells) {
  if (B.officeKind !== 'xlsx' && B.officeKind !== 'csv') {
    return { ok: false, error: '当前不是 Excel/CSV 表格编辑器' };
  }
  let changed = 0;
  for (const item of (cells || []).slice(0, 500)) {
    const value = String(item?.value ?? '');
    let ref = String(item?.cell || '').trim();
    if (!ref && Number.isFinite(Number(item?.row)) && Number.isFinite(Number(item?.col))) {
      ref = `${columnName(Number(item.col))}${Number(item.row) + 1}`;
    }
    const decoded = decodeCellRef(ref);
    if (!decoded) continue;
    const r = decoded.r;
    const c = decoded.c;
    const normalizedRef = `${columnName(c)}${r + 1}`;
    if (B.officeKind === 'xlsx') {
      const sheet = String(item?.sheet || B.officeSheet || '');
      if (!sheet || !B.officeBook?.Sheets?.[sheet]) continue;
      const cache = ensureXlsxSheetCache(sheet);
      while (cache.rows.length <= r) cache.rows.push([]);
      const row = cache.rows[r] || (cache.rows[r] = []);
      while (row.length <= c) row.push('');
      row[c] = value;
      const key = `${sheet}!${normalizedRef}`;
      const original = B.officeOriginal.get(sheet)?.get(key) ?? '';
      if (value === original) B.officeDirty.delete(key);
      else B.officeDirty.set(key, { sheet, cell: normalizedRef, value });
      if (sheet === B.officeSheet) updateGridCellDom(r, c, value, B.officeDirty.has(key));
    } else {
      while (B.officeRows.length <= r) B.officeRows.push([]);
      const row = B.officeRows[r];
      while (row.length <= c) row.push('');
      row[c] = value;
      B.officeDirty.add(`${r}:${c}`);
      B.officeEditGen = (B.officeEditGen || 0) + 1;
      updateGridCellDom(r, c, value, true);
    }
    changed += 1;
  }
  if (changed) {
    B.editDirty = true;
    setOfficeStatus('AI 已直接修改，正在写回…');
    scheduleOfficeAutoSave();
  }
  return {
    ok: true,
    changed,
    kind: B.officeKind,
    sheet: B.officeKind === 'xlsx' ? B.officeSheet : '',
    textPreview: JSON.stringify((B.officeView?.rows || []).slice(0, 8)),
  };
}

function applyEditorParagraphs(paragraphs) {
  if (B.officeKind !== 'pptx') {
    return { ok: false, error: '当前不是 PPT 编辑器' };
  }
  let changed = 0;
  for (const item of (paragraphs || []).slice(0, 500)) {
    const index = Number(item?.index);
    if (!Number.isFinite(index) || !B.officePptxItems?.has(index)) continue;
    const text = String(item?.text ?? '');
    const ta = document.querySelector(`#fileContent textarea[data-index="${index}"]`);
    if (ta) {
      ta.value = text;
      autoGrowPptx(ta);
    }
    for (const slide of B.officePptx?.slides || []) {
      for (const para of slide.items || []) {
        if (para.index === index) para.text = text;
      }
    }
    B.officeDirty.add(index);
    changed += 1;
  }
  if (changed) {
    B.editDirty = true;
    setOfficeStatus('AI 已直接修改，正在写回…');
    scheduleOfficeAutoSave();
  }
  return {
    ok: true,
    changed,
    kind: 'pptx',
    textPreview: (B.officePptx?.slides || [])
      .flatMap((slide) => slide.items || [])
      .slice(0, 12)
      .map((item) => item.text)
      .join('\n'),
  };
}

function scheduleOfficeAutoSave() {
  if (!B.editing || !B.editOffice) return;
  if (B.officeAutoTimer) clearTimeout(B.officeAutoTimer);
  B.officeAutoTimer = setTimeout(() => {
    B.officeAutoTimer = 0;
    void autoSaveOfficeLive();
  }, 900);
}

async function autoSaveOfficeLive() {
  if (!B.editing || !B.editOffice) return;
  if (B.officeSaving) {
    scheduleOfficeAutoSave();
    return;
  }
  if (B.officeKind === 'xlsx') {
    const updates = [...B.officeDirty.values()];
    if (!updates.length) return;
    B.officeSaving = true;
    try {
      const r = await api('/api/office/xlsx/write', {
        method: 'POST',
        body: { path: B.filePath, updates, mtime: B.editMtime },
      });
      if (r?.mtime) B.editMtime = r.mtime;
      for (const u of updates) {
        const key = `${u.sheet}!${u.cell}`;
        if (B.officeDirty.get(key) === u) {
          B.officeDirty.delete(key);
          B.officeOriginal.get(u.sheet)?.set(key, u.value);
        }
      }
      B.editDirty = B.officeDirty.size > 0;
      refreshGridDirtyClasses();
      setOfficeStatus(B.editDirty ? 'AI 已写回一部分，继续保存中…' : 'AI 已直接修改并写回 Excel');
    } catch (e) {
      setOfficeStatus(`AI 改动已在编辑器，自动写回失败：${apiErrorText(e)}`);
    } finally {
      B.officeSaving = false;
      if (B.officeDirty.size) scheduleOfficeAutoSave();
    }
    return;
  }
  if (B.officeKind === 'csv') {
    if (!B.editDirty) return;
    B.officeSaving = true;
    const gen = B.officeEditGen || 0;
    try {
      const content = serializeDelimited(
        trimGrid(B.officeRows),
        B.officeDelim,
        B.officeNewline,
        B.officeBom
      );
      const r = await api('/api/files/write', {
        method: 'POST',
        body: { path: B.filePath, content, mtime: B.editMtime },
      });
      if (r?.mtime) B.editMtime = r.mtime;
      if (gen === (B.officeEditGen || 0)) {
        B.editDirty = false;
        B.officeDirty.clear();
        refreshGridDirtyClasses();
        setOfficeStatus('AI 已直接修改并写回 CSV');
      } else {
        B.editDirty = true;
        setOfficeStatus('AI 已写回，检测到新的修改，继续保存中…');
      }
    } catch (e) {
      setOfficeStatus(`AI 改动已在编辑器，自动写回失败：${apiErrorText(e)}`);
    } finally {
      B.officeSaving = false;
      if (B.editDirty) scheduleOfficeAutoSave();
    }
    return;
  }
  if (B.officeKind === 'pptx') {
    const updates = [...B.officeDirty].map((index) => {
      const ta = document.querySelector(`#fileContent textarea[data-index="${index}"]`);
      return { index, text: ta ? ta.value : B.officePptxItems.get(index) || '' };
    });
    if (!updates.length) return;
    B.officeSaving = true;
    try {
      const r = await api('/api/office/pptx/write', {
        method: 'POST',
        body: { path: B.filePath, paragraphs: updates, mtime: B.editMtime },
      });
      if (r?.mtime) B.editMtime = r.mtime;
      for (const u of updates) {
        const ta = document.querySelector(`#fileContent textarea[data-index="${u.index}"]`);
        if (ta && ta.value === u.text) {
          B.officeDirty.delete(u.index);
          B.officePptxItems.set(u.index, u.text);
        }
      }
      B.editDirty = B.officeDirty.size > 0;
      setOfficeStatus(B.editDirty ? 'AI 已写回一部分，继续保存中…' : 'AI 已直接修改并写回 PPT');
    } catch (e) {
      setOfficeStatus(`AI 改动已在编辑器，自动写回失败：${apiErrorText(e)}`);
    } finally {
      B.officeSaving = false;
      if (B.officeDirty.size) scheduleOfficeAutoSave();
    }
  }
}

function applyEditorOp(op) {
  if (op?.type === 'read') return editorSnapshot();
  if (op?.type === 'apply') return applyEditorOperations(op.operations || []);
  if (op?.type === 'set_cells') return applyEditorCells(op.cells || []);
  if (op?.type === 'set_paragraphs') return applyEditorParagraphs(op.paragraphs || []);
  return { ok: false, error: `未知编辑器操作：${op?.type || ''}` };
}

async function pollEditorOps() {
  if (B.editorPolling || !B.editing || !B.editorSessionId) return;
  B.editorPolling = true;
  const sid = B.editorSessionId;
  try {
    const result = await api(`/api/editor/poll?sessionId=${encodeURIComponent(sid)}`);
    for (const op of result.ops || []) {
      if (!B.editing || B.editorSessionId !== sid) break;
      let reply;
      try {
        reply = applyEditorOp(op);
      } catch (e) {
        reply = { ok: false, error: String(e?.message || e).slice(0, 500) };
      }
      try {
        await api('/api/editor/ack', {
          method: 'POST',
          body: { sessionId: sid, id: op.id, result: reply },
        });
      } catch {}
    }
  } catch {
  } finally {
    B.editorPolling = false;
  }
}


async function startEdit() {
  const p = B.filePath;
  if (!p || !isEditablePath(p)) return;
  if (B.editing) return;
  if (Number(B.fileMeta?.size) > 2 * 1024 * 1024 && !confirm('文件超过 2MB，编辑器可能卡顿，仍然打开？')) return;
  if (isPdfPath(p)) return startPdfEdit(p);
  if (isXlsxPath(p)) return startSheetEdit(p, 'xlsx');
  if (isCsvPath(p)) return startSheetEdit(p, 'csv');
  if (isPptxPath(p)) return startPptxEdit(p);
  const rich = isRichPath(p);
  const docx = isDocxPath(p);
  let text = '';
  let html = '';
  if (rich) {
    try {
      html = await loadEditorHtml(p);
    } catch (e) {
      toast(`读取失败：${apiErrorText(e)}`, 'err');
      return;
    }
  } else {
    try {
      text = await readFileText(p);
    } catch (e) {
      toast(`读取失败：${e.message}`, 'err');
      return;
    }
  }
  let mtime = Number(B.fileMeta?.mtime) || 0;
  if (!mtime) {
    try {
      const s = await api(`/api/files/stat?path=${encodeURIComponent(p)}`);
      mtime = Number(s.mtime) || 0;
    } catch {}
  }
  B.editing = true;
  B.editDirty = false;
  B.editMtime = mtime;
  B.editRich = rich;
  B.editDocx = docx;
  B.richRange = null;
  const content = $('#fileContent');
  if (rich) {
    content.innerHTML = `<div class="fv-editor">
      ${richToolbarHtml(docx)}
      <div class="fv-rich-scroll">
        <div class="fv-paper ${docx ? 'fv-paper-doc' : 'fv-paper-md'}">
          <div id="feRich" class="fv-rich ${docx ? 'fv-docx' : 'fv-markdown md-body'}" contenteditable="true" spellcheck="false">${html}</div>
        </div>
      </div>
    </div>`;
    wireRichToolbar();
    if (!docx) resolveEditorImages(p);
    $('#feSave').onclick = () => saveEdit();
    $('#feCancel').onclick = () => cancelEdit();
    setEditorStatus(docx ? 'Word 保存会简化排版' : '');
    $('#feRich').focus();
  } else {
    content.innerHTML = `<div class="fv-editor">
      <div class="fv-editor-bar">
        <button type="button" class="btn primary" id="feSave">保存</button>
        <button type="button" class="btn" id="feCancel">取消</button>
        <span class="fv-editor-note">纯文本 · ${MOD_KEY}S 保存</span>
        <span class="fv-editor-status" id="feStatus"></span>
      </div>
      <textarea id="feText" spellcheck="false"></textarea>
    </div>`;
    const ta = $('#feText');
    ta.value = text;
    ta.oninput = () => {
      B.editDirty = true;
      setEditorStatus();
    };
    $('#feSave').onclick = () => saveEdit();
    $('#feCancel').onclick = () => cancelEdit();
    setEditorStatus();
    ta.focus();
  }
  void registerEditorSession();
  ensureEditKeyHandler();
  startEditorWatch();
}

function exitEditMode() {
  stopEditorBridge();
  if (B.officeAutoTimer) {
    clearTimeout(B.officeAutoTimer);
    B.officeAutoTimer = 0;
  }
  B.editing = false;
  B.editDirty = false;
  B.editRich = false;
  B.editDocx = false;
  B.editOffice = false;
  B.editSave = null;
  B.liveAiEditedAt = 0;
  B.editFrontmatter = '';
  B.richRange = null;
  B.officeKind = '';
  B.officeBook = null;
  B.officeSheet = '';
  B.officeSheetCache = null;
  B.officeOriginal = null;
  B.officeDirty = null;
  B.officeRows = null;
  B.officeView = null;
  B.officePptx = null;
  B.officePptxItems = null;
  B.pdfEditData = null;
  B.editPdf = false;
  stopEditorWatch();
}

async function saveEdit() {
  if (!B.editing || B.editOffice) return;
  const rich = $('#feRich');
  const ta = $('#feText');
  if (!rich && !ta) return;
  const btn = $('#feSave');
  if (btn) btn.disabled = true;
  try {
    let r;
    if (rich) {
      if (B.editDocx) {
        if (!B.editDocxWarned) {
          if (
            !confirm(
              '保存会重新生成 Word 文件：标题、段落、列表、粗体等会保留，图片、表格样式和复杂排版会简化。继续？'
            )
          ) {
            return;
          }
          B.editDocxWarned = true;
        }
        setEditorStatus('保存中…');
        r = await api('/api/files/write-docx', {
          method: 'POST',
          body: { path: B.filePath, html: rich.innerHTML, mtime: B.editMtime },
        });
      } else {
        let md = '';
        try {
          md = (B.editFrontmatter || '') + richHtmlToMarkdown(editorHtmlForMarkdown());
        } catch (e) {
          toast(`Markdown 转换失败：${apiErrorText(e)}`, 'err');
          return;
        }
        setEditorStatus('保存中…');
        r = await api('/api/files/write', {
          method: 'POST',
          body: { path: B.filePath, content: md, mtime: B.editMtime },
        });
      }
    } else {
      setEditorStatus('保存中…');
      r = await api('/api/files/write', {
        method: 'POST',
        body: { path: B.filePath, content: ta.value, mtime: B.editMtime },
      });
    }
    if (r?.mtime) B.editMtime = r.mtime;
    exitEditMode();
    await openFileInPane(B.filePath);
    toast('已保存');
  } catch (e) {
    if (/409/.test(String(e.message))) {
      const s = await api(`/api/files/stat?path=${encodeURIComponent(B.filePath)}`).catch(() => null);
      if (s?.mtime) B.editMtime = s.mtime;
      toast('文件已被其他程序改过，按保存再试一次（会用你当前编辑器里的内容覆盖）', 'err');
    } else {
      toast(`保存失败：${apiErrorText(e)}`, 'err');
    }
    setEditorStatus();
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function cancelEdit() {
  if (!B.editing) return;
  if (B.editDirty && !confirm('有未保存的修改，确定放弃？')) return;
  const p = B.filePath;
  exitEditMode();
  await openFileInPane(p);
}

async function reloadEditorContent() {
  if (!B.editing) return;
  if (B.editRich) {
    const box = $('#feRich');
    if (!box) return;
    box.innerHTML = await loadEditorHtml(B.filePath);
    if (!B.editDocx) resolveEditorImages(B.filePath);
  } else {
    const ta = $('#feText');
    if (ta) ta.value = await readFileText(B.filePath);
  }
}

function startEditorWatch() {
  stopEditorWatch();
  editorWatcher = setInterval(async () => {
    if (!B.editing || !B.filePath) return stopEditorWatch();
    try {
      const s = await api(`/api/files/stat?path=${encodeURIComponent(B.filePath)}`);
      if (!s?.exists || !s.mtime) return;
      if (B.editMtime && Math.abs(Number(s.mtime) - B.editMtime) > 2) {
        if (B.editOffice) {
          if (B.editDirty) {
            setOfficeStatus('文件已被外部修改，当前有未保存修改');
            return;
          }
          if (B.officeKind === 'pdf') {
            await reloadPdfEditor();
            setOfficeStatus('PDF 已更新');
            return;
          }
          exitEditMode();
          await openFileInPane(B.filePath);
          toast('文件已被外部修改，已重新载入');
          return;
        }
        if (B.editDirty) {
          if (B.liveAiEditedAt && Date.now() - B.liveAiEditedAt < 30000) {
            B.editMtime = Number(s.mtime);
            setEditorStatus('AI 已直接修改编辑器（文件也已写回）');
            return;
          }
          setEditorStatus('文件已被 AI/外部修改，当前有未保存修改');
          return;
        }
        await reloadEditorContent();
        B.editMtime = Number(s.mtime);
        setEditorStatus('已载入外部修改');
      }
    } catch {}
  }, 2000);
}

function teardownVideo() {
  if (videoLiveTimer) {
    clearInterval(videoLiveTimer);
    videoLiveTimer = 0;
  }
}

function fmtTime(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function videoStatus(text) {
  const el = $('#fvVideoStatus');
  if (el) el.textContent = text;
}

function renderVideoTranscript(result, content) {
  const panel = $('#fvTranscript');
  if (!panel) return;
  panel.hidden = false;
  panel.innerHTML = '';
  if (result.summary) {
    const box = document.createElement('div');
    box.className = 'fv-tr-summary';
    box.textContent = result.summary;
    panel.appendChild(box);
  }
  const segs = result.segments || [];
  if (!segs.length) {
    panel.innerHTML = '<div class="usage-loading">没有识别到语音</div>';
    return;
  }
  for (const s of segs) {
    const row = document.createElement('div');
    row.className = 'fv-tr-seg';
    row.dataset.start = String(s.start || 0);
    const time = document.createElement('span');
    time.className = 'fv-tr-time';
    time.textContent = `${fmtTime(s.start)}`;
    const body = document.createElement('div');
    body.className = 'fv-tr-body';
    const orig = document.createElement('div');
    orig.className = 'fv-tr-text';
    orig.textContent = s.text;
    body.appendChild(orig);
    if (s.translation) {
      const tr = document.createElement('div');
      tr.className = 'fv-tr-trans';
      tr.textContent = s.translation;
      body.appendChild(tr);
    }
    row.append(time, body);
    row.onclick = () => {
      const video = $('#fvVideo');
      if (video) {
        video.currentTime = Number(s.start) || 0;
        video.play().catch(() => {});
      }
    };
    panel.appendChild(row);
  }
}

async function transcribeVideo(file, content) {
  const btn = $('#fvTranscribe');
  if (btn) btn.disabled = true;
  videoStatus('准备转写…');
  try {
    const first = await api('/api/video/transcribe', {
      method: 'POST',
      body: { path: file },
    });
    let result = first.result || null;
    if (!result) {
      const id = first.id;
      for (;;) {
        await new Promise((r) => setTimeout(r, 1000));
        const job = await api(`/api/video/transcribe/${id}`);
        videoStatus(`转写中 ${job.progress || 0}%`);
        if (job.status === 'error') throw new Error(job.error || '转写失败');
        if (job.status === 'done') {
          result = job.result;
          break;
        }
      }
    }
    renderVideoTranscript(result, content);
    videoStatus(
      result?.segments?.length
        ? `转写完成 · ${result.segments.length} 段`
        : '没有识别到语音'
    );
  } catch (e) {
    videoStatus(`转写失败：${apiErrorText(e)}`);
  } finally {
    if (btn) btn.disabled = false;
  }
}

function appendLiveSegments(segs) {
  const panel = $('#fvTranscript');
  if (!panel) return;
  panel.hidden = false;
  for (const s of segs || []) {
    const key = `${Math.round(s.start * 2)}|${s.text}`;
    if (panel.querySelector(`[data-live-key="${CSS.escape(key)}"]`)) continue;
    const row = document.createElement('div');
    row.className = 'fv-tr-seg';
    row.dataset.liveKey = key;
    row.dataset.start = String(s.start || 0);
    row.innerHTML = `<span class="fv-tr-time">${fmtTime(s.start)}</span><div class="fv-tr-body"><div class="fv-tr-text">${esc(
      s.text
    )}</div></div>`;
    row.onclick = () => {
      const video = $('#fvVideo');
      if (video) {
        video.currentTime = Number(s.start) || 0;
        video.play().catch(() => {});
      }
    };
    panel.appendChild(row);
  }
  panel.scrollTop = panel.scrollHeight;
}

function toggleLiveVideo(file) {
  const btn = $('#fvLive');
  const sub = $('#fvSubtitle');
  const video = $('#fvVideo');
  if (videoLiveTimer) {
    teardownVideo();
    if (btn) btn.textContent = '实时字幕';
    if (sub) sub.hidden = true;
    videoStatus('已停止实时字幕');
    return;
  }
  if (!video) return;
  if (btn) btn.textContent = '停止实时字幕';
  videoStatus('实时字幕中…（约 5–8 秒延迟）');
  let busy = false;
  const seen = new Set();
  const normalize = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '');
  videoLiveTimer = setInterval(async () => {
    if (busy || !video || video.paused || video.ended) return;
    busy = true;
    try {
      const r = await api('/api/video/live', {
        method: 'POST',
        body: {
          path: file,
          start: Math.max(0, video.currentTime - 2),
          duration: 8,
        },
      });
      const segs = (r.segments || []).filter((s) => {
        const key = normalize(s.text);
        if (key.length < 2 || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      const text = segs.map((s) => s.text).join(' ').trim();
      if (text && sub) {
        sub.dataset.liveText = text;
        sub.textContent = text;
        sub.hidden = false;
        translateApi([text])
          .then(([tr]) => {
            if (!tr || sub.dataset.liveText !== text) return;
            sub.textContent = `${text}\n${tr}`;
          })
          .catch(() => {});
      }
      appendLiveSegments(segs);
    } catch (e) {
      videoStatus(`实时字幕失败：${apiErrorText(e)}`);
    } finally {
      busy = false;
    }
  }, 4000);
}

function wireVideoTools(file, content) {
  teardownVideo();
  $('#fvTranscribe').onclick = () => transcribeVideo(file, content);
  $('#fvLive').onclick = () => toggleLiveVideo(file);
  const video = $('#fvVideo');
  if (video) {
    video.addEventListener('pause', () => {
      const sub = $('#fvSubtitle');
      if (sub) sub.hidden = true;
    });
  }
}

async function renderFile(p, meta) {
  updateEditButton(isEditablePath(p));
  const content = $('#fileContent');
  const head = $('#fileHead');
  if (!content) return;
  const name = fileBase(p);
  const ext = (meta.ext || fileExt(p)).toLowerCase();
  const kind = fileKind(p);
  const raw = fileRawUrl(p);
  const icon = fileIconFor(p);

  const paneIcon = $('#paneFileIcon');
  if (paneIcon) paneIcon.textContent = icon;
  const paneName = $('#paneFileName');
  if (paneName) paneName.textContent = name;

  const zoomable = kind === 'image';
  const zoomBar = $('#paneZoom');
  if (zoomBar) zoomBar.hidden = !zoomable;

  if (kind === 'image') {
    content.innerHTML = `<div class="fv-image-wrap"><img id="fvImage" src="${raw}" alt="${esc(
      name
    )}" /></div>`;
    const imgEl = $('#fvImage');
    const wrapEl = content.querySelector('.fv-image-wrap');
    B.fileZoom = 1;
    if (imgEl) {
      imgEl.addEventListener('load', () => {
        B.fileZoom = fitImageZoom();
        applyFileZoom();
      });
    }
    if (wrapEl && imgEl) {
      let panning = false;
      let startX = 0;
      let startY = 0;
      let startLeft = 0;
      let startTop = 0;
      wrapEl.addEventListener('pointerdown', (e) => {
        if (!wrapEl.classList.contains('is-zoomed') || e.button !== 0) return;
        panning = true;
        startX = e.clientX;
        startY = e.clientY;
        startLeft = wrapEl.scrollLeft;
        startTop = wrapEl.scrollTop;
        wrapEl.classList.add('panning');
        wrapEl.setPointerCapture?.(e.pointerId);
      });
      wrapEl.addEventListener('pointermove', (e) => {
        if (!panning) return;
        wrapEl.scrollLeft = startLeft - (e.clientX - startX);
        wrapEl.scrollTop = startTop - (e.clientY - startY);
        e.preventDefault();
      });
      const endPan = () => {
        panning = false;
        wrapEl.classList.remove('panning');
      };
      wrapEl.addEventListener('pointerup', endPan);
      wrapEl.addEventListener('pointercancel', endPan);
    }
    applyFileZoom();
    return;
  }
  if (kind === 'pdf') {
    await renderPdfViewer(p, content);
    return;
  }
  if (kind === 'video') {
    content.innerHTML = `<div class="fv-video">
      <div class="fv-video-stage">
        <video id="fvVideo" controls src="${raw}"></video>
        <div class="fv-subtitle" id="fvSubtitle" hidden></div>
      </div>
      <div class="fv-video-bar">
        <button type="button" class="btn" id="fvTranscribe">转写全文</button>
        <button type="button" class="btn" id="fvLive">实时字幕</button>
        <span class="fv-video-status" id="fvVideoStatus"></span>
      </div>
      <div class="fv-transcript" id="fvTranscript" hidden></div>
    </div>`;
    wireVideoTools(p, content);
    return;
  }
  if (kind === 'audio') {
    content.innerHTML = `<div class="fv-media fv-audio"><div class="fv-audio-icon">🎵</div><audio controls autoplay src="${raw}"></audio><div class="fv-empty-sub">${esc(
      name
    )}</div></div>`;
    return;
  }
  if (kind === 'markdown') {
    try {
      const text = await readFileText(p);
      const big = text.length > 1200000;
      const shown = big ? text.slice(0, 1200000) : text;
      const note = big
        ? `<div class="fv-note"><span>文件较大，已显示前 ${fmtChars(
            shown.length
          )}（共 ${fmtChars(text.length)}）</span><button type="button" class="link-btn" id="fvMdOpen">用默认应用打开</button></div>`
        : '';
      content.innerHTML = `${note}<div class="fv-paper fv-paper-md"><div class="fv-markdown md-body">${window.renderMarkdown(
        normalizeMarkdown(shown),
        { breaks: false }
      )}</div></div>`;
      const mdOpen = $('#fvMdOpen');
      if (mdOpen) mdOpen.onclick = () => openLocalFile(p, 'open');
      // Markdown 里引用的本地图片，按文件所在目录解析后直接显示
      enhanceMermaid(content);
      content.querySelectorAll('.fv-markdown img').forEach((img) => {
        img.addEventListener('error', () => img.classList.add('is-broken'));
        const src = img.getAttribute('src') || '';
        if (!src || /^(https?:|data:|blob:)/i.test(src)) return;
        const clean = decodeURIComponent(src.split('#')[0].split('?')[0]);
        const isAbs = /^([A-Za-z]:[\\/]|\\\\|\/)/.test(clean);
        const sepIdx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
        const abs = isAbs
          ? clean
          : (sepIdx >= 0 ? p.slice(0, sepIdx + 1) : '') + clean.replace(/^\.[\\/]/, '');
        img.src = fileRawUrl(abs);
      });
      content.querySelectorAll('img').forEach((img) => {
        img.loading = 'lazy';
      });
    } catch (e) {
      content.innerHTML = `<div class="fv-error"><div class="fv-empty-icon">⚠️</div><div class="fv-empty-title">无法预览 Markdown</div><div class="fv-empty-sub">${esc(
        String(e.message || e)
      )}</div></div>`;
    }
    return;
  }
  if (kind === 'csv') {
    try {
      const text = await readFileText(p);
      content.innerHTML = `<div class="fv-doc fv-doc-table">${renderCsvTable(
        text,
        ext === 'tsv' ? '\t' : ','
      )}</div>`;
    } catch (e) {
      content.innerHTML = `<div class="fv-error"><div class="fv-empty-sub">${esc(String(e.message || e))}</div></div>`;
    }
    return;
  }
  if (kind === 'json') {
    try {
      const text = await readFileText(p);
      let pretty = text;
      try {
        pretty = JSON.stringify(JSON.parse(text), null, 2);
      } catch {}
      content.innerHTML = `<div class="fv-doc"><pre class="fv-code"><code>${esc(
        pretty.slice(0, 2000000)
      )}</code></pre></div>`;
    } catch (e) {
      content.innerHTML = `<div class="fv-error"><div class="fv-empty-sub">${esc(String(e.message || e))}</div></div>`;
    }
    return;
  }
  if (kind === 'text') {
    if (meta.size > 40 * 1024 * 1024) {
      content.innerHTML = `<div class="fv-error"><div class="fv-empty-icon">📄</div><div class="fv-empty-title">文件较大（${fmtSize(
        meta.size
      )}）</div><div class="fv-empty-sub">超过 40 MB，为了不卡住界面，请用默认应用打开。</div><div class="fv-error-actions"><button class="btn" id="fvOpenExternal2">默认应用打开</button></div></div>`;
      $('#fvOpenExternal2').onclick = () => openLocalFile(p, 'open');
      return;
    }
    try {
      const text = await readFileText(p);
      const isHtml = /^(html?|xhtml)$/i.test(ext);
      const prose = ['txt', 'log', 'srt', 'vtt', 'text'].includes(ext);
      const note = isHtml
        ? `<div class="fv-note"><span>这是网页源码</span><button type="button" class="btn primary fv-note-btn" id="fvPreviewHtml">在浏览器里预览</button><span class="fv-note-hint" id="fvPreviewHint"></span></div>`
        : '';
      const body = prose
        ? `<div class="fv-paper"><div class="fv-prose" id="fvTextCode"></div></div>`
        : `<div class="fv-doc"><pre class="fv-code" id="fvTextCode"></pre></div>`;
      content.innerHTML = `${note}${body}
        <div class="fv-more" id="fvMore" hidden><button type="button" class="btn" id="fvMoreBtn">继续加载</button><span id="fvMoreInfo"></span></div>`;
      mountTextChunks(text, prose);
      const preview = $('#fvPreviewHtml');
      if (preview) {
        preview.onclick = async () => {
          const hint = $('#fvPreviewHint');
          preview.disabled = true;
          if (hint) hint.textContent = '正在准备…';
          try {
            const r = await api(`/api/files/preview?path=${encodeURIComponent(p)}`);
            if (hint) hint.textContent = '';
            setPaneMode('browser');
            navigateBrowser(r.url);
          } catch (e) {
            if (hint) hint.textContent = `预览失败：${e.message}`;
          } finally {
            preview.disabled = false;
          }
        };
      }
    } catch (e) {
      content.innerHTML = `<div class="fv-error"><div class="fv-empty-sub">${esc(String(e.message || e))}</div></div>`;
    }
    return;
  }

  if (ext === 'docx' && window.mammoth) {
    content.innerHTML = `<div class="fv-loading"><span class="fv-spinner"></span>正在解析 Word 文档…</div>`;
    try {
      const buf = await (await fetch(fileRawUrl(p), { cache: 'no-store' })).arrayBuffer();
      const doc = await window.mammoth.convertToHtml(
        { arrayBuffer: buf },
        {
          convertImage: window.mammoth.images.imgElement((image) =>
            image
              .read('base64')
              .then((b64) => ({ src: `data:${image.contentType};base64,${b64}` }))
          ),
        }
      );
      const clean = window.DOMPurify
        ? window.DOMPurify.sanitize(doc.value, { USE_PROFILES: { html: true } })
        : doc.value;
      content.innerHTML = `<div class="fv-note"><span>Word 文档预览</span><button type="button" class="link-btn" id="fvWordOpen">用默认应用打开</button></div>
        <div class="fv-paper fv-paper-doc"><div class="fv-docx">${clean}</div></div>`;
      const wordOpen = $('#fvWordOpen');
      if (wordOpen) wordOpen.onclick = () => openLocalFile(p, 'open');
      return;
    } catch (e) {
      console.warn('Word 解析失败，退回纯文本', e);
    }
  }

  if ((ext === 'xlsx' || ext === 'xls') && window.XLSX) {
    content.innerHTML = `<div class="fv-loading"><span class="fv-spinner"></span>正在读取表格…</div>`;
    try {
      const buf = await (await fetch(fileRawUrl(p), { cache: 'no-store' })).arrayBuffer();
      const wb = window.XLSX.read(buf, { type: 'array' });
      renderXlsx(wb, content, p);
      return;
    } catch (e) {
      console.warn('表格解析失败', e);
    }
  }

  if (ext === 'pptx' && window.pptxPreview) {
    content.innerHTML = `<div class="fv-loading"><span class="fv-spinner"></span>正在渲染幻灯片…</div>`;
    try {
      const buf = await (await fetch(fileRawUrl(p), { cache: 'no-store' })).arrayBuffer();
      const width = Math.max(360, content.clientWidth - 48);
      const height = Math.round((width * 9) / 16);
      content.innerHTML = `<div class="ppt-view"><div class="ppt-note">只读预览 · 幻灯片里的文字可以直接选中</div><div class="ppt-stage" id="pptStage"></div></div>`;
      const stage = $('#pptStage');
      const previewer = window.pptxPreview.init(stage, { width, height });
      await previewer.preview(buf);
      // 库默认把画布限制成一页高度，这里放开，让所有幻灯片顺序排列、外层滚动
      const wrapper = stage.querySelector('.pptx-preview-wrapper');
      if (wrapper) {
        wrapper.style.height = 'auto';
        wrapper.style.maxHeight = 'none';
        wrapper.style.overflow = 'visible';
        wrapper.querySelectorAll('.pptx-preview-slide-wrapper').forEach((slide) => {
          slide.style.marginBottom = '18px';
        });
      }
      return;
    } catch (e) {
      console.warn('PPT 渲染失败', e);
    }
  }

  if (['doc', 'docx', 'rtf', 'rtfd', 'odt', 'webarchive', 'pages', 'key', 'numbers'].includes(ext)) {
    content.innerHTML = `<div class="fv-loading"><span class="fv-spinner"></span>正在提取文字…</div>`;
    try {
      const r = await api(`/api/files/text?path=${encodeURIComponent(p)}&max=200000`);
      const text = String(r.text || '');
      if (text.trim()) {
        content.innerHTML = `<div class="fv-note"><span>已提取文档文字，排版可能与原文件不同</span><button type="button" class="link-btn" id="fvOfficeOpen">用默认应用打开</button></div>
          <div class="fv-paper"><div class="fv-prose" id="fvOfficeText"></div></div>`;
        const pre = $('#fvOfficeText');
        if (pre) pre.appendChild(buildProseFragment(text.slice(0, 200000)));
        const openBtn = $('#fvOfficeOpen');
        if (openBtn) openBtn.onclick = () => openLocalFile(p, 'open');
        return;
      }
    } catch {}
  }

  // 二进制 / Office：先用 macOS Quick Look 生成缩略图
  content.innerHTML = `<div class="fv-quicklook"><div class="fv-loading"><span class="fv-spinner"></span>正在生成预览…</div></div>
    <div class="fv-meta-line">${esc(name)} · ${fmtSize(meta.size)}</div>
    <div class="fv-fallback-actions">
      <button type="button" class="btn" id="fvOpenExternal3">用默认应用打开</button>
      <button type="button" class="btn ghost" id="fvReveal3">在访达中显示</button>
    </div>`;
  const openBtn = $('#fvOpenExternal3');
  if (openBtn) openBtn.onclick = () => openLocalFile(p, 'open');
  const revealBtn = $('#fvReveal3');
  if (revealBtn) revealBtn.onclick = () => openLocalFile(p, 'reveal');
  const box = content.querySelector('.fv-quicklook');
  const img = new Image();
  img.alt = name;
  img.onload = () => {
    if (!box) return;
    box.innerHTML = '';
    box.appendChild(img);
  };
  img.onerror = () => {
    if (!box) return;
    box.innerHTML = `<div class="fv-empty-icon">${icon}</div><div class="fv-empty-title">这个格式暂时不能内嵌预览</div><div class="fv-empty-sub">可以用默认应用打开，或者在访达中查看。</div>`;
  };
  img.src = fileThumbUrl(p);
}

function normalizeMarkdown(raw) {
  return String(raw)
    .split('\n')
    .map((line) => {
      const m = /^(\s{4,})([-*+]|\d{1,3}[.)])\s+/.exec(line);
      if (!m) return line;
      const level = Math.max(2, Math.min(14, Math.floor(m[1].length / 2)));
      return ' '.repeat(level) + line.slice(m[1].length);
    })
    .join('\n');
}

const TEXT_BATCH = 200000;

function fmtChars(n) {
  const v = Number(n) || 0;
  return v >= 10000 ? `${(v / 10000).toFixed(1)} 万字` : `${v} 字`;
}

// 大文本按 20 万字一批渲染：首屏先给 40 万字，
// 滚到底部附近再追加下一批，几 MB 的小说也能秒开、滚动条不跳。
function buildProseFragment(text) {
  const frag = document.createDocumentFragment();
  const terminal = /[。！？!?…」』】]$/;
  let buf = '';
  const flush = () => {
    if (!buf) return;
    const p = document.createElement('p');
    p.textContent = buf;
    frag.appendChild(p);
    buf = '';
  };
  const addBlock = (tag, line) => {
    flush();
    const el = document.createElement(tag);
    el.textContent = line;
    frag.appendChild(el);
  };
  for (const raw of String(text).split('\n')) {
    const line = raw.replace(/\r/g, '').trim();
    if (!line) {
      flush();
      continue;
    }
    const short = line.length <= 42;
    const heading =
      short && /^(第[0-9一二三四五六七八九十百千]+[章节回卷部篇]|Chapter\b)/i.test(line);
    const sub =
      !heading &&
      short &&
      (/^([一二三四五六七八九十百]+、|（[一二三四五六七八九十百]+）)/.test(line) ||
        /^(?![0-9]+\.[0-9])[0-9]{1,2}[.、]\s*\S/.test(line));
    if (heading) {
      addBlock('h3', line);
      continue;
    }
    if (sub) {
      addBlock('h4', line);
      continue;
    }
    if (buf) {
      buf +=
        /[A-Za-z0-9]$/.test(buf) && /^[A-Za-z0-9]/.test(line) ? ` ${line}` : line;
      if (terminal.test(line) || buf.length > 3000) flush();
      continue;
    }
    if (line.length <= 30 && !/[，,、；;：:]$/.test(line)) {
      flush();
      const el = document.createElement('p');
      el.className = 'fv-line';
      el.textContent = line;
      frag.appendChild(el);
      continue;
    }
    buf = line;
    if (terminal.test(line)) flush();
  }
  flush();
  return frag;
}

function appendTextBatch() {
  const st = B.textState;
  if (!st) return;
  const more = $('#fvMore');
  const btn = $('#fvMoreBtn');
  const info = $('#fvMoreInfo');
  const total = st.text.length;
  if (st.at >= total) {
    if (btn) btn.hidden = true;
    if (info) info.textContent = `全文 ${fmtChars(total)}`;
    return;
  }
  let end = Math.min(total, st.at + TEXT_BATCH);
  if (end < total) {
    const cut = st.text.lastIndexOf('\n', end);
    if (cut > st.at + TEXT_BATCH * 0.4) end = cut + 1;
  }
  const block = document.createElement('div');
  block.className = 'fv-chunk';
  if (st.prose) block.appendChild(buildProseFragment(st.text.slice(st.at, end)));
  else block.textContent = st.text.slice(st.at, end);
  st.code.appendChild(block);
  st.at = end;
  if (more) more.hidden = false;
  if (st.at >= total) {
    if (btn) btn.hidden = true;
    if (info) info.textContent = `全文 ${fmtChars(total)}`;
  } else {
    if (btn) btn.hidden = false;
    if (info) info.textContent = `已显示 ${fmtChars(st.at)} / ${fmtChars(total)} · 继续向下滚动自动加载`;
  }
}

function maybeLoadMoreText() {
  const st = B.textState;
  if (!st || st.at >= st.text.length) return;
  if (!st.code?.isConnected) {
    B.textState = null;
    return;
  }
  const box = $('#fileContent');
  if (!box) return;
  if (box.scrollTop + box.clientHeight > box.scrollHeight - 900) appendTextBatch();
}

function mountTextChunks(text, prose = false) {
  const code = $('#fvTextCode');
  const more = $('#fvMore');
  const btn = $('#fvMoreBtn');
  const info = $('#fvMoreInfo');
  if (!code) return;
  B.textState = { text: String(text || ''), at: 0, code, prose };
  if (more) more.hidden = text.length < 60000;
  if (btn) {
    btn.hidden = false;
    btn.textContent = '继续加载';
    btn.onclick = () => appendTextBatch();
  }
  appendTextBatch();
  appendTextBatch();
}

function fitImageZoom() {
  const img = $('#fvImage');
  const wrap = img?.closest('.fv-image-wrap');
  const nw = img?.naturalWidth || 0;
  if (!img || !wrap || !nw) return 1;
  const avail = Math.max(160, wrap.clientWidth - 36);
  return Math.min(1, Math.max(0.05, avail / nw));
}

function applyFileZoom() {
  const img = $('#fvImage');
  const label = $('#fileZoomLabel');
  if (!img) return;
  const nw = img.naturalWidth || 0;
  if (nw) {
    img.style.width = `${Math.max(28, Math.round(nw * B.fileZoom))}px`;
    img.style.maxWidth = 'none';
    img.style.maxHeight = 'none';
    img.style.height = 'auto';
  }
  const pct = Math.round(B.fileZoom * 100);
  if (label) label.textContent = `${pct}%`;
  const wrap = img.closest('.fv-image-wrap');
  if (wrap) wrap.classList.toggle('is-zoomed', B.fileZoom > fitImageZoom() * 1.05);
}

function zoomFile(delta) {
  B.fileZoom = Math.min(6, Math.max(0.05, Math.round((B.fileZoom + delta) * 20) / 20));
  applyFileZoom();
}

function setupPaneDrops() {
  const pane = $('#browserPane');
  const hint = $('#paneDropHint');
  if (!pane) return;
  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  pane.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    depth += 1;
    if (hint) hint.hidden = false;
  });
  pane.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    if (hint) hint.hidden = false;
  });
  pane.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    e.stopPropagation();
    depth = Math.max(0, depth - 1);
    if (!depth && hint) hint.hidden = true;
  });
  pane.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    depth = 0;
    if (hint) hint.hidden = true;
    const files = [...(e.dataTransfer?.files || [])];
    const p = droppedFilePath(files[0]);
    if (p) openFileInPane(p);
    else toast('没拿到文件路径，换一个文件试试', 'err');
  });
}

function initBrowser() {
  B.view = document.querySelector('#browserView');
  const fallback = $('#browserFallback');
  if (!B.supported || !B.view || typeof B.view.loadURL !== 'function') {
    B.supported = false;
    if (B.view) B.view.style.display = 'none';
    if (fallback) fallback.hidden = false;
    return;
  }
  if (fallback) fallback.hidden = true;

  try {
    B.view.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
    );
  } catch {}

  B.view.addEventListener('dom-ready', () => {
    B.ready = true;
    syncBrowserUrl();
    if (B.theme === 'light') applyPaneTheme('light');
  });
  B.view.addEventListener('did-navigate', () => {
    syncBrowserUrl();
    resetPageTranslationOnNavigate();
  });
  B.view.addEventListener('did-navigate-in-page', syncBrowserUrl);
  B.view.addEventListener('did-start-loading', () => setBrowserStatus('加载中…'));
  B.view.addEventListener('did-stop-loading', () => {
    syncBrowserUrl();
    setBrowserStatus('');
  });
  B.view.addEventListener('did-fail-load', (e) => {
    if (e.errorCode !== -3) setBrowserStatus(`加载失败：${e.errorDescription || e.errorCode}`);
  });
  B.view.addEventListener('new-window', (e) => {
    if (!e.url) return;
    try {
      e.preventDefault();
    } catch {}
    navigateBrowser(e.url);
  });

  applyPaneTheme(localStorage.getItem('bt.pane.theme') || 'dark');
  applyPaneSide(localStorage.getItem('bt.pane.side') || 'right');
  const storedMode = localStorage.getItem('bt.pane.mode') || 'browser';
  setPaneMode(storedMode);

  if (localStorage.getItem('bt.browser.open') === '1') {
    let storedUrl = localStorage.getItem('bt.browser.url') || '/start.html';
    if (isPreviewUrl(storedUrl)) storedUrl = '/start.html';
    if (storedMode === 'browser') {
      setBrowserOpen(true, storedUrl);
    } else {
      setBrowserOpen(true);
      if (B.supported && storedUrl) {
        try {
          B.view.loadURL(storedUrl);
        } catch {}
      }
    }
  }
}

function initBrowserResizer() {
  const resizer = $('#browserResizer');
  const pane = $('#browserPane');
  if (!resizer || !pane) return;
  let drag = null;
  const overlay = document.createElement('div');
  overlay.className = 'pane-drag-overlay';
  overlay.hidden = true;
  document.body.appendChild(overlay);

  const appWidth = () =>
    document.querySelector('.app')?.clientWidth || window.innerWidth || document.documentElement.clientWidth;
  const clampWidth = (w) => {
    const app = appWidth();
    const sidebar = document.querySelector('.sidebar')?.offsetWidth || 0;
    const sidebarHidden = document.body.classList.contains('sidebar-hidden');
    // 侧栏收起时，聊天栏可以缩到接近一个侧栏的宽度
    const minChat = sidebarHidden ? 220 : app < 1100 ? 320 : 380;
    const maxPct = sidebarHidden ? 0.82 : 0.62;
    // 视觉上只有 1px 的分隔线，另外 10px 是透明拖拽热区
    const max = Math.max(200, Math.min(app * maxPct, app - sidebar - minChat - 2));
    return Math.max(sidebarHidden ? 200 : 240, Math.min(max, w));
  };
  const setWidth = (w, save = false) => {
    const pw = clampWidth(w);
    pane.style.flexBasis = `${pw}px`;
    if (save) localStorage.setItem('bt.browser.width', String(Math.round(pw)));
    scheduleChatCompact();
  };
  B.setPaneWidth = (w, save = false) => setWidth(w, save);
  B.clampPane = () => {
    if (!pane.hidden) setWidth(pane.getBoundingClientRect().width);
  };
  let pendingWidth = 0;
  let widthRaf = 0;
  const flushWidth = () => {
    widthRaf = 0;
    if (pendingWidth) setWidth(pendingWidth);
  };
  const onMove = (e) => {
    if (!drag) return;
    const left = document.body.classList.contains('pane-left');
    const dx = e.clientX - drag.x;
    // 一帧只改一次宽度，避免 pointermove 高频触发整页重排
    pendingWidth = left ? drag.w + dx : drag.w - dx;
    if (!widthRaf) widthRaf = requestAnimationFrame(flushWidth);
  };
  const end = () => {
    if (!drag) return;
    // 把最后一帧还没落地的宽度补上，避免快速拖动时松手位置被丢掉
    if (pendingWidth) setWidth(pendingWidth);
    drag = null;
    if (widthRaf) cancelAnimationFrame(widthRaf);
    widthRaf = 0;
    pendingWidth = 0;
    overlay.hidden = true;
    document.body.classList.remove('pane-resizing');
    document.body.style.userSelect = '';
    setWidth(pane.getBoundingClientRect().width, true);
  };
  resizer.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    drag = { x: e.clientX, w: pane.getBoundingClientRect().width };
    overlay.hidden = false;
    document.body.classList.add('pane-resizing');
    document.body.style.userSelect = 'none';
    try {
      resizer.setPointerCapture(e.pointerId);
    } catch {}
    e.preventDefault();
  });
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);
  window.addEventListener('blur', end);
  window.addEventListener('resize', () => {
    B.clampPane?.();
    scheduleChatCompact();
  });
  // 侧栏宽度有动画，光靠 window.resize 不够；用 ResizeObserver 每次布局变化都重新夹住面板宽度
  if (typeof ResizeObserver !== 'undefined') {
    let roTimer = 0;
    const ro = new ResizeObserver(() => {
      // 侧栏有 0.2s 动画，等布局稳定后再夹一次，避免动画期间每帧重排
      clearTimeout(roTimer);
      roTimer = setTimeout(() => {
        B.clampPane?.();
        scheduleChatCompact();
      }, 120);
    });
    const appEl = document.querySelector('.app');
    if (appEl) ro.observe(appEl);
    const sideEl = document.querySelector('.sidebar');
    if (sideEl) ro.observe(sideEl);
  }
  resizer.addEventListener('dblclick', () => {
    const app = appWidth();
    const sidebar = document.querySelector('.sidebar')?.getBoundingClientRect().width || 0;
    setWidth((app - sidebar) * 0.48, true);
  });
  resizer.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const left = document.body.classList.contains('pane-left');
    const grow = e.key === (left ? 'ArrowRight' : 'ArrowLeft');
    setWidth(pane.getBoundingClientRect().width + (grow ? 24 : -24), true);
  });
}

function setBrowserOpen(open, url, loadStart = true) {
  B.open = open;
  $('#browserPane').hidden = !open;
  $('#browserResizer').hidden = !open;
  $('#browserToggle')?.classList.toggle('active', open);
  document.body.classList.toggle('pane-open', !!open);
  localStorage.setItem('bt.browser.open', open ? '1' : '0');
  scheduleChatCompact();
  if (!open) {
    stopFileWatch();
    teardownVideo();
    exitEditMode();
    clearPaneSelection();
    return;
  }
  setTimeout(() => {
    B.clampPane?.();
    scheduleChatCompact();
  }, 0);
  setTimeout(() => {
    B.clampPane?.();
    scheduleChatCompact();
  }, 280);
  if (B.mode === 'file' && !B.filePath) renderFileEmpty();
  if (url && B.mode === 'browser') {
    navigateBrowser(url);
    return;
  }
  if (B.mode !== 'browser') return;
  if (!loadStart || !B.supported) return;
  let current = '';
  try {
    current = B.view.getURL();
  } catch {}
  if (!current || current === 'about:blank') navigateBrowser('/start.html');
}

const PREVIEW_URL_RE = /^http:\/\/127\.0\.0\.1:\d+\/f\//;

function isPreviewUrl(u) {
  return PREVIEW_URL_RE.test(String(u || ''));
}

function normalizeBrowserUrl(input) {
  const s = String(input || '').trim();
  if (!s) return '';
  if (/^(https?|about):/i.test(s)) return s;
  if (s.startsWith('/')) return new URL(s, location.href).href;
  if (/^[\w-]+(\.[\w-]+)+([/?#]|$)/.test(s)) return `https://${s}`;
  return `https://www.bing.com/search?q=${encodeURIComponent(s)}`;
}

function navigateBrowser(input) {
  const raw = String(input || '').trim();
  if (!raw) return;
  if (/^file:\/\//i.test(raw)) {
    try {
      const p = decodeURIComponent(new URL(raw).pathname);
      openFileInPane(p);
      return;
    } catch {}
  }
  clearPaneSelection();
  if (B.mode !== 'browser') setPaneMode('browser');
  const url = normalizeBrowserUrl(raw);
  if (!url) return;
  const start = new URL('/start.html', location.href).href;
  if (url !== start && !isPreviewUrl(url)) localStorage.setItem('bt.browser.url', url);
  $('#browserUrl').value = url === start ? '' : url;
  if (!B.supported) return;
  try {
    if (B.ready) B.view.loadURL(url);
    else B.view.src = url;
  } catch (e) {
    setBrowserStatus(`打开失败：${e.message}`);
  }
}

function syncBrowserUrl() {
  if (!B.supported) return;
  let u = '';
  try {
    u = B.view.getURL();
  } catch {}
  if (!u || u === 'about:blank') return;
  const start = new URL('/start.html', location.href).href;
  $('#browserUrl').value = u === start ? '' : u;
  if (/^https?:/i.test(u) && !isPreviewUrl(u)) localStorage.setItem('bt.browser.url', u);
}

let browserStatusTimer = null;
function setBrowserStatus(text) {
  const el = $('#browserStatus');
  if (!el) return;
  el.textContent = text || '';
  if (browserStatusTimer) clearTimeout(browserStatusTimer);
  if (text) {
    browserStatusTimer = setTimeout(() => {
      el.textContent = '';
    }, 8000);
  }
}

function waitBrowserLoad(ms = 10000) {
  return new Promise((resolve) => {
    if (!B.supported || !B.view) return resolve();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      B.view.removeEventListener('did-stop-loading', finish);
      resolve();
    };
    B.view.addEventListener('did-stop-loading', finish);
    setTimeout(finish, ms);
  });
}

async function extractPage() {
  if (!B.supported || !B.view) throw new Error('没有内置浏览器');
  const data = await Promise.race([
    B.view.executeJavaScript(`(() => {
      const links = [...document.querySelectorAll('a[href]')].slice(0, 40)
        .map(a => ({ text: (a.innerText || '').trim().slice(0, 80), href: a.href }))
        .filter(x => x.text && /^https?:/i.test(x.href));
      return {
        url: location.href,
        title: document.title || '',
        text: (document.body ? document.body.innerText : '').slice(0, 8000),
        links
      };
    })()`),
    new Promise((_, reject) => setTimeout(() => reject(new Error('读取页面超时')), 8000)),
  ]);
  return { ok: true, ...data };
}

async function findLocalFiles(name) {
  const r = await api(`/api/files/find?name=${encodeURIComponent(String(name || '').trim())}`);
  return r.files || [];
}

async function resolveLocalFileArg(raw) {
  const value = String(raw || '').trim();
  if (!value) throw new Error('缺少文件路径或文件名');
  if (/^([A-Za-z]:[\\/]|\\\\|\/|~[\\/])/.test(value)) return { path: value, files: [] };
  const files = await findLocalFiles(value);
  if (!files.length) throw new Error(`没找到文件：${value}`);
  return { path: files[0].path, files };
}

async function executeBrowserCommand(cmd) {
  const action = cmd.action;
  const args = String(cmd.args || '').trim();
  if (action === 'file_find') {
    const found = await resolveLocalFileArg(args);
    await openFileInPane(found.path);
    return {
      ok: true,
      kind: 'file',
      action: 'find',
      path: found.path,
      title: fileBase(found.path),
      files: found.files,
      text: `已在右侧文件查看器打开：${found.path}`,
    };
  }
  if (action === 'file_open') {
    const found = await resolveLocalFileArg(args);
    await openFileInPane(found.path);
    return {
      ok: true,
      kind: 'file',
      action: 'open',
      path: found.path,
      title: fileBase(found.path),
      files: found.files,
      text: `已在右侧文件查看器打开：${found.path}`,
    };
  }
  if (action === 'file_read') {
    const found = await resolveLocalFileArg(args);
    const check = await api('/api/files/check', { method: 'POST', body: { paths: [found.path] } });
    const meta = check.files?.[0];
    if (!meta?.exists) throw new Error('文件不存在');
    if (meta.isDir) throw new Error('这是一个目录');
    const ext = fileExt(found.path);
    if (!FILE_TEXT_EXTS.has(ext)) throw new Error('这个文件不是纯文本，无法直接读取；可以先用 FILE open 打开查看');
    if (meta.size > 2 * 1024 * 1024) throw new Error('文件太大（超过 2MB），请用 FILE open 打开查看');
    const text = await readFileText(found.path);
    await openFileInPane(found.path);
    return {
      ok: true,
      kind: 'file',
      action: 'read',
      path: found.path,
      title: fileBase(found.path),
      files: found.files,
      text: text.slice(0, 12000),
    };
  }
  if (action === 'open') {
    if (!args) throw new Error('缺少网址');
    navigateBrowser(args);
    await waitBrowserLoad(12000);
    return extractPage();
  }
  if (action === 'read') return extractPage();
  if (action === 'click') {
    if (!args) throw new Error('缺少 CSS 选择器');
    const ok = await B.view.executeJavaScript(
      `(() => { const el = document.querySelector(${JSON.stringify(
        args
      )}); if (!el) return false; el.click(); return true; })()`
    );
    if (!ok) throw new Error(`找不到元素：${args}`);
    await waitBrowserLoad(4000);
    return extractPage();
  }
  if (action === 'type') {
    const idx = args.indexOf('|||');
    if (idx < 0) throw new Error('格式应为：选择器 ||| 要输入的文字');
    const sel = args.slice(0, idx).trim();
    const text = args.slice(idx + 3).trim();
    const ok = await B.view.executeJavaScript(
      `(() => { const el = document.querySelector(${JSON.stringify(
        sel
      )}); if (!el) return false; el.focus(); el.value = ${JSON.stringify(
        text
      )}; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`
    );
    if (!ok) throw new Error(`找不到输入框：${sel}`);
    return extractPage();
  }
  if (action === 'back') {
    B.view.goBack();
    await waitBrowserLoad(5000);
    return extractPage();
  }
  if (action === 'forward') {
    B.view.goForward();
    await waitBrowserLoad(5000);
    return extractPage();
  }
  if (action === 'reload') {
    B.view.reload();
    await waitBrowserLoad(8000);
    return extractPage();
  }
  throw new Error(`不支持的浏览器操作：${action}`);
}

async function postBrowserResult(id, data) {
  try {
    await api('/api/browser/result', { method: 'POST', body: { id, ...data } });
  } catch {}
}

async function handleBrowserCommand(cmd) {
  const isFile = String(cmd.action || '').startsWith('file_');
  setBrowserOpen(true, null, false);
  if (!B.supported && !isFile) {
    await postBrowserResult(cmd.id, { ok: false, error: '当前环境没有内置浏览器' });
    return;
  }
  setBrowserStatus(`AI：${browserCommandLabel(cmd)}`);
  try {
    const result = await executeBrowserCommand(cmd);
    await postBrowserResult(cmd.id, result);
    setBrowserStatus(
      result.kind === 'file'
        ? `AI 已打开文件：${result.title || result.path}`
        : `AI 已读取：${result.title || result.url}`
    );
  } catch (e) {
    await postBrowserResult(cmd.id, { ok: false, error: e.message });
    setBrowserStatus(`AI ${isFile ? '文件' : '浏览器'}操作失败：${e.message}`);
  }
}

function browserCommandLabel(cmd) {
  const a = cmd.action;
  if (a === 'file_open') return `打开文件 ${cmd.args || ''}`;
  if (a === 'file_find') return `查找文件 ${cmd.args || ''}`;
  if (a === 'file_read') return `读取文件 ${cmd.args || ''}`;
  if (a === 'open') return `打开 ${cmd.args || ''}`;
  return a;
}

function syncConnUI() {
  const pill = $('#connPill');
  if (!pill) return;
  pill.dataset.state = S.connOn ? 'on' : 'off';
  const text = $('#connText');
  if (text) text.textContent = S.connOn ? '在线' : '重连中';
}

function connectSSE() {
  const es = new EventSource('/api/events');
  const setConn = (on) => {
    S.connOn = !!on;
    syncConnUI();
  };
  es.onopen = () => setConn(true);
  es.onerror = () => setConn(false);
  es.addEventListener('message', (e) => {
    const { chatId, message } = JSON.parse(e.data);
    if (!S.messages[chatId]) S.messages[chatId] = [];
    S.messages[chatId].push(message);
    if (chatId === S.activeChatId) renderThread();
    if (
      message.type === 'text' &&
      message.senderId !== 'user' &&
      message.meta?.viaUser !== true &&
      botById(message.senderId)
    ) {
      playNotify();
    }
  });

  es.addEventListener('message-update', (e) => {
    const { chatId, message } = JSON.parse(e.data);
    const list = S.messages[chatId] || [];
    const idx = list.findIndex((m) => m.id === message.id);
    if (idx >= 0) list[idx] = message;
    else list.push(message);
    if (chatId === S.activeChatId) renderThread();
  });

  es.addEventListener('status', (e) => {
    const d = JSON.parse(e.data);
    const beforeSet = Object.keys(S.status[d.chatId] || {}).sort().join(',');
    S.status[d.chatId] ||= {};
    if (d.running) {
      const prev = S.status[d.chatId][d.botId] || {};
      S.status[d.chatId][d.botId] = {
        ...prev,
        botId: d.botId,
        name: d.name,
        queued: !!d.queued,
        startedAt: d.startedAt || prev.startedAt || Date.now(),
        preview: d.preview || prev.preview || '',
        step: d.step || prev.step || '',
        thinking: d.thinking || prev.thinking || '',
        live: d.live || prev.live || '',
      };
    } else {
      delete S.status[d.chatId][d.botId];
    }
    if (!Object.keys(S.status[d.chatId]).length) delete S.status[d.chatId];
    if (d.chatId === S.activeChatId) updateTyping();
    const afterSet = Object.keys(S.status[d.chatId] || {}).sort().join(',');
    if (beforeSet !== afterSet) renderSidebar();
  });

  es.addEventListener('bots', (e) => {
    S.bots = JSON.parse(e.data).bots;
    renderSidebar();
  });

  es.addEventListener('botGroups', (e) => {
    S.botGroups = JSON.parse(e.data).botGroups || [];
    renderSidebar();
  });

  es.addEventListener('roles', (e) => {
    S.roles = JSON.parse(e.data).roles || [];
  });

  es.addEventListener('agyProfiles', (e) => {
    S.agyProfiles = JSON.parse(e.data).profiles || [];
  });

  es.addEventListener('alert', (e) => {
    const d = JSON.parse(e.data);
    const bot = botById(d.botId);
    if (bot) {
      bot.alert = { type: d.type, text: d.text, chatId: d.chatId, at: Date.now() };
      renderSidebar();
    }
  });

  es.addEventListener('chats', (e) => {
    S.chats = JSON.parse(e.data).chats;
    if (
      S.wfChatId &&
      !$('#modalMask').hidden &&
      (document.querySelector('.wf2') || document.querySelector('.wf'))
    ) {
      const fresh = chatById(S.wfChatId);
      if (fresh?.workflow) {
        const prev = S.wfDraft ? `${S.wfDraft.status}:${S.wfDraft.currentNodeId}` : '';
        const next = `${fresh.workflow.status}:${fresh.workflow.currentNodeId}`;
        if (prev !== next) {
          // 只同步运行时状态，别把正在编辑的内容覆盖掉
          S.wfDraft.status = fresh.workflow.status;
          S.wfDraft.currentNodeId = fresh.workflow.currentNodeId;
          const flow = $('#wf2Flow');
          if (flow) flow.innerHTML = wf2FlowHtml(fresh, S.wfDraft);
        }
      }
    }
    renderSidebar();
    if (S.activeChatId) renderEffort();
    if (S.activeChatId) renderModelPill();
    if (S.activeChatId && !chatById(S.activeChatId)) {
      clearComposerDraft(S.activeChatId);
      const inp = $('#input');
      if (inp) {
        inp.value = '';
        inp.style.height = 'auto';
      }
      S.pendingAttachments = [];
      S.activeChatId = null;
      renderAttachChips();
      syncSendState();
      renderThread();
    }
    if (S.editingChatId && !$('#modalMask').hidden) {
      const fresh = chatById(S.editingChatId);
      if (fresh) {
        const fl = $('#gFileList');
        if (fl) fl.innerHTML = groupFilesHtml(fresh.files);
        const lg = document.querySelector('#modal .group-log');
        if (lg) lg.innerHTML = groupLogHtml(fresh);
      }
    }
  });

  es.addEventListener('settings', (e) => {
    S.settings = JSON.parse(e.data).settings;
    applyWallpaper();
    renderSidebar();
    if (S.activeChatId) renderThread();
  });

  es.addEventListener('browser', (e) => {
    handleBrowserCommand(JSON.parse(e.data));
  });

  es.addEventListener('cleared', (e) => {
    const { chatId } = JSON.parse(e.data);
    S.messages[chatId] = [];
    if (chatId === S.activeChatId) renderThread();
  });
}

async function boot() {
  const [data, setup] = await Promise.all([
    api('/api/bootstrap'),
    api('/api/setup/status').catch(() => null),
  ]);
  S.setup = setup;
  S.self = data.self;
  S.settings = data.settings || { leaderId: null, wallpaper: true };
  S.bots = data.bots;
  S.botGroups = data.botGroups || [];
  S.chats = data.chats;
  S.roles = data.roles || [];
  S.agyProfiles = data.agyProfiles || [];
  S.models = data.models || { opencode: [], agy: [], codex: [], codebuddy: [], qoder: [] };
  S.agyProfileModels = {};
  if ((S.bots || []).some((b) => b.backend === 'agy')) {
    for (const profile of S.agyProfiles || []) {
      void loadAgyProfileModels(profile.id, { switchModel: false });
    }
  }
  S.flowRulesDefault = data.flowRulesDefault || '';
  S.sources = data.sources || [];
  S.avatars = data.avatars || [];
  S.wallpapers = data.wallpapers || [];
  applyWallpaper();
  applySidebar();
  bind();
  renderSidebar();
  renderThread();
  syncSendState();
  connectSSE();
  if (S.chats[0]) openChat(S.chats[0].id);
  if (setup?.firstRun) setTimeout(() => openWelcome(), 350);
  // 模型列表不阻塞首屏
  api('/api/models')
    .then((models) => {
      S.models = models;
      renderSidebar();
      if (S.activeChatId) renderModelPill();
    })
    .catch(() => {});

  api('/api/skills')
    .then((d) => (S.skills = d.skills || []))
    .catch(() => {});
}

boot().catch((e) => {
  document.body.innerHTML = `<div style="padding:40px;color:#e8eaf0;font-family:-apple-system,sans-serif">
    <h2>启动失败</h2><pre style="white-space:pre-wrap;color:#ef7d7d">${e?.stack || e}</pre></div>`;
});
