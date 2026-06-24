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
    expect(md).toContain("**Tool: Ran tool mysteryTool** (`mysteryTool`) — error");
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
          metadata: { usage: { inputTokens: 3, outputTokens: 4, totalTokens: 99 } },
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

describe("buildChatMarkdown — pending / in-progress messages", () => {
  it("continues the heading numbering after the persisted rows", () => {
    const md = buildChatMarkdown({
      title: "t",
      chatId: "c",
      rows: [row({ role: "user", content: "persisted" })],
      pending: [
        {
          role: "user",
          parts: [{ type: "text", text: "live question" }],
          generating: false,
        },
        {
          role: "assistant",
          parts: [{ type: "text", text: "live answer" }],
          generating: true,
        },
      ],
      t,
    });
    expect(md).toContain("## 1. You");
    expect(md).toContain("## 2. You");
    expect(md).toContain("## 3. AI agent");
    expect(md).toContain("live question");
    expect(md).toContain("live answer");
  });

  it("flags a generating assistant pending message as still being generated", () => {
    const md = buildChatMarkdown({
      title: "t",
      chatId: "c",
      rows: [row({ role: "user", content: "persisted" })],
      pending: [
        {
          role: "assistant",
          parts: [{ type: "text", text: "partial reply" }],
          generating: true,
        },
      ],
      t,
    });
    expect(md).toContain("partial reply");
    expect(md).toContain("still being generated");
  });

  it("renders a non-generating user pending message without the note", () => {
    const md = buildChatMarkdown({
      title: "t",
      chatId: "c",
      rows: [row({ role: "user", content: "persisted" })],
      pending: [
        {
          role: "user",
          parts: [{ type: "text", text: "my live message" }],
          generating: false,
        },
      ],
      t,
    });
    expect(md).toContain("my live message");
    expect(md).not.toContain("still being generated");
  });

  it("includes the pending messages in the metadata message count", () => {
    const md = buildChatMarkdown({
      title: "t",
      chatId: "c",
      rows: [
        row({ role: "user", content: "a" }),
        row({ role: "assistant", content: "b" }),
      ],
      pending: [
        {
          role: "user",
          parts: [{ type: "text", text: "c" }],
          generating: false,
        },
        {
          role: "assistant",
          parts: [{ type: "text", text: "d" }],
          generating: true,
        },
      ],
      t,
    });
    // 2 persisted rows + 2 pending = 4.
    expect(md).toContain("- Messages: 4");
  });

  it("emits the heading and note for a generating assistant with empty parts", () => {
    expect(() =>
      buildChatMarkdown({
        title: "t",
        chatId: "c",
        rows: [row({ role: "user", content: "persisted" })],
        pending: [
          {
            role: "assistant",
            parts: [],
            generating: true,
          },
        ],
        t,
      }),
    ).not.toThrow();
    const md = buildChatMarkdown({
      title: "t",
      chatId: "c",
      rows: [row({ role: "user", content: "persisted" })],
      pending: [
        {
          role: "assistant",
          parts: [],
          generating: true,
        },
      ],
      t,
    });
    expect(md).toContain("## 2. AI agent");
    expect(md).toContain("still being generated");
  });
});
