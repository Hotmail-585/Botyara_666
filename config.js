// ЕДИНСТВЕННЫЙ файл, который нужно отредактировать: впишите свои значения.
// Всё здесь публично (в браузере всё равно видно). Секретов здесь быть не должно.

export const config = {
  // Адрес API бота (HTTPS-домен вашего хостинга: bot-hosting.net → Domains). Без слеша в конце.
  apiUrl: 'https://c06poca4kr.apps.bot-hosting.cloud',

  // Twitch Developer Console → ваше приложение → Client ID
  twitchClientId: '1794963369664',

  // Канонический адрес сайта = OAuth Redirect URL в приложении Twitch.
  redirectUri: 'https://hotmail-585.github.io/Botyara_666/',

  // Twitch-ник бота (чат, где пишут !join). Пусто = в подсказках будет просто «в чате бота».
  botName: 'Botyara_666',

  // Сколько авто-сообщений бот использует по умолчанию (MAX_TIMERS в боте).
  // Если в списке больше, сайт покажет предупреждение. По схеме БД максимум 20.
  botTimersLimit: 20,

  // Сколько секунд ждать ответа бота после входа через Twitch.
  linkTimeoutSec: 15,
};
