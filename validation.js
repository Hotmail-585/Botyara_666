// Чистая логика без браузера и Firebase: проверки полей (зеркало database.rules.json),
// работа со списком авто-сообщений, разбор ответа Twitch и данные админ-панели. Тестируется в Node.

export const LIMITS = {
  nameMin: 3,
  nameMax: 16,
  tagPattern: /^[A-Za-z0-9]{3,5}$/,
  regions: ['eu', 'na', 'ap', 'kr'],
  cmdMax: 20,          // символов после "!"
  textMax: 400,
  timersMax: 20,       // по схеме (ключи 0..19)
  intervalMin: 1,
  intervalMax: 1440,
};

// Встроенные команды бота: свои команды и алиасы с такими именами создать нельзя.
export const RESERVED_COMMANDS = [
  '!rank', '!setrank', '!join', '!leave',
  '!ранг', '!peak', '!lastgame', '!today', '!сегодня', '!acc', '!addacc', '!delacc',
  '!8ball', '!dice', '!coin', '!duel', '!games',
  '!rps', '!love', '!agent', '!map', '!roulette',
  '!points', '!очки', '!top', '!daily', '!give', '!gift', '!shop', '!buy', '!accept', '!принять', '!pts',
  '!команды', '!commands', '!status', '!help', '!list',
  '!addcom', '!editcom', '!delcom', '!addtimer', '!deltimer', '!timer', '!timers',
  '!pred', '!permit', '!filters',
];
export const MAX_ACCOUNTS = 5;   // основной + до 4 дополнительных

const ok = (value) => ({ ok: true, value });
const fail = (error) => ({ ok: false, error });

export function validateValorantName(input) {
  const v = String(input ?? '').trim();
  if (v.length < LIMITS.nameMin || v.length > LIMITS.nameMax) {
    return fail(`Ник Valorant: от ${LIMITS.nameMin} до ${LIMITS.nameMax} символов.`);
  }
  return ok(v);
}

