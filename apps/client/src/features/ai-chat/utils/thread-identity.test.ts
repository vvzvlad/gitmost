import { describe, it, expect } from "vitest";
import { newThread, switchThread, adoptThread } from "./thread-identity";

describe("newThread", () => {
  it("uses the supplied key and has no chat id yet", () => {
    expect(newThread("new-abc")).toEqual({ key: "new-abc", chatId: null });
  });
});

describe("switchThread", () => {
  it("switches to an existing chat: key becomes the chat id", () => {
    expect(switchThread("chat-1")).toEqual({
      key: "chat-1",
      chatId: "chat-1",
    });
  });
});

describe("adoptThread", () => {
  it("adopts in place for a new chat: keeps the key, sets the chat id", () => {
    const prev = newThread("new-abc");
    expect(adoptThread(prev, "chat-1")).toEqual({
      key: "new-abc",
      chatId: "chat-1",
    });
  });

  it("is a no-op for an already-persisted chat", () => {
    const prev: { key: string; chatId: string | null } = {
      key: "chat-1",
      chatId: "chat-1",
    };
    expect(adoptThread(prev, "chat-2")).toBe(prev);
  });

  it("INVARIANT: adoption never remounts (key unchanged) while chatId changes", () => {
    const prev = newThread("new-abc");
    const next = adoptThread(prev, "chat-1");
    // The mount key is preserved (no remount) ...
    expect(next.key).toBe(prev.key);
    // ... while the chat id moved from null to the real id.
    expect(prev.chatId).toBeNull();
    expect(next.chatId).toBe("chat-1");
  });

  it("INVARIANT: after adoption thread.chatId equals the adopted id, so the window's render-phase reconciler (activeChatId !== thread.chatId) does NOT fire and remount the live thread", () => {
    const adoptedId = "chat-1";
    const next = adoptThread(newThread("new-abc"), adoptedId);
    // The window sets activeChatId to the same adoptedId; this asserts they match
    // so the reconciler treats it as already-in-sync, not a switch.
    expect(next.chatId).toBe(adoptedId);
  });
});
