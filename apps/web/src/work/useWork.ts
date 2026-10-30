import { useCallback, useEffect, useMemo, useState } from "react";
import type { Lane, LaneEvent } from "@contextlanes/protocol";
import { useJson, useProjectStream } from "../api";
import { loadHistory, mergeEvents } from "./model";

export function useWork(project: string) {
  const [lanes, error, reloadLanes] = useJson<Lane[]>(`/api/projects/${project}/lanes`);
  const [activity, activityError, reloadActivity] = useJson<LaneEvent[]>(`/api/projects/${project}/activity`);
  const [live, setLive] = useState<LaneEvent[]>([]);
  const [version, setVersion] = useState(0);
  const event = useCallback((event: LaneEvent) => {
    setLive((old) => mergeEvents(old, [event]));
    if (["lane.created", "lane.state"].includes(event.type)) reloadLanes();
  }, [reloadLanes]);
  const reopen = useCallback(() => { reloadLanes(); reloadActivity(); setVersion((v) => v + 1); }, [reloadLanes, reloadActivity]);
  useProjectStream(project, event, reopen);
  useEffect(() => { setLive([]); }, [project]);
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
    void loadHistory(lane, fetch, abort.signal).then((events) => { if (!abort.signal.aborted) setHistory({ lane, events }); }, (err) => { if (!abort.signal.aborted) setError(err instanceof Error ? err.message : "Could not load steps."); });
    return () => abort.abort();
  }, [lane, version]);
  return { events: mergeEvents(history.lane === lane ? history.events : [], live.filter((e) => e.lane === lane)), error };
}
