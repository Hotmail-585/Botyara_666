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

// Встроенные команды бота: свои команды с такими именами бот, скорее всего, не вызовет.
export const RESERVED_COMMANDS = [
  '!rank', '!setrank', '!join', '!leave',
  '!ранг', '!peak', '!lastgame', '!today', '!сегодня', '!acc', '!addacc', '!delacc',
  '!8ball', '!dice', '!coin', '!duel', '!games',
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
    timers: timersToList(raw.timers),
    games: raw.games === true,
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

// Предпросмотр: так сообщение увидят в чате ({user} -> ник зрителя).
export function renderPreview(text, user = 'Зритель') {
  return String(text ?? '').replace(/\{user\}/gi, user);
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

export function makeState(randomBytes) {
  return Array.from(randomBytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
