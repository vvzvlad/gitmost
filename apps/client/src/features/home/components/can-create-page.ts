import { ISpace } from "@/features/space/types/space.types.ts";
import { SpaceRole } from "@/lib/types.ts";

// The /spaces list endpoint returns membership.role but NOT membership.permissions
// (only /spaces/info includes CASL rules). Mirror the server space-ability mapping:
// ADMIN and WRITER can manage pages, READER is read-only. So a space is writable
// for the current user when their role is ADMIN or WRITER.
//
// Extracted from new-note-button.tsx into this pure sibling module so it can be
// unit-tested without importing the component (whose dependency chain pulls in
// main.tsx and renders the whole app at import time).
export function canCreatePage(space: ISpace): boolean {
  const role = space.membership?.role;
  return role === SpaceRole.ADMIN || role === SpaceRole.WRITER;
}
