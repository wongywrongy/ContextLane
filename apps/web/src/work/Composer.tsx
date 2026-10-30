import { useState } from "react";
import type { LaneEvent } from "@contextlanes/protocol";
import { postJson } from "../api";
import { Section } from "../components/ui";
import { queuedPrompts } from "./model";

export function Composer({ lane, events, interrupt }: { lane: string; events: LaneEvent[]; interrupt: () => void }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState("");
  const queue = queuedPrompts(events);
  const send = async (immediate: boolean) => {
    if (!text.trim() || sending) return;
    setSending(true); setNotice("");
    try {
      const result = await postJson<{ delivered: boolean }>(`/api/lanes/${lane}/prompt`, { text, immediate });
      setText("");
      setNotice(!result.delivered ? "Saved. Waiting for the lane host to reconnect." : immediate ? "Sent now. Interruption requested." : "Queued after the current turn.");
    } catch (err) { setNotice(err instanceof Error ? err.message : "Could not send the message. Your draft is kept."); }
    finally { setSending(false); }
  };
  return <Section title="Message" meta="Enter: queue · ⌘/Ctrl+Enter: send now · Esc: interrupt">
    {queue.length ? <div className="message-queue" aria-label="Queued messages"><span className="lbl">Queued · {queue.length}</span>{queue.map((event) => <p key={event.payload.commandId}>{event.payload.command.kind === "prompt" ? event.payload.command.text : ""}</p>)}</div> : null}
    <div className="sec-b composer"><label htmlFor="lane-message" className="lbl">Tell this lane what to do</label>
      <textarea id="lane-message" value={text} maxLength={100_000} rows={3} placeholder="Add a detail or change direction…" onChange={(event) => setText(event.target.value)} onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(event.metaKey || event.ctrlKey); }
      }} />
      <div className="composer-actions"><span className="muted">Shift+Enter for a new line</span><button className="btn ghost" onClick={interrupt}>Interrupt</button><button className="btn ghost" disabled={sending || !text.trim()} onClick={() => void send(true)}>Send now</button><button className="btn" disabled={sending || !text.trim()} onClick={() => void send(false)}>Queue</button></div>
      {notice ? <p role="status">{notice}</p> : null}
    </div>
  </Section>;
}
