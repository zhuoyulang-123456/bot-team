import { app, BrowserWindow, Menu, dialog, shell, ipcMain } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { killActiveChildren } from '../lib/agents.mjs';

const APP_NAME = 'Bot Team';

app.setName(APP_NAME);
app.setAboutPanelOptions({
  applicationName: APP_NAME,
  applicationVersion: app.getVersion(),
  copyright: '本地 AI 员工工作台',
});

/* 打包后从 Finder 启动时 PATH 只有 /usr/bin:/bin，必须补上登录 shell 的环境，
   否则 opencode / codex / agy 全都找不到。 */
function fixPath() {
  const home = os.homedir();
  const extra = [
    path.join(home, '.local/lib/node/bin'),
    path.join(home, '.local/bin'),
    path.join(home, '.bun/bin'),
    path.join(home, '.opencode/bin'),
    path.join(home, '.npm-global/bin'),
    path.join(home, '.volta/bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ];
  try {
    const nvm = path.join(home, '.nvm/versions/node');
    for (const v of fs.readdirSync(nvm)) extra.push(path.join(nvm, v, 'bin'));
  } catch {}

  let loginPath = '';
  try {
    const shellBin = process.env.SHELL || '/bin/zsh';
    // 用哨兵包住，避免 .zprofile 里的 banner/版本提示污染 PATH
    const out = execFileSync(shellBin, ['-lc', 'printf "__BT_PATH__%s__BT_END__" "$PATH"'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const m = out.match(/__BT_PATH__([\s\S]*?)__BT_END__/);
    if (m) loginPath = m[1].trim();
  } catch {}

  const parts = new Set(
    [loginPath, process.env.PATH, ...extra].filter(Boolean).join(':').split(':').filter(Boolean)
  );
  process.env.PATH = [...parts].join(':');
}

let win = null;
let serverUrl = null;

async function bootServer() {
  const home = app.getPath('userData');
  fs.mkdirSync(home, { recursive: true });
  process.env.BOT_TEAM_HOME = home;
  process.env.NODE_ENV = process.env.NODE_ENV || 'production';

  // 必须在设置 BOT_TEAM_HOME 之后再加载，store.mjs 会读它决定数据目录。
  const { startServer } = await import('../server.mjs');
  const { port } = await startServer({ port: 0 });
  serverUrl = `http://127.0.0.1:${port}`;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1240,
    height: 840,
    minWidth: 920,
    minHeight: 620,
    show: false,
    backgroundColor: '#0b0c10',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 17 },
    title: APP_NAME,
    webPreferences: {
      preload: path.join(import.meta.dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      webviewTag: true,
    },
  });

  win.once('ready-to-show', () => win.show());
  win.loadURL(serverUrl);

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(serverUrl)) {
      e.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });

  win.on('closed', () => {
    win = null;
  });
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac
      ? [
          {
            label: APP_NAME,
            submenu: [
              { role: 'about', label: `关于 ${APP_NAME}` },
              { type: 'separator' },
              {
                label: '打开数据文件夹',
                click: () => shell.openPath(app.getPath('userData')),
              },
              { type: 'separator' },
              { role: 'hide', label: '隐藏' },
              { role: 'hideOthers', label: '隐藏其他' },
              { role: 'unhide', label: '显示全部' },
              { type: 'separator' },
              { role: 'quit', label: `退出 ${APP_NAME}` },
            ],
          },
        ]
      : []),
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '显示',
      submenu: [
        { role: 'reload', label: '重新载入' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'zoom', label: '缩放' },
        { role: 'close', label: '关闭窗口' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  ipcMain.handle('open-data-dir', () => shell.openPath(app.getPath('userData')));

  ipcMain.handle('pick-files', async () => {
    try {
      const opts = { properties: ['openFile', 'multiSelections'], title: '选择要查看的文件' };
      const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
      return r.canceled ? [] : r.filePaths;
    } catch {
      return [];
    }
  });

  ipcMain.handle('login-item-get', () => {
    try {
      return !!app.getLoginItemSettings().openAtLogin;
    } catch {
      return false;
    }
  });
  ipcMain.handle('login-item-set', (event, enabled) => {
    try {
      app.setLoginItemSettings({ openAtLogin: !!enabled, openAsHidden: true });
      return !!app.getLoginItemSettings().openAtLogin;
    } catch {
      return false;
    }
  });

  // 在 App 内登录 MiMo：直接读 Electron 自己的 Cookie，不需要完全磁盘访问权限
  ipcMain.handle('mimo-login', async () => {
    const allowed = (url) => {
      try {
        const h = new URL(url).hostname;
        return (
          h === 'platform.xiaomimimo.com' ||
          h.endsWith('.xiaomimimo.com') ||
          h === 'account.xiaomi.com' ||
          h.endsWith('.account.xiaomi.com') ||
          h === 'xiaomi.com' ||
          h.endsWith('.xiaomi.com')
        );
      } catch {
        return false;
      }
    };
    return await new Promise((resolve, reject) => {
      const authWin = new BrowserWindow({
        width: 520,
        height: 780,
        title: '登录 MiMo',
        parent: win || undefined,
        autoHideMenuBar: true,
        webPreferences: { contextIsolation: true, nodeIntegration: false },
      });
      authWin.loadURL('https://platform.xiaomimimo.com/#/console/balance');
      authWin.webContents.setWindowOpenHandler(({ url }) => {
        if (allowed(url)) return { action: 'allow' };
        if (/^https?:/i.test(url)) shell.openExternal(url);
        return { action: 'deny' };
      });
      let finished = false;
      const finish = (value) => {
        if (finished) return;
        finished = true;
        clearInterval(timer);
        resolve(value);
        if (!authWin.isDestroyed()) authWin.close();
      };
      const fail = (err) => {
        if (finished) return;
        finished = true;
        clearInterval(timer);
        reject(err);
      };
      const timer = setInterval(async () => {
        try {
          const cookies = await authWin.webContents.session.cookies.get({
            domain: 'xiaomimimo.com',
          });
          if (!cookies.some((c) => c.name === 'api-platform_serviceToken')) return;
          const header = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
          finish(header);
        } catch {}
      }, 1500);
      authWin.on('closed', () => fail(new Error('已取消登录')));
      authWin.webContents.on('did-fail-load', (_e, code, desc) => {
        if (code !== -3) fail(new Error(`登录页加载失败：${desc}`));
      });
    });
  });

  app.whenReady().then(async () => {
    fixPath();
    buildMenu();
    try {
      await bootServer();
    } catch (e) {
      dialog.showErrorBox('启动失败', String(e?.stack || e));
      app.quit();
      return;
    }
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => {
    try {
      killActiveChildren();
    } catch {}
  });
}
