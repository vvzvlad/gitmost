import { atomWithStorage, createJSONStorage } from "jotai/utils";
// `SyncStorage` is NOT re-exported from `jotai/utils`; import it from the
// vanilla sub-path (exports map `./*`, moduleResolution: bundler). Do not
// re-declare the interface locally — it must stay in lockstep with jotai.
import type { SyncStorage } from "jotai/vanilla/utils/atomWithStorage";

// Guarded accessor: reading `window.localStorage` THROWS (SecurityError) when the
// browser blocks site data (Chrome "Block all cookies", corporate site-data
// policy, a sandboxed iframe). jotai's own try/catch lives ONLY inside
// createJSONStorage's DEFAULT `getStringStorage` parameter, so passing a custom
// `() => localStorage` loses that guard — and with `getOnInit: true` the read
// happens synchronously at atom construction (module eval), turning that throw
// into a white screen for the whole app. Returning `undefined` here lets
// createJSONStorage degrade to defaults (`getStringStorage()?.getItem` -> null).
// Exported: open-tree-nodes-atom.ts needs the same guard.
export const uiLocalStorage = (): Storage | undefined => {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
};

// Build a fail-soft, validated SyncStorage over `uiLocalStorage`. Every stored
// value is run through the caller's `validate`; anything that fails (corrupt
// JSON already yields the initial from createJSONStorage, out-of-contract shapes
// are rejected here) degrades to the initial value. Exported for the regression
// guard test (acceptance #6) that asserts `subscribe` is absent.
export function createUiStorage<Value>(
  validate: (v: unknown) => v is Value,
): SyncStorage<Value> {
  // `uiLocalStorage as () => Storage`: tsconfig has strictNullChecks:false so the
  // `| undefined` return type is currently accepted, but the cast documents the
  // intent and keeps the call compiling if strict is ever turned on (Storage
  // satisfies jotai's SyncStringStorage).
  const base = createJSONStorage<Value>(uiLocalStorage as () => Storage);
  return {
    getItem: (key, initial) => {
      try {
        const v = base.getItem(key, initial);
        return validate(v) ? v : initial;
      } catch {
        // `validate` is caller-supplied and runs at module eval under getOnInit:
        // a throwing validator must degrade to the default, not white-screen.
        return initial;
      }
    },
    setItem: (key, v) => {
      try {
        base.setItem(key, v);
      } catch {
        /* quota exceeded / storage disabled: best-effort, never throw */
      }
    },
    removeItem: (key) => {
      try {
        base.removeItem(key);
      } catch {
        /* best-effort */
      }
    },
    // `subscribe` INTENTIONALLY omitted -> no cross-tab live sync (localStorage
    // here is a snapshot for load, not a tab-sync channel). Do NOT reach for
    // jotai's `unstable_withStorageValidator`: it spreads `{...storage}` and
    // copies `subscribe` back in, silently restoring cross-tab sync AND leaving
    // the subscribe path unvalidated.
  };
}

// A localStorage-backed atom for UI chrome: fail-soft (a blocked/unavailable
// localStorage degrades to `initialValue`, never throws at module load) and
// validated (any out-of-contract persisted value degrades to `initialValue`).
// `getOnInit: true` hydrates synchronously at construction so the first render
// already has the saved value (no flicker, and effects reading it on mount see
// the restored value — see AiChatWindow geometry restore).
export function atomWithUiStorage<Value>(
  key: string,
  initialValue: Value,
  validate: (v: unknown) => v is Value,
) {
  return atomWithStorage<Value>(key, initialValue, createUiStorage(validate), {
    getOnInit: true,
  });
}
