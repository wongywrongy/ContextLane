Captured from Claude Code 2.1.316 and Codex 0.166.0 on neo, 2026-11-01, using one-line tasks in throwaway `/tmp` repositories. Paths, session/turn/call ids are scrubbed; hook field names and native result shapes are preserved. PermissionRequest has no tool_use_id; Codex adds a description absent from its matching PreToolUse input.

Claude's fixture wrote `hello.txt`; its permission was answered from the 390px Inbox. Codex fetched a loopback fixture URL with Python and wrote `hello.txt` after a 390px Inbox answer. Its Bash PostToolUse response was empty; `session.jsonl` contains the matching native CommandExecution and token-count records used to recover its output and exit status at Stop.

Codex does not expose Notification in this installed version, so there is no fabricated Notification fixture. Its seven generated hooks were reviewed individually in `/hooks` inside its isolated CODEX_HOME; unrelated plugin hooks remained untrusted. Generated configurations never modified the user's global trust list.

Only token-count fields needed by replay are retained in the session fixture. Unused account-credit metadata was removed in V8; the fixture audit test rejects credential and credit/balance keys in future captures. Earlier commits remain in history, as required by the no-history-rewrite rule.
