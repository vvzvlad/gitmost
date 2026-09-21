import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  within,
} from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { ModalsProvider } from "@mantine/modals";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Provider, createStore } from "jotai";
import { UserRole } from "@/lib/types";
import { currentUserAtom } from "@/features/user/atoms/current-user-atom";
import { IApiKey } from "@/features/api-key/types/api-key.types";

// Mock the service layer so no real HTTP is attempted; every test drives the
// component through these three functions.
vi.mock("@/features/api-key/services/api-key-service", () => ({
  getApiKeys: vi.fn(),
  createApiKey: vi.fn(),
  revokeApiKey: vi.fn(),
  revealApiKey: vi.fn(),
}));

import {
  getApiKeys,
  createApiKey,
  revokeApiKey,
  revealApiKey,
} from "@/features/api-key/services/api-key-service";
import ApiKeysManager from "./api-keys-manager";

// matchMedia (read by MantineProvider) is stubbed globally in vitest.setup.ts.

const ISO_SOON = new Date(Date.now() + 10 * 864e5).toISOString();
const ISO_FAR = new Date(Date.now() + 200 * 864e5).toISOString();
const ISO_EXPIRED = new Date(Date.now() - 3 * 864e5).toISOString();

// Dump the storage stub via the Web Storage API — its data lives in a closure
// (see vitest.setup.ts), so JSON.stringify(localStorage) would be vacuous.
function storageDump(): string {
  let out = "";
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i) as string;
    out += `${k}=${localStorage.getItem(k)};`;
  }
  return out;
}

function makeKey(overrides: Partial<IApiKey> = {}): IApiKey {
  return {
    id: "key-1",
    name: "CI token",
    expiresAt: ISO_FAR,
    lastUsedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    creator: { id: "u1", name: "Alice", email: "a@x.io", avatarUrl: null },
    ...overrides,
  };
}

