# ContextLanes — visual system

The mockups live on the design canvas, page v4 ("Full site"), with a **Legend** board that shows every code below in one place. Tokens are in `apps/web/src/styles/tokens.css`.

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
| Work | Run and steer lanes: overview graph or one lane (Steps / Terminal) |
| Review | Decide on finished work |
| Run | Keep each lane's app running |
| Architecture | How the code fits together and where lanes touch it |
| Insights | Learn from past lanes and act |

4. **Empty states say what will be there and when**, never a blank box.
5. **Phone:** the same sections stacked; tabs scroll; the top bar becomes two rows.

**Work terminal:** the Steps / Terminal controls sit in the existing section header. Terminal shows a connection status in words, an xterm shell that fits the available width, a Reconnect action on disconnection, and a footer explaining persistence and `contextlanes term`. Keyboard focus is visible; xterm's screen-reader mode is enabled. Switching away detaches the browser without ending the shell. Phone layout is verified in Chromium at 390px; physical keyboard behavior still needs device acceptance.

**Inbox:** live requests sit in the Waiting section, with a diamond, the full request title, lane link and named single-use choices. Answer targets are at least 44px tall; no choice is selected or answered automatically. Busy controls disable only while sending, and failures remain visible with the request. The Phone notifications section enables this device after explicit browser permission. A web manifest and push-only service worker support installation; there is no cached approval state.

**Setup:** one section-led column with exactly three steps: Agent, Project, First lane. Each progress item has a state glyph and Done / Not done. Continue is disabled until the current requirement and earlier gates are complete. The terminal owns initial ownership, remote access, linger and a ten-minute QR/link; no claim-code field appears. Installed agent CLIs appear first, the rest under Other agents. Each has only Ready, Install or Sign in; login opens the fixed agent command inline in an xterm section. Known failures say what to do without displaying raw errors.

Project discovery lists unchecked repositories with name/path/current branch. Browsing home and entering a `~` path are secondary choices. First lane uses labelled branch/ready-agent menus and an example task placeholder. Notifications/local endpoints are optional Projects sections after the first lane: Web Push comes first, ntfy/Telegram sit under Other ways. The Serve URL fills itself. A passkey action appears after sign-in at the HTTPS address and is labelled Add a passkey for this address. Forms use 16px inputs, 44px action targets and the existing warm section system. Fresh configs have passed at 1440px and 390px.

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

**Work overview:** goal cards lead to numbered lane cards; a dashed amber gate appears only for lanes awaiting an answer or review. Nodes include words and glyphs. The two-hour strip uses event times and idle periods; a new lane may have only a tiny mark at the right edge. Timeline rows are keyboard-accessible alternatives to graph selection.

**Work · one lane:** navigation stays on the left; one step trail and composer form the main column; the right column inspects only this lane. Steps have timestamps and named family tiles. Thinking and long output start collapsed. Measured changes use green/red diff bars; test pips have passed/failed names and numerical totals. Failed-then-fixed tools retain a red outline and word label. The composer preserves failed drafts. Phones use a horizontal lane strip, stacked inspector and 16px composer text to avoid keyboard zoom.
