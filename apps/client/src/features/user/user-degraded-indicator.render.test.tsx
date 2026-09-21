import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { MemoryRouter } from "react-router-dom";
import { Provider, createStore } from "jotai";

/**
 * #641, part 3 — rule #8 render test of the OBSERVABLE property "degraded gate ⇒
 * the UserDegradedIndicator badge is in the document".
 *
 * `resolveUserGate` (the pure decision) is unit-tested in user-provider-gate.test;
 * this mounts the REAL `UserProvider` and asserts the wiring `gate === "degraded"
 * → <>{children}<UserDegradedIndicator/></>` actually renders the badge — and that
 * a HEALTHY gate does NOT (the non-vacuity is built in). Only `/me` is faked (the
 * one input that selects the gate) plus the socket/reload side-effects that a
 * headless mount cannot run; the gate decision and the indicator component are the
 * real thing.
 */

const hoisted = vi.hoisted(() => ({
  meResult: {
    data: undefined as unknown,
    isLoading: false,
    error: undefined as unknown,
    isError: false,
  },
}));

// The single input that selects the gate.
vi.mock("@/features/user/hooks/use-current-user", () => ({
  default: () => hoisted.meResult,
}));

// Local-first ON — the degraded branch only exists with the flag on.
vi.mock("@/lib/config", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, isLocalFirstEnabled: () => true };
});

// Side-effects a headless mount cannot run (sockets, version-reload, collab
// token). None participate in the gate decision.
vi.mock("socket.io-client", () => ({
  io: () => ({ on: vi.fn(), disconnect: vi.fn() }),
}));
vi.mock("@/features/auth/queries/auth-query.tsx", () => ({
  useCollabToken: () => ({ data: undefined, refetch: vi.fn() }),
}));
vi.mock("@/features/websocket/use-query-subscription.ts", () => ({
  useQuerySubscription: () => undefined,
}));
vi.mock("@/features/websocket/use-tree-socket.ts", () => ({
  useTreeSocket: () => undefined,
}));
vi.mock("@/features/notification/hooks/use-notification-socket.ts", () => ({
  useNotificationSocket: () => undefined,
}));
vi.mock("@/features/user/guarded-reload.tsx", () => ({
  triggerGuardedReload: vi.fn(),
  useVersionReloadOnNavigation: () => undefined,
  surfacePreviousReloadBreadcrumb: () => undefined,
}));
vi.mock("@/main.tsx", async () => {
  const { QueryClient } = await import("@tanstack/react-query");
  return { queryClient: new QueryClient() };
});
vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, useTranslation: () => ({ t: (k: string) => k, i18n: { changeLanguage: vi.fn(), resolvedLanguage: "en", language: "en" } }) };
});

import { UserProvider } from "@/features/user/user-provider";

const CURRENT_USER = {
  user: { id: "u1", locale: "en" },
  workspace: { id: "w1" },
};
const transportError = { code: "ERR_NETWORK", response: undefined };

function mount() {
  const store = createStore();
  return render(
    <MantineProvider>
      <Provider store={store}>
        <MemoryRouter>
          <UserProvider>
            <div data-testid="app-children">app</div>
          </UserProvider>
        </MemoryRouter>
      </Provider>
    </MantineProvider>,
  );
}

beforeEach(() => {
  hoisted.meResult = {
    data: undefined,
    isLoading: false,
    error: undefined,
    isError: false,
  };
});

afterEach(() => {
  cleanup();
});

describe("UserProvider degraded branch renders the indicator (#641 part 3)", () => {
  it("DEGRADED gate (data + transport error) → badge IS in the document", () => {
    hoisted.meResult = {
      data: CURRENT_USER,
      isLoading: false,
      error: transportError,
      isError: true,
    };
    const { queryByTestId } = mount();
    // The app stays mounted (degraded, not blocked)...
    expect(queryByTestId("app-children")).not.toBeNull();
    // ...and the ONLY user-visible degraded signal is rendered.
    expect(queryByTestId("user-degraded-indicator")).not.toBeNull();
  });

  it("HEALTHY gate (data, no error) → badge is ABSENT (non-vacuity)", () => {
    hoisted.meResult = {
      data: CURRENT_USER,
      isLoading: false,
      error: undefined,
      isError: false,
    };
    const { queryByTestId } = mount();
    expect(queryByTestId("app-children")).not.toBeNull();
    expect(queryByTestId("user-degraded-indicator")).toBeNull();
  });
});
