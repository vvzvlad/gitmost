import { describe, it, expect } from "vitest";
import { buildChatMarkdown } from "@/features/ai-chat/utils/chat-markdown.ts";
import type { IAiChatMessageRow } from "@/features/ai-chat/types/ai-chat.types.ts";

/**
 * Tests for the client-only Markdown export builder. The output embeds a live
 * `new Date().toISOString()` export timestamp; we never assert that value, only
 * the deterministic structure (headings, numbering, fenced blocks, totals).
 *
 * A pass-through translator keeps role/tool labels predictable so the
 * structural assertions are stable without an i18n runtime.
 */
const t = (key: string, values?: Record<string, unknown>): string => {
  if (values && typeof values.name === "string") {
    return key.replace("{{name}}", values.name);
  }
  return key;
};

function row(partial: Partial<IAiChatMessageRow>): IAiChatMessageRow {
  return {
    id: partial.id ?? "id",
    role: partial.role ?? "user",
    content: partial.content ?? null,
    metadata: partial.metadata ?? null,
    createdAt: partial.createdAt ?? "2026-06-21T00:00:00.000Z",
  };
}

describe("buildChatMarkdown — structure", () => {
  it("emits the title heading, chat id and message count", () => {
    const md = buildChatMarkdown({
      title: "My chat",
      chatId: "chat-123",
      rows: [],
      t,
    });
    expect(md).toContain("# My chat");
    expect(md).toContain("- Chat ID: `chat-123`");
    expect(md).toContain("- Messages: 0");
    expect(md).toContain("- Exported:"); // timestamp present, value not asserted
  });

  it("falls back to the translated 'Untitled chat' for empty/blank titles", () => {
    expect(
      buildChatMarkdown({ title: null, chatId: "c", rows: [], t }),
    ).toContain("# Untitled chat");
    expect(
      buildChatMarkdown({ title: "   ", chatId: "c", rows: [], t }),
    ).toContain("# Untitled chat");
  });

  it("numbers rows sequentially with role headings", () => {
    const md = buildChatMarkdown({
      title: "t",
      chatId: "c",
      rows: [
        row({ role: "user", content: "hi" }),
        row({ role: "assistant", content: "hello" }),
        row({ role: "user", content: "again" }),
      ],
      t,
    });
    expect(md).toContain("## 1. You");
    expect(md).toContain("## 2. AI agent");
    expect(md).toContain("## 3. You");
    // Heading numbering is strictly index+1, not e.g. role-relative.
    expect(md).not.toContain("## 0.");
  });

  it("renders the per-row text content from `content` when no metadata.parts", () => {
    const md = buildChatMarkdown({
      title: "t",
      chatId: "c",
      rows: [row({ role: "user", content: "plain body" })],
      t,
    });
    expect(md).toContain("plain body");
  });
});

describe("buildChatMarkdown — text parts", () => {
  it("skips empty / whitespace-only text parts", () => {
    const md = buildChatMarkdown({
      title: "t",
      chatId: "c",
      rows: [
        row({
          role: "assistant",
          content: "ignored-content",
          metadata: {
            parts: [
              { type: "text", text: "   " },
              { type: "text", text: "" },
              { type: "text", text: "kept line" },
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ] as any,
          },
        }),
      ],
      t,
    });
    expect(md).toContain("kept line");
    // Whitespace-only part contributed no block of its own.
    expect(md).not.toContain("   \n\n");
    // When metadata.parts exists, the plain `content` fallback is NOT used.
    expect(md).not.toContain("ignored-content");
  });
});

