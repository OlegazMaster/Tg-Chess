// Экран партии: онлайн против человека или локально против компьютера
import { Chess } from '/shared/chess.js';
import { LEVELS } from '/shared/engine.js';
import { Board } from './board.js';
import { esc, el, avatar, fmtClock, sheet, toast, haptic, sound, signed, tg } from './ui.js';

const REASONS = {
  checkmate: 'Мат', resign: 'Сдача', timeout: 'Время вышло',
  timeout_draw: 'Время вышло, но для мата не хватает материала', stalemate: 'Пат',
  insufficient: 'Недостаточно материала для мата', threefold: 'Троекратное повторение позиции',
  fifty: 'Правило 50 ходов', agreement: 'Ничья по соглашению', abandon: 'Соперник покинул партию',
  aborted: 'Партия отменена: первый ход не был сделан',
};
const GLYPH = { p: '♟', n: '♞', b: '♝', r: '♜', q: '♛' };
const VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9 };
const QUICK = ['Удачи!', 'Хорошая игра!', 'Спасибо за партию', 'Ой!', 'Красиво 👏', 'Реванш?'];

export class GameView {
  // opts: { mode: 'online'|'ai', me, net, onExit, onNewGame, aiLevel, aiColor, aiMoves }
  constructor(opts) {
    this.o = opts;
    this.mode = opts.mode;
    this.chess = new Chess();
    this.viewPly = null;
    this.status = 'active';
    this.unread = 0;
    this.chat = [];
    this.timer = null;
    this.thinking = false;
    this.endShown = false;
  }

  // ---------- построение ----------
  mount(container) {
    this.root = el(`<div class="screen game">
      <div class="plate" data-p="top"></div>
      <div class="board-wrap"><div class="bd"></div></div>
      <div class="plate" data-p="bottom"></div>
      <div class="status-line"></div>
      <div class="offer-slot"></div>
      <div class="moves"></div>
      <div class="toolbar"></div>
    </div>`);
    container.replaceChildren(this.root);
    this.board = new Board(this.root.querySelector('.bd'), {
      movable: (sq) => this._canMoveFrom(sq),
      legal: (sq) => (this._canMoveFrom(sq) ? this.chess.moves({ square: sq, verbose: true }) : []),
      onMove: (from, to, promotion) => this._userMove(from, to, promotion),
    });
    this.board.setOrientation(this.myColor || 'w');
    this._renderAll(false);
    this.timer = setInterval(() => this._tick(), 100);
    if (tg) { try { tg.enableClosingConfirmation(); } catch { /* старый клиент */ } }
    if (this.mode === 'ai') this._maybeAIMove();
  }

  unmount() {
    clearInterval(this.timer);
    if (this.worker) { this.worker.terminate(); this.worker = null; }
    if (this.thinking) { this.thinking = false; this.reqId = (this.reqId || 0) + 1; }
    if (tg) { try { tg.disableClosingConfirmation(); } catch { /* старый клиент */ } }
  }

  // ---------- общие данные ----------
  get live() { return this.viewPly === null || this.viewPly === this.chess._history.length; }

  _canMoveFrom(sq) {
    if (this.status !== 'active' || !this.live || this.thinking) return false;
    if (this.chess.turn() !== this.myColor) return false;
    const p = this.chess.get(sq);
    return !!p && p.color === this.myColor;
  }

  _player(color) {
    return color === 'w' ? this.white : this.black;
  }

  _checkSquare(c) {
    if (!c.inCheck()) return null;
    for (const row of c.board8()) for (const p of row) if (p && p.type === 'k' && p.color === c.turn()) return p.square;
    return null;
  }

  _positionAt(ply) {
    const h = this.chess.history({ verbose: true });
    if (ply >= h.length) return { fen: this.chess.fen(), last: h[h.length - 1], chess: this.chess };
    const c = new Chess();
    for (let i = 0; i < ply; i++) c.move(h[i].san);
    return { fen: c.fen(), last: h[ply - 1], chess: c };
  }

  // ---------- онлайн ----------
  loadSnapshot(g) {
    this.gameId = g.id;
    this.white = g.white; this.black = g.black;
    this.myColor = g.you || 'w';
    this.tc = g.tc; this.rated = g.rated;
    this.chess = new Chess();
    for (const m of g.moves) this.chess.move(m);
    this.status = g.status === 'active' ? 'active' : 'ended';
    this.result = g.result; this.reason = g.reason; this.deltas = g.deltas;
    this.drawOffer = g.drawOffer;
    this.chat = g.chat || [];
    this._syncClock(g);
    const opp = this.myColor === 'w' ? 'b' : 'w';
    this.oppOfflineUntil = g.offline && g.offline[opp] ? this._local(g.offline[opp], g.serverTime) : null;
    this.viewPly = null;
    if (this.board) {
      this.board.setOrientation(this.myColor);
      this._renderAll(false);
    }
  }

