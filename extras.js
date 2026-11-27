// Кабинет: опросы зрителей и итоги стримов. Данные пишет бот (pollVotes/*, summaries/*), заявки на опрос идут через pollReq/*.
import { ref, onValue, set } from './fb.js';

const $ = (id) => document.getElementById(id);
function h(tag, props = {}, kids = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'text') n.textContent = v;
    else if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const c of [].concat(kids)) if (c) n.append(c);
  return n;
}

let ctx = () => ({ nick: null, isOwn: false });
let toast = () => {};
let subPoll = null;
let subSum = null;
let pollFor = null;
let sumFor = null;
let poll = null;
let sums = null;
let tick = 0;

export function initCabinetExtras(opts) {
  ctx = opts.ctx; toast = opts.toast;
  $('pollAddOpt').addEventListener('click', addOpt);
  $('pollStart').addEventListener('click', startPoll);
  $('pollStop').addEventListener('click', stopPoll);
  const box = $('pollOpts');
  box.append(optRow(), optRow());
}

export function resetExtras() {
  try { subPoll?.(); } catch { /* */ }
  try { subSum?.(); } catch { /* */ }
  subPoll = subSum = null; pollFor = sumFor = null; poll = sums = null;
  clearInterval(tick); tick = 0;
}

// ---------- Опросы ----------
function optRow() {
  return h('input', { type: 'text', class: 'pollopt', maxlength: '40', placeholder: 'Вариант ответа', 'aria-label': 'Вариант ответа' });
}
function addOpt() {
  const box = $('pollOpts');
  if (box.children.length >= 5) return;
  box.append(optRow());
  $('pollAddOpt').hidden = box.children.length >= 5;
}

async function sendReq(payload) {
  const { nick } = ctx();
  if (!nick) return false;
  try {
    await set(ref(null, `pollReq/${nick}`), { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, createdAt: Date.now(), ...payload });
    return true;
  } catch (e) { console.error(e); toast('Не удалось отправить. P901', 'err'); return false; }
}

async function startPoll() {
  const q = $('pollQ').value.trim();
  const opts = [...document.querySelectorAll('#pollOpts .pollopt')].map((i) => i.value.trim()).filter(Boolean);
  const sec = Number($('pollSec').value) || 120;
  if (!q || opts.length < 2) { toast('Нужен вопрос и минимум два варианта', 'err'); return; }
  $('pollStart').disabled = true;
  if (await sendReq({ action: 'start', q, opts, sec })) toast('Опрос запускается, бот напишет его в чат', 'ok');
  setTimeout(() => { $('pollStart').disabled = false; }, 4000);
}
async function stopPoll() { if (await sendReq({ action: 'end' })) toast('Опрос завершается', 'ok'); }

export function showPolls() {
  const { nick, isOwn } = ctx();
  $('pollForm').hidden = !isOwn;
  $('pollOwnerNote').hidden = isOwn;
  if (!nick || pollFor === nick) { renderPoll(); return; }
  try { subPoll?.(); } catch { /* */ }
  pollFor = nick; poll = undefined;
  subPoll = onValue(ref(null, `pollVotes/${nick}`), (snap) => { if (pollFor !== nick) return; poll = snap.val() || null; renderPoll(); }, (e) => { console.error(e); poll = null; renderPoll(); });
  clearInterval(tick);
  tick = setInterval(renderPoll, 1000);
}

function renderPoll() {
  const card = $('pollLive');
  if (!poll) { card.hidden = true; $('pollStop').hidden = true; return; }
  card.hidden = false;
  const left = Math.max(0, Math.round((poll.endsAt - Date.now()) / 1000));
  const open = !poll.closed && left > 0;
  $('pollLiveQ').textContent = poll.q;
  $('pollLiveState').textContent = open ? `идёт: ещё ${left} с` : 'завершён';
  $('pollLiveState').className = 'pill ' + (open ? 'on' : 'off');
  $('pollStop').hidden = !open || !ctx().isOwn;
  const total = poll.counts.reduce((a, b) => a + b, 0);
  const max = Math.max(1, ...poll.counts);
  const list = $('pollBars');
  list.replaceChildren(...poll.opts.map((o, i) => {
    const n = poll.counts[i] || 0;
    const fill = h('span', { class: 'bar-fill' });
    fill.style.width = `${Math.round((n / max) * 100)}%`;
    return h('li', { class: 'bar' + (n === max && total ? ' lead' : '') }, [
      h('span', { class: 'bar-k', text: `!${i + 1}` }),
      h('span', { class: 'bar-main' }, [h('span', { class: 'bar-name', text: o }), h('span', { class: 'bar-track' }, [fill])]),
      h('span', { class: 'bar-v', text: `${n}${total ? ` · ${Math.round((n / total) * 100)}%` : ''}` }),
    ]);
  }));
  $('pollTotal').textContent = `Всего голосов: ${total}`;
}

