/**
 * Auto mode's guard. In Auto, ContextLanes (never the agent) approves each request the agent makes, except
 * the dire ones below, which still wait for the owner with the reason shown. The agent stays in a mode that
 * asks, so every action passes through here, and only "allow once" is ever chosen, so it keeps asking.
 *
 * The rules are fixed and readable, not a model's judgement: published tests of classifier-based auto modes
 * found force-pushes cleared after the classifier read the owner's request as consent, and prefix allow rules
 * (`git:*`) that covered `git push --force`. So commands are read whole, including chained, piped and nested
 * ones, and anything that matches waits for you. A false alarm costs one tap; a miss can cost a branch.
 *
 * This is a conservative review aid, not a shell parser or a security boundary. It cannot see what a
 * checkout script does, aliases resolved by a shell, or data an allowed program sends over the network.
 */

export type GuardInput = {
  /** ACP tool kind: read, edit, delete, move, search, execute, think, fetch, other. */
  kind: string | null;
  /** The shell command when the request runs one (from the agent's own request, not its prose). */
  command: string | null;
  /** Files the request names. */
  paths: string[];
  /** Where the command runs, when the agent says. */
  cwd?: string | null;
  title: string;
};
export type GuardContext = {
  /** The lane's checkout; writes inside it are the lane's own business. */
  worktree: string;
  /** The owner's home folder, for ~ and $HOME. */
  home: string;
  /** The branch the lane merges into, e.g. main. Pushing to it directly waits for you. */
  base: string | null;
  /** Other folders the lane may write (temporary files). */
  writable?: string[];
};
export type GuardVerdict = { ok: true } | { ok: false; reason: string };

/** The categories, in the words the Models help and the docs use. */
export const DIRE_ACTIONS = [
  "rewriting or deleting branches on the remote, or pushing straight to the base branch",
  "publishing, deploying or changing cloud and GitHub settings",
  "deleting or writing files outside the lane's checkout",
  "reading credentials (SSH keys, cloud and GitHub tokens, other agents' logins)",
  "running a script straight from the internet, or sending data to another machine",
  "changing the machine itself: sudo, services, scheduled jobs, global installs, stopping other processes",
  "destroying database data",
] as const;

