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