export function validateTag(input) {
  const v = String(input ?? '').trim().replace(/^#/, '');
  if (!LIMITS.tagPattern.test(v)) {
    return fail('Тег: от 3 до 5 латинских букв или цифр (без #), например 1234.');
  }
  return ok(v);
}

export function validateRegion(input) {
  const v = String(input ?? '').trim().toLowerCase();
  if (!LIMITS.regions.includes(v)) return fail('Выберите регион: eu, na, ap или kr.');
  return ok(v);
}

// Символы, запрещённые в ключах Firebase: . $ # [ ] / и управляющие.
const BAD_KEY_CHARS = /[.$#\[\]\/\u0000-\u001f\u007f]/;

export function validateCommandName(input) {
  let v = String(input ?? '').trim().toLowerCase();
  if (v === '') return fail('Введите название команды, например !discord');
  if (!v.startsWith('!')) v = '!' + v;
  const body = v.slice(1);
  if (body.length < 1 || body.length > LIMITS.cmdMax) {
    return fail(`Название команды: ! и от 1 до ${LIMITS.cmdMax} символов.`);
  }
  if (/\s/.test(body)) return fail('В названии команды не должно быть пробелов.');
  if (BAD_KEY_CHARS.test(v)) {
    return fail('В названии команды нельзя использовать . $ # [ ] / и служебные символы.');
  }
  if (RESERVED_COMMANDS.includes(v)) {
    return fail(`${v} — встроенная команда бота, выберите другое название.`);
  }
  return ok(v);
}

// Текст команды и авто-сообщения: 1..400 символов, не начинается с / или . (даже после пробелов).
export function validateMessageText(input) {
  // В чате Twitch нет переносов строк: заменяем их пробелом.
  const v = String(input ?? '').replace(/\s*[\r\n]+\s*/g, ' ').trim();
  if (v.length < 1) return fail('Текст не может быть пустым.');
  if (v.length > LIMITS.textMax) {
    return fail(`Текст слишком длинный: ${v.length} из ${LIMITS.textMax} символов.`);
  }
  if (/^\s*[\/.]/.test(v)) {
    return fail('Текст не должен начинаться с «/» или «.» — Twitch воспримет это как команду.');
  }
  return ok(v);
}

export function validateInterval(input) {
  const raw = String(input ?? '').trim();
  if (!/^\d+$/.test(raw)) {
    return fail(`Интервал: целое число минут от ${LIMITS.intervalMin} до ${LIMITS.intervalMax}.`);
  }
  const n = Number(raw);
  if (n < LIMITS.intervalMin || n > LIMITS.intervalMax) {
    return fail(`Интервал: от ${LIMITS.intervalMin} до ${LIMITS.intervalMax} минут.`);
  }
  return ok(n);
}

// ---------- Права, кулдаун и алиасы своих команд ----------

export const PERM_LEVELS = [
  ['all', 'Все зрители'],
  ['sub', 'Подписчики и выше'],
  ['vip', 'VIP и выше'],
  ['mod', 'Только модераторы'],
];
export const PERM_SHORT = { all: 'все', sub: 'подписчики+', vip: 'VIP+', mod: 'модераторы' };
export const CMD_CD = { min: 0, max: 3600, def: 5 };   // кулдаун на канал, секунд
export const ALIASES_MAX = 30;                          // алиасов на весь канал
export const ALIASES_PER_CMD = 5;
const CMD_KEY = /^![^ ]{1,20}$/;

export function validateCmdOptions(permInput, cdInput) {
  const perm = String(permInput ?? 'all').trim().toLowerCase() || 'all';
  if (!PERM_LEVELS.some(([k]) => k === perm)) return fail('Выберите, кто может вызывать команду.');
  const raw = String(cdInput ?? '').trim();
  let cd = CMD_CD.def;
  if (raw !== '') {
    if (!/^\d+$/.test(raw) || Number(raw) > CMD_CD.max) {
      return fail(`Кулдаун: целое число секунд от ${CMD_CD.min} до ${CMD_CD.max} (пусто = ${CMD_CD.def}).`);
    }
    cd = Number(raw);
  }
  return ok({ perm, cd });
}

// Строка "!ds, !дс" -> список названий. self — название самой команды (алиас не может совпадать с ним).
export function parseAliasList(input, self = '') {
  const parts = String(input ?? '').split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (const p of parts) {
    const r = validateCommandName(p);
    if (!r.ok) return fail(`Алиас «${p}»: ${r.error}`);
    if (r.value === self) return fail('Алиас не может совпадать с названием самой команды.');
    if (!out.includes(r.value)) out.push(r.value);
  }
  if (out.length > ALIASES_PER_CMD) return fail(`Не больше ${ALIASES_PER_CMD} алиасов на одну команду.`);
  return ok(out);
}

function cmdOptsOf(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw)) {
    if (!CMD_KEY.test(k) || !v || typeof v !== 'object') continue;
    out[k] = {
      perm: PERM_LEVELS.some(([p]) => p === v.perm) ? v.perm : 'all',
      cd: Number.isInteger(v.cd) && v.cd >= CMD_CD.min && v.cd <= CMD_CD.max ? v.cd : CMD_CD.def,
    };
  }
  return out;
}

function aliasesOf(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw)) {
    if (CMD_KEY.test(k) && typeof v === 'string' && CMD_KEY.test(v)) out[k] = v;
  }
  return out;
}

// ---------- Авто-сообщения ----------

// Из значения узла timers (массив, объект с ключами или null) получаем плотный массив строк
// в порядке числовых ключей. Дыры и пустые значения пропускаются.
export function timersToList(raw) {
  if (raw == null) return [];
  const entries = Array.isArray(raw)
    ? raw.map((v, i) => [i, v])
    : Object.entries(raw).map(([k, v]) => [Number(k), v]);
  return entries
    .filter(([k, v]) => Number.isInteger(k) && typeof v === 'string' && v !== '')
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => v);
}

// Список -> объект {"0": "...", "1": "..."} или null (пустой список = удалить узел).
export function listToTimers(list) {
  if (!list.length) return null;
  const obj = {};
  list.forEach((text, i) => { obj[String(i)] = text; });
  return obj;
}

