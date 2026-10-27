// Шахматные правила: генерация ходов, SAN, FEN, окончание партии.
// Общий модуль для браузера и сервера. Доска в формате 0x88 (a8 = 0, h1 = 119).

export const WHITE = 'w';
export const BLACK = 'b';
export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

const P = 1, N = 2, B = 3, R = 4, Q = 5, K = 6;
const WC = 8, BC = 16;
const TYPE_CH = ['', 'p', 'n', 'b', 'r', 'q', 'k'];
const CH_TYPE = { p: P, n: N, b: B, r: R, q: Q, k: K };

export const FLAGS = { NORMAL: 1, CAPTURE: 2, BIG_PAWN: 4, EP: 8, PROMO: 16, KCASTLE: 32, QCASTLE: 64 };
const F = FLAGS;

const CASTLE_WK = 1, CASTLE_WQ = 2, CASTLE_BK = 4, CASTLE_BQ = 8;

const KNIGHT_OFF = [-33, -31, -18, -14, 14, 18, 31, 33];
const KING_OFF = [-17, -16, -15, -1, 1, 15, 16, 17];
const BISHOP_OFF = [-17, -15, 15, 17];
const ROOK_OFF = [-16, -1, 1, 16];

export function sqName(sq) {
  return 'abcdefgh'[sq & 7] + (8 - (sq >> 4));
}
export function sqIndex(name) {
  if (typeof name !== 'string' || name.length !== 2) return -1;
  const f = name.charCodeAt(0) - 97, r = name.charCodeAt(1) - 49;
  if (f < 0 || f > 7 || r < 0 || r > 7) return -1;
  return (7 - r) * 16 + f;
}
export function isLightSquare(name) {
  const f = name.charCodeAt(0) - 97, r = name.charCodeAt(1) - 49;
  return (f + r) % 2 === 1;
}

const colorOf = (p) => (p & WC ? WHITE : BLACK);
const typeOf = (p) => p & 7;

// Изменение прав рокировки, когда фигура уходит с поля или поле занято взятием
const CASTLE_MASK = new Array(128).fill(15);
CASTLE_MASK[sqIndex('e1')] = 15 & ~(CASTLE_WK | CASTLE_WQ);
CASTLE_MASK[sqIndex('h1')] = 15 & ~CASTLE_WK;
CASTLE_MASK[sqIndex('a1')] = 15 & ~CASTLE_WQ;
CASTLE_MASK[sqIndex('e8')] = 15 & ~(CASTLE_BK | CASTLE_BQ);
CASTLE_MASK[sqIndex('h8')] = 15 & ~CASTLE_BK;
CASTLE_MASK[sqIndex('a8')] = 15 & ~CASTLE_BQ;

export function validateFen(fen) {
  if (typeof fen !== 'string') return false;
  const parts = fen.trim().split(/\s+/);
  if (parts.length < 4) return false;
  const rows = parts[0].split('/');
  if (rows.length !== 8) return false;
  let wk = 0, bk = 0;
  for (const row of rows) {
    let n = 0;
    for (const c of row) {
      if (/[1-8]/.test(c)) n += +c;
      else if (/[pnbrqkPNBRQK]/.test(c)) { n++; if (c === 'K') wk++; if (c === 'k') bk++; }
      else return false;
    }
    if (n !== 8) return false;
  }
  if (wk !== 1 || bk !== 1) return false;
  if (!/^[wb]$/.test(parts[1])) return false;
  if (!/^(-|[KQkq]+)$/.test(parts[2])) return false;
  if (!/^(-|[a-h][36])$/.test(parts[3])) return false;
  return true;
}

export class Chess {
  constructor(fen = START_FEN) {
    this.load(fen);
  }

  load(fen) {
    if (!validateFen(fen)) throw new Error('Неверный FEN: ' + fen);
    const parts = fen.trim().split(/\s+/);
    this.board = new Array(128).fill(0);
    this.kings = { w: -1, b: -1 };
    let sq = 0;
    for (const c of parts[0]) {
      if (c === '/') { sq += 8; continue; }
      if (/[1-8]/.test(c)) { sq += +c; continue; }
      const lower = c.toLowerCase();
      const color = c === lower ? BC : WC;
      this.board[sq] = color | CH_TYPE[lower];
      if (lower === 'k') this.kings[color === WC ? 'w' : 'b'] = sq;
      sq++;
    }
    this._turn = parts[1];
    this.castling = 0;
    if (parts[2].includes('K')) this.castling |= CASTLE_WK;
    if (parts[2].includes('Q')) this.castling |= CASTLE_WQ;
    if (parts[2].includes('k')) this.castling |= CASTLE_BK;
    if (parts[2].includes('q')) this.castling |= CASTLE_BQ;
    this.ep = parts[3] === '-' ? -1 : sqIndex(parts[3]);
    this.halfmove = parts[4] !== undefined ? parseInt(parts[4], 10) || 0 : 0;
    this.fullmove = parts[5] !== undefined ? parseInt(parts[5], 10) || 1 : 1;
    this.startFen = fen.trim();
    this._stack = [];
    this._history = [];
    this._positions = new Map();
    this._countPosition(1);
    return true;
  }

