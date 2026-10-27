// Главный модуль Mini App: экраны, состояние, связь с сервером
import { Net } from './net.js';
import { GameView } from './gameview.js';
import { Board } from './board.js';
import { Chess } from '/shared/chess.js';
import { LEVELS } from '/shared/engine.js';
import { tg, esc, el, avatar, toast, sheet, closeAllSheets, haptic, sound, signed, ago, plural } from './ui.js';

const app = document.getElementById('app');
const TC_LABEL = { 1: 'Пуля', 2: 'Пуля', 3: 'Блиц', 5: 'Блиц', 10: 'Рапид', 15: 'Рапид', 30: 'Классика' };
const tcName = (tc) => TC_LABEL[parseInt(tc, 10)] || '';

const state = {
  me: null, online: 0, timeControls: [],
  challengesIn: new Map(), challengesOut: new Map(),
  queue: null, game: null, gameView: null, botUsername: '',
  stack: [], pendingJoin: null,
};
let net;

// ---------- запуск ----------
async function boot() {
  let initData = tg ? tg.initData : '';
  const params = new URLSearchParams(location.search);
  if (tg) {
    tg.ready();
    tg.expand();
    try { tg.disableVerticalSwipes(); } catch { /* старый клиент */ }
    try { tg.setHeaderColor('secondary_bg_color'); tg.setBackgroundColor('secondary_bg_color'); } catch { /* старый клиент */ }
    tg.BackButton.onClick(() => back());
  }
  const cfg = await fetch('/api/config').then(r => r.json()).catch(() => ({}));
  state.botUsername = cfg.botUsername || '';
  if (!initData && cfg.devMode) {
    // вход без Telegram только в режиме разработки: ?dev=ID&name=Имя
    const id = params.get('dev') || localStorage.getItem('devId') || String(1000 + Math.floor(Math.random() * 9000));
    localStorage.setItem('devId', id);
    initData = `dev:${id}:${encodeURIComponent(params.get('name') || 'Игрок ' + id)}`;
  }
  if (!initData) {
    app.innerHTML = `<div class="splash"><div class="splash-logo">♞</div>
      <b>Откройте приложение через Telegram</b><div class="hint center">Эта страница работает внутри бота${state.botUsername ? ` <a href="https://t.me/${esc(state.botUsername)}">@${esc(state.botUsername)}</a>` : ''}.</div></div>`;
    return;
  }

  const start = (tg && tg.initDataUnsafe && tg.initDataUnsafe.start_param) || '';
  if (params.get('join')) state.pendingJoin = params.get('join');
  else if (start.startsWith('duel_')) state.pendingJoin = start.slice(5);
  state.startScreen = params.get('screen') || '';

  net = new Net(initData);
  wire();
  net.connect();
}

