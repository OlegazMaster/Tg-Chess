// Интерактивная доска: тап или перетаскивание, подсветка ходов, анимация, выбор превращения.
import { pieceSVG } from './pieces.js';

const FILES = 'abcdefgh';

function parseFen(fen) {
  const map = new Map();
  const rows = fen.split(' ')[0].split('/');
  rows.forEach((row, r) => {
    let f = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) { f += +ch; continue; }
      const color = ch === ch.toUpperCase() ? 'w' : 'b';
      map.set(FILES[f] + (8 - r), { color, type: ch.toLowerCase() });
      f++;
    }
  });
  return map;
}

export class Board {
  constructor(root, opts = {}) {
    this.root = root;
    this.opts = opts; // { onMove(from,to,promo), movable(square) -> bool, legal(square) -> [{to, promotion}] }
    this.orientation = 'w';
    this.position = new Map();
    this.pieceEls = new Map(); // square -> element
    this.selected = null;
    this.lastMove = null;
    this.checkSq = null;
    this.interactive = false;
    this.drag = null;
    this._build();
  }

  _build() {
    this.root.classList.add('board');
    this.root.innerHTML = '';
    this.squaresEl = document.createElement('div');
    this.squaresEl.className = 'squares';
    this.piecesEl = document.createElement('div');
    this.piecesEl.className = 'pieces';
    this.root.append(this.squaresEl, this.piecesEl);
    this.squareEls = new Map();
    for (let i = 0; i < 64; i++) {
      const d = document.createElement('div');
      d.className = 'sq';
      this.squaresEl.append(d);
    }
    this._layoutSquares();
    this.root.addEventListener('pointerdown', (e) => this._down(e));
    this.root.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('pointermove', (e) => this._move(e), { passive: false });
    window.addEventListener('pointerup', (e) => this._up(e));
    window.addEventListener('pointercancel', () => this._cancelDrag());
  }

  _layoutSquares() {
    this.squareEls.clear();
    const els = [...this.squaresEl.children];
    els.forEach((d, i) => {
      const row = Math.floor(i / 8), col = i % 8;
      const file = this.orientation === 'w' ? col : 7 - col;
      const rank = this.orientation === 'w' ? 8 - row : row + 1;
      const sq = FILES[file] + rank;
      d.dataset.square = sq;
      d.className = 'sq ' + ((file + rank) % 2 === 1 ? 'light' : 'dark');
      let coords = '';
      if (col === 0) coords += `<span class="coord rank">${rank}</span>`;
      if (row === 7) coords += `<span class="coord file">${FILES[file]}</span>`;
      d.innerHTML = coords;
      this.squareEls.set(sq, d);
    });
  }

  _xy(sq) {
    const f = FILES.indexOf(sq[0]), r = +sq[1];
    return this.orientation === 'w' ? [f, 8 - r] : [7 - f, r - 1];
  }

  _place(el, sq) {
    const [x, y] = this._xy(sq);
    el.style.transform = `translate(${x * 100}%, ${y * 100}%)`;
  }

  setOrientation(color) {
    if (color === this.orientation) return;
    this.orientation = color;
    this._layoutSquares();
    for (const [sq, el] of this.pieceEls) {
      el.classList.add('no-anim');
      this._place(el, sq);
      void el.offsetWidth;
      el.classList.remove('no-anim');
    }
    this._paint();
  }

  flip() { this.setOrientation(this.orientation === 'w' ? 'b' : 'w'); }

  // Установить позицию; с анимацией перемещения фигур
  setPosition(fen, { lastMove = null, check = null, animate = true } = {}) {
    const next = parseFen(fen);
    const oldEls = new Map(this.pieceEls);
    const newEls = new Map();
    // фигуры, оставшиеся на месте
    for (const [sq, p] of next) {
      const el = oldEls.get(sq);
      if (el && el.dataset.piece === p.color + p.type) { newEls.set(sq, el); oldEls.delete(sq); }
    }
    // перемещения: ищем ближайшую исчезнувшую фигуру того же вида
    for (const [sq, p] of next) {
      if (newEls.has(sq)) continue;
      const key = p.color + p.type;
      let bestSq = null, bestD = 99;
      for (const [osq, el] of oldEls) {
        if (el.dataset.piece !== key || next.get(osq)?.color + next.get(osq)?.type === key) continue;
        const d = Math.abs(FILES.indexOf(osq[0]) - FILES.indexOf(sq[0])) + Math.abs(+osq[1] - +sq[1]);
        if (d < bestD) { bestD = d; bestSq = osq; }
      }
      let el;
      if (bestSq && animate) { el = oldEls.get(bestSq); oldEls.delete(bestSq); }
      else {
        el = document.createElement('div');
        el.className = 'piece no-anim';
        el.dataset.piece = key;
        el.innerHTML = pieceSVG(p.color, p.type);
        this.piecesEl.append(el);
        this._place(el, sq);
        void el.offsetWidth;
        el.classList.remove('no-anim');
      }
      el.dataset.square = sq;
      this._place(el, sq);
      newEls.set(sq, el);
    }
    for (const el of oldEls.values()) {
      if (animate) { el.classList.add('captured'); setTimeout(() => el.remove(), 200); } else el.remove();
    }
    for (const [sq, el] of newEls) el.dataset.square = sq;
    this.pieceEls = newEls;
    this.position = next;
    this.lastMove = lastMove;
    this.checkSq = check;
    if (this.selected && !this.position.has(this.selected)) this.selected = null;
    this._paint();
  }

