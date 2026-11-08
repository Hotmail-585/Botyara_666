// Кабинет Twitch-бота. Чистый JS-модуль, без сборки.
// Версия Firebase JS SDK зафиксирована в импортах ниже (одна и та же во всех трёх).
import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import {
  getAuth, GoogleAuthProvider, signInWithPopup, onAuthStateChanged, signOut,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import {
  getDatabase, ref, onValue, set, update, runTransaction, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js';

import { config } from './config.js';
import {
  LIMITS, TOKEN_PATTERN,
  validateValorantName, validateTag, validateRegion, validateCommandName,
  validateMessageText, validateInterval,
  normalizeChannel, timersAdd, timersEdit, timersRemove,
  accountsToList, listToAccounts, validateModLogin, renderPreview, MAX_ACCOUNTS,
  parseTwitchHash, buildTwitchAuthUrl, makeState,
  validateAdminLimit, formatAgo, formatDuration, alertsOf, botOnline, buildAdminRows,
} from './validation.js';

const $ = (id) => document.getElementById(id);
const VIEWS = ['loading', 'error', 'login', 'connect', 'linking', 'linkfail', 'nochannel', 'dashboard', 'admin'];
const STATE_KEY = 'twitch_oauth_state';
const TAB_KEY = 'bot_tab';
const BASE_TITLE = document.title;
const ADMIN_TICK_MS = 15 * 1000;
const PERM_HINT = 'Сервер отклонил действие. Проверьте, что в Firebase опубликованы новые правила (database.rules.json) и что ваш ник есть в ADMINS бота.';
const LIMIT_FIELDS = [
  ['limMaxChannels', 'maxChannels'],
  ['limMaxCommands', 'maxCommands'],
  ['limMaxTimers', 'maxTimers'],
  ['limInactiveDays', 'inactiveDays'],
];

let auth = null;
let db = null;

// Состояние текущей сессии (сбрасывается при выходе)
let S = null;
function freshState() {
  return {
    id: Date.now() + Math.random(),
    uid: null,
    email: '',                 // почта аккаунта Google (для подписи, пока Twitch не привязан)
    nick: null,
    channel: undefined,        // undefined = ещё не загружен, null = канала нет
    pendingToken: null,
    linking: false,
    linkTimer: null,
    unsubUser: null,
    unsubChannel: null,
    editingCmd: null,          // название команды, которую правим
    editingTimer: null,        // { index, old }
    dirtyValorant: false,
    dirtyInterval: false,
    // админ-панель
    isAdmin: false,
    tab: null,                 // 'cabinet' | 'admin' | null (= выбрать автоматически)
    unsubAdminFlag: null,
    adminUnsubs: [],
    adminTimer: null,
    admin: null,
    dirtyLimits: false,
    // подключение бота через сайт
    joining: null,             // { id, timer, unsub } пока ждём ответ бота
    showModHint: false,        // показать подсказку «выдайте боту модератора»
    // модераторы кабинета и переключатель каналов
    active: null,              // ник канала, которым управляем сейчас (свой или тот, куда добавили модератором)
    access: [],                // каналы, куда нас добавили модератором (modAccess/{ник})
    accessLoaded: false,
    autoLanded: false,         // у модератора без своего канала автоматически открыть первый доступный (один раз)
    unsubAccess: null,
    mods: null,                // наши модераторы (channelMods/{ник}), только для владельца
    unsubMods: null,
    testing: false,            // идёт тест: ждём ответ бота
  };
}

// ---------- Вспомогательное ----------

let currentView = 'loading';
function isOwn() { return !!S && S.active === S.nick; }

function showView(name) {
  currentView = name;
  for (const v of VIEWS) $('view-' + v).hidden = v !== name;
  const inCabinet = name === 'dashboard' || name === 'nochannel' || name === 'admin';
  $('userbox').hidden = !(name === 'connect' || (inCabinet && S?.nick));
  $('unlinkBtn').hidden = !S?.nick;
  $('tabs').hidden = !(inCabinet && S?.isAdmin && S?.nick);
  $('main').classList.toggle('wide', name === 'admin');
  renderTabs();
  renderChanBar();
}

// Выбор канала: виден, только если нас добавили модератором чужого канала.
function renderChanBar() {
  const bar = $('chanBar');
  const show = !!S && !!S.nick && S.access.length > 0 && (currentView === 'dashboard' || currentView === 'nochannel');
  bar.hidden = !show;
  if (!show) return;
  const sel = $('chanSelect');
  const options = [S.nick, ...S.access];
  const key = options.join(',');
  if (sel.dataset.key !== key) {
    sel.dataset.key = key;
    sel.replaceChildren(...options.map((n) => el('option', { value: n, text: n === S.nick ? `${n} (мой канал)` : n })));
  }
  sel.value = S.active;
  $('chanBarNote').textContent = isOwn()
    ? 'Вас добавили модератором на других каналах: выберите канал, чтобы управлять ботом там.'
    : `Вы управляете каналом ${S.active} как модератор: можно править команды, авто-сообщения, аккаунты Valorant и игры.`;
}

let toastTimer = null;
function toast(msg, kind = 'ok') {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast ' + kind;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, kind === 'err' ? 6500 : 2500);
}

function showFatal(text) {
  $('errorText').textContent = text;
  showView('error');
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) if (c) node.append(c);
  return node;
}

function setError(id, msg) {
  const p = $(id);
  p.textContent = msg || '';
  p.hidden = !msg;
}

function friendlyError(e, permHint) {
  const code = String(e?.code || '');
  const msg = String(e?.message || '');
  if (/permission_denied/i.test(code + msg)) {
    return permHint || 'Сервер не принял изменение. Возможно, бот отключён от канала (!leave) или данные не прошли проверку.';
  }
  if (/network|unavailable|offline|disconnected/i.test(code + msg)) {
    return 'Нет связи с сервером. Проверьте интернет и попробуйте ещё раз.';
  }
  return 'Не удалось сохранить: ' + (code || msg || 'неизвестная ошибка');
}

async function save(fn, okMsg, permHint) {
  try {
    await fn();
    if (okMsg) toast(okMsg, 'ok');
    return true;
  } catch (e) {
    console.error(e);
    toast(friendlyError(e, permHint), 'err');
    return false;
  }
}

function channelRef() { return ref(db, `channels/${S.active}`); }

// ---------- Настройки и запуск ----------

function configProblem() {
  const f = config.firebase || {};
  const needed = [f.apiKey, f.authDomain, f.databaseURL, f.projectId, f.appId, config.twitchClientId];
  if (needed.some((v) => !v || String(v).includes('ВСТАВЬТЕ'))) {
    return 'Сайт ещё не настроен: откройте файл config.js и впишите значения Firebase и Twitch Client ID.';
  }
  return null;
}

function redirectUri() {
  if (config.redirectUri) return config.redirectUri;
  const path = location.pathname.replace(/index\.html$/, '');
  return location.origin + path;
}

function saveOauthState(value) {
  try { sessionStorage.setItem(STATE_KEY, value); return true; } catch { /* ниже запасной вариант */ }
  try { localStorage.setItem(STATE_KEY, value); return true; } catch { return false; }
}
function takeOauthState() {
  let v = null;
  try { v = sessionStorage.getItem(STATE_KEY); sessionStorage.removeItem(STATE_KEY); } catch { /* */ }
  if (!v) {
    try { v = localStorage.getItem(STATE_KEY); localStorage.removeItem(STATE_KEY); } catch { /* */ }
  }
  return v;
}

function startLogin() {
  const state = makeState(crypto.getRandomValues(new Uint8Array(16)));
  if (!saveOauthState(state)) {
    toast('Браузер блокирует хранение данных сайта, вход через Twitch невозможен. Отключите приватный режим или блокировщик.', 'err');
    return;
  }
  location.href = buildTwitchAuthUrl({
    clientId: config.twitchClientId,
    redirectUri: redirectUri(),
    state,
  });
}

// Разбираем ответ Twitch из адресной строки и сразу убираем его оттуда.
function consumeTwitchReturn() {
  if (!/access_token=|error=/.test(location.hash)) return { token: null, message: null };
  const p = parseTwitchHash(location.hash);
  history.replaceState(null, '', location.pathname + location.search);
  const expected = takeOauthState();
  if (p.error) {
    return { token: null, message: 'Вход через Twitch отменён или не удался.' };
  }
  if (!expected || p.state !== expected) {
    return { token: null, message: 'Не удалось подтвердить вход (проверка state). Попробуйте войти ещё раз.' };
  }
  if (!p.accessToken || !TOKEN_PATTERN.test(p.accessToken)) {
    return { token: null, message: 'Twitch вернул неожиданный ответ. Попробуйте войти ещё раз.' };
  }
  return { token: p.accessToken, message: null };
}

function authErrorText(e) {
  const code = String(e?.code || '');
  if (/operation-not-allowed|admin-restricted/.test(code)) {
    return 'В Firebase не включён вход через Google. Откройте Authentication → Sign-in method и включите «Google».';
  }
  if (/unauthorized-domain/.test(code)) {
    return 'Адрес сайта не добавлен в Firebase: Authentication → Settings → Authorized domains.';
  }
  if (/network/.test(code)) return 'Нет связи с сервером. Проверьте интернет и обновите страницу.';
  return 'Не удалось войти в Firebase: ' + (code || e?.message || 'неизвестная ошибка');
}

function currentUserOnce() {
  return new Promise((resolve) => {
    const off = onAuthStateChanged(auth, (u) => { off(); resolve(u); });
  });
}

async function startSession(pendingToken = null) {
  teardown();
  S = freshState();
  S.pendingToken = pendingToken;
  showView('loading');
  $('loadingText').textContent = 'Загрузка…';
  const sid = S.id;
  let user;
  try {
    user = await currentUserOnce();
  } catch (e) {
    console.error(e);
    showFatal(authErrorText(e));
    return;
  }
  if (!S || S.id !== sid) return;
  if (!user) {                       // не вошли через Google
    S.pendingToken = null;
    showView('login');
    if (pendingToken) toast('Сессия Google не найдена. Войдите через Google и привяжите Twitch ещё раз.', 'err');
    return;
  }
  S.uid = user.uid;
  S.email = user.email || '';
  $('userNick').textContent = S.email;
  subscribeUser();
}

async function startGoogleLogin() {
  try {
    await signInWithPopup(auth, new GoogleAuthProvider());
  } catch (e) {
    const code = String(e?.code || '');
    if (/popup-closed-by-user|cancelled-popup-request/.test(code)) return;
    console.error(e);
    if (/popup-blocked/.test(code)) toast('Браузер заблокировал окно входа Google. Разрешите всплывающие окна для этого сайта.', 'err');
    else toast(authErrorText(e), 'err');
    return;
  }
  await startSession(null);
}

// Отвязка: пользователь сам удаляет свою связь с Twitch-каналом (правила разрешают только удаление своих записей).
async function unlinkTwitch() {
  if (!S?.nick) return;
  if (!confirm(`Отвязать Twitch-канал ${S.nick} от этого входа Google?\n\nНастройки бота на канале останутся. Привязать Twitch можно будет снова.`)) return;
  const { nick, uid } = S;
  await save(
    () => update(ref(db), { [`users/${uid}`]: null, [`links/${nick}/${uid}`]: null }),
    'Twitch отвязан',
  );
}

function teardown() {
  if (!S) return;
  endJoin();
  clearTimeout(S.linkTimer);
  try { S.unsubUser?.(); } catch { /* */ }
  try { S.unsubChannel?.(); } catch { /* */ }
  stopAccess();
  S.unsubUser = S.unsubChannel = null;
  stopAdmin();
  S.id = null;
}

// ---------- Привязка ----------

function subscribeUser() {
  const sid = S.id;
  S.unsubUser = onValue(
    ref(db, `users/${S.uid}`),
    (snap) => {
      if (!S || S.id !== sid) return;
      const v = snap.val();
      if (typeof v === 'string' && v) onLinked(v);
      else onUnlinked();
    },
    (err) => {
      console.error(err);
      if (!S || S.id !== sid) return;
      showFatal('Нет доступа к базе данных: ' + (err?.code || err?.message) + '. Проверьте правила базы и адрес databaseURL в config.js.');
    },
  );
}

function onLinked(nick) {
  clearTimeout(S.linkTimer);
  S.linking = false;
  S.pendingToken = null;
  if (S.nick === nick) return;
  S.nick = nick;
  S.active = nick;
  $('userNick').textContent = nick;
  S.channel = undefined;
  $('loadingText').textContent = 'Загружаем настройки…';
  showView('loading');
  subscribeChannel();
  subscribeAdminFlag();
  subscribeAccess();
  subscribeMods();
}

function onUnlinked() {
  if (S.nick) { // связь пропала на лету: начинаем заново
    try { S.unsubChannel?.(); } catch { /* */ }
    stopAdmin();
    stopAccess();
    endJoin();
    S.nick = null;
    S.active = null;
    S.autoLanded = false;
    S.channel = undefined;
    S.editingCmd = null;
    S.editingTimer = null;
    S.dirtyValorant = S.dirtyInterval = false;
    $('userNick').textContent = S.email;
  }
  if (S.pendingToken) { sendLink(); return; }
  if (!S.linking) showView('connect');
}

async function sendLink() {
  const token = S.pendingToken;
  S.pendingToken = null;
  S.linking = true;
  showView('linking');
  const sid = S.id;
  const fail = () => {
    if (!S || S.id !== sid || S.nick) return;
    S.linking = false;
    showView('linkfail');
  };
  S.linkTimer = setTimeout(fail, (config.linkTimeoutSec || 15) * 1000);
  try {
    await set(ref(db, `linkRequests/${S.uid}`), { token, createdAt: serverTimestamp() });
  } catch (e) {
    console.error(e);
    clearTimeout(S.linkTimer);
    fail();
  }
}

// ---------- Канал ----------

function subscribeChannel() {
  const sid = S.id;
  const nick = S.active;
  try { S.unsubChannel?.(); } catch { /* */ }
  S.unsubChannel = onValue(
    ref(db, `channels/${nick}`),
    (snap) => {
      if (!S || S.id !== sid || S.active !== nick) return;
      S.channel = normalizeChannel(snap.val());
      if (!S.channel) {
        S.editingCmd = null;
        S.editingTimer = null;
        if (nick !== S.nick) {          // чужой канал удалили
          toast(`Канал ${nick} больше недоступен. Открыт ваш канал.`, 'err');
          switchChannel(S.nick);
          return;
        }
      }
      route();
      maybeAutoLand();
    },
    (err) => {
      console.error(err);
      if (!S || S.id !== sid || S.active !== nick) return;
      if (nick !== S.nick) {            // доступ модератора отозвали
        toast(`Нет доступа к каналу ${nick}. Возможно, владелец убрал вас из модераторов.`, 'err');
        switchChannel(S.nick);
        return;
      }
      showFatal('Нет доступа к настройкам канала (' + (err?.code || err?.message) + '). Попробуйте выйти и войти заново.');
    },
  );
}

// Переключение на другой канал (свой или тот, где мы модератор кабинета).
function switchChannel(nick) {
  if (!S || !S.nick || S.active === nick) return;
  S.active = nick;
  S.channel = undefined;
  S.editingCmd = null;
  S.editingTimer = null;
  S.dirtyValorant = S.dirtyInterval = false;
  resetCommandForm();
  resetTimerForm();
  setError('accError', '');
  setError('vError', '');
  subscribeChannel();
  route();
}

// Модератор без собственного канала при первом входе сразу попадает на первый доступный канал.
function maybeAutoLand() {
  if (!S || S.autoLanded || !S.accessLoaded || !isOwn() || S.channel !== null || !S.access.length) return;
  S.autoLanded = true;
  switchChannel(S.access[0]);
}

const LOGIN_RE = /^[a-z0-9_]{3,25}$/;
function loginsOf(v, except) {
  return v && typeof v === 'object'
    ? Object.keys(v).filter((k) => v[k] === true && LOGIN_RE.test(k) && k !== except).sort()
    : [];
}

// Каналы, куда нас добавили модератором: modAccess/{наш ник}.
function subscribeAccess() {
  const sid = S.id;
  const nick = S.nick;
  S.unsubAccess = onValue(
    ref(db, `modAccess/${nick}`),
    (snap) => {
      if (!S || S.id !== sid || S.nick !== nick) return;
      S.access = loginsOf(snap.val(), nick);
      S.accessLoaded = true;
      if (!isOwn() && !S.access.includes(S.active)) {
        toast(`Доступ к каналу ${S.active} закрыт. Открыт ваш канал.`, 'err');
        switchChannel(nick);
      }
      maybeAutoLand();
      renderChanBar();
    },
    (err) => {
      console.error(err);
      if (!S || S.id !== sid) return;
      S.access = [];
      S.accessLoaded = true;
      renderChanBar();
    },
  );
}

// Наши модераторы: channelMods/{наш ник} (читает только владелец).
function subscribeMods() {
  const sid = S.id;
  const nick = S.nick;
  S.unsubMods = onValue(
    ref(db, `channelMods/${nick}`),
    (snap) => {
      if (!S || S.id !== sid || S.nick !== nick) return;
      S.mods = loginsOf(snap.val(), null);
      renderMods();
    },
    (err) => {
      console.error(err);
      if (!S || S.id !== sid) return;
      S.mods = null;
      renderMods();
    },
  );
}

function stopAccess() {
  if (!S) return;
  try { S.unsubAccess?.(); } catch { /* */ }
  try { S.unsubMods?.(); } catch { /* */ }
  S.unsubAccess = S.unsubMods = null;
  S.access = [];
  S.accessLoaded = false;
  S.mods = null;
}

// ---------- Подключение бота через сайт ----------

const JOIN_WAIT_MS = 25 * 1000;
const JOIN_MESSAGES = {
  notfound: 'Аккаунт Valorant не найден. Проверьте ник и тег.',
  ratelimit: 'Сервис рангов сейчас перегружен. Попробуйте через минуту.',
  apierror: 'Не удалось проверить аккаунт Valorant. Попробуйте позже.',
  blocked: 'Бот недоступен для вашего канала.',
  full: 'Свободных мест у бота пока нет. Попробуйте позже.',
  notlinked: 'Twitch не привязан к этому входу. Выйдите и привяжите Twitch заново.',
  badformat: 'Проверьте ник, тег и регион.',
  expired: 'Заявка устарела. Попробуйте ещё раз.',
  busy: 'Бот сейчас занят. Попробуйте через минуту.',
  error: 'Боту не удалось подключиться. Попробуйте позже.',
};

function setJoinBusy(busy, text = '') {
  for (const id of ['jName', 'jTag', 'jRegion', 'jSave']) $(id).disabled = busy;
  const st = $('jStatus');
  st.textContent = text;
  st.hidden = !text;
}

// Прекращает ожидание ответа бота (таймер и подписка на joinResults).
function endJoin() {
  const j = S?.joining;
  if (!j) return;
  clearTimeout(j.timer);
  try { j.unsub?.(); } catch { /* */ }
  S.joining = null;
  setJoinBusy(false);
}

function renderModHint() {
  const name = String(config.botName || '').replace(/[^A-Za-z0-9_]/g, '');
  $('modCmd').textContent = '/mod ' + (name || 'имя_бота');
  $('modHint').hidden = !S?.showModHint || !isOwn();
}

async function onJoinSubmit(ev) {
  ev.preventDefault();
  if (!S || S.joining) return;
  const n = validateValorantName($('jName').value);
  const t = validateTag($('jTag').value);
  const r = validateRegion($('jRegion').value);
  const bad = [n, t, r].find((x) => !x.ok);
  if (bad) { setError('jError', bad.error); return; }
  setError('jError', '');

  const sid = S.id;
  const uid = S.uid;
  const id = makeState(crypto.getRandomValues(new Uint8Array(12)));
  const job = { id, timer: null, unsub: null };
  S.joining = job;
  setJoinBusy(true, 'Подключаем бота… обычно это занимает несколько секунд.');

  job.unsub = onValue(
    ref(db, `joinResults/${uid}`),
    (snap) => {
      if (!S || S.id !== sid || S.joining !== job) return;
      const v = snap.val();
      if (!v || v.id !== id) return;              // ответ на какую-то прошлую заявку
      endJoin();
      if (v.code === 'ok') {
        S.showModHint = true;
        renderModHint();
        toast('Бот подключён к вашему каналу', 'ok');
      } else if (v.code === 'exists') {
        toast('Бот уже подключён к вашему каналу', 'ok');
      } else {
        setError('jError', JOIN_MESSAGES[v.code] || JOIN_MESSAGES.error);
      }
    },
    (err) => {
      console.error(err);
      if (!S || S.id !== sid || S.joining !== job) return;
      endJoin();
      setError('jError', friendlyError(err, 'Нет доступа к ответу бота. Проверьте, что в Firebase опубликованы новые правила (database.rules.json).'));
    },
  );
  job.timer = setTimeout(() => {
    if (!S || S.id !== sid || S.joining !== job) return;
    endJoin();
    if (S.channel === null) setError('jError', 'Бот не ответил. Возможно, он сейчас выключен. Попробуйте ещё раз позже.');
  }, JOIN_WAIT_MS);

  try {
    await set(ref(db, `joinRequests/${uid}`), {
      id, name: n.value, tag: t.value, region: r.value, createdAt: serverTimestamp(),
    });
  } catch (e) {
    console.error(e);
    if (S && S.id === sid && S.joining === job) {
      endJoin();
      setError('jError', friendlyError(e, 'Сервер отклонил заявку. Проверьте, что в Firebase опубликованы новые правила (database.rules.json).'));
    }
  }
}

// ---------- Вкладки и выбор экрана ----------

function loadTab() {
  try {
    const v = localStorage.getItem(TAB_KEY);
    return v === 'admin' || v === 'cabinet' ? v : null;
  } catch { return null; }
}
function saveTab(v) {
  try { localStorage.setItem(TAB_KEY, v); } catch { /* не страшно */ }
}

function effectiveTab() {
  if (!S || !S.isAdmin) return 'cabinet';
  if (S.tab) return S.tab;
  return S.channel === null ? 'admin' : 'cabinet';   // у владельца бота может не быть своего канала
}

function renderTabs() {
  const t = effectiveTab();
  $('tabCabinet').setAttribute('aria-selected', String(t === 'cabinet'));
  $('tabAdmin').setAttribute('aria-selected', String(t === 'admin'));
}

function setTab(tab) {
  if (!S || !S.isAdmin) return;
  S.tab = tab;
  saveTab(tab);
  route();
}

// Показывает нужный экран по текущему состоянию (вкладка, загружен ли канал, есть ли он).
function route() {
  if (!S || !S.nick) return;
  if (effectiveTab() === 'admin') {
    showView('admin');
    renderAdmin();
    return;
  }
  if (S.channel === undefined) { showView('loading'); return; }
  if (S.channel === null) { showView('nochannel'); return; }
  showView('dashboard');
  renderDashboard();
}

// ---------- Админ-панель ----------

function freshAdmin() {
  return {
    status: null, channels: null, stats: null, settings: null, blocked: null,
    loaded: {}, errors: {},
    offset: 0,                 // разница между часами сервера и этого устройства
    filter: '',
    seenAlertAt: null,         // самое новое оповещение, о котором уже знаем
    wasOnline: null,
  };
}

function serverNow() { return Date.now() + (S?.admin?.offset || 0); }

// Владелец бота определяется по узлу admins/{ник}: его пишет только бот из списка ADMINS.
function subscribeAdminFlag() {
  const sid = S.id;
  const nick = S.nick;
  S.unsubAdminFlag = onValue(
    ref(db, `admins/${nick}`),
    (snap) => {
      if (!S || S.id !== sid || S.nick !== nick) return;
      const is = snap.val() === true;
      if (is === S.isAdmin) return;
      S.isAdmin = is;
      if (is) { S.tab = loadTab(); startAdmin(); } else stopAdminData();
      route();
    },
    (err) => { console.error(err); /* не владелец или правила не обновлены: вкладки просто не будет */ },
  );
}

let adminRaf = null;
const adminPending = new Set();
function scheduleAdminRender(...parts) {
  for (const p of parts) adminPending.add(p);
  if (adminRaf) return;
  adminRaf = requestAnimationFrame(() => {
    adminRaf = null;
    const p = new Set(adminPending);
    adminPending.clear();
    if (S?.isAdmin && effectiveTab() === 'admin') renderAdmin(p);
  });
}

const ADMIN_SOURCES = [
  ['admin/status', 'status', ['status', 'alerts', 'limits']],
  ['channels', 'channels', ['channels']],
  ['admin/channelStats', 'stats', ['channels']],
  ['admin/settings', 'settings', ['limits']],
  ['admin/blocked', 'blocked', ['channels']],
];

function startAdmin() {
  stopAdminData();
  S.admin = freshAdmin();
  const sid = S.id;
  for (const [path, key, parts] of ADMIN_SOURCES) {
    S.adminUnsubs.push(onValue(
      ref(db, path),
      (snap) => {
        if (!S || S.id !== sid || !S.admin) return;
        S.admin[key] = snap.val();
        S.admin.loaded[key] = true;
        delete S.admin.errors[key];
        if (key === 'status') checkAdminEvents();
        scheduleAdminRender(...parts, ...(Object.keys(S.admin.errors).length ? ['status'] : []));
      },
      (err) => {
        console.error(err);
        if (!S || S.id !== sid || !S.admin) return;
        S.admin.errors[key] = err?.code || 'error';
        scheduleAdminRender('status');
      },
    ));
  }
  S.adminUnsubs.push(onValue(ref(db, '.info/serverTimeOffset'), (snap) => {
    if (S?.admin) S.admin.offset = Number(snap.val()) || 0;
  }));
  S.adminTimer = setInterval(() => {
    if (!S?.admin) return;
    checkAdminEvents();
    if (effectiveTab() === 'admin') renderAdmin(new Set(['status', 'alerts']));
  }, ADMIN_TICK_MS);
}

// Закрывает только данные админ-панели (подписки, таймер, значок в названии), флаг владельца остаётся.
function stopAdminData() {
  if (!S) return;
  for (const off of S.adminUnsubs) { try { off(); } catch { /* */ } }
  S.adminUnsubs = [];
  clearInterval(S.adminTimer);
  S.adminTimer = null;
  S.admin = null;
  document.title = BASE_TITLE;
}

// Закрывает всё: и данные, и слежение за флагом владельца (выход, потеря привязки).
function stopAdmin() {
  if (!S) return;
  stopAdminData();
  try { S.unsubAdminFlag?.(); } catch { /* */ }
  S.unsubAdminFlag = null;
  S.isAdmin = false;
}

function renderAdmin(parts = new Set(['status', 'alerts', 'channels', 'limits'])) {
  if (!S?.isAdmin || !S.admin) return;
  if (parts.has('status')) renderBotState();
  if (parts.has('alerts')) renderAlerts();
  if (parts.has('channels')) renderAdminChannels();
  if (parts.has('limits')) renderLimits();
  updateNotifyButton();
}

function kvRow(grid, label, value) {
  grid.append(el('dt', { text: label }), el('dd', { text: value }));
}

function renderBotState() {
  const A = S.admin;
  const st = A.status;
  const box = $('botState');
  const grid = $('statusGrid');
  box.replaceChildren();
  grid.replaceChildren();

  const setState = (cls, text) => box.append(el('span', { class: 'dot ' + cls, 'aria-hidden': 'true' }), el('span', { text }));

  if (Object.keys(A.errors).length) {
    setState('bad', 'Нет доступа к данным админ-панели (' + Object.values(A.errors)[0] + '). ' + PERM_HINT);
    return;
  }
  if (!A.loaded.status) { setState('warn', 'Загрузка…'); return; }
  if (!st) {
    setState('warn', 'Бот ещё не передавал своё состояние. Обновите bot.js на хостинге и перезапустите бота.');
    return;
  }

  const now = serverNow();
  const online = botOnline(st, now);
  if (online) setState('ok', 'Бот онлайн');
  else setState('bad', 'Бот не отвечает: последний сигнал ' + (Number.isFinite(st.heartbeatAt) ? formatAgo(now - st.heartbeatAt) : 'неизвестно когда'));

  kvRow(grid, 'Работает без перезапуска', online && Number.isFinite(st.startedAt) ? formatDuration(now - st.startedAt) : '—');

  const tw = st.twitch || {};
  let twText = tw.connected ? 'Подключён' : 'Нет соединения';
  if (Number.isFinite(tw.lastDisconnectAt)) {
    twText += ` (последний разрыв ${formatAgo(now - tw.lastDisconnectAt)}${tw.lastDisconnectReason ? ': ' + tw.lastDisconnectReason : ''})`;
  }
  kvRow(grid, 'Twitch', twText);

  const c = st.channels || {};
  const lim = st.limits || {};
  kvRow(grid, 'Каналы', `${c.total ?? 0} из ${lim.maxChannels ?? '?'} · включено ${c.enabled ?? 0} · заблокировано ${c.blocked ?? 0}`);

  const h = st.henrik || {};
  kvRow(grid, 'HenrikDev: запросов', `за час ${h.requestsHour ?? 0}, за сутки ${h.requestsDay ?? 0}`);
  kvRow(grid, 'HenrikDev: ошибок', `за час ${h.errorsHour ?? 0}, за сутки ${h.errorsDay ?? 0} (ответов 429 за сутки: ${h.rateLimitedDay ?? 0})`);

  if (Number.isFinite(h.remaining) && Number.isFinite(h.limit)) {
    const expired = Number.isFinite(h.resetAt) && now > h.resetAt;
    const ago = Number.isFinite(h.observedAt) ? formatAgo(now - h.observedAt) : '';
    const text = expired
      ? `окно уже сбросилось, доступно до ${h.limit} запросов (по последнему ответу, ${ago}, оставалось ${h.remaining})`
      : `осталось ${h.remaining} из ${h.limit}${Number.isFinite(h.resetAt) ? `, сброс через ${Math.max(0, Math.ceil((h.resetAt - now) / 1000))} с` : ''} (по последнему ответу, ${ago})`;
    kvRow(grid, 'HenrikDev: лимит запросов', text);
  } else {
    kvRow(grid, 'HenrikDev: лимит запросов', 'пока нет данных (появятся после первого запроса !rank)');
  }

  let last = '—';
  if (h.lastStatus) last = `HTTP ${h.lastStatus}`;
  if (Number.isFinite(h.lastOkAt)) last += `, последний успешный ответ ${formatAgo(now - h.lastOkAt)}`;
  kvRow(grid, 'HenrikDev: последний ответ', last);
  if (h.lastError && Number.isFinite(h.lastErrorAt)) kvRow(grid, 'HenrikDev: последняя ошибка', `${h.lastError} (${formatAgo(now - h.lastErrorAt)})`);
}

const ALERT_LEVEL = { info: ['Инфо', ''], warn: ['Внимание', 'warn'], error: ['Ошибка', 'bad'] };

function renderAlerts() {
  const list = $('alertList');
  list.replaceChildren();
  const alerts = alertsOf(S.admin.status);
  const now = serverNow();
  for (const a of alerts) {
    const [label, cls] = ALERT_LEVEL[a.level];
    list.append(el('li', { class: 'item alert-item' }, [
      el('span', { class: 'pill ' + cls, text: label }),
      el('span', { class: 'item-text', text: a.text }),
      el('span', { class: 'when', text: formatAgo(now - a.at) }),
    ]));
  }
  $('alertEmpty').hidden = alerts.length > 0;
}

const STATUS_VIEW = {
  active: ['Работает', 'ok'],
  off: ['Выключен', 'warn'],
  'auto-off': ['Отключён из-за тишины', 'warn'],
  blocked: ['Заблокирован', 'bad'],
};

function renderAdminChannels() {
  const A = S.admin;
  const list = $('chanList');
  list.replaceChildren();
  if (!A.loaded.channels) { $('chanEmpty').textContent = 'Загрузка…'; $('chanEmpty').hidden = false; return; }

  const rows = buildAdminRows(A.channels, A.stats, A.blocked);
  $('chanCount').textContent = `(${rows.length})`;
  const q = A.filter.trim().toLowerCase();
  const shown = q ? rows.filter((r) => r.nick.includes(q)) : rows;
  const now = serverNow();

  for (const r of shown) {
    const [label, cls] = STATUS_VIEW[r.status];
    const head = el('div', { class: 'chan-head' }, [
      /^[a-z0-9_]{3,25}$/.test(r.nick)
        ? el('a', { href: `https://www.twitch.tv/${r.nick}`, target: '_blank', rel: 'noopener', text: r.nick })
        : el('span', { text: r.nick }),
      el('span', { class: 'pill ' + cls, text: label }),
    ]);
    const activity = r.stat.lastMessageAt
      ? `последнее сообщение в чате ${formatAgo(now - r.stat.lastMessageAt)}`
      : 'сообщений в чате ещё не было';
    const main = el('div', { class: 'item-main' }, [
      head,
      el('div', { class: 'chan-meta', text: `Valorant: ${r.name || '—'}#${r.tag || '—'} (${r.region})` }),
      el('div', { class: 'chan-meta', text: `Команд: ${r.commands} · авто-сообщений: ${r.timers} · !rank: ${r.stat.rank} · своих команд: ${r.stat.cmd} · сообщений в чате: ${r.stat.messages}` }),
      el('div', { class: 'chan-meta', text: activity }),
      r.blocked ? el('div', { class: 'chan-reason', text: 'Причина блокировки: ' + (r.blocked.reason || 'не указана') }) : null,
    ]);

    const actions = [];
    if (r.status !== 'blocked') {
      actions.push(el('button', {
        class: 'btn small', type: 'button', text: r.enabled ? 'Выключить' : 'Включить',
        onclick: () => adminSetEnabled(r.nick, !r.enabled),
      }));
      actions.push(el('button', {
        class: 'btn small danger', type: 'button', text: 'Заблокировать',
        onclick: () => adminBlock(r.nick),
      }));
    } else {
      actions.push(el('button', {
        class: 'btn small', type: 'button', text: 'Разблокировать',
        onclick: () => adminUnblock(r.nick),
      }));
    }
    actions.push(el('button', {
      class: 'btn small danger', type: 'button', text: 'Удалить',
      onclick: () => adminRemove(r.nick),
    }));

    list.append(el('li', { class: 'item chan' + (r.status === 'blocked' ? ' blocked' : '') }, [
      main,
      el('div', { class: 'item-actions' }, actions),
    ]));
  }

  const empty = $('chanEmpty');
  if (!rows.length) { empty.textContent = 'К боту пока не подключён ни один канал.'; empty.hidden = false; }
  else if (!shown.length) { empty.textContent = 'Ничего не найдено.'; empty.hidden = false; }
  else empty.hidden = true;
}

function renderLimits() {
  const A = S.admin;
  const st = A.status;
  const settings = A.settings && typeof A.settings === 'object' ? A.settings : {};
  for (const [id, key] of LIMIT_FIELDS) {
    const input = $(id);
    const def = st?.defaults?.[key];
    input.placeholder = Number.isFinite(def) ? `по умолчанию: ${def}` : 'по умолчанию';
    if (!S.dirtyLimits) input.value = Number.isInteger(settings[key]) ? String(settings[key]) : '';
  }
  const l = st?.limits;
  $('limitsNote').textContent = l
    ? `Сейчас действует: каналов до ${l.maxChannels}, команд до ${l.maxCommands}, авто-сообщений до ${l.maxTimers}, ${l.inactiveDays ? `отключение после ${l.inactiveDays} дн. тишины` : 'автоотключение выключено'}. Лимиты не удаляют то, что уже есть: они только не дают добавить сверх нормы.`
    : '';
}

// ---------- Админ-панель: действия ----------

async function adminSetEnabled(nick, on) {
  await save(
    () => update(ref(db, `channels/${nick}`), { enabled: on }),
    on ? `Канал ${nick} включён` : `Канал ${nick} выключен`,
    PERM_HINT,
  );
}

async function adminBlock(nick) {
  const reason = prompt(`Заблокировать канал ${nick}? Бот перестанет отвечать в его чате и не даст ему подключиться снова.\n\nПричина (можно оставить пустой):`, '');
  if (reason === null) return;
  const text = reason.replace(/\s+/g, ' ').trim().slice(0, 100);
  const data = { at: serverTimestamp() };
  if (text) data.reason = text;
  await save(() => set(ref(db, `admin/blocked/${nick}`), data), `Канал ${nick} заблокирован`, PERM_HINT);
}

async function adminUnblock(nick) {
  await save(() => set(ref(db, `admin/blocked/${nick}`), null), `Канал ${nick} разблокирован`, PERM_HINT);
}

async function adminRemove(nick) {
  if (!confirm(`Удалить канал ${nick} из бота?\n\nКоманды, авто-сообщения и настройки этого канала пропадут. Стример сможет подключиться заново командой !join.`)) return;
  await save(() => set(ref(db, `channels/${nick}`), null), `Канал ${nick} удалён`, PERM_HINT);
}

async function onLimitsSubmit(ev) {
  ev.preventDefault();
  const changes = {};
  for (const [id, key] of LIMIT_FIELDS) {
    const r = validateAdminLimit(key, $(id).value);
    if (!r.ok) { setError('limitsError', r.error); return; }
    changes[key] = r.value;       // null = убрать своё значение, бот возьмёт значение по умолчанию
  }
  setError('limitsError', '');
  $('limitsSave').disabled = true;
  const ok = await save(() => update(ref(db, 'admin/settings'), changes), 'Лимиты сохранены', PERM_HINT);
  $('limitsSave').disabled = false;
  if (ok) S.dirtyLimits = false;
}

// ---------- Админ-панель: события и уведомления ----------

function notify(msg, kind = 'err') {
  toast(msg, kind);
  try {
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification('Кабинет Twitch-бота', { body: msg });
    }
  } catch { /* не страшно */ }
}

