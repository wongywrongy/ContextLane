import { useEffect, useState } from "react";
import type { HighlighterCore, ThemedToken } from "shiki/core";
import type { DiffLine } from "./review";

/** File extensions shiki knows, by its language ids. Anything else stays plain. */
const LANGS: Record<string, string> = {
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "tsx", js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "jsx",
  json: "json", jsonc: "jsonc", css: "css", scss: "scss", html: "html", vue: "vue", svelte: "svelte", md: "markdown", mdx: "mdx",
  py: "python", go: "go", rs: "rust", rb: "ruby", java: "java", kt: "kotlin", swift: "swift", c: "c", h: "c", cpp: "cpp", cs: "csharp",
  sh: "shellscript", bash: "shellscript", zsh: "shellscript", yml: "yaml", yaml: "yaml", toml: "toml", sql: "sql", graphql: "graphql",
  php: "php", lua: "lua", ex: "elixir", exs: "elixir", dart: "dart", prisma: "prisma",
};
export const langOf = (file: string): string | null => LANGS[file.split(".").at(-1)?.toLowerCase() ?? ""] ?? null;

type Loaded = { highlighter: HighlighterCore; languages: Record<string, () => Promise<unknown>> };
let loading: Promise<Loaded> | null = null;

/**
 * shiki, loaded the first time a diff is shown: the core, the JavaScript regex engine (no WebAssembly),
 * and each language only when a file needs it. Colours are CSS variables (--sh-*), so the theme is ours
 * and follows light and dark (app.css).
 */
function highlighter(): Promise<Loaded> {
  return loading ??= Promise.all([import("shiki/core"), import("shiki/engine/javascript"), import("shiki/langs")]).then(async ([core, engine, langs]) => {
    const theme = core.createCssVariablesTheme({ name: "contextlanes", variablePrefix: "--sh-", variableDefaults: {}, fontStyle: true });
    const highlighter = await core.createHighlighterCore({ themes: [theme], langs: [], engine: engine.createJavaScriptRegexEngine({ forgiving: true }) });
    return { highlighter, languages: langs.bundledLanguages as Record<string, () => Promise<unknown>> };
  });
}

/**
 * Tokens for each code row of a diff, by row index. Each file's lines are highlighted together in diff
 * order, so a string or comment that spans lines keeps its colour. Rows without code get nothing; until
 * shiki is ready (or for unknown languages) every row stays plain text.
 */
export function useDiffTokens(rows: DiffLine[]): Map<number, ThemedToken[]> | null {
  const [tokens, setTokens] = useState<Map<number, ThemedToken[]> | null>(null);
  useEffect(() => {
    let live = true;
    setTokens(null);
    const files = new Map<string, number[]>();
    rows.forEach((row, i) => { if (row.line && row.file && langOf(row.file)) files.set(row.file, [...files.get(row.file) ?? [], i]); });
    if (!files.size || files.size > 40 || rows.length > 20_000) return;
    void highlighter().then(async ({ highlighter, languages }) => {
      const out = new Map<number, ThemedToken[]>();
      for (const [file, indexes] of files) {
        const lang = langOf(file)!;
        if (!highlighter.getLoadedLanguages().includes(lang)) {
          const load = languages[lang];
          if (!load) continue;
          await highlighter.loadLanguage(load as never).catch(() => {});
          if (!highlighter.getLoadedLanguages().includes(lang)) continue;
        }
        const code = indexes.map((i) => rows[i]!.text.slice(1)).join("\n");
        const lines = highlighter.codeToTokensBase(code, { lang, theme: "contextlanes" });
        indexes.forEach((rowIndex, n) => { if (lines[n]) out.set(rowIndex, lines[n]); });
      }
      if (live) setTokens(out);
    }).catch(() => {});
    return () => { live = false; };
  }, [rows]);
  return tokens;
}
