import { useState } from "react";
import type { FolderListing, Project, RepositoryScan } from "@contextlanes/protocol";
import { errorMessage, postJson, useJson } from "../api";
import { AGENT_NAMES, AgentMark, Dialog, Icon, ago, tildePath } from "./ui";

/**
 * Add repositories: the ones your agents already worked in and the ones found in your home
 * folder, as a checklist. "Choose a folder" swaps the list for a folder browser inside the
 * same dialog, so it never takes over the page.
 */
export function AddRepoDialog({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [view, setView] = useState<"found" | "browse">("found");
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
  if (view === "browse") return <FolderBrowser home={homePath} onBack={() => setView("found")} onClose={onClose} add={add} busy={busy} error={error} added={added} />;
  const repos = scan?.repositories ?? [];
  const choosable = repos.filter((r) => !added.has(r.path) && !r.note?.startsWith("Owned by"));
  return <Dialog title="Add repositories" meta={scan ? `${repos.length} found` : undefined} onClose={onClose}
    footer={<><button className="btn ghost" onClick={() => setView("browse")}>Choose a folder…</button>
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
                : <span className="sub" style={{ display: "block" }}>{[repo.branch ?? "no branch", repo.usedBy.length ? `used with ${repo.usedBy.map((a) => AGENT_NAMES[a]).join(" and ")}${repo.lastUsed ? ` · ${ago(repo.lastUsed)} ago` : ""}` : null].filter(Boolean).join(" · ")}</span>}
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
