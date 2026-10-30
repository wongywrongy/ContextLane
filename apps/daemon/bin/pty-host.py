#!/usr/bin/env python3
"""ContextLanes PTY host: runs one command on a pseudo-terminal, outside the daemon.

The daemon never loads a native terminal module. Each browser terminal is this small process,
so a crash ends that terminal only (the pattern VS Code uses for its pty host). The terminal
itself is the standard POSIX one: openpty, a new session with the pty as controlling terminal,
and TIOCSWINSZ for the window size, as ttyd, script(1) and tmux do.

    pty-host.py COLS ROWS COMMAND [ARG...]

stdin  bytes typed into the terminal
stdout bytes the terminal printed
fd 3   resize requests, one "COLS ROWS" line each
The exit code is the command's; 128+N when signal N ended it.
"""
import errno
import fcntl
import os
import select
import signal
import struct
import sys
import termios


def set_size(fd, cols, rows):
    cols = max(1, min(int(cols), 500))
    rows = max(1, min(int(rows), 200))
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def main():
    if len(sys.argv) < 4:
        sys.stderr.write("usage: pty-host.py COLS ROWS COMMAND [ARG...]\n")
        return 2
    cols, rows, command = sys.argv[1], sys.argv[2], sys.argv[3:]
    master, slave = os.openpty()
    set_size(slave, cols, rows)
    pid = os.fork()
    if pid == 0:
        try:
            os.close(master)
            os.setsid()
            fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
            for target in (0, 1, 2):
                os.dup2(slave, target)
            if slave > 2:
                os.close(slave)
            os.closerange(3, 256)
            os.environ["TERM"] = "xterm-256color"
            signal.signal(signal.SIGPIPE, signal.SIG_DFL)
            os.execvp(command[0], command)
        except OSError as err:
            os.write(2, f"Could not start {command[0]}: {err.strerror}\r\n".encode())
        os._exit(127)

    os.close(slave)

    def hang_up(*_):
        try:
            os.kill(pid, signal.SIGHUP)
        except ProcessLookupError:
            pass

    signal.signal(signal.SIGTERM, hang_up)
    signal.signal(signal.SIGHUP, hang_up)
    signal.signal(signal.SIGPIPE, signal.SIG_IGN)

    try:
        control = os.fdopen(3, "rb", buffering=0)
        sources = [master, 0, control.fileno()]
    except OSError:
        control = None
        sources = [master, 0]
    pending = b""
    out = sys.stdout.buffer

    while True:
        try:
            ready, _, _ = select.select(sources, [], [])
        except InterruptedError:
            continue
        if master in ready:
            try:
                data = os.read(master, 65536)
            except OSError as err:
                if err.errno != errno.EIO:
                    raise
                data = b""
            if not data:
                break  # The command and everything on its terminal have closed it.
            try:
                out.write(data)
                out.flush()
            except BrokenPipeError:
                hang_up()
                break
        if 0 in ready:
            data = os.read(0, 65536)
            if not data:
                hang_up()  # The daemon hung up: behave like a closed terminal window.
                sources.remove(0)
            else:
                os.write(master, data)
        if control is not None and control.fileno() in ready:
            data = os.read(control.fileno(), 4096)
            if not data:
                sources.remove(control.fileno())
                control = None
            else:
                pending += data
                while b"\n" in pending:
                    line, pending = pending.split(b"\n", 1)
                    parts = line.split()
                    if len(parts) == 2 and parts[0].isdigit() and parts[1].isdigit():
                        set_size(master, parts[0], parts[1])

    _, status = os.waitpid(pid, 0)
    if os.WIFSIGNALED(status):
        return 128 + os.WTERMSIG(status)
    return os.WEXITSTATUS(status)


if __name__ == "__main__":
    sys.exit(main())