  _local(serverTs, serverNow) { return serverTs - serverNow + Date.now(); }

  _syncClock(m) {
    if (!m.clock) return;
    this.clockBase = { ...m.clock };
    this.clockAt = Date.now();
    this.running = !!m.running;
    this.firstMoveUntil = m.firstMoveDeadline ? this._local(m.firstMoveDeadline, m.serverTime) : null;
  }

  applyMove(m) {
    const ply = this.chess._history.length;
    if (m.ply === ply + 1) {
      const mv = this.chess.move(m.lan);
      if (!mv || this.chess.fen() !== m.fen) return this.o.net.send({ t: 'resync' });
      this._afterMove(mv, true);
    } else if (m.ply !== ply) {
      return this.o.net.send({ t: 'resync' });
    }
    this.drawOffer = m.drawOffer;
    this._syncClock(m);
    this._renderAll(true);
  }

  applyDraw(m) {
    this.drawOffer = m.offer;
    if (m.offer && m.offer !== this.myColor) { haptic('warning'); sound('notify'); }
    if (m.declined && this.drawOffer === null) toast('Предложение ничьей отклонено');
    this._renderOffer();
  }

  applyChat(m) {
    this.chat.push(m);
    if (this.chatSheet) this._renderChatLog();
    else if (m.from !== this.myColor) { this.unread++; sound('notify'); toast(`💬 ${m.text}`); }
    this._renderToolbar();
  }

  applyPresence(m) {
    if (m.color === this.myColor) return;
    this.oppOfflineUntil = m.online ? null : Date.now() + (m.deadline - Date.now());
    if (m.online) toast('Соперник вернулся');
  }

  applyEnd(m) {
    this.status = 'ended';
    this.result = m.result; this.reason = m.reason; this.deltas = m.deltas;
    this.drawOffer = null;
    this.clockBase = m.clock || this.clockBase; this.clockAt = Date.now(); this.running = false;
    this.firstMoveUntil = null; this.oppOfflineUntil = null;
    this._renderAll(false);
    this._showResult();
  }

  // ---------- против компьютера ----------
  startAI({ level, color, moves = [] }) {
    this.level = LEVELS.find(l => l.id === level) || LEVELS[1];
    this.myColor = color;
    const me = this.o.me;
    const bot = { id: -1, name: `Компьютер · ${this.level.name}`, rating: null, ai: true };
    const human = { id: me.id, name: me.name, photo: me.photo, rating: me.rating };
    this.white = color === 'w' ? human : bot;
    this.black = color === 'w' ? bot : human;
    this.chess = new Chess();
    for (const m of moves) this.chess.move(m);
    this.status = 'active';
    const over = this.chess.gameOverReason();
    if (over) this._endAI(over);
    if (this.board) { this.board.setOrientation(color); this._renderAll(false); }
    this._maybeAIMove();
  }

  _saveAI() {
    try {
      if (this.status === 'active') {
        localStorage.setItem('aiGame', JSON.stringify({ level: this.level.id, color: this.myColor, moves: this.chess.history() }));
      } else localStorage.removeItem('aiGame');
    } catch { /* хранилище недоступно */ }
  }

  _maybeAIMove() {
    if (this.mode !== 'ai' || this.status !== 'active' || this.chess.turn() === this.myColor) return;
    this.thinking = true;
    this._renderStatus();
    if (!this.worker) {
      this.worker = new Worker('engine-worker.js', { type: 'module' });
      this.worker.onmessage = (e) => this._onEngine(e.data);
    }
    this.reqId = (this.reqId || 0) + 1;
    const startedAt = Date.now();
    this.engineStarted = startedAt;
    this.worker.postMessage({ id: this.reqId, fen: this.chess.fen(), level: this.level });
  }

