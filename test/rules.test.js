// Проверка правил: perft-числа для эталонных позиций и несколько особых случаев
import { Chess, perft } from '../shared/chess.js';

const cases = [
  ['rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', [20, 400, 8902, 197281]],
  ['r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1', [48, 2039, 97862]],
  ['8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1', [14, 191, 2812, 43238]],
  ['r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1', [6, 264, 9467]],
  ['rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8', [44, 1486, 62379]],
  ['r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10', [46, 2079, 89890]],
];

let failed = 0;
for (const [fen, expected] of cases) {
  const c = new Chess(fen);
  expected.forEach((n, i) => {
    const got = perft(c, i + 1);
    if (got !== n) { failed++; console.log(`ОШИБКА ${fen} глубина ${i + 1}: ${got}, ожидалось ${n}`); }
  });
}

const mate = new Chess();
['e4', 'e5', 'Qh5', 'Nc6', 'Bc4', 'Nf6', 'Qxf7#'].forEach(m => mate.move(m));
if (mate.gameOverReason() !== 'checkmate') { failed++; console.log('ОШИБКА: детский мат не распознан'); }

const rep = new Chess();
['Nf3', 'Nf6', 'Ng1', 'Ng8', 'Nf3', 'Nf6', 'Ng1', 'Ng8'].forEach(m => rep.move(m));
if (!rep.isThreefoldRepetition()) { failed++; console.log('ОШИБКА: троекратное повторение'); }

const ep = new Chess('k7/8/8/3pP3/8/8/8/7K w - d6 0 1');
if (!ep.move('exd6')) { failed++; console.log('ОШИБКА: взятие на проходе'); }

console.log(failed ? `Провалено проверок: ${failed}` : 'Все проверки правил пройдены');
process.exit(failed ? 1 : 0);
