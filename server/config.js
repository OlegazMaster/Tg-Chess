import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* .env необязателен */ }

const env = process.env;

export const config = {
  botToken: env.BOT_TOKEN || '',
  // Публичный адрес Mini App по HTTPS, например https://chess.example.com
  webAppUrl: (env.WEBAPP_URL || 'http://localhost:8090').replace(/\/+$/, ''),
  host: env.HOST || '127.0.0.1',
  port: parseInt(env.PORT || '8090', 10),
  dbPath: env.DB_PATH || path.join(ROOT, 'data', 'chess.db'),
  // Адрес Bot API (можно указать свой прокси или локальный Bot API сервер)
  telegramApi: (env.TELEGRAM_API || 'https://api.telegram.org').replace(/\/+$/, ''),
  // Режим разработки: вход без Telegram (только для проверки в обычном браузере!)
  devMode: env.DEV_MODE === '1',
  // Username бота без @ и короткое имя Mini App из BotFather (/newapp).
  // Нужны для ссылок-вызовов, если сервер не может связаться с Bot API.
  botUsername: (env.BOT_USERNAME || '').replace(/^@/, ''),
  appName: env.APP_NAME || '',
  startRating: 1200,
};

if (!config.botToken && !config.devMode) {
  console.error('Не задан BOT_TOKEN. Укажите его в файле .env (см. .env.example).');
  process.exit(1);
}
