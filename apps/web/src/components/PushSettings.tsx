import { useState } from "react";
import { postJson, useJson, errorMessage, RequestError } from "../api";

export function PushSettings() {
  const [config] = useJson<{ publicKey: string | null; channels: Record<string, boolean> }>("/api/notifications");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const enable = async () => {
    setBusy(true);
    try {
      if (!("serviceWorker" in navigator) || !("PushManager" in window) || !window.isSecureContext) throw new RequestError("Use HTTPS or loopback in a browser that supports Web Push.");
      if (await Notification.requestPermission() !== "granted") throw new RequestError("Notifications were not allowed. Change this site's notification permission in your browser to try again.");
      const keys = config?.publicKey ? { publicKey: config.publicKey } : await postJson<{ publicKey: string }>("/api/setup/push", {});
      await navigator.serviceWorker.register("/sw.js");
      const worker = await navigator.serviceWorker.ready;
      const key = Uint8Array.from(atob(keys.publicKey.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
      const subscription = await worker.pushManager.getSubscription() ?? await worker.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      await postJson("/api/push/subscriptions", subscription.toJSON());
      setMessage("This device will receive unanswered requests. Quiet hours apply.");
    } catch (err) { setMessage(errorMessage(err)); }
    finally { setBusy(false); }
  };
  // One row of the Notifications section (settings.webp).
  return <>
    <div className="sec-r"><span className="kl">Phone push</span><span style={{ flex: 1, minWidth: 0 }}>On this device, once ContextLanes is on its home screen. Requests wait for your answer.</span><button className="btn ghost sm" disabled={busy} onClick={() => void enable()}>Turn on here</button></div>
    {message ? <div className="sec-f" role="status" style={{ fontSize: 13 }}>{message}</div> : null}
  </>;
}
