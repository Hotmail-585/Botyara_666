// Клиент API бота. Заменяет Firebase: тот же стиль вызовов (ref, onValue, set, update, runTransaction),
// но данные приходят с сервера бота по WebSocket (а если WebSocket не работает, по SSE).
// Вход: токен Twitch меняется на сессию бота, сессия хранится в localStorage.

const SESSION_KEY = 'bot_session';

let apiUrl = '';
let session = null;           // { session, uid, login, exp }
let playerKey = '';           // ключ плеера (ссылка для OBS): даёт доступ к musicPlayer/{ключ} без входа
let ws = null;                // активный транспорт: { send(msg), close() }
let state = 'idle';           // idle | connecting | open
let everOpened = false;
let wsFails = 0;
let useSse = false;
let backoff = 1000;
let reconnectTimer = null;
let serverOffset = 0;
let seq = 0;
const subs = new Map();       // id -> { path, cb, errCb, offset }
const pending = new Map();    // rid -> { resolve, reject, timer }
const openWaiters = [];
const authListeners = new Set();

function storeGet() { try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch { return null; } }
function storeSet(v) { try { if (v) localStorage.setItem(SESSION_KEY, JSON.stringify(v)); else localStorage.removeItem(SESSION_KEY); } catch { /* не страшно */ } }

function apiError(code, message) {
  const e = new Error(message || code);
  e.code = code;
  return e;
}

function nextId(p) { seq += 1; return `${p}${seq}`; }

// ---------- Транспорты ----------
function openWebSocket(onMsg, onOpen, onClose) {
  const url = apiUrl.replace(/^http/, 'ws');
  const sock = new WebSocket(url);
  let opened = false;
  sock.onopen = () => { opened = true; onOpen(); };
  sock.onmessage = (ev) => { try { onMsg(JSON.parse(ev.data)); } catch { /* */ } };
  sock.onclose = () => onClose(opened);
  sock.onerror = () => { /* onclose придёт следом */ };
  return { send: (m) => { if (sock.readyState === 1) sock.send(JSON.stringify(m)); }, close: () => { try { sock.close(); } catch { /* */ } } };
}

function openSse(onMsg, onOpen, onClose) {
  const cid = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
  const es = new EventSource(`${apiUrl}/events?cid=${cid}`);
  let opened = false;
  es.onopen = () => { opened = true; onOpen(); };
  es.onmessage = (ev) => { try { onMsg(JSON.parse(ev.data)); } catch { /* */ } };
  es.onerror = () => { try { es.close(); } catch { /* */ } onClose(opened); };
  return {
    send: (m) => { fetch(`${apiUrl}/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cid, msg: m }) }).catch(() => {}); },
    close: () => { try { es.close(); } catch { /* */ } },
  };
}

// ---------- Соединение ----------
function connect() {
  if (state !== 'idle' || !apiUrl) return;
  state = 'connecting';
  const opener = useSse ? openSse : openWebSocket;
  let transport = null;
  const handle = (m) => onServer(m);
  transport = opener(handle, () => {
    ws = transport;
    state = 'open';
    everOpened = true;
    wsFails = 0;
    backoff = 1000;
    if (session) ws.send({ t: 'auth', token: session.session });
    if (playerKey) ws.send({ t: 'key', key: playerKey });
    for (const [id, s] of subs) ws.send({ t: 'sub', id, path: s.path });
    for (const w of openWaiters.splice(0)) w();
  }, (wasOpen) => {
    if (ws === transport || state === 'connecting') {
      ws = null;
      state = 'idle';
    }
    for (const [rid, p] of pending) { clearTimeout(p.timer); p.reject(apiError('unavailable', 'Нет связи с сервером')); pending.delete(rid); }
    if (!wasOpen && !everOpened && !useSse) {
      wsFails += 1;
      if (wsFails >= 2) { useSse = true; wsFails = 0; }
    }
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 20000);
  });
}

function waitOpen(ms = 8000) {
  if (state === 'open') return Promise.resolve();
  connect();
  return new Promise((resolve, reject) => {
    const w = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { const i = openWaiters.indexOf(w); if (i >= 0) openWaiters.splice(i, 1); reject(apiError('unavailable', 'Нет связи с сервером')); }, ms);
    openWaiters.push(w);
  });
}

function onServer(m) {
  switch (m.t) {
    case 'hello': serverOffset = Number(m.now) - Date.now(); for (const s of subs.values()) if (s.path === '.info/serverTimeOffset') s.cb({ val: () => serverOffset }); break;
    case 'authed': break;
    case 'autherr':
      if (session) { session = null; storeSet(null); for (const f of authListeners) f(null); }
      break;
    case 'val': { const s = subs.get(m.id); if (s) s.cb({ val: () => (m.value === undefined ? null : m.value), exists: () => m.value != null }); break; }
    case 'err': { const s = subs.get(m.id); if (s) { subs.delete(m.id); if (s.errCb) s.errCb(apiError(m.code || 'error')); } break; }
    case 'ok': case 'fail': {
      const p = pending.get(m.rid);
      if (!p) break;
      pending.delete(m.rid);
      clearTimeout(p.timer);
      if (m.t === 'ok') p.resolve(m); else p.reject(apiError(m.code || 'error', m.message));
      break;
    }
    default:
  }
}

async function request(msg) {
  await waitOpen();
  const rid = nextId('r');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(rid); reject(apiError('unavailable', 'Сервер не ответил')); }, 15000);
    pending.set(rid, { resolve, reject, timer });
    ws.send({ ...msg, rid });
  });
}

// ---------- Публичный интерфейс (как у Firebase) ----------
export function initApi(url) {
  apiUrl = String(url || '').replace(/\/+$/, '');
  session = storeGet();
  if (session && session.exp < Date.now()) { session = null; storeSet(null); }
}

export function startConnection() { connect(); }

export function currentSession() { return session ? { uid: session.uid, login: session.login } : null; }

export function onSessionChange(fn) { authListeners.add(fn); return () => authListeners.delete(fn); }

// Меняет токен Twitch (из адресной строки после входа) на сессию бота.
export async function loginWithTwitch(accessToken) {
  let res;
  try {
    res = await fetch(`${apiUrl}/auth/twitch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accessToken }) });
  } catch (e) { throw apiError('unavailable', 'Нет связи с сервером бота'); }
  let body = null;
  try { body = await res.json(); } catch { /* */ }
  if (!res.ok || !body || !body.session) throw apiError((body && body.error) || `http_${res.status}`, 'Вход не удался');
  session = body;
  storeSet(body);
  if (state === 'open') ws.send({ t: 'auth', token: body.session });
  for (const f of authListeners) f(currentSession());
  return currentSession();
}