function wire() {
  net.on('hello', (m) => {
    const first = !state.me;
    state.me = m.me; state.online = m.online; state.timeControls = m.timeControls;
    if (first) {
      if (!state.game) go(state.startScreen === 'top' ? 'top' : state.startScreen === 'duel' ? 'duel' : 'home', {}, true);
      if (state.startScreen === 'top' || state.startScreen === 'duel') state.stack.unshift({ name: 'home', props: {} });
      updateBack();
      if (state.pendingJoin) { net.send({ t: 'challenge_info', code: state.pendingJoin }); }
    } else refresh('home');
  });
  net.on('auth_error', (m) => {
    app.innerHTML = `<div class="splash"><div class="splash-logo">⚠️</div><div class="center">${esc(m.message)}</div></div>`;
  });
  net.on('status', (s) => {
    if (!s.online && state.me) toast('Нет связи с сервером. Переподключаемся…', 4000);
    if (s.online && s.reconnected) { toast('Связь восстановлена'); if (state.game) net.send({ t: 'resync' }); }
  });
  net.on('me', (m) => { state.me = m.me; refresh('home'); refresh('profile'); });
  net.on('online', (m) => { state.online = m.n; const o = document.querySelector('[data-online]'); if (o) o.textContent = onlineText(); });
  net.on('error', (m) => { toast(m.message); haptic('error'); });

  net.on('queue', (m) => {
    state.queue = m.tc ? { tc: m.tc, waiting: m.waiting, since: state.queue && state.queue.tc === m.tc ? state.queue.since : Date.now() } : null;
    renderSearch();
  });

  net.on('challenge_in', (m) => {
    const fresh = !state.challengesIn.has(m.challenge.code);
    state.challengesIn.set(m.challenge.code, m.challenge);
    refresh('home');
    if (fresh && !state.game) { sound('notify'); haptic('warning'); showIncoming(m.challenge); }
  });
  net.on('challenge_out', (m) => { state.challengesOut.set(m.challenge.code, m.challenge); refresh('home'); refresh('duel'); });
  net.on('challenge_gone', (m) => {
    const out = state.challengesOut.get(m.code);
    state.challengesIn.delete(m.code);
    state.challengesOut.delete(m.code);
    if (out && m.reason === 'declined') toast('Соперник отклонил вызов');
    if (out && m.reason === 'expired') toast('Срок вызова истёк');
    if (state.incoming && state.incoming.code === m.code && m.reason !== 'accepted') { state.incoming.close(); toast('Вызов отменён'); }
    refresh('home'); refresh('duel');
  });
  net.on('challenge_info', (m) => {
    state.pendingJoin = null;
    if (!m.challenge) return toast('Этот вызов уже недействителен');
    if (m.challenge.from.id === state.me.id) return toast('Это ваш вызов — отправьте ссылку другу');
    showIncoming(m.challenge);
  });

  net.on('game', (m) => {
    const g = m.game;
    const isNew = !state.game || state.game.id !== g.id;
    state.queue = null;
    if (isNew) closeAllSheets();
    state.game = g;
    if (isNew) {
      sound('start'); haptic('success');
      const view = new GameView({
        mode: 'online', me: state.me, net,
        onExit: () => leaveGame(), onProfile: (id) => go('profile', { id }),
      });
      view.loadSnapshot(g);
      state.gameView = view;
      go('game', {}, true);
      state.stack = [{ name: 'home', props: {} }, { name: 'game', props: {} }];
      updateBack();
    } else if (state.gameView) {
      state.gameView.loadSnapshot(g);
    }
  });
  net.on('nogame', () => { if (state.game && state.game.status === 'active') { state.game = null; } });
  net.on('move', (m) => { if (state.gameView && state.gameView.gameId === m.gameId) state.gameView.applyMove(m); });
  net.on('draw', (m) => { if (state.gameView && state.gameView.gameId === m.gameId) state.gameView.applyDraw(m); });
  net.on('chat', (m) => { if (state.gameView && state.gameView.gameId === m.gameId) state.gameView.applyChat(m); });
  net.on('presence', (m) => { if (state.gameView && state.gameView.gameId === m.gameId) state.gameView.applyPresence(m); });
  net.on('rematch', (m) => { if (state.gameView) state.gameView.applyRematch(m); });
  net.on('end', (m) => {
    if (state.game && state.game.id === m.gameId) state.game.status = 'ended';
    if (state.gameView && state.gameView.gameId === m.gameId) state.gameView.applyEnd(m);
  });
}

function onlineText() {
  return `${state.online} ${plural(state.online, 'игрок', 'игрока', 'игроков')} онлайн`;
}

// ---------- навигация ----------
let current = null;
function go(name, props = {}, replace = false) {
  if (current && current.name === 'game' && name !== 'game' && state.gameView && state.gameView.mode === 'ai') {
    // партия с компьютером сохраняется в localStorage
  }
  if (replace) state.stack = [{ name, props }];
  else state.stack.push({ name, props });
  render(name, props);
  updateBack();
}

function back() {
  if (state.stack.length <= 1) return;
  state.stack.pop();
  const top = state.stack[state.stack.length - 1];
  render(top.name, top.props);
  updateBack();
}

function updateBack() {
  if (!tg) return;
  if (state.stack.length > 1) tg.BackButton.show(); else tg.BackButton.hide();
}

function render(name, props) {
  if (current && current.view) current.view.unmount();
  current = { name, props };
  window.scrollTo(0, 0);
  const fn = SCREENS[name] || SCREENS.home;
  fn(props);
}

function refresh(name) {
  if (current && current.name === name) SCREENS[name](current.props, true);
}

function leaveGame() {
  const view = state.gameView;
  if (view && view.mode === 'online' && view.status !== 'active') { state.game = null; state.gameView = null; }
  if (view && view.mode === 'ai') state.gameView = null;
  go('home', {}, true);
}

