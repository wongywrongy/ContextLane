import type { ReactNode } from "react";
import type { LaneState } from "@contextlanes/protocol";

/** A section: the one container every group of content lives in. */
export function Section(props: { title: ReactNode; meta?: ReactNode; end?: ReactNode; tone?: "you"; children?: ReactNode; footer?: ReactNode }) {
  return (
    <section className={`sec${props.tone ? ` ${props.tone}` : ""}`}>
      <div className="sec-h">
        <h3>{props.title}</h3>
        {props.meta ? <span className="m">{props.meta}</span> : null}
        {props.end ? <div className="e">{props.end}</div> : null}
      </div>
      {props.children}
      {props.footer ? <div className="sec-f">{props.footer}</div> : null}
    </section>
  );
}

export function PageHeader(props: { title: string; meta?: ReactNode; end?: ReactNode }) {
  return (
    <div className="ph">
      <h1>{props.title}</h1>
      {props.meta ? <span className="m">{props.meta}</span> : null}
      {props.end ? <div className="e">{props.end}</div> : null}
    </div>
  );
}

/** Empty states say what will be here and when, instead of leaving a blank box. */
export function Empty(props: { children: ReactNode }) {
  return <div className="empty">{props.children}</div>;
}

const STATE_LABEL: Record<LaneState, string> = {
  draft: "Draft", setting_up: "Setting up", working: "Working", needs_you: "Needs you", in_review: "In review",
  merged: "Merged", cleaned: "Cleaned up", failed: "Failed", paused: "Paused", archived: "Archived",
};

export function StateGlyph({ state, label = false }: { state: LaneState; label?: boolean }) {
  return (
    <span className="gl" title={STATE_LABEL[state]}>
      <i className={`g ${state}`} aria-hidden="true" />
      {label ? STATE_LABEL[state] : <span className="sr-only" style={{ position: "absolute", left: -9999 }}>{STATE_LABEL[state]}</span>}
    </span>
  );
}

export function LaneBadge({ id, colour }: { id: string; colour: string }) {
  return <span className="lb" style={{ background: `var(--${colour})` }}>{id.slice(id.lastIndexOf("/") + 1)}</span>;
}

const MARKS: Record<string, [string, string]> = {
  "claude-code": ["cc", "CC"], codex: ["cx", "CX"], opencode: ["oc", "OC"], hermes: ["ha", "HA"], ollama: ["ol", "OL"], "llama.cpp": ["lc", "LC"],
};

/** One mark system for agents and runtimes; official logos can replace these at build time. */
export function AgentMark({ agent }: { agent: string }) {
  const [cls, text] = MARKS[agent] ?? ["oc", agent.slice(0, 2).toUpperCase()];
  return <span className={`am ${cls}`} title={agent}>{text}</span>;
}