// ---------- Итоги стримов ----------
export function showSummaries() {
  const { nick } = ctx();
  if (!nick || sumFor === nick) { renderSums(); return; }
  try { subSum?.(); } catch { /* */ }
  sumFor = nick; sums = undefined;
  subSum = onValue(ref(null, `summaries/${nick}`), (snap) => { if (sumFor !== nick) return; const v = snap.val() || {}; sums = Object.entries(v).filter(([, s]) => s && typeof s === 'object' && Number.isFinite(s.start)).map(([k, s]) => ({ ...s, key: k })).sort((a, b) => b.start - a.start); renderSums(); }, (e) => { console.error(e); sums = null; renderSums(); });
}

const fmtDur = (ms) => { const m = Math.round(ms / 60000); return m >= 60 ? `${Math.floor(m / 60)} ч ${m % 60} мин` : `${m} мин`; };
const fmtDate = (ts) => new Date(ts).toLocaleDateString(document.documentElement.lang || 'ru', { day: 'numeric', month: 'long', year: 'numeric' });
const rankText = (r) => (r ? `${r.from.name} → ${r.to.name}${r.delta ? `, ${r.delta > 0 ? '+' : ''}${r.delta} RR` : ''}` : '');

export function chatText(s) {
  const parts = [`Итоги стрима: ${s.wins} поб. / ${s.losses} пораж.`];
  if (s.d > 0 || s.k > 0) parts.push(`K/D ${s.kd}`);
  if (s.rank) parts.push(`ранг: ${rankText(s.rank)}`);
  if (s.peak) parts.push(`пик зрителей ${s.peak}`);
  if (s.top) parts.push(`самый активный: ${s.top.user}`);
  return parts.join(' · ').slice(0, 480);
}

function tile(k, v, cls = '') { return h('div', { class: 'sumtile' }, [h('small', { text: k }), h('b', { class: cls, text: String(v) })]); }

function sumCard(s) {
  const head = h('div', { class: 'sc-head' }, [
    h('div', {}, [h('small', { class: 'sc-t', text: 'Итоги стрима' }), h('h3', { text: s.acct || 'Стрим', translate: 'no' })]),
    h('div', { class: 'sc-date' }, [h('span', { text: fmtDate(s.start) }), h('span', { text: `${fmtDur(s.dur)} в эфире` })]),
  ]);
  const hasGames = s.wins + s.losses + s.draws > 0;
  const tiles = h('div', { class: 'sc-tiles' }, [
    ...(hasGames ? [tile('Победы', s.wins, 'w'), tile('Поражения', s.losses, 'l'), tile('K/D за стрим', s.kd)] : []),
    tile('Зрителей (пик)', s.peak || 0),
  ]);
  const info = [];
  if (s.rank) info.push(h('div', { class: 'sc-row' }, [h('small', { text: 'Ранг' }), h('b', { text: rankText(s.rank), translate: 'no' })]));
  if (s.agent) info.push(h('div', { class: 'sc-row' }, [h('small', { text: 'Лучший агент' }), h('b', { text: `${s.agent.name} · ${s.agent.n}`, translate: 'no' })]));
  if (s.best) info.push(h('div', { class: 'sc-row' }, [h('small', { text: 'Лучший матч' }), h('b', { text: `${s.best.k} убийств${s.best.map ? ' · ' + s.best.map : ''}`, translate: 'no' })]));
  if (s.top) info.push(h('div', { class: 'sc-row' }, [h('small', { text: 'Самый активный' }), h('b', { text: `${s.top.user} · ${s.top.msgs}`, translate: 'no' })]));
  const seq = h('div', { class: 'sc-seq' }, [...(s.seq || '')].map((c) => h('span', { class: 'm ' + (c === 'W' ? 'w' : c === 'L' ? 'l' : 'd'), text: c })));
  const btns = h('div', { class: 'row' }, [
    h('button', { class: 'btn', type: 'button', text: 'Скачать картинку', onclick: () => downloadCard(s) }),
    h('button', { class: 'btn', type: 'button', text: 'Скопировать для чата', onclick: async (e) => { try { await navigator.clipboard.writeText(chatText(s)); e.target.textContent = 'Скопировано'; setTimeout(() => { e.target.textContent = 'Скопировать для чата'; }, 1500); } catch { prompt('Скопируйте текст:', chatText(s)); } } }),
  ]);
  return h('div', { class: 'card sumcard' }, [head, tiles, ...info, seq, btns]);
}

