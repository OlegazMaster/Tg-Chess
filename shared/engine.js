// Небольшой шахматный движок: альфа-бета с итеративным углублением и форсированными взятиями.
import { Chess, PIECE } from './chess.js';

const { P, N, B, R, Q, K, WC } = PIECE;
const VALUE = [0, 100, 320, 330, 500, 900, 0];

// Таблицы позиционных бонусов (с точки зрения белых, a8 = индекс 0)
const PST = {
  [P]: [
    0, 0, 0, 0, 0, 0, 0, 0,
    50, 50, 50, 50, 50, 50, 50, 50,
    10, 10, 20, 30, 30, 20, 10, 10,
    5, 5, 10, 25, 25, 10, 5, 5,
    0, 0, 0, 20, 20, 0, 0, 0,
    5, -5, -10, 0, 0, -10, -5, 5,
    5, 10, 10, -20, -20, 10, 10, 5,
    0, 0, 0, 0, 0, 0, 0, 0],
  [N]: [
    -50, -40, -30, -30, -30, -30, -40, -50,
    -40, -20, 0, 0, 0, 0, -20, -40,
    -30, 0, 10, 15, 15, 10, 0, -30,
    -30, 5, 15, 20, 20, 15, 5, -30,
    -30, 0, 15, 20, 20, 15, 0, -30,
    -30, 5, 10, 15, 15, 10, 5, -30,
    -40, -20, 0, 5, 5, 0, -20, -40,
    -50, -40, -30, -30, -30, -30, -40, -50],
  [B]: [
    -20, -10, -10, -10, -10, -10, -10, -20,
    -10, 0, 0, 0, 0, 0, 0, -10,
    -10, 0, 5, 10, 10, 5, 0, -10,
    -10, 5, 5, 10, 10, 5, 5, -10,
    -10, 0, 10, 10, 10, 10, 0, -10,
    -10, 10, 10, 10, 10, 10, 10, -10,
    -10, 5, 0, 0, 0, 0, 5, -10,
    -20, -10, -10, -10, -10, -10, -10, -20],
  [R]: [
    0, 0, 0, 0, 0, 0, 0, 0,
    5, 10, 10, 10, 10, 10, 10, 5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    0, 0, 0, 5, 5, 0, 0, 0],
  [Q]: [
    -20, -10, -10, -5, -5, -10, -10, -20,
    -10, 0, 0, 0, 0, 0, 0, -10,
    -10, 0, 5, 5, 5, 5, 0, -10,
    -5, 0, 5, 5, 5, 5, 0, -5,
    0, 0, 5, 5, 5, 5, 0, -5,
    -10, 5, 5, 5, 5, 5, 0, -10,
    -10, 0, 5, 0, 0, 0, 0, -10,
    -20, -10, -10, -5, -5, -10, -10, -20],
  [K]: [
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -20, -30, -30, -40, -40, -30, -30, -20,
    -10, -20, -20, -20, -20, -20, -20, -10,
    20, 20, 0, 0, 0, 0, 20, 20,
    20, 30, 10, 0, 0, 10, 30, 20],
  KE: [
    -50, -40, -30, -20, -20, -30, -40, -50,
    -30, -20, -10, 0, 0, -10, -20, -30,
    -30, -10, 20, 30, 30, 20, -10, -30,
    -30, -10, 30, 40, 40, 30, -10, -30,
    -30, -10, 30, 40, 40, 30, -10, -30,
    -30, -10, 20, 30, 30, 20, -10, -30,
    -30, -30, 0, 0, 0, 0, -30, -30,
    -50, -30, -30, -30, -30, -30, -30, -50],
};

const MATE = 100000;

function evaluate(c) {
  const b = c.board;
  let score = 0, nonPawn = 0;
  for (let sq = 0; sq < 128; sq++) {
    if (sq & 0x88) { sq += 7; continue; }
    const p = b[sq];
    if (p && (p & 7) !== P && (p & 7) !== K) nonPawn += VALUE[p & 7];
  }
  const endgame = nonPawn <= 1300;
  for (let sq = 0; sq < 128; sq++) {
    if (sq & 0x88) { sq += 7; continue; }
    const p = b[sq];
    if (!p) continue;
    const t = p & 7;
    const white = !!(p & WC);
    const idx = (sq >> 4) * 8 + (sq & 7);
    const tIdx = white ? idx : (7 - (sq >> 4)) * 8 + (sq & 7);
    const table = t === K && endgame ? PST.KE : PST[t];
    const v = VALUE[t] + table[tIdx];
    score += white ? v : -v;
  }
  return c.turn() === 'w' ? score : -score;
}

