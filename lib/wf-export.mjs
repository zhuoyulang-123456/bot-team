/* 服务端流程图导出：不依赖浏览器，供 Bot / CLI 调用。 */

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function cut(text, max) {
  const s = String(text || '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function depths(wf) {
  const byId = new Map(wf.nodes.map((n) => [n.id, n]));
  const depth = new Map();
  const start = byId.has(wf.startNodeId) ? wf.startNodeId : wf.nodes[0]?.id;
  const queue = [];
  if (start) {
    depth.set(start, 0);
    queue.push(start);
  }
  for (let i = 0; i < queue.length; i++) {
    const node = byId.get(queue[i]);
    if (!node) continue;
    const d = depth.get(node.id) || 0;
    const outs = [...(node.next || []).map((e) => e.to), ...(node.parallel?.targets || [])];
    for (const to of outs) {
      if (to === '__end__' || !byId.has(to) || depth.has(to)) continue;
      depth.set(to, d + 1);
      queue.push(to);
    }
  }
  let max = 0;
  for (const d of depth.values()) max = Math.max(max, d);
  for (const n of wf.nodes) if (!depth.has(n.id)) depth.set(n.id, max + 1);
  return depth;
}

function incoming(wf, id) {
  return wf.nodes.reduce((n, x) => n + (x.next || []).filter((e) => e.to === id).length, 0);
}

function isBranchNode(wf, id) {
  return wf.nodes.some((n) => n.parallel?.targets?.includes(id));
}

function modeOf(wf, node, depth) {
  if ((node.parallel?.targets || []).length >= 2) return 'branch';
  if (['next', 'merge', 'loop', 'end'].includes(node.nextMode)) return node.nextMode;
  const edge = (node.next || [])[0];
  if (!edge || edge.to === '__end__') return 'end';
  if (incoming(wf, edge.to) >= 2) return 'merge';
  const target = wf.nodes.find((n) => n.id === edge.to);
  if (target && (depth.get(target.id) || 0) <= (depth.get(node.id) || 0)) return 'loop';
  return 'next';
}

function modeText(wf, node, mode) {
  if (mode === 'end') return '流程到此结束';
  if (mode === 'branch') {
    const names = (node.parallel?.targets || [])
      .map((id) => wf.nodes.find((n) => n.id === id)?.title)
      .filter(Boolean);
    return names.length ? `同时交给「${names.join('」「')}」` : '并行分发';
  }
  const edge = (node.next || [])[0];
  const target = wf.nodes.find((n) => n.id === edge?.to);
  const label = mode === 'merge' ? '汇合到' : mode === 'loop' ? '回到' : '下一步';
  return `${label}「${target?.title || '?'}」`;
}

function tag(x, y, text, color) {
  const w = Math.max(30, String(text).length * 11 + 14);
  return `<g>
    <rect x="${x - w}" y="${y - 12}" width="${w}" height="19" rx="9.5" fill="${color}22" stroke="${color}66" stroke-width="1"/>
    <text x="${x - w / 2}" y="${y + 1.5}" text-anchor="middle" font-size="10" fill="${color}">${esc(text)}</text>
  </g>`;
}

function elbow(x1, y1, x2, y2, busY) {
  const bus = busY == null ? (y1 + y2) / 2 : busY;
  const r = Math.min(12, Math.abs(x2 - x1) / 2 || 12);
  if (Math.abs(x2 - x1) < 1.2) return `M${x1},${y1} L${x2},${y2}`;
  const dir = x2 > x1 ? 1 : -1;
  return `M${x1},${y1} L${x1},${bus - r} Q${x1},${bus} ${x1 + dir * r},${bus} L${
    x2 - dir * r
  },${bus} Q${x2},${bus} ${x2},${bus + r} L${x2},${y2}`;
}

export function buildWorkflowSvg(wf, bots = []) {
  const botById = (id) => bots.find((b) => b.id === id);
  const CW = 252;
  const CH = 96;
  const GX = 30;
  const GY = 86;
  const PAD = 80;
  const depth = depths(wf);
  const rows = [];
  for (const n of wf.nodes) {
    const d = depth.get(n.id) || 0;
    (rows[d] ||= []).push(n);
  }
  const stages = rows.filter(Boolean);
  const rowWidth = (r) => r.length * CW + (r.length - 1) * GX;
  const widest = stages.reduce((m, r) => Math.max(m, rowWidth(r)), 0);
  const W = Math.max(1000, widest + PAD * 2);
  const top = 56;
  const H = top + stages.length * (CH + GY) + 18;
  const pos = new Map();
  stages.forEach((row, si) => {
    const x0 = (W - rowWidth(row)) / 2;
    row.forEach((n, i) => pos.set(n.id, { x: x0 + i * (CW + GX), y: top + si * (CH + GY), w: CW, h: CH }));
  });

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
      const mode = modeOf(wf, n, depth);
      const isStart = wf.startNodeId === n.id;
      const isBranch = isBranchNode(wf, n.id);
      const isMerge = incoming(wf, n.id) >= 2;
      const stroke = isStart
        ? 'rgba(167,139,250,.75)'
        : isMerge
          ? 'rgba(61,220,151,.35)'
          : 'rgba(255,255,255,.1)';
      const fill = isStart ? 'url(#cardStart)' : 'url(#card)';
      let tags = '';
      let tx = p.x + p.w - 14;
      if (isBranch) {
        tags += tag(tx, p.y + 20, '分支', '#a78bfa');
        tx -= 44;
      }
      if (isMerge) {
        tags += tag(tx, p.y + 20, '汇合', '#3ddc97');
        tx -= 44;
      }
      if (isStart) tags += tag(tx, p.y + 20, '起点', '#c4b5fd');
      const accent = isStart
        ? '#7c6cf5'
        : isBranch
          ? 'rgba(124,108,245,.9)'
          : isMerge
            ? 'rgba(61,220,151,.75)'
            : 'rgba(255,255,255,.14)';
      const icons = { next: '→', merge: '⇥', loop: '↺', end: '■', branch: '⇉' };
      return `<g>
        <rect x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" rx="14" fill="${fill}" stroke="${stroke}" stroke-width="1.4"/>
        <rect x="${p.x}" y="${p.y + 14}" width="3" height="${p.h - 28}" rx="1.5" fill="${accent}" opacity="0.9"/>
        ${tags}
        <text x="${p.x + 18}" y="${p.y + 32}" font-size="15" font-weight="600" fill="#e8eaf0">${esc(
          cut(n.title || '未命名', 15)
        )}</text>
        <text x="${p.x + 18}" y="${p.y + 56}" font-size="11.5" fill="#8b93a5">${esc(
          cut(`${bot?.emoji ? `${bot.emoji} ` : ''}${bot?.name || '未指定 Bot'}`, 24)
        )}</text>
        <text x="${p.x + 18}" y="${p.y + 78}" font-size="10.5" fill="#a99cf0">${esc(
          cut(`${icons[mode] || '→'} ${modeText(wf, n, mode)}`, 26)
        )}</text>
      </g>`;
    })
    .join('');

  const lines = edges
    .map(([from, to]) => {
      const a = pos.get(from);
      const b = pos.get(to);
      if (!a || !b) return '';
      if (b.y <= a.y) {
        const LX = 30;
        const sy = a.y + a.h / 2;
        const ty = b.y + b.h / 2;
        const d = `M${a.x},${sy} L${LX + 10},${sy} Q${LX},${sy} ${LX},${sy - 10} L${LX},${
          ty + 10
        } Q${LX},${ty} ${LX + 10},${ty} L${b.x - 6},${ty}`;
        const labelY = (sy + ty) / 2;
        return `<path d="${d}" fill="none" stroke="#8f7cf0" stroke-width="1.8" stroke-dasharray="7 7" marker-end="url(#arrowLoop)" opacity="0.9"/>
          <text transform="rotate(-90 ${LX - 15} ${labelY})" x="${LX - 15}" y="${labelY}" text-anchor="middle" font-size="10.5" fill="#a99cf0" stroke="#0b0d13" stroke-width="3" paint-order="stroke" stroke-linejoin="round">回到「${esc(
            cut(wf.nodes.find((n) => n.id === to)?.title || '', 10)
          )}」· 下一轮</text>`;
      }
      return `<path d="${elbow(a.x + a.w / 2, a.y + a.h, b.x + b.w / 2, b.y - 6, (a.y + a.h + b.y - 6) / 2)}" fill="none" stroke="#5b587d" stroke-width="1.6" marker-end="url(#arrow)" opacity="0.85"/>`;
    })
    .join('');

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
  </svg>`;
}

export function buildWorkflowHtml(chat, wf, bots = []) {
  const count = wf.nodes.length;
  const maxSteps = wf.maxSteps === 0 ? '不限' : `${wf.maxSteps} 步`;
  const branchCount = wf.nodes.filter((n) => (n.parallel?.targets || []).length >= 2).length;
  const now = new Date();
  const stamp = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())} ${pad2(
    now.getHours()
  )}:${pad2(now.getMinutes())}`;
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
    margin: 0; min-height: 100vh; padding: 40px 24px 56px;
    background:
      radial-gradient(1100px 520px at 12% -10%, rgba(124,108,245,.18), transparent 60%),
      radial-gradient(900px 500px at 92% 4%, rgba(61,220,151,.08), transparent 55%),
      #0b0d13;
    color: #e8eaf0;
    font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", Arial, sans-serif;
    display: flex; justify-content: center;
  }
  .sheet {
    width: min(1240px, 100%); border-radius: 22px; border: 1px solid rgba(255,255,255,.08);
    background: linear-gradient(180deg, rgba(24,27,37,.96), rgba(15,17,24,.98));
    box-shadow: 0 30px 90px rgba(0,0,0,.55); padding: 28px 30px 22px;
  }
  .eyebrow { font-size: 12px; letter-spacing: .08em; color: #8b93a5; }
  h1 { margin: 6px 0 8px; font-size: 24px; }
  .meta { display: flex; flex-wrap: wrap; gap: 8px; font-size: 11.5px; color: #8b93a5; }
  .meta span { padding: 3px 10px; border-radius: 999px; border: 1px solid rgba(255,255,255,.09); background: rgba(255,255,255,.03); }
  .canvas {
    margin: 18px 0 8px; border-radius: 18px; border: 1px solid rgba(255,255,255,.055);
    background: radial-gradient(120% 60% at 0% 0%, rgba(124,108,245,.1), transparent 60%), rgba(255,255,255,.012);
    overflow: auto;
  }
  .canvas svg { display: block; width: 100%; height: auto; min-width: 760px; }
  footer {
    display: flex; align-items: center; justify-content: space-between; gap: 16px;
    padding-top: 14px; border-top: 1px solid rgba(255,255,255,.06); font-size: 11px; color: #7f8797;
  }
  .legend { display: flex; gap: 14px; flex-wrap: wrap; }
  .legend i { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 5px; vertical-align: middle; }
  @media print { body { padding: 0; background: #0b0d13; } .sheet { box-shadow: none; border: 0; } }
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
  <div class="canvas">${buildWorkflowSvg(wf, bots)}</div>
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
