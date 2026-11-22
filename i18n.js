// Локализация сайта (русский, украинский, английский) без правки разметки.
// Исходный язык интерфейса русский: тексты на странице и в коде остаются русскими, а при выборе другого языка
// этот модуль подменяет их по словарю (lang/uk.js, lang/en.js), когда они попадают на страницу.
// Словарь: ключ = русский текст, значение = перевод. В ключах {0}, {1} стоят на месте подставляемых значений.
// Смена языка перезагружает страницу: так проще и надёжнее, чем перерисовывать всё на лету.

export const LANGS = [['ru', 'RU', 'Русский'], ['uk', 'UA', 'Українська'], ['en', 'EN', 'English']];
const KEY = 'bot_lang';
const LOCALES = { ru: 'ru-RU', uk: 'uk-UA', en: 'en-GB' };
const ATTRS = ['placeholder', 'title', 'aria-label', 'alt'];
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'INPUT', 'CODE-SKIP', 'SVG', 'NOSCRIPT']);
const INLINE = new Set(['CODE', 'B', 'STRONG', 'EM', 'I', 'A', 'SMALL', 'KBD', 'BR', 'SPAN', 'U']);
const CYR = /[А-Яа-яЁёІіЇїЄєҐґ]/;
const PH = /\{(\d+)\}/g;

let dict = null;
let patterns = [];
let lang = 'ru';

const norm = (s) => String(s).replace(/\s+/g, ' ').trim();

function detect() {
  try { const v = localStorage.getItem(KEY); if (LANGS.some((l) => l[0] === v)) return v; } catch { /* */ }
  const nav = String((typeof navigator !== 'undefined' && (navigator.languages && navigator.languages[0] || navigator.language)) || 'ru').toLowerCase();
  if (nav.startsWith('uk')) return 'uk';
  if (nav.startsWith('ru') || nav.startsWith('be')) return 'ru';
  return /^[a-z]{2}/.test(nav) ? 'en' : 'ru';
}

export const getLang = () => lang;
export const locale = () => LOCALES[lang] || 'ru-RU';

export function setLang(l, reload = true) {
  if (!LANGS.some((x) => x[0] === l)) return;
  try { localStorage.setItem(KEY, l); } catch { /* */ }
  if (reload) location.reload();
}

function compile(d) {
  patterns = [];
  for (const [k, v] of Object.entries(d)) {
    if (!PH.test(k)) { PH.lastIndex = 0; continue; }
    PH.lastIndex = 0;
    const order = [];
    let re = '';
    let last = 0;
    let m;
    while ((m = PH.exec(k))) {
      re += k.slice(last, m.index).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      re += '([^]{1,200}?)';
      order.push(Number(m[1]));
      last = m.index + m[0].length;
    }
    re += k.slice(last).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    PH.lastIndex = 0;
    const lit = k.replace(PH, '').replace(/\s+/g, '').length;
    if (lit < 4 || /^\{\d+\}/.test(k) && /\{\d+\}$/.test(k)) continue;   // слишком «жадные» шаблоны не нужны
    patterns.push({ re: new RegExp('^' + re + '$', 's'), order, out: v, len: k.length });
  }
  patterns.sort((a, b) => b.len - a.len);   // сначала самые длинные (точные) шаблоны
}

// Перевод строки: точное совпадение, затем шаблон с подстановками, затем «Начало: значение».
export function tr(s, depth = 0) {
  if (!dict || typeof s !== 'string' || !CYR.test(s)) return s;
  const n = norm(s);
  if (Object.prototype.hasOwnProperty.call(dict, n)) return dict[n];
  if (depth < 2) {
    for (const p of patterns) {
      const m = p.re.exec(n);
      if (!m) continue;
      const vals = {};
      p.order.forEach((idx, i) => { vals[idx] = tr(m[i + 1], depth + 1); });
      return p.out.replace(PH, (_, i) => (i in vals ? vals[i] : ''));
    }
    const dm = /^(\d{1,2}) (января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря) (\d{4})$/.exec(n);
    if (dm) {
      const i = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'].indexOf(dm[2]);
      const M = lang === 'uk' ? ['січня', 'лютого', 'березня', 'квітня', 'травня', 'червня', 'липня', 'серпня', 'вересня', 'жовтня', 'листопада', 'грудня']
        : ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
      return lang === 'uk' ? `${dm[1]} ${M[i]} ${dm[3]}` : `${M[i]} ${dm[1]}, ${dm[3]}`;
    }
    if (n.includes(' · ')) { const parts = n.split(' · '); const o = parts.map((x) => tr(x, depth + 1)); if (o.some((x, i) => x !== parts[i])) return o.join(' · '); }
    const lead = /^([✓•✗×–—-]\s+)(.+)$/s.exec(n);
    if (lead) { const o = tr(lead[2], depth + 1); if (o !== lead[2]) return lead[1] + o; }
    const c = n.indexOf(': ');
    if (c > 3 && c < n.length - 2) {
      const head = n.slice(0, c + 1);
      if (Object.prototype.hasOwnProperty.call(dict, head)) return dict[head] + ' ' + tr(n.slice(c + 2), depth + 1);
    }
  }
  return s;
}

