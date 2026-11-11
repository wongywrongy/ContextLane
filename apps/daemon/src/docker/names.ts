/**
 * Fixed names of the Docker runtime (docs/V4.md section 3). compose.yaml, the image, install-command and
 * scripts/v4-check/phase2.sh use the same ones; change them together or not at all.
 */
export const CONTROL_CONTAINER = "contextlanes";
/** On the control container, so it can be told from anything else that happens to be called contextlanes. */
export const CONTROL_LABEL = "contextlanes.control";
/** The private network the control service and every lane share. Never published. */
export const NETWORK = "contextlanes";
/** The volume the control image fills with tmux, Node and the agent CLIs for lanes. */
export const TOOLS_VOLUME = "contextlanes-tools";
/** Where the control container mounts the tools volume, and where the image keeps the copy it fills it from. */
export const TOOLS_MOUNT = "/var/lib/contextlanes-tools";
export const TOOLS_IN_IMAGE = "/opt/contextlanes-tools";
/** The marker file at the top of both: the versions inside, one line. */
export const TOOLS_MARKER = ".version";
/** Every short-lived helper container carries this label (and is named contextlanes-helper-<random>). */
export const HELPER_LABEL = "contextlanes.helper";
export const HELPER_PREFIX = "contextlanes-helper-";
/** Inside the control container: its data folder and the API port. */
export const DATA_MOUNT = "/data";
export const API_PORT = 4600;
/** Where Docker's socket usually is on a Linux host. */
export const SOCKET = "/var/run/docker.sock";

// ── Lanes (v4 phase 3) ──
/** Labels on every lane container, so the control service finds its lanes again after a restart. */
export const LANE_LABEL = "contextlanes.lane";
export const PROJECT_LABEL = "contextlanes.project";
/** A random value per container: the Dev Container CLI never reuses a container left by an earlier lane of the same id. */
export const INSTANCE_LABEL = "contextlanes.instance";
/** Inside a lane: the tools volume (read-only, first on PATH), the agent logins, and the lane's own files. */
export const LANE_TOOLS = "/opt/contextlanes";
export const LANE_AGENT_HOME = "/opt/contextlanes-home";
/** Created by root when the lane is made and given to the lane's user, mode 0700: launch files, task, unit state. Not in the checkout. */
export const LANE_DIR = "/var/lib/contextlanes-lane";
/** Where lanes reach the API: the control container's name on the contextlanes network. */
export const LANE_API = `http://${CONTROL_CONTAINER}:${API_PORT}`;
/** tmux runs in each lane with its own socket name, so a project's own tmux use never meets ours. */
export const LANE_TMUX_SOCKET = "contextlanes";
/**
 * Agent logins, one volume per uid. A new volume is owned by root and is given once to the lane's user;
 * lanes whose users have different uids cannot share one, so each uid gets its own (docs/V4.md 8d).
 */
export const agentHomeVolume = (uid: number) => `contextlanes-agent-home-${uid}`;