// Мутаторы для runTransaction: получают текущее значение узла timers и возвращают новое.
// undefined = отменить транзакцию (список изменился или упёрлись в лимит).
export function timersAdd(text) {
  return (current) => {
    const list = timersToList(current);
    if (list.length >= LIMITS.timersMax) return undefined;
    return listToTimers([...list, text]);
  };
}

export function timersEdit(index, oldText, newText) {
  return (current) => {
    const list = timersToList(current);
    if (list[index] !== oldText) return undefined;
    list[index] = newText;
    return listToTimers(list);
  };
}

export function timersRemove(index, oldText) {
  return (current) => {
    const list = timersToList(current);
    if (list[index] !== oldText) return undefined;
    list.splice(index, 1);
    return listToTimers(list);
  };
}

// ---------- Фильтры чата ----------

export const FILTER_KINDS = ['links', 'caps', 'repeat', 'emotes', 'words'];
export const FILTER_NAMES = {
  links: 'Ссылки',
  caps: 'Капс',
  repeat: 'Повторы',
  emotes: 'Спам эмоутами',
  words: 'Запрещённые слова',
};
export const FILTER_SEC = { min: 1, max: 86400, def: 10 };   // длительность таймаута
export const FILTER_PARAMS = {
  caps: {
    minLen: { min: 5, max: 200, def: 15, label: 'Минимум букв в сообщении' },
    percent: { min: 50, max: 100, def: 70, label: 'Доля заглавных букв, %' },
  },
  repeat: { times: { min: 2, max: 10, def: 3, label: 'Одинаковых сообщений подряд' } },
  emotes: { max: { min: 3, max: 50, def: 10, label: 'Максимум эмоутов в сообщении' } },
};
export const FILTER_TEXT_MAX = { allow: 300, list: 1500 };

const intIn = (v, spec) => (Number.isInteger(v) && v >= spec.min && v <= spec.max ? v : spec.def);

// Настройки фильтров из узла channels/{ник}/filters (нет поля = значение по умолчанию, как у бота).
export function filtersSettings(raw) {
  const f = raw && typeof raw === 'object' ? raw : {};
  const out = { on: f.on === true };
  for (const kind of FILTER_KINDS) {
    const x = f[kind] && typeof f[kind] === 'object' ? f[kind] : {};
    const o = { on: x.on === true, action: x.action === 'timeout' ? 'timeout' : 'delete', sec: intIn(x.sec, FILTER_SEC) };
    for (const [k, spec] of Object.entries(FILTER_PARAMS[kind] || {})) o[k] = intIn(x[k], spec);
    if (kind === 'links') o.allow = typeof x.allow === 'string' ? x.allow : '';
    if (kind === 'words') o.list = typeof x.list === 'string' ? x.list : '';
    out[kind] = o;
  }
  return out;
}

