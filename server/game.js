import crypto from 'node:crypto';
import { Chess } from '../shared/chess.js';
import { eloDeltas } from './elo.js';
import { saveGame } from './db.js';

export const TIME_CONTROLS = {
  '1+0': [1, 0], '2+1': [2, 1], '3+0': [3, 0], '3+2': [3, 2], '5+0': [5, 0], '5+3': [5, 3],
  '10+0': [10, 0], '10+5': [10, 5], '15+10': [15, 10], '30+0': [30, 0],
};

const FIRST_MOVE_MS = 30_000;   // время на первый ход, иначе партия отменяется
const ABANDON_MS = 90_000;      // сколько ждать отключившегося игрока
const CHAT_LIMIT = 100;

export const newId = (n = 8) => crypto.randomBytes(n).toString('base64url').slice(0, n);

export class Game {
  constructor({ hub, white, black, tc, rated }) {
    this.hub = hub;
    this.id = newId(10);
    this.white = white;   // { id, name, photo, rating, games }
    this.black = black;
    this.tc = tc;
    const [min, inc] = TIME_CONTROLS[tc];
    this.base = min * 60_000;
    this.inc = inc * 1000;
    this.rated = rated;
    this.chess = new Chess();
    this.clock = { w: this.base, b: this.base };
    this.turnStart = Date.now();
    this.startedAt = Date.now();
    this.status = 'active';
    this.result = null;
    this.reason = null;
    this.deltas = null;
    this.drawOffer = null;
    this.rematchFrom = null;
    this.chat = [];
    this.offline = { w: null, b: null }; // время отключения
    this.timers = {};
    this._armFirstMove();
  }

  colorOf(uid) {
    if (uid === this.white.id) return 'w';
    if (uid === this.black.id) return 'b';
    return null;
  }
  player(color) { return color === 'w' ? this.white : this.black; }
  opponentId(uid) { return uid === this.white.id ? this.black.id : this.white.id; }
  get ply() { return this.chess._history.length; }
  clockRunning() { return this.status === 'active' && this.ply >= 2; }

  // Остаток времени на текущий момент
  clockNow() {
    const c = { ...this.clock };
    if (this.clockRunning()) c[this.chess.turn()] = Math.max(0, c[this.chess.turn()] - (Date.now() - this.turnStart));
    return c;
  }

  snapshot(uid) {
    const h = this.chess.history({ verbose: true });
    return {
      id: this.id,
      white: this.white, black: this.black,
      tc: this.tc, rated: this.rated,
      you: this.colorOf(uid),
      moves: h.map(m => m.lan),
      sans: h.map(m => m.san),
      fen: this.chess.fen(),
      turn: this.chess.turn(),
      clock: this.clockNow(),
      running: this.clockRunning(),
      firstMoveDeadline: this.ply < 2 ? this.turnStart + FIRST_MOVE_MS : null,
      status: this.status, result: this.result, reason: this.reason, deltas: this.deltas,
      drawOffer: this.drawOffer,
      chat: this.chat.slice(-30),
      offline: {
        w: this.offline.w ? this.offline.w + ABANDON_MS : null,
        b: this.offline.b ? this.offline.b + ABANDON_MS : null,
      },
      serverTime: Date.now(),
    };
  }

  broadcast(msg) {
    this.hub.send(this.white.id, msg);
    this.hub.send(this.black.id, msg);
  }

  _clear(name) {
    if (this.timers[name]) { clearTimeout(this.timers[name]); delete this.timers[name]; }
  }

  _armFirstMove() {
    this._clear('first');
    this.timers.first = setTimeout(() => {
      if (this.status === 'active' && this.ply < 2) this.end(null, 'aborted');
    }, FIRST_MOVE_MS);
  }

  _armFlag() {
    this._clear('flag');
    if (!this.clockRunning()) return;
    const color = this.chess.turn();
    const left = this.clock[color] - (Date.now() - this.turnStart);
    this.timers.flag = setTimeout(() => this._checkFlag(), Math.max(0, left) + 50);
  }

  _checkFlag() {
    if (this.status !== 'active' || !this.clockRunning()) return false;
    const color = this.chess.turn();
    const left = this.clock[color] - (Date.now() - this.turnStart);
    if (left > 0) { this._armFlag(); return false; }
    this.clock[color] = 0;
    const other = color === 'w' ? 'b' : 'w';
    // если у соперника нет материала для мата — ничья
    if (!this.chess.canMate(other)) this.end('1/2-1/2', 'timeout_draw');
    else this.end(other === 'w' ? '1-0' : '0-1', 'timeout');
    return true;
  }

