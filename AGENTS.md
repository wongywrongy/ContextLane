# Working in this repo

ContextLanes runs coding agents on an always-on Linux machine. A task is done when its required checks pass on the reviewed commit and its integration is confirmed. Agent idleness, a model verdict, and an open pull request are different states.

## Commands

Use the package manager pinned in `package.json` (Node >= 22.13, Node 24 recommended).

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm check
corepack pnpm dev
```

Run `pnpm check` before a commit. Add regression coverage for changed behavior; [DEVELOPING.md](docs/DEVELOPING.md) describes optional integration checks and their prerequisites.

## Invariants

- Write state through `Store.appendEvent` or `Store.setLaneState`. Keep persisted state and its event consistent.
- Validate requests and events with the schemas in `packages/protocol`. Run commands through the injected `Runner` with argument arrays.
- A lane checkout is agent-controlled. Daemon file access must use `apps/daemon/src/safefs.ts`; do not follow links out of a checkout or open devices/FIFOs.
- Run lane commands through `sandbox()` and daemon git/gh through `confineGit`. A permission decision is not a filesystem or network boundary.
- Owner decisions require owner credentials. Agents cannot approve recipes, enable Auto or widen permissions. Auto chooses only one-time approvals and holds uncertain requests.
- Native prompt hooks are observations, not proof of owner input. Automatic prompt echoes must not reset repair budgets or acknowledge owner-only questions.
- Never prune shared Git worktree registrations from a restricted filesystem view. Hidden checkouts are not missing checkouts; preserve registrations when visibility is incomplete.
- Review checks run in a disposable snapshot of an exact commit and approved recipe. Reject tracked-source mutations in the snapshot and live commit/recipe drift. Failed, missing, or stale required checks cannot become a successful review. Confirm the actual PR merge or parent integration before marking a lane merged or allowing cleanup.
- Unknown usage remains unknown. Label estimates as estimates; helper output size is not measured cloud-token savings.
- Keep task instructions focused on acceptance criteria and context unavailable from the code. Do not require plans, context-management rituals, or broad documentation reads for every task.

## Read only what the change needs

- [BRIEF.md](docs/BRIEF.md): product purpose and success criteria.
- [ARCHITECTURE.md](docs/ARCHITECTURE.md): lifecycle, processes, trust boundaries, and source entry points.
- [RECIPES.md](docs/RECIPES.md): environment and check configuration.
- [DESIGN.md](docs/DESIGN.md): UI rules and current mockups. Reuse existing section/components and keep state understandable without color.
- [IMPLEMENTATION.md](docs/IMPLEMENTATION.md): current status and acceptance still outstanding.

Use strict TypeScript and ESM with `.js` import extensions. Pin dependencies. Historical milestone notes are reference material, not required startup context.
