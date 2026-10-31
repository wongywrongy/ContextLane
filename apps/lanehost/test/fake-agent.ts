import { agent, methods, PROTOCOL_VERSION, type SessionConfigOption } from "@agentclientprotocol/sdk/unstable";

/** A real SDK agent app, with no model, filesystem, shell or network side effects. */
export function fakeAgent(onPrompt?: () => Promise<void>) {
  const turns: string[] = [];
  const choices: unknown[] = [];
  const sessions: unknown[] = [];
  const modes: string[] = [];
  let cancel: (() => void) | undefined;
  let release: (() => void) | undefined;
  let model = "small";
  let effort = "medium";
  const configs = (): SessionConfigOption[] => [{ id: "model", name: "Model", category: "model", type: "select", currentValue: model,
    options: [{ value: "small", name: "Small" }, { value: "large", name: "Large" }] },
    { id: "reasoning_effort", name: "Reasoning effort", category: "thought_level", type: "select", currentValue: effort,
      options: [{ value: "minimal", name: "Minimal" }, { value: "medium", name: "Medium" }, { value: "xhigh", name: "Xhigh" }] }];
  const app = agent({ name: "fake" })
    .onRequest(methods.agent.initialize, () => ({ protocolVersion: PROTOCOL_VERSION, agentCapabilities: {}, authMethods: [] }))
    .onRequest(methods.agent.session.new, ({ params }) => {
      sessions.push(params);
      return { sessionId: "fake-session", modes: { currentModeId: "default", availableModes: [
        { id: "default", name: "Ask" }, { id: "acceptEdits", name: "Accept edits" }, { id: "plan", name: "Plan" }, { id: "bypassPermissions", name: "Bypass permissions" }, { id: "agent", name: "Auto review" },
      ] }, configOptions: configs() };
    })
    .onRequest(methods.agent.session.setMode, ({ params }) => { modes.push(params.modeId); return {}; })
    .onRequest(methods.agent.session.setConfigOption, ({ params }) => { if (params.configId === "reasoning_effort") effort = String(params.value); else model = String(params.value); return { configOptions: configs() }; })
    .onNotification(methods.agent.session.cancel, () => cancel?.())
    .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
      // A new lane's first message ends with the ContextLanes tools hint; the fake agent acts on the task before it.
      const text = params.prompt.map((p) => p.type === "text" ? p.text : "").join("").replace(/\n\n---\n\nContextLanes tools[\s\S]*$/, "");
      turns.push(text);
      await onPrompt?.();
      if (text === "cost" || text === "foreign-cost") {
        await client.notify(methods.client.session.update, { sessionId: params.sessionId, update: { sessionUpdate: "usage_update", used: 10, size: 100, cost: { amount: .25, currency: text === "cost" ? "USD" : "EUR" } } });
        return { stopReason: "end_turn" };
      }
      if (text === "usage") {
        const update = (update: import("@agentclientprotocol/sdk/unstable").SessionUpdate) => client.notify(methods.client.session.update, { sessionId: params.sessionId, update });
        await update({ sessionUpdate: "usage_update", used: 142, size: 200, cost: { amount: turns.length * 0.25, currency: "USD" },
          _meta: { "_claude/rateLimit": { unifiedWindows: { five_hour: { utilization: .62, resetsAt: Math.floor(Date.now() / 1000) + 3600 }, seven_day: { utilization: .31, resetsAt: Math.floor(Date.now() / 1000) + 86400 } } } } });
        await update({ sessionUpdate: "compaction_update", compactionId: "compact-1", status: "completed" });
        await update({ sessionUpdate: "compaction_update", compactionId: "compact-1", status: "completed" });
        return { stopReason: "end_turn", usage: { totalTokens: 180, inputTokens: 100, outputTokens: 20, cachedReadTokens: 50, cachedWriteTokens: 10 } };
      }
      await client.notify(methods.client.session.update, { sessionId: params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `Started ${text}. ` } } });
      if (text === "showcase") {
        const update = (update: import("@agentclientprotocol/sdk").SessionUpdate) => client.notify(methods.client.session.update, { sessionId: params.sessionId, update });
        await update({ sessionUpdate: "plan", entries: [{ content: "Read the current config", status: "completed", priority: "medium" }, { content: "Change validation and run checks", status: "in_progress", priority: "high" }] });
        await update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "I will keep the validation at the boundary." } });
        await update({ sessionUpdate: "tool_call", toolCallId: "read", title: "Read config.ts", kind: "read", status: "completed", locations: [{ path: "src/config.ts" }] });
        await update({ sessionUpdate: "tool_call", toolCallId: "edit", title: "Validate the project path", kind: "edit", locations: [{ path: "src/config.ts" }] });
        await update({ sessionUpdate: "tool_call_update", toolCallId: "edit", status: "failed" });
        await update({ sessionUpdate: "tool_call_update", toolCallId: "edit", status: "completed", content: [{ type: "diff", path: "src/config.ts", oldText: "same\nold\n", newText: "same\nnew\nextra\n" }] });
        await update({ sessionUpdate: "tool_call", toolCallId: "test", title: "Run project checks", kind: "execute" });
        await update({ sessionUpdate: "tool_call_update", toolCallId: "test", status: "completed", content: [{ type: "content", content: { type: "text", text: "TAP version 13\nok 1 - valid path\nok 2 - rejects outside path\n" } }] });
        await update({ sessionUpdate: "usage_update", used: 1024, size: 8192 });
        await update({ sessionUpdate: "tool_call", toolCallId: "helper", title: "Ask a helper to read validation", name: "Agent", kind: "other", status: "completed" });
      }
      if (text === "permission") {
        const result = await client.request(methods.client.session.requestPermission, { sessionId: params.sessionId,
          toolCall: { toolCallId: "tool-1", title: "Run fixture check", kind: "execute" },
          options: [{ optionId: "yes", name: "Allow once", kind: "allow_once" }, { optionId: "no", name: "Deny", kind: "reject_once" }] });
        choices.push(result.outcome);
      }
      if (text === "busy") {
        // A command that runs until the test releases it, then the agent keeps going until stopped.
        await client.notify(methods.client.session.update, { sessionId: params.sessionId, update: { sessionUpdate: "tool_call", toolCallId: "busy-1", title: "pnpm test", kind: "execute", status: "in_progress" } });
        await new Promise<void>((resolve) => { release = resolve; });
        await client.notify(methods.client.session.update, { sessionId: params.sessionId, update: { sessionUpdate: "tool_call_update", toolCallId: "busy-1", status: "completed" } });
        await new Promise<void>((resolve) => { cancel = resolve; });
        cancel = undefined;
        return { stopReason: "cancelled" };
      }
      if (text === "hold") {
        await new Promise<void>((resolve) => { cancel = resolve; });
        cancel = undefined;
        return { stopReason: "cancelled" };
      }
      await client.notify(methods.client.session.update, { sessionId: params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `Finished ${text}.` } } });
      return { stopReason: "end_turn" };
    });
  return { app, turns, choices, sessions, modes, release: () => release?.() };
}
