import type { InboxItem } from "@contextlanes/protocol";
import { useJson } from "../api";
import { Empty, PageHeader, Section } from "../components/ui";

export function InboxPage() {
  const [items] = useJson<InboxItem[]>("/api/inbox");
  return (
    <main className="page">
      <PageHeader title="Inbox" meta="everything waiting on you, oldest first" />
      <Section title="Waiting" meta={items ? String(items.length) : ""}>
        {items?.length ? (
          items.map((i) => (
            <div className="sec-r" key={i.id}>
              <i className="g needs_you" />
              <span className="mono" style={{ fontSize: 12 }}>{i.lane}</span>
              <span style={{ flex: 1 }}>{i.title}</span>
              <span className="lbl">{i.kind}</span>
            </div>
          ))
        ) : (
          <Empty>Nothing is waiting on you. Permission requests and finished checkpoints land here and on your phone.</Empty>
        )}
      </Section>
    </main>
  );
}
