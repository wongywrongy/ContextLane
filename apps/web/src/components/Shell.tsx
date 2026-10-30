import { NavLink, Outlet, useParams } from "react-router";
import type { Health, InboxItem } from "@contextlanes/protocol";
import { useJson } from "../api";

export function Shell() {
  const [health, down] = useJson<Health>("/api/health");
  const [inbox] = useJson<InboxItem[]>("/api/inbox");
  return (
    <>
      <header className="top">
        <NavLink className="wm" to="/">Context<span className="ln">Lanes</span></NavLink>
        <nav className="gnav" aria-label="Main">
          <NavLink to="/" end>Projects</NavLink>
          <NavLink to="/inbox">Inbox{inbox?.length ? <span className="count">{inbox.length}</span> : null}</NavLink>
          <NavLink to="/models">Models</NavLink>
          <NavLink to="/settings">Settings</NavLink>
        </nav>
        <span className={`host${down ? " down" : ""}`} title={down ? "Daemon not reachable" : "Machine online"}><i />{health?.host ?? "…"}</span>
      </header>
      <Outlet />
    </>
  );
}

const TABS = [
  ["work", "Work"],
  ["review", "Review"],
  ["run", "Run"],
  ["architecture", "Architecture"],
  ["insights", "Insights"],
] as const;

export function ProjectShell() {
  const { project = "" } = useParams();
  return (
    <>
      <section className="band" aria-label="Project">
        <div className="meta">Projects / {project}</div>
        <h1>{project}</h1>
      </section>
      <nav className="tabs" aria-label="Project">
        {TABS.map(([path, label]) => (
          <NavLink key={path} to={`/p/${project}/${path}`}>{label}</NavLink>
        ))}
      </nav>
      <Outlet />
    </>
  );
}