// Следит за состоянием бота: новые оповещения, пропажа и возвращение сигнала, значок в названии вкладки.
function checkAdminEvents() {
  const A = S?.admin;
  if (!A || !A.loaded.status || !A.status) return;
  const now = serverNow();
  const alerts = alertsOf(A.status);
  const newest = alerts.reduce((m, a) => Math.max(m, a.at), 0);

  if (A.seenAlertAt === null) {
    A.seenAlertAt = newest;                       // при открытии страницы про старые оповещения не уведомляем
  } else if (newest > A.seenAlertAt) {
    const fresh = alerts.filter((a) => a.at > A.seenAlertAt && a.level !== 'info');
    A.seenAlertAt = newest;
    for (const a of fresh.slice(0, 3)) notify('Бот: ' + a.text, a.level === 'error' ? 'err' : 'err');
  }

  const online = botOnline(A.status, now);
  if (A.wasOnline === true && !online) notify('Бот не отвечает: сигнал пропал.');
  else if (A.wasOnline === false && online) notify('Бот снова онлайн.', 'ok');
  A.wasOnline = online;

  const recentError = alerts.some((a) => a.level === 'error' && now - a.at < 30 * 60 * 1000);
  document.title = !online || recentError ? '⚠ ' + BASE_TITLE : BASE_TITLE;
}

