import { searchBest } from '/shared/engine.js';

self.onmessage = (e) => {
  const { id, fen, level } = e.data;
  let best = null;
  try { best = searchBest(fen, level); } catch (err) { console.error(err); }
  self.postMessage({ id, best });
};