  _onEngine({ id, best }) {
    if (id !== this.reqId || this.status !== 'active') return;
    const delay = Math.max(0, 450 - (Date.now() - this.engineStarted)); // чтобы ход не появлялся мгновенно
    setTimeout(() => {
      if (id !== this.reqId) return;
      this.thinking = false;
      const mv = best && this.chess.move(best);
      if (!mv) return this._renderAll(false);
      this.viewPly = null;
      this._afterMove(mv, true);
      this._renderAll(true);
      this._checkAIEnd();
    }, delay);
  }

  _checkAIEnd() {
    const r = this.chess.gameOverReason();
    if (r) this._endAI(r);
    this._saveAI();
  }

  _endAI(reason, result) {
    if (!result) {
      if (reason === 'checkmate') result = this.chess.turn() === 'w' ? '0-1' : '1-0';
      else result = '1/2-1/2';
    }
    this.status = 'ended';
    this.result = result; this.reason = reason; this.deltas = null;
    this.thinking = false;
    this._saveAI();
    if (this.root) { this._renderAll(false); this._showResult(); }
  }

  _undoAI() {
    if (this.thinking) { this.reqId++; this.thinking = false; }
    if (this.status !== 'active') { this.status = 'active'; this.result = null; }
    // откатываем до своего хода
    do { this.chess.undo(); } while (this.chess._history.length && this.chess.turn() !== this.myColor);
    if (this.chess.turn() !== this.myColor) { this._renderAll(false); this._maybeAIMove(); }
    this.viewPly = null;
    this._saveAI();
    this._renderAll(false);
  }

  // ---------- ходы ----------
  _userMove(from, to, promotion) {
    const ply = this.chess._history.length;
    const mv = this.chess.move({ from, to, promotion });
    if (!mv) return this._renderBoard(false);
    this._afterMove(mv, false);
    if (this.mode === 'online') {
      this.o.net.send({ t: 'move', gameId: this.gameId, from, to, promotion, ply });
      // ход отправлен — до ответа сервера часы не трогаем
      if (this.drawOffer === (this.myColor === 'w' ? 'b' : 'w')) this.drawOffer = null;
      this._renderAll(true);
    } else {
      this._renderAll(true);
      this._checkAIEnd();
      this._maybeAIMove();
    }
  }

  _afterMove(mv, byOpponent) {
    const check = mv.san.includes('+') || mv.san.includes('#');
    sound(check ? 'check' : mv.captured ? 'capture' : 'move');
    if (byOpponent) haptic('light');
    this.viewPly = null;
  }

  // ---------- часы ----------
  _clockNow(color) {
    if (!this.clockBase) return null;
    let v = this.clockBase[color];
    if (this.running && this.status === 'active' && this.chess.turn() === color) v -= Date.now() - this.clockAt;
    return Math.max(0, v);
  }

  _tick() {
    if (!this.root || !this.root.isConnected) return;
    if (this.mode === 'online') {
      for (const pos of ['top', 'bottom']) {
        const color = this._colorAt(pos);
        const c = this.root.querySelector(`.plate[data-p="${pos}"] .clock`);
        if (!c) continue;
        const v = this._clockNow(color);
        c.textContent = fmtClock(v);
        const active = this.status === 'active' && this.chess.turn() === color && this.running;
        c.classList.toggle('active', active || (this.status === 'active' && this.chess.turn() === color));
        c.classList.toggle('low', v < 20_000);
      }
    }
    this._renderStatus();
  }

  _colorAt(pos) {
    const bottom = this.board ? this.board.orientation : this.myColor;
    return pos === 'bottom' ? bottom : (bottom === 'w' ? 'b' : 'w');
  }

  // ---------- отрисовка ----------
  _renderAll(animate) {
    if (!this.root) return;
    this._renderPlates();
    this._renderBoard(animate);
    this._renderMoves();
    this._renderOffer();
    this._renderToolbar();
    this._renderStatus();
  }

  _renderBoard(animate) {
    const ply = this.viewPly === null ? this.chess._history.length : this.viewPly;
    const { fen, last, chess } = this._positionAt(ply);
    this.board.setPosition(fen, {
      lastMove: last ? { from: last.from, to: last.to } : null,
      check: this._checkSquare(chess),
      animate,
    });
    this.board.setInteractive(this.status === 'active' && this.live && !this.thinking && this.chess.turn() === this.myColor);
  }

