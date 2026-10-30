import { createHash } from "node:crypto";
import webPush from "web-push";
import { TelegramUpdates, type InboxItem, type NotificationChannel, type NotificationConfig, type PushSubscription } from "@contextlanes/protocol";
import type { EventBus } from "../bus.js";
import type { Store } from "../db/store.js";

export function quietNow(config: NotificationConfig["quiet"], now = new Date()): boolean {
  if (!config || config.start === config.end) return false;
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: config.timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now);
  return config.start < config.end ? time >= config.start && time < config.end : time >= config.start || time < config.end;
}

type PushSender = (subscription: PushSubscription, payload: string, config: NonNullable<NotificationConfig["webPush"]>) => Promise<unknown>;
export class Notifier {
  private readonly http: typeof fetch;
  private readonly push: PushSender;
  private readonly stop = new AbortController();
  private off?: () => void;
  private timer?: ReturnType<typeof setInterval>;
  private flushing?: Promise<void>;
  private polling?: Promise<void>;
  private stopped = false;

  constructor(private readonly deps: { store: Store; bus: EventBus; config: NotificationConfig; answer: (token: string) => Promise<boolean>; fetch?: typeof fetch; push?: PushSender; now?: () => Date }) {
    this.http = deps.fetch ?? fetch;
    this.push = deps.push ?? ((subscription, payload, config) => webPush.sendNotification(subscription, payload, { vapidDetails: config, timeout: 5000, TTL: 86_400 }));
  }

  start(): void {
    this.off = this.deps.bus.subscribeAll((event) => { if (event.type === "permission.requested") void this.flush(); });
    this.timer = setInterval(() => void this.flush(), 60_000);
    void this.flush();
    if (this.deps.config.telegram) this.polling = this.poll();
  }

  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = this.deliver().finally(() => { this.flushing = undefined; });
    return this.flushing;
  }

  async close(): Promise<void> {
    this.stopped = true;
    this.stop.abort();
    this.off?.();
    clearInterval(this.timer);
    await this.polling;
    await this.flushing;
  }

  private actions(item: InboxItem, channel: NotificationChannel) {
    const requestId = item.id.slice(item.id.indexOf("#") + 1);
    return item.options.filter((o) => o.kind === "allow_once" || o.kind === "reject_once").slice(0, channel === "webpush" ? 2 : 3)
      .map((o) => ({ label: o.label, token: this.deps.store.action(item.lane, requestId, o.id, channel) }));
  }

  private async deliver(): Promise<void> {
    const { config, store, bus } = this.deps;
    if (this.stopped || quietNow(config.quiet, this.deps.now?.())) return;
    for (const item of store.inbox().filter((item) => item.kind === "permission" || item.kind === "question")) {
      const requestId = item.id.slice(item.id.indexOf("#") + 1);
      const page = `${config.publicUrl ?? ""}/p/${item.lane.split("/")[0]}/work`;
      const send = async (channel: NotificationChannel, fn: () => Promise<unknown>, target = "") => {
        if (store.notified(item.lane, requestId, channel, target) || store.answered(item.lane, requestId)) return;
        try {
          await fn();
          bus.publish(store.appendEvent(item.lane, { type: "notification.sent", payload: { requestId, channel, target } }, `notification:${requestId}:${channel}:${target}`));
        } catch (err) {
          if (!this.stopped) bus.publish(store.appendEvent(item.lane, { type: "notification.failed", payload: { requestId, channel, message: `${channel} delivery failed; check notification configuration and connectivity` } }, `notification-error:${requestId}:${channel}:${target}`));
        }
      };
      if (config.ntfy) await send("ntfy", () => {
        const actions = this.actions(item, "ntfy").map((a) => ({ action: "http", label: a.label, url: `${config.publicUrl!.replace(/\/$/, "")}/api/answers`, method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${a.token}` }, body: "{}", clear: true }));
        return this.post(config.ntfy!.url, { topic: config.ntfy!.topic, title: `${item.lane} needs you`, message: item.title, click: page, actions }, config.ntfy!.token);
      });
      if (config.telegram) await send("telegram", () => this.telegram("sendMessage", { chat_id: config.telegram!.chatId, text: `${item.lane}: ${item.title}`,
        reply_markup: { inline_keyboard: this.actions(item, "telegram").map((a) => [{ text: a.label, callback_data: a.token }]) } }));
      if (config.webPush) for (const subscription of store.subscriptions()) {
        const target = createHash("sha256").update(subscription.endpoint).digest("hex");
        await send("webpush", async () => {
          try { await this.push(subscription, JSON.stringify({ title: `${item.lane} needs you`, body: item.title, tag: item.id, url: page, actions: this.actions(item, "webpush") }), config.webPush!); }
          catch (err) {
            if (err && typeof err === "object" && "statusCode" in err && [404, 410].includes(Number(err.statusCode))) store.removeSubscription(subscription.endpoint);
            throw err;
          }
        }, target);
      }
    }
  }

  private async post(url: string, body: unknown, token?: string): Promise<unknown> {
    const response = await this.http(url, { method: "POST", headers: { "content-type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body), signal: AbortSignal.any([this.stop.signal, AbortSignal.timeout(30_000)]) });
    if (!response.ok) throw new Error(`notification HTTP ${response.status}`);
    return response.json();
  }

  private telegram(method: string, body: unknown): Promise<unknown> {
    return this.post(`https://api.telegram.org/bot${this.deps.config.telegram!.botToken}/${method}`, body);
  }

  async pollOnce(): Promise<void> {
    const config = this.deps.config.telegram;
    if (!config) return;
    const updates = TelegramUpdates.parse(await this.telegram("getUpdates", { offset: this.deps.store.telegramOffset(), timeout: 25, allowed_updates: ["callback_query"] }));
    for (const update of updates.result) {
      const callback = update.callback_query;
      if (callback?.data) {
        const allowed = String(callback.from.id) === config.ownerId && String(callback.message?.chat.id) === config.chatId;
        const answered = allowed && await this.deps.answer(callback.data);
        await this.telegram("answerCallbackQuery", { callback_query_id: callback.id, text: answered ? "Answered." : "Not pending, or not your request." });
      }
      this.deps.store.setTelegramOffset(update.update_id + 1);
    }
  }

  private async poll(): Promise<void> {
    while (!this.stopped) {
      try { await this.pollOnce(); }
      catch {
        if (!this.stopped) await new Promise<void>((resolve) => {
          const done = () => { clearTimeout(timer); this.stop.signal.removeEventListener("abort", done); resolve(); };
          const timer = setTimeout(done, 5000);
          this.stop.signal.addEventListener("abort", done, { once: true });
        });
      }
    }
  }
}
