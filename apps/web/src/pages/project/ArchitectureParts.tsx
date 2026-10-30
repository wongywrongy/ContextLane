import type { Lane } from "@contextlanes/protocol";
import { LaneBadge } from "../../components/ui";

/** "Two lanes are editing this": who, and how many files each changed. The suggested order and its action arrive with collision warnings. */
export function CollisionBox({ editing }: { project: string; module: string; editing: { lane: Lane; files: string[] }[]; lanes: Lane[] }) {
  return <div className="cbox" role="note">
    <b style={{ fontSize: 14 }}><i className="g wait" aria-hidden="true" /> {editing.length === 2 ? "Two" : editing.length} lanes are editing this</b>
    {editing.map((t) => <div key={t.lane.id} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13.5 }}><LaneBadge id={t.lane.id} colour={t.lane.colour} /><span style={{ minWidth: 0, overflowWrap: "anywhere" }}>{t.lane.task}</span><span className="mono muted" style={{ marginLeft: "auto", fontSize: 12 }}>{t.files.length} {t.files.length === 1 ? "file" : "files"}</span></div>)}
  </div>;
}

/** What agents are told about a module (phase 3.5). Hidden until briefs exist. */
export function BriefBlock(_: { project: string; module: string }) {
  return null;
}