  setInteractive(on) {
    this.interactive = on;
    if (!on) { this.selected = null; this._cancelDrag(); }
    this._paint();
  }

  _paint() {
    const legal = this.selected && this.opts.legal ? this.opts.legal(this.selected) : [];
    const targets = new Set(legal.map(m => m.to));
    for (const [sq, d] of this.squareEls) {
      d.classList.toggle('last', !!this.lastMove && (sq === this.lastMove.from || sq === this.lastMove.to));
      d.classList.toggle('selected', sq === this.selected);
      d.classList.toggle('check', sq === this.checkSq);
      const t = targets.has(sq);
      d.classList.toggle('dot', t && !this.position.has(sq));
      d.classList.toggle('ring', t && this.position.has(sq));
    }
  }

  _squareAt(e) {
    const r = this.root.getBoundingClientRect();
    const x = Math.floor((e.clientX - r.left) / r.width * 8);
    const y = Math.floor((e.clientY - r.top) / r.height * 8);
    if (x < 0 || x > 7 || y < 0 || y > 7) return null;
    const file = this.orientation === 'w' ? x : 7 - x;
    const rank = this.orientation === 'w' ? 8 - y : y + 1;
    return FILES[file] + rank;
  }

  _canPick(sq) {
    return this.interactive && this.position.has(sq) && (!this.opts.movable || this.opts.movable(sq));
  }

  _isTarget(from, to) {
    return !!from && this.opts.legal && this.opts.legal(from).some(m => m.to === to);
  }

  _down(e) {
    if (e.button !== undefined && e.button !== 0) return;
    if (this.promoEl) return;
    const sq = this._squareAt(e);
    if (!sq) return;
    e.preventDefault();
    if (this.selected && sq !== this.selected && this._isTarget(this.selected, sq)) {
      this._tryMove(this.selected, sq);
      return;
    }
    if (this._canPick(sq)) {
      const wasSelected = this.selected === sq;
      this.selected = sq;
      this._paint();
      const el = this.pieceEls.get(sq);
      const r = this.root.getBoundingClientRect();
      this.drag = { from: sq, el, startX: e.clientX, startY: e.clientY, active: false, size: r.width / 8, rect: r, wasSelected };
      this.root.setPointerCapture?.(e.pointerId);
    } else {
      this.selected = null;
      this._paint();
    }
  }

  _move(e) {
    const d = this.drag;
    if (!d) return;
    const dx = e.clientX - d.startX, dy = e.clientY - d.startY;
    if (!d.active && Math.hypot(dx, dy) < 6) return;
    e.preventDefault();
    if (!d.active) {
      d.active = true;
      d.el.classList.add('dragging');
    }
    const x = e.clientX - d.rect.left - d.size / 2;
    const y = e.clientY - d.rect.top - d.size / 2;
    d.el.style.transform = `translate(${x}px, ${y}px) scale(1.15)`;
    const over = this._squareAt(e);
    for (const [sq, s] of this.squareEls) s.classList.toggle('hover', sq === over && this._isTarget(d.from, sq));
  }

  _up(e) {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    for (const s of this.squareEls.values()) s.classList.remove('hover');
    if (!d.active) {
      // обычный тап: повторный тап по выбранной фигуре снимает выбор
      if (d.wasSelected) { this.selected = null; this._paint(); }
      return;
    }
    d.el.classList.remove('dragging');
    const to = this._squareAt(e);
    d.el.classList.add('no-anim');
    this._place(d.el, d.from);
    void d.el.offsetWidth;
    d.el.classList.remove('no-anim');
    if (to && to !== d.from && this._isTarget(d.from, to)) this._tryMove(d.from, to, true);
  }

  _cancelDrag() {
    const d = this.drag;
    this.drag = null;
    if (d && d.active) {
      d.el.classList.remove('dragging');
      this._place(d.el, d.from);
    }
  }

  async _tryMove(from, to, dropped = false) {
    const moves = this.opts.legal(from).filter(m => m.to === to);
    if (!moves.length) return;
    let promotion;
    if (moves.some(m => m.promotion)) {
      promotion = await this._askPromotion(to, this.position.get(from).color);
      if (!promotion) { this._paint(); return; }
    }
    this.selected = null;
    if (dropped) {
      // визуально переносим фигуру сразу, без анимации от исходного поля
      const el = this.pieceEls.get(from);
      if (el) { el.classList.add('no-anim'); this._place(el, to); void el.offsetWidth; el.classList.remove('no-anim'); }
    }
    this._paint();
    this.opts.onMove(from, to, promotion);
  }

  _askPromotion(to, color) {
    return new Promise((resolve) => {
      const [x, y] = this._xy(to);
      const box = document.createElement('div');
      box.className = 'promo';
      const down = y === 0;
      box.style.left = `${x * 12.5}%`;
      box.style.top = down ? '0' : 'auto';
      box.style.bottom = down ? 'auto' : '0';
      for (const t of ['q', 'n', 'r', 'b']) {
        const b = document.createElement('button');
        b.innerHTML = pieceSVG(color, t);
        b.addEventListener('pointerdown', (e) => { e.stopPropagation(); close(t); });
        box.append(b);
      }
      const shade = document.createElement('div');
      shade.className = 'promo-shade';
      shade.addEventListener('pointerdown', (e) => { e.stopPropagation(); close(null); });
      const close = (t) => { shade.remove(); box.remove(); this.promoEl = null; resolve(t); };
      this.root.append(shade, box);
      this.promoEl = box;
    });
  }
}
