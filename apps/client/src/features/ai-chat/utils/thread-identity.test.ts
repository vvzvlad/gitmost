import { describe, it, expect } from "vitest";
import {
  newThread,
  switchThread,
  adoptThread,
  threadSessionReducer,
} from "./thread-identity";

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
  // Key UNCHANGED (no remount) + chatId moved null->realId. The unchanged key is
  // what keeps the live useChat store alive; the matching chatId is what makes the
  // window's render-phase reconciler (activeChatId !== thread.chatId) treat the
  // adopted thread as already-in-sync rather than a switch.
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
});

describe("threadSessionReducer", () => {
  it("reconcile to an existing id switches (key becomes the id)", () => {
    const next = threadSessionReducer(newThread("new-abc"), {
      type: "reconcile",
      chatId: "chat-1",
      newKey: "new-xyz",
    });
    expect(next).toEqual({ key: "chat-1", chatId: "chat-1" });
  });

  it("reconcile to null starts a fresh new thread with the supplied key", () => {
    const next = threadSessionReducer(switchThread("chat-1"), {
      type: "reconcile",
      chatId: null,
      newKey: "new-xyz",
    });
    expect(next).toEqual({ key: "new-xyz", chatId: null });
  });

  it("adopt on a new thread keeps the key and sets the id", () => {
    const next = threadSessionReducer(newThread("new-abc"), {
      type: "adopt",
      chatId: "chat-1",
    });
    expect(next).toEqual({ key: "new-abc", chatId: "chat-1" });
  });

  it("adopt on a persisted thread is a no-op", () => {
    const prev = switchThread("chat-1");
    expect(threadSessionReducer(prev, { type: "adopt", chatId: "chat-2" })).toBe(
      prev,
    );
  });
});
