// Рейтинг Эло. score: 1 — победа, 0.5 — ничья, 0 — поражение (для первого игрока)
export function kFactor(rating, games) {
  if (games < 30) return 40;
  if (rating >= 2400) return 10;
  return 20;
}

export function expected(ra, rb) {
  return 1 / (1 + Math.pow(10, (rb - ra) / 400));
}

export function eloDeltas(white, black, score) {
  const ew = expected(white.rating, black.rating);
  const dw = Math.round(kFactor(white.rating, white.games) * (score - ew));
  const db = Math.round(kFactor(black.rating, black.games) * ((1 - score) - (1 - ew)));
  return { white: dw, black: db };
}
