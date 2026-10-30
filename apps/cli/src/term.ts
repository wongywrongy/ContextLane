/** Colour on a terminal; plain when piped or NO_COLOR is set (no-color.org). Same rules as the updater's. */
export const isTty = (stream: NodeJS.WriteStream = process.stdout) => !!stream.isTTY && !process.env.NO_COLOR && process.env.TERM !== "dumb";
const paint = (code: string) => (s: string) => isTty() ? `\x1b[${code}m${s}\x1b[0m` : s;
export const bold = paint("1"), dim = paint("2"), green = paint("32"), red = paint("31"), yellow = paint("33"), cyan = paint("36");
export const ok = (s: string) => `${green("✓")} ${s}`;
export const fail = (s: string) => `${red("✗")} ${s}`;
