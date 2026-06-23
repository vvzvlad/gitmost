import { describe, it, expect } from "vitest";
import { canCreatePage } from "./can-create-page.ts";
import { ISpace } from "@/features/space/types/space.types.ts";
import { SpaceRole } from "@/lib/types.ts";

// Unit tests for `canCreatePage` (new-note-button.tsx). The home screen has no
// active space, so the "New note" button resolves its target from the user's
// writable spaces. This predicate mirrors the server space-ability mapping
// (ADMIN/WRITER can manage pages, READER is read-only). The /spaces list endpoint
// only returns membership.role (not CASL permissions), so a regression here would
// either hide the button for legitimate writers or offer it to read-only members.

function spaceWithRole(role?: SpaceRole): ISpace {
  // Only `membership.role` is consulted by the predicate; the rest is filler.
  return {
    membership: role ? ({ role } as any) : undefined,
  } as ISpace;
}

describe("canCreatePage", () => {
  it("is true for ADMIN and WRITER roles", () => {
    expect(canCreatePage(spaceWithRole(SpaceRole.ADMIN))).toBe(true);
    expect(canCreatePage(spaceWithRole(SpaceRole.WRITER))).toBe(true);
  });

  it("is false for the READER role", () => {
    expect(canCreatePage(spaceWithRole(SpaceRole.READER))).toBe(false);
  });

  it("is false when membership / role is missing", () => {
    expect(canCreatePage(spaceWithRole(undefined))).toBe(false);
    expect(canCreatePage({} as ISpace)).toBe(false);
  });

  it("filters an empty space list down to nothing writable", () => {
    const spaces: ISpace[] = [
      spaceWithRole(SpaceRole.READER),
      spaceWithRole(undefined),
    ];
    expect(spaces.filter(canCreatePage)).toHaveLength(0);
  });
});
