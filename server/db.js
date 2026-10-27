import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';
import { displayName } from './auth.js';

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
const db = new DatabaseSync(config.dbPath);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    username TEXT NOT NULL DEFAULT '',
    photo TEXT NOT NULL DEFAULT '',
    rating INTEGER NOT NULL DEFAULT ${config.startRating},
    peak INTEGER NOT NULL DEFAULT ${config.startRating},
    games INTEGER NOT NULL DEFAULT 0,
    wins INTEGER NOT NULL DEFAULT 0,
    losses INTEGER NOT NULL DEFAULT 0,
    draws INTEGER NOT NULL DEFAULT 0,
    bot_started INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_seen INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS games (
    id TEXT PRIMARY KEY,
    white_id INTEGER NOT NULL REFERENCES users(id),
    black_id INTEGER NOT NULL REFERENCES users(id),
    result TEXT NOT NULL,
    reason TEXT NOT NULL,
    tc TEXT NOT NULL,
    rated INTEGER NOT NULL,
    white_rating INTEGER NOT NULL,
    black_rating INTEGER NOT NULL,
    white_delta INTEGER NOT NULL DEFAULT 0,
    black_delta INTEGER NOT NULL DEFAULT 0,
    pgn TEXT NOT NULL,
    moves INTEGER NOT NULL DEFAULT 0,
    started_at INTEGER NOT NULL,
    ended_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS games_white ON games(white_id, ended_at);
  CREATE INDEX IF NOT EXISTS games_black ON games(black_id, ended_at);
  CREATE INDEX IF NOT EXISTS games_ended ON games(ended_at);
  CREATE INDEX IF NOT EXISTS users_rating ON users(rating);
`);

const q = {
  get: db.prepare('SELECT * FROM users WHERE id = ?'),
  insert: db.prepare(`INSERT INTO users (id, name, username, photo, created_at, last_seen)
                      VALUES (?, ?, ?, ?, ?, ?)`),
  update: db.prepare('UPDATE users SET name = ?, username = ?, photo = ?, last_seen = ? WHERE id = ?'),
  botStarted: db.prepare('UPDATE users SET bot_started = 1 WHERE id = ?'),
  applyResult: db.prepare(`UPDATE users SET rating = rating + ?, peak = MAX(peak, rating + ?), games = games + 1,
                           wins = wins + ?, losses = losses + ?, draws = draws + ? WHERE id = ?`),
  insertGame: db.prepare(`INSERT INTO games (id, white_id, black_id, result, reason, tc, rated, white_rating, black_rating,
                          white_delta, black_delta, pgn, moves, started_at, ended_at)
                          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  top: db.prepare(`SELECT id, name, username, photo, rating, games, wins, losses, draws FROM users
                   WHERE games > 0 ORDER BY rating DESC, games DESC LIMIT ?`),
  rank: db.prepare('SELECT COUNT(*) AS n FROM users WHERE games > 0 AND rating > ?'),
  week: db.prepare(`SELECT u.id, u.name, u.username, u.photo, u.rating, SUM(x.d) AS gain, COUNT(*) AS n, SUM(x.win) AS w
    FROM (
      SELECT white_id AS uid, white_delta AS d, CASE result WHEN '1-0' THEN 1 ELSE 0 END AS win FROM games WHERE rated = 1 AND ended_at > ?
      UNION ALL
      SELECT black_id, black_delta, CASE result WHEN '0-1' THEN 1 ELSE 0 END FROM games WHERE rated = 1 AND ended_at > ?
    ) x JOIN users u ON u.id = x.uid
    GROUP BY u.id ORDER BY gain DESC, w DESC LIMIT ?`),
  recent: db.prepare(`SELECT g.*, w.name AS white_name, b.name AS black_name FROM games g
    JOIN users w ON w.id = g.white_id JOIN users b ON b.id = g.black_id
    WHERE g.white_id = ? OR g.black_id = ? ORDER BY g.ended_at DESC LIMIT ?`),
  game: db.prepare(`SELECT g.*, w.name AS white_name, b.name AS black_name FROM games g
    JOIN users w ON w.id = g.white_id JOIN users b ON b.id = g.black_id WHERE g.id = ?`),
  ratingHistory: db.prepare(`SELECT ended_at, CASE WHEN white_id = ? THEN white_rating + white_delta ELSE black_rating + black_delta END AS r
    FROM games WHERE rated = 1 AND (white_id = ? OR black_id = ?) ORDER BY ended_at DESC LIMIT 50`),
  h2h: db.prepare(`SELECT
      SUM(CASE WHEN (white_id = ?1 AND result = '1-0') OR (black_id = ?1 AND result = '0-1') THEN 1 ELSE 0 END) AS w,
      SUM(CASE WHEN result = '1/2-1/2' THEN 1 ELSE 0 END) AS d,
      SUM(CASE WHEN (white_id = ?2 AND result = '1-0') OR (black_id = ?2 AND result = '0-1') THEN 1 ELSE 0 END) AS l
    FROM games WHERE (white_id = ?1 AND black_id = ?2) OR (white_id = ?2 AND black_id = ?1)`),
  search: db.prepare(`SELECT id, name, username, photo, rating, games FROM users
    WHERE name LIKE ? OR username LIKE ? ORDER BY games DESC LIMIT 20`),
};

