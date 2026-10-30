import { useEffect, useState } from "react";
import { getJson } from "../api";

let cached: Promise<string | null> | null = null;
/** The owner's editor link template ([editor] url in config), fetched once per page load. */
export function useEditor(): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => { void (cached ??= getJson<{ url: string }>("/api/editor").then((r) => r.url, () => null)).then(setUrl); }, []);
  return url;
}
export const editorLink = (template: string, path: string) => template.replaceAll("{path}", encodeURI(path));