// ---------- экраны ----------
const SCREENS = {
  home(props, isRefresh) {
    const me = state.me;
    const ins = [...state.challengesIn.values()];
    const outs = [...state.challengesOut.values()];
    const aiSaved = loadAISaved();
    const activeOnline = state.game && state.game.status === 'active';
    const node = el(`<div class="screen">
      <div class="me-head">
        ${avatar(me, 'lg')}
        <div class="grow">
          <div class="name ellipsis">${esc(me.name)}</div>
          <div class="row" style="gap:8px;margin-top:4px">
            <span class="rating-pill">★ ${me.rating}</span>
            ${me.rank ? `<span class="hint small">#${me.rank} в рейтинге</span>` : '<span class="hint small">ещё нет рейтинговых партий</span>'}
          </div>
          <div class="hint small" style="margin-top:4px"><span class="online-dot"></span> <span data-online>${onlineText()}</span></div>
        </div>
      </div>
      ${activeOnline ? '<button class="banner" data-a="resume">♟ <span class="grow">Вернуться к партии</span> ›</button>' : ''}
      ${ins.length ? `<div class="card"><h3>Вам бросили вызов</h3>${ins.map(c => challengeRow(c, 'in')).join('')}</div>` : ''}
      <div class="card">
        <h3>Быстрая игра на рейтинг</h3>
        <div class="tc-grid">${state.timeControls.slice(0, 9).map(tc => `<button class="tc" data-tc="${tc}"><b>${tc}</b><span>${tcName(tc)}</span></button>`).join('')}</div>
      </div>
      <div class="card" style="padding:4px 14px">
        ${menuItem('duel', '⚔️', 'Вызвать друга', 'Ссылка-приглашение или вызов игроку')}
        ${menuItem('ai', '🤖', aiSaved ? 'Продолжить с компьютером' : 'Играть с компьютером', aiSaved ? `Партия сохранена · ${aiSaved.moves.length} ${plural(aiSaved.moves.length, 'ход', 'хода', 'ходов')}` : 'Тренировка, 4 уровня сложности')}
        ${menuItem('top', '🏆', 'Таблица лидеров', 'Лучшие игроки и прирост за неделю')}
        ${menuItem('profile', '👤', 'Мой профиль', 'Статистика и история партий')}
      </div>
      ${outs.length ? `<div class="card"><h3>Мои вызовы</h3>${outs.map(c => challengeRow(c, 'out')).join('')}</div>` : ''}
      <div class="center hint small" style="margin-top:14px"><button data-a="sound">${localStorage.getItem('sound') === 'off' ? '🔇 Звук выключен' : '🔊 Звук включён'}</button></div>
    </div>`);
    node.querySelectorAll('[data-tc]').forEach(b => b.onclick = () => startSearch(b.dataset.tc));
    node.querySelectorAll('[data-go]').forEach(b => b.onclick = () => {
      if (b.dataset.go === 'ai' && aiSaved) return resumeAI(aiSaved);
      go(b.dataset.go, b.dataset.go === 'profile' ? { id: me.id } : {});
    });
    const resume = node.querySelector('[data-a=resume]');
    if (resume) resume.onclick = () => { go('game', {}); };
    node.querySelector('[data-a=sound]').onclick = () => {
      localStorage.setItem('sound', localStorage.getItem('sound') === 'off' ? 'on' : 'off');
      refresh('home');
    };
    bindChallengeRows(node);
    app.replaceChildren(node);
  },

  duel(props) {
    const s = state.duelForm || (state.duelForm = { tc: '5+0', rated: true, color: 'random' });
    const outs = [...state.challengesOut.values()].filter(c => !c.to);
    const node = el(`<div class="screen">
      <div class="card">
        <h3>Ссылка-приглашение</h3>
        <div class="field"><label>Контроль времени</label>
          <div class="tc-grid">${state.timeControls.map(tc => `<button class="tc ${tc === s.tc ? 'on' : ''}" data-tc="${tc}"><b>${tc}</b><span>${tcName(tc)}</span></button>`).join('')}</div></div>
        <div class="field"><label>Партия</label>
          <div class="seg" data-seg="rated"><button data-v="1" class="${s.rated ? 'on' : ''}">На рейтинг</button><button data-v="0" class="${!s.rated ? 'on' : ''}">Товарищеская</button></div></div>
        <div class="field"><label>Мой цвет</label>
          <div class="seg" data-seg="color"><button data-v="w" class="${s.color === 'w' ? 'on' : ''}">Белые</button><button data-v="random" class="${s.color === 'random' ? 'on' : ''}">Случайно</button><button data-v="b" class="${s.color === 'b' ? 'on' : ''}">Чёрные</button></div></div>
        <button class="btn" data-a="create">Создать вызов и отправить</button>
      </div>
      ${outs.length ? `<div class="card"><h3>Активные ссылки</h3>${outs.map(c => challengeRow(c, 'out')).join('')}</div>` : ''}
      <div class="card">
        <h3>Вызвать игрока</h3>
        <input class="search" placeholder="Поиск по имени или @username" data-a="q">
        <div class="plist" data-list style="margin-top:6px"><div class="empty small">Загрузка…</div></div>
      </div>
    </div>`);
    node.querySelectorAll('[data-tc]').forEach(b => b.onclick = () => { s.tc = b.dataset.tc; haptic('select'); SCREENS.duel(props); });
    node.querySelectorAll('[data-seg] button').forEach(b => b.onclick = () => {
      const key = b.parentElement.dataset.seg;
      s[key] = key === 'rated' ? b.dataset.v === '1' : b.dataset.v;
      haptic('select'); SCREENS.duel(props);
    });
    node.querySelector('[data-a=create]').onclick = () => {
      state.wantShare = true;
      net.send({ t: 'challenge', tc: s.tc, rated: s.rated, color: s.color });
    };
    bindChallengeRows(node);
    const list = node.querySelector('[data-list]');
    const input = node.querySelector('[data-a=q]');
    const showList = (items, emptyText) => {
      list.innerHTML = items.length ? items.map(u => `<button class="prow" data-uid="${u.id}">${avatar(u, 'sm', u.online)}
        <div class="grow ellipsis">${esc(u.name)}${u.playing ? ' <span class="hint small">· играет</span>' : ''}</div><span class="val">${u.rating}</span></button>`).join('')
        : `<div class="empty small">${emptyText}</div>`;
      list.querySelectorAll('[data-uid]').forEach(b => b.onclick = () => challengePlayer(items.find(u => String(u.id) === b.dataset.uid)));
    };
    const loadOnline = () => net.api('/api/online').then(r => showList(r.list, 'Сейчас больше никого нет онлайн. Отправьте другу ссылку!')).catch(e => showList([], esc(e.message)));
    let t;
    input.oninput = () => {
      clearTimeout(t);
      const q = input.value.trim();
      if (q.length < 2) return loadOnline();
      t = setTimeout(() => net.api('/api/search?q=' + encodeURIComponent(q)).then(r => showList(r.list, 'Никого не нашли')).catch(() => {}), 300);
    };
    loadOnline();
    app.replaceChildren(node);
    // после создания вызова сразу открываем «Поделиться»
    if (state.wantShare && outs.length) {
      state.wantShare = false;
      shareChallenge(outs.sort((a, b) => b.createdAt - a.createdAt)[0]);
    }
  },

  ai() {
    const s = state.aiForm || (state.aiForm = { level: 2, color: 'w' });
    const node = el(`<div class="screen">
      <div class="card"><h3>Сложность</h3>
        ${LEVELS.map(l => `<button class="level ${l.id === s.level ? 'on' : ''}" data-l="${l.id}"><b>${esc(l.name)}</b><span class="stars">${'★'.repeat(l.id)}${'☆'.repeat(4 - l.id)}</span></button>`).join('')}
      </div>
      <div class="card"><h3>Играю за</h3>
        <div class="seg" data-seg="color"><button data-v="w" class="${s.color === 'w' ? 'on' : ''}">Белых</button><button data-v="random" class="${s.color === 'random' ? 'on' : ''}">Случайно</button><button data-v="b" class="${s.color === 'b' ? 'on' : ''}">Чёрных</button></div>
      </div>
      <button class="btn" data-a="go">Начать партию</button>
      <p class="hint small center">Партии с компьютером не влияют на рейтинг.</p>
    </div>`);
    node.querySelectorAll('[data-l]').forEach(b => b.onclick = () => { s.level = +b.dataset.l; haptic('select'); SCREENS.ai(); });
    node.querySelectorAll('[data-seg] button').forEach(b => b.onclick = () => { s.color = b.dataset.v; haptic('select'); SCREENS.ai(); });
    node.querySelector('[data-a=go]').onclick = () => {
      const color = s.color === 'random' ? (Math.random() < 0.5 ? 'w' : 'b') : s.color;
      startAIGame({ level: s.level, color, moves: [] });
    };
    app.replaceChildren(node);
  },

  game() {
    const view = state.gameView;
    if (!view) return go('home', {}, true);
    current.view = view;
    view.mount(app);
  },

  async top(props, isRefresh) {
    const period = props.period || 'all';
    const node = el(`<div class="screen">
      <div class="seg tabs"><button data-p="all" class="${period === 'all' ? 'on' : ''}">По рейтингу</button><button data-p="week" class="${period === 'week' ? 'on' : ''}">Прирост за неделю</button></div>
      <div class="card" style="padding:6px 10px"><div class="plist" data-list><div class="empty">Загрузка…</div></div></div>
      <div data-me></div>
    </div>`);
    node.querySelectorAll('[data-p]').forEach(b => b.onclick = () => {
      haptic('select');
      state.stack[state.stack.length - 1].props = { period: b.dataset.p };
      SCREENS.top({ period: b.dataset.p });
    });
    app.replaceChildren(node);
    try {
      const r = await net.api('/api/leaderboard?period=' + period);
      if (!node.isConnected) return;
      const list = node.querySelector('[data-list]');
      const medal = (i) => ['🥇', '🥈', '🥉'][i];
      list.innerHTML = r.list.length ? r.list.map((u, i) => `<button class="prow ${u.id === state.me.id ? 'me' : ''}" data-uid="${u.id}">
          <span class="place ${i < 3 ? 'medal' : ''}">${medal(i) || i + 1}</span>${avatar(u, 'sm', u.online)}
          <div class="grow"><div class="ellipsis">${esc(u.name)}</div><div class="hint small">${period === 'week' ? `${u.games} ${plural(u.games, 'партия', 'партии', 'партий')} · ${u.wins} ${plural(u.wins, 'победа', 'победы', 'побед')}` : `${u.games} ${plural(u.games, 'партия', 'партии', 'партий')}`}</div></div>
          <span class="val ${period === 'week' ? (u.gain > 0 ? 'plus' : u.gain < 0 ? 'minus' : '') : ''}">${period === 'week' ? signed(u.gain) : u.rating}</span></button>`).join('')
        : `<div class="empty">${period === 'week' ? 'На этой неделе рейтинговых партий ещё не было' : 'Пока никто не сыграл рейтинговую партию. Станьте первым!'}</div>`;
      list.querySelectorAll('[data-uid]').forEach(b => b.onclick = () => go('profile', { id: +b.dataset.uid }));
      const inList = r.list.some(u => u.id === state.me.id);
      if (period === 'all' && !inList) {
        node.querySelector('[data-me]').innerHTML = `<div class="sticky-me"><div class="prow me"><span class="place">${r.me.rank || '—'}</span>${avatar(state.me, 'sm')}
          <div class="grow ellipsis">Вы</div><span class="val">${state.me.rating}</span></div></div>`;
      }
    } catch (e) {
      node.querySelector('[data-list]').innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    }
  },

  async profile(props) {
    const id = props.id || state.me.id;
    const mine = id === state.me.id;
    const node = el('<div class="screen"><div class="empty">Загрузка…</div></div>');
    app.replaceChildren(node);
    let p;
    try { p = await net.api('/api/user/' + id); } catch (e) { node.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
    if (!node.isConnected) return;
    const total = p.wins + p.draws + p.losses || 1;
    const pct = (n) => (n / total * 100).toFixed(1) + '%';
    node.innerHTML = `
      <div class="card center">
        <div style="display:grid;place-items:center;margin-bottom:8px">${avatar(p, 'lg', p.online && !mine)}</div>
        <div style="font-size:20px;font-weight:700">${esc(p.name)}</div>
        ${p.username ? `<div class="hint small">@${esc(p.username)}</div>` : ''}
        <div class="hint small">${mine ? '' : p.playing ? 'Сейчас играет' : p.online ? 'В сети' : 'Был ' + ago(p.lastSeen)}</div>
        <div style="font-size:34px;font-weight:800;margin-top:6px">${p.rating}</div>
        <div class="hint small">${p.rank ? `#${p.rank} в рейтинге · ` : ''}пик ${p.peak}</div>
        ${p.history.length > 2 ? sparkline(p.history) : ''}
      </div>
      <div class="card">
        <div class="stats"><div><b class="plus">${p.wins}</b><span>${plural(p.wins, 'победа', 'победы', 'побед')}</span></div><div><b>${p.draws}</b><span>${plural(p.draws, 'ничья', 'ничьи', 'ничьих')}</span></div><div><b class="minus">${p.losses}</b><span>${plural(p.losses, 'поражение', 'поражения', 'поражений')}</span></div></div>
        <div class="wdl"><i style="width:${pct(p.wins)};background:var(--win)"></i><i style="width:${pct(p.draws)};background:var(--hint)"></i><i style="width:${pct(p.losses)};background:var(--danger)"></i></div>
        ${p.h2h && (p.h2h.wins + p.h2h.draws + p.h2h.losses) ? `<div class="hint small center" style="margin-top:8px">Ваши личные встречи: ${p.h2h.wins} – ${p.h2h.draws} – ${p.h2h.losses}</div>` : ''}
      </div>
      ${!mine ? `<button class="btn" data-a="challenge" style="margin-bottom:10px">⚔️ Вызвать на дуэль</button>` : ''}
      <div class="card"><h3>Последние партии</h3>${p.recent.length ? p.recent.map(g => gameRow(g, id)).join('') : '<div class="empty small">Партий пока нет</div>'}</div>`;
    const ch = node.querySelector('[data-a=challenge]');
    if (ch) ch.onclick = () => challengePlayer(p);
    node.querySelectorAll('[data-game]').forEach(b => b.onclick = () => go('review', { id: b.dataset.game }));
  },

  async review(props) {
    const node = el('<div class="screen"><div class="empty">Загрузка…</div></div>');
    app.replaceChildren(node);
    let g;
    try { g = await net.api('/api/game/' + props.id); } catch (e) { node.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
    if (!node.isConnected) return;
    const chess = new Chess();
    const text = g.pgn.replace(/\[[^\]]*\]/g, '').replace(/\d+\.(\.\.)?/g, ' ').replace(/(1-0|0-1|1\/2-1\/2|\*)\s*$/, '');
    for (const san of text.split(/\s+/).filter(Boolean)) if (!chess.move(san)) break;
    const hist = chess.history({ verbose: true });
    const myColor = g.black.id === state.me.id ? 'b' : 'w';
    let ply = hist.length;
    node.innerHTML = `<div class="game">
      <div class="plate">${avatar({ id: g[myColor === 'w' ? 'black' : 'white'].id, name: g[myColor === 'w' ? 'black' : 'white'].name })}<div class="who"><b>${esc(g[myColor === 'w' ? 'black' : 'white'].name)} <span class="hint">${g[myColor === 'w' ? 'black' : 'white'].rating}</span></b></div></div>
      <div class="bd"></div>
      <div class="plate">${avatar({ id: g[myColor].id, name: g[myColor].name })}<div class="who"><b>${esc(g[myColor].name)} <span class="hint">${g[myColor].rating}</span></b></div></div>
      <div class="status-line">${esc(g.result)} · ${esc(g.tc)} · ${g.rated ? 'рейтинговая' : 'товарищеская'}</div>
      <div class="moves"></div>
      <div class="toolbar"><button data-a="first"><span class="i">⏮</span>Начало</button><button data-a="prev"><span class="i">◀</span>Назад</button><button data-a="next"><span class="i">▶</span>Вперёд</button><button data-a="last"><span class="i">⏭</span>Конец</button><button data-a="copy"><span class="i">📋</span>PGN</button></div>
    </div>`;
    const board = new Board(node.querySelector('.bd'), { legal: () => [] });
    board.setOrientation(myColor);
    const moves = node.querySelector('.moves');
    const show = (animate = true) => {
      const c = new Chess();
      for (let i = 0; i < ply; i++) c.move(hist[i].san);
      const last = hist[ply - 1];
      board.setPosition(c.fen(), { lastMove: last ? { from: last.from, to: last.to } : null, animate });
      moves.innerHTML = hist.map((m, i) => `${i % 2 === 0 ? `<span class="n">${i / 2 + 1}.</span>` : ''}<button data-ply="${i + 1}" class="${i + 1 === ply ? 'cur' : ''}">${esc(m.san)}</button>`).join('');
      moves.querySelectorAll('button').forEach(b => b.onclick = () => { ply = +b.dataset.ply; show(); });
      const cur = moves.querySelector('.cur');
      if (cur) cur.scrollIntoView({ inline: 'center', block: 'nearest' });
    };
    show(false);
    node.querySelectorAll('.toolbar button').forEach(b => b.onclick = () => {
      const a = b.dataset.a;
      if (a === 'copy') {
        navigator.clipboard.writeText(g.pgn).then(() => toast('PGN скопирован'), () => toast('Не удалось скопировать'));
        return;
      }
      ply = a === 'first' ? 0 : a === 'last' ? hist.length : a === 'prev' ? Math.max(0, ply - 1) : Math.min(hist.length, ply + 1);
      haptic('select');
      show();
    });
  },
};

// ---------- части экранов ----------
function menuItem(go, ico, title, sub) {
  return `<button class="menu-item" data-go="${go}"><span class="ico">${ico}</span><span class="grow"><b>${esc(title)}</b><span class="hint small">${esc(sub)}</span></span><span class="chev">›</span></button>`;
}

function challengeRow(c, dir) {
  const who = dir === 'in' ? c.from : c.to;
  const label = dir === 'in' ? `${esc(c.from.name)} <span class="hint">${c.from.rating}</span>` : who ? `Вызов: ${esc(who.name)}` : 'Ссылка-приглашение';
  const meta = `${c.tc} · ${c.rated ? 'на рейтинг' : 'товарищеская'}`;
  const btns = dir === 'in'
    ? `<button class="btn small secondary" data-ch-decline="${c.code}">✕</button><button class="btn small" data-ch-accept="${c.code}">Принять</button>`
    : `${!c.to ? `<button class="btn small secondary" data-ch-share="${c.code}">Отправить</button>` : ''}<button class="btn small secondary" data-ch-cancel="${c.code}">✕</button>`;
  return `<div class="challenge ${dir}">${dir === 'in' ? avatar(c.from, 'sm') : '<span style="font-size:22px">⚔️</span>'}
    <div class="grow"><div class="ellipsis">${label}</div><div class="hint small">${meta}</div></div>${btns}</div>`;
}

function bindChallengeRows(node) {
  node.querySelectorAll('[data-ch-accept]').forEach(b => b.onclick = () => net.send({ t: 'challenge_accept', code: b.dataset.chAccept }));
  node.querySelectorAll('[data-ch-decline]').forEach(b => b.onclick = () => net.send({ t: 'challenge_decline', code: b.dataset.chDecline }));
  node.querySelectorAll('[data-ch-cancel]').forEach(b => b.onclick = () => net.send({ t: 'challenge_cancel', code: b.dataset.chCancel }));
  node.querySelectorAll('[data-ch-share]').forEach(b => b.onclick = () => shareChallenge(state.challengesOut.get(b.dataset.chShare)));
}

function gameRow(g, uid) {
  const color = g.white.id === uid ? 'white' : 'black';
  const opp = color === 'white' ? g.black : g.white;
  const res = g.result === '1/2-1/2' ? 'd' : (g.result === '1-0') === (color === 'white') ? 'w' : 'l';
  const d = g[color].delta;
  return `<button class="game-row" data-game="${esc(g.id)}"><span class="res ${res}">${{ w: 'В', l: 'П', d: 'Н' }[res]}</span>
    <div class="grow"><div class="ellipsis">${color === 'white' ? '⚪' : '⚫'} ${esc(opp.name)} <span class="hint small">${opp.rating}</span></div>
    <div class="hint small">${esc(g.tc)} · ${ago(g.endedAt)}</div></div>
    ${g.rated ? `<span class="val ${d > 0 ? 'plus' : d < 0 ? 'minus' : ''}">${signed(d)}</span>` : '<span class="hint small">без рейтинга</span>'}</button>`;
}

function sparkline(vals) {
  const w = 300, h = 70, pad = 6;
  const min = Math.min(...vals), max = Math.max(...vals);
  const span = max - min || 1;
  const pts = vals.map((v, i) => `${(pad + i / (vals.length - 1) * (w - pad * 2)).toFixed(1)},${(h - pad - (v - min) / span * (h - pad * 2)).toFixed(1)}`).join(' ');
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><polyline points="${pts}" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linejoin="round" vector-effect="non-scaling-stroke"/></svg>`;
}

// ---------- действия ----------
function startSearch(tc) {
  if (state.game && state.game.status === 'active') return toast('Сначала завершите текущую партию');
  haptic('light');
  state.queue = { tc, waiting: 1, since: Date.now() };
  net.send({ t: 'queue', tc });
  renderSearch();
}

function renderSearch() {
  if (!state.queue) { if (state.searchSheet) state.searchSheet.close(); return; }
  if (!state.searchSheet) {
    state.searchSheet = sheet('<div class="searching"><div class="spinner"></div><h2 data-t></h2><div class="hint" data-w></div><div class="hint small" data-s></div></div><button class="btn secondary" data-a="cancel">Отменить поиск</button>', {
      onClose: () => {
        state.searchSheet = null;
        clearInterval(state.searchTimer);
        if (state.queue) { net.send({ t: 'unqueue' }); state.queue = null; }
      },
    });
    state.searchSheet.root.querySelector('[data-a=cancel]').onclick = () => state.searchSheet.close();
    state.searchTimer = setInterval(() => {
      const s = state.searchSheet && state.searchSheet.root.querySelector('[data-s]');
      if (s && state.queue) s.textContent = `Ищем ${Math.floor((Date.now() - state.queue.since) / 1000)} с`;
    }, 500);
  }
  const r = state.searchSheet.root;
  r.querySelector('[data-t]').textContent = `Поиск соперника · ${state.queue.tc}`;
  const others = Math.max(0, (state.queue.waiting || 1) - 1);
  r.querySelector('[data-w]').textContent = others ? `В очереди ещё ${others}` : 'Подбираем соперника с близким рейтингом';
}

function showIncoming(c) {
  if (state.incoming) state.incoming.close();
  const s = sheet(`<div class="center" style="display:grid;place-items:center;gap:6px">${avatar(c.from, 'lg')}
      <h2 style="margin:6px 0 0">${esc(c.from.name)}</h2><div class="hint">Рейтинг ${c.from.rating}</div></div>
    <p class="center">вызывает вас на дуэль<br><b>${esc(c.tc)}</b> · ${c.rated ? 'на рейтинг' : 'товарищеская'}${c.color !== 'random' ? ` · вы играете ${c.color === 'w' ? 'чёрными' : 'белыми'}` : ''}</p>
    ${!c.fromOnline ? '<p class="hint small center">Соперник сейчас не в приложении — мы пришлём ему уведомление.</p>' : ''}
    <div class="btns two"><button class="btn secondary" data-a="no">Отклонить</button><button class="btn" data-a="yes">Принять</button></div>`,
  { onClose: () => { state.incoming = null; } });
  s.code = c.code;
  state.incoming = s;
  s.root.querySelector('[data-a=yes]').onclick = () => net.send({ t: 'challenge_accept', code: c.code });
  s.root.querySelector('[data-a=no]').onclick = () => {
    if (c.to) net.send({ t: 'challenge_decline', code: c.code });
    s.close();
  };
}

function challengePlayer(u) {
  if (!u) return;
  const f = { tc: (state.duelForm && state.duelForm.tc) || '5+0', rated: true };
  const s = sheet(`<h2>Вызов: ${esc(u.name)}</h2>
    <div class="field"><label>Контроль времени</label><div class="tc-grid">${state.timeControls.map(tc => `<button class="tc ${tc === f.tc ? 'on' : ''}" data-tc="${tc}"><b>${tc}</b><span>${tcName(tc)}</span></button>`).join('')}</div></div>
    <div class="field"><div class="seg"><button data-r="1" class="on">На рейтинг</button><button data-r="0">Товарищеская</button></div></div>
    <button class="btn" data-a="send">⚔️ Бросить вызов</button>`);
  s.root.querySelectorAll('[data-tc]').forEach(b => b.onclick = () => {
    f.tc = b.dataset.tc;
    s.root.querySelectorAll('[data-tc]').forEach(x => x.classList.toggle('on', x === b));
  });
  s.root.querySelectorAll('[data-r]').forEach(b => b.onclick = () => {
    f.rated = b.dataset.r === '1';
    s.root.querySelectorAll('[data-r]').forEach(x => x.classList.toggle('on', x === b));
  });
  s.root.querySelector('[data-a=send]').onclick = () => {
    net.send({ t: 'challenge', to: u.id, tc: f.tc, rated: f.rated });
    s.close();
    toast(`Вызов отправлен: ${u.name}`);
    haptic('success');
  };
}

function shareChallenge(c) {
  if (!c) return;
  const link = c.link || `${location.origin}/?join=${c.code}`;
  const text = `⚔️ Вызываю тебя на шахматную дуэль! ${c.tc}, ${c.rated ? 'на рейтинг' : 'товарищеская'}.`;
  const s = sheet(`<h2>Вызов создан</h2>
    <p class="hint center">Отправьте ссылку другу. Как только он её откроет и примет вызов, партия начнётся.</p>
    <div class="search small" style="margin-bottom:10px;word-break:break-all;-webkit-user-select:all;user-select:all">${esc(link)}</div>
    <div class="btns"><button class="btn" data-a="tg">Отправить в Telegram</button><button class="btn secondary" data-a="copy">Скопировать ссылку</button></div>`);
  s.root.querySelector('[data-a=tg]').onclick = () => {
    const url = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(text)}`;
    if (tg) tg.openTelegramLink(url); else window.open(url, '_blank');
    s.close();
  };
  s.root.querySelector('[data-a=copy]').onclick = () => {
    navigator.clipboard.writeText(link).then(() => toast('Ссылка скопирована'), () => toast('Скопируйте ссылку вручную'));
  };
}

// ---------- партия с компьютером ----------
function loadAISaved() {
  try {
    const s = JSON.parse(localStorage.getItem('aiGame') || 'null');
    return s && Array.isArray(s.moves) ? s : null;
  } catch { return null; }
}

function startAIGame({ level, color, moves }) {
  const view = new GameView({ mode: 'ai', me: state.me, net, onExit: () => leaveGame(), onProfile: null });
  view.startAI({ level, color, moves });
  view._saveAI();
  state.gameView = view;
  state.stack = [{ name: 'home', props: {} }];
  go('game');
}

function resumeAI(saved) {
  const s = sheet(`<h2>Партия с компьютером</h2><p class="hint center">У вас есть незаконченная партия.</p>
    <div class="btns"><button class="btn" data-a="go">Продолжить</button><button class="btn secondary" data-a="new">Новая партия</button></div>`);
  s.root.querySelector('[data-a=go]').onclick = () => { s.close(); startAIGame(saved); };
  s.root.querySelector('[data-a=new]').onclick = () => { s.close(); localStorage.removeItem('aiGame'); go('ai'); };
}

boot();