describe("buildChatMarkdown — tool parts", () => {
  it("renders a tool label, name, state and fenced Input/Output blocks", () => {
    const md = buildChatMarkdown({
      title: "t",
      chatId: "c",
      rows: [
        row({
          role: "assistant",
          content: "",
          metadata: {
            parts: [
              {
                type: "tool-getPage",
                state: "output-available",
                input: { pageId: "p1" },
                output: { id: "p1", title: "Home" },
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
              } as any,
            ],
          },
        }),
      ],
      t,
    });
    // Known tool name maps to its label key; raw name in backticks; done state.
    expect(md).toContain("**Tool: Read page** (`getPage`) — done");
    expect(md).toContain("Input:");
    expect(md).toContain("Output:");
    // Fenced JSON blocks contain the stringified payloads.
    expect(md).toContain('"pageId": "p1"');
    expect(md).toContain('"title": "Home"');
    expect(md).toContain("```json");
  });

  it("renders the generic label for an unknown tool and surfaces errorText", () => {
    const md = buildChatMarkdown({
      title: "t",
      chatId: "c",
      rows: [
        row({
          role: "assistant",
          content: "",
          metadata: {
            parts: [
              {
                type: "tool-mysteryTool",
                state: "output-error",
                input: { a: 1 },
                errorText: "boom",
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
              } as any,
            ],
          },
        }),
      ],
      t,
    });
    expect(md).toContain(
      "**Tool: Ran tool mysteryTool** (`mysteryTool`) — error",
    );
    expect(md).toContain("**Error:** boom");
  });

  it("does not throw on a circular tool input (falls back to String)", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const circular: any = {};
    circular.self = circular;
    expect(() =>
      buildChatMarkdown({
        title: "t",
        chatId: "c",
        rows: [
          row({
            role: "assistant",
            content: "",
            metadata: {
              parts: [
                {
                  type: "tool-getPage",
                  state: "input-available",
                  input: circular,
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                } as any,
              ],
            },
          }),
        ],
        t,
      }),
    ).not.toThrow();
  });
});

