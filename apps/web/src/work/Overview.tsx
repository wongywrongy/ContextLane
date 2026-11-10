import { useEffect, useState, type CSSProperties } from "react";
import { useParams } from "react-router";
import type { BoardLane, InboxItem, Lane, LaneEvent } from "@contextlanes/protocol";
import { useJson } from "../api";
import { AgentMark, Glyph, LaneBadge, Section, StateGlyph } from "../components/ui";
import { isIdle, laneNow } from "./model";
import { BOARD_COLUMNS, boardColumn } from "./board";
import { useFeatures } from "../features";

/** The board groups lanes by their actual lifecycle state. It shows where each lane is; lanes are moved by what happens to them, not by hand. */
export function Overview({ lanes, events, waiting, select }: { lanes: Lane[]; events: LaneEvent[]; waiting: InboxItem[]; select: (id: string) => void }) {
  const { project } = useParams();
  const [facts, error, reload] = useJson<BoardLane[]>(`/api/projects/${project}/board`);
  // Only review moves lanes to In review and Merged; without it those columns stay empty.
  const features = useFeatures();
  const [now, setNow] = useState(Date.now());
  const changed = events.findLast(e => ["lane.state", "checkpoint.judged", "usage", "env.status"].includes(e.type));
  const version = `${changed?.lane}/${changed?.seq}/${lanes.map(l => `${l.id}:${l.state}`).join(",")}`;
  useEffect(reload, [version, reload]);
  useEffect(() => { const timer = setInterval(() => { setNow(Date.now()); reload(); }, 30_000); return () => clearInterval(timer); }, [reload]);
  const cards = (facts ?? []).map(card => ({ ...card, lane: lanes.find(l => l.id === card.lane.id) ?? card.lane }));
  if (!facts) return <Section title="Board"><p className="sec-b" role={error ? "alert" : "status"}>{error ? error.message : "Loading lanes…"}</p></Section>;
  const columns = BOARD_COLUMNS.filter(column => features.review || !["In review", "Merged"].includes(column));
  return <div className="board-wrap">
    {error ? <p role="alert">{error.message}</p> : null}
    <div className="lane-board" aria-label="Lane board" data-key-list style={{ "--cols": columns.length } as CSSProperties}>{columns.map(column => {
      const shown = cards.filter(card => boardColumn(card, waiting.some(i => i.lane === card.lane.id), now) === column);
      return <div className="board-column" key={column} data-column={column}><Section title={column} meta={`${shown.length}${column === "Merged" ? " · 7 days" : ""}`}>
        {shown.map(card => <article className="board-card" key={card.lane.id} data-lane={card.lane.id}>
          <button data-list-item className="board-open" onClick={() => select(card.lane.id)}><span className="board-who"><LaneBadge id={card.lane.id} colour={card.lane.colour} /><AgentMark agent={card.lane.agent} small /><span>{card.lane.kind === "shell" ? "no agent" : card.lane.agent}</span></span><b>{card.lane.task}</b><span className="board-now">{laneNow(card.lane, events, waiting)}</span><StateGlyph state={card.lane.state} idle={isIdle(card.lane, events)} label /></button>
          <div className="board-facts">{card.contextPct !== null ? <span>ctx {card.contextPct}%</span> : null}{card.verdict ? <Glyph g={card.verdict === "merge" ? "done" : card.verdict === "fix first" ? "wait" : "fail"}>{card.verdict}</Glyph> : null}{card.preview ? <a className="lnk" href={card.preview} target="_blank" rel="noreferrer">Preview ↗</a> : null}</div>
        </article>)}
        {!shown.length ? <div className="sec-b muted">No lanes</div> : null}
      </Section></div>;
    })}</div>
  </div>;
}
