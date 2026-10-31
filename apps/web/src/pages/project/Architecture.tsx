import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useParams, useSearchParams } from "react-router";
import { AREA_THRESHOLD, areaOf, assign, codeAreas, type CodeArea, type CodeMap, type Lane, type Project, type ProjectMap } from "@contextlanes/protocol";
import { useJson } from "../../api";
import { useProjectWork } from "../../components/Shell";
import { NewLaneDialog } from "../../components/NewLane";
import { editorLink, useEditor } from "../../components/editor";
import { Empty, Glyph, Help, Icon, LaneBadge, PageHeader, Section, agoText } from "../../components/ui";
import { BriefBlock, CollisionBox, TidyBlock } from "./ArchitectureParts";

type Filter = "all" | "lanes" | "changes" | "tests";
type Box = { x: number; y: number; w: number; h: number };

/**
 * Architecture (architecture.webp): the project's real layers and dependencies from CodeGraph, with
 * where each open lane is working on top. Selecting a module fills the inspector; a main path traces
 * one route through the layers.
 */
export function ArchitecturePage() {
  const { project = "" } = useParams();
  const work = useProjectWork();
  const [data, error, reload] = useJson<ProjectMap>(`/api/projects/${project}/map`);
  const [projects] = useJson<Project[]>("/api/projects");
  const lanes = work.lanes;
  useEffect(() => { const t = setInterval(reload, 30_000); return () => clearInterval(t); }, [reload]);
  const map = data?.map ?? null;

  const touched = useMemo(() => {
    const byModule = new Map<string, { lane: Lane; files: string[] }[]>();
    for (const o of data?.lanes ?? []) {
      const lane = lanes.find((l) => l.id === o.lane);
      if (!lane) continue;
      for (const [module, files] of Object.entries(o.modules)) byModule.set(module, [...(byModule.get(module) ?? []), { lane, files }]);
    }
    return byModule;
  }, [data, lanes]);
  const created = useMemo(() => new Set((data?.lanes ?? []).flatMap((o) => o.created)), [data]);
  const usesChange = useMemo(() => new Set((map?.links ?? []).filter((l) => touched.has(l.target) && !touched.has(l.source)).map((l) => l.source)), [map, touched]);
  const [filter, setFilter] = useState<Filter | null>(null);
  const shown: Filter = filter ?? (touched.size ? "lanes" : "all");
  const [selected, setSelected] = useState<string | null>(null);
  const [traced, setTraced] = useState<number | null>(null);
  const [starting, setStarting] = useState<string | null>(null);
  // Large repositories start at areas (AREA_THRESHOLD): the area opened is in the address, so Back closes it.
  const [params, setParams] = useSearchParams();
  const area = params.get("area");
  const openArea = (name: string | null) => { setSelected(null); setTraced(null); setParams(name ? { area: name } : {}); };
  const [query, setQuery] = useState("");

  if (error && !data) return <main className="pg"><PageHeader title="Architecture" /><Section title="Architecture"><Empty>The code map could not be loaded. {error.message}</Empty></Section></main>;
  if (!data) return <main className="pg"><PageHeader title="Architecture" meta="how the code fits together and where lanes touch it" /><Section title="Architecture"><Empty icon="search">Mapping the code · a large repository takes a minute</Empty></Section></main>;
  if (!map) return <main className="pg"><PageHeader title="Architecture" /><Section title="Architecture"><Empty>{data.error ?? "No code map yet."}</Empty></Section></main>;

  const modules = map.modules.concat([...created].filter((id) => !map.modules.some((m) => m.id === id)).map((id) => ({ id, layer: layerForNew(id, map, touched.get(id)?.[0]?.files ?? []), files: touched.get(id)?.[0]?.files.length ?? 0, lines: 0, tests: 0 })));
  const path = traced === null ? null : map.paths[traced] ?? null;
  const q = query.trim().toLowerCase();
  const byFilter = (m: CodeMap["modules"][number]) => shown === "all" || shown === "tests" || (shown === "changes" ? touched.has(m.id) : touched.has(m.id) || usesChange.has(m.id));
  const big = modules.length > AREA_THRESHOLD;
  const atAreas = big && !area && !q && !path;
  const scoped = modules.filter((m) => (!area || areaOf(m.id, map) === area) && (!q || m.id.toLowerCase().includes(q)) && (!path || path.modules.includes(m.id) || !big));
  const visible = scoped.filter(byFilter);
  const areas = atAreas ? codeAreas(map, modules).filter((a) => shown === "all" || shown === "tests" || a.modules.some((id) => modules.some((m) => m.id === id && byFilter(m)))) : [];
  const focus = selected ? modules.find((m) => m.id === selected) ?? null : null;
  const synced = agoText(map.syncedAt);
  return <main className="pg stack">
    <div className="arw">
      <div style={{ display: "grid", gap: 16, minWidth: 0 }}>
        <Section title="Architecture" meta={atAreas ? `${areas.length} ${areas.length === 1 ? "area" : "areas"} · ${modules.length} modules · CodeGraph, synced ${synced}` : `${visible.length} of ${modules.length} modules · CodeGraph, synced ${synced}`}
          end={<div className="seg" role="group" aria-label="Show">{(["all", "lanes", "changes", "tests"] as const).map((f) => <button key={f} className={shown === f ? "on" : ""} aria-pressed={shown === f} onClick={() => setFilter(f)}>{f === "all" ? "Show all" : f[0]!.toUpperCase() + f.slice(1)}</button>)}</div>}>
          {big ? <div className="sec-r" style={{ gap: 10, minHeight: 48 }}>
            {area ? <><button className="lnk" onClick={() => openArea(null)}>All areas</button><span className="muted">›</span><b className="mono" style={{ fontSize: 13.5 }}>{area}</b></> : q || path ? <span className="muted" style={{ fontSize: 13.5 }}>{q ? "Modules matching your search" : `Tracing ${path!.name}`}</span> : null}
            <input className="in" type="search" placeholder="Find a module" aria-label="Find a module" value={query} onChange={(e) => setQuery(e.target.value)} style={{ marginLeft: "auto", maxWidth: 240, minHeight: 34 }} />
          </div> : null}
          {data.error ? <div className="sec-f" role="status" style={{ fontSize: 13 }}>{data.error} Showing the last map.</div> : null}
          {atAreas ? <AreaGrid areas={areas} map={map} touched={touched} usesChange={usesChange} open={openArea} />
            : !visible.length ? <Empty>{q ? `No module matches "${query}".` : shown === "changes" || shown === "lanes" ? "No lane has changed code here yet" : "CodeGraph found no code it can read here."}</Empty>
            : <Diagram map={map} modules={visible} touched={touched} created={created} usesChange={usesChange} tests={shown === "tests"} selected={selected} select={setSelected} path={path} onlySelected={visible.length > AREA_THRESHOLD} />}
          {touched.size || !atAreas ? <div className="alegend" aria-label="Key">
            {!atAreas ? <span><i className="ln" />calls or imports</span> : null}{touched.size ? <><span><i className="ed" />a lane edits it</span><span><i className="tw" />two lanes edit it</span><span><i />uses a change</span></> : null}
          </div> : null}
        </Section>
        <TidyBlock project={project} changed={reload} />
        {map.paths.length ? <Section title="Main paths" meta="select one to trace it on the diagram">
          {map.paths.map((p, i) => <button key={p.name + i} className={`mrow${traced === i ? " on" : ""}`} aria-pressed={traced === i} onClick={() => setTraced(traced === i ? null : i)}>
            <Icon name="move" /><b style={{ fontSize: 14 }}>{p.name}</b><span className="p">{p.modules.join(" → ")}</span>
          </button>)}
        </Section> : null}
      </div>
      <aside className="sec insp" aria-label="Selected module">
        {focus ? <Inspector project={project} map={map} module={focus} touched={touched} lanes={lanes} startHere={() => setStarting(focus.id)} root={projects?.find((p) => p.id === project)?.path ?? null} />
          : <AtAGlance map={map} modules={modules} touched={touched} lanes={lanes} openArea={big ? openArea : null} select={(id) => { if (big) setParams({ area: areaOf(id, map) }); setSelected(id); }} />}
      </aside>
    </div>
    {starting && projects ? <NewLaneDialog projects={projects} project={project} task={`In ${starting}: `} onClose={() => setStarting(null)} /> : null}
  </main>;
}