  reset() { this.load(START_FEN); }
  turn() { return this._turn; }

  get(square) {
    const sq = sqIndex(square);
    if (sq < 0 || !this.board[sq]) return null;
    const p = this.board[sq];
    return { type: TYPE_CH[typeOf(p)], color: colorOf(p) };
  }

  board8() {
    const out = [];
    for (let r = 0; r < 8; r++) {
      const row = [];
      for (let f = 0; f < 8; f++) {
        const sq = r * 16 + f;
        const p = this.board[sq];
        row.push(p ? { square: sqName(sq), type: TYPE_CH[typeOf(p)], color: colorOf(p) } : null);
      }
      out.push(row);
    }
    return out;
  }

  // ---------- FEN ----------
  _epForFen() {
    // поле взятия на проходе пишем только если взятие реально возможно
    if (this.ep < 0) return '-';
    const us = this._turn === WHITE ? WC : BC;
    const dir = this._turn === WHITE ? 16 : -16; // откуда может бить наша пешка
    for (const d of [dir - 1, dir + 1]) {
      const s = this.ep + d;
      if (!(s & 0x88) && this.board[s] === (us | P)) return sqName(this.ep);
    }
    return '-';
  }

  _placement() {
    let s = '';
    for (let r = 0; r < 8; r++) {
      let empty = 0;
      for (let f = 0; f < 8; f++) {
        const p = this.board[r * 16 + f];
        if (!p) { empty++; continue; }
        if (empty) { s += empty; empty = 0; }
        const ch = TYPE_CH[typeOf(p)];
        s += p & WC ? ch.toUpperCase() : ch;
      }
      if (empty) s += empty;
      if (r < 7) s += '/';
    }
    return s;
  }

  _castleStr() {
    let c = '';
    if (this.castling & CASTLE_WK) c += 'K';
    if (this.castling & CASTLE_WQ) c += 'Q';
    if (this.castling & CASTLE_BK) c += 'k';
    if (this.castling & CASTLE_BQ) c += 'q';
    return c || '-';
  }

  _positionKey() {
    return this._placement() + ' ' + this._turn + ' ' + this._castleStr() + ' ' + this._epForFen();
  }

  fen() {
    return this._positionKey() + ' ' + this.halfmove + ' ' + this.fullmove;
  }

  _countPosition(delta) {
    const key = this._positionKey();
    const n = (this._positions.get(key) || 0) + delta;
    if (n <= 0) this._positions.delete(key); else this._positions.set(key, n);
  }

  // ---------- атаки ----------
  isAttacked(sq, byColor) {
    const b = this.board;
    const them = byColor === WHITE ? WC : BC;
    // пешки
    if (byColor === WHITE) {
      for (const d of [15, 17]) { const s = sq + d; if (!(s & 0x88) && b[s] === (WC | P)) return true; }
    } else {
      for (const d of [-15, -17]) { const s = sq + d; if (!(s & 0x88) && b[s] === (BC | P)) return true; }
    }
    for (const d of KNIGHT_OFF) { const s = sq + d; if (!(s & 0x88) && b[s] === (them | N)) return true; }
    for (const d of KING_OFF) { const s = sq + d; if (!(s & 0x88) && b[s] === (them | K)) return true; }
    for (const d of BISHOP_OFF) {
      let s = sq + d;
      while (!(s & 0x88)) {
        const p = b[s];
        if (p) { if (p === (them | B) || p === (them | Q)) return true; break; }
        s += d;
      }
    }
    for (const d of ROOK_OFF) {
      let s = sq + d;
      while (!(s & 0x88)) {
        const p = b[s];
        if (p) { if (p === (them | R) || p === (them | Q)) return true; break; }
        s += d;
      }
    }
    return false;
  }

  _kingAttacked(color) {
    return this.isAttacked(this.kings[color], color === WHITE ? BLACK : WHITE);
  }

