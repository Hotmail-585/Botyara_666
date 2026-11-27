// Публичный профиль зрителя: данные отдаёт бот (/profile и /leaderboard), вход не нужен.
import { config } from './config.js';
import { initApi, apiBases } from './fb.js';
import './i18n.js';

const $ = (id) => document.getElementById(id);
function h(tag, props = {}, kids = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) { if (k === 'text') n.textContent = v; else if (k === 'class') n.className = v; else n.setAttribute(k, v); }
  for (const c of [].concat(kids)) if (c) n.append(c);
  return n;
}

initApi([config.apiUrl, ...(config.apiUrls || [])]);

// Запрос ко всем адресам бота по очереди (первый, который ответил, побеждает)
async function api(path) {
  let last = null;
  for (const base of apiBases()) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 7000);
    try {
      const res = await fetch(`${base}${path}`, { cache: 'no-store', signal: ctl.signal });
      const body = await res.json().catch(() => ({}));
      if (res.status === 404) return { error: 'notfound' };
      if (res.ok) return body;
      last = { error: `http_${res.status}` };
    } catch (e) { last = { error: e?.name === 'AbortError' ? 'timeout' : 'network' }; } finally { clearTimeout(timer); }
  }
  return last || { error: 'network' };
}

function msg(text) { const m = $('pfMsg'); m.textContent = text; m.hidden = !text; }
const nf = (n) => Number(n || 0).toLocaleString(document.documentElement.lang || 'ru');
const tile = (k, v) => h('div', { class: 'pf-tile' }, [h('small', { text: k }), h('b', { text: v })]);

function profileLink(c, u) { return `?c=${encodeURIComponent(c)}&u=${encodeURIComponent(u)}`; }

function renderProfile(p) {
  $('pfProfile').hidden = false;
  $('pfName').textContent = p.user;
  $('pfChanName').textContent = p.chan;
  $('pfAvatar').textContent = p.user.charAt(0).toUpperCase();
  document.title = `${p.user}: профиль`;
  const rk = $('pfRank');
  rk.hidden = !p.rank;
  if (p.rank) {
    $('pfRankName').textContent = p.rank.tier ? `${p.rank.tier}${p.rank.tid >= 3 ? ` · ${p.rank.rr} RR` : ''}` : 'ранг неизвестен';
    $('pfRankId').textContent = `${p.rank.name}#${p.rank.tag}`;
  }
  $('pfTiles').replaceChildren(
    tile('Очки', nf(p.points.balance)),
    tile('Место по очкам', p.points.place ? `#${p.points.place}` : '—'),
    tile('Серия !daily', `${p.points.daily || 0} дн.`),
    tile('Сообщений', nf(p.chat.msgs)),
    tile('Дней в чате', nf(p.chat.days)),
    tile('Серия дней', `${p.chat.streak} дн.`),
    tile('Лучшая серия', `${p.chat.best} дн.`),
  );
  const got = p.ach.filter((a) => a.at).length;
  $('pfAchCount').textContent = `${got} / ${p.ach.length}`;
  const sorted = [...p.ach].sort((a, b) => (b.at ? 1 : 0) - (a.at ? 1 : 0));
  $('pfAch').replaceChildren(...sorted.map((a) => h('div', { class: 'pf-a' + (a.at ? ' got' : ''), title: a.at ? new Date(a.at).toLocaleDateString(document.documentElement.lang || 'ru') : '' }, [
    h('span', { class: 'ico', text: a.ico }),
    h('div', {}, [h('b', { text: a.name }), h('span', { text: a.desc })]),
  ])));
}

function renderBoards(c, lb) {
  $('pfBoards').hidden = false;
  const fill = (id, rows, f) => {
    const ol = $(id);
    ol.replaceChildren(...(rows.length ? rows.map((r) => h('li', {}, [h('a', { href: profileLink(c, r.user), text: r.user, translate: 'no' }), h('em', { text: f(r), translate: 'no' })])) : [h('p', { class: 'muted', text: 'Пока пусто' })]));
  };
  fill('pfTopPts', lb.points, (r) => nf(r.balance));
  fill('pfTopRank', lb.ranks, (r) => `${r.tier}${r.tid >= 3 ? ` · ${r.rr} RR` : ''}`);
}

const ERRTXT = { notfound: 'Канал или зритель не найден. P404', network: 'Нет связи с ботом. P101', timeout: 'Бот не ответил вовремя. P102' };

async function load() {
  const q = new URLSearchParams(location.search);
  const c = (q.get('c') || '').trim().toLowerCase();
  const u = (q.get('u') || '').trim().toLowerCase();
  $('pfChan').value = c; $('pfUser').value = u;
  $('pfProfile').hidden = true; $('pfBoards').hidden = true; msg('');
  if (!c) { msg('Введите ник стримера и ник зрителя.'); return; }
  msg('Загрузка…');
  const [p, lb] = await Promise.all([u ? api(`/profile?c=${encodeURIComponent(c)}&u=${encodeURIComponent(u)}`) : null, api(`/leaderboard?c=${encodeURIComponent(c)}`)]);
  msg('');
  if (lb.error) { msg(ERRTXT[lb.error] || `Ошибка. ${lb.error}`); return; }
  if (p) { if (p.error) msg(ERRTXT[p.error] || `Ошибка. ${p.error}`); else renderProfile(p); }
  renderBoards(c, lb);
}

$('pfForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const c = $('pfChan').value.trim().toLowerCase(); const u = $('pfUser').value.trim().toLowerCase().replace(/^@/, '');
  history.pushState(null, '', profileLink(c, u).replace(/&u=$/, ''));
  load();
});
addEventListener('popstate', load);
$('themeBtn').addEventListener('click', () => {
  const cur = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', cur);
  try { localStorage.setItem('bot_theme', cur); } catch { /* */ }
});
load();