function updateNotifyButton() {
  const b = $('notifyBtn');
  if (!('Notification' in window)) { b.hidden = true; return; }
  b.hidden = false;
  const p = Notification.permission;
  b.disabled = p !== 'default';
  b.textContent = p === 'granted' ? 'Уведомления в браузере включены'
    : p === 'denied' ? 'Уведомления запрещены в браузере'
      : 'Включить уведомления в браузере';
}

async function onNotifyClick() {
  try { await Notification.requestPermission(); } catch (e) { console.error(e); }
  updateNotifyButton();
}

// ---------- Отрисовка кабинета ----------

function renderDashboard() {
  const ch = S.channel;
  if (!ch) return;

  // Бот вкл/выкл
  $('enabledToggle').checked = ch.enabled;
  $('enabledLabel').textContent = ch.enabled ? 'Включён' : 'Выключен';
  $('enabledNote').textContent = ch.enabled
    ? 'Бот отвечает в чате: !rank, свои команды и авто-сообщения работают.'
    : 'Бот молчит в чате: !rank, команды и авто-сообщения не отправляются. Управление через чат продолжает работать.';

  // Valorant
  if (!S.dirtyValorant) {
    $('vName').value = ch.name;
    $('vTag').value = ch.tag;
    $('vRegion').value = ch.region;
  }

  // Игры
  $('gamesToggle').checked = ch.games;
  $('gamesLabel').textContent = ch.games ? 'Включены' : 'Выключены';

  renderModHint();
  renderAccounts(ch);
  renderMods();
  renderCommands(ch);
  renderTimers(ch);
  renderPreviews();
}

