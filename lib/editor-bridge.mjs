const sessions = new Map();
let activeSessionId = '';
let seq = 0;

function now() {
  return Date.now();
}

function prune() {
  const cutoff = now() - 120000;
  for (const [id, session] of sessions) {
    if (session.lastSeen < cutoff) {
      for (const waiter of session.waiters.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error('编辑器已关闭'));
      }
      sessions.delete(id);
      if (activeSessionId === id) activeSessionId = '';
    }
  }
}

export function registerEditor({ sessionId, filePath, kind }) {
  const id = String(sessionId || '').trim();
  if (!id) throw new Error('缺少 sessionId');
  prune();
  const previous = sessions.get(activeSessionId);
  if (previous && previous.sessionId !== id) {
    for (const waiter of previous.waiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('编辑器已切换'));
    }
    sessions.delete(activeSessionId);
  }
  sessions.set(id, {
    sessionId: id,
    filePath: String(filePath || ''),
    kind: String(kind || ''),
    pending: [],
    waiters: new Map(),
    lastSeen: now(),
  });
  activeSessionId = id;
  return { ok: true, sessionId: id, filePath: String(filePath || ''), kind: String(kind || '') };
}

export function unregisterEditor(sessionId) {
  const id = String(sessionId || '').trim();
  if (!id) return;
  const session = sessions.get(id);
  if (session) {
    for (const waiter of session.waiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('编辑器已关闭'));
    }
    sessions.delete(id);
  }
  if (activeSessionId === id) activeSessionId = '';
}

export function getActiveEditor() {
  prune();
  const session = sessions.get(activeSessionId);
  if (!session) return null;
  return {
    sessionId: session.sessionId,
    filePath: session.filePath,
    kind: session.kind,
    lastSeen: session.lastSeen,
  };
}

export function touchEditor(sessionId) {
  const id = String(sessionId || '').trim();
  const session = sessions.get(id);
  if (!session) return false;
  session.lastSeen = now();
  return true;
}

export function takeEditorOps(sessionId) {
  const id = String(sessionId || '').trim();
  const session = sessions.get(id);
  if (!session) return [];
  session.lastSeen = now();
  return session.pending.splice(0);
}

export function ackEditorOp(sessionId, opId, result) {
  const id = String(sessionId || '').trim();
  const session = sessions.get(id);
  if (!session) return false;
  const waiter = session.waiters.get(Number(opId));
  if (!waiter) return false;
  session.waiters.delete(Number(opId));
  clearTimeout(waiter.timer);
  waiter.resolve(result && typeof result === 'object' ? result : { ok: true });
  return true;
}

export function requestEditorOp(sessionId, op, timeoutMs = 20000) {
  const id = String(sessionId || '').trim();
  const session = sessions.get(id);
  if (!session) return Promise.reject(new Error('右侧没有正在编辑的文件'));
  const timeout = Math.max(1000, Math.min(60000, Number(timeoutMs) || 20000));
  return new Promise((resolve, reject) => {
    const opId = ++seq;
    const timer = setTimeout(() => {
      session.waiters.delete(opId);
      reject(new Error('编辑器没有响应，请确认右侧文件仍处于编辑状态'));
    }, timeout);
    session.waiters.set(opId, { resolve, reject, timer });
    session.pending.push({ id: opId, ...op });
    session.lastSeen = now();
  });
}
