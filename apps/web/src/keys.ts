export type KeyAction = "palette" | "help" | "next" | "previous" | "answer" | "review" | "split-right" | "split-down" | { lane: number };
type Key = Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "isComposing" | "defaultPrevented">;
export function keyAction(e: Key, typing: boolean, dialog = false): KeyAction | null {
  if (typing || dialog || e.defaultPrevented || e.isComposing || e.altKey) return null;
  const cmd = e.metaKey || e.ctrlKey;
  if (cmd) {
    if (/^[1-9]$/.test(e.key)) return { lane: Number(e.key) - 1 };
    if (e.key.toLowerCase() === "k") return "palette";
    if (e.key.toLowerCase() === "d") return e.shiftKey ? "split-down" : "split-right";
    return null;
  }
  const plain: Record<string, KeyAction> = { ":": "palette", "?": "help", j: "next", k: "previous", a: "answer", r: "review" };
  return plain[e.key] ?? null;
}
export function typingTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || !!target.closest("input,textarea,select,.tty,.xterm,[contenteditable=true]"));
}
