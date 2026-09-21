import { describe, it, expect, vi, beforeEach } from "vitest";
import { getDefaultStore } from "jotai";
import { currentUserAtom } from "@/features/user/atoms/current-user-atom";
import type { ICurrentUser } from "@/features/user/types/user.types";

// #642, part 3 — the api-client 401 interceptor must PURGE the persisted
// current-user BEFORE any early return on an exempt path (collab-token, /share,
// and redirectToLogin's own /login exempt return). Otherwise a dead-session
// reload paints the shell from the seed then redirects to /login, where the key
// survives → /login seeds again → app → /me → 401: an infinite loop.

const hoisted = vi.hoisted(() => ({ localFirst: true }));

vi.mock("@/lib/config.ts", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    isLocalFirstEnabled: () => hoisted.localFirst,
    isCloud: () => false,
  };
});

import api from "@/lib/api-client";

const store = getDefaultStore();

function persisted(): ICurrentUser {
  return {
    user: { id: "u1", name: "Stale", locale: "en", role: "member" },
    workspace: { id: "w1" },
  } as unknown as ICurrentUser;
}

// The registered axios response error handler (there is exactly one).
function get401Handler(): (e: unknown) => Promise<unknown> {
  const handlers = (api.interceptors.response as any).handlers as Array<{
    rejected?: (e: unknown) => Promise<unknown>;
  } | null>;
  const h = handlers.find((x) => x && x.rejected);
  if (!h?.rejected) throw new Error("no response error interceptor registered");
  return h.rejected;
}

function error401(responseURL: string) {
  return {
    response: { status: 401, data: {} },
    request: { responseURL },
  };
}

beforeEach(() => {
  localStorage.clear();
  hoisted.localFirst = true;
  store.set(currentUserAtom, persisted());
  // Land on /login: redirectToLogin early-returns here WITHOUT clearing — the
  // exact path the loop trap lives on.
  window.history.pushState({}, "", "/login");
});

describe("api-client 401 currentUser purge (#642 part 3)", () => {
  it("criterion 5/8: a 401 on /login clears the persisted currentUser BEFORE redirectToLogin's exempt-path early return", async () => {
    expect(localStorage.getItem("currentUser")).not.toBeNull(); // precondition
    const rejected = get401Handler();

    await expect(
      rejected(error401("http://localhost/api/users/me")),
    ).rejects.toBeDefined();

    expect(localStorage.getItem("currentUser")).toBeNull();
    expect(store.get(currentUserAtom)).toBeNull();
  });

  it("clears before the collab-token early return too", async () => {
    const rejected = get401Handler();
    // The collab-token branch swallows the error (`return;`) → resolves.
    await rejected(error401("http://localhost/api/auth/collab-token"));

    expect(localStorage.getItem("currentUser")).toBeNull();
    expect(store.get(currentUserAtom)).toBeNull();
  });

  it("non-vacuity + flag OFF: with local-first OFF the key SURVIVES a 401 (byte-unchanged; proves the assertion above is not vacuous)", async () => {
    hoisted.localFirst = false;
    const rejected = get401Handler();

    await expect(
      rejected(error401("http://localhost/api/users/me")),
    ).rejects.toBeDefined();

    expect(localStorage.getItem("currentUser")).not.toBeNull();
    expect(store.get(currentUserAtom)).toEqual(persisted());
  });
});
