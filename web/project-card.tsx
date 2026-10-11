import React, { useEffect, useRef, useState } from 'react';
import type { Environment, PreviewStatus, Project, ProjectDetails, Operation, PreviewOperation } from '../src/shared/contracts';
import {
  agentKey,
  branchLabel,
  chipTone,
  pillState,
  editorHref,
  groupAgents,
  groupServices,
  groupLinks,
  type GroupLink,
  label,
  recipePresentation,
  type ProjectGroup,
} from './projects';
import { Icon } from './icons';
import { ClaudeMark } from './marks/claude';
import { CodexMark } from './marks/codex';
export type DetailTab = 'Worktrees' | 'Agents' | 'Services' | 'Links' | 'Environment' | 'Activity';
export const time = (value?: string | null) =>
  value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleTimeString('en-GB', { hour12: false }) : '—';
const date = (value?: string | null) => (value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : '—');
export function Chip({ state, children }: { state: string; children?: React.ReactNode }) {
  const tone = chipTone(state);
  return <span className={`chip lp sm ${['Ready', 'Available', 'Listening', 'Published', 'Stopped', 'Down', 'Unknown', 'Link'].includes(state) ? pillState(state) : tone}`} title={state} aria-label={state}><span className="d" aria-hidden="true"/>{children ?? (state === 'Unknown' ? '—' : state)}</span>;
}
export function Mark({ name }: { name: string }) {
  const vendor = name === 'Codex' ? 'codex' : name === 'Claude Code' ? 'claude' : 'other';
  return (
    <span className={`mark ${vendor}`} aria-hidden="true">
      {vendor === 'claude' ? <ClaudeMark /> : vendor === 'codex' ? <CodexMark /> : name.slice(0, 2).toUpperCase()}
    </span>
  );
}
export function PathLink({ path, template, host }: { path: string; template?: string | null; host?: string | null }) {
  const href = editorHref(path, template, host);
  const [notice, setNotice] = useState('');
  return href ? (
    <a className="path" href={href} title="Open folder in editor">
      <span className="path-value">{path}</span>
      <Icon name="external" />
    </a>
  ) : (
    <span className="path">
      <span className="path-value">{path}</span>
      <button
        className="copy-path"
        aria-label={`Copy ${path}`}
        onClick={() => {
          void navigator.clipboard
            .writeText(path)
            .then(() => setNotice('Copied'))
            .catch(() => setNotice('Copy unavailable. Select the path.'));
        }}
      >
        {notice === 'Copied' ? 'Copied' : 'Copy'}
      </button>
      {notice && (
        <span className={`copy-notice${notice === 'Copied' ? ' sr-only' : ''}`} role="status">
          {notice}
        </span>
      )}
    </span>
  );
}
function Table({ headings, children }: { headings: string[]; children: React.ReactNode }) {
  const rows = React.Children.map(children, (row) => {
    if (!React.isValidElement<{ children: React.ReactNode; role?: string }>(row)) return row;
    return React.cloneElement(row, {
      role: 'row',
      children: React.Children.map(row.props.children, (cell, index) =>
        React.isValidElement<{ children?: React.ReactNode; role?: string; 'data-label'?: string }>(cell)
          ? React.cloneElement(cell, {
              'data-label': headings[index],
              role: 'cell',
              children: <span className="cell-value">{cell.props.children}</span>,
            })
          : cell,
      ),
    });
  });
  return (
    <div className="tbl-wrap" tabIndex={0} aria-label={`${headings.join(', ')} table`}>
      <table className="tbl" role="table">
        <thead>
          <tr role="row">
            {headings.map((h) => (
              <th scope="col" key={h}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{rows}</tbody>
      </table>
    </div>
  );
}
export function ProjectDetailsPanel({
  group,
  tab,
  onOpen,
  environments,
  environmentErrors,
  previews,
  previewErrors,
  details,
  projectError,
  stale,
  lifecycleAvailable,
  observedAt,
  working,
  onAction,
  onLogs,
  logs,
  logsError,
  editorTemplate,
  editorHost,
  activity,
  activityError,
  onRequest,
  onClose,
}: {
  editorTemplate: string | null;
  editorHost: string | null;
  activity: (Operation | PreviewOperation)[];
  activityError: string;
  onRequest: (path: string) => void;
  onClose: () => void;
  group: ProjectGroup;
  tab: DetailTab;
  onOpen: (tab?: DetailTab) => void;
  environments: Record<string, Environment>;
  environmentErrors: Record<string, string>;
  previews: Record<string, PreviewStatus>;
  previewErrors: Record<string, string>;
  details: ProjectDetails | null;
  projectError: string;
  stale: boolean;
  lifecycleAvailable: boolean;
  observedAt: string | undefined;
  working: string | null;
  onAction: (id: string, action: 'start' | 'stop' | 'publish' | 'unpublish') => void;
  onLogs: (id: string, service: string) => void;
  logs: { title: string; lines: string[]; truncated: boolean } | null;
  logsError: string;
}) {
  const project = group.primary;
  const agents = groupAgents(group);
  const services = groupServices(group, environments);
  const managed = group.environmentIds.length > 0;
  const envs = group.environmentIds.flatMap((id) => (environments[id] ? [environments[id]] : []));
  const publications = Object.values(previews).filter((p) => group.checkouts.some((c) => c.path === p.checkoutPath));
  const previewStale =
    stale || !!projectError || group.environmentIds.some((id) => environmentErrors[id]) || publications.some((p) => previewErrors[p.id]);
  const links = groupLinks(group, environments, previews, details);
  if (previewStale) for (const link of links) link.state = 'Unknown';
  const operations = activity;

  const conflict =
    !!working ||
    group.checkouts.flatMap((p) => p.controls ?? []).some((e) => ['accepted', 'running'].includes(e.latestOperation?.status ?? '')) ||
    envs.some((e) => ['accepted', 'running'].includes(e.latestOperation?.status ?? '')) ||
    publications.some((p) => ['accepted', 'running'].includes(p.latestOperation?.status ?? ''));
  const activeOperation = (env: { latestOperation: Operation | null }) => ['accepted', 'running'].includes(env.latestOperation?.status ?? '');
  const controls = (env: {
    id: string;
    desiredState: string;
    application?: string;
    hasResources?: boolean;
    startAllowed: boolean;
    latestOperation: Operation | null;
  }) =>
    !stale &&
    !environmentErrors[env.id] &&
    lifecycleAvailable &&
    !conflict &&
    !activeOperation(env) &&
    (env.desiredState === 'running' || env.hasResources || (env.application && env.application !== 'stopped') ? (
      <button className="btn" onClick={() => onAction(env.id, 'stop')}>
        Stop{envs.length > 1 ? ` ${label(env.id)}` : ''}
      </button>
    ) : env.startAllowed ? (
      <button className="btn" onClick={() => onAction(env.id, 'start')}>
        Start{envs.length > 1 ? ` ${label(env.id)}` : ''}
      </button>
    ) : null);
  const logServices = group.checkouts.flatMap((p) => p.logServices);
  const tabs: DetailTab[] = ['Worktrees', 'Agents', 'Services', 'Links', 'Activity', ...(managed ? ['Environment' as const] : [])];
  const activeTab = tabs.includes(tab) ? tab : 'Worktrees';
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !(event.target as HTMLElement).closest('[popover]')) onClose(); };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [onClose]);
  const agentCheckout = (a: Project['agents'][number]) =>
    group.checkouts.find((p) =>
      a.source === 'detected process' && a.worktreePath ? p.path === a.worktreePath : p.agents.some((other) => agentKey(other) === agentKey(a)),
    );
  const count = (t: DetailTab) =>
    t === 'Worktrees' ? group.checkouts.length : t === 'Agents' ? agents.length : t === 'Services' ? services.length : t === 'Links' ? links.length : t === 'Activity' ? operations.length : envs.length;
  const recipeCheckout = group.checkouts.find((p) => p.recipe?.found);
  const recipe = recipeCheckout?.recipe;
  const http = (checkoutId: string, port: number) => details?.http?.find((h) => h.checkoutId === checkoutId && h.port === port)?.http;
  return (
    <section className="details-drawer dpanel" aria-label={`${project.name} details`}>
      <header className="drawer-header">
        <div><h2 id={`details-title-${project.id}`}>{project.name}</h2><span className="mono muted">{project.path}</span></div>
        <button className="btn" onClick={onClose}>Close</button>
      </header>
      {recipe?.found && <div className="drawer-recipe"><Chip state={recipePresentation(recipe).state}>Recipe · {recipePresentation(recipe).text}</Chip>{recipe.valid && recipe.approval !== 'approved' && !stale && !working && <button className="btn" onClick={() => onRequest(recipeCheckout!.path)}>Request environment…</button>}</div>}
      <div className="details project-details" id={`details-${project.id}`}>
          <div
            className="tabs dtabs seg"
            role="tablist"
            aria-label={`${project.name} details`}
            onKeyDown={(event) => {
              if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
              event.preventDefault();
              const index = tabs.indexOf(activeTab);
              const next =
                event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? tabs.length - 1
                    : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
              onOpen(tabs[next]);
              document.getElementById(`tab-${project.id}-${tabs[next]}`)?.focus();
            }}
          >
            {tabs.map((t) => (
              <button
                className={`tab ${t === activeTab ? 'on' : ''}`}
                role="tab"
                aria-selected={t === activeTab}
                tabIndex={t === activeTab ? 0 : -1}
                id={`tab-${project.id}-${t}`}
                aria-controls={`panel-${project.id}`}
                key={t}
                onClick={() => onOpen(t)}
              >
                {t}
                {count(t) !== null && <b>{count(t)}</b>}
              </button>
            ))}
          </div>
          <div className="panel dbody" role="tabpanel" id={`panel-${project.id}`} aria-labelledby={`tab-${project.id}-${activeTab}`} tabIndex={0}>
            {recipe?.errors.map((e) => (
              <p className="notice bad" role="alert" key={e.code}>
                {e.code} · {e.message}
              </p>
            ))}
            {projectError && (
              <p className="notice bad" role="alert">
                {projectError} · Details observation stale
              </p>
            )}
            {group.checkouts.filter(p => p.runtime.status === 'unknown').map(p => <p className="notice bad" role="alert" key={p.id}>Listener observation unavailable · {p.path}</p>)}
            {stale && <p className="notice">Showing the last successful observation.</p>}
            {activeTab === 'Worktrees' && <WorktreesTab group={group} editorTemplate={editorTemplate} editorHost={editorHost} />}
            {activeTab === 'Agents' && <AgentsTab agents={agents} agentCheckout={agentCheckout} />}
            {activeTab === 'Services' && <ServicesTab services={services} stale={stale} environmentErrors={environmentErrors} http={http} />}
            {activeTab === 'Links' && (
              <LinksTab
                links={links}
                publications={publications}
                details={details}
                enabled={!previewStale && lifecycleAvailable && !conflict}
                onAction={onAction}
                previewErrors={previewErrors}
              />
            )}
            {activeTab === 'Environment' && (
              <EnvironmentTab
                group={group}
                environments={environments}
                stale={stale}
                environmentErrors={environmentErrors}
                controls={controls}
                logServices={logServices}
                onLogs={onLogs}
                activeOperation={activeOperation}
                logs={logs}
                logsError={logsError}
              />
            )}
            {activeTab === 'Activity' && (
              <ActivityTab activityError={activityError} operations={operations} envs={envs} observedAt={observedAt} services={services} />
            )}
          </div>
        </div>
    </section>
  );
}

