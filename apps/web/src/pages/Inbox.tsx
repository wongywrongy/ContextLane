import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import type { InboxItem, Lane, LaneEvent, Project } from "@contextlanes/protocol";
import { apiFetch, answerItem, errorMessage, reviewLink, useInbox, useJson } from "../api";
import { AGENT_NAMES, Empty, Glyph, LaneBadge, Tile, ago, iconFor, laneNumber, type IconName } from "../components/ui";
import { loadHistory, stepsFor } from "../work/model";

const KINDS = [["all", "All"], ["permission", "Permissions"], ["question", "Questions"], ["review", "Reviews"], ["approval", "Approvals"], ["collision", "Collisions"]] as const;
const KIND_ICON: Record<InboxItem["kind"], IconName> = { permission: "permission", question: "question", review: "checkpoint", approval: "environment", collision: "subagent" };
const KIND_WORD: Record<InboxItem["kind"], string> = { permission: "Permission", question: "Question", review: "Review", approval: "Approval", collision: "Collision" };

/** Inbox: everything waiting on you, oldest first; the selected item with what led to it. */
export function InboxPage() {
  const [items, error, reload] = useInbox();
  const [lanes] = useJson<Lane[]>("/api/lanes");
  const [projects] = useJson<Project[]>("/api/projects");
  const [params, setParams] = useSearchParams();
  const [kind, setKind] = useState<(typeof KINDS)[number][0]>("all");
  const sorted = useMemo(() => [...(items ?? [])].sort((a, b) => a.since.localeCompare(b.since)), [items]);
  const shown = sorted.filter((i) => kind === "all" || i.kind === kind);
  const selected = shown.find((i) => i.id === params.get("item")) ?? shown[0] ?? null;
  const count = (k: string) => k === "all" ? sorted.length : sorted.filter((i) => i.kind === k).length;
  return <main className="pg" style={{ gap: 0 }}>
    <div className="ph"><h1>Inbox</h1><span className="m">everything waiting on you, oldest first</span>
      <div className="e">{KINDS.filter(([k]) => k !== "all" && count(k)).length < 2 ? null : KINDS.filter(([k]) => k === "all" || count(k)).map(([k, label]) => <button key={k} className={`chipf${kind === k ? " on" : ""}`} aria-pressed={kind === k} onClick={() => setKind(k)}>{label} {count(k)}</button>)}</div></div>
    {error ? <p role="alert">{error.message} <button className="btn ghost sm" onClick={reload}>Try again</button></p> : null}
    {items && !sorted.length ? <section className="sec"><div className="sec-r"><Glyph g="done" /><span>Nothing needs you. When an agent asks a question or for permission, it appears here. To get it on your phone too, set up Notifications in Settings.</span></div></section>
      : <div className="ibx">
        <section className="sec" aria-label="Waiting">
          {shown.map((item) => {
            const lane = lanes?.find((l) => l.id === item.lane);
            return <button key={item.id} className={`irow${item.id === selected?.id ? " on" : ""}`} onClick={() => setParams({ item: item.id })}>
              <Tile family="you" icon={KIND_ICON[item.kind]} label={KIND_WORD[item.kind]} />
              <span style={{ minWidth: 0 }}><span className="who">{lane ? <LaneBadge id={lane.id} colour={lane.colour} /> : null}{projects?.find((p) => p.id === item.lane.split("/")[0])?.name ?? item.lane}</span><span className="tt">{item.title}</span></span>
              <span className="t">{ago(item.since)}</span>
            </button>;
          })}
          {!items ? <Empty>Loading…</Empty> : null}
        </section>
        {selected ? <Detail key={selected.id} item={selected} lane={lanes?.find((l) => l.id === selected.lane)} project={projects?.find((p) => p.id === selected.lane.split("/")[0])} answered={reload} /> : null}
      </div>}
  </main>;
}

function Detail({ item, lane, project, answered }: { item: InboxItem; lane?: Lane; project?: Project; answered: () => void }) {
  const [events, setEvents] = useState<LaneEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const abort = new AbortController();
    void loadHistory(item.lane, apiFetch, abort.signal).then(setEvents, () => {});
    return () => abort.abort();
  }, [item.lane]);
  const requestId = item.id.slice(item.id.indexOf("#") + 1);
  const request = events.find((e) => e.type === "permission.requested" && e.payload.requestId === requestId);
  const detail = request?.type === "permission.requested" ? request.payload.detail : undefined;
  const before = request ? stepsFor(events.filter((e) => e.seq < request.seq)).filter((s) => s.type !== "text" && s.type !== "thought").slice(-3) : [];
  const respond = async (optionId: string) => {
    setBusy(true); setError("");
    try { await answerItem(item, optionId); answered(); } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  };
  const agent = lane ? AGENT_NAMES[lane.agent] ?? lane.agent : "The agent";
  return <section className="sec idet" aria-label="Selected item">
    <div className="sec-h"><Tile family="you" icon={KIND_ICON[item.kind]} small />{lane ? <LaneBadge id={lane.id} colour={lane.colour} /> : null}<h3>{lane?.task ?? item.lane}</h3><span className="m">{project?.name}{lane ? ` · ${agent}` : ""}</span><div className="e"><Glyph g="wait">{KIND_WORD[item.kind]}</Glyph></div></div>
    <div className="sec-b" style={{ padding: "20px 22px" }}>
      <h2>{item.kind === "question" ? `${agent} asks: ` : item.kind === "permission" ? `${agent} wants to: ` : ""}{item.title}</h2>
      {detail ? <div className="out" style={{ margin: "0 0 14px" }}>{detail}</div> : null}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {item.options.map((o, i) => <button key={o.id} className={`btn${i === 0 || o.kind === "allow_once" ? "" : " ghost"}`} disabled={busy} onClick={() => void respond(o.id)}>{o.label}</button>)}
        {!item.options.length ? <Link className="btn" to={item.kind === "review" ? reviewLink(item.lane) : item.kind === "collision" ? `/p/${item.lane.split("/")[0]}/architecture` : `/p/${item.lane.split("/")[0]}/work?lane=${encodeURIComponent(item.lane)}`}>{item.kind === "review" ? "Open the review" : item.kind === "collision" ? "Open the architecture" : "Open the lane"}</Link> : null}
      </div>
      {error ? <p role="alert" style={{ marginBottom: 0 }}>{error}</p> : null}
    </div>
    {before.length ? <div className="led"><div className="lbl" style={{ marginBottom: 6 }}>What led here</div>
      {before.map((s) => <div className="r" key={s.seq}><Tile family={s.family} icon={s.tool ? iconFor(s.tool.kind) : s.type === "plan" ? "plan" : "think"} small /><span>{s.type === "plan" ? "Wrote a plan" : s.title}</span><span className="tm">{new Date(s.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })}</span></div>)}
    </div> : null}
    <div className="sec-f"><Link className="lnk" to={`/p/${item.lane.split("/")[0]}/work?lane=${encodeURIComponent(item.lane)}`}>Open lane {laneNumber(item.lane)} →</Link></div>
  </section>;
}
