// Связь с сервером: REST и WebSocket с автопереподключением
export class Net {
  constructor(initData) {
    this.initData = initData;
    this.ws = null;
    this.handlers = new Map();
    this.authed = false;
    this.outbox = [];
    this.retry = 0;
    this.closedByAuth = false;
  }

  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(fn);
  }

  emit(type, msg) {
    for (const fn of this.handlers.get(type) || []) {
      try { fn(msg); } catch (e) { console.error(e); }
    }
  }

  connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      ws.send(JSON.stringify({ t: 'auth', initData: this.initData }));
    };
    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.t === 'hello') {
        this.authed = true;
        const wasOffline = this.offline;
        this.offline = false;
        this.emit('status', { online: true, reconnected: wasOffline });
        for (const m of this.outbox.splice(0)) ws.send(JSON.stringify(m));
      }
      if (msg.t === 'auth_error') this.closedByAuth = true;
      this.emit(msg.t, msg);
      this.emit('*', msg);
    };
    ws.onclose = () => {
      this.authed = false;
      if (this.closedByAuth) return;
      this.offline = true;
      this.emit('status', { online: false });
      const delay = Math.min(10_000, 500 * 2 ** this.retry++);
      setTimeout(() => this.connect(), delay);
    };
    ws.onerror = () => {};
  }

  send(msg) {
    if (this.authed && this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(msg));
    else if (['move', 'queue', 'challenge', 'challenge_accept'].includes(msg.t)) this.outbox.push(msg);
  }

  async api(path) {
    const res = await fetch(path, { headers: { 'X-Init-Data': this.initData } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Ошибка сети');
    return data;
  }
}