function renderCommands(ch) {
  const list = $('cmdList');
  list.replaceChildren();
  for (const [name, text] of ch.commands) {
    const li = el('li', { class: 'item' + (S.editingCmd === name ? ' editing' : '') }, [
      el('div', { class: 'item-main' }, [
        el('div', { class: 'item-name', text: name }),
        el('div', { class: 'item-text', text: text }),
      ]),
      el('div', { class: 'item-actions' }, [
        testButton(text),
        el('button', { class: 'btn small', type: 'button', text: 'Изменить', onclick: () => editCommand(name, text) }),
        el('button', { class: 'btn small danger', type: 'button', text: 'Удалить', onclick: () => deleteCommand(name) }),
      ]),
    ]);
    list.append(li);
  }
  $('cmdEmpty').hidden = ch.commands.length > 0;
  // если правимую команду удалили в чате: выходим из режима правки
  if (S.editingCmd && !ch.commands.some(([n]) => n === S.editingCmd)) resetCommandForm();
}

function renderTimers(ch) {
  $('timerToggle').checked = !ch.timerOff;
  $('timerLabel').textContent = ch.timerOff ? 'Выключены' : 'Включены';

  if (!S.dirtyInterval) $('tInterval').value = ch.timerInterval == null ? '' : String(ch.timerInterval);
  $('intervalNote').textContent = ch.timerInterval == null
    ? 'Сейчас используется интервал по умолчанию, заданный в боте. Чтобы задать свой, введите число минут от 1 до 1440.'
    : `Бот пишет одно сообщение раз в ${ch.timerInterval} мин. (если в чате есть активность). Пустое поле = интервал по умолчанию.`;

  const list = $('timerList');
  list.replaceChildren();
  ch.timers.forEach((text, index) => {
    list.append(el('li', { class: 'item' + (S.editingTimer?.index === index ? ' editing' : '') }, [
      el('div', { class: 'item-main' }, [el('div', { class: 'item-text', text })]),
      el('div', { class: 'item-actions' }, [
        testButton(text),
        el('button', { class: 'btn small', type: 'button', text: 'Изменить', onclick: () => editTimer(index, text) }),
        el('button', { class: 'btn small danger', type: 'button', text: 'Удалить', onclick: () => deleteTimer(index, text) }),
      ]),
    ]));
  });
  $('timerEmpty').hidden = ch.timers.length > 0;

  const botLimit = config.botTimersLimit;
  const warn = $('timerWarn');
  if (botLimit && ch.timers.length > botLimit) {
    warn.textContent = `Бот по умолчанию принимает до ${botLimit} авто-сообщений (лимит задаёт владелец бота), остальные могут не отправляться.`;
    warn.hidden = false;
  } else {
    warn.hidden = true;
  }

  if (S.editingTimer && ch.timers[S.editingTimer.index] !== S.editingTimer.old) resetTimerForm();
}

