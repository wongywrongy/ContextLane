import { claimStatusline, post, statuslineSnapshot } from './telemetry-hook.mjs';

try {
  // Drain oversized input without retaining it or interrupting the wrapped command.
  let chunks = [], size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size <= 1024 * 1024) chunks.push(chunk);
    else chunks = [];
  }
  if (size <= 1024 * 1024) {
    const snapshot = statuslineSnapshot(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    if (snapshot && claimStatusline(snapshot.session_id)) await post('/hook/statusline', snapshot);
  }
} catch {}
