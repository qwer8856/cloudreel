import { AppError, safeError } from './validation.mjs';

const EVENTS = ['completed', 'failed', 'quota', 'auth'];
export class Notifications {
  constructor({ state, save, now = Date.now }) {
    Object.assign(this, { state, save, now });
    state.notifications ||= {
      enabled: false,
      channel: 'webhook',
      events: EVENTS,
      url: '',
      token: '',
      chatId: '',
    };
    state.notificationHistory ||= [];
    state.notificationQueue ||= [];
  }
  view() {
    const config = this.state.notifications;
    return {
      enabled: config.enabled,
      channel: config.channel,
      events: config.events,
      chatId: config.chatId,
      urlSaved: Boolean(config.url),
      tokenSaved: Boolean(config.token),
      history: this.state.notificationHistory.slice(-50).reverse(),
      pending: this.state.notificationQueue.length,
    };
  }
  configure(input) {
    const current = this.state.notifications;
    if (
      typeof input.enabled !== 'boolean' ||
      !['webhook', 'telegram'].includes(input.channel) ||
      !Array.isArray(input.events) ||
      input.events.some((event) => !EVENTS.includes(event))
    )
      throw new AppError('通知设置无效。');
    const config = {
      enabled: input.enabled,
      channel: input.channel,
      events: [...new Set(input.events)],
      url: input.url || current.url || '',
      token: input.token || current.token || '',
      chatId: String(input.chatId ?? current.chatId ?? '').trim(),
    };
    if (config.url) {
      try {
        const url = new URL(config.url);
        if (
          !['http:', 'https:'].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.hash ||
          config.url.length > 2048
        )
          throw new Error();
      } catch {
        throw new AppError('Webhook 需使用有效的 HTTP/HTTPS 地址。');
      }
    }
    if (config.token && !/^\d+:[A-Za-z0-9_-]+$/.test(config.token))
      throw new AppError('Telegram Bot Token 格式无效。');
    if (
      config.enabled &&
      ((config.channel === 'webhook' && !config.url) ||
        (config.channel === 'telegram' && (!config.token || !/^-?\d+$/.test(config.chatId))))
    )
      throw new AppError('请填写通知渠道的完整信息。');
    this.state.notifications = config;
    // Old events must not be delivered to a newly configured recipient.
    if (
      current.channel !== config.channel ||
      (config.channel === 'webhook'
        ? current.url !== config.url
        : current.token !== config.token || current.chatId !== config.chatId)
    )
      this.state.notificationQueue = [];
    return this.view();
  }
  async enqueue(event, job) {
    const config = this.state.notifications;
    if (!config.enabled || !config.events.includes(event)) return;
    const key = `${event}:${job.id}:${job.attempts || 0}:${job.quotaDate || ''}`;
    if (
      this.state.notificationHistory.some((item) => item.key === key) ||
      this.state.notificationQueue.some((item) => item.key === key)
    )
      return;
    const names = {
      completed: '任务完成',
      failed: '任务失败',
      quota: '已达每日额度',
      auth: '网盘需要重新授权',
    };
    this.state.notificationQueue.push({
      key,
      event,
      text: `CloudReel · ${names[event]}\n${String(job.name || job.id).slice(0, 80)}\n已传输 ${Number(job.transferredBytes || job.stats?.bytes || 0)} 字节`,
      at: new Date(this.now()).toISOString(),
      attempts: 0,
      nextAt: 0,
    });
    this.state.notificationQueue = this.state.notificationQueue.slice(-100);
  }
  async deliver(item) {
    const config = this.state.notifications;
    const telegram = config.channel === 'telegram';
    const response = await fetch(
      telegram ? `https://api.telegram.org/bot${config.token}/sendMessage` : config.url,
      {
        method: 'POST',
        redirect: 'error',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          telegram
            ? { chat_id: config.chatId, text: item.text }
            : { event: item.event, text: item.text, at: item.at },
        ),
        signal: AbortSignal.timeout(10000),
      },
    );
    if (!response.ok) throw new AppError(`通知服务返回 HTTP ${response.status}。`, 502);
    if (telegram) {
      const result = await response.json();
      if (!result.ok) throw new AppError('Telegram 未接受通知，请检查机器人和会话权限。', 502);
    } else await response.body?.cancel();
  }
  async test() {
    if (!this.state.notifications.enabled) throw new AppError('请先保存并启用通知。');
    try {
      await this.deliver({
        event: 'test',
        text: 'CloudReel · 通知连接测试',
        at: new Date(this.now()).toISOString(),
      });
    } catch (error) {
      throw new AppError(
        error instanceof AppError ? error.message : '通知发送失败，请检查渠道设置。',
        502,
      );
    }
    return { ok: true };
  }
  async tick() {
    if (!this.state.notifications.enabled) return;
    const item = this.state.notificationQueue.find((item) => item.nextAt <= this.now());
    if (!item) return;
    try {
      await this.deliver(item);
      this.state.notificationHistory.push({
        key: item.key,
        event: item.event,
        at: new Date(this.now()).toISOString(),
        status: 'sent',
      });
      this.state.notificationQueue = this.state.notificationQueue.filter((value) => value !== item);
    } catch (error) {
      item.attempts++;
      item.nextAt = this.now() + Math.min(3600000, 30000 * 2 ** (item.attempts - 1));
      if (item.attempts >= 5) {
        this.state.notificationHistory.push({
          key: item.key,
          event: item.event,
          at: new Date(this.now()).toISOString(),
          status: 'failed',
          error: error instanceof AppError ? safeError(error.message) : '通知连接失败',
        });
        this.state.notificationQueue = this.state.notificationQueue.filter(
          (value) => value !== item,
        );
      }
    }
    this.state.notificationHistory = this.state.notificationHistory.slice(-100);
    await this.save();
  }
}