// ---------- Действия: бот и Valorant ----------

async function onEnabledChange() {
  const box = $('enabledToggle');
  box.disabled = true;
  await save(() => update(channelRef(), { enabled: box.checked }), box.checked ? 'Бот включён' : 'Бот выключен');
  box.disabled = false;
}

async function onValorantSubmit(ev) {
  ev.preventDefault();
  const n = validateValorantName($('vName').value);
  const t = validateTag($('vTag').value);
  const r = validateRegion($('vRegion').value);
  const bad = [n, t, r].find((x) => !x.ok);
  if (bad) { setError('vError', bad.error); return; }
  setError('vError', '');
  $('vSave').disabled = true;
  const ok = await save(() => update(channelRef(), { name: n.value, tag: t.value, region: r.value }), 'Аккаунт Valorant сохранён');
  $('vSave').disabled = false;
  if (ok) {
    S.dirtyValorant = false;
    $('vName').value = n.value;
    $('vTag').value = t.value;
  }
}

// ---------- Аккаунты Valorant ----------

function allAccounts(ch) { return [{ name: ch.name, tag: ch.tag, region: ch.region }, ...ch.accounts]; }
function activeNumber(ch) { return ch.activeAccount <= allAccounts(ch).length ? ch.activeAccount : 1; }

