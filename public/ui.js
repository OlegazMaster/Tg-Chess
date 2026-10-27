// Мелкие помощники интерфейса
export const tg = window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.initData ? window.Telegram.WebApp : null;

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

const COLORS = ['#e17076', '#7bc862', '#65aadd', '#a695e7', '#ee7aae', '#6ec9cb', '#faa774'];
export function avatar(u, cls = '', online = false) {
  const name = (u && u.name) || '?';
  const color = COLORS[Math.abs(Number(u && u.id) || 0) % COLORS.length];
  const letter = esc([...name.trim()][0] || '?').toUpperCase();
  const img = u && u.photo ? `<img src="${esc(u.photo)}" alt="" loading="lazy" onerror="this.remove()">` : '';
  return `<div class="avatar ${cls}" style="background:${color}">${letter}${img}${online ? '<i class="on"></i>' : ''}</div>`;
}

let toastTimer;
export function toast(text, ms = 2600) {
  const t = document.getElementById('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

// Нижняя шторка. Возвращает { root, close }
const openSheets = new Set();
export function sheet(html, { onClose, dismissable = true } = {}) {
  const shade = el(`<div class="sheet-shade"><div class="sheet"><div class="grip"></div>${html}</div></div>`);
  let closed = false;
  const handle = { root: shade.querySelector('.sheet'), close: null };
  const close = () => {
    if (closed) return;
    closed = true;
    openSheets.delete(handle);
    shade.remove();
    onClose && onClose();
  };
  handle.close = close;
  if (dismissable) shade.addEventListener('click', (e) => { if (e.target === shade) close(); });
  document.body.append(shade);
  openSheets.add(handle);
  return handle;
}

export function closeAllSheets() {
  for (const s of [...openSheets]) s.close();
}

export function haptic(kind = 'light') {
  try {
    const h = tg && tg.HapticFeedback;
    if (!h) return;
    if (['success', 'error', 'warning'].includes(kind)) h.notificationOccurred(kind);
    else if (kind === 'select') h.selectionChanged();
    else h.impactOccurred(kind);
  } catch { /* старый клиент */ }
}

export function fmtClock(ms) {
  ms = Math.max(0, ms);
  if (ms < 10_000) {
    const s = Math.floor(ms / 1000), t = Math.floor((ms % 1000) / 100);
    return `0:0${s}.${t}`;
  }
  const total = Math.ceil(ms / 1000);
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
}

export function plural(n, one, few, many) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

export function ago(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'только что';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} ${plural(m, 'минуту', 'минуты', 'минут')} назад`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} ${plural(h, 'час', 'часа', 'часов')} назад`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} ${plural(d, 'день', 'дня', 'дней')} назад`;
  return new Date(ts).toLocaleDateString('ru-RU');
}

export const signed = (n) => (n > 0 ? '+' + n : String(n));

// Короткие звуки без файлов
let audio;
export function sound(kind) {
  if (localStorage.getItem('sound') === 'off') return;
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    const now = audio.currentTime;
    const tone = (freq, start, dur, vol = 0.18, type = 'sine') => {
      const o = audio.createOscillator(), g = audio.createGain();
      o.type = type; o.frequency.value = freq;
      g.gain.setValueAtTime(0, now + start);
      g.gain.linearRampToValueAtTime(vol, now + start + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, now + start + dur);
      o.connect(g).connect(audio.destination);
      o.start(now + start); o.stop(now + start + dur + 0.02);
    };
    if (kind === 'move') tone(520, 0, 0.07, 0.16, 'triangle');
    else if (kind === 'capture') { tone(300, 0, 0.09, 0.22, 'triangle'); tone(220, 0.03, 0.08, 0.15, 'triangle'); }
    else if (kind === 'check') { tone(880, 0, 0.09, 0.14); tone(660, 0.08, 0.12, 0.12); }
    else if (kind === 'start') { tone(523, 0, 0.12); tone(659, 0.1, 0.12); tone(784, 0.2, 0.18); }
    else if (kind === 'win') { tone(523, 0, 0.12); tone(659, 0.1, 0.12); tone(784, 0.2, 0.12); tone(1047, 0.3, 0.3); }
    else if (kind === 'lose') { tone(392, 0, 0.18); tone(330, 0.15, 0.18); tone(262, 0.3, 0.35); }
    else if (kind === 'draw') { tone(440, 0, 0.15); tone(440, 0.18, 0.2); }
    else if (kind === 'notify') { tone(740, 0, 0.1); tone(988, 0.1, 0.16); }
  } catch { /* звук недоступен */ }
}
