// Vitest global setup (test-infra only — no production app source).
//
// Under Node 25 / jsdom 25 / vitest 4 the jsdom `localStorage` exposed on the
// global is not a usable Storage: its methods (`setItem`/`getItem`/...) are not
// callable, so any code touching `localStorage` throws `... is not a function`.
// Production code such as `isHtmlEmbedFeatureEnabled()` reads
// `localStorage.getItem("currentUser")`, which made dependent tests fail.
//
// We install a correct in-memory Storage stub on the global BEFORE tests run so
// the Web Storage contract holds: string coercion of keys/values, `null` for
// missing keys, working `length`/`key(index)`, and `clear()`.
import { vi } from "vitest";

// Minimal, spec-faithful in-memory implementation of the Web Storage API.
function createStorage(): Storage {
  let store = new Map<string, string>();

  const storage: Storage = {
    get length(): number {
      return store.size;
    },
    clear(): void {
      store = new Map<string, string>();
    },
    getItem(key: string): string | null {
      // Missing keys must return `null`, not `undefined`.
      const value = store.get(String(key));
      return value === undefined ? null : value;
    },
    setItem(key: string, value: string): void {
      // Web Storage coerces both key and value to strings.
      store.set(String(key), String(value));
    },
    removeItem(key: string): void {
      store.delete(String(key));
    },
    key(index: number): string | null {
      // Insertion order matches Map iteration order; out-of-range => null.
      const keys = Array.from(store.keys());
      return index >= 0 && index < keys.length ? keys[index] : null;
    },
  };

  return storage;
}

// Install on the jsdom global. `vi.stubGlobal` also reflects onto `window`
// (jsdom shares `globalThis` and `window`), so both `localStorage` and
// `window.localStorage` resolve to the same working stub.
vi.stubGlobal("localStorage", createStorage());
vi.stubGlobal("sessionStorage", createStorage());

// MantineProvider (and other components) read `window.matchMedia` on mount, which
// jsdom does not implement. Provide a minimal stub here so any test rendering
// Mantine works without re-stubbing matchMedia in every file.
vi.stubGlobal("matchMedia", (query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: vi.fn(),
  removeListener: vi.fn(),
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  dispatchEvent: vi.fn(),
}));
