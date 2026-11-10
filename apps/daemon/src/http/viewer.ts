import type { Config } from "../config.js";
import { routeFeature } from "../features.js";

/** What a browser gets when it tries to change something the web app only shows. */
export const VIEWER_REFUSAL = { error: "The web app shows lanes and takes your decisions. Do this with the contextlanes command on the machine.", code: "viewer" } as const;

/**
 * Everything a signed-in browser may change. The web app is a viewer plus the decisions only the owner
 * can make: answering a question or permission, and approving a recipe. The rest is this browser's own
 * sign-in and notifications. Lanes, projects, environments and settings are changed with the CLI.
 */
const BROWSER_WRITES = new Set([
  "POST /api/answers",
  "POST /api/projects/:project/recipe/approve",
  "POST /api/tickets",
  "POST /api/push/subscriptions", "DELETE /api/push/subscriptions", "POST /api/setup/push",
  "POST /api/setup/passkey/options", "POST /api/setup/passkey",
  // Asks each agent afresh whether it is installed and signed in; changes nothing.
  "POST /api/setup/agents/check",
]);

/** Settings a frozen feature's own page edits, by the feature that must be on. Everything else is config.toml's. */
const FEATURE_SETTINGS: Record<string, (keyof Config["features"])[]> = { localModels: ["helper", "insights"], routing: ["acp"] };
const SETTINGS = "POST /api/setup/settings";

/** Whether a browser may save this settings body: only keys that belong to a feature that is on. */
export function browserSettings(config: Config, body: unknown): boolean {
  const keys = body && typeof body === "object" ? Object.keys(body) : [];
  return keys.length > 0 && keys.every((key) => FEATURE_SETTINGS[key]?.some((feature) => config.features[feature]));
}

/**
 * Whether a browser session may send this request. Reads always; writes only from the list above, or to
 * a feature the owner turned on in config ([features]), which brings its own page and actions with it.
 */
export function browserMay(config: Config, method: string, route: string): boolean {
  if (["GET", "HEAD", "OPTIONS"].includes(method)) return true;
  if (BROWSER_WRITES.has(`${method} ${route}`)) return true;
  // Checked again with its body (browserSettings) once that is parsed.
  if (`${method} ${route}` === SETTINGS) return Object.values(FEATURE_SETTINGS).flat().some((feature) => config.features[feature]);
  const feature = routeFeature(route);
  return !!feature && config.features[feature];
}

/** Streams a browser may open with a ticket: everything it watches, but not the agent sign-in terminal, which takes typing. */
export function browserTicket(path: string): boolean {
  return !/^\/api\/setup\/agents\/[^/]+\/terminal$/.test(path);
}
