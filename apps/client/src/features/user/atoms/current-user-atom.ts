import { atom, getDefaultStore } from "jotai";
import { atomWithStorage, createJSONStorage, RESET } from "jotai/utils";
import { ICurrentUser, IUser } from "@/features/user/types/user.types";
import { IWorkspace } from "@/features/workspace/types/workspace.types";
import { uiLocalStorage } from "@/lib/jotai-helper.ts";

// Explicit SYNCHRONOUS localStorage, built exactly like the sibling boot-cache
// atoms (open-tree-nodes-atom.ts / page-meta-cache-atom.ts / tree-data-atom.ts).
// Passing `undefined` as the 3rd arg makes jotai pick its ASYNC-capable storage
// overload, which (a) widens the value type to `ICurrentUser | Promise<…>` and
// (b) does NOT guarantee a synchronous first-render read — so it must be an
// explicit SyncStorage. `uiLocalStorage` (not a bare `() => localStorage`) keeps
// the guard: reading `window.localStorage` THROWS when the browser blocks site
// data, and with `getOnInit: true` that read runs synchronously at module eval,
// so an unguarded accessor would white-screen the whole app; the guard degrades
// to jotai's defaults (empty) instead.
const currentUserStorage = createJSONStorage<ICurrentUser | null>(
  uiLocalStorage as () => Storage,
);

// `getOnInit: true` (#640, part 2) — read the persisted current user
// SYNCHRONOUSLY at atom init, so the very first frame already has a resolved
// (workspace, user) scope key (`scopeKeyAtom`). The explicit synchronous storage
// above is what makes this true: with it, jotai's `getOnInit` reads the persisted
// `currentUser` from localStorage the first time a store reads this atom (at app
// boot localStorage is already populated), synchronously, and the value type
// stays `ICurrentUser | null` (sync). Were it left async (`undefined` storage),
// jotai would pick the async overload and return the initialValue
// (null) at t0, not storage, so `scopeKeyAtom` would be "anon:anon" on the first
// frame — and the ydoc DB name / tombstone check / eviction would have no real
// scope to compute against (an anon-scope eviction would target a database
// matching no real DB and falsely report success). UserProvider still fetches
// `/me` and overwrites this a tick later, so a stale persisted user is corrected
// within one RTT (its authority is capped to a single round-trip).
export const currentUserAtom = atomWithStorage<ICurrentUser | null>(
  "currentUser",
  null,
  currentUserStorage,
  { getOnInit: true },
);

// #642, part 3 — purge the persisted current user (both the on-disk key and the
// in-memory jotai value). Called by the api-client 401 interceptor when a session
// is found dead, BEFORE it redirects to login. RESET on an `atomWithStorage`
// removes the storage key and reverts the value to `null`, exactly like logout's
// `setCurrentUser(RESET)` — so a dead-session reload cannot keep seeding the shell
// and loop between /login and the app. The app uses jotai's default store (no
// custom Provider), so `getDefaultStore()` is the same store the components read.
export function clearPersistedCurrentUser(): void {
  getDefaultStore().set(currentUserAtom, RESET);
}

export const userAtom = atom(
  (get) => {
    const currentUser = get(currentUserAtom);
    return currentUser?.user ?? null;
  },
  (get, set, newUser: IUser) => {
    const currentUser = get(currentUserAtom);
    if (currentUser) {
      set(currentUserAtom, {
        ...currentUser,
        user: newUser,
      });
    }
  }
);

export const workspaceAtom = atom(
  (get) => {
    const currentUser = get(currentUserAtom);
    return currentUser?.workspace ?? null;
  },
  (get, set, newWorkspace: IWorkspace) => {
    const currentUser = get(currentUserAtom);
    if (currentUser) {
      set(currentUserAtom, {
        ...currentUser,
        workspace: newWorkspace,
      });
    }
  }
);
