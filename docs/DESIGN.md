# ContextLanes — visual system

The mockups are exported to [mockups/](mockups/README.md), one image per page, with a **Legend** board that shows every code below in one place. The web app ports the canvas CSS with the same class names (`apps/web/src/styles/app.css`); tokens are in `tokens.css`. Match the board; do not reinterpret it.

## Principles

These settle disputes. When a screen and a principle disagree, the screen changes.

1. **The loop first.** Every screen answers "what needs me, and what do I do" before anything else. The loop is: start a lane, answer it, review it, merge it.
2. **One word per thing.** Use the words below and nothing else. Tool and protocol names (ACP, CodeGraph, tmux, tailnet) appear only where you set them up.
3. **One main action per section.** A black button for the main action, ghost buttons for the rest, a text link only for navigation. A big decision (review, hand off) never sits in a list with a clipboard helper.
4. **Unknown is silent.** A value that was not measured is left out, never shown as "–", "not reported" or 0. An error is one sentence that says what to do.
5. **Glyphs mean state.** Amber only when something waits on you; a green check only for something finished or healthy. Policies and descriptions are plain text.
6. **State agrees everywhere.** Every page reads the same events; two pages showing different states for one lane is a bug.
7. **Machine text in mono, people text in sans.** Ids, branches, paths, numbers and section meta are mono; sentences are not.
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

- Light first, warm and editorial: cream background `#FAF7F2`, white section cards, black ink `#0D0C0B`.
- Hanken Grotesk for text, JetBrains Mono for ids, numbers, paths and labels.
- Thin dividers, no shadows except the selected item.
- Wordmark: "Context" solid, "Lanes" sliced into three horizontal lanes.

## Layout rules

1. **Every group of content lives in a section card** with a header row (title, one line of meta, actions on the right), rows that share one rhythm (52px minimum) and an optional footer.
2. **One job per page.** One main column; a side column only as the inspector of something selected. No page split into two unrelated halves, and no job spread across two pages.
3. **Page jobs**

| Page | Job |
|---|---|
| Projects | What needs you, then every project |
| Inbox | Answer everything waiting on you |
| Models | Who does the work: agents with their limits, local models, helper, routing |
| Settings | Configure the machine |
| Work | Run and steer lanes: the overview (one row per lane) or one lane (Steps / Terminal) |
| Review | Decide on finished work |
| Run | Keep each lane's app running |
| Architecture | How the code fits together and where lanes touch it |
| Insights | Learn from past lanes and act |

4. **Empty states say what will be there and when**, never a blank box.
5. **Phone:** the same sections stacked; tabs scroll; the top bar becomes two rows.

**Show only what works.** Tabs, inspector blocks and lane actions for later phases are in the code behind `apps/web/src/features.ts` (`READY.review`, `READY.run`, …). A tab bar with one tab is hidden. Agents are given only the toolbox tools that work (`LIVE_TOOLS` in `packages/toolbox`).

**Projects:** Needs you (one row per item: kind tile, lane badge, project, what, age, Allow / Deny inline for permissions), then project tiles (cover, name, folder, lane badges with glyphs, one status line). Add repo opens a dialog; it never takes over the page.

**Add repositories:** a checklist of repositories your agents already work in (Claude Code and Codex session history, newest first, with their marks) and ones found in your home folder, each with path and branch, nothing preselected. Repositories that cannot be used yet say why in one sentence (owned by another user, no commits). Large data folders are skipped and named. Choose a folder swaps the list for a folder browser inside the same dialog: breadcrumbs, folders with a git tag and an Add button on each repository, and a path field that accepts `~` and paths outside home.

**Work · one lane:** lane list on the left grouped by goal (rail in the lane colour, agent mark, task, glyph, what it is doing now; idle lanes say so); the lane in the middle (header, model and mode controls with Auto on/off and Interrupt, Steps / Terminal with All / Thinking / Changes, the step trail on a spine in its own scrolling window sized to the screen (it opens at the latest step, follows new steps while you are at the bottom, stays put when you scroll up with a Latest button back, and loads earlier steps as you reach the top), the permission card at "now", the message box with queued messages on top); the inspector on the right (plan with glyphs, context ring, checkout, lane actions). A failed lane shows why it stopped above the controls.

**Inbox:** list on the left (kind tile, lane badge, project, title, age; the selected one has an amber edge), the selected item on the right (lane and agent, the request in a sentence, the command if any, every option as a button, what led here, open the lane). Filter chips by kind.

**Setup:** two columns. Left: what to run on the machine (`contextlanes setup`) and why an always-on machine. Right: numbered steps with Done / Now / Next: sign in, connect an agent, add projects, start your first lane, then the optional phone and local-model steps. Only the current step is open; done steps can be reopened with Change.

**Terminal:** Steps / Terminal sit in the section header. The terminal footer says it is your shell, keeps running when the tab closes, and shows `contextlanes term NN`.

## Legend

Meaning is never carried by colour alone: every state has a shape, every step kind an icon, every lane a number.

**Lane states**

| Glyph | State | Meaning |
|---|---|---|
| ● black dot | Working | The agent is doing something |
| ◌ dashed violet ring | Thinking / setting up | Working, nothing to see yet |
| ◆ amber diamond | Needs you · In review | Waiting on you; the only amber thing on screen |
| ■ red square | Failed | Stopped until you retry |
| ✓ green dot | Done · Merged | Finished |
| ○ hollow ring | Idle · Draft | Not running |
| ‖ bars | Paused | Kept, not running |

**Step families** (icon tile colours)

| Family | Tile | ACP kinds and ours |
|---|---|---|
| Look | sand `#EFE8DC` | read, search, fetch |
| Change | blue `#E3EAF8` | edit, delete, move |
| Run | green `#E3F0E6` | execute, test, environment |
| Mind | violet `#ECE7FD` | plan, think |
| You | amber `#FCEBC9` | permission, question, checkpoint |
| Team | pink `#F5E3EE` | handoff, subagent, local helper |

**Lanes:** six colours in order `#4C5BD4`, `#0E8A8A`, `#B0458C`, `#7A7F2A`, `#55657A`, `#9A5B2E`, always with the lane number badge (`01`).

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
| white with a coloured left edge | a lane edits it (edge = lane colour) |
| dashed amber | two lanes edit it |
| dotted border, "uses a change" | depends on a module a lane changed |
| sand fill, grey text | no lane here |
| green "new" tag | added by a lane |

**Timeline and review:** solid bar = working; amber stripes = waiting on you; red outline on a step tile = failed then fixed; green and red diff bar = added and removed lines; one pip per test, red = failing.

## Copy

Plain words. Say what happened and what to do: "Claude wants to run a command", "Allow once", "Keeps running when you close this tab". No AI jargon in the UI.

**Work overview:** one section per goal (or one "Lanes" section when no lane has a goal), the group with something waiting on you first. Each lane is one row: badge and agent mark, task, what it is doing in plain words ("Running pnpm test", "Wants to run rg", never the raw command line), its last two hours as a bar, and its state with how long it has been in it. It reads the same with one lane or thirty, so it replaced the graph (October 2026), which was empty with few lanes and tangled with many.
