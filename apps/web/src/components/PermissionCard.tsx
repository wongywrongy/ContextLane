import { useState } from "react";
import { Link } from "react-router";
import type { InboxItem } from "@contextlanes/protocol";
import { postJson } from "../api";

export function PermissionCard({ item, answered }: { item: InboxItem; answered: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const respond = async (optionId: string) => {
    setBusy(true); setError("");
    try {
      await postJson("/api/answers", { lane: item.lane, requestId: item.id.slice(item.id.indexOf("#") + 1), optionId, via: window.matchMedia("(max-width: 760px)").matches ? "phone" : "web" });
      answered();
    } catch (err) { setError(err instanceof Error ? err.message : "Could not send your answer. Try again."); }
    finally { setBusy(false); }
  };
  return (
    <div className="permission-card">
      <div className="permission-title"><i className="g needs_you" aria-hidden="true" /><strong>{item.title}</strong><Link className="mono" to={`/p/${item.lane.split("/")[0]}/work`}>{item.lane}</Link></div>
      <div className="permission-actions">
        {item.options.filter((o) => o.kind === "allow_once" || o.kind === "reject_once").map((option) => <button key={option.id} className={`btn${option.kind === "reject_once" ? " ghost" : ""}`} disabled={busy} onClick={() => void respond(option.id)}>{option.label}</button>)}
        {item.kind === "review" ? <Link className="btn" to={`/p/${item.lane.split("/")[0]}/review`}>Open review</Link> : null}
      </div>
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}
