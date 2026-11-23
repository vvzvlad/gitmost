import { describe, expect, it } from "vitest";
import { collectParticipants, participantColor } from "./page-presence";

describe("page participants", () => {
  it("merges tabs by user and keeps editing until the last editing tab leaves", () => {
    const reader = { pagePresence: { id: "a", name: "Anna", mode: "viewing" } };
    const editor = { pagePresence: { id: "a", name: "Anna", mode: "editing" } };
    const other = {
      pagePresence: { id: "b", name: "Bohdan", mode: "viewing" },
    };
    expect(
      collectParticipants([editor, reader, other]).map((p) => [p.id, p.mode]),
    ).toEqual([
      ["a", "editing"],
      ["b", "viewing"],
    ]);
    expect(collectParticipants([reader, other])[0].mode).toBe("viewing");
    expect(collectParticipants([other]).map((p) => p.id)).toEqual(["b"]);
  });

  it("ignores absent and malformed presence and uses the same stable color as the caret", () => {
    expect(
      collectParticipants([
        {},
        { pagePresence: null },
        { pagePresence: { id: 1 } },
      ]),
    ).toEqual([]);
    const [person] = collectParticipants([
      {
        pagePresence: { id: "a", name: "Anna", mode: "editing", color: "bad" },
      },
    ]);
    expect(person.color).toBe(participantColor("a"));
  });
});
