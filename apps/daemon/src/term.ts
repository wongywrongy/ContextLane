/**
 * Terminal output for the commands people run by hand (update, setup): colour and a spinner on a
 * terminal, plain lines when piped, logged by systemd or NO_COLOR is set (no-color.org).
 */
export const isTty = (stream: NodeJS.WriteStream = process.stdout) => !!stream.isTTY && !process.env.NO_COLOR && process.env.TERM !== "dumb";
const paint = (code: string) => (s: string) => isTty() ? `\x1b[${code}m${s}\x1b[0m` : s;
export const bold = paint("1"), dim = paint("2"), green = paint("32"), red = paint("31"), yellow = paint("33"), cyan = paint("36");
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const mark = { ok: () => green("✓"), warn: () => yellow("!"), fail: () => red("✗") };

export function elapsed(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/** Steps: a line ending in "…" spins until the next line arrives, then is marked done with its time. */
export class Steps {
  private current: { text: string; at: number; timer: NodeJS.Timeout | null } | null = null;
  private frame = 0;
  constructor(private out: NodeJS.WriteStream = process.stdout, private now = () => Date.now()) {}

  start(text: string): void {
    this.finish("ok");
    this.current = { text, at: this.now(), timer: null };
    if (!isTty(this.out)) { this.out.write(`  ${text}…\n`); return; }
    const draw = () => {
      const c = this.current!;
      const t = this.now() - c.at;
      this.out.write(`\r\x1b[2K  ${cyan(FRAMES[this.frame++ % FRAMES.length]!)} ${c.text}${t > 3000 ? dim(` ${elapsed(t)}`) : ""}`);
    };
    draw();
    this.current.timer = setInterval(draw, 80);
  }

  /** Ends the running step (if any) with a mark and how long it took. */
  finish(how: keyof typeof mark = "ok"): void {
    const c = this.current;
    if (!c) return;
    this.current = null;
    if (c.timer) clearInterval(c.timer);
    const t = this.now() - c.at;
    if (isTty(this.out)) this.out.write(`\r\x1b[2K  ${mark[how]()} ${c.text}${t > 3000 ? dim(` ${elapsed(t)}`) : ""}\n`);
  }

  line(text: string, how: keyof typeof mark | "detail" | "plain" = "ok"): void {
    this.finish(how === "fail" ? "fail" : "ok");
    if (how === "detail") this.out.write(`    ${dim(text.trim())}\n`);
    else if (how === "plain") this.out.write(`  ${text}\n`);
    else this.out.write(`  ${mark[how]()} ${text}\n`);
  }

  /** Routes the updater's log lines: "…" lines become steps, indented lines details, warnings marked. */
  log(text: string): void {
    if (text.endsWith("…")) return this.start(text.slice(0, -1));
    if (text.startsWith("  ")) return this.line(text, "detail");
    if (text.startsWith("Open ContextLanes: ")) { this.finish(); this.out.write(`\n  ${bold("Open ContextLanes")}  ${cyan(text.slice(19).split(" ")[0]!)}${dim(text.slice(19).split(" ").slice(1).join(" ") ? ` ${text.slice(19).split(" ").slice(1).join(" ")}` : "")}\n`); return; }
    if (/did not|could not|going back|no earlier|is gone|changed its format/i.test(text)) return this.line(text, "warn");
    if (/^Run contextlanes|^This copy runs|^Undo with/.test(text)) return this.line(dim(text), "plain");
    this.line(text, "ok");
  }
}
