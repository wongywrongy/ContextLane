import { useEffect, useMemo, useState } from "react";
import type { InboxItem, Lane, LaneEvent } from "@contextlanes/protocol";
import { AgentMark, Empty, LaneBadge, Section, StateGlyph, ago } from "../components/ui";
import { isIdle, laneNow, timeline } from "./model";

/** Most urgent first: what waits on you, then what is moving, then the rest. */
const RANK: Record<Lane["state"], number> = { needs_you: 0, in_review: 1, failed: 2, working: 3, setting_up: 4, paused: 5, draft: 6, merged: 7, cleaned: 8, archived: 9 };

/**
 * The overview: every open lane as one row, grouped by goal, most urgent first. A row says who is on it,
 * what it is doing in plain words, its last two hours, and its state. It reads the same with one lane or
 * thirty, and needs no layout engine.
 */
export function Overview({ lanes, events, waiting, select }: { lanes: Lane[]; events: LaneEvent[]; waiting: InboxItem[]; select: (id: string) => void }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(timer); }, []);
  const start = now - 2 * 60 * 60_000;
  const groups = useMemo(() => {
    const goals = lanes.some((l) => l.goal);
    const by = new Map<string, Lane[]>();
    for (const lane of lanes) { const key = goals ? lane.goal ?? "No goal" : "Lanes"; by.set(key, [...(by.get(key) ?? []), lane]); }
    const urgency = (ls: Lane[]) => Math.min(...ls.map((l) => RANK[l.state]));
    return [...by].map(([goal, ls]) => [goal, [...ls].sort((a, b) => RANK[a.state] - RANK[b.state] || b.createdAt.localeCompare(a.createdAt))] as const)
      .sort((a, b) => (a[0] === "No goal" ? 1 : 0) - (b[0] === "No goal" ? 1 : 0) || urgency(a[1]) - urgency(b[1]));
  }, [lanes]);
  // A lane forked from another says where it came from.
  const from = useMemo(() => new Map(events.flatMap((e) => e.type === "lane.forked" ? [[e.payload.to, e.payload.from] as const] : [])), [events]);
  const since = (lane: Lane) => events.findLast((e) => e.lane === lane.id && e.type === "lane.state")?.at ?? lane.createdAt;
  const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (!lanes.length) return <Section title="Lanes"><Empty>No lanes yet</Empty></Section>;
  return <>
    {groups.map(([goal, ls]) => {
      const need = ls.filter((l) => l.state === "needs_you" || l.state === "in_review").length;
      return <Section key={goal} title={goal} meta={`${ls.length} ${ls.length === 1 ? "lane" : "lanes"}${need ? ` · ${need} ${need === 1 ? "needs" : "need"} you` : ""}`}
        end={<span className="mono muted" style={{ fontSize: 12 }}>{clock(start)} → now</span>}>
        {ls.map((lane) => <button className="ov-row" key={lane.id} onClick={() => select(lane.id)}>
          <span className="ov-who"><LaneBadge id={lane.id} colour={lane.colour} /><AgentMark agent={lane.agent} small /></span>
          <span className="ov-what"><b>{lane.task}</b><span>{laneNow(lane, events, waiting)}{from.has(lane.id) ? ` · from lane ${from.get(lane.id)!.slice(from.get(lane.id)!.lastIndexOf("/") + 1)}` : ""}</span></span>
          <span className="timeline-track" aria-label={`Last two hours of ${lane.task}`}>
            {timeline(lane, events, start, now).map((segment, i) => <span key={i} className={`activity-bar ${segment.state}`} style={{ left: `${(segment.from - start) / (now - start) * 100}%`, width: `${(segment.to - segment.from) / (now - start) * 100}%` }} title={`${segment.state.replaceAll("_", " ")} · ${new Date(segment.from).toLocaleTimeString()} to ${new Date(segment.to).toLocaleTimeString()}`} />)}
          </span>
          <span className="ov-state"><StateGlyph state={lane.state} idle={isIdle(lane, events)} label /><small>{ago(since(lane), now)}</small></span>
        </button>)}
      </Section>;
    })}
    <p className="graph-legend" style={{ margin: "0 2px" }}>Bars show the last two hours. Solid: working · stripes: waiting on you · red: failed · pale: idle or paused.</p>
  </>;
}
