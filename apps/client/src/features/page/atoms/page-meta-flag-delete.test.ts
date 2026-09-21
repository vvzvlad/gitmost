import { describe, it, expect, beforeEach, vi } from "vitest";
import { getDefaultStore } from "jotai";

// Mock config (the real one pulls lucide-react/dynamic, unresolved in the test
// env). The flag is a closure so each test can flip it.
let flag = true;
vi.mock("@/lib/config", () => ({
  isLocalFirstEnabled: () => flag,
  isClientTelemetryEnabled: () => false,
  getOfflineGraceMs: () => 30 * 24 * 60 * 60 * 1000,
}));

import {
  writePageMetaAtom,
  removePageMetaAtom,
  pageMetaCacheAtom,
  flushPendingPageMetaWrites,
  PAGE_META_KEY_PREFIX,
} from "./page-meta-cache-atom";
import { currentUserAtom } from "@/features/user/atoms/current-user-atom";
import type { ICurrentUser } from "@/features/user/types/user.types";

const SCOPE_KEY = `${PAGE_META_KEY_PREFIX}w1:u1`;

beforeEach(() => {
  flag = true;
  localStorage.clear();
  getDefaultStore().set(currentUserAtom, {
    user: { id: "u1" },
    workspace: { id: "w1" },
  } as unknown as ICurrentUser);
});

describe("removePageMetaAtom bypasses the flag (#640 acceptance 10)", () => {
  it("deletes a revoked page's meta with the flag OFF; a flag flip does not resurrect it", () => {
    const store = getDefaultStore();
    const page = { id: "id-1", slugId: "slug-1", title: "T", icon: null };

    // Flag ON: the page gets cached under both aliases.
    store.set(writePageMetaAtom, page);
    flushPendingPageMetaWrites();
    expect(store.get(pageMetaCacheAtom)["id-1"]).toBeTruthy();

    // Flag OFF: the WRITER is a no-op (so nothing re-adds it)...
    flag = false;
    store.set(writePageMetaAtom, page);
    // ...but the DELETE still runs (deletion is out of the flag gate).
    store.set(removePageMetaAtom, "id-1");
    flushPendingPageMetaWrites();

    // The entry is gone from the RAW persisted blob (both aliases).
    const raw = localStorage.getItem(SCOPE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    expect(parsed["id-1"]).toBeUndefined();
    expect(parsed["slug-1"]).toBeUndefined();

    // Flag back ON: the revoked page's meta does NOT resurface.
    flag = true;
    expect(store.get(pageMetaCacheAtom)["id-1"]).toBeUndefined();
  });
});
