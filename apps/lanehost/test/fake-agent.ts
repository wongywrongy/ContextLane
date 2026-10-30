import { agent, methods, PROTOCOL_VERSION, type SessionConfigOption } from "@agentclientprotocol/sdk";

/** A real SDK agent app, with no model, filesystem, shell or network side effects. */
export function fakeAgent() {
  const turns: string[] = [];
  const choices: unknown[] = [];
  const sessions: unknown[] = [];
  const modes: string[] = [];
  let cancel: (() => void) | undefined;
  let model = "small";
  const configs = (): SessionConfigOption[] => [{ id: "model", name: "Model", category: "model", type: "select", currentValue: model,
    options: [{ value: "small", name: "Small" }, { value: "large", name: "Large" }] }];
  const app = agent({ name: "fake" })
    .onRequest(methods.agent.initialize, () => ({ protocolVersion: PROTOCOL_VERSION, agentCapabilities: {}, authMethods: [] }))
    .onRequest(methods.agent.session.new, ({ params }) => {
      sessions.push(params);
      return { sessionId: "fake-session", modes: { currentModeId: "default", availableModes: [
        { id: "default", name: "Ask" }, { id: "plan", name: "Plan" }, { id: "bypassPermissions", name: "Bypass permissions" }, { id: "agent", name: "Auto review" },
      ] }, configOptions: configs() };
    })
    .onRequest(methods.agent.session.setMode, ({ params }) => { modes.push(params.modeId); return {}; })
    .onRequest(methods.agent.session.setConfigOption, ({ params }) => { model = String(params.value); return { configOptions: configs() }; })
    .onNotification(methods.agent.session.cancel, () => cancel?.())
    .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
      const text = params.prompt.map((p) => p.type === "text" ? p.text : "").join("");
      turns.push(text);
      await client.notify(methods.client.session.update, { sessionId: params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `Started ${text}. ` } } });
      if (text === "permission") {
        const result = await client.request(methods.client.session.requestPermission, { sessionId: params.sessionId,
          toolCall: { toolCallId: "tool-1", title: "Run fixture check", kind: "execute" },
          options: [{ optionId: "yes", name: "Allow once", kind: "allow_once" }, { optionId: "no", name: "Deny", kind: "reject_once" }] });
        choices.push(result.outcome);
      }
      if (text === "hold") {
        await new Promise<void>((resolve) => { cancel = resolve; });
        cancel = undefined;
        return { stopReason: "cancelled" };
      }
      await client.notify(methods.client.session.update, { sessionId: params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `Finished ${text}.` } } });
      return { stopReason: "end_turn" };
    });
  return { app, turns, choices, sessions, modes };
}
