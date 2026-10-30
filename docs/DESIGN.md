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
