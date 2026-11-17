// ЕДИНСТВЕННЫЙ файл, который нужно отредактировать: впишите свои значения вместо ВСТАВЬТЕ_...
// Всё здесь публично (в браузере всё равно видно). Секретов здесь быть не должно.
// Настоящие секреты (HenrikDev, токены Twitch, Telegram, Firebase Admin) живут только в .env бота.

export const config = {
  // Firebase Console → ⚙ Project settings → General → Your apps → Web app → SDK setup and configuration
firebase: {
    apiKey: 'AIzaSyAFjEqq9ZOVQnCGlBIQAKi6Ikl9ENGIvvc',
    authDomain: 'botyara-f4b18.firebaseapp.com',
    databaseURL: 'https://botyara-f4b18-default-rtdb.firebaseio.com',
    projectId: 'botyara-f4b18',
    appId: '1:123064665877:web:3e4592412ed36ad4260b1c',
  },

  // Канонический адрес сайта = OAuth Redirect URL в приложении Twitch.
  redirectUri: 'https://hotmail-585.github.io/Botyara_666/',

  // Twitch-ник бота (чат, где пишут !join). Пусто = в подсказках будет просто «в чате бота».
  botName: 'Botyara_666',

  // Сколько авто-сообщений бот использует по умолчанию (MAX_TIMERS в боте).
  // Если в списке больше, сайт покажет предупреждение. По схеме БД максимум 20.
  botTimersLimit: 20,

  // Сколько секунд ждать ответа бота после входа через Twitch.
  linkTimeoutSec: 15,

  // Twitch Client ID и ключ YouTube здесь не нужны: сайт получает их от бота (publicConfig в базе),
  // а бот берёт их из своего .env (TWITCH_CLIENT_ID, YOUTUBE_API_KEY).
};
