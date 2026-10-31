import { useState, type ReactNode } from "react";
import { errorMessage } from "../api";

/** A button that runs one request, shows "Working…", and says in one sentence what went wrong. */
export function Action({ children, run, done, disabled = false, small = false, ghost = false }: { children: ReactNode; run: () => Promise<unknown>; done?: () => void; disabled?: boolean; small?: boolean; ghost?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return <><button type="button" className={`btn${small ? " sm" : ""}${ghost ? " ghost" : ""}`} disabled={busy || disabled} aria-busy={busy || undefined} onClick={async () => {
    setBusy(true); setError("");
    try { await run(); done?.(); } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }}>{children}</button>{error ? <span role="alert">{error}</span> : null}</>;
}
