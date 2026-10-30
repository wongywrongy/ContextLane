import { z } from "zod";

export const NotificationChannel = z.enum(["ntfy", "telegram", "webpush"]);
export type NotificationChannel = z.infer<typeof NotificationChannel>;
export const PushSubscription = z.object({
  endpoint: z.url().refine((url) => new URL(url).protocol === "https:", "push endpoint must use HTTPS"),
  keys: z.object({ p256dh: z.string().regex(/^[\w-]{87}$/), auth: z.string().regex(/^[\w-]{22}$/) }),
});
export type PushSubscription = z.infer<typeof PushSubscription>;
export const NotificationConfig = z.object({
  publicUrl: z.url().optional(),
  quiet: z.object({
    start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    timeZone: z.string().refine((zone) => { try { new Intl.DateTimeFormat("en", { timeZone: zone }); return true; } catch { return false; } }).default("UTC"),
  }).optional(),
  ntfy: z.object({ url: z.url().default("https://ntfy.sh"), topic: z.string().regex(/^[\w-]+$/), token: z.string().optional() }).optional(),
  telegram: z.object({ botToken: z.string().min(1), chatId: z.string().regex(/^-?\d+$/), ownerId: z.string().regex(/^\d+$/) }).optional(),
  webPush: z.object({ subject: z.string().regex(/^(mailto:|https:\/\/)/), publicKey: z.string().min(1), privateKey: z.string().min(1) }).optional(),
}).superRefine((config, ctx) => {
  if (config.ntfy && !config.publicUrl) ctx.addIssue({ code: "custom", message: "ntfy actions need notifications.publicUrl", path: ["publicUrl"] });
  for (const [key, value] of [["publicUrl", config.publicUrl], ["ntfy.url", config.ntfy?.url]] as const) {
    if (value) { const url = new URL(value); if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname))) ctx.addIssue({ code: "custom", message: "use HTTPS, or loopback for local testing", path: [key] }); }
  }
});
export type NotificationConfig = z.infer<typeof NotificationConfig>;
export const TelegramUpdates = z.object({ ok: z.literal(true), result: z.array(z.object({
  update_id: z.number().int(), callback_query: z.object({ id: z.string(), data: z.string().optional(), from: z.object({ id: z.number().int() }), message: z.object({ chat: z.object({ id: z.number().int() }) }).optional() }).optional(),
})) });
