import { ReviewComment } from "@contextlanes/protocol";
import { useEffect, useState } from "react";

export type DiffLine = { text: string; kind: string; file: string; line: number | null; side: "old" | "new" };
export function diffLines(text: string): DiffLine[] {
  let file = "", old = 0, next = 0, hunk = false;
  return text.split("\n").map((text) => {
    if (text.startsWith("diff --git ")) { file = ""; hunk = false; }
    if (!hunk && /^(---|\+\+\+) /.test(text)) {
      let path = text.slice(4).split("\t")[0]!;
      if (path.startsWith('"')) {
        try {
          const octal = /\\[0-7]{3}/.test(path);
          path = JSON.parse(path.replace(/\\([0-7]{3})/g, (_, digits: string) => `\\u00${parseInt(digits, 8).toString(16).padStart(2, "0")}`)) as string;
          if (octal) path = new TextDecoder().decode(Uint8Array.from(path, c => c.charCodeAt(0)));
        } catch { path = ""; }
      }
      if (path && path !== "/dev/null") file = path.replace(/^[ab]\//, "");
    }
    const range = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (range) { old = Number(range[1]); next = Number(range[2]); hunk = true; return { text, kind: "hunk", file, line: null, side: "new" }; }
    const side = text.startsWith("-") ? "old" : "new";
    let line: number | null = null;
    if (hunk && /^[ +\-]/.test(text)) {
      line = side === "old" ? old : next;
      if (!text.startsWith("+")) old++;
      if (!text.startsWith("-")) next++;
    }
    return { text, kind: line === null ? "meta" : text.startsWith("+") ? "add" : text.startsWith("-") ? "del" : "", file, line, side };
  });
}

export function useReviewComments(lane: string) {
  const key = `cl-review:${lane}`;
  const [comments, setComments] = useState<ReviewComment[]>(() => { try { return ReviewComment.array().max(50).parse(JSON.parse(localStorage.getItem(key) ?? "[]")); } catch { return []; } });
  useEffect(() => { try { if (comments.length) localStorage.setItem(key, JSON.stringify(comments)); else localStorage.removeItem(key); } catch { /* The tray still works when storage is unavailable. */ } }, [key, comments]);
  const add = (comment: ReviewComment) => setComments((before) => before.length < 50 ? [...before, comment] : before);
  const clear = () => { try { localStorage.removeItem(key); } catch { /* Storage is optional. */ } setComments([]); };
  return { comments, setComments, add, clear };
}