  _material() {
    const count = { w: { p: 0, n: 0, b: 0, r: 0, q: 0 }, b: { p: 0, n: 0, b: 0, r: 0, q: 0 } };
    for (const row of this.chess.board8()) for (const p of row) if (p && p.type !== 'k') count[p.color][p.type]++;
    const start = { p: 8, n: 2, b: 2, r: 2, q: 1 };
    const out = {};
    for (const c of ['w', 'b']) {
      const opp = c === 'w' ? 'b' : 'w';
      let s = '', score = 0;
      for (const t of ['q', 'r', 'b', 'n', 'p']) {
        const taken = Math.max(0, start[t] - count[opp][t]);
        s += GLYPH[t].repeat(taken);
        score += count[c][t] * VALUE[t];
      }
      out[c] = { s, score };
    }
    return out;
  }

  _renderPlates() {
    const mat = this._material();
    for (const pos of ['top', 'bottom']) {
      const color = this._colorAt(pos);
      const p = this._player(color) || {};
      const opp = color === 'w' ? 'b' : 'w';
      const adv = mat[color].score - mat[opp].score;
      const plate = this.root.querySelector(`.plate[data-p="${pos}"]`);
      const ratingStr = p.rating ? ` <span class="hint">${p.rating}</span>` : '';
      const ava = p.ai ? '<div class="avatar" style="background:#5c6370">🤖</div>' : avatar(p);
      plate.innerHTML = `${ava}
        <div class="who"><b class="ellipsis">${esc(p.name || '…')}${ratingStr}</b>
          <div class="captures">${mat[color].s}${adv > 0 ? ` +${adv}` : ''}</div></div>
        ${this.mode === 'online' ? '<div class="clock">–:––</div>' : ''}`;
      if (!p.ai && p.id && this.o.onProfile) {
        plate.querySelector('.who').addEventListener('click', () => this.o.onProfile(p.id));
      }
    }
    this._tick();
  }

  _renderMoves() {
    const box = this.root.querySelector('.moves');
    const h = this.chess.history();
    const cur = this.viewPly === null ? h.length : this.viewPly;
    let html = '';
    h.forEach((san, i) => {
      if (i % 2 === 0) html += `<span class="n">${i / 2 + 1}.</span>`;
      html += `<button data-ply="${i + 1}" class="${i + 1 === cur ? 'cur' : ''}">${esc(san)}</button>`;
    });
    box.innerHTML = html || '<span class="hint small" style="padding:0 6px">Ходов пока нет</span>';
    box.querySelectorAll('button').forEach(b => b.addEventListener('click', () => this._view(+b.dataset.ply)));
    const c = box.querySelector('.cur');
    if (c) c.scrollIntoView({ inline: 'center', block: 'nearest' });
    else box.scrollLeft = box.scrollWidth;
  }

  _view(ply) {
    const n = this.chess._history.length;
    ply = Math.max(0, Math.min(n, ply));
    this.viewPly = ply === n ? null : ply;
    haptic('select');
    this._renderBoard(true);
    this._renderMoves();
  }

  _renderOffer() {
    const slot = this.root.querySelector('.offer-slot');
    const opp = this.myColor === 'w' ? 'b' : 'w';
    if (this.mode === 'online' && this.status === 'active' && this.drawOffer === opp) {
      slot.innerHTML = `<div class="offer"><span class="grow">Соперник предлагает ничью</span>
        <button class="btn small secondary" data-a="no">Нет</button><button class="btn small" data-a="yes">Принять</button></div>`;
      slot.querySelector('[data-a=yes]').onclick = () => this.o.net.send({ t: 'draw_offer' });
      slot.querySelector('[data-a=no]').onclick = () => { this.o.net.send({ t: 'draw_decline' }); this.drawOffer = null; this._renderOffer(); };
    } else if (this.mode === 'online' && this.status === 'active' && this.drawOffer === this.myColor) {
      slot.innerHTML = '<div class="offer"><span class="grow">Вы предложили ничью. Ждём ответа…</span></div>';
    } else slot.innerHTML = '';
  }

  _renderStatus() {
    const line = this.root && this.root.querySelector('.status-line');
    if (!line) return;
    let text = '', warn = false;
    const now = Date.now();
    if (this.status !== 'active') {
      text = this._resultText().title + ' · ' + (REASONS[this.reason] || '');
    } else if (this.thinking) {
      text = 'Компьютер думает…';
    } else if (this.oppOfflineUntil) {
      const s = Math.max(0, Math.ceil((this.oppOfflineUntil - now) / 1000));
      text = `Соперник отключился. Победа будет засчитана через ${s} с`; warn = true;
    } else if (this.firstMoveUntil && this.mode === 'online') {
      const s = Math.max(0, Math.ceil((this.firstMoveUntil - now) / 1000));
      const mine = this.chess.turn() === this.myColor;
      text = mine ? `Ваш первый ход — осталось ${s} с` : `Ждём первый ход соперника (${s} с)`;
      warn = mine && s <= 10;
    } else if (!this.live) {
      text = 'Просмотр истории · нажмите ▶, чтобы вернуться';
    } else if (this.chess.turn() === this.myColor) {
      text = this.chess.inCheck() ? 'Шах! Ваш ход' : 'Ваш ход';
      warn = this.chess.inCheck();
    } else {
      text = 'Ход соперника';
    }
    if (line.textContent !== text) line.textContent = text;
    line.classList.toggle('warn', warn);
  }

