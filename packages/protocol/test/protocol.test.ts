import { describe, expect, it } from "vitest";
import { canTransition, laneColour, laneId, laneNumber, LaneEvent, parsePayload, STEP_FAMILY, waitsOnOwner } from "@contextlanes/protocol";

describe("lane ids and colours", () => {
  it("formats project-local lane numbers", () => {
    expect(laneId("shuttleworks", 1)).toBe("shuttleworks/01");
    expect(laneNumber("shuttleworks/12")).toBe("12");
  });
  it("cycles six colours", () => {
    expect(laneColour(1)).toBe("lc1");
    expect(laneColour(7)).toBe("lc1");
  });
});

describe("lane lifecycle", () => {
  it("only waits on the owner when asking or in review", () => {
    expect(waitsOnOwner("needs_you")).toBe(true);
    expect(waitsOnOwner("in_review")).toBe(true);
    expect(waitsOnOwner("working")).toBe(false);
  });
  it("allows the main path and rejects skips", () => {
    expect(canTransition("draft", "setting_up")).toBe(true);
    expect(canTransition("working", "in_review")).toBe(true);
    expect(canTransition("in_review", "working")).toBe(true);
    expect(canTransition("draft", "merged")).toBe(false);
    expect(canTransition("cleaned", "working")).toBe(false);
  });
});

describe("events", () => {
  it("validates a stored event", () => {
    const ev = LaneEvent.parse({ lane: "shuttleworks/01", seq: 1, at: "2026-10-29T13:33:00Z", type: "agent.thought", payload: { text: "fees are in the club timezone" } });
    expect(ev.type).toBe("agent.thought");
  });
  it("rejects a payload of the wrong shape", () => {
    expect(() => parsePayload("tool.call", { callId: "1" })).toThrow();
  });
  it("maps every step kind to a visual family", () => {
    expect(STEP_FAMILY.helper).toBe("team");
    expect(STEP_FAMILY.permission).toBe("you");
  });
});
