import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";

// Shared, hoisted mock state so the @ai-sdk/react and "ai" module mocks (hoisted
// above the imports) can expose the captured useChat callbacks / transport and
// the spies back to the test body.
const h = vi.hoisted(() => ({
  state: {
    status: "streaming" as string,
    onFinish: null as null | ((arg: Record<string, unknown>) => void),
    sendMessage: vi.fn(),
    stop: vi.fn(),
    transport: null as null | {
      prepareSendMessagesRequest: (arg: {
        messages: unknown[];
        body: Record<string, unknown>;
      }) => { body: Record<string, unknown> };
    },
  },
}));

// Mock useChat: capture onFinish, return the spies and the controllable status.
vi.mock("@ai-sdk/react", () => ({
  useChat: (opts: { onFinish?: (arg: Record<string, unknown>) => void }) => {
    h.state.onFinish = opts.onFinish ?? null;
    return {
      messages: [],
      sendMessage: h.state.sendMessage,
      status: h.state.status,
      stop: h.state.stop,
      error: null,
    };
  },
}));

// Mock "ai": deterministic ids + a transport that records its options so the test
// can invoke prepareSendMessagesRequest and assert the `interrupted` flag.
vi.mock("ai", () => {
  let counter = 0;
  return {
    generateId: () => `gid-${counter++}`,
    DefaultChatTransport: class {
      constructor(opts: {
        prepareSendMessagesRequest: (arg: {
          messages: unknown[];
          body: Record<string, unknown>;
        }) => { body: Record<string, unknown> };
      }) {
        h.state.transport = opts;
      }
    },
  };
});

// Stub the heavy children: MessageList (markdown/render) and ChatInput (the
// composer). The ChatInput stub exposes a button that queues a message, the only
// interaction this test needs to populate the queue while "streaming".
vi.mock("@/features/ai-chat/components/message-list.tsx", () => ({
  default: () => <div data-testid="message-list" />,
}));
vi.mock("@/features/ai-chat/components/chat-input.tsx", () => ({
  default: ({ onQueue }: { onQueue: (text: string) => void }) => (
    <button data-testid="queue-btn" onClick={() => onQueue("queued text")}>
      queue
    </button>
  ),
}));

import ChatThread from "./chat-thread";

function renderThread() {
  const onTurnFinished = vi.fn();
  render(
    <MantineProvider>
      <ChatThread chatId="c1" initialRows={[]} onTurnFinished={onTurnFinished} />
    </MantineProvider>,
  );
  return { onTurnFinished };
}

describe("ChatThread — send now (#198)", () => {
  beforeEach(() => {
    h.state.status = "streaming";
    h.state.onFinish = null;
    h.state.sendMessage.mockClear();
    h.state.stop.mockClear();
    h.state.transport = null;
  });

  it("aborts the current turn and resends the queued message on the abort", () => {
    renderThread();

    // Queue a message while the turn is streaming.
    fireEvent.click(screen.getByTestId("queue-btn"));
    const sendNowBtn = screen.getByLabelText("Send now");
    expect(sendNowBtn).toBeTruthy();

    // "Send now" interrupts the current turn (stop), but does NOT send yet —
    // the resend happens once the abort lands in onFinish.
    fireEvent.click(sendNowBtn);
    expect(h.state.stop).toHaveBeenCalledTimes(1);
    expect(h.state.sendMessage).not.toHaveBeenCalled();

    // The abort we triggered reaches onFinish: the promoted head is flushed.
    act(() => {
      h.state.onFinish?.({
        message: { id: "a", role: "assistant", parts: [] },
        isAbort: true,
        isDisconnect: false,
        isError: false,
      });
    });
    expect(h.state.sendMessage).toHaveBeenCalledWith({ text: "queued text" });
  });

  it("tags exactly the next send as interrupted (one-shot flag)", () => {
    renderThread();
    fireEvent.click(screen.getByTestId("queue-btn"));
    fireEvent.click(screen.getByLabelText("Send now"));

    const prep = h.state.transport!.prepareSendMessagesRequest;
    // The send right after "send now" carries interrupted: true...
    expect(prep({ messages: [], body: {} }).body.interrupted).toBe(true);
    // ...and only that one (the flag is read-and-cleared).
    expect(prep({ messages: [], body: {} }).body.interrupted).toBe(false);
  });

  it("sends immediately without an interrupt when not streaming", () => {
    h.state.status = "ready";
    renderThread();

    fireEvent.click(screen.getByTestId("queue-btn"));
    fireEvent.click(screen.getByLabelText("Send now"));

    // No turn to interrupt: sent straight away, no abort, not flagged.
    expect(h.state.stop).not.toHaveBeenCalled();
    expect(h.state.sendMessage).toHaveBeenCalledWith({ text: "queued text" });
    const prep = h.state.transport!.prepareSendMessagesRequest;
    expect(prep({ messages: [], body: {} }).body.interrupted).toBe(false);
  });
});
