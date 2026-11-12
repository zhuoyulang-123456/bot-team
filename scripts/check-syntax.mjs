import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const skip = new Set(['node_modules', 'release', 'data', 'bots', 'groups', '.git', '.remember']);
let checked = 0;
let failed = 0;

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
      continue;
    }
    if (!/\.(mjs|js|cjs)$/.test(entry.name)) continue;
    checked += 1;
    try {
      execFileSync(process.execPath, ['--check', full], { stdio: 'pipe' });
    } catch (e) {
      failed += 1;
      console.error(`\n✗ ${path.relative(root, full)}`);
      console.error(String(e.stderr || e.message).trim().split('\n').slice(0, 6).join('\n'));
    }
  }
}

walk(root);
if (failed) {
  console.error(`\n${failed} 个文件语法检查失败（共 ${checked} 个）`);
  process.exit(1);
}
console.log(`语法检查通过：${checked} 个文件`);