describe("buildChatMarkdown — fence anti-breakout", () => {
  it("lengthens the delimiter so embedded ``` cannot break out of the block", () => {
    // Tool input whose stringified string form contains a literal ``` run.
    const md = buildChatMarkdown({
      title: "t",
      chatId: "c",
      rows: [
        row({
          role: "assistant",
          content: "",
          metadata: {
            parts: [
              {
                type: "tool-getPage",
                state: "output-available",
                // A bare string passes through stringify() verbatim.
                input: "before ``` after",
                output: "x",
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
              } as any,
            ],
          },
        }),
      ],
      t,
    });
    // The fence around the 3-backtick content must use at least 4 backticks so
    // the embedded ``` run cannot terminate the block.
    expect(md).toContain("````json\nbefore ``` after\n````");
    // Robust anti-breakout check: the opening fence delimiter is strictly
    // longer than the longest backtick run inside the wrapped content. (A naive
    // `not.toContain("```json...")` is a false negative — a 4-backtick fence
    // textually contains the 3-backtick substring.)
    const open = md.match(/(`{3,})json\nbefore/);
    expect(open).not.toBeNull();
    expect(open![1].length).toBeGreaterThan(3); // > the 3-backtick run in content
  });

  it("uses a 5-backtick fence when the content has a 4-backtick run", () => {
    const md = buildChatMarkdown({
      title: "t",
      chatId: "c",
      rows: [
        row({
          role: "assistant",
          content: "",
          metadata: {
            parts: [
              {
                type: "tool-getPage",
                state: "output-available",
                input: "a ```` b",
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
              } as any,
            ],
          },
        }),
      ],
      t,
    });
    expect(md).toContain("`````json\na ```` b\n`````");
  });
});

describe("buildChatMarkdown — token totals", () => {
  it("prints the total-tokens line only when the summed usage is > 0", () => {
    const withTokens = buildChatMarkdown({
      title: "t",
      chatId: "c",
      rows: [
        row({
          role: "assistant",
          content: "x",
          metadata: { usage: { inputTokens: 10, outputTokens: 5 } },
        }),
      ],
      t,
    });
    expect(withTokens).toContain("- Total tokens: 15");
    // Per-row usage footer too.
    expect(withTokens).toContain("_Tokens — in: 10, out: 5, total: 15_");
  });

  it("omits the total-tokens line when the sum is 0 / usage absent", () => {
    const noTokens = buildChatMarkdown({
      title: "t",
      chatId: "c",
      rows: [
        row({ role: "user", content: "hi" }),
        row({
          role: "assistant",
          content: "x",
          metadata: { usage: { inputTokens: 0, outputTokens: 0 } },
        }),
      ],
      t,
    });
    expect(noTokens).not.toContain("- Total tokens:");
  });

  it("uses totalTokens when present rather than summing in/out", () => {
    const md = buildChatMarkdown({
      title: "t",
      chatId: "c",
      rows: [
        row({
          role: "assistant",
          content: "x",
          metadata: {
            usage: { inputTokens: 3, outputTokens: 4, totalTokens: 99 },
          },
        }),
      ],
      t,
    });
    expect(md).toContain("- Total tokens: 99");
  });

  it("appends the reasoning figure to the row footer when reasoningTokens > 0", () => {
    const md = buildChatMarkdown({
      title: "t",
      chatId: "c",
      rows: [
        row({
          role: "assistant",
          content: "x",
          metadata: {
            usage: { inputTokens: 10, outputTokens: 8, reasoningTokens: 3 },
          },
        }),
      ],
      t,
    });
    expect(md).toContain("_Tokens — in: 10, out: 8, reasoning: 3, total: 18_");
  });

  it("omits the reasoning figure when reasoningTokens is 0 / absent", () => {
    const zero = buildChatMarkdown({
      title: "t",
      chatId: "c",
      rows: [
        row({
          role: "assistant",
          content: "x",
          metadata: {
            usage: { inputTokens: 10, outputTokens: 5, reasoningTokens: 0 },
          },
        }),
      ],
      t,
    });
    expect(zero).toContain("_Tokens — in: 10, out: 5, total: 15_");
    expect(zero).not.toContain("reasoning:");

    const absent = buildChatMarkdown({
      title: "t",
      chatId: "c",
      rows: [
        row({
          role: "assistant",
          content: "x",
          metadata: { usage: { inputTokens: 10, outputTokens: 5 } },
        }),
      ],
      t,
    });
    expect(absent).not.toContain("reasoning:");
  });
});

// A minimal on-screen (live) message, matching the subset buildChatMarkdown reads.
function live(partial: {
  id?: string;
  role?: string;
  parts?: { type: string; text?: string }[];
  metadata?: { usage?: Record<string, number>; error?: string };
}) {
  return {
    id: partial.id ?? "live-id",
    role: partial.role ?? "assistant",
    parts: partial.parts ?? [],
    metadata: partial.metadata,
  };
}

describe("buildChatMarkdown — live (WYSIWYG) source", () => {
  it("uses the live messages as the document (what's on screen), numbered from 1", () => {
    const md = buildChatMarkdown({
      title: "t",
      chatId: "c",
      // Persisted rows hold only the user turn; the assistant reply is live-only.
      rows: [row({ id: "u1", role: "user", content: "persisted user" })],
      live: [
        live({
          id: "u1",
          role: "user",
          parts: [{ type: "text", text: "on-screen user" }],
        }),
        live({
          id: "a1",
          role: "assistant",
          parts: [{ type: "text", text: "on-screen reply" }],
        }),
      ],
      isStreaming: false,
      t,
    });
    expect(md).toContain("## 1. You");
    expect(md).toContain("## 2. AI agent");
    expect(md).toContain("on-screen user");
    expect(md).toContain("on-screen reply");
    // Message count reflects the LIVE document, not rows + live.
    expect(md).toContain("- Messages: 2");
  });

  it("captures a partial reply from an interrupted (non-streaming) turn — no 'generating' note", () => {
    const md = buildChatMarkdown({
      title: "t",
      chatId: "c",
      rows: [row({ id: "u1", role: "user", content: "q" })],
      live: [
        live({ id: "u1", role: "user", parts: [{ type: "text", text: "q" }] }),
        live({
          id: "a-live",
          role: "assistant",
          parts: [{ type: "text", text: "partial plan before the drop" }],
        }),
      ],
      isStreaming: false, // the stream dropped — not streaming anymore
      banner: "Connection lost — the answer was interrupted.",
      t,
    });
    // The partial assistant answer that was on screen IS in the export.
    expect(md).toContain("partial plan before the drop");
    // It is NOT flagged still-generating (the turn is over, just interrupted).
    expect(md).not.toContain("still being generated");
    // The on-screen banner is recorded at the end.
    expect(md).toContain("Connection lost — the answer was interrupted.");
  });

  it("flags ONLY the tail assistant as still generating, and only while streaming", () => {
    const streaming = buildChatMarkdown({
      title: "t",
      chatId: "c",
      rows: [],
      live: [
        live({
          id: "a",
          role: "assistant",
          parts: [{ type: "text", text: "done earlier" }],
        }),
        live({
          id: "u",
          role: "user",
          parts: [{ type: "text", text: "next q" }],
        }),
        live({
          id: "b",
          role: "assistant",
          parts: [{ type: "text", text: "streaming now" }],
        }),
      ],
      isStreaming: true,
      t,
    });
    // Exactly one "still being generated" note (the tail assistant).
    expect(streaming.match(/still being generated/g)?.length).toBe(1);

    const idle = buildChatMarkdown({
      title: "t",
      chatId: "c",
      rows: [],
      live: [
        live({
          id: "b",
          role: "assistant",
          parts: [{ type: "text", text: "final" }],
        }),
      ],
      isStreaming: false,
      t,
    });
    expect(idle).not.toContain("still being generated");
  });

  it("does NOT flag a completed assistant as generating when the streaming tail is a user message", () => {
    // The `status === "submitted"` window: the user just sent, isStreaming is
    // already true, but the new assistant turn has no message yet so the tail is
    // the USER message. The previous assistant answer is complete on screen and
    // must not be marked still-generating (WYSIWYG; regression for #160 review).
    const md = buildChatMarkdown({
      title: "t",
      chatId: "c",
      rows: [],
      live: [
        live({
          id: "a",
          role: "assistant",
          parts: [{ type: "text", text: "completed answer" }],
        }),
        live({
          id: "u",
          role: "user",
          parts: [{ type: "text", text: "the new question" }],
        }),
      ],
      isStreaming: true,
      t,
    });
    expect(md).toContain("completed answer");
    expect(md).not.toContain("still being generated");
  });

  it("emits the heading + note for a streaming tail assistant with empty parts", () => {
    const md = buildChatMarkdown({
      title: "t",
      chatId: "c",
      rows: [row({ id: "u1", role: "user", content: "q" })],
      live: [
        live({ id: "u1", role: "user", parts: [{ type: "text", text: "q" }] }),
        live({ id: "a-live", role: "assistant", parts: [] }),
      ],
      isStreaming: true,
      t,
    });
    expect(md).toContain("## 2. AI agent");
    expect(md).toContain("still being generated");
  });
});

describe("buildChatMarkdown — live enrichment from persisted rows", () => {
  it("pulls usage / error / timestamp from the persisted row matched by id", () => {
    const md = buildChatMarkdown({
      title: "t",
      chatId: "c",
      rows: [
        row({
          id: "a1",
          role: "assistant",
          content: "x",
          createdAt: "2026-06-22T10:00:00.000Z",
          metadata: {
            usage: { inputTokens: 10, outputTokens: 5 },
            error: "rate limited",
          },
        }),
      ],
      live: [
        // Same id as the persisted row, but no usage/error/timestamp on the live msg.
        live({
          id: "a1",
          role: "assistant",
          parts: [{ type: "text", text: "reply" }],
        }),
      ],
      isStreaming: false,
      t,
    });
    expect(md).toContain("reply");
    // Token footer + total come from the enriched row.
    expect(md).toContain("_Tokens — in: 10, out: 5, total: 15_");
    expect(md).toContain("- Total tokens: 15");
    expect(md).toContain("**⚠️ Error:** rate limited");
    // The persisted timestamp is carried into the export.
    expect(md).toContain("<!-- 2026-06-22T10:00:00.000Z -->");
  });

  it("prefers authoritative usage already on the live message over the row's", () => {
    const md = buildChatMarkdown({
      title: "t",
      chatId: "c",
      rows: [
        row({
          id: "a1",
          role: "assistant",
          content: "x",
          metadata: {
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          },
        }),
      ],
      live: [
        live({
          id: "a1",
          role: "assistant",
          parts: [{ type: "text", text: "reply" }],
          metadata: {
            usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
          },
        }),
      ],
      isStreaming: false,
      t,
    });
    // The live (authoritative, freshest) usage wins, not the stale row usage.
    expect(md).toContain("- Total tokens: 150");
    expect(md).not.toContain("- Total tokens: 2");
  });

  it("a current-turn live message with no matching row renders without a footer", () => {
    const md = buildChatMarkdown({
      title: "t",
      chatId: "c",
      rows: [row({ id: "u1", role: "user", content: "q" })],
      live: [
        live({ id: "u1", role: "user", parts: [{ type: "text", text: "q" }] }),
        live({
          id: "a-live",
          role: "assistant",
          parts: [{ type: "text", text: "fresh reply" }],
        }),
      ],
      isStreaming: false,
      t,
    });
    expect(md).toContain("fresh reply");
    // No persisted row for the live assistant -> no token footer, no timestamp.
    expect(md).not.toContain("_Tokens —");
    expect(md).not.toContain("<!-- undefined -->");
  });
});

describe("buildChatMarkdown — fallback + banner", () => {
  it("falls back to the persisted rows when there are no live messages", () => {
    const md = buildChatMarkdown({
      title: "t",
      chatId: "c",
      rows: [
        row({ role: "user", content: "from rows" }),
        row({
          role: "assistant",
          content: "answer",
          metadata: { usage: { inputTokens: 4, outputTokens: 6 } },
        }),
      ],
      live: [], // empty live mirror -> fallback path
      isStreaming: false,
      t,
    });
    expect(md).toContain("## 1. You");
    expect(md).toContain("## 2. AI agent");
    expect(md).toContain("from rows");
    expect(md).toContain("- Messages: 2");
    expect(md).toContain("- Total tokens: 10");
  });

  it("appends the on-screen banner once, after the messages", () => {
    const md = buildChatMarkdown({
      title: "t",
      chatId: "c",
      rows: [row({ role: "user", content: "q" })],
      live: [
        live({ id: "u", role: "user", parts: [{ type: "text", text: "q" }] }),
      ],
      isStreaming: false,
      banner: "Rate limit reached — try again shortly.",
      t,
    });
    expect(md).toContain("_⚠️ Rate limit reached — try again shortly._");
    // Banner comes after the (only) message block.
    expect(md.indexOf("Rate limit reached")).toBeGreaterThan(
      md.indexOf("## 1."),
    );
  });

  it("omits the banner block when there is no banner", () => {
    const md = buildChatMarkdown({
      title: "t",
      chatId: "c",
      rows: [row({ role: "user", content: "q" })],
      live: [
        live({ id: "u", role: "user", parts: [{ type: "text", text: "q" }] }),
      ],
      isStreaming: false,
      banner: null,
      t,
    });
    expect(md).not.toContain("_⚠️");
  });
});

// #174: a brand-new, not-yet-persisted chat whose first turn is streaming (or was
// interrupted) has live messages but NO persisted rows yet, and its chat id is not
// known (the caller passes a placeholder). The export must still capture the
// on-screen thread WYSIWYG from the live messages alone.
describe("buildChatMarkdown — first-turn export with no persisted base (#174)", () => {
  it("builds the document from live messages alone when rows are empty", () => {
    const md = buildChatMarkdown({
      title: null,
      chatId: "unsaved",
      rows: [],
      live: [
        live({
          id: "u1",
          role: "user",
          parts: [{ type: "text", text: "hello" }],
        }),
        live({
          id: "a1",
          role: "assistant",
          parts: [{ type: "text", text: "partial reply" }],
        }),
      ],
      isStreaming: true,
      t,
    });
    // Both on-screen messages are serialized, numbered from 1.
    expect(md).toContain("## 1. You");
    expect(md).toContain("hello");
    expect(md).toContain("## 2. AI agent");
    expect(md).toContain("partial reply");
    // The streaming tail assistant is flagged as in-progress.
    expect(md).toContain("still being generated");
    // The placeholder chat id and the live message count are recorded.
    expect(md).toContain("- Chat ID: `unsaved`");
    expect(md).toContain("- Messages: 2");
    // No persisted timestamp exists for a current-turn live message.
    expect(md).not.toContain("<!--");
  });

  it("captures an interrupted first turn (no rows, not streaming) without a generating note", () => {
    const md = buildChatMarkdown({
      title: null,
      chatId: "unsaved",
      rows: [],
      live: [
        live({ id: "u1", role: "user", parts: [{ type: "text", text: "q" }] }),
        live({
          id: "a1",
          role: "assistant",
          parts: [{ type: "text", text: "half an answer" }],
        }),
      ],
      isStreaming: false,
      banner: "Connection dropped — the response was cut off.",
      t,
    });
    expect(md).toContain("half an answer");
    // An interrupted (non-streaming) partial is exported as-is, no generating note.
    expect(md).not.toContain("still being generated");
    // The on-screen banner records the interruption.
    expect(md).toContain("_⚠️ Connection dropped — the response was cut off._");
  });
});