function LinksTab({
  links,
  publications,
  details,
  enabled,
  onAction,
  previewErrors,
}: {
  links: GroupLink[];
  publications: PreviewStatus[];
  details: ProjectDetails | null;
  enabled: boolean;
  onAction: (id: string, action: 'publish' | 'unpublish') => void;
  previewErrors: Record<string, string>;
}) {
  return (
    <>
      <div className="environment-actions">
        {enabled &&
          details?.approvedTargetIds
            .filter((id) => !publications.some((p) => p.targetId === id && !p.removed))
            .map((id) => (
              <button className="btn primary" key={id} onClick={() => onAction(id, 'publish')}>
                Publish {label(id)}
              </button>
            ))}
        {enabled &&
          publications
            .filter((p) => !p.removed)
            .map((p) => (
              <button className="btn" key={p.id} onClick={() => onAction(p.id, 'unpublish')}>
                Unpublish {p.serviceName}
              </button>
            ))}
      </div>
      <Table headings={['Label', 'URL', 'Source', 'Target', 'HTTPS', 'Verified', 'State']}>
        {links.map((link) => (
          <tr key={link.key}>
            <td>{link.label}</td>
            <td>
              <a className="pv-url mono" href={link.url} target="_blank" rel="noreferrer" aria-label={`${link.label}, ${link.url}`}>
                <span>{link.url}</span>
                <Icon name="external" />
              </a>
            </td>
            <td>{link.source}</td>
            <td className="mono">{link.target ?? '—'}</td>
            <td>{link.https ?? '—'}</td>
            <td>{date(link.verifiedAt)}</td>
            <td>
              <Chip state={link.state} />
              {link.operation && (
                <span className="operation-status" role="status">
                  {link.operation.action} · {label(link.operation.status)}
                  {link.operation.error && ` · ${link.operation.error.code}: ${link.operation.error.message}`}
                </span>
              )}
              {previewErrors[link.key] && <span role="alert">{previewErrors[link.key]} · Observation stale</span>}
            </td>
          </tr>
        ))}
      </Table>
      {!links.length && <p className="empty">No links</p>}
    </>
  );
}

