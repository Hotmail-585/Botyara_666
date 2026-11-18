// Здесь нужен только адрес бота. Client ID Twitch, ник бота и ключ YouTube сайт получает у самого бота
// (адрес /public-config), поэтому дублировать их тут не нужно. Секретов здесь быть не должно.

export const config = {
  // Адрес API бота (HTTPS-домен хостинга: bot-hosting.net → Domains). Без слеша в конце.
  apiUrl: 'https://c06poca4kr.apps.bot-hosting.cloud',

  // Канонический адрес сайта = OAuth Redirect URL в приложении Twitch.
  redirectUri: 'https://hotmail-585.github.io/Botyara_666/',

  // Необязательно: запасные значения на случай, если бот недоступен. Обычно оставьте пустыми.
  twitchClientId: '',
  botName: '',

  // Сколько авто-сообщений бот использует по умолчанию (MAX_TIMERS в боте).
  botTimersLimit: 20,

  // Сколько секунд ждать ответа бота после входа через Twitch.
  linkTimeoutSec: 15,
};
