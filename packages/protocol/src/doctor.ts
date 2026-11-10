/** One finding of `cl doctor`: what was found, and one line on how to fix it when it is not ok. */
export type DoctorCheck = { id: string; title: string; state: "ok" | "warn" | "fail"; found: string; fix?: string };
/** Also the bug-report format: versions and choices, never a token or a secret. */
export type DoctorReport = {
  version: string; node: string; platform: string; supervisor: string; sandbox: string;
  previews: { mode: string; domain: string | null; bind: string; port: number };
  checks: DoctorCheck[];
};
