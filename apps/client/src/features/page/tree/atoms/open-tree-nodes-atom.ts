import { atom } from "jotai";
import {
  atomFamily,
  atomWithStorage,
  createJSONStorage,
} from "jotai/utils";
import { currentUserAtom } from "@/features/user/atoms/current-user-atom";
import { uiLocalStorage } from "@/lib/jotai-helper.ts";

export type OpenMap = Record<string, boolean>;

// Explicit synchronous localStorage so `getOnInit` resolves to the sync overload
// (the default storage is typed sync+async, which would widen the value type to
// `OpenMap | Promise<OpenMap>` and break the functional-updater setter below).
// `uiLocalStorage` (not a bare `() => localStorage`) so a browser that blocks
// site data degrades to an empty map instead of throwing at atom construction
// (getOnInit reads synchronously at module eval) — which, with sidebar-atom.ts
// now guarded, would otherwise make THIS the new top white-screen cause.
const openTreeNodesStorage = createJSONStorage<OpenMap>(
  uiLocalStorage as () => Storage,
);

// Single source of truth for the open-map localStorage key prefix. Exported so
// the logout cache sweep (tree-data-atom.ts) removes keys by the SAME prefix
// used to write them — a rename here can never silently desync the cleanup.
export const OPEN_TREE_NODES_KEY_PREFIX = "openTreeNodes:";

// One persisted open/closed map per (workspace, user). Scoping the localStorage
// key prevents accounts that share a browser origin from leaking tree state.
// `getOnInit: true` reads localStorage synchronously at atom init (not on mount),
// so the first render already has the saved state — no collapse-then-expand
// flicker on reload, and writes never run against an un-hydrated empty map.
const openTreeNodesFamily = atomFamily((scopeKey: string) =>
  atomWithStorage<OpenMap>(
    `${OPEN_TREE_NODES_KEY_PREFIX}${scopeKey}`,
    {},
    openTreeNodesStorage,
    { getOnInit: true },
  ),
);

// Resolve the storage scope from the current user. Fall back to "anon" for the
// workspace/user parts when nothing is loaded yet (logged out / first paint).
// Shared by the open-map atom below and the persisted tree-data atom
// (tree-data-atom.ts) so both caches are scoped identically.
export const scopeKeyAtom = atom((get) => {
  const currentUser = get(currentUserAtom);
  const workspaceId = currentUser?.workspace?.id ?? "anon";
  const userId = currentUser?.user?.id ?? "anon";
  return `${workspaceId}:${userId}`;
});

// Public facade — same read value (OpenMap) and same setter shape (value OR
// functional updater) as the previous in-memory atom, but transparently routed
// to the localStorage-backed map for the current workspace/user.
export const openTreeNodesAtom = atom(
  (get) => get(openTreeNodesFamily(get(scopeKeyAtom))),
  (get, set, update: OpenMap | ((prev: OpenMap) => OpenMap)) => {
    const target = openTreeNodesFamily(get(scopeKeyAtom));
    const next =
      typeof update === "function"
        ? (update as (prev: OpenMap) => OpenMap)(get(target))
        : update;
    set(target, next);
  },
);