  _renderToolbar() {
    const bar = this.root.querySelector('.toolbar');
    const n = this.chess._history.length;
    const cur = this.viewPly === null ? n : this.viewPly;
    const btn = (a, i, label, extra = '') => `<button data-a="${a}" ${extra}><span class="i">${i}</span>${label}</button>`;
    let html = btn('flip', '⇅', 'Доска') + btn('prev', '◀', 'Назад', cur === 0 ? 'disabled' : '') +
      btn('next', '▶', 'Вперёд', cur === n ? 'disabled' : '');
    if (this.status === 'active') {
      if (this.mode === 'online') {
        html += btn('draw', '½', 'Ничья', n < 2 || this.drawOffer === this.myColor ? 'disabled' : '');
        html += btn('resign', '⚑', n < 2 ? 'Отменить' : 'Сдаться');
        html += `<button data-a="chat"><span class="i">💬</span>Чат${this.unread ? '<i class="badge"></i>' : ''}</button>`;
      } else {
        html += btn('undo', '↶', 'Ход назад', n === 0 ? 'disabled' : '');
        html += btn('resign', '⚑', 'Сдаться');
      }
    } else {
      if (this.mode === 'online') html += `<button data-a="chat"><span class="i">💬</span>Чат${this.unread ? '<i class="badge"></i>' : ''}</button>`;
      html += btn('result', '🏁', 'Итог');
      html += btn('exit', '⌂', 'Меню');
    }
    bar.innerHTML = html;
    bar.querySelectorAll('button').forEach(b => b.addEventListener('click', () => this._action(b.dataset.a)));
  }

  _action(a) {
    const n = this.chess._history.length;
    const cur = this.viewPly === null ? n : this.viewPly;
    if (a === 'flip') { this.board.flip(); this._renderPlates(); haptic('select'); }
    else if (a === 'prev') { this._view(cur - 1); this._renderToolbar(); }
    else if (a === 'next') { this._view(cur + 1); this._renderToolbar(); }
    else if (a === 'draw') {
      this.o.net.send({ t: 'draw_offer' });
      if (this.drawOffer !== (this.myColor === 'w' ? 'b' : 'w')) { this.drawOffer = this.myColor; this._renderOffer(); this._renderToolbar(); }
    } else if (a === 'resign') this._confirmResign();
    else if (a === 'chat') this._openChat();
    else if (a === 'undo') this._undoAI();
    else if (a === 'result') this._showResult();
    else if (a === 'exit') this.o.onExit();
  }

  _confirmResign() {
    const abort = this.mode === 'online' && this.chess._history.length < 2;
    const s = sheet(`<h2>${abort ? 'Отменить партию?' : 'Сдаться?'}</h2>
      <p class="hint center">${abort ? 'Партия ещё не началась, рейтинг не изменится.' : this.mode === 'online' && this.rated ? 'Вы потеряете рейтинг за эту партию.' : 'Партия будет засчитана как поражение.'}</p>
      <div class="btns two"><button class="btn secondary" data-a="no">Играть дальше</button><button class="btn danger" data-a="yes">${abort ? 'Отменить' : 'Сдаться'}</button></div>`);
    s.root.querySelector('[data-a=no]').onclick = s.close;
    s.root.querySelector('[data-a=yes]').onclick = () => {
      s.close();
      if (this.mode === 'online') this.o.net.send({ t: 'resign' });
      else this._endAI('resign', this.myColor === 'w' ? '0-1' : '1-0');
    };
  }