function renderAccounts(ch) {
  const all = allAccounts(ch);
  const act = activeNumber(ch);
  const list = $('accList');
  list.replaceChildren();
  all.forEach((a, i) => {
    const n = i + 1;
    const actions = [];
    if (act !== n) {
      actions.push(el('button', { class: 'btn small', type: 'button', text: 'Сделать активным', onclick: () => setActiveAccount(n) }));
    }
    if (n > 1) actions.push(el('button', { class: 'btn small danger', type: 'button', text: 'Удалить', onclick: () => deleteAccount(n) }));
    list.append(el('li', { class: 'item' }, [
      el('div', { class: 'item-main' }, [
        el('div', { class: 'item-name' }, [
          document.createTextNode(`${n}) ${a.name}#${a.tag} (${a.region})`),
          n === 1 ? el('span', { class: 'pill', text: 'основной' }) : null,
          act === n ? el('span', { class: 'pill ok', text: 'активный' }) : null,
        ]),
      ]),
      el('div', { class: 'item-actions' }, actions),
    ]));
  });
  const full = all.length >= MAX_ACCOUNTS;
  $('accFull').hidden = !full;
  for (const id of ['aName', 'aTag', 'aRegion', 'accAdd']) $(id).disabled = full;
}

async function setActiveAccount(n) {
  await save(() => update(channelRef(), { activeAccount: n === 1 ? null : n }), `Активный аккаунт: №${n}`);
}

async function onAccountAdd(ev) {
  ev.preventDefault();
  const ch = S.channel;
  const n = validateValorantName($('aName').value);
  const t = validateTag($('aTag').value);
  const r = validateRegion($('aRegion').value);
  const bad = [n, t, r].find((x) => !x.ok);
  if (bad) { setError('accError', bad.error); return; }
  const all = allAccounts(ch);
  if (all.length >= MAX_ACCOUNTS) { setError('accError', `Максимум аккаунтов: ${MAX_ACCOUNTS}.`); return; }
  if (all.some((a) => a.name.toLowerCase() === n.value.toLowerCase() && a.tag.toLowerCase() === t.value.toLowerCase())) {
    setError('accError', 'Этот аккаунт уже добавлен.');
    return;
  }
  setError('accError', '');
  $('accAdd').disabled = true;
  const ok = await save(() => update(channelRef(), {
    accounts: listToAccounts([...ch.accounts, { name: n.value, tag: t.value, region: r.value }]),
  }), `Аккаунт №${all.length + 1} добавлен`);
  $('accAdd').disabled = false;
  if (ok) { $('aName').value = ''; $('aTag').value = ''; }
}

async function deleteAccount(n) {
  const ch = S.channel;
  const all = allAccounts(ch);
  const target = all[n - 1];
  if (!target || !confirm(`Удалить аккаунт ${target.name}#${target.tag}?`)) return;
  const extras = ch.accounts.filter((_, i) => i !== n - 2);
  let act = activeNumber(ch);
  if (act === n) act = 1; else if (act > n) act -= 1;
  await save(() => update(channelRef(), {
    accounts: listToAccounts(extras),
    activeAccount: act === 1 ? null : act,
  }), 'Аккаунт удалён');
}

