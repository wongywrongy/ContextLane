import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Lane, LaneEvent } from "@contextlanes/protocol";
import { apiFetch, useJson, useProjectStream } from "../api";
import { loadHistory, mergeEvents } from "./model";

const LIVE_LIMIT = 4000;

export function useWork(project: string) {
  const [lanes, error, reloadLanes] = useJson<Lane[]>(`/api/projects/${project}/lanes`);
  const [activity, activityError, reloadActivity] = useJson<LaneEvent[]>(`/api/projects/${project}/activity`);
  const [live, setLive] = useState<LaneEvent[]>([]);
  const [version, setVersion] = useState(0);
  const reopen = useCallback(() => { reloadLanes(); reloadActivity(); setVersion((v) => v + 1); }, [reloadLanes, reloadActivity]);
  // Stream events arrive in order, so they are appended, not re-sorted. A page left open for days would
  // keep every streamed word; past a few thousand, the stored history is loaded again and the buffer starts over.
  const streamed = useRef(0);
  const event = useCallback((event: LaneEvent) => {
    if (++streamed.current > LIVE_LIMIT) { streamed.current = 0; setLive([]); reopen(); }
    else setLive((old) => [...old, event]);
    if (["lane.created", "lane.state", "lane.renamed"].includes(event.type)) reloadLanes();
  }, [reloadLanes, reopen]);
  useProjectStream(project, event, reopen);
  useEffect(() => { setLive([]); streamed.current = 0; }, [project]);
  const events = useMemo(() => mergeEvents(activity ?? [], live.filter((e) => e.lane.startsWith(`${project}/`))), [activity, live, project]);
  return { lanes: lanes?.filter((l) => l.project === project) ?? [], error: error ?? activityError, events, version, reload: reopen };
}

export function useHistory(lane: string, live: LaneEvent[], version: number) {
  const [history, setHistory] = useState<{ lane: string; events: LaneEvent[] }>({ lane, events: [] });
  const [error, setError] = useState("");
  useEffect(() => {
    if (!lane) return;
    const abort = new AbortController();
    setError("");
    void loadHistory(lane, apiFetch, abort.signal).then((events) => { if (!abort.signal.aborted) setHistory({ lane, events }); }, (err) => { if (!abort.signal.aborted) setError(err instanceof Error ? err.message : "Could not load steps."); });
    return () => abort.abort();
  }, [lane, version]);
  return { events: mergeEvents(history.lane === lane ? history.events : [], live.filter((e) => e.lane === lane)), error };
}
