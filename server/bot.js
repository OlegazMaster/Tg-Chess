// Бот: команда /start с кнопкой Mini App, ссылки-вызовы, уведомления.
import { config } from './config.js';
import { upsertUser, markBotStarted, getUser, leaderboard } from './db.js';
import { escapeHtml } from './hub.js';

export class Bot {
  constructor(hub) {
    this.hub = hub;
    this.username = '';
    this.offset = 0;
    this.stopped = false;
  }

  async api(method, body) {
    const res = await fetch(`${config.telegramApi}/bot${config.botToken}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(method === 'getUpdates' ? 65_000 : 15_000),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(`${method}: ${data.description}`);
    return data.result;
  }

  appUrl(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return config.webAppUrl + '/' + (qs ? '?' + qs : '');
  }

  async start() {
    const me = await this.api('getMe');
    this.username = me.username;
    console.log(`Бот @${this.username} запущен`);
    await this.api('setMyCommands', {
      commands: [
        { command: 'start', description: 'Открыть шахматы' },
        { command: 'top', description: 'Таблица лидеров' },
        { command: 'duel', description: 'Создать ссылку-вызов' },
      ],
    }).catch(e => console.warn(e.message));
    await this.api('setChatMenuButton', {
      menu_button: { type: 'web_app', text: 'Играть', web_app: { url: this.appUrl() } },
    }).catch(e => console.warn(e.message));
    this.poll();
  }

  async poll() {
    while (!this.stopped) {
      try {
        const updates = await this.api('getUpdates', { offset: this.offset, timeout: 50, allowed_updates: ['message'] });
        for (const u of updates) {
          this.offset = u.update_id + 1;
          this.onUpdate(u).catch(e => console.error('Ошибка в обработке апдейта', e.message));
        }
      } catch (e) {
        console.error('getUpdates:', e.message, e.cause ? `(${e.cause.code || e.cause.message})` : '');
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  }

  button(text, params) {
    return { inline_keyboard: [[{ text, web_app: { url: this.appUrl(params) } }]] };
  }

  async onUpdate(u) {
    const msg = u.message;
    if (!msg || !msg.from || msg.chat.type !== 'private' || typeof msg.text !== 'string') return;
    upsertUser(msg.from);
    markBotStarted(msg.from.id);
    const [cmd, payload = ''] = msg.text.trim().split(/\s+/, 2);

    if (cmd === '/start' && payload.startsWith('duel_')) {
      const code = payload.slice(5).replace(/[^\w-]/g, '');
      const ch = this.hub.challenges.get(code);
      if (!ch) {
        return this.api('sendMessage', {
          chat_id: msg.chat.id, text: 'Этот вызов уже недействителен. Но сыграть можно всегда!',
          reply_markup: this.button('♟ Открыть шахматы'),
        });
      }
      const from = getUser(ch.fromId);
      return this.api('sendMessage', {
        chat_id: msg.chat.id, parse_mode: 'HTML',
        text: `⚔️ <b>${escapeHtml(from.name)}</b> (${from.rating}) вызывает вас на дуэль!\nКонтроль: ${ch.tc}, ${ch.rated ? 'на рейтинг' : 'без рейтинга'}.`,
        reply_markup: this.button('Принять вызов', { join: code }),
      });
    }

    if (cmd === '/top') {
      const top = leaderboard('all', 10);
      const lines = top.map((p, i) => `${['🥇', '🥈', '🥉'][i] || (i + 1) + '.'} ${escapeHtml(p.name)} — <b>${p.rating}</b>`);
      return this.api('sendMessage', {
        chat_id: msg.chat.id, parse_mode: 'HTML',
        text: '🏆 <b>Лучшие игроки</b>\n\n' + (lines.join('\n') || 'Пока никто не сыграл ни одной рейтинговой партии.'),
        reply_markup: this.button('Открыть таблицу', { screen: 'top' }),
      });
    }

    if (cmd === '/duel') {
      return this.api('sendMessage', {
        chat_id: msg.chat.id,
        text: 'Откройте приложение и нажмите «Вызвать друга» — я сделаю ссылку, которую можно переслать.',
        reply_markup: this.button('⚔️ Вызвать друга', { screen: 'duel' }),
      });
    }

    return this.api('sendMessage', {
      chat_id: msg.chat.id, parse_mode: 'HTML',
      text: '♟ <b>Шахматы</b>\n\nИграйте онлайн на рейтинг, вызывайте друзей на дуэль и поднимайтесь в таблице лидеров. Можно потренироваться и против компьютера.',
      reply_markup: this.button('♟ Играть'),
    });
  }

  // Уведомление через бота. silentIfOnline — не слать, если игрок и так видит вызов в приложении.
  async notify(uid, html, params, silentIfOnline = false) {
    if (silentIfOnline) return;
    const u = getUser(uid);
    if (!u || !u.bot_started) return;
    try {
      await this.api('sendMessage', {
        chat_id: uid, parse_mode: 'HTML', text: html,
        reply_markup: this.button(params && params.join ? 'Принять вызов' : 'Открыть', params),
      });
    } catch (e) {
      console.warn('Уведомление не доставлено', uid, e.message);
    }
  }
}
