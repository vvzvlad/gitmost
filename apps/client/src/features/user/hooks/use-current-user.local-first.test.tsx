import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, renderHook, screen, cleanup, waitFor } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { ICurrentUser } from "@/features/user/types/user.types";
import { currentUserAtom } from "@/features/user/atoms/current-user-atom";
import { resolveUserGate } from "@/features/user/user-provider-gate";

// #642 (Ф6) — drop the FIRST of two serial RTTs on page open. `useCurrentUser`
// now seeds react-query from the persisted `currentUserAtom` so UserProvider's
// `if (isLoading) return <></>` gate passes through on the first frame, and
// `useRedirectIfAuthenticated` requires a CONFIRMED fetch so a stale seed cannot
// bounce /login into the app. All under `LOCAL_FIRST_ENABLED`.

const hoisted = vi.hoisted(() => ({ localFirst: true }));

vi.mock("@/lib/config.ts", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    isLocalFirstEnabled: () => hoisted.localFirst,
  };
});

const getMyInfoMock = vi.hoisted(() => vi.fn());
vi.mock("@/features/user/services/user-service", () => ({
  getMyInfo: getMyInfoMock,
}));

const navigateMock = vi.hoisted(() => vi.fn());
vi.mock("react-router-dom", () => ({
  useNavigate: () => navigateMock,
}));

import useCurrentUser from "@/features/user/hooks/use-current-user";
import { useRedirectIfAuthenticated } from "@/features/auth/hooks/use-redirect-if-authenticated";

function persisted(): ICurrentUser {
  return {
    user: { id: "u1", name: "Stale", locale: "en", role: "member" },
    workspace: { id: "w1" },
  } as unknown as ICurrentUser;
}

function networkError(): Error {
  // A transport failure: no `.response`, so httpStatusOf() is undefined (not
  // 401/404) — the Ф5 gate must tolerate it while data is present.
  return Object.assign(new Error("Network Error"), { code: "ERR_NETWORK" });
}

function status401(): unknown {
  return { response: { status: 401, data: {} } };
}

function makeWrapper(store: ReturnType<typeof createStore>) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>
      <Provider store={store}>{children}</Provider>
    </QueryClientProvider>
  );
}

// A faithful miniature of UserProvider's `/me` gate: render children unless the
// `/me` query is still loading (mirrors user-provider.tsx `if (isLoading)`).
function MiniUserGate() {
  const { isLoading } = useCurrentUser();
  if (isLoading) return <div data-testid="empty-gate" />;
  return <div data-testid="children" />;
}

// Drives useRedirectIfAuthenticated AND surfaces the confirmed-fetch flags so a
// test can wait for the real /me to settle before asserting on navigation.
function LoginProbe() {
  useRedirectIfAuthenticated();
  const { isFetched, isSuccess } = useCurrentUser();
  return (
    <div
      data-testid="probe"
      data-fetched={String(isFetched)}
      data-success={String(isSuccess)}
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  hoisted.localFirst = true;
});

afterEach(() => {
  cleanup();
});

