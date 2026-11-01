// Native hooks need only Node's built-ins, not the CLI's client, protocol or daemon bundles.
import { randomUUID } from "node:crypto";
const timer = setTimeout(() => process.exit(0), 1900);
try {
  const lane = process.env.CONTEXTLANES_LANE;
  const token = process.env.CONTEXTLANES_LANE_TOKEN;
  const url = new URL(process.env.CONTEXTLANES_URL ?? "http://127.0.0.1:4600");
  if (!lane || !token || url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname)) process.exit(0);
  process.stdin.setEncoding("utf8");
  let stdin = "";
  for await (const chunk of process.stdin) { stdin += chunk; if (stdin.length > 2_000_000) process.exit(0); }
  const payload = JSON.parse(stdin);
  const event = process.argv[2] === "hook" ? process.argv[3] : process.argv[2];
  if (event && payload.hook_event_name !== event) process.exit(0);
  const path = `/api/lanes/${lane.split("/").map(encodeURIComponent).join("/")}/hooks`;
  const request = async (path, body) => {
    const r = await fetch(new URL(path, url), { method: body ? "POST" : "GET", headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(1500), redirect: "error" });
    if (!r.ok) throw new Error("Hook unavailable");
    return r.json();
  };
  let result = await request(path, { eventId: randomUUID(), payload });
  clearTimeout(timer);
  const until = Date.now() + 86_400_000;
  while (result.pending === true && typeof result.requestId === "string" && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 250));
    result = await request(`${path}/answer?request=${encodeURIComponent(result.requestId)}`);
  }
  if (result.hookSpecificOutput) process.stdout.write(`${JSON.stringify({ hookSpecificOutput: result.hookSpecificOutput })}\n`);
} catch { /* No decision: the native CLI's own prompt remains authoritative. */ }
finally { clearTimeout(timer); }
