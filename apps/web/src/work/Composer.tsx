import { useEffect, useMemo, useRef, useState } from "react";
import type { Lane, LaneEvent } from "@contextlanes/protocol";
import { getJson, postJson } from "../api";
import { laneNumber } from "../components/ui";
import { queuedPrompts } from "./model";

type Picture = { name: string; mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif"; data: string };
const TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;

/**
 * Message box from the Console board: queued messages on top, Enter queues, ⌘/Ctrl+Enter sends now.
 * @ file attaches files from the lane's checkout, / command lists the agent's own slash commands, and
 * Attach image appears only for agents that take pictures.
 */
export function Composer({ lane, events, agent }: { lane: Lane; events: LaneEvent[]; agent: string }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState("");
  const [files, setFiles] = useState<string[]>([]);
  const [pictures, setPictures] = useState<Picture[]>([]);
  const [picker, setPicker] = useState<"file" | "command" | null>(null);
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<string[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const queue = queuedPrompts(events);
  const session = useMemo(() => events.findLast((e) => e.type === "agent.session"), [events]);
  const commands = session?.type === "agent.session" ? session.payload.commands ?? [] : [];
  const takesImages = session?.type === "agent.session" && session.payload.images === true;

  useEffect(() => {
    if (picker !== "file") return;
    const timer = setTimeout(() => void getJson<{ files: string[] }>(`/api/lanes/${lane.id}/files?q=${encodeURIComponent(query)}`).then((r) => setFound(r.files), () => setFound([])), 150);
    return () => clearTimeout(timer);
  }, [picker, query, lane.id]);

  const send = async (immediate: boolean) => {
    if (!text.trim() || sending) return;
    setSending(true); setNotice("");
    try {
      const result = await postJson<{ delivered: boolean }>(`/api/lanes/${lane.id}/prompt`, { text, immediate, files, images: pictures.map(({ mimeType, data }) => ({ mimeType, data })) });
      setText(""); setFiles([]); setPictures([]); setPicker(null);
      setNotice(!result.delivered ? "Saved. It sends when the lane’s agent reconnects." : immediate ? "Sent now. The current step was interrupted." : "");
    } catch (err) { setNotice(err instanceof Error ? err.message : "The message could not be sent. Your draft is kept."); }
    finally { setSending(false); }
  };
  const addPicture = async (file: File) => {
    if (!TYPES.includes(file.type as Picture["mimeType"])) { setNotice("Pictures can be PNG, JPEG, WebP or GIF."); return; }
    if (file.size > 5 * 1024 * 1024) { setNotice("Pictures can be at most 5 MB."); return; }
    if (pictures.length >= 3) { setNotice("Up to three pictures per message."); return; }
    const data = await new Promise<string>((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result).split(",")[1] ?? ""); r.onerror = () => reject(r.error); r.readAsDataURL(file); });
    setPictures((p) => [...p, { name: file.name, mimeType: file.type as Picture["mimeType"], data }]);
  };
  const toggle = (which: "file" | "command") => { setPicker(picker === which ? null : which); setQuery(""); };
  const shownCommands = commands.filter((c) => !query || c.name.toLowerCase().includes(query.toLowerCase())).slice(0, 12);

  return <section className="compose" aria-label="Message the agent">
    {queue.map((event) => <div className="q" key={event.payload.commandId}>
      <span className="lbl" style={{ fontSize: 11 }}>Queued</span>
      <span className="txt">“{event.payload.command.kind === "prompt" ? event.payload.command.text : ""}”</span>
      <span className="mono muted" style={{ fontSize: 11.5 }}>sends after this step</span>
    </div>)}
    {picker ? <div className="q">
      <input className="in mono" style={{ maxWidth: 280, minHeight: 32 }} autoFocus aria-label={picker === "file" ? "Find a file in this lane" : "Find a command"} placeholder={picker === "file" ? "Find a file…" : "Find a command…"} value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") setPicker(null); }} />
      {picker === "file"
        ? found.length ? found.slice(0, 8).map((f) => <button key={f} className="fchip" style={{ border: 0, cursor: "pointer" }} title={f} onClick={() => { if (!files.includes(f) && files.length < 10) setFiles([...files, f]); setPicker(null); }}>{f}</button>) : <span className="muted" style={{ fontSize: 13 }}>No matching files.</span>
        : shownCommands.length ? shownCommands.map((c) => <button key={c.name} className="fchip" style={{ border: 0, cursor: "pointer" }} title={c.description} onClick={() => { setText(`/${c.name} ${text.replace(/^\/\S*\s*/, "")}`); setPicker(null); }}>/{c.name}</button>) : <span className="muted" style={{ fontSize: 13 }}>{commands.length ? "No matching commands." : `${agent} has not listed any commands yet.`}</span>}
    </div> : null}
    {files.length || pictures.length ? <div className="q" aria-label="Attached">
      <span className="lbl" style={{ fontSize: 11 }}>Attached</span>
      {files.map((f) => <span className="fchip" key={f} title={f}>{f.split("/").at(-1)}<button aria-label={`Remove ${f}`} style={{ border: 0, background: "none", cursor: "pointer", marginLeft: 4 }} onClick={() => setFiles(files.filter((x) => x !== f))}>×</button></span>)}
      {pictures.map((p, i) => <span className="fchip" key={i} title={p.name}>{p.name}<button aria-label={`Remove ${p.name}`} style={{ border: 0, background: "none", cursor: "pointer", marginLeft: 4 }} onClick={() => setPictures(pictures.filter((_, j) => j !== i))}>×</button></span>)}
    </div> : null}
    <div className="bd">
      <label htmlFor="lane-message" className="lbl" style={{ display: "block", marginBottom: 6 }}>Message {agent} in lane {laneNumber(lane.id)}</label>
      <textarea id="lane-message" rows={2} value={text} maxLength={100_000} placeholder="Answer, redirect, or add to the plan…" onChange={(e) => setText(e.target.value)} onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(event.metaKey || event.ctrlKey); }
      }} onPaste={(event) => { const image = [...event.clipboardData.files].find((f) => f.type.startsWith("image/")); if (image && takesImages) { event.preventDefault(); void addPicture(image); } }} />
      <div className="row">
        <button className={`chipf${picker === "file" ? " on" : ""}`} aria-expanded={picker === "file"} onClick={() => toggle("file")}>@ file</button>
        <button className={`chipf${picker === "command" ? " on" : ""}`} aria-expanded={picker === "command"} onClick={() => toggle("command")}>/ command</button>
        {takesImages ? <><button className="chipf" onClick={() => fileInput.current?.click()}>Attach image</button>
          <input ref={fileInput} type="file" accept={TYPES.join(",")} hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void addPicture(f); e.target.value = ""; }} /></> : null}
        <span className="keys"><span className="kbd2">↵</span> queue · <span className="kbd2">⌘↵</span> send now · <span className="kbd2">⇧↵</span> new line</span>
        <button className="btn sm" disabled={sending || !text.trim()} onClick={() => void send(false)}>{sending ? "Sending…" : "Send"}</button>
      </div>
      {notice ? <p role="status">{notice}</p> : null}
    </div>
  </section>;
}
