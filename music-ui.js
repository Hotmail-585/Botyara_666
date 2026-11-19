// Вкладка «Музыка» кабинета. Подгружается при первом открытии вкладки (app.js). Данные идут через сервер бота (fb.js).
import { ref, get, set, push, update, remove, serverTimestamp, getPublicConfig } from './fb.js';

import { onValue as rawOnValue } from './fb.js';
const $ = (id) => document.getElementById('mu-' + id);
let offs = [], bound = false, timers = [];
const onValue = (r, cb, err) => { const off = rawOnValue(r, cb, err); offs.push(off); return off; };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const db = null;
const MUSIC_STATE_KEY = 'music_oauth_state';
let CLIENT_ID = '', YT_KEY = '', REDIRECT = '';
let clientIdReady = Promise.resolve();
let uid = null, nick = null, key = null, cfg = {}, queue = [], control = {}, plays = {}, bans = { users: {}, tracks: {} }, fb = {}, playlists = {}, status = null;
let started = null, pendingReturn = null, isOwner = true;

// Ответ Twitch после входа для музыки (?code=&state=). Вызывается из app.js до старта; чужой ответ не трогает.
export function consumeMusicReturn() {
  if (!/[?&](code|error)=/.test(location.search)) return null;
  const q = new URLSearchParams(location.search);
  let expected = null;
  try { expected = sessionStorage.getItem(MUSIC_STATE_KEY); } catch { /* */ }
  if (!expected || q.get('state') !== expected) return null;
  try { sessionStorage.removeItem(MUSIC_STATE_KEY); } catch { /* */ }
  history.replaceState(null, '', location.pathname + location.hash);
  if (q.get('error')) return { code: null, message: 'Twitch: ' + (q.get('error_description') || q.get('error')) };
  return { code: q.get('code'), message: null };
}

// Запуск вкладки один раз на сессию. opts: { uid, nick, redirect, ret }
export function initMusic(opts) {
  const id = opts.uid + ':' + opts.nick;
  if (started === id) return;
  if (started) { for (const f of offs) { try { f(); } catch { /* */ } } offs = []; for (const t of timers) clearInterval(t); timers = []; key = null; cfg = {}; queue = []; control = {}; plays = {}; bans = { users: {}, tracks: {} }; fb = {}; playlists = {}; status = null; $('gate').hidden = false; $('gate').textContent = 'Загрузка…'; $('app').hidden = true; }
  started = id;
  isOwner = opts.isOwner !== false;
  uid = opts.uid; nick = opts.nick; REDIRECT = opts.redirect; pendingReturn = opts.ret || null;
  clientIdReady = getPublicConfig().then((pub) => {
    if (typeof pub.twitchClientId === 'string' && /^[a-z0-9]{20,40}$/i.test(pub.twitchClientId)) CLIENT_ID = pub.twitchClientId;
    if (typeof pub.youtubeApiKey === 'string' && pub.youtubeApiKey.trim().length > 10) YT_KEY = pub.youtubeApiKey.trim();
  }).catch(() => {});
  const gate = $('gate');
  (async () => {
    try {
      await ensureKey();
      gate.hidden = true; $('app').hidden = false;
      startApp();
    } catch (e) { gate.textContent = 'Ошибка: ' + e.message; started = null; }
  })();
}

