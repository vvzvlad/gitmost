import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterEach,
} from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { MantineProvider } from "@mantine/core";

// --- Mocks for the heavy / networked module graph ---------------------------
// EditSpaceForm wires the "Enable Git sync" Switch to a TanStack-Query mutation
// (useUpdateSpaceMutation). We mock ONLY that hook so the test fully controls
// mutateAsync (resolve / reject) and isPending, and stub i18n. The real Mantine
// Switch is rendered so the checkbox role / disabled state is meaningful.

// i18n: identity translator — labels stay as their English keys for queries.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

// Mutation hook: a controllable mutateAsync plus a togglable isPending.
const mutateAsync = vi.fn();
let isPending = false;
vi.mock("@/features/space/queries/space-query.ts", () => ({
  useUpdateSpaceMutation: () => ({
    mutateAsync,
    get isPending() {
      return isPending;
    },
  }),
}));

// jsdom lacks matchMedia, which MantineProvider's color-scheme hook needs.
beforeAll(() => {
  if (!window.matchMedia) {
    window.matchMedia = (query: string) =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList;
  }
});

import { EditSpaceForm } from "./edit-space-form";
import type { ISpace } from "@/features/space/types/space.types.ts";

function makeSpace(overrides: Partial<ISpace> = {}): ISpace {
  return {
    id: "space-1",
    name: "Engineering",
    description: "",
    slug: "eng",
    hostname: "host",
    creatorId: "u1",
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    ...overrides,
  } as ISpace;
}

function renderForm(props: { space: ISpace; readOnly?: boolean }) {
  return render(
    <MantineProvider>
      <EditSpaceForm space={props.space} readOnly={props.readOnly} />
    </MantineProvider>,
  );
}

// The form now renders TWO switches (git-sync enable + auto-merge-conflicts) in
// that DOM order. Mantine renders each as an <input type="checkbox"
// role="switch"> but does NOT expose its label as the accessible name, so we
// disambiguate by DOM order (index 0 = enable, 1 = auto-merge) and assert the
// human-readable label text is present alongside.
function getToggle(): HTMLInputElement {
  screen.getByText("Enable Git sync");
  return screen.getAllByRole("switch")[0] as HTMLInputElement;
}

function getAutoMergeToggle(): HTMLInputElement {
  screen.getByText("Auto-merge conflicts on push");
  return screen.getAllByRole("switch")[1] as HTMLInputElement;
}

afterEach(() => {
  cleanup();
  mutateAsync.mockReset();
  isPending = false;
});

describe("EditSpaceForm git-sync toggle", () => {
  // Test 3: initial checked state derives from settings.gitSync.enabled ?? false.
  it("derives initial checked state from space.settings.gitSync.enabled (true -> checked)", () => {
    renderForm({
      space: makeSpace({ settings: { gitSync: { enabled: true } } }),
    });
    expect(getToggle().checked).toBe(true);
  });

  it("defaults to unchecked when gitSync settings are missing", () => {
    renderForm({ space: makeSpace() });
    expect(getToggle().checked).toBe(false);
  });

  // Test 4: toggling fires the mutation with { spaceId, gitSyncEnabled } and
  // optimistically flips the switch.
  it("fires the mutation with the correct payload and optimistically flips on", async () => {
    mutateAsync.mockResolvedValue(undefined);
    renderForm({ space: makeSpace() });

    const toggle = getToggle();
    expect(toggle.checked).toBe(false);

    fireEvent.click(toggle);

    // Optimistic update: the switch reflects the new state immediately.
    expect(toggle.checked).toBe(true);

    expect(mutateAsync).toHaveBeenCalledTimes(1);
    expect(mutateAsync).toHaveBeenCalledWith({
      spaceId: "space-1",
      gitSyncEnabled: true,
    });

    // Resolution leaves the toggle on.
    await waitFor(() => expect(toggle.checked).toBe(true));
  });

  // Test 5: rollback on mutation error — the most valuable test.
  it("rolls back the toggle to its prior state when the mutation rejects", async () => {
    mutateAsync.mockRejectedValue(new Error("network"));
    renderForm({
      space: makeSpace({ settings: { gitSync: { enabled: false } } }),
    });

    const toggle = getToggle();
    expect(toggle.checked).toBe(false);

    fireEvent.click(toggle);

    // Optimistically flips on before the rejection lands.
    expect(toggle.checked).toBe(true);
    expect(mutateAsync).toHaveBeenCalledWith({
      spaceId: "space-1",
      gitSyncEnabled: true,
    });

    // After the rejected promise settles, the component reverts to OFF so the
    // user is not misled into believing sync is enabled.
    await waitFor(() => expect(toggle.checked).toBe(false));
  });

  // Test 6: disabled when readOnly and when the mutation is pending.
  it("disables the toggle when readOnly", () => {
    renderForm({ space: makeSpace(), readOnly: true });
    expect(getToggle().disabled).toBe(true);
  });

  it("disables the toggle while the mutation is pending", () => {
    isPending = true;
    renderForm({ space: makeSpace() });
    expect(getToggle().disabled).toBe(true);
  });
});

describe("EditSpaceForm auto-merge-conflicts toggle", () => {
  it("derives initial checked state from space.settings.gitSync.autoMergeConflicts (true -> checked)", () => {
    renderForm({
      space: makeSpace({
        settings: { gitSync: { autoMergeConflicts: true } },
      }),
    });
    expect(getAutoMergeToggle().checked).toBe(true);
  });

  it("defaults to unchecked when autoMergeConflicts is missing (SAFE default)", () => {
    renderForm({ space: makeSpace() });
    expect(getAutoMergeToggle().checked).toBe(false);
  });

  it("fires the mutation with { spaceId, autoMergeConflicts } and optimistically flips on", async () => {
    mutateAsync.mockResolvedValue(undefined);
    renderForm({ space: makeSpace() });

    const toggle = getAutoMergeToggle();
    expect(toggle.checked).toBe(false);

    fireEvent.click(toggle);

    // Optimistic update.
    expect(toggle.checked).toBe(true);
    expect(mutateAsync).toHaveBeenCalledTimes(1);
    expect(mutateAsync).toHaveBeenCalledWith({
      spaceId: "space-1",
      autoMergeConflicts: true,
    });

    await waitFor(() => expect(toggle.checked).toBe(true));
  });

  it("rolls back to its prior state when the mutation rejects", async () => {
    mutateAsync.mockRejectedValue(new Error("network"));
    renderForm({
      space: makeSpace({
        settings: { gitSync: { autoMergeConflicts: false } },
      }),
    });

    const toggle = getAutoMergeToggle();
    expect(toggle.checked).toBe(false);

    fireEvent.click(toggle);

    expect(toggle.checked).toBe(true);
    expect(mutateAsync).toHaveBeenCalledWith({
      spaceId: "space-1",
      autoMergeConflicts: true,
    });

    await waitFor(() => expect(toggle.checked).toBe(false));
  });

  it("disables the toggle when readOnly", () => {
    renderForm({ space: makeSpace(), readOnly: true });
    expect(getAutoMergeToggle().disabled).toBe(true);
  });
});
