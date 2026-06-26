import { describe, it, expect } from "vitest";
import { catalogRoleInstallState } from "./catalog-role-install-state.ts";
import type { IAiRole } from "@/features/ai-chat/types/ai-chat.types.ts";

// Build a workspace role with a catalog source. Fields irrelevant to the
// install-state decision are filled with harmless defaults.
function installedRole(
  source: { slug: string; language: string; version: number },
  overrides: Partial<IAiRole> = {},
): IAiRole {
  return {
    id: `role-${source.slug}-${source.language}`,
    name: source.slug,
    emoji: null,
    description: null,
    enabled: true,
    autoStart: true,
    launchMessage: null,
    source,
    ...overrides,
  };
}

const catalogRole = { slug: "writer", version: 3 };

// Mirrors the role-launch.ts precedent: the modal's role-state computation is a
// pure function so the import/installed/update decision is testable directly.
describe("catalogRoleInstallState", () => {
  it("no matching installed role -> import", () => {
    const result = catalogRoleInstallState(catalogRole, [], "en");
    expect(result).toEqual({ state: "import" });
  });

  it("same slug + language, installed version > catalog -> installed", () => {
    const installed = installedRole({
      slug: "writer",
      language: "en",
      version: 5,
    });
    const result = catalogRoleInstallState(catalogRole, [installed], "en");
    expect(result).toEqual({ state: "installed", installed });
  });

  it("same slug + language, installed version == catalog -> installed", () => {
    const installed = installedRole({
      slug: "writer",
      language: "en",
      version: 3,
    });
    const result = catalogRoleInstallState(catalogRole, [installed], "en");
    expect(result).toEqual({ state: "installed", installed });
  });

  it("same slug + language, installed version < catalog -> update (from/to)", () => {
    const installed = installedRole({
      slug: "writer",
      language: "en",
      version: 1,
    });
    const result = catalogRoleInstallState(catalogRole, [installed], "en");
    expect(result).toEqual({
      state: "update",
      installed,
      fromVersion: 1,
      toVersion: 3,
    });
  });

  it("same slug but DIFFERENT language -> import (a separate install)", () => {
    // 'writer' is installed in 'ru'; browsing the 'en' catalog must offer it as a
    // fresh import, not treat the ru copy as already installed.
    const installed = installedRole({
      slug: "writer",
      language: "ru",
      version: 5,
    });
    const result = catalogRoleInstallState(catalogRole, [installed], "en");
    expect(result).toEqual({ state: "import" });
  });

  it("matches the right language when the same slug is installed in several", () => {
    const ru = installedRole(
      { slug: "writer", language: "ru", version: 5 },
      { id: "ru-role" },
    );
    const en = installedRole(
      { slug: "writer", language: "en", version: 1 },
      { id: "en-role" },
    );
    const result = catalogRoleInstallState(catalogRole, [ru, en], "en");
    expect(result).toEqual({
      state: "update",
      installed: en,
      fromVersion: 1,
      toVersion: 3,
    });
  });

  it("ignores manually-created roles (no source) sharing the name", () => {
    const manual = installedRole(
      { slug: "writer", language: "en", version: 9 },
      { source: null },
    );
    const result = catalogRoleInstallState(catalogRole, [manual], "en");
    expect(result).toEqual({ state: "import" });
  });
});
