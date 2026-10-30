import { useState } from "react";
import type { FolderListing, Project, RepositoryScan } from "@contextlanes/protocol";
import { postJson, useJson } from "../api";
import { Empty, Section } from "../components/ui";
import { Action } from "./ui";

export function ProjectsSection({ projects, reload }: { projects: Project[] | null; reload: () => void }) {
  const [scan, error, scanAgain] = useJson<RepositoryScan>("/api/setup/projects/scan");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [browsing, setBrowsing] = useState(false);
  const [path, setPath] = useState("");
  const registered = (path: string) => projects?.some((p) => p.path === path);
  return <>
    <Section title="Repositories in your home folder" meta="Nothing is selected for you" end={<button className="btn ghost" onClick={scanAgain}>Scan again</button>}>
      {error ? <Empty>Your home folder could not be scanned. Browse for a repository below.</Empty> : !scan ? <Empty>Looking for Git repositories…</Empty> : <>
        {scan.repositories.map((repo) => <label className="repo-choice" key={repo.path}>
          <input type="checkbox" aria-label={`Select ${repo.name}`} checked={selected.has(repo.path)} disabled={registered(repo.path)} onChange={(e) => setSelected((current) => {
            const next = new Set(current); if (e.target.checked) next.add(repo.path); else next.delete(repo.path); return next;
          })} /><span><strong>{repo.name}</strong><code>{repo.path}</code><span className="muted">{repo.branch ?? "Detached HEAD"}{registered(repo.path) ? " · Added" : ""}</span></span>
        </label>)}
        {!scan.repositories.length && <Empty>No repositories found. Browse for one below.</Empty>}
        {scan.limited && <p className="sec-b muted">Stopped after 2,000 folders. Browse below if your repository is missing.</p>}
        <div className="sec-f"><Action disabled={!selected.size} run={async () => {
          for (const selectedPath of selected) { await postJson("/api/projects", { path: selectedPath }); reload(); }
          setSelected(new Set());
        }}>Add selected projects</Action></div>
      </>}
    </Section>
    <Section title="Choose another folder" meta="Browse home or enter a path">
      <div className="setup-body"><button className="btn ghost" onClick={() => setBrowsing(!browsing)}>{browsing ? "Close folder browser" : "Browse folders"}</button>
        {browsing && <FolderBrowser choose={(chosen) => { setPath(chosen); setBrowsing(false); }} />}
        <label>Repository path<input placeholder="~/code/my-project" value={path} onChange={(e) => setPath(e.target.value)} /></label>
        <Action disabled={!path.trim()} done={() => { setPath(""); reload(); }} run={() => postJson("/api/projects", { path })}>Add folder</Action>
      </div>
    </Section>
    {!!projects?.length && <Section title="Added projects">{projects.map((p) => <div className="sec-r" key={p.id}><i className="g merged" /><b>{p.name}</b><code>{p.path}</code></div>)}</Section>}
  </>;
}
function FolderBrowser({ choose }: { choose: (path: string) => void }) {
  const [path, setPath] = useState("~");
  const [folder, error] = useJson<FolderListing>(`/api/setup/projects/folders?path=${encodeURIComponent(path)}`);
  return <div className="folder-browser" aria-label="Home folder browser">
    {error ? <p role="alert">This folder cannot be opened. Choose another folder.</p> : !folder ? <p>Opening folder…</p> : <>
      <code>{folder.path}</code><div className="setup-actions">{folder.parent && <button className="btn ghost" onClick={() => setPath(folder.parent!)}>Up one folder</button>}<button className="btn" onClick={() => choose(folder.path)}>Use this folder</button></div>
      {folder.folders.map((entry) => <button className="folder-row" key={`${entry.name}:${entry.path}`} onClick={() => setPath(entry.path)}>{entry.name}<span aria-hidden="true">→</span></button>)}
      {!folder.folders.length && <p>No folders inside this folder.</p>}
    </>}
  </div>;
}