function renderManager(role: UserRole) {
  const store = createStore();
  store.set(currentUserAtom, {
    user: { id: "me", role } as never,
    workspace: {} as never,
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const utils = render(
    <Provider store={store}>
      <QueryClientProvider client={queryClient}>
        <MantineProvider>
          <ModalsProvider>
            <ApiKeysManager />
          </ModalsProvider>
        </MantineProvider>
      </QueryClientProvider>
    </Provider>,
  );
  return { store, queryClient, ...utils };
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe("ApiKeysManager — list rendering", () => {
  it("renders an explicit expiry date and highlights a <30-day key (acceptance #3)", async () => {
    vi.mocked(getApiKeys).mockResolvedValue([
      makeKey({ id: "k-soon", name: "Soon key", expiresAt: ISO_SOON }),
      makeKey({ id: "k-far", name: "Far key", expiresAt: ISO_FAR }),
    ]);

    renderManager(UserRole.MEMBER);

    await screen.findByText("Soon key");
    // Explicit dates, not "in N days": the year is rendered verbatim.
    const soonYear = new Date(ISO_SOON).getFullYear().toString();
    expect(screen.getAllByText(new RegExp(soonYear)).length).toBeGreaterThan(0);
    // Exactly one key is inside the 30-day warning window.
    expect(screen.getAllByText("Expiring soon")).toHaveLength(1);
  });

  it('shows "Expired" (not "Expiring soon") for an already-expired key', async () => {
    vi.mocked(getApiKeys).mockResolvedValue([
      makeKey({ id: "k-dead", name: "Dead key", expiresAt: ISO_EXPIRED }),
    ]);
    renderManager(UserRole.MEMBER);
    await screen.findByText("Dead key");
    // A past expiry is labelled "Expired", never the forward-looking badge.
    expect(screen.getByText("Expired")).toBeDefined();
    expect(screen.queryByText("Expiring soon")).toBeNull();
  });

  it('shows "Never" for an unlimited key and no highlight', async () => {
    vi.mocked(getApiKeys).mockResolvedValue([
      makeKey({ id: "k-forever", name: "Forever", expiresAt: null }),
    ]);
    renderManager(UserRole.MEMBER);
    await screen.findByText("Forever");
    expect(screen.getByText("Never")).toBeDefined();
    expect(screen.queryByText("Expiring soon")).toBeNull();
  });

  it("empty list shows the empty state", async () => {
    vi.mocked(getApiKeys).mockResolvedValue([]);
    renderManager(UserRole.MEMBER);
    expect(await screen.findByText("No API keys yet")).toBeDefined();
  });
});

describe("ApiKeysManager — admin vs member view (acceptance #6)", () => {
  it("a member does NOT see the author column", async () => {
    vi.mocked(getApiKeys).mockResolvedValue([
      makeKey({ creator: { id: "me", name: "Me", email: "m@x.io", avatarUrl: null } }),
    ]);
    renderManager(UserRole.MEMBER);
    await screen.findByText("CI token");
    // Author header absent + creator name not rendered (no author column).
    expect(screen.queryByText("Author")).toBeNull();
    expect(screen.queryByText("Me")).toBeNull();
  });

  it("an admin sees the author column with the creator's name", async () => {
    vi.mocked(getApiKeys).mockResolvedValue([
      makeKey({ creator: { id: "u1", name: "Alice", email: "a@x.io", avatarUrl: null } }),
    ]);
    renderManager(UserRole.ADMIN);
    await screen.findByText("CI token");
    expect(screen.getByText("Author")).toBeDefined();
    expect(screen.getByText("Alice")).toBeDefined();
  });
});

describe("ApiKeysManager — revoke (acceptance #4)", () => {
  it("revoke removes the row from the list", async () => {
    vi.mocked(getApiKeys)
      .mockResolvedValueOnce([
        makeKey({ id: "k1", name: "Doomed" }),
        makeKey({ id: "k2", name: "Survivor" }),
      ])
      // After revoke, invalidation refetches the reduced list.
      .mockResolvedValue([makeKey({ id: "k2", name: "Survivor" })]);
    vi.mocked(revokeApiKey).mockResolvedValue();

    renderManager(UserRole.MEMBER);
    await screen.findByText("Doomed");

    fireEvent.click(screen.getByLabelText("Revoke Doomed"));
    // Confirm modal → click the destructive confirm button.
    const confirm = await screen.findByRole("button", { name: "Revoke" });
    fireEvent.click(confirm);

    await waitFor(() =>
      expect(screen.queryByText("Doomed")).toBeNull(),
    );
    expect(screen.getByText("Survivor")).toBeDefined();
    expect(revokeApiKey).toHaveBeenCalledWith("k1");
  });
});

describe("ApiKeysManager — create no longer shows the token (copy replaces show-once)", () => {
  it("create closes the modal + toasts without ever rendering the token", async () => {
    const SECRET = "gm_secret-created-value";
    vi.mocked(getApiKeys).mockResolvedValue([]);
    vi.mocked(createApiKey).mockResolvedValue({
      token: SECRET,
      apiKey: {
        id: "new-1",
        name: "My key",
        expiresAt: ISO_FAR,
        createdAt: new Date().toISOString(),
      },
    });

    const { queryClient } = renderManager(UserRole.MEMBER);
    await screen.findByText("No API keys yet");

    fireEvent.click(
      screen.getAllByRole("button", { name: "Create API key" })[0],
    );
    const nameInput = await screen.findByLabelText(/Name/);
    fireEvent.change(nameInput, { target: { value: "My key" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(createApiKey).toHaveBeenCalled());
    // The token is never rendered (no more show-once modal).
    expect(screen.queryByTestId("api-key-token")).toBeNull();
    expect(screen.queryByText(SECRET)).toBeNull();

    // The created token never lands in localStorage or the react-query caches.
    expect(storageDump()).not.toContain(SECRET);
    const cacheDump = JSON.stringify(
      queryClient.getQueryCache().getAll().map((q) => q.state.data),
    );
    expect(cacheDump).not.toContain(SECRET);
    const mutationDump = JSON.stringify(
      queryClient.getMutationCache().getAll().map((m) => m.state.data),
    );
    expect(mutationDump).not.toContain(SECRET);
  });
});

describe("ApiKeysManager — copy under step-up (acceptance #9)", () => {
  it("copies a re-minted token to the clipboard and leaks it nowhere else", async () => {
    const SECRET = "gm_revealed-token-value-xyz";
    const writeText = vi.fn().mockResolvedValue(undefined);
    // jsdom has no clipboard; install a stub the copy helper will use.
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    vi.mocked(getApiKeys).mockResolvedValue([makeKey({ id: "k1", name: "CI token" })]);
    vi.mocked(revealApiKey).mockResolvedValue(SECRET);

    const { queryClient } = renderManager(UserRole.MEMBER);
    await screen.findByText("CI token");

    // Click the per-row Copy action → password step-up modal.
    fireEvent.click(screen.getByLabelText("Copy CI token"));
    const pwInput = await screen.findByLabelText("Password");
    fireEvent.change(pwInput, { target: { value: "hunter2" } });
    fireEvent.click(screen.getByRole("button", { name: "Copy to clipboard" }));

    // The reveal request carried the id + password; the token was written to the
    // clipboard and NOWHERE else.
    await waitFor(() =>
      expect(revealApiKey).toHaveBeenCalledWith({
        id: "k1",
        password: "hunter2",
      }),
    );
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(SECRET));

    // The revealed secret is never in the DOM, localStorage, or either cache.
    expect(screen.queryByText(SECRET)).toBeNull();
    expect(storageDump()).not.toContain(SECRET);
    const cacheDump = JSON.stringify(
      queryClient.getQueryCache().getAll().map((q) => q.state.data),
    );
    expect(cacheDump).not.toContain(SECRET);
    const mutationDump = JSON.stringify(
      queryClient.getMutationCache().getAll().map((m) => m.state.data),
    );
    expect(mutationDump).not.toContain(SECRET);
  });

  it("a wrong password keeps the modal open and does not copy", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    vi.mocked(getApiKeys).mockResolvedValue([makeKey({ id: "k1", name: "CI token" })]);
    // Server returns a 401 for a wrong step-up password.
    vi.mocked(revealApiKey).mockRejectedValue({ response: { status: 401 } });

    renderManager(UserRole.MEMBER);
    await screen.findByText("CI token");

    fireEvent.click(screen.getByLabelText("Copy CI token"));
    const pwInput = await screen.findByLabelText("Password");
    fireEvent.change(pwInput, { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: "Copy to clipboard" }));

    await waitFor(() => expect(revealApiKey).toHaveBeenCalled());
    // Nothing copied; the password field is still on screen for a retry.
    expect(writeText).not.toHaveBeenCalled();
    expect(await screen.findByLabelText("Password")).toBeDefined();
  });
});