// "twitch.tv, https://www.youtube.com/x" -> "twitch.tv,youtube.com"
export function parseDomainList(input) {
  const parts = String(input ?? '')
    .split(/[\s,;]+/)
    .map((s) => s.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[\/?#].*$/, ''))
    .filter(Boolean);
  const out = [];
  for (const p of parts) {
    if (p.length > 60 || !/^[\p{L}\p{N}-]+(\.[\p{L}\p{N}-]+)+$/u.test(p)) {
      return fail(`Сайт «${p}»: укажите домен, например twitch.tv.`);
    }
    if (!out.includes(p)) out.push(p);
  }
  if (out.length > 20) return fail('Не больше 20 разрешённых сайтов.');
  const joined = out.join(',');
  if (joined.length > FILTER_TEXT_MAX.allow) return fail(`Список сайтов слишком длинный (максимум ${FILTER_TEXT_MAX.allow} символов).`);
  return ok(joined);
}

// Слова и фразы через запятую или с новой строки -> "слово,фраза".
export function parseWordList(input) {
  const parts = String(input ?? '')
    .split(/[,;\n]+/)
    .map((s) => s.replace(/\s+/g, ' ').trim().toLowerCase())
    .filter(Boolean);
  const out = [];
  for (const p of parts) {
    if (p.length < 2 || p.length > 40) return fail(`Слово «${p}»: от 2 до 40 символов.`);
    if (!out.includes(p)) out.push(p);
  }
  if (out.length > 50) return fail('Не больше 50 слов и фраз.');
  const joined = out.join(',');
  if (joined.length > FILTER_TEXT_MAX.list) return fail(`Список слишком длинный (максимум ${FILTER_TEXT_MAX.list} символов).`);
  return ok(joined);
}

// form: { links: {action, sec, allow}, caps: {action, sec, minLen, percent}, repeat: {..., times},
//         emotes: {..., max}, words: {..., list} } (всё строки).
// Результат: плоский объект {"links/action": "...", ...} для update() внутри channels/{ник}/filters.
export function validateFilterSettings(form) {
  const out = {};
  for (const kind of FILTER_KINDS) {
    const f = (form && form[kind]) || {};
    const name = FILTER_NAMES[kind];
    out[`${kind}/action`] = f.action === 'timeout' ? 'timeout' : 'delete';

    const secRaw = String(f.sec ?? '').trim();
    if (!/^\d+$/.test(secRaw) || Number(secRaw) < FILTER_SEC.min || Number(secRaw) > FILTER_SEC.max) {
      return fail(`${name}: длительность таймаута — целое число секунд от ${FILTER_SEC.min} до ${FILTER_SEC.max}.`);
    }
    out[`${kind}/sec`] = Number(secRaw);

    for (const [k, spec] of Object.entries(FILTER_PARAMS[kind] || {})) {
      const raw = String(f[k] ?? '').trim();
      if (!/^\d+$/.test(raw) || Number(raw) < spec.min || Number(raw) > spec.max) {
        return fail(`${name}, «${spec.label}»: целое число от ${spec.min} до ${spec.max}.`);
      }
      out[`${kind}/${k}`] = Number(raw);
    }

    if (kind === 'links') {
      const r = parseDomainList(f.allow);
      if (!r.ok) return r;
      out['links/allow'] = r.value === '' ? null : r.value;
    }
    if (kind === 'words') {
      const r = parseWordList(f.list);
      if (!r.ok) return r;
      out['words/list'] = r.value === '' ? null : r.value;
    }
  }
  return ok(out);
}

// ---------- Данные канала ----------

// Приводим узел channels/{ник} к удобному виду для интерфейса.
export function normalizeChannel(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const commands = raw.commands && typeof raw.commands === 'object' ? raw.commands : {};
  return {
    name: typeof raw.name === 'string' ? raw.name : '',
    tag: typeof raw.tag === 'string' ? raw.tag : '',
    region: LIMITS.regions.includes(raw.region) ? raw.region : 'eu',
    enabled: raw.enabled !== false,       // нет поля = включён
    timerOff: raw.timerOff === true,
    timerInterval: Number.isInteger(raw.timerInterval) ? raw.timerInterval : null, // null = по умолчанию у бота
    commands: Object.entries(commands)
      .filter(([, v]) => typeof v === 'string')
      .sort(([a], [b]) => a.localeCompare(b, 'ru')),
    cmdOpts: cmdOptsOf(raw.cmdOpts),      // название -> { perm, cd }
    aliases: aliasesOf(raw.aliases),      // алиас -> название команды
    timers: timersToList(raw.timers),
    games: raw.games === true,
    roulette: raw.roulette === true,
    points: pointsSettings(raw.points),
    shop: shopToList(raw.shop),
    filters: filtersSettings(raw.filters),
    accounts: accountsToList(raw.accounts),
    activeAccount: Number.isInteger(raw.activeAccount) && raw.activeAccount >= 1 && raw.activeAccount <= MAX_ACCOUNTS ? raw.activeAccount : 1,
  };
}

// ---------- Аккаунты Valorant, модераторы, предпросмотр ----------

// Дополнительные аккаунты: массив или объект с ключами 0..3 -> плотный список {name, tag, region}.
export function accountsToList(raw) {
  if (raw == null || typeof raw !== 'object') return [];
  const entries = Array.isArray(raw) ? raw.map((v, i) => [i, v]) : Object.entries(raw).map(([k, v]) => [Number(k), v]);
  return entries
    .filter(([k, v]) => Number.isInteger(k) && v && typeof v.name === 'string' && typeof v.tag === 'string')
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => ({ name: v.name, tag: v.tag, region: LIMITS.regions.includes(v.region) ? v.region : 'eu' }))
    .slice(0, MAX_ACCOUNTS - 1);
}

// Список -> объект {"0": {...}} или null (пустой список = удалить узел).
export function listToAccounts(list) {
  if (!list.length) return null;
  const obj = {};
  list.forEach((a, i) => { obj[String(i)] = { name: a.name, tag: a.tag, region: a.region }; });
  return obj;
}

// Ник модератора Twitch: без @, строчными, 3..25 символов a-z 0-9 _.
export function validateModLogin(input) {
  const v = String(input ?? '').trim().replace(/^@/, '').toLowerCase();
  if (!/^[a-z0-9_]{3,25}$/.test(v)) return fail('Ник Twitch: от 3 до 25 символов a-z, 0-9 и _.');
  return ok(v);
}

// Предпросмотр: так сообщение увидят в чате. Список переменных такой же, как в bot.js (renderTemplate).
// vars = false: ничего не подставлять (авто-сообщения отправляются как есть).
export function renderPreview(text, user = 'Зритель', vars = true) {
  const src = String(text ?? '');
  if (!vars) return src;
  return src.replace(/\{(user|touser|args|count|channel|random)(?:[ :]+(\d{1,9})\s*-\s*(\d{1,9}))?\}/gi, (m, name, a, b) => {
    switch (name.toLowerCase()) {
      case 'user': return user;
      case 'touser': return 'Друг';
      case 'args': return 'текст';
      case 'count': return '42';
      case 'channel': return 'ваш_канал';
      case 'random': {
        if (a === undefined) return m;
        const lo = Math.min(Number(a), Number(b));
        const hi = Math.max(Number(a), Number(b));
        return String(Math.floor((lo + hi) / 2));
      }
      default: return m;
    }
  });
}

// ---------- Админ-панель ----------

// Границы лимитов (те же числа в database.rules.json и в bot.js).
export const ADMIN_LIMITS = {
  maxChannels: { min: 1, max: 1000, label: 'Максимум каналов' },
  maxCommands: { min: 1, max: 200, label: 'Максимум команд на канал' },
  maxTimers: { min: 1, max: 20, label: 'Максимум авто-сообщений на канал' },
  inactiveDays: { min: 0, max: 365, label: 'Отключать после N дней тишины (0 = не отключать)' },
};

// Пустое поле = "значение по умолчанию из настроек бота" (value: null, ключ из базы удаляется).
export function validateAdminLimit(key, input) {
  const spec = ADMIN_LIMITS[key];
  if (!spec) return fail('Неизвестная настройка.');
  const raw = String(input ?? '').trim();
  if (raw === '') return ok(null);
  if (!/^\d+$/.test(raw)) return fail(`${spec.label}: целое число от ${spec.min} до ${spec.max}.`);
  const n = Number(raw);
  if (n < spec.min || n > spec.max) return fail(`${spec.label}: от ${spec.min} до ${spec.max}.`);
  return ok(n);
}

// "3 мин назад", "5 ч назад" и т. д. diffMs = сколько миллисекунд прошло.
export function formatAgo(diffMs) {
  if (!Number.isFinite(diffMs)) return '—';
  const s = Math.floor(diffMs / 1000);
  if (s < 45) return 'только что';
  const m = Math.floor(s / 60);
  if (m < 60) return `${Math.max(m, 1)} мин назад`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} ч назад`;
  return `${Math.floor(h / 24)} дн. назад`;
}

// Длительность: "2 д 3 ч", "5 ч 12 мин", "7 мин", "20 с".
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d} д ${h} ч`;
  if (h) return `${h} ч ${m} мин`;
  if (m) return `${m} мин`;
  return `${s} с`;
}

