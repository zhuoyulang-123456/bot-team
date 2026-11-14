import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const isWin = process.platform === 'win32';
export const isMac = process.platform === 'darwin';
export const PATH_DELIM = path.delimiter;

/**
 * 判断路径是否为绝对路径（兼容 POSIX、Windows 盘符路径和 UNC 路径）。
 */
export function isAbsolutePath(p) {
  const s = String(p || '');
  if (!s) return false;
  return path.isAbsolute(s) || /^[A-Za-z]:[\\/]/.test(s) || /^\\\\/.test(s);
}

/**
 * 返回当前平台的可执行文件扩展名列表。
 */
export function pathExts() {
  if (!isWin) return [''];
  const raw = (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean);
  return ['', ...raw];
}

/**
 * 返回各平台常见的补充 CLI 搜索目录。
 */
export function fallbackBinDirs() {
  const home = os.homedir();
  if (isWin) {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const dirs = [
      path.join(appData, 'npm'),
      path.join(localAppData, 'Programs'),
      path.join(localAppData, 'Microsoft', 'WinGet', 'Packages'),
      path.join(localAppData, 'Volta', 'bin'),
      path.join(home, '.volta', 'bin'),
      path.join(home, '.bun', 'bin'),
      path.join(home, '.opencode', 'bin'),
      path.join(home, '.local', 'bin'),
      path.join(home, '.qoder-cn', 'bin', 'qoderclicn'),
      path.join(home, '.qoder-cn', 'bin'),
      path.join(localAppData, 'agy', 'bin'),
      path.join(localAppData, 'antigravity', 'bin'),
      path.join(localAppData, 'antigravity'),
      path.join(programFiles, 'nodejs'),
      path.join(programFiles, 'Git', 'cmd'),
      path.join(programFilesX86, 'Git', 'cmd'),
      'C:\\ffmpeg\\bin',
    ];
    return dirs;
  }

  const dirs = [
    path.join(home, '.local/lib/node/bin'),
    path.join(home, '.local/bin'),
    path.join(home, '.opencode/bin'),
    path.join(home, '.bun/bin'),
    path.join(home, '.npm-global/bin'),
    path.join(home, '.volta/bin'),
    path.join(home, 'Library/pnpm'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
  ];
  try {
    const nvm = path.join(home, '.nvm/versions/node');
    for (const v of fs.readdirSync(nvm)) dirs.push(path.join(nvm, v, 'bin'));
  } catch {}
  return dirs;
}

/**
 * 在 PATH 及补充目录中查找可执行文件，找不到返回空字符串。
 */
export function which(cmd, extraDirs = []) {
  if (!cmd) return '';
  if (cmd.includes('/') || cmd.includes('\\')) {
    try {
      if (fs.statSync(cmd).isFile()) return cmd;
    } catch {}
    return '';
  }
  const dirs = [
    ...String(process.env.PATH || '').split(PATH_DELIM).filter(Boolean),
    ...extraDirs,
    ...fallbackBinDirs(),
  ];
  const exts = pathExts();
  for (const dir of dirs) {
    for (const ext of exts) {
      const file = path.join(dir, cmd + ext);
      try {
        if (!fs.statSync(file).isFile()) continue;
        if (!isWin) fs.accessSync(file, fs.constants.X_OK);
        return file;
      } catch {}
    }
  }
  return '';
}

/**
 * 返回当前平台可用的 Python 3 命令与前置参数。
 */
export function pythonCommand() {
  if (isWin) {
    const py = which('python') || which('python3');
    if (py) return { cmd: py, args: [] };
    const launcher = which('py');
    if (launcher) return { cmd: launcher, args: ['-3'] };
    return { cmd: 'python', args: [] };
  }
  const py3 = which('python3') || which('python');
  return { cmd: py3 || 'python3', args: [] };
}

/**
 * 返回当前平台可用的 curl 路径。
 */
export function curlCommand() {
  return which('curl') || (isWin ? 'curl.exe' : '/usr/bin/curl');
}

/**
 * 终止子进程（Windows 下同时清理整个进程树）。
 */
export function killProcessTree(child, signal = 'SIGKILL') {
  if (!child) return;
  if (isWin && child.pid) {
    try {
      execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
    } catch {}
  }
  try {
    child.kill(isWin ? undefined : signal);
  } catch {}
}

/**
 * 使用系统默认程序打开文件或文件夹。
 */
export function openPathExternal(target) {
  if (isWin) {
    spawn('cmd', ['/c', 'start', '', target], {
      stdio: 'ignore',
      detached: true,
      windowsHide: true,
    }).unref();
    return;
  }
  spawn('open', [target], { stdio: 'ignore', detached: true }).unref();
}

/**
 * 在系统文件管理器中定位并选中指定文件。
 */
export function revealPathExternal(target) {
  if (isWin) {
    spawn('explorer', [`/select,${target}`], {
      stdio: 'ignore',
      detached: true,
      windowsHide: true,
    }).unref();
    return;
  }
  spawn('open', ['-R', target], { stdio: 'ignore', detached: true }).unref();
}

/**
 * 使用系统默认浏览器或协议处理器打开 URL。
 */
export function openUrlExternal(url) {
  if (isWin) {
    spawn('cmd', ['/c', 'start', '', url], {
      stdio: 'ignore',
      detached: true,
      windowsHide: true,
    }).unref();
    return;
  }
  execFile('open', [url], () => {});
}
