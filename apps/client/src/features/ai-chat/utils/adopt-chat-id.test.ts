import { describe, it, expect } from "vitest";
import { resolveAdoptedChatId, pickNewlyCreatedChatId } from "./adopt-chat-id";

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