const rndKey = (n = 32) => { const a = new Uint8Array(n); crypto.getRandomValues(a); const c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'; return [...a].map((x) => c[x % c.length]).join(''); };
async function ensureKey() {
  const v = (await get(ref(db, `musicKeys/${nick}`))).val();
  if (typeof v === 'string') { key = v; return; }
  const k = rndKey();
  await update(ref(db), { [`musicKeyOwner/${k}`]: nick, [`musicKeys/${nick}`]: k });
  key = k;
}
const P = (sub) => ref(db, `musicPlayer/${key}/${sub}`);
const obsUrl = () => new URL('music-obs.html?k=' + key, REDIRECT || location.href).href;
const dockUrl = () => new URL('music-dock.html?k=' + key, REDIRECT || location.href).href;

// ───── вкладки ─────
const TABS = [['conn', 'Подключение'], ['queue', 'Очередь и управление'], ['set', 'Настройки'], ['pl', 'Плейлисты'], ['ban', 'Баны'], ['hist', 'История']];
$('tabs').innerHTML = TABS.map(([id, t]) => `<button data-t="${id}">${t}</button>`).join('');
function showTab(id) {
  document.querySelectorAll('#panel-music .mu-sec').forEach((s) => s.classList.toggle('on', s.id === 'mu-s-' + id));
  document.querySelectorAll('#mu-tabs button').forEach((b) => b.classList.toggle('on', b.dataset.t === id));
}


function startApp() {
  if (!bound) {
    bound = true;
    $('tabs').addEventListener('click', (e) => { if (e.target.dataset.t) showTab(e.target.dataset.t); });
  }
  showTab('conn');
  // Подключение Twitch (награды) делает только владелец канала: токен принадлежит его аккаунту
  $('tbtn').hidden = !isOwner;
  if (!isOwner) $('tmsg').textContent = 'Подключить или отключить бота может только владелец канала. Остальное управление доступно вам как модератору.';
  $('obsUrl').textContent = obsUrl(); $('dockUrl').textContent = dockUrl();
  document.querySelectorAll('[data-copy]').forEach((b) => (b.onclick = async () => { const t = $(b.dataset.copy).textContent; try { await navigator.clipboard.writeText(t); b.textContent = 'Скопировано'; setTimeout(() => (b.textContent = 'Копировать'), 1500); } catch (e) { prompt('Скопируйте ссылку:', t); } }));
  $('newKey').onclick = rotateKey;
  onValue(P('cfg'), (s) => { cfg = s.val() || {}; fillCfg(); });
  onValue(P('bans'), (s) => { const v = s.val() || {}; bans = { users: v.users || {}, tracks: v.tracks || {} }; renderBans(); });
  onValue(P('fb'), (s) => { fb = s.val() || {}; renderPlaylists(); });
  onValue(P('playlists'), (s) => { playlists = s.val() || {}; renderPlaylists(); });
  onValue(ref(db, `musicStatus/${nick}`), (s) => { status = s.val(); renderStatus(); });
  bindPlayer(); setupSettings(); setupPlaylists(); setupBans(); setupAuth();
}

async function rotateKey() {
  if (!confirm('Выдать новые ссылки? Старые в OBS перестанут работать, очередь и настройки плеера (баны, плейлисты, настройки наград) будут сброшены.')) return;
  try {
    const old = key, k = rndKey();
    await update(ref(db), { [`musicKeyOwner/${k}`]: nick, [`musicKeys/${nick}`]: k });
    await remove(ref(db, `musicPlayer/${old}`)).catch(() => {});
    await remove(ref(db, `musicKeyOwner/${old}`)).catch(() => {});
    location.reload();
  } catch (e) { alert('Не удалось: ' + e.message); }
}

// ───── подключение бота к наградам (код авторизации Twitch → бот) ─────
const AUTH_MSG = {
  ok: ['Готово: бот подключён и принимает заказы.', true], disconnected: ['Бот отключён от ваших наград.', true],
  noscope: ['Вы не дали нужное право. Подключите ещё раз и подтвердите доступ.', false], wronguser: ['Вы вошли в Twitch под другим аккаунтом, чем в кабинете.', false],
  denied: ['Twitch не принял код. Подключите ещё раз.', false], expired: ['Запрос устарел, подключите ещё раз.', false], busy: ['Бот сейчас занят, повторите через минуту.', false],
  noconfig: ['У бота не задан TWITCH_CLIENT_SECRET (спросите владельца бота).', false], notlinked: ['Twitch не привязан к кабинету.', false], nokey: ['Нет ключа плеера, обновите страницу.', false], error: ['Ошибка бота, попробуйте позже (запущен ли бот?).', false],
};
function setMsg(text, ok) { $('tmsg').className = 'mute ' + (ok ? 'ok' : 'err'); $('tmsg').textContent = text; }
function sendAuth(body) {
  return new Promise(async (resolve) => {
    const id = rndKey(16); let done = false;
    const off = onValue(ref(db, `musicAuthResults/${uid}`), (s) => { const v = s.val(); if (v && v.id === id && !done) { done = true; off(); clearTimeout(to); resolve(v.code); } });
    const to = setTimeout(() => { if (!done) { done = true; off(); resolve('timeout'); } }, 25000);
    try { await set(ref(db, `musicAuthRequests/${uid}`), { id, createdAt: serverTimestamp(), ...body }); }
    catch (e) { if (!done) { done = true; off(); clearTimeout(to); resolve('error'); } }
  });
}
function setupAuth() {
  $('tbtn').onclick = async () => {
    if (status && status.linked) {
      if (!confirm('Отключить бота от наград? Награды останутся на Twitch, но заказы приниматься не будут.')) return;
      setMsg('Отключаю…', true); const c = await sendAuth({ action: 'disconnect' }); const m = AUTH_MSG[c] || ['Бот не ответил (запущен ли бот?).', false]; setMsg(m[0], m[1]); return;
    }
    await clientIdReady;
    if (!CLIENT_ID || String(CLIENT_ID).includes('ВСТАВЬТЕ')) { setMsg('Client ID не найден: бот не передал его сайту. Проверьте TWITCH_CLIENT_ID в .env бота и перезапустите бота.', false); return; }
    const st = rndKey(16); try { sessionStorage.setItem(MUSIC_STATE_KEY, st); } catch { setMsg('Браузер не дал сохранить данные входа (приватный режим?).', false); return; }
    const q = new URLSearchParams({ client_id: CLIENT_ID, redirect_uri: REDIRECT, response_type: 'code', scope: 'channel:manage:redemptions', state: st, force_verify: 'true' });
    location.href = 'https://id.twitch.tv/oauth2/authorize?' + q;
  };
  if (pendingReturn) {
    const r = pendingReturn; pendingReturn = null; showTab('conn');
    if (r.message) setMsg(r.message, false);
    else if (!r.code) setMsg('Twitch не вернул код, подключите ещё раз.', false);
    else { setMsg('Подключаю бота…', true); sendAuth({ code: r.code, redirect: REDIRECT }).then((c) => { const m = AUTH_MSG[c] || ['Бот не ответил (запущен ли бот?).', false]; setMsg(m[0], m[1]); }); }
  }
}
const RW = { ok: 'работает', off: 'выключена', duplicate: 'награда с таким названием уже есть (создана не ботом): переименуйте', noaffiliate: 'нужен статус партнёра/компаньона Twitch', error: 'ошибка, повторите сохранение настроек' };
function renderStatus() {
  const linked = !!(status && status.linked);
  $('tdot').className = 'dot ' + (linked ? (status.ws === 'on' ? 'on' : 'wait') : '');
  $('tstat').textContent = linked ? (status.ws === 'on' ? 'бот принимает заказы' : 'бот подключается к Twitch…') : (status && status.error === 'revoked' ? 'доступ отозван, подключите заново' : 'не подключено');
  $('tbtn').textContent = linked ? 'Отключить' : 'Подключить Twitch';
  $('rstat').innerHTML = linked ? `Награда за трек: ${esc(RW[status.track] || 'настраивается…')}<br>Награда за плейлист: ${esc(RW[status.playlist] || 'настраивается…')}` : 'После подключения заполните «Настройки» → «Награды» и сохраните: бот создаст награды.';
}

// ───── плеер: очередь, управление, история, журнал ─────
const norm = (s) => String(s || '').trim().toLowerCase().replace(/^@/, '');
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const cmd = (a, d) => update(P('control'), { cmd: { a, n: Date.now(), ...(d !== undefined ? { d } : {}) } });
function bindPlayer() {
  onValue(P('queue'), (s) => { const v = s.val() || {}; queue = Object.entries(v).map(([k, x]) => ({ ...x, key: k })).sort((a, b) => a.ts - b.ts); renderQueue(); });
  onValue(P('control'), (s) => { control = s.val() || {}; $('vol').value = Number.isFinite(control.volume) ? control.volume : 50; $('bPause').textContent = control.paused ? '▶ Дальше' : '⏸ Пауза'; renderNow(); });
  onValue(P('state'), (s) => { plays = s.val() || {}; renderNow(); });
  onValue(P('history'), (s) => {
    const list = Object.values(s.val() || {}).sort((a, b) => b.ts - a.ts).slice(0, 50);
    const R = { played: 'сыграно', skipped: 'пропущено', error: 'ошибка' };
    $('hist').innerHTML = list.length ? list.map((h) => `<div class="item"><div class="t"><b>${esc(h.title)}</b><span class="mute">${esc(h.from || '')} · ${new Date(h.ts).toLocaleString()} · ${R[h.result] || ''}</span></div></div>`).join('') : 'пока пусто';
  });
  onValue(P('log'), (s) => {
    const list = Object.values(s.val() || {}).sort((a, b) => b.at - a.at).slice(0, 20);
    $('orders').innerHTML = list.length ? list.map((l) => `<div class="item"><div class="t"><b class="${l.result === 'added' ? 'ok' : 'err'}">${l.result === 'added' ? '✔' : '✖'} ${esc(l.user)}</b><span class="mute">${esc(l.text || '')} → ${esc(l.result === 'added' ? l.reason : 'отклонён: ' + l.reason)} · ${new Date(l.at).toLocaleTimeString()}</span></div></div>`).join('') : 'пока нет';
  });
  $('bPrev').onclick = () => cmd('prev'); $('bSkip').onclick = () => cmd('skip');
  $('bPlay').onclick = () => update(P('control'), { stopped: false, paused: false });
  $('bStop').onclick = () => update(P('control'), { stopped: true });
  $('bPause').onclick = () => update(P('control'), control.stopped ? { stopped: false, paused: false } : { paused: !control.paused });
  $('bBack10').onclick = () => cmd('seek', -10); $('bFwd10').onclick = () => cmd('seek', 10); $('bRestart').onclick = () => cmd('restart');
  $('vol').onchange = (e) => update(P('control'), { volume: Number(e.target.value) });
  $('manualAdd').onclick = addManual;
  $('queue').onclick = async (e) => {
    const d = e.target.dataset; const it = (k) => queue.find((i) => i.key === k);
    try {
      if (d.rm) await remove(P(`queue/${d.rm}`));
      else if (d.bt && it(d.bt) && confirm(`Забанить трек «${it(d.bt).title}»?`)) await banTrack(it(d.bt).id);
      else if (d.bu && it(d.bu) && confirm(`Забанить зрителя ${it(d.bu).from}?`)) await banUser(it(d.bu).from);
    } catch (err) { alert('Не удалось: ' + err.message); }
  };
  timers.push(setInterval(renderNow, 5000));
}
function renderNow() {
  const it = queue.find((i) => i.key === plays.id) || queue.find((i) => i.status === 'playing');
  const alive = plays.at && Date.now() - plays.at < 40000;
  $('now').innerHTML = (it ? `<b>${esc(it.title)}</b><br>заказал(а): ${esc(it.from)}${plays.dur ? ` · ${fmt(plays.pos)} / ${fmt(plays.dur)}` : ''}` : (control.stopped ? 'Остановлено' : 'Ничего не играет')) + (alive ? '' : '<br><span class="err">плеер в OBS не отвечает — открыта ли ссылка плеера?</span>');
  $('bPlay').style.display = control.stopped ? '' : 'none'; $('bStop').style.display = control.stopped ? 'none' : '';
}
function renderQueue() {
  $('queue').innerHTML = queue.length ? queue.map((i) => `<div class="item"><div class="t"><b>${esc(i.title)}${i.status === 'playing' ? '<span class="tag">играет</span>' : ''}</b><span class="mute">${esc(i.from)}${i.channel ? ' · ' + esc(i.channel) : ''}</span></div>` +
    `<button class="b g" title="Убрать" data-rm="${esc(i.key)}">✕</button><button class="b g" title="Забанить трек" data-bt="${esc(i.key)}">🚫</button>${String(i.from).startsWith('📂') ? '' : `<button class="b g" title="Забанить зрителя" data-bu="${esc(i.key)}">👤</button>`}</div>`).join('') : 'пусто';
  renderNow();
}

// ───── YouTube-хелперы ─────
const extractVideoId = (t) => { const m = String(t).match(/(?:v=|youtu\.be\/|embed\/|shorts\/)([A-Za-z0-9_-]{11})/); return m ? m[1] : (/^[A-Za-z0-9_-]{11}$/.test(String(t).trim()) ? String(t).trim() : null); };
const extractPlaylistId = (t) => { const m = String(t).match(/[?&]list=([A-Za-z0-9_-]+)/); return m ? m[1] : null; };
async function videoInfo(id) {
  try { const r = await fetch(`https://www.youtube.com/oembed?url=https://youtube.com/watch?v=${id}&format=json`); if (r.ok) { const d = await r.json(); return { title: d.title, channel: d.author_name }; } } catch (e) { /* */ }
  return null;
}
async function ytList(path) {
  const r = await fetch(`https://www.googleapis.com/youtube/v3/${path}&key=${YT_KEY}`);
  if (!r.ok) { let m = ''; try { const j = await r.json(); m = (j.error && j.error.message) || ''; } catch (e) { /* */ } throw new Error('YouTube API ' + r.status + (m ? ': ' + m.slice(0, 140) : '')); }
  return r.json();
}
async function playlistTracks(plId, max) {
  const out = []; let tok = '';
  do {
    const d = await ytList(`playlistItems?part=snippet&playlistId=${plId}&maxResults=50${tok ? '&pageToken=' + tok : ''}`);
    for (const it of d.items || []) {
      const id = it.snippet?.resourceId?.videoId, title = it.snippet?.title;
      if (id && title && title !== 'Deleted video' && title !== 'Private video') out.push({ id, title: title.slice(0, 200), channel: (it.snippet?.videoOwnerChannelTitle || '').slice(0, 100) });
      if (out.length >= max) break;
    }
    tok = d.nextPageToken || '';
  } while (tok && out.length < max);
  return out;
}
async function addManual() {
  const st = $('manualSt'); const id = extractVideoId($('manual').value);
  const say = (m, ok) => { st.className = 'mute ' + (ok ? 'ok' : 'err'); st.textContent = m; };
  if (!id) return say('Не похоже на ссылку YouTube');
  if (bans.tracks[id]) return say('Этот трек в бане');
  const info = (await videoInfo(id)) || { title: 'YouTube track', channel: '' };
  try { await push(P('queue'), { id, title: String(info.title).slice(0, 200), channel: String(info.channel || '').slice(0, 100), from: 'Стример', ts: Date.now(), status: 'approved', source: 'manual' }); $('manual').value = ''; say('Добавлено', true); } catch (e) { say(e.message); }
}

// ───── настройки ─────
const clampN = (v, lo, hi, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
function fillCfg() {
  const val = (id, v) => { const el = $(id); if (document.activeElement !== el) el.value = v; };
  const chk = (id, v) => { $(id).checked = v; };
  const has = Object.keys(cfg).length > 0;
  val('cfgTrack', has ? (cfg.trackReward || '') : 'Заказать песню'); val('cfgTrackCost', cfg.trackCost || 500);
  val('cfgPl', cfg.playlistReward || ''); val('cfgPlCost', cfg.playlistCost || 1000); val('cfgMaxPl', cfg.maxPlTracks || 10);
  val('cfgDur', cfg.maxDurationMin ?? 10); val('cfgMaxQ', cfg.maxQueue || 50); val('cfgMaxU', cfg.maxPerUser || 5);
  chk('cfgAge', cfg.blockAgeRestricted !== false); chk('cfgEmb', cfg.requireEmbeddable !== false); chk('cfgChat', cfg.chatReplies !== false);
}
function setupSettings() {
  $('cfgSave').onclick = async () => {
    try {
      await update(P('cfg'), {
        trackReward: $('cfgTrack').value.trim().slice(0, 45), trackCost: clampN($('cfgTrackCost').value, 1, 1000000, 500),
        playlistReward: $('cfgPl').value.trim().slice(0, 45), playlistCost: clampN($('cfgPlCost').value, 1, 1000000, 1000), maxPlTracks: clampN($('cfgMaxPl').value, 1, 50, 10),
        maxDurationMin: clampN($('cfgDur').value, 0, 600, 10), maxQueue: clampN($('cfgMaxQ').value, 1, 200, 50), maxPerUser: clampN($('cfgMaxU').value, 1, 50, 5),
        blockAgeRestricted: $('cfgAge').checked, requireEmbeddable: $('cfgEmb').checked, chatReplies: $('cfgChat').checked,
      });
      $('cfgSt').className = 'ok'; $('cfgSt').textContent = 'Сохранено. Бот обновит награды в течение пары секунд.';
    } catch (e) { $('cfgSt').className = 'err'; $('cfgSt').textContent = e.message; }
  };
  onValue(P('widget'), (s) => {
    const w = s.val() || {};
    $('wAcc').value = w.accent || '#3ddc84'; $('wBg').value = w.bg || '#131315'; $('wText').value = w.text || '#f3f3f4';
    $('wOp').value = w.opacity ?? 88; $('wNext').value = w.nextCount ?? 5; $('wFrom').checked = w.showFrom === true; $('wThumb').checked = w.showThumb === true; $('wHide').checked = w.hideWhenIdle === true;
  });
  $('wSave').onclick = async () => {
    try {
      await update(P('widget'), { accent: $('wAcc').value, bg: $('wBg').value, text: $('wText').value, opacity: clampN($('wOp').value, 0, 100, 88), nextCount: clampN($('wNext').value, 0, 10, 5), showFrom: $('wFrom').checked, showThumb: $('wThumb').checked, hideWhenIdle: $('wHide').checked });
      $('wSt').className = 'ok'; $('wSt').textContent = 'Сохранено';
    } catch (e) { $('wSt').className = 'err'; $('wSt').textContent = e.message; }
  };
}

// ───── плейлисты (играют сами, когда очередь пуста; запускает плеер в OBS) ─────
function setupPlaylists() {
  document.querySelectorAll('[data-mode]').forEach((b) => (b.onclick = () => update(P('fb'), { mode: b.dataset.mode })));
  $('plAdd').onclick = async () => {
  const st = $('plSt'); const id = extractPlaylistId($('plUrl').value);
  const say = (m, e) => { st.className = e ? 'err' : 'ok'; st.textContent = m; };
  await clientIdReady;
  if (!YT_KEY) return say('Ключ YouTube не получен от бота: проверьте YOUTUBE_API_KEY в .env бота и перезапустите бота.', true);
    if (!id) return say('Не похоже на ссылку плейлиста (нужен параметр list=)', true);
    $('plAdd').disabled = true; say('Загружаю…');
    try {
      const info = (await ytList(`playlists?part=snippet&id=${id}`)).items?.[0]?.snippet; if (!info) throw new Error('Плейлист не найден или закрыт');
      const tracks = await playlistTracks(id, 200); if (!tracks.length) throw new Error('В плейлисте нет доступных треков');
      await push(P('playlists'), { plId: id.slice(0, 60), title: info.title.slice(0, 200), thumb: (info.thumbnails?.default?.url || '').slice(0, 300), count: tracks.length, addedAt: Date.now(), tracks });
      $('plUrl').value = ''; say(`Добавлен: ${info.title} (${tracks.length})`);
    } catch (e) { say(e.message, true); }
    $('plAdd').disabled = false;
  };
  $('plList').onclick = async (e) => {
    const p = e.target.dataset.play, d = e.target.dataset.del;
    if (p) await update(P('fb'), { active: p, index: 0, mode: (fb.mode && fb.mode !== 'off') ? fb.mode : 'order' });
    if (d && confirm('Удалить плейлист?')) { await remove(P(`playlists/${d}`)); if (fb.active === d) await update(P('fb'), { active: '' }); }
  };
}
function renderPlaylists() {
  const mode = fb.mode || 'off';
  document.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
  const pls = Object.entries(playlists);
  $('plList').innerHTML = pls.length ? pls.map(([k, p]) => `<div class="item"><div class="t"><b>${esc(p.title)}${fb.active === k ? '<span class="tag">активный</span>' : ''}</b><span class="mute">${p.count} треков</span></div><button class="b g" data-play="${esc(k)}">Сделать активным</button><button class="b g" data-del="${esc(k)}">✕</button></div>`).join('') : '<div class="mute">плейлистов нет</div>';
}

// ───── баны ─────
const fresh = async () => Object.entries((await get(P('queue'))).val() || {}).map(([k, x]) => ({ ...x, key: k }));
async function banTrack(id) {
  await update(P('bans/tracks'), { [id]: true });
  for (const i of (await fresh()).filter((x) => x.id === id)) await remove(P(`queue/${i.key}`));
}
async function banUser(name) {
  const n = norm(name); if (!/^[a-z0-9_]{1,25}$/.test(n)) return;
  await update(P('bans/users'), { [n]: true });
  for (const i of (await fresh()).filter((x) => norm(x.from) === n)) await remove(P(`queue/${i.key}`));
}
function setupBans() {
  $('banUAdd').onclick = async () => { await banUser($('banU').value); $('banU').value = ''; };
  $('banTAdd').onclick = async () => { const id = extractVideoId($('banT').value); if (!id) return; await banTrack(id); $('banT').value = ''; };
  $('s-ban').onclick = async (e) => { const u = e.target.dataset.unu, t = e.target.dataset.unt; if (u) await remove(P(`bans/users/${u}`)); if (t) await remove(P(`bans/tracks/${t}`)); };
}
function renderBans() {
  const list = (obj, attr) => Object.keys(obj).map((k) => `<div class="item"><div class="t"><b>${esc(k)}</b></div><button class="b g" data-${attr}="${esc(k)}">Разбанить</button></div>`).join('') || '<div class="mute">пусто</div>';
  $('banUList').innerHTML = list(bans.users, 'unu'); $('banTList').innerHTML = list(bans.tracks, 'unt');
}
