import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, act, cleanup } from "@testing-library/react";
import { MemoryRouter, useNavigate } from "react-router-dom";

// Mocks for the dirty shell's side-effecting collaborators.
vi.mock("@mantine/notifications", () => ({
  notifications: { show: vi.fn() },
}));
vi.mock("@/i18n.ts", () => ({ default: { t: (k: string) => k } }));
vi.mock("@/lib/reload-guard", () => ({
  hasAutoReloaded: vi.fn(() => false),
  markAutoReloaded: vi.fn(() => true),
  recordReloadBreadcrumb: vi.fn(),
  takeReloadBreadcrumb: vi.fn(() => null),
}));

import { notifications } from "@mantine/notifications";
import { hasAutoReloaded, markAutoReloaded } from "@/lib/reload-guard";
import {
  triggerGuardedReload,
  useVersionReloadOnNavigation,
  __resetGuardedReloadForTests,
} from "./guarded-reload";

const show = notifications.show as unknown as ReturnType<typeof vi.fn>;
const mockHasAutoReloaded = hasAutoReloaded as unknown as ReturnType<
  typeof vi.fn
>;
const mockMarkAutoReloaded = markAutoReloaded as unknown as ReturnType<
  typeof vi.fn
>;

let reload: ReturnType<typeof vi.fn>;
let visibility: DocumentVisibilityState;

// Test harness mounted inside a router: it installs the navigation hook and
// exposes `navigate` so a test can drive an in-app router navigation.
let doNavigate: (to: string) => void;
function Harness() {
  useVersionReloadOnNavigation();
  const navigate = useNavigate();
  doNavigate = navigate;
  return null;
}

function mountHarness() {
  render(
    <MemoryRouter initialEntries={["/start"]}>
      <Harness />
    </MemoryRouter>,
  );
}

function navigateTo(path: string) {
  act(() => {
    doNavigate(path);
  });
}

beforeEach(() => {
  __resetGuardedReloadForTests();
  vi.clearAllMocks();
  mockHasAutoReloaded.mockReturnValue(false);
  mockMarkAutoReloaded.mockReturnValue(true);

  vi.stubGlobal("APP_VERSION", "test-A");

  reload = vi.fn();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { reload },
  });

  visibility = "visible";
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("triggerGuardedReload (variant C)", () => {
  it("noop when versions match: no banner, no reload", () => {
    triggerGuardedReload("test-A");
    expect(show).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it("noop when the server version is empty (fail-safe)", () => {
    triggerGuardedReload("");
    triggerGuardedReload(undefined);
    expect(show).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it("real mismatch shows the banner but does NOT reload immediately", () => {
    mountHarness();
    triggerGuardedReload("test-B");
    expect(show).toHaveBeenCalledTimes(1);
    expect(show.mock.calls[0][0]).toMatchObject({
      id: "app-version-reload",
      autoClose: false,
      withCloseButton: true,
    });
    expect(reload).not.toHaveBeenCalled();
  });

  it("reloads EXACTLY ONCE on the first in-app navigation after a mismatch", () => {
    mountHarness();
    triggerGuardedReload("test-B");
    expect(reload).not.toHaveBeenCalled();

    navigateTo("/next");
    expect(reload).toHaveBeenCalledTimes(1);

    // A second navigation must NOT reload again (one-shot was consumed).
    navigateTo("/again");
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("does NOT reload on a 2nd mismatch after the first was armed/consumed (one-shot)", () => {
    mountHarness();
    triggerGuardedReload("test-B");
    navigateTo("/next");
    expect(reload).toHaveBeenCalledTimes(1);

    // Another app-version mismatch arrives (reconnect): must not re-arm.
    triggerGuardedReload("test-C");
    navigateTo("/again");
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("does NOT reload merely from the tab going to the background", () => {
    mountHarness();
    triggerGuardedReload("test-B");
    expect(reload).not.toHaveBeenCalled();

    visibility = "hidden";
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(reload).not.toHaveBeenCalled();
  });

  it("a hidden-at-receipt tab is also NOT reloaded immediately (variant C uniform); reloads on next navigation", () => {
    visibility = "hidden";
    mountHarness();
    triggerGuardedReload("test-B");
    expect(reload).not.toHaveBeenCalled();
    expect(show).toHaveBeenCalledTimes(1);

    navigateTo("/next");
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("the banner's Update button reloads immediately", () => {
    triggerGuardedReload("test-B");
    const message = show.mock.calls[0][0].message as {
      props: { onClick: () => void };
    };
    message.props.onClick();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("banner-only (auto-reload already spent): banner, never auto-reload on navigation", () => {
    mockHasAutoReloaded.mockReturnValue(true);
    mountHarness();
    triggerGuardedReload("test-B");
    expect(show).toHaveBeenCalledTimes(1);

    navigateTo("/next");
    expect(reload).not.toHaveBeenCalled();
  });

  it("does NOT reload when the flag write fails; falls back to the banner", () => {
    mockMarkAutoReloaded.mockReturnValue(false);
    mountHarness();
    triggerGuardedReload("test-B");
    navigateTo("/next");
    expect(reload).not.toHaveBeenCalled();
    // performAutoReload falls back to showing the banner (initial + fallback).
    expect(show).toHaveBeenCalled();
  });

  it("is idempotent within a tab-load: repeated emits do not stack banners", () => {
    triggerGuardedReload("test-B");
    triggerGuardedReload("test-B");
    triggerGuardedReload("test-C");
    expect(show).toHaveBeenCalledTimes(1);
  });
});
