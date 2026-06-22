import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useChatSession } from "./use-chat-session";

// Drive the hook the way the window does: the parent owns `activeChatId` and
// passes it back in. `setActiveChatId` is a spy so we can assert the EXACT id the
// hook adopts (the #137 regression: it must be the authoritative streamed id, not
// the newest chat in the list).
function setup(initial: {
  activeChatId: string | null;
  chats: { items?: { id: string }[] } | undefined;
  messagesLoading?: boolean;
}) {
  const setActiveChatId = vi.fn();
  const onInvalidateChatList = vi.fn();
  const onInvalidateChatMessages = vi.fn();
  const { result, rerender } = renderHook(
    (props: {
      activeChatId: string | null;
      chats: { items?: { id: string }[] } | undefined;
      messagesLoading?: boolean;
    }) =>
      useChatSession({
        activeChatId: props.activeChatId,
        setActiveChatId,
        chats: props.chats,
        messagesLoading: props.messagesLoading ?? false,
        onInvalidateChatList,
        onInvalidateChatMessages,
      }),
    { initialProps: initial },
  );
  return {
    result,
    rerender,
    setActiveChatId,
    onInvalidateChatList,
    onInvalidateChatMessages,
  };
}

describe("useChatSession", () => {
  beforeEach(() => vi.clearAllMocks());

  it("#137 REGRESSION LOCK: adopts the authoritative streamed id, NOT items[0]", () => {
    // Brand-new chat, list already holds a SIBLING chat B as items[0] (a second
    // tab just created it). The server streams the real id "A" for THIS chat.
    const { result, setActiveChatId } = setup({
      activeChatId: null,
      chats: { items: [{ id: "B" }] },
    });
    result.current.onTurnFinished("A");
    // Must adopt the authoritative id, not the newest-in-list guess.
    expect(setActiveChatId).toHaveBeenCalledWith("A");
    expect(setActiveChatId).not.toHaveBeenCalledWith("B");
  });

  it("fallback adopt: arms on a server-id-less finish, adopts the single new id after refetch", () => {
    const { result, rerender, setActiveChatId } = setup({
      activeChatId: null,
      chats: { items: [{ id: "x" }] },
    });
    // No server id => arm the fallback (no adoption yet).
    result.current.onTurnFinished(undefined);
    expect(setActiveChatId).not.toHaveBeenCalled();
    // The refetch lands with the new row => adopt it.
    rerender({ activeChatId: null, chats: { items: [{ id: "x" }, { id: "new" }] } });
    expect(setActiveChatId).toHaveBeenCalledWith("new");
  });

  it("fallback ambiguous: two new ids appear => no adoption", () => {
    const { result, rerender, setActiveChatId } = setup({
      activeChatId: null,
      chats: { items: [{ id: "x" }] },
    });
    result.current.onTurnFinished(undefined);
    rerender({
      activeChatId: null,
      chats: { items: [{ id: "x" }, { id: "n1" }, { id: "n2" }] },
    });
    expect(setActiveChatId).not.toHaveBeenCalled();
  });

  it("fallback add+delete in one window: adopts the new id (membership compare)", () => {
    const { result, rerender, setActiveChatId } = setup({
      activeChatId: null,
      chats: { items: [{ id: "a" }, { id: "b" }] },
    });
    result.current.onTurnFinished(undefined);
    // a was deleted, new was added — same length, but membership changed.
    rerender({ activeChatId: null, chats: { items: [{ id: "b" }, { id: "new" }] } });
    expect(setActiveChatId).toHaveBeenCalledWith("new");
  });

  it("disarm on reconcile: a fallback armed then switched away is NOT adopted by a late refetch", () => {
    // Arm the error-path fallback on a brand-new chat (snapshot before=["x"]).
    const { result, rerender, setActiveChatId } = setup({
      activeChatId: null,
      chats: { items: [{ id: "x" }] },
    });
    result.current.onTurnFinished(undefined);
    // The user switches to an existing chat C BEFORE the refetch lands; the
    // render-phase reconciler must DISARM the pending fallback.
    rerender({ activeChatId: "C", chats: { items: [{ id: "x" }] } });
    // ...then starts a fresh new chat again (back to null), without re-arming.
    rerender({ activeChatId: null, chats: { items: [{ id: "x" }] } });
    // A late refetch now brings a new row. Because the earlier fallback was
    // disarmed on the switch (not left armed with the stale ["x"] snapshot), it
    // must NOT be adopted. (Without the disarm this would wrongly adopt "new".)
    rerender({
      activeChatId: null,
      chats: { items: [{ id: "x" }, { id: "new" }] },
    });
    expect(setActiveChatId).not.toHaveBeenCalledWith("new");
  });

  it("in-place adopt keeps threadKey stable; an external switch remounts", () => {
    const chats = { items: [{ id: "B" }] };
    const { result, rerender } = setup({ activeChatId: null, chats });
    const keyBefore = result.current.threadKey;
    // Adopt the streamed id; the PARENT then reflects activeChatId="A" back in.
    result.current.onTurnFinished("A");
    rerender({ activeChatId: "A", chats });
    // In-place adoption: SAME mount key (the live useChat store is preserved).
    expect(result.current.threadKey).toBe(keyBefore);

    // An EXTERNAL switch (not via adopt) to a different chat must remount: the
    // key becomes the chat id.
    rerender({ activeChatId: "C", chats });
    expect(result.current.threadKey).toBe("C");
  });

  it("waitingForHistory gates the loader only while opening an unloaded existing chat", () => {
    // Open an existing chat whose history is still loading => loader on.
    const { result, rerender } = setup({
      activeChatId: "chat-1",
      chats: { items: [{ id: "chat-1" }] },
      messagesLoading: true,
    });
    expect(result.current.waitingForHistory).toBe(true);
    // Once loading finishes, the latch flips and the loader is off.
    rerender({
      activeChatId: "chat-1",
      chats: { items: [{ id: "chat-1" }] },
      messagesLoading: false,
    });
    expect(result.current.waitingForHistory).toBe(false);
  });
});
