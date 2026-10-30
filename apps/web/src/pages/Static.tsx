import { Empty, PageHeader, Section } from "../components/ui";

/** Pages whose data arrives in later phases. Each keeps its final structure so layout work is done once. */
export function ModelsPage() {
  return (
    <main className="page">
      <PageHeader title="Models" meta="who does the work, where it runs, and what a new lane gets" />
      <Section title="Agents" meta="each keeps its own login and limits · talks over ACP"><Empty>Claude Code, Codex and OpenCode appear here once the ACP registry check runs (phase 1).</Empty></Section>
      <Section title="Local models"><Empty>Ollama and llama.cpp endpoints with GPU memory (phase 3).</Empty></Section>
      <Section title="Local helper" meta="read · edit · check"><Empty>Uses, redo rate and tokens saved per kind (phase 3).</Empty></Section>
      <Section title="Routing"><Empty>Which agent and model a new lane gets (phase 4).</Empty></Section>
    </main>
  );
}

export function SettingsPage() {
  return (
    <main className="page" style={{ maxWidth: 1080, margin: "0 auto", width: "100%" }}>
      <PageHeader title="Settings" meta="every setting is also in ~/.config/contextlanes/config.toml" />
      {["This machine", "Access", "Notifications", "Lanes", "Data"].map((t) => (
        <Section key={t} title={t}><Empty>Read from config.toml (phase 1).</Empty></Section>
      ))}
    </main>
  );
}

export function ReviewPage() {
  return (
    <main className="page">
      <PageHeader title="Review" meta="decide on finished work" />
      <Section title="Checkpoints"><Empty>Result, process, plan vs done, before and after, steps and files for each checkpoint (phase 2).</Empty></Section>
    </main>
  );
}

export function RunPage() {
  return (
    <main className="page">
      <PageHeader title="Run" meta="each lane's copy of the app, from the approved recipe" />
      <Section title="Environments"><Empty>Lane setup, services, private links and logs (phase 2).</Empty></Section>
      <Section title="Recipe and housekeeping"><Empty>Recipe approval, cleanup and exposure (phase 2).</Empty></Section>
    </main>
  );
}

export function ArchitecturePage() {
  return (
    <main className="page">
      <PageHeader title="Architecture" meta="how the code fits together and where lanes touch it" />
      <Section title="Dependency view"><Empty>Layers, calls and imports from CodeGraph, with the lane overlay (phase 3).</Empty></Section>
    </main>
  );
}

export function InsightsPage() {
  return (
    <main className="page">
      <PageHeader title="Insights" meta="what past lanes say about this project, and what to do about it" />
      <Section title="This week"><Empty>A short summary written by the local model, with links to its evidence (phase 3).</Empty></Section>
      <Section title="Suggestions"><Empty>Each suggestion cites what it saw and offers one action (phase 3).</Empty></Section>
    </main>
  );
}
