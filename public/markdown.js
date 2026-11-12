/* Bot Team Markdown 渲染：marked + DOMPurify，本地文件，无外网依赖。 */
(function () {
  const esc = (s) =>
    String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  function fallback(text) {
    return esc(text).replace(/\n/g, '<br>');
  }

  // 先把数学公式抽出来，避免 marked / breaks 把 $$ 多行公式拆散
  function extractMath(raw) {
    const store = [];
    const push = (expr, display) => {
      store.push({ expr, display });
      return `@@BTMATH${store.length - 1}@@`;
    };
    const convert = (chunk) => {
      let out = chunk;
      out = out.replace(/\$\$([\s\S]+?)\$\$/g, (m, expr) => push(expr, true));
      out = out.replace(/\\\[([\s\S]+?)\\\]/g, (m, expr) => push(expr, true));
      out = out.replace(/\\\(([\s\S]+?)\\\)/g, (m, expr) => push(expr, false));
      out = out.replace(/(^|[^\\$])\$([^\n$]+?)\$/g, (m, pre, expr) => {
        if (!expr.trim()) return m;
        return pre + push(expr, false);
      });
      return out;
    };
    // 代码块和行内代码里的 $ 不动
    const parts = String(raw).split(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/);
    const text = parts.map((p, i) => (i % 2 ? p : convert(p))).join('');
    return { text, store };
  }

  function mathNode(item) {
    const span = document.createElement('span');
    span.className = item.display ? 'bt-math bt-math-display' : 'bt-math';
    if (window.katex) {
      try {
        span.innerHTML = window.katex.renderToString(item.expr, {
          displayMode: !!item.display,
          throwOnError: false,
          strict: 'ignore',
          trust: false,
        });
        return span;
      } catch {}
    }
    span.textContent = item.display ? `$$${item.expr}$$` : `$${item.expr}$`;
    return span;
  }

  function fillMathTokens(root, store) {
    if (!store.length) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      if (!node.nodeValue || !node.nodeValue.includes('@@BTMATH')) continue;
      const parts = node.nodeValue.split(/(@@BTMATH\d+@@)/);
      const frag = document.createDocumentFragment();
      for (const part of parts) {
        const m = part.match(/^@@BTMATH(\d+)@@$/);
        if (m) {
          const item = store[Number(m[1])];
          if (item) frag.appendChild(mathNode(item));
        } else if (part) {
          frag.appendChild(document.createTextNode(part));
        }
      }
      node.parentNode.replaceChild(frag, node);
    }
  }

  function render(text, opts) {
    const raw = String(text ?? '');
    if (!raw) return '';
    if (!window.marked || !window.DOMPurify) return fallback(raw);
    const breaks = !opts || opts.breaks !== false;
    try {
      const math = extractMath(raw);
      const html = window.marked.parse(math.text, { gfm: true, breaks });
      const clean = window.DOMPurify.sanitize(html, {
        USE_PROFILES: { html: true },
      });
      const tpl = document.createElement('template');
      tpl.innerHTML = clean;
      fillMathTokens(tpl.content, math.store);
      tpl.content.querySelectorAll('a').forEach((a) => {
        a.target = '_blank';
        a.rel = 'noreferrer';
      });
      linkifyFiles(tpl.content);
      return tpl.innerHTML;
    } catch {
      return fallback(raw);
    }
  }

  // 把正文里的本地文件路径变成可点的文件标签，点一下就能打开。
  function linkifyFiles(root) {
    // 允许路径里带空格（Application Support/Bot Team），以第一个扩展名收住
    const re =
      /(?:~\/|\/(?:Users|tmp|private|Volumes|opt|var|home)\/)[^\n<>"'`|]*?\.[A-Za-z0-9]{1,8}(?=$|[\s，。；：、！？）】》,.!?])/g;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      const parent = node.parentElement;
      if (!parent || parent.closest('a, code, pre')) continue;
      const text = node.nodeValue || '';
      re.lastIndex = 0;
      if (!re.test(text)) continue;
      re.lastIndex = 0;
      const frag = document.createDocumentFragment();
      let last = 0;
      let m;
      while ((m = re.exec(text))) {
        const raw = m[0];
        const trail = (raw.match(/[.,;:!?，。；：、）】》"']+$/) || [''])[0];
        const filePath = trail ? raw.slice(0, -trail.length) : raw;
        if (filePath.length < 5) continue;
        frag.appendChild(document.createTextNode(text.slice(last, m.index)));
        const a = document.createElement('a');
        a.className = 'file-ref';
        a.href = '#';
        a.dataset.btFile = filePath;
        a.title = filePath;
        a.textContent = filePath.split('/').pop();
        frag.appendChild(a);
        if (trail) frag.appendChild(document.createTextNode(trail));
        last = m.index + raw.length;
      }
      if (last === 0) continue;
      frag.appendChild(document.createTextNode(text.slice(last)));
      node.parentNode.replaceChild(frag, node);
    }
  }

  window.renderMarkdown = render;
})();
