import React, { useEffect, useRef } from 'react';
import type { ApprovalReview } from '../src/shared/contracts';
import { Chip, PathLink } from './project-card';
export function ApprovalPanel({
  reviews,
  selected,
  onSelect,
  onDecide,
  onClose,
  working,
}: {
  reviews: ApprovalReview[];
  selected: string;
  onSelect: (id: string) => void;
  onDecide: (id: string, approve: boolean) => void;
  onClose: () => void;
  working: boolean;
}) {
  const title = useRef<HTMLHeadingElement>(null),
    review = reviews.find((r) => r.id === selected);
  useEffect(() => {
    title.current?.focus();
    title.current?.scrollIntoView({ block: 'start' });
  }, [selected]);
  return (
    <section className="approval-review box glass" aria-labelledby="approval-title">
      <div className="approval-heading">
        <h2 id="approval-title" ref={title} tabIndex={-1}>
          Review environment
        </h2>
        <button className="btn" onClick={onClose}>
          Close
        </button>
      </div>
      {reviews.length > 1 && (
        <label>
          Pending request
          <select value={selected} onChange={(e) => onSelect(e.target.value)}>
            {reviews.map((r) => (
              <option key={r.id} value={r.id}>
                {r.preview.checkoutPath}
              </option>
            ))}
          </select>
        </label>
      )}
      {!review ? (
        <p role="status">This request is no longer pending. Refresh to see its current recipe status.</p>
      ) : (
        <>
          <PathLink path={review.preview.checkoutPath} />
          <dl className="kv">
            <dt>Recipe SHA256</dt>
            <dd className="mono">{review.recipeHash}</dd>
            <dt>Toolchain revision</dt>
            <dd className="mono">{review.toolchainRevision}</dd>
            <dt>Scope</dt>
            <dd>This recipe and toolchain for this project’s checkouts.</dd>
          </dl>
          {review.stale && (
            <p className="notice bad" role="alert">
              Recipe or toolchain changed. Request a new review before approving.
            </p>
          )}
          {review.preview.services.map((s) => (
            <section className="approval-service box" key={s.id}>
              <h3>
                {s.id} <span className="mono">:{s.port}</span>
              </h3>
              <h4>Command · argument array</h4>
              <pre className="term">{JSON.stringify(s.command, null, 2)}</pre>
              <dl className="kv">
                <dt>Working directory</dt>
                <dd className="mono">{s.cwd}</dd>
                <dt>Environment names</dt>
                <dd className="mono">{s.envNames.join(', ') || '—'}</dd>
                <dt>Readiness</dt>
                <dd className="mono">
                  {s.readiness.path} · HTTP {s.readiness.status} · body includes {JSON.stringify(s.readiness.bodyIncludes)} · {s.readiness.timeoutMs}{' '}
                  ms
                </dd>
              </dl>
            </section>
          ))}
          <h3>Private previews</h3>
          {review.preview.previews.map((p) => (
            <p className="approval-preview" key={p.serviceId}>
              <strong>{p.label}</strong>
              <span className="mono">{p.url}</span>
              <Chip state="Registered">Planned · {p.serviceId}</Chip>
            </p>
          ))}
          {!!review.preview.setup.length && (
            <>
              <h3>Setup hints</h3>
              <p className="pv-note">Informational only. Rootlane never executes these commands.</p>
              <ul>
                {review.preview.setup.map((hint, index) => (
                  <li className="mono" key={index}>
                    {hint}
                  </li>
                ))}
              </ul>
            </>
          )}
          <p className="pv-note">
            Environment values and secrets are never displayed. Approval permits the reviewed commands; it does not start them.
          </p>
          <div className="environment-actions">
            {!working && !review.stale && (
              <button className="btn primary" onClick={() => onDecide(review.id, true)}>
                Approve recipe…
              </button>
            )}
            {!working && (
              <button className="btn" onClick={() => onDecide(review.id, false)}>
                Reject
              </button>
            )}
            {working && <span role="status">Saving…</span>}
          </div>
        </>
      )}
    </section>
  );
}
