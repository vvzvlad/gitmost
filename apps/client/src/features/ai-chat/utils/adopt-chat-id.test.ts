import { describe, it, expect } from "vitest";
import {
  resolveAdoptedChatId,
  pickNewlyCreatedChatId,
  newlyAddedChatIds,
  extractServerChatId,
} from "./adopt-chat-id";

describe("resolveAdoptedChatId", () => {
  it("adopts the server id for a brand-new chat (activeChatId null + id)", () => {
    expect(resolveAdoptedChatId(null, "chat-1")).toBe("chat-1");
  });

  it("returns null for an existing chat even with a server id", () => {
    expect(resolveAdoptedChatId("chat-existing", "chat-1")).toBeNull();
  });

  it("returns null for a new chat with no server id", () => {
    expect(resolveAdoptedChatId(null, undefined)).toBeNull();
    expect(resolveAdoptedChatId(null, null)).toBeNull();
  });
});

describe("pickNewlyCreatedChatId", () => {
  it("returns the single newly-appeared id", () => {
    expect(pickNewlyCreatedChatId(["a", "b"], ["c", "a", "b"])).toBe("c");
  });

  it("returns null when no new id appeared", () => {
    expect(pickNewlyCreatedChatId(["a", "b"], ["a", "b"])).toBeNull();
  });

  it("returns null when more than one new id appeared (ambiguous)", () => {
    expect(pickNewlyCreatedChatId(["a"], ["a", "b", "c"])).toBeNull();
  });

  it("returns the single after id when before is empty", () => {
    expect(pickNewlyCreatedChatId([], ["only"])).toBe("only");
  });

  it("treats a duplicated new id as one (deduped, not ambiguous)", () => {
    expect(pickNewlyCreatedChatId(["a"], ["a", "new", "new"])).toBe("new");
  });

  it("returns null when membership is unchanged but reordered", () => {
    expect(pickNewlyCreatedChatId(["a", "b"], ["b", "a"])).toBeNull();
  });
});

describe("newlyAddedChatIds", () => {
  it("returns the single new id", () => {
    expect([...newlyAddedChatIds(["a", "b"], ["a", "b", "c"])]).toEqual(["c"]);
  });

  it("returns an empty set when nothing was added", () => {
    expect(newlyAddedChatIds(["a", "b"], ["b", "a"]).size).toBe(0);
  });

  it("returns both new ids when two were added", () => {
    expect(newlyAddedChatIds(["a"], ["a", "b", "c"])).toEqual(
      new Set(["b", "c"]),
    );
  });

  it("keeps only the new id across an add+delete in the same window", () => {
    // before [a,b] -> after [b,new]: a was deleted, new was added.
    expect([...newlyAddedChatIds(["a", "b"], ["b", "new"])]).toEqual(["new"]);
  });

  it("dedupes a repeated new id to a single entry", () => {
    expect(newlyAddedChatIds(["a"], ["a", "new", "new"])).toEqual(
      new Set(["new"]),
    );
  });
});

describe("extractServerChatId", () => {
  it("returns the chatId when present on metadata", () => {
    expect(extractServerChatId({ metadata: { chatId: "chat-1" } })).toBe(
      "chat-1",
    );
  });

  it("returns undefined when the message has no metadata", () => {
    expect(extractServerChatId({})).toBeUndefined();
  });

  it("returns undefined when metadata lacks chatId", () => {
    expect(extractServerChatId({ metadata: { other: 1 } })).toBeUndefined();
  });

  it("returns undefined for a non-string chatId", () => {
    expect(extractServerChatId({ metadata: { chatId: 42 } })).toBeUndefined();
  });

  it("returns undefined for an undefined message", () => {
    expect(extractServerChatId(undefined)).toBeUndefined();
  });
});
