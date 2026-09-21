import { describe, it, expect } from "vitest";
import {
  bundleCounts,
  bundlePhase,
  installedLangForRole,
  mapBundleRolesToView,
  mapCatalogRoleToView,
  nameConflictSlugs,
  partialOffersRename,
  type CatalogViewRole,
} from "./catalog-bundle-model.ts";
import type {
  IAiRole,
  IAiRoleCatalogRole,
} from "@/features/ai-chat/types/ai-chat.types.ts";

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

function catalogRole(
  overrides: Partial<IAiRoleCatalogRole> = {},
): IAiRoleCatalogRole {
  return {
    slug: "writer",
    emoji: "✍️",
    name: "Writer",
    description: "Drafts copy.",
    instructions: "be a writer",
    autoStart: true,
    launchMessage: null,
    version: 3,
    ...overrides,
  };
}

// Build a minimal view role for bundlePhase tests.
function viewRole(status: CatalogViewRole["status"]): CatalogViewRole {
  return { slug: `s-${status}`, name: status, description: "", version: 1, status };
}

describe("bundlePhase", () => {
  it("empty bundle -> empty", () => {
    expect(bundlePhase([])).toBe("empty");
  });

  it("all importable, none installed -> allNew", () => {
    expect(bundlePhase([viewRole("import"), viewRole("import")])).toBe(
      "allNew",
    );
  });

  it("nothing to import or update -> allInstalled", () => {
    expect(bundlePhase([viewRole("installed"), viewRole("installed")])).toBe(
      "allInstalled",
    );
  });

  it("updates present, nothing to import -> updates", () => {
    expect(bundlePhase([viewRole("update"), viewRole("installed")])).toBe(
      "updates",
    );
  });

  it("import + installed (no updates) -> mixed", () => {
    expect(bundlePhase([viewRole("import"), viewRole("installed")])).toBe(
      "mixed",
    );
  });

  it("import + update -> mixed", () => {
    expect(bundlePhase([viewRole("import"), viewRole("update")])).toBe("mixed");
  });

  it("a skipped role with nothing installed -> mixed (NOT allInstalled)", () => {
    // F1: a bundle whose only non-installed role was skipped has 0 installed for
    // it, so the collapsed 'All installed · up to date' header would contradict
    // the open 'Installed 0 · 1 skipped' plaque. It must be mixed until resolved.
    expect(bundlePhase([viewRole("skipped")])).toBe("mixed");
  });

  it("installed + a skipped role -> mixed (partial success is not allInstalled)", () => {
    expect(bundlePhase([viewRole("installed"), viewRole("skipped")])).toBe(
      "mixed",
    );
  });
});

describe("bundleCounts", () => {
  it("tallies each status once", () => {
    expect(
      bundleCounts([
        viewRole("import"),
        viewRole("import"),
        viewRole("installed"),
        viewRole("update"),
        viewRole("skipped"),
      ]),
    ).toEqual({ importable: 2, installed: 1, update: 1, skipped: 1 });
  });
});

describe("nameConflictSlugs / partialOffersRename (reason -> action)", () => {
  it("only name-conflict skips become the transient overlay / offer rename", () => {
    const skipped = [
      { slug: "writer", name: "Writer", reason: "name-conflict" as const },
      { slug: "editor", name: "Editor", reason: "already-installed" as const },
    ];
    expect(nameConflictSlugs(skipped)).toEqual(["writer"]);
    expect(partialOffersRename(skipped)).toBe(true);
  });

  it("an already-installed-only skip is informational: no overlay, no rename", () => {
    const skipped = [
      { slug: "editor", name: "Editor", reason: "already-installed" as const },
    ];
    expect(nameConflictSlugs(skipped)).toEqual([]);
    expect(partialOffersRename(skipped)).toBe(false);
  });
});

describe("installedLangForRole", () => {
  it("returns the other language when the same slug is installed elsewhere", () => {
    const roles = [installedRole({ slug: "writer", language: "ru", version: 2 })];
    expect(installedLangForRole("writer", roles, "en")).toBe("ru");
  });

  it("returns undefined when the same slug is installed in the SAME language", () => {
    const roles = [installedRole({ slug: "writer", language: "en", version: 2 })];
    expect(installedLangForRole("writer", roles, "en")).toBeUndefined();
  });

  it("returns undefined when no install of the slug exists", () => {
    expect(installedLangForRole("writer", [], "en")).toBeUndefined();
  });

  it("ignores manually-created roles (no source)", () => {
    const roles = [
      installedRole({ slug: "writer", language: "ru", version: 2 }, {
        source: null,
      }),
    ];
    expect(installedLangForRole("writer", roles, "en")).toBeUndefined();
  });
});

describe("mapCatalogRoleToView", () => {
  it("no install -> import status, catalog version, emoji preserved", () => {
    const view = mapCatalogRoleToView(catalogRole(), [], "en");
    expect(view).toMatchObject({
      slug: "writer",
      emoji: "✍️",
      name: "Writer",
      description: "Drafts copy.",
      status: "import",
      version: 3,
    });
    expect(view.installedRoleId).toBeUndefined();
    expect(view.installedLang).toBeUndefined();
  });

  it("import with the slug installed in another language -> installedLang set", () => {
    const roles = [installedRole({ slug: "writer", language: "ru", version: 9 })];
    const view = mapCatalogRoleToView(catalogRole(), roles, "en");
    expect(view.status).toBe("import");
    expect(view.installedLang).toBe("ru");
  });

  it("installed (up to date) -> installed status, catalog version, installedRoleId", () => {
    const installed = installedRole({
      slug: "writer",
      language: "en",
      version: 3,
    });
    const view = mapCatalogRoleToView(catalogRole(), [installed], "en");
    expect(view).toMatchObject({
      status: "installed",
      version: 3,
      installedRoleId: installed.id,
    });
  });

  it("update -> version=from, newVersion=to, installedRoleId", () => {
    const installed = installedRole({
      slug: "writer",
      language: "en",
      version: 1,
    });
    const view = mapCatalogRoleToView(catalogRole(), [installed], "en");
    expect(view).toMatchObject({
      status: "update",
      version: 1,
      newVersion: 3,
      installedRoleId: installed.id,
    });
  });

  it("missing emoji -> emoji undefined; null description -> empty string", () => {
    const view = mapCatalogRoleToView(
      catalogRole({ emoji: null, description: null }),
      [],
      "en",
    );
    expect(view.emoji).toBeUndefined();
    expect(view.description).toBe("");
  });
});

describe("mapBundleRolesToView", () => {
  it("maps a bundle's roles preserving order", () => {
    const roles = [
      catalogRole({ slug: "a", name: "A", version: 1 }),
      catalogRole({ slug: "b", name: "B", version: 1 }),
    ];
    const installed = [installedRole({ slug: "a", language: "en", version: 1 })];
    const view = mapBundleRolesToView(roles, installed, "en");
    expect(view.map((r) => r.slug)).toEqual(["a", "b"]);
    expect(view[0].status).toBe("installed");
    expect(view[1].status).toBe("import");
  });
});
