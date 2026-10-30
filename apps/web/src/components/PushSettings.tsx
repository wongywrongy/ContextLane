import { useState } from "react";
import { postJson, useJson } from "../api";
import { Section } from "./ui";

export function PushSettings() {
  const [config] = useJson<{ publicKey: string | null; channels: Record<string, boolean> }>("/api/notifications");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const enable = async () => {
    setBusy(true);
    try {
      if (!("serviceWorker" in navigator) || !("PushManager" in window) || !window.isSecureContext) throw new Error("Use HTTPS or loopback in a browser that supports Web Push.");
      if (await Notification.requestPermission() !== "granted") throw new Error("Notifications were not allowed. Change this site's notification permission in your browser to try again.");
      await navigator.serviceWorker.register("/sw.js");
      const worker = await navigator.serviceWorker.ready;
      const key = Uint8Array.from(atob(config!.publicKey!.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
      const subscription = await worker.pushManager.getSubscription() ?? await worker.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      await postJson("/api/push/subscriptions", subscription.toJSON());
      setMessage("This device will receive unanswered requests. Quiet hours apply.");
    } catch (err) { setMessage(err instanceof Error ? err.message : "Could not enable notifications."); }
    finally { setBusy(false); }
  };
  return <Section title="Phone notifications" meta="you decide when the agent continues">
    <div className="sec-b"><p>Install ContextLanes on your home screen, then enable notifications on this device. Requests keep waiting until you answer.</p>
      <button className="btn" disabled={busy || !config?.publicKey} onClick={() => void enable()}>Enable push on this device</button>
      {!config?.publicKey ? <p className="muted">Set up Web Push before enabling this device.</p> : null}
      {message ? <p role="status">{message}</p> : null}
    </div>
  </Section>;
}