function orderScore(m, pvMove) {
  if (pvMove && m.from === pvMove.from && m.to === pvMove.to && m.promotion === pvMove.promotion) return 1e6;
  let s = 0;
  if (m.captured) s += 10 * VALUE[m.captured & 7] - VALUE[m.piece & 7] + 1000;
  if (m.promotion) s += VALUE[m.promotion] + 800;
  return s;
}

export function searchBest(fen, opts = {}) {
  const maxDepth = opts.depth || 3;
  const timeLimit = opts.timeMs || 1500;
  const noise = opts.noise || 0;
  const randomChance = opts.randomChance || 0;
  const c = new Chess(fen);
  const root = c._legal();
  if (!root.length) return null;
  const toLan = (m) => {
    const names = 'abcdefgh';
    const sq = (s) => names[s & 7] + (8 - (s >> 4));
    return { from: sq(m.from), to: sq(m.to), promotion: m.promotion ? ' pnbrqk'[m.promotion] : undefined };
  };
  if (randomChance && Math.random() < randomChance) return toLan(root[Math.floor(Math.random() * root.length)]);

  const start = Date.now();
  let nodes = 0, stopped = false;
  const timeUp = () => {
    if ((++nodes & 1023) === 0 && Date.now() - start > timeLimit) stopped = true;
    return stopped;
  };

  function quiesce(alpha, beta, qdepth) {
    if (timeUp()) return 0;
    const stand = evaluate(c);
    if (stand >= beta) return beta;
    if (stand > alpha) alpha = stand;
    if (qdepth <= 0) return alpha;
    const moves = c._legal().filter(m => m.captured || m.promotion);
    moves.sort((a, b2) => orderScore(b2) - orderScore(a));
    for (const m of moves) {
      c._make(m);
      const s = -quiesce(-beta, -alpha, qdepth - 1);
      c._unmake();
      if (stopped) return 0;
      if (s >= beta) return beta;
      if (s > alpha) alpha = s;
    }
    return alpha;
  }

  function negamax(depth, alpha, beta, ply) {
    if (timeUp()) return 0;
    const moves = c._legal();
    if (!moves.length) return c.inCheck() ? -MATE + ply : 0;
    if (c.halfmove >= 100) return 0;
    if (depth <= 0) return quiesce(alpha, beta, 6);
    moves.sort((a, b2) => orderScore(b2) - orderScore(a));
    for (const m of moves) {
      c._make(m);
      const s = -negamax(depth - 1, -beta, -alpha, ply + 1);
      c._unmake();
      if (stopped) return 0;
      if (s >= beta) return beta;
      if (s > alpha) alpha = s;
    }
    return alpha;
  }

  let best = root[0], bestScores = null;
  for (let d = 1; d <= maxDepth; d++) {
    const scored = [];
    root.sort((a, b2) => orderScore(b2, best) - orderScore(a, best));
    let alpha = -MATE - 1;
    for (const m of root) {
      c._make(m);
      // окно расширено на величину шума, чтобы ходы, близкие к лучшему, имели честную оценку
      const s = -negamax(d - 1, -MATE - 1, -(alpha - noise), 1);
      c._unmake();
      if (stopped) break;
      scored.push({ m, s });
      if (s > alpha) alpha = s;
    }
    if (stopped && d > 1) break;
    if (scored.length) {
      bestScores = scored;
      scored.sort((a, b2) => b2.s - a.s);
      best = scored[0].m;
      if (scored[0].s > MATE - 1000) break; // нашли мат
    }
    if (Date.now() - start > timeLimit * 0.5) break;
  }

  if (noise && bestScores && bestScores.length > 1) {
    const top = bestScores[0].s;
    const pool = bestScores.filter(x => x.s >= top - noise);
    best = pool[Math.floor(Math.random() * pool.length)].m;
  }
  return toLan(best);
}

export const LEVELS = [
  { id: 1, name: 'Новичок', depth: 1, noise: 200, randomChance: 0.25, timeMs: 400 },
  { id: 2, name: 'Любитель', depth: 2, noise: 60, randomChance: 0.05, timeMs: 800 },
  { id: 3, name: 'Клубный игрок', depth: 3, noise: 20, timeMs: 1500 },
  { id: 4, name: 'Мастер', depth: 6, noise: 0, timeMs: 3000 },
];