// Оповещения из admin/status: массив или объект с ключами, новые первыми.
export function alertsOf(status) {
  const raw = status && status.alerts;
  if (!raw || typeof raw !== 'object') return [];
  return Object.values(raw)
    .filter((a) => a && typeof a.text === 'string')
    .map((a) => ({
      at: Number.isFinite(a.at) ? a.at : 0,
      kind: String(a.kind || ''),
      level: ['info', 'warn', 'error'].includes(a.level) ? a.level : 'warn',
      text: a.text,
    }))
    .sort((a, b) => b.at - a.at);
}

// Бот считается онлайн, если сигнал (heartbeat) приходил не позже, чем 3 интервала назад.
export function botOnline(status, serverNowMs) {
  if (!status || !Number.isFinite(status.heartbeatAt)) return false;
  const sec = Number.isFinite(status.heartbeatSec) && status.heartbeatSec > 0 ? status.heartbeatSec : 60;
  return serverNowMs - status.heartbeatAt <= 3 * sec * 1000;
}

// Список каналов для админ-панели: канал + статистика + блокировка + итоговый статус.
// status: 'blocked' | 'auto-off' (отключён из-за неактивности) | 'off' (выключен) | 'active'
export function buildAdminRows(channelsRaw, statsRaw, blockedRaw) {
  const channels = channelsRaw && typeof channelsRaw === 'object' ? channelsRaw : {};
  const stats = statsRaw && typeof statsRaw === 'object' ? statsRaw : {};
  const blocked = blockedRaw && typeof blockedRaw === 'object' ? blockedRaw : {};
  const int = (v) => (Number.isFinite(v) && v >= 0 ? v : 0);

  const rows = [];
  for (const [nick, raw] of Object.entries(channels)) {
    const ch = normalizeChannel(raw);
    if (!ch) continue;
    const s = stats[nick] && typeof stats[nick] === 'object' ? stats[nick] : {};
    const b = blocked[nick] ? (typeof blocked[nick] === 'object' ? blocked[nick] : {}) : null;
    const stat = {
      since: int(s.since),
      lastMessageAt: int(s.lastMessageAt),
      messages: int(s.messages),
      rank: int(s.rank),
      cmd: int(s.cmd),
      autoDisabledAt: int(s.autoDisabledAt),
    };
    let status = 'active';
    if (b) status = 'blocked';
    else if (!ch.enabled) status = stat.autoDisabledAt ? 'auto-off' : 'off';
    rows.push({
      nick,
      name: ch.name,
      tag: ch.tag,
      region: ch.region,
      enabled: ch.enabled,
      commands: ch.commands.length,
      timers: ch.timers.length,
      stat,
      blocked: b ? { reason: typeof b.reason === 'string' ? b.reason : '', at: int(b.at) } : null,
      status,
      lastActivity: Math.max(stat.lastMessageAt, stat.since),
    });
  }
  return rows.sort((a, b) => a.nick.localeCompare(b.nick));
}