type CardProps = Parameters<typeof ProjectDetailsPanel>[0];

function WorktreesTab({
  group,
  editorTemplate,
  editorHost,
}: {
  group: CardProps['group'];
  editorTemplate: CardProps['editorTemplate'];
  editorHost: CardProps['editorHost'];
}) {
  return (
    <Table headings={['Name', 'Branch', 'Changes', 'Ahead / behind', 'Last commit', 'Path', 'Listening ports', 'Agents']}>
      {group.checkouts.map((p) => (
        <tr key={p.id}>
          <td className="strong">{p.name}</td>
          <td className="mono">{branchLabel(p)}</td>
          <td className="mono">{p.git?.dirty ?? '—'}</td>
          <td className="mono">
            {p.git?.ahead ?? '—'} / {p.git?.behind ?? '—'}
          </td>
          <td>
            <span className="mono">{p.git?.lastCommit?.sha7 ?? '—'}</span> {p.git?.lastCommit?.subject}
            <span className="muted"> {p.git?.lastCommit ? date(p.git.lastCommit.committedAt) : ''}</span>
          </td>
          <td>
            <PathLink path={p.path} template={editorTemplate} host={editorHost} />
          </td>
          <td className="mono">{p.runtime.ports.map((port) => ':' + port).join(', ') || '—'}</td>
          <td>{p.agents.length || '—'}</td>
        </tr>
      ))}
    </Table>
  );
}

