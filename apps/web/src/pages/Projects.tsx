import { Link } from "react-router";
import type { Project } from "@contextlanes/protocol";
import { useJson, useInbox } from "../api";
import { Empty, PageHeader, Section } from "../components/ui";

export function ProjectsPage() {
  const [projects] = useJson<Project[]>("/api/projects");
  const [inbox] = useInbox();
  return (
    <main className="page">
      <Section tone="you" title="Needs you" meta={inbox ? `${inbox.length}` : ""} end={<Link to="/inbox">Open inbox →</Link>}>
        {inbox?.length ? (
          inbox.slice(0, 3).map((i) => (
            <div className="sec-r" key={i.id}>
              <i className="g needs_you" />
              <span className="mono" style={{ fontSize: 12 }}>{i.lane}</span>
              <span>{i.title}</span>
            </div>
          ))
        ) : (
          <Empty>Nothing is waiting on you.</Empty>
        )}
      </Section>
      <PageHeader title="Projects" meta={projects ? `${projects.length} repos` : ""} />
      <Section title="All projects">
        {projects?.length ? (
          projects.map((p) => (
            <Link className="sec-r" key={p.id} to={`/p/${p.id}/work`} style={{ textDecoration: "none" }}>
              <b>{p.name}</b>
              <span className="mono muted" style={{ fontSize: 12 }}>{p.path}</span>
            </Link>
          ))
        ) : (
          <Empty>No projects yet. Add one with POST /api/projects or the setup wizard (phase 1).</Empty>
        )}
      </Section>
    </main>
  );
}
