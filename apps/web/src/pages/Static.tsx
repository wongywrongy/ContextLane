import { Empty, PageHeader, Section } from "../components/ui";

/** Pages whose data arrives in later phases. Each keeps its final structure so layout work is done once. */
export function ReviewPage() {
  return (
    <main className="pg">
      <PageHeader title="Review" meta="decide on finished work" />
      <Section title="Checkpoints"><Empty>Result, process, plan vs done, before and after, steps and files for each checkpoint (phase 2).</Empty></Section>
    </main>
  );
}

export function ArchitecturePage() {
  return (
    <main className="pg">
      <PageHeader title="Architecture" meta="how the code fits together and where lanes touch it" />
      <Section title="Dependency view"><Empty>Layers, calls and imports from CodeGraph, with the lane overlay (phase 3).</Empty></Section>
    </main>
  );
}

export function InsightsPage() {
  return (
    <main className="pg">
      <PageHeader title="Insights" meta="what past lanes say about this project, and what to do about it" />
      <Section title="This week"><Empty>A short summary written by the local model, with links to its evidence (phase 3).</Empty></Section>
      <Section title="Suggestions"><Empty>Each suggestion cites what it saw and offers one action (phase 3).</Empty></Section>
    </main>
  );
}