/** The main language of the modules on screen in a layer, by files; the map's layer label when unknown. */
function techOf(modules: { files: number; tech?: string }[]): string | null {
  const counts = new Map<string, number>();
  for (const m of modules) if (m.tech) counts.set(m.tech, (counts.get(m.tech) ?? 0) + m.files);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

/** A module only a lane has: its layer by the same rules as the map's. */
function layerForNew(id: string, map: CodeMap, files: string[]): string {
  const layer = assign(files[0] ?? id, map.rules)?.layer;
  return layer && map.layers.some((l) => l.name === layer) ? layer : map.layers.find((l) => l.name === "Logic")?.name ?? map.layers.at(-1)?.name ?? "Logic";
}

function Diagram({ map, modules, touched, created, usesChange, tests, selected, select, path, onlySelected }: {
  map: CodeMap; modules: CodeMap["modules"]; touched: Map<string, { lane: Lane; files: string[] }[]>; created: Set<string>; usesChange: Set<string>;
  tests: boolean; selected: string | null; select: (id: string) => void; path: CodeMap["paths"][number] | null; onlySelected: boolean;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const [boxes, setBoxes] = useState<Record<string, Box>>({});
  // A module on a layer CodeGraph did not list (a folder a lane just created) still gets a column.
  const layers = [...map.layers, ...[...new Set(modules.map((m) => m.layer))].filter((name) => !map.layers.some((l) => l.name === name)).map((name) => ({ name, tech: null as string | null }))]
    .filter((l) => modules.some((m) => m.layer === l.name));
  const ids = modules.map((m) => m.id).join("|");
  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const measure = () => {
      const base = el.getBoundingClientRect();
      const next: Record<string, Box> = {};
      for (const node of el.querySelectorAll<HTMLElement>("[data-module]")) { const r = node.getBoundingClientRect(); next[node.dataset.module!] = { x: r.left - base.left, y: r.top - base.top, w: r.width, h: r.height }; }
      setBoxes(next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ids]);
  const shownIds = new Set(modules.map((m) => m.id));
  const onPath = (a: string, b: string) => !!path && path.modules.some((m, i) => m === a && path.modules[i + 1] === b);
  // Many modules: draw only the selected module's links (or the traced path), so the lines stay readable.
  const links = map.links.filter((l) => shownIds.has(l.source) && shownIds.has(l.target) && (!onlySelected || onPath(l.source, l.target) || l.source === selected || l.target === selected)).slice(0, 120);
  return <div className="lays" ref={wrap} style={{ gridTemplateColumns: `repeat(${Math.max(1, layers.length)}, minmax(0,1fr))` }}>
    <svg className="links" aria-hidden="true">
      {links.map((l) => {
        const a = boxes[l.source], b = boxes[l.target];
        if (!a || !b) return null;
        const forward = b.x > a.x + a.w / 2;
        const [x1, y1] = forward ? [a.x + a.w, a.y + a.h / 2] : b.x + b.w < a.x ? [a.x, a.y + a.h / 2] : [a.x + a.w / 2, a.y + (b.y > a.y ? a.h : 0)];
        const [x2, y2] = forward ? [b.x, b.y + b.h / 2] : b.x + b.w < a.x ? [b.x + b.w, b.y + b.h / 2] : [b.x + b.w / 2, b.y + (b.y > a.y ? 0 : b.h)];
        const dx = Math.abs(x2 - x1) / 2;
        const d = Math.abs(x2 - x1) > 20 ? `M${x1},${y1} C${x1 + (x2 > x1 ? dx : -dx)},${y1} ${x2 - (x2 > x1 ? dx : -dx)},${y2} ${x2},${y2}` : `M${x1},${y1} L${x2},${y2}`;
        const hot = onPath(l.source, l.target) || (!path && (l.source === selected || l.target === selected));
        return <path key={`${l.source}>${l.target}`} d={d} className={hot ? "hot" : created.has(l.source) || created.has(l.target) ? "new" : ""} />;
      })}
    </svg>
    {layers.map((layer) => <div className="lay" key={layer.name}>
      <div className="lay-h">{layer.name}{(techOf(modules.filter((m) => m.layer === layer.name)) ?? layer.tech) ? <span className="t">{techOf(modules.filter((m) => m.layer === layer.name)) ?? layer.tech}</span> : null}</div>
      {modules.filter((m) => m.layer === layer.name).map((m) => {
        const by = touched.get(m.id) ?? [];
        const quiet = (path && !path.modules.includes(m.id)) || (tests && !m.tests);
        const cls = ["mod", by.length >= 2 ? "two" : by.length ? `edit ${by[0]!.lane.colour}` : "", usesChange.has(m.id) && !by.length ? "uses" : "", quiet ? "quiet" : "", selected === m.id ? "on" : ""].filter(Boolean).join(" ");
        return <button key={m.id} data-module={m.id} className={cls} aria-pressed={selected === m.id} onClick={() => select(m.id)}>
          <span className="nm">{m.id}{created.has(m.id) ? <> <span className="tag">new</span></> : null}</span>
          <span className="sb">{tests ? `${m.tests} ${m.tests === 1 ? "test file" : "test files"}` : `${m.files} ${m.files === 1 ? "file" : "files"}`}{by.length ? <span className="e">{by.map((t) => <LaneBadge key={t.lane.id} id={t.lane.id} colour={t.lane.colour} />)}</span> : null}</span>
        </button>;
      })}
    </div>)}
  </div>;
}

function Inspector({ project, map, module, touched, lanes, startHere, root }: { project: string; map: CodeMap; module: CodeMap["modules"][number]; touched: Map<string, { lane: Lane; files: string[] }[]>; lanes: Lane[]; startHere: () => void; root: string | null }) {
  const editor = useEditor();
  const usedBy = map.links.filter((l) => l.target === module.id);
  const symbol = (source: string) => map.pairs.filter((p) => p.source === source && p.target === module.id).sort((a, b) => b.count - a.count)[0]?.to;
  const by = touched.get(module.id) ?? [];
  const covered = map.coveredBy[module.id] ?? [];
  return <>
    <div className="ps">
      <span className="lbl">Selected module</span>
      <div className="mono" style={{ fontSize: 15, fontWeight: 600, margin: "6px 0 2px", overflowWrap: "anywhere" }}>{module.id}</div>
      <div className="muted" style={{ fontSize: 13 }}>{module.layer} layer · {module.files} {module.files === 1 ? "file" : "files"}{module.lines ? ` · ${module.lines} lines` : ""}</div>
    </div>
    {by.length >= 2 ? <div className="ps"><CollisionBox project={project} module={module.id} editing={by} lanes={lanes} /></div> : null}
    <div className="ps">
      <div className="ps-h" style={{ marginBottom: 4 }}><span className="lbl">Used by</span></div>
      {usedBy.length ? usedBy.slice(0, 8).map((l) => { const t = touched.get(l.source)?.[0]; const s = symbol(l.source); return <div className="urow" key={l.source}><span style={{ overflowWrap: "anywhere" }}>{l.source}</span><span className="r">{t ? <LaneBadge id={t.lane.id} colour={t.lane.colour} /> : s ? `${s}()` : `${l.count}×`}</span></div>; })
        : <p className="muted" style={{ margin: 0, fontSize: 13 }}>Nothing else in the project uses it.</p>}
      <div className="ps-h" style={{ margin: "14px 0 4px" }}><span className="lbl">Covered by</span></div>
      {covered.length ? covered.slice(0, 5).map((c) => <div className="urow" key={c.module}><span>{c.module}</span><span className="r">{c.files} {c.files === 1 ? "file" : "files"}</span></div>)
        : <p className="muted" style={{ margin: 0, fontSize: 13 }}><Glyph g="wait">No test imports it.</Glyph></p>}
    </div>
    <BriefBlock project={project} module={module.id} />
    <div className="ps" style={{ display: "flex", gap: 12, justifyContent: "space-between" }}>
      <button className="lnk" style={{ fontWeight: 600 }} onClick={startHere}>Start a lane here →</button>
      {editor && root ? <a className="lnk" style={{ fontWeight: 600 }} href={editorLink(editor, `${root}/${module.id}`)}>Open in editor →</a> : null}
    </div>
  </>;
}

/** Areas (large repositories): one card per top folder with its size, layers, lanes and what it uses. */
function AreaGrid({ areas, map, touched, usesChange, open }: { areas: CodeArea[]; map: CodeMap; touched: Map<string, { lane: Lane; files: string[] }[]>; usesChange: Set<string>; open: (name: string) => void }) {
  if (!areas.length) return <Empty>No lane has changed code yet</Empty>;
  return <div className="areas">{areas.map((a) => {
    const lanes = new Map<string, Lane>();
    let two = false;
    for (const id of a.modules) { const by = touched.get(id) ?? []; if (by.length >= 2) two = true; for (const t of by) lanes.set(t.lane.id, t.lane); }
    const uses = a.modules.some((id) => usesChange.has(id)) && !lanes.size;
    const cls = ["mod", "area", two ? "two" : lanes.size ? `edit ${[...lanes.values()][0]!.colour}` : "", uses ? "uses" : ""].filter(Boolean).join(" ");
    return <button key={a.name} className={cls} onClick={() => open(a.name)} aria-label={`Open ${a.name}`}>
      <span className="nm">{a.name}</span>
      <span className="sb">{a.modules.length} {a.modules.length === 1 ? "module" : "modules"} · {a.files} files{lanes.size ? <span className="e">{[...lanes.values()].map((l) => <LaneBadge key={l.id} id={l.id} colour={l.colour} />)}</span> : null}</span>
      {(() => { const tested = a.modules.filter((id) => (map.coveredBy[id] ?? []).length || (map.modules.find((m) => m.id === id)?.tests ?? 0) > 0).length;
        return <span className="ly"><Glyph g={tested === a.modules.length ? "done" : tested ? "wait" : "idle"}>{tested === a.modules.length ? "all modules tested" : tested ? `${tested} of ${a.modules.length} modules tested` : "no tests"}</Glyph></span>; })()}
      {a.uses.length ? <span className="us">uses {a.uses.slice(0, 3).map((u) => u.area).join(", ")}{a.uses.length > 3 ? ` +${a.uses.length - 3}` : ""}</span> : null}
    </button>;
  })}<span className="sr-only">{map.modules.length} modules in {areas.length} areas</span></div>;
}

/**
 * The side column before anything is selected: what is worth looking at in this project now. Where each
 * open lane is working, modules two lanes edit, the modules most of the code depends on, and the largest
 * ones no test covers. Each line opens its module.
 */
function AtAGlance({ map, modules, touched, lanes, openArea, select }: { map: CodeMap; modules: CodeMap["modules"]; touched: Map<string, { lane: Lane; files: string[] }[]>; lanes: Lane[]; openArea: ((name: string) => void) | null; select: (id: string) => void }) {
  const open = lanes.filter((l) => !["merged", "cleaned", "archived"].includes(l.state));
  const where = (lane: Lane) => [...touched].filter(([, by]) => by.some((t) => t.lane.id === lane.id)).map(([id]) => id);
  const shared = [...touched].filter(([, by]) => by.length >= 2);
  const inbound = new Map<string, number>();
  for (const l of map.links) inbound.set(l.target, (inbound.get(l.target) ?? 0) + 1);
  const hubs = [...inbound].filter(([id]) => modules.some((m) => m.id === id)).sort((a, b) => b[1] - a[1]).slice(0, 3);
  const untested = modules.filter((m) => !m.tests && !(map.coveredBy[m.id] ?? []).length && m.files > 0).sort((a, b) => b.files - a.files);
  const row = (id: string, right: ReactNode) => <button className="urow" key={id} style={{ width: "100%", background: "none", border: 0, borderTop: "1px solid var(--line-soft)", cursor: "pointer", textAlign: "left", font: "500 12.5px var(--mono)", color: "var(--ink)", padding: 0 }} onClick={() => select(id)}><span style={{ overflowWrap: "anywhere" }}>{id}</span><span className="r">{right}</span></button>;
  return <>
    <div className="ps">
      <span className="lbl">Lanes here</span>
      {open.length ? open.map((lane) => { const ids = where(lane); return <div key={lane.id} style={{ marginTop: 10 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13.5 }}><LaneBadge id={lane.id} colour={lane.colour} /><span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{lane.task}</span></div>
        {ids.length ? ids.slice(0, 4).map((id) => row(id, (() => { const n = touched.get(id)!.find((t) => t.lane.id === lane.id)!.files.length; return `${n} ${n === 1 ? "file" : "files"}`; })())) : <div className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>No code changed yet</div>}
      </div>; }) : <div style={{ marginTop: 10 }}><Glyph g="idle">No open lanes</Glyph></div>}
    </div>
    {shared.length ? <div className="ps"><span className="lbl">Two lanes, one module</span>{shared.map(([id, by]) => row(id, <span className="e">{by.map((t) => <LaneBadge key={t.lane.id} id={t.lane.id} colour={t.lane.colour} />)}</span>))}</div> : null}
    {hubs.length ? <div className="ps"><div style={{ display: "flex", alignItems: "center", gap: 6 }}><span className="lbl">Most depended on</span><Help label="Why these?">Changes here reach the most other modules, so they deserve the closest review.</Help></div>{hubs.map(([id, n]) => row(id, `${n} ${n === 1 ? "user" : "users"}`))}</div> : null}
    {untested.length ? <div className="ps"><span className="lbl">Largest without tests</span>{untested.slice(0, 4).map((m) => row(m.id, `${m.files} files`))}{untested.length > 4 ? <div className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>and {untested.length - 4} more</div> : null}</div> : null}
    {openArea ? <div className="ps muted" style={{ fontSize: 12.5 }}>Open an area on the left to see its modules.</div> : null}
  </>;
}