// Подстановка в переведённую строку: t('Привет, {0}', name)
export function t(s, ...args) {
  let out = tr(s);
  if (args.length) out = out.replace(PH, (_, i) => (args[Number(i)] ?? ''));
  return out;
}

// Единица перевода: элемент с текстом и безобидными встроенными тегами (<code>, <b>…) переводится целиком, чтобы порядок слов был правильным.
function isUnit(el) {
  if (!el.children.length) return false;
  let ownText = false;
  for (const c of el.childNodes) if (c.nodeType === 3 && CYR.test(c.data)) ownText = true;
  if (!ownText) return false;
  const bad = (n) => {
    for (const c of n.children) {
      if (!INLINE.has(c.tagName) || c.id || c.classList.contains('botname') || c.hasAttribute('data-i18n-skip')) return true;
      if (bad(c)) return true;
    }
    return false;
  };
  return !bad(el);
}

const skipEl = (el) => SKIP_TAGS.has(el.tagName.toUpperCase()) || el.hasAttribute('data-i18n-skip') || el.getAttribute('translate') === 'no';

let collector = null;   // при сборе словаря сюда складываются найденные ключи
function look(s) { if (collector && CYR.test(s)) collector.add(norm(s)); }

function walk(node) {
  if (node.nodeType === 3) {
    if (CYR.test(node.data)) {
      look(node.data);
      if (dict) {
        const out = tr(node.data);
        if (out !== node.data) node.data = node.data.match(/^\s*/)[0] + out + node.data.match(/\s*$/)[0];
      }
    }
    return;
  }
  if (node.nodeType !== 1 || node.hasAttribute('data-i18n-skip') || node.getAttribute('translate') === 'no') return;
  for (const a of ATTRS) {
    const v = node.getAttribute(a);
    if (v && CYR.test(v)) {
      look(v);
      if (dict) { const o = tr(v); if (o !== v) node.setAttribute(a, o); }
    }
  }
  if (node.tagName === 'INPUT' && /^(button|submit)$/i.test(node.type) && CYR.test(node.value)) { look(node.value); if (dict) node.value = tr(node.value); }
  if (SKIP_TAGS.has(node.tagName.toUpperCase())) return;
  if (isUnit(node)) {
    const key = norm(node.innerHTML);
    look(key);
    if (dict && Object.prototype.hasOwnProperty.call(dict, key)) { node.innerHTML = dict[key]; return; }
  }
  for (const c of [...node.childNodes]) walk(c);
}

let mo = null;
function observe() {
  mo.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
}
function apply(fn) { mo.disconnect(); try { fn(); } finally { observe(); } }

function startObserver() {
  mo = new MutationObserver((records) => {
    apply(() => {
      for (const r of records) {
        if (r.type === 'childList') {
          for (const n of r.addedNodes) {
            if (n.nodeType === 1 || n.nodeType === 3) {
              // если добавили текст внутрь «единицы» (например, подпись названия бота), переводим целиком родителя
              walk(n);
            }
          }
        } else if (r.type === 'characterData') {
          if (r.target.parentElement && skipEl(r.target.parentElement)) continue;
          walk(r.target);
        } else if (r.type === 'attributes' && r.target.nodeType === 1) {
          const v = r.target.getAttribute(r.attributeName);
          if (v && CYR.test(v)) { const o = tr(v); if (o !== v) r.target.setAttribute(r.attributeName, o); }
        }
      }
    });
  });
  observe();
}

// Родные диалоги браузера тоже переводим.
function patchDialogs() {
  for (const name of ['alert', 'confirm', 'prompt']) {
    const orig = window[name].bind(window);
    window[name] = (msg, ...rest) => orig(tr(String(msg ?? '')), ...rest);
  }
}

export function collectKeys(root = document.body) {
  collector = new Set();
  const keep = dict; dict = null;
  walk(root);
  dict = keep;
  const out = [...collector];
  collector = null;
  return out;
}

function translateAll() {
  apply(() => {
    walk(document.body);
    if (CYR.test(document.title)) document.title = tr(document.title);
  });
}

function reveal() { document.documentElement.style.visibility = ''; }

async function init() {
  lang = detect();
  document.documentElement.lang = lang;
  if (lang !== 'ru') {
    try {
      const mod = await import(`./lang/${lang}.js`);
      dict = mod.default || {};
      compile(dict);
    } catch (e) {
      console.error('i18n: не удалось загрузить словарь', e);
      dict = null; lang = 'ru'; document.documentElement.lang = 'ru';
    }
  }
  const go = () => {
    if (dict) { patchDialogs(); startObserver(); translateAll(); }
    reveal();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go, { once: true }); else go();
}

await init();
