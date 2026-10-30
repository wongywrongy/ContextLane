import { useEffect, useRef, useState } from "react";
import { Terminal as Xterm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { AgentId, TerminalInput } from "@contextlanes/protocol";
import { ticketUrl } from "../api";
import "@xterm/xterm/css/xterm.css";

export function Terminal(props: ({ lane: string; login?: never } | { login: AgentId; lane?: never }) & { onExit?: () => void }) {
  const { lane, login } = props;
  const onExit = useRef(props.onExit); onExit.current = props.onExit;
  const container = useRef<HTMLDivElement>(null);
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState("Connecting to the shell…");
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const term = new Xterm({
      fontFamily: '"JetBrains Mono", monospace', fontSize: 14,
      screenReaderMode: true, scrollback: 5000,
      theme: { background: "#141310", foreground: "#E9E4DA", cursor: "#E9E4DA", selectionBackground: "#55657A" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container.current!);
    fit.fit();
    let socket: WebSocket | null = null;
    const send = (message: TerminalInput) => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    };
    setConnected(false);
    setStatus("Connecting to the shell…");
    let active = true;
    void ticketUrl(login ? `/api/setup/agents/${login}/terminal` : `/api/lanes/${lane}/terminal`).then((path) => {
      if (!active) return;
      const url = new URL(path, window.location.href);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      const open = socket = new WebSocket(url);
      open.onopen = () => {
        setConnected(true);
        setStatus(login ? "Connected · Follow the login instructions below" : "Connected · Keeps running when you close this tab");
        send({ type: "resize", cols: term.cols, rows: term.rows });
        term.focus();
      };
      open.onmessage = (event: MessageEvent<string>) => term.write(event.data);
      open.onclose = (event) => {
        setConnected(false);
        setStatus(login && event.code === 1000 ? "Login command finished. Choose Check again to confirm sign-in." : event.reason || "Connection closed. Reconnect to return to your shell.");
        if (login) onExit.current?.();
      };
      open.onerror = () => setStatus("Could not connect. Check the daemon, then reconnect.");
    }, () => setStatus("Could not connect. Check the daemon, then reconnect."));
    const input = term.onData((data) => {
      // Keep large pastes inside the wire limit, including escaped and Unicode text.
      for (const chunk of data.match(/[\s\S]{1,4096}/gu) ?? []) send({ type: "input", data: chunk });
    });
    const resize = term.onResize(({ cols, rows }) => send({ type: "resize", cols, rows }));
    const observer = new ResizeObserver(() => fit.fit());
    observer.observe(container.current!);
    void document.fonts.ready.then(() => { if (active) fit.fit(); });
    return () => {
      active = false;
      observer.disconnect();
      input.dispose();
      resize.dispose();
      if (socket) { socket.onopen = socket.onclose = socket.onerror = socket.onmessage = null; socket.close(); }
      term.dispose();
    };
  }, [lane, login, attempt]);

  return (
    <>
      <div className="terminal-status" role="status">
        <span>{status}</span>
        {!connected ? <button className="btn ghost" onClick={() => setAttempt((n) => n + 1)}>Reconnect</button> : null}
      </div>
      <div className="tty" ref={container} aria-label={login ? `Login terminal for ${login}` : `Shell for lane ${lane}`} />
      {!login && <div className="sec-f terminal-help">Same shell: <code>contextlanes term {lane}</code>. Older history: Ctrl+B, then [.</div>}
    </>
  );
}
