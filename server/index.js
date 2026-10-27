import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { config, ROOT } from './config.js';
import { validateInitData } from './auth.js';
import { upsertUser, leaderboard, profile, getGame, searchUsers, getUser, rankOf } from './db.js';
import { Hub } from './hub.js';
import { Bot } from './bot.js';

const hub = new Hub();

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
};
const STATIC = [
  { prefix: '/shared/', dir: path.join(ROOT, 'shared') },
  { prefix: '/', dir: path.join(ROOT, 'public') },
];

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function serveStatic(req, res, pathname) {
  for (const { prefix, dir } of STATIC) {
    if (!pathname.startsWith(prefix)) continue;
    let rel = decodeURIComponent(pathname.slice(prefix.length)) || 'index.html';
    const file = path.normalize(path.join(dir, rel));
    if (!file.startsWith(dir)) break;
    let stat;
    try { stat = fs.statSync(file); } catch { continue; }
    if (!stat.isFile()) continue;
    const ext = path.extname(file);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      // HTML не кешируем, чтобы обновления доходили сразу; остальное — ненадолго
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
      'Content-Length': stat.size,
    });
    if (req.method === 'HEAD') return res.end(), true;
    fs.createReadStream(file).pipe(res);
    return true;
  }
  return false;
}

function authUser(req) {
  const tg = validateInitData(req.headers['x-init-data']);
  return tg ? upsertUser(tg) : null;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://local');
  const p = url.pathname;
  try {
    if (p.startsWith('/api/')) {
      if (p === '/api/health') return sendJson(res, 200, { ok: true, ...hub.stats() });
      if (p === '/api/config') return sendJson(res, 200, { botUsername: config.botUsername || (hub.bot ? hub.bot.username : ''), devMode: config.devMode });
      const me = authUser(req);
      if (!me) return sendJson(res, 401, { error: 'Нужен вход через Telegram' });

      if (p === '/api/leaderboard') {
        const period = url.searchParams.get('period') === 'week' ? 'week' : 'all';
        const list = leaderboard(period).map(u => ({ ...u, online: hub.isOnline(u.id) }));
        return sendJson(res, 200, { period, list, me: { id: me.id, rating: me.rating, rank: rankOf(me), games: me.games } });
      }
      let m = /^\/api\/user\/(\d+)$/.exec(p);
      if (m) {
        const prof = profile(Number(m[1]), me.id);
        if (!prof) return sendJson(res, 404, { error: 'Игрок не найден' });
        prof.online = hub.isOnline(prof.id);
        prof.playing = hub.activeGame.has(prof.id);
        return sendJson(res, 200, prof);
      }
      m = /^\/api\/game\/([\w-]+)$/.exec(p);
      if (m) {
        const g = getGame(m[1]);
        return g ? sendJson(res, 200, g) : sendJson(res, 404, { error: 'Партия не найдена' });
      }
      if (p === '/api/search') {
        const text = (url.searchParams.get('q') || '').trim();
        if (text.length < 2) return sendJson(res, 200, { list: [] });
        return sendJson(res, 200, { list: searchUsers(text).filter(u => u.id !== me.id).map(u => ({ ...u, online: hub.isOnline(u.id) })) });
      }
      if (p === '/api/online') {
        const list = [...hub.sockets.keys()].filter(id => id !== me.id).slice(0, 50).map(id => {
          const u = getUser(id);
          return u && { id: u.id, name: u.name, photo: u.photo, rating: u.rating, playing: hub.activeGame.has(id) };
        }).filter(Boolean);
        return sendJson(res, 200, { list });
      }
      return sendJson(res, 404, { error: 'Не найдено' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    if (serveStatic(req, res, p)) return;
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Не найдено');
  } catch (e) {
    console.error('HTTP', p, e);
    if (!res.headersSent) sendJson(res, 500, { error: 'Внутренняя ошибка' });
  }
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });
wss.on('connection', (ws) => hub.attach(ws));
setInterval(() => hub.heartbeat(), 30_000).unref();

server.listen(config.port, config.host, () => {
  console.log(`Шахматы: http://${config.host}:${config.port}  (публичный адрес ${config.webAppUrl})`);
  if (config.devMode) console.log('ВНИМАНИЕ: включён DEV_MODE — вход без Telegram разрешён. Не используйте его в бою.');
});

if (config.botToken) {
  const bot = new Bot(hub);
  hub.bot = bot;
  // если Telegram временно недоступен, пробуем снова, пока не получится
  const startBot = (attempt = 1) => {
    bot.start().catch(e => {
      const reason = e.cause ? `${e.message} (${e.cause.code || e.cause.message})` : e.message;
      const delay = Math.min(60, 5 * attempt);
      console.error(`Бот не запустился: ${reason}. Повтор через ${delay} с`);
      setTimeout(() => startBot(attempt + 1), delay * 1000);
    });
  };
  startBot();
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log('Остановка...');
    for (const g of hub.games.values()) {
      if (g.status === 'active') g.broadcast({ t: 'error', message: 'Сервер перезапускается. Партия будет прервана.' });
    }
    server.close();
    setTimeout(() => process.exit(0), 300);
  });
}
