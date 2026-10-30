import type { WebSocket } from "@fastify/websocket";
import { TerminalInput } from "@contextlanes/protocol";
import type { TerminalProcess } from "../run.js";

/** The PTY is only a tmux client. Hanging it up leaves the session and shell alive. */
export function connectTerminal(socket: WebSocket, pty: TerminalProcess): void {
  let detached = false;
  const detach = () => {
    if (detached) return;
    detached = true;
    data.dispose();
    exit.dispose();
    try { pty.kill(); } catch { /* The attach client may already have exited. */ }
  };
  const data = pty.onData((text) => {
    if (socket.readyState !== socket.OPEN) return;
    if (socket.bufferedAmount > 1_048_576) {
      socket.close(1013, "Terminal connection is too slow. Reconnect to continue.");
      detach();
      return;
    }
    socket.send(text);
  });
  const exit = pty.onExit((e) => {
    detached = true;
    data.dispose();
    exit.dispose();
    // Close reasons are limited to 123 bytes.
    if (e?.error) socket.close(1011, e.error.slice(0, 120));
    else socket.close(1000, "Terminal detached.");
  });
  socket.on("message", (raw, binary) => {
    if (detached) return;
    try {
      if (binary) throw new Error("text frames only");
      const msg = TerminalInput.parse(JSON.parse(raw.toString()));
      if (msg.type === "input") pty.write(msg.data);
      else pty.resize(msg.cols, msg.rows);
    } catch {
      socket.close(1008, "Invalid terminal input.");
      detach();
    }
  });
  socket.on("close", detach);
  socket.on("error", detach);
}
