import { useState } from "react";
import { Button, Group } from "@mantine/core";
import { IconHourglass, IconPlus } from "@tabler/icons-react";
import { useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useGetSpaceBySlugQuery } from "@/features/space/queries/space-query.ts";
import { useTreeMutation } from "@/features/page/tree/hooks/use-tree-mutation.ts";
import { useSpaceAbility } from "@/features/space/permissions/use-space-ability.ts";
import {
  SpaceCaslAction,
  SpaceCaslSubject,
} from "@/features/space/permissions/permissions.type.ts";

// Space-overview quick actions: create a regular note or a temporary note
// (which auto-moves to Trash after the workspace lifetime) directly in the
// current space and open it. Mirrors the sidebar's create buttons but lives on
// the space overview screen, reusing `useTreeMutation.handleCreate` so the new
// page is optimistically inserted into the sidebar tree and navigated to.
export default function SpaceCreateNoteButtons() {
  const { t } = useTranslation();
  const { spaceSlug } = useParams();
  const { data: space } = useGetSpaceBySlugQuery(spaceSlug);
  const spaceAbility = useSpaceAbility(space?.membership?.permissions);
  // `handleCreate` is read unconditionally to keep hook order stable; it is
  // only invoked after the permission guard below confirms a loaded space.
  const { handleCreate } = useTreeMutation(space?.id ?? "");
  // Which create action is in flight: drives the per-button spinner and the
  // shared disabled state so a slow create round-trip cannot be double-fired.
  const [pending, setPending] = useState<"regular" | "temporary" | null>(null);

  // Render nothing until the space loads, or when the user cannot manage pages.
  if (!space) return null;
  if (spaceAbility.cannot(SpaceCaslAction.Manage, SpaceCaslSubject.Page)) {
    return null;
  }

  const createNote = (temporary: boolean) => {
    if (pending) return;
    setPending(temporary ? "temporary" : "regular");
    // handleCreate creates the page then navigates away (unmounting this
    // component); the create mutation already shows a red notification on
    // failure, so swallow the rejection and just clear the pending flag.
    handleCreate(null, temporary ? { temporary: true } : undefined)
      .catch(() => {})
      .finally(() => setPending(null));
  };

  return (
    <Group grow gap="sm">
      <Button
        size="md"
        variant="light"
        color="gray"
        leftSection={<IconPlus size={18} />}
        loading={pending === "regular"}
        disabled={pending !== null}
        onClick={() => createNote(false)}
      >
        {t("New note")}
      </Button>
      <Button
        size="md"
        variant="light"
        color="gray"
        leftSection={<IconHourglass size={18} />}
        loading={pending === "temporary"}
        disabled={pending !== null}
        onClick={() => createNote(true)}
      >
        {t("New temporary note")}
      </Button>
    </Group>
  );
}