function AgentsTab({
  agents,
  agentCheckout,
}: {
  agents: ReturnType<typeof groupAgents>;
  agentCheckout: (agent: Project['agents'][number]) => Project | undefined;
}) {
  return (
    <>
      <Table headings={['Agent', 'Source', 'Checkout', 'Working directory', 'Process started', 'Process id', 'Ports']}>
        {agents.map((a) => (
          <tr key={agentKey(a)}>
            <td>
              <span className="agent-name">
                <Mark name={a.name} />
                {a.name}
              </span>
            </td>
            <td>{a.source === 'detected process' ? 'Detected process' : 'Owner registration'}</td>
            <td className="mono">{agentCheckout(a)?.path ?? '—'}</td>
            <td className="mono">{a.source === 'detected process' ? a.cwd ?? '—' : '—'}</td>
            <td className="mono">{a.source === 'detected process' ? date(a.startedAt) : '—'}</td>
            <td className="mono">{a.source === 'detected process' ? (a.pid ?? '—') : '—'}</td>
            <td className="mono">{a.source === 'detected process' ? a.ports?.map(port => ':' + port).join(', ') || '—' : '—'}</td>
          </tr>
        ))}
      </Table>
      {!agents.length && <p className="empty">No agents attached.</p>}
      <p className="pv-note">Rootlane doesn't read transcripts or infer activity.</p>
    </>
  );
}