function renderSums() {
  const box = $('sumList');
  const empty = $('sumEmpty');
  if (!box) return;
  if (sums === undefined) { box.replaceChildren(); empty.hidden = false; empty.textContent = 'Загрузка…'; return; }
  if (!sums || !sums.length) { box.replaceChildren(); empty.hidden = false; empty.textContent = sums === null ? 'Не удалось загрузить итоги. S901' : 'Итогов пока нет. Карточка появится через несколько минут после конца стрима.'; return; }
  empty.hidden = true;
  box.replaceChildren(...sums.map(sumCard));
}

// Картинка карточки (PNG) рисуется на холсте
function downloadCard(s) {
  const W = 760; const S2 = 2;
  const rows = [s.rank, s.agent, s.best, s.top].filter(Boolean).length;
  const H = 250 + rows * 38 + 110;
  const cv = document.createElement('canvas');
  cv.width = W * S2; cv.height = H * S2;
  const c = cv.getContext('2d');
  c.scale(S2, S2);
  const font = (px, w = 400) => { c.font = `${w} ${px}px Inter, system-ui, sans-serif`; };
  c.fillStyle = '#09090b'; c.fillRect(0, 0, W, H);
  const g = c.createLinearGradient(0, 0, W, H); g.addColorStop(0, 'rgba(255,45,58,.22)'); g.addColorStop(.6, 'rgba(255,45,58,0)');
  c.fillStyle = g; c.fillRect(0, 0, W, H);
  c.strokeStyle = '#3a1a1e'; c.lineWidth = 2; c.strokeRect(1, 1, W - 2, H - 2);
  c.fillStyle = '#9a9aa3'; font(13, 600); c.fillText('ИТОГИ СТРИМА', 32, 44);
  c.fillStyle = '#f3f3f5'; font(28, 800); c.fillText(s.acct || 'Стрим', 32, 78);
  c.textAlign = 'right'; c.fillStyle = '#9a9aa3'; font(14); c.fillText(fmtDate(s.start), W - 32, 44); c.fillText(`${fmtDur(s.dur)} в эфире`, W - 32, 66); c.textAlign = 'left';
  const hasGames = s.wins + s.losses + s.draws > 0;
  const tl = [...(hasGames ? [['ПОБЕДЫ', s.wins, '#3ddc97'], ['ПОРАЖЕНИЯ', s.losses, '#ff5a64'], ['K/D ЗА СТРИМ', s.kd, '#f3f3f5']] : []), ['ЗРИТЕЛЕЙ (ПИК)', s.peak || 0, '#f3f3f5']];
  const tw = (W - 64 - (tl.length - 1) * 12) / tl.length;
  tl.forEach(([k, v, col], i) => {
    const x = 32 + i * (tw + 12);
    c.fillStyle = '#0c0c0f'; c.fillRect(x, 106, tw, 82); c.strokeStyle = '#2a2a30'; c.lineWidth = 1; c.strokeRect(x + .5, 106.5, tw - 1, 81);
    c.fillStyle = '#9a9aa3'; font(11, 600); c.fillText(k, x + 14, 130);
    c.fillStyle = col; font(32, 800); c.fillText(String(v), x + 14, 170);
  });
  let y = 212;
  const items = [];
  if (s.rank) items.push(['РАНГ', rankText(s.rank)]);
  if (s.agent) items.push(['ЛУЧШИЙ АГЕНТ', `${s.agent.name} · ${s.agent.n}`]);
  if (s.best) items.push(['ЛУЧШИЙ МАТЧ', `${s.best.k} убийств${s.best.map ? ' · ' + s.best.map : ''}`]);
  if (s.top) items.push(['САМЫЙ АКТИВНЫЙ', `${s.top.user} · ${s.top.msgs} сообщ.`]);
  for (const [k, v] of items) {
    c.fillStyle = '#9a9aa3'; font(11, 600); c.fillText(k, 32, y + 14);
    c.fillStyle = '#f3f3f5'; font(16, 700); c.fillText(v, 190, y + 15);
    y += 38;
  }
  [...(s.seq || '')].forEach((ch, i) => {
    const x = 32 + i * 34; const col = ch === 'W' ? '#3ddc97' : ch === 'L' ? '#ff5a64' : '#9a9aa3';
    c.fillStyle = col + '26'; c.fillRect(x, y + 8, 28, 28); c.strokeStyle = col; c.strokeRect(x + .5, y + 8.5, 27, 27);
    c.fillStyle = col; font(12, 800); c.textAlign = 'center'; c.fillText(ch, x + 14, y + 27); c.textAlign = 'left';
  });
  c.fillStyle = '#6c6c75'; font(12); c.fillText('Кабинет бота', 32, H - 22);
  cv.toBlob((b) => { const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = `stream-${new Date(s.start).toISOString().slice(0, 10)}.png`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); });
}