async function onGamesChange() {
  const box = $('gamesToggle');
  box.disabled = true;
  await save(() => update(channelRef(), { games: box.checked }), box.checked ? 'Мини-игры включены' : 'Мини-игры выключены');
  box.disabled = false;
}

// ---------- Модераторы кабинета ----------

function renderMods() {
  const card = $('modsCard');
  const own = isOwn();
  card.hidden = !own || S?.mods === null;
  if (card.hidden) return;
  const list = $('modList');
  list.replaceChildren();
  for (const login of S.mods) {
    list.append(el('li', { class: 'item' }, [
      el('div', { class: 'item-main' }, [el('div', { class: 'item-name', text: login })]),
      el('div', { class: 'item-actions' }, [
        el('button', { class: 'btn small danger', type: 'button', text: 'Убрать', onclick: () => removeMod(login) }),
      ]),
    ]));
  }
  $('modEmpty').hidden = S.mods.length > 0;
}

const MODS_MAX = 20;

async function onModAdd(ev) {
  ev.preventDefault();
  if (!isOwn()) return;
  const r = validateModLogin($('modName').value);
  if (!r.ok) { setError('modError', r.error); return; }
  if (r.value === S.nick) { setError('modError', 'Это ваш собственный ник: вы и так владелец.'); return; }
  if (S.mods.includes(r.value)) { setError('modError', 'Этот человек уже добавлен.'); return; }
  if (S.mods.length >= MODS_MAX) { setError('modError', `Максимум модераторов: ${MODS_MAX}.`); return; }
  setError('modError', '');
  $('modAdd').disabled = true;
  const ok = await save(() => update(ref(db), {
    [`channelMods/${S.nick}/${r.value}`]: true,
    [`modAccess/${r.value}/${S.nick}`]: true,
  }), `${r.value} добавлен(а) как модератор кабинета`, PERM_HINT);
  $('modAdd').disabled = false;
  if (ok) $('modName').value = '';
}

async function removeMod(login) {
  if (!isOwn() || !confirm(`Убрать ${login} из модераторов кабинета?`)) return;
  await save(() => update(ref(db), {
    [`channelMods/${S.nick}/${login}`]: null,
    [`modAccess/${login}/${S.nick}`]: null,
  }), `${login} больше не модератор кабинета`, PERM_HINT);
}

// ---------- Предпросмотр и тест ----------

function renderChat(boxId, lines) {
  const box = $(boxId);
  box.replaceChildren();
  box.hidden = lines.length === 0;
  for (const [kind, who, text] of lines) {
    box.append(el('div', { class: 'chat-line ' + kind }, [el('span', { class: 'who', text: who + ':' }), document.createTextNode(text)]));
  }
}

function renderPreviews() {
  const text = $('cmdText').value.trim();
  const name = $('cmdName').value.trim().toLowerCase();
  renderChat('cmdPreview', text
    ? [['viewer', 'Зритель', name ? (name.startsWith('!') ? name : '!' + name) : '!команда'], ['bot', 'Бот', renderPreview(text)]]
    : []);
  const t = $('timerText').value.trim();
  renderChat('timerPreview', t ? [['bot', 'Бот', renderPreview(t)]] : []);
}

const TEST_WAIT_MS = 12 * 1000;
const TEST_MESSAGES = {
  forbidden: 'Нет прав писать в чат этого канала.',
  blocked: 'Бот недоступен для этого канала.',
  nochannel: 'Бот сейчас не подключён к чату этого канала.',
  badtext: 'Бот не принял текст: он пустой, слишком длинный или начинается с «/» или «.».',
  cooldown: 'Слишком часто. Подождите несколько секунд.',
  expired: 'Запрос устарел. Попробуйте ещё раз.',
  notlinked: 'Twitch не привязан к этому входу. Выйдите и привяжите Twitch заново.',
  error: 'Боту не удалось отправить сообщение. Попробуйте позже.',
};

function testButton(getText) {
  const btn = el('button', { class: 'btn small test-btn', type: 'button', text: 'Тест' });
  btn.disabled = !!S?.testing;
  btn.addEventListener('click', () => sendTest(typeof getText === 'function' ? getText() : getText));
  return btn;
}

function setTestBusy(busy) {
  for (const b of document.querySelectorAll('.test-btn')) b.disabled = busy;
}

// Просит бота отправить текст в чат канала (testRequests -> testResults). Бот сам подставит {user} = ваш ник.
async function sendTest(raw) {
  if (!S || !S.channel || S.testing) return;
  const t = validateMessageText(raw);
  if (!t.ok) { toast(t.error, 'err'); return; }
  const sid = S.id;
  const uid = S.uid;
  const chan = S.active;
  const id = makeState(crypto.getRandomValues(new Uint8Array(12)));
  S.testing = true;
  setTestBusy(true);
  let finished = false;
  let unsub = null;
  let timer = null;
  const done = (msg, kind) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    try { unsub?.(); } catch { /* */ }
    if (S && S.id === sid) S.testing = false;
    setTestBusy(false);
    toast(msg, kind);
  };
  unsub = onValue(
    ref(db, `testResults/${uid}`),
    (snap) => {
      const v = snap.val();
      if (!v || v.id !== id) return;                // ответ на прошлый запрос
      if (v.code === 'ok') done('Сообщение отправлено в чат', 'ok');
      else done(TEST_MESSAGES[v.code] || TEST_MESSAGES.error, 'err');
    },
    (err) => {
      console.error(err);
      done(friendlyError(err, 'Нет доступа к ответу бота. Проверьте, что в Firebase опубликованы новые правила (database.rules.json).'), 'err');
    },
  );
  timer = setTimeout(() => done('Бот не ответил. Возможно, он сейчас выключен.', 'err'), TEST_WAIT_MS);
  try {
    await set(ref(db, `testRequests/${uid}`), { id, text: t.value, channel: chan, createdAt: serverTimestamp() });
  } catch (e) {
    console.error(e);
    done(friendlyError(e, 'Сервер отклонил запрос. Проверьте, что в Firebase опубликованы новые правила (database.rules.json).'), 'err');
  }
}

// ---------- Действия: команды ----------

function resetCommandForm() {
  S.editingCmd = null;
  $('cmdName').value = '';
  $('cmdText').value = '';
  $('cmdFormTitle').textContent = 'Новая команда';
  $('cmdSave').textContent = 'Добавить команду';
  $('cmdCancel').hidden = true;
  setError('cmdError', '');
  updateCounter('cmdText', 'cmdCount');
  renderPreviews();
}

function editCommand(name, text) {
  S.editingCmd = name;
  $('cmdName').value = name;
  $('cmdText').value = text;
  $('cmdFormTitle').textContent = 'Изменить команду';
  $('cmdSave').textContent = 'Сохранить изменения';
  $('cmdCancel').hidden = false;
  setError('cmdError', '');
  updateCounter('cmdText', 'cmdCount');
  renderPreviews();
  renderCommands(S.channel);
  $('cmdForm').scrollIntoView({ behavior: 'smooth', block: 'center' });
  $('cmdText').focus();
}

async function onCommandSubmit(ev) {
  ev.preventDefault();
  const n = validateCommandName($('cmdName').value);
  if (!n.ok) { setError('cmdError', n.error); return; }
  const t = validateMessageText($('cmdText').value);
  if (!t.ok) { setError('cmdError', t.error); return; }

  const old = S.editingCmd;
  const exists = S.channel.commands.some(([name]) => name === n.value);
  if (exists && n.value !== old) {
    setError('cmdError', `Команда ${n.value} уже есть. Нажмите «Изменить» рядом с ней.`);
    return;
  }
  setError('cmdError', '');

  const changes = { [`commands/${n.value}`]: t.value };
  if (old && old !== n.value) changes[`commands/${old}`] = null; // переименование
  $('cmdSave').disabled = true;
  const ok = await save(() => update(channelRef(), changes), old ? 'Команда изменена' : 'Команда добавлена');
  $('cmdSave').disabled = false;
  if (ok) resetCommandForm();
}