function ServicesTab({
  services,
  stale,
  environmentErrors,
  http,
}: {
  services: ReturnType<typeof groupServices>;
  stale: CardProps['stale'];
  environmentErrors: CardProps['environmentErrors'];
  http: (checkoutId: string, port: number) => NonNullable<ProjectDetails['http']>[number]['http'] | undefined;
}) {
  return (
    <>
      <Table headings={['Name', 'Endpoint', 'Process', 'Started', 'Checkout', 'Unit', 'Ownership', 'Started by', 'State', 'HTTP']}>
        {services.map((s) => (
          <tr key={s.key}>
            <td>{s.name}</td>
            <td className="mono">{s.checkout.runtime.listeners?.find(l => l.port === s.port)?.loopback ? `localhost:${s.port}` : `:${s.port} · bind address unknown`}</td>
            <td className="mono">{s.process?.pid ?? '—'}</td>
            <td className="mono">{date(s.process?.startedAt)}</td>
            <td className="mono">{s.checkout.path}</td>
            <td className="mono">{s.unit}</td>
            <td>{s.managed ? 'Rootlane' : 'Observe-only'}</td>
            <td>{s.startedBy ? `${s.startedBy.name} · PID ${s.startedBy.pid}` : '—'}</td>
            <td>
              <Chip state={stale || s.checkout.environmentIds.some((id) => environmentErrors[id]) ? 'Unknown' : s.state} />
            </td>
            <td className="mono">{http(s.checkout.id, s.port) ? `HTTP ${http(s.checkout.id, s.port)!.status}` : '—'}</td>
          </tr>
        ))}
      </Table>
      {!services.length && <p className="empty">No services observed.</p>}
    </>
  );
}