// ---------- Twitch ----------

// Токен Twitch: правила БД принимают 20-64 символа латиница/цифры.
export const TOKEN_PATTERN = /^[A-Za-z0-9]{20,64}$/;

export function parseTwitchHash(hash) {
  const params = new URLSearchParams(String(hash || '').replace(/^#/, ''));
  return {
    accessToken: params.get('access_token'),
    state: params.get('state'),
    error: params.get('error'),
    errorDescription: params.get('error_description'),
  };
}

export function buildTwitchAuthUrl({ clientId, redirectUri, state }) {
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'token',
    state,
  });
  return `https://id.twitch.tv/oauth2/authorize?${q.toString()}`;
}

// Предсказания Twitch: право и обмен одноразового кода (authorization code flow, секрет знает только бот).
export const PRED_SCOPE = 'channel:manage:predictions';
export const PRED_CODE_PATTERN = /^[A-Za-z0-9]{10,60}$/;

export function parseTwitchQuery(search) {
  const params = new URLSearchParams(String(search || '').replace(/^\?/, ''));
  return {
    code: params.get('code'),
    state: params.get('state'),
    scope: params.get('scope'),
    error: params.get('error'),
    errorDescription: params.get('error_description'),
  };
}

export function buildTwitchCodeUrl({ clientId, redirectUri, state }) {
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: PRED_SCOPE,
    state,
    force_verify: 'true',
  });
  return `https://id.twitch.tv/oauth2/authorize?${q.toString()}`;
}

