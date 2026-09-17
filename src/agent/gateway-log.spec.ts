import { describe, it, expect } from "vitest";
import {
  GATEWAY_METADATA_MAX,
  gatewayLogFields,
  type GatewayCorrelation
} from "./gateway-log.js";
import { parseTurn } from "./history.js";

describe("gatewayLogFields", () => {
  it("tags a round with its position in both metadata and the event id", () => {
    expect(
      gatewayLogFields({
        agent: "reactive",
        taskId: "t1",
        phase: "round",
        round: 3,
        channel: "C08ABC"
      })
    ).toEqual({
      metadata: {
        agent: "reactive",
        taskId: "t1",
        phase: "round",
        round: 3,
        channel: "C08ABC"
      },
      eventId: "t1:r3"
    });
  });

  it("names a subtask's event by its subtask, apart from a round's", () => {
    expect(
      gatewayLogFields({ taskId: "t1", phase: "subagent", subtaskId: 3 })
        .eventId
    ).toBe("t1:s3");
    expect(gatewayLogFields({ taskId: "t1", round: 3 }).eventId).toBe("t1:r3");
  });

  it("gives a call with no unit of work no event id", () => {
    // Compaction runs in a Session every task shares, so there is no task to
    // name — and an event id that meant "every compaction this agent ever ran"
    // would filter nothing.
    expect(
      gatewayLogFields({ agent: "reactive", phase: "compaction" })
    ).toEqual({ metadata: { agent: "reactive", phase: "compaction" } });
  });

  it("drops the lowest-priority key once the budget is spent", () => {
    const metadata = gatewayLogFields({
      agent: "a",
      taskId: "t",
      phase: "round",
      round: 1,
      subtaskId: 1,
      channel: "C"
    }).metadata;

    expect(Object.keys(metadata ?? {})).toHaveLength(GATEWAY_METADATA_MAX);
    expect(metadata).not.toHaveProperty("channel");
  });

  it("leaves out what a site does not know rather than sending a placeholder", () => {
    expect(gatewayLogFields({ agent: "", taskId: undefined })).toEqual({});
  });

  it("never carries the sender of a turn, even when handed the whole turn", () => {
    const turn = parseTurn(
      '<turn from="Ada" id="U01XYZ" channel="C08ABC" at="2026-09-17T10:00:00Z">hi</turn>'
    );
    // A caller spreading everything it has is the realistic way a person's id
    // would reach the log. The builder reads its own keys and no others.
    const fields = gatewayLogFields({
      ...(turn as unknown as GatewayCorrelation),
      phase: "triage"
    });

    expect(fields.metadata).toEqual({ phase: "triage", channel: "C08ABC" });
    expect(JSON.stringify(fields)).not.toContain("U01XYZ");
    expect(JSON.stringify(fields)).not.toContain("Ada");
  });
});
