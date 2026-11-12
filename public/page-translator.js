/* Bot Team page translator (injected into the webview page).
   Reconstructed after the Immersive Translate full-page pipeline:
   paragraph entities -> queue -> visibility/immediate batching -> inline wrapper
   inside the paragraph, with a source wrapper for dual/translation-only switching. */
(() => {
  if (window.__BT_TRANSLATOR__) return;

  const SKIP = [
    'pre',
    'code',
    'kbd',
    'samp',
    'script',
    'style',
    'noscript',
    'textarea',
    'input',
    'select',
    'option',
    'button',
    'nav',
    'footer',
    'header',
    'svg',
    'math',
    '[role="button"]',
    '[role="menu"]',
    '[role="tab"]',
    '[role="navigation"]',
    '[role="toolbar"]',
    '[contenteditable="true"]',
    '[aria-hidden="true"]',
    '[translate="no"]',
    '[aria-labelledby="files"]',
    '[data-testid="tree-view"]',
    '[class*="react-directory"]',
    '[class*="file-tree"]',
    '[class*="file-navigation"]',
    '[class*="sidebar" i]',
    '[class*="breadcrumb" i]',
    '[class*="pagination" i]',
    '[class*="toolbar" i]',
    '[class*="sr-only" i]',
    '[class*="visually-hidden" i]',
    '.notranslate',
    '[data-bt-translation]',
    '[data-bt-source]',
  ].join(',');

  const BLOCK_DISPLAY = /^(block|list-item|table|table-row|table-cell|flex|grid|flow-root|inline-block|inline-flex|inline-grid)$/;
  const UI_CLASS =
    /(^|[\s_-])(nav|menu|toolbar|button|btn|tab|header|footer|sidebar|meta|action|control|breadcrumb|pagination|social|share|comment-form|search|dropdown|modal|popover|tooltip|badge|chip)([\s_-]|$)/i;
  const HEADINGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
  const CONTENT_SELECTORS = [
    'article',
    'main',
    '[role="main"]',
    '.markdown-body',
    '.markdown',
    '.post-content',
    '.entry-content',
    '.article-content',
    '.doc-content',
  ];

  const state = {
    active: false,
    area: 'main',
    startMode: 'immediate',
    display: 'dual',
    paragraphs: new Map(),
    byEl: new WeakMap(),
    queue: [],
    seq: 0,
    root: null,
    observer: null,
    mutation: null,
    scanTimer: 0,
    maxParagraphs: 800,
    truncated: false,
    writing: false,
  };

  function status() {
    let done = 0;
    let failed = 0;
    for (const p of state.paragraphs.values()) {
      if (p.status === 'done') done += 1;
      else if (p.status === 'failed') failed += 1;
    }
    const total = state.paragraphs.size;
    return {
      ok: true,
      active: state.active,
      area: state.area,
      startMode: state.startMode,
      display: state.display,
      total,
      done,
      failed,
      pending: Math.max(0, total - done - failed),
      queued: state.queue.length,
      truncated: state.truncated,
      waiting: state.active && state.paragraphs.size === 0,
    };
  }

  function ensureStyle() {
    let style = document.getElementById('bt-page-style');
    if (style) return;
    style = document.createElement('style');
    style.id = 'bt-page-style';
    style.textContent = [
      '.bt-page-translation{display:block;box-sizing:border-box;width:auto;max-width:100%;min-width:0;margin:6px 0 8px;padding:4px 10px;border-left:2px solid rgba(124,108,245,.55);border-radius:0 6px 6px 0;background:rgba(124,108,245,.07);color:inherit;font:inherit;font-size:.96em;line-height:1.7;text-align:left;white-space:normal;word-break:break-word;overflow-wrap:anywhere;text-shadow:none}',
      '.bt-page-translation.bt-in-heading{font-size:.72em;font-weight:400;line-height:1.55;letter-spacing:normal}',
      '.bt-page-translation.bt-in-li{margin:4px 0 6px}',
      '[data-bt-source]{display:contents}',
      '[data-bt-translate-state="translation"] [data-bt-source]{display:none!important}',
      '[data-bt-translate-state="translation"] .bt-page-translation{border-left:0;border-radius:0;padding-left:0;background:none;margin:0}',
    ].join('\n');
    (document.head || document.documentElement).appendChild(style);
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    try {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
      const rect = el.getBoundingClientRect();
      if (rect.width < 10 || rect.height < 6) return false;
      if (cs.position === 'fixed' || cs.position === 'sticky') return true;
    } catch {}
    return el.offsetParent !== null || el.getClientRects().length > 0;
  }

  function hasBlockChild(el) {
    for (const child of el.children) {
      let display = '';
      try {
        display = getComputedStyle(child).display;
      } catch {}
      if (display && BLOCK_DISPLAY.test(display)) return true;
    }
    return false;
  }

  function isLeafDiv(el) {
    if (el.closest(SKIP)) return false;
    if (el.getAttribute('role') || el.getAttribute('onclick')) return false;
    const cls = `${String(el.className || '')} ${String(el.id || '')}`;
    if (UI_CLASS.test(cls)) return false;
    try {
      if (getComputedStyle(el).cursor === 'pointer') return false;
    } catch {}
    if (el.querySelector('button,input,select,textarea,svg,canvas')) return false;
    if (hasBlockChild(el)) return false;
    return true;
  }

  function isLeafAnchor(el) {
    if (el.closest(SKIP)) return false;
    if (el.getAttribute('role') || el.getAttribute('onclick')) return false;
    try {
      const display = getComputedStyle(el).display;
      if (!/^(block|flow-root|list-item)$/.test(display)) return false;
    } catch {}
    if (hasBlockChild(el)) return false;
    if (el.querySelector('button,input,select,textarea,svg,canvas')) return false;
    // 段落/标题/表格里的行内链接会被它们的外层一起翻译，不能再单独抽出来
    if (el.closest('p,h1,h2,h3,h4,h5,h6,blockquote,td,th')) return false;
    const li = el.closest('li');
    if (li) {
      let liDisplay = '';
      try {
        liDisplay = getComputedStyle(li).display;
      } catch {}
      if (!/flex|grid/.test(liDisplay)) return false;
    }
    let node = el.parentElement;
    while (node && node !== document.body) {
      if (node.tagName === 'DIV' && isLeafDiv(node)) return false;
      node = node.parentElement;
    }
    const text = normalize(el.innerText || el.textContent || '');
    return text.length >= 8;
  }

  function chooseRoot() {
    if (state.area === 'body') return document.body;
    const bestOf = (selectors) => {
      let root = null;
      let best = 0;
      for (const selector of selectors) {
        for (const el of document.querySelectorAll(selector)) {
          if (el.closest(SKIP)) continue;
          // GitHub 会同时保留一份 0×0 的隐藏 main（React SSR），不能只看文字长度
          if (!isVisible(el)) continue;
          const len = (el.innerText || '').length;
          if (len > best) {
            best = len;
            root = el;
          }
        }
      }
      return { root, len: best };
    };
    // 用 main 做正文范围，但把文件树/侧栏/面包屑等 UI 通过 SKIP 排除；
    // 这样 GitHub 的 issues 页能覆盖 “Learn. Collaborate. Grow.” 和 changelog，
    // 仓库页又不会把文件树翻成竖排。
    const main = bestOf(['main', '[role="main"]']);
    const bodyLen = (document.body.innerText || '').length;
    // GitHub 首页这类页面，main 只有左栏，右侧卡片在 main 外面；
    // main 占比太小时退回 body（仍用语义块 + SKIP 排除导航/侧栏）。
    if (main.root && main.len >= 300 && main.len >= bodyLen * 0.6) return main.root;
    const article = bestOf([
      'article',
      '.markdown-body',
      '.post-content',
      '.entry-content',
      '.article-content',
      '.doc-content',
    ]);
    if (article.root && article.len >= Math.max(300, bodyLen * 0.4)) return article.root;
    if (bodyLen >= 300) return document.body;
    return main.root || article.root || document.body;
  }

  function normalize(text) {
    return String(text || '')
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function sourceText(el) {
    const source = el.querySelector(':scope > [data-bt-source]');
    if (source) return normalize(source.innerText || source.textContent || '');
    const copy = el.cloneNode(true);
    copy.querySelectorAll?.('[data-bt-translation]').forEach((n) => n.remove());
    return normalize(copy.innerText || copy.textContent || '');
  }

  function isUsableText(text) {
    if (text.length < 2 || text.length > 4000) return false;
    const letters = (text.match(/[A-Za-z\u00C0-\u024F\u4e00-\u9fff]/g) || []).length;
    return letters >= 2;
  }

  function addParagraph(el) {
    if (!el || !el.isConnected) return false;
    if (el.closest(SKIP)) return false;
    if (el.querySelector('button,input,select,textarea,[role="button"],[contenteditable="true"]')) {
      return false;
    }

    // 站点（尤其 React）重渲染时会把我们的译文节点删掉，但元素本身还在。
    // 用 WeakMap 记录元素，不依赖 data 属性：译文没了就补回去或重新排队。
    const existing = state.byEl.get(el);
    if (existing) {
      const wrapper = el.querySelector(':scope > [data-bt-translation]');
      if (wrapper) {
        if (existing.status !== 'done') {
          existing.status = 'done';
          existing.error = '';
        }
        return false;
      }
      const current = sourceText(el);
      if (!isUsableText(current)) return false;
      if (existing.translation && current === existing.srcText) {
        if (render(existing, existing.translation)) {
          existing.status = 'done';
          existing.error = '';
        }
        return false;
      }
      if (existing.status === 'done' || existing.status === 'failed' || !existing.el.isConnected) {
        existing.srcText = current;
        existing.text = current;
        existing.translation = '';
        existing.status = 'pending';
        existing.error = '';
        if (state.startMode === 'immediate' || !state.observer) queueParagraph(existing);
        else observeParagraph(existing);
      }
      return false;
    }

    if (state.paragraphs.size >= state.maxParagraphs) {
      state.truncated = true;
      return false;
    }
    if (el.hasAttribute('data-bt-paragraph')) return false;
    if (el.querySelector('[data-bt-translation]')) return false;
    if (el.tagName === 'DIV' && !isLeafDiv(el)) return false;
    if (el.tagName === 'LI' && hasBlockChild(el)) return false;
    if (el.tagName === 'TD' || el.tagName === 'TH') {
      if (hasBlockChild(el)) return false;
    }
    try {
      const display = getComputedStyle(el).display;
      if (/flex|grid/.test(display)) return false;
    } catch {}
    if (!isVisible(el)) return false;
    const text = normalize(el.innerText || el.textContent || '');
    if (!isUsableText(text)) return false;

    const id = `p${++state.seq}`;
    const p = {
      id,
      el,
      text,
      srcText: text,
      translation: '',
      tag: el.tagName,
      status: 'pending',
      error: '',
      wrapper: null,
    };
    state.paragraphs.set(id, p);
    state.byEl.set(el, p);
    el.setAttribute('data-bt-paragraph', id);
    if (state.startMode === 'immediate' || !state.observer) queueParagraph(p);
    else observeParagraph(p);
    return true;
  }

  function collect() {
    for (const [id, p] of state.paragraphs) {
      if (p.el && !p.el.isConnected) state.paragraphs.delete(id);
    }
    const root = chooseRoot();
    state.root = root;
    const selector =
      'p,li,h1,h2,h3,h4,h5,h6,blockquote,dd,dt,figcaption,summary,td,th';
    const nodes = [...root.querySelectorAll(selector)];
    // “正文”模式补叶子 div：GitHub 的 changelog 条目就是 flex li 里的 block div；
    // “整页”模式只用语义块，避免把导航/按钮翻掉。
    if (state.area === 'main') {
      for (const el of root.querySelectorAll('div')) {
        if (isLeafDiv(el)) nodes.push(el);
      }
      // GitHub 的 changelog 条目标题是块级 <a>，既不是 p/li 也不是 div
      for (const el of root.querySelectorAll('a')) {
        if (isLeafAnchor(el)) nodes.push(el);
      }
    }
    const unique = [...new Set(nodes)];
    const leaves = unique.filter(
      (el) => !unique.some((other) => other !== el && el.contains(other))
    );
    let added = 0;
    for (const el of leaves) {
      if (addParagraph(el)) added += 1;
      if (state.paragraphs.size >= state.maxParagraphs) {
        state.truncated = true;
        break;
      }
    }
    return added;
  }

  function queueParagraph(p) {
    if (!p || p.status === 'done' || p.status === 'queued' || p.status === 'loading') return;
    p.status = 'queued';
    state.queue.push(p.id);
  }

  function observeParagraph(p) {
    if (!state.observer) return;
    try {
      state.observer.observe(p.el);
    } catch {}
  }

  function wrapSource(p) {
    const el = p.el;
    if (el.querySelector(':scope > [data-bt-source]')) return;
    const source = document.createElement('span');
    source.setAttribute('data-bt-source', '1');
    source.style.display = 'contents';
    const keep = el.querySelector(':scope > [data-bt-translation]');
    for (const node of [...el.childNodes]) {
      if (node === keep) continue;
      source.appendChild(node);
    }
    el.insertBefore(source, el.firstChild);
  }

  function unwrapSource(el) {
    const source = el.querySelector(':scope > [data-bt-source]');
    if (!source) return;
    while (source.firstChild) el.insertBefore(source.firstChild, source);
    source.remove();
  }

  function render(p, text) {
    if (!p || !p.el || !p.el.isConnected) return false;
    wrapSource(p);
    let wrapper = p.el.querySelector(':scope > [data-bt-translation]');
    if (!wrapper) {
      wrapper = document.createElement('span');
      wrapper.className = 'bt-page-translation';
      wrapper.setAttribute('data-bt-translation', '1');
      wrapper.setAttribute('translate', 'no');
      wrapper.setAttribute('lang', document.documentElement.lang || 'zh-CN');
      p.el.appendChild(wrapper);
    }
    wrapper.textContent = text;
    wrapper.classList.toggle('bt-in-heading', HEADINGS.has(p.tag));
    wrapper.classList.toggle('bt-in-li', p.tag === 'LI');
    p.wrapper = wrapper;
    p.translation = text;
    p.el.setAttribute('data-bt-has-translation', '1');
    return true;
  }

  function takeQueue(limit = 20) {
    if (!state.active) return [];
    const out = [];
    while (state.queue.length && out.length < limit) {
      const id = state.queue.shift();
      const p = state.paragraphs.get(id);
      if (!p || p.status !== 'queued') continue;
      if (!p.el.isConnected) {
        p.status = 'failed';
        p.error = '节点已从页面移除';
        continue;
      }
      p.status = 'loading';
      out.push({ id: p.id, text: p.text });
    }
    return out;
  }

  function apply(items) {
    if (!Array.isArray(items)) return status();
    state.writing = true;
    for (const item of items) {
      const p = state.paragraphs.get(String(item?.id || ''));
      if (!p) continue;
      const text = normalize(item.text);
      if (!text) {
        p.status = 'failed';
        p.error = '没有拿到译文';
        continue;
      }
      if (!p.el.isConnected) {
        p.status = 'failed';
        p.error = '节点已从页面移除';
        continue;
      }
      if (render(p, text)) {
        p.status = 'done';
        p.error = '';
        p.text = text;
        p.translation = text;
      } else {
        p.status = 'failed';
        p.error = '插入译文失败';
      }
    }
    state.writing = false;
    return status();
  }

  function fail(ids, error) {
    for (const id of Array.isArray(ids) ? ids : []) {
      const p = state.paragraphs.get(String(id));
      if (!p) continue;
      p.status = 'failed';
      p.error = String(error || '').slice(0, 300);
    }
    return status();
  }

  function setDisplay(mode) {
    state.display = mode === 'translation' ? 'translation' : 'dual';
    if (state.active) {
      document.documentElement.setAttribute('data-bt-translate-state', state.display);
    }
    return status();
  }

  function retry() {
    let count = 0;
    for (const p of state.paragraphs.values()) {
      if (p.status !== 'failed') continue;
      p.status = 'pending';
      p.error = '';
      count += 1;
      if (state.startMode === 'immediate' || !state.observer) queueParagraph(p);
      else observeParagraph(p);
    }
    return { ...status(), retried: count };
  }

  function scheduleScan() {
    if (state.scanTimer) return;
    state.scanTimer = setTimeout(() => {
      state.scanTimer = 0;
      if (!state.active) return;
      collect();
    }, 600);
  }

  function attachMutation() {
    if (state.mutation || !document.body) return;
    state.mutation = new MutationObserver((records) => {
      if (!state.active || state.writing) return;
      for (const record of records) {
        if (record.type === 'characterData') {
          const parent = record.target.parentElement;
          if (parent && !parent.closest('[data-bt-translation],[data-bt-source]')) {
            scheduleScan();
            return;
          }
          continue;
        }
        for (const node of record.addedNodes) {
          if (node.nodeType === 3) {
            scheduleScan();
            return;
          }
          if (node.nodeType !== 1) continue;
          if (node.matches?.('[data-bt-translation],[data-bt-source],#bt-page-style')) continue;
          if (node.closest?.('[data-bt-translation],[data-bt-source]')) continue;
          scheduleScan();
          return;
        }
      }
    });
    state.mutation.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }

  function start(options = {}) {
    if (state.active || state.paragraphs.size) restore();
    ensureStyle();
    state.area = options.area === 'body' ? 'body' : 'main';
    state.startMode = options.startMode === 'dynamic' ? 'dynamic' : 'immediate';
    state.display = options.display === 'translation' ? 'translation' : 'dual';
    document.documentElement.setAttribute('data-bt-translate-state', state.display);
    state.active = true;
    state.seq = 0;
    state.truncated = false;
    state.paragraphs.clear();
    state.queue = [];

    if (state.startMode === 'dynamic' && 'IntersectionObserver' in window) {
      state.observer = new IntersectionObserver(
        (entries) => {
          if (!state.active) return;
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const el = entry.target;
            const id = el.getAttribute('data-bt-paragraph');
            const p = id ? state.paragraphs.get(id) : null;
            if (p && p.status === 'pending') {
              queueParagraph(p);
              try {
                state.observer.unobserve(el);
              } catch {}
            }
          }
        },
        { rootMargin: '300px 0px' }
      );
    }

    const added = collect();
    attachMutation();
    return { ...status(), added };
  }

  function restore() {
    state.active = false;
    if (state.observer) {
      try {
        state.observer.disconnect();
      } catch {}
      state.observer = null;
    }
    if (state.mutation) {
      try {
        state.mutation.disconnect();
      } catch {}
      state.mutation = null;
    }
    if (state.scanTimer) {
      clearTimeout(state.scanTimer);
      state.scanTimer = 0;
    }
    state.writing = true;
    for (const p of state.paragraphs.values()) {
      if (!p.el?.isConnected) continue;
      try {
        p.el.querySelectorAll(':scope > [data-bt-translation]').forEach((el) => el.remove());
        unwrapSource(p.el);
        p.el.removeAttribute('data-bt-paragraph');
        p.el.removeAttribute('data-bt-has-translation');
      } catch {}
    }
    for (const el of document.querySelectorAll('[data-bt-translation]')) el.remove();
    for (const source of document.querySelectorAll('[data-bt-source]')) {
      const parent = source.parentElement;
      if (!parent) continue;
      while (source.firstChild) parent.insertBefore(source.firstChild, source);
      source.remove();
    }
    for (const el of document.querySelectorAll('[data-bt-paragraph]')) {
      el.removeAttribute('data-bt-paragraph');
      el.removeAttribute('data-bt-has-translation');
    }
    document.documentElement.removeAttribute('data-bt-translate-state');
    document.getElementById('bt-page-style')?.remove();
    state.paragraphs.clear();
    state.byEl = new WeakMap();
    state.queue = [];
    state.root = null;
    state.writing = false;
    return status();
  }

  window.__BT_TRANSLATOR__ = {
    start,
    takeQueue,
    apply,
    fail,
    status,
    restore,
    setDisplay,
    retry,
    rescan: () => {
      if (!state.active) return status();
      const before = state.paragraphs.size;
      collect();
      return { ...status(), added: state.paragraphs.size - before };
    },
  };
})();