  move(uid, data) {
    if (this.status !== 'active') return 'Партия уже завершена';
    const color = this.colorOf(uid);
    if (!color) return 'Вы не участник партии';
    if (this.chess.turn() !== color) return 'Сейчас ход соперника';
    if (typeof data.ply === 'number' && data.ply !== this.ply) return null; // устаревший повтор, молча игнорируем
    if (this._checkFlag()) return null;

    const now = Date.now();
    const wasRunning = this.clockRunning();
    const mv = this.chess.move({ from: data.from, to: data.to, promotion: data.promotion });
    if (!mv) return 'Недопустимый ход';

    if (wasRunning) {
      this.clock[color] = Math.max(0, this.clock[color] - (now - this.turnStart)) + this.inc;
    }
    this.turnStart = now;
    if (this.drawOffer && this.drawOffer !== color) this.drawOffer = null; // ход = отказ от ничьей
    if (this.ply < 2) this._armFirstMove(); else this._clear('first');

    this.broadcast({
      t: 'move', gameId: this.id, lan: mv.lan, san: mv.san, from: mv.from, to: mv.to, promotion: mv.promotion,
      ply: this.ply, fen: this.chess.fen(), turn: this.chess.turn(), clock: { ...this.clock },
      running: this.clockRunning(), drawOffer: this.drawOffer,
      firstMoveDeadline: this.ply < 2 ? this.turnStart + FIRST_MOVE_MS : null, serverTime: now,
    });

    const reason = this.chess.gameOverReason();
    if (reason === 'checkmate') this.end(color === 'w' ? '1-0' : '0-1', 'checkmate');
    else if (reason) this.end('1/2-1/2', reason);
    else this._armFlag();
    return null;
  }

  resign(uid) {
    const color = this.colorOf(uid);
    if (!color || this.status !== 'active') return;
    if (this.ply < 2) return this.end(null, 'aborted');
    this.end(color === 'w' ? '0-1' : '1-0', 'resign');
  }

  offerDraw(uid) {
    const color = this.colorOf(uid);
    if (!color || this.status !== 'active' || this.ply < 2) return;
    if (this.drawOffer && this.drawOffer !== color) return this.end('1/2-1/2', 'agreement');
    this.drawOffer = color;
    this.broadcast({ t: 'draw', gameId: this.id, offer: color });
  }

  declineDraw(uid) {
    const color = this.colorOf(uid);
    if (!color || !this.drawOffer || this.drawOffer === color) return;
    this.drawOffer = null;
    this.broadcast({ t: 'draw', gameId: this.id, offer: null, declined: true });
  }

  say(uid, text) {
    const color = this.colorOf(uid);
    if (!color) return;
    text = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!text) return;
    const entry = { from: color, text, at: Date.now() };
    this.chat.push(entry);
    if (this.chat.length > CHAT_LIMIT) this.chat.shift();
    this.broadcast({ t: 'chat', gameId: this.id, ...entry });
  }

  setOnline(uid, online) {
    const color = this.colorOf(uid);
    if (!color || this.status !== 'active') return;
    if (online) {
      if (!this.offline[color]) return;
      this.offline[color] = null;
      this._clear('abandon_' + color);
    } else {
      if (this.offline[color]) return;
      this.offline[color] = Date.now();
      this.timers['abandon_' + color] = setTimeout(() => {
        if (this.status !== 'active' || !this.offline[color]) return;
        if (this.ply < 2) return this.end(null, 'aborted');
        this.end(color === 'w' ? '0-1' : '1-0', 'abandon');
      }, ABANDON_MS);
    }
    const msg = { t: 'presence', gameId: this.id, color, online, deadline: online ? null : this.offline[color] + ABANDON_MS };
    this.hub.send(this.opponentId(uid), msg);
  }

  end(result, reason) {
    if (this.status !== 'active') return;
    this.status = reason === 'aborted' ? 'aborted' : 'ended';
    this.result = result;
    this.reason = reason;
    this.clock = this.clockNow();
    for (const k of Object.keys(this.timers)) this._clear(k);

    let deltas = { white: 0, black: 0 };
    if (this.status === 'ended') {
      const score = result === '1-0' ? 1 : result === '0-1' ? 0 : 0.5;
      if (this.rated) deltas = eloDeltas(this.white, this.black, score);
      const dt = new Date(this.startedAt);
      const pgn = this.chess.pgn({
        Event: this.rated ? 'Рейтинговая партия' : 'Товарищеская партия',
        Site: 'Telegram Mini App',
        Date: `${dt.getUTCFullYear()}.${String(dt.getUTCMonth() + 1).padStart(2, '0')}.${String(dt.getUTCDate()).padStart(2, '0')}`,
        White: this.white.name, Black: this.black.name, Result: result,
        WhiteElo: this.white.rating, BlackElo: this.black.rating, TimeControl: this.tc,
      });
      try {
        saveGame({
          id: this.id, whiteId: this.white.id, blackId: this.black.id, result, reason, tc: this.tc, rated: this.rated,
          whiteRating: this.white.rating, blackRating: this.black.rating, whiteDelta: deltas.white, blackDelta: deltas.black,
          pgn, moves: this.ply, startedAt: this.startedAt, endedAt: Date.now(),
        });
      } catch (e) {
        console.error('Не удалось сохранить партию', this.id, e);
      }
    }
    this.deltas = deltas;
    this.broadcast({
      t: 'end', gameId: this.id, result, reason, deltas, clock: this.clock,
      ratings: { w: this.white.rating + deltas.white, b: this.black.rating + deltas.black },
    });
    this.hub.onGameEnd(this);
  }
}
