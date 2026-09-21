import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";

/**
 * F1 regression: every floating anchor in the editor must start `autoUpdate`
 * with `{ layoutShift: false }`.
 *
 * `layoutShift: true` (the library default) starts `observeMove()`, which
 * rebuilds an IntersectionObserver in a loop until two consecutive
 * `intersectionRatio` values compare EXACTLY equal. Over a clipped table cell
 * in a fractional-width column that never converges in WebKit, so the loop
 * spins forever — a forced layout + `computePosition` + a React render per
 * iteration. The three table handles are the worst offenders because a single
 * click into a cell keeps them mounted for the rest of the session.
 *
 * The test drives the REAL components: it mocks `@floating-ui/react` only to
 * capture what `useFloating` is given, then invokes that `whileElementsMounted`
 * exactly the way floating-ui does and asserts the options reach `autoUpdate`.
 */

const autoUpdateMock = vi.fn(() => () => {});
type WhileElementsMounted = (
  reference: unknown,
  floating: unknown,
  update: () => void,
) => void;

// Mantine's own `<Menu>` also calls `useFloating` from this module, so the
// captures are keyed by placement — each handle uses a placement of its own.
const captured: Array<{
  placement?: string;
  whileElementsMounted: WhileElementsMounted;
}> = [];

vi.mock("@floating-ui/react", () => ({
  autoUpdate: (...args: unknown[]) => (autoUpdateMock as any)(...args),
  offset: () => ({ name: "offset" }),
  hide: () => ({ name: "hide" }),
  useFloating: (options: any) => {
    if (options?.whileElementsMounted) {
      captured.push({
        placement: options.placement,
        whileElementsMounted: options.whileElementsMounted,
      });
    }
    return {
      refs: { setReference: () => {}, setFloating: () => {} },
      floatingStyles: {},
      middlewareData: {},
    };
  },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

// CellChevron subscribes to the column-resizing plugin through this hook;
// there is no real ProseMirror state behind the stub editor.
vi.mock("@tiptap/react", () => ({
  useEditorState: () => false,
}));

import { ColumnHandle } from "./column-handle";
import { RowHandle } from "./row-handle";
import { CellChevron } from "./cell-chevron";

function makeEditor() {
  const cell = document.createElement("td");
  document.body.appendChild(cell);
  return {
    isEditable: true,
    isDestroyed: false,
    view: { nodeDOM: () => cell, dom: document.createElement("div") },
    state: { tr: { setSelection: () => {} }, selection: {}, doc: {} },
    commands: { freezeHandles: () => true, unfreezeHandles: () => true },
  } as any;
}

const tableNode = { type: { name: "table" }, nodeSize: 10 } as any;

beforeEach(() => {
  autoUpdateMock.mockClear();
  captured.length = 0;
});

function assertLayoutShiftDisabled(placement: string) {
  // One capture per render — floating-ui reads `whileElementsMounted` through
  // a latest-ref, so the inline arrow does NOT restart autoUpdate per render;
  // the last capture is the live one.
  const entries = captured.filter((c) => c.placement === placement);
  expect(entries.length).toBeGreaterThan(0);
  const reference = document.createElement("div");
  const floating = document.createElement("div");
  const update = () => {};

  entries[entries.length - 1].whileElementsMounted(reference, floating, update);

  expect(autoUpdateMock).toHaveBeenCalledTimes(1);
  const args = autoUpdateMock.mock.calls[0] as unknown as unknown[];
  expect(args[0]).toBe(reference);
  expect(args[1]).toBe(floating);
  expect(args[2]).toBe(update);
  expect(args[3]).toMatchObject({ layoutShift: false });
}

describe("table handles disable floating-ui layoutShift", () => {
  it("ColumnHandle", () => {
    render(
      <MantineProvider>
        <ColumnHandle
          editor={makeEditor()}
          index={0}
          anchorPos={1}
          tableNode={tableNode}
          tablePos={0}
        />
      </MantineProvider>,
    );
    assertLayoutShiftDisabled("top");
  });

  it("RowHandle", () => {
    render(
      <MantineProvider>
        <RowHandle
          editor={makeEditor()}
          index={0}
          anchorPos={1}
          tableNode={tableNode}
          tablePos={0}
        />
      </MantineProvider>,
    );
    assertLayoutShiftDisabled("left");
  });

  it("CellChevron", () => {
    render(
      <MantineProvider>
        <CellChevron
          editor={makeEditor()}
          cellPos={1}
          tableNode={tableNode}
          tablePos={0}
        />
      </MantineProvider>,
    );
    assertLayoutShiftDisabled("top-end");
  });
});