  inCheck() { return this._kingAttacked(this._turn); }

  // ---------- генерация ходов ----------
  _pseudo(onlySq = -1) {
    const moves = [];
    const b = this.board;
    const color = this._turn;
    const us = color === WHITE ? WC : BC;
    const them = color === WHITE ? BC : WC;
    const add = (from, to, piece, captured, flags) => {
      if (typeOf(piece) === P && ((to >> 4) === 0 || (to >> 4) === 7)) {
        for (const promo of [Q, R, B, N]) moves.push({ from, to, piece, captured, promotion: promo, flags: flags | F.PROMO });
      } else {
        moves.push({ from, to, piece, captured, promotion: 0, flags });
      }
    };
    for (let from = 0; from < 128; from++) {
      if (from & 0x88) { from += 7; continue; }
      if (onlySq >= 0 && from !== onlySq) continue;
      const piece = b[from];
      if (!piece || !(piece & us)) continue;
      const type = typeOf(piece);
      if (type === P) {
        const dir = color === WHITE ? -16 : 16;
        const startRank = color === WHITE ? 6 : 1;
        const one = from + dir;
        if (!(one & 0x88) && !b[one]) {
          add(from, one, piece, 0, F.NORMAL);
          const two = one + dir;
          if ((from >> 4) === startRank && !b[two]) add(from, two, piece, 0, F.BIG_PAWN);
        }
        for (const d of [dir - 1, dir + 1]) {
          const to = from + d;
          if (to & 0x88) continue;
          if (b[to] && (b[to] & them)) add(from, to, piece, b[to], F.CAPTURE);
          else if (to === this.ep) add(from, to, piece, them | P, F.EP);
        }
      } else if (type === N || type === K) {
        for (const d of type === N ? KNIGHT_OFF : KING_OFF) {
          const to = from + d;
          if (to & 0x88) continue;
          if (!b[to]) add(from, to, piece, 0, F.NORMAL);
          else if (b[to] & them) add(from, to, piece, b[to], F.CAPTURE);
        }
        if (type === K) {
          const enemy = color === WHITE ? BLACK : WHITE;
          const home = color === WHITE ? sqIndex('e1') : sqIndex('e8');
          if (from === home) {
            const kRight = color === WHITE ? CASTLE_WK : CASTLE_BK;
            const qRight = color === WHITE ? CASTLE_WQ : CASTLE_BQ;
            if ((this.castling & kRight) && !b[from + 1] && !b[from + 2] && b[from + 3] === (us | R) &&
                !this.isAttacked(from, enemy) && !this.isAttacked(from + 1, enemy) && !this.isAttacked(from + 2, enemy)) {
              add(from, from + 2, piece, 0, F.KCASTLE);
            }
            if ((this.castling & qRight) && !b[from - 1] && !b[from - 2] && !b[from - 3] && b[from - 4] === (us | R) &&
                !this.isAttacked(from, enemy) && !this.isAttacked(from - 1, enemy) && !this.isAttacked(from - 2, enemy)) {
              add(from, from - 2, piece, 0, F.QCASTLE);
            }
          }
        }
      } else {
        const offs = type === B ? BISHOP_OFF : type === R ? ROOK_OFF : KING_OFF;
        for (const d of offs) {
          let to = from + d;
          while (!(to & 0x88)) {
            if (!b[to]) add(from, to, piece, 0, F.NORMAL);
            else { if (b[to] & them) add(from, to, piece, b[to], F.CAPTURE); break; }
            to += d;
          }
        }
      }
    }
    return moves;
  }

  // Легальные ходы во внутреннем формате (используется движком)
  _legal(onlySq = -1) {
    const color = this._turn;
    const out = [];
    for (const m of this._pseudo(onlySq)) {
      this._make(m);
      if (!this._kingAttacked(color)) out.push(m);
      this._unmake();
    }
    return out;
  }

  _make(m) {
    const b = this.board;
    const color = this._turn;
    this._stack.push({ m, castling: this.castling, ep: this.ep, halfmove: this.halfmove, fullmove: this.fullmove });
    b[m.to] = m.promotion ? ((color === WHITE ? WC : BC) | m.promotion) : m.piece;
    b[m.from] = 0;
    if (m.flags & F.EP) b[color === WHITE ? m.to + 16 : m.to - 16] = 0;
    if (m.flags & F.KCASTLE) { b[m.to - 1] = b[m.to + 1]; b[m.to + 1] = 0; }
    if (m.flags & F.QCASTLE) { b[m.to + 1] = b[m.to - 2]; b[m.to - 2] = 0; }
    if (typeOf(m.piece) === K) this.kings[color] = m.to;
    this.castling &= CASTLE_MASK[m.from] & CASTLE_MASK[m.to];
    this.ep = m.flags & F.BIG_PAWN ? (color === WHITE ? m.to + 16 : m.to - 16) : -1;
    this.halfmove = typeOf(m.piece) === P || m.captured ? 0 : this.halfmove + 1;
    if (color === BLACK) this.fullmove++;
    this._turn = color === WHITE ? BLACK : WHITE;
  }