const SECRET = /(^|[\s"'=:/])(~|\$\{?HOME\}?)?[^\s"']*(\.ssh\/|\bid_(rsa|ed25519|ecdsa|dsa)\b|\.aws\/|\.config\/gh\b|\.git-credentials|\.netrc|\.docker\/config\.json|\.kube\/config|\.gnupg\/|\.config\/gcloud|\.azure\/|\.claude\/\.credentials|\.codex\/auth\.json|\.config\/contextlanes|\.local\/share\/contextlanes|\.password-store)/i;
const WRITERS = /^(rm|rmdir|unlink|shred|mv|cp|tee|touch|mkdir|chmod|chown|chgrp|ln|truncate|install|rsync|dd|sed|perl|patch)$/;

type Rule = [RegExp, string];
/** Matched against each simple command (after splitting chains and unwrapping sh -c, $(…) and backticks). */
const COMMAND_RULES: Rule[] = [
  [/^git\s+push\b.*(\s-f\b|\s--force\b|\s--force-with-lease\b|\s--mirror\b|\s--delete\b|\s-d\b|\s--prune\b|\s\+\S|\s:\S)/, "force-pushes or deletes a branch on the remote"],
  [/^git\s+(filter-branch|filter-repo|update-ref\s+-d|reflog\s+expire)\b/, "rewrites the repository's history"],
  [/^git\s+(branch\s+(-D|-d|--delete|-f|--force|-M|-m)|tag\s+(-d|--delete))\b/, "deletes or moves a branch or tag shared with your other checkouts"],
  [/^git\s+worktree\s+(remove|prune)\b/, "removes a checkout, possibly another lane's"],
  [/^git\s+(remote\s+(add|set-url|remove|rm|rename)|config\s+(--global|--system))\b/, "changes where git pushes, or your global git settings"],
  [/^gh\s+(repo\s+(delete|edit|rename|archive)|pr\s+merge|release\s+(create|delete|edit|upload)|secret|variable|ssh-key|gpg-key|auth|workflow\s+run)\b/, "changes GitHub directly"],
  [/^gh\s+api\b.*(-X|--method)\s*(DELETE|PUT|PATCH|POST)\b/i, "changes GitHub directly"],
  [/^(npm|pnpm|yarn|bun)\s+(publish|unpublish|deprecate|dist-tag|owner|token|login|adduser)\b/, "publishes a package or changes its registry"],
  [/^(npm|pnpm|yarn|bun)\s+(run\s+)?(deploy|publish|release)(:\S*)?\b/, "runs a deploy or release script"],
  [/^make\s+(\S+\s+)*(deploy|publish|release)\b/, "runs a deploy or release target"],
  [/^(cargo\s+publish|twine\s+upload|gem\s+push|poetry\s+publish|docker\s+(push|login)|podman\s+push)\b/, "publishes a package or image"],
  [/^(kubectl\s+(apply|delete|create|replace|patch|scale|rollout|drain|edit|set)|helm\s+(install|upgrade|uninstall|delete|rollback)|terraform\s+(apply|destroy|import|state)|tofu\s+(apply|destroy)|pulumi\s+(up|destroy)|ansible-playbook)\b/, "changes infrastructure"],
  [/^(vercel|netlify|fly|flyctl|firebase|wrangler|railway|heroku|serverless|sls|cdk|sam|eb)\b.*\b(deploy|publish|--prod|promote|destroy|delete|rm|remove)\b/, "deploys or removes a hosted service"],
  [/^(aws|gcloud|az|doctl|oci)\s/, "uses a cloud account"],
  [/^(sudo|su|doas|pkexec)\b/, "runs as another user"],
  [/^(systemctl|launchctl|service|crontab|at|shutdown|reboot|halt|poweroff|mkfs(\.\w+)?|fdisk|parted|wipefs|mount|umount|iptables|ufw|nft)\b/, "changes the machine itself"],
  [/^(pkill|killall)\b|^kill\s+(-\S+\s+)*(-1|1)\b/, "stops processes it did not start"],
  [/^(npm|pnpm|yarn)\s+(i|install|add|remove|uninstall|rm)\s+(.*\s)?(-g|--global)\b|^yarn\s+global\b|^pip3?\s+install\s+(.*\s)?--user\b|^(brew|apt|apt-get|dnf|yum|pacman|snap|flatpak)\s/, "installs or removes software for the whole machine"],
  [/^(nc|ncat|netcat|socat|telnet|ssh|scp|sftp|ftp)\b/, "connects to another machine"],
  [/^rsync\b.*\s\S+:\S*/, "copies files to another machine"],
  [/^(dropdb|dropuser)\b|\b(DROP\s+(DATABASE|SCHEMA|TABLE)|TRUNCATE\s+(TABLE\s+)?\w)|^redis-cli\b.*\bFLUSH(ALL|DB)\b|dropDatabase\(/i, "destroys database data"],
  [/^contextlanes\b/, "uses ContextLanes itself"],
  [/^(chmod|chown)\s+(-\S+\s+)*-R\b.*\s\/(\s|$)/, "changes permissions across the whole machine"],
  [/^(eval|source|\.)\s+<\(|^(bash|sh|zsh)\s+<\(/, "runs a script it downloads"],
];
/** Matched against the whole command, since they span a pipe. */
const PIPE_RULES: Rule[] = [
  [/\b(curl|wget|fetch|iwr|irm)\b[^|;&]*\|\s*(sudo\s+)?(ba|z|da|k)?sh\b|\b(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(python3?|node|perl|ruby|php)\b/, "runs a script straight from the internet"],
  [/\$\(\s*(curl|wget)\b/, "runs a script straight from the internet"],
];
const LOCAL_URL = /^(https?:\/\/)?(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?|0\.0\.0\.0)(:\d+)?(\/|$)/i;

/** Splits a command line into simple commands: chains, pipes, subshells, sh -c '…', $(…) and backticks. */
export function simpleCommands(line: string): string[] {
  const out: string[] = [];
  const walk = (text: string, depth: number) => {
    if (depth > 4) { out.push(text.trim()); return; }
    // Nested commands first: $(…), backticks and sh -c / bash -c strings.
    for (const m of text.matchAll(/\$\(([^()]*)\)|`([^`]*)`/g)) walk(m[1] ?? m[2] ?? "", depth + 1);
    for (const m of text.matchAll(/\b(?:ba|z|da)?sh\s+-\w*c\s+(?:'([^']*)'|"([^"]*)")/g)) walk(m[1] ?? m[2] ?? "", depth + 1);
    for (const part of text.split(/\|\||&&|[;|&\n]|\(|\)/)) {
      // Leading environment assignments and wrappers do not change what runs.
      const bare = part.trim().replace(/^((\w+=\S*|env|command|exec|nohup|time|nice|xargs(\s+-\S+)*|timeout\s+\S+)\s+)+/, "").trim();
      if (bare) out.push(bare);
    }
  };
  walk(line, 0);
  return out;
}

const tokens = (cmd: string) => (cmd.match(/'[^']*'|"[^"]*"|\S+/g) ?? []).map((t) => t.replace(/^['"]|['"]$/g, ""));

function expand(path: string, ctx: GuardContext): string {
  const p = path.replace(/^~(?=\/|$)/, ctx.home).replace(/^\$\{?HOME\}?(?=\/|$)/, ctx.home);
  if (!p.startsWith("/")) return normalize(`${ctx.worktree}/${p}`);
  return normalize(p);
}
function normalize(p: string): string {
  const parts: string[] = [];
  for (const seg of p.split("/")) { if (!seg || seg === ".") continue; if (seg === "..") parts.pop(); else parts.push(seg); }
  return `/${parts.join("/")}`;
}
function inside(path: string, ctx: GuardContext): boolean {
  const roots = [ctx.worktree, "/tmp", "/var/tmp", "/dev/null", "/dev/stdout", "/dev/stderr", ...(ctx.writable ?? [])].map(normalize);
  return roots.some((r) => path === r || path.startsWith(`${r}/`));
}
/** A token that names a path outside the checkout once ~, $HOME and .. are resolved. */
function outsidePath(token: string, ctx: GuardContext): string | null {
  if (!token || token.startsWith("-") || /^[a-z]+:\/\//i.test(token) || /^\w+=/.test(token)) return null;
  if (!/^(\/|~|\$\{?HOME|\.\.)/.test(token) && !token.includes("/../")) return null;
  const full = expand(token, ctx);
  return inside(full, ctx) ? null : full;
}

function checkCommand(cmd: string, ctx: GuardContext): string | null {
  const words = tokens(cmd);
  const program = words[0]?.split("/").pop() ?? "";
  if (/[\\$`'"]/.test(program)) return "uses a dynamically constructed command whose effects need review";
  if (!["git", "gh"].includes(program) && /\b(?:git\s+(?:[-\w./]+\s+)*push\b|gh\s+api\b)/.test(cmd)) return "wraps a git or GitHub operation whose effects need review";
  // Match the actual executable name, including /usr/bin/git. Git's global flags precede its
  // subcommand; do not let `git -C . push --force` slip past rules anchored at `git push`.
  let args = words.slice(1);
  if (program === "git") {
    while (args[0]?.startsWith("-")) {
      const flag = args[0];
      if (["--no-pager", "--paginate", "--no-optional-locks"].includes(flag)) { args = args.slice(1); continue; }
      if (flag === "-C" || flag.startsWith("-C")) {
        const dir = flag === "-C" ? args[1] : flag.slice(2);
        if (!dir || !inside(expand(dir, ctx), ctx)) return "changes git's working directory outside this lane's checkout";
        args = args.slice(flag === "-C" ? 2 : 1); continue;
      }
      // Config overrides can install aliases/helpers, and repository overrides change what is mutated.
      return "uses git options whose effects need review";
    }
    const known = new Set(["add", "am", "apply", "bisect", "blame", "branch", "checkout", "cherry-pick", "clean", "clone", "commit", "config", "describe", "diff", "fetch", "format-patch", "grep", "init", "log", "ls-files", "ls-remote", "ls-tree", "merge", "merge-base", "mv", "notes", "pull", "push", "range-diff", "rebase", "reflog", "remote", "reset", "restore", "rev-list", "rev-parse", "revert", "rm", "shortlog", "show", "show-ref", "stash", "status", "switch", "tag", "worktree", "filter-branch", "filter-repo", "update-ref"]);
    if (!args[0] || !known.has(args[0])) return "uses an unknown git command or alias whose effects need review";
  }
  const normalized = [program, ...args].join(" ");
  for (const [re, why] of COMMAND_RULES) if (re.test(normalized)) return why;
  if (program === "git") {
    if (["branch", "tag"].includes(args[0] ?? "") && args.slice(1).some((w) => /^--(?:delete|force|move|copy)(?:=|$)|^-[^-]*[dDfFmMcC]/.test(w))) return "deletes or moves a branch or tag shared with your other checkouts";
    if (args[0] === "update-ref" || args[0] === "reflog" && args.some((w) => ["expire", "delete", "drop"].includes(w))) return "rewrites the repository's history";
    if (args[0] === "worktree" && args[1] !== "list") return "changes a checkout, possibly another lane's";
    if (args[0] === "config" && !args.slice(1).some((w) => ["--get", "--get-all", "--get-regexp", "--get-urlmatch", "--list", "-l", "get", "list"].includes(w))) return "changes git settings whose effects need review";
  }
  // Pushing the lane's own branch is normal; pushing straight to the base branch is not.
  if (ctx.base && /^git\s+push\b/.test(normalized)) {
    const base = ctx.base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(\\s|:|/)${base}(\\s|$)`).test(normalized) || /\sHEAD:(main|master)\b/.test(normalized)) return `pushes straight to ${ctx.base}`;
  }
  if (program === "git" && args[0] === "push") {
    // Combined short flags (-uf), abbreviated long flags and configured default destinations are
    // ambiguous. Auto only accepts an explicit remote and refspec with ordinary transport flags.
    const values: string[] = [];
    for (const arg of args.slice(1)) {
      if (["-u", "--set-upstream", "--porcelain", "--verbose", "-v", "--quiet", "-q", "--dry-run", "-n"].includes(arg)) continue;
      if (arg.startsWith("-")) return "uses push options whose effects need review";
      if (arg.startsWith("+") || arg.startsWith(":")) return "force-pushes or deletes a branch on the remote";
      values.push(arg);
    }
    if (values.length < 2 || values.some((v) => /[$`*]/.test(v))) return "pushes to a destination that needs review";
  }
  if (program === "gh") {
    if (args[0]?.startsWith("-")) return "uses GitHub options whose effects need review";
    if (args[0] === "api") {
      // gh switches from GET to POST when any field or input is supplied, even without -X.
      if (args.slice(1).some((w) => /^(-[fF].*|--(?:raw-field|field|input)(?:=|$))/.test(w))) return "changes GitHub directly";
      const method = args.findIndex((w) => w === "-X" || w === "--method");
      if (method !== -1 && !["GET", "HEAD"].includes(args[method + 1]?.toUpperCase() ?? "")) return "changes GitHub directly";
      if (args.some((w) => /^(?:-X.+|--method=)/.test(w) && !/^(?:-X|--method=)(?:GET|HEAD)$/i.test(w))) return "changes GitHub directly";
    } else {
      const readOnly: Record<string, string[]> = { pr: ["view", "list", "status", "diff", "checks", "checkout"], issue: ["view", "list", "status"], repo: ["view", "list", "clone"], run: ["view", "list", "watch"], workflow: ["view", "list"], release: ["view", "list", "download"], search: ["code", "commits", "issues", "prs", "repos"], browse: [] };
      if (!args[0] || !(args[0] in readOnly) || (readOnly[args[0]]!.length > 0 && !readOnly[args[0]]!.includes(args[1] ?? ""))) return "uses a GitHub command whose effects need review";
    }
  }
  // Writing anywhere outside the checkout: a writer with an outside path, or a redirect to one.
  const inPlace = program === "sed" ? words.some((w) => /^-\w*i/.test(w) || w === "--in-place") : program === "perl" ? words.some((w) => /^-\w*i/.test(w)) : true;
  if (WRITERS.test(program) && inPlace) {
    if (["cp", "rsync", "install"].includes(program)) {
      // These read from anywhere; only the destination (the last path) matters.
      const dest = outsidePath(words.at(-1) ?? "", ctx);
      if (dest) return `writes ${dest}, outside this lane's checkout`;
    } else {
      const out = words.slice(1).map((w) => outsidePath(program === "dd" ? (w.startsWith("of=") ? w.slice(3) : "") : w, ctx)).find(Boolean);
      if (out) return ["rm", "rmdir", "unlink", "shred"].includes(program) ? `deletes ${out}, outside this lane's checkout` : `changes ${out}, outside this lane's checkout`;
    }
  }
  if (program === "find" && words.some((w) => w === "-delete" || w === "-exec" && /rm/.test(cmd))) { const out = words.slice(1).map((w) => outsidePath(w, ctx)).find(Boolean); if (out) return `deletes files under ${out}, outside this lane's checkout`; }
  for (const m of cmd.matchAll(/(?:^|[^<>&\d])>>?\s*(\S+)/g)) { const out = outsidePath(m[1]!, ctx); if (out) return `writes ${out}, outside this lane's checkout`; }
  // Sending data out: an upload or a request with a body to anywhere but this machine.
  if (/^(curl|wget|http|https|xh)\b/.test(program)) {
    const sends = words.some((w) => /^(-[dFT].*|--(?:data\S*|form\S*|upload-file|post-data|post-file|body-data|body-file)(?:=|$))/.test(w))
      || /\s(-X|--request|--method)\s*(POST|PUT|PATCH|DELETE)\b/i.test(cmd)
      || /^(http|https|xh)$/.test(program) && /\s(POST|PUT|PATCH|DELETE)\s/i.test(cmd);
    const url = words.slice(1).find((w) => /^[a-z]+:\/\//i.test(w) || /^[\w.-]+\.[a-z]{2,}(\/|:|$)/i.test(w));
    if (sends && url && !LOCAL_URL.test(url)) return `sends data to ${url.replace(/^[a-z]+:\/\//i, "").split("/")[0]}`;
  }
  return null;
}

/** The verdict for one request in Auto. `ok: false` means it waits for the owner, with the reason shown. */
export function guard(input: GuardInput, ctx: GuardContext): GuardVerdict {
  const command = input.command?.trim() || null;
  // What cannot be seen is not approved: a command with no text, or a file change that names no file.
  if (input.kind === "execute" && !command && !/\s/.test(input.title.trim().replace(/^Run command$/i, ""))) return { ok: false, reason: "ContextLanes could not see the command" };
  if (["edit", "delete", "move"].includes(input.kind ?? "") && !input.paths.length) return { ok: false, reason: "ContextLanes could not see which files it changes" };
  if (command && input.cwd) {
    const where = expand(input.cwd, ctx);
    if (!inside(where, ctx)) return { ok: false, reason: `runs in ${where}, outside this lane's checkout` };
  }
  const texts = [command ?? "", ...input.paths, input.kind === "execute" && !command ? input.title : ""].filter(Boolean);
  for (const text of texts) if (SECRET.test(text)) return { ok: false, reason: "reads or uses credentials (SSH keys, cloud or GitHub tokens, agent logins)" };
  const line = command ?? (input.kind === "execute" ? input.title : "");
  if (line) {
    for (const [re, why] of PIPE_RULES) if (re.test(line)) return { ok: false, reason: why };
    for (const cmd of simpleCommands(line)) { const why = checkCommand(cmd, ctx); if (why) return { ok: false, reason: why }; }
  }
  // File tools: edits, deletes and moves outside the checkout.
  if (["edit", "delete", "move"].includes(input.kind ?? "")) {
    const out = input.paths.map((p) => expand(p, ctx)).find((p) => !inside(p, ctx));
    if (out) return { ok: false, reason: `${input.kind === "delete" ? "deletes" : input.kind === "move" ? "moves" : "edits"} ${out}, outside this lane's checkout` };
  }
  return { ok: true };
}
