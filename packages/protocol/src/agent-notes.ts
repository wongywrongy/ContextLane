/**
 * What an agent needs to know to use its lane, in under 25 lines. Printed by `contextlanes agent-notes`
 * for a project's AGENTS.md or CLAUDE.md, and given to every CLI lane's agent with its first message.
 */
export const AGENT_NOTES = `## ContextLanes

This checkout is a ContextLanes lane: its own branch, its own copy of the app on its own ports, and a link for each service. Use the \`contextlanes\` command; inside a lane it already knows which lane you are in. Add --json to any command for machine-readable output.

- \`contextlanes app status\` — services, their state, port and link
- \`contextlanes app start\` — start the app from the recipe (.contextlanes.json) and wait until it is healthy or failed; on failure it prints the logs
- \`contextlanes app restart [service]\`, \`contextlanes app stop\`
- \`contextlanes logs <service> [-n 100]\` — recent log lines
- \`contextlanes url [service]\` — the service's link, and nothing else (default service: web)
- \`contextlanes recipe\` — the recipe, its hash and whether it is approved

Services get \`$PORT\` and must listen on 127.0.0.1 (\`$HOST\`). They also get \`$LANE_URL\` and \`$LANE_HOSTNAME\` (their own link), and \`$LANE_URL_<NAME>\` for every service, usable in the recipe's commands and env values.

Exit codes: 0 done, 1 failed, 2 wrong usage, 3 ContextLanes not reachable, 4 waiting on the owner. Exit 4 means the recipe is new or changed and only the owner can approve it: say so, and continue with work that does not need the app. Never try to approve it yourself.`;