  _unmake() {
    const st = this._stack.pop();
    if (!st) return null;
    const m = st.m;
    const b = this.board;
    this._turn = this._turn === WHITE ? BLACK : WHITE;
    const color = this._turn;
    this.castling = st.castling; this.ep = st.ep; this.halfmove = st.halfmove; this.fullmove = st.fullmove;
    b[m.from] = m.piece;
    b[m.to] = 0;
    if (m.flags & F.EP) b[color === WHITE ? m.to + 16 : m.to - 16] = m.captured;
    else if (m.captured) b[m.to] = m.captured;
    if (m.flags & F.KCASTLE) { b[m.to + 1] = b[m.to - 1]; b[m.to - 1] = 0; }
    if (m.flags & F.QCASTLE) { b[m.to - 2] = b[m.to + 1]; b[m.to + 1] = 0; }
    if (typeOf(m.piece) === K) this.kings[color] = m.from;
    return m;
  }

  _san(m, legal) {
    let san;
    if (m.flags & F.KCASTLE) san = 'O-O';
    else if (m.flags & F.QCASTLE) san = 'O-O-O';
    else {
      const type = typeOf(m.piece);
      const capture = !!m.captured;
      if (type === P) {
        san = (capture ? sqName(m.from)[0] + 'x' : '') + sqName(m.to);
      } else {
        san = TYPE_CH[type].toUpperCase();
        const rivals = legal.filter(o => o !== m && o.to === m.to && o.piece === m.piece && o.from !== m.from);
        if (rivals.length) {
          const sameFile = rivals.some(o => (o.from & 7) === (m.from & 7));
          const sameRank = rivals.some(o => (o.from >> 4) === (m.from >> 4));
          const n = sqName(m.from);
          if (!sameFile) san += n[0];
          else if (!sameRank) san += n[1];
          else san += n;
        }
        san += (capture ? 'x' : '') + sqName(m.to);
      }
      if (m.promotion) san += '=' + TYPE_CH[m.promotion].toUpperCase();
    }
    this._make(m);
    if (this.inCheck()) san += this._legal().length ? '+' : '#';
    this._unmake();
    return san;
  }

  _verbose(m, legal) {
    const flags = [];
    if (m.flags & F.CAPTURE) flags.push('c');
    if (m.flags & F.EP) flags.push('e');
    if (m.flags & F.BIG_PAWN) flags.push('b');
    if (m.flags & F.PROMO) flags.push('p');
    if (m.flags & F.KCASTLE) flags.push('k');
    if (m.flags & F.QCASTLE) flags.push('q');
    if (!flags.length || (flags.length === 1 && flags[0] === 'p')) flags.unshift('n');
    return {
      color: colorOf(m.piece),
      from: sqName(m.from),
      to: sqName(m.to),
      piece: TYPE_CH[typeOf(m.piece)],
      captured: m.captured ? TYPE_CH[typeOf(m.captured)] : undefined,
      promotion: m.promotion ? TYPE_CH[m.promotion] : undefined,
      flags: flags.join(''),
      san: this._san(m, legal),
      lan: sqName(m.from) + sqName(m.to) + (m.promotion ? TYPE_CH[m.promotion] : ''),
    };
  }

  moves(opts = {}) {
    const only = opts.square ? sqIndex(opts.square) : -1;
    if (opts.square && only < 0) return [];
    const all = this._legal();
    const list = only >= 0 ? all.filter(m => m.from === only) : all;
    if (opts.verbose) return list.map(m => this._verbose(m, all));
    return list.map(m => this._san(m, all));
  }

