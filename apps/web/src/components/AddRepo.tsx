import { useState } from "react";
import type { FolderListing, GithubListing, Project, RepositoryScan } from "@contextlanes/protocol";
import { errorMessage, postJson, useJson } from "../api";
import { AGENT_NAMES, AgentMark, Dialog, Icon, ago, agoText, tildePath } from "./ui";

/**
 * Add repositories: the ones your agents already worked in and the ones found in your home
 * folder, as a checklist. "Choose a folder" swaps the list for a folder browser inside the
 * same dialog, so it never takes over the page.
 */
export function AddRepoDialog({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [view, setView] = useState<"found" | "browse" | "github">("found");
  const [projects, , reloadProjects] = useJson<Project[]>("/api/projects");
  const [home] = useJson<FolderListing>("/api/setup/projects/folders?path=~");
  const [scan, scanError, rescan] = useJson<RepositoryScan>("/api/setup/projects/scan");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const added = new Set(projects?.map((p) => p.path));
  const homePath = home?.path ?? null;
  const add = async (paths: string[]) => {
    setBusy(true); setError("");
    try {
      for (const path of paths) await postJson("/api/projects", { path });
      reloadProjects(); onAdded(); onClose();
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  };
  if (view === "github") return <FromGithub onBack={() => setView("found")} onClose={onClose} onAdded={() => { reloadProjects(); onAdded(); onClose(); }} />;
  if (view === "browse") return <FolderBrowser home={homePath} onBack={() => setView("found")} onClose={onClose} add={add} busy={busy} error={error} added={added} />;
  const repos = scan?.repositories ?? [];
  const choosable = repos.filter((r) => !added.has(r.path) && !r.note?.startsWith("Owned by"));
  return <Dialog title="Add repositories" meta={scan ? `${repos.length} found` : undefined} onClose={onClose}
    footer={<><button className="btn ghost" onClick={() => setView("browse")}>Choose a folder…</button><button className="btn ghost" onClick={() => setView("github")}>From GitHub…</button>
      <div className="e">{error ? <span role="alert">{error}</span> : null}<button className="btn" disabled={!selected.size || busy} onClick={() => void add([...selected])}>{busy ? "Adding…" : selected.size ? `Add ${selected.size} ${selected.size === 1 ? "repository" : "repositories"}` : "Add repositories"}</button></div></>}>
    {scanError ? <div className="empty">Repositories could not be listed. <button className="lnk" onClick={rescan}>Try again</button> or choose a folder.</div>
      : !scan ? <div className="empty">Looking at your agents’ recent work and your home folder…</div>
      : !repos.length ? <div className="empty">No Git repositories were found. Choose a folder, or clone a repository on this machine first.</div>
      : <>
        {repos.map((repo) => {
          const isAdded = added.has(repo.path);
          const disabled = isAdded || !choosable.includes(repo);
          return <label className={`repo${disabled ? " off" : ""}`} key={repo.path}>
            <input type="checkbox" aria-label={`Select ${repo.name}`} disabled={disabled} checked={isAdded || selected.has(repo.path)} onChange={(e) => setSelected((old) => { const next = new Set(old); if (e.target.checked) next.add(repo.path); else next.delete(repo.path); return next; })} />
            <span style={{ minWidth: 0 }}>
              <span className="nm"><b>{repo.name}</b><span className="mono">{tildePath(repo.path, homePath)}</span></span>
              {repo.note ? <span className={`sub warn`} style={{ display: "block" }}>{repo.note}</span>
                : <span className="sub" style={{ display: "block" }}>{[repo.branch ?? "no branch", repo.usedBy.length ? `used with ${repo.usedBy.map((a) => AGENT_NAMES[a]).join(" and ")}${repo.lastUsed ? ` · ${agoText(repo.lastUsed)}` : ""}` : null].filter(Boolean).join(" · ")}</span>}
            </span>
            <span className="meta">{isAdded ? <span className="sig">added</span> : repo.usedBy.map((a) => <AgentMark key={a} agent={a} small />)}</span>
          </label>;
        })}
        {scan.skipped.length || scan.limited ? <div className="dlg-note">
          {scan.skipped.length ? <>Not searched, because they hold a lot of folders: {scan.skipped.map((p) => tildePath(p, homePath)).join(", ")}. </> : null}
          {scan.limited ? <>The search stopped early. </> : null}
          <button className="lnk" onClick={() => setView("browse")}>Choose a folder</button> if a repository is missing.
        </div> : null}
      </>}
  </Dialog>;
}

function FolderBrowser({ home, onBack, onClose, add, busy, error, added }: { home: string | null; onBack: () => void; onClose: () => void; add: (paths: string[]) => Promise<void>; busy: boolean; error: string; added: Set<string> }) {
  const [path, setPath] = useState("~");
  const [typed, setTyped] = useState("");
  const [listing, listError] = useJson<FolderListing>(`/api/setup/projects/folders?path=${encodeURIComponent(path)}`);
  const crumbs = listing && home ? tildePath(listing.path, home).split("/").filter(Boolean) : [];
  const isAdded = listing ? added.has(listing.path) : false;
  return <Dialog title="Choose a folder" meta="inside your home folder" onClose={onClose}
    footer={<><button className="btn ghost" onClick={onBack}>Back to the list</button>
      <div className="e">{error ? <span role="alert">{error}</span> : null}
        <button className="btn" disabled={!listing?.repo || isAdded || busy} title={listing?.repo ? undefined : "Open a folder that is a Git repository"} onClick={() => listing && void add([listing.path])}>{isAdded ? "Already added" : busy ? "Adding…" : listing?.repo ? `Add ${listing.path.split("/").at(-1)}` : "Open a repository to add it"}</button></div></>}>
    <form className="pathin" onSubmit={(e) => { e.preventDefault(); if (typed.trim()) void add([typed.trim()]); }}>
      <input className="in mono" aria-label="Repository path" placeholder="Or type a path: ~/code/app or /srv/app" value={typed} onChange={(e) => setTyped(e.target.value)} />
      <button className="btn ghost" disabled={!typed.trim() || busy}>Add path</button>
    </form>
    <nav className="crumbs" aria-label="Folder">
      {crumbs.map((part, i) => <span key={i} style={{ display: "contents" }}>{i ? <span>/</span> : null}<button onClick={() => setPath(i === 0 ? "~" : `~/${crumbs.slice(1, i + 1).join("/")}`)}>{part}</button></span>)}
    </nav>
    {listError ? <div className="empty" role="alert">This folder cannot be opened. <button className="lnk" onClick={() => setPath("~")}>Back to home</button></div>
      : !listing ? <div className="empty">Opening…</div>
      : <>
        {listing.parent ? <div className="fold"><button className="go" onClick={() => setPath(listing.parent!)}><span className="up" aria-hidden="true">↑</span>Up one folder</button></div> : null}
        {listing.folders.map((folder) => <div className="fold" key={folder.path}>
          <button className="go" onClick={() => setPath(folder.path)}><Icon name="folder" />{folder.name}{folder.repo ? <span className="tag">git</span> : null}</button>
          {folder.repo ? added.has(folder.path) ? <span className="sig">added</span> : <button className="btn ghost sm" disabled={busy} onClick={() => void add([folder.path])}>Add</button> : null}
        </div>)}
        {!listing.folders.length ? <div className="empty">No folders here.</div> : null}
      </>}
  </Dialog>;
}

/** Your GitHub repositories (through gh on this machine); adding one clones it into the code folder first. */
function FromGithub({ onBack, onClose, onAdded }: { onBack: () => void; onClose: () => void; onAdded: () => void }) {
  const [listing, listError, retry] = useJson<GithubListing>("/api/setup/github");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  const add = async (repo: string) => {
    setBusy(repo); setError("");
    try { await postJson("/api/setup/github/clone", { repo }); onAdded(); } catch (e) { setError(errorMessage(e)); } finally { setBusy(null); }
  };
  const repos = listing?.available ? listing.repos.filter((r) => !filter || r.name.toLowerCase().includes(filter.toLowerCase())) : [];
  return <Dialog title="Add from GitHub" meta={listing?.available ? `clones into ${listing.folder}` : undefined} onClose={onClose}
    footer={<><button className="btn ghost" onClick={onBack}>Back</button><div className="e">{error ? <span role="alert">{error}</span> : null}</div></>}>
    {listError ? <div className="empty">Your repositories could not be listed. <button className="lnk" onClick={retry}>Try again</button></div>
      : !listing ? <div className="empty">Asking GitHub for your repositories…</div>
      : !listing.available ? <div className="empty">{listing.reason}</div>
      : <>
        <input className="in" aria-label="Filter repositories" placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ marginBottom: 8 }} />
        {repos.map((r) => <div className="repo" key={r.name}>
          <span style={{ minWidth: 0 }}>
            <span className="nm"><b>{r.name}</b>{r.private ? <span className="mono">private</span> : null}</span>
            <span className="sub" style={{ display: "block" }}>{[r.description, `updated ${agoText(r.updatedAt)}`, r.cloned ? "already on this machine" : null].filter(Boolean).join(" · ")}</span>
          </span>
          <span className="meta"><button className="btn sm" disabled={!!busy} onClick={() => void add(r.name)}>{busy === r.name ? (r.cloned ? "Adding…" : "Cloning…") : r.cloned ? "Add" : "Clone and add"}</button></span>
        </div>)}
        {!repos.length ? <div className="empty">No repositories match.</div> : null}
      </>}
  </Dialog>;
}
