import { useEffect, useState, type DragEvent } from "react";
import { useParams } from "react-router";
import type { BoardLane, InboxItem, Lane, LaneEvent } from "@contextlanes/protocol";
import { errorMessage, useJson } from "../api";
import { AgentMark, Glyph, LaneBadge, Section, StateGlyph } from "../components/ui";
import { isIdle, laneNow } from "./model";
import { BOARD_COLUMNS, boardColumn, boardDrop, type BoardColumn } from "./board";

/** The board groups actual lifecycle state; drag and menu actions share the existing owner APIs. */
export function Overview({ lanes, events, waiting, select }: { lanes: Lane[]; events: LaneEvent[]; waiting: InboxItem[]; select: (id: string) => void }) {
  const { project } = useParams();
  const [facts, error, reload] = useJson<BoardLane[]>(`/api/projects/${project}/board`);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const changed = events.findLast(e => ["lane.state", "checkpoint.judged", "usage", "env.status"].includes(e.type));
  const version = `${changed?.lane}/${changed?.seq}/${lanes.map(l => `${l.id}:${l.state}`).join(",")}`;
  useEffect(reload, [version, reload]);
  useEffect(() => { const timer = setInterval(() => { setNow(Date.now()); reload(); }, 30_000); return () => clearInterval(timer); }, [reload]);
  const act = async (lane: Lane, to: BoardColumn | "Archive") => { if (busy) return; setBusy(lane.id); setNotice(""); try { setNotice(await boardDrop(lane, to)); reload(); } catch (e) { setNotice(errorMessage(e)); } finally { setBusy(null); } };
  const drop = (e: DragEvent, to: BoardColumn | "Archive") => { e.preventDefault(); const id = e.dataTransfer.getData("application/x-contextlanes-lane"); const lane = lanes.find(l => l.id === id); if (lane) void act(lane, to); };
  const cards = (facts ?? []).map(card => ({ ...card, lane: lanes.find(l => l.id === card.lane.id) ?? card.lane }));
  if (!facts) return <Section title="Board"><p className="sec-b" role={error ? "alert" : "status"}>{error ? error.message : "Loading lanes…"}</p></Section>;
  return <div className="board-wrap">
    {error ? <p role="alert">{error.message}</p> : null}{notice ? <p role="status">{notice}</p> : null}
    <div className="lane-board" aria-label="Lane board">{BOARD_COLUMNS.map(column => {
      const shown = cards.filter(card => boardColumn(card, waiting.some(i => i.lane === card.lane.id), now) === column);
      return <div className="board-column" key={column} data-column={column} onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; }} onDrop={e => drop(e, column)}><Section title={column} meta={`${shown.length}${column === "Merged" ? " · 7 days" : ""}`}>
        {shown.map(card => <article className="board-card" key={card.lane.id} data-lane={card.lane.id} draggable={!busy} onDragStart={e => { e.dataTransfer.setData("application/x-contextlanes-lane", card.lane.id); e.dataTransfer.effectAllowed = "move"; }}>
          <button className="board-open" onClick={() => select(card.lane.id)}><span className="board-who"><LaneBadge id={card.lane.id} colour={card.lane.colour} /><AgentMark agent={card.lane.agent} small /><span>{card.lane.agent}</span></span><b>{card.lane.task}</b><span className="board-now">{laneNow(card.lane, events, waiting)}</span><StateGlyph state={card.lane.state} idle={isIdle(card.lane, events)} label /></button>
          <div className="board-facts">{card.contextPct !== null ? <span>ctx {card.contextPct}%</span> : null}{card.verdict ? <Glyph g={card.verdict === "merge" ? "done" : card.verdict === "fix first" ? "wait" : "fail"}>{card.verdict}</Glyph> : null}{card.preview ? <a className="lnk" href={card.preview} target="_blank" rel="noreferrer" draggable={false}>Preview ↗</a> : null}</div>
          {["working", "failed"].includes(card.lane.state) ? <details className="board-actions"><summary aria-label={`Actions for ${card.lane.id}`}>Actions</summary><button className="btn ghost sm" disabled={!!busy} onClick={() => void act(card.lane, card.lane.state === "failed" ? "Archive" : "In review")}>{card.lane.state === "failed" ? "Archive" : "Ask for review"}</button></details> : null}
        </article>)}
        {!shown.length ? <div className="sec-b muted">No lanes</div> : null}
      </Section></div>;
    })}</div>
    <section className="sec board-archive" aria-label="Archive failed lane" onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; }} onDrop={e => drop(e, "Archive")}><div className="sec-r muted">Drop a failed lane here to archive it. Its checkout and history stay.</div></section>
  </div>;
}
