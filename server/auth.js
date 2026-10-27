import crypto from 'node:crypto';
import { config } from './config.js';

const MAX_AGE_SEC = 7 * 24 * 3600;

// Проверка подписи initData от Telegram:
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
export function validateInitData(initData) {
  if (typeof initData !== 'string' || !initData || initData.length > 4096) return null;

  if (config.devMode && initData.startsWith('dev:')) {
    const [, id, ...name] = initData.split(':');
    const uid = parseInt(id, 10);
    if (!uid) return null;
    let n = name.join(':');
    try { n = decodeURIComponent(n); } catch { /* оставляем как есть */ }
    return { id: uid, first_name: n || 'Тестер ' + uid, username: '', photo_url: '' };
  }

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const dataCheck = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(config.botToken).digest();
  const calc = crypto.createHmac('sha256', secret).update(dataCheck).digest('hex');
  const a = Buffer.from(calc, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  const authDate = parseInt(params.get('auth_date') || '0', 10);
  if (!authDate || Date.now() / 1000 - authDate > MAX_AGE_SEC) return null;

  try {
    const user = JSON.parse(params.get('user') || 'null');
    if (!user || typeof user.id !== 'number') return null;
    return {
      id: user.id,
      first_name: String(user.first_name || ''),
      last_name: String(user.last_name || ''),
      username: String(user.username || ''),
      photo_url: String(user.photo_url || ''),
      start_param: params.get('start_param') || '',
    };
  } catch {
    return null;
  }
}

export function displayName(u) {
  const n = [u.first_name, u.last_name].filter(Boolean).join(' ').trim() || u.username || 'Игрок';
  return n.slice(0, 40);
}
