import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useChatSession } from "./use-chat-session";
import type { UseChatSessionOptions } from "./use-chat-session";

// The props the test drives: the parent-owned subset of UseChatSessionOptions
// (the spies are injected by setup, not per-render). messagesLoading is optional
// here (defaulted to false in setup) for terser test call sites.
type DriverProps = Pick<UseChatSessionOptions, "activeChatId" | "chats"> & {
  messagesLoading?: boolean;
};

// Drive the hook the way the window does: the parent owns `activeChatId` and
// passes it back in. `setActiveChatId` is a spy so we can assert the EXACT id the
// hook adopts (the #137 regression: it must be the authoritative streamed id, not
// the newest chat in the list).
function setup(initial: DriverProps) {
  const setActiveChatId = vi.fn();
  const onInvalidateChatList = vi.fn();
  const onInvalidateChatMessages = vi.fn();
  const { result, rerender } = renderHook(
    (props: DriverProps) =>
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
    rerender({
      activeChatId: null,
      chats: { items: [{ id: "x" }, { id: "new" }] },
    });
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
    rerender({
      activeChatId: null,
      chats: { items: [{ id: "b" }, { id: "new" }] },
    });
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

  it("startNewChat while already in a new chat: cancelPendingAdoption stops a late refetch adopting the failed chat", () => {
    // The Warning path the render-phase reconciler can't catch: pressing "New
    // chat" while already in a new chat keeps activeChatId === null (a no-op for
    // the atom), so only the explicit cancelPendingAdoption() disarms.
    const { result, rerender, setActiveChatId } = setup({
      activeChatId: null,
      chats: { items: [{ id: "x" }] },
    });
    result.current.onTurnFinished(undefined); // first turn failed → arm (before=["x"])
    result.current.cancelPendingAdoption(); // window calls this from startNewChat
    // The just-failed row lands in a late refetch; it must NOT be adopted.
    rerender({
      activeChatId: null,
      chats: { items: [{ id: "x" }, { id: "failed" }] },
    });
    expect(setActiveChatId).not.toHaveBeenCalledWith("failed");
  });

  it("onTurnFinished for an existing chat: no adoption, invalidates that chat's messages", () => {
    const {
      result,
      setActiveChatId,
      onInvalidateChatList,
      onInvalidateChatMessages,
    } = setup({ activeChatId: "chat-1", chats: { items: [{ id: "chat-1" }] } });
    result.current.onTurnFinished("chat-1");
    expect(setActiveChatId).not.toHaveBeenCalled(); // existing chat is never re-adopted
    expect(onInvalidateChatList).toHaveBeenCalled();
    expect(onInvalidateChatMessages).toHaveBeenCalledWith("chat-1");
  });

  it("double onTurnFinished on a failed-after-start turn: primary adopt, 2nd no-id call does NOT re-arm the fallback", () => {
    // ai@6 fires onFinish AND onError on a failed turn. If the failure happened
    // AFTER the `start` chunk, onFinish carries the streamed id and onError does
    // not — so onTurnFinished runs twice in one turn (id, then no-id) before any
    // re-render. The 2nd call must NOT re-arm the fallback off the still-null
    // closure; otherwise a late refetch (parent hasn't reflected the adoption yet)
    // would wrongly adopt a sibling row.
    const { result, rerender, setActiveChatId } = setup({
      activeChatId: null,
      chats: { items: [{ id: "x" }] },
    });
    result.current.onTurnFinished("A"); // onFinish: primary adoption
    expect(setActiveChatId).toHaveBeenCalledWith("A");
    result.current.onTurnFinished(undefined); // onError: same turn, no id
    // Even in the worst case (the parent has NOT yet reflected activeChatId="A"
    // and a late refetch lands a new row), the just-failed sibling must NOT be
    // adopted. Two layers guarantee this: the ref guard keeps the 2nd call from
    // re-arming at the source, and the render-phase reconciler disarms anything
    // stale once thread.chatId ("A") diverges from the still-null activeChatId.
    rerender({
      activeChatId: null,
      chats: { items: [{ id: "x" }, { id: "late" }] },
    });
    expect(setActiveChatId).not.toHaveBeenCalledWith("late");
  });

  it("#174 early adopt: onServerChatId adopts the streamed id mid-stream (Copy button available during the first turn)", () => {
    // Brand-new chat: no id yet. The server streams the real chat id "A" on the
    // `start` chunk WHILE the first turn is still streaming (before onTurnFinished
    // fires at the terminal outcome). The hook must adopt it immediately so the
    // window's activeChatId-gated Copy/export button lights up during the stream.
    const { result, setActiveChatId } = setup({
      activeChatId: null,
      chats: { items: [] },
    });
    result.current.onServerChatId("A");
    expect(setActiveChatId).toHaveBeenCalledWith("A");
  });

  it("#174 early adopt is in-place: threadKey stays stable (live stream not torn down)", () => {
    const chats = { items: [] };
    const { result, rerender } = setup({ activeChatId: null, chats });
    const keyBefore = result.current.threadKey;
    result.current.onServerChatId("A");
    // Parent reflects the adopted id back in; the SAME mount key is kept so the
    // in-flight useChat store (the streaming turn) is preserved.
    rerender({ activeChatId: "A", chats });
    expect(result.current.threadKey).toBe(keyBefore);
  });

  it("#174 early adopt: no-op for an existing chat and for a missing id", () => {
    const { result, setActiveChatId } = setup({
      activeChatId: "chat-1",
      chats: { items: [{ id: "chat-1" }] },
    });
    result.current.onServerChatId("chat-1"); // already has an id
    result.current.onServerChatId(undefined); // no streamed id
    expect(setActiveChatId).not.toHaveBeenCalled();
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
