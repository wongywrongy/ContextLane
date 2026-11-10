import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { DndContext, DragOverlay, KeyboardSensor, MouseSensor, TouchSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { Menu } from "@base-ui/react/menu";
import { clsx } from "clsx";
import { toast } from "sonner";
import { useParams } from "react-router";
import type { BoardLane, InboxItem, Lane, LaneEvent } from "@contextlanes/protocol";
import { errorMessage, useJson } from "../api";
import { AgentMark, Glyph, LaneBadge, Section, StateGlyph } from "../components/ui";
import { isIdle, laneNow } from "./model";
import { BOARD_COLUMNS, boardColumn, boardDrop, type BoardColumn } from "./board";
import { useFeatures } from "../features";

/**
 * The board groups actual lifecycle state. Cards move with dnd kit (mouse, touch and keyboard), and a
 * drop or an Actions choice goes through the same owner APIs; the outcome shows as a toast.
 */
export function Overview({ lanes, events, waiting, select }: { lanes: Lane[]; events: LaneEvent[]; waiting: InboxItem[]; select: (id: string) => void }) {
  const { project } = useParams();
  const [facts, error, reload] = useJson<BoardLane[]>(`/api/projects/${project}/board`);
  // Only review moves lanes to In review and Merged; without it those columns stay empty.
  const features = useFeatures();
  const [busy, setBusy] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const changed = events.findLast(e => ["lane.state", "checkpoint.judged", "usage", "env.status"].includes(e.type));
  const version = `${changed?.lane}/${changed?.seq}/${lanes.map(l => `${l.id}:${l.state}`).join(",")}`;
  useEffect(reload, [version, reload]);
  useEffect(() => { const timer = setInterval(() => { setNow(Date.now()); reload(); }, 30_000); return () => clearInterval(timer); }, [reload]);
  // A short press-and-move starts a drag, so a tap or click still opens the lane; touch waits a moment so the page can scroll.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 6 } }),
    useSensor(KeyboardSensor),
  );
  const act = async (lane: Lane, to: BoardColumn | "Archive") => {
    if (busy) return;
    setBusy(lane.id);
    try { toast(await boardDrop(lane, to)); reload(); } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(null); }
  };
  const cards = (facts ?? []).map(card => ({ ...card, lane: lanes.find(l => l.id === card.lane.id) ?? card.lane }));
  if (!facts) return <Section title="Board"><p className="sec-b" role={error ? "alert" : "status"}>{error ? error.message : "Loading lanes…"}</p></Section>;
  const columns = BOARD_COLUMNS.filter(column => features.review || !["In review", "Merged"].includes(column));
  const held = cards.find(c => c.lane.id === dragging);
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    setDragging(null);
    const lane = lanes.find(l => l.id === active.id);
    if (lane && over) void act(lane, over.id as BoardColumn | "Archive");
  };
  return <DndContext sensors={sensors} onDragStart={({ active }) => setDragging(String(active.id))} onDragCancel={() => setDragging(null)} onDragEnd={onDragEnd}>
    <div className="board-wrap">
      {error ? <p role="alert">{error.message}</p> : null}
      <div className="lane-board" aria-label="Lane board" data-key-list style={{ "--cols": columns.length } as CSSProperties}>{columns.map(column => {
        const shown = cards.filter(card => boardColumn(card, waiting.some(i => i.lane === card.lane.id), now) === column);
        return <Column key={column} id={column}><Section title={column} meta={`${shown.length}${column === "Merged" ? " · 7 days" : ""}`}>
          {shown.map(card => <Card key={card.lane.id} card={card} disabled={!!busy}>{body => <>
            <button data-list-item className="board-open" onClick={() => select(card.lane.id)}><span className="board-who"><LaneBadge id={card.lane.id} colour={card.lane.colour} /><AgentMark agent={card.lane.agent} small /><span>{card.lane.kind === "shell" ? "no agent" : card.lane.agent}</span></span><b>{card.lane.task}</b><span className="board-now">{laneNow(card.lane, events, waiting)}</span><StateGlyph state={card.lane.state} idle={isIdle(card.lane, events)} label /></button>
            <div className="board-facts">{card.contextPct !== null ? <span>ctx {card.contextPct}%</span> : null}{card.verdict ? <Glyph g={card.verdict === "merge" ? "done" : card.verdict === "fix first" ? "wait" : "fail"}>{card.verdict}</Glyph> : null}{card.preview ? <a className="lnk" href={card.preview} target="_blank" rel="noreferrer">Preview ↗</a> : null}</div>
            {body}
            {["working", "failed"].includes(card.lane.state) && (card.lane.state === "failed" || features.review) ? <Menu.Root>
              <Menu.Trigger className="board-actions" aria-label={`Actions for ${card.lane.id}`}>Actions ▾</Menu.Trigger>
              <Menu.Portal><Menu.Positioner className="pop-pos" side="bottom" align="start" sideOffset={4}><Menu.Popup className="menu">
                <Menu.Item className="menu-i" disabled={!!busy} onClick={() => void act(card.lane, card.lane.state === "failed" ? "Archive" : "In review")}>{card.lane.state === "failed" ? "Archive" : "Ask for review"}</Menu.Item>
              </Menu.Popup></Menu.Positioner></Menu.Portal>
            </Menu.Root> : null}
          </>}</Card>)}
          {!shown.length ? <div className="sec-b muted">No lanes</div> : null}
        </Section></Column>;
      })}</div>
      <Column id="Archive" className="sec board-archive" label="Archive failed lane"><div className="sec-r muted">Drop a failed lane here to archive it. Its checkout and history stay.</div></Column>
    </div>
    <DragOverlay dropAnimation={null}>{held ? <div className="board-card held"><span className="board-who"><LaneBadge id={held.lane.id} colour={held.lane.colour} /></span><b>{held.lane.task}</b></div> : null}</DragOverlay>
  </DndContext>;
}

/** A place a card can be dropped: a column, or the archive strip. */
function Column({ id, className = "board-column", label, children }: { id: string; className?: string; label?: string; children: ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return <div ref={setNodeRef} className={clsx(className, isOver && "over")} data-column={id} aria-label={label}>{children}</div>;
}

/** A card that can be picked up by its grip; the rest of the card stays clickable. */
function Card({ card, disabled, children }: { card: BoardLane; disabled: boolean; children: (grip: ReactNode) => ReactNode }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: card.lane.id, disabled });
  const grip = <button className="board-grip" aria-label={`Move ${card.lane.id}`} {...attributes} {...listeners}>⠿ move</button>;
  return <article ref={setNodeRef} className={clsx("board-card", isDragging && "lifted")} data-lane={card.lane.id}>{children(grip)}</article>;
}