async function deleteCommand(name) {
  if (!confirm(`Удалить команду ${name}?`)) return;
  const ok = await save(() => update(channelRef(), { [`commands/${name}`]: null }), 'Команда удалена');
  if (ok && S.editingCmd === name) resetCommandForm();
}

// ---------- Действия: авто-сообщения ----------

function resetTimerForm() {
  S.editingTimer = null;
  $('timerText').value = '';
  $('timerFormTitle').textContent = 'Новое авто-сообщение';
  $('timerSave').textContent = 'Добавить сообщение';
  $('timerCancel').hidden = true;
  setError('timerError', '');
  updateCounter('timerText', 'timerCount');
  renderPreviews();
}

function editTimer(index, old) {
  S.editingTimer = { index, old };
  $('timerText').value = old;
  $('timerFormTitle').textContent = 'Изменить авто-сообщение';
  $('timerSave').textContent = 'Сохранить изменения';
  $('timerCancel').hidden = false;
  setError('timerError', '');
  updateCounter('timerText', 'timerCount');
  renderPreviews();
  renderTimers(S.channel);
  $('timerForm').scrollIntoView({ behavior: 'smooth', block: 'center' });
  $('timerText').focus();
}

async function timersTransaction(mutator) {
  const res = await runTransaction(ref(db, `channels/${S.active}/timers`), mutator);
  return res.committed;
}

async function onTimerSubmit(ev) {
  ev.preventDefault();
  const t = validateMessageText($('timerText').value);
  if (!t.ok) { setError('timerError', t.error); return; }
  const editing = S.editingTimer;
  if (!editing && S.channel.timers.length >= LIMITS.timersMax) {
    setError('timerError', `Достигнут максимум: ${LIMITS.timersMax} авто-сообщений. Удалите ненужное.`);
    return;
  }
  setError('timerError', '');
  $('timerSave').disabled = true;
  let committed = false;
  const ok = await save(async () => {
    committed = await timersTransaction(
      editing ? timersEdit(editing.index, editing.old, t.value) : timersAdd(t.value),
    );
  });
  $('timerSave').disabled = false;
  if (!ok) return;
  if (committed) {
    toast(editing ? 'Сообщение изменено' : 'Сообщение добавлено', 'ok');
    resetTimerForm();
  } else {
    toast('Список изменился (возможно, правка из чата) или достигнут лимит. Проверьте список и повторите.', 'err');
  }
}

async function deleteTimer(index, old) {
  if (!confirm('Удалить это авто-сообщение?')) return;
  let committed = false;
  const ok = await save(async () => { committed = await timersTransaction(timersRemove(index, old)); });
  if (!ok) return;
  if (committed) {
    toast('Сообщение удалено', 'ok');
    if (S.editingTimer) resetTimerForm();
  } else {
    toast('Список изменился. Проверьте его и повторите.', 'err');
  }
}

async function onTimerToggle() {
  const box = $('timerToggle');
  box.disabled = true;
  await save(() => update(channelRef(), { timerOff: !box.checked }), box.checked ? 'Авто-сообщения включены' : 'Авто-сообщения выключены');
  box.disabled = false;
}

async function onIntervalSubmit(ev) {
  ev.preventDefault();
  const raw = $('tInterval').value.trim();
  let value;
  if (raw === '') {
    value = null; // сброс до значения по умолчанию в боте
  } else {
    const r = validateInterval(raw);
    if (!r.ok) { setError('intervalError', r.error); return; }
    value = r.value;
  }
  setError('intervalError', '');
  $('tIntervalSave').disabled = true;
  const ok = await save(
    () => update(channelRef(), { timerInterval: value }),
    value === null ? 'Интервал сброшен до значения по умолчанию' : 'Интервал сохранён',
  );
  $('tIntervalSave').disabled = false;
  if (ok) S.dirtyInterval = false;
}

// ---------- Выход ----------

async function logout() {
  teardown();
  S = null;
  document.title = BASE_TITLE;
  try { await signOut(auth); } catch (e) { console.error(e); }
  $('userNick').textContent = '';
  await startSession(null);
}

// ---------- Подсказки ----------

function updateCounter(textId, counterId) {
  const len = $(textId).value.trim().length;
  const c = $(counterId);
  c.textContent = `${len}/${LIMITS.textMax}`;
  c.classList.toggle('over', len > LIMITS.textMax);
}

function fillBotName() {
  if (!config.botName) return;
  const name = String(config.botName).replace(/[^A-Za-z0-9_]/g, '');
  if (!name) return;
  for (const span of document.querySelectorAll('.botname')) {
    span.append(' (', el('a', { href: `https://www.twitch.tv/${name}`, target: '_blank', rel: 'noopener', text: name }), ')');
  }
}

// ---------- Запуск ----------

function bindUi() {
  $('googleBtn').addEventListener('click', startGoogleLogin);
  $('connectBtn').addEventListener('click', startLogin);
  $('unlinkBtn').addEventListener('click', unlinkTwitch);
  $('linkRetry').addEventListener('click', startLogin);
  $('errorRetry').addEventListener('click', () => location.reload());
  $('logoutBtn').addEventListener('click', logout);

  $('tabCabinet').addEventListener('click', () => setTab('cabinet'));
  $('tabAdmin').addEventListener('click', () => setTab('admin'));

  $('joinForm').addEventListener('submit', onJoinSubmit);
  $('modHintClose').addEventListener('click', () => { if (S) S.showModHint = false; renderModHint(); });

  $('enabledToggle').addEventListener('change', onEnabledChange);
  $('valorantForm').addEventListener('submit', onValorantSubmit);
  for (const id of ['vName', 'vTag', 'vRegion']) {
    $(id).addEventListener('input', () => { if (S) S.dirtyValorant = true; });
    $(id).addEventListener('change', () => { if (S) S.dirtyValorant = true; });
  }

  $('cmdForm').addEventListener('submit', onCommandSubmit);
  $('cmdCancel').addEventListener('click', resetCommandForm);
  $('cmdText').addEventListener('input', () => { updateCounter('cmdText', 'cmdCount'); renderPreviews(); });
  $('cmdName').addEventListener('input', renderPreviews);
  $('cmdTest').addEventListener('click', () => sendTest($('cmdText').value));
  $('timerTest').addEventListener('click', () => sendTest($('timerText').value));
  $('accForm').addEventListener('submit', onAccountAdd);
  $('gamesToggle').addEventListener('change', onGamesChange);
  $('modForm').addEventListener('submit', onModAdd);
  $('chanSelect').addEventListener('change', () => switchChannel($('chanSelect').value));

  $('timerToggle').addEventListener('change', onTimerToggle);
  $('intervalForm').addEventListener('submit', onIntervalSubmit);
  $('tInterval').addEventListener('input', () => { if (S) S.dirtyInterval = true; });
  $('timerForm').addEventListener('submit', onTimerSubmit);
  $('timerCancel').addEventListener('click', resetTimerForm);
  $('timerText').addEventListener('input', () => { updateCounter('timerText', 'timerCount'); renderPreviews(); });

  // админ-панель
  $('chanSearch').addEventListener('input', () => {
    if (!S?.admin) return;
    S.admin.filter = $('chanSearch').value;
    renderAdminChannels();
  });
  $('limitsForm').addEventListener('submit', onLimitsSubmit);
  for (const [id] of LIMIT_FIELDS) $(id).addEventListener('input', () => { if (S) S.dirtyLimits = true; });
  $('notifyBtn').addEventListener('click', onNotifyClick);

  updateCounter('cmdText', 'cmdCount');
  updateCounter('timerText', 'timerCount');
  fillBotName();
}

async function main() {
  bindUi();
  showView('loading');

  const problem = configProblem();
  if (problem) { showFatal(problem); return; }

  const ret = consumeTwitchReturn(); // сразу убирает токен из адресной строки

  try {
    const app = initializeApp(config.firebase);
    auth = getAuth(app);
    db = getDatabase(app);
  } catch (e) {
    console.error(e);
    showFatal('Не удалось запустить Firebase: проверьте значения в config.js.');
    return;
  }

  await startSession(ret.token);
  if (ret.message) toast(ret.message, 'err');
}

main();
