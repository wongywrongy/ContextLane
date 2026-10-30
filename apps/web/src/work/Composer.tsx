import { useState } from "react";
import type { Lane, LaneEvent } from "@contextlanes/protocol";
import { postJson } from "../api";
import { laneNumber } from "../components/ui";
import { queuedPrompts } from "./model";

/** Message box from the Console board: queued messages on top, Enter queues, ⌘/Ctrl+Enter sends now. */
export function Composer({ lane, events, agent }: { lane: Lane; events: LaneEvent[]; agent: string }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState("");
  const queue = queuedPrompts(events);
  const send = async (immediate: boolean) => {
    if (!text.trim() || sending) return;
    setSending(true); setNotice("");
    try {
      const result = await postJson<{ delivered: boolean }>(`/api/lanes/${lane.id}/prompt`, { text, immediate });
      setText("");
      setNotice(!result.delivered ? "Saved. It sends when the lane’s agent reconnects." : immediate ? "Sent now. The current step was interrupted." : "");
    } catch (err) { setNotice(err instanceof Error ? err.message : "The message could not be sent. Your draft is kept."); }
    finally { setSending(false); }
  };
  return <section className="compose" aria-label="Message the agent">
    {queue.map((event) => <div className="q" key={event.payload.commandId}>
      <span className="lbl" style={{ fontSize: 11 }}>Queued</span>
      <span className="txt">“{event.payload.command.kind === "prompt" ? event.payload.command.text : ""}”</span>
      <span className="mono muted" style={{ fontSize: 11.5 }}>sends after this step</span>
    </div>)}
    <div className="bd">
      <label htmlFor="lane-message" className="lbl" style={{ display: "block", marginBottom: 6 }}>Message {agent} in lane {laneNumber(lane.id)}</label>
      <textarea id="lane-message" rows={2} value={text} maxLength={100_000} placeholder="Answer, redirect, or add to the plan…" onChange={(e) => setText(e.target.value)} onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(event.metaKey || event.ctrlKey); }
      }} />
      <div className="row">
        <span className="keys"><span className="kbd2">↵</span> queue · <span className="kbd2">⌘↵</span> send now · <span className="kbd2">⇧↵</span> new line</span>
        <button className="btn sm" disabled={sending || !text.trim()} onClick={() => void send(false)}>{sending ? "Sending…" : "Send"}</button>
      </div>
      {notice ? <p role="status">{notice}</p> : null}
    </div>
  </section>;
}
