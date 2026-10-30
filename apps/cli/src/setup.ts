import { readFile } from "node:fs/promises";
import qr from "qrcode-terminal";
import { SetupLink, SetupStatus, type Project } from "@contextlanes/protocol";
import { api, daemonUrl, ClientError } from "./client.js";

export async function setupOutput(sshHost = process.env.SSH_CONNECTION?.trim().split(/\s+/)[2]): Promise<string> {
  if (!["127.0.0.1", "localhost"].includes(new URL(daemonUrl()).hostname)) throw new ClientError("Run contextlanes setup in the machine’s SSH session.");
  const status = SetupStatus.parse(await api("/api/setup/status"));
  if (!status.controlFile) throw new ClientError("Restart the ContextLanes daemon, then run contextlanes setup again.");
  const token = (await readFile(status.controlFile, "utf8").catch(() => { throw new ClientError("The local setup credential could not be read; run this command as the daemon’s user."); })).trim();
  const link = SetupLink.parse(await api("/api/setup/local", { method: "POST", body: sshHost ? { sshHost } : {}, token }));
  let code = "";
  qr.generate(link.url, { small: true }, (result) => { code = result; });
  return [...link.messages, ...(link.tunnel ? ["On your computer, open the SSH tunnel:", link.tunnel] : []),
    "Open this link or scan the QR code (single use; expires in 10 minutes):", link.url, code].join("\n");
}

export async function addProject(path = process.cwd()): Promise<Project> {
  return api<Project>("/api/projects", { method: "POST", body: { path } });
}
