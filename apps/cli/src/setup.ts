import { readFile } from "node:fs/promises";
import qr from "qrcode-terminal";
import { SetupLink, SetupStatus, type Project } from "@contextlanes/protocol";
import { api, daemonUrl, ClientError } from "./client.js";
import { bold, cyan, dim, yellow } from "./term.js";

export async function setupOutput(sshHost = process.env.SSH_CONNECTION?.trim().split(/\s+/)[2]): Promise<string> {
  if (!["127.0.0.1", "localhost"].includes(new URL(daemonUrl()).hostname)) throw new ClientError("Run contextlanes setup in the machine’s SSH session.");
  const parsed = SetupStatus.safeParse(await api("/api/setup/status"));
  if (!parsed.success || !parsed.data.controlFile) throw new ClientError("Restart the ContextLanes daemon, then run contextlanes setup again.");
  const status = parsed.data;
  const token = (await readFile(status.controlFile!, "utf8").catch(() => { throw new ClientError("The local setup credential could not be read; run this command as the daemon’s user."); })).trim();
  const link = SetupLink.parse(await api("/api/setup/local", { method: "POST", body: sshHost ? { sshHost } : {}, token }));
  let code = "";
  qr.generate(link.url, { small: true }, (result) => { code = result; });
  return ["", `  ${bold("ContextLanes setup")}`, "", ...(link.messages.length ? [`  ${bold("Do this first")} on this machine:`, ...link.messages.map((m) => `     ${yellow(m)}`)] : []),
    ...(link.tunnel ? ["", `  ${bold("1.")} On your computer, open the SSH tunnel:`, `     ${cyan(link.tunnel)}`, "", `  ${bold("2.")} Then open this link, or scan the code with your phone:`] : ["", `  ${bold("Open this link")}, or scan the code with your phone:`]),
    `     ${cyan(link.url)}`, `     ${dim("Works once and expires in 10 minutes. Run contextlanes setup again for a new one.")}`, "", code,
    `  ${bold("Next")} in the browser: connect an agent, add a project, then start a lane.`, ""].join("\n");
}

export async function addProject(path = process.cwd()): Promise<Project> {
  return api<Project>("/api/projects", { method: "POST", body: { path } });
}
