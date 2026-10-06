import { describe, it, expect } from "vitest";
import {
  ENTRY_SECTION_MAX_CHARS,
  clipEntryBody,
  readEntryDetail
} from "./detail.js";

describe("clipEntryBody", () => {
  it("leaves a body inside the ceiling untouched", () => {
    expect(clipEntryBody("short")).toBe("short");
  });

  it("keeps the head and the tail, and says how much went", () => {
    const lines = Array.from({ length: 2000 }, (_, n) => `line ${n}`);
    const clipped = clipEntryBody(lines.join("\n"), 400);
    expect(clipped.length).toBeLessThan(500);
    expect(clipped.startsWith("line 0\n")).toBe(true);
    expect(clipped.endsWith("line 1999")).toBe(true);
    expect(clipped).toMatch(/\n… \d+ lines elided …\n/);
  });

  it("counts characters when there are no lines to count", () => {
    const clipped = clipEntryBody("x".repeat(1000), 100);
    expect(clipped).toContain("… 900 characters elided …");
  });

  it("defaults to the ceiling an entry keeps", () => {
    const body = "y".repeat(ENTRY_SECTION_MAX_CHARS + 1);
    expect(clipEntryBody(body)).not.toBe(body);
  });
});

describe("readEntryDetail", () => {
  it("is undefined for anything that is not a card", () => {
    expect(readEntryDetail(undefined)).toBeUndefined();
    expect(readEntryDetail("Bash")).toBeUndefined();
    expect(readEntryDetail([])).toBeUndefined();
    expect(readEntryDetail({ bogus: 1 })).toBeUndefined();
  });

  it("drops what is malformed field by field, and keeps the rest", () => {
    expect(
      readEntryDetail({
        ref: "t1",
        status: "finished",
        title: 7,
        sections: [
          { label: "Input", body: "ls", format: "code" },
          { label: "Output", body: 3 },
          { body: "no label", format: "html" }
        ],
        checklist: [
          { text: "one", state: "done" },
          { text: "two", state: "maybe" }
        ]
      })
    ).toEqual({
      ref: "t1",
      sections: [
        { label: "Input", body: "ls", format: "code" },
        { label: "", body: "no label" }
      ],
      checklist: [{ text: "one", state: "done" }]
    });
  });

  it("keeps an empty checklist, which clears the pinned one", () => {
    expect(readEntryDetail({ checklist: [] })).toEqual({ checklist: [] });
  });

  it("clips a section past the ceiling", () => {
    const detail = readEntryDetail({
      sections: [
        { label: "Output", body: "z".repeat(ENTRY_SECTION_MAX_CHARS * 2) }
      ]
    });
    expect(detail?.sections?.[0]?.body.length).toBeLessThan(
      ENTRY_SECTION_MAX_CHARS + 100
    );
  });
});
