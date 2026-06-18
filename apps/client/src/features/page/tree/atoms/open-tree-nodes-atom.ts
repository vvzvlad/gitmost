import { atom } from "jotai";
import {
  atomFamily,
  atomWithStorage,
  createJSONStorage,
} from "jotai/utils";
import { currentUserAtom } from "@/features/user/atoms/current-user-atom";

export type OpenMap = Record<string, boolean>;

// Explicit synchronous localStorage so `getOnInit` resolves to the sync overload
// (the default storage is typed sync+async, which would widen the value type to
// `OpenMap | Promise<OpenMap>` and break the functional-updater setter below).
const openTreeNodesStorage = createJSONStorage<OpenMap>(() => localStorage);

// One persisted open/closed map per (workspace, user). Scoping the localStorage
// key prevents accounts that share a browser origin from leaking tree state.
// `getOnInit: true` reads localStorage synchronously at atom init (not on mount),
// so the first render already has the saved state — no collapse-then-expand
// flicker on reload, and writes never run against an un-hydrated empty map.
const openTreeNodesFamily = atomFamily((scopeKey: string) =>
  atomWithStorage<OpenMap>(`openTreeNodes:${scopeKey}`, {}, openTreeNodesStorage, {
    getOnInit: true,
  }),
);

// Resolve the storage scope from the current user. Fall back to "anon" for the
// workspace/user parts when nothing is loaded yet (logged out / first paint).
const scopeKeyAtom = atom((get) => {
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
