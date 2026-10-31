import { useEffect, useRef, type ReactNode } from "react";
import { AGENTS, type LaneState, type StepKind } from "@contextlanes/protocol";

/** A section: the one container every group of content lives in. */
export function Section(props: { title: ReactNode; meta?: ReactNode; end?: ReactNode; tone?: "you"; icon?: ReactNode; children?: ReactNode; footer?: ReactNode; id?: string; help?: ReactNode }) {
  return (
    <section className={`sec${props.tone ? ` ${props.tone}` : ""}`} id={props.id}>
      <div className="sec-h">
        {props.icon}
        <h3>{props.title}</h3>
        {props.help ? <Help>{props.help}</Help> : null}
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

/**
 * Empty states: what goes here in a few words, with an icon and the action that fills it.
 * Never a paragraph; anything longer belongs in a Help next to the section title.
 */
export function Empty(props: { children: ReactNode; icon?: IconName; family?: Family; action?: ReactNode }) {
  if (!props.icon && !props.action) return <div className="empty">{props.children}</div>;
  return <div className="empty lead">{props.icon ? <Tile family={props.family ?? "look"} icon={props.icon} small /> : null}<span>{props.children}</span>{props.action ? <span className="e">{props.action}</span> : null}</div>;
}

/**
 * The explanation behind a signal, one click away instead of always on screen: a small "?" that opens
 * a short note. Use it for how something works; never for what the user must do now.
 */
export function Help(props: { children: ReactNode; label?: string }) {
  const ref = useRef<HTMLDetailsElement>(null);
  // Closes like a popover: a click elsewhere or Escape.
  useEffect(() => {
    const close = (event: Event) => {
      const el = ref.current;
      if (!el?.open) return;
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !el.contains(event.target as Node)) { el.open = false; if (event instanceof KeyboardEvent) event.preventDefault(); }
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close, true);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", close, true); };
  }, []);
  return <details className="help" ref={ref}><summary aria-label={props.label ?? "What is this?"} title={props.label ?? "What is this?"}>?</summary><div className="help-b">{props.children}</div></details>;
}

/** A fact as a signal: glyph, short word, and an optional mono detail. For status rows and summaries. */
export function Fact(props: { g: string; children: ReactNode; detail?: ReactNode }) {
  return <span className="fact"><Glyph g={props.g}>{props.children}</Glyph>{props.detail ? <span className="mono muted">{props.detail}</span> : null}</span>;
}

/** Lane states map onto the seven glyphs of the legend: shape and colour, plus a word. */
export const GLYPH: Record<LaneState, [glyph: "work" | "think" | "wait" | "fail" | "done" | "idle" | "pause", label: string]> = {
  draft: ["idle", "Draft"], setting_up: ["think", "Setting up"], working: ["work", "Working"], needs_you: ["wait", "Needs you"],
  in_review: ["wait", "In review"], merged: ["done", "Merged"], cleaned: ["done", "Cleaned up"], failed: ["fail", "Failed"],
  paused: ["pause", "Paused"], archived: ["idle", "Archived"],
};
export function Glyph({ g, children }: { g: string; children?: ReactNode }) {
  return <span className={`gl ${g}`}><i className={`g ${g}`} aria-hidden="true" />{children}</span>;
}
export function StateGlyph({ state, label = false, idle = false }: { state: LaneState; label?: boolean; idle?: boolean }) {
  const [g, text] = idle ? ["idle", "Idle"] : GLYPH[state];
  return label ? <Glyph g={g}>{text}</Glyph> : <i className={`g ${g}`} role="img" aria-label={text} title={text} />;
}

export function laneNumber(id: string): string { return id.slice(id.lastIndexOf("/") + 1); }
export function LaneBadge({ id, colour, large = false }: { id: string; colour: string; large?: boolean }) {
  return <span className={`lb ${colour}${large ? " lg" : ""}`}>{laneNumber(id)}</span>;
}

export const AGENT_NAMES: Record<string, string> = { ...Object.fromEntries(AGENTS.map((a) => [a.id, a.name])), hermes: "Hermes Agent", ollama: "Ollama", "llama.cpp": "llama.cpp" };
const MARKS: Record<string, [string, string]> = {
  ...Object.fromEntries(AGENTS.map((a) => [a.id, ["oc", a.mark] as [string, string]])),
  "claude-code": ["cc", "CC"], codex: ["cx", "CX"], hermes: ["ha", "HA"], ollama: ["ol", "OL"], "llama.cpp": ["lc", "LC"],
};
/** One mark system for agents and runtimes; official logos can replace these at build time. */
export function AgentMark({ agent, small = false }: { agent: string; small?: boolean }) {
  const [cls, text] = MARKS[agent] ?? ["oc", agent.slice(0, 2).toUpperCase()];
  return <span className={`am ${cls}${small ? " sm" : ""}`} title={AGENT_NAMES[agent] ?? agent}>{text}</span>;
}

/** Step icons from the design canvas, one per kind. Families tint the tile. */
const ICONS = {
  read: <><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v4h4" /><path d="M9 12h6M9 16h6" /></>,
  search: <><circle cx="11" cy="11" r="6" /><path d="m20 20-4.5-4.5" /></>,
  fetch: <><circle cx="12" cy="12" r="8.5" /><path d="M3.5 12h17M12 3.5c2.5 2.6 2.5 14.4 0 17M12 3.5c-2.5 2.6-2.5 14.4 0 17" /></>,
  edit: <><path d="M4 20h4L19 9l-4-4L4 16z" /><path d="m13.5 6.5 4 4" /></>,
  delete: <path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13" />,
  move: <path d="M4 8h14l-3-3M20 16H6l3 3" />,
  execute: <><rect x="3" y="4.5" width="18" height="15" rx="2" /><path d="m7 9.5 3 2.5-3 2.5M12.5 15h4.5" /></>,
  test: <><path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.8 3h10.4A2 2 0 0 0 19 18l-5-9V3" /><path d="M7.5 15h9" /></>,
  environment: <><rect x="4" y="4" width="16" height="6" rx="1.5" /><rect x="4" y="14" width="16" height="6" rx="1.5" /><path d="M8 7h.01M8 17h.01" /></>,
  plan: <><path d="M9 6h11M9 12h11M9 18h11" /><path d="m3.5 6 1.5 1.5L7.5 5M3.5 12l1.5 1.5L7.5 11" /><circle cx="5" cy="18" r="1.2" /></>,
  think: <><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" /><circle cx="12" cy="12" r="2.5" /></>,
  permission: <><path d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6z" /><path d="m9 12 2 2 4-4" /></>,
  question: <><path d="M4 5h16v11H9l-5 4z" /><path d="M10 9a2 2 0 1 1 2.8 1.8c-.6.3-.8.7-.8 1.2M12 14.2v.1" /></>,
  checkpoint: <path d="M5 21V4M5 4h11l-2 4 2 4H5" />,
  handoff: <><path d="M4 12h7M11 12l5-5h4M11 12l5 5h4" /><path d="m18 5 2 2-2 2M18 15l2 2-2 2" /></>,
  subagent: <><circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="12" r="2" /><path d="M6 7v10M6 12h4a4 4 0 0 0 4-4V8M8 12h8" /></>,
  message: <><path d="M4 5h16v11H9l-5 4z" /><path d="M8 9.5h8M8 12.5h5" /></>,
  folder: <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2h8.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z" />,
} as const;
export type IconName = keyof typeof ICONS;
export function Icon({ name }: { name: IconName }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{ICONS[name]}</svg>;
}
export type Family = "look" | "change" | "run" | "mind" | "you" | "team";
export function iconFor(kind: StepKind | "message" | "question"): IconName {
  if (kind === "other") return "read";
  if (kind === "helper") return "subagent";
  return kind in ICONS ? kind as IconName : "read";
}
export function Tile({ family, icon, small = false, label }: { family: Family; icon: IconName; small?: boolean; label?: string }) {
  return <span className={`k ${family}${small ? " sm" : ""}`} role={label ? "img" : undefined} aria-label={label}><Icon name={icon} /></span>;
}

/** Each project gets one of six covers, stable for its id. */
export function coverFor(id: string): string {
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return `cv-${(hash % 10) + 1}`;
}

/** Short age: now, 4m, 3h, 2d. */
export function ago(iso: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 1440)}d`;
}
/** "just now", "3m ago", "2h ago". */
export const agoText = (iso: string, now = Date.now()) => { const a = ago(iso, now); return a === "now" ? "just now" : `${a} ago`; };
export function tildePath(path: string, home?: string | null): string {
  return home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path;
}

/** A modal dialog: Escape and the backdrop close it, focus returns where it was. */
export function Dialog({ title, meta, onClose, children, footer, wide = false }: { title: string; meta?: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    if (!dialog.open) dialog.showModal();
    return () => dialog.close();
  }, []);
  return <dialog ref={ref} className="dlg" style={wide ? { width: "min(820px, calc(100vw - 32px))" } : undefined} aria-label={title}
    onCancel={(e) => { e.preventDefault(); onClose(); }} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="dlg-h"><h2>{title}</h2>{meta ? <span className="m">{meta}</span> : null}<button className="x" aria-label="Close" onClick={onClose}>×</button></div>
    <div className="dlg-b">{children}</div>
    {footer ? <div className="dlg-f">{footer}</div> : null}
  </dialog>;
}