export function upsertUser(tg) {
  const now = Date.now();
  const name = displayName(tg);
  const existing = q.get.get(tg.id);
  if (existing) q.update.run(name, tg.username || '', tg.photo_url || existing.photo || '', now, tg.id);
  else q.insert.run(tg.id, name, tg.username || '', tg.photo_url || '', now, now);
  return q.get.get(tg.id);
}

export const getUser = (id) => q.get.get(id) || null;
export const markBotStarted = (id) => q.botStarted.run(id);

export function saveGame(g) {
  db.exec('BEGIN');
  try {
    q.insertGame.run(g.id, g.whiteId, g.blackId, g.result, g.reason, g.tc, g.rated ? 1 : 0, g.whiteRating, g.blackRating,
      g.whiteDelta, g.blackDelta, g.pgn, g.moves, g.startedAt, g.endedAt);
    if (g.rated) {
      const ws = g.result === '1-0' ? 1 : 0, bs = g.result === '0-1' ? 1 : 0, dr = g.result === '1/2-1/2' ? 1 : 0;
      q.applyResult.run(g.whiteDelta, g.whiteDelta, ws, bs, dr, g.whiteId);
      q.applyResult.run(g.blackDelta, g.blackDelta, bs, ws, dr, g.blackId);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

const publicUser = (u) => u && ({
  id: u.id, name: u.name, username: u.username, photo: u.photo, rating: u.rating,
  games: u.games, wins: u.wins, losses: u.losses, draws: u.draws,
});

export function leaderboard(period, limit = 100) {
  if (period === 'week') {
    const since = Date.now() - 7 * 24 * 3600 * 1000;
    return q.week.all(since, since, limit).map(r => ({
      id: r.id, name: r.name, username: r.username, photo: r.photo, rating: r.rating, gain: r.gain, games: r.n, wins: r.w,
    }));
  }
  return q.top.all(limit).map(publicUser);
}

export function rankOf(user) {
  if (!user || !user.games) return null;
  return q.rank.get(user.rating).n + 1;
}

const gameRow = (g) => ({
  id: g.id, white: { id: g.white_id, name: g.white_name, rating: g.white_rating, delta: g.white_delta },
  black: { id: g.black_id, name: g.black_name, rating: g.black_rating, delta: g.black_delta },
  result: g.result, reason: g.reason, tc: g.tc, rated: !!g.rated, moves: g.moves, endedAt: g.ended_at,
});

export function profile(id, viewerId) {
  const u = q.get.get(id);
  if (!u) return null;
  const history = q.ratingHistory.all(id, id, id).map(r => r.r).reverse();
  const out = {
    ...publicUser(u), peak: u.peak, createdAt: u.created_at, lastSeen: u.last_seen, rank: rankOf(u),
    recent: q.recent.all(id, id, 20).map(gameRow),
    history: [config.startRating, ...history].slice(-50),
  };
  if (viewerId && viewerId !== id) {
    const h = q.h2h.get(viewerId, id);
    out.h2h = { wins: h.w || 0, draws: h.d || 0, losses: h.l || 0 };
  }
  return out;
}

export function getGame(id) {
  const g = q.game.get(id);
  return g ? { ...gameRow(g), pgn: g.pgn } : null;
}

export function searchUsers(text) {
  const s = '%' + String(text).replace(/[%_]/g, '').slice(0, 30) + '%';
  return q.search.all(s, s).map(publicUser);
}

export { publicUser };
