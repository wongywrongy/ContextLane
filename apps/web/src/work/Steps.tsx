import type { InboxItem, LaneEvent } from "@contextlanes/protocol";
import { PermissionCard } from "../components/PermissionCard";
import { Empty, StepIcon } from "../components/ui";
import { stepsFor, type Step } from "./model";

function TestPips({ tests }: { tests: { name: string; passed: boolean }[] }) {
  return <div className="test-pips" aria-label={`${tests.filter((test) => test.passed).length} of ${tests.length} tests passed`}>
    {tests.map((test, i) => <span key={i} className={test.passed ? "pass" : "fail"} title={`${test.passed ? "Passed" : "Failed"}: ${test.name}`} aria-label={`${test.passed ? "Passed" : "Failed"}: ${test.name}`} />)}
    <span>{tests.filter((test) => test.passed).length}/{tests.length} passed</span>
  </div>;
}
function StepBody({ step, events, waiting, reload }: { step: Step; events: LaneEvent[]; waiting: InboxItem[]; reload: () => void }) {
  if (step.type === "thought") return <details><summary>Thinking</summary><p className="step-text">{step.text}</p></details>;
  if (step.type === "plan" && step.event.type === "agent.plan") return <><strong>Plan</strong><ol className="plan-list">{step.event.payload.entries.map((entry, i) => <li key={i} className={entry.status}><span>{entry.status.replaceAll("_", " ")}</span>{entry.text}</li>)}</ol></>;
  if (step.type === "permission" && step.event.type === "permission.requested") {
    const request = step.event.payload;
    const pending = waiting.find((item) => item.id === `${step.event.lane}#${request.requestId}`);
    const answer = events.find((e) => e.type === "permission.answered" && e.payload.requestId === request.requestId);
    if (pending) return <PermissionCard item={pending} answered={reload} />;
    return <><strong>{step.title}</strong><p className="muted">{answer?.type === "permission.answered" ? `Answered: ${request.options.find((o) => o.id === answer.payload.optionId)?.label ?? "Cancelled"}` : "Waiting for your answer…"}</p></>;
  }
  if (step.tool) {
    const { diff, tests, status, failedBefore, files, summary } = step.tool;
    return <><div className="step-heading"><strong>{step.title}</strong><span className={`step-status ${status ?? "pending"}`}>{failedBefore && status === "completed" ? "Failed, then fixed" : (status ?? "pending").replaceAll("_", " ")}</span></div>
      {files.length ? <p className="mono step-files">{files.join(" · ")}</p> : null}
      {diff ? <div className="diff-stat" aria-label={`${diff.added} lines added, ${diff.removed} removed`}><span className="added">+{diff.added}</span><span className="removed">−{diff.removed}</span><span className="diff-bar"><i className="added" style={{ flex: diff.added }} /><i className="removed" style={{ flex: diff.removed }} /></span></div> : null}
      {tests?.length ? <TestPips tests={tests} /> : null}
      {summary ? <details className="tool-output"><summary>Output</summary><pre>{summary}</pre></details> : null}
    </>;
  }
  if (step.event.type === "check.result") return <><strong>{step.title}</strong><TestPips tests={[{ name: step.event.payload.name, passed: step.event.payload.passed }]} />{step.event.payload.detail ? <p>{step.event.payload.detail}</p> : null}</>;
  return <><strong>{step.title}</strong>{step.text ? <p className="step-text">{step.text}</p> : null}</>;
}
export function Steps({ events, waiting, reload }: { events: LaneEvent[]; waiting: InboxItem[]; reload: () => void }) {
  const steps = stepsFor(events);
  if (!steps.length) return <Empty>The agent's plan, messages and tool calls will appear here as they arrive.</Empty>;
  return <div className="step-trail">{steps.map((step) => <article key={step.seq} className={`trail-row ${step.family}${step.tool?.failedBefore ? " recovered" : ""}`}>
    <time dateTime={step.at}>{new Date(step.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })}</time><StepIcon family={step.family} /><div className="step-body"><StepBody step={step} events={events} waiting={waiting} reload={reload} /></div>
  </article>)}</div>;
}