  _findMove(input) {
    const legal = this._legal();
    if (typeof input === 'string') {
      const s = input.trim().replace(/[+#!?]+$/, '').replace(/0/g, 'O');
      // UCI: e2e4, e7e8q
      const uci = /^([a-h][1-8])([a-h][1-8])([qrbn])?$/i.exec(s);
      if (uci) return this._findMove({ from: uci[1], to: uci[2], promotion: uci[3] && uci[3].toLowerCase() });
      for (const m of legal) {
        if (this._san(m, legal).replace(/[+#]$/, '') === s) return { m, legal };
      }
      return null;
    }
    if (!input || typeof input !== 'object') return null;
    const from = sqIndex(input.from), to = sqIndex(input.to);
    if (from < 0 || to < 0) return null;
    const promo = input.promotion ? CH_TYPE[String(input.promotion).toLowerCase()] : 0;
    for (const m of legal) {
      if (m.from !== from || m.to !== to) continue;
      if (m.promotion) {
        if ((promo || Q) === m.promotion) return { m, legal };
      } else return { m, legal };
    }
    return null;
  }

  // Возвращает подробный ход или null, если ход нелегален
  move(input) {
    const found = this._findMove(input);
    if (!found) return null;
    const v = this._verbose(found.m, found.legal);
    v.before = this.fen();
    this._make(found.m);
    this._history.push(v);
    this._countPosition(1);
    v.after = this.fen();
    return v;
  }

  undo() {
    if (!this._stack.length) return null;
    this._countPosition(-1);
    this._unmake();
    return this._history.pop() || null;
  }

  history(opts = {}) {
    return opts.verbose ? this._history.slice() : this._history.map(h => h.san);
  }

  isCheckmate() { return this.inCheck() && this._legal().length === 0; }
  isStalemate() { return !this.inCheck() && this._legal().length === 0; }

  isInsufficientMaterial() {
    const minors = [];
    let others = 0;
    for (let sq = 0; sq < 128; sq++) {
      if (sq & 0x88) { sq += 7; continue; }
      const p = this.board[sq];
      if (!p) continue;
      const t = typeOf(p);
      if (t === K) continue;
      if (t === B || t === N) minors.push({ t, light: ((sq >> 4) + (sq & 7)) % 2 });
      else others++;
    }
    if (others) return false;
    if (minors.length <= 1) return true;
    // только слоны, все на полях одного цвета
    if (minors.every(m => m.t === B)) return minors.every(m => m.light === minors[0].light);
    return false;
  }

  isThreefoldRepetition() { return (this._positions.get(this._positionKey()) || 0) >= 3; }
  isFiftyMoves() { return this.halfmove >= 100; }
  isDraw() {
    return this.isStalemate() || this.isInsufficientMaterial() || this.isThreefoldRepetition() || this.isFiftyMoves();
  }
  isGameOver() { return this.isCheckmate() || this.isDraw(); }

  // Причина окончания: checkmate | stalemate | insufficient | threefold | fifty | null
  gameOverReason() {
    const noMoves = this._legal().length === 0;
    if (noMoves) return this.inCheck() ? 'checkmate' : 'stalemate';
    if (this.isInsufficientMaterial()) return 'insufficient';
    if (this.isThreefoldRepetition()) return 'threefold';
    if (this.isFiftyMoves()) return 'fifty';
    return null;
  }

  // Есть ли у стороны хоть какой-то материал для мата (для ничьей при флаге)
  canMate(color) {
    const us = color === WHITE ? WC : BC;
    let minors = 0;
    for (let sq = 0; sq < 128; sq++) {
      if (sq & 0x88) { sq += 7; continue; }
      const p = this.board[sq];
      if (!p || !(p & us)) continue;
      const t = typeOf(p);
      if (t === P || t === R || t === Q) return true;
      if (t === B || t === N) minors++;
    }
    return minors >= 2;
  }

  pgn(headers = {}) {
    let out = '';
    for (const [k, v] of Object.entries(headers)) out += `[${k} "${String(v).replace(/"/g, "'")}"]\n`;
    if (out) out += '\n';
    const tmp = new Chess(this.startFen);
    const parts = [];
    for (const h of this._history) {
      const num = tmp.fullmove;
      if (tmp.turn() === WHITE) parts.push(num + '. ' + h.san);
      else parts.push((parts.length ? '' : num + '... ') + h.san);
      tmp.move(h.san);
    }
    if (headers.Result) parts.push(headers.Result);
    return out + parts.join(' ');
  }
}

// Подсчёт узлов для проверки генератора ходов
export function perft(chess, depth) {
  if (depth === 0) return 1;
  const moves = chess._legal();
  if (depth === 1) return moves.length;
  let n = 0;
  for (const m of moves) {
    chess._make(m);
    n += perft(chess, depth - 1);
    chess._unmake();
  }
  return n;
}

export const PIECE = { P, N, B, R, Q, K, WC, BC };
