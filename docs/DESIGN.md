# ContextLanes — visual system

The v2 reference screenshots live in [mockups/v2/](mockups/v2/); they predate the current disclosure refinements. The v2 plan in [V2.md](V2.md) supersedes the earlier cream canvas boards. Shared tokens and page classes live in `apps/web/src/styles/app.css`; `tokens.css` declares the self-hosted fonts. Claude Design boards still need to be redone to match.

## Principles

These settle disputes. When a screen and a principle disagree, the screen changes.

1. **The loop first.** Every screen answers "what needs me, and what do I do" before anything else. The loop is: start a lane, answer it, review it, merge it.
2. **One word per thing.** Use the words below and nothing else. Tool and protocol names (ACP, CodeGraph, tmux, tailnet) appear only where you set them up.
3. **One main action per section.** An accent button for the main action, ghost buttons for the rest, a text link only for navigation. A big decision (review, hand off) never sits in a list with a clipboard helper.
4. **Unknown is silent.** A value that was not measured is left out, never shown as "–", "not reported" or 0. An error is one sentence that says what to do.
5. **Glyphs mean state.** Amber only when something waits on you; a green check only for something finished or healthy. Policies and descriptions are plain text.
6. **State agrees everywhere.** Every page reads the same events; two pages showing different states for one lane is a bug.
7. **Everything in mono.** JetBrains Mono carries the interface, code, paths and prose. Use weight and rules for hierarchy.
8. **Show, then configure.** Pages show what is happening; settings live in Settings or behind an explicit Edit.
9. **Signals before sentences.** A state is a glyph and a word or two (`Fact`, `Glyph`), not a sentence. No paragraph on any page: an empty section is an icon, a few words and the action that fills it (`Empty` with `icon` and `action`); how something works sits behind the "?" next to its title (`Help`, or `Section help=`); long output (an error's log lines) sits behind Details. A real sequence (what Start runs, how work reaches Review) is drawn as steps with arrows (`.flow`), and only a real sequence.

## Words

| Word | Means | Not |
|---|---|---|
| Project | A git repository you added | repo, workspace |
| Lane | One agent on one task, with its own branch, folder and terminal | job, session, worker |
| Agent | The coding program doing the work (Claude Code, Codex, OpenCode) | model, bot |
| Local model | A model on your machines (Ollama, llama.cpp) used for small jobs | endpoint (except in its form) |
| Needs you | A question or permission request waiting for your answer | pending, blocked |
| Ask for review | Run the checks and put a lane's work on Review | send checkpoint |
| Checkpoint | One reviewable state of a lane's work: checks, screenshots, plan, diff | packet |
| Recipe | How a lane runs your app (`.contextlanes.json`): setup, services, checks | config, environment file |
| Preview | A lane's running copy of your app | environment, instance |
| Brief | A short note about a module that agents can ask for | summary, doc |
| Area / module / layer | A top folder / a folder of code in it / Web, API, Logic or Data | package, component |
| Hand off / Restart with a summary / Copy into a new lane | Another agent continues / the same agent restarts with an empty context / a second lane starts from this one | fork, fresh session |

## Look

- Dark first: background `#08090a`, panels `#0f1011`, raised surfaces `#151719`, rules `#3a3e44` (soft rules `#272a2e`).
- Ink `#f4f4f0`, dim text `#a8aaa4`, decorative faint `#5c5f59`. Small faint text uses the AA counterpart `#9a9d94`; decorative faint never carries text.
- Accent `#7ee0a3`, needs-you amber `#f2b84b`, errors `#ff6b5e`, information `#7aa7ff`.
- JetBrains Mono v2.304 is self-hosted with its OFL license. UI is 13px, small text 12px, headings 14px semibold.
- Square everywhere: no corner radius on any control, section or popup; only status dots are round. 1px rules, no cover images, no soft shadows. A floating part (menu, toast, dragged card) gets a hard 1px ink border and a flat offset shadow in `--line`. Rows start at 28px and grow for content.
- High contrast: near-black ground, near-white ink, rules visible at a glance. The focused or selected row inverts (ink background, ground text) rather than tinting.
- Built on established parts, styled only with our tokens: cmdk (jump), base-ui (dialog, popover), shiki (diff colours through `--sh-*` variables). Never ship a library's default theme.
- Dark/Light is a browser-local option in Settings. Both token sets pass `node scripts/check-contrast.mjs`; lane badge text and primary buttons are included.

## Viewer

The web app shows lanes and takes two decisions: answering a question or permission, and approving a recipe. It has no other buttons that change a lane, a project, an environment or a setting. Where a page used to act, it shows the command instead (`Cmd`: a `$` prompt, the command in mono, click to copy), so the owner or an agent runs it on the machine. The lane terminal is watch-only. Settings shows what `config.toml` holds and the lines that change it.

## Layout rules

1. **Every group of content lives in a section** with a ruled header (title, meta, actions), dense rows (28px minimum) and an optional status-line footer.
2. **One job per page.** One main column; a side column only as the inspector of something selected. No page split into two unrelated halves, and no job spread across two pages.
3. **Page jobs**

| Page | Job |
|---|---|
| Projects | What needs you, then every project |
| Inbox | Answer everything waiting on you |
| Models | Who does the work: agents with their limits, local models, helper, routing |
| Settings | Configure the machine |
| Work | Run and steer lanes: the five-column board or one lane with saved terminal/diff/preview/steps panes |
| Review | Decide on finished work |
| Run | Keep each lane's app running |
| Architecture | How the code fits together and where lanes touch it |
| Insights | Learn from past lanes and act |

4. **Empty states say what will be there and when**, never a blank box.
5. **Phone:** the same sections stacked; tabs scroll; the status bar wraps; pane splits and board columns stack.

**Show only what works.** Tabs, inspector blocks and lane actions for later phases are in the code behind `apps/web/src/features.ts` (`READY.review`, `READY.run`, …). A tab bar with one tab is hidden. Agents are given only the toolbox tools that work (`LIVE_TOOLS` in `packages/toolbox`).

**Projects:** Needs you (one row per item: kind tile, lane badge, project, what, age, Allow / Deny inline for permissions), then project sections (name, folder, lane badges, counts for every board column and Needs you lanes inline). Add repo opens a dialog; it never takes over the page.

**Add repositories:** a checklist of repositories your agents already work in (Claude Code and Codex session history, newest first, with their marks) and ones found in your home folder, each with path and branch, nothing preselected. Repositories that cannot be used yet say why in one sentence (owned by another user, no commits). Large data folders are skipped and named. Choose a folder swaps the list for a folder browser inside the same dialog: breadcrumbs, folders with a git tag and an Add button on each repository, and a path field that accepts `~` and paths outside home.

**Work · one lane:** the native CLI terminal is the main pane for CLI lanes; ACP keeps Progress as its initial view. The lane navigation stays at the left and its inspector at the right. The inspector keeps terminal/editor access visible; copy helpers and lane actions use labeled native disclosures. Failed lanes open their recovery actions. Reported context is a compact percentage with token details on demand. Each pane can show Terminal, Diff, Preview, Progress or Steps. Split the selected pane right or down, change its view or close it; up to four equal-share panes are saved per lane in guarded localStorage. Phone splits stack. A status line below shows the lane colour/number, agent, state glyph and word, reported context and any waiting question. The composer remains visible and shows its real queue. A failed lane explains why above its controls.

**Inbox:** list on the left (kind tile, lane badge, project, title, age; the selected one has an amber edge), the selected item on the right (lane and agent, the request in a sentence, the command if any, every option as a button, what led here, open the lane). Filter chips by kind.

**Models:** ready agents first. Unconfigured local models and routing remain available in collapsed Optional sections. Configured endpoints stay expanded so failures and workload remain visible.

**Setup:** two columns. Left: what to run on the machine (`contextlanes setup`) and why an always-on machine. Right: numbered steps with Done / Now / Next: sign in, connect an agent, add projects, start your first lane, then the optional phone and local-model steps. Only the current step is open; done steps can be reopened with Change.

**Terminal:** every pane attaches to the same native tmux session. Closing a pane or changing theme never stops the CLI. Reconnect belongs to a lost browser connection. `contextlanes open <lane>` opens that same session from a shell.

**Header:** a compact status bar shows the machine, project/lane breadcrumbs, Inbox count, navigation and the command palette hint. No project covers.

**Keyboard:** ⌘/Ctrl 1–9 jumps to lanes; j/k moves in a list; a opens the selected question or focuses its answer choices (Tab/Enter chooses); r opens Review; : or ⌘/Ctrl K opens the palette; ? lists keys. ⌘/Ctrl D splits right, ⌘/Ctrl Shift D down. Keys never fire in an input, editor, terminal, composition or an open dialog. Buttons provide every action on a phone.

## Legend

Meaning is never carried by colour alone: every state has a shape, every step kind an icon, every lane a number.

**Lane states**

| Glyph | State | Meaning |
|---|---|---|
| ● ink dot | Working | The agent is doing something |
| ◌ dashed blue ring | Thinking / setting up | Working, nothing to see yet |
| ◆ amber diamond | Needs you · In review | Waiting on you; the only amber thing on screen |
| ■ red square | Failed | Stopped until you retry |
| ✓ green dot | Done · Merged | Finished |
| ○ hollow ring | Idle · Draft | Not running |
| ‖ bars | Paused | Kept, not running |

**Step families** (icon tile colours)

| Family | Tile | ACP kinds and ours |
|---|---|---|
| Look | quiet `#24231e` | read, search, fetch |
| Change | blue `#1c2635` | edit, delete, move |
| Run | green `#172b20` | execute, test, environment |
| Mind | violet `#232438` | plan, think |
| You | amber `#302619` | permission, question, checkpoint |
| Team | pink `#302331` | handoff, subagent, local helper |

**Lanes:** six colours in order `#9aa7ff`, `#6fd5d3`, `#ed9ed2`, `#c0ce78`, `#a8b8ce`, `#e4af82`, always with the lane number badge (`01`).

**Agent and model marks:** monogram tiles: CC Claude Code, CX Codex, OC OpenCode, HA Hermes, OL Ollama, LC llama.cpp. The app can load each vendor's official logo from its brand kit at build time, following their guidelines.

**Lines in graphs and diagrams**

| Line | Meaning |
|---|---|
| solid grey arrow | calls or imports (Architecture) · spawned (Overview) |
| dashed blue | a handoff, or a dependency a lane added |
| dotted grey | subagent, or happens later |
| dashed amber box | gate: your review |

**Module boxes (Architecture)**

| Box | Meaning |
|---|---|
| panel with a coloured left edge | a lane edits it (edge = lane colour) |
| dashed amber | two lanes edit it |
| dotted border, "uses a change" | depends on a module a lane changed |
| quiet fill, dim text | no lane here |
| green "new" tag | added by a lane |

**Timeline and review:** solid bar = working; amber stripes = waiting on you; red outline on a step tile = failed then fixed; green and red diff bar = added and removed lines; one pip per test, red = failing.

## Copy

Plain words. Say what happened and what to do: "Claude wants to run a command", "Allow once", "Keeps running when you close this tab". No AI jargon in the UI.

**Work overview:** Working, Needs you, In review, Merged (last seven days) and Failed. Cards show lane number/colour, agent, title and the plain now line, with context, verdict and preview only when reported. Dropping a working card into In review requests a checkpoint; a failed card dropped into the archive area keeps its checkout/history. Phone Actions menus call the same APIs.
