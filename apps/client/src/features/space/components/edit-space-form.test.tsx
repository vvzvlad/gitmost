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

// Server git-sync flag (window.CONFIG.GIT_SYNC_ENABLED): ON by default here so
// the toggle tests see the switches; one test flips it OFF.
let gitSyncFlag = true;
vi.mock("@/lib/config.ts", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isGitSyncEnabled: () => gitSyncFlag,
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

// The form renders ONE switch (git-sync enable). Mantine renders it as an
// <input type="checkbox" role="switch"> but does NOT expose its label as the
// accessible name, so we take it by role and assert the human-readable label
// text is present alongside.
function getToggle(): HTMLInputElement {
  screen.getByText("Enable Git sync");
  return screen.getAllByRole("switch")[0] as HTMLInputElement;
}

afterEach(() => {
  cleanup();
  mutateAsync.mockReset();
  isPending = false;
  gitSyncFlag = true;
});

describe("EditSpaceForm with git-sync disabled on the server", () => {
  it("renders no git-sync switch", () => {
    gitSyncFlag = false;
    renderForm({ space: makeSpace() });
    expect(screen.queryAllByRole("switch")).toHaveLength(0);
    expect(screen.queryByText("Enable Git sync")).toBeNull();
  });
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

describe("EditSpaceForm appearance", () => {
  it("saves the icon and color alongside existing space fields", async () => {
    mutateAsync.mockResolvedValue({});
    renderForm({ space: makeSpace() });
    fireEvent.click(screen.getByRole("button", { name: "Rocket" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Icon color" }), {
      target: { value: "#7c3aed" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledWith({
      spaceId: "space-1", icon: "rocket", iconColor: "#7c3aed",
    }));
  });

  it("resets a custom appearance with explicit nulls", async () => {
    mutateAsync.mockResolvedValue({});
    renderForm({ space: makeSpace({ settings: { appearance: { icon: "code", color: "#166c9d" } } }) });
    fireEvent.click(screen.getByRole("button", { name: "Reset space appearance" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledWith({
      spaceId: "space-1", icon: null, iconColor: null,
    }));
  });

  it("disables appearance changes in a read-only space", () => {
    renderForm({ space: makeSpace(), readOnly: true });
    expect((screen.getByRole("button", { name: "Rocket" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });
});
