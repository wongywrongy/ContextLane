import { Cmd, Dialog } from "./ui";

/** A task as one shell word, so nothing in it is expanded by the shell it is pasted into. */
export const shellQuote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;

export function startLaneCommand(project: string, task?: string): string {
  return `cl new ${project} ${task ? shellQuote(task) : '"<task>"'}`;
}

/** Lanes start from the machine. Where a page suggests one, it hands over the command with the task filled in. */
export function StartLaneDialog({ project, task, onClose }: { project: string; task?: string; onClose: () => void }) {
  return <Dialog title="Start a lane" meta={project} onClose={onClose} footer={<button className="btn ghost" onClick={onClose}>Close</button>}>
    <p style={{ margin: "0 0 12px", fontSize: 14 }}>Run this on the machine, or hand it to your agent. The lane appears here when it starts.</p>
    <Cmd>{startLaneCommand(project, task)}</Cmd>
  </Dialog>;
}
