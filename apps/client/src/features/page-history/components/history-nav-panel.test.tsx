import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { useState } from "react";
import HistoryNavPanel from "./history-nav-panel";
import { IPageHistory } from "@/features/page-history/types/page.types";
import { isoDayInTz } from "@/features/page-history/utils/revision-row";

// matchMedia / ResizeObserver are stubbed globally in vitest.setup.ts.
// react-i18next with no initialized instance returns the key as the label.

const TZ = "UTC";
const todayISO = isoDayInTz(new Date(), TZ);

function item(partial: Partial<IPageHistory>): IPageHistory {
  return {
    id: "x",
    // Default to "today" so the current-month calendar has a matching cell.
    createdAt: new Date().toISOString(),
    lastUpdatedBy: { id: "u1", name: "Alice", avatarUrl: "" },
    ...partial,
  } as IPageHistory;
}

const manual = item({ id: "m1", kind: "manual", lastUpdatedSource: "user" });
const autosave = item({ id: "a1", kind: null, lastUpdatedSource: "user" });

// Controlled harness so the "Only versions" switch actually toggles the filter,
// exercising the switch → filter wiring (not just a static prop).
function Harness({
  items = [manual, autosave],
  counts = new Map<string, number>(),
  onPick = vi.fn(),
  fetchNextPage = vi.fn(),
}: {
  items?: IPageHistory[];
  counts?: Map<string, number>;
  onPick?: () => void;
  fetchNextPage?: () => Promise<any>;
}) {
  const [onlyVersions, setOnlyVersions] = useState(false);
  return (
    <MantineProvider>
      <HistoryNavPanel
        fullItems={items}
        activeId=""
        onSelect={onPick}
        fetchNextPage={fetchNextPage as any}
        hasNextPage={false}
        isFetchingNextPage={false}
        isError={false}
        isLoading={false}
        counts={counts}
        selectedDayISO={todayISO}
        tz={TZ}
        onlyVersions={onlyVersions}
        setOnlyVersions={setOnlyVersions}
      />
    </MantineProvider>
  );
}

describe("HistoryNavPanel (#568 left nav)", () => {
  beforeEach(() => {
    // jsdom has no scrollTo on elements — provide a spyable stub.
    // @ts-ignore
    Element.prototype.scrollTo = vi.fn();
  });

  it("renders one dense row per revision and the mini-calendar", () => {
    render(<Harness />);
    expect(screen.getAllByTestId("revision-row")).toHaveLength(2);
    // 42-cell month grid is present.
    expect(screen.getAllByTestId("calendar-day")).toHaveLength(42);
  });

  it("the 'Only versions' switch filters out autosaves (non-vacuous)", () => {
    render(<Harness />);
    // Both the manual version and the autosave are shown initially.
    expect(screen.getAllByTestId("revision-row")).toHaveLength(2);

    fireEvent.click(screen.getByLabelText("Only versions"));

    // After filtering, only the manual VERSION row remains — if the filter
    // predicate were dropped this assertion would fail.
    const rows = screen.getAllByTestId("revision-row");
    expect(rows).toHaveLength(1);
    expect(screen.getByText("Alice")).toBeDefined();
  });

  it("picking a loaded day scrolls the list to that day's anchor", () => {
    render(<Harness counts={new Map([[todayISO, 1]])} />);
    const todayCell = screen
      .getAllByTestId("calendar-day")
      .find((c) => c.getAttribute("data-day") === todayISO)!;
    fireEvent.click(todayCell);
    // The day IS loaded (the row is on `today`), so scrollTo is invoked directly
    // without any pagination fetch.
    expect(Element.prototype.scrollTo).toHaveBeenCalled();
  });

  it("shows an explicit error state instead of a blank list", () => {
    render(
      <MantineProvider>
        <HistoryNavPanel
          fullItems={[]}
          activeId=""
          onSelect={vi.fn()}
          fetchNextPage={vi.fn() as any}
          hasNextPage={false}
          isFetchingNextPage={false}
          isError
          isLoading={false}
          counts={new Map()}
          selectedDayISO={null}
          tz={TZ}
          onlyVersions={false}
          setOnlyVersions={vi.fn()}
        />
      </MantineProvider>,
    );
    expect(screen.getByText("Error loading page history.")).toBeDefined();
    expect(screen.queryAllByTestId("revision-row")).toHaveLength(0);
  });

  it("shows an empty state (not blank) when there is no history", () => {
    render(
      <MantineProvider>
        <HistoryNavPanel
          fullItems={[]}
          activeId=""
          onSelect={vi.fn()}
          fetchNextPage={vi.fn() as any}
          hasNextPage={false}
          isFetchingNextPage={false}
          isError={false}
          isLoading={false}
          counts={new Map()}
          selectedDayISO={null}
          tz={TZ}
          onlyVersions={false}
          setOnlyVersions={vi.fn()}
        />
      </MantineProvider>,
    );
    expect(screen.getByText("No page history saved yet.")).toBeDefined();
  });

  it("does NOT flash the empty text while the initial query is loading", () => {
    // F1-residual: during the first fetch data is empty but isLoading is true —
    // the empty state must stay hidden until loading settles (mirrors the right
    // pane). Reverting the `!isLoading` gate makes this fail.
    render(
      <MantineProvider>
        <HistoryNavPanel
          fullItems={[]}
          activeId=""
          onSelect={vi.fn()}
          fetchNextPage={vi.fn() as any}
          hasNextPage={false}
          isFetchingNextPage={false}
          isError={false}
          isLoading={true}
          counts={new Map()}
          selectedDayISO={null}
          tz={TZ}
          onlyVersions={false}
          setOnlyVersions={vi.fn()}
        />
      </MantineProvider>,
    );
    expect(screen.queryByText("No page history saved yet.")).toBeNull();
  });
});
