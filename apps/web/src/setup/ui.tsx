import { useState, type ReactNode } from "react";
import { errorMessage } from "../api";
export function Action({ children, run, done, disabled = false }: { children: ReactNode; run: () => Promise<unknown>; done?: () => void; disabled?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return <><button type="button" className="btn" disabled={busy || disabled} onClick={async () => {
    setBusy(true); setError("");
    try { await run(); done?.(); } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }}>{busy ? "Working…" : children}</button>{error && <p className="setup-error" role="alert">{error}</p>}</>;
}
