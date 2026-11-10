import { useEffect, useMemo, useState } from "react";
import { clsx } from "clsx";
import { useDiffTokens } from "./highlight";
import type { ReviewComment } from "@contextlanes/protocol";
import { errorMessage, postJson, useJson } from "../api";
import { Dialog, Section } from "../components/ui";
import { diffLines, useReviewComments } from "./review";

type Point = Omit<ReviewComment, "text">;
export function DiffLines({ text, add }: { text: string; add: (comment: ReviewComment) => void }) {
  const [point, setPoint] = useState<Point | null>(null);
  const [comment, setComment] = useState("");
  const rows = useMemo(() => diffLines(text), [text]);
  const tokens = useDiffTokens(rows);
  // The +/- marker stays plain; the code after it is coloured by shiki once it has loaded.
  const code = (i: number, text: string) => {
    const line = tokens?.get(i);
    if (!line) return text || " ";
    return <>{text[0]}{line.map((t, n) => <span key={n} style={{ color: t.color, fontStyle: t.fontStyle === 1 ? "italic" : undefined, fontWeight: t.fontStyle === 2 ? 700 : undefined }}>{t.content}</span>)}</>;
  };
  return <><div className="dfv">{rows.map((row, i) => row.line && row.file
    ? <button key={i} className={clsx("diff-line", row.kind)} aria-label={`Comment on ${row.file}:${row.line}${row.side === "old" ? " (before)" : ""}`} onClick={() => { setPoint({ file: row.file, line: row.line, side: row.side, quote: row.text.slice(1, 4001) }); setComment(""); }}><span className="diff-number">{row.line}</span>{code(i, row.text)}</button>
    : <div key={i} className={row.kind}>{row.text || " "}</div>)}</div>
    {point ? <Dialog title="Line comment" meta={`${point.file}:${point.line}${point.side === "old" ? " · before" : ""}`} onClose={() => setPoint(null)} footer={<><button className="btn ghost" onClick={() => setPoint(null)}>Cancel</button><button className="btn" disabled={!comment.trim()} onClick={() => { add({ ...point, text: comment.trim() }); setPoint(null); }}>Add to request</button></>}>
      <blockquote className="out">{point.quote}</blockquote><textarea className="in" aria-label="Line comment" maxLength={2000} rows={3} autoFocus value={comment} onChange={e => setComment(e.target.value)} />
    </Dialog> : null}</>;
}

export function ReviewTray({ comments, remove, send, busy }: { comments: ReviewComment[]; remove: (index: number) => void; send?: () => void; busy?: boolean }) {
  if (!comments.length) return null;
  return <Section title="Change request" meta={`${comments.length} / 50 comments`} end={send ? <button className="btn sm" disabled={busy} onClick={send}>Request changes</button> : undefined}>
    {comments.map((c, i) => <div className="sec-b" key={i}><div className="sec-r" style={{ padding: 0, flexWrap: "wrap" }}><b className="mono">{c.file}{c.line ? `:${c.line}` : ""}{c.side === "old" ? " · before" : ""}</b><button className="lnk" style={{ marginLeft: "auto" }} aria-label={`Remove comment ${i + 1}`} onClick={() => remove(i)}>Remove</button></div>{c.quote ? <blockquote className="out">{c.quote}</blockquote> : null}<p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{c.text}</p></div>)}
  </Section>;
}

export function WorkDiff({ lane, version }: { lane: string; version: number }) {
  const [data, error, reload] = useJson<{ diff: string }>(`/api/lanes/${lane}/diff`);
  const { comments, setComments, add, clear } = useReviewComments(lane);
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState("");
  useEffect(reload, [version, reload]);
  const send = async () => { setBusy(true); setNotice(""); try { await postJson(`/api/lanes/${lane}/request-changes`, { comments }); clear(); setNotice("Change request queued for the agent."); } catch (e) { setNotice(errorMessage(e)); } finally { setBusy(false); } };
  return <><div className="sec-r"><button className="btn ghost sm" onClick={reload}>Refresh diff</button><span className="muted">Click a line to comment</span></div>{error ? <p role="alert" className="sec-b">{error.message}</p> : null}{data?.diff ? <DiffLines text={data.diff} add={add} /> : <p className="sec-b">No tracked changes against the lane's base.</p>}<ReviewTray comments={comments} remove={index => setComments(c => c.filter((_, i) => i !== index))} send={() => void send()} busy={busy} />{notice ? <p role="status" className="sec-b">{notice}</p> : null}</>;
}
