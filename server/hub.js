// Онлайн-часть: подключения, поиск соперника, вызовы на дуэль, активные партии.
import { validateInitData } from './auth.js';
import { config } from './config.js';
import { upsertUser, getUser, publicUser, rankOf } from './db.js';
import { Game, TIME_CONTROLS, newId } from './game.js';

const CHALLENGE_TTL = 30 * 60_000;
const AUTH_TIMEOUT = 10_000;

export class Hub {
  constructor() {
    this.sockets = new Map();     // uid -> Set<ws>
    this.queue = new Map();       // uid -> { tc, since, rating }
    this.challenges = new Map();  // code -> challenge
    this.games = new Map();       // id -> Game
    this.activeGame = new Map();  // uid -> gameId
    this.bot = null;              // уведомления через бота (необязательно)
    setInterval(() => this._matchmake(), 1000).unref();
    setInterval(() => this._cleanup(), 60_000).unref();
    setInterval(() => this._broadcastOnline(), 15_000).unref();
  }

  // ---------- подключения ----------
  attach(ws) {
    ws.uid = null;
    ws.bucket = { tokens: 20, at: Date.now() };
    const authTimer = setTimeout(() => { if (!ws.uid) ws.close(4001, 'auth timeout'); }, AUTH_TIMEOUT);
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (raw) => {
      if (!this._allow(ws)) return;
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (!msg || typeof msg.t !== 'string') return;
      if (!ws.uid) {
        if (msg.t !== 'auth') return;
        clearTimeout(authTimer);
        return this._auth(ws, msg.initData);
      }
      try { this._handle(ws, ws.uid, msg); } catch (e) { console.error('Ошибка обработки', msg.t, e); }
    });
    ws.on('close', () => {
      clearTimeout(authTimer);
      if (ws.uid) this._disconnect(ws);
    });
  }

  heartbeat() {
    for (const set of this.sockets.values()) {
      for (const ws of set) {
        if (!ws.isAlive) { ws.terminate(); continue; }
        ws.isAlive = false;
        try { ws.ping(); } catch { /* сокет уже закрыт */ }
      }
    }
  }

  _allow(ws) {
    const now = Date.now();
    const b = ws.bucket;
    b.tokens = Math.min(20, b.tokens + (now - b.at) / 100); // 10 сообщений/с, всплеск до 20
    b.at = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  _auth(ws, initData) {
    const tg = validateInitData(initData);
    if (!tg) {
      this._sendWs(ws, { t: 'auth_error', message: 'Не удалось проверить вход через Telegram. Откройте приложение заново.' });
      return ws.close(4003, 'bad auth');
    }
    const user = upsertUser(tg);
    ws.uid = user.id;
    const firstSocket = !this.sockets.has(user.id);
    if (firstSocket) this.sockets.set(user.id, new Set());
    this.sockets.get(user.id).add(ws);

    this._sendWs(ws, {
      t: 'hello', me: { ...publicUser(user), peak: user.peak, rank: rankOf(user) }, online: this.sockets.size,
      startParam: tg.start_param || '', timeControls: Object.keys(TIME_CONTROLS),
    });

    // вызовы, адресованные этому игроку, и его собственные
    for (const ch of this.challenges.values()) {
      if (ch.toId === user.id) this._sendWs(ws, { t: 'challenge_in', challenge: this._chPublic(ch) });
      if (ch.fromId === user.id) this._sendWs(ws, { t: 'challenge_out', challenge: this._chPublic(ch) });
    }
    if (this.queue.has(user.id)) this._sendWs(ws, { t: 'queue', tc: this.queue.get(user.id).tc, waiting: this._queueCount(this.queue.get(user.id).tc) });

    const gid = this.activeGame.get(user.id);
    const game = gid && this.games.get(gid);
    if (game && game.status === 'active') {
      this._sendWs(ws, { t: 'game', game: game.snapshot(user.id) });
      game.setOnline(user.id, true);
    }
  }

  _disconnect(ws) {
    const set = this.sockets.get(ws.uid);
    if (!set) return;
    set.delete(ws);
    if (set.size) return;
    this.sockets.delete(ws.uid);
    this.queue.delete(ws.uid);
    const gid = this.activeGame.get(ws.uid);
    const game = gid && this.games.get(gid);
    if (game) game.setOnline(ws.uid, false);
  }

  isOnline(uid) { return this.sockets.has(uid); }

  _sendWs(ws, msg) {
    if (ws.readyState === 1) ws.send(JSON.stringify(msg));
  }

  send(uid, msg) {
    const set = this.sockets.get(uid);
    if (!set) return false;
    const data = JSON.stringify(msg);
    for (const ws of set) if (ws.readyState === 1) ws.send(data);
    return true;
  }

  _broadcastOnline() {
    const msg = { t: 'online', n: this.sockets.size, games: this.activeGame.size / 2 };
    for (const uid of this.sockets.keys()) this.send(uid, msg);
  }

  _error(ws, message) { this._sendWs(ws, { t: 'error', message }); }

  // ---------- сообщения ----------
  _handle(ws, uid, msg) {
    const gid = this.activeGame.get(uid);
    const game = gid ? this.games.get(gid) : (msg.gameId ? this.games.get(msg.gameId) : null);

    switch (msg.t) {
      case 'ping': return this._sendWs(ws, { t: 'pong', serverTime: Date.now(), id: msg.id });
      case 'me': {
        const u = getUser(uid);
        return this._sendWs(ws, { t: 'me', me: { ...publicUser(u), peak: u.peak, rank: rankOf(u) } });
      }
      case 'queue': return this._joinQueue(ws, uid, msg.tc);
      case 'unqueue':
        this.queue.delete(uid);
        return this._sendWs(ws, { t: 'queue', tc: null });
      case 'challenge': return this._createChallenge(ws, uid, msg);
      case 'challenge_cancel': return this._cancelChallenge(uid, msg.code);
      case 'challenge_accept': return this._acceptChallenge(ws, uid, msg.code);
      case 'challenge_decline': return this._declineChallenge(uid, msg.code);
      case 'challenge_info': {
        const ch = this.challenges.get(String(msg.code || ''));
        if (!ch) return this._sendWs(ws, { t: 'challenge_info', code: msg.code, challenge: null });
        return this._sendWs(ws, { t: 'challenge_info', code: msg.code, challenge: this._chPublic(ch) });
      }
      case 'resync':
        if (game) this._sendWs(ws, { t: 'game', game: game.snapshot(uid) });
        else this._sendWs(ws, { t: 'nogame' });
        return;
      case 'move': {
        if (!game || game.id !== msg.gameId) return this._error(ws, 'Партия не найдена');
        const err = game.move(uid, msg);
        if (err) {
          this._error(ws, err);
          this._sendWs(ws, { t: 'game', game: game.snapshot(uid) });
        }
        return;
      }
      case 'resign': if (game) game.resign(uid); return;
      case 'abort': if (game && game.ply < 2) game.end(null, 'aborted'); return;
      case 'draw_offer': if (game) game.offerDraw(uid); return;
      case 'draw_decline': if (game) game.declineDraw(uid); return;
      case 'chat': if (game) game.say(uid, msg.text); return;
      case 'rematch': return this._rematch(ws, uid, msg.gameId);
    }
  }

  // ---------- быстрый поиск ----------
  _joinQueue(ws, uid, tc) {
    if (!TIME_CONTROLS[tc]) return this._error(ws, 'Неизвестный контроль времени');
    if (this.activeGame.has(uid)) return this._error(ws, 'Сначала завершите текущую партию');
    const u = getUser(uid);
    this.queue.set(uid, { tc, since: Date.now(), rating: u.rating });
    this.send(uid, { t: 'queue', tc, waiting: this._queueCount(tc) });
    this._matchmake();
  }

  _queueCount(tc) {
    let n = 0;
    for (const q of this.queue.values()) if (q.tc === tc) n++;
    return n;
  }

  _matchmake() {
    const byTc = new Map();
    for (const [uid, q] of this.queue) {
      if (!byTc.has(q.tc)) byTc.set(q.tc, []);
      byTc.get(q.tc).push({ uid, ...q });
    }
    const now = Date.now();
    for (const [tc, list] of byTc) {
      list.sort((a, b) => a.since - b.since);
      const used = new Set();
      for (const a of list) {
        if (used.has(a.uid)) continue;
        // окно по рейтингу расширяется со временем ожидания
        const windowA = 150 + (now - a.since) / 1000 * 25;
        let best = null;
        for (const b of list) {
          if (b.uid === a.uid || used.has(b.uid)) continue;
          const diff = Math.abs(a.rating - b.rating);
          const windowB = 150 + (now - b.since) / 1000 * 25;
          if (diff <= Math.min(windowA, windowB) && (!best || diff < Math.abs(a.rating - best.rating))) best = b;
        }
        if (best) {
          used.add(a.uid); used.add(best.uid);
          this.queue.delete(a.uid); this.queue.delete(best.uid);
          const aWhite = Math.random() < 0.5;
          this._startGame(aWhite ? a.uid : best.uid, aWhite ? best.uid : a.uid, tc, true);
        }
      }
    }
  }

  // ---------- вызовы ----------
  _chPublic(ch) {
    const from = getUser(ch.fromId);
    const to = ch.toId ? getUser(ch.toId) : null;
    return {
      code: ch.code, tc: ch.tc, rated: ch.rated, color: ch.color, createdAt: ch.createdAt, expiresAt: ch.createdAt + CHALLENGE_TTL,
      from: publicUser(from), to: to ? publicUser(to) : null, fromOnline: this.isOnline(ch.fromId),
      link: inviteLink(this.bot, ch.code),
    };
  }

  _createChallenge(ws, uid, msg) {
    if (!TIME_CONTROLS[msg.tc]) return this._error(ws, 'Неизвестный контроль времени');
    if (this.activeGame.has(uid)) return this._error(ws, 'Сначала завершите текущую партию');
    const toId = msg.to ? Number(msg.to) : null;
    if (toId === uid) return this._error(ws, 'Нельзя вызвать самого себя');
    if (toId && !getUser(toId)) return this._error(ws, 'Игрок не найден');
    let mine = 0;
    for (const ch of this.challenges.values()) if (ch.fromId === uid) mine++;
    if (mine >= 5) return this._error(ws, 'Слишком много активных вызовов. Отмените старые.');

    const ch = {
      code: newId(8), fromId: uid, toId, tc: msg.tc, rated: msg.rated !== false,
      color: ['w', 'b'].includes(msg.color) ? msg.color : 'random', createdAt: Date.now(),
    };
    this.challenges.set(ch.code, ch);
    const pub = this._chPublic(ch);
    this.send(uid, { t: 'challenge_out', challenge: pub });

    if (toId) {
      const delivered = this.send(toId, { t: 'challenge_in', challenge: pub });
      const from = getUser(uid);
      if (this.bot) {
        this.bot.notify(toId,
          `⚔️ <b>${escapeHtml(from.name)}</b> (${from.rating}) вызывает вас на дуэль!\n` +
          `Контроль: ${ch.tc}, ${ch.rated ? 'на рейтинг' : 'без рейтинга'}.`,
          { join: ch.code }, delivered);
      }
    }
  }

  _cancelChallenge(uid, code) {
    const ch = this.challenges.get(String(code || ''));
    if (!ch || ch.fromId !== uid) return;
    this._dropChallenge(ch, 'cancelled');
  }

  _declineChallenge(uid, code) {
    const ch = this.challenges.get(String(code || ''));
    if (!ch || ch.toId !== uid) return;
    this._dropChallenge(ch, 'declined');
  }

  _dropChallenge(ch, reason) {
    this.challenges.delete(ch.code);
    const msg = { t: 'challenge_gone', code: ch.code, reason };
    this.send(ch.fromId, msg);
    if (ch.toId) this.send(ch.toId, msg);
  }

  _acceptChallenge(ws, uid, code) {
    const ch = this.challenges.get(String(code || ''));
    if (!ch) return this._error(ws, 'Вызов уже недействителен');
    if (ch.fromId === uid) return this._error(ws, 'Это ваш собственный вызов. Отправьте ссылку другу.');
    if (ch.toId && ch.toId !== uid) return this._error(ws, 'Этот вызов адресован другому игроку');
    if (this.activeGame.has(uid)) return this._error(ws, 'Сначала завершите текущую партию');
    if (this.activeGame.has(ch.fromId)) return this._error(ws, 'Соперник сейчас играет другую партию. Попробуйте позже.');
    this.challenges.delete(ch.code);
    this.send(ch.fromId, { t: 'challenge_gone', code: ch.code, reason: 'accepted' });

    let white = ch.fromId, black = uid;
    if (ch.color === 'b' || (ch.color === 'random' && Math.random() < 0.5)) [white, black] = [black, white];
    const game = this._startGame(white, black, ch.tc, ch.rated);

    if (!this.isOnline(ch.fromId) && this.bot) {
      const acc = getUser(uid);
      this.bot.notify(ch.fromId, `✅ <b>${escapeHtml(acc.name)}</b> принял ваш вызов! Партия началась — заходите скорее.`, { game: game.id });
    }
  }

  // ---------- партии ----------
  _startGame(whiteId, blackId, tc, rated) {
    const snap = (id) => {
      const u = getUser(id);
      return { id: u.id, name: u.name, photo: u.photo, rating: u.rating, games: u.games };
    };
    this.queue.delete(whiteId); this.queue.delete(blackId);
    // вызовы этих игроков больше не нужны
    for (const ch of [...this.challenges.values()]) {
      if (ch.fromId === whiteId || ch.fromId === blackId) this._dropChallenge(ch, 'busy');
    }
    const game = new Game({ hub: this, white: snap(whiteId), black: snap(blackId), tc, rated });
    this.games.set(game.id, game);
    this.activeGame.set(whiteId, game.id);
    this.activeGame.set(blackId, game.id);
    for (const uid of [whiteId, blackId]) {
      this.send(uid, { t: 'game', game: game.snapshot(uid) });
      if (!this.isOnline(uid)) game.setOnline(uid, false);
    }
    return game;
  }

  onGameEnd(game) {
    for (const uid of [game.white.id, game.black.id]) {
      if (this.activeGame.get(uid) === game.id) this.activeGame.delete(uid);
      const u = getUser(uid);
      this.send(uid, { t: 'me', me: { ...publicUser(u), peak: u.peak, rank: rankOf(u) } });
    }
    game.endedAt = Date.now();
  }

  _rematch(ws, uid, gameId) {
    const game = this.games.get(gameId);
    if (!game || game.status === 'active' || !game.colorOf(uid)) return;
    const opp = game.opponentId(uid);
    if (this.activeGame.has(uid) || this.activeGame.has(opp)) return this._error(ws, 'Соперник уже играет другую партию');
    if (game.rematchFrom && game.rematchFrom !== uid) {
      game.rematchFrom = 'done';
      // цвета меняются
      this._startGame(game.black.id, game.white.id, game.tc, game.rated);
      return;
    }
    if (game.rematchFrom) return;
    game.rematchFrom = uid;
    this.send(opp, { t: 'rematch', gameId: game.id, from: uid });
    this.send(uid, { t: 'rematch', gameId: game.id, from: uid });
  }

  _cleanup() {
    const now = Date.now();
    for (const ch of [...this.challenges.values()]) {
      if (now - ch.createdAt > CHALLENGE_TTL) this._dropChallenge(ch, 'expired');
    }
    for (const [id, g] of this.games) {
      if (g.status !== 'active' && now - (g.endedAt || now) > 10 * 60_000) this.games.delete(id);
    }
  }

  stats() {
    return { online: this.sockets.size, games: this.activeGame.size / 2, queue: this.queue.size };
  }
}

// Ссылка-вызов: прямо в Mini App (если задано APP_NAME), иначе через /start бота
export function inviteLink(bot, code) {
  const username = config.botUsername || (bot && bot.username) || '';
  if (!username) return null;
  if (config.appName) return `https://t.me/${username}/${config.appName}?startapp=duel_${code}`;
  return `https://t.me/${username}?start=duel_${code}`;
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
