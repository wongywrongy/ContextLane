import type { InboxItem } from "@contextlanes/protocol";
import { useJson } from "../api";
import { Empty, PageHeader, Section } from "../components/ui";
import { useEffect } from "react";
import { PermissionCard } from "../components/PermissionCard";
import { PushSettings } from "../components/PushSettings";

export function InboxPage() {
  const [items, error, reload] = useJson<InboxItem[]>("/api/inbox");
  useEffect(() => {
    const source = new EventSource("/api/stream");
    source.addEventListener("lane", (event) => { if (/permission\.|lane.state/.test(JSON.parse((event as MessageEvent<string>).data).type)) reload(); });
    return () => source.close();
  }, [reload]);
  return (
    <main className="page">
      <PageHeader title="Inbox" meta="everything waiting on you, oldest first" />
      <Section title="Waiting" meta={items ? String(items.length) : ""}>
        {error ? <p className="sec-b" role="alert">{error.message} <button className="btn ghost" onClick={reload}>Try again</button></p> : null}
        {items?.length ? (
          items.map((i) => (
            <PermissionCard key={i.id} item={i} answered={reload} />
          ))
        ) : (
          <Empty>Nothing is waiting on you. Permission requests and finished checkpoints land here and on your phone.</Empty>
        )}
      </Section>
      <PushSettings />
    </main>
  );
}