function EnvironmentTab({
  group,
  environments,
  stale,
  environmentErrors,
  controls,
  logServices,
  onLogs,
  activeOperation,
  logs,
  logsError,
}: {
  group: CardProps['group'];
  environments: CardProps['environments'];
  stale: CardProps['stale'];
  environmentErrors: CardProps['environmentErrors'];
  controls: (env: Environment | NonNullable<Project['controls']>[number]) => React.ReactNode;
  logServices: Project['logServices'];
  onLogs: CardProps['onLogs'];
  activeOperation: (env: { latestOperation: Operation | null }) => boolean;
  logs: CardProps['logs'];
  logsError: CardProps['logsError'];
}) {
  return (
    <>
      <Table headings={['Checkout / instance', 'Ports', 'Previews', 'Application', 'Actions']}>
        {group.environmentIds.map((id) => {
          const env = environments[id],
            checkout = group.checkouts.find((p) => p.environmentIds.includes(id));
          return (
            <tr key={id}>
              <td>
                <strong>{checkout?.branch ?? checkout?.name ?? '—'}</strong>
                <span className="instance-id mono">{id}</span>
              </td>
              <td className="mono">
                {env
                  ? Object.entries(env.ports ?? {}).map(([name, port]) => (
                      <div key={name}>
                        {name} :{port}
                      </div>
                    ))
                  : '—'}
              </td>
              <td>
                {env?.previews?.length
                  ? env.previews.map((p) => (
                      <a className="pv-url" href={p.url} key={p.serviceId} target="_blank" rel="noreferrer">
                        {p.url}
                        <Icon name="external" />
                      </a>
                    ))
                  : '—'}
              </td>
              <td>
                {env ? <Chip state={stale || environmentErrors[id] || env.observationError ? 'Unknown' : label(env.application)} /> : '—'}
                {environmentErrors[id] && (
                  <p className="notice bad" role="alert">
                    {environmentErrors[id]} · Observation stale
                  </p>
                )}
                {env?.latestOperation?.error && (
                  <p className="notice bad" role="alert">
                    {env.latestOperation.error.code} · {env.latestOperation.error.message}
                  </p>
                )}
              </td>
              <td>
                <div className="environment-actions">
                  {env && controls(env)}
                  {logServices
                    .filter((s) => s.environmentId === id)
                    .map((s) => (
                      <button className="btn" key={s.serviceId} onClick={() => onLogs(id, s.serviceId)}>
                        <Icon name="logs" />
                        {label(s.serviceId)} logs
                      </button>
                    ))}
                  {env && activeOperation(env) && <Chip state="Working" />}
                </div>
              </td>
            </tr>
          );
        })}
      </Table>
      <p className="pv-note">Preview URLs are allocated addresses. Availability is verified separately in Links.</p>
      {group.environmentIds.map((id) => {
        const env = environments[id];
        return (
          env && (
            <details className="environment" key={id}>
              <summary>{label(id)} · profile and latest operation</summary>
              <div className="grid-2">
                <div className="box">
                  <h4>Environment</h4>
                  <dl className="kv">
                    <dt>Checkout</dt>
                    <dd className="mono">{group.checkouts.find((p) => p.environmentIds.includes(id))?.path ?? '—'}</dd>
                    <dt>Profile</dt>
                    <dd className="mono">{env.id}</dd>
                    <dt>Revision</dt>
                    <dd className="mono">{env.profileRevision}</dd>
                    <dt>Desired state</dt>
                    <dd>{env.desiredState}</dd>
                    <dt>Application</dt>
                    <dd>{env.application}</dd>
                    <dt>Effects</dt>
                    <dd>{env.effects}</dd>
                    <dt>Data requirements</dt>
                    <dd>{env.dataRequirements}</dd>
                  </dl>
                </div>
                <div className="box">
                  <h4>Latest operation</h4>
                  <dl className="kv">
                    <dt>Action</dt>
                    <dd>{env.latestOperation?.action ?? '—'}</dd>
                    <dt>Status</dt>
                    <dd>{env.latestOperation ? <Chip state={label(env.latestOperation.status)} /> : '—'}</dd>
                    <dt>Requested</dt>
                    <dd>{date(env.latestOperation?.createdAt)}</dd>
                    <dt>Finished</dt>
                    <dd>{date(env.latestOperation?.finishedAt)}</dd>
                    <dt>Operation id</dt>
                    <dd className="mono">{env.latestOperation?.id.slice(0, 8) ?? '—'}</dd>
                  </dl>
                </div>
              </div>
              {env.observationError && (
                <p className="notice bad" role="alert">
                  {env.observationError.message}
                </p>
              )}
            </details>
          )
        );
      })}
      {logs && (
        <section className="logs">
          <h4>{logs.title}</h4>
          {logsError && (
            <p className="notice bad" role="alert">
              {logsError}
              {logs.lines.length > 0 ? ' · Showing retained log output.' : ''}
            </p>
          )}
          {logs.truncated && <p className="pv-note">Latest 50 entries, up to 2 KiB each.</p>}
          <pre className="term">{logs.lines.join('\n') || 'No recorded output available.'}</pre>
        </section>
      )}
    </>
  );
}

function ActivityTab({
  activityError,
  operations,
  envs,
  observedAt,
  services,
}: {
  activityError: CardProps['activityError'];
  operations: (Operation | PreviewOperation)[];
  envs: Environment[];
  observedAt: CardProps['observedAt'];
  services: ReturnType<typeof groupServices>;
}) {
  return (
    <div className="timeline">
      {activityError && (
        <p className="notice bad" role="alert">
          {activityError}
        </p>
      )}
      {!operations.length && !activityError && <p className="empty">No recorded operations.</p>}
      {operations.map((op) => (
        <div className="ev" key={op.id}>
          <time title={date(op.createdAt)}>{time(op.createdAt)}</time>
          <Chip state={label(op.status)} />
          <div>
            {label(op.action)} · {label('environmentId' in op ? op.environmentId : op.previewId)}
            <span className="mono muted"> · {op.id.slice(0, 8)}</span>
            {op.error && (
              <p>
                {op.error.code} · {op.error.message}
              </p>
            )}
          </div>
        </div>
      ))}
      {envs.map((e) => (
        <div className="ev" key={e.id}>
          <time title={date(e.observedAt)}>{time(e.observedAt)}</time>
          <Icon name="refresh" />
          <div>
            Observed {label(e.id)} · {e.application} · preview {e.preview}
          </div>
        </div>
      ))}
      <div className="ev">
        <time>{time(observedAt)}</time>
        <Icon name="refresh" />
        <div>Current catalog observation · {services.filter((s) => s.state === 'Listening').length} listeners</div>
      </div>
    </div>
  );
}
