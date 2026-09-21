import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import type { ReactNode } from "react";
import type { IPage } from "@/features/page/types/page.types";
import type { ICurrentUser } from "@/features/user/types/user.types";

// #563 — a session can end WITHOUT a logout (expired cookie, closed tab), which
// leaves the previous user's boot caches (page titles!) and their `currentUser`
// in localStorage. Sign-in must therefore purge them exactly like logout does —
// otherwise the next user renders the first commit under the PREVIOUS user's
// scope key (`currentUser` is only replaced by `/me` a tick later) and sees that
// user's cached page titles/icons.

vi.mock("@/features/auth/services/auth-service", () => ({
  login: vi.fn().mockResolvedValue({}),
  logout: vi.fn().mockResolvedValue(undefined),
  forgotPassword: vi.fn(),
  passwordReset: vi.fn(),
  setupWorkspace: vi.fn(),
  verifyUserToken: vi.fn(),
}));

vi.mock("@/features/workspace/services/workspace-service.ts", () => ({
  acceptInvitation: vi.fn(),
}));

vi.mock("react-router-dom", () => ({
  useNavigate: () => vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: "3rdParty", init: () => undefined },
}));

import useAuth from "./use-auth";
import {
  writePageMetaAtom,
  flushPendingPageMetaWrites,
  PAGE_META_KEY_PREFIX,
} from "@/features/page/atoms/page-meta-cache-atom";
import { currentUserAtom } from "@/features/user/atoms/current-user-atom";

const USER_A_META_KEY = `${PAGE_META_KEY_PREFIX}wA:uA`;
const USER_A_TREE_KEY = "treeData:v1:wA:uA";

function userB(): ICurrentUser {
  return {
    user: { id: "uB" },
    workspace: { id: "wB" },
  } as unknown as ICurrentUser;
}

function page(): Partial<IPage> {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    slugId: "slug1",
    title: "User B's page",
  };
}

function wrapper(store: ReturnType<typeof createStore>) {
  return ({ children }: { children: ReactNode }) => (
    <Provider store={store}>{children}</Provider>
  );
}

beforeEach(() => {
  localStorage.clear();
  process.env.LOCAL_FIRST_ENABLED = "true";
});

afterEach(() => {
  delete process.env.LOCAL_FIRST_ENABLED;
  vi.restoreAllMocks();
});

describe("handleSignIn purges the previous user's boot caches (#563)", () => {
  it("sweeps the persisted caches + the stale currentUser, and keeps persistence working", async () => {
    // User A's session ended without a logout: their caches are still on disk.
    localStorage.setItem(
      USER_A_META_KEY,
      JSON.stringify({
        slug1: {
          id: "aaaa",
          slugId: "slug1",
          title: "User A's secret page",
          lastAccess: 1,
        },
      }),
    );
    localStorage.setItem(USER_A_TREE_KEY, JSON.stringify([{ id: "a-node" }]));
    localStorage.setItem(
      "currentUser",
      JSON.stringify({ user: { id: "uA" }, workspace: { id: "wA" } }),
    );

    const store = createStore();
    const { result } = renderHook(() => useAuth(), { wrapper: wrapper(store) });

    await act(async () => {
      await result.current.signIn({ email: "b@example.com", password: "x" });
    });

    // Nothing of user A's is left for the incoming user to render.
    expect(localStorage.getItem(USER_A_META_KEY)).toBeNull();
    expect(localStorage.getItem(USER_A_TREE_KEY)).toBeNull();
    // …and the stale currentUser is gone, so the scope key cannot resolve to A
    // in the commits before `/me` answers.
    expect(localStorage.getItem("currentUser")).toBeNull();
    expect(store.get(currentUserAtom)).toBeNull();

    // Crucially, sign-in must NOT arm the logout kill-switch: this is the same
    // SPA session, so the boot cache has to keep persisting for user B.
    store.set(currentUserAtom, userB());
    store.set(writePageMetaAtom, page());
    flushPendingPageMetaWrites();

    const written = localStorage.getItem(`${PAGE_META_KEY_PREFIX}wB:uB`);
    expect(written).not.toBeNull();
    expect(JSON.parse(written!)["slug1"].title).toBe("User B's page");
  });
});