  _openChat() {
    this.unread = 0;
    this._renderToolbar();
    const s = sheet(`<h2>Чат</h2><div class="chat-log"></div>
      <div class="quick">${QUICK.map(q => `<button>${esc(q)}</button>`).join('')}</div>
      <form class="row"><input class="search grow" maxlength="200" placeholder="Сообщение…" enterkeyhint="send"><button class="btn small">➤</button></form>`,
    { onClose: () => { this.chatSheet = null; } });
    this.chatSheet = s;
    this._renderChatLog();
    const input = s.root.querySelector('input');
    const sendText = (t) => { if (t.trim()) this.o.net.send({ t: 'chat', text: t.trim() }); };
    s.root.querySelector('form').onsubmit = (e) => { e.preventDefault(); sendText(input.value); input.value = ''; };
    s.root.querySelectorAll('.quick button').forEach(b => { b.onclick = () => sendText(b.textContent); });
  }

  _renderChatLog() {
    const log = this.chatSheet && this.chatSheet.root.querySelector('.chat-log');
    if (!log) return;
    log.innerHTML = this.chat.length
      ? this.chat.map(m => `<div class="bubble ${m.from === this.myColor ? 'mine' : ''}">${esc(m.text)}</div>`).join('')
      : '<div class="empty small">Сообщений пока нет</div>';
    log.scrollTop = log.scrollHeight;
  }

  _resultText() {
    if (this.reason === 'aborted') return { title: 'Партия отменена', kind: 'draw' };
    if (this.result === '1/2-1/2') return { title: 'Ничья', kind: 'draw' };
    const won = (this.result === '1-0') === (this.myColor === 'w');
    return won ? { title: 'Победа!', kind: 'win' } : { title: 'Поражение', kind: 'lose' };
  }

  _showResult() {
    if (this.endSheet) return;
    const { title, kind } = this._resultText();
    if (!this.endShown) {
      this.endShown = true;
      sound(kind);
      haptic(kind === 'win' ? 'success' : kind === 'lose' ? 'error' : 'warning');
    }
    let reason = REASONS[this.reason] || '';
    if (this.reason === 'abandon') {
      const won = (this.result === '1-0') === (this.myColor === 'w');
      reason = won ? 'Соперник покинул партию' : 'Вы слишком долго были не в сети';
    }
    const d = this.deltas && this.mode === 'online' && this.rated ? (this.myColor === 'w' ? this.deltas.white : this.deltas.black) : null;
    const me = this._player(this.myColor);
    const deltaHtml = d !== null && this.reason !== 'aborted'
      ? `<div class="result-delta ${d > 0 ? 'plus' : d < 0 ? 'minus' : ''}">${signed(d)} · ${me.rating + d}</div>` : '<div style="height:12px"></div>';
    const online = this.mode === 'online';
    const s = sheet(`<div class="result-title">${title}</div><div class="hint center">${esc(reason)}</div>${deltaHtml}
      <div class="btns">
        ${online && this.reason !== 'aborted' ? '<button class="btn" data-a="rematch">Реванш</button>' : ''}
        ${!online ? '<button class="btn" data-a="again">Сыграть ещё</button>' : ''}
        <div class="btns two">
          <button class="btn secondary" data-a="board">К доске</button>
          <button class="btn secondary" data-a="new">${online ? 'Новая игра' : 'Меню'}</button>
        </div>
      </div>`, { onClose: () => { this.endSheet = null; } });
    this.endSheet = s;
    const q = (a) => s.root.querySelector(`[data-a=${a}]`);
    if (q('rematch')) {
      if (this.rematchState === 'sent') { q('rematch').disabled = true; q('rematch').textContent = 'Ждём ответа соперника…'; }
      if (this.rematchState === 'offered') q('rematch').textContent = 'Принять реванш';
      q('rematch').onclick = () => {
        this.o.net.send({ t: 'rematch', gameId: this.gameId });
        if (this.rematchState !== 'offered') { this.rematchState = 'sent'; q('rematch').disabled = true; q('rematch').textContent = 'Ждём ответа соперника…'; }
      };
    }
    if (q('again')) q('again').onclick = () => { s.close(); this.startAI({ level: this.level.id, color: this.myColor === 'w' ? 'b' : 'w' }); this.endShown = false; this._saveAI(); };
    q('board').onclick = s.close;
    q('new').onclick = () => { s.close(); this.o.onExit(); };
  }

  applyRematch(m) {
    if (m.gameId !== this.gameId) return;
    if (m.from === this.o.me.id) { this.rematchState = 'sent'; return; }
    this.rematchState = 'offered';
    sound('notify');
    toast('Соперник предлагает реванш');
    if (this.endSheet) { this.endSheet.close(); this._showResult(); }
  }
}