describe("useCurrentUser seed (#642 parts 1+2)", () => {
  it("criterion 1+2: reload with a valid persisted session renders the shell on frame 1 (isLoading false via initialData, /me not yet fetched)", () => {
    const store = createStore();
    store.set(currentUserAtom, persisted());
    getMyInfoMock.mockReturnValue(new Promise<never>(() => {})); // /me in flight

    const wrapper = makeWrapper(store);

    // Observable: the gate renders CHILDREN on the very first frame, before /me.
    render(<MiniUserGate />, { wrapper });
    expect(screen.queryByTestId("children")).not.toBeNull();
    expect(screen.queryByTestId("empty-gate")).toBeNull();

    // The query state that drives it: success + data present + not yet fetched.
    const { result } = renderHook(() => useCurrentUser(), { wrapper });
    expect(result.current.isLoading).toBe(false);
    expect(result.current.data).toEqual(persisted());
    expect(result.current.isSuccess).toBe(true);
    expect(result.current.isFetched).toBe(false); // seed, not a real fetch yet

    // And that state resolves the UserProvider gate to "children".
    expect(
      resolveUserGate({
        localFirst: true,
        isLoading: result.current.isLoading,
        error: result.current.error,
        hasData: Boolean(result.current.data),
      }),
    ).toBe("children");
  });

  it("criterion 4: first visit with NO persisted user gates to empty until /me resolves (no regression)", async () => {
    const store = createStore(); // currentUserAtom stays null
    let resolve!: (v: ICurrentUser) => void;
    getMyInfoMock.mockReturnValue(
      new Promise<ICurrentUser>((r) => {
        resolve = r;
      }),
    );
    const wrapper = makeWrapper(store);

    render(<MiniUserGate />, { wrapper });
    // Frame 1: today's behavior — empty gate, no children.
    expect(screen.queryByTestId("empty-gate")).not.toBeNull();
    expect(screen.queryByTestId("children")).toBeNull();

    resolve(persisted());
    await waitFor(() =>
      expect(screen.queryByTestId("children")).not.toBeNull(),
    );
  });

  it("flag OFF: a persisted user is NOT seeded — frame 1 is today's empty gate (byte-unchanged)", () => {
    hoisted.localFirst = false;
    const store = createStore();
    store.set(currentUserAtom, persisted());
    getMyInfoMock.mockReturnValue(new Promise<never>(() => {}));
    const wrapper = makeWrapper(store);

    render(<MiniUserGate />, { wrapper });
    expect(screen.queryByTestId("empty-gate")).not.toBeNull();
    expect(screen.queryByTestId("children")).toBeNull();

    const { result } = renderHook(() => useCurrentUser(), { wrapper });
    expect(result.current.isLoading).toBe(true);
    expect(result.current.data).toBeUndefined();
  });

  it("criterion 7: a transport error on /me WITH a persisted user keeps data present (app stays mounted via Ф5 'degraded') — the seed does not break Ф5", async () => {
    const store = createStore();
    store.set(currentUserAtom, persisted());
    getMyInfoMock.mockRejectedValue(networkError());
    const wrapper = makeWrapper(store);

    const { result } = renderHook(() => useCurrentUser(), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));

    // Seed data is RETAINED through the error → the gate stays out of "blocked".
    expect(result.current.data).toEqual(persisted());
    expect(
      resolveUserGate({
        localFirst: true,
        isLoading: false,
        error: result.current.error,
        hasData: Boolean(result.current.data),
      }),
    ).toBe("degraded");
  });
});

describe("useRedirectIfAuthenticated confirmed-fetch gate (#642 part 4)", () => {
  it("criterion 8: /login with a stale persisted user does NOT auto-redirect (seed alone is not a confirmed fetch), even after /me 401s", async () => {
    const store = createStore();
    store.set(currentUserAtom, persisted());
    getMyInfoMock.mockRejectedValue(status401());
    const wrapper = makeWrapper(store);

    render(<LoginProbe />, { wrapper });

    // Frame 1: seeded (success + data) but NOT fetched → no navigation.
    expect(navigateMock).not.toHaveBeenCalled();

    // After the real /me resolves (as a 401) → fetched, but not success → still
    // no redirect. No /login ⇄ app loop.
    await waitFor(() =>
      expect(screen.getByTestId("probe").getAttribute("data-fetched")).toBe(
        "true",
      ),
    );
    expect(screen.getByTestId("probe").getAttribute("data-success")).toBe(
      "false",
    );
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it("non-vacuity: a genuinely authenticated /login (real /me succeeds) DOES redirect once", async () => {
    const store = createStore();
    store.set(currentUserAtom, persisted());
    getMyInfoMock.mockResolvedValue(persisted());
    const wrapper = makeWrapper(store);

    render(<LoginProbe />, { wrapper });
    await waitFor(() => expect(navigateMock).toHaveBeenCalledTimes(1));
  });

  it("flag OFF: redirect still fires only after a confirmed fetch (behavior-equivalent to today's `data && data.user`)", async () => {
    hoisted.localFirst = false;
    const store = createStore();
    let resolve!: (v: ICurrentUser) => void;
    getMyInfoMock.mockReturnValue(
      new Promise<ICurrentUser>((r) => {
        resolve = r;
      }),
    );
    const wrapper = makeWrapper(store);

    render(<LoginProbe />, { wrapper });
    expect(navigateMock).not.toHaveBeenCalled(); // no seed, still loading

    resolve(persisted());
    await waitFor(() => expect(navigateMock).toHaveBeenCalledTimes(1));
  });
});
