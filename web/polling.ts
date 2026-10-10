// Refresh requests coalesce; a running request has at most one successor.
export function polling(work: (signal: AbortSignal) => Promise<void>, visible = () => !document.hidden) {
  const abort = new AbortController();
  let running = false;
  let queued = false;
  async function refresh() {
    if (abort.signal.aborted || !visible()) return;
    if (running) {
      queued = true;
      return;
    }
    running = true;
    try {
      do {
        queued = false;
        await work(abort.signal);
      } while (queued && !abort.signal.aborted && visible());
    } finally {
      running = false;
    }
  }
  return {
    refresh,
    stop() {
      queued = false;
      abort.abort();
    },
  };
}