export function logoutSession() {
  session = null;
  storeSet(null);
  if (ws) { try { ws.close(); } catch { /* */ } }
  for (const f of authListeners) f(null);
}

export function ref(_db, path = '') { return { path: String(path).replace(/^\/+|\/+$/g, '') }; }

export function serverTimestamp() { return { '.sv': 'timestamp' }; }

export function onValue(r, cb, errCb) {
  let once = false;
  if (errCb && typeof errCb === 'object') { once = errCb.onlyOnce === true; errCb = undefined; }
  if (once) {
    let off = () => {};
    let done = false;
    off = onValue(r, (snap) => { if (done) return; done = true; Promise.resolve().then(() => off()); cb(snap); });
    return () => { done = true; off(); };
  }
  const id = nextId('s');
  const entry = { path: r.path, cb, errCb };
  if (r.path === '.info/serverTimeOffset') {
    subs.set(id, entry);
    connect();
    if (state === 'open') cb({ val: () => serverOffset });
    return () => subs.delete(id);
  }
  subs.set(id, entry);
  if (state === 'open') ws.send({ t: 'sub', id, path: r.path });
  else connect();
  return () => {
    if (subs.delete(id) && state === 'open') ws.send({ t: 'unsub', id });
  };
}

export function set(r, value) { return request({ t: 'set', path: r.path, value: value === undefined ? null : value }).then(() => undefined); }

export function update(r, values) { return request({ t: 'update', path: r.path, value: values }).then(() => undefined); }

// Транзакция: читаем текущее значение, считаем новое, записываем только если за это время значение не изменилось.
export async function runTransaction(r, mutator) {
  let current = (await request({ t: 'get', path: r.path })).value;
  for (let attempt = 0; attempt < 5; attempt++) {
    const next = mutator(current === undefined ? null : current);
    if (next === undefined) return { committed: false };
    const res = await request({ t: 'tx', path: r.path, expected: current === undefined ? null : current, value: next });
    if (res.committed) return { committed: true };
    current = res.current === undefined ? null : res.current;
  }
  return { committed: false };
}

// Один раз прочитать значение.
export async function get(r) {
  const res = await request({ t: 'get', path: r.path });
  const v = res.value === undefined ? null : res.value;
  return { val: () => v, exists: () => v != null };
}

export async function remove(r) { return set(r, null); }

// Как push() в Firebase: ключ создаётся на клиенте и сортируется по времени.
const PUSH_CHARS = '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';
let lastPush = 0;
let lastRand = [];
function pushId() {
  let t = Date.now() + serverOffset;
  const dup = t === lastPush;
  lastPush = t;
  let head = '';
  for (let i = 0; i < 8; i++) { head = PUSH_CHARS.charAt(t % 64) + head; t = Math.floor(t / 64); }
  if (!dup) lastRand = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b % 64);
  else { let i = 11; for (; i >= 0 && lastRand[i] === 63; i--) lastRand[i] = 0; if (i >= 0) lastRand[i] += 1; }
  return head + lastRand.map((n) => PUSH_CHARS.charAt(n)).join('');
}
export function push(r, value) {
  const child = { path: r.path ? `${r.path}/${pushId()}` : pushId() };
  child.key = child.path.split('/').pop();
  const p = value === undefined ? Promise.resolve() : set(child, value);
  const out = p.then(() => child);
  out.key = child.key;
  out.path = child.path;
  return out;
}

// Ключ плеера для OBS-страниц (без входа через Twitch).
export function setPlayerKey(k) {
  playerKey = String(k || '');
  if (state === 'open' && playerKey) ws.send({ t: 'key', key: playerKey });
}

// Публичные настройки, которые бот сам отдаёт сайту (Client ID Twitch, ник бота, ключ YouTube).
export async function getPublicConfig() {
  const res = await fetch(`${apiUrl}/public-config`, { cache: 'no-store' });
  if (!res.ok) throw apiError(`http_${res.status}`, 'Бот не отдал настройки');
  return res.json();
}