export function makeState(randomBytes) {
  return Array.from(randomBytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------- Очки и магазин ----------

export const PTS_LIMITS = {
  perChat: { min: 1, max: 1000, def: 10, label: 'Очков за активность' },
  everyMin: { min: 1, max: 120, def: 5, label: 'Как часто начислять, минут' },
  daily: { min: 0, max: 100000, def: 100, label: 'Ежедневный бонус (0 = выключен)' },
  maxBet: { min: 1, max: 100000, def: 500, label: 'Максимальная ставка' },
};
export const SHOP_MAX = 10;
export const SHOP_NAME_MAX = 30;
export const SHOP_COST_MAX = 1000000;

// Настройки очков из узла channels/{ник}/points (нет поля = значение по умолчанию, как у бота).
export function pointsSettings(raw) {
  const p = raw && typeof raw === 'object' ? raw : {};
  const out = { on: p.on === true };
  for (const [k, spec] of Object.entries(PTS_LIMITS)) {
    out[k] = Number.isInteger(p[k]) && p[k] >= spec.min && p[k] <= spec.max ? p[k] : spec.def;
  }
  return out;
}

// Поля формы настроек очков -> числа. inputs: { perChat, everyMin, daily, maxBet } (строки).
export function validatePointsSettings(inputs) {
  const out = {};
  for (const [k, spec] of Object.entries(PTS_LIMITS)) {
    const raw = String(inputs?.[k] ?? '').trim();
    if (!/^\d+$/.test(raw)) return fail(`${spec.label}: целое число от ${spec.min} до ${spec.max}.`);
    const n = Number(raw);
    if (n < spec.min || n > spec.max) return fail(`${spec.label}: от ${spec.min} до ${spec.max}.`);
    out[k] = n;
  }
  return ok(out);
}

// Магазин: массив или объект с ключами 0..9 -> плотный список {name, cost}.
export function shopToList(raw) {
  if (raw == null || typeof raw !== 'object') return [];
  const entries = Array.isArray(raw) ? raw.map((v, i) => [i, v]) : Object.entries(raw).map(([k, v]) => [Number(k), v]);
  return entries
    .filter(([k, v]) => Number.isInteger(k) && v && typeof v.name === 'string' && v.name && Number.isInteger(v.cost) && v.cost >= 1)
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => ({ name: v.name, cost: v.cost }))
    .slice(0, SHOP_MAX);
}

export function listToShop(list) {
  if (!list.length) return null;
  const obj = {};
  list.forEach((it, i) => { obj[String(i)] = { name: it.name, cost: it.cost }; });
  return obj;
}

export function validateShopItem(nameInput, costInput) {
  const name = String(nameInput ?? '').replace(/\s+/g, ' ').trim();
  if (name.length < 1 || name.length > SHOP_NAME_MAX) return fail(`Название награды: от 1 до ${SHOP_NAME_MAX} символов.`);
  const raw = String(costInput ?? '').trim();
  if (!/^\d+$/.test(raw)) return fail(`Цена: целое число от 1 до ${SHOP_COST_MAX}.`);
  const cost = Number(raw);
  if (cost < 1 || cost > SHOP_COST_MAX) return fail(`Цена: от 1 до ${SHOP_COST_MAX}.`);
  return ok({ name, cost });
}

// Мутаторы для runTransaction (как у авто-сообщений): undefined = отменить.
const sameItem = (a, b) => a && b && a.name === b.name && a.cost === b.cost;
export function shopAdd(item) {
  return (current) => {
    const list = shopToList(current);
    if (list.length >= SHOP_MAX) return undefined;
    return listToShop([...list, item]);
  };
}
export function shopEdit(index, old, item) {
  return (current) => {
    const list = shopToList(current);
    if (!sameItem(list[index], old)) return undefined;
    list[index] = item;
    return listToShop(list);
  };
}
export function shopRemove(index, old) {
  return (current) => {
    const list = shopToList(current);
    if (!sameItem(list[index], old)) return undefined;
    list.splice(index, 1);
    return listToShop(list);
  };
}

// Таблица лидеров из узла points/{ник}: { total: сколько зрителей с очками, top: [{ nick, b }] }.
export function topOf(raw, n = 10) {
  const rows = raw && typeof raw === 'object'
    ? Object.entries(raw).filter(([, u]) => u && Number.isFinite(u.b) && u.b > 0).map(([nick, u]) => ({ nick, b: Math.floor(u.b) }))
    : [];
  rows.sort((a, b) => b.b - a.b || a.nick.localeCompare(b.nick));
  return { total: rows.length, top: rows.slice(0, n) };
}

// Заказы из магазина: purchases/{ник} -> список, новые первыми.
export function purchasesOf(raw) {
  if (!raw || typeof raw !== 'object') return [];
  return Object.entries(raw)
    .filter(([, p]) => p && typeof p.user === 'string' && typeof p.item === 'string')
    .map(([id, p]) => ({ id, user: p.user, item: p.item, cost: Number.isFinite(p.cost) ? p.cost : 0, at: Number.isFinite(p.at) ? p.at : 0 }))
    .sort((a, b) => b.at - a.at);
}

// ---------- Статистика чата ----------
// users: { ник: число сообщений }. Возвращает самых активных: [{ nick, n }], по убыванию, при равенстве по нику.
export function topChatters(users, limit = 10) {
  if (!users || typeof users !== 'object') return { total: 0, top: [] };
  const rows = Object.entries(users)
    .filter(([k, n]) => typeof k === 'string' && Number.isInteger(n) && n > 0)
    .map(([nick, n]) => ({ nick, n }))
    .sort((a, b) => b.n - a.n || (a.nick < b.nick ? -1 : a.nick > b.nick ? 1 : 0));
  return { total: rows.length, top: rows.slice(0, limit) };
}

const pad2 = (n) => String(n).padStart(2, '0');

// hours: { 'h<номер часа от 1970>': сообщений }. mode: '24h' (24 часа по часам) или '14d' (14 суток по дням).
// tzMin: смещение часового пояса зрителя в минутах от UTC (по умолчанию как у браузера).
// Возвращает { bars: [{ label, title, value }], sum, peak: { title, value } | null }.
export function activitySeries(hours, nowMs, mode = '24h', tzMin = -new Date().getTimezoneOffset()) {
  const HOUR = 3600 * 1000;
  const src = hours && typeof hours === 'object' ? hours : {};
  const localParts = (ms) => { const d = new Date(ms + tzMin * 60000); return d; };
  const get = (idx) => { const n = src[`h${idx}`]; return Number.isInteger(n) && n > 0 ? n : 0; };
  const curHour = Math.floor(nowMs / HOUR);
  const bars = [];
  if (mode === '24h') {
    for (let i = 23; i >= 0; i--) {
      const idx = curHour - i;
      const d = localParts(idx * HOUR);
      const hh = pad2(d.getUTCHours());
      bars.push({ label: hh, title: `${pad2(d.getUTCDate())}.${pad2(d.getUTCMonth() + 1)} ${hh}:00`, value: get(idx) });
    }
  } else {
    const dayKey = (ms) => { const d = localParts(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); };
    const todayKey = dayKey(nowMs);
    const byDay = new Map();
    for (let idx = curHour - 14 * 24 - 24; idx <= curHour; idx++) {
      const n = get(idx);
      if (!n) continue;
      const k = dayKey(idx * HOUR);
      byDay.set(k, (byDay.get(k) || 0) + n);
    }
    for (let i = 13; i >= 0; i--) {
      const k = todayKey - i * 86400000;
      const d = new Date(k);
      const lab = `${pad2(d.getUTCDate())}.${pad2(d.getUTCMonth() + 1)}`;
      bars.push({ label: lab, title: lab, value: byDay.get(k) || 0 });
    }
  }
  const sum = bars.reduce((a, b) => a + b.value, 0);
  let peak = null;
  for (const b of bars) if (b.value > 0 && (!peak || b.value > peak.value)) peak = { title: b.title, value: b.value };
  return { bars, sum, peak };
}
