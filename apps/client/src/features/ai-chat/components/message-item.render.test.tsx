import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import type { UIMessage } from "@ai-sdk/react";

// Stub react-i18next (the component reads `useTranslation`). Mirrors the other
// message-item specs.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import MessageItem from "./message-item";
import { messageSignature } from "@/features/ai-chat/utils/message-signature.ts";
// The REAL canonical renderer (NOT the spy the memo test installs): this file
// exercises the actual markdown output so the visual-regression assertions below
// compare against genuine HTML (incl. the schema's `<li><p>` wrappers).
import { renderChatMarkdown } from "@/features/ai-chat/utils/markdown.ts";
import classes from "./ai-chat.module.css";

const msg = (
  parts: UIMessage["parts"],
  extra?: Partial<UIMessage>,
): UIMessage =>
  ({ id: "m1", role: "assistant", parts, ...extra }) as UIMessage;

const renderRow = (message: UIMessage, turnStreaming = false) =>
  render(
    <MantineProvider>
      <MessageItem
        message={message}
        signature={messageSignature(message)}
        turnStreaming={turnStreaming}
      />
    </MantineProvider>,
  );

// A rich multi-block answer that exercises headings, a list (the `<li><p>` case
// the scoped CSS tightens), inline emphasis, and multiple paragraphs.
const ANSWER = [
  "# Заголовок",
  "",
  "Первый абзац с **жирным** и `кодом`.",
  "",
  "- пункт один",
  "- пункт два",
  "",
  "Второй абзац.",
].join("\n");

describe("MessageItem final render — visual parity with the canonical pipeline", () => {
  it("a finalized text part renders exactly renderChatMarkdown(text)", () => {
    const { container } = renderRow(
      msg([{ type: "text", text: ANSWER, state: "done" }]),
    );
    const block = container.querySelector(`.${classes.markdown}`);
    expect(block).not.toBeNull();
    // Byte-for-byte the canonical output (the SAME whole-text pass the pre-#492
    // MarkdownPart produced), including `<li><p>…</p></li>` wrappers.
    expect(block!.innerHTML).toBe(renderChatMarkdown(ANSWER, {}));
    // The list wrapper is really present (guards against a vacuous empty render).
    expect(container.querySelectorAll("li p").length).toBe(2);
  });

  it("the streaming incremental view CONVERGES to the canonical render on finish", () => {
    // Mount mid-stream (live tail) — the DOM here is the incremental view.
    const { container, rerender } = render(
      <MantineProvider>
        <MessageItem
          message={msg([{ type: "text", text: ANSWER, state: "streaming" }])}
          signature={messageSignature(
            msg([{ type: "text", text: ANSWER, state: "streaming" }]),
          )}
          turnStreaming
        />
      </MantineProvider>,
    );
    // Finish the turn: state flips to done AND the turn is no longer streaming.
    const done = msg([{ type: "text", text: ANSWER, state: "done" }]);
    rerender(
      <MantineProvider>
        <MessageItem message={done} signature={messageSignature(done)} />
      </MantineProvider>,
    );
    // After finish there is exactly ONE canonical markdown container whose HTML is
    // the whole-text render — identical to the non-streaming path above.
    const blocks = container.querySelectorAll(`.${classes.markdown}`);
    expect(blocks.length).toBe(1);
    expect(blocks[0].innerHTML).toBe(renderChatMarkdown(ANSWER, {}));
  });

  it("neutralizeInternalLinks is honored on the finalized render", () => {
    const linkAnswer = "См. [страницу](/p/abc).";
    const { container } = render(
      <MantineProvider>
        <MessageItem
          message={msg([{ type: "text", text: linkAnswer, state: "done" }])}
          signature={messageSignature(
            msg([{ type: "text", text: linkAnswer, state: "done" }]),
          )}
          neutralizeInternalLinks
        />
      </MantineProvider>,
    );
    const block = container.querySelector(`.${classes.markdown}`);
    expect(block!.innerHTML).toBe(
      renderChatMarkdown(linkAnswer, { neutralizeInternalLinks: true }),
    );
    // The internal link was made inert (no href) by the neutralization flag.
    const a = container.querySelector("a");
    expect(a?.hasAttribute("href")).toBe(false);
  });
});
